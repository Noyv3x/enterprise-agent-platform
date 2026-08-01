// Code generated from docs/contracts/technical-profiles.json by scripts/docs_sync.py; DO NOT EDIT.
package identity

var generatedTargetProfile = Profile{
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
