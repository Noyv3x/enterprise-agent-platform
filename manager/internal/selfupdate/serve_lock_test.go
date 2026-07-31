package selfupdate

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestAcquireServeLockCreatesFreshRootAndRetainsSingleton(t *testing.T) {
	stateDirectory := t.TempDir()
	if err := os.Chmod(stateDirectory, 0o755); err != nil {
		t.Fatal(err)
	}
	manager := &Manager{Profile: testActiveProfile, Root: filepath.Join(stateDirectory, "manager-binaries")}

	lease, err := manager.AcquireServeLock()
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	stateInfo, err := os.Lstat(stateDirectory)
	if err != nil || stateInfo.Mode().Perm() != 0o700 {
		t.Fatalf("fresh serve state root mode = %#v, err=%v", stateInfo, err)
	}

	rootInfo, err := os.Lstat(manager.Root)
	if err != nil || !rootInfo.IsDir() || rootInfo.Mode().Perm() != 0o700 {
		t.Fatalf("fresh serve root = %#v, err=%v", rootInfo, err)
	}
	lockPath := filepath.Join(manager.Root, managerServeLockName)
	lockInfo, err := os.Lstat(lockPath)
	if err != nil || !lockInfo.Mode().IsRegular() || lockInfo.Mode().Perm() != 0o600 {
		t.Fatalf("fresh serve lock = %#v, err=%v", lockInfo, err)
	}
	flags, _, errno := syscall.Syscall(syscall.SYS_FCNTL, lease.file.Fd(), syscall.F_GETFD, 0)
	if errno != 0 || flags&syscall.FD_CLOEXEC == 0 {
		t.Fatalf("serve lock descriptor flags = %#x, errno=%v", flags, errno)
	}
	if second, err := manager.AcquireServeLock(); err == nil {
		second.Release()
		t.Fatal("second serve acquired the singleton while its owner was live")
	} else if !strings.Contains(err.Error(), "already owns") {
		t.Fatalf("second serve lock error = %v", err)
	}

	lease.Release()
	second, err := manager.AcquireServeLock()
	if err != nil {
		t.Fatalf("serve lock was not reusable after release: %v", err)
	}
	second.Release()
}

func TestAcquireServeLockRejectsUnsafeRootAndLock(t *testing.T) {
	t.Run("fresh parent writable by another identity", func(t *testing.T) {
		parent := t.TempDir()
		if err := os.Chmod(parent, 0o777); err != nil {
			t.Fatal(err)
		}
		root := filepath.Join(parent, "manager-binaries")
		if lease, err := (&Manager{Profile: testActiveProfile, Root: root}).AcquireServeLock(); err == nil {
			lease.Release()
			t.Fatal("unsafe fresh-install parent was repaired and accepted")
		}
		if _, err := os.Lstat(root); !os.IsNotExist(err) {
			t.Fatalf("unsafe fresh-install parent gained a binary root: %v", err)
		}
		info, err := os.Lstat(parent)
		if err != nil || info.Mode().Perm() != 0o777 {
			t.Fatalf("unsafe fresh-install parent was mutated: %#v, err=%v", info, err)
		}
	})

	t.Run("root symlink", func(t *testing.T) {
		base := t.TempDir()
		target := filepath.Join(base, "target")
		if err := os.Mkdir(target, 0o700); err != nil {
			t.Fatal(err)
		}
		root := filepath.Join(base, "manager-binaries")
		if err := os.Symlink(target, root); err != nil {
			t.Fatal(err)
		}
		if lease, err := (&Manager{Profile: testActiveProfile, Root: root}).AcquireServeLock(); err == nil {
			lease.Release()
			t.Fatal("symlink Manager root was accepted")
		}
	})

	t.Run("root broad mode", func(t *testing.T) {
		root := filepath.Join(t.TempDir(), "manager-binaries")
		if err := os.Mkdir(root, 0o755); err != nil {
			t.Fatal(err)
		}
		if lease, err := (&Manager{Profile: testActiveProfile, Root: root}).AcquireServeLock(); err == nil {
			lease.Release()
			t.Fatal("broad Manager root mode was accepted")
		}
	})

	for _, test := range []struct {
		name   string
		create func(string) error
	}{
		{name: "symlink", create: func(path string) error { return os.Symlink("target", path) }},
		{name: "directory", create: func(path string) error { return os.Mkdir(path, 0o700) }},
		{name: "broad mode", create: func(path string) error { return os.WriteFile(path, nil, 0o644) }},
	} {
		t.Run("lock "+test.name, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "manager-binaries")
			if err := os.Mkdir(root, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := test.create(filepath.Join(root, managerServeLockName)); err != nil {
				t.Fatal(err)
			}
			if lease, err := (&Manager{Profile: testActiveProfile, Root: root}).AcquireServeLock(); err == nil {
				lease.Release()
				t.Fatalf("unsafe %s serve lock was accepted", test.name)
			}
		})
	}
}

func TestServeLockPrecedesBusyExternalRecoveryProbe(t *testing.T) {
	fixture, _ := newExternalRecoveryProbeFixture(t)
	releaseRecovery, err := acquireRecoveryLock(fixture.manager.Root)
	if err != nil {
		t.Fatal(err)
	}
	defer releaseRecovery()

	serveLease, err := fixture.manager.AcquireServeLock()
	if err != nil {
		t.Fatalf("acquire serve lock outside busy recovery lock: %v", err)
	}
	defer serveLease.Release()
	startupLease, err := fixture.manager.AcquireStartupOwnership()
	if err != nil || startupLease == nil || !startupLease.ExternalRecoveryProbe() {
		t.Fatalf("busy external recovery admission = %#v, err=%v", startupLease, err)
	}
	startupLease.Release()
}
