//go:build linux

package main

import (
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/config"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffstartup"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"golang.org/x/sys/unix"
)

func TestLocateStartupStateHomeUsesOnlyExplicitConfigOrOSAccountDefault(t *testing.T) {
	account, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", filepath.Join(t.TempDir(), "hostile-home"))
	t.Setenv("XDG_STATE_HOME", filepath.Join(t.TempDir(), "hostile-state"))
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(t.TempDir(), "hostile-config"))
	defaultPath, err := locateStartupStateHome(filepath.Join(t.TempDir(), "missing-manager.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(account.HomeDir, ".local", "state"); defaultPath != want {
		t.Fatalf("default state home = %q, want %q", defaultPath, want)
	}
	if got, want := defaultSourceStartupConfigPath(account.HomeDir), filepath.Join(account.HomeDir, ".config", identity.SourceProfile().ConfigDirectory, identity.SourceProfile().ConfigFile); got != want {
		t.Fatalf("default config path = %q, want OS-account path %q", got, want)
	}

	directory := t.TempDir()
	configPath := filepath.Join(directory, "arbitrary-source.toml")
	stateHome := filepath.Join(directory, "neutral-state")
	if err := os.WriteFile(configPath, []byte("data_root = \"/ignored\"\nstate_home = "+strconv.Quote(stateHome)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	located, err := locateStartupStateHome(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if located != stateHome {
		t.Fatalf("located state home = %q, want %q", located, stateHome)
	}

	if err := os.WriteFile(configPath, []byte("state_home = "+strconv.Quote(stateHome)+"\nstate_home = "+strconv.Quote(stateHome)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := locateStartupStateHome(configPath); err == nil || !strings.Contains(err.Error(), "duplicate") {
		t.Fatalf("duplicate locator was accepted: %v", err)
	}
}

func TestBindStartupConfigRejectsRetainedRawDigestMismatch(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "manager.toml")
	dataRoot := filepath.Join(root, identity.SourceProfile().DataDirectory)
	stateHome := filepath.Join(root, "state-home")
	raw := []byte("data_root = " + strconv.Quote(dataRoot) + "\nstate_home = " + strconv.Quote(stateHome) + "\n")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.LoadStartupSnapshot(identity.SourceActiveProfile(), path, raw, true, stateHome)
	if err != nil {
		t.Fatal(err)
	}
	startup := invocationStartup{decision: handoffstartup.Decision{
		ActiveProfile: identity.SourceActiveProfile(), Profile: identity.SourceProfile(), ConfigSHA256: strings.Repeat("f", 64),
		Paths: handoffstartup.RuntimePaths{
			StableBinary: filepath.Join(root, identity.SourceProfile().ManagerBinary), ConfigPath: path,
			DataRoot: cfg.DataRoot, StateRoot: cfg.StateDir, SocketPath: cfg.SocketPath,
		},
	}, stateHome: stateHome}
	if err := bindStartupConfigPath(path, &startup); err == nil || !strings.Contains(err.Error(), "digest differs") {
		t.Fatalf("mismatched retained config digest error = %v", err)
	}
}

func TestStartupConfigSnapshotDetectsReplacementAfterCapture(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "manager.toml")
	raw := []byte("state_home = \"/tmp/state-a\"\n")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	snapshot, err := locateStartupConfigSnapshot(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path, path+".old"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := verifyStartupConfigSnapshotStillBound(snapshot); err == nil || !strings.Contains(err.Error(), "identity changed") {
		t.Fatalf("same-content replacement was accepted: %v", err)
	}
}

func TestMissingStartupConfigSnapshotRejectsLaterAppearance(t *testing.T) {
	path := filepath.Join(t.TempDir(), "manager.toml")
	snapshot, err := locateStartupConfigSnapshot(path)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Exists {
		t.Fatal("missing config was reported as existing")
	}
	if err := os.WriteFile(path, []byte("state_home = \"/tmp/state\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := verifyStartupConfigSnapshotStillBound(snapshot); err == nil || !strings.Contains(err.Error(), "appeared") {
		t.Fatalf("config appearance was accepted: %v", err)
	}
}

func TestLocateStartupStateHomeRejectsSymlinkComponents(t *testing.T) {
	root := t.TempDir()
	realDirectory := filepath.Join(root, "real")
	if err := os.Mkdir(realDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	realConfig := filepath.Join(realDirectory, "manager.toml")
	if err := os.WriteFile(realConfig, []byte("state_home = \"/tmp/state\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	linkedDirectory := filepath.Join(root, "linked")
	if err := os.Symlink(realDirectory, linkedDirectory); err != nil {
		t.Fatal(err)
	}
	if _, err := locateStartupStateHome(filepath.Join(linkedDirectory, "manager.toml")); err == nil {
		t.Fatal("symlinked config parent was accepted")
	}
	linkedConfig := filepath.Join(root, "linked.toml")
	if err := os.Symlink(realConfig, linkedConfig); err != nil {
		t.Fatal(err)
	}
	if _, err := locateStartupStateHome(linkedConfig); err == nil {
		t.Fatal("symlinked config file was accepted")
	}
}

func TestStartupConfigLocatorDetectsPathReplacement(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "manager.toml")
	if err := os.WriteFile(path, []byte("state_home = \"/tmp/state-a\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	file, parentFD, leaf, opened, err := openStartupConfigNoFollow(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	defer unix.Close(parentFD)
	if err := os.Rename(path, path+".old"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("state_home = \"/tmp/state-b\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := verifyStartupConfigStillBound(parentFD, leaf, int(file.Fd()), opened); err == nil || !strings.Contains(err.Error(), "identity changed") {
		t.Fatalf("replacement was accepted: %v", err)
	}
}
