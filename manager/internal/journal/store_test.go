package journal

import (
	"errors"
	"testing"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/model"
)

func TestOperationIdempotencyAndPersistence(t *testing.T) {
	now := time.Unix(100, 0)
	store, err := Open(t.TempDir(), now)
	if err != nil {
		t.Fatal(err)
	}
	generation := store.State().Generation
	request := model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: "same-request", ExpectedGeneration: generation}
	first, reused, err := store.Begin(request, now)
	if err != nil || reused {
		t.Fatalf("begin: reused=%v err=%v", reused, err)
	}
	again, reused, err := store.Begin(model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: "same-request", ExpectedGeneration: store.State().Generation}, now)
	if err != nil || !reused || again.ID != first.ID {
		t.Fatalf("idempotency failed: %#v %v", again, err)
	}
	reopened, err := Open(store.dir, now)
	if err != nil {
		t.Fatal(err)
	}
	active, err := reopened.RecoverActive()
	if err != nil || active == nil || active.ID != first.ID {
		t.Fatalf("operation journal did not recover: %#v %v", active, err)
	}
}

func TestFailedIdempotentOperationCreatesANewAttempt(t *testing.T) {
	store, err := Open(t.TempDir(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	request := model.OperationRequest{Kind: model.OperationInstall, IdempotencyKey: "stable-install", ExpectedGeneration: store.State().Generation}
	first, reused, err := store.Begin(request, time.Now())
	if err != nil || reused || first.Attempt != 1 {
		t.Fatalf("unexpected first attempt: %#v %v %v", first, reused, err)
	}
	if _, err := store.Complete(first.ID, false, nil, "temporary failure", time.Now()); err != nil {
		t.Fatal(err)
	}
	request.ExpectedGeneration = store.State().Generation
	second, reused, err := store.Begin(request, time.Now().Add(time.Second))
	if err != nil || reused || second.ID == first.ID || second.Attempt != 2 {
		t.Fatalf("failed request was not retried as a new attempt: %#v %v %v", second, reused, err)
	}
}
func TestBeginRejectsStaleGeneration(t *testing.T) {
	store, err := Open(t.TempDir(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = store.Begin(model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: "stale", ExpectedGeneration: 99}, time.Now())
	if !errors.Is(err, ErrGenerationConflict) {
		t.Fatalf("expected generation conflict, got %v", err)
	}
}

func TestBeginRejectsAnotherOperationWhileFinalizeIsPending(t *testing.T) {
	store, err := Open(t.TempDir(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	request := model.OperationRequest{Kind: model.OperationInstall, IdempotencyKey: "install", ExpectedGeneration: store.State().Generation}
	op, _, err := store.Begin(request, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Complete(op.ID, true, func(state *model.ManagerState) {
		state.FinalizePendingOperationID = op.ID
	}, "", time.Now()); err != nil {
		t.Fatal(err)
	}

	state := store.State()
	if _, _, err := store.Begin(model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: "update", ExpectedGeneration: state.Generation}, time.Now()); !errors.Is(err, ErrOperationInProgress) {
		t.Fatalf("another operation crossed the finalize boundary: %v", err)
	}
	// An idempotent retry can still observe the exact pending operation.
	retry, reused, err := store.Begin(model.OperationRequest{Kind: model.OperationInstall, IdempotencyKey: "install", ExpectedGeneration: state.Generation}, time.Now())
	if err != nil || !reused || retry.ID != op.ID {
		t.Fatalf("pending operation was not idempotently observable: %#v reused=%v err=%v", retry, reused, err)
	}
}

func TestCompletePersistsTerminalOperationBeforeStateAndLeavesRecoverableWindow(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(dir, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	op, _, err := store.Begin(model.OperationRequest{
		Kind:               model.OperationUpdate,
		IdempotencyKey:     "terminal-before-state",
		ExpectedGeneration: store.State().Generation,
	}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	injected := false
	store.beforePersistState = func(next model.ManagerState) error {
		if next.ActiveOperationID == "" && !injected {
			injected = true
			return errors.New("injected state fsync failure")
		}
		return nil
	}
	if _, err = store.Complete(op.ID, false, nil, "pull failed", time.Now()); err == nil {
		t.Fatal("expected state persistence failure")
	}

	// Simulate a process restart. The terminal operation is durable while the
	// old state still points at it, giving Recover an exact, non-resumable case.
	reopened, err := Open(dir, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	active, err := reopened.RecoverActive()
	if err != nil || active == nil {
		t.Fatalf("terminal/state split was not recoverable: %#v %v", active, err)
	}
	if active.ID != op.ID || active.Status != model.OperationFailed || active.Error != "pull failed" {
		t.Fatalf("terminal operation was not persisted first: %#v", active)
	}
}
