package journal

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
)

type checkpoint struct {
	SchemaVersion int                        `json:"schema_version"`
	State         model.ManagerState         `json:"state"`
	Operations    map[string]model.Operation `json:"operations"`
	Transition    *bridgeTransition          `json:"bridge_transition,omitempty"`
}

// A pre-confirmation import belongs to one exact N installing operation.
// N can still restore its own journals after rejecting this child.
type bridgeTransition struct {
	Target       string `json:"target"`
	OperationID  string `json:"operation_id"`
	SourceSHA256 string `json:"source_sha256"`
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
	var value checkpoint
	if err := atomicfile.ReadJSONWithLimit(s.checkpointPath, &value, info.Size()); err != nil {
		return err
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
	s.transition = value.Transition
	return nil
}

func (s *Store) importBridgeLocked(target string) error {
	statePath := filepath.Join(s.dir, "state.json")
	if info, err := os.Lstat(statePath); err == nil && !privateRegular(info) {
		return errors.New("bridge state must be an owner-only regular file")
	} else if err != nil && !os.IsNotExist(err) {
		return err
	}
	err := atomicfile.ReadJSON(statePath, &s.state)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	hasState := err == nil
	if s.state.SchemaVersion != 1 {
		return errors.New("unsupported bridge state schema")
	}
	entries, err := os.ReadDir(filepath.Join(s.dir, "operations"))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	for _, entry := range entries {
		if !hasState {
			return errors.New("bridge operations exist without state")
		}
		if entry.Type()&os.ModeSymlink != 0 || entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			return errors.New("uncertain bridge journal entry; settle with release N before upgrading")
		}
		id := strings.TrimSuffix(entry.Name(), ".json")
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !privateRegular(info) {
			return errors.New("bridge operation must be an owner-only regular file")
		}
		var op model.Operation
		if err := atomicfile.ReadJSON(filepath.Join(s.dir, "operations", entry.Name()), &op); err != nil {
			return err
		}
		if !validID(id) || op.ID != id || op.SchemaVersion != 1 {
			return errors.New("invalid bridge operation identity")
		}
		settled := (op.Status == model.OperationSucceeded || op.Status == model.OperationFailed) && op.Finalized
		transition := target != "" && s.state.ActiveOperationID == "" && s.state.FinalizePendingOperationID == id && s.state.Candidate == nil && s.state.Maintenance && s.state.Current != nil && s.state.Current.ID == target && s.state.Current.SourceCommit == target && s.state.Previous != nil && s.state.Previous.ID != target && op.Kind == model.OperationUpdate && op.Status == model.OperationSucceeded && !op.Finalized && op.CompletedAt != nil && op.TargetGeneration == target && op.ReservationStatus == model.ReservationMutationStarted && op.SnapshotPath != "" && !op.PreparedCleanupPending && !op.ManagerActivationRollback && op.GateSettlementAction == ""
		transition = transition && s.state.Current.RollbackSnapshotPath == op.SnapshotPath && !op.SnapshotRestored && !op.ReservationReleased && op.ManagerRollbackGeneration == ""
		if !settled && !transition {
			return fmt.Errorf("legacy pending or uncertain operation %s: settle with release N before upgrading", id)
		}
		s.records[id] = op
	}
	if s.state.ActiveOperationID != "" || s.state.Candidate != nil {
		return errors.New("legacy pending operation or candidate: settle with release N before upgrading")
	}
	if id := s.state.FinalizePendingOperationID; id != "" {
		op, ok := s.records[id]
		if !ok || target == "" || op.Finalized || op.TargetGeneration != target {
			return errors.New("legacy finalize owner is not the authenticated supervised transition")
		}
		source, err := json.Marshal(checkpoint{SchemaVersion: 1, State: s.state, Operations: s.records})
		if err != nil {
			return err
		}
		digest := sha256.Sum256(source)
		s.transition = &bridgeTransition{Target: target, OperationID: id, SourceSHA256: hex.EncodeToString(digest[:])}
	} else if s.state.Maintenance {
		return errors.New("legacy maintenance is unsettled: settle with release N before upgrading")
	}
	return nil
}

func privateRegular(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Geteuid()) && info.Mode().IsRegular() && info.Mode().Perm() == 0o600
}
