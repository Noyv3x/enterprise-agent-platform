//go:build linux

package handoffhelper

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffhost"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffowner"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffstartup"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

const (
	testPredecessor = "1111111111111111111111111111111111111111"
	testBridge      = "2222222222222222222222222222222222222222"
	testSourceSHA   = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testTargetSHA   = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	testProofSHA    = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	testBootID      = "116a2e13-30af-4ecc-8ea1-465b1b820f40"
)

type fakeHelperHost struct {
	mu              sync.Mutex
	pid             int
	inspectErr      error
	disableCount    int
	removeCount     int
	removedInactive bool
}

func (*fakeHelperHost) Resolve(request handoffhost.ArmRequest) (handoffhost.HelperSpec, error) {
	return (&handoffhost.LinuxHost{}).Resolve(request)
}

func (host *fakeHelperHost) Inspect(_ context.Context, spec handoffhost.HelperSpec) (handoffhost.HelperProof, error) {
	host.mu.Lock()
	defer host.mu.Unlock()
	if host.inspectErr != nil {
		return handoffhost.HelperProof{}, host.inspectErr
	}
	return handoffhost.HelperProof{
		TransactionID: spec.TransactionID, UnitName: spec.UnitName, UnitPath: spec.UnitPath,
		UnitSHA256: spec.UnitSHA256, ExecutablePath: spec.ExecutablePath,
		ExecutableSHA256: spec.ExecutableSHA256, Argv: append([]string(nil), spec.Argv...),
		Enabled: true, Active: true, MainPID: host.pid,
		ControlGroup: "/user.slice/helper.service", BootID: testBootID,
	}, nil
}

func (host *fakeHelperHost) DisableForExit(_ context.Context, _ handoffhost.HelperSpec, proof handoffhost.HelperProof) error {
	host.mu.Lock()
	defer host.mu.Unlock()
	if proof.MainPID != host.pid {
		return errors.New("wrong helper proof")
	}
	host.disableCount++
	return nil
}

func (host *fakeHelperHost) RemoveInactive(_ context.Context, _ handoffhost.RemovalRequest) (handoffhost.RemovalResult, error) {
	host.mu.Lock()
	defer host.mu.Unlock()
	host.removeCount++
	host.removedInactive = true
	return handoffhost.RemovalResult{UnitRemoved: true, ExecutableRemoved: true}, nil
}

type callLog struct {
	mu    sync.Mutex
	calls []string
}

type staticJournalLease struct {
	journal handoff.Journal
	err     error
}

func (lease staticJournalLease) Load() (handoff.Journal, error) { return lease.journal, lease.err }

func (log *callLog) add(name string) {
	log.mu.Lock()
	defer log.mu.Unlock()
	log.calls = append(log.calls, name)
}

func (log *callLog) snapshot() []string {
	log.mu.Lock()
	defer log.mu.Unlock()
	return append([]string(nil), log.calls...)
}

type fakeRuntime struct{ log *callLog }

type fakeSourceRelease struct {
	log *callLog
	err error
}

func (source *fakeSourceRelease) RestoreCanonicalSourceRelease(context.Context, handoff.Journal) error {
	source.log.add("restore_source_release")
	return source.err
}

func (runtime *fakeRuntime) ReserveAdmission(context.Context, Operation) error {
	runtime.log.add("reserve")
	return nil
}
func (runtime *fakeRuntime) DrainAndStopWriters(context.Context, Operation) error {
	runtime.log.add("drain")
	return nil
}
func (runtime *fakeRuntime) CreateSnapshot(_ context.Context, operation Operation) (handoff.Snapshot, error) {
	runtime.log.add("snapshot")
	return handoff.Snapshot{Path: filepath.Join(filepath.Dir(operation.Source.DataRoot), "snapshot"), ManifestSHA256: testProofSHA}, nil
}
func (runtime *fakeRuntime) FenceSource(context.Context, Operation) error {
	runtime.log.add("fence")
	return nil
}
func (runtime *fakeRuntime) RestoreSourceBeforeFence(context.Context, Operation, handoffstartup.JournalLease) error {
	runtime.log.add("restore_source_before_fence")
	return nil
}
func (runtime *fakeRuntime) ReleaseAdmission(context.Context, Operation) error {
	runtime.log.add("release")
	return nil
}

type fakeData struct {
	log          *callLog
	validateErr  error
	transformErr error
}

func (data *fakeData) ValidateConfiguration() error { return data.validateErr }
func (data *fakeData) StageTarget(context.Context, Operation) error {
	data.log.add("stage")
	return nil
}
func (data *fakeData) TransformAndPublish(context.Context, Operation) error {
	data.log.add("transform_publish")
	return data.transformErr
}
func (data *fakeData) RestoreData(context.Context, Operation) error {
	data.log.add("restore_data")
	return nil
}
func (data *fakeData) RemoveTargetStaging(context.Context, Operation) error {
	data.log.add("remove_staging")
	return nil
}

type fakeParticipants struct {
	log        *callLog
	ack        handoff.TargetAck
	startErr   error
	started    bool
	inspectErr error
	lastStart  StartRequest
	mu         sync.Mutex
}

func (participants *fakeParticipants) InspectStarted(_ context.Context, request StartRequest) (bool, error) {
	participants.mu.Lock()
	defer participants.mu.Unlock()
	participants.lastStart = request
	return participants.started, participants.inspectErr
}
func (participants *fakeParticipants) ReconcileStarted(_ context.Context, request StartRequest) error {
	participants.mu.Lock()
	defer participants.mu.Unlock()
	participants.lastStart = request
	if !participants.started {
		return errors.New("participant is not started")
	}
	return nil
}

func (participants *fakeParticipants) Start(_ context.Context, request StartRequest) error {
	participants.mu.Lock()
	participants.lastStart = request
	participants.mu.Unlock()
	participants.log.add("start_" + string(request.Role))
	return participants.startErr
}
func (participants *fakeParticipants) ProbeTarget(context.Context, Operation) error {
	participants.log.add("probe_target")
	return nil
}
func (participants *fakeParticipants) TargetAcknowledgement(context.Context, Operation) (handoff.TargetAck, error) {
	participants.log.add("target_ack")
	return participants.ack, nil
}
func (participants *fakeParticipants) RetireSource(context.Context, Operation) error {
	participants.log.add("retire_source")
	return nil
}
func (participants *fakeParticipants) VerifyTargetCommitBoundary(context.Context, Operation) error {
	participants.log.add("verify_commit")
	return nil
}
func (participants *fakeParticipants) CommitTargetPlatform(_ context.Context, operation Operation) (handoff.TargetPlatformCommit, error) {
	participants.log.add("commit_platform")
	receipt := handoff.TargetPlatformCommit{
		SchemaVersion: 1, OperationID: operation.TransactionID,
		TargetGeneration: operation.Release.BridgeGeneration, BindingSHA256: operation.BindingSHA256,
		DatabaseSchemaVersion: operation.Evidence.DatabaseSchemaVersion, CommittedAt: operation.UpdatedAt.Add(time.Second).Format(time.RFC3339Nano),
	}
	receipt.ReceiptSHA256, _ = handoff.ComputeTargetPlatformCommitSHA256(receipt)
	return receipt, nil
}
func (participants *fakeParticipants) StopTarget(context.Context, Operation) error {
	participants.log.add("stop_target")
	return nil
}
func (participants *fakeParticipants) VerifySourceIdentity(context.Context, Operation) error {
	participants.log.add("verify_source")
	return nil
}
func (participants *fakeParticipants) VerifySourcePublicReady(context.Context, Operation) error {
	participants.log.add("verify_source_public")
	return nil
}

type fakeIssuerFactory struct {
	mu      sync.Mutex
	created int
	served  int
	newErr  error
	journal handoff.Journal
}

func (factory *fakeIssuerFactory) New(options handoffstartup.IssuerOptions) (StartupIssuer, error) {
	if factory.newErr != nil {
		return nil, factory.newErr
	}
	journal, err := options.Lease.Load()
	if err != nil {
		return nil, err
	}
	factory.mu.Lock()
	factory.created++
	factory.journal = journal
	factory.mu.Unlock()
	return &fakeIssuer{factory: factory}, nil
}

type fakeIssuer struct {
	factory *fakeIssuerFactory
	mu      sync.Mutex
	closed  bool
}

func (issuer *fakeIssuer) Serve(context.Context) error {
	issuer.factory.mu.Lock()
	issuer.factory.served++
	issuer.factory.mu.Unlock()
	return nil
}

func (issuer *fakeIssuer) Close() error {
	issuer.mu.Lock()
	defer issuer.mu.Unlock()
	issuer.closed = true
	return nil
}

type helperFixture struct {
	t             *testing.T
	store         *handoff.Store
	helper        *handoff.Helper
	journal       handoff.Journal
	driver        *Driver
	host          *fakeHelperHost
	runtime       *fakeRuntime
	data          *fakeData
	participants  *fakeParticipants
	sourceRelease *fakeSourceRelease
	issuer        *fakeIssuerFactory
	log           *callLog
	bindings      handoffstartup.Bindings
	now           time.Time
	callerPID     *int
}

func newHelperFixture(t *testing.T) *helperFixture {
	t.Helper()
	root := t.TempDir()
	stateHome := filepath.Join(root, "state")
	dataHome := filepath.Join(root, "share")
	for _, directory := range []string{stateHome, dataHome} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	source, target := identity.SourceProfile(), identity.TargetProfile()
	sourceRoot := filepath.Join(dataHome, source.DataDirectory)
	targetRoot := filepath.Join(dataHome, target.DataDirectory)
	if err := os.Mkdir(sourceRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	journalRoot := filepath.Join(stateHome, target.DataDirectory, "handoff")
	store, err := handoff.Open(journalRoot, sourceRoot, targetRoot)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })

	configHome := filepath.Join(root, "config")
	binHome := filepath.Join(root, "bin")
	runtimeRoot := filepath.Join(root, "run")
	unitHome := filepath.Join(root, "units")
	sourceSocket, _ := source.ControlSocketPath(sourceRoot, "")
	targetSocket, _ := target.ControlSocketPath(targetRoot, runtimeRoot)
	bindings := handoffstartup.Bindings{
		Source: handoffstartup.RuntimePaths{
			StableBinary: source.ManagerInstallPath(binHome), ConfigPath: source.DefaultConfigPath(configHome),
			DataRoot: sourceRoot, StateRoot: source.ManagerStateRoot(sourceRoot), SocketPath: sourceSocket,
		},
		Target: handoffstartup.RuntimePaths{
			StableBinary: target.ManagerInstallPath(binHome), ConfigPath: target.DefaultConfigPath(configHome),
			DataRoot: targetRoot, StateRoot: target.ManagerStateRoot(targetRoot), SocketPath: targetSocket,
		},
	}
	now := time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC)
	journal, err := handoff.NewJournal(
		handoff.ReleaseBinding{
			PredecessorGeneration: testPredecessor, BridgeGeneration: testBridge,
			ManifestPath: filepath.Join(source.ManagerStateRoot(sourceRoot), "releases", testBridge, "manifest.json"), ManifestSHA256: strings.Repeat("d", 64),
			TargetManagerSHA256: testTargetSHA, TargetManagerVersion: testBridge, TargetComposeSHA256: strings.Repeat("e", 64),
		},
		handoff.SourceBinding{
			Namespace: source.ProfileID, Unit: source.ManagerUnit, UnitEnabled: true,
			UnitPath: filepath.Join(unitHome, source.ManagerUnit), UnitSHA256: strings.Repeat("1", 64),
			StableBinary: bindings.Source.StableBinary, StableSHA256: testSourceSHA,
			ConfigPath: bindings.Source.ConfigPath, ConfigSHA256: strings.Repeat("2", 64),
			ManifestPath: filepath.Join(source.ManagerStateRoot(sourceRoot), "releases", testPredecessor, "manifest.json"), ManifestSHA256: strings.Repeat("d", 64),
			ComposePath: filepath.Join(source.ManagerStateRoot(sourceRoot), "releases", testPredecessor, "compose.yaml"), ComposeSHA256: strings.Repeat("e", 64),
			DataRoot: sourceRoot, SocketPath: sourceSocket, ComposeProject: source.ComposeProject,
			CoreNetwork: source.CoreNetwork, CoreNetworkID: "abcdefabcdef", LabelPrefix: source.LabelPrefix,
		},
		handoff.TargetBinding{
			Namespace: target.ProfileID, Unit: target.ManagerUnit, UnitPath: filepath.Join(unitHome, target.ManagerUnit),
			StableBinary: bindings.Target.StableBinary, ConfigPath: bindings.Target.ConfigPath, ConfigSHA256: strings.Repeat("9", 64), DataRoot: targetRoot,
			SocketPath:     bindings.Target.SocketPath,
			ComposeProject: target.ComposeProject, CoreNetwork: target.CoreNetwork, LabelPrefix: target.LabelPrefix,
		},
		handoff.Evidence{
			ManagerStateSHA256: strings.Repeat("3", 64), SelfUpdateStateSHA256: strings.Repeat("4", 64),
			SandboxRegistrySHA256: strings.Repeat("5", 64), DockerInventorySHA256: strings.Repeat("6", 64),
			DatabaseSchemaVersion: 1, DatabaseIntegrity: "ok", RuntimeIdentitySHA256: strings.Repeat("7", 64),
			WorkspaceIdentitySHA256: strings.Repeat("8", 64), BootID: testBootID,
		}, now,
	)
	if err != nil {
		t.Fatal(err)
	}
	journal, err = store.Create(journal)
	if err != nil {
		t.Fatal(err)
	}
	helper, journal, err := store.OpenHelper(journal.TransactionID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = helper.Close() })

	log := &callLog{}
	host := &fakeHelperHost{pid: 4242}
	callerPID := new(int)
	*callerPID = host.pid
	runtimeBoundary := &fakeRuntime{log: log}
	data := &fakeData{log: log}
	participants := &fakeParticipants{log: log}
	sourceRelease := &fakeSourceRelease{log: log}
	issuer := &fakeIssuerFactory{}
	driver, err := New(Options{
		TransactionDirectory: filepath.Join(store.Root(), journal.TransactionID), Bindings: bindings,
		Runtime: runtimeBoundary, Data: data, Participants: participants, SourceRelease: sourceRelease, HelperHost: host,
		IssuerFactory: issuer, CurrentPID: func() int { return *callerPID }, Clock: func() time.Time { return now.Add(2 * time.Hour) },
	})
	if err != nil {
		t.Fatal(err)
	}
	evidence, err := driver.VerifyPersistentHelper(context.Background(), journal)
	if err != nil {
		t.Fatal(err)
	}
	journal, err = helper.Mutate(journal.Revision, now.Add(time.Second), func(next *handoff.Journal) error {
		next.Helper = &evidence
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	participants.ack = handoff.TargetAck{
		ManagerVersion: testBridge, ExecutableSHA256: testTargetSHA, SourceCommit: testBridge,
		PID: 5252, SocketPath: journal.Target.SocketPath, AutoUpdateCheckAt: now.Add(59 * time.Minute),
		IssuedAt: now.Add(time.Hour), ProofSHA256: testProofSHA,
	}
	return &helperFixture{
		t: t, store: store, helper: helper, journal: journal, driver: driver, host: host,
		runtime: runtimeBoundary, data: data, participants: participants, sourceRelease: sourceRelease, issuer: issuer,
		log: log, bindings: bindings, now: now.Add(time.Second), callerPID: callerPID,
	}
}

func (fixture *helperFixture) mutate(change func(*handoff.Journal)) {
	fixture.t.Helper()
	fixture.now = fixture.now.Add(time.Second)
	next, err := fixture.helper.Mutate(fixture.journal.Revision, fixture.now, func(journal *handoff.Journal) error {
		change(journal)
		return nil
	})
	if err != nil {
		fixture.t.Fatal(err)
	}
	fixture.journal = next
}

func (fixture *helperFixture) advanceForward(target handoff.Phase) {
	fixture.t.Helper()
	phases := []handoff.Phase{
		handoff.PhasePlanned, handoff.PhaseHelperArmed, handoff.PhaseAdmissionReserved,
		handoff.PhaseWritersStopped, handoff.PhaseSnapshotReady, handoff.PhaseSourceFenced,
		handoff.PhaseTargetStaged, handoff.PhaseDataRelocated, handoff.PhaseTargetStarted,
		handoff.PhaseTargetVerified, handoff.PhaseSourceRetired, handoff.PhaseTargetCommitPlanned, handoff.PhaseCommitted,
	}
	for fixture.journal.Phase != target {
		index := -1
		for candidate, phase := range phases {
			if phase == fixture.journal.Phase {
				index = candidate
				break
			}
		}
		if index < 0 || index+1 >= len(phases) {
			fixture.t.Fatalf("cannot advance %s to %s", fixture.journal.Phase, target)
		}
		if fixture.journal.Phase == handoff.PhaseWritersStopped && fixture.journal.Snapshot == nil {
			fixture.mutate(func(journal *handoff.Journal) {
				journal.Snapshot = &handoff.Snapshot{Path: filepath.Join(filepath.Dir(journal.Source.DataRoot), "snapshot"), ManifestSHA256: testProofSHA}
			})
		}
		if fixture.journal.Phase == handoff.PhaseTargetStarted && fixture.journal.TargetAck == nil {
			ack := fixture.participants.ack
			if fixture.now.Before(ack.IssuedAt) {
				fixture.now = ack.IssuedAt
			}
			fixture.mutate(func(journal *handoff.Journal) { journal.TargetAck = &ack })
		}
		next := phases[index+1]
		fixture.mutate(func(journal *handoff.Journal) {
			if next == handoff.PhaseCommitted {
				receipt := handoff.TargetPlatformCommit{
					SchemaVersion: 1, OperationID: journal.TransactionID,
					TargetGeneration: journal.Release.BridgeGeneration, BindingSHA256: journal.BindingSHA256,
					DatabaseSchemaVersion: journal.Evidence.DatabaseSchemaVersion, CommittedAt: fixture.now.Format(time.RFC3339Nano),
				}
				receipt.ReceiptSHA256, _ = handoff.ComputeTargetPlatformCommitSHA256(receipt)
				journal.TargetPlatformCommit = &receipt
			}
			journal.Phase = next
			if next == handoff.PhaseCommitted {
				journal.Status = handoff.StatusCommitted
			}
		})
	}
}

func (fixture *helperFixture) advanceRollback(target handoff.Phase) {
	fixture.t.Helper()
	if fixture.journal.Status == handoff.StatusRunning {
		fixture.advanceForward(handoff.PhaseSourceFenced)
		fixture.mutate(func(journal *handoff.Journal) { journal.Error = "injected forward failure" })
	}
	for fixture.journal.Phase != target {
		var next handoff.Phase
		switch fixture.journal.Phase {
		case handoff.PhaseRollbackPlanned:
			next = handoff.PhaseTargetStopped
		case handoff.PhaseTargetStopped:
			next = handoff.PhaseDataRestored
		case handoff.PhaseDataRestored:
			next = handoff.PhaseSourceStarted
		case handoff.PhaseSourceStarted:
			next = handoff.PhaseRolledBack
		default:
			fixture.t.Fatalf("cannot advance rollback %s to %s", fixture.journal.Phase, target)
		}
		fixture.mutate(func(journal *handoff.Journal) {
			journal.Phase = next
			if next == handoff.PhaseRolledBack {
				journal.Status = handoff.StatusRolledBack
			}
		})
	}
}

func TestForwardHelperPhasesUseRealBoundariesAndStartupLease(t *testing.T) {
	fixture := newHelperFixture(t)
	ctx := context.Background()
	restartHelper := func() {
		fixture.host.mu.Lock()
		fixture.host.pid++
		*fixture.callerPID = fixture.host.pid
		fixture.host.mu.Unlock()
	}
	fixture.advanceForward(handoff.PhaseHelperArmed)
	restartHelper()
	if err := fixture.driver.ReserveAdmission(ctx, fixture.journal); err != nil {
		t.Fatal(err)
	}
	fixture.advanceForward(handoff.PhaseAdmissionReserved)
	restartHelper()
	if err := fixture.driver.DrainAndStopWriters(ctx, fixture.journal); err != nil {
		t.Fatal(err)
	}
	fixture.advanceForward(handoff.PhaseWritersStopped)
	restartHelper()
	snapshot, err := fixture.driver.CreateSnapshot(ctx, fixture.journal)
	if err != nil {
		t.Fatal(err)
	}
	fixture.mutate(func(journal *handoff.Journal) { journal.Snapshot = &snapshot })
	fixture.advanceForward(handoff.PhaseSnapshotReady)
	restartHelper()
	if err := fixture.driver.FenceSource(ctx, fixture.journal); err != nil {
		t.Fatal(err)
	}
	fixture.advanceForward(handoff.PhaseSourceFenced)
	restartHelper()
	if err := fixture.driver.StageTarget(ctx, fixture.journal); err != nil {
		t.Fatal(err)
	}
	fixture.advanceForward(handoff.PhaseTargetStaged)
	restartHelper()
	if err := fixture.driver.TransformData(ctx, fixture.journal); err != nil {
		t.Fatal(err)
	}
	fixture.advanceForward(handoff.PhaseDataRelocated)
	restartHelper()
	if err := fixture.driver.StartTarget(ctx, fixture.journal, fixture.helper.StartupLease()); err != nil {
		t.Fatal(err)
	}
	fixture.advanceForward(handoff.PhaseTargetStarted)
	restartHelper()
	if err := fixture.driver.ProbeTarget(ctx, fixture.journal); err != nil {
		t.Fatal(err)
	}
	ack, err := fixture.driver.TargetAcknowledgement(ctx, fixture.journal)
	if err != nil {
		t.Fatal(err)
	}
	if fixture.now.Before(ack.IssuedAt) {
		fixture.now = ack.IssuedAt
	}
	fixture.mutate(func(journal *handoff.Journal) { journal.TargetAck = &ack })
	fixture.advanceForward(handoff.PhaseTargetVerified)
	restartHelper()
	if err := fixture.driver.RetireSource(ctx, fixture.journal); err != nil {
		t.Fatal(err)
	}
	fixture.advanceForward(handoff.PhaseSourceRetired)
	restartHelper()
	if err := fixture.driver.VerifyTargetCommitBoundary(ctx, fixture.journal); err != nil {
		t.Fatal(err)
	}

	want := []string{"reserve", "drain", "snapshot", "fence", "stage", "transform_publish", "start_target", "probe_target", "target_ack", "retire_source", "verify_commit"}
	if got := fixture.log.snapshot(); !reflect.DeepEqual(got, want) {
		t.Fatalf("calls = %v, want %v", got, want)
	}
	fixture.issuer.mu.Lock()
	created, served, issued := fixture.issuer.created, fixture.issuer.served, fixture.issuer.journal
	fixture.issuer.mu.Unlock()
	if created != 1 || served != 1 || issued.Revision == 0 || issued.TransactionID != fixture.journal.TransactionID {
		t.Fatalf("startup issuer did not consume the helper lease: created=%d served=%d journal=%+v", created, served, issued)
	}
	fixture.participants.mu.Lock()
	start := fixture.participants.lastStart
	fixture.participants.mu.Unlock()
	if start.Role != ParticipantTarget || start.Unit != fixture.journal.Target.Unit || start.StableBinary != fixture.journal.Target.StableBinary ||
		start.CapabilitySocketPath != filepath.Join(filepath.Dir(start.CapabilitySocketPath), handoffstartup.SocketBasename) {
		t.Fatalf("target start request is not journal-bound: %+v", start)
	}
}

func TestRollbackAndPreFenceRecoveryUseDistinctStartupBoundaries(t *testing.T) {
	ctx := context.Background()
	preFence := newHelperFixture(t)
	preFence.advanceForward(handoff.PhaseWritersStopped)
	if err := preFence.driver.RestoreSourceBeforeFence(ctx, preFence.journal, preFence.helper.StartupLease()); err != nil {
		t.Fatal(err)
	}
	if preFence.issuer.created != 0 {
		t.Fatal("pre-fence source recovery created a startup issuer")
	}
	if got := preFence.log.snapshot(); !reflect.DeepEqual(got, []string{"restore_source_release", "restore_source_before_fence"}) {
		t.Fatalf("pre-fence recovery calls = %v", got)
	}

	rollback := newHelperFixture(t)
	rollback.advanceRollback(handoff.PhaseRollbackPlanned)
	if err := rollback.driver.StopTarget(ctx, rollback.journal); err != nil {
		t.Fatal(err)
	}
	rollback.advanceRollback(handoff.PhaseTargetStopped)
	if err := rollback.driver.RestoreData(ctx, rollback.journal); err != nil {
		t.Fatal(err)
	}
	rollback.advanceRollback(handoff.PhaseDataRestored)
	if err := rollback.driver.StartSource(ctx, rollback.journal, rollback.helper.StartupLease()); err != nil {
		t.Fatal(err)
	}
	rollback.advanceRollback(handoff.PhaseSourceStarted)
	if err := rollback.driver.VerifySourceIdentity(ctx, rollback.journal); err != nil {
		t.Fatal(err)
	}
	if err := rollback.driver.ReleaseAdmission(ctx, rollback.journal); err != nil {
		t.Fatal(err)
	}
	if err := rollback.driver.VerifySourcePublicReady(ctx, rollback.journal); err != nil {
		t.Fatal(err)
	}
	want := []string{"stop_target", "restore_data", "restore_source_release", "start_source", "restore_source_release", "verify_source", "release", "verify_source_public"}
	if got := rollback.log.snapshot(); !reflect.DeepEqual(got, want) {
		t.Fatalf("rollback calls = %v, want %v", got, want)
	}
}

func TestSourceReleaseRestorationFailurePrecedesEverySourceStart(t *testing.T) {
	preFence := newHelperFixture(t)
	preFence.advanceForward(handoff.PhaseWritersStopped)
	preFence.sourceRelease.err = errors.New("recovery bundle unavailable")
	if err := preFence.driver.RestoreSourceBeforeFence(context.Background(), preFence.journal, preFence.helper.StartupLease()); err == nil {
		t.Fatal("pre-fence recovery ignored canonical source release failure")
	}
	if got := preFence.log.snapshot(); !reflect.DeepEqual(got, []string{"restore_source_release"}) {
		t.Fatalf("pre-fence runtime ran before canonical source recovery: %v", got)
	}

	rollback := newHelperFixture(t)
	rollback.advanceRollback(handoff.PhaseDataRestored)
	rollback.sourceRelease.err = errors.New("recovery bundle unavailable")
	if err := rollback.driver.StartSource(context.Background(), rollback.journal, rollback.helper.StartupLease()); err == nil {
		t.Fatal("rollback source start ignored canonical source release failure")
	}
	if got := rollback.log.snapshot(); !reflect.DeepEqual(got, []string{"restore_source_release"}) {
		t.Fatalf("source participant ran before canonical source recovery: %v", got)
	}
}

func TestWrongPhaseAndHelperIdentityFailBeforeEffects(t *testing.T) {
	fixture := newHelperFixture(t)
	if err := fixture.driver.ReserveAdmission(context.Background(), fixture.journal); !errors.Is(err, ErrWrongPhase) {
		t.Fatalf("wrong phase error = %v", err)
	}
	fixture.advanceForward(handoff.PhaseHelperArmed)
	fixture.host.pid++
	if err := fixture.driver.ReserveAdmission(context.Background(), fixture.journal); !errors.Is(err, ErrOwnership) {
		t.Fatalf("PID ownership error = %v", err)
	}
	if got := fixture.log.snapshot(); len(got) != 0 {
		t.Fatalf("unauthorized effect calls = %v", got)
	}
}

func TestHelperRestartWithNewPIDRetainsStaticJournalOwnership(t *testing.T) {
	fixture := newHelperFixture(t)
	fixture.advanceForward(handoff.PhaseHelperArmed)
	staticEvidence := *fixture.journal.Helper
	fixture.host.mu.Lock()
	fixture.host.pid = 5151
	fixture.host.mu.Unlock()
	*fixture.callerPID = 5151
	if err := fixture.driver.ReserveAdmission(context.Background(), fixture.journal); err != nil {
		t.Fatalf("new helper PID could not resume the static transaction: %v", err)
	}
	if !reflect.DeepEqual(*fixture.journal.Helper, staticEvidence) {
		t.Fatal("dynamic helper restart changed durable static evidence")
	}
	if got := fixture.log.snapshot(); !reflect.DeepEqual(got, []string{"reserve"}) {
		t.Fatalf("resumed helper effects = %v", got)
	}
}

func TestDataTransitionFailureIsRetryableButNeverReportedAsSuccess(t *testing.T) {
	fixture := newHelperFixture(t)
	fixture.advanceForward(handoff.PhaseTargetStaged)
	fixture.data.transformErr = errors.New("schema transformer unavailable")
	if err := fixture.driver.TransformData(context.Background(), fixture.journal); err == nil {
		t.Fatal("failed transform was reported as success")
	}
	fixture.data.transformErr = nil
	if err := fixture.driver.TransformData(context.Background(), fixture.journal); err != nil {
		t.Fatal(err)
	}
	if got := fixture.log.snapshot(); !reflect.DeepEqual(got, []string{"transform_publish", "transform_publish"}) {
		t.Fatalf("transform replay calls = %v", got)
	}
}

func TestFinalizeOnlyDisablesAndStableCleanupOnlyRemovesInactiveArtifacts(t *testing.T) {
	fixture := newHelperFixture(t)
	fixture.advanceForward(handoff.PhaseCommitted)
	if err := fixture.driver.FinalizePersistentHelper(context.Background(), fixture.journal); err != nil {
		t.Fatal(err)
	}
	if err := fixture.driver.FinalizePersistentHelper(context.Background(), fixture.journal); err != nil {
		t.Fatal(err)
	}
	fixture.host.mu.Lock()
	disabled, removed := fixture.host.disableCount, fixture.host.removeCount
	fixture.host.mu.Unlock()
	if disabled != 2 || removed != 0 {
		t.Fatalf("helper self-finalization disabled=%d removed=%d", disabled, removed)
	}
	if err := fixture.driver.CleanupTerminalHelper(context.Background(), fixture.journal); err != nil {
		t.Fatal(err)
	}
	fixture.host.mu.Lock()
	removed = fixture.host.removeCount
	fixture.host.mu.Unlock()
	if removed != 1 {
		t.Fatalf("stable cleanup remove count = %d", removed)
	}
}

func TestInvalidEvidenceAndUnavailableDataFailClosed(t *testing.T) {
	fixture := newHelperFixture(t)
	fixture.advanceForward(handoff.PhaseTargetStarted)
	fixture.participants.ack.ProofSHA256 = "invalid"
	if _, err := fixture.driver.TargetAcknowledgement(context.Background(), fixture.journal); err == nil {
		t.Fatal("invalid target acknowledgement was accepted")
	}

	data := &fakeData{log: &callLog{}, validateErr: errors.New("missing sqlite transformer")}
	_, err := New(Options{
		TransactionDirectory: filepath.Join(fixture.store.Root(), fixture.journal.TransactionID), Bindings: fixture.bindings,
		Runtime: fixture.runtime, Data: data, Participants: fixture.participants, SourceRelease: &fakeSourceRelease{log: &callLog{}}, HelperHost: fixture.host,
	})
	if !errors.Is(err, ErrDataUnavailable) {
		t.Fatalf("unavailable data adapter error = %v", err)
	}
}

func TestSourceOwnerMethodsRemainUnavailableInHelperProcess(t *testing.T) {
	fixture := newHelperFixture(t)
	if _, err := fixture.driver.Preflight(context.Background(), handoffownerBridgeRequestForTest(), identity.SourceProfile(), identity.TargetProfile()); !errors.Is(err, ErrSourceOwnerOnly) {
		t.Fatalf("helper preflight error = %v", err)
	}
	if err := fixture.driver.ArmPersistentHelper(context.Background(), fixture.journal); !errors.Is(err, ErrSourceOwnerOnly) {
		t.Fatalf("helper arm error = %v", err)
	}
	if _, err := fixture.driver.AcquireRuntimeObservationLease(context.Background()); !errors.Is(err, ErrSourceOwnerOnly) {
		t.Fatalf("helper observation error = %v", err)
	}
}

// Avoid importing release fixtures into this package: Preflight rejects the
// call before inspecting its request.
func handoffownerBridgeRequestForTest() handoffowner.BridgeRequest {
	return handoffowner.BridgeRequest{}
}

func TestStartFailsClosedWhenIssuerCannotBeEstablished(t *testing.T) {
	fixture := newHelperFixture(t)
	fixture.advanceForward(handoff.PhaseDataRelocated)
	fixture.issuer.newErr = fmt.Errorf("issuer unavailable")
	if err := fixture.driver.StartTarget(context.Background(), fixture.journal, fixture.helper.StartupLease()); err == nil {
		t.Fatal("participant started without a startup issuer")
	}
	if got := fixture.log.snapshot(); len(got) != 0 {
		t.Fatalf("participant was called after issuer failure: %v", got)
	}
}

func TestStartReplayUsesExactParticipantProofWithoutSecondIssuer(t *testing.T) {
	fixture := newHelperFixture(t)
	fixture.advanceForward(handoff.PhaseDataRelocated)
	fixture.participants.started = true
	if err := fixture.driver.StartTarget(context.Background(), fixture.journal, fixture.helper.StartupLease()); err != nil {
		t.Fatal(err)
	}
	if fixture.issuer.created != 0 || fixture.issuer.served != 0 {
		t.Fatal("already-started participant was issued a second one-shot capability")
	}
	if got := fixture.log.snapshot(); len(got) != 0 {
		t.Fatalf("already-started participant was started again: %v", got)
	}
}
