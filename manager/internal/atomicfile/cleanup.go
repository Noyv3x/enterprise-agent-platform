package atomicfile

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const managedTempPrefix = ".tmp-"

// ManagedTempCleanupPolicy describes the two deletion gates supported by the
// atomic writer. ExclusiveWriter may only be set by a caller that already owns
// the entire directory's cross-process writer domain. Other callers must use a
// positive Grace matching the obsolete-artifact retention policy.
type ManagedTempCleanupPolicy struct {
	Now               time.Time
	Grace             time.Duration
	ExclusiveWriter   bool
	DurableReferences []string
}

// ManagedTempCleanupResult reports exact atomic-writer residues. Retained
// files are still evidence and must not be silently accepted by a domain
// enumerator.
type ManagedTempCleanupResult struct {
	Removed  int
	Retained int
}

// IsManagedTempName recognizes exactly the names produced by
// os.CreateTemp(dir, ".tmp-*") in WriteFile. os.nextRandom formats a uint32 in
// base 10, so accepting letters, punctuation, suffixes, or more than ten
// digits would expand the cleanup authority beyond this package's writer.
func IsManagedTempName(name string) bool {
	if !strings.HasPrefix(name, managedTempPrefix) {
		return false
	}
	suffix := strings.TrimPrefix(name, managedTempPrefix)
	if len(suffix) < 1 || len(suffix) > 10 {
		return false
	}
	for index := range suffix {
		if suffix[index] < '0' || suffix[index] > '9' {
			return false
		}
	}
	return true
}

// ValidateDurableReference rejects a durable path whose leaf could be removed
// as an atomic-write residue. Durable schemas should normally impose a still
// narrower canonical filename; this check keeps the deletion contract explicit
// at cleanup boundaries.
func ValidateDurableReference(path string) error {
	if path == "" {
		return nil
	}
	if IsManagedTempName(filepath.Base(filepath.Clean(path))) {
		return fmt.Errorf("durable reference %q names a managed temporary file", path)
	}
	return nil
}

// CleanupManagedTemps removes only exact crash-left files created by WriteFile
// from an already-open, canonical, owner-owned directory. The opened directory
// is the authority used by openat/unlinkat; canonicalPath is only an identity
// view and must resolve to the same inode.
func CleanupManagedTemps(directory *os.File, canonicalPath string, policy ManagedTempCleanupPolicy) (ManagedTempCleanupResult, error) {
	return cleanupManagedTemps(directory, canonicalPath, policy, uint32(os.Geteuid()), managedTempCleanupHooks{})
}

type managedTempCleanupHooks struct {
	beforeOpen         func(string)
	beforeUnlink       func(string)
	afterDirectorySync func(string)
}

func cleanupManagedTemps(
	directory *os.File,
	canonicalPath string,
	policy ManagedTempCleanupPolicy,
	expectedUID uint32,
	hooks managedTempCleanupHooks,
) (ManagedTempCleanupResult, error) {
	var result ManagedTempCleanupResult
	if directory == nil {
		return result, errors.New("managed temporary cleanup directory is not open")
	}
	if canonicalPath == "" || !filepath.IsAbs(canonicalPath) || filepath.Clean(canonicalPath) != canonicalPath {
		return result, errors.New("managed temporary cleanup directory path is not absolute and canonical")
	}
	resolvedPath, err := filepath.EvalSymlinks(canonicalPath)
	if err != nil {
		return result, fmt.Errorf("resolve managed temporary cleanup directory: %w", err)
	}
	if resolvedPath != canonicalPath {
		return result, errors.New("managed temporary cleanup directory path contains a symbolic link")
	}
	if !policy.ExclusiveWriter && policy.Grace <= 0 {
		return result, errors.New("managed temporary cleanup without an exclusive writer requires a positive grace period")
	}
	if policy.Now.IsZero() {
		return result, errors.New("managed temporary cleanup time is required")
	}
	for _, reference := range policy.DurableReferences {
		if err := ValidateDurableReference(reference); err != nil {
			return result, err
		}
	}

	pathInfo, err := os.Lstat(canonicalPath)
	if err != nil {
		return result, fmt.Errorf("inspect managed temporary cleanup directory: %w", err)
	}
	openedInfo, err := directory.Stat()
	if err != nil {
		return result, fmt.Errorf("inspect opened managed temporary cleanup directory: %w", err)
	}
	if err := validateManagedTempDirectory(pathInfo, openedInfo, expectedUID); err != nil {
		return result, err
	}
	if !os.SameFile(pathInfo, openedInfo) {
		return result, errors.New("managed temporary cleanup directory changed while it was opened")
	}
	if _, err := directory.Seek(0, 0); err != nil {
		return result, fmt.Errorf("rewind managed temporary cleanup directory: %w", err)
	}
	entries, err := directory.ReadDir(-1)
	if err != nil {
		return result, fmt.Errorf("enumerate managed temporary cleanup directory: %w", err)
	}
	for _, entry := range entries {
		name := entry.Name()
		if !IsManagedTempName(name) {
			if strings.HasPrefix(name, managedTempPrefix) {
				return result, fmt.Errorf("unknown atomic temporary artifact %q", name)
			}
			continue
		}
		if hooks.beforeOpen != nil {
			hooks.beforeOpen(name)
		}
		candidatePath := filepath.Join(canonicalPath, name)
		pathCandidate, err := os.Lstat(candidatePath)
		if err != nil {
			return result, fmt.Errorf("inspect managed temporary artifact %q: %w", name, err)
		}
		if err := validateManagedTempCandidate(pathCandidate, expectedUID); err != nil {
			return result, fmt.Errorf("validate managed temporary artifact %q: %w", name, err)
		}

		fd, err := syscall.Openat(int(directory.Fd()), name, syscall.O_RDONLY|syscall.O_NONBLOCK|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
		if err != nil {
			return result, fmt.Errorf("open managed temporary artifact %q: %w", name, err)
		}
		candidate := os.NewFile(uintptr(fd), candidatePath)
		if candidate == nil {
			_ = syscall.Close(fd)
			return result, fmt.Errorf("open managed temporary artifact %q: invalid file descriptor", name)
		}
		openedCandidate, statErr := candidate.Stat()
		if statErr == nil {
			statErr = validateManagedTempCandidate(openedCandidate, expectedUID)
		}
		if statErr == nil && !os.SameFile(pathCandidate, openedCandidate) {
			statErr = errors.New("artifact changed while it was opened")
		}
		if statErr != nil {
			_ = candidate.Close()
			return result, fmt.Errorf("revalidate managed temporary artifact %q: %w", name, statErr)
		}
		if !policy.ExclusiveWriter && policy.Now.Sub(openedCandidate.ModTime()) <= policy.Grace {
			result.Retained++
			_ = candidate.Close()
			continue
		}
		if hooks.beforeUnlink != nil {
			hooks.beforeUnlink(name)
		}
		latestPathCandidate, err := os.Lstat(candidatePath)
		if err != nil {
			_ = candidate.Close()
			return result, fmt.Errorf("reinspect managed temporary artifact %q before unlink: %w", name, err)
		}
		if err := validateManagedTempCandidate(latestPathCandidate, expectedUID); err != nil {
			_ = candidate.Close()
			return result, fmt.Errorf("revalidate managed temporary artifact %q before unlink: %w", name, err)
		}
		if !os.SameFile(openedCandidate, latestPathCandidate) {
			_ = candidate.Close()
			return result, fmt.Errorf("managed temporary artifact %q changed before unlink", name)
		}
		if err := syscall.Unlinkat(int(directory.Fd()), name); err != nil {
			_ = candidate.Close()
			return result, fmt.Errorf("unlink managed temporary artifact %q: %w", name, err)
		}
		if err := directory.Sync(); err != nil {
			_ = candidate.Close()
			return result, fmt.Errorf("sync managed temporary cleanup directory after unlinking %q: %w", name, err)
		}
		if hooks.afterDirectorySync != nil {
			hooks.afterDirectorySync(name)
		}
		if err := candidate.Close(); err != nil {
			return result, fmt.Errorf("close removed managed temporary artifact %q: %w", name, err)
		}
		result.Removed++
	}
	return result, nil
}

func validateManagedTempDirectory(pathInfo, openedInfo os.FileInfo, expectedUID uint32) error {
	for _, info := range []os.FileInfo{pathInfo, openedInfo} {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("managed temporary cleanup root is not a non-symlink directory")
		}
		metadata, ok := info.Sys().(*syscall.Stat_t)
		if !ok || metadata.Uid != expectedUID {
			return errors.New("managed temporary cleanup root is not owned by the current identity")
		}
	}
	if pathInfo.Mode().Perm()&0o022 != 0 || openedInfo.Mode().Perm()&0o022 != 0 {
		return errors.New("managed temporary cleanup root is writable by another host identity")
	}
	return nil
}

func validateManagedTempCandidate(info os.FileInfo, expectedUID uint32) error {
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("artifact is not a non-symlink regular file")
	}
	metadata, ok := info.Sys().(*syscall.Stat_t)
	if !ok || metadata.Uid != expectedUID {
		return errors.New("artifact is not owned by the current identity")
	}
	if metadata.Nlink != 1 {
		return errors.New("artifact has multiple hard links")
	}
	return nil
}
