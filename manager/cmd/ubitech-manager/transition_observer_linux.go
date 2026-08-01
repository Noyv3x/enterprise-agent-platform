//go:build linux

package main

import (
	"context"
	"errors"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/attestation"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffowner"
)

// receiptStateObserver is intentionally narrower than the coordinator. The
// control API can request a secret-free observation, but it can neither select
// a journal transaction nor access the deployment signing key.
type receiptStateObserver interface {
	ObserveSourceOwner(context.Context, string, string) (handoffowner.ReceiptObservation, error)
	ObserveTargetCommitted(context.Context, string, string) (handoffowner.ReceiptObservation, error)
}

type transitionObservationAdapter struct {
	owner         receiptStateObserver
	managerSHA256 string
}

func (adapter transitionObservationAdapter) ObserveTransition(ctx context.Context, challenge attestation.Challenge) (attestation.Observation, error) {
	if adapter.owner == nil || adapter.managerSHA256 == "" {
		return attestation.Observation{}, errors.New("release transition ownership observer is unavailable")
	}
	var (
		observed handoffowner.ReceiptObservation
		err      error
	)
	switch challenge.ReceiptType {
	case attestation.ReceiptSourceOwnerReady:
		observed, err = adapter.owner.ObserveSourceOwner(ctx, challenge.ExpectedObservedGeneration, adapter.managerSHA256)
	case attestation.ReceiptTargetHandoffCommitted:
		observed, err = adapter.owner.ObserveTargetCommitted(ctx, challenge.ExpectedObservedGeneration, adapter.managerSHA256)
	default:
		return attestation.Observation{}, errors.New("release transition receipt type is unsupported")
	}
	if err != nil {
		return attestation.Observation{}, err
	}
	return attestation.Observation{
		ObservedGeneration: observed.ObservedGeneration,
		ProfileID:          observed.ProfileID,
		Capability:         observed.Capability,
		Status:             observed.Status,
		ManagerSHA256:      observed.ManagerSHA256,
		EvidenceSHA256:     observed.EvidenceSHA256,
	}, nil
}
