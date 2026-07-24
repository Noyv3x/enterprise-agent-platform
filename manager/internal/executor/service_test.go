package executor

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/driver"
	"github.com/ubitech/agent-platform/manager/internal/logstore"
	"github.com/ubitech/agent-platform/manager/internal/release"
	"github.com/ubitech/agent-platform/manager/internal/sandbox"
)

type engineStub struct{}

func (engineStub) Preflight(context.Context) error                         { return nil }
func (engineStub) Pull(context.Context, release.Manifest) error            { return nil }
func (engineStub) Prepare(context.Context, release.Manifest) error         { return nil }
func (engineStub) StopFixed(context.Context) error                         { return nil }
func (engineStub) StartFixed(context.Context, release.Manifest) error      { return nil }
func (engineStub) Migrate(context.Context, release.Manifest) error         { return nil }
func (engineStub) Probe(context.Context, release.Manifest) error           { return nil }
func (engineStub) Logs(context.Context, string, int) (string, error)       { return "", nil }
func (engineStub) EnsureSandbox(context.Context, driver.SandboxSpec) error { return nil }
func (engineStub) StopSandbox(context.Context, string) error               { return nil }
func (engineStub) RemoveSandbox(context.Context, string) error             { return nil }
func (engineStub) SandboxRunning(context.Context, string) (bool, error)    { return true, nil }
func (engineStub) ExecArgs(driver.SandboxSpec, string, string, []string) (string, []string) {
	return "/bin/true", nil
}

func newTestService(t *testing.T) (*Service, string) {
	t.Helper()
	root := t.TempDir()
	engine := engineStub{}
	sandboxes, err := sandbox.Open(engine, filepath.Join(root, "data"), filepath.Join(root, "sandboxes.json"), "registry/sandbox@sha256:"+strings.Repeat("a", 64), "network", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	auditLog := logstore.New(filepath.Join(root, "audit.jsonl"), 1<<20, 2)
	processes := NewProcessManager(engine, sandboxes, 1<<20)
	return &Service{Audits: AuditStore{Dir: filepath.Join(root, "control"), Log: auditLog}, Processes: processes, Files: FileService{Sandboxes: sandboxes, MaxBytes: 1 << 20}}, root
}
func identity() Identity {
	return Identity{RunID: "run-1", ScopeID: "private:1", LifecycleID: "life-1", ToolCallID: "tool-1", ExecutionContext: ExecutionContext{SandboxID: "private-1", WorkspaceID: "user-1"}}
}
func TestAuditedHostTerminalExecutesAndDoesNotLogRawCommand(t *testing.T) {
	service, root := newTestService(t)
	arguments, _ := json.Marshal(terminalArguments{Command: "printf super-secret", CWD: "/workspace"})
	request := AuditRequest{Identity: identity(), AuditID: "audit-1", Target: "host", Operation: "terminal", Action: "run", Arguments: arguments, Details: map[string]any{"command": "[redacted]"}}
	receipt, err := service.Audit(request)
	if err != nil {
		t.Fatal(err)
	}
	call := Call{Identity: request.Identity, AuditID: receipt.AuditID, ExecutorID: receipt.ExecutorID, Target: receipt.Target, Action: "run", Arguments: arguments}
	response, err := service.Terminal(context.Background(), call)
	if err != nil {
		t.Fatal(err)
	}
	result := response["result"].(ProcessSnapshot)
	if result.Stdout != "super-secret" || result.Status != "completed" {
		t.Fatalf("unexpected terminal result: %#v", result)
	}
	audit, err := os.ReadFile(filepath.Join(root, "audit.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(audit), "super-secret") {
		t.Fatalf("raw command/output leaked into audit log: %s", audit)
	}
	if !strings.Contains(string(audit), "[redacted]") {
		t.Fatal("safe audit display was not retained")
	}
}
func TestReceiptCannotBeReusedForDifferentTarget(t *testing.T) {
	service, _ := newTestService(t)
	arguments, _ := json.Marshal(terminalArguments{Command: "true"})
	request := AuditRequest{Identity: identity(), AuditID: "audit-2", Target: "sandbox", Operation: "terminal", Action: "run", Arguments: arguments, Details: map[string]any{}}
	receipt, err := service.Audit(request)
	if err != nil {
		t.Fatal(err)
	}
	call := Call{Identity: request.Identity, AuditID: receipt.AuditID, ExecutorID: receipt.ExecutorID, Target: "host", Action: "run", Arguments: arguments}
	if _, err := service.Terminal(context.Background(), call); err == nil {
		t.Fatal("expected receipt target mismatch")
	}
}

func TestProcessReceiptCannotCrossFromSandboxToHostProcess(t *testing.T) {
	service, _ := newTestService(t)
	arguments, _ := json.Marshal(terminalArguments{Command: "sleep 30", Background: true, UpdateBehavior: "terminate"})
	hostAudit := AuditRequest{Identity: identity(), AuditID: "audit-host-terminal", Target: "host", Operation: "terminal", Action: "run", Arguments: arguments, Details: map[string]any{"command": "[redacted]"}}
	hostReceipt, err := service.Audit(hostAudit)
	if err != nil {
		t.Fatal(err)
	}
	hostCall := Call{Identity: hostAudit.Identity, AuditID: hostReceipt.AuditID, ExecutorID: hostReceipt.ExecutorID, Target: "host", Action: "run", Arguments: arguments}
	response, err := service.Terminal(context.Background(), hostCall)
	if err != nil {
		t.Fatal(err)
	}
	processID := response["result"].(ProcessSnapshot).ID

	processArguments, _ := json.Marshal(processArguments{ProcessID: processID})
	processAudit := AuditRequest{Identity: identity(), AuditID: "audit-sandbox-process", Target: "sandbox", Operation: "process", Action: "read", Arguments: processArguments, Details: map[string]any{"action": "read"}}
	processReceipt, err := service.Audit(processAudit)
	if err != nil {
		t.Fatal(err)
	}
	processCall := Call{Identity: processAudit.Identity, AuditID: processReceipt.AuditID, ExecutorID: processReceipt.ExecutorID, Target: "sandbox", Action: "read", Arguments: processArguments}
	if _, err := service.Process(processCall); err == nil {
		t.Fatal("sandbox process receipt accessed a host process")
	}
	if _, err := service.Processes.Kill(hostAudit.ScopeID, hostAudit.LifecycleID, "host", processID); err != nil {
		t.Fatal(err)
	}
}
