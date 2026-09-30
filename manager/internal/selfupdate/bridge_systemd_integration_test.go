package selfupdate

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
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
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/journal"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/releasetest"
)

const bridgeIntegrationN = "770add1e3f4dc63d88e37597c9f7b2dd85a96c45"
const bridgeIntegrationNext = "3333333333333333333333333333333333333333"
const bridgeIntegrationRejected = "4444444444444444444444444444444444444444"
const bridgeIntegrationPeriodic = "5555555555555555555555555555555555555555"
const bridgeIntegrationInner = "AGENT_PLATFORM_BRIDGE_INTEGRATION_BINARIES"

// TestBridgeSystemdBinaryUpgradeIntegration exercises real CLI executables, not
// test-process identity responders. Only their compiled technical namespace is
// changed, in disposable source trees, to avoid touching the installed service.
// The fixture starts the actual release-N immutable supervisor and child from
// a settled deployment checkpoint. It exercises binary activation and migration
// of N's seeded pending finalization through authenticated mock gate settlement,
// not Docker migrations, real Platform gate behavior, or the full update CLI.
func TestBridgeSystemdBinaryUpgradeIntegration(t *testing.T) {
	bridgeIntegrationBuildAndRun(t, bridgeIntegrationN, bridgeIntegrationRun)
}

func bridgeIntegrationBuildAndRun(t *testing.T, baseline string, run func(*testing.T, context.Context, string)) {
	t.Helper()
	if os.Getenv("AGENT_PLATFORM_SYSTEMD_INTEGRATION") != "1" {
		t.Skip("set AGENT_PLATFORM_SYSTEMD_INTEGRATION=1 to run the user-systemd integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()
	bridgeIntegrationCommand(t, ctx, "", "systemctl", "--user", "show-environment")
	if binaries := os.Getenv(bridgeIntegrationInner); binaries != "" {
		inner, innerCancel := context.WithTimeout(ctx, 180*time.Second)
		defer innerCancel()
		run(t, inner, binaries)
		return
	}

	base := t.TempDir()
	currentTree := filepath.Join(base, "current")
	oldTree := filepath.Join(base, "old")
	module, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	bridgeIntegrationCopyTree(t, module, currentTree)
	archive := bridgeIntegrationCommand(t, ctx, filepath.Dir(module), "git", "archive", baseline, "manager")
	reader := tar.NewReader(bytes.NewReader(archive))
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if header.Typeflag != tar.TypeReg {
			continue
		}
		relative := strings.TrimPrefix(header.Name, "manager/")
		if relative == header.Name || strings.HasPrefix(relative, "../") {
			t.Fatalf("unsafe archive member %q", header.Name)
		}
		data, err := io.ReadAll(reader)
		if err != nil {
			t.Fatal(err)
		}
		bridgeIntegrationWrite(t, filepath.Join(oldTree, relative), data, os.FileMode(header.Mode))
	}
	namespace := "agent-platform-bridge-it-" + bridgeIntegrationSuffix(t)
	for _, tree := range []string{currentTree, oldTree} {
		path := filepath.Join(tree, "internal", "identity", "technical_profiles_generated.go")
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		data = bytes.ReplaceAll(data, []byte("agent-platform-manager"), []byte(namespace))
		bridgeIntegrationWrite(t, path, data, 0o600)
	}
	binaries := filepath.Join(base, "binaries")
	if err := os.MkdirAll(binaries, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, binary := range []struct{ tree, name, version string }{
		{oldTree, "bridge", baseline},
		{currentTree, "next", bridgeIntegrationNext},
		{currentTree, "periodic", bridgeIntegrationPeriodic},
		{currentTree, "rejected", bridgeIntegrationRejected},
	} {
		// Only the negative candidate has an injected startup failure; version
		// and artifact verification still execute the real current CLI.
		mainPath := filepath.Join(binary.tree, "cmd", "agent-platform-manager", "main.go")
		mainSource, err := os.ReadFile(mainPath)
		if err != nil {
			t.Fatal(err)
		}
		if binary.name == "rejected" {
			positions := token.NewFileSet()
			parsed, err := parser.ParseFile(positions, mainPath, mainSource, 0)
			if err != nil {
				t.Fatal(err)
			}
			bodyOffset := -1
			for _, declaration := range parsed.Decls {
				function, ok := declaration.(*ast.FuncDecl)
				if ok && function.Recv == nil && function.Name.Name == "main" && function.Body != nil {
					bodyOffset = positions.Position(function.Body.Lbrace).Offset + 1
					break
				}
			}
			if bodyOffset < 0 {
				t.Fatal("cannot locate main function for candidate immediate-exit fault")
			}
			injection := []byte("\nif len(os.Args) > 1 && os.Args[1] == \"serve\" { os.Exit(42) }\n")
			fault := make([]byte, 0, len(mainSource)+len(injection))
			fault = append(fault, mainSource[:bodyOffset]...)
			fault = append(fault, injection...)
			fault = append(fault, mainSource[bodyOffset:]...)
			bridgeIntegrationWrite(t, mainPath, fault, 0o600)
		}
		bridgeIntegrationCommand(t, ctx, binary.tree, "go", "build", "-buildvcs=false", "-ldflags=-X main.version="+binary.version, "-o", filepath.Join(binaries, binary.name), "./cmd/agent-platform-manager")
		if binary.name == "rejected" {
			bridgeIntegrationWrite(t, mainPath, mainSource, 0o600)
		}
	}
	command := exec.CommandContext(ctx, "go", "test", "-count=1", "-v", "-timeout=240s", "-run=^"+t.Name()+"$", "./internal/selfupdate")
	command.Dir = currentTree
	command.Env = append(os.Environ(), bridgeIntegrationInner+"="+binaries)
	output, err := command.CombinedOutput()
	t.Logf("namespaced real-binary fixture:\n%s", output)
	if err != nil {
		t.Fatalf("real-binary bridge integration: %v", err)
	}
}

func bridgeIntegrationRun(t *testing.T, ctx context.Context, binaries string) {
	base, err := os.MkdirTemp("", "bridge-it-")
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
	root := filepath.Join(stateDir, "manager-binaries")
	configPath := filepath.Join(base, "manager.toml")
	socketPath := filepath.Join(base, "control", "manager.sock")
	tokenPath := filepath.Join(stateDir, "secrets", "manager-token")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	_ = listener.Close()
	generation, composePath := bridgeIntegrationCore(t, ctx, base, stateDir, profile.ManagerBinary)
	const transitionID = "integration-n-to-next"
	var gateRequests atomic.Int32
	var gateCommitted atomic.Bool
	var gateEffects atomic.Int32
	gate := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer bridge-integration-control-token" {
			t.Errorf("Platform gate received unauthenticated request to %s", r.URL.Path)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if r.Method == http.MethodGet && r.URL.Path == "/internal/manager/health" {
			w.WriteHeader(http.StatusOK)
			return
		}
		var request struct {
			OperationID string `json:"operation_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil || request.OperationID != transitionID || r.Method != http.MethodPost || r.URL.Path != "/internal/manager/update/commit-release" {
			t.Errorf("unexpected gate settlement: %s %s operation=%q error=%v", r.Method, r.URL.Path, request.OperationID, err)
			http.Error(w, "unexpected settlement", http.StatusBadRequest)
			return
		}
		gateRequests.Add(1)
		// Platform settles an operation idempotently. The Manager can replay
		// the same identity after its durable receipt without committing twice.
		if gateCommitted.CompareAndSwap(false, true) {
			gateEffects.Add(1)
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(gate.Close)
	bridgeIntegrationWrite(t, configPath, []byte(fmt.Sprintf("data_root = %q\nsocket_path = %q\nlisten = %q\nupdate_enabled = false\ncompose_project = %q\ncompose_file = %q\nplatform_gate_url = %q\n", filepath.Join(base, "data"), socketPath, address, profile.ManagerBinary, composePath, gate.URL)), 0o600)
	bridgeIntegrationWrite(t, tokenPath, []byte("bridge-integration-control-token\n"), 0o600)
	bridgeIntegrationWrite(t, filepath.Join(stateDir, "secrets", "manager-executor-token"), []byte("bridge-integration-executor-token\n"), 0o600)
	journalState := model.NewState(time.Now())
	journalState.Current = &generation
	if err := atomicfile.WriteJSON(filepath.Join(stateDir, "state.json"), journalState, 0o600); err != nil {
		t.Fatal(err)
	}
	manager := &Manager{Profile: identity.CompileTimeActiveProfile(), ConfigPath: configPath, Root: root, StatePath: filepath.Join(stateDir, "manager-binaries.json"), InstallPath: stable, SocketPath: socketPath, ControlTokenFile: tokenPath, UnitName: profile.ManagerUnit, RunningVersion: bridgeIntegrationN}

	selected := bridgeIntegrationVersion(t, root, filepath.Join(binaries, "bridge"), bridgeIntegrationN)
	data, err := os.ReadFile(selected.Path)
	if err != nil {
		t.Fatal(err)
	}
	bridgeIntegrationWrite(t, stable, data, 0o755)
	launcher := selected
	launcher.Path = filepath.Join(root, "launcher")
	bridgeIntegrationWrite(t, launcher.Path, data, 0o700)
	if err := atomicfile.WriteJSON(manager.StatePath, State{SchemaVersion: 1, Current: &selected, Previous: &selected, UpdatedAt: time.Now().UTC()}, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := atomicfile.WriteJSON(manager.launcherPath(), launcherState{SchemaVersion: 1, Launcher: launcher, Proven: true, Selected: selected, Previous: &selected}, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := atomicfile.WriteJSON(filepath.Join(root, "bridge-handoff.json"), map[string]any{"schema_version": 1, "status": "proven", "launcher": launcher}, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if t.Failed() {
			output, _ := exec.CommandContext(cleanup, "journalctl", "--user", "--no-pager", "-n", "100", "-u", profile.ManagerUnit).CombinedOutput()
			t.Logf("isolated unit diagnostics:\n%s", output)
			for _, path := range []string{manager.StatePath, filepath.Join(stateDir, "state.json"), filepath.Join(stateDir, "update.json"), manager.launcherPath()} {
				data, err := os.ReadFile(path)
				t.Logf("isolated durable state %s: %s (error=%v)", path, data, err)
			}
		}
		_ = exec.CommandContext(cleanup, "systemctl", "--user", "stop", profile.ManagerUnit).Run()
		_ = os.Remove(unitPath)
		_ = os.Remove(stable)
		_ = exec.CommandContext(cleanup, "systemctl", "--user", "daemon-reload").Run()
		_ = exec.CommandContext(cleanup, "systemctl", "--user", "reset-failed", profile.ManagerUnit).Run()
	})
	bridgeIntegrationWrite(t, unitPath, []byte(fmt.Sprintf("[Unit]\nDescription=Isolated Manager N to N+1 integration\n[Service]\nType=simple\nExecStart=%s launcher --config %s\nRestart=on-failure\nRestartSec=1\nTimeoutStopSec=5\nNoNewPrivileges=true\n[Install]\nWantedBy=default.target\n", launcher.Path, configPath)), 0o644)
	bridgeIntegrationCommand(t, ctx, "", "systemctl", "--user", "daemon-reload")
	bridgeIntegrationCommand(t, ctx, "", "systemctl", "--user", "start", profile.ManagerUnit)
	bridgeIntegrationIdentity(t, ctx, manager, selected)
	bridgeIntegrationEventually(t, ctx, "release N supervised child and core readiness", func() (bool, error) {
		s, err := manager.readLauncher()
		return err == nil && s.BootReady && s.Acknowledged && !s.Pending && s.Selected.SHA256 == selected.SHA256, err
	})
	launcherPID, err := bridgeIntegrationPID(ctx, profile.ManagerUnit)
	if err != nil {
		t.Fatal(err)
	}
	launcherSHA, err := fileSHA256(filepath.Join("/proc", strconv.Itoa(launcherPID), "exe"))
	if err != nil || launcherSHA != selected.SHA256 {
		t.Fatalf("initial launcher is not release N: SHA=%s: %v", launcherSHA, err)
	}
	launcherPath, err := os.Readlink(filepath.Join("/proc", strconv.Itoa(launcherPID), "exe"))
	if err != nil || launcherPath != launcher.Path || launcherPath == stable {
		t.Fatalf("launcher is not independently immutable: path=%s: %v", launcherPath, err)
	}
	initial, err := manager.readLauncher()
	if err != nil || initial.ChildPID <= 1 || initial.ChildPID == launcherPID {
		t.Fatalf("release N was not supervised: %#v: %v", initial, err)
	}
	initialSHA, err := fileSHA256(filepath.Join("/proc", strconv.Itoa(initial.ChildPID), "exe"))
	if err != nil || initialSHA != selected.SHA256 {
		t.Fatalf("initial child is not actual release N: SHA=%s: %v", initialSHA, err)
	}
	for _, upgrade := range []struct {
		name, version string
		fallback      bool
	}{{"rejected", bridgeIntegrationRejected, true}, {"next", bridgeIntegrationNext, false}} {
		t.Run(upgrade.name, func(t *testing.T) {
			payload, err := os.ReadFile(filepath.Join(binaries, upgrade.name))
			if err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(payload) }))
			defer server.Close()
			compose, err := os.ReadFile(composePath)
			if err != nil {
				t.Fatal(err)
			}
			manifest := releasetest.NewTarget(upgrade.version, releasetest.WithArtifactBaseURL(server.URL), releasetest.WithManagerBinary(runtime.GOARCH, payload), releasetest.WithCompose(compose)).Manifest
			manifest.Images = generation.Images
			if err := manager.Prepare(ctx, manifest); err != nil {
				t.Fatal(err)
			}
			if err := manager.MarkPlatformCommitted(manifest); err != nil {
				t.Fatal(err)
			}
			if !upgrade.fallback {
				// Recreate the exact N finalization checkpoint offline; the live
				// N child above is stopped so it cannot rewrite seeded state.
				bridgeIntegrationCommand(t, ctx, "", "systemctl", "--user", "stop", profile.ManagerUnit)
				now := time.Now().UTC()
				manifestPath := filepath.Join(stateDir, "releases", manifest.ID(), "manifest.json")
				bridgeIntegrationWrite(t, filepath.Join(filepath.Dir(manifestPath), "compose.yaml"), compose, 0o600)
				if err := atomicfile.WriteJSON(manifestPath, manifest, 0o600); err != nil {
					t.Fatal(err)
				}
				snapshotPath := filepath.Join(stateDir, "snapshots", transitionID)
				target := model.Generation{ID: manifest.ID(), ManifestPath: manifestPath, SourceCommit: manifest.SourceCommit, DatabaseVersion: manifest.DatabaseSchemaVersion, Images: manifest.Images, RollbackSnapshotPath: snapshotPath, ActivatedAt: now}
				state := model.NewState(now)
				state.Current, state.Previous = &target, &generation
				state.FinalizePendingOperationID = transitionID
				state.Maintenance, state.PublicState, state.Phase = true, model.StateUpdating, model.PhaseProbing
				op := model.Operation{SchemaVersion: 1, ID: transitionID, Kind: model.OperationUpdate, IdempotencyKey: transitionID, Attempt: 1, TargetGeneration: target.ID, Status: model.OperationSucceeded, Phase: model.PhaseProbing, ReservationStatus: model.ReservationMutationStarted, SnapshotPath: snapshotPath, CreatedAt: now, UpdatedAt: now, CompletedAt: &now}
				if err := atomicfile.WriteJSON(filepath.Join(stateDir, "operations", transitionID+".json"), op, 0o600); err != nil {
					t.Fatal(err)
				}
				if err := atomicfile.WriteJSON(filepath.Join(stateDir, "state.json"), state, 0o600); err != nil {
					t.Fatal(err)
				}
				if _, err := os.Lstat(filepath.Join(stateDir, "update.json")); !os.IsNotExist(err) {
					t.Fatalf("N unexpectedly owns the N+1 transaction record: %v", err)
				}
			}
			if err := manager.Activate(ctx, manifest); err != nil {
				t.Fatal(err)
			}
			if !upgrade.fallback {
				bridgeIntegrationCommand(t, ctx, "", "systemctl", "--user", "start", profile.ManagerUnit)
				launcherPID, err = bridgeIntegrationPID(ctx, profile.ManagerUnit)
				if err != nil {
					t.Fatal(err)
				}
			}
			want := upgrade.version
			if upgrade.fallback {
				want = bridgeIntegrationN
			}
			bridgeIntegrationEventually(t, ctx, "bounded supervised selection "+want, func() (bool, error) {
				settled, err := manager.State()
				if err != nil {
					return false, err
				}
				supervised, err := manager.readLauncher()
				return err == nil && supervised.BootReady && !supervised.Pending && settled.Current != nil && settled.Current.Version == want && settled.Candidate == nil && settled.Activation == nil, err
			})
			settled, err := manager.State()
			if err != nil {
				t.Fatal(err)
			}
			bridgeIntegrationIdentity(t, ctx, manager, *settled.Current)
			pid, err := bridgeIntegrationPID(ctx, profile.ManagerUnit)
			if err != nil {
				t.Fatal(err)
			}
			sha, err := fileSHA256(filepath.Join("/proc", strconv.Itoa(pid), "exe"))
			if err != nil || sha != launcherSHA {
				t.Fatalf("upgrade replaced immutable launcher: %s: %v", sha, err)
			}
			if pid != launcherPID {
				t.Fatalf("launcher did not survive child replacement: initial=%d final=%d", launcherPID, pid)
			}
			supervised, err := manager.readLauncher()
			if err != nil {
				t.Fatal(err)
			}
			if supervised.ChildPID <= 1 || supervised.ChildPID == pid || !supervised.BootReady {
				t.Fatalf("invalid supervised child proof: %#v", supervised)
			}
			childSHA, err := fileSHA256(filepath.Join("/proc", strconv.Itoa(supervised.ChildPID), "exe"))
			if err != nil || childSHA != settled.Current.SHA256 {
				t.Fatalf("child identity mismatch: %s: %v", childSHA, err)
			}
			stableSHA, err := fileSHA256(stable)
			if err != nil || stableSHA != settled.Current.SHA256 {
				t.Fatalf("stable selection differs from healthy child: %s: %v", stableSHA, err)
			}
			if upgrade.fallback {
				time.Sleep(2 * time.Second)
				after, err := bridgeIntegrationPID(ctx, profile.ManagerUnit)
				if err != nil || after != pid {
					t.Fatalf("fallback loops launcher: before=%d after=%d: %v", pid, after, err)
				}
				afterChild, err := manager.readLauncher()
				if err != nil || afterChild.ChildPID != supervised.ChildPID || afterChild.Pending {
					t.Fatalf("fallback loops child: before=%d after=%#v: %v", supervised.ChildPID, afterChild, err)
				}
				if err := manager.Prepare(ctx, manifest); err == nil {
					t.Fatal("rejected candidate was admitted again")
				}
			} else if settled.Previous == nil || settled.Previous.Version != bridgeIntegrationN || settled.Previous.SHA256 != selected.SHA256 {
				t.Fatalf("successful update lost byte-identical release N fallback: %#v", settled.Previous)
			} else {
				version := bridgeIntegrationCommand(t, ctx, "", settled.Previous.Path, "version")
				if strings.TrimSpace(string(version)) != bridgeIntegrationN {
					t.Fatalf("previous N is no longer runnable: %s", version)
				}
			}
			manager.RunningVersion = want
			t.Logf("selected version=%s child PID=%d SHA=%s, same launcher PID=%d, fallback=%t", want, supervised.ChildPID, childSHA, pid, upgrade.fallback)
		})
	}
	bridgeIntegrationEventually(t, ctx, "N operation migrated and gate-settled by N+1", func() (bool, error) {
		var checkpoint struct {
			State      model.ManagerState         `json:"state"`
			Operations map[string]model.Operation `json:"operations"`
		}
		if err := atomicfile.ReadJSON(filepath.Join(stateDir, "update.json"), &checkpoint); err != nil {
			return false, err
		}
		op := checkpoint.Operations[transitionID]
		return op.ID == transitionID && op.IdempotencyKey == transitionID && op.Finalized && op.Status == model.OperationSucceeded && op.GateSettlementAction == model.GateSettlementCommit && checkpoint.State.FinalizePendingOperationID == "" && !checkpoint.State.Maintenance && checkpoint.State.Current != nil && checkpoint.State.Current.SourceCommit == bridgeIntegrationNext && checkpoint.State.Previous != nil && checkpoint.State.Previous.SourceCommit == bridgeIntegrationN, nil
	})
	if requests, effects := gateRequests.Load(), gateEffects.Load(); requests != 2 || effects != 1 {
		t.Fatalf("N gate settlement requests=%d effects=%d, want receipt-fenced replay and one logical commit", requests, effects)
	}
	bridgeIntegrationCommand(t, ctx, "", "systemctl", "--user", "restart", profile.ManagerUnit)
	bridgeIntegrationEventually(t, ctx, "rejected selection remains rejected after service restart", func() (bool, error) {
		supervised, err := manager.readLauncher()
		if err != nil {
			return false, err
		}
		return supervised.LauncherPID != launcherPID && supervised.BootReady && !supervised.Pending && supervised.Selected.Version == bridgeIntegrationNext && supervised.Rejected == bridgeIntegrationRejected, nil
	})
	settled, err := manager.State()
	if err != nil {
		t.Fatal(err)
	}
	bridgeIntegrationIdentity(t, ctx, manager, *settled.Current)
	if effects := gateEffects.Load(); effects != 1 {
		t.Fatalf("settled operation produced another commit effect after restart: %d", effects)
	}
	t.Run("committed-restart-pending-operation", func(t *testing.T) {
		bridgeIntegrationPendingRestart(t, ctx, manager, stateDir, *settled.Current)
	})
	t.Run("periodic-update-after-supervised-restart", func(t *testing.T) {
		bridgeIntegrationPeriodicUpdate(t, ctx, manager, stateDir, binaries, *settled.Current)
	})
	t.Run("fresh-bootstrap-installer-permissions", func(t *testing.T) {
		bridgeIntegrationCommand(t, ctx, "", "systemctl", "--user", "stop", profile.ManagerUnit)
		freshBase := filepath.Join(base, "fresh")
		freshStateDir := filepath.Join(freshBase, "data", "manager")
		freshConfig := filepath.Join(freshBase, "manager.toml")
		freshSocket := filepath.Join(freshBase, "control", "manager.sock")
		freshToken := filepath.Join(freshStateDir, "secrets", "manager-token")
		bridgeIntegrationWrite(t, freshConfig, []byte(fmt.Sprintf("data_root = %q\nsocket_path = %q\nlisten = %q\nupdate_enabled = false\ncompose_project = %q\ncompose_file = %q\nplatform_gate_url = %q\n", filepath.Join(freshBase, "data"), freshSocket, address, profile.ManagerBinary, composePath, gate.URL)), 0o600)
		bridgeIntegrationWrite(t, freshToken, []byte("bridge-integration-control-token\n"), 0o600)
		bridgeIntegrationWrite(t, filepath.Join(freshStateDir, "secrets", "manager-executor-token"), []byte("bridge-integration-executor-token\n"), 0o600)
		payload, err := os.ReadFile(filepath.Join(binaries, "next"))
		if err != nil {
			t.Fatal(err)
		}
		bridgeIntegrationWrite(t, stable, payload, 0o755)
		fresh := &Manager{Profile: identity.CompileTimeActiveProfile(), ConfigPath: freshConfig, Root: filepath.Join(freshStateDir, "manager-binaries"), StatePath: filepath.Join(freshStateDir, "manager-binaries.json"), InstallPath: stable, SocketPath: freshSocket, ControlTokenFile: freshToken, UnitName: profile.ManagerUnit, RunningVersion: bridgeIntegrationNext}
		freshLauncher := filepath.Join(fresh.Root, "launcher")
		bridgeIntegrationWrite(t, unitPath, []byte(fmt.Sprintf("[Unit]\nDescription=Isolated fresh Manager bootstrap\n[Service]\nType=simple\nExecStart=%s launcher --config %s\nRestart=on-failure\nRestartSec=1\nTimeoutStopSec=5\nNoNewPrivileges=true\n[Install]\nWantedBy=default.target\n", freshLauncher, freshConfig)), 0o644)
		output := bridgeIntegrationCommand(t, ctx, "", stable, "bootstrap-launcher", "--config", freshConfig)
		if strings.TrimSpace(string(output)) != freshLauncher {
			t.Fatalf("bootstrap returned unexpected launcher: %s", output)
		}
		// Bootstrap must run before any deployment state exists. Seed the same
		// healthy core checkpoint only afterward to exercise supervised readiness.
		checkpoint := model.NewState(time.Now())
		checkpoint.Current = &generation
		if err := atomicfile.WriteJSON(filepath.Join(freshStateDir, "state.json"), checkpoint, 0o600); err != nil {
			t.Fatal(err)
		}
		bridgeIntegrationCommand(t, ctx, "", "systemctl", "--user", "daemon-reload")
		bridgeIntegrationCommand(t, ctx, "", "systemctl", "--user", "start", profile.ManagerUnit)
		bridgeIntegrationEventually(t, ctx, "fresh N+1 bootstrap supervised child readiness", func() (bool, error) {
			supervised, err := fresh.readLauncher()
			return err == nil && supervised.Bootstrap && supervised.BootReady && supervised.Acknowledged && !supervised.Pending && supervised.Selected.Version == bridgeIntegrationNext, err
		})
		supervised, err := fresh.readLauncher()
		if err != nil {
			t.Fatal(err)
		}
		pid, err := bridgeIntegrationPID(ctx, profile.ManagerUnit)
		if err != nil {
			t.Fatal(err)
		}
		bridgeIntegrationIdentity(t, ctx, fresh, supervised.Selected)
		childPID := supervised.ChildPID
		if childPID <= 1 || childPID == pid || supervised.LauncherPID != pid {
			t.Fatalf("fresh bootstrap did not launch an independent supervised child: launcher=%d child=%d state=%#v", pid, childPID, supervised)
		}
		for _, process := range []struct {
			pid  int
			path string
		}{{pid, freshLauncher}, {childPID, supervised.Selected.Path}} {
			executable := filepath.Join("/proc", strconv.Itoa(process.pid), "exe")
			path, err := os.Readlink(executable)
			if err != nil || path != process.path {
				t.Fatalf("fresh process %d executable=%q, want %q: %v", process.pid, path, process.path, err)
			}
			hash, err := fileSHA256(executable)
			if err != nil || hash != sha256Hex(payload) {
				t.Fatalf("fresh process %d is not actual N+1: SHA=%s: %v", process.pid, hash, err)
			}
		}
		for path, mode := range map[string]os.FileMode{
			stable: 0o755, unitPath: 0o644, fresh.StatePath: 0o600, fresh.launcherPath(): 0o600,
			freshToken: 0o600, filepath.Join(freshStateDir, "secrets", "manager-executor-token"): 0o600,
		} {
			info, err := os.Lstat(path)
			if err != nil {
				t.Fatal(err)
			}
			if !info.Mode().IsRegular() || info.Mode().Perm() != mode {
				t.Fatalf("bootstrap changed installer permissions: %s has %s, want %04o", path, info.Mode(), mode)
			}
		}
	})
}

func bridgeIntegrationIdentity(t *testing.T, ctx context.Context, manager *Manager, version Version) int {
	t.Helper()
	client := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", manager.SocketPath)
	}}, Timeout: time.Second}
	defer client.CloseIdleConnections()
	var pid int
	bridgeIntegrationEventually(t, ctx, "authenticated real Manager identity "+version.Version, func() (bool, error) {
		request, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://manager/v1/identity", nil)
		request.Header.Set("Authorization", "Bearer bridge-integration-control-token")
		response, err := client.Do(request)
		if err != nil {
			return false, nil
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return false, nil
		}
		var identity struct{ Status, Version, SHA256 string }
		if err := json.NewDecoder(response.Body).Decode(&identity); err != nil {
			return false, err
		}
		if identity.Status != "healthy" || identity.Version != version.Version || identity.SHA256 != version.SHA256 {
			return false, nil
		}
		pid, err = bridgeIntegrationPID(ctx, manager.UnitName)
		return pid > 1, err
	})
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://manager/v1/identity", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated identity returned %d", response.StatusCode)
	}
	return pid
}

func bridgeIntegrationVersion(t *testing.T, root, source, version string) Version {
	t.Helper()
	data, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "versions", version+"-"+version[:12], identity.TargetProfile().ManagerBinary)
	bridgeIntegrationWrite(t, path, data, 0o700)
	result := Version{Version: version, SourceCommit: version, SHA256: sha256Hex(data), Path: path, VerifiedAt: time.Now().UTC(), PlatformCommitted: true}
	if err := atomicfile.WriteJSON(filepath.Join(filepath.Dir(path), "metadata.json"), result, 0o600); err != nil {
		t.Fatal(err)
	}
	return result
}

func bridgeIntegrationWrite(t *testing.T, path string, data []byte, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := atomicfile.WriteFile(path, data, mode); err != nil {
		t.Fatal(err)
	}
}

func bridgeIntegrationCopyTree(t *testing.T, source, destination string) {
	t.Helper()
	err := filepath.WalkDir(source, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("nonregular source member %s", path)
		}
		if !strings.HasSuffix(path, ".go") && filepath.Base(path) != "go.mod" && filepath.Base(path) != "go.sum" {
			return nil
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		bridgeIntegrationWrite(t, filepath.Join(destination, relative), data, 0o600)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func bridgeIntegrationCommand(t *testing.T, ctx context.Context, directory, name string, args ...string) []byte {
	t.Helper()
	command := exec.CommandContext(ctx, name, args...)
	command.Dir = directory
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("%s %v: %v\n%s", name, args, err, output)
	}
	return output
}

// The Manager's production core probe verifies real Compose container health,
// digest identity and project/service labels. These isolated Alpine processes
// provide that boundary without launching or claiming to test Platform itself.
func bridgeIntegrationCore(t *testing.T, ctx context.Context, base, stateDir, project string) (model.Generation, string) {
	t.Helper()
	const image = "alpine@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce"
	composePath := filepath.Join(base, "core-compose.yaml")
	var compose strings.Builder
	compose.WriteString("services:\n")
	for _, service := range []string{"platform", "agent-runtime"} {
		fmt.Fprintf(&compose, "  %s:\n    image: %s\n    command: [\"sleep\", \"600\"]\n    network_mode: none\n    read_only: true\n    healthcheck:\n      test: [\"CMD\", \"kill\", \"-0\", \"1\"]\n      interval: 1s\n      timeout: 1s\n      retries: 3\n", service, image)
	}
	bridgeIntegrationWrite(t, composePath, []byte(compose.String()), 0o600)
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		output, err := exec.CommandContext(cleanup, "docker", "compose", "--project-name", project, "--file", composePath, "down", "--timeout", "2").CombinedOutput()
		if err != nil {
			t.Errorf("remove isolated core containers: %v: %s", err, output)
		}
	})
	bridgeIntegrationCommand(t, ctx, "", "docker", "compose", "--project-name", project, "--file", composePath, "up", "-d", "--wait", "--wait-timeout", "20")
	fixture := releasetest.NewTarget(bridgeIntegrationN, releasetest.WithCompose([]byte(compose.String())))
	fixture.Manifest.Images["platform"] = image
	fixture.Manifest.Images["agent-runtime"] = image
	manifestPath := filepath.Join(stateDir, "releases", fixture.Manifest.ID(), "manifest.json")
	bridgeIntegrationWrite(t, filepath.Join(filepath.Dir(manifestPath), "compose.yaml"), fixture.Compose, 0o600)
	if err := atomicfile.WriteJSON(manifestPath, fixture.Manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	return model.Generation{ID: fixture.Manifest.ID(), ManifestPath: manifestPath, SourceCommit: bridgeIntegrationN, DatabaseVersion: fixture.Manifest.DatabaseSchemaVersion, Images: fixture.Manifest.Images, ActivatedAt: time.Now().UTC()}, composePath
}

func bridgeIntegrationPendingRestart(t *testing.T, ctx context.Context, manager *Manager, stateDir string, selected Version) {
	t.Helper()
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	previous, err := manager.readLauncher()
	if err != nil {
		t.Fatal(err)
	}
	bridgeIntegrationCommand(t, ctx, "", "systemctl", "--user", "stop", manager.UnitName)
	requested := make(chan struct{}, 1)
	releaseRequest := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case requested <- struct{}{}:
		default:
		}
		select {
		case <-releaseRequest:
			http.Error(w, "isolated test intentionally blocks release admission", http.StatusServiceUnavailable)
		case <-r.Context().Done():
		}
	}))
	defer server.Close()
	defer close(releaseRequest)
	store, err := journal.Open(stateDir, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	operation, _, err := store.Begin(model.OperationRequest{
		Kind: model.OperationUpdate, IdempotencyKey: "bridge-pending-restart",
		ExpectedGeneration: store.State().Generation, ManifestURL: server.URL,
	}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	bridgeIntegrationCommand(t, ctx, "", "systemctl", "--user", "start", manager.UnitName)
	bridgeIntegrationEventually(t, ctx, "committed child readiness with an unfinished validating operation", func() (bool, error) {
		launcher, err := manager.readLauncher()
		if err != nil {
			return false, err
		}
		return launcher.LauncherPID != previous.LauncherPID && launcher.BootReady && !launcher.Pending && !launcher.Failed && launcher.Selected.SHA256 == selected.SHA256, nil
	})
	bridgeIntegrationIdentity(t, ctx, manager, selected)
	select {
	case <-requested:
	case <-ctx.Done():
		t.Fatal("committed Manager did not resume the original operation")
	}
	launcher, err := manager.readLauncher()
	if err != nil {
		t.Fatal(err)
	}
	pid, err := bridgeIntegrationPID(ctx, manager.UnitName)
	if err != nil || launcher.LauncherPID != pid || !launcher.BootReady || launcher.Failed {
		t.Fatalf("resumed operation lost live supervisor readiness: %#v MainPID=%d: %v", launcher, pid, err)
	}
	var checkpoint struct {
		SchemaVersion int                        `json:"schema_version"`
		State         model.ManagerState         `json:"state"`
		Operations    map[string]model.Operation `json:"operations"`
	}
	if err := atomicfile.ReadJSON(filepath.Join(stateDir, "update.json"), &checkpoint); err != nil {
		t.Fatal(err)
	}
	persisted, found := checkpoint.Operations[operation.ID]
	if checkpoint.SchemaVersion != 1 || checkpoint.State.ActiveOperationID != operation.ID || !found || persisted.ID != operation.ID || persisted.IdempotencyKey != operation.IdempotencyKey || persisted.Phase != model.PhaseValidating || persisted.Status == model.OperationFailed {
		t.Fatalf("restart did not retain pending operation identity: %#v", persisted)
	}
	t.Logf("committed supervised Manager became ready and resumed original validating operation %s", operation.ID)
}

func bridgeIntegrationPeriodicUpdate(t *testing.T, ctx context.Context, manager *Manager, stateDir, binaries string, selected Version) {
	t.Helper()
	ctx, cancel := context.WithTimeout(ctx, 75*time.Second)
	defer cancel()
	type checkpoint struct {
		State      model.ManagerState         `json:"state"`
		Operations map[string]model.Operation `json:"operations"`
	}
	var before checkpoint
	bridgeIntegrationEventually(t, ctx, "previous restart operation finalized", func() (bool, error) {
		var current checkpoint
		if err := atomicfile.ReadJSON(filepath.Join(stateDir, "update.json"), &current); err != nil {
			return false, err
		}
		before = current
		return before.State.ActiveOperationID == "" && before.State.FinalizePendingOperationID == "", nil
	})
	previous, err := manager.readLauncher()
	if err != nil {
		t.Fatal(err)
	}
	currentPayload, err := os.ReadFile(filepath.Join(binaries, "next"))
	if err != nil {
		t.Fatal(err)
	}
	compose, err := os.ReadFile(filepath.Join(filepath.Dir(before.State.Current.ManifestPath), "compose.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	payload, err := os.ReadFile(filepath.Join(binaries, "periodic"))
	if err != nil {
		t.Fatal(err)
	}
	var published atomic.Bool
	var initialPolls atomic.Int32
	var targetPolls atomic.Int32
	var binaryRequests atomic.Int32
	var currentManifest, targetManifest []byte
	releaseBinary := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/manifest.json":
			w.Header().Set("Content-Type", "application/json")
			if published.Load() {
				targetPolls.Add(1)
				_, _ = w.Write(targetManifest)
			} else {
				initialPolls.Add(1)
				_, _ = w.Write(currentManifest)
			}
		case "/agent-platform-compose.yaml", "/current/agent-platform-compose.yaml":
			_, _ = w.Write(compose)
		case "/current/agent-platform-manager-linux-" + runtime.GOARCH:
			_, _ = w.Write(currentPayload)
		case "/agent-platform-manager-linux-" + runtime.GOARCH:
			// Pause a real artifact transfer after target admission so the
			// durable operation can be inspected without starting a cutover.
			binaryRequests.Add(1)
			select {
			case <-releaseBinary:
				_, _ = w.Write(payload)
			case <-r.Context().Done():
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	defer close(releaseBinary)
	defer func() {
		stop, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		bridgeIntegrationCommand(t, stop, "", "systemctl", "--user", "stop", manager.UnitName)
	}()
	current := releasetest.NewTarget(bridgeIntegrationNext, releasetest.WithArtifactBaseURL(server.URL+"/current"), releasetest.WithManagerBinary(runtime.GOARCH, currentPayload), releasetest.WithCompose(compose))
	current.Manifest.Images = before.State.Current.Images
	currentManifest, err = json.Marshal(current.Manifest)
	if err != nil {
		t.Fatal(err)
	}
	fixture := releasetest.NewTarget(bridgeIntegrationPeriodic, releasetest.WithArtifactBaseURL(server.URL), releasetest.WithManagerBinary(runtime.GOARCH, payload), releasetest.WithCompose(compose))
	fixture.Manifest.Images = before.State.Current.Images
	targetManifest, err = json.Marshal(fixture.Manifest)
	if err != nil {
		t.Fatal(err)
	}
	config, err := os.ReadFile(manager.ConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	config = bytes.Replace(config, []byte("update_enabled = false"), []byte("update_enabled = true"), 1)
	releaseURL := server.URL + "/manifest.json"
	config = append(config, []byte(fmt.Sprintf("update_interval = \"30s\"\nrelease_manifest_url = %q\n", releaseURL))...)
	bridgeIntegrationWrite(t, manager.ConfigPath, config, 0o600)
	bridgeIntegrationCommand(t, ctx, "", "systemctl", "--user", "restart", manager.UnitName)
	bridgeIntegrationEventually(t, ctx, "N+1 supervised restart and initial automatic poll", func() (bool, error) {
		supervised, err := manager.readLauncher()
		return err == nil && supervised.LauncherPID != previous.LauncherPID && supervised.ChildPID != previous.ChildPID && supervised.BootReady && !supervised.Pending && supervised.Selected.SHA256 == selected.SHA256 && initialPolls.Load() > 0, err
	})
	bridgeIntegrationIdentity(t, ctx, manager, selected)
	// The startup poll sees only the committed release. Publishing afterward
	// requires a later periodic tick; no control check/update endpoint is used.
	published.Store(true)
	var started model.Operation
	bridgeIntegrationEventually(t, ctx, "periodic automatic target operation after restart", func() (bool, error) {
		var current checkpoint
		if err := atomicfile.ReadJSON(filepath.Join(stateDir, "update.json"), &current); err != nil {
			return false, err
		}
		op, found := current.Operations[current.State.ActiveOperationID]
		if !found || op.TargetGeneration != fixture.Manifest.ID() || binaryRequests.Load() == 0 {
			return false, nil
		}
		hash := sha256.New()
		for _, value := range []string{releaseURL, fixture.Manifest.ID(), op.CreatedAt.UTC().Format("2006010215")} {
			_, _ = hash.Write([]byte(value))
			_, _ = hash.Write([]byte{0})
		}
		wantKey := "auto-" + hex.EncodeToString(hash.Sum(nil))
		if _, existed := before.Operations[op.ID]; existed || op.Kind != model.OperationUpdate || op.IdempotencyKey != wantKey || op.TargetManifestURL != releaseURL || op.Phase != model.PhaseValidating || op.Status != model.OperationRunning || op.Attempt != 1 {
			return false, fmt.Errorf("unexpected automatic operation: %#v, want key %s", op, wantKey)
		}
		if current.State.Current == nil || current.State.Current.ID != before.State.Current.ID || current.State.Candidate == nil || current.State.Candidate.ID != fixture.Manifest.ID() {
			return false, fmt.Errorf("automatic admission changed committed generation or lost candidate: %#v", current.State)
		}
		started = op
		return targetPolls.Load() >= 2, nil
	})
	t.Logf("periodic poll after supervised N+1 restart started operation=%s target=%s key=%s phase=%s", started.ID, started.TargetGeneration, started.IdempotencyKey, started.Phase)
}

func bridgeIntegrationSuffix(t *testing.T) string {
	t.Helper()
	value := make([]byte, 12)
	if _, err := rand.Read(value); err != nil {
		t.Fatalf("generate collision-resistant systemd unit suffix: %v", err)
	}
	return fmt.Sprintf("%d-%s", os.Getpid(), hex.EncodeToString(value))
}

func bridgeIntegrationPID(ctx context.Context, unit string) (int, error) {
	output, err := exec.CommandContext(ctx, "systemctl", "--user", "show", unit, "--property=MainPID", "--value").Output()
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(string(output)))
}

func bridgeIntegrationEventually(t *testing.T, ctx context.Context, description string, check func() (bool, error)) {
	t.Helper()
	for {
		ok, err := check()
		if err != nil {
			t.Fatalf("wait for %s: %v", description, err)
		}
		if ok {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("wait for %s: %v", description, ctx.Err())
		case <-time.After(100 * time.Millisecond):
		}
	}
}
