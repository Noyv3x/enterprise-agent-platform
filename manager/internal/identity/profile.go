// Package identity defines the immutable technical identities used by the
// Manager. These values are deployment protocol, not administrator branding.
package identity

import (
	"errors"
	"fmt"
	"path/filepath"
	"reflect"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
)

// Profile is the complete fixed namespace needed to identify one Manager
// deployment. Profiles are compile-time protocol values and must never be
// populated from configuration, environment, branding, or executable names.
type Profile struct {
	ProfileID                  string
	ManagerBinary              string
	ManagerUnit                string
	ConfigDirectory            string
	ConfigFile                 string
	DataDirectory              string
	ManagerStateDirectory      string
	DataRootSocketPath         string
	RuntimeSocketPath          string
	ContainerDataRoot          string
	ContainerSecretRoot        string
	ContainerControlSocketPath string
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

var target = Profile{
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

// ActiveProfile is an opaque, validated technical profile. Keeping its value
// private prevents mutable Config structs or administrator input from selecting
// a namespace accidentally.
type ActiveProfile struct {
	value Profile
}

// SourceProfile returns a copy of the currently deployed technical identity.
// It is intended for protocol comparison and tests. Production construction
// should inject SourceActiveProfile instead of consulting this function from
// internal components.
func SourceProfile() Profile { return source }

// TargetProfile returns the immutable target binding used by the verified
// namespace handoff.
func TargetProfile() Profile { return target }

// TargetProfileID returns the signed target identity in release manifests.
func TargetProfileID() string { return target.ProfileID }

// SourceActiveProfile is the only ordinary-startup profile selector.
func SourceActiveProfile() ActiveProfile { return ActiveProfile{value: source} }

// ActivateVerifiedHandoffTarget constructs the target profile only after the
// caller has verified the external handoff journal and capability. This
// function deliberately accepts no profile ID, path, environment, or branding
// value: the supplied binding must equal the complete compile-time target.
func ActivateVerifiedHandoffTarget(binding Profile) (ActiveProfile, error) {
	if !reflect.DeepEqual(binding, target) {
		return ActiveProfile{}, errors.New("verified handoff target does not match the canonical target profile")
	}
	return ActiveProfile{value: target}, nil
}

// Validate proves that the active value is one of the two exact compile-time
// profiles. It rejects zero values and field-level mutations.
func (a ActiveProfile) Validate() error {
	if reflect.DeepEqual(a.value, source) || reflect.DeepEqual(a.value, target) {
		return nil
	}
	return errors.New("active technical profile is invalid")
}

// Profile returns a copy of the validated active profile.
func (a ActiveProfile) Profile() (Profile, error) {
	if err := a.Validate(); err != nil {
		return Profile{}, err
	}
	return a.value, nil
}

// ProtectedHostProfiles returns the technical roots that host execution must
// protect while the one-time namespace handoff can have source rollback state
// and target state on disk simultaneously.
func (a ActiveProfile) ProtectedHostProfiles() ([]Profile, error) {
	if err := a.Validate(); err != nil {
		return nil, err
	}
	return []Profile{source, target}, nil
}

func (p Profile) DefaultConfigPath(configHome string) string {
	return filepath.Join(configHome, p.ConfigDirectory, p.ConfigFile)
}

func (p Profile) DefaultDataRoot(dataHome string) string {
	return filepath.Join(dataHome, p.DataDirectory)
}

func (p Profile) ManagerStateRoot(dataRoot string) string {
	return filepath.Join(dataRoot, p.ManagerStateDirectory)
}

// ControlSocketPath resolves the profile socket. Source uses its durable data
// root while target uses the owner-specific XDG runtime directory.
func (p Profile) ControlSocketPath(dataRoot, runtimeRoot string) (string, error) {
	if p.DataRootSocketPath != "" && p.RuntimeSocketPath == "" {
		if !filepath.IsAbs(dataRoot) {
			return "", errors.New("data root must be absolute")
		}
		return filepath.Join(dataRoot, filepath.FromSlash(p.DataRootSocketPath)), nil
	}
	if p.RuntimeSocketPath != "" && p.DataRootSocketPath == "" {
		if !filepath.IsAbs(runtimeRoot) {
			return "", errors.New("XDG runtime directory must be absolute for the target profile")
		}
		return filepath.Join(runtimeRoot, filepath.FromSlash(p.RuntimeSocketPath)), nil
	}
	return "", fmt.Errorf("profile %q has an invalid control socket binding", p.ProfileID)
}

func (p Profile) ManagerInstallPath(binHome string) string {
	return filepath.Join(binHome, p.ManagerBinary)
}

func (p Profile) Label(suffix string) string {
	return p.LabelPrefix + "." + suffix
}
