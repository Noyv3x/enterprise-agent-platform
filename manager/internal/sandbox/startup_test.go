package sandbox

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type startupEngine struct {
	*sandboxEngine
	stopErr error
}

func (e *startupEngine) StopRunningManagedSandboxes(ctx context.Context) error {
	if e.stopErr != nil {
		return e.stopErr
	}
	for name, running := range e.running {
		if running {
			if err := e.StopSandbox(ctx, name); err != nil {
				return err
			}
		}
	}
	return nil
}

func TestStartupStopsUnregisteredSandboxesAndRestartsOnDemand(t *testing.T) {
	engine := &startupEngine{sandboxEngine: &sandboxEngine{}}
	root := t.TempDir()
	state := filepath.Join(root, "manager", "sandboxes.json")
	open := func() *Manager {
		t.Helper()
		manager, err := Open(testActiveProfile, engine, filepath.Join(root, "data"), state, "sandbox-image", "network", time.Hour)
		if err != nil {
			t.Fatal(err)
		}
		return manager
	}
	manager := open()
	spec, err := manager.Ensure(context.Background(), "private-1", "user-1", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.BeginCall("private-1", time.Now()); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{spec.Workspace, spec.Home, spec.Environment} {
		if err := os.WriteFile(filepath.Join(dir, "kept"), []byte(dir), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// A crash can leave a container that was never committed to the registry.
	engine.running["unregistered-managed"] = true
	data, err := os.ReadFile(state)
	if err != nil {
		t.Fatal(err)
	}
	data = []byte(strings.Replace(string(data), "\"active_calls\": 1", "\"active_calls\": 1, \"background_processes\": 2", 1))
	if err := os.WriteFile(state, data, 0o600); err != nil {
		t.Fatal(err)
	}
	manager = open()
	if err := manager.StopRunning(context.Background()); err != nil {
		t.Fatal(err)
	}
	if engine.running[spec.ContainerName] || engine.running["unregistered-managed"] {
		t.Fatal("startup left a managed sandbox running")
	}
	record := open().Records()[0]
	if record.ActiveCalls != 0 || record.StoppedAt == nil {
		t.Fatalf("stale accounting survived startup: %#v", record)
	}
	data, err = os.ReadFile(state)
	if err != nil || strings.Contains(string(data), "background_processes") {
		t.Fatalf("obsolete accounting survived persistence: %s, %v", data, err)
	}
	for _, dir := range []string{spec.Workspace, spec.Home, spec.Environment} {
		data, err := os.ReadFile(filepath.Join(dir, "kept"))
		if err != nil || string(data) != dir {
			t.Fatalf("persistent sandbox data changed: %s, %v", data, err)
		}
	}
	if _, err := manager.Ensure(context.Background(), "private-1", "user-1", time.Now()); err != nil {
		t.Fatal(err)
	}
	if !engine.running[spec.ContainerName] || engine.running["unregistered-managed"] {
		t.Fatal("Ensure did not restart only the requested sandbox")
	}
}

func TestStartupFailurePreservesAccounting(t *testing.T) {
	for _, failure := range []string{"unsupported", "stop", "persist"} {
		t.Run(failure, func(t *testing.T) {
			engine := &startupEngine{sandboxEngine: &sandboxEngine{}}
			root := t.TempDir()
			manager, err := Open(testActiveProfile, engine, filepath.Join(root, "data"), filepath.Join(root, "manager", "sandboxes.json"), "sandbox-image", "network", time.Hour)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := manager.Ensure(context.Background(), "private-1", "user-1", time.Now()); err != nil {
				t.Fatal(err)
			}
			if err := manager.BeginCall("private-1", time.Now()); err != nil {
				t.Fatal(err)
			}
			switch failure {
			case "unsupported":
				manager.Engine = engine.sandboxEngine
			case "stop":
				engine.stopErr = errors.New("container state uncertain")
			case "persist":
				manager.StatePath = root
			}
			if err := manager.StopRunning(context.Background()); err == nil {
				t.Fatal("startup accepted uncertain cleanup")
			}
			record := manager.Records()[0]
			if record.ActiveCalls != 1 || record.StoppedAt != nil {
				t.Fatalf("failed startup changed accounting: %#v", record)
			}
		})
	}
}
