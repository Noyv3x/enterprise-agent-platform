//go:build linux

package handoffhelper

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

type ProductionParticipantOptions struct {
	Units              UnitController
	Observer           ParticipantObserver
	SourceStack        GenerationStack
	TargetStack        GenerationStack
	SourceManifest     release.Manifest
	TargetManifest     release.Manifest
	TargetCommitter    TargetPlatformCommitter
	TargetInstallation TargetInstallationBoundary
	Clock              func() time.Time
	PollInterval       time.Duration
}

// ProductionParticipant is the real systemd + owner-control implementation
// used by the persistent helper. It does not infer ownership from a PID, unit
// name, socket existence, or health page alone.
type ProductionParticipant struct {
	units              UnitController
	observer           ParticipantObserver
	sourceStack        GenerationStack
	targetStack        GenerationStack
	sourceManifest     release.Manifest
	targetManifest     release.Manifest
	targetCommitter    TargetPlatformCommitter
	targetInstallation TargetInstallationBoundary
	clock              func() time.Time
	poll               time.Duration
}

func NewProductionParticipant(options ProductionParticipantOptions) (*ProductionParticipant, error) {
	if options.Units == nil || options.Observer == nil || options.SourceStack == nil || options.TargetStack == nil ||
		options.TargetCommitter == nil || options.TargetInstallation == nil {
		return nil, errors.New("production participant requires systemd, owner-control, and source/target stack boundaries")
	}
	if options.SourceManifest.ID() == "" || options.TargetManifest.ID() == "" {
		return nil, errors.New("production participant requires immutable source and target manifests")
	}
	if options.Clock == nil {
		options.Clock = time.Now
	}
	if options.PollInterval == 0 {
		options.PollInterval = 100 * time.Millisecond
	}
	if options.PollInterval < 10*time.Millisecond || options.PollInterval > time.Second {
		return nil, errors.New("participant poll interval is outside 10ms..1s")
	}
	return &ProductionParticipant{
		units: options.Units, observer: options.Observer, sourceStack: options.SourceStack,
		targetStack: options.TargetStack, sourceManifest: options.SourceManifest,
		targetManifest: options.TargetManifest, targetCommitter: options.TargetCommitter,
		targetInstallation: options.TargetInstallation,
		clock:              options.Clock, poll: options.PollInterval,
	}, nil
}

func (participant *ProductionParticipant) InspectStarted(ctx context.Context, request StartRequest) (bool, error) {
	unitPath := request.Operation.Target.UnitPath
	if request.Role == ParticipantSource {
		unitPath = request.Operation.Source.UnitPath
	}
	state, err := participant.units.Inspect(ctx, request.Unit, unitPath)
	if err != nil {
		return false, err
	}
	if request.Role == ParticipantTarget && state.LoadState == "not-found" && state.ActiveState == "inactive" && state.MainPID == 0 {
		return false, nil
	}
	if state.LoadState != "loaded" {
		return false, errors.New("participant systemd unit is not loaded")
	}
	if request.Role == ParticipantTarget {
		if err := participant.targetInstallation.VerifyTarget(ctx, request.Operation); err != nil {
			return false, fmt.Errorf("verify target host installation: %w", err)
		}
	}
	if state.ActiveState == "inactive" || state.ActiveState == "failed" {
		if state.MainPID != 0 {
			return false, errors.New("inactive participant unit still reports a MainPID")
		}
		return false, nil
	}
	if state.ActiveState != "active" || state.MainPID <= 1 {
		return false, errors.New("participant unit is neither provably inactive nor active")
	}
	observation, err := participant.observe(ctx, request.Operation, request.Role)
	if err != nil {
		return false, fmt.Errorf("active participant did not prove startup ownership: %w", err)
	}
	if observation.StartupRevision == 0 || observation.StartupRevision > request.Operation.Revision || observation.PID != state.MainPID {
		return false, errors.New("active participant proof is newer than this operation or differs from the systemd PID")
	}
	return true, nil
}

func (participant *ProductionParticipant) Start(ctx context.Context, request StartRequest) error {
	unitPath := request.Operation.Target.UnitPath
	if request.Role == ParticipantSource {
		unitPath = request.Operation.Source.UnitPath
		if err := participant.units.Enable(ctx, request.Unit); err != nil {
			return fmt.Errorf("restore source unit enablement: %w", err)
		}
	} else if request.Role == ParticipantTarget {
		if err := participant.targetInstallation.EnsureTarget(ctx, request.Operation); err != nil {
			return fmt.Errorf("install target Manager host identity: %w", err)
		}
		if request.Operation.Phase == handoff.PhaseTargetCommitPlanned {
			if err := participant.units.Enable(ctx, request.Unit); err != nil {
				return fmt.Errorf("enable target Manager at the forward-only commit checkpoint: %w", err)
			}
		}
		state, err := participant.units.Inspect(ctx, request.Unit, unitPath)
		if err != nil {
			return err
		}
		if request.Operation.Phase == handoff.PhaseTargetCommitPlanned {
			if state.UnitFileState != "enabled" {
				return errors.New("target unit is not boot-enabled at the forward-only commit boundary")
			}
		} else if state.UnitFileState == "enabled" {
			return errors.New("target unit became boot-enabled before the commit boundary")
		}
	} else {
		return errors.New("participant start role is invalid")
	}
	if err := participant.units.StartWithLocator(ctx, request.Unit, request.TransactionDirectory); err != nil {
		return err
	}

	ticker := time.NewTicker(participant.poll)
	defer ticker.Stop()
	for {
		started, err := participant.InspectStarted(ctx, request)
		if err == nil && started {
			break
		}
		if err != nil {
			state, stateErr := participant.units.Inspect(ctx, request.Unit, unitPath)
			if stateErr != nil {
				return errors.Join(err, stateErr)
			}
			if state.ActiveState == "failed" || state.ActiveState == "inactive" {
				return err
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
	// Platform startup synchronously reads the Manager owner-control status to
	// restore this transaction's maintenance reservation. The restricted
	// participant must therefore consume its capability and prove its control
	// identity before Compose starts any fixed service.
	return participant.startAndProbeFixed(ctx, request)
}

func (participant *ProductionParticipant) ReconcileStarted(ctx context.Context, request StartRequest) error {
	started, err := participant.InspectStarted(ctx, request)
	if err != nil {
		return err
	}
	if !started {
		return errors.New("participant disappeared while reconciling its fixed generation")
	}
	if request.Role == ParticipantTarget && request.Operation.Phase == handoff.PhaseTargetCommitPlanned {
		if err := participant.units.Enable(ctx, request.Unit); err != nil {
			return fmt.Errorf("enable existing target Manager at the forward-only commit checkpoint: %w", err)
		}
	}
	if err := participant.startAndProbeFixed(ctx, request); err != nil {
		return err
	}
	started, err = participant.InspectStarted(ctx, request)
	if err != nil {
		return err
	}
	if !started {
		return errors.New("participant disappeared after reconciling its fixed generation")
	}
	return nil
}

func (participant *ProductionParticipant) startAndProbeFixed(ctx context.Context, request StartRequest) error {
	stack, manifest := participant.targetStack, participant.targetManifest
	wantGeneration := request.Operation.Release.BridgeGeneration
	if request.Role == ParticipantSource {
		stack, manifest = participant.sourceStack, participant.sourceManifest
		wantGeneration = request.Operation.Release.PredecessorGeneration
	} else if request.Role != ParticipantTarget {
		return errors.New("participant fixed-stack role is invalid")
	}
	if manifest.ID() != wantGeneration || manifest.SourceCommit != wantGeneration {
		return errors.New("participant fixed-stack manifest differs from the journal generation")
	}
	if request.Role == ParticipantSource {
		if err := stack.VerifyCoreNetwork(ctx, request.Operation.Source.CoreNetworkID); err != nil {
			return fmt.Errorf("prove source core network before fixed-stack recovery: %w", err)
		}
	}
	if err := stack.StartFixed(ctx, manifest); err != nil {
		return fmt.Errorf("start %s fixed generation: %w", request.Role, err)
	}
	if err := stack.Probe(ctx, manifest); err != nil {
		return fmt.Errorf("probe %s fixed generation: %w", request.Role, err)
	}
	return nil
}

func (participant *ProductionParticipant) ProbeTarget(ctx context.Context, operation Operation) error {
	if participant.targetManifest.ID() != operation.Release.BridgeGeneration {
		return errors.New("target stack manifest differs from the bridge generation")
	}
	if err := participant.targetStack.Probe(ctx, participant.targetManifest); err != nil {
		return fmt.Errorf("probe target fixed stack: %w", err)
	}
	observation, err := participant.observe(ctx, operation, ParticipantTarget)
	if err != nil {
		return err
	}
	if !observation.CoreReady || observation.PublicListenerOwned {
		return errors.New("target is not core-ready behind the helper-owned public listener")
	}
	return nil
}

func (participant *ProductionParticipant) TargetAcknowledgement(ctx context.Context, operation Operation) (handoff.TargetAck, error) {
	observation, err := participant.observe(ctx, operation, ParticipantTarget)
	if err != nil {
		return handoff.TargetAck{}, err
	}
	if !observation.CoreReady || !observation.ReadyToCommit || observation.PublicListenerOwned || observation.AutoUpdateCheckAt.IsZero() {
		return handoff.TargetAck{}, errors.New("target cannot acknowledge before core, channel, and private-listener readiness")
	}
	return handoff.TargetAck{
		ManagerVersion: observation.ManagerVersion, ExecutableSHA256: observation.ExecutableSHA256,
		SourceCommit: observation.SourceCommit, PID: observation.PID, SocketPath: observation.SocketPath,
		AutoUpdateCheckAt: observation.AutoUpdateCheckAt.UTC(), IssuedAt: observation.IssuedAt.UTC(),
		ProofSHA256: observation.ProofSHA256,
	}, nil
}

func (participant *ProductionParticipant) RetireSource(ctx context.Context, operation Operation) error {
	if err := participant.units.Disable(ctx, operation.Source.Unit); err != nil {
		return err
	}
	state, err := participant.units.Inspect(ctx, operation.Source.Unit, operation.Source.UnitPath)
	if err != nil {
		return err
	}
	if state.ActiveState != "inactive" || state.MainPID != 0 || state.UnitFileState == "enabled" {
		return errors.New("source Manager is not inactive and boot-disabled at retirement")
	}
	return nil
}

func (participant *ProductionParticipant) VerifyTargetCommitBoundary(ctx context.Context, operation Operation) error {
	if err := participant.targetInstallation.VerifyTarget(ctx, operation); err != nil {
		return fmt.Errorf("verify committed target host installation: %w", err)
	}
	target, err := participant.units.Inspect(ctx, operation.Target.Unit, operation.Target.UnitPath)
	if err != nil {
		return err
	}
	if target.ActiveState != "active" || target.MainPID <= 1 || target.UnitFileState == "enabled" {
		return errors.New("target Manager is not active and boot-disabled before the forward-only checkpoint")
	}
	if participant.targetManifest.ID() != operation.Release.BridgeGeneration {
		return errors.New("target commit manifest differs from the bridge generation")
	}
	if err := participant.targetStack.Probe(ctx, participant.targetManifest); err != nil {
		return fmt.Errorf("probe target fixed stack at commit: %w", err)
	}
	source, err := participant.units.Inspect(ctx, operation.Source.Unit, operation.Source.UnitPath)
	if err != nil {
		return err
	}
	if source.ActiveState != "inactive" || source.MainPID != 0 || source.UnitFileState == "enabled" {
		return errors.New("source Manager is not retired at target commit")
	}
	observation, err := participant.observe(ctx, operation, ParticipantTarget)
	if err != nil {
		return err
	}
	// PublicListenerOwned may be false immediately before first transfer or true
	// after a transfer acknowledgement whose phase write was interrupted. The
	// coordinator's phase-aware listener boundary independently proves the exact
	// unique owner before invoking this host check; do not turn that replay window
	// into an unsafe rollback merely because adoption completed first.
	if !observation.CoreReady || !observation.ReadyToCommit {
		return errors.New("target commit proof is incomplete")
	}
	return nil
}

func (participant *ProductionParticipant) CommitTargetPlatform(ctx context.Context, operation Operation) (handoff.TargetPlatformCommit, error) {
	return participant.targetCommitter.CommitHandoff(
		ctx, operation.TransactionID, operation.Release.BridgeGeneration, operation.BindingSHA256,
	)
}

func (participant *ProductionParticipant) StopTarget(ctx context.Context, operation Operation) error {
	state, inspectErr := participant.units.Inspect(ctx, operation.Target.Unit, operation.Target.UnitPath)
	var disableErr, stopErr error
	if inspectErr == nil && state.LoadState == "loaded" {
		disableErr = participant.units.Disable(ctx, operation.Target.Unit)
		stopErr = participant.units.Stop(ctx, operation.Target.Unit)
	} else if inspectErr != nil || state.LoadState != "not-found" || state.ActiveState != "inactive" || state.MainPID != 0 {
		return errors.Join(inspectErr, errors.New("target Manager installation is neither loaded nor provably absent"))
	}
	stackErr := participant.targetStack.StopFixed(ctx)
	if err := errors.Join(disableErr, stopErr, stackErr); err != nil {
		return err
	}
	if err := verifyFixedStackStopped(ctx, participant.targetStack, participant.targetManifest); err != nil {
		return fmt.Errorf("prove target fixed writers stopped: %w", err)
	}
	state, err := participant.units.Inspect(ctx, operation.Target.Unit, operation.Target.UnitPath)
	if err != nil {
		return err
	}
	if state.ActiveState != "inactive" || state.MainPID != 0 || state.UnitFileState == "enabled" {
		return errors.New("target Manager remains active or boot-enabled after fencing")
	}
	if err := participant.targetStack.RemoveTransactionCoreNetwork(ctx, operation.TransactionID, operation.BindingSHA256); err != nil {
		return fmt.Errorf("remove rolled-back target core network: %w", err)
	}
	if err := participant.targetInstallation.RemoveTarget(ctx, operation); err != nil {
		return fmt.Errorf("remove rolled-back target host installation: %w", err)
	}
	return nil
}

func (participant *ProductionParticipant) VerifySourceIdentity(ctx context.Context, operation Operation) error {
	if participant.sourceManifest.ID() != operation.Release.PredecessorGeneration {
		return errors.New("source stack manifest differs from the handoff predecessor")
	}
	if err := participant.sourceStack.VerifyCoreNetwork(ctx, operation.Source.CoreNetworkID); err != nil {
		return fmt.Errorf("reverify restored source core network: %w", err)
	}
	if err := participant.sourceStack.Probe(ctx, participant.sourceManifest); err != nil {
		return fmt.Errorf("probe restored source fixed stack: %w", err)
	}
	observation, err := participant.observe(ctx, operation, ParticipantSource)
	if err != nil {
		return err
	}
	state, err := participant.units.Inspect(ctx, operation.Source.Unit, operation.Source.UnitPath)
	if err != nil {
		return err
	}
	if state.ActiveState != "active" || state.MainPID != observation.PID ||
		(operation.Source.UnitEnabled && state.UnitFileState != "enabled") {
		return errors.New("source Manager systemd identity is not restored")
	}
	return nil
}

func (participant *ProductionParticipant) VerifySourcePublicReady(ctx context.Context, operation Operation) error {
	if err := participant.sourceStack.VerifyCoreNetwork(ctx, operation.Source.CoreNetworkID); err != nil {
		return fmt.Errorf("reverify source core network before public readiness: %w", err)
	}
	observation, err := participant.observe(ctx, operation, ParticipantSource)
	if err != nil {
		return err
	}
	if !observation.CoreReady || !observation.PublicListenerOwned {
		return errors.New("source Manager does not own a ready core and public gateway")
	}
	return nil
}

func (participant *ProductionParticipant) observe(ctx context.Context, operation Operation, role ParticipantRole) (ParticipantObservation, error) {
	challenge, err := newParticipantChallenge(operation, role)
	if err != nil {
		return ParticipantObservation{}, err
	}
	observation, err := participant.observer.Observe(ctx, role, challenge)
	if err != nil {
		return ParticipantObservation{}, err
	}
	if err := participant.validateObservation(operation, challenge, observation); err != nil {
		return ParticipantObservation{}, err
	}
	return observation, nil
}

func (participant *ProductionParticipant) validateObservation(operation Operation, challenge ParticipantChallenge, observation ParticipantObservation) error {
	if observation.SchemaVersion != participantProtocolSchema || observation.TransactionID != challenge.TransactionID ||
		observation.BindingSHA256 != challenge.BindingSHA256 || observation.Role != challenge.Role ||
		observation.Nonce != challenge.Nonce || !participantNoncePattern.MatchString(observation.Nonce) ||
		observation.StartupRevision == 0 || observation.StartupRevision > operation.Revision || observation.PID <= 1 {
		return errors.New("participant observation challenge binding is invalid")
	}
	wantVersion, wantCommit, wantSHA, wantSocket := operation.Release.TargetManagerVersion,
		operation.Release.BridgeGeneration, operation.Release.TargetManagerSHA256, operation.Target.SocketPath
	if challenge.Role == ParticipantSource {
		wantVersion, wantCommit, wantSHA, wantSocket = operation.Release.PredecessorGeneration,
			operation.Release.PredecessorGeneration, operation.Source.StableSHA256, operation.Source.SocketPath
	}
	if observation.ManagerVersion != wantVersion || observation.SourceCommit != wantCommit ||
		observation.ExecutableSHA256 != wantSHA || observation.SocketPath != wantSocket {
		return errors.New("participant observation runtime identity differs from the journal")
	}
	if observation.IssuedAt.IsZero() || observation.IssuedAt.Before(operation.CreatedAt) ||
		observation.IssuedAt.After(participant.clock().UTC().Add(time.Minute)) ||
		(!observation.AutoUpdateCheckAt.IsZero() && observation.AutoUpdateCheckAt.After(observation.IssuedAt)) {
		return errors.New("participant observation timestamps are invalid")
	}
	wantProof, err := ComputeParticipantProof(observation)
	if err != nil || wantProof != observation.ProofSHA256 {
		return errors.New("participant observation proof digest is invalid")
	}
	return nil
}
