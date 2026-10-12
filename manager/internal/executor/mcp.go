package executor

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/driver"
	technicalidentity "github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/sandbox"
)

const (
	mcpFrameMaximumBytes    = 1 << 20
	mcpQueueMaximumBytes    = 8 << 20
	mcpRecvDefaultBytes     = 1 << 20
	mcpRecvMaximumBytes     = 4 << 20
	mcpWaitMaximum          = 30000
	mcpArgsMaximum          = 128
	mcpArgBytesMaximum      = 8192
	mcpEnvMaximum           = 64
	mcpEnvValueBytesMaximum = 32 << 10
	mcpEnvTotalBytesMaximum = 256 << 10
	mcpRetention            = 2 * time.Minute
	mcpRetainedEnded        = 32
	mcpLogCapBytes          = 1 << 20
	mcpLogDropBytes         = 512 << 10
	mcpStderrTailBytes      = 2048
	mcpIDPrefix             = "mcp_"
)

// Reasons a connection ended. protocol* reasons end in state "failed".
const (
	mcpReasonExited         = "exited"
	mcpReasonStopped        = "stopped"
	mcpReasonSandboxStopped = "sandbox_stopped"
	mcpReasonFrameTooLarge  = "frame_too_large"
	mcpReasonInvalidUTF8    = "invalid_utf8"
	mcpReasonQueueOverflow  = "queue_overflow"
	mcpReasonInputOverflow  = "input_overflow"
	mcpReasonChannelFailed  = "channel_failed"
	mcpReasonStartFailed    = "start_failed"
)

var (
	// ErrMCPConnectionNotFound covers unknown ids, ids owned by someone else and
	// ids forgotten by a Manager restart; they are deliberately indistinguishable.
	ErrMCPConnectionNotFound = errors.New("MCP connection not found")
	mcpIDPattern             = regexp.MustCompile(`^mcp_[0-9a-hjkmnp-tv-z]{26}$`)
	mcpBareCommandPattern    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$`)
	mcpEnvKeyPattern         = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)
	mcpMethodPattern         = regexp.MustCompile(`^[A-Za-z0-9_./-]{1,64}$`)
	mcpConnectorPattern      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`)
)

type mcpStartArguments struct {
	ConnectorID string            `json:"connector_id"`
	Command     string            `json:"command"`
	Args        []string          `json:"args"`
	CWD         string            `json:"cwd"`
	Env         map[string]string `json:"env"`
}

type mcpSendArguments struct {
	ConnectionID string `json:"connection_id"`
	Message      string `json:"message"`
}

type mcpStopArguments struct {
	ConnectionID string `json:"connection_id"`
}

// MCPRecvRequest is the owner-checked, long-polled read of a connection.
type MCPRecvRequest struct {
	ConnectionID string `json:"connection_id"`
	Owner        string `json:"owner"`
	Ack          int64  `json:"ack"`
	WaitMS       int    `json:"wait_ms,omitempty"`
	MaxBytes     int    `json:"max_bytes,omitempty"`
}

type MCPMessage struct {
	Seq  int64  `json:"seq"`
	Data string `json:"data"`
}

type MCPRecvResult struct {
	Messages []MCPMessage `json:"messages"`
	Next     int64        `json:"next"`
	State    string       `json:"state"`
	Reason   string       `json:"reason,omitempty"`
	// ExitCode and StderrTail (redacted, bounded) describe an ended server.
	ExitCode   *int   `json:"exit_code,omitempty"`
	StderrTail string `json:"stderr_tail,omitempty"`
}

// MCPConfig carries the limits and log storage of the MCP channel.
type MCPConfig struct {
	Dir         string
	OwnerLimit  int
	GlobalLimit int
}

// MCPManager supervises local stdio MCP servers in personal sandboxes. A
// connection is in memory only: its stdout protocol frames are never redacted
// or persisted, and it does not survive a sandbox stop or a Manager restart.
// Only the server's stderr is written, redacted and capped, to a log.
type MCPManager struct {
	Engine    driver.Engine
	Sandboxes *sandbox.Manager
	Dir       string

	OwnerLimit  int
	GlobalLimit int
	// Tunables that tests shorten.
	QueueMax     int
	FrameMax     int
	TermGrace    time.Duration
	StartTimeout time.Duration
	Retention    time.Duration
	Now          func() time.Time

	mu    sync.Mutex
	conns map[string]*mcpConn
}

type mcpConn struct {
	id    string
	owner string
	exec  ExecutionContext
	log   *processLog

	done        chan struct{}
	started     chan struct{}
	startedOnce sync.Once
	hard        chan struct{}
	hardOnce    sync.Once
	control     controlPipe

	qmu        sync.Mutex // guards everything below
	msgs       []MCPMessage
	queued     int
	partial    []byte
	lastSeq    int64
	acked      int64
	wake       chan struct{}
	state      string
	reason     string
	exitCode   *int
	unconfirm  bool
	ended      time.Time
	failedOpen bool // a protocol failure ended ingestion
}

type mcpFrame struct {
	Stream        string `json:"stream"`
	Data          []byte `json:"data"`
	Code          int    `json:"code"`
	Confirmed     bool   `json:"confirmed"`
	Cancelled     bool   `json:"cancelled"`
	InputOverflow bool   `json:"input_overflow"`
}

func NewMCPManager(active technicalidentity.ActiveProfile, engine driver.Engine, sandboxes *sandbox.Manager, config MCPConfig) (*MCPManager, error) {
	if _, err := active.Profile(); err != nil {
		return nil, fmt.Errorf("MCP technical profile: %w", err)
	}
	if config.Dir == "" || !filepath.IsAbs(config.Dir) {
		return nil, errors.New("MCP directory must be absolute")
	}
	if config.OwnerLimit < 1 {
		config.OwnerLimit = 8
	}
	if config.GlobalLimit < 1 {
		config.GlobalLimit = 64
	}
	// Connections never survive a restart, so their stderr logs are stale.
	if err := os.RemoveAll(config.Dir); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(config.Dir, 0o700); err != nil {
		return nil, err
	}
	return &MCPManager{
		Engine: engine, Sandboxes: sandboxes, Dir: config.Dir,
		OwnerLimit: config.OwnerLimit, GlobalLimit: config.GlobalLimit,
		QueueMax: mcpQueueMaximumBytes, FrameMax: mcpFrameMaximumBytes,
		TermGrace: 5 * time.Second, StartTimeout: 20 * time.Second, Retention: mcpRetention,
		conns: map[string]*mcpConn{},
	}, nil
}

func (m *MCPManager) now() time.Time {
	if m.Now != nil {
		return m.Now().UTC()
	}
	return time.Now().UTC()
}

func (c *mcpConn) hardKill() { c.hardOnce.Do(func() { close(c.hard) }) }

func (c *mcpConn) signalLocked() {
	close(c.wake)
	c.wake = make(chan struct{})
}

// terminate ends the connection now with reason (the first reason wins).
func (c *mcpConn) terminate(reason string) {
	c.qmu.Lock()
	if c.state == "running" && c.reason == "" {
		c.reason = reason
	}
	c.qmu.Unlock()
	c.hardKill()
}

// ingest reassembles stdout chunks into LF-terminated frames, byte for byte.
// It never blocks: a violation records its reason and kills the connection, so
// the transport is always drained and stop is always deliverable.
func (m *MCPManager) ingest(c *mcpConn, data []byte) {
	c.qmu.Lock()
	reason := m.ingestLocked(c, data)
	if reason != "" && c.reason == "" {
		c.reason = reason
	}
	if reason != "" {
		c.failedOpen = true
	}
	c.signalLocked()
	c.qmu.Unlock()
	if reason != "" {
		c.hardKill()
	}
}

func (m *MCPManager) ingestLocked(c *mcpConn, data []byte) string {
	if c.failedOpen || c.state != "running" {
		return ""
	}
	for len(data) > 0 {
		index := bytes.IndexByte(data, '\n')
		if index < 0 {
			if len(c.partial)+len(data) > m.FrameMax {
				return mcpReasonFrameTooLarge
			}
			c.partial = append(c.partial, data...)
			return ""
		}
		line := data[:index]
		data = data[index+1:]
		if len(c.partial)+len(line) > m.FrameMax {
			return mcpReasonFrameTooLarge
		}
		frame := line
		if len(c.partial) > 0 {
			frame = append(c.partial, line...)
		}
		if len(frame) > 0 {
			if !utf8.Valid(frame) {
				return mcpReasonInvalidUTF8
			}
			if c.queued+len(frame) > m.QueueMax {
				return mcpReasonQueueOverflow
			}
			c.lastSeq++
			c.msgs = append(c.msgs, MCPMessage{Seq: c.lastSeq, Data: string(frame)})
			c.queued += len(frame)
		}
		c.partial = c.partial[:0]
	}
	return ""
}

func validMCPConnectorID(value string) bool { return mcpConnectorPattern.MatchString(value) }

// validateMCPStart checks the launch descriptor and returns the absolute cwd.
func validateMCPStart(args mcpStartArguments) (string, error) {
	if !validMCPConnectorID(args.ConnectorID) {
		return "", errors.New("connector_id is invalid")
	}
	cwd, err := mcpWorkspacePath(contract.ContainerWorkspace, args.CWD)
	if err != nil {
		return "", errors.New("cwd must be inside the workspace")
	}
	command := args.Command
	if strings.Contains(command, "/") {
		if _, err := mcpWorkspacePath(cwd, command); err != nil {
			return "", errors.New("command path must be inside the workspace")
		}
	} else if !mcpBareCommandPattern.MatchString(command) {
		return "", errors.New("command must be a bare executable name or a workspace path")
	}
	if len(args.Args) > mcpArgsMaximum {
		return "", errors.New("too many arguments")
	}
	for _, argument := range args.Args {
		if len(argument) > mcpArgBytesMaximum || !utf8.ValidString(argument) || strings.ContainsRune(argument, 0) {
			return "", errors.New("an argument is invalid")
		}
	}
	if len(args.Env) > mcpEnvMaximum {
		return "", errors.New("too many environment variables")
	}
	total := 0
	for key, value := range args.Env {
		if !mcpEnvKeyPattern.MatchString(key) || len(value) > mcpEnvValueBytesMaximum || !utf8.ValidString(value) || strings.ContainsRune(value, 0) {
			return "", errors.New("an environment variable is invalid")
		}
		total += len(key) + len(value)
	}
	if total > mcpEnvTotalBytesMaximum {
		return "", errors.New("environment is too large")
	}
	return cwd, nil
}

// mcpWorkspacePath resolves value (absolute, or relative to base) and requires
// the cleaned result to stay inside the workspace.
func mcpWorkspacePath(base, value string) (string, error) {
	if strings.ContainsRune(value, 0) || len(value) > 4096 || !utf8.ValidString(value) {
		return "", errors.New("invalid path")
	}
	if value == "" {
		value = base
	} else if value[0] != '/' {
		value = base + "/" + value
	}
	cleaned := path.Clean(value)
	root := contract.ContainerWorkspace
	if cleaned != root && !strings.HasPrefix(cleaned, root+"/") {
		return "", errors.New("outside the workspace")
	}
	return cleaned, nil
}

func validateMCPMessage(message string) error {
	if len(message) == 0 || len(message) > mcpFrameMaximumBytes {
		return errors.New("message must be 1 byte to 1 MiB")
	}
	if !utf8.ValidString(message) || strings.ContainsAny(message, "\r\n") {
		return errors.New("message must be single-line UTF-8")
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal([]byte(message), &object); err != nil || object == nil {
		return errors.New("message must be one JSON-RPC object")
	}
	return nil
}

// projectMCPAudit is the only audit detail an MCP receipt retains: it is derived
// from the arguments here, never taken from the caller, and holds no env values,
// argv or message content.
func projectMCPAudit(action string, raw json.RawMessage) (map[string]any, error) {
	switch action {
	case "start":
		var args mcpStartArguments
		if err := decodeArguments(raw, &args); err != nil {
			return nil, err
		}
		if _, err := validateMCPStart(args); err != nil {
			return nil, err
		}
		keys := make([]string, 0, len(args.Env))
		for key := range args.Env {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		return map[string]any{"connector_id": args.ConnectorID, "command": args.Command, "args_count": len(args.Args), "env_keys": keys}, nil
	case "send":
		var args mcpSendArguments
		if err := decodeArguments(raw, &args); err != nil {
			return nil, err
		}
		if !mcpIDPattern.MatchString(args.ConnectionID) {
			return nil, ErrMCPConnectionNotFound
		}
		if err := validateMCPMessage(args.Message); err != nil {
			return nil, err
		}
		details := map[string]any{"connection_id": args.ConnectionID, "bytes": len(args.Message)}
		var probe struct {
			Method string `json:"method"`
		}
		if json.Unmarshal([]byte(args.Message), &probe) == nil && mcpMethodPattern.MatchString(probe.Method) {
			details["method"] = probe.Method
		}
		return details, nil
	case "stop":
		var args mcpStopArguments
		if err := decodeArguments(raw, &args); err != nil {
			return nil, err
		}
		if !mcpIDPattern.MatchString(args.ConnectionID) {
			return nil, ErrMCPConnectionNotFound
		}
		return map[string]any{"connection_id": args.ConnectionID}, nil
	}
	return nil, errors.New("operation and action are not a supported execution binding")
}

// residency is one finite hold on a sandbox, released exactly once.
type residency struct {
	once    sync.Once
	release func()
}

func (r *residency) End() { r.once.Do(r.release) }

func (m *MCPManager) lease(sandboxID string) (*residency, error) {
	if err := m.Sandboxes.BeginCall(sandboxID, time.Now()); err != nil {
		return nil, err
	}
	return &residency{release: func() { _ = m.Sandboxes.EndCall(sandboxID, time.Now()) }}, nil
}

// Start launches a server and returns its connection id once the in-sandbox
// supervisor is up. Residency is held only until then.
func (m *MCPManager) Start(ctx context.Context, call Call, args mcpStartArguments) (string, error) {
	cwd, err := validateMCPStart(args)
	if err != nil {
		return "", err
	}
	if call.Target != "sandbox" {
		return "", errors.New("target must be sandbox")
	}
	owner := scopeFamilyRoot(call.ScopeID)
	id, err := newULIDID(mcpIDPrefix, m.now())
	if err != nil {
		return "", err
	}
	log, err := newProcessLog(filepath.Join(m.Dir, id), mcpLogCapBytes, mcpLogDropBytes)
	if err != nil {
		return "", err
	}
	c := &mcpConn{
		id: id, owner: owner, log: log, wake: make(chan struct{}), state: "running",
		done: make(chan struct{}), started: make(chan struct{}), hard: make(chan struct{}),
		exec: call.ExecutionContext,
	}
	c.exec.Profile = storedProfile(call.ExecutionContext.Profile)
	abandon := func() {
		m.mu.Lock()
		delete(m.conns, id)
		m.mu.Unlock()
		log.Close()
		_ = os.RemoveAll(filepath.Join(m.Dir, id))
	}
	m.mu.Lock()
	m.pruneLocked()
	running, ownerRunning := 0, 0
	for _, other := range m.conns {
		select {
		case <-other.done:
			continue
		default:
		}
		running++
		if other.owner == owner {
			ownerRunning++
		}
	}
	if ownerRunning >= m.OwnerLimit || running >= m.GlobalLimit {
		m.mu.Unlock()
		log.Close()
		_ = os.RemoveAll(filepath.Join(m.Dir, id))
		return "", errors.New("too many MCP connections")
	}
	m.conns[id] = c
	m.mu.Unlock()

	spec, err := m.Sandboxes.Ensure(ctx, call.ExecutionContext.SandboxID, call.ExecutionContext.WorkspaceID, time.Now(), call.ExecutionContext.Profile)
	if err != nil {
		abandon()
		return "", err
	}
	hold, err := m.lease(call.ExecutionContext.SandboxID)
	if err != nil {
		abandon()
		return "", err
	}
	defer hold.End()
	if err := ctx.Err(); err != nil {
		abandon()
		return "", err
	}
	argv := append([]string{"-I", "-c", sandboxMCPWrapper, args.Command}, args.Args...)
	name, arguments := m.Engine.ExecArgs(spec, cwd, "python3", argv)
	command := exec.Command(name, arguments...)
	command.WaitDelay = 3 * time.Second
	controlRead, controlWrite, err := os.Pipe()
	if err != nil {
		abandon()
		return "", err
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
		abandon()
		return "", err
	}
	controlRead.Close()
	c.control.file = controlWrite
	go m.supervise(c, command, reader, writer)

	env := args.Env
	if env == nil {
		env = map[string]string{}
	}
	if err := c.control.send(map[string]any{"t": "env", "env": env}); err != nil {
		c.terminate(mcpReasonStartFailed)
		<-c.done
		return "", m.startFailure(c, err.Error())
	}
	timer := time.NewTimer(m.StartTimeout)
	defer timer.Stop()
	select {
	case <-c.started:
	case <-c.done:
	case <-ctx.Done():
		c.terminate(mcpReasonStartFailed)
		<-c.done
		return "", ctx.Err()
	case <-timer.C:
		c.terminate(mcpReasonStartFailed)
		<-c.done
	}
	select {
	case <-c.done:
		// The server ended while starting (a missing executable exits 127).
		return "", m.startFailure(c, "")
	default:
	}
	return id, nil
}

func (m *MCPManager) startFailure(c *mcpConn, detail string) error {
	result := m.snapshot(c)
	message := "MCP server did not start (" + result.Reason + ")"
	if result.ExitCode != nil {
		message = fmt.Sprintf("MCP server exited during start with code %d", *result.ExitCode)
	}
	if detail != "" {
		message += ": " + detail
	}
	if tail := strings.TrimSpace(result.StderrTail); tail != "" {
		message += ": " + tail
	}
	m.mu.Lock()
	delete(m.conns, c.id)
	m.mu.Unlock()
	_ = os.RemoveAll(filepath.Join(m.Dir, c.id))
	return errors.New(message)
}

func (m *MCPManager) supervise(c *mcpConn, command *exec.Cmd, reader *io.PipeReader, writer *io.PipeWriter) {
	var final *mcpFrame
	decoded := make(chan error, 1)
	go func() {
		defer reader.Close()
		decoder := json.NewDecoder(reader)
		for {
			var frame mcpFrame
			if err := decoder.Decode(&frame); err != nil {
				if err == io.EOF && final != nil {
					err = nil
				}
				if err != nil {
					c.hardKill()
				}
				decoded <- err
				return
			}
			if final != nil {
				c.hardKill()
				decoded <- errors.New("output after terminal confirmation")
				return
			}
			switch frame.Stream {
			case "started":
				c.startedOnce.Do(func() { close(c.started) })
			case "stdout":
				m.ingest(c, frame.Data)
			case "stderr":
				_, _ = c.log.Write(frame.Data)
			case "exit":
				final = &frame
			default:
				c.hardKill()
				decoded <- errors.New("invalid MCP output frame")
				return
			}
		}
	}()
	waited := make(chan error, 1)
	go func() { err := command.Wait(); writer.Close(); waited <- err }()
	var waitErr error
	select {
	case waitErr = <-waited:
	case <-c.hard:
		c.control.close()
		select {
		case waitErr = <-waited:
		case <-time.After(5 * time.Second):
			_ = command.Process.Kill()
			_ = reader.Close()
			waitErr = <-waited
		}
	}
	decodeErr := <-decoded
	c.log.Close()
	m.finalize(c, final, waitErr, decodeErr)
}

func (m *MCPManager) containerGone(c *mcpConn) bool {
	spec, err := m.Sandboxes.Spec(c.exec.SandboxID)
	if err != nil {
		return false
	}
	running, err := m.Engine.SandboxRunning(context.Background(), spec.ContainerName)
	return err == nil && !running
}

func mcpFailureReason(reason string) bool {
	switch reason {
	case mcpReasonFrameTooLarge, mcpReasonInvalidUTF8, mcpReasonQueueOverflow, mcpReasonInputOverflow, mcpReasonChannelFailed, mcpReasonStartFailed:
		return true
	}
	return false
}

func (m *MCPManager) finalize(c *mcpConn, final *mcpFrame, waitErr, decodeErr error) {
	started := false
	select {
	case <-c.started:
		started = true
	default:
	}
	confirmed := final != nil && final.Confirmed && waitErr == nil && decodeErr == nil
	gone := false
	if !confirmed {
		gone = m.containerGone(c)
	}
	c.qmu.Lock()
	reason := c.reason
	if reason == "" && final != nil && final.InputOverflow {
		reason = mcpReasonInputOverflow
	}
	state := "exited"
	switch {
	case !started && final == nil:
		state, reason = "failed", mcpReasonStartFailed
		c.unconfirm = !gone
	case confirmed:
		if reason == "" {
			reason = mcpReasonExited
		}
		if mcpFailureReason(reason) {
			state = "failed"
		}
	case gone:
		reason = mcpReasonSandboxStopped
	default:
		state, reason, c.unconfirm = "failed", mcpReasonChannelFailed, true
	}
	if final != nil {
		code := final.Code
		c.exitCode = &code
	}
	if reason == mcpReasonStopped {
		c.msgs, c.queued = nil, 0
	}
	c.partial = nil
	c.state, c.reason, c.ended = state, reason, m.now()
	c.signalLocked()
	c.qmu.Unlock()
	close(c.done)
	m.mu.Lock()
	m.pruneLocked()
	m.mu.Unlock()
}

// pruneLocked forgets ended connections after Retention, keeping at most
// mcpRetainedEnded of them.
func (m *MCPManager) pruneLocked() {
	type endedConn struct {
		c  *mcpConn
		at time.Time
	}
	var ended []endedConn
	for _, c := range m.conns {
		select {
		case <-c.done:
		default:
			continue
		}
		c.qmu.Lock()
		at := c.ended
		c.qmu.Unlock()
		ended = append(ended, endedConn{c, at})
	}
	sort.Slice(ended, func(i, j int) bool { return ended[i].at.After(ended[j].at) })
	now := m.now()
	for index, item := range ended {
		if index >= mcpRetainedEnded || now.Sub(item.at) > m.Retention {
			delete(m.conns, item.c.id)
			_ = os.RemoveAll(filepath.Join(m.Dir, item.c.id))
		}
	}
}

func (m *MCPManager) lookup(id, owner string) (*mcpConn, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c := m.conns[id]
	if c == nil || c.owner != owner {
		return nil, ErrMCPConnectionNotFound
	}
	return c, nil
}

// lookupCall resolves a connection for a receipt-bound call: it must belong to
// the call's owner and be bound to the call's sandbox and workspace.
func (m *MCPManager) lookupCall(call Call, id string) (*mcpConn, error) {
	c, err := m.lookup(id, scopeFamilyRoot(call.ScopeID))
	if err != nil {
		return nil, err
	}
	if !sameExecutionContext(c.exec, call.ExecutionContext) {
		return nil, ErrMCPConnectionNotFound
	}
	return c, nil
}

// CheckOwner reports whether the call may address the connection.
func (m *MCPManager) CheckOwner(id string, call Call) error {
	_, err := m.lookupCall(call, id)
	return err
}

// Send writes exactly one frame to the server. Acceptance by the control pipe
// is not execution by the server; a failed write ends the connection.
func (m *MCPManager) Send(call Call, id, message string) error {
	if err := validateMCPMessage(message); err != nil {
		return err
	}
	c, err := m.lookupCall(call, id)
	if err != nil {
		return err
	}
	c.qmu.Lock()
	state, reason := c.state, c.reason
	c.qmu.Unlock()
	if state != "running" {
		return fmt.Errorf("MCP connection has ended (%s)", reason)
	}
	hold, err := m.lease(c.exec.SandboxID)
	if err != nil {
		return err
	}
	defer hold.End()
	frame := map[string]any{"t": "d", "d": base64.StdEncoding.EncodeToString([]byte(message + "\n"))}
	if err := c.control.send(frame); err != nil {
		c.terminate(mcpReasonChannelFailed)
		return err
	}
	return nil
}

// Stop terminates the server: SIGTERM to its group, SIGKILL after TermGrace,
// and confirmation of every descendant. An unconfirmed stop is an error.
func (m *MCPManager) Stop(call Call, id string) (MCPRecvResult, error) {
	c, err := m.lookupCall(call, id)
	if err != nil {
		return MCPRecvResult{}, err
	}
	c.qmu.Lock()
	if c.state == "running" && c.reason == "" {
		c.reason = mcpReasonStopped
	}
	running := c.state == "running"
	c.qmu.Unlock()
	if running {
		_ = c.control.send(map[string]any{"t": "s", "s": int(syscall.SIGTERM)})
		select {
		case <-c.done:
		case <-time.After(m.TermGrace):
			c.hardKill()
			select {
			case <-c.done:
			case <-time.After(30 * time.Second):
			}
		}
	}
	select {
	case <-c.done:
	default:
		return MCPRecvResult{}, errors.New("MCP server termination is not confirmed yet")
	}
	result := m.snapshot(c)
	c.qmu.Lock()
	unconfirmed := c.unconfirm
	c.qmu.Unlock()
	if unconfirmed {
		return MCPRecvResult{}, errors.New("MCP server termination is not confirmed")
	}
	return result, nil
}

// snapshot reports the connection's state without delivering messages.
func (m *MCPManager) snapshot(c *mcpConn) MCPRecvResult {
	c.qmu.Lock()
	result := MCPRecvResult{Messages: []MCPMessage{}, Next: c.acked, State: c.state, ExitCode: c.exitCode}
	if c.state != "running" {
		result.Reason = c.reason
	}
	ended := c.state != "running"
	c.qmu.Unlock()
	if ended {
		result.StderrTail = stderrTail(c.log)
	}
	return result
}

func stderrTail(log *processLog) string {
	read, err := log.Read(-1, mcpStderrTailBytes)
	if err != nil {
		return ""
	}
	return string(read.Data)
}

// Recv returns the retained messages after req.Ack. Messages stay retained
// until a later call acknowledges them, so a lost response is simply retried.
func (m *MCPManager) Recv(ctx context.Context, req MCPRecvRequest) (MCPRecvResult, error) {
	if req.Ack < 0 || req.WaitMS < 0 || req.WaitMS > mcpWaitMaximum || req.MaxBytes < 0 || req.MaxBytes > mcpRecvMaximumBytes {
		return MCPRecvResult{}, errors.New("ack, wait_ms or max_bytes is out of range")
	}
	if req.MaxBytes == 0 {
		req.MaxBytes = mcpRecvDefaultBytes
	}
	c, err := m.lookup(req.ConnectionID, req.Owner)
	if err != nil {
		return MCPRecvResult{}, err
	}
	var timer <-chan time.Time
	if req.WaitMS > 0 {
		t := time.NewTimer(time.Duration(req.WaitMS) * time.Millisecond)
		defer t.Stop()
		timer = t.C
	}
	for {
		c.qmu.Lock()
		if req.Ack > c.lastSeq || req.Ack < c.acked {
			c.qmu.Unlock()
			return MCPRecvResult{}, fmt.Errorf("ack %d is outside the retained range %d..%d", req.Ack, c.acked, c.lastSeq)
		}
		drop := 0
		for drop < len(c.msgs) && c.msgs[drop].Seq <= req.Ack {
			c.queued -= len(c.msgs[drop].Data)
			drop++
		}
		if drop > 0 {
			c.msgs = append([]MCPMessage(nil), c.msgs[drop:]...)
		}
		c.acked = req.Ack
		out, size := []MCPMessage{}, 0
		for _, message := range c.msgs {
			if len(out) > 0 && size+len(message.Data) > req.MaxBytes {
				break
			}
			out = append(out, message)
			size += len(message.Data)
		}
		result := MCPRecvResult{Messages: out, Next: req.Ack, State: c.state, ExitCode: c.exitCode}
		if len(out) > 0 {
			result.Next = out[len(out)-1].Seq
		}
		ended := c.state != "running"
		more := len(out) < len(c.msgs)
		if ended && !more {
			result.Reason = c.reason
		} else {
			result.State = "running"
			result.ExitCode = nil
		}
		wake := c.wake
		c.qmu.Unlock()
		if len(out) > 0 || ended || req.WaitMS == 0 {
			if ended && !more {
				result.StderrTail = stderrTail(c.log)
			}
			return result, nil
		}
		select {
		case <-wake:
		case <-timer:
			return result, nil
		case <-ctx.Done():
			return MCPRecvResult{}, ctx.Err()
		}
	}
}

// SandboxStopped ends every connection hosted by the stopped sandbox. It runs
// from the sandbox stop path, possibly under the lifecycle lock, so it only
// records the reason and closes the lease; the supervisor settles asynchronously.
func (m *MCPManager) SandboxStopped(sandboxID string) {
	m.mu.Lock()
	var hit []*mcpConn
	for _, c := range m.conns {
		if c.exec.SandboxID == sandboxID {
			hit = append(hit, c)
		}
	}
	m.mu.Unlock()
	for _, c := range hit {
		c.terminate(mcpReasonSandboxStopped)
	}
}

// RunningCount reports live connections, for tests and diagnostics.
func (m *MCPManager) RunningCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	count := 0
	for _, c := range m.conns {
		select {
		case <-c.done:
		default:
			count++
		}
	}
	return count
}
