//go:build linux

package journal

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"syscall"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
)

const observationJSONLimit int64 = 8 << 20

// OperationBoundary is a single in-memory Store snapshot cross-checked against
// every durable operation file. ObserveOperationBoundary is deliberately pure
// read-only; unlike maintenance enumeration it never removes atomic residues.
type OperationBoundary struct {
	State         model.ManagerState
	Operations    []model.Operation
	AllTerminal   bool
	EvidenceCount int
	StateSHA256   string
}

func (s *Store) ObserveOperationBoundary() (OperationBoundary, error) {
	if s == nil {
		return OperationBoundary{}, errors.New("operation journal store is unavailable")
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	var durableState model.ManagerState
	stateData, err := readObservationJSON(s.statePath, &durableState)
	if err != nil {
		return OperationBoundary{}, fmt.Errorf("read Manager state observation: %w", err)
	}
	if !reflect.DeepEqual(durableState, s.state) {
		return OperationBoundary{}, errors.New("durable Manager state differs from the live journal store")
	}
	if durableState.SchemaVersion != 1 {
		return OperationBoundary{}, fmt.Errorf("unsupported Manager state schema %d", durableState.SchemaVersion)
	}
	entries, err := os.ReadDir(s.operations)
	if err != nil {
		return OperationBoundary{}, fmt.Errorf("enumerate operation observation: %w", err)
	}
	sort.Slice(entries, func(left, right int) bool { return entries[left].Name() < entries[right].Name() })
	operations := make([]model.Operation, 0, len(entries))
	allTerminal := true
	seen := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if entry.Type()&os.ModeSymlink != 0 || entry.IsDir() || filepath.Ext(name) != ".json" {
			return OperationBoundary{}, fmt.Errorf("unknown operation observation entry %q", name)
		}
		id := name[:len(name)-len(".json")]
		if !validID(id) {
			return OperationBoundary{}, fmt.Errorf("invalid operation observation entry %q", name)
		}
		if _, duplicate := seen[id]; duplicate {
			return OperationBoundary{}, fmt.Errorf("duplicate operation identity %q", id)
		}
		seen[id] = struct{}{}
		var operation model.Operation
		if _, err := readObservationJSON(filepath.Join(s.operations, name), &operation); err != nil {
			return OperationBoundary{}, fmt.Errorf("read operation %q: %w", id, err)
		}
		if err := validateObservedOperation(id, operation); err != nil {
			return OperationBoundary{}, err
		}
		if !operationTerminal(operation) {
			allTerminal = false
		}
		operations = append(operations, BoundOperation(operation))
	}
	for _, referenced := range []string{durableState.ActiveOperationID, durableState.FinalizePendingOperationID} {
		if referenced == "" {
			continue
		}
		if _, ok := seen[referenced]; !ok {
			return OperationBoundary{}, fmt.Errorf("Manager state references missing operation %q", referenced)
		}
		allTerminal = false
	}
	return OperationBoundary{
		State: cloneState(durableState), Operations: operations,
		AllTerminal: allTerminal, EvidenceCount: len(operations),
		StateSHA256: hex.EncodeToString(sha256Sum(stateData)),
	}, nil
}

func sha256Sum(data []byte) []byte {
	digest := sha256.Sum256(data)
	return digest[:]
}

func validateObservedOperation(id string, operation model.Operation) error {
	if operation.SchemaVersion != 1 || operation.ID != id {
		return fmt.Errorf("operation journal identity mismatch for %q", id)
	}
	switch operation.Kind {
	case model.OperationInstall, model.OperationUpdate, model.OperationRestart, model.OperationRollback, model.OperationRepair:
	default:
		return fmt.Errorf("operation %q has unknown kind %q", id, operation.Kind)
	}
	switch operation.Status {
	case model.OperationPending, model.OperationRunning:
		if operation.Finalized || operation.CompletedAt != nil {
			return fmt.Errorf("nonterminal operation %q contains terminal markers", id)
		}
	case model.OperationSucceeded, model.OperationFailed:
		if operation.Finalized != (operation.CompletedAt != nil) {
			return fmt.Errorf("terminal operation %q has an incomplete finalized boundary", id)
		}
	default:
		return fmt.Errorf("operation %q has unknown status %q", id, operation.Status)
	}
	switch operation.Phase {
	case model.PhaseValidating, model.PhasePulling, model.PhasePreparing, model.PhaseDraining,
		model.PhaseSnapshotting, model.PhaseMigrating, model.PhaseStarting, model.PhaseProbing,
		model.PhaseCommitting, model.PhaseRollingBack:
	default:
		return fmt.Errorf("operation %q has unknown phase %q", id, operation.Phase)
	}
	if operation.IdempotencyKey == "" || operation.Attempt < 1 || operation.CreatedAt.IsZero() || operation.UpdatedAt.IsZero() {
		return fmt.Errorf("operation %q has an incomplete durable identity", id)
	}
	return nil
}

func operationTerminal(operation model.Operation) bool {
	return (operation.Status == model.OperationSucceeded || operation.Status == model.OperationFailed) &&
		operation.Finalized && operation.CompletedAt != nil
}

func readObservationJSON(path string, destination any) ([]byte, error) {
	pathInfo, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	metadata, ok := pathInfo.Sys().(*syscall.Stat_t)
	if !ok || !pathInfo.Mode().IsRegular() || pathInfo.Mode()&os.ModeSymlink != 0 ||
		metadata.Uid != uint32(os.Getuid()) || metadata.Nlink != 1 || pathInfo.Mode().Perm()&0o077 != 0 ||
		pathInfo.Size() < 1 || pathInfo.Size() > observationJSONLimit {
		return nil, errors.New("journal observation file has unsafe metadata")
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), filepath.Base(path))
	if file == nil {
		_ = syscall.Close(fd)
		return nil, errors.New("open journal observation: invalid descriptor")
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !os.SameFile(pathInfo, opened) {
		return nil, errors.New("journal observation file changed while opening")
	}
	data, err := io.ReadAll(io.LimitReader(file, observationJSONLimit+1))
	if err != nil {
		return nil, err
	}
	if len(data) == 0 || int64(len(data)) > observationJSONLimit {
		return nil, errors.New("journal observation JSON has an invalid size")
	}
	if err := validateClosedJSON(data); err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return nil, err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return nil, errors.New("journal observation contains trailing JSON")
		}
		return nil, err
	}
	return data, nil
}

func validateClosedJSON(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	var walk func() error
	walk = func() error {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		delimiter, compound := token.(json.Delim)
		if !compound {
			return nil
		}
		switch delimiter {
		case '{':
			keys := map[string]struct{}{}
			for decoder.More() {
				keyToken, keyErr := decoder.Token()
				if keyErr != nil {
					return keyErr
				}
				key, ok := keyToken.(string)
				if !ok {
					return errors.New("JSON object key is not a string")
				}
				if _, duplicate := keys[key]; duplicate {
					return fmt.Errorf("duplicate JSON object key %q", key)
				}
				keys[key] = struct{}{}
				if err := walk(); err != nil {
					return err
				}
			}
			end, err := decoder.Token()
			if err != nil || end != json.Delim('}') {
				return errors.New("unterminated JSON object")
			}
		case '[':
			for decoder.More() {
				if err := walk(); err != nil {
					return err
				}
			}
			end, err := decoder.Token()
			if err != nil || end != json.Delim(']') {
				return errors.New("unterminated JSON array")
			}
		default:
			return errors.New("invalid JSON delimiter")
		}
		return nil
	}
	if err := walk(); err != nil {
		return err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("JSON contains a trailing value")
		}
		return err
	}
	return nil
}
