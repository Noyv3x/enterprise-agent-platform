package journal

import (
	"encoding/json"
	"errors"
	"os"
	"syscall"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
)

type checkpoint struct {
	SchemaVersion int                        `json:"schema_version"`
	State         model.ManagerState         `json:"state"`
	Operations    map[string]model.Operation `json:"operations"`
}

func (s *Store) reconcileUncertainStateLocked() error {
	if !s.stateUncertain {
		return nil
	}
	return s.loadCheckpointLocked()
}

func (s *Store) reconcileAdmissionLocked() error {
	return s.reconcileUncertainStateLocked()
}

func (s *Store) loadCheckpointLocked() error {
	info, err := os.Lstat(s.checkpointPath)
	if err != nil {
		return err
	}
	if !privateRegular(info) {
		return errors.New("update checkpoint must be an owner-only regular file")
	}
	var value struct {
		checkpoint
		BridgeTransition json.RawMessage `json:"bridge_transition"`
	}
	if err := atomicfile.ReadJSONWithLimit(s.checkpointPath, &value, info.Size()); err != nil {
		return err
	}
	if len(value.BridgeTransition) != 0 {
		return errors.New("provisional bridge checkpoints are unsupported")
	}
	if value.SchemaVersion != 1 || value.State.SchemaVersion != 1 || value.Operations == nil {
		return errors.New("unsupported update checkpoint schema")
	}
	if value.State.ActiveOperationID != "" && value.State.FinalizePendingOperationID != "" {
		return errors.New("overlapping checkpoint operation owners")
	}
	for id, op := range value.Operations {
		if !validID(id) || op.ID != id || op.SchemaVersion != 1 {
			return errors.New("invalid checkpoint operation identity")
		}
		if op.Status != model.OperationPending && op.Status != model.OperationRunning && op.Status != model.OperationSucceeded && op.Status != model.OperationFailed {
			return errors.New("unknown checkpoint operation status")
		}
		if (op.Status == model.OperationPending || op.Status == model.OperationRunning || !op.Finalized) && id != value.State.ActiveOperationID && id != value.State.FinalizePendingOperationID {
			return errors.New("checkpoint has an unowned unfinished operation")
		}
	}
	for _, id := range []string{value.State.ActiveOperationID, value.State.FinalizePendingOperationID} {
		if id != "" {
			if _, ok := value.Operations[id]; !ok {
				return errors.New("checkpoint operation owner is missing")
			}
		}
	}
	s.state, s.records, s.stateUncertain = value.State, value.Operations, false
	return nil
}

func privateRegular(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Geteuid()) && info.Mode().IsRegular() && info.Mode().Perm() == 0o600
}
