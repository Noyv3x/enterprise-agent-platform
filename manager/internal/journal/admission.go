package journal

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
)

// Only an uncertain publication requires a disk refresh during ordinary state
// mutation. Open and Begin always validate admission; successful in-process
// state writes already hold the same lock and need no repeated journal scan.
func (s *Store) reconcileUncertainStateLocked() error {
	if !s.stateUncertain {
		return nil
	}
	return s.reconcileAdmissionLocked()
}

// reconcileAdmissionLocked closes only Begin's operation-first publication
// window. Every other unfinished orphan remains evidence requiring intervention.
func (s *Store) reconcileAdmissionLocked() error {
	var state model.ManagerState
	if err := atomicfile.ReadJSON(s.statePath, &state); err != nil {
		return err
	}
	if state.SchemaVersion != 1 || state.ActiveOperationID != "" && state.FinalizePendingOperationID != "" {
		return errors.New("invalid manager admission ownership")
	}
	operations, err := s.unfinishedOperationsLocked()
	if err != nil {
		return err
	}
	var orphan *model.Operation
	for index := range operations {
		op := &operations[index]
		if op.ID == state.ActiveOperationID || op.ID == state.FinalizePendingOperationID {
			continue
		}
		if orphan != nil || state.ActiveOperationID != "" || state.FinalizePendingOperationID != "" {
			return errors.New("conflicting unfinished operation ownership")
		}
		orphan = op
	}
	if orphan != nil {
		var raw json.RawMessage
		if err := atomicfile.ReadJSON(s.operationPath(orphan.ID), &raw); err != nil {
			return err
		}
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		var durable model.Operation
		if err := decoder.Decode(&durable); err != nil {
			return err
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil {
			return err
		}
		for _, key := range []string{"schema_version", "id", "kind", "idempotency_key", "attempt", "expected_generation", "status", "finalized", "phase", "history", "created_at", "updated_at"} {
			if value, ok := fields[key]; !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
				return fmt.Errorf("operation %s has incomplete admission evidence", orphan.ID)
			}
		}
		if !reflect.DeepEqual(durable, *orphan) {
			return errors.New("operation changed during admission reconciliation")
		}
		if !pristineAdmission(*orphan) || orphan.ExpectedGeneration != state.Generation || state.Generation == ^uint64(0) || state.Maintenance || state.Phase != "" {
			return fmt.Errorf("operation %s is not a recoverable admission", orphan.ID)
		}
		state.Generation++
		state.ActiveOperationID = orphan.ID
		state.Phase = orphan.Phase
		state.UpdatedAt, state.HeartbeatAt = orphan.CreatedAt, orphan.CreatedAt
		if err := s.persistStateValueLocked(&state); err != nil {
			return err
		}
	}
	// Also refresh after an ambiguous state write: disk may already reference
	// the operation even though the previous call returned a sync error.
	s.state = state
	s.stateUncertain = false
	return nil
}

func pristineAdmission(op model.Operation) bool {
	switch op.Kind {
	case model.OperationInstall, model.OperationUpdate, model.OperationRestart, model.OperationRollback, model.OperationRepair:
	default:
		return false
	}
	if op.IdempotencyKey == "" || op.Attempt < 1 || op.CreatedAt.IsZero() {
		return false
	}
	// Compare the whole durable record to Begin's zero-side-effect shape so
	// recovery cannot silently ignore a new checkpoint field in the model.
	expected := model.Operation{
		SchemaVersion: 1, ID: op.ID, Kind: op.Kind, IdempotencyKey: op.IdempotencyKey,
		Attempt: op.Attempt, ExpectedGeneration: op.ExpectedGeneration, TargetManifestURL: op.TargetManifestURL,
		Status: model.OperationPending, Phase: model.PhaseValidating,
		History: []model.PhaseEvent{{Phase: model.PhaseValidating, At: op.CreatedAt}}, CreatedAt: op.CreatedAt, UpdatedAt: op.CreatedAt,
	}
	return reflect.DeepEqual(op, expected)
}
