package sandbox

import (
	"fmt"
	"strings"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/driver"
)

func NormalizeProfile(profile string) (string, error) {
	switch profile {
	case "", "agent":
		return "agent", nil
	case "chat":
		return "chat", nil
	default:
		return "", fmt.Errorf("unknown sandbox profile %q", profile)
	}
}

func validateWorkspaceProfile(workspace, profile string) error {
	chat := strings.HasPrefix(workspace, "chat-user-")
	if (profile == "chat") != chat {
		return fmt.Errorf("workspace_id %q is incompatible with profile %q", workspace, profile)
	}
	return nil
}

func (m *Manager) applyResources(spec *driver.SandboxSpec, profile string) {
	resources := m.AgentResources
	if profile == "chat" {
		resources = m.ChatResources
		spec.Network = "none"
	}
	spec.Memory, spec.MemorySwap, spec.CPUs, spec.PidsLimit = resources.Memory, resources.MemorySwap, resources.CPUs, resources.PidsLimit
}

func (m *Manager) idleFor(profile string) time.Duration {
	if profile == "chat" {
		return m.ChatIdle
	}
	return m.Idle
}
