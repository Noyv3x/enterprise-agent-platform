package sandbox

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBeginCallPersistenceFailureDoesNotPinSandbox(t *testing.T) {
	root := t.TempDir()
	engine := &sandboxEngine{}
	statePath := filepath.Join(root, "manager", "sandboxes.json")
	manager, err := Open(testActiveProfile, engine, filepath.Join(root, "data"), statePath, "sandbox@sha256:"+strings.Repeat("a", 64), "network", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if _, err := manager.Ensure(context.Background(), "private-1", "user-1", now); err != nil {
		t.Fatal(err)
	}
	backup := statePath + ".saved"
	if err := os.Rename(statePath, backup); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(statePath, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := manager.BeginCall("private-1", now); err == nil {
		t.Fatal("BeginCall accepted a registry destination that cannot be atomically replaced")
	}
	if records := manager.Records(); len(records) != 1 || records[0].ActiveCalls != 0 {
		t.Errorf("failed call admission leaked an active call: %#v", records)
	}
	if err := os.Remove(statePath); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(backup, statePath); err != nil {
		t.Fatal(err)
	}
	stopped, err := manager.Reap(context.Background(), now.Add(2*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if len(stopped) != 1 || stopped[0] != "private-1" {
		t.Errorf("failed admission prevented idle reclamation after storage recovered: %v", stopped)
	}
	engine.mu.Lock()
	defer engine.mu.Unlock()
	if len(engine.stopped) != 1 {
		t.Errorf("idle sandbox stop calls = %v, want exactly one", engine.stopped)
	}
}
