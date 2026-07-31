//go:build linux

package main

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/attestation"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffowner"
)

type fakeReceiptStateObserver struct {
	sourceCalls int
	targetCalls int
	generation  string
	digest      string
	result      handoffowner.ReceiptObservation
	err         error
}

func (observer *fakeReceiptStateObserver) ObserveSourceOwner(_ context.Context, generation, digest string) (handoffowner.ReceiptObservation, error) {
	observer.sourceCalls++
	observer.generation, observer.digest = generation, digest
	return observer.result, observer.err
}

func (observer *fakeReceiptStateObserver) ObserveTargetCommitted(_ context.Context, generation, digest string) (handoffowner.ReceiptObservation, error) {
	observer.targetCalls++
	observer.generation, observer.digest = generation, digest
	return observer.result, observer.err
}

func TestTransitionObservationAdapterRoutesOnlyChallengeReceiptType(t *testing.T) {
	digest := strings.Repeat("a", 64)
	generation := strings.Repeat("b", 40)
	owner := &fakeReceiptStateObserver{result: handoffowner.ReceiptObservation{
		ObservedGeneration: generation,
		ProfileID:          "agent-platform-v1",
		Capability:         "target_owner",
		Status:             "committed",
		ManagerSHA256:      digest,
		EvidenceSHA256:     strings.Repeat("c", 64),
	}}
	adapter := transitionObservationAdapter{owner: owner, managerSHA256: digest}
	observation, err := adapter.ObserveTransition(context.Background(), attestation.Challenge{
		ReceiptType:                attestation.ReceiptTargetHandoffCommitted,
		ExpectedObservedGeneration: generation,
	})
	if err != nil {
		t.Fatal(err)
	}
	if owner.sourceCalls != 0 || owner.targetCalls != 1 || owner.generation != generation || owner.digest != digest {
		t.Fatalf("unexpected owner routing: %#v", owner)
	}
	if observation.ObservedGeneration != generation || observation.ManagerSHA256 != digest || observation.EvidenceSHA256 != owner.result.EvidenceSHA256 {
		t.Fatalf("unexpected observation projection: %#v", observation)
	}
}

func TestTransitionObservationAdapterRejectsUnknownAndUnavailableOwner(t *testing.T) {
	adapter := transitionObservationAdapter{owner: &fakeReceiptStateObserver{}, managerSHA256: strings.Repeat("a", 64)}
	if _, err := adapter.ObserveTransition(context.Background(), attestation.Challenge{ReceiptType: "other"}); err == nil {
		t.Fatal("unknown receipt type was accepted")
	}
	adapter.owner = nil
	if _, err := adapter.ObserveTransition(context.Background(), attestation.Challenge{ReceiptType: attestation.ReceiptSourceOwnerReady}); err == nil {
		t.Fatal("missing owner was accepted")
	}
	owner := &fakeReceiptStateObserver{err: errors.New("not idle")}
	adapter = transitionObservationAdapter{owner: owner, managerSHA256: strings.Repeat("a", 64)}
	if _, err := adapter.ObserveTransition(context.Background(), attestation.Challenge{ReceiptType: attestation.ReceiptSourceOwnerReady}); !errors.Is(err, owner.err) {
		t.Fatalf("owner error = %v", err)
	}
}
