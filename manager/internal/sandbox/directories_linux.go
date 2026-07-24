//go:build linux

package sandbox

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// ensureOwnedDirectoryBelow walks from the configured data directory with
// directory file descriptors. No path component below dataDir may be a
// symlink, non-directory, or owned by an identity other than the Manager's
// deployment UID/GID.
func ensureOwnedDirectoryBelow(dataDir, target string, uid, gid int) error {
	base := filepath.Clean(dataDir)
	target = filepath.Clean(target)
	if !filepath.IsAbs(base) || !filepath.IsAbs(target) {
		return errors.New("sandbox data and bind paths must be absolute")
	}
	relative, err := filepath.Rel(base, target)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return errors.New("sandbox bind root must be below the configured data directory")
	}
	if err := os.MkdirAll(base, 0o700); err != nil {
		return fmt.Errorf("create sandbox data directory: %w", err)
	}
	currentFD, err := syscall.Open(base, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return fmt.Errorf("open sandbox data directory without following links: %w", err)
	}
	defer func() { _ = syscall.Close(currentFD) }()
	if err := requireOwnedDirectoryFD(currentFD, uid, gid); err != nil {
		return fmt.Errorf("validate sandbox data directory: %w", err)
	}

	parts := strings.Split(relative, string(filepath.Separator))
	for index, part := range parts {
		if part == "" || part == "." || part == ".." {
			return errors.New("sandbox bind root contains an invalid path segment")
		}
		nextFD, openErr := syscall.Openat(currentFD, part, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		if errors.Is(openErr, syscall.ENOENT) {
			if mkdirErr := syscall.Mkdirat(currentFD, part, 0o700); mkdirErr != nil && !errors.Is(mkdirErr, syscall.EEXIST) {
				return fmt.Errorf("create sandbox directory %q: %w", part, mkdirErr)
			}
			nextFD, openErr = syscall.Openat(currentFD, part, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		}
		if openErr != nil {
			return fmt.Errorf("open sandbox directory %q without following links: %w", part, openErr)
		}
		if err := requireOwnedDirectoryFD(nextFD, uid, gid); err != nil {
			_ = syscall.Close(nextFD)
			return fmt.Errorf("validate sandbox directory %q: %w", part, err)
		}
		if index == len(parts)-1 {
			if err := syscall.Fchmod(nextFD, 0o700); err != nil {
				_ = syscall.Close(nextFD)
				return fmt.Errorf("restrict sandbox bind root %q: %w", part, err)
			}
		}
		_ = syscall.Close(currentFD)
		currentFD = nextFD
	}
	return nil
}

func requireOwnedDirectoryFD(fd, uid, gid int) error {
	var stat syscall.Stat_t
	if err := syscall.Fstat(fd, &stat); err != nil {
		return fmt.Errorf("inspect directory: %w", err)
	}
	if stat.Mode&syscall.S_IFMT != syscall.S_IFDIR {
		return errors.New("path is not a directory")
	}
	if stat.Uid != uint32(uid) || stat.Gid != uint32(gid) {
		return fmt.Errorf("directory is not owned by deployment identity %d:%d", uid, gid)
	}
	return nil
}
