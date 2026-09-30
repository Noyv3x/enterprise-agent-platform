package selfupdate

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/releasetest"
)

const productionIntegrationVersion = "6889bf66dd63754e42de46f7048eed84a3f0768f"

// Unlike the historical bridge checkpoint test, this sends a normal update to
// the production Manager API and waits for the entire transaction to settle.
// Docker, Compose, the launcher and both Manager binaries are real. Alpine core
// services and the authenticated Platform gate isolate the host update protocol;
// this does not test Platform's application migrations or gate implementation.
func TestProductionSystemdBinaryUpgradeIntegration(t *testing.T) {
	bridgeIntegrationBuildAndRun(t, productionIntegrationVersion, productionIntegrationRun)
}

func productionIntegrationRun(t *testing.T, ctx context.Context, binaries string) {
	base, err := os.MkdirTemp("", "production-it-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(base) })
	account, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	profile := identity.TargetProfile()
	stable := filepath.Join(account.HomeDir, ".local", "bin", profile.ManagerBinary)
	unitPath := filepath.Join(account.HomeDir, ".config", "systemd", "user", profile.ManagerUnit)
	for _, path := range []string{stable, unitPath} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("isolated path already exists or cannot be inspected: %s: %v", path, err)
		}
	}
	stateDir := filepath.Join(base, "data", "manager")
	configPath := filepath.Join(base, "manager.toml")
	socketPath := filepath.Join(base, "control", "manager.sock")
	tokenPath := filepath.Join(stateDir, "secrets", "manager-token")
	generation, composePath := bridgeIntegrationCore(t, ctx, base, stateDir, profile.ManagerBinary)
	compose, err := os.ReadFile(composePath)
	if err != nil {
		t.Fatal(err)
	}
	// The production driver invokes `platform migrate` during a normal update.
	// Keep a real one-off container, with an explicit successful fixture command.
	compose = bytes.ReplaceAll(compose, []byte("    command:"), []byte("    entrypoint: [\"/bin/sh\", \"-c\", \"if [ \\\"$$1\\\" = migrate ]; then exit 0; fi; exec \\\"$$@\\\"\", \"fixture\"]\n    command:"))
	bridgeIntegrationWrite(t, composePath, compose, 0o600)
	payload, err := os.ReadFile(filepath.Join(binaries, "next"))
	if err != nil {
		t.Fatal(err)
	}
	var manifestJSON []byte
	releases := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/manifest.json":
			_, _ = w.Write(manifestJSON)
		case "/agent-platform-compose.yaml":
			_, _ = w.Write(compose)
		case "/agent-platform-manager-linux-" + runtime.GOARCH:
			_, _ = w.Write(payload)
		default:
			http.NotFound(w, r)
		}
	}))
	defer releases.Close()
	target := releasetest.NewTarget(bridgeIntegrationNext, releasetest.WithArtifactBaseURL(releases.URL), releasetest.WithManagerBinary(runtime.GOARCH, payload), releasetest.WithCompose(compose))
	// R1 must remain consumable by production: all ten image keys, even though
	// this fixture starts only the two required core services.
	for key := range target.Manifest.Images {
		target.Manifest.Images[key] = generation.Images["platform"]
	}
	if len(target.Manifest.Images) != 10 {
		t.Fatalf("R1 fixture must publish the legacy ten-image catalog: %v", target.Manifest.Images)
	}
	manifestJSON, err = json.Marshal(target.Manifest)
	if err != nil {
		t.Fatal(err)
	}
	generation.SourceCommit = productionIntegrationVersion
	initial := releasetest.NewTarget(productionIntegrationVersion, releasetest.WithCompose(compose))
	initial.Manifest.Images = target.Manifest.Images
	generation.Images = initial.Manifest.Images
	generation.ManifestPath = filepath.Join(stateDir, "releases", initial.Manifest.ID(), "manifest.json")
	generation.ID = initial.Manifest.ID()
	bridgeIntegrationWrite(t, filepath.Join(filepath.Dir(generation.ManifestPath), "compose.yaml"), compose, 0o600)
	if err := atomicfile.WriteJSON(generation.ManifestPath, initial.Manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	var gateMu sync.Mutex
	var reservedID, committedID string
	gate := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer bridge-integration-control-token" {
			t.Errorf("unauthenticated Platform gate call: %s", r.URL.Path)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if r.Method == http.MethodGet && r.URL.Path == "/internal/manager/health" {
			w.WriteHeader(http.StatusOK)
			return
		}
		var body struct {
			OperationID string `json:"operation_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.OperationID == "" || r.Method != http.MethodPost {
			t.Errorf("invalid gate request: %s: %v", r.URL.Path, err)
			http.Error(w, "invalid operation", http.StatusBadRequest)
			return
		}
		gateMu.Lock()
		defer gateMu.Unlock()
		switch r.URL.Path {
		case "/internal/manager/update/readiness":
			if reservedID != "" && reservedID != body.OperationID {
				t.Errorf("reservation identity changed: %s -> %s", reservedID, body.OperationID)
			}
			reservedID = body.OperationID
			_, _ = io.WriteString(w, `{"ready":true,"reserved":true}`)
		case "/internal/manager/update/commit-release":
			if reservedID != body.OperationID {
				t.Errorf("commit without matching reservation: %s", body.OperationID)
			}
			committedID = body.OperationID
			_, _ = io.WriteString(w, `{"released":true}`)
		default:
			t.Errorf("unexpected gate action: %s", r.URL.Path)
			http.Error(w, "unexpected gate action", http.StatusBadRequest)
		}
	}))
	defer gate.Close()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	_ = listener.Close()
	bridgeIntegrationWrite(t, configPath, []byte(fmt.Sprintf("data_root = %q\nsocket_path = %q\nlisten = %q\nupdate_enabled = false\ncompose_project = %q\ncompose_file = %q\nplatform_gate_url = %q\n", filepath.Join(base, "data"), socketPath, address, profile.ManagerBinary, composePath, gate.URL)), 0o600)
	bridgeIntegrationWrite(t, tokenPath, []byte("bridge-integration-control-token\n"), 0o600)
	bridgeIntegrationWrite(t, filepath.Join(stateDir, "secrets", "manager-executor-token"), []byte("bridge-integration-executor-token\n"), 0o600)
	// An existing deployment has a validated workspace root before cutover.
	if err := os.MkdirAll(filepath.Join(base, "data", "data", "workspaces"), 0o700); err != nil {
		t.Fatal(err)
	}
	oldPayload, err := os.ReadFile(filepath.Join(binaries, "bridge"))
	if err != nil {
		t.Fatal(err)
	}
	manager := &Manager{Profile: identity.CompileTimeActiveProfile(), ConfigPath: configPath, Root: filepath.Join(stateDir, "manager-binaries"), StatePath: filepath.Join(stateDir, "manager-binaries.json"), InstallPath: stable, SocketPath: socketPath, ControlTokenFile: tokenPath, UnitName: profile.ManagerUnit, RunningVersion: productionIntegrationVersion}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if t.Failed() {
			output, _ := exec.CommandContext(cleanup, "journalctl", "--user", "--no-pager", "-n", "100", "-u", profile.ManagerUnit).CombinedOutput()
			t.Logf("production upgrade unit diagnostics:\n%s", output)
			for _, path := range []string{manager.StatePath, filepath.Join(stateDir, "update.json"), manager.launcherPath()} {
				data, err := os.ReadFile(path)
				t.Logf("durable state %s: %s (error=%v)", path, data, err)
			}
		}
		_ = exec.CommandContext(cleanup, "systemctl", "--user", "stop", profile.ManagerUnit).Run()
		_ = os.Remove(unitPath)
		_ = os.Remove(stable)
		_ = exec.CommandContext(cleanup, "systemctl", "--user", "daemon-reload").Run()
		_ = exec.CommandContext(cleanup, "systemctl", "--user", "reset-failed", profile.ManagerUnit).Run()
	})
	bridgeIntegrationWrite(t, stable, oldPayload, 0o755)
	bridgeIntegrationCommand(t, ctx, "", stable, "bootstrap-launcher", "--config", configPath)
	state := model.NewState(time.Now())
	state.Current = &generation
	if err := atomicfile.WriteJSON(filepath.Join(stateDir, "state.json"), state, 0o600); err != nil {
		t.Fatal(err)
	}
	launcher := filepath.Join(manager.Root, "launcher")
	bridgeIntegrationWrite(t, unitPath, []byte(fmt.Sprintf("[Unit]\nDescription=Isolated production Manager to M1 update\n[Service]\nType=simple\nExecStart=%s launcher --config %s\nRestart=on-failure\nRestartSec=1\nTimeoutStopSec=5\nNoNewPrivileges=true\n", launcher, configPath)), 0o644)
	bridgeIntegrationCommand(t, ctx, "", "systemctl", "--user", "daemon-reload")
	bridgeIntegrationCommand(t, ctx, "", "systemctl", "--user", "start", profile.ManagerUnit)
	old := Version{Version: productionIntegrationVersion, SHA256: sha256Hex(oldPayload)}
	launcherPID := bridgeIntegrationIdentity(t, ctx, manager, old)
	bridgeIntegrationEventually(t, ctx, "production supervised readiness", func() (bool, error) {
		s, err := manager.readLauncher()
		return err == nil && s.BootReady && s.Acknowledged && !s.Pending, err
	})
	client := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socketPath)
	}}, Timeout: 5 * time.Second}
	defer client.CloseIdleConnections()
	// The child observes the launcher's durable acknowledgement asynchronously.
	// Wait on the public admission fence, as the production CLI does, rather
	// than treating the launcher record or identity endpoint as writable proof.
	bridgeIntegrationEventually(t, ctx, "production control admission readiness", func() (bool, error) {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://manager/v1/ready", nil)
		if err != nil {
			return false, err
		}
		request.Header.Set("Authorization", "Bearer bridge-integration-control-token")
		response, err := client.Do(request)
		if err != nil {
			return false, err
		}
		defer response.Body.Close()
		return response.StatusCode == http.StatusNoContent, nil
	})
	body, err := json.Marshal(map[string]any{"operation": "update", "idempotency_key": "production-to-m1", "manifest_url": releases.URL + "/manifest.json"})
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://manager/v1/operations", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer bridge-integration-control-token")
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	var admitted struct {
		Operation model.Operation `json:"operation"`
	}
	decodeErr := json.NewDecoder(response.Body).Decode(&admitted)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusAccepted || decodeErr != nil || admitted.Operation.ID == "" {
		t.Fatalf("normal update admission: HTTP %d operation=%#v: %v", response.StatusCode, admitted.Operation, decodeErr)
	}
	bridgeIntegrationEventually(t, ctx, "normal production-to-M1 update finalized", func() (bool, error) {
		var checkpoint struct {
			State      model.ManagerState         `json:"state"`
			Operations map[string]model.Operation `json:"operations"`
		}
		if err := atomicfile.ReadJSON(filepath.Join(stateDir, "update.json"), &checkpoint); err != nil {
			return false, err
		}
		op := checkpoint.Operations[admitted.Operation.ID]
		if op.Status == model.OperationFailed {
			return false, fmt.Errorf("normal update failed: %#v", op)
		}
		return op.Status == model.OperationSucceeded && op.Finalized && op.GateSettlementAction == model.GateSettlementCommit && checkpoint.State.ActiveOperationID == "" && checkpoint.State.FinalizePendingOperationID == "" && !checkpoint.State.Maintenance && checkpoint.State.Current != nil && checkpoint.State.Current.ID == target.Manifest.ID() && checkpoint.State.Previous != nil && checkpoint.State.Previous.ID == generation.ID, nil
	})
	settled, err := manager.State()
	if err != nil || settled.Current == nil || settled.Previous == nil || settled.Current.Version != bridgeIntegrationNext || settled.Current.SHA256 != sha256Hex(payload) || settled.Previous.SHA256 != old.SHA256 || settled.Previous.Version != productionIntegrationVersion || settled.Candidate != nil || settled.Activation != nil {
		t.Fatalf("normal update lost verified selection or production fallback: %#v: %v", settled, err)
	}
	bridgeIntegrationIdentity(t, ctx, manager, *settled.Current)
	pid, err := bridgeIntegrationPID(ctx, profile.ManagerUnit)
	if err != nil || pid != launcherPID {
		t.Fatalf("normal update replaced immutable launcher: before=%d after=%d: %v", launcherPID, pid, err)
	}
	launcherSHA, err := fileSHA256(filepath.Join("/proc", strconv.Itoa(pid), "exe"))
	if err != nil || launcherSHA != old.SHA256 {
		t.Fatalf("launcher no longer runs production binary: %s: %v", launcherSHA, err)
	}
	supervised, err := manager.readLauncher()
	if err != nil {
		t.Fatal(err)
	}
	childSHA, err := fileSHA256(filepath.Join("/proc", strconv.Itoa(supervised.ChildPID), "exe"))
	if err != nil || childSHA != settled.Current.SHA256 || supervised.ChildPID == pid {
		t.Fatalf("M1 is not the real supervised executable: %s: %v", childSHA, err)
	}
	gateMu.Lock()
	committed := committedID
	gateMu.Unlock()
	if committed != admitted.Operation.ID {
		t.Fatalf("normal update did not settle its original gate reservation: %s != %s", committed, admitted.Operation.ID)
	}
	stableSHA, err := fileSHA256(stable)
	if err != nil || stableSHA != settled.Current.SHA256 {
		t.Fatalf("stable binary does not match the M1 child: %s: %v", stableSHA, err)
	}
	version := bridgeIntegrationCommand(t, ctx, "", settled.Previous.Path, "version")
	if string(bytes.TrimSpace(version)) != productionIntegrationVersion {
		t.Fatalf("retained production fallback reports unexpected version: %s", version)
	}
	bridgeIntegrationCommand(t, ctx, "", "systemctl", "--user", "restart", profile.ManagerUnit)
	bridgeIntegrationIdentity(t, ctx, manager, *settled.Current)
	bridgeIntegrationEventually(t, ctx, "M1 survives service restart", func() (bool, error) {
		s, err := manager.readLauncher()
		return err == nil && s.LauncherPID != launcherPID && s.BootReady && s.Acknowledged && !s.Pending && s.Selected.SHA256 == settled.Current.SHA256, err
	})
	t.Logf("production %s -> M1 %s through normal operation %s; immutable launcher PID=%d SHA=%s", productionIntegrationVersion, settled.Current.SHA256, admitted.Operation.ID, launcherPID, launcherSHA)
}
