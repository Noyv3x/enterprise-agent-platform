package operation

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func targetHandoffTestRequest() TargetHandoffCommitRequest {
	return TargetHandoffCommitRequest{
		OperationID:      "handoff_" + strings.Repeat("a", 32),
		TargetGeneration: strings.Repeat("b", 40),
		BindingSHA256:    strings.Repeat("c", 64),
	}
}

func targetHandoffTestReceipt(t *testing.T, request TargetHandoffCommitRequest) TargetHandoffCommitReceipt {
	t.Helper()
	receipt := TargetHandoffCommitReceipt{
		SchemaVersion: targetHandoffSchemaVersion, OperationID: request.OperationID,
		TargetGeneration: request.TargetGeneration, BindingSHA256: request.BindingSHA256,
		DatabaseSchemaVersion: 2026072901, CommittedAt: "2026-07-31T12:34:56.123456Z",
	}
	material := targetHandoffReceiptMaterial{
		BindingSHA256: receipt.BindingSHA256, CommittedAt: receipt.CommittedAt,
		DatabaseSchemaVersion: receipt.DatabaseSchemaVersion, OperationID: receipt.OperationID,
		SchemaVersion: receipt.SchemaVersion, TargetGeneration: receipt.TargetGeneration,
	}
	encoded, err := json.Marshal(material)
	if err != nil {
		t.Fatal(err)
	}
	receipt.ReceiptSHA256 = fmt.Sprintf("%x", sha256.Sum256(encoded))
	if receipt.ReceiptSHA256 != "d88b7e48f47f0d3337d3a11a66a9fb3a863145127f5dd49b28ab7e280f35037b" {
		t.Fatalf("cross-runtime receipt digest = %s", receipt.ReceiptSHA256)
	}
	return receipt
}

func TestHTTPGateCommitsExactTargetHandoffReceipt(t *testing.T) {
	request := targetHandoffTestRequest()
	receipt := targetHandoffTestReceipt(t, request)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, incoming *http.Request) {
		if incoming.Method != http.MethodPost || incoming.URL.Path != "/internal/manager/handoff/commit-release" {
			t.Fatalf("request = %s %s", incoming.Method, incoming.URL.Path)
		}
		if incoming.Header.Get("Authorization") != "Bearer control-token" {
			t.Fatalf("authorization = %q", incoming.Header.Get("Authorization"))
		}
		decoder := json.NewDecoder(incoming.Body)
		decoder.DisallowUnknownFields()
		var got TargetHandoffCommitRequest
		if err := decoder.Decode(&got); err != nil || got != request {
			t.Fatalf("request = %#v err=%v", got, err)
		}
		_ = json.NewEncoder(response).Encode(targetHandoffCommitResponse{Released: true, Receipt: receipt})
	}))
	defer server.Close()

	got, err := (HTTPGate{BaseURL: server.URL, Token: "control-token", Client: server.Client()}).CommitTargetHandoff(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if got != receipt {
		t.Fatalf("receipt = %#v, want %#v", got, receipt)
	}
}

func TestHTTPGateRejectsNonClosedTargetHandoffResponses(t *testing.T) {
	request := targetHandoffTestRequest()
	receipt := targetHandoffTestReceipt(t, request)
	valid, err := json.Marshal(targetHandoffCommitResponse{Released: true, Receipt: receipt})
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name string
		body string
	}{
		{name: "unknown", body: strings.TrimSuffix(string(valid), "}") + `,"unknown":true}`},
		{name: "duplicate", body: strings.TrimSuffix(string(valid), "}") + `,"released":true}`},
		{name: "trailing", body: string(valid) + `{}`},
		{name: "oversize", body: strings.Repeat(" ", targetHandoffResponseLimit+1)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				_, _ = response.Write([]byte(test.body))
			}))
			defer server.Close()
			if _, err := (HTTPGate{BaseURL: server.URL, Client: server.Client()}).CommitTargetHandoff(context.Background(), request); err == nil {
				t.Fatal("non-closed response was accepted")
			}
		})
	}
}

func TestHTTPGateRejectsTargetHandoffReceiptIdentityAndDigest(t *testing.T) {
	request := targetHandoffTestRequest()
	for _, mutate := range []func(*TargetHandoffCommitReceipt){
		func(receipt *TargetHandoffCommitReceipt) { receipt.TargetGeneration = strings.Repeat("d", 40) },
		func(receipt *TargetHandoffCommitReceipt) { receipt.ReceiptSHA256 = strings.Repeat("0", 64) },
	} {
		receipt := targetHandoffTestReceipt(t, request)
		mutate(&receipt)
		server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(response).Encode(targetHandoffCommitResponse{Released: true, Receipt: receipt})
		}))
		_, err := (HTTPGate{BaseURL: server.URL, Client: server.Client()}).CommitTargetHandoff(context.Background(), request)
		server.Close()
		if err == nil {
			t.Fatal("conflicting target handoff receipt was accepted")
		}
	}
}

func TestHTTPGateObservesExactTargetHandoffReservation(t *testing.T) {
	request := targetHandoffTestRequest()
	receipt := targetHandoffTestReceipt(t, request)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, incoming *http.Request) {
		if incoming.Method != http.MethodGet || incoming.URL.Path != "/internal/manager/handoff/reservation" {
			t.Fatalf("request = %s %s", incoming.Method, incoming.URL.Path)
		}
		_ = json.NewEncoder(response).Encode(TargetHandoffReservationObservation{
			SchemaVersion: targetHandoffSchemaVersion, Reserved: true,
			ReservationID: request.OperationID, ReservationOwner: "manager", Receipt: &receipt,
		})
	}))
	defer server.Close()
	observed, err := (HTTPGate{BaseURL: server.URL, Client: server.Client()}).ObserveTargetHandoff(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if !observed.Reserved || observed.Receipt == nil || *observed.Receipt != receipt {
		t.Fatalf("observation = %#v", observed)
	}
}

func TestHTTPGateTargetHandoffCommitCanRetryAmbiguousResponse(t *testing.T) {
	request := targetHandoffTestRequest()
	receipt := targetHandoffTestReceipt(t, request)
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) == 1 {
			_, _ = response.Write([]byte(`{"released":true,"receipt":`))
			return
		}
		_ = json.NewEncoder(response).Encode(targetHandoffCommitResponse{Released: true, Receipt: receipt})
	}))
	defer server.Close()
	gate := HTTPGate{BaseURL: server.URL, Client: server.Client()}
	if _, err := gate.CommitTargetHandoff(context.Background(), request); err == nil {
		t.Fatal("truncated response was accepted")
	}
	got, err := gate.CommitTargetHandoff(context.Background(), request)
	if err != nil || got != receipt {
		t.Fatalf("retry receipt=%#v err=%v", got, err)
	}
}
