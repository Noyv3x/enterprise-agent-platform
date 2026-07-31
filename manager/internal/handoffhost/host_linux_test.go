//go:build linux

package handoffhost

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

const testBootID = "116a2e13-30af-4ecc-8ea1-465b1b820f40"

type hostFixture struct {
	base           string
	request        ArmRequest
	spec           HelperSpec
	host           *LinuxHost
	runner         *fakeSystemdRunner
	procRoot       string
	bootPath       string
	artifact       string
	journal        string
	unitDir        string
	transactionDir string
}

type fakeSystemdRunner struct {
	mu             sync.Mutex
	spec           HelperSpec
	procRoot       string
	enabled        bool
	active         bool
	pid            int
	controlGroup   string
	calls          [][]string
	argvOverride   []string
	cgroupOverride string
}

func (runner *fakeSystemdRunner) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	runner.calls = append(runner.calls, append([]string{name}, args...))
	if name != "systemctl" || len(args) < 2 || args[0] != "--user" {
		return nil, errors.New("unexpected command")
	}
	switch args[1] {
	case "daemon-reload":
		return nil, nil
	case "enable":
		if len(args) != 3 || args[2] != runner.spec.UnitName {
			return nil, errors.New("unexpected enable")
		}
		runner.enabled = true
		return nil, nil
	case "start":
		if len(args) != 3 || args[2] != runner.spec.UnitName {
			return nil, errors.New("unexpected start")
		}
		runner.active = true
		if err := runner.writeProcess(); err != nil {
			return nil, err
		}
		return nil, nil
	case "stop":
		if len(args) != 3 || args[2] != runner.spec.UnitName {
			return nil, errors.New("unexpected stop")
		}
		runner.active = false
		return nil, nil
	case "disable":
		if len(args) != 3 || args[2] != runner.spec.UnitName {
			return nil, errors.New("unexpected disable")
		}
		runner.enabled = false
		return nil, nil
	case "is-enabled":
		if !runner.enabled {
			return nil, errors.New("disabled")
		}
		return nil, nil
	case "is-active":
		if !runner.active {
			return nil, errors.New("inactive")
		}
		return nil, nil
	case "show":
		if len(args) != 5 || args[2] != runner.spec.UnitName || args[4] != "--value" || !strings.HasPrefix(args[3], "--property=") {
			return nil, errors.New("unexpected show")
		}
		property := strings.TrimPrefix(args[3], "--property=")
		values := map[string]string{
			"MainPID": "0", "ControlPID": "0", "ControlGroup": runner.controlGroup,
			"FragmentPath": runner.spec.UnitPath, "ActiveState": "inactive", "UnitFileState": "disabled",
		}
		if runner.active {
			values["MainPID"] = integerString(runner.pid)
			values["ActiveState"] = "active"
		}
		if runner.enabled {
			values["UnitFileState"] = "enabled"
		}
		value, ok := values[property]
		if !ok {
			return nil, errors.New("unknown property")
		}
		return []byte(value + "\n"), nil
	default:
		return nil, errors.New("unexpected systemctl action")
	}
}

func (runner *fakeSystemdRunner) writeProcess() error {
	processDirectory := filepath.Join(runner.procRoot, integerString(runner.pid))
	if err := os.MkdirAll(processDirectory, 0o700); err != nil {
		return err
	}
	_ = os.Remove(filepath.Join(processDirectory, "exe"))
	if err := os.Symlink(runner.spec.ExecutablePath, filepath.Join(processDirectory, "exe")); err != nil {
		return err
	}
	argv := runner.spec.Argv
	if runner.argvOverride != nil {
		argv = runner.argvOverride
	}
	cmdline := []byte(strings.Join(argv, "\x00") + "\x00")
	if err := os.WriteFile(filepath.Join(processDirectory, "cmdline"), cmdline, 0o600); err != nil {
		return err
	}
	cgroup := runner.controlGroup
	if runner.cgroupOverride != "" {
		cgroup = runner.cgroupOverride
	}
	return os.WriteFile(filepath.Join(processDirectory, "cgroup"), []byte("0::"+cgroup+"\n"), 0o600)
}

func integerString(value int) string {
	if value == 0 {
		return "0"
	}
	digits := make([]byte, 0, 20)
	for value > 0 {
		digits = append(digits, byte('0'+value%10))
		value /= 10
	}
	for left, right := 0, len(digits)-1; left < right; left, right = left+1, right-1 {
		digits[left], digits[right] = digits[right], digits[left]
	}
	return string(digits)
}

func newHostFixture(t *testing.T) *hostFixture {
	t.Helper()
	base := shortTempDir(t)
	transactionID := randomTestTransactionID(t)
	transactionDirectory := filepath.Join(base, transactionID)
	if err := os.Mkdir(transactionDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	journal := filepath.Join(transactionDirectory, journalBasename)
	if err := os.WriteFile(journal, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	artifact := filepath.Join(base, "verified-manager")
	if err := os.WriteFile(artifact, []byte("immutable helper artifact\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	artifactSHA := shaFileForTest(t, artifact)
	unitDir := filepath.Join(base, "systemd", "user")
	if err := os.MkdirAll(unitDir, 0o700); err != nil {
		t.Fatal(err)
	}
	procRoot := filepath.Join(base, "proc")
	if err := os.Mkdir(procRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	bootPath := filepath.Join(base, "boot_id")
	if err := os.WriteFile(bootPath, []byte(testBootID+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	request := ArmRequest{
		TargetProfile: identity.TargetProfile(), TransactionID: transactionID,
		TransactionDirectory: transactionDirectory, ArtifactPath: artifact,
		ArtifactSHA256: artifactSHA, UnitDirectory: unitDir, JournalPath: journal,
	}
	host := &LinuxHost{ProcRoot: procRoot, BootIDPath: bootPath}
	spec, err := host.Resolve(request)
	if err != nil {
		t.Fatal(err)
	}
	runner := &fakeSystemdRunner{spec: spec, procRoot: procRoot, pid: 4242, controlGroup: "/user.slice/user-1000.slice/app.slice/" + spec.UnitName}
	host.Runner = runner
	return &hostFixture{base: base, request: request, spec: spec, host: host, runner: runner, procRoot: procRoot, bootPath: bootPath, artifact: artifact, journal: journal, unitDir: unitDir, transactionDir: transactionDirectory}
}

func shortTempDir(t *testing.T) string {
	t.Helper()
	base, err := os.MkdirTemp("/tmp", "hh-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(base) })
	return base
}

func TestArmInspectAndRemovePersistentHelper(t *testing.T) {
	fixture := newHostFixture(t)
	result, err := fixture.host.Arm(context.Background(), fixture.request)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(result.Spec, fixture.spec) {
		t.Fatalf("Arm spec = %#v, want %#v", result.Spec, fixture.spec)
	}
	if result.Proof.MainPID != fixture.runner.pid || result.Proof.BootID != testBootID || !result.Proof.Enabled || !result.Proof.Active {
		t.Fatalf("unexpected helper proof: %#v", result.Proof)
	}
	assertMode(t, result.Spec.UnitPath, 0o600)
	assertMode(t, result.Spec.ExecutablePath, 0o700)
	if got := shaFileForTest(t, result.Spec.UnitPath); got != result.Spec.UnitSHA256 {
		t.Fatalf("unit SHA = %s, want %s", got, result.Spec.UnitSHA256)
	}
	if got := shaFileForTest(t, result.Spec.ExecutablePath); got != result.Spec.ExecutableSHA256 {
		t.Fatalf("executable SHA = %s, want %s", got, result.Spec.ExecutableSHA256)
	}

	proof, err := fixture.host.Inspect(context.Background(), result.Spec)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(proof, result.Proof) {
		t.Fatalf("second proof = %#v, want %#v", proof, result.Proof)
	}
	removed, err := fixture.host.Remove(context.Background(), RemovalRequest{Spec: result.Spec, ExpectedProof: result.Proof})
	if err != nil {
		t.Fatal(err)
	}
	if !removed.UnitRemoved || !removed.ExecutableRemoved {
		t.Fatalf("removal result = %#v", removed)
	}
	for _, path := range []string{result.Spec.UnitPath, result.Spec.ExecutablePath} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("removed path %s still exists: %v", path, err)
		}
	}
	if fixture.runner.active || fixture.runner.enabled {
		t.Fatal("fake systemd helper remained active or enabled")
	}
}

func TestDisableForExitNeverStopsOrUnlinksRunningHelper(t *testing.T) {
	fixture := newHostFixture(t)
	result, err := fixture.host.Arm(context.Background(), fixture.request)
	if err != nil {
		t.Fatal(err)
	}
	if err := fixture.host.DisableForExit(context.Background(), result.Spec, result.Proof); err != nil {
		t.Fatal(err)
	}
	if err := fixture.host.DisableForExit(context.Background(), result.Spec, result.Proof); err != nil {
		t.Fatalf("idempotent DisableForExit replay: %v", err)
	}
	if fixture.runner.enabled || !fixture.runner.active {
		t.Fatalf("terminal helper state enabled=%v active=%v", fixture.runner.enabled, fixture.runner.active)
	}
	for _, path := range []string{result.Spec.UnitPath, result.Spec.ExecutablePath} {
		if _, err := os.Lstat(path); err != nil {
			t.Fatalf("DisableForExit removed %s: %v", path, err)
		}
	}
	disableCalls := 0
	for _, call := range fixture.runner.calls {
		if len(call) >= 3 && call[0] == "systemctl" && call[1] == "--user" && call[2] == "stop" {
			t.Fatalf("DisableForExit tried to stop itself: %v", call)
		}
		if len(call) >= 3 && call[0] == "systemctl" && call[1] == "--user" && call[2] == "disable" {
			disableCalls++
		}
	}
	if disableCalls != 1 {
		t.Fatalf("DisableForExit replay issued %d disable calls", disableCalls)
	}
}

func TestRemoveInactiveRefusesLiveHelperThenCleansAfterNormalExit(t *testing.T) {
	fixture := newHostFixture(t)
	result, err := fixture.host.Arm(context.Background(), fixture.request)
	if err != nil {
		t.Fatal(err)
	}
	request := RemovalRequest{Spec: result.Spec, ExpectedProof: result.Proof}
	callCount := len(fixture.runner.calls)
	if _, err := fixture.host.RemoveInactive(context.Background(), request); err == nil {
		t.Fatal("RemoveInactive accepted a live helper")
	}
	for _, call := range fixture.runner.calls[callCount:] {
		if len(call) >= 3 && call[2] == "stop" {
			t.Fatalf("RemoveInactive stopped the live helper: %v", call)
		}
	}
	if err := fixture.host.DisableForExit(context.Background(), result.Spec, result.Proof); err != nil {
		t.Fatal(err)
	}
	fixture.runner.mu.Lock()
	fixture.runner.active = false
	fixture.runner.mu.Unlock()
	removed, err := fixture.host.RemoveInactive(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if !removed.UnitRemoved || !removed.ExecutableRemoved {
		t.Fatalf("inactive cleanup result = %#v", removed)
	}
}

func TestArmIsIdempotentForExactFiles(t *testing.T) {
	fixture := newHostFixture(t)
	first, err := fixture.host.Arm(context.Background(), fixture.request)
	if err != nil {
		t.Fatal(err)
	}
	firstUnit := fileIdentityForTest(t, first.Spec.UnitPath)
	firstExecutable := fileIdentityForTest(t, first.Spec.ExecutablePath)
	second, err := fixture.host.Arm(context.Background(), fixture.request)
	if err != nil {
		t.Fatal(err)
	}
	if firstUnit != fileIdentityForTest(t, second.Spec.UnitPath) || firstExecutable != fileIdentityForTest(t, second.Spec.ExecutablePath) {
		t.Fatal("idempotent Arm replaced an already exact immutable file")
	}
}

func TestArmRejectsUnsafePersistentInputsBeforeSystemd(t *testing.T) {
	tests := map[string]func(*testing.T, *hostFixture){
		"artifact symlink": func(t *testing.T, fixture *hostFixture) {
			target := fixture.artifact + ".target"
			if err := os.Rename(fixture.artifact, target); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, fixture.artifact); err != nil {
				t.Fatal(err)
			}
		},
		"artifact hardlink": func(t *testing.T, fixture *hostFixture) {
			if err := os.Link(fixture.artifact, fixture.artifact+".link"); err != nil {
				t.Fatal(err)
			}
		},
		"artifact broad mode": func(t *testing.T, fixture *hostFixture) {
			if err := os.Chmod(fixture.artifact, 0o755); err != nil {
				t.Fatal(err)
			}
		},
		"journal symlink": func(t *testing.T, fixture *hostFixture) {
			target := fixture.journal + ".target"
			if err := os.Rename(fixture.journal, target); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, fixture.journal); err != nil {
				t.Fatal(err)
			}
		},
		"transaction broad mode": func(t *testing.T, fixture *hostFixture) {
			if err := os.Chmod(fixture.transactionDir, 0o755); err != nil {
				t.Fatal(err)
			}
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			fixture := newHostFixture(t)
			mutate(t, fixture)
			if _, err := fixture.host.Arm(context.Background(), fixture.request); err == nil {
				t.Fatal("Arm accepted an unsafe persistent input")
			}
			if len(fixture.runner.calls) != 0 {
				t.Fatalf("unsafe input reached systemd: %v", fixture.runner.calls)
			}
		})
	}
}

func TestInspectRejectsRuntimeAndPathReplacement(t *testing.T) {
	tests := map[string]func(*testing.T, *hostFixture, ArmResult){
		"unit replaced by symlink": func(t *testing.T, fixture *hostFixture, result ArmResult) {
			if err := os.Remove(result.Spec.UnitPath); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(fixture.journal, result.Spec.UnitPath); err != nil {
				t.Fatal(err)
			}
		},
		"executable gained hardlink": func(t *testing.T, _ *hostFixture, result ArmResult) {
			if err := os.Link(result.Spec.ExecutablePath, result.Spec.ExecutablePath+".link"); err != nil {
				t.Fatal(err)
			}
		},
		"argv changed": func(t *testing.T, fixture *hostFixture, result ArmResult) {
			fixture.runner.argvOverride = append(append([]string(nil), result.Spec.Argv...), "unexpected")
			if err := fixture.runner.writeProcess(); err != nil {
				t.Fatal(err)
			}
		},
		"cgroup changed": func(t *testing.T, fixture *hostFixture, _ ArmResult) {
			fixture.runner.cgroupOverride = "/user.slice/other.service"
			if err := fixture.runner.writeProcess(); err != nil {
				t.Fatal(err)
			}
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			fixture := newHostFixture(t)
			result, err := fixture.host.Arm(context.Background(), fixture.request)
			if err != nil {
				t.Fatal(err)
			}
			mutate(t, fixture, result)
			if _, err := fixture.host.Inspect(context.Background(), result.Spec); err == nil {
				t.Fatal("Inspect accepted replaced helper identity")
			}
		})
	}
}

func TestRemoveRefusesMismatchedPersistedProofBeforeStop(t *testing.T) {
	fixture := newHostFixture(t)
	result, err := fixture.host.Arm(context.Background(), fixture.request)
	if err != nil {
		t.Fatal(err)
	}
	proof := result.Proof
	proof.UnitSHA256 = strings.Repeat("f", 64)
	callCount := len(fixture.runner.calls)
	if _, err := fixture.host.Remove(context.Background(), RemovalRequest{Spec: result.Spec, ExpectedProof: proof}); err == nil {
		t.Fatal("Remove accepted a mismatched persisted proof")
	}
	for _, call := range fixture.runner.calls[callCount:] {
		if len(call) >= 3 && call[2] == "stop" {
			t.Fatalf("mismatched proof stopped the helper: %v", call)
		}
	}
}

func TestRemoveReplaysOnlyTheUnitUnlinkedCrashCheckpoint(t *testing.T) {
	fixture := newHostFixture(t)
	result, err := fixture.host.Arm(context.Background(), fixture.request)
	if err != nil {
		t.Fatal(err)
	}
	fixture.runner.mu.Lock()
	fixture.runner.active = false
	fixture.runner.enabled = false
	fixture.runner.mu.Unlock()
	if err := os.Remove(result.Spec.UnitPath); err != nil {
		t.Fatal(err)
	}
	removed, err := fixture.host.Remove(context.Background(), RemovalRequest{Spec: result.Spec, ExpectedProof: result.Proof})
	if err != nil {
		t.Fatal(err)
	}
	if !removed.UnitRemoved || !removed.ExecutableRemoved {
		t.Fatalf("partial removal replay = %#v", removed)
	}
	if _, err := os.Lstat(result.Spec.ExecutablePath); !os.IsNotExist(err) {
		t.Fatalf("partial removal replay left executable: %v", err)
	}
}

func randomTestTransactionID(t *testing.T) string {
	t.Helper()
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		t.Fatal(err)
	}
	return "handoff_" + hex.EncodeToString(value)
}

func shaFileForTest(t *testing.T, path string) string {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	value, err := hashOpenFile(file)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func assertMode(t *testing.T, path string, mode os.FileMode) {
	t.Helper()
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != mode {
		t.Fatalf("%s mode = %o, want %o", path, info.Mode().Perm(), mode)
	}
}

func fileIdentityForTest(t *testing.T, path string) fileIdentity {
	t.Helper()
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	identity, err := identityFromInfo(info)
	if err != nil {
		t.Fatal(err)
	}
	return identity
}
