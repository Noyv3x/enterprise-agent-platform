package journal

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
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
	state := cloneState(s.state)
	state.LastError = BoundDiagnostic(state.LastError)
	return state
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
	if err := s.persistStateValueLocked(&next); err != nil {
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
	id, err := randomID("op_")
	if err != nil {
		return model.Operation{}, false, err
	}
	op := model.Operation{
		SchemaVersion: 1, ID: id, Kind: req.Kind, IdempotencyKey: req.IdempotencyKey,
		Attempt:            attempt,
		ExpectedGeneration: req.ExpectedGeneration, TargetManifestURL: req.ManifestURL,
		Status: model.OperationPending, Phase: model.PhaseValidating,
		History: []model.PhaseEvent{{Phase: model.PhaseValidating, At: now.UTC()}}, CreatedAt: now.UTC(), UpdatedAt: now.UTC(),
	}
	if err := s.persistOperationLocked(&op); err != nil {
		return model.Operation{}, false, err
	}
	next := cloneState(s.state)
	next.Generation++
	next.ActiveOperationID = op.ID
	next.Phase = op.Phase
	next.UpdatedAt, next.HeartbeatAt = now.UTC(), now.UTC()
	if err := s.persistStateValueLocked(&next); err != nil {
		_ = os.Remove(s.operationPath(op.ID))
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
	if err := s.cleanupOperationAtomicResiduesLocked(); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(s.operations)
	if err != nil {
		return nil, err
	}
	unfinished := make([]model.Operation, 0)
	for _, entry := range entries {
		if entry.Type()&os.ModeSymlink != 0 || entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			return nil, fmt.Errorf("unknown operation journal entry %s", entry.Name())
		}
		id := strings.TrimSuffix(entry.Name(), ".json")
		if !validID(id) {
			return nil, fmt.Errorf("invalid operation journal entry %s", entry.Name())
		}
		op, err := s.readOperationLocked(id)
		if err != nil {
			return nil, err
		}
		if op.ID != id || op.SchemaVersion != 1 {
			return nil, fmt.Errorf("operation journal identity mismatch for %s", entry.Name())
		}
		switch op.Status {
		case model.OperationPending, model.OperationRunning:
			unfinished = append(unfinished, BoundOperation(op))
		case model.OperationSucceeded, model.OperationFailed:
			if !op.Finalized {
				unfinished = append(unfinished, BoundOperation(op))
			}
		default:
			return nil, fmt.Errorf("operation journal %s has unknown status %q", entry.Name(), op.Status)
		}
	}
	sort.Slice(unfinished, func(left, right int) bool {
		return unfinished[left].CreatedAt.Before(unfinished[right].CreatedAt)
	})
	return unfinished, nil
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
	if err := s.persistOperationLocked(&op); err != nil {
		return model.Operation{}, err
	}
	next := cloneState(s.state)
	next.Generation++
	next.PublicState = public
	next.Maintenance = maintenance
	next.Phase = phase
	next.UpdatedAt, next.HeartbeatAt = now.UTC(), now.UTC()
	if err := s.persistStateValueLocked(&next); err != nil {
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
	if err := s.persistOperationLocked(&op); err != nil {
		return model.Operation{}, err
	}
	if err := s.persistStateValueLocked(&next); err != nil {
		return model.Operation{}, err
	}
	s.state = next
	return op, nil
}

// CompletePreparedCleanup closes the durable inverse-update protocol. The
// terminal operation is persisted before the active Platform owner is cleared,
// so a crash between the two files is recovered as an ordinary terminal/state
// half-commit and can never re-enter runUpdate.
func (s *Store) CompletePreparedCleanup(id string, now time.Time) (model.Operation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
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
	// Clearing the marker is atomic with making the operation terminal. A crash
	// after this write cannot re-enter runUpdate; RecoverActive observes failed
	// and only clears the still-active Platform projection.
	if err := s.persistOperationLocked(&op); err != nil {
		return model.Operation{}, err
	}
	next := cloneState(s.state)
	next.Generation++
	next.ActiveOperationID = ""
	next.Phase = ""
	next.PublicState = model.StateIdle
	next.Maintenance = false
	next.LastError = op.Error
	next.RetryAfterSeconds = 0
	next.UpdatedAt, next.HeartbeatAt = completed, completed
	if err := s.persistStateValueLocked(&next); err != nil {
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
	// Recovery consumes the durable record rather than an API projection. Keep
	// the original diagnostic here so the first bounded recovery write can
	// retain the original byte count and digest instead of truncating an already
	// truncated marker a second time.
	return &op, nil
}

func (s *Store) operationPath(id string) string {
	return filepath.Join(s.operations, id+".json")
}

func (s *Store) persistStateLocked() error { return s.persistStateValueLocked(&s.state) }
func (s *Store) persistStateValueLocked(value *model.ManagerState) error {
	value.LastError = BoundDiagnostic(value.LastError)
	if s.beforePersistState != nil {
		if err := s.beforePersistState(cloneState(*value)); err != nil {
			return err
		}
	}
	return atomicfile.WriteJSON(s.statePath, *value, 0o600)
}
func (s *Store) persistOperationLocked(op *model.Operation) error {
	*op = BoundOperation(*op)
	return atomicfile.WriteJSON(s.operationPath(op.ID), *op, 0o600)
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
	if err := s.cleanupOperationAtomicResiduesLocked(); err != nil {
		return model.Operation{}, false, err
	}
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
