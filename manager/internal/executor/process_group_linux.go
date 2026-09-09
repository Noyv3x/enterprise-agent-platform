package executor

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// waitHostProcessGroup owns the pre-reap lifetime of this direct child. WNOWAIT
// pins its PID even after exit, so a group signal cannot target a reused PGID.
// Only the caller may reap the child, after this function has returned.
func waitHostProcessGroup(ctx context.Context, pid int, signal func(int, syscall.Signal) error) error {
	if pid <= 1 {
		return syscall.ECHILD
	}
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	signalled := false
	for {
		var info unix.Siginfo
		err := unix.Waitid(unix.P_PID, pid, &info, unix.WEXITED|unix.WNOWAIT|unix.WNOHANG, nil)
		if errors.Is(err, syscall.EINTR) {
			continue
		}
		if err != nil {
			// ECHILD includes an already-reaped controller. Never signal an
			// unbound numeric group, even when the request was cancelled.
			return err
		}
		if info.Signo != 0 && hostProcessGroupStopped(pid) {
			return nil
		}
		if !signalled && ctx.Err() != nil {
			if err := signal(-pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
				return err
			}
			signalled = true
		}
		if signalled {
			<-ticker.C
		} else {
			select {
			case <-ctx.Done():
			case <-ticker.C:
			}
		}
	}
}

// A dead descendant may await reaping by its new parent. Zombies cannot run or
// retain pipes; they must not keep an otherwise stopped process group active.
func hostProcessGroupStopped(group int) bool {
	if err := syscall.Kill(-group, 0); errors.Is(err, syscall.ESRCH) {
		return true
	}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return false
	}
	return observeHostProcessGroup(group, entries, func(pid int) ([]byte, error) {
		return os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	})
}

// observeHostProcessGroup accepts a proc snapshot reader so proc visibility
// restrictions can be exercised without privileged procfs remounts.
func observeHostProcessGroup(group int, entries []os.DirEntry, readStat func(int) ([]byte, error)) bool {
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		data, err := readStat(pid)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			if errors.Is(err, syscall.EACCES) || errors.Is(err, syscall.EPERM) {
				// hidepid may hide stat for unrelated users while leaving
				// their PID directory visible. Ask the kernel for group
				// membership before attributing that denial to our group.
				// Unknown membership or an unreadable owned member remains
				// unconfirmed; neither can be treated as a stopped process.
				pgid, groupErr := syscall.Getpgid(pid)
				if errors.Is(groupErr, syscall.ESRCH) || groupErr == nil && pgid != group {
					continue
				}
			}
			return false
		}
		end := strings.LastIndexByte(string(data), ')')
		if end < 0 {
			return false
		}
		fields := strings.Fields(string(data[end+1:]))
		if len(fields) < 3 {
			return false
		}
		pgid, err := strconv.Atoi(fields[2])
		if err != nil {
			return false
		}
		if pgid == group && fields[0] != "Z" && fields[0] != "X" {
			return false
		}
	}
	return true
}
