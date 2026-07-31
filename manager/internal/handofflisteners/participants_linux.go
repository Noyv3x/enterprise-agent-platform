//go:build linux

package handofflisteners

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sync"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handofffd"
)

// SourceSender duplicates the gateway controller's current listeners. The
// original source descriptors remain open until the helper acknowledgement.
type SourceSender struct {
	directory     string
	transactionID string
	expected      ExpectedResolver
	probe         OwnershipProbe
}

func NewSourceSender(options SourceSenderOptions) (*SourceSender, error) {
	if options.Expected == nil || options.Probe == nil {
		return nil, errors.New("source listener sender requires expected-address and ownership verifiers")
	}
	if _, err := socketPath(options.TransactionDirectory, options.TransactionID, handofffd.SourceToHelperSocketBasename); err != nil {
		return nil, err
	}
	return &SourceSender{directory: options.TransactionDirectory, transactionID: options.TransactionID, expected: options.Expected, probe: options.Probe}, nil
}

func (sender *SourceSender) SendCurrent(ctx context.Context, journal handoff.Journal, current []handofffd.NamedListener) error {
	if sender == nil || journal.TransactionID != sender.transactionID {
		return errors.New("source listener sender belongs to another transaction")
	}
	if err := handoff.Validate(journal); err != nil {
		return fmt.Errorf("validate source listener handoff journal: %w", err)
	}
	if journal.Phase != handoff.PhasePlanned && journal.Phase != handoff.PhaseHelperArmed {
		return fmt.Errorf("source cannot transfer public listeners in handoff phase %q", journal.Phase)
	}
	expected, err := sender.expected.ExpectedListeners(ctx, journal)
	if err != nil {
		return err
	}
	expected, err = handofffd.ValidateIdentities(expected)
	if err != nil {
		return err
	}
	if err := describeExact(current, expected); err != nil {
		return fmt.Errorf("validate current gateway listeners: %w", err)
	}
	owner, err := sender.probe.PublicOwner(ctx, journal, expected)
	if err != nil || owner != OwnerSource {
		return errors.New("source gateway was not proven to own the current public listeners")
	}
	path, err := socketPath(sender.directory, sender.transactionID, handofffd.SourceToHelperSocketBasename)
	if err != nil {
		return err
	}
	if err := handofffd.SendAt(ctx, sender.directory, filepath.Base(path), journal.TransactionID, current); err != nil {
		return fmt.Errorf("send current source listeners to helper: %w", err)
	}
	return nil
}

// ParticipantReceiver is created by a startup-routed target or rollback
// source before it performs any public gateway side effect. Its socket role is
// permanent and cannot collide with either of the other two directions.
type ParticipantReceiver struct {
	directory     string
	transactionID string
	role          ParticipantRole
	expected      ExpectedResolver

	mu       sync.Mutex
	receiver *handofffd.Receiver
	closed   bool
}

func OpenParticipantReceiver(options ParticipantOptions) (*ParticipantReceiver, error) {
	if options.Expected == nil {
		return nil, errors.New("listener participant requires an expected-address verifier")
	}
	basename := ""
	switch options.Role {
	case ParticipantTarget:
		basename = handofffd.HelperToTargetSocketBasename
	case ParticipantSource:
		basename = handofffd.HelperToSourceSocketBasename
	default:
		return nil, errors.New("listener participant role is invalid")
	}
	path, err := socketPath(options.TransactionDirectory, options.TransactionID, basename)
	if err != nil {
		return nil, err
	}
	receiver, err := handofffd.ListenAtRecovering(options.TransactionDirectory, filepath.Base(path))
	if err != nil {
		return nil, fmt.Errorf("open %s listener receiver: %w", options.Role, err)
	}
	return &ParticipantReceiver{
		directory: options.TransactionDirectory, transactionID: options.TransactionID,
		role: options.Role, expected: options.Expected, receiver: receiver,
	}, nil
}

func (participant *ParticipantReceiver) Receive(ctx context.Context, journal handoff.Journal) ([]handofffd.NamedListener, error) {
	return participant.receive(ctx, journal, nil)
}

// ReceiveAndAdopt is the production participant boundary. It validates the
// complete descriptor set, invokes adopt while the gateway controller holds
// its own ownership lock, and acknowledges the helper only after adoption
// succeeds. ErrPostAdoptionAcknowledgement means the gateway must stay live
// while the helper reconciles the authenticated owner proof.
func (participant *ParticipantReceiver) ReceiveAndAdopt(ctx context.Context, journal handoff.Journal, adopt func([]handofffd.NamedListener) error) error {
	if adopt == nil {
		return errors.New("listener participant adoption callback is required")
	}
	_, err := participant.receive(ctx, journal, adopt)
	return err
}

func (participant *ParticipantReceiver) receive(ctx context.Context, journal handoff.Journal, adopt func([]handofffd.NamedListener) error) ([]handofffd.NamedListener, error) {
	participant.mu.Lock()
	defer participant.mu.Unlock()
	if participant == nil || participant.closed || participant.receiver == nil {
		return nil, errors.New("listener participant receiver is closed")
	}
	if journal.TransactionID != participant.transactionID {
		return nil, errors.New("listener participant journal belongs to another transaction")
	}
	if err := handoff.Validate(journal); err != nil {
		return nil, fmt.Errorf("validate participant listener handoff journal: %w", err)
	}
	if !participant.phaseAllowed(journal.Phase) {
		return nil, fmt.Errorf("%s cannot receive public listeners from handoff phase %q", participant.role, journal.Phase)
	}
	expected, err := participant.expected.ExpectedListeners(ctx, journal)
	if err != nil {
		return nil, err
	}
	expected, err = handofffd.ValidateIdentities(expected)
	if err != nil {
		return nil, err
	}
	var listeners []handofffd.NamedListener
	if adopt == nil {
		listeners, err = participant.receiver.AcceptExact(ctx, journal.TransactionID, expected)
	} else {
		listeners, err = participant.receiver.AcceptExactWithAdoption(ctx, journal.TransactionID, expected, adopt)
	}
	if err != nil {
		if errors.Is(err, handofffd.ErrPostAdoptionAcknowledgement) {
			closeErr := participant.receiver.Close()
			participant.receiver = nil
			participant.closed = true
			return listeners, errors.Join(err, closeErr)
		}
		return nil, fmt.Errorf("receive %s public listeners: %w", participant.role, err)
	}
	if err := participant.receiver.Close(); err != nil {
		_ = closeListeners(listeners)
		return nil, fmt.Errorf("retire %s listener receiver: %w", participant.role, err)
	}
	participant.receiver = nil
	participant.closed = true
	return listeners, nil
}

func (participant *ParticipantReceiver) phaseAllowed(phase handoff.Phase) bool {
	if participant.role == ParticipantTarget {
		switch phase {
		case handoff.PhaseDataRelocated, handoff.PhaseTargetStarted, handoff.PhaseTargetVerified,
			handoff.PhaseSourceRetired, handoff.PhaseTargetCommitPlanned:
			return true
		}
		return false
	}
	return sourceListenerReceivePhase(phase)
}

func sourceListenerReceivePhase(phase handoff.Phase) bool {
	switch phase {
	case handoff.PhasePlanned, handoff.PhaseHelperArmed, handoff.PhaseAdmissionReserved,
		handoff.PhaseWritersStopped, handoff.PhaseSnapshotReady,
		handoff.PhaseDataRestored, handoff.PhaseSourceStarted:
		return true
	default:
		return false
	}
}

func (participant *ParticipantReceiver) Close() error {
	if participant == nil {
		return nil
	}
	participant.mu.Lock()
	defer participant.mu.Unlock()
	if participant.closed {
		return nil
	}
	participant.closed = true
	if participant.receiver == nil {
		return nil
	}
	err := participant.receiver.Close()
	participant.receiver = nil
	return err
}
