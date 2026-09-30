//go:build linux

package executor

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
)

// managedFilePath keeps the trusted mount root separate from the
// untrusted relative path. All filesystem access below walks from an open root
// fd with O_NOFOLLOW, so a process cannot redirect a later Manager file call
// through a parent symlink.
type managedFilePath struct {
	root     string
	relative string
	readOnly bool
}

func (s FileService) sandboxPath(call Call, value string) (managedFilePath, error) {
	if call.Target != "sandbox" {
		return managedFilePath{}, errors.New("secure sandbox path requires target=sandbox")
	}
	if value == "" || strings.IndexByte(value, 0) >= 0 {
		return managedFilePath{}, errors.New("path is required")
	}
	spec, err := s.Sandboxes.Spec(call.ExecutionContext.SandboxID)
	if err != nil {
		return managedFilePath{}, err
	}

	logical := filepath.Clean(value)
	if !filepath.IsAbs(logical) {
		logical = filepath.Join(contract.ContainerWorkspace, logical)
	}
	attachmentRoot := filepath.Join(contract.ContainerWorkspace, s.profile.InternalWorkspaceDirectory, "attachments")
	type mapping struct {
		logical  string
		host     string
		readOnly bool
	}
	mappings := make([]mapping, 0, 4)
	// The attachment mount overlays a subtree of /workspace in the container.
	// Match it before the general workspace mapping so file tools see the same
	// bytes as terminal commands do, and enforce the mount's read-only contract.
	if spec.Attachments != "" {
		mappings = append(mappings, mapping{logical: attachmentRoot, host: spec.Attachments, readOnly: true})
	}
	mappings = append(mappings,
		mapping{logical: contract.ContainerWorkspace, host: spec.Workspace},
		mapping{logical: contract.ContainerAgentHome, host: spec.Home},
		mapping{logical: contract.ContainerAgentEnv, host: spec.Environment},
	)
	for _, candidate := range mappings {
		relative, ok := relativeBelow(candidate.logical, logical)
		if !ok {
			continue
		}
		path := managedFilePath{root: candidate.host, relative: relative, readOnly: candidate.readOnly}
		return path, nil
	}
	return managedFilePath{}, errors.New("sandbox file tools can access only persistent mounted paths")
}

func relativeBelow(root, path string) (string, bool) {
	if path == root {
		return ".", true
	}
	if !strings.HasPrefix(path, root+string(filepath.Separator)) {
		return "", false
	}
	relative := strings.TrimPrefix(path, root+string(filepath.Separator))
	clean := filepath.Clean(relative)
	if clean == "." || filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", false
	}
	return clean, true
}

func (path managedFilePath) rejectMutation() error {
	if path.readOnly {
		return errors.New("attachments are read-only")
	}
	return nil
}

func openManagedRegular(path managedFilePath) (*os.File, error) {
	parent, leaf, err := openManagedParent(path, false)
	if err != nil {
		return nil, err
	}
	defer parent.Close()
	if leaf == "." {
		return nil, errors.New("path is not a regular file")
	}
	fd, err := syscall.Openat(int(parent.Fd()), leaf, syscall.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, managedOpenError(err)
	}
	file := os.NewFile(uintptr(fd), leaf)
	if file == nil {
		_ = syscall.Close(fd)
		return nil, errors.New("open managed file failed")
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	if !info.Mode().IsRegular() {
		_ = file.Close()
		return nil, errors.New("path is not a regular file")
	}
	return file, nil
}

// openManagedParent returns an fd pinned to the final parent directory. Every
// traversed component is opened relative to the previous fd with O_NOFOLLOW;
// replacing a pathname concurrently therefore cannot redirect the operation.
func openManagedParent(path managedFilePath, createParents bool) (*os.File, string, error) {
	rootFD, err := syscall.Open(path.root, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, "", managedOpenError(err)
	}
	current := os.NewFile(uintptr(rootFD), "sandbox-root")
	if current == nil {
		_ = syscall.Close(rootFD)
		return nil, "", errors.New("open managed root failed")
	}
	parts, err := safeRelativeParts(path.relative)
	if err != nil {
		_ = current.Close()
		return nil, "", err
	}
	if len(parts) == 0 {
		return current, ".", nil
	}
	for _, part := range parts[:len(parts)-1] {
		nextFD, openErr := syscall.Openat(int(current.Fd()), part, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		if errors.Is(openErr, syscall.ENOENT) && createParents {
			mkdirErr := syscall.Mkdirat(int(current.Fd()), part, 0o700)
			if mkdirErr != nil && !errors.Is(mkdirErr, syscall.EEXIST) {
				_ = current.Close()
				return nil, "", fmt.Errorf("create managed directory: %w", mkdirErr)
			}
			nextFD, openErr = syscall.Openat(int(current.Fd()), part, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		}
		if openErr != nil {
			_ = current.Close()
			return nil, "", managedOpenError(openErr)
		}
		next := os.NewFile(uintptr(nextFD), part)
		if next == nil {
			_ = syscall.Close(nextFD)
			_ = current.Close()
			return nil, "", errors.New("open managed directory failed")
		}
		_ = current.Close()
		current = next
	}
	return current, parts[len(parts)-1], nil
}

func safeRelativeParts(relative string) ([]string, error) {
	clean := filepath.Clean(relative)
	if clean == "." {
		return nil, nil
	}
	if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return nil, errors.New("path escapes trusted filesystem root")
	}
	parts := strings.Split(clean, string(filepath.Separator))
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || strings.IndexByte(part, 0) >= 0 {
			return nil, errors.New("managed path contains an invalid component")
		}
	}
	return parts, nil
}

func managedOpenError(err error) error {
	if errors.Is(err, syscall.ELOOP) || errors.Is(err, syscall.ENOTDIR) {
		return errors.New("managed path contains a symbolic link or non-directory component")
	}
	return fmt.Errorf("open managed path: %w", err)
}

func writeManagedFile(path managedFilePath, data []byte, mode os.FileMode, temporaryPrefix string) error {
	if err := path.rejectMutation(); err != nil {
		return err
	}
	parent, leaf, err := openManagedParent(path, true)
	if err != nil {
		return err
	}
	defer parent.Close()
	return writeManagedFileAt(parent, leaf, data, mode, temporaryPrefix)
}

func writeManagedFileAt(parent *os.File, leaf string, data []byte, mode os.FileMode, temporaryPrefix string) error {
	if leaf == "." {
		return errors.New("path is a directory")
	}
	if err := validateManagedWriteTarget(parent, leaf); err != nil {
		return err
	}

	temporary, file, err := createTemporaryAt(parent, temporaryPrefix)
	if err != nil {
		return err
	}
	removeTemporary := true
	defer func() {
		_ = file.Close()
		if removeTemporary {
			_ = syscall.Unlinkat(int(parent.Fd()), temporary)
		}
	}()
	if err := file.Chmod(mode); err != nil {
		return fmt.Errorf("set managed file permissions: %w", err)
	}
	if _, err := file.Write(data); err != nil {
		return fmt.Errorf("write managed file: %w", err)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync managed file: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close managed file: %w", err)
	}
	if err := syscall.Renameat(int(parent.Fd()), temporary, int(parent.Fd()), leaf); err != nil {
		return fmt.Errorf("replace managed file: %w", err)
	}
	removeTemporary = false
	if err := syscall.Fsync(int(parent.Fd())); err != nil {
		return fmt.Errorf("sync managed directory: %w", err)
	}
	return nil
}

func validateManagedWriteTarget(parent *os.File, leaf string) error {
	fd, err := syscall.Openat(int(parent.Fd()), leaf, syscall.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if errors.Is(err, syscall.ENOENT) {
		return nil
	}
	if err != nil {
		return managedOpenError(err)
	}
	defer syscall.Close(fd)
	var stat syscall.Stat_t
	if err := syscall.Fstat(fd, &stat); err != nil {
		return err
	}
	if stat.Mode&syscall.S_IFMT != syscall.S_IFREG {
		return errors.New("path is not a regular file")
	}
	return nil
}

func createTemporaryAt(parent *os.File, temporaryPrefix string) (string, *os.File, error) {
	if temporaryPrefix == "" || strings.Contains(temporaryPrefix, string(filepath.Separator)) {
		return "", nil, errors.New("managed temporary-file prefix is invalid")
	}
	for attempt := 0; attempt < 16; attempt++ {
		random := make([]byte, 12)
		if _, err := rand.Read(random); err != nil {
			return "", nil, err
		}
		name := temporaryPrefix + "-write-" + hex.EncodeToString(random)
		fd, err := syscall.Openat(int(parent.Fd()), name, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o600)
		if errors.Is(err, syscall.EEXIST) {
			continue
		}
		if err != nil {
			return "", nil, fmt.Errorf("create temporary managed file: %w", err)
		}
		file := os.NewFile(uintptr(fd), name)
		if file == nil {
			_ = syscall.Close(fd)
			_ = syscall.Unlinkat(int(parent.Fd()), name)
			return "", nil, errors.New("create temporary managed file failed")
		}
		return name, file, nil
	}
	return "", nil, errors.New("could not allocate temporary managed file")
}
