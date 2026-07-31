package journal

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
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

func TestStateWithReferencedOperationRejectsAmbiguousOrMissingReference(t *testing.T) {
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
	if err = os.Remove(store.operationPath(operation.ID)); err != nil {
		t.Fatal(err)
	}
	if _, _, err = store.StateWithReferencedOperation(); err == nil ||
		!strings.Contains(err.Error(), "read manager state operation") {
		t.Fatalf("missing referenced operation was accepted: %v", err)
	}
}

func TestOversizedPersistedDiagnosticsConvergeOnlyOnSubsequentWrites(t *testing.T) {
	dir := t.TempDir()
	seed, err := Open(dir, time.Unix(100, 0))
	if err != nil {
		t.Fatal(err)
	}
	op, _, err := seed.Begin(model.OperationRequest{
		Kind:               model.OperationUpdate,
		IdempotencyKey:     "oversized-persisted-diagnostic",
		ExpectedGeneration: seed.State().Generation,
	}, time.Unix(101, 0))
	if err != nil {
		t.Fatal(err)
	}
	persistedDiagnostic := strings.Repeat("retry reservation release\n", 110000)
	state := seed.State()
	state.LastError = persistedDiagnostic
	op.Error = persistedDiagnostic
	for i := 0; i < MaxOperationHistoryEntries+20; i++ {
		op.History = append(op.History, model.PhaseEvent{
			Phase: model.PhaseDraining,
			At:    time.Unix(int64(200+i), 0).UTC(),
			Note:  "history-note-" + strconv.Itoa(i) + ":" + strings.Repeat("x", MaxHistoryNoteBytes*2),
		})
	}
	statePath := filepath.Join(dir, "state.json")
	opPath := filepath.Join(dir, "operations", op.ID+".json")
	if err := atomicfile.WriteJSON(statePath, state, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := atomicfile.WriteJSON(opPath, op, 0o600); err != nil {
		t.Fatal(err)
	}
	stateBefore, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	opBefore, err := os.ReadFile(opPath)
	if err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(dir, time.Unix(102, 0))
	if err != nil {
		t.Fatal(err)
	}
	want := BoundDiagnostic(persistedDiagnostic)
	if got := reopened.State().LastError; got != want {
		t.Fatalf("State did not bound the persisted diagnostic: %d bytes", len(got))
	}
	readOp, err := reopened.Operation(op.ID)
	if err != nil {
		t.Fatal(err)
	}
	if readOp.Error != want || len(readOp.History) != MaxOperationHistoryEntries {
		t.Fatalf("Operation did not bound persisted diagnostics: error=%d history=%d", len(readOp.Error), len(readOp.History))
	}
	markedNotes := 0
	for _, event := range readOp.History {
		if len(event.Note) > MaxHistoryNoteBytes {
			t.Fatalf("history note was not safely bounded: %d bytes", len(event.Note))
		}
		if strings.Contains(event.Note, "[diagnostic truncated;") {
			markedNotes++
		}
	}
	if markedNotes == 0 {
		t.Fatal("oversized history notes were not marked as truncated")
	}
	stateAfterRead, _ := os.ReadFile(statePath)
	opAfterRead, _ := os.ReadFile(opPath)
	if !bytes.Equal(stateBefore, stateAfterRead) || !bytes.Equal(opBefore, opAfterRead) {
		t.Fatal("opening or reading a journal rewrote durable evidence")
	}
	recoveryOp, err := reopened.RecoverActive()
	if err != nil {
		t.Fatal(err)
	}
	if recoveryOp == nil || recoveryOp.Error != persistedDiagnostic {
		t.Fatal("internal recovery lost the original diagnostic before its first bounded write")
	}

	if _, err := reopened.MutateState(time.Unix(103, 0), func(*model.ManagerState) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if _, err := reopened.UpdateOperation(op.ID, func(*model.Operation) error { return nil }); err != nil {
		t.Fatal(err)
	}
	var persistedState model.ManagerState
	if err := atomicfile.ReadJSON(statePath, &persistedState); err != nil {
		t.Fatal(err)
	}
	var persistedOp model.Operation
	if err := atomicfile.ReadJSON(opPath, &persistedOp); err != nil {
		t.Fatal(err)
	}
	if persistedState.LastError != want || persistedOp.Error != want || len(persistedOp.History) != MaxOperationHistoryEntries {
		t.Fatalf("subsequent writes did not converge diagnostics: state=%d operation=%d want=%d", len(persistedState.LastError), len(persistedOp.Error), len(want))
	}
}

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
	again, reused, err := store.Begin(request, now)
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

func TestCompletePreparedCleanupTerminalizesMarkerBeforeState(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(dir, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	op, _, err := store.Begin(model.OperationRequest{
		Kind: model.OperationUpdate, IdempotencyKey: "prepared-cleanup-half", ExpectedGeneration: store.State().Generation,
	}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpdateOperation(op.ID, func(value *model.Operation) error {
		value.Status = model.OperationRunning
		value.TargetGeneration = strings.Repeat("a", 40)
		value.PreparedCleanupPending = true
		value.Error = "original pull failure"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	injected := false
	store.beforePersistState = func(next model.ManagerState) error {
		if next.ActiveOperationID == "" && !injected {
			injected = true
			return errors.New("injected prepared cleanup state fsync failure")
		}
		return nil
	}
	if _, err := store.CompletePreparedCleanup(op.ID, time.Now()); err == nil {
		t.Fatal("expected prepared cleanup state persistence failure")
	}

	reopened, err := Open(dir, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	active, err := reopened.RecoverActive()
	if err != nil || active == nil || active.Status != model.OperationFailed || !active.Finalized ||
		active.PreparedCleanupPending || active.CompletedAt == nil || active.Error != "original pull failure" {
		t.Fatalf("terminal cleanup half-commit retained a resumable marker: %#v %v", active, err)
	}
	completed, err := reopened.Complete(op.ID, false, func(state *model.ManagerState) {
		state.Candidate = nil
		state.PublicState = model.StateIdle
		state.Maintenance = false
		state.LastError = active.Error
		state.RetryAfterSeconds = 0
	}, active.Error, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if completed.PreparedCleanupPending || completed.Status != model.OperationFailed || !completed.Finalized ||
		reopened.State().ActiveOperationID != "" || reopened.State().PublicState != model.StateIdle {
		t.Fatalf("terminal cleanup half-commit did not converge: operation=%#v state=%#v", completed, reopened.State())
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
	if err := os.WriteFile(filepath.Join(store.operations, "unknown.tmp"), []byte("evidence"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UnfinishedOperations(); err == nil || !strings.Contains(err.Error(), "unknown operation journal entry") {
		t.Fatalf("unknown operation evidence was ignored: %v", err)
	}
}
