package journal

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
)

func TestBeginCrashKeepsReplayOwned(t *testing.T) {
	const marker = "JOURNAL_BEGIN_CRASH_CHILD"
	request := model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: "begin-crash"}
	if dir := os.Getenv(marker); dir != "" {
		store, err := Open(dir, time.Unix(100, 0))
		if err != nil {
			t.Fatal(err)
		}
		request.ExpectedGeneration = store.State().Generation
		store.beforePersistState = func(next model.ManagerState) error {
			if next.ActiveOperationID != "" {
				os.Exit(73)
			}
			return nil
		}
		_, _, err = store.Begin(request, time.Unix(101, 0))
		t.Fatalf("crash seam not reached: %v", err)
	}
	dir := t.TempDir()
	seed, err := Open(dir, time.Unix(100, 0))
	if err != nil {
		t.Fatal(err)
	}
	request.ExpectedGeneration = seed.State().Generation
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable, "-test.run=^TestBeginCrashKeepsReplayOwned$", "-test.count=1")
	cmd.Env = append(os.Environ(), marker+"="+dir)
	output, err := cmd.CombinedOutput()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 73 {
		t.Fatalf("child did not hit durable-operation crash seam: %v %s", err, output)
	}
	reopened, err := Open(dir, time.Unix(102, 0))
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		op, reused, err := reopened.Begin(request, time.Unix(103, 0))
		if err != nil {
			t.Fatalf("replay: %v", err)
		}
		state := reopened.State()
		if (op.Status == model.OperationPending || op.Status == model.OperationRunning) && state.ActiveOperationID != op.ID {
			t.Fatalf("replay returned ownerless unfinished operation: id=%s reused=%t status=%s active=%q", op.ID, reused, op.Status, state.ActiveOperationID)
		}
		reopened, err = Open(dir, time.Unix(104, 0))
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestBeginStateWriteErrorsPreserveAndReconcileOwner(t *testing.T) {
	for _, committed := range []bool{false, true} {
		name := "before_commit"
		if committed {
			name = "after_commit"
		}
		t.Run(name, func(t *testing.T) {
			store, err := Open(t.TempDir(), time.Unix(100, 0))
			if err != nil {
				t.Fatal(err)
			}
			request := model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: name, ExpectedGeneration: store.State().Generation}
			store.beforePersistState = func(next model.ManagerState) error {
				if committed {
					if err := atomicfile.WriteJSON(store.statePath, next, 0o600); err != nil {
						t.Fatal(err)
					}
				}
				return errors.New("state publication interrupted")
			}
			if _, _, err := store.Begin(request, time.Unix(101, 0)); err == nil {
				t.Fatal("expected publication error")
			}
			store.beforePersistState = nil
			unfinished, err := store.UnfinishedOperations()
			if err != nil || len(unfinished) != 1 {
				t.Fatalf("lost durable operation evidence: %v %v", unfinished, err)
			}
			op, reused, err := store.Begin(request, time.Unix(102, 0))
			if err != nil || !reused || op.ID != unfinished[0].ID {
				t.Fatalf("replay changed the owner: %v %v %v", op, reused, err)
			}
			state := store.State()
			if state.ActiveOperationID != op.ID || state.Generation != request.ExpectedGeneration+1 {
				t.Fatalf("admission did not converge exactly once: %+v", state)
			}
			active, err := store.RecoverActive()
			if err != nil || active == nil || active.ID != op.ID {
				t.Fatalf("recovery lost admission owner: %v %v", active, err)
			}
		})
	}
}

func TestStateMutationAfterInterruptedAdmissionPreservesOwner(t *testing.T) {
	for _, committed := range []bool{false, true} {
		name := "before_state_commit"
		if committed {
			name = "after_state_commit"
		}
		t.Run(name, func(t *testing.T) {
			store, err := Open(t.TempDir(), time.Unix(100, 0))
			if err != nil {
				t.Fatal(err)
			}
			request := model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: name, ExpectedGeneration: store.State().Generation}
			store.beforePersistState = func(next model.ManagerState) error {
				// The filesystem becomes healthy immediately after this one
				// publication failure; no replay/reopen runs before mutation.
				store.beforePersistState = nil
				if committed {
					if err := atomicfile.WriteJSON(store.statePath, next, 0o600); err != nil {
						t.Fatal(err)
					}
				}
				return errors.New("one state publication failure")
			}
			if _, _, err := store.Begin(request, time.Unix(101, 0)); err == nil {
				t.Fatal("expected interrupted admission")
			}
			unfinished, err := store.UnfinishedOperations()
			if err != nil || len(unfinished) != 1 {
				t.Fatalf("missing durable admission: %v %v", unfinished, err)
			}
			ownerID := unfinished[0].ID
			// This is the same shared journal mutation boundary used by
			// acceptManifest after a successful /v1/check.
			state, err := store.MutateState(time.Unix(102, 0), func(state *model.ManagerState) error {
				state.Candidate = &model.Generation{ID: "checked-candidate", DatabaseVersion: 1}
				state.LastError = ""
				return nil
			})
			if err != nil {
				t.Fatalf("healthy candidate publication failed: %v", err)
			}
			if state.ActiveOperationID != ownerID || state.Generation != request.ExpectedGeneration+2 {
				t.Errorf("candidate publication lost admission ownership: %+v", state)
			}
			replayed, reused, replayErr := store.Begin(request, time.Unix(103, 0))
			if replayErr != nil || !reused || replayed.ID != ownerID {
				t.Errorf("healthy mutation stranded idempotent replay: %v reused=%v err=%v", replayed, reused, replayErr)
			}
			reopened, openErr := Open(store.dir, time.Unix(104, 0))
			if openErr != nil {
				t.Fatalf("healthy mutation made the journal unrecoverable: %v", openErr)
			}
			active, err := reopened.RecoverActive()
			if err != nil || active == nil || active.ID != ownerID {
				t.Fatalf("reopened recovery lost admission: %v %v", active, err)
			}
			if reopened.State().Candidate == nil || reopened.State().Candidate.ID != "checked-candidate" {
				t.Fatal("admission recovery discarded the legitimate candidate publication")
			}
		})
	}
}

func TestAdmissionRejectsConflictingOrIncompleteEvidence(t *testing.T) {
	for _, conflict := range []string{"generation", "phase", "side_effect", "multiple", "missing_request", "unknown_field"} {
		t.Run(conflict, func(t *testing.T) {
			store, err := Open(t.TempDir(), time.Unix(100, 0))
			if err != nil {
				t.Fatal(err)
			}
			request := model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: conflict, ExpectedGeneration: store.State().Generation}
			store.beforePersistState = func(model.ManagerState) error { return errors.New("interrupted") }
			if _, _, err := store.Begin(request, time.Unix(101, 0)); err == nil {
				t.Fatal("expected interrupted admission")
			}
			store.beforePersistState = nil
			operations, err := store.UnfinishedOperations()
			if err != nil || len(operations) != 1 {
				t.Fatalf("missing admission evidence: %v %v", operations, err)
			}
			op := operations[0]
			switch conflict {
			case "generation":
				op.ExpectedGeneration++
			case "phase":
				op.Phase = model.PhasePulling
			case "side_effect":
				op.ReservationStatus = model.ReservationConfirmed
			case "multiple":
				other := op
				other.ID = "op_conflicting"
				other.IdempotencyKey = "other"
				if err := store.persistOperationLocked(&other); err != nil {
					t.Fatal(err)
				}
			}
			if err := store.persistOperationLocked(&op); err != nil {
				t.Fatal(err)
			}
			if conflict == "missing_request" || conflict == "unknown_field" {
				var fields map[string]json.RawMessage
				if err := atomicfile.ReadJSON(store.operationPath(op.ID), &fields); err != nil {
					t.Fatal(err)
				}
				if conflict == "missing_request" {
					delete(fields, "expected_generation")
				} else {
					fields["unknown_checkpoint"] = json.RawMessage("true")
				}
				if err := atomicfile.WriteJSON(store.operationPath(op.ID), fields, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			beforeState, err := os.ReadFile(store.statePath)
			if err != nil {
				t.Fatal(err)
			}
			beforeOp, err := os.ReadFile(store.operationPath(op.ID))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := Open(store.dir, time.Unix(102, 0)); err == nil {
				t.Fatal("reopened conflicting admission")
			}
			if _, _, err := store.Begin(request, time.Unix(103, 0)); err == nil {
				t.Fatal("replayed conflicting admission")
			}
			called := false
			if _, err := store.MutateState(time.Unix(104, 0), func(state *model.ManagerState) error {
				called = true
				state.LastError = "unrelated diagnostic"
				return nil
			}); err == nil || called {
				t.Fatal("state mutation crossed conflicting admission evidence")
			}
			afterState, err := os.ReadFile(store.statePath)
			if err != nil {
				t.Fatal(err)
			}
			afterOp, err := os.ReadFile(store.operationPath(op.ID))
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(beforeState, afterState) || !bytes.Equal(beforeOp, afterOp) {
				t.Fatal("failed admission changed durable evidence")
			}
		})
	}
}
