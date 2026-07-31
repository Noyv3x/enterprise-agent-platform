//go:build linux

package handoffhelper

import (
	"context"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

type participantObserverFake struct {
	operation       Operation
	now             time.Time
	events          *[]string
	startupRevision uint64
	publicOwned     bool
}

type targetPlatformCommitterFake struct{}

type targetInstallationFake struct {
	events *[]string
}

func (installation targetInstallationFake) EnsureTarget(context.Context, Operation) error {
	if installation.events != nil {
		*installation.events = append(*installation.events, "install:target")
	}
	return nil
}

func (targetInstallationFake) VerifyTarget(context.Context, Operation) error { return nil }
func (installation targetInstallationFake) RemoveTarget(context.Context, Operation) error {
	if installation.events != nil {
		*installation.events = append(*installation.events, "uninstall:target")
	}
	return nil
}

func (targetPlatformCommitterFake) CommitHandoff(_ context.Context, transactionID, generation, binding string) (handoff.TargetPlatformCommit, error) {
	receipt := handoff.TargetPlatformCommit{
		SchemaVersion: 1, OperationID: transactionID, TargetGeneration: generation,
		BindingSHA256: binding, DatabaseSchemaVersion: 1, CommittedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}
	receipt.ReceiptSHA256, _ = handoff.ComputeTargetPlatformCommitSHA256(receipt)
	return receipt, nil
}

func (observer participantObserverFake) Observe(_ context.Context, role ParticipantRole, challenge ParticipantChallenge) (ParticipantObservation, error) {
	if observer.events != nil {
		*observer.events = append(*observer.events, "observe:"+string(role))
	}
	version, commit, digest, socket := observer.operation.Release.TargetManagerVersion,
		observer.operation.Release.BridgeGeneration, observer.operation.Release.TargetManagerSHA256, observer.operation.Target.SocketPath
	if role == ParticipantSource {
		version, commit, digest, socket = observer.operation.Release.PredecessorGeneration,
			observer.operation.Release.PredecessorGeneration, observer.operation.Source.StableSHA256, observer.operation.Source.SocketPath
	}
	result := ParticipantObservation{
		SchemaVersion: participantProtocolSchema, TransactionID: challenge.TransactionID,
		StartupRevision: challenge.Revision, BindingSHA256: challenge.BindingSHA256,
		Role: role, Nonce: challenge.Nonce, ManagerVersion: version, SourceCommit: commit,
		ExecutableSHA256: digest, PID: 111, SocketPath: socket, CoreReady: true,
		PublicListenerOwned: observer.publicOwned,
		IssuedAt:            observer.now,
	}
	if observer.startupRevision != 0 {
		result.StartupRevision = observer.startupRevision
	}
	result.ProofSHA256, _ = ComputeParticipantProof(result)
	return result, nil
}

func TestTargetCommitCheckpointReusesOlderParticipantOrRestartsWithFreshCapability(t *testing.T) {
	root := t.TempDir()
	now := time.Now().UTC()
	operation := Operation{
		TransactionID: "handoff_0123456789abcdef0123456789abcdef", TransactionDirectory: filepath.Join(root, "handoff_0123456789abcdef0123456789abcdef"),
		Revision: 20, BindingSHA256: testProofSHA, CreatedAt: now.Add(-time.Minute), UpdatedAt: now,
		Status: handoff.StatusRunning, DesiredOutcome: handoff.OutcomeForward, Phase: handoff.PhaseTargetCommitPlanned,
		Release: handoff.ReleaseBinding{PredecessorGeneration: testPredecessor, BridgeGeneration: testBridge, TargetManagerVersion: testBridge, TargetManagerSHA256: testTargetSHA},
		Source:  handoff.SourceBinding{Unit: "source.service", UnitPath: filepath.Join(root, "source.service"), StableSHA256: testSourceSHA, SocketPath: filepath.Join(root, "source.sock"), UnitEnabled: true},
		Target:  handoff.TargetBinding{Unit: "target.service", UnitPath: filepath.Join(root, "target.service"), SocketPath: filepath.Join(root, "target.sock")},
	}
	newParticipant := func(units *unitControllerFake, stack *generationStackFake, revision uint64) *ProductionParticipant {
		participant, err := NewProductionParticipant(ProductionParticipantOptions{
			Units: units, Observer: participantObserverFake{operation: operation, now: now, startupRevision: revision},
			SourceStack: &generationStackFake{}, TargetStack: stack,
			SourceManifest: release.Manifest{SourceCommit: testPredecessor}, TargetManifest: release.Manifest{SourceCommit: testBridge},
			TargetCommitter: targetPlatformCommitterFake{}, TargetInstallation: targetInstallationFake{},
			Clock: func() time.Time { return now }, PollInterval: 10 * time.Millisecond,
		})
		if err != nil {
			t.Fatal(err)
		}
		return participant
	}
	request := StartRequest{Operation: operation, Role: ParticipantTarget, Unit: operation.Target.Unit, StableBinary: filepath.Join(root, "target-manager"), TransactionDirectory: operation.TransactionDirectory}

	t.Run("active participant from earlier revision is enabled without restart", func(t *testing.T) {
		units := &unitControllerFake{states: map[string]UnitState{
			operation.Target.Unit: {LoadState: "loaded", ActiveState: "active", UnitFileState: "disabled", FragmentPath: operation.Target.UnitPath, MainPID: 111},
		}}
		stack := &generationStackFake{running: true}
		participant := newParticipant(units, stack, 9)
		if err := participant.ReconcileStarted(context.Background(), request); err != nil {
			t.Fatal(err)
		}
		if units.locatorStarts != 0 || units.states[operation.Target.Unit].UnitFileState != "enabled" || stack.starts != 1 {
			t.Fatalf("commit replay restarted participant or failed enablement: starts=%d state=%+v stack=%d", units.locatorStarts, units.states[operation.Target.Unit], stack.starts)
		}
	})

	t.Run("inactive participant restarts with current revision capability", func(t *testing.T) {
		units := &unitControllerFake{states: map[string]UnitState{
			operation.Target.Unit: {LoadState: "loaded", ActiveState: "inactive", UnitFileState: "disabled", FragmentPath: operation.Target.UnitPath},
		}}
		stack := &generationStackFake{}
		participant := newParticipant(units, stack, operation.Revision)
		if err := participant.Start(context.Background(), request); err != nil {
			t.Fatal(err)
		}
		if units.locatorStarts != 1 || units.states[operation.Target.Unit].UnitFileState != "enabled" || stack.starts != 1 {
			t.Fatalf("commit restart did not consume fresh capability: starts=%d state=%+v stack=%d", units.locatorStarts, units.states[operation.Target.Unit], stack.starts)
		}
	})

	t.Run("future revision proof is rejected", func(t *testing.T) {
		units := &unitControllerFake{states: map[string]UnitState{
			operation.Target.Unit: {LoadState: "loaded", ActiveState: "active", UnitFileState: "enabled", FragmentPath: operation.Target.UnitPath, MainPID: 111},
		}}
		participant := newParticipant(units, &generationStackFake{running: true}, operation.Revision+1)
		if _, err := participant.InspectStarted(context.Background(), request); err == nil {
			t.Fatal("future participant revision was accepted")
		}
	})
}

func TestProductionParticipantStartsRestrictedManagersBeforeRoleBoundFixedStacks(t *testing.T) {
	root := t.TempDir()
	now := time.Now().UTC()
	operation := Operation{
		TransactionID: "handoff_0123456789abcdef0123456789abcdef", Revision: 9,
		BindingSHA256: testProofSHA, CreatedAt: now.Add(-time.Minute), UpdatedAt: now,
		Release: handoff.ReleaseBinding{
			PredecessorGeneration: testPredecessor, BridgeGeneration: testBridge,
			TargetManagerVersion: testBridge, TargetManagerSHA256: testTargetSHA,
		},
		Source: handoff.SourceBinding{
			Unit: "source.service", UnitPath: filepath.Join(root, "source.service"), StableSHA256: testSourceSHA,
			SocketPath: filepath.Join(root, "source.sock"), UnitEnabled: true, CoreNetworkID: "abcdefabcdef",
		},
		Target: handoff.TargetBinding{
			Unit: "target.service", UnitPath: filepath.Join(root, "target.service"), SocketPath: filepath.Join(root, "target.sock"),
		},
	}
	events := []string{}
	units := &unitControllerFake{events: &events, states: map[string]UnitState{
		operation.Source.Unit: {LoadState: "loaded", ActiveState: "inactive", UnitFileState: "disabled", FragmentPath: operation.Source.UnitPath},
		operation.Target.Unit: {LoadState: "loaded", ActiveState: "inactive", UnitFileState: "disabled", FragmentPath: operation.Target.UnitPath},
	}}
	sourceStack := &generationStackFake{name: "source", events: &events}
	targetStack := &generationStackFake{name: "target", events: &events}
	participant, err := NewProductionParticipant(ProductionParticipantOptions{
		Units: units, Observer: participantObserverFake{operation: operation, now: now, events: &events, publicOwned: true},
		SourceStack: sourceStack, TargetStack: targetStack,
		SourceManifest:     release.Manifest{SourceCommit: testPredecessor},
		TargetManifest:     release.Manifest{SourceCommit: testBridge},
		TargetCommitter:    targetPlatformCommitterFake{},
		TargetInstallation: targetInstallationFake{events: &events},
		Clock:              func() time.Time { return now }, PollInterval: 10 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, role := range []ParticipantRole{ParticipantTarget, ParticipantSource} {
		unit, stable := operation.Target.Unit, filepath.Join(root, "target-manager")
		if role == ParticipantSource {
			unit, stable = operation.Source.Unit, filepath.Join(root, "source-manager")
		}
		request := StartRequest{Operation: operation, Role: role, Unit: unit, StableBinary: stable, TransactionDirectory: filepath.Join(root, operation.TransactionID)}
		if err := participant.Start(context.Background(), request); err != nil {
			t.Fatalf("start %s: %v", role, err)
		}
	}
	if sourceStack.starts != 1 || sourceStack.probes != 1 || targetStack.starts != 1 || targetStack.probes != 1 {
		t.Fatalf("fixed stacks source=%d/%d target=%d/%d", sourceStack.starts, sourceStack.probes, targetStack.starts, targetStack.probes)
	}
	want := []string{
		"install:target", "unit:target.service", "observe:target", "stack:target",
		"unit:source.service", "observe:source", "stack:source",
	}
	if !reflect.DeepEqual(events, want) {
		t.Fatalf("participant startup order = %v, want %v", events, want)
	}
	if len(sourceStack.networkProofs) != 1 || sourceStack.networkProofs[0] != operation.Source.CoreNetworkID {
		t.Fatalf("source startup network proofs = %v", sourceStack.networkProofs)
	}
	if err := participant.VerifySourceIdentity(context.Background(), operation); err != nil {
		t.Fatalf("verify restored source identity: %v", err)
	}
	if len(sourceStack.networkProofs) != 2 || sourceStack.networkProofs[1] != operation.Source.CoreNetworkID {
		t.Fatalf("source identity network proofs = %v", sourceStack.networkProofs)
	}
	if err := participant.VerifySourcePublicReady(context.Background(), operation); err != nil {
		t.Fatalf("verify restored source public readiness: %v", err)
	}
	if len(sourceStack.networkProofs) != 3 || sourceStack.networkProofs[2] != operation.Source.CoreNetworkID {
		t.Fatalf("source public-readiness network proofs = %v", sourceStack.networkProofs)
	}
}

func TestProductionParticipantRollbackRemovesTransactionNetworkAfterWriterFenceAndReplays(t *testing.T) {
	root := t.TempDir()
	now := time.Now().UTC()
	operation := Operation{
		TransactionID: "handoff_0123456789abcdef0123456789abcdef", Revision: 9,
		BindingSHA256: testProofSHA, CreatedAt: now.Add(-time.Minute), UpdatedAt: now,
		Release: handoff.ReleaseBinding{
			PredecessorGeneration: testPredecessor, BridgeGeneration: testBridge,
			TargetManagerVersion: testBridge, TargetManagerSHA256: testTargetSHA,
		},
		Source: handoff.SourceBinding{Unit: "source.service", UnitPath: filepath.Join(root, "source.service")},
		Target: handoff.TargetBinding{Unit: "target.service", UnitPath: filepath.Join(root, "target.service"), SocketPath: filepath.Join(root, "target.sock")},
	}
	events := []string{}
	units := &unitControllerFake{states: map[string]UnitState{
		operation.Target.Unit: {LoadState: "loaded", ActiveState: "active", UnitFileState: "disabled", FragmentPath: operation.Target.UnitPath, MainPID: 111},
	}}
	targetStack := &generationStackFake{name: "target", events: &events, running: true}
	participant, err := NewProductionParticipant(ProductionParticipantOptions{
		Units: units, Observer: participantObserverFake{operation: operation, now: now},
		SourceStack: &generationStackFake{}, TargetStack: targetStack,
		SourceManifest: release.Manifest{SourceCommit: testPredecessor}, TargetManifest: release.Manifest{SourceCommit: testBridge},
		TargetCommitter: targetPlatformCommitterFake{}, TargetInstallation: targetInstallationFake{events: &events},
		Clock: func() time.Time { return now }, PollInterval: 10 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		if err := participant.StopTarget(context.Background(), operation); err != nil {
			t.Fatalf("rollback attempt %d: %v", attempt+1, err)
		}
	}
	want := []string{
		"stop:target", "network:target", "uninstall:target",
		"stop:target", "network:target", "uninstall:target",
	}
	if !reflect.DeepEqual(events, want) {
		t.Fatalf("rollback order = %v, want %v", events, want)
	}
	wantRemoval := [2]string{operation.TransactionID, operation.BindingSHA256}
	if len(targetStack.networkRemovals) != 2 || targetStack.networkRemovals[0] != wantRemoval || targetStack.networkRemovals[1] != wantRemoval {
		t.Fatalf("network rollback bindings = %v", targetStack.networkRemovals)
	}
}
