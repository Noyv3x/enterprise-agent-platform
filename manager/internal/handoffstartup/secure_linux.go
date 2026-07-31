//go:build linux

package handoffstartup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type fileIdentity struct {
	device uint64
	inode  uint64
	uid    uint32
	mode   uint32
	links  uint64
}

func openDirectoryNoFollow(path string, exactOwnerMode bool) (*os.File, error) {
	if !canonicalAbsolute(path) {
		return nil, fmt.Errorf("%w: directory path is not canonical and absolute", ErrUnsafePath)
	}
	current, err := syscall.Open(string(filepath.Separator), syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	components := strings.Split(strings.TrimPrefix(path, string(filepath.Separator)), string(filepath.Separator))
	for _, component := range components {
		if component == "" {
			continue
		}
		next, openErr := syscall.Openat(current, component, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		_ = syscall.Close(current)
		if openErr != nil {
			return nil, openErr
		}
		current = next
	}
	var stat syscall.Stat_t
	if err := syscall.Fstat(current, &stat); err != nil {
		_ = syscall.Close(current)
		return nil, err
	}
	if stat.Mode&syscall.S_IFMT != syscall.S_IFDIR || (exactOwnerMode && (stat.Uid != uint32(os.Getuid()) || stat.Mode&0o777 != 0o700)) {
		_ = syscall.Close(current)
		return nil, fmt.Errorf("%w: directory owner, type, or mode is invalid", ErrUnsafePath)
	}
	return os.NewFile(uintptr(current), path), nil
}

func openRegularNoFollow(path string) (*os.File, fileIdentity, error) {
	if !canonicalAbsolute(path) || filepath.Base(path) == string(filepath.Separator) {
		return nil, fileIdentity{}, fmt.Errorf("%w: regular file path is invalid", ErrUnsafePath)
	}
	parent, err := openDirectoryNoFollow(filepath.Dir(path), false)
	if err != nil {
		return nil, fileIdentity{}, err
	}
	defer parent.Close()
	fd, err := syscall.Openat(int(parent.Fd()), filepath.Base(path), syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, fileIdentity{}, err
	}
	file := os.NewFile(uintptr(fd), path)
	identity, err := inspectFile(file)
	if err != nil {
		_ = file.Close()
		return nil, fileIdentity{}, err
	}
	if identity.mode&syscall.S_IFMT != syscall.S_IFREG || identity.uid != uint32(os.Getuid()) || identity.links != 1 || identity.mode&0o022 != 0 {
		_ = file.Close()
		return nil, fileIdentity{}, fmt.Errorf("%w: executable owner, type, links, or mode is invalid", ErrUnsafePath)
	}
	return file, identity, nil
}

func inspectFile(file *os.File) (fileIdentity, error) {
	var stat syscall.Stat_t
	if file == nil {
		return fileIdentity{}, errors.New("file is unavailable")
	}
	if err := syscall.Fstat(int(file.Fd()), &stat); err != nil {
		return fileIdentity{}, err
	}
	return fileIdentity{device: uint64(stat.Dev), inode: stat.Ino, uid: stat.Uid, mode: stat.Mode, links: uint64(stat.Nlink)}, nil
}

func hashFile(file *os.File) (string, error) {
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func verifyProcessExecutable(pid int, stablePath, expectedSHA string) error {
	if pid <= 0 {
		return errors.New("process id is invalid")
	}
	stable, stableIdentity, err := openRegularNoFollow(stablePath)
	if err != nil {
		return fmt.Errorf("open stable Manager executable: %w", err)
	}
	defer stable.Close()
	stableSHA, err := hashFile(stable)
	if err != nil {
		return fmt.Errorf("hash stable Manager executable: %w", err)
	}
	if expectedSHA != "" && stableSHA != expectedSHA {
		return errors.New("stable Manager executable digest differs from the handoff journal")
	}
	procPath := filepath.Join("/proc", strconv.Itoa(pid), "exe")
	fd, err := syscall.Open(procPath, syscall.O_RDONLY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return fmt.Errorf("open running Manager executable: %w", err)
	}
	running := os.NewFile(uintptr(fd), procPath)
	defer running.Close()
	runningIdentity, err := inspectFile(running)
	if err != nil {
		return err
	}
	if runningIdentity.mode&syscall.S_IFMT != syscall.S_IFREG || runningIdentity.device != stableIdentity.device || runningIdentity.inode != stableIdentity.inode {
		return errors.New("running Manager executable is not the bound stable inode")
	}
	runningSHA, err := hashFile(running)
	if err != nil {
		return fmt.Errorf("hash running Manager executable: %w", err)
	}
	if runningSHA != stableSHA {
		return errors.New("running and stable Manager executable digests differ")
	}
	return nil
}

func verifyRuntimeLayout(paths RuntimePaths) error {
	config, configIdentity, err := openRegularNoFollow(paths.ConfigPath)
	if err != nil {
		return fmt.Errorf("open Manager config: %w", err)
	}
	_ = config.Close()
	if configIdentity.mode&0o777 != 0o600 {
		return errors.New("Manager config is not owner-only")
	}
	for label, path := range map[string]string{
		"data root":          paths.DataRoot,
		"Manager state root": paths.StateRoot,
		"control directory":  filepath.Dir(paths.SocketPath),
	} {
		directory, err := openDirectoryNoFollow(path, true)
		if err != nil {
			return fmt.Errorf("open %s: %w", label, err)
		}
		_ = directory.Close()
	}
	return nil
}

func inspectPath(path string) (fileIdentity, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return fileIdentity{}, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fileIdentity{}, errors.New("path identity is unavailable")
	}
	return fileIdentity{device: uint64(stat.Dev), inode: stat.Ino, uid: stat.Uid, mode: stat.Mode, links: uint64(stat.Nlink)}, nil
}

func verifySocketIdentity(value fileIdentity) error {
	if value.mode&syscall.S_IFMT != syscall.S_IFSOCK || value.uid != uint32(os.Getuid()) || value.mode&0o777 != 0o600 {
		return fmt.Errorf("%w: startup channel owner, type, or mode is invalid", ErrUnsafePath)
	}
	return nil
}

func peerCredentials(connection *net.UnixConn) (*syscall.Ucred, error) {
	if connection == nil {
		return nil, errors.New("startup channel connection is unavailable")
	}
	raw, err := connection.SyscallConn()
	if err != nil {
		return nil, err
	}
	var credentials *syscall.Ucred
	var controlErr error
	if err := raw.Control(func(fd uintptr) {
		credentials, controlErr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}); err != nil {
		return nil, err
	}
	if controlErr != nil {
		return nil, controlErr
	}
	if credentials == nil || credentials.Uid != uint32(os.Getuid()) || credentials.Pid <= 0 {
		return nil, errors.New("startup channel peer is not the Manager deployment user")
	}
	return credentials, nil
}

func setConnectionDeadline(connection *net.UnixConn, ctx context.Context, fallback time.Time) error {
	deadline := fallback
	if requested, ok := ctx.Deadline(); ok && (deadline.IsZero() || requested.Before(deadline)) {
		deadline = requested
	}
	if deadline.IsZero() {
		return errors.New("startup channel requires a bounded deadline")
	}
	return connection.SetDeadline(deadline)
}

func contextIOError(ctx context.Context, err error) error {
	if ctxErr := ctx.Err(); ctxErr != nil {
		return ctxErr
	}
	return err
}

func interruptOnCancel(ctx context.Context, interrupt func() error) func() {
	if ctx == nil || ctx.Done() == nil {
		return func() {}
	}
	stopped := make(chan struct{})
	var once sync.Once
	go func() {
		select {
		case <-ctx.Done():
			_ = interrupt()
		case <-stopped:
		}
	}()
	return func() { once.Do(func() { close(stopped) }) }
}
