package selfupdate

import (
	"fmt"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

func (m *Manager) ValidateTechnicalProfile() error {
	if m == nil {
		return fmt.Errorf("Manager is required")
	}
	if err := m.Profile.Validate(); err != nil {
		return fmt.Errorf("self-update technical profile: %w", err)
	}
	return nil
}

func (m *Manager) technicalProfile() identity.Profile {
	profile, _ := m.Profile.Profile()
	return profile
}

func (m *Manager) managerBinaryName() string { return m.technicalProfile().ManagerBinary }
