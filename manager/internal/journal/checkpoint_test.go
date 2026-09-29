package journal

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
)

func TestCheckpointFailureNeverPublishesHalfTransition(t *testing.T) {
	for _, boundary := range []string{"admission", "phase", "completion", "finalization"} {
		t.Run(boundary, func(t *testing.T) {
			dir := t.TempDir()
			now := time.Unix(100, 0)
			store, err := Open(dir, now)
			if err != nil {
				t.Fatal(err)
			}
			request := model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: "atomic", ExpectedGeneration: store.State().Generation}
			var op model.Operation
			if boundary != "admission" {
				op, _, err = store.Begin(request, now)
				if err != nil {
					t.Fatal(err)
				}
			}
			if boundary == "finalization" {
				_, err = store.Complete(op.ID, true, func(s *model.ManagerState) { s.FinalizePendingOperationID = op.ID; s.Maintenance = true }, "", now)
				if err != nil {
					t.Fatal(err)
				}
			}
			before, err := os.ReadFile(store.checkpointPath)
			if err != nil {
				t.Fatal(err)
			}
			store.beforePersistState = func(model.ManagerState) error { return errors.New("injected checkpoint failure") }
			switch boundary {
			case "admission":
				_, _, err = store.Begin(request, now)
			case "phase":
				_, err = store.SetPhase(op.ID, model.PhaseSnapshotting, model.StateUpdating, true, "snapshot", now)
			case "completion":
				_, err = store.Complete(op.ID, false, nil, "failure", now)
			case "finalization":
				err = store.Finalize(op.ID, model.GateSettlementCommit, now)
			}
			if err == nil {
				t.Fatal("expected injected failure")
			}
			after, _ := os.ReadFile(store.checkpointPath)
			if !bytes.Equal(before, after) {
				t.Fatal("failed transaction published a half transition")
			}
			reopened, err := Open(dir, now)
			if err != nil {
				t.Fatal(err)
			}
			if boundary == "admission" {
				if reopened.State().ActiveOperationID != "" {
					t.Fatal("failed admission owns state")
				}
			} else {
				got, err := reopened.Operation(op.ID)
				if err != nil {
					t.Fatal(err)
				}
				if boundary == "finalization" {
					if got.Finalized || reopened.State().FinalizePendingOperationID != op.ID {
						t.Fatal("failed finalization lost owner")
					}
				} else if got.Status != model.OperationPending || reopened.State().ActiveOperationID != op.ID {
					t.Fatal("failed checkpoint changed operation owner")
				}
			}
		})
	}
}

func TestBridgeMigrationPreservesRollbackFilesAndImportsOnce(t *testing.T) {
	dir := t.TempDir()
	now := time.Unix(100, 0)
	state := model.NewState(now)
	path := filepath.Join(dir, "state.json")
	if err := atomicfile.WriteJSON(path, state, 0o600); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(path)
	store, err := Open(dir, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.MutateState(now, func(s *model.ManagerState) error { s.LastError = "new checkpoint"; return nil }); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("legacy rollback input changed")
	}
	if err = os.WriteFile(path, []byte("invalid legacy bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(dir, now)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.State().LastError != "new checkpoint" {
		t.Fatal("legacy file became a second authority")
	}
	info, err := os.Stat(filepath.Join(dir, "update.json"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("checkpoint permissions: %v %v", info, err)
	}
}

func TestBridgeMigrationOnlyAllowsAuthenticatedInstallingTransition(t *testing.T) {
	for _, scenario := range []string{"settled", "pending", "authenticated", "wrong-target", "second-pending", "rollback", "commit-intent"} {
		t.Run(scenario, func(t *testing.T) {
			dir := t.TempDir()
			now := time.Unix(100, 0)
			target := strings.Repeat("a", 40)
			state := model.NewState(now)
			state.Current = &model.Generation{ID: target, SourceCommit: target, RollbackSnapshotPath: "/private/snapshot"}
			state.Previous = &model.Generation{ID: strings.Repeat("b", 40)}
			op := model.Operation{SchemaVersion: 1, ID: "op_bridge", Kind: model.OperationUpdate, Status: model.OperationSucceeded, Finalized: true, CompletedAt: &now, TargetGeneration: target, SnapshotPath: "/private/snapshot", ReservationStatus: model.ReservationMutationStarted}
			proof := ""
			if scenario != "settled" {
				op.Finalized = false
				state.FinalizePendingOperationID = op.ID
				state.Maintenance = true
			}
			if scenario != "pending" && scenario != "settled" {
				proof = target
			}
			if scenario == "wrong-target" {
				proof = strings.Repeat("c", 40)
			}
			if scenario == "rollback" {
				op.ManagerActivationRollback = true
			}
			if scenario == "commit-intent" {
				op.GateSettlementAction = model.GateSettlementCommit
			}
			if err := os.Mkdir(filepath.Join(dir, "operations"), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := atomicfile.WriteJSON(filepath.Join(dir, "state.json"), state, 0o600); err != nil {
				t.Fatal(err)
			}
			if err := atomicfile.WriteJSON(filepath.Join(dir, "operations", op.ID+".json"), op, 0o600); err != nil {
				t.Fatal(err)
			}
			if scenario == "second-pending" {
				other := op
				other.ID = "op_other"
				if err := atomicfile.WriteJSON(filepath.Join(dir, "operations", other.ID+".json"), other, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			store, err := OpenWithTransition(dir, now, proof)
			allowed := scenario == "settled" || scenario == "authenticated"
			if allowed {
				if err != nil {
					t.Fatal(err)
				}
				got, err := store.Operation(op.ID)
				if err != nil || got.TargetGeneration != target {
					t.Fatalf("lost operation: %#v %v", got, err)
				}
			} else {
				if err == nil {
					t.Fatal("accepted uncertain legacy transition")
				}
				if _, err := os.Stat(filepath.Join(dir, "update.json")); !os.IsNotExist(err) {
					t.Fatal("rejected migration published checkpoint")
				}
			}
		})
	}
}

func TestRejectedProvisionalImportCannotOwnNextBridgeAttempt(t *testing.T) {
	for _, sameTarget := range []bool{false, true} {
		t.Run(fmt.Sprintf("same-target=%t", sameTarget), func(t *testing.T) {
			dir := t.TempDir()
			now := time.Unix(100, 0)
			firstTarget := strings.Repeat("a", 40)
			nextTarget := strings.Repeat("c", 40)
			if sameTarget {
				nextTarget = firstTarget
			}
			state := model.NewState(now)
			state.Current = &model.Generation{ID: firstTarget, SourceCommit: firstTarget, RollbackSnapshotPath: "/snapshot/first"}
			state.Previous = &model.Generation{ID: strings.Repeat("b", 40)}
			state.Maintenance = true
			state.FinalizePendingOperationID = "op_first"
			first := model.Operation{SchemaVersion: 1, ID: "op_first", Kind: model.OperationUpdate,
				Status: model.OperationSucceeded, CompletedAt: &now, TargetGeneration: firstTarget,
				SnapshotPath: "/snapshot/first", ReservationStatus: model.ReservationMutationStarted}
			if err := os.Mkdir(filepath.Join(dir, "operations"), 0o700); err != nil {
				t.Fatal(err)
			}
			publish := func(op model.Operation) {
				t.Helper()
				if err := atomicfile.WriteJSON(filepath.Join(dir, "state.json"), state, 0o600); err != nil {
					t.Fatal(err)
				}
				if err := atomicfile.WriteJSON(filepath.Join(dir, "operations", op.ID+".json"), op, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			publish(first)
			if _, err := OpenWithTransition(dir, now, firstTarget); err != nil {
				t.Fatal(err)
			}
			// N's launcher rejects the child; N restores and settles its own
			// immutable-format records, then installs a fresh operation.
			first.Status, first.Finalized = model.OperationFailed, true
			publish(first)
			next := first
			next.ID, next.TargetGeneration, next.SnapshotPath = "op_next", nextTarget, "/snapshot/next"
			next.Status, next.Finalized = model.OperationSucceeded, false
			state.Generation++
			state.FinalizePendingOperationID = next.ID
			state.Current = &model.Generation{ID: nextTarget, SourceCommit: nextTarget, RollbackSnapshotPath: next.SnapshotPath}
			publish(next)
			before, _ := os.ReadFile(filepath.Join(dir, "update.json"))
			if _, err := Open(dir, now); err == nil {
				t.Fatal("provisional checkpoint accepted without authenticated proof")
			}
			after, _ := os.ReadFile(filepath.Join(dir, "update.json"))
			if !bytes.Equal(before, after) {
				t.Fatal("refused provisional import changed checkpoint")
			}
			store, err := OpenWithTransition(dir, now, nextTarget)
			if err != nil {
				t.Fatal(err)
			}
			if store.State().FinalizePendingOperationID != next.ID || store.State().Current.ID != nextTarget {
				t.Fatal("rejected checkpoint retained the former installing operation")
			}
			old, err := store.Operation(first.ID)
			if err != nil || !old.Finalized || old.Status != model.OperationFailed {
				t.Fatalf("N fallback settlement was not imported: %#v %v", old, err)
			}
			if _, err := store.UpdateOperation(next.ID, func(op *model.Operation) error {
				op.GateSettlementAction = model.GateSettlementCommit
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			// Once launcher-confirmed commit intent is durable, stale N files
			// are never again an authority, even if they later become unreadable.
			if err := os.WriteFile(filepath.Join(dir, "state.json"), []byte("obsolete"), 0o600); err != nil {
				t.Fatal(err)
			}
			reopened, err := Open(dir, now)
			if err != nil || reopened.State().FinalizePendingOperationID != next.ID {
				t.Fatalf("confirmed checkpoint lost authority: %v", err)
			}
		})
	}
}

func TestCheckpointRetentionPreservesReplayHorizonAndRollbackLinks(t *testing.T) {
	dir := t.TempDir()
	now := time.Unix(20000000, 0)
	store, err := Open(dir, now)
	if err != nil {
		t.Fatal(err)
	}
	store.state.Current = &model.Generation{ID: "current", RollbackSnapshotPath: "/snapshot/current"}
	store.state.Previous = &model.Generation{ID: "previous", RollbackSnapshotPath: "/snapshot/previous"}
	for i := range 133 {
		completed := now.Add(-20*24*time.Hour + time.Duration(i)*time.Hour)
		if i == 132 {
			completed = now.Add(-time.Hour)
		}
		id := fmt.Sprintf("op_%03d", i)
		op := model.Operation{SchemaVersion: 1, ID: id, Kind: model.OperationUpdate,
			IdempotencyKey: id, Status: model.OperationFailed, Finalized: true,
			CompletedAt: &completed, CreatedAt: completed, UpdatedAt: completed}
		switch i {
		case 0:
			op.SnapshotPath = "/snapshot/current"
		case 1:
			op.SnapshotPath = "/snapshot/previous"
		case 2:
			op.Status, op.TargetGeneration = model.OperationSucceeded, "current"
		}
		store.records[id] = op
	}
	active, _, err := store.Begin(model.OperationRequest{Kind: model.OperationUpdate,
		IdempotencyKey: "active", ExpectedGeneration: store.State().Generation}, now)
	if err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(dir, now)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"op_000", "op_001", "op_002", "op_005", "op_132", active.ID} {
		if _, err := reopened.Operation(id); err != nil {
			t.Fatalf("retention lost protected operation %s: %v", id, err)
		}
	}
	for _, id := range []string{"op_003", "op_004"} {
		if _, err := reopened.Operation(id); !os.IsNotExist(err) {
			t.Fatalf("expired operation %s was not removed atomically: %v", id, err)
		}
	}
	replay, reused, err := reopened.Begin(model.OperationRequest{Kind: model.OperationUpdate,
		IdempotencyKey: "op_132", ExpectedGeneration: 0}, now)
	if err != nil || !reused || replay.ID != "op_132" {
		t.Fatalf("retained idempotency key lost exact replay: %#v %t %v", replay, reused, err)
	}
}
