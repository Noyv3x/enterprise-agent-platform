package snapshot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/atomicfile"
)

type Entry struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
	Mode   uint32 `json:"mode"`
}
type Manifest struct {
	SchemaVersion int       `json:"schema_version"`
	OperationID   string    `json:"operation_id"`
	CreatedAt     time.Time `json:"created_at"`
	Entries       []Entry   `json:"entries"`
}

type Store struct {
	DataDir, BackupDir string
	Retention          time.Duration
	renamePath         func(string, string) error
	syncDir            func(string) error
}

var managedFiles = []string{"platform.db", "platform.db-wal", "platform.db-shm", "bootstrap-admin-password.txt"}

type validatedEntry struct {
	entry  Entry
	source string
}

func (s Store) Create(ctx context.Context, operationID string) (string, error) {
	if !safeID(operationID) {
		return "", fmt.Errorf("invalid operation id")
	}
	dir := filepath.Join(s.BackupDir, operationID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	manifest := Manifest{SchemaVersion: 1, OperationID: operationID, CreatedAt: time.Now().UTC()}
	for _, name := range managedFiles {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		default:
		}
		source := filepath.Join(s.DataDir, name)
		info, err := os.Lstat(source)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return "", err
		}
		if !info.Mode().IsRegular() {
			return "", fmt.Errorf("snapshot source %s is not a regular file", name)
		}
		dest := filepath.Join(dir, name)
		digest, err := copyFile(source, dest, info.Mode().Perm())
		if err != nil {
			return "", err
		}
		manifest.Entries = append(manifest.Entries, Entry{Path: name, Size: info.Size(), SHA256: digest, Mode: uint32(info.Mode().Perm())})
	}
	if err := atomicfile.WriteJSON(filepath.Join(dir, "manifest.json"), manifest, 0o600); err != nil {
		return "", err
	}
	// The copied files and manifest are not a durable snapshot until both the
	// snapshot directory entries and the operation directory's entry in the
	// backup root have reached stable storage.
	if err := s.syncDirectory(dir); err != nil {
		return "", fmt.Errorf("sync snapshot directory: %w", err)
	}
	if err := s.syncDirectory(s.BackupDir); err != nil {
		return "", fmt.Errorf("sync snapshot backup directory: %w", err)
	}
	return dir, nil
}

func (s Store) Restore(ctx context.Context, path string) error {
	_, entries, err := s.validateSnapshot(ctx, path)
	if err != nil {
		return err
	}
	if err := validateDataDirectory(s.DataDir); err != nil {
		return err
	}
	transactionDir, err := os.MkdirTemp(s.DataDir, ".snapshot-restore-")
	if err != nil {
		return fmt.Errorf("create restore transaction: %w", err)
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.RemoveAll(transactionDir)
		}
	}()
	stagingDir := filepath.Join(transactionDir, "staging")
	previousDir := filepath.Join(transactionDir, "previous")
	if err := os.Mkdir(stagingDir, 0o700); err != nil {
		return fmt.Errorf("create restore staging directory: %w", err)
	}
	if err := os.Mkdir(previousDir, 0o700); err != nil {
		return fmt.Errorf("create restore backup directory: %w", err)
	}

	for _, name := range managedFiles {
		validated, ok := entries[name]
		if !ok {
			continue
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		destination := filepath.Join(stagingDir, name)
		digest, copyErr := copyFile(validated.source, destination, os.FileMode(validated.entry.Mode))
		if copyErr != nil {
			return fmt.Errorf("stage snapshot entry %s: %w", name, copyErr)
		}
		if digest != validated.entry.SHA256 {
			return fmt.Errorf("snapshot changed while staging %s", name)
		}
		stagedInfo, statErr := os.Lstat(destination)
		if statErr != nil {
			return fmt.Errorf("inspect staged snapshot entry %s: %w", name, statErr)
		}
		if !stagedInfo.Mode().IsRegular() || stagedInfo.Size() != validated.entry.Size {
			return fmt.Errorf("staged snapshot entry %s does not match manifest", name)
		}
	}
	if err := s.syncDirectory(stagingDir); err != nil {
		return fmt.Errorf("sync restore staging directory: %w", err)
	}
	if err := validateCurrentFiles(s.DataDir); err != nil {
		return err
	}

	// Keep the transaction directory after any commit error. Even when the
	// synchronous compensation succeeds, retaining both sides gives repair
	// tooling enough evidence to recover from an underlying persistent I/O
	// failure instead of deleting the only remaining copy.
	cleanup = false
	if err := s.commitRestore(stagingDir, previousDir, entries); err != nil {
		return err
	}
	if err := os.RemoveAll(transactionDir); err != nil {
		return fmt.Errorf("remove committed restore transaction: %w", err)
	}
	return nil
}

func (s Store) validateSnapshot(ctx context.Context, path string) (string, map[string]validatedEntry, error) {
	clean, err := filepath.Abs(path)
	if err != nil {
		return "", nil, err
	}
	root, err := filepath.Abs(s.BackupDir)
	if err != nil {
		return "", nil, err
	}
	if filepath.Dir(clean) != root {
		return "", nil, fmt.Errorf("snapshot must be a direct child of backup root")
	}
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", nil, fmt.Errorf("resolve backup root: %w", err)
	}
	realSnapshot, err := filepath.EvalSymlinks(clean)
	if err != nil {
		return "", nil, fmt.Errorf("resolve snapshot: %w", err)
	}
	if filepath.Dir(realSnapshot) != realRoot {
		return "", nil, fmt.Errorf("snapshot is outside backup root")
	}
	info, err := os.Lstat(clean)
	if err != nil {
		return "", nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", nil, fmt.Errorf("snapshot path is not a regular directory")
	}
	manifestPath := filepath.Join(clean, "manifest.json")
	manifestInfo, err := os.Lstat(manifestPath)
	if err != nil {
		return "", nil, err
	}
	if !manifestInfo.Mode().IsRegular() {
		return "", nil, fmt.Errorf("snapshot manifest is not a regular file")
	}
	var manifest Manifest
	if err := atomicfile.ReadJSON(manifestPath, &manifest); err != nil {
		return "", nil, err
	}
	if manifest.SchemaVersion != 1 {
		return "", nil, fmt.Errorf("unsupported snapshot schema version %d", manifest.SchemaVersion)
	}
	if !safeID(manifest.OperationID) || manifest.OperationID != filepath.Base(clean) {
		return "", nil, fmt.Errorf("snapshot operation id does not match its directory")
	}
	allowed := make(map[string]struct{}, len(managedFiles))
	for _, name := range managedFiles {
		allowed[name] = struct{}{}
	}
	validated := make(map[string]validatedEntry, len(manifest.Entries))
	for _, entry := range manifest.Entries {
		select {
		case <-ctx.Done():
			return "", nil, ctx.Err()
		default:
		}
		if filepath.Base(entry.Path) != entry.Path {
			return "", nil, fmt.Errorf("invalid snapshot entry %q", entry.Path)
		}
		if _, ok := allowed[entry.Path]; !ok {
			return "", nil, fmt.Errorf("unknown snapshot entry %q", entry.Path)
		}
		if _, duplicate := validated[entry.Path]; duplicate {
			return "", nil, fmt.Errorf("duplicate snapshot entry %q", entry.Path)
		}
		if entry.Size < 0 || entry.Mode & ^uint32(os.ModePerm) != 0 {
			return "", nil, fmt.Errorf("invalid snapshot metadata for %s", entry.Path)
		}
		digestBytes, decodeErr := hex.DecodeString(entry.SHA256)
		if decodeErr != nil || len(digestBytes) != sha256.Size || hex.EncodeToString(digestBytes) != entry.SHA256 {
			return "", nil, fmt.Errorf("invalid snapshot checksum for %s", entry.Path)
		}
		source := filepath.Join(clean, entry.Path)
		sourceInfo, statErr := os.Lstat(source)
		if statErr != nil {
			return "", nil, fmt.Errorf("inspect snapshot entry %s: %w", entry.Path, statErr)
		}
		if !sourceInfo.Mode().IsRegular() {
			return "", nil, fmt.Errorf("snapshot entry %s is not a regular file", entry.Path)
		}
		if sourceInfo.Size() != entry.Size || uint32(sourceInfo.Mode().Perm()) != entry.Mode {
			return "", nil, fmt.Errorf("snapshot entry %s metadata does not match manifest", entry.Path)
		}
		digest, digestErr := fileDigest(source)
		if digestErr != nil {
			return "", nil, fmt.Errorf("read snapshot entry %s: %w", entry.Path, digestErr)
		}
		if digest != entry.SHA256 {
			return "", nil, fmt.Errorf("snapshot checksum mismatch for %s", entry.Path)
		}
		validated[entry.Path] = validatedEntry{entry: entry, source: source}
	}
	return clean, validated, nil
}

func validateDataDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("inspect data directory: %w", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("data directory is not a regular directory")
	}
	return nil
}

func validateCurrentFiles(dataDir string) error {
	for _, name := range managedFiles {
		info, err := os.Lstat(filepath.Join(dataDir, name))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return fmt.Errorf("inspect current data file %s: %w", name, err)
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("current data file %s is not a regular file", name)
		}
	}
	return nil
}

func (s Store) commitRestore(stagingDir, previousDir string, entries map[string]validatedEntry) error {
	movedPrevious := make(map[string]bool, len(managedFiles))
	installed := make(map[string]bool, len(entries))
	compensate := func(cause error) error {
		var compensationErr error
		for index := len(managedFiles) - 1; index >= 0; index-- {
			name := managedFiles[index]
			if !installed[name] {
				continue
			}
			if err := s.rename(filepath.Join(s.DataDir, name), filepath.Join(stagingDir, name)); err != nil {
				compensationErr = errors.Join(compensationErr, fmt.Errorf("remove uncommitted %s: %w", name, err))
			}
		}
		for index := len(managedFiles) - 1; index >= 0; index-- {
			name := managedFiles[index]
			if !movedPrevious[name] {
				continue
			}
			if err := s.rename(filepath.Join(previousDir, name), filepath.Join(s.DataDir, name)); err != nil {
				compensationErr = errors.Join(compensationErr, fmt.Errorf("restore previous %s: %w", name, err))
			}
		}
		if err := s.syncDirectory(s.DataDir); err != nil {
			compensationErr = errors.Join(compensationErr, fmt.Errorf("sync compensated data directory: %w", err))
		}
		if compensationErr != nil {
			return errors.Join(cause, fmt.Errorf("restore compensation failed: %w", compensationErr))
		}
		return cause
	}

	for _, name := range managedFiles {
		target := filepath.Join(s.DataDir, name)
		if _, err := os.Lstat(target); os.IsNotExist(err) {
			continue
		} else if err != nil {
			return compensate(fmt.Errorf("inspect current %s during restore commit: %w", name, err))
		}
		if err := s.rename(target, filepath.Join(previousDir, name)); err != nil {
			return compensate(fmt.Errorf("back up current %s: %w", name, err))
		}
		movedPrevious[name] = true
	}
	if err := s.syncDirectory(previousDir); err != nil {
		return compensate(fmt.Errorf("sync previous data backup: %w", err))
	}
	if err := s.syncDirectory(s.DataDir); err != nil {
		return compensate(fmt.Errorf("sync data backup switch: %w", err))
	}
	for _, name := range managedFiles {
		if _, ok := entries[name]; !ok {
			continue
		}
		if err := s.rename(filepath.Join(stagingDir, name), filepath.Join(s.DataDir, name)); err != nil {
			return compensate(fmt.Errorf("install restored %s: %w", name, err))
		}
		installed[name] = true
	}
	if err := s.syncDirectory(s.DataDir); err != nil {
		return compensate(fmt.Errorf("sync restored data directory: %w", err))
	}
	return nil
}

func (s Store) rename(source, destination string) error {
	if s.renamePath != nil {
		return s.renamePath(source, destination)
	}
	return os.Rename(source, destination)
}

func (s Store) syncDirectory(path string) error {
	if s.syncDir != nil {
		return s.syncDir(path)
	}
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func (s Store) Prune(now time.Time) error {
	retention := s.Retention
	if retention <= 0 {
		retention = 7 * 24 * time.Hour
	}
	entries, err := os.ReadDir(s.BackupDir)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if now.Sub(info.ModTime()) > retention {
			if err := os.RemoveAll(filepath.Join(s.BackupDir, entry.Name())); err != nil {
				return err
			}
		}
	}
	return nil
}

func copyFile(source, destination string, mode os.FileMode) (string, error) {
	in, err := os.Open(source)
	if err != nil {
		return "", err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return "", err
	}
	out, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return "", err
	}
	keep := false
	defer func() {
		_ = out.Close()
		if !keep {
			_ = os.Remove(destination)
		}
	}()
	if err := out.Chmod(mode.Perm()); err != nil {
		return "", err
	}
	hash := sha256.New()
	_, copyErr := io.Copy(io.MultiWriter(out, hash), in)
	syncErr := out.Sync()
	closeErr := out.Close()
	if copyErr != nil {
		return "", copyErr
	}
	if syncErr != nil {
		return "", syncErr
	}
	if closeErr != nil {
		return "", closeErr
	}
	keep = true
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func fileDigest(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
func safeID(id string) bool {
	if id == "" || len(id) > 128 {
		return false
	}
	for _, r := range id {
		if !(r == '_' || r == '-' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') {
			return false
		}
	}
	return true
}
