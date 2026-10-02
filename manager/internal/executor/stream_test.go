package executor

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func auditedTerminalCall(t *testing.T, service *Service, id, command string, details map[string]any) Call {
	t.Helper()
	arguments, _ := json.Marshal(terminalArguments{Command: command})
	if details == nil {
		details = map[string]any{"command": "[redacted]"}
	}
	bound := identity()
	bound.ToolCallID = id
	request := AuditRequest{Identity: bound, AuditID: id, Target: "sandbox", Operation: "terminal", Action: "run", Arguments: arguments, Details: details}
	receipt, err := service.Audit(request)
	if err != nil {
		t.Fatal(err)
	}
	return callForReceipt(request, receipt, "run", arguments)
}

type frameLog struct {
	mu     sync.Mutex
	frames []OutputFrame
	at     []time.Time
}

func (l *frameLog) emit(frame any) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.frames = append(l.frames, frame.(OutputFrame))
	l.at = append(l.at, time.Now())
	return nil
}

func (l *frameLog) joined(stream string) string {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out strings.Builder
	for _, frame := range l.frames {
		if frame.Stream == stream {
			out.WriteString(frame.Data)
		}
	}
	return out.String()
}

func TestTerminalStreamEmitsOrderedFramesMatchingResult(t *testing.T) {
	service, _ := newTestService(t)
	// The redactor withholds a 512-byte undecided suffix, so each write is padded.
	call := auditedTerminalCall(t, service, "stream-order", "printf '%0600d\\n' 1; sleep 0.3; printf '%0600d\\n' 2 >&2; sleep 0.3; printf '%0600d\\n' 3; exit 3", nil)
	var log frameLog
	started := time.Now()
	response, err := service.TerminalStream(context.Background(), call, log.emit)
	if err != nil {
		t.Fatal(err)
	}
	result := response["result"].(ProcessSnapshot)
	if len(result.Stdout) != 1202 || len(result.Stderr) != 601 || result.ExitCode == nil || *result.ExitCode != 3 {
		t.Fatalf("unexpected result: %+v", result)
	}
	if len(log.frames) < 3 {
		t.Fatalf("output was not streamed as it was committed: %+v", log.frames)
	}
	var order []string
	for _, frame := range log.frames {
		if frame.Type != "output" {
			t.Fatalf("unexpected frame type %q", frame.Type)
		}
		order = append(order, frame.Stream)
	}
	if len(order) < 3 || order[0] != "stdout" || order[1] != "stderr" {
		t.Fatalf("frame order = %v", order)
	}
	if log.joined("stdout") != result.Stdout || log.joined("stderr") != result.Stderr {
		t.Fatalf("frames differ from result: %+v", log.frames)
	}
	if log.at[0].Sub(started) > 250*time.Millisecond {
		t.Fatalf("first frame was held until the command ended: %v", log.at[0].Sub(started))
	}
}

func TestTerminalStreamNeverEmitsSecretSplitAcrossWrites(t *testing.T) {
	service, _ := newTestService(t)
	call := auditedTerminalCall(t, service, "stream-redact", "printf 'before\\nAuthorization: Bearer sec'; sleep 0.4; printf 'ret-canary\\nafter\\n'", nil)
	var log frameLog
	response, err := service.TerminalStream(context.Background(), call, log.emit)
	if err != nil {
		t.Fatal(err)
	}
	result := response["result"].(ProcessSnapshot)
	if strings.Contains(result.Stdout, "secret-canary") {
		t.Fatalf("result leaked secret: %q", result.Stdout)
	}
	for _, frame := range log.frames {
		for _, leak := range []string{"Bearer sec", "ret-canary", "secret-canary"} {
			if strings.Contains(frame.Data, leak) {
				t.Fatalf("frame leaked %q: %+v", leak, frame)
			}
		}
	}
	if log.joined("stdout") != result.Stdout {
		t.Fatalf("frames %q differ from result %q", log.joined("stdout"), result.Stdout)
	}
}

func TestTerminalStreamNeverStreamsPrivateMCPOutput(t *testing.T) {
	service, _ := newTestService(t)
	details := map[string]any{"tool": "mcp", "action": "call", "arguments": map[string]any{"server": "local", "tool": "echo"}}
	call := auditedTerminalCall(t, service, "stream-private", "printf private-output; printf private-err >&2", details)
	var log frameLog
	response, err := service.TerminalStream(context.Background(), call, log.emit)
	if err != nil {
		t.Fatal(err)
	}
	if result := response["result"].(ProcessSnapshot); result.Stdout != "private-output" || result.Stderr != "private-err" {
		t.Fatalf("unexpected private result: %+v", result)
	}
	if len(log.frames) != 0 {
		t.Fatalf("private output was streamed: %+v", log.frames)
	}
}

func TestTerminalStreamCapsStreamedBytesButNotResult(t *testing.T) {
	service, _ := newTestService(t)
	service.Processes.MaxOutput = 2 << 20
	call := auditedTerminalCall(t, service, "stream-cap", `python3 -c "import sys; sys.stdout.write('x'*(1<<20)); sys.stderr.write('y'*(1<<20))"`, nil)
	var log frameLog
	response, err := service.TerminalStream(context.Background(), call, log.emit)
	if err != nil {
		t.Fatal(err)
	}
	result := response["result"].(ProcessSnapshot)
	if len(result.Stdout) != 1<<20 || len(result.Stderr) != 1<<20 {
		t.Fatalf("result is not authoritative: %d/%d", len(result.Stdout), len(result.Stderr))
	}
	if total := len(log.joined("stdout")) + len(log.joined("stderr")); total > streamOutputLimit {
		t.Fatalf("streamed %d bytes, limit %d", total, streamOutputLimit)
	}
	if !strings.HasPrefix(result.Stdout, log.joined("stdout")) || !strings.HasPrefix(result.Stderr, log.joined("stderr")) {
		t.Fatal("streamed output is not a prefix of the result")
	}
}

func TestLiveOutputIsBoundedWhenReaderIsSlow(t *testing.T) {
	live := newLiveOutput()
	chunk := []byte(strings.Repeat("z", 4096))
	for range 1024 { // 4 MiB with nothing draining
		live.append("stdout", chunk)
	}
	live.mu.Lock()
	pending, stopped := live.pending, live.stopped
	live.mu.Unlock()
	if pending > streamPendingLimit || !stopped {
		t.Fatalf("pending=%d stopped=%v", pending, stopped)
	}
	// A command runs to completion even when no reader ever drains.
	service, _ := newTestService(t)
	call := auditedTerminalCall(t, service, "stream-slow", `python3 -c "import sys; sys.stdout.write('x'*(900*1024))"`, nil)
	slow := newLiveOutput()
	response, err := service.terminal(context.Background(), call, slow)
	if err != nil {
		t.Fatal(err)
	}
	if len(response["result"].(ProcessSnapshot).Stdout) != 900*1024 {
		t.Fatal("slow reader changed the result")
	}
	slow.mu.Lock()
	defer slow.mu.Unlock()
	if slow.pending > streamPendingLimit {
		t.Fatalf("pending=%d exceeds bound", slow.pending)
	}
}

func TestLiveOutputKeepsRunesWholeAcrossWrites(t *testing.T) {
	live := newLiveOutput()
	text := "héllo 你好 😀 end"
	for _, b := range []byte(text) {
		live.append("stdout", []byte{b})
	}
	live.close()
	var got strings.Builder
	live.drain(func(frame any) error {
		data := frame.(OutputFrame).Data
		if strings.ContainsRune(data, '\uFFFD') {
			t.Fatalf("frame split a rune: %q", data)
		}
		got.WriteString(data)
		return nil
	})
	if got.String() != text {
		t.Fatalf("got %q", got.String())
	}
}

func TestLiveOutputCoalescesAdjacentSegments(t *testing.T) {
	live := newLiveOutput()
	for i := range 100 {
		live.append("stdout", []byte(strconv.Itoa(i%10)))
	}
	live.append("stderr", []byte("e"))
	live.close()
	frames := 0
	live.drain(func(any) error { frames++; return nil })
	if frames != 2 {
		t.Fatalf("frames = %d, want 2", frames)
	}
}
