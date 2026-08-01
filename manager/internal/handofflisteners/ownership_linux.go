//go:build linux

package handofflisteners

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"regexp"
	"syscall"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handofffd"
)

const (
	OwnershipSchemaVersion       = 1
	OwnershipControlPath         = "/v1/handoff/listener-ownership"
	MaximumOwnershipPayloadBytes = 4096
)

var (
	ownershipNoncePattern          = regexp.MustCompile(`^[0-9a-f]{64}$`)
	ErrOwnershipControlUnavailable = errors.New("participant ownership control socket is unavailable")
)

// OwnershipChallenge is sent over an authenticated, owner-only Manager
// control socket. The fresh nonce prevents a prior response from being used as
// current listener evidence.
type OwnershipChallenge struct {
	SchemaVersion int                          `json:"schema_version"`
	TransactionID string                       `json:"transaction_id"`
	Role          PublicOwner                  `json:"role"`
	Nonce         string                       `json:"nonce"`
	Listeners     []handofffd.ListenerIdentity `json:"listeners"`
}

// OwnershipProof is produced while the participant gateway controller holds
// its listener lock. Owns=false always carries an empty listener list; an
// owner must return the complete exact primary plus optional LAN set.
type OwnershipProof struct {
	SchemaVersion int                          `json:"schema_version"`
	TransactionID string                       `json:"transaction_id"`
	Role          PublicOwner                  `json:"role"`
	Nonce         string                       `json:"nonce"`
	Owns          bool                         `json:"owns"`
	Listeners     []handofffd.ListenerIdentity `json:"listeners"`
}

// OwnershipControlClient performs the token-authenticated request against the
// immutable source or target Manager control socket. Only a positively proven
// absent control endpoint may wrap ErrOwnershipControlUnavailable; HTTP,
// authentication, decoding, timeout, and identity errors must remain errors.
type OwnershipControlClient interface {
	Challenge(context.Context, handoff.Journal, PublicOwner, OwnershipChallenge) (OwnershipProof, error)
}

type OwnershipControlClientFunc func(context.Context, handoff.Journal, PublicOwner, OwnershipChallenge) (OwnershipProof, error)

func (function OwnershipControlClientFunc) Challenge(ctx context.Context, journal handoff.Journal, role PublicOwner, challenge OwnershipChallenge) (OwnershipProof, error) {
	return function(ctx, journal, role, challenge)
}

type Reachability string

const (
	ReachabilityRefused   Reachability = "refused"
	ReachabilityConnected Reachability = "connected"
	ReachabilityUnknown   Reachability = "unknown"
)

// PublicReachability is only a conservative fallback when a participant
// control process is absent. A connected public address is never an ownership
// proof; only a complete set of explicit ECONNREFUSED results can prove none.
type PublicReachability interface {
	Check(context.Context, handofffd.ListenerIdentity) (Reachability, error)
}

type PublicReachabilityFunc func(context.Context, handofffd.ListenerIdentity) (Reachability, error)

func (function PublicReachabilityFunc) Check(ctx context.Context, identity handofffd.ListenerIdentity) (Reachability, error) {
	return function(ctx, identity)
}

type TCPReachability struct {
	Timeout time.Duration
}

func (probe TCPReachability) Check(ctx context.Context, identity handofffd.ListenerIdentity) (Reachability, error) {
	address, err := netip.ParseAddrPort(identity.Address)
	if err != nil {
		return ReachabilityUnknown, errors.New("public reachability address is invalid")
	}
	dialAddress := address
	if address.Addr().IsUnspecified() {
		loopback := netip.MustParseAddr("127.0.0.1")
		if address.Addr().Is6() {
			loopback = netip.IPv6Loopback()
		}
		dialAddress = netip.AddrPortFrom(loopback, address.Port())
	}
	timeout := probe.Timeout
	if timeout <= 0 {
		timeout = 500 * time.Millisecond
	}
	connection, err := (&net.Dialer{Timeout: timeout}).DialContext(ctx, "tcp", dialAddress.String())
	if err == nil {
		_ = connection.Close()
		return ReachabilityConnected, nil
	}
	if ctx.Err() != nil {
		return ReachabilityUnknown, ctx.Err()
	}
	if errors.Is(err, syscall.ECONNREFUSED) {
		return ReachabilityRefused, nil
	}
	return ReachabilityUnknown, nil
}

type ClosedWorldProbeOptions struct {
	Control      OwnershipControlClient
	Reachability PublicReachability
	Random       io.Reader
}

// ClosedWorldOwnershipProbe classifies participants only from fresh
// authenticated control-socket statements. It reports none only after the
// entire expected public set explicitly refuses TCP connections.
type ClosedWorldOwnershipProbe struct {
	control      OwnershipControlClient
	reachability PublicReachability
	random       io.Reader
}

func NewClosedWorldOwnershipProbe(options ClosedWorldProbeOptions) (*ClosedWorldOwnershipProbe, error) {
	if options.Control == nil {
		return nil, errors.New("closed-world ownership probe requires a control client")
	}
	if options.Reachability == nil {
		options.Reachability = TCPReachability{}
	}
	if options.Random == nil {
		options.Random = rand.Reader
	}
	return &ClosedWorldOwnershipProbe{control: options.Control, reachability: options.Reachability, random: options.Random}, nil
}

func (probe *ClosedWorldOwnershipProbe) PublicOwner(ctx context.Context, journal handoff.Journal, expected []handofffd.ListenerIdentity) (PublicOwner, error) {
	if probe == nil || probe.control == nil || probe.reachability == nil || probe.random == nil {
		return OwnerUnknown, errors.New("closed-world ownership probe is unavailable")
	}
	if err := handoff.Validate(journal); err != nil {
		return OwnerUnknown, fmt.Errorf("validate ownership journal: %w", err)
	}
	expected, err := canonicalIdentities(expected)
	if err != nil {
		return OwnerUnknown, err
	}
	claims := make([]PublicOwner, 0, 1)
	for _, role := range []PublicOwner{OwnerSource, OwnerTarget} {
		challenge, err := newOwnershipChallenge(probe.random, journal.TransactionID, role, expected)
		if err != nil {
			return OwnerUnknown, err
		}
		proof, err := probe.control.Challenge(ctx, journal, role, challenge)
		if errors.Is(err, ErrOwnershipControlUnavailable) {
			// The control client may return this sentinel only after its endpoint
			// resolver has positively proved the journal-bound participant process
			// absent and the socket missing or refusing on the same inode. An absent
			// process cannot retain a descriptor, so this is an authoritative
			// non-owner result rather than an incomplete role set.
			continue
		}
		if err != nil {
			return OwnerUnknown, fmt.Errorf("challenge %s listener owner: %w", role, err)
		}
		if err := ValidateOwnershipProof(challenge, proof); err != nil {
			return OwnerUnknown, fmt.Errorf("validate %s listener owner proof: %w", role, err)
		}
		if proof.Owns {
			claims = append(claims, role)
		}
	}
	if len(claims) > 1 {
		return OwnerUnknown, nil
	}
	if len(claims) == 1 {
		return claims[0], nil
	}
	for _, identity := range expected {
		state, err := probe.reachability.Check(ctx, identity)
		if err != nil {
			return OwnerUnknown, fmt.Errorf("probe public listener %s reachability: %w", identity.Name, err)
		}
		if state != ReachabilityRefused {
			return OwnerUnknown, nil
		}
	}
	return OwnerNone, nil
}

func newOwnershipChallenge(random io.Reader, transactionID string, role PublicOwner, expected []handofffd.ListenerIdentity) (OwnershipChallenge, error) {
	if !transactionPattern.MatchString(transactionID) || (role != OwnerSource && role != OwnerTarget) {
		return OwnershipChallenge{}, errors.New("ownership challenge identity is invalid")
	}
	expected, err := canonicalIdentities(expected)
	if err != nil {
		return OwnershipChallenge{}, err
	}
	nonce := make([]byte, 32)
	if _, err := io.ReadFull(random, nonce); err != nil {
		return OwnershipChallenge{}, fmt.Errorf("generate ownership challenge nonce: %w", err)
	}
	return OwnershipChallenge{
		SchemaVersion: OwnershipSchemaVersion,
		TransactionID: transactionID,
		Role:          role,
		Nonce:         hex.EncodeToString(nonce),
		Listeners:     expected,
	}, nil
}

func ValidateOwnershipChallenge(challenge OwnershipChallenge) error {
	if challenge.SchemaVersion != OwnershipSchemaVersion || !transactionPattern.MatchString(challenge.TransactionID) ||
		(challenge.Role != OwnerSource && challenge.Role != OwnerTarget) || !ownershipNoncePattern.MatchString(challenge.Nonce) {
		return errors.New("ownership challenge identity is invalid")
	}
	canonical, err := canonicalIdentities(challenge.Listeners)
	if err != nil || !identitiesEqual(canonical, challenge.Listeners) {
		return errors.New("ownership challenge listener set is not canonical")
	}
	return nil
}

// BuildOwnershipProof must be called while the participant gateway controller
// lock is held. Passing nil listeners is the explicit waiting/not-owner state.
func BuildOwnershipProof(challenge OwnershipChallenge, role PublicOwner, listeners []handofffd.NamedListener) (OwnershipProof, error) {
	if err := ValidateOwnershipChallenge(challenge); err != nil {
		return OwnershipProof{}, err
	}
	if role != challenge.Role {
		return OwnershipProof{}, errors.New("ownership challenge targets another participant role")
	}
	proof := OwnershipProof{
		SchemaVersion: OwnershipSchemaVersion,
		TransactionID: challenge.TransactionID,
		Role:          role,
		Nonce:         challenge.Nonce,
		Listeners:     []handofffd.ListenerIdentity{},
	}
	if listeners == nil {
		return proof, nil
	}
	actual, err := handofffd.Describe(listeners)
	if err != nil || !identitiesEqual(actual, challenge.Listeners) {
		return OwnershipProof{}, errors.New("gateway listener set does not match the ownership challenge")
	}
	proof.Owns = true
	proof.Listeners = actual
	return proof, nil
}

func ValidateOwnershipProof(challenge OwnershipChallenge, proof OwnershipProof) error {
	if err := ValidateOwnershipChallenge(challenge); err != nil {
		return err
	}
	if proof.SchemaVersion != OwnershipSchemaVersion || proof.TransactionID != challenge.TransactionID ||
		proof.Role != challenge.Role || proof.Nonce != challenge.Nonce {
		return errors.New("ownership proof does not match its challenge")
	}
	if !proof.Owns {
		if proof.Listeners == nil || len(proof.Listeners) != 0 {
			return errors.New("non-owner proof must contain an explicit empty listener set")
		}
		return nil
	}
	canonical, err := canonicalIdentities(proof.Listeners)
	if err != nil || !identitiesEqual(canonical, proof.Listeners) || !identitiesEqual(canonical, challenge.Listeners) {
		return errors.New("owner proof does not contain the exact canonical listener set")
	}
	return nil
}

func EncodeOwnershipChallenge(challenge OwnershipChallenge) ([]byte, error) {
	if err := ValidateOwnershipChallenge(challenge); err != nil {
		return nil, err
	}
	return json.Marshal(challenge)
}

func DecodeOwnershipChallenge(payload []byte) (OwnershipChallenge, error) {
	var challenge OwnershipChallenge
	if err := decodeOwnershipObject(payload, &challenge); err != nil {
		return OwnershipChallenge{}, err
	}
	if err := ValidateOwnershipChallenge(challenge); err != nil {
		return OwnershipChallenge{}, err
	}
	return challenge, nil
}

func EncodeOwnershipProof(challenge OwnershipChallenge, proof OwnershipProof) ([]byte, error) {
	if err := ValidateOwnershipProof(challenge, proof); err != nil {
		return nil, err
	}
	return json.Marshal(proof)
}

func DecodeOwnershipProof(challenge OwnershipChallenge, payload []byte) (OwnershipProof, error) {
	var proof OwnershipProof
	if err := decodeOwnershipObject(payload, &proof); err != nil {
		return OwnershipProof{}, err
	}
	if err := ValidateOwnershipProof(challenge, proof); err != nil {
		return OwnershipProof{}, err
	}
	return proof, nil
}

func decodeOwnershipObject(payload []byte, target any) error {
	if len(payload) == 0 || len(payload) > MaximumOwnershipPayloadBytes {
		return errors.New("ownership message size is invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("decode ownership message: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("ownership message contains trailing JSON")
	}
	return nil
}

func canonicalIdentities(values []handofffd.ListenerIdentity) ([]handofffd.ListenerIdentity, error) {
	canonical, err := handofffd.ValidateIdentities(values)
	if err != nil {
		return nil, err
	}
	return canonical, nil
}
