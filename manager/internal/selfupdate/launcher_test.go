package selfupdate

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

func launcherFixture(t *testing.T) (*Manager, launcherState) {
	t.Helper()
	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	m := &Manager{Profile: testActiveProfile, Root: filepath.Join(root, "manager-binaries"), StatePath: filepath.Join(root, "manager-binaries.json"), InstallPath: filepath.Join(root, "stable"), LauncherHealthTimeout: 100 * time.Millisecond}
	version := func(name string, content []byte) Version {
		path := filepath.Join(m.Root, "versions", strings.Repeat(name, 40)+"-"+strings.Repeat(name, 12), m.managerBinaryName())
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, content, 0o700); err != nil {
			t.Fatal(err)
		}
		v := Version{Version: strings.Repeat(name, 40), SourceCommit: strings.Repeat(name, 40), Path: path, SHA256: sha256Hex(content), VerifiedAt: time.Now().UTC(), PlatformCommitted: true}
		if err := m.ensureVersionMetadata(v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	previous := version("a", []byte("#!/bin/sh\nexit 7\n"))
	candidate := version("b", []byte("#!/bin/sh\nexit 8\n"))
	launcherBytes, err := os.ReadFile("/proc/self/exe")
	if err != nil {
		t.Fatal(err)
	}
	launcher := Version{Version: previous.Version, Path: filepath.Join(m.Root, "launcher"), SHA256: sha256Hex(launcherBytes)}
	if err := os.WriteFile(launcher.Path, launcherBytes, 0o700); err != nil {
		t.Fatal(err)
	}
	s := launcherState{SchemaVersion: 1, Launcher: launcher, Proven: true, Selected: candidate, Previous: &previous, Pending: true}
	if err := atomicfile.WriteJSON(m.launcherPath(), s, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := atomicfile.WriteJSON(filepath.Join(m.Root, "bridge-handoff.json"), map[string]any{"status": "proven", "launcher": launcher}, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := atomicfile.WriteJSON(m.StatePath, State{SchemaVersion: 1, Current: &previous, Candidate: &candidate}, 0o600); err != nil {
		t.Fatal(err)
	}
	return m, s
}

func TestLauncherFallbackSelectsVerifiedPreviousOnce(t *testing.T) {
	m, initial := launcherFixture(t)
	if err := m.mutateLauncher(m.selectLauncherFallback); err != nil {
		t.Fatal(err)
	}
	s, err := m.readLauncher()
	if err != nil {
		t.Fatal(err)
	}
	if s.Selected != *initial.Previous || s.Pending || s.Rejected != initial.Selected.SourceCommit {
		t.Fatalf("incorrect fallback: %+v", s)
	}
	if !binaryMatches(m.InstallPath, initial.Previous.SHA256) {
		t.Fatal("stable bytes did not restore verified previous")
	}
	state, err := m.load()
	if err != nil {
		t.Fatal(err)
	}
	if state.Current.SHA256 != initial.Previous.SHA256 || state.Candidate != nil {
		t.Fatalf("fallback projection: %+v", state)
	}
	if err := m.mutateLauncher(m.selectLauncherFallback); err == nil {
		t.Fatal("fallback was allowed twice")
	}
}

func TestLauncherFallbackRejectsUnverifiedOrCommittedSelection(t *testing.T) {
	for _, scenario := range []string{"tampered", "missing", "committed"} {
		t.Run(scenario, func(t *testing.T) {
			m, s := launcherFixture(t)
			switch scenario {
			case "tampered":
				if err := os.WriteFile(s.Previous.Path, []byte("changed"), 0o700); err != nil {
					t.Fatal(err)
				}
			case "missing":
				s.Previous = nil
			case "committed":
				s.Pending = false
			}
			selected := s.Selected
			if err := m.selectLauncherFallback(&s); err == nil {
				t.Fatal("unsafe fallback accepted")
			}
			if s.Selected != selected {
				t.Fatal("rejected fallback changed selection")
			}
		})
	}
}

func TestLauncherHealthDeadlineBoundsMissingAcknowledgement(t *testing.T) {
	m, s := launcherFixture(t)
	start := time.Now()
	err := m.waitLauncherReady(context.Background(), make(chan error), s.Selected, nil)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("deadline error: %v", err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("startup deadline was not bounded")
	}
}

// This exercises the actual supervisor and actual failed child processes, not
// mocked process forwarding. Restart must retain the one-shot failure decision.
func TestLauncherStopsAfterCandidateAndPreviousExit(t *testing.T) {
	m, initial := launcherFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := m.RunLauncher(ctx, nil); !errors.Is(err, ErrLauncherStopped) {
		t.Fatalf("expected clean service-stop signal, got %v", err)
	}
	s, err := m.readLauncher()
	if err != nil {
		t.Fatal(err)
	}
	if !s.Failed || s.Pending || s.Selected.SHA256 != initial.Previous.SHA256 || s.Rejected != initial.Selected.SourceCommit {
		t.Fatalf("unbounded failure state: %+v", s)
	}
	if err := m.RunLauncher(ctx, nil); !errors.Is(err, ErrLauncherStopped) {
		t.Fatalf("explicit retry must still stop finitely: %v", err)
	}
	after, err := m.readLauncher()
	if err != nil {
		t.Fatal(err)
	}
	if after.Selected != s.Selected || after.Rejected != s.Rejected || after.Pending {
		t.Fatal("explicit start retried rejected candidate")
	}
}

func TestLauncherRequiresExactIdentityAndCoreReadiness(t *testing.T) {
	for _, scenario := range []string{"healthy", "wrong_sha", "unhealthy_core"} {
		t.Run(scenario, func(t *testing.T) {
			m, s := launcherFixture(t)
			socketRoot, err := os.MkdirTemp("", "launcher-probe-")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.RemoveAll(socketRoot) })
			m.SocketPath = filepath.Join(socketRoot, "control.sock")
			m.ControlTokenFile = filepath.Join(socketRoot, "token")
			token := strings.Repeat("a", 64)
			if err := os.WriteFile(m.ControlTokenFile, []byte(token), 0o600); err != nil {
				t.Fatal(err)
			}
			listener, err := net.Listen("unix", m.SocketPath)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(m.SocketPath, 0o600); err != nil {
				t.Fatal(err)
			}
			digest := s.Selected.SHA256
			if scenario == "wrong_sha" {
				digest = strings.Repeat("f", 64)
			}
			server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/v1/identity" || r.Header.Get("Authorization") != "Bearer "+token {
					http.Error(w, "unauthorized", http.StatusUnauthorized)
					return
				}
				_ = json.NewEncoder(w).Encode(map[string]string{"status": "healthy", "version": s.Selected.Version, "sha256": digest})
			})}
			go func() { _ = server.Serve(listener) }()
			t.Cleanup(func() { _ = server.Close() })
			if err := m.mutateLauncher(func(s *launcherState) error { s.Acknowledged = true; return nil }); err != nil {
				t.Fatal(err)
			}
			coreCalls := 0
			err = m.waitLauncherReady(context.Background(), make(chan error), s.Selected, func(context.Context) error {
				coreCalls++
				if scenario == "unhealthy_core" {
					return errors.New("core is not ready")
				}
				return nil
			})
			if scenario == "healthy" {
				if err != nil || coreCalls == 0 {
					t.Fatalf("healthy startup rejected: %v", err)
				}
			} else if !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("unsafe startup accepted: %v", err)
			}
			if scenario == "wrong_sha" && coreCalls != 0 {
				t.Fatal("core check ran before identity authentication")
			}
			if scenario == "unhealthy_core" && coreCalls == 0 {
				t.Fatal("core failure was not exercised")
			}
		})
	}
}

func TestLauncherInterruptedCandidateDoesNotRestartIt(t *testing.T) {
	m, s := launcherFixture(t)
	marker := filepath.Join(t.TempDir(), "candidate-replayed")
	data := []byte("#!/bin/sh\nprintf replay > '" + marker + "'\nexit 8\n")
	s.Selected.SHA256 = sha256Hex(data)
	if err := os.WriteFile(s.Selected.Path, data, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := atomicfile.WriteJSON(filepath.Join(filepath.Dir(s.Selected.Path), "metadata.json"), s.Selected, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := m.mutateLauncher(func(latest *launcherState) error { latest.Selected = s.Selected; latest.Attempted = true; return nil }); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := m.RunLauncher(ctx, nil); !errors.Is(err, ErrLauncherStopped) {
		t.Fatalf("interrupted candidate did not fall back: %v", err)
	}
	after, err := m.readLauncher()
	if err != nil {
		t.Fatal(err)
	}
	if after.Selected.SHA256 != s.Previous.SHA256 || after.Rejected != s.Selected.SourceCommit {
		t.Fatal("interrupted candidate was not durably rejected")
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("candidate was replayed: %v", err)
	}
}

func TestLauncherActivationProofSurvivesCommittedBootHandshake(t *testing.T) {
	m, s := launcherFixture(t)
	manifest := release.Manifest{SourceCommit: s.Selected.SourceCommit, Manager: release.ManagerRelease{Version: s.Selected.Version, Artifacts: map[string]release.Artifact{runtime.GOARCH: {SHA256: s.Selected.SHA256}}}}
	if err := m.mutateLauncher(func(s *launcherState) error { s.BootReady = true; return nil }); err != nil {
		t.Fatal(err)
	}
	if committed, err := m.ActivationCommitted(manifest); err != nil || committed {
		t.Fatalf("unpromoted candidate passed barrier: %v %v", committed, err)
	}
	if err := m.mutateLauncher(func(s *launcherState) error { s.Pending = false; s.BootReady = false; return nil }); err != nil {
		t.Fatal(err)
	}
	if committed, err := m.ActivationCommitted(manifest); err != nil || !committed {
		t.Fatalf("durable promotion lost during committed boot handshake: %v %v", committed, err)
	}
}

func TestLauncherRejectedHistoryDoesNotEraseLaterPreparedCandidate(t *testing.T) {
	m, initial := launcherFixture(t)
	if err := m.mutateLauncher(m.selectLauncherFallback); err != nil {
		t.Fatal(err)
	}
	next := initial.Selected
	next.SourceCommit = strings.Repeat("c", 40)
	next.Version = next.SourceCommit
	next.Path = filepath.Join(m.Root, "versions", next.Version+"-"+next.SourceCommit[:12], m.managerBinaryName())
	data, err := os.ReadFile(initial.Selected.Path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(next.Path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(next.Path, data, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := m.ensureVersionMetadata(next); err != nil {
		t.Fatal(err)
	}
	state, err := m.load()
	if err != nil {
		t.Fatal(err)
	}
	state.Candidate = &next
	if err := atomicfile.WriteJSON(m.StatePath, state, 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := m.RunLauncher(ctx, nil); !errors.Is(err, ErrLauncherStopped) {
		t.Fatalf("selected fixture did not execute: %v", err)
	}
	after, err := m.load()
	if err != nil {
		t.Fatal(err)
	}
	if after.Candidate == nil || *after.Candidate != next {
		t.Fatal("restart erased unrelated prepared candidate after historical rejection")
	}
	// Even an interrupted projection must refuse a different transaction.
	if err := m.mutateLauncher(func(s *launcherState) error { s.FallbackProjectionPending = true; return m.projectLauncherFallback(s) }); err == nil {
		t.Fatal("interrupted fallback claimed an unrelated candidate")
	}
	after, err = m.load()
	if err != nil {
		t.Fatal(err)
	}
	if after.Candidate == nil || *after.Candidate != next {
		t.Fatal("refused projection changed candidate")
	}
}

func TestLauncherStartsRecoveryQueuedCandidateBeforeOldStartupAcknowledgement(t *testing.T) {
	for _, oldExits := range []bool{false, true} {
		t.Run(map[bool]string{false: "old_waits", true: "old_exits"}[oldExits], func(t *testing.T) {
			m, initial := launcherFixture(t)
			m.LauncherHealthTimeout = 2 * time.Second
			marker := filepath.Join(t.TempDir(), "candidate-started")
			oldRelease := filepath.Join(t.TempDir(), "old-release")
			current := *initial.Previous
			candidate := initial.Selected
			rewrite := func(v *Version, data []byte) {
				t.Helper()
				v.SHA256 = sha256Hex(data)
				if err := os.WriteFile(v.Path, data, 0o700); err != nil {
					t.Fatal(err)
				}
				if err := atomicfile.WriteJSON(filepath.Join(filepath.Dir(v.Path), "metadata.json"), v, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			rewrite(&current, []byte("#!/bin/sh\nwhile [ ! -e '"+oldRelease+"' ]; do sleep 0.01; done\nexit 9\n"))
			rewrite(&candidate, []byte("#!/bin/sh\nprintf started > '"+marker+"'\nexec sleep 20\n"))
			if err := atomicfile.WriteJSON(m.StatePath, State{SchemaVersion: 1, Current: &current, Candidate: &candidate}, 0o600); err != nil {
				t.Fatal(err)
			}
			if err := m.mutateLauncher(func(s *launcherState) error {
				s.Selected = current
				s.Previous = &current
				s.Pending = false
				s.Attempted = false
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			done := make(chan error, 1)
			go func() { done <- m.RunLauncher(ctx, nil) }()
			defer func() {
				cancel()
				select {
				case <-done:
				case <-time.After(time.Second):
					t.Error("launcher did not reap its child")
				}
			}()
			until := func(label string, ready func() bool) {
				t.Helper()
				deadline := time.Now().Add(time.Second)
				for time.Now().Before(deadline) {
					if ready() {
						return
					}
					time.Sleep(5 * time.Millisecond)
				}
				t.Fatalf("timed out waiting for %s", label)
			}
			until("committed child startup", func() bool { s, err := m.readLauncher(); return err == nil && s.ChildPID > 1 && !s.BootReady })
			manifest := release.Manifest{SourceCommit: candidate.SourceCommit, Manager: release.ManagerRelease{Version: candidate.Version, Artifacts: map[string]release.Artifact{runtime.GOARCH: {SHA256: candidate.SHA256}}}}
			// This is the real finalize-recovery activation call made while the
			// committed child is still behind its per-boot acknowledgement fence.
			if err := m.Activate(ctx, manifest); err != nil {
				t.Fatal(err)
			}
			if oldExits {
				if err := os.WriteFile(oldRelease, nil, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			until("queued candidate execution", func() bool { _, err := os.Stat(marker); return err == nil })
			after, err := m.readLauncher()
			if err != nil {
				t.Fatal(err)
			}
			if after.Selected.SHA256 != candidate.SHA256 || !after.Pending || !after.Attempted || after.Failed || after.Rejected != "" {
				t.Fatalf("queued activation was lost during old startup: %+v", after)
			}
			if committed, err := m.ActivationCommitted(manifest); err != nil || committed {
				t.Fatalf("gate barrier opened before new candidate proof: %v %v", committed, err)
			}
		})
	}
}

func launcherAcknowledgementFixture(t *testing.T) *Manager {
	t.Helper()
	m, s := launcherFixture(t)
	parentSHA, err := fileSHA256(filepath.Join("/proc", strconv.Itoa(os.Getppid()), "exe"))
	if err != nil {
		t.Fatal(err)
	}
	ownSHA, err := fileSHA256("/proc/self/exe")
	if err != nil {
		t.Fatal(err)
	}
	m.RunningVersion = s.Selected.Version
	t.Setenv("AGENT_PLATFORM_LAUNCHER_PID", strconv.Itoa(os.Getppid()))
	if err := m.mutateLauncher(func(s *launcherState) error {
		s.LauncherPID = os.Getppid()
		s.Launcher.SHA256 = parentSHA
		s.Selected.SHA256 = ownSHA
		s.ChildPID = 0
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestLauncherAcknowledgementWaitsForExactPIDRegistration(t *testing.T) {
	m := launcherAcknowledgementFixture(t)
	m.LauncherHealthTimeout = time.Minute
	pending := make(chan struct{}, 1)
	m.launcherRegistrationPending = func() {
		select {
		case pending <- struct{}{}:
		default:
		}
	}
	result := make(chan error, 1)
	go func() { result <- m.AcknowledgeStartup() }()
	select {
	case err := <-result:
		t.Fatalf("acknowledgement completed before PID registration: %v", err)
	case <-pending:
	case <-time.After(65 * time.Second):
		t.Fatal("acknowledgement did not observe the unregistered PID")
	}
	before, err := m.readLauncher()
	if err != nil {
		t.Fatal(err)
	}
	if before.Acknowledged {
		t.Fatal("unregistered child was acknowledged")
	}
	if err := m.mutateLauncher(func(s *launcherState) error { s.ChildPID = os.Getpid(); return nil }); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("exact delayed registration was rejected: %v", err)
		}
	case <-time.After(65 * time.Second):
		t.Fatal("acknowledgement did not observe registered PID")
	}
	after, err := m.readLauncher()
	if err != nil {
		t.Fatal(err)
	}
	if !after.Acknowledged || after.ChildPID != os.Getpid() {
		t.Fatal("exact child acknowledgement was not persisted")
	}
}

func TestLauncherAcknowledgementRejectsWrongRegistrationAndIdentity(t *testing.T) {
	for _, scenario := range []string{"wrong_pid", "wrong_parent_sha", "wrong_version", "missing_pid"} {
		t.Run(scenario, func(t *testing.T) {
			m := launcherAcknowledgementFixture(t)
			if err := m.mutateLauncher(func(s *launcherState) error {
				switch scenario {
				case "wrong_pid":
					s.ChildPID = os.Getpid() + 1
				case "wrong_parent_sha":
					s.Launcher.SHA256 = strings.Repeat("f", 64)
				case "wrong_version":
					s.Selected.Version = strings.Repeat("f", 40)
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			start := time.Now()
			err := m.AcknowledgeStartup()
			if err == nil {
				t.Fatal("invalid child registration was acknowledged")
			}
			if scenario == "missing_pid" && !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("missing PID did not reach bounded deadline: %v", err)
			}
			if time.Since(start) > 10*time.Second {
				t.Fatal("registration wait exceeded bound")
			}
			after, err := m.readLauncher()
			if err != nil {
				t.Fatal(err)
			}
			if after.Acknowledged {
				t.Fatal("rejected registration changed acknowledgement")
			}
		})
	}
}

func TestLauncherParentRegistrationWaitsForRecoveryLock(t *testing.T) {
	m := launcherAcknowledgementFixture(t)
	m.LauncherHealthTimeout = time.Minute
	release, err := acquireRecoveryLock(m.Root)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if release != nil {
			release()
		}
	}()
	result := make(chan error, 1)
	go func() {
		result <- m.mutateLauncher(func(s *launcherState) error {
			s.ChildPID = os.Getpid()
			return nil
		})
	}()
	select {
	case err := <-result:
		t.Fatalf("registration did not wait for held recovery lock: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	before, err := m.readLauncher()
	if err != nil {
		t.Fatal(err)
	}
	if before.ChildPID != 0 || before.Acknowledged {
		t.Fatalf("held lock allowed premature registration: %+v", before)
	}
	release()
	release = nil
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("registration failed after lock release: %v", err)
		}
	case <-time.After(6 * time.Second):
		t.Fatal("registration remained blocked after lock release")
	}
	if err := m.AcknowledgeStartup(); err != nil {
		t.Fatal(err)
	}
	after, err := m.readLauncher()
	if err != nil {
		t.Fatal(err)
	}
	if after.ChildPID != os.Getpid() || !after.Acknowledged {
		t.Fatalf("registered child was not acknowledged: %+v", after)
	}
}

func TestLauncherLockWaitIsBoundedWithoutChangingRecoveryAdmission(t *testing.T) {
	m, _ := launcherFixture(t)
	release, err := acquireRecoveryLock(m.Root)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	called := false
	err = m.mutateLauncherContext(ctx, func(s *launcherState) error {
		called = true
		s.ChildPID = os.Getpid()
		return nil
	})
	if !errors.Is(err, context.DeadlineExceeded) || called {
		t.Fatalf("held lock did not bound mutation: called=%v err=%v", called, err)
	}
	// Genuine external ownership claims must still fail immediately, not wait.
	claim := make(chan error, 1)
	go func() {
		unlock, err := acquireRecoveryLock(m.Root)
		if unlock != nil {
			unlock()
		}
		claim <- err
	}()
	select {
	case err := <-claim:
		if !errors.Is(err, syscall.EWOULDBLOCK) {
			t.Fatalf("external ownership admission changed: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("external ownership claim waited for held lock")
	}
}
