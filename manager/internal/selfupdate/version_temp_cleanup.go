package selfupdate

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
)

// cleanupVersionAtomicResiduesLocked runs only while the caller holds the
// global recovery lock. Prepare, controlled recovery and version maintenance
// all share that lock, so it excludes every writer of the versions domain.
func (m *Manager) cleanupVersionAtomicResiduesLocked(now time.Time, state State) error {
	if _, err := validatedStartupVersionDirectories(m, state); err != nil {
		return err
	}
	references := startupDurableReferences(m, state)
	for _, reference := range references {
		if err := atomicfile.ValidateDurableReference(reference); err != nil {
			return err
		}
	}
	root := filepath.Join(m.Root, "versions")
	if !filepath.IsAbs(root) || filepath.Clean(root) != root {
		return errors.New("Manager version root is not absolute and canonical")
	}
	rootInfo, err := os.Lstat(root)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect Manager version root for atomic cleanup: %w", err)
	}
	if err := validateRecoveryDirectory(root, true); err != nil {
		return fmt.Errorf("validate Manager version root for atomic cleanup: %w", err)
	}
	fd, err := syscall.Open(root, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return fmt.Errorf("open Manager version root for atomic cleanup: %w", err)
	}
	opened := os.NewFile(uintptr(fd), root)
	if opened == nil {
		_ = syscall.Close(fd)
		return errors.New("open Manager version root for atomic cleanup: invalid file descriptor")
	}
	defer opened.Close()
	openedInfo, err := opened.Stat()
	if err != nil || !os.SameFile(rootInfo, openedInfo) {
		if err == nil {
			err = errors.New("directory changed while it was opened")
		}
		return fmt.Errorf("revalidate Manager version root for atomic cleanup: %w", err)
	}
	entries, err := opened.ReadDir(-1)
	if err != nil {
		return fmt.Errorf("enumerate Manager version root for atomic cleanup: %w", err)
	}
	var cleanupErrors []error
	for _, entry := range entries {
		name := entry.Name()
		if name == "" || filepath.Base(name) != name || safeID(name) != name || entry.Type()&os.ModeSymlink != 0 || !entry.IsDir() {
			continue
		}
		directory := filepath.Join(root, name)
		childFD, openErr := syscall.Open(directory, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
		if openErr != nil {
			cleanupErrors = append(cleanupErrors, fmt.Errorf("open Manager version directory %s for atomic cleanup: %w", name, openErr))
			continue
		}
		child := os.NewFile(uintptr(childFD), directory)
		if child == nil {
			_ = syscall.Close(childFD)
			cleanupErrors = append(cleanupErrors, fmt.Errorf("open Manager version directory %s for atomic cleanup: invalid file descriptor", name))
			continue
		}
		result, cleanupErr := atomicfile.CleanupManagedTemps(child, directory, atomicfile.ManagedTempCleanupPolicy{
			Now: now, ExclusiveWriter: true, DurableReferences: references,
		})
		closeErr := child.Close()
		if cleanupErr != nil {
			cleanupErrors = append(cleanupErrors, fmt.Errorf("clean Manager version directory %s atomic residues: %w", name, cleanupErr))
			continue
		}
		if closeErr != nil {
			cleanupErrors = append(cleanupErrors, fmt.Errorf("close Manager version directory %s after atomic cleanup: %w", name, closeErr))
			continue
		}
		if result.Retained != 0 {
			cleanupErrors = append(cleanupErrors, fmt.Errorf("Manager version directory %s retained %d artifacts despite exclusive writer ownership", name, result.Retained))
		}
	}
	return errors.Join(cleanupErrors...)
}

// cleanupAgedAtomicResiduesLocked covers non-startup-critical Manager state
// directories during low-frequency maintenance. Watchdogs do not share the
// global recovery lock for every one of these directories, so even though the
// caller holds that lock, this path always retains files inside the ordinary
// obsolete-artifact grace window.
func (m *Manager) cleanupAgedAtomicResiduesLocked(now time.Time, grace time.Duration, state State) error {
	if _, err := validatedStartupVersionDirectories(m, state); err != nil {
		return err
	}
	references := startupDurableReferences(m, state)
	for _, reference := range references {
		if err := atomicfile.ValidateDurableReference(reference); err != nil {
			return err
		}
	}
	directories := []string{
		filepath.Dir(m.StatePath),
		filepath.Join(m.Root, "activations"),
		filepath.Join(m.Root, "recoveries"),
	}
	var cleanupErrors []error
	for _, directory := range directories {
		result, err := cleanupAgedAtomicResidueDirectory(directory, now, grace, references)
		if err != nil {
			cleanupErrors = append(cleanupErrors, err)
			continue
		}
		// A fresh artifact is intentionally not an error in a directory that
		// is unrelated to the current startup identity. The next maintenance
		// pass will reconsider it after the grace period.
		_ = result.Retained
	}
	return errors.Join(cleanupErrors...)
}

func cleanupAgedAtomicResidueDirectory(directory string, now time.Time, grace time.Duration, references []string) (atomicfile.ManagedTempCleanupResult, error) {
	var empty atomicfile.ManagedTempCleanupResult
	if !filepath.IsAbs(directory) || filepath.Clean(directory) != directory {
		return empty, fmt.Errorf("managed atomic residue directory %q is not absolute and canonical", directory)
	}
	if _, err := os.Lstat(directory); os.IsNotExist(err) {
		return empty, nil
	} else if err != nil {
		return empty, fmt.Errorf("inspect managed atomic residue directory %s: %w", directory, err)
	}
	fd, err := syscall.Open(directory, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return empty, fmt.Errorf("open managed atomic residue directory %s: %w", directory, err)
	}
	opened := os.NewFile(uintptr(fd), directory)
	if opened == nil {
		_ = syscall.Close(fd)
		return empty, fmt.Errorf("open managed atomic residue directory %s: invalid file descriptor", directory)
	}
	defer opened.Close()
	result, err := atomicfile.CleanupManagedTemps(opened, directory, atomicfile.ManagedTempCleanupPolicy{
		Now: now, Grace: grace, DurableReferences: references,
	})
	if err != nil {
		return result, fmt.Errorf("clean aged atomic residues in %s: %w", directory, err)
	}
	return result, nil
}
