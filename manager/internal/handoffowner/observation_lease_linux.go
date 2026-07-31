//go:build linux

package handoffowner

import (
	"context"
	"errors"
	"fmt"
	"reflect"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
)

// observeReceiptBoundary freezes both handoff ownership and ordinary runtime
// admission across a double observation. Store.OpenObservation retains the
// exact root directory descriptor and uses openat plus the canonical journal
// decoder, so a pathname replacement cannot splice an unlocked journal tree
// into this evidence.
func (c *Coordinator) observeReceiptBoundary(ctx context.Context) ([]handoff.Journal, RuntimeObservation, error) {
	journalLease, before, err := c.store.OpenObservation()
	if err != nil {
		return nil, RuntimeObservation{}, err
	}
	defer journalLease.Close()
	for _, journal := range before {
		if err := c.validateJournalProfiles(journal); err != nil {
			return nil, RuntimeObservation{}, err
		}
	}

	// Lock order is handoff observation first, ordinary-operation admission
	// second. Concrete host code must not reacquire the handoff singleton.
	runtimeLease, err := c.host.AcquireRuntimeObservationLease(ctx)
	if err != nil {
		return nil, RuntimeObservation{}, fmt.Errorf("acquire runtime observation admission: %w", err)
	}
	observation, observeErr := runtimeLease.Observe(ctx)
	after, readErr := journalLease.Read()
	closeErr := runtimeLease.Close()
	if observeErr != nil || readErr != nil || closeErr != nil {
		return nil, RuntimeObservation{}, errors.Join(observeErr, readErr, closeErr)
	}
	if !reflect.DeepEqual(before, after) {
		return nil, RuntimeObservation{}, errors.New("handoff journals changed during the receipt observation lease")
	}
	return before, observation, nil
}
