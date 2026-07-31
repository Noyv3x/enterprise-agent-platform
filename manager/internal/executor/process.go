package executor

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/driver"
	technicalidentity "github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/sandbox"
)

type ProcessManager struct {
	Engine              driver.Engine
	Sandboxes           *sandbox.Manager
	MaxOutput           int64
	mu                  sync.Mutex
	processes           map[string]*managedProcess
	pendingByFamily     map[string]int
	pendingGlobal       int
	maxRunningPerFamily int
	maxRunningGlobal    int
	maxCompletedRecords int
	completedRecordTTL  time.Duration
	previewID           string
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
		result += "\n[output truncated by platform manager]\n"
	}
	return result
}

func NewProcessManager(engine driver.Engine, sandboxes *sandbox.Manager, maxOutput int64) *ProcessManager {
	if maxOutput < 1024 {
		maxOutput = 1 << 20
	}
	manager := &ProcessManager{
		Engine: engine, Sandboxes: sandboxes, MaxOutput: maxOutput,
		processes:           map[string]*managedProcess{},
		pendingByFamily:     map[string]int{},
		maxRunningPerFamily: 16,
		maxRunningGlobal:    128,
		maxCompletedRecords: 64,
		completedRecordTTL:  time.Hour,
		previewID:           newPreviewID(),
	}
	manager.recoverSandboxProcesses()
	manager.pruneCompleted(time.Now())
	return manager
}

func newPreviewID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err == nil {
		return hex.EncodeToString(value[:])
	}
	// The cursor is not a capability, but it must still change across Manager
	// restarts. Keep startup available if the host entropy source is transiently
	// unavailable while retaining process/time/address separation.
	fallback := sha256.Sum256([]byte(fmt.Sprintf(
		"%d:%d:%p", time.Now().UnixNano(), os.Getpid(), &value,
	)))
	return hex.EncodeToString(fallback[:16])
}

func scopeFamilyRoot(scope string) string {
	if index := strings.Index(scope, "/delegate/"); index >= 0 {
		return scope[:index]
	}
	return scope
}

func (m *ProcessManager) reserveProcessSlot(scope string) error {
	family := scopeFamilyRoot(scope)
	m.mu.Lock()
	defer m.mu.Unlock()
	runningGlobal := 0
	runningFamily := 0
	for _, process := range m.processes {
		process.mu.Lock()
		active := activeProcessStatus(process.snapshot.Status)
		processScope := process.snapshot.ScopeKey
		process.mu.Unlock()
		if !active {
			continue
		}
		runningGlobal++
		if scopeFamilyRoot(processScope) == family {
			runningFamily++
		}
	}
	if runningFamily+m.pendingByFamily[family] >= m.maxRunningPerFamily {
		return fmt.Errorf("Agent scope family already owns %d running processes", m.maxRunningPerFamily)
	}
	if runningGlobal+m.pendingGlobal >= m.maxRunningGlobal {
		return fmt.Errorf("Manager already owns %d running processes", m.maxRunningGlobal)
	}
	m.pendingByFamily[family]++
	m.pendingGlobal++
	return nil
}

func (m *ProcessManager) releaseProcessSlot(scope string) {
	m.mu.Lock()
	m.releaseProcessSlotLocked(scope)
	m.mu.Unlock()
}

func (m *ProcessManager) releaseProcessSlotLocked(scope string) {
	family := scopeFamilyRoot(scope)
	if count := m.pendingByFamily[family]; count > 1 {
		m.pendingByFamily[family] = count - 1
	} else {
		delete(m.pendingByFamily, family)
	}
	if m.pendingGlobal > 0 {
		m.pendingGlobal--
	}
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

const hostProcessWrapper = `
cd /proc/self/fd/3 || exit 125
exec 3<&-
exec /bin/sh -lc "$1"
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
	spec, err := m.Sandboxes.Ensure(requestContext, call.ExecutionContext.SandboxID, call.ExecutionContext.WorkspaceID, time.Now())
	if err != nil {
		return ProcessSnapshot{}, err
	}
	if err := m.Sandboxes.BeginCall(call.ExecutionContext.SandboxID, time.Now()); err != nil {
		return ProcessSnapshot{}, err
	}
	callOpen := true
	defer func() {
		if callOpen {
			_ = m.Sandboxes.EndCall(call.ExecutionContext.SandboxID, false, time.Now())
		}
	}()
	id, err := randomID("proc_")
	if err != nil {
		return ProcessSnapshot{}, err
	}
	m.pruneCompleted(time.Now())
	if err := m.reserveProcessSlot(call.ScopeID); err != nil {
		return ProcessSnapshot{}, err
	}
	reserved := true
	defer func() {
		if reserved {
			m.releaseProcessSlot(call.ScopeID)
		}
	}()
	cwd := args.CWD
	var name string
	var commandArgs []string
	var pidFile, hostPIDFile, hostStdoutFile, hostStderrFile string
	var hostWorkingDirectory *os.File
	defer func() {
		if hostWorkingDirectory != nil {
			_ = hostWorkingDirectory.Close()
		}
	}()
	if call.Target == "sandbox" {
		if cwd == "" {
			cwd = contract.ContainerWorkspace
		}
		if cwd[0] != '/' {
			cwd = contract.ContainerWorkspace + "/" + cwd
		}
		processDir := filepath.Join(spec.Environment, "processes")
		if err := os.MkdirAll(processDir, 0o700); err != nil {
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
			cwd = contract.ContainerWorkspace
		}
		resolved, resolveErr := m.Sandboxes.ResolveHostPath(call.ExecutionContext.SandboxID, cwd, sandbox.HostPathWorkingDirectory)
		if resolveErr != nil {
			return ProcessSnapshot{}, resolveErr
		}
		hostWorkingDirectory, err = openHostWorkingDirectory(resolved)
		if err != nil {
			return ProcessSnapshot{}, err
		}
		cwd = resolved.Canonical
		name = "/bin/sh"
		commandArgs = []string{"-c", hostProcessWrapper, technicalidentity.SourceProfile().ManagerBinary, args.Command}
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
		command.Dir = string(filepath.Separator)
		command.ExtraFiles = []*os.File{hostWorkingDirectory}
		command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
	}
	stdout, stderr := &boundedBuffer{limit: m.MaxOutput}, &boundedBuffer{limit: m.MaxOutput}
	command.Stdout, command.Stderr = stdout, stderr
	stdin, err := command.StdinPipe()
	if err != nil {
		cancel()
		return ProcessSnapshot{}, err
	}
	now := time.Now().UTC()
	stateFile := ""
	if call.Target == "sandbox" {
		stateFile = filepath.Join(filepath.Dir(m.Sandboxes.StatePath), "processes", spec.AgentHash, id+".json")
	}
	process := &managedProcess{snapshot: ProcessSnapshot{ID: id, RunID: call.RunID, ScopeKey: call.ScopeID, LifecycleID: call.LifecycleID, Target: call.Target, Command: args.Command, CWD: cwd, Status: "running", Stdout: "", Stderr: "", StartedAt: now, Background: args.Background}, command: command, stdin: stdin, cancel: cancel, context: executionContext, sandboxID: call.ExecutionContext.SandboxID, spec: spec, pidFile: pidFile, hostPIDFile: hostPIDFile, hostStdoutFile: hostStdoutFile, hostStderrFile: hostStderrFile, stateFile: stateFile, stdout: stdout, stderr: stderr}
	if err := command.Start(); err != nil {
		cancel()
		return ProcessSnapshot{}, err
	}
	if hostWorkingDirectory != nil {
		_ = hostWorkingDirectory.Close()
		hostWorkingDirectory = nil
	}
	process.snapshot.PID = command.Process.Pid
	if call.Target == "sandbox" {
		if containerPID, waitErr := waitForPIDFile(hostPIDFile, 2*time.Second); waitErr != nil {
			cancel()
			_, _ = m.stopSandboxProcess(process)
			return ProcessSnapshot{}, waitErr
		} else {
			process.snapshot.PID = containerPID
		}
	}
	m.mu.Lock()
	m.releaseProcessSlotLocked(call.ScopeID)
	m.processes[id] = process
	m.mu.Unlock()
	reserved = false
	_ = m.persistProcess(process)
	if args.Background {
		_ = m.Sandboxes.EndCall(call.ExecutionContext.SandboxID, true, time.Now())
		callOpen = false
		go m.wait(process)
		return m.snapshot(process), nil
	}
	m.wait(process)
	snapshot := m.snapshot(process)
	_ = m.Sandboxes.EndCall(call.ExecutionContext.SandboxID, snapshot.Status == "orphaned", time.Now())
	callOpen = false
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
		}
	} else if !confirmed {
		process.snapshot.StopConfirmed = boolPointer(false)
		process.snapshot.Status = "orphaned"
		process.snapshot.Background = true
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
	_ = m.persistProcess(process)
	if background && !orphaned {
		_ = m.Sandboxes.ProcessExited(process.sandboxID, time.Now())
	}
	m.pruneCompleted(time.Now())
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

func (m *ProcessManager) pruneCompleted(now time.Time) {
	type completedProcess struct {
		id       string
		finished time.Time
		process  *managedProcess
	}
	candidates := make([]completedProcess, 0)
	m.mu.Lock()
	for id, process := range m.processes {
		process.mu.Lock()
		active := activeProcessStatus(process.snapshot.Status)
		finished := process.snapshot.StartedAt
		if process.snapshot.FinishedAt != nil {
			finished = *process.snapshot.FinishedAt
		}
		process.mu.Unlock()
		if !active {
			candidates = append(candidates, completedProcess{id: id, finished: finished, process: process})
		}
	}
	sort.Slice(candidates, func(i, j int) bool {
		if !candidates[i].finished.Equal(candidates[j].finished) {
			return candidates[i].finished.After(candidates[j].finished)
		}
		return candidates[i].id > candidates[j].id
	})
	removed := make([]*managedProcess, 0)
	for index, candidate := range candidates {
		expired := m.completedRecordTTL > 0 && now.Sub(candidate.finished) > m.completedRecordTTL
		if index >= m.maxCompletedRecords || expired {
			delete(m.processes, candidate.id)
			removed = append(removed, candidate.process)
		}
	}
	m.mu.Unlock()
	for _, process := range removed {
		m.removeCompletedProcessFiles(process)
	}
}

func removeFileWithin(root, path string) {
	if root == "" || path == "" {
		return
	}
	root = filepath.Clean(root)
	path = filepath.Clean(path)
	relative, err := filepath.Rel(root, path)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return
	}
	_ = os.Remove(path)
}

func (m *ProcessManager) removeCompletedProcessFiles(process *managedProcess) {
	stateRoot := filepath.Join(filepath.Dir(m.Sandboxes.StatePath), "processes")
	outputRoot := filepath.Join(process.spec.Environment, "processes")
	removeFileWithin(stateRoot, process.stateFile)
	removeFileWithin(outputRoot, process.hostPIDFile)
	removeFileWithin(outputRoot, process.hostStdoutFile)
	removeFileWithin(outputRoot, process.hostStderrFile)
	if process.stateFile != "" {
		_ = os.Remove(filepath.Dir(process.stateFile))
	}
	if process.spec.Environment != "" {
		_ = os.Remove(outputRoot)
	}
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
		m.pruneCompleted(now)
		return
	}
}

func (m *ProcessManager) sandboxCommand(process *managedProcess, script string) (string, error) {
	name, args := m.Engine.ExecArgs(process.spec, contract.ContainerAgentEnv, "/bin/sh", []string{"-c", script, technicalidentity.SourceProfile().ManagerBinary, process.pidFile})
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
	m.pruneCompleted(time.Now())
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
	sortProcessSnapshots(result)
	return result
}

func (m *ProcessManager) listScopeFamily(scope, lifecycle string) []ProcessSnapshot {
	m.pruneCompleted(time.Now())
	m.mu.Lock()
	values := make([]*managedProcess, 0, len(m.processes))
	for _, process := range m.processes {
		values = append(values, process)
	}
	m.mu.Unlock()
	result := make([]ProcessSnapshot, 0)
	for _, process := range values {
		snapshot := m.snapshot(process)
		if scopeFamilyOwns(scope, snapshot.ScopeKey) && (lifecycle == "" || snapshot.LifecycleID == lifecycle) {
			result = append(result, snapshot)
		}
	}
	sortProcessSnapshots(result)
	return result
}

func sortProcessSnapshots(processes []ProcessSnapshot) {
	sort.Slice(processes, func(i, j int) bool {
		leftActive := activeProcessStatus(processes[i].Status)
		rightActive := activeProcessStatus(processes[j].Status)
		if leftActive != rightActive {
			return leftActive
		}
		if !processes[i].StartedAt.Equal(processes[j].StartedAt) {
			return processes[i].StartedAt.After(processes[j].StartedAt)
		}
		return processes[i].ID < processes[j].ID
	})
}

func scopeFamilyOwns(root, candidate string) bool {
	return candidate == root || (root != "" && strings.HasPrefix(candidate, root+"/delegate/"))
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
		if scopeFamilyOwns(scope, s.ScopeKey) && (lifecycle == "" || s.LifecycleID == lifecycle) && activeProcessStatus(s.Status) {
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
	list := m.listScopeFamily(scope, lifecycle)
	previews := make([]map[string]any, 0, len(list))
	if len(list) > 16 {
		list = list[:16]
	}
	fingerprint := sha256.New()
	writeFingerprint := func(value string) {
		_, _ = fmt.Fprintf(fingerprint, "%d:", len(value))
		_, _ = fingerprint.Write([]byte(value))
	}
	writeFingerprint(scope)
	writeFingerprint(lifecycle)
	updatedAt := time.Now().UTC()
	for _, p := range list {
		output := p.Stdout
		if p.Stderr != "" {
			output += "\n[stderr]\n" + p.Stderr
		}
		if len(output) > 16*1024 {
			output = output[len(output)-16*1024:]
		}
		truncated := len(p.Stdout)+len(p.Stderr) > len(output)
		exitCode := ""
		if p.ExitCode != nil {
			exitCode = strconv.Itoa(*p.ExitCode)
		}
		finishedAt := ""
		if p.FinishedAt != nil {
			finishedAt = p.FinishedAt.Format(time.RFC3339Nano)
		}
		for _, value := range []string{
			p.ID, p.Command, p.CWD, output, p.Status,
			strconv.FormatBool(activeProcessStatus(p.Status)),
			exitCode, p.StartedAt.Format(time.RFC3339Nano), finishedAt,
			strconv.FormatBool(truncated),
		} {
			writeFingerprint(value)
		}
		previews = append(previews, map[string]any{"id": p.ID, "title": p.Command, "command": p.Command, "cwd": p.CWD, "output": output, "status": p.Status, "running": activeProcessStatus(p.Status), "exit_code": p.ExitCode, "started_at": p.StartedAt, "updated_at": updatedAt, "finished_at": p.FinishedAt, "truncated": truncated})
	}
	digest := fingerprint.Sum(nil)
	var revisionNumber uint64
	for _, value := range digest[:8] {
		revisionNumber = revisionNumber<<8 | uint64(value)
	}
	revision := fmt.Sprintf("preview_manager_%s:%d", m.previewID, revisionNumber)
	if since == revision {
		return map[string]any{"processes": []any{}, "revision": revision, "unchanged": true}
	}
	return map[string]any{"processes": previews, "revision": revision}
}
func (m *ProcessManager) RunningCount(scope, lifecycle string) int {
	count := 0
	for _, p := range m.listScopeFamily(scope, lifecycle) {
		if activeProcessStatus(p.Status) {
			count++
		}
	}
	return count
}

// ActiveBackgroundCount returns the number of managed background processes
// that are still running or whose termination could not be confirmed. Every
// such process delays an update; the Manager never terminates one for cutover.
func (m *ProcessManager) ActiveBackgroundCount() int {
	m.mu.Lock()
	values := make([]*managedProcess, 0, len(m.processes))
	for _, p := range m.processes {
		values = append(values, p)
	}
	m.mu.Unlock()
	count := 0
	for _, p := range values {
		s := m.snapshot(p)
		if s.Background && activeProcessStatus(s.Status) {
			count++
		}
	}
	return count
}
