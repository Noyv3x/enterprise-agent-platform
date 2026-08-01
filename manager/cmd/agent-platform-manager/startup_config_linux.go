//go:build linux

package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/config"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"golang.org/x/sys/unix"
)

const maximumStartupConfigBytes = 1 << 20

type targetConfigSnapshot struct {
	path     string
	exists   bool
	raw      []byte
	identity unix.Stat_t
}

func resolveTargetConfiguration(path string) (config.Config, error) {
	if path == "" {
		var err error
		path, err = defaultTargetConfigPath()
		if err != nil {
			return config.Config{}, err
		}
	}
	if !canonicalStartupPath(path) {
		return config.Config{}, errors.New("startup config path must be canonical and absolute")
	}
	snapshot, err := readTargetConfigSnapshot(path)
	if err != nil {
		return config.Config{}, err
	}
	return config.LoadSnapshot(identity.CompileTimeActiveProfile(), snapshot.path, snapshot.raw, snapshot.exists)
}

func defaultTargetConfigPath() (string, error) {
	account, err := currentDeploymentAccount()
	if err != nil {
		return "", err
	}
	return identity.TargetProfile().DefaultConfigPath(filepath.Join(account.HomeDir, ".config")), nil
}

func currentDeploymentAccount() (*user.User, error) {
	account, err := user.Current()
	if err != nil {
		return nil, fmt.Errorf("resolve operating-system account: %w", err)
	}
	home := filepath.Clean(account.HomeDir)
	if account.Uid != strconv.Itoa(os.Getuid()) || account.HomeDir != home || home == string(filepath.Separator) || !canonicalStartupPath(home) {
		return nil, errors.New("operating-system account has an invalid home directory")
	}
	return account, nil
}

func canonicalStartupPath(path string) bool {
	return path != "" && filepath.IsAbs(path) && filepath.Clean(path) == path && !strings.ContainsRune(path, 0)
}

func readTargetConfigSnapshot(path string) (targetConfigSnapshot, error) {
	file, parentFD, leaf, opened, err := openStartupConfigNoFollow(path)
	if errors.Is(err, unix.ENOENT) {
		return targetConfigSnapshot{path: path}, nil
	}
	if err != nil {
		return targetConfigSnapshot{}, fmt.Errorf("open startup config: %w", err)
	}
	defer file.Close()
	defer unix.Close(parentFD)
	limited := &io.LimitedReader{R: file, N: maximumStartupConfigBytes + 1}
	raw, err := io.ReadAll(limited)
	if err != nil {
		return targetConfigSnapshot{}, fmt.Errorf("read startup config: %w", err)
	}
	if limited.N == 0 || len(raw) > maximumStartupConfigBytes {
		return targetConfigSnapshot{}, errors.New("startup config exceeded its byte limit")
	}
	if err := verifyStartupConfigStillBound(parentFD, leaf, int(file.Fd()), opened); err != nil {
		return targetConfigSnapshot{}, err
	}
	return targetConfigSnapshot{path: path, exists: true, raw: bytes.Clone(raw), identity: opened}, nil
}

func openStartupConfigNoFollow(path string) (*os.File, int, string, unix.Stat_t, error) {
	components := strings.Split(strings.TrimPrefix(path, string(filepath.Separator)), string(filepath.Separator))
	if len(components) == 0 || components[len(components)-1] == "" {
		return nil, -1, "", unix.Stat_t{}, errors.New("startup config path has no final component")
	}
	parentFD, err := unix.Open(string(filepath.Separator), unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, -1, "", unix.Stat_t{}, err
	}
	for _, component := range components[:len(components)-1] {
		if component == "" || component == "." || component == ".." {
			_ = unix.Close(parentFD)
			return nil, -1, "", unix.Stat_t{}, errors.New("startup config path contains an invalid component")
		}
		next, openErr := unix.Openat(parentFD, component, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
		_ = unix.Close(parentFD)
		if openErr != nil {
			return nil, -1, "", unix.Stat_t{}, openErr
		}
		parentFD = next
	}
	leaf := components[len(components)-1]
	fd, err := unix.Openat(parentFD, leaf, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		_ = unix.Close(parentFD)
		return nil, -1, "", unix.Stat_t{}, err
	}
	var opened unix.Stat_t
	if err := unix.Fstat(fd, &opened); err != nil {
		_ = unix.Close(fd)
		_ = unix.Close(parentFD)
		return nil, -1, "", unix.Stat_t{}, err
	}
	if opened.Mode&unix.S_IFMT != unix.S_IFREG || opened.Uid != uint32(os.Getuid()) || opened.Nlink != 1 || opened.Mode&0o022 != 0 || opened.Size < 0 || opened.Size > maximumStartupConfigBytes {
		_ = unix.Close(fd)
		_ = unix.Close(parentFD)
		return nil, -1, "", unix.Stat_t{}, errors.New("startup config must be an owner-controlled bounded regular file")
	}
	file := os.NewFile(uintptr(fd), path)
	if file == nil {
		_ = unix.Close(fd)
		_ = unix.Close(parentFD)
		return nil, -1, "", unix.Stat_t{}, errors.New("open startup config")
	}
	return file, parentFD, leaf, opened, nil
}

func verifyStartupConfigStillBound(parentFD int, leaf string, fileFD int, opened unix.Stat_t) error {
	var retained, pathItem unix.Stat_t
	if err := unix.Fstat(fileFD, &retained); err != nil {
		return fmt.Errorf("reinspect startup config: %w", err)
	}
	if err := unix.Fstatat(parentFD, leaf, &pathItem, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return fmt.Errorf("reinspect startup config path: %w", err)
	}
	if !sameStartupConfigIdentity(opened, retained) || !sameStartupConfigIdentity(opened, pathItem) || pathItem.Mode&unix.S_IFMT != unix.S_IFREG {
		return errors.New("startup config identity changed while it was read")
	}
	return nil
}

func sameStartupConfigIdentity(left, right unix.Stat_t) bool {
	return left.Dev == right.Dev && left.Ino == right.Ino && left.Mode == right.Mode && left.Uid == right.Uid && left.Gid == right.Gid && left.Nlink == right.Nlink && left.Size == right.Size &&
		left.Ctim.Sec == right.Ctim.Sec && left.Ctim.Nsec == right.Ctim.Nsec && left.Mtim.Sec == right.Mtim.Sec && left.Mtim.Nsec == right.Mtim.Nsec
}
