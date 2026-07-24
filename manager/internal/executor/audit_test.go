package executor

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func recordAuditForTest(t *testing.T, store AuditStore, operation, action string, arguments json.RawMessage) (AuditRequest, AuditReceipt) {
	t.Helper()
	request := AuditRequest{
		Identity:  identity(),
		AuditID:   "audit-binding-test",
		Target:    "sandbox",
		Operation: operation,
		Action:    action,
		Arguments: arguments,
		Details:   map[string]any{"display": "[redacted]"},
	}
	receipt, err := store.Record(request)
	if err != nil {
		t.Fatal(err)
	}
	return request, receipt
}

func callForReceipt(request AuditRequest, receipt AuditReceipt, action string, arguments json.RawMessage) Call {
	return Call{
		Identity:   request.Identity,
		AuditID:    receipt.AuditID,
		ExecutorID: receipt.ExecutorID,
		Target:     receipt.Target,
		Action:     action,
		Arguments:  arguments,
	}
}

func TestAuditReceiptBindsCanonicalArgumentsAndIsSingleUse(t *testing.T) {
	now := time.Date(2026, time.July, 24, 12, 0, 0, 0, time.UTC)
	store := AuditStore{Dir: filepath.Join(t.TempDir(), "control"), Now: func() time.Time { return now }}
	request, receipt := recordAuditForTest(
		t,
		store,
		"terminal",
		"run",
		json.RawMessage(`{"cwd":"/workspace","command":"printf safe"}`),
	)

	receiptBytes, err := os.ReadFile(filepath.Join(store.Dir, "receipts", receipt.ExecutorID+".json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(receiptBytes), "printf safe") {
		t.Fatal("receipt persisted raw execution arguments instead of a digest")
	}

	tampered := callForReceipt(
		request,
		receipt,
		"run",
		json.RawMessage(`{"command":"printf malicious","cwd":"/workspace"}`),
	)
	if _, err := store.Consume(tampered, "terminal"); err == nil {
		t.Fatal("tampered command was authorized by a benign audit")
	}

	// Key order and insignificant whitespace do not affect the canonical digest.
	legitimate := callForReceipt(
		request,
		receipt,
		"run",
		json.RawMessage(`{ "command": "printf safe", "cwd": "/workspace" }`),
	)
	if _, err := store.Consume(legitimate, "terminal"); err != nil {
		t.Fatal(err)
	}
	now = now.Add(59 * time.Minute)
	if _, err := store.Consume(legitimate, "terminal"); err == nil {
		t.Fatal("consumed execution receipt was replayed during its former one-hour validity window")
	}
}

func TestAuditReceiptRejectsPathAndActionTamperingWithoutBeingConsumed(t *testing.T) {
	store := AuditStore{Dir: filepath.Join(t.TempDir(), "control")}
	request, receipt := recordAuditForTest(
		t,
		store,
		"read_file",
		"read",
		json.RawMessage(`{"path":"/workspace/safe.txt","offset":0}`),
	)

	pathTamper := callForReceipt(
		request,
		receipt,
		"read",
		json.RawMessage(`{"path":"/etc/shadow","offset":0}`),
	)
	if _, err := store.Consume(pathTamper, "read_file"); err == nil {
		t.Fatal("tampered path was authorized")
	}
	actionTamper := callForReceipt(request, receipt, "write", request.Arguments)
	if _, err := store.Consume(actionTamper, "write_file"); err == nil {
		t.Fatal("tampered operation/action was authorized")
	}

	legitimate := callForReceipt(request, receipt, "read", request.Arguments)
	if _, err := store.Consume(legitimate, "read_file"); err != nil {
		t.Fatalf("tampering attempt consumed the legitimate receipt: %v", err)
	}
}

func TestAuditReceiptConcurrentConsumptionAllowsExactlyOneCaller(t *testing.T) {
	store := AuditStore{Dir: filepath.Join(t.TempDir(), "control")}
	request, receipt := recordAuditForTest(t, store, "process", "list", json.RawMessage(`{}`))
	call := callForReceipt(request, receipt, "list", request.Arguments)

	const callers = 32
	var successes atomic.Int32
	var wait sync.WaitGroup
	wait.Add(callers)
	for range callers {
		go func() {
			defer wait.Done()
			if _, err := store.Consume(call, "process"); err == nil {
				successes.Add(1)
			}
		}()
	}
	wait.Wait()
	if successes.Load() != 1 {
		t.Fatalf("expected exactly one receipt consumer, got %d", successes.Load())
	}
}

func TestAuditRejectsUnsupportedOperationActionPair(t *testing.T) {
	store := AuditStore{Dir: filepath.Join(t.TempDir(), "control")}
	request := AuditRequest{
		Identity:  identity(),
		AuditID:   "audit-invalid-binding",
		Target:    "sandbox",
		Operation: "terminal",
		Action:    "read",
		Arguments: json.RawMessage(`{}`),
		Details:   map[string]any{},
	}
	if _, err := store.Record(request); err == nil {
		t.Fatal("unsupported operation/action pair was audited")
	}
}
