//go:build linux

package executor

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"

	"github.com/ubitech/agent-platform/manager/internal/contract"
)

// sandboxFilePath keeps the trusted mount root separate from the untrusted
// relative path. All filesystem access below walks from an open root fd with
// O_NOFOLLOW, so a Sandbox process cannot redirect a later Manager file call
// through a parent symlink into the host filesystem.
type sandboxFilePath struct {
	root     string
	relative string
	readOnly bool
}

func (s FileService) sandboxPath(call Call, value string) (sandboxFilePath, error) {
	if call.Target != "sandbox" {
		return sandboxFilePath{}, errors.New("secure sandbox path requires target=sandbox")
	}
	if value == "" || strings.IndexByte(value, 0) >= 0 {
		return sandboxFilePath{}, errors.New("path is required")
	}
	spec, err := s.Sandboxes.Spec(call.ExecutionContext.SandboxID)
	if err != nil {
		return sandboxFilePath{}, err
	}

	logical := filepath.Clean(value)
	if !filepath.IsAbs(logical) {
		logical = filepath.Join(contract.ContainerWorkspace, logical)
	}
	attachmentRoot := filepath.Join(contract.ContainerWorkspace, ".ubitech", "attachments")
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
		return sandboxFilePath{root: candidate.host, relative: relative, readOnly: candidate.readOnly}, nil
	}
	return sandboxFilePath{}, errors.New("sandbox file tools can access only persistent mounted paths")
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

func (path sandboxFilePath) rejectMutation() error {
	if path.readOnly {
		return errors.New("attachments are read-only")
	}
	return nil
}

func openSandboxRegular(path sandboxFilePath) (*os.File, error) {
	parent, leaf, err := openSandboxParent(path, false)
	if err != nil {
		return nil, err
	}
	defer parent.Close()
	if leaf == "." {
		return nil, errors.New("path is not a regular file")
	}
	fd, err := syscall.Openat(int(parent.Fd()), leaf, syscall.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, sandboxOpenError(err)
	}
	file := os.NewFile(uintptr(fd), leaf)
	if file == nil {
		_ = syscall.Close(fd)
		return nil, errors.New("open sandbox file failed")
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

// openSandboxParent returns an fd pinned to the final parent directory. Every
// traversed component is opened relative to the previous fd with O_NOFOLLOW;
// replacing a pathname concurrently therefore cannot redirect the operation.
func openSandboxParent(path sandboxFilePath, createParents bool) (*os.File, string, error) {
	rootFD, err := syscall.Open(path.root, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, "", sandboxOpenError(err)
	}
	current := os.NewFile(uintptr(rootFD), "sandbox-root")
	if current == nil {
		_ = syscall.Close(rootFD)
		return nil, "", errors.New("open sandbox root failed")
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
				return nil, "", fmt.Errorf("create sandbox directory: %w", mkdirErr)
			}
			nextFD, openErr = syscall.Openat(int(current.Fd()), part, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		}
		if openErr != nil {
			_ = current.Close()
			return nil, "", sandboxOpenError(openErr)
		}
		next := os.NewFile(uintptr(nextFD), part)
		if next == nil {
			_ = syscall.Close(nextFD)
			_ = current.Close()
			return nil, "", errors.New("open sandbox directory failed")
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
		return nil, errors.New("path escapes sandbox mount")
	}
	parts := strings.Split(clean, string(filepath.Separator))
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || strings.IndexByte(part, 0) >= 0 {
			return nil, errors.New("sandbox path contains an invalid component")
		}
	}
	return parts, nil
}

func sandboxOpenError(err error) error {
	if errors.Is(err, syscall.ELOOP) || errors.Is(err, syscall.ENOTDIR) {
		return errors.New("sandbox path contains a symbolic link or non-directory component")
	}
	return fmt.Errorf("open sandbox path: %w", err)
}

func writeSandboxFile(path sandboxFilePath, data []byte, mode os.FileMode) error {
	if err := path.rejectMutation(); err != nil {
		return err
	}
	parent, leaf, err := openSandboxParent(path, true)
	if err != nil {
		return err
	}
	defer parent.Close()
	if leaf == "." {
		return errors.New("path is a directory")
	}
	if err := validateSandboxWriteTarget(parent, leaf); err != nil {
		return err
	}

	temporary, file, err := createTemporaryAt(parent)
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
		return fmt.Errorf("set sandbox file permissions: %w", err)
	}
	if _, err := file.Write(data); err != nil {
		return fmt.Errorf("write sandbox file: %w", err)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync sandbox file: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close sandbox file: %w", err)
	}
	if err := syscall.Renameat(int(parent.Fd()), temporary, int(parent.Fd()), leaf); err != nil {
		return fmt.Errorf("replace sandbox file: %w", err)
	}
	removeTemporary = false
	if err := syscall.Fsync(int(parent.Fd())); err != nil {
		return fmt.Errorf("sync sandbox directory: %w", err)
	}
	return nil
}

func validateSandboxWriteTarget(parent *os.File, leaf string) error {
	fd, err := syscall.Openat(int(parent.Fd()), leaf, syscall.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if errors.Is(err, syscall.ENOENT) {
		return nil
	}
	if err != nil {
		return sandboxOpenError(err)
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

func createTemporaryAt(parent *os.File) (string, *os.File, error) {
	for attempt := 0; attempt < 16; attempt++ {
		random := make([]byte, 12)
		if _, err := rand.Read(random); err != nil {
			return "", nil, err
		}
		name := ".ubitech-write-" + hex.EncodeToString(random)
		fd, err := syscall.Openat(int(parent.Fd()), name, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o600)
		if errors.Is(err, syscall.EEXIST) {
			continue
		}
		if err != nil {
			return "", nil, fmt.Errorf("create temporary sandbox file: %w", err)
		}
		file := os.NewFile(uintptr(fd), name)
		if file == nil {
			_ = syscall.Close(fd)
			_ = syscall.Unlinkat(int(parent.Fd()), name)
			return "", nil, errors.New("create temporary sandbox file failed")
		}
		return name, file, nil
	}
	return "", nil, errors.New("could not allocate temporary sandbox file")
}

func searchSandbox(ctx context.Context, path sandboxFilePath, matcher *regexp.Regexp, max int) ([]string, error) {
	root, err := openSandboxNode(path)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	results := make([]string, 0, max)
	if err := searchSandboxNode(ctx, root, ".", matcher, max, &results); err != nil {
		return nil, err
	}
	return results, nil
}

func openSandboxNode(path sandboxFilePath) (*os.File, error) {
	if path.relative == "." {
		fd, err := syscall.Open(path.root, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		if err != nil {
			return nil, sandboxOpenError(err)
		}
		file := os.NewFile(uintptr(fd), "sandbox-root")
		if file == nil {
			_ = syscall.Close(fd)
			return nil, errors.New("open sandbox search root failed")
		}
		return file, nil
	}
	parent, leaf, err := openSandboxParent(path, false)
	if err != nil {
		return nil, err
	}
	defer parent.Close()
	fd, err := syscall.Openat(int(parent.Fd()), leaf, syscall.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, sandboxOpenError(err)
	}
	file := os.NewFile(uintptr(fd), leaf)
	if file == nil {
		_ = syscall.Close(fd)
		return nil, errors.New("open sandbox search path failed")
	}
	return file, nil
}

func searchSandboxNode(ctx context.Context, node *os.File, relative string, matcher *regexp.Regexp, max int, results *[]string) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	if len(*results) >= max {
		return nil
	}
	if matcher.MatchString(relative) {
		*results = append(*results, relative+": filename match")
		if len(*results) >= max {
			return nil
		}
	}
	info, err := node.Stat()
	if err != nil {
		return err
	}
	if info.Mode().IsRegular() {
		if info.Size() > 2<<20 {
			return nil
		}
		return scanSandboxFile(node, relative, matcher, max, results)
	}
	if !info.IsDir() {
		return nil
	}
	entries, err := node.Readdir(-1)
	if err != nil {
		return err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, entry := range entries {
		if len(*results) >= max {
			return nil
		}
		name := entry.Name()
		if name == "" || name == "." || name == ".." || strings.ContainsRune(name, filepath.Separator) {
			continue
		}
		childRelative := name
		if relative != "." {
			childRelative = filepath.Join(relative, name)
		}
		fd, openErr := syscall.Openat(int(node.Fd()), name, syscall.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		if errors.Is(openErr, syscall.ELOOP) || errors.Is(openErr, syscall.ENOENT) {
			// Match symlink names for parity with filepath.WalkDir, but never
			// follow their content or a concurrently replaced entry.
			if matcher.MatchString(childRelative) {
				*results = append(*results, childRelative+": filename match")
			}
			continue
		}
		if openErr != nil {
			return sandboxOpenError(openErr)
		}
		child := os.NewFile(uintptr(fd), name)
		if child == nil {
			_ = syscall.Close(fd)
			return errors.New("open sandbox search entry failed")
		}
		err = searchSandboxNode(ctx, child, childRelative, matcher, max, results)
		_ = child.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

func scanSandboxFile(file *os.File, relative string, matcher *regexp.Regexp, max int, results *[]string) error {
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 2<<20)
	line := 0
	for scanner.Scan() && len(*results) < max {
		line++
		text := scanner.Text()
		if !matcher.MatchString(text) {
			continue
		}
		if len(text) > 500 {
			text = text[:500]
		}
		*results = append(*results, fmt.Sprintf("%s:%d:%s", relative, line, text))
	}
	return scanner.Err()
}
