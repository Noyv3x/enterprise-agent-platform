package snapshot

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
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
	StagingRetention   time.Duration
	RemovalGuard       release.RemovalGuard
	renamePath         func(string, string) error
	syncDir            func(string) error
	copyPath           func(string, string, os.FileMode) (string, error)
}

// Verify validates a rollback snapshot without changing the live database.
func (s Store) Verify(ctx context.Context, path string) error {
	_, _, err := s.validateSnapshot(ctx, path)
	return err
}

var managedFiles = []string{"platform.db", "platform.db-wal", "platform.db-shm", "bootstrap-admin-password.txt"}

// RequiredBytes returns a conservative upper bound for one snapshot of the
// current managed files. Sparse files are charged at their logical size, while
// filesystems which allocate more blocks than the logical length are charged at
// the allocated size. Callers must still recheck after quiescing admissions.
func RequiredBytes(ctx context.Context, dataDir string) (uint64, error) {
	var required uint64
	for _, name := range managedFiles {
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		default:
		}
		path := filepath.Join(dataDir, name)
		info, err := os.Lstat(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return 0, fmt.Errorf("inspect snapshot source %s: %w", name, err)
		}
		if !info.Mode().IsRegular() || info.Size() < 0 {
			return 0, fmt.Errorf("snapshot source %s is not a regular file", name)
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || stat.Blocks < 0 {
			return 0, fmt.Errorf("snapshot source %s has unavailable allocation metadata", name)
		}
		logical := uint64(info.Size())
		blocks := uint64(stat.Blocks)
		if blocks > ^uint64(0)/512 {
			return 0, fmt.Errorf("snapshot source %s allocated size overflows", name)
		}
		allocated := blocks * 512
		if allocated > logical {
			logical = allocated
		}
		if required > ^uint64(0)-logical {
			return 0, errors.New("snapshot source size total overflows")
		}
		required += logical
	}
	return required, nil
}

type validatedEntry struct {
	entry  Entry
	source string
}

func (s Store) Create(ctx context.Context, operationID string) (path string, resultErr error) {
	if !safeID(operationID) {
		return "", fmt.Errorf("invalid operation id")
	}
	if err := os.MkdirAll(s.BackupDir, 0o700); err != nil {
		return "", err
	}
	encodedID := base64.RawURLEncoding.EncodeToString([]byte(operationID))
	staging, err := os.MkdirTemp(s.BackupDir, ".snapshot-"+encodedID+".*")
	if err != nil {
		return "", fmt.Errorf("create snapshot staging directory: %w", err)
	}
	if err := os.Chmod(staging, 0o700); err != nil {
		_ = os.RemoveAll(staging)
		return "", fmt.Errorf("restrict snapshot staging directory: %w", err)
	}
	published := false
	renamed := false
	finalPath := filepath.Join(s.BackupDir, operationID)
	defer func() {
		if published {
			return
		}
		cleanupErr := error(nil)
		if renamed {
			cleanupErr = s.removeUncommittedSnapshot(finalPath, operationID)
		} else {
			cleanupErr = removeSnapshotStaging(staging)
		}
		if cleanupErr == nil {
			cleanupErr = s.syncDirectory(s.BackupDir)
		}
		if cleanupErr != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("clean failed snapshot staging: %w", cleanupErr))
		}
	}()
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
		dest := filepath.Join(staging, name)
		digest, err := s.copyFile(source, dest, info.Mode().Perm())
		if err != nil {
			return "", err
		}
		manifest.Entries = append(manifest.Entries, Entry{Path: name, Size: info.Size(), SHA256: digest, Mode: uint32(info.Mode().Perm())})
	}
	if err := atomicfile.WriteJSON(filepath.Join(staging, "manifest.json"), manifest, 0o600); err != nil {
		return "", err
	}
	// The copied files and manifest are not a durable snapshot until both the
	// snapshot directory entries and the operation directory's entry in the
	// backup root have reached stable storage.
	if err := s.syncDirectory(staging); err != nil {
		return "", fmt.Errorf("sync snapshot directory: %w", err)
	}
	if _, err := os.Lstat(finalPath); err == nil {
		return "", errors.New("snapshot destination already exists")
	} else if !os.IsNotExist(err) {
		return "", fmt.Errorf("inspect snapshot destination: %w", err)
	}
	if err := os.Rename(staging, finalPath); err != nil {
		return "", fmt.Errorf("publish snapshot directory: %w", err)
	}
	renamed = true
	if err := s.syncDirectory(s.BackupDir); err != nil {
		return "", fmt.Errorf("sync snapshot backup directory: %w", err)
	}
	published = true
	return finalPath, nil
}

func (s Store) copyFile(source, destination string, mode os.FileMode) (string, error) {
	if s.copyPath != nil {
		return s.copyPath(source, destination, mode)
	}
	return copyFile(source, destination, mode)
}

func (s Store) removeUncommittedSnapshot(path, operationID string) error {
	manifest, _, err := s.validateSnapshot(context.Background(), path)
	if err != nil {
		return fmt.Errorf("validate uncommitted snapshot: %w", err)
	}
	var identity Manifest
	if err := atomicfile.ReadJSON(filepath.Join(manifest, "manifest.json"), &identity); err != nil {
		return err
	}
	if identity.OperationID != operationID || filepath.Base(manifest) != operationID {
		return errors.New("uncommitted snapshot identity changed")
	}
	return os.RemoveAll(manifest)
}

func removeSnapshotStaging(path string) error {
	if err := validateSnapshotStaging(path); err != nil {
		return err
	}
	return os.RemoveAll(path)
}

func snapshotStagingOperationID(name string) (string, bool) {
	const prefix = ".snapshot-"
	if !strings.HasPrefix(name, prefix) {
		return "", false
	}
	encoded, suffix, ok := strings.Cut(strings.TrimPrefix(name, prefix), ".")
	if !ok || encoded == "" || suffix == "" {
		return "", false
	}
	for _, character := range suffix {
		if character < '0' || character > '9' {
			return "", false
		}
	}
	decoded, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || !safeID(string(decoded)) {
		return "", false
	}
	return string(decoded), true
}

func validateSnapshotStaging(path string) error {
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 {
		return errors.New("snapshot staging path is not a private regular directory")
	}
	if _, ok := snapshotStagingOperationID(filepath.Base(path)); !ok {
		return errors.New("snapshot staging path has an invalid operation identity")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != os.Getuid() {
		return errors.New("snapshot staging path is not owned by the Manager user")
	}
	allowed := map[string]struct{}{"manifest.json": {}}
	for _, name := range managedFiles {
		allowed[name] = struct{}{}
	}
	contents, err := os.ReadDir(path)
	if err != nil {
		return err
	}
	for _, content := range contents {
		if _, known := allowed[content.Name()]; !known && !strings.HasPrefix(content.Name(), ".tmp-") {
			return fmt.Errorf("unknown file in snapshot staging directory: %s", content.Name())
		}
		entryInfo, err := os.Lstat(filepath.Join(path, content.Name()))
		if err != nil || !entryInfo.Mode().IsRegular() || entryInfo.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("snapshot staging content %s is not a regular file", content.Name())
		}
		entryStat, ok := entryInfo.Sys().(*syscall.Stat_t)
		if !ok || int(entryStat.Uid) != os.Getuid() {
			return fmt.Errorf("snapshot staging content %s has invalid ownership", content.Name())
		}
	}
	return nil
}

func (s Store) Restore(ctx context.Context, path string) error {
	_, entries, err := s.validateSnapshot(ctx, path)
	if err != nil {
		return err
	}
	s.DataDir = filepath.Clean(s.DataDir)
	if err := s.ensureDataDirectoryForRestore(); err != nil {
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
	contents, err := os.ReadDir(clean)
	if err != nil {
		return "", nil, fmt.Errorf("list snapshot contents: %w", err)
	}
	allowedContents := map[string]struct{}{"manifest.json": {}}
	for name := range validated {
		allowedContents[name] = struct{}{}
	}
	for _, content := range contents {
		if _, ok := allowedContents[content.Name()]; !ok {
			return "", nil, fmt.Errorf("unknown file in snapshot: %s", content.Name())
		}
		if content.Type()&os.ModeSymlink != 0 || !content.Type().IsRegular() {
			info, infoErr := content.Info()
			if infoErr != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
				return "", nil, fmt.Errorf("snapshot content %s is not a regular file", content.Name())
			}
		}
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
	if err := validateOwnerOnlyDirectory(path, info); err != nil {
		return err
	}
	return nil
}

// ensureDataDirectoryForRestore permits one narrowly-scoped recreation path:
// a rollback journal has already selected and fully validated the snapshot,
// but an interrupted rollback removed its uncommitted destination.
// Only the final data directory may be absent. Its existing parent remains the
// trust anchor and must be a real directory owned by the Manager user.
func (s Store) ensureDataDirectoryForRestore() error {
	if !filepath.IsAbs(s.DataDir) {
		return errors.New("data directory must be absolute")
	}
	s.DataDir = filepath.Clean(s.DataDir)
	parent := filepath.Dir(s.DataDir)
	if parent == s.DataDir {
		return errors.New("refusing to recreate an unsafe data directory")
	}
	parentInfo, err := os.Lstat(parent)
	if err != nil {
		return fmt.Errorf("inspect data directory parent: %w", err)
	}
	if !parentInfo.IsDir() || parentInfo.Mode()&os.ModeSymlink != 0 {
		return errors.New("data directory parent is not a regular directory")
	}
	if err := validateDirectoryOwner(parent, parentInfo); err != nil {
		return fmt.Errorf("data directory parent: %w", err)
	}
	dataInfo, err := os.Lstat(s.DataDir)
	if os.IsNotExist(err) {
		if err := os.Mkdir(s.DataDir, 0o700); err != nil && !os.IsExist(err) {
			return fmt.Errorf("recreate data directory: %w", err)
		}
	} else if err != nil {
		return fmt.Errorf("inspect data directory: %w", err)
	} else if !dataInfo.IsDir() || dataInfo.Mode()&os.ModeSymlink != 0 {
		return errors.New("data directory is not a regular directory")
	} else if err := validateOwnerOnlyDirectory(s.DataDir, dataInfo); err != nil {
		return err
	}
	if err := validateDataDirectory(s.DataDir); err != nil {
		return err
	}
	if err := s.syncDirectory(parent); err != nil {
		return fmt.Errorf("sync recreated data directory parent: %w", err)
	}
	return nil
}

func validateDirectoryOwner(path string, info os.FileInfo) error {
	metadata, ok := info.Sys().(*syscall.Stat_t)
	if !ok || metadata.Uid != uint32(os.Getuid()) {
		return fmt.Errorf("directory %s is not owned by the Manager user", path)
	}
	if info.Mode().Perm()&0o022 != 0 {
		return fmt.Errorf("directory %s is writable by another host identity", path)
	}
	return nil
}

func validateOwnerOnlyDirectory(path string, info os.FileInfo) error {
	if err := validateDirectoryOwner(path, info); err != nil {
		return err
	}
	if info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("directory %s is accessible by another host identity", path)
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

// Prune removes only expired, fully validated snapshots that are not referenced
// by a current generation or unfinished operation. Unknown or damaged entries
// are retained so maintenance can never turn a diagnostic anomaly into data
// loss.
func (s Store) Prune(ctx context.Context, now time.Time, protected map[string]struct{}) (int, error) {
	retention := s.Retention
	if retention <= 0 {
		retention = 7 * 24 * time.Hour
	}
	stagingRetention := s.StagingRetention
	if stagingRetention <= 0 {
		stagingRetention = time.Hour
	}
	entries, err := os.ReadDir(s.BackupDir)
	if os.IsNotExist(err) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	canonicalProtected := make(map[string]struct{}, len(protected))
	for path := range protected {
		if path == "" {
			continue
		}
		absolute, absoluteErr := filepath.Abs(path)
		if absoluteErr != nil {
			return 0, absoluteErr
		}
		canonicalProtected[filepath.Clean(absolute)] = struct{}{}
	}
	removed := 0
	for _, entry := range entries {
		select {
		case <-ctx.Done():
			return removed, ctx.Err()
		default:
		}
		if _, staging := snapshotStagingOperationID(entry.Name()); staging {
			path := filepath.Join(s.BackupDir, entry.Name())
			info, infoErr := entry.Info()
			if infoErr != nil || now.Sub(info.ModTime()) <= stagingRetention || validateSnapshotStaging(path) != nil {
				continue
			}
			releaseGuard := func() {}
			if s.RemovalGuard != nil {
				var ok bool
				releaseGuard, ok = s.RemovalGuard()
				if !ok {
					continue
				}
			}
			err := removeSnapshotStaging(path)
			releaseGuard()
			if err != nil {
				return removed, err
			}
			removed++
			continue
		}
		if entry.Type()&os.ModeSymlink != 0 || !entry.IsDir() || !safeID(entry.Name()) {
			continue
		}
		path := filepath.Join(s.BackupDir, entry.Name())
		absolute, absoluteErr := filepath.Abs(path)
		if absoluteErr != nil {
			return removed, absoluteErr
		}
		if _, keep := canonicalProtected[filepath.Clean(absolute)]; keep {
			continue
		}
		clean, _, validateErr := s.validateSnapshot(ctx, path)
		if validateErr != nil {
			continue
		}
		var manifest Manifest
		if readErr := atomicfile.ReadJSON(filepath.Join(clean, "manifest.json"), &manifest); readErr != nil {
			continue
		}
		if manifest.CreatedAt.IsZero() || now.Sub(manifest.CreatedAt) <= retention {
			continue
		}
		// Revalidate at the deletion boundary. A failed or interrupted snapshot
		// writer may have left new evidence after the first verification; such a
		// directory must be retained rather than recursively removed.
		rechecked, _, recheckErr := s.validateSnapshot(ctx, clean)
		if recheckErr != nil || rechecked != clean {
			continue
		}
		releaseGuard := func() {}
		if s.RemovalGuard != nil {
			var ok bool
			releaseGuard, ok = s.RemovalGuard()
			if !ok {
				continue
			}
		}
		err := os.RemoveAll(rechecked)
		releaseGuard()
		if err != nil {
			return removed, err
		}
		removed++
	}
	if removed > 0 {
		if err := s.syncDirectory(s.BackupDir); err != nil {
			return removed, fmt.Errorf("sync snapshot backup directory after prune: %w", err)
		}
	}
	return removed, nil
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
