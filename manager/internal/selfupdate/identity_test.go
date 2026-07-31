package selfupdate

import (
	"testing"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

func TestManagerUsesVerifiedTargetTechnicalProfile(t *testing.T) {
	active, err := identity.ActivateVerifiedHandoffTarget(identity.TargetProfile())
	if err != nil {
		t.Fatal(err)
	}
	manager := &Manager{Profile: active}
	if err := manager.ValidateTechnicalProfile(); err != nil {
		t.Fatal(err)
	}

	target := identity.TargetProfile()
	if got := manager.managerBinaryName(); got != target.ManagerBinary {
		t.Fatalf("manager binary = %q, want %q", got, target.ManagerBinary)
	}
	if got := manager.managerUnitName(); got != target.ManagerUnit {
		t.Fatalf("manager unit = %q, want %q", got, target.ManagerUnit)
	}
	if got := manager.watchdogUnitPrefix(); got != target.WatchdogUnitPrefix {
		t.Fatalf("watchdog prefix = %q, want %q", got, target.WatchdogUnitPrefix)
	}
	if got := manager.recoveryWatchdogUnitPrefix(); got != target.RecoveryWatchdogUnitPrefix {
		t.Fatalf("recovery watchdog prefix = %q, want %q", got, target.RecoveryWatchdogUnitPrefix)
	}
}

func TestManagerRejectsMissingTechnicalProfile(t *testing.T) {
	if err := (&Manager{}).ValidateTechnicalProfile(); err == nil {
		t.Fatal("expected missing technical profile to be rejected")
	}
}
