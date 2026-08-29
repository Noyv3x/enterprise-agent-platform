package config

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
)

type Public struct {
	UpdateEnabled       bool     `json:"update_enabled"`
	UpdateInterval      int      `json:"update_interval"`
	ReleaseManifestURL  string   `json:"release_manifest_url"`
	LANEnabled          bool     `json:"lan_enabled"`
	LANListen           string   `json:"lan_listen"`
	DirectAccessCIDRs   []string `json:"direct_access_cidrs"`
	TrustedIngressCIDRs []string `json:"trusted_ingress_cidrs"`
	LANActive           bool     `json:"lan_active"`
	LANError            string   `json:"lan_error,omitempty"`
}
type Patch struct {
	UpdateEnabled       *bool     `json:"update_enabled,omitempty"`
	UpdateInterval      *int      `json:"update_interval,omitempty"`
	ReleaseManifestURL  *string   `json:"release_manifest_url,omitempty"`
	LANEnabled          *bool     `json:"lan_enabled,omitempty"`
	LANListen           *string   `json:"lan_listen,omitempty"`
	DirectAccessCIDRs   *[]string `json:"direct_access_cidrs,omitempty"`
	TrustedIngressCIDRs *[]string `json:"trusted_ingress_cidrs,omitempty"`
}

type Manager struct {
	mu        sync.RWMutex
	value     Config
	lanActive bool
	lanError  string
	lanApply  func(Config) (bool, error)
}

func NewManager(value Config) *Manager { return &Manager{value: value} }
func (m *Manager) Config() Config      { m.mu.RLock(); defer m.mu.RUnlock(); return m.value }
func (m *Manager) Public() Public {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return public(m.value, m.lanActive, m.lanError)
}

func (m *Manager) SetLANStatus(active bool, err error) {
	m.mu.Lock()
	m.lanActive = active
	if err != nil {
		m.lanError = "LAN listener is unavailable"
	} else {
		m.lanError = ""
	}
	m.mu.Unlock()
}

// SetLANApply installs the sole runtime owner for LAN listener changes. The
// callback must not call back into Manager: Patch holds the configuration lock
// so applying a listener and committing its persisted configuration form one
// serialized transaction.
func (m *Manager) SetLANApply(apply func(Config) (bool, error)) {
	m.mu.Lock()
	m.lanApply = apply
	m.mu.Unlock()
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
	if update.LANEnabled != nil {
		next.LANEnabled = *update.LANEnabled
	}
	if update.LANListen != nil {
		next.LANAddress = strings.TrimSpace(*update.LANListen)
	}
	if update.DirectAccessCIDRs != nil {
		next.DirectAccessCIDRs = append([]string(nil), (*update.DirectAccessCIDRs)...)
	}
	if update.TrustedIngressCIDRs != nil {
		next.TrustedIngressCIDRs = append([]string(nil), (*update.TrustedIngressCIDRs)...)
	}
	if err := next.Validate(); err != nil {
		return Public{}, err
	}
	lanChanged := !sameLANConfig(m.value, next)
	lanApplied := false
	lanActive := m.lanActive
	if lanChanged && m.lanApply != nil {
		active, err := m.lanApply(next)
		if err != nil {
			m.lanError = "LAN listener is unavailable"
			return Public{}, err
		}
		lanApplied = true
		lanActive = active
	}
	if err := atomicfile.WriteFile(next.ConfigPath, []byte(render(next)), 0o600); err != nil {
		if lanApplied {
			active, rollbackErr := m.lanApply(m.value)
			m.lanActive = active
			if rollbackErr != nil {
				m.lanActive = false
				m.lanError = "LAN listener is unavailable"
			}
		}
		return Public{}, err
	}
	m.value = next
	if lanChanged {
		m.lanActive = lanActive
		m.lanError = ""
	}
	return public(next, m.lanActive, m.lanError), nil
}

func sameLANConfig(left, right Config) bool {
	return left.LANEnabled == right.LANEnabled && left.LANAddress == right.LANAddress &&
		slices.Equal(left.DirectAccessCIDRs, right.DirectAccessCIDRs) &&
		slices.Equal(left.TrustedIngressCIDRs, right.TrustedIngressCIDRs)
}

func public(value Config, lanActive bool, lanError string) Public {
	return Public{
		UpdateEnabled:       value.UpdateEnabled,
		UpdateInterval:      int(value.UpdateInterval / time.Second),
		ReleaseManifestURL:  value.ReleaseURL,
		LANEnabled:          value.LANEnabled,
		LANListen:           value.LANAddress,
		DirectAccessCIDRs:   append([]string(nil), value.DirectAccessCIDRs...),
		TrustedIngressCIDRs: append([]string(nil), value.TrustedIngressCIDRs...),
		LANActive:           lanActive,
		LANError:            lanError,
	}
}

func render(c Config) string {
	return fmt.Sprintf(`data_root = %q
listen = %q
lan_enabled = %t
lan_listen = %q
direct_access_cidrs = %s
trusted_ingress_cidrs = %s
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
internal_token_file = %q
compose_file = %q
compose_project = %q
docker_binary = %q
sandbox_image = %q
sandbox_network = %q
health_timeout_seconds = %d
drain_timeout_seconds = %d
command_max_bytes = %d
`, c.DataRoot, c.GatewayAddress, c.LANEnabled, c.LANAddress, formatStringArray(c.DirectAccessCIDRs), formatStringArray(c.TrustedIngressCIDRs), c.ReleaseURL, c.ReleaseChannel, c.UpdateEnabled, c.UpdateInterval.String(), c.SandboxIdle.String(), formatByteSize(c.LogMaxBytes), c.LogBackups, c.SocketPath, c.PlatformURL, c.PlatformGateURL, c.InternalTokenFile, c.ComposeFile, c.ComposeProject, c.DockerBinary, c.SandboxImage, c.SandboxNetwork, int(c.HealthTimeout/time.Second), int(c.DrainTimeout/time.Second), c.CommandMaxBytes)
}

func formatStringArray(values []string) string {
	quoted := make([]string, 0, len(values))
	for _, value := range values {
		quoted = append(quoted, fmt.Sprintf("%q", value))
	}
	return "[" + strings.Join(quoted, ", ") + "]"
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
