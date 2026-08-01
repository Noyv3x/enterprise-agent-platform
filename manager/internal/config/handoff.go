package config

import (
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

// DeriveHandoffTarget creates the target technical configuration while
// preserving only administrator-owned operational settings from source. Every
// technical path and namespace is rebound to the canonical target profile.
func DeriveHandoffTarget(source Config, targetActive identity.ActiveProfile, targetConfigPath, targetDataRoot, targetSocketPath string) (Config, error) {
	sourceProfile, err := source.activeProfile.Profile()
	if err != nil || sourceProfile != identity.SourceProfile() {
		return Config{}, errors.New("handoff target configuration requires the canonical source configuration")
	}
	targetProfile, err := targetActive.Profile()
	if err != nil || targetProfile != identity.TargetProfile() {
		return Config{}, errors.New("handoff target configuration requires the canonical target profile")
	}
	for label, path := range map[string]string{"target config": targetConfigPath, "target data root": targetDataRoot, "target socket": targetSocketPath} {
		if path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path {
			return Config{}, fmt.Errorf("%s must be canonical and absolute", label)
		}
	}
	if filepath.Base(targetConfigPath) != targetProfile.ConfigFile || filepath.Base(filepath.Dir(targetConfigPath)) != targetProfile.ConfigDirectory ||
		filepath.Base(targetDataRoot) != targetProfile.DataDirectory {
		return Config{}, errors.New("handoff target configuration paths differ from the canonical target profile")
	}
	target, err := Defaults(targetActive)
	if err != nil {
		return Config{}, err
	}
	target.ConfigPath = targetConfigPath
	target.DataHome = filepath.Dir(targetDataRoot)
	target.DataRoot = targetDataRoot
	target.StateDir = targetProfile.ManagerStateRoot(targetDataRoot)
	target.StateHome = source.StateHome
	if !strings.HasSuffix(targetSocketPath, string(filepath.Separator)+filepath.FromSlash(targetProfile.RuntimeSocketPath)) {
		return Config{}, errors.New("handoff target socket differs from the canonical target profile")
	}
	target.SocketPath = targetSocketPath
	target.GatewayAddress = source.GatewayAddress
	target.LANEnabled = source.LANEnabled
	target.LANAddress = source.LANAddress
	target.DirectAccessCIDRs = append([]string(nil), source.DirectAccessCIDRs...)
	target.TrustedIngressCIDRs = append([]string(nil), source.TrustedIngressCIDRs...)
	target.PlatformURL = source.PlatformURL
	target.PlatformGateURL = source.PlatformGateURL
	target.InternalToken = ""
	target.InternalTokenFile = filepath.Join(target.StateDir, "secrets", "manager-token")
	target.ReleaseURL = source.ReleaseURL
	target.ReleaseChannel = source.ReleaseChannel
	target.UpdateEnabled = source.UpdateEnabled
	target.UpdateInterval = source.UpdateInterval
	target.ComposeFile = ""
	target.ComposeProject = targetProfile.ComposeProject
	target.DockerBinary = source.DockerBinary
	target.SandboxImage = source.SandboxImage
	target.SandboxNetwork = targetProfile.CoreNetwork
	target.SandboxIdle = source.SandboxIdle
	target.HealthTimeout = source.HealthTimeout
	target.DrainTimeout = source.DrainTimeout
	target.LogMaxBytes = source.LogMaxBytes
	target.LogBackups = source.LogBackups
	target.CommandMaxBytes = source.CommandMaxBytes
	if err := target.Validate(); err != nil {
		return Config{}, fmt.Errorf("validate handoff target config: %w", err)
	}
	return target, nil
}

// RenderHandoffTarget emits the complete deterministic manager.toml consumed
// by the helper-owned target installation. It intentionally has no comments,
// branding, plaintext secret, or ambient defaults.
func RenderHandoffTarget(value Config) ([]byte, error) {
	profile, err := value.activeProfile.Profile()
	if err != nil || profile != identity.TargetProfile() {
		return nil, errors.New("only the canonical handoff target config can be rendered")
	}
	if err := value.Validate(); err != nil {
		return nil, err
	}
	quote := strconv.Quote
	array := func(values []string) string {
		quoted := make([]string, len(values))
		for index, item := range values {
			quoted[index] = quote(item)
		}
		return "[" + strings.Join(quoted, ", ") + "]"
	}
	lines := []string{
		"data_root = " + quote(value.DataRoot),
		"state_dir = " + quote(value.StateDir),
		"state_home = " + quote(value.StateHome),
		"socket_path = " + quote(value.SocketPath),
		"listen = " + quote(value.GatewayAddress),
		"lan_enabled = " + strconv.FormatBool(value.LANEnabled),
		"lan_listen = " + quote(value.LANAddress),
		"direct_access_cidrs = " + array(value.DirectAccessCIDRs),
		"trusted_ingress_cidrs = " + array(value.TrustedIngressCIDRs),
		"platform_url = " + quote(value.PlatformURL),
		"platform_gate_url = " + quote(value.PlatformGateURL),
		"internal_token_file = " + quote(value.ControlTokenFile()),
		"release_manifest_url = " + quote(value.ReleaseURL),
		"release_channel = " + quote(value.ReleaseChannel),
		"update_enabled = " + strconv.FormatBool(value.UpdateEnabled),
		"update_interval = " + quote(value.UpdateInterval.String()),
		"compose_project = " + quote(value.ComposeProject),
		"docker_binary = " + quote(value.DockerBinary),
		"sandbox_image = " + quote(value.SandboxImage),
		"sandbox_network = " + quote(value.SandboxNetwork),
		"sandbox_idle = " + quote(value.SandboxIdle.String()),
		"health_timeout_seconds = " + strconv.FormatInt(int64(value.HealthTimeout.Seconds()), 10),
		"drain_timeout_seconds = " + strconv.FormatInt(int64(value.DrainTimeout.Seconds()), 10),
		"log_max_size = " + strconv.FormatInt(value.LogMaxBytes, 10),
		"log_max_files = " + strconv.Itoa(value.LogBackups),
		"command_max_bytes = " + strconv.FormatInt(value.CommandMaxBytes, 10),
	}
	return []byte(strings.Join(lines, "\n") + "\n"), nil
}
