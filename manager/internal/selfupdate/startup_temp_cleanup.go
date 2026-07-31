package selfupdate

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
)

// cleanupStartupAtomicResidues is called only after AcquireStartupOwnership
// has obtained the free global recovery lease and before any application
// writer is constructed. That boundary is the single-writer proof for both the
// self-update and operation journal directories. A global-busy/probe-only
// startup must never call this helper.
func (m *Manager) cleanupStartupAtomicResidues() error {
	state, err := m.load()
	if err != nil {
		return fmt.Errorf("read Manager state before cleaning startup atomic residues: %w", err)
	}
	references := startupDurableReferences(m, state)
	for _, reference := range references {
		if err := atomicfile.ValidateDurableReference(reference); err != nil {
			return fmt.Errorf("validate startup durable reference: %w", err)
		}
	}
	versionDirectories, err := validatedStartupVersionDirectories(m, state)
	if err != nil {
		return err
	}

	stateDirectory := filepath.Dir(m.StatePath)
	directories := []struct {
		path        string
		exclusive   bool
		mustBeClear bool
	}{
		// Operation journals have no watchdog writer. Before application
		// construction, the retained serve startup lease proves this domain
		// has no writer and permits immediate crash cleanup.
		{path: filepath.Join(stateDirectory, "operations"), exclusive: true, mustBeClear: true},
		// recoveries is enumerated as a closed-world startup identity set.
		// A fresh watchdog write is retained and must fence this startup until
		// the writer completes or the residue ages out.
		{path: filepath.Join(m.Root, "recoveries"), mustBeClear: true},
	}
	seen := make(map[string]struct{}, len(directories)+3)
	for _, directory := range directories {
		if err := m.cleanupStartupAtomicResidueDirectory(directory.path, references, directory.exclusive, directory.mustBeClear, seen); err != nil {
			return err
		}
	}
	for _, directory := range versionDirectories {
		if err := m.cleanupStartupAtomicResidueDirectory(directory, references, true, true, seen); err != nil {
			return err
		}
	}
	return nil
}

// validatedStartupVersionDirectories converts durable version identities into
// deletion roots without trusting their path strings. Every accepted binary is
// the fixed leaf of one direct child of Root/versions, and the directory name
// must be derivable from the version's immutable identity.
func validatedStartupVersionDirectories(m *Manager, state State) ([]string, error) {
	versionsRoot := filepath.Join(m.Root, "versions")
	if m.Root == "" || !filepath.IsAbs(m.Root) || filepath.Clean(m.Root) != m.Root ||
		!filepath.IsAbs(versionsRoot) || filepath.Clean(versionsRoot) != versionsRoot {
		return nil, errors.New("Manager version root is not absolute and canonical")
	}
	seen := make(map[string]struct{}, 3)
	directories := make([]string, 0, 3)
	for _, version := range []*Version{state.Current, state.Previous, state.Candidate} {
		if version == nil {
			continue
		}
		path := version.Path
		if path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path ||
			filepath.Base(path) != m.managerBinaryName() || filepath.Dir(filepath.Dir(path)) != versionsRoot {
			return nil, errors.New("durable Manager version path is outside the fixed versions root")
		}
		directory := filepath.Dir(path)
		if !validVersionDirectoryIdentity(filepath.Base(directory), *version) {
			return nil, errors.New("durable Manager version directory identity is invalid")
		}
		if _, ok := seen[directory]; ok {
			continue
		}
		seen[directory] = struct{}{}
		directories = append(directories, directory)
	}
	return directories, nil
}

func startupDurableReferences(m *Manager, state State) []string {
	references := []string{m.StatePath, m.InstallPath, m.SocketPath, m.ControlTokenFile}
	for _, version := range []*Version{state.Current, state.Previous, state.Candidate} {
		if version != nil {
			references = append(references, version.Path)
		}
	}
	if state.Activation != nil {
		references = append(references, state.Activation.PlanPath, state.Activation.CandidatePath)
	}
	return references
}

func (m *Manager) cleanupStartupAtomicResidueDirectory(directory string, references []string, exclusive, mustBeClear bool, seen map[string]struct{}) error {
	if directory == "" || !filepath.IsAbs(directory) || filepath.Clean(directory) != directory {
		return fmt.Errorf("startup atomic residue directory %q is not absolute and canonical", directory)
	}
	if _, ok := seen[directory]; ok {
		return nil
	}
	seen[directory] = struct{}{}
	info, err := os.Lstat(directory)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect startup atomic residue directory %s: %w", directory, err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("startup atomic residue root %s is not a non-symlink directory", directory)
	}
	fd, err := syscall.Open(directory, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return fmt.Errorf("open startup atomic residue directory %s: %w", directory, err)
	}
	opened := os.NewFile(uintptr(fd), directory)
	if opened == nil {
		_ = syscall.Close(fd)
		return fmt.Errorf("open startup atomic residue directory %s: invalid file descriptor", directory)
	}
	defer opened.Close()
	result, err := atomicfile.CleanupManagedTemps(opened, directory, atomicfile.ManagedTempCleanupPolicy{
		Now:               m.now(),
		Grace:             time.Duration(contract.ObsoleteArtifactRetentionSeconds) * time.Second,
		ExclusiveWriter:   exclusive,
		DurableReferences: references,
	})
	if err != nil {
		return fmt.Errorf("clean startup atomic residues in %s: %w", directory, err)
	}
	if mustBeClear && result.Retained != 0 {
		return fmt.Errorf("startup atomic residue cleanup in %s retained %d fresh artifacts without exclusive writer proof", directory, result.Retained)
	}
	return nil
}
