//go:build linux

package handoffhelper

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

type systemdRunnerFake struct {
	calls    [][]string
	show     string
	startErr error
	unsetErr error
}

func (runner *systemdRunnerFake) Run(_ context.Context, name string, arguments ...string) ([]byte, error) {
	call := append([]string{name}, arguments...)
	runner.calls = append(runner.calls, call)
	joined := strings.Join(arguments, " ")
	if strings.Contains(joined, " show ") || len(arguments) > 1 && arguments[1] == "show" {
		return []byte(runner.show), nil
	}
	if len(arguments) > 1 && arguments[1] == "start" {
		return nil, runner.startErr
	}
	if len(arguments) > 1 && arguments[1] == "unset-environment" {
		return nil, runner.unsetErr
	}
	return nil, nil
}

func TestSystemdControllerStrictInspectAndLocatorCleanup(t *testing.T) {
	runner := &systemdRunnerFake{show: "LoadState=loaded\nActiveState=active\nUnitFileState=disabled\nFragmentPath=/units/agent-platform-manager.service\nMainPID=42\n"}
	controller := SystemdController{Runner: runner}
	state, err := controller.Inspect(context.Background(), "agent-platform-manager.service", "/units/agent-platform-manager.service")
	if err != nil {
		t.Fatal(err)
	}
	if state.MainPID != 42 || state.ActiveState != "active" || state.UnitFileState != "disabled" {
		t.Fatalf("unit state = %+v", state)
	}
	directory := "/state/agent-platform/handoff/handoff_0123456789abcdef0123456789abcdef"
	runner.startErr = errors.New("start failed")
	runner.unsetErr = errors.New("unset failed")
	err = controller.StartWithLocator(context.Background(), "agent-platform-manager.service", directory)
	if err == nil || !strings.Contains(err.Error(), "start failed") || !strings.Contains(err.Error(), "unset failed") {
		t.Fatalf("joined locator cleanup error = %v", err)
	}
	wantTail := [][]string{
		{"systemctl", "--user", "set-environment", startupLocatorEnvironment + "=" + directory},
		{"systemctl", "--user", "start", "agent-platform-manager.service"},
		{"systemctl", "--user", "unset-environment", startupLocatorEnvironment},
	}
	if got := runner.calls[len(runner.calls)-3:]; !reflect.DeepEqual(got, wantTail) {
		t.Fatalf("locator calls = %#v, want %#v", got, wantTail)
	}
}

func TestSystemdControllerRejectsDuplicateOrChangedProperties(t *testing.T) {
	runner := &systemdRunnerFake{show: "LoadState=loaded\nActiveState=active\nActiveState=inactive\nUnitFileState=enabled\nFragmentPath=/units/source.service\nMainPID=1\n"}
	if _, err := (SystemdController{Runner: runner}).Inspect(context.Background(), "source.service", "/units/source.service"); err == nil {
		t.Fatal("duplicate systemd property was accepted")
	}
}
