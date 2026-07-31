//go:build linux

package selfupdate

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadBoundRunningExecutableRequiresTheSameInode(t *testing.T) {
	root := t.TempDir()
	data := []byte("same executable bytes on distinct inodes\n")
	immutable := filepath.Join(root, "immutable-manager")
	copyPath := filepath.Join(root, "copied-manager")
	for _, path := range []string{immutable, copyPath} {
		if err := os.WriteFile(path, data, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	digest := sha256Hex(data)
	if _, err := readBoundRunningExecutable(copyPath, immutable, digest); err == nil || !strings.Contains(err.Error(), "immutable owner inode") {
		t.Fatalf("same-content distinct inode was accepted: %v", err)
	}
	got, err := readBoundRunningExecutable(immutable, immutable, digest)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("same executable inode was rejected: bytes=%q err=%v", got, err)
	}
}

func TestReadBoundRunningExecutableRejectsWrongDigest(t *testing.T) {
	path := filepath.Join(t.TempDir(), "immutable-manager")
	if err := os.WriteFile(path, []byte("manager executable\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := readBoundRunningExecutable(path, path, strings.Repeat("a", 64)); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("wrong executable digest was accepted: %v", err)
	}
}
