package selfupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
)

type recoveryRunner struct {
	mu       sync.Mutex
	calls    [][]string
	failCall int
	onRun    func(string, []string)
}

func (r *recoveryRunner) Run(_ context.Context, name string, arguments ...string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, append([]string{name}, arguments...))
	if r.failCall > 0 && len(r.calls) == r.failCall {
		return errors.New("injected recovery command failure")
	}
	if r.onRun != nil {
		r.onRun(name, append([]string(nil), arguments...))
	}
	return nil
}

func (r *recoveryRunner) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.calls)
}

type recoveryFixture struct {
	manager        *Manager
	runner         *recoveryRunner
	executablePath string
	platformPath   string
	oldBinary      []byte
	newBinary      []byte
	newSHA         string
	oldSHA         string
	platformCommit string
	server         *http.Server
	identity       *recoveryIdentityResponse
}

type recoveryIdentityResponse struct {
	mu        sync.RWMutex
	available bool
	version   string
	sha       string
}

func testRecoveryExecutableReader(path, expected string) ([]byte, error) {
	data, _, err := readRecoveryRegularFile(path, recoveryMaxBinaryBytes, false)
	if err != nil {
		return nil, err
	}
	if sha256Hex(data) != expected {
		return nil, errors.New("test recovery executable checksum mismatch")
	}
	return data, nil
}

func (i *recoveryIdentityResponse) set(available bool, version, sha string) {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.available = available
	i.version = version
	i.sha = sha
}

func (i *recoveryIdentityResponse) value() (bool, string, string) {
	i.mu.RLock()
	defer i.mu.RUnlock()
	return i.available, i.version, i.sha
}

func newRecoveryFixture(t *testing.T) *recoveryFixture {
	t.Helper()
	root := t.TempDir()
	stateDir := filepath.Join(root, "state")
	managerRoot := filepath.Join(stateDir, "manager-binaries")
	versions := filepath.Join(managerRoot, "versions")
	binDir := filepath.Join(root, "bin")
	recoveryDir := filepath.Join(root, "recovery")
	secretsDir := filepath.Join(stateDir, "secrets")
	for _, directory := range []string{stateDir, managerRoot, versions, binDir, recoveryDir, secretsDir} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	oldBinary := []byte("old-current-manager-binary\n")
	newBinary := []byte("new-recovery-manager-binary\n")
	oldDigest := sha256.Sum256(oldBinary)
	newDigest := sha256.Sum256(newBinary)
	oldSHA := hex.EncodeToString(oldDigest[:])
	newSHA := hex.EncodeToString(newDigest[:])
	currentDir := filepath.Join(versions, "running-"+oldSHA[:12])
	if err := os.MkdirAll(currentDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(currentDir, 0o700); err != nil {
		t.Fatal(err)
	}
	oldPath := filepath.Join(currentDir, "agent-platform-manager")
	stablePath := filepath.Join(binDir, "agent-platform-manager")
	executablePath := filepath.Join(recoveryDir, "agent-platform-manager")
	for _, target := range []string{oldPath, stablePath} {
		if err := atomicfile.WriteFile(target, oldBinary, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chmod(stablePath, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := atomicfile.WriteFile(executablePath, newBinary, 0o700); err != nil {
		t.Fatal(err)
	}
	managerStatePath := filepath.Join(stateDir, "manager-binaries.json")
	oldSourceCommit := strings.Repeat("a", 40)
	managerState := State{
		SchemaVersion: 1,
		Current: &Version{
			Version:           oldSourceCommit,
			SourceCommit:      oldSourceCommit,
			Path:              oldPath,
			SHA256:            oldSHA,
			VerifiedAt:        time.Unix(1, 0).UTC(),
			PlatformCommitted: true,
		},
		UpdatedAt: time.Unix(1, 0).UTC(),
	}
	if err := atomicfile.WriteJSON(managerStatePath, managerState, 0o600); err != nil {
		t.Fatal(err)
	}
	platformCommit := strings.Repeat("b", 40)
	recoveryVersion := strings.Repeat("c", 40)
	platformPath := filepath.Join(stateDir, "state.json")
	platformState := model.NewState(time.Unix(2, 0))
	platformState.Current = &model.Generation{ID: platformCommit, SourceCommit: platformCommit}
	if err := atomicfile.WriteJSON(platformPath, platformState, 0o600); err != nil {
		t.Fatal(err)
	}
	token := "0123456789abcdef0123456789abcdef"
	tokenPath := filepath.Join(secretsDir, "manager-token")
	if err := atomicfile.WriteFile(tokenPath, []byte(token+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	controlDir, err := os.MkdirTemp("", "ubitech-recovery-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(controlDir) })
	if err := os.Chmod(controlDir, 0o700); err != nil {
		t.Fatal(err)
	}
	socketPath := filepath.Join(controlDir, "manager.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(socketPath, 0o600); err != nil {
		t.Fatal(err)
	}
	identity := &recoveryIdentityResponse{version: recoveryVersion, sha: newSHA}
	server := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer "+token {
			response.WriteHeader(http.StatusUnauthorized)
			return
		}
		if request.URL.Path == "/v1/status" {
			response.WriteHeader(http.StatusOK)
			return
		}
		if request.URL.Path != "/v1/identity" {
			response.WriteHeader(http.StatusNotFound)
			return
		}
		available, identityVersion, identitySHA := identity.value()
		if !available {
			response.WriteHeader(http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(response).Encode(map[string]string{
			"status": "healthy", "version": identityVersion, "sha256": identitySHA,
		})
	})}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	runner := &recoveryRunner{onRun: func(name string, arguments []string) {
		if name == "systemctl" && len(arguments) >= 3 && arguments[1] == "start" {
			stable, err := os.ReadFile(stablePath)
			if err == nil && sha256Hex(stable) == newSHA {
				identity.set(true, recoveryVersion, newSHA)
			} else {
				identity.set(false, "", "")
			}
		}
	}}
	manager := &Manager{Profile: testActiveProfile,
		ConfigPath:               filepath.Join(root, "config", "manager.toml"),
		Root:                     managerRoot,
		StatePath:                managerStatePath,
		InstallPath:              stablePath,
		SocketPath:               socketPath,
		ControlTokenFile:         tokenPath,
		UnitName:                 "agent-platform-manager.service",
		RunningVersion:           recoveryVersion,
		Runner:                   runner,
		Now:                      func() time.Time { return time.Unix(3, 0).UTC() },
		recoveryExecutableReader: testRecoveryExecutableReader,
		RecoveryProcessVerifier: func(_ context.Context, unit, stable, expectedSHA string) error {
			if unit != "agent-platform-manager.service" || stable != stablePath || expectedSHA != newSHA {
				return errors.New("unexpected recovered service identity")
			}
			return nil
		},
	}
	return &recoveryFixture{
		manager: manager, runner: runner, executablePath: executablePath, platformPath: platformPath,
		oldBinary: oldBinary, newBinary: newBinary, newSHA: newSHA, oldSHA: oldSHA,
		platformCommit: platformCommit, server: server, identity: identity,
	}
}

func TestRecoverCurrentCommitsOnlyAfterHealthyReplacementAndIsReentrant(t *testing.T) {
	fixture := newRecoveryFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if err := fixture.manager.RecoverCurrent(ctx, fixture.executablePath, fixture.platformPath, fixture.newSHA); err != nil {
		t.Fatal(err)
	}
	installed, err := os.ReadFile(fixture.manager.InstallPath)
	if err != nil || string(installed) != string(fixture.newBinary) {
		t.Fatalf("stable Manager was not replaced: %q %v", installed, err)
	}
	state, err := fixture.manager.State()
	if err != nil {
		t.Fatal(err)
	}
	if state.Current == nil || state.Current.SHA256 != fixture.newSHA || state.Current.SourceCommit != fixture.platformCommit || state.Current.Version != fixture.manager.RunningVersion || !state.Current.PlatformCommitted {
		t.Fatalf("recovered Manager was not registered as Current: %#v", state)
	}
	if state.Previous == nil || state.Previous.SHA256 != fixture.oldSHA || state.Candidate != nil || state.Activation != nil {
		t.Fatalf("previous/current recovery boundary is invalid: %#v", state)
	}
	if !pathWithin(filepath.Join(fixture.manager.Root, "versions"), state.Current.Path) || !binaryMatches(state.Current.Path, fixture.newSHA) {
		t.Fatalf("Current recovery executable is not immutable: %#v", state.Current)
	}
	previousPath := state.Previous.Path
	before := fixture.runner.count()
	if err := fixture.manager.RecoverCurrent(ctx, fixture.executablePath, fixture.platformPath, fixture.newSHA); err != nil {
		t.Fatal(err)
	}
	state, err = fixture.manager.State()
	if err != nil {
		t.Fatal(err)
	}
	if state.Previous == nil || state.Previous.Path != previousPath || fixture.runner.count() != before+1 {
		t.Fatalf("replayed recovery was not a stable no-op: state=%#v calls=%d", state, fixture.runner.count())
	}
}

func TestRecoverCurrentConvergesAfterInterruptedStableReplacement(t *testing.T) {
	fixture := newRecoveryFixture(t)
	if err := atomicfile.WriteFile(fixture.manager.InstallPath, fixture.newBinary, 0o755); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if err := fixture.manager.RecoverCurrent(ctx, fixture.executablePath, fixture.platformPath, fixture.newSHA); err != nil {
		t.Fatal(err)
	}
	state, err := fixture.manager.State()
	if err != nil || state.Current == nil || state.Current.SHA256 != fixture.newSHA || state.Previous == nil || state.Previous.SHA256 != fixture.oldSHA {
		t.Fatalf("interrupted replacement did not converge: %#v %v", state, err)
	}
}

func TestRecoverCurrentRestoresOldStableAndLeavesStateOnStartFailure(t *testing.T) {
	fixture := newRecoveryFixture(t)
	originalState, err := os.ReadFile(fixture.manager.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	fixture.runner.failCall = 2
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	err = fixture.manager.RecoverCurrent(ctx, fixture.executablePath, fixture.platformPath, fixture.newSHA)
	if err == nil || !strings.Contains(err.Error(), "start recovered Manager") {
		t.Fatalf("expected injected start failure, got %v", err)
	}
	installed, readErr := os.ReadFile(fixture.manager.InstallPath)
	if readErr != nil || string(installed) != string(fixture.oldBinary) {
		t.Fatalf("previous stable Manager was not restored: %q %v", installed, readErr)
	}
	currentState, readErr := os.ReadFile(fixture.manager.StatePath)
	if readErr != nil || string(currentState) != string(originalState) {
		t.Fatalf("failed recovery changed self-update state: %v", readErr)
	}
	if fixture.runner.count() < 4 {
		t.Fatalf("failed recovery did not stop/start the previous Manager: %#v", fixture.runner.calls)
	}
}

func TestRecoverCurrentRestoresOldServiceWhenInitialStopIsUncertain(t *testing.T) {
	fixture := newRecoveryFixture(t)
	fixture.runner.failCall = 1
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	err := fixture.manager.RecoverCurrent(ctx, fixture.executablePath, fixture.platformPath, fixture.newSHA)
	if err == nil || !strings.Contains(err.Error(), "stop Current Manager service") {
		t.Fatalf("expected uncertain stop failure, got %v", err)
	}
	assertRecoveryKeptOldCurrent(t, fixture)
	if fixture.runner.count() < 3 {
		t.Fatalf("uncertain stop did not force a second stop and restart: %#v", fixture.runner.calls)
	}
}

func TestRecoverCurrentRejectsWrongCandidateIdentityAndRollsBack(t *testing.T) {
	tests := map[string]func(*recoveryFixture) (string, string){
		"version": func(fixture *recoveryFixture) (string, string) {
			return strings.Repeat("d", 40), fixture.newSHA
		},
		"sha256": func(fixture *recoveryFixture) (string, string) {
			return fixture.manager.RunningVersion, strings.Repeat("e", 64)
		},
	}
	for name, wrongIdentity := range tests {
		t.Run(name, func(t *testing.T) {
			fixture := newRecoveryFixture(t)
			version, digest := wrongIdentity(fixture)
			fixture.runner.onRun = func(name string, arguments []string) {
				if name == "systemctl" && len(arguments) >= 3 && arguments[1] == "start" {
					fixture.identity.set(true, version, digest)
				}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
			defer cancel()
			err := fixture.manager.RecoverCurrent(ctx, fixture.executablePath, fixture.platformPath, fixture.newSHA)
			if err == nil || !strings.Contains(err.Error(), "control health") {
				t.Fatalf("wrong candidate identity result = %v", err)
			}
			assertRecoveryKeptOldCurrent(t, fixture)
		})
	}
}

func TestRecoverCurrentRollsBackWhenSystemdMainProcessDoesNotMatch(t *testing.T) {
	fixture := newRecoveryFixture(t)
	fixture.manager.RecoveryProcessVerifier = func(context.Context, string, string, string) error {
		return errors.New("MainPID executable is not the stable candidate")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 7*time.Second)
	defer cancel()
	err := fixture.manager.RecoverCurrent(ctx, fixture.executablePath, fixture.platformPath, fixture.newSHA)
	if err == nil || !strings.Contains(err.Error(), "service process") {
		t.Fatalf("mismatched MainPID result = %v", err)
	}
	assertRecoveryKeptOldCurrent(t, fixture)
}

func assertRecoveryKeptOldCurrent(t *testing.T, fixture *recoveryFixture) {
	t.Helper()
	installed, err := os.ReadFile(fixture.manager.InstallPath)
	if err != nil || string(installed) != string(fixture.oldBinary) {
		t.Fatalf("previous stable Manager was not preserved: %q %v", installed, err)
	}
	state, err := fixture.manager.State()
	if err != nil {
		t.Fatal(err)
	}
	if state.Current == nil || state.Current.SHA256 != fixture.oldSHA || state.Previous != nil || state.Candidate != nil || state.Activation != nil {
		t.Fatalf("failed recovery changed self-update state: %#v", state)
	}
}

func TestRecoverCurrentRejectsUnsafeOrConflictingInputsBeforeStoppingService(t *testing.T) {
	tests := map[string]func(*testing.T, *recoveryFixture) (string, string){
		"wrong checksum": func(_ *testing.T, fixture *recoveryFixture) (string, string) {
			return fixture.executablePath, strings.Repeat("d", 64)
		},
		"development binary": func(_ *testing.T, fixture *recoveryFixture) (string, string) {
			fixture.manager.RunningVersion = "development"
			return fixture.executablePath, fixture.newSHA
		},
		"active candidate": func(t *testing.T, fixture *recoveryFixture) (string, string) {
			state, err := fixture.manager.State()
			if err != nil {
				t.Fatal(err)
			}
			state.Candidate = &Version{SHA256: fixture.newSHA}
			if err := atomicfile.WriteJSON(fixture.manager.StatePath, state, 0o600); err != nil {
				t.Fatal(err)
			}
			return fixture.executablePath, fixture.newSHA
		},
		"uncommitted current": func(t *testing.T, fixture *recoveryFixture) (string, string) {
			state, err := fixture.manager.State()
			if err != nil {
				t.Fatal(err)
			}
			state.Current.PlatformCommitted = false
			if err := atomicfile.WriteJSON(fixture.manager.StatePath, state, 0o600); err != nil {
				t.Fatal(err)
			}
			return fixture.executablePath, fixture.newSHA
		},
		"mismatched platform generation": func(t *testing.T, fixture *recoveryFixture) (string, string) {
			var state model.ManagerState
			if err := atomicfile.ReadJSON(fixture.platformPath, &state); err != nil {
				t.Fatal(err)
			}
			state.Current.ID = strings.Repeat("f", 40)
			if err := atomicfile.WriteJSON(fixture.platformPath, state, 0o600); err != nil {
				t.Fatal(err)
			}
			return fixture.executablePath, fixture.newSHA
		},
		"symlink executable": func(t *testing.T, fixture *recoveryFixture) (string, string) {
			path := filepath.Join(filepath.Dir(fixture.executablePath), "manager-link")
			if err := os.Symlink(fixture.executablePath, path); err != nil {
				t.Fatal(err)
			}
			return path, fixture.newSHA
		},
	}
	for name, prepare := range tests {
		t.Run(name, func(t *testing.T) {
			fixture := newRecoveryFixture(t)
			executable, expected := prepare(t, fixture)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if err := fixture.manager.RecoverCurrent(ctx, executable, fixture.platformPath, expected); err == nil {
				t.Fatal("unsafe recovery input was accepted")
			}
			if fixture.runner.count() != 0 {
				t.Fatalf("unsafe input stopped or started the Manager: %#v", fixture.runner.calls)
			}
		})
	}
}

func TestRecoverCurrentRejectsConcurrentInvocation(t *testing.T) {
	fixture := newRecoveryFixture(t)
	releaseLock, err := acquireRecoveryLock(fixture.manager.Root)
	if err != nil {
		t.Fatal(err)
	}
	defer releaseLock()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	err = fixture.manager.RecoverCurrent(ctx, fixture.executablePath, fixture.platformPath, fixture.newSHA)
	if err == nil || !strings.Contains(err.Error(), "already running") {
		t.Fatalf("concurrent recovery result = %v", err)
	}
	if fixture.runner.count() != 0 {
		t.Fatalf("concurrent recovery reached systemd: %#v", fixture.runner.calls)
	}
}

func TestRecoverCurrentRefusesToBypassHealthyCurrentManager(t *testing.T) {
	fixture := newRecoveryFixture(t)
	state, err := fixture.manager.State()
	if err != nil {
		t.Fatal(err)
	}
	fixture.identity.set(true, state.Current.Version, state.Current.SHA256)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	err = fixture.manager.RecoverCurrent(ctx, fixture.executablePath, fixture.platformPath, fixture.newSHA)
	if err == nil || !strings.Contains(err.Error(), "normal update path") {
		t.Fatalf("healthy Current recovery result = %v", err)
	}
	if fixture.runner.count() != 0 {
		t.Fatalf("healthy Current Manager was stopped: %#v", fixture.runner.calls)
	}
	assertRecoveryKeptOldCurrent(t, fixture)
}
