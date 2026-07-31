package handoff

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

var forwardPhases = []Phase{
	PhasePlanned,
	PhaseHelperArmed,
	PhaseAdmissionReserved,
	PhaseWritersStopped,
	PhaseSnapshotReady,
	PhaseSourceFenced,
	PhaseTargetStaged,
	PhaseDataRelocated,
	PhaseTargetStarted,
	PhaseTargetVerified,
	PhaseSourceRetired,
	PhaseTargetCommitPlanned,
	PhaseCommitted,
}

var rollbackPhases = []Phase{
	PhaseRollbackPlanned,
	PhaseTargetStopped,
	PhaseDataRestored,
	PhaseSourceStarted,
	PhaseRolledBack,
}

func phaseIndex(phases []Phase, phase Phase) int {
	for index, candidate := range phases {
		if candidate == phase {
			return index
		}
	}
	return -1
}

func knownPhase(phase Phase) bool {
	return phase == PhaseAborted || phaseIndex(forwardPhases, phase) >= 0 || phaseIndex(rollbackPhases, phase) >= 0
}

func validTransition(from, to Phase) bool {
	if from == to {
		return true
	}
	if fromIndex := phaseIndex(forwardPhases, from); fromIndex >= 0 {
		if fromIndex+1 < len(forwardPhases) && forwardPhases[fromIndex+1] == to {
			return true
		}
		if fromIndex < phaseIndex(forwardPhases, PhaseSourceFenced) && to == PhaseAborted {
			return true
		}
		if fromIndex >= phaseIndex(forwardPhases, PhaseSourceFenced) &&
			fromIndex < phaseIndex(forwardPhases, PhaseTargetCommitPlanned) && to == PhaseRollbackPlanned {
			return true
		}
		return false
	}
	if fromIndex := phaseIndex(rollbackPhases, from); fromIndex >= 0 {
		return fromIndex+1 < len(rollbackPhases) && rollbackPhases[fromIndex+1] == to
	}
	return false
}

// Validate verifies the complete schema, immutable binding digest, phase
// history and every evidence prerequisite. It is run on every disk read and
// immediately before every atomic replacement.
func Validate(j Journal) error {
	if j.SchemaVersion != SchemaVersion {
		return fmt.Errorf("unsupported handoff journal schema %d", j.SchemaVersion)
	}
	if j.Revision == 0 {
		return errors.New("handoff journal revision must be positive")
	}
	if !transactionIDPattern.MatchString(j.TransactionID) {
		return errors.New("handoff transaction id is invalid")
	}
	if !knownPhase(j.Phase) {
		return fmt.Errorf("handoff journal has unknown phase %q", j.Phase)
	}
	if err := validateBinding(j); err != nil {
		return err
	}
	if j.CreatedAt.IsZero() || j.UpdatedAt.IsZero() || j.UpdatedAt.Before(j.CreatedAt) {
		return errors.New("handoff journal timestamps are invalid")
	}
	if len(j.Error) > MaxErrorBytes {
		return errors.New("handoff journal error exceeds its size limit")
	}
	if err := validateHistory(j); err != nil {
		return err
	}
	if err := validateStatus(j); err != nil {
		return err
	}
	if err := validatePhaseEvidence(j); err != nil {
		return err
	}
	return nil
}

func validateHistory(j Journal) error {
	if len(j.History) == 0 || len(j.History) > len(forwardPhases)+len(rollbackPhases)+1 {
		return errors.New("handoff journal history length is invalid")
	}
	if j.History[0].Phase != PhasePlanned || !j.History[0].At.Equal(j.CreatedAt) {
		return errors.New("handoff journal history must begin at planned and created_at")
	}
	previousAt := j.CreatedAt
	for index, event := range j.History {
		if !knownPhase(event.Phase) || event.At.IsZero() || event.At.Before(previousAt) || event.At.After(j.UpdatedAt) {
			return fmt.Errorf("handoff journal history event %d is invalid", index)
		}
		if len(event.Note) > MaxNoteBytes {
			return fmt.Errorf("handoff journal history event %d note exceeds its size limit", index)
		}
		if index > 0 && !validTransition(j.History[index-1].Phase, event.Phase) {
			return fmt.Errorf("illegal handoff phase transition %s -> %s", j.History[index-1].Phase, event.Phase)
		}
		previousAt = event.At
	}
	if j.History[len(j.History)-1].Phase != j.Phase {
		return errors.New("handoff journal phase does not match its history tail")
	}
	return nil
}

func validateStatus(j Journal) error {
	switch j.Status {
	case StatusRunning:
		if j.DesiredOutcome != OutcomeForward || phaseIndex(forwardPhases, j.Phase) < 0 || j.Phase == PhaseCommitted {
			return errors.New("running handoff journal must be on the nonterminal forward path")
		}
	case StatusRecovering:
		if j.DesiredOutcome != OutcomeRollback || phaseIndex(rollbackPhases, j.Phase) < 0 || j.Phase == PhaseRolledBack {
			return errors.New("recovering handoff journal must be on the nonterminal rollback path")
		}
	case StatusCommitted:
		if j.DesiredOutcome != OutcomeForward || j.Phase != PhaseCommitted {
			return errors.New("committed handoff journal has inconsistent outcome or phase")
		}
	case StatusRolledBack:
		if j.DesiredOutcome != OutcomeRollback || j.Phase != PhaseRolledBack {
			return errors.New("rolled-back handoff journal has inconsistent outcome or phase")
		}
	case StatusAborted:
		if j.DesiredOutcome != OutcomeRollback || j.Phase != PhaseAborted {
			return errors.New("aborted handoff journal has inconsistent outcome or phase")
		}
	default:
		return fmt.Errorf("handoff journal has unknown status %q", j.Status)
	}
	if j.Terminal() {
		if j.CompletedAt == nil || j.CompletedAt.IsZero() || j.CompletedAt.Before(j.CreatedAt) || j.CompletedAt.After(j.UpdatedAt) {
			return errors.New("terminal handoff journal has invalid completed_at")
		}
	} else if j.CompletedAt != nil {
		return errors.New("nonterminal handoff journal cannot have completed_at")
	}
	if historyContains(j.History, PhaseSourceFenced) && j.Error != "" && !j.Terminal() && j.Phase != PhaseTargetCommitPlanned {
		if j.Status != StatusRecovering || j.DesiredOutcome != OutcomeRollback || phaseIndex(rollbackPhases, j.Phase) < 0 {
			return errors.New("an error after source_fenced must own a recoverable rollback intent")
		}
	}
	return nil
}

func validatePhaseEvidence(j Journal) error {
	helperReached := historyContains(j.History, PhaseHelperArmed)
	snapshotReached := historyContains(j.History, PhaseSnapshotReady)
	targetVerified := historyContains(j.History, PhaseTargetVerified)
	targetCommitPlanned := historyContains(j.History, PhaseTargetCommitPlanned)

	if helperReached && j.Helper == nil {
		return errors.New("handoff helper evidence is required from helper_armed")
	}
	if j.Helper != nil {
		suffix := strings.TrimPrefix(j.TransactionID, "handoff_")[:12]
		targetProfile := identity.TargetProfile()
		if j.Helper.Unit != targetProfile.DataDirectory+"-namespace-handoff-"+suffix+".service" ||
			!canonicalAbsolutePath(j.Helper.Executable) || !validSHA(j.Helper.UnitSHA256) ||
			!validSHA(j.Helper.SHA256) || !validSHA(j.Helper.ArgvSHA256) ||
			j.Helper.SHA256 != j.Release.TargetManagerSHA256 ||
			!strings.HasPrefix(j.Helper.ControlGroup, "/") {
			return errors.New("handoff helper evidence is invalid or not bound to the transaction")
		}
	}
	if snapshotReached && j.Snapshot == nil {
		return errors.New("handoff snapshot evidence is required from snapshot_ready")
	}
	if j.Snapshot != nil && (!canonicalAbsolutePath(j.Snapshot.Path) || !validSHA(j.Snapshot.ManifestSHA256)) {
		return errors.New("handoff snapshot evidence is invalid")
	}
	if targetVerified && j.TargetAck == nil {
		return errors.New("handoff target acknowledgement is required from target_verified")
	}
	if j.TargetAck != nil {
		if err := validateTargetAck(j, *j.TargetAck); err != nil {
			return err
		}
	}
	if j.Status == StatusCommitted {
		if j.TargetPlatformCommit == nil {
			return errors.New("committed handoff requires target Platform commit evidence")
		}
	} else if j.TargetPlatformCommit != nil {
		return errors.New("target Platform commit evidence is only valid on a committed handoff")
	}
	if j.TargetPlatformCommit != nil {
		if !targetCommitPlanned {
			return errors.New("target Platform commit evidence requires target_commit_planned history")
		}
		if err := validateTargetPlatformCommit(j, *j.TargetPlatformCommit); err != nil {
			return err
		}
	}
	if j.Status == StatusAborted {
		if j.AbortCleanup == nil || !j.AbortCleanup.Complete() {
			return errors.New("aborted handoff journal requires complete cleanup evidence")
		}
		if historyContains(j.History, PhaseSourceFenced) {
			return errors.New("handoff cannot abort after source_fenced")
		}
	} else if j.AbortCleanup != nil && historyContains(j.History, PhaseSourceFenced) {
		return errors.New("handoff abort cleanup cannot be recorded after source_fenced")
	}
	return nil
}

func validateTargetPlatformCommit(j Journal, receipt TargetPlatformCommit) error {
	if receipt.SchemaVersion != 1 || receipt.OperationID != j.TransactionID ||
		receipt.TargetGeneration != j.Release.BridgeGeneration || receipt.BindingSHA256 != j.BindingSHA256 ||
		receipt.DatabaseSchemaVersion != j.Evidence.DatabaseSchemaVersion || receipt.DatabaseSchemaVersion <= 0 ||
		receipt.CommittedAt == "" || !validSHA(receipt.ReceiptSHA256) {
		return errors.New("target Platform commit receipt does not match the handoff binding")
	}
	committedAt, err := time.Parse(time.RFC3339Nano, receipt.CommittedAt)
	if err != nil || committedAt.Location() != time.UTC {
		return errors.New("target Platform commit receipt timestamp is invalid")
	}
	plannedAt, ok := firstPhaseTime(j.History, PhaseTargetCommitPlanned)
	if !ok || committedAt.Before(plannedAt) || committedAt.After(j.UpdatedAt) {
		return errors.New("target Platform commit receipt timestamp is invalid")
	}
	digest, err := ComputeTargetPlatformCommitSHA256(receipt)
	if err != nil || digest != receipt.ReceiptSHA256 {
		return errors.New("target Platform commit receipt digest is invalid")
	}
	return nil
}

func validateTargetAck(j Journal, ack TargetAck) error {
	if ack.ManagerVersion != j.Release.TargetManagerVersion || ack.ExecutableSHA256 != j.Release.TargetManagerSHA256 ||
		ack.SourceCommit != j.Release.BridgeGeneration || ack.SocketPath != j.Target.SocketPath ||
		ack.PID <= 0 || !validSHA(ack.ProofSHA256) || ack.IssuedAt.IsZero() || ack.AutoUpdateCheckAt.IsZero() {
		return errors.New("handoff target acknowledgement does not match the target binding")
	}
	startedAt, ok := firstPhaseTime(j.History, PhaseTargetStarted)
	if !ok || ack.IssuedAt.Before(startedAt) {
		return errors.New("handoff target acknowledgement predates target_started")
	}
	if ack.IssuedAt.After(j.UpdatedAt) || ack.AutoUpdateCheckAt.After(ack.IssuedAt) {
		return errors.New("handoff target acknowledgement timestamps are invalid")
	}
	return nil
}

func historyContains(history []PhaseEvent, phase Phase) bool {
	_, ok := firstPhaseTime(history, phase)
	return ok
}

func firstPhaseTime(history []PhaseEvent, phase Phase) (time.Time, bool) {
	for _, event := range history {
		if event.Phase == phase {
			return event.At, true
		}
	}
	return time.Time{}, false
}

func sameImmutableBinding(left, right Journal) bool {
	return left.SchemaVersion == right.SchemaVersion && left.TransactionID == right.TransactionID &&
		left.BindingSHA256 == right.BindingSHA256 && reflect.DeepEqual(left.Release, right.Release) &&
		reflect.DeepEqual(left.Source, right.Source) && reflect.DeepEqual(left.Target, right.Target) &&
		reflect.DeepEqual(left.Evidence, right.Evidence) && left.CreatedAt.Equal(right.CreatedAt)
}

func validateWriteOnce(before, after Journal) error {
	if err := writeOnce("helper", before.Helper, after.Helper); err != nil {
		return err
	}
	if err := writeOnce("snapshot", before.Snapshot, after.Snapshot); err != nil {
		return err
	}
	if err := writeOnce("target_ack", before.TargetAck, after.TargetAck); err != nil {
		return err
	}
	if err := writeOnce("target_platform_commit", before.TargetPlatformCommit, after.TargetPlatformCommit); err != nil {
		return err
	}
	return writeOnce("abort_cleanup", before.AbortCleanup, after.AbortCleanup)
}

func writeOnce(label string, before, after any) error {
	beforeValue := reflect.ValueOf(before)
	afterValue := reflect.ValueOf(after)
	beforeNil := before == nil || (beforeValue.Kind() == reflect.Ptr && beforeValue.IsNil())
	afterNil := after == nil || (afterValue.Kind() == reflect.Ptr && afterValue.IsNil())
	if beforeNil {
		return nil
	}
	if afterNil || !reflect.DeepEqual(before, after) {
		return fmt.Errorf("handoff %s evidence is write-once", label)
	}
	return nil
}

func validateEvidenceIntroduction(before, after Journal) error {
	if before.Helper == nil && after.Helper != nil && (before.Phase != PhasePlanned || after.Phase != PhasePlanned) {
		return errors.New("handoff helper evidence must be persisted while phase is planned")
	}
	if before.Snapshot == nil && after.Snapshot != nil && (before.Phase != PhaseWritersStopped || after.Phase != PhaseWritersStopped) {
		return errors.New("handoff snapshot evidence must be persisted while phase is writers_stopped")
	}
	if before.TargetAck == nil && after.TargetAck != nil && (before.Phase != PhaseTargetStarted || after.Phase != PhaseTargetStarted) {
		return errors.New("handoff target acknowledgement must be persisted while phase is target_started")
	}
	if before.TargetPlatformCommit == nil && after.TargetPlatformCommit != nil &&
		(before.Phase != PhaseTargetCommitPlanned || after.Phase != PhaseCommitted || after.Status != StatusCommitted) {
		return errors.New("target Platform commit evidence must be persisted with terminal committed")
	}
	if before.AbortCleanup == nil && after.AbortCleanup != nil {
		if phaseIndex(forwardPhases, before.Phase) < 0 || phaseIndex(forwardPhases, before.Phase) >= phaseIndex(forwardPhases, PhaseSourceFenced) ||
			after.Phase != before.Phase || !after.AbortCleanup.Complete() {
			return errors.New("handoff abort cleanup must be complete and persisted before source_fenced")
		}
	}
	return nil
}
