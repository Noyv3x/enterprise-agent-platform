package executor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/driver"
	technicalidentity "github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/sandbox"
)

// ProcessManager retains executing calls and unconfirmed termination evidence.
// Startup stops managed sandboxes before serving calls after a Manager restart.
type ProcessManager struct {
	Engine    driver.Engine
	Sandboxes *sandbox.Manager
	MaxOutput int64
	mu        sync.Mutex
	runs      map[*foregroundRun]struct{}
}

type foregroundRun struct {
	identity  Identity
	cancel    context.CancelFunc
	done      chan struct{}
	confirmed bool // published by closing done
}

type boundedBuffer struct {
	mu        sync.Mutex
	value     bytes.Buffer
	limit     int64
	truncated bool
	private   bool
	redactor  outputRedactor
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.private {
		b.writeSanitizedLocked(p)
	} else {
		b.redactor.Write(p, b.writeSanitizedLocked)
	}
	return len(p), nil
}
func (b *boundedBuffer) writeSanitizedLocked(p []byte) {
	remaining := max(0, b.limit-int64(b.value.Len()))
	if int64(len(p)) > remaining {
		p = p[:remaining]
		b.truncated = true
	}
	_, _ = b.value.Write(p)
}
func (b *boundedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	result := b.value.String()
	pending := ""
	if !b.private {
		pending = b.redactor.Preview()
	}
	remaining := max(0, b.limit-int64(len(result)))
	truncated := b.truncated || int64(len(pending)) > remaining
	if int64(len(pending)) > remaining {
		pending = pending[:remaining]
	}
	result += pending
	if truncated {
		result += "\n[output truncated by platform manager]\n"
	}
	return result
}
func (b *boundedBuffer) Flush() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.private {
		b.redactor.Flush(b.writeSanitizedLocked)
	}
}

func NewProcessManager(active technicalidentity.ActiveProfile, engine driver.Engine, sandboxes *sandbox.Manager, maxOutput int64) (*ProcessManager, error) {
	if _, err := active.Profile(); err != nil {
		return nil, fmt.Errorf("process executor technical profile: %w", err)
	}
	if maxOutput < 1024 {
		maxOutput = 1 << 20
	}
	return &ProcessManager{Engine: engine, Sandboxes: sandboxes, MaxOutput: maxOutput, runs: map[*foregroundRun]struct{}{}}, nil
}

// The attached stdin is a lifetime lease, not command input. EOF (including a
// lost Manager connection) or the independent deadline kills the entire child
// process group. The wrapper is a subreaper so confirmation includes reaping
// grandchildren, even when their parent exits first. Output and final status
// share a framed stream; command output cannot forge termination confirmation.
const sandboxProcessWrapper = `
import base64, ctypes, errno, json, os, selectors, signal, sys, time
ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0 or sys.exit(125)
deadline = time.monotonic() + int(sys.argv[1]) / 1000
out_r, out_w = os.pipe()
err_r, err_w = os.pipe()
ready_r, ready_w = os.pipe()
child = os.fork()
if child == 0:
    os.close(ready_r)
    os.setsid()
    os.umask(0o077)
    os.dup2(os.open('/dev/null', os.O_RDONLY), 0)
    os.dup2(out_w, 1); os.dup2(err_w, 2)
    for fd in (out_r, out_w, err_r, err_w): os.close(fd)
    os.write(ready_w, b'1'); os.close(ready_w)
    os.execv('/bin/sh', ['/bin/sh', '-lc', sys.argv[2]])
os.close(ready_w); os.close(out_w); os.close(err_w)
if os.read(ready_r, 1) != b'1': sys.exit(125)
os.close(ready_r)
selector = selectors.DefaultSelector()
selector.register(0, selectors.EVENT_READ, 'lease')
selector.register(out_r, selectors.EVENT_READ, 'stdout')
selector.register(err_r, selectors.EVENT_READ, 'stderr')
status = None
cancelled = False
stopping = None
confirmed = False
def emit(value):
    try:
        sys.stdout.write(json.dumps(value) + '\n'); sys.stdout.flush()
    except (BrokenPipeError, OSError):
        pass
def kill_group():
    try: os.killpg(child, signal.SIGKILL)
    except ProcessLookupError: pass
try:
    while True:
        # Observe without reaping: the leader pins its process-group identity
        # until the only group signal has been sent.
        exited = stopping is None and os.waitid(os.P_PID, child, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None
        now = time.monotonic()
        if now >= deadline: cancelled = True
        if stopping is None and (cancelled or exited):
            kill_group()
            stopping = now
        if stopping is not None:
            # A descendant may create another session and escape the original
            # group. Subreaper adoption brings it back under this supervisor.
            # No other thread reaps children, so each PID stays pinned between
            # enumeration and signaling, even if the child exits meanwhile.
            with open('/proc/self/task/%d/children' % os.getpid(), encoding='ascii') as children:
                for pid in map(int, children.read().split()):
                    try: os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError: pass
            while True:
                try: pid, value = os.waitpid(-1, os.WNOHANG)
                except ChildProcessError:
                    confirmed = True
                    break
                if pid == 0: break
                if pid == child: status = os.waitstatus_to_exitcode(value)
            if confirmed and all(key.data == 'lease' for key in selector.get_map().values()): break
            if now - stopping >= 2: break
        for key, _ in selector.select(timeout=0.02):
            data = os.read(key.fd, 8192)
            if key.data == 'lease':
                if not data:
                    cancelled = True
                    selector.unregister(key.fd)
            elif data:
                emit({'stream': key.data, 'data': base64.b64encode(data).decode('ascii')})
            else:
                selector.unregister(key.fd); os.close(key.fd)
    emit({'stream': 'exit', 'code': status if status is not None else -1, 'confirmed': confirmed, 'cancelled': cancelled})
finally:
    if stopping is None: kill_group()
`

func validateTerminalArguments(args terminalArguments) error {
	if args.Command == "" {
		return errors.New("command is required")
	}
	if args.Background {
		return errors.New("background commands are not supported")
	}
	if args.TimeoutMS != 0 && (args.TimeoutMS < terminalTimeoutMinimumMilliseconds || args.TimeoutMS > terminalTimeoutMaximumMilliseconds) {
		return errors.New("timeout_ms is out of range")
	}
	return nil
}

type executionFrame struct {
	Stream    string `json:"stream"`
	Data      []byte `json:"data"`
	Code      int    `json:"code"`
	Confirmed bool   `json:"confirmed"`
	Cancelled bool   `json:"cancelled"`
}

func scopeFamilyRoot(scope string) string {
	if index := strings.Index(scope, "/delegate/"); index >= 0 {
		return scope[:index]
	}
	return scope
}

func (m *ProcessManager) Run(requestContext context.Context, call Call, args terminalArguments) (result ProcessSnapshot, runErr error) {
	if err := validateTerminalArguments(args); err != nil {
		return result, err
	}
	if call.Target != "sandbox" {
		return result, errors.New("target must be sandbox")
	}
	timeout := args.TimeoutMS
	if timeout == 0 {
		timeout = terminalTimeoutDefaultMilliseconds
	}
	ctx, cancel := context.WithTimeout(requestContext, time.Duration(timeout)*time.Millisecond)
	defer cancel()
	run := &foregroundRun{identity: call.Identity, cancel: cancel, done: make(chan struct{}), confirmed: true}
	m.mu.Lock()
	// Reserve before Ensure or Start: pending calls consume the same capacity
	// as attached commands. Closed records retain cancellation evidence only.
	runningGlobal, runningFamily := 0, 0
	family := scopeFamilyRoot(call.ScopeID)
	for active := range m.runs {
		select {
		case <-active.done:
			continue
		default:
		}
		runningGlobal++
		if scopeFamilyRoot(active.identity.ScopeID) == family {
			runningFamily++
		}
	}
	if runningFamily >= 16 {
		m.mu.Unlock()
		return result, errors.New("Agent scope family already owns 16 running processes")
	}
	if runningGlobal >= 128 {
		m.mu.Unlock()
		return result, errors.New("Manager already owns 128 running processes")
	}
	m.runs[run] = struct{}{}
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		// Losing the supervisor/transport is not proof of termination. Preserve
		// this small identity-only record so later cancellation cannot report a
		// false success. Restart cleanup is the eventual confirmation boundary.
		if run.confirmed {
			delete(m.runs, run)
		}
		close(run.done)
		m.mu.Unlock()
	}()
	spec, err := m.Sandboxes.Ensure(ctx, call.ExecutionContext.SandboxID, call.ExecutionContext.WorkspaceID, time.Now(), call.ExecutionContext.Profile)
	if err != nil {
		return result, err
	}
	if err := m.Sandboxes.BeginCall(call.ExecutionContext.SandboxID, time.Now()); err != nil {
		return result, err
	}
	defer func() { runErr = errors.Join(runErr, m.Sandboxes.EndCall(call.ExecutionContext.SandboxID, time.Now())) }()
	if err := ctx.Err(); err != nil {
		return result, err
	}
	cwd := args.CWD
	if cwd == "" {
		cwd = contract.ContainerWorkspace
	}
	if cwd[0] != '/' {
		cwd = contract.ContainerWorkspace + "/" + cwd
	}
	name, arguments := m.Engine.ExecArgs(spec, cwd, "python3", []string{"-I", "-c", sandboxProcessWrapper, strconv.Itoa(timeout), args.Command})
	command := exec.Command(name, arguments...)
	command.WaitDelay = 3 * time.Second
	stdin, err := command.StdinPipe()
	if err != nil {
		return result, err
	}
	defer stdin.Close()
	reader, writer := io.Pipe()
	command.Stdout = writer
	stdout := &boundedBuffer{limit: m.MaxOutput, private: args.PrivateOutput}
	stderr := &boundedBuffer{limit: m.MaxOutput, private: args.PrivateOutput}
	command.Stderr = stderr
	if err := command.Start(); err != nil {
		reader.Close()
		writer.Close()
		return result, err
	}
	run.confirmed = false
	result = ProcessSnapshot{RunID: call.RunID, ScopeKey: call.ScopeID, LifecycleID: call.LifecycleID, Target: "sandbox", Command: args.DisplayCommand, CWD: cwd, Status: "failed", StartedAt: time.Now().UTC()}
	var final *executionFrame
	decoded := make(chan error, 1)
	go func() {
		defer reader.Close()
		decoder := json.NewDecoder(reader)
		for {
			var frame executionFrame
			if err := decoder.Decode(&frame); err != nil {
				if err == io.EOF && final != nil {
					err = nil
				}
				if err != nil {
					cancel()
				}
				decoded <- err
				return
			}
			if final != nil {
				cancel()
				decoded <- errors.New("output after terminal confirmation")
				return
			}
			switch frame.Stream {
			case "stdout", "stderr":
				if frame.Stream == "stdout" {
					_, _ = stdout.Write(frame.Data)
				} else {
					_, _ = stderr.Write(frame.Data)
				}
			case "exit":
				final = &frame
			default:
				cancel()
				decoded <- errors.New("invalid terminal output frame")
				return
			}
		}
	}()
	waited := make(chan error, 1)
	go func() { err := command.Wait(); writer.Close(); waited <- err }()
	select {
	case err = <-waited:
	case <-ctx.Done():
		_ = stdin.Close()
		select {
		case err = <-waited:
		case <-time.After(5 * time.Second):
			_ = command.Process.Kill()
			_ = reader.Close()
			err = <-waited
		}
	}
	decodeErr := <-decoded
	stdout.Flush()
	stderr.Flush()
	result.Stdout, result.Stderr = stdout.String(), stderr.String()
	finished := time.Now().UTC()
	result.FinishedAt = &finished
	if final == nil || decodeErr != nil || err != nil || !final.Confirmed {
		return result, errors.Join(errors.New("sandbox command termination was not confirmed"), err, decodeErr)
	}
	run.confirmed = true
	result.StopConfirmed = &run.confirmed
	result.ExitCode = &final.Code
	if final.Cancelled || ctx.Err() != nil {
		result.Status = "cancelled"
	} else if final.Code == 0 {
		result.Status = "completed"
	}
	return result, nil
}

func (m *ProcessManager) CancelRun(identity RunIdentity) bool {
	if identity.RunID == "" || identity.ScopeID == "" || identity.LifecycleID == "" || identity.ExecutionContext.SandboxID == "" || identity.ExecutionContext.WorkspaceID == "" {
		return false
	}
	if _, err := sandbox.NormalizeProfile(identity.ExecutionContext.Profile); err != nil {
		return false
	}
	m.mu.Lock()
	var matched []*foregroundRun
	for run := range m.runs {
		i := run.identity
		if i.RunID == identity.RunID && i.ScopeID == identity.ScopeID && i.LifecycleID == identity.LifecycleID && i.ExecutionContext.SandboxID == identity.ExecutionContext.SandboxID && i.ExecutionContext.WorkspaceID == identity.ExecutionContext.WorkspaceID {
			if !sameProfile(i.ExecutionContext.Profile, identity.ExecutionContext.Profile) {
				m.mu.Unlock()
				return false
			}
			matched = append(matched, run)
		}
	}
	for _, run := range matched {
		run.cancel()
	}
	m.mu.Unlock()
	timer := time.NewTimer(8 * time.Second)
	defer timer.Stop()
	for _, run := range matched {
		select {
		case <-run.done:
			if !run.confirmed {
				return false
			}
		case <-timer.C:
			return false
		}
	}
	return true
}
