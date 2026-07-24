package config

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/atomicfile"
)

type Public struct {
	UpdateEnabled      bool   `json:"update_enabled"`
	UpdateInterval     int    `json:"update_interval"`
	ReleaseManifestURL string `json:"release_manifest_url"`
}
type Patch struct {
	UpdateEnabled      *bool   `json:"update_enabled,omitempty"`
	UpdateInterval     *int    `json:"update_interval,omitempty"`
	ReleaseManifestURL *string `json:"release_manifest_url,omitempty"`
}

type Manager struct {
	mu    sync.RWMutex
	value Config
}

func NewManager(value Config) *Manager { return &Manager{value: value} }
func (m *Manager) Config() Config      { m.mu.RLock(); defer m.mu.RUnlock(); return m.value }
func (m *Manager) Public() Public {
	value := m.Config()
	return Public{UpdateEnabled: value.UpdateEnabled, UpdateInterval: int(value.UpdateInterval / time.Second), ReleaseManifestURL: value.ReleaseURL}
}
func (m *Manager) Patch(update Patch) (Public, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	next := m.value
	if update.UpdateEnabled != nil {
		next.UpdateEnabled = *update.UpdateEnabled
	}
	if update.UpdateInterval != nil {
		if *update.UpdateInterval < 30 || *update.UpdateInterval > 86400 {
			return Public{}, errors.New("update_interval must be between 30 and 86400 seconds")
		}
		next.UpdateInterval = time.Duration(*update.UpdateInterval) * time.Second
	}
	if update.ReleaseManifestURL != nil {
		value := strings.TrimSpace(*update.ReleaseManifestURL)
		if value != "" && !strings.HasPrefix(value, "https://") && !strings.HasPrefix(value, "http://127.0.0.1") && !strings.HasPrefix(value, "http://[::1]") {
			return Public{}, errors.New("release_manifest_url must use https or loopback http")
		}
		next.ReleaseURL = value
	}
	if err := next.Validate(); err != nil {
		return Public{}, err
	}
	if err := atomicfile.WriteFile(next.ConfigPath, []byte(render(next)), 0o600); err != nil {
		return Public{}, err
	}
	m.value = next
	return Public{UpdateEnabled: next.UpdateEnabled, UpdateInterval: int(next.UpdateInterval / time.Second), ReleaseManifestURL: next.ReleaseURL}, nil
}
func render(c Config) string {
	return fmt.Sprintf(`data_root = %q
listen = %q
release_manifest_url = %q
release_channel = %q
update_enabled = %t
update_interval = %q
sandbox_idle = %q
log_max_size = %q
log_max_files = %d
socket_path = %q
platform_url = %q
platform_gate_url = %q
legacy_platform_gate_url = %q
internal_token_file = %q
compose_file = %q
compose_project = %q
docker_binary = %q
sandbox_image = %q
sandbox_network = %q
health_timeout_seconds = %d
drain_timeout_seconds = %d
command_max_bytes = %d
`, c.DataRoot, c.GatewayAddress, c.ReleaseURL, c.ReleaseChannel, c.UpdateEnabled, c.UpdateInterval.String(), c.SandboxIdle.String(), formatByteSize(c.LogMaxBytes), c.LogBackups, c.SocketPath, c.PlatformURL, c.PlatformGateURL, c.LegacyPlatformGateURL, c.InternalTokenFile, c.ComposeFile, c.ComposeProject, c.DockerBinary, c.SandboxImage, c.SandboxNetwork, int(c.HealthTimeout/time.Second), int(c.DrainTimeout/time.Second), c.CommandMaxBytes)
}
func formatByteSize(value int64) string {
	if value%(1<<30) == 0 {
		return fmt.Sprintf("%dGiB", value/(1<<30))
	}
	if value%(1<<20) == 0 {
		return fmt.Sprintf("%dMiB", value/(1<<20))
	}
	if value%(1<<10) == 0 {
		return fmt.Sprintf("%dKiB", value/(1<<10))
	}
	return fmt.Sprintf("%dB", value)
}
