//go:build linux

package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"golang.org/x/sys/unix"
)

const maximumStartupLocatorConfigBytes = 1 << 20

type startupConfigSnapshot struct {
	Path      string
	Exists    bool
	Raw       []byte
	StateHome string
	identity  unix.Stat_t
}

// locateStartupStateHome performs the only config read allowed before the
// terminal handoff journal selects a technical profile.  It deliberately
// understands just state_home; every other setting is parsed later under the
// profile selected by the journal.  An omitted state_home is the immutable
// OS-account default rather than an XDG/HOME environment value.
func locateStartupStateHome(configPath string) (string, error) {
	snapshot, err := locateStartupConfigSnapshot(configPath)
	if err != nil {
		return "", err
	}
	return snapshot.StateHome, nil
}

func locateStartupConfigSnapshot(configPath string) (startupConfigSnapshot, error) {
	account, err := user.Current()
	if err != nil {
		return startupConfigSnapshot{}, fmt.Errorf("resolve operating-system account: %w", err)
	}
	home := filepath.Clean(account.HomeDir)
	if account.Uid != strconv.Itoa(os.Getuid()) || account.HomeDir != home || home == string(filepath.Separator) || !canonicalStartupPath(home) {
		return startupConfigSnapshot{}, errors.New("operating-system account has an invalid home directory")
	}
	defaultStateHome := filepath.Join(home, ".local", "state")
	if configPath == "" {
		active, profileErr := identity.CompileTimeActiveProfile()
		if profileErr != nil {
			return startupConfigSnapshot{}, fmt.Errorf("select compiled startup technical profile: %w", profileErr)
		}
		profile, profileErr := active.Profile()
		if profileErr != nil {
			return startupConfigSnapshot{}, profileErr
		}
		configPath = profile.DefaultConfigPath(filepath.Join(home, ".config"))
	}
	if !canonicalStartupPath(configPath) {
		return startupConfigSnapshot{}, errors.New("startup config path must be canonical and absolute")
	}
	file, parentFD, leaf, opened, err := openStartupConfigNoFollow(configPath)
	if errors.Is(err, unix.ENOENT) {
		return startupConfigSnapshot{Path: configPath, StateHome: defaultStateHome}, nil
	}
	if err != nil {
		return startupConfigSnapshot{}, fmt.Errorf("open startup config locator: %w", err)
	}
	defer file.Close()
	defer unix.Close(parentFD)
	limited := &io.LimitedReader{R: file, N: maximumStartupLocatorConfigBytes + 1}
	raw, err := io.ReadAll(limited)
	if err != nil {
		return startupConfigSnapshot{}, fmt.Errorf("read startup config locator: %w", err)
	}
	if limited.N == 0 || len(raw) > maximumStartupLocatorConfigBytes {
		return startupConfigSnapshot{}, errors.New("startup config locator exceeded its byte limit while it was read")
	}
	if err := verifyStartupConfigStillBound(parentFD, leaf, int(file.Fd()), opened); err != nil {
		return startupConfigSnapshot{}, err
	}
	stateHome, err := parseStartupStateHome(raw, home, defaultStateHome)
	if err != nil {
		return startupConfigSnapshot{}, err
	}
	return startupConfigSnapshot{
		Path: configPath, Exists: true, Raw: append([]byte(nil), raw...), StateHome: stateHome, identity: opened,
	}, nil
}

func startupConfigSnapshotSHA256(snapshot startupConfigSnapshot) (string, error) {
	if !snapshot.Exists {
		return "", errors.New("startup config snapshot is missing")
	}
	digest := sha256.Sum256(snapshot.Raw)
	return hex.EncodeToString(digest[:]), nil
}

// secureStartupConfigSnapshotSHA256 uses the startup locator's component-wise
// no-follow open and read-after-fstatat revalidation rather than reopening an
// absolute pathname through potentially replaced parent symlinks.
func secureStartupConfigSnapshotSHA256(path string) (string, error) {
	snapshot, err := locateStartupConfigSnapshot(path)
	if err != nil {
		return "", err
	}
	return startupConfigSnapshotSHA256(snapshot)
}

func defaultSourceStartupConfigPath(accountHome string) string {
	return identity.SourceProfile().DefaultConfigPath(filepath.Join(accountHome, ".config"))
}

func parseStartupStateHome(config []byte, home, defaultStateHome string) (string, error) {
	stateHome := defaultStateHome
	found := false
	scanner := bufio.NewScanner(bytes.NewReader(config))
	scanner.Buffer(make([]byte, 4096), maximumStartupLocatorConfigBytes)
	for line := 1; scanner.Scan(); line++ {
		raw := strings.TrimSpace(strings.SplitN(scanner.Text(), "#", 2)[0])
		if raw == "" || strings.HasPrefix(raw, "[") {
			continue
		}
		parts := strings.SplitN(raw, "=", 2)
		if len(parts) != 2 {
			return "", fmt.Errorf("startup config locator line %d is malformed", line)
		}
		if strings.TrimSpace(parts[0]) != "state_home" {
			continue
		}
		if found {
			return "", errors.New("startup config locator contains duplicate state_home settings")
		}
		found = true
		value := strings.Trim(strings.TrimSpace(parts[1]), "\"")
		if value == "~" {
			value = home
		} else if strings.HasPrefix(value, "~/") {
			value = filepath.Join(home, strings.TrimPrefix(value, "~/"))
		}
		if !canonicalStartupPath(value) {
			return "", errors.New("startup state_home must be canonical and absolute")
		}
		stateHome = value
	}
	if err := scanner.Err(); err != nil {
		return "", fmt.Errorf("read startup config locator: %w", err)
	}
	return stateHome, nil
}

func verifyStartupConfigSnapshotStillBound(snapshot startupConfigSnapshot) error {
	if snapshot.Path == "" {
		return nil
	}
	file, parentFD, leaf, opened, err := openStartupConfigNoFollow(snapshot.Path)
	if !snapshot.Exists {
		if errors.Is(err, unix.ENOENT) {
			return nil
		}
		if err == nil {
			file.Close()
			unix.Close(parentFD)
			return errors.New("startup config appeared after the routing snapshot")
		}
		return fmt.Errorf("reinspect missing startup config snapshot: %w", err)
	}
	if err != nil {
		return fmt.Errorf("reopen startup config snapshot: %w", err)
	}
	defer file.Close()
	defer unix.Close(parentFD)
	if !sameStartupConfigIdentity(snapshot.identity, opened) {
		return errors.New("startup config path identity changed after routing")
	}
	limited := &io.LimitedReader{R: file, N: maximumStartupLocatorConfigBytes + 1}
	raw, readErr := io.ReadAll(limited)
	if readErr != nil || limited.N == 0 || !bytes.Equal(raw, snapshot.Raw) {
		return errors.Join(readErr, errors.New("startup config content changed after routing"))
	}
	return verifyStartupConfigStillBound(parentFD, leaf, int(file.Fd()), opened)
}

func canonicalStartupPath(path string) bool {
	return path != "" && filepath.IsAbs(path) && filepath.Clean(path) == path && !strings.ContainsRune(path, 0)
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
	if opened.Mode&unix.S_IFMT != unix.S_IFREG || opened.Uid != uint32(os.Getuid()) || opened.Mode&0o022 != 0 || opened.Size < 0 || opened.Size > maximumStartupLocatorConfigBytes {
		_ = unix.Close(fd)
		_ = unix.Close(parentFD)
		return nil, -1, "", unix.Stat_t{}, errors.New("startup config locator must be an owner-controlled bounded regular file")
	}
	file := os.NewFile(uintptr(fd), path)
	if file == nil {
		_ = unix.Close(fd)
		_ = unix.Close(parentFD)
		return nil, -1, "", unix.Stat_t{}, errors.New("open startup config locator")
	}
	return file, parentFD, leaf, opened, nil
}

func verifyStartupConfigStillBound(parentFD int, leaf string, fileFD int, opened unix.Stat_t) error {
	var retained unix.Stat_t
	if err := unix.Fstat(fileFD, &retained); err != nil {
		return fmt.Errorf("reinspect startup config locator: %w", err)
	}
	var pathItem unix.Stat_t
	if err := unix.Fstatat(parentFD, leaf, &pathItem, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return fmt.Errorf("reinspect startup config path item: %w", err)
	}
	if !sameStartupConfigIdentity(opened, retained) || !sameStartupConfigIdentity(opened, pathItem) || pathItem.Mode&unix.S_IFMT != unix.S_IFREG {
		return errors.New("startup config locator identity changed while it was read")
	}
	return nil
}

func sameStartupConfigIdentity(left, right unix.Stat_t) bool {
	return left.Dev == right.Dev && left.Ino == right.Ino && left.Mode == right.Mode && left.Uid == right.Uid && left.Gid == right.Gid && left.Size == right.Size &&
		left.Ctim.Sec == right.Ctim.Sec && left.Ctim.Nsec == right.Ctim.Nsec && left.Mtim.Sec == right.Mtim.Sec && left.Mtim.Nsec == right.Mtim.Nsec
}
