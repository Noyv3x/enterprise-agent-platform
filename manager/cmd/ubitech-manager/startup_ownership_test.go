package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/selfupdate"
)

func TestServeRejectsRecoveryOwnershipBeforeBuilderSideEffects(t *testing.T) {
	base := t.TempDir()
	dataRoot := filepath.Join(base, "data")
	stateDir := filepath.Join(dataRoot, "manager")
	recoveries := filepath.Join(stateDir, "manager-binaries", "recoveries")
	if err := os.MkdirAll(recoveries, 0o700); err != nil {
		t.Fatal(err)
	}
	journalPath := filepath.Join(recoveries, "recover-current-aaaaaaaaaaaa-bbbbbbbbbbbb.json")
	if err := os.WriteFile(journalPath, []byte("{malformed"), 0o600); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(base, "manager.toml")
	if err := os.WriteFile(configPath, []byte("data_root = \""+dataRoot+"\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDG_BIN_HOME", filepath.Join(base, "bin"))
	builderCalls := 0
	err := serveCommandWithBuild([]string{"--config", configPath}, func(string) (*application, error) {
		builderCalls++
		return nil, errors.New("builder must not run")
	})
	if err == nil || !strings.Contains(err.Error(), "before construction") {
		t.Fatalf("serve ownership error = %v", err)
	}
	if builderCalls != 0 {
		t.Fatalf("builder ran %d times before ownership admission", builderCalls)
	}
	if _, statErr := os.Lstat(filepath.Join(stateDir, "control", "manager.sock")); !os.IsNotExist(statErr) {
		t.Fatalf("serve created control socket before ownership admission: %v", statErr)
	}
}

func TestAcquireServeStartupOwnershipHoldsSingletonForAdmissionLifetime(t *testing.T) {
	base := t.TempDir()
	dataRoot := filepath.Join(base, "data")
	stateDir := filepath.Join(dataRoot, "manager")
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(base, "manager.toml")
	if err := os.WriteFile(configPath, []byte("data_root = \""+dataRoot+"\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDG_BIN_HOME", filepath.Join(base, "bin"))

	startup, err := acquireServeStartupOwnership(configPath)
	if err != nil {
		t.Fatal(err)
	}
	manager := &selfupdate.Manager{Root: filepath.Join(stateDir, "manager-binaries")}
	if second, err := manager.AcquireServeLock(); err == nil {
		second.Release()
		startup.release()
		t.Fatal("serve admission released its singleton before the serve lifetime")
	}
	startup.release()

	second, err := manager.AcquireServeLock()
	if err != nil {
		t.Fatalf("serve singleton was not released with admission: %v", err)
	}
	second.Release()
}
