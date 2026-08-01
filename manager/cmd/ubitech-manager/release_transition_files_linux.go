//go:build linux

package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

type ownerFileIdentity struct {
	device uint64
	inode  uint64
}

type ownerParentDirectory struct {
	file     *os.File
	path     string
	leaf     string
	identity ownerFileIdentity
}

type createdOwnerFile struct {
	parent   *ownerParentDirectory
	identity ownerFileIdentity
}

func (parent *ownerParentDirectory) close() {
	if parent != nil && parent.file != nil {
		_ = parent.file.Close()
	}
}

func readOwnerInputFile(path string, maxBytes int64) ([]byte, error) {
	parent, err := openOwnerParent(path)
	if err != nil {
		return nil, err
	}
	defer parent.close()
	fd, err := syscall.Openat(int(parent.file.Fd()), parent.leaf, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	if file == nil {
		_ = syscall.Close(fd)
		return nil, errors.New("open owner input file failed")
	}
	defer file.Close()
	identity, size, err := validateOwnerInputFD(fd)
	if err != nil {
		return nil, err
	}
	if size <= 0 || size > maxBytes {
		return nil, fmt.Errorf("input size must be between 1 and %d bytes", maxBytes)
	}
	if err := verifyOwnerInputEntry(parent, identity); err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) == 0 || int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("input size must be between 1 and %d bytes", maxBytes)
	}
	if err := verifyOwnerInputEntry(parent, identity); err != nil {
		return nil, err
	}
	if err := parent.verifyPath(); err != nil {
		return nil, err
	}
	return data, nil
}

func writeOwnerOutputPair(firstPath string, first []byte, secondPath string, second []byte) error {
	if firstPath == secondPath {
		return errors.New("receipt and signature paths must be distinct")
	}
	firstParent, err := openOwnerParent(firstPath)
	if err != nil {
		return err
	}
	defer firstParent.close()
	secondParent, err := openOwnerParent(secondPath)
	if err != nil {
		return err
	}
	defer secondParent.close()
	if firstParent.identity == secondParent.identity && firstParent.leaf == secondParent.leaf {
		return errors.New("receipt and signature resolve to the same parent entry")
	}
	firstCreated, err := createOwnerOutput(firstParent, first)
	if err != nil {
		return fmt.Errorf("write release transition receipt: %w", err)
	}
	if _, err := createOwnerOutput(secondParent, second); err != nil {
		if cleanupErr := unlinkCreatedOwnerFile(firstCreated); cleanupErr != nil {
			return fmt.Errorf("write release transition signature: %v; rollback receipt: %w", err, cleanupErr)
		}
		return fmt.Errorf("write release transition signature: %w", err)
	}
	return nil
}

func writeNewOwnerFile(path string, data []byte) error {
	parent, err := openOwnerParent(path)
	if err != nil {
		return err
	}
	defer parent.close()
	_, err = createOwnerOutput(parent, data)
	return err
}

func openOwnerParent(path string) (*ownerParentDirectory, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, errors.New("file path must be absolute and canonical")
	}
	leaf := filepath.Base(path)
	if leaf == "" || leaf == "." || leaf == ".." || strings.ContainsRune(leaf, rune(filepath.Separator)) {
		return nil, errors.New("file path has an invalid final name")
	}
	parentPath := filepath.Dir(path)
	file, identity, uid, mode, err := openAbsoluteDirectoryNoFollow(parentPath)
	if err != nil {
		return nil, err
	}
	if uid != uint32(os.Getuid()) || mode.Perm()&0o022 != 0 {
		file.Close()
		return nil, errors.New("file parent must be an owner-controlled non-symlink directory")
	}
	return &ownerParentDirectory{file: file, path: parentPath, leaf: leaf, identity: identity}, nil
}

func openAbsoluteDirectoryNoFollow(path string) (*os.File, ownerFileIdentity, uint32, os.FileMode, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, ownerFileIdentity{}, 0, 0, errors.New("directory path must be absolute and canonical")
	}
	rootFD, err := syscall.Open(string(filepath.Separator), syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, ownerFileIdentity{}, 0, 0, err
	}
	current := os.NewFile(uintptr(rootFD), string(filepath.Separator))
	if current == nil {
		_ = syscall.Close(rootFD)
		return nil, ownerFileIdentity{}, 0, 0, errors.New("open filesystem root failed")
	}
	trimmed := strings.TrimPrefix(path, string(filepath.Separator))
	if trimmed != "" {
		for _, component := range strings.Split(trimmed, string(filepath.Separator)) {
			fd, openErr := syscall.Openat(int(current.Fd()), component, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
			if openErr != nil {
				current.Close()
				return nil, ownerFileIdentity{}, 0, 0, openErr
			}
			next := os.NewFile(uintptr(fd), component)
			if next == nil {
				_ = syscall.Close(fd)
				current.Close()
				return nil, ownerFileIdentity{}, 0, 0, errors.New("open directory component failed")
			}
			current.Close()
			current = next
		}
	}
	identity, uid, mode, err := directoryIdentity(int(current.Fd()))
	if err != nil {
		current.Close()
		return nil, ownerFileIdentity{}, 0, 0, err
	}
	return current, identity, uid, mode, nil
}

func directoryIdentity(fd int) (ownerFileIdentity, uint32, os.FileMode, error) {
	var stat syscall.Stat_t
	if err := syscall.Fstat(fd, &stat); err != nil {
		return ownerFileIdentity{}, 0, 0, err
	}
	if stat.Mode&syscall.S_IFMT != syscall.S_IFDIR {
		return ownerFileIdentity{}, 0, 0, errors.New("path component is not a directory")
	}
	return ownerFileIdentity{device: uint64(stat.Dev), inode: stat.Ino}, stat.Uid, os.FileMode(stat.Mode), nil
}

func (parent *ownerParentDirectory) verifyPath() error {
	file, identity, uid, mode, err := openAbsoluteDirectoryNoFollow(parent.path)
	if file != nil {
		file.Close()
	}
	if err != nil || identity != parent.identity || uid != uint32(os.Getuid()) || mode.Perm()&0o022 != 0 {
		return errors.New("file parent identity changed during operation")
	}
	return nil
}

func validateOwnerInputFD(fd int) (ownerFileIdentity, int64, error) {
	var stat syscall.Stat_t
	if err := syscall.Fstat(fd, &stat); err != nil {
		return ownerFileIdentity{}, 0, err
	}
	if stat.Mode&syscall.S_IFMT != syscall.S_IFREG || stat.Uid != uint32(os.Getuid()) || stat.Nlink != 1 || os.FileMode(stat.Mode).Perm()&0o077 != 0 {
		return ownerFileIdentity{}, 0, errors.New("input must be an owner-only, single-link regular file")
	}
	return ownerFileIdentity{device: uint64(stat.Dev), inode: stat.Ino}, stat.Size, nil
}

func validateOwnerOutputFD(fd int) (ownerFileIdentity, error) {
	var stat syscall.Stat_t
	if err := syscall.Fstat(fd, &stat); err != nil {
		return ownerFileIdentity{}, err
	}
	if stat.Mode&syscall.S_IFMT != syscall.S_IFREG || stat.Uid != uint32(os.Getuid()) || stat.Nlink != 1 || os.FileMode(stat.Mode).Perm() != 0o600 {
		return ownerFileIdentity{}, errors.New("output must be an owner-owned, single-link 0600 regular file")
	}
	return ownerFileIdentity{device: uint64(stat.Dev), inode: stat.Ino}, nil
}

func verifyOwnerInputEntry(parent *ownerParentDirectory, expected ownerFileIdentity) error {
	fd, err := syscall.Openat(int(parent.file.Fd()), parent.leaf, syscall.O_RDONLY|syscall.O_NONBLOCK|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return errors.New("input file identity changed during operation")
	}
	defer syscall.Close(fd)
	identity, _, err := validateOwnerInputFD(fd)
	if err != nil || identity != expected {
		return errors.New("input file identity changed during operation")
	}
	return nil
}

func verifyOwnerOutputEntry(parent *ownerParentDirectory, expected ownerFileIdentity) error {
	fd, err := syscall.Openat(int(parent.file.Fd()), parent.leaf, syscall.O_RDONLY|syscall.O_NONBLOCK|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return errors.New("output file identity changed during operation")
	}
	defer syscall.Close(fd)
	identity, err := validateOwnerOutputFD(fd)
	if err != nil || identity != expected {
		return errors.New("output file identity changed during operation")
	}
	return nil
}

func createOwnerOutput(parent *ownerParentDirectory, data []byte) (result createdOwnerFile, returnErr error) {
	if err := parent.verifyPath(); err != nil {
		return createdOwnerFile{}, err
	}
	fd, err := syscall.Openat(int(parent.file.Fd()), parent.leaf, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return createdOwnerFile{}, err
	}
	file := os.NewFile(uintptr(fd), filepath.Join(parent.path, parent.leaf))
	if file == nil {
		_ = syscall.Close(fd)
		return createdOwnerFile{}, errors.New("open owner output file failed")
	}
	var stat syscall.Stat_t
	if err := syscall.Fstat(fd, &stat); err != nil {
		file.Close()
		return createdOwnerFile{}, err
	}
	identity := ownerFileIdentity{device: uint64(stat.Dev), inode: stat.Ino}
	committed := false
	defer func() {
		_ = file.Close()
		if !committed {
			if cleanupErr := unlinkCreatedOwnerFile(createdOwnerFile{parent: parent, identity: identity}); cleanupErr != nil {
				returnErr = errors.Join(returnErr, fmt.Errorf("clean up incomplete owner output: %w", cleanupErr))
			}
		}
	}()
	if stat.Mode&syscall.S_IFMT != syscall.S_IFREG || stat.Uid != uint32(os.Getuid()) || stat.Nlink != 1 {
		return createdOwnerFile{}, errors.New("new output is not an owner-owned single-link regular file")
	}
	if err := syscall.Fchmod(fd, 0o600); err != nil {
		return createdOwnerFile{}, err
	}
	if verified, err := validateOwnerOutputFD(fd); err != nil || verified != identity {
		return createdOwnerFile{}, errors.New("new output identity changed while securing it")
	}
	if _, err := file.Write(data); err != nil {
		return createdOwnerFile{}, err
	}
	if err := file.Sync(); err != nil {
		return createdOwnerFile{}, err
	}
	if err := verifyOwnerOutputEntry(parent, identity); err != nil {
		return createdOwnerFile{}, err
	}
	if err := file.Close(); err != nil {
		return createdOwnerFile{}, err
	}
	if err := parent.file.Sync(); err != nil {
		return createdOwnerFile{}, err
	}
	if err := parent.verifyPath(); err != nil {
		return createdOwnerFile{}, err
	}
	if err := verifyOwnerOutputEntry(parent, identity); err != nil {
		return createdOwnerFile{}, err
	}
	committed = true
	return createdOwnerFile{parent: parent, identity: identity}, nil
}

func unlinkCreatedOwnerFile(created createdOwnerFile) error {
	if created.parent == nil || created.identity == (ownerFileIdentity{}) {
		return errors.New("created output identity is unavailable")
	}
	if err := verifyOwnerOutputEntry(created.parent, created.identity); err != nil {
		return err
	}
	if err := syscall.Unlinkat(int(created.parent.file.Fd()), created.parent.leaf); err != nil {
		return err
	}
	return created.parent.file.Sync()
}
