package selfupdate

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/model"
	"github.com/ubitech/agent-platform/manager/internal/release"
)

const (
	recoveryActivationMode            = "recover_current"
	recoverySupersededStatus          = "superseded_by_recovery"
	recoveryActivationHealthTimeoutMS = 45_000
	recoveryActivationObservationPoll = 100 * time.Millisecond
	recoveryWatchdogUnitPrefix        = "ubitech-agent-manager-watchdog-"
	recoveryCurrentWatchdogUnitPrefix = "ubitech-agent-manager-watchdog-current-recovery-"
)

type recoveryActivationRequest struct {
	executablePath    string
	platformStatePath string
	platformCommit    string
	expectedSHA       string
	newBinary         []byte
	newSHA            string
	unit              string
	originalStateData []byte
	state             State
	oldCurrent        Version
	oldBinary         []byte
}

type recoveryFinalizeEvidence struct {
	stateData     []byte
	operationData []byte
	manifestData  []byte
	state         model.ManagerState
	operation     model.Operation
	manifest      release.Manifest
	operationPath string
	manifestPath  string
}

type recoveryTakeover struct {
	stateData      []byte
	state          State
	planData       []byte
	plan           Plan
	stableSHA      string
	candidate      Version
	watchdogs      []string
	unitWasEnabled bool
}

// recoverCurrentActivation converts a fully proven, stuck normal activation
// into a new standard activation owned by the checksum-verified recovery
// binary. The recovery watchdog remains the sole writer of the final
// Current/Previous transition; this external command only establishes a safe
// rollback checkpoint and observes the standard terminal state.
func (m *Manager) recoverCurrentActivation(ctx context.Context, request recoveryActivationRequest) error {
	if _, err := readRecoveryControlToken(m.ControlTokenFile); err != nil {
		return err
	}
	stagedPath, err := m.stageRecoveryBinary(request.newBinary, request.newSHA)
	if err != nil {
		return err
	}

	evidence, err := readRecoveryFinalizeEvidence(request.platformStatePath, request.platformCommit)
	if err != nil {
		return err
	}
	journalPath := m.recoveryTakeoverJournalPath(request.platformCommit, request.newSHA)
	if journal, exists, journalErr := m.readRecoveryTakeoverJournal(journalPath); journalErr != nil {
		return journalErr
	} else if exists {
		return m.driveRecoveryTakeoverJournal(ctx, request, evidence, journal)
	}

	takeover, err := m.readRecoveryTakeover(request.stateData(), request.state, evidence)
	if err != nil {
		return err
	}
	unitEnabled, err := m.recoveryUnitIsEnabled(ctx, request.unit)
	if err != nil {
		return fmt.Errorf("inspect Manager unit enablement before activation takeover: %w", err)
	}
	if !unitEnabled {
		return errors.New("controlled recovery requires the Manager main unit to be enabled before takeover")
	}
	takeover.unitWasEnabled = true
	if err := m.runner().Run(ctx, "systemctl", "--user", "stop", request.unit); err != nil {
		return fmt.Errorf("stop Manager before activation takeover: %w", err)
	}
	restartOnError := true
	defer func() {
		if restartOnError {
			restartCtx, cancel := context.WithTimeout(context.Background(), recoveryRollbackTime)
			defer cancel()
			_ = m.runner().Run(restartCtx, "systemctl", "--user", "start", request.unit)
		}
	}()
	if err := m.quiesceRecoveryUnits(ctx, request.unit, takeover.watchdogs, takeover.plan.PlanPath); err != nil {
		return err
	}

	// Stopping an active watchdog is a synchronization boundary, not proof that
	// its final write lost the race. Re-read and classify the durable state.
	latestEvidence, err := readRecoveryFinalizeEvidence(request.platformStatePath, request.platformCommit)
	if err != nil {
		return fmt.Errorf("revalidate Platform finalize state after quiescing Manager: %w", err)
	}
	if !sameRecoveryFinalize(evidence, latestEvidence) {
		return errors.New("Platform finalize state changed while Manager activation was quiesced")
	}
	latestStateData, latestState, err := readRecoverySelfUpdateState(m.StatePath)
	if err != nil {
		return fmt.Errorf("re-read Manager state after quiescing activation: %w", err)
	}
	latestEnabled, err := m.recoveryUnitIsEnabled(ctx, request.unit)
	if err != nil || latestEnabled != takeover.unitWasEnabled {
		if err == nil {
			err = errors.New("Manager unit enablement changed while activation was quiesced")
		}
		return err
	}

	switch {
	case bytes.Equal(latestStateData, takeover.stateData):
		latestTakeover, validateErr := m.readRecoveryTakeover(latestStateData, latestState, latestEvidence)
		if validateErr != nil {
			return fmt.Errorf("revalidate activation after quiescing watchdog: %w", validateErr)
		}
		if latestTakeover.plan.PlanPath != takeover.plan.PlanPath || sha256Hex(latestTakeover.planData) != sha256Hex(takeover.planData) {
			return errors.New("Manager activation plan changed while its watchdog was quiesced")
		}
		latestTakeover.unitWasEnabled = takeover.unitWasEnabled
		journal, journalErr := m.newRecoveryTakeoverJournal(request, latestEvidence, *latestTakeover, stagedPath)
		if journalErr != nil {
			return journalErr
		}
		if journalErr = m.persistRecoveryTakeoverJournal(journal); journalErr != nil {
			return fmt.Errorf("persist current recovery takeover journal: %w", journalErr)
		}
		restartOnError = false
		return m.driveRecoveryTakeoverJournal(ctx, request, latestEvidence, journal)
	case latestState.Activation == nil && latestState.Candidate != nil &&
		latestState.Current != nil && latestState.Current.SHA256 == request.oldCurrent.SHA256:
		// The old watchdog won the stop race and completed its normal rollback.
		// Its terminal plan is still required as the audit binding.
		_, _, _, checkpointErr := m.validateRecoveryCheckpoint(latestState, request.platformCommit)
		if checkpointErr != nil {
			return fmt.Errorf("reclassify watchdog rollback checkpoint: %w", checkpointErr)
		}
		journal, journalErr := m.newRecoveryTakeoverJournal(request, latestEvidence, *takeover, stagedPath)
		if journalErr != nil {
			return journalErr
		}
		if journalErr = m.persistRecoveryTakeoverJournal(journal); journalErr != nil {
			return fmt.Errorf("persist current recovery takeover journal: %w", journalErr)
		}
		restartOnError = false
		return m.driveRecoveryTakeoverJournal(ctx, request, latestEvidence, journal)
	case latestState.Activation == nil && latestState.Candidate == nil && latestState.Current != nil &&
		latestState.Current.SourceCommit == request.platformCommit:
		// The old watchdog committed immediately before it was stopped. Continue
		// from that now-authoritative Current rather than writing from the stale
		// pre-stop snapshot.
		currentBinary, _, readErr := readRecoveryRegularFile(latestState.Current.Path, recoveryMaxBinaryBytes, false)
		if readErr != nil || !validSHA256(latestState.Current.SHA256) || sha256Hex(currentBinary) != latestState.Current.SHA256 {
			return errors.New("watchdog committed an invalid Current Manager while recovery was quiescing")
		}
		request.oldCurrent = *latestState.Current
		request.oldBinary = currentBinary
		stable, _, readErr := readRecoveryRegularFile(m.InstallPath, recoveryMaxBinaryBytes, false)
		if readErr != nil || sha256Hex(stable) != request.oldCurrent.SHA256 {
			return errors.New("watchdog commit did not leave stable at the new registered Current")
		}
		return errors.New("ordinary watchdog committed while recovery was quiescing; rerun recover-current against the reclassified Current state")
	default:
		return errors.New("Manager self-update state changed to an unrecognized state while activation was quiesced")
	}
}

func (r recoveryActivationRequest) stateData() []byte {
	return r.originalStateData
}

func readRecoveryFinalizeEvidence(path, expectedCommit string) (recoveryFinalizeEvidence, error) {
	var evidence recoveryFinalizeEvidence
	data, _, err := readRecoveryRegularFile(path, recoveryMaxJSONBytes, true)
	if err != nil {
		return evidence, fmt.Errorf("read Platform Manager journal: %w", err)
	}
	if err := decodeRecoveryJSON(data, &evidence.state); err != nil {
		return evidence, fmt.Errorf("decode Platform Manager journal: %w", err)
	}
	state := evidence.state
	if state.SchemaVersion != 1 || state.Current == nil || state.Current.ID != expectedCommit || state.Current.SourceCommit != expectedCommit || !validSourceCommit(expectedCommit) {
		return evidence, errors.New("Platform Current does not match the Manager activation source commit")
	}
	if state.Candidate != nil || state.ActiveOperationID != "" || !state.Maintenance || state.PublicState != model.StateUpdating || state.Phase != "" {
		return evidence, errors.New("Platform is not at the committed finalize-pending maintenance boundary")
	}
	if !validRecoveryOperationID(state.FinalizePendingOperationID) {
		return evidence, errors.New("Platform has no valid finalize-pending operation")
	}
	operationPath := filepath.Join(filepath.Dir(path), "operations", state.FinalizePendingOperationID+".json")
	operationData, _, err := readRecoveryRegularFile(operationPath, recoveryMaxJSONBytes, true)
	if err != nil {
		return evidence, fmt.Errorf("read finalize-pending operation: %w", err)
	}
	if err := decodeRecoveryJSON(operationData, &evidence.operation); err != nil {
		return evidence, fmt.Errorf("decode finalize-pending operation: %w", err)
	}
	op := evidence.operation
	if op.SchemaVersion != 1 || op.ID != state.FinalizePendingOperationID ||
		(op.Kind != model.OperationInstall && op.Kind != model.OperationUpdate) ||
		op.Status != model.OperationSucceeded || op.Finalized || op.TargetGeneration != expectedCommit || op.CompletedAt == nil ||
		op.Phase != model.PhaseCommitting || op.ReservationStatus != model.ReservationMutationStarted || op.ReservationReleased ||
		op.CreatedAt.IsZero() || op.UpdatedAt.Before(op.CreatedAt) || op.CompletedAt.Before(op.UpdatedAt) ||
		op.SnapshotPath != state.Current.RollbackSnapshotPath || !state.Current.ActivatedAt.Equal(*op.CompletedAt) {
		return evidence, errors.New("finalize-pending operation is not a succeeded unfinalized install/update for Platform Current")
	}
	manifestPath := filepath.Join(filepath.Dir(path), "releases", expectedCommit, "manifest.json")
	if state.Current.ManifestPath != manifestPath {
		return evidence, errors.New("Platform Current manifest path is outside the managed release directory")
	}
	manifestData, _, err := readRecoveryRegularFile(manifestPath, 1<<20, true)
	if err != nil {
		return evidence, fmt.Errorf("read Platform Current release manifest: %w", err)
	}
	if err := decodeRecoveryJSON(manifestData, &evidence.manifest); err != nil {
		return evidence, fmt.Errorf("decode Platform Current release manifest: %w", err)
	}
	manifest := evidence.manifest
	_, artifactOK := manifest.Manager.Artifacts[runtime.GOARCH]
	if manifest.Validate(manifest.Channel, "linux", runtime.GOARCH) != nil || manifest.SourceCommit != expectedCommit || manifest.Manager.Version == "" || !artifactOK ||
		manifest.DatabaseSchemaVersion != state.Current.DatabaseVersion || !reflect.DeepEqual(manifest.Images, state.Current.Images) {
		return evidence, errors.New("Platform Current release manifest does not match the committed generation")
	}
	evidence.stateData = data
	evidence.operationData = operationData
	evidence.manifestData = manifestData
	evidence.operationPath = operationPath
	evidence.manifestPath = manifestPath
	return evidence, nil
}

func sameRecoveryFinalize(left, right recoveryFinalizeEvidence) bool {
	return left.state.Current != nil && right.state.Current != nil &&
		left.state.Current.ID == right.state.Current.ID &&
		left.state.Current.SourceCommit == right.state.Current.SourceCommit &&
		left.state.ActiveOperationID == right.state.ActiveOperationID &&
		left.state.FinalizePendingOperationID == right.state.FinalizePendingOperationID &&
		left.state.Maintenance == right.state.Maintenance &&
		left.state.PublicState == right.state.PublicState &&
		bytes.Equal(left.operationData, right.operationData) &&
		bytes.Equal(left.manifestData, right.manifestData)
}

func validRecoveryOperationID(value string) bool {
	if len(value) < 4 || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if !(character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' || character == '-' || character == '_') {
			return false
		}
	}
	return true
}

func (m *Manager) readRecoveryTakeover(stateData []byte, state State, evidence recoveryFinalizeEvidence) (*recoveryTakeover, error) {
	if state.Current == nil || state.Candidate == nil || state.Activation == nil {
		return nil, errors.New("controlled activation takeover requires Current, Candidate, and Activation")
	}
	candidate := *state.Candidate
	artifact, artifactOK := evidence.manifest.Manager.Artifacts[runtime.GOARCH]
	if !candidate.PlatformCommitted || candidate.SourceCommit != evidence.manifest.SourceCommit ||
		candidate.Version != evidence.manifest.Manager.Version || !artifactOK || candidate.SHA256 != artifact.SHA256 ||
		!validSourceCommit(candidate.Version) || !validSourceCommit(candidate.SourceCommit) || !validSHA256(candidate.SHA256) {
		return nil, errors.New("Manager Candidate is not the committed Platform Manager candidate")
	}
	if !pathWithin(filepath.Join(m.Root, "versions"), candidate.Path) {
		return nil, errors.New("Manager Candidate path is outside the versions directory")
	}
	candidateBinary, _, err := readRecoveryRegularFile(candidate.Path, recoveryMaxBinaryBytes, false)
	if err != nil || sha256Hex(candidateBinary) != candidate.SHA256 {
		return nil, errors.New("Manager Candidate does not match its immutable executable")
	}
	activation := state.Activation
	if activation.CandidateSHA != candidate.SHA256 || activation.CandidatePath != candidate.Path || activation.PlanPath == "" {
		return nil, errors.New("Manager Activation does not match Candidate")
	}
	if !pathWithin(filepath.Join(m.Root, "activations"), activation.PlanPath) {
		return nil, errors.New("Manager activation plan is outside the activations directory")
	}
	planData, plan, err := readRecoveryActivationPlan(activation.PlanPath)
	if err != nil {
		return nil, err
	}
	if plan.Mode != "" {
		return nil, errors.New("ordinary activation takeover cannot claim a specialized activation plan")
	}
	if err := m.validateRecoveryPlanBinding(plan, state, candidate, evidence.manifest.SourceCommit, false); err != nil {
		return nil, err
	}
	stable, _, err := readRecoveryRegularFile(m.InstallPath, recoveryMaxBinaryBytes, false)
	if err != nil {
		return nil, fmt.Errorf("validate stable Manager during activation takeover: %w", err)
	}
	stableSHA := sha256Hex(stable)
	if stableSHA != state.Current.SHA256 && stableSHA != candidate.SHA256 {
		return nil, errors.New("stable Manager matches neither Current nor the committed Candidate")
	}
	return &recoveryTakeover{
		stateData: stateData,
		state:     state,
		planData:  planData,
		plan:      plan,
		stableSHA: stableSHA,
		candidate: candidate,
		watchdogs: recoveryActivationWatchdogUnits(candidate),
	}, nil
}

func readRecoveryActivationPlan(path string) ([]byte, Plan, error) {
	var plan Plan
	data, _, err := readRecoveryRegularFile(path, recoveryMaxJSONBytes, true)
	if err != nil {
		return nil, plan, fmt.Errorf("read Manager activation plan: %w", err)
	}
	if err := decodeRecoveryJSON(data, &plan); err != nil {
		return nil, plan, fmt.Errorf("decode Manager activation plan: %w", err)
	}
	if plan.SchemaVersion != 1 {
		return nil, plan, fmt.Errorf("unsupported Manager activation plan schema %d", plan.SchemaVersion)
	}
	return data, plan, nil
}

func (m *Manager) validateRecoveryPlanBinding(plan Plan, state State, candidate Version, platformCommit string, owned bool) error {
	unit := m.recoveryUnitName()
	if plan.PlanPath == "" || plan.StatePath != m.StatePath || plan.InstallPath != m.InstallPath ||
		plan.SocketPath != m.SocketPath || plan.ControlTokenFile != m.ControlTokenFile || plan.UnitName != unit ||
		plan.CandidateVersion != candidate.Version || plan.CandidateSHA != candidate.SHA256 ||
		candidate.Path == "" || plan.CandidatePath != candidate.Path || !candidate.PlatformCommitted ||
		!validSourceCommit(platformCommit) || candidate.SourceCommit != platformCommit || plan.PlatformCommit != platformCommit ||
		state.Current == nil || plan.PreviousPath != state.Current.Path {
		return errors.New("Manager activation plan is not bound to the current Manager configuration")
	}
	if owned {
		if plan.Mode != recoveryActivationMode ||
			!validSHA256(plan.RecoveryTransactionID) || !validSHA256(plan.CandidateSHA) || plan.CandidatePath != candidate.Path ||
			plan.PlanPath != m.currentRecoveryPlanPath(platformCommit, candidate.SHA256) ||
			plan.RecoveryJournalPath != m.recoveryTakeoverJournalPath(platformCommit, candidate.SHA256) ||
			plan.SupersededPlanPath == "" || !pathWithin(filepath.Join(m.Root, "activations"), plan.SupersededPlanPath) ||
			!validSHA256(plan.SupersededPlanSHA) {
			return errors.New("current recovery activation plan has an invalid recovery binding")
		}
	} else if plan.Mode != "" ||
		plan.RecoveryTransactionID != "" || plan.RecoveryJournalPath != "" ||
		plan.SupersededPlanPath != "" || plan.SupersededPlanSHA != "" {
		return errors.New("ordinary Manager activation has an invalid Platform binding")
	}
	if plan.HealthTimeoutMS < 1_000 || plan.HealthTimeoutMS > 10*60*1_000 || plan.CreatedAt.IsZero() || plan.UpdatedAt.IsZero() || plan.UpdatedAt.Before(plan.CreatedAt) {
		return errors.New("Manager activation plan has invalid timing fields")
	}
	switch plan.Status {
	case "prepared":
		if plan.Activated || plan.Acknowledged {
			return errors.New("prepared Manager activation has invalid acknowledgement flags")
		}
	case "activated":
		if !plan.Activated || plan.Acknowledged {
			return errors.New("activated Manager activation has invalid acknowledgement flags")
		}
	case "acknowledged":
		if !plan.Activated || !plan.Acknowledged {
			return errors.New("acknowledged Manager activation has invalid flags")
		}
	case "rolled_back", "aborted_before_replace", recoverySupersededStatus:
		if state.Activation != nil && plan.Status != recoverySupersededStatus {
			return errors.New("terminal Manager activation is still active")
		}
	default:
		return fmt.Errorf("unsupported Manager activation status %q", plan.Status)
	}
	if state.Activation != nil {
		if state.Activation.PlanPath != plan.PlanPath || state.Activation.CandidateSHA != plan.CandidateSHA ||
			state.Activation.CandidatePath != candidate.Path || state.Activation.StartedAt.IsZero() ||
			state.Activation.StartedAt.Before(plan.CreatedAt) {
			return errors.New("Manager Activation intent is inconsistent with its plan")
		}
	}
	return nil
}

func recoveryActivationWatchdogUnits(candidate Version) []string {
	return []string{
		recoveryWatchdogUnitPrefix + safeID(candidate.SourceCommit[:12]),
		recoveryWatchdogUnitPrefix + "recovery-" + safeID(candidate.SHA256[:12]),
	}
}

func (m *Manager) quiesceRecoveryUnits(ctx context.Context, mainUnit string, exactUnits []string, planPath string) error {
	if m.RecoveryUnitQuiescer != nil {
		return m.RecoveryUnitQuiescer(ctx, mainUnit, append([]string(nil), exactUnits...), planPath)
	}
	allowed := make(map[string]struct{}, len(exactUnits)*2)
	for _, unit := range exactUnits {
		allowed[unit] = struct{}{}
		allowed[unit+".service"] = struct{}{}
	}
	output, err := exec.CommandContext(ctx, "systemctl", "--user", "list-units", "--all", "--plain", "--no-legend", "--full", recoveryWatchdogUnitPrefix+"*").CombinedOutput()
	if err != nil {
		return fmt.Errorf("enumerate Manager watchdog units: %w: %s", err, strings.TrimSpace(string(output)))
	}
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		if _, ok := allowed[fields[0]]; !ok {
			return fmt.Errorf("unknown Manager watchdog unit %s prevents controlled recovery", fields[0])
		}
	}
	for _, unit := range exactUnits {
		loadState, loadErr := recoverySystemdProperty(ctx, unit, "LoadState")
		if loadErr != nil {
			return loadErr
		}
		if loadState != "not-found" {
			stopOutput, stopErr := exec.CommandContext(ctx, "systemctl", "--user", "stop", unit).CombinedOutput()
			if stopErr != nil {
				return fmt.Errorf("stop Manager watchdog %s: %w: %s", unit, stopErr, strings.TrimSpace(string(stopOutput)))
			}
		}
	}
	for _, unit := range append([]string{mainUnit}, exactUnits...) {
		active, activeErr := recoverySystemdProperty(ctx, unit, "ActiveState")
		if activeErr != nil {
			return activeErr
		}
		pidText, pidErr := recoverySystemdProperty(ctx, unit, "MainPID")
		if pidErr != nil {
			return pidErr
		}
		pid, parseErr := strconv.Atoi(pidText)
		if parseErr != nil {
			return fmt.Errorf("Manager unit %s returned invalid MainPID %q", unit, pidText)
		}
		controlPIDText, controlPIDErr := recoverySystemdProperty(ctx, unit, "ControlPID")
		if controlPIDErr != nil {
			return controlPIDErr
		}
		controlPID, parseControlErr := strconv.Atoi(controlPIDText)
		if parseControlErr != nil {
			return fmt.Errorf("Manager unit %s returned invalid ControlPID %q", unit, controlPIDText)
		}
		controlGroup, groupErr := recoverySystemdProperty(ctx, unit, "ControlGroup")
		if groupErr != nil {
			return groupErr
		}
		if active != "inactive" && active != "failed" || pid != 0 || controlPID != 0 {
			return fmt.Errorf("Manager unit %s did not quiesce: active=%s MainPID=%d ControlPID=%d", unit, active, pid, controlPID)
		}
		if controlGroup != "" && controlGroup != "/" {
			if processPID, found, groupProcessErr := recoveryProcessInControlGroup(controlGroup); groupProcessErr != nil {
				return groupProcessErr
			} else if found {
				return fmt.Errorf("Manager unit %s control group still contains same-identity process %d", unit, processPID)
			}
		}
	}
	if pid, found, processErr := recoveryWatchdogProcess(planPath); processErr != nil {
		return processErr
	} else if found {
		return fmt.Errorf("Manager watchdog process %d still owns activation plan %s", pid, planPath)
	}
	if pid, arguments, found, processErr := recoveryAnyWatchdogProcess(); processErr != nil {
		return processErr
	} else if found {
		return fmt.Errorf("unknown same-identity Manager watchdog process %d prevents controlled recovery: %s", pid, strings.Join(arguments, " "))
	}
	return nil
}

func recoveryProcessInControlGroup(controlGroup string) (int, bool, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0, false, fmt.Errorf("enumerate host processes for control group proof: %w", err)
	}
	for _, entry := range entries {
		pid, parseErr := strconv.Atoi(entry.Name())
		if parseErr != nil || pid <= 1 {
			continue
		}
		status, readErr := os.ReadFile(filepath.Join("/proc", entry.Name(), "status"))
		if readErr != nil || !bytes.Contains(status, []byte("Uid:\t"+strconv.Itoa(os.Getuid())+"\t")) {
			continue
		}
		groups, readErr := os.ReadFile(filepath.Join("/proc", entry.Name(), "cgroup"))
		if readErr == nil && recoveryProcessInExactControlGroup(groups, controlGroup) {
			return pid, true, nil
		}
	}
	return 0, false, nil
}

func recoverySystemdProperty(ctx context.Context, unit, property string) (string, error) {
	output, err := exec.CommandContext(ctx, "systemctl", "--user", "show", unit, "--property="+property, "--value").CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("inspect Manager unit %s %s: %w: %s", unit, property, err, strings.TrimSpace(string(output)))
	}
	return strings.TrimSpace(string(output)), nil
}

func recoveryWatchdogProcess(planPath string) (int, bool, error) {
	pid, arguments, found, err := recoveryAnyWatchdogProcess()
	if err != nil || !found {
		return pid, found, err
	}
	if len(arguments) == 4 && arguments[1] == "self-update-watchdog" && arguments[2] == "--plan" && arguments[3] == planPath {
		return pid, true, nil
	}
	// The first watchdog may be unrelated to planPath; search all processes so
	// integration diagnostics can still identify an exact owner.
	return recoveryWatchdogProcessForPlan(planPath)
}

func recoveryAnyWatchdogProcess() (int, []string, bool, error) {
	return scanRecoveryWatchdogProcesses("")
}

func recoveryWatchdogProcessForPlan(planPath string) (int, bool, error) {
	pid, _, found, err := scanRecoveryWatchdogProcesses(planPath)
	return pid, found, err
}

func scanRecoveryWatchdogProcesses(planPath string) (int, []string, bool, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0, nil, false, fmt.Errorf("enumerate host processes: %w", err)
	}
	for _, entry := range entries {
		pid, parseErr := strconv.Atoi(entry.Name())
		if parseErr != nil || pid <= 1 {
			continue
		}
		status, readErr := os.ReadFile(filepath.Join("/proc", entry.Name(), "status"))
		if readErr != nil {
			continue
		}
		uidLine := "Uid:\t" + strconv.Itoa(os.Getuid()) + "\t"
		if !bytes.Contains(status, []byte(uidLine)) {
			continue
		}
		command, readErr := os.ReadFile(filepath.Join("/proc", entry.Name(), "cmdline"))
		if readErr != nil {
			continue
		}
		arguments := strings.Split(strings.TrimRight(string(command), "\x00"), "\x00")
		watchdog := false
		for _, argument := range arguments {
			watchdog = watchdog || argument == "self-update-watchdog"
		}
		if !watchdog {
			continue
		}
		if planPath == "" || len(arguments) == 4 && arguments[1] == "self-update-watchdog" && arguments[2] == "--plan" && arguments[3] == planPath {
			return pid, arguments, true, nil
		}
	}
	return 0, nil, false, nil
}

func (m *Manager) verifyRecoveryWatchdogProcess(ctx context.Context, unit, executablePath, expectedSHA, planPath string) error {
	if m.RecoveryWatchdogVerifier != nil {
		return m.RecoveryWatchdogVerifier(ctx, unit, executablePath, expectedSHA, planPath)
	}
	if !strings.HasPrefix(unit, recoveryCurrentWatchdogUnitPrefix) || !validSHA256(expectedSHA) ||
		unit != recoveryCurrentWatchdogUnitPrefix+safeID(expectedSHA[:12]) {
		return errors.New("current recovery watchdog unit identity is invalid")
	}
	mainPIDText, err := recoverySystemdProperty(ctx, unit, "MainPID")
	if err != nil {
		return err
	}
	controlPIDText, err := recoverySystemdProperty(ctx, unit, "ControlPID")
	if err != nil {
		return err
	}
	controlGroup, err := recoverySystemdProperty(ctx, unit, "ControlGroup")
	if err != nil {
		return err
	}
	mainPID, mainErr := strconv.Atoi(mainPIDText)
	controlPID, controlErr := strconv.Atoi(controlPIDText)
	if mainErr != nil || mainPID <= 1 || controlErr != nil || controlPID != 0 || controlGroup == "" || controlGroup == "/" {
		return errors.New("current recovery watchdog has invalid systemd process metadata")
	}
	processExecutable := filepath.Join("/proc", strconv.Itoa(mainPID), "exe")
	processSHA, err := fileSHA256(processExecutable)
	if err != nil || processSHA != expectedSHA {
		return errors.New("current recovery watchdog executable checksum does not match recovery artifact")
	}
	immutableInfo, err := os.Stat(executablePath)
	if err != nil {
		return err
	}
	processInfo, err := os.Stat(processExecutable)
	if err != nil || !os.SameFile(immutableInfo, processInfo) {
		return errors.New("current recovery watchdog is not executing the immutable recovery inode")
	}
	commandData, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(mainPID), "cmdline"))
	if err != nil {
		return fmt.Errorf("read current recovery watchdog command line: %w", err)
	}
	arguments := strings.Split(strings.TrimRight(string(commandData), "\x00"), "\x00")
	if len(arguments) != 4 || arguments[1] != "self-update-watchdog" || arguments[2] != "--plan" || arguments[3] != planPath {
		return errors.New("current recovery watchdog command line does not exactly own the recovery plan")
	}
	cgroupData, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(mainPID), "cgroup"))
	if err != nil || !recoveryProcessInExactControlGroup(cgroupData, controlGroup) {
		return errors.New("current recovery watchdog process is outside its systemd control group")
	}
	return nil
}

func recoveryProcessInExactControlGroup(data []byte, controlGroup string) bool {
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		parts := strings.SplitN(line, ":", 3)
		if len(parts) == 3 && parts[2] == controlGroup {
			return true
		}
	}
	return false
}

func (m *Manager) validateRecoveryCheckpoint(state State, platformCommit string) (State, string, string, error) {
	if state.Current == nil || state.Candidate == nil || state.Activation != nil || state.Candidate.SourceCommit != platformCommit {
		return State{}, "", "", errors.New("Manager state is not a candidate-only rollback checkpoint")
	}
	planPath := filepath.Join(m.Root, "activations", safeID(platformCommit)+".json")
	data, plan, err := readRecoveryActivationPlan(planPath)
	if err != nil {
		return State{}, "", "", err
	}
	if plan.Status != "rolled_back" && plan.Status != "aborted_before_replace" && plan.Status != recoverySupersededStatus {
		return State{}, "", "", errors.New("candidate-only rollback checkpoint has no terminal activation plan")
	}
	if plan.CandidateSHA != state.Candidate.SHA256 || plan.PreviousPath != state.Current.Path {
		return State{}, "", "", errors.New("candidate-only rollback checkpoint does not match its activation plan")
	}
	stable, _, err := readRecoveryRegularFile(m.InstallPath, recoveryMaxBinaryBytes, false)
	if err != nil || sha256Hex(stable) != state.Current.SHA256 {
		return State{}, "", "", errors.New("candidate-only rollback checkpoint stable does not match Current")
	}
	return state, planPath, sha256Hex(data), nil
}

func (m *Manager) currentRecoveryPlanPath(platformCommit, recoverySHA string) string {
	return filepath.Join(m.Root, "activations", "recover-current-"+safeID(platformCommit[:12])+"-"+safeID(recoverySHA[:12])+".json")
}

func (m *Manager) recoveryUnitIsActive(ctx context.Context, unit string) (bool, error) {
	if m.RecoveryUnitActive != nil {
		return m.RecoveryUnitActive(ctx, unit)
	}
	active, err := recoverySystemdProperty(ctx, unit, "ActiveState")
	if err != nil {
		return false, err
	}
	return active == "active" || active == "activating" || active == "reloading", nil
}

func (m *Manager) recoveryUnitIsEnabled(ctx context.Context, unit string) (bool, error) {
	if m.RecoveryUnitEnabled != nil {
		return m.RecoveryUnitEnabled(ctx, unit)
	}
	output, err := exec.CommandContext(ctx, "systemctl", "--user", "is-enabled", unit).CombinedOutput()
	status := strings.TrimSpace(string(output))
	if err == nil && status == "enabled" {
		return true, nil
	}
	if status == "disabled" {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("inspect Manager unit enablement: %w: %s", err, status)
	}
	return false, fmt.Errorf("Manager unit has unsupported enablement state %q", status)
}

func (m *Manager) setRecoveryUnitEnabled(ctx context.Context, unit string, enabled bool) error {
	if m.RecoveryUnitFencer != nil {
		if err := m.RecoveryUnitFencer(ctx, unit, enabled); err != nil {
			return err
		}
	} else {
		action := "disable"
		if enabled {
			action = "enable"
		}
		if err := m.runner().Run(ctx, "systemctl", "--user", action, unit); err != nil {
			return fmt.Errorf("%s Manager unit: %w", action, err)
		}
	}
	actual, err := m.recoveryUnitIsEnabled(ctx, unit)
	if err != nil {
		return err
	}
	if actual != enabled {
		return fmt.Errorf("Manager unit enablement proof failed: enabled=%t, want %t", actual, enabled)
	}
	return nil
}
