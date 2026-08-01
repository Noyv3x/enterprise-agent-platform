//go:build linux

package handoffstartup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

// HelperLocatorMode is selected only by the one extant capability socket.
// The locator path itself never selects a technical profile or startup mode.
type HelperLocatorMode string

const (
	HelperLocatorFormal      HelperLocatorMode = "formal"
	HelperLocatorAbortSource HelperLocatorMode = "abort_source"
)

// HelperLocatorDecision is a closed union. Formal and AbortSource can never
// both be populated.
type HelperLocatorDecision struct {
	Mode        HelperLocatorMode
	Formal      *Decision
	AbortSource *AbortSourceDecision
}

// AbortSourceSnapshot is the restricted pre-fence source capability. It has
// no profile selector, Store path, status/outcome, mutation token, or writer
// capability. The API itself fixes this snapshot to the source layout.
type AbortSourceSnapshot struct {
	SchemaVersion  int       `json:"schema_version"`
	TransactionID  string    `json:"transaction_id"`
	Revision       uint64    `json:"revision"`
	BindingSHA256  string    `json:"binding_sha256"`
	Nonce          string    `json:"nonce"`
	ManagerSHA256  string    `json:"manager_sha256"`
	StableBinary   string    `json:"stable_binary"`
	ConfigPath     string    `json:"config_path"`
	ConfigSHA256   string    `json:"config_sha256"`
	DataRoot       string    `json:"data_root"`
	StateRoot      string    `json:"state_root"`
	SocketPath     string    `json:"socket_path"`
	ComposeProject string    `json:"compose_project"`
	CoreNetwork    string    `json:"core_network"`
	IssuedAt       time.Time `json:"issued_at"`
	ExpiresAt      time.Time `json:"expires_at"`
}

// AbortSourceDecision is consumed before any ordinary Manager construction.
// The caller must remain in restricted mode until listener restoration and
// terminal/global-lease release have independently completed.
type AbortSourceDecision struct {
	TransactionID string
	Revision      uint64
	BindingSHA256 string
	ManagerSHA256 string
	ConfigSHA256  string
	Paths         RuntimePaths
	Snapshot      AbortSourceSnapshot
}

type AbortSourceIssuerOptions struct {
	Lease                JournalLease
	TransactionDirectory string
	Bindings             Bindings
	TTL                  time.Duration
	Clock                Clock
}

// AbortSourceConsumption lets the helper bind a successful one-shot exchange
// to the exact systemd MainPID before accepting startup as complete.
type AbortSourceConsumption struct {
	PID           int
	TransactionID string
	Revision      uint64
	BindingSHA256 string
}

type AbortSourceIssuer struct {
	lease       JournalLease
	bindings    Bindings
	ttl         time.Duration
	clock       Clock
	transaction string
	directory   *os.File
	listener    *net.UnixListener
	procPath    string
	identity    fileIdentity
	mu          sync.Mutex
	consumed    bool
	closed      bool
}

func NewAbortSourceIssuer(options AbortSourceIssuerOptions) (*AbortSourceIssuer, error) {
	if options.Lease == nil {
		return nil, errors.New("abort source capability requires the helper journal lease")
	}
	if options.Clock == nil {
		options.Clock = time.Now
	}
	if options.TTL == 0 {
		options.TTL = DefaultTTL
	}
	if options.TTL <= 0 || options.TTL > MaximumTTL {
		return nil, errors.New("abort source capability TTL is outside the allowed range")
	}
	if err := validateBindings(options.Bindings); err != nil {
		return nil, err
	}
	journal, err := options.Lease.Load()
	if err != nil {
		return nil, fmt.Errorf("read helper-owned abort journal: %w", err)
	}
	if filepath.Base(options.TransactionDirectory) != journal.TransactionID || !transactionPattern.MatchString(journal.TransactionID) {
		return nil, errors.New("abort source transaction directory differs from the helper journal")
	}
	if err := validateAbortSourceJournal(journal, options.Bindings); err != nil {
		return nil, err
	}
	directory, err := openDirectoryNoFollow(options.TransactionDirectory, true)
	if err != nil {
		return nil, fmt.Errorf("open abort source transaction directory: %w", err)
	}
	if err := prepareCapabilitySocket(directory, AbortSourceSocketBasename, SocketBasename); err != nil {
		_ = directory.Close()
		return nil, err
	}
	procPath := fmt.Sprintf("/proc/self/fd/%d/%s", directory.Fd(), AbortSourceSocketBasename)
	listener, err := net.ListenUnix("unixpacket", &net.UnixAddr{Name: procPath, Net: "unixpacket"})
	if err != nil {
		_ = directory.Close()
		return nil, err
	}
	listener.SetUnlinkOnClose(false)
	cleanup := true
	defer func() {
		if cleanup {
			_ = listener.Close()
			_ = syscall.Unlinkat(int(directory.Fd()), AbortSourceSocketBasename)
			_ = directory.Close()
		}
	}()
	if err := syscall.Fchmodat(int(directory.Fd()), AbortSourceSocketBasename, 0o600, 0); err != nil {
		return nil, fmt.Errorf("restrict abort source capability socket: %w", err)
	}
	pathIdentity, err := inspectPath(procPath)
	if err != nil {
		return nil, err
	}
	if err := verifySocketIdentity(pathIdentity); err != nil {
		return nil, err
	}
	cleanup = false
	return &AbortSourceIssuer{
		lease: options.Lease, bindings: options.Bindings, ttl: options.TTL, clock: options.Clock,
		transaction: journal.TransactionID, directory: directory, listener: listener,
		procPath: procPath, identity: pathIdentity,
	}, nil
}

func (issuer *AbortSourceIssuer) Serve(ctx context.Context) (AbortSourceConsumption, error) {
	if issuer == nil {
		return AbortSourceConsumption{}, errors.New("abort source capability issuer is unavailable")
	}
	issuer.mu.Lock()
	if issuer.closed || issuer.consumed {
		issuer.mu.Unlock()
		return AbortSourceConsumption{}, ErrCapabilityConsumed
	}
	issuer.consumed = true
	listener := issuer.listener
	deadline := issuer.clock().UTC().Add(issuer.ttl)
	issuer.mu.Unlock()
	defer issuer.Close()
	if requested, ok := ctx.Deadline(); ok && requested.Before(deadline) {
		deadline = requested
	}
	if err := listener.SetDeadline(deadline); err != nil {
		return AbortSourceConsumption{}, err
	}
	stopAcceptInterrupt := interruptOnCancel(ctx, func() error { return listener.SetDeadline(time.Now()) })
	connection, err := listener.AcceptUnix()
	stopAcceptInterrupt()
	if err != nil {
		return AbortSourceConsumption{}, contextIOError(ctx, err)
	}
	defer connection.Close()
	if err := issuer.verifySocket(); err != nil {
		return AbortSourceConsumption{}, err
	}
	credentials, err := peerCredentials(connection)
	if err != nil {
		return AbortSourceConsumption{}, err
	}
	if err := setConnectionDeadline(connection, ctx, deadline); err != nil {
		return AbortSourceConsumption{}, err
	}
	stopConnectionInterrupt := interruptOnCancel(ctx, func() error { return connection.SetDeadline(time.Now()) })
	defer stopConnectionInterrupt()
	payload, err := readPacket(connection)
	if err != nil {
		return AbortSourceConsumption{}, contextIOError(ctx, err)
	}
	var request startupRequest
	if err := decodeExactJSON(payload, &request, requestFields); err != nil {
		return AbortSourceConsumption{}, fmt.Errorf("decode abort source capability request: %w", err)
	}
	if request.SchemaVersion != SchemaVersion || request.TransactionID != issuer.transaction || !noncePattern.MatchString(request.Nonce) {
		return AbortSourceConsumption{}, errors.New("abort source capability request binding is invalid")
	}
	journal, err := issuer.lease.Load()
	if err != nil {
		return AbortSourceConsumption{}, fmt.Errorf("refresh helper-owned abort journal: %w", err)
	}
	if err := validateAbortSourceJournal(journal, issuer.bindings); err != nil {
		return AbortSourceConsumption{}, err
	}
	if err := verifyProcessExecutable(int(credentials.Pid), issuer.bindings.Source.StableBinary, journal.Source.StableSHA256); err != nil {
		return AbortSourceConsumption{}, fmt.Errorf("verify abort source capability peer executable: %w", err)
	}
	issuedAt := issuer.clock().UTC()
	if issuedAt.After(deadline) {
		return AbortSourceConsumption{}, context.DeadlineExceeded
	}
	expiresAt := issuedAt.Add(issuer.ttl)
	if deadline.Before(expiresAt) {
		expiresAt = deadline
	}
	snapshot := abortSourceSnapshotFromJournal(journal, issuer.bindings.Source, request.Nonce, issuedAt, expiresAt)
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		return AbortSourceConsumption{}, err
	}
	if len(encoded) > maxPacketBytes {
		return AbortSourceConsumption{}, errors.New("abort source capability snapshot exceeds its packet limit")
	}
	written, oobWritten, err := connection.WriteMsgUnix(encoded, nil, nil)
	if err != nil || written != len(encoded) || oobWritten != 0 {
		if err == nil {
			err = io.ErrShortWrite
		}
		return AbortSourceConsumption{}, contextIOError(ctx, err)
	}
	return AbortSourceConsumption{
		PID: int(credentials.Pid), TransactionID: journal.TransactionID,
		Revision: journal.Revision, BindingSHA256: journal.BindingSHA256,
	}, nil
}

func (issuer *AbortSourceIssuer) verifySocket() error {
	observed, err := inspectPath(issuer.procPath)
	if err != nil {
		return err
	}
	if observed != issuer.identity {
		return errors.New("abort source capability socket identity changed")
	}
	return verifySocketIdentity(observed)
}

func (issuer *AbortSourceIssuer) Close() error {
	if issuer == nil {
		return nil
	}
	issuer.mu.Lock()
	defer issuer.mu.Unlock()
	if issuer.closed {
		return nil
	}
	issuer.closed = true
	var result error
	if issuer.listener != nil {
		result = errors.Join(result, issuer.listener.Close())
	}
	if current, err := inspectPath(issuer.procPath); err == nil {
		if current != issuer.identity {
			result = errors.Join(result, errors.New("refusing to remove a replaced abort source capability socket"))
		} else if err := syscall.Unlinkat(int(issuer.directory.Fd()), AbortSourceSocketBasename); err != nil && !errors.Is(err, syscall.ENOENT) {
			result = errors.Join(result, err)
		}
	} else if !os.IsNotExist(err) {
		result = errors.Join(result, err)
	}
	if issuer.directory != nil {
		result = errors.Join(result, issuer.directory.Close())
	}
	return result
}

// RouteFromHelperLocator is the startup Router entry point used by serve. It
// refuses stale locators and ambiguous channel sets before choosing a parser.
func (r *Router) RouteFromHelperLocator(ctx context.Context, transactionDirectory string) (HelperLocatorDecision, error) {
	if r == nil {
		return HelperLocatorDecision{}, errors.New("startup router is unavailable")
	}
	directory, err := openLocatorDirectory(transactionDirectory)
	if err != nil {
		return HelperLocatorDecision{}, err
	}
	formal, formalErr := capabilityExists(directory, SocketBasename)
	abort, abortErr := capabilityExists(directory, AbortSourceSocketBasename)
	_ = directory.Close()
	if formalErr != nil || abortErr != nil {
		return HelperLocatorDecision{}, errors.Join(formalErr, abortErr)
	}
	if formal == abort {
		return HelperLocatorDecision{}, errors.New("helper locator must expose exactly one startup capability role")
	}
	if formal {
		decision, err := r.RouteFromHelper(ctx, transactionDirectory)
		if err != nil {
			return HelperLocatorDecision{}, err
		}
		return HelperLocatorDecision{Mode: HelperLocatorFormal, Formal: &decision}, nil
	}
	decision, err := r.RouteAbortSource(ctx, transactionDirectory)
	if err != nil {
		return HelperLocatorDecision{}, err
	}
	return HelperLocatorDecision{Mode: HelperLocatorAbortSource, AbortSource: &decision}, nil
}

func (r *Router) RouteAbortSource(ctx context.Context, transactionDirectory string) (AbortSourceDecision, error) {
	if r == nil {
		return AbortSourceDecision{}, errors.New("startup router is unavailable")
	}
	directory, err := openLocatorDirectory(transactionDirectory)
	if err != nil {
		return AbortSourceDecision{}, err
	}
	defer directory.Close()
	if err := requireCapabilityAbsent(directory, SocketBasename); err != nil {
		return AbortSourceDecision{}, err
	}
	transactionID := filepath.Base(transactionDirectory)
	procPath := fmt.Sprintf("/proc/self/fd/%d/%s", directory.Fd(), AbortSourceSocketBasename)
	before, err := inspectPath(procPath)
	if err != nil {
		return AbortSourceDecision{}, err
	}
	if err := verifySocketIdentity(before); err != nil {
		return AbortSourceDecision{}, err
	}
	raw, err := (&net.Dialer{}).DialContext(ctx, "unixpacket", procPath)
	if err != nil {
		return AbortSourceDecision{}, contextIOError(ctx, err)
	}
	connection, ok := raw.(*net.UnixConn)
	if !ok {
		_ = raw.Close()
		return AbortSourceDecision{}, errors.New("abort source capability did not create a Unix packet connection")
	}
	defer connection.Close()
	after, err := inspectPath(procPath)
	if err != nil || after != before {
		return AbortSourceDecision{}, errors.New("abort source capability socket changed while connecting")
	}
	if _, err := peerCredentials(connection); err != nil {
		return AbortSourceDecision{}, err
	}
	now := r.clock().UTC()
	if err := setConnectionDeadline(connection, ctx, now.Add(MaximumTTL)); err != nil {
		return AbortSourceDecision{}, err
	}
	stopConnectionInterrupt := interruptOnCancel(ctx, func() error { return connection.SetDeadline(time.Now()) })
	defer stopConnectionInterrupt()
	nonce, err := randomNonce()
	if err != nil {
		return AbortSourceDecision{}, err
	}
	encoded, err := json.Marshal(startupRequest{SchemaVersion: SchemaVersion, TransactionID: transactionID, Nonce: nonce})
	if err != nil {
		return AbortSourceDecision{}, err
	}
	written, oobWritten, err := connection.WriteMsgUnix(encoded, nil, nil)
	if err != nil || written != len(encoded) || oobWritten != 0 {
		if err == nil {
			err = io.ErrShortWrite
		}
		return AbortSourceDecision{}, contextIOError(ctx, err)
	}
	payload, err := readPacket(connection)
	if err != nil {
		return AbortSourceDecision{}, contextIOError(ctx, err)
	}
	var snapshot AbortSourceSnapshot
	if err := decodeExactJSON(payload, &snapshot, abortSourceSnapshotFields); err != nil {
		return AbortSourceDecision{}, fmt.Errorf("decode abort source capability snapshot: %w", err)
	}
	return r.decisionFromAbortSourceSnapshot(snapshot, transactionID, nonce)
}

func (r *Router) decisionFromAbortSourceSnapshot(snapshot AbortSourceSnapshot, transactionID, nonce string) (AbortSourceDecision, error) {
	if snapshot.SchemaVersion != SchemaVersion || snapshot.TransactionID != transactionID || snapshot.Nonce != nonce ||
		!transactionPattern.MatchString(snapshot.TransactionID) || !noncePattern.MatchString(snapshot.Nonce) || snapshot.Revision == 0 ||
		!shaPattern.MatchString(snapshot.BindingSHA256) || !shaPattern.MatchString(snapshot.ManagerSHA256) ||
		!shaPattern.MatchString(snapshot.ConfigSHA256) {
		return AbortSourceDecision{}, errors.New("abort source capability snapshot binding is invalid")
	}
	now := r.clock().UTC()
	if snapshot.IssuedAt.IsZero() || snapshot.ExpiresAt.IsZero() || snapshot.ExpiresAt.Before(snapshot.IssuedAt) ||
		snapshot.ExpiresAt.Sub(snapshot.IssuedAt) > MaximumTTL || now.Before(snapshot.IssuedAt) || !now.Before(snapshot.ExpiresAt) {
		return AbortSourceDecision{}, errors.New("abort source capability snapshot is expired or has invalid timestamps")
	}
	paths := r.bindings.Source
	if paths.StableBinary == "" {
		paths = RuntimePaths{
			StableBinary: snapshot.StableBinary,
			ConfigPath:   snapshot.ConfigPath,
			DataRoot:     snapshot.DataRoot,
			StateRoot:    snapshot.StateRoot,
			SocketPath:   snapshot.SocketPath,
		}
		if err := validateRuntimePaths("abort source capability", identity.SourceProfile(), paths); err != nil {
			return AbortSourceDecision{}, err
		}
	}
	profile := identity.SourceProfile()
	if snapshot.StableBinary != paths.StableBinary || snapshot.ConfigPath != paths.ConfigPath || snapshot.DataRoot != paths.DataRoot ||
		snapshot.StateRoot != paths.StateRoot || snapshot.SocketPath != paths.SocketPath ||
		snapshot.ComposeProject != profile.ComposeProject || snapshot.CoreNetwork != profile.CoreNetwork {
		return AbortSourceDecision{}, errors.New("abort source capability snapshot differs from the fixed source layout")
	}
	if err := verifyProcessExecutable(r.pid(), paths.StableBinary, snapshot.ManagerSHA256); err != nil {
		return AbortSourceDecision{}, fmt.Errorf("verify abort source Router executable: %w", err)
	}
	if err := verifyRuntimeLayout(paths); err != nil {
		return AbortSourceDecision{}, fmt.Errorf("verify abort source Router layout: %w", err)
	}
	return AbortSourceDecision{
		TransactionID: snapshot.TransactionID, Revision: snapshot.Revision,
		BindingSHA256: snapshot.BindingSHA256, ManagerSHA256: snapshot.ManagerSHA256, ConfigSHA256: snapshot.ConfigSHA256,
		Paths: paths, Snapshot: snapshot,
	}, nil
}

func validateAbortSourceJournal(journal handoff.Journal, bindings Bindings) error {
	if err := validateJournalBindings(journal, bindings); err != nil {
		return err
	}
	if journal.Status != handoff.StatusRunning || journal.DesiredOutcome != handoff.OutcomeForward ||
		!phaseIs(journal.Phase, handoff.PhasePlanned, handoff.PhaseHelperArmed, handoff.PhaseAdmissionReserved,
			handoff.PhaseWritersStopped, handoff.PhaseSnapshotReady) {
		return errors.New("abort source capability requires an exact pre-fence forward journal")
	}
	return nil
}

func abortSourceSnapshotFromJournal(journal handoff.Journal, paths RuntimePaths, nonce string, issuedAt, expiresAt time.Time) AbortSourceSnapshot {
	profile := identity.SourceProfile()
	return AbortSourceSnapshot{
		SchemaVersion: SchemaVersion, TransactionID: journal.TransactionID, Revision: journal.Revision,
		BindingSHA256: journal.BindingSHA256, Nonce: nonce, ManagerSHA256: journal.Source.StableSHA256,
		StableBinary: paths.StableBinary, ConfigPath: paths.ConfigPath, ConfigSHA256: journal.Source.ConfigSHA256, DataRoot: paths.DataRoot,
		StateRoot: paths.StateRoot, SocketPath: paths.SocketPath, ComposeProject: profile.ComposeProject,
		CoreNetwork: profile.CoreNetwork, IssuedAt: issuedAt, ExpiresAt: expiresAt,
	}
}

func openLocatorDirectory(transactionDirectory string) (*os.File, error) {
	transactionID := filepath.Base(transactionDirectory)
	if !transactionPattern.MatchString(transactionID) {
		return nil, fmt.Errorf("%w: startup transaction id is invalid", ErrUnsafePath)
	}
	return openDirectoryNoFollow(transactionDirectory, true)
}

func capabilityExists(directory *os.File, basename string) (bool, error) {
	path := fmt.Sprintf("/proc/self/fd/%d/%s", directory.Fd(), basename)
	identity, err := inspectPath(path)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err := verifySocketIdentity(identity); err != nil {
		return false, err
	}
	return true, nil
}

var abortSourceSnapshotFields = []string{
	"schema_version", "transaction_id", "revision", "binding_sha256", "nonce", "manager_sha256",
	"stable_binary", "config_path", "config_sha256", "data_root", "state_root", "socket_path", "compose_project",
	"core_network", "issued_at", "expires_at",
}
