package selfupdate

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
)

func (m *Manager) driveRecoveryTakeoverJournal(
	ctx context.Context,
	request recoveryActivationRequest,
	evidence recoveryFinalizeEvidence,
	journal recoveryTakeoverJournal,
) error {
	if err := m.validateRecoveryTakeoverRequest(request, evidence, journal); err != nil {
		return err
	}

	if recoveryPhaseBefore(journal.Phase, recoveryTakeoverWatchdogOwned) {
		// Until a recovery watchdog is both state-referenced and proven active,
		// the external transaction remains the only activation writer. Repeated
		// invocations quiesce the old exact owners before touching a checkpoint.
		if err := m.setRecoveryUnitEnabled(ctx, request.unit, false); err != nil {
			return fmt.Errorf("fence Manager automatic startup during current recovery takeover: %w", err)
		}
		if err := m.runner().Run(ctx, "systemctl", "--user", "stop", request.unit); err != nil {
			return fmt.Errorf("stop Manager while resuming current recovery takeover: %w", err)
		}
		exactUnits := recoveryActivationWatchdogUnits(journal.OriginalCandidate)
		if journal.Phase == recoveryTakeoverIntentPersisted {
			exactUnits = append(exactUnits, journal.RecoveryWatchdogUnit)
		}
		if err := m.quiesceRecoveryUnits(ctx, request.unit, exactUnits, journal.OriginalPlanPath); err != nil {
			return err
		}
		if err := m.validateRecoveryPreHandoffCheckpoint(journal); err != nil {
			return err
		}
	}

	if recoveryPhaseBefore(journal.Phase, recoveryTakeoverStableCurrent) {
		if err := m.runRecoveryBootstrapTransition(&journal, recoveryTakeoverStableCurrent, func(latest recoveryTakeoverJournal) error {
			return m.ensureRecoveryStable(latest.OriginalCurrent, latest.InitialStableSHA256)
		}); err != nil {
			return err
		}
	}
	if recoveryPhaseBefore(journal.Phase, recoveryTakeoverPlanSuperseded) {
		if err := m.runRecoveryBootstrapTransition(&journal, recoveryTakeoverPlanSuperseded, func(latest recoveryTakeoverJournal) error {
			return m.ensureOriginalPlanSuperseded(latest)
		}); err != nil {
			return err
		}
	}
	if recoveryPhaseBefore(journal.Phase, recoveryTakeoverActivationCleared) {
		if err := m.runRecoveryBootstrapTransition(&journal, recoveryTakeoverActivationCleared, func(latest recoveryTakeoverJournal) error {
			return m.ensureOriginalActivationCleared(latest)
		}); err != nil {
			return err
		}
	}
	if recoveryPhaseBefore(journal.Phase, recoveryTakeoverIntentPersisted) {
		if err := m.runRecoveryBootstrapTransition(&journal, recoveryTakeoverIntentPersisted, func(latest recoveryTakeoverJournal) error {
			if err := m.ensureRecoveryStableReplaced(latest); err != nil {
				return err
			}
			return m.ensureRecoveryActivationIntent(latest, request)
		}); err != nil {
			return err
		}
	}
	if recoveryPhaseBefore(journal.Phase, recoveryTakeoverWatchdogOwned) {
		if err := m.runRecoveryBootstrapTransition(&journal, recoveryTakeoverWatchdogOwned, func(latest recoveryTakeoverJournal) error {
			return m.ensureRecoveryWatchdog(ctx, latest)
		}); err != nil {
			return err
		}
	}
	if journal.Phase != recoveryTakeoverCommitted && journal.Phase != recoveryTakeoverRolledBack {
		if err := m.ensureRecoveryWatchdog(ctx, journal); err != nil {
			return fmt.Errorf("restore current recovery watchdog ownership: %w", err)
		}
	}

	// From watchdog_owned onward the recovery watchdog is the sole writer of
	// commit/rollback and Current/Previous. The external command is limited to
	// the journaled activation bootstrap below and then becomes an observer.
	if recoveryPhaseBefore(journal.Phase, recoveryTakeoverStableReplaced) {
		if err := m.runRecoveryBootstrapTransition(&journal, recoveryTakeoverStableReplaced, func(latest recoveryTakeoverJournal) error {
			return m.ensureRecoveryStableReplaced(latest)
		}); err != nil {
			return fmt.Errorf("recovery watchdog owns rollback after stable replacement failed: %w", err)
		}
	}
	if recoveryPhaseBefore(journal.Phase, recoveryTakeoverPlanActivated) {
		if err := m.runRecoveryBootstrapTransition(&journal, recoveryTakeoverPlanActivated, func(latest recoveryTakeoverJournal) error {
			return m.ensureRecoveryPlanActivated(latest)
		}); err != nil {
			return fmt.Errorf("recovery watchdog owns rollback after plan activation failed: %w", err)
		}
	}
	if recoveryPhaseBefore(journal.Phase, recoveryTakeoverMainStarted) {
		if err := m.setRecoveryUnitEnabled(ctx, request.unit, true); err != nil {
			return fmt.Errorf("recovery watchdog owns rollback after Manager enablement failed: %w", err)
		}
		// Starting the main unit may synchronously reach acknowledgement and let
		// the watchdog commit. Do not hold the takeover lock across systemd's
		// start transaction; the following conditional phase advance observes a
		// terminal watchdog write instead of overwriting it.
		if err := m.runner().Run(ctx, "systemctl", "--user", "start", request.unit); err != nil {
			return fmt.Errorf("recovery watchdog owns rollback after Manager start failed: %w", err)
		}
		if err := m.advanceRecoveryTakeoverJournal(&journal, recoveryTakeoverMainStarted); err != nil {
			return err
		}
	}

	if journal.Phase == recoveryTakeoverRolledBack {
		return errors.New("current recovery activation was rolled back by its watchdog")
	}
	if journal.Phase == recoveryTakeoverCommitted {
		return m.verifyCommittedRecovery(ctx, request, journal)
	}
	return m.observeJournaledRecoveryActivation(ctx, request, evidence, journal)
}

func (m *Manager) validateRecoveryPreHandoffCheckpoint(journal recoveryTakeoverJournal) error {
	data, state, err := readRecoverySelfUpdateState(m.StatePath)
	if err != nil {
		return err
	}
	if sha256Hex(data) == journal.OriginalStateSHA256 {
		return nil
	}
	if !recoveryStateHasOriginalBase(state, journal) {
		return errors.New("Manager state left registered Current before recovery watchdog handoff")
	}
	if state.Candidate != nil && reflect.DeepEqual(*state.Candidate, journal.OriginalCandidate) {
		if state.Activation != nil && reflect.DeepEqual(*state.Activation, journal.OriginalActivation) {
			return nil
		}
		if state.Activation == nil &&
			(journal.Phase == recoveryTakeoverPlanSuperseded || journal.Phase == recoveryTakeoverActivationCleared) {
			_, plan, planErr := readRecoveryActivationPlan(journal.OriginalPlanPath)
			if planErr != nil {
				return planErr
			}
			settledState := journal.OriginalState
			settledState.Activation = nil
			if err := m.validateRecoveryPlanBinding(plan, settledState, journal.OriginalCandidate, journal.PlatformCommit, false); err != nil {
				return fmt.Errorf("validate journaled activation-cleared plan: %w", err)
			}
			wantError := "ordinary Manager activation was superseded by controlled Current recovery transaction " + journal.TransactionID
			if plan.Status != recoverySupersededStatus || plan.Error != wantError {
				return errors.New("journaled activation-cleared checkpoint has no exact superseded plan evidence")
			}
			stableSHA, stableErr := fileSHA256(journal.InstallPath)
			if stableErr != nil {
				return stableErr
			}
			if journal.Phase == recoveryTakeoverPlanSuperseded {
				if stableSHA != journal.OriginalCurrent.SHA256 {
					return errors.New("journaled plan-superseded checkpoint does not retain stable Current")
				}
				if _, statErr := os.Lstat(journal.RecoveryPlanPath); !os.IsNotExist(statErr) {
					if statErr != nil {
						return statErr
					}
					return errors.New("journaled plan-superseded checkpoint unexpectedly has a recovery plan")
				}
				return nil
			}
			if stableSHA != journal.OriginalCurrent.SHA256 && stableSHA != journal.RecoverySHA256 {
				return errors.New("journaled activation-cleared stable is outside the recovery transaction")
			}
			_, recoveryPlanErr := os.Lstat(journal.RecoveryPlanPath)
			if os.IsNotExist(recoveryPlanErr) {
				return nil
			}
			if recoveryPlanErr != nil {
				return recoveryPlanErr
			}
			if stableSHA != journal.RecoverySHA256 {
				return errors.New("journaled activation-cleared plan exists before stable recovery replacement")
			}
			_, recoveryPlan, recoveryPlanErr := readRecoveryActivationPlan(journal.RecoveryPlanPath)
			if recoveryPlanErr != nil {
				return recoveryPlanErr
			}
			if err := validateRecoveryPlanOwnership(recoveryPlan, journal); err != nil {
				return fmt.Errorf("validate journaled pre-intent recovery plan: %w", err)
			}
			if recoveryPlan.Status != "prepared" || recoveryPlan.Activated || recoveryPlan.Acknowledged {
				return errors.New("journaled pre-intent recovery plan is not prepared")
			}
			return nil
		}
	}
	if recoveryCandidateMatches(state.Candidate, journal) && recoveryActivationMatches(state.Activation, journal) {
		return nil
	}
	return errors.New("Manager state is outside every journaled pre-handoff recovery checkpoint")
}

func (m *Manager) runRecoveryBootstrapTransition(
	journal *recoveryTakeoverJournal,
	target string,
	apply func(recoveryTakeoverJournal) error,
) error {
	return withRecoveryTakeoverMutationLock(journal.Path, func() error {
		latest, exists, err := m.readRecoveryTakeoverJournal(journal.Path)
		if err != nil {
			return err
		}
		if !exists || latest.TransactionID != journal.TransactionID {
			return errors.New("current recovery bootstrap lost takeover journal ownership")
		}
		if !sameRecoveryTakeoverBinding(latest, *journal) {
			return errors.New("current recovery bootstrap lost immutable takeover binding")
		}
		*journal = latest
		if latest.Phase == recoveryTakeoverCommitted || latest.Phase == recoveryTakeoverRolledBack ||
			!recoveryPhaseBefore(latest.Phase, target) {
			return nil
		}
		if !validRecoveryTakeoverTransition(latest.Phase, target) {
			return fmt.Errorf("current recovery bootstrap cannot transition %s -> %s", latest.Phase, target)
		}
		if err := apply(latest); err != nil {
			return err
		}
		return m.advanceRecoveryTakeoverJournalLocked(journal, target)
	})
}

func (m *Manager) validateRecoveryTakeoverRequest(request recoveryActivationRequest, evidence recoveryFinalizeEvidence, journal recoveryTakeoverJournal) error {
	if journal.RecoveryVersion != m.RunningVersion || journal.RecoverySHA256 != request.newSHA ||
		journal.RecoveryPath != filepath.Join(m.Root, "versions", "recovery-"+request.newSHA[:12], "ubitech-manager") ||
		journal.PlatformCommit != request.platformCommit || journal.PlatformStatePath != request.platformStatePath ||
		journal.OperationID != evidence.operation.ID || journal.OperationPath != evidence.operationPath ||
		journal.ManifestPath != evidence.manifestPath || journal.PlatformStateSHA256 != sha256Hex(evidence.stateData) ||
		journal.OperationSHA256 != sha256Hex(evidence.operationData) || journal.ManifestSHA256 != sha256Hex(evidence.manifestData) {
		return errors.New("current recovery request does not match its durable takeover journal")
	}
	artifact, ok := evidence.manifest.Manager.Artifacts[runtime.GOARCH]
	if !ok || journal.OriginalCandidate.Version != evidence.manifest.Manager.Version ||
		journal.OriginalCandidate.SourceCommit != journal.PlatformCommit || journal.OriginalCandidate.SHA256 != artifact.SHA256 ||
		!journal.OriginalCandidate.PlatformCommitted {
		return errors.New("takeover journal does not preserve the committed original Candidate identity")
	}
	if journal.OriginalState.Activation == nil ||
		journal.OriginalActivation.CandidateSHA != journal.OriginalCandidate.SHA256 ||
		journal.OriginalActivation.CandidatePath != journal.OriginalCandidate.Path ||
		journal.OriginalActivation.PlanPath != journal.OriginalPlanPath {
		return errors.New("takeover journal does not preserve the original Activation identity")
	}
	recoveryBinary, _, err := readRecoveryRegularFile(journal.RecoveryPath, recoveryMaxBinaryBytes, false)
	if err != nil || sha256Hex(recoveryBinary) != request.newSHA || !bytes.Equal(recoveryBinary, request.newBinary) {
		return errors.New("durable current recovery artifact no longer matches the requested executable")
	}
	currentBinary, _, err := readRecoveryRegularFile(journal.OriginalCurrent.Path, recoveryMaxBinaryBytes, false)
	if err != nil || sha256Hex(currentBinary) != journal.OriginalCurrent.SHA256 {
		return errors.New("durable takeover journal Current executable is invalid")
	}
	candidateBinary, _, err := readRecoveryRegularFile(journal.OriginalCandidate.Path, recoveryMaxBinaryBytes, false)
	if err != nil || sha256Hex(candidateBinary) != journal.OriginalCandidate.SHA256 {
		return errors.New("durable takeover journal Candidate executable is invalid")
	}
	return nil
}

func recoveryPhaseBefore(current, target string) bool {
	order := map[string]int{
		recoveryTakeoverPrepared:          0,
		recoveryTakeoverStableCurrent:     1,
		recoveryTakeoverPlanSuperseded:    2,
		recoveryTakeoverActivationCleared: 3,
		recoveryTakeoverIntentPersisted:   4,
		recoveryTakeoverWatchdogOwned:     5,
		recoveryTakeoverStableReplaced:    6,
		recoveryTakeoverPlanActivated:     7,
		recoveryTakeoverMainStarted:       8,
		recoveryTakeoverCommitted:         9,
		recoveryTakeoverRolledBack:        9,
	}
	return order[current] < order[target]
}

func (m *Manager) ensureRecoveryStable(current Version, initialStableSHA string) error {
	stable, _, err := readRecoveryRegularFile(m.InstallPath, recoveryMaxBinaryBytes, false)
	if err != nil {
		return fmt.Errorf("inspect stable during activation settlement: %w", err)
	}
	stableSHA := sha256Hex(stable)
	if stableSHA == current.SHA256 {
		return nil
	}
	if stableSHA != initialStableSHA {
		return errors.New("stable Manager changed outside the journaled activation takeover")
	}
	currentBinary, _, err := readRecoveryRegularFile(current.Path, recoveryMaxBinaryBytes, false)
	if err != nil || sha256Hex(currentBinary) != current.SHA256 {
		return errors.New("journaled Current Manager executable is invalid")
	}
	if err := validateRecoveryWritableTarget(m.InstallPath); err != nil {
		return err
	}
	if err := atomicfile.WriteFile(m.InstallPath, currentBinary, 0o755); err != nil {
		return fmt.Errorf("restore registered Current before controlled takeover: %w", err)
	}
	if !binaryMatches(m.InstallPath, current.SHA256) {
		return errors.New("stable Manager did not reach the journaled Current checkpoint")
	}
	return nil
}

func (m *Manager) ensureOriginalPlanSuperseded(journal recoveryTakeoverJournal) error {
	data, plan, err := readRecoveryActivationPlan(journal.OriginalPlanPath)
	if err != nil {
		return err
	}
	if sha256Hex(data) == journal.OriginalPlanSHA256 {
		if err := m.validateRecoveryPlanBinding(plan, journal.OriginalState, journal.OriginalCandidate, journal.PlatformCommit, false); err != nil {
			return fmt.Errorf("validate original Manager activation plan: %w", err)
		}
		plan.Status = recoverySupersededStatus
		plan.Error = "ordinary Manager activation was superseded by controlled Current recovery transaction " + journal.TransactionID
		plan.UpdatedAt = m.now()
		return persistActivationPlan(plan.PlanPath, plan)
	}
	if plan.Status != recoverySupersededStatus && plan.Status != "rolled_back" {
		return errors.New("original Manager activation plan changed outside the takeover transaction")
	}
	settledState := journal.OriginalState
	settledState.Activation = nil
	if err := m.validateRecoveryPlanBinding(plan, settledState, journal.OriginalCandidate, journal.PlatformCommit, false); err != nil {
		return fmt.Errorf("validate terminal original Manager activation plan: %w", err)
	}
	if plan.PlanPath != journal.OriginalPlanPath || plan.CandidateSHA != journal.OriginalCandidate.SHA256 || plan.PreviousPath != journal.OriginalCurrent.Path {
		return errors.New("terminal original Manager activation plan no longer matches takeover journal")
	}
	if plan.Status != recoverySupersededStatus {
		// A stopped ordinary watchdog may have won the race and durably rolled
		// back before takeover isolation completed. Rebind that already-safe
		// terminal plan to this transaction so every stale ordinary watchdog
		// snapshot observes an explicit loss of ownership.
		plan.Status = recoverySupersededStatus
		plan.Error = "ordinary Manager activation was superseded by controlled Current recovery transaction " + journal.TransactionID
		plan.UpdatedAt = m.now()
		return persistActivationPlan(plan.PlanPath, plan)
	}
	return nil
}

func (m *Manager) ensureOriginalActivationCleared(journal recoveryTakeoverJournal) error {
	data, state, err := readRecoverySelfUpdateState(m.StatePath)
	if err != nil {
		return err
	}
	if sha256Hex(data) == journal.OriginalStateSHA256 {
		state.Activation = nil
		state.UpdatedAt = m.now()
		return atomicfile.WriteJSON(m.StatePath, state, 0o600)
	}
	if !matchesRecoveryActivationClearedState(state, journal) {
		return errors.New("Manager state is outside the journaled activation-cleared checkpoint")
	}
	return nil
}

func matchesRecoveryActivationClearedState(state State, journal recoveryTakeoverJournal) bool {
	return recoveryStateHasOriginalBase(state, journal) && state.Candidate != nil &&
		reflect.DeepEqual(*state.Candidate, journal.OriginalCandidate) && state.Activation == nil
}

func recoveryStateHasOriginalBase(state State, journal recoveryTakeoverJournal) bool {
	return state.SchemaVersion == journal.OriginalState.SchemaVersion && state.Current != nil &&
		reflect.DeepEqual(*state.Current, journal.OriginalCurrent) && reflect.DeepEqual(state.Previous, journal.OriginalState.Previous)
}

func recoveryCandidateMatches(candidate *Version, journal recoveryTakeoverJournal) bool {
	return candidate != nil && candidate.Version == journal.RecoveryVersion && candidate.SourceCommit == journal.PlatformCommit &&
		candidate.SHA256 == journal.RecoverySHA256 && candidate.Path == journal.RecoveryPath &&
		candidate.PlatformCommitted && !candidate.VerifiedAt.IsZero()
}

func recoveryActivationMatches(activation *Activation, journal recoveryTakeoverJournal) bool {
	return activation != nil && activation.PlanPath == journal.RecoveryPlanPath &&
		activation.CandidateSHA == journal.RecoverySHA256 && activation.CandidatePath == journal.RecoveryPath &&
		!activation.StartedAt.IsZero()
}

func (m *Manager) ensureRecoveryActivationIntent(journal recoveryTakeoverJournal, request recoveryActivationRequest) error {
	_, state, err := readRecoverySelfUpdateState(m.StatePath)
	if err != nil {
		return err
	}
	now := m.now()
	plan := recoveryActivationPlanFromJournal(journal)
	if recoveryStateHasOriginalBase(state, journal) && recoveryCandidateMatches(state.Candidate, journal) &&
		recoveryActivationMatches(state.Activation, journal) {
		_, existing, readErr := readRecoveryActivationPlan(journal.RecoveryPlanPath)
		if readErr != nil {
			return readErr
		}
		return validateRecoveryPlanOwnership(existing, journal)
	}
	if !matchesRecoveryActivationClearedState(state, journal) {
		return errors.New("Manager state left the activation-cleared checkpoint before recovery intent")
	}
	if info, statErr := os.Lstat(journal.RecoveryPlanPath); statErr == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("current recovery activation plan path is not a regular file")
		}
		_, existing, readErr := readRecoveryActivationPlan(journal.RecoveryPlanPath)
		if readErr != nil {
			return readErr
		}
		if existing.Mode != recoveryActivationMode || existing.RecoveryTransactionID != journal.TransactionID || existing.CandidateSHA != journal.RecoverySHA256 {
			return errors.New("existing current recovery activation plan belongs to another transaction")
		}
		if err := validateRecoveryPlanOwnership(existing, journal); err != nil {
			return fmt.Errorf("validate existing current recovery activation plan: %w", err)
		}
		plan = existing
	} else if !os.IsNotExist(statErr) {
		return statErr
	} else if err := persistActivationPlan(journal.RecoveryPlanPath, plan); err != nil {
		return fmt.Errorf("persist journaled current recovery activation plan: %w", err)
	}
	candidate := Version{
		Version:           journal.RecoveryVersion,
		SourceCommit:      journal.PlatformCommit,
		Path:              journal.RecoveryPath,
		SHA256:            journal.RecoverySHA256,
		VerifiedAt:        now,
		PlatformCommitted: true,
	}
	state.Candidate = &candidate
	state.Activation = &Activation{PlanPath: journal.RecoveryPlanPath, CandidateSHA: candidate.SHA256, CandidatePath: candidate.Path, StartedAt: now}
	state.UpdatedAt = now
	return atomicfile.WriteJSON(m.StatePath, state, 0o600)
}

func recoveryActivationPlanFromJournal(journal recoveryTakeoverJournal) Plan {
	return Plan{
		SchemaVersion:         1,
		Mode:                  recoveryActivationMode,
		PlanPath:              journal.RecoveryPlanPath,
		Status:                "prepared",
		StatePath:             journal.ManagerStatePath,
		InstallPath:           journal.InstallPath,
		SocketPath:            journal.SocketPath,
		ControlTokenFile:      journal.ControlTokenFile,
		UnitName:              journal.UnitName,
		CandidateVersion:      journal.RecoveryVersion,
		CandidateSHA:          journal.RecoverySHA256,
		CandidatePath:         journal.RecoveryPath,
		PlatformCommit:        journal.PlatformCommit,
		RecoveryTransactionID: journal.TransactionID,
		RecoveryJournalPath:   journal.Path,
		SupersededPlanPath:    journal.OriginalPlanPath,
		SupersededPlanSHA:     journal.OriginalPlanSHA256,
		PreviousPath:          journal.OriginalCurrent.Path,
		CreatedAt:             journal.CreatedAt,
		UpdatedAt:             journal.CreatedAt,
		HealthTimeoutMS:       journal.RecoveryHealthTimeoutMS,
		BootID:                journal.InitialBootID,
	}
}

func (m *Manager) ensureRecoveryWatchdog(ctx context.Context, journal recoveryTakeoverJournal) error {
	active, err := m.recoveryUnitIsActive(ctx, journal.RecoveryWatchdogUnit)
	if err != nil {
		return err
	}
	if !active {
		if err := m.runner().Run(ctx, "systemd-run", "--user", "--quiet", "--collect", "--unit", journal.RecoveryWatchdogUnit, "--property=Type=exec", journal.RecoveryPath, "self-update-watchdog", "--plan", journal.RecoveryPlanPath); err != nil {
			return fmt.Errorf("start journaled current recovery watchdog: %w", err)
		}
	}
	active, err = m.recoveryUnitIsActive(ctx, journal.RecoveryWatchdogUnit)
	if err != nil {
		return err
	}
	if !active {
		return errors.New("current recovery watchdog was not proven active after launch")
	}
	return m.verifyRecoveryWatchdogProcess(ctx, journal.RecoveryWatchdogUnit, journal.RecoveryPath, journal.RecoverySHA256, journal.RecoveryPlanPath)
}

func (m *Manager) ensureRecoveryStableReplaced(journal recoveryTakeoverJournal) error {
	stable, _, err := readRecoveryRegularFile(m.InstallPath, recoveryMaxBinaryBytes, false)
	if err != nil {
		return err
	}
	stableSHA := sha256Hex(stable)
	if stableSHA == journal.RecoverySHA256 {
		return nil
	}
	if stableSHA != journal.OriginalCurrent.SHA256 {
		return errors.New("stable Manager left the journaled Current checkpoint before recovery replacement")
	}
	recoveryBinary, _, err := readRecoveryRegularFile(journal.RecoveryPath, recoveryMaxBinaryBytes, false)
	if err != nil || sha256Hex(recoveryBinary) != journal.RecoverySHA256 {
		return errors.New("journaled recovery Manager executable is invalid")
	}
	if err := atomicfile.WriteFile(m.InstallPath, recoveryBinary, 0o755); err != nil {
		return err
	}
	if !binaryMatches(m.InstallPath, journal.RecoverySHA256) {
		return errors.New("stable Manager did not reach journaled recovery executable")
	}
	return nil
}

func (m *Manager) ensureRecoveryPlanActivated(journal recoveryTakeoverJournal) error {
	_, plan, err := readRecoveryActivationPlan(journal.RecoveryPlanPath)
	if err != nil {
		return err
	}
	if err := validateRecoveryPlanOwnership(plan, journal); err != nil {
		return err
	}
	if plan.Status == "activated" || plan.Status == "acknowledged" {
		return nil
	}
	if plan.Status != "prepared" || plan.Activated || plan.Acknowledged {
		return errors.New("current recovery plan cannot enter activated state from its durable status")
	}
	plan.Activated = true
	plan.Status = "activated"
	plan.UpdatedAt = m.now()
	return persistActivationPlan(plan.PlanPath, plan)
}

func validateRecoveryPlanOwnership(plan Plan, journal recoveryTakeoverJournal) error {
	if plan.SchemaVersion != 1 || plan.Mode != recoveryActivationMode || plan.RecoveryTransactionID != journal.TransactionID ||
		plan.RecoveryJournalPath != journal.Path || plan.PlanPath != journal.RecoveryPlanPath ||
		plan.StatePath != journal.ManagerStatePath || plan.InstallPath != journal.InstallPath ||
		plan.SocketPath != journal.SocketPath || plan.ControlTokenFile != journal.ControlTokenFile || plan.UnitName != journal.UnitName ||
		plan.CandidateVersion != journal.RecoveryVersion || plan.CandidateSHA != journal.RecoverySHA256 ||
		plan.CandidatePath != journal.RecoveryPath || plan.PlatformCommit != journal.PlatformCommit ||
		plan.PreviousPath != journal.OriginalCurrent.Path || plan.SupersededPlanPath != journal.OriginalPlanPath ||
		plan.SupersededPlanSHA != journal.OriginalPlanSHA256 || plan.HealthTimeoutMS != journal.RecoveryHealthTimeoutMS ||
		plan.BootID != journal.InitialBootID || plan.CreatedAt.IsZero() || plan.UpdatedAt.Before(plan.CreatedAt) {
		return errors.New("current recovery plan lost its takeover transaction ownership")
	}
	switch plan.Status {
	case "prepared":
		if plan.Activated || plan.Acknowledged {
			return errors.New("prepared current recovery plan has invalid activation flags")
		}
	case "activated":
		if !plan.Activated || plan.Acknowledged {
			return errors.New("activated current recovery plan has invalid acknowledgement flags")
		}
	case "acknowledged", "committed":
		if !plan.Activated || !plan.Acknowledged {
			return errors.New("acknowledged current recovery plan has invalid flags")
		}
	case "rolled_back":
	default:
		return fmt.Errorf("current recovery plan has unsupported status %q", plan.Status)
	}
	return nil
}

func (m *Manager) observeJournaledRecoveryActivation(ctx context.Context, request recoveryActivationRequest, evidence recoveryFinalizeEvidence, journal recoveryTakeoverJournal) error {
	ticker := time.NewTicker(recoveryActivationObservationPoll)
	defer ticker.Stop()
	for {
		latest, exists, err := m.readRecoveryTakeoverJournal(journal.Path)
		if err != nil || !exists {
			if err == nil {
				err = errors.New("current recovery takeover journal disappeared")
			}
			return err
		}
		switch latest.Phase {
		case recoveryTakeoverCommitted:
			return m.verifyCommittedRecovery(ctx, request, latest)
		case recoveryTakeoverRolledBack:
			return errors.New("current recovery activation was rolled back by its watchdog")
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("current recovery activation remains owned by its watchdog: %w", ctx.Err())
		case <-ticker.C:
		}
	}
}

func (m *Manager) completeRecoveryTerminalCheckpoint(ctx context.Context, journal recoveryTakeoverJournal) (string, bool, error) {
	phase := ""
	completed := false
	err := withRecoveryTakeoverMutationLock(journal.Path, func() error {
		latest, exists, readErr := m.readRecoveryTakeoverJournal(journal.Path)
		if readErr != nil {
			return readErr
		}
		if !exists || latest.TransactionID != journal.TransactionID {
			return errors.New("current recovery terminal replay lost takeover journal ownership")
		}
		if !sameRecoveryTakeoverBinding(latest, journal) {
			return errors.New("current recovery terminal replay lost immutable takeover binding")
		}
		journal = latest
		if recoveryPhaseBefore(journal.Phase, recoveryTakeoverWatchdogOwned) {
			return nil
		}
		if err := validateRecoveryPlatformCurrentIdentity(journal); err != nil {
			return err
		}
		_, state, readErr := readRecoverySelfUpdateState(journal.ManagerStatePath)
		if readErr != nil {
			return readErr
		}
		plan := recoveryActivationPlanFromJournal(journal)
		planValid := false
		var planReadErr error
		planData, _, rawPlanErr := readRecoveryRegularFile(journal.RecoveryPlanPath, recoveryMaxJSONBytes, true)
		if rawPlanErr != nil {
			if !os.IsNotExist(rawPlanErr) {
				return rawPlanErr
			}
			planReadErr = rawPlanErr
		} else {
			var observed Plan
			if decodeErr := decodeRecoveryJSON(planData, &observed); decodeErr != nil {
				planReadErr = fmt.Errorf("decode current recovery activation plan: %w", decodeErr)
			} else {
				owned, ownershipErr := readRecoveryTakeoverOwnership(observed)
				if ownershipErr != nil {
					return ownershipErr
				}
				if owned.TransactionID != journal.TransactionID || !sameRecoveryTakeoverBinding(owned, journal) {
					return errors.New("current recovery terminal replay lost complete plan ownership")
				}
				plan = observed
				planValid = true
			}
		}
		switch {
		case recoveryCommittedStateMatches(state, journal):
			if journal.Phase == recoveryTakeoverRolledBack {
				return errors.New("rolled-back current recovery journal conflicts with committed Manager state")
			}
			if !binaryMatches(journal.InstallPath, journal.RecoverySHA256) {
				return errors.New("current recovery committed checkpoint has an invalid plan or stable executable")
			}
			if planValid {
				validStatus := plan.Status == "acknowledged" || plan.Status == "committed"
				if journal.Phase == recoveryTakeoverCommitted {
					validStatus = plan.Status == "committed"
				}
				if !validStatus || !plan.Activated || !plan.Acknowledged {
					return errors.New("current recovery committed checkpoint has an invalid plan or stable executable")
				}
			} else {
				if err := validateSupersededRecoveryPlanConfiguration(plan, journal); err != nil {
					return err
				}
				plan.Activated = true
				plan.Acknowledged = true
			}
			if !planValid || plan.Status != "committed" || journal.Phase != recoveryTakeoverCommitted {
				plan.Status = "committed"
				plan.UpdatedAt = m.now()
				if err := validateRecoveryPlanOwnership(plan, journal); err != nil {
					return fmt.Errorf("validate reconstructed current recovery commit plan: %w", err)
				}
				if err := persistActivationPlan(plan.PlanPath, plan); err != nil {
					return fmt.Errorf("complete current recovery committed plan: %w", err)
				}
				if err := persistRecoveryTakeoverTerminalLocked(journal, recoveryTakeoverCommitted); err != nil {
					return fmt.Errorf("complete current recovery committed journal: %w", err)
				}
			}
			if err := m.convergeRecoveryCommitService(ctx, journal); err != nil {
				return err
			}
			phase, completed = recoveryTakeoverCommitted, true
			return nil
		case recoveryStateHasOriginalBase(state, journal) && state.Candidate == nil && state.Activation == nil:
			if journal.Phase == recoveryTakeoverCommitted {
				return errors.New("committed current recovery journal conflicts with rolled-back Manager state")
			}
			if !binaryMatches(journal.InstallPath, journal.OriginalCurrent.SHA256) {
				return errors.New("current recovery rollback checkpoint has an invalid plan or stable executable")
			}
			if planValid {
				if plan.Status == "committed" || journal.Phase == recoveryTakeoverRolledBack && plan.Status != "rolled_back" {
					return errors.New("current recovery rollback checkpoint has an invalid plan or stable executable")
				}
			}
			if !planValid {
				if err := validateSupersededRecoveryPlanConfiguration(plan, journal); err != nil {
					return err
				}
			}
			if !planValid || plan.Status != "rolled_back" || journal.Phase != recoveryTakeoverRolledBack {
				plan.Status = "rolled_back"
				plan.Error = boundRecoveryPlanError(plan.Error)
				plan.UpdatedAt = m.now()
				if err := validateRecoveryPlanOwnership(plan, journal); err != nil {
					return fmt.Errorf("validate reconstructed current recovery rollback plan: %w", err)
				}
				if err := persistActivationPlan(plan.PlanPath, plan); err != nil {
					return fmt.Errorf("complete current recovery rolled-back plan: %w", err)
				}
				if err := persistRecoveryTakeoverTerminalLocked(journal, recoveryTakeoverRolledBack); err != nil {
					return fmt.Errorf("complete current recovery rollback journal: %w", err)
				}
			}
			if err := m.convergeRecoveryRollbackService(ctx, journal); err != nil {
				return err
			}
			phase, completed = recoveryTakeoverRolledBack, true
			return nil
		default:
			if journal.Phase == recoveryTakeoverCommitted || journal.Phase == recoveryTakeoverRolledBack {
				return errors.New("terminal current recovery journal no longer matches its live Manager checkpoint")
			}
			if planReadErr != nil {
				return planReadErr
			}
			return nil
		}
	})
	return phase, completed, err
}

func (m *Manager) convergeRecoveryCommitService(ctx context.Context, journal recoveryTakeoverJournal) error {
	_, state, err := readRecoverySelfUpdateState(journal.ManagerStatePath)
	if err != nil || !recoveryCommittedStateMatches(state, journal) ||
		!binaryMatches(journal.InstallPath, journal.RecoverySHA256) {
		return errors.New("current recovery committed checkpoint is not durable")
	}
	_, plan, err := readRecoveryActivationPlan(journal.RecoveryPlanPath)
	if err != nil || validateRecoveryPlanOwnership(plan, journal) != nil || plan.Status != "committed" ||
		!plan.Activated || !plan.Acknowledged {
		return errors.New("current recovery committed plan is not durable")
	}
	if err := m.setRecoveryUnitEnabled(ctx, journal.UnitName, true); err != nil {
		return fmt.Errorf("restore Manager unit enablement after current recovery commit: %w", err)
	}
	if recoveryManagerIdentityMatches(ctx, journal.SocketPath, journal.ControlTokenFile, journal.RecoveryVersion, journal.RecoverySHA256) &&
		m.verifyRecoveryServiceProcess(ctx, journal.UnitName, journal.RecoverySHA256) == nil {
		return nil
	}
	if err := m.runner().Run(ctx, "systemctl", "--user", "start", journal.UnitName); err != nil {
		return fmt.Errorf("start registered recovery Current after commit: %w", err)
	}
	if err := waitRecoveryManagerIdentity(ctx, journal.SocketPath, journal.ControlTokenFile, journal.RecoveryVersion, journal.RecoverySHA256); err != nil {
		return fmt.Errorf("verify registered recovery Current identity after commit: %w", err)
	}
	if err := m.verifyRecoveryServiceProcess(ctx, journal.UnitName, journal.RecoverySHA256); err != nil {
		return fmt.Errorf("verify registered recovery Current process after commit: %w", err)
	}
	return nil
}

func (m *Manager) convergeRecoveryRollbackService(ctx context.Context, journal recoveryTakeoverJournal) error {
	_, state, err := readRecoverySelfUpdateState(journal.ManagerStatePath)
	if err != nil || !recoveryStateHasOriginalBase(state, journal) ||
		state.Candidate != nil || state.Activation != nil ||
		!binaryMatches(journal.InstallPath, journal.OriginalCurrent.SHA256) {
		return errors.New("current recovery rolled-back checkpoint is not durable")
	}
	_, plan, err := readRecoveryActivationPlan(journal.RecoveryPlanPath)
	if err != nil || validateRecoveryPlanOwnership(plan, journal) != nil || plan.Status != "rolled_back" {
		return errors.New("current recovery rolled-back plan is not durable")
	}
	if err := m.setRecoveryUnitEnabled(ctx, journal.UnitName, true); err != nil {
		return fmt.Errorf("restore Manager unit enablement after current recovery rollback: %w", err)
	}
	if err := m.runner().Run(ctx, "systemctl", "--user", "restart", "--no-block", journal.UnitName); err != nil {
		return fmt.Errorf("restart registered Current after current recovery rollback: %w", err)
	}
	if err := waitRecoveryManagerIdentity(ctx, journal.SocketPath, journal.ControlTokenFile, journal.OriginalCurrent.Version, journal.OriginalCurrent.SHA256); err != nil {
		return fmt.Errorf("verify registered Current identity after current recovery rollback: %w", err)
	}
	if err := m.verifyRecoveryServiceProcess(ctx, journal.UnitName, journal.OriginalCurrent.SHA256); err != nil {
		return fmt.Errorf("verify registered Current process after current recovery rollback: %w", err)
	}
	return nil
}

func validateRecoveryPlatformCurrentIdentity(journal recoveryTakeoverJournal) error {
	data, _, err := readRecoveryRegularFile(journal.PlatformStatePath, recoveryMaxJSONBytes, true)
	if err != nil {
		return fmt.Errorf("read Platform state during current recovery terminal replay: %w", err)
	}
	var state model.ManagerState
	if err := decodeRecoveryJSON(data, &state); err != nil {
		return fmt.Errorf("decode Platform state during current recovery terminal replay: %w", err)
	}
	if state.SchemaVersion != 1 || state.Current == nil || state.Current.ID != journal.PlatformCommit ||
		state.Current.SourceCommit != journal.PlatformCommit || state.Current.ManifestPath != journal.ManifestPath || state.Candidate != nil {
		return errors.New("Platform Current identity changed before current recovery terminal replay")
	}
	manifest, _, err := readRecoveryRegularFile(journal.ManifestPath, 1<<20, true)
	if err != nil || sha256Hex(manifest) != journal.ManifestSHA256 {
		return errors.New("Platform Current manifest changed before current recovery terminal replay")
	}
	return nil
}

func recoveryCommittedStateMatches(state State, journal recoveryTakeoverJournal) bool {
	return state.SchemaVersion == journal.OriginalState.SchemaVersion && state.Current != nil &&
		state.Current.Version == journal.RecoveryVersion && state.Current.SourceCommit == journal.PlatformCommit &&
		state.Current.Path == journal.RecoveryPath && state.Current.SHA256 == journal.RecoverySHA256 &&
		state.Current.PlatformCommitted && !state.Current.VerifiedAt.IsZero() &&
		state.Previous != nil && reflect.DeepEqual(*state.Previous, journal.OriginalCurrent) &&
		state.Candidate == nil && state.Activation == nil
}

func (m *Manager) verifyCommittedRecovery(ctx context.Context, request recoveryActivationRequest, journal recoveryTakeoverJournal) error {
	_, state, err := readRecoverySelfUpdateState(m.StatePath)
	if err != nil {
		return err
	}
	if !recoveryCommittedStateMatches(state, journal) || state.Current.Version != m.RunningVersion ||
		state.Current.SourceCommit != request.platformCommit || state.Current.SHA256 != request.newSHA {
		return errors.New("committed current recovery state does not contain the expected Current/Previous boundary")
	}
	if err := waitRecoveryManagerIdentity(ctx, m.SocketPath, m.ControlTokenFile, m.RunningVersion, request.newSHA); err != nil {
		return fmt.Errorf("verify committed recovery Manager identity: %w", err)
	}
	if err := m.verifyRecoveryServiceProcess(ctx, request.unit, request.newSHA); err != nil {
		return fmt.Errorf("verify committed recovery Manager process: %w", err)
	}
	return nil
}

func restoreRecoveryActivationPrevious(plan Plan, runner Runner, journal recoveryTakeoverJournal) error {
	return restoreRecoveryActivationPreviousOwned(plan, runner, journal, false)
}

// restoreRecoveryActivationPreviousFromVerifiedPlan is used only while the
// recovery watchdog holds the takeover mutation lock and its plan file became
// missing or invalid after a previously verified read.  The takeover journal
// remains the durable owner; the last verified plan may recreate only the
// transaction's exact managed plan as part of the same rollback checkpoint.
func restoreRecoveryActivationPreviousFromVerifiedPlan(plan Plan, runner Runner, journal recoveryTakeoverJournal) error {
	return restoreRecoveryActivationPreviousOwned(plan, runner, journal, true)
}

// completeRecoveryActivationCommitFromVerifiedPlan is used only while the
// recovery watchdog holds the takeover mutation lock and its plan became
// unreadable after the atomic Current promotion. The last verified plan may
// rebuild terminal evidence only when state and stable still prove that exact
// commit; it never moves Current or Previous again.
func completeRecoveryActivationCommitFromVerifiedPlan(plan Plan, journal recoveryTakeoverJournal) error {
	if journal.Phase == recoveryTakeoverRolledBack || recoveryPhaseBefore(journal.Phase, recoveryTakeoverWatchdogOwned) {
		return errors.New("current recovery journal does not own commit reconstruction")
	}
	if err := validateRecoveryPlanOwnership(plan, journal); err != nil {
		return fmt.Errorf("validate last verified recovery plan before commit recreation: %w", err)
	}
	durablePlan := plan
	planData, _, planReadErr := readRecoveryRegularFile(journal.RecoveryPlanPath, recoveryMaxJSONBytes, true)
	if planReadErr == nil {
		var observed Plan
		if decodeErr := decodeRecoveryJSON(planData, &observed); decodeErr == nil {
			if err := validateRecoveryPlanOwnership(observed, journal); err != nil {
				return err
			}
			durablePlan = observed
		}
	} else if !os.IsNotExist(planReadErr) {
		return planReadErr
	}
	if (durablePlan.Status != "acknowledged" && durablePlan.Status != "committed") ||
		!durablePlan.Activated || !durablePlan.Acknowledged {
		return errors.New("last verified recovery plan is not an acknowledged commit checkpoint")
	}
	_, state, err := readRecoverySelfUpdateState(journal.ManagerStatePath)
	if err != nil {
		return err
	}
	if !recoveryCommittedStateMatches(state, journal) || !binaryMatches(journal.InstallPath, journal.RecoverySHA256) {
		return errors.New("lost recovery plan does not match the committed Manager checkpoint")
	}
	durablePlan.Status = "committed"
	durablePlan.UpdatedAt = time.Now().UTC()
	if err := persistActivationPlan(durablePlan.PlanPath, durablePlan); err != nil {
		return fmt.Errorf("recreate committed current recovery plan: %w", err)
	}
	if err := persistRecoveryTakeoverTerminalLocked(journal, recoveryTakeoverCommitted); err != nil {
		return fmt.Errorf("complete committed current recovery journal: %w", err)
	}
	return nil
}

func restoreRecoveryActivationPreviousOwned(plan Plan, runner Runner, journal recoveryTakeoverJournal, allowPlanRecreate bool) error {
	plan.Error = boundRecoveryPlanError(plan.Error)
	previous, _, err := readRecoveryRegularFile(journal.OriginalCurrent.Path, recoveryMaxBinaryBytes, false)
	if err != nil || sha256Hex(previous) != journal.OriginalCurrent.SHA256 || plan.PreviousPath != journal.OriginalCurrent.Path {
		return errors.New("current recovery rollback Current executable is invalid")
	}
	durablePlan := plan
	planData, _, planReadErr := readRecoveryRegularFile(journal.RecoveryPlanPath, recoveryMaxJSONBytes, true)
	if planReadErr == nil {
		var observed Plan
		if decodeErr := decodeRecoveryJSON(planData, &observed); decodeErr == nil {
			if err := validateRecoveryPlanOwnership(observed, journal); err != nil {
				return err
			}
			durablePlan = observed
		} else if !allowPlanRecreate {
			return decodeErr
		}
	} else if !allowPlanRecreate || !os.IsNotExist(planReadErr) {
		return planReadErr
	}
	if allowPlanRecreate {
		if err := validateRecoveryPlanOwnership(plan, journal); err != nil {
			return fmt.Errorf("validate last verified recovery plan before rollback recreation: %w", err)
		}
		if durablePlan.PlanPath != plan.PlanPath || durablePlan.RecoveryTransactionID != plan.RecoveryTransactionID {
			return errors.New("last verified recovery plan lost takeover ownership")
		}
	}
	if durablePlan.Status == "committed" {
		return errors.New("committed current recovery activation cannot be rolled back")
	}
	_, state, err := readRecoverySelfUpdateState(plan.StatePath)
	if err != nil {
		return err
	}
	rollbackCheckpoint := recoveryStateHasOriginalBase(state, journal) && state.Candidate == nil && state.Activation == nil
	if !rollbackCheckpoint {
		if !recoveryStateHasOriginalBase(state, journal) || !recoveryCandidateMatches(state.Candidate, journal) ||
			!recoveryActivationMatches(state.Activation, journal) {
			return errors.New("current recovery rollback lost conditional state ownership")
		}
	}
	stable, _, err := readRecoveryRegularFile(plan.InstallPath, recoveryMaxBinaryBytes, false)
	if err != nil {
		return err
	}
	stableSHA := sha256Hex(stable)
	if stableSHA != journal.OriginalCurrent.SHA256 {
		if stableSHA != journal.RecoverySHA256 {
			return errors.New("current recovery rollback stable is outside the transaction")
		}
		if err := atomicfile.WriteFile(plan.InstallPath, previous, 0o755); err != nil {
			return fmt.Errorf("restore Current during recovery watchdog rollback: %w", err)
		}
	}
	if !binaryMatches(plan.InstallPath, journal.OriginalCurrent.SHA256) {
		return errors.New("current recovery rollback did not restore registered Current")
	}
	if !rollbackCheckpoint {
		// Re-prove state ownership after the stable mutation. A concurrent writer
		// cannot be allowed to inherit this watchdog's following state write.
		_, latest, readErr := readRecoverySelfUpdateState(plan.StatePath)
		if readErr != nil {
			return readErr
		}
		if !recoveryStateHasOriginalBase(latest, journal) || !recoveryCandidateMatches(latest.Candidate, journal) ||
			!recoveryActivationMatches(latest.Activation, journal) {
			return errors.New("current recovery rollback ownership changed after stable restoration")
		}
		latest.Activation = nil
		// The takeover journal retains the complete failed R identity. Clearing
		// Candidate is the durable failure fence: restarting C must not let normal
		// finalize logic immediately reactivate the same recovery artifact for X.
		latest.Candidate = nil
		latest.UpdatedAt = time.Now().UTC()
		if err := atomicfile.WriteJSON(plan.StatePath, latest, 0o600); err != nil {
			return fmt.Errorf("persist current recovery rollback checkpoint: %w", err)
		}
	}
	_, checkpoint, err := readRecoverySelfUpdateState(plan.StatePath)
	if err != nil || !recoveryStateHasOriginalBase(checkpoint, journal) || checkpoint.Candidate != nil || checkpoint.Activation != nil {
		return errors.New("current recovery rollback state checkpoint was not durable")
	}
	durablePlan.Status = "rolled_back"
	durablePlan.Error = plan.Error
	durablePlan.UpdatedAt = time.Now().UTC()
	if err := persistActivationPlan(durablePlan.PlanPath, durablePlan); err != nil {
		return fmt.Errorf("persist current recovery rollback plan: %w", err)
	}
	if err := persistRecoveryTakeoverTerminalLocked(journal, recoveryTakeoverRolledBack); err != nil {
		return fmt.Errorf("persist current recovery rollback journal: %w", err)
	}
	if err := runner.Run(context.Background(), "systemctl", "--user", "enable", plan.UnitName); err != nil {
		return fmt.Errorf("current recovery rollback was durable but Manager enablement failed: %w", err)
	}
	if err := runner.Run(context.Background(), "systemctl", "--user", "is-enabled", "--quiet", plan.UnitName); err != nil {
		return fmt.Errorf("current recovery rollback could not prove Manager enablement: %w", err)
	}
	if err := runner.Run(context.Background(), "systemctl", "--user", "restart", "--no-block", plan.UnitName); err != nil {
		return fmt.Errorf("current recovery rollback was durable but Current restart failed: %w", err)
	}
	return errors.New(plan.Error)
}

func boundRecoveryPlanError(value string) string {
	if value == "" {
		return "current recovery candidate did not become healthy before its watchdog deadline"
	}
	return value
}
