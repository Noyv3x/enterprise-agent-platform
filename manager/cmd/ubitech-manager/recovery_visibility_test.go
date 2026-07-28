package main

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/journal"
	"github.com/ubitech/agent-platform/manager/internal/logstore"
	"github.com/ubitech/agent-platform/manager/internal/model"
)

func TestRecordCurrentRecoveryFailurePersistsBoundedDiagnosticOnly(t *testing.T) {
	root := t.TempDir()
	store, err := journal.Open(filepath.Join(root, "state"), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	current := &model.Generation{ID: strings.Repeat("a", 40), Images: map[string]string{"platform": "example.invalid/platform"}}
	candidate := &model.Generation{ID: strings.Repeat("b", 40), Images: map[string]string{"platform": "example.invalid/candidate"}}
	if _, err := store.MutateState(time.Now(), func(state *model.ManagerState) error {
		state.Current = current
		state.Candidate = candidate
		state.FinalizePendingOperationID = "op_finalize"
		state.PublicState = model.StateUpdating
		state.Phase = model.PhaseCommitting
		state.Maintenance = true
		state.RetryAfterSeconds = 37
		state.LastError = "older diagnostic"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	audit := logstore.New(filepath.Join(root, "audit.jsonl"), 1<<20, 2)
	app := &application{state: store, audit: audit}
	before := store.State()
	recoveryErr := errors.New(strings.Repeat("temporary recovery failure ", 5000))
	wantDiagnostic := journal.BoundDiagnostic(recoveryErr.Error())

	app.recordCurrentRecoveryFailure(recoveryErr)
	after := store.State()
	if after.LastError != wantDiagnostic || len(after.LastError) > journal.MaxDiagnosticBytes {
		t.Fatalf("LastError was not bounded: got=%d want=%d", len(after.LastError), len(wantDiagnostic))
	}
	wantState := before
	wantState.Generation = after.Generation
	wantState.UpdatedAt = after.UpdatedAt
	wantState.HeartbeatAt = after.HeartbeatAt
	wantState.LastError = wantDiagnostic
	if !reflect.DeepEqual(after, wantState) {
		t.Fatalf("recovery visibility changed durable intent\nafter: %#v\nwant:  %#v", after, wantState)
	}

	events, err := audit.Tail(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("audit events = %d, want 1", len(events))
	}
	var event logstore.Event
	if err := json.Unmarshal(events[0], &event); err != nil {
		t.Fatal(err)
	}
	if event.Type != "manager.recovery_failed" || event.OperationID != "op_finalize" || event.Error != wantDiagnostic {
		t.Fatalf("unexpected recovery audit: %#v", event)
	}

	// Repeating an identical transient failure may add another audit event, but
	// must not churn the durable state generation.
	generation := after.Generation
	app.recordCurrentRecoveryFailure(recoveryErr)
	if got := store.State().Generation; got != generation {
		t.Fatalf("identical diagnostic changed state generation: got %d want %d", got, generation)
	}
}

func TestRecordCurrentRecoveryFailureUsesActiveOperation(t *testing.T) {
	root := t.TempDir()
	store, err := journal.Open(filepath.Join(root, "state"), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.MutateState(time.Now(), func(state *model.ManagerState) error {
		state.ActiveOperationID = "op_active"
		state.PublicState = model.StateFailed
		state.Maintenance = true
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	audit := logstore.New(filepath.Join(root, "audit.jsonl"), 1<<20, 2)
	app := &application{state: store, audit: audit}
	app.recordCurrentRecoveryFailure(errors.New("operation journal unavailable"))
	events, err := audit.Tail(1)
	if err != nil {
		t.Fatal(err)
	}
	var event logstore.Event
	if len(events) != 1 {
		t.Fatalf("audit events = %d, want 1", len(events))
	}
	if err := json.Unmarshal(events[0], &event); err != nil {
		t.Fatal(err)
	}
	if event.OperationID != "op_active" {
		t.Fatalf("recovery audit operation = %q, want op_active", event.OperationID)
	}
}

func TestCapabilityRetryDelayBacksOffAndCaps(t *testing.T) {
	tests := map[int]time.Duration{
		0:  time.Minute,
		1:  15 * time.Second,
		2:  30 * time.Second,
		3:  time.Minute,
		7:  10 * time.Minute,
		12: 10 * time.Minute,
	}
	for failures, expected := range tests {
		if got := capabilityRetryDelay(failures); got != expected {
			t.Fatalf("capabilityRetryDelay(%d) = %s, want %s", failures, got, expected)
		}
	}
}

func TestReconciliationLoopRetriesWithoutBlockingCaller(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var mu sync.Mutex
	calls := 0
	converged := make(chan struct{})
	reconcile := func(context.Context) error {
		mu.Lock()
		defer mu.Unlock()
		calls++
		if calls < 3 {
			return errors.New("transient capability failure")
		}
		close(converged)
		return nil
	}
	done := make(chan struct{})
	go func() {
		runReconciliationLoop(ctx, time.Millisecond, func(int) time.Duration { return time.Millisecond }, reconcile)
		close(done)
	}()
	select {
	case <-converged:
	case <-time.After(time.Second):
		t.Fatal("reconciliation did not retry to convergence")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("reconciliation loop did not stop")
	}
	mu.Lock()
	defer mu.Unlock()
	if calls != 3 {
		t.Fatalf("reconciliation calls = %d, want 3", calls)
	}
}
