//go:build linux

package control

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

const controlSocketProbeTimeout = 500 * time.Millisecond

type socketPathIdentity struct {
	device uint64
	inode  uint64
	uid    uint32
	type_  os.FileMode
}

type ownerListener struct {
	*net.UnixListener
	uid      uint32
	path     string
	identity socketPathIdentity
	bindLock *socketBindLock
	close    sync.Once
	closeErr error
}

type socketBindLock struct {
	file       *os.File
	release    sync.Once
	releaseErr error
}

func Listen(path string) (net.Listener, error) {
	return listen(path, probeControlSocket)
}

func listen(path string, probe func(string, time.Duration) error) (net.Listener, error) {
	if path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path || filepath.Base(path) == "." || filepath.Base(path) == string(filepath.Separator) {
		return nil, errors.New("control socket path must be absolute and canonical")
	}
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, err
	}
	directoryInfo, err := os.Lstat(directory)
	if err != nil {
		return nil, err
	}
	directoryStat, ok := directoryInfo.Sys().(*syscall.Stat_t)
	if directoryInfo.Mode()&os.ModeSymlink != 0 || !directoryInfo.IsDir() || !ok || directoryStat.Uid != uint32(os.Getuid()) {
		return nil, errors.New("control directory must be an owner-owned non-symlink directory")
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return nil, err
	}
	bindLock, err := acquireSocketBindLock(directory, path, directoryInfo)
	if err != nil {
		return nil, err
	}
	releaseBindLock := true
	defer func() {
		if releaseBindLock {
			_ = bindLock.Release()
		}
	}()
	if identity, err := controlSocketIdentity(path); err == nil {
		if identity.uid != uint32(os.Getuid()) || identity.type_ != os.ModeSocket {
			return nil, errors.New("refusing to replace a non-owner control socket")
		}
		if err := probe(path, controlSocketProbeTimeout); err == nil {
			return nil, errors.New("refusing to replace a live control socket")
		} else if !errors.Is(err, syscall.ECONNREFUSED) {
			return nil, fmt.Errorf("refusing to replace a control socket after an ambiguous connect result: %w", err)
		}
		current, err := controlSocketIdentity(path)
		if err != nil {
			return nil, fmt.Errorf("revalidate stale control socket before removal: %w", err)
		}
		if current != identity {
			return nil, errors.New("refusing to replace a control socket whose path identity changed during the stale probe")
		}
		if err := os.Remove(path); err != nil {
			return nil, err
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	address := &net.UnixAddr{Name: path, Net: "unix"}
	listener, err := net.ListenUnix("unix", address)
	if err != nil {
		return nil, err
	}
	// Never let net.UnixListener unlink this pathname by string. Every teardown
	// path below either removes the exact recorded inode while the bind lock is
	// held or leaves an ambiguous pathname for the next locked stale probe.
	listener.SetUnlinkOnClose(false)
	identity, err := controlSocketIdentity(path)
	if err != nil {
		_ = listener.Close()
		return nil, fmt.Errorf("identify newly bound control socket: %w", err)
	}
	if identity.uid != uint32(os.Getuid()) || identity.type_ != os.ModeSocket {
		_ = listener.Close()
		return nil, errors.New("newly bound control socket has an unexpected owner or type")
	}
	owned := &ownerListener{
		UnixListener: listener,
		uid:          uint32(os.Getuid()),
		path:         path,
		identity:     identity,
		bindLock:     bindLock,
	}
	if err := os.Chmod(path, 0o600); err != nil {
		_ = owned.Close()
		return nil, err
	}
	current, err := controlSocketIdentity(path)
	if err != nil || current != identity {
		_ = owned.Close()
		if err != nil {
			return nil, fmt.Errorf("revalidate newly bound control socket: %w", err)
		}
		return nil, errors.New("newly bound control socket path identity changed during setup")
	}
	releaseBindLock = false
	return owned, nil
}

func probeControlSocket(path string, timeout time.Duration) error {
	connection, err := net.DialTimeout("unix", path, timeout)
	if err != nil {
		return err
	}
	_ = connection.Close()
	return nil
}

func controlSocketIdentity(path string) (socketPathIdentity, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return socketPathIdentity{}, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return socketPathIdentity{}, errors.New("control socket metadata is unavailable")
	}
	return socketPathIdentity{
		device: uint64(stat.Dev),
		inode:  uint64(stat.Ino),
		uid:    stat.Uid,
		type_:  info.Mode() & os.ModeType,
	}, nil
}

func acquireSocketBindLock(directory, socketPath string, directoryInfo os.FileInfo) (*socketBindLock, error) {
	directoryFD, err := syscall.Open(directory, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, fmt.Errorf("open control directory for socket bind ownership: %w", err)
	}
	defer syscall.Close(directoryFD)
	var openedDirectory syscall.Stat_t
	if err := syscall.Fstat(directoryFD, &openedDirectory); err != nil {
		return nil, fmt.Errorf("inspect opened control directory for socket bind ownership: %w", err)
	}
	if !sameSocketPathInode(directoryInfo, &openedDirectory) || !directoryInfo.IsDir() || directoryInfo.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("control directory changed while acquiring socket bind ownership")
	}

	lockName := filepath.Base(socketPath) + ".lock"
	fd, err := syscall.Openat(directoryFD, lockName, syscall.O_CREAT|syscall.O_RDWR|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open control socket bind lock: %w", err)
	}
	file := os.NewFile(uintptr(fd), socketPath+".lock")
	if file == nil {
		_ = syscall.Close(fd)
		return nil, errors.New("open control socket bind lock: invalid file descriptor")
	}
	lock := &socketBindLock{file: file}
	keep := false
	defer func() {
		if !keep {
			_ = lock.Release()
		}
	}()

	stat, err := validateSocketBindLockFile(file)
	if err != nil {
		return nil, err
	}
	lockPath := socketPath + ".lock"
	pathInfo, err := os.Lstat(lockPath)
	if err != nil || !sameSocketPathInode(pathInfo, stat) || !pathInfo.Mode().IsRegular() || pathInfo.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("control socket bind lock path changed while opening")
	}
	if err := syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, errors.New("another Manager process owns the control socket bind lock")
		}
		return nil, fmt.Errorf("acquire control socket bind lock: %w", err)
	}
	latestStat, err := validateSocketBindLockFile(file)
	if err != nil || latestStat.Dev != stat.Dev || latestStat.Ino != stat.Ino || latestStat.Uid != stat.Uid {
		if err != nil {
			return nil, err
		}
		return nil, errors.New("control socket bind lock identity changed while locking")
	}
	pathInfo, err = os.Lstat(lockPath)
	if err != nil || !sameSocketPathInode(pathInfo, latestStat) || !pathInfo.Mode().IsRegular() || pathInfo.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("control socket bind lock path changed while locking")
	}
	latestDirectoryInfo, err := os.Lstat(directory)
	if err != nil || !sameSocketPathInode(latestDirectoryInfo, &openedDirectory) || !latestDirectoryInfo.IsDir() || latestDirectoryInfo.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("control directory changed while locking socket bind ownership")
	}

	keep = true
	return lock, nil
}

func validateSocketBindLockFile(file *os.File) (*syscall.Stat_t, error) {
	info, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("inspect control socket bind lock: %w", err)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || stat.Uid != uint32(os.Getuid()) || stat.Nlink != 1 {
		return nil, errors.New("control socket bind lock must be an owner-owned singly-linked regular file")
	}
	if info.Mode().Perm()&0o177 != 0 {
		return nil, errors.New("control socket bind lock permissions are broader than 0600")
	}
	return stat, nil
}

func sameSocketPathInode(info os.FileInfo, stat *syscall.Stat_t) bool {
	if info == nil || stat == nil {
		return false
	}
	observed, ok := info.Sys().(*syscall.Stat_t)
	return ok && observed.Dev == stat.Dev && observed.Ino == stat.Ino && observed.Uid == stat.Uid
}

func (l *socketBindLock) Release() error {
	if l == nil {
		return nil
	}
	l.release.Do(func() {
		if l.file == nil {
			return
		}
		unlockErr := syscall.Flock(int(l.file.Fd()), syscall.LOCK_UN)
		closeErr := l.file.Close()
		l.releaseErr = errors.Join(unlockErr, closeErr)
	})
	return l.releaseErr
}

func (l *ownerListener) Close() error {
	return l.closeAfterUnlink(nil)
}

func (l *ownerListener) closeAfterUnlink(afterUnlink func()) error {
	l.close.Do(func() {
		cleanupErr := l.unlinkOwnedPath()
		if afterUnlink != nil {
			afterUnlink()
		}
		closeErr := l.UnixListener.Close()
		bindLockErr := l.bindLock.Release()
		l.closeErr = errors.Join(closeErr, cleanupErr, bindLockErr)
	})
	return l.closeErr
}

func (l *ownerListener) unlinkOwnedPath() error {
	identity, err := controlSocketIdentity(l.path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect control socket during listener teardown: %w", err)
	}
	if identity != l.identity {
		return nil
	}
	if err := os.Remove(l.path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove owned control socket during listener teardown: %w", err)
	}
	return nil
}

func (l *ownerListener) Accept() (net.Conn, error) {
	for {
		connection, err := l.AcceptUnix()
		if err != nil {
			return nil, err
		}
		raw, err := connection.SyscallConn()
		if err != nil {
			_ = connection.Close()
			continue
		}
		var credential *syscall.Ucred
		var controlErr error
		err = raw.Control(func(fd uintptr) {
			credential, controlErr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
		})
		if err == nil && controlErr == nil && credential != nil && credential.Uid == l.uid {
			return connection, nil
		}
		_ = connection.Close()
	}
}
