package executor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/driver"
)

// This fixture runs only as a test-owned subprocess, never as a Manager.
func TestProcessBoundaryBoundaryHelper(t *testing.T) {
	args := os.Args
	if len(args) < 4 || args[len(args)-3] != "process-boundary-helper" {
		return
	}
	mode, report := args[len(args)-2], args[len(args)-1]
	childPID := 0
	var child *exec.Cmd
	if mode == "group" {
		child = exec.Command("/bin/sleep", "3")
		child.Stdout, child.Stderr = os.Stdout, os.Stderr
		if err := child.Start(); err != nil {
			os.Exit(91)
		}
		childPID = child.Process.Pid
	}
	if err := os.WriteFile(report, []byte(fmt.Sprintf("%d %d", os.Getpid(), childPID)), 0600); err != nil {
		os.Exit(92)
	}
	if child != nil {
		_ = child.Wait()
	} else {
		time.Sleep(3 * time.Second)
	}
	os.Exit(0)
}

func processBoundaryQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'" }
func processBoundaryCommand(mode, report string) string {
	return "exec " + processBoundaryQuote(os.Args[0]) + " -test.run=^TestProcessBoundaryBoundaryHelper$ -- process-boundary-helper " + mode + " " + processBoundaryQuote(report)
}

// /proc start time protects cleanup against PID reuse. Parent/group fields prove
// that the reported processes belong to this test before any signal is sent.
func processBoundaryIdentity(pid int) (ppid, group int, start, state string, err error) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0, 0, "", "", err
	}
	end := strings.LastIndexByte(string(data), ')')
	if end < 0 {
		return 0, 0, "", "", fmt.Errorf("invalid proc stat")
	}
	fields := strings.Fields(string(data[end+1:]))
	if len(fields) < 20 {
		return 0, 0, "", "", fmt.Errorf("short proc stat")
	}
	ppid, err = strconv.Atoi(fields[1])
	if err != nil {
		return
	}
	group, err = strconv.Atoi(fields[2])
	return ppid, group, fields[19], fields[0], err
}

func processBoundaryReport(t *testing.T, path string) (int, int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(path)
		var pid, child int
		if err == nil {
			if n, _ := fmt.Sscanf(string(data), "%d %d", &pid, &child); n == 2 && pid > 1 {
				return pid, child
			}
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("test-owned helper did not publish identity")
	return 0, 0
}

func TestProcessBoundaryTailFIFORejectsWithoutWriter(t *testing.T) {
	path := filepath.Join(t.TempDir(), "output.fifo")
	if err := syscall.Mkfifo(path, 0600); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := readTailFile(path, 64); done <- err }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("FIFO output was accepted")
		}
	case <-time.After(150 * time.Millisecond):
		// RDWR never waits for a reader and releases the old blocking Open.
		fd, err := syscall.Open(path, syscall.O_RDWR|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
		if err != nil {
			t.Fatal(err)
		}
		defer syscall.Close(fd)
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("FIFO cleanup did not release reader")
		}
		t.Fatal("readTailFile blocked on a FIFO without a writer instead of rejecting it")
	}
}

func TestProcessBoundaryEmptyPIDHonorsDeadline(t *testing.T) {
	path := filepath.Join(t.TempDir(), "empty.pid")
	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := waitForPIDFile(path, 50*time.Millisecond); done <- err }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("empty PID unexpectedly accepted")
		}
	case <-time.After(200 * time.Millisecond):
		// Removing our fixture forces even the old empty-file loop to its deadline check.
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("PID reader failed bounded cleanup")
		}
		t.Fatal("empty PID file bypassed its 50ms deadline")
	}
}

type processBoundaryEngine struct {
	engineStub
	report string
}

func (e processBoundaryEngine) ExecArgs(_ driver.SandboxSpec, _ string, name string, _ []string) (string, []string) {
	if name == "python3" {
		return os.Args[0], []string{"-test.run=^TestProcessBoundaryBoundaryHelper$", "--", "process-boundary-helper", "idle", e.report}
	}
	return "/bin/sh", []string{"-c", "printf stopped"}
}

func TestProcessBoundaryPIDFailureReapsController(t *testing.T) {
	service, root := newTestService(t)
	report := filepath.Join(root, "controller")
	service.Processes.Engine = processBoundaryEngine{report: report}
	done := make(chan error, 1)
	go func() {
		_, err := service.Processes.Run(context.Background(), Call{Identity: identity(), Target: "sandbox"}, terminalArguments{Command: "unused", Background: true})
		done <- err
	}()
	pid, _ := processBoundaryReport(t, report)
	ppid, _, start, _, err := processBoundaryIdentity(pid)
	if err != nil || ppid != os.Getpid() {
		t.Fatalf("controller is not our direct child: %d %v", ppid, err)
	}
	defer func() {
		_, _, current, _, err := processBoundaryIdentity(pid)
		if err == nil && current == start {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
		var status syscall.WaitStatus
		deadline := time.Now().Add(time.Second)
		for time.Now().Before(deadline) {
			got, err := syscall.Wait4(pid, &status, syscall.WNOHANG, nil)
			if got == pid || errors.Is(err, syscall.ECHILD) {
				return
			}
			time.Sleep(time.Millisecond)
		}
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("missing managed PID was accepted")
		}
	case <-time.After(4 * time.Second):
		t.Fatal("PID failure did not return")
	}
	// Observe a zombie without reaping it; a correct Run has already called Wait.
	deadline := time.Now().Add(200 * time.Millisecond)
	for time.Now().Before(deadline) {
		_, _, current, state, err := processBoundaryIdentity(pid)
		if os.IsNotExist(err) || (err == nil && current != start) {
			return
		}
		if err == nil && state == "Z" {
			t.Fatal("Start succeeded, PID publication failed, controller left unreaped (zombie)")
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("failed-start controller is still present after Run returned")
}

func TestProcessBoundaryHostDeadlineKillsOwnedGroup(t *testing.T) {
	service, root := newTestService(t)
	report := filepath.Join(root, "group")
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		defer close(done)
		_, err := service.Processes.Run(ctx, Call{Identity: identity(), Target: "host"}, terminalArguments{Command: processBoundaryCommand("group", report)})
		done <- err
	}()
	leader, child := processBoundaryReport(t, report)
	parent, group, leaderStart, _, err := processBoundaryIdentity(leader)
	if err != nil || parent != os.Getpid() || group != leader {
		t.Fatalf("unverified test leader: parent=%d group=%d err=%v", parent, group, err)
	}
	parent, childGroup, childStart, _, err := processBoundaryIdentity(child)
	if err != nil || parent != leader || childGroup != group {
		t.Fatalf("unverified test child: parent=%d group=%d err=%v", parent, childGroup, err)
	}
	defer func() {
		_, pg, start, _, err := processBoundaryIdentity(child)
		_, lpg, ls, _, le := processBoundaryIdentity(leader)
		if (err == nil && pg == group && start == childStart) || (le == nil && lpg == group && ls == leaderStart) {
			_ = syscall.Kill(-group, syscall.SIGKILL)
		}
		select {
		case <-done:
		case <-time.After(4 * time.Second):
		}
	}()
	<-ctx.Done()
	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Error("100ms host deadline did not converge; descendant retained output pipes")
	}
	_, _, current, state, err := processBoundaryIdentity(child)
	if err == nil && current == childStart && state != "Z" {
		t.Error("host deadline killed only the leader; verified owned child is still running")
	}
}

func TestProcessBoundaryStdinWriteHonorsRequestCancellation(t *testing.T) {
	service, root := newTestService(t)
	report := filepath.Join(root, "stdin")
	snapshot, err := service.Processes.Run(context.Background(), Call{Identity: identity(), Target: "host"}, terminalArguments{Command: processBoundaryCommand("idle", report), Background: true})
	if err != nil {
		t.Fatal(err)
	}
	pid, _ := processBoundaryReport(t, report)
	parent, group, start, _, err := processBoundaryIdentity(pid)
	if err != nil || pid != snapshot.PID || parent != os.Getpid() || group != pid {
		t.Fatalf("unverified stdin helper: %d %v", pid, err)
	}
	service.Processes.mu.Lock()
	process := service.Processes.processes[snapshot.ID]
	service.Processes.mu.Unlock()
	defer func() {
		_, pg, current, _, err := processBoundaryIdentity(pid)
		if err == nil && pg == group && current == start {
			_ = syscall.Kill(-group, syscall.SIGKILL)
		}
		select {
		case <-process.done:
		case <-time.After(4 * time.Second):
			t.Error("stdin helper did not terminate")
		}
	}()
	raw, err := json.Marshal(processWriteArguments{ProcessID: snapshot.ID, Input: strings.Repeat("x", 128<<10)})
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := service.Audit(AuditRequest{Identity: identity(), AuditID: "process-boundary-write", Target: "host", Operation: "process", Action: "write", Arguments: raw, Details: map[string]any{"action": "write"}})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := service.Process(ctx, Call{Identity: identity(), AuditID: receipt.AuditID, ExecutorID: receipt.ExecutorID, Target: "host", Action: "write", Arguments: raw})
		done <- err
	}()
	<-ctx.Done()
	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) && !errors.Is(err, context.Canceled) {
			t.Errorf("write must report request cancellation, got %v", err)
		}
	case <-time.After(300 * time.Millisecond):
		t.Error("Service.Process write stayed blocked after request cancellation")
		_ = process.stdin.Close()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("stdin write did not release after fixture cleanup")
		}
	}
	_, _, current, state, err := processBoundaryIdentity(pid)
	if err != nil || current != start || state == "Z" {
		t.Errorf("request cancellation terminated detached background helper: %v", err)
	}
}

func TestCompletionTaskPIDFailureRemainsReconcilable(t *testing.T) {
	service, root := newTestService(t)
	service.Processes.Engine = processBoundaryEngine{report: filepath.Join(root, "failed-task-controller")}
	call := Call{Identity: identity(), Target: "sandbox", CompletionRequired: true, CompletionOwnerID: strings.Repeat("a", 64)}
	result, err := service.Processes.Run(context.Background(), call, terminalArguments{Command: "unused", Background: true})
	if err == nil || result.ID == "" || activeProcessStatus(result.Status) {
		t.Fatalf("PID publication failure must retain a terminal task: %#v %v", result, err)
	}
	if !result.Background {
		t.Error("failed background task lost its background responsibility")
	}
	task := TaskIdentity{ScopeID: call.ScopeID, LifecycleID: call.LifecycleID, ExecutionContext: call.ExecutionContext, CompletionOwnerID: call.CompletionOwnerID}
	pending, err := service.Processes.ReconcileTasks(task)
	if err != nil || len(pending) != 1 || pending[0].ID != result.ID {
		t.Errorf("failed task is absent from reconciliation: %#v %v", pending, err)
	}
	if !service.Processes.AcknowledgeTask(TaskProcessIdentity{TaskIdentity: task, ProcessID: result.ID}) {
		t.Error("failed task cannot be acknowledged")
	}
	pending, err = service.Processes.ReconcileTasks(task)
	if err != nil || len(pending) != 0 {
		t.Errorf("acknowledged task remains pending: %#v %v", pending, err)
	}
}
