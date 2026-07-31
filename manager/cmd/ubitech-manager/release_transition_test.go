//go:build linux

package main

import (
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

func TestReleaseTransitionOwnerFilesRejectUnsafeInputs(t *testing.T) {
	root := t.TempDir()
	input := filepath.Join(root, "challenge.json")
	if err := os.WriteFile(input, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	data, err := readOwnerInputFile(input, 1024)
	if err != nil || string(data) != "{}\n" {
		t.Fatalf("read safe input = %q, %v", data, err)
	}
	if err := os.Chmod(input, 0o640); err != nil {
		t.Fatal(err)
	}
	if _, err := readOwnerInputFile(input, 1024); err == nil {
		t.Fatal("group-readable challenge was accepted")
	}
	link := filepath.Join(root, "challenge-link.json")
	if err := os.Symlink(input, link); err != nil {
		t.Fatal(err)
	}
	if _, err := readOwnerInputFile(link, 1024); err == nil {
		t.Fatal("symlink challenge was accepted")
	}
	if err := os.Chmod(input, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(input, filepath.Join(root, "challenge-hardlink.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := readOwnerInputFile(input, 1024); err == nil {
		t.Fatal("hard-linked challenge was accepted")
	}
}

func TestWriteOwnerOutputPairIsExclusiveAndOwnerOnly(t *testing.T) {
	root := t.TempDir()
	receipt := filepath.Join(root, "receipt.json")
	signature := filepath.Join(root, "receipt.sig")
	if err := writeOwnerOutputPair(receipt, []byte("{}\n"), signature, []byte("signature\n")); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{receipt, signature} {
		info, err := os.Lstat(path)
		if err != nil {
			t.Fatal(err)
		}
		if !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
			t.Fatalf("unsafe output %s: %v", path, info.Mode())
		}
	}
	if err := writeOwnerOutputPair(receipt, []byte("changed\n"), signature, []byte("changed\n")); err == nil || !strings.Contains(err.Error(), "exists") {
		t.Fatalf("output overwrite result: %v", err)
	}
}

func TestWriteOwnerOutputPairRollsBackFirstFileWhenSecondCannotBeCreated(t *testing.T) {
	root := t.TempDir()
	receipt := filepath.Join(root, "receipt.json")
	signature := filepath.Join(root, "receipt.sig")
	if err := os.WriteFile(signature, []byte("existing"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writeOwnerOutputPair(receipt, []byte("{}\n"), signature, []byte("signature\n")); err == nil {
		t.Fatal("existing signature was overwritten")
	}
	if _, err := os.Lstat(receipt); !os.IsNotExist(err) {
		t.Fatalf("partial receipt was retained: %v", err)
	}
}

func TestOwnerFilesRejectSymlinkedParentDirectories(t *testing.T) {
	root := t.TempDir()
	external := filepath.Join(root, "external")
	if err := os.Mkdir(external, 0o700); err != nil {
		t.Fatal(err)
	}
	linked := filepath.Join(root, "linked")
	if err := os.Symlink(external, linked); err != nil {
		t.Fatal(err)
	}
	input := filepath.Join(external, "challenge.json")
	if err := os.WriteFile(input, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readOwnerInputFile(filepath.Join(linked, "challenge.json"), 1024); err == nil {
		t.Fatal("input beneath a symlinked parent was accepted")
	}
	if err := writeNewOwnerFile(filepath.Join(linked, "receipt.json"), []byte("{}\n")); err == nil {
		t.Fatal("output beneath a symlinked parent was accepted")
	}
	if _, err := os.Lstat(filepath.Join(external, "receipt.json")); !os.IsNotExist(err) {
		t.Fatalf("output writer followed a symlinked parent: %v", err)
	}
}

func TestOwnerOutputCleanupPreservesConcurrentReplacement(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "receipt.json")
	parent, err := openOwnerParent(path)
	if err != nil {
		t.Fatal(err)
	}
	defer parent.close()
	created, err := createOwnerOutput(parent, []byte("original\n"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path, filepath.Join(root, "moved.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("replacement\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := unlinkCreatedOwnerFile(created); err == nil {
		t.Fatal("cleanup accepted a replacement inode")
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "replacement\n" {
		t.Fatalf("replacement after cleanup = %q, %v", data, err)
	}
}

func TestOwnerOutputRejectsParentPathReplacementBeforeCreate(t *testing.T) {
	root := t.TempDir()
	original := filepath.Join(root, "output")
	if err := os.Mkdir(original, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(original, "receipt.json")
	parent, err := openOwnerParent(path)
	if err != nil {
		t.Fatal(err)
	}
	defer parent.close()
	if err := os.Rename(original, filepath.Join(root, "moved")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(original, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := createOwnerOutput(parent, []byte("{}\n")); err == nil {
		t.Fatal("output writer accepted a replaced parent path")
	}
	if _, err := os.Lstat(filepath.Join(original, "receipt.json")); !os.IsNotExist(err) {
		t.Fatalf("replacement directory received output: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(root, "moved", "receipt.json")); !os.IsNotExist(err) {
		t.Fatalf("detached original directory received output: %v", err)
	}
}

func TestManagerInstallPathIgnoresMutableHome(t *testing.T) {
	t.Setenv("XDG_BIN_HOME", "")
	t.Setenv("HOME", filepath.Join(t.TempDir(), "attacker-home"))
	account, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	profile := identity.SourceProfile()
	want := filepath.Join(account.HomeDir, ".local", "bin", profile.ManagerBinary)
	if got := managerInstallPath(identity.SourceActiveProfile()); got != want {
		t.Fatalf("manager install path = %q, want OS-account path %q", got, want)
	}
}
