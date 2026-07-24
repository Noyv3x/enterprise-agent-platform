package driver

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEnsureHostLayoutRestrictsCapabilityFiles(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	state := filepath.Join(root, "manager")
	secrets := filepath.Join(state, "secrets")
	control := filepath.Join(state, "control")
	if err := os.MkdirAll(secrets, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(control, 0o777); err != nil {
		t.Fatal(err)
	}
	controlToken := filepath.Join(secrets, "manager-token")
	if err := os.WriteFile(controlToken, []byte("0123456789abcdef0123456789abcdef\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	driver := DockerCLI{DataRoot: root, StateDir: state}
	if err := driver.EnsureHostLayout(); err != nil {
		t.Fatal(err)
	}
	for _, directory := range []string{secrets, control} {
		info, err := os.Lstat(directory)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o700 {
			t.Fatalf("%s mode = %o, want 700", directory, info.Mode().Perm())
		}
	}
	for _, name := range []string{"manager-token", "manager-executor-token"} {
		path := filepath.Join(secrets, name)
		info, err := os.Lstat(path)
		if err != nil {
			t.Fatal(err)
		}
		if !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
			t.Fatalf("%s is not a 0600 regular file: %v", path, info.Mode())
		}
		if _, err := ReadOwnerSecret(path); err != nil {
			t.Fatal(err)
		}
	}
}

func TestEnsureHostLayoutRejectsSymlinkCapability(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	state := filepath.Join(root, "manager")
	secrets := filepath.Join(state, "secrets")
	if err := os.MkdirAll(secrets, 0o700); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "token-target")
	if err := os.WriteFile(target, []byte("0123456789abcdef0123456789abcdef\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(secrets, "manager-token")); err != nil {
		t.Fatal(err)
	}
	driver := DockerCLI{DataRoot: root, StateDir: state}
	if err := driver.EnsureHostLayout(); err == nil {
		t.Fatal("symlink Manager capability was accepted")
	}
}

func TestEnsureHostLayoutRejectsSymlinkPrivateDirectory(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	state := filepath.Join(root, "manager")
	if err := os.MkdirAll(state, 0o700); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "elsewhere")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(state, "secrets")); err != nil {
		t.Fatal(err)
	}
	driver := DockerCLI{DataRoot: root, StateDir: state}
	if err := driver.EnsureHostLayout(); err == nil {
		t.Fatal("symlink secrets directory was accepted")
	}
}

func TestReadOwnerSecretRejectsNonOwner(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("changing file ownership requires root")
	}
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, []byte("0123456789abcdef0123456789abcdef\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chown(path, 65534, 65534); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadOwnerSecret(path); err == nil {
		t.Fatal("non-owner secret was accepted")
	}
}
