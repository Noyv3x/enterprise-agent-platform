package selfupdate

import (
	"archive/tar"
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
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/journal"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/releasetest"
)

const bridgeIntegrationOldCommit = "535ac3fadeb46b2a625b03ea0d8471b467bb4544"
const bridgeIntegrationN = "2222222222222222222222222222222222222222"
const bridgeIntegrationNext = "3333333333333333333333333333333333333333"
const bridgeIntegrationRejected = "4444444444444444444444444444444444444444"
const bridgeIntegrationInner = "AGENT_PLATFORM_BRIDGE_INTEGRATION_BINARIES"

// TestBridgeSystemdBinaryUpgradeIntegration exercises real CLI executables, not
// test-process identity responders. Only their compiled technical namespace is
// changed, in disposable source trees, to avoid touching the installed service.
// The fixture seeds the legacy binary transaction; it does not claim to execute
// Docker migrations, a release gate transaction, or a full `update` operation.
func TestBridgeSystemdBinaryUpgradeIntegration(t *testing.T) {
	if os.Getenv(recoverySystemdIntegrationEnvironment) != "1" {
		t.Skip("set AGENT_PLATFORM_SYSTEMD_INTEGRATION=1 to run the user-systemd integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	bridgeIntegrationCommand(t, ctx, "", "systemctl", "--user", "show-environment")
	if binaries := os.Getenv(bridgeIntegrationInner); binaries != "" {
		inner, innerCancel := context.WithTimeout(ctx, 150*time.Second)
		defer innerCancel()
		bridgeIntegrationRun(t, inner, binaries)
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
	archive := bridgeIntegrationCommand(t, ctx, filepath.Dir(module), "git", "archive", bridgeIntegrationOldCommit, "manager")
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
	namespace := "agent-platform-bridge-it-" + recoverySystemdIntegrationSuffix(t)
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
		{oldTree, "old", bridgeIntegrationOldCommit},
		{currentTree, "bridge", bridgeIntegrationN},
		{currentTree, "next", bridgeIntegrationNext},
		// A real pre-launcher executable cannot acknowledge the authenticated
		// supervised boot protocol. This injects a missing startup acknowledgement
		// without replacing Manager's HTTP identity endpoint with a mock.
		{oldTree, "rejected", bridgeIntegrationRejected},
	} {
		bridgeIntegrationCommand(t, ctx, binary.tree, "go", "build", "-buildvcs=false", "-ldflags=-X main.version="+binary.version, "-o", filepath.Join(binaries, binary.name), "./cmd/agent-platform-manager")
	}
	command := exec.CommandContext(ctx, "go", "test", "-count=1", "-v", "-timeout=210s", "-run=^TestBridgeSystemdBinaryUpgradeIntegration$", "./internal/selfupdate")
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
	profile := testTechnicalProfile
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
	bridgeIntegrationWrite(t, configPath, []byte(fmt.Sprintf("data_root = %q\nsocket_path = %q\nlisten = %q\nupdate_enabled = false\ncompose_project = %q\ncompose_file = %q\n", filepath.Join(base, "data"), socketPath, address, profile.ManagerBinary, composePath)), 0o600)
	bridgeIntegrationWrite(t, tokenPath, []byte("bridge-integration-control-token\n"), 0o600)
	bridgeIntegrationWrite(t, filepath.Join(stateDir, "secrets", "manager-executor-token"), []byte("bridge-integration-executor-token\n"), 0o600)
	journalState := model.NewState(time.Now())
	journalState.Current = &generation
	if err := atomicfile.WriteJSON(filepath.Join(stateDir, "state.json"), journalState, 0o600); err != nil {
		t.Fatal(err)
	}
	manager := &Manager{Profile: testActiveProfile, ConfigPath: configPath, Root: root, StatePath: filepath.Join(stateDir, "manager-binaries.json"), InstallPath: stable, SocketPath: socketPath, ControlTokenFile: tokenPath, UnitName: profile.ManagerUnit, RunningVersion: bridgeIntegrationN}
	old := bridgeIntegrationVersion(t, root, filepath.Join(binaries, "old"), bridgeIntegrationOldCommit)
	candidate := bridgeIntegrationVersion(t, root, filepath.Join(binaries, "bridge"), bridgeIntegrationN)
	oldData, err := os.ReadFile(old.Path)
	if err != nil {
		t.Fatal(err)
	}
	bridgeIntegrationWrite(t, stable, oldData, 0o700)
	planPath := filepath.Join(root, "activations", bridgeIntegrationN+".json")
	now := time.Now().UTC()
	state := State{SchemaVersion: 1, Current: &old, Candidate: &candidate, Activation: &Activation{PlanPath: planPath, CandidateSHA: candidate.SHA256, CandidatePath: candidate.Path, StartedAt: now}, UpdatedAt: now}
	if err := atomicfile.WriteJSON(manager.StatePath, State{SchemaVersion: 1, Current: &old, UpdatedAt: now}, 0o600); err != nil {
		t.Fatal(err)
	}
	plan := Plan{SchemaVersion: 1, PlanPath: planPath, Status: "prepared", StatePath: manager.StatePath, InstallPath: stable, SocketPath: socketPath, ControlTokenFile: tokenPath, UnitName: profile.ManagerUnit, CandidateVersion: candidate.Version, CandidateSHA: candidate.SHA256, CandidatePath: candidate.Path, PlatformCommit: candidate.SourceCommit, PreviousPath: old.Path, CreatedAt: now, UpdatedAt: now, HealthTimeoutMS: 30000, BootID: "bridge-integration"}
	if err := persistActivationPlan(planPath, plan); err != nil {
		t.Fatal(err)
	}
	watchdog := profile.WatchdogUnitPrefix + bridgeIntegrationN[:12]
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if t.Failed() {
			output, _ := exec.CommandContext(cleanup, "journalctl", "--user", "--no-pager", "-n", "100", "-u", profile.ManagerUnit, "-u", watchdog+".service").CombinedOutput()
			t.Logf("isolated unit diagnostics:\n%s", output)
			for _, path := range []string{manager.StatePath, filepath.Join(stateDir, "state.json"), manager.bridgeHandoffPath(), manager.launcherPath()} {
				data, err := os.ReadFile(path)
				t.Logf("isolated durable state %s: %s (error=%v)", path, data, err)
			}
		}
		_ = exec.CommandContext(cleanup, "systemctl", "--user", "stop", profile.ManagerUnit+"-bridge-handoff.service", profile.ManagerUnit, watchdog+".service").Run()
		worker := profile.ManagerUnit + "-bridge-handoff.service"
		_ = exec.CommandContext(cleanup, "systemctl", "--user", "disable", worker).Run()
		_ = os.Remove(filepath.Join(filepath.Dir(unitPath), worker))
		_ = os.Remove(unitPath)
		_ = os.Remove(stable)
		_ = exec.CommandContext(cleanup, "systemctl", "--user", "daemon-reload").Run()
		_ = exec.CommandContext(cleanup, "systemctl", "--user", "reset-failed", profile.ManagerUnit, worker, watchdog+".service").Run()
	})
	bridgeIntegrationWrite(t, unitPath, []byte(fmt.Sprintf("[Unit]\nDescription=Isolated Manager bridge integration\n[Service]\nType=simple\nExecStart=%s serve --config %s\nRestart=on-failure\nRestartSec=1\nTimeoutStopSec=5\nNoNewPrivileges=true\n[Install]\nWantedBy=default.target\n", stable, configPath)), 0o600)
	bridgeIntegrationCommand(t, ctx, "", "systemctl", "--user", "daemon-reload")
	bridgeIntegrationCommand(t, ctx, "", "systemctl", "--user", "start", profile.ManagerUnit)
	initialPID := bridgeIntegrationIdentity(t, ctx, manager, old)
	bridgeIntegrationCatalogCheck(t, ctx, manager, stateDir)
	if err := atomicfile.WriteJSON(manager.StatePath, state, 0o600); err != nil {
		t.Fatal(err)
	}
	bridgeIntegrationCommand(t, ctx, "", "systemd-run", "--user", "--quiet", "--collect", "--unit="+watchdog, old.Path, "self-update-watchdog", "--plan", planPath, "--config", configPath)
	recoverySystemdIntegrationEventually(t, ctx, "genuine old watchdog ownership", func() (bool, error) {
		pid, err := recoverySystemdIntegrationPID(ctx, watchdog+".service")
		if err != nil || pid < 2 {
			return false, err
		}
		sha, err := fileSHA256(filepath.Join("/proc", strconv.Itoa(pid), "exe"))
		return sha == old.SHA256, err
	})
	data, err := os.ReadFile(candidate.Path)
	if err != nil {
		t.Fatal(err)
	}
	bridgeIntegrationWrite(t, stable, data, 0o700)
	plan.Activated, plan.Status = true, "activated"
	if err := persistActivationPlan(planPath, plan); err != nil {
		t.Fatal(err)
	}
	recoverySystemdIntegrationEventually(t, ctx, "old watchdog commit", func() (bool, error) {
		var durable Plan
		if err := atomicfile.ReadJSON(planPath, &durable); err != nil {
			return false, err
		}
		return durable.Status == "committed", nil
	})
	bridgePID := bridgeIntegrationIdentity(t, ctx, manager, candidate)
	if bridgePID == initialPID {
		t.Fatal("legacy activation did not replace old Manager process")
	}
	recoverySystemdIntegrationEventually(t, ctx, "automatic immutable launcher handoff", func() (bool, error) { return manager.LauncherEnabled() })
	recoverySystemdIntegrationEventually(t, ctx, "independent handoff worker durable proof", func() (bool, error) {
		var handoff bridgeHandoff
		if err := atomicfile.ReadJSON(manager.bridgeHandoffPath(), &handoff); err != nil {
			return false, err
		}
		return handoff.Status == "proven", nil
	})
	launcherPID, err := recoverySystemdIntegrationPID(ctx, profile.ManagerUnit)
	if err != nil {
		t.Fatal(err)
	}
	launcherSHA, err := fileSHA256(filepath.Join("/proc", strconv.Itoa(launcherPID), "exe"))
	if err != nil || launcherSHA != candidate.SHA256 {
		t.Fatalf("launcher executable SHA=%s error=%v", launcherSHA, err)
	}
	launcherPath, err := os.Readlink(filepath.Join("/proc", strconv.Itoa(launcherPID), "exe"))
	if err != nil || launcherPath == stable {
		t.Fatalf("launcher must be independent of stable: %s: %v", launcherPath, err)
	}
	load, err := recoverySystemdProperty(ctx, watchdog+".service", "LoadState")
	if err != nil || load != "not-found" {
		t.Fatalf("legacy watchdog still present: %s: %v", load, err)
	}
	t.Logf("old watchdog committed N; old PID=%d, immutable launcher PID=%d path=%s SHA=%s; handoff record proven", initialPID, launcherPID, launcherPath, launcherSHA)
	var checked model.ManagerState
	if err := atomicfile.ReadJSON(filepath.Join(stateDir, "state.json"), &checked); err != nil {
		t.Fatal(err)
	}
	if checked.Candidate == nil || checked.Candidate.ID != bridgeIntegrationNext {
		t.Fatalf("handoff discarded the checked release catalog candidate: %#v", checked.Candidate)
	}
	for _, phase := range []string{"prepared", "switching", "failed"} {
		scenario := "resume-handoff-" + phase
		if phase == "failed" {
			scenario = "explicit-retry-failed-handoff"
		}
		t.Run(scenario, func(t *testing.T) {
			bridgeIntegrationResumeHandoff(t, ctx, manager, unitPath, phase, candidate)
		})
	}
	for _, phase := range []string{"switching", "recovering"} {
		t.Run("boot-recovery-missing-launcher-"+phase, func(t *testing.T) {
			bridgeIntegrationMissingLauncherRecovery(t, ctx, manager, unitPath, phase, candidate)
		})
	}
	launcherPID, err = recoverySystemdIntegrationPID(ctx, profile.ManagerUnit)
	if err != nil {
		t.Fatal(err)
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
			manifest := releasetest.NewTarget(upgrade.version, releasetest.WithArtifactBaseURL(server.URL), releasetest.WithManagerBinary(runtime.GOARCH, payload)).Manifest
			if err := manager.Prepare(ctx, manifest); err != nil {
				t.Fatal(err)
			}
			if err := manager.MarkPlatformCommitted(manifest); err != nil {
				t.Fatal(err)
			}
			if err := manager.Activate(ctx, manifest); err != nil {
				t.Fatal(err)
			}
			want := upgrade.version
			if upgrade.fallback {
				want = bridgeIntegrationN
			}
			recoverySystemdIntegrationEventually(t, ctx, "bounded supervised selection "+want, func() (bool, error) {
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
			pid, err := recoverySystemdIntegrationPID(ctx, profile.ManagerUnit)
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
				after, err := recoverySystemdIntegrationPID(ctx, profile.ManagerUnit)
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
			} else if settled.Previous == nil || settled.Previous.Version != bridgeIntegrationN {
				t.Fatalf("successful update lost bridge fallback: %#v", settled.Previous)
			}
			manager.RunningVersion = want
			t.Logf("selected version=%s child PID=%d SHA=%s, same launcher PID=%d, fallback=%t", want, supervised.ChildPID, childSHA, pid, upgrade.fallback)
		})
	}
	bridgeIntegrationCommand(t, ctx, "", "systemctl", "--user", "restart", profile.ManagerUnit)
	recoverySystemdIntegrationEventually(t, ctx, "rejected selection remains rejected after service restart", func() (bool, error) {
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
	t.Run("committed-restart-pending-operation", func(t *testing.T) {
		bridgeIntegrationPendingRestart(t, ctx, manager, stateDir, *settled.Current)
	})
}

func bridgeIntegrationIdentity(t *testing.T, ctx context.Context, manager *Manager, version Version) int {
	t.Helper()
	client := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", manager.SocketPath)
	}}, Timeout: time.Second}
	defer client.CloseIdleConnections()
	var pid int
	recoverySystemdIntegrationEventually(t, ctx, "authenticated real Manager identity "+version.Version, func() (bool, error) {
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
		pid, err = recoverySystemdIntegrationPID(ctx, manager.UnitName)
		return pid > 1, err
	})
	return pid
}

func bridgeIntegrationVersion(t *testing.T, root, source, version string) Version {
	t.Helper()
	data, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "versions", version+"-"+version[:12], testTechnicalProfile.ManagerBinary)
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

// Recreate a durable crash checkpoint with the independent worker absent.
// This deliberately avoids timing a SIGKILL against a sub-millisecond write:
// every resumed process is real, but the interrupted record is seeded offline.
func bridgeIntegrationResumeHandoff(t *testing.T, ctx context.Context, manager *Manager, unitPath, phase string, selected Version) {
	t.Helper()
	ctx, cancel := context.WithTimeout(ctx, 35*time.Second)
	defer cancel()
	worker := manager.UnitName + "-bridge-handoff.service"
	recoverySystemdIntegrationEventually(t, ctx, "previous handoff worker exit", func() (bool, error) {
		return bridgeIntegrationWorkerStopped(ctx, worker)
	})
	bridgeIntegrationCommand(t, ctx, "", "systemctl", "--user", "stop", manager.UnitName)
	var handoff bridgeHandoff
	if err := atomicfile.ReadJSON(manager.bridgeHandoffPath(), &handoff); err != nil {
		t.Fatal(err)
	}
	handoff.Status = phase
	handoff.Error = ""
	if phase == "failed" {
		handoff.Error = "isolated failed handoff checkpoint"
	}
	if err := atomicfile.WriteJSON(manager.bridgeHandoffPath(), handoff, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := manager.mutateLauncher(func(state *launcherState) error {
		state.Proven = false
		state.Failed = phase == "failed"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	unit := handoff.Replacement
	if phase == "prepared" || phase == "failed" {
		unit = handoff.Original
	}
	bridgeIntegrationWrite(t, unitPath, unit, 0o600)
	bridgeIntegrationCommand(t, ctx, "", "systemctl", "--user", "daemon-reload")
	bridgeIntegrationCommand(t, ctx, "", "systemctl", "--user", "start", manager.UnitName)
	if phase == "failed" {
		stablePID := bridgeIntegrationIdentity(t, ctx, manager, selected)
		// Give normal startup reconciliation an opportunity to observe the
		// terminal record. It must not silently retry a failed switch.
		time.Sleep(6 * time.Second)
		var terminal bridgeHandoff
		if err := atomicfile.ReadJSON(manager.bridgeHandoffPath(), &terminal); err != nil {
			t.Fatal(err)
		}
		proven, err := manager.LauncherEnabled()
		if err != nil || proven || terminal.Status != "failed" {
			t.Fatalf("failed handoff retried without explicit authorization: %#v proven=%t: %v", terminal, proven, err)
		}
		pid, err := recoverySystemdIntegrationPID(ctx, manager.UnitName)
		if err != nil || pid != stablePID {
			t.Fatalf("failed handoff loops restored service: initial=%d final=%d: %v", stablePID, pid, err)
		}
		bridgeIntegrationCommand(t, ctx, "", manager.InstallPath, "bridge-handoff", "--retry", "--config", manager.ConfigPath)
	}
	recoverySystemdIntegrationEventually(t, ctx, "interrupted "+phase+" handoff to regain durable proof", func() (bool, error) {
		var resumed bridgeHandoff
		if err := atomicfile.ReadJSON(manager.bridgeHandoffPath(), &resumed); err != nil {
			return false, err
		}
		proven, err := manager.LauncherEnabled()
		return err == nil && proven && resumed.Status == "proven", err
	})
	pid := bridgeIntegrationIdentity(t, ctx, manager, selected)
	executable, err := os.Readlink(filepath.Join("/proc", strconv.Itoa(pid), "exe"))
	if err != nil || executable != filepath.Join(manager.Root, "launcher") {
		t.Fatalf("resumed handoff is not supervised: %s: %v", executable, err)
	}
	state, err := manager.readLauncher()
	if err != nil || !state.BootReady || state.Failed || state.ChildPID <= 1 {
		t.Fatalf("resumed child is not ready: %#v: %v", state, err)
	}
	digest, err := fileSHA256(filepath.Join("/proc", strconv.Itoa(state.ChildPID), "exe"))
	if err != nil || digest != selected.SHA256 {
		t.Fatalf("resumed child digest=%s, expected %s: %v", digest, selected.SHA256, err)
	}
	t.Logf("resumed %s handoff with worker initially absent: launcher=%d child=%d", phase, pid, state.ChildPID)
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
	recoverySystemdIntegrationEventually(t, ctx, "committed child readiness with an unfinished validating operation", func() (bool, error) {
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
	pid, err := recoverySystemdIntegrationPID(ctx, manager.UnitName)
	if err != nil || launcher.LauncherPID != pid || !launcher.BootReady || launcher.Failed {
		t.Fatalf("resumed operation lost live supervisor readiness: %#v MainPID=%d: %v", launcher, pid, err)
	}
	var persisted model.Operation
	if err := atomicfile.ReadJSON(filepath.Join(stateDir, "operations", operation.ID+".json"), &persisted); err != nil {
		t.Fatal(err)
	}
	if persisted.ID != operation.ID || persisted.IdempotencyKey != operation.IdempotencyKey || persisted.Phase != model.PhaseValidating || persisted.Status == model.OperationFailed {
		t.Fatalf("restart did not retain pending operation identity: %#v", persisted)
	}
	t.Logf("committed supervised Manager became ready and resumed original validating operation %s", operation.ID)
}

func bridgeIntegrationCatalogCheck(t *testing.T, ctx context.Context, manager *Manager, stateDir string) {
	t.Helper()
	var fixture releasetest.Fixture
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/manifest.json":
			_ = json.NewEncoder(w).Encode(fixture.Manifest)
		case "/agent-platform-compose.yaml":
			_, _ = w.Write(fixture.Compose)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	fixture = releasetest.NewTarget(bridgeIntegrationNext, releasetest.WithArtifactBaseURL(server.URL))
	body, err := json.Marshal(map[string]string{"idempotency_key": "bridge-catalog-before-handoff", "manifest_url": server.URL + "/manifest.json"})
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", manager.SocketPath)
	}}, Timeout: 10 * time.Second}
	defer client.CloseIdleConnections()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://manager/v1/check", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer bridge-integration-control-token")
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil || response.StatusCode != http.StatusOK {
		t.Fatalf("real legacy release check: status=%d body=%s: %v", response.StatusCode, data, err)
	}
	var state model.ManagerState
	if err := atomicfile.ReadJSON(filepath.Join(stateDir, "state.json"), &state); err != nil {
		t.Fatal(err)
	}
	if state.Candidate == nil || state.Candidate.ID != bridgeIntegrationNext || state.ActiveOperationID != "" || state.FinalizePendingOperationID != "" || state.Maintenance {
		t.Fatalf("release check did not publish an isolated catalog candidate: %#v", state)
	}
	t.Logf("actual legacy /v1/check persisted catalog-only candidate %s before N handoff", state.Candidate.ID)
}

// Start the enabled persistent recovery entrypoint with no surviving worker or
// main process, as at user-systemd boot. The replacement main executable is
// deliberately absent, so successful recovery cannot depend on its startup.
func bridgeIntegrationMissingLauncherRecovery(t *testing.T, ctx context.Context, manager *Manager, unitPath, phase string, selected Version) {
	t.Helper()
	ctx, cancel := context.WithTimeout(ctx, 35*time.Second)
	defer cancel()
	worker := manager.UnitName + "-bridge-handoff.service"
	recoverySystemdIntegrationEventually(t, ctx, "completed recovery worker exit", func() (bool, error) {
		return bridgeIntegrationWorkerStopped(ctx, worker)
	})
	bridgeIntegrationCommand(t, ctx, "", "systemctl", "--user", "stop", manager.UnitName)
	var handoff bridgeHandoff
	if err := atomicfile.ReadJSON(manager.bridgeHandoffPath(), &handoff); err != nil {
		t.Fatal(err)
	}
	handoff.Status, handoff.Error = phase, ""
	if err := atomicfile.WriteJSON(manager.bridgeHandoffPath(), handoff, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := manager.mutateLauncher(func(state *launcherState) error {
		state.Proven = false
		state.BootReady = false
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	bridgeIntegrationWrite(t, unitPath, handoff.Replacement, 0o600)
	launcherBytes, err := os.ReadFile(handoff.Launcher.Path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(handoff.Launcher.Path); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := os.Lstat(handoff.Launcher.Path); os.IsNotExist(err) {
			bridgeIntegrationWrite(t, handoff.Launcher.Path, launcherBytes, 0o700)
		}
	}()
	bridgeIntegrationCommand(t, ctx, "", "systemctl", "--user", "daemon-reload")
	bridgeIntegrationCommand(t, ctx, "", "systemctl", "--user", "enable", worker)
	bridgeIntegrationCommand(t, ctx, "", "systemctl", "--user", "is-enabled", worker)
	bridgeIntegrationCommand(t, ctx, "", "systemctl", "--user", "start", worker)
	recoverySystemdIntegrationEventually(t, ctx, "independent stable bridge recovery of "+phase+" with absent launcher", func() (bool, error) {
		var recovered bridgeHandoff
		if err := atomicfile.ReadJSON(manager.bridgeHandoffPath(), &recovered); err != nil {
			return false, err
		}
		return recovered.Status == "failed", nil
	})
	pid := bridgeIntegrationIdentity(t, ctx, manager, selected)
	executable, err := os.Readlink(filepath.Join("/proc", strconv.Itoa(pid), "exe"))
	if err != nil || executable != manager.InstallPath {
		t.Fatalf("missing-launcher recovery did not restore stable service: %s: %v", executable, err)
	}
	actualUnit, err := os.ReadFile(unitPath)
	if err != nil || !bytes.Equal(actualUnit, handoff.Original) {
		t.Fatalf("missing-launcher recovery did not restore saved unit: %v", err)
	}
	if _, err := os.Lstat(handoff.Launcher.Path); !os.IsNotExist(err) {
		t.Fatalf("recovery unexpectedly required or replaced absent launcher: %v", err)
	}
	recoverySystemdIntegrationEventually(t, ctx, "independent recovery worker to finish", func() (bool, error) {
		return bridgeIntegrationWorkerStopped(ctx, worker)
	})
	t.Logf("enabled persistent worker restored stable PID=%d from %s with launcher absent", pid, phase)
	// Repair the deliberately removed fixture artifact, then use the real
	// operator retry command to leave a proven supervisor for later scenarios.
	bridgeIntegrationWrite(t, handoff.Launcher.Path, launcherBytes, 0o700)
	bridgeIntegrationCommand(t, ctx, "", manager.InstallPath, "bridge-handoff", "--retry", "--config", manager.ConfigPath)
	recoverySystemdIntegrationEventually(t, ctx, "proof after repairing missing fixture launcher", func() (bool, error) {
		return manager.LauncherEnabled()
	})
}

func bridgeIntegrationWorkerStopped(ctx context.Context, unit string) (bool, error) {
	active, err := recoverySystemdProperty(ctx, unit, "ActiveState")
	if err != nil || (active != "inactive" && active != "failed") {
		return false, err
	}
	pid, err := recoverySystemdIntegrationPID(ctx, unit)
	return pid == 0, err
}
