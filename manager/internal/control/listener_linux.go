//go:build linux

package control

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"syscall"
)

type ownerListener struct {
	*net.UnixListener
	uid uint32
}

func Listen(path string) (net.Listener, error) {
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
	if info, err := os.Lstat(path); err == nil {
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || stat.Uid != uint32(os.Getuid()) || info.Mode()&os.ModeSocket == 0 {
			return nil, errors.New("refusing to replace a non-owner control socket")
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
	if err := os.Chmod(path, 0o600); err != nil {
		_ = listener.Close()
		return nil, err
	}
	return &ownerListener{UnixListener: listener, uid: uint32(os.Getuid())}, nil
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
