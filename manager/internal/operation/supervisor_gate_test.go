package operation

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/journal"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

// Seed the durable boundary after Platform cutover, before the supervisor has
// accepted or rejected the new Manager. Both generations remain recoverable.
func supervisorFinalizeFixture(t *testing.T) (*Orchestrator, string, string, string) {
	t.Helper()
	dir := t.TempDir()
	store, err := journal.Open(filepath.Join(dir, "state"), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	previousID, candidateID := strings.Repeat("a", 40), strings.Repeat("b", 40)
	previousPath := writeRollbackManifest(t, dir, previousID)
	candidatePath := writeRollbackManifest(t, dir, candidateID)
	if _, err := store.MutateState(time.Now(), func(state *model.ManagerState) error {
		state.Current = &model.Generation{ID: previousID, ManifestPath: previousPath}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	op, _, err := store.Begin(model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: "supervisor-gate", ExpectedGeneration: store.State().Generation}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpdateOperation(op.ID, func(value *model.Operation) error {
		value.Status = model.OperationSucceeded
		value.TargetGeneration = candidateID
		value.SnapshotPath = "/snapshots/supervisor-cutover"
		value.ReservationStatus = model.ReservationMutationStarted
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.MutateState(time.Now(), func(state *model.ManagerState) error {
		state.ActiveOperationID = ""
		state.Previous = state.Current
		state.Current = &model.Generation{ID: candidateID, ManifestPath: candidatePath, RollbackSnapshotPath: "/snapshots/supervisor-cutover"}
		state.FinalizePendingOperationID = op.ID
		state.PublicState = model.StateUpdating
		state.Maintenance = true
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return &Orchestrator{Store: store, Engine: &fakeEngine{}, Gate: &scriptedGate{}, Snapshots: &scriptedSnapshot{}, Channel: contract.ReleaseChannel}, op.ID, previousID, candidateID
}

func TestSupervisorUnconfirmedActivationCannotSettlePlatformGate(t *testing.T) {
	for _, acknowledgementError := range []bool{false, true} {
		name := "not-yet-confirmed"
		if acknowledgementError {
			name = "confirmation-unreadable"
		}
		t.Run(name, func(t *testing.T) {
			orchestrator, operationID, _, candidateID := supervisorFinalizeFixture(t)
			selfUpdate := &recordingSelfUpdate{pendingCommitChecks: 1}
			if acknowledgementError {
				selfUpdate.activationErr = errors.New("supervisor confirmation unavailable")
			}
			orchestrator.SelfUpdate = selfUpdate
			gate := orchestrator.Gate.(*scriptedGate)
			committed := 0
			orchestrator.OnCommit = func(release.Manifest) { committed++ }
			if err := orchestrator.RecoverBeforeActivation(context.Background()); err != nil {
				t.Fatal(err)
			}
			if err := orchestrator.Recover(context.Background()); err == nil {
				t.Fatal("unconfirmed supervisor activation unexpectedly finalized")
			}
			state := orchestrator.Store.State()
			op, err := orchestrator.Store.Operation(operationID)
			if err != nil {
				t.Fatal(err)
			}
			if !state.Maintenance || state.FinalizePendingOperationID != operationID || state.Current.ID != candidateID || op.Finalized || op.GateSettlementAction != "" || op.ReservationReleased {
				t.Fatalf("unconfirmed activation lost its closed recovery boundary: state=%#v operation=%#v", state, op)
			}
			if len(gate.releaseIDs) != 0 || committed != 0 {
				t.Fatalf("unconfirmed activation authorized Platform: gate=%#v commits=%d", gate, committed)
			}
			selfUpdate.activationErr = nil
			selfUpdate.pendingCommitChecks = 0
			if err := orchestrator.Recover(context.Background()); err != nil {
				t.Fatal(err)
			}
			state = orchestrator.Store.State()
			op, err = orchestrator.Store.Operation(operationID)
			if err != nil {
				t.Fatal(err)
			}
			if state.Maintenance || state.FinalizePendingOperationID != "" || !op.Finalized || op.GateSettlementAction != model.GateSettlementCommit || committed != 1 {
				t.Fatalf("confirmed activation did not finalize: state=%#v operation=%#v commits=%d", state, op, committed)
			}
			if !reflect.DeepEqual(gate.commitIDs, []string{operationID, operationID}) || len(gate.abortIDs) != 0 {
				t.Fatalf("confirmation settled the wrong reservation: %#v", gate)
			}
		})
	}
}

type supervisorRejectedCoreEngine struct {
	*fakeEngine
	rejectedID string
	probed     []string
}

func (engine *supervisorRejectedCoreEngine) Probe(_ context.Context, manifest release.Manifest) error {
	engine.probed = append(engine.probed, manifest.ID())
	if manifest.ID() == engine.rejectedID {
		return errors.New("candidate Platform core is unhealthy")
	}
	return nil
}

func TestSupervisorFallbackRestoresBeforeProbingUnhealthyCandidate(t *testing.T) {
	orchestrator, operationID, previousID, candidateID := supervisorFinalizeFixture(t)
	engine := &supervisorRejectedCoreEngine{fakeEngine: &fakeEngine{}, rejectedID: candidateID}
	orchestrator.Engine = engine
	orchestrator.SelfUpdate = &recordingSelfUpdate{rolledBack: true}
	gate := orchestrator.Gate.(*scriptedGate)
	snapshots := orchestrator.Snapshots.(*scriptedSnapshot)
	publicReady := false
	orchestrator.PublicProbe = func(context.Context) error {
		if !publicReady {
			return errors.New("public listener failed to start")
		}
		return nil
	}
	gate.onRelease = func(int) {
		if !publicReady || !reflect.DeepEqual(snapshots.restores, []string{"/snapshots/supervisor-cutover"}) {
			t.Fatalf("gate opened before supervised fallback readiness: ready=%v restores=%v", publicReady, snapshots.restores)
		}
	}
	// Candidate preflight must not mistake a rejected core for a healthy boot.
	if err := orchestrator.RecoverBeforeActivation(context.Background()); err == nil || !strings.Contains(err.Error(), "core readiness") {
		t.Fatalf("unhealthy candidate preflight = %v", err)
	}
	if len(gate.releaseIDs) != 0 || len(snapshots.restores) != 0 {
		t.Fatal("candidate preflight settled or restored an unconfirmed generation")
	}
	engine.probed = nil
	if err := orchestrator.RecoverBeforeSupervisorProof(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := orchestrator.ProbeCurrentGeneration(context.Background()); err == nil || !strings.Contains(err.Error(), "public listener failed") {
		t.Fatalf("fallback public startup failure = %v", err)
	}
	held := orchestrator.Store.State()
	pending, err := orchestrator.Store.Operation(operationID)
	if err != nil {
		t.Fatal(err)
	}
	if held.Current.ID != previousID || !held.Maintenance || held.ActiveOperationID != operationID ||
		pending.Status != model.OperationRunning || !pending.SnapshotRestored || pending.Finalized || pending.ReservationReleased ||
		pending.GateSettlementAction != "" || len(gate.releaseIDs) != 0 {
		t.Fatalf("failed fallback boot lost its reservation: state=%#v operation=%#v gate=%#v", held, pending, gate)
	}
	// A later supervised boot resumes the same durable rollback; the restored
	// snapshot is not replayed and even healthy core readiness cannot settle it.
	if err := orchestrator.RecoverBeforeSupervisorProof(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(gate.releaseIDs) != 0 || !orchestrator.Store.State().Maintenance {
		t.Fatal("repeated pre-proof recovery opened the gate")
	}
	publicReady = true
	if err := orchestrator.ProbeCurrentGeneration(context.Background()); err != nil {
		t.Fatal(err)
	}
	// The caller has now received launcher boot proof.
	if err := orchestrator.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := orchestrator.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	state := orchestrator.Store.State()
	op, err := orchestrator.Store.Operation(operationID)
	if err != nil {
		t.Fatal(err)
	}
	if state.Current.ID != previousID || state.Maintenance || state.FinalizePendingOperationID != "" || op.Status != model.OperationFailed || !op.Finalized || !op.SnapshotRestored || !op.ManagerActivationRollback {
		t.Fatalf("fallback did not recover the previous generation: state=%#v operation=%#v", state, op)
	}
	if !reflect.DeepEqual(gate.abortIDs, []string{operationID}) || len(gate.commitIDs) != 0 || !reflect.DeepEqual(engine.probed, []string{previousID, previousID, previousID, previousID, previousID}) {
		t.Fatalf("fallback probed failed core or settled the wrong gate: probes=%v gate=%#v", engine.probed, gate)
	}
}

func TestSupervisorPreProofDefersReservationAndCleanupRecovery(t *testing.T) {
	for _, candidate := range []bool{false, true} {
		for _, checkpoint := range []string{"prepared-cleanup", "confirmation-pending", "confirmed", "release-uncertain", "failed-terminal", "rolling-back"} {
			t.Run(fmt.Sprintf("candidate=%t/%s", candidate, checkpoint), func(t *testing.T) {
				orchestrator, id, _, _ := supervisorFinalizeFixture(t)
				if _, err := orchestrator.Store.UpdateOperation(id, func(op *model.Operation) error {
					op.Status = model.OperationRunning
					op.Phase = model.PhaseRollingBack
					switch checkpoint {
					case "prepared-cleanup":
						op.PreparedCleanupPending = true
					case "confirmation-pending":
						op.ReservationStatus = model.ReservationConfirmationPending
					case "confirmed":
						op.ReservationStatus = model.ReservationConfirmed
					case "release-uncertain":
						op.ReservationStatus = model.ReservationReleaseUncertain
					case "failed-terminal":
						op.Status = model.OperationFailed
						op.Error = "interrupted rollback"
					}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
				if _, err := orchestrator.Store.MutateState(time.Now(), func(state *model.ManagerState) error {
					state.ActiveOperationID = id
					state.FinalizePendingOperationID = ""
					return nil
				}); err != nil {
					t.Fatal(err)
				}
				var err error
				if candidate {
					err = orchestrator.RecoverBeforeActivation(context.Background())
				} else {
					err = orchestrator.RecoverBeforeSupervisorProof(context.Background())
				}
				if err != nil {
					t.Fatal(err)
				}
				state := orchestrator.Store.State()
				op, err := orchestrator.Store.Operation(id)
				if err != nil {
					t.Fatal(err)
				}
				gate := orchestrator.Gate.(*scriptedGate)
				if state.ActiveOperationID != id || !state.Maintenance || op.Finalized || op.ReservationReleased ||
					op.GateSettlementAction != "" || len(gate.releaseIDs) != 0 {
					t.Fatalf("pre-proof recovery settled %s: state=%#v operation=%#v gate=%#v", checkpoint, state, op, gate)
				}
			})
		}
	}
}

func TestGateCommitIntentForbidsSnapshotRollbackAndRecoversForward(t *testing.T) {
	orchestrator, id, _, target := supervisorFinalizeFixture(t)
	orchestrator.SelfUpdate = &recordingSelfUpdate{rolledBack: true}
	op, err := orchestrator.Store.UpdateOperation(id, func(value *model.Operation) error {
		value.GateSettlementAction = model.GateSettlementCommit
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	orchestrator.restoreAfterMaintenance(context.Background(), op, nil, errors.New("commit reply lost"), true)
	snapshots := orchestrator.Snapshots.(*scriptedSnapshot)
	if len(snapshots.restores) != 0 || orchestrator.Store.State().Current.ID != target {
		t.Fatal("uncertain gate commit restored the old database")
	}
	if err := orchestrator.RecoverBeforeSupervisorProof(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := orchestrator.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	op, err = orchestrator.Store.Operation(id)
	if err != nil {
		t.Fatal(err)
	}
	gate := orchestrator.Gate.(*scriptedGate)
	if !op.Finalized || orchestrator.Store.State().Maintenance || len(snapshots.restores) != 0 ||
		!reflect.DeepEqual(gate.commitIDs, []string{id, id}) || len(gate.abortIDs) != 0 {
		t.Fatalf("forward recovery did not settle the same target: op=%#v gate=%#v", op, gate)
	}
}

func TestGateRestartBeforeReceiptIsReconciledBeforeMaintenanceOpens(t *testing.T) {
	orchestrator, id, _, _ := supervisorFinalizeFixture(t)
	orchestrator.SelfUpdate = &recordingSelfUpdate{}
	reserved := true
	gate := &recordingGate{}
	gate.onCommit = func() {
		state, op, err := orchestrator.Store.StateWithReferencedOperation()
		if err != nil || op == nil || op.ID != id || !state.Maintenance {
			t.Fatalf("gate request lost its closed owner: %#v %#v %v", state, op, err)
		}
		reserved = false
		if gate.commits == 1 {
			if op.Finalized {
				t.Fatal("first gate request claimed an unconfirmed receipt")
			}
			// Platform restarts immediately after replying. Its startup sees
			// no finalized receipt yet and reconstructs the reservation.
			reserved = true
		} else if !op.Finalized || op.GateSettlementAction != model.GateSettlementCommit {
			t.Fatal("gate reconciliation preceded its durable receipt")
		}
	}
	orchestrator.Gate = gate
	if err := orchestrator.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	if reserved || orchestrator.Store.State().Maintenance {
		t.Fatal("Manager opened maintenance without releasing the rebooted Platform gate")
	}
}
