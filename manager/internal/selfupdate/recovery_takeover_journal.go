package selfupdate

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

const (
	recoveryTakeoverPrepared          = "prepared"
	recoveryTakeoverStableCurrent     = "stable_current"
	recoveryTakeoverPlanSuperseded    = "plan_superseded"
	recoveryTakeoverActivationCleared = "activation_cleared"
	recoveryTakeoverIntentPersisted   = "recovery_intent_persisted"
	recoveryTakeoverWatchdogOwned     = "watchdog_owned"
	recoveryTakeoverStableReplaced    = "stable_replaced"
	recoveryTakeoverPlanActivated     = "plan_activated"
	recoveryTakeoverMainStarted       = "main_started"
	recoveryTakeoverCommitted         = "committed"
	recoveryTakeoverRolledBack        = "rolled_back"
)

type recoveryTakeoverJournal struct {
	SchemaVersion int    `json:"schema_version"`
	TransactionID string `json:"transaction_id"`
	Phase         string `json:"phase"`
	Path          string `json:"path"`

	RecoveryVersion         string `json:"recovery_version"`
	RecoverySHA256          string `json:"recovery_sha256"`
	RecoveryPath            string `json:"recovery_path"`
	PlatformCommit          string `json:"platform_commit"`
	ManagerStatePath        string `json:"manager_state_path"`
	InstallPath             string `json:"install_path"`
	SocketPath              string `json:"socket_path"`
	ControlTokenFile        string `json:"control_token_file"`
	UnitName                string `json:"unit_name"`
	RecoveryHealthTimeoutMS int    `json:"recovery_health_timeout_ms"`
	InitialBootID           string `json:"initial_boot_id"`
	UnitInitiallyEnabled    bool   `json:"unit_initially_enabled"`

	PlatformStatePath   string `json:"platform_state_path"`
	PlatformStateSHA256 string `json:"platform_state_sha256"`
	OperationID         string `json:"operation_id"`
	OperationPath       string `json:"operation_path"`
	OperationSHA256     string `json:"operation_sha256"`
	ManifestPath        string `json:"manifest_path"`
	ManifestSHA256      string `json:"manifest_sha256"`

	OriginalStateSHA256 string     `json:"original_selfupdate_state_sha256"`
	OriginalState       State      `json:"original_selfupdate_state"`
	OriginalCurrent     Version    `json:"original_current"`
	OriginalCandidate   Version    `json:"original_candidate"`
	OriginalActivation  Activation `json:"original_activation"`
	OriginalPlanPath    string     `json:"original_plan_path"`
	OriginalPlanSHA256  string     `json:"original_plan_sha256"`
	InitialStableSHA256 string     `json:"initial_stable_sha256"`

	RecoveryPlanPath     string `json:"recovery_plan_path"`
	RecoveryWatchdogUnit string `json:"recovery_watchdog_unit"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (m *Manager) recoveryTakeoverJournalPath(platformCommit, recoverySHA string) string {
	return filepath.Join(m.Root, "recoveries", "recover-current-"+safeID(platformCommit[:12])+"-"+safeID(recoverySHA[:12])+".json")
}

func (m *Manager) newRecoveryTakeoverJournal(
	request recoveryActivationRequest,
	evidence recoveryFinalizeEvidence,
	takeover recoveryTakeover,
	stagedPath string,
) (recoveryTakeoverJournal, error) {
	if takeover.state.Current == nil || takeover.state.Candidate == nil || takeover.state.Activation == nil {
		return recoveryTakeoverJournal{}, errors.New("cannot journal an incomplete Manager activation takeover")
	}
	path := m.recoveryTakeoverJournalPath(request.platformCommit, request.newSHA)
	recoveryPlanPath := m.currentRecoveryPlanPath(request.platformCommit, request.newSHA)
	watchdogUnit := m.recoveryWatchdogUnitPrefix() + safeID(request.newSHA[:12])
	now := m.now()
	journal := recoveryTakeoverJournal{
		SchemaVersion:           1,
		Phase:                   recoveryTakeoverPrepared,
		Path:                    path,
		RecoveryVersion:         m.RunningVersion,
		RecoverySHA256:          request.newSHA,
		RecoveryPath:            stagedPath,
		PlatformCommit:          request.platformCommit,
		ManagerStatePath:        m.StatePath,
		InstallPath:             m.InstallPath,
		SocketPath:              m.SocketPath,
		ControlTokenFile:        m.ControlTokenFile,
		UnitName:                request.unit,
		RecoveryHealthTimeoutMS: recoveryActivationHealthTimeoutMS,
		InitialBootID:           m.bootID(),
		UnitInitiallyEnabled:    takeover.unitWasEnabled,
		PlatformStatePath:       request.platformStatePath,
		PlatformStateSHA256:     sha256Hex(evidence.stateData),
		OperationID:             evidence.operation.ID,
		OperationPath:           evidence.operationPath,
		OperationSHA256:         sha256Hex(evidence.operationData),
		ManifestPath:            evidence.manifestPath,
		ManifestSHA256:          sha256Hex(evidence.manifestData),
		OriginalStateSHA256:     sha256Hex(takeover.stateData),
		OriginalState:           takeover.state,
		OriginalCurrent:         *takeover.state.Current,
		OriginalCandidate:       *takeover.state.Candidate,
		OriginalActivation:      *takeover.state.Activation,
		OriginalPlanPath:        takeover.plan.PlanPath,
		OriginalPlanSHA256:      sha256Hex(takeover.planData),
		InitialStableSHA256:     takeover.stableSHA,
		RecoveryPlanPath:        recoveryPlanPath,
		RecoveryWatchdogUnit:    watchdogUnit,
		CreatedAt:               now,
		UpdatedAt:               now,
	}
	journal.TransactionID = recoveryTakeoverTransactionID(journal)
	if err := validateRecoveryTakeoverJournal(journal, m); err != nil {
		return recoveryTakeoverJournal{}, err
	}
	return journal, nil
}

func (m *Manager) persistRecoveryTakeoverJournal(journal recoveryTakeoverJournal) error {
	if err := validateRecoveryTakeoverJournal(journal, m); err != nil {
		return err
	}
	if err := ensureRecoveryDirectory(filepath.Dir(journal.Path)); err != nil {
		return fmt.Errorf("prepare current recovery journal directory: %w", err)
	}
	return atomicfile.WriteJSON(journal.Path, journal, 0o600)
}

func (m *Manager) advanceRecoveryTakeoverJournal(journal *recoveryTakeoverJournal, phase string) error {
	return withRecoveryTakeoverMutationLock(journal.Path, func() error {
		return m.advanceRecoveryTakeoverJournalLocked(journal, phase)
	})
}

func (m *Manager) advanceRecoveryTakeoverJournalLocked(journal *recoveryTakeoverJournal, phase string) error {
	latest, exists, err := m.readRecoveryTakeoverJournal(journal.Path)
	if err != nil {
		return err
	}
	if !exists || latest.TransactionID != journal.TransactionID {
		return errors.New("current recovery takeover journal ownership changed")
	}
	if !sameRecoveryTakeoverBinding(latest, *journal) {
		return errors.New("current recovery takeover journal immutable binding changed")
	}
	if latest.Phase != journal.Phase {
		if !recoveryPhaseBefore(latest.Phase, journal.Phase) {
			*journal = latest
			return nil
		}
		return fmt.Errorf("current recovery takeover journal regressed from %s to %s", journal.Phase, latest.Phase)
	}
	if !validRecoveryTakeoverTransition(journal.Phase, phase) {
		return fmt.Errorf("invalid current recovery phase transition %s -> %s", journal.Phase, phase)
	}
	journal.Phase = phase
	journal.UpdatedAt = m.now()
	return m.persistRecoveryTakeoverJournal(*journal)
}

func sameRecoveryTakeoverBinding(left, right recoveryTakeoverJournal) bool {
	left.Phase, right.Phase = "", ""
	left.UpdatedAt, right.UpdatedAt = time.Time{}, time.Time{}
	return reflect.DeepEqual(left, right)
}

// withRecoveryTakeoverMutationLock is the cross-process serialization point
// shared by the external bootstrap writer and the recovery watchdog. Atomic
// replacement alone is not a compare-and-swap: without this lock a stale
// bootstrap phase could overwrite a terminal watchdog write after both
// processes had read the same journal generation.
func withRecoveryTakeoverMutationLock(journalPath string, mutate func() error) error {
	if journalPath == "" || !filepath.IsAbs(journalPath) || filepath.Clean(journalPath) != journalPath {
		return errors.New("current recovery takeover journal path is invalid")
	}
	lockPath := journalPath + ".lock"
	fd, err := syscall.Open(lockPath, syscall.O_CREAT|syscall.O_RDWR|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return fmt.Errorf("open current recovery takeover lock: %w", err)
	}
	file := os.NewFile(uintptr(fd), lockPath)
	if file == nil {
		_ = syscall.Close(fd)
		return errors.New("open current recovery takeover lock: invalid file descriptor")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return fmt.Errorf("inspect current recovery takeover lock: %w", err)
	}
	if !info.Mode().IsRegular() {
		return errors.New("current recovery takeover lock is not a regular file")
	}
	if err := validateRecoveryOwner(lockPath, info); err != nil {
		return err
	}
	if info.Mode().Perm()&0o077 != 0 {
		return errors.New("current recovery takeover lock is accessible by another host identity")
	}
	if err := file.Chmod(0o600); err != nil {
		return fmt.Errorf("restrict current recovery takeover lock: %w", err)
	}
	if err := syscall.Flock(fd, syscall.LOCK_EX); err != nil {
		return fmt.Errorf("lock current recovery takeover journal: %w", err)
	}
	defer syscall.Flock(fd, syscall.LOCK_UN) //nolint:errcheck -- best-effort unlock while closing the descriptor
	return mutate()
}

func (m *Manager) readRecoveryTakeoverJournal(path string) (recoveryTakeoverJournal, bool, error) {
	var journal recoveryTakeoverJournal
	if _, err := os.Lstat(path); err != nil {
		if os.IsNotExist(err) {
			return journal, false, nil
		}
		return journal, false, err
	}
	data, _, err := readRecoveryRegularFile(path, recoveryMaxJSONBytes, true)
	if err != nil {
		if os.IsNotExist(err) {
			return journal, false, nil
		}
		return journal, false, err
	}
	if err := decodeRecoveryJSON(data, &journal); err != nil {
		return journal, false, fmt.Errorf("decode current recovery takeover journal: %w", err)
	}
	if err := validateRecoveryTakeoverJournal(journal, m); err != nil {
		return journal, false, err
	}
	return journal, true, nil
}

func validateRecoveryTakeoverJournal(journal recoveryTakeoverJournal, manager *Manager) error {
	if journal.SchemaVersion != 1 || !validSHA256(journal.TransactionID) ||
		!validSourceCommit(journal.RecoveryVersion) || !validSHA256(journal.RecoverySHA256) ||
		!validSourceCommit(journal.PlatformCommit) || journal.CreatedAt.IsZero() || journal.UpdatedAt.Before(journal.CreatedAt) {
		return errors.New("current recovery takeover journal identity is invalid")
	}
	for _, digest := range []string{
		journal.PlatformStateSHA256,
		journal.OperationSHA256,
		journal.ManifestSHA256,
		journal.OriginalStateSHA256,
		journal.OriginalPlanSHA256,
		journal.InitialStableSHA256,
	} {
		if !validSHA256(digest) {
			return errors.New("current recovery takeover journal contains an invalid digest")
		}
	}
	wantTransactionID := recoveryTakeoverTransactionID(journal)
	if journal.TransactionID != wantTransactionID {
		return errors.New("current recovery takeover journal transaction digest is invalid")
	}
	if journal.Path != manager.recoveryTakeoverJournalPath(journal.PlatformCommit, journal.RecoverySHA256) ||
		journal.RecoveryPlanPath != manager.currentRecoveryPlanPath(journal.PlatformCommit, journal.RecoverySHA256) ||
		journal.RecoveryWatchdogUnit != manager.recoveryWatchdogUnitPrefix()+safeID(journal.RecoverySHA256[:12]) ||
		journal.PlatformStatePath != filepath.Join(filepath.Dir(manager.StatePath), "state.json") ||
		journal.OperationPath != filepath.Join(filepath.Dir(manager.StatePath), "operations", journal.OperationID+".json") ||
		journal.ManifestPath != filepath.Join(filepath.Dir(manager.StatePath), "releases", journal.PlatformCommit, "manifest.json") ||
		journal.OriginalPlanPath == "" || journal.RecoveryPath == "" {
		return errors.New("current recovery takeover journal paths are inconsistent")
	}
	if journal.ManagerStatePath != manager.StatePath || journal.InstallPath != manager.InstallPath ||
		journal.SocketPath != manager.SocketPath || journal.ControlTokenFile != manager.ControlTokenFile ||
		journal.UnitName != manager.recoveryUnitName() || !validRecoveryUnit(journal.UnitName) ||
		journal.RecoveryHealthTimeoutMS != recoveryActivationHealthTimeoutMS || journal.InitialBootID == "" ||
		len(journal.InitialBootID) > 256 || strings.ContainsAny(journal.InitialBootID, "\r\n") || !journal.UnitInitiallyEnabled {
		return errors.New("current recovery takeover journal Manager configuration is inconsistent")
	}
	for _, managedPath := range []string{journal.ManagerStatePath, journal.InstallPath, journal.SocketPath, journal.ControlTokenFile} {
		if managedPath == "" || !filepath.IsAbs(managedPath) || filepath.Clean(managedPath) != managedPath {
			return errors.New("current recovery takeover journal contains a non-canonical Manager path")
		}
	}
	if !pathWithin(filepath.Join(manager.Root, "versions"), journal.RecoveryPath) ||
		!pathWithin(filepath.Join(manager.Root, "versions"), journal.OriginalCurrent.Path) ||
		!pathWithin(filepath.Join(manager.Root, "versions"), journal.OriginalCandidate.Path) ||
		!pathWithin(filepath.Join(manager.Root, "activations"), journal.OriginalPlanPath) ||
		!pathWithin(filepath.Join(manager.Root, "activations"), journal.RecoveryPlanPath) {
		return errors.New("current recovery takeover journal references an unmanaged Manager path")
	}
	if journal.RecoveryPath != filepath.Join(manager.Root, "versions", "recovery-"+journal.RecoverySHA256[:12], manager.managerBinaryName()) {
		return errors.New("current recovery takeover journal recovery artifact path is inconsistent")
	}
	if !validRecoveryOperationID(journal.OperationID) ||
		!validSourceCommit(journal.OriginalCurrent.Version) || !validSourceCommit(journal.OriginalCurrent.SourceCommit) ||
		!validSHA256(journal.OriginalCurrent.SHA256) || !journal.OriginalCurrent.PlatformCommitted || journal.OriginalCurrent.VerifiedAt.IsZero() ||
		journal.OriginalCandidate.Version != journal.PlatformCommit || journal.OriginalCandidate.SourceCommit != journal.PlatformCommit ||
		!validSHA256(journal.OriginalCandidate.SHA256) || !journal.OriginalCandidate.PlatformCommitted || journal.OriginalCandidate.VerifiedAt.IsZero() ||
		journal.OriginalActivation.StartedAt.IsZero() {
		return errors.New("current recovery takeover journal version snapshot is invalid")
	}
	if journal.OriginalCurrent.Path == "" || journal.OriginalCandidate.Path == "" ||
		journal.OriginalActivation.PlanPath != journal.OriginalPlanPath ||
		journal.OriginalActivation.CandidateSHA != journal.OriginalCandidate.SHA256 ||
		journal.OriginalActivation.CandidatePath != journal.OriginalCandidate.Path {
		return errors.New("current recovery takeover journal snapshot is inconsistent")
	}
	if journal.OriginalState.SchemaVersion != 1 || journal.OriginalState.Current == nil ||
		journal.OriginalState.Candidate == nil || journal.OriginalState.Activation == nil || journal.OriginalState.UpdatedAt.IsZero() ||
		!reflect.DeepEqual(*journal.OriginalState.Current, journal.OriginalCurrent) ||
		!reflect.DeepEqual(*journal.OriginalState.Candidate, journal.OriginalCandidate) ||
		!reflect.DeepEqual(*journal.OriginalState.Activation, journal.OriginalActivation) {
		return errors.New("current recovery takeover journal does not preserve the full original Manager state")
	}
	switch journal.Phase {
	case recoveryTakeoverPrepared,
		recoveryTakeoverStableCurrent,
		recoveryTakeoverPlanSuperseded,
		recoveryTakeoverActivationCleared,
		recoveryTakeoverIntentPersisted,
		recoveryTakeoverWatchdogOwned,
		recoveryTakeoverStableReplaced,
		recoveryTakeoverPlanActivated,
		recoveryTakeoverMainStarted,
		recoveryTakeoverCommitted,
		recoveryTakeoverRolledBack:
	default:
		return fmt.Errorf("unsupported current recovery takeover phase %q", journal.Phase)
	}
	return nil
}

func recoveryTakeoverTransactionID(journal recoveryTakeoverJournal) string {
	identity := struct {
		RecoveryVersion      string `json:"recovery_version"`
		RecoverySHA256       string `json:"recovery_sha256"`
		RecoveryPath         string `json:"recovery_path"`
		PlatformCommit       string `json:"platform_commit"`
		ManagerStatePath     string `json:"manager_state_path"`
		InstallPath          string `json:"install_path"`
		SocketPath           string `json:"socket_path"`
		ControlTokenFile     string `json:"control_token_file"`
		UnitName             string `json:"unit_name"`
		HealthTimeoutMS      int    `json:"health_timeout_ms"`
		InitialBootID        string `json:"initial_boot_id"`
		UnitInitiallyEnabled bool   `json:"unit_initially_enabled"`
		PlatformStatePath    string `json:"platform_state_path"`
		PlatformStateSHA256  string `json:"platform_state_sha256"`
		OperationID          string `json:"operation_id"`
		OperationPath        string `json:"operation_path"`
		OperationSHA256      string `json:"operation_sha256"`
		ManifestPath         string `json:"manifest_path"`
		ManifestSHA256       string `json:"manifest_sha256"`
		OriginalStateSHA256  string `json:"original_state_sha256"`
		OriginalPlanPath     string `json:"original_plan_path"`
		OriginalPlanSHA256   string `json:"original_plan_sha256"`
		InitialStableSHA256  string `json:"initial_stable_sha256"`
		RecoveryPlanPath     string `json:"recovery_plan_path"`
		RecoveryWatchdogUnit string `json:"recovery_watchdog_unit"`
	}{
		RecoveryVersion: journal.RecoveryVersion, RecoverySHA256: journal.RecoverySHA256,
		RecoveryPath: journal.RecoveryPath, PlatformCommit: journal.PlatformCommit,
		ManagerStatePath: journal.ManagerStatePath, InstallPath: journal.InstallPath,
		SocketPath: journal.SocketPath, ControlTokenFile: journal.ControlTokenFile, UnitName: journal.UnitName,
		HealthTimeoutMS: journal.RecoveryHealthTimeoutMS, InitialBootID: journal.InitialBootID,
		UnitInitiallyEnabled: journal.UnitInitiallyEnabled,
		PlatformStatePath:    journal.PlatformStatePath, PlatformStateSHA256: journal.PlatformStateSHA256,
		OperationID: journal.OperationID, OperationPath: journal.OperationPath, OperationSHA256: journal.OperationSHA256,
		ManifestPath: journal.ManifestPath, ManifestSHA256: journal.ManifestSHA256,
		OriginalStateSHA256: journal.OriginalStateSHA256, OriginalPlanPath: journal.OriginalPlanPath,
		OriginalPlanSHA256: journal.OriginalPlanSHA256, InitialStableSHA256: journal.InitialStableSHA256,
		RecoveryPlanPath: journal.RecoveryPlanPath, RecoveryWatchdogUnit: journal.RecoveryWatchdogUnit,
	}
	data, _ := json.Marshal(identity)
	return sha256Hex(data)
}

func validRecoveryTakeoverTransition(from, to string) bool {
	if from == to {
		return true
	}
	transitions := map[string]string{
		recoveryTakeoverPrepared:          recoveryTakeoverStableCurrent,
		recoveryTakeoverStableCurrent:     recoveryTakeoverPlanSuperseded,
		recoveryTakeoverPlanSuperseded:    recoveryTakeoverActivationCleared,
		recoveryTakeoverActivationCleared: recoveryTakeoverIntentPersisted,
		recoveryTakeoverIntentPersisted:   recoveryTakeoverWatchdogOwned,
		recoveryTakeoverWatchdogOwned:     recoveryTakeoverStableReplaced,
		recoveryTakeoverStableReplaced:    recoveryTakeoverPlanActivated,
		recoveryTakeoverPlanActivated:     recoveryTakeoverMainStarted,
		recoveryTakeoverMainStarted:       recoveryTakeoverCommitted,
	}
	if transitions[from] == to {
		return true
	}
	// Once the recovery watchdog owns the transaction it may roll back from
	// any bootstrap or observation phase. No pre-handoff phase may claim that
	// terminal transition.
	switch from {
	case recoveryTakeoverWatchdogOwned, recoveryTakeoverStableReplaced, recoveryTakeoverPlanActivated, recoveryTakeoverMainStarted:
		return to == recoveryTakeoverRolledBack || to == recoveryTakeoverCommitted
	default:
		return false
	}
}

func readRecoveryTakeoverOwnership(active identity.ActiveProfile, plan Plan) (recoveryTakeoverJournal, error) {
	var journal recoveryTakeoverJournal
	if plan.Mode != recoveryActivationMode || plan.RecoveryJournalPath == "" || plan.RecoveryTransactionID == "" {
		return journal, errors.New("activation plan has no current recovery ownership")
	}
	if !filepath.IsAbs(plan.RecoveryJournalPath) || filepath.Clean(plan.RecoveryJournalPath) != plan.RecoveryJournalPath {
		return journal, errors.New("activation plan current recovery journal path is invalid")
	}
	data, _, err := readRecoveryRegularFile(plan.RecoveryJournalPath, recoveryMaxJSONBytes, true)
	if err != nil {
		return journal, fmt.Errorf("read current recovery ownership journal: %w", err)
	}
	if err := decodeRecoveryJSON(data, &journal); err != nil {
		return journal, err
	}
	root := filepath.Dir(filepath.Dir(plan.RecoveryJournalPath))
	manager := &Manager{
		Profile:          active,
		Root:             root,
		StatePath:        filepath.Join(filepath.Dir(root), "manager-binaries.json"),
		InstallPath:      journal.InstallPath,
		SocketPath:       journal.SocketPath,
		ControlTokenFile: journal.ControlTokenFile,
		UnitName:         journal.UnitName,
	}
	if err := validateRecoveryTakeoverJournal(journal, manager); err != nil {
		return journal, err
	}
	if err := validateSupersededRecoveryPlanConfiguration(plan, journal); err != nil {
		return journal, err
	}
	if err := validateRecoveryPlanOwnership(plan, journal); err != nil {
		return journal, err
	}
	return journal, nil
}

func validateSupersededRecoveryPlanConfiguration(recoveryPlan Plan, journal recoveryTakeoverJournal) error {
	_, superseded, err := readRecoveryActivationPlan(journal.OriginalPlanPath)
	if err != nil {
		return fmt.Errorf("read superseded Manager activation plan: %w", err)
	}
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
		return errors.New("current recovery plan configuration is not bound to its superseded activation")
	}
	return nil
}

func persistRecoveryTakeoverTerminal(journal recoveryTakeoverJournal, phase string) error {
	return withRecoveryTakeoverMutationLock(journal.Path, func() error {
		return persistRecoveryTakeoverTerminalLocked(journal, phase)
	})
}

func persistRecoveryTakeoverTerminalLocked(journal recoveryTakeoverJournal, phase string) error {
	if phase != recoveryTakeoverCommitted && phase != recoveryTakeoverRolledBack {
		return errors.New("invalid current recovery terminal phase")
	}
	data, _, err := readRecoveryRegularFile(journal.Path, recoveryMaxJSONBytes, true)
	if err != nil {
		return err
	}
	var latest recoveryTakeoverJournal
	if err := decodeRecoveryJSON(data, &latest); err != nil {
		return err
	}
	if latest.TransactionID != journal.TransactionID {
		return errors.New("current recovery terminal writer lost transaction ownership")
	}
	if !sameRecoveryTakeoverBinding(latest, journal) {
		return errors.New("current recovery terminal writer lost immutable journal ownership")
	}
	journal = latest
	if journal.Phase == phase {
		return nil
	}
	if journal.Phase == recoveryTakeoverCommitted || journal.Phase == recoveryTakeoverRolledBack {
		return fmt.Errorf("current recovery is already terminal in phase %s", journal.Phase)
	}
	if !validRecoveryTakeoverTransition(journal.Phase, phase) {
		return fmt.Errorf("current recovery journal cannot transition %s -> %s", journal.Phase, phase)
	}
	journal.Phase = phase
	journal.UpdatedAt = time.Now().UTC()
	return atomicfile.WriteJSON(journal.Path, journal, 0o600)
}
