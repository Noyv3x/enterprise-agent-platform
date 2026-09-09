package executor

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"

	"golang.org/x/sys/unix"
)

func TestReapedHostControllerCannotSignalReplacementGroup(t *testing.T) {
	old := exec.Command("/bin/true")
	old.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := old.Start(); err != nil {
		t.Fatal(err)
	}
	oldPID := old.Process.Pid
	if err := old.Wait(); err != nil {
		t.Fatal(err)
	}

	// Model reuse through a signal seam, never by forcing kernel PID reuse.
	// Any attempted signal to the stale identity would reach only this new,
	// verified test-owned process group, whose leader is not reaped until cleanup.
	report := filepath.Join(t.TempDir(), "replacement")
	replacement := exec.Command(os.Args[0], "-test.run=^TestProcessBoundaryBoundaryHelper$", "--", "process-boundary-helper", "idle", report)
	replacement.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := replacement.Start(); err != nil {
		t.Fatal(err)
	}
	reaped := false
	defer func() {
		if !reaped {
			_ = syscall.Kill(-replacement.Process.Pid, syscall.SIGKILL)
			_ = replacement.Wait()
		}
	}()
	pid, _ := processBoundaryReport(t, report)
	parent, group, start, _, err := processBoundaryIdentity(pid)
	if err != nil || pid != replacement.Process.Pid || parent != os.Getpid() || group != pid {
		t.Fatalf("replacement group is not test-owned: %d %v", pid, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err = waitHostProcessGroup(ctx, oldPID, func(_ int, signal syscall.Signal) error {
		return syscall.Kill(-pid, signal)
	})
	if !errors.Is(err, syscall.ECHILD) {
		t.Fatalf("reaped controller must fail closed: %v", err)
	}
	_, _, current, state, err := processBoundaryIdentity(pid)
	if err != nil || current != start || state == "Z" || state == "X" {
		t.Fatalf("replacement group was affected by stale controller cancellation: %v state=%s", err, state)
	}
	err = replacement.Wait()
	reaped = true
	if err != nil {
		t.Fatalf("replacement process did not retain its natural successful exit: %v", err)
	}
}

func TestHostGroupObservationIgnoresUnreadableUnrelatedProcess(t *testing.T) {
	for _, live := range []bool{false, true} {
		name := "exited-owned-group"
		if live {
			name = "live-owned-group"
		}
		t.Run(name, func(t *testing.T) {
			start := func(name string, args ...string) *exec.Cmd {
				command := exec.Command(name, args...)
				command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
				if err := command.Start(); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() {
					// This test is the sole reaper; even an exited child
					// retains its identity until cleanup.
					_ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
					_ = command.Wait()
				})
				return command
			}
			var owned *exec.Cmd
			if live {
				owned = start("/bin/sleep", "30")
			} else {
				owned = start("/bin/true")
				var info unix.Siginfo
				if err := unix.Waitid(unix.P_PID, owned.Process.Pid, &info, unix.WEXITED|unix.WNOWAIT, nil); err != nil {
					t.Fatal(err)
				}
			}
			unrelated := start("/bin/sleep", "30")
			group := owned.Process.Pid
			if otherGroup, err := syscall.Getpgid(unrelated.Process.Pid); err != nil || otherGroup == group {
				t.Fatalf("unrelated fixture is not in a distinct group: %d %v", otherGroup, err)
			}
			directory := t.TempDir()
			for _, pid := range []int{group, unrelated.Process.Pid} {
				if err := os.Mkdir(filepath.Join(directory, strconv.Itoa(pid)), 0700); err != nil {
					t.Fatal(err)
				}
			}
			entries, err := os.ReadDir(directory)
			if err != nil {
				t.Fatal(err)
			}
			stopped := observeHostProcessGroup(group, entries, func(pid int) ([]byte, error) {
				path := filepath.Join("/proc", strconv.Itoa(pid), "stat")
				if pid == unrelated.Process.Pid || live && pid == group {
					// hidepid=1 exposes the PID directory but denies stat.
					return nil, &os.PathError{Op: "open", Path: path, Err: syscall.EACCES}
				}
				return os.ReadFile(path)
			})
			if stopped == live {
				t.Fatalf("group stopped=%t with owned member live=%t and unrelated stat denied", stopped, live)
			}
		})
	}
}
