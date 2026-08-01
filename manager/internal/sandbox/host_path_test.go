package sandbox

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestResolveHostPathMapsLogicalRootsAndRejectsProtectedPaths(t *testing.T) {
	root := t.TempDir()
	manager, err := Open(
		testActiveProfile,
		&sandboxEngine{},
		filepath.Join(root, "data"),
		filepath.Join(root, "manager", "sandboxes.json"),
		"sandbox@sha256:"+strings.Repeat("a", 64),
		"network",
		time.Hour,
	)
	if err != nil {
		t.Fatal(err)
	}
	spec, err := manager.Ensure(context.Background(), "private-1", "user-1", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	mapped, err := manager.ResolveHostPath("private-1", "/workspace/nested/file.txt", HostPathRead)
	if err != nil {
		t.Fatal(err)
	}
	if mapped.Root != spec.Workspace || mapped.Relative != filepath.Join("nested", "file.txt") || mapped.Canonical != filepath.Join(spec.Workspace, "nested", "file.txt") {
		t.Fatalf("unexpected host mapping: %#v", mapped)
	}

	denied := []struct {
		name   string
		path   string
		access HostPathAccess
	}{
		{name: "manager state", path: filepath.Join(root, "manager", "secrets", "manager-token"), access: HostPathRead},
		{name: "manager cwd", path: filepath.Join(root, "manager"), access: HostPathWorkingDirectory},
		{name: "standard config", path: "/home/deployer/.config/agent-platform/manager.toml", access: HostPathRead},
		{name: "target config", path: "/home/deployer/.config/agent-platform/manager.toml", access: HostPathRead},
		{name: "target manager state", path: "/home/deployer/.local/share/agent-platform/manager/state.json", access: HostPathRead},
		{name: "target runtime control", path: "/run/user/1001/agent-platform-manager/manager.sock", access: HostPathRead},
		{name: "docker socket", path: "/run/docker.sock", access: HostPathRead},
		{name: "process credentials", path: "/proc/self/environ", access: HostPathRead},
		{name: "system write", path: "/etc/passwd", access: HostPathWrite},
	}
	for _, test := range denied {
		t.Run(test.name, func(t *testing.T) {
			if _, err := manager.ResolveHostPath("private-1", test.path, test.access); err == nil || !strings.Contains(err.Error(), "protected") {
				t.Fatalf("protected host path was accepted: %v", err)
			}
		})
	}
	if _, err := manager.ResolveHostPath("private-1", "../../outside", HostPathRead); err == nil {
		t.Fatal("relative host path escaped the workspace mapping")
	}
}
