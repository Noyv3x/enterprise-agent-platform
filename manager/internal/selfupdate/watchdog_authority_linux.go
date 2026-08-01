//go:build linux

package selfupdate

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

// WatchdogBinding is constructed from the already-routed, authenticated
// Manager Config. Its fields are intentionally private so argv or a plan file
// cannot manufacture a different runtime root/profile.
type WatchdogBinding struct {
	active           identity.ActiveProfile
	configPath       string
	root             string
	statePath        string
	activationRoot   string
	installPath      string
	socketPath       string
	controlTokenFile string
	unitName         string
	// bindingValidator is an unexported test seam for state-machine fixtures
	// whose temporary roots intentionally do not use the installed profile
	// basenames. Production bindings never set it.
	bindingValidator func(WatchdogBinding) error
	processVerifier  func(context.Context, WatchdogBinding, Plan, string, string) error
}

// WatchdogBinding returns the exact runtime authority represented by m. The
// caller must populate Manager paths from the retained startup Config and the
// Router-selected stable binary, never from ambient XDG values.
func (m *Manager) WatchdogBinding() (WatchdogBinding, error) {
	if err := m.ValidateTechnicalProfile(); err != nil {
		return WatchdogBinding{}, err
	}
	profile, err := m.Profile.Profile()
	if err != nil {
		return WatchdogBinding{}, err
	}
	unit := m.UnitName
	if unit == "" {
		unit = profile.ManagerUnit
	}
	binding := WatchdogBinding{
		active: m.Profile, configPath: m.ConfigPath, root: m.Root, statePath: m.StatePath,
		activationRoot: filepath.Join(m.Root, "activations"), installPath: m.InstallPath,
		socketPath: m.SocketPath, controlTokenFile: m.ControlTokenFile, unitName: unit,
	}
	if err := binding.validate(); err != nil {
		return WatchdogBinding{}, err
	}
	return binding, nil
}

func (binding WatchdogBinding) validate() error {
	if binding.bindingValidator != nil {
		return binding.bindingValidator(binding)
	}
	if err := binding.active.Validate(); err != nil {
		return fmt.Errorf("watchdog technical profile: %w", err)
	}
	profile, err := binding.active.Profile()
	if err != nil {
		return err
	}
	for name, path := range map[string]string{
		"config": binding.configPath, "binary root": binding.root, "state": binding.statePath,
		"activation root": binding.activationRoot, "stable binary": binding.installPath,
		"control socket": binding.socketPath, "control token": binding.controlTokenFile,
	} {
		if path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path || strings.ContainsRune(path, 0) {
			return fmt.Errorf("watchdog %s path is invalid", name)
		}
	}
	if binding.activationRoot != filepath.Join(binding.root, "activations") ||
		binding.statePath != filepath.Join(filepath.Dir(binding.root), "manager-binaries.json") ||
		filepath.Base(binding.root) != "manager-binaries" ||
		filepath.Base(binding.installPath) != profile.ManagerBinary || binding.unitName != profile.ManagerUnit {
		return errors.New("watchdog binding differs from the routed Manager profile")
	}
	return nil
}

func (binding WatchdogBinding) validatePlan(planPath string, plan Plan) error {
	if err := binding.validate(); err != nil {
		return err
	}
	if planPath == "" || !filepath.IsAbs(planPath) || filepath.Clean(planPath) != planPath ||
		filepath.Dir(planPath) != binding.activationRoot || plan.PlanPath != planPath ||
		plan.StatePath != binding.statePath || plan.InstallPath != binding.installPath ||
		plan.SocketPath != binding.socketPath || plan.ControlTokenFile != binding.controlTokenFile ||
		plan.UnitName != binding.unitName {
		return errors.New("activation plan differs from the routed watchdog authority")
	}
	if !pathWithin(filepath.Join(binding.root, "versions"), plan.CandidatePath) ||
		!pathWithin(filepath.Join(binding.root, "versions"), plan.PreviousPath) {
		return errors.New("activation plan executable is outside the routed Manager version root")
	}
	return nil
}

func (binding WatchdogBinding) verifyCurrentProcess(ctx context.Context, plan Plan, immutablePath, expectedSHA string) error {
	if binding.processVerifier != nil {
		return binding.processVerifier(ctx, binding, plan, immutablePath, expectedSHA)
	}
	profile, _ := binding.active.Profile()
	unit := profile.WatchdogUnitPrefix + safeID(plan.PlatformCommit[:12])
	if plan.Mode == recoveryActivationMode {
		unit = profile.RecoveryWatchdogUnitPrefix + safeID(expectedSHA[:12])
	}
	mainPIDText, err := recoverySystemdProperty(ctx, unit, "MainPID")
	if err != nil {
		return err
	}
	controlPIDText, err := recoverySystemdProperty(ctx, unit, "ControlPID")
	if err != nil {
		return err
	}
	controlGroup, err := recoverySystemdProperty(ctx, unit, "ControlGroup")
	if err != nil {
		return err
	}
	mainPID, mainErr := strconv.Atoi(mainPIDText)
	controlPID, controlErr := strconv.Atoi(controlPIDText)
	if mainErr != nil || mainPID != os.Getpid() || controlErr != nil || controlPID != 0 || controlGroup == "" || controlGroup == "/" {
		return errors.New("watchdog process is not the exact systemd unit owner")
	}
	if _, err := readBoundRunningExecutable("/proc/self/exe", immutablePath, expectedSHA); err != nil {
		return err
	}
	commandData, err := os.ReadFile("/proc/self/cmdline")
	if err != nil {
		return fmt.Errorf("read watchdog command line: %w", err)
	}
	arguments := strings.Split(strings.TrimRight(string(commandData), "\x00"), "\x00")
	want := []string{arguments[0], "self-update-watchdog", "--plan", plan.PlanPath, "--config", binding.configPath}
	if !reflect.DeepEqual(arguments, want) {
		return errors.New("watchdog command line does not exactly own the routed plan and config")
	}
	cgroupData, err := os.ReadFile("/proc/self/cgroup")
	if err != nil || !recoveryProcessInExactControlGroup(cgroupData, controlGroup) {
		return errors.New("watchdog process is outside its exact systemd control group")
	}
	return nil
}
