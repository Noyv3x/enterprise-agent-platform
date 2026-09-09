package executor

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const retainedProjectionCanary = "retained_synthetic_bearer_791bc54"

// This helper is invoked only by this file's bounded, test-owned host commands.
// No environment marker is needed: argv still works when inheritance is fixed.
func TestRetainedProjectionHelper(t *testing.T) {
	if len(os.Args) < 3 || os.Args[len(os.Args)-2] != "--retained-projection-helper" {
		return
	}
	switch os.Args[len(os.Args)-1] {
	case "output":
		fmt.Print("Authorization: Bearer " + retainedProjectionCanary)
	default:
		os.Exit(2)
	}
	os.Exit(0)
}

func retainedProjectionTerminal(t *testing.T, service *Service, mode string, durable bool) ProcessSnapshot {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	quote := func(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'" }
	command := "exec " + quote(executable) + " -test.run=^TestRetainedProjectionHelper$ -- --retained-projection-helper " + mode
	arguments, err := json.Marshal(terminalArguments{Command: command, CWD: "/workspace", TimeoutMS: 5000, Background: durable})
	if err != nil {
		t.Fatal(err)
	}
	request := AuditRequest{Identity: identity(), AuditID: "retained-projection-terminal", Target: "host", Operation: "terminal", Action: "run", Arguments: arguments, Details: map[string]any{"command": "test-owned helper (safe display)"}}
	receipt, err := service.Audit(request)
	if err != nil {
		t.Fatal(err)
	}
	call := Call{Identity: request.Identity, AuditID: receipt.AuditID, ExecutorID: receipt.ExecutorID, Target: "host", Action: "run", Arguments: arguments}
	if durable {
		call.CompletionRequired = true
		call.CompletionOwnerID = strings.Repeat("a", 64)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	response, err := service.Terminal(ctx, call)
	if err != nil {
		t.Fatal(err)
	}
	result := response["result"].(ProcessSnapshot)
	service.Processes.mu.Lock()
	process := service.Processes.processes[result.ID]
	service.Processes.mu.Unlock()
	// Wait on the controller, not merely the returned status: persisted output is
	// committed before done closes. Cancellation never affects unrelated PIDs.
	t.Cleanup(func() {
		process.cancel()
		select {
		case <-process.done:
		case <-time.After(8 * time.Second):
			t.Error("test-owned helper controller did not finish")
		}
	})
	select {
	case <-process.done:
	case <-ctx.Done():
		t.Fatal("test-owned helper did not finish within deadline")
	}
	result, err = service.Processes.Get(call.ScopeID, call.LifecycleID, "host", result.ID)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "completed" || result.ExitCode == nil || *result.ExitCode != 0 {
		t.Fatalf("helper failed: status=%s stderr=%q", result.Status, result.Stderr)
	}
	return result
}

func TestRetainedProjectionRetainedOutput(t *testing.T) {
	for _, durable := range []bool{false, true} {
		name := "ordinary-host"
		if durable {
			name = "completion-owned-host"
		}
		t.Run(name, func(t *testing.T) {
			service, root := newTestService(t)
			result := retainedProjectionTerminal(t, service, "output", durable)
			assertSafe := func(layer string, value []byte) {
				if bytes.Contains(value, []byte(retainedProjectionCanary)) {
					t.Errorf("%s retains synthetic Authorization bearer value", layer)
				}
			}
			assertSafe("process.read snapshot", []byte(result.Stdout))
			if result.Command != "test-owned helper (safe display)" {
				t.Fatalf("unbound command presentation: %q", result.Command)
			}
			if !strings.Contains(result.Stdout, "[redacted]") {
				t.Fatalf("output was hidden rather than redacted: %q", result.Stdout)
			}
			preview, err := json.Marshal(service.Processes.Preview(identity().ScopeID, identity().LifecycleID, ""))
			if err != nil {
				t.Fatal(err)
			}
			assertSafe("preview", preview)
			audit, err := os.ReadFile(filepath.Join(root, "audit.jsonl"))
			if err != nil {
				t.Fatal(err)
			}
			assertSafe("safe audit", audit)
			if !bytes.Contains(audit, []byte("test-owned helper (safe display)")) {
				t.Error("safe audit presentation was not retained")
			}
			statePath := filepath.Join(root, "manager", "processes", "host", result.ID+".json")
			state, err := os.ReadFile(statePath)
			if !durable {
				// Ordinary host commands have no durable process record. Do not
				// invent a persistence leak by manually assigning a stateFile.
				if !os.IsNotExist(err) {
					t.Fatalf("ordinary host persistence expectation: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var record persistedProcess
			if err := json.Unmarshal(state, &record); err != nil || record.Snapshot.ID != result.ID {
				t.Fatalf("invalid test-owned durable record: %v", err)
			}
			assertSafe("durable process JSON", state)
		})
	}
}

func TestSandboxRetainedOutputFilesAreSanitizedBeforeRotation(t *testing.T) {
	if _, err := os.Stat("/usr/bin/python3"); err != nil {
		t.Skip("python3 is required for the sandbox process protocol")
	}
	service, _ := newTestService(t)
	service.Processes.Engine = localSandboxEngine{}
	service.Processes.MaxOutput = 128
	secret := strings.Repeat("sensitive-canary", 200)
	command := "printf '" + strings.Repeat("ordinary-padding", 40) + "\\nAuthorization: Bea'; sleep .05; printf 'rer " + secret + "\\nordinary-end\\n'; printf 'Cookie: " + secret + "\\nstderr-end\\n' >&2"
	result, err := service.Processes.Run(context.Background(), Call{Identity: identity(), Target: "sandbox"}, terminalArguments{
		Command: command, DisplayCommand: "test-owned output fixture", TimeoutMS: 5000,
	})
	if err != nil || result.Status != "completed" {
		t.Fatalf("sandbox output fixture failed: %#v %v", result, err)
	}
	if !strings.Contains(result.Stdout, "ordinary-end") || !strings.Contains(result.Stderr, "stderr-end") {
		t.Fatalf("ordinary output lost: %#v", result)
	}
	service.Processes.mu.Lock()
	process := service.Processes.processes[result.ID]
	service.Processes.mu.Unlock()
	for _, path := range []string{process.hostStdoutFile, process.hostStderrFile, process.stateFile} {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(data, []byte("sensitive-canary")) {
			t.Fatalf("retained output contains a raw credential at %s", path)
		}
		if !bytes.Contains(data, []byte("[redacted]")) {
			t.Fatalf("output was hidden instead of sanitized at %s", path)
		}
	}
}
