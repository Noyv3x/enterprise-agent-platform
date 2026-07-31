//go:build linux

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/config"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

const (
	startupSourceGeneration = "1111111111111111111111111111111111111111"
	startupTargetGeneration = "2222222222222222222222222222222222222222"
	startupTestSHA          = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
)

// This is the post-commit reboot/CLI hard gate.  The supplied config is a
// target config that SourceActiveProfile cannot validate.  Routing must open
// the neutral journal first, select target, and only then load the config.
func TestCommittedTargetStartupRoutesBeforeProfileConfigLoad(t *testing.T) {
	if targetConfigPath := os.Getenv("AGENT_PLATFORM_TARGET_STARTUP_TEST_CONFIG"); targetConfigPath != "" {
		targetActive, err := identity.ActivateVerifiedHandoffTarget(identity.TargetProfile())
		if err != nil {
			t.Fatal(err)
		}
		startup, err := resolveInvocationStartupWithConfig(context.Background(), "", targetConfigPath)
		if err != nil {
			t.Fatalf("committed target serve/CLI route failed: %v", err)
		}
		if startup.activeProfile() != targetActive || startup.decision.Paths.ConfigPath != targetConfigPath ||
			startup.stateHome != os.Getenv("AGENT_PLATFORM_TARGET_STARTUP_TEST_STATE_HOME") {
			t.Fatalf("unexpected committed target route: %+v", startup)
		}
		expectedStable := os.Getenv("AGENT_PLATFORM_TARGET_STARTUP_TEST_STABLE")
		if expectedStable == "" || startup.selectedStableBinary() != expectedStable {
			t.Fatalf("committed target stable route = %q, want %q", startup.selectedStableBinary(), expectedStable)
		}
		if ambient := managerInstallPath(targetActive); ambient == expectedStable {
			t.Fatalf("test did not separate journal stable %q from ambient XDG_BIN_HOME", expectedStable)
		}
		manager, err := routedSelfUpdateManager(targetActive, startup.configuration, startup.selectedStableBinary())
		if err != nil || manager.InstallPath != expectedStable {
			t.Fatalf("serve self-update ownership lost routed stable: manager=%+v err=%v", manager, err)
		}
		if routed, err := bindInvocationConfig([]string{"--config", targetConfigPath}, startup); err != nil || len(routed) != 2 {
			t.Fatalf("target CLI config binding failed: %v %v", routed, err)
		}
		authority, err := resolveInvocationAuthorityWithConfig(context.Background(), targetConfigPath)
		if err != nil || authority.activeProfile() != targetActive {
			t.Fatalf("target watchdog/recover authority route failed: %+v %v", authority, err)
		}
		if _, err := bindInvocationConfig([]string{"--plan", os.Getenv("AGENT_PLATFORM_TARGET_STARTUP_TEST_PLAN"), "--config", targetConfigPath}, authority); err != nil {
			t.Fatalf("target watchdog config binding failed: %v", err)
		}
		if _, err := bindRequiredInvocationConfig([]string{"--config", targetConfigPath, "--yes"}, authority); err != nil {
			t.Fatalf("target recover-current config binding failed: %v", err)
		}
		return
	}
	root := t.TempDir()
	binHome := filepath.Join(root, "bin")
	journalBinHome := filepath.Join(root, "journal-bin")
	configHome := filepath.Join(root, "config")
	dataHome := filepath.Join(root, "data")
	stateHome := filepath.Join(root, "custom-state")
	runtimeHome := filepath.Join(root, "runtime")
	for _, path := range []string{binHome, journalBinHome, configHome, dataHome, stateHome, runtimeHome} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("XDG_BIN_HOME", binHome)
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("XDG_DATA_HOME", dataHome)
	t.Setenv("XDG_STATE_HOME", filepath.Join(root, "ambient-state-must-not-select"))
	t.Setenv("XDG_RUNTIME_DIR", runtimeHome)

	sourceProfile := identity.SourceProfile()
	targetProfile := identity.TargetProfile()
	sourceActive := identity.SourceActiveProfile()
	targetActive, err := identity.ActivateVerifiedHandoffTarget(targetProfile)
	if err != nil {
		t.Fatal(err)
	}
	sourceRoot := sourceProfile.DefaultDataRoot(dataHome)
	targetRoot := targetProfile.DefaultDataRoot(dataHome)
	for _, path := range []string{
		sourceRoot, targetRoot, sourceProfile.ManagerStateRoot(sourceRoot), targetProfile.ManagerStateRoot(targetRoot),
		filepath.Dir(filepath.Join(sourceRoot, filepath.FromSlash(sourceProfile.DataRootSocketPath))),
		filepath.Join(runtimeHome, filepath.Dir(filepath.FromSlash(targetProfile.RuntimeSocketPath))),
		filepath.Join(configHome, targetProfile.ConfigDirectory), filepath.Join(configHome, "systemd", "user"),
	} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}

	sourceConfigPath := filepath.Join(root, "arbitrary-source-config.toml")
	sourceConfigBody := "data_root = " + strconvQuote(sourceRoot) + "\nstate_home = " + strconvQuote(stateHome) + "\n"
	if err := os.WriteFile(sourceConfigPath, []byte(sourceConfigBody), 0o600); err != nil {
		t.Fatal(err)
	}
	sourceConfig, err := config.Load(sourceActive, sourceConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	targetConfigPath := targetProfile.DefaultConfigPath(configHome)
	targetSocket := filepath.Join(runtimeHome, filepath.FromSlash(targetProfile.RuntimeSocketPath))
	targetConfig, err := config.DeriveHandoffTarget(sourceConfig, targetActive, targetConfigPath, targetRoot, targetSocket)
	if err != nil {
		t.Fatal(err)
	}
	targetConfigBytes, err := config.RenderHandoffTarget(targetConfig)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(targetConfigPath, targetConfigBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	targetConfigDigest := sha256.Sum256(targetConfigBytes)

	targetStable := targetProfile.ManagerInstallPath(journalBinHome)
	if targetStable == managerInstallPath(targetActive) {
		t.Fatal("target journal stable fixture unexpectedly equals ambient Manager path")
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	executableBytes, err := os.ReadFile(executable)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(targetStable, executableBytes, 0o700); err != nil {
		t.Fatalf("copy test executable as target stable Manager: %v", err)
	}
	sourceStable := managerInstallPath(sourceActive)
	if err := os.WriteFile(sourceStable, []byte("retired source manager"), 0o700); err != nil {
		t.Fatal(err)
	}
	targetSHA := testFileSHA256(t, targetStable)

	store, err := handoff.Open(filepath.Join(stateHome, "agent-platform", "handoff"), sourceRoot, targetRoot)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 7, 31, 1, 0, 0, 0, time.UTC)
	journal, err := handoff.NewJournal(
		handoff.ReleaseBinding{
			PredecessorGeneration: startupSourceGeneration, BridgeGeneration: startupTargetGeneration,
			ManifestPath:   filepath.Join(sourceProfile.ManagerStateRoot(sourceRoot), "releases", startupTargetGeneration, "manifest.json"),
			ManifestSHA256: startupTestSHA, TargetManagerSHA256: targetSHA,
			TargetManagerVersion: startupTargetGeneration, TargetComposeSHA256: startupTestSHA,
		},
		handoff.SourceBinding{
			Namespace: sourceProfile.ProfileID, Unit: sourceProfile.ManagerUnit, UnitEnabled: true,
			UnitPath: filepath.Join(configHome, "systemd", "user", sourceProfile.ManagerUnit), UnitSHA256: startupTestSHA,
			StableBinary: sourceStable, StableSHA256: startupTestSHA, ConfigPath: sourceConfigPath, ConfigSHA256: startupTestSHA,
			ManifestPath: filepath.Join(sourceProfile.ManagerStateRoot(sourceRoot), "releases", startupSourceGeneration, "manifest.json"), ManifestSHA256: startupTestSHA,
			ComposePath: filepath.Join(sourceProfile.ManagerStateRoot(sourceRoot), "releases", startupSourceGeneration, "compose.yaml"), ComposeSHA256: startupTestSHA,
			DataRoot: sourceRoot, SocketPath: sourceConfig.SocketPath, ComposeProject: sourceProfile.ComposeProject,
			CoreNetwork: sourceProfile.CoreNetwork, CoreNetworkID: strings.Repeat("c", 64), LabelPrefix: sourceProfile.LabelPrefix,
		},
		handoff.TargetBinding{
			Namespace: targetProfile.ProfileID, Unit: targetProfile.ManagerUnit,
			UnitPath: filepath.Join(configHome, "systemd", "user", targetProfile.ManagerUnit), StableBinary: targetStable,
			ConfigPath: targetConfigPath, ConfigSHA256: hex.EncodeToString(targetConfigDigest[:]), DataRoot: targetRoot, SocketPath: targetSocket,
			ComposeProject: targetProfile.ComposeProject, CoreNetwork: targetProfile.CoreNetwork, LabelPrefix: targetProfile.LabelPrefix,
		},
		handoff.Evidence{
			ManagerStateSHA256: startupTestSHA, SelfUpdateStateSHA256: startupTestSHA, SandboxRegistrySHA256: startupTestSHA,
			DockerInventorySHA256: startupTestSHA, DatabaseSchemaVersion: 1, DatabaseIntegrity: "ok",
			RuntimeIdentitySHA256: startupTestSHA, WorkspaceIdentitySHA256: startupTestSHA,
			BootID: "11111111-1111-1111-1111-111111111111",
		}, now,
	)
	if err != nil {
		t.Fatal(err)
	}
	created, err := store.Create(journal)
	if err != nil {
		t.Fatal(err)
	}
	helper, current, err := store.OpenHelper(created.TransactionID)
	if err != nil {
		t.Fatal(err)
	}
	current = commitStartupJournal(t, helper, current, targetSHA)
	if current.Status != handoff.StatusCommitted {
		t.Fatal("test journal did not commit")
	}
	if err := helper.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(targetConfigPath, append(append([]byte(nil), targetConfigBytes...), []byte("# replaced content\n")...), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := terminalHandoffBindings(store, targetConfig); err == nil || !strings.Contains(err.Error(), "target config digest") {
		t.Fatalf("terminal target accepted mismatched config digest: %v", err)
	}
	if err := os.WriteFile(targetConfigPath, targetConfigBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	sourceBinding, targetBinding, err := terminalHandoffBindings(store, targetConfig)
	if err != nil {
		t.Fatalf("derive target ownership from committed journal: %v", err)
	}
	if sourceBinding.ConfigPath != sourceConfigPath || targetBinding.ConfigPath != targetConfigPath {
		t.Fatalf("terminal ownership bindings = source %q target %q", sourceBinding.ConfigPath, targetBinding.ConfigPath)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	command := exec.Command(targetStable, "-test.run=^TestCommittedTargetStartupRoutesBeforeProfileConfigLoad$", "-test.v=false")
	command.Env = append(os.Environ(),
		"AGENT_PLATFORM_TARGET_STARTUP_TEST_CONFIG="+targetConfigPath,
		"AGENT_PLATFORM_TARGET_STARTUP_TEST_STATE_HOME="+stateHome,
		"AGENT_PLATFORM_TARGET_STARTUP_TEST_STABLE="+targetStable,
		"AGENT_PLATFORM_TARGET_STARTUP_TEST_PLAN="+filepath.Join(root, "plan.json"),
	)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("committed target restart/CLI subprocess failed: %v\n%s", err, output)
	}
}

func commitStartupJournal(t *testing.T, helper *handoff.Helper, current handoff.Journal, targetSHA string) handoff.Journal {
	t.Helper()
	at := current.UpdatedAt.Add(time.Second)
	mutate := func(change func(*handoff.Journal)) {
		var err error
		current, err = helper.Mutate(current.Revision, at, func(next *handoff.Journal) error { change(next); return nil })
		if err != nil {
			t.Fatal(err)
		}
		at = at.Add(time.Second)
	}
	suffix := strings.TrimPrefix(current.TransactionID, "handoff_")[:12]
	mutate(func(next *handoff.Journal) {
		next.Helper = &handoff.HelperEvidence{
			Unit:       identity.TargetProfile().DataDirectory + "-namespace-handoff-" + suffix + ".service",
			UnitSHA256: startupTestSHA, Executable: next.Target.StableBinary, SHA256: targetSHA,
			ArgvSHA256: startupTestSHA, ControlGroup: "/test/handoff",
		}
	})
	for _, phase := range []handoff.Phase{handoff.PhaseHelperArmed, handoff.PhaseAdmissionReserved, handoff.PhaseWritersStopped} {
		value := phase
		mutate(func(next *handoff.Journal) { next.Phase = value })
	}
	mutate(func(next *handoff.Journal) {
		next.Snapshot = &handoff.Snapshot{Path: filepath.Join(filepath.Dir(next.Source.DataRoot), "snapshot"), ManifestSHA256: startupTestSHA}
	})
	for _, phase := range []handoff.Phase{
		handoff.PhaseSnapshotReady, handoff.PhaseSourceFenced, handoff.PhaseTargetStaged,
		handoff.PhaseDataRelocated, handoff.PhaseTargetStarted,
	} {
		value := phase
		mutate(func(next *handoff.Journal) { next.Phase = value })
	}
	mutate(func(next *handoff.Journal) {
		next.TargetAck = &handoff.TargetAck{
			ManagerVersion: next.Release.TargetManagerVersion, ExecutableSHA256: targetSHA,
			SourceCommit: next.Release.BridgeGeneration, PID: os.Getpid(), SocketPath: next.Target.SocketPath,
			AutoUpdateCheckAt: at.Add(-time.Second), IssuedAt: at, ProofSHA256: startupTestSHA,
		}
	})
	for _, phase := range []handoff.Phase{handoff.PhaseTargetVerified, handoff.PhaseSourceRetired, handoff.PhaseTargetCommitPlanned} {
		value := phase
		mutate(func(next *handoff.Journal) { next.Phase = value })
	}
	mutate(func(next *handoff.Journal) {
		committedAt := at.Add(-time.Second).UTC().Format(time.RFC3339Nano)
		receipt := handoff.TargetPlatformCommit{
			SchemaVersion: 1, OperationID: next.TransactionID, TargetGeneration: next.Release.BridgeGeneration,
			BindingSHA256: next.BindingSHA256, DatabaseSchemaVersion: next.Evidence.DatabaseSchemaVersion, CommittedAt: committedAt,
		}
		receipt.ReceiptSHA256, _ = handoff.ComputeTargetPlatformCommitSHA256(receipt)
		next.TargetPlatformCommit = &receipt
		next.Phase = handoff.PhaseCommitted
		next.Status = handoff.StatusCommitted
	})
	return current
}

func testFileSHA256(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func strconvQuote(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `\"`) + `"`
}
