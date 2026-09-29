package selfupdate

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

// ErrLauncherStopped asks the service entrypoint to exit successfully after
// bounded startup failure, disabling automatic Restart=on-failure loops.
// A later explicit service start retries only the durable selected executable.
var ErrLauncherStopped = errors.New("launcher stopped after bounded startup failure")

// launcherState is separate from the schema-1 watchdog protocol. The old
// watchdog never reads it and it is created only after legacy settlement.
type launcherState struct {
	SchemaVersion             int      `json:"schema_version"`
	Launcher                  Version  `json:"launcher"`
	Proven                    bool     `json:"proven"`
	Bootstrap                 bool     `json:"bootstrap,omitempty"`
	Selected                  Version  `json:"selected"`
	Previous                  *Version `json:"previous,omitempty"`
	Pending                   bool     `json:"pending"`
	Attempted                 bool     `json:"attempted"`
	Rejected                  string   `json:"rejected,omitempty"`
	FallbackProjectionPending bool     `json:"fallback_projection_pending"`
	LauncherPID               int      `json:"launcher_pid"`
	ChildPID                  int      `json:"child_pid"`
	Acknowledged              bool     `json:"acknowledged"`
	BootReady                 bool     `json:"boot_ready"`
	Failed                    bool     `json:"failed"`
}

func (m *Manager) launcherPath() string { return filepath.Join(m.Root, "launcher-state.json") }
func (m *Manager) readLauncher() (launcherState, error) {
	var s launcherState
	info, err := os.Lstat(m.launcherPath())
	if err != nil {
		return s, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return s, errors.New("launcher state is not private regular file")
	}
	if err := validateRecoveryOwner(m.launcherPath(), info); err != nil {
		return s, err
	}
	if err := atomicfile.ReadJSON(m.launcherPath(), &s); err != nil {
		return s, err
	}
	if s.SchemaVersion != 1 {
		return s, errors.New("unsupported launcher state")
	}
	return s, nil
}
func (m *Manager) mutateLauncher(f func(*launcherState) error) error {
	return m.mutateLauncherContext(context.Background(), f)
}

func (m *Manager) mutateLauncherContext(ctx context.Context, f func(*launcherState) error) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	releaseLock, err := waitRecoveryLock(ctx, m.Root)
	if err != nil {
		return err
	}
	defer releaseLock()
	return withOrdinaryActivationMutationLock(m.launcherPath(), func() error {
		s, err := m.readLauncher()
		if err != nil {
			return err
		}
		if err := f(&s); err != nil {
			return err
		}
		return atomicfile.WriteJSON(m.launcherPath(), s, 0o600)
	})
}

func (m *Manager) acquireLauncherMutation() (func(), error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return waitRecoveryLock(ctx, m.Root)
}
func (m *Manager) verifyLauncherVersion(v Version, launcher bool) error {
	if !validSHA256(v.SHA256) || v.Version == "" || !filepath.IsAbs(v.Path) || filepath.Clean(v.Path) != v.Path {
		return errors.New("invalid launcher executable identity")
	}
	expected := filepath.Join(m.Root, "versions") + string(os.PathSeparator)
	if launcher {
		if v.Path != filepath.Join(m.Root, "launcher") {
			return errors.New("unauthorized launcher path")
		}
	} else if !strings.HasPrefix(v.Path, expected) {
		return errors.New("unauthorized Manager selection")
	}
	resolved, err := filepath.EvalSymlinks(v.Path)
	if err != nil || resolved != v.Path {
		return errors.New("launcher executable path contains symlink")
	}
	info, err := os.Lstat(v.Path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o022 != 0 || info.Mode().Perm()&0o100 == 0 {
		return errors.New("unsafe launcher executable permissions")
	}
	if err := validateRecoveryOwner(v.Path, info); err != nil {
		return err
	}
	if !launcher {
		return m.validateStartupVersionArtifact(v, "supervised")
	}
	if !binaryMatches(v.Path, v.SHA256) {
		return errors.New("launcher executable checksum mismatch")
	}
	return nil
}

// LauncherEnabled means the independent handoff has been proven, not staged.
func (m *Manager) LauncherEnabled() (bool, error) {
	s, err := m.readLauncher()
	if os.IsNotExist(err) {
		return false, nil
	}
	return s.Proven, err
}
func (m *Manager) SupervisedStartup() (bool, error) {
	if os.Getenv("AGENT_PLATFORM_LAUNCHER_PID") == "" {
		return false, nil
	}
	s, err := m.readLauncher()
	if err != nil {
		return false, err
	}
	if strconv.Itoa(s.LauncherPID) != os.Getenv("AGENT_PLATFORM_LAUNCHER_PID") || s.LauncherPID != os.Getppid() || !binaryMatches(fmt.Sprintf("/proc/%d/exe", s.LauncherPID), s.Launcher.SHA256) || !binaryMatches("/proc/self/exe", s.Selected.SHA256) {
		return false, errors.New("supervised Manager process binding mismatch")
	}
	return true, nil
}

// SupervisedCandidateStartup distinguishes an unproven activation from the
// per-boot handshake of a committed or restored Manager.
func (m *Manager) SupervisedCandidateStartup() (bool, error) {
	supervised, err := m.SupervisedStartup()
	if err != nil || !supervised {
		return false, err
	}
	s, err := m.readLauncher()
	return s.Pending, err
}

func (m *Manager) acknowledgeLauncher() error {
	timeout := m.launcherDeadline()
	if timeout > time.Minute {
		timeout = time.Minute
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		// Atomic replacement makes an unlocked observation safe. Do not hash
		// executables while holding the lock needed by the parent to register us.
		s, err := m.readLauncher()
		if err != nil {
			return err
		}
		if s.LauncherPID != os.Getppid() || strconv.Itoa(s.LauncherPID) != os.Getenv("AGENT_PLATFORM_LAUNCHER_PID") ||
			s.Selected.Version != m.RunningVersion {
			return errors.New("launcher acknowledgement identity mismatch")
		}
		if s.ChildPID != 0 {
			if s.ChildPID != os.Getpid() {
				return errors.New("launcher acknowledgement process mismatch")
			}
			if !binaryMatches(fmt.Sprintf("/proc/%d/exe", s.LauncherPID), s.Launcher.SHA256) ||
				!binaryMatches("/proc/self/exe", s.Selected.SHA256) {
				return errors.New("launcher acknowledgement identity mismatch")
			}
			return m.mutateLauncherContext(ctx, func(latest *launcherState) error {
				// Authenticate the snapshot outside the lock, then atomically
				// acknowledge only the same exact processes and executable identities.
				if latest.LauncherPID != s.LauncherPID || latest.ChildPID != s.ChildPID ||
					latest.Launcher != s.Launcher || latest.Selected != s.Selected {
					return errors.New("launcher acknowledgement identity changed")
				}
				latest.Acknowledged = true
				return nil
			})
		}
		if m.launcherRegistrationPending != nil {
			m.launcherRegistrationPending()
		}
		// Start the delay after observing/calling the hook, rather than consuming
		// a buffered ticker tick and immediately competing with parent registration.
		timer := time.NewTimer(10 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}
func (m *Manager) awaitLauncher(ctx context.Context) error {
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		s, err := m.readLauncher()
		if err != nil {
			return err
		}
		if s.ChildPID != os.Getpid() {
			return errors.New("launcher selected another child")
		}
		if s.BootReady {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
func (m *Manager) activateLauncher(manifest release.Manifest) error {
	return m.mutateLauncher(func(s *launcherState) error {
		if !s.Proven || s.Failed {
			return errors.New("launcher handoff is not proven")
		}
		if s.Selected.SourceCommit == manifest.SourceCommit {
			return nil
		}
		if s.Pending || s.Rejected == manifest.SourceCommit {
			return errors.New("launcher candidate already pending or rejected")
		}
		state, err := m.load()
		if err != nil {
			return err
		}
		if state.Candidate == nil || !state.Candidate.PlatformCommitted || state.Candidate.SourceCommit != manifest.SourceCommit {
			return errors.New("launcher candidate is not prepared")
		}
		if err := m.verifyLauncherVersion(*state.Candidate, false); err != nil {
			return err
		}
		if err := m.verifyLauncherVersion(s.Selected, false); err != nil {
			return err
		}
		previous := s.Selected
		s.Previous = &previous
		s.Selected = *state.Candidate
		s.Pending = true
		s.Attempted = false
		s.BootReady = false
		s.Acknowledged = false
		return nil
	})
}

// selectLauncherFallback is a one-way transition. A rejected startup never
// becomes eligible again, including after the service itself restarts.
func (m *Manager) selectLauncherFallback(s *launcherState) error {
	if !s.Pending || s.Previous == nil {
		return errors.New("no uncommitted launcher fallback")
	}
	if err := m.verifyLauncherVersion(*s.Previous, false); err != nil {
		return err
	}
	s.Rejected = s.Selected.SourceCommit
	s.Selected = *s.Previous
	s.Pending = false
	s.BootReady = false
	s.Acknowledged = false
	s.FallbackProjectionPending = true
	// Persist the one-shot decision before projecting stable/schema-1 state.
	// A restart can finish projection, but must never execute the rejected child.
	if err := atomicfile.WriteJSON(m.launcherPath(), s, 0o600); err != nil {
		return err
	}
	return m.projectLauncherFallback(s)
}

func (m *Manager) projectLauncherFallback(s *launcherState) error {
	if !s.FallbackProjectionPending {
		return nil
	}
	if s.Pending || s.Rejected == "" {
		return errors.New("invalid launcher fallback projection ownership")
	}
	state, err := m.load()
	if err != nil {
		return err
	}
	if state.Candidate != nil && state.Candidate.SourceCommit != s.Rejected {
		return errors.New("launcher fallback cannot clear another prepared candidate")
	}
	if state.Current == nil || (state.Current.SourceCommit != s.Selected.SourceCommit && state.Current.SourceCommit != s.Rejected) {
		return errors.New("launcher fallback no longer owns Current projection")
	}
	if err := m.projectLauncher(*s); err != nil {
		return err
	}
	s.FallbackProjectionPending = false
	return nil
}

func (m *Manager) verifyLauncherSelection() error {
	release, err := m.acquireLauncherMutation()
	if err != nil {
		return err
	}
	defer release()
	s, err := m.readLauncher()
	if err != nil {
		return err
	}
	return m.verifyLauncherVersion(s.Selected, false)
}
func (m *Manager) projectLauncher(s launcherState) error {
	state, err := m.load()
	if err != nil {
		return err
	}
	if state.Current != nil && *state.Current == s.Selected && state.Candidate == nil && state.Activation == nil && binaryMatches(m.InstallPath, s.Selected.SHA256) {
		return nil
	}
	state.Current = &s.Selected
	state.Previous = s.Previous
	state.Candidate = nil
	state.Activation = nil
	state.UpdatedAt = m.now()
	data, err := os.ReadFile(s.Selected.Path)
	if err != nil {
		return err
	}
	if sha256Hex(data) != s.Selected.SHA256 {
		return errors.New("selected Manager changed before stable projection")
	}
	if err := atomicfile.WriteFile(m.InstallPath, data, 0o755); err != nil {
		return err
	}
	return atomicfile.WriteJSON(m.StatePath, state, 0o600)
}

func (m *Manager) launcherDeadline() time.Duration {
	if m.LauncherHealthTimeout > 0 && m.LauncherHealthTimeout <= 10*time.Minute {
		return m.LauncherHealthTimeout
	}
	return 60 * time.Second
}

var errLauncherSelectionChanged = errors.New("launcher selection changed during startup")

func (m *Manager) launcherReplacement(selected Version) (bool, error) {
	s, err := m.readLauncher()
	return err == nil && s.Pending && !s.Attempted && (s.Selected.SHA256 != selected.SHA256 || s.Selected.SourceCommit != selected.SourceCommit), err
}

func (m *Manager) waitLauncherReady(ctx context.Context, childDone <-chan error, selected Version, coreReady func(context.Context) error) error {
	ctx, cancel := context.WithTimeout(ctx, m.launcherDeadline())
	defer cancel()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-childDone:
			return fmt.Errorf("Manager exited before startup: %v", err)
		case <-ticker.C:
		}
		s, err := m.readLauncher()
		if err != nil {
			return err
		}
		if s.Pending && !s.Attempted && (s.Selected.SHA256 != selected.SHA256 || s.Selected.SourceCommit != selected.SourceCommit) {
			return errLauncherSelectionChanged
		}
		if s.Acknowledged && managerHealthy(ctx, m.SocketPath, m.ControlTokenFile, selected.Version, selected.SHA256) {
			if coreReady != nil {
				if err := coreReady(ctx); err != nil {
					continue
				}
			}
			return nil
		}
	}
}

// RunLauncher executes verified immutable version paths, never the replaceable
// stable path. A late committed crash exits for systemd restart without rollback.
func (m *Manager) RunLauncher(ctx context.Context, coreReady func(context.Context) error) error {
	lease, err := m.acquireLauncherProcess()
	if err != nil {
		return err
	}
	defer lease.Release()
	s, err := m.readLauncher()
	if err != nil {
		return err
	}
	if err := m.verifyLauncherVersion(s.Launcher, true); err != nil {
		return err
	}
	if !binaryMatches("/proc/self/exe", s.Launcher.SHA256) {
		return errors.New("launcher is not executing its immutable identity")
	}
	if s.Failed {
		if err = m.mutateLauncher(func(latest *launcherState) error { latest.Failed = false; return nil }); err != nil {
			return err
		}
	}
	for {
		s, err = m.readLauncher()
		if err != nil {
			return err
		}
		if s.Pending && s.Attempted {
			if err = m.mutateLauncher(m.selectLauncherFallback); err != nil {
				return m.stopLauncher(err)
			}
			continue
		}
		if s.FallbackProjectionPending {
			if err = m.mutateLauncher(m.projectLauncherFallback); err != nil {
				return m.stopLauncher(err)
			}
		}
		if err = m.verifyLauncherSelection(); err != nil {
			if !s.Pending {
				return m.stopLauncher(err)
			}
			if err = m.mutateLauncher(m.selectLauncherFallback); err != nil {
				return m.stopLauncher(err)
			}
			continue
		}
		child := exec.Command(s.Selected.Path, "serve", "--config", m.ConfigPath)
		child.Env = append(os.Environ(), "AGENT_PLATFORM_LAUNCHER_PID="+strconv.Itoa(os.Getpid()))
		child.Stdout = os.Stdout
		child.Stderr = os.Stderr
		if err = m.mutateLauncher(func(latest *launcherState) error {
			latest.LauncherPID = os.Getpid()
			latest.ChildPID = 0
			latest.BootReady = false
			latest.Acknowledged = false
			if latest.Pending {
				latest.Attempted = true
			}
			return nil
		}); err != nil {
			return err
		}
		if err = child.Start(); err != nil {
			if s.Pending {
				if err = m.mutateLauncher(m.selectLauncherFallback); err != nil {
					return m.stopLauncher(err)
				}
				continue
			}
			return m.stopLauncher(err)
		}
		done := make(chan error, 1)
		go func() { defer close(done); done <- child.Wait() }()
		stop := func() {
			_ = child.Process.Kill()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
			}
		}
		if err = m.mutateLauncher(func(latest *launcherState) error { latest.ChildPID = child.Process.Pid; return nil }); err != nil {
			stop()
			return err
		}
		err = m.waitLauncherReady(ctx, done, s.Selected, coreReady)
		if err != nil {
			stop()
			if ctx.Err() != nil {
				return ctx.Err()
			}
			queued, readErr := m.launcherReplacement(s.Selected)
			if readErr != nil {
				return readErr
			}
			if queued {
				continue
			}
			if s.Pending {
				if err = m.mutateLauncher(m.selectLauncherFallback); err != nil {
					return m.stopLauncher(err)
				}
				continue
			}
			return m.stopLauncher(err)
		}
		if err = m.mutateLauncher(func(latest *launcherState) error {
			if latest.Selected.SHA256 != s.Selected.SHA256 {
				return errors.New("launcher selection changed during startup")
			}
			if latest.Pending {
				if err := m.projectLauncher(*latest); err != nil {
					return err
				}
				latest.Pending = false
			}
			latest.BootReady = true
			if latest.Bootstrap {
				latest.Proven = true
			}
			return nil
		}); err != nil {
			stop()
			queued, readErr := m.launcherReplacement(s.Selected)
			if readErr != nil {
				return readErr
			}
			if queued {
				continue
			}
			return err
		}
		ticker := time.NewTicker(100 * time.Millisecond)
		switching := false
		for !switching {
			select {
			case <-ctx.Done():
				ticker.Stop()
				stop()
				return ctx.Err()
			case err := <-done:
				ticker.Stop()
				queued, readErr := m.launcherReplacement(s.Selected)
				if readErr != nil {
					return readErr
				}
				if queued {
					switching = true
					continue
				}
				if err == nil {
					return errors.New("committed Manager exited")
				}
				return err
			case <-ticker.C:
				latest, readErr := m.readLauncher()
				if readErr != nil {
					ticker.Stop()
					stop()
					return readErr
				}
				switching = latest.Pending && latest.Selected.SHA256 != s.Selected.SHA256
			}
		}
		ticker.Stop()
		stop()
	}
}

func (m *Manager) stopLauncher(cause error) error {
	err := m.mutateLauncher(func(s *launcherState) error { s.Failed = true; s.BootReady = false; return nil })
	return errors.Join(ErrLauncherStopped, cause, err)
}

func (m *Manager) acquireLauncherProcess() (*ServeLease, error) {
	if err := validateRecoveryDirectory(m.Root, true); err != nil {
		return nil, err
	}
	path := filepath.Join(m.Root, "launcher.lock")
	fd, err := syscall.Open(path, syscall.O_CREAT|syscall.O_RDWR|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	lease := &ServeLease{file: file}
	info, err := file.Stat()
	if err != nil {
		lease.Release()
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		lease.Release()
		return nil, errors.New("unsafe launcher process lock")
	}
	if err := validateRecoveryOwner(path, info); err != nil {
		lease.Release()
		return nil, err
	}
	if err := syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		lease.Release()
		return nil, fmt.Errorf("launcher already running: %w", err)
	}
	return lease, nil
}
