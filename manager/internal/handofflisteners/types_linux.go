//go:build linux

// Package handofflisteners is the production listener-ownership layer for a
// namespace handoff. It deliberately keeps policy inputs injectable: the
// source/target configuration reader resolves the immutable addresses, the
// public-owner probe identifies the one live participant, and the coordinator
// proves that the helper still owns the global handoff lease.
package handofflisteners

import (
	"context"
	"errors"
	"net"
	"path/filepath"
	"regexp"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handofffd"
)

const (
	bindLockBasename = "public-listeners.bind.lock"
)

var transactionPattern = regexp.MustCompile(`^handoff_[0-9a-f]{32}$`)

type PublicOwner string

const (
	OwnerNone    PublicOwner = "none"
	OwnerSource  PublicOwner = "source"
	OwnerHelper  PublicOwner = "helper"
	OwnerTarget  PublicOwner = "target"
	OwnerUnknown PublicOwner = "unknown"
)

type ParticipantRole string

const (
	ParticipantTarget ParticipantRole = "target"
	ParticipantSource ParticipantRole = "source"
)

// ExpectedResolver returns the exact primary and optional LAN address set
// after verifying the relevant immutable config digest in journal. Returning
// values from an unverified ambient config is outside this contract.
type ExpectedResolver interface {
	ExpectedListeners(context.Context, handoff.Journal) ([]handofffd.ListenerIdentity, error)
}

type ExpectedResolverFunc func(context.Context, handoff.Journal) ([]handofffd.ListenerIdentity, error)

func (function ExpectedResolverFunc) ExpectedListeners(ctx context.Context, journal handoff.Journal) ([]handofffd.ListenerIdentity, error) {
	return function(ctx, journal)
}

// OwnershipProbe returns an owner only after proving the complete expected
// address set. Partial ownership and ambiguous reachability must be reported
// as OwnerUnknown or an error, never OwnerNone.
type OwnershipProbe interface {
	PublicOwner(context.Context, handoff.Journal, []handofffd.ListenerIdentity) (PublicOwner, error)
}

type OwnershipProbeFunc func(context.Context, handoff.Journal, []handofffd.ListenerIdentity) (PublicOwner, error)

func (function OwnershipProbeFunc) PublicOwner(ctx context.Context, journal handoff.Journal, expected []handofffd.ListenerIdentity) (PublicOwner, error) {
	return function(ctx, journal, expected)
}

// HelperAuthority is an optional supplemental verifier/fault-injection hook.
// The opaque handoff.StartupLease supplied to every ListenerDriver method is
// the mandatory production authority; this hook can only make a check stricter
// and can never replace or bypass that lease.
type HelperAuthority interface {
	VerifyHelperOwner(context.Context, handoff.Journal) error
}

type HelperAuthorityFunc func(context.Context, handoff.Journal) error

func (function HelperAuthorityFunc) VerifyHelperOwner(ctx context.Context, journal handoff.Journal) error {
	return function(ctx, journal)
}

type Rebinder interface {
	Rebind(context.Context, []handofffd.ListenerIdentity) ([]handofffd.NamedListener, error)
}

type RebinderFunc func(context.Context, []handofffd.ListenerIdentity) ([]handofffd.NamedListener, error)

func (function RebinderFunc) Rebind(ctx context.Context, expected []handofffd.ListenerIdentity) ([]handofffd.NamedListener, error) {
	return function(ctx, expected)
}

type HelperOptions struct {
	TransactionDirectory string
	TransactionID        string
	Expected             ExpectedResolver
	Probe                OwnershipProbe
	Authority            HelperAuthority
	Rebinder             Rebinder
}

type SourceSenderOptions struct {
	TransactionDirectory string
	TransactionID        string
	Expected             ExpectedResolver
	Probe                OwnershipProbe
}

type ParticipantOptions struct {
	TransactionDirectory string
	TransactionID        string
	Role                 ParticipantRole
	Expected             ExpectedResolver
}

func socketPath(transactionDirectory, transactionID string, basename string) (string, error) {
	if transactionDirectory == "" || !filepath.IsAbs(transactionDirectory) || filepath.Clean(transactionDirectory) != transactionDirectory {
		return "", errors.New("listener handoff transaction directory must be canonical and absolute")
	}
	if !transactionPattern.MatchString(transactionID) || filepath.Base(transactionDirectory) != transactionID {
		return "", errors.New("listener handoff transaction directory is not bound to its transaction id")
	}
	switch basename {
	case handofffd.SourceToHelperSocketBasename, handofffd.HelperToTargetSocketBasename, handofffd.HelperToSourceSocketBasename:
	default:
		return "", errors.New("listener handoff socket role is invalid")
	}
	// This is a logical identity only. handofffd opens the transaction
	// directory and binds/connects through /proc/self/fd/<dirfd>/<basename>, so
	// this path is never copied into sockaddr_un and may safely exceed 107
	// bytes.
	return filepath.Join(transactionDirectory, basename), nil
}

func identitiesEqual(left, right []handofffd.ListenerIdentity) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func describeExact(listeners []handofffd.NamedListener, expected []handofffd.ListenerIdentity) error {
	actual, err := handofffd.Describe(listeners)
	if err != nil {
		return err
	}
	if !identitiesEqual(actual, expected) {
		return errors.New("live listeners do not match the journal-bound address set")
	}
	return nil
}

func closeListeners(listeners []handofffd.NamedListener) error {
	var result error
	for _, named := range listeners {
		if named.Listener != nil {
			result = errors.Join(result, named.Listener.Close())
		}
	}
	return result
}

func listenerAddress(listener net.Listener) string {
	if listener == nil || listener.Addr() == nil {
		return ""
	}
	return listener.Addr().String()
}
