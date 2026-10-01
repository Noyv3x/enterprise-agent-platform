package journal

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
)

var ErrOperationInProgress = errors.New("another mutation operation is already active")
var ErrGenerationConflict = errors.New("manager generation changed")
var ErrIdempotencyConflict = errors.New("idempotency key belongs to a different operation request")

// MaxDiagnosticBytes keeps operation projections compact even when JSON
// escaping expands every retained byte. The marker preserves the original size
// and a stable identity for forensic correlation without unbounded journals.
const MaxDiagnosticBytes = 64 << 10
const MaxHistoryNoteBytes = 2 << 10
const MaxOperationHistoryEntries = 64

func BoundDiagnostic(message string) string {
	return boundDiagnostic(message, MaxDiagnosticBytes)
}

func BoundDiagnosticWithLimit(message string, limit int) string {
	return boundDiagnostic(message, limit)
}

func boundDiagnostic(message string, limit int) string {
	if len(message) <= limit {
		return message
	}
	digest := sha256.Sum256([]byte(message))
	marker := fmt.Sprintf("\n...[diagnostic truncated; original_bytes=%d; sha256=%s]...\n", len(message), hex.EncodeToString(digest[:]))
	if limit <= len(marker) {
		return marker[:limit]
	}
	retained := limit - len(marker)
	headBytes := retained / 2
	tailBytes := retained - headBytes
	// Error strings are expected to be UTF-8. Avoid introducing a split rune at
	// either truncation boundary so API projections remain well-formed text too.
	for headBytes > 0 && !utf8.RuneStart(message[headBytes]) {
		headBytes--
	}
	tailStart := len(message) - tailBytes
	for tailStart < len(message) && !utf8.RuneStart(message[tailStart]) {
		tailStart++
	}
	return message[:headBytes] + marker + message[tailStart:]
}

func BoundOperation(op model.Operation) model.Operation {
	op.Error = BoundDiagnostic(op.Error)
	history := op.History
	if len(history) > MaxOperationHistoryEntries {
		head := MaxOperationHistoryEntries / 2
		tail := MaxOperationHistoryEntries - head
		bounded := make([]model.PhaseEvent, 0, MaxOperationHistoryEntries)
		bounded = append(bounded, history[:head]...)
		bounded = append(bounded, history[len(history)-tail:]...)
		history = bounded
	} else {
		history = append([]model.PhaseEvent(nil), history...)
	}
	for i := range history {
		history[i].Note = BoundDiagnosticWithLimit(history[i].Note, MaxHistoryNoteBytes)
	}
	op.History = history
	return op
}

type Store struct {
	checkpointPath     string
	records            map[string]model.Operation
	historyPruneAfter  time.Time
	mu                 sync.Mutex
	state              model.ManagerState
	stateUncertain     bool
	beforePersistState func(model.ManagerState) error
}

// Open loads the sole checkpoint authority. Callers hold the service lock.
func Open(dir string, now time.Time) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	store := &Store{checkpointPath: filepath.Join(dir, "update.json"),
		state: model.NewState(now), records: make(map[string]model.Operation)}
	if err := store.loadCheckpointLocked(); err == nil {
		return store, nil
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	for _, name := range []string{"state.json", "operations"} {
		if _, err := os.Lstat(filepath.Join(dir, name)); err == nil {
			return nil, errors.New("missing update checkpoint with legacy state present")
		} else if !os.IsNotExist(err) {
			return nil, err
		}
	}
	if err := store.persistStateLocked(); err != nil {
		return nil, err
	}
	return store, nil
}

func (s *Store) State() model.ManagerState {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := cloneState(s.state)
	state.LastError = BoundDiagnostic(state.LastError)
	return state
}

// StateWithReferencedOperation returns one lock-consistent status snapshot.
// The operation is nil when the state has no active or finalize-pending owner.
// Ambiguous or unreadable references are errors so callers cannot combine a
// state snapshot with an unrelated operation journal entry.
func (s *Store) StateWithReferencedOperation() (model.ManagerState, *model.Operation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.reconcileUncertainStateLocked(); err != nil {
		return model.ManagerState{}, nil, err
	}
	state := cloneState(s.state)
	state.LastError = BoundDiagnostic(state.LastError)
	if state.ActiveOperationID != "" && state.FinalizePendingOperationID != "" {
		return state, nil, errors.New("manager state references overlapping operations")
	}
	operationID := state.ActiveOperationID
	if operationID == "" {
		operationID = state.FinalizePendingOperationID
	}
	if operationID == "" {
		return state, nil, nil
	}
	operation, err := s.readOperationLocked(operationID)
	if err != nil {
		return state, nil, fmt.Errorf("read manager state operation: %w", err)
	}
	if operation.SchemaVersion != 1 || operation.ID != operationID {
		return state, nil, errors.New("manager state operation identity is invalid")
	}
	operation = BoundOperation(operation)
	return state, &operation, nil
}

func (s *Store) MutateState(now time.Time, fn func(*model.ManagerState) error) (model.ManagerState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.reconcileUncertainStateLocked(); err != nil {
		return model.ManagerState{}, err
	}
	next := cloneState(s.state)
	if err := fn(&next); err != nil {
		return model.ManagerState{}, err
	}
	next.Generation++
	next.UpdatedAt = now.UTC()
	next.HeartbeatAt = now.UTC()
	if err := s.persistStateValueLocked(&next); err != nil {
		return model.ManagerState{}, err
	}
	s.state = next
	return cloneState(next), nil
}

func (s *Store) Begin(req model.OperationRequest, now time.Time) (model.Operation, bool, error) {
	return s.BeginWithAdmission(req, now, nil)
}

// BeginWithAdmission checks a new operation's admission after resolving exact
// replays, but before publishing any journal mutation. The callback must not
// call Store methods; its snapshot is protected by the Store lock.
func (s *Store) BeginWithAdmission(req model.OperationRequest, now time.Time, admit func(model.ManagerState) error) (model.Operation, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if req.IdempotencyKey == "" {
		return model.Operation{}, false, errors.New("idempotency_key is required")
	}
	if err := s.reconcileAdmissionLocked(); err != nil {
		return model.Operation{}, false, err
	}
	attempt := 1
	if existing, ok, err := s.findByIdempotencyLocked(req.IdempotencyKey); err != nil {
		return model.Operation{}, false, err
	} else if ok {
		existing = BoundOperation(existing)
		if !sameOperationRequest(existing, req) {
			return model.Operation{}, false, ErrIdempotencyConflict
		}
		if existing.Status != model.OperationFailed {
			return existing, true, nil
		}
		// An exact replay after a lost response still carries the generation
		// used to create the failed operation and must observe that terminal
		// attempt. A caller explicitly starting the next attempt first reads
		// current state and supplies its newer generation.
		if req.ExpectedGeneration == existing.ExpectedGeneration {
			return existing, true, nil
		}
		attempt = existing.Attempt + 1
		if attempt < 2 {
			attempt = 2
		}
	}
	if req.ExpectedGeneration != s.state.Generation {
		return model.Operation{}, false, ErrGenerationConflict
	}
	if s.state.ActiveOperationID != "" || s.state.FinalizePendingOperationID != "" {
		return model.Operation{}, false, ErrOperationInProgress
	}
	if admit != nil {
		if err := admit(cloneState(s.state)); err != nil {
			return model.Operation{}, false, err
		}
	}
	id, err := randomID("op_")
	if err != nil {
		return model.Operation{}, false, err
	}
	op := model.Operation{
		SchemaVersion: 1, ID: id, Kind: req.Kind, IdempotencyKey: req.IdempotencyKey,
		Attempt:            attempt,
		ExpectedGeneration: req.ExpectedGeneration, TargetManifestURL: req.ManifestURL, ExpectedTargetID: req.ExpectedTargetID,
		Status: model.OperationPending, Phase: model.PhaseValidating,
		History: []model.PhaseEvent{{Phase: model.PhaseValidating, At: now.UTC()}}, CreatedAt: now.UTC(), UpdatedAt: now.UTC(),
	}
	// Publish admission and its public projection in a single checkpoint.
	next := cloneState(s.state)
	next.Generation++
	next.ActiveOperationID = op.ID
	next.Phase = op.Phase
	next.UpdatedAt, next.HeartbeatAt = now.UTC(), now.UTC()
	if err := s.persistCheckpointLocked(&next, &op); err != nil {
		return model.Operation{}, false, err
	}
	s.state = next
	return op, false, nil
}

func sameOperationRequest(existing model.Operation, request model.OperationRequest) bool {
	return existing.Kind == request.Kind &&
		existing.TargetManifestURL == request.ManifestURL
}

func (s *Store) Operation(id string) (model.Operation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	op, err := s.readOperationLocked(id)
	if err != nil {
		return model.Operation{}, err
	}
	return BoundOperation(op), nil
}

// UnfinishedOperations returns every durable operation that could still own a
// candidate, snapshot, reservation, or recovery action. Maintenance treats an
// unreadable or unknown journal entry as a hard stop rather than guessing that
// its resources are unreachable.
func (s *Store) UnfinishedOperations() ([]model.Operation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.reconcileUncertainStateLocked(); err != nil {
		return nil, err
	}
	operations, err := s.unfinishedOperationsLocked()
	for index := range operations {
		operations[index] = BoundOperation(operations[index])
	}
	return operations, err
}

func (s *Store) unfinishedOperationsLocked() ([]model.Operation, error) {
	unfinished := make([]model.Operation, 0)
	for _, op := range s.records {
		if op.Status == model.OperationPending || op.Status == model.OperationRunning || !op.Finalized {
			unfinished = append(unfinished, op)
		}
	}
	sort.Slice(unfinished, func(i, j int) bool { return unfinished[i].CreatedAt.Before(unfinished[j].CreatedAt) })
	return unfinished, nil
}

func (s *Store) SetPhase(id string, phase model.OperationPhase, public model.PublicState, maintenance bool, note string, now time.Time) (model.Operation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.reconcileUncertainStateLocked(); err != nil {
		return model.Operation{}, err
	}
	op, err := s.readOperationLocked(id)
	if err != nil {
		return model.Operation{}, err
	}
	if op.Status == model.OperationSucceeded || op.Status == model.OperationFailed {
		return model.Operation{}, errors.New("operation is already complete")
	}
	op.Status, op.Phase, op.UpdatedAt = model.OperationRunning, phase, now.UTC()
	op.History = append(op.History, model.PhaseEvent{Phase: phase, At: now.UTC(), Note: note})
	next := cloneState(s.state)
	next.Generation++
	next.PublicState = public
	next.Maintenance = maintenance
	next.Phase = phase
	next.UpdatedAt, next.HeartbeatAt = now.UTC(), now.UTC()
	if err := s.persistCheckpointLocked(&next, &op); err != nil {
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
	if err := s.persistOperationLocked(&op); err != nil {
		return model.Operation{}, err
	}
	return op, nil
}

func (s *Store) Complete(id string, success bool, stateFn func(*model.ManagerState), message string, now time.Time) (model.Operation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.reconcileUncertainStateLocked(); err != nil {
		return model.Operation{}, err
	}
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
	if !op.Finalized || !success {
		op.GateSettlementAction = ""
	}
	if err := s.persistCheckpointLocked(&next, &op); err != nil {
		return model.Operation{}, err
	}
	s.state = next
	return op, nil
}

// Finalize publishes settled gate evidence and clears maintenance atomically.
func (s *Store) Finalize(id string, action model.GateSettlementAction, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	op, err := s.readOperationLocked(id)
	if err != nil {
		return err
	}
	if s.state.FinalizePendingOperationID != id || op.Status != model.OperationSucceeded {
		return errors.New("operation is not awaiting gate settlement")
	}
	next := cloneState(s.state)
	next.Generation++
	next.FinalizePendingOperationID = ""
	next.PublicState, next.Maintenance = model.StateIdle, false
	next.LastError, next.RetryAfterSeconds = "", 0
	next.UpdatedAt, next.HeartbeatAt = now.UTC(), now.UTC()
	op.Finalized, op.GateSettlementAction, op.UpdatedAt = true, action, now.UTC()
	if err := s.persistCheckpointLocked(&next, &op); err != nil {
		return err
	}
	s.state = next
	return nil
}

// CompletePreparedCleanup atomically closes the inverse-update operation.
func (s *Store) CompletePreparedCleanup(id string, now time.Time) (model.Operation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.reconcileUncertainStateLocked(); err != nil {
		return model.Operation{}, err
	}
	op, err := s.readOperationLocked(id)
	if err != nil {
		return model.Operation{}, err
	}
	if !op.PreparedCleanupPending || (op.Kind != model.OperationInstall && op.Kind != model.OperationUpdate) ||
		op.TargetGeneration == "" || op.Error == "" {
		return model.Operation{}, errors.New("prepared cleanup operation is not an active inverse-update owner")
	}
	if op.Finalized || op.CompletedAt != nil ||
		(op.Status != model.OperationPending && op.Status != model.OperationRunning) {
		return model.Operation{}, errors.New("prepared cleanup operation has an invalid terminal boundary")
	}
	if s.state.ActiveOperationID != id || s.state.FinalizePendingOperationID != "" || s.state.Candidate != nil {
		return model.Operation{}, errors.New("prepared cleanup Platform state is not ready for terminal commit")
	}
	completed := now.UTC()
	op.Status = model.OperationFailed
	op.Finalized = true
	op.GateSettlementAction = ""
	op.PreparedCleanupPending = false
	op.UpdatedAt = completed
	op.CompletedAt = &completed
	next := cloneState(s.state)
	next.Generation++
	next.ActiveOperationID = ""
	next.Phase = ""
	next.PublicState = model.StateIdle
	next.Maintenance = false
	next.LastError = op.Error
	next.RetryAfterSeconds = 0
	next.UpdatedAt, next.HeartbeatAt = completed, completed
	if err := s.persistCheckpointLocked(&next, &op); err != nil {
		return model.Operation{}, err
	}
	s.state = next
	return op, nil
}

func (s *Store) RecoverActive() (*model.Operation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.reconcileUncertainStateLocked(); err != nil {
		return nil, err
	}
	if s.state.ActiveOperationID == "" {
		return nil, nil
	}
	op, err := s.readOperationLocked(s.state.ActiveOperationID)
	if err != nil {
		return nil, fmt.Errorf("active operation journal is missing: %w", err)
	}
	// Recovery consumes the durable record rather than an API projection. Keep
	// the original diagnostic here so the first bounded recovery write can
	// retain the original byte count and digest instead of truncating an already
	// truncated marker a second time.
	return &op, nil
}

func (s *Store) persistStateLocked() error { return s.persistStateValueLocked(&s.state) }
func (s *Store) persistStateValueLocked(value *model.ManagerState) error {
	return s.persistCheckpointLocked(value, nil)
}
func (s *Store) persistCheckpointLocked(state *model.ManagerState, op *model.Operation) error {
	state.LastError = BoundDiagnostic(state.LastError)
	if s.beforePersistState != nil {
		if err := s.beforePersistState(cloneState(*state)); err != nil {
			return err
		}
	}
	records := s.records
	pruneAt := state.UpdatedAt
	if op != nil && op.UpdatedAt.After(pruneAt) {
		pruneAt = op.UpdatedAt
	}
	if op != nil {
		*op = BoundOperation(*op)
		records = maps.Clone(records)
		records[op.ID] = *op
		pruneCheckpointHistory(records, *state, pruneAt)
	}
	if op == nil && len(records) > 128 && !pruneAt.Before(s.historyPruneAfter) {
		records = maps.Clone(records)
		pruneCheckpointHistory(records, *state, pruneAt)
	}
	s.stateUncertain = true
	if err := atomicfile.WriteJSON(s.checkpointPath, checkpoint{1, *state, records}, 0o600); err != nil {
		return err
	}
	s.records = records
	if op != nil || !pruneAt.Before(s.historyPruneAfter) {
		s.historyPruneAfter = pruneAt.Add(time.Hour)
	}
	s.stateUncertain = false
	return nil
}
func (s *Store) persistOperationLocked(op *model.Operation) error {
	return s.persistCheckpointLocked(&s.state, op)
}
func (s *Store) readOperationLocked(id string) (model.Operation, error) {
	if !validID(id) {
		return model.Operation{}, errors.New("invalid operation id")
	}
	if err := s.reconcileUncertainStateLocked(); err != nil {
		return model.Operation{}, err
	}
	op, ok := s.records[id]
	if !ok {
		return model.Operation{}, os.ErrNotExist
	}
	op.History = append([]model.PhaseEvent(nil), op.History...)
	return op, nil
}
func (s *Store) findByIdempotencyLocked(key string) (model.Operation, bool, error) {
	var latest model.Operation
	found := false
	for _, op := range s.records {
		if op.IdempotencyKey == key && (!found || op.Attempt > latest.Attempt ||
			op.Attempt == latest.Attempt && op.CreatedAt.After(latest.CreatedAt)) {
			latest, found = op, true
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
	clone.Images = maps.Clone(value.Images)
	return clone
}

// Retention is part of checkpoint publication, never a separate cleanup owner.
// Keep the legacy idempotency horizon: newest 128 terminals or seven days,
// plus operations still linked to the two retained rollback generations.
func pruneCheckpointHistory(records map[string]model.Operation, state model.ManagerState, now time.Time) {
	if len(records) <= 128 {
		return
	}
	terminal := make([]string, 0, len(records))
	for _, op := range records {
		if op.Finalized && op.CompletedAt != nil &&
			(op.Status == model.OperationSucceeded || op.Status == model.OperationFailed) {
			terminal = append(terminal, op.ID)
		}
	}
	if len(terminal) <= 128 {
		return
	}
	sort.Slice(terminal, func(i, j int) bool {
		left, right := records[terminal[i]], records[terminal[j]]
		if left.CompletedAt.Equal(*right.CompletedAt) {
			return left.ID > right.ID
		}
		return left.CompletedAt.After(*right.CompletedAt)
	})
	cutoff := now.Add(-7 * 24 * time.Hour)
	for _, id := range terminal[128:] {
		op := records[id]
		if !op.CompletedAt.Before(cutoff) || op.ID == state.ActiveOperationID ||
			op.ID == state.FinalizePendingOperationID || op.PreparedCleanupPending {
			continue
		}
		linked := false
		for _, generation := range []*model.Generation{state.Current, state.Previous} {
			if generation != nil && ((op.SnapshotPath != "" && op.SnapshotPath == generation.RollbackSnapshotPath) ||
				(op.Status == model.OperationSucceeded && op.TargetGeneration == generation.ID &&
					(op.Kind == model.OperationInstall || op.Kind == model.OperationUpdate))) {
				linked = true
			}
		}
		if !linked {
			delete(records, op.ID)
		}
	}
}
