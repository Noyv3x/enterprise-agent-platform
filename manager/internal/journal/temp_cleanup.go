package journal

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
)

// cleanupOperationAtomicResiduesLocked runs with Store.mu held. The Manager
// startup lease prevents a second application Store for the same state root,
// and recovery/watchdog processes only read operation evidence, so this mutex
// is the operation journal domain's complete writer exclusion proof.
func (s *Store) cleanupOperationAtomicResiduesLocked() error {
	directory := filepath.Clean(s.operations)
	if !filepath.IsAbs(directory) || directory != s.operations {
		return fmt.Errorf("operation journal directory is not absolute and canonical")
	}
	fd, err := syscall.Open(directory, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return fmt.Errorf("open operation journal directory for atomic cleanup: %w", err)
	}
	opened := os.NewFile(uintptr(fd), directory)
	if opened == nil {
		_ = syscall.Close(fd)
		return fmt.Errorf("open operation journal directory for atomic cleanup: invalid file descriptor")
	}
	defer opened.Close()
	result, err := atomicfile.CleanupManagedTemps(opened, directory, atomicfile.ManagedTempCleanupPolicy{
		Now: time.Now().UTC(), ExclusiveWriter: true,
	})
	if err != nil {
		return fmt.Errorf("clean operation journal atomic residues: %w", err)
	}
	if result.Retained != 0 {
		return fmt.Errorf("operation journal cleanup retained %d artifacts despite exclusive writer ownership", result.Retained)
	}
	return nil
}
