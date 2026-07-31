//go:build linux

package handofflisteners

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"sync"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handofffd"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffowner"
)

// HelperDriver implements handoffowner.ListenerDriver. Construction creates
// the source receiver immediately, before a helper resumes its coordinator.
type HelperDriver struct {
	directory     string
	transactionID string
	expected      ExpectedResolver
	probe         OwnershipProbe
	authority     HelperAuthority
	rebinder      Rebinder

	mu             sync.Mutex
	sourceReceiver *handofffd.Receiver
	held           []handofffd.NamedListener
	maintenance    *maintenanceGroup
	closed         bool
}

func NewHelper(options HelperOptions) (*HelperDriver, error) {
	if options.Expected == nil || options.Probe == nil {
		return nil, errors.New("listener helper requires expected-address and ownership verifiers")
	}
	if options.Rebinder == nil {
		options.Rebinder = TCPRebinder{}
	}
	path, err := socketPath(options.TransactionDirectory, options.TransactionID, handofffd.SourceToHelperSocketBasename)
	if err != nil {
		return nil, err
	}
	receiver, err := handofffd.ListenAtRecovering(options.TransactionDirectory, filepath.Base(path))
	if err != nil {
		return nil, fmt.Errorf("open source-to-helper listener receiver: %w", err)
	}
	return &HelperDriver{
		directory: options.TransactionDirectory, transactionID: options.TransactionID,
		expected: options.Expected, probe: options.Probe, authority: options.Authority,
		rebinder: options.Rebinder, sourceReceiver: receiver,
	}, nil
}

func (driver *HelperDriver) EnsureMaintenance(ctx context.Context, journal handoff.Journal, lease handoff.StartupLease, current handoffowner.ListenerState) (handoffowner.ListenerState, error) {
	driver.mu.Lock()
	defer driver.mu.Unlock()
	expected, err := driver.prepare(ctx, journal, lease)
	if err != nil {
		return handoffowner.ListenerState{}, err
	}
	policy, err := maintenancePolicyForPhase(journal.Phase)
	if err != nil {
		return handoffowner.ListenerState{}, err
	}
	if driver.liveHeld(expected) {
		if err := driver.verifyLease(ctx, journal, lease); err != nil {
			return handoffowner.ListenerState{}, fmt.Errorf("revalidate helper lease for retained public listeners: %w", err)
		}
		return helperListenerState(driver.held), nil
	}
	if current.Owner == handoffowner.ListenerOwnerHelper {
		if len(current.Listeners) == 0 || describeExact(current.Listeners, expected) != nil {
			return handoffowner.ListenerState{}, errors.New("recorded helper listener custody has no complete live descriptor set")
		}
		if err := driver.startMaintenanceWithLeaseLocked(ctx, journal, lease, current.Listeners, expected); err != nil {
			return handoffowner.ListenerState{}, fmt.Errorf("restore maintenance service for recorded helper listeners: %w", err)
		}
		return helperListenerState(current.Listeners), nil
	}
	if len(current.Listeners) != 0 {
		return handoffowner.ListenerState{}, errors.New("non-helper listener custody unexpectedly carries descriptors")
	}
	owner, err := driver.probeOwner(ctx, journal, lease, expected)
	if err != nil {
		return handoffowner.ListenerState{}, fmt.Errorf("probe public listener owner before maintenance recovery: %w", err)
	}
	switch owner {
	case OwnerSource:
		if policy.allowSourceOwner {
			if err := driver.verifyLease(ctx, journal, lease); err != nil {
				return handoffowner.ListenerState{}, fmt.Errorf("revalidate helper lease after proving source listener ownership: %w", err)
			}
			return handoffowner.ListenerState{Owner: handoffowner.ListenerOwnerSource}, nil
		}
		if !policy.receiveSource {
			return handoffowner.ListenerState{}, fmt.Errorf("source owns public listeners in incompatible handoff phase %q", journal.Phase)
		}
		if driver.sourceReceiver == nil {
			return handoffowner.ListenerState{}, errors.New("source owns public listeners but the source-to-helper receiver is unavailable")
		}
		if err := driver.verifyLease(ctx, journal, lease); err != nil {
			return handoffowner.ListenerState{}, fmt.Errorf("revalidate helper lease before receiving public listeners: %w", err)
		}
		listeners, err := driver.sourceReceiver.AcceptExactWithAdoption(ctx, journal.TransactionID, expected, func([]handofffd.NamedListener) error {
			if err := driver.verifyLease(ctx, journal, lease); err != nil {
				return fmt.Errorf("helper lease changed after receiving public listeners: %w", err)
			}
			return nil
		})
		if err != nil {
			return handoffowner.ListenerState{}, fmt.Errorf("receive source public listeners: %w", err)
		}
		if err := driver.verifyLease(ctx, journal, lease); err != nil {
			_ = closeListeners(listeners)
			return handoffowner.ListenerState{}, fmt.Errorf("revalidate helper lease after source listener acknowledgement: %w", err)
		}
		if err := driver.verifyLease(ctx, journal, lease); err != nil {
			_ = closeListeners(listeners)
			return handoffowner.ListenerState{}, fmt.Errorf("revalidate helper lease before retiring source receiver: %w", err)
		}
		closeErr := driver.sourceReceiver.Close()
		driver.sourceReceiver = nil
		leaseErr := driver.verifyLease(ctx, journal, lease)
		if closeErr != nil || leaseErr != nil {
			_ = closeListeners(listeners)
			return handoffowner.ListenerState{}, errors.Join(
				wrapError("retire source-to-helper receiver", closeErr),
				wrapError("helper lease changed after retiring source receiver", leaseErr),
			)
		}
		if err := driver.startMaintenanceWithLeaseLocked(ctx, journal, lease, listeners, expected); err != nil {
			_ = closeListeners(listeners)
			return handoffowner.ListenerState{}, fmt.Errorf("start helper maintenance service: %w", err)
		}
		return helperListenerState(listeners), nil
	case OwnerNone:
		listeners, err := driver.recoverLocked(ctx, journal, lease, expected)
		if err != nil {
			return handoffowner.ListenerState{}, err
		}
		return helperListenerState(listeners), nil
	case OwnerTarget:
		if !policy.allowTargetOwner {
			return handoffowner.ListenerState{}, fmt.Errorf("target owns public listeners in incompatible handoff phase %q", journal.Phase)
		}
		if err := driver.verifyLease(ctx, journal, lease); err != nil {
			return handoffowner.ListenerState{}, fmt.Errorf("revalidate helper lease after proving target listener ownership: %w", err)
		}
		return handoffowner.ListenerState{Owner: handoffowner.ListenerOwnerTarget}, nil
	case OwnerHelper:
		return handoffowner.ListenerState{}, errors.New("another helper process appears to own public listeners")
	default:
		return handoffowner.ListenerState{}, errors.New("public listener ownership is unknown")
	}
}

type maintenancePhasePolicy struct {
	receiveSource    bool
	allowSourceOwner bool
	allowTargetOwner bool
}

func maintenancePolicyForPhase(phase handoff.Phase) (maintenancePhasePolicy, error) {
	switch phase {
	case handoff.PhaseSnapshotReady:
		return maintenancePhasePolicy{receiveSource: true}, nil
	case handoff.PhaseSourceFenced, handoff.PhaseTargetStaged, handoff.PhaseDataRelocated,
		handoff.PhaseTargetStarted, handoff.PhaseTargetVerified,
		handoff.PhaseTargetStopped, handoff.PhaseDataRestored:
		return maintenancePhasePolicy{}, nil
	case handoff.PhaseSourceRetired, handoff.PhaseTargetCommitPlanned, handoff.PhaseRollbackPlanned:
		return maintenancePhasePolicy{allowTargetOwner: true}, nil
	case handoff.PhaseSourceStarted:
		return maintenancePhasePolicy{allowSourceOwner: true}, nil
	default:
		return maintenancePhasePolicy{}, fmt.Errorf("helper cannot establish maintenance listener custody in handoff phase %q", phase)
	}
}

func helperListenerState(listeners []handofffd.NamedListener) handoffowner.ListenerState {
	return handoffowner.ListenerState{
		Owner: handoffowner.ListenerOwnerHelper, Listeners: append([]handofffd.NamedListener(nil), listeners...),
	}
}

func (driver *HelperDriver) CommitToTarget(ctx context.Context, journal handoff.Journal, lease handoff.StartupLease, supplied []handofffd.NamedListener) error {
	return driver.transfer(ctx, journal, lease, supplied, ParticipantTarget)
}

func (driver *HelperDriver) RestoreToSource(ctx context.Context, journal handoff.Journal, lease handoff.StartupLease, supplied []handofffd.NamedListener) error {
	return driver.transfer(ctx, journal, lease, supplied, ParticipantSource)
}

// OwnsPublicListeners proves helper ownership from the current complete FD set
// while revalidating the helper's journal authority. It never infers ownership
// from public reachability or a process name.
func (driver *HelperDriver) OwnsPublicListeners(ctx context.Context, journal handoff.Journal, lease handoff.StartupLease) (bool, error) {
	driver.mu.Lock()
	defer driver.mu.Unlock()
	expected, err := driver.prepare(ctx, journal, lease)
	if err != nil {
		return false, err
	}
	owned := driver.liveHeld(expected)
	if err := driver.verifyLease(ctx, journal, lease); err != nil {
		return false, fmt.Errorf("helper lease changed while proving held listeners: %w", err)
	}
	return owned, nil
}

func (driver *HelperDriver) transfer(ctx context.Context, journal handoff.Journal, lease handoff.StartupLease, supplied []handofffd.NamedListener, role ParticipantRole) error {
	driver.mu.Lock()
	defer driver.mu.Unlock()
	expected, err := driver.prepare(ctx, journal, lease)
	if err != nil {
		return err
	}
	wantedOwner := OwnerTarget
	basename := handofffd.HelperToTargetSocketBasename
	allowedPhase := func(phase handoff.Phase) bool {
		return phase == handoff.PhaseSourceRetired || phase == handoff.PhaseTargetCommitPlanned
	}
	if role == ParticipantSource {
		wantedOwner = OwnerSource
		basename = handofffd.HelperToSourceSocketBasename
		allowedPhase = sourceListenerReceivePhase
	}
	if !allowedPhase(journal.Phase) {
		return fmt.Errorf("helper cannot transfer public listeners to %s in handoff phase %q", role, journal.Phase)
	}

	listeners, err := driver.usableListeners(ctx, journal, lease, expected, supplied)
	if err != nil {
		return err
	}
	if len(listeners) == 0 {
		owner, probeErr := driver.probeOwner(ctx, journal, lease, expected)
		if probeErr != nil {
			return fmt.Errorf("probe public listener owner during %s replay: %w", role, probeErr)
		}
		if owner == wantedOwner {
			if err := driver.verifyLease(ctx, journal, lease); err != nil {
				return fmt.Errorf("revalidate helper lease after proving %s listener ownership: %w", role, err)
			}
			return nil
		}
		if owner != OwnerNone {
			return fmt.Errorf("cannot replay listener transfer to %s while public owner is %q", role, owner)
		}
		listeners, err = driver.recoverLocked(ctx, journal, lease, expected)
		if err != nil {
			return err
		}
	}
	if err := driver.stopMaintenanceWithLeaseLocked(ctx, journal, lease); err != nil {
		return fmt.Errorf("stop helper maintenance accepts before %s transfer: %w", role, err)
	}
	path, err := socketPath(driver.directory, driver.transactionID, basename)
	if err != nil {
		return errors.Join(err, driver.restartMaintenanceWithLeaseLocked(ctx, journal, lease, listeners, expected))
	}
	if err := driver.verifyLease(ctx, journal, lease); err != nil {
		return errors.Join(
			fmt.Errorf("revalidate helper lease before %s listener transfer: %w", role, err),
			driver.restartMaintenanceWithLeaseLocked(ctx, journal, lease, listeners, expected),
		)
	}
	sendErr := handofffd.SendAt(ctx, driver.directory, filepath.Base(path), journal.TransactionID, listeners)
	leaseErr := driver.verifyLease(ctx, journal, lease)
	if sendErr != nil {
		if leaseErr != nil {
			return errors.Join(
				fmt.Errorf("transfer public listeners to %s: %w", role, sendErr),
				fmt.Errorf("helper lease changed across %s listener transfer: %w", role, leaseErr),
			)
		}
		owner, probeErr := driver.probeOwner(ctx, journal, lease, expected)
		if probeErr == nil && owner == wantedOwner {
			if err := driver.verifyLease(ctx, journal, lease); err != nil {
				return fmt.Errorf("revalidate helper lease before releasing reconciled %s listeners: %w", role, err)
			}
			closeErr := closeListeners(listeners)
			driver.held = nil
			postCloseErr := driver.verifyLease(ctx, journal, lease)
			if closeErr != nil || postCloseErr != nil {
				return errors.Join(
					wrapError(fmt.Sprintf("close helper listeners after reconciled %s ownership", role), closeErr),
					wrapError(fmt.Sprintf("helper lease changed after releasing reconciled %s listeners", role), postCloseErr),
				)
			}
			return nil
		}
		restartErr := driver.restartMaintenanceWithLeaseLocked(ctx, journal, lease, listeners, expected)
		return errors.Join(
			fmt.Errorf("transfer public listeners to %s: %w", role, sendErr),
			probeErr,
			restartErr,
		)
	}
	if leaseErr != nil {
		return fmt.Errorf("helper lease changed across acknowledged %s listener transfer: %w", role, leaseErr)
	}
	// An exact acknowledgement proves that the participant owns duplicate
	// descriptors. Only now may the helper release every original descriptor.
	if err := driver.verifyLease(ctx, journal, lease); err != nil {
		return fmt.Errorf("revalidate helper lease before releasing acknowledged %s listeners: %w", role, err)
	}
	closeErr := closeListeners(listeners)
	driver.held = nil
	postCloseErr := driver.verifyLease(ctx, journal, lease)
	if closeErr != nil || postCloseErr != nil {
		return errors.Join(
			wrapError(fmt.Sprintf("close helper listeners after %s acknowledgement", role), closeErr),
			wrapError(fmt.Sprintf("helper lease changed after releasing acknowledged %s listeners", role), postCloseErr),
		)
	}
	return nil
}

func (driver *HelperDriver) recoverLocked(ctx context.Context, journal handoff.Journal, lease handoff.StartupLease, expected []handofffd.ListenerIdentity) ([]handofffd.NamedListener, error) {
	if err := driver.verifyLease(ctx, journal, lease); err != nil {
		return nil, fmt.Errorf("verify helper lease before listener recovery: %w", err)
	}
	lock, err := acquireDurableBindLock(driver.directory)
	leaseErr := driver.verifyLease(ctx, journal, lease)
	if err != nil || leaseErr != nil {
		if lock != nil {
			_ = lock.Close()
		}
		return nil, errors.Join(
			wrapError("acquire durable listener bind lock", err),
			wrapError("helper lease changed while acquiring the listener bind lock", leaseErr),
		)
	}
	defer lock.Close()
	owner, err := driver.probeOwner(ctx, journal, lease, expected)
	if err != nil {
		return nil, fmt.Errorf("re-probe public listener owner under bind lock: %w", err)
	}
	if owner != OwnerNone {
		return nil, fmt.Errorf("public listeners cannot be rebound while owner is %q", owner)
	}
	if err := driver.verifyLease(ctx, journal, lease); err != nil {
		return nil, fmt.Errorf("revalidate helper lease before public listener rebind: %w", err)
	}
	listeners, err := driver.rebinder.Rebind(ctx, expected)
	leaseErr = driver.verifyLease(ctx, journal, lease)
	if err != nil || leaseErr != nil {
		_ = closeListeners(listeners)
		return nil, errors.Join(
			wrapError("rebind public listeners", err),
			wrapError("helper lease changed after listener rebind", leaseErr),
		)
	}
	keep := false
	defer func() {
		if !keep {
			_ = closeListeners(listeners)
		}
	}()
	if err := describeExact(listeners, expected); err != nil {
		return nil, errors.New("rebound public listeners do not match the helper binding")
	}
	if err := driver.startMaintenanceWithLeaseLocked(ctx, journal, lease, listeners, expected); err != nil {
		return nil, fmt.Errorf("start rebound helper maintenance service: %w", err)
	}
	keep = true
	return listeners, nil
}

func (driver *HelperDriver) prepare(ctx context.Context, journal handoff.Journal, lease handoff.StartupLease) ([]handofffd.ListenerIdentity, error) {
	if driver == nil || driver.closed {
		return nil, errors.New("listener helper is closed")
	}
	if journal.TransactionID != driver.transactionID {
		return nil, errors.New("listener helper journal belongs to another transaction")
	}
	if err := handoff.Validate(journal); err != nil {
		return nil, fmt.Errorf("validate listener handoff journal: %w", err)
	}
	if err := driver.verifyLease(ctx, journal, lease); err != nil {
		return nil, fmt.Errorf("verify helper lease: %w", err)
	}
	expected, err := driver.expected.ExpectedListeners(ctx, journal)
	if err != nil {
		return nil, fmt.Errorf("resolve journal-bound public listeners: %w", err)
	}
	expected, err = handofffd.ValidateIdentities(expected)
	if err != nil {
		return nil, err
	}
	if err := driver.verifyLease(ctx, journal, lease); err != nil {
		return nil, fmt.Errorf("helper lease changed while resolving public listeners: %w", err)
	}
	return expected, nil
}

func (driver *HelperDriver) verifyLease(ctx context.Context, journal handoff.Journal, lease handoff.StartupLease) error {
	locked, err := lease.Load()
	if err != nil {
		return err
	}
	if locked.TransactionID != driver.transactionID || locked.TransactionID != journal.TransactionID ||
		locked.Revision != journal.Revision || locked.BindingSHA256 != journal.BindingSHA256 ||
		!reflect.DeepEqual(locked, journal) {
		return errors.New("helper lease journal differs from the listener operation")
	}
	if driver.authority != nil {
		if err := driver.authority.VerifyHelperOwner(ctx, locked); err != nil {
			return err
		}
	}
	return nil
}

func (driver *HelperDriver) probeOwner(ctx context.Context, journal handoff.Journal, lease handoff.StartupLease, expected []handofffd.ListenerIdentity) (PublicOwner, error) {
	if err := driver.verifyLease(ctx, journal, lease); err != nil {
		return OwnerUnknown, fmt.Errorf("verify helper lease before public owner probe: %w", err)
	}
	owner, probeErr := driver.probe.PublicOwner(ctx, journal, expected)
	leaseErr := driver.verifyLease(ctx, journal, lease)
	if probeErr != nil || leaseErr != nil {
		return OwnerUnknown, errors.Join(probeErr, wrapError("helper lease changed across public owner probe", leaseErr))
	}
	return owner, nil
}

func (driver *HelperDriver) liveHeld(expected []handofffd.ListenerIdentity) bool {
	if len(driver.held) == 0 {
		return false
	}
	if err := describeExact(driver.held, expected); err != nil {
		_ = driver.stopMaintenanceLocked()
		_ = closeListeners(driver.held)
		driver.held = nil
		return false
	}
	return driver.maintenance != nil
}

func (driver *HelperDriver) usableListeners(ctx context.Context, journal handoff.Journal, lease handoff.StartupLease, expected []handofffd.ListenerIdentity, supplied []handofffd.NamedListener) ([]handofffd.NamedListener, error) {
	if driver.liveHeld(expected) {
		if err := driver.verifyLease(ctx, journal, lease); err != nil {
			return nil, fmt.Errorf("helper lease changed while inspecting retained listeners: %w", err)
		}
		return driver.held, nil
	}
	if len(supplied) > 0 && describeExact(supplied, expected) == nil {
		if err := driver.startMaintenanceWithLeaseLocked(ctx, journal, lease, supplied, expected); err != nil {
			return nil, fmt.Errorf("start helper maintenance service for retained listeners: %w", err)
		}
		return supplied, nil
	}
	return nil, nil
}

func (driver *HelperDriver) holdWithMaintenanceLocked(listeners []handofffd.NamedListener, expected []handofffd.ListenerIdentity) error {
	if driver.maintenance != nil {
		return errors.New("helper maintenance service is already active")
	}
	maintenance, err := startMaintenance(listeners, expected)
	if err != nil {
		return err
	}
	driver.held = listeners
	driver.maintenance = maintenance
	return nil
}

func (driver *HelperDriver) startMaintenanceWithLeaseLocked(ctx context.Context, journal handoff.Journal, lease handoff.StartupLease, listeners []handofffd.NamedListener, expected []handofffd.ListenerIdentity) error {
	if err := driver.verifyLease(ctx, journal, lease); err != nil {
		return fmt.Errorf("revalidate helper lease before starting maintenance listeners: %w", err)
	}
	startErr := driver.holdWithMaintenanceLocked(listeners, expected)
	leaseErr := driver.verifyLease(ctx, journal, lease)
	if leaseErr != nil && driver.maintenance != nil {
		_ = driver.stopMaintenanceLocked()
		driver.held = nil
	}
	return errors.Join(
		wrapError("start maintenance listeners", startErr),
		wrapError("helper lease changed after starting maintenance listeners", leaseErr),
	)
}

func (driver *HelperDriver) stopMaintenanceLocked() error {
	if driver.maintenance == nil {
		return nil
	}
	err := driver.maintenance.Close()
	driver.maintenance = nil
	return err
}

func (driver *HelperDriver) stopMaintenanceWithLeaseLocked(ctx context.Context, journal handoff.Journal, lease handoff.StartupLease) error {
	if err := driver.verifyLease(ctx, journal, lease); err != nil {
		return fmt.Errorf("revalidate helper lease before stopping maintenance listeners: %w", err)
	}
	stopErr := driver.stopMaintenanceLocked()
	leaseErr := driver.verifyLease(ctx, journal, lease)
	return errors.Join(
		wrapError("stop maintenance listeners", stopErr),
		wrapError("helper lease changed after stopping maintenance listeners", leaseErr),
	)
}

func (driver *HelperDriver) restartMaintenanceLocked(listeners []handofffd.NamedListener, expected []handofffd.ListenerIdentity) error {
	if driver.maintenance != nil {
		return nil
	}
	maintenance, err := startMaintenance(listeners, expected)
	if err != nil {
		return fmt.Errorf("restore helper maintenance service: %w", err)
	}
	driver.held = listeners
	driver.maintenance = maintenance
	return nil
}

func (driver *HelperDriver) restartMaintenanceWithLeaseLocked(ctx context.Context, journal handoff.Journal, lease handoff.StartupLease, listeners []handofffd.NamedListener, expected []handofffd.ListenerIdentity) error {
	if err := driver.verifyLease(ctx, journal, lease); err != nil {
		return fmt.Errorf("revalidate helper lease before restoring maintenance listeners: %w", err)
	}
	restartErr := driver.restartMaintenanceLocked(listeners, expected)
	leaseErr := driver.verifyLease(ctx, journal, lease)
	if leaseErr != nil {
		_ = driver.stopMaintenanceLocked()
	}
	return errors.Join(
		wrapError("restore helper maintenance service", restartErr),
		wrapError("helper lease changed after restoring maintenance listeners", leaseErr),
	)
}

func wrapError(message string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s: %w", message, err)
}

func (driver *HelperDriver) Close() error {
	if driver == nil {
		return nil
	}
	driver.mu.Lock()
	defer driver.mu.Unlock()
	if driver.closed {
		return nil
	}
	driver.closed = true
	var result error
	if driver.sourceReceiver != nil {
		result = errors.Join(result, driver.sourceReceiver.Close())
		driver.sourceReceiver = nil
	}
	result = errors.Join(result, driver.stopMaintenanceLocked())
	result = errors.Join(result, closeListeners(driver.held))
	driver.held = nil
	return result
}
