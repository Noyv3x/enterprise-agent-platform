package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/driver"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/executor"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/logstore"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/sandbox"
)

type wiringEngine struct{}

func (wiringEngine) Preflight(context.Context) error                    { return nil }
func (wiringEngine) Pull(context.Context, release.Manifest) error       { return nil }
func (wiringEngine) Prepare(context.Context, release.Manifest) error    { return nil }
func (wiringEngine) StopFixed(context.Context) error                    { return nil }
func (wiringEngine) StartFixed(context.Context, release.Manifest) error { return nil }
func (wiringEngine) Migrate(context.Context, release.Manifest) error    { return nil }
func (wiringEngine) Probe(context.Context, release.Manifest) error      { return nil }
func (wiringEngine) Logs(context.Context, string, int) (string, error)  { return "", nil }
func (wiringEngine) EnsureSandbox(context.Context, driver.SandboxSpec) error {
	return nil
}
func (wiringEngine) StopSandbox(context.Context, string) error            { return nil }
func (wiringEngine) RemoveSandbox(context.Context, string) error          { return nil }
func (wiringEngine) SandboxRunning(context.Context, string) (bool, error) { return true, nil }
func (wiringEngine) ExecArgs(driver.SandboxSpec, string, string, []string) (string, []string) {
	return "/bin/true", nil
}

func TestExecutionWiringRetainsTargetFileProfile(t *testing.T) {
	root := t.TempDir()
	active := identity.CompileTimeActiveProfile()
	engine := wiringEngine{}
	sandboxes, err := sandbox.Open(
		active,
		engine,
		filepath.Join(root, "data"),
		filepath.Join(root, "manager", "sandboxes.json"),
		"registry.invalid/sandbox@sha256:"+strings.Repeat("a", 64),
		"agent-platform_core",
		time.Hour,
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sandboxes.Ensure(context.Background(), "private-1", "user-1", time.Now()); err != nil {
		t.Fatal(err)
	}
	attachment := filepath.Join(root, "data", "attachments", "private", "1", "note.txt")
	if err := os.WriteFile(attachment, []byte("attachment"), 0o600); err != nil {
		t.Fatal(err)
	}
	shadow := filepath.Join(root, "data", "workspaces", "user-1", ".agent-platform", "attachments")
	if err := os.MkdirAll(shadow, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(shadow, "note.txt"), []byte("workspace-shadow"), 0o600); err != nil {
		t.Fatal(err)
	}
	audit := logstore.New(filepath.Join(root, "audit.jsonl"), 1<<20, 2)
	service, _, err := newExecutionService(active, engine, sandboxes, filepath.Join(root, "control"), audit, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	arguments, err := json.Marshal(map[string]any{"path": "/workspace/.agent-platform/attachments/note.txt"})
	if err != nil {
		t.Fatal(err)
	}
	content, _, err := service.Files.Execute(context.Background(), executor.Call{
		Identity: executor.Identity{ExecutionContext: executor.ExecutionContext{SandboxID: "private-1", WorkspaceID: "user-1"}},
		Target:   "sandbox", Action: "read", Arguments: arguments,
	})
	if err != nil {
		t.Fatal(err)
	}
	if content != "attachment" {
		t.Fatalf("target attachment mapping returned %q", content)
	}
}
