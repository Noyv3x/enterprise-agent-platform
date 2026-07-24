package executor

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/contract"
	"github.com/ubitech/agent-platform/manager/internal/driver"
	"github.com/ubitech/agent-platform/manager/internal/sandbox"
)

type localSandboxEngine struct{ engineStub }

func (localSandboxEngine) ExecArgs(spec driver.SandboxSpec, _ string, command string, args []string) (string, []string) {
	result := append([]string(nil), args...)
	for index, value := range result {
		value = strings.ReplaceAll(value, contract.ContainerAgentEnv, spec.Environment)
		value = strings.ReplaceAll(value, contract.ContainerAgentHome, spec.Home)
		value = strings.ReplaceAll(value, contract.ContainerWorkspace, spec.Workspace)
		result[index] = value
	}
	return command, result
}

func TestSandboxProcessOutputAndControlSurviveManagerRestart(t *testing.T) {
	if _, err := os.Stat("/usr/bin/python3"); err != nil {
		t.Skip("python3 is required for the sandbox process protocol")
	}
	root := t.TempDir()
	engine := localSandboxEngine{}
	registry := filepath.Join(root, "manager", "sandboxes.json")
	sandboxes, err := sandbox.Open(engine, filepath.Join(root, "data"), registry, "sandbox@sha256:"+strings.Repeat("a", 64), "network", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	first := NewProcessManager(engine, sandboxes, 64<<10)
	call := Call{Identity: identity(), Target: "sandbox"}
	command := `i=0; while [ "$i" -lt 20 ]; do echo "line-$i"; i=$((i+1)); sleep .05; done; sleep 30`
	snapshot, err := first.Run(context.Background(), call, terminalArguments{Command: command, Background: true, UpdateBehavior: "terminate"})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		current, getErr := first.Get(call.ScopeID, call.LifecycleID, "sandbox", snapshot.ID)
		if getErr == nil && strings.Contains(current.Stdout, "line-5") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("sandbox output was not persisted while running: %#v %v", current, getErr)
		}
		time.Sleep(50 * time.Millisecond)
	}

	// Constructing a second manager simulates service restart: it has no docker
	// attach handle or in-memory command, only the durable process record/PID and
	// output files.
	second := NewProcessManager(engine, sandboxes, 64<<10)
	recovered, err := second.Get(call.ScopeID, call.LifecycleID, "sandbox", snapshot.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !activeProcessStatus(recovered.Status) || !strings.Contains(recovered.Stdout, "line-5") {
		t.Fatalf("running process was not reconstructed with output: %#v", recovered)
	}
	stopped, err := second.Kill(call.ScopeID, call.LifecycleID, "sandbox", snapshot.ID)
	if err != nil {
		second.mu.Lock()
		pidPath := second.processes[snapshot.ID].hostPIDFile
		second.mu.Unlock()
		pidData, _ := os.ReadFile(pidPath)
		t.Fatalf("%v (pid record %q)", err, pidData)
	}
	if stopped.Status != "cancelled" || stopped.StopConfirmed == nil || !*stopped.StopConfirmed {
		t.Fatalf("recovered process termination was not confirmed: %#v", stopped)
	}
	second.mu.Lock()
	pidFile := second.processes[snapshot.ID].hostPIDFile
	second.mu.Unlock()
	if _, err := os.Stat(pidFile); !os.IsNotExist(err) {
		t.Fatalf("confirmed stop left a live managed PID file: %v", err)
	}
}
