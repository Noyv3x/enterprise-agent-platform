package journal

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
)

func TestUnfinishedOperationsCleansCrashLeftAtomicResidue(t *testing.T) {
	directory := t.TempDir()
	store, err := Open(directory, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	residue := filepath.Join(directory, "operations", ".tmp-123")
	if err := os.WriteFile(residue, []byte("partial journal"), 0o600); err != nil {
		t.Fatal(err)
	}
	operations, err := store.UnfinishedOperations()
	if err != nil {
		t.Fatal(err)
	}
	if len(operations) != 0 {
		t.Fatalf("unfinished operations = %#v, want none", operations)
	}
	if _, err := os.Lstat(residue); !os.IsNotExist(err) {
		t.Fatalf("operation residue stat = %v, want removed", err)
	}
}

func TestBeginCleansOperationResidueBeforeIdempotencyEnumeration(t *testing.T) {
	directory := t.TempDir()
	store, err := Open(directory, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	residue := filepath.Join(directory, "operations", ".tmp-456")
	if err := os.WriteFile(residue, []byte("partial journal"), 0o600); err != nil {
		t.Fatal(err)
	}
	request := model.OperationRequest{
		Kind: model.OperationUpdate, IdempotencyKey: "atomic-cleanup", ExpectedGeneration: store.State().Generation,
	}
	if _, reused, err := store.Begin(request, time.Now().UTC()); err != nil || reused {
		t.Fatalf("begin operation after residue: reused=%v err=%v", reused, err)
	}
	if _, err := os.Lstat(residue); !os.IsNotExist(err) {
		t.Fatalf("operation residue stat = %v, want removed before idempotency scan", err)
	}
}

func TestUnfinishedOperationsRejectsUnsafeAtomicLookalike(t *testing.T) {
	directory := t.TempDir()
	store, err := Open(directory, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	lookalike := filepath.Join(directory, "operations", ".tmp-attacker")
	if err := os.WriteFile(lookalike, []byte("unknown evidence"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = store.UnfinishedOperations()
	if err == nil || !strings.Contains(err.Error(), "unknown atomic temporary") {
		t.Fatalf("unfinished operation error = %v, want lookalike rejection", err)
	}
	if _, err := os.Lstat(lookalike); err != nil {
		t.Fatalf("unsafe lookalike was removed: %v", err)
	}
}
