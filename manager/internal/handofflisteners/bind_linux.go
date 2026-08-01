//go:build linux

package handofflisteners

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handofffd"
)

type durableBindLock struct {
	file *os.File
}

// TCPRebinder recreates the complete expected set as one failure-atomic
// group. The caller must hold the durable bind lock and helper authority.
type TCPRebinder struct{}

func (TCPRebinder) Rebind(ctx context.Context, expected []handofffd.ListenerIdentity) ([]handofffd.NamedListener, error) {
	expected, err := handofffd.ValidateIdentities(expected)
	if err != nil {
		return nil, err
	}
	listeners := make([]handofffd.NamedListener, 0, len(expected))
	for _, identity := range expected {
		address, err := netip.ParseAddrPort(identity.Address)
		if err != nil {
			_ = closeListeners(listeners)
			return nil, errors.New("journal-bound listener address is invalid")
		}
		network := "tcp4"
		if address.Addr().Is6() {
			network = "tcp6"
		}
		listener, err := (&net.ListenConfig{}).Listen(ctx, network, identity.Address)
		if err != nil {
			_ = closeListeners(listeners)
			return nil, fmt.Errorf("rebind %s listener at %s: %w", identity.Name, identity.Address, err)
		}
		tcp, ok := listener.(*net.TCPListener)
		if !ok {
			_ = listener.Close()
			_ = closeListeners(listeners)
			return nil, errors.New("listener rebind did not create a TCP listener")
		}
		listeners = append(listeners, handofffd.NamedListener{Name: identity.Name, Listener: tcp})
	}
	if err := describeExact(listeners, expected); err != nil {
		_ = closeListeners(listeners)
		return nil, err
	}
	return listeners, nil
}

func acquireDurableBindLock(transactionDirectory string) (*durableBindLock, error) {
	directoryInfo, err := os.Lstat(transactionDirectory)
	if err != nil {
		return nil, fmt.Errorf("inspect listener handoff transaction directory: %w", err)
	}
	directoryStat, ok := directoryInfo.Sys().(*syscall.Stat_t)
	if !ok || !directoryInfo.IsDir() || directoryInfo.Mode()&os.ModeSymlink != 0 ||
		directoryStat.Uid != uint32(os.Getuid()) || directoryInfo.Mode().Perm() != 0o700 {
		return nil, errors.New("listener handoff transaction directory is not owner-only")
	}
	directoryFD, err := openDirectoryNoSymlinks(transactionDirectory)
	if err != nil {
		return nil, fmt.Errorf("open listener handoff transaction directory: %w", err)
	}
	directory := os.NewFile(uintptr(directoryFD), transactionDirectory)
	if directory == nil {
		_ = syscall.Close(directoryFD)
		return nil, errors.New("open listener handoff transaction directory returned an invalid descriptor")
	}
	defer directory.Close()
	var openedDirectory syscall.Stat_t
	if err := syscall.Fstat(directoryFD, &openedDirectory); err != nil ||
		uint64(openedDirectory.Dev) != uint64(directoryStat.Dev) || openedDirectory.Ino != directoryStat.Ino {
		return nil, errors.New("listener handoff transaction directory identity changed")
	}

	lockFD, err := syscall.Openat(directoryFD, bindLockBasename,
		syscall.O_CREAT|syscall.O_RDWR|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open durable listener bind lock: %w", err)
	}
	file := os.NewFile(uintptr(lockFD), filepath.Join(transactionDirectory, bindLockBasename))
	if file == nil {
		_ = syscall.Close(lockFD)
		return nil, errors.New("open durable listener bind lock returned an invalid descriptor")
	}
	closeFile := true
	defer func() {
		if closeFile {
			_ = file.Close()
		}
	}()
	identity, err := validateBindLock(file)
	if err != nil {
		return nil, err
	}
	pathInfo, err := os.Lstat(filepath.Join(transactionDirectory, bindLockBasename))
	if err != nil {
		return nil, fmt.Errorf("inspect durable listener bind lock path: %w", err)
	}
	pathStat, ok := pathInfo.Sys().(*syscall.Stat_t)
	if !ok || uint64(pathStat.Dev) != uint64(identity.Dev) || pathStat.Ino != identity.Ino {
		return nil, errors.New("durable listener bind lock path identity changed")
	}
	if err := syscall.Flock(lockFD, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return nil, fmt.Errorf("acquire durable listener bind lock: %w", err)
	}
	if _, err := validateBindLock(file); err != nil {
		_ = syscall.Flock(lockFD, syscall.LOCK_UN)
		return nil, err
	}
	reopenedFD, err := openDirectoryNoSymlinks(transactionDirectory)
	if err != nil {
		_ = syscall.Flock(lockFD, syscall.LOCK_UN)
		return nil, errors.New("listener handoff transaction directory path changed while locking")
	}
	var reopenedDirectory syscall.Stat_t
	reopenErr := syscall.Fstat(reopenedFD, &reopenedDirectory)
	_ = syscall.Close(reopenedFD)
	if reopenErr != nil || uint64(reopenedDirectory.Dev) != uint64(openedDirectory.Dev) || reopenedDirectory.Ino != openedDirectory.Ino {
		_ = syscall.Flock(lockFD, syscall.LOCK_UN)
		return nil, errors.New("listener handoff transaction directory identity changed while locking")
	}
	if err := file.Sync(); err != nil {
		_ = syscall.Flock(lockFD, syscall.LOCK_UN)
		return nil, fmt.Errorf("sync durable listener bind lock: %w", err)
	}
	if err := directory.Sync(); err != nil {
		_ = syscall.Flock(lockFD, syscall.LOCK_UN)
		return nil, fmt.Errorf("sync listener handoff transaction directory: %w", err)
	}
	closeFile = false
	return &durableBindLock{file: file}, nil
}

func openDirectoryNoSymlinks(path string) (int, error) {
	if path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return -1, errors.New("listener handoff transaction directory path is invalid")
	}
	fd, err := syscall.Open("/", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	for _, component := range strings.Split(strings.TrimPrefix(path, "/"), "/") {
		if component == "" || component == "." || component == ".." {
			_ = syscall.Close(fd)
			return -1, errors.New("listener handoff transaction directory path is not canonical")
		}
		next, openErr := syscall.Openat(fd, component, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
		_ = syscall.Close(fd)
		if openErr != nil {
			return -1, openErr
		}
		fd = next
	}
	return fd, nil
}

func validateBindLock(file *os.File) (*syscall.Stat_t, error) {
	info, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("inspect durable listener bind lock: %w", err)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || stat.Uid != uint32(os.Getuid()) ||
		info.Mode().Perm() != 0o600 || stat.Nlink != 1 {
		return nil, errors.New("durable listener bind lock is not a secured owner-only regular file")
	}
	return stat, nil
}

func (lock *durableBindLock) Close() error {
	if lock == nil || lock.file == nil {
		return nil
	}
	err := syscall.Flock(int(lock.file.Fd()), syscall.LOCK_UN)
	err = errors.Join(err, lock.file.Close())
	lock.file = nil
	return err
}
