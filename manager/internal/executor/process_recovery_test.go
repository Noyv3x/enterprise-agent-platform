package executor

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/driver"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/sandbox"
)

func TestPreviewRevisionIsOpaqueAndChangesAcrossManagerRestart(t *testing.T) {
	root := t.TempDir()
	engine := localSandboxEngine{}
	registry := filepath.Join(root, "manager", "sandboxes.json")
	sandboxes, err := sandbox.Open(testActiveProfile, engine, filepath.Join(root, "data"), registry, "sandbox@sha256:"+strings.Repeat("a", 64), "network", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	first, err := NewProcessManager(testActiveProfile, engine, sandboxes, 64<<10)
	if err != nil {
		t.Fatal(err)
	}
	firstRevision, ok := first.Preview("private:1", "life-1", "")["revision"].(string)
	if !ok || !regexp.MustCompile(`^preview_manager_[a-f0-9]{32}:[0-9]{1,20}$`).MatchString(firstRevision) {
		t.Fatalf("first preview revision is not an opaque Manager cursor: %q", firstRevision)
	}
	unchanged := first.Preview("private:1", "life-1", firstRevision)
	if unchanged["unchanged"] != true || unchanged["revision"] != firstRevision {
		t.Fatalf("matching preview cursor did not produce an unchanged response: %#v", unchanged)
	}
	otherScope := first.Preview("private:2", "life-1", firstRevision)
	if otherScope["unchanged"] == true || otherScope["revision"] == firstRevision {
		t.Fatalf("preview cursor was reusable across scopes: %#v", otherScope)
	}
	second, err := NewProcessManager(testActiveProfile, engine, sandboxes, 64<<10)
	if err != nil {
		t.Fatal(err)
	}
	secondRevision, ok := second.Preview("private:1", "life-1", firstRevision)["revision"].(string)
	if !ok || !regexp.MustCompile(`^preview_manager_[a-f0-9]{32}:[0-9]{1,20}$`).MatchString(secondRevision) {
		t.Fatalf("second preview revision is not an opaque Manager cursor: %q", secondRevision)
	}
	if secondRevision == firstRevision {
		t.Fatal("preview cursor was reused across Manager restart")
	}
}

func TestPreviewUsesScopeFamilyActiveOrderingAndOutputSensitiveCursor(t *testing.T) {
	service, _ := newTestService(t)
	processes := service.Processes
	processes.completedRecordTTL = 24 * time.Hour
	started := time.Now().UTC().Add(-10 * time.Minute)
	add := func(id, scope, status string, offset time.Duration) *managedProcess {
		stdout := &boundedBuffer{limit: 64 << 10}
		_, _ = stdout.Write([]byte(id + "-first"))
		process := &managedProcess{
			snapshot: ProcessSnapshot{
				ID: id, RunID: "run-" + id, ScopeKey: scope, LifecycleID: "life-1",
				Target: "sandbox", Command: "command-" + id, CWD: "/workspace",
				Status: status, Stdout: "", Stderr: "", StartedAt: started.Add(offset),
				Background: activeProcessStatus(status),
			},
			stdout: stdout, stderr: &boundedBuffer{limit: 64 << 10},
		}
		if status == "orphaned" {
			confirmed := false
			process.snapshot.StopConfirmed = &confirmed
		}
		processes.processes[id] = process
		return process
	}
	root := add("root", "private:1", "running", time.Minute)
	add("delegate", "private:1/delegate/child", "orphaned", 2*time.Minute)
	add("completed", "private:1", "completed", 3*time.Minute)
	add("similar-prefix", "private:10/delegate/child", "running", 4*time.Minute)

	first := processes.Preview("private:1", "life-1", "")
	items, ok := first["processes"].([]map[string]any)
	if !ok || len(items) != 3 {
		t.Fatalf("family preview = %#v, want root plus delegate only", first)
	}
	gotOrder := []string{items[0]["id"].(string), items[1]["id"].(string), items[2]["id"].(string)}
	wantOrder := []string{"delegate", "root", "completed"}
	for index := range wantOrder {
		if gotOrder[index] != wantOrder[index] {
			t.Fatalf("preview order = %#v, want %#v", gotOrder, wantOrder)
		}
	}
	if count := processes.RunningCount("private:1", "life-1"); count != 2 {
		t.Fatalf("family running count = %d, want 2", count)
	}
	revision := first["revision"].(string)
	if _, err := root.stdout.Write([]byte("-second")); err != nil {
		t.Fatal(err)
	}
	changed := processes.Preview("private:1", "life-1", revision)
	if changed["unchanged"] == true || changed["revision"] == revision {
		t.Fatalf("output change did not invalidate preview cursor: %#v", changed)
	}
}

func TestCleanupScopeStopsRootAndDelegateFamilyOnly(t *testing.T) {
	service, _ := newTestService(t)
	processes := service.Processes
	start := func(scope string) ProcessSnapshot {
		callIdentity := identity()
		callIdentity.ScopeID = scope
		callIdentity.RunID = "run-" + scope
		result, err := processes.Run(context.Background(), Call{Identity: callIdentity, Target: "host"}, terminalArguments{
			Command: "sleep 30", Background: true,
		})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	root := start("private:1")
	delegate := start("private:1/delegate/child")
	similarPrefix := start("private:10/delegate/child")
	defer processes.CleanupScope("private:1", "life-1")
	defer processes.CleanupScope("private:10", "life-1")

	if count := processes.RunningCount("private:1", "life-1"); count != 2 {
		t.Fatalf("family running count before cleanup = %d, want 2", count)
	}
	if !processes.CleanupScope("private:1", "life-1") {
		t.Fatal("family cleanup could not confirm root and delegate termination")
	}
	if count := processes.RunningCount("private:1", "life-1"); count != 0 {
		t.Fatalf("family running count after cleanup = %d, want 0", count)
	}
	if count := processes.RunningCount("private:10", "life-1"); count != 1 {
		t.Fatalf("similar-prefix scope was affected by cleanup: count=%d", count)
	}
	for _, id := range []string{root.ID, delegate.ID} {
		select {
		case <-processes.processes[id].done:
		default:
			t.Fatalf("cleanup returned before process %s bookkeeping settled", id)
		}
	}
	select {
	case <-processes.processes[similarPrefix.ID].done:
		t.Fatal("similar-prefix process was unexpectedly settled")
	default:
	}
}

func TestCleanupScopeWaitsForTerminalControllerSettlement(t *testing.T) {
	service, _ := newTestService(t)
	processes := service.Processes
	settled := make(chan struct{})
	processes.processes["settling"] = &managedProcess{
		snapshot: ProcessSnapshot{
			ID: "settling", ScopeKey: "private:1", LifecycleID: "life-1",
			Target: "host", Status: "cancelled", StartedAt: time.Now().UTC(),
		},
		done: settled, stdout: &boundedBuffer{limit: 1024},
		stderr: &boundedBuffer{limit: 1024},
	}
	result := make(chan bool, 1)
	go func() {
		result <- processes.CleanupScope("private:1", "life-1")
	}()
	select {
	case <-result:
		t.Fatal("cleanup returned before terminal controller settlement")
	case <-time.After(25 * time.Millisecond):
	}
	close(settled)
	select {
	case confirmed := <-result:
		if !confirmed {
			t.Fatal("cleanup did not confirm settled terminal controller")
		}
	case <-time.After(time.Second):
		t.Fatal("cleanup did not return after terminal controller settlement")
	}
}

func TestRunLimitsAreAtomicAcrossScopeFamilyAndManager(t *testing.T) {
	service, _ := newTestService(t)
	processes := service.Processes
	processes.maxRunningPerFamily = 1
	processes.maxRunningGlobal = 2
	start := func(scope string) (ProcessSnapshot, error) {
		callIdentity := identity()
		callIdentity.ScopeID = scope
		callIdentity.RunID = "run-" + scope
		return processes.Run(context.Background(), Call{Identity: callIdentity, Target: "host"}, terminalArguments{
			Command: "sleep 30", Background: true,
		})
	}
	if _, err := start("private:1"); err != nil {
		t.Fatal(err)
	}
	defer processes.CleanupScope("private:1", "life-1")
	if _, err := start("private:1/delegate/child"); err == nil || !strings.Contains(err.Error(), "scope family") {
		t.Fatalf("delegate escaped family process limit: %v", err)
	}
	if _, err := start("private:2"); err != nil {
		t.Fatal(err)
	}
	defer processes.CleanupScope("private:2", "life-1")
	if _, err := start("private:3"); err == nil || !strings.Contains(err.Error(), "Manager already owns") {
		t.Fatalf("process escaped global limit: %v", err)
	}
}

func TestRunPreStartFailureReleasesSandboxCallAndProcessReservation(t *testing.T) {
	service, _ := newTestService(t)
	processes := service.Processes
	processes.maxRunningPerFamily = 1
	callIdentity := identity()
	_, err := processes.Run(context.Background(), Call{Identity: callIdentity, Target: "host"}, terminalArguments{
		Command: "true", CWD: "../../outside-workspace",
	})
	if err == nil {
		t.Fatal("escaping host cwd unexpectedly succeeded")
	}
	records := processes.Sandboxes.Records()
	if len(records) != 1 || records[0].ActiveCalls != 0 {
		t.Fatalf("pre-start failure leaked sandbox call: %#v", records)
	}
	processes.mu.Lock()
	pendingGlobal := processes.pendingGlobal
	pendingFamily := len(processes.pendingByFamily)
	processes.mu.Unlock()
	if pendingGlobal != 0 || pendingFamily != 0 {
		t.Fatalf("pre-start failure leaked process reservation: global=%d families=%d", pendingGlobal, pendingFamily)
	}
}

func TestHostRunRejectsSymlinkedWorkingDirectory(t *testing.T) {
	service, root := newTestService(t)
	if _, err := service.Processes.Sandboxes.Ensure(context.Background(), identity().ExecutionContext.SandboxID, identity().ExecutionContext.WorkspaceID, time.Now()); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(root, "outside-cwd")
	if err := os.MkdirAll(outside, 0o700); err != nil {
		t.Fatal(err)
	}
	workspace := filepath.Join(root, "data", "workspaces", "user-1")
	if err := os.Symlink(outside, filepath.Join(workspace, "escape-cwd")); err != nil {
		t.Fatal(err)
	}
	_, err := service.Processes.Run(context.Background(), Call{Identity: identity(), Target: "host"}, terminalArguments{
		Command: "true", CWD: "/workspace/escape-cwd",
	})
	if err == nil || !strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("host terminal followed a symlinked cwd: %v", err)
	}
	records := service.Processes.Sandboxes.Records()
	if len(records) != 1 || records[0].ActiveCalls != 0 {
		t.Fatalf("rejected host cwd leaked an active call: %#v", records)
	}
}

func TestHostWorkingDirectoryFDStaysPinnedAfterPathReplacement(t *testing.T) {
	service, _ := newTestService(t)
	spec, err := service.Processes.Sandboxes.Ensure(context.Background(), identity().ExecutionContext.SandboxID, identity().ExecutionContext.WorkspaceID, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(spec.Workspace, "cwd")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "marker.txt"), []byte("pinned"), 0o600); err != nil {
		t.Fatal(err)
	}
	resolved, err := service.Processes.Sandboxes.ResolveHostPath(identity().ExecutionContext.SandboxID, "/workspace/cwd", sandbox.HostPathWorkingDirectory)
	if err != nil {
		t.Fatal(err)
	}
	directory, err := openHostWorkingDirectory(resolved)
	if err != nil {
		t.Fatal(err)
	}
	defer directory.Close()

	pinned := filepath.Join(spec.Workspace, "cwd-pinned")
	if err := os.Rename(target, pinned); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "marker.txt"), []byte("replacement"), 0o600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command("/bin/sh", "-c", hostProcessWrapper, "agent-platform-manager", "cat marker.txt")
	command.Dir = string(filepath.Separator)
	command.ExtraFiles = []*os.File{directory}
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("run from pinned cwd: %v: %s", err, output)
	}
	if string(output) != "pinned" {
		t.Fatalf("command used replacement cwd: %q", output)
	}
}

func TestCompletedProcessPruningPreservesActiveAndRemovesOwnedFiles(t *testing.T) {
	service, root := newTestService(t)
	processes := service.Processes
	processes.maxCompletedRecords = 1
	processes.completedRecordTTL = time.Hour
	now := time.Now().UTC()
	add := func(id, status string, finished time.Time) *managedProcess {
		environment := filepath.Join(root, "environments", id)
		outputDir := filepath.Join(environment, "processes")
		stateDir := filepath.Join(filepath.Dir(processes.Sandboxes.StatePath), "processes", "agent")
		if err := os.MkdirAll(outputDir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(stateDir, 0o700); err != nil {
			t.Fatal(err)
		}
		stateFile := filepath.Join(stateDir, id+".json")
		stdoutFile := filepath.Join(outputDir, id+".out")
		stderrFile := filepath.Join(outputDir, id+".err")
		pidFile := filepath.Join(outputDir, id+".pid")
		for _, path := range []string{stateFile, stdoutFile, stderrFile, pidFile} {
			if err := os.WriteFile(path, []byte(id), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		finishedCopy := finished
		process := &managedProcess{
			snapshot: ProcessSnapshot{
				ID: id, ScopeKey: "private:1", LifecycleID: "life-1", Target: "sandbox",
				Status: status, StartedAt: finished.Add(-time.Minute), FinishedAt: &finishedCopy,
			},
			spec: driver.SandboxSpec{Environment: environment}, stateFile: stateFile,
			hostPIDFile: pidFile, hostStdoutFile: stdoutFile, hostStderrFile: stderrFile,
			stdout: &boundedBuffer{limit: 1024}, stderr: &boundedBuffer{limit: 1024},
		}
		processes.processes[id] = process
		return process
	}
	old := add("old", "completed", now.Add(-2*time.Hour))
	newest := add("new", "completed", now.Add(-time.Minute))
	active := add("active", "orphaned", now.Add(-3*time.Hour))

	processes.pruneCompleted(now)
	processes.mu.Lock()
	_, oldPresent := processes.processes[old.snapshot.ID]
	_, newPresent := processes.processes[newest.snapshot.ID]
	_, activePresent := processes.processes[active.snapshot.ID]
	processes.mu.Unlock()
	if oldPresent || !newPresent || !activePresent {
		t.Fatalf("pruned process set old=%t new=%t active=%t", oldPresent, newPresent, activePresent)
	}
	for _, path := range []string{old.stateFile, old.hostPIDFile, old.hostStdoutFile, old.hostStderrFile} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("pruned process file still exists: %s (%v)", path, err)
		}
	}
	if _, err := os.Lstat(active.stateFile); err != nil {
		t.Fatalf("active process state was pruned: %v", err)
	}
}

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
	sandboxes, err := sandbox.Open(testActiveProfile, engine, filepath.Join(root, "data"), registry, "sandbox@sha256:"+strings.Repeat("a", 64), "network", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	first, err := NewProcessManager(testActiveProfile, engine, sandboxes, 64<<10)
	if err != nil {
		t.Fatal(err)
	}
	call := Call{Identity: identity(), Target: "sandbox"}
	command := `i=0; while [ "$i" -lt 20 ]; do echo "line-$i"; i=$((i+1)); sleep .05; done; sleep 30`
	snapshot, err := first.Run(context.Background(), call, terminalArguments{Command: command, Background: true})
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
	second, err := NewProcessManager(testActiveProfile, engine, sandboxes, 64<<10)
	if err != nil {
		t.Fatal(err)
	}
	recovered, err := second.Get(call.ScopeID, call.LifecycleID, "sandbox", snapshot.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !activeProcessStatus(recovered.Status) || !strings.Contains(recovered.Stdout, "line-5") {
		t.Fatalf("running process was not reconstructed with output: %#v", recovered)
	}
	waited, err := second.Wait(
		context.Background(),
		call.ScopeID,
		call.LifecycleID,
		"sandbox",
		call.ExecutionContext,
		snapshot.ID,
		100*time.Millisecond,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !waited.WaitTimedOut || !activeProcessStatus(waited.Status) {
		t.Fatalf("recovered running process was not waitable: %#v", waited)
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

func TestPrivateMCPProcessReturnsRawOutputWithoutRetainingRequestOrResult(t *testing.T) {
	if _, err := os.Stat("/usr/bin/python3"); err != nil {
		t.Skip("python3 is required for the sandbox process protocol")
	}
	root := t.TempDir()
	engine := localSandboxEngine{}
	registry := filepath.Join(root, "manager", "sandboxes.json")
	sandboxes, err := sandbox.Open(testActiveProfile, engine, filepath.Join(root, "data"), registry, "sandbox@sha256:"+strings.Repeat("a", 64), "network", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	processes, err := NewProcessManager(testActiveProfile, engine, sandboxes, 64<<10)
	if err != nil {
		t.Fatal(err)
	}
	payload := "eyJhcmd1bWVudHMiOnsidG9rZW4iOiJtY3Atc2VjcmV0In19"
	rawResult := "raw-mcp-result-that-must-not-be-retained"
	call := Call{Identity: identity(), Target: "sandbox"}
	immediate, err := processes.Run(context.Background(), call, terminalArguments{
		Command:        "printf '" + rawResult + "' # /usr/local/bin/agent-platform-mcp " + payload,
		CWD:            "/workspace",
		DisplayCommand: `MCP call server="local" tool="mutate"`,
		PrivateOutput:  true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if immediate.Stdout != rawResult || immediate.Command != `MCP call server="local" tool="mutate"` {
		t.Fatalf("immediate MCP result lost or command not projected: %#v", immediate)
	}
	retained, err := processes.Get(call.ScopeID, call.LifecycleID, "sandbox", immediate.ID)
	if err != nil {
		t.Fatal(err)
	}
	if retained.Command != immediate.Command || retained.Stdout != privateProcessOutput || strings.Contains(retained.Stdout, rawResult) {
		t.Fatalf("retained MCP snapshot contains private execution data: %#v", retained)
	}
	preview := processes.Preview(call.ScopeID, call.LifecycleID, "")
	items, ok := preview["processes"].([]map[string]any)
	if !ok || len(items) != 1 {
		t.Fatalf("unexpected MCP preview: %#v", preview)
	}
	serializedPreview, _ := json.Marshal(items[0])
	if strings.Contains(string(serializedPreview), payload) || strings.Contains(string(serializedPreview), rawResult) {
		t.Fatalf("MCP preview leaked private execution data: %s", serializedPreview)
	}
	processes.mu.Lock()
	managed := processes.processes[immediate.ID]
	processes.mu.Unlock()
	for _, path := range []string{managed.hostStdoutFile, managed.hostStderrFile} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("private MCP output file was retained at %s: %v", path, err)
		}
	}
	state, err := os.ReadFile(managed.stateFile)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(state), payload) || strings.Contains(string(state), rawResult) {
		t.Fatalf("MCP state retained private execution data: %s", state)
	}
}

func TestRecoveredTerminalStateRequiresAuthoritativeExitFile(t *testing.T) {
	service, root := newTestService(t)
	processes := service.Processes
	tests := []struct {
		name       string
		content    *string
		symlink    bool
		wantStatus string
		wantCode   *int
	}{
		{name: "zero", content: stringPointer("0\n"), wantStatus: "completed", wantCode: intPointer(0)},
		{name: "nonzero", content: stringPointer("23\n"), wantStatus: "failed", wantCode: intPointer(23)},
		{name: "missing", wantStatus: "failed"},
		{name: "malformed", content: stringPointer("not-an-exit\n"), wantStatus: "failed"},
		{name: "symlink", content: stringPointer("0\n"), symlink: true, wantStatus: "failed"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			exitFile := filepath.Join(root, "exit-"+test.name)
			if test.content != nil {
				if test.symlink {
					target := exitFile + ".target"
					if err := os.WriteFile(target, []byte(*test.content), 0o600); err != nil {
						t.Fatal(err)
					}
					if err := os.Symlink(target, exitFile); err != nil {
						t.Fatal(err)
					}
				} else if err := os.WriteFile(exitFile, []byte(*test.content), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			process := &managedProcess{
				snapshot:     ProcessSnapshot{Status: "running", StartedAt: time.Now().UTC()},
				hostExitFile: exitFile,
				stdout:       &boundedBuffer{limit: 1024}, stderr: &boundedBuffer{limit: 1024},
			}
			processes.restoreRecoveredTerminalState(process, time.Now().UTC())
			if process.snapshot.Status != test.wantStatus {
				t.Fatalf("status = %q, want %q", process.snapshot.Status, test.wantStatus)
			}
			if test.wantCode == nil {
				if process.snapshot.ExitCode != nil {
					t.Fatalf("unproven terminal state invented exit code %d", *process.snapshot.ExitCode)
				}
			} else if process.snapshot.ExitCode == nil || *process.snapshot.ExitCode != *test.wantCode {
				t.Fatalf("exit code = %#v, want %d", process.snapshot.ExitCode, *test.wantCode)
			}
		})
	}
}

func TestUnacknowledgedTaskTerminalIsPinnedUntilRuntimeAcknowledges(t *testing.T) {
	service, root := newTestService(t)
	processes := service.Processes
	processes.completedRecordTTL = time.Millisecond
	finished := time.Now().UTC().Add(-time.Hour)
	stateDir := filepath.Join(filepath.Dir(processes.Sandboxes.StatePath), "processes", "pinned")
	environment := filepath.Join(root, "environment")
	if err := os.MkdirAll(filepath.Join(environment, "processes"), 0o700); err != nil {
		t.Fatal(err)
	}
	process := &managedProcess{
		snapshot: ProcessSnapshot{
			ID: "proc_pinned", RunID: "run-pinned", ScopeKey: "private:1", LifecycleID: "life-1",
			Target: "sandbox", Status: "failed", StartedAt: finished.Add(-time.Minute), FinishedAt: &finished,
			Background: true,
		},
		sandboxID: "private-1", workspaceID: "user-1",
		spec: driver.SandboxSpec{Environment: environment}, stateFile: filepath.Join(stateDir, "proc_pinned.json"),
		completionOwnerID: strings.Repeat("a", 64), completionToolCallID: "tool-pinned",
		done: make(chan struct{}), stdout: &boundedBuffer{limit: 1024}, stderr: &boundedBuffer{limit: 1024},
	}
	close(process.done)
	processes.processes[process.snapshot.ID] = process
	if err := processes.persistProcess(process); err != nil {
		t.Fatal(err)
	}
	processes.pruneCompleted(time.Now())
	if _, ok := processes.processes[process.snapshot.ID]; !ok {
		t.Fatal("unacknowledged task terminal was pruned")
	}
	identity := TaskIdentity{
		ScopeID: "private:1", LifecycleID: "life-1",
		ExecutionContext:  ExecutionContext{SandboxID: "private-1", WorkspaceID: "user-1"},
		CompletionOwnerID: strings.Repeat("a", 64),
	}
	reconciled, err := processes.ReconcileTasks(identity)
	if err != nil || len(reconciled) != 1 || reconciled[0].ID != process.snapshot.ID {
		t.Fatalf("reconciled = %#v, err=%v", reconciled, err)
	}
	if !processes.AcknowledgeTask(TaskProcessIdentity{TaskIdentity: identity, ProcessID: process.snapshot.ID}) {
		t.Fatal("terminal task acknowledgement failed")
	}
	processes.pruneCompleted(time.Now())
	if _, ok := processes.processes[process.snapshot.ID]; ok {
		t.Fatal("acknowledged expired terminal remained pinned")
	}
}

func TestCancelRunPreservesOnlyExactCompletionTask(t *testing.T) {
	if _, err := os.Stat("/usr/bin/python3"); err != nil {
		t.Skip("python3 is required for the sandbox process protocol")
	}
	root := t.TempDir()
	engine := localSandboxEngine{}
	sandboxes, err := sandbox.Open(testActiveProfile, engine, filepath.Join(root, "data"), filepath.Join(root, "manager", "sandboxes.json"), "sandbox@sha256:"+strings.Repeat("a", 64), "network", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	processes, err := NewProcessManager(testActiveProfile, engine, sandboxes, 64<<10)
	if err != nil {
		t.Fatal(err)
	}
	base := identity()
	base.RunID = "run-preserve"
	taskCall := Call{Identity: base, Target: "sandbox", CompletionRequired: true, CompletionOwnerID: strings.Repeat("b", 64)}
	task, err := processes.Run(context.Background(), taskCall, terminalArguments{Command: "sleep 30", Background: true})
	if err != nil {
		t.Fatal(err)
	}
	serviceIdentity := base
	serviceIdentity.ToolCallID = "tool-service"
	serviceProcess, err := processes.Run(context.Background(), Call{Identity: serviceIdentity, Target: "sandbox"}, terminalArguments{Command: "sleep 30", Background: true})
	if err != nil {
		processes.CleanupScope(base.ScopeID, base.LifecycleID)
		t.Fatal(err)
	}
	defer processes.CleanupScope(base.ScopeID, base.LifecycleID)
	confirmed := processes.CancelRun(RunIdentity{
		RunID: base.RunID, ScopeID: base.ScopeID, LifecycleID: base.LifecycleID,
		ExecutionContext: base.ExecutionContext, PreserveProcessIDs: []string{task.ID},
	})
	if !confirmed {
		t.Fatal("run cleanup did not confirm non-preserved process termination")
	}
	preserved, err := processes.Get(base.ScopeID, base.LifecycleID, "sandbox", task.ID)
	if err != nil || !activeProcessStatus(preserved.Status) {
		t.Fatalf("finite task was not preserved: %#v, %v", preserved, err)
	}
	removed, err := processes.Get(base.ScopeID, base.LifecycleID, "sandbox", serviceProcess.ID)
	if err != nil || removed.Status != "cancelled" {
		t.Fatalf("unregistered background process escaped cleanup: %#v, %v", removed, err)
	}
	wrong := processes.CancelRun(RunIdentity{
		RunID: base.RunID, ScopeID: base.ScopeID, LifecycleID: base.LifecycleID,
		ExecutionContext:   ExecutionContext{SandboxID: "other", WorkspaceID: base.ExecutionContext.WorkspaceID},
		PreserveProcessIDs: []string{task.ID},
	})
	if wrong {
		t.Fatal("mismatched execution context preserved a process")
	}
}

func TestHostCompletionIntentRecoversAsFailedUnknownInsteadOfReplaying(t *testing.T) {
	root := t.TempDir()
	engine := engineStub{}
	sandboxes, err := sandbox.Open(testActiveProfile, engine, filepath.Join(root, "data"), filepath.Join(root, "manager", "sandboxes.json"), "sandbox@sha256:"+strings.Repeat("a", 64), "network", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	first, err := NewProcessManager(testActiveProfile, engine, sandboxes, 64<<10)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	process := &managedProcess{
		snapshot: ProcessSnapshot{
			ID: "proc_host_crash", RunID: "run-host", ScopeKey: "private:1", LifecycleID: "life-1",
			Target: "host", Command: "side-effecting-host-command", CWD: "/workspace", Status: "running",
			StartedAt: now, Background: true,
		},
		sandboxID: "private-1", workspaceID: "user-1",
		stateFile:         filepath.Join(filepath.Dir(sandboxes.StatePath), "processes", "host", "proc_host_crash.json"),
		completionOwnerID: strings.Repeat("c", 64), completionToolCallID: "tool-host", starting: true,
		done: make(chan struct{}), stdout: &boundedBuffer{limit: 1024}, stderr: &boundedBuffer{limit: 1024},
	}
	if err := first.persistProcess(process); err != nil {
		t.Fatal(err)
	}
	second, err := NewProcessManager(testActiveProfile, engine, sandboxes, 64<<10)
	if err != nil {
		t.Fatal(err)
	}
	recovered, err := second.Get("private:1", "life-1", "host", process.snapshot.ID)
	if err != nil {
		t.Fatal(err)
	}
	if recovered.Status != "failed" || recovered.ExitCode != nil {
		t.Fatalf("host crash recovery invented success: %#v", recovered)
	}
	tasks, err := second.ReconcileTasks(TaskIdentity{
		ScopeID: "private:1", LifecycleID: "life-1",
		ExecutionContext:  ExecutionContext{SandboxID: "private-1", WorkspaceID: "user-1"},
		CompletionOwnerID: strings.Repeat("c", 64),
	})
	if err != nil || len(tasks) != 1 || tasks[0].ID != process.snapshot.ID {
		t.Fatalf("host crash task was not recoverable: %#v, %v", tasks, err)
	}
}

func TestAcknowledgedHostTaskRecordReentersNormalPruningAfterRestart(t *testing.T) {
	root := t.TempDir()
	engine := engineStub{}
	sandboxes, err := sandbox.Open(testActiveProfile, engine, filepath.Join(root, "data"), filepath.Join(root, "manager", "sandboxes.json"), "sandbox@sha256:"+strings.Repeat("a", 64), "network", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	finished := time.Now().UTC()
	stateFile := filepath.Join(filepath.Dir(sandboxes.StatePath), "processes", "host", "proc_host_ack.json")
	state := persistedProcess{
		Snapshot: ProcessSnapshot{
			ID: "proc_host_ack", RunID: "run-host", ScopeKey: "private:1", LifecycleID: "life-1",
			Target: "host", Command: "true", CWD: "/workspace", Status: "completed", ExitCode: intPointer(0),
			StartedAt: finished.Add(-time.Second), FinishedAt: &finished, Background: true,
		},
		SandboxID: "private-1", WorkspaceID: "user-1", CompletionOwnerID: strings.Repeat("f", 64),
		CompletionToolCallID: "tool-host", CompletionAcknowledged: true,
	}
	if err := atomicfile.WriteJSON(stateFile, state, 0o600); err != nil {
		t.Fatal(err)
	}
	recovered, err := NewProcessManager(testActiveProfile, engine, sandboxes, 64<<10)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := recovered.Get("private:1", "life-1", "host", "proc_host_ack"); err != nil {
		t.Fatalf("fresh acknowledged record was not loaded for normal retention: %v", err)
	}
	recovered.pruneCompleted(finished.Add(2 * time.Hour))
	if _, err := recovered.Get("private:1", "life-1", "host", "proc_host_ack"); err == nil {
		t.Fatal("expired acknowledged host record was not pruned")
	}
	if _, err := os.Lstat(stateFile); !os.IsNotExist(err) {
		t.Fatalf("pruned acknowledged host state file leaked: %v", err)
	}
}

func TestCompletionOwnerAdmissionStopsBeforeThe257thUnacknowledgedTask(t *testing.T) {
	service, _ := newTestService(t)
	processes := service.Processes
	owner := strings.Repeat("d", 64)
	for index := 0; index < 256; index++ {
		id := fmt.Sprintf("proc_limit_%03d", index)
		processes.processes[id] = &managedProcess{
			snapshot:          ProcessSnapshot{ID: id, Status: "running", StartedAt: time.Now().UTC(), Background: true},
			completionOwnerID: owner,
			stdout:            &boundedBuffer{limit: 1024}, stderr: &boundedBuffer{limit: 1024},
		}
	}
	if err := processes.reserveCompletionOwner(owner); err == nil || !strings.Contains(err.Error(), "256") {
		t.Fatalf("257th unacknowledged task was admitted: %v", err)
	}
	processes.processes["proc_limit_000"].completionAcknowledged = true
	if err := processes.reserveCompletionOwner(owner); err != nil {
		t.Fatalf("acknowledged task did not release owner capacity: %v", err)
	}
	processes.releaseCompletionOwner(owner)
}

func TestRecoveredStartingSandboxIntentWithoutPIDFailsClosedAsOrphaned(t *testing.T) {
	root := t.TempDir()
	engine := localSandboxEngine{}
	registry := filepath.Join(root, "manager", "sandboxes.json")
	sandboxes, err := sandbox.Open(testActiveProfile, engine, filepath.Join(root, "data"), registry, "sandbox@sha256:"+strings.Repeat("a", 64), "network", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	spec, err := sandboxes.Ensure(context.Background(), identity().ExecutionContext.SandboxID, identity().ExecutionContext.WorkspaceID, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	stateFile := filepath.Join(filepath.Dir(sandboxes.StatePath), "processes", spec.AgentHash, "proc_starting.json")
	state := persistedProcess{
		Snapshot: ProcessSnapshot{
			ID: "proc_starting", RunID: "run-starting", ScopeKey: "private:1", LifecycleID: "life-1",
			Target: "sandbox", Command: "side-effecting-command", CWD: "/workspace", Status: "running",
			StartedAt: time.Now().UTC(), Background: true,
		},
		SandboxID: identity().ExecutionContext.SandboxID, WorkspaceID: identity().ExecutionContext.WorkspaceID,
		PIDFile:           filepath.ToSlash(filepath.Join(contract.ContainerAgentEnv, "processes", "proc_starting.pid")),
		HostPIDFile:       filepath.Join(spec.Environment, "processes", "proc_starting.pid"),
		CompletionOwnerID: strings.Repeat("e", 64), CompletionToolCallID: "tool-starting", Starting: true,
	}
	if err := atomicfile.WriteJSON(stateFile, state, 0o600); err != nil {
		t.Fatal(err)
	}
	recovered, err := NewProcessManager(testActiveProfile, engine, sandboxes, 64<<10)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := recovered.Get("private:1", "life-1", "sandbox", "proc_starting")
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Status != "orphaned" || snapshot.StopConfirmed == nil || *snapshot.StopConfirmed {
		t.Fatalf("uncertain startup was not preserved fail-closed: %#v", snapshot)
	}
	killed, killErr := recovered.Kill("private:1", "life-1", "sandbox", "proc_starting")
	if killErr == nil || killed.Status != "orphaned" || killed.StopConfirmed == nil || *killed.StopConfirmed {
		t.Fatalf("missing startup PID was falsely confirmed by kill: snapshot=%#v err=%v", killed, killErr)
	}
	tasks, err := recovered.ReconcileTasks(TaskIdentity{
		ScopeID: "private:1", LifecycleID: "life-1",
		ExecutionContext: identity().ExecutionContext, CompletionOwnerID: strings.Repeat("e", 64),
	})
	if err != nil || len(tasks) != 1 || tasks[0].ID != "proc_starting" {
		t.Fatalf("uncertain startup disappeared from reconciliation: %#v, %v", tasks, err)
	}
}

func TestScopeCleanupReturnsPinnedCompletionEvidenceUntilAcknowledged(t *testing.T) {
	service, _ := newTestService(t)
	processes := service.Processes
	owner := strings.Repeat("9", 64)
	done := make(chan struct{})
	close(done)
	process := &managedProcess{
		snapshot: ProcessSnapshot{
			ID: "proc_cleanup_evidence", RunID: "run-cleanup", ScopeKey: "private:1/delegate/child",
			LifecycleID: "life-1", Target: "sandbox", Status: "cancelled", StartedAt: time.Now().UTC(), Background: true,
		},
		sandboxID: "private-1", workspaceID: "user-1", completionOwnerID: owner,
		done: done, stdout: &boundedBuffer{limit: 1024}, stderr: &boundedBuffer{limit: 1024},
	}
	processes.processes[process.snapshot.ID] = process

	for attempt := 0; attempt < 2; attempt++ {
		result, err := processes.CleanupScopeWithEvidence("private:1", "life-1")
		if err != nil || !result.Confirmed || len(result.CompletionTasks) != 1 {
			t.Fatalf("cleanup attempt %d lost pinned evidence: result=%#v err=%v", attempt+1, result, err)
		}
		evidence := result.CompletionTasks[0]
		if evidence.ProcessID != process.snapshot.ID || evidence.ScopeID != process.snapshot.ScopeKey ||
			evidence.LifecycleID != "life-1" || evidence.Target != "sandbox" ||
			evidence.CompletionOwnerID != owner || evidence.ExecutionContext.SandboxID != "private-1" ||
			evidence.ExecutionContext.WorkspaceID != "user-1" {
			t.Fatalf("cleanup evidence changed trusted identity: %#v", evidence)
		}
		process.mu.Lock()
		acknowledged := process.completionAcknowledged
		process.mu.Unlock()
		if acknowledged {
			t.Fatal("Manager acknowledged cleanup evidence before Runtime local commit")
		}
	}
	if !processes.AcknowledgeTask(TaskProcessIdentity{
		TaskIdentity: TaskIdentity{
			ScopeID: process.snapshot.ScopeKey, LifecycleID: "life-1",
			ExecutionContext:  ExecutionContext{SandboxID: "private-1", WorkspaceID: "user-1"},
			CompletionOwnerID: owner,
		},
		ProcessID: process.snapshot.ID,
	}) {
		t.Fatal("Runtime acknowledgement was rejected")
	}
	result, err := processes.CleanupScopeWithEvidence("private:1", "life-1")
	if err != nil || !result.Confirmed || len(result.CompletionTasks) != 0 {
		t.Fatalf("acknowledged evidence was replayed: result=%#v err=%v", result, err)
	}
}

func TestScopeCleanupEvidenceLimitFailsBeforeProcessMutation(t *testing.T) {
	service, _ := newTestService(t)
	processes := service.Processes
	for index := 0; index <= maxScopeCleanupCompletionEvidence; index++ {
		done := make(chan struct{})
		close(done)
		id := fmt.Sprintf("proc_cleanup_limit_%04d", index)
		processes.processes[id] = &managedProcess{
			snapshot:  ProcessSnapshot{ID: id, ScopeKey: "private:limit", LifecycleID: "life-1", Target: "host", Status: "cancelled", StartedAt: time.Now().UTC(), Background: true},
			sandboxID: "private-limit", workspaceID: "user-limit", completionOwnerID: strings.Repeat("8", 64),
			done: done, stdout: &boundedBuffer{limit: 1024}, stderr: &boundedBuffer{limit: 1024},
		}
	}
	active := &managedProcess{
		snapshot:  ProcessSnapshot{ID: "proc_cleanup_limit_active", ScopeKey: "private:limit", LifecycleID: "life-1", Target: "host", Status: "running", StartedAt: time.Now().UTC(), Background: true},
		sandboxID: "private-limit", workspaceID: "user-limit", done: make(chan struct{}),
		stdout: &boundedBuffer{limit: 1024}, stderr: &boundedBuffer{limit: 1024},
	}
	processes.processes[active.snapshot.ID] = active
	if _, err := processes.CleanupScopeWithEvidence("private:limit", "life-1"); err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("oversized cleanup evidence was not rejected: %v", err)
	}
	if snapshot := processes.snapshot(active); snapshot.Status != "running" || active.stopRequested {
		t.Fatalf("cleanup mutated a process before evidence admission: %#v", snapshot)
	}
}

func TestScopeCleanupFenceDrainsAdmittedStartsAndPreservesAdjacentAdmission(t *testing.T) {
	service, _ := newTestService(t)
	processes := service.Processes
	if err := processes.reserveProcessSlot("private:1/delegate/child", "life-1"); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := processes.CleanupScopeWithEvidenceContext(context.Background(), "private:1", "life-1")
		result <- err
	}()
	waitForCleanupFence(t, processes, scopeCleanupFence{scopeID: "private:1", lifecycleID: "life-1"})
	if err := processes.reserveProcessSlot("private:1", "life-1"); err == nil || !strings.Contains(err.Error(), "cleanup") {
		t.Fatalf("same-family start entered an active cleanup fence: %v", err)
	}
	for _, identity := range []processStartIdentity{
		{scopeID: "private:1", lifecycleID: "life-2"},
		{scopeID: "private:10/delegate/child", lifecycleID: "life-1"},
	} {
		if err := processes.reserveProcessSlot(identity.scopeID, identity.lifecycleID); err != nil {
			t.Fatalf("adjacent start was blocked by cleanup fence: identity=%#v err=%v", identity, err)
		}
		processes.releaseProcessSlot(identity.scopeID, identity.lifecycleID)
	}
	if _, err := processes.CleanupScopeWithEvidenceContext(context.Background(), "private:1/delegate/child", "life-1"); err == nil || !strings.Contains(err.Error(), "overlapping") {
		t.Fatalf("overlapping cleanup was not rejected: %v", err)
	}
	select {
	case err := <-result:
		t.Fatalf("cleanup returned before admitted start settled: %v", err)
	default:
	}
	done := make(chan struct{})
	close(done)
	processes.mu.Lock()
	processes.processes["proc_admitted_cleanup"] = &managedProcess{
		snapshot: ProcessSnapshot{
			ID: "proc_admitted_cleanup", ScopeKey: "private:1/delegate/child", LifecycleID: "life-1",
			Target: "host", Status: "cancelled", StartedAt: time.Now().UTC(), Background: true,
		},
		sandboxID: "private-1", workspaceID: "user-1", completionOwnerID: strings.Repeat("7", 64),
		done: done, stdout: &boundedBuffer{limit: 1024}, stderr: &boundedBuffer{limit: 1024},
	}
	processes.releaseProcessSlotLocked("private:1/delegate/child", "life-1")
	processes.mu.Unlock()
	if err := <-result; err != nil {
		t.Fatalf("cleanup failed after admitted start registered: %v", err)
	}
}

func TestScopeCleanupEvidenceLimitIncludesAStartAdmittedBeforeTheFence(t *testing.T) {
	service, _ := newTestService(t)
	processes := service.Processes
	for index := 0; index < maxScopeCleanupCompletionEvidence; index++ {
		done := make(chan struct{})
		close(done)
		id := fmt.Sprintf("proc_pending_limit_%04d", index)
		processes.processes[id] = &managedProcess{
			snapshot:  ProcessSnapshot{ID: id, ScopeKey: "private:pending-limit", LifecycleID: "life-1", Target: "host", Status: "cancelled", StartedAt: time.Now().UTC(), Background: true},
			sandboxID: "private-limit", workspaceID: "user-limit", completionOwnerID: strings.Repeat("6", 64),
			done: done, stdout: &boundedBuffer{limit: 1024}, stderr: &boundedBuffer{limit: 1024},
		}
	}
	active := &managedProcess{
		snapshot:  ProcessSnapshot{ID: "proc_pending_limit_active", ScopeKey: "private:pending-limit", LifecycleID: "life-1", Target: "host", Status: "running", StartedAt: time.Now().UTC(), Background: true},
		sandboxID: "private-limit", workspaceID: "user-limit", done: make(chan struct{}),
		stdout: &boundedBuffer{limit: 1024}, stderr: &boundedBuffer{limit: 1024},
	}
	processes.processes[active.snapshot.ID] = active
	if err := processes.reserveProcessSlot("private:pending-limit/delegate/child", "life-1"); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := processes.CleanupScopeWithEvidenceContext(context.Background(), "private:pending-limit", "life-1")
		result <- err
	}()
	waitForCleanupFence(t, processes, scopeCleanupFence{scopeID: "private:pending-limit", lifecycleID: "life-1"})
	done := make(chan struct{})
	close(done)
	processes.mu.Lock()
	processes.processes["proc_pending_limit_late"] = &managedProcess{
		snapshot:  ProcessSnapshot{ID: "proc_pending_limit_late", ScopeKey: "private:pending-limit/delegate/child", LifecycleID: "life-1", Target: "host", Status: "cancelled", StartedAt: time.Now().UTC(), Background: true},
		sandboxID: "private-limit", workspaceID: "user-limit", completionOwnerID: strings.Repeat("6", 64),
		done: done, stdout: &boundedBuffer{limit: 1024}, stderr: &boundedBuffer{limit: 1024},
	}
	processes.releaseProcessSlotLocked("private:pending-limit/delegate/child", "life-1")
	processes.mu.Unlock()
	if err := <-result; err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("cleanup evidence preflight ignored the admitted start: %v", err)
	}
	if snapshot := processes.snapshot(active); snapshot.Status != "running" || active.stopRequested {
		t.Fatalf("oversized admitted evidence mutated active process: %#v", snapshot)
	}
}

func waitForCleanupFence(t *testing.T, processes *ProcessManager, fence scopeCleanupFence) {
	t.Helper()
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	for {
		processes.mu.Lock()
		_, installed := processes.cleanupFences[fence]
		changed := processes.cleanupFenceChanged
		processes.mu.Unlock()
		if installed {
			return
		}
		select {
		case <-changed:
		case <-timer.C:
			t.Fatal("scope cleanup fence was not installed")
		}
	}
}

func stringPointer(value string) *string { return &value }
func intPointer(value int) *int          { return &value }
