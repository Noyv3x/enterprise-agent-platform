package identity

import (
	"path/filepath"
	"reflect"
	"testing"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
)

func TestSourceProfileMatchesExistingDeploymentProtocol(t *testing.T) {
	want := Profile{
		ProfileID:                  "ubitech-agent-v1",
		ManagerBinary:              "ubitech-manager",
		ManagerUnit:                "ubitech-agent-manager.service",
		ConfigDirectory:            "ubitech-agent",
		ConfigFile:                 "manager.toml",
		DataDirectory:              "ubitech-agent",
		ManagerStateDirectory:      "manager",
		DataRootSocketPath:         "manager/control/manager.sock",
		ContainerDataRoot:          "/var/lib/ubitech-agent",
		ContainerSecretRoot:        "/run/secrets/ubitech",
		ContainerControlSocketPath: "/run/ubitech-manager/manager.sock",
		GatewayStatusPath:          "/__ubitech/status",
		GatewayHealthPath:          "/__ubitech/health",
		ComposeProject:             "ubitech-agent",
		CoreNetwork:                "ubitech-agent_core",
		EnvironmentPrefix:          "UBITECH",
		LabelPrefix:                "org.ubitech.agent",
		SandboxContainerPrefix:     "ubitech-sandbox-",
		MigrationContainerPrefix:   "ubitech-migration-",
		WatchdogUnitPrefix:         "ubitech-agent-manager-watchdog-",
		RecoveryWatchdogUnitPrefix: "ubitech-agent-manager-watchdog-current-recovery-",
		InternalWorkspaceDirectory: ".ubitech",
	}
	if got := SourceProfile(); !reflect.DeepEqual(got, want) {
		t.Fatalf("source profile changed the deployed protocol:\n got: %#v\nwant: %#v", got, want)
	}
	if got := want.DefaultConfigPath("/config"); got != filepath.Join("/config", "ubitech-agent", "manager.toml") {
		t.Fatalf("source config path = %q", got)
	}
	if got := want.DefaultDataRoot("/data"); got != filepath.Join("/data", "ubitech-agent") {
		t.Fatalf("source data root = %q", got)
	}
	got, err := want.ControlSocketPath("/data/ubitech-agent", "")
	if err != nil || got != filepath.Join("/data/ubitech-agent", "manager", "control", "manager.sock") {
		t.Fatalf("source socket path = %q, %v", got, err)
	}
}

func TestTargetProfileMatchesHandoffContract(t *testing.T) {
	want := Profile{
		ProfileID:                  "agent-platform-v1",
		ManagerBinary:              "agent-platform-manager",
		ManagerUnit:                "agent-platform-manager.service",
		ConfigDirectory:            "agent-platform",
		ConfigFile:                 "manager.toml",
		DataDirectory:              "agent-platform",
		ManagerStateDirectory:      "manager",
		RuntimeSocketPath:          "agent-platform-manager/manager.sock",
		ContainerDataRoot:          "/var/lib/agent-platform",
		ContainerSecretRoot:        "/run/secrets/agent-platform",
		ContainerControlSocketPath: "/run/agent-platform-manager/manager.sock",
		GatewayStatusPath:          "/__agent_platform/status",
		GatewayHealthPath:          "/__agent_platform/health",
		ComposeProject:             "agent-platform",
		CoreNetwork:                "agent-platform_core",
		EnvironmentPrefix:          "AGENT_PLATFORM",
		LabelPrefix:                "io.agent-platform",
		SandboxContainerPrefix:     "agent-platform-sandbox-",
		MigrationContainerPrefix:   "agent-platform-migration-",
		WatchdogUnitPrefix:         "agent-platform-manager-watchdog-",
		RecoveryWatchdogUnitPrefix: "agent-platform-manager-watchdog-current-recovery-",
		InternalWorkspaceDirectory: ".agent-platform",
	}
	if got := TargetProfile(); !reflect.DeepEqual(got, want) {
		t.Fatalf("target profile differs from the handoff contract:\n got: %#v\nwant: %#v", got, want)
	}
	if got := TargetProfileID(); got != want.ProfileID {
		t.Fatalf("target profile ID = %q", got)
	}
	got, err := want.ControlSocketPath("/ignored", "/run/user/1001")
	if err != nil || got != "/run/user/1001/agent-platform-manager/manager.sock" {
		t.Fatalf("target socket path = %q, %v", got, err)
	}
}

func TestActiveProfileSelectionIsClosed(t *testing.T) {
	active := SourceActiveProfile()
	if err := active.Validate(); err != nil {
		t.Fatal(err)
	}
	changed := SourceProfile()
	changed.ManagerBinary = "changed"
	if _, err := ActivateVerifiedHandoffTarget(changed); err == nil {
		t.Fatal("mutated binding selected the target profile")
	}
	targetActive, err := ActivateVerifiedHandoffTarget(TargetProfile())
	if err != nil {
		t.Fatal(err)
	}
	got, err := targetActive.Profile()
	if err != nil || !reflect.DeepEqual(got, TargetProfile()) {
		t.Fatalf("target activation = %#v, %v", got, err)
	}
	if err := (ActiveProfile{}).Validate(); err == nil {
		t.Fatal("zero active profile was accepted")
	}
}

func TestProfilesAreReturnedByValue(t *testing.T) {
	changed := SourceProfile()
	changed.ManagerBinary = "changed"
	if SourceProfile().ManagerBinary != "ubitech-manager" {
		t.Fatal("caller mutated the source profile")
	}
	changed = TargetProfile()
	changed.ManagerBinary = "changed"
	if TargetProfile().ManagerBinary != "agent-platform-manager" {
		t.Fatal("caller mutated the target profile")
	}
}

func TestReleaseStageSelectsOnlyTheCanonicalCompileTimeProfile(t *testing.T) {
	for _, test := range []struct {
		stage string
		want  Profile
	}{
		{stage: "bridge", want: SourceProfile()},
		{stage: "cleanup", want: TargetProfile()},
		{stage: "target_baseline", want: TargetProfile()},
	} {
		t.Run(test.stage, func(t *testing.T) {
			active, err := ActiveProfileForReleaseContract(
				test.stage, SourceProfile().ProfileID, TargetProfile().ProfileID,
			)
			if err != nil {
				t.Fatal(err)
			}
			got, err := active.Profile()
			if err != nil || !reflect.DeepEqual(got, test.want) {
				t.Fatalf("stage %q profile = %#v, %v; want %#v", test.stage, got, err, test.want)
			}
		})
	}

	for _, test := range []struct {
		name, stage, sourceID, targetID string
	}{
		{name: "unknown stage", stage: "source_owner", sourceID: SourceProfile().ProfileID, targetID: TargetProfile().ProfileID},
		{name: "source drift", stage: "bridge", sourceID: TargetProfile().ProfileID, targetID: TargetProfile().ProfileID},
		{name: "target drift", stage: "cleanup", sourceID: SourceProfile().ProfileID, targetID: SourceProfile().ProfileID},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := ActiveProfileForReleaseContract(test.stage, test.sourceID, test.targetID); err == nil {
				t.Fatal("invalid release contract selected a technical profile")
			}
		})
	}
}

func TestCompileTimeProfileMatchesGeneratedStage(t *testing.T) {
	active, err := CompileTimeActiveProfile()
	if err != nil {
		t.Fatal(err)
	}
	want := SourceActiveProfile()
	if contract.ReleaseTransitionStage == "cleanup" || contract.ReleaseTransitionStage == "target_baseline" {
		want, err = ActivateVerifiedHandoffTarget(TargetProfile())
		if err != nil {
			t.Fatal(err)
		}
	}
	if active != want {
		t.Fatalf("stage %q selected %#v, want %#v", contract.ReleaseTransitionStage, active, want)
	}
}
