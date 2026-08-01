//go:build linux

package handoffhelper

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const startupLocatorEnvironment = "AGENT_PLATFORM_HANDOFF_TRANSACTION_DIRECTORY"

type SystemdRunner interface {
	Run(context.Context, string, ...string) ([]byte, error)
}

type ExecSystemdRunner struct{}

func (ExecSystemdRunner) Run(ctx context.Context, name string, arguments ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, name, arguments...)
	var output bytes.Buffer
	command.Stdout, command.Stderr = &output, &output
	if err := command.Run(); err != nil {
		return nil, fmt.Errorf("%s: %w: %s", name, err, strings.TrimSpace(output.String()))
	}
	if output.Len() > 64<<10 {
		return nil, errors.New("systemd command output exceeds 64 KiB")
	}
	return append([]byte(nil), output.Bytes()...), nil
}

type UnitState struct {
	LoadState     string
	ActiveState   string
	UnitFileState string
	FragmentPath  string
	MainPID       int
}

type UnitController interface {
	Inspect(context.Context, string, string) (UnitState, error)
	Enable(context.Context, string) error
	Disable(context.Context, string) error
	Stop(context.Context, string) error
	StartWithLocator(context.Context, string, string) error
}

// SystemdController is the production user-systemd boundary. It never invokes
// a shell and the only temporary Manager environment key it can set is the
// compile-time startup-channel locator above.
type SystemdController struct {
	Runner SystemdRunner
}

func (controller SystemdController) runner() SystemdRunner {
	if controller.Runner != nil {
		return controller.Runner
	}
	return ExecSystemdRunner{}
}

func (controller SystemdController) Inspect(ctx context.Context, unit, expectedFragment string) (UnitState, error) {
	if err := validateUnitIdentity(unit, expectedFragment); err != nil {
		return UnitState{}, err
	}
	output, err := controller.runner().Run(ctx, "systemctl", "--user", "show", unit, "--no-pager",
		"--property=LoadState", "--property=ActiveState", "--property=UnitFileState",
		"--property=FragmentPath", "--property=MainPID")
	if err != nil {
		return UnitState{}, err
	}
	properties := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		key, value, ok := strings.Cut(line, "=")
		if !ok || key == "" {
			return UnitState{}, errors.New("systemd returned malformed unit properties")
		}
		if _, duplicate := properties[key]; duplicate {
			return UnitState{}, errors.New("systemd returned duplicate unit properties")
		}
		properties[key] = value
	}
	for _, key := range []string{"LoadState", "ActiveState", "UnitFileState", "FragmentPath", "MainPID"} {
		if _, ok := properties[key]; !ok {
			return UnitState{}, fmt.Errorf("systemd omitted %s", key)
		}
	}
	pid, err := strconv.Atoi(properties["MainPID"])
	if err != nil || pid < 0 {
		return UnitState{}, errors.New("systemd returned an invalid MainPID")
	}
	state := UnitState{
		LoadState: properties["LoadState"], ActiveState: properties["ActiveState"],
		UnitFileState: properties["UnitFileState"], FragmentPath: properties["FragmentPath"], MainPID: pid,
	}
	if state.LoadState == "loaded" && state.FragmentPath != expectedFragment {
		return UnitState{}, errors.New("systemd unit fragment differs from the journal binding")
	}
	return state, nil
}

func (controller SystemdController) Enable(ctx context.Context, unit string) error {
	return controller.simple(ctx, "enable", unit)
}

func (controller SystemdController) Disable(ctx context.Context, unit string) error {
	return controller.simple(ctx, "disable", unit)
}

func (controller SystemdController) Stop(ctx context.Context, unit string) error {
	return controller.simple(ctx, "stop", unit)
}

func (controller SystemdController) simple(ctx context.Context, verb, unit string) error {
	if !validUnitName(unit) {
		return errors.New("systemd unit name is invalid")
	}
	_, err := controller.runner().Run(ctx, "systemctl", "--user", verb, unit)
	return err
}

func (controller SystemdController) StartWithLocator(ctx context.Context, unit, transactionDirectory string) (resultErr error) {
	if !validUnitName(unit) || !canonicalAbsolute(transactionDirectory) || !transactionPattern.MatchString(filepath.Base(transactionDirectory)) {
		return errors.New("systemd participant startup binding is invalid")
	}
	runner := controller.runner()
	assignment := startupLocatorEnvironment + "=" + transactionDirectory
	if _, err := runner.Run(ctx, "systemctl", "--user", "set-environment", assignment); err != nil {
		return fmt.Errorf("set handoff startup locator: %w", err)
	}
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, cleanupErr := runner.Run(cleanupCtx, "systemctl", "--user", "unset-environment", startupLocatorEnvironment)
		if cleanupErr != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("clear handoff startup locator: %w", cleanupErr))
		}
	}()
	if _, err := runner.Run(ctx, "systemctl", "--user", "start", unit); err != nil {
		return fmt.Errorf("start handoff participant unit: %w", err)
	}
	return nil
}

func validateUnitIdentity(unit, fragment string) error {
	if !validUnitName(unit) || !canonicalAbsolute(fragment) || filepath.Base(fragment) != unit {
		return errors.New("systemd unit identity is invalid")
	}
	return nil
}

func validUnitName(unit string) bool {
	if unit == "" || filepath.Base(unit) != unit || !strings.HasSuffix(unit, ".service") || len(unit) > 255 {
		return false
	}
	for _, character := range unit {
		if !(character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' || strings.ContainsRune("_.@-", character)) {
			return false
		}
	}
	return true
}
