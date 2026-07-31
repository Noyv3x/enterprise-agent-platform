package selfupdate

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

const startupRecoveryArtifactLimit = 256

type startupRecoveryReference struct {
	path        string
	lockPath    string
	lockPresent bool
	journal     recoveryTakeoverJournal
}

type startupRecoveryEnumeration struct {
	references []startupRecoveryReference
	signature  string
}

type startupRecoverySnapshot struct {
	journal recoveryTakeoverJournal
	plan    Plan
	state   State

	journalSHA     string
	planSHA        string
	supersededSHA  string
	stateSHA       string
	stableSHA      string
	platformSHA    string
	operationSHA   string
	manifestSHA    string
	recoverySHA    string
	currentSHA     string
	candidateSHA   string
	runningSHA     string
	runningVersion string
}

type startupHealthyRecoverySnapshot struct {
	state       State
	stateSHA    string
	stableSHA   string
	runningSHA  string
	currentSHA  string
	recoverySHA string
	metadataSHA string
}

// StartupOwnershipLease records the admitted startup mode and retains any free
// global recovery flock across Manager construction and activation settlement.
type StartupOwnershipLease struct {
	root    string
	mode    startupOwnershipMode
	release func()
}

type startupOwnershipMode uint8

const (
	startupOwnershipNormal startupOwnershipMode = iota
	startupOwnershipExternalRecoveryProbe
	startupOwnershipRecoveryCandidate
)

// ExternalRecoveryProbe reports that recover-current still owns the global
// recovery lock. This process may expose only its authenticated identity until
// the external owner commits it as Current or releases the lock without doing
// so.
func (l *StartupOwnershipLease) ExternalRecoveryProbe() bool {
	return l != nil && l.mode == startupOwnershipExternalRecoveryProbe
}

// RecoveryCandidate reports that an external takeover still holds the global
// lock but has already transferred the exact pending activation to this
// watchdog-owned process. It must run the normal acknowledgement protocol.
func (l *StartupOwnershipLease) RecoveryCandidate() bool {
	return l != nil && l.mode == startupOwnershipRecoveryCandidate
}

// RetainsRecoveryLock reports whether this admission holds the global recovery
// lock on behalf of the serve startup path.
func (l *StartupOwnershipLease) RetainsRecoveryLock() bool {
	return l != nil && l.release != nil
}

func (l *StartupOwnershipLease) Release() {
	if l == nil || l.release == nil {
		return
	}
	release := l.release
	l.release = nil
	release()
}

// ValidateStartupOwnership is the first serve-time self-update gate. It is
// deliberately read-only with respect to Manager state, activation plans and
// the stable executable. A persisted takeover journal is an ownership marker
// even in the reboot window before recover-current has disabled the main unit.
func (m *Manager) ValidateStartupOwnership() error {
	lease, err := m.AcquireStartupOwnership()
	if lease != nil {
		lease.Release()
	}
	return err
}

// AcquireStartupOwnership performs the same validation while returning any
// newly acquired global recovery lock to the caller. The caller must retain it
// until the control listener is live and a pending activation is settled.
func (m *Manager) AcquireStartupOwnership() (*StartupOwnershipLease, error) {
	if err := m.validateStartupOwnershipRoot(); err != nil {
		return nil, err
	}
	if _, err := os.Lstat(m.Root); os.IsNotExist(err) {
		return &StartupOwnershipLease{root: m.Root, mode: startupOwnershipNormal}, nil
	}
	releaseGlobal, err := acquireRecoveryLock(m.Root)
	globalBusy := startupRecoveryLockBusy(err)
	if err != nil && !globalBusy {
		return nil, fmt.Errorf("coordinate Manager startup with external recovery: %w", err)
	}
	if globalBusy {
		mode, err := m.validateStartupOwnershipState(true)
		if err != nil {
			return nil, err
		}
		return &StartupOwnershipLease{root: m.Root, mode: mode}, nil
	}
	lease := &StartupOwnershipLease{root: m.Root, mode: startupOwnershipNormal, release: releaseGlobal}
	if err := m.cleanupStartupAtomicResidues(); err != nil {
		lease.Release()
		return nil, fmt.Errorf("clean Manager startup atomic residues under recovery lease: %w", err)
	}
	if _, err := m.validateStartupOwnershipState(false); err != nil {
		lease.Release()
		return nil, err
	}
	return lease, nil
}

// AwaitExternalRecoveryOwnership keeps a probe-only startup fenced while the
// recover-current process owns the global lock. Once that owner releases the
// lock, the exact running inode must already be a valid normal startup
// checkpoint. A successful return retains the newly acquired lock.
func (m *Manager) AwaitExternalRecoveryOwnership(ctx context.Context, interval time.Duration) (*StartupOwnershipLease, error) {
	if interval <= 0 {
		interval = 50 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		lease, err := m.AcquireStartupOwnership()
		if err != nil {
			// The admitted external owner is allowed to atomically move its
			// state marker while the probe endpoint is live. An intermediate
			// double-snapshot mismatch cannot grant more authority; keep serving
			// identity only while the global lock is still demonstrably held and
			// require one final exact free-lock validation before promotion.
			release, lockErr := acquireRecoveryLock(m.Root)
			if lockErr == nil {
				lease := &StartupOwnershipLease{root: m.Root, mode: startupOwnershipNormal, release: release}
				if _, finalErr := m.validateStartupOwnershipState(false); finalErr != nil {
					lease.Release()
					return nil, errors.Join(err, finalErr)
				}
				return lease, nil
			}
			if !startupRecoveryLockBusy(lockErr) {
				return nil, errors.Join(err, fmt.Errorf("recheck external Manager recovery lock: %w", lockErr))
			}
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-ticker.C:
			}
			continue
		}
		if !lease.ExternalRecoveryProbe() {
			return lease, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ticker.C:
		}
	}
}

// ValidateStartupOwnershipWithLease revalidates all durable ownership while a
// serve caller retains the lease returned before construction.
func (m *Manager) ValidateStartupOwnershipWithLease(lease *StartupOwnershipLease) error {
	if lease == nil || lease.release == nil || lease.root != m.Root {
		return errors.New("Manager startup ownership lease is invalid")
	}
	if err := m.validateStartupOwnershipRoot(); err != nil {
		return err
	}
	_, err := m.validateStartupOwnershipState(false)
	return err
}

func (m *Manager) validateStartupOwnershipRoot() error {
	if m.Root == "" || !filepath.IsAbs(m.Root) || filepath.Clean(m.Root) != m.Root {
		return errors.New("Manager binary root path is invalid during startup ownership validation")
	}
	if _, err := os.Lstat(m.Root); err != nil {
		if os.IsNotExist(err) {
			// A fresh installation has no self-update owner and recover-current
			// cannot acquire its global lock until this root exists.
			if _, stateErr := os.Lstat(m.StatePath); os.IsNotExist(stateErr) {
				return nil
			} else if stateErr != nil {
				return fmt.Errorf("inspect Manager self-update state without binary root: %w", stateErr)
			}
			return errors.New("Manager self-update state exists without its binary root")
		}
		return fmt.Errorf("inspect Manager binary root during startup ownership validation: %w", err)
	}
	if err := validateRecoveryDirectory(m.Root, true); err != nil {
		return fmt.Errorf("validate Manager binary root during startup ownership validation: %w", err)
	}
	return nil
}

func (m *Manager) validateStartupOwnershipState(globalBusy bool) (startupOwnershipMode, error) {
	enumeration, err := m.enumerateStartupRecoveries()
	if err != nil {
		return startupOwnershipNormal, err
	}
	nonterminal := make([]startupRecoverySnapshot, 0, 1)
	for _, reference := range enumeration.references {
		journal := reference.journal
		if recoveryPhaseBefore(journal.Phase, recoveryTakeoverWatchdogOwned) {
			nonterminal = append(nonterminal, startupRecoverySnapshot{journal: journal})
			continue
		}
		snapshot, err := m.validateStartupRecoveryReference(reference, globalBusy)
		if err != nil {
			return startupOwnershipNormal, err
		}
		if snapshot.journal.Phase != recoveryTakeoverCommitted && snapshot.journal.Phase != recoveryTakeoverRolledBack {
			nonterminal = append(nonterminal, snapshot)
		}
	}
	if len(nonterminal) > 1 {
		return startupOwnershipNormal, errors.New("multiple nonterminal Manager recovery takeover journals prevent startup")
	}

	latestEnumeration, err := m.enumerateStartupRecoveries()
	if err != nil {
		return startupOwnershipNormal, err
	}
	if latestEnumeration.signature != enumeration.signature {
		return startupOwnershipNormal, errors.New("Manager recovery artifacts changed during startup ownership validation")
	}

	if len(nonterminal) == 1 {
		journal := nonterminal[0].journal
		if recoveryPhaseBefore(journal.Phase, recoveryTakeoverWatchdogOwned) {
			return startupOwnershipNormal, fmt.Errorf("Manager recovery transaction %s remains externally owned in phase %s", journal.TransactionID, journal.Phase)
		}
		if globalBusy && recoveryStateHasOriginalBase(nonterminal[0].state, journal) &&
			recoveryCandidateMatches(nonterminal[0].state.Candidate, journal) &&
			recoveryActivationMatches(nonterminal[0].state.Activation, journal) {
			return startupOwnershipRecoveryCandidate, nil
		}
		if globalBusy {
			return startupOwnershipExternalRecoveryProbe, nil
		}
		return startupOwnershipNormal, nil
	}
	if !globalBusy {
		return startupOwnershipNormal, m.validateUnlockedStartupWithoutTakeover()
	}
	if err := m.validateBusyStartupWithoutTakeover(); err != nil {
		return startupOwnershipNormal, fmt.Errorf("external Manager recovery holds the startup lock: %w", err)
	}
	return startupOwnershipExternalRecoveryProbe, nil
}

func startupRecoveryLockBusy(err error) bool {
	return err != nil && (errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN))
}

func (m *Manager) enumerateStartupRecoveries() (startupRecoveryEnumeration, error) {
	var result startupRecoveryEnumeration
	directory := filepath.Join(m.Root, "recoveries")
	info, err := os.Lstat(directory)
	if err != nil {
		if os.IsNotExist(err) {
			return result, nil
		}
		return result, fmt.Errorf("inspect Manager recovery journal directory: %w", err)
	}
	if err := validateRecoveryDirectory(directory, true); err != nil {
		return result, fmt.Errorf("validate Manager recovery journal directory: %w", err)
	}
	fd, err := syscall.Open(directory, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return result, fmt.Errorf("open Manager recovery journal directory: %w", err)
	}
	opened := os.NewFile(uintptr(fd), directory)
	if opened == nil {
		_ = syscall.Close(fd)
		return result, errors.New("open Manager recovery journal directory: invalid file descriptor")
	}
	defer opened.Close()
	openedInfo, err := opened.Stat()
	if err != nil || !os.SameFile(info, openedInfo) {
		if err == nil {
			err = errors.New("directory changed while it was opened")
		}
		return result, fmt.Errorf("revalidate Manager recovery journal directory: %w", err)
	}
	entries, err := opened.ReadDir(-1)
	if err != nil {
		return result, fmt.Errorf("enumerate Manager recovery journal directory: %w", err)
	}
	if len(entries) > startupRecoveryArtifactLimit {
		return result, errors.New("Manager recovery journal directory contains too many artifacts")
	}

	journalNames := make(map[string]struct{})
	lockNames := make(map[string]struct{})
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if name == "" || filepath.Base(name) != name {
			return result, errors.New("Manager recovery journal directory contains an invalid artifact name")
		}
		names = append(names, name)
		switch {
		case validStartupRecoveryJournalName(name):
			journalNames[name] = struct{}{}
		case strings.HasSuffix(name, ".lock") && validStartupRecoveryJournalName(strings.TrimSuffix(name, ".lock")):
			lockNames[name] = struct{}{}
		default:
			return result, fmt.Errorf("unknown Manager recovery artifact %q prevents startup", name)
		}
	}
	for lockName := range lockNames {
		journalName := strings.TrimSuffix(lockName, ".lock")
		if _, ok := journalNames[journalName]; !ok {
			return result, fmt.Errorf("orphan Manager recovery lock %q prevents startup", lockName)
		}
		if err := validateStartupRecoveryLockFile(filepath.Join(directory, lockName)); err != nil {
			return result, err
		}
	}

	sort.Strings(names)
	result.signature = strings.Join(names, "\x00")
	orderedJournals := make([]string, 0, len(journalNames))
	for name := range journalNames {
		orderedJournals = append(orderedJournals, name)
	}
	sort.Strings(orderedJournals)
	for _, name := range orderedJournals {
		path := filepath.Join(directory, name)
		journal, exists, err := m.readRecoveryTakeoverJournal(path)
		if err != nil {
			return result, fmt.Errorf("validate Manager recovery takeover journal %q: %w", name, err)
		}
		if !exists {
			return result, fmt.Errorf("Manager recovery takeover journal %q disappeared during enumeration", name)
		}
		lockPath := path + ".lock"
		_, lockPresent := lockNames[name+".lock"]
		result.references = append(result.references, startupRecoveryReference{
			path: path, lockPath: lockPath, lockPresent: lockPresent, journal: journal,
		})
	}
	return result, nil
}

func validStartupRecoveryJournalName(name string) bool {
	const prefix = "recover-current-"
	const suffix = ".json"
	if !strings.HasPrefix(name, prefix) || !strings.HasSuffix(name, suffix) {
		return false
	}
	identity := strings.TrimSuffix(strings.TrimPrefix(name, prefix), suffix)
	if len(identity) != 25 || identity[12] != '-' {
		return false
	}
	for index, character := range identity {
		if index == 12 {
			continue
		}
		if !(character >= '0' && character <= '9' || character >= 'a' && character <= 'f') {
			return false
		}
	}
	return true
}

func validateStartupRecoveryLockFile(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("inspect Manager recovery journal lock: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() != 0 {
		return errors.New("Manager recovery journal lock is not an empty non-symlink regular file")
	}
	if err := validateRecoveryOwner(path, info); err != nil {
		return err
	}
	if info.Mode().Perm()&0o077 != 0 {
		return errors.New("Manager recovery journal lock is accessible by another host identity")
	}
	return nil
}

func (m *Manager) validateStartupRecoveryReference(reference startupRecoveryReference, globalBusy bool) (startupRecoverySnapshot, error) {
	var empty startupRecoverySnapshot
	if !reference.lockPresent {
		return empty, fmt.Errorf("Manager recovery transaction %s has no durable mutation lock", reference.journal.TransactionID)
	}
	release, busy, err := tryStartupRecoveryJournalLock(reference.lockPath)
	if err != nil {
		return empty, err
	}
	if release != nil {
		defer release()
		return m.readStartupRecoverySnapshot(reference.path, globalBusy)
	}
	if !busy || !globalBusy {
		return empty, errors.New("Manager recovery journal mutation is in progress during startup")
	}

	// recover-current holds the global lock while starting and probing the exact
	// recovery process. Waiting here would deadlock that systemctl transaction.
	// Two identical secure snapshots admit only a checkpoint which stayed fixed
	// throughout the validation window.
	first, err := m.readStartupRecoverySnapshot(reference.path, true)
	if err != nil {
		return empty, err
	}
	second, err := m.readStartupRecoverySnapshot(reference.path, true)
	if err != nil {
		return empty, err
	}
	if !reflect.DeepEqual(first, second) {
		return empty, errors.New("Manager recovery ownership changed while its mutation lock was busy")
	}
	return second, nil
}

func tryStartupRecoveryJournalLock(path string) (func(), bool, error) {
	fd, err := syscall.Open(path, syscall.O_RDWR|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, false, fmt.Errorf("open Manager recovery journal mutation lock: %w", err)
	}
	file := os.NewFile(uintptr(fd), path)
	if file == nil {
		_ = syscall.Close(fd)
		return nil, false, errors.New("open Manager recovery journal mutation lock: invalid file descriptor")
	}
	closeFile := true
	defer func() {
		if closeFile {
			_ = file.Close()
		}
	}()
	info, err := file.Stat()
	if err != nil {
		return nil, false, fmt.Errorf("inspect Manager recovery journal mutation lock: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() != 0 {
		return nil, false, errors.New("Manager recovery journal mutation lock is not an empty regular file")
	}
	if err := validateRecoveryOwner(path, info); err != nil {
		return nil, false, err
	}
	if info.Mode().Perm()&0o077 != 0 {
		return nil, false, errors.New("Manager recovery journal mutation lock is accessible by another host identity")
	}
	if err := syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		if startupRecoveryLockBusy(err) {
			return nil, true, nil
		}
		return nil, false, fmt.Errorf("lock Manager recovery journal during startup: %w", err)
	}
	closeFile = false
	return func() {
		_ = syscall.Flock(fd, syscall.LOCK_UN)
		_ = file.Close()
	}, false, nil
}

func (m *Manager) readStartupRecoverySnapshot(path string, globalBusy bool) (startupRecoverySnapshot, error) {
	var snapshot startupRecoverySnapshot
	journalData, _, err := readRecoveryRegularFile(path, recoveryMaxJSONBytes, true)
	if err != nil {
		return snapshot, fmt.Errorf("read Manager recovery journal during startup: %w", err)
	}
	if err := decodeRecoveryJSON(journalData, &snapshot.journal); err != nil {
		return snapshot, fmt.Errorf("decode Manager recovery journal during startup: %w", err)
	}
	if err := validateRecoveryTakeoverJournal(snapshot.journal, m); err != nil {
		return snapshot, err
	}
	if snapshot.journal.Path != path {
		return snapshot, errors.New("Manager recovery journal does not identify its enumerated path")
	}
	planData, plan, err := readRecoveryActivationPlan(snapshot.journal.RecoveryPlanPath)
	if err != nil {
		return snapshot, err
	}
	snapshot.plan = plan
	if err := validateRecoveryPlanOwnership(plan, snapshot.journal); err != nil {
		return snapshot, err
	}
	supersededData, superseded, err := readRecoveryActivationPlan(snapshot.journal.OriginalPlanPath)
	if err != nil {
		return snapshot, err
	}
	if err := validateStartupSupersededPlan(plan, superseded, snapshot.journal); err != nil {
		return snapshot, err
	}
	snapshot.journalSHA = sha256Hex(journalData)
	snapshot.planSHA = sha256Hex(planData)
	snapshot.supersededSHA = sha256Hex(supersededData)
	stateData, state, err := readRecoverySelfUpdateState(snapshot.journal.ManagerStatePath)
	if err != nil {
		return snapshot, err
	}
	snapshot.state = state
	snapshot.stateSHA = sha256Hex(stateData)

	if snapshot.journal.Phase == recoveryTakeoverCommitted || snapshot.journal.Phase == recoveryTakeoverRolledBack {
		if err := validateStartupTerminalRecovery(snapshot.journal, plan); err != nil {
			return snapshot, err
		}
		if err := m.validateStartupTerminalRecoveryLiveState(&snapshot); err != nil {
			return snapshot, err
		}
		return snapshot, nil
	}
	if recoveryPhaseBefore(snapshot.journal.Phase, recoveryTakeoverWatchdogOwned) {
		return snapshot, fmt.Errorf("Manager recovery transaction remains externally owned in phase %s", snapshot.journal.Phase)
	}

	stable, _, err := readRecoveryRegularFile(snapshot.journal.InstallPath, recoveryMaxBinaryBytes, false)
	if err != nil {
		return snapshot, fmt.Errorf("read stable Manager during startup recovery validation: %w", err)
	}
	snapshot.stableSHA = sha256Hex(stable)
	snapshot.runningSHA, err = startupRunningExecutableSHA()
	if err != nil {
		return snapshot, err
	}
	snapshot.runningVersion = m.RunningVersion

	for _, artifact := range []struct {
		path string
		want string
		set  func(string)
	}{
		{snapshot.journal.RecoveryPath, snapshot.journal.RecoverySHA256, func(value string) { snapshot.recoverySHA = value }},
		{snapshot.journal.OriginalCurrent.Path, snapshot.journal.OriginalCurrent.SHA256, func(value string) { snapshot.currentSHA = value }},
		{snapshot.journal.OriginalCandidate.Path, snapshot.journal.OriginalCandidate.SHA256, func(value string) { snapshot.candidateSHA = value }},
	} {
		data, _, readErr := readRecoveryRegularFile(artifact.path, recoveryMaxBinaryBytes, false)
		if readErr != nil || sha256Hex(data) != artifact.want {
			return snapshot, fmt.Errorf("Manager recovery executable %s no longer matches its journal binding", artifact.path)
		}
		artifact.set(sha256Hex(data))
	}
	for _, evidence := range []struct {
		path string
		want string
		set  func(string)
		max  int64
	}{
		{snapshot.journal.PlatformStatePath, snapshot.journal.PlatformStateSHA256, func(value string) { snapshot.platformSHA = value }, recoveryMaxJSONBytes},
		{snapshot.journal.OperationPath, snapshot.journal.OperationSHA256, func(value string) { snapshot.operationSHA = value }, recoveryMaxJSONBytes},
		{snapshot.journal.ManifestPath, snapshot.journal.ManifestSHA256, func(value string) { snapshot.manifestSHA = value }, 1 << 20},
	} {
		data, _, readErr := readRecoveryRegularFile(evidence.path, evidence.max, true)
		if readErr != nil || sha256Hex(data) != evidence.want {
			return snapshot, fmt.Errorf("Manager recovery evidence %s changed before startup", evidence.path)
		}
		evidence.set(sha256Hex(data))
	}
	if err := validateStartupOwnedRecovery(snapshot, globalBusy); err != nil {
		return snapshot, err
	}
	return snapshot, nil
}

func validateStartupSupersededPlan(recoveryPlan, superseded Plan, journal recoveryTakeoverJournal) error {
	if superseded.Status != recoverySupersededStatus || superseded.Mode != "" ||
		superseded.PlanPath != journal.OriginalPlanPath || superseded.StatePath != journal.ManagerStatePath ||
		superseded.InstallPath != journal.InstallPath || superseded.SocketPath != journal.SocketPath ||
		superseded.ControlTokenFile != journal.ControlTokenFile || superseded.UnitName != journal.UnitName ||
		superseded.CandidateVersion != journal.OriginalCandidate.Version || superseded.CandidateSHA != journal.OriginalCandidate.SHA256 ||
		superseded.CandidatePath != journal.OriginalCandidate.Path || superseded.PlatformCommit != journal.PlatformCommit ||
		superseded.PreviousPath != journal.OriginalCurrent.Path ||
		recoveryPlan.StatePath != superseded.StatePath || recoveryPlan.InstallPath != superseded.InstallPath ||
		recoveryPlan.SocketPath != superseded.SocketPath || recoveryPlan.ControlTokenFile != superseded.ControlTokenFile ||
		recoveryPlan.UnitName != superseded.UnitName {
		return errors.New("Manager recovery plan is not bound to its superseded activation during startup")
	}
	return nil
}

func validateStartupTerminalRecovery(journal recoveryTakeoverJournal, plan Plan) error {
	switch journal.Phase {
	case recoveryTakeoverCommitted:
		if plan.Status != "committed" || !plan.Activated || !plan.Acknowledged {
			return errors.New("committed Manager recovery journal has no committed plan checkpoint")
		}
	case recoveryTakeoverRolledBack:
		if plan.Status != "rolled_back" {
			return errors.New("rolled-back Manager recovery journal has no rolled-back plan checkpoint")
		}
	default:
		return errors.New("nonterminal Manager recovery journal cannot be ignored during startup")
	}
	return nil
}

func (m *Manager) validateStartupTerminalRecoveryLiveState(snapshot *startupRecoverySnapshot) error {
	journal, state := snapshot.journal, snapshot.state
	if state.Activation != nil && (state.Activation.PlanPath == journal.RecoveryPlanPath ||
		state.Activation.CandidateSHA == journal.RecoverySHA256 || state.Activation.CandidatePath == journal.RecoveryPath) {
		return errors.New("terminal Manager recovery journal is still referenced by an Activation intent")
	}
	if state.Candidate != nil && (state.Candidate.SHA256 == journal.RecoverySHA256 || state.Candidate.Path == journal.RecoveryPath) {
		return errors.New("terminal Manager recovery journal is still referenced by Candidate state")
	}

	wantStable := ""
	switch journal.Phase {
	case recoveryTakeoverCommitted:
		if state.Current != nil && state.Current.SHA256 == journal.RecoverySHA256 && state.Current.Path == journal.RecoveryPath &&
			state.Candidate == nil && state.Activation == nil {
			if !recoveryCommittedStateMatches(state, journal) {
				return errors.New("live Manager state only partially matches a committed recovery transaction")
			}
			wantStable = journal.RecoverySHA256
		}
	case recoveryTakeoverRolledBack:
		if recoveryStateHasOriginalBase(state, journal) && state.Candidate == nil && state.Activation == nil {
			wantStable = journal.OriginalCurrent.SHA256
		}
	}
	if wantStable == "" {
		// A later Manager transaction may legitimately replace Current and prune
		// version/manifest/operation artifacts retained by this historical audit
		// journal. Its terminal plan remains the durable transaction evidence.
		return nil
	}
	stable, _, err := readRecoveryRegularFile(journal.InstallPath, recoveryMaxBinaryBytes, false)
	if err != nil {
		return fmt.Errorf("read live stable Manager for terminal recovery validation: %w", err)
	}
	snapshot.stableSHA = sha256Hex(stable)
	if snapshot.stableSHA != wantStable {
		return errors.New("live Manager state and stable executable disagree with terminal recovery journal")
	}
	return nil
}

func validateStartupOwnedRecovery(snapshot startupRecoverySnapshot, globalBusy bool) error {
	journal, plan, state := snapshot.journal, snapshot.plan, snapshot.state
	active := recoveryStateHasOriginalBase(state, journal) && recoveryCandidateMatches(state.Candidate, journal) &&
		recoveryActivationMatches(state.Activation, journal)
	committed := recoveryCommittedStateMatches(state, journal)
	rolledBack := recoveryStateHasOriginalBase(state, journal) && state.Candidate == nil && state.Activation == nil

	switch {
	case active:
		if !validStartupActiveRecoveryPlan(journal.Phase, plan) {
			return errors.New("watchdog-owned Manager recovery phase and plan checkpoint are inconsistent")
		}
		if snapshot.stableSHA != journal.RecoverySHA256 || snapshot.runningSHA != journal.RecoverySHA256 ||
			snapshot.runningVersion != journal.RecoveryVersion {
			return errors.New("running Manager does not match the watchdog-owned recovery Candidate")
		}
	case committed:
		if !globalBusy {
			return errors.New("committed recovery half-checkpoint still requires external recovery convergence")
		}
		if (plan.Status != "acknowledged" && plan.Status != "committed") || !plan.Activated || !plan.Acknowledged ||
			snapshot.stableSHA != journal.RecoverySHA256 || snapshot.runningSHA != journal.RecoverySHA256 ||
			snapshot.runningVersion != journal.RecoveryVersion {
			return errors.New("running Manager does not match the recovery committed half-checkpoint")
		}
	case rolledBack:
		if !globalBusy {
			return errors.New("rolled-back recovery half-checkpoint still requires external recovery convergence")
		}
		if plan.Status == "committed" || snapshot.stableSHA != journal.OriginalCurrent.SHA256 ||
			snapshot.runningSHA != journal.OriginalCurrent.SHA256 || snapshot.runningVersion != journal.OriginalCurrent.Version {
			return errors.New("running Manager does not match the recovery rollback half-checkpoint")
		}
	default:
		return errors.New("Manager state is outside every watchdog-owned recovery checkpoint")
	}
	return nil
}

func validStartupActiveRecoveryPlan(phase string, plan Plan) bool {
	switch phase {
	case recoveryTakeoverWatchdogOwned:
		return plan.Status == "prepared" && !plan.Activated && !plan.Acknowledged
	case recoveryTakeoverStableReplaced:
		return plan.Status == "prepared" || plan.Status == "activated"
	case recoveryTakeoverPlanActivated, recoveryTakeoverMainStarted:
		return plan.Status == "activated" || plan.Status == "acknowledged"
	default:
		return false
	}
}

func startupRunningExecutableSHA() (string, error) {
	// Opening /proc/self/exe hashes the executing inode. os.Executable returns
	// the stable pathname on Linux, which may already name a replacement inode.
	digest, err := fileSHA256("/proc/self/exe")
	if err != nil {
		return "", fmt.Errorf("hash running Manager executable during startup ownership validation: %w", err)
	}
	return digest, nil
}

func (m *Manager) validateUnlockedStartupWithoutTakeover() error {
	if _, err := os.Lstat(m.StatePath); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("inspect Manager self-update state during startup: %w", err)
	}
	_, state, err := readRecoverySelfUpdateState(m.StatePath)
	if err != nil {
		return err
	}
	if state.Current == nil {
		if state.Candidate != nil || state.Activation != nil {
			return errors.New("Manager activation state has no registered Current")
		}
		return nil
	}
	if state.Candidate != nil && state.Activation == nil {
		return m.validateStartupPreparedCandidate(state)
	}
	if state.Candidate == nil && state.Activation != nil {
		return errors.New("journal-free Manager Activation has no Candidate owner")
	}
	if state.Candidate != nil {
		return m.validateStartupOrdinaryActivation(state)
	}
	if err := m.validateStartupSettledActivationPlan(state); err != nil {
		return err
	}
	return m.validateStartupCurrentProcess(*state.Current)
}

func (m *Manager) validateStartupSettledActivationPlan(state State) error {
	if state.Current == nil || !validSourceCommit(state.Current.SourceCommit) {
		return nil
	}
	planPath := filepath.Join(m.Root, "activations", safeID(state.Current.SourceCommit)+".json")
	if _, err := os.Lstat(planPath); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("inspect settled Manager activation plan during startup: %w", err)
	}
	_, plan, err := readRecoveryActivationPlan(planPath)
	if err != nil {
		return err
	}
	switch plan.Status {
	case ordinaryRolledBackStatus, recoverySupersededStatus:
		// These are audit records for a Candidate which did not become this
		// Current. They are interpreted only by their exact owning operation.
		return nil
	case "acknowledged", "committed":
	default:
		return fmt.Errorf("settled Manager Current has nonterminal activation plan status %q", plan.Status)
	}
	unit := m.recoveryUnitName()
	expectedPath := filepath.Join(m.Root, "versions", safeID(state.Current.Version+"-"+state.Current.SourceCommit[:12]), sourceManagerBinaryName())
	if plan.Mode != "" || plan.SchemaVersion != 1 || plan.PlanPath != planPath ||
		plan.StatePath != m.StatePath || plan.InstallPath != m.InstallPath || plan.SocketPath != m.SocketPath ||
		plan.ControlTokenFile != m.ControlTokenFile || plan.UnitName != unit ||
		plan.CandidateVersion != state.Current.Version || plan.CandidateSHA != state.Current.SHA256 ||
		plan.CandidatePath != expectedPath || state.Current.Path != expectedPath ||
		plan.PlatformCommit != state.Current.SourceCommit || state.Previous == nil || plan.PreviousPath != state.Previous.Path ||
		plan.RecoveryTransactionID != "" || plan.RecoveryJournalPath != "" || plan.SupersededPlanPath != "" || plan.SupersededPlanSHA != "" ||
		!plan.Activated || !plan.Acknowledged || plan.CreatedAt.IsZero() || plan.UpdatedAt.IsZero() ||
		plan.UpdatedAt.Before(plan.CreatedAt) || plan.HealthTimeoutMS < 1_000 || plan.HealthTimeoutMS > 10*60*1_000 || plan.BootID == "" {
		return errors.New("settled Manager Current does not exactly match its acknowledged activation plan")
	}
	if !validSHA256(state.Previous.SHA256) || !pathWithin(filepath.Join(m.Root, "versions"), state.Previous.Path) {
		return errors.New("settled Manager activation Previous identity is invalid")
	}
	previous, _, err := readRecoveryRegularFile(state.Previous.Path, recoveryMaxBinaryBytes, false)
	if err != nil || sha256Hex(previous) != state.Previous.SHA256 {
		return errors.New("settled Manager activation Previous artifact is invalid")
	}
	return nil
}

func (m *Manager) validateStartupPreparedCandidate(state State) error {
	if state.Current == nil || state.Candidate == nil || state.Activation != nil {
		return errors.New("prepared Manager Candidate checkpoint is incomplete")
	}
	candidate := *state.Candidate
	if !validSourceCommit(candidate.SourceCommit) || candidate.Version == "" || !validSHA256(candidate.SHA256) ||
		candidate.VerifiedAt.IsZero() || !pathWithin(filepath.Join(m.Root, "versions"), candidate.Path) {
		return errors.New("prepared Manager Candidate identity is invalid")
	}
	if err := m.validateStartupVersionArtifact(candidate, "Candidate"); err != nil {
		return err
	}
	if err := m.validateStartupCurrentProcess(*state.Current); err != nil {
		return err
	}

	planPath := filepath.Join(m.Root, "activations", safeID(candidate.SourceCommit)+".json")
	planExists := false
	var plan Plan
	if _, err := os.Lstat(planPath); err == nil {
		planExists = true
		_, plan, err = readRecoveryActivationPlan(planPath)
		if err != nil {
			return err
		}
		if plan.Status == ordinaryRolledBackStatus || plan.Status == recoverySupersededStatus {
			return fmt.Errorf("prepared Manager Candidate is bound to terminal plan status %q", plan.Status)
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect prepared Manager Candidate plan: %w", err)
	}

	manifest, err := m.validateStartupPreparedCandidatePlatform(candidate)
	if err != nil {
		return err
	}
	artifact := manifest.Manager.Artifacts[runtime.GOARCH]
	if manifest.SourceCommit != candidate.SourceCommit || manifest.Manager.Version != candidate.Version || artifact.SHA256 != candidate.SHA256 {
		return errors.New("prepared Manager Candidate does not match its immutable Platform manifest")
	}

	if !candidate.PlatformCommitted {
		if planExists {
			return errors.New("uncommitted prepared Manager Candidate unexpectedly has an activation plan")
		}
		return nil
	}
	if planExists {
		if plan.Status != "prepared" || plan.Activated || plan.Acknowledged || plan.PlanPath != planPath {
			return errors.New("committed prepared Manager Candidate plan is not an unactivated checkpoint")
		}
		if err := m.validateRecoveryPlanBinding(plan, state, candidate, candidate.SourceCommit, false); err != nil {
			return fmt.Errorf("validate committed prepared Manager Candidate plan: %w", err)
		}
	}
	return nil
}

func (m *Manager) validateStartupPreparedCandidatePlatform(candidate Version) (release.Manifest, error) {
	platformPath := filepath.Join(filepath.Dir(m.StatePath), "state.json")
	platformData, _, err := readRecoveryRegularFile(platformPath, recoveryMaxJSONBytes, true)
	if err != nil {
		return release.Manifest{}, fmt.Errorf("read Platform state for prepared Manager Candidate: %w", err)
	}
	var platform model.ManagerState
	if err := decodeRecoveryJSON(platformData, &platform); err != nil {
		return release.Manifest{}, fmt.Errorf("decode Platform state for prepared Manager Candidate: %w", err)
	}
	if platform.SchemaVersion != 1 {
		return release.Manifest{}, errors.New("prepared Manager Candidate has an unsupported Platform state")
	}

	if candidate.PlatformCommitted {
		evidence, err := readRecoveryFinalizeEvidence(platformPath, candidate.SourceCommit)
		if err != nil {
			return release.Manifest{}, fmt.Errorf("validate committed prepared Manager Candidate: %w", err)
		}
		unfinished, err := readStartupUnfinishedOperations(filepath.Dir(platformPath))
		if err != nil {
			return release.Manifest{}, err
		}
		if len(unfinished) != 1 || unfinished[0].ID != evidence.operation.ID ||
			unfinished[0].Status != model.OperationSucceeded || unfinished[0].Finalized {
			return release.Manifest{}, errors.New("committed prepared Manager Candidate does not have one unique finalize owner")
		}
		return evidence.manifest, nil
	}
	if platform.Candidate == nil || platform.ActiveOperationID == "" || platform.FinalizePendingOperationID != "" ||
		platform.Candidate.ID != candidate.SourceCommit || platform.Candidate.SourceCommit != candidate.SourceCommit {
		return release.Manifest{}, errors.New("uncommitted prepared Manager Candidate has no exact active Platform owner")
	}
	if !validRecoveryOperationID(platform.ActiveOperationID) {
		return release.Manifest{}, errors.New("uncommitted prepared Manager Candidate has an invalid active operation")
	}
	manifestPath := filepath.Join(filepath.Dir(platformPath), "releases", candidate.SourceCommit, "manifest.json")
	if platform.Candidate.ManifestPath != manifestPath {
		return release.Manifest{}, errors.New("prepared Manager Candidate Platform manifest path is not managed")
	}
	manifestData, _, err := readRecoveryRegularFile(manifestPath, 1<<20, true)
	if err != nil {
		return release.Manifest{}, fmt.Errorf("read prepared Manager Candidate manifest: %w", err)
	}
	var manifest release.Manifest
	if err := decodeRecoveryJSON(manifestData, &manifest); err != nil {
		return release.Manifest{}, fmt.Errorf("decode prepared Manager Candidate manifest: %w", err)
	}
	if err := manifest.Validate(manifest.Channel, "linux", runtime.GOARCH); err != nil {
		return release.Manifest{}, fmt.Errorf("validate prepared Manager Candidate manifest: %w", err)
	}
	if manifest.SourceCommit != candidate.SourceCommit || platform.Candidate.DatabaseVersion != manifest.DatabaseSchemaVersion ||
		!reflect.DeepEqual(platform.Candidate.Images, manifest.Images) {
		return release.Manifest{}, errors.New("prepared Manager Candidate Platform generation does not match its manifest")
	}
	if err := validateStartupPreparedCandidateOperation(filepath.Dir(platformPath), platform); err != nil {
		return release.Manifest{}, err
	}
	return manifest, nil
}

func validateStartupPreparedCandidateOperation(stateDir string, platform model.ManagerState) error {
	unfinished, err := readStartupUnfinishedOperations(stateDir)
	if err != nil {
		return err
	}
	if len(unfinished) != 1 || unfinished[0].ID != platform.ActiveOperationID {
		return errors.New("prepared Manager Candidate does not have one unique unfinished Platform operation")
	}
	op := unfinished[0]
	if (op.Kind != model.OperationInstall && op.Kind != model.OperationUpdate) || op.Finalized ||
		(op.Status != model.OperationPending && op.Status != model.OperationRunning) ||
		op.TargetGeneration != platform.Candidate.ID || op.CompletedAt != nil || op.CreatedAt.IsZero() ||
		op.UpdatedAt.Before(op.CreatedAt) || op.Phase != platform.Phase || op.Phase == model.PhaseRollingBack {
		return errors.New("prepared Manager Candidate active operation is not a live install/update owner")
	}
	if op.Status == model.OperationPending && op.Phase != model.PhaseValidating {
		return errors.New("pending prepared Manager Candidate operation is outside validation")
	}
	switch op.Phase {
	case model.PhaseValidating:
		if platform.Maintenance || op.ReservationStatus != "" {
			return errors.New("prepared Manager Candidate validation phase has an invalid reservation boundary")
		}
	case model.PhasePulling:
		if platform.Maintenance || platform.PublicState != model.StateIdle || op.ReservationStatus != "" {
			return errors.New("prepared Manager Candidate pull phase has an invalid reservation boundary")
		}
	case model.PhasePreparing:
		if platform.Maintenance || platform.PublicState != model.StateWaitingForTasks || op.ReservationStatus != "" {
			return errors.New("prepared Manager Candidate preparation phase has an invalid reservation boundary")
		}
	case model.PhaseDraining:
		if !validStartupPreparedDrainingBoundary(op, platform) {
			return errors.New("prepared Manager Candidate draining phase has an invalid reservation boundary")
		}
	case model.PhaseSnapshotting, model.PhaseMigrating, model.PhaseStarting, model.PhaseProbing, model.PhaseCommitting:
		freshInstall := op.Kind == model.OperationInstall && platform.Current == nil
		if !platform.Maintenance || platform.PublicState != model.StateUpdating ||
			(freshInstall && op.ReservationStatus != "") || (!freshInstall && op.ReservationStatus != model.ReservationMutationStarted) {
			return errors.New("prepared Manager Candidate cutover operation lacks its exact mutation owner")
		}
	default:
		return errors.New("prepared Manager Candidate operation phase is invalid")
	}
	return nil
}

func readStartupUnfinishedOperations(stateDir string) ([]model.Operation, error) {
	operationsDir := filepath.Join(stateDir, "operations")
	if err := validateRecoveryDirectory(operationsDir, true); err != nil {
		return nil, fmt.Errorf("validate prepared Manager Candidate operation directory: %w", err)
	}
	entries, err := os.ReadDir(operationsDir)
	if err != nil {
		return nil, fmt.Errorf("enumerate prepared Manager Candidate operations: %w", err)
	}
	if len(entries) > 4096 {
		return nil, errors.New("operation directory is too large to prove prepared Manager Candidate ownership")
	}
	unfinished := make([]model.Operation, 0, 1)
	for _, entry := range entries {
		if entry.Type()&os.ModeSymlink != 0 || entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			return nil, fmt.Errorf("unknown operation journal entry %q while proving prepared Manager Candidate", entry.Name())
		}
		id := strings.TrimSuffix(entry.Name(), ".json")
		if !validRecoveryOperationID(id) {
			return nil, fmt.Errorf("invalid operation journal entry %q while proving prepared Manager Candidate", entry.Name())
		}
		data, _, err := readRecoveryRegularFile(filepath.Join(operationsDir, entry.Name()), recoveryMaxJSONBytes, true)
		if err != nil {
			return nil, fmt.Errorf("read operation %q while proving prepared Manager Candidate: %w", id, err)
		}
		var operation model.Operation
		if err := decodeRecoveryJSON(data, &operation); err != nil {
			return nil, fmt.Errorf("decode operation %q while proving prepared Manager Candidate: %w", id, err)
		}
		if operation.SchemaVersion != 1 || operation.ID != id {
			return nil, fmt.Errorf("operation journal %q has an invalid identity", id)
		}
		switch operation.Status {
		case model.OperationPending, model.OperationRunning:
			unfinished = append(unfinished, operation)
		case model.OperationSucceeded, model.OperationFailed:
			if !operation.Finalized {
				unfinished = append(unfinished, operation)
			}
		default:
			return nil, fmt.Errorf("operation journal %q has unknown status %q", id, operation.Status)
		}
	}
	return unfinished, nil
}

func validStartupPreparedDrainingBoundary(op model.Operation, platform model.ManagerState) bool {
	waiting := !platform.Maintenance && platform.PublicState == model.StateWaitingForTasks
	reserved := platform.Maintenance && platform.PublicState == model.StateUpdating
	uncertain := platform.Maintenance && platform.PublicState == model.StateFailed
	switch op.ReservationStatus {
	case "":
		// An update waits here before its first durable reservation owner. A
		// fresh install has no admission reservation and enters maintenance with
		// the same empty status immediately before stopping its first writer.
		return waiting || (op.Kind == model.OperationInstall && platform.Current == nil && reserved)
	case model.ReservationConfirmationPending:
		// UpdateOperation persists this owner before SetPhase persists the
		// fail-closed maintenance projection, so both adjacent durable halves are
		// replayable and still name the same operation.
		return waiting || reserved
	case model.ReservationConfirmed, model.ReservationMutationStarted:
		return reserved
	case model.ReservationReleaseUncertain:
		return uncertain
	default:
		return false
	}
}

func (m *Manager) validateStartupVersionArtifact(version Version, label string) error {
	data, _, err := readRecoveryRegularFile(version.Path, recoveryMaxBinaryBytes, false)
	if err != nil || sha256Hex(data) != version.SHA256 {
		return fmt.Errorf("%s Manager artifact is invalid during startup", label)
	}
	directory := filepath.Dir(version.Path)
	if !validVersionDirectoryIdentity(filepath.Base(directory), version) {
		return fmt.Errorf("%s Manager version directory identity is invalid during startup", label)
	}
	metadataData, _, err := readRecoveryRegularFile(filepath.Join(directory, "metadata.json"), recoveryMaxJSONBytes, true)
	if err != nil {
		return fmt.Errorf("read %s Manager version metadata during startup: %w", label, err)
	}
	var metadata Version
	if err := decodeRecoveryJSON(metadataData, &metadata); err != nil {
		return fmt.Errorf("%s Manager metadata does not match state during startup", label)
	}
	recoveryDirectory := filepath.Base(directory) == "recovery-"+version.SHA256[:12]
	sourceMatches := metadata.SourceCommit == version.SourceCommit ||
		(recoveryDirectory && metadata.SourceCommit == "" && validSourceCommit(version.SourceCommit))
	verifiedMatches := metadata.VerifiedAt.Equal(version.VerifiedAt) ||
		(recoveryDirectory && !metadata.VerifiedAt.IsZero() && !version.VerifiedAt.IsZero())
	if metadata.Version != version.Version || !sourceMatches || metadata.Path != version.Path ||
		metadata.SHA256 != version.SHA256 || !verifiedMatches {
		return fmt.Errorf("%s Manager metadata does not match state during startup", label)
	}
	if err := validateVersionDirectoryContents(directory); err != nil {
		return fmt.Errorf("validate %s Manager version directory during startup: %w", label, err)
	}
	return nil
}

func (m *Manager) validateStartupCurrentProcess(current Version) error {
	if current.Version == "" || !validSHA256(current.SHA256) || current.VerifiedAt.IsZero() ||
		!current.PlatformCommitted || !pathWithin(filepath.Join(m.Root, "versions"), current.Path) {
		return errors.New("registered Manager Current identity is invalid during startup")
	}
	if err := m.validateStartupVersionArtifact(current, "Current"); err != nil {
		return err
	}
	stable, _, err := readRecoveryRegularFile(m.InstallPath, recoveryMaxBinaryBytes, false)
	if err != nil || sha256Hex(stable) != current.SHA256 {
		return errors.New("stable Manager does not match registered Current during prepared startup")
	}
	runningSHA, err := startupRunningExecutableSHA()
	if err != nil {
		return err
	}
	if runningSHA != current.SHA256 || m.RunningVersion != current.Version {
		return errors.New("running Manager does not match registered Current during prepared startup")
	}
	return nil
}

func (m *Manager) validateStartupOrdinaryActivation(state State) error {
	candidate, activation := state.Candidate, state.Activation
	if state.Current == nil || candidate == nil || activation == nil || !candidate.PlatformCommitted ||
		!validSourceCommit(candidate.SourceCommit) || !validSHA256(candidate.SHA256) ||
		activation.CandidateSHA != candidate.SHA256 || activation.CandidatePath != candidate.Path ||
		!pathWithin(filepath.Join(m.Root, "versions"), candidate.Path) ||
		!pathWithin(filepath.Join(m.Root, "activations"), activation.PlanPath) {
		return errors.New("ordinary Manager startup activation identity is invalid")
	}
	_, plan, err := readRecoveryActivationPlan(activation.PlanPath)
	if err != nil {
		return err
	}
	if plan.Mode != "" || plan.PlanPath != activation.PlanPath {
		return errors.New("ordinary Manager startup activation has a specialized or mismatched plan")
	}
	if plan.Status == ordinaryRolledBackStatus {
		return m.validateStartupOrdinaryRollbackHalf(state, plan)
	}
	if err := m.validateRecoveryPlanBinding(plan, state, *candidate, candidate.SourceCommit, false); err != nil {
		return err
	}
	currentData, _, err := readRecoveryRegularFile(state.Current.Path, recoveryMaxBinaryBytes, false)
	if err != nil || !validSHA256(state.Current.SHA256) || sha256Hex(currentData) != state.Current.SHA256 {
		return errors.New("ordinary Manager startup Current artifact is invalid")
	}
	candidateData, _, err := readRecoveryRegularFile(candidate.Path, recoveryMaxBinaryBytes, false)
	if err != nil || sha256Hex(candidateData) != candidate.SHA256 {
		return errors.New("ordinary Manager startup Candidate artifact is invalid")
	}
	stable, _, err := readRecoveryRegularFile(m.InstallPath, recoveryMaxBinaryBytes, false)
	if err != nil {
		return err
	}
	stableSHA := sha256Hex(stable)
	if stableSHA != state.Current.SHA256 && stableSHA != candidate.SHA256 {
		return errors.New("ordinary Manager startup stable executable matches neither Current nor Candidate")
	}
	runningSHA, err := startupRunningExecutableSHA()
	if err != nil {
		return err
	}
	if runningSHA != stableSHA {
		return errors.New("ordinary Manager startup process is not executing the stable identity")
	}
	return nil
}

func (m *Manager) validateStartupOrdinaryRollbackHalf(state State, plan Plan) error {
	if state.Candidate == nil {
		return errors.New("rolled-back Manager activation has no Candidate identity")
	}
	candidate := *state.Candidate
	if candidate.Version == "" || !validSourceCommit(candidate.SourceCommit) || !validSHA256(candidate.SHA256) ||
		candidate.VerifiedAt.IsZero() || !candidate.PlatformCommitted {
		return errors.New("rolled-back Manager Candidate identity is incomplete")
	}
	expectedCandidatePath := filepath.Join(
		m.Root,
		"versions",
		safeID(candidate.Version+"-"+candidate.SourceCommit[:12]),
		sourceManagerBinaryName(),
	)
	expectedPlanPath := filepath.Join(m.Root, "activations", safeID(candidate.SourceCommit)+".json")
	if candidate.Path != expectedCandidatePath || plan.PlanPath != expectedPlanPath ||
		state.Activation == nil || state.Activation.PlanPath != expectedPlanPath {
		return errors.New("rolled-back Manager Candidate or activation plan path is not the exact managed identity")
	}
	if state.Current == nil || state.Candidate == nil || state.Activation == nil || plan.Error == "" ||
		state.Current.Version == "" || !validSHA256(state.Current.SHA256) || state.Current.VerifiedAt.IsZero() ||
		!state.Current.PlatformCommitted || !pathWithin(filepath.Join(m.Root, "versions"), state.Current.Path) ||
		state.Activation.PlanPath != plan.PlanPath || state.Activation.CandidateSHA != state.Candidate.SHA256 ||
		state.Activation.CandidatePath != state.Candidate.Path || state.Activation.StartedAt.IsZero() ||
		state.Activation.StartedAt.Before(plan.CreatedAt) {
		return errors.New("rolled-back Manager activation has incomplete terminal ownership evidence")
	}
	// validateRecoveryPlanBinding intentionally rejects terminal plans which are
	// still referenced. Validate all immutable/configuration fields against a
	// copy with that one expected plan-first half-checkpoint removed, then prove
	// the live reference explicitly above.
	settledBinding := state
	settledBinding.Activation = nil
	if err := m.validateRecoveryPlanBinding(plan, settledBinding, *state.Candidate, state.Candidate.SourceCommit, false); err != nil {
		return fmt.Errorf("validate rolled-back Manager activation binding: %w", err)
	}
	if err := m.validateStartupVersionArtifact(*state.Current, "rolled-back Current"); err != nil {
		return err
	}
	if err := m.validateStartupVersionArtifact(*state.Candidate, "rolled-back Candidate"); err != nil {
		return err
	}
	stable, _, err := readRecoveryRegularFile(m.InstallPath, recoveryMaxBinaryBytes, false)
	if err != nil || sha256Hex(stable) != state.Current.SHA256 {
		return errors.New("rolled-back Manager activation stable binary is not registered Current")
	}
	runningSHA, err := startupRunningExecutableSHA()
	if err != nil {
		return err
	}
	if runningSHA != state.Current.SHA256 || m.RunningVersion != state.Current.Version {
		return errors.New("rolled-back Manager activation process is not registered Current")
	}
	return nil
}

func (m *Manager) validateBusyStartupWithoutTakeover() error {
	first, err := m.readStartupHealthyRecoverySnapshot()
	if err != nil {
		return err
	}
	second, err := m.readStartupHealthyRecoverySnapshot()
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(first, second) {
		return errors.New("Manager recovery marker changed while the global recovery lock was busy")
	}
	return nil
}

func (m *Manager) readStartupHealthyRecoverySnapshot() (startupHealthyRecoverySnapshot, error) {
	var snapshot startupHealthyRecoverySnapshot
	stateData, state, err := readRecoverySelfUpdateState(m.StatePath)
	if err != nil {
		return snapshot, err
	}
	if state.Current == nil || state.Candidate != nil || state.Activation != nil || state.UpdatedAt.IsZero() {
		return snapshot, errors.New("busy external recovery has no settled Manager Current marker")
	}
	current := *state.Current
	if !validSourceCommit(current.Version) || !validSourceCommit(current.SourceCommit) || !validSHA256(current.SHA256) ||
		!current.PlatformCommitted || current.VerifiedAt.IsZero() || !pathWithin(filepath.Join(m.Root, "versions"), current.Path) {
		return snapshot, errors.New("busy external recovery has an invalid registered Current identity")
	}
	currentBinary, _, err := readRecoveryRegularFile(current.Path, recoveryMaxBinaryBytes, false)
	if err != nil || sha256Hex(currentBinary) != current.SHA256 {
		return snapshot, errors.New("busy external recovery registered Current artifact is invalid")
	}
	stable, _, err := readRecoveryRegularFile(m.InstallPath, recoveryMaxBinaryBytes, false)
	if err != nil {
		return snapshot, fmt.Errorf("read stable Manager while external recovery lock is busy: %w", err)
	}
	runningSHA, err := startupRunningExecutableSHA()
	if err != nil {
		return snapshot, err
	}
	stableSHA := sha256Hex(stable)
	if runningSHA != stableSHA {
		return snapshot, errors.New("running Manager and stable executable differ while external recovery lock is busy")
	}
	snapshot = startupHealthyRecoverySnapshot{
		state: state, stateSHA: sha256Hex(stateData), stableSHA: stableSHA,
		runningSHA: runningSHA, currentSHA: sha256Hex(currentBinary),
	}
	if stableSHA == current.SHA256 {
		if m.RunningVersion != current.Version {
			return snapshot, errors.New("running Manager version does not match registered Current during external recovery")
		}
		return snapshot, nil
	}
	if !validSourceCommit(m.RunningVersion) {
		return snapshot, errors.New("running recovery Manager version is invalid")
	}
	recoveryPath := filepath.Join(m.Root, "versions", "recovery-"+stableSHA[:12], sourceManagerBinaryName())
	recoveryBinary, _, err := readRecoveryRegularFile(recoveryPath, recoveryMaxBinaryBytes, false)
	if err != nil || sha256Hex(recoveryBinary) != stableSHA {
		return snapshot, errors.New("stable recovery Manager has no matching immutable recovery artifact")
	}
	metadataPath := filepath.Join(filepath.Dir(recoveryPath), "metadata.json")
	metadataData, _, err := readRecoveryRegularFile(metadataPath, recoveryMaxJSONBytes, true)
	if err != nil {
		return snapshot, fmt.Errorf("read immutable recovery Manager metadata: %w", err)
	}
	var metadata Version
	if err := decodeRecoveryJSON(metadataData, &metadata); err != nil {
		return snapshot, fmt.Errorf("decode immutable recovery Manager metadata: %w", err)
	}
	if metadata.Version != m.RunningVersion || metadata.Path != recoveryPath || metadata.SHA256 != stableSHA ||
		metadata.VerifiedAt.IsZero() || !metadata.PlatformCommitted ||
		(metadata.SourceCommit != "" && !validSourceCommit(metadata.SourceCommit)) {
		return snapshot, errors.New("stable recovery Manager metadata does not match the running process")
	}
	if err := validateVersionDirectoryContents(filepath.Dir(recoveryPath)); err != nil {
		return snapshot, fmt.Errorf("validate immutable recovery Manager directory: %w", err)
	}
	snapshot.recoverySHA = sha256Hex(recoveryBinary)
	snapshot.metadataSHA = sha256Hex(metadataData)
	return snapshot, nil
}
