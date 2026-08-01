//go:build linux

package handoffhelper

import (
	"context"
	"errors"
	"fmt"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffstartup"
)

type startupResult struct {
	owner string
	err   error
}

func (driver *Driver) startParticipant(ctx context.Context, journal handoff.Journal, lease handoff.StartupLease, role ParticipantRole, phases ...handoff.Phase) error {
	operation, _, _, err := driver.authorize(ctx, journal, phases...)
	if err != nil {
		return err
	}
	locked, err := lease.Load()
	if err != nil {
		return fmt.Errorf("read helper startup lease: %w", err)
	}
	if locked.TransactionID != journal.TransactionID || locked.Revision != journal.Revision || locked.BindingSHA256 != journal.BindingSHA256 {
		return errors.New("helper startup lease differs from the coordinator journal")
	}
	capabilityPath, err := handoffstartup.CapabilitySocketPath(driver.transactionDirectory)
	if err != nil {
		return err
	}
	unit, stable := journal.Target.Unit, journal.Target.StableBinary
	if role == ParticipantSource {
		unit, stable = journal.Source.Unit, journal.Source.StableBinary
	}
	request := StartRequest{
		Operation: operation, Role: role, Unit: unit, StableBinary: stable,
		TransactionDirectory: driver.transactionDirectory, CapabilitySocketPath: capabilityPath,
	}
	alreadyStarted, err := driver.participants.InspectStarted(ctx, request)
	if err != nil {
		return fmt.Errorf("inspect %s startup replay boundary: %w", role, err)
	}
	if alreadyStarted {
		if err := driver.participants.ReconcileStarted(ctx, request); err != nil {
			return fmt.Errorf("reconcile existing %s startup: %w", role, err)
		}
		if _, _, _, err := driver.authorize(ctx, journal, phases...); err != nil {
			return fmt.Errorf("helper ownership changed after proving existing %s startup: %w", role, err)
		}
		return nil
	}
	issuer, err := driver.issuerFactory.New(handoffstartup.IssuerOptions{
		Lease: lease, TransactionDirectory: driver.transactionDirectory, Bindings: driver.bindings,
	})
	if err != nil {
		return fmt.Errorf("create %s startup issuer: %w", role, err)
	}

	childCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	results := make(chan startupResult, 2)
	go func() { results <- startupResult{owner: "issuer", err: issuer.Serve(childCtx)} }()
	go func() {
		results <- startupResult{owner: "participant", err: driver.participants.Start(childCtx, request)}
	}()

	var resultErr error
	for completed := 0; completed < 2; completed++ {
		result := <-results
		if result.err != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("%s %s startup: %w", role, result.owner, result.err))
			cancel()
			resultErr = errors.Join(resultErr, issuer.Close())
		}
	}
	resultErr = errors.Join(resultErr, issuer.Close())
	if resultErr != nil {
		return resultErr
	}
	if _, _, _, err := driver.authorize(ctx, journal, phases...); err != nil {
		return fmt.Errorf("helper ownership changed after %s startup: %w", role, err)
	}
	return nil
}
