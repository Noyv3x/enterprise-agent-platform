package executor

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func registerWaitProcess(
	t *testing.T,
	manager *ProcessManager,
	id, status string,
) *managedProcess {
	t.Helper()
	stdout := &boundedBuffer{limit: 64 << 10}
	stderr := &boundedBuffer{limit: 64 << 10}
	process := &managedProcess{
		snapshot: ProcessSnapshot{
			ID:          id,
			RunID:       "run-1",
			ScopeKey:    "private:1",
			LifecycleID: "life-1",
			Target:      "sandbox",
			Command:     "long-command",
			CWD:         "/workspace",
			Status:      status,
			StartedAt:   time.Now().UTC(),
			Background:  true,
		},
		sandboxID:   "private-1",
		workspaceID: "user-1",
		done:        make(chan struct{}),
		stdout:      stdout,
		stderr:      stderr,
	}
	if !activeProcessStatus(status) {
		now := time.Now().UTC()
		code := 0
		process.snapshot.FinishedAt = &now
		process.snapshot.ExitCode = &code
		close(process.done)
	}
	manager.mu.Lock()
	manager.processes[id] = process
	manager.mu.Unlock()
	return process
}

func TestProcessWaitReturnsTerminalSnapshotImmediatelyAndStably(t *testing.T) {
	service, _ := newTestService(t)
	process := registerWaitProcess(t, service.Processes, "terminal", "completed")
	if _, err := process.stdout.Write([]byte("final output")); err != nil {
		t.Fatal(err)
	}

	first, err := service.Processes.Wait(
		context.Background(),
		"private:1",
		"life-1",
		"sandbox",
		identity().ExecutionContext,
		"terminal",
		time.Hour,
	)
	if err != nil {
		t.Fatal(err)
	}
	if first.WaitTimedOut || first.Status != "completed" || first.Stdout != "final output" {
		t.Fatalf("unexpected terminal wait result: %#v", first)
	}
	second, err := service.Processes.Wait(
		context.Background(),
		"private:1",
		"life-1",
		"sandbox",
		identity().ExecutionContext,
		"terminal",
		time.Hour,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("terminal wait was consumptive or unstable:\nfirst=%#v\nsecond=%#v", first, second)
	}
}

func TestProcessWaitRequiresExactOwnership(t *testing.T) {
	service, _ := newTestService(t)
	registerWaitProcess(t, service.Processes, "owned", "completed")
	tests := []struct {
		name      string
		scope     string
		lifecycle string
		target    string
		execution ExecutionContext
	}{
		{name: "scope", scope: "private:1/delegate/child", lifecycle: "life-1", target: "sandbox", execution: identity().ExecutionContext},
		{name: "lifecycle", scope: "private:1", lifecycle: "life-2", target: "sandbox", execution: identity().ExecutionContext},
		{name: "target", scope: "private:1", lifecycle: "life-1", target: "host", execution: identity().ExecutionContext},
		{name: "sandbox", scope: "private:1", lifecycle: "life-1", target: "sandbox", execution: ExecutionContext{SandboxID: "private-2", WorkspaceID: "user-1"}},
		{name: "workspace", scope: "private:1", lifecycle: "life-1", target: "sandbox", execution: ExecutionContext{SandboxID: "private-1", WorkspaceID: "user-2"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := service.Processes.Wait(
				context.Background(),
				test.scope,
				test.lifecycle,
				test.target,
				test.execution,
				"owned",
				time.Second,
			); err == nil || err.Error() != "process not found" {
				t.Fatalf("ownership mismatch leaked the process: %v", err)
			}
		})
	}
}

func TestProcessWaitTimeoutDoesNotStopRunningProcess(t *testing.T) {
	service, _ := newTestService(t)
	process := registerWaitProcess(t, service.Processes, "running", "running")
	var cancelled atomic.Bool
	process.cancel = func() { cancelled.Store(true) }

	result, err := service.Processes.Wait(
		context.Background(),
		"private:1",
		"life-1",
		"sandbox",
		identity().ExecutionContext,
		"running",
		100*time.Millisecond,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !result.WaitTimedOut || result.Status != "running" {
		t.Fatalf("wait timeout did not return a running observation: %#v", result)
	}
	if cancelled.Load() || process.snapshot.Status != "running" {
		t.Fatal("wait timeout stopped or mutated the process")
	}
	select {
	case <-process.done:
		t.Fatal("wait timeout settled the process controller")
	default:
	}
}

func TestProcessWaitAbortDoesNotStopRunningProcess(t *testing.T) {
	service, _ := newTestService(t)
	process := registerWaitProcess(t, service.Processes, "abortable", "running")
	var cancelled atomic.Bool
	process.cancel = func() { cancelled.Store(true) }
	waitContext, cancelWait := context.WithCancel(context.Background())
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancelWait()
	}()

	_, err := service.Processes.Wait(
		waitContext,
		"private:1",
		"life-1",
		"sandbox",
		identity().ExecutionContext,
		"abortable",
		time.Second,
	)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("wait abort returned %v, want context.Canceled", err)
	}
	if cancelled.Load() || process.snapshot.Status != "running" {
		t.Fatal("wait abort stopped or mutated the process")
	}
}

func TestProcessWaitObservesNaturalCompletion(t *testing.T) {
	service, _ := newTestService(t)
	process := registerWaitProcess(t, service.Processes, "natural", "running")
	go func() {
		time.Sleep(20 * time.Millisecond)
		_, _ = process.stdout.Write([]byte("finished"))
		finished := time.Now().UTC()
		code := 0
		process.mu.Lock()
		process.snapshot.Status = "completed"
		process.snapshot.ExitCode = &code
		process.snapshot.FinishedAt = &finished
		process.mu.Unlock()
		close(process.done)
	}()

	result, err := service.Processes.Wait(
		context.Background(),
		"private:1",
		"life-1",
		"sandbox",
		identity().ExecutionContext,
		"natural",
		time.Second,
	)
	if err != nil {
		t.Fatal(err)
	}
	if result.WaitTimedOut || result.Status != "completed" || result.Stdout != "finished" {
		t.Fatalf("natural completion was not returned: %#v", result)
	}
}

func TestServiceProcessWaitUsesClosedArgumentsAndReportsTimeout(t *testing.T) {
	service, _ := newTestService(t)
	registerWaitProcess(t, service.Processes, "service-running", "running")
	waitArguments, _ := json.Marshal(processWaitArguments{ProcessID: "service-running", TimeoutMS: 100})
	waitAudit := AuditRequest{
		Identity: identity(), AuditID: "audit-process-wait", Target: "sandbox",
		Operation: "process", Action: "wait", Arguments: waitArguments,
		Details: map[string]any{"action": "wait"},
	}
	receipt, err := service.Audit(waitAudit)
	if err != nil {
		t.Fatal(err)
	}
	waitCall := Call{
		Identity: waitAudit.Identity, AuditID: receipt.AuditID, ExecutorID: receipt.ExecutorID,
		Target: "sandbox", Action: "wait", Arguments: waitArguments,
	}
	response, err := service.Process(context.Background(), waitCall)
	if err != nil {
		t.Fatal(err)
	}
	result, ok := response["result"].(ProcessWaitResult)
	if !ok || !result.WaitTimedOut || result.Status != "running" {
		t.Fatalf("unexpected service wait response: %#v", response)
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"wait_timed_out":true`) {
		t.Fatalf("service wait response omitted timeout marker: %s", encoded)
	}

	for _, test := range []struct {
		arguments json.RawMessage
		want      string
	}{
		{arguments: json.RawMessage(`{"process_id":"service-running","timeout_ms":100,"input":"not allowed"}`), want: "unknown field"},
		{arguments: json.RawMessage(`{"process_id":"service-running","timeout_ms":99}`), want: "timeout_ms"},
		{arguments: json.RawMessage(`{"process_id":"service-running","timeout_ms":3600001}`), want: "timeout_ms"},
	} {
		call := waitCall
		call.Arguments = test.arguments
		if _, err := service.Process(context.Background(), call); err == nil || !strings.Contains(err.Error(), test.want) {
			t.Fatalf("invalid wait arguments %s returned %v, want %q", test.arguments, err, test.want)
		}
	}
}

func TestServiceProcessWaitHonorsContextWithoutStoppingProcess(t *testing.T) {
	service, _ := newTestService(t)
	process := registerWaitProcess(t, service.Processes, "service-abort", "running")
	var cancelled atomic.Bool
	process.cancel = func() { cancelled.Store(true) }
	arguments, _ := json.Marshal(processWaitArguments{ProcessID: "service-abort", TimeoutMS: 1000})
	audit := AuditRequest{
		Identity: identity(), AuditID: "audit-process-wait-abort", Target: "sandbox",
		Operation: "process", Action: "wait", Arguments: arguments,
		Details: map[string]any{"action": "wait"},
	}
	receipt, err := service.Audit(audit)
	if err != nil {
		t.Fatal(err)
	}
	call := Call{
		Identity: audit.Identity, AuditID: receipt.AuditID, ExecutorID: receipt.ExecutorID,
		Target: "sandbox", Action: "wait", Arguments: arguments,
	}
	waitContext, cancelWait := context.WithCancel(context.Background())
	cancelWait()
	if _, err := service.Process(waitContext, call); !errors.Is(err, context.Canceled) {
		t.Fatalf("service wait returned %v, want context.Canceled", err)
	}
	if cancelled.Load() || process.snapshot.Status != "running" {
		t.Fatal("service wait cancellation stopped or mutated the process")
	}
}
