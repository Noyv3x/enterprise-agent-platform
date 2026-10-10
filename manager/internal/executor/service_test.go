package executor

import (
	"context"
	"encoding/base64"
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

var testActiveProfile = technicalidentity.CompileTimeActiveProfile()

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
func (engineStub) ExecArgs(_ driver.SandboxSpec, _ string, name string, args []string) (string, []string) {
	return name, args
}

func newTestService(t *testing.T) (*Service, string) {
	t.Helper()
	return newTestServiceWithEngine(t, engineStub{})
}

func newTestServiceWithEngine(t *testing.T, engine driver.Engine) (*Service, string) {
	t.Helper()
	root := t.TempDir()
	sandboxes, err := sandbox.Open(testActiveProfile, engine, filepath.Join(root, "data"), filepath.Join(root, "manager", "sandboxes.json"), "registry/sandbox@sha256:"+strings.Repeat("a", 64), "network", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	auditLog := logstore.New(filepath.Join(root, "audit.jsonl"), 1<<20, 2)
	processes, err := NewProcessManager(testActiveProfile, engine, sandboxes, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	files, err := NewFileService(testActiveProfile, sandboxes, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	audits := AuditStore{Dir: filepath.Join(root, "control"), Log: auditLog}
	background, err := NewBackgroundManager(testActiveProfile, engine, sandboxes, audits, BackgroundConfig{Dir: filepath.Join(root, "manager", "processes"), OwnerLimit: 16, GlobalLimit: 128})
	if err != nil {
		t.Fatal(err)
	}
	background.TermGrace = 400 * time.Millisecond
	sandboxes.OnStopped = background.SandboxStopped
	return &Service{Audits: audits, Processes: processes, Background: background, Files: files}, root
}
func identity() Identity {
	return Identity{RunID: "run-1", ScopeID: "private:1", LifecycleID: "life-1", ToolCallID: "tool-1", ExecutionContext: ExecutionContext{SandboxID: "private-1", WorkspaceID: "user-1"}}
}
func TestAuditedTerminalExecutesAndDoesNotLogRawCommand(t *testing.T) {
	service, root := newTestService(t)
	arguments, _ := json.Marshal(terminalArguments{Command: "printf super-secret", CWD: "/workspace"})
	request := AuditRequest{Identity: identity(), AuditID: "audit-1", Target: "sandbox", Operation: "terminal", Action: "run", Arguments: arguments, Details: map[string]any{"command": "[redacted]"}}
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

func TestMCPAuditRetainsOnlyCanonicalActivityProjection(t *testing.T) {
	service, root := newTestService(t)
	secret := "mcp-secret-that-must-not-be-retained"
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"action":"call","server":"local","tool":"mutate","arguments":{"token":"` + secret + `"}}`))
	arguments, _ := json.Marshal(terminalArguments{
		Command:   "/usr/local/bin/agent-platform-mcp " + payload,
		CWD:       "/workspace",
		TimeoutMS: 35_000,
	})
	request := AuditRequest{
		Identity: identity(), AuditID: "audit-mcp-projection", Target: "sandbox",
		Operation: "terminal", Action: "run", Arguments: arguments,
		Details: map[string]any{
			"tool": "mcp", "action": "call",
			"arguments": map[string]any{
				"server": "local", "tool": "mutate",
				"arguments": map[string]any{"token": secret},
			},
		},
	}
	if _, err := service.Audit(request); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		filepath.Join(root, "audit.jsonl"),
		filepath.Join(root, "control", "receipts"),
	} {
		err := filepath.Walk(path, func(candidate string, info os.FileInfo, walkErr error) error {
			if walkErr != nil || info.IsDir() {
				return walkErr
			}
			content, readErr := os.ReadFile(candidate)
			if readErr != nil {
				return readErr
			}
			if strings.Contains(string(content), payload) || strings.Contains(string(content), secret) {
				t.Fatalf("MCP request leaked into %s: %s", candidate, content)
			}
			if !strings.Contains(string(content), `"server"`) || !strings.Contains(string(content), `"local"`) ||
				!strings.Contains(string(content), `"tool"`) || !strings.Contains(string(content), `"mutate"`) {
				t.Fatalf("safe MCP projection missing from %s: %s", candidate, content)
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	bad := request
	bad.AuditID = "audit-mcp-control"
	bad.Details = map[string]any{
		"tool": "mcp", "action": "call",
		"arguments": map[string]any{"server": "local", "tool": "safe\u202eevil"},
	}
	if _, err := service.Audit(bad); err == nil || !strings.Contains(err.Error(), "invalid tool") {
		t.Fatalf("dangerous MCP presentation was not rejected: %v", err)
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

func TestApprovedSandboxFilePathCannotBeRedirectedBeforeExecution(t *testing.T) {
	service, root := newTestService(t)
	if _, _, err := executeSandboxFile(t, service, "write", fileWriteArguments{Path: "/workspace/approved/secret.txt", Content: "approved"}); err != nil {
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
	request := AuditRequest{Identity: identity(), AuditID: "audit-sandbox-file", Target: "sandbox", Operation: "read_file", Action: "read", Arguments: arguments, Details: map[string]any{"path": "/workspace/approved/secret.txt"}}
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
	call := Call{Identity: request.Identity, AuditID: receipt.AuditID, ExecutorID: receipt.ExecutorID, Target: "sandbox", Action: "read", Arguments: arguments}
	if _, err := service.File(context.Background(), call); err == nil || !strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("approved host path followed a replacement symlink: %v", err)
	}
	if _, err := service.File(context.Background(), call); err == nil || !strings.Contains(err.Error(), "already consumed") {
		t.Fatalf("rejected host approval receipt was reusable: %v", err)
	}
}
