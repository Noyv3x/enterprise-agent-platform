//go:build linux

package handoffowner

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

const maxCoordinatorSteps = 64

var (
	fullCommitPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)
	sha256Pattern     = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// TransitionError reports a bridge that safely terminated as aborted or
// rolled_back. A nonterminal recovery failure is returned directly instead.
type TransitionError struct {
	TransactionID string
	Status        handoff.Status
	Cause         string
}

func (e *TransitionError) Error() string {
	return fmt.Sprintf("namespace handoff %s ended %s: %s", e.TransactionID, e.Status, e.Cause)
}

// New constructs a source-owner coordinator from explicit immutable
// profiles. It rejects target-selected or field-mutated source identities.
func New(options Options) (*Coordinator, error) {
	if options.Store == nil || options.Host == nil || options.Listeners == nil {
		return nil, errors.New("handoff owner requires journal, host, and listener drivers")
	}
	source, err := options.SourceProfile.Profile()
	if err != nil {
		return nil, fmt.Errorf("validate source active profile: %w", err)
	}
	if !reflect.DeepEqual(source, identity.SourceProfile()) {
		return nil, errors.New("handoff owner must be constructed under the canonical source profile")
	}
	if _, err := identity.ActivateVerifiedHandoffTarget(options.TargetProfile); err != nil {
		return nil, fmt.Errorf("validate target profile: %w", err)
	}
	if options.Channel == "" {
		return nil, errors.New("handoff owner release channel is required")
	}
	goos := options.GOOS
	if goos == "" {
		goos = runtime.GOOS
	}
	goarch := options.GOARCH
	if goarch == "" {
		goarch = runtime.GOARCH
	}
	if goos != "linux" || (goarch != "amd64" && goarch != "arm64") {
		return nil, fmt.Errorf("handoff owner does not support %s/%s", goos, goarch)
	}
	clock := options.Clock
	if clock == nil {
		clock = time.Now
	}
	return &Coordinator{
		store: options.Store, host: options.Host, listeners: options.Listeners,
		active: options.SourceProfile, source: source, target: options.TargetProfile, channel: options.Channel,
		goos: goos, goarch: goarch, clock: clock,
	}, nil
}

// Begin routes and persists a new bridge transaction. The only call before
// Store.Create is HostDriver.Preflight, whose interface contract is read-only.
// The first host effect is arming the persistent helper after the independent
// journal has been fsynced.
func (c *Coordinator) Begin(ctx context.Context, request BridgeRequest) (handoff.Journal, error) {
	binding, descriptor, err := c.validateBridgeRequest(request)
	if err != nil {
		return handoff.Journal{}, err
	}

	var admission RuntimeObservationLease
	created, existing, createErr := c.store.CreatePlanned(func() (handoff.Journal, error) {
		plan, preflightErr := c.host.Preflight(ctx, request, c.source, c.target)
		if preflightErr != nil {
			return handoff.Journal{}, fmt.Errorf("namespace handoff preflight: %w", preflightErr)
		}
		admission = plan.Admission
		if admission == nil {
			return handoff.Journal{}, errors.New("namespace handoff preflight did not retain ordinary runtime admission")
		}
		if plan.Evidence.DatabaseSchemaVersion != request.Manifest.DatabaseSchemaVersion {
			return handoff.Journal{}, errors.New("handoff preflight database schema differs from the bridge manifest")
		}
		if artifact := descriptor.Source.Manager.Artifacts[c.goarch]; plan.Source.StableSHA256 != artifact.SHA256 {
			return handoff.Journal{}, errors.New("handoff source stable binary differs from the predecessor artifact")
		}
		if err := validateIdleRuntime(plan.Runtime, c.source, descriptor.PredecessorGeneration, plan.Source.StableSHA256); err != nil {
			return handoff.Journal{}, fmt.Errorf("handoff preflight runtime boundary: %w", err)
		}
		journal, journalErr := handoff.NewJournal(binding, plan.Source, plan.Target, plan.Evidence, c.now(time.Time{}))
		if journalErr != nil {
			return handoff.Journal{}, fmt.Errorf("construct handoff journal: %w", journalErr)
		}
		if err := c.validateJournalProfiles(journal); err != nil {
			return handoff.Journal{}, err
		}
		return journal, nil
	})
	var closeErr error
	if admission != nil {
		closeErr = admission.Close()
	}
	if createErr != nil || closeErr != nil {
		return created, errors.Join(createErr, closeErr)
	}
	if existing {
		if !reflect.DeepEqual(created.Release, binding) || created.Source.Namespace != c.source.ProfileID ||
			created.Target.Namespace != c.target.ProfileID {
			return handoff.Journal{}, ErrHandoffInProgress
		}
		if err := c.validateJournalProfiles(created); err != nil {
			return handoff.Journal{}, err
		}
	}
	if err := c.host.ArmPersistentHelper(ctx, created); err != nil {
		// The journal intentionally remains nonterminal. Startup recovery can
		// reconcile an arm operation whose result was uncertain.
		verb := "arm"
		if existing {
			verb = "re-arm"
		}
		return created, fmt.Errorf("%s persistent handoff helper: %w", verb, err)
	}
	return created, nil
}

// RecoverStartup discovers the unique nonterminal journal, re-arms its
// persistent helper idempotently, and returns the fail-closed startup routing
// facts. It never executes host migration phases in the Manager process.
func (c *Coordinator) RecoverStartup(ctx context.Context) (StartupRecovery, error) {
	journal, found, err := c.store.DiscoverNonTerminal()
	if err != nil {
		return StartupRecovery{}, fmt.Errorf("discover startup handoff: %w", err)
	}
	if !found {
		return StartupRecovery{}, nil
	}
	if err := c.validateJournalProfiles(journal); err != nil {
		return StartupRecovery{}, err
	}
	disposition := startupRecovery(journal)
	if err := c.host.ArmPersistentHelper(ctx, journal); err != nil {
		return disposition, fmt.Errorf("re-arm startup handoff helper: %w", err)
	}
	return disposition, nil
}

func startupRecovery(journal handoff.Journal) StartupRecovery {
	forwardTarget := journal.Status == handoff.StatusRunning &&
		phaseAtOrAfter(journal.Phase, handoff.PhaseDataRelocated) &&
		!phaseAtOrAfter(journal.Phase, handoff.PhaseCommitted)
	sourceParticipant := journal.Status == handoff.StatusRunning && !phaseAtOrAfter(journal.Phase, handoff.PhaseSourceFenced)
	if journal.Status == handoff.StatusRecovering &&
		(journal.Phase == handoff.PhaseDataRestored || journal.Phase == handoff.PhaseSourceStarted) {
		sourceParticipant = true
	}
	maintenance := journal.Status == handoff.StatusRecovering || phaseAtOrAfter(journal.Phase, handoff.PhaseAdmissionReserved)
	return StartupRecovery{
		Active: true, TransactionID: journal.TransactionID, Status: journal.Status,
		Phase: journal.Phase, DesiredOutcome: journal.DesiredOutcome,
		BlockOrdinaryOperations: true, MaintenanceRequired: maintenance,
		PersistentHelperRequired: true, SourceParticipantRequired: sourceParticipant,
		TargetParticipantRequired: forwardTarget,
	}
}

// Resume is the persistent helper entry point. OpenHelper holds the global
// singleton and transaction locks, in that order, for every host effect and
// journal checkpoint through terminal settlement.
func (c *Coordinator) Resume(ctx context.Context, transactionID string) (handoff.Journal, error) {
	helper, journal, err := c.store.OpenHelper(transactionID)
	if err != nil {
		return handoff.Journal{}, fmt.Errorf("acquire persistent handoff ownership: %w", err)
	}
	closed := false
	defer func() {
		if !closed {
			_ = helper.Close()
		}
	}()
	if err := c.validateJournalProfiles(journal); err != nil {
		_ = helper.Close()
		closed = true
		return journal, err
	}

	final, runErr := c.runOwned(ctx, helper, journal, ListenerState{})
	closeErr := helper.Close()
	closed = true
	if closeErr != nil && runErr == nil {
		runErr = fmt.Errorf("release handoff journal ownership: %w", closeErr)
	}
	if final.Terminal() {
		if err := c.host.FinalizePersistentHelper(ctx, final); err != nil {
			runErr = errors.Join(runErr, fmt.Errorf("finalize persistent handoff helper: %w", err))
		}
	}
	return final, runErr
}

func (c *Coordinator) runOwned(ctx context.Context, helper *handoff.Helper, journal handoff.Journal, listeners ListenerState) (handoff.Journal, error) {
	for step := 0; step < maxCoordinatorSteps; step++ {
		if journal.Terminal() {
			// A terminal journal is the authoritative business result. The
			// persistent helper must exit successfully after disabling its unit;
			// returning the original migration failure here would make systemd's
			// Restart=on-failure start a new PID after safe settlement.
			return journal, nil
		}
		if err := ctx.Err(); err != nil {
			return journal, err
		}

		verified, err := c.host.VerifyPersistentHelper(ctx, journal)
		if err != nil {
			cause := fmt.Errorf("verify persistent helper: %w", err)
			updated, updateErr := c.recordError(helper, journal, cause)
			if updateErr != nil {
				return journal, errors.Join(cause, updateErr)
			}
			return updated, cause
		}
		if journal.Helper == nil {
			if journal.Phase != handoff.PhasePlanned {
				return c.settleFailure(ctx, helper, journal, listeners, errors.New("helper evidence is absent after planned"))
			}
			journal, err = c.mutate(helper, journal, c.now(journal.UpdatedAt), func(next *handoff.Journal) {
				evidence := verified
				next.Helper = &evidence
			})
			if err != nil {
				return journal, fmt.Errorf("persist helper evidence: %w", err)
			}
			continue
		}
		if !reflect.DeepEqual(*journal.Helper, verified) {
			cause := errors.New("persistent helper identity changed")
			updated, updateErr := c.recordError(helper, journal, cause)
			if updateErr != nil {
				return journal, errors.Join(cause, updateErr)
			}
			return updated, cause
		}

		if journal.Status == handoff.StatusRecovering {
			var stepErr error
			journal, listeners, stepErr = c.rollbackStep(ctx, helper, journal, listeners)
			if stepErr != nil {
				if c.interrupted(ctx, stepErr) {
					return journal, stepErr
				}
				updated, updateErr := c.recordError(helper, journal, stepErr)
				if updateErr != nil {
					return journal, errors.Join(stepErr, updateErr)
				}
				return updated, stepErr
			}
			continue
		}
		if journal.Error != "" && !sourceFenceRecorded(journal) {
			return c.abortBeforeFence(ctx, helper, journal, listeners, errors.New(journal.Error))
		}

		var stepErr error
		journal, listeners, stepErr = c.forwardStep(ctx, helper, journal, listeners)
		if stepErr != nil {
			if c.interrupted(ctx, stepErr) {
				return journal, stepErr
			}
			return c.settleFailure(ctx, helper, journal, listeners, stepErr)
		}
	}
	return journal, errors.New("handoff coordinator exceeded its bounded phase loop")
}

func (c *Coordinator) forwardStep(ctx context.Context, helper *handoff.Helper, journal handoff.Journal, listeners ListenerState) (handoff.Journal, ListenerState, error) {
	var err error
	switch journal.Phase {
	case handoff.PhasePlanned:
		journal, err = c.advance(helper, journal, handoff.PhaseHelperArmed)
	case handoff.PhaseHelperArmed:
		err = c.host.ReserveAdmission(ctx, journal)
		if err == nil {
			journal, err = c.advance(helper, journal, handoff.PhaseAdmissionReserved)
		}
	case handoff.PhaseAdmissionReserved:
		err = c.host.DrainAndStopWriters(ctx, journal)
		if err == nil {
			journal, err = c.advance(helper, journal, handoff.PhaseWritersStopped)
		}
	case handoff.PhaseWritersStopped:
		if journal.Snapshot == nil {
			var snapshot handoff.Snapshot
			snapshot, err = c.host.CreateSnapshot(ctx, journal)
			if err == nil {
				journal, err = c.mutate(helper, journal, c.now(journal.UpdatedAt), func(next *handoff.Journal) {
					value := snapshot
					next.Snapshot = &value
				})
			}
		} else {
			journal, err = c.advance(helper, journal, handoff.PhaseSnapshotReady)
		}
	case handoff.PhaseSnapshotReady:
		listeners, err = c.ensureMaintenance(ctx, helper, journal, listeners)
		if err == nil {
			err = c.host.FenceSource(ctx, journal)
		}
		if err == nil {
			journal, err = c.advance(helper, journal, handoff.PhaseSourceFenced)
		}
	case handoff.PhaseSourceFenced:
		listeners, err = c.ensureMaintenance(ctx, helper, journal, listeners)
		if err == nil {
			err = c.host.StageTarget(ctx, journal)
		}
		if err == nil {
			journal, err = c.advance(helper, journal, handoff.PhaseTargetStaged)
		}
	case handoff.PhaseTargetStaged:
		listeners, err = c.ensureMaintenance(ctx, helper, journal, listeners)
		if err == nil {
			err = c.host.TransformData(ctx, journal)
		}
		if err == nil {
			journal, err = c.advance(helper, journal, handoff.PhaseDataRelocated)
		}
	case handoff.PhaseDataRelocated:
		listeners, err = c.ensureMaintenance(ctx, helper, journal, listeners)
		if err == nil {
			err = c.host.StartTarget(ctx, journal, helper.StartupLease())
		}
		if err == nil {
			journal, err = c.advance(helper, journal, handoff.PhaseTargetStarted)
		}
	case handoff.PhaseTargetStarted:
		listeners, err = c.ensureMaintenance(ctx, helper, journal, listeners)
		if err == nil {
			err = c.host.ProbeTarget(ctx, journal)
		}
		if err != nil {
			break
		}
		if journal.TargetAck == nil {
			var acknowledgement handoff.TargetAck
			acknowledgement, err = c.host.TargetAcknowledgement(ctx, journal)
			if err == nil {
				at := c.now(journal.UpdatedAt)
				if acknowledgement.IssuedAt.After(at) {
					at = acknowledgement.IssuedAt.UTC()
				}
				journal, err = c.mutate(helper, journal, at, func(next *handoff.Journal) {
					value := acknowledgement
					next.TargetAck = &value
				})
			}
		} else {
			journal, err = c.advance(helper, journal, handoff.PhaseTargetVerified)
		}
	case handoff.PhaseTargetVerified:
		listeners, err = c.ensureMaintenance(ctx, helper, journal, listeners)
		if err == nil {
			err = c.host.RetireSource(ctx, journal)
		}
		if err == nil {
			journal, err = c.advance(helper, journal, handoff.PhaseSourceRetired)
		}
	case handoff.PhaseSourceRetired:
		listeners, err = c.ensureMaintenance(ctx, helper, journal, listeners)
		if err == nil {
			err = c.host.VerifyTargetCommitBoundary(ctx, journal)
		}
		if err == nil {
			err = c.listeners.CommitToTarget(ctx, journal, helper.StartupLease(), listeners.Listeners)
		}
		if err == nil {
			listeners = ListenerState{Owner: ListenerOwnerTarget}
			journal, err = c.advance(helper, journal, handoff.PhaseTargetCommitPlanned)
		}
	case handoff.PhaseTargetCommitPlanned:
		var receipt handoff.TargetPlatformCommit
		listeners, err = c.ensureMaintenance(ctx, helper, journal, listeners)
		// The target unit is boot-enabled at this forward-only boundary, but a
		// host crash can restart it without the one-shot startup capability.
		// Reissue and prove the same journal-bound restricted participant before
		// asking Platform for the idempotent commit receipt.
		if err == nil {
			err = c.host.StartTarget(ctx, journal, helper.StartupLease())
		}
		if err == nil {
			// A reboot loses every process-owned descriptor. Reconcile an existing
			// authenticated target owner or transfer freshly rebound helper FDs
			// before Platform can release its persistent maintenance reservation.
			err = c.listeners.CommitToTarget(ctx, journal, helper.StartupLease(), listeners.Listeners)
		}
		if err == nil {
			listeners = ListenerState{Owner: ListenerOwnerTarget}
			receipt, err = c.host.CommitTargetPlatform(ctx, journal)
		}
		if err == nil {
			at := c.now(journal.UpdatedAt)
			var committedAt time.Time
			committedAt, err = time.Parse(time.RFC3339Nano, receipt.CommittedAt)
			if err == nil && committedAt.Location() != time.UTC {
				err = errors.New("target Platform commit timestamp is not UTC")
			}
			if err == nil && committedAt.After(at) {
				at = committedAt.UTC()
			}
			if err == nil {
				journal, err = c.mutate(helper, journal, at, func(next *handoff.Journal) {
					value := receipt
					next.TargetPlatformCommit = &value
					next.Error = ""
					next.Phase = handoff.PhaseCommitted
					next.Status = handoff.StatusCommitted
				})
			}
		}
	default:
		err = fmt.Errorf("unexpected forward handoff phase %q", journal.Phase)
	}
	return journal, listeners, err
}

func (c *Coordinator) rollbackStep(ctx context.Context, helper *handoff.Helper, journal handoff.Journal, listeners ListenerState) (handoff.Journal, ListenerState, error) {
	var err error
	switch journal.Phase {
	case handoff.PhaseRollbackPlanned:
		// First prove the current unique owner. If a lost transfer response left
		// target owning the maintenance listener, this observation must complete
		// before target is fenced.
		listeners, err = c.ensureMaintenance(ctx, helper, journal, listeners)
		if err == nil {
			err = c.host.StopTarget(ctx, journal)
		}
		if err == nil {
			// Fencing target invalidates its observed custody. Re-observe under the
			// bind lock so helper serves 503 before data restoration begins.
			listeners, err = c.ensureMaintenance(ctx, helper, journal, ListenerState{})
		}
		if err == nil {
			journal, err = c.advance(helper, journal, handoff.PhaseTargetStopped)
		}
	case handoff.PhaseTargetStopped:
		listeners, err = c.ensureMaintenance(ctx, helper, journal, listeners)
		if err == nil {
			err = c.host.RestoreData(ctx, journal)
		}
		if err == nil {
			journal, err = c.advance(helper, journal, handoff.PhaseDataRestored)
		}
	case handoff.PhaseDataRestored:
		listeners, err = c.ensureMaintenance(ctx, helper, journal, listeners)
		if err == nil {
			err = c.host.StartSource(ctx, journal, helper.StartupLease())
		}
		if err == nil {
			journal, err = c.advance(helper, journal, handoff.PhaseSourceStarted)
		}
	case handoff.PhaseSourceStarted:
		listeners, err = c.ensureMaintenance(ctx, helper, journal, listeners)
		if err == nil {
			err = c.listeners.RestoreToSource(ctx, journal, helper.StartupLease(), listeners.Listeners)
		}
		if err == nil {
			listeners = ListenerState{Owner: ListenerOwnerSource}
			err = c.host.VerifySourceIdentity(ctx, journal)
		}
		if err == nil {
			err = c.host.VerifySourcePublicReady(ctx, journal)
		}
		if err == nil {
			err = c.host.ReleaseAdmission(ctx, journal)
		}
		if err == nil {
			journal, err = c.mutate(helper, journal, c.now(journal.UpdatedAt), func(next *handoff.Journal) {
				next.Phase = handoff.PhaseRolledBack
				next.Status = handoff.StatusRolledBack
			})
		}
	default:
		err = fmt.Errorf("unexpected rollback handoff phase %q", journal.Phase)
	}
	return journal, listeners, err
}

func (c *Coordinator) ensureMaintenance(ctx context.Context, helper *handoff.Helper, journal handoff.Journal, current ListenerState) (ListenerState, error) {
	observed, err := c.listeners.EnsureMaintenance(ctx, journal, helper.StartupLease(), current)
	if err != nil {
		return ListenerState{}, err
	}
	switch observed.Owner {
	case ListenerOwnerHelper:
		if len(observed.Listeners) == 0 {
			return ListenerState{}, errors.New("helper listener observation has no descriptors")
		}
	case ListenerOwnerSource, ListenerOwnerTarget:
		if len(observed.Listeners) != 0 {
			return ListenerState{}, errors.New("participant listener observation unexpectedly exposes descriptors")
		}
	default:
		return ListenerState{}, errors.New("listener maintenance owner is unknown")
	}
	return observed, nil
}

func (c *Coordinator) settleFailure(ctx context.Context, helper *handoff.Helper, journal handoff.Journal, listeners ListenerState, cause error) (handoff.Journal, error) {
	updated, err := c.recordError(helper, journal, cause)
	if err != nil {
		return journal, errors.Join(cause, err)
	}
	if updated.Status == handoff.StatusRecovering {
		// Continue rollback under the same uninterrupted Helper lease.
		return c.runOwned(ctx, helper, updated, listeners)
	}
	if updated.Phase == handoff.PhaseTargetCommitPlanned && updated.Status == handoff.StatusRunning &&
		updated.DesiredOutcome == handoff.OutcomeForward {
		// The durable checkpoint precedes the first potentially side-effectful
		// Platform commit request. Its outcome may be unknown, so this boundary
		// is forward-only and a persistent helper replay must retry/observe the
		// exact receipt instead of restoring stale source data.
		return updated, cause
	}
	return c.abortBeforeFence(ctx, helper, updated, listeners, cause)
}

func (c *Coordinator) abortBeforeFence(ctx context.Context, helper *handoff.Helper, journal handoff.Journal, listeners ListenerState, cause error) (handoff.Journal, error) {
	if sourceFenceRecorded(journal) {
		return journal, errors.New("cannot abort a handoff after source_fenced")
	}
	if journal.Phase == handoff.PhaseSnapshotReady {
		var err error
		listeners, err = c.ensureMaintenance(ctx, helper, journal, listeners)
		if err != nil {
			return journal, errors.Join(cause, fmt.Errorf("restore pre-fence maintenance listener custody: %w", err))
		}
	}
	steps := []struct {
		name string
		run  func() error
	}{
		{"remove target staging", func() error { return c.host.RemoveTargetStaging(ctx, journal) }},
		{"restore source before fence", func() error { return c.host.RestoreSourceBeforeFence(ctx, journal, helper.StartupLease()) }},
		{"restore source listeners", func() error {
			return c.listeners.RestoreToSource(ctx, journal, helper.StartupLease(), listeners.Listeners)
		}},
		{"verify source identity", func() error { return c.host.VerifySourceIdentity(ctx, journal) }},
		{"release admission", func() error { return c.host.ReleaseAdmission(ctx, journal) }},
		{"verify source public readiness", func() error { return c.host.VerifySourcePublicReady(ctx, journal) }},
	}
	for _, step := range steps {
		if err := step.run(); err != nil {
			if c.interrupted(ctx, err) {
				return journal, err
			}
			updated, updateErr := c.recordError(helper, journal, fmt.Errorf("%s: %w", step.name, err))
			if updateErr != nil {
				return journal, errors.Join(err, updateErr)
			}
			return updated, fmt.Errorf("abort cleanup %s: %w", step.name, err)
		}
	}
	if journal.AbortCleanup == nil {
		cleanup := handoff.AbortCleanup{
			ReservationReleased: true, StagingRemoved: true, ListenersRestored: true,
			SourceIdentityVerified: true, SourcePublicReady: true,
		}
		var err error
		journal, err = c.mutate(helper, journal, c.now(journal.UpdatedAt), func(next *handoff.Journal) {
			next.AbortCleanup = &cleanup
		})
		if err != nil {
			return journal, errors.Join(cause, fmt.Errorf("persist abort cleanup: %w", err))
		}
	}
	var err error
	journal, err = c.mutate(helper, journal, c.now(journal.UpdatedAt), func(next *handoff.Journal) {
		next.DesiredOutcome = handoff.OutcomeRollback
		next.Status = handoff.StatusAborted
		next.Phase = handoff.PhaseAborted
	})
	if err != nil {
		return journal, errors.Join(cause, fmt.Errorf("commit handoff abort: %w", err))
	}
	return journal, nil
}

func (c *Coordinator) recordError(helper *handoff.Helper, journal handoff.Journal, cause error) (handoff.Journal, error) {
	message := boundedError(cause)
	if journal.Error == message {
		return journal, nil
	}
	updated, err := c.mutate(helper, journal, c.now(journal.UpdatedAt), func(next *handoff.Journal) {
		next.Error = message
	})
	if err != nil {
		return journal, fmt.Errorf("persist handoff failure: %w", err)
	}
	return updated, nil
}

func (c *Coordinator) advance(helper *handoff.Helper, journal handoff.Journal, phase handoff.Phase) (handoff.Journal, error) {
	return c.mutate(helper, journal, c.now(journal.UpdatedAt), func(next *handoff.Journal) { next.Phase = phase })
}

func (c *Coordinator) mutate(helper *handoff.Helper, journal handoff.Journal, at time.Time, mutate func(*handoff.Journal)) (handoff.Journal, error) {
	return helper.Mutate(journal.Revision, at, func(next *handoff.Journal) error {
		mutate(next)
		return nil
	})
}

func (c *Coordinator) now(minimum time.Time) time.Time {
	now := c.clock().UTC()
	if now.IsZero() || now.Before(minimum) {
		return minimum.UTC()
	}
	return now
}

func (c *Coordinator) interrupted(ctx context.Context, err error) bool {
	return ctx.Err() != nil && errors.Is(err, ctx.Err())
}

func (c *Coordinator) validateBridgeRequest(request BridgeRequest) (handoff.ReleaseBinding, release.NamespaceHandoff, error) {
	if request.Manifest.NamespaceHandoff == nil {
		return handoff.ReleaseBinding{}, release.NamespaceHandoff{}, ErrOrdinaryManifest
	}
	if err := request.Manifest.ValidateForProfile(c.channel, c.goos, c.goarch, c.active); err != nil {
		return handoff.ReleaseBinding{}, release.NamespaceHandoff{}, fmt.Errorf("validate bridge release: %w", err)
	}
	if !canonicalAbsolutePath(request.ManifestPath) || !sha256Pattern.MatchString(request.ManifestSHA256) {
		return handoff.ReleaseBinding{}, release.NamespaceHandoff{}, errors.New("bridge manifest path or digest is invalid")
	}
	descriptor := *request.Manifest.NamespaceHandoff
	if descriptor.Source.ProfileID != c.source.ProfileID || descriptor.Target.ProfileID != c.target.ProfileID {
		return handoff.ReleaseBinding{}, release.NamespaceHandoff{}, errors.New("bridge manifest profiles differ from the injected technical profiles")
	}
	targetArtifact, ok := descriptor.Target.Manager.Artifacts[c.goarch]
	if !ok {
		return handoff.ReleaseBinding{}, release.NamespaceHandoff{}, errors.New("bridge target Manager artifact for this architecture is absent")
	}
	return handoff.ReleaseBinding{
		PredecessorGeneration: descriptor.PredecessorGeneration,
		BridgeGeneration:      descriptor.BridgeGeneration,
		ManifestPath:          request.ManifestPath,
		ManifestSHA256:        request.ManifestSHA256,
		TargetManagerSHA256:   targetArtifact.SHA256,
		TargetManagerVersion:  descriptor.Target.Manager.Version,
		TargetComposeSHA256:   descriptor.Target.Compose.SHA256,
	}, descriptor, nil
}

func (c *Coordinator) validateJournalProfiles(journal handoff.Journal) error {
	if journal.Source.Namespace != c.source.ProfileID || journal.Source.Unit != c.source.ManagerUnit ||
		journal.Source.ComposeProject != c.source.ComposeProject || journal.Source.CoreNetwork != c.source.CoreNetwork ||
		journal.Source.LabelPrefix != c.source.LabelPrefix {
		return errors.New("handoff journal source binding differs from the injected source profile")
	}
	if journal.Target.Namespace != c.target.ProfileID || journal.Target.Unit != c.target.ManagerUnit ||
		journal.Target.ComposeProject != c.target.ComposeProject || journal.Target.CoreNetwork != c.target.CoreNetwork ||
		journal.Target.LabelPrefix != c.target.LabelPrefix {
		return errors.New("handoff journal target binding differs from the injected target profile")
	}
	return handoff.Validate(journal)
}

func transitionError(journal handoff.Journal) error {
	cause := journal.Error
	if cause == "" {
		cause = "bridge did not commit"
	}
	return &TransitionError{TransactionID: journal.TransactionID, Status: journal.Status, Cause: cause}
}

func boundedError(err error) string {
	message := strings.TrimSpace(err.Error())
	if message == "" {
		message = "namespace handoff failed"
	}
	if len(message) <= handoff.MaxErrorBytes {
		return message
	}
	message = message[:handoff.MaxErrorBytes]
	for len(message) > 0 && !utf8.ValidString(message) {
		message = message[:len(message)-1]
	}
	return message
}

func sourceFenceRecorded(journal handoff.Journal) bool {
	for _, event := range journal.History {
		if event.Phase == handoff.PhaseSourceFenced {
			return true
		}
	}
	return false
}

func phaseAtOrAfter(phase, threshold handoff.Phase) bool {
	order := []handoff.Phase{
		handoff.PhasePlanned, handoff.PhaseHelperArmed, handoff.PhaseAdmissionReserved,
		handoff.PhaseWritersStopped, handoff.PhaseSnapshotReady, handoff.PhaseSourceFenced,
		handoff.PhaseTargetStaged, handoff.PhaseDataRelocated, handoff.PhaseTargetStarted,
		handoff.PhaseTargetVerified, handoff.PhaseSourceRetired, handoff.PhaseTargetCommitPlanned,
		handoff.PhaseCommitted,
	}
	position := func(value handoff.Phase) int {
		for index, candidate := range order {
			if candidate == value {
				return index
			}
		}
		return -1
	}
	left, right := position(phase), position(threshold)
	return left >= 0 && right >= 0 && left >= right
}

func canonicalAbsolutePath(path string) bool {
	return path != "" && filepath.IsAbs(path) && filepath.Clean(path) == path
}

func digestJSON(value any) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}
