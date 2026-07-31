package journal

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"syscall"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
)

const (
	// TerminalOperationRetention preserves a useful time window for status
	// inspection and idempotent response recovery.
	TerminalOperationRetention = 7 * 24 * time.Hour
	// TerminalOperationMinimum preserves a useful tail even on quiet systems
	// whose most recent operations are older than the time window.
	TerminalOperationMinimum = 128
	maxOperationJournalBytes = int64(8 << 20)
)

// TerminalOperationRemovalGuard enters the Manager maintenance admission
// boundary immediately before a journal unlink. The returned release function
// must be called after the parent directory has been durably synchronized.
type TerminalOperationRemovalGuard func() (release func(), ok bool)

type terminalOperationRecord struct {
	name      string
	info      os.FileInfo
	data      []byte
	operation model.Operation
}

type terminalOperationCleanupHooks struct {
	beforeUnlink  func(string)
	syncDirectory func(*os.File, string) error
}

// PruneTerminalOperations removes only expired, finalized terminal journals
// outside the newest retained tail. Planning is performed without the external
// maintenance admission lock. Every unlink is separately admitted and then
// revalidated under Store.mu, preserving the maintenance lock order.
func (s *Store) PruneTerminalOperations(ctx context.Context, now time.Time, guard TerminalOperationRemovalGuard) (int, error) {
	return s.pruneTerminalOperations(ctx, now, guard, uint32(os.Geteuid()), terminalOperationCleanupHooks{})
}

func (s *Store) pruneTerminalOperations(
	ctx context.Context,
	now time.Time,
	guard TerminalOperationRemovalGuard,
	expectedUID uint32,
	hooks terminalOperationCleanupHooks,
) (int, error) {
	if ctx == nil {
		return 0, errors.New("terminal operation cleanup context is required")
	}
	if now.IsZero() {
		return 0, errors.New("terminal operation cleanup time is required")
	}
	if guard == nil {
		return 0, errors.New("terminal operation cleanup removal guard is required")
	}

	s.mu.Lock()
	plan, err := s.planTerminalOperationCleanupLocked(now.UTC(), expectedUID)
	s.mu.Unlock()
	if err != nil {
		return 0, err
	}

	removed := 0
	var cleanupErrors []error
	for _, planned := range plan {
		if err := ctx.Err(); err != nil {
			cleanupErrors = append(cleanupErrors, err)
			break
		}
		releaseAdmission, ok := guard()
		if !ok {
			break
		}
		if releaseAdmission == nil {
			cleanupErrors = append(cleanupErrors, errors.New("terminal operation cleanup guard returned a nil release function"))
			break
		}

		s.mu.Lock()
		deleted, deleteErr := s.removePlannedTerminalOperationLocked(planned, expectedUID, hooks)
		s.mu.Unlock()
		releaseAdmission()
		if deleteErr != nil {
			cleanupErrors = append(cleanupErrors, deleteErr)
			continue
		}
		if deleted {
			removed++
		}
	}
	return removed, errors.Join(cleanupErrors...)
}

func (s *Store) planTerminalOperationCleanupLocked(now time.Time, expectedUID uint32) ([]terminalOperationRecord, error) {
	directory, err := s.openVerifiedOperationDirectory(expectedUID)
	if err != nil {
		return nil, err
	}
	defer directory.Close()

	temporaryResult, err := atomicfile.CleanupManagedTemps(directory, s.operations, atomicfile.ManagedTempCleanupPolicy{
		Now: now, ExclusiveWriter: true,
	})
	if err != nil {
		return nil, fmt.Errorf("clean operation journal atomic residues before terminal pruning: %w", err)
	}
	if temporaryResult.Retained != 0 {
		return nil, fmt.Errorf("operation journal cleanup retained %d artifacts despite exclusive writer ownership", temporaryResult.Retained)
	}
	if _, err := directory.Seek(0, 0); err != nil {
		return nil, fmt.Errorf("rewind operation journal directory before terminal pruning: %w", err)
	}
	entries, err := directory.ReadDir(-1)
	if err != nil {
		return nil, fmt.Errorf("enumerate operation journals for terminal pruning: %w", err)
	}

	terminal := make([]terminalOperationRecord, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if filepath.Ext(name) != ".json" {
			return nil, fmt.Errorf("unknown operation journal entry %s", name)
		}
		id := name[:len(name)-len(".json")]
		if !validID(id) || name != id+".json" {
			return nil, fmt.Errorf("invalid operation journal entry %s", name)
		}
		record, err := s.readVerifiedOperationRecord(directory, name, expectedUID)
		if err != nil {
			return nil, err
		}
		if err := validateOperationJournalIdentity(record.operation, id); err != nil {
			return nil, fmt.Errorf("validate operation journal %s: %w", name, err)
		}
		if terminalOperationEligible(record.operation, s.state) {
			terminal = append(terminal, record)
		}
	}

	sort.Slice(terminal, func(left, right int) bool {
		leftCompleted := *terminal[left].operation.CompletedAt
		rightCompleted := *terminal[right].operation.CompletedAt
		if !leftCompleted.Equal(rightCompleted) {
			return leftCompleted.After(rightCompleted)
		}
		if !terminal[left].operation.UpdatedAt.Equal(terminal[right].operation.UpdatedAt) {
			return terminal[left].operation.UpdatedAt.After(terminal[right].operation.UpdatedAt)
		}
		if !terminal[left].operation.CreatedAt.Equal(terminal[right].operation.CreatedAt) {
			return terminal[left].operation.CreatedAt.After(terminal[right].operation.CreatedAt)
		}
		return terminal[left].name > terminal[right].name
	})
	if len(terminal) <= TerminalOperationMinimum {
		return nil, nil
	}
	cutoff := now.Add(-TerminalOperationRetention)
	removable := make([]terminalOperationRecord, 0, len(terminal)-TerminalOperationMinimum)
	for _, record := range terminal[TerminalOperationMinimum:] {
		if record.operation.CompletedAt.Before(cutoff) {
			removable = append(removable, record)
		}
	}
	return removable, nil
}

func (s *Store) removePlannedTerminalOperationLocked(planned terminalOperationRecord, expectedUID uint32, hooks terminalOperationCleanupHooks) (bool, error) {
	if planned.operation.ID == s.state.ActiveOperationID || planned.operation.ID == s.state.FinalizePendingOperationID {
		return false, nil
	}
	directory, err := s.openVerifiedOperationDirectory(expectedUID)
	if err != nil {
		return false, err
	}
	defer directory.Close()
	if hooks.beforeUnlink != nil {
		hooks.beforeUnlink(planned.name)
	}
	current, err := s.readVerifiedOperationRecord(directory, planned.name, expectedUID)
	if err != nil {
		return false, fmt.Errorf("revalidate terminal operation journal %s before unlink: %w", planned.name, err)
	}
	if !os.SameFile(planned.info, current.info) || !bytes.Equal(planned.data, current.data) {
		return false, fmt.Errorf("terminal operation journal %s changed before unlink", planned.name)
	}
	if !terminalOperationEligible(current.operation, s.state) {
		return false, nil
	}
	if err := syscall.Unlinkat(int(directory.Fd()), planned.name); err != nil {
		return false, fmt.Errorf("unlink terminal operation journal %s: %w", planned.name, err)
	}
	syncDirectory := hooks.syncDirectory
	if syncDirectory == nil {
		syncDirectory = func(directory *os.File, _ string) error { return directory.Sync() }
	}
	if err := syncDirectory(directory, planned.name); err != nil {
		return false, fmt.Errorf("sync operation journal directory after unlinking %s: %w", planned.name, err)
	}
	return true, nil
}

func (s *Store) openVerifiedOperationDirectory(expectedUID uint32) (*os.File, error) {
	directoryPath := filepath.Clean(s.operations)
	if !filepath.IsAbs(directoryPath) || directoryPath != s.operations {
		return nil, errors.New("operation journal directory is not absolute and canonical")
	}
	resolvedPath, err := filepath.EvalSymlinks(directoryPath)
	if err != nil {
		return nil, fmt.Errorf("resolve operation journal directory: %w", err)
	}
	if resolvedPath != directoryPath {
		return nil, errors.New("operation journal directory path contains a symbolic link")
	}
	pathInfo, err := os.Lstat(directoryPath)
	if err != nil {
		return nil, fmt.Errorf("inspect operation journal directory: %w", err)
	}
	fd, err := syscall.Open(directoryPath, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, fmt.Errorf("open operation journal directory: %w", err)
	}
	directory := os.NewFile(uintptr(fd), directoryPath)
	if directory == nil {
		_ = syscall.Close(fd)
		return nil, errors.New("open operation journal directory: invalid file descriptor")
	}
	openedInfo, err := directory.Stat()
	if err != nil {
		_ = directory.Close()
		return nil, fmt.Errorf("inspect opened operation journal directory: %w", err)
	}
	if err := validateOperationJournalDirectory(pathInfo, openedInfo, expectedUID); err != nil {
		_ = directory.Close()
		return nil, err
	}
	if !os.SameFile(pathInfo, openedInfo) {
		_ = directory.Close()
		return nil, errors.New("operation journal directory changed while it was opened")
	}
	return directory, nil
}

func (s *Store) readVerifiedOperationRecord(directory *os.File, name string, expectedUID uint32) (terminalOperationRecord, error) {
	path := filepath.Join(s.operations, name)
	pathInfo, err := os.Lstat(path)
	if err != nil {
		return terminalOperationRecord{}, fmt.Errorf("inspect operation journal %s: %w", name, err)
	}
	if err := validateOperationJournalFile(pathInfo, expectedUID); err != nil {
		return terminalOperationRecord{}, fmt.Errorf("validate operation journal %s: %w", name, err)
	}
	fd, err := syscall.Openat(int(directory.Fd()), name, syscall.O_RDONLY|syscall.O_NONBLOCK|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return terminalOperationRecord{}, fmt.Errorf("open operation journal %s: %w", name, err)
	}
	file := os.NewFile(uintptr(fd), path)
	if file == nil {
		_ = syscall.Close(fd)
		return terminalOperationRecord{}, fmt.Errorf("open operation journal %s: invalid file descriptor", name)
	}
	defer file.Close()
	openedInfo, err := file.Stat()
	if err != nil {
		return terminalOperationRecord{}, fmt.Errorf("inspect opened operation journal %s: %w", name, err)
	}
	if err := validateOperationJournalFile(openedInfo, expectedUID); err != nil {
		return terminalOperationRecord{}, fmt.Errorf("revalidate operation journal %s: %w", name, err)
	}
	if !os.SameFile(pathInfo, openedInfo) {
		return terminalOperationRecord{}, fmt.Errorf("operation journal %s changed while it was opened", name)
	}
	if openedInfo.Size() < 0 || openedInfo.Size() > maxOperationJournalBytes {
		return terminalOperationRecord{}, fmt.Errorf("operation journal %s exceeds %d-byte limit", name, maxOperationJournalBytes)
	}
	data, err := io.ReadAll(io.LimitReader(file, maxOperationJournalBytes+1))
	if err != nil {
		return terminalOperationRecord{}, fmt.Errorf("read operation journal %s: %w", name, err)
	}
	if int64(len(data)) > maxOperationJournalBytes {
		return terminalOperationRecord{}, fmt.Errorf("operation journal %s exceeds %d-byte limit", name, maxOperationJournalBytes)
	}
	var operation model.Operation
	if err := json.Unmarshal(data, &operation); err != nil {
		return terminalOperationRecord{}, fmt.Errorf("decode operation journal %s: %w", name, err)
	}
	return terminalOperationRecord{name: name, info: openedInfo, data: data, operation: operation}, nil
}

func validateOperationJournalDirectory(pathInfo, openedInfo os.FileInfo, expectedUID uint32) error {
	for _, info := range []os.FileInfo{pathInfo, openedInfo} {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("operation journal root is not a non-symlink directory")
		}
		metadata, ok := info.Sys().(*syscall.Stat_t)
		if !ok || metadata.Uid != expectedUID {
			return errors.New("operation journal root is not owned by the current identity")
		}
	}
	if pathInfo.Mode().Perm()&0o022 != 0 || openedInfo.Mode().Perm()&0o022 != 0 {
		return errors.New("operation journal root is writable by another host identity")
	}
	return nil
}

func validateOperationJournalFile(info os.FileInfo, expectedUID uint32) error {
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("journal is not a non-symlink regular file")
	}
	metadata, ok := info.Sys().(*syscall.Stat_t)
	if !ok || metadata.Uid != expectedUID {
		return errors.New("journal is not owned by the current identity")
	}
	if metadata.Nlink != 1 {
		return errors.New("journal has multiple hard links")
	}
	if info.Mode().Perm()&0o077 != 0 {
		return errors.New("journal is not owner-only")
	}
	return nil
}

func validateOperationJournalIdentity(operation model.Operation, expectedID string) error {
	if operation.SchemaVersion != 1 || operation.ID != expectedID {
		return errors.New("identity or schema mismatch")
	}
	if operation.IdempotencyKey == "" || operation.Attempt < 1 {
		return errors.New("idempotency identity is incomplete")
	}
	switch operation.Kind {
	case model.OperationInstall, model.OperationUpdate, model.OperationRestart, model.OperationRollback, model.OperationRepair:
	default:
		return fmt.Errorf("unknown operation kind %q", operation.Kind)
	}
	switch operation.Status {
	case model.OperationPending, model.OperationRunning, model.OperationSucceeded, model.OperationFailed:
	default:
		return fmt.Errorf("unknown operation status %q", operation.Status)
	}
	if operation.CreatedAt.IsZero() || operation.UpdatedAt.IsZero() || operation.UpdatedAt.Before(operation.CreatedAt) {
		return errors.New("operation timestamps are invalid")
	}
	return nil
}

func terminalOperationEligible(operation model.Operation, state model.ManagerState) bool {
	if operation.ID == state.ActiveOperationID || operation.ID == state.FinalizePendingOperationID || !operation.Finalized {
		return false
	}
	if operation.Status != model.OperationSucceeded && operation.Status != model.OperationFailed {
		return false
	}
	return operation.CompletedAt != nil && !operation.CompletedAt.IsZero() && !operation.CompletedAt.Before(operation.CreatedAt)
}
