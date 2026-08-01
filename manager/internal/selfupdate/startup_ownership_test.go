package selfupdate

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

const startupPrepareProbeEnvironment = "UBITECH_STARTUP_PREPARE_PROBE"

func TestMain(m *testing.M) {
	if os.Getenv(startupPrepareProbeEnvironment) == "1" && len(os.Args) == 2 && os.Args[1] == "version" {
		fmt.Println("startup-ownership-test-manager")
		os.Exit(0)
	}
	os.Exit(m.Run())
}

type startupOwnershipFixture struct {
	manager      *Manager
	stateDir     string
	statePath    string
	platformPath string
	stablePath   string
	current      Version
	running      []byte
	runningSHA   string
}

func newStartupOwnershipFixture(t *testing.T) *startupOwnershipFixture {
	t.Helper()
	base := t.TempDir()
	stateDir := filepath.Join(base, "manager")
	root := filepath.Join(stateDir, "manager-binaries")
	for _, directory := range []string{
		stateDir, root, filepath.Join(root, "versions"), filepath.Join(root, "activations"),
		filepath.Join(stateDir, "operations"), filepath.Join(stateDir, "releases"), filepath.Join(stateDir, "secrets"),
	} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	running, err := os.ReadFile("/proc/self/exe")
	if err != nil {
		t.Fatal(err)
	}
	runningSHA := sha256Hex(running)
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	current := Version{
		Version: strings.Repeat("a", 40), SourceCommit: strings.Repeat("0", 40),
		Path:   filepath.Join(root, "versions", "running-"+runningSHA[:12], "ubitech-manager"),
		SHA256: runningSHA, VerifiedAt: now, PlatformCommitted: true,
	}
	writeStartupVersion(t, current, running, current)
	stablePath := filepath.Join(base, "bin", "ubitech-manager")
	if err := atomicfile.WriteFile(stablePath, running, 0o755); err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(stateDir, "manager-binaries.json")
	writeStartupJSON(t, statePath, State{SchemaVersion: 1, Current: &current, UpdatedAt: now})
	tokenPath := filepath.Join(stateDir, "secrets", "manager-token")
	if err := atomicfile.WriteFile(tokenPath, []byte("0123456789abcdef0123456789abcdef\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return &startupOwnershipFixture{
		manager: &Manager{Profile: testActiveProfile,
			ConfigPath: filepath.Join(base, "config", "manager.toml"),
			Root:       root, StatePath: statePath, InstallPath: stablePath,
			SocketPath: filepath.Join(stateDir, "control", "manager.sock"), ControlTokenFile: tokenPath,
			UnitName: "ubitech-agent-manager.service", RunningVersion: current.Version,
		},
		stateDir: stateDir, statePath: statePath, platformPath: filepath.Join(stateDir, "state.json"),
		stablePath: stablePath, current: current, running: running, runningSHA: runningSHA,
	}
}

func writeStartupVersion(t *testing.T, version Version, binary []byte, metadata Version) {
	t.Helper()
	if err := atomicfile.WriteFile(version.Path, binary, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := atomicfile.WriteJSON(filepath.Join(filepath.Dir(version.Path), "metadata.json"), metadata, 0o600); err != nil {
		t.Fatal(err)
	}
}

func writeStartupJSON(t *testing.T, path string, value any) {
	t.Helper()
	if err := atomicfile.WriteJSON(path, value, 0o600); err != nil {
		t.Fatal(err)
	}
}

func (f *startupOwnershipFixture) installPreparedCandidate(t *testing.T, committed bool) (Version, release.Manifest, model.Operation) {
	t.Helper()
	now := f.current.VerifiedAt.Add(time.Minute)
	commit := strings.Repeat("b", 40)
	candidateBinary := []byte("immutable prepared Manager candidate\n")
	candidateSHA := sha256Hex(candidateBinary)
	candidate := Version{
		Version: commit, SourceCommit: commit,
		Path:   filepath.Join(f.manager.Root, "versions", safeID(commit+"-"+commit[:12]), "ubitech-manager"),
		SHA256: candidateSHA, VerifiedAt: now, PlatformCommitted: committed,
	}
	metadata := candidate
	metadata.PlatformCommitted = false // MarkPlatformCommitted mutates state, not immutable metadata.
	writeStartupVersion(t, candidate, candidateBinary, metadata)
	state := State{SchemaVersion: 1, Current: &f.current, Candidate: &candidate, UpdatedAt: now}
	writeStartupJSON(t, f.statePath, state)

	images := activationTakeoverImages()
	manifestPath := filepath.Join(f.stateDir, "releases", commit, "manifest.json")
	manifest := release.Manifest{
		SchemaVersion: contract.SchemaVersion, Channel: contract.ReleaseChannel, SourceCommit: commit,
		GeneratedAt: now, ProtocolVersion: contract.SchemaVersion, DatabaseSchemaVersion: contract.DatabaseSchemaVersion,
		Manager: release.ManagerRelease{Version: candidate.Version, Artifacts: map[string]release.Artifact{
			runtime.GOARCH: {URL: "http://127.0.0.1/manager", SHA256: candidate.SHA256},
		}},
		Compose: release.Artifact{URL: "http://127.0.0.1/compose", SHA256: strings.Repeat("c", 64)}, Images: images,
	}
	writeStartupJSON(t, manifestPath, manifest)
	operationID := "op_startup_owner_1234567890"
	operationPath := filepath.Join(f.stateDir, "operations", operationID+".json")
	operation := model.Operation{
		SchemaVersion: 1, ID: operationID, Kind: model.OperationUpdate, IdempotencyKey: "startup-owner",
		Attempt: 1, ExpectedGeneration: 7, TargetGeneration: commit, Status: model.OperationRunning,
		Phase: model.PhasePulling, CreatedAt: now, UpdatedAt: now.Add(time.Second),
	}
	platform := model.NewState(now)
	platform.Generation = 8
	platform.PublicState = model.StateIdle
	platform.Phase = model.PhasePulling
	platform.ActiveOperationID = operationID
	platform.Current = &model.Generation{ID: f.current.SourceCommit, SourceCommit: f.current.SourceCommit}
	platform.Candidate = &model.Generation{
		ID: commit, SourceCommit: commit, ManifestPath: manifestPath,
		DatabaseVersion: manifest.DatabaseSchemaVersion, Images: images,
	}
	if committed {
		completedAt := now.Add(2 * time.Second)
		rollbackPath := filepath.Join(f.stateDir, "backups", "before-startup")
		platform.Current = &model.Generation{
			ID: commit, SourceCommit: commit, ManifestPath: manifestPath,
			DatabaseVersion: manifest.DatabaseSchemaVersion, Images: images,
			RollbackSnapshotPath: rollbackPath, ActivatedAt: completedAt,
		}
		platform.Candidate = nil
		platform.ActiveOperationID = ""
		platform.FinalizePendingOperationID = operationID
		platform.PublicState = model.StateUpdating
		platform.Phase = ""
		platform.Maintenance = true
		operation.Status = model.OperationSucceeded
		operation.Phase = model.PhaseCommitting
		operation.ReservationStatus = model.ReservationMutationStarted
		operation.SnapshotPath = rollbackPath
		operation.UpdatedAt = now.Add(time.Second)
		operation.CompletedAt = &completedAt
	}
	writeStartupJSON(t, operationPath, operation)
	writeStartupJSON(t, f.platformPath, platform)
	return candidate, manifest, operation
}

func (f *startupOwnershipFixture) ordinaryPlan(candidate Version, status string) Plan {
	now := candidate.VerifiedAt.Add(time.Second)
	return Plan{
		SchemaVersion: 1, PlanPath: filepath.Join(f.manager.Root, "activations", candidate.SourceCommit+".json"),
		Status: status, StatePath: f.statePath, InstallPath: f.stablePath,
		SocketPath: f.manager.SocketPath, ControlTokenFile: f.manager.ControlTokenFile, UnitName: f.manager.UnitName,
		CandidateVersion: candidate.Version, CandidateSHA: candidate.SHA256, CandidatePath: candidate.Path,
		PlatformCommit: candidate.SourceCommit, PreviousPath: f.current.Path,
		CreatedAt: now, UpdatedAt: now, HealthTimeoutMS: 45_000, BootID: "boot-startup-owner",
	}
}

func startupOwnershipManifest(t *testing.T, binary []byte, commit string) (release.Manifest, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_, _ = response.Write(binary)
	}))
	manifest := release.Manifest{
		SchemaVersion: contract.SchemaVersion, Channel: contract.ReleaseChannel, SourceCommit: commit,
		GeneratedAt: time.Date(2026, 7, 30, 13, 0, 0, 0, time.UTC), ProtocolVersion: contract.SchemaVersion,
		DatabaseSchemaVersion: contract.DatabaseSchemaVersion,
		Manager: release.ManagerRelease{Version: commit, Artifacts: map[string]release.Artifact{
			runtime.GOARCH: {URL: server.URL, SHA256: sha256Hex(binary)},
		}},
		Compose: release.Artifact{URL: "http://127.0.0.1/compose", SHA256: strings.Repeat("f", 64)},
		Images:  activationTakeoverImages(),
	}
	return manifest, server
}

func writeStartupActivePlatformEvidence(t *testing.T, manager *Manager, candidate Version, manifest release.Manifest) {
	t.Helper()
	stateDir := filepath.Dir(manager.StatePath)
	now := manifest.GeneratedAt
	manifestPath := filepath.Join(stateDir, "releases", candidate.SourceCommit, "manifest.json")
	operationID := "op_real_prepare_startup_owner"
	if err := os.MkdirAll(filepath.Join(stateDir, "operations"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeStartupJSON(t, manifestPath, manifest)
	writeStartupJSON(t, filepath.Join(stateDir, "operations", operationID+".json"), model.Operation{
		SchemaVersion: 1, ID: operationID, Kind: model.OperationUpdate, IdempotencyKey: "real-prepare",
		Attempt: 1, ExpectedGeneration: 4, TargetGeneration: candidate.SourceCommit,
		Status: model.OperationRunning, Phase: model.PhasePulling, CreatedAt: now, UpdatedAt: now.Add(time.Second),
	})
	platform := model.NewState(now)
	platform.Generation = 5
	platform.PublicState = model.StateIdle
	platform.Phase = model.PhasePulling
	platform.ActiveOperationID = operationID
	platform.Candidate = &model.Generation{
		ID: candidate.SourceCommit, SourceCommit: candidate.SourceCommit, ManifestPath: manifestPath,
		DatabaseVersion: manifest.DatabaseSchemaVersion, Images: manifest.Images,
	}
	writeStartupJSON(t, filepath.Join(stateDir, "state.json"), platform)
}

func writeStartupFinalizePlatformEvidence(t *testing.T, manager *Manager, candidate Version, manifest release.Manifest) {
	t.Helper()
	stateDir := filepath.Dir(manager.StatePath)
	now := manifest.GeneratedAt
	updatedAt := now.Add(time.Second)
	completedAt := now.Add(2 * time.Second)
	manifestPath := filepath.Join(stateDir, "releases", candidate.SourceCommit, "manifest.json")
	operationID := "op_real_mark_startup_owner"
	rollbackPath := filepath.Join(stateDir, "backups", "before-real-mark")
	if err := os.MkdirAll(filepath.Join(stateDir, "operations"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeStartupJSON(t, manifestPath, manifest)
	writeStartupJSON(t, filepath.Join(stateDir, "operations", operationID+".json"), model.Operation{
		SchemaVersion: 1, ID: operationID, Kind: model.OperationUpdate, IdempotencyKey: "real-mark",
		Attempt: 1, ExpectedGeneration: 4, TargetGeneration: candidate.SourceCommit,
		Status: model.OperationSucceeded, Phase: model.PhaseCommitting, ReservationStatus: model.ReservationMutationStarted,
		SnapshotPath: rollbackPath, CreatedAt: now, UpdatedAt: updatedAt, CompletedAt: &completedAt,
	})
	platform := model.NewState(now)
	platform.Generation = 5
	platform.PublicState = model.StateUpdating
	platform.Maintenance = true
	platform.FinalizePendingOperationID = operationID
	platform.Current = &model.Generation{
		ID: candidate.SourceCommit, SourceCommit: candidate.SourceCommit, ManifestPath: manifestPath,
		DatabaseVersion: manifest.DatabaseSchemaVersion, Images: manifest.Images,
		RollbackSnapshotPath: rollbackPath, ActivatedAt: completedAt,
	}
	writeStartupJSON(t, filepath.Join(stateDir, "state.json"), platform)
}

func TestStartupOwnershipPreparedCandidateRequiresExactLiveOwner(t *testing.T) {
	fixture := newStartupOwnershipFixture(t)
	candidate, _, _ := fixture.installPreparedCandidate(t, false)
	if err := fixture.manager.ValidateStartupOwnership(); err != nil {
		t.Fatalf("exact Prepare checkpoint was rejected: %v", err)
	}

	plan := fixture.ordinaryPlan(candidate, ordinaryRolledBackStatus)
	plan.Error = "candidate was rejected"
	writeStartupJSON(t, plan.PlanPath, plan)
	if err := fixture.manager.ValidateStartupOwnership(); err == nil || !strings.Contains(err.Error(), "terminal plan") {
		t.Fatalf("ownerless terminal Candidate checkpoint was accepted: %v", err)
	}
}

func TestStartupOwnershipPreparedCandidateReservationBoundaries(t *testing.T) {
	tests := []struct {
		name        string
		status      model.OperationStatus
		phase       model.OperationPhase
		reservation model.ReservationStatus
		kind        model.OperationKind
		public      model.PublicState
		maintenance bool
		fresh       bool
		want        bool
	}{
		{name: "pending validation", status: model.OperationPending, phase: model.PhaseValidating, kind: model.OperationUpdate, public: model.StateIdle, want: true},
		{name: "pre-reservation draining", status: model.OperationRunning, phase: model.PhaseDraining, kind: model.OperationUpdate, public: model.StateWaitingForTasks, want: true},
		{name: "confirmation intent before state projection", status: model.OperationRunning, phase: model.PhaseDraining, reservation: model.ReservationConfirmationPending, kind: model.OperationUpdate, public: model.StateWaitingForTasks, want: true},
		{name: "confirmation intent reserved", status: model.OperationRunning, phase: model.PhaseDraining, reservation: model.ReservationConfirmationPending, kind: model.OperationUpdate, public: model.StateUpdating, maintenance: true, want: true},
		{name: "confirmed reservation", status: model.OperationRunning, phase: model.PhaseDraining, reservation: model.ReservationConfirmed, kind: model.OperationUpdate, public: model.StateUpdating, maintenance: true, want: true},
		{name: "mutation started", status: model.OperationRunning, phase: model.PhaseDraining, reservation: model.ReservationMutationStarted, kind: model.OperationUpdate, public: model.StateUpdating, maintenance: true, want: true},
		{name: "release uncertain", status: model.OperationRunning, phase: model.PhaseDraining, reservation: model.ReservationReleaseUncertain, kind: model.OperationUpdate, public: model.StateFailed, maintenance: true, want: true},
		{name: "fresh install draining", status: model.OperationRunning, phase: model.PhaseDraining, kind: model.OperationInstall, public: model.StateUpdating, maintenance: true, fresh: true, want: true},
		{name: "confirmed but not fail closed", status: model.OperationRunning, phase: model.PhaseDraining, reservation: model.ReservationConfirmed, kind: model.OperationUpdate, public: model.StateWaitingForTasks, want: false},
		{name: "mutation but not fail closed", status: model.OperationRunning, phase: model.PhaseDraining, reservation: model.ReservationMutationStarted, kind: model.OperationUpdate, public: model.StateWaitingForTasks, want: false},
		{name: "uncertainty projected as updating", status: model.OperationRunning, phase: model.PhaseDraining, reservation: model.ReservationReleaseUncertain, kind: model.OperationUpdate, public: model.StateUpdating, maintenance: true, want: false},
		{name: "update maintenance without reservation", status: model.OperationRunning, phase: model.PhaseDraining, kind: model.OperationUpdate, public: model.StateUpdating, maintenance: true, want: false},
		{name: "confirmation projected failed", status: model.OperationRunning, phase: model.PhaseDraining, reservation: model.ReservationConfirmationPending, kind: model.OperationUpdate, public: model.StateFailed, maintenance: true, want: false},
		{name: "pending with reservation", status: model.OperationPending, phase: model.PhaseValidating, reservation: model.ReservationConfirmationPending, kind: model.OperationUpdate, public: model.StateIdle, want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newStartupOwnershipFixture(t)
			_, _, operation := fixture.installPreparedCandidate(t, false)
			var platform model.ManagerState
			if err := atomicfile.ReadJSON(fixture.platformPath, &platform); err != nil {
				t.Fatal(err)
			}
			operation.Status = test.status
			operation.Phase = test.phase
			operation.Kind = test.kind
			operation.ReservationStatus = test.reservation
			platform.Phase = test.phase
			platform.PublicState = test.public
			platform.Maintenance = test.maintenance
			if test.fresh {
				platform.Current = nil
			}
			writeStartupJSON(t, filepath.Join(fixture.stateDir, "operations", operation.ID+".json"), operation)
			writeStartupJSON(t, fixture.platformPath, platform)
			err := fixture.manager.ValidateStartupOwnership()
			if test.want && err != nil {
				t.Fatalf("valid reservation checkpoint was rejected: %v", err)
			}
			if !test.want && err == nil {
				t.Fatal("invalid reservation checkpoint was admitted")
			}
		})
	}
}

func TestStartupOwnershipCommittedCandidateUsesFinalizeEvidenceNotMutableMetadata(t *testing.T) {
	fixture := newStartupOwnershipFixture(t)
	fixture.installPreparedCandidate(t, true)
	if err := fixture.manager.ValidateStartupOwnership(); err != nil {
		t.Fatalf("Prepare -> MarkPlatformCommitted checkpoint was rejected: %v", err)
	}
}

func TestStartupOwnershipRealPrepareMarkRestartUsesImmutableMetadataFields(t *testing.T) {
	fixture := newStartupOwnershipFixture(t)
	commit := strings.Repeat("6", 40)
	manifest, server := startupOwnershipManifest(t, fixture.running, commit)
	defer server.Close()
	fixture.manager.Client = release.Client{HTTP: server.Client()}
	fixture.manager.Now = func() time.Time { return manifest.GeneratedAt }
	t.Setenv(startupPrepareProbeEnvironment, "1")
	if err := fixture.manager.Prepare(context.Background(), manifest); err != nil {
		t.Fatalf("real Prepare: %v", err)
	}
	if err := fixture.manager.MarkPlatformCommitted(manifest); err != nil {
		t.Fatalf("real MarkPlatformCommitted: %v", err)
	}
	state, err := fixture.manager.State()
	if err != nil || state.Candidate == nil || !state.Candidate.PlatformCommitted {
		t.Fatalf("real Prepare/Mark state = %#v, err=%v", state, err)
	}
	var metadata Version
	if err := atomicfile.ReadJSON(filepath.Join(filepath.Dir(state.Candidate.Path), "metadata.json"), &metadata); err != nil {
		t.Fatal(err)
	}
	if metadata.PlatformCommitted {
		t.Fatal("test no longer covers state-only PlatformCommitted mutation")
	}
	writeStartupFinalizePlatformEvidence(t, fixture.manager, *state.Candidate, manifest)
	if err := fixture.manager.ValidateStartupOwnership(); err != nil {
		t.Fatalf("restart rejected real Prepare -> MarkPlatformCommitted checkpoint: %v", err)
	}
}

func TestStartupOwnershipRecoveredCurrentCanRestartAndOwnNextRealPrepare(t *testing.T) {
	fixture := newRecoveryFixture(t)
	running, err := os.ReadFile("/proc/self/exe")
	if err != nil {
		t.Fatal(err)
	}
	fixture.newBinary = running
	fixture.newSHA = sha256Hex(running)
	if err := atomicfile.WriteFile(fixture.executablePath, running, 0o700); err != nil {
		t.Fatal(err)
	}
	fixture.identity.set(false, "", "")
	fixture.runner.onRun = func(name string, arguments []string) {
		if name == "systemctl" && len(arguments) >= 3 && arguments[1] == "start" {
			stable, readErr := os.ReadFile(fixture.manager.InstallPath)
			if readErr == nil && sha256Hex(stable) == fixture.newSHA {
				fixture.identity.set(true, fixture.manager.RunningVersion, fixture.newSHA)
			} else {
				fixture.identity.set(false, "", "")
			}
		}
	}
	fixture.manager.RecoveryProcessVerifier = func(_ context.Context, unit, stable, expectedSHA string) error {
		if unit != fixture.manager.UnitName || stable != fixture.manager.InstallPath || expectedSHA != fixture.newSHA {
			return errors.New("unexpected recovered service identity")
		}
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if err := fixture.manager.RecoverCurrent(ctx, fixture.executablePath, fixture.platformPath, fixture.newSHA); err != nil {
		t.Fatalf("real RecoverCurrent protocol: %v", err)
	}
	if err := fixture.manager.ValidateStartupOwnership(); err != nil {
		t.Fatalf("recovered Current restart was rejected: %v", err)
	}
	state, err := fixture.manager.State()
	if err != nil || state.Current == nil {
		t.Fatalf("read recovered Current: %#v, err=%v", state, err)
	}
	if currentDirectory := filepath.Base(filepath.Dir(state.Current.Path)); currentDirectory != "recovery-"+state.Current.SHA256[:12] {
		t.Fatalf("recovered Current directory = %q, want digest-bound recovery identity", currentDirectory)
	}
	if state.Previous == nil || filepath.Base(filepath.Dir(state.Previous.Path)) != "running-"+state.Previous.SHA256[:12] {
		t.Fatalf("recovered Previous does not retain its digest-bound managed identity: %#v", state.Previous)
	}
	var recoveryMetadata Version
	if err := atomicfile.ReadJSON(filepath.Join(filepath.Dir(state.Current.Path), "metadata.json"), &recoveryMetadata); err != nil {
		t.Fatal(err)
	}
	if recoveryMetadata.SourceCommit != "" || state.Current.SourceCommit == "" {
		t.Fatalf("test lost recovered metadata/state provenance distinction: metadata=%#v state=%#v", recoveryMetadata, state.Current)
	}

	nextCommit := strings.Repeat("7", 40)
	manifest, server := startupOwnershipManifest(t, running, nextCommit)
	defer server.Close()
	fixture.manager.Client = release.Client{HTTP: server.Client()}
	t.Setenv(startupPrepareProbeEnvironment, "1")
	if err := fixture.manager.Prepare(context.Background(), manifest); err != nil {
		t.Fatalf("real Prepare after recovered Current: %v", err)
	}
	state, err = fixture.manager.State()
	if err != nil || state.Candidate == nil {
		t.Fatalf("next prepared Candidate = %#v, err=%v", state, err)
	}
	writeStartupActivePlatformEvidence(t, fixture.manager, *state.Candidate, manifest)
	if err := fixture.manager.ValidateStartupOwnership(); err != nil {
		t.Fatalf("recovered Current plus next real Prepare was rejected: %v", err)
	}
}

func TestStartupOwnershipAdmitsOrdinaryRollbackPlanFirstHalfCheckpoint(t *testing.T) {
	fixture := newStartupOwnershipFixture(t)
	candidate, _, _ := fixture.installPreparedCandidate(t, true)
	plan := fixture.ordinaryPlan(candidate, ordinaryRolledBackStatus)
	plan.Activated = true
	plan.Error = "watchdog restored registered Current"
	writeStartupJSON(t, plan.PlanPath, plan)
	state := State{
		SchemaVersion: 1, Current: &fixture.current, Candidate: &candidate,
		Activation: &Activation{
			PlanPath: plan.PlanPath, CandidateSHA: candidate.SHA256,
			CandidatePath: candidate.Path, StartedAt: plan.CreatedAt.Add(time.Second),
		},
		UpdatedAt: plan.UpdatedAt,
	}
	writeStartupJSON(t, fixture.statePath, state)
	if err := fixture.manager.ValidateStartupOwnership(); err != nil {
		t.Fatalf("exact ordinary rollback half-checkpoint was rejected: %v", err)
	}
	if err := fixture.manager.AcknowledgeStartup(); err != nil {
		t.Fatalf("ordinary rollback half-checkpoint did not settle: %v", err)
	}
	_, settled, err := readRecoverySelfUpdateState(fixture.statePath)
	if err != nil || settled.Candidate != nil || settled.Activation != nil || settled.Current == nil || settled.Current.SHA256 != fixture.current.SHA256 {
		t.Fatalf("ordinary rollback settlement = %#v, err=%v", settled, err)
	}
}

func TestStartupOwnershipRejectsTamperedOrdinaryRollbackHalfCandidate(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Version, *Activation, *Plan)
	}{
		{name: "platform commit flag", mutate: func(candidate *Version, _ *Activation, _ *Plan) {
			candidate.PlatformCommitted = false
		}},
		{name: "empty version", mutate: func(candidate *Version, _ *Activation, plan *Plan) {
			candidate.Version = ""
			plan.CandidateVersion = ""
		}},
		{name: "invalid source commit", mutate: func(candidate *Version, _ *Activation, plan *Plan) {
			candidate.SourceCommit = "invalid"
			plan.PlatformCommit = "invalid"
		}},
		{name: "invalid sha", mutate: func(candidate *Version, activation *Activation, plan *Plan) {
			candidate.SHA256 = "invalid"
			activation.CandidateSHA = "invalid"
			plan.CandidateSHA = "invalid"
		}},
		{name: "zero verification time", mutate: func(candidate *Version, _ *Activation, _ *Plan) {
			candidate.VerifiedAt = time.Time{}
		}},
		{name: "inexact managed candidate path", mutate: func(candidate *Version, activation *Activation, plan *Plan) {
			candidate.Path = filepath.Join(filepath.Dir(filepath.Dir(candidate.Path)), "other", "ubitech-manager")
			activation.CandidatePath = candidate.Path
			plan.CandidatePath = candidate.Path
		}},
		{name: "inexact activation plan path", mutate: func(_ *Version, activation *Activation, plan *Plan) {
			plan.PlanPath = filepath.Join(filepath.Dir(plan.PlanPath), "other.json")
			activation.PlanPath = plan.PlanPath
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newStartupOwnershipFixture(t)
			candidate, _, _ := fixture.installPreparedCandidate(t, true)
			plan := fixture.ordinaryPlan(candidate, ordinaryRolledBackStatus)
			plan.Activated = true
			plan.Error = "watchdog restored registered Current"
			activation := Activation{
				PlanPath: plan.PlanPath, CandidateSHA: candidate.SHA256,
				CandidatePath: candidate.Path, StartedAt: plan.CreatedAt.Add(time.Second),
			}
			test.mutate(&candidate, &activation, &plan)
			writeStartupJSON(t, plan.PlanPath, plan)
			state := State{
				SchemaVersion: 1, Current: &fixture.current, Candidate: &candidate,
				Activation: &activation, UpdatedAt: plan.UpdatedAt,
			}
			writeStartupJSON(t, fixture.statePath, state)
			before, err := os.ReadFile(fixture.statePath)
			if err != nil {
				t.Fatal(err)
			}
			if err := fixture.manager.ValidateStartupOwnership(); err == nil {
				t.Fatal("tampered ordinary rollback half-checkpoint was accepted")
			}
			after, err := os.ReadFile(fixture.statePath)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(before, after) {
				t.Fatal("rollback-half refusal mutated Manager state")
			}
		})
	}
}

func TestStartupOwnershipAdmitsOnlyExactOrdinaryStateFirstCommitCheckpoint(t *testing.T) {
	fixture := newStartupOwnershipFixture(t)
	commit := strings.Repeat("8", 40)
	now := fixture.current.VerifiedAt.Add(time.Hour)
	current := Version{
		Version: commit, SourceCommit: commit,
		Path:   filepath.Join(fixture.manager.Root, "versions", safeID(commit+"-"+commit[:12]), "ubitech-manager"),
		SHA256: fixture.runningSHA, VerifiedAt: now, PlatformCommitted: true,
	}
	writeStartupVersion(t, current, fixture.running, current)
	state := State{
		SchemaVersion: 1, Current: &current, Previous: &fixture.current, UpdatedAt: now,
	}
	writeStartupJSON(t, fixture.statePath, state)
	fixture.manager.RunningVersion = current.Version
	plan := Plan{
		SchemaVersion: 1, PlanPath: filepath.Join(fixture.manager.Root, "activations", commit+".json"),
		Status: "acknowledged", StatePath: fixture.statePath, InstallPath: fixture.stablePath,
		SocketPath: fixture.manager.SocketPath, ControlTokenFile: fixture.manager.ControlTokenFile, UnitName: fixture.manager.UnitName,
		CandidateVersion: current.Version, CandidateSHA: current.SHA256, CandidatePath: current.Path,
		PlatformCommit: current.SourceCommit, PreviousPath: fixture.current.Path,
		Activated: true, Acknowledged: true, CreatedAt: now.Add(-time.Minute), UpdatedAt: now,
		HealthTimeoutMS: 45_000, BootID: "boot-state-first-commit",
	}
	writeStartupJSON(t, plan.PlanPath, plan)
	if err := fixture.manager.ValidateStartupOwnership(); err != nil {
		t.Fatalf("exact acknowledged state-first commit checkpoint was rejected: %v", err)
	}
	manifest := release.Manifest{
		SourceCommit: commit,
		Manager: release.ManagerRelease{Version: current.Version, Artifacts: map[string]release.Artifact{
			runtime.GOARCH: {SHA256: current.SHA256},
		}},
	}
	committed, err := fixture.manager.ActivationCommitted(manifest)
	if err != nil || !committed {
		t.Fatalf("restart barrier did not terminalize state-first checkpoint: committed=%v err=%v", committed, err)
	}
	_, terminal, err := readRecoveryActivationPlan(plan.PlanPath)
	if err != nil || terminal.Status != "committed" {
		t.Fatalf("state-first plan terminal = %#v, err=%v", terminal, err)
	}

	plan.CandidateSHA = strings.Repeat("f", 64)
	writeStartupJSON(t, plan.PlanPath, plan)
	if err := fixture.manager.ValidateStartupOwnership(); err == nil || !strings.Contains(err.Error(), "exactly match") {
		t.Fatalf("mismatched acknowledged state-first checkpoint was accepted: %v", err)
	}
}

func startupActiveRecoveryFixture(t *testing.T) (*activationTakeoverFixture, recoveryTakeoverJournal) {
	t.Helper()
	fixture := newActivationTakeoverFixture(t)
	running, err := os.ReadFile("/proc/self/exe")
	if err != nil {
		t.Fatal(err)
	}
	fixture.recoveryBinary = running
	fixture.recoverySHA = sha256Hex(running)
	if err := atomicfile.WriteFile(fixture.executablePath, running, 0o700); err != nil {
		t.Fatal(err)
	}
	fixture.identity.set(true, fixture.recoveryCommit, fixture.recoverySHA)
	journal := activationTakeoverPauseAtMainStarted(t, fixture)
	return fixture, journal
}

func TestStartupOwnershipClassifiesWatchdogOwnedRecoveryCandidate(t *testing.T) {
	fixture, journal := startupActiveRecoveryFixture(t)
	lease, err := fixture.manager.AcquireStartupOwnership()
	if err != nil {
		t.Fatalf("free-lock recovery Candidate was rejected: %v", err)
	}
	if !lease.RetainsRecoveryLock() || lease.ExternalRecoveryProbe() || lease.RecoveryCandidate() {
		t.Fatalf("free-lock admission did not retain normal lease: %#v", lease)
	}
	lease.Release()

	releaseGlobal, err := acquireRecoveryLock(fixture.manager.Root)
	if err != nil {
		t.Fatal(err)
	}
	defer releaseGlobal()
	lease, err = fixture.manager.AcquireStartupOwnership()
	if err != nil {
		t.Fatalf("externally protected recovery Candidate was rejected: %v", err)
	}
	if !lease.RecoveryCandidate() || lease.ExternalRecoveryProbe() || lease.RetainsRecoveryLock() {
		t.Fatalf("watchdog-owned Candidate was misclassified as probe-only: %#v", lease)
	}
	if err := fixture.manager.AcknowledgeStartup(); err != nil {
		t.Fatalf("externally protected recovery Candidate did not run pending acknowledgement: %v", err)
	}
	_, acknowledged, err := readRecoveryActivationPlan(journal.RecoveryPlanPath)
	if err != nil || acknowledged.Status != "acknowledged" || !acknowledged.Acknowledged {
		t.Fatalf("recovery Candidate acknowledgement = %#v, err=%v", acknowledged, err)
	}

	releaseJournal, busy, err := tryStartupRecoveryJournalLock(journal.Path + ".lock")
	if err != nil || busy || releaseJournal == nil {
		t.Fatalf("hold recovery mutation lock: busy=%v err=%v", busy, err)
	}
	defer releaseJournal()
	lease, err = fixture.manager.AcquireStartupOwnership()
	if err != nil || !lease.RecoveryCandidate() {
		t.Fatalf("busy journal deadlocked or lost exact Candidate classification: lease=%#v err=%v", lease, err)
	}
}

func TestStartupOwnershipRejectsPreWatchdogJournalWithoutMutation(t *testing.T) {
	fixture, journal := startupActiveRecoveryFixture(t)
	journal.Phase = recoveryTakeoverPrepared
	journal.UpdatedAt = journal.UpdatedAt.Add(time.Second)
	if err := fixture.manager.persistRecoveryTakeoverJournal(journal); err != nil {
		t.Fatal(err)
	}
	paths := []string{fixture.statePath, fixture.oldPlanPath, fixture.stablePath, journal.Path, journal.RecoveryPlanPath}
	before := make(map[string][]byte, len(paths))
	for _, path := range paths {
		before[path], _ = os.ReadFile(path)
	}
	calls := fixture.runner.snapshot()
	err := fixture.manager.ValidateStartupOwnership()
	if err == nil || !strings.Contains(err.Error(), "externally owned") {
		t.Fatalf("pre-watchdog journal was admitted: %v", err)
	}
	for path, expected := range before {
		actual, readErr := os.ReadFile(path)
		if readErr != nil || !reflect.DeepEqual(actual, expected) {
			t.Fatalf("startup refusal mutated %s: err=%v", path, readErr)
		}
	}
	if !reflect.DeepEqual(fixture.runner.snapshot(), calls) {
		t.Fatal("startup ownership refusal invoked the recovery runner")
	}
}

func TestStartupOwnershipTerminalJournalSurvivesLaterArtifactPruning(t *testing.T) {
	fixture, journal := startupActiveRecoveryFixture(t)
	if err := fixture.manager.AcknowledgeStartup(); err != nil {
		t.Fatal(err)
	}
	_, plan, err := readRecoveryActivationPlan(journal.RecoveryPlanPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := commitActivation(testActiveProfile, plan.PlanPath, plan); err != nil {
		t.Fatalf("commit recovery activation fixture: %v", err)
	}
	if err := fixture.manager.ValidateStartupOwnership(); err != nil {
		t.Fatalf("direct committed recovery restart was rejected: %v", err)
	}

	later := Version{
		Version: fixture.manager.RunningVersion, SourceCommit: strings.Repeat("9", 40),
		Path:   filepath.Join(fixture.manager.Root, "versions", "running-"+fixture.recoverySHA[:12], "ubitech-manager"),
		SHA256: fixture.recoverySHA, VerifiedAt: time.Now().UTC(), PlatformCommitted: true,
	}
	writeStartupVersion(t, later, fixture.recoveryBinary, later)
	writeStartupJSON(t, fixture.statePath, State{SchemaVersion: 1, Current: &later, UpdatedAt: later.VerifiedAt})
	for _, path := range []string{
		filepath.Dir(journal.OriginalCurrent.Path), filepath.Dir(journal.OriginalCandidate.Path), filepath.Dir(journal.RecoveryPath),
		journal.PlatformStatePath, journal.OperationPath, journal.ManifestPath,
	} {
		if err := os.RemoveAll(path); err != nil {
			t.Fatal(err)
		}
	}
	if err := fixture.manager.ValidateStartupOwnership(); err != nil {
		t.Fatalf("historical terminal journal depended on pruned transaction artifacts: %v", err)
	}
}

func TestStartupOwnershipRejectsTerminalSupersededPlanMissingIdentityWithoutMutation(t *testing.T) {
	fixture, journal := startupActiveRecoveryFixture(t)
	if err := fixture.manager.AcknowledgeStartup(); err != nil {
		t.Fatal(err)
	}
	_, recoveryPlan, err := readRecoveryActivationPlan(journal.RecoveryPlanPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := commitActivation(testActiveProfile, recoveryPlan.PlanPath, recoveryPlan); err != nil {
		t.Fatalf("commit recovery activation fixture: %v", err)
	}
	journal, exists, err := fixture.manager.readRecoveryTakeoverJournal(journal.Path)
	if err != nil || !exists || journal.Phase != recoveryTakeoverCommitted {
		t.Fatalf("committed recovery journal = %#v, exists=%v err=%v", journal, exists, err)
	}
	_, superseded, err := readRecoveryActivationPlan(journal.OriginalPlanPath)
	if err != nil {
		t.Fatal(err)
	}
	superseded.CandidatePath = ""
	superseded.PlatformCommit = ""
	activationTakeoverWriteJSON(t, journal.OriginalPlanPath, superseded)

	before := fixture.keyFiles()
	for _, path := range []string{journal.Path, journal.RecoveryPlanPath} {
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			t.Fatal(readErr)
		}
		before[path] = data
	}
	calls := fixture.runner.snapshot()
	if err := fixture.manager.ValidateStartupOwnership(); err == nil || !strings.Contains(err.Error(), "not bound") {
		t.Fatalf("terminal superseded plan with missing identity was admitted: %v", err)
	}
	activationTakeoverAssertFiles(t, before)
	if !reflect.DeepEqual(fixture.runner.snapshot(), calls) {
		t.Fatal("startup ownership refusal invoked the recovery runner")
	}
}

func TestStartupOwnershipRejectsMalformedAndUnknownRecoveryArtifacts(t *testing.T) {
	for _, test := range []struct {
		name string
		file string
		data []byte
	}{
		{name: "malformed journal", file: "recover-current-aaaaaaaaaaaa-bbbbbbbbbbbb.json", data: []byte("{broken")},
		{name: "unknown artifact", file: "unowned.tmp", data: []byte("unknown")},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newStartupOwnershipFixture(t)
			directory := filepath.Join(fixture.manager.Root, "recoveries")
			if err := os.MkdirAll(directory, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := atomicfile.WriteFile(filepath.Join(directory, test.file), test.data, 0o600); err != nil {
				t.Fatal(err)
			}
			stateBefore, _ := os.ReadFile(fixture.statePath)
			stableBefore, _ := os.ReadFile(fixture.stablePath)
			if err := fixture.manager.ValidateStartupOwnership(); err == nil {
				t.Fatal("unsafe recovery artifact was accepted")
			}
			stateAfter, _ := os.ReadFile(fixture.statePath)
			stableAfter, _ := os.ReadFile(fixture.stablePath)
			if !reflect.DeepEqual(stateBefore, stateAfter) || !reflect.DeepEqual(stableBefore, stableAfter) {
				t.Fatal("unsafe recovery artifact refusal mutated Manager state or stable binary")
			}
		})
	}
}

func newExternalRecoveryProbeFixture(t *testing.T) (*startupOwnershipFixture, Version) {
	t.Helper()
	fixture := newStartupOwnershipFixture(t)
	oldBinary := []byte("old registered Manager Current\n")
	oldSHA := sha256Hex(oldBinary)
	old := Version{
		Version: strings.Repeat("c", 40), SourceCommit: strings.Repeat("0", 40),
		Path:   filepath.Join(fixture.manager.Root, "versions", "running-"+oldSHA[:12], "ubitech-manager"),
		SHA256: oldSHA, VerifiedAt: fixture.current.VerifiedAt, PlatformCommitted: true,
	}
	writeStartupVersion(t, old, oldBinary, old)
	writeStartupJSON(t, fixture.statePath, State{SchemaVersion: 1, Current: &old, UpdatedAt: old.VerifiedAt})
	recoveryVersion := strings.Repeat("d", 40)
	fixture.manager.RunningVersion = recoveryVersion
	recovery := Version{
		Version: recoveryVersion,
		Path:    filepath.Join(fixture.manager.Root, "versions", "recovery-"+fixture.runningSHA[:12], "ubitech-manager"),
		SHA256:  fixture.runningSHA, VerifiedAt: old.VerifiedAt.Add(time.Second), PlatformCommitted: true,
	}
	writeStartupVersion(t, recovery, fixture.running, recovery)
	return fixture, recovery
}

func newCommittedRecoveryRelayFixture(t *testing.T) (*activationTakeoverFixture, recoveryTakeoverJournal, Version) {
	t.Helper()
	fixture := newActivationTakeoverFixture(t)
	journal := activationTakeoverPauseAtMainStarted(t, fixture)
	if err := fixture.manager.acknowledgeExecutable(journal.RecoveryPath); err != nil {
		t.Fatalf("acknowledge first recovery: %v", err)
	}
	_, plan, err := readRecoveryActivationPlan(journal.RecoveryPlanPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := commitActivation(testActiveProfile, plan.PlanPath, plan); err != nil {
		t.Fatalf("commit first recovery: %v", err)
	}
	journal, exists, err := fixture.manager.readRecoveryTakeoverJournal(journal.Path)
	if err != nil || !exists || journal.Phase != recoveryTakeoverCommitted {
		t.Fatalf("first recovery journal = %#v, exists=%v err=%v", journal, exists, err)
	}

	running, err := os.ReadFile("/proc/self/exe")
	if err != nil {
		t.Fatal(err)
	}
	runningSHA := sha256Hex(running)
	replacement := Version{
		Version: strings.Repeat("3", 40),
		Path:    filepath.Join(fixture.manager.Root, "versions", "recovery-"+runningSHA[:12], "ubitech-manager"),
		SHA256:  runningSHA, VerifiedAt: time.Now().UTC(), PlatformCommitted: true,
	}
	writeStartupVersion(t, replacement, running, replacement)
	if err := atomicfile.WriteFile(fixture.stablePath, running, 0o755); err != nil {
		t.Fatal(err)
	}
	fixture.manager.RunningVersion = replacement.Version
	return fixture, journal, replacement
}

func TestCommittedRecoveryRelayUsesProbeUntilAtomicCurrentRegistration(t *testing.T) {
	fixture, journal, replacement := newCommittedRecoveryRelayFixture(t)
	releaseGlobal, err := acquireRecoveryLock(fixture.manager.Root)
	if err != nil {
		t.Fatal(err)
	}
	lease, err := fixture.manager.AcquireStartupOwnership()
	if err != nil || lease == nil || !lease.ExternalRecoveryProbe() || lease.RetainsRecoveryLock() {
		t.Fatalf("committed recovery relay admission = %#v, err=%v", lease, err)
	}

	result := make(chan struct {
		lease *StartupOwnershipLease
		err   error
	}, 1)
	go func() {
		settled, waitErr := fixture.manager.AwaitExternalRecoveryOwnership(context.Background(), 5*time.Millisecond)
		result <- struct {
			lease *StartupOwnershipLease
			err   error
		}{lease: settled, err: waitErr}
	}()
	state := activationTakeoverReadState(fixture.statePath)
	replacement.SourceCommit = journal.PlatformCommit
	replacement.VerifiedAt = replacement.VerifiedAt.Add(time.Second)
	writeStartupJSON(t, fixture.statePath, State{
		SchemaVersion: state.SchemaVersion, Current: &replacement, Previous: state.Current, UpdatedAt: replacement.VerifiedAt,
	})
	releaseGlobal()
	select {
	case observed := <-result:
		if observed.err != nil || observed.lease == nil || !observed.lease.RetainsRecoveryLock() || observed.lease.ExternalRecoveryProbe() {
			t.Fatalf("registered relay recovery did not obtain normal ownership: lease=%#v err=%v", observed.lease, observed.err)
		}
		observed.lease.Release()
	case <-time.After(time.Second):
		t.Fatal("registered relay recovery did not leave probe-only mode")
	}
}

func TestCommittedRecoveryRelayRequiresBusyLockAndImmutableMetadata(t *testing.T) {
	t.Run("lock free", func(t *testing.T) {
		fixture, _, _ := newCommittedRecoveryRelayFixture(t)
		if _, err := fixture.manager.AcquireStartupOwnership(); err == nil || !strings.Contains(err.Error(), "stable executable disagree") {
			t.Fatalf("lock-free relay checkpoint was admitted: %v", err)
		}
	})
	t.Run("missing metadata", func(t *testing.T) {
		fixture, _, replacement := newCommittedRecoveryRelayFixture(t)
		if err := os.Remove(filepath.Join(filepath.Dir(replacement.Path), "metadata.json")); err != nil {
			t.Fatal(err)
		}
		releaseGlobal, err := acquireRecoveryLock(fixture.manager.Root)
		if err != nil {
			t.Fatal(err)
		}
		defer releaseGlobal()
		if _, err := fixture.manager.AcquireStartupOwnership(); err == nil || !strings.Contains(err.Error(), "metadata") {
			t.Fatalf("relay without immutable metadata was admitted: %v", err)
		}
	})
}

func TestRolledBackRecoveryCannotBecomeRelayProbe(t *testing.T) {
	fixture := newActivationTakeoverFixture(t)
	journal := activationTakeoverPauseAtMainStarted(t, fixture)
	_, plan, err := readRecoveryActivationPlan(journal.RecoveryPlanPath)
	if err != nil {
		t.Fatal(err)
	}
	plan.Error = "first recovery failed"
	if err := restorePrevious(testActiveProfile, plan, fixture.runner); err == nil || !strings.Contains(err.Error(), plan.Error) {
		t.Fatalf("roll back first recovery: %v", err)
	}
	journal, exists, err := fixture.manager.readRecoveryTakeoverJournal(journal.Path)
	if err != nil || !exists || journal.Phase != recoveryTakeoverRolledBack {
		t.Fatalf("rolled-back recovery journal = %#v, exists=%v err=%v", journal, exists, err)
	}
	running, err := os.ReadFile("/proc/self/exe")
	if err != nil {
		t.Fatal(err)
	}
	runningSHA := sha256Hex(running)
	replacement := Version{
		Version: strings.Repeat("3", 40),
		Path:    filepath.Join(fixture.manager.Root, "versions", "recovery-"+runningSHA[:12], "ubitech-manager"),
		SHA256:  runningSHA, VerifiedAt: time.Now().UTC(), PlatformCommitted: true,
	}
	writeStartupVersion(t, replacement, running, replacement)
	if err := atomicfile.WriteFile(fixture.stablePath, running, 0o755); err != nil {
		t.Fatal(err)
	}
	fixture.manager.RunningVersion = replacement.Version
	releaseGlobal, err := acquireRecoveryLock(fixture.manager.Root)
	if err != nil {
		t.Fatal(err)
	}
	defer releaseGlobal()
	if _, err := fixture.manager.AcquireStartupOwnership(); err == nil || !strings.Contains(err.Error(), "stable executable disagree") {
		t.Fatalf("rolled-back recovery became a relay probe: %v", err)
	}
}

func TestExternalRecoveryProbeExitsIfLockOwnerDiesBeforeRegistration(t *testing.T) {
	fixture, _ := newExternalRecoveryProbeFixture(t)
	releaseGlobal, err := acquireRecoveryLock(fixture.manager.Root)
	if err != nil {
		t.Fatal(err)
	}
	lease, err := fixture.manager.AcquireStartupOwnership()
	if err != nil || !lease.ExternalRecoveryProbe() {
		t.Fatalf("simple recovery did not enter probe-only mode: lease=%#v err=%v", lease, err)
	}
	result := make(chan error, 1)
	go func() {
		_, waitErr := fixture.manager.AwaitExternalRecoveryOwnership(context.Background(), 5*time.Millisecond)
		result <- waitErr
	}()
	select {
	case err := <-result:
		t.Fatalf("probe-only process stopped waiting while owner held lock: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	releaseGlobal()
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("unregistered recovery process became a full Manager")
		}
	case <-time.After(time.Second):
		t.Fatal("unregistered recovery process did not exit after owner lock release")
	}
}

func TestExternalRecoveryProbePromotesOnlyAfterAtomicCurrentRegistration(t *testing.T) {
	fixture, recovery := newExternalRecoveryProbeFixture(t)
	releaseGlobal, err := acquireRecoveryLock(fixture.manager.Root)
	if err != nil {
		t.Fatal(err)
	}
	result := make(chan struct {
		lease *StartupOwnershipLease
		err   error
	}, 1)
	go func() {
		lease, waitErr := fixture.manager.AwaitExternalRecoveryOwnership(context.Background(), 5*time.Millisecond)
		result <- struct {
			lease *StartupOwnershipLease
			err   error
		}{lease: lease, err: waitErr}
	}()
	recovery.SourceCommit = strings.Repeat("e", 40)
	recovery.VerifiedAt = recovery.VerifiedAt.Add(time.Second) // State commit time differs from immutable metadata time.
	writeStartupJSON(t, fixture.statePath, State{SchemaVersion: 1, Current: &recovery, UpdatedAt: recovery.VerifiedAt})
	releaseGlobal()
	select {
	case observed := <-result:
		if observed.err != nil || observed.lease == nil || !observed.lease.RetainsRecoveryLock() || observed.lease.ExternalRecoveryProbe() {
			t.Fatalf("registered recovery did not obtain normal retained ownership: lease=%#v err=%v", observed.lease, observed.err)
		}
		observed.lease.Release()
	case <-time.After(time.Second):
		t.Fatal("registered recovery did not leave probe-only mode")
	}
}

func TestStartupOwnershipFreshInstallHasNoSyntheticOwner(t *testing.T) {
	base := t.TempDir()
	manager := &Manager{Profile: testActiveProfile,
		Root: filepath.Join(base, "manager-binaries"), StatePath: filepath.Join(base, "manager-binaries.json"),
		InstallPath: filepath.Join(base, "bin", "ubitech-manager"), RunningVersion: strings.Repeat("a", 40),
	}
	lease, err := manager.AcquireStartupOwnership()
	if err != nil || lease == nil || lease.RetainsRecoveryLock() || lease.ExternalRecoveryProbe() || lease.RecoveryCandidate() {
		t.Fatalf("fresh startup admission = %#v, err=%v", lease, err)
	}
}

func TestStartupOwnershipGlobalLockIsNonblocking(t *testing.T) {
	fixture := newStartupOwnershipFixture(t)
	releaseGlobal, err := acquireRecoveryLock(fixture.manager.Root)
	if err != nil {
		t.Fatal(err)
	}
	defer releaseGlobal()
	type result struct {
		lease *StartupOwnershipLease
		err   error
	}
	done := make(chan result, 1)
	go func() {
		lease, acquireErr := fixture.manager.AcquireStartupOwnership()
		done <- result{lease: lease, err: acquireErr}
	}()
	select {
	case observed := <-done:
		if observed.err != nil || !observed.lease.ExternalRecoveryProbe() {
			t.Fatalf("busy Current health probe admission = %#v, err=%v", observed.lease, observed.err)
		}
	case <-time.After(time.Second):
		t.Fatal("startup waited on the held global recovery flock")
	}
}

func TestStartupRecoveryJournalLockUsesNonblockingFlock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.lock")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	fd, err := syscall.Open(path, syscall.O_RDWR|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.Close(fd)
	if err := syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	type result struct {
		release func()
		busy    bool
		err     error
	}
	done := make(chan result, 1)
	go func() {
		release, busy, lockErr := tryStartupRecoveryJournalLock(path)
		done <- result{release: release, busy: busy, err: lockErr}
	}()
	select {
	case observed := <-done:
		if observed.release != nil {
			observed.release()
		}
		if observed.err != nil || !observed.busy {
			t.Fatalf("nonblocking journal flock: busy=%v err=%v", observed.busy, observed.err)
		}
	case <-time.After(time.Second):
		t.Fatal("startup waited on the held recovery journal flock")
	}
}
