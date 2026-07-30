package selfupdate

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"syscall"
)

const managerServeLockName = "serve.lock"

// ServeLease is the outermost Manager process ownership fence. It is acquired
// before recovery ownership and retained for the complete serve lifetime.
type ServeLease struct {
	file *os.File
	once sync.Once
}

// Release relinquishes the serve singleton. The durable lock file is retained
// so every process coordinates on the same inode.
func (l *ServeLease) Release() {
	if l == nil {
		return
	}
	l.once.Do(func() {
		if l.file == nil {
			return
		}
		_ = syscall.Flock(int(l.file.Fd()), syscall.LOCK_UN)
		_ = l.file.Close()
	})
}

// AcquireServeLock obtains the owner-only, nonblocking singleton that must be
// held outside the recovery and activation-plan locks. The only fresh-install
// mutation it permits is creation of the missing Manager binary root and its
// durable lock file.
func (m *Manager) AcquireServeLock() (*ServeLease, error) {
	if m.Root == "" || !filepath.IsAbs(m.Root) || filepath.Clean(m.Root) != m.Root {
		return nil, errors.New("Manager binary root path is invalid for serve ownership")
	}
	if _, err := os.Lstat(m.Root); err != nil {
		if !os.IsNotExist(err) {
			return nil, fmt.Errorf("inspect Manager binary root for serve ownership: %w", err)
		}
		parent := filepath.Dir(m.Root)
		if err := validateRecoveryDirectory(parent, false); err != nil {
			return nil, fmt.Errorf("validate Manager state directory before creating serve ownership root: %w", err)
		}
		// The installer accepts an owner-owned, non-group-writable state root.
		// Tighten that already trusted directory before the first serve creates
		// the private binary root; never repair an unsafe owner/type/path.
		if err := os.Chmod(parent, 0o700); err != nil {
			return nil, fmt.Errorf("restrict Manager state directory before creating serve ownership root: %w", err)
		}
		if err := validateRecoveryDirectory(parent, true); err != nil {
			return nil, fmt.Errorf("revalidate restricted Manager state directory before creating serve ownership root: %w", err)
		}
		if err := os.Mkdir(m.Root, 0o700); err != nil && !os.IsExist(err) {
			return nil, fmt.Errorf("create Manager binary root for serve ownership: %w", err)
		}
	}
	if err := validateRecoveryDirectory(m.Root, true); err != nil {
		return nil, fmt.Errorf("validate Manager binary root for serve ownership: %w", err)
	}

	rootFD, err := syscall.Open(m.Root, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, fmt.Errorf("open Manager binary root for serve ownership: %w", err)
	}
	defer syscall.Close(rootFD)
	var openedRoot syscall.Stat_t
	if err := syscall.Fstat(rootFD, &openedRoot); err != nil {
		return nil, fmt.Errorf("inspect opened Manager binary root for serve ownership: %w", err)
	}
	rootInfo, err := os.Lstat(m.Root)
	if err != nil || !sameServeLockInode(rootInfo, &openedRoot) || !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("Manager binary root changed while acquiring serve ownership")
	}

	fd, err := syscall.Openat(rootFD, managerServeLockName, syscall.O_CREAT|syscall.O_RDWR|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open Manager serve ownership lock: %w", err)
	}
	file := os.NewFile(uintptr(fd), filepath.Join(m.Root, managerServeLockName))
	if file == nil {
		_ = syscall.Close(fd)
		return nil, errors.New("open Manager serve ownership lock: invalid file descriptor")
	}
	lease := &ServeLease{file: file}
	closeLease := true
	defer func() {
		if closeLease {
			lease.Release()
		}
	}()

	info, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("inspect Manager serve ownership lock: %w", err)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || stat.Uid != uint32(os.Getuid()) || stat.Nlink != 1 {
		return nil, errors.New("Manager serve ownership lock must be an owner-owned singly-linked regular file")
	}
	if info.Mode().Perm()&0o077 != 0 {
		return nil, errors.New("Manager serve ownership lock is accessible by another host identity")
	}
	pathInfo, err := os.Lstat(filepath.Join(m.Root, managerServeLockName))
	if err != nil || !sameServeLockInode(pathInfo, stat) || !pathInfo.Mode().IsRegular() || pathInfo.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("Manager serve ownership lock path changed while opening")
	}
	if err := syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, errors.New("another Manager serve process already owns this installation")
		}
		return nil, fmt.Errorf("acquire Manager serve ownership lock: %w", err)
	}
	// Close the path-swap window after flock: a replaced pathname would let a
	// second serve coordinate on a different inode.
	pathInfo, err = os.Lstat(filepath.Join(m.Root, managerServeLockName))
	if err != nil || !sameServeLockInode(pathInfo, stat) || !pathInfo.Mode().IsRegular() || pathInfo.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("Manager serve ownership lock path changed while locking")
	}
	latestRootInfo, err := os.Lstat(m.Root)
	if err != nil || !sameServeLockInode(latestRootInfo, &openedRoot) || !latestRootInfo.IsDir() || latestRootInfo.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("Manager binary root changed while locking serve ownership")
	}

	closeLease = false
	return lease, nil
}

func sameServeLockInode(info os.FileInfo, stat *syscall.Stat_t) bool {
	if info == nil || stat == nil {
		return false
	}
	observed, ok := info.Sys().(*syscall.Stat_t)
	return ok && observed.Dev == stat.Dev && observed.Ino == stat.Ino && observed.Uid == stat.Uid
}
