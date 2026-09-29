package operation

import (
	"context"
	"fmt"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/maintenance"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
)

// Retain runs only between transactions under the same admission lock used to
// publish them. It never removes Docker images or independent sandbox state.
func (o *Orchestrator) Retain(ctx context.Context) error {
	unlock, err := o.lockMaintenanceAdmission(ctx)
	if err != nil {
		return err
	}
	defer unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	state := o.Store.State()
	if state.Current == nil || state.PublicState != model.StateIdle || state.Maintenance ||
		state.Candidate != nil || state.ActiveOperationID != "" || state.FinalizePendingOperationID != "" {
		return nil
	}
	unfinished, err := o.Store.UnfinishedOperations()
	if err != nil {
		return err
	}
	if len(unfinished) != 0 {
		return nil
	}
	policy := maintenance.ReleasePolicy{
		Root: o.ReleasesDir, Channel: o.Channel, Profile: o.TechnicalProfile,
		CurrentID: state.Current.ID,
	}
	protected := make(map[string]struct{}, 2)
	for _, generation := range []*model.Generation{state.Current, state.Previous} {
		if generation != nil && generation.RollbackSnapshotPath != "" {
			protected[generation.RollbackSnapshotPath] = struct{}{}
		}
	}
	if state.Previous != nil {
		policy.PreviousID = state.Previous.ID
	}
	if _, err := maintenance.PruneReleases(ctx, policy); err != nil {
		return fmt.Errorf("retain committed releases: %w", err)
	}
	if snapshots, ok := o.Snapshots.(interface {
		Prune(context.Context, time.Time, map[string]struct{}) (int, error)
	}); ok {
		if _, err := snapshots.Prune(ctx, o.now(), protected); err != nil {
			return fmt.Errorf("retain rollback snapshots: %w", err)
		}
	}
	return nil
}
