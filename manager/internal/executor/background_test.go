package executor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/driver"
)

var bgCalls atomic.Int64

// receipted records an audit receipt for a process call and returns the Call.
func receipted(t *testing.T, service *Service, ident Identity, action string, arguments any, details map[string]any) Call {
	t.Helper()
	raw, err := json.Marshal(arguments)
	if err != nil {
		t.Fatal(err)
	}
	ident.ToolCallID = "tool-" + strconv.FormatInt(bgCalls.Add(1), 10)
	request := AuditRequest{Identity: ident, AuditID: "audit-" + ident.ToolCallID, Target: "sandbox", Operation: "process", Action: action, Arguments: raw, Details: details}
	receipt, err := service.Audit(request)
	if err != nil {
		t.Fatal(err)
	}
	return Call{Identity: ident, AuditID: receipt.AuditID, ExecutorID: receipt.ExecutorID, Target: "sandbox", Action: action, Arguments: raw}
}

func bgStart(t *testing.T, service *Service, ident Identity, args processStartArguments) ProcessView {
	t.Helper()
	view, err := bgStartErr(service, t, ident, args)
	if err != nil {
		t.Fatal(err)
	}
	return view
}

func bgStartErr(service *Service, t *testing.T, ident Identity, args processStartArguments) (ProcessView, error) {
	t.Helper()
	call := receipted(t, service, ident, "start", args, map[string]any{"command": args.Command, "cwd": args.CWD})
	result, err := service.ProcessStart(context.Background(), call)
	if err != nil {
		return ProcessView{}, err
	}
	return result["process"].(ProcessView), nil
}

func bgKill(t *testing.T, service *Service, ident Identity, id string) ProcessView {
	t.Helper()
	call := receipted(t, service, ident, "kill", processKillArguments{ProcessID: id}, map[string]any{"process_id": id})
	result, err := service.ProcessKill(context.Background(), call)
	if err != nil {
		t.Fatal(err)
	}
	return result["process"].(ProcessView)
}

func bgStdin(service *Service, t *testing.T, ident Identity, id, data string, eof bool) (ProcessView, error) {
	t.Helper()
	call := receipted(t, service, ident, "stdin", processStdinArguments{ProcessID: id, Data: data, EOF: eof}, map[string]any{"process_id": id, "bytes": len(data)})
	result, err := service.ProcessStdin(context.Background(), call)
	if err != nil {
		return ProcessView{}, err
	}
	return result["process"].(ProcessView), nil
}

func bgRead(t *testing.T, service *Service, id string, offset int64, max, wait int) ProcessReadResult {
	t.Helper()
	result, err := service.ProcessRead(context.Background(), ProcessReadRequest{ProcessID: id, Owner: "private:1", Offset: offset, MaxBytes: max, WaitMS: wait})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func bgWaitEnded(t *testing.T, service *Service, id string) ProcessView {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		result := bgRead(t, service, id, 0, 1, 500)
		if result.Process.State != "running" {
			return result.Process
		}
	}
	t.Fatal("process did not end")
	return ProcessView{}
}

func bgAll(t *testing.T, service *Service, id string) string {
	t.Helper()
	bgWaitEnded(t, service, id)
	return bgRead(t, service, id, 0, processReadMaximumBytes, 0).Data
}

func waitForPID(t *testing.T, marker string) int {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(marker); err == nil {
			if pid, _ := strconv.Atoi(strings.TrimSpace(string(data))); pid > 1 {
				return pid
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("marker pid was not written")
	return 0
}

func TestBackgroundReadOffsetsTailAndLongPoll(t *testing.T) {
	service, _ := newTestService(t)
	view := bgStart(t, service, identity(), processStartArguments{Command: "printf abc; sleep 0.6; printf def; printf 'h\\303\\251llo'"})
	if view.State != "running" || view.Owner != "private:1" || !strings.HasPrefix(view.ID, "proc_") || len(view.ID) != 31 || view.Seq == 0 {
		t.Fatalf("unexpected start view: %+v", view)
	}
	first := bgRead(t, service, view.ID, 0, 0, 5000)
	if first.Data != "abc" || first.OffsetStart != 0 || first.NextOffset != 3 || first.EOF {
		t.Fatalf("long poll returned %+v", first)
	}
	started := time.Now()
	second := bgRead(t, service, view.ID, first.NextOffset, 0, 5000)
	if !strings.HasPrefix(second.Data, "def") || time.Since(started) < 200*time.Millisecond {
		t.Fatalf("second poll did not wait for new bytes: %+v after %v", second, time.Since(started))
	}
	ended := bgWaitEnded(t, service, view.ID)
	if ended.State != "exited" || ended.ExitCode == nil || *ended.ExitCode != 0 || ended.EndedAt == nil || ended.LogBytes != int64(len("abcdefhéllo")) {
		t.Fatalf("unexpected end view: %+v", ended)
	}
	all := bgRead(t, service, view.ID, 0, 0, 0)
	if all.Data != "abcdefhéllo" || !all.EOF || all.NextOffset != all.Process.LogBytes {
		t.Fatalf("full read %+v", all)
	}
	// Slices never split a rune: é occupies bytes 7-8, so two bytes yield "h"
	// at offset 6 and the next offset points at the rune.
	slice := bgRead(t, service, view.ID, 6, 2, 0)
	if slice.Data != "h" || slice.NextOffset != 7 || slice.EOF {
		t.Fatalf("rune boundary slice %+v", slice)
	}
	// An offset inside a rune skips its continuation byte.
	mid := bgRead(t, service, view.ID, 8, 100, 0)
	if mid.Data != "llo" || mid.OffsetStart != 9 {
		t.Fatalf("mid-rune offset %+v", mid)
	}
	tail := bgRead(t, service, view.ID, -1, 4, 0)
	if tail.Data != "llo" || !tail.EOF || !utf8.ValidString(tail.Data) {
		t.Fatalf("tail %+v", tail)
	}
	if past := bgRead(t, service, view.ID, 10_000, 0, 0); past.Data != "" || past.NextOffset != all.Process.LogBytes || !past.EOF {
		t.Fatalf("offset past the end %+v", past)
	}
	if _, err := service.ProcessRead(context.Background(), ProcessReadRequest{ProcessID: view.ID, Owner: "private:1", Offset: -2}); err == nil {
		t.Fatal("negative offset was accepted")
	}
	// Cancelling a long poll returns promptly with the context error.
	running := bgStart(t, service, identity(), processStartArguments{Command: "sleep 30"})
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	if _, err := service.ProcessRead(ctx, ProcessReadRequest{ProcessID: running.ID, Owner: "private:1", WaitMS: 30000}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("long poll ignored cancellation: %v", err)
	}
	bgKill(t, service, identity(), running.ID)
}

func TestBackgroundExitCodeAndTimeout(t *testing.T) {
	service, _ := newTestService(t)
	// Bash-only syntax: the model is told it runs bash, and /bin/sh is dash in the sandbox.
	exited := bgStart(t, service, identity(), processStartArguments{Command: "set -o pipefail; a=(out); [[ -n ${a[0]} ]] && echo ${a[0]}; echo err >&2; exit 7"})
	view := bgWaitEnded(t, service, exited.ID)
	if view.State != "exited" || *view.ExitCode != 7 || view.Reason != "" || view.StdinOpen {
		t.Fatalf("unexpected exit view: %+v", view)
	}
	if got := bgRead(t, service, exited.ID, 0, 0, 0).Data; !strings.Contains(got, "out\n") || !strings.Contains(got, "err\n") {
		t.Fatalf("stdout and stderr were not combined: %q", got)
	}
	marker := filepath.Join(t.TempDir(), "child")
	timed := bgStart(t, service, identity(), processStartArguments{Command: "sleep 60 & echo $! > " + shellQuote(marker) + "; wait", TimeoutMS: 300})
	pid := waitForPID(t, marker)
	view = bgWaitEnded(t, service, timed.ID)
	if view.State != "killed" || view.Reason != "timeout" || view.Unconfirmed {
		t.Fatalf("unexpected timeout view: %+v", view)
	}
	if _, err := os.Stat(fmt.Sprintf("/proc/%d", pid)); !os.IsNotExist(err) {
		t.Fatalf("grandchild survived the deadline: %v", err)
	}
}

func TestBackgroundStdinAndEOF(t *testing.T) {
	service, root := newTestService(t)
	view := bgStart(t, service, identity(), processStartArguments{Command: "cat", Stdin: true})
	if !view.StdinOpen {
		t.Fatalf("stdin not open: %+v", view)
	}
	secret := "stdin-secret-canary-0123"
	if _, err := bgStdin(service, t, identity(), view.ID, secret+"\n", false); err != nil {
		t.Fatal(err)
	}
	if got := bgRead(t, service, view.ID, 0, 0, 5000).Data; got != secret+"\n" {
		// Redaction is pattern based; this canary is not a credential shape.
		t.Fatalf("stdin echo %q", got)
	}
	after, err := bgStdin(service, t, identity(), view.ID, "", true)
	if err != nil || after.StdinOpen {
		t.Fatalf("eof: %+v %v", after, err)
	}
	if _, err := bgStdin(service, t, identity(), view.ID, "late", false); err == nil {
		t.Fatal("stdin accepted data after eof")
	}
	if ended := bgWaitEnded(t, service, view.ID); ended.State != "exited" || *ended.ExitCode != 0 {
		t.Fatalf("cat did not exit on eof: %+v", ended)
	}
	// The audit trail records the byte count, never the content.
	audit, err := os.ReadFile(filepath.Join(root, "audit.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(audit), secret) || !strings.Contains(string(audit), `"bytes":`) {
		t.Fatalf("stdin audit leaked content or lost the byte count:\n%s", audit)
	}
	// Without stdin the pipe is /dev/null and the API refuses.
	closed := bgStart(t, service, identity(), processStartArguments{Command: "cat; echo done"})
	if _, err := bgStdin(service, t, identity(), closed.ID, "x", false); err == nil || !strings.Contains(err.Error(), "not open") {
		t.Fatalf("stdin to a process without stdin: %v", err)
	}
	if got := bgAll(t, service, closed.ID); got != "done\n" {
		t.Fatalf("/dev/null stdin: %q", got)
	}
	// Projection mismatch is rejected and a foreign scope cannot write.
	running := bgStart(t, service, identity(), processStartArguments{Command: "cat", Stdin: true})
	raw, _ := json.Marshal(processStdinArguments{ProcessID: running.ID, Data: "abc"})
	ident := identity()
	ident.ToolCallID = "tool-mismatch"
	receipt, err := service.Audit(AuditRequest{Identity: ident, AuditID: "audit-mismatch", Target: "sandbox", Operation: "process", Action: "stdin", Arguments: raw, Details: map[string]any{"process_id": running.ID, "bytes": 99}})
	if err != nil {
		t.Fatal(err)
	}
	call := Call{Identity: ident, AuditID: receipt.AuditID, ExecutorID: receipt.ExecutorID, Target: "sandbox", Action: "stdin", Arguments: raw}
	if _, err := service.ProcessStdin(context.Background(), call); err == nil || !strings.Contains(err.Error(), "projection") {
		t.Fatalf("mismatched byte count accepted: %v", err)
	}
	foreign := identity()
	foreign.ScopeID = "private:2"
	if _, err := bgStdin(service, t, foreign, running.ID, "x", false); !errors.Is(err, ErrProcessNotFound) {
		t.Fatalf("foreign owner stdin: %v", err)
	}
	bgKill(t, service, identity(), running.ID)
}

func TestBackgroundKillConfirmsDescendantsAndEscalates(t *testing.T) {
	for _, tc := range []struct{ name, command string }{
		{"term", "sleep 60 & echo $! > %s; wait"},
		{"escaped-session", "setsid sleep 60 & echo $! > %s; wait"},
		{"ignores-term", "trap '' TERM; sleep 60 & echo $! > %s; while true; do sleep 1; done"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			service, _ := newTestService(t)
			marker := filepath.Join(t.TempDir(), "child")
			view := bgStart(t, service, identity(), processStartArguments{Command: fmt.Sprintf(tc.command, shellQuote(marker))})
			pid := waitForPID(t, marker)
			started := time.Now()
			killed := bgKill(t, service, identity(), view.ID)
			if killed.State != "killed" || killed.Reason != "user" || killed.Unconfirmed || killed.EndedAt == nil {
				t.Fatalf("unexpected kill view: %+v", killed)
			}
			if tc.name == "ignores-term" && time.Since(started) < 300*time.Millisecond {
				t.Fatalf("SIGKILL came before the SIGTERM grace period: %v", time.Since(started))
			}
			if _, err := os.Stat(fmt.Sprintf("/proc/%d", pid)); !os.IsNotExist(err) {
				t.Fatalf("descendant survived a confirmed kill: %v", err)
			}
			again := bgKill(t, service, identity(), view.ID)
			if again.State != "killed" || again.Seq != killed.Seq {
				t.Fatalf("kill is not idempotent: %+v", again)
			}
		})
	}
}

func TestBackgroundRunCancelKillsAttachedAndKeepsDetached(t *testing.T) {
	service, _ := newTestService(t)
	bound := identity()
	attached := bgStart(t, service, bound, processStartArguments{Command: "sleep 60", Attached: true})
	promoted := bgStart(t, service, bound, processStartArguments{Command: "sleep 60", Attached: true})
	independent := bgStart(t, service, bound, processStartArguments{Command: "sleep 60"})
	detached, err := service.ProcessDetach(ProcessDetachRequest{ProcessID: promoted.ID, Owner: "private:1"})
	if err != nil || detached["process"].(ProcessView).Attached {
		t.Fatalf("detach: %+v %v", detached, err)
	}
	again, err := service.ProcessDetach(ProcessDetachRequest{ProcessID: promoted.ID, Owner: "private:1"})
	if err != nil || again["process"].(ProcessView).Seq != detached["process"].(ProcessView).Seq {
		t.Fatalf("detach must be idempotent and not bump seq: %+v %v", again, err)
	}
	if _, err := service.ProcessDetach(ProcessDetachRequest{ProcessID: attached.ID, Owner: "private:2"}); !errors.Is(err, ErrProcessNotFound) {
		t.Fatalf("detach by another owner: %v", err)
	}
	other := bound
	other.RunID = "run-other"
	otherRun := bgStart(t, service, other, processStartArguments{Command: "sleep 60", Attached: true})
	wrong := RunIdentity{RunID: bound.RunID, ScopeID: bound.ScopeID, LifecycleID: bound.LifecycleID, ExecutionContext: bound.ExecutionContext}
	wrong.ExecutionContext.Profile = "chat"
	if service.CancelRun(wrong) {
		t.Fatal("profile drift authorized cancellation")
	}
	if !service.CancelRun(RunIdentity{RunID: bound.RunID, ScopeID: bound.ScopeID, LifecycleID: bound.LifecycleID, ExecutionContext: bound.ExecutionContext}) {
		t.Fatal("run cancellation was not confirmed")
	}
	states := map[string]ProcessView{}
	for _, id := range []string{attached.ID, promoted.ID, independent.ID, otherRun.ID} {
		states[id] = bgRead(t, service, id, 0, 1, 0).Process
	}
	if v := states[attached.ID]; v.State != "killed" || v.Reason != "run_cancelled" {
		t.Fatalf("attached process: %+v", v)
	}
	for _, id := range []string{promoted.ID, independent.ID, otherRun.ID} {
		if states[id].State != "running" {
			t.Fatalf("process %s should have survived: %+v", id, states[id])
		}
		bgKill(t, service, bound, id)
	}
}

func TestBackgroundNameLimitsAndOwnership(t *testing.T) {
	service, _ := newTestService(t)
	name := "web-1.dev"
	first := bgStart(t, service, identity(), processStartArguments{Command: "sleep 60", Name: &name})
	if first.Name == nil || *first.Name != name {
		t.Fatalf("name not recorded: %+v", first)
	}
	if _, err := bgStartErr(service, t, identity(), processStartArguments{Command: "sleep 60", Name: &name}); err == nil || !strings.Contains(err.Error(), "already in use") {
		t.Fatalf("duplicate name: %v", err)
	}
	// The same name is free for another owner, and for this one after it ends.
	foreign := identity()
	foreign.ScopeID = "private:2"
	foreign.ExecutionContext = ExecutionContext{SandboxID: "private-2", WorkspaceID: "user-2"}
	other := bgStart(t, service, foreign, processStartArguments{Command: "sleep 60", Name: &name})
	if other.Owner != "private:2" {
		t.Fatalf("owner: %+v", other)
	}
	delegated := identity()
	delegated.ScopeID = "private:1/delegate/bg-4"
	child := bgStart(t, service, delegated, processStartArguments{Command: "sleep 60"})
	if child.Owner != "private:1" || child.ScopeID != "private:1/delegate/bg-4" {
		t.Fatalf("delegate scope must share the root owner: %+v", child)
	}
	bgKill(t, service, identity(), first.ID)
	reused := bgStart(t, service, identity(), processStartArguments{Command: "sleep 60", Name: &name})
	bgKill(t, service, identity(), reused.ID)
	bgKill(t, service, identity(), child.ID)
	bgKill(t, service, foreign, other.ID)

	for _, bad := range []processStartArguments{
		{Command: ""}, {Command: "true", TimeoutMS: 99}, {Command: "true", TimeoutMS: processTimeoutMaximumMilliseconds + 1},
		{Command: "true", Name: ptr("")}, {Command: "true", Name: ptr(".x")}, {Command: "true", Name: ptr("a b")},
		{Command: "true", Name: ptr(strings.Repeat("a", 49))},
	} {
		if _, err := bgStartErr(service, t, identity(), bad); err == nil {
			t.Fatalf("invalid start accepted: %+v", bad)
		}
	}
	if view := bgStart(t, service, identity(), processStartArguments{Command: "true", TimeoutMS: processTimeoutMaximumMilliseconds, Name: ptr(strings.Repeat("a", 48))}); view.State == "" {
		t.Fatal("boundary values rejected")
	}

	// Owner mismatch on every owner-checked route.
	view := bgStart(t, service, identity(), processStartArguments{Command: "sleep 60"})
	if _, err := service.ProcessRead(context.Background(), ProcessReadRequest{ProcessID: view.ID, Owner: "private:2"}); !errors.Is(err, ErrProcessNotFound) {
		t.Fatalf("read by another owner: %v", err)
	}
	if _, err := service.ProcessRead(context.Background(), ProcessReadRequest{ProcessID: "proc_00000000000000000000000000", Owner: "private:1"}); !errors.Is(err, ErrProcessNotFound) {
		t.Fatalf("unknown id: %v", err)
	}
	killCall := receipted(t, service, foreign, "kill", processKillArguments{ProcessID: view.ID}, map[string]any{"process_id": view.ID})
	if _, err := service.ProcessKill(context.Background(), killCall); !errors.Is(err, ErrProcessNotFound) {
		t.Fatalf("kill by another owner: %v", err)
	}
	// A refused owner check must not spend the receipt: the real owner's retry works.
	killCall.Identity = identity()
	if listed, _ := service.ProcessList(ProcessListRequest{Owner: "private:9", IncludeFinished: true}); len(listed["processes"].([]ProcessView)) != 0 {
		t.Fatalf("list leaked another owner's processes: %+v", listed)
	}
	bgKill(t, service, identity(), view.ID)

	// Receipts bind the operation: a terminal receipt cannot start a process.
	raw, _ := json.Marshal(processStartArguments{Command: "true"})
	ident := identity()
	ident.ToolCallID = "tool-terminal"
	receipt, err := service.Audit(AuditRequest{Identity: ident, AuditID: "audit-terminal", Target: "sandbox", Operation: "terminal", Action: "run", Arguments: raw, Details: map[string]any{"command": "true"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.ProcessStart(context.Background(), Call{Identity: ident, AuditID: receipt.AuditID, ExecutorID: receipt.ExecutorID, Target: "sandbox", Action: "start", Arguments: raw}); err == nil {
		t.Fatal("terminal receipt started a process")
	}
	// A spent receipt cannot replay.
	call := receipted(t, service, identity(), "start", processStartArguments{Command: "true"}, map[string]any{"command": "true"})
	if _, err := service.ProcessStart(context.Background(), call); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ProcessStart(context.Background(), call); err == nil {
		t.Fatal("receipt replay started a second process")
	}
}

func ptr(value string) *string { return &value }

func TestBackgroundLimits(t *testing.T) {
	service, _ := newTestService(t)
	service.Background.OwnerLimit, service.Background.GlobalLimit = 2, 3
	var ids []string
	start := func(scope string) (ProcessView, error) {
		ident := identity()
		ident.ScopeID = scope
		return bgStartErr(service, t, ident, processStartArguments{Command: "sleep 60"})
	}
	for range 2 {
		view, err := start("private:1")
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, view.ID)
	}
	if _, err := start("private:1/delegate/bg-9"); err == nil || !strings.Contains(err.Error(), "too many background processes") {
		t.Fatalf("owner limit (delegates share it): %v", err)
	}
	view, err := start("private:2")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := start("private:3"); err == nil || !strings.Contains(err.Error(), "too many background processes") {
		t.Fatalf("global limit: %v", err)
	}
	// Finished processes free their slot; rejected starts leave no record.
	bgKill(t, service, identity(), ids[0])
	if next, err := start("private:1"); err != nil {
		t.Fatalf("slot was not released: %v", err)
	} else {
		ids = append(ids, next.ID)
	}
	if got := service.Background.RunningCount(); got != 3 {
		t.Fatalf("running count %d", got)
	}
	// The foreground pool is separate and unaffected.
	if _, err := service.Processes.Run(context.Background(), Call{Identity: identity(), Target: "sandbox"}, terminalArguments{Command: "true"}); err != nil {
		t.Fatalf("foreground blocked by background limit: %v", err)
	}
	foreign := identity()
	foreign.ScopeID = "private:2"
	bgKill(t, service, foreign, view.ID)
	for _, id := range ids[1:] {
		bgKill(t, service, identity(), id)
	}
}

func TestBackgroundChangesFeedOrderingAndLongPoll(t *testing.T) {
	service, _ := newTestService(t)
	empty, err := service.ProcessChanges(context.Background(), ProcessChangesRequest{})
	if err != nil || len(empty.Changes) != 0 || empty.Next != 0 {
		t.Fatalf("empty feed: %+v %v", empty, err)
	}
	a := bgStart(t, service, identity(), processStartArguments{Command: "sleep 60", Attached: true})
	b := bgStart(t, service, identity(), processStartArguments{Command: "sleep 60"})
	feed, err := service.ProcessChanges(context.Background(), ProcessChangesRequest{After: 0})
	if err != nil || len(feed.Changes) != 2 || feed.Changes[0].ID != a.ID || feed.Changes[1].ID != b.ID || feed.Changes[0].Seq >= feed.Changes[1].Seq || feed.Next != feed.Changes[1].Seq {
		t.Fatalf("feed: %+v %v", feed, err)
	}
	// Output does not bump seq.
	if again, _ := service.ProcessChanges(context.Background(), ProcessChangesRequest{After: feed.Next}); len(again.Changes) != 0 || again.Next != feed.Next {
		t.Fatalf("no change expected: %+v", again)
	}
	// A long poll wakes on a state change and returns only what changed.
	result := make(chan ProcessChangesResult, 1)
	go func() {
		got, _ := service.ProcessChanges(context.Background(), ProcessChangesRequest{After: feed.Next, WaitMS: 10000})
		result <- got
	}()
	time.Sleep(150 * time.Millisecond)
	if _, err := service.ProcessDetach(ProcessDetachRequest{ProcessID: a.ID, Owner: "private:1"}); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-result:
		if len(got.Changes) != 1 || got.Changes[0].ID != a.ID || got.Changes[0].Attached || got.Changes[0].Seq <= feed.Next {
			t.Fatalf("woken feed: %+v", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("long poll did not wake")
	}
	started := time.Now()
	idle, _ := service.ProcessChanges(context.Background(), ProcessChangesRequest{After: 1 << 40, WaitMS: 200})
	if time.Since(started) > 150*time.Millisecond && len(idle.Changes) == 0 {
		t.Fatalf("an after-cursor beyond the counter must resync from the start: %+v", idle)
	}
	if len(idle.Changes) != 2 {
		t.Fatalf("resync returned %+v", idle)
	}
	killed := bgKill(t, service, identity(), b.ID)
	last, _ := service.ProcessChanges(context.Background(), ProcessChangesRequest{After: feed.Next})
	if len(last.Changes) != 2 || last.Changes[1].ID != b.ID || last.Changes[1].State != "killed" || last.Next != killed.Seq {
		t.Fatalf("final feed: %+v", last)
	}
	bgKill(t, service, identity(), a.ID)
}

func TestBackgroundChangesPaginatesAtFiveHundred(t *testing.T) {
	service, _ := newTestService(t)
	background := service.Background
	background.mu.Lock()
	for range 520 {
		id, err := newProcessID(time.Now())
		if err != nil {
			t.Fatal(err)
		}
		log, err := newProcessLog(filepath.Join(background.Dir, id), background.LogCap, background.LogDrop)
		if err != nil {
			t.Fatal(err)
		}
		ended := time.Now()
		p := &bgProcess{visible: true, log: log, done: make(chan struct{}), rec: processRecord{ID: id, Owner: "private:1", State: "exited", StartedAt: ended, EndedAt: &ended}}
		close(p.done)
		background.procs[id] = p
		_ = background.bumpLocked(p)
	}
	background.mu.Unlock()
	first, _ := service.ProcessChanges(context.Background(), ProcessChangesRequest{})
	if len(first.Changes) != 500 || first.Next != first.Changes[499].Seq {
		t.Fatalf("first page: %d next %d", len(first.Changes), first.Next)
	}
	second, _ := service.ProcessChanges(context.Background(), ProcessChangesRequest{After: first.Next})
	if len(second.Changes) != 20 {
		t.Fatalf("second page: %d", len(second.Changes))
	}
}

func TestBackgroundRestartInterruptsRunningProcessesAndKeepsSeq(t *testing.T) {
	service, root := newTestService(t)
	running := bgStart(t, service, identity(), processStartArguments{Command: "echo before; sleep 60", Attached: true})
	finished := bgStart(t, service, identity(), processStartArguments{Command: "echo done"})
	bgWaitEnded(t, service, finished.ID)
	bgRead(t, service, running.ID, 0, 0, 5000)
	before, _ := service.ProcessChanges(context.Background(), ProcessChangesRequest{})

	// A new supervisor over the same state, as after a Manager restart (the
	// startup barrier has already stopped the sandbox processes).
	restarted, err := NewBackgroundManager(testActiveProfile, engineStub{}, service.Background.Sandboxes, service.Audits, BackgroundConfig{Dir: filepath.Join(root, "manager", "processes"), OwnerLimit: 16, GlobalLimit: 128})
	if err != nil {
		t.Fatal(err)
	}
	loaded, _ := restarted.Changes(context.Background(), ProcessChangesRequest{})
	if len(loaded.Changes) != len(before.Changes) || loaded.Next != before.Next {
		t.Fatalf("persisted feed differs: %+v vs %+v", loaded, before)
	}
	if err := restarted.Recover(); err != nil {
		t.Fatal(err)
	}
	feed, _ := restarted.Changes(context.Background(), ProcessChangesRequest{After: before.Next})
	if len(feed.Changes) != 1 || feed.Changes[0].ID != running.ID {
		t.Fatalf("recovery feed: %+v", feed)
	}
	got := feed.Changes[0]
	if got.State != "interrupted" || got.Reason != "system_restart" || got.StdinOpen || got.EndedAt == nil || got.Seq <= before.Next || got.ExitCode != nil {
		t.Fatalf("recovered view: %+v", got)
	}
	read, err := restarted.Read(context.Background(), ProcessReadRequest{ProcessID: running.ID, Owner: "private:1"})
	if err != nil || read.Data != "before\n" || !read.EOF {
		t.Fatalf("the log must survive a restart: %+v %v", read, err)
	}
	// Finished processes are untouched and the counter never moves backwards.
	if view, _ := restarted.Read(context.Background(), ProcessReadRequest{ProcessID: finished.ID, Owner: "private:1"}); view.Process.State != "exited" || view.Process.Seq != finished.Seq && view.Process.Seq < finished.Seq {
		t.Fatalf("finished process changed: %+v", view.Process)
	}
	again, err := NewBackgroundManager(testActiveProfile, engineStub{}, service.Background.Sandboxes, service.Audits, BackgroundConfig{Dir: filepath.Join(root, "manager", "processes"), OwnerLimit: 16, GlobalLimit: 128})
	if err != nil {
		t.Fatal(err)
	}
	if err := again.Recover(); err != nil {
		t.Fatal(err)
	}
	if after, _ := again.Changes(context.Background(), ProcessChangesRequest{After: got.Seq}); len(after.Changes) != 0 || after.Next != got.Seq {
		t.Fatalf("recovery is not idempotent: %+v", after)
	}
	audit, _ := os.ReadFile(filepath.Join(root, "audit.jsonl"))
	if !strings.Contains(string(audit), "system_restart") {
		t.Fatalf("interruption was not audited:\n%s", audit)
	}
	// The original supervisor still owns the real process; end it.
	bgKill(t, service, identity(), running.ID)
}

type countingEngine struct {
	engineStub
	mu      sync.Mutex
	stops   int
	running atomic.Bool
}

func newCountingEngine() *countingEngine {
	engine := &countingEngine{}
	engine.running.Store(true)
	return engine
}

func (e *countingEngine) StopSandbox(context.Context, string) error {
	e.mu.Lock()
	e.stops++
	e.mu.Unlock()
	return nil
}
func (e *countingEngine) SandboxRunning(context.Context, string) (bool, error) {
	return e.running.Load(), nil
}
func (e *countingEngine) stopCount() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.stops
}

func TestBackgroundResidencyBlocksIdleStopAndImageReplacement(t *testing.T) {
	engine := newCountingEngine()
	service, _ := newTestServiceWithEngine(t, engine)
	sandboxes := service.Background.Sandboxes
	view := bgStart(t, service, identity(), processStartArguments{Command: "sleep 60"})
	records := sandboxes.Records()
	if len(records) != 1 || records[0].ActiveCalls != 1 {
		t.Fatalf("a running process must pin its sandbox: %+v", records)
	}
	oldImage := records[0].Image
	stopped, err := sandboxes.Reap(context.Background(), time.Now().Add(48*time.Hour))
	if err != nil || len(stopped) != 0 || engine.stopCount() != 0 {
		t.Fatalf("idle stop ignored a running process: %v %v %d", stopped, err, engine.stopCount())
	}
	newImage := "registry/sandbox@sha256:" + strings.Repeat("b", 64)
	sandboxes.SetImage(newImage)
	spec, err := sandboxes.Ensure(context.Background(), "private-1", "user-1", time.Now())
	if err != nil || spec.Image != oldImage || engine.stopCount() != 0 {
		t.Fatalf("image replacement during a running process: %+v %v stops=%d", spec, err, engine.stopCount())
	}
	if updated, err := sandboxes.ReconcileImages(context.Background(), time.Now()); err != nil || len(updated) != 0 {
		t.Fatalf("image retirement ignored a running process: %v %v", updated, err)
	}
	bgKill(t, service, identity(), view.ID)
	if records := sandboxes.Records(); records[0].ActiveCalls != 0 {
		t.Fatalf("residency not released after the process ended: %+v", records)
	}
	// Released: idle stop works again, and a recreate follows on the next Ensure.
	stopped, err = sandboxes.Reap(context.Background(), time.Now().Add(48*time.Hour))
	if err != nil || len(stopped) != 1 || engine.stopCount() != 1 {
		t.Fatalf("idle stop after release: %v %v %d", stopped, err, engine.stopCount())
	}
	// A foreground call does not leak residency either.
	if _, err := service.Processes.Run(context.Background(), Call{Identity: identity(), Target: "sandbox"}, terminalArguments{Command: "true"}); err != nil {
		t.Fatal(err)
	}
	if records := sandboxes.Records(); records[0].ActiveCalls != 0 {
		t.Fatalf("foreground residency: %+v", records)
	}
}

func TestBackgroundSandboxStoppedAndLostSupervisor(t *testing.T) {
	engine := newCountingEngine()
	service, _ := newTestServiceWithEngine(t, engine)
	view := bgStart(t, service, identity(), processStartArguments{Command: "sleep 60"})
	service.Background.SandboxStopped("private-1")
	ended := bgWaitEnded(t, service, view.ID)
	if ended.State != "interrupted" || ended.Reason != "sandbox_stopped" || ended.Unconfirmed {
		t.Fatalf("sandbox stop: %+v", ended)
	}
	// The sandbox hook fires from Reap's stop path as well.
	if stopped, _ := service.Background.Sandboxes.Reap(context.Background(), time.Now().Add(48*time.Hour)); len(stopped) != 1 {
		t.Fatalf("expected the idle sandbox to stop: %v", stopped)
	}

	// A lost supervisor with the container gone is sandbox_stopped; with the
	// container still running its termination is unconfirmed and says so.
	engine.running.Store(false)
	gone := bgStart(t, service, identity(), processStartArguments{Command: `kill -KILL "$PPID"; sleep 2`})
	if v := bgWaitEnded(t, service, gone.ID); v.State != "interrupted" || v.Reason != "sandbox_stopped" {
		t.Fatalf("container gone: %+v", v)
	}
	engine.running.Store(true)
	lost := bgStart(t, service, identity(), processStartArguments{Command: `kill -KILL "$PPID"; sleep 2`})
	if v := bgWaitEnded(t, service, lost.ID); v.State != "failed" || !v.Unconfirmed {
		t.Fatalf("lost supervisor: %+v", v)
	}
	if records := service.Background.Sandboxes.Records(); records[0].ActiveCalls != 0 {
		t.Fatalf("residency leaked: %+v", records)
	}
}

type brokenWrapperEngine struct{ engineStub }

func (brokenWrapperEngine) ExecArgs(driver.SandboxSpec, string, string, []string) (string, []string) {
	return "sh", []string{"-c", "echo no-such-container >&2; exit 3"}
}

func TestBackgroundStartFailure(t *testing.T) {
	service, _ := newTestServiceWithEngine(t, brokenWrapperEngine{})
	view := bgStart(t, service, identity(), processStartArguments{Command: "true"})
	if view.State != "failed" || view.Reason != "start_failed" || view.ExitCode != nil {
		t.Fatalf("start failure view: %+v", view)
	}
	if got := bgRead(t, service, view.ID, 0, 0, 0).Data; got != "no-such-container\n" {
		t.Fatalf("diagnostics: %q", got)
	}
	if records := service.Background.Sandboxes.Records(); records[0].ActiveCalls != 0 {
		t.Fatalf("residency leaked on a failed start: %+v", records)
	}
}

func TestBackgroundLogRotationAdvancesRetainedFrom(t *testing.T) {
	service, root := newTestService(t)
	service.Background.LogCap, service.Background.LogDrop = 4096, 2048
	view := bgStart(t, service, identity(), processStartArguments{Command: "head -c 20000 /dev/zero | tr '\\0' a"})
	ended := bgWaitEnded(t, service, view.ID)
	if ended.LogBytes != 20000 {
		t.Fatalf("log_bytes counts the logical stream: %+v", ended)
	}
	result := bgRead(t, service, view.ID, 0, processReadMaximumBytes, 0)
	if result.RetainedFrom == 0 || result.OffsetStart != result.RetainedFrom || result.NextOffset != 20000 || !result.EOF {
		t.Fatalf("read below retained_from must clamp: %+v", result)
	}
	retained := int64(len(result.Data))
	if retained != 20000-result.RetainedFrom || retained > 4096 || retained < 2048 {
		t.Fatalf("retained %d of cap 4096, retained_from %d", retained, result.RetainedFrom)
	}
	info, err := os.Stat(filepath.Join(root, "manager", "processes", view.ID, "output.log"))
	if err != nil || info.Size() != retained {
		t.Fatalf("log file size %v vs %d: %v", info, retained, err)
	}
	// Offsets stay stable: a reader that was current keeps its position.
	if tail := bgRead(t, service, view.ID, 19990, 100, 0); tail.OffsetStart != 19990 || len(tail.Data) != 10 {
		t.Fatalf("stable offsets: %+v", tail)
	}
	// retained_from survives a restart.
	restarted, err := NewBackgroundManager(testActiveProfile, engineStub{}, service.Background.Sandboxes, service.Audits, BackgroundConfig{Dir: filepath.Join(root, "manager", "processes")})
	if err != nil {
		t.Fatal(err)
	}
	again, err := restarted.Read(context.Background(), ProcessReadRequest{ProcessID: view.ID, Owner: "private:1"})
	if err != nil || again.RetainedFrom != result.RetainedFrom || again.Process.LogBytes != 20000 {
		t.Fatalf("after restart: %+v %v", again, err)
	}
}

func TestBackgroundLogRotationKeepsRunesWhole(t *testing.T) {
	service, _ := newTestService(t)
	service.Background.LogCap, service.Background.LogDrop = 1000, 501
	view := bgStart(t, service, identity(), processStartArguments{Command: "i=0; while [ $i -lt 600 ]; do printf '\\303\\251\\342\\202\\254'; i=$((i+1)); done"})
	bgWaitEnded(t, service, view.ID)
	result := bgRead(t, service, view.ID, 0, processReadMaximumBytes, 0)
	if !utf8.ValidString(result.Data) || result.OffsetStart != result.RetainedFrom || result.NextOffset != 600*5 {
		t.Fatalf("rotation split a rune: valid=%v %+v", utf8.ValidString(result.Data), result)
	}
	if strings.ContainsRune(result.Data, utf8.RuneError) {
		t.Fatal("a whole-rune log must not contain replacement characters")
	}
}

func TestBackgroundBinaryOutputIsValidUTF8(t *testing.T) {
	service, _ := newTestService(t)
	view := bgStart(t, service, identity(), processStartArguments{Command: "printf 'a\\377b\\303'"})
	got := bgAll(t, service, view.ID)
	if got != "a\uFFFDb\uFFFD" || !utf8.ValidString(got) {
		t.Fatalf("invalid bytes must be replaced, got %q", got)
	}
}

func TestBackgroundRedactsSecretSplitAcrossChunks(t *testing.T) {
	service, _ := newTestService(t)
	command := "printf 'api_key=sk-live-sec'; sleep 0.5; printf 'retvalue0123456789\\n'; printf 'visible\\n'"
	view := bgStart(t, service, identity(), processStartArguments{Command: command})
	got := bgAll(t, service, view.ID)
	if strings.Contains(got, "sk-live") || strings.Contains(got, "retvalue") || !strings.Contains(got, outputRedactionMarker) || !strings.Contains(got, "visible\n") {
		t.Fatalf("secret split across chunks reached the log: %q", got)
	}
	// Also while the process still runs: the undecided suffix is withheld.
	live := bgStart(t, service, identity(), processStartArguments{Command: "printf 'Authorization: Bearer tok-part'; sleep 5"})
	time.Sleep(300 * time.Millisecond)
	if partial := bgRead(t, service, live.ID, 0, 0, 0).Data; strings.Contains(partial, "tok-part") {
		t.Fatalf("an undecided secret prefix was published: %q", partial)
	}
	bgKill(t, service, identity(), live.ID)
	if final := bgRead(t, service, live.ID, 0, 0, 0).Data; strings.Contains(final, "tok-part") {
		t.Fatalf("flushed log leaks: %q", final)
	}
	// The displayed command is redacted and bounded.
	secretCommand := "curl -H 'Authorization: Bearer abc123secret' https://x.test/ " + strings.Repeat("y", 6000)
	shown := bgStart(t, service, identity(), processStartArguments{Command: "true"})
	_ = shown
	call := receipted(t, service, identity(), "start", processStartArguments{Command: "true"}, map[string]any{"command": secretCommand})
	result, err := service.ProcessStart(context.Background(), call)
	if err != nil {
		t.Fatal(err)
	}
	display := result["process"].(ProcessView).Command
	if strings.Contains(display, "abc123secret") || utf8.RuneCountInString(display) > 4096 {
		t.Fatalf("view command not redacted/bounded: %d runes %q", utf8.RuneCountInString(display), display[:80])
	}
}

func TestBackgroundRetention(t *testing.T) {
	service, root := newTestService(t)
	background := service.Background
	var ticks atomic.Int64
	ticks.Store(time.Now().UnixNano())
	advance := func(d time.Duration) { ticks.Add(int64(d)) }
	background.Now = func() time.Time { return time.Unix(0, ticks.Load()).UTC() }
	background.KeepPerOwner = 2
	var ids []string
	for i := range 4 {
		view := bgStart(t, service, identity(), processStartArguments{Command: "echo " + strconv.Itoa(i)})
		bgWaitEnded(t, service, view.ID)
		ids = append(ids, view.ID)
		advance(time.Minute)
	}
	background.prune()
	list, _ := service.ProcessList(ProcessListRequest{Owner: "private:1", IncludeFinished: true})
	views := list["processes"].([]ProcessView)
	if len(views) != 2 || views[0].ID != ids[3] || views[1].ID != ids[2] {
		t.Fatalf("newest per owner: %+v", views)
	}
	for _, id := range ids[:2] {
		if _, err := os.Stat(filepath.Join(root, "manager", "processes", id)); !os.IsNotExist(err) {
			t.Fatalf("log of pruned process %s kept: %v", id, err)
		}
		if _, err := service.ProcessRead(context.Background(), ProcessReadRequest{ProcessID: id, Owner: "private:1"}); !errors.Is(err, ErrProcessNotFound) {
			t.Fatalf("pruned process readable: %v", err)
		}
	}
	// Another owner's history is counted separately.
	foreign := identity()
	foreign.ScopeID = "private:2"
	foreign.ExecutionContext = ExecutionContext{SandboxID: "private-2", WorkspaceID: "user-2"}
	other := bgStart(t, service, foreign, processStartArguments{Command: "true"})
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); {
		if result, err := background.Read(context.Background(), ProcessReadRequest{ProcessID: other.ID, Owner: "private:2", WaitMS: 500}); err == nil && result.Process.State != "running" {
			break
		}
	}
	// A running process is never pruned, however old; finished ones expire at 7 days.
	running := bgStart(t, service, identity(), processStartArguments{Command: "sleep 60"})
	advance(8 * 24 * time.Hour)
	background.prune()
	if v, err := service.ProcessRead(context.Background(), ProcessReadRequest{ProcessID: running.ID, Owner: "private:1"}); err != nil || v.Process.State != "running" {
		t.Fatalf("running process pruned: %+v %v", v, err)
	}
	list, _ = service.ProcessList(ProcessListRequest{Owner: "private:1", IncludeFinished: true})
	if views := list["processes"].([]ProcessView); len(views) != 1 || views[0].ID != running.ID {
		t.Fatalf("expired history kept: %+v", views)
	}
	if entries, _ := os.ReadDir(filepath.Join(root, "manager", "processes")); len(entries) != 2 { // index.json + running
		t.Fatalf("expected index and one process directory, got %v", entries)
	}
	bgKill(t, service, identity(), running.ID)
}

func TestBackgroundListOrdersNewestFirstAndFiltersFinished(t *testing.T) {
	service, _ := newTestService(t)
	old := bgStart(t, service, identity(), processStartArguments{Command: "true"})
	bgWaitEnded(t, service, old.ID)
	time.Sleep(5 * time.Millisecond)
	live := bgStart(t, service, identity(), processStartArguments{Command: "sleep 60"})
	listed, err := service.ProcessList(ProcessListRequest{Owner: "private:1"})
	if err != nil || len(listed["processes"].([]ProcessView)) != 1 || listed["processes"].([]ProcessView)[0].ID != live.ID {
		t.Fatalf("running only: %+v %v", listed, err)
	}
	all, _ := service.ProcessList(ProcessListRequest{Owner: "private:1", IncludeFinished: true})
	if views := all["processes"].([]ProcessView); len(views) != 2 || views[0].ID != live.ID || views[1].ID != old.ID {
		t.Fatalf("newest first: %+v", views)
	}
	if _, err := service.ProcessList(ProcessListRequest{}); err == nil {
		t.Fatal("list without owner accepted")
	}
	bgKill(t, service, identity(), live.ID)
}

func TestBackgroundAuditTrail(t *testing.T) {
	service, root := newTestService(t)
	view := bgStart(t, service, identity(), processStartArguments{Command: "exit 4"})
	bgWaitEnded(t, service, view.ID)
	deadline := time.Now().Add(3 * time.Second)
	var audit string
	for time.Now().Before(deadline) {
		data, _ := os.ReadFile(filepath.Join(root, "audit.jsonl"))
		audit = string(data)
		if strings.Contains(audit, "execution.finished") {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	for _, want := range []string{"execution.audit", "execution.started", "execution.finished", `"operation":"process"`, `"exit_code":4`} {
		if !strings.Contains(audit, want) {
			t.Fatalf("audit log lacks %s:\n%s", want, audit)
		}
	}
}
