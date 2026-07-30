package journal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/model"
)

func TestPruneTerminalOperationsEnforcesTimeWindowAndMinimumTail(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	t.Run("minimum tail", func(t *testing.T) {
		store, err := Open(t.TempDir(), now)
		if err != nil {
			t.Fatal(err)
		}
		for index := 0; index < TerminalOperationMinimum+2; index++ {
			writeTerminalCleanupOperation(t, store, terminalCleanupID(index), now.Add(-30*24*time.Hour+time.Duration(index)*time.Minute), model.OperationSucceeded, true, true)
		}
		removed, err := store.PruneTerminalOperations(context.Background(), now, allowTerminalOperationRemoval)
		if err != nil {
			t.Fatal(err)
		}
		if removed != 2 {
			t.Fatalf("removed=%d, want 2", removed)
		}
		assertTerminalCleanupMissing(t, store.operationPath(terminalCleanupID(0)))
		assertTerminalCleanupMissing(t, store.operationPath(terminalCleanupID(1)))
		for index := 2; index < TerminalOperationMinimum+2; index++ {
			assertTerminalCleanupExists(t, store.operationPath(terminalCleanupID(index)))
		}
	})

	t.Run("seven day window", func(t *testing.T) {
		store, err := Open(t.TempDir(), now)
		if err != nil {
			t.Fatal(err)
		}
		writeTerminalCleanupOperation(t, store, terminalCleanupID(0), now.Add(-8*24*time.Hour), model.OperationFailed, true, true)
		writeTerminalCleanupOperation(t, store, terminalCleanupID(1), now.Add(-TerminalOperationRetention), model.OperationFailed, true, true)
		for index := 2; index < TerminalOperationMinimum+2; index++ {
			writeTerminalCleanupOperation(t, store, terminalCleanupID(index), now.Add(-6*24*time.Hour+time.Duration(index)*time.Minute), model.OperationSucceeded, true, true)
		}
		removed, err := store.PruneTerminalOperations(context.Background(), now, allowTerminalOperationRemoval)
		if err != nil {
			t.Fatal(err)
		}
		if removed != 1 {
			t.Fatalf("removed=%d, want 1", removed)
		}
		assertTerminalCleanupMissing(t, store.operationPath(terminalCleanupID(0)))
		assertTerminalCleanupExists(t, store.operationPath(terminalCleanupID(1)))
	})
}

func TestPruneTerminalOperationsNeverDeletesLiveOrIncompleteEvidence(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	store, err := Open(t.TempDir(), now)
	if err != nil {
		t.Fatal(err)
	}
	for index := 0; index < TerminalOperationMinimum+7; index++ {
		writeTerminalCleanupOperation(t, store, terminalCleanupID(index), now.Add(-30*24*time.Hour+time.Duration(index)*time.Minute), model.OperationSucceeded, true, true)
	}
	writeTerminalCleanupOperation(t, store, terminalCleanupID(0), now.Add(-40*24*time.Hour), model.OperationPending, true, true)
	writeTerminalCleanupOperation(t, store, terminalCleanupID(1), now.Add(-39*24*time.Hour), model.OperationRunning, true, true)
	writeTerminalCleanupOperation(t, store, terminalCleanupID(2), now.Add(-38*24*time.Hour), model.OperationSucceeded, false, true)
	writeTerminalCleanupOperation(t, store, terminalCleanupID(3), now.Add(-37*24*time.Hour), model.OperationFailed, true, false)
	if _, err := store.MutateState(now, func(state *model.ManagerState) error {
		state.ActiveOperationID = terminalCleanupID(4)
		state.FinalizePendingOperationID = terminalCleanupID(5)
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	removed, err := store.PruneTerminalOperations(context.Background(), now, allowTerminalOperationRemoval)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("removed=%d, want 1 from the 129 eligible finalized journals", removed)
	}
	for index := 0; index <= 5; index++ {
		assertTerminalCleanupExists(t, store.operationPath(terminalCleanupID(index)))
	}
}

func TestPruneTerminalOperationsDoesNotEnterRecoveryOrActivationDomains(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	root := t.TempDir()
	store, err := Open(root, now)
	if err != nil {
		t.Fatal(err)
	}
	for index := 0; index < TerminalOperationMinimum+1; index++ {
		writeTerminalCleanupOperation(t, store, terminalCleanupID(index), now.Add(-30*24*time.Hour+time.Duration(index)*time.Minute), model.OperationSucceeded, true, true)
	}
	recovery := filepath.Join(root, "manager-binaries", "recoveries", "recovery.json")
	activation := filepath.Join(root, "manager-binaries", "activations", "activation.json")
	for _, path := range []string{recovery, activation} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("audit evidence\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.PruneTerminalOperations(context.Background(), now, allowTerminalOperationRemoval); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{recovery, activation} {
		assertTerminalCleanupExists(t, path)
	}
}

func TestPruneTerminalOperationsFailsClosedOnUnsafeJournalEvidence(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name   string
		create func(*testing.T, *Store) string
		uid    func() uint32
	}{
		{
			name: "unknown entry",
			create: func(t *testing.T, store *Store) string {
				path := filepath.Join(store.operations, "unknown-evidence")
				writeTerminalCleanupBytes(t, path, []byte("evidence\n"), 0o600)
				return path
			},
		},
		{
			name: "malformed JSON",
			create: func(t *testing.T, store *Store) string {
				path := store.operationPath("op_malformed")
				writeTerminalCleanupBytes(t, path, []byte("{\n"), 0o600)
				return path
			},
		},
		{
			name: "symbolic link",
			create: func(t *testing.T, store *Store) string {
				target := filepath.Join(store.dir, "outside-operation.json")
				writeTerminalCleanupBytes(t, target, []byte("{}\n"), 0o600)
				path := store.operationPath("op_symlink")
				if err := os.Symlink(target, path); err != nil {
					t.Fatal(err)
				}
				return path
			},
		},
		{
			name: "hard link",
			create: func(t *testing.T, store *Store) string {
				path := store.operationPath("op_hardlink")
				writeTerminalCleanupOperation(t, store, "op_hardlink", now.Add(-30*24*time.Hour), model.OperationSucceeded, true, true)
				if err := os.Link(path, filepath.Join(store.dir, "hardlink-copy")); err != nil {
					t.Fatal(err)
				}
				return path
			},
		},
		{
			name: "broad mode",
			create: func(t *testing.T, store *Store) string {
				path := store.operationPath("op_broad")
				writeTerminalCleanupOperation(t, store, "op_broad", now.Add(-30*24*time.Hour), model.OperationSucceeded, true, true)
				if err := os.Chmod(path, 0o640); err != nil {
					t.Fatal(err)
				}
				return path
			},
		},
		{
			name: "wrong owner identity",
			create: func(t *testing.T, store *Store) string {
				path := store.operationPath("op_owner")
				writeTerminalCleanupOperation(t, store, "op_owner", now.Add(-30*24*time.Hour), model.OperationSucceeded, true, true)
				return path
			},
			uid: func() uint32 { return uint32(os.Geteuid() + 1) },
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store, err := Open(t.TempDir(), now)
			if err != nil {
				t.Fatal(err)
			}
			path := test.create(t, store)
			expectedUID := uint32(os.Geteuid())
			if test.uid != nil {
				expectedUID = test.uid()
			}
			_, err = store.pruneTerminalOperations(context.Background(), now, allowTerminalOperationRemoval, expectedUID, terminalOperationCleanupHooks{})
			if err == nil {
				t.Fatal("unsafe journal evidence was accepted")
			}
			assertTerminalCleanupExists(t, path)
		})
	}
}

func TestPruneTerminalOperationsRejectsInodeReplacementAndContinuesOtherCandidates(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	store, err := Open(t.TempDir(), now)
	if err != nil {
		t.Fatal(err)
	}
	for index := 0; index < TerminalOperationMinimum+2; index++ {
		writeTerminalCleanupOperation(t, store, terminalCleanupID(index), now.Add(-30*24*time.Hour+time.Duration(index)*time.Minute), model.OperationSucceeded, true, true)
	}
	replaced := ""
	original := filepath.Join(store.dir, "replaced-original.json")
	removed, err := store.pruneTerminalOperations(context.Background(), now, allowTerminalOperationRemoval, uint32(os.Geteuid()), terminalOperationCleanupHooks{
		beforeUnlink: func(name string) {
			if replaced != "" {
				return
			}
			replaced = name
			path := filepath.Join(store.operations, name)
			if err := os.Rename(path, original); err != nil {
				t.Fatal(err)
			}
			data, err := os.ReadFile(original)
			if err != nil {
				t.Fatal(err)
			}
			writeTerminalCleanupBytes(t, path, data, 0o600)
		},
	})
	if err == nil || !strings.Contains(err.Error(), "changed before unlink") {
		t.Fatalf("cleanup error=%v, want inode replacement rejection", err)
	}
	if removed != 1 {
		t.Fatalf("removed=%d, want unaffected candidate to be removed", removed)
	}
	assertTerminalCleanupExists(t, filepath.Join(store.operations, replaced))
	assertTerminalCleanupExists(t, original)
}

func TestPruneTerminalOperationsReportsDirectorySyncFailureAndHonorsGuard(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	t.Run("sync failure", func(t *testing.T) {
		store, err := Open(t.TempDir(), now)
		if err != nil {
			t.Fatal(err)
		}
		for index := 0; index < TerminalOperationMinimum+1; index++ {
			writeTerminalCleanupOperation(t, store, terminalCleanupID(index), now.Add(-30*24*time.Hour+time.Duration(index)*time.Minute), model.OperationSucceeded, true, true)
		}
		syncCalls := 0
		removed, err := store.pruneTerminalOperations(context.Background(), now, allowTerminalOperationRemoval, uint32(os.Geteuid()), terminalOperationCleanupHooks{
			syncDirectory: func(_ *os.File, _ string) error {
				syncCalls++
				return errors.New("injected directory fsync failure")
			},
		})
		if err == nil || !strings.Contains(err.Error(), "injected directory fsync failure") {
			t.Fatalf("cleanup error=%v, want directory fsync failure", err)
		}
		if syncCalls != 1 || removed != 0 {
			t.Fatalf("sync calls=%d removed=%d, want 1 and 0", syncCalls, removed)
		}
	})

	t.Run("guard rejection", func(t *testing.T) {
		store, err := Open(t.TempDir(), now)
		if err != nil {
			t.Fatal(err)
		}
		for index := 0; index < TerminalOperationMinimum+1; index++ {
			writeTerminalCleanupOperation(t, store, terminalCleanupID(index), now.Add(-30*24*time.Hour+time.Duration(index)*time.Minute), model.OperationSucceeded, true, true)
		}
		removed, err := store.PruneTerminalOperations(context.Background(), now, func() (func(), bool) { return nil, false })
		if err != nil || removed != 0 {
			t.Fatalf("guarded cleanup removed=%d err=%v", removed, err)
		}
		assertTerminalCleanupExists(t, store.operationPath(terminalCleanupID(0)))
	})
}

func allowTerminalOperationRemoval() (func(), bool) { return func() {}, true }

func terminalCleanupID(index int) string { return fmt.Sprintf("op_cleanup_%032x", index) }

func writeTerminalCleanupOperation(t *testing.T, store *Store, id string, completed time.Time, status model.OperationStatus, finalized, includeCompleted bool) {
	t.Helper()
	created := completed.Add(-time.Minute)
	operation := model.Operation{
		SchemaVersion:  1,
		ID:             id,
		Kind:           model.OperationUpdate,
		IdempotencyKey: "cleanup-" + id,
		Attempt:        1,
		Status:         status,
		Finalized:      finalized,
		Phase:          model.PhaseCommitting,
		History:        []model.PhaseEvent{{Phase: model.PhaseCommitting, At: created}},
		CreatedAt:      created,
		UpdatedAt:      completed,
	}
	if includeCompleted {
		value := completed
		operation.CompletedAt = &value
	}
	data, err := json.MarshalIndent(operation, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	writeTerminalCleanupBytes(t, store.operationPath(id), append(data, '\n'), 0o600)
}

func writeTerminalCleanupBytes(t *testing.T, path string, data []byte, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, data, mode); err != nil {
		t.Fatal(err)
	}
}

func assertTerminalCleanupExists(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Lstat(path); err != nil {
		t.Fatalf("expected %s to remain: %v", path, err)
	}
}

func assertTerminalCleanupMissing(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("expected %s to be removed, stat error=%v", path, err)
	}
}
