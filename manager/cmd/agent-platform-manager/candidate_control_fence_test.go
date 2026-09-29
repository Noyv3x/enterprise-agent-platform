package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/control"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/journal"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
)

func TestPendingCandidateControlHandlerOpensOnlyIdentityUntilPromotion(t *testing.T) {
	store, err := journal.Open(filepath.Join(t.TempDir(), "state"), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	full := &control.API{
		Store: store, ControlToken: "control-token", ExecutorToken: "executor-token",
		ManagerVersion: strings.Repeat("a", 40), ManagerSHA256: strings.Repeat("b", 64),
	}
	handler := newServeControlHandler(full, true)

	for _, test := range []struct {
		name     string
		method   string
		path     string
		token    string
		wantCode int
	}{
		{name: "identity", method: http.MethodGet, path: "/v1/identity", token: full.ControlToken, wantCode: http.StatusOK},
		{name: "unauthenticated identity", method: http.MethodGet, path: "/v1/identity", token: "wrong-token", wantCode: http.StatusUnauthorized},
		{name: "status", method: http.MethodGet, path: "/v1/status", token: full.ControlToken, wantCode: http.StatusNotFound},
		{name: "operation mutation", method: http.MethodPost, path: "/v1/operations", token: full.ControlToken, wantCode: http.StatusNotFound},
		{name: "executor token", method: http.MethodPost, path: "/v1/executor/processes", token: full.ExecutorToken, wantCode: http.StatusUnauthorized},
	} {
		t.Run("fenced "+test.name, func(t *testing.T) {
			if code := candidateControlRequest(handler, test.method, test.path, test.token); code != test.wantCode {
				t.Fatalf("status = %d, want %d", code, test.wantCode)
			}
		})
	}

	handler.promote(full)
	if code := candidateControlRequest(handler, http.MethodGet, "/v1/status", full.ControlToken); code != http.StatusOK {
		t.Fatalf("full status after promotion = %d, want %d", code, http.StatusOK)
	}
}

func TestRecoveryControlStatusAllowsPlatformGateReadWithoutOpeningMutations(t *testing.T) {
	store, err := journal.Open(filepath.Join(t.TempDir(), "state"), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	op, _, err := store.Begin(model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: "fallback-recovery", ExpectedGeneration: store.State().Generation}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.MutateState(time.Now(), func(state *model.ManagerState) error {
		state.Maintenance = true
		state.Current = &model.Generation{ID: strings.Repeat("a", 40), SourceCommit: strings.Repeat("a", 40)}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	full := &control.API{Store: store, ControlToken: "control-token", ExecutorToken: "executor-token", ManagerVersion: strings.Repeat("a", 40), ManagerSHA256: strings.Repeat("b", 64)}
	handler := newServeControlHandler(full, true)
	handler.allowRecoveryStatus(full)
	server := httptest.NewServer(handler)
	defer server.Close()
	request, err := http.NewRequest(http.MethodGet, server.URL+"/v1/status", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+full.ControlToken)
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var status map[string]json.RawMessage
	if response.StatusCode != http.StatusOK {
		t.Fatalf("Platform recovery status = %d", response.StatusCode)
	}
	if err := json.NewDecoder(response.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	if settlement, present := status["gate_settlement"]; !present || string(settlement) != "null" {
		t.Fatalf("recovery status lost explicit unsettled gate: %s", settlement)
	}
	var operationID string
	if err := json.Unmarshal(status["active_operation_id"], &operationID); err != nil || operationID != op.ID || string(status["maintenance"]) != "true" {
		t.Fatalf("recovery status lost original gate owner/maintenance: %+v error=%v", status, err)
	}
	for _, test := range []struct {
		method, path, token string
		code                int
	}{
		{http.MethodGet, "/v1/status", "wrong-token", http.StatusUnauthorized},
		{http.MethodGet, "/v1/status", full.ExecutorToken, http.StatusUnauthorized},
		{http.MethodPost, "/v1/status", full.ControlToken, http.StatusNotFound},
		{http.MethodPost, "/v1/operations", full.ControlToken, http.StatusNotFound},
		{http.MethodGet, "/v1/config", full.ControlToken, http.StatusNotFound},
		{http.MethodPost, "/v1/executor/processes", full.ExecutorToken, http.StatusUnauthorized},
	} {
		if code := candidateControlRequest(handler, test.method, test.path, test.token); code != test.code {
			t.Fatalf("recovery capability %s %s = %d, want %d", test.method, test.path, code, test.code)
		}
	}
}

func TestPendingCandidateControlHandlerPromotionIsRaceSafe(t *testing.T) {
	store, err := journal.Open(filepath.Join(t.TempDir(), "state"), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	full := &control.API{
		Store: store, ControlToken: "control-token", ExecutorToken: "executor-token",
		ManagerVersion: strings.Repeat("a", 40), ManagerSHA256: strings.Repeat("b", 64),
	}
	handler := newServeControlHandler(full, true)
	start := make(chan struct{})
	var workers sync.WaitGroup
	for worker := 0; worker < 12; worker++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			for attempt := 0; attempt < 100; attempt++ {
				identity := candidateControlRequest(handler, http.MethodGet, "/v1/identity", full.ControlToken)
				if identity != http.StatusOK {
					t.Errorf("identity during promotion = %d", identity)
					return
				}
				status := candidateControlRequest(handler, http.MethodGet, "/v1/status", full.ControlToken)
				if status != http.StatusNotFound && status != http.StatusOK {
					t.Errorf("status during promotion = %d", status)
					return
				}
			}
		}()
	}
	close(start)
	handler.promote(full)
	workers.Wait()
}

func candidateControlRequest(handler http.Handler, method, path, token string) int {
	request := httptest.NewRequest(method, path, nil)
	request.Header.Set("Authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response.Code
}
