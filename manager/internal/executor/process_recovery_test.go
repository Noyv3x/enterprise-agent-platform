package executor

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/contract"
	"github.com/ubitech/agent-platform/manager/internal/driver"
	"github.com/ubitech/agent-platform/manager/internal/sandbox"
)

func TestPreviewRevisionIsOpaqueAndChangesAcrossManagerRestart(t *testing.T) {
	root := t.TempDir()
	engine := localSandboxEngine{}
	registry := filepath.Join(root, "manager", "sandboxes.json")
	sandboxes, err := sandbox.Open(engine, filepath.Join(root, "data"), registry, "sandbox@sha256:"+strings.Repeat("a", 64), "network", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	first := NewProcessManager(engine, sandboxes, 64<<10)
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
	second := NewProcessManager(engine, sandboxes, 64<<10)
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
	start("private:1")
	start("private:1/delegate/child")
	start("private:10/delegate/child")
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
	sandboxes, err := sandbox.Open(engine, filepath.Join(root, "data"), registry, "sandbox@sha256:"+strings.Repeat("a", 64), "network", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	first := NewProcessManager(engine, sandboxes, 64<<10)
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
