//go:build linux

package handoffhost

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

type installationRunner struct {
	unitPath string
	active   bool
	enabled  bool
}

func (runner *installationRunner) Run(_ context.Context, name string, arguments ...string) ([]byte, error) {
	if name != "systemctl" || len(arguments) < 2 || arguments[0] != "--user" {
		return nil, errors.New("unexpected installation command")
	}
	switch arguments[1] {
	case "daemon-reload":
		return nil, nil
	case "show":
		active, pid := "inactive", "0"
		if runner.active {
			active, pid = "active", "123"
		}
		enabled := "disabled"
		if runner.enabled {
			enabled = "enabled"
		}
		return []byte(strings.Join([]string{
			"LoadState=loaded", "ActiveState=" + active, "UnitFileState=" + enabled,
			"FragmentPath=" + runner.unitPath, "MainPID=" + pid, "",
		}, "\n")), nil
	default:
		return nil, errors.New("unexpected installation systemd action")
	}
}

func TestTargetInstallationIsReplayableAndRollbackExact(t *testing.T) {
	request, host := targetInstallationFixture(t)
	ctx := context.Background()
	if err := host.EnsureTargetInstallation(ctx, request); err != nil {
		t.Fatal(err)
	}
	unit, err := os.ReadFile(request.UnitPath)
	if err != nil {
		t.Fatal(err)
	}
	runtimeRoot := filepath.Dir(filepath.Dir(request.SocketPath))
	if !strings.Contains(string(unit), `Environment="XDG_STATE_HOME=`+request.StateHome+`"`) ||
		!strings.Contains(string(unit), `Environment="XDG_RUNTIME_DIR=`+runtimeRoot+`"`) {
		t.Fatalf("target unit does not persist custom state/runtime homes: %s", unit)
	}
	if err := host.EnsureTargetInstallation(ctx, request); err != nil {
		t.Fatalf("replay exact target installation: %v", err)
	}
	for path, mode := range map[string]os.FileMode{request.StableBinary: 0o700, request.ConfigPath: 0o600, request.UnitPath: 0o600} {
		info, err := os.Lstat(path)
		if err != nil || info.Mode().Perm() != mode {
			t.Fatalf("installed %s mode/info = %v, %v", path, info, err)
		}
	}
	if err := host.RemoveTargetInstallation(ctx, request); err != nil {
		t.Fatal(err)
	}
	if err := host.RemoveTargetInstallation(ctx, request); err != nil {
		t.Fatalf("replay target installation rollback: %v", err)
	}
	for _, path := range []string{request.StableBinary, request.ConfigPath, request.UnitPath, filepath.Dir(request.ConfigPath)} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("rollback retained %s: %v", path, err)
		}
	}
}

func TestTargetInstallationRejectsConflictAndActiveRollback(t *testing.T) {
	request, host := targetInstallationFixture(t)
	ctx := context.Background()
	if err := host.EnsureTargetInstallation(ctx, request); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(request.ConfigPath, []byte("changed = true\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := host.VerifyTargetInstallation(ctx, request); err == nil {
		t.Fatal("expected conflicting target config rejection")
	}
	if err := os.WriteFile(request.ConfigPath, request.ConfigBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	runner := host.Runner.(*installationRunner)
	runner.active = true
	if err := host.RemoveTargetInstallation(ctx, request); err == nil {
		t.Fatal("expected active target rollback rejection")
	}
}

func targetInstallationFixture(t *testing.T) (TargetInstallationRequest, *LinuxHost) {
	t.Helper()
	base := shortTempDir(t)
	tx := filepath.Join(base, "handoff_0123456789abcdef0123456789abcdef")
	helper := filepath.Join(tx, helperDirectory)
	bin := filepath.Join(base, "bin")
	configHome := filepath.Join(base, "config")
	unitHome := filepath.Join(configHome, "systemd", "user")
	for _, directory := range []string{tx, helper, bin, configHome, filepath.Join(configHome, "systemd"), unitHome} {
		if err := os.Mkdir(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	target := identity.TargetProfile()
	artifact := filepath.Join(helper, target.ManagerBinary)
	if err := os.WriteFile(artifact, []byte("target-manager\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	request := TargetInstallationRequest{
		TargetProfile: target, TransactionID: filepath.Base(tx), TransactionDirectory: tx,
		ArtifactPath: artifact, ArtifactSHA256: shaFileForTest(t, artifact),
		StableBinary: filepath.Join(bin, target.ManagerBinary),
		ConfigPath:   filepath.Join(configHome, target.ConfigDirectory, target.ConfigFile),
		UnitPath:     filepath.Join(unitHome, target.ManagerUnit), DataRoot: filepath.Join(base, target.DataDirectory),
		StateHome:   filepath.Join(base, "custom-state"),
		SocketPath:  filepath.Join(base, "runtime", filepath.FromSlash(target.RuntimeSocketPath)),
		ConfigBytes: []byte("data_root = \"" + filepath.Join(base, target.DataDirectory) + "\"\n"),
	}
	runner := &installationRunner{unitPath: request.UnitPath}
	return request, &LinuxHost{Runner: runner}
}
