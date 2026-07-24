package executor

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/atomicfile"
	"github.com/ubitech/agent-platform/manager/internal/contract"
	"github.com/ubitech/agent-platform/manager/internal/driver"
	"github.com/ubitech/agent-platform/manager/internal/sandbox"
)

type ProcessManager struct {
	Engine    driver.Engine
	Sandboxes *sandbox.Manager
	MaxOutput int64
	mu        sync.Mutex
	processes map[string]*managedProcess
	revision  uint64
}
type managedProcess struct {
	mu             sync.Mutex
	snapshot       ProcessSnapshot
	command        *exec.Cmd
	stdin          io.WriteCloser
	cancel         context.CancelFunc
	context        context.Context
	sandboxID      string
	spec           driver.SandboxSpec
	pidFile        string
	hostPIDFile    string
	hostStdoutFile string
	hostStderrFile string
	stateFile      string
	stopMu         sync.Mutex
	stdout, stderr *boundedBuffer
}

type persistedProcess struct {
	Snapshot    ProcessSnapshot `json:"snapshot"`
	SandboxID   string          `json:"sandbox_id"`
	PIDFile     string          `json:"pid_file"`
	HostPIDFile string          `json:"host_pid_file"`
	StdoutFile  string          `json:"stdout_file"`
	StderrFile  string          `json:"stderr_file"`
}
type boundedBuffer struct {
	mu        sync.Mutex
	value     bytes.Buffer
	limit     int64
	truncated bool
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := len(p)
	remaining := b.limit - int64(b.value.Len())
	if remaining > 0 {
		if int64(n) > remaining {
			_, _ = b.value.Write(p[:remaining])
			b.truncated = true
		} else {
			_, _ = b.value.Write(p)
		}
	} else {
		b.truncated = true
	}
	return n, nil
}
func (b *boundedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	result := b.value.String()
	if b.truncated {
		result += "\n[output truncated by ubitech-manager]\n"
	}
	return result
}

func NewProcessManager(engine driver.Engine, sandboxes *sandbox.Manager, maxOutput int64) *ProcessManager {
	if maxOutput < 1024 {
		maxOutput = 1 << 20
	}
	manager := &ProcessManager{Engine: engine, Sandboxes: sandboxes, MaxOutput: maxOutput, processes: map[string]*managedProcess{}}
	manager.recoverSandboxProcesses()
	return manager
}

const sandboxProcessWrapper = `
import os, selectors, sys
pid_file, stdout_file, stderr_file, limit, command = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5]
out_r, out_w = os.pipe()
err_r, err_w = os.pipe()
child = os.fork()
if child:
    os.close(out_w); os.close(err_w)
    out_fd = os.open(stdout_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o600)
    err_fd = os.open(stderr_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o600)
    selector = selectors.DefaultSelector()
    selector.register(out_r, selectors.EVENT_READ, (out_fd, stdout_file))
    selector.register(err_r, selectors.EVENT_READ, (err_fd, stderr_file))
    while selector.get_map():
        for key, _ in selector.select(timeout=1):
            chunk = os.read(key.fd, 65536)
            if not chunk:
                selector.unregister(key.fd); os.close(key.fd); continue
            target_fd, target_path = key.data
            os.write(target_fd, chunk)
            size = os.lseek(target_fd, 0, os.SEEK_END)
            if size > limit * 2:
                read_fd = os.open(target_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
                tail = os.pread(read_fd, limit, size - limit)
                os.close(read_fd)
                os.ftruncate(target_fd, 0); os.lseek(target_fd, 0, os.SEEK_SET); os.write(target_fd, tail)
    os.fsync(out_fd); os.fsync(err_fd); os.close(out_fd); os.close(err_fd)
    _, status = os.waitpid(child, 0)
    if os.WIFEXITED(status):
        os._exit(os.WEXITSTATUS(status))
    if os.WIFSIGNALED(status):
        os._exit(128 + os.WTERMSIG(status))
    os._exit(125)
os.close(out_r); os.close(err_r)
os.setsid()
os.umask(0o077)
with open(pid_file, "w", encoding="ascii") as handle:
    start_time = open("/proc/self/stat", "r", encoding="ascii").read().split()[21]
    handle.write("%d %s\n" % (os.getpid(), start_time))
    handle.flush()
    os.fsync(handle.fileno())
os.dup2(out_w, 1); os.dup2(err_w, 2)
os.close(out_w); os.close(err_w)
os.execv("/bin/sh", ["/bin/sh", "-lc", command])
`

const sandboxStopScript = `
file=$1
if [ ! -r "$file" ]; then echo stopped; exit 0; fi
read -r pid expected < "$file" || { echo unknown; exit 0; }
case "$pid:$expected" in *[!0-9:]*) echo unknown; exit 0;; esac
actual=$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || true)
if [ "$actual" != "$expected" ]; then rm -f "$file"; echo stopped; exit 0; fi
if ! kill -0 "$pid" 2>/dev/null; then rm -f "$file"; echo stopped; exit 0; fi
kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
i=0
while [ "$i" -lt 50 ]; do
  if ! kill -0 "$pid" 2>/dev/null; then rm -f "$file"; echo stopped; exit 0; fi
  i=$((i+1)); sleep .1
done
kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
i=0
while [ "$i" -lt 20 ]; do
  if ! kill -0 "$pid" 2>/dev/null; then rm -f "$file"; echo stopped; exit 0; fi
  i=$((i+1)); sleep .1
done
echo running
`

const sandboxStatusScript = `
file=$1
if [ ! -r "$file" ]; then echo stopped; exit 0; fi
read -r pid expected < "$file" || { echo unknown; exit 0; }
case "$pid:$expected" in *[!0-9:]*) echo unknown; exit 0;; esac
actual=$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || true)
if [ "$actual" = "$expected" ] && kill -0 "$pid" 2>/dev/null; then echo running; else rm -f "$file"; echo stopped; fi
`

func (m *ProcessManager) Run(requestContext context.Context, call Call, args terminalArguments) (ProcessSnapshot, error) {
	if args.Command == "" {
		return ProcessSnapshot{}, errors.New("command is required")
	}
	if args.TimeoutMS < 0 || args.TimeoutMS > 24*60*60*1000 {
		return ProcessSnapshot{}, errors.New("timeout_ms is out of range")
	}
	if args.UpdateBehavior != "" && args.UpdateBehavior != "wait" && args.UpdateBehavior != "terminate" {
		return ProcessSnapshot{}, errors.New("invalid update_behavior")
	}
	if !args.Background && args.UpdateBehavior != "" {
		return ProcessSnapshot{}, errors.New("update_behavior requires background=true")
	}
	spec, err := m.Sandboxes.Ensure(requestContext, call.ExecutionContext.SandboxID, call.ExecutionContext.WorkspaceID, time.Now())
	if err != nil {
		return ProcessSnapshot{}, err
	}
	if err := m.Sandboxes.BeginCall(call.ExecutionContext.SandboxID, time.Now()); err != nil {
		return ProcessSnapshot{}, err
	}
	id, err := randomID("proc_")
	if err != nil {
		_ = m.Sandboxes.EndCall(call.ExecutionContext.SandboxID, false, time.Now())
		return ProcessSnapshot{}, err
	}
	cwd := args.CWD
	var name string
	var commandArgs []string
	var pidFile, hostPIDFile, hostStdoutFile, hostStderrFile string
	if call.Target == "sandbox" {
		if cwd == "" {
			cwd = contract.ContainerWorkspace
		}
		if cwd[0] != '/' {
			cwd = contract.ContainerWorkspace + "/" + cwd
		}
		processDir := filepath.Join(spec.Environment, "processes")
		if err := os.MkdirAll(processDir, 0o700); err != nil {
			_ = m.Sandboxes.EndCall(call.ExecutionContext.SandboxID, false, time.Now())
			return ProcessSnapshot{}, err
		}
		hostPIDFile = filepath.Join(processDir, id+".pid")
		hostStdoutFile = filepath.Join(processDir, id+".out")
		hostStderrFile = filepath.Join(processDir, id+".err")
		pidFile = filepath.ToSlash(filepath.Join(contract.ContainerAgentEnv, "processes", id+".pid"))
		_ = os.Remove(hostPIDFile)
		_ = os.Remove(hostStdoutFile)
		_ = os.Remove(hostStderrFile)
		stdoutFile := filepath.ToSlash(filepath.Join(contract.ContainerAgentEnv, "processes", id+".out"))
		stderrFile := filepath.ToSlash(filepath.Join(contract.ContainerAgentEnv, "processes", id+".err"))
		name, commandArgs = m.Engine.ExecArgs(spec, cwd, "python3", []string{"-c", sandboxProcessWrapper, pidFile, stdoutFile, stderrFile, strconv.FormatInt(m.MaxOutput, 10), args.Command})
	} else if call.Target == "host" {
		if cwd == "" {
			cwd = spec.Workspace
		} else if resolved, resolveErr := m.Sandboxes.ResolvePath("host", call.ExecutionContext.SandboxID, cwd); resolveErr == nil {
			cwd = resolved
		} else {
			return ProcessSnapshot{}, resolveErr
		}
		name = "/bin/sh"
		commandArgs = []string{"-lc", args.Command}
	} else {
		return ProcessSnapshot{}, errors.New("invalid target")
	}
	base := requestContext
	if args.Background {
		base = context.Background()
	}
	executionContext, cancel := context.WithCancel(base)
	if args.TimeoutMS > 0 {
		executionContext, cancel = context.WithTimeout(base, time.Duration(args.TimeoutMS)*time.Millisecond)
	}
	command := exec.CommandContext(executionContext, name, commandArgs...)
	if call.Target == "host" {
		command.Dir = cwd
		command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
	}
	stdout, stderr := &boundedBuffer{limit: m.MaxOutput}, &boundedBuffer{limit: m.MaxOutput}
	command.Stdout, command.Stderr = stdout, stderr
	stdin, err := command.StdinPipe()
	if err != nil {
		cancel()
		_ = m.Sandboxes.EndCall(call.ExecutionContext.SandboxID, false, time.Now())
		return ProcessSnapshot{}, err
	}
	now := time.Now().UTC()
	stateFile := ""
	if call.Target == "sandbox" {
		stateFile = filepath.Join(filepath.Dir(m.Sandboxes.StatePath), "processes", spec.AgentHash, id+".json")
	}
	process := &managedProcess{snapshot: ProcessSnapshot{ID: id, RunID: call.RunID, ScopeKey: call.ScopeID, LifecycleID: call.LifecycleID, Target: call.Target, Command: args.Command, CWD: cwd, Status: "running", Stdout: "", Stderr: "", StartedAt: now, Background: args.Background, UpdateBehavior: args.UpdateBehavior}, command: command, stdin: stdin, cancel: cancel, context: executionContext, sandboxID: call.ExecutionContext.SandboxID, spec: spec, pidFile: pidFile, hostPIDFile: hostPIDFile, hostStdoutFile: hostStdoutFile, hostStderrFile: hostStderrFile, stateFile: stateFile, stdout: stdout, stderr: stderr}
	if err := command.Start(); err != nil {
		cancel()
		_ = m.Sandboxes.EndCall(call.ExecutionContext.SandboxID, false, time.Now())
		return ProcessSnapshot{}, err
	}
	process.snapshot.PID = command.Process.Pid
	if call.Target == "sandbox" {
		if containerPID, waitErr := waitForPIDFile(hostPIDFile, 2*time.Second); waitErr != nil {
			cancel()
			_, _ = m.stopSandboxProcess(process)
			_ = m.Sandboxes.EndCall(call.ExecutionContext.SandboxID, false, time.Now())
			return ProcessSnapshot{}, waitErr
		} else {
			process.snapshot.PID = containerPID
		}
	}
	m.mu.Lock()
	m.processes[id] = process
	m.revision++
	m.mu.Unlock()
	_ = m.persistProcess(process)
	if args.Background {
		_ = m.Sandboxes.EndCall(call.ExecutionContext.SandboxID, true, time.Now())
		go m.wait(process)
		return m.snapshot(process), nil
	}
	m.wait(process)
	snapshot := m.snapshot(process)
	_ = m.Sandboxes.EndCall(call.ExecutionContext.SandboxID, snapshot.Status == "orphaned", time.Now())
	if snapshot.Status == "cancelled" {
		return snapshot, context.Canceled
	}
	return snapshot, nil
}

func (m *ProcessManager) wait(process *managedProcess) {
	err := process.command.Wait()
	contextErr := process.context.Err()
	confirmed := true
	if process.snapshot.Target == "sandbox" && err != nil {
		if contextErr != nil {
			confirmed, _ = m.stopSandboxProcess(process)
		} else if running, statusErr := m.sandboxProcessRunning(process); statusErr != nil || running {
			confirmed = false
		}
	}
	process.cancel()
	finished := time.Now().UTC()
	process.mu.Lock()
	process.snapshot.Stdout, process.snapshot.Stderr = process.stdout.String(), process.stderr.String()
	process.snapshot.FinishedAt = &finished
	if err == nil {
		code := 0
		process.snapshot.ExitCode = &code
		process.snapshot.Status = "completed"
	} else if contextErr != nil {
		process.snapshot.StopConfirmed = boolPointer(confirmed)
		if confirmed {
			process.snapshot.Status = "cancelled"
		} else {
			process.snapshot.Status = "orphaned"
			process.snapshot.Background = true
			if process.snapshot.UpdateBehavior == "" {
				process.snapshot.UpdateBehavior = "wait"
			}
		}
	} else if !confirmed {
		process.snapshot.StopConfirmed = boolPointer(false)
		process.snapshot.Status = "orphaned"
		process.snapshot.Background = true
		if process.snapshot.UpdateBehavior == "" {
			process.snapshot.UpdateBehavior = "wait"
		}
	} else {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			code := exitErr.ExitCode()
			process.snapshot.ExitCode = &code
			process.snapshot.Status = "failed"
		} else {
			process.snapshot.Status = "cancelled"
		}
	}
	background := process.snapshot.Background
	orphaned := process.snapshot.Status == "orphaned"
	process.mu.Unlock()
	if process.hostPIDFile != "" && !orphaned {
		_ = os.Remove(process.hostPIDFile)
	}
	m.mu.Lock()
	m.revision++
	m.mu.Unlock()
	_ = m.persistProcess(process)
	if background && !orphaned {
		_ = m.Sandboxes.ProcessExited(process.sandboxID, time.Now())
	}
}

func waitForPIDFile(path string, timeout time.Duration) (int, error) {
	deadline := time.Now().Add(timeout)
	for {
		data, err := os.ReadFile(path)
		if err == nil {
			fields := bytes.Fields(data)
			if len(fields) == 0 {
				continue
			}
			pid, parseErr := strconv.Atoi(string(fields[0]))
			if parseErr == nil && pid > 1 {
				return pid, nil
			}
		}
		if err != nil && !os.IsNotExist(err) {
			return 0, err
		}
		if time.Now().After(deadline) {
			return 0, errors.New("sandbox process did not publish its managed PID")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func boolPointer(value bool) *bool { return &value }

func (m *ProcessManager) persistProcess(process *managedProcess) error {
	if process.stateFile == "" {
		return nil
	}
	value := persistedProcess{Snapshot: m.snapshot(process), SandboxID: process.sandboxID, PIDFile: process.pidFile, HostPIDFile: process.hostPIDFile, StdoutFile: process.hostStdoutFile, StderrFile: process.hostStderrFile}
	return atomicfile.WriteJSON(process.stateFile, value, 0o600)
}

func (m *ProcessManager) recoverSandboxProcesses() {
	counts := map[string]int{}
	for _, record := range m.Sandboxes.Records() {
		spec, err := m.Sandboxes.Spec(record.SandboxID)
		if err != nil {
			continue
		}
		files, _ := filepath.Glob(filepath.Join(filepath.Dir(m.Sandboxes.StatePath), "processes", spec.AgentHash, "*.json"))
		for _, stateFile := range files {
			var state persistedProcess
			if err := atomicfile.ReadJSON(stateFile, &state); err != nil || state.SandboxID != record.SandboxID || state.Snapshot.Target != "sandbox" || state.Snapshot.ID == "" {
				continue
			}
			stdout, stderr := &boundedBuffer{limit: m.MaxOutput}, &boundedBuffer{limit: m.MaxOutput}
			_, _ = stdout.Write([]byte(state.Snapshot.Stdout))
			_, _ = stderr.Write([]byte(state.Snapshot.Stderr))
			process := &managedProcess{snapshot: state.Snapshot, cancel: func() {}, context: context.Background(), sandboxID: state.SandboxID, spec: spec, pidFile: state.PIDFile, hostPIDFile: state.HostPIDFile, hostStdoutFile: state.StdoutFile, hostStderrFile: state.StderrFile, stateFile: stateFile, stdout: stdout, stderr: stderr}
			if activeProcessStatus(process.snapshot.Status) {
				running, statusErr := m.sandboxProcessRunning(process)
				if statusErr != nil {
					process.snapshot.Status = "orphaned"
					process.snapshot.StopConfirmed = boolPointer(false)
					running = true
				}
				if running {
					process.snapshot.Background = true
					if process.snapshot.UpdateBehavior == "" {
						process.snapshot.UpdateBehavior = "wait"
					}
					counts[state.SandboxID]++
					go m.watchRecoveredProcess(process)
				} else {
					now := time.Now().UTC()
					process.snapshot.Status = "completed"
					process.snapshot.FinishedAt = &now
					process.snapshot.StopConfirmed = nil
					_ = m.persistProcess(process)
				}
			}
			m.processes[process.snapshot.ID] = process
		}
	}
	_ = m.Sandboxes.ReconcileProcesses(counts, time.Now())
}

func (m *ProcessManager) watchRecoveredProcess(process *managedProcess) {
	for {
		time.Sleep(time.Second)
		running, err := m.sandboxProcessRunning(process)
		if err != nil || running {
			continue
		}
		now := time.Now().UTC()
		process.mu.Lock()
		if activeProcessStatus(process.snapshot.Status) {
			process.snapshot.Status = "completed"
			process.snapshot.FinishedAt = &now
			process.snapshot.StopConfirmed = nil
		}
		process.mu.Unlock()
		_ = m.persistProcess(process)
		_ = m.Sandboxes.ProcessExited(process.sandboxID, now)
		m.mu.Lock()
		m.revision++
		m.mu.Unlock()
		return
	}
}

func (m *ProcessManager) sandboxCommand(process *managedProcess, script string) (string, error) {
	name, args := m.Engine.ExecArgs(process.spec, contract.ContainerAgentEnv, "/bin/sh", []string{"-c", script, "ubitech-manager", process.pidFile})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("sandbox process control: %w", err)
	}
	return string(bytes.TrimSpace(output)), nil
}

func (m *ProcessManager) sandboxProcessRunning(process *managedProcess) (bool, error) {
	status, err := m.sandboxCommand(process, sandboxStatusScript)
	if err != nil {
		return true, err
	}
	switch status {
	case "running":
		return true, nil
	case "stopped":
		return false, nil
	default:
		return true, fmt.Errorf("sandbox process returned an indeterminate state %q", status)
	}
}

func (m *ProcessManager) stopSandboxProcess(process *managedProcess) (bool, error) {
	process.stopMu.Lock()
	defer process.stopMu.Unlock()
	status, err := m.sandboxCommand(process, sandboxStopScript)
	if err != nil {
		return false, err
	}
	if status != "stopped" {
		return false, fmt.Errorf("sandbox process termination was not confirmed: %s", status)
	}
	return true, nil
}

func (m *ProcessManager) stopHostProcess(process *managedProcess) bool {
	process.mu.Lock()
	pid := process.snapshot.PID
	process.mu.Unlock()
	if pid <= 1 {
		return false
	}
	_ = syscall.Kill(-pid, syscall.SIGTERM)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(-pid, 0); errors.Is(err, syscall.ESRCH) {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	_ = syscall.Kill(-pid, syscall.SIGKILL)
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(-pid, 0); errors.Is(err, syscall.ESRCH) {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

func (m *ProcessManager) stopProcess(process *managedProcess) bool {
	process.mu.Lock()
	target := process.snapshot.Target
	process.mu.Unlock()
	confirmed := false
	if target == "sandbox" {
		confirmed, _ = m.stopSandboxProcess(process)
	} else {
		confirmed = m.stopHostProcess(process)
	}
	if process.cancel != nil {
		process.cancel()
	}
	process.mu.Lock()
	process.snapshot.StopConfirmed = boolPointer(confirmed)
	if confirmed && process.command == nil {
		now := time.Now().UTC()
		process.snapshot.Status = "cancelled"
		process.snapshot.FinishedAt = &now
	}
	process.mu.Unlock()
	if confirmed && process.command == nil {
		_ = m.persistProcess(process)
		_ = m.Sandboxes.ProcessExited(process.sandboxID, time.Now())
	}
	return confirmed
}
func (m *ProcessManager) snapshot(process *managedProcess) ProcessSnapshot {
	process.mu.Lock()
	defer process.mu.Unlock()
	value := process.snapshot
	value.Stdout, value.Stderr = process.stdout.String(), process.stderr.String()
	if process.hostStdoutFile != "" {
		if output, err := readTailFile(process.hostStdoutFile, m.MaxOutput); err == nil {
			value.Stdout = output
		}
	}
	if process.hostStderrFile != "" {
		if output, err := readTailFile(process.hostStderrFile, m.MaxOutput); err == nil {
			value.Stderr = output
		}
	}
	return value
}

func readTailFile(path string, limit int64) (string, error) {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return "", err
	}
	file := os.NewFile(uintptr(fd), filepath.Base(path))
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", errors.New("process output is not a regular file")
	}
	if limit < 1 {
		limit = 1 << 20
	}
	start := info.Size() - limit
	if start < 0 {
		start = 0
	}
	if _, err := file.Seek(start, io.SeekStart); err != nil {
		return "", err
	}
	data, err := io.ReadAll(io.LimitReader(file, limit))
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func (m *ProcessManager) List(scope, lifecycle string, target ...string) []ProcessSnapshot {
	m.mu.Lock()
	values := make([]*managedProcess, 0, len(m.processes))
	for _, p := range m.processes {
		values = append(values, p)
	}
	m.mu.Unlock()
	result := make([]ProcessSnapshot, 0)
	for _, p := range values {
		s := m.snapshot(p)
		if s.ScopeKey == scope && (lifecycle == "" || s.LifecycleID == lifecycle) && (len(target) == 0 || s.Target == target[0]) {
			result = append(result, s)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].StartedAt.Before(result[j].StartedAt) })
	return result
}
func (m *ProcessManager) Get(scope, lifecycle, target, id string) (ProcessSnapshot, error) {
	m.mu.Lock()
	p, ok := m.processes[id]
	m.mu.Unlock()
	if !ok {
		return ProcessSnapshot{}, errors.New("process not found")
	}
	s := m.snapshot(p)
	if s.ScopeKey != scope || s.Target != target || (lifecycle != "" && s.LifecycleID != lifecycle) {
		return ProcessSnapshot{}, errors.New("process not found")
	}
	return s, nil
}
func (m *ProcessManager) Write(scope, lifecycle, target, id, input string) error {
	m.mu.Lock()
	p, ok := m.processes[id]
	m.mu.Unlock()
	if !ok {
		return errors.New("process not found")
	}
	s := m.snapshot(p)
	if s.ScopeKey != scope || s.Target != target || (lifecycle != "" && s.LifecycleID != lifecycle) || !activeProcessStatus(s.Status) {
		return errors.New("process is not running")
	}
	if p.stdin == nil {
		return errors.New("input is unavailable for a process recovered after Manager restart")
	}
	_, err := io.WriteString(p.stdin, input)
	return err
}
func (m *ProcessManager) Kill(scope, lifecycle, target, id string) (ProcessSnapshot, error) {
	m.mu.Lock()
	p, ok := m.processes[id]
	m.mu.Unlock()
	if !ok {
		return ProcessSnapshot{}, errors.New("process not found")
	}
	s := m.snapshot(p)
	if s.ScopeKey != scope || s.Target != target || (lifecycle != "" && s.LifecycleID != lifecycle) {
		return ProcessSnapshot{}, errors.New("process not found")
	}
	if !activeProcessStatus(s.Status) {
		return s, nil
	}
	if !m.stopProcess(p) {
		return m.snapshot(p), errors.New("process termination could not be confirmed")
	}
	if !confirmStopped([]*managedProcess{p}, 3*time.Second) {
		return m.snapshot(p), errors.New("process controller did not observe termination")
	}
	return m.snapshot(p), nil
}
func (m *ProcessManager) CancelRun(runID, scope, lifecycle string) bool {
	m.mu.Lock()
	values := make([]*managedProcess, 0)
	for _, p := range m.processes {
		values = append(values, p)
	}
	m.mu.Unlock()
	matched := make([]*managedProcess, 0)
	for _, p := range values {
		s := m.snapshot(p)
		if s.RunID == runID && s.ScopeKey == scope && s.LifecycleID == lifecycle && activeProcessStatus(s.Status) {
			if !m.stopProcess(p) {
				return false
			}
			matched = append(matched, p)
		}
	}
	return confirmStopped(matched, 2*time.Second)
}
func (m *ProcessManager) CleanupScope(scope, lifecycle string) bool {
	m.mu.Lock()
	values := make([]*managedProcess, 0)
	for _, p := range m.processes {
		values = append(values, p)
	}
	m.mu.Unlock()
	matched := make([]*managedProcess, 0)
	for _, p := range values {
		s := m.snapshot(p)
		if s.ScopeKey == scope && (lifecycle == "" || s.LifecycleID == lifecycle) && activeProcessStatus(s.Status) {
			if !m.stopProcess(p) {
				return false
			}
			matched = append(matched, p)
		}
	}
	return confirmStopped(matched, 3*time.Second)
}

// ShutdownHost terminates every host process group before the Manager exits.
// Sandbox processes use the durable in-container protocol and intentionally
// survive a Manager restart; host children instead share the user-systemd
// service lifecycle and must never become untracked after restart.
func (m *ProcessManager) ShutdownHost() bool {
	m.mu.Lock()
	values := make([]*managedProcess, 0, len(m.processes))
	for _, process := range m.processes {
		values = append(values, process)
	}
	m.mu.Unlock()
	matched := make([]*managedProcess, 0)
	for _, process := range values {
		snapshot := m.snapshot(process)
		if snapshot.Target == "host" && activeProcessStatus(snapshot.Status) {
			if !m.stopProcess(process) {
				return false
			}
			matched = append(matched, process)
		}
	}
	return confirmStopped(matched, 5*time.Second)
}

func activeProcessStatus(status string) bool { return status == "running" || status == "orphaned" }
func confirmStopped(processes []*managedProcess, timeout time.Duration) bool {
	if len(processes) == 0 {
		return true
	}
	deadline := time.Now().Add(timeout)
	for {
		all := true
		for _, process := range processes {
			process.mu.Lock()
			running := activeProcessStatus(process.snapshot.Status)
			process.mu.Unlock()
			if running {
				all = false
				break
			}
		}
		if all {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(20 * time.Millisecond)
	}
}
func (m *ProcessManager) Preview(scope, lifecycle, since string) map[string]any {
	list := m.List(scope, lifecycle)
	m.mu.Lock()
	revision := fmt.Sprintf("%d", m.revision)
	m.mu.Unlock()
	if since == revision {
		return map[string]any{"processes": []any{}, "revision": revision, "unchanged": true}
	}
	previews := make([]map[string]any, 0, len(list))
	if len(list) > 16 {
		list = list[len(list)-16:]
	}
	for _, p := range list {
		output := p.Stdout
		if p.Stderr != "" {
			output += "\n[stderr]\n" + p.Stderr
		}
		if len(output) > 16*1024 {
			output = output[len(output)-16*1024:]
		}
		previews = append(previews, map[string]any{"id": p.ID, "title": p.Command, "command": p.Command, "cwd": p.CWD, "output": output, "status": p.Status, "running": activeProcessStatus(p.Status), "exit_code": p.ExitCode, "started_at": p.StartedAt, "updated_at": time.Now().UTC(), "finished_at": p.FinishedAt, "truncated": len(p.Stdout)+len(p.Stderr) > len(output)})
	}
	return map[string]any{"processes": previews, "revision": revision}
}
func (m *ProcessManager) RunningCount(scope, lifecycle string) int {
	count := 0
	for _, p := range m.List(scope, lifecycle) {
		if activeProcessStatus(p.Status) {
			count++
		}
	}
	return count
}
func (m *ProcessManager) UpdateBlockers() (int, int, int) {
	m.mu.Lock()
	values := make([]*managedProcess, 0)
	for _, p := range m.processes {
		values = append(values, p)
	}
	m.mu.Unlock()
	running, blocking, terminable := 0, 0, 0
	for _, p := range values {
		s := m.snapshot(p)
		if s.Background && activeProcessStatus(s.Status) {
			running++
			if s.UpdateBehavior == "terminate" {
				terminable++
			} else {
				blocking++
			}
		}
	}
	return running, blocking, terminable
}
