package snapshot

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRestoreRemovesWALAbsentFromSnapshot(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "data")
	backups := filepath.Join(root, "backups")
	if err := os.MkdirAll(data, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "platform.db"), []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := Store{DataDir: data, BackupDir: backups}
	snapshot, err := store.Create(context.Background(), "op_test")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "platform.db"), []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "platform.db-wal"), []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := store.Restore(context.Background(), snapshot); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Join(data, "platform.db"))
	if err != nil || string(content) != "old" {
		t.Fatalf("database was not restored: %q %v", content, err)
	}
	if _, err := os.Stat(filepath.Join(data, "platform.db-wal")); !os.IsNotExist(err) {
		t.Fatalf("stale WAL remains: %v", err)
	}
}

func TestRestoreRejectsCorruptSnapshotWithoutChangingCurrentData(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "data")
	backups := filepath.Join(root, "backups")
	if err := os.MkdirAll(data, 0o700); err != nil {
		t.Fatal(err)
	}
	old := map[string]string{
		"platform.db":                  "snapshot-db",
		"platform.db-wal":              "snapshot-wal",
		"platform.db-shm":              "snapshot-shm",
		"bootstrap-admin-password.txt": "snapshot-password",
	}
	writeFiles(t, data, old)
	store := Store{DataDir: data, BackupDir: backups}
	snapshotPath, err := store.Create(context.Background(), "op_corrupt")
	if err != nil {
		t.Fatal(err)
	}
	current := map[string]string{
		"platform.db":                  "current-db",
		"platform.db-wal":              "current-wal",
		"platform.db-shm":              "current-shm",
		"bootstrap-admin-password.txt": "current-password",
	}
	writeFiles(t, data, current)
	if err := os.WriteFile(filepath.Join(snapshotPath, "platform.db-wal"), []byte("tampered-wal"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := store.Restore(context.Background(), snapshotPath); err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("expected checksum error, got %v", err)
	}
	assertFiles(t, data, current)
}

func TestRestoreCompensatesCommitRenameFailure(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "data")
	backups := filepath.Join(root, "backups")
	if err := os.MkdirAll(data, 0o700); err != nil {
		t.Fatal(err)
	}
	snapshotFiles := map[string]string{
		"platform.db":                  "snapshot-db",
		"platform.db-wal":              "snapshot-wal",
		"platform.db-shm":              "snapshot-shm",
		"bootstrap-admin-password.txt": "snapshot-password",
	}
	writeFiles(t, data, snapshotFiles)
	store := Store{DataDir: data, BackupDir: backups}
	snapshotPath, err := store.Create(context.Background(), "op_rename_failure")
	if err != nil {
		t.Fatal(err)
	}
	current := map[string]string{
		"platform.db":                  "current-db",
		"platform.db-wal":              "current-wal",
		"platform.db-shm":              "current-shm",
		"bootstrap-admin-password.txt": "current-password",
	}
	writeFiles(t, data, current)
	injected := false
	store.renamePath = func(source, destination string) error {
		if !injected && filepath.Base(source) == "platform.db-wal" && filepath.Base(filepath.Dir(source)) == "staging" {
			injected = true
			return errors.New("injected staged WAL rename failure")
		}
		return os.Rename(source, destination)
	}

	if err := store.Restore(context.Background(), snapshotPath); err == nil || !strings.Contains(err.Error(), "injected staged WAL rename failure") {
		t.Fatalf("expected injected commit error, got %v", err)
	}
	if !injected {
		t.Fatal("rename failure was not injected")
	}
	assertFiles(t, data, current)
}

func TestCreateRequiresSnapshotAndBackupDirectoryDurability(t *testing.T) {
	for _, test := range []struct {
		name      string
		failLevel string
		wantCalls int
		wantError string
	}{
		{name: "snapshot-directory", failLevel: "snapshot", wantCalls: 1, wantError: "sync snapshot directory"},
		{name: "backup-directory", failLevel: "backup", wantCalls: 2, wantError: "sync snapshot backup directory"},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			data := filepath.Join(root, "data")
			backups := filepath.Join(root, "backups")
			if err := os.MkdirAll(data, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(data, "platform.db"), []byte("snapshot"), 0o600); err != nil {
				t.Fatal(err)
			}
			operationID := "op_" + strings.ReplaceAll(test.name, "-", "_")
			snapshotDir := filepath.Join(backups, operationID)
			calls := make([]string, 0, 2)
			injected := errors.New("injected directory fsync failure")
			store := Store{DataDir: data, BackupDir: backups}
			store.syncDir = func(path string) error {
				calls = append(calls, filepath.Clean(path))
				if test.failLevel == "snapshot" && filepath.Clean(path) == filepath.Clean(snapshotDir) {
					return injected
				}
				if test.failLevel == "backup" && filepath.Clean(path) == filepath.Clean(backups) {
					return injected
				}
				return nil
			}
			path, err := store.Create(context.Background(), operationID)
			if path != "" || !errors.Is(err, injected) || !strings.Contains(err.Error(), test.wantError) {
				t.Fatalf("directory durability failure returned success: path=%q err=%v", path, err)
			}
			if len(calls) != test.wantCalls || calls[0] != filepath.Clean(snapshotDir) {
				t.Fatalf("unexpected directory sync sequence: %#v", calls)
			}
			if test.wantCalls == 2 && calls[1] != filepath.Clean(backups) {
				t.Fatalf("backup root was not the final durability barrier: %#v", calls)
			}
		})
	}
}

func TestCreateSyncsSnapshotBeforeBackupRootOnSuccess(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "data")
	backups := filepath.Join(root, "backups")
	if err := os.MkdirAll(data, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "platform.db"), []byte("snapshot"), 0o600); err != nil {
		t.Fatal(err)
	}
	calls := make([]string, 0, 2)
	store := Store{DataDir: data, BackupDir: backups}
	store.syncDir = func(path string) error {
		calls = append(calls, filepath.Clean(path))
		return nil
	}
	path, err := store.Create(context.Background(), "op_success")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{filepath.Clean(path), filepath.Clean(backups)}
	if len(calls) != len(want) || calls[0] != want[0] || calls[1] != want[1] {
		t.Fatalf("snapshot durability barriers are out of order: got %#v want %#v", calls, want)
	}
}

func writeFiles(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func assertFiles(t *testing.T, dir string, expected map[string]string) {
	t.Helper()
	for name, want := range expected {
		content, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if string(content) != want {
			t.Fatalf("%s changed: got %q, want %q", name, content, want)
		}
	}
}
