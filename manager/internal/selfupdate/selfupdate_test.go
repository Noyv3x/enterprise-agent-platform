package selfupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/journal"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

type fakeRunner struct {
	calls       [][]string
	fail        string
	failure     error
	activeUnits map[string]bool
	onRun       func(string, []string)
}

type runnerFunc func(context.Context, string, ...string) error

func TestStartupIdentityTracksRunningInodeAfterPathReplacement(t *testing.T) {
	if os.Getenv("UBITECH_SELFUPDATE_INODE_HELPER") == "1" {
		executable, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		runningSHA, err := fileSHA256("/proc/self/exe")
		if err != nil {
			t.Fatal(err)
		}
		restoredCurrent := []byte("restored-current-manager-after-candidate-start\n")
		currentSHA := sha256Hex(restoredCurrent)
		if runningSHA == currentSHA {
			t.Fatal("helper process and restored Current unexpectedly share a checksum")
		}
		if err := atomicfile.WriteFile(executable, restoredCurrent, 0o755); err != nil {
			t.Fatal(err)
		}
		root := t.TempDir()
		statePath := filepath.Join(root, "manager-binaries.json")
		state := State{SchemaVersion: 1, Current: &Version{SHA256: currentSHA}, UpdatedAt: time.Now().UTC()}
		if err := atomicfile.WriteJSON(statePath, state, 0o600); err != nil {
			t.Fatal(err)
		}
		manager := &Manager{StatePath: statePath}
		if err := manager.AcknowledgeStartup(); err == nil || !strings.Contains(err.Error(), "not the registered Current") {
			t.Fatalf("startup acknowledgement followed replaced path instead of running inode: %v", err)
		}
		if err := manager.AwaitStartupCommit(context.Background()); err == nil || !strings.Contains(err.Error(), "without promoting") {
			t.Fatalf("startup commit wait followed replaced path instead of running inode: %v", err)
		}
		return
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(executable)
	if err != nil {
		t.Fatal(err)
	}
	copyPath := filepath.Join(t.TempDir(), "ubitech-manager-inode-helper")
	if err := atomicfile.WriteFile(copyPath, data, 0o755); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(copyPath, "-test.run=^TestStartupIdentityTracksRunningInodeAfterPathReplacement$")
	command.Env = append(os.Environ(), "UBITECH_SELFUPDATE_INODE_HELPER=1")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("running-inode helper failed: %v\n%s", err, output)
	}
}

func (run runnerFunc) Run(ctx context.Context, name string, arguments ...string) error {
	return run(ctx, name, arguments...)
}

func (r *fakeRunner) Run(_ context.Context, name string, args ...string) error {
	r.calls = append(r.calls, append([]string{name}, args...))
	if name == r.fail {
		if r.failure != nil {
			return r.failure
		}
		return errors.New("injected failure")
	}
	if name == "systemd-run" {
		for index, argument := range args {
			if argument == "--unit" && index+1 < len(args) {
				if r.activeUnits == nil {
					r.activeUnits = map[string]bool{}
				}
				r.activeUnits[args[index+1]] = true
				break
			}
		}
	}
	if r.onRun != nil {
		r.onRun(name, append([]string(nil), args...))
	}
	return nil
}

func candidateManifest(t *testing.T, binary []byte) (release.Manifest, *httptest.Server) {
	t.Helper()
	sum := sha256.Sum256(binary)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(binary) }))
	manifest := release.Manifest{SourceCommit: strings.Repeat("a", 40), Manager: release.ManagerRelease{Version: "next", Artifacts: map[string]release.Artifact{runtime.GOARCH: {URL: server.URL, SHA256: hex.EncodeToString(sum[:])}}}}
	return manifest, server
}

func newPreparedManager(t *testing.T) (*Manager, release.Manifest, []byte, *fakeRunner) {
	t.Helper()
	oldBinary := []byte("#!/bin/sh\necho current\n")
	newBinary := []byte("#!/bin/sh\necho next\n")
	manifest, server := candidateManifest(t, newBinary)
	t.Cleanup(server.Close)
	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	install := filepath.Join(root, "bin", "ubitech-manager")
	if err := atomicfile.WriteFile(install, oldBinary, 0o755); err != nil {
		t.Fatal(err)
	}
	runner := &fakeRunner{activeUnits: map[string]bool{}}
	tokenFile := filepath.Join(root, "state", "secrets", "manager-token")
	if err := atomicfile.WriteFile(tokenFile, []byte("0123456789abcdef0123456789abcdef\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	manager := &Manager{Root: filepath.Join(root, "state", "binaries"), StatePath: filepath.Join(root, "state", "manager-binaries.json"), InstallPath: install, SocketPath: filepath.Join(root, "manager.sock"), ControlTokenFile: tokenFile, UnitName: "ubitech-agent-manager.service", RunningVersion: "current", Client: release.Client{HTTP: server.Client()}, Runner: runner, Now: func() time.Time { return time.Unix(10, 0) }, BootID: func() string { return "boot-a" }}
	manager.RecoveryUnitActive = func(_ context.Context, unit string) (bool, error) {
		return runner.activeUnits[unit], nil
	}
	manager.OrdinaryWatchdogVerifier = func(_ context.Context, unit, executablePath, expectedSHA, planPath string) error {
		if !runner.activeUnits[unit] || executablePath == "" || expectedSHA == "" || planPath == "" {
			return errors.New("test watchdog identity is incomplete")
		}
		return nil
	}
	if err := manager.Prepare(context.Background(), manifest); err != nil {
		t.Fatal(err)
	}
	return manager, manifest, oldBinary, runner
}

func ordinaryTestPlan(manager *Manager, manifest release.Manifest, state State, createdAt time.Time) Plan {
	return Plan{
		SchemaVersion: 1, PlanPath: filepath.Join(manager.Root, "activations", safeID(manifest.SourceCommit)+".json"),
		Status: "prepared", StatePath: manager.StatePath, InstallPath: manager.InstallPath,
		SocketPath: manager.SocketPath, ControlTokenFile: manager.ControlTokenFile, UnitName: manager.UnitName,
		CandidateVersion: state.Candidate.Version, CandidateSHA: state.Candidate.SHA256,
		CandidatePath: state.Candidate.Path, PlatformCommit: manifest.SourceCommit, PreviousPath: state.Current.Path,
		CreatedAt: createdAt, UpdatedAt: createdAt, HealthTimeoutMS: 45_000, BootID: "boot-a",
	}
}

func TestProbeTransientUnitUsesWaitedCollectibleOneshot(t *testing.T) {
	runner := &fakeRunner{}
	manager := &Manager{Runner: runner}
	if err := manager.ProbeTransientUnit(context.Background()); err != nil {
		t.Fatal(err)
	}
	want := []string{"systemd-run", "--user", "--quiet", "--wait", "--collect", "--property=Type=oneshot", "/usr/bin/true"}
	if len(runner.calls) != 1 || strings.Join(runner.calls[0], "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("unexpected transient probe: %#v", runner.calls)
	}
}

func TestProbeTransientUnitFailsClosed(t *testing.T) {
	runner := &fakeRunner{fail: "systemd-run"}
	manager := &Manager{Runner: runner}
	if err := manager.ProbeTransientUnit(context.Background()); err == nil || !strings.Contains(err.Error(), "probe user-systemd transient unit") {
		t.Fatalf("expected a fail-closed transient probe, got %v", err)
	}
}

func TestPrepareVerifiesButDoesNotActivateCandidate(t *testing.T) {
	manager, _, oldBinary, _ := newPreparedManager(t)
	state, err := manager.State()
	if err != nil {
		t.Fatal(err)
	}
	if state.Current == nil || state.Current.Version != "current" || state.Candidate == nil || state.Candidate.Version != "next" || state.Candidate.PlatformCommitted || state.Activation != nil {
		t.Fatalf("unsafe state transition: %#v", state)
	}
	installed, _ := os.ReadFile(manager.InstallPath)
	if string(installed) != string(oldBinary) {
		t.Fatal("Prepare changed the stable executable")
	}
	for _, version := range []*Version{state.Current, state.Candidate} {
		var metadata Version
		if err := atomicfile.ReadJSON(filepath.Join(filepath.Dir(version.Path), "metadata.json"), &metadata); err != nil {
			t.Fatalf("verified Manager version lacks cleanup provenance: %v", err)
		}
		if metadata != *version {
			t.Fatalf("Manager version metadata = %#v, want %#v", metadata, *version)
		}
	}
}

func TestDiscardPreparedClearsOnlyExactUncommittedCandidate(t *testing.T) {
	manager, manifest, _, _ := newPreparedManager(t)
	state, err := manager.State()
	if err != nil || state.Candidate == nil {
		t.Fatalf("load prepared candidate: %#v %v", state, err)
	}
	candidatePath := state.Candidate.Path
	if err := manager.DiscardPrepared(manifest); err != nil {
		t.Fatal(err)
	}
	state, err = manager.State()
	if err != nil || state.Candidate != nil || state.Activation != nil || state.Current == nil {
		t.Fatalf("discard changed more than the prepared Candidate: %#v %v", state, err)
	}
	if _, err := os.Stat(candidatePath); err != nil {
		t.Fatalf("discard removed the retained candidate artifact: %v", err)
	}
	if err := manager.DiscardPrepared(manifest); err != nil {
		t.Fatalf("idempotent prepared discard failed: %v", err)
	}
}

func TestDiscardPreparedRejectsCommittedActivatedOrMismatchedCandidate(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*State)
	}{
		{name: "platform-committed", mutate: func(state *State) { state.Candidate.PlatformCommitted = true }},
		{name: "activation", mutate: func(state *State) {
			state.Activation = &Activation{PlanPath: filepath.Join("/tmp", "plan"), CandidateSHA: state.Candidate.SHA256, CandidatePath: state.Candidate.Path, StartedAt: time.Unix(11, 0)}
		}},
		{name: "source", mutate: func(state *State) { state.Candidate.SourceCommit = strings.Repeat("b", 40) }},
		{name: "checksum", mutate: func(state *State) { state.Candidate.SHA256 = strings.Repeat("0", 64) }},
		{name: "path", mutate: func(state *State) { state.Candidate.Path = filepath.Join(filepath.Dir(state.Candidate.Path), "other") }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			manager, manifest, _, _ := newPreparedManager(t)
			state, err := manager.State()
			if err != nil {
				t.Fatal(err)
			}
			test.mutate(&state)
			if err := atomicfile.WriteJSON(manager.StatePath, state, 0o600); err != nil {
				t.Fatal(err)
			}
			if err := manager.DiscardPrepared(manifest); err == nil {
				t.Fatal("DiscardPrepared accepted a non-exact Candidate")
			}
			after, err := manager.State()
			if err != nil || after.Candidate == nil {
				t.Fatalf("rejected discard removed Candidate: %#v %v", after, err)
			}
		})
	}
}

func TestActivateCreatesOwnerOnlyActivationDirectoryOnFreshRoot(t *testing.T) {
	manager, manifest, _, _ := newPreparedManager(t)
	activationsRoot := filepath.Join(manager.Root, "activations")
	if _, err := os.Lstat(activationsRoot); !os.IsNotExist(err) {
		t.Fatalf("fresh Manager unexpectedly has activation directory: %v", err)
	}
	if err := manager.MarkPlatformCommitted(manifest); err != nil {
		t.Fatal(err)
	}
	if err := manager.Activate(context.Background(), manifest); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(activationsRoot)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o700 {
		t.Fatalf("activation directory is not an owner-only real directory: mode=%v err=%v", info, err)
	}
}

func TestActivationRollbackQueryLeavesFreshRootUntouchedBeforeFirstActivate(t *testing.T) {
	manager, manifest, _, _ := newPreparedManager(t)
	activationsRoot := filepath.Join(manager.Root, "activations")
	if _, err := os.Lstat(activationsRoot); !os.IsNotExist(err) {
		t.Fatalf("fresh Manager unexpectedly has activation directory: %v", err)
	}
	if err := manager.MarkPlatformCommitted(manifest); err != nil {
		t.Fatal(err)
	}
	rolledBack, err := manager.ActivationRolledBack(manifest)
	if err != nil || rolledBack {
		t.Fatalf("fresh activation was classified as rolled back: rolledBack=%v err=%v", rolledBack, err)
	}
	if _, err := os.Lstat(activationsRoot); !os.IsNotExist(err) {
		t.Fatalf("rollback query created activation artifacts before Activate: %v", err)
	}
	if err := manager.Activate(context.Background(), manifest); err != nil {
		t.Fatal(err)
	}
	state, err := manager.State()
	if err != nil || state.Activation == nil {
		t.Fatalf("first activation did not establish its durable intent: %#v %v", state, err)
	}
}

func TestActivateRejectsUntrustedActivationDirectory(t *testing.T) {
	for _, mode := range []string{"world-accessible", "symlink"} {
		t.Run(mode, func(t *testing.T) {
			manager, manifest, _, _ := newPreparedManager(t)
			activationsRoot := filepath.Join(manager.Root, "activations")
			switch mode {
			case "world-accessible":
				if err := os.Mkdir(activationsRoot, 0o755); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				target := t.TempDir()
				if err := os.Symlink(target, activationsRoot); err != nil {
					t.Fatal(err)
				}
			}
			if err := manager.MarkPlatformCommitted(manifest); err != nil {
				t.Fatal(err)
			}
			if err := manager.Activate(context.Background(), manifest); err == nil || !strings.Contains(err.Error(), "activation directory") {
				t.Fatalf("Activate accepted %s activation directory: %v", mode, err)
			}
		})
	}
}

func TestPruneVersionsRemovesOnlyExpiredVerifiedUnreferencedDirectories(t *testing.T) {
	manager, _, _, _ := newPreparedManager(t)
	state, err := manager.State()
	if err != nil {
		t.Fatal(err)
	}
	oldBinary := []byte("obsolete manager binary")
	oldDigest := sha256Hex(oldBinary)
	oldCommit := strings.Repeat("b", 40)
	oldVersion := Version{
		Version: "obsolete", SourceCommit: oldCommit,
		Path:       filepath.Join(manager.Root, "versions", safeID("obsolete-"+oldCommit[:12]), "ubitech-manager"),
		SHA256:     oldDigest,
		VerifiedAt: time.Unix(10, 0).UTC(),
	}
	if err := atomicfile.WriteFile(oldVersion.Path, oldBinary, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := manager.ensureVersionMetadata(oldVersion); err != nil {
		t.Fatal(err)
	}

	removed, err := manager.PruneVersions(context.Background(), time.Unix(10_000, 0).UTC(), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("removed Manager versions = %d, want 1", removed)
	}
	if _, err := os.Lstat(filepath.Dir(oldVersion.Path)); !os.IsNotExist(err) {
		t.Fatalf("expired Manager version remains: %v", err)
	}
	for _, version := range []*Version{state.Current, state.Candidate} {
		if _, err := os.Lstat(version.Path); err != nil {
			t.Fatalf("referenced Manager version was removed: %v", err)
		}
	}
}

func TestPruneVersionsRetainsDirectoryContainingUnknownEvidence(t *testing.T) {
	manager, _, _, _ := newPreparedManager(t)
	binary := []byte("obsolete manager binary")
	digest := sha256Hex(binary)
	commit := strings.Repeat("c", 40)
	version := Version{
		Version: "obsolete", SourceCommit: commit,
		Path:       filepath.Join(manager.Root, "versions", safeID("obsolete-"+commit[:12]), "ubitech-manager"),
		SHA256:     digest,
		VerifiedAt: time.Unix(10, 0).UTC(),
	}
	if err := atomicfile.WriteFile(version.Path, binary, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := manager.ensureVersionMetadata(version); err != nil {
		t.Fatal(err)
	}
	note := filepath.Join(filepath.Dir(version.Path), "operator-note.txt")
	if err := os.WriteFile(note, []byte("retain"), 0o600); err != nil {
		t.Fatal(err)
	}

	removed, err := manager.PruneVersions(context.Background(), time.Unix(10_000, 0).UTC(), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 0 {
		t.Fatalf("Manager version with unknown evidence was removed: %d", removed)
	}
	if content, err := os.ReadFile(note); err != nil || string(content) != "retain" {
		t.Fatalf("unknown Manager version evidence changed: %q %v", content, err)
	}
}

func TestPrepareCannotRaceExternalCurrentRecovery(t *testing.T) {
	manager, manifest, _, _ := newPreparedManager(t)
	releaseLock, err := acquireRecoveryLock(manager.Root)
	if err != nil {
		t.Fatal(err)
	}
	defer releaseLock()
	err = manager.Prepare(context.Background(), manifest)
	if err == nil || !strings.Contains(err.Error(), "external recovery") {
		t.Fatalf("Prepare while external recovery lock is held = %v", err)
	}
}

func TestActivateCannotRaceExternalCurrentRecovery(t *testing.T) {
	manager, manifest, oldBinary, runner := newPreparedManager(t)
	if err := manager.MarkPlatformCommitted(manifest); err != nil {
		t.Fatal(err)
	}
	releaseLock, err := acquireRecoveryLock(manager.Root)
	if err != nil {
		t.Fatal(err)
	}
	defer releaseLock()
	err = manager.Activate(context.Background(), manifest)
	if err == nil || !strings.Contains(err.Error(), "external Manager recovery is already running") {
		t.Fatalf("Activate while external recovery lock is held = %v", err)
	}
	stable, readErr := os.ReadFile(manager.InstallPath)
	if readErr != nil || string(stable) != string(oldBinary) {
		t.Fatalf("blocked activation changed stable Manager: %q %v", stable, readErr)
	}
	if countFakeRunnerCommands(runner, "systemd-run") != 0 || countFakeRunnerCommands(runner, "systemctl") != 0 {
		t.Fatalf("blocked activation launched a service action: %#v", runner.calls)
	}
}

func TestActivateResumesPreparedPlanWithoutClobberingOrDuplicatingWatchdog(t *testing.T) {
	manager, manifest, _, runner := newPreparedManager(t)
	if err := manager.MarkPlatformCommitted(manifest); err != nil {
		t.Fatal(err)
	}
	state, err := manager.State()
	if err != nil {
		t.Fatal(err)
	}
	createdAt := time.Unix(5, 0).UTC()
	plan := ordinaryTestPlan(manager, manifest, state, createdAt)
	if err := persistActivationPlan(plan.PlanPath, plan); err != nil {
		t.Fatal(err)
	}
	watchdogUnit := recoveryWatchdogUnitPrefix + manifest.SourceCommit[:12]
	runner.activeUnits[watchdogUnit] = true
	spawnsBefore := countFakeRunnerCommands(runner, "systemd-run")

	if err := manager.Activate(context.Background(), manifest); err != nil {
		t.Fatal(err)
	}

	if countFakeRunnerCommands(runner, "systemd-run") != spawnsBefore {
		t.Fatalf("prepared activation replay launched a duplicate watchdog: %#v", runner.calls)
	}
	if countFakeRunnerCommands(runner, "systemctl") != 0 {
		t.Fatalf("Manager process tried to synchronously restart its own unit: %#v", runner.calls)
	}
	var resumed Plan
	if err := atomicfile.ReadJSON(plan.PlanPath, &resumed); err != nil {
		t.Fatal(err)
	}
	if resumed.CreatedAt != createdAt || !resumed.Activated || resumed.Acknowledged || resumed.Status != "activated" {
		t.Fatalf("prepared activation plan was clobbered instead of resumed: %#v", resumed)
	}
	state, err = manager.State()
	if err != nil {
		t.Fatal(err)
	}
	if state.Activation == nil || state.Activation.PlanPath != plan.PlanPath || state.Candidate == nil {
		t.Fatalf("prepared activation intent was not reconstructed: %#v", state)
	}
	if !binaryMatches(manager.InstallPath, state.Candidate.SHA256) {
		t.Fatal("prepared activation replay did not install the verified Candidate")
	}
}

func TestActivateDoesNotOverwriteMismatchedExistingPlan(t *testing.T) {
	manager, manifest, oldBinary, runner := newPreparedManager(t)
	if err := manager.MarkPlatformCommitted(manifest); err != nil {
		t.Fatal(err)
	}
	state, err := manager.State()
	if err != nil {
		t.Fatal(err)
	}
	plan := ordinaryTestPlan(manager, manifest, state, time.Unix(5, 0).UTC())
	plan.CandidatePath = filepath.Join(t.TempDir(), "wrong-candidate")
	if err := persistActivationPlan(plan.PlanPath, plan); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(plan.PlanPath)
	if err != nil {
		t.Fatal(err)
	}

	err = manager.Activate(context.Background(), manifest)
	if err == nil || !strings.Contains(err.Error(), "existing Manager activation plan is not reusable") {
		t.Fatalf("mismatched existing activation plan was accepted: %v", err)
	}
	after, err := os.ReadFile(plan.PlanPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(before) {
		t.Fatal("mismatched existing activation plan was overwritten")
	}
	stable, err := os.ReadFile(manager.InstallPath)
	if err != nil || string(stable) != string(oldBinary) {
		t.Fatalf("mismatched plan changed stable Manager: %q %v", stable, err)
	}
	if countFakeRunnerCommands(runner, "systemd-run") != 0 || countFakeRunnerCommands(runner, "systemctl") != 0 {
		t.Fatalf("mismatched plan launched a service action: %#v", runner.calls)
	}
}

func TestWatchdogCommitsAcknowledgedHealthyCandidate(t *testing.T) {
	manager, manifest, _, runner := newPreparedManager(t)
	if err := manager.MarkPlatformCommitted(manifest); err != nil {
		t.Fatal(err)
	}
	if err := manager.Activate(context.Background(), manifest); err != nil {
		t.Fatal(err)
	}
	state, _ := manager.State()
	if state.Activation == nil || state.Current.Version != "current" {
		t.Fatalf("candidate was committed before watchdog health: %#v", state)
	}
	if committed, err := manager.ActivationCommitted(manifest); err != nil || committed {
		t.Fatalf("activation intent bypassed watchdog barrier: committed=%v err=%v", committed, err)
	}
	var plan Plan
	if err := atomicfile.ReadJSON(state.Activation.PlanPath, &plan); err != nil {
		t.Fatal(err)
	}
	plan.Acknowledged = true
	plan.Status = "acknowledged"
	plan.HealthTimeoutMS = 5_000
	if err := atomicfile.WriteJSON(plan.PlanPath, plan, 0o600); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", manager.SocketPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(manager.SocketPath, 0o600); err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer 0123456789abcdef0123456789abcdef" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if request.URL.Path != "/v1/identity" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{
			"status": "healthy", "version": plan.CandidateVersion, "sha256": plan.CandidateSHA,
		})
	})}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	if _, err := readRecoveryControlToken(manager.ControlTokenFile); err != nil {
		t.Fatalf("identity fixture token: %v", err)
	}
	if err := validateRecoverySocket(manager.SocketPath); err != nil {
		t.Fatalf("identity fixture socket: %v", err)
	}
	if !managerHealthy(context.Background(), manager.SocketPath, manager.ControlTokenFile, plan.CandidateVersion, plan.CandidateSHA) {
		t.Fatal("candidate identity fixture is not healthy")
	}
	if err := RunWatchdog(context.Background(), plan.PlanPath, runner); err != nil {
		t.Fatal(err)
	}
	state, _ = manager.State()
	if state.Current == nil || state.Current.Version != "next" || state.Previous == nil || state.Previous.Version != "current" || state.Candidate != nil || state.Activation != nil {
		t.Fatalf("watchdog did not commit candidate: %#v", state)
	}
	if committed, err := manager.ActivationCommitted(manifest); err != nil || !committed {
		t.Fatalf("watchdog commit was not visible to cleanup barrier: committed=%v err=%v", committed, err)
	}
}

func TestActivationCommittedTerminalizesStateFirstCommitAfterRestart(t *testing.T) {
	manager, manifest, _, _ := newPreparedManager(t)
	if err := manager.MarkPlatformCommitted(manifest); err != nil {
		t.Fatal(err)
	}
	if err := manager.Activate(context.Background(), manifest); err != nil {
		t.Fatal(err)
	}
	state, err := manager.State()
	if err != nil || state.Current == nil || state.Candidate == nil || state.Activation == nil {
		t.Fatalf("activation intent is missing: %#v %v", state, err)
	}
	previous := *state.Current
	planPath := state.Activation.PlanPath
	var plan Plan
	if err := atomicfile.ReadJSON(planPath, &plan); err != nil {
		t.Fatal(err)
	}
	plan.Status = "acknowledged"
	plan.Activated = true
	plan.Acknowledged = true
	plan.UpdatedAt = time.Now().UTC()
	if err := persistActivationPlan(planPath, plan); err != nil {
		t.Fatal(err)
	}
	// Exact crash boundary: Candidate was promoted atomically, but the old
	// watchdog exited before writing the terminal plan.
	state.Previous = state.Current
	state.Current = state.Candidate
	state.Candidate = nil
	state.Activation = nil
	state.UpdatedAt = time.Now().UTC()
	if err := atomicfile.WriteJSON(manager.StatePath, state, 0o600); err != nil {
		t.Fatal(err)
	}

	restarted := *manager
	committed, err := restarted.ActivationCommitted(manifest)
	if err != nil || !committed {
		t.Fatalf("restart finalize barrier did not reconcile state-first commit: committed=%v err=%v", committed, err)
	}
	var terminal Plan
	if err := atomicfile.ReadJSON(planPath, &terminal); err != nil || terminal.Status != "committed" || !terminal.Activated || !terminal.Acknowledged {
		t.Fatalf("restart finalize barrier did not terminalize plan: %#v %v", terminal, err)
	}
	after, err := restarted.State()
	if err != nil || after.Current == nil || after.Current.SourceCommit != manifest.SourceCommit ||
		after.Previous == nil || *after.Previous != previous || after.Candidate != nil || after.Activation != nil {
		t.Fatalf("restart finalize barrier moved committed state twice: %#v %v", after, err)
	}
	if committed, err := restarted.ActivationCommitted(manifest); err != nil || !committed {
		t.Fatalf("terminal activation barrier was not idempotent: committed=%v err=%v", committed, err)
	}
}

func TestActivationCommittedRejectsConflictingPlanAtStateFirstCheckpoint(t *testing.T) {
	manager, manifest, _, _ := newPreparedManager(t)
	if err := manager.MarkPlatformCommitted(manifest); err != nil {
		t.Fatal(err)
	}
	if err := manager.Activate(context.Background(), manifest); err != nil {
		t.Fatal(err)
	}
	state, err := manager.State()
	if err != nil || state.Candidate == nil || state.Activation == nil {
		t.Fatalf("activation intent is missing: %#v %v", state, err)
	}
	planPath := state.Activation.PlanPath
	var plan Plan
	if err := atomicfile.ReadJSON(planPath, &plan); err != nil {
		t.Fatal(err)
	}
	plan.Status = "acknowledged"
	plan.Activated = true
	plan.Acknowledged = true
	plan.CandidatePath = filepath.Join(t.TempDir(), "conflicting-candidate")
	plan.UpdatedAt = time.Now().UTC()
	if err := persistActivationPlan(planPath, plan); err != nil {
		t.Fatal(err)
	}
	state.Previous = state.Current
	state.Current = state.Candidate
	state.Candidate = nil
	state.Activation = nil
	if err := atomicfile.WriteJSON(manager.StatePath, state, 0o600); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(planPath)
	if err != nil {
		t.Fatal(err)
	}
	if committed, err := manager.ActivationCommitted(manifest); err == nil || committed {
		t.Fatalf("conflicting acknowledged plan passed finalize barrier: committed=%v err=%v", committed, err)
	}
	after, err := os.ReadFile(planPath)
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatalf("rejected finalize barrier rewrote conflicting plan: %v", err)
	}
}

func TestOrdinaryWatchdogRecreatesCommittedPlanAfterStatePromotion(t *testing.T) {
	for _, mode := range []string{"deleted", "corrupt"} {
		t.Run(mode, func(t *testing.T) {
			manager, manifest, _, runner := newPreparedManager(t)
			if err := manager.MarkPlatformCommitted(manifest); err != nil {
				t.Fatal(err)
			}
			if err := manager.Activate(context.Background(), manifest); err != nil {
				t.Fatal(err)
			}
			state, err := manager.State()
			if err != nil || state.Activation == nil || state.Candidate == nil {
				t.Fatalf("activation intent is missing: %#v %v", state, err)
			}
			var plan Plan
			if err := atomicfile.ReadJSON(state.Activation.PlanPath, &plan); err != nil {
				t.Fatal(err)
			}
			plan.Status = "acknowledged"
			plan.Activated = true
			plan.Acknowledged = true
			plan.HealthTimeoutMS = 5_000
			plan.UpdatedAt = time.Now().UTC()
			if err := persistActivationPlan(plan.PlanPath, plan); err != nil {
				t.Fatal(err)
			}
			listener, err := net.Listen("unix", manager.SocketPath)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(manager.SocketPath, 0o600); err != nil {
				t.Fatal(err)
			}
			var once sync.Once
			var checkpointErr error
			server := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				once.Do(func() {
					promoted, loadErr := manager.State()
					if loadErr != nil || promoted.Current == nil || promoted.Candidate == nil {
						checkpointErr = errors.New("load activation state for injected commit")
						return
					}
					promoted.Previous = promoted.Current
					promoted.Current = promoted.Candidate
					promoted.Candidate = nil
					promoted.Activation = nil
					promoted.UpdatedAt = time.Now().UTC()
					if writeErr := atomicfile.WriteJSON(manager.StatePath, promoted, 0o600); writeErr != nil {
						checkpointErr = writeErr
						return
					}
					switch mode {
					case "deleted":
						checkpointErr = os.Remove(plan.PlanPath)
					case "corrupt":
						checkpointErr = atomicfile.WriteFile(plan.PlanPath, []byte("{corrupt"), 0o600)
					}
				})
				if request.Header.Get("Authorization") != "Bearer 0123456789abcdef0123456789abcdef" || request.URL.Path != "/v1/identity" {
					response.WriteHeader(http.StatusUnauthorized)
					return
				}
				_ = json.NewEncoder(response).Encode(map[string]string{
					"status": "healthy", "version": plan.CandidateVersion, "sha256": plan.CandidateSHA,
				})
			})}
			go func() { _ = server.Serve(listener) }()
			t.Cleanup(func() { _ = server.Close() })
			if err := RunWatchdog(context.Background(), plan.PlanPath, runner); err != nil {
				t.Fatalf("watchdog did not reconstruct committed plan: %v", err)
			}
			if checkpointErr != nil {
				t.Fatalf("inject commit checkpoint: %v", checkpointErr)
			}
			committed, err := manager.State()
			if err != nil || committed.Current == nil || committed.Current.SHA256 != plan.CandidateSHA ||
				committed.Candidate != nil || committed.Activation != nil {
				t.Fatalf("commit checkpoint changed during reconstruction: %#v %v", committed, err)
			}
			var terminal Plan
			if err := atomicfile.ReadJSON(plan.PlanPath, &terminal); err != nil || terminal.Status != "committed" ||
				!terminal.Activated || !terminal.Acknowledged {
				t.Fatalf("committed plan was not reconstructed: %#v %v", terminal, err)
			}
		})
	}
}

func TestOrdinaryWatchdogSubmitsExternalRestartOnceAndLateReplayIsNoOp(t *testing.T) {
	manager, manifest, _, runner := newPreparedManager(t)
	if err := manager.MarkPlatformCommitted(manifest); err != nil {
		t.Fatal(err)
	}
	if err := manager.Activate(context.Background(), manifest); err != nil {
		t.Fatal(err)
	}
	if countFakeRunnerCommands(runner, "systemctl") != 0 {
		t.Fatalf("activation initiator synchronously restarted its own unit: %#v", runner.calls)
	}
	state, err := manager.State()
	if err != nil || state.Activation == nil {
		t.Fatalf("activation intent is missing: %#v %v", state, err)
	}
	var plan Plan
	if err := atomicfile.ReadJSON(state.Activation.PlanPath, &plan); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", manager.SocketPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(manager.SocketPath, 0o600); err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer 0123456789abcdef0123456789abcdef" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "healthy", "version": plan.CandidateVersion, "sha256": plan.CandidateSHA})
	})}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	var callbackErr error
	runner.onRun = func(name string, _ []string) {
		if name != "systemctl" || callbackErr != nil {
			return
		}
		var acknowledged Plan
		if callbackErr = atomicfile.ReadJSON(plan.PlanPath, &acknowledged); callbackErr != nil {
			return
		}
		acknowledged.Acknowledged = true
		acknowledged.Status = "acknowledged"
		acknowledged.UpdatedAt = time.Now().UTC()
		callbackErr = persistActivationPlan(plan.PlanPath, acknowledged)
	}
	if err := RunWatchdog(context.Background(), plan.PlanPath, runner); err != nil {
		t.Fatal(err)
	}
	if callbackErr != nil {
		t.Fatal(callbackErr)
	}
	if countFakeRunnerCommands(runner, "systemctl") != 1 {
		t.Fatalf("watchdog submitted Manager restart more than once: %#v", runner.calls)
	}
	state, err = manager.State()
	if err != nil || state.Current == nil || state.Current.SourceCommit != manifest.SourceCommit || state.Candidate != nil || state.Activation != nil {
		t.Fatalf("watchdog did not commit Candidate: %#v %v", state, err)
	}
	callsBeforeReplay := len(runner.calls)
	if err := RunWatchdog(context.Background(), plan.PlanPath, runner); err != nil {
		t.Fatalf("late committed watchdog replay failed: %v", err)
	}
	if len(runner.calls) != callsBeforeReplay {
		t.Fatalf("late committed watchdog replay changed the service: %#v", runner.calls[callsBeforeReplay:])
	}
}

func TestStaleOrdinaryWatchdogCannotRollbackCommittedCandidate(t *testing.T) {
	manager, manifest, _, runner := newPreparedManager(t)
	if err := manager.MarkPlatformCommitted(manifest); err != nil {
		t.Fatal(err)
	}
	if err := manager.Activate(context.Background(), manifest); err != nil {
		t.Fatal(err)
	}
	state, err := manager.State()
	if err != nil || state.Activation == nil {
		t.Fatalf("activation intent is missing: %#v %v", state, err)
	}
	var stale Plan
	if err := atomicfile.ReadJSON(state.Activation.PlanPath, &stale); err != nil {
		t.Fatal(err)
	}
	committed := stale
	committed.Acknowledged = true
	committed.Status = "acknowledged"
	committed.UpdatedAt = time.Now().UTC()
	if err := persistActivationPlan(committed.PlanPath, committed); err != nil {
		t.Fatal(err)
	}
	if err := commitActivation(committed.PlanPath, committed); err != nil {
		t.Fatal(err)
	}
	callsBefore := len(runner.calls)
	stale.Error = "stale watchdog timeout"
	if err := restorePrevious(stale, runner); err != nil {
		t.Fatalf("stale watchdog did not observe committed terminal state: %v", err)
	}
	if len(runner.calls) != callsBefore {
		t.Fatalf("stale watchdog restarted the committed Manager: %#v", runner.calls[callsBefore:])
	}
	state, err = manager.State()
	if err != nil || state.Current == nil || state.Current.SourceCommit != manifest.SourceCommit || state.Previous == nil || state.Candidate != nil || state.Activation != nil {
		t.Fatalf("stale watchdog changed committed self-update state: %#v %v", state, err)
	}
	if !binaryMatches(manager.InstallPath, state.Current.SHA256) {
		t.Fatal("stale watchdog replaced the committed stable Manager")
	}
}

func TestOrdinaryCommitRejectsRollbackCrashAfterStableWasRestored(t *testing.T) {
	manager, manifest, oldBinary, _ := newPreparedManager(t)
	if err := manager.MarkPlatformCommitted(manifest); err != nil {
		t.Fatal(err)
	}
	if err := manager.Activate(context.Background(), manifest); err != nil {
		t.Fatal(err)
	}
	state, err := manager.State()
	if err != nil || state.Current == nil || state.Candidate == nil || state.Activation == nil {
		t.Fatalf("activation intent is missing: %#v %v", state, err)
	}
	currentBefore := *state.Current
	planPath := state.Activation.PlanPath
	var plan Plan
	if err := atomicfile.ReadJSON(planPath, &plan); err != nil {
		t.Fatal(err)
	}
	plan.Acknowledged = true
	plan.Status = "acknowledged"
	plan.UpdatedAt = time.Now().UTC()
	if err := persistActivationPlan(planPath, plan); err != nil {
		t.Fatal(err)
	}
	// Exact rollback crash boundary: stable is already Current again, while the
	// acknowledged plan and Candidate/Activation state have not yet reached
	// their terminal rollback writes.
	if err := atomicfile.WriteFile(manager.InstallPath, oldBinary, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := commitActivation(planPath, plan); err == nil || !strings.Contains(err.Error(), "stable Manager does not match Candidate") {
		t.Fatalf("ordinary commit accepted a rollback crash checkpoint: %v", err)
	}
	state, err = manager.State()
	if err != nil || state.Current == nil || *state.Current != currentBefore || state.Candidate == nil || state.Activation == nil {
		t.Fatalf("rejected commit promoted or cleared Candidate: %#v %v", state, err)
	}
	if !binaryMatches(manager.InstallPath, currentBefore.SHA256) {
		t.Fatal("rejected commit changed the restored stable Current")
	}
	var durable Plan
	if err := atomicfile.ReadJSON(planPath, &durable); err != nil || durable.Status != "acknowledged" || !durable.Activated || !durable.Acknowledged {
		t.Fatalf("rejected commit changed acknowledged plan evidence: %#v %v", durable, err)
	}
}

func TestFreshOrdinaryWatchdogCompletesPlanAfterStateCommitCrash(t *testing.T) {
	manager, manifest, _, runner := newPreparedManager(t)
	if err := manager.MarkPlatformCommitted(manifest); err != nil {
		t.Fatal(err)
	}
	if err := manager.Activate(context.Background(), manifest); err != nil {
		t.Fatal(err)
	}
	state, err := manager.State()
	if err != nil || state.Current == nil || state.Candidate == nil || state.Activation == nil {
		t.Fatalf("activation intent is missing: %#v %v", state, err)
	}
	currentBefore := *state.Current
	planPath := state.Activation.PlanPath
	var plan Plan
	if err := atomicfile.ReadJSON(planPath, &plan); err != nil {
		t.Fatal(err)
	}
	plan.Acknowledged = true
	plan.Status = "acknowledged"
	plan.UpdatedAt = time.Now().UTC()
	if err := persistActivationPlan(planPath, plan); err != nil {
		t.Fatal(err)
	}
	state.Previous = state.Current
	state.Current = state.Candidate
	state.Candidate = nil
	state.Activation = nil
	state.UpdatedAt = time.Now().UTC()
	if err := atomicfile.WriteJSON(manager.StatePath, state, 0o600); err != nil {
		t.Fatal(err)
	}

	if err := RunWatchdog(context.Background(), planPath, runner); err != nil {
		t.Fatalf("fresh watchdog did not reconcile state-first commit: %v", err)
	}
	committed, err := manager.State()
	if err != nil || committed.Current == nil || committed.Current.SHA256 != plan.CandidateSHA ||
		committed.Previous == nil || *committed.Previous != currentBefore ||
		committed.Candidate != nil || committed.Activation != nil {
		t.Fatalf("fresh watchdog changed committed state: %#v %v", committed, err)
	}
	var terminal Plan
	if err := atomicfile.ReadJSON(planPath, &terminal); err != nil || terminal.Status != "committed" {
		t.Fatalf("fresh watchdog did not terminalize plan: %#v %v", terminal, err)
	}
	stale := plan
	stale.Error = "stale watchdog rollback after state commit"
	if err := restorePrevious(stale, runner); err != nil {
		t.Fatalf("stale rollback did not observe committed terminal plan: %v", err)
	}
	after, err := manager.State()
	if err != nil || !reflect.DeepEqual(committed, after) {
		t.Fatalf("stale rollback changed reconciled commit: before=%#v after=%#v err=%v", committed, after, err)
	}
}

func TestOrdinaryWatchdogRetriesExternalRestartSubmission(t *testing.T) {
	manager, manifest, _, _ := newPreparedManager(t)
	if err := manager.MarkPlatformCommitted(manifest); err != nil {
		t.Fatal(err)
	}
	if err := manager.Activate(context.Background(), manifest); err != nil {
		t.Fatal(err)
	}
	state, err := manager.State()
	if err != nil || state.Activation == nil {
		t.Fatalf("activation intent is missing: %#v %v", state, err)
	}
	var plan Plan
	if err := atomicfile.ReadJSON(state.Activation.PlanPath, &plan); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", manager.SocketPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(manager.SocketPath, 0o600); err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "healthy", "version": plan.CandidateVersion, "sha256": plan.CandidateSHA})
	})}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	restartAttempts := 0
	runner := runnerFunc(func(_ context.Context, name string, _ ...string) error {
		if name != "systemctl" {
			return fmt.Errorf("unexpected watchdog command %s", name)
		}
		restartAttempts++
		if restartAttempts == 1 {
			return errors.New("signal: terminated")
		}
		var acknowledged Plan
		if err := atomicfile.ReadJSON(plan.PlanPath, &acknowledged); err != nil {
			return err
		}
		acknowledged.Acknowledged = true
		acknowledged.Status = "acknowledged"
		acknowledged.UpdatedAt = time.Now().UTC()
		return persistActivationPlan(plan.PlanPath, acknowledged)
	})
	if err := RunWatchdog(context.Background(), plan.PlanPath, runner); err != nil {
		t.Fatal(err)
	}
	if restartAttempts != 2 {
		t.Fatalf("external restart attempts = %d, want one retry after signal termination", restartAttempts)
	}
}

func TestOrdinaryWatchdogRestoresCurrentWhenOwnedPlanDisappears(t *testing.T) {
	manager, manifest, oldBinary, runner := newPreparedManager(t)
	if err := manager.MarkPlatformCommitted(manifest); err != nil {
		t.Fatal(err)
	}
	if err := manager.Activate(context.Background(), manifest); err != nil {
		t.Fatal(err)
	}
	state, err := manager.State()
	if err != nil || state.Activation == nil {
		t.Fatalf("activation intent is missing: %#v %v", state, err)
	}
	planPath := state.Activation.PlanPath
	corrupted := false
	runner.onRun = func(name string, _ []string) {
		if name != "systemctl" || corrupted {
			return
		}
		corrupted = true
		runner.onRun = nil
		_ = os.WriteFile(planPath, []byte("{corrupt"), 0o600)
	}
	err = RunWatchdog(context.Background(), planPath, runner)
	if err == nil || !strings.Contains(err.Error(), "read Manager activation plan while watching candidate") {
		t.Fatalf("lost activation plan did not produce a bounded rollback error: %v", err)
	}
	stable, readErr := os.ReadFile(manager.InstallPath)
	if readErr != nil || string(stable) != string(oldBinary) {
		t.Fatalf("lost activation plan did not restore Current: %q %v", stable, readErr)
	}
	state, readErr = manager.State()
	if readErr != nil || state.Candidate != nil || state.Activation != nil || state.Current == nil || state.Current.SourceCommit == manifest.SourceCommit {
		t.Fatalf("lost activation plan left unsafe Candidate ownership: %#v %v", state, readErr)
	}
	var terminal Plan
	if readErr := atomicfile.ReadJSON(planPath, &terminal); readErr != nil || terminal.Status != ordinaryRolledBackStatus {
		t.Fatalf("lost activation plan did not recreate terminal evidence: %#v %v", terminal, readErr)
	}
}

func TestRecoveryWatchdogRejectsUnownedPlanWithoutOrdinaryManagerRestart(t *testing.T) {
	root := t.TempDir()
	planPath := filepath.Join(root, "recovery-plan.json")
	plan := Plan{
		SchemaVersion: 1, Mode: recoveryActivationMode, PlanPath: planPath, Status: "activated",
		Activated: true, UnitName: "ubitech-agent-manager.service", HealthTimeoutMS: 5_000,
	}
	if err := persistActivationPlan(planPath, plan); err != nil {
		t.Fatal(err)
	}
	runner := &fakeRunner{}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := RunWatchdog(ctx, planPath, runner); err == nil || !strings.Contains(err.Error(), "activation plan has no current recovery ownership") {
		t.Fatalf("unowned recovery watchdog result = %v, want fail-closed ownership error", err)
	}
	if countFakeRunnerCommands(runner, "systemctl") != 0 {
		t.Fatalf("recovery watchdog bypassed takeover-owned main start sequencing: %#v", runner.calls)
	}
}

func TestWatchdogRestoresPreviousBinaryWhenCandidateDoesNotStart(t *testing.T) {
	manager, manifest, oldBinary, runner := newPreparedManager(t)
	if err := manager.MarkPlatformCommitted(manifest); err != nil {
		t.Fatal(err)
	}
	if err := manager.Activate(context.Background(), manifest); err != nil {
		t.Fatal(err)
	}
	state, _ := manager.State()
	var plan Plan
	if err := atomicfile.ReadJSON(state.Activation.PlanPath, &plan); err != nil {
		t.Fatal(err)
	}
	plan.HealthTimeoutMS = 1_000
	if err := atomicfile.WriteJSON(plan.PlanPath, plan, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := RunWatchdog(context.Background(), plan.PlanPath, runner); err == nil {
		t.Fatal("expected watchdog rollback result")
	}
	installed, err := os.ReadFile(manager.InstallPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(installed) != string(oldBinary) {
		t.Fatal("watchdog did not atomically restore the previous executable")
	}
	state, _ = manager.State()
	if state.Current == nil || state.Current.Version != "current" || state.Activation != nil || state.Candidate != nil {
		t.Fatalf("rollback corrupted self-update state: %#v", state)
	}
	var terminal Plan
	if err := atomicfile.ReadJSON(plan.PlanPath, &terminal); err != nil {
		t.Fatal(err)
	}
	if terminal.Status != ordinaryRolledBackStatus || terminal.PlatformCommit != manifest.SourceCommit || terminal.CandidatePath == "" {
		t.Fatalf("watchdog rollback evidence is incomplete: %#v", terminal)
	}
	if rolledBack, err := manager.ActivationRolledBack(manifest); err != nil || !rolledBack {
		t.Fatalf("watchdog rollback was not visible to Platform recovery: rolledBack=%v err=%v", rolledBack, err)
	}
	if err := manager.Prepare(context.Background(), manifest); err == nil || !strings.Contains(err.Error(), "cannot be retried") {
		t.Fatalf("rejected Manager candidate was prepared again: %v", err)
	}
	if len(runner.calls) < 3 || runner.calls[len(runner.calls)-1][0] != "systemctl" {
		t.Fatalf("rollback did not restart the restored service: %#v", runner.calls)
	}
}

func TestPreviousManagerSettlesCrashAfterTerminalRollbackPlanBeforeStateClear(t *testing.T) {
	manager, manifest, oldBinary, _ := newPreparedManager(t)
	if err := manager.MarkPlatformCommitted(manifest); err != nil {
		t.Fatal(err)
	}
	if err := manager.Activate(context.Background(), manifest); err != nil {
		t.Fatal(err)
	}
	state, err := manager.State()
	if err != nil {
		t.Fatal(err)
	}
	var plan Plan
	if err := atomicfile.ReadJSON(state.Activation.PlanPath, &plan); err != nil {
		t.Fatal(err)
	}
	if err := atomicfile.WriteFile(manager.InstallPath, oldBinary, 0o755); err != nil {
		t.Fatal(err)
	}
	plan.Status = ordinaryRolledBackStatus
	plan.Error = "injected watchdog rejection"
	if err := persistActivationPlan(plan.PlanPath, plan); err != nil {
		t.Fatal(err)
	}
	if err := manager.acknowledgeExecutable(state.Current.Path); err != nil {
		t.Fatal(err)
	}
	state, err = manager.State()
	if err != nil {
		t.Fatal(err)
	}
	if state.Candidate != nil || state.Activation != nil || state.Current == nil || state.Current.Version != "current" {
		t.Fatalf("old Manager did not settle terminal watchdog state: %#v", state)
	}
	if rolledBack, err := manager.ActivationRolledBack(manifest); err != nil || !rolledBack {
		t.Fatalf("settled rollback was not reported: rolledBack=%v err=%v", rolledBack, err)
	}
}

func TestActivationRolledBackReconcilesStateAfterRollbackPlanHalfCommit(t *testing.T) {
	for _, running := range []string{"previous-manager", "candidate-manager"} {
		t.Run(running, func(t *testing.T) {
			manager, manifest, oldBinary, runner := newPreparedManager(t)
			if err := manager.MarkPlatformCommitted(manifest); err != nil {
				t.Fatal(err)
			}
			if err := manager.Activate(context.Background(), manifest); err != nil {
				t.Fatal(err)
			}
			state, err := manager.State()
			if err != nil || state.Current == nil || state.Candidate == nil || state.Activation == nil {
				t.Fatalf("activation intent is missing: %#v %v", state, err)
			}
			var plan Plan
			if err := atomicfile.ReadJSON(state.Activation.PlanPath, &plan); err != nil {
				t.Fatal(err)
			}
			if err := atomicfile.WriteFile(manager.InstallPath, oldBinary, 0o755); err != nil {
				t.Fatal(err)
			}
			plan.Status = ordinaryRolledBackStatus
			plan.Error = "injected rollback state half-commit"
			plan.UpdatedAt = time.Now().UTC()
			if err := persistActivationPlan(plan.PlanPath, plan); err != nil {
				t.Fatal(err)
			}
			if running == "candidate-manager" {
				if err := manager.acknowledgeExecutable(state.Candidate.Path); err == nil || !strings.Contains(err.Error(), "rolled-back Manager activation") {
					t.Fatalf("candidate process unexpectedly settled rollback state: %v", err)
				}
				stillPending, err := manager.State()
				if err != nil || stillPending.Candidate == nil || stillPending.Activation == nil {
					t.Fatalf("candidate acknowledgement changed half-commit before periodic reconciliation: %#v %v", stillPending, err)
				}
			}
			callsBefore := len(runner.calls)
			rolledBack, err := manager.ActivationRolledBack(manifest)
			if err != nil || !rolledBack {
				t.Fatalf("periodic rollback barrier did not reconcile %s: rolledBack=%v err=%v", running, rolledBack, err)
			}
			settled, err := manager.State()
			if err != nil || settled.Current == nil || settled.Current.SourceCommit == manifest.SourceCommit ||
				settled.Candidate != nil || settled.Activation != nil || !binaryMatches(manager.InstallPath, settled.Current.SHA256) {
				t.Fatalf("periodic rollback reconciliation left unsafe state: %#v %v", settled, err)
			}
			if len(runner.calls) != callsBefore {
				t.Fatalf("periodic state-only reconciliation submitted systemd work: %#v", runner.calls[callsBefore:])
			}
		})
	}
}

func TestActivationRolledBackCompletesCrashAfterStableRestoreBeforePlanWrite(t *testing.T) {
	for _, status := range []string{"activated", "acknowledged"} {
		t.Run(status, func(t *testing.T) {
			manager, manifest, oldBinary, runner := newPreparedManager(t)
			if err := manager.MarkPlatformCommitted(manifest); err != nil {
				t.Fatal(err)
			}
			if err := manager.Activate(context.Background(), manifest); err != nil {
				t.Fatal(err)
			}
			state, err := manager.State()
			if err != nil || state.Activation == nil || state.Candidate == nil {
				t.Fatalf("activation intent is missing: %#v %v", state, err)
			}
			var plan Plan
			if err := atomicfile.ReadJSON(state.Activation.PlanPath, &plan); err != nil {
				t.Fatal(err)
			}
			if status == "acknowledged" {
				plan.Status = "acknowledged"
				plan.Activated = true
				plan.Acknowledged = true
				plan.UpdatedAt = time.Now().UTC()
				if err := persistActivationPlan(plan.PlanPath, plan); err != nil {
					t.Fatal(err)
				}
			}
			if err := atomicfile.WriteFile(manager.InstallPath, oldBinary, 0o755); err != nil {
				t.Fatal(err)
			}
			callsBefore := len(runner.calls)
			rolledBack, err := manager.ActivationRolledBack(manifest)
			if err != nil || !rolledBack {
				t.Fatalf("stable-restored crash was not reconciled: rolledBack=%v err=%v", rolledBack, err)
			}
			settled, err := manager.State()
			if err != nil || settled.Current == nil || settled.Candidate != nil || settled.Activation != nil ||
				!binaryMatches(manager.InstallPath, settled.Current.SHA256) {
				t.Fatalf("stable-restored rollback did not settle state: %#v %v", settled, err)
			}
			var terminal Plan
			if err := atomicfile.ReadJSON(plan.PlanPath, &terminal); err != nil || terminal.Status != ordinaryRolledBackStatus || terminal.Error == "" {
				t.Fatalf("stable-restored rollback did not persist terminal plan: %#v %v", terminal, err)
			}
			if len(runner.calls) != callsBefore {
				t.Fatalf("state-only reconciliation submitted systemd work: %#v", runner.calls[callsBefore:])
			}
		})
	}
}

func TestActivationRolledBackDoesNotInferRollbackFromPreparedPlan(t *testing.T) {
	manager, manifest, _, _ := newPreparedManager(t)
	if err := manager.MarkPlatformCommitted(manifest); err != nil {
		t.Fatal(err)
	}
	state, err := manager.State()
	if err != nil || state.Current == nil || state.Candidate == nil {
		t.Fatalf("prepared state is missing: %#v %v", state, err)
	}
	plan := ordinaryTestPlan(manager, manifest, state, time.Now().UTC())
	if err := persistActivationPlan(plan.PlanPath, plan); err != nil {
		t.Fatal(err)
	}
	state.Activation = &Activation{
		PlanPath: plan.PlanPath, CandidateSHA: plan.CandidateSHA,
		CandidatePath: plan.CandidatePath, StartedAt: plan.CreatedAt.Add(time.Second),
	}
	state.UpdatedAt = state.Activation.StartedAt
	if err := atomicfile.WriteJSON(manager.StatePath, state, 0o600); err != nil {
		t.Fatal(err)
	}
	rolledBack, err := manager.ActivationRolledBack(manifest)
	if err != nil || rolledBack {
		t.Fatalf("prepared plan was misclassified as rolled back: rolledBack=%v err=%v", rolledBack, err)
	}
	unchanged, err := manager.State()
	if err != nil || unchanged.Candidate == nil || unchanged.Activation == nil {
		t.Fatalf("prepared activation references were cleared: %#v %v", unchanged, err)
	}
}

func TestPreviousManagerRestartBeforeStableReplacementProducesFinalizeRollbackBarrier(t *testing.T) {
	manager, manifest, oldBinary, _ := newPreparedManager(t)
	if err := manager.MarkPlatformCommitted(manifest); err != nil {
		t.Fatal(err)
	}
	state, err := manager.State()
	if err != nil {
		t.Fatal(err)
	}
	plan := ordinaryTestPlan(manager, manifest, state, time.Unix(5, 0).UTC())
	if err := persistActivationPlan(plan.PlanPath, plan); err != nil {
		t.Fatal(err)
	}
	state.Activation = &Activation{
		PlanPath: plan.PlanPath, CandidateSHA: state.Candidate.SHA256,
		CandidatePath: state.Candidate.Path, StartedAt: time.Unix(10, 0).UTC(),
	}
	state.UpdatedAt = time.Unix(10, 0).UTC()
	if err := atomicfile.WriteJSON(manager.StatePath, state, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := manager.acknowledgeExecutable(state.Current.Path); err != nil {
		t.Fatal(err)
	}

	state, err = manager.State()
	if err != nil {
		t.Fatal(err)
	}
	if state.Current == nil || state.Current.SourceCommit == manifest.SourceCommit || state.Candidate != nil || state.Activation != nil {
		t.Fatalf("pre-replacement restart did not clear rejected activation ownership: %#v", state)
	}
	stable, err := os.ReadFile(manager.InstallPath)
	if err != nil || string(stable) != string(oldBinary) {
		t.Fatalf("pre-replacement restart changed Current: %q %v", stable, err)
	}
	var terminal Plan
	if err := atomicfile.ReadJSON(plan.PlanPath, &terminal); err != nil {
		t.Fatal(err)
	}
	if terminal.Status != ordinaryRolledBackStatus || terminal.Activated || terminal.Error != "activation stopped before stable binary replacement" {
		t.Fatalf("pre-replacement restart did not write standard rollback evidence: %#v", terminal)
	}
	if rolledBack, err := manager.ActivationRolledBack(manifest); err != nil || !rolledBack {
		t.Fatalf("Platform finalize cannot observe pre-replacement rejection: rolledBack=%v err=%v", rolledBack, err)
	}
	if err := manager.Prepare(context.Background(), manifest); err == nil || !strings.Contains(err.Error(), "cannot be retried") {
		t.Fatalf("rejected pre-replacement Candidate became reactivatable: %v", err)
	}
}

func TestActivateCannotOverwriteWatchdogRollbackWhileSystemdProofIsInFlight(t *testing.T) {
	manager, manifest, oldBinary, runner := newPreparedManager(t)
	if err := manager.MarkPlatformCommitted(manifest); err != nil {
		t.Fatal(err)
	}
	proofEntered := make(chan struct{})
	releaseProof := make(chan struct{})
	manager.OrdinaryWatchdogVerifier = func(context.Context, string, string, string, string) error {
		close(proofEntered)
		<-releaseProof
		return nil
	}
	activateResult := make(chan error, 1)
	go func() { activateResult <- manager.Activate(context.Background(), manifest) }()
	select {
	case <-proofEntered:
	case <-time.After(2 * time.Second):
		t.Fatal("Activate did not reach out-of-lock watchdog proof")
	}
	state, err := manager.State()
	if err != nil || state.Activation == nil {
		t.Fatalf("Activate did not persist intent before watchdog proof: %#v err=%v", state, err)
	}
	var plan Plan
	if err := atomicfile.ReadJSON(state.Activation.PlanPath, &plan); err != nil {
		t.Fatal(err)
	}
	restartObservedUnlocked := false
	runner.onRun = func(name string, arguments []string) {
		if name == "systemctl" && len(arguments) >= 3 && arguments[1] == "restart" {
			restartObservedUnlocked = ordinaryTestPlanLockAvailable(t, plan.PlanPath)
		}
	}
	plan.Error = "watchdog deadline won before stable replacement"
	if err := restorePrevious(plan, runner); err == nil || !strings.Contains(err.Error(), "watchdog deadline") {
		t.Fatalf("watchdog rollback result = %v", err)
	}
	close(releaseProof)
	if err := <-activateResult; err == nil || !strings.Contains(err.Error(), "lost activation ownership") {
		t.Fatalf("stale Activate result = %v", err)
	}
	if !restartObservedUnlocked || countFakeRunnerCommands(runner, "systemctl") != 1 {
		t.Fatalf("watchdog restart was not submitted exactly once after unlock: %#v", runner.calls)
	}
	installed, err := os.ReadFile(manager.InstallPath)
	if err != nil || string(installed) != string(oldBinary) {
		t.Fatalf("stale Activate replaced rolled-back stable Manager: %q err=%v", installed, err)
	}
	if err := atomicfile.ReadJSON(plan.PlanPath, &plan); err != nil || plan.Status != ordinaryRolledBackStatus {
		t.Fatalf("stale Activate overwrote terminal plan: %#v err=%v", plan, err)
	}
	state, err = manager.State()
	if err != nil || state.Candidate != nil || state.Activation != nil {
		t.Fatalf("stale Activate restored rejected ownership: %#v err=%v", state, err)
	}
}

func TestCandidateAcknowledgementCannotOverwriteConcurrentWatchdogRollback(t *testing.T) {
	manager, manifest, _, runner := newPreparedManager(t)
	if err := manager.MarkPlatformCommitted(manifest); err != nil {
		t.Fatal(err)
	}
	if err := manager.Activate(context.Background(), manifest); err != nil {
		t.Fatal(err)
	}
	state, err := manager.State()
	if err != nil || state.Activation == nil {
		t.Fatalf("activation intent is missing: %#v err=%v", state, err)
	}
	var plan Plan
	if err := atomicfile.ReadJSON(state.Activation.PlanPath, &plan); err != nil {
		t.Fatal(err)
	}
	proofEntered := make(chan struct{})
	releaseProof := make(chan struct{})
	manager.OrdinaryWatchdogVerifier = func(context.Context, string, string, string, string) error {
		close(proofEntered)
		<-releaseProof
		return nil
	}
	ackResult := make(chan error, 1)
	go func() { ackResult <- manager.acknowledgeExecutable(manager.InstallPath) }()
	select {
	case <-proofEntered:
	case <-time.After(2 * time.Second):
		t.Fatal("candidate acknowledgement did not reach out-of-lock watchdog proof")
	}
	restartObservedUnlocked := false
	runner.onRun = func(name string, arguments []string) {
		if name == "systemctl" && len(arguments) >= 3 && arguments[1] == "restart" {
			restartObservedUnlocked = ordinaryTestPlanLockAvailable(t, plan.PlanPath)
		}
	}
	plan.Error = "watchdog rollback won acknowledgement race"
	if err := restorePrevious(plan, runner); err == nil || !strings.Contains(err.Error(), "acknowledgement race") {
		t.Fatalf("watchdog rollback result = %v", err)
	}
	close(releaseProof)
	if err := <-ackResult; err == nil || !strings.Contains(err.Error(), "settled before candidate acknowledgement") {
		t.Fatalf("stale candidate acknowledgement result = %v", err)
	}
	if !restartObservedUnlocked || countFakeRunnerCommands(runner, "systemctl") != 1 {
		t.Fatalf("rollback restart was not submitted exactly once after unlock: %#v", runner.calls)
	}
	if err := atomicfile.ReadJSON(plan.PlanPath, &plan); err != nil || plan.Status != ordinaryRolledBackStatus || plan.Acknowledged {
		t.Fatalf("stale candidate overwrote rollback plan: %#v err=%v", plan, err)
	}
	state, err = manager.State()
	if err != nil || state.Candidate != nil || state.Activation != nil {
		t.Fatalf("stale candidate restored rejected state: %#v err=%v", state, err)
	}
}

func TestStartupCompletesIntentAfterCrashBetweenBinaryReplaceAndPlanUpdate(t *testing.T) {
	manager, manifest, _, runner := newPreparedManager(t)
	if err := manager.MarkPlatformCommitted(manifest); err != nil {
		t.Fatal(err)
	}
	if err := manager.Activate(context.Background(), manifest); err != nil {
		t.Fatal(err)
	}
	state, _ := manager.State()
	var plan Plan
	if err := atomicfile.ReadJSON(state.Activation.PlanPath, &plan); err != nil {
		t.Fatal(err)
	}
	// Exact power-loss window: the stable path contains the candidate, while the
	// last durable plan still says replacement has not happened. A reboot also
	// removes the original transient watchdog unit.
	plan.Activated = false
	plan.Acknowledged = false
	plan.Status = "prepared"
	plan.BootID = "boot-before-power-loss"
	if err := atomicfile.WriteJSON(plan.PlanPath, plan, 0o600); err != nil {
		t.Fatal(err)
	}
	watchdogUnit := recoveryWatchdogUnitPrefix + manifest.SourceCommit[:12]
	runner.activeUnits[watchdogUnit] = false
	spawnsBefore := countFakeRunnerCommands(runner, "systemd-run")
	if err := manager.acknowledgeExecutable(manager.InstallPath); err != nil {
		t.Fatal(err)
	}
	if err := atomicfile.ReadJSON(plan.PlanPath, &plan); err != nil {
		t.Fatal(err)
	}
	if !plan.Activated || !plan.Acknowledged || plan.Status != "acknowledged" {
		t.Fatalf("candidate did not idempotently finish crash intent: %#v", plan)
	}
	if countFakeRunnerCommands(runner, "systemd-run") != spawnsBefore+1 || !runner.activeUnits[watchdogUnit] {
		t.Fatalf("startup did not re-arm the lost transient watchdog: %#v", runner.calls)
	}
}

func TestActivationPlanBoundsExternalWatchdogFailure(t *testing.T) {
	manager, manifest, _, runner := newPreparedManager(t)
	if err := manager.MarkPlatformCommitted(manifest); err != nil {
		t.Fatal(err)
	}
	if err := manager.Activate(context.Background(), manifest); err != nil {
		t.Fatal(err)
	}
	state, err := manager.State()
	if err != nil || state.Activation == nil {
		t.Fatalf("activation plan was not prepared: %#v %v", state, err)
	}
	var plan Plan
	if err := atomicfile.ReadJSON(state.Activation.PlanPath, &plan); err != nil {
		t.Fatal(err)
	}
	plan.BootID = "boot-before-restart"
	if err := atomicfile.WriteJSON(plan.PlanPath, plan, 0o600); err != nil {
		t.Fatal(err)
	}
	runner.activeUnits[recoveryWatchdogUnitPrefix+manifest.SourceCommit[:12]] = false
	runner.fail = "systemd-run"
	externalFailure := "watchdog-external-head\n" + strings.Repeat("y", journal.MaxDiagnosticBytes*3) + "\nwatchdog-external-tail"
	runner.failure = errors.New(externalFailure)
	restartObservedUnlocked := false
	runner.onRun = func(name string, arguments []string) {
		if name == "systemctl" && len(arguments) >= 3 && arguments[1] == "restart" {
			restartObservedUnlocked = ordinaryTestPlanLockAvailable(t, plan.PlanPath)
		}
	}
	want := journal.BoundDiagnostic("could not prove Manager activation watchdog before startup acknowledgement: start manager activation watchdog: " + externalFailure)
	err = manager.acknowledgeExecutable(manager.InstallPath)
	if err == nil {
		t.Fatal("watchdog re-arm failure did not roll back activation")
	}
	if err.Error() != want {
		t.Fatalf("returned activation diagnostic does not identify the original external error: got %q want %q", err.Error(), want)
	}
	if err := atomicfile.ReadJSON(plan.PlanPath, &plan); err != nil {
		t.Fatal(err)
	}
	if plan.Error != want {
		t.Fatalf("durable activation diagnostic does not identify the original external error: got %q want %q", plan.Error, want)
	}
	if !strings.Contains(plan.Error, "watchdog-external-head") || !strings.Contains(plan.Error, "watchdog-external-tail") || !strings.Contains(plan.Error, "diagnostic truncated") || !strings.Contains(plan.Error, "sha256=") {
		t.Fatalf("durable activation diagnostic lost correlation data: %q", plan.Error)
	}
	if !restartObservedUnlocked || countFakeRunnerCommands(runner, "systemctl") != 1 {
		t.Fatalf("watchdog-proof rollback did not restart exactly once after releasing plan lock: %#v", runner.calls)
	}
}

func countFakeRunnerCommands(runner *fakeRunner, command string) int {
	count := 0
	for _, call := range runner.calls {
		if len(call) > 0 && call[0] == command {
			count++
		}
	}
	return count
}

func ordinaryTestPlanLockAvailable(t *testing.T, planPath string) bool {
	t.Helper()
	lockPath := planPath + ".lock"
	fd, err := syscall.Open(lockPath, syscall.O_RDWR|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		t.Errorf("open ordinary activation lock for assertion: %v", err)
		return false
	}
	defer syscall.Close(fd) //nolint:errcheck -- test-only descriptor cleanup
	if err := syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return false
	}
	_ = syscall.Flock(fd, syscall.LOCK_UN)
	return true
}
