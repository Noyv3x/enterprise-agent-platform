//go:build linux

package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveTargetConfigurationUsesOneOwnerControlledSnapshot(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "manager.toml")
	dataRoot := filepath.Join(root, "data")
	if err := os.WriteFile(path, []byte("data_root = \""+dataRoot+"\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := resolveTargetConfiguration(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ConfigPath != path || cfg.DataRoot != dataRoot {
		t.Fatalf("resolved config = %#v", cfg)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if cfg.ConfigPath != path || cfg.DataRoot != dataRoot {
		t.Fatal("retained configuration changed after pathname removal")
	}
}

func TestResolveTargetConfigurationRejectsRelativeAndSymlinkPaths(t *testing.T) {
	if _, err := resolveTargetConfiguration("manager.toml"); err == nil {
		t.Fatal("relative config path was accepted")
	}
	root := t.TempDir()
	target := filepath.Join(root, "target.toml")
	link := filepath.Join(root, "manager.toml")
	if err := os.WriteFile(target, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveTargetConfiguration(link); err == nil {
		t.Fatal("symbolic-link config path was accepted")
	}
}

func TestManagerInstallPathIgnoresAmbientXDGRoot(t *testing.T) {
	want, err := defaultTargetConfigPath()
	if err != nil {
		t.Fatal(err)
	}
	want = filepath.Join(filepath.Dir(filepath.Dir(filepath.Dir(want))), ".local", "bin", "agent-platform-manager")
	t.Setenv("XDG_BIN_HOME", filepath.Join(t.TempDir(), "alternate-bin"))
	if got := managerInstallPath(); got != want {
		t.Fatalf("install path = %q, want OS-account path %q", got, want)
	}
}
