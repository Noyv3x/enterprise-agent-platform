package selfupdate

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

var testActiveProfile = identity.CompileTimeActiveProfile()

func TestSupervisorPrerequisiteRejectsLegacyButAllowsSupervisedCandidate(t *testing.T) {
	m, s := launcherFixture(t)
	if err := m.RequireSupervisor(); err != nil {
		t.Fatalf("valid pending supervisor selection rejected: %v", err)
	}
	s.Proven = false
	if err := atomicfile.WriteJSON(m.launcherPath(), s, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := m.RequireSupervisor(); err == nil {
		t.Fatal("unproven N handoff accepted")
	}
	s.Proven = true
	if err := atomicfile.WriteJSON(m.launcherPath(), s, 0o600); err != nil {
		t.Fatal(err)
	}
	state, err := m.load()
	if err != nil {
		t.Fatal(err)
	}
	state.Activation = json.RawMessage(`{"plan_path":"legacy-plan.json"}`)
	if err := atomicfile.WriteJSON(m.StatePath, state, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := m.RequireSupervisor(); err == nil {
		t.Fatal("legacy activation accepted")
	}
	if err := os.Remove(m.launcherPath()); err != nil {
		t.Fatal(err)
	}
	if err := m.RequireSupervisor(); err == nil {
		t.Fatal("missing N supervisor accepted")
	}
}

func TestBootstrapRefusesExistingInstallationWithoutMutation(t *testing.T) {
	m, _ := launcherFixture(t)
	before, err := os.ReadFile(m.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.BootstrapLauncher(context.Background()); err == nil {
		t.Fatal("bootstrap replaced existing installation")
	}
	after, err := os.ReadFile(m.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(before) {
		t.Fatal("failed bootstrap mutated binary state")
	}
}

func TestSupervisorStateRejectsPublicPermissions(t *testing.T) {
	m, _ := launcherFixture(t)
	if err := os.Chmod(m.StatePath, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := m.RequireSupervisor(); err == nil {
		t.Fatal("public binary state accepted")
	}
}

func TestSupervisorIgnoresRetiredHandoffReceipt(t *testing.T) {
	m, _ := launcherFixture(t)
	path := filepath.Join(m.Root, "bridge-handoff.json")
	if err := os.WriteFile(path, []byte("retained legacy bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := m.RequireSupervisor(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "retained legacy bytes" {
		t.Fatalf("retired receipt changed: %v", err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := m.RequireSupervisor(); err != nil {
		t.Fatalf("retired receipt required: %v", err)
	}
}

func TestInstalledFilePermissions(t *testing.T) {
	for _, test := range []struct {
		name    string
		mode    os.FileMode
		symlink bool
		accept  bool
	}{
		{"readable", 0o644, false, true},
		{"executable", 0o755, false, true},
		{"group-writable", 0o664, false, false},
		{"other-writable", 0o646, false, false},
		{"symlink", 0o644, true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "installed")
			const content = "installed-file-content"
			if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(path, test.mode); err != nil {
				t.Fatal(err)
			}
			if test.symlink {
				link := path + ".link"
				if err := os.Symlink(path, link); err != nil {
					t.Fatal(err)
				}
				path = link
			}
			data, _, err := readRecoveryRegularFile(path, 4096, false)
			if test.accept {
				if err != nil || string(data) != content {
					t.Fatalf("safe installed file rejected: data=%q error=%v", data, err)
				}
			} else if err == nil {
				t.Fatal("unsafe installed file accepted")
			}
		})
	}
}

func TestControlTokenRemainsPrivate(t *testing.T) {
	for _, test := range []struct {
		name    string
		mode    os.FileMode
		symlink bool
		accept  bool
	}{
		{"private", 0o600, false, true},
		{"group-readable", 0o640, false, false},
		{"public-readable", 0o644, false, false},
		{"public-executable", 0o755, false, false},
		{"symlink", 0o600, true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.Chmod(dir, 0o700); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(dir, "manager-token")
			const token = "test-control-token-with-at-least-32-bytes"
			if err := os.WriteFile(path, []byte(token+"\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(path, test.mode); err != nil {
				t.Fatal(err)
			}
			if test.symlink {
				link := path + ".link"
				if err := os.Symlink(path, link); err != nil {
					t.Fatal(err)
				}
				path = link
			}
			value, err := readRecoveryControlToken(path)
			if test.accept {
				if err != nil || value != token {
					t.Fatalf("private control token rejected: %v", err)
				}
			} else if err == nil {
				t.Fatal("non-private control token accepted")
			}
		})
	}
}
