//go:build linux

// Package handoffevidence owns the production, read-only evidence boundary
// used by the source side of the one-time technical namespace handoff.
package handoffevidence

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"runtime"
	"sync"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffowner"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffsource"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/journal"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/runtimegate"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/sandbox"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/selfupdate"
)

var admissionSHA256 = regexp.MustCompile(`^[0-9a-f]{64}$`)

// MaintenanceGate is the context-bounded subset of maintenance.Admission.
// A plain sync.Locker is deliberately insufficient: spawning a goroutine to
// make Lock context-aware can acquire the lock after the caller has returned.
type MaintenanceGate interface {
	TryLock() bool
	Unlock()
}

type SandboxObserver interface {
	Records() []sandbox.Record
}

type AdmissionOptions struct {
	Profile       identity.ActiveProfile
	Runtime       *runtimegate.Gate
	Maintenance   MaintenanceGate
	Journal       *journal.Store
	SelfUpdate    *selfupdate.Manager
	Units         handoffsource.UnitInspector
	Sandboxes     SandboxObserver
	Background    func() int
	ChannelProbe  func(context.Context) (time.Time, error)
	ManagerSHA256 string
	Architecture  string
	PollInterval  time.Duration
}

// ProductionAdmission freezes new executor requests before taking the short
// lifecycle-publication lock. This is the only supported order beneath the
// already-held handoff-global lock: runtime -> maintenance -> self-update.
type ProductionAdmission struct {
	profile       identity.Profile
	runtime       *runtimegate.Gate
	maintenance   MaintenanceGate
	journal       *journal.Store
	selfUpdate    *selfupdate.Manager
	units         handoffsource.UnitInspector
	sandboxes     SandboxObserver
	background    func() int
	channelProbe  func(context.Context) (time.Time, error)
	managerSHA256 string
	architecture  string
	pollInterval  time.Duration
}

var _ handoffsource.Admission = (*ProductionAdmission)(nil)

func NewAdmission(options AdmissionOptions) (*ProductionAdmission, error) {
	profile, err := options.Profile.Profile()
	if err != nil {
		return nil, fmt.Errorf("handoff evidence technical profile: %w", err)
	}
	if options.Runtime == nil || options.Maintenance == nil || options.Journal == nil ||
		options.SelfUpdate == nil || options.Units == nil || options.Sandboxes == nil ||
		options.Background == nil || options.ChannelProbe == nil {
		return nil, errors.New("handoff evidence admission dependencies are incomplete")
	}
	if !admissionSHA256.MatchString(options.ManagerSHA256) {
		return nil, errors.New("handoff evidence running Manager digest is invalid")
	}
	architecture := options.Architecture
	if architecture == "" {
		architecture = runtime.GOARCH
	}
	if architecture != "amd64" && architecture != "arm64" {
		return nil, fmt.Errorf("handoff evidence does not support architecture %q", architecture)
	}
	poll := options.PollInterval
	if poll == 0 {
		poll = 10 * time.Millisecond
	}
	if poll < time.Millisecond || poll > time.Second {
		return nil, errors.New("handoff evidence admission poll interval is invalid")
	}
	return &ProductionAdmission{
		profile: profile, runtime: options.Runtime, maintenance: options.Maintenance,
		journal: options.Journal, selfUpdate: options.SelfUpdate, units: options.Units,
		sandboxes: options.Sandboxes, background: options.Background,
		channelProbe: options.ChannelProbe, managerSHA256: options.ManagerSHA256,
		architecture: architecture, pollInterval: poll,
	}, nil
}

func (admission *ProductionAdmission) Acquire(ctx context.Context) (handoffowner.RuntimeObservationLease, error) {
	if admission == nil {
		return nil, errors.New("handoff evidence admission is unavailable")
	}
	unfreeze, err := admission.runtime.Freeze(ctx)
	if err != nil {
		return nil, fmt.Errorf("freeze runtime execution admission: %w", err)
	}
	maintenanceHeld := false
	defer func() {
		if !maintenanceHeld {
			unfreeze()
		}
	}()
	ticker := time.NewTicker(admission.pollInterval)
	defer ticker.Stop()
	for !admission.maintenance.TryLock() {
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("acquire maintenance admission: %w", ctx.Err())
		case <-ticker.C:
		}
	}
	maintenanceHeld = true

	selfLease, err := admission.selfUpdate.OpenObservation()
	if err != nil {
		admission.maintenance.Unlock()
		maintenanceHeld = false
		return nil, fmt.Errorf("acquire self-update observation: %w", err)
	}
	return &runtimeObservationLease{
		owner: admission, selfUpdate: selfLease, unfreeze: unfreeze,
	}, nil
}

type runtimeObservationLease struct {
	owner      *ProductionAdmission
	selfUpdate *selfupdate.ObservationLease
	unfreeze   func()
	mu         sync.Mutex
	closed     bool
	closeErr   error
}

func (lease *runtimeObservationLease) Observe(ctx context.Context) (handoffowner.RuntimeObservation, error) {
	if lease == nil || lease.owner == nil || lease.selfUpdate == nil {
		return handoffowner.RuntimeObservation{}, errors.New("runtime observation lease is unavailable")
	}
	lease.mu.Lock()
	defer lease.mu.Unlock()
	if lease.closed {
		return handoffowner.RuntimeObservation{}, errors.New("runtime observation lease is closed")
	}
	if err := ctx.Err(); err != nil {
		return handoffowner.RuntimeObservation{}, err
	}
	owner := lease.owner
	if !owner.runtime.Frozen() || owner.runtime.Active() != 0 {
		return handoffowner.RuntimeObservation{}, errors.New("runtime execution boundary is not frozen and idle")
	}
	boundary, err := owner.journal.ObserveOperationBoundary()
	if err != nil {
		return handoffowner.RuntimeObservation{}, err
	}
	state := boundary.State
	if state.Current == nil || state.Current.ID == "" || state.Current.ID != state.Current.SourceCommit {
		return handoffowner.RuntimeObservation{}, errors.New("Manager journal Current has no exact generation identity")
	}
	selfState := lease.selfUpdate.State()
	if selfState.Current == nil || selfState.Current.SourceCommit != state.Current.SourceCommit ||
		selfState.Current.SHA256 != owner.managerSHA256 || !selfState.Current.PlatformCommitted {
		return handoffowner.RuntimeObservation{}, errors.New("self-update Current differs from the running committed generation")
	}
	watchdogs, err := owner.units.ActiveUnits(ctx, []string{
		owner.profile.WatchdogUnitPrefix, owner.profile.RecoveryWatchdogUnitPrefix,
	})
	if err != nil {
		return handoffowner.RuntimeObservation{}, fmt.Errorf("inspect Manager watchdogs: %w", err)
	}
	activeCalls, sandboxBackground, err := sandboxActivity(owner.sandboxes.Records())
	if err != nil {
		return handoffowner.RuntimeObservation{}, err
	}
	processBackground := owner.background()
	if processBackground < 0 {
		return handoffowner.RuntimeObservation{}, errors.New("background process observation is negative")
	}
	background := processBackground
	if sandboxBackground > background {
		background = sandboxBackground
	}
	activeExecutions := activeCalls + background
	if activeExecutions < activeCalls {
		return handoffowner.RuntimeObservation{}, errors.New("runtime execution count overflow")
	}
	channelCheck, err := owner.channelProbe(ctx)
	if err != nil {
		return handoffowner.RuntimeObservation{}, fmt.Errorf("authenticated Platform channel observation: %w", err)
	}
	if channelCheck.IsZero() || channelCheck.After(time.Now().UTC().Add(time.Minute)) {
		return handoffowner.RuntimeObservation{}, errors.New("authenticated Platform channel timestamp is invalid")
	}
	idle := state.PublicState == model.StateIdle && state.Phase == "" && !state.Maintenance &&
		state.ActiveOperationID == "" && state.FinalizePendingOperationID == "" && state.Candidate == nil &&
		boundary.AllTerminal && selfState.Candidate == nil && selfState.Activation == nil &&
		len(watchdogs) == 0 && activeExecutions == 0
	return handoffowner.RuntimeObservation{
		Profile: owner.profile, Generation: state.Current.SourceCommit,
		ManagerSHA256: owner.managerSHA256, Architecture: owner.architecture,
		Idle: idle, Maintenance: state.Maintenance,
		ActiveOperationID: state.ActiveOperationID, FinalizePendingOperationID: state.FinalizePendingOperationID,
		CandidatePresent:  state.Candidate != nil || selfState.Candidate != nil,
		ActivationPresent: selfState.Activation != nil, WatchdogCount: len(watchdogs),
		ActiveExecutionCount: activeExecutions, AuthenticatedChannelCheck: channelCheck.UTC(),
	}, nil
}

func sandboxActivity(records []sandbox.Record) (int, int, error) {
	active, background := 0, 0
	seen := make(map[string]struct{}, len(records))
	for _, record := range records {
		if record.SandboxID == "" || record.ActiveCalls < 0 || record.BackgroundProcesses < 0 {
			return 0, 0, errors.New("Sandbox registry contains invalid activity evidence")
		}
		if _, duplicate := seen[record.SandboxID]; duplicate {
			return 0, 0, fmt.Errorf("Sandbox registry contains duplicate identity %q", record.SandboxID)
		}
		seen[record.SandboxID] = struct{}{}
		active += record.ActiveCalls
		background += record.BackgroundProcesses
		if active < 0 || background < 0 {
			return 0, 0, errors.New("Sandbox activity count overflow")
		}
	}
	return active, background, nil
}

func (lease *runtimeObservationLease) Close() error {
	if lease == nil {
		return nil
	}
	lease.mu.Lock()
	defer lease.mu.Unlock()
	if lease.closed {
		return lease.closeErr
	}
	lease.closed = true
	verifyErr := lease.selfUpdate.VerifyUnchanged()
	closeErr := lease.selfUpdate.Close()
	lease.owner.maintenance.Unlock()
	if lease.unfreeze != nil {
		lease.unfreeze()
	}
	lease.closeErr = errors.Join(verifyErr, closeErr)
	return lease.closeErr
}
