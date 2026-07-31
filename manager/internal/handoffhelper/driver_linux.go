//go:build linux

package handoffhelper

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffhost"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffowner"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffstartup"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

var (
	transactionPattern = regexp.MustCompile(`^handoff_[0-9a-f]{32}$`)
)

func New(options Options) (*Driver, error) {
	if options.Runtime == nil || options.Data == nil || options.Participants == nil || options.SourceRelease == nil {
		return nil, errors.New("persistent handoff helper requires runtime, data, participant, and source-release boundaries")
	}
	if err := options.Data.ValidateConfiguration(); err != nil {
		return nil, fmt.Errorf("validate production handoff data transition: %w", errors.Join(ErrDataUnavailable, err))
	}
	if !canonicalAbsolute(options.TransactionDirectory) {
		return nil, errors.New("persistent handoff transaction directory must be canonical and absolute")
	}
	transactionID := filepath.Base(options.TransactionDirectory)
	if !transactionPattern.MatchString(transactionID) {
		return nil, errors.New("persistent handoff transaction directory has an invalid transaction id")
	}
	// NewHelperRouter performs the canonical closed-world binding validation
	// without accepting or opening a Store.
	if _, err := handoffstartup.NewHelperRouter(options.Bindings); err != nil {
		return nil, fmt.Errorf("validate helper startup bindings: %w", err)
	}
	if options.HelperHost == nil {
		options.HelperHost = &handoffhost.LinuxHost{}
	}
	if options.IssuerFactory == nil {
		options.IssuerFactory = realIssuerFactory{}
	}
	if options.CurrentPID == nil {
		options.CurrentPID = os.Getpid
	}
	if options.Clock == nil {
		options.Clock = time.Now
	}
	return &Driver{
		transactionID: transactionID, transactionDirectory: options.TransactionDirectory,
		bindings: options.Bindings, runtime: options.Runtime, data: options.Data,
		participants: options.Participants, sourceRelease: options.SourceRelease, helperHost: options.HelperHost,
		issuerFactory: options.IssuerFactory, currentPID: options.CurrentPID, clock: options.Clock,
	}, nil
}

func (*Driver) Preflight(context.Context, handoffowner.BridgeRequest, identity.Profile, identity.Profile) (handoffowner.PreflightPlan, error) {
	return handoffowner.PreflightPlan{}, ErrSourceOwnerOnly
}

func (*Driver) ArmPersistentHelper(context.Context, handoff.Journal) error { return ErrSourceOwnerOnly }

func (driver *Driver) VerifyPersistentHelper(ctx context.Context, journal handoff.Journal) (handoff.HelperEvidence, error) {
	_, proof, err := driver.proveCurrent(ctx, journal, false)
	if err != nil {
		return handoff.HelperEvidence{}, err
	}
	evidence := evidenceFromProof(proof)
	if journal.Helper != nil && !reflect.DeepEqual(*journal.Helper, evidence) {
		return handoff.HelperEvidence{}, fmt.Errorf("%w: current helper static identity differs from durable journal evidence", ErrOwnership)
	}
	return evidence, nil
}

func (driver *Driver) FinalizePersistentHelper(ctx context.Context, journal handoff.Journal) error {
	if !journal.Terminal() {
		return errors.New("persistent helper cannot finalize before a terminal journal is durable")
	}
	if err := driver.validateJournal(journal); err != nil {
		return err
	}
	if journal.Helper == nil {
		return fmt.Errorf("%w: terminal journal has no helper static identity", ErrOwnership)
	}
	spec, err := driver.resolveSpec(journal)
	if err != nil {
		return err
	}
	proof := staticProofFromEvidence(*journal.Helper, spec)
	proof.MainPID = driver.currentPID()
	// DisableForExit proves the same active PID and static files, removes only
	// boot enablement, and deliberately leaves the calling process running.
	return driver.helperHost.DisableForExit(ctx, spec, proof)
}

// CleanupTerminalHelper is called later by a stable source/target Manager.
// It refuses a nonterminal journal and delegates only to the inactive-only
// host primitive, which can never stop a live helper.
func (driver *Driver) CleanupTerminalHelper(ctx context.Context, journal handoff.Journal) error {
	if !journal.Terminal() || journal.Helper == nil {
		return errors.New("stable helper cleanup requires terminal journal evidence")
	}
	spec, err := driver.resolveSpec(journal)
	if err != nil {
		return err
	}
	if err := driver.validateJournal(journal); err != nil {
		return err
	}
	expected := staticProofFromEvidence(*journal.Helper, spec)
	if !evidenceMatchesSpec(*journal.Helper, spec) {
		return fmt.Errorf("%w: terminal helper evidence differs from its deterministic spec", ErrOwnership)
	}
	result, err := driver.helperHost.RemoveInactive(ctx, handoffhost.RemovalRequest{Spec: spec, ExpectedProof: expected})
	if err != nil {
		return err
	}
	if !result.UnitRemoved || !result.ExecutableRemoved {
		return errors.New("inactive helper cleanup did not remove both exact static artifacts")
	}
	return nil
}

func (driver *Driver) ReserveAdmission(ctx context.Context, journal handoff.Journal) error {
	return driver.run(ctx, journal, []handoff.Phase{handoff.PhaseHelperArmed}, driver.runtime.ReserveAdmission)
}

func (driver *Driver) DrainAndStopWriters(ctx context.Context, journal handoff.Journal) error {
	return driver.run(ctx, journal, []handoff.Phase{handoff.PhaseAdmissionReserved}, driver.runtime.DrainAndStopWriters)
}

func (driver *Driver) CreateSnapshot(ctx context.Context, journal handoff.Journal) (handoff.Snapshot, error) {
	operation, _, _, err := driver.authorize(ctx, journal, handoff.PhaseWritersStopped)
	if err != nil {
		return handoff.Snapshot{}, err
	}
	snapshot, err := driver.runtime.CreateSnapshot(ctx, operation)
	if err != nil {
		return handoff.Snapshot{}, err
	}
	probe := journal
	probe.Snapshot = &snapshot
	if err := handoff.Validate(probe); err != nil {
		return handoff.Snapshot{}, fmt.Errorf("runtime returned invalid snapshot evidence: %w", err)
	}
	if _, _, _, err := driver.authorize(ctx, journal, handoff.PhaseWritersStopped); err != nil {
		return handoff.Snapshot{}, fmt.Errorf("helper ownership changed after snapshot: %w", err)
	}
	return snapshot, nil
}

func (driver *Driver) FenceSource(ctx context.Context, journal handoff.Journal) error {
	return driver.run(ctx, journal, []handoff.Phase{handoff.PhaseSnapshotReady}, driver.runtime.FenceSource)
}

func (driver *Driver) StageTarget(ctx context.Context, journal handoff.Journal) error {
	return driver.run(ctx, journal, []handoff.Phase{handoff.PhaseSourceFenced}, driver.data.StageTarget)
}

func (driver *Driver) TransformData(ctx context.Context, journal handoff.Journal) error {
	return driver.run(ctx, journal, []handoff.Phase{handoff.PhaseTargetStaged}, driver.data.TransformAndPublish)
}

func (driver *Driver) StartTarget(ctx context.Context, journal handoff.Journal, lease handoff.StartupLease) error {
	return driver.startParticipant(ctx, journal, lease, ParticipantTarget, handoff.PhaseDataRelocated, handoff.PhaseTargetCommitPlanned)
}

func (driver *Driver) ProbeTarget(ctx context.Context, journal handoff.Journal) error {
	return driver.run(ctx, journal, []handoff.Phase{handoff.PhaseTargetStarted}, driver.participants.ProbeTarget)
}

func (driver *Driver) TargetAcknowledgement(ctx context.Context, journal handoff.Journal) (handoff.TargetAck, error) {
	operation, _, _, err := driver.authorize(ctx, journal, handoff.PhaseTargetStarted)
	if err != nil {
		return handoff.TargetAck{}, err
	}
	ack, err := driver.participants.TargetAcknowledgement(ctx, operation)
	if err != nil {
		return handoff.TargetAck{}, err
	}
	probe := journal
	probe.TargetAck = &ack
	now := driver.clock().UTC()
	if now.Before(probe.UpdatedAt) {
		now = probe.UpdatedAt
	}
	probe.UpdatedAt = now
	if err := handoff.Validate(probe); err != nil {
		return handoff.TargetAck{}, fmt.Errorf("target returned invalid acknowledgement: %w", err)
	}
	if _, _, _, err := driver.authorize(ctx, journal, handoff.PhaseTargetStarted); err != nil {
		return handoff.TargetAck{}, fmt.Errorf("helper ownership changed after target acknowledgement: %w", err)
	}
	return ack, nil
}

func (driver *Driver) RetireSource(ctx context.Context, journal handoff.Journal) error {
	return driver.run(ctx, journal, []handoff.Phase{handoff.PhaseTargetVerified}, driver.participants.RetireSource)
}

func (driver *Driver) VerifyTargetCommitBoundary(ctx context.Context, journal handoff.Journal) error {
	return driver.run(ctx, journal, []handoff.Phase{handoff.PhaseSourceRetired}, driver.participants.VerifyTargetCommitBoundary)
}

func (driver *Driver) CommitTargetPlatform(ctx context.Context, journal handoff.Journal) (handoff.TargetPlatformCommit, error) {
	operation, _, _, err := driver.authorize(ctx, journal, handoff.PhaseTargetCommitPlanned)
	if err != nil {
		return handoff.TargetPlatformCommit{}, err
	}
	receipt, err := driver.participants.CommitTargetPlatform(ctx, operation)
	if err != nil {
		return handoff.TargetPlatformCommit{}, err
	}
	probe := journal
	probe.TargetPlatformCommit = &receipt
	probe.Phase = handoff.PhaseCommitted
	probe.Status = handoff.StatusCommitted
	committedAt, err := time.Parse(time.RFC3339Nano, receipt.CommittedAt)
	if err != nil || committedAt.Location() != time.UTC {
		return handoff.TargetPlatformCommit{}, errors.New("target returned invalid Platform commit timestamp")
	}
	probe.UpdatedAt = committedAt.UTC()
	if probe.UpdatedAt.Before(journal.UpdatedAt) {
		probe.UpdatedAt = journal.UpdatedAt
	}
	probe.CompletedAt = &probe.UpdatedAt
	probe.History = append(probe.History, handoff.PhaseEvent{Phase: handoff.PhaseCommitted, At: probe.UpdatedAt})
	if err := handoff.Validate(probe); err != nil {
		return handoff.TargetPlatformCommit{}, fmt.Errorf("target returned invalid Platform commit receipt: %w", err)
	}
	if _, _, _, err := driver.authorize(ctx, journal, handoff.PhaseTargetCommitPlanned); err != nil {
		return handoff.TargetPlatformCommit{}, fmt.Errorf("helper ownership changed after target Platform commit: %w", err)
	}
	return receipt, nil
}

func (driver *Driver) StopTarget(ctx context.Context, journal handoff.Journal) error {
	return driver.run(ctx, journal, []handoff.Phase{handoff.PhaseRollbackPlanned}, driver.participants.StopTarget)
}

func (driver *Driver) RestoreData(ctx context.Context, journal handoff.Journal) error {
	return driver.run(ctx, journal, []handoff.Phase{handoff.PhaseTargetStopped}, driver.data.RestoreData)
}

func (driver *Driver) StartSource(ctx context.Context, journal handoff.Journal, lease handoff.StartupLease) error {
	if err := driver.restoreCanonicalSourceRelease(ctx, journal, handoff.PhaseDataRestored); err != nil {
		return err
	}
	return driver.startParticipant(ctx, journal, lease, ParticipantSource, handoff.PhaseDataRestored)
}

func (driver *Driver) RestoreSourceBeforeFence(ctx context.Context, journal handoff.Journal, lease handoff.StartupLease) error {
	phases := []handoff.Phase{
		handoff.PhasePlanned, handoff.PhaseHelperArmed, handoff.PhaseAdmissionReserved,
		handoff.PhaseWritersStopped, handoff.PhaseSnapshotReady,
	}
	operation, _, _, err := driver.authorize(ctx, journal, phases...)
	if err != nil {
		return err
	}
	leased, err := lease.Load()
	if err != nil {
		return fmt.Errorf("read abort source startup lease: %w", err)
	}
	if !reflect.DeepEqual(leased, journal) {
		return fmt.Errorf("%w: abort source startup lease differs from the helper journal", ErrOwnership)
	}
	if err := driver.restoreCanonicalSourceRelease(ctx, journal, phases...); err != nil {
		return err
	}
	operation, _, _, err = driver.authorize(ctx, journal, phases...)
	if err != nil {
		return fmt.Errorf("helper ownership changed after restoring the canonical source release: %w", err)
	}
	if err := driver.runtime.RestoreSourceBeforeFence(ctx, operation, lease); err != nil {
		return err
	}
	if _, _, _, err := driver.authorize(ctx, journal, phases...); err != nil {
		return fmt.Errorf("helper ownership changed after abort source restoration: %w", err)
	}
	return nil
}

func (driver *Driver) ReleaseAdmission(ctx context.Context, journal handoff.Journal) error {
	return driver.run(ctx, journal, []handoff.Phase{
		handoff.PhasePlanned, handoff.PhaseHelperArmed, handoff.PhaseAdmissionReserved,
		handoff.PhaseWritersStopped, handoff.PhaseSnapshotReady, handoff.PhaseSourceStarted,
	}, driver.runtime.ReleaseAdmission)
}

func (driver *Driver) RemoveTargetStaging(ctx context.Context, journal handoff.Journal) error {
	return driver.run(ctx, journal, []handoff.Phase{
		handoff.PhasePlanned, handoff.PhaseHelperArmed, handoff.PhaseAdmissionReserved,
		handoff.PhaseWritersStopped, handoff.PhaseSnapshotReady,
	}, driver.data.RemoveTargetStaging)
}

func (driver *Driver) VerifySourceIdentity(ctx context.Context, journal handoff.Journal) error {
	phases := []handoff.Phase{
		handoff.PhasePlanned, handoff.PhaseHelperArmed, handoff.PhaseAdmissionReserved,
		handoff.PhaseWritersStopped, handoff.PhaseSnapshotReady, handoff.PhaseSourceStarted,
	}
	if err := driver.restoreCanonicalSourceRelease(ctx, journal, phases...); err != nil {
		return err
	}
	return driver.run(ctx, journal, phases, driver.participants.VerifySourceIdentity)
}

func (driver *Driver) restoreCanonicalSourceRelease(ctx context.Context, journal handoff.Journal, phases ...handoff.Phase) error {
	if _, _, _, err := driver.authorize(ctx, journal, phases...); err != nil {
		return err
	}
	if err := driver.sourceRelease.RestoreCanonicalSourceRelease(ctx, journal); err != nil {
		return fmt.Errorf("restore canonical source release: %w", err)
	}
	if _, _, _, err := driver.authorize(ctx, journal, phases...); err != nil {
		return fmt.Errorf("helper ownership changed after restoring the canonical source release: %w", err)
	}
	return nil
}

func (driver *Driver) VerifySourcePublicReady(ctx context.Context, journal handoff.Journal) error {
	return driver.run(ctx, journal, []handoff.Phase{
		handoff.PhasePlanned, handoff.PhaseHelperArmed, handoff.PhaseAdmissionReserved,
		handoff.PhaseWritersStopped, handoff.PhaseSnapshotReady, handoff.PhaseSourceStarted,
	}, driver.participants.VerifySourcePublicReady)
}

func (*Driver) AcquireRuntimeObservationLease(context.Context) (handoffowner.RuntimeObservationLease, error) {
	return nil, ErrSourceOwnerOnly
}

func (driver *Driver) run(ctx context.Context, journal handoff.Journal, phases []handoff.Phase, effect func(context.Context, Operation) error) error {
	operation, _, _, err := driver.authorize(ctx, journal, phases...)
	if err != nil {
		return err
	}
	if err := effect(ctx, operation); err != nil {
		return err
	}
	if _, _, _, err := driver.authorize(ctx, journal, phases...); err != nil {
		return fmt.Errorf("helper ownership changed after %s effect: %w", journal.Phase, err)
	}
	return nil
}

func (driver *Driver) authorize(ctx context.Context, journal handoff.Journal, phases ...handoff.Phase) (Operation, handoffhost.HelperSpec, handoffhost.HelperProof, error) {
	if err := ctx.Err(); err != nil {
		return Operation{}, handoffhost.HelperSpec{}, handoffhost.HelperProof{}, err
	}
	if !phaseAllowed(journal.Phase, phases) {
		return Operation{}, handoffhost.HelperSpec{}, handoffhost.HelperProof{}, fmt.Errorf("%w: got %s", ErrWrongPhase, journal.Phase)
	}
	spec, proof, err := driver.proveCurrent(ctx, journal, true)
	if err != nil {
		return Operation{}, handoffhost.HelperSpec{}, handoffhost.HelperProof{}, err
	}
	return operationFrom(journal, driver.transactionDirectory, proof), spec, proof, nil
}

func (driver *Driver) proveCurrent(ctx context.Context, journal handoff.Journal, requirePersisted bool) (handoffhost.HelperSpec, handoffhost.HelperProof, error) {
	if err := driver.validateJournal(journal); err != nil {
		return handoffhost.HelperSpec{}, handoffhost.HelperProof{}, err
	}
	if requirePersisted && journal.Helper == nil {
		return handoffhost.HelperSpec{}, handoffhost.HelperProof{}, fmt.Errorf("%w: journal has no persisted helper evidence", ErrOwnership)
	}
	spec, err := driver.resolveSpec(journal)
	if err != nil {
		return handoffhost.HelperSpec{}, handoffhost.HelperProof{}, err
	}
	proof, err := driver.helperHost.Inspect(ctx, spec)
	if err != nil {
		return handoffhost.HelperSpec{}, handoffhost.HelperProof{}, fmt.Errorf("prove active persistent helper: %w", err)
	}
	if proof.MainPID != driver.currentPID() {
		return handoffhost.HelperSpec{}, handoffhost.HelperProof{}, fmt.Errorf("%w: systemd helper PID is not the calling process", ErrOwnership)
	}
	if !proofMatchesSpec(proof, spec) {
		return handoffhost.HelperSpec{}, handoffhost.HelperProof{}, fmt.Errorf("%w: helper host proof differs from deterministic spec", ErrOwnership)
	}
	if journal.Helper != nil && !reflect.DeepEqual(*journal.Helper, evidenceFromProof(proof)) {
		return handoffhost.HelperSpec{}, handoffhost.HelperProof{}, fmt.Errorf("%w: helper host static identity differs from persisted evidence", ErrOwnership)
	}
	return spec, proof, nil
}

func (driver *Driver) validateJournal(journal handoff.Journal) error {
	if err := handoff.Validate(journal); err != nil {
		return fmt.Errorf("validate helper-owned journal: %w", err)
	}
	if journal.TransactionID != driver.transactionID || filepath.Base(driver.transactionDirectory) != journal.TransactionID {
		return fmt.Errorf("%w: journal transaction differs from helper directory", ErrOwnership)
	}
	source, target := identity.SourceProfile(), identity.TargetProfile()
	if journal.Source.Namespace != source.ProfileID || journal.Source.Unit != source.ManagerUnit ||
		journal.Source.StableBinary != driver.bindings.Source.StableBinary || journal.Source.ConfigPath != driver.bindings.Source.ConfigPath ||
		journal.Source.DataRoot != driver.bindings.Source.DataRoot || journal.Source.SocketPath != driver.bindings.Source.SocketPath ||
		journal.Target.Namespace != target.ProfileID || journal.Target.Unit != target.ManagerUnit ||
		journal.Target.StableBinary != driver.bindings.Target.StableBinary || journal.Target.ConfigPath != driver.bindings.Target.ConfigPath ||
		journal.Target.DataRoot != driver.bindings.Target.DataRoot ||
		journal.Target.SocketPath != driver.bindings.Target.SocketPath {
		return fmt.Errorf("%w: journal paths differ from immutable startup bindings", ErrOwnership)
	}
	if filepath.Base(journal.Source.UnitPath) != source.ManagerUnit || filepath.Base(journal.Target.UnitPath) != target.ManagerUnit ||
		filepath.Dir(journal.Source.UnitPath) != filepath.Dir(journal.Target.UnitPath) {
		return fmt.Errorf("%w: source and target unit paths are not one bound user-systemd namespace", ErrOwnership)
	}
	return nil
}

func (driver *Driver) resolveSpec(journal handoff.Journal) (handoffhost.HelperSpec, error) {
	helperExecutable := filepath.Join(driver.transactionDirectory, "helper", identity.TargetProfile().ManagerBinary)
	request := handoffhost.ArmRequest{
		TargetProfile: identity.TargetProfile(), TransactionID: journal.TransactionID,
		TransactionDirectory: driver.transactionDirectory, ArtifactPath: helperExecutable,
		ArtifactSHA256: journal.Release.TargetManagerSHA256,
		UnitDirectory:  filepath.Dir(journal.Target.UnitPath),
		JournalPath:    filepath.Join(driver.transactionDirectory, "journal.json"),
	}
	spec, err := driver.helperHost.Resolve(request)
	if err != nil {
		return handoffhost.HelperSpec{}, fmt.Errorf("resolve helper static identity: %w", err)
	}
	if journal.Helper != nil && !evidenceMatchesSpec(*journal.Helper, spec) {
		return handoffhost.HelperSpec{}, fmt.Errorf("%w: journal helper evidence differs from deterministic identity", ErrOwnership)
	}
	return spec, nil
}

func operationFrom(journal handoff.Journal, directory string, proof handoffhost.HelperProof) Operation {
	operation := Operation{
		TransactionID: journal.TransactionID, TransactionDirectory: directory,
		Revision: journal.Revision, BindingSHA256: journal.BindingSHA256, Status: journal.Status,
		DesiredOutcome: journal.DesiredOutcome, Phase: journal.Phase, Release: journal.Release,
		Source: journal.Source, Target: journal.Target, Evidence: journal.Evidence,
		Helper: *journal.Helper, HelperProof: proof, CreatedAt: journal.CreatedAt, UpdatedAt: journal.UpdatedAt,
	}
	if journal.Snapshot != nil {
		copy := *journal.Snapshot
		operation.Snapshot = &copy
	}
	return operation
}

func evidenceFromProof(proof handoffhost.HelperProof) handoff.HelperEvidence {
	return handoff.HelperEvidence{
		Unit: proof.UnitName, UnitSHA256: proof.UnitSHA256,
		Executable: proof.ExecutablePath, SHA256: proof.ExecutableSHA256,
		ArgvSHA256: handoffhost.ArgvSHA256(proof.Argv), ControlGroup: proof.ControlGroup,
	}
}

func staticProofFromEvidence(evidence handoff.HelperEvidence, spec handoffhost.HelperSpec) handoffhost.HelperProof {
	return handoffhost.HelperProof{
		TransactionID: spec.TransactionID, UnitName: spec.UnitName, UnitPath: spec.UnitPath,
		UnitSHA256: spec.UnitSHA256, ExecutablePath: spec.ExecutablePath,
		ExecutableSHA256: spec.ExecutableSHA256, Argv: append([]string(nil), spec.Argv...),
		ControlGroup: evidence.ControlGroup,
	}
}

func evidenceMatchesSpec(evidence handoff.HelperEvidence, spec handoffhost.HelperSpec) bool {
	return evidence.Unit == spec.UnitName && evidence.UnitSHA256 == spec.UnitSHA256 &&
		evidence.Executable == spec.ExecutablePath && evidence.SHA256 == spec.ExecutableSHA256 &&
		evidence.ArgvSHA256 == handoffhost.ArgvSHA256(spec.Argv) && strings.HasPrefix(evidence.ControlGroup, "/")
}

func proofMatchesSpec(proof handoffhost.HelperProof, spec handoffhost.HelperSpec) bool {
	return proof.TransactionID == spec.TransactionID && proof.UnitName == spec.UnitName && proof.UnitPath == spec.UnitPath &&
		proof.UnitSHA256 == spec.UnitSHA256 && proof.ExecutablePath == spec.ExecutablePath &&
		proof.ExecutableSHA256 == spec.ExecutableSHA256 && reflect.DeepEqual(proof.Argv, spec.Argv) &&
		proof.Enabled && proof.Active && proof.MainPID > 1 && strings.HasPrefix(proof.ControlGroup, "/")
}

func phaseAllowed(observed handoff.Phase, allowed []handoff.Phase) bool {
	for _, phase := range allowed {
		if observed == phase {
			return true
		}
	}
	return false
}

func canonicalAbsolute(path string) bool {
	return path != "" && filepath.IsAbs(path) && filepath.Clean(path) == path && !strings.ContainsRune(path, 0)
}

var _ handoffowner.HostDriver = (*Driver)(nil)
