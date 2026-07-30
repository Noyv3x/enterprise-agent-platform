//go:build linux

package control

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
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

func TestListenRejectsLiveControlSocketWithoutRemovingIt(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "control", "manager.sock")
	owner, err := Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = owner.Close() })
	wantIdentity, err := controlSocketIdentity(path)
	if err != nil {
		t.Fatal(err)
	}

	if replacement, err := Listen(path); err == nil {
		_ = replacement.Close()
		t.Fatal("live control socket was replaced")
	}
	gotIdentity, err := controlSocketIdentity(path)
	if err != nil {
		t.Fatalf("live control socket was removed: %v", err)
	}
	if gotIdentity != wantIdentity {
		t.Fatalf("live control socket identity changed: got %#v, want %#v", gotIdentity, wantIdentity)
	}
	assertUnixSocketDialable(t, path)
}

func TestListenReplacesConnectionRefusedStaleControlSocket(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "control", "manager.sock")
	leaveStaleUnixSocket(t, path)

	listener, err := Listen(path)
	if err != nil {
		t.Fatalf("replace stale control socket: %v", err)
	}
	assertUnixSocketDialable(t, path)
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("owned control socket remained after close: %v", err)
	}
}

func TestListenRejectsSocketInodeSwapAfterStaleProbe(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "control", "manager.sock")
	staleIdentity := leaveStaleUnixSocket(t, path)
	var successor *net.UnixListener

	listener, err := listen(path, func(path string, _ time.Duration) error {
		if err := os.Remove(path); err != nil {
			t.Fatalf("remove stale socket in probe: %v", err)
		}
		successor = bindRawUnixSocket(t, path)
		successorIdentity, identityErr := controlSocketIdentity(path)
		if identityErr != nil {
			t.Fatal(identityErr)
		}
		if successorIdentity == staleIdentity {
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
			// Some filesystems immediately reuse a just-unlinked inode. Keep the
			// first successor descriptor open after unlinking its path so its
			// inode cannot be reused by the successor that the test observes.
			displaced := successor
			successor = bindRawUnixSocket(t, path)
			successorIdentity, identityErr = controlSocketIdentity(path)
			_ = displaced.Close()
			if identityErr != nil {
				t.Fatal(identityErr)
			}
			if successorIdentity == staleIdentity {
				t.Fatal("test could not construct a distinct successor socket inode")
			}
		}
		return syscall.ECONNREFUSED
	})
	if err == nil {
		_ = listener.Close()
		t.Fatal("socket inode swap was accepted as the probed stale socket")
	}
	if successor == nil {
		t.Fatal("probe did not install successor socket")
	}
	t.Cleanup(func() {
		_ = successor.Close()
		_ = os.Remove(path)
	})
	assertUnixSocketDialable(t, path)
}

func TestListenRejectsAmbiguousSocketProbeWithoutRemovingIt(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "control", "manager.sock")
	wantIdentity := leaveStaleUnixSocket(t, path)

	listener, err := listen(path, func(_ string, timeout time.Duration) error {
		if timeout <= 0 {
			t.Fatalf("probe timeout = %v, want a positive bound", timeout)
		}
		return &net.OpError{Op: "dial", Net: "unix", Err: context.DeadlineExceeded}
	})
	if err == nil {
		_ = listener.Close()
		t.Fatal("ambiguous control socket probe was accepted")
	}
	gotIdentity, err := controlSocketIdentity(path)
	if err != nil {
		t.Fatalf("ambiguous probe removed the socket: %v", err)
	}
	if gotIdentity != wantIdentity {
		t.Fatalf("ambiguous probe changed socket identity: got %#v, want %#v", gotIdentity, wantIdentity)
	}
}

func TestListenSerializesConcurrentStaleSocketClaims(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "control", "manager.sock")
	leaveStaleUnixSocket(t, path)
	probeEntered := make(chan struct{})
	releaseProbe := make(chan struct{})
	type listenResult struct {
		listener net.Listener
		err      error
	}
	firstResult := make(chan listenResult, 1)
	go func() {
		listener, err := listen(path, func(_ string, _ time.Duration) error {
			close(probeEntered)
			<-releaseProbe
			return syscall.ECONNREFUSED
		})
		firstResult <- listenResult{listener: listener, err: err}
	}()
	select {
	case <-probeEntered:
	case <-time.After(time.Second):
		t.Fatal("first stale claimant did not reach its socket probe")
	}

	secondResult := make(chan listenResult, 1)
	go func() {
		listener, err := Listen(path)
		secondResult <- listenResult{listener: listener, err: err}
	}()
	select {
	case second := <-secondResult:
		if second.err == nil {
			_ = second.listener.Close()
			close(releaseProbe)
			t.Fatal("second stale claimant bypassed the sibling bind lock")
		}
	case <-time.After(time.Second):
		close(releaseProbe)
		t.Fatal("second stale claimant blocked instead of failing nonblockingly")
	}
	close(releaseProbe)
	first := <-firstResult
	if first.err != nil {
		t.Fatalf("first stale claimant failed: %v", first.err)
	}
	if first.listener == nil {
		t.Fatal("first stale claimant returned no listener")
	}
	assertUnixSocketDialable(t, path)
	if err := first.listener.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestListenReusesDurableUnlockedBindLock(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "control", "manager.sock")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	lockPath := path + ".lock"
	if err := os.WriteFile(lockPath, []byte("durable\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	for attempt := 0; attempt < 2; attempt++ {
		listener, err := Listen(path)
		if err != nil {
			t.Fatalf("reuse durable bind lock attempt %d: %v", attempt+1, err)
		}
		if err := listener.Close(); err != nil {
			t.Fatal(err)
		}
		info, err := os.Lstat(lockPath)
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
			t.Fatalf("durable bind lock after attempt %d = %#v, err=%v", attempt+1, info, err)
		}
	}
}

func TestListenRejectsUnsafeSiblingBindLock(t *testing.T) {
	for _, test := range []struct {
		name   string
		create func(string, string) error
	}{
		{name: "symlink", create: func(lockPath, target string) error {
			if err := os.WriteFile(target, nil, 0o600); err != nil {
				return err
			}
			return os.Symlink(target, lockPath)
		}},
		{name: "hardlink", create: func(lockPath, target string) error {
			if err := os.WriteFile(target, nil, 0o600); err != nil {
				return err
			}
			return os.Link(target, lockPath)
		}},
		{name: "wide mode", create: func(lockPath, _ string) error {
			return os.WriteFile(lockPath, nil, 0o644)
		}},
		{name: "executable mode", create: func(lockPath, _ string) error {
			return os.WriteFile(lockPath, nil, 0o700)
		}},
		{name: "directory", create: func(lockPath, _ string) error {
			return os.Mkdir(lockPath, 0o700)
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			path := filepath.Join(t.TempDir(), "control", "manager.sock")
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
				t.Fatal(err)
			}
			lockPath := path + ".lock"
			target := filepath.Join(filepath.Dir(path), "target")
			if err := test.create(lockPath, target); err != nil {
				t.Fatal(err)
			}
			if listener, err := Listen(path); err == nil {
				_ = listener.Close()
				t.Fatalf("unsafe %s bind lock was accepted", test.name)
			}
			if _, err := os.Lstat(path); !os.IsNotExist(err) {
				t.Fatalf("unsafe bind lock created a control socket: %v", err)
			}
		})
	}
}

func TestListenBindLockIsCloseOnExecAndHeldUntilListenerClose(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "control", "manager.sock")
	listener, err := Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	owner, ok := listener.(*ownerListener)
	if !ok {
		_ = listener.Close()
		t.Fatalf("listener type = %T, want *ownerListener", listener)
	}
	flags, _, errno := syscall.Syscall(syscall.SYS_FCNTL, owner.bindLock.file.Fd(), syscall.F_GETFD, 0)
	if errno != 0 || flags&syscall.FD_CLOEXEC == 0 {
		_ = listener.Close()
		t.Fatalf("bind lock descriptor flags = %#x, errno=%v", flags, errno)
	}
	if successor, err := Listen(path); err == nil {
		_ = successor.Close()
		_ = listener.Close()
		t.Fatal("successor acquired bind ownership before listener close")
	}
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	successor, err := Listen(path)
	if err != nil {
		t.Fatalf("successor could not reuse released sibling bind lock: %v", err)
	}
	if err := successor.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestOwnerListenerClosePreservesSuccessorSocket(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "control", "manager.sock")
	listener, err := Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	predecessor, ok := listener.(*ownerListener)
	if !ok {
		_ = listener.Close()
		t.Fatalf("listener type = %T, want *ownerListener", listener)
	}
	var successor *net.UnixListener
	var wantIdentity socketPathIdentity
	if err := predecessor.closeAfterUnlink(func() {
		if _, statErr := os.Lstat(path); !os.IsNotExist(statErr) {
			t.Fatalf("predecessor path still exists before descriptor close: %v", statErr)
		}
		if competing, listenErr := Listen(path); listenErr == nil {
			_ = competing.Close()
			t.Fatal("sibling bind lock was released before the predecessor descriptor closed")
		}
		successor = bindRawUnixSocket(t, path)
		identity, identityErr := controlSocketIdentity(path)
		if identityErr != nil {
			t.Fatal(identityErr)
		}
		wantIdentity = identity
	}); err != nil {
		t.Fatal(err)
	}
	if successor == nil {
		t.Fatal("successor was not bound during predecessor teardown")
	}
	t.Cleanup(func() {
		_ = successor.Close()
		_ = os.Remove(path)
	})
	gotIdentity, err := controlSocketIdentity(path)
	if err != nil {
		t.Fatalf("predecessor teardown removed successor socket: %v", err)
	}
	if gotIdentity != wantIdentity {
		t.Fatalf("successor identity changed during predecessor teardown: got %#v, want %#v", gotIdentity, wantIdentity)
	}
	assertUnixSocketDialable(t, path)
}

func leaveStaleUnixSocket(t *testing.T, path string) socketPathIdentity {
	t.Helper()
	listener := bindRawUnixSocket(t, path)
	identity, err := controlSocketIdentity(path)
	if err != nil {
		_ = listener.Close()
		t.Fatal(err)
	}
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(path) })
	return identity
}

func bindRawUnixSocket(t *testing.T, path string) *net.UnixListener {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	listener.SetUnlinkOnClose(false)
	return listener
}

func assertUnixSocketDialable(t *testing.T, path string) {
	t.Helper()
	connection, err := net.DialTimeout("unix", path, time.Second)
	if err != nil {
		t.Fatalf("dial live Unix socket: %v", err)
	}
	_ = connection.Close()
}
