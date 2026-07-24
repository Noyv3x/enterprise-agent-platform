package config

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/contract"
)

type Config struct {
	ConfigPath            string
	DataRoot              string
	StateDir              string
	DataDir               string
	SocketPath            string
	GatewayAddress        string
	PlatformURL           string
	PlatformGateURL       string
	LegacyPlatformGateURL string
	InternalToken         string
	InternalTokenFile     string
	ReleaseURL            string
	ReleaseChannel        string
	UpdateEnabled         bool
	UpdateInterval        time.Duration
	ComposeFile           string
	ComposeProject        string
	DockerBinary          string
	SandboxImage          string
	SandboxNetwork        string
	SandboxIdle           time.Duration
	HealthTimeout         time.Duration
	DrainTimeout          time.Duration
	LogMaxBytes           int64
	LogBackups            int
	CommandMaxBytes       int64
	dataDirExplicit       bool
}

// SourceMigrationExpectations are bridge-owned values that must agree with
// the persisted Manager configuration before a source deployment hands over
// control. Mutable tuning and secrets deliberately do not belong here.
type SourceMigrationExpectations struct {
	DataRoot           string
	GatewayAddress     string
	ReleaseManifestURL string
	ReleaseChannel     string
	LegacyPlatformURL  string
	ControlSocketPath  string
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
	dataRoot := filepath.Join(dataHome, "ubitech-agent")
	stateDir := filepath.Join(dataRoot, "manager")
	dataDir := filepath.Join(dataRoot, "data")
	return Config{
		ConfigPath:      filepath.Join(configHome, "ubitech-agent", "manager.toml"),
		DataRoot:        dataRoot,
		StateDir:        stateDir,
		DataDir:         dataDir,
		SocketPath:      filepath.Join(stateDir, "control", "manager.sock"),
		GatewayAddress:  "127.0.0.1:8080",
		PlatformURL:     "http://127.0.0.1:18080",
		PlatformGateURL: "http://127.0.0.1:18080",
		ReleaseChannel:  contract.ReleaseChannel,
		UpdateEnabled:   true,
		UpdateInterval:  5 * time.Minute,
		ComposeProject:  "ubitech-agent",
		DockerBinary:    "docker",
		SandboxNetwork:  "ubitech-agent_core",
		SandboxIdle:     time.Duration(contract.SandboxIdleSeconds) * time.Second,
		HealthTimeout:   2 * time.Minute,
		DrainTimeout:    5 * time.Minute,
		LogMaxBytes:     10 << 20,
		LogBackups:      5,
		CommandMaxBytes: 1 << 20,
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
		c.DataRoot = root
		c.StateDir = filepath.Join(root, "manager")
		if !c.dataDirExplicit {
			c.DataDir = filepath.Join(root, "data")
		}
		c.SocketPath = filepath.Join(root, "manager", "control", "manager.sock")
	case "state_dir":
		c.StateDir = expandHome(value)
	case "data_dir":
		c.DataDir = expandHome(value)
		c.dataDirExplicit = true
	case "socket_path":
		c.SocketPath = expandHome(value)
	case "gateway_address":
		c.GatewayAddress = value
	case "listen":
		c.GatewayAddress = value
	case "platform_url":
		c.PlatformURL = value
	case "platform_gate_url":
		c.PlatformGateURL = value
	case "legacy_platform_gate_url":
		c.LegacyPlatformGateURL = value
	case "internal_token":
		return errors.New("internal_token plaintext is not accepted; use internal_token_file")
	case "internal_token_file":
		c.InternalTokenFile = expandHome(value)
	case "release_url":
		c.ReleaseURL = value
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
	case "update_interval_seconds":
		n, err := strconv.Atoi(value)
		if err != nil || n < 30 || n > 86400 {
			return fmt.Errorf("update_interval_seconds must be between 30 and 86400")
		}
		c.UpdateInterval = time.Duration(n) * time.Second
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
	case "sandbox_idle_seconds":
		n, err := strconv.Atoi(value)
		if err != nil || n < 1 {
			return fmt.Errorf("sandbox_idle_seconds must be positive")
		}
		c.SandboxIdle = time.Duration(n) * time.Second
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
	case "log_max_bytes":
		n, err := strconv.ParseInt(value, 10, 64)
		if err != nil || n < 1024 {
			return fmt.Errorf("log_max_bytes must be at least 1024")
		}
		c.LogMaxBytes = n
	case "log_max_size":
		n, err := parseByteSize(value)
		if err != nil || n < 1024 {
			return fmt.Errorf("log_max_size is invalid")
		}
		c.LogMaxBytes = n
	case "log_backups":
		n, err := strconv.Atoi(value)
		if err != nil || n < 1 {
			return fmt.Errorf("log_backups must be positive")
		}
		c.LogBackups = n
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
	for name, path := range map[string]string{"data_root": c.DataRoot, "state_dir": c.StateDir, "data_dir": c.DataDir, "socket_path": c.SocketPath} {
		if !filepath.IsAbs(path) {
			return fmt.Errorf("%s must be absolute", name)
		}
	}
	if filepath.Clean(c.DataDir) != c.PlatformDataDir() {
		return fmt.Errorf("data_dir must equal data_root/data (%s)", c.PlatformDataDir())
	}
	if c.ReleaseChannel == "" || c.ComposeProject == "" || c.DockerBinary == "" {
		return fmt.Errorf("release_channel, compose_project and docker_binary are required")
	}
	if c.SandboxIdle <= 0 || c.LogMaxBytes <= 0 || c.CommandMaxBytes <= 0 || c.UpdateInterval < 30*time.Second {
		return fmt.Errorf("duration and size limits must be positive")
	}
	return nil
}

// PlatformDataDir is the single authoritative host path mounted into the
// Platform container. DataDir remains parseable only as a compatibility
// assertion for older manager.toml files; Validate rejects any divergent value.
func (c Config) PlatformDataDir() string {
	return filepath.Join(filepath.Clean(c.DataRoot), "data")
}

// ValidateSourceMigration compares values after manager.toml has passed
// through the Manager's canonical parser. Paths are cleaned so harmless
// trailing separators do not create false mismatches; network and catalog
// values remain exact trust-boundary inputs.
func (c Config) ValidateSourceMigration(expected SourceMigrationExpectations) error {
	if err := c.Validate(); err != nil {
		return fmt.Errorf("invalid effective Manager configuration: %w", err)
	}
	required := map[string]string{
		"data_root":                expected.DataRoot,
		"listen":                   expected.GatewayAddress,
		"release_manifest_url":     expected.ReleaseManifestURL,
		"release_channel":          expected.ReleaseChannel,
		"legacy_platform_gate_url": expected.LegacyPlatformURL,
		"socket_path":              expected.ControlSocketPath,
	}
	for name, value := range required {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("source migration expectation %s is required", name)
		}
	}

	configured := map[string]string{
		"data_root":                filepath.Clean(c.DataRoot),
		"listen":                   c.GatewayAddress,
		"release_manifest_url":     c.ReleaseURL,
		"release_channel":          c.ReleaseChannel,
		"legacy_platform_gate_url": c.LegacyPlatformGateURL,
		"socket_path":              filepath.Clean(c.SocketPath),
	}
	expectedValues := map[string]string{
		"data_root":                filepath.Clean(expected.DataRoot),
		"listen":                   expected.GatewayAddress,
		"release_manifest_url":     expected.ReleaseManifestURL,
		"release_channel":          expected.ReleaseChannel,
		"legacy_platform_gate_url": expected.LegacyPlatformURL,
		"socket_path":              filepath.Clean(expected.ControlSocketPath),
	}
	for _, name := range []string{"data_root", "listen", "release_manifest_url", "release_channel", "legacy_platform_gate_url", "socket_path"} {
		if configured[name] != expectedValues[name] {
			return fmt.Errorf("source migration config mismatch for %s: configured %q, expected %q", name, configured[name], expectedValues[name])
		}
	}
	return nil
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
