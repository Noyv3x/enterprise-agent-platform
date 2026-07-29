package selfupdate

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

const recoverySystemdIntegrationEnvironment = "UBITECH_SYSTEMD_INTEGRATION"
const recoverySystemdIntegrationHelperEnvironment = "UBITECH_SYSTEMD_INTEGRATION_HELPER"

func init() {
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

func TestRecoverySystemdQuiescenceIntegration(t *testing.T) {
	if os.Getenv(recoverySystemdIntegrationEnvironment) != "1" {
		t.Skip("set UBITECH_SYSTEMD_INTEGRATION=1 to run the user-systemd integration test")
	}
	if _, err := exec.LookPath("systemctl"); err != nil {
		t.Skipf("systemctl is unavailable: %v", err)
	}
	if _, err := exec.LookPath("systemd-run"); err != nil {
		t.Skipf("systemd-run is unavailable: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if output, err := exec.CommandContext(ctx, "systemctl", "--user", "show-environment").CombinedOutput(); err != nil {
		t.Skipf("user systemd is unavailable: %v: %s", err, strings.TrimSpace(string(output)))
	}

	// This test deliberately refuses to run alongside any real Manager watchdog.
	// The production inventory check would reject it too, but skipping here proves
	// that the test cannot stop an existing product unit before reaching that check.
	if units, err := recoverySystemdIntegrationWatchdogUnits(ctx); err != nil {
		t.Fatalf("inventory Manager watchdog units before integration test: %v", err)
	} else if len(units) != 0 {
		t.Skipf("existing Manager watchdog units make an isolated integration test unsafe: %v", units)
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
