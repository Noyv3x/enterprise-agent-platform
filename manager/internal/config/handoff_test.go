package config

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

func TestDeriveAndRenderHandoffTargetPreservesOperationsAndRebindsIdentity(t *testing.T) {
	root := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "config"))
	t.Setenv("XDG_DATA_HOME", filepath.Join(root, "data"))
	t.Setenv("XDG_STATE_HOME", filepath.Join(root, "state"))
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(root, "runtime"))
	for _, directory := range []string{os.Getenv("XDG_CONFIG_HOME"), os.Getenv("XDG_DATA_HOME"), os.Getenv("XDG_STATE_HOME"), os.Getenv("XDG_RUNTIME_DIR")} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	source, err := Defaults(identity.SourceActiveProfile())
	if err != nil {
		t.Fatal(err)
	}
	source.GatewayAddress = "127.0.0.1:9090"
	source.LANEnabled = true
	source.LANAddress = "10.0.0.4:9091"
	source.ReleaseURL = "https://updates.invalid/release.json"
	targetActive, err := identity.ActivateVerifiedHandoffTarget(identity.TargetProfile())
	if err != nil {
		t.Fatal(err)
	}
	targetPath := identity.TargetProfile().DefaultConfigPath(os.Getenv("XDG_CONFIG_HOME"))
	targetRoot := identity.TargetProfile().DefaultDataRoot(os.Getenv("XDG_DATA_HOME"))
	targetSocket := filepath.Join(os.Getenv("XDG_RUNTIME_DIR"), filepath.FromSlash(identity.TargetProfile().RuntimeSocketPath))
	target, err := DeriveHandoffTarget(source, targetActive, targetPath, targetRoot, targetSocket)
	if err != nil {
		t.Fatal(err)
	}
	if target.GatewayAddress != source.GatewayAddress || target.LANAddress != source.LANAddress ||
		target.ComposeProject != identity.TargetProfile().ComposeProject || target.SandboxNetwork != identity.TargetProfile().CoreNetwork ||
		target.DataRoot != targetRoot || target.StateDir != identity.TargetProfile().ManagerStateRoot(targetRoot) ||
		target.StateHome != source.StateHome || target.SocketPath != targetSocket {
		t.Fatalf("derived target config = %+v", target)
	}
	raw, err := RenderHandoffTarget(target)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(targetPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(targetActive, targetPath)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(loaded, target) {
		t.Fatalf("rendered target round trip differs\nloaded=%+v\ntarget=%+v", loaded, target)
	}
}
