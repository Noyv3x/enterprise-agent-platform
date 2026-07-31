package identity

import (
	"path/filepath"
	"reflect"
	"testing"
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
	if got := want.ControlSocketPath("/data/ubitech-agent"); got != filepath.Join("/data/ubitech-agent", "manager", "control", "manager.sock") {
		t.Fatalf("source socket path = %q", got)
	}
}

func TestTargetProfileIDMatchesSignedManifestContract(t *testing.T) {
	if got := TargetProfileID(); got != "agent-platform-v1" {
		t.Fatalf("target profile ID = %q", got)
	}
}

func TestProfilesAreReturnedByValue(t *testing.T) {
	changed := SourceProfile()
	changed.ManagerBinary = "changed"
	if SourceProfile().ManagerBinary != "ubitech-manager" {
		t.Fatal("caller mutated the source profile")
	}
}
