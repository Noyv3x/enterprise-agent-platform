package config

import (
	"bufio"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

type Config struct {
	ConfigPath          string
	DataRoot            string
	StateDir            string
	SocketPath          string
	GatewayAddress      string
	LANEnabled          bool
	LANAddress          string
	DirectAccessCIDRs   []string
	TrustedIngressCIDRs []string
	PlatformURL         string
	PlatformGateURL     string
	InternalToken       string
	InternalTokenFile   string
	ReleaseURL          string
	ReleaseChannel      string
	UpdateEnabled       bool
	UpdateInterval      time.Duration
	ComposeFile         string
	ComposeProject      string
	DockerBinary        string
	SandboxImage        string
	SandboxNetwork      string
	SandboxIdle         time.Duration
	HealthTimeout       time.Duration
	DrainTimeout        time.Duration
	LogMaxBytes         int64
	LogBackups          int
	CommandMaxBytes     int64
}

func Defaults() (Config, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Config{}, fmt.Errorf("resolve home directory: %w", err)
	}
	configHome := os.Getenv("XDG_CONFIG_HOME")
	if configHome == "" {
		configHome = filepath.Join(home, ".config")
	}
	dataHome := os.Getenv("XDG_DATA_HOME")
	if dataHome == "" {
		dataHome = filepath.Join(home, ".local", "share")
	}
	profile := identity.SourceProfile()
	dataRoot := profile.DefaultDataRoot(dataHome)
	stateDir := profile.ManagerStateRoot(dataRoot)
	socketPath := profile.ControlSocketPath(dataRoot)
	return Config{
		ConfigPath:          profile.DefaultConfigPath(configHome),
		DataRoot:            dataRoot,
		StateDir:            stateDir,
		SocketPath:          socketPath,
		GatewayAddress:      "127.0.0.1:8080",
		LANEnabled:          false,
		LANAddress:          "127.0.0.1:8081",
		DirectAccessCIDRs:   []string{"127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fd00::/8"},
		TrustedIngressCIDRs: []string{"127.0.0.0/8", "::1/128"},
		PlatformURL:         "http://127.0.0.1:18080",
		PlatformGateURL:     "http://127.0.0.1:18080",
		ReleaseChannel:      contract.ReleaseChannel,
		UpdateEnabled:       true,
		UpdateInterval:      5 * time.Minute,
		ComposeProject:      profile.ComposeProject,
		DockerBinary:        "docker",
		SandboxNetwork:      profile.CoreNetwork,
		SandboxIdle:         time.Duration(contract.SandboxIdleSeconds) * time.Second,
		HealthTimeout:       2 * time.Minute,
		DrainTimeout:        5 * time.Minute,
		LogMaxBytes:         10 << 20,
		LogBackups:          5,
		CommandMaxBytes:     1 << 20,
	}, nil
}

func Load(path string) (Config, error) {
	cfg, err := Defaults()
	if err != nil {
		return Config{}, err
	}
	if path != "" {
		cfg.ConfigPath = path
	}
	f, err := os.Open(cfg.ConfigPath)
	if os.IsNotExist(err) {
		return cfg, nil
	}
	if err != nil {
		return Config{}, fmt.Errorf("open config: %w", err)
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	line := 0
	for s.Scan() {
		line++
		raw := strings.TrimSpace(strings.SplitN(s.Text(), "#", 2)[0])
		if raw == "" || strings.HasPrefix(raw, "[") {
			continue
		}
		parts := strings.SplitN(raw, "=", 2)
		if len(parts) != 2 {
			return Config{}, fmt.Errorf("config line %d: expected key = value", line)
		}
		key := strings.TrimSpace(parts[0])
		value := strings.Trim(strings.TrimSpace(parts[1]), "\"")
		if err := set(&cfg, key, value); err != nil {
			return Config{}, fmt.Errorf("config line %d: %w", line, err)
		}
	}
	if err := s.Err(); err != nil {
		return Config{}, fmt.Errorf("read config: %w", err)
	}
	return cfg, cfg.Validate()
}

func set(c *Config, key, value string) error {
	switch key {
	case "data_root":
		root := expandHome(value)
		profile := identity.SourceProfile()
		socketPath := profile.ControlSocketPath(root)
		c.DataRoot = root
		c.StateDir = profile.ManagerStateRoot(root)
		c.SocketPath = socketPath
	case "state_dir":
		c.StateDir = expandHome(value)
	case "socket_path":
		c.SocketPath = expandHome(value)
	case "listen":
		c.GatewayAddress = value
	case "lan_enabled":
		parsed, err := strconv.ParseBool(value)
		if err != nil {
			return fmt.Errorf("lan_enabled must be true or false")
		}
		c.LANEnabled = parsed
	case "lan_listen":
		c.LANAddress = value
	case "direct_access_cidrs":
		values, err := parseStringArray(value)
		if err != nil {
			return fmt.Errorf("direct_access_cidrs: %w", err)
		}
		c.DirectAccessCIDRs = values
	case "trusted_ingress_cidrs":
		values, err := parseStringArray(value)
		if err != nil {
			return fmt.Errorf("trusted_ingress_cidrs: %w", err)
		}
		c.TrustedIngressCIDRs = values
	case "platform_url":
		c.PlatformURL = value
	case "platform_gate_url":
		c.PlatformGateURL = value
	case "internal_token":
		return errors.New("internal_token plaintext is not accepted; use internal_token_file")
	case "internal_token_file":
		c.InternalTokenFile = expandHome(value)
	case "release_manifest_url":
		c.ReleaseURL = value
	case "release_channel":
		c.ReleaseChannel = value
	case "update_enabled":
		parsed, err := strconv.ParseBool(value)
		if err != nil {
			return fmt.Errorf("update_enabled must be true or false")
		}
		c.UpdateEnabled = parsed
	case "update_interval":
		duration, err := time.ParseDuration(value)
		if err != nil || duration < 30*time.Second || duration > 24*time.Hour {
			return fmt.Errorf("update_interval must be between 30s and 24h")
		}
		c.UpdateInterval = duration
	case "compose_file":
		c.ComposeFile = expandHome(value)
	case "compose_project":
		c.ComposeProject = value
	case "docker_binary":
		c.DockerBinary = value
	case "sandbox_image":
		c.SandboxImage = value
	case "sandbox_network":
		c.SandboxNetwork = value
	case "sandbox_idle":
		duration, err := time.ParseDuration(value)
		if err != nil || duration < time.Minute || duration > 24*time.Hour {
			return fmt.Errorf("sandbox_idle must be between 1m and 24h")
		}
		c.SandboxIdle = duration
	case "health_timeout_seconds":
		n, err := strconv.Atoi(value)
		if err != nil || n < 1 {
			return fmt.Errorf("health_timeout_seconds must be positive")
		}
		c.HealthTimeout = time.Duration(n) * time.Second
	case "drain_timeout_seconds":
		n, err := strconv.Atoi(value)
		if err != nil || n < 1 {
			return fmt.Errorf("drain_timeout_seconds must be positive")
		}
		c.DrainTimeout = time.Duration(n) * time.Second
	case "log_max_size":
		n, err := parseByteSize(value)
		if err != nil || n < 1024 {
			return fmt.Errorf("log_max_size is invalid")
		}
		c.LogMaxBytes = n
	case "log_max_files":
		n, err := strconv.Atoi(value)
		if err != nil || n < 1 || n > 100 {
			return fmt.Errorf("log_max_files must be between 1 and 100")
		}
		c.LogBackups = n
	case "command_max_bytes":
		n, err := strconv.ParseInt(value, 10, 64)
		if err != nil || n < 1024 {
			return fmt.Errorf("command_max_bytes must be at least 1024")
		}
		c.CommandMaxBytes = n
	default:
		return fmt.Errorf("unknown setting %q", key)
	}
	return nil
}

func (c Config) Validate() error {
	for name, path := range map[string]string{"data_root": c.DataRoot, "state_dir": c.StateDir, "socket_path": c.SocketPath, "internal_token_file": c.ControlTokenFile()} {
		if !filepath.IsAbs(path) {
			return fmt.Errorf("%s must be absolute", name)
		}
	}
	if c.ReleaseChannel == "" || c.ComposeProject == "" || c.DockerBinary == "" {
		return fmt.Errorf("release_channel, compose_project and docker_binary are required")
	}
	if c.SandboxIdle <= 0 || c.LogMaxBytes <= 0 || c.CommandMaxBytes <= 0 || c.UpdateInterval < 30*time.Second {
		return fmt.Errorf("duration and size limits must be positive")
	}
	mainAddress, err := validateListenAddress("listen", c.GatewayAddress, false)
	if err != nil {
		return err
	}
	lanAddress, err := validateListenAddress("lan_listen", c.LANAddress, true)
	if err != nil {
		return err
	}
	if c.LANEnabled && listenersOverlap(mainAddress, lanAddress) {
		return errors.New("lan_listen must use an address and port distinct from listen")
	}
	if _, err := DirectAccessPrefixes(c.DirectAccessCIDRs); err != nil {
		return err
	}
	if c.LANEnabled && len(c.DirectAccessCIDRs) == 0 {
		return errors.New("direct_access_cidrs must not be empty when LAN access is enabled")
	}
	if _, err := TrustedIngressPrefixes(c.TrustedIngressCIDRs); err != nil {
		return err
	}
	return nil
}

func validateListenAddress(name, value string, lan bool) (netip.AddrPort, error) {
	host, rawPort, err := net.SplitHostPort(strings.TrimSpace(value))
	if err != nil {
		return netip.AddrPort{}, fmt.Errorf("%s must be an IP literal and port", name)
	}
	address, err := netip.ParseAddr(host)
	if err != nil || address.Zone() != "" || address.IsMulticast() {
		return netip.AddrPort{}, fmt.Errorf("%s must use an unzoned unicast or unspecified IP literal", name)
	}
	port, err := strconv.Atoi(rawPort)
	if err != nil || port < 1 || port > 65535 {
		return netip.AddrPort{}, fmt.Errorf("%s port must be between 1 and 65535", name)
	}
	if lan && !address.IsPrivate() && !address.IsLoopback() {
		return netip.AddrPort{}, errors.New("lan_listen must bind a private or loopback address")
	}
	return netip.AddrPortFrom(address, uint16(port)), nil
}

func listenersOverlap(left, right netip.AddrPort) bool {
	if left.Port() != right.Port() || left.Addr().BitLen() != right.Addr().BitLen() {
		return false
	}
	return left.Addr() == right.Addr() || left.Addr().IsUnspecified() || right.Addr().IsUnspecified()
}

// DirectAccessPrefixes parses the exact private or loopback networks allowed
// to connect to the optional LAN listener. Public and non-canonical prefixes
// are rejected so a typo cannot broaden direct access.
func DirectAccessPrefixes(values []string) ([]netip.Prefix, error) {
	return validateCIDRs("direct_access_cidrs", values, true)
}

// TrustedIngressPrefixes parses networks whose reverse proxies may supply
// forwarding metadata. The set is deliberately limited to loopback and private
// networks; a public source can never become trusted through this setting.
func TrustedIngressPrefixes(values []string) ([]netip.Prefix, error) {
	return validateCIDRs("trusted_ingress_cidrs", values, true)
}

func validateCIDRs(name string, values []string, allowLoopback bool) ([]netip.Prefix, error) {
	if len(values) > 32 {
		return nil, fmt.Errorf("%s accepts at most 32 entries", name)
	}
	result := make([]netip.Prefix, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, raw := range values {
		value := strings.TrimSpace(raw)
		prefix, err := netip.ParsePrefix(value)
		if err != nil || prefix != prefix.Masked() || prefix.Addr().Zone() != "" {
			return nil, fmt.Errorf("%s contains invalid or non-canonical CIDR %q", name, raw)
		}
		if !prefixInsidePrivateNetwork(prefix) && !(allowLoopback && prefixInsideLoopbackNetwork(prefix)) {
			expected := "private"
			if allowLoopback {
				expected = "private or loopback"
			}
			return nil, fmt.Errorf("%s CIDR %q must be %s", name, raw, expected)
		}
		canonical := prefix.String()
		if _, exists := seen[canonical]; exists {
			return nil, fmt.Errorf("%s contains duplicate CIDR %q", name, canonical)
		}
		seen[canonical] = struct{}{}
		result = append(result, prefix)
	}
	return result, nil
}

func prefixInsidePrivateNetwork(value netip.Prefix) bool {
	allowed := []netip.Prefix{
		netip.MustParsePrefix("10.0.0.0/8"),
		netip.MustParsePrefix("172.16.0.0/12"),
		netip.MustParsePrefix("192.168.0.0/16"),
		netip.MustParsePrefix("fc00::/7"),
	}
	for _, network := range allowed {
		if value.Addr().BitLen() == network.Addr().BitLen() && value.Bits() >= network.Bits() && network.Contains(value.Addr()) {
			return true
		}
	}
	return false
}

func prefixInsideLoopbackNetwork(value netip.Prefix) bool {
	for _, network := range []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8"), netip.MustParsePrefix("::1/128")} {
		if value.Addr().BitLen() == network.Addr().BitLen() && value.Bits() >= network.Bits() && network.Contains(value.Addr()) {
			return true
		}
	}
	return false
}

func parseStringArray(value string) ([]string, error) {
	value = strings.TrimSpace(value)
	if len(value) < 2 || value[0] != '[' || value[len(value)-1] != ']' {
		return nil, errors.New("expected a TOML string array")
	}
	body := strings.TrimSpace(value[1 : len(value)-1])
	if body == "" {
		return []string{}, nil
	}
	parts := strings.Split(body, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		decoded, err := strconv.Unquote(part)
		if err != nil || decoded == "" {
			return nil, errors.New("entries must be non-empty quoted strings")
		}
		result = append(result, decoded)
	}
	return result, nil
}

// PlatformDataDir is the single authoritative host path mounted into the
// Platform container.
func (c Config) PlatformDataDir() string {
	return filepath.Join(filepath.Clean(c.DataRoot), "data")
}

// ControlTokenFile returns the effective Manager control capability path. An
// omitted setting uses the same state-root default as the Manager runtime.
func (c Config) ControlTokenFile() string {
	if strings.TrimSpace(c.InternalTokenFile) != "" {
		return filepath.Clean(c.InternalTokenFile)
	}
	return filepath.Join(filepath.Clean(c.StateDir), "secrets", "manager-token")
}

func parseByteSize(value string) (int64, error) {
	trimmed := strings.TrimSpace(value)
	units := []struct {
		suffix     string
		multiplier int64
	}{{"GiB", 1 << 30}, {"MiB", 1 << 20}, {"KiB", 1 << 10}, {"GB", 1000 * 1000 * 1000}, {"MB", 1000 * 1000}, {"KB", 1000}, {"B", 1}}
	for _, unit := range units {
		if strings.HasSuffix(trimmed, unit.suffix) {
			number := strings.TrimSpace(strings.TrimSuffix(trimmed, unit.suffix))
			parsed, err := strconv.ParseInt(number, 10, 64)
			if err != nil || parsed < 0 {
				return 0, errors.New("invalid byte size")
			}
			return parsed * unit.multiplier, nil
		}
	}
	return strconv.ParseInt(trimmed, 10, 64)
}

func expandHome(path string) string {
	if path == "~" || strings.HasPrefix(path, "~/") {
		if current, err := user.Current(); err == nil {
			if path == "~" {
				return current.HomeDir
			}
			return filepath.Join(current.HomeDir, strings.TrimPrefix(path, "~/"))
		}
	}
	return path
}
