package executor

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/driver"
	technicalidentity "github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/logstore"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/sandbox"
)

var testActiveProfile = technicalidentity.SourceActiveProfile()

func openBackgroundMutationAdmission(context.Context) (func(), error) {
	return func() {}, nil
}

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
	sandboxes, err := sandbox.Open(testActiveProfile, engine, filepath.Join(root, "data"), filepath.Join(root, "manager", "sandboxes.json"), "registry/sandbox@sha256:"+strings.Repeat("a", 64), "network", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	auditLog := logstore.New(filepath.Join(root, "audit.jsonl"), 1<<20, 2)
	processes, err := NewProcessManager(testActiveProfile, engine, sandboxes, 1<<20, openBackgroundMutationAdmission)
	if err != nil {
		t.Fatal(err)
	}
	files, err := NewFileService(testActiveProfile, sandboxes, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	return &Service{Audits: AuditStore{Dir: filepath.Join(root, "control"), Log: auditLog}, Processes: processes, Files: files}, root
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

func TestApprovedHostFilePathCannotBeRedirectedBeforeExecution(t *testing.T) {
	service, root := newTestService(t)
	if _, _, err := executeHostFile(t, service, "write", fileWriteArguments{Path: "/workspace/approved/secret.txt", Content: "approved"}); err != nil {
		t.Fatal(err)
	}
	managerSecrets := filepath.Join(root, "manager", "secrets")
	if err := os.MkdirAll(managerSecrets, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(managerSecrets, "secret.txt"), []byte("manager-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	arguments, _ := json.Marshal(fileReadArguments{Path: "/workspace/approved/secret.txt"})
	request := AuditRequest{Identity: identity(), AuditID: "audit-host-file", Target: "host", Operation: "read_file", Action: "read", Arguments: arguments, Details: map[string]any{"path": "/workspace/approved/secret.txt"}}
	receipt, err := service.Audit(request)
	if err != nil {
		t.Fatal(err)
	}
	workspace := filepath.Join(root, "data", "workspaces", "user-1")
	if err := os.Rename(filepath.Join(workspace, "approved"), filepath.Join(workspace, "approved-original")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(managerSecrets, filepath.Join(workspace, "approved")); err != nil {
		t.Fatal(err)
	}
	call := Call{Identity: request.Identity, AuditID: receipt.AuditID, ExecutorID: receipt.ExecutorID, Target: "host", Action: "read", Arguments: arguments}
	if _, err := service.File(context.Background(), call); err == nil || !strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("approved host path followed a replacement symlink: %v", err)
	}
	if _, err := service.File(context.Background(), call); err == nil || !strings.Contains(err.Error(), "already consumed") {
		t.Fatalf("rejected host approval receipt was reusable: %v", err)
	}
}

func TestProcessReceiptCannotCrossFromSandboxToHostProcess(t *testing.T) {
	service, _ := newTestService(t)
	arguments, _ := json.Marshal(terminalArguments{Command: "sleep 30", Background: true})
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
	if got := service.Processes.ActiveBackgroundCount(); got != 1 {
		t.Fatalf("active background process count = %d, want 1", got)
	}

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
	if got := service.Processes.ActiveBackgroundCount(); got != 0 {
		t.Fatalf("active background process count after kill = %d, want 0", got)
	}
}
