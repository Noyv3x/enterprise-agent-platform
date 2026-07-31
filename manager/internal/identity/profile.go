// Package identity defines the immutable technical identities used by the
// Manager. These values are deployment protocol, not administrator branding.
package identity

import (
	"path/filepath"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
)

// Profile is the complete fixed namespace needed to identify one Manager
// deployment. A profile is selected by code, never by mutable configuration or
// branding input.
type Profile struct {
	ProfileID                  string
	ManagerBinary              string
	ManagerUnit                string
	ConfigDirectory            string
	ConfigFile                 string
	DataDirectory              string
	ManagerStateDirectory      string
	DataRootSocketPath         string
	ContainerDataRoot          string
	GatewayStatusPath          string
	GatewayHealthPath          string
	ComposeProject             string
	CoreNetwork                string
	EnvironmentPrefix          string
	LabelPrefix                string
	SandboxContainerPrefix     string
	MigrationContainerPrefix   string
	WatchdogUnitPrefix         string
	RecoveryWatchdogUnitPrefix string
	InternalWorkspaceDirectory string
}

var source = Profile{
	ProfileID:                  "ubitech-agent-v1",
	ManagerBinary:              "ubitech-manager",
	ManagerUnit:                "ubitech-agent-manager.service",
	ConfigDirectory:            "ubitech-agent",
	ConfigFile:                 "manager.toml",
	DataDirectory:              "ubitech-agent",
	ManagerStateDirectory:      "manager",
	DataRootSocketPath:         "manager/control/manager.sock",
	ContainerDataRoot:          contract.ContainerDataRoot,
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

const targetProfileID = "agent-platform-v1"

// SourceProfile returns a copy of the currently deployed technical identity.
// Current Manager code must bind this profile explicitly until the namespace
// handoff release owns the transition.
func SourceProfile() Profile { return source }

// TargetProfileID returns only the signed identity understood by the inert
// manifest boundary. The complete target profile belongs to the future
// source-owner release, where every field has an execution consumer.
func TargetProfileID() string { return targetProfileID }

func (p Profile) DefaultConfigPath(configHome string) string {
	return filepath.Join(configHome, p.ConfigDirectory, p.ConfigFile)
}

func (p Profile) DefaultDataRoot(dataHome string) string {
	return filepath.Join(dataHome, p.DataDirectory)
}

func (p Profile) ManagerStateRoot(dataRoot string) string {
	return filepath.Join(dataRoot, p.ManagerStateDirectory)
}

// ControlSocketPath resolves the current source profile's durable socket.
func (p Profile) ControlSocketPath(dataRoot string) string {
	return filepath.Join(dataRoot, filepath.FromSlash(p.DataRootSocketPath))
}

func (p Profile) ManagerInstallPath(binHome string) string {
	return filepath.Join(binHome, p.ManagerBinary)
}

func (p Profile) Label(suffix string) string {
	return p.LabelPrefix + "." + suffix
}
