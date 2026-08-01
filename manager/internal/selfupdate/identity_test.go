package selfupdate

import (
	"strings"
	"testing"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/releasetest"
)

func TestManagerUsesVerifiedTargetTechnicalProfile(t *testing.T) {
	active := identity.CompileTimeActiveProfile()
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

func TestSelfUpdateManifestValidationUsesTheRoutedProfile(t *testing.T) {
	target := identity.CompileTimeActiveProfile()
	manifest := releasetest.NewTarget(strings.Repeat("a", 40)).Manifest
	if err := validateSelfUpdateManifest(target, manifest); err != nil {
		t.Fatalf("routed target rejected schema 2 Candidate: %v", err)
	}
	if err := validateSelfUpdateManifest(identity.ActiveProfile{}, manifest); err == nil ||
		!strings.Contains(err.Error(), "technical profile") {
		t.Fatalf("missing technical identity accepted target Candidate: %v", err)
	}
}
