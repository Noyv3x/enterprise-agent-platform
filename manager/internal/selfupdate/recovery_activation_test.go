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
	"reflect"
	"runtime"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/atomicfile"
	"github.com/ubitech/agent-platform/manager/internal/contract"
	"github.com/ubitech/agent-platform/manager/internal/model"
	"github.com/ubitech/agent-platform/manager/internal/release"
)

type activationTakeoverRunner struct {
	mu    sync.Mutex
	calls [][]string
	hook  func(string, []string) error
}

func (r *activationTakeoverRunner) Run(_ context.Context, name string, arguments ...string) error {
	call := append([]string{name}, arguments...)
	r.mu.Lock()
	r.calls = append(r.calls, call)
	hook := r.hook
	r.mu.Unlock()
	if hook != nil {
		return hook(name, append([]string(nil), arguments...))
	}
	return nil
}

func (r *activationTakeoverRunner) snapshot() [][]string {
	r.mu.Lock()
	defer r.mu.Unlock()
	result := make([][]string, len(r.calls))
	for index := range r.calls {
		result[index] = append([]string(nil), r.calls[index]...)
	}
	return result
}

func (r *activationTakeoverRunner) countCommand(name string) int {
	count := 0
	for _, call := range r.snapshot() {
		if len(call) > 0 && call[0] == name {
			count++
		}
	}
	return count
}

type activationTakeoverQuiesceCall struct {
	mainUnit  string
	exact     []string
	planPath  string
	stateHash string
	planHash  string
	stableSHA string
}

type activationTakeoverFixture struct {
	manager *Manager
	runner  *activationTakeoverRunner

	executablePath string
	platformPath   string
	operationPath  string
	manifestPath   string
	oldPlanPath    string
	statePath      string
	stablePath     string
	tokenPath      string

	currentCommit   string
	candidateCommit string
	recoveryCommit  string
	operationID     string

	currentBinary   []byte
	candidateBinary []byte
	recoveryBinary  []byte
	currentSHA      string
	candidateSHA    string
	recoverySHA     string

	originalState     State
	originalPlan      Plan
	originalPlatform  model.ManagerState
	originalOperation model.Operation
	originalManifest  release.Manifest
	identity          *recoveryIdentityResponse
	server            *http.Server

	mu                 sync.Mutex
	activeUnits        map[string]bool
	unitEnabled        bool
	quiesceCalls       []activationTakeoverQuiesceCall
	quiesceErr         error
	commitOnMainStart  bool
	acknowledgeOnStart bool
	processChecks      int
	watchdogChecks     int
}

func newActivationTakeoverFixture(t *testing.T) *activationTakeoverFixture {
	t.Helper()
	base := t.TempDir()
	stateDir := filepath.Join(base, "manager")
	managerRoot := filepath.Join(stateDir, "manager-binaries")
	versionsDir := filepath.Join(managerRoot, "versions")
	activationsDir := filepath.Join(managerRoot, "activations")
	operationsDir := filepath.Join(stateDir, "operations")
	releasesDir := filepath.Join(stateDir, "releases")
	secretsDir := filepath.Join(stateDir, "secrets")
	binDir := filepath.Join(base, "bin")
	downloadDir := filepath.Join(base, "download")
	for _, directory := range []string{
		stateDir, managerRoot, versionsDir, activationsDir, operationsDir,
		releasesDir, secretsDir, binDir, downloadDir,
	} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}

	fixture := &activationTakeoverFixture{
		currentCommit:     strings.Repeat("0", 40),
		candidateCommit:   strings.Repeat("1", 40),
		recoveryCommit:    strings.Repeat("2", 40),
		operationID:       "op_424eed2fafecda3e46c89222c6ed33d7",
		currentBinary:     []byte("registered-current-manager-C\n"),
		candidateBinary:   []byte("platform-committed-candidate-X\n"),
		recoveryBinary:    []byte("externally-verified-recovery-R\n"),
		activeUnits:       make(map[string]bool),
		unitEnabled:       true,
		commitOnMainStart: true,
	}
	fixture.currentSHA = activationTakeoverSHA(fixture.currentBinary)
	fixture.candidateSHA = activationTakeoverSHA(fixture.candidateBinary)
	fixture.recoverySHA = activationTakeoverSHA(fixture.recoveryBinary)

	currentDir := filepath.Join(versionsDir, fixture.currentCommit+"-"+fixture.currentCommit[:12])
	candidateDir := filepath.Join(versionsDir, fixture.candidateCommit+"-"+fixture.candidateCommit[:12])
	for _, directory := range []string{currentDir, candidateDir, filepath.Join(releasesDir, fixture.candidateCommit)} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	currentPath := filepath.Join(currentDir, "ubitech-manager")
	candidatePath := filepath.Join(candidateDir, "ubitech-manager")
	fixture.stablePath = filepath.Join(binDir, "ubitech-manager")
	fixture.executablePath = filepath.Join(downloadDir, "ubitech-manager")
	for path, data := range map[string][]byte{
		currentPath:            fixture.currentBinary,
		candidatePath:          fixture.candidateBinary,
		fixture.stablePath:     fixture.candidateBinary,
		fixture.executablePath: fixture.recoveryBinary,
	} {
		mode := os.FileMode(0o700)
		if path == fixture.stablePath {
			mode = 0o755
		}
		if err := atomicfile.WriteFile(path, data, mode); err != nil {
			t.Fatal(err)
		}
	}

	fixture.statePath = filepath.Join(stateDir, "manager-binaries.json")
	fixture.oldPlanPath = filepath.Join(activationsDir, fixture.candidateCommit+".json")
	fixture.platformPath = filepath.Join(stateDir, "state.json")
	fixture.operationPath = filepath.Join(operationsDir, fixture.operationID+".json")
	fixture.manifestPath = filepath.Join(releasesDir, fixture.candidateCommit, "manifest.json")
	fixture.tokenPath = filepath.Join(secretsDir, "manager-token")

	createdAt := time.Date(2026, 7, 29, 0, 32, 25, 0, time.UTC)
	updatedAt := createdAt.Add(time.Second)
	completedAt := updatedAt.Add(time.Second)
	fixture.originalPlan = Plan{
		SchemaVersion:    1,
		PlanPath:         fixture.oldPlanPath,
		Status:           "activated",
		StatePath:        fixture.statePath,
		InstallPath:      fixture.stablePath,
		SocketPath:       "",
		ControlTokenFile: fixture.tokenPath,
		UnitName:         "ubitech-agent-manager.service",
		CandidateVersion: fixture.candidateCommit,
		CandidateSHA:     fixture.candidateSHA,
		CandidatePath:    candidatePath,
		PreviousPath:     currentPath,
		Activated:        true,
		Acknowledged:     false,
		CreatedAt:        createdAt,
		UpdatedAt:        updatedAt,
		HealthTimeoutMS:  45_000,
		BootID:           "116a2e13-30af-4ecc-8ea1-465b1b820f40",
	}
	fixture.originalState = State{
		SchemaVersion: 1,
		Current: &Version{
			Version: fixture.currentCommit, SourceCommit: fixture.currentCommit,
			Path: currentPath, SHA256: fixture.currentSHA, VerifiedAt: createdAt, PlatformCommitted: true,
		},
		Candidate: &Version{
			Version: fixture.candidateCommit, SourceCommit: fixture.candidateCommit,
			Path: candidatePath, SHA256: fixture.candidateSHA, VerifiedAt: updatedAt, PlatformCommitted: true,
		},
		Activation: &Activation{
			PlanPath: fixture.oldPlanPath, CandidateSHA: fixture.candidateSHA,
			CandidatePath: candidatePath, StartedAt: completedAt,
		},
		UpdatedAt: completedAt,
	}

	images := activationTakeoverImages()
	fixture.originalManifest = release.Manifest{
		SchemaVersion:         contract.SchemaVersion,
		Channel:               contract.ReleaseChannel,
		SourceCommit:          fixture.candidateCommit,
		GeneratedAt:           createdAt,
		ProtocolVersion:       contract.SchemaVersion,
		DatabaseSchemaVersion: contract.DatabaseSchemaVersion,
		Manager: release.ManagerRelease{
			Version: fixture.candidateCommit,
			Artifacts: map[string]release.Artifact{
				runtime.GOARCH: {URL: "http://127.0.0.1/manager", SHA256: fixture.candidateSHA},
			},
		},
		Compose: release.Artifact{URL: "http://127.0.0.1/compose", SHA256: strings.Repeat("a", 64)},
		Images:  images,
	}
	rollbackSnapshot := filepath.Join(stateDir, "backups", "before-X")
	fixture.originalPlatform = model.NewState(createdAt)
	fixture.originalPlatform.Generation = 43898
	fixture.originalPlatform.PublicState = model.StateUpdating
	fixture.originalPlatform.Maintenance = true
	fixture.originalPlatform.FinalizePendingOperationID = fixture.operationID
	fixture.originalPlatform.Current = &model.Generation{
		ID: fixture.candidateCommit, SourceCommit: fixture.candidateCommit,
		ManifestPath: fixture.manifestPath, DatabaseVersion: contract.DatabaseSchemaVersion,
		Images: images, RollbackSnapshotPath: rollbackSnapshot, ActivatedAt: completedAt,
	}
	fixture.originalPlatform.UpdatedAt = completedAt
	fixture.originalOperation = model.Operation{
		SchemaVersion:       1,
		ID:                  fixture.operationID,
		Kind:                model.OperationUpdate,
		IdempotencyKey:      "deployment-snapshot",
		Attempt:             1,
		ExpectedGeneration:  43897,
		TargetGeneration:    fixture.candidateCommit,
		Status:              model.OperationSucceeded,
		Finalized:           false,
		Phase:               model.PhaseCommitting,
		ReservationStatus:   model.ReservationMutationStarted,
		SnapshotPath:        rollbackSnapshot,
		ReservationReleased: false,
		CreatedAt:           createdAt,
		UpdatedAt:           updatedAt,
		CompletedAt:         &completedAt,
	}

	activationTakeoverWriteJSON(t, fixture.oldPlanPath, fixture.originalPlan)
	activationTakeoverWriteJSON(t, fixture.statePath, fixture.originalState)
	activationTakeoverWriteJSON(t, fixture.platformPath, fixture.originalPlatform)
	activationTakeoverWriteJSON(t, fixture.operationPath, fixture.originalOperation)
	activationTakeoverWriteJSON(t, fixture.manifestPath, fixture.originalManifest)
	if err := atomicfile.WriteFile(fixture.tokenPath, []byte("0123456789abcdef0123456789abcdef\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	controlDir, err := os.MkdirTemp("", "ubitech-activation-takeover-")
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
	fixture.originalPlan.SocketPath = socketPath
	activationTakeoverWriteJSON(t, fixture.oldPlanPath, fixture.originalPlan)
	fixture.identity = &recoveryIdentityResponse{version: fixture.recoveryCommit, sha: fixture.recoverySHA}
	fixture.server = &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer 0123456789abcdef0123456789abcdef" {
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
		available, version, digest := fixture.identity.value()
		if !available {
			response.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_ = json.NewEncoder(response).Encode(map[string]string{
			"status": "healthy", "version": version, "sha256": digest,
		})
	})}
	go func() { _ = fixture.server.Serve(listener) }()
	t.Cleanup(func() { _ = fixture.server.Close() })

	fixture.runner = &activationTakeoverRunner{}
	fixture.manager = &Manager{
		Root:             managerRoot,
		StatePath:        fixture.statePath,
		InstallPath:      fixture.stablePath,
		SocketPath:       socketPath,
		ControlTokenFile: fixture.tokenPath,
		UnitName:         "ubitech-agent-manager.service",
		RunningVersion:   fixture.recoveryCommit,
		Runner:           fixture.runner,
		Now:              func() time.Time { return completedAt.Add(time.Second) },
		BootID:           func() string { return fixture.originalPlan.BootID },
	}
	fixture.manager.RecoveryUnitActive = func(_ context.Context, unit string) (bool, error) {
		fixture.mu.Lock()
		defer fixture.mu.Unlock()
		return fixture.activeUnits[unit], nil
	}
	fixture.manager.RecoveryUnitEnabled = func(_ context.Context, _ string) (bool, error) {
		fixture.mu.Lock()
		defer fixture.mu.Unlock()
		return fixture.unitEnabled, nil
	}
	fixture.manager.RecoveryUnitFencer = func(_ context.Context, _ string, enabled bool) error {
		fixture.mu.Lock()
		defer fixture.mu.Unlock()
		fixture.unitEnabled = enabled
		return nil
	}
	fixture.manager.RecoveryProcessVerifier = func(_ context.Context, unit, stable, expectedSHA string) error {
		fixture.mu.Lock()
		defer fixture.mu.Unlock()
		fixture.processChecks++
		if unit != fixture.manager.UnitName || stable != fixture.stablePath ||
			(expectedSHA != fixture.recoverySHA && expectedSHA != fixture.currentSHA) || !binaryMatches(stable, expectedSHA) {
			return errors.New("unexpected recovered Manager process identity")
		}
		return nil
	}
	fixture.manager.RecoveryWatchdogVerifier = func(_ context.Context, unit, immutablePath, expectedSHA, planPath string) error {
		fixture.mu.Lock()
		defer fixture.mu.Unlock()
		fixture.watchdogChecks++
		if unit != recoveryCurrentWatchdogUnitPrefix+fixture.recoverySHA[:12] ||
			immutablePath != filepath.Join(fixture.manager.Root, "versions", "recovery-"+fixture.recoverySHA[:12], "ubitech-manager") ||
			expectedSHA != fixture.recoverySHA || planPath != fixture.manager.currentRecoveryPlanPath(fixture.candidateCommit, fixture.recoverySHA) {
			return errors.New("unexpected recovery watchdog process identity")
		}
		return nil
	}
	fixture.manager.RecoveryUnitQuiescer = func(_ context.Context, mainUnit string, exact []string, planPath string) error {
		call := activationTakeoverQuiesceCall{
			mainUnit:  mainUnit,
			exact:     append([]string(nil), exact...),
			planPath:  planPath,
			stateHash: activationTakeoverFileSHA(t, fixture.statePath),
			planHash:  activationTakeoverFileSHA(t, fixture.oldPlanPath),
			stableSHA: activationTakeoverFileSHA(t, fixture.stablePath),
		}
		fixture.mu.Lock()
		fixture.quiesceCalls = append(fixture.quiesceCalls, call)
		err := fixture.quiesceErr
		fixture.mu.Unlock()
		return err
	}
	fixture.runner.hook = fixture.runHook
	return fixture
}

func (f *activationTakeoverFixture) runHook(name string, arguments []string) error {
	if name == "systemd-run" {
		for index, argument := range arguments {
			if argument == "--unit" && index+1 < len(arguments) {
				f.mu.Lock()
				f.activeUnits[arguments[index+1]] = true
				f.mu.Unlock()
			}
		}
		return nil
	}
	if name != "systemctl" || len(arguments) < 3 || arguments[0] != "--user" {
		return nil
	}
	switch arguments[1] {
	case "stop":
		f.identity.set(false, "", "")
	case "start":
		if !binaryMatches(f.stablePath, f.recoverySHA) {
			return nil
		}
		f.identity.set(true, f.recoveryCommit, f.recoverySHA)
		f.mu.Lock()
		acknowledge := f.acknowledgeOnStart || f.commitOnMainStart
		commit := f.commitOnMainStart
		f.mu.Unlock()
		if acknowledge {
			state := activationTakeoverReadState(f.statePath)
			if state.Candidate == nil {
				return errors.New("recovery start had no Candidate")
			}
			if err := f.manager.acknowledgeExecutable(state.Candidate.Path); err != nil {
				return err
			}
		}
		if commit {
			state := activationTakeoverReadState(f.statePath)
			if state.Activation == nil {
				return errors.New("recovery start had no Activation")
			}
			_, plan, err := readRecoveryActivationPlan(state.Activation.PlanPath)
			if err != nil {
				return err
			}
			return commitActivation(plan.PlanPath, plan)
		}
	case "enable":
		f.mu.Lock()
		f.unitEnabled = true
		f.mu.Unlock()
	case "restart":
		if binaryMatches(f.stablePath, f.currentSHA) {
			f.identity.set(true, f.currentCommit, f.currentSHA)
		}
	}
	return nil
}

func (f *activationTakeoverFixture) setCommitBehavior(acknowledge, commit bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.acknowledgeOnStart = acknowledge
	f.commitOnMainStart = commit
}

func (f *activationTakeoverFixture) keyFiles() map[string][]byte {
	result := make(map[string][]byte)
	for _, path := range []string{
		f.statePath, f.oldPlanPath, f.platformPath, f.operationPath,
		f.manifestPath, f.stablePath, f.originalState.Current.Path,
		f.originalState.Candidate.Path, f.tokenPath,
	} {
		data, err := os.ReadFile(path)
		if err != nil {
			panic(err)
		}
		result[path] = data
	}
	return result
}

func (f *activationTakeoverFixture) quiesceSnapshot() ([]activationTakeoverQuiesceCall, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	result := make([]activationTakeoverQuiesceCall, len(f.quiesceCalls))
	copy(result, f.quiesceCalls)
	return result, f.quiesceErr
}

func TestRecoverCurrentTakesOverExactStuckActivationThroughWatchdogCommit(t *testing.T) {
	fixture := newActivationTakeoverFixture(t)
	platformBefore := activationTakeoverFileSHA(t, fixture.platformPath)
	operationBefore := activationTakeoverFileSHA(t, fixture.operationPath)
	manifestBefore := activationTakeoverFileSHA(t, fixture.manifestPath)
	originalStateSHA := activationTakeoverFileSHA(t, fixture.statePath)
	originalPlanSHA := activationTakeoverFileSHA(t, fixture.oldPlanPath)

	ctx, cancel := context.WithTimeout(context.Background(), 7*time.Second)
	defer cancel()
	if err := fixture.manager.RecoverCurrent(ctx, fixture.executablePath, fixture.platformPath, fixture.recoverySHA); err != nil {
		t.Fatal(err)
	}

	state := activationTakeoverReadState(fixture.statePath)
	if state.Current == nil || state.Current.Version != fixture.recoveryCommit ||
		state.Current.SourceCommit != fixture.candidateCommit || state.Current.SHA256 != fixture.recoverySHA ||
		state.Current.Path == fixture.executablePath || state.Candidate != nil || state.Activation != nil {
		t.Fatalf("recovery R was not committed as immutable Current for Platform X: %#v", state)
	}
	if state.Previous == nil || state.Previous.Version != fixture.currentCommit ||
		state.Previous.SHA256 != fixture.currentSHA || state.Previous.Path != fixture.originalState.Current.Path {
		t.Fatalf("watchdog did not preserve registered Current C as Previous: %#v", state.Previous)
	}
	if got := activationTakeoverFileSHA(t, fixture.stablePath); got != fixture.recoverySHA {
		t.Fatalf("stable Manager is %s, want recovery R %s", got, fixture.recoverySHA)
	}

	_, oldPlan, err := readRecoveryActivationPlan(fixture.oldPlanPath)
	if err != nil {
		t.Fatal(err)
	}
	if oldPlan.Status != recoverySupersededStatus || !strings.Contains(oldPlan.Error, "controlled Current recovery") {
		t.Fatalf("old activation plan was not durably superseded: %#v", oldPlan)
	}
	journalPath := fixture.manager.recoveryTakeoverJournalPath(fixture.candidateCommit, fixture.recoverySHA)
	journal, exists, err := fixture.manager.readRecoveryTakeoverJournal(journalPath)
	if err != nil || !exists {
		t.Fatalf("read takeover journal: exists=%v err=%v", exists, err)
	}
	if journal.Phase != recoveryTakeoverCommitted || journal.OriginalStateSHA256 != originalStateSHA ||
		journal.OriginalPlanSHA256 != originalPlanSHA || journal.OriginalCurrent != *fixture.originalState.Current ||
		journal.OriginalCandidate != *fixture.originalState.Candidate || journal.OriginalActivation != *fixture.originalState.Activation {
		t.Fatalf("takeover journal lost the exact C/X activation identity: %#v", journal)
	}
	if journal.PlatformCommit != fixture.candidateCommit || journal.OperationID != fixture.operationID ||
		journal.InitialStableSHA256 != fixture.candidateSHA {
		t.Fatalf("takeover journal lost deployed X/finalize evidence: %#v", journal)
	}
	if activationTakeoverFileSHA(t, fixture.platformPath) != platformBefore ||
		activationTakeoverFileSHA(t, fixture.operationPath) != operationBefore ||
		activationTakeoverFileSHA(t, fixture.manifestPath) != manifestBefore {
		t.Fatal("controlled Manager takeover mutated Platform finalize evidence")
	}
	quiesceCalls, _ := fixture.quiesceSnapshot()
	if len(quiesceCalls) < 2 {
		t.Fatalf("expected initial and journal-owner quiescence, got %#v", quiesceCalls)
	}
	wantUnits := recoveryActivationWatchdogUnits(*fixture.originalState.Candidate)
	for _, call := range quiesceCalls {
		gotUnits := append([]string(nil), call.exact...)
		sort.Strings(gotUnits)
		want := append([]string(nil), wantUnits...)
		sort.Strings(want)
		if call.mainUnit != fixture.manager.UnitName || call.planPath != fixture.oldPlanPath ||
			!reflect.DeepEqual(gotUnits, want) || call.stateHash != originalStateSHA ||
			call.planHash != originalPlanSHA || call.stableSHA != fixture.candidateSHA {
			t.Fatalf("quiescer did not observe the exact untouched old owners: got=%#v wantUnits=%#v", call, wantUnits)
		}
	}
	fixture.mu.Lock()
	processChecks := fixture.processChecks
	watchdogChecks := fixture.watchdogChecks
	fixture.mu.Unlock()
	if processChecks < 2 || watchdogChecks < 2 || fixture.runner.countCommand("systemd-run") != 1 {
		t.Fatalf("recovery did not prove process/watchdog ownership: processChecks=%d watchdogChecks=%d calls=%#v", processChecks, watchdogChecks, fixture.runner.snapshot())
	}
}

func TestRecoverCurrentActivationEvidenceMismatchFailsBeforeSystemd(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*testing.T, *activationTakeoverFixture)
	}{
		{
			name: "Platform boundary",
			mutate: func(t *testing.T, fixture *activationTakeoverFixture) {
				state := fixture.originalPlatform
				state.Maintenance = false
				activationTakeoverWriteJSON(t, fixture.platformPath, state)
			},
		},
		{
			name: "operation boundary",
			mutate: func(t *testing.T, fixture *activationTakeoverFixture) {
				op := fixture.originalOperation
				op.Finalized = true
				activationTakeoverWriteJSON(t, fixture.operationPath, op)
			},
		},
		{
			name: "manifest Manager version",
			mutate: func(t *testing.T, fixture *activationTakeoverFixture) {
				manifest := fixture.originalManifest
				manifest.Manager.Version = strings.Repeat("3", 40)
				activationTakeoverWriteJSON(t, fixture.manifestPath, manifest)
			},
		},
		{
			name: "manifest current arch artifact",
			mutate: func(t *testing.T, fixture *activationTakeoverFixture) {
				manifest := fixture.originalManifest
				manifest.Manager.Artifacts = activationTakeoverArtifacts(manifest.Manager.Artifacts)
				artifact := manifest.Manager.Artifacts[runtime.GOARCH]
				artifact.SHA256 = strings.Repeat("f", 64)
				manifest.Manager.Artifacts[runtime.GOARCH] = artifact
				activationTakeoverWriteJSON(t, fixture.manifestPath, manifest)
			},
		},
		{
			name: "Candidate identity",
			mutate: func(t *testing.T, fixture *activationTakeoverFixture) {
				state := fixture.originalState
				candidate := *state.Candidate
				candidate.PlatformCommitted = false
				state.Candidate = &candidate
				activationTakeoverWriteJSON(t, fixture.statePath, state)
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newActivationTakeoverFixture(t)
			test.mutate(t, fixture)
			before := fixture.keyFiles()
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if err := fixture.manager.RecoverCurrent(ctx, fixture.executablePath, fixture.platformPath, fixture.recoverySHA); err == nil {
				t.Fatal("evidence mismatch unexpectedly entered controlled takeover")
			}
			if calls := fixture.runner.snapshot(); len(calls) != 0 {
				t.Fatalf("evidence mismatch reached systemd: %#v", calls)
			}
			quiesceCalls, _ := fixture.quiesceSnapshot()
			if len(quiesceCalls) != 0 {
				t.Fatalf("evidence mismatch reached unit quiescence: %#v", quiesceCalls)
			}
			activationTakeoverAssertFiles(t, before)
		})
	}
}

func TestRecoverCurrentQuiescerFailurePreservesActivationAndFiles(t *testing.T) {
	fixture := newActivationTakeoverFixture(t)
	fixture.mu.Lock()
	fixture.quiesceErr = errors.New("injected unit ownership ambiguity")
	fixture.mu.Unlock()
	before := fixture.keyFiles()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	err := fixture.manager.RecoverCurrent(ctx, fixture.executablePath, fixture.platformPath, fixture.recoverySHA)
	if err == nil || !strings.Contains(err.Error(), "injected unit ownership ambiguity") {
		t.Fatalf("unexpected quiescer error: %v", err)
	}
	activationTakeoverAssertFiles(t, before)
	if _, exists, journalErr := fixture.manager.readRecoveryTakeoverJournal(
		fixture.manager.recoveryTakeoverJournalPath(fixture.candidateCommit, fixture.recoverySHA),
	); journalErr != nil || exists {
		t.Fatalf("failed quiescence created a takeover journal: exists=%v err=%v", exists, journalErr)
	}
	if fixture.runner.countCommand("systemd-run") != 0 {
		t.Fatalf("failed quiescence launched a watchdog: %#v", fixture.runner.snapshot())
	}
	quiesceCalls, _ := fixture.quiesceSnapshot()
	if len(quiesceCalls) != 1 {
		t.Fatalf("unexpected quiescer calls: %#v", quiesceCalls)
	}
}

func TestRecoveryWatchdogCommitReplayDoesNotRotatePreviousTwice(t *testing.T) {
	fixture := newActivationTakeoverFixture(t)
	fixture.setCommitBehavior(true, false)
	ctx, cancel := context.WithTimeout(context.Background(), 350*time.Millisecond)
	err := fixture.manager.RecoverCurrent(ctx, fixture.executablePath, fixture.platformPath, fixture.recoverySHA)
	cancel()
	if err == nil || !strings.Contains(err.Error(), "owned by its watchdog") {
		t.Fatalf("expected observer timeout after watchdog ownership handoff, got %v", err)
	}
	journalPath := fixture.manager.recoveryTakeoverJournalPath(fixture.candidateCommit, fixture.recoverySHA)
	journal, exists, err := fixture.manager.readRecoveryTakeoverJournal(journalPath)
	if err != nil || !exists || journal.Phase != recoveryTakeoverMainStarted {
		t.Fatalf("takeover did not stop at replayable main_started boundary: %#v exists=%v err=%v", journal, exists, err)
	}
	spawns := fixture.runner.countCommand("systemd-run")
	replayCtx, replayCancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	err = fixture.manager.RecoverCurrent(replayCtx, fixture.executablePath, fixture.platformPath, fixture.recoverySHA)
	replayCancel()
	if err == nil || !strings.Contains(err.Error(), "owned by its watchdog") {
		t.Fatalf("expected replay observer timeout, got %v", err)
	}
	if fixture.runner.countCommand("systemd-run") != spawns {
		t.Fatalf("replay launched a duplicate watchdog: before=%d after=%d calls=%#v", spawns, fixture.runner.countCommand("systemd-run"), fixture.runner.snapshot())
	}

	state := activationTakeoverReadState(fixture.statePath)
	if state.Current == nil || state.Candidate == nil || state.Activation == nil {
		t.Fatalf("missing owned recovery activation before simulated crash: %#v", state)
	}
	planPath := state.Activation.PlanPath
	_, plan, err := readRecoveryActivationPlan(planPath)
	if err != nil || plan.Status != "acknowledged" {
		t.Fatalf("recovery process did not acknowledge before simulated crash: %#v err=%v", plan, err)
	}
	// Exact crash boundary: commitActivation has atomically promoted state but
	// has not yet written the terminal plan or takeover-journal metadata.
	state.Previous = state.Current
	state.Current = state.Candidate
	state.Candidate = nil
	state.Activation = nil
	activationTakeoverWriteJSON(t, fixture.statePath, state)
	if err := commitActivation(planPath, plan); err != nil {
		t.Fatalf("watchdog did not finish metadata-only replay: %v", err)
	}
	committed := activationTakeoverReadState(fixture.statePath)
	if committed.Current == nil || committed.Current.SHA256 != fixture.recoverySHA ||
		committed.Previous == nil || committed.Previous.SHA256 != fixture.currentSHA ||
		committed.Previous.SHA256 == fixture.candidateSHA {
		t.Fatalf("metadata replay rotated Current/Previous twice: %#v", committed)
	}
	if err := commitActivation(planPath, plan); err != nil {
		t.Fatalf("terminal watchdog replay was not idempotent: %v", err)
	}
	afterSecondReplay := activationTakeoverReadState(fixture.statePath)
	if !reflect.DeepEqual(committed, afterSecondReplay) {
		t.Fatalf("terminal replay mutated Current/Previous: before=%#v after=%#v", committed, afterSecondReplay)
	}
	journal, exists, err = fixture.manager.readRecoveryTakeoverJournal(journalPath)
	if err != nil || !exists || journal.Phase != recoveryTakeoverCommitted {
		t.Fatalf("metadata replay did not terminalize journal: %#v exists=%v err=%v", journal, exists, err)
	}
}

func TestSupersededOldWatchdogSnapshotCannotCommitOrRestore(t *testing.T) {
	fixture := newActivationTakeoverFixture(t)
	fixture.setCommitBehavior(true, false)
	oldPlanSnapshot := fixture.originalPlan
	ctx, cancel := context.WithTimeout(context.Background(), 350*time.Millisecond)
	err := fixture.manager.RecoverCurrent(ctx, fixture.executablePath, fixture.platformPath, fixture.recoverySHA)
	cancel()
	if err == nil {
		t.Fatal("expected recovery observer timeout")
	}
	_, durableOldPlan, err := readRecoveryActivationPlan(fixture.oldPlanPath)
	if err != nil || durableOldPlan.Status != recoverySupersededStatus {
		t.Fatalf("old ownership was not superseded: %#v err=%v", durableOldPlan, err)
	}
	before := fixture.keyFiles()
	if err := commitActivation(fixture.oldPlanPath, oldPlanSnapshot); err == nil || !strings.Contains(err.Error(), "superseded") {
		t.Fatalf("stale old watchdog commit was not rejected: %v", err)
	}
	if err := restorePrevious(oldPlanSnapshot, fixture.runner); err == nil || !strings.Contains(err.Error(), "superseded") {
		t.Fatalf("stale old watchdog rollback was not rejected: %v", err)
	}
	activationTakeoverAssertFiles(t, before)
}

func TestRecoveryWatchdogRollbackRestoresCurrentCheckpointAndIsReplayable(t *testing.T) {
	fixture := newActivationTakeoverFixture(t)
	fixture.setCommitBehavior(true, false)
	platformBefore := activationTakeoverFileSHA(t, fixture.platformPath)
	operationBefore := activationTakeoverFileSHA(t, fixture.operationPath)
	manifestBefore := activationTakeoverFileSHA(t, fixture.manifestPath)
	ctx, cancel := context.WithTimeout(context.Background(), 350*time.Millisecond)
	err := fixture.manager.RecoverCurrent(ctx, fixture.executablePath, fixture.platformPath, fixture.recoverySHA)
	cancel()
	if err == nil || !strings.Contains(err.Error(), "owned by its watchdog") {
		t.Fatalf("expected recovery observer timeout, got %v", err)
	}
	state := activationTakeoverReadState(fixture.statePath)
	if state.Activation == nil || state.Candidate == nil || state.Candidate.SHA256 != fixture.recoverySHA ||
		activationTakeoverFileSHA(t, fixture.stablePath) != fixture.recoverySHA {
		t.Fatalf("fixture did not reach watchdog-owned R activation: %#v", state)
	}
	_, plan, err := readRecoveryActivationPlan(state.Activation.PlanPath)
	if err != nil {
		t.Fatal(err)
	}
	plan.Error = "injected recovery health deadline"
	if err := restorePrevious(plan, fixture.runner); err == nil || !strings.Contains(err.Error(), plan.Error) {
		t.Fatalf("unexpected recovery watchdog rollback result: %v", err)
	}
	rolledBack := activationTakeoverReadState(fixture.statePath)
	if rolledBack.Current == nil || rolledBack.Current.SHA256 != fixture.currentSHA ||
		rolledBack.Current.Path != fixture.originalState.Current.Path || rolledBack.Activation != nil ||
		rolledBack.Candidate != nil {
		t.Fatalf("watchdog rollback did not restore the C checkpoint: %#v", rolledBack)
	}
	if got := activationTakeoverFileSHA(t, fixture.stablePath); got != fixture.currentSHA {
		t.Fatalf("watchdog rollback left stable at %s, want C %s", got, fixture.currentSHA)
	}
	journalPath := fixture.manager.recoveryTakeoverJournalPath(fixture.candidateCommit, fixture.recoverySHA)
	journal, exists, err := fixture.manager.readRecoveryTakeoverJournal(journalPath)
	if err != nil || !exists || journal.Phase != recoveryTakeoverRolledBack {
		t.Fatalf("watchdog rollback did not terminalize journal: %#v exists=%v err=%v", journal, exists, err)
	}
	_, durablePlan, err := readRecoveryActivationPlan(plan.PlanPath)
	if err != nil || durablePlan.Status != "rolled_back" || durablePlan.Error != plan.Error {
		t.Fatalf("watchdog rollback did not terminalize plan: %#v err=%v", durablePlan, err)
	}
	if activationTakeoverFileSHA(t, fixture.platformPath) != platformBefore ||
		activationTakeoverFileSHA(t, fixture.operationPath) != operationBefore ||
		activationTakeoverFileSHA(t, fixture.manifestPath) != manifestBefore {
		t.Fatal("Manager rollback mutated Platform finalize evidence")
	}

	beforeReplay := fixture.keyFiles()
	if err := restorePrevious(plan, fixture.runner); err == nil || !strings.Contains(err.Error(), plan.Error) {
		t.Fatalf("terminal rollback replay was not idempotent: %v", err)
	}
	activationTakeoverAssertFiles(t, beforeReplay)
}

func TestRecoveryTakeoverJournalRejectsLostConditionalOwnership(t *testing.T) {
	fixture := newActivationTakeoverFixture(t)
	fixture.setCommitBehavior(true, false)
	ctx, cancel := context.WithTimeout(context.Background(), 350*time.Millisecond)
	err := fixture.manager.RecoverCurrent(ctx, fixture.executablePath, fixture.platformPath, fixture.recoverySHA)
	cancel()
	if err == nil {
		t.Fatal("expected recovery observer timeout")
	}
	journalPath := fixture.manager.recoveryTakeoverJournalPath(fixture.candidateCommit, fixture.recoverySHA)
	stale, exists, err := fixture.manager.readRecoveryTakeoverJournal(journalPath)
	if err != nil || !exists || stale.Phase != recoveryTakeoverMainStarted {
		t.Fatalf("read watchdog-owned journal: %#v exists=%v err=%v", stale, exists, err)
	}
	beforeState := activationTakeoverFileSHA(t, fixture.statePath)
	beforeStable := activationTakeoverFileSHA(t, fixture.stablePath)
	beforePlan := activationTakeoverFileSHA(t, stale.RecoveryPlanPath)

	otherOwner := stale
	otherOwner.OriginalStateSHA256 = strings.Repeat("e", 64)
	otherOwner.TransactionID = activationTakeoverJournalTransactionID(otherOwner)
	otherOwner.UpdatedAt = otherOwner.UpdatedAt.Add(time.Second)
	if err := fixture.manager.persistRecoveryTakeoverJournal(otherOwner); err != nil {
		t.Fatalf("install conditional-ownership competitor: %v", err)
	}
	staleForAdvance := stale
	if err := fixture.manager.advanceRecoveryTakeoverJournal(&staleForAdvance, recoveryTakeoverCommitted); err == nil ||
		!strings.Contains(err.Error(), "ownership changed") {
		t.Fatalf("stale phase writer was not rejected: %v", err)
	}
	if err := persistRecoveryTakeoverTerminal(stale, recoveryTakeoverCommitted); err == nil ||
		!strings.Contains(err.Error(), "lost transaction ownership") {
		t.Fatalf("stale terminal writer was not rejected: %v", err)
	}
	if activationTakeoverFileSHA(t, fixture.statePath) != beforeState ||
		activationTakeoverFileSHA(t, fixture.stablePath) != beforeStable ||
		activationTakeoverFileSHA(t, stale.RecoveryPlanPath) != beforePlan {
		t.Fatal("rejected stale journal owner mutated activation state, stable, or plan")
	}
}

func TestRecoveryTakeoverMutationLockPreservesConcurrentWatchdogTerminal(t *testing.T) {
	for _, terminal := range []string{recoveryTakeoverCommitted, recoveryTakeoverRolledBack} {
		t.Run(terminal, func(t *testing.T) {
			fixture := newActivationTakeoverFixture(t)
			journal := activationTakeoverPauseAtMainStarted(t, fixture)
			journal.Phase = recoveryTakeoverWatchdogOwned
			if err := fixture.manager.persistRecoveryTakeoverJournal(journal); err != nil {
				t.Fatal(err)
			}

			applyEntered := make(chan struct{})
			releaseApply := make(chan struct{})
			bootstrapDone := make(chan error, 1)
			bootstrapJournal := journal
			go func() {
				bootstrapDone <- fixture.manager.runRecoveryBootstrapTransition(
					&bootstrapJournal,
					recoveryTakeoverStableReplaced,
					func(recoveryTakeoverJournal) error {
						close(applyEntered)
						<-releaseApply
						return nil
					},
				)
			}()
			<-applyEntered

			terminalStarted := make(chan struct{})
			terminalDone := make(chan error, 1)
			go func() {
				close(terminalStarted)
				terminalDone <- persistRecoveryTakeoverTerminal(journal, terminal)
			}()
			<-terminalStarted
			select {
			case err := <-terminalDone:
				t.Fatalf("terminal writer bypassed bootstrap flock: %v", err)
			case <-time.After(50 * time.Millisecond):
			}
			close(releaseApply)
			if err := <-bootstrapDone; err != nil {
				t.Fatalf("bootstrap phase writer failed: %v", err)
			}
			if err := <-terminalDone; err != nil {
				t.Fatalf("watchdog terminal writer failed after flock handoff: %v", err)
			}
			latest, exists, err := fixture.manager.readRecoveryTakeoverJournal(journal.Path)
			if err != nil || !exists || latest.Phase != terminal {
				t.Fatalf("stale bootstrap overwrote watchdog terminal: %#v exists=%v err=%v", latest, exists, err)
			}
		})
	}
}

func TestRecoveryPlanOwnershipRequiresEveryBindingField(t *testing.T) {
	fixture := newActivationTakeoverFixture(t)
	journal := activationTakeoverPauseAtMainStarted(t, fixture)
	_, plan, err := readRecoveryActivationPlan(journal.RecoveryPlanPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateRecoveryPlanOwnership(plan, journal); err != nil {
		t.Fatalf("valid recovery plan binding was rejected: %v", err)
	}
	tests := []struct {
		name   string
		mutate func(*Plan)
	}{
		{"transaction id", func(plan *Plan) { plan.RecoveryTransactionID = "" }},
		{"journal path", func(plan *Plan) { plan.RecoveryJournalPath = "" }},
		{"candidate version", func(plan *Plan) { plan.CandidateVersion = "" }},
		{"candidate sha", func(plan *Plan) { plan.CandidateSHA = "" }},
		{"candidate path", func(plan *Plan) { plan.CandidatePath = "" }},
		{"superseded plan path", func(plan *Plan) { plan.SupersededPlanPath = "" }},
		{"superseded plan sha", func(plan *Plan) { plan.SupersededPlanSHA = "" }},
		{"platform commit", func(plan *Plan) { plan.PlatformCommit = "" }},
		{"previous path", func(plan *Plan) { plan.PreviousPath = "" }},
		{"plan path", func(plan *Plan) { plan.PlanPath = "" }},
		{"Manager state path", func(plan *Plan) { plan.StatePath = "" }},
		{"install path", func(plan *Plan) { plan.InstallPath = "" }},
		{"socket path", func(plan *Plan) { plan.SocketPath = "" }},
		{"control token path", func(plan *Plan) { plan.ControlTokenFile = "" }},
		{"unit name", func(plan *Plan) { plan.UnitName = "" }},
		{"health timeout", func(plan *Plan) { plan.HealthTimeoutMS = 0 }},
		{"boot id", func(plan *Plan) { plan.BootID = "" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			mutated := plan
			test.mutate(&mutated)
			if err := validateRecoveryPlanOwnership(mutated, journal); err == nil {
				t.Fatal("incomplete recovery plan retained transaction ownership")
			}
			if _, err := readRecoveryTakeoverOwnership(mutated); err == nil {
				t.Fatal("incomplete recovery plan was accepted by watchdog ownership read")
			}
		})
	}
}

func TestRecoveryProcessInExactControlGroup(t *testing.T) {
	controlGroup := "/user.slice/user-1001.slice/user@1001.service/app.slice/ubitech-watchdog.service"
	tests := []struct {
		name string
		data string
		want bool
	}{
		{"unified exact", "0::" + controlGroup + "\n", true},
		{"controller exact", "5:cpu,memory:" + controlGroup + "\n", true},
		{"one exact among lines", "4:cpu:/other\n0::" + controlGroup + "\n", true},
		{"substring suffix", "0::" + controlGroup + "-attacker\n", false},
		{"substring prefix", "0::/prefix" + controlGroup + "\n", false},
		{"child path", "0::" + controlGroup + "/child\n", false},
		{"parent path", "0::" + filepath.Dir(controlGroup) + "\n", false},
		{"same basename elsewhere", "0::/attacker/ubitech-watchdog.service\n", false},
		{"embedded second record", "0::/other " + controlGroup + "\n", false},
		{"malformed missing separator", "0:" + controlGroup + "\n", false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := recoveryProcessInExactControlGroup([]byte(test.data), controlGroup); got != test.want {
				t.Fatalf("recoveryProcessInExactControlGroup(%q, %q)=%v, want %v", test.data, controlGroup, got, test.want)
			}
		})
	}
}

func TestRecoveryBootstrapReplaysCompletedSideEffectBeforePhaseWrite(t *testing.T) {
	tests := []struct {
		name   string
		from   string
		target string
		setup  func(*testing.T, *activationTakeoverFixture)
		apply  func(context.Context, *activationTakeoverFixture, recoveryTakeoverJournal) error
	}{
		{
			name: "stable Current restored",
			from: recoveryTakeoverPrepared, target: recoveryTakeoverStableCurrent,
			setup: func(t *testing.T, fixture *activationTakeoverFixture) {
				if err := atomicfile.WriteFile(fixture.stablePath, fixture.currentBinary, 0o755); err != nil {
					t.Fatal(err)
				}
			},
			apply: func(_ context.Context, fixture *activationTakeoverFixture, journal recoveryTakeoverJournal) error {
				return fixture.manager.ensureRecoveryStable(journal.OriginalCurrent, journal.InitialStableSHA256)
			},
		},
		{
			name: "old plan superseded",
			from: recoveryTakeoverStableCurrent, target: recoveryTakeoverPlanSuperseded,
			apply: func(_ context.Context, fixture *activationTakeoverFixture, journal recoveryTakeoverJournal) error {
				return fixture.manager.ensureOriginalPlanSuperseded(journal)
			},
		},
		{
			name: "old activation cleared",
			from: recoveryTakeoverPlanSuperseded, target: recoveryTakeoverActivationCleared,
			setup: func(t *testing.T, fixture *activationTakeoverFixture) {
				state := fixture.originalState
				state.Activation = nil
				activationTakeoverWriteJSON(t, fixture.statePath, state)
			},
			apply: func(_ context.Context, fixture *activationTakeoverFixture, journal recoveryTakeoverJournal) error {
				return fixture.manager.ensureOriginalActivationCleared(journal)
			},
		},
		{
			name: "recovery intent persisted",
			from: recoveryTakeoverActivationCleared, target: recoveryTakeoverIntentPersisted,
			apply: func(_ context.Context, fixture *activationTakeoverFixture, journal recoveryTakeoverJournal) error {
				return fixture.manager.ensureRecoveryActivationIntent(journal, recoveryActivationRequest{unit: fixture.manager.UnitName})
			},
		},
		{
			name: "watchdog owns transaction",
			from: recoveryTakeoverIntentPersisted, target: recoveryTakeoverWatchdogOwned,
			apply: func(ctx context.Context, fixture *activationTakeoverFixture, journal recoveryTakeoverJournal) error {
				return fixture.manager.ensureRecoveryWatchdog(ctx, journal)
			},
		},
		{
			name: "stable replaced with R",
			from: recoveryTakeoverWatchdogOwned, target: recoveryTakeoverStableReplaced,
			apply: func(_ context.Context, fixture *activationTakeoverFixture, journal recoveryTakeoverJournal) error {
				return fixture.manager.ensureRecoveryStableReplaced(journal)
			},
		},
		{
			name: "recovery plan activated",
			from: recoveryTakeoverStableReplaced, target: recoveryTakeoverPlanActivated,
			apply: func(_ context.Context, fixture *activationTakeoverFixture, journal recoveryTakeoverJournal) error {
				return fixture.manager.ensureRecoveryPlanActivated(journal)
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newActivationTakeoverFixture(t)
			journal := activationTakeoverPauseAtMainStarted(t, fixture)
			if test.setup != nil {
				test.setup(t, fixture)
			}
			journal.Phase = test.from
			if err := fixture.manager.persistRecoveryTakeoverJournal(journal); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if err := fixture.manager.runRecoveryBootstrapTransition(&journal, test.target, func(latest recoveryTakeoverJournal) error {
				return test.apply(ctx, fixture, latest)
			}); err != nil {
				t.Fatalf("completed side effect was not replayable: %v", err)
			}
			latest, exists, err := fixture.manager.readRecoveryTakeoverJournal(journal.Path)
			if err != nil || !exists || latest.Phase != test.target {
				t.Fatalf("phase did not catch up to completed side effect: %#v exists=%v err=%v", latest, exists, err)
			}
		})
	}
}

func TestRecoveryMainStartReplayAdvancesMissingPhaseWithoutDuplicateWatchdog(t *testing.T) {
	fixture := newActivationTakeoverFixture(t)
	journal := activationTakeoverPauseAtMainStarted(t, fixture)
	journal.Phase = recoveryTakeoverPlanActivated
	if err := fixture.manager.persistRecoveryTakeoverJournal(journal); err != nil {
		t.Fatal(err)
	}
	watchdogSpawns := fixture.runner.countCommand("systemd-run")
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	err := fixture.manager.RecoverCurrent(ctx, fixture.executablePath, fixture.platformPath, fixture.recoverySHA)
	cancel()
	if err == nil || !strings.Contains(err.Error(), "owned by its watchdog") {
		t.Fatalf("expected observer timeout after replayed main start, got %v", err)
	}
	latest, exists, readErr := fixture.manager.readRecoveryTakeoverJournal(journal.Path)
	if readErr != nil || !exists || latest.Phase != recoveryTakeoverMainStarted {
		t.Fatalf("main start replay did not catch up phase: %#v exists=%v err=%v", latest, exists, readErr)
	}
	if fixture.runner.countCommand("systemd-run") != watchdogSpawns {
		t.Fatalf("main start replay launched a duplicate watchdog: %#v", fixture.runner.snapshot())
	}
}

func TestRecoverCurrentRebindsOldWatchdogRollbackWonDuringStopRace(t *testing.T) {
	fixture := newActivationTakeoverFixture(t)
	quiesceCalls := 0
	fixture.manager.RecoveryUnitQuiescer = func(_ context.Context, _ string, _ []string, planPath string) error {
		quiesceCalls++
		if quiesceCalls != 1 {
			return nil
		}
		if planPath != fixture.oldPlanPath {
			return errors.New("stop-race quiescer received the wrong old plan")
		}
		// The ordinary watchdog wins exactly while the external command is
		// stopping/quiescing it: stable is restored to C, its Activation is
		// cleared while Candidate X remains, and its plan becomes rolled_back.
		state := fixture.originalState
		state.Activation = nil
		activationTakeoverWriteJSON(t, fixture.statePath, state)
		plan := fixture.originalPlan
		plan.Status = "rolled_back"
		plan.Error = "candidate did not acknowledge before old watchdog deadline"
		plan.UpdatedAt = plan.UpdatedAt.Add(time.Second)
		activationTakeoverWriteJSON(t, fixture.oldPlanPath, plan)
		if err := atomicfile.WriteFile(fixture.stablePath, fixture.currentBinary, 0o755); err != nil {
			t.Fatal(err)
		}
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 7*time.Second)
	defer cancel()
	if err := fixture.manager.RecoverCurrent(ctx, fixture.executablePath, fixture.platformPath, fixture.recoverySHA); err != nil {
		t.Fatal(err)
	}
	state := activationTakeoverReadState(fixture.statePath)
	if state.Current == nil || state.Current.SHA256 != fixture.recoverySHA ||
		state.Previous == nil || state.Previous.SHA256 != fixture.currentSHA ||
		state.Candidate != nil || state.Activation != nil {
		t.Fatalf("stop-race rollback was not rebound into recovery activation: %#v", state)
	}
	_, oldPlan, err := readRecoveryActivationPlan(fixture.oldPlanPath)
	if err != nil || oldPlan.Status != recoverySupersededStatus {
		t.Fatalf("rolled-back old plan was not rebound as superseded: %#v err=%v", oldPlan, err)
	}
	journal, exists, err := fixture.manager.readRecoveryTakeoverJournal(
		fixture.manager.recoveryTakeoverJournalPath(fixture.candidateCommit, fixture.recoverySHA),
	)
	if err != nil || !exists || journal.Phase != recoveryTakeoverCommitted ||
		journal.OriginalCandidate.SHA256 != fixture.candidateSHA || journal.OriginalCurrent.SHA256 != fixture.currentSHA {
		t.Fatalf("stop-race takeover journal lost C/X identity: %#v exists=%v err=%v", journal, exists, err)
	}
	if quiesceCalls < 2 {
		t.Fatalf("stop-race path did not re-quiesce journal ownership: calls=%d", quiesceCalls)
	}
}

func TestRecoveryUnitFenceAndActivationOrdering(t *testing.T) {
	t.Run("journal then fence; activate then enable and start", func(t *testing.T) {
		fixture := newActivationTakeoverFixture(t)
		events := make([]string, 0, 3)
		fixture.manager.RecoveryUnitFencer = func(_ context.Context, _ string, enabled bool) error {
			journalPath := fixture.manager.recoveryTakeoverJournalPath(fixture.candidateCommit, fixture.recoverySHA)
			journal, exists, err := fixture.manager.readRecoveryTakeoverJournal(journalPath)
			if err != nil || !exists {
				return errors.New("unit fence ran before takeover journal was durable")
			}
			if enabled {
				state := activationTakeoverReadState(fixture.statePath)
				if journal.Phase != recoveryTakeoverPlanActivated || !binaryMatches(fixture.stablePath, fixture.recoverySHA) ||
					state.Candidate == nil || state.Candidate.SHA256 != fixture.recoverySHA ||
					state.Activation == nil || state.Activation.PlanPath != journal.RecoveryPlanPath {
					return errors.New("Manager was enabled before R activation was durably activated")
				}
				events = append(events, "enable")
			} else {
				state := activationTakeoverReadState(fixture.statePath)
				if state.Activation == nil || state.Activation.PlanPath == journal.RecoveryPlanPath {
					return errors.New("recovery Activation existed before the Manager unit fence")
				}
				events = append(events, "disable")
			}
			fixture.mu.Lock()
			fixture.unitEnabled = enabled
			fixture.mu.Unlock()
			return nil
		}
		originalHook := fixture.runner.hook
		fixture.runner.hook = func(name string, arguments []string) error {
			if name == "systemctl" && len(arguments) >= 3 && arguments[0] == "--user" && arguments[1] == "start" &&
				binaryMatches(fixture.stablePath, fixture.recoverySHA) {
				fixture.mu.Lock()
				enabled := fixture.unitEnabled
				fixture.mu.Unlock()
				journal, exists, err := fixture.manager.readRecoveryTakeoverJournal(
					fixture.manager.recoveryTakeoverJournalPath(fixture.candidateCommit, fixture.recoverySHA),
				)
				if err != nil || !exists || journal.Phase != recoveryTakeoverPlanActivated || !enabled {
					return errors.New("Manager start overtook recovery plan activation or unit enablement")
				}
				events = append(events, "start")
			}
			return originalHook(name, arguments)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 7*time.Second)
		defer cancel()
		if err := fixture.manager.RecoverCurrent(ctx, fixture.executablePath, fixture.platformPath, fixture.recoverySHA); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(events, []string{"disable", "enable", "start"}) {
			t.Fatalf("unexpected unit fence/start order: %#v", events)
		}
	})

	t.Run("stable C checkpoint has no recovery Activation", func(t *testing.T) {
		fixture := newActivationTakeoverFixture(t)
		quiesces := 0
		fixture.manager.RecoveryUnitQuiescer = func(_ context.Context, _ string, _ []string, _ string) error {
			quiesces++
			if quiesces == 2 {
				plan := fixture.originalPlan
				plan.Status = "unexpected_terminal_owner"
				activationTakeoverWriteJSON(t, fixture.oldPlanPath, plan)
			}
			return nil
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := fixture.manager.RecoverCurrent(ctx, fixture.executablePath, fixture.platformPath, fixture.recoverySHA); err == nil {
			t.Fatal("invalid old-plan checkpoint unexpectedly advanced")
		}
		state := activationTakeoverReadState(fixture.statePath)
		if !binaryMatches(fixture.stablePath, fixture.currentSHA) || state.Activation == nil ||
			state.Activation.PlanPath != fixture.oldPlanPath || state.Candidate == nil || state.Candidate.SHA256 != fixture.candidateSHA {
			t.Fatalf("stable C checkpoint acquired a recovery Activation: %#v", state)
		}
		fixture.mu.Lock()
		enabled := fixture.unitEnabled
		fixture.mu.Unlock()
		if enabled {
			t.Fatal("Manager unit fence opened at incomplete stable C checkpoint")
		}
		journal, exists, err := fixture.manager.readRecoveryTakeoverJournal(
			fixture.manager.recoveryTakeoverJournalPath(fixture.candidateCommit, fixture.recoverySHA),
		)
		if err != nil || !exists || journal.Phase != recoveryTakeoverStableCurrent {
			t.Fatalf("unexpected stable C journal checkpoint: %#v exists=%v err=%v", journal, exists, err)
		}
	})

	t.Run("stable R precedes recovery intent", func(t *testing.T) {
		fixture := newActivationTakeoverFixture(t)
		conflictingPlanPath := fixture.manager.currentRecoveryPlanPath(fixture.candidateCommit, fixture.recoverySHA)
		activationTakeoverWriteJSON(t, conflictingPlanPath, Plan{
			SchemaVersion: 1, Mode: recoveryActivationMode, PlanPath: conflictingPlanPath,
			RecoveryTransactionID: strings.Repeat("f", 64), CandidateSHA: fixture.recoverySHA,
		})
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := fixture.manager.RecoverCurrent(ctx, fixture.executablePath, fixture.platformPath, fixture.recoverySHA); err == nil {
			t.Fatal("conflicting recovery intent unexpectedly advanced")
		}
		state := activationTakeoverReadState(fixture.statePath)
		if !binaryMatches(fixture.stablePath, fixture.recoverySHA) || state.Activation != nil ||
			state.Candidate == nil || state.Candidate.SHA256 != fixture.candidateSHA {
			t.Fatalf("R was not stable before recovery intent persistence: %#v", state)
		}
		journal, exists, err := fixture.manager.readRecoveryTakeoverJournal(
			fixture.manager.recoveryTakeoverJournalPath(fixture.candidateCommit, fixture.recoverySHA),
		)
		if err != nil || !exists || journal.Phase != recoveryTakeoverActivationCleared {
			t.Fatalf("unexpected pre-intent journal checkpoint: %#v exists=%v err=%v", journal, exists, err)
		}
	})
}

func TestRecoverCurrentCompletesCommitAfterPlatformAlreadyFinalized(t *testing.T) {
	fixture := newActivationTakeoverFixture(t)
	journal := activationTakeoverPauseAtMainStarted(t, fixture)
	state := activationTakeoverReadState(fixture.statePath)
	if state.Current == nil || state.Candidate == nil || state.Activation == nil {
		t.Fatalf("missing recovery activation before simulated watchdog crash: %#v", state)
	}
	state.Previous = state.Current
	state.Current = state.Candidate
	state.Candidate = nil
	state.Activation = nil
	activationTakeoverWriteJSON(t, fixture.statePath, state)

	platform := fixture.originalPlatform
	platform.Generation++
	platform.PublicState = model.StateIdle
	platform.Maintenance = false
	platform.FinalizePendingOperationID = ""
	platform.UpdatedAt = platform.UpdatedAt.Add(time.Minute)
	activationTakeoverWriteJSON(t, fixture.platformPath, platform)
	operation := fixture.originalOperation
	operation.Finalized = true
	operation.ReservationReleased = true
	operation.UpdatedAt = operation.CompletedAt.Add(time.Second)
	activationTakeoverWriteJSON(t, fixture.operationPath, operation)

	before := activationTakeoverReadState(fixture.statePath)
	ctx, cancel := context.WithTimeout(context.Background(), 7*time.Second)
	defer cancel()
	if err := fixture.manager.RecoverCurrent(ctx, fixture.executablePath, fixture.platformPath, fixture.recoverySHA); err != nil {
		t.Fatal(err)
	}
	after := activationTakeoverReadState(fixture.statePath)
	if !reflect.DeepEqual(before, after) || after.Previous == nil || after.Previous.SHA256 != fixture.currentSHA {
		t.Fatalf("post-finalize metadata replay rotated Previous or rewrote state: before=%#v after=%#v", before, after)
	}
	_, plan, err := readRecoveryActivationPlan(journal.RecoveryPlanPath)
	if err != nil || plan.Status != "committed" {
		t.Fatalf("post-finalize replay did not complete plan: %#v err=%v", plan, err)
	}
	latest, exists, err := fixture.manager.readRecoveryTakeoverJournal(journal.Path)
	if err != nil || !exists || latest.Phase != recoveryTakeoverCommitted {
		t.Fatalf("post-finalize replay did not complete journal: %#v exists=%v err=%v", latest, exists, err)
	}
}

func TestRecoverCurrentConvergesRollbackAfterTerminalWriteBeforeServiceRestore(t *testing.T) {
	fixture := newActivationTakeoverFixture(t)
	journal := activationTakeoverPauseAtMainStarted(t, fixture)
	state := activationTakeoverReadState(fixture.statePath)
	_, plan, err := readRecoveryActivationPlan(state.Activation.PlanPath)
	if err != nil {
		t.Fatal(err)
	}
	plan.Error = "injected rollback before service enablement"
	fixture.mu.Lock()
	fixture.unitEnabled = false
	fixture.mu.Unlock()
	originalHook := fixture.runner.hook
	failEnable := true
	fixture.runner.hook = func(name string, arguments []string) error {
		if failEnable && name == "systemctl" && len(arguments) >= 3 && arguments[0] == "--user" && arguments[1] == "enable" {
			failEnable = false
			return errors.New("injected crash before rollback enablement")
		}
		return originalHook(name, arguments)
	}
	if err := restorePrevious(plan, fixture.runner); err == nil || !strings.Contains(err.Error(), "enablement failed") {
		t.Fatalf("unexpected interrupted rollback result: %v", err)
	}
	fixture.identity.set(false, "", "")
	checkpoint := activationTakeoverReadState(fixture.statePath)
	if checkpoint.Current == nil || checkpoint.Current.SHA256 != fixture.currentSHA || checkpoint.Candidate != nil || checkpoint.Activation != nil {
		t.Fatalf("rollback terminal checkpoint retained failed R activation: %#v", checkpoint)
	}
	latest, exists, err := fixture.manager.readRecoveryTakeoverJournal(journal.Path)
	if err != nil || !exists || latest.Phase != recoveryTakeoverRolledBack {
		t.Fatalf("rollback journal was not terminal before service restore: %#v exists=%v err=%v", latest, exists, err)
	}
	watchdogSpawns := fixture.runner.countCommand("systemd-run")
	ctx, cancel := context.WithTimeout(context.Background(), 7*time.Second)
	defer cancel()
	err = fixture.manager.RecoverCurrent(ctx, fixture.executablePath, fixture.platformPath, fixture.recoverySHA)
	if err == nil || !strings.Contains(err.Error(), "rolled back") {
		t.Fatalf("rollback replay did not report terminal rollback: %v", err)
	}
	fixture.mu.Lock()
	enabled := fixture.unitEnabled
	fixture.mu.Unlock()
	if !enabled || fixture.runner.countCommand("systemd-run") != watchdogSpawns {
		t.Fatalf("rollback replay entered activation instead of restoring C: enabled=%v calls=%#v", enabled, fixture.runner.snapshot())
	}
	checkpoint = activationTakeoverReadState(fixture.statePath)
	if checkpoint.Candidate != nil || checkpoint.Activation != nil || checkpoint.Current.SHA256 != fixture.currentSHA {
		t.Fatalf("rollback replay reintroduced failed Candidate R: %#v", checkpoint)
	}
}

func TestRecoveryHostRebootRearmsWatcherFromRecoveryArtifact(t *testing.T) {
	for _, outcome := range []string{recoveryTakeoverCommitted, recoveryTakeoverRolledBack} {
		t.Run(outcome, func(t *testing.T) {
			fixture := newActivationTakeoverFixture(t)
			journal := activationTakeoverPauseAtMainStarted(t, fixture)
			oldBootID := journal.InitialBootID
			newBootID := "boot-after-host-restart"
			fixture.manager.BootID = func() string { return newBootID }
			fixture.mu.Lock()
			fixture.activeUnits[journal.RecoveryWatchdogUnit] = false
			fixture.mu.Unlock()
			spawns := fixture.runner.countCommand("systemd-run")
			state := activationTakeoverReadState(fixture.statePath)
			if state.Candidate == nil {
				t.Fatal("missing recovery Candidate before reboot acknowledgement")
			}
			if err := fixture.manager.acknowledgeExecutable(state.Candidate.Path); err != nil {
				t.Fatalf("new-boot acknowledgement did not re-arm recovery watchdog: %v", err)
			}
			calls := fixture.runner.snapshot()
			if fixture.runner.countCommand("systemd-run") != spawns+1 ||
				!activationTakeoverHasWatchdogLaunch(calls, journal.RecoveryWatchdogUnit, journal.RecoveryPath, journal.RecoveryPlanPath) ||
				activationTakeoverHasWatchdogLaunch(calls, journal.RecoveryWatchdogUnit, journal.OriginalCurrent.Path, journal.RecoveryPlanPath) {
				t.Fatalf("reboot watchdog was not rebuilt exclusively from immutable R: %#v", calls)
			}
			latest, exists, err := fixture.manager.readRecoveryTakeoverJournal(journal.Path)
			if err != nil || !exists || latest.InitialBootID != oldBootID || oldBootID == newBootID {
				t.Fatalf("reboot changed immutable initial boot binding: %#v exists=%v err=%v", latest, exists, err)
			}
			_, plan, err := readRecoveryActivationPlan(journal.RecoveryPlanPath)
			if err != nil || plan.BootID != oldBootID {
				t.Fatalf("reboot changed immutable plan boot binding: %#v err=%v", plan, err)
			}
			switch outcome {
			case recoveryTakeoverCommitted:
				if err := commitActivation(plan.PlanPath, plan); err != nil {
					t.Fatalf("new-boot recovery watchdog could not commit: %v", err)
				}
				committed := activationTakeoverReadState(fixture.statePath)
				if committed.Current == nil || committed.Current.SHA256 != fixture.recoverySHA ||
					committed.Previous == nil || committed.Previous.SHA256 != fixture.currentSHA {
					t.Fatalf("new-boot watchdog committed wrong Current/Previous: %#v", committed)
				}
			case recoveryTakeoverRolledBack:
				plan.Error = "new-boot recovery health failure"
				if err := restorePrevious(plan, fixture.runner); err == nil || !strings.Contains(err.Error(), plan.Error) {
					t.Fatalf("new-boot recovery watchdog could not roll back: %v", err)
				}
				rolledBack := activationTakeoverReadState(fixture.statePath)
				if rolledBack.Current == nil || rolledBack.Current.SHA256 != fixture.currentSHA ||
					rolledBack.Candidate != nil || rolledBack.Activation != nil {
					t.Fatalf("new-boot watchdog rollback retained R: %#v", rolledBack)
				}
			}
		})
	}
}

func activationTakeoverPauseAtMainStarted(t *testing.T, fixture *activationTakeoverFixture) recoveryTakeoverJournal {
	t.Helper()
	fixture.setCommitBehavior(true, false)
	ctx, cancel := context.WithTimeout(context.Background(), 350*time.Millisecond)
	err := fixture.manager.RecoverCurrent(ctx, fixture.executablePath, fixture.platformPath, fixture.recoverySHA)
	cancel()
	if err == nil || !strings.Contains(err.Error(), "owned by its watchdog") {
		t.Fatalf("expected observer timeout at main_started, got %v", err)
	}
	journalPath := fixture.manager.recoveryTakeoverJournalPath(fixture.candidateCommit, fixture.recoverySHA)
	journal, exists, err := fixture.manager.readRecoveryTakeoverJournal(journalPath)
	if err != nil || !exists || journal.Phase != recoveryTakeoverMainStarted {
		t.Fatalf("takeover did not reach main_started: %#v exists=%v err=%v", journal, exists, err)
	}
	return journal
}

func activationTakeoverSHA(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func activationTakeoverImages() map[string]string {
	names := []string{
		"platform", "agent-runtime", "camofox", "agent-sandbox", "searxng",
		"firecrawl-api", "firecrawl-playwright", "firecrawl-postgres", "firecrawl-redis",
		"firecrawl-rabbitmq",
	}
	images := make(map[string]string, len(names))
	for index, name := range names {
		digit := "abcdef0123456789"[index%16]
		images[name] = "registry.example/" + name + "@sha256:" + strings.Repeat(string(digit), 64)
	}
	return images
}

func activationTakeoverArtifacts(source map[string]release.Artifact) map[string]release.Artifact {
	result := make(map[string]release.Artifact, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func activationTakeoverJournalTransactionID(journal recoveryTakeoverJournal) string {
	return recoveryTakeoverTransactionID(journal)
}

func activationTakeoverHasWatchdogLaunch(calls [][]string, unit, executable, planPath string) bool {
	for _, call := range calls {
		if len(call) == 11 && call[0] == "systemd-run" && call[1] == "--user" && call[2] == "--quiet" &&
			call[3] == "--collect" && call[4] == "--unit" && call[5] == unit && call[6] == "--property=Type=exec" &&
			call[7] == executable && call[8] == "self-update-watchdog" && call[9] == "--plan" && call[10] == planPath {
			return true
		}
	}
	return false
}

func activationTakeoverWriteJSON(t *testing.T, path string, value any) {
	t.Helper()
	if err := atomicfile.WriteJSON(path, value, 0o600); err != nil {
		t.Fatal(err)
	}
}

func activationTakeoverReadState(path string) State {
	var state State
	if err := atomicfile.ReadJSON(path, &state); err != nil {
		panic(err)
	}
	return state
}

func activationTakeoverFileSHA(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return activationTakeoverSHA(data)
}

func activationTakeoverAssertFiles(t *testing.T, expected map[string][]byte) {
	t.Helper()
	for path, want := range expected {
		got, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read preserved file %s: %v", path, err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("recovery unexpectedly mutated %s", path)
		}
	}
}
