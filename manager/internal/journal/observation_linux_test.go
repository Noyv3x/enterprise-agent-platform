//go:build linux

package journal

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
)

func TestObserveOperationBoundaryIsPureAndClosedWorld(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(dir, time.Unix(1, 0))
	if err != nil {
		t.Fatal(err)
	}
	op, _, err := store.Begin(model.OperationRequest{
		Kind: model.OperationUpdate, IdempotencyKey: "observe", ExpectedGeneration: store.State().Generation,
	}, time.Unix(2, 0))
	if err != nil {
		t.Fatal(err)
	}
	completed := time.Unix(3, 0).UTC()
	op.Status, op.Finalized, op.CompletedAt, op.UpdatedAt = model.OperationSucceeded, true, &completed, completed
	if err := atomicfile.WriteJSON(filepath.Join(dir, "operations", op.ID+".json"), op, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.MutateState(completed, func(state *model.ManagerState) error {
		state.ActiveOperationID = ""
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	boundary, err := store.ObserveOperationBoundary()
	if err != nil {
		t.Fatal(err)
	}
	if !boundary.AllTerminal || boundary.EvidenceCount != 1 || len(boundary.Operations) != 1 {
		t.Fatalf("operation boundary = %#v", boundary)
	}

	residue := filepath.Join(dir, "operations", ".tmp-123")
	if err := os.WriteFile(residue, []byte("temporary"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ObserveOperationBoundary(); err == nil || !strings.Contains(err.Error(), "unknown") {
		t.Fatalf("unknown residue was accepted: %v", err)
	}
	if _, err := os.Stat(residue); err != nil {
		t.Fatalf("pure observation removed the residue: %v", err)
	}
}

func TestObserveOperationBoundaryRejectsUnknownAndDuplicateJSON(t *testing.T) {
	for _, test := range []struct {
		name string
		body string
	}{
		{name: "unknown", body: `{"schema_version":1,"generation":0,"public_state":"idle","maintenance":false,"heartbeat_at":"1970-01-01T00:00:01Z","updated_at":"1970-01-01T00:00:01Z","unknown":true}`},
		{name: "duplicate", body: `{"schema_version":1,"schema_version":1,"generation":0,"public_state":"idle","maintenance":false,"heartbeat_at":"1970-01-01T00:00:01Z","updated_at":"1970-01-01T00:00:01Z"}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			dir := t.TempDir()
			store, err := Open(dir, time.Unix(1, 0))
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, "state.json"), []byte(test.body), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := store.ObserveOperationBoundary(); err == nil {
				t.Fatal("invalid durable state was accepted")
			}
		})
	}
}
