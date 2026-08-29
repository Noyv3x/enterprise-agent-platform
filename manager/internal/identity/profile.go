// Package identity defines the immutable technical identities used by the
// Manager. These values are deployment protocol, not administrator branding.
package identity

import (
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
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

var target = generatedTargetProfile

// ActiveProfile is an opaque, validated technical profile. Keeping its value
// private prevents mutable Config structs or administrator input from selecting
// a namespace accidentally.
type ActiveProfile struct {
	value Profile
}

// TargetProfile returns the immutable technical identity for every supported
// Manager lifecycle operation.
func TargetProfile() Profile { return target }

// TargetProfileID returns the signed target identity in release manifests.
func TargetProfileID() string { return target.ProfileID }

// CompileTimeActiveProfile is the sole production identity selector. Paths,
// argv, environment, manifests, branding and executable basenames cannot
// influence the selected namespace.
func CompileTimeActiveProfile() ActiveProfile { return ActiveProfile{value: target} }

// Validate proves that the active value is the exact compile-time target
// profile. It rejects zero values and field-level mutations.
func (a ActiveProfile) Validate() error {
	if reflect.DeepEqual(a.value, target) {
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

// ProtectedHostProfiles returns the sole technical root that host execution
// must protect.
func (a ActiveProfile) ProtectedHostProfiles() ([]Profile, error) {
	if err := a.Validate(); err != nil {
		return nil, err
	}
	return []Profile{target}, nil
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

// ControlSocketPath resolves the owner-specific runtime socket path.
func (p Profile) ControlSocketPath(runtimeRoot string) (string, error) {
	if p.RuntimeSocketPath == "" {
		return "", fmt.Errorf("profile %q has no control socket binding", p.ProfileID)
	}
	if !filepath.IsAbs(runtimeRoot) {
		return "", errors.New("XDG runtime directory must be absolute")
	}
	return filepath.Join(runtimeRoot, filepath.FromSlash(p.RuntimeSocketPath)), nil
}

func (p Profile) Label(suffix string) string {
	return p.LabelPrefix + "." + suffix
}
