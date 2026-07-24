package operation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/atomicfile"
	"github.com/ubitech/agent-platform/manager/internal/driver"
	"github.com/ubitech/agent-platform/manager/internal/journal"
	"github.com/ubitech/agent-platform/manager/internal/logstore"
	"github.com/ubitech/agent-platform/manager/internal/model"
	"github.com/ubitech/agent-platform/manager/internal/release"
)

type Snapshotter interface {
	Create(context.Context, string) (string, error)
	Restore(context.Context, string) error
}

type LegacyMigrator interface {
	Active() bool
	PreCutover(context.Context, string) error
	Cutover(context.Context, string) error
	FinalizeCleanup(context.Context, string) error
	Rollback(context.Context, string) error
}
type SelfUpdater interface {
	Prepare(context.Context, release.Manifest) error
	MarkPlatformCommitted(release.Manifest) error
	Activate(context.Context, release.Manifest) error
	ActivationCommitted(release.Manifest) (bool, error)
}

type Orchestrator struct {
	Store               *journal.Store
	Engine              driver.Engine
	Gate                Gate
	LegacyGate          Gate
	Snapshots           Snapshotter
	Legacy              LegacyMigrator
	SelfUpdate          SelfUpdater
	ReleasesDir         string
	ManifestURL         string
	Channel             string
	ReleaseClient       release.Client
	Log                 *logstore.Store
	Now                 func() time.Time
	Sleep               func(context.Context, time.Duration) error
	PollInterval        time.Duration
	OnCommit            func(release.Manifest)
	PublicProbe         func(context.Context) error
	LocalUpdateBlockers func() (running, blocking, terminable int)
	mu                  sync.Mutex
	finalizeMu          sync.Mutex
	rollbackMu          sync.Mutex
	running             map[string]context.CancelFunc
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
	if request.ExpectedSourceCommit != "" && !validSourceCommit(request.ExpectedSourceCommit) {
		return model.Operation{}, false, errors.New("expected_source_commit must be a 40-character lowercase Git commit")
	}
	op, reused, err := o.Store.Begin(request, o.now())
	if err != nil || reused {
		return op, reused, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	o.mu.Lock()
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
// old-binary watchdog can still reject the candidate Manager.  Finalize hooks
// are deliberately withheld: reservation release, legacy cleanup, and other
// post-commit effects may run only after the watchdog has committed the
// candidate binary.
func (o *Orchestrator) RecoverBeforeActivation(ctx context.Context) error {
	return o.recover(ctx, false, true)
}

func (o *Orchestrator) Recover(ctx context.Context) error {
	return o.recover(ctx, true, false)
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
	if op.Status == model.OperationFailed {
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
	if !state.Maintenance && (op.Phase == model.PhaseValidating || op.Phase == model.PhasePulling || op.Phase == model.PhasePreparing || op.Phase == model.PhaseDraining) {
		if activationPreflight {
			return fmt.Errorf("candidate Manager activation is blocked by unfinished operation %s in phase %s", op.ID, op.Phase)
		}
		resume, cancel := context.WithCancel(context.Background())
		o.mu.Lock()
		if o.running == nil {
			o.running = map[string]context.CancelFunc{}
		}
		o.running[op.ID] = cancel
		o.mu.Unlock()
		go func() { defer cancel(); o.run(resume, *op) }()
		return nil
	}
	return o.recoverRollback(ctx, *op)
}

func (o *Orchestrator) recoverFinalize(ctx context.Context, state model.ManagerState, runHooks bool) error {
	op, err := o.Store.Operation(state.FinalizePendingOperationID)
	if err != nil {
		return fmt.Errorf("load pending finalize operation: %w", err)
	}
	if op.Status != model.OperationSucceeded {
		return fmt.Errorf("pending finalize operation %s is not succeeded", op.ID)
	}
	if state.Current == nil || state.Current.ManifestPath == "" || op.TargetGeneration != state.Current.ID {
		return errors.New("pending finalize generation does not match current generation")
	}
	manifest, err := o.loadManifest(state.Current.ManifestPath)
	if err != nil {
		return err
	}
	if err = o.probeCommittedGeneration(ctx, manifest); err != nil {
		return o.finalizeFailure("committed generation readiness is pending", err)
	}
	if !runHooks {
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
		o.runRepair(ctx, op)
	default:
		o.failBeforeMaintenance(op, fmt.Errorf("unsupported operation %q", op.Kind))
	}
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
			state.LastError = "release is not ready; bridge remains online"
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
	if op.ExpectedSourceCommit != "" && manifest.SourceCommit != op.ExpectedSourceCommit {
		o.failBeforeMaintenance(op, fmt.Errorf("source migration release mismatch: expected %s, received %s", op.ExpectedSourceCommit, manifest.SourceCommit))
		return
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
	if o.SelfUpdate != nil {
		if err = o.SelfUpdate.Prepare(ctx, manifest); err != nil {
			if release.IsTemporarilyUnavailable(err) {
				o.failBeforeMaintenanceRetryable(op, err)
			} else {
				o.failBeforeMaintenance(op, err)
			}
			return
		}
	}
	if _, err = o.Store.UpdateOperation(op.ID, func(value *model.Operation) error {
		value.TargetGeneration = manifest.ID()
		value.UpdatedAt = o.now()
		return nil
	}); err != nil {
		o.failBeforeMaintenance(op, fmt.Errorf("persist target generation: %w", err))
		return
	}
	if _, err = o.Store.MutateState(o.now(), func(state *model.ManagerState) error { state.Candidate = generation(manifest, path); return nil }); err != nil {
		o.failBeforeMaintenance(op, fmt.Errorf("persist candidate generation: %w", err))
		return
	}
	if _, err = o.Store.SetPhase(op.ID, model.PhasePulling, model.StateIdle, false, "pulling immutable image digests", o.now()); err != nil {
		o.failBeforeMaintenance(op, fmt.Errorf("persist pulling phase: %w", err))
		return
	}
	if err = o.Engine.Pull(ctx, manifest); err != nil {
		o.failBeforeMaintenanceRetryable(op, err)
		return
	}
	if _, err = o.Store.SetPhase(op.ID, model.PhasePreparing, model.StateWaitingForTasks, false, "candidate is prepared", o.now()); err != nil {
		o.failBeforeMaintenance(op, fmt.Errorf("persist preparing phase: %w", err))
		return
	}
	if err = o.Engine.Prepare(ctx, manifest); err != nil {
		o.failBeforeMaintenance(op, err)
		return
	}
	stateBeforeCutover := o.Store.State()
	freshInstall := op.Kind == model.OperationInstall && stateBeforeCutover.Current == nil && (o.Legacy == nil || !o.Legacy.Active())
	legacyCutover := op.Kind == model.OperationInstall && o.Legacy != nil && o.Legacy.Active()
	if !freshInstall {
		if err = o.reserve(ctx, op.ID, legacyCutover); err != nil {
			o.failBeforeMaintenance(op, err)
			return
		}
	}
	if legacyCutover {
		if err = o.Legacy.PreCutover(ctx, op.ID); err != nil {
			gate := o.Gate
			if o.LegacyGate != nil {
				gate = o.LegacyGate
			}
			if releaseErr := gate.Release(context.Background(), op.ID); releaseErr != nil {
				o.failAfterMaintenance(ctx, op, nil, errors.Join(err, fmt.Errorf("release reservation after cutover preflight: %w", releaseErr)))
			} else {
				o.failBeforeMaintenance(op, err)
			}
			return
		}
	}
	if _, err = o.Store.SetPhase(op.ID, model.PhaseDraining, model.StateUpdating, true, "business admission reserved", o.now()); err != nil {
		gate := o.Gate
		if legacyCutover && o.LegacyGate != nil {
			gate = o.LegacyGate
		}
		_ = gate.Release(context.Background(), op.ID)
		o.failBeforeMaintenance(op, fmt.Errorf("persist reserved admission phase: %w", err))
		return
	}
	if op.Kind == model.OperationInstall && o.Legacy != nil && o.Legacy.Active() {
		if err = o.Legacy.Cutover(ctx, op.ID); err != nil {
			o.failAfterMaintenance(ctx, op, nil, err)
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
	if !op.Finalized {
		isGenerationChange := op.Kind == model.OperationInstall || op.Kind == model.OperationUpdate
		if isGenerationChange && o.SelfUpdate != nil {
			if selfErr := o.SelfUpdate.MarkPlatformCommitted(manifest); selfErr != nil {
				return o.finalizeFailure("manager binary could not be committed", selfErr)
			}
			if selfErr := o.SelfUpdate.Activate(context.Background(), manifest); selfErr != nil {
				return o.finalizeFailure("manager activation is pending", selfErr)
			}
			committed, selfErr := o.SelfUpdate.ActivationCommitted(manifest)
			if selfErr != nil {
				return o.finalizeFailure("manager activation acknowledgement is pending", selfErr)
			}
			if !committed {
				// The old process normally reaches this point immediately after queuing
				// its own restart. Destructive legacy cleanup is intentionally deferred
				// until the watchdog has observed and committed a healthy new Manager.
				return o.finalizeFailure("manager activation acknowledgement is pending", errors.New("watchdog has not committed the candidate Manager"))
			}
		}
		if (isGenerationChange || op.Kind == model.OperationRollback) && o.OnCommit != nil {
			o.OnCommit(manifest)
		}
		if op.Kind == model.OperationInstall && o.Legacy != nil {
			if cleanupErr := o.Legacy.FinalizeCleanup(ctx, op.ID); cleanupErr != nil {
				return o.finalizeFailure("legacy archive or cleanup is pending", cleanupErr)
			}
		}
		// Admission release is the final externally visible hook. For a source
		// migration, FinalizeCleanup has already persisted the verified archive,
		// retired live-data caches, and committed legacy cleanup. This prevents
		// resumed workers from racing those filesystem mutations.
		if err := o.Gate.Release(ctx, op.ID); err != nil {
			return o.finalizeFailure("update reservation release is pending", err)
		}
		o.event(op.ID, "operation.committed", manifest.ID(), nil)
		if _, err := o.Store.UpdateOperation(op.ID, func(value *model.Operation) error {
			if value.Status != model.OperationSucceeded {
				return errors.New("cannot finalize a non-succeeded operation")
			}
			value.Finalized = true
			value.UpdatedAt = o.now()
			return nil
		}); err != nil {
			return err
		}
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
	return nil
}

func (o *Orchestrator) finalizeFailure(prefix string, cause error) error {
	message := prefix + ": " + cause.Error()
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
	manifest, err := o.loadManifest(state.Current.ManifestPath)
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
	if err = o.reserve(ctx, op.ID, false); err != nil {
		o.failBeforeMaintenance(op, err)
		return
	}
	_, _ = o.Store.SetPhase(op.ID, model.PhaseDraining, model.StateUpdating, true, "restart reserved", o.now())
	if err = o.Engine.StopFixed(ctx); err == nil {
		_, _ = o.Store.SetPhase(op.ID, model.PhaseStarting, model.StateUpdating, true, "restarting current generation", o.now())
		err = o.Engine.StartFixed(ctx, manifest)
	}
	if err == nil {
		_, _ = o.Store.SetPhase(op.ID, model.PhaseProbing, model.StateUpdating, true, "probing restarted generation", o.now())
		err = o.Engine.Probe(ctx, manifest)
	}
	if err != nil {
		o.failAfterMaintenance(ctx, op, nil, err)
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
	manifest, err := o.loadManifest(state.Previous.ManifestPath)
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
	if err = o.reserve(ctx, op.ID, false); err != nil {
		o.failBeforeMaintenance(op, err)
		return
	}
	_, _ = o.Store.SetPhase(op.ID, model.PhaseDraining, model.StateUpdating, true, "rollback reserved", o.now())
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
	_, _ = o.Store.SetPhase(op.ID, model.PhaseStarting, model.StateUpdating, true, "starting previous generation", o.now())
	if err = o.Engine.StartFixed(ctx, manifest); err == nil {
		_, _ = o.Store.SetPhase(op.ID, model.PhaseProbing, model.StateUpdating, true, "probing previous generation", o.now())
		err = o.Engine.Probe(ctx, manifest)
	}
	if err != nil {
		o.failAfterMaintenance(ctx, op, nil, err)
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
	manifest, err := o.loadManifest(state.Current.ManifestPath)
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

func (o *Orchestrator) reserve(ctx context.Context, id string, legacy bool) error {
	if _, err := o.Store.SetPhase(id, model.PhaseDraining, model.StateWaitingForTasks, false, "waiting for active tasks", o.now()); err != nil {
		return fmt.Errorf("persist task wait phase: %w", err)
	}
	for {
		if o.LocalUpdateBlockers != nil {
			running, _, _ := o.LocalUpdateBlockers()
			if running > 0 {
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
		gate := o.Gate
		if legacy && o.LegacyGate != nil {
			gate = o.LegacyGate
		}
		reservation, err := gate.Reserve(ctx, id)
		if err != nil {
			return err
		}
		if reservation.Reserved {
			return nil
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
	originalError := current.Error
	if originalError == "" {
		originalError = cause.Error()
	}
	// A process can die between persisting the operation terminal record and
	// persisting Manager state. Re-open that half-commit as a durable rollback
	// before SetPhase, which intentionally rejects terminal operations.
	_, _ = o.Store.UpdateOperation(op.ID, func(value *model.Operation) error {
		value.Status = model.OperationRunning
		value.Finalized = false
		value.CompletedAt = nil
		value.Error = originalError
		value.UpdatedAt = o.now()
		return nil
	})
	if firstAttempt {
		_, _ = o.Store.SetPhase(op.ID, model.PhaseRollingBack, model.StateUpdating, true, "restoring previous generation", o.now())
	}
	// Stop every possible writer before touching the snapshot or restarting the
	// legacy service. This also covers a first install, where state.Current is
	// nil but the candidate may already have reached StartFixed before failing
	// its readiness or public-gateway probe.
	stopErr := o.Engine.StopFixed(ctx)
	readErr := stopErr
	current, operationErr = o.Store.Operation(op.ID)
	if readErr == nil && operationErr != nil {
		readErr = operationErr
	}
	if readErr == nil && current.SnapshotPath != "" {
		readErr = o.Snapshots.Restore(ctx, current.SnapshotPath)
	}
	state := o.Store.State()
	legacyRestored := false
	if stopErr == nil && op.Kind == model.OperationInstall && o.Legacy != nil {
		if legacyErr := o.Legacy.Rollback(ctx, op.ID); legacyErr == nil {
			legacyRestored = true
		} else if readErr == nil {
			readErr = legacyErr
		}
	}
	if readErr == nil && state.Current != nil {
		var previous release.Manifest
		previous, readErr = o.loadManifest(state.Current.ManifestPath)
		if readErr == nil {
			_ = o.Engine.StopFixed(ctx)
			readErr = o.Engine.StartFixed(ctx, previous)
			if readErr == nil {
				readErr = o.Engine.Probe(ctx, previous)
			}
		}
	}
	if readErr == nil && (state.Current != nil || legacyRestored) {
		gate := o.Gate
		if legacyRestored && o.LegacyGate != nil {
			gate = o.LegacyGate
		}
		if releaseErr := gate.Release(context.Background(), op.ID); releaseErr != nil {
			readErr = fmt.Errorf("release update reservation: %w", releaseErr)
		}
	}
	if readErr == nil && state.Current == nil && !legacyRestored {
		// A clean first install has no older generation to restart. Once every
		// candidate writer is stopped and its pre-install snapshot is restored,
		// the safe outcome is a terminal failed install behind the Manager page.
		_, _ = o.Store.Complete(op.ID, false, func(value *model.ManagerState) {
			value.PublicState = model.StateFailed
			value.Maintenance = true
			value.LastError = originalError
			value.Candidate = nil
			value.RetryAfterSeconds = 0
		}, originalError, o.now())
	} else if readErr == nil && (state.Current != nil || legacyRestored) {
		_, _ = o.Store.Complete(op.ID, false, func(value *model.ManagerState) {
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
		_, _ = o.Store.UpdateOperation(op.ID, func(value *model.Operation) error {
			value.Status = model.OperationRunning
			value.Phase = model.PhaseRollingBack
			value.Error = originalError
			value.CompletedAt = nil
			value.Finalized = false
			value.UpdatedAt = o.now()
			return nil
		})
		_, _ = o.Store.MutateState(o.now(), func(value *model.ManagerState) error {
			value.ActiveOperationID = op.ID
			value.Phase = model.PhaseRollingBack
			value.PublicState = model.StateFailed
			value.Maintenance = true
			value.LastError = message
			value.RetryAfterSeconds = 5
			return nil
		})
	}
	if firstAttempt {
		o.event(op.ID, "operation.failed", op.TargetGeneration, cause)
	}
	_ = target
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
		value.Error = err.Error()
	}
	_ = o.Log.Append(value)
}
func generation(manifest release.Manifest, path string) *model.Generation {
	return &model.Generation{ID: manifest.ID(), ManifestPath: path, SourceCommit: manifest.SourceCommit, DatabaseVersion: manifest.DatabaseSchemaVersion, Images: manifest.Images}
}

func validSourceCommit(value string) bool {
	if len(value) != 40 {
		return false
	}
	for _, r := range value {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			return false
		}
	}
	return true
}

var _ = json.Valid
