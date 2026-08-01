package identity

import (
	"path/filepath"
	"reflect"
	"testing"
)

func TestTargetProfileMatchesCurrentProtocol(t *testing.T) {
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
		t.Fatalf("target profile differs from the canonical contract:\n got: %#v\nwant: %#v", got, want)
	}
	if TargetProfileID() != want.ProfileID {
		t.Fatalf("target profile ID = %q", TargetProfileID())
	}
	if got := want.DefaultConfigPath("/config"); got != filepath.Join("/config", "agent-platform", "manager.toml") {
		t.Fatalf("config path = %q", got)
	}
	if got := want.DefaultDataRoot("/data"); got != filepath.Join("/data", "agent-platform") {
		t.Fatalf("data root = %q", got)
	}
	got, err := want.ControlSocketPath("/run/user/1001")
	if err != nil || got != "/run/user/1001/agent-platform-manager/manager.sock" {
		t.Fatalf("socket path = %q, %v", got, err)
	}
}

func TestCompileTimeProfileIsClosedAndReturnedByValue(t *testing.T) {
	active := CompileTimeActiveProfile()
	if err := active.Validate(); err != nil {
		t.Fatal(err)
	}
	got, err := active.Profile()
	if err != nil || !reflect.DeepEqual(got, TargetProfile()) {
		t.Fatalf("active profile = %#v, %v", got, err)
	}
	if err := (ActiveProfile{}).Validate(); err == nil {
		t.Fatal("zero active profile was accepted")
	}
	changed := TargetProfile()
	changed.ManagerBinary = "changed"
	if TargetProfile().ManagerBinary != "agent-platform-manager" {
		t.Fatal("caller mutated the compile-time profile")
	}
}

func TestControlSocketRequiresAbsoluteRuntimeRoot(t *testing.T) {
	if _, err := TargetProfile().ControlSocketPath(""); err == nil {
		t.Fatal("empty runtime root was accepted")
	}
	if _, err := TargetProfile().ControlSocketPath("relative"); err == nil {
		t.Fatal("relative runtime root was accepted")
	}
}
