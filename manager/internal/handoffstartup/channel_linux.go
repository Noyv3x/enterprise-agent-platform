//go:build linux

package handoffstartup

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"syscall"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

var (
	transactionPattern = regexp.MustCompile(`^handoff_[0-9a-f]{32}$`)
	noncePattern       = regexp.MustCompile(`^[0-9a-f]{64}$`)
	shaPattern         = regexp.MustCompile(`^[0-9a-f]{64}$`)
	commitPattern      = regexp.MustCompile(`^[0-9a-f]{40}$`)
)

type startupRequest struct {
	SchemaVersion int    `json:"schema_version"`
	TransactionID string `json:"transaction_id"`
	Nonce         string `json:"nonce"`
}

// Issuer is a one-attempt startup capability owned by the persistent helper.
// It retains the transaction directory fd so channel creation and cleanup do
// not follow a pathname after validation.
type Issuer struct {
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

// CapabilitySocketPath returns the externally visible path. Actual creation,
// verification, connection, and removal are rooted at retained directory fds.
func CapabilitySocketPath(transactionDirectory string) (string, error) {
	if !canonicalAbsolute(transactionDirectory) || !transactionPattern.MatchString(filepath.Base(transactionDirectory)) {
		return "", fmt.Errorf("%w: transaction directory is invalid", ErrUnsafePath)
	}
	return filepath.Join(transactionDirectory, SocketBasename), nil
}

// NewIssuer creates the owner-only channel after proving that Lease still
// refers to the same transaction. It performs no Store lookup.
func NewIssuer(options IssuerOptions) (*Issuer, error) {
	if options.Lease == nil {
		return nil, errors.New("startup capability requires the helper journal lease")
	}
	if options.Clock == nil {
		options.Clock = time.Now
	}
	if options.TTL == 0 {
		options.TTL = DefaultTTL
	}
	if options.TTL <= 0 || options.TTL > MaximumTTL {
		return nil, errors.New("startup capability TTL is outside the allowed range")
	}
	if err := validateBindings(options.Bindings); err != nil {
		return nil, err
	}
	journal, err := options.Lease.Load()
	if err != nil {
		return nil, fmt.Errorf("read helper-owned startup journal: %w", err)
	}
	if filepath.Base(options.TransactionDirectory) != journal.TransactionID || !transactionPattern.MatchString(journal.TransactionID) {
		return nil, errors.New("startup transaction directory differs from the helper journal")
	}
	if err := validateJournalBindings(journal, options.Bindings); err != nil {
		return nil, err
	}
	directory, err := openDirectoryNoFollow(options.TransactionDirectory, true)
	if err != nil {
		return nil, fmt.Errorf("open startup transaction directory: %w", err)
	}
	procPath := fmt.Sprintf("/proc/self/fd/%d/%s", directory.Fd(), SocketBasename)
	if err := prepareCapabilitySocket(directory, SocketBasename, AbortSourceSocketBasename); err != nil {
		_ = directory.Close()
		return nil, err
	}
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
			_ = syscall.Unlinkat(int(directory.Fd()), SocketBasename)
			_ = directory.Close()
		}
	}()
	if err := syscall.Fchmodat(int(directory.Fd()), SocketBasename, 0o600, 0); err != nil {
		return nil, fmt.Errorf("restrict startup capability socket: %w", err)
	}
	pathIdentity, err := inspectPath(procPath)
	if err != nil {
		return nil, err
	}
	if err := verifySocketIdentity(pathIdentity); err != nil {
		return nil, err
	}
	cleanup = false
	return &Issuer{
		lease: options.Lease, bindings: options.Bindings, ttl: options.TTL, clock: options.Clock,
		transaction: journal.TransactionID, directory: directory, listener: listener, procPath: procPath, identity: pathIdentity,
	}, nil
}

// Serve accepts exactly one packet exchange. Any attempt closes and removes
// this socket; callers can create a new nonce-bound issuer after revalidating
// the still-held helper lease.
func (issuer *Issuer) Serve(ctx context.Context) error {
	if issuer == nil {
		return errors.New("startup capability issuer is unavailable")
	}
	issuer.mu.Lock()
	if issuer.closed || issuer.consumed {
		issuer.mu.Unlock()
		return ErrCapabilityConsumed
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
		return err
	}
	stopAcceptInterrupt := interruptOnCancel(ctx, func() error { return listener.SetDeadline(time.Now()) })
	connection, err := listener.AcceptUnix()
	stopAcceptInterrupt()
	if err != nil {
		return contextIOError(ctx, err)
	}
	defer connection.Close()
	if err := issuer.verifySocket(); err != nil {
		return err
	}
	credentials, err := peerCredentials(connection)
	if err != nil {
		return err
	}
	if err := setConnectionDeadline(connection, ctx, deadline); err != nil {
		return err
	}
	stopConnectionInterrupt := interruptOnCancel(ctx, func() error { return connection.SetDeadline(time.Now()) })
	defer stopConnectionInterrupt()
	payload, err := readPacket(connection)
	if err != nil {
		return contextIOError(ctx, err)
	}
	var request startupRequest
	if err := decodeExactJSON(payload, &request, requestFields); err != nil {
		return fmt.Errorf("decode startup capability request: %w", err)
	}
	if request.SchemaVersion != SchemaVersion || request.TransactionID != issuer.transaction || !noncePattern.MatchString(request.Nonce) {
		return errors.New("startup capability request binding is invalid")
	}
	journal, err := issuer.lease.Load()
	if err != nil {
		return fmt.Errorf("refresh helper-owned startup journal: %w", err)
	}
	if journal.TransactionID != issuer.transaction {
		return errors.New("helper-owned startup journal changed transaction")
	}
	if err := validateJournalBindings(journal, issuer.bindings); err != nil {
		return err
	}
	profile, paths, generation, managerSHA, err := participantForPhase(journal, issuer.bindings)
	if err != nil {
		return err
	}
	if err := verifyProcessExecutable(int(credentials.Pid), paths.StableBinary, managerSHA); err != nil {
		return fmt.Errorf("verify startup capability peer executable: %w", err)
	}
	issuedAt := issuer.clock().UTC()
	if issuedAt.After(deadline) {
		return context.DeadlineExceeded
	}
	expiresAt := issuedAt.Add(issuer.ttl)
	if deadline.Before(expiresAt) {
		expiresAt = deadline
	}
	snapshot := snapshotFromJournal(journal, profile, paths, generation, managerSHA, request.Nonce, issuedAt, expiresAt)
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	if len(encoded) > maxPacketBytes {
		return errors.New("startup capability snapshot exceeds its packet limit")
	}
	written, oobWritten, err := connection.WriteMsgUnix(encoded, nil, nil)
	if err != nil || written != len(encoded) || oobWritten != 0 {
		if err == nil {
			err = io.ErrShortWrite
		}
		return contextIOError(ctx, err)
	}
	return nil
}

func (issuer *Issuer) verifySocket() error {
	observed, err := inspectPath(issuer.procPath)
	if err != nil {
		return err
	}
	if observed != issuer.identity {
		return errors.New("startup capability socket identity changed")
	}
	return verifySocketIdentity(observed)
}

// Close removes only the socket inode created by this issuer.
func (issuer *Issuer) Close() error {
	if issuer == nil {
		return nil
	}
	issuer.mu.Lock()
	defer issuer.mu.Unlock()
	if issuer.closed {
		return nil
	}
	issuer.closed = true
	var errs []error
	if issuer.listener != nil {
		errs = append(errs, issuer.listener.Close())
	}
	if current, err := inspectPath(issuer.procPath); err == nil {
		if current != issuer.identity {
			errs = append(errs, errors.New("refusing to remove a replaced startup capability socket"))
		} else if err := syscall.Unlinkat(int(issuer.directory.Fd()), SocketBasename); err != nil && !errors.Is(err, syscall.ENOENT) {
			errs = append(errs, err)
		}
	} else if !os.IsNotExist(err) {
		errs = append(errs, err)
	}
	if issuer.directory != nil {
		errs = append(errs, issuer.directory.Close())
	}
	return errors.Join(errs...)
}

func participantForPhase(journal handoff.Journal, bindings Bindings) (identity.Profile, RuntimePaths, string, string, error) {
	switch journal.Phase {
	case handoff.PhaseDataRelocated, handoff.PhaseTargetStarted, handoff.PhaseTargetVerified, handoff.PhaseSourceRetired, handoff.PhaseTargetCommitPlanned:
		if journal.Status != handoff.StatusRunning || journal.DesiredOutcome != handoff.OutcomeForward {
			return identity.Profile{}, RuntimePaths{}, "", "", errors.New("target startup capability requires a running forward handoff")
		}
		return identity.TargetProfile(), bindings.Target, journal.Release.BridgeGeneration, journal.Release.TargetManagerSHA256, nil
	case handoff.PhaseDataRestored, handoff.PhaseSourceStarted:
		if journal.Status != handoff.StatusRecovering || journal.DesiredOutcome != handoff.OutcomeRollback {
			return identity.Profile{}, RuntimePaths{}, "", "", errors.New("source startup capability requires a recovering rollback handoff")
		}
		return identity.SourceProfile(), bindings.Source, journal.Release.PredecessorGeneration, journal.Source.StableSHA256, nil
	default:
		return identity.Profile{}, RuntimePaths{}, "", "", fmt.Errorf("handoff phase %s cannot issue a startup capability", journal.Phase)
	}
}

func snapshotFromJournal(journal handoff.Journal, profile identity.Profile, paths RuntimePaths, generation, managerSHA, nonce string, issuedAt, expiresAt time.Time) StartupSnapshot {
	configSHA256 := journal.Source.ConfigSHA256
	if profile == identity.TargetProfile() {
		configSHA256 = journal.Target.ConfigSHA256
	}
	return StartupSnapshot{
		SchemaVersion: SchemaVersion, TransactionID: journal.TransactionID, Revision: journal.Revision,
		BindingSHA256: journal.BindingSHA256, Nonce: nonce, ProfileID: profile.ProfileID,
		Status: journal.Status, Phase: journal.Phase, DesiredOutcome: journal.DesiredOutcome,
		Generation: generation, ManagerSHA256: managerSHA, StableBinary: paths.StableBinary,
		ConfigPath: paths.ConfigPath, ConfigSHA256: configSHA256, DataRoot: paths.DataRoot, StateRoot: paths.StateRoot,
		SocketPath: paths.SocketPath, ComposeProject: profile.ComposeProject, CoreNetwork: profile.CoreNetwork,
		IssuedAt: issuedAt, ExpiresAt: expiresAt,
	}
}

// RouteFromHelper obtains and consumes one helper snapshot. transactionDirectory
// locates only the authenticated channel; it is not a profile selector.
func (r *Router) RouteFromHelper(ctx context.Context, transactionDirectory string) (Decision, error) {
	if r == nil {
		return Decision{}, errors.New("startup router is unavailable")
	}
	transactionID := filepath.Base(transactionDirectory)
	if !transactionPattern.MatchString(transactionID) {
		return Decision{}, fmt.Errorf("%w: startup transaction id is invalid", ErrUnsafePath)
	}
	directory, err := openDirectoryNoFollow(transactionDirectory, true)
	if err != nil {
		return Decision{}, err
	}
	defer directory.Close()
	procPath := fmt.Sprintf("/proc/self/fd/%d/%s", directory.Fd(), SocketBasename)
	if err := requireCapabilityAbsent(directory, AbortSourceSocketBasename); err != nil {
		return Decision{}, err
	}
	before, err := inspectPath(procPath)
	if err != nil {
		return Decision{}, err
	}
	if err := verifySocketIdentity(before); err != nil {
		return Decision{}, err
	}
	dialer := net.Dialer{}
	raw, err := dialer.DialContext(ctx, "unixpacket", procPath)
	if err != nil {
		return Decision{}, contextIOError(ctx, err)
	}
	connection, ok := raw.(*net.UnixConn)
	if !ok {
		_ = raw.Close()
		return Decision{}, errors.New("startup capability did not create a Unix packet connection")
	}
	defer connection.Close()
	after, err := inspectPath(procPath)
	if err != nil || after != before {
		return Decision{}, errors.New("startup capability socket changed while connecting")
	}
	if _, err := peerCredentials(connection); err != nil {
		return Decision{}, err
	}
	now := r.clock().UTC()
	if err := setConnectionDeadline(connection, ctx, now.Add(MaximumTTL)); err != nil {
		return Decision{}, err
	}
	stopConnectionInterrupt := interruptOnCancel(ctx, func() error { return connection.SetDeadline(time.Now()) })
	defer stopConnectionInterrupt()
	nonce, err := randomNonce()
	if err != nil {
		return Decision{}, err
	}
	request := startupRequest{SchemaVersion: SchemaVersion, TransactionID: transactionID, Nonce: nonce}
	encoded, err := json.Marshal(request)
	if err != nil {
		return Decision{}, err
	}
	written, oobWritten, err := connection.WriteMsgUnix(encoded, nil, nil)
	if err != nil || written != len(encoded) || oobWritten != 0 {
		if err == nil {
			err = io.ErrShortWrite
		}
		return Decision{}, contextIOError(ctx, err)
	}
	payload, err := readPacket(connection)
	if err != nil {
		return Decision{}, contextIOError(ctx, err)
	}
	var snapshot StartupSnapshot
	if err := decodeExactJSON(payload, &snapshot, snapshotFields); err != nil {
		return Decision{}, fmt.Errorf("decode startup capability snapshot: %w", err)
	}
	decision, err := r.decisionFromSnapshot(snapshot, transactionID, nonce)
	if err != nil {
		return Decision{}, err
	}
	return decision, nil
}

func (r *Router) decisionFromSnapshot(snapshot StartupSnapshot, transactionID, nonce string) (Decision, error) {
	if snapshot.SchemaVersion != SchemaVersion || snapshot.TransactionID != transactionID || snapshot.Nonce != nonce ||
		!transactionPattern.MatchString(snapshot.TransactionID) || !noncePattern.MatchString(snapshot.Nonce) || snapshot.Revision == 0 ||
		!shaPattern.MatchString(snapshot.BindingSHA256) || !shaPattern.MatchString(snapshot.ManagerSHA256) ||
		!shaPattern.MatchString(snapshot.ConfigSHA256) || !commitPattern.MatchString(snapshot.Generation) {
		return Decision{}, errors.New("startup capability snapshot binding is invalid")
	}
	now := r.clock().UTC()
	if snapshot.IssuedAt.IsZero() || snapshot.ExpiresAt.IsZero() || snapshot.ExpiresAt.Before(snapshot.IssuedAt) ||
		snapshot.ExpiresAt.Sub(snapshot.IssuedAt) > MaximumTTL || now.Before(snapshot.IssuedAt) || !now.Before(snapshot.ExpiresAt) {
		return Decision{}, errors.New("startup capability snapshot is expired or has invalid timestamps")
	}
	profile, paths, err := expectedSnapshotParticipant(snapshot, r.bindings)
	if err != nil {
		return Decision{}, err
	}
	if snapshot.StableBinary != paths.StableBinary || snapshot.ConfigPath != paths.ConfigPath || snapshot.DataRoot != paths.DataRoot ||
		snapshot.StateRoot != paths.StateRoot || snapshot.SocketPath != paths.SocketPath ||
		snapshot.ComposeProject != profile.ComposeProject || snapshot.CoreNetwork != profile.CoreNetwork {
		return Decision{}, errors.New("startup capability snapshot differs from the resolved runtime binding")
	}
	if err := verifyProcessExecutable(r.pid(), paths.StableBinary, snapshot.ManagerSHA256); err != nil {
		return Decision{}, fmt.Errorf("verify startup Router executable: %w", err)
	}
	if err := verifyRuntimeLayout(paths); err != nil {
		return Decision{}, fmt.Errorf("verify startup Router layout: %w", err)
	}
	active := identity.SourceActiveProfile()
	if profile == identity.TargetProfile() {
		active, err = identity.ActivateVerifiedHandoffTarget(profile)
		if err != nil {
			return Decision{}, err
		}
	}
	copy := snapshot
	return Decision{
		ActiveProfile: active, Profile: profile, TransactionID: snapshot.TransactionID,
		Paths: paths, Revision: snapshot.Revision, BindingSHA256: snapshot.BindingSHA256,
		ConfigSHA256: snapshot.ConfigSHA256, Snapshot: &copy,
	}, nil
}

func expectedSnapshotParticipant(snapshot StartupSnapshot, bindings Bindings) (identity.Profile, RuntimePaths, error) {
	var profile identity.Profile
	switch snapshot.ProfileID {
	case identity.TargetProfile().ProfileID:
		if snapshot.Status != handoff.StatusRunning || snapshot.DesiredOutcome != handoff.OutcomeForward ||
			!phaseIs(snapshot.Phase, handoff.PhaseDataRelocated, handoff.PhaseTargetStarted, handoff.PhaseTargetVerified, handoff.PhaseSourceRetired, handoff.PhaseTargetCommitPlanned) {
			return identity.Profile{}, RuntimePaths{}, errors.New("target startup snapshot is outside the allowed forward phases")
		}
		profile = identity.TargetProfile()
	case identity.SourceProfile().ProfileID:
		if snapshot.Status != handoff.StatusRecovering || snapshot.DesiredOutcome != handoff.OutcomeRollback ||
			!phaseIs(snapshot.Phase, handoff.PhaseDataRestored, handoff.PhaseSourceStarted) {
			return identity.Profile{}, RuntimePaths{}, errors.New("source startup snapshot is outside the allowed rollback phases")
		}
		profile = identity.SourceProfile()
	default:
		return identity.Profile{}, RuntimePaths{}, errors.New("startup snapshot names an unknown profile")
	}
	paths := bindings.Source
	if profile == identity.TargetProfile() {
		paths = bindings.Target
	}
	if paths.StableBinary == "" {
		paths = RuntimePaths{
			StableBinary: snapshot.StableBinary,
			ConfigPath:   snapshot.ConfigPath,
			DataRoot:     snapshot.DataRoot,
			StateRoot:    snapshot.StateRoot,
			SocketPath:   snapshot.SocketPath,
		}
		if err := validateRuntimePaths("startup capability", profile, paths); err != nil {
			return identity.Profile{}, RuntimePaths{}, err
		}
	}
	return profile, paths, nil
}

func phaseIs(observed handoff.Phase, allowed ...handoff.Phase) bool {
	for _, candidate := range allowed {
		if observed == candidate {
			return true
		}
	}
	return false
}

func readPacket(connection *net.UnixConn) ([]byte, error) {
	payload := make([]byte, maxPacketBytes+1)
	oob := make([]byte, 1)
	count, oobCount, flags, _, err := connection.ReadMsgUnix(payload, oob)
	if err != nil {
		return nil, err
	}
	if count <= 0 || count > maxPacketBytes || oobCount != 0 || flags&(syscall.MSG_TRUNC|syscall.MSG_CTRUNC) != 0 {
		return nil, errors.New("startup capability packet is empty, truncated, oversized, or contains control data")
	}
	return append([]byte(nil), payload[:count]...), nil
}

func randomNonce() (string, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw[:]), nil
}

// prepareCapabilitySocket permits crash replay only for the same channel
// role. The helper's retained writer lease authenticates the caller of the
// enclosing constructor; a conflicting role is never guessed or removed.
func prepareCapabilitySocket(directory *os.File, basename, conflictingBasename string) error {
	if directory == nil || (basename != SocketBasename && basename != AbortSourceSocketBasename) ||
		(conflictingBasename != SocketBasename && conflictingBasename != AbortSourceSocketBasename) || basename == conflictingBasename {
		return errors.New("startup capability socket role is invalid")
	}
	if err := requireCapabilityAbsent(directory, conflictingBasename); err != nil {
		return err
	}
	path := fmt.Sprintf("/proc/self/fd/%d/%s", directory.Fd(), basename)
	before, err := inspectPath(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := verifySocketIdentity(before); err != nil {
		return err
	}
	connection, dialErr := net.DialTimeout("unixpacket", path, 100*time.Millisecond)
	if dialErr == nil {
		_ = connection.Close()
		return errors.New("startup capability socket already has a live owner")
	}
	if !errors.Is(dialErr, syscall.ECONNREFUSED) {
		return fmt.Errorf("probe existing startup capability socket: %w", dialErr)
	}
	after, err := inspectPath(path)
	if err != nil || after != before {
		return errors.New("startup capability socket changed during stale recovery")
	}
	if err := syscall.Unlinkat(int(directory.Fd()), basename); err != nil {
		return fmt.Errorf("remove stale startup capability socket: %w", err)
	}
	if err := syscall.Fsync(int(directory.Fd())); err != nil {
		return fmt.Errorf("sync stale startup capability removal: %w", err)
	}
	return nil
}

func requireCapabilityAbsent(directory *os.File, basename string) error {
	if directory == nil || (basename != SocketBasename && basename != AbortSourceSocketBasename) {
		return errors.New("startup capability socket role is invalid")
	}
	path := fmt.Sprintf("/proc/self/fd/%d/%s", directory.Fd(), basename)
	if _, err := os.Lstat(path); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return err
	}
	return errors.New("conflicting startup capability socket exists")
}

var requestFields = []string{"schema_version", "transaction_id", "nonce"}

var snapshotFields = []string{
	"schema_version", "transaction_id", "revision", "binding_sha256", "nonce", "profile_id", "status", "phase",
	"desired_outcome", "generation", "manager_sha256", "stable_binary", "config_path", "config_sha256", "data_root", "state_root",
	"socket_path", "compose_project", "core_network", "issued_at", "expires_at",
}
