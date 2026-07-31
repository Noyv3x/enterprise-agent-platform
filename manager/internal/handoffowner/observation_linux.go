//go:build linux

package handoffowner

import (
	"context"
	"errors"
	"fmt"
	"reflect"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

// ObserveSourceOwner produces the authoritative source_owner_ready evidence.
// It is valid only at a completely idle A2 source-owner boundary with no live
// handoff transaction.
func (c *Coordinator) ObserveSourceOwner(ctx context.Context, expectedGeneration, expectedManagerSHA256 string) (ReceiptObservation, error) {
	if !fullCommitPattern.MatchString(expectedGeneration) || !sha256Pattern.MatchString(expectedManagerSHA256) {
		return ReceiptObservation{}, errors.New("source-owner expected generation or Manager digest is invalid")
	}
	journals, runtimeObservation, err := c.observeReceiptBoundary(ctx)
	if err != nil {
		return ReceiptObservation{}, fmt.Errorf("observe source-owner ownership boundary: %w", err)
	}
	for _, journal := range journals {
		if !journal.Terminal() {
			return ReceiptObservation{}, errors.New("source-owner receipt requires no nonterminal handoff")
		}
	}
	if err := validateIdleRuntime(runtimeObservation, c.source, expectedGeneration, expectedManagerSHA256); err != nil {
		return ReceiptObservation{}, err
	}
	material := struct {
		SchemaVersion int                `json:"schema_version"`
		Capability    string             `json:"capability"`
		Status        string             `json:"status"`
		Runtime       RuntimeObservation `json:"runtime"`
	}{1, "source_owner", "idle", runtimeObservation}
	evidenceSHA256, err := digestJSON(material)
	if err != nil {
		return ReceiptObservation{}, fmt.Errorf("digest source-owner evidence: %w", err)
	}
	return ReceiptObservation{
		ObservedGeneration: runtimeObservation.Generation,
		ProfileID:          runtimeObservation.Profile.ProfileID,
		Capability:         "source_owner", Status: "idle",
		Architecture:   runtimeObservation.Architecture,
		ManagerSHA256:  runtimeObservation.ManagerSHA256,
		EvidenceSHA256: evidenceSHA256,
	}, nil
}

// ObserveTargetCommitted produces the authoritative
// target_handoff_committed evidence. It uniquely selects the terminal journal
// by the challenge-bound bridge generation and re-reads the live target
// process; callers cannot select an arbitrary historical transaction.
func (c *Coordinator) ObserveTargetCommitted(ctx context.Context, expectedGeneration, expectedManagerSHA256 string) (ReceiptObservation, error) {
	if !fullCommitPattern.MatchString(expectedGeneration) || !sha256Pattern.MatchString(expectedManagerSHA256) {
		return ReceiptObservation{}, errors.New("target-owner expected generation or Manager digest is invalid")
	}
	journals, runtimeObservation, err := c.observeReceiptBoundary(ctx)
	if err != nil {
		return ReceiptObservation{}, fmt.Errorf("observe target-owner ownership boundary: %w", err)
	}
	var journal handoff.Journal
	found := false
	for _, candidate := range journals {
		if !candidate.Terminal() {
			return ReceiptObservation{}, errors.New("target-owner receipt requires no nonterminal handoff")
		}
		if candidate.Status == handoff.StatusCommitted && candidate.Phase == handoff.PhaseCommitted &&
			candidate.Release.BridgeGeneration == expectedGeneration {
			if found {
				return ReceiptObservation{}, errors.New("multiple committed handoff transactions match the target generation")
			}
			journal = candidate
			found = true
		}
	}
	if !found {
		return ReceiptObservation{}, errors.New("a unique committed handoff transaction was not found for the target generation")
	}
	if err := c.validateJournalProfiles(journal); err != nil {
		return ReceiptObservation{}, err
	}
	if journal.Status != handoff.StatusCommitted || journal.Phase != handoff.PhaseCommitted || journal.TargetAck == nil || journal.TargetPlatformCommit == nil {
		return ReceiptObservation{}, errors.New("target-owner receipt requires a terminal committed handoff with target acknowledgement and Platform commit receipt")
	}
	if !historyHasPhase(journal, handoff.PhaseSourceRetired) {
		return ReceiptObservation{}, errors.New("target-owner receipt requires persisted source retirement")
	}
	if journal.Release.TargetManagerSHA256 != expectedManagerSHA256 {
		return ReceiptObservation{}, errors.New("committed handoff Manager digest does not match the target challenge")
	}
	if err := validateIdleRuntime(runtimeObservation, c.target, expectedGeneration, expectedManagerSHA256); err != nil {
		return ReceiptObservation{}, err
	}
	if journal.CompletedAt == nil || runtimeObservation.AuthenticatedChannelCheck.IsZero() ||
		!runtimeObservation.AuthenticatedChannelCheck.After(*journal.CompletedAt) {
		return ReceiptObservation{}, errors.New("target-owner receipt requires an authenticated channel check after the committed handoff")
	}
	material := struct {
		SchemaVersion  int                          `json:"schema_version"`
		Capability     string                       `json:"capability"`
		Status         string                       `json:"status"`
		TransactionID  string                       `json:"transaction_id"`
		Revision       uint64                       `json:"revision"`
		BindingSHA256  string                       `json:"binding_sha256"`
		CompletedAt    any                          `json:"completed_at"`
		TargetAck      handoff.TargetAck            `json:"target_ack"`
		PlatformCommit handoff.TargetPlatformCommit `json:"target_platform_commit"`
		Runtime        RuntimeObservation           `json:"runtime"`
	}{
		1, "target_owner", "committed", journal.TransactionID, journal.Revision,
		journal.BindingSHA256, journal.CompletedAt, *journal.TargetAck, *journal.TargetPlatformCommit, runtimeObservation,
	}
	evidenceSHA256, err := digestJSON(material)
	if err != nil {
		return ReceiptObservation{}, fmt.Errorf("digest target-owner evidence: %w", err)
	}
	return ReceiptObservation{
		ObservedGeneration: runtimeObservation.Generation,
		ProfileID:          runtimeObservation.Profile.ProfileID,
		Capability:         "target_owner", Status: "committed",
		Architecture:   runtimeObservation.Architecture,
		ManagerSHA256:  runtimeObservation.ManagerSHA256,
		EvidenceSHA256: evidenceSHA256,
	}, nil
}

func validateIdleRuntime(observation RuntimeObservation, profile identity.Profile, generation, managerSHA256 string) error {
	if !reflect.DeepEqual(observation.Profile, profile) {
		return errors.New("runtime technical profile does not match the expected receipt profile")
	}
	if observation.Generation != generation || observation.ManagerSHA256 != managerSHA256 {
		return errors.New("runtime generation or Manager digest does not match receipt expectations")
	}
	if observation.Architecture != "amd64" && observation.Architecture != "arm64" {
		return errors.New("runtime architecture is not supported by deployment receipts")
	}
	if !observation.Idle || observation.Maintenance || observation.ActiveOperationID != "" ||
		observation.FinalizePendingOperationID != "" || observation.CandidatePresent || observation.ActivationPresent ||
		observation.WatchdogCount != 0 || observation.ActiveExecutionCount != 0 {
		return errors.New("runtime is not at the receipt-grade idle ownership boundary")
	}
	return nil
}

func historyHasPhase(journal handoff.Journal, phase handoff.Phase) bool {
	for _, event := range journal.History {
		if event.Phase == phase {
			return true
		}
	}
	return false
}
