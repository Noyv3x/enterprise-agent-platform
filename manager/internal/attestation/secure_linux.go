//go:build linux

package attestation

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

type fileIdentity struct {
	device uint64
	inode  uint64
}

type directoryNode struct {
	identity fileIdentity
	uid      uint32
	mode     uint32
}

type directoryChain struct {
	components []string
	nodes      []directoryNode
	complete   bool
}

type secureDirectory struct {
	file     *os.File
	path     string
	identity fileIdentity
}

type secureStateRoot struct {
	service   *Service
	stateHome *secureDirectory
	namespace *secureDirectory
	root      *secureDirectory
}

func (directory *secureDirectory) close() {
	if directory != nil && directory.file != nil {
		_ = directory.file.Close()
	}
}

func (root *secureStateRoot) close() {
	if root == nil {
		return
	}
	root.root.close()
	root.namespace.close()
	root.stateHome.close()
}

func (s *Service) openRoot() (*secureStateRoot, error) {
	if s.Root == "" || !filepath.IsAbs(s.Root) || filepath.Clean(s.Root) != s.Root {
		return nil, errors.New("release transition state root must be an absolute canonical path")
	}
	if filepath.Base(s.Root) != "release-transition" || filepath.Base(filepath.Dir(s.Root)) != "agent-platform" {
		return nil, errors.New("release transition state root has an unexpected identity")
	}
	stateHome := s.StateHome
	if stateHome == "" {
		stateHome = filepath.Dir(filepath.Dir(s.Root))
	}
	if !filepath.IsAbs(stateHome) || filepath.Clean(stateHome) != stateHome {
		return nil, errors.New("XDG state home must be an absolute canonical path")
	}
	if filepath.Join(stateHome, "agent-platform", "release-transition") != s.Root {
		return nil, errors.New("release transition state root is not below the configured XDG state home")
	}
	if err := validateOperatingSystemAccountHome(); err != nil {
		return nil, err
	}
	for _, forbidden := range s.ForbiddenRoots {
		if forbidden == "" {
			continue
		}
		if !filepath.IsAbs(forbidden) || filepath.Clean(forbidden) != forbidden || pathsContainEachOther(s.Root, forbidden) {
			return nil, errors.New("release transition state root overlaps a managed data root")
		}
	}
	if err := rejectPhysicalOverlap(s.Root, s.ForbiddenRoots); err != nil {
		return nil, fmt.Errorf("release transition state root physically overlaps a managed data root: %w", err)
	}

	stateHomeDirectory, err := openOwnerAnchor(stateHome, "XDG state home")
	if err != nil {
		return nil, err
	}
	result := &secureStateRoot{service: s, stateHome: stateHomeDirectory}
	fail := true
	defer func() {
		if fail {
			result.close()
		}
	}()
	result.namespace, err = openOrCreateOwnerDirectory(stateHomeDirectory, "agent-platform")
	if err != nil {
		return nil, fmt.Errorf("open release transition namespace directory: %w", err)
	}
	result.root, err = openOrCreateOwnerDirectory(result.namespace, "release-transition")
	if err != nil {
		return nil, fmt.Errorf("open release transition state root: %w", err)
	}
	if err := result.verify(); err != nil {
		return nil, err
	}
	fail = false
	return result, nil
}

func validateOperatingSystemAccountHome() error {
	account, err := user.Current()
	if err != nil {
		return fmt.Errorf("resolve operating-system account home: %w", err)
	}
	home := filepath.Clean(account.HomeDir)
	if account.Uid != strconv.Itoa(os.Getuid()) || account.HomeDir != home || !filepath.IsAbs(home) || home == string(filepath.Separator) {
		return errors.New("operating-system account has an invalid home directory")
	}
	directory, err := openOwnerAnchor(home, "operating-system account home")
	if err != nil {
		return err
	}
	directory.close()
	return nil
}

func openOwnerAnchor(path, label string) (*secureDirectory, error) {
	chain, file, err := openAbsoluteDirectoryChain(path, false)
	if err != nil {
		return nil, fmt.Errorf("validate %s: %w", label, err)
	}
	if !chain.complete || file == nil || len(chain.nodes) == 0 {
		return nil, fmt.Errorf("%s does not exist", label)
	}
	uid := uint32(os.Getuid())
	for _, node := range chain.nodes {
		if node.uid != 0 && node.uid != uid {
			file.Close()
			return nil, fmt.Errorf("%s has an ancestor not owned by root or the current account", label)
		}
		writableStickyRoot := node.uid == 0 && node.mode&syscall.S_ISVTX != 0
		if os.FileMode(node.mode).Perm()&0o022 != 0 && !writableStickyRoot {
			file.Close()
			return nil, fmt.Errorf("%s has a group- or world-writable ancestor", label)
		}
	}
	last := chain.nodes[len(chain.nodes)-1]
	if last.uid != uid {
		file.Close()
		return nil, fmt.Errorf("%s must be owned by the current account", label)
	}
	return &secureDirectory{file: file, path: path, identity: last.identity}, nil
}

// openAbsoluteDirectoryChain walks an absolute canonical path from a pinned
// root descriptor. Every component is opened relative to the previous fd with
// O_NOFOLLOW, so a path replacement cannot redirect a later component open.
// When allowMissing is true, the chain stops at the first missing component.
func openAbsoluteDirectoryChain(path string, allowMissing bool) (directoryChain, *os.File, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return directoryChain{}, nil, errors.New("path must be absolute and canonical")
	}
	components := splitAbsolutePath(path)
	rootFD, err := syscall.Open(string(filepath.Separator), syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return directoryChain{}, nil, err
	}
	current := os.NewFile(uintptr(rootFD), string(filepath.Separator))
	if current == nil {
		_ = syscall.Close(rootFD)
		return directoryChain{}, nil, errors.New("open filesystem root failed")
	}
	rootNode, err := directoryNodeForFD(int(current.Fd()))
	if err != nil {
		current.Close()
		return directoryChain{}, nil, err
	}
	chain := directoryChain{components: components, nodes: []directoryNode{rootNode}, complete: true}
	for _, component := range components {
		fd, openErr := syscall.Openat(int(current.Fd()), component, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
		if openErr != nil {
			if allowMissing && errors.Is(openErr, syscall.ENOENT) {
				chain.complete = false
				return chain, current, nil
			}
			current.Close()
			return directoryChain{}, nil, openErr
		}
		next := os.NewFile(uintptr(fd), component)
		if next == nil {
			_ = syscall.Close(fd)
			current.Close()
			return directoryChain{}, nil, errors.New("open directory component failed")
		}
		node, statErr := directoryNodeForFD(fd)
		if statErr != nil {
			next.Close()
			current.Close()
			return directoryChain{}, nil, statErr
		}
		current.Close()
		current = next
		chain.nodes = append(chain.nodes, node)
	}
	return chain, current, nil
}

func splitAbsolutePath(path string) []string {
	trimmed := strings.TrimPrefix(path, string(filepath.Separator))
	if trimmed == "" {
		return nil
	}
	return strings.Split(trimmed, string(filepath.Separator))
}

func directoryNodeForFD(fd int) (directoryNode, error) {
	var stat syscall.Stat_t
	if err := syscall.Fstat(fd, &stat); err != nil {
		return directoryNode{}, err
	}
	if stat.Mode&syscall.S_IFMT != syscall.S_IFDIR {
		return directoryNode{}, errors.New("path component is not a directory")
	}
	return directoryNode{
		identity: fileIdentity{device: uint64(stat.Dev), inode: stat.Ino},
		uid:      stat.Uid,
		mode:     stat.Mode,
	}, nil
}

func openOrCreateOwnerDirectory(parent *secureDirectory, name string) (*secureDirectory, error) {
	if !safeLeafName(name) {
		return nil, errors.New("directory name is invalid")
	}
	created := false
	if err := syscall.Mkdirat(int(parent.file.Fd()), name, 0o700); err != nil {
		if !errors.Is(err, syscall.EEXIST) {
			return nil, err
		}
	} else {
		created = true
		if err := parent.file.Sync(); err != nil {
			return nil, fmt.Errorf("sync parent directory after mkdir: %w", err)
		}
	}
	fd, err := syscall.Openat(int(parent.file.Fd()), name, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), filepath.Join(parent.path, name))
	if file == nil {
		_ = syscall.Close(fd)
		return nil, errors.New("open owner directory failed")
	}
	if created {
		if err := syscall.Fchmod(fd, 0o700); err != nil {
			file.Close()
			return nil, err
		}
	}
	node, err := directoryNodeForFD(fd)
	if err != nil {
		file.Close()
		return nil, err
	}
	if node.uid != uint32(os.Getuid()) || os.FileMode(node.mode).Perm() != 0o700 {
		file.Close()
		return nil, errors.New("release transition directory must be an owner-owned 0700 directory")
	}
	directory := &secureDirectory{file: file, path: filepath.Join(parent.path, name), identity: node.identity}
	if err := verifyDirectoryEntry(parent, name, directory.identity); err != nil {
		directory.close()
		return nil, err
	}
	return directory, nil
}

func openOwnerChildDirectory(parent *secureDirectory, name string) (*secureDirectory, error) {
	if !safeLeafName(name) {
		return nil, errors.New("directory name is invalid")
	}
	fd, err := syscall.Openat(int(parent.file.Fd()), name, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), filepath.Join(parent.path, name))
	if file == nil {
		_ = syscall.Close(fd)
		return nil, errors.New("open owner directory failed")
	}
	node, err := directoryNodeForFD(fd)
	if err != nil {
		file.Close()
		return nil, err
	}
	if node.uid != uint32(os.Getuid()) || os.FileMode(node.mode).Perm() != 0o700 {
		file.Close()
		return nil, errors.New("release transition directory must be an owner-owned 0700 directory")
	}
	directory := &secureDirectory{file: file, path: filepath.Join(parent.path, name), identity: node.identity}
	if err := verifyDirectoryEntry(parent, name, directory.identity); err != nil {
		directory.close()
		return nil, err
	}
	return directory, nil
}

func verifyDirectoryEntry(parent *secureDirectory, name string, expected fileIdentity) error {
	fd, err := syscall.Openat(int(parent.file.Fd()), name, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return errors.New("release transition directory identity changed")
	}
	defer syscall.Close(fd)
	node, err := directoryNodeForFD(fd)
	if err != nil || node.identity != expected {
		return errors.New("release transition directory identity changed")
	}
	return nil
}

func (root *secureStateRoot) verify() error {
	stateHome, err := openOwnerAnchor(root.stateHome.path, "XDG state home")
	if err != nil {
		return err
	}
	stateIdentity := stateHome.identity
	stateHome.close()
	if stateIdentity != root.stateHome.identity {
		return errors.New("XDG state home identity changed")
	}
	if err := verifyDirectoryEntry(root.stateHome, "agent-platform", root.namespace.identity); err != nil {
		return err
	}
	if err := verifyDirectoryEntry(root.namespace, "release-transition", root.root.identity); err != nil {
		return err
	}
	if err := rejectPhysicalOverlap(root.service.Root, root.service.ForbiddenRoots); err != nil {
		return fmt.Errorf("release transition state root identity changed into a managed data root: %w", err)
	}
	chain, file, err := openAbsoluteDirectoryChain(root.service.Root, false)
	if file != nil {
		file.Close()
	}
	if err != nil || !chain.complete || len(chain.nodes) == 0 || chain.nodes[len(chain.nodes)-1].identity != root.root.identity {
		return errors.New("release transition state root path identity changed")
	}
	return nil
}

func pathsContainEachOther(first, second string) bool {
	contains := func(parent, child string) bool {
		relative, err := filepath.Rel(parent, child)
		return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
	}
	return contains(first, second) || contains(second, first)
}

func rejectPhysicalOverlap(stateRoot string, forbiddenRoots []string) error {
	state, file, err := openAbsoluteDirectoryChain(stateRoot, true)
	if file != nil {
		file.Close()
	}
	if err != nil {
		return err
	}
	for _, forbiddenRoot := range forbiddenRoots {
		if forbiddenRoot == "" {
			continue
		}
		forbidden, forbiddenFile, err := openAbsoluteDirectoryChain(forbiddenRoot, true)
		if forbiddenFile != nil {
			forbiddenFile.Close()
		}
		if err != nil {
			return err
		}
		if chainsCanContainEachOther(state, forbidden) {
			return fmt.Errorf("%s aliases or contains %s", stateRoot, forbiddenRoot)
		}
	}
	return nil
}

func chainsCanContainEachOther(left, right directoryChain) bool {
	for leftDepth, leftNode := range left.nodes {
		for rightDepth, rightNode := range right.nodes {
			if leftNode.identity != rightNode.identity {
				continue
			}
			leftRemaining := left.components[leftDepth:]
			rightRemaining := right.components[rightDepth:]
			if stringSlicePrefix(leftRemaining, rightRemaining) || stringSlicePrefix(rightRemaining, leftRemaining) {
				return true
			}
		}
	}
	return false
}

func stringSlicePrefix(prefix, value []string) bool {
	if len(prefix) > len(value) {
		return false
	}
	for index := range prefix {
		if prefix[index] != value[index] {
			return false
		}
	}
	return true
}

func safeLeafName(name string) bool {
	return name != "" && name != "." && name != ".." && filepath.Base(name) == name && !strings.ContainsRune(name, rune(filepath.Separator))
}

func writeImmutableOwnerFileAt(directory *secureDirectory, name string, data []byte) (returnErr error) {
	if !safeLeafName(name) {
		return errors.New("release transition state filename is invalid")
	}
	fd, err := syscall.Openat(int(directory.file.Fd()), name, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		if errors.Is(err, syscall.EEXIST) {
			existing, readErr := readOwnerFileAt(directory, name, int64(len(data)))
			if readErr == nil && bytes.Equal(existing, data) {
				return nil
			}
			return os.ErrExist
		}
		return err
	}
	file := os.NewFile(uintptr(fd), name)
	if file == nil {
		_ = syscall.Close(fd)
		return errors.New("open release transition state file failed")
	}
	identity, validationErr := ownerRegularFileIdentity(fd)
	if validationErr != nil {
		file.Close()
		return validationErr
	}
	committed := false
	defer func() {
		_ = file.Close()
		if !committed {
			if cleanupErr := unlinkOwnedIdentityAt(directory, name, identity); cleanupErr != nil {
				returnErr = errors.Join(returnErr, fmt.Errorf("clean up incomplete release transition state file: %w", cleanupErr))
			}
		}
	}()
	if err := syscall.Fchmod(fd, 0o600); err != nil {
		return err
	}
	if secured, err := validateOwnerFileDescriptor(fd, 0o600); err != nil || secured != identity {
		return errors.New("release transition state file identity changed while securing it")
	}
	if _, err := file.Write(data); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := verifyFileEntry(directory, name, identity, 0o600); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := directory.file.Sync(); err != nil {
		return err
	}
	committed = true
	return nil
}

func readOwnerFileAt(directory *secureDirectory, name string, limit int64) ([]byte, error) {
	if !safeLeafName(name) {
		return nil, errors.New("release transition state filename is invalid")
	}
	fd, err := syscall.Openat(int(directory.file.Fd()), name, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), name)
	if file == nil {
		_ = syscall.Close(fd)
		return nil, errors.New("open release transition state file failed")
	}
	defer file.Close()
	identity, err := validateOwnerFileDescriptor(fd, 0o600)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if info.Size() < 0 || info.Size() > limit {
		return nil, errors.New("release transition state file exceeds its size limit")
	}
	if err := verifyFileEntry(directory, name, identity, 0o600); err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("release transition state file exceeds its size limit")
	}
	if err := verifyFileEntry(directory, name, identity, 0o600); err != nil {
		return nil, err
	}
	return data, nil
}

func validateOwnerFileDescriptor(fd int, exactMode os.FileMode) (fileIdentity, error) {
	var stat syscall.Stat_t
	if err := syscall.Fstat(fd, &stat); err != nil {
		return fileIdentity{}, err
	}
	if stat.Mode&syscall.S_IFMT != syscall.S_IFREG || stat.Uid != uint32(os.Getuid()) || stat.Nlink != 1 || os.FileMode(stat.Mode).Perm() != exactMode {
		return fileIdentity{}, errors.New("release transition state file must be an owner-owned singly-linked 0600 regular file")
	}
	return fileIdentity{device: uint64(stat.Dev), inode: stat.Ino}, nil
}

func ownerRegularFileIdentity(fd int) (fileIdentity, error) {
	var stat syscall.Stat_t
	if err := syscall.Fstat(fd, &stat); err != nil {
		return fileIdentity{}, err
	}
	if stat.Mode&syscall.S_IFMT != syscall.S_IFREG || stat.Uid != uint32(os.Getuid()) || stat.Nlink != 1 {
		return fileIdentity{}, errors.New("release transition state file must be an owner-owned singly-linked regular file")
	}
	return fileIdentity{device: uint64(stat.Dev), inode: stat.Ino}, nil
}

func verifyFileEntry(directory *secureDirectory, name string, expected fileIdentity, mode os.FileMode) error {
	fd, err := syscall.Openat(int(directory.file.Fd()), name, syscall.O_RDONLY|syscall.O_NONBLOCK|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return errors.New("release transition state file identity changed")
	}
	defer syscall.Close(fd)
	identity, err := validateOwnerFileDescriptor(fd, mode)
	if err != nil || identity != expected {
		return errors.New("release transition state file identity changed")
	}
	return nil
}

func unlinkOwnedIdentityAt(directory *secureDirectory, name string, expected fileIdentity) error {
	if err := verifyFileEntry(directory, name, expected, 0o600); err != nil {
		return err
	}
	if err := syscall.Unlinkat(int(directory.file.Fd()), name); err != nil {
		return err
	}
	return directory.file.Sync()
}

func readOwnerJSONAt(directory *secureDirectory, name string, value any, limit int64) error {
	data, err := readOwnerFileAt(directory, name, limit)
	if err != nil {
		return err
	}
	if err := rejectDuplicateJSONFields(data); err != nil {
		return fmt.Errorf("release transition state JSON: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("release transition state JSON contains trailing data")
	}
	return nil
}
