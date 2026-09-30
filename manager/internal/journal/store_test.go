package journal

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
)

func TestBoundDiagnosticIsMarkedAndSafeForJSONExpansion(t *testing.T) {
	if got := BoundDiagnostic("short failure"); got != "short failure" {
		t.Fatalf("short diagnostic changed: %q", got)
	}
	large := strings.Repeat("\x1b\r", MaxDiagnosticBytes)
	bounded := BoundDiagnostic(large)
	if len(bounded) > MaxDiagnosticBytes {
		t.Fatalf("bounded diagnostic has %d bytes, limit is %d", len(bounded), MaxDiagnosticBytes)
	}
	for _, part := range []string{
		"[diagnostic truncated;",
		"original_bytes=" + strconv.Itoa(len(large)),
		"sha256=",
	} {
		if !strings.Contains(bounded, part) {
			t.Fatalf("bounded diagnostic is missing %q", part)
		}
	}
	if again := BoundDiagnostic(large); again != bounded {
		t.Fatal("diagnostic marker is not deterministic")
	}
	if !strings.HasPrefix(bounded, large[:256]) || !strings.HasSuffix(bounded, large[len(large)-256:]) {
		t.Fatal("bounded diagnostic did not preserve both the head and tail")
	}
	encoded, err := json.Marshal(bounded)
	if err != nil {
		t.Fatal(err)
	}
	if len(encoded) >= 1<<20 {
		t.Fatalf("JSON escaping exceeded the response safety budget: %d bytes", len(encoded))
	}
}

func TestStateWithReferencedOperationReturnsOneLockConsistentClone(t *testing.T) {
	store, err := Open(t.TempDir(), time.Unix(100, 0))
	if err != nil {
		t.Fatal(err)
	}
	operation, _, err := store.Begin(model.OperationRequest{
		Kind:               model.OperationUpdate,
		IdempotencyKey:     "atomic-status-snapshot",
		ExpectedGeneration: store.State().Generation,
	}, time.Unix(101, 0))
	if err != nil {
		t.Fatal(err)
	}
	operation, err = store.UpdateOperation(operation.ID, func(value *model.Operation) error {
		value.Status = model.OperationRunning
		value.Phase = model.PhaseStarting
		value.TargetGeneration = strings.Repeat("a", 40)
		value.History = append(value.History, model.PhaseEvent{Phase: model.PhaseStarting, Note: "original"})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	state, referenced, err := store.StateWithReferencedOperation()
	if err != nil {
		t.Fatal(err)
	}
	if referenced == nil || referenced.ID != operation.ID ||
		referenced.Phase != model.PhaseStarting ||
		state.ActiveOperationID != operation.ID {
		t.Fatalf("status snapshot is inconsistent: state=%#v operation=%#v", state, referenced)
	}
	state.ActiveOperationID = "mutated"
	referenced.Kind = model.OperationRepair
	referenced.History[len(referenced.History)-1].Note = "mutated"

	stateAgain, referencedAgain, err := store.StateWithReferencedOperation()
	if err != nil {
		t.Fatal(err)
	}
	if stateAgain.ActiveOperationID != operation.ID || referencedAgain == nil ||
		referencedAgain.Kind != model.OperationUpdate ||
		referencedAgain.History[len(referencedAgain.History)-1].Note != "original" {
		t.Fatalf("status snapshot aliases Store state: state=%#v operation=%#v", stateAgain, referencedAgain)
	}
}

func TestStateWithReferencedOperationFailsClosedOnInvalidReference(t *testing.T) {
	store, err := Open(t.TempDir(), time.Unix(100, 0))
	if err != nil {
		t.Fatal(err)
	}
	operation, _, err := store.Begin(model.OperationRequest{
		Kind:               model.OperationUpdate,
		IdempotencyKey:     "invalid-status-snapshot",
		ExpectedGeneration: store.State().Generation,
	}, time.Unix(101, 0))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.MutateState(time.Unix(102, 0), func(state *model.ManagerState) error {
		state.FinalizePendingOperationID = operation.ID
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err = store.StateWithReferencedOperation(); err == nil ||
		!strings.Contains(err.Error(), "overlapping") {
		t.Fatalf("overlapping operation references were accepted: %v", err)
	}

	if _, err = store.MutateState(time.Unix(103, 0), func(state *model.ManagerState) error {
		state.FinalizePendingOperationID = ""
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	delete(store.records, operation.ID)
	if _, _, err = store.StateWithReferencedOperation(); err == nil ||
		!strings.Contains(err.Error(), "read manager state operation") {
		t.Fatalf("missing referenced operation was accepted: %v", err)
	}
}

func TestOperationIdempotencyAndPersistence(t *testing.T) {
	now := time.Unix(100, 0)
	dir := t.TempDir()
	store, err := Open(dir, now)
	if err != nil {
		t.Fatal(err)
	}
	generation := store.State().Generation
	request := model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: "same-request", ExpectedGeneration: generation}
	first, reused, err := store.Begin(request, now)
	if err != nil || reused {
		t.Fatalf("begin: reused=%v err=%v", reused, err)
	}
	again, reused, err := store.Begin(request, now)
	if err != nil || !reused || again.ID != first.ID {
		t.Fatalf("idempotency failed: %#v %v", again, err)
	}
	reopened, err := Open(dir, now)
	if err != nil {
		t.Fatal(err)
	}
	active, err := reopened.RecoverActive()
	if err != nil || active == nil || active.ID != first.ID {
		t.Fatalf("operation journal did not recover: %#v %v", active, err)
	}
}

func TestAdmissionClosurePreservesReplayAndRejectsNewAttempt(t *testing.T) {
	now := time.Unix(100, 0)
	store, err := Open(t.TempDir(), now)
	if err != nil {
		t.Fatal(err)
	}
	request := model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: "before-handoff", ExpectedGeneration: store.State().Generation}
	first, _, err := store.Begin(request, now)
	if err != nil {
		t.Fatal(err)
	}
	closed := errors.New("launcher handoff unproven")
	reject := func(model.ManagerState) error { return closed }
	replayed, reused, err := store.BeginWithAdmission(request, now, reject)
	if err != nil || !reused || replayed.ID != first.ID {
		t.Fatalf("closed admission hid active replay: op=%+v reused=%v err=%v", replayed, reused, err)
	}
	if _, err := store.Complete(first.ID, false, nil, "failed", now); err != nil {
		t.Fatal(err)
	}
	replayed, reused, err = store.BeginWithAdmission(request, now, reject)
	if err != nil || !reused || replayed.ID != first.ID || replayed.Status != model.OperationFailed {
		t.Fatalf("closed admission hid terminal replay: op=%+v reused=%v err=%v", replayed, reused, err)
	}
	before := store.State()
	request.ExpectedGeneration = before.Generation
	if _, _, err := store.BeginWithAdmission(request, now, reject); !errors.Is(err, closed) {
		t.Fatalf("new attempt crossed closed admission: %v", err)
	}
	after := store.State()
	if after.Generation != before.Generation || after.ActiveOperationID != "" {
		t.Fatalf("rejected admission mutated journal: %+v", after)
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
	replayed, reused, err := store.Begin(request, time.Now())
	if err != nil || !reused || replayed.ID != first.ID || replayed.Status != model.OperationFailed {
		t.Fatalf("exact failed response replay did not return the original attempt: %#v %v %v", replayed, reused, err)
	}
	request.ExpectedGeneration = store.State().Generation
	second, reused, err := store.Begin(request, time.Now().Add(time.Second))
	if err != nil || reused || second.ID == first.ID || second.Attempt != 2 {
		t.Fatalf("failed request was not retried as a new attempt: %#v %v %v", second, reused, err)
	}
}

func TestIdempotencyKeyRejectsDifferentOperationFingerprint(t *testing.T) {
	store, err := Open(t.TempDir(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	request := model.OperationRequest{
		Kind:               model.OperationInstall,
		IdempotencyKey:     "stable-key",
		ExpectedGeneration: store.State().Generation,
		ManifestURL:        "https://releases.example/one.json",
	}
	if _, _, err := store.Begin(request, time.Now()); err != nil {
		t.Fatal(err)
	}
	staleConflict := request
	staleConflict.ManifestURL = "https://releases.example/conflict.json"
	if _, _, err := store.Begin(staleConflict, time.Now()); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("stale generation hid an idempotency fingerprint conflict: %v", err)
	}
	for _, mutate := range []func(*model.OperationRequest){
		func(value *model.OperationRequest) { value.Kind = model.OperationUpdate },
		func(value *model.OperationRequest) { value.ManifestURL = "https://releases.example/two.json" },
	} {
		conflict := request
		conflict.ExpectedGeneration = store.State().Generation
		mutate(&conflict)
		if _, _, err := store.Begin(conflict, time.Now()); !errors.Is(err, ErrIdempotencyConflict) {
			t.Fatalf("different request reused an idempotency key: %#v err=%v", conflict, err)
		}
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

func TestUnfinishedOperationsFailsClosedAndExcludesFinalizedHistory(t *testing.T) {
	store, err := Open(t.TempDir(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	op, _, err := store.Begin(model.OperationRequest{
		Kind: model.OperationUpdate, IdempotencyKey: "maintenance-protection",
		ExpectedGeneration: store.State().Generation,
	}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	unfinished, err := store.UnfinishedOperations()
	if err != nil || len(unfinished) != 1 || unfinished[0].ID != op.ID {
		t.Fatalf("pending operation was not protected: %#v %v", unfinished, err)
	}
	if _, err := store.Complete(op.ID, false, nil, "failed before maintenance", time.Now()); err != nil {
		t.Fatal(err)
	}
	unfinished, err = store.UnfinishedOperations()
	if err != nil || len(unfinished) != 0 {
		t.Fatalf("finalized operation remained protected: %#v %v", unfinished, err)
	}
}
