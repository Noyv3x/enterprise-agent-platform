package journal

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/atomicfile"
	"github.com/ubitech/agent-platform/manager/internal/model"
)

var ErrOperationInProgress = errors.New("another mutation operation is already active")
var ErrGenerationConflict = errors.New("manager generation changed")

type Store struct {
	dir                string
	statePath          string
	operations         string
	mu                 sync.Mutex
	state              model.ManagerState
	beforePersistState func(model.ManagerState) error
}

func Open(dir string, now time.Time) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(dir, "operations"), 0o700); err != nil {
		return nil, fmt.Errorf("create manager state: %w", err)
	}
	store := &Store{
		dir: dir, statePath: filepath.Join(dir, "state.json"),
		operations: filepath.Join(dir, "operations"), state: model.NewState(now),
	}
	if err := atomicfile.ReadJSON(store.statePath, &store.state); err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	if store.state.SchemaVersion != 1 {
		return nil, fmt.Errorf("unsupported manager state schema %d", store.state.SchemaVersion)
	}
	if _, err := os.Stat(store.statePath); os.IsNotExist(err) {
		if err := store.persistStateLocked(); err != nil {
			return nil, err
		}
	}
	return store, nil
}

func (s *Store) State() model.ManagerState {
	s.mu.Lock()
	defer s.mu.Unlock()
	return cloneState(s.state)
}

func (s *Store) MutateState(now time.Time, fn func(*model.ManagerState) error) (model.ManagerState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := cloneState(s.state)
	if err := fn(&next); err != nil {
		return model.ManagerState{}, err
	}
	next.Generation++
	next.UpdatedAt = now.UTC()
	next.HeartbeatAt = now.UTC()
	if err := s.persistStateValueLocked(next); err != nil {
		return model.ManagerState{}, err
	}
	s.state = next
	return cloneState(next), nil
}

func (s *Store) Heartbeat(now time.Time) error {
	_, err := s.MutateState(now, func(state *model.ManagerState) error { return nil })
	return err
}

func (s *Store) Begin(req model.OperationRequest, now time.Time) (model.Operation, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if req.IdempotencyKey == "" {
		return model.Operation{}, false, errors.New("idempotency_key is required")
	}
	if req.ExpectedGeneration != s.state.Generation {
		return model.Operation{}, false, ErrGenerationConflict
	}
	attempt := 1
	if existing, ok, err := s.findByIdempotencyLocked(req.IdempotencyKey); err != nil {
		return model.Operation{}, false, err
	} else if ok {
		if existing.Status != model.OperationFailed {
			return existing, true, nil
		}
		attempt = existing.Attempt + 1
		if attempt < 2 {
			attempt = 2
		}
	}
	if s.state.ActiveOperationID != "" || s.state.FinalizePendingOperationID != "" {
		return model.Operation{}, false, ErrOperationInProgress
	}
	id, err := randomID("op_")
	if err != nil {
		return model.Operation{}, false, err
	}
	op := model.Operation{
		SchemaVersion: 1, ID: id, Kind: req.Kind, IdempotencyKey: req.IdempotencyKey,
		Attempt:            attempt,
		ExpectedGeneration: req.ExpectedGeneration, TargetManifestURL: req.ManifestURL, ExpectedSourceCommit: req.ExpectedSourceCommit,
		Status: model.OperationPending, Phase: model.PhaseValidating,
		History: []model.PhaseEvent{{Phase: model.PhaseValidating, At: now.UTC()}}, CreatedAt: now.UTC(), UpdatedAt: now.UTC(),
	}
	if err := s.persistOperationLocked(op); err != nil {
		return model.Operation{}, false, err
	}
	next := cloneState(s.state)
	next.Generation++
	next.ActiveOperationID = op.ID
	next.Phase = op.Phase
	next.UpdatedAt, next.HeartbeatAt = now.UTC(), now.UTC()
	if err := s.persistStateValueLocked(next); err != nil {
		_ = os.Remove(s.operationPath(op.ID))
		return model.Operation{}, false, err
	}
	s.state = next
	return op, false, nil
}

func (s *Store) Operation(id string) (model.Operation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readOperationLocked(id)
}

func (s *Store) SetPhase(id string, phase model.OperationPhase, public model.PublicState, maintenance bool, note string, now time.Time) (model.Operation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	op, err := s.readOperationLocked(id)
	if err != nil {
		return model.Operation{}, err
	}
	if op.Status == model.OperationSucceeded || op.Status == model.OperationFailed {
		return model.Operation{}, errors.New("operation is already complete")
	}
	op.Status, op.Phase, op.UpdatedAt = model.OperationRunning, phase, now.UTC()
	op.History = append(op.History, model.PhaseEvent{Phase: phase, At: now.UTC(), Note: note})
	if err := s.persistOperationLocked(op); err != nil {
		return model.Operation{}, err
	}
	next := cloneState(s.state)
	next.Generation++
	next.PublicState = public
	next.Maintenance = maintenance
	next.Phase = phase
	next.UpdatedAt, next.HeartbeatAt = now.UTC(), now.UTC()
	if err := s.persistStateValueLocked(next); err != nil {
		return model.Operation{}, err
	}
	s.state = next
	return op, nil
}

func (s *Store) UpdateOperation(id string, fn func(*model.Operation) error) (model.Operation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	op, err := s.readOperationLocked(id)
	if err != nil {
		return model.Operation{}, err
	}
	if err := fn(&op); err != nil {
		return model.Operation{}, err
	}
	if err := s.persistOperationLocked(op); err != nil {
		return model.Operation{}, err
	}
	return op, nil
}

func (s *Store) Complete(id string, success bool, stateFn func(*model.ManagerState), message string, now time.Time) (model.Operation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	op, err := s.readOperationLocked(id)
	if err != nil {
		return model.Operation{}, err
	}
	completed := now.UTC()
	op.UpdatedAt, op.CompletedAt = completed, &completed
	if success {
		op.Status = model.OperationSucceeded
	} else {
		op.Status, op.Error = model.OperationFailed, message
	}
	next := cloneState(s.state)
	next.Generation++
	next.ActiveOperationID = ""
	next.Phase = ""
	next.UpdatedAt, next.HeartbeatAt = completed, completed
	if stateFn != nil {
		stateFn(&next)
	}
	op.Finalized = !success || next.FinalizePendingOperationID != id
	if err := s.persistOperationLocked(op); err != nil {
		return model.Operation{}, err
	}
	if err := s.persistStateValueLocked(next); err != nil {
		return model.Operation{}, err
	}
	s.state = next
	return op, nil
}

func (s *Store) RecoverActive() (*model.Operation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state.ActiveOperationID == "" {
		return nil, nil
	}
	op, err := s.readOperationLocked(s.state.ActiveOperationID)
	if err != nil {
		return nil, fmt.Errorf("active operation journal is missing: %w", err)
	}
	return &op, nil
}

func (s *Store) operationPath(id string) string {
	return filepath.Join(s.operations, id+".json")
}

func (s *Store) persistStateLocked() error { return s.persistStateValueLocked(s.state) }
func (s *Store) persistStateValueLocked(value model.ManagerState) error {
	if s.beforePersistState != nil {
		if err := s.beforePersistState(cloneState(value)); err != nil {
			return err
		}
	}
	return atomicfile.WriteJSON(s.statePath, value, 0o600)
}
func (s *Store) persistOperationLocked(op model.Operation) error {
	return atomicfile.WriteJSON(s.operationPath(op.ID), op, 0o600)
}
func (s *Store) readOperationLocked(id string) (model.Operation, error) {
	if !validID(id) {
		return model.Operation{}, errors.New("invalid operation id")
	}
	var op model.Operation
	if err := atomicfile.ReadJSON(s.operationPath(id), &op); err != nil {
		return model.Operation{}, err
	}
	return op, nil
}

func (s *Store) findByIdempotencyLocked(key string) (model.Operation, bool, error) {
	entries, err := os.ReadDir(s.operations)
	if err != nil {
		return model.Operation{}, false, err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() > entries[j].Name() })
	var latest model.Operation
	found := false
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		var op model.Operation
		if err := atomicfile.ReadJSON(filepath.Join(s.operations, entry.Name()), &op); err != nil {
			return model.Operation{}, false, err
		}
		if op.IdempotencyKey == key {
			if !found || op.Attempt > latest.Attempt || op.Attempt == latest.Attempt && op.CreatedAt.After(latest.CreatedAt) {
				latest, found = op, true
			}
		}
	}
	return latest, found, nil
}

func randomID(prefix string) (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(b), nil
}
func validID(id string) bool {
	if len(id) < 4 || len(id) > 128 {
		return false
	}
	for _, r := range id {
		if !(r == '_' || r == '-' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') {
			return false
		}
	}
	return true
}
func cloneState(value model.ManagerState) model.ManagerState {
	clone := value
	if value.Current != nil {
		v := cloneGeneration(*value.Current)
		clone.Current = &v
	}
	if value.Previous != nil {
		v := cloneGeneration(*value.Previous)
		clone.Previous = &v
	}
	if value.Candidate != nil {
		v := cloneGeneration(*value.Candidate)
		clone.Candidate = &v
	}
	return clone
}
func cloneGeneration(value model.Generation) model.Generation {
	clone := value
	if value.Images != nil {
		clone.Images = make(map[string]string, len(value.Images))
		for k, v := range value.Images {
			clone.Images[k] = v
		}
	}
	return clone
}
