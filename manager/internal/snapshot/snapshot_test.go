package snapshot

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/atomicfile"
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

func TestRestoreRecreatesMissingOwnedDataDirectory(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "data")
	backups := filepath.Join(root, "backups")
	if err := os.Mkdir(data, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "platform.db"), []byte("snapshot-db"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := Store{DataDir: data, BackupDir: backups}
	snapshotPath, err := store.Create(context.Background(), "op_missing_data")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(data); err != nil {
		t.Fatal(err)
	}

	var synced []string
	store.syncDir = func(path string) error {
		synced = append(synced, filepath.Clean(path))
		return nil
	}
	if err := store.Restore(context.Background(), snapshotPath); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Join(data, "platform.db"))
	if err != nil || string(content) != "snapshot-db" {
		t.Fatalf("snapshot was not restored into recreated data directory: %q %v", content, err)
	}
	info, err := os.Lstat(data)
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0o700 {
		t.Fatalf("recreated data directory is unsafe: info=%v err=%v", info, err)
	}
	if len(synced) == 0 || synced[0] != filepath.Clean(root) {
		t.Fatalf("data parent was not the first durability barrier: %#v", synced)
	}
}

func TestRestoreRejectsMissingDataBelowSymlinkParent(t *testing.T) {
	root := t.TempDir()
	realRoot := filepath.Join(root, "real")
	if err := os.Mkdir(realRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	data := filepath.Join(realRoot, "data")
	backups := filepath.Join(root, "backups")
	if err := os.Mkdir(data, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "platform.db"), []byte("snapshot-db"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := Store{DataDir: data, BackupDir: backups}
	snapshotPath, err := store.Create(context.Background(), "op_symlink_parent")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(data); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "linked")
	if err := os.Symlink(realRoot, link); err != nil {
		t.Fatal(err)
	}
	store.DataDir = filepath.Join(link, "data")

	err = store.Restore(context.Background(), snapshotPath)
	if err == nil || !strings.Contains(err.Error(), "parent is not a regular directory") {
		t.Fatalf("restore accepted a missing data directory below a symlink parent: %v", err)
	}
	if _, err := os.Lstat(data); !os.IsNotExist(err) {
		t.Fatalf("unsafe restore created the symlinked target: %v", err)
	}
}

func TestRestoreValidatesSnapshotBeforeRecreatingMissingData(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "data")
	backups := filepath.Join(root, "backups")
	if err := os.Mkdir(data, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "platform.db"), []byte("snapshot-db"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := Store{DataDir: data, BackupDir: backups}
	snapshotPath, err := store.Create(context.Background(), "op_corrupt_missing_data")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(snapshotPath, "platform.db"), []byte("corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(data); err != nil {
		t.Fatal(err)
	}
	if err := store.Restore(context.Background(), snapshotPath); err == nil || !strings.Contains(err.Error(), "snapshot") {
		t.Fatalf("corrupt snapshot was accepted: %v", err)
	}
	if _, err := os.Lstat(data); !os.IsNotExist(err) {
		t.Fatalf("invalid snapshot recreated the missing target: %v", err)
	}
}

func TestRestoreRejectsMissingDataBelowWritableParent(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "data")
	backups := filepath.Join(root, "backups")
	if err := os.Mkdir(data, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "platform.db"), []byte("snapshot-db"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := Store{DataDir: data, BackupDir: backups}
	snapshotPath, err := store.Create(context.Background(), "op_writable_parent")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(data); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(root, 0o770); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(root, 0o700)
	if err := store.Restore(context.Background(), snapshotPath); err == nil || !strings.Contains(err.Error(), "writable by another host identity") {
		t.Fatalf("writable parent was accepted: %v", err)
	}
	if _, err := os.Lstat(data); !os.IsNotExist(err) {
		t.Fatalf("unsafe parent gained a recreated target: %v", err)
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
		{name: "snapshot-directory", failLevel: "snapshot", wantCalls: 2, wantError: "sync snapshot directory"},
		{name: "backup-directory", failLevel: "backup", wantCalls: 3, wantError: "sync snapshot backup directory"},
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
			calls := make([]string, 0, 2)
			injected := errors.New("injected directory fsync failure")
			failedBackupSync := false
			store := Store{DataDir: data, BackupDir: backups}
			store.syncDir = func(path string) error {
				calls = append(calls, filepath.Clean(path))
				if test.failLevel == "snapshot" && strings.HasPrefix(filepath.Base(path), ".snapshot-") {
					return injected
				}
				if test.failLevel == "backup" && filepath.Clean(path) == filepath.Clean(backups) && !failedBackupSync {
					failedBackupSync = true
					return injected
				}
				return nil
			}
			path, err := store.Create(context.Background(), operationID)
			if path != "" || !errors.Is(err, injected) || !strings.Contains(err.Error(), test.wantError) {
				t.Fatalf("directory durability failure returned success: path=%q err=%v", path, err)
			}
			if len(calls) != test.wantCalls || !strings.HasPrefix(filepath.Base(calls[0]), ".snapshot-") {
				t.Fatalf("unexpected directory sync sequence: %#v", calls)
			}
			if calls[1] != filepath.Clean(backups) {
				t.Fatalf("backup root was not the final durability barrier: %#v", calls)
			}
			entries, readErr := os.ReadDir(backups)
			if readErr != nil || len(entries) != 0 {
				t.Fatalf("failed snapshot left backup entries: %#v %v", entries, readErr)
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
	if len(calls) != 2 || !strings.HasPrefix(filepath.Base(calls[0]), ".snapshot-") || calls[1] != filepath.Clean(backups) {
		t.Fatalf("snapshot durability barriers are out of order: got %#v", calls)
	}
	if filepath.Clean(path) != filepath.Join(backups, "op_success") {
		t.Fatalf("snapshot final path = %q", path)
	}
}

func TestRequiredBytesUsesLargerOfLogicalAndAllocatedSize(t *testing.T) {
	data := t.TempDir()
	path := filepath.Join(data, "platform.db")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(8 << 20); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		t.Fatal("test filesystem did not expose allocation metadata")
	}
	want := uint64(info.Size())
	if allocated := uint64(stat.Blocks) * 512; allocated > want {
		want = allocated
	}
	got, err := RequiredBytes(context.Background(), data)
	if err != nil {
		t.Fatal(err)
	}
	if got != want || got < 8<<20 {
		t.Fatalf("required snapshot bytes = %d, want %d", got, want)
	}
}

func TestCreateCleansOperationStagingAfterMidCopyFailure(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
	}{
		{name: "generic", err: io.ErrUnexpectedEOF},
		{name: "enospc", err: syscall.ENOSPC},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			data := filepath.Join(root, "data")
			backups := filepath.Join(root, "backups")
			if err := os.MkdirAll(data, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(data, "platform.db"), []byte("database"), 0o600); err != nil {
				t.Fatal(err)
			}
			store := Store{DataDir: data, BackupDir: backups}
			store.copyPath = func(_, destination string, _ os.FileMode) (string, error) {
				if err := os.WriteFile(destination, []byte("partial"), 0o600); err != nil {
					return "", err
				}
				return "", test.err
			}
			path, err := store.Create(context.Background(), "op_"+test.name)
			if path != "" || !errors.Is(err, test.err) {
				t.Fatalf("mid-copy failure = path %q error %v", path, err)
			}
			entries, readErr := os.ReadDir(backups)
			if readErr != nil || len(entries) != 0 {
				t.Fatalf("failed copy left snapshot artifacts: %#v %v", entries, readErr)
			}
		})
	}
}

func TestPruneRemovesOnlyExpiredRecognizedSnapshotStaging(t *testing.T) {
	root := t.TempDir()
	backups := filepath.Join(root, "backups")
	if err := os.MkdirAll(backups, 0o700); err != nil {
		t.Fatal(err)
	}
	makeStaging := func(operationID string) string {
		t.Helper()
		encoded := base64.RawURLEncoding.EncodeToString([]byte(operationID))
		path, err := os.MkdirTemp(backups, ".snapshot-"+encoded+".*")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(path, 0o700); err != nil {
			t.Fatal(err)
		}
		return path
	}
	old := makeStaging("op_crashed")
	recent := makeStaging("op_recent")
	unknown := makeStaging("op_unknown")
	for _, path := range []string{old, recent, unknown} {
		if err := os.WriteFile(filepath.Join(path, "platform.db"), []byte("partial"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(unknown, "operator-note.txt"), []byte("retain"), 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	oldTime := now.Add(-2 * time.Hour)
	for _, path := range []string{old, unknown} {
		if err := os.Chtimes(path, oldTime, oldTime); err != nil {
			t.Fatal(err)
		}
	}
	store := Store{BackupDir: backups, StagingRetention: time.Hour}
	removed, err := store.Prune(context.Background(), now, nil)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("removed staging count = %d, want 1", removed)
	}
	if _, err := os.Lstat(old); !os.IsNotExist(err) {
		t.Fatalf("expired recognized staging remains: %v", err)
	}
	for _, path := range []string{recent, unknown} {
		if _, err := os.Lstat(path); err != nil {
			t.Fatalf("protected staging %s changed: %v", path, err)
		}
	}
}

func TestPruneRemovesOnlyExpiredValidatedUnprotectedSnapshots(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "data")
	backups := filepath.Join(root, "backups")
	if err := os.MkdirAll(data, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "platform.db"), []byte("snapshot"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := Store{DataDir: data, BackupDir: backups, Retention: time.Hour}
	old := createSnapshotAt(t, store, "op_expired", time.Unix(10, 0))
	protected := createSnapshotAt(t, store, "op_protected", time.Unix(10, 0))
	recent := createSnapshotAt(t, store, "op_recent", time.Unix(9_500, 0))

	removed, err := store.Prune(context.Background(), time.Unix(10_000, 0), map[string]struct{}{protected: {}})
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("removed snapshots = %d, want 1", removed)
	}
	if _, err := os.Lstat(old); !os.IsNotExist(err) {
		t.Fatalf("expired snapshot remains: %v", err)
	}
	for _, path := range []string{protected, recent} {
		if _, err := os.Lstat(path); err != nil {
			t.Fatalf("retained snapshot %s is unavailable: %v", path, err)
		}
	}
}

func TestPruneRetainsSnapshotContainingUnknownEvidence(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "data")
	backups := filepath.Join(root, "backups")
	if err := os.MkdirAll(data, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "platform.db"), []byte("snapshot"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := Store{DataDir: data, BackupDir: backups, Retention: time.Hour}
	path := createSnapshotAt(t, store, "op_unknown_evidence", time.Unix(10, 0))
	if err := os.WriteFile(filepath.Join(path, "operator-note.txt"), []byte("retain me"), 0o600); err != nil {
		t.Fatal(err)
	}

	removed, err := store.Prune(context.Background(), time.Unix(10_000, 0), nil)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 0 {
		t.Fatalf("snapshot with unknown evidence was removed: %d", removed)
	}
	if content, err := os.ReadFile(filepath.Join(path, "operator-note.txt")); err != nil || string(content) != "retain me" {
		t.Fatalf("unknown snapshot evidence changed: %q %v", content, err)
	}
}

func createSnapshotAt(t *testing.T, store Store, operationID string, createdAt time.Time) string {
	t.Helper()
	path, err := store.Create(context.Background(), operationID)
	if err != nil {
		t.Fatal(err)
	}
	var manifest Manifest
	manifestPath := filepath.Join(path, "manifest.json")
	if err := atomicfile.ReadJSON(manifestPath, &manifest); err != nil {
		t.Fatal(err)
	}
	manifest.CreatedAt = createdAt.UTC()
	if err := atomicfile.WriteJSON(manifestPath, manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
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
