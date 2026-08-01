//go:build linux

package main

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/config"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handofffd"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handofflisteners"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffsource"
)

type journalListenerResolver struct {
	config *config.Manager
}

func (resolver journalListenerResolver) ExpectedListeners(_ context.Context, journal handoff.Journal) ([]handofffd.ListenerIdentity, error) {
	if resolver.config == nil {
		return nil, errors.New("source listener configuration is unavailable")
	}
	cfg := resolver.config.Config()
	if cfg.ConfigPath != journal.Source.ConfigPath {
		return nil, errors.New("source listener configuration path differs from the handoff journal")
	}
	digest, err := secureConfigSHA256(cfg.ConfigPath)
	if err != nil {
		return nil, fmt.Errorf("verify source listener configuration: %w", err)
	}
	if digest != journal.Source.ConfigSHA256 {
		return nil, errors.New("source listener configuration changed after handoff planning")
	}
	values := []handofffd.ListenerIdentity{{Name: "primary", Address: cfg.GatewayAddress}}
	if cfg.LANEnabled {
		values = append(values, handofffd.ListenerIdentity{Name: "lan", Address: cfg.LANAddress})
	}
	return handofffd.ValidateIdentities(values)
}

type sourceTransferOwnershipProbe struct {
	gateway *gatewayController
	units   handoffsource.UnitInspector
}

func (probe sourceTransferOwnershipProbe) PublicOwner(ctx context.Context, journal handoff.Journal, expected []handofffd.ListenerIdentity) (handofflisteners.PublicOwner, error) {
	if probe.gateway == nil || probe.units == nil {
		return handofflisteners.OwnerUnknown, errors.New("source listener ownership proof is unavailable")
	}
	state, err := probe.units.Show(ctx, journal.Target.Unit)
	if err != nil {
		return handofflisteners.OwnerUnknown, fmt.Errorf("prove target Manager absence before source transfer: %w", err)
	}
	if state.LoadState != "not-found" || state.ActiveState == "active" || state.MainPID != 0 || state.FragmentPath != "" {
		return handofflisteners.OwnerUnknown, errors.New("target Manager appeared before source listener transfer")
	}
	listeners, err := probe.gateway.CurrentHandoffListeners()
	if err != nil {
		return handofflisteners.OwnerUnknown, err
	}
	actual, err := handofffd.Describe(listeners)
	if err != nil {
		return handofflisteners.OwnerUnknown, err
	}
	canonical, err := handofffd.ValidateIdentities(expected)
	if err != nil {
		return handofflisteners.OwnerUnknown, err
	}
	if len(actual) != len(canonical) {
		return handofflisteners.OwnerUnknown, errors.New("source gateway listener set differs from the journal")
	}
	for index := range actual {
		if actual[index] != canonical[index] {
			return handofflisteners.OwnerUnknown, errors.New("source gateway listener identity differs from the journal")
		}
	}
	return handofflisteners.OwnerSource, nil
}

type sourceListenerHandoff struct {
	gateway  *gatewayController
	expected handofflisteners.ExpectedResolver
	probe    handofflisteners.OwnershipProbe
	ctx      context.Context
	cancel   context.CancelFunc

	mu      sync.Mutex
	started map[string]struct{}
	wait    sync.WaitGroup
}

func newSourceListenerHandoff(gateway *gatewayController, configs *config.Manager) (*sourceListenerHandoff, error) {
	if gateway == nil || configs == nil {
		return nil, errors.New("source listener handoff dependencies are incomplete")
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &sourceListenerHandoff{
		gateway: gateway, expected: journalListenerResolver{config: configs},
		probe: sourceTransferOwnershipProbe{gateway: gateway, units: handoffsource.SystemdCLI{}},
		ctx:   ctx, cancel: cancel, started: map[string]struct{}{},
	}, nil
}

// Start is invoked immediately after Coordinator.Begin has synchronously
// armed the persistent helper. It creates the return receiver before starting
// the blocking source-to-helper transfer, so every pre-fence abort has a live
// route back to the same gateway process.
func (transfer *sourceListenerHandoff) Start(_ context.Context, journal handoff.Journal) error {
	if transfer == nil {
		return errors.New("source listener handoff is unavailable")
	}
	if err := transfer.gateway.ConfigureHandoffParticipant(journal, handofflisteners.OwnerSource); err != nil {
		return err
	}
	transfer.mu.Lock()
	if _, exists := transfer.started[journal.TransactionID]; exists {
		transfer.mu.Unlock()
		return nil
	}
	receiver, err := handofflisteners.OpenParticipantReceiver(handofflisteners.ParticipantOptions{
		TransactionDirectory: transferDirectory(transfer.gateway.app, journal), TransactionID: journal.TransactionID,
		Role: handofflisteners.ParticipantSource, Expected: transfer.expected,
	})
	if err != nil {
		transfer.mu.Unlock()
		return fmt.Errorf("open source listener return boundary: %w", err)
	}
	sender, err := handofflisteners.NewSourceSender(handofflisteners.SourceSenderOptions{
		TransactionDirectory: transferDirectory(transfer.gateway.app, journal), TransactionID: journal.TransactionID,
		Expected: transfer.expected, Probe: transfer.probe,
	})
	if err != nil {
		_ = receiver.Close()
		transfer.mu.Unlock()
		return err
	}
	transfer.started[journal.TransactionID] = struct{}{}
	transfer.wait.Add(1)
	transfer.mu.Unlock()

	go transfer.run(journal, sender, receiver)
	return nil
}

func (transfer *sourceListenerHandoff) run(journal handoff.Journal, sender *handofflisteners.SourceSender, receiver *handofflisteners.ParticipantReceiver) {
	defer transfer.wait.Done()
	defer receiver.Close()

	for {
		listeners, err := transfer.gateway.CurrentHandoffListeners()
		if err == nil {
			err = sender.SendCurrent(transfer.ctx, journal, listeners)
		}
		if err == nil {
			if err := transfer.gateway.RelinquishHandoffListeners(); err == nil {
				break
			}
		}
		if !waitHandoffRetry(transfer.ctx) {
			return
		}
	}

	for {
		err := receiver.ReceiveAndAdopt(transfer.ctx, journal, transfer.gateway.AdoptHandoffListeners)
		if err == nil || errors.Is(err, handofffd.ErrPostAdoptionAcknowledgement) {
			// Adoption is already durable in the running gateway. ACK uncertainty
			// is reconciled by the helper's authenticated owner proof.
			return
		}
		if !waitHandoffRetry(transfer.ctx) {
			return
		}
	}
}

func waitHandoffRetry(ctx context.Context) bool {
	timer := time.NewTimer(100 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func (transfer *sourceListenerHandoff) Close() {
	if transfer == nil {
		return
	}
	transfer.cancel()
	transfer.wait.Wait()
}

func transferDirectory(app *application, journal handoff.Journal) string {
	return filepath.Join(app.handoffStore.Root(), journal.TransactionID)
}

func secureConfigSHA256(path string) (string, error) {
	return secureStartupConfigSnapshotSHA256(path)
}
