//go:build linux

package handofflisteners

import (
	"bytes"
	"context"
	"errors"
	"net"
	"strings"
	"testing"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handofffd"
)

type scriptedOwnershipClient struct {
	owners      map[PublicOwner]bool
	unavailable map[PublicOwner]bool
	mutate      func(PublicOwner, *OwnershipProof)
}

func (client scriptedOwnershipClient) Challenge(_ context.Context, _ handoff.Journal, role PublicOwner, challenge OwnershipChallenge) (OwnershipProof, error) {
	if client.unavailable[role] {
		return OwnershipProof{}, ErrOwnershipControlUnavailable
	}
	listeners := []handofffd.NamedListener(nil)
	if client.owners[role] {
		// The protocol client receives a typed proof from the role's control
		// socket. Construct its descriptor-independent equivalent here.
		proof := OwnershipProof{
			SchemaVersion: OwnershipSchemaVersion,
			TransactionID: challenge.TransactionID,
			Role:          role,
			Nonce:         challenge.Nonce,
			Owns:          true,
			Listeners:     append([]handofffd.ListenerIdentity(nil), challenge.Listeners...),
		}
		if client.mutate != nil {
			client.mutate(role, &proof)
		}
		return proof, nil
	}
	proof, err := BuildOwnershipProof(challenge, role, listeners)
	if client.mutate != nil {
		client.mutate(role, &proof)
	}
	return proof, err
}

func closedWorldProbe(t *testing.T, client OwnershipControlClient, reachability Reachability) *ClosedWorldOwnershipProbe {
	t.Helper()
	probe, err := NewClosedWorldOwnershipProbe(ClosedWorldProbeOptions{
		Control: client,
		Reachability: PublicReachabilityFunc(func(context.Context, handofffd.ListenerIdentity) (Reachability, error) {
			return reachability, nil
		}),
		Random: bytes.NewReader(bytes.Repeat([]byte{0x5a}, 256)),
	})
	if err != nil {
		t.Fatal(err)
	}
	return probe
}

func TestClosedWorldOwnershipTreatsProvenAbsentProcessAsNonOwner(t *testing.T) {
	journal := newJournal(t)
	expected := []handofffd.ListenerIdentity{{Name: "primary", Address: "127.0.0.1:18443"}}

	probe := closedWorldProbe(t, scriptedOwnershipClient{
		owners: map[PublicOwner]bool{OwnerSource: true},
	}, ReachabilityConnected)
	owner, err := probe.PublicOwner(context.Background(), journal, expected)
	if err != nil || owner != OwnerSource {
		t.Fatalf("authenticated source owner = %q, %v", owner, err)
	}

	for _, test := range []struct {
		name   string
		owner  PublicOwner
		absent PublicOwner
	}{
		{name: "source survives target absence", owner: OwnerSource, absent: OwnerTarget},
		{name: "target survives source retirement", owner: OwnerTarget, absent: OwnerSource},
	} {
		t.Run(test.name, func(t *testing.T) {
			probe := closedWorldProbe(t, scriptedOwnershipClient{
				owners:      map[PublicOwner]bool{test.owner: true},
				unavailable: map[PublicOwner]bool{test.absent: true},
			}, ReachabilityConnected)
			owner, err := probe.PublicOwner(context.Background(), journal, expected)
			if err != nil || owner != test.owner {
				t.Fatalf("owner with other process proven absent = %q, %v; want %q", owner, err, test.owner)
			}
		})
	}
}

func TestClosedWorldOwnershipReportsNoneOnlyWhenEveryAddressRefuses(t *testing.T) {
	journal := newJournal(t)
	expected := []handofffd.ListenerIdentity{
		{Name: "lan", Address: "127.0.0.1:18444"},
		{Name: "primary", Address: "127.0.0.1:18443"},
	}
	client := scriptedOwnershipClient{}
	owner, err := closedWorldProbe(t, client, ReachabilityRefused).PublicOwner(context.Background(), journal, expected)
	if err != nil || owner != OwnerNone {
		t.Fatalf("fully refused owner = %q, %v; want none", owner, err)
	}
	owner, err = closedWorldProbe(t, client, ReachabilityConnected).PublicOwner(context.Background(), journal, expected)
	if err != nil || owner != OwnerUnknown {
		t.Fatalf("unauthenticated connected owner = %q, %v; want unknown", owner, err)
	}
}

func TestClosedWorldOwnershipRejectsReplayedOrMalformedProof(t *testing.T) {
	journal := newJournal(t)
	expected := []handofffd.ListenerIdentity{{Name: "primary", Address: "127.0.0.1:18443"}}
	probe := closedWorldProbe(t, scriptedOwnershipClient{
		owners: map[PublicOwner]bool{OwnerSource: true},
		mutate: func(role PublicOwner, proof *OwnershipProof) {
			if role == OwnerSource {
				proof.Nonce = strings.Repeat("0", 64)
			}
		},
	}, ReachabilityRefused)
	owner, err := probe.PublicOwner(context.Background(), journal, expected)
	if err == nil || owner != OwnerUnknown || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("replayed proof = %q, %v", owner, err)
	}
}

func TestOwnershipMessagesAreClosedWorldAndGatewayProofIsExact(t *testing.T) {
	journal := newJournal(t)
	expected := []handofffd.ListenerIdentity{{Name: "primary", Address: "127.0.0.1:18443"}}
	challenge, err := newOwnershipChallenge(bytes.NewReader(bytes.Repeat([]byte{1}, 32)), journal.TransactionID, OwnerTarget, expected)
	if err != nil {
		t.Fatal(err)
	}
	waiting, err := BuildOwnershipProof(challenge, OwnerTarget, nil)
	if err != nil || waiting.Owns || waiting.Listeners == nil || len(waiting.Listeners) != 0 {
		t.Fatalf("waiting participant proof = %#v, %v", waiting, err)
	}
	payload, err := EncodeOwnershipChallenge(challenge)
	if err != nil {
		t.Fatal(err)
	}
	payload = append(payload[:len(payload)-1], []byte(`,"extra":true}`)...)
	if _, err := DecodeOwnershipChallenge(payload); err == nil {
		t.Fatal("ownership challenge accepted an unknown field")
	}
	bad := waiting
	bad.Listeners = nil
	if err := ValidateOwnershipProof(challenge, bad); err == nil {
		t.Fatal("non-owner proof accepted a null listener set")
	}
}

func TestTCPReachabilityDistinguishesRefusedFromConnected(t *testing.T) {
	listener := tcpListener(t)
	identity := handofffd.ListenerIdentity{Name: "primary", Address: listener.Addr().String()}
	probe := TCPReachability{}
	state, err := probe.Check(context.Background(), identity)
	if err != nil || state != ReachabilityConnected {
		t.Fatalf("live reachability = %q, %v", state, err)
	}
	if err := listener.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
		t.Fatal(err)
	}
	state, err = probe.Check(context.Background(), identity)
	if err != nil || state != ReachabilityRefused {
		t.Fatalf("closed reachability = %q, %v", state, err)
	}
}
