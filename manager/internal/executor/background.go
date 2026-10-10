package executor

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/driver"
	technicalidentity "github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/sandbox"
)

const (
	processTimeoutMinimumMilliseconds = 100
	processTimeoutMaximumMilliseconds = 604800000
	processNameMaximum                = 48
	processCommandMaximumBytes        = 100000
	processViewCommandMaximumRunes    = 4096
	processReadDefaultBytes           = 65536
	processReadMaximumBytes           = 262144
	processWaitMaximumMilliseconds    = 30000
	processStdinMaximumBytes          = 64 << 10
	processListMaximum                = 200
	processChangesMaximum             = 500
	processRetention                  = 7 * 24 * time.Hour
	processRetainedPerOwner           = 200
	processIndexSchemaVersion         = 1
)

var (
	// ErrProcessNotFound covers unknown ids and ids owned by someone else, which
	// are deliberately indistinguishable.
	ErrProcessNotFound = errors.New("background process not found")
	processNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)
	processIDPattern   = regexp.MustCompile(`^proc_[0-9a-hjkmnp-tv-z]{26}$`)
)

type ProcessView struct {
	ID          string  `json:"id"`
	Owner       string  `json:"owner"`
	ScopeID     string  `json:"scope_id"`
	SandboxID   string  `json:"sandbox_id"`
	Name        *string `json:"name"`
	Command     string  `json:"command"`
	CWD         string  `json:"cwd"`
	State       string  `json:"state"`
	ExitCode    *int    `json:"exit_code"`
	Reason      string  `json:"reason"`
	Attached    bool    `json:"attached"`
	StdinOpen   bool    `json:"stdin_open"`
	StartedAt   string  `json:"started_at"`
	EndedAt     *string `json:"ended_at"`
	LogBytes    int64   `json:"log_bytes"`
	Seq         int64   `json:"seq"`
	Unconfirmed bool    `json:"unconfirmed,omitempty"`
}

// processRecord is the persisted identity and outcome of one process.
type processRecord struct {
	ID          string     `json:"id"`
	Owner       string     `json:"owner"`
	Name        *string    `json:"name"`
	Command     string     `json:"command"`
	CWD         string     `json:"cwd"`
	State       string     `json:"state"`
	ExitCode    *int       `json:"exit_code"`
	Reason      string     `json:"reason"`
	Attached    bool       `json:"attached"`
	StdinOpen   bool       `json:"stdin_open"`
	StartedAt   time.Time  `json:"started_at"`
	EndedAt     *time.Time `json:"ended_at"`
	Seq         int64      `json:"seq"`
	Unconfirmed bool       `json:"unconfirmed,omitempty"`
	TimeoutMS   int        `json:"timeout_ms"`
	Identity    Identity   `json:"identity"`
	AuditID     string     `json:"audit_id"`
	ExecutorID  string     `json:"executor_id"`
}

type processIndex struct {
	SchemaVersion int             `json:"schema_version"`
	Seq           int64           `json:"seq"`
	Processes     []processRecord `json:"processes"`
}

type processStartArguments struct {
	Command   string  `json:"command"`
	CWD       string  `json:"cwd,omitempty"`
	TimeoutMS int     `json:"timeout_ms"`
	Name      *string `json:"name,omitempty"`
	Stdin     bool    `json:"stdin"`
	Attached  bool    `json:"attached"`
}

type processStdinArguments struct {
	ProcessID string `json:"process_id"`
	Data      string `json:"data"`
	EOF       bool   `json:"eof,omitempty"`
}

type processKillArguments struct {
	ProcessID string `json:"process_id"`
}

type ProcessDetachRequest struct {
	ProcessID string `json:"process_id"`
	Owner     string `json:"owner"`
}

type ProcessListRequest struct {
	Owner           string `json:"owner"`
	IncludeFinished bool   `json:"include_finished,omitempty"`
}

type ProcessReadRequest struct {
	ProcessID string `json:"process_id"`
	Owner     string `json:"owner"`
	Offset    int64  `json:"offset,omitempty"`
	MaxBytes  int    `json:"max_bytes,omitempty"`
	WaitMS    int    `json:"wait_ms,omitempty"`
}

type ProcessReadResult struct {
	Data         string      `json:"data"`
	OffsetStart  int64       `json:"offset_start"`
	NextOffset   int64       `json:"next_offset"`
	RetainedFrom int64       `json:"retained_from"`
	EOF          bool        `json:"eof"`
	Process      ProcessView `json:"process"`
}

type ProcessChangesRequest struct {
	After  int64 `json:"after"`
	WaitMS int   `json:"wait_ms,omitempty"`
}

type ProcessChangesResult struct {
	Changes []ProcessView `json:"changes"`
	Next    int64         `json:"next"`
}

// BackgroundConfig carries the limits and storage of the process supervisor.
type BackgroundConfig struct {
	Dir         string
	OwnerLimit  int
	GlobalLimit int
}

// BackgroundManager supervises sandbox processes that outlive the request and
// run that created them. Their records and logs are persisted; the processes
// themselves never survive a Manager restart (startup stops every sandbox).
type BackgroundManager struct {
	Engine    driver.Engine
	Sandboxes *sandbox.Manager
	Audit     AuditStore
	Dir       string

	OwnerLimit  int
	GlobalLimit int
	// Tunables that tests shorten.
	LogCap, LogDrop int64
	TermGrace       time.Duration
	KeepPerOwner    int
	StartTimeout    time.Duration
	Now             func() time.Time

	mu    sync.Mutex
	seq   int64
	procs map[string]*bgProcess
	wake  chan struct{}
	dirty bool
}

type bgProcess struct {
	rec     processRecord
	visible bool
	log     *processLog
	display string

	done        chan struct{}
	started     chan struct{}
	startedOnce sync.Once
	hard        chan struct{}
	hardOnce    sync.Once

	controlMu     sync.Mutex
	control       *os.File
	controlClosed bool
	controlBroken bool

	stopReason string // guarded by BackgroundManager.mu
}

func NewBackgroundManager(active technicalidentity.ActiveProfile, engine driver.Engine, sandboxes *sandbox.Manager, audit AuditStore, config BackgroundConfig) (*BackgroundManager, error) {
	if _, err := active.Profile(); err != nil {
		return nil, fmt.Errorf("background process technical profile: %w", err)
	}
	if config.Dir == "" || !filepath.IsAbs(config.Dir) {
		return nil, errors.New("background process directory must be absolute")
	}
	if config.OwnerLimit < 1 {
		config.OwnerLimit = 16
	}
	if config.GlobalLimit < 1 {
		config.GlobalLimit = 128
	}
	m := &BackgroundManager{
		Engine: engine, Sandboxes: sandboxes, Audit: audit, Dir: config.Dir,
		OwnerLimit: config.OwnerLimit, GlobalLimit: config.GlobalLimit,
		LogCap: processLogCapBytes, LogDrop: processLogDropBytes,
		TermGrace: 5 * time.Second, KeepPerOwner: processRetainedPerOwner, StartTimeout: 20 * time.Second,
		procs: map[string]*bgProcess{}, wake: make(chan struct{}),
	}
	if err := os.MkdirAll(m.Dir, 0o700); err != nil {
		return nil, err
	}
	var index processIndex
	if err := atomicfile.ReadJSONWithLimit(m.indexPath(), &index, 256<<20); err != nil {
		if !os.IsNotExist(err) {
			return nil, fmt.Errorf("load background process index: %w", err)
		}
	} else if index.SchemaVersion != processIndexSchemaVersion {
		return nil, fmt.Errorf("unsupported background process index schema %d", index.SchemaVersion)
	}
	m.seq = index.Seq
	for _, record := range index.Processes {
		if !processIDPattern.MatchString(record.ID) {
			return nil, fmt.Errorf("background process index has an invalid id %q", record.ID)
		}
		m.seq = max64(m.seq, record.Seq)
		log, err := newProcessLog(filepath.Join(m.Dir, record.ID), m.LogCap, m.LogDrop)
		if err != nil {
			return nil, fmt.Errorf("open background process log %s: %w", record.ID, err)
		}
		p := &bgProcess{rec: record, visible: true, log: log, done: make(chan struct{})}
		close(p.done)
		m.procs[record.ID] = p
	}
	return m, nil
}

func (m *BackgroundManager) indexPath() string { return filepath.Join(m.Dir, "index.json") }

func (m *BackgroundManager) now() time.Time {
	if m.Now != nil {
		return m.Now().UTC()
	}
	return time.Now().UTC()
}

// persistLocked rewrites the whole index; a failed write stays dirty and is
// retried by the next change, so in-memory state is never lost to one failure.
func (m *BackgroundManager) persistLocked() error {
	index := processIndex{SchemaVersion: processIndexSchemaVersion, Seq: m.seq, Processes: []processRecord{}}
	for _, p := range m.procs {
		if p.visible {
			index.Processes = append(index.Processes, p.rec)
		}
	}
	sort.Slice(index.Processes, func(i, j int) bool { return index.Processes[i].Seq < index.Processes[j].Seq })
	if err := atomicfile.WriteJSON(m.indexPath(), index, 0o600); err != nil {
		m.dirty = true
		return fmt.Errorf("persist background processes: %w", err)
	}
	m.dirty = false
	return nil
}

// bumpLocked records a state change: new seq, persisted, observers woken.
func (m *BackgroundManager) bumpLocked(p *bgProcess) error {
	m.seq++
	p.rec.Seq = m.seq
	err := m.persistLocked()
	close(m.wake)
	m.wake = make(chan struct{})
	return err
}

func (m *BackgroundManager) viewLocked(p *bgProcess) ProcessView {
	view := ProcessView{
		ID: p.rec.ID, Owner: p.rec.Owner, ScopeID: p.rec.Identity.ScopeID, SandboxID: p.rec.Identity.ExecutionContext.SandboxID,
		Name: p.rec.Name, Command: p.rec.Command, CWD: p.rec.CWD, State: p.rec.State, ExitCode: p.rec.ExitCode,
		Reason: p.rec.Reason, Attached: p.rec.Attached, StdinOpen: p.rec.StdinOpen,
		StartedAt: p.rec.StartedAt.UTC().Format(time.RFC3339Nano), LogBytes: p.log.Total(), Seq: p.rec.Seq,
		Unconfirmed: p.rec.Unconfirmed,
	}
	if p.rec.EndedAt != nil {
		ended := p.rec.EndedAt.UTC().Format(time.RFC3339Nano)
		view.EndedAt = &ended
	}
	return view
}

func (m *BackgroundManager) lookupLocked(id, owner string) (*bgProcess, error) {
	if !processIDPattern.MatchString(id) || owner == "" {
		return nil, ErrProcessNotFound
	}
	p := m.procs[id]
	if p == nil || !p.visible || p.rec.Owner != owner {
		return nil, ErrProcessNotFound
	}
	return p, nil
}

// CheckOwner reports whether the process exists and belongs to owner.
func (m *BackgroundManager) CheckOwner(id, owner string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, err := m.lookupLocked(id, owner)
	return err
}

func newProcessID(now time.Time) (string, error) {
	var raw [16]byte
	milliseconds := uint64(now.UnixMilli())
	for i := range 6 {
		raw[i] = byte(milliseconds >> (8 * (5 - i)))
	}
	if _, err := rand.Read(raw[6:]); err != nil {
		return "", err
	}
	value := new(big.Int).SetBytes(raw[:])
	const alphabet = "0123456789abcdefghjkmnpqrstvwxyz"
	encoded := make([]byte, 26)
	mask := big.NewInt(31)
	digit := new(big.Int)
	for i := 25; i >= 0; i-- {
		digit.And(value, mask)
		encoded[i] = alphabet[digit.Int64()]
		value.Rsh(value, 5)
	}
	return "proc_" + string(encoded), nil
}

func validateProcessStart(args processStartArguments) error {
	if args.Command == "" {
		return errors.New("command is required")
	}
	if len(args.Command) > processCommandMaximumBytes {
		return errors.New("command is too long")
	}
	if args.TimeoutMS != 0 && (args.TimeoutMS < processTimeoutMinimumMilliseconds || args.TimeoutMS > processTimeoutMaximumMilliseconds) {
		return errors.New("timeout_ms is out of range")
	}
	if args.Name != nil && (len(*args.Name) < 1 || len(*args.Name) > processNameMaximum || !processNamePattern.MatchString(*args.Name)) {
		return errors.New("name must be 1-48 characters of [A-Za-z0-9._-] starting with a letter or digit")
	}
	return nil
}

func truncateRunes(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	count := 0
	for index := range value {
		if count == limit {
			return value[:index]
		}
		count++
	}
	return value
}

// The background wrapper reuses the foreground design: a subreaper that owns a
// new-session process group, confirms descendant termination, and kills the
// group when the supervisor stdin reaches EOF (Manager gone). Stdin carries
// framed control lines {"t":"d","d":<b64>}, {"t":"e"} and {"t":"s","s":<signal>}.
// The command's own stdin is a pipe fed from those frames (or /dev/null), and
// stdout/stderr are combined. An argv timeout of 0 means no deadline.
const sandboxBackgroundWrapper = `
import base64, ctypes, json, os, selectors, signal, sys, time
ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0 or sys.exit(125)
timeout = int(sys.argv[1])
deadline = time.monotonic() + timeout / 1000 if timeout > 0 else None
want_stdin = sys.argv[2] == '1'
out_r, out_w = os.pipe()
ready_r, ready_w = os.pipe()
in_r, in_w = os.pipe() if want_stdin else (None, None)
child = os.fork()
if child == 0:
    os.close(ready_r)
    os.setsid()
    os.umask(0o077)
    os.dup2(in_r if want_stdin else os.open('/dev/null', os.O_RDONLY), 0)
    os.dup2(out_w, 1); os.dup2(out_w, 2)
    for fd in (out_r, out_w, in_r, in_w):
        if fd is not None and fd > 2: os.close(fd)
    os.write(ready_w, b'1'); os.close(ready_w)
    os.execv('/bin/bash', ['bash', '-c', sys.argv[3]])
os.close(ready_w); os.close(out_w)
if want_stdin:
    os.close(in_r); os.set_blocking(in_w, False)
if os.read(ready_r, 1) != b'1': sys.exit(125)
os.close(ready_r)
selector = selectors.DefaultSelector()
selector.register(0, selectors.EVENT_READ, 'lease')
selector.register(out_r, selectors.EVENT_READ, 'output')
status = None
cancelled = False
timed_out = False
stopping = None
confirmed = False
control = bytearray()
pending = bytearray()
eof = False
paused = False
def emit(value):
    try:
        sys.stdout.write(json.dumps(value) + '\n'); sys.stdout.flush()
    except (BrokenPipeError, OSError):
        pass
def kill_group():
    try: os.killpg(child, signal.SIGKILL)
    except ProcessLookupError: pass
def close_stdin():
    global in_w
    if in_w is not None:
        try: os.close(in_w)
        except OSError: pass
        in_w = None
def handle(line):
    global eof
    try: frame = json.loads(line)
    except ValueError: return
    kind = frame.get('t')
    if kind == 'd' and in_w is not None:
        pending.extend(base64.b64decode(frame.get('d', '')))
    elif kind == 'e':
        eof = True
    elif kind == 's':
        try: os.killpg(child, int(frame.get('s', 15)))
        except (ProcessLookupError, ValueError, OSError): pass
def pump_stdin():
    global eof
    if in_w is None: return
    while pending:
        try: written = os.write(in_w, pending[:65536])
        except BlockingIOError: return
        except OSError:
            pending.clear(); eof = True; break
        del pending[:written]
    if eof and not pending: close_stdin()
emit({'stream': 'started'})
try:
    while True:
        # Observe without reaping: the leader pins its process-group identity
        # until the only group signal has been sent.
        exited = stopping is None and os.waitid(os.P_PID, child, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None
        now = time.monotonic()
        if deadline is not None and now >= deadline and stopping is None:
            cancelled = timed_out = True
        if stopping is None and (cancelled or exited):
            kill_group()
            stopping = now
        if stopping is not None:
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
        else:
            pump_stdin()
            if len(pending) > (1 << 20) and not paused and 0 in selector.get_map():
                selector.unregister(0); paused = True
            elif paused and len(pending) <= (1 << 20):
                selector.register(0, selectors.EVENT_READ, 'lease'); paused = False
        for key, _ in selector.select(timeout=0.02):
            data = os.read(key.fd, 65536)
            if key.data == 'lease':
                if not data:
                    cancelled = True
                    selector.unregister(key.fd)
                    continue
                control.extend(data)
                while b'\n' in control:
                    line, _, rest = bytes(control).partition(b'\n')
                    control[:] = rest
                    handle(line)
            elif data:
                for start in range(0, len(data), 8192):
                    emit({'stream': 'output', 'data': base64.b64encode(data[start:start + 8192]).decode('ascii')})
            else:
                selector.unregister(key.fd); os.close(key.fd)
    emit({'stream': 'exit', 'code': status if status is not None else -1, 'confirmed': confirmed, 'cancelled': cancelled, 'timed_out': timed_out})
finally:
    if stopping is None: kill_group()
`

type backgroundFrame struct {
	Stream    string `json:"stream"`
	Data      []byte `json:"data"`
	Code      int    `json:"code"`
	Confirmed bool   `json:"confirmed"`
	Cancelled bool   `json:"cancelled"`
	TimedOut  bool   `json:"timed_out"`
}

// Start launches a process. The returned view is `running` (record persisted),
// or `failed`/`start_failed` when the in-sandbox supervisor never came up.
func (m *BackgroundManager) Start(ctx context.Context, call Call, args processStartArguments, display string) (ProcessView, error) {
	if err := validateProcessStart(args); err != nil {
		return ProcessView{}, err
	}
	if call.Target != "sandbox" {
		return ProcessView{}, errors.New("target must be sandbox")
	}
	owner := scopeFamilyRoot(call.ScopeID)
	id, err := newProcessID(m.now())
	if err != nil {
		return ProcessView{}, err
	}
	log, err := newProcessLog(filepath.Join(m.Dir, id), m.LogCap, m.LogDrop)
	if err != nil {
		return ProcessView{}, err
	}
	cwd := args.CWD
	if cwd == "" {
		cwd = contract.ContainerWorkspace
	}
	if cwd[0] != '/' {
		cwd = contract.ContainerWorkspace + "/" + cwd
	}
	p := &bgProcess{
		visible: false, log: log, display: display,
		done: make(chan struct{}), started: make(chan struct{}), hard: make(chan struct{}),
		rec: processRecord{
			ID: id, Owner: owner, Name: args.Name, Command: truncateRunes(display, processViewCommandMaximumRunes), CWD: cwd,
			State: "running", Attached: args.Attached, StdinOpen: args.Stdin, StartedAt: m.now(), TimeoutMS: args.TimeoutMS,
			Identity: call.Identity, AuditID: call.AuditID, ExecutorID: call.ExecutorID,
		},
	}
	p.rec.Identity.ExecutionContext.Profile = storedProfile(call.ExecutionContext.Profile)
	abandon := func() {
		m.mu.Lock()
		delete(m.procs, id)
		m.mu.Unlock()
		_ = os.RemoveAll(filepath.Join(m.Dir, id))
	}
	m.mu.Lock()
	running, ownerRunning := 0, 0
	for _, other := range m.procs {
		if other.rec.State != "running" {
			continue
		}
		running++
		if other.rec.Owner == owner {
			ownerRunning++
			if args.Name != nil && other.rec.Name != nil && *other.rec.Name == *args.Name {
				m.mu.Unlock()
				_ = os.RemoveAll(filepath.Join(m.Dir, id))
				return ProcessView{}, fmt.Errorf("background process name %q is already in use", *args.Name)
			}
		}
	}
	if ownerRunning >= m.OwnerLimit || running >= m.GlobalLimit {
		m.mu.Unlock()
		_ = os.RemoveAll(filepath.Join(m.Dir, id))
		return ProcessView{}, errors.New("too many background processes")
	}
	m.procs[id] = p
	m.mu.Unlock()

	spec, err := m.Sandboxes.Ensure(ctx, call.ExecutionContext.SandboxID, call.ExecutionContext.WorkspaceID, time.Now(), call.ExecutionContext.Profile)
	if err != nil {
		abandon()
		return ProcessView{}, err
	}
	if err := m.Sandboxes.BeginCall(call.ExecutionContext.SandboxID, time.Now()); err != nil {
		abandon()
		return ProcessView{}, err
	}
	releaseResidency := func() { _ = m.Sandboxes.EndCall(call.ExecutionContext.SandboxID, time.Now()) }
	if err := ctx.Err(); err != nil {
		releaseResidency()
		abandon()
		return ProcessView{}, err
	}
	stdinFlag := "0"
	if args.Stdin {
		stdinFlag = "1"
	}
	timeout := args.TimeoutMS
	name, arguments := m.Engine.ExecArgs(spec, cwd, "python3", []string{"-I", "-c", sandboxBackgroundWrapper, strconv.Itoa(timeout), stdinFlag, args.Command})
	command := exec.Command(name, arguments...)
	command.WaitDelay = 3 * time.Second
	controlRead, controlWrite, err := os.Pipe()
	if err != nil {
		releaseResidency()
		abandon()
		return ProcessView{}, err
	}
	command.Stdin = controlRead
	reader, writer := io.Pipe()
	command.Stdout = writer
	command.Stderr = log
	if err := command.Start(); err != nil {
		controlRead.Close()
		controlWrite.Close()
		reader.Close()
		writer.Close()
		releaseResidency()
		abandon()
		return ProcessView{}, err
	}
	controlRead.Close()
	p.control = controlWrite
	go m.supervise(p, command, reader, writer)

	m.mu.Lock()
	p.visible = true
	persistErr := m.bumpLocked(p)
	m.mu.Unlock()
	if persistErr != nil {
		// The start was never reported, so it must not keep running.
		p.hardKill()
		<-p.done
		m.mu.Lock()
		p.visible = false
		delete(m.procs, id)
		m.mu.Unlock()
		_ = os.RemoveAll(filepath.Join(m.Dir, id))
		return ProcessView{}, persistErr
	}
	timer := time.NewTimer(m.StartTimeout)
	defer timer.Stop()
	select {
	case <-p.started:
	case <-p.done:
	case <-ctx.Done():
		p.hardKill()
		<-p.done
		return ProcessView{}, ctx.Err()
	case <-timer.C:
		p.hardKill()
		<-p.done
	}
	m.prune()
	m.mu.Lock()
	view := m.viewLocked(p)
	m.mu.Unlock()
	return view, nil
}

func (p *bgProcess) hardKill() {
	p.hardOnce.Do(func() { close(p.hard) })
}

// sendControl writes one framed control line. A write that cannot finish
// poisons the channel (a partial frame would corrupt the framing); a hard kill
// still works because it closes the lease instead.
func (p *bgProcess) sendControl(frames ...map[string]any) error {
	p.controlMu.Lock()
	defer p.controlMu.Unlock()
	if p.controlClosed || p.controlBroken {
		return errors.New("process control channel is closed")
	}
	for _, frame := range frames {
		line, err := json.Marshal(frame)
		if err != nil {
			return err
		}
		_ = p.control.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if _, err := p.control.Write(append(line, '\n')); err != nil {
			p.controlBroken = true
			return fmt.Errorf("process control channel failed: %w", err)
		}
	}
	return nil
}

func (p *bgProcess) closeControl() {
	p.controlMu.Lock()
	defer p.controlMu.Unlock()
	if !p.controlClosed {
		p.controlClosed = true
		_ = p.control.Close()
	}
}

func (m *BackgroundManager) supervise(p *bgProcess, command *exec.Cmd, reader *io.PipeReader, writer *io.PipeWriter) {
	var final *backgroundFrame
	decoded := make(chan error, 1)
	go func() {
		defer reader.Close()
		decoder := json.NewDecoder(reader)
		for {
			var frame backgroundFrame
			if err := decoder.Decode(&frame); err != nil {
				if err == io.EOF && final != nil {
					err = nil
				}
				if err != nil {
					p.hardKill()
				}
				decoded <- err
				return
			}
			if final != nil {
				p.hardKill()
				decoded <- errors.New("output after terminal confirmation")
				return
			}
			switch frame.Stream {
			case "started":
				p.startedOnce.Do(func() { close(p.started) })
			case "output":
				_, _ = p.log.Write(frame.Data)
			case "exit":
				final = &frame
			default:
				p.hardKill()
				decoded <- errors.New("invalid process output frame")
				return
			}
		}
	}()
	waited := make(chan error, 1)
	go func() { err := command.Wait(); writer.Close(); waited <- err }()
	var waitErr error
	select {
	case waitErr = <-waited:
	case <-p.hard:
		p.closeControl()
		select {
		case waitErr = <-waited:
		case <-time.After(5 * time.Second):
			_ = command.Process.Kill()
			_ = reader.Close()
			waitErr = <-waited
		}
	}
	decodeErr := <-decoded
	p.log.Close()
	m.finalize(p, final, waitErr, decodeErr)
}

func (m *BackgroundManager) containerGone(p *bgProcess) bool {
	spec, err := m.Sandboxes.Spec(p.rec.Identity.ExecutionContext.SandboxID)
	if err != nil {
		return false
	}
	running, err := m.Engine.SandboxRunning(context.Background(), spec.ContainerName)
	return err == nil && !running
}

func (m *BackgroundManager) finalize(p *bgProcess, final *backgroundFrame, waitErr, decodeErr error) {
	started := false
	select {
	case <-p.started:
		started = true
	default:
	}
	confirmed := final != nil && final.Confirmed && waitErr == nil && decodeErr == nil
	gone := false
	if !confirmed {
		gone = m.containerGone(p)
	}
	// Release residency before the state is observable, so a caller that sees
	// a terminal state may immediately stop or replace the sandbox.
	_ = m.Sandboxes.EndCall(p.rec.Identity.ExecutionContext.SandboxID, time.Now())

	m.mu.Lock()
	stop := p.stopReason
	state, reason, unconfirmed := "exited", "", false
	var exit *int
	if final != nil {
		code := final.Code
		exit = &code
	}
	switch {
	case !started && final == nil:
		state, reason = "failed", "start_failed"
		unconfirmed = !gone
		exit = nil
	case confirmed && stop == "sandbox_stopped":
		state, reason = "interrupted", "sandbox_stopped"
	case confirmed && final.TimedOut:
		state, reason = "killed", "timeout"
	case confirmed && stop != "":
		state, reason = "killed", stop
	case confirmed && final.Cancelled:
		state = "killed"
	case confirmed:
	case gone:
		state, reason = "interrupted", "sandbox_stopped"
	default:
		state, reason, unconfirmed = "failed", stop, true
	}
	ended := m.now()
	p.rec.State, p.rec.Reason, p.rec.Unconfirmed, p.rec.ExitCode = state, reason, unconfirmed, exit
	p.rec.EndedAt, p.rec.StdinOpen = &ended, false
	_ = m.bumpLocked(p)
	rec := p.rec
	close(p.done)
	m.mu.Unlock()
	p.log.Signal()
	summary := map[string]any{"status": state, "reason": reason, "exit_code": exit}
	_ = m.Audit.Finished(recordCall(rec), summary, nil)
	m.prune()
}

func recordCall(rec processRecord) Call {
	return Call{Identity: rec.Identity, AuditID: rec.AuditID, ExecutorID: rec.ExecutorID, Target: "sandbox", Action: "start"}
}

// kill stops a running process: SIGTERM to its group, SIGKILL (lease close)
// after TermGrace, and descendant confirmation by the wrapper.
func (m *BackgroundManager) kill(p *bgProcess, reason string) {
	m.mu.Lock()
	if p.rec.State != "running" {
		m.mu.Unlock()
		return
	}
	if p.stopReason == "" {
		p.stopReason = reason
	}
	m.mu.Unlock()
	_ = p.sendControl(map[string]any{"t": "s", "s": int(syscall.SIGTERM)})
	select {
	case <-p.done:
		return
	case <-time.After(m.TermGrace):
	}
	p.hardKill()
	select {
	case <-p.done:
	case <-time.After(30 * time.Second):
	}
}

func (m *BackgroundManager) Kill(id, owner string) (ProcessView, error) {
	m.mu.Lock()
	p, err := m.lookupLocked(id, owner)
	m.mu.Unlock()
	if err != nil {
		return ProcessView{}, err
	}
	m.kill(p, "user")
	m.mu.Lock()
	defer m.mu.Unlock()
	if p.rec.State == "running" {
		return ProcessView{}, errors.New("process termination is not confirmed yet")
	}
	return m.viewLocked(p), nil
}

func (m *BackgroundManager) Stdin(id, owner, data string, eof bool) (ProcessView, error) {
	if len(data) > processStdinMaximumBytes {
		return ProcessView{}, errors.New("stdin data is too large")
	}
	if data == "" && !eof {
		return ProcessView{}, errors.New("data or eof is required")
	}
	m.mu.Lock()
	p, err := m.lookupLocked(id, owner)
	if err == nil && (p.rec.State != "running" || !p.rec.StdinOpen) {
		err = errors.New("process stdin is not open")
	}
	m.mu.Unlock()
	if err != nil {
		return ProcessView{}, err
	}
	var frames []map[string]any
	if data != "" {
		frames = append(frames, map[string]any{"t": "d", "d": base64.StdEncoding.EncodeToString([]byte(data))})
	}
	if eof {
		frames = append(frames, map[string]any{"t": "e"})
	}
	if err := p.sendControl(frames...); err != nil {
		return ProcessView{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if eof && p.rec.State == "running" && p.rec.StdinOpen {
		p.rec.StdinOpen = false
		_ = m.bumpLocked(p)
	}
	return m.viewLocked(p), nil
}

func (m *BackgroundManager) Detach(req ProcessDetachRequest) (ProcessView, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, err := m.lookupLocked(req.ProcessID, req.Owner)
	if err != nil {
		return ProcessView{}, err
	}
	if p.rec.Attached {
		p.rec.Attached = false
		_ = m.bumpLocked(p)
	}
	return m.viewLocked(p), nil
}

func (m *BackgroundManager) List(req ProcessListRequest) ([]ProcessView, error) {
	if req.Owner == "" {
		return nil, errors.New("owner is required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var matched []*bgProcess
	for _, p := range m.procs {
		if p.visible && p.rec.Owner == req.Owner && (req.IncludeFinished || p.rec.State == "running") {
			matched = append(matched, p)
		}
	}
	sort.Slice(matched, func(i, j int) bool {
		if !matched[i].rec.StartedAt.Equal(matched[j].rec.StartedAt) {
			return matched[i].rec.StartedAt.After(matched[j].rec.StartedAt)
		}
		return matched[i].rec.ID > matched[j].rec.ID
	})
	if len(matched) > processListMaximum {
		matched = matched[:processListMaximum]
	}
	views := make([]ProcessView, 0, len(matched))
	for _, p := range matched {
		views = append(views, m.viewLocked(p))
	}
	return views, nil
}

func (m *BackgroundManager) Read(ctx context.Context, req ProcessReadRequest) (ProcessReadResult, error) {
	if req.Offset < -1 || req.MaxBytes < 0 || req.WaitMS < 0 {
		return ProcessReadResult{}, errors.New("offset, max_bytes and wait_ms must not be negative (offset -1 is the tail)")
	}
	maxBytes := req.MaxBytes
	if maxBytes == 0 {
		maxBytes = processReadDefaultBytes
	}
	maxBytes = min(maxBytes, processReadMaximumBytes)
	wait := time.Duration(min(req.WaitMS, processWaitMaximumMilliseconds)) * time.Millisecond
	deadline := time.NewTimer(wait)
	defer deadline.Stop()
	for {
		m.mu.Lock()
		p, err := m.lookupLocked(req.ProcessID, req.Owner)
		m.mu.Unlock()
		if err != nil {
			return ProcessReadResult{}, err
		}
		wake := p.log.WakeChan()
		chunk, err := p.log.Read(req.Offset, maxBytes)
		if err != nil {
			return ProcessReadResult{}, err
		}
		m.mu.Lock()
		view := m.viewLocked(p)
		ended := p.rec.State != "running"
		m.mu.Unlock()
		if len(chunk.Data) > 0 || ended || wait == 0 {
			return ProcessReadResult{
				Data: string(chunk.Data), OffsetStart: chunk.Start, NextOffset: chunk.Next, RetainedFrom: chunk.RetainedFrom,
				EOF: ended && chunk.Next == chunk.Total, Process: view,
			}, nil
		}
		select {
		case <-wake:
		case <-deadline.C:
			wait = 0
		case <-ctx.Done():
			return ProcessReadResult{}, ctx.Err()
		}
	}
}

func (m *BackgroundManager) Changes(ctx context.Context, req ProcessChangesRequest) (ProcessChangesResult, error) {
	if req.After < 0 || req.WaitMS < 0 {
		return ProcessChangesResult{}, errors.New("after and wait_ms must not be negative")
	}
	deadline := time.NewTimer(time.Duration(min(req.WaitMS, processWaitMaximumMilliseconds)) * time.Millisecond)
	defer deadline.Stop()
	after := req.After
	for {
		m.mu.Lock()
		if after > m.seq {
			after = 0 // the caller's cursor is from a lost state: resync
		}
		wake := m.wake
		var changed []*bgProcess
		for _, p := range m.procs {
			if p.visible && p.rec.Seq > after {
				changed = append(changed, p)
			}
		}
		sort.Slice(changed, func(i, j int) bool { return changed[i].rec.Seq < changed[j].rec.Seq })
		next := m.seq
		if len(changed) > processChangesMaximum {
			changed = changed[:processChangesMaximum]
			next = changed[len(changed)-1].rec.Seq
		}
		views := make([]ProcessView, 0, len(changed))
		for _, p := range changed {
			views = append(views, m.viewLocked(p))
		}
		m.mu.Unlock()
		if len(views) > 0 || req.WaitMS == 0 {
			return ProcessChangesResult{Changes: views, Next: next}, nil
		}
		select {
		case <-wake:
		case <-deadline.C:
			return ProcessChangesResult{Changes: views, Next: next}, nil
		case <-ctx.Done():
			return ProcessChangesResult{}, ctx.Err()
		}
	}
}

// CancelRun kills processes still attached to the run. Detached processes are
// never touched. It reports whether every matched process ended confirmed.
func (m *BackgroundManager) CancelRun(identity RunIdentity) bool {
	m.mu.Lock()
	var matched []*bgProcess
	for _, p := range m.procs {
		i := p.rec.Identity
		if p.rec.State != "running" || !p.rec.Attached {
			continue
		}
		if i.RunID == identity.RunID && i.ScopeID == identity.ScopeID && i.LifecycleID == identity.LifecycleID && i.ExecutionContext.SandboxID == identity.ExecutionContext.SandboxID && i.ExecutionContext.WorkspaceID == identity.ExecutionContext.WorkspaceID {
			if !sameProfile(i.ExecutionContext.Profile, identity.ExecutionContext.Profile) {
				m.mu.Unlock()
				return false
			}
			matched = append(matched, p)
		}
	}
	m.mu.Unlock()
	var group sync.WaitGroup
	for _, p := range matched {
		group.Add(1)
		go func() { defer group.Done(); m.kill(p, "run_cancelled") }()
	}
	group.Wait()
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, p := range matched {
		if p.rec.State == "running" || p.rec.Unconfirmed {
			return false
		}
	}
	return true
}

// SandboxStopped is the hook for a stop outside the startup barrier: the
// container's processes are gone or going, so they are recorded accordingly.
func (m *BackgroundManager) SandboxStopped(sandboxID string) {
	m.mu.Lock()
	var matched []*bgProcess
	for _, p := range m.procs {
		if p.rec.State == "running" && p.rec.Identity.ExecutionContext.SandboxID == sandboxID {
			if p.stopReason == "" || p.stopReason == "user" || p.stopReason == "run_cancelled" {
				p.stopReason = "sandbox_stopped"
			}
			matched = append(matched, p)
		}
	}
	m.mu.Unlock()
	for _, p := range matched {
		p.hardKill()
	}
}

// Recover runs once at startup, after every sandbox was force-stopped: what was
// running can no longer be, so it becomes interrupted and is never replayed.
func (m *BackgroundManager) Recover() error {
	m.mu.Lock()
	var recovered []processRecord
	var persistErr error
	for _, p := range m.procs {
		if p.rec.State != "running" {
			continue
		}
		ended := m.now()
		p.rec.State, p.rec.Reason, p.rec.StdinOpen, p.rec.EndedAt = "interrupted", "system_restart", false, &ended
		if err := m.bumpLocked(p); err != nil {
			persistErr = err
		}
		recovered = append(recovered, p.rec)
	}
	m.mu.Unlock()
	for _, rec := range recovered {
		_ = m.Audit.Finished(recordCall(rec), map[string]any{"status": "interrupted", "reason": "system_restart", "exit_code": nil}, nil)
	}
	m.prune()
	return persistErr
}

// prune applies retention: finished processes live 7 days, or the newest 200
// per owner, whichever removes more.
func (m *BackgroundManager) prune() {
	m.mu.Lock()
	cutoff := m.now().Add(-processRetention)
	byOwner := map[string][]*bgProcess{}
	var remove []string
	for _, p := range m.procs {
		if !p.visible || p.rec.State == "running" || p.rec.EndedAt == nil {
			continue
		}
		if p.rec.EndedAt.Before(cutoff) {
			remove = append(remove, p.rec.ID)
			continue
		}
		byOwner[p.rec.Owner] = append(byOwner[p.rec.Owner], p)
	}
	for _, list := range byOwner {
		sort.Slice(list, func(i, j int) bool { return list[i].rec.EndedAt.After(*list[j].rec.EndedAt) })
		for _, p := range list[min(len(list), m.KeepPerOwner):] {
			remove = append(remove, p.rec.ID)
		}
	}
	for _, id := range remove {
		delete(m.procs, id)
	}
	if len(remove) > 0 || m.dirty {
		_ = m.persistLocked()
	}
	m.mu.Unlock()
	for _, id := range remove {
		_ = os.RemoveAll(filepath.Join(m.Dir, id))
	}
}

// RunningCount reports running processes, for tests and diagnostics.
func (m *BackgroundManager) RunningCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	count := 0
	for _, p := range m.procs {
		if p.rec.State == "running" {
			count++
		}
	}
	return count
}
