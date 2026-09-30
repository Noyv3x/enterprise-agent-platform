package journal

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

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

func TestCheckpointIsSoleAuthority(t *testing.T) {
	dir := t.TempDir()
	now := time.Unix(100, 0)
	store, err := Open(dir, now)
	if err != nil {
		t.Fatal(err)
	}
	request := model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: "settled", ExpectedGeneration: store.State().Generation}
	op, _, err := store.Begin(request, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Complete(op.ID, true, func(s *model.ManagerState) {
		s.FinalizePendingOperationID = op.ID
		s.Maintenance = true
	}, "", now); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpdateOperation(op.ID, func(op *model.Operation) error {
		op.GateSettlementAction = model.GateSettlementCommit
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	legacy := filepath.Join(dir, "state.json")
	if err := os.WriteFile(legacy, []byte("unreadable legacy state"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "operations"), 0o700); err != nil {
		t.Fatal(err)
	}
	record := filepath.Join(dir, "operations", "op_old.json")
	if err := os.WriteFile(record, []byte("unreadable legacy operation"), 0o600); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(dir, now)
	if err != nil {
		t.Fatal(err)
	}
	got, err := reopened.Operation(op.ID)
	if err != nil || got.GateSettlementAction != model.GateSettlementCommit || reopened.State().FinalizePendingOperationID != op.ID || !reopened.State().Maintenance {
		t.Fatalf("lost forward settlement: %#v %v", got, err)
	}
	replay, reused, err := reopened.Begin(request, now)
	if err != nil || !reused || replay.ID != op.ID {
		t.Fatalf("lost idempotency binding: %#v %t %v", replay, reused, err)
	}
	for path, want := range map[string]string{legacy: "unreadable legacy state", record: "unreadable legacy operation"} {
		data, err := os.ReadFile(path)
		if err != nil || string(data) != want {
			t.Fatalf("legacy input changed: %s %v", path, err)
		}
	}
}

func TestMissingCheckpointRefusesLegacyState(t *testing.T) {
	for _, name := range []string{"state.json", "operations"} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, name)
			if err := os.WriteFile(path, []byte("legacy bytes"), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := Open(dir, time.Now()); err == nil {
				t.Fatal("accepted legacy state without a checkpoint")
			}
			data, err := os.ReadFile(path)
			if err != nil || string(data) != "legacy bytes" {
				t.Fatalf("legacy input changed: %v", err)
			}
			if _, err := os.Stat(filepath.Join(dir, "update.json")); !os.IsNotExist(err) {
				t.Fatal("refusal published a checkpoint")
			}
		})
	}
}

func TestUnsupportedCheckpointNeverFallsBack(t *testing.T) {
	for _, document := range []string{
		`invalid`,
		`{"schema_version":2,"state":{"schema_version":1},"operations":{}}`,
		`{"schema_version":1,"state":{"schema_version":1},"operations":{},"bridge_transition":{"target":"old"}}`,
		`{"schema_version":1,"state":{"schema_version":1},"operations":{},"bridge_transition":null}`,
	} {
		t.Run(document, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "update.json")
			if err := os.WriteFile(path, []byte(document), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := Open(dir, time.Now()); err == nil {
				t.Fatal("accepted unsupported checkpoint")
			}
			data, err := os.ReadFile(path)
			if err != nil || string(data) != document {
				t.Fatalf("refusal rewrote checkpoint: %v", err)
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
