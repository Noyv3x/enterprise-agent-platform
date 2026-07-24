//go:build linux

package control

import (
	"os"
	"path/filepath"
	"testing"
)

func TestListenRestrictsControlDirectoryAndSocket(t *testing.T) {
	t.Parallel()
	directory := filepath.Join(t.TempDir(), "control")
	if err := os.Mkdir(directory, 0o777); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "manager.sock")
	listener, err := Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	for name, expected := range map[string]os.FileMode{directory: 0o700, path: 0o600} {
		info, err := os.Lstat(name)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != expected {
			t.Fatalf("%s mode = %o, want %o", name, info.Mode().Perm(), expected)
		}
	}
}

func TestListenRejectsSymlinkControlDirectory(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	target := filepath.Join(root, "target")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "control")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if listener, err := Listen(filepath.Join(link, "manager.sock")); err == nil {
		_ = listener.Close()
		t.Fatal("symlink control directory was accepted")
	}
}
