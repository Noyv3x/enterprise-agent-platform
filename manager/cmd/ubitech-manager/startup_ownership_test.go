package main

import (
	"errors"
	"fmt"
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
	cfg, err := loadWithProfile(testActiveProfile, configPath)
	if err != nil {
		t.Fatal(err)
	}
	err = func() error {
		startup, admissionErr := acquireServeStartupOwnershipWithConfig(testActiveProfile, cfg, managerInstallPath(testActiveProfile))
		if admissionErr != nil {
			return fmt.Errorf("validate Manager startup ownership before construction: %w", admissionErr)
		}
		defer startup.release()
		builderCalls++
		return errors.New("builder must not run")
	}()
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

	cfg, err := loadWithProfile(testActiveProfile, configPath)
	if err != nil {
		t.Fatal(err)
	}
	profile, err := testActiveProfile.Profile()
	if err != nil {
		t.Fatal(err)
	}
	routedStable := profile.ManagerInstallPath(filepath.Join(base, "journal-bin"))
	if routedStable == managerInstallPath(testActiveProfile) {
		t.Fatal("test routed stable unexpectedly equals the ambient Manager path")
	}
	startup, err := acquireServeStartupOwnershipWithConfig(testActiveProfile, cfg, routedStable)
	if err != nil {
		t.Fatal(err)
	}
	if startup.manager.InstallPath != routedStable {
		startup.release()
		t.Fatalf("startup ownership Manager stable = %q, want routed %q", startup.manager.InstallPath, routedStable)
	}
	manager := &selfupdate.Manager{Profile: testActiveProfile, Root: filepath.Join(stateDir, "manager-binaries")}
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

func TestServeSingletonRevalidatesRouteBeforeRecoveryOwnership(t *testing.T) {
	base := t.TempDir()
	dataRoot := filepath.Join(base, "data")
	stateDir := filepath.Join(dataRoot, "manager")
	recoveries := filepath.Join(stateDir, "manager-binaries", "recoveries")
	if err := os.MkdirAll(recoveries, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(recoveries, "recover-current-aaaaaaaaaaaa-bbbbbbbbbbbb.json"), []byte("{malformed"), 0o600); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(base, "manager.toml")
	if err := os.WriteFile(configPath, []byte("data_root = \""+dataRoot+"\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDG_BIN_HOME", filepath.Join(base, "bin"))
	cfg, err := loadWithProfile(testActiveProfile, configPath)
	if err != nil {
		t.Fatal(err)
	}
	routeErr := errors.New("synthetic route changed")
	startup, err := acquireServeStartupOwnershipWithConfigAndRevalidation(testActiveProfile, cfg, managerInstallPath(testActiveProfile), func() error {
		return routeErr
	})
	if startup != nil {
		startup.release()
		t.Fatal("startup admission survived a failed route revalidation")
	}
	if !errors.Is(err, routeErr) || strings.Contains(err.Error(), "decode") {
		t.Fatalf("startup error = %v, want route failure before malformed recovery state", err)
	}
}
