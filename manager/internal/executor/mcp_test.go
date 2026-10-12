package executor

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

var mcpCalls atomic.Int64

func mcpRaw(t *testing.T, value any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// mcpCall records an `mcp` receipt (no caller details: Manager derives them).
func mcpCall(t *testing.T, service *Service, ident Identity, action string, arguments any) Call {
	t.Helper()
	call, err := mcpCallErr(service, ident, action, mcpRaw(t, arguments))
	if err != nil {
		t.Fatal(err)
	}
	return call
}

func mcpCallErr(service *Service, ident Identity, action string, raw json.RawMessage) (Call, error) {
	ident.ToolCallID = "mcp-tool-" + strconv.FormatInt(mcpCalls.Add(1), 10)
	receipt, err := service.Audit(AuditRequest{Identity: ident, AuditID: "audit-" + ident.ToolCallID, Target: "sandbox", Operation: "mcp", Action: action, Arguments: raw})
	if err != nil {
		return Call{}, err
	}
	return Call{Identity: ident, AuditID: receipt.AuditID, ExecutorID: receipt.ExecutorID, Target: "sandbox", Action: action, Arguments: raw}, nil
}

func pyServer(script string, env map[string]string) mcpStartArguments {
	return mcpStartArguments{ConnectorID: "conn-1", Command: "python3", Args: []string{"-u", "-c", script}, CWD: "", Env: env}
}

func mcpStartErr(service *Service, t *testing.T, ident Identity, args mcpStartArguments) (string, error) {
	t.Helper()
	call := mcpCall(t, service, ident, "start", args)
	result, err := service.MCPStart(context.Background(), call)
	if err != nil {
		return "", err
	}
	return result["connection_id"].(string), nil
}

func mcpStart(t *testing.T, service *Service, ident Identity, args mcpStartArguments) string {
	t.Helper()
	id, err := mcpStartErr(service, t, ident, args)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = service.MCP.Stop(Call{Identity: ident}, id) })
	return id
}

func mcpSend(service *Service, t *testing.T, ident Identity, id, message string) error {
	t.Helper()
	call := mcpCall(t, service, ident, "send", mcpSendArguments{ConnectionID: id, Message: message})
	_, err := service.MCPSend(context.Background(), call)
	return err
}

func mcpStop(service *Service, t *testing.T, ident Identity, id string) (map[string]any, error) {
	t.Helper()
	call := mcpCall(t, service, ident, "stop", mcpStopArguments{ConnectionID: id})
	return service.MCPStop(context.Background(), call)
}

func mcpRecv(t *testing.T, service *Service, id string, ack int64, waitMS int) MCPRecvResult {
	t.Helper()
	result, err := service.MCPRecv(context.Background(), MCPRecvRequest{ConnectionID: id, Owner: "private:1", Ack: ack, WaitMS: waitMS})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

// mcpWaitSettled waits, without receiving, until the supervisor settled the
// connection, so nothing is acknowledged meanwhile.
func mcpWaitSettled(t *testing.T, service *Service, id string) {
	t.Helper()
	conn, err := service.MCP.lookup(id, "private:1")
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-conn.done:
	case <-time.After(30 * time.Second):
		t.Fatal("connection did not settle")
	}
}

// mcpCollect long-polls until it holds want messages or the connection ended.
func mcpCollect(t *testing.T, service *Service, id string, want int) ([]MCPMessage, MCPRecvResult) {
	t.Helper()
	var all []MCPMessage
	var ack int64
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		result := mcpRecv(t, service, id, ack, 1000)
		all = append(all, result.Messages...)
		ack = result.Next
		if len(all) >= want && want >= 0 || result.State != "running" {
			return all, result
		}
	}
	t.Fatalf("timed out with %d of %d messages", len(all), want)
	return nil, MCPRecvResult{}
}

func mcpWaitEnded(t *testing.T, service *Service, id string) MCPRecvResult {
	t.Helper()
	var ack int64
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		result := mcpRecv(t, service, id, ack, 1000)
		ack = result.Next
		if result.State != "running" {
			return result
		}
	}
	t.Fatal("connection did not end")
	return MCPRecvResult{}
}

func filesContaining(t *testing.T, root string, needles ...string) []string {
	t.Helper()
	var hits []string
	_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		for _, needle := range needles {
			if strings.Contains(string(data), needle) {
				hits = append(hits, path+" contains "+needle)
			}
		}
		return nil
	})
	return hits
}

func TestMCPStdoutIsByteIdenticalNeverRedactedAndNeverPersisted(t *testing.T) {
	service, root := newTestService(t)
	canary := "stdout-canary-0123456789abcdef"
	script := `
import sys
sys.stdout.write('{"jsonrpc":"2.0","result":"Bearer ` + canary + ` token=` + canary + ` \u00e9\u4f60"}\n')
sys.stderr.write('visible-diagnostic password=stderr-canary-fedcba9876543210\n')
sys.stderr.flush()
sys.stdout.write('{"two":2}\n')
sys.stdout.flush()
sys.stdin.readline()
`
	id := mcpStart(t, service, identity(), pyServer(script, nil))
	messages, _ := mcpCollect(t, service, id, 2)
	want := `{"jsonrpc":"2.0","result":"Bearer ` + canary + ` token=` + canary + ` é你"}`
	if len(messages) != 2 || messages[0].Data != want || messages[1].Data != `{"two":2}` || messages[0].Seq != 1 || messages[1].Seq != 2 {
		t.Fatalf("stdout was altered: %+v", messages)
	}
	if _, err := mcpStop(service, t, identity(), id); err != nil {
		t.Fatal(err)
	}
	if hits := filesContaining(t, root, canary); len(hits) != 0 {
		t.Fatalf("stdout protocol bytes reached disk: %v", hits)
	}
	// stderr goes through the redacted, capped log and nowhere else.
	result := mcpRecv(t, service, id, 2, 0)
	if !strings.Contains(result.StderrTail, "visible-diagnostic") || strings.Contains(result.StderrTail, "stderr-canary") {
		t.Fatalf("stderr was not redacted: %q", result.StderrTail)
	}
	logged, err := os.ReadFile(filepath.Join(root, "manager", "mcp", id, "output.log"))
	if err != nil || !strings.Contains(string(logged), "visible-diagnostic") || strings.Contains(string(logged), "stderr-canary") {
		t.Fatalf("stderr log: %q %v", logged, err)
	}
}

func TestMCPSplitLinesAndMultibyteUTF8(t *testing.T) {
	service, _ := newTestService(t)
	script := `
import sys, time
out = sys.stdout.buffer
out.write('{"s":"'.encode() + '你好'.encode()[:4]); out.flush(); time.sleep(0.3)
out.write('你好'.encode()[4:] + b'"}\n{"b":1}\n{"c"'); out.flush(); time.sleep(0.3)
out.write(b':2}\n\n{"d":3}\n'); out.flush()
sys.stdin.readline()
`
	id := mcpStart(t, service, identity(), pyServer(script, nil))
	messages, _ := mcpCollect(t, service, id, 4)
	var got []string
	for _, message := range messages {
		got = append(got, message.Data)
	}
	want := []string{`{"s":"你好"}`, `{"b":1}`, `{"c":2}`, `{"d":3}`}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("frames: %q", got)
	}
}

func TestMCPFrameCapAndQueueOverflowTerminateWithReason(t *testing.T) {
	service, _ := newTestService(t)
	// Exactly 1 MiB is a frame; one more byte is not.
	id := mcpStart(t, service, identity(), pyServer(`
import sys
sys.stdout.write('x' * (1 << 20) + '\n'); sys.stdout.flush()
sys.stdin.readline()
`, nil))
	messages, result := mcpCollect(t, service, id, 1)
	if len(messages) != 1 || len(messages[0].Data) != 1<<20 || result.State != "running" {
		t.Fatalf("a 1 MiB frame must be accepted: %d %+v", len(messages), result)
	}
	id = mcpStart(t, service, identity(), pyServer(`
import sys
sys.stdout.write('{"ok":1}\n' + 'y' * ((1 << 20) + 1) + '\n'); sys.stdout.flush()
sys.stdin.readline()
`, nil))
	ended := mcpWaitEnded(t, service, id)
	if ended.State != "failed" || ended.Reason != "frame_too_large" {
		t.Fatalf("oversized frame: %+v", ended)
	}
	// An unterminated line beyond the cap is rejected before it is stored.
	id = mcpStart(t, service, identity(), pyServer(`
import sys, time
sys.stdout.write('z' * (3 << 20)); sys.stdout.flush(); time.sleep(30)
`, nil))
	if ended := mcpWaitEnded(t, service, id); ended.Reason != "frame_too_large" {
		t.Fatalf("missing-LF line: %+v", ended)
	}
	// Nine 1 MiB frames overflow the 8 MiB queue; the eight kept stay readable.
	id = mcpStart(t, service, identity(), pyServer(`
import sys
for index in range(9):
    sys.stdout.write(str(index) * (1 << 20) + '\n')
sys.stdout.flush()
sys.stdin.readline()
`, nil))
	mcpWaitSettled(t, service, id) // nothing is acknowledged, so the queue fills
	all, final := mcpCollect(t, service, id, -1)
	if final.State != "failed" || final.Reason != "queue_overflow" || len(all) != 8 {
		t.Fatalf("queue overflow: %d messages, %+v", len(all), final)
	}
	for index, message := range all {
		if len(message.Data) != 1<<20 || message.Data[0] != byte('0'+index) {
			t.Fatalf("message %d corrupted", index)
		}
	}
	// Invalid UTF-8 is a malformed frame, never repaired.
	id = mcpStart(t, service, identity(), pyServer(`
import sys
sys.stdout.buffer.write(b'{"a":"\xff"}\n'); sys.stdout.flush()
sys.stdin.readline()
`, nil))
	if ended := mcpWaitEnded(t, service, id); ended.State != "failed" || ended.Reason != "invalid_utf8" {
		t.Fatalf("invalid UTF-8: %+v", ended)
	}
}

func TestMCPAckRetentionAcrossRepeatedRecv(t *testing.T) {
	service, _ := newTestService(t)
	id := mcpStart(t, service, identity(), pyServer(`
import sys
for index in range(1, 4):
    print('{"n":%d}' % index)
sys.stdout.flush()
sys.stdin.readline()
`, nil))
	deadline := time.Now().Add(10 * time.Second)
	var first MCPRecvResult
	for len(first.Messages) < 3 && time.Now().Before(deadline) {
		first = mcpRecv(t, service, id, 0, 500)
	}
	if len(first.Messages) != 3 || first.Next != 3 {
		t.Fatalf("first recv: %+v", first)
	}
	// The response was "lost": the same ack returns the same messages.
	again := mcpRecv(t, service, id, 0, 0)
	if len(again.Messages) != 3 || again.Messages[0].Data != `{"n":1}` {
		t.Fatalf("retry lost messages: %+v", again)
	}
	partial := mcpRecv(t, service, id, 2, 0)
	if len(partial.Messages) != 1 || partial.Messages[0].Seq != 3 || partial.Next != 3 {
		t.Fatalf("ack 2: %+v", partial)
	}
	empty := mcpRecv(t, service, id, 3, 0)
	if len(empty.Messages) != 0 || empty.Next != 3 || empty.State != "running" {
		t.Fatalf("ack 3: %+v", empty)
	}
	for _, ack := range []int64{1, 4, -1} {
		if _, err := service.MCPRecv(context.Background(), MCPRecvRequest{ConnectionID: id, Owner: "private:1", Ack: ack}); err == nil {
			t.Fatalf("ack %d was accepted", ack)
		}
	}
	// max_bytes splits a batch without losing or reordering messages.
	limited := mcpStart(t, service, identity(), pyServer(`
import sys
for index in range(1, 4):
    print('{"n":%d}' % index)
sys.stdout.flush()
sys.stdin.readline()
`, nil))
	var batch MCPRecvResult
	for len(batch.Messages) == 0 {
		batch, _ = service.MCPRecv(context.Background(), MCPRecvRequest{ConnectionID: limited, Owner: "private:1", WaitMS: 500, MaxBytes: 8})
	}
	if len(batch.Messages) != 1 || batch.Messages[0].Seq != 1 {
		t.Fatalf("max_bytes: %+v", batch)
	}
}

func TestMCPEndedConnectionReportsTerminalStateWithLastBatch(t *testing.T) {
	service, _ := newTestService(t)
	id := mcpStart(t, service, identity(), pyServer(`
print('{"n":1}'); print('{"n":2}')
`, nil))
	mcpWaitSettled(t, service, id)
	first, err := service.MCPRecv(context.Background(), MCPRecvRequest{ConnectionID: id, Owner: "private:1", MaxBytes: 8})
	if err != nil || len(first.Messages) != 1 || first.State != "running" || first.Reason != "" {
		t.Fatalf("the terminal state must wait for the last batch: %+v %v", first, err)
	}
	last, err := service.MCPRecv(context.Background(), MCPRecvRequest{ConnectionID: id, Owner: "private:1", Ack: first.Next, MaxBytes: 8})
	if err != nil || len(last.Messages) != 1 || last.Messages[0].Seq != 2 || last.State != "exited" || last.Reason != "exited" || last.ExitCode == nil || *last.ExitCode != 0 {
		t.Fatalf("last batch: %+v %v", last, err)
	}
}

func TestMCPEnvironmentNeverInArgvRecordsOrAudit(t *testing.T) {
	service, root := newTestService(t)
	canary := "env-canary-0123456789abcdef"
	script := `
import json, os, sys
def argv(pid):
    return open('/proc/%d/cmdline' % pid, 'rb').read().decode('utf-8', 'replace')
print(json.dumps({'env': os.environ.get('MCP_TOKEN'), 'own': argv(os.getpid()), 'parent': argv(os.getppid())}))
sys.stdout.flush()
sys.stdin.readline()
`
	id := mcpStart(t, service, identity(), pyServer(script, map[string]string{"MCP_TOKEN": canary}))
	messages, _ := mcpCollect(t, service, id, 1)
	var seen struct{ Env, Own, Parent string }
	if err := json.Unmarshal([]byte(messages[0].Data), &seen); err != nil {
		t.Fatal(err)
	}
	if seen.Env != canary {
		t.Fatalf("the server did not receive its environment: %+v", seen)
	}
	if strings.Contains(seen.Own, canary) || strings.Contains(seen.Parent, canary) || !strings.Contains(seen.Parent, "python3") && !strings.Contains(seen.Parent, "-c") {
		t.Fatalf("environment reached argv: %+v", seen)
	}
	if _, err := mcpStop(service, t, identity(), id); err != nil {
		t.Fatal(err)
	}
	if hits := filesContaining(t, root, canary); len(hits) != 0 {
		t.Fatalf("environment value retained: %v", hits)
	}
	audit, _ := os.ReadFile(filepath.Join(root, "audit.jsonl"))
	if !strings.Contains(string(audit), `"env_keys":["MCP_TOKEN"]`) || strings.Contains(string(audit), canary) {
		t.Fatalf("audit projection: %s", audit)
	}
	// Even a rejected start never records values.
	bad := pyServer("pass", map[string]string{"bad key": canary})
	if _, err := mcpCallErr(service, identity(), "start", mcpRaw(t, bad)); err == nil {
		t.Fatal("an invalid environment key was audited")
	}
}

func TestMCPSendFramingAndPoisonedChannel(t *testing.T) {
	service, _ := newTestService(t)
	script := `
import sys
for line in sys.stdin:
    sys.stdout.write('echo:' + line); sys.stdout.flush()
`
	id := mcpStart(t, service, identity(), pyServer(script, nil))
	first, second := `{"jsonrpc":"2.0","id":1,"method":"ping","params":{"x":"é"}}`, `{"jsonrpc":"2.0","method":"notifications/initialized"}`
	if err := mcpSend(service, t, identity(), id, first); err != nil {
		t.Fatal(err)
	}
	if err := mcpSend(service, t, identity(), id, second); err != nil {
		t.Fatal(err)
	}
	messages, _ := mcpCollect(t, service, id, 2)
	if messages[0].Data != "echo:"+first || messages[1].Data != "echo:"+second {
		t.Fatalf("send framing: %+v", messages)
	}
	// Exactly one object per send: embedded line breaks, non-objects, empty and
	// oversized messages never reach the server.
	for name, bad := range map[string]string{
		"newline": "{\"a\":1}\n{\"b\":2}", "carriage return": "{\"a\":1}\r", "array": `[{"a":1}]`, "string": `"x"`,
		"not json": `{`, "empty": ``, "oversized": `{"p":"` + strings.Repeat("a", 1<<20) + `"}`,
	} {
		if _, err := mcpCallErr(service, identity(), "send", mcpRaw(t, mcpSendArguments{ConnectionID: id, Message: bad})); err == nil {
			t.Fatalf("%s message was accepted", name)
		}
	}
	// A control channel that cannot be written is poisoned and ends the connection.
	conn, _ := service.MCP.lookup(id, "private:1")
	conn.control.mu.Lock()
	conn.control.broken = true // what a failed or partial write leaves behind
	conn.control.mu.Unlock()
	if err := mcpSend(service, t, identity(), id, first); err == nil {
		t.Fatal("send over a broken channel succeeded")
	}
	ended := mcpWaitEnded(t, service, id)
	if ended.State != "failed" && ended.State != "exited" || ended.Reason != "channel_failed" {
		t.Fatalf("poisoned channel: %+v", ended)
	}
	if err := mcpSend(service, t, identity(), id, first); err == nil || !strings.Contains(err.Error(), "ended") {
		t.Fatalf("send after the channel ended: %v", err)
	}
}

func TestMCPInputBacklogEndsTheConnection(t *testing.T) {
	service, _ := newTestService(t)
	id := mcpStart(t, service, identity(), pyServer(`
import time
time.sleep(60)
`, nil))
	message := `{"p":"` + strings.Repeat("a", 1<<20-16) + `"}`
	var sendErr error
	for range 12 {
		if sendErr = mcpSend(service, t, identity(), id, message); sendErr != nil {
			break
		}
	}
	ended := mcpWaitEnded(t, service, id)
	if ended.State != "failed" || ended.Reason != "input_overflow" {
		t.Fatalf("a server that never reads stdin: %+v (last send error %v)", ended, sendErr)
	}
}

func TestMCPStopConfirmsTerminationOfDescendants(t *testing.T) {
	service, root := newTestService(t)
	marker := filepath.Join(root, "grandchild.pid")
	script := `
import signal, subprocess, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
child = subprocess.Popen(['sleep', '600'])
open(` + strconv.Quote(marker) + `, 'w').write(str(child.pid))
print('{"ready":true}'); sys.stdout.flush()
time.sleep(600)
`
	id := mcpStart(t, service, identity(), pyServer(script, nil))
	mcpCollect(t, service, id, 1)
	pid := waitForPID(t, marker)
	started := time.Now()
	result, err := mcpStop(service, t, identity(), id)
	if err != nil {
		t.Fatal(err)
	}
	if result["state"] != "exited" || result["reason"] != "stopped" {
		t.Fatalf("stop result: %v", result)
	}
	if time.Since(started) < service.MCP.TermGrace {
		t.Fatal("SIGTERM was ignored, so stop must escalate only after the grace period")
	}
	deadline := time.Now().Add(5 * time.Second)
	for syscall.Kill(pid, 0) == nil && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if err := syscall.Kill(pid, 0); err == nil {
		t.Fatal("a descendant survived a confirmed stop")
	}
	if after := mcpRecv(t, service, id, 1, 0); after.State != "exited" || after.Reason != "stopped" {
		t.Fatalf("recv after stop: %+v", after)
	}
	// Stop is idempotent for an ended connection.
	if _, err := mcpStop(service, t, identity(), id); err != nil {
		t.Fatal(err)
	}
}

func TestMCPHoldsNoSandboxResidencyWhileIdle(t *testing.T) {
	engine := newCountingEngine()
	service, _ := newTestServiceWithEngine(t, engine)
	sandboxes := service.MCP.Sandboxes
	script := `
import sys
for line in sys.stdin:
    sys.stdout.write(line); sys.stdout.flush()
`
	id := mcpStart(t, service, identity(), pyServer(script, nil))
	if records := sandboxes.Records(); len(records) != 1 || records[0].ActiveCalls != 0 {
		t.Fatalf("a connection must not pin its sandbox: %+v", records)
	}
	if err := mcpSend(service, t, identity(), id, `{"id":1}`); err != nil {
		t.Fatal(err)
	}
	if records := sandboxes.Records(); records[0].ActiveCalls != 0 {
		t.Fatalf("send leaked residency: %+v", records)
	}
	mcpCollect(t, service, id, 1)
	// Waiting in recv never counts as activity either.
	if records := sandboxes.Records(); records[0].ActiveCalls != 0 {
		t.Fatalf("recv holds residency: %+v", records)
	}
	stopped, err := sandboxes.Reap(context.Background(), time.Now().Add(48*time.Hour))
	if err != nil || len(stopped) != 1 || engine.stopCount() != 1 {
		t.Fatalf("idle stop was blocked by an MCP connection: %v %v %d", stopped, err, engine.stopCount())
	}
	ended := mcpWaitEnded(t, service, id)
	if ended.State != "exited" || ended.Reason != "sandbox_stopped" {
		t.Fatalf("idle stop must end the connection: %+v", ended)
	}
	if err := mcpSend(service, t, identity(), id, `{"id":2}`); err == nil {
		t.Fatal("send to a connection whose sandbox stopped")
	}
	if records := sandboxes.Records(); records[0].ActiveCalls != 0 {
		t.Fatalf("residency leaked: %+v", records)
	}
	// A failed start releases its lease as well.
	if _, err := mcpStartErr(service, t, identity(), mcpStartArguments{ConnectorID: "c", Command: "definitely-missing-mcp-server"}); err == nil {
		t.Fatal("missing executable started")
	}
	if records := sandboxes.Records(); records[0].ActiveCalls != 0 {
		t.Fatalf("failed start leaked residency: %+v", records)
	}
}

func TestMCPManagerRestartForgetsConnections(t *testing.T) {
	service, root := newTestService(t)
	id := mcpStart(t, service, identity(), pyServer(`
import sys
print('{"n":1}'); sys.stdout.flush()
sys.stdin.readline()
`, nil))
	mcpCollect(t, service, id, 1)
	restarted, err := NewMCPManager(testActiveProfile, engineStub{}, service.MCP.Sandboxes, MCPConfig{Dir: filepath.Join(root, "manager", "mcp"), OwnerLimit: 8, GlobalLimit: 64})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := restarted.Recv(context.Background(), MCPRecvRequest{ConnectionID: id, Owner: "private:1"}); !errors.Is(err, ErrMCPConnectionNotFound) {
		t.Fatalf("a restarted Manager must not know the connection: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "manager", "mcp", id)); !os.IsNotExist(err) {
		t.Fatalf("stale stderr log kept: %v", err)
	}
	if restarted.RunningCount() != 0 {
		t.Fatal("restarted manager reports running connections")
	}
	// The old supervisor still owns the real process (the startup barrier would
	// have stopped its container); end it.
	if _, err := mcpStop(service, t, identity(), id); err != nil {
		t.Fatal(err)
	}
}

func TestMCPOwnerLimitsAndForeignConnectionIsNotFound(t *testing.T) {
	service, _ := newTestService(t)
	service.MCP.OwnerLimit, service.MCP.GlobalLimit = 2, 3
	hold := pyServer(`
import sys
sys.stdin.readline()
`, nil)
	first := mcpStart(t, service, identity(), hold)
	delegated := identity()
	delegated.ScopeID = "private:1/delegate/bg-1"
	mcpStart(t, service, delegated, hold) // a delegate shares its root's pool
	if _, err := mcpStartErr(service, t, identity(), hold); err == nil || !strings.Contains(err.Error(), "too many MCP connections") {
		t.Fatalf("owner limit: %v", err)
	}
	other := identity()
	other.ScopeID = "private:2"
	other.ExecutionContext = ExecutionContext{SandboxID: "private-2", WorkspaceID: "user-2"}
	second := mcpStart(t, service, other, hold)
	if _, err := mcpStartErr(service, t, other, hold); err == nil || !strings.Contains(err.Error(), "too many MCP connections") {
		t.Fatalf("global limit: %v", err)
	}
	// Foreign and unknown ids are indistinguishable.
	for _, check := range []func() error{
		func() error {
			_, err := service.MCPRecv(context.Background(), MCPRecvRequest{ConnectionID: first, Owner: "private:2"})
			return err
		},
		func() error {
			_, err := service.MCPRecv(context.Background(), MCPRecvRequest{ConnectionID: "mcp_00000000000000000000000000", Owner: "private:1"})
			return err
		},
		func() error { return mcpSend(service, t, other, first, `{"id":1}`) },
		func() error { _, err := mcpStop(service, t, other, first); return err },
		func() error {
			sameOwnerOtherSandbox := identity()
			sameOwnerOtherSandbox.ExecutionContext = ExecutionContext{SandboxID: "private-9", WorkspaceID: "user-9"}
			_, err := mcpStop(service, t, sameOwnerOtherSandbox, first)
			return err
		},
	} {
		if err := check(); !errors.Is(err, ErrMCPConnectionNotFound) {
			t.Fatalf("foreign access: %v", err)
		}
	}
	if _, err := service.MCPRecv(context.Background(), MCPRecvRequest{ConnectionID: second, Owner: "private:1"}); !errors.Is(err, ErrMCPConnectionNotFound) {
		t.Fatalf("cross-owner recv: %v", err)
	}
	// A stopped connection frees its slot.
	if _, err := mcpStop(service, t, identity(), first); err != nil {
		t.Fatal(err)
	}
	mcpStart(t, service, identity(), hold)
}

func TestMCPReceiptsForStartSendAndStopCarryOnlyProjections(t *testing.T) {
	service, root := newTestService(t)
	secretArg := "message-body-canary-0123456789"
	id := mcpStart(t, service, identity(), mcpStartArguments{ConnectorID: "conn-1", Command: "python3", Args: []string{"-u", "-c", "import sys\nfor line in sys.stdin:\n    pass\n"}, Env: map[string]string{"B_KEY": "v", "A_KEY": "w"}})
	message := `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"t","arguments":{"q":"` + secretArg + `"}}}`
	call := mcpCall(t, service, identity(), "send", mcpSendArguments{ConnectionID: id, Message: message})
	if _, err := service.MCPSend(context.Background(), call); err != nil {
		t.Fatal(err)
	}
	if _, err := service.MCPSend(context.Background(), call); err == nil {
		t.Fatal("a send receipt was replayed")
	}
	// A receipt for other arguments cannot be redirected to another message.
	other := mcpCall(t, service, identity(), "send", mcpSendArguments{ConnectionID: id, Message: `{"a":1}`})
	other.Arguments = mcpRaw(t, mcpSendArguments{ConnectionID: id, Message: `{"a":2}`})
	if _, err := service.MCPSend(context.Background(), other); err == nil {
		t.Fatal("a receipt was accepted for different arguments")
	}
	if _, err := mcpStop(service, t, identity(), id); err != nil {
		t.Fatal(err)
	}
	audit, err := os.ReadFile(filepath.Join(root, "audit.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(audit)
	for _, want := range []string{
		`"env_keys":["A_KEY","B_KEY"]`, `"args_count":3`, `"connector_id":"conn-1"`,
		`"connection_id":"` + id + `"`, `"bytes":` + strconv.Itoa(len(message)), `"method":"tools/call"`,
		`"type":"execution.started"`, `"type":"execution.finished"`, `"reason":"stopped"`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("audit lacks %s:\n%s", want, text)
		}
	}
	if strings.Contains(text, secretArg) || strings.Contains(text, "import sys") {
		t.Fatalf("audit retained message or argv content:\n%s", text)
	}
	if hits := filesContaining(t, root, secretArg, `"v"`); len(hits) != 0 {
		t.Fatalf("content reached disk: %v", hits)
	}
	for _, kind := range []string{"start", "send", "stop"} {
		if got := strings.Count(text, `"operation":"mcp"`); got < 3 {
			t.Fatalf("%s receipt events missing: %d", kind, got)
		}
	}
}

func TestMCPLaunchValidation(t *testing.T) {
	good := []mcpStartArguments{
		{ConnectorID: "c", Command: "npx", Args: []string{"-y", "@modelcontextprotocol/server-everything"}},
		{ConnectorID: "c", Command: "uvx", Args: []string{"mcp-server-time"}},
		{ConnectorID: "c", Command: "./server", CWD: "tools"},
		{ConnectorID: "c", Command: "/workspace/bin/server", CWD: "/workspace/x"},
		{ConnectorID: "c", Command: "node", CWD: "/workspace"},
	}
	for _, args := range good {
		if _, err := validateMCPStart(args); err != nil {
			t.Errorf("%+v: %v", args, err)
		}
	}
	bad := map[string]mcpStartArguments{
		"shell line":       {ConnectorID: "c", Command: "npx -y server"},
		"shell operator":   {ConnectorID: "c", Command: "a;b"},
		"empty command":    {ConnectorID: "c"},
		"flag command":     {ConnectorID: "c", Command: "-c"},
		"outside absolute": {ConnectorID: "c", Command: "/usr/bin/python3"},
		"relative escape":  {ConnectorID: "c", Command: "../../bin/sh"},
		"cwd escape":       {ConnectorID: "c", Command: "node", CWD: "../.."},
		"cwd outside":      {ConnectorID: "c", Command: "node", CWD: "/etc"},
		"bad connector":    {ConnectorID: "bad id", Command: "node"},
		"nul argument":     {ConnectorID: "c", Command: "node", Args: []string{"a\x00b"}},
		"env key":          {ConnectorID: "c", Command: "node", Env: map[string]string{"1X": "v"}},
		"env nul":          {ConnectorID: "c", Command: "node", Env: map[string]string{"X": "a\x00"}},
		"huge env":         {ConnectorID: "c", Command: "node", Env: map[string]string{"X": strings.Repeat("a", mcpEnvValueBytesMaximum+1)}},
	}
	for name, args := range bad {
		if _, err := validateMCPStart(args); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}

func TestMCPStartFailureReportsExitAndStderr(t *testing.T) {
	service, _ := newTestService(t)
	_, err := mcpStartErr(service, t, identity(), mcpStartArguments{ConnectorID: "c", Command: "definitely-missing-mcp-server"})
	if err == nil || !strings.Contains(err.Error(), "code 127") || !strings.Contains(err.Error(), "cannot execute") {
		t.Fatalf("start failure: %v", err)
	}
	if service.MCP.RunningCount() != 0 {
		t.Fatal("a failed start still counts against the limits")
	}
	// An exit after the server was executed is reported by recv, with its code.
	id, err := mcpStartErr(service, t, identity(), pyServer("import sys; sys.stderr.write('boom\\n'); sys.exit(3)", nil))
	if err != nil {
		t.Fatal(err)
	}
	if ended := mcpWaitEnded(t, service, id); ended.State != "exited" || ended.ExitCode == nil || *ended.ExitCode != 3 || !strings.Contains(ended.StderrTail, "boom") {
		t.Fatalf("exit report: %+v", ended)
	}
}

func TestMCPRecvLongPollWakesOnMessageAndTimesOut(t *testing.T) {
	service, _ := newTestService(t)
	id := mcpStart(t, service, identity(), pyServer(`
import sys, time
time.sleep(0.5)
print('{"late":1}'); sys.stdout.flush()
sys.stdin.readline()
`, nil))
	started := time.Now()
	idle := mcpRecv(t, service, id, 0, 100)
	if len(idle.Messages) != 0 || idle.State != "running" || time.Since(started) < 90*time.Millisecond {
		t.Fatalf("an empty long poll must wait and report running: %+v", idle)
	}
	woken := mcpRecv(t, service, id, 0, 10000)
	if len(woken.Messages) != 1 || woken.Messages[0].Data != `{"late":1}` {
		t.Fatalf("long poll: %+v", woken)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, err := service.MCPRecv(ctx, MCPRecvRequest{ConnectionID: id, Owner: "private:1", Ack: 1, WaitMS: 30000}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("a cancelled request must stop waiting: %v", err)
	}
	for _, bad := range []MCPRecvRequest{
		{ConnectionID: id, Owner: "private:1", WaitMS: 30001}, {ConnectionID: id, Owner: "private:1", MaxBytes: 4<<20 + 1},
		{ConnectionID: id, Owner: "private:1", WaitMS: -1},
	} {
		if _, err := service.MCPRecv(context.Background(), bad); err == nil {
			t.Fatalf("accepted %+v", bad)
		}
	}
}

func TestMCPEndedConnectionsAreForgottenAfterRetention(t *testing.T) {
	service, _ := newTestService(t)
	var skew atomic.Int64
	service.MCP.Now = func() time.Time { return time.Now().Add(time.Duration(skew.Load())) }
	id := mcpStart(t, service, identity(), pyServer("print('{}')", nil))
	mcpWaitEnded(t, service, id)
	skew.Store(int64(service.MCP.Retention + time.Second))
	// Pruning runs on admission.
	_, _ = mcpStartErr(service, t, identity(), pyServer("pass", nil))
	if _, err := service.MCPRecv(context.Background(), MCPRecvRequest{ConnectionID: id, Owner: "private:1"}); !errors.Is(err, ErrMCPConnectionNotFound) {
		t.Fatalf("an ended connection outlived its retention: %v", err)
	}
}
