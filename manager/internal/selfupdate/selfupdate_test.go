package selfupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/atomicfile"
	"github.com/ubitech/agent-platform/manager/internal/release"
)

type fakeRunner struct {
	calls [][]string
	fail  string
}

func (r *fakeRunner) Run(_ context.Context, name string, args ...string) error {
	r.calls = append(r.calls, append([]string{name}, args...))
	if name == r.fail {
		return errors.New("injected failure")
	}
	return nil
}

func candidateManifest(t *testing.T, binary []byte) (release.Manifest, *httptest.Server) {
	t.Helper()
	sum := sha256.Sum256(binary)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(binary) }))
	manifest := release.Manifest{SourceCommit: strings.Repeat("a", 40), Manager: release.ManagerRelease{Version: "next", Artifacts: map[string]release.Artifact{runtime.GOARCH: {URL: server.URL, SHA256: hex.EncodeToString(sum[:])}}}}
	return manifest, server
}

func newPreparedManager(t *testing.T) (*Manager, release.Manifest, []byte, *fakeRunner) {
	t.Helper()
	oldBinary := []byte("#!/bin/sh\necho current\n")
	newBinary := []byte("#!/bin/sh\necho next\n")
	manifest, server := candidateManifest(t, newBinary)
	t.Cleanup(server.Close)
	root := t.TempDir()
	install := filepath.Join(root, "bin", "ubitech-manager")
	if err := atomicfile.WriteFile(install, oldBinary, 0o755); err != nil {
		t.Fatal(err)
	}
	runner := &fakeRunner{}
	tokenFile := filepath.Join(root, "state", "secrets", "manager-token")
	if err := atomicfile.WriteFile(tokenFile, []byte("0123456789abcdef0123456789abcdef\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	manager := &Manager{Root: filepath.Join(root, "state", "binaries"), StatePath: filepath.Join(root, "state", "manager-binaries.json"), InstallPath: install, SocketPath: filepath.Join(root, "manager.sock"), ControlTokenFile: tokenFile, UnitName: "ubitech-agent-manager.service", RunningVersion: "current", Client: release.Client{HTTP: server.Client()}, Runner: runner, Now: func() time.Time { return time.Unix(10, 0) }, BootID: func() string { return "boot-a" }}
	if err := manager.Prepare(context.Background(), manifest); err != nil {
		t.Fatal(err)
	}
	return manager, manifest, oldBinary, runner
}

func TestProbeTransientUnitUsesWaitedCollectibleOneshot(t *testing.T) {
	runner := &fakeRunner{}
	manager := &Manager{Runner: runner}
	if err := manager.ProbeTransientUnit(context.Background()); err != nil {
		t.Fatal(err)
	}
	want := []string{"systemd-run", "--user", "--quiet", "--wait", "--collect", "--property=Type=oneshot", "/usr/bin/true"}
	if len(runner.calls) != 1 || strings.Join(runner.calls[0], "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("unexpected transient probe: %#v", runner.calls)
	}
}

func TestProbeTransientUnitFailsClosed(t *testing.T) {
	runner := &fakeRunner{fail: "systemd-run"}
	manager := &Manager{Runner: runner}
	if err := manager.ProbeTransientUnit(context.Background()); err == nil || !strings.Contains(err.Error(), "probe user-systemd transient unit") {
		t.Fatalf("expected a fail-closed transient probe, got %v", err)
	}
}

func TestPrepareVerifiesButDoesNotActivateCandidate(t *testing.T) {
	manager, _, oldBinary, _ := newPreparedManager(t)
	state, err := manager.State()
	if err != nil {
		t.Fatal(err)
	}
	if state.Current == nil || state.Current.Version != "current" || state.Candidate == nil || state.Candidate.Version != "next" || state.Candidate.PlatformCommitted || state.Activation != nil {
		t.Fatalf("unsafe state transition: %#v", state)
	}
	installed, _ := os.ReadFile(manager.InstallPath)
	if string(installed) != string(oldBinary) {
		t.Fatal("Prepare changed the stable executable")
	}
}

func TestWatchdogCommitsAcknowledgedHealthyCandidate(t *testing.T) {
	manager, manifest, _, runner := newPreparedManager(t)
	if err := manager.MarkPlatformCommitted(manifest); err != nil {
		t.Fatal(err)
	}
	if err := manager.Activate(context.Background(), manifest); err != nil {
		t.Fatal(err)
	}
	state, _ := manager.State()
	if state.Activation == nil || state.Current.Version != "current" {
		t.Fatalf("candidate was committed before watchdog health: %#v", state)
	}
	if committed, err := manager.ActivationCommitted(manifest); err != nil || committed {
		t.Fatalf("activation intent bypassed watchdog barrier: committed=%v err=%v", committed, err)
	}
	var plan Plan
	if err := atomicfile.ReadJSON(state.Activation.PlanPath, &plan); err != nil {
		t.Fatal(err)
	}
	plan.Acknowledged = true
	plan.HealthTimeoutMS = 3_000
	if err := atomicfile.WriteJSON(plan.PlanPath, plan, 0o600); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", manager.SocketPath)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer 0123456789abcdef0123456789abcdef" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusOK)
	})}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	if err := RunWatchdog(context.Background(), plan.PlanPath, runner); err != nil {
		t.Fatal(err)
	}
	state, _ = manager.State()
	if state.Current == nil || state.Current.Version != "next" || state.Previous == nil || state.Previous.Version != "current" || state.Candidate != nil || state.Activation != nil {
		t.Fatalf("watchdog did not commit candidate: %#v", state)
	}
	if committed, err := manager.ActivationCommitted(manifest); err != nil || !committed {
		t.Fatalf("watchdog commit was not visible to cleanup barrier: committed=%v err=%v", committed, err)
	}
}

func TestWatchdogRestoresPreviousBinaryWhenCandidateDoesNotStart(t *testing.T) {
	manager, manifest, oldBinary, runner := newPreparedManager(t)
	if err := manager.MarkPlatformCommitted(manifest); err != nil {
		t.Fatal(err)
	}
	if err := manager.Activate(context.Background(), manifest); err != nil {
		t.Fatal(err)
	}
	state, _ := manager.State()
	var plan Plan
	if err := atomicfile.ReadJSON(state.Activation.PlanPath, &plan); err != nil {
		t.Fatal(err)
	}
	plan.HealthTimeoutMS = 1
	if err := atomicfile.WriteJSON(plan.PlanPath, plan, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := RunWatchdog(context.Background(), plan.PlanPath, runner); err == nil {
		t.Fatal("expected watchdog rollback result")
	}
	installed, err := os.ReadFile(manager.InstallPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(installed) != string(oldBinary) {
		t.Fatal("watchdog did not atomically restore the previous executable")
	}
	state, _ = manager.State()
	if state.Current == nil || state.Current.Version != "current" || state.Activation != nil {
		t.Fatalf("rollback corrupted self-update state: %#v", state)
	}
	if len(runner.calls) < 3 || runner.calls[len(runner.calls)-1][0] != "systemctl" {
		t.Fatalf("rollback did not restart the restored service: %#v", runner.calls)
	}
}

func TestStartupCompletesIntentAfterCrashBetweenBinaryReplaceAndPlanUpdate(t *testing.T) {
	manager, manifest, _, runner := newPreparedManager(t)
	if err := manager.MarkPlatformCommitted(manifest); err != nil {
		t.Fatal(err)
	}
	if err := manager.Activate(context.Background(), manifest); err != nil {
		t.Fatal(err)
	}
	state, _ := manager.State()
	var plan Plan
	if err := atomicfile.ReadJSON(state.Activation.PlanPath, &plan); err != nil {
		t.Fatal(err)
	}
	// Exact power-loss window: the stable path contains the candidate, while the
	// last durable plan still says replacement has not happened. A reboot also
	// removes the original transient watchdog unit.
	plan.Activated = false
	plan.Acknowledged = false
	plan.Status = "prepared"
	plan.BootID = "boot-before-power-loss"
	if err := atomicfile.WriteJSON(plan.PlanPath, plan, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := manager.acknowledgeExecutable(manager.InstallPath); err != nil {
		t.Fatal(err)
	}
	if err := atomicfile.ReadJSON(plan.PlanPath, &plan); err != nil {
		t.Fatal(err)
	}
	if !plan.Activated || !plan.Acknowledged || plan.Status != "acknowledged" {
		t.Fatalf("candidate did not idempotently finish crash intent: %#v", plan)
	}
	if len(runner.calls) < 3 || runner.calls[len(runner.calls)-1][0] != "systemd-run" {
		t.Fatalf("startup did not re-arm the lost transient watchdog: %#v", runner.calls)
	}
}
