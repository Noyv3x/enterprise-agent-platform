package executor

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/atomicfile"
	"github.com/ubitech/agent-platform/manager/internal/logstore"
)

type AuditStore struct {
	Dir string
	Log *logstore.Store
	Now func() time.Time
}

func (s AuditStore) Record(request AuditRequest) (AuditReceipt, error) {
	if err := validateIdentity(request.Identity); err != nil {
		return AuditReceipt{}, err
	}
	if !validID(request.AuditID) || request.Operation == "" {
		return AuditReceipt{}, errors.New("audit_id and operation are required")
	}
	if request.Target != "sandbox" && request.Target != "host" {
		return AuditReceipt{}, errors.New("target must be sandbox or host")
	}
	if err := validateOperationAction(request.Operation, request.Action); err != nil {
		return AuditReceipt{}, err
	}
	argumentsSHA256, err := canonicalArgumentsSHA256(request.Arguments)
	if err != nil {
		return AuditReceipt{}, fmt.Errorf("invalid audited arguments: %w", err)
	}
	id, err := randomID("exec_")
	if err != nil {
		return AuditReceipt{}, err
	}
	now := s.now()
	record := receiptRecord{
		AuditReceipt:    AuditReceipt{AuditID: request.AuditID, ExecutorID: id, Target: request.Target, RecordedAt: now},
		Identity:        request.Identity,
		Operation:       request.Operation,
		Action:          request.Action,
		ArgumentsSHA256: argumentsSHA256,
		CreatedAt:       now,
	}
	record.Details = request.Details
	if err := os.MkdirAll(filepath.Join(s.Dir, "receipts"), 0o700); err != nil {
		return AuditReceipt{}, err
	}
	if err := atomicfile.WriteJSON(filepath.Join(s.Dir, "receipts", id+".json"), record, 0o600); err != nil {
		return AuditReceipt{}, err
	}
	if s.Log != nil {
		if err := s.Log.Append(logstore.Event{At: now, Type: "execution.audit", AuditID: request.AuditID, ExecutorID: id, Target: request.Target, RunID: request.RunID, ScopeID: request.ScopeID, ToolCallID: request.ToolCallID, Details: map[string]any{"operation": request.Operation, "arguments": request.Details}}); err != nil {
			return AuditReceipt{}, err
		}
	}
	return record.AuditReceipt, nil
}

// Consume verifies the full execution binding and atomically spends the
// receipt before the caller starts the operation. A failed binding check does
// not consume the receipt; after a successful check, at most one concurrent
// caller can remove the owner-only receipt file and proceed.
func (s AuditStore) Consume(call Call, operation string) (receiptRecord, error) {
	if err := validateIdentity(call.Identity); err != nil {
		return receiptRecord{}, err
	}
	if !validID(call.ExecutorID) || !validID(call.AuditID) {
		return receiptRecord{}, errors.New("invalid execution receipt")
	}
	if err := validateOperationAction(operation, call.Action); err != nil {
		return receiptRecord{}, err
	}
	argumentsSHA256, err := canonicalArgumentsSHA256(call.Arguments)
	if err != nil {
		return receiptRecord{}, fmt.Errorf("invalid execution arguments: %w", err)
	}
	path := filepath.Join(s.Dir, "receipts", call.ExecutorID+".json")
	var record receiptRecord
	if err := atomicfile.ReadJSON(path, &record); err != nil {
		if os.IsNotExist(err) {
			return receiptRecord{}, errors.New("execution receipt is missing or already consumed")
		}
		return receiptRecord{}, fmt.Errorf("load execution receipt: %w", err)
	}
	if record.AuditID != call.AuditID ||
		record.ExecutorID != call.ExecutorID ||
		record.Target != call.Target ||
		record.RunID != call.RunID ||
		record.ScopeID != call.ScopeID ||
		record.LifecycleID != call.LifecycleID ||
		record.ToolCallID != call.ToolCallID ||
		record.ExecutionContext != call.ExecutionContext ||
		record.Operation != operation ||
		record.Action != call.Action ||
		subtle.ConstantTimeCompare([]byte(record.ArgumentsSHA256), []byte(argumentsSHA256)) != 1 {
		return receiptRecord{}, errors.New("execution call does not match its audit receipt")
	}
	now := s.now()
	if record.CreatedAt.IsZero() || record.CreatedAt.After(now.Add(time.Minute)) || now.Sub(record.CreatedAt) > time.Hour {
		return receiptRecord{}, errors.New("execution receipt expired")
	}
	if err := os.Remove(path); err != nil {
		if os.IsNotExist(err) {
			return receiptRecord{}, errors.New("execution receipt is missing or already consumed")
		}
		return receiptRecord{}, fmt.Errorf("consume execution receipt: %w", err)
	}
	if err := syncDirectory(filepath.Dir(path)); err != nil {
		return receiptRecord{}, fmt.Errorf("persist consumed execution receipt: %w", err)
	}
	return record, nil
}

func validateOperationAction(operation, action string) error {
	valid := false
	switch operation {
	case "terminal":
		valid = action == "run"
	case "process":
		valid = action == "list" || action == "read" || action == "write" || action == "kill"
	case "read_file":
		valid = action == "read"
	case "write_file":
		valid = action == "write"
	case "patch_file":
		valid = action == "patch"
	case "search_files":
		valid = action == "search"
	}
	if !valid {
		return errors.New("operation and action are not a supported execution binding")
	}
	return nil
}

func canonicalArgumentsSHA256(raw json.RawMessage) (string, error) {
	if len(raw) == 0 {
		return "", errors.New("arguments are required")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return "", err
	}
	if _, ok := value.(map[string]any); !ok {
		return "", errors.New("arguments must be a JSON object")
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return "", errors.New("arguments must contain exactly one JSON value")
	}
	canonical, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(canonical)
	return hex.EncodeToString(digest[:]), nil
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func (s AuditStore) Started(call Call, details any) error {
	if s.Log == nil {
		return nil
	}
	return s.Log.Append(logstore.Event{At: s.now(), Type: "execution.started", AuditID: call.AuditID, ExecutorID: call.ExecutorID, Target: call.Target, RunID: call.RunID, ScopeID: call.ScopeID, ToolCallID: call.ToolCallID, Details: details})
}
func (s AuditStore) Finished(call Call, result any, err error) error {
	if s.Log == nil {
		return nil
	}
	event := logstore.Event{At: s.now(), Type: "execution.finished", AuditID: call.AuditID, ExecutorID: call.ExecutorID, Target: call.Target, RunID: call.RunID, ScopeID: call.ScopeID, ToolCallID: call.ToolCallID, Result: result}
	if err != nil {
		event.Error = err.Error()
	}
	return s.Log.Append(event)
}
func (s AuditStore) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}
func validateIdentity(value Identity) error {
	if value.RunID == "" || value.ScopeID == "" || value.LifecycleID == "" || value.ToolCallID == "" || value.ExecutionContext.SandboxID == "" || value.ExecutionContext.WorkspaceID == "" {
		return errors.New("execution identity is incomplete")
	}
	return nil
}
func randomID(prefix string) (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(value), nil
}
func validID(value string) bool {
	if value == "" || len(value) > 160 {
		return false
	}
	for _, r := range value {
		if !(r == '_' || r == '-' || r == '.' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') {
			return false
		}
	}
	return true
}
