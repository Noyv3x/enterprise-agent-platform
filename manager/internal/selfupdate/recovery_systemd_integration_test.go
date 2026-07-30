package selfupdate

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/atomicfile"
)

const recoverySystemdIntegrationEnvironment = "UBITECH_SYSTEMD_INTEGRATION"
const recoverySystemdIntegrationHelperEnvironment = "UBITECH_SYSTEMD_INTEGRATION_HELPER"
const ordinarySystemdIntegrationMainEnvironment = "UBITECH_SYSTEMD_ACTIVATION_MAIN_HELPER"
const ordinarySystemdIntegrationWatchdogEnvironment = "UBITECH_SYSTEMD_ACTIVATION_WATCHDOG_HELPER"

func init() {
	if os.Getenv(ordinarySystemdIntegrationWatchdogEnvironment) == "1" {
		if len(os.Args) != 4 || os.Args[1] != "self-update-watchdog" || os.Args[2] != "--plan" || !filepath.IsAbs(os.Args[3]) {
			_, _ = fmt.Fprintf(os.Stderr, "invalid ordinary integration watchdog argv: %q\n", os.Args)
			os.Exit(2)
		}
		if err := RunWatchdog(context.Background(), os.Args[3], nil); err != nil {
			_, _ = fmt.Fprintf(os.Stderr, "ordinary integration watchdog failed: %v\n", err)
			os.Exit(2)
		}
		os.Exit(0)
	}
	if os.Getenv(ordinarySystemdIntegrationMainEnvironment) == "1" {
		if err := runOrdinarySystemdIntegrationMain(); err != nil {
			_, _ = fmt.Fprintf(os.Stderr, "ordinary integration Manager failed: %v\n", err)
			os.Exit(2)
		}
		os.Exit(0)
	}
	if os.Getenv(recoverySystemdIntegrationHelperEnvironment) != "1" {
		return
	}
	if len(os.Args) != 4 || os.Args[1] != "self-update-watchdog" || os.Args[2] != "--plan" || !filepath.IsAbs(os.Args[3]) {
		_, _ = fmt.Fprintf(os.Stderr, "invalid re-executed integration watchdog argv: %q\n", os.Args)
		os.Exit(2)
	}
	if _, err := os.Stat(os.Args[3]); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "stat re-executed integration activation plan: %v\n", err)
		os.Exit(2)
	}
	for {
		time.Sleep(time.Second)
	}
}

func runOrdinarySystemdIntegrationMain() error {
	planPath := os.Getenv("UBITECH_SYSTEMD_ACTIVATION_PLAN")
	markerPath := os.Getenv("UBITECH_SYSTEMD_ACTIVATION_MARKER")
	if !filepath.IsAbs(planPath) || !filepath.IsAbs(markerPath) {
		return fmt.Errorf("ordinary integration paths must be absolute: plan=%q marker=%q", planPath, markerPath)
	}
	var plan Plan
	if err := atomicfile.ReadJSON(planPath, &plan); err != nil {
		return fmt.Errorf("read ordinary integration plan: %w", err)
	}
	var state State
	if err := atomicfile.ReadJSON(plan.StatePath, &state); err != nil {
		return fmt.Errorf("read ordinary integration state: %w", err)
	}
	executableSHA, err := fileSHA256("/proc/self/exe")
	if err != nil {
		return fmt.Errorf("hash ordinary integration executable: %w", err)
	}
	version := ""
	if executableSHA == plan.CandidateSHA {
		version = plan.CandidateVersion
	} else if state.Current != nil && executableSHA == state.Current.SHA256 {
		version = state.Current.Version
	}
	if version == "" {
		return fmt.Errorf("ordinary integration executable %s is neither Current nor Candidate", executableSHA)
	}
	token, err := readRecoveryControlToken(plan.ControlTokenFile)
	if err != nil {
		return err
	}
	if err := os.Remove(plan.SocketPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove stale ordinary integration socket: %w", err)
	}
	listener, err := net.Listen("unix", plan.SocketPath)
	if err != nil {
		return fmt.Errorf("listen on ordinary integration socket: %w", err)
	}
	defer listener.Close()
	if err := os.Chmod(plan.SocketPath, 0o600); err != nil {
		return fmt.Errorf("protect ordinary integration socket: %w", err)
	}
	marker, err := os.OpenFile(markerPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("open ordinary integration start marker: %w", err)
	}
	if _, err := fmt.Fprintf(marker, "%d %s\n", os.Getpid(), executableSHA); err != nil {
		_ = marker.Close()
		return fmt.Errorf("record ordinary integration start: %w", err)
	}
	if err := marker.Sync(); err != nil {
		_ = marker.Close()
		return fmt.Errorf("sync ordinary integration start: %w", err)
	}
	if err := marker.Close(); err != nil {
		return fmt.Errorf("close ordinary integration start marker: %w", err)
	}

	handler := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		if request.Method != http.MethodGet || request.URL.Path != "/v1/identity" || request.Header.Get("Authorization") != "Bearer "+token {
			response.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(response).Encode(map[string]string{
			"status": "healthy", "version": version, "sha256": executableSHA,
		})
	})
	server := &http.Server{Handler: handler, ReadHeaderTimeout: time.Second}
	serveError := make(chan error, 1)
	go func() { serveError <- server.Serve(listener) }()

	if executableSHA == plan.CandidateSHA {
		// Leave a visible interval in which the candidate MainPID is running while
		// the independent watchdog remains alive. The integration assertion uses
		// this interval to prove cgroup separation, not merely eventual success.
		time.Sleep(1500 * time.Millisecond)
		manager := &Manager{
			Root: filepath.Dir(filepath.Dir(plan.PlanPath)), StatePath: plan.StatePath,
			InstallPath: plan.InstallPath, SocketPath: plan.SocketPath,
			ControlTokenFile: plan.ControlTokenFile, UnitName: plan.UnitName,
			RunningVersion: plan.CandidateVersion,
		}
		if err := manager.acknowledgeExecutable("/proc/self/exe"); err != nil {
			return fmt.Errorf("acknowledge ordinary integration candidate: %w", err)
		}
	}
	if err := <-serveError; err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

func TestRecoverySystemdQuiescenceIntegration(t *testing.T) {
	if os.Getenv(recoverySystemdIntegrationEnvironment) != "1" {
		t.Skip("set UBITECH_SYSTEMD_INTEGRATION=1 to run the user-systemd integration test")
	}
	if _, err := exec.LookPath("systemctl"); err != nil {
		t.Fatalf("systemctl is unavailable while the systemd integration gate is required: %v", err)
	}
	if _, err := exec.LookPath("systemd-run"); err != nil {
		t.Fatalf("systemd-run is unavailable while the systemd integration gate is required: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if output, err := exec.CommandContext(ctx, "systemctl", "--user", "show-environment").CombinedOutput(); err != nil {
		t.Fatalf("user systemd is unavailable while the integration gate is required: %v: %s", err, strings.TrimSpace(string(output)))
	}

	// This test deliberately refuses to run alongside any real Manager watchdog.
	// The production inventory check would reject it too; the opt-in gate fails
	// without touching an existing product unit rather than silently passing.
	if units, err := recoverySystemdIntegrationWatchdogUnits(ctx); err != nil {
		t.Fatalf("inventory Manager watchdog units before integration test: %v", err)
	} else if len(units) != 0 {
		t.Fatalf("existing Manager watchdog units make the required isolated integration test unsafe: %v", units)
	}

	suffix := recoverySystemdIntegrationSuffix(t)
	unitBase := recoveryWatchdogUnitPrefix + "integration-" + suffix
	unit := unitBase + ".service"
	mainUnit := "ubitech-agent-manager-integration-main-" + suffix + ".service"
	if loadState, err := recoverySystemdProperty(ctx, unit, "LoadState"); err != nil {
		t.Fatalf("inspect prospective integration unit: %v", err)
	} else if loadState != "not-found" {
		t.Fatalf("collision-resistant integration unit already exists: %s load=%s", unit, loadState)
	}
	if loadState, err := recoverySystemdProperty(ctx, mainUnit, "LoadState"); err != nil {
		t.Fatalf("inspect prospective nonexistent main unit: %v", err)
	} else if loadState != "not-found" {
		t.Fatalf("collision-resistant main unit unexpectedly exists: %s load=%s", mainUnit, loadState)
	}

	planPath := filepath.Join(t.TempDir(), "activation-plan.json")
	if err := os.WriteFile(planPath, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	// Cleanup is intentionally scoped to the exact collision-resistant unit. It
	// never resets, stops, reloads, or otherwise addresses a product unit.
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_ = exec.CommandContext(cleanupCtx, "systemctl", "--user", "stop", unit).Run()
	})

	start := exec.CommandContext(
		ctx,
		"systemd-run", "--user", "--quiet", "--collect", "--unit", unitBase,
		"--property=Type=exec",
		os.Args[0], "-test.run=^TestRecoverySystemdWatchdogHelperProcess$", "--",
		"self-update-watchdog", "--plan", planPath,
	)
	if output, err := start.CombinedOutput(); err != nil {
		t.Fatalf("start exact integration watchdog %s: %v: %s", unit, err, strings.TrimSpace(string(output)))
	}

	var mainPID int
	recoverySystemdIntegrationEventually(t, ctx, "integration watchdog to become active", func() (bool, error) {
		active, err := recoverySystemdProperty(ctx, unit, "ActiveState")
		if err != nil {
			return false, err
		}
		pidText, err := recoverySystemdProperty(ctx, unit, "MainPID")
		if err != nil {
			return false, err
		}
		pid, err := strconv.Atoi(pidText)
		if err != nil {
			return false, fmt.Errorf("parse integration watchdog MainPID %q: %w", pidText, err)
		}
		if active == "active" && pid > 1 {
			mainPID = pid
			return true, nil
		}
		return false, nil
	})

	units, err := recoverySystemdIntegrationWatchdogUnits(ctx)
	if err != nil {
		t.Fatalf("inventory active integration watchdog: %v", err)
	}
	if len(units) != 1 || units[0] != unit {
		t.Fatalf("watchdog inventory = %v, want only %s", units, unit)
	}
	recoverySystemdIntegrationEventually(t, ctx, "integration watchdog to re-exec with exact production argv", func() (bool, error) {
		processPID, found, err := recoveryWatchdogProcess(planPath)
		if err != nil {
			return false, err
		}
		return found && processPID == mainPID, nil
	})

	manager := &Manager{}
	if err := manager.quiesceRecoveryUnits(ctx, mainUnit, []string{unitBase}, planPath); err != nil {
		t.Fatalf("quiesce exact integration watchdog: %v", err)
	}

	recoverySystemdIntegrationEventually(t, ctx, "integration watchdog to be collected", func() (bool, error) {
		load, err := recoverySystemdProperty(ctx, unit, "LoadState")
		if err != nil {
			return false, err
		}
		active, err := recoverySystemdProperty(ctx, unit, "ActiveState")
		if err != nil {
			return false, err
		}
		pidText, err := recoverySystemdProperty(ctx, unit, "MainPID")
		if err != nil {
			return false, err
		}
		pid, err := strconv.Atoi(pidText)
		if err != nil {
			return false, fmt.Errorf("parse quiesced integration watchdog MainPID %q: %w", pidText, err)
		}
		return load == "not-found" && active == "inactive" && pid == 0, nil
	})
	if pid, found, err := recoveryWatchdogProcess(planPath); err != nil {
		t.Fatalf("inspect quiesced same-plan process: %v", err)
	} else if found {
		t.Fatalf("same-plan watchdog process %d survived quiescence", pid)
	}
}

func TestOrdinarySystemdActivationRestartIntegration(t *testing.T) {
	if os.Getenv(recoverySystemdIntegrationEnvironment) != "1" {
		t.Skip("set UBITECH_SYSTEMD_INTEGRATION=1 to run the user-systemd integration test")
	}
	if _, err := exec.LookPath("systemctl"); err != nil {
		t.Fatalf("systemctl is unavailable while the systemd integration gate is required: %v", err)
	}
	if _, err := exec.LookPath("systemd-run"); err != nil {
		t.Fatalf("systemd-run is unavailable while the systemd integration gate is required: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	if output, err := exec.CommandContext(ctx, "systemctl", "--user", "show-environment").CombinedOutput(); err != nil {
		t.Fatalf("user systemd is unavailable while the integration gate is required: %v: %s", err, strings.TrimSpace(string(output)))
	}
	if units, err := recoverySystemdIntegrationWatchdogUnits(ctx); err != nil {
		t.Fatalf("inventory Manager watchdog units before activation integration test: %v", err)
	} else if len(units) != 0 {
		t.Fatalf("existing Manager watchdog units make the required isolated integration test unsafe: %v", units)
	}

	suffix := recoverySystemdIntegrationSuffix(t)
	platformCommit := sha256Hex([]byte("ordinary-systemd-integration-" + suffix))[:40]
	watchdogBase := recoveryWatchdogUnitPrefix + platformCommit[:12]
	watchdogUnit := watchdogBase + ".service"
	mainBase := "ubitech-agent-manager-integration-main-" + suffix
	mainUnit := mainBase + ".service"
	for _, unit := range []string{watchdogUnit, mainUnit} {
		load, err := recoverySystemdProperty(ctx, unit, "LoadState")
		if err != nil {
			t.Fatalf("inspect prospective integration unit %s: %v", unit, err)
		}
		if load != "not-found" {
			t.Fatalf("collision-resistant integration unit already exists: %s load=%s", unit, load)
		}
	}
	root := t.TempDir()
	// Register unit cleanup after t.TempDir so LIFO cleanup stops every process
	// before the temporary executable and state tree are removed.
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_ = exec.CommandContext(cleanupCtx, "systemctl", "--user", "stop", watchdogUnit).Run()
		_ = exec.CommandContext(cleanupCtx, "systemctl", "--user", "stop", mainUnit).Run()
	})
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	versionsRoot := filepath.Join(root, "versions")
	activationsRoot := filepath.Join(root, "activations")
	controlRoot := filepath.Join(root, "control")
	for _, directory := range []string{versionsRoot, activationsRoot, controlRoot} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	testExecutable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	executableData, err := os.ReadFile(testExecutable)
	if err != nil {
		t.Fatal(err)
	}
	currentPath := filepath.Join(versionsRoot, "current-manager")
	candidatePath := filepath.Join(versionsRoot, "candidate-manager")
	installPath := filepath.Join(root, "ubitech-manager")
	if err := atomicfile.WriteFile(currentPath, executableData, 0o700); err != nil {
		t.Fatal(err)
	}
	candidateData := append(append([]byte(nil), executableData...), []byte("\nUBITECH-ORDINARY-SYSTEMD-CANDIDATE-"+suffix+"\n")...)
	if err := atomicfile.WriteFile(candidatePath, candidateData, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := atomicfile.WriteFile(installPath, executableData, 0o755); err != nil {
		t.Fatal(err)
	}
	currentSHA := sha256Hex(executableData)
	candidateSHA := sha256Hex(candidateData)
	if currentSHA == candidateSHA {
		t.Fatal("ordinary integration Current and Candidate checksums unexpectedly match")
	}
	currentVersion := strings.Repeat("1", 40)
	controlToken := strings.Repeat("integration-token-", 4)
	tokenPath := filepath.Join(root, "manager-token")
	if err := os.WriteFile(tokenPath, []byte(controlToken+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(root, "manager-binaries.json")
	planPath := filepath.Join(activationsRoot, platformCommit+".json")
	socketPath := filepath.Join(controlRoot, "manager.sock")
	markerPath := filepath.Join(root, "manager-starts.log")
	now := time.Now().UTC()
	state := State{
		SchemaVersion: 1,
		Current: &Version{
			Version: currentVersion, SourceCommit: currentVersion, Path: currentPath,
			SHA256: currentSHA, VerifiedAt: now, PlatformCommitted: true,
		},
		Candidate: &Version{
			Version: platformCommit, SourceCommit: platformCommit, Path: candidatePath,
			SHA256: candidateSHA, VerifiedAt: now, PlatformCommitted: true,
		},
		Activation: &Activation{
			PlanPath: planPath, CandidateSHA: candidateSHA, CandidatePath: candidatePath, StartedAt: now,
		},
		UpdatedAt: now,
	}
	plan := Plan{
		SchemaVersion: 1, PlanPath: planPath, Status: "prepared", StatePath: statePath,
		InstallPath: installPath, SocketPath: socketPath, ControlTokenFile: tokenPath,
		UnitName: mainUnit, CandidateVersion: platformCommit, CandidateSHA: candidateSHA,
		CandidatePath: candidatePath, PlatformCommit: platformCommit, PreviousPath: currentPath,
		CreatedAt: now, UpdatedAt: now, HealthTimeoutMS: 15_000, BootID: "integration-boot",
	}
	if err := atomicfile.WriteJSON(statePath, state, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := persistActivationPlan(planPath, plan); err != nil {
		t.Fatal(err)
	}

	mainStart := exec.CommandContext(
		ctx,
		"systemd-run", "--user", "--quiet", "--collect", "--unit", mainBase,
		"--property=Type=exec", "--property=TimeoutStopSec=5s",
		"--setenv="+ordinarySystemdIntegrationMainEnvironment+"=1",
		"--setenv=UBITECH_SYSTEMD_ACTIVATION_PLAN="+planPath,
		"--setenv=UBITECH_SYSTEMD_ACTIVATION_MARKER="+markerPath,
		installPath,
	)
	if output, err := mainStart.CombinedOutput(); err != nil {
		t.Fatalf("start ordinary integration Manager unit: %v: %s", err, strings.TrimSpace(string(output)))
	}
	var initialMainPID int
	recoverySystemdIntegrationEventually(t, ctx, "initial Current Manager to become active", func() (bool, error) {
		active, err := recoverySystemdProperty(ctx, mainUnit, "ActiveState")
		if err != nil {
			return false, err
		}
		pid, err := recoverySystemdIntegrationPID(ctx, mainUnit)
		if err != nil {
			return false, err
		}
		starts, err := recoverySystemdIntegrationStarts(markerPath)
		if err != nil {
			return false, err
		}
		if active == "active" && pid > 1 && len(starts) == 1 && starts[0].sha == currentSHA {
			initialMainPID = pid
			return true, nil
		}
		return false, nil
	})

	watchdogStart := exec.CommandContext(
		ctx,
		"systemd-run", "--user", "--quiet", "--collect", "--unit", watchdogBase,
		"--property=Type=exec",
		"--setenv="+ordinarySystemdIntegrationWatchdogEnvironment+"=1",
		currentPath, "self-update-watchdog", "--plan", planPath,
	)
	if output, err := watchdogStart.CombinedOutput(); err != nil {
		t.Fatalf("start ordinary integration watchdog: %v: %s", err, strings.TrimSpace(string(output)))
	}
	manager := &Manager{}
	recoverySystemdIntegrationEventually(t, ctx, "ordinary integration watchdog ownership", func() (bool, error) {
		active, err := recoverySystemdProperty(ctx, watchdogUnit, "ActiveState")
		if err != nil || active != "active" {
			return false, err
		}
		if err := manager.verifyOrdinaryWatchdogProcess(ctx, watchdogBase, currentPath, currentSHA, planPath); err != nil {
			return false, nil
		}
		return true, nil
	})

	if err := atomicfile.WriteFile(installPath, candidateData, 0o755); err != nil {
		t.Fatal(err)
	}
	plan.Activated = true
	plan.Status = "activated"
	plan.UpdatedAt = time.Now().UTC()
	if err := persistActivationPlan(planPath, plan); err != nil {
		t.Fatal(err)
	}

	var candidateMainPID int
	recoverySystemdIntegrationEventually(t, ctx, "watchdog-driven candidate Manager restart", func() (bool, error) {
		pid, err := recoverySystemdIntegrationPID(ctx, mainUnit)
		if err != nil {
			return false, err
		}
		if pid <= 1 || pid == initialMainPID {
			return false, nil
		}
		processSHA, err := fileSHA256(filepath.Join("/proc", strconv.Itoa(pid), "exe"))
		if err != nil || processSHA != candidateSHA {
			return false, nil
		}
		watchdogActive, err := recoverySystemdProperty(ctx, watchdogUnit, "ActiveState")
		if err != nil || watchdogActive != "active" {
			return false, err
		}
		candidateMainPID = pid
		return true, nil
	})
	if candidateMainPID == 0 {
		t.Fatal("candidate Manager PID was not observed")
	}

	recoverySystemdIntegrationEventually(t, ctx, "ordinary activation commit and watchdog collection", func() (bool, error) {
		var durablePlan Plan
		if err := atomicfile.ReadJSON(planPath, &durablePlan); err != nil {
			return false, err
		}
		var durableState State
		if err := atomicfile.ReadJSON(statePath, &durableState); err != nil {
			return false, err
		}
		load, err := recoverySystemdProperty(ctx, watchdogUnit, "LoadState")
		if err != nil {
			return false, err
		}
		committed := durablePlan.Status == "committed" && durableState.Current != nil &&
			durableState.Current.SHA256 == candidateSHA && durableState.Candidate == nil && durableState.Activation == nil
		return committed && load == "not-found", nil
	})
	time.Sleep(500 * time.Millisecond)
	starts, err := recoverySystemdIntegrationStarts(markerPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(starts) != 2 || starts[0].sha != currentSHA || starts[1].sha != candidateSHA {
		t.Fatalf("Manager starts = %#v, want exactly Current then Candidate", starts)
	}
	if pid, err := recoverySystemdIntegrationPID(ctx, mainUnit); err != nil {
		t.Fatal(err)
	} else if pid != candidateMainPID {
		t.Fatalf("candidate Manager restarted more than once: observed=%d final=%d", candidateMainPID, pid)
	}
	if output, err := exec.CommandContext(ctx, "systemctl", "--user", "stop", mainUnit).CombinedOutput(); err != nil {
		t.Fatalf("stop exact ordinary integration Manager unit: %v: %s", err, strings.TrimSpace(string(output)))
	}
	recoverySystemdIntegrationEventually(t, ctx, "ordinary integration Manager unit to be collected", func() (bool, error) {
		load, err := recoverySystemdProperty(ctx, mainUnit, "LoadState")
		return load == "not-found", err
	})
}

func TestRecoverySystemdWatchdogHelperProcess(t *testing.T) {
	separator := -1
	for index, argument := range os.Args {
		if argument == "--" {
			separator = index
			break
		}
	}
	if separator < 0 {
		t.Skip("integration helper is only run as a transient user-systemd service")
	}
	arguments := os.Args[separator+1:]
	if len(arguments) != 3 || arguments[0] != "self-update-watchdog" || arguments[1] != "--plan" || !filepath.IsAbs(arguments[2]) {
		t.Fatalf("invalid integration helper arguments: %q", arguments)
	}
	if _, err := os.Stat(arguments[2]); err != nil {
		t.Fatalf("stat integration activation plan: %v", err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatalf("resolve integration test executable: %v", err)
	}
	environment := append(os.Environ(), recoverySystemdIntegrationHelperEnvironment+"=1")
	if err := syscall.Exec(
		executable,
		[]string{executable, "self-update-watchdog", "--plan", arguments[2]},
		environment,
	); err != nil {
		t.Fatalf("re-exec integration watchdog with production argv: %v", err)
	}
}

func recoverySystemdIntegrationWatchdogUnits(ctx context.Context) ([]string, error) {
	output, err := exec.CommandContext(
		ctx,
		"systemctl", "--user", "list-units", "--all", "--plain", "--no-legend", "--full",
		recoveryWatchdogUnitPrefix+"*",
	).CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("list user-systemd Manager watchdog units: %w: %s", err, strings.TrimSpace(string(output)))
	}
	var units []string
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 0 {
			units = append(units, fields[0])
		}
	}
	return units, nil
}

func recoverySystemdIntegrationSuffix(t *testing.T) string {
	t.Helper()
	value := make([]byte, 12)
	if _, err := rand.Read(value); err != nil {
		t.Fatalf("generate collision-resistant systemd unit suffix: %v", err)
	}
	return fmt.Sprintf("%d-%s", os.Getpid(), hex.EncodeToString(value))
}

type recoverySystemdIntegrationStart struct {
	pid int
	sha string
}

func recoverySystemdIntegrationPID(ctx context.Context, unit string) (int, error) {
	value, err := recoverySystemdProperty(ctx, unit, "MainPID")
	if err != nil {
		return 0, err
	}
	pid, err := strconv.Atoi(value)
	if err != nil {
		return 0, fmt.Errorf("parse %s MainPID %q: %w", unit, value, err)
	}
	return pid, nil
}

func recoverySystemdIntegrationStarts(path string) ([]recoverySystemdIntegrationStart, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var starts []recoverySystemdIntegrationStart
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 2 || !validSHA256(fields[1]) {
			return nil, fmt.Errorf("invalid ordinary integration start marker %q", line)
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil || pid <= 1 {
			return nil, fmt.Errorf("invalid ordinary integration start PID %q", fields[0])
		}
		starts = append(starts, recoverySystemdIntegrationStart{pid: pid, sha: fields[1]})
	}
	return starts, nil
}

func recoverySystemdIntegrationEventually(t *testing.T, ctx context.Context, description string, check func() (bool, error)) {
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
