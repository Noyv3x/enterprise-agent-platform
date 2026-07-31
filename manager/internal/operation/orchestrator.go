package operation

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/driver"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/journal"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/logstore"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

type Snapshotter interface {
	Create(context.Context, string) (string, error)
	Restore(context.Context, string) error
}

type SelfUpdater interface {
	Prepare(context.Context, release.Manifest) error
	DiscardPrepared(release.Manifest) error
	MarkPlatformCommitted(release.Manifest) error
	Activate(context.Context, release.Manifest) error
	ActivationCommitted(release.Manifest) (bool, error)
	ActivationRolledBack(release.Manifest) (bool, error)
}

type Orchestrator struct {
	Store                *journal.Store
	Engine               driver.Engine
	Gate                 Gate
	Snapshots            Snapshotter
	SelfUpdate           SelfUpdater
	TechnicalProfile     identity.ActiveProfile
	DataRoot             string
	ReleasesDir          string
	ManifestURL          string
	Channel              string
	ReleaseClient        release.Client
	Log                  *logstore.Store
	Now                  func() time.Time
	Sleep                func(context.Context, time.Duration) error
	PollInterval         time.Duration
	OnCommit             func(release.Manifest)
	OnFinalized          func(release.Manifest)
	PublicProbe          func(context.Context) error
	LocalActiveProcesses func() int
	FixedStackMu         sync.Locker
	MaintenanceMu        sync.Locker
	// HandoffAdmission is acquired before MaintenanceMu for every ordinary
	// operation publication boundary. A source-owner Manager uses it to retain
	// the deployment-wide handoff observation lock and reject a nonterminal
	// namespace transaction. The returned release function must be idempotent.
	HandoffAdmission func(context.Context) (release func(), err error)
	// NamespaceHandoffCheck is installed only by the complete source-owner
	// application. It receives the already validated and immutably retained
	// bridge manifest identity after the ordinary observation lease is released,
	// and must route it to the handoff coordinator. Ordinary update execution
	// still rejects the descriptor; the coordinator is its only mutation owner.
	NamespaceHandoffCheck func(context.Context, release.Manifest, string, string) error
	ReclaimCapacity       func(context.Context, string, release.Manifest) error
	mu                    sync.Mutex
	finalizeMu            sync.Mutex
	rollbackMu            sync.Mutex
	running               map[string]context.CancelFunc
}

const reservationReleaseTimeout = 10 * time.Second
const reservationRetrySeparator = "\n--- latest reservation release retry ---\n"

type reservationReleaseUncertainError struct{ cause error }

func (e *reservationReleaseUncertainError) Error() string { return e.cause.Error() }
func (e *reservationReleaseUncertainError) Unwrap() error { return e.cause }

type retainedGenerationSlot string

const (
	retainedGenerationCurrent  retainedGenerationSlot = "current"
	retainedGenerationPrevious retainedGenerationSlot = "previous"
)

// retainedSourceAbortGate is deliberately narrower than Gate. Only the source
// profile's exact, locally retained public predecessor may opt into the one
// legacy endpoint needed to abort its reservation. Ordinary fakes, target
// Managers, remote manifests and future generations never acquire this method.
type retainedSourceAbortGate interface {
	releaseRetainedSourcePredecessor(context.Context, string, string) error
}

func (o *Orchestrator) Preflight(ctx context.Context) error {
	if err := o.Engine.Preflight(ctx); err != nil {
		return err
	}
	for _, path := range []string{o.ReleasesDir} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			return err
		}
	}
	return nil
}
func (o *Orchestrator) Check(ctx context.Context, url string) (release.Manifest, error) {
	if url == "" {
		url = o.ManifestURL
	}
	manifest, data, err := o.ReleaseClient.Fetch(ctx, url, o.Channel)
	if err != nil {
		return release.Manifest{}, err
	}
	if manifest.NamespaceHandoff != nil && o.NamespaceHandoffCheck == nil {
		return release.Manifest{}, errors.New("namespace handoff requires the complete handoff owner and cannot run as an ordinary update")
	}
	if manifest.NamespaceHandoff == nil {
		if err := rejectUnownedNamespaceHandoff(manifest); err != nil {
			return release.Manifest{}, err
		}
	}
	if manifest.NamespaceHandoff != nil {
		// Retain bytes and clear any old check-only Candidate while following the
		// ordinary global->runtime lock order. Release that observation before
		// entering Coordinator.Begin, which takes the same global lock and then
		// acquires its stronger runtime freeze. Re-entering while held deadlocks;
		// publishing a Candidate would let runUpdate misinterpret the bridge.
		unlockMaintenance, lockErr := o.lockMaintenanceAdmission(ctx)
		if lockErr != nil {
			return release.Manifest{}, lockErr
		}
		path, saveErr := o.saveManifest(ctx, manifest, data)
		if saveErr == nil {
			_, saveErr = o.Store.MutateState(o.now(), func(state *model.ManagerState) error {
				state.Candidate = nil
				state.LastError = ""
				return nil
			})
		}
		unlockMaintenance()
		if saveErr != nil {
			return release.Manifest{}, saveErr
		}
		digest := sha256.Sum256(data)
		if err := o.NamespaceHandoffCheck(ctx, manifest, path, fmt.Sprintf("%x", digest[:])); err != nil {
			return release.Manifest{}, err
		}
		return manifest, nil
	}
	unlockMaintenance, err := o.lockMaintenanceAdmission(ctx)
	if err != nil {
		return release.Manifest{}, err
	}
	defer unlockMaintenance()
	path, err := o.saveManifest(ctx, manifest, data)
	if err != nil {
		return release.Manifest{}, err
	}
	_, err = o.Store.MutateState(o.now(), func(state *model.ManagerState) error {
		if state.Current != nil && state.Current.ID == manifest.ID() {
			state.Candidate = nil
		} else {
			state.Candidate = generation(manifest, path)
		}
		state.LastError = ""
		return nil
	})
	return manifest, err
}
func (o *Orchestrator) Start(request model.OperationRequest) (model.Operation, bool, error) {
	unlockMaintenance, err := o.lockMaintenanceAdmission(context.Background())
	if err != nil {
		return model.Operation{}, false, err
	}
	defer unlockMaintenance()
	o.mu.Lock()
	op, reused, err := o.Store.Begin(request, o.now())
	if err != nil || reused {
		o.mu.Unlock()
		return op, reused, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	if o.running == nil {
		o.running = map[string]context.CancelFunc{}
	}
	o.running[op.ID] = cancel
	o.mu.Unlock()
	go func() {
		defer func() { o.mu.Lock(); delete(o.running, op.ID); o.mu.Unlock(); cancel() }()
		o.run(ctx, op)
	}()
	return op, false, nil
}
func (o *Orchestrator) Await(ctx context.Context, id string) (model.Operation, error) {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		op, err := o.Store.Operation(id)
		if err != nil {
			return model.Operation{}, err
		}
		if op.Status == model.OperationFailed {
			return op, nil
		}
		if op.Status == model.OperationSucceeded && op.Finalized && o.Store.State().FinalizePendingOperationID != op.ID {
			return op, nil
		}
		select {
		case <-ctx.Done():
			return model.Operation{}, ctx.Err()
		case <-ticker.C:
		}
	}
}

// RecoverBeforeActivation validates the durable operation journal while the
// active-binary watchdog can still reject the candidate Manager. Finalize hooks
// are deliberately withheld until the watchdog has committed the candidate
// binary.
func (o *Orchestrator) RecoverBeforeActivation(ctx context.Context) error {
	unlockMaintenance, err := o.lockMaintenanceAdmission(ctx)
	if err != nil {
		return err
	}
	defer unlockMaintenance()
	return o.recover(ctx, false, true)
}

func (o *Orchestrator) Recover(ctx context.Context) error {
	unlockMaintenance, err := o.lockMaintenanceAdmission(ctx)
	if err != nil {
		return err
	}
	defer unlockMaintenance()
	return o.recover(ctx, true, false)
}

func (o *Orchestrator) lockMaintenanceAdmission(ctx context.Context) (func(), error) {
	releaseHandoff := func() {}
	if o.HandoffAdmission != nil {
		var err error
		releaseHandoff, err = o.HandoffAdmission(ctx)
		if err != nil {
			return nil, err
		}
		if releaseHandoff == nil {
			return nil, errors.New("handoff admission returned a nil release function")
		}
	}
	if o.MaintenanceMu == nil {
		return releaseHandoff, nil
	}
	o.MaintenanceMu.Lock()
	return func() {
		o.MaintenanceMu.Unlock()
		releaseHandoff()
	}, nil
}

func (o *Orchestrator) RecoveryPending() bool {
	state := o.Store.State()
	if state.FinalizePendingOperationID != "" {
		return true
	}
	if state.ActiveOperationID == "" {
		return false
	}
	o.mu.Lock()
	_, running := o.running[state.ActiveOperationID]
	o.mu.Unlock()
	return !running
}

func (o *Orchestrator) recover(ctx context.Context, runFinalizeHooks, activationPreflight bool) error {
	state := o.Store.State()
	if state.FinalizePendingOperationID != "" {
		return o.recoverFinalize(ctx, state, runFinalizeHooks)
	}
	op, err := o.Store.RecoverActive()
	if err != nil {
		return err
	}
	if op == nil {
		return nil
	}
	if op.PreparedCleanupPending {
		return o.recoverPreparedCleanup(*op)
	}
	if op.ManagerActivationRollback {
		return o.recoverManagerActivationRollback(ctx, *op)
	}
	// A terminal operation can be durable while Manager state still names it as
	// active. Resolve that half-commit before inspecting reservation checkpoints:
	// inverse cleanup deliberately retains the old reservation fields, and must
	// never be routed back through reservation or update recovery after its
	// terminal write has cleared PreparedCleanupPending.
	if op.Status == model.OperationFailed {
		state = o.Store.State()
		if state.Maintenance {
			return o.recoverRollback(ctx, *op)
		}
		_, err = o.Store.Complete(op.ID, false, func(value *model.ManagerState) {
			value.Candidate = nil
			value.PublicState = model.StateIdle
			value.Maintenance = false
			value.LastError = op.Error
			value.RetryAfterSeconds = 0
		}, op.Error, o.now())
		return err
	}
	if op.ReservationStatus == model.ReservationConfirmationPending || op.ReservationStatus == model.ReservationConfirmed || op.ReservationStatus == model.ReservationReleaseUncertain {
		return o.recoverUnconfirmedReservation(ctx, *op)
	}
	state = o.Store.State()
	if op.Status == model.OperationSucceeded && state.Candidate != nil && op.TargetGeneration == state.Candidate.ID {
		manifest, loadErr := o.loadManifest(state.Candidate.ManifestPath)
		if loadErr != nil {
			return loadErr
		}
		if probeErr := o.probeCommittedGeneration(ctx, manifest); probeErr != nil {
			o.failAfterMaintenance(ctx, *op, &manifest, fmt.Errorf("recover half-committed generation: %w", probeErr))
			return nil
		}
		now := o.now()
		_, err = o.Store.Complete(op.ID, true, func(value *model.ManagerState) {
			value.Previous = value.Current
			value.Current = value.Candidate
			value.Current.RollbackSnapshotPath = op.SnapshotPath
			value.Current.ActivatedAt = now
			value.Candidate = nil
			value.FinalizePendingOperationID = op.ID
			value.PublicState = model.StateUpdating
			value.Maintenance = true
			value.LastError = ""
		}, "", now)
		if err == nil && runFinalizeHooks {
			err = o.finalizeCommitted(ctx, *op, manifest)
		}
		return err
	}
	if !state.Maintenance && (op.Phase == model.PhaseValidating || op.Phase == model.PhasePulling || op.Phase == model.PhasePreparing || op.Phase == model.PhaseDraining) {
		if activationPreflight {
			return fmt.Errorf("candidate Manager activation is blocked by unfinished operation %s in phase %s", op.ID, op.Phase)
		}
		resume, cancel := context.WithCancel(context.Background())
		o.mu.Lock()
		if o.running == nil {
			o.running = map[string]context.CancelFunc{}
		}
		if _, exists := o.running[op.ID]; exists {
			o.mu.Unlock()
			cancel()
			return nil
		}
		o.running[op.ID] = cancel
		o.mu.Unlock()
		go func() {
			defer func() {
				o.mu.Lock()
				delete(o.running, op.ID)
				o.mu.Unlock()
				cancel()
			}()
			o.run(resume, *op)
		}()
		return nil
	}
	return o.recoverRollback(ctx, *op)
}

func (o *Orchestrator) recoverFinalize(ctx context.Context, state model.ManagerState, runHooks bool) error {
	op, err := o.Store.Operation(state.FinalizePendingOperationID)
	if err != nil {
		return fmt.Errorf("load pending finalize operation: %w", err)
	}
	if op.ManagerActivationRollback {
		return o.recoverManagerActivationRollback(ctx, op)
	}
	if op.Status != model.OperationSucceeded {
		return fmt.Errorf("pending finalize operation %s is not succeeded", op.ID)
	}
	if state.Current == nil || state.Current.ManifestPath == "" || op.TargetGeneration != state.Current.ID {
		return errors.New("pending finalize generation does not match current generation")
	}
	manifest, err := o.loadStateManifest(state.Current, retainedGenerationCurrent)
	if err != nil {
		return err
	}
	if !runHooks {
		if err = o.probeCommittedGeneration(ctx, manifest); err != nil {
			return o.finalizeFailure("committed generation readiness is pending", err)
		}
		return nil
	}
	return o.finalizeCommitted(ctx, op, manifest)
}

func (o *Orchestrator) probeCommittedGeneration(ctx context.Context, manifest release.Manifest) error {
	if err := o.Engine.Probe(ctx, manifest); err != nil {
		return fmt.Errorf("core readiness: %w", err)
	}
	if o.PublicProbe != nil {
		if err := o.PublicProbe(ctx); err != nil {
			return fmt.Errorf("public gateway readiness: %w", err)
		}
	}
	return nil
}

func (o *Orchestrator) run(ctx context.Context, op model.Operation) {
	switch op.Kind {
	case model.OperationInstall, model.OperationUpdate:
		o.runUpdate(ctx, op)
	case model.OperationRestart:
		o.runRestart(ctx, op)
	case model.OperationRollback:
		o.runRollback(ctx, op)
	case model.OperationRepair:
		o.withFixedStack(func() { o.runRepair(ctx, op) })
	default:
		o.failBeforeMaintenance(op, fmt.Errorf("unsupported operation %q", op.Kind))
	}
}

func (o *Orchestrator) withFixedStack(run func()) {
	if o.FixedStackMu != nil {
		o.FixedStackMu.Lock()
		defer o.FixedStackMu.Unlock()
	}
	run()
}

func (o *Orchestrator) runUpdate(ctx context.Context, op model.Operation) {
	url := op.TargetManifestURL
	if url == "" {
		url = o.ManifestURL
	}
	if _, err := o.Store.SetPhase(op.ID, model.PhaseValidating, model.StateIdle, false, "validating release catalog and immutable artifacts", o.now()); err != nil {
		o.failBeforeMaintenance(op, fmt.Errorf("persist validation phase: %w", err))
		return
	}
	var manifest release.Manifest
	var data []byte
	var err error
	for {
		manifest, data, err = o.ReleaseClient.Fetch(ctx, url, o.Channel)
		if err == nil {
			break
		}
		temporarilyUnavailable := release.IsTemporarilyUnavailable(err)
		if op.Kind != model.OperationInstall || !temporarilyUnavailable {
			if temporarilyUnavailable {
				o.failBeforeMaintenanceRetryable(op, err)
			} else {
				o.failBeforeMaintenance(op, err)
			}
			return
		}
		if _, stateErr := o.Store.MutateState(o.now(), func(state *model.ManagerState) error {
			state.PublicState = model.StateWaitingForTasks
			state.Maintenance = false
			state.LastError = "release is not ready; the current generation remains online"
			state.RetryAfterSeconds = int(o.pollInterval() / time.Second)
			return nil
		}); stateErr != nil {
			o.failBeforeMaintenance(op, fmt.Errorf("persist release wait state: %w", stateErr))
			return
		}
		if err = o.wait(ctx, o.pollInterval()); err != nil {
			o.failBeforeMaintenance(op, err)
			return
		}
	}
	if err = rejectUnownedNamespaceHandoff(manifest); err != nil {
		o.failBeforeMaintenance(op, err)
		return
	}
	if checker, ok := o.Engine.(driver.CapacityChecker); ok {
		if err = o.checkCapacity(ctx, checker, op.ID, driver.CapacityPreDownload, manifest); err != nil {
			o.failBeforeMaintenanceRetryable(op, err)
			return
		}
	}
	path, err := o.saveManifest(ctx, manifest, data)
	if err != nil {
		if release.IsTemporarilyUnavailable(err) {
			o.failBeforeMaintenanceRetryable(op, err)
		} else {
			o.failBeforeMaintenance(op, err)
		}
		return
	}
	if _, err = o.Store.UpdateOperation(op.ID, func(value *model.Operation) error {
		value.TargetGeneration = manifest.ID()
		value.UpdatedAt = o.now()
		return nil
	}); err != nil {
		o.failBeforeMaintenance(op, fmt.Errorf("persist target generation: %w", err))
		return
	}
	op.TargetGeneration = manifest.ID()
	if _, err = o.Store.MutateState(o.now(), func(state *model.ManagerState) error { state.Candidate = generation(manifest, path); return nil }); err != nil {
		o.failBeforeMaintenance(op, fmt.Errorf("persist candidate generation: %w", err))
		return
	}
	if o.SelfUpdate != nil {
		if err = o.SelfUpdate.Prepare(ctx, manifest); err != nil {
			o.failPreparedBeforeMaintenance(op, manifest, path, err, release.IsTemporarilyUnavailable(err))
			return
		}
	}
	if _, err = o.Store.SetPhase(op.ID, model.PhasePulling, model.StateIdle, false, "pulling immutable image digests", o.now()); err != nil {
		o.failPreparedBeforeMaintenance(op, manifest, path, fmt.Errorf("persist pulling phase: %w", err), false)
		return
	}
	if err = o.pullWithCapacityRetry(ctx, op.ID, manifest); err != nil {
		o.failPreparedBeforeMaintenance(op, manifest, path, err, true)
		return
	}
	if _, err = o.Store.SetPhase(op.ID, model.PhasePreparing, model.StateWaitingForTasks, false, "candidate is prepared", o.now()); err != nil {
		o.failPreparedBeforeMaintenance(op, manifest, path, fmt.Errorf("persist preparing phase: %w", err), false)
		return
	}
	if err = o.Engine.Prepare(ctx, manifest); err != nil {
		o.failPreparedBeforeMaintenance(op, manifest, path, err, false)
		return
	}
	if checker, ok := o.Engine.(driver.CapacityChecker); ok {
		if err = o.checkCapacity(ctx, checker, op.ID, driver.CapacityPreCutover, manifest); err != nil {
			o.failPreparedBeforeMaintenance(op, manifest, path, err, true)
			return
		}
	}
	stateBeforeCutover := o.Store.State()
	freshInstall := op.Kind == model.OperationInstall && stateBeforeCutover.Current == nil
	if !freshInstall {
		if err = o.reserve(ctx, op.ID); err != nil {
			o.failPreparedReservation(op, manifest, path, err)
			return
		}
	}
	if o.FixedStackMu != nil {
		o.FixedStackMu.Lock()
		defer o.FixedStackMu.Unlock()
	}
	// Platform admission is now quiesced and capability reconciliation is excluded
	// by FixedStackMu. Re-read both the snapshot sources and ordinary-user
	// filesystem capacity at this final non-destructive boundary. A shortfall must
	// release the reservation before the current writer is stopped.
	if checker, ok := o.Engine.(driver.CapacityChecker); ok {
		if err = checker.CheckCapacity(ctx, driver.CapacityPreCutover, manifest); err != nil {
			if freshInstall {
				o.failPreparedBeforeMaintenance(op, manifest, path, fmt.Errorf("recheck capacity before fresh-install writer start: %w", err), true)
				return
			}
			o.failReservedCapacityRecheck(op, manifest, path, err)
			return
		}
	}
	if freshInstall {
		if _, err = o.Store.SetPhase(op.ID, model.PhaseDraining, model.StateUpdating, true, "fresh install entering maintenance", o.now()); err != nil {
			o.failPreparedBeforeMaintenance(op, manifest, path, fmt.Errorf("persist fresh-install maintenance phase: %w", err), false)
			return
		}
		preparer, ok := o.Engine.(driver.FreshInstallDataPreparer)
		if !ok {
			o.failAfterMaintenance(ctx, op, nil, errors.New("fresh install data layout preparation is unavailable"))
			return
		}
		if err = preparer.PrepareFreshInstallDataLayout(); err != nil {
			o.failAfterMaintenance(ctx, op, nil, fmt.Errorf("prepare fresh-install data layout: %w", err))
			return
		}
	}
	if !freshInstall {
		if err = o.beginReservedMutation(op.ID); err != nil {
			o.failPreparedReservation(op, manifest, path, err)
			return
		}
	}
	if err = o.Engine.StopFixed(ctx); err != nil {
		o.failAfterMaintenance(ctx, op, nil, err)
		return
	}
	snapshotPath, err := o.snapshot(ctx, op.ID)
	if err != nil {
		o.failAfterMaintenance(ctx, op, nil, err)
		return
	}
	if _, err = o.Store.UpdateOperation(op.ID, func(value *model.Operation) error {
		value.SnapshotPath = snapshotPath
		value.UpdatedAt = o.now()
		return nil
	}); err != nil {
		o.failAfterMaintenance(ctx, op, nil, fmt.Errorf("persist rollback snapshot: %w", err))
		return
	}
	if _, err = o.Store.SetPhase(op.ID, model.PhaseMigrating, model.StateUpdating, true, "running versioned migrations", o.now()); err != nil {
		o.failAfterMaintenance(ctx, op, nil, fmt.Errorf("persist migration phase: %w", err))
		return
	}
	if err = o.Engine.Migrate(ctx, manifest); err != nil {
		o.failAfterMaintenance(ctx, op, &manifest, err)
		return
	}
	if _, err = o.Store.SetPhase(op.ID, model.PhaseStarting, model.StateUpdating, true, "starting target generation", o.now()); err != nil {
		o.failAfterMaintenance(ctx, op, &manifest, fmt.Errorf("persist target start phase: %w", err))
		return
	}
	if err = o.Engine.StartFixed(ctx, manifest); err != nil {
		o.failAfterMaintenance(ctx, op, &manifest, err)
		return
	}
	if _, err = o.Store.SetPhase(op.ID, model.PhaseProbing, model.StateUpdating, true, "probing core readiness", o.now()); err != nil {
		o.failAfterMaintenance(ctx, op, &manifest, fmt.Errorf("persist probe phase: %w", err))
		return
	}
	if err = o.Engine.Probe(ctx, manifest); err != nil {
		o.failAfterMaintenance(ctx, op, &manifest, err)
		return
	}
	if o.PublicProbe != nil {
		if err = o.PublicProbe(ctx); err != nil {
			o.failAfterMaintenance(ctx, op, &manifest, fmt.Errorf("public gateway readiness: %w", err))
			return
		}
	}
	if _, err = o.Store.SetPhase(op.ID, model.PhaseCommitting, model.StateUpdating, true, "committing generation", o.now()); err != nil {
		o.failAfterMaintenance(ctx, op, &manifest, fmt.Errorf("persist commit phase: %w", err))
		return
	}
	now := o.now()
	_, err = o.Store.Complete(op.ID, true, func(state *model.ManagerState) {
		state.Previous = state.Current
		state.Current = generation(manifest, path)
		state.Current.RollbackSnapshotPath = snapshotPath
		state.Current.ActivatedAt = now
		state.Candidate = nil
		state.FinalizePendingOperationID = op.ID
		state.PublicState = model.StateUpdating
		state.Maintenance = true
		state.LastError = ""
		state.RetryAfterSeconds = 0
	}, "", now)
	if err == nil {
		_ = o.finalizeCommitted(context.Background(), op, manifest)
	}
}

func rejectUnownedNamespaceHandoff(manifest release.Manifest) error {
	if manifest.NamespaceHandoff != nil {
		return errors.New("namespace handoff requires the complete handoff owner and cannot run as an ordinary update")
	}
	return nil
}

func (o *Orchestrator) checkCapacity(ctx context.Context, checker driver.CapacityChecker, operationID, stage string, manifest release.Manifest) error {
	err := checker.CheckCapacity(ctx, stage, manifest)
	if err == nil || !driver.IsInsufficientCapacity(err) || o.ReclaimCapacity == nil {
		return err
	}
	reclaimErr := o.ReclaimCapacity(ctx, operationID, manifest)
	retryErr := checker.CheckCapacity(ctx, stage, manifest)
	if retryErr == nil {
		return nil
	}
	if reclaimErr != nil {
		return errors.Join(retryErr, fmt.Errorf("controlled maintenance before capacity retry: %w", reclaimErr))
	}
	return retryErr
}

func (o *Orchestrator) pullWithCapacityRetry(ctx context.Context, operationID string, manifest release.Manifest) error {
	err := o.Engine.Pull(ctx, manifest)
	if err == nil || !driver.IsInsufficientCapacity(err) || o.ReclaimCapacity == nil {
		return err
	}
	reclaimErr := o.ReclaimCapacity(ctx, operationID, manifest)
	retryErr := o.Engine.Pull(ctx, manifest)
	if retryErr == nil {
		return nil
	}
	if reclaimErr != nil {
		return errors.Join(retryErr, fmt.Errorf("controlled maintenance before image pull retry: %w", reclaimErr))
	}
	return retryErr
}

func (o *Orchestrator) failReservedCapacityRecheck(op model.Operation, manifest release.Manifest, path string, cause error) {
	released := o.resolveReservationUncertainty(o.Gate, op.ID, fmt.Errorf("recheck capacity after admission reservation: %w", cause))
	var uncertain *reservationReleaseUncertainError
	if errors.As(released, &uncertain) {
		o.failReservation(op, released)
		return
	}
	o.failPreparedBeforeMaintenance(op, manifest, path, released, true)
}

func (o *Orchestrator) finalizeCommitted(ctx context.Context, op model.Operation, manifest release.Manifest) error {
	o.finalizeMu.Lock()
	defer o.finalizeMu.Unlock()
	stateBefore := o.Store.State()
	if stateBefore.FinalizePendingOperationID == "" {
		return nil
	}
	if stateBefore.FinalizePendingOperationID != op.ID {
		return errors.New("pending finalize operation changed")
	}
	watchdogCommitted := false
	if !op.Finalized {
		isGenerationChange := op.Kind == model.OperationInstall || op.Kind == model.OperationUpdate
		if isGenerationChange && o.SelfUpdate != nil {
			rolledBack, selfErr := o.SelfUpdate.ActivationRolledBack(manifest)
			if selfErr != nil {
				return o.finalizeFailure("manager activation rollback evidence is invalid", selfErr)
			}
			if rolledBack {
				return o.beginManagerActivationRollback(ctx, op, manifest)
			}
			if selfErr := o.SelfUpdate.MarkPlatformCommitted(manifest); selfErr != nil {
				return o.finalizeFailure("manager binary could not be committed", selfErr)
			}
			if selfErr := o.SelfUpdate.Activate(ctx, manifest); selfErr != nil {
				return o.finalizeFailure("manager activation is pending", selfErr)
			}
			committed, selfErr := o.SelfUpdate.ActivationCommitted(manifest)
			if selfErr != nil {
				return o.finalizeFailure("manager activation acknowledgement is pending", selfErr)
			}
			if !committed {
				// The old process normally reaches this point immediately after queuing
				// its own restart. Finalization is intentionally deferred until the
				// watchdog has observed and committed a healthy new Manager.
				return o.finalizeFailure("manager activation acknowledgement is pending", errors.New("watchdog has not committed the candidate Manager"))
			}
			watchdogCommitted = true
		}
		if (isGenerationChange || op.Kind == model.OperationRollback) && o.OnCommit != nil {
			o.OnCommit(manifest)
		}
	}
	// Activation and commit hooks can take long enough for a previously healthy
	// core container or the public listener to change underneath us. Re-probe at
	// the final reservation boundary, including crash recovery after the
	// operation journal was finalized but Manager state was not yet cleared.
	if err := o.probeCommittedGeneration(ctx, manifest); err != nil {
		return o.finalizeFailure("final committed generation readiness is pending", err)
	}
	if !op.Finalized {
		// Persist the exact effect that really crossed the external Gate. A
		// generation operation without a SelfUpdate owner retains its supported
		// abort behavior; only durable watchdog evidence grants commit authority.
		action := model.GateSettlementAbort
		if watchdogCommitted {
			action = model.GateSettlementCommit
		}
		if action == model.GateSettlementAbort && op.Kind == model.OperationUpdate &&
			stateBefore.Previous != nil &&
			stateBefore.Previous.ID == contract.SourceOwnerCompatGeneration &&
			stateBefore.Previous.SourceCommit == contract.SourceOwnerCompatGeneration {
			return o.finalizeFailure(
				"P1 workspace normalization requires a committed Manager activation",
				errors.New("watchdog did not authorize the machine-schema commit Gate"),
			)
		}
		releaseErr := o.settleGate(ctx, op.ID, op.Kind, action)
		if releaseErr != nil {
			return o.finalizeFailure("update reservation release is pending", releaseErr)
		}
		o.event(op.ID, "operation.committed", manifest.ID(), nil)
		var err error
		if op, err = o.Store.UpdateOperation(op.ID, func(value *model.Operation) error {
			if value.Status != model.OperationSucceeded {
				return errors.New("cannot finalize a non-succeeded operation")
			}
			value.Finalized = true
			value.GateSettlementAction = action
			value.UpdatedAt = o.now()
			return nil
		}); err != nil {
			return err
		}
	}
	// Finalized and finalize_pending are separate durable files. Persisting
	// Finalized first makes /v1/status.gate_settlement authoritative for a
	// Platform that restarts in this window. Always replay the idempotent Gate
	// after that checkpoint, then and only then clear Manager maintenance state.
	// Recovery enters here with Finalized already true and therefore repeats no
	// SelfUpdate, OnCommit, or audit hook.
	if releaseErr := o.reconcileFinalizedGate(ctx, op); releaseErr != nil {
		return o.finalizeFailure("update reservation reconciliation is pending", releaseErr)
	}
	_, err := o.Store.MutateState(o.now(), func(state *model.ManagerState) error {
		if state.FinalizePendingOperationID != op.ID {
			return errors.New("pending finalize operation changed")
		}
		state.FinalizePendingOperationID = ""
		state.PublicState = model.StateIdle
		state.Maintenance = false
		state.LastError = ""
		state.RetryAfterSeconds = 0
		return nil
	})
	if err != nil {
		return err
	}
	if o.OnFinalized != nil {
		o.OnFinalized(manifest)
	}
	return nil
}

func (o *Orchestrator) reconcileFinalizedGate(ctx context.Context, op model.Operation) error {
	return o.settleGate(ctx, op.ID, op.Kind, op.GateSettlementAction)
}

func (o *Orchestrator) settleGate(ctx context.Context, operationID string, kind model.OperationKind, action model.GateSettlementAction) error {
	switch action {
	case model.GateSettlementCommit:
		if kind != model.OperationInstall && kind != model.OperationUpdate {
			return fmt.Errorf("operation kind %q cannot commit the reservation Gate", kind)
		}
		if o.Gate == nil {
			return errors.New("platform admission gate is not configured for commit")
		}
		return o.Gate.Commit(ctx, operationID)
	case model.GateSettlementAbort:
		switch kind {
		case model.OperationInstall, model.OperationUpdate, model.OperationRestart, model.OperationRollback, model.OperationRepair:
			return o.releaseGate(ctx, o.Gate, operationID)
		default:
			return fmt.Errorf("operation kind %q cannot abort the reservation Gate", kind)
		}
	default:
		return fmt.Errorf("operation %s has invalid reservation Gate settlement %q", operationID, action)
	}
}

func (o *Orchestrator) beginManagerActivationRollback(ctx context.Context, op model.Operation, manifest release.Manifest) error {
	durable, err := o.Store.Operation(op.ID)
	if err != nil {
		return o.finalizeFailure("load Manager activation rollback operation", err)
	}
	op = durable
	state := o.Store.State()
	if op.Kind != model.OperationUpdate || state.FinalizePendingOperationID != op.ID ||
		state.Current == nil || state.Current.ID != manifest.ID() || state.Previous == nil ||
		state.Previous.ID == "" || state.Previous.ManifestPath == "" || op.SnapshotPath == "" ||
		op.ReservationStatus != model.ReservationMutationStarted {
		return o.finalizeFailure("manager activation rollback cannot restore the previous generation", errors.New("committed update rollback evidence is incomplete"))
	}
	message := journal.BoundDiagnostic("Manager candidate was rejected by its activation watchdog; restoring the previous Platform generation")
	updated, err := o.Store.UpdateOperation(op.ID, func(value *model.Operation) error {
		if value.Status != model.OperationSucceeded || value.TargetGeneration != manifest.ID() {
			return errors.New("committed update operation changed before Manager rollback")
		}
		value.ManagerActivationRollback = true
		value.ManagerRollbackGeneration = state.Previous.ID
		value.Status = model.OperationRunning
		value.Finalized = false
		value.GateSettlementAction = ""
		value.Retryable = true
		value.Phase = model.PhaseRollingBack
		value.CompletedAt = nil
		value.Error = message
		value.History = append(value.History, model.PhaseEvent{Phase: model.PhaseRollingBack, At: o.now(), Note: "Manager watchdog rejected candidate; restoring previous generation"})
		value.UpdatedAt = o.now()
		return nil
	})
	if err != nil {
		return o.finalizeFailure("persist Manager activation rollback intent", err)
	}
	return o.recoverManagerActivationRollback(ctx, updated)
}

func (o *Orchestrator) recoverManagerActivationRollback(ctx context.Context, op model.Operation) error {
	if !op.ManagerActivationRollback || op.ManagerRollbackGeneration == "" || op.SnapshotPath == "" || op.Error == "" ||
		(op.Status != model.OperationRunning && op.Status != model.OperationFailed) {
		return errors.New("Manager activation rollback journal is incomplete")
	}
	state := o.Store.State()
	if state.FinalizePendingOperationID == op.ID {
		if state.ActiveOperationID != "" || state.Current == nil || state.Current.ID != op.TargetGeneration ||
			state.Previous == nil || state.Previous.ID != op.ManagerRollbackGeneration || state.Previous.ManifestPath == "" {
			return errors.New("pending Manager activation rollback does not match Platform generations")
		}
		if _, err := o.Store.MutateState(o.now(), func(value *model.ManagerState) error {
			if value.FinalizePendingOperationID != op.ID || value.ActiveOperationID != "" ||
				value.Current == nil || value.Current.ID != op.TargetGeneration || value.Previous == nil ||
				value.Previous.ID != op.ManagerRollbackGeneration {
				return errors.New("Manager activation rollback ownership changed")
			}
			previous := *value.Previous
			value.Current = &previous
			value.Previous = nil
			value.Candidate = nil
			value.ActiveOperationID = op.ID
			value.FinalizePendingOperationID = ""
			value.Phase = model.PhaseRollingBack
			value.PublicState = model.StateUpdating
			value.Maintenance = true
			value.LastError = op.Error
			value.RetryAfterSeconds = 0
			return nil
		}); err != nil {
			return fmt.Errorf("enter Manager activation Platform rollback: %w", err)
		}
		state = o.Store.State()
	}
	if state.ActiveOperationID == "" {
		current, err := o.Store.Operation(op.ID)
		if err == nil && current.Status == model.OperationFailed && current.Finalized {
			return nil
		}
		return errors.New("Manager activation rollback lost its active operation")
	}
	if state.ActiveOperationID != op.ID || state.FinalizePendingOperationID != "" || state.Current == nil ||
		state.Current.ID != op.ManagerRollbackGeneration || state.Previous != nil {
		return errors.New("active Manager activation rollback does not match the previous Platform generation")
	}
	current, err := o.Store.Operation(op.ID)
	if err != nil {
		return err
	}
	o.failAfterMaintenance(ctx, current, nil, errors.New(current.Error))
	completed, err := o.Store.Operation(op.ID)
	if err != nil {
		return err
	}
	finalState := o.Store.State()
	if completed.Status != model.OperationFailed || !completed.Finalized || !completed.Retryable ||
		finalState.ActiveOperationID != "" || finalState.FinalizePendingOperationID != "" ||
		finalState.Current == nil || finalState.Current.ID != op.ManagerRollbackGeneration || finalState.Maintenance {
		if finalState.LastError != "" {
			return errors.New(finalState.LastError)
		}
		return errors.New("Manager activation Platform rollback remains pending")
	}
	o.event(op.ID, "operation.failed", op.TargetGeneration, errors.New(completed.Error))
	return nil
}

func (o *Orchestrator) finalizeFailure(prefix string, cause error) error {
	message := journal.BoundDiagnostic(prefix + ": " + cause.Error())
	_, _ = o.Store.MutateState(o.now(), func(state *model.ManagerState) error {
		state.PublicState = model.StateUpdating
		state.Maintenance = true
		state.LastError = message
		return nil
	})
	return errors.New(message)
}

func (o *Orchestrator) runRestart(ctx context.Context, op model.Operation) {
	state := o.Store.State()
	if state.Current == nil {
		o.failBeforeMaintenance(op, errors.New("there is no current generation"))
		return
	}
	manifest, err := o.loadStateManifest(state.Current, retainedGenerationCurrent)
	if err != nil {
		o.failBeforeMaintenance(op, err)
		return
	}
	if _, err = o.Store.UpdateOperation(op.ID, func(value *model.Operation) error {
		value.TargetGeneration = state.Current.ID
		value.UpdatedAt = o.now()
		return nil
	}); err != nil {
		o.failBeforeMaintenance(op, fmt.Errorf("persist restart target generation: %w", err))
		return
	}
	op.TargetGeneration = state.Current.ID
	if err = o.reserve(ctx, op.ID); err != nil {
		o.failReservation(op, err)
		return
	}
	if o.FixedStackMu != nil {
		o.FixedStackMu.Lock()
		defer o.FixedStackMu.Unlock()
	}
	if err = o.beginReservedMutation(op.ID); err != nil {
		o.failReservation(op, err)
		return
	}
	if err = o.Engine.StopFixed(ctx); err != nil {
		o.failAfterMaintenance(ctx, op, nil, err)
		return
	}
	if _, err = o.Store.SetPhase(op.ID, model.PhaseStarting, model.StateUpdating, true, "restarting current generation", o.now()); err != nil {
		o.failAfterMaintenance(ctx, op, &manifest, fmt.Errorf("persist restart start phase: %w", err))
		return
	}
	if err = o.Engine.StartFixed(ctx, manifest); err != nil {
		o.failAfterMaintenance(ctx, op, &manifest, err)
		return
	}
	if _, err = o.Store.SetPhase(op.ID, model.PhaseProbing, model.StateUpdating, true, "probing restarted generation", o.now()); err != nil {
		o.failAfterMaintenance(ctx, op, &manifest, fmt.Errorf("persist restart probe phase: %w", err))
		return
	}
	if err = o.Engine.Probe(ctx, manifest); err != nil {
		o.failAfterMaintenance(ctx, op, &manifest, err)
		return
	}
	if _, err = o.Store.SetPhase(op.ID, model.PhaseCommitting, model.StateUpdating, true, "committing restarted generation", o.now()); err != nil {
		o.failAfterMaintenance(ctx, op, &manifest, fmt.Errorf("persist restart commit phase: %w", err))
		return
	}
	_, err = o.Store.Complete(op.ID, true, func(state *model.ManagerState) {
		state.FinalizePendingOperationID = op.ID
		state.PublicState = model.StateUpdating
		state.Maintenance = true
		state.LastError = ""
		state.RetryAfterSeconds = 0
	}, "", o.now())
	if err == nil {
		_ = o.finalizeCommitted(context.Background(), op, manifest)
	} else {
		o.failAfterMaintenance(ctx, op, &manifest, fmt.Errorf("persist restart finalize intent: %w", err))
	}
}
func (o *Orchestrator) runRollback(ctx context.Context, op model.Operation) {
	state := o.Store.State()
	if state.Previous == nil {
		o.failBeforeMaintenance(op, errors.New("there is no previous generation"))
		return
	}
	manifest, err := o.loadStateManifest(state.Previous, retainedGenerationPrevious)
	if err != nil {
		o.failBeforeMaintenance(op, err)
		return
	}
	if _, err = o.Store.UpdateOperation(op.ID, func(value *model.Operation) error {
		value.TargetGeneration = state.Previous.ID
		value.UpdatedAt = o.now()
		return nil
	}); err != nil {
		o.failBeforeMaintenance(op, fmt.Errorf("persist rollback target generation: %w", err))
		return
	}
	op.TargetGeneration = state.Previous.ID
	if _, err = o.Store.SetPhase(op.ID, model.PhasePulling, model.StateIdle, false, "ensuring previous core image digests", o.now()); err != nil {
		o.failBeforeMaintenance(op, fmt.Errorf("persist rollback image phase: %w", err))
		return
	}
	if err = o.pullWithCapacityRetry(ctx, op.ID, manifest); err != nil {
		o.failBeforeMaintenanceRetryable(op, fmt.Errorf("prepare previous generation images: %w", err))
		return
	}
	if err = o.reserve(ctx, op.ID); err != nil {
		o.failReservation(op, err)
		return
	}
	if o.FixedStackMu != nil {
		o.FixedStackMu.Lock()
		defer o.FixedStackMu.Unlock()
	}
	if err = o.beginReservedMutation(op.ID); err != nil {
		o.failReservation(op, err)
		return
	}
	if err = o.Engine.StopFixed(ctx); err != nil {
		o.failAfterMaintenance(ctx, op, nil, err)
		return
	}
	snapshotPath, err := o.snapshot(ctx, op.ID)
	if err != nil {
		o.failAfterMaintenance(ctx, op, nil, err)
		return
	}
	if _, err = o.Store.UpdateOperation(op.ID, func(value *model.Operation) error {
		value.SnapshotPath = snapshotPath
		value.UpdatedAt = o.now()
		return nil
	}); err != nil {
		o.haltAfterSnapshotJournalFailure(ctx, op, fmt.Errorf("persist rollback rescue snapshot: %w", err))
		return
	}
	op.SnapshotPath = snapshotPath
	if state.Current == nil || state.Current.RollbackSnapshotPath == "" {
		o.failAfterMaintenance(ctx, op, nil, errors.New("current generation has no upgrade snapshot for rollback"))
		return
	}
	if err = o.Snapshots.Restore(ctx, state.Current.RollbackSnapshotPath); err != nil {
		o.failAfterMaintenance(ctx, op, nil, err)
		return
	}
	if _, err = o.Store.SetPhase(op.ID, model.PhaseStarting, model.StateUpdating, true, "starting previous generation", o.now()); err != nil {
		o.failAfterMaintenance(ctx, op, &manifest, fmt.Errorf("persist rollback start phase: %w", err))
		return
	}
	if err = o.Engine.StartFixed(ctx, manifest); err != nil {
		o.failAfterMaintenance(ctx, op, &manifest, err)
		return
	}
	if _, err = o.Store.SetPhase(op.ID, model.PhaseProbing, model.StateUpdating, true, "probing previous generation", o.now()); err != nil {
		o.failAfterMaintenance(ctx, op, &manifest, fmt.Errorf("persist rollback probe phase: %w", err))
		return
	}
	if err = o.Engine.Probe(ctx, manifest); err != nil {
		o.failAfterMaintenance(ctx, op, &manifest, err)
		return
	}
	if _, err = o.Store.SetPhase(op.ID, model.PhaseCommitting, model.StateUpdating, true, "committing previous generation", o.now()); err != nil {
		o.failAfterMaintenance(ctx, op, &manifest, fmt.Errorf("persist rollback commit phase: %w", err))
		return
	}
	_, err = o.Store.Complete(op.ID, true, func(value *model.ManagerState) {
		oldCurrent := value.Current
		newCurrent := value.Previous
		if newCurrent != nil {
			copy := *newCurrent
			copy.RollbackSnapshotPath = snapshotPath
			newCurrent = &copy
		}
		value.Current = newCurrent
		value.Previous = oldCurrent
		value.FinalizePendingOperationID = op.ID
		value.PublicState = model.StateUpdating
		value.Maintenance = true
		value.LastError = ""
		value.RetryAfterSeconds = 0
	}, "", o.now())
	if err == nil {
		_ = o.finalizeCommitted(context.Background(), op, manifest)
	} else {
		o.failAfterMaintenance(ctx, op, &manifest, fmt.Errorf("persist rollback finalize intent: %w", err))
	}
}
func (o *Orchestrator) runRepair(ctx context.Context, op model.Operation) {
	state := o.Store.State()
	if state.PublicState != model.StateFailed {
		o.failBeforeMaintenance(op, errors.New("repair is available only in failed state"))
		return
	}
	if state.Current == nil {
		o.failBeforeMaintenance(op, errors.New("no current generation is available for repair"))
		return
	}
	manifest, err := o.loadStateManifest(state.Current, retainedGenerationCurrent)
	if err == nil {
		_, err = o.Store.UpdateOperation(op.ID, func(value *model.Operation) error {
			value.TargetGeneration = state.Current.ID
			value.UpdatedAt = o.now()
			return nil
		})
		if err != nil {
			err = fmt.Errorf("persist repair target generation: %w", err)
		}
	}
	op.TargetGeneration = state.Current.ID
	if err == nil {
		err = o.Engine.StartFixed(ctx, manifest)
	}
	if err == nil {
		err = o.Engine.Probe(ctx, manifest)
	}
	if err != nil {
		_, _ = o.Store.Complete(op.ID, false, func(value *model.ManagerState) {
			value.PublicState = model.StateFailed
			value.Maintenance = true
			value.LastError = err.Error()
		}, err.Error(), o.now())
		return
	}
	if _, err = o.Store.SetPhase(op.ID, model.PhaseCommitting, model.StateUpdating, true, "committing repaired generation", o.now()); err != nil {
		_, _ = o.Store.Complete(op.ID, false, func(value *model.ManagerState) {
			value.PublicState = model.StateFailed
			value.Maintenance = true
			value.LastError = err.Error()
		}, err.Error(), o.now())
		return
	}
	_, err = o.Store.Complete(op.ID, true, func(value *model.ManagerState) {
		value.FinalizePendingOperationID = op.ID
		value.PublicState = model.StateUpdating
		value.Maintenance = true
		value.LastError = ""
		value.RetryAfterSeconds = 0
	}, "", o.now())
	if err == nil {
		_ = o.finalizeCommitted(context.Background(), op, manifest)
	}
}

func (o *Orchestrator) reserve(ctx context.Context, id string) error {
	if _, err := o.Store.SetPhase(id, model.PhaseDraining, model.StateWaitingForTasks, false, "waiting for active tasks", o.now()); err != nil {
		return fmt.Errorf("persist task wait phase: %w", err)
	}
	gate := o.Gate
	if gate == nil {
		return errors.New("platform admission gate is not configured")
	}
	for {
		if o.LocalActiveProcesses != nil {
			if o.LocalActiveProcesses() > 0 {
				const retry = 5
				if _, err := o.Store.MutateState(o.now(), func(state *model.ManagerState) error {
					state.RetryAfterSeconds = retry
					return nil
				}); err != nil {
					return fmt.Errorf("persist local task wait state: %w", err)
				}
				if err := o.wait(ctx, retry*time.Second); err != nil {
					return err
				}
				continue
			}
		}
		reservation, err := gate.Reserve(ctx, id)
		if err != nil {
			cause := fmt.Errorf("reserve Platform admission: %w", err)
			// A 401 response from the first reserve is deterministic: the
			// Platform authenticates Manager requests before it reaches the
			// reservation handler, so no admission state can have changed. Do
			// not turn an invalid Manager capability into release uncertainty.
			// Once any reserve has succeeded, including the confirmation below,
			// every error still uses the fail-closed release protocol.
			if isDefinitiveAuthenticationRejection(err) {
				return fmt.Errorf("Platform admission authentication configuration was rejected: %w", cause)
			}
			return o.resolveReservationUncertainty(gate, id, cause)
		}
		if reservation.Reserved {
			// The Platform reservation freezes new Agent admissions, so this
			// second local inventory closes the race where a background terminal
			// was registered after the first local check but before Platform idle.
			if o.LocalActiveProcesses != nil {
				if o.LocalActiveProcesses() > 0 {
					if releaseErr := o.releaseReservation(gate, id, errors.New("a local task appeared while Platform admission was being reserved")); releaseErr != nil {
						return releaseErr
					}
					const retry = 5
					if _, stateErr := o.Store.MutateState(o.now(), func(state *model.ManagerState) error {
						state.RetryAfterSeconds = retry
						return nil
					}); stateErr != nil {
						return fmt.Errorf("persist local post-reservation wait state: %w", stateErr)
					}
					if waitErr := o.wait(ctx, retry*time.Second); waitErr != nil {
						return waitErr
					}
					continue
				}
			}
			break
		}
		retry := reservation.RetryAfterSeconds
		if retry < 1 {
			retry = 5
		}
		if _, err = o.Store.MutateState(o.now(), func(state *model.ManagerState) error { state.RetryAfterSeconds = retry; return nil }); err != nil {
			return fmt.Errorf("persist Platform task wait state: %w", err)
		}
		if err = o.wait(ctx, time.Duration(retry)*time.Second); err != nil {
			return err
		}
	}

	// Persist the Manager-side maintenance owner before asking the Platform to
	// confirm the same reservation. If the Platform process restarts after the
	// first response, its startup path can now reconstruct the reservation from
	// this durable state before it starts any business worker.
	if _, err := o.Store.UpdateOperation(id, func(value *model.Operation) error {
		value.ReservationStatus = model.ReservationConfirmationPending
		value.UpdatedAt = o.now()
		return nil
	}); err != nil {
		return o.resolveReservationUncertainty(gate, id, fmt.Errorf("persist reservation confirmation intent: %w", err))
	}
	if _, err := o.Store.SetPhase(id, model.PhaseDraining, model.StateUpdating, true, "admission reserved; confirming durable maintenance", o.now()); err != nil {
		return o.resolveReservationUncertainty(gate, id, fmt.Errorf("persist reserved admission phase: %w", err))
	}

	for {
		reservation, err := gate.Reserve(ctx, id)
		if err != nil {
			return o.resolveReservationUncertainty(gate, id, fmt.Errorf("confirm Platform admission reservation: %w", err))
		}
		if reservation.Reserved {
			break
		}
		retry := reservation.RetryAfterSeconds
		if retry < 1 {
			retry = 5
		}
		if _, err = o.Store.MutateState(o.now(), func(state *model.ManagerState) error {
			state.RetryAfterSeconds = retry
			return nil
		}); err != nil {
			return o.resolveReservationUncertainty(gate, id, fmt.Errorf("persist Platform reservation confirmation wait: %w", err))
		}
		if err = o.wait(ctx, time.Duration(retry)*time.Second); err != nil {
			return o.resolveReservationUncertainty(gate, id, err)
		}
	}
	if _, err := o.Store.UpdateOperation(id, func(value *model.Operation) error {
		value.ReservationStatus = model.ReservationConfirmed
		value.UpdatedAt = o.now()
		return nil
	}); err != nil {
		return o.resolveReservationUncertainty(gate, id, fmt.Errorf("persist reservation confirmation: %w", err))
	}
	if _, err := o.Store.MutateState(o.now(), func(state *model.ManagerState) error {
		state.RetryAfterSeconds = 0
		return nil
	}); err != nil {
		return o.resolveReservationUncertainty(gate, id, fmt.Errorf("persist confirmed reservation state: %w", err))
	}
	return nil
}

func (o *Orchestrator) beginReservedMutation(id string) error {
	if _, err := o.Store.UpdateOperation(id, func(value *model.Operation) error {
		if value.ReservationStatus != model.ReservationConfirmed {
			return errors.New("admission reservation is not durably confirmed")
		}
		value.ReservationStatus = model.ReservationMutationStarted
		value.UpdatedAt = o.now()
		return nil
	}); err != nil {
		return o.resolveReservationUncertainty(o.Gate, id, fmt.Errorf("persist destructive mutation boundary: %w", err))
	}
	return nil
}

func (o *Orchestrator) resolveReservationUncertainty(gate Gate, id string, cause error) error {
	if err := o.releaseReservation(gate, id, cause); err != nil {
		return err
	}
	return cause
}

func (o *Orchestrator) releaseReservation(gate Gate, id string, cause error) error {
	if gate == nil {
		return &reservationReleaseUncertainError{cause: errors.Join(cause, errors.New("platform admission gate is not configured for release"))}
	}
	releaseCtx, cancel := context.WithTimeout(context.Background(), reservationReleaseTimeout)
	defer cancel()
	if err := o.releaseGate(releaseCtx, gate, id); err != nil {
		return &reservationReleaseUncertainError{cause: errors.Join(cause, fmt.Errorf("confirm reservation release: %w", err))}
	}
	return nil
}

func (o *Orchestrator) failReservation(op model.Operation, cause error) {
	var uncertain *reservationReleaseUncertainError
	if !errors.As(cause, &uncertain) {
		o.failBeforeMaintenance(op, cause)
		return
	}
	_ = o.holdUnconfirmedReservation(op, cause)
}

func (o *Orchestrator) failPreparedReservation(op model.Operation, manifest release.Manifest, path string, cause error) {
	var uncertain *reservationReleaseUncertainError
	if errors.As(cause, &uncertain) {
		_ = o.holdUnconfirmedReservation(op, cause)
		return
	}
	o.failPreparedBeforeMaintenance(op, manifest, path, cause, false)
}

func (o *Orchestrator) holdUnconfirmedReservation(op model.Operation, cause error) error {
	message := journal.BoundDiagnostic(cause.Error())
	if _, err := o.Store.UpdateOperation(op.ID, func(value *model.Operation) error {
		value.Status = model.OperationRunning
		value.Finalized = false
		value.GateSettlementAction = ""
		value.CompletedAt = nil
		value.Phase = model.PhaseDraining
		value.ReservationStatus = model.ReservationReleaseUncertain
		value.Error = message
		value.UpdatedAt = o.now()
		return nil
	}); err != nil {
		persistErr := fmt.Errorf("persist uncertain reservation recovery intent: %w", err)
		o.event(op.ID, "operation.failed", op.TargetGeneration, errors.Join(cause, persistErr))
		return persistErr
	}
	if _, err := o.Store.MutateState(o.now(), func(state *model.ManagerState) error {
		state.ActiveOperationID = op.ID
		state.Phase = model.PhaseDraining
		state.PublicState = model.StateFailed
		state.Maintenance = true
		state.LastError = message
		state.RetryAfterSeconds = 5
		return nil
	}); err != nil {
		persistErr := fmt.Errorf("persist fail-closed reservation state: %w", err)
		o.event(op.ID, "operation.failed", op.TargetGeneration, errors.Join(cause, persistErr))
		return persistErr
	}
	o.event(op.ID, "operation.failed", op.TargetGeneration, cause)
	return nil
}

func (o *Orchestrator) recoverUnconfirmedReservation(_ context.Context, op model.Operation) error {
	gate := o.Gate
	releaseCtx, cancel := context.WithTimeout(context.Background(), reservationReleaseTimeout)
	defer cancel()
	if gate == nil {
		return o.holdUnconfirmedReservation(op, errors.New(reservationRetryDiagnostic(op.Error, "platform admission gate is not configured for reservation recovery")))
	}
	if err := o.releaseGate(releaseCtx, gate, op.ID); err != nil {
		return o.holdUnconfirmedReservation(op, errors.New(reservationRetryDiagnostic(op.Error, fmt.Sprintf("retry reservation release: %v", err))))
	}
	message := journal.BoundDiagnostic(op.Error)
	if message == "" {
		message = "operation interrupted before the admission reservation was confirmed"
	}
	state := o.Store.State()
	// Restart/rollback reservations, and validation failures which never staged
	// a release target, have no Manager Candidate dependency to unwind.
	if (op.Kind != model.OperationInstall && op.Kind != model.OperationUpdate) || op.TargetGeneration == "" {
		if state.Candidate != nil {
			return errors.New("reservation without a release target unexpectedly owns a Platform Candidate")
		}
		_, err := o.Store.Complete(op.ID, false, func(value *model.ManagerState) {
			value.PublicState = model.StateIdle
			value.Maintenance = false
			value.LastError = message
			value.RetryAfterSeconds = 0
		}, message, o.now())
		return err
	}
	durable, err := o.beginPreparedCleanup(op, op.TargetGeneration, errors.New(message), op.Retryable)
	if err != nil {
		return fmt.Errorf("persist prepared cleanup after reservation recovery: %w", err)
	}
	if err := o.reconcilePreparedCleanup(durable); err != nil {
		return o.holdPreparedCleanup(durable, err)
	}
	return nil
}

func reservationRetryDiagnostic(existing, latest string) string {
	root, _, _ := strings.Cut(existing, reservationRetrySeparator)
	if root == "" {
		root = "reservation release remains unconfirmed"
	}
	// Bound each side before joining so the fixed separator always survives;
	// the next recovery tick can replace, rather than append to, the latest retry.
	componentLimit := (journal.MaxDiagnosticBytes - len(reservationRetrySeparator)) / 2
	root = journal.BoundDiagnosticWithLimit(root, componentLimit)
	latest = journal.BoundDiagnosticWithLimit(latest, componentLimit)
	return journal.BoundDiagnostic(root + reservationRetrySeparator + latest)
}
func (o *Orchestrator) snapshot(ctx context.Context, id string) (string, error) {
	if _, err := o.Store.SetPhase(id, model.PhaseSnapshotting, model.StateUpdating, true, "creating consistent state snapshot", o.now()); err != nil {
		return "", err
	}
	return o.Snapshots.Create(ctx, id)
}
func (o *Orchestrator) failBeforeMaintenance(op model.Operation, err error) {
	_, _ = o.Store.Complete(op.ID, false, func(state *model.ManagerState) {
		state.PublicState = model.StateIdle
		state.Maintenance = false
		state.LastError = err.Error()
	}, err.Error(), o.now())
	o.event(op.ID, "operation.failed", op.TargetGeneration, err)
}

func (o *Orchestrator) failPreparedBeforeMaintenance(op model.Operation, manifest release.Manifest, path string, cause error, retryable bool) {
	durable, err := o.beginPreparedCleanup(op, manifest.ID(), cause, retryable)
	if err != nil {
		// An atomic write can report a directory-sync error after rename. Re-read
		// before deciding that the marker is absent; if it is durable, recovery
		// ownership has already transferred to the cleanup-only protocol.
		if observed, readErr := o.Store.Operation(op.ID); readErr == nil && observed.PreparedCleanupPending {
			durable = observed
		} else {
			o.event(op.ID, "operation.failed", op.TargetGeneration, errors.Join(cause, fmt.Errorf("persist prepared cleanup intent: %w", err)))
			return
		}
	}
	if path != filepath.Join(o.ReleasesDir, manifest.ID(), "manifest.json") {
		_ = o.holdPreparedCleanup(durable, errors.New("prepared cleanup manifest is outside the managed release path"))
		return
	}
	if err := o.reconcilePreparedCleanup(durable); err != nil {
		_ = o.holdPreparedCleanup(durable, err)
	}
}

func (o *Orchestrator) beginPreparedCleanup(op model.Operation, target string, cause error, retryable bool) (model.Operation, error) {
	message := journal.BoundDiagnostic(cause.Error())
	return o.Store.UpdateOperation(op.ID, func(value *model.Operation) error {
		if value.ID != op.ID || (value.Kind != model.OperationInstall && value.Kind != model.OperationUpdate) ||
			value.TargetGeneration != target || value.Finalized || value.CompletedAt != nil ||
			(value.Status != model.OperationPending && value.Status != model.OperationRunning) {
			return errors.New("prepared cleanup cannot claim the active operation")
		}
		if value.PreparedCleanupPending {
			if value.Error == "" {
				return errors.New("prepared cleanup marker has no original failure")
			}
			return nil
		}
		value.PreparedCleanupPending = true
		value.Status = model.OperationRunning
		value.Finalized = false
		value.GateSettlementAction = ""
		value.CompletedAt = nil
		value.Retryable = retryable
		value.Error = message
		value.UpdatedAt = o.now()
		return nil
	})
}

func (o *Orchestrator) recoverPreparedCleanup(op model.Operation) error {
	if err := o.reconcilePreparedCleanup(op); err != nil {
		return o.holdPreparedCleanup(op, err)
	}
	return nil
}

// reconcilePreparedCleanup is the only recovery path after the durable marker.
// It never fetches, prepares, reserves, starts, or migrates a generation.
func (o *Orchestrator) reconcilePreparedCleanup(op model.Operation) error {
	manifest, path, err := o.loadPreparedCleanupManifest(op)
	if err != nil {
		return err
	}
	expected := generation(manifest, path)
	state := o.Store.State()
	if state.ActiveOperationID != op.ID || state.FinalizePendingOperationID != "" {
		return errors.New("prepared cleanup lost its active Platform owner")
	}
	if state.Candidate != nil && !reflect.DeepEqual(state.Candidate, expected) {
		return errors.New("prepared cleanup Platform Candidate does not match its immutable manifest")
	}
	if o.SelfUpdate != nil {
		if err := o.SelfUpdate.DiscardPrepared(manifest); err != nil {
			return fmt.Errorf("discard prepared Manager Candidate: %w", err)
		}
	}
	durable, err := o.Store.Operation(op.ID)
	if err != nil {
		return fmt.Errorf("re-read prepared cleanup operation: %w", err)
	}
	if !samePreparedCleanupOwner(op, durable) {
		return errors.New("prepared cleanup operation identity changed after Manager cleanup")
	}
	if state = o.Store.State(); state.ActiveOperationID != op.ID || state.FinalizePendingOperationID != "" {
		return errors.New("prepared cleanup Platform owner changed after Manager cleanup")
	}
	if state.Candidate != nil {
		if !reflect.DeepEqual(state.Candidate, expected) {
			return errors.New("prepared cleanup Platform Candidate changed before clearing")
		}
		if _, err := o.Store.MutateState(o.now(), func(value *model.ManagerState) error {
			if value.ActiveOperationID != op.ID || value.FinalizePendingOperationID != "" ||
				!reflect.DeepEqual(value.Candidate, expected) {
				return errors.New("prepared cleanup Platform Candidate ownership changed during clearing")
			}
			value.Candidate = nil
			return nil
		}); err != nil {
			return fmt.Errorf("clear prepared Platform Candidate: %w", err)
		}
	}
	durable, err = o.Store.Operation(op.ID)
	if err != nil || !samePreparedCleanupOwner(op, durable) {
		if err == nil {
			err = errors.New("prepared cleanup operation changed before terminal commit")
		}
		return err
	}
	state = o.Store.State()
	if state.ActiveOperationID != op.ID || state.FinalizePendingOperationID != "" || state.Candidate != nil {
		return errors.New("prepared cleanup Platform state is not terminal-ready")
	}
	completed, err := o.Store.CompletePreparedCleanup(op.ID, o.now())
	if err != nil {
		return fmt.Errorf("commit prepared cleanup terminal state: %w", err)
	}
	o.event(op.ID, "operation.failed", op.TargetGeneration, errors.New(completed.Error))
	return nil
}

func (o *Orchestrator) loadPreparedCleanupManifest(op model.Operation) (release.Manifest, string, error) {
	if !op.PreparedCleanupPending || (op.Kind != model.OperationInstall && op.Kind != model.OperationUpdate) ||
		op.TargetGeneration == "" || op.Error == "" {
		return release.Manifest{}, "", errors.New("prepared cleanup operation intent is incomplete")
	}
	if filepath.Base(op.TargetGeneration) != op.TargetGeneration || len(op.TargetGeneration) != 40 {
		return release.Manifest{}, "", errors.New("prepared cleanup target generation is not a managed release identity")
	}
	for _, character := range op.TargetGeneration {
		if !(character >= '0' && character <= '9' || character >= 'a' && character <= 'f') {
			return release.Manifest{}, "", errors.New("prepared cleanup target generation is not a lowercase commit")
		}
	}
	if o.ReleasesDir == "" || !filepath.IsAbs(o.ReleasesDir) || filepath.Clean(o.ReleasesDir) != o.ReleasesDir {
		return release.Manifest{}, "", errors.New("prepared cleanup release root is not absolute and canonical")
	}
	generationDir := filepath.Join(o.ReleasesDir, op.TargetGeneration)
	for _, entry := range []struct {
		label string
		path  string
	}{{"release root", o.ReleasesDir}, {"generation directory", generationDir}} {
		info, err := os.Lstat(entry.path)
		if err != nil {
			return release.Manifest{}, "", fmt.Errorf("inspect managed prepared cleanup %s: %w", entry.label, err)
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return release.Manifest{}, "", fmt.Errorf("managed prepared cleanup %s is not a real directory", entry.label)
		}
	}
	path := filepath.Join(generationDir, "manifest.json")
	info, err := os.Lstat(path)
	if err != nil {
		return release.Manifest{}, "", fmt.Errorf("inspect managed prepared cleanup manifest: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 1<<20 {
		return release.Manifest{}, "", errors.New("managed prepared cleanup manifest has an invalid type or size")
	}
	manifest, err := o.loadManifest(path)
	if err != nil {
		return release.Manifest{}, "", fmt.Errorf("load managed prepared cleanup manifest: %w", err)
	}
	if manifest.ID() != op.TargetGeneration || manifest.SourceCommit != op.TargetGeneration {
		return release.Manifest{}, "", errors.New("prepared cleanup manifest does not match operation target")
	}
	return manifest, path, nil
}

func samePreparedCleanupOwner(expected, actual model.Operation) bool {
	return actual.ID == expected.ID && actual.Kind == expected.Kind &&
		actual.TargetGeneration == expected.TargetGeneration && actual.PreparedCleanupPending &&
		actual.Error == expected.Error && actual.Retryable == expected.Retryable &&
		!actual.Finalized && actual.CompletedAt == nil &&
		(actual.Status == model.OperationPending || actual.Status == model.OperationRunning)
}

func (o *Orchestrator) holdPreparedCleanup(op model.Operation, cleanupErr error) error {
	message := journal.BoundDiagnostic(errors.Join(errors.New(op.Error), fmt.Errorf("prepared candidate cleanup remains pending: %w", cleanupErr)).Error())
	_, err := o.Store.UpdateOperation(op.ID, func(value *model.Operation) error {
		if !samePreparedCleanupOwner(op, *value) {
			return errors.New("prepared candidate cleanup lost its operation owner")
		}
		value.Status = model.OperationRunning
		value.Finalized = false
		value.GateSettlementAction = ""
		value.CompletedAt = nil
		// Preserve Error as the immutable original cause. The latest cleanup
		// diagnostic is projected through Manager state without recursive growth.
		value.UpdatedAt = o.now()
		return nil
	})
	if err != nil {
		o.event(op.ID, "operation.failed", op.TargetGeneration, errors.Join(cleanupErr, err))
		return err
	}
	if _, err := o.Store.MutateState(o.now(), func(state *model.ManagerState) error {
		if state.ActiveOperationID != op.ID || state.FinalizePendingOperationID != "" {
			return errors.New("prepared candidate cleanup lost its Platform owner")
		}
		state.LastError = message
		state.RetryAfterSeconds = 5
		return nil
	}); err != nil {
		o.event(op.ID, "operation.failed", op.TargetGeneration, errors.Join(cleanupErr, err))
		return err
	}
	o.event(op.ID, "operation.failed", op.TargetGeneration, cleanupErr)
	return nil
}

func (o *Orchestrator) failBeforeMaintenanceRetryable(op model.Operation, err error) {
	if _, persistErr := o.Store.UpdateOperation(op.ID, func(value *model.Operation) error {
		value.Retryable = true
		value.UpdatedAt = o.now()
		return nil
	}); persistErr != nil {
		o.failBeforeMaintenance(op, errors.Join(err, fmt.Errorf("persist retryable operation classification: %w", persistErr)))
		return
	}
	o.failBeforeMaintenance(op, err)
}

// haltAfterSnapshotJournalFailure is intentionally not a normal rollback.
// Once creation of the rescue snapshot has returned but its journal update has
// failed, the Manager cannot know whether the snapshot path is durable across a
// crash.  Keep every writer stopped and maintenance closed; in particular, do
// not call Snapshotter.Restore from this process.
func (o *Orchestrator) haltAfterSnapshotJournalFailure(ctx context.Context, op model.Operation, cause error) {
	_ = o.Engine.StopFixed(ctx)
	_, _ = o.Store.MutateState(o.now(), func(state *model.ManagerState) error {
		state.PublicState = model.StateFailed
		state.Maintenance = true
		state.LastError = cause.Error()
		state.RetryAfterSeconds = 0
		return nil
	})
	o.event(op.ID, "operation.failed", op.TargetGeneration, cause)
}

func (o *Orchestrator) failAfterMaintenance(ctx context.Context, op model.Operation, target *release.Manifest, cause error) {
	o.rollbackMu.Lock()
	defer o.rollbackMu.Unlock()

	current, operationErr := o.Store.Operation(op.ID)
	if operationErr != nil {
		return
	}
	firstAttempt := current.Phase != model.PhaseRollingBack
	failureAlreadyRecorded := current.Error != ""
	originalError := current.Error
	if originalError == "" {
		originalError = cause.Error()
	}
	// Repeated rollback failures must not grow Error and LastError without a
	// bound. Normalize that history even when there is no
	// live candidate to diagnose, otherwise a successful offline recovery can
	// restart the stable Manager with another multi-megabyte status response.
	originalError = journal.BoundDiagnostic(originalError)
	// Preserve the exact candidate evidence before StopFixed removes the failed
	// containers. A cancelled operation context must not suppress forensics, so
	// the optional Docker implementation owns a short, bounded background
	// deadline. Never append the same diagnostic again during recovery retries.
	if firstAttempt && !failureAlreadyRecorded && target != nil {
		if diagnoser, ok := o.Engine.(driver.CandidateFailureDiagnoser); ok {
			if diagnostic := strings.TrimSpace(diagnoser.CandidateFailureDiagnostics(context.Background(), *target)); diagnostic != "" {
				originalError = journal.BoundDiagnostic(originalError + "\n\ncandidate failure diagnostics:\n" + diagnostic)
			}
		}
	}
	// A process can die between persisting the operation terminal record and
	// persisting Manager state. Re-open that half-commit as a durable rollback
	// before SetPhase, which intentionally rejects terminal operations.
	if _, operationErr = o.Store.UpdateOperation(op.ID, func(value *model.Operation) error {
		value.Status = model.OperationRunning
		value.Finalized = false
		value.GateSettlementAction = ""
		value.CompletedAt = nil
		value.Error = originalError
		value.UpdatedAt = o.now()
		return nil
	}); operationErr != nil {
		o.event(op.ID, "operation.failed", op.TargetGeneration, fmt.Errorf("reopen rollback operation: %w", operationErr))
		return
	}
	if firstAttempt {
		if _, operationErr = o.Store.SetPhase(op.ID, model.PhaseRollingBack, model.StateUpdating, true, "restoring previous generation", o.now()); operationErr != nil {
			o.event(op.ID, "operation.failed", op.TargetGeneration, fmt.Errorf("persist rollback phase: %w", operationErr))
			return
		}
	}
	// Stop every possible writer before touching the snapshot or restarting the
	// current generation. This also covers a first install, where state.Current is
	// nil but the candidate may already have reached StartFixed before failing
	// its readiness or public-gateway probe.
	stopErr := o.Engine.StopFixed(ctx)
	readErr := stopErr
	current, operationErr = o.Store.Operation(op.ID)
	if readErr == nil && operationErr != nil {
		readErr = operationErr
	}
	if readErr == nil && !current.SnapshotRestored {
		if current.SnapshotPath != "" {
			readErr = o.Snapshots.Restore(ctx, current.SnapshotPath)
		}
		if readErr == nil {
			current, operationErr = o.Store.UpdateOperation(op.ID, func(value *model.Operation) error {
				value.SnapshotRestored = true
				value.UpdatedAt = o.now()
				return nil
			})
			if operationErr != nil {
				readErr = fmt.Errorf("persist snapshot-restored checkpoint: %w", operationErr)
			}
		}
	}
	state := o.Store.State()
	if readErr == nil && state.Current != nil {
		var previous release.Manifest
		previous, readErr = o.loadStateManifest(state.Current, retainedGenerationCurrent)
		if readErr == nil {
			_ = o.Engine.StopFixed(ctx)
			readErr = o.Engine.StartFixed(ctx, previous)
			if readErr == nil {
				readErr = o.Engine.Probe(ctx, previous)
			}
		}
	}
	if readErr == nil && state.Current != nil && !current.ReservationReleased {
		gate := o.Gate
		if gate == nil {
			readErr = errors.New("release update reservation: Platform admission gate is not configured")
		}
		if readErr == nil {
			releaseCtx, cancel := context.WithTimeout(context.Background(), reservationReleaseTimeout)
			releaseErr := o.releaseGate(releaseCtx, gate, op.ID)
			cancel()
			if releaseErr != nil {
				readErr = fmt.Errorf("release update reservation: %w", releaseErr)
			}
		}
		if readErr == nil {
			current, operationErr = o.Store.UpdateOperation(op.ID, func(value *model.Operation) error {
				value.ReservationReleased = true
				value.UpdatedAt = o.now()
				return nil
			})
			if operationErr != nil {
				readErr = fmt.Errorf("persist reservation-released checkpoint: %w", operationErr)
			}
		}
	}
	// Platform has not committed this install/update candidate. Before the first
	// destructive Candidate write, transfer ownership to the durable inverse
	// protocol. Once that marker exists this function must return: recovery may
	// only replay exact Candidate reconciliation and can never resume runUpdate.
	if readErr == nil && !current.ManagerActivationRollback &&
		(current.Kind == model.OperationInstall || current.Kind == model.OperationUpdate) {
		durable, markerErr := o.beginPreparedCleanup(current, current.TargetGeneration, errors.New(originalError), current.Retryable)
		if markerErr != nil {
			// Rename can have succeeded even when the parent-directory sync reports
			// an error. Re-read before deciding whether inverse ownership moved.
			if observed, observedErr := o.Store.Operation(current.ID); observedErr == nil && observed.PreparedCleanupPending {
				durable = observed
			} else {
				readErr = fmt.Errorf("persist rollback prepared cleanup intent: %w", markerErr)
			}
		}
		if durable.PreparedCleanupPending {
			if cleanupErr := o.reconcilePreparedCleanup(durable); cleanupErr != nil {
				_ = o.holdPreparedCleanup(durable, cleanupErr)
			}
			return
		}
	}
	if readErr == nil && state.Current == nil {
		// A clean first install has no older generation to restart. Once every
		// candidate writer is stopped and its pre-install snapshot is restored,
		// the safe outcome is a terminal failed install behind the Manager page.
		_, operationErr = o.Store.Complete(op.ID, false, func(value *model.ManagerState) {
			value.PublicState = model.StateFailed
			value.Maintenance = true
			value.LastError = originalError
			value.Candidate = nil
			value.RetryAfterSeconds = 0
		}, originalError, o.now())
	} else if readErr == nil && state.Current != nil {
		_, operationErr = o.Store.Complete(op.ID, false, func(value *model.ManagerState) {
			value.PublicState = model.StateIdle
			value.Maintenance = false
			value.LastError = originalError
			value.Candidate = nil
			value.RetryAfterSeconds = 0
		}, originalError, o.now())
	} else {
		message := originalError
		if readErr != nil {
			message += "; rollback failed: " + readErr.Error()
		}
		_, operationErr = o.Store.UpdateOperation(op.ID, func(value *model.Operation) error {
			value.Status = model.OperationRunning
			value.Phase = model.PhaseRollingBack
			value.Error = originalError
			value.CompletedAt = nil
			value.Finalized = false
			value.GateSettlementAction = ""
			value.UpdatedAt = o.now()
			return nil
		})
		_, stateErr := o.Store.MutateState(o.now(), func(value *model.ManagerState) error {
			value.ActiveOperationID = op.ID
			value.Phase = model.PhaseRollingBack
			value.PublicState = model.StateFailed
			value.Maintenance = true
			value.LastError = message
			value.RetryAfterSeconds = 5
			return nil
		})
		if operationErr == nil && stateErr != nil {
			operationErr = stateErr
		}
	}
	if operationErr != nil {
		o.event(op.ID, "operation.failed", op.TargetGeneration, errors.Join(cause, fmt.Errorf("persist rollback recovery state: %w", operationErr)))
		return
	}
	if firstAttempt {
		o.event(op.ID, "operation.failed", op.TargetGeneration, cause)
	}
}
func (o *Orchestrator) recoverRollback(ctx context.Context, op model.Operation) error {
	state := o.Store.State()
	if !state.Maintenance {
		return nil
	}
	o.failAfterMaintenance(ctx, op, nil, errors.New("manager restarted during a mutating phase"))
	return nil
}
func (o *Orchestrator) saveManifest(ctx context.Context, manifest release.Manifest, data []byte) (string, error) {
	if err := os.MkdirAll(o.ReleasesDir, 0o700); err != nil {
		return "", err
	}
	compose, err := o.ReleaseClient.FetchArtifact(ctx, manifest.Compose, 5<<20)
	if err != nil {
		return "", fmt.Errorf("fetch Compose artifact: %w", err)
	}
	dir := filepath.Join(o.ReleasesDir, manifest.ID())
	path := filepath.Join(dir, "manifest.json")
	if _, err := os.Lstat(dir); err == nil {
		if err := immutableReleaseMatches(dir, data, compose); err != nil {
			return "", err
		}
		return path, nil
	} else if !os.IsNotExist(err) {
		return "", fmt.Errorf("inspect release generation: %w", err)
	}

	staging, err := os.MkdirTemp(o.ReleasesDir, ".release-"+manifest.ID()+"-*")
	if err != nil {
		return "", fmt.Errorf("create release staging directory: %w", err)
	}
	removeStaging := true
	defer func() {
		if removeStaging {
			_ = os.RemoveAll(staging)
		}
	}()
	if err := atomicfile.WriteFile(filepath.Join(staging, "manifest.json"), data, 0o600); err != nil {
		return "", err
	}
	if err := atomicfile.WriteFile(filepath.Join(staging, "compose.yaml"), compose, 0o600); err != nil {
		return "", err
	}
	if err := os.Rename(staging, dir); err != nil {
		// A concurrent check may have published the same immutable generation.
		// Reuse it only when both artifacts are byte-for-byte identical.
		if matchErr := immutableReleaseMatches(dir, data, compose); matchErr != nil {
			return "", errors.Join(fmt.Errorf("publish release generation: %w", err), matchErr)
		}
		return path, nil
	}
	removeStaging = false
	if err := syncDirectory(o.ReleasesDir); err != nil {
		return "", err
	}
	return path, nil
}

func immutableReleaseMatches(dir string, manifest, compose []byte) error {
	info, err := os.Lstat(dir)
	if err != nil {
		return fmt.Errorf("immutable release collision: inspect generation: %w", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("immutable release collision: generation is not a regular directory")
	}
	for _, expected := range []struct {
		name  string
		data  []byte
		limit int64
	}{{"manifest.json", manifest, 1 << 20}, {"compose.yaml", compose, 5 << 20}} {
		path := filepath.Join(dir, expected.name)
		fileInfo, statErr := os.Lstat(path)
		if statErr != nil {
			return fmt.Errorf("immutable release collision: %s is unavailable: %w", expected.name, statErr)
		}
		if !fileInfo.Mode().IsRegular() || fileInfo.Mode()&os.ModeSymlink != 0 || fileInfo.Size() > expected.limit {
			return fmt.Errorf("immutable release collision: %s has an invalid type or size", expected.name)
		}
		actual, readErr := os.ReadFile(path)
		if readErr != nil {
			return fmt.Errorf("immutable release collision: read %s: %w", expected.name, readErr)
		}
		if !bytes.Equal(actual, expected.data) {
			return fmt.Errorf("immutable release collision: %s differs for the same source commit", expected.name)
		}
	}
	return nil
}

func syncDirectory(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open release directory: %w", err)
	}
	defer dir.Close()
	if err := dir.Sync(); err != nil {
		return fmt.Errorf("sync release directory: %w", err)
	}
	return nil
}
func (o *Orchestrator) loadManifest(path string) (release.Manifest, error) {
	var value release.Manifest
	if err := atomicfile.ReadJSON(path, &value); err != nil {
		return value, err
	}
	if err := value.Validate(o.Channel, runtime.GOOS, runtime.GOARCH); err != nil {
		return value, err
	}
	return value, nil
}

// loadStateManifest keeps the current parser strict for every normal retained
// generation. The compatibility reader is reached only after strict validation
// fails and independently proves the exact source-profile Current/Previous P1
// bytes and path fixed by the release-transition contract.
func (o *Orchestrator) loadStateManifest(generation *model.Generation, slot retainedGenerationSlot) (release.Manifest, error) {
	if generation == nil {
		return release.Manifest{}, errors.New("retained generation is absent")
	}
	manifest, strictErr := o.loadManifest(generation.ManifestPath)
	if strictErr == nil {
		return manifest, nil
	}
	manifest, compatibilityErr := o.loadRetainedSourceCompatibility(generation, slot)
	if compatibilityErr == nil {
		return manifest, nil
	}
	return release.Manifest{}, errors.Join(
		strictErr,
		fmt.Errorf("retained source predecessor compatibility rejected: %w", compatibilityErr),
	)
}

// releaseGate performs the normal abort first in all cases. HTTPGate is allowed
// to try the historical endpoint only when this process can still prove that
// the authoritative Current is the exact canonical source predecessor.
func (o *Orchestrator) releaseGate(ctx context.Context, gate Gate, operationID string) error {
	if gate == nil {
		return errors.New("platform admission gate is not configured for release")
	}
	if o.Store == nil {
		return gate.Release(ctx, operationID)
	}
	state := o.Store.State()
	if state.Current != nil {
		if _, err := o.loadRetainedSourceCompatibility(state.Current, retainedGenerationCurrent); err == nil {
			if compatibilityGate, ok := gate.(retainedSourceAbortGate); ok {
				return compatibilityGate.releaseRetainedSourcePredecessor(ctx, operationID, state.Current.ID)
			}
		}
	}
	return gate.Release(ctx, operationID)
}
func (o *Orchestrator) now() time.Time {
	if o.Now != nil {
		return o.Now().UTC()
	}
	return time.Now().UTC()
}
func (o *Orchestrator) wait(ctx context.Context, duration time.Duration) error {
	if o.Sleep != nil {
		return o.Sleep(ctx, duration)
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
func (o *Orchestrator) pollInterval() time.Duration {
	if o.PollInterval >= 30*time.Second {
		return o.PollInterval
	}
	return 2 * time.Minute
}
func (o *Orchestrator) event(id, event, generationID string, err error) {
	if o.Log == nil {
		return
	}
	value := logstore.Event{At: o.now(), Type: event, OperationID: id, Details: map[string]any{"generation": generationID}}
	if err != nil {
		value.Error = journal.BoundDiagnostic(err.Error())
	}
	_ = o.Log.Append(value)
}
func generation(manifest release.Manifest, path string) *model.Generation {
	return &model.Generation{ID: manifest.ID(), ManifestPath: path, SourceCommit: manifest.SourceCommit, DatabaseVersion: manifest.DatabaseSchemaVersion, Images: manifest.Images}
}

var _ = json.Valid
