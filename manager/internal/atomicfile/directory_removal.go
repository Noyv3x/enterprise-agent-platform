package atomicfile

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// DirectoryRemoval binds domain validation to one flat, immutable directory.
// Snapshot and release layouts contain only regular files; subdirectories and
// links are deliberately not granted recursive deletion authority.
type DirectoryRemoval struct {
	path      string
	parent    unix.Stat_t
	directory unix.Stat_t
	entries   map[string]unix.Stat_t
}

// PlanDirectoryRemoval brackets slow domain validation with identity/ctime
// checks. Remove therefore need not hash snapshot bytes under the admission lock.
func PlanDirectoryRemoval(path string, validate func() error) (*DirectoryRemoval, error) {
	path, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	p := &DirectoryRemoval{path: path, entries: make(map[string]unix.Stat_t)}
	parent, directory, err := p.open()
	if err != nil {
		return nil, err
	}
	defer parent.Close()
	defer directory.Close()
	if err := unix.Fstat(int(parent.Fd()), &p.parent); err != nil {
		return nil, err
	}
	if err := unix.Fstat(int(directory.Fd()), &p.directory); err != nil {
		return nil, err
	}
	entries, err := directory.ReadDir(-1)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		var st unix.Stat_t
		if err := unix.Fstatat(int(directory.Fd()), entry.Name(), &st, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return nil, err
		}
		if st.Mode&unix.S_IFMT != unix.S_IFREG || st.Uid != uint32(os.Geteuid()) || st.Nlink != 1 || st.Mode&0o022 != 0 {
			return nil, errors.New("removal candidate contains an unsafe file")
		}
		p.entries[entry.Name()] = st
	}
	if err := validate(); err != nil {
		return nil, err
	}
	if err := p.check(parent, directory, p.directory, p.entries); err != nil {
		return nil, err
	}
	return p, nil
}

func (p *DirectoryRemoval) open() (*os.File, *os.File, error) {
	root := filepath.Dir(p.path)
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil || resolved != root {
		return nil, nil, errors.New("removal parent is not canonical")
	}
	fd, err := unix.Open(root, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, nil, err
	}
	parent := os.NewFile(uintptr(fd), root)
	fd, err = unix.Openat(int(parent.Fd()), filepath.Base(p.path), unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		parent.Close()
		return nil, nil, err
	}
	return parent, os.NewFile(uintptr(fd), p.path), nil
}

func sameRemovalObject(a, b unix.Stat_t) bool {
	return a.Dev == b.Dev && a.Ino == b.Ino && a.Mode == b.Mode && a.Uid == b.Uid && a.Gid == b.Gid
}

func sameRemovalVersion(a, b unix.Stat_t) bool {
	return sameRemovalObject(a, b) && a.Nlink == b.Nlink && a.Size == b.Size && a.Mtim == b.Mtim && a.Ctim == b.Ctim
}

func (p *DirectoryRemoval) check(parent, directory *os.File, expected unix.Stat_t, entries map[string]unix.Stat_t) error {
	var root, rootPath, opened, named unix.Stat_t
	if err := unix.Fstat(int(parent.Fd()), &root); err != nil {
		return err
	}
	if err := unix.Lstat(filepath.Dir(p.path), &rootPath); err != nil {
		return err
	}
	if !sameRemovalObject(root, p.parent) || !sameRemovalObject(root, rootPath) || root.Uid != uint32(os.Geteuid()) || root.Mode&0o022 != 0 {
		return errors.New("removal parent identity changed or is unsafe")
	}
	if err := unix.Fstat(int(directory.Fd()), &opened); err != nil {
		return err
	}
	if err := unix.Fstatat(int(parent.Fd()), filepath.Base(p.path), &named, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return err
	}
	if !sameRemovalVersion(opened, expected) || !sameRemovalVersion(named, expected) || opened.Uid != uint32(os.Geteuid()) || opened.Mode&0o022 != 0 {
		return errors.New("removal directory identity changed or is unsafe")
	}
	if _, err := directory.Seek(0, 0); err != nil {
		return err
	}
	current, err := directory.ReadDir(-1)
	if err != nil {
		return err
	}
	if len(current) != len(entries) {
		return errors.New("removal directory entries changed")
	}
	for _, entry := range current {
		before, ok := entries[entry.Name()]
		var after unix.Stat_t
		if !ok {
			return errors.New("removal directory contains an unplanned entry")
		}
		if err := unix.Fstatat(int(directory.Fd()), entry.Name(), &after, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return err
		}
		if !sameRemovalVersion(before, after) {
			return fmt.Errorf("removal entry %q changed", entry.Name())
		}
	}
	// Enumeration must itself have observed a stable directory.
	if err := unix.Fstat(int(directory.Fd()), &opened); err != nil {
		return err
	}
	if !sameRemovalVersion(opened, expected) {
		return errors.New("removal directory changed during inspection")
	}
	return nil
}

// Remove must run inside the caller's removal guard. It never resolves child
// paths again, moves evidence aside, or deletes an entry absent from the plan.
func (p *DirectoryRemoval) Remove() error {
	parent, directory, err := p.open()
	if err != nil {
		return err
	}
	defer parent.Close()
	defer directory.Close()
	expected := p.directory
	remaining := make(map[string]unix.Stat_t, len(p.entries))
	for name, st := range p.entries {
		remaining[name] = st
	}
	for name := range p.entries {
		if err := p.check(parent, directory, expected, remaining); err != nil {
			return err
		}
		if err := unix.Unlinkat(int(directory.Fd()), name, 0); err != nil {
			return err
		}
		if err := directory.Sync(); err != nil {
			return err
		}
		delete(remaining, name)
		if err := unix.Fstat(int(directory.Fd()), &expected); err != nil {
			return err
		}
	}
	if err := p.check(parent, directory, expected, remaining); err != nil {
		return err
	}
	if err := unix.Unlinkat(int(parent.Fd()), filepath.Base(p.path), unix.AT_REMOVEDIR); err != nil {
		return err
	}
	return parent.Sync()
}
