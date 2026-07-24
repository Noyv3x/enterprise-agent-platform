package control

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/journal"
	"github.com/ubitech/agent-platform/manager/internal/model"
)

func TestAPICapabilityMatrix(t *testing.T) {
	t.Parallel()
	api := &API{
		ControlToken:  "control-token-0123456789abcdef",
		ExecutorToken: "executor-token-0123456789abcdef",
	}
	tests := []struct {
		name       string
		path       string
		authority  string
		wantStatus int
	}{
		{name: "operation rejects missing token", path: "/v1/operations", wantStatus: http.StatusUnauthorized},
		{name: "operation rejects executor token", path: "/v1/operations", authority: "Bearer executor-token-0123456789abcdef", wantStatus: http.StatusUnauthorized},
		{name: "operation rejects raw token", path: "/v1/operations", authority: "control-token-0123456789abcdef", wantStatus: http.StatusUnauthorized},
		{name: "operation rejects malformed bearer", path: "/v1/operations", authority: "Bearer  control-token-0123456789abcdef", wantStatus: http.StatusUnauthorized},
		{name: "operation accepts control token", path: "/v1/operations", authority: "Bearer control-token-0123456789abcdef", wantStatus: http.StatusNotFound},
		{name: "executor rejects missing token", path: "/v1/executor/not-found", wantStatus: http.StatusUnauthorized},
		{name: "executor rejects control token", path: "/v1/executor/not-found", authority: "Bearer control-token-0123456789abcdef", wantStatus: http.StatusUnauthorized},
		{name: "executor rejects raw token", path: "/v1/executor/not-found", authority: "executor-token-0123456789abcdef", wantStatus: http.StatusUnauthorized},
		{name: "executor accepts executor token", path: "/v1/executor/not-found", authority: "Bearer executor-token-0123456789abcdef", wantStatus: http.StatusMethodNotAllowed},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, test.path, nil)
			if test.authority != "" {
				request.Header.Set("Authorization", test.authority)
			}
			response := httptest.NewRecorder()
			api.ServeHTTP(response, request)
			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d; body=%s", response.Code, test.wantStatus, response.Body.String())
			}
		})
	}
}

func TestStatusExposesDurableMaintenanceReservation(t *testing.T) {
	t.Parallel()
	store, err := journal.Open(t.TempDir(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.MutateState(time.Now(), func(state *model.ManagerState) error {
		state.PublicState = model.StateUpdating
		state.Maintenance = true
		state.ActiveOperationID = ""
		state.FinalizePendingOperationID = "op_finalize_pending"
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	api := &API{Store: store, ControlToken: "control-token-0123456789abcdef"}
	request := httptest.NewRequest(http.MethodGet, "/v1/status", nil)
	request.Header.Set("Authorization", "Bearer control-token-0123456789abcdef")
	response := httptest.NewRecorder()
	api.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
	var status struct {
		Maintenance                *bool   `json:"maintenance"`
		ActiveOperationID          *string `json:"active_operation_id"`
		FinalizePendingOperationID *string `json:"finalize_pending_operation_id"`
		OperationID                *string `json:"operation_id"`
	}
	if err := json.NewDecoder(response.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	if status.Maintenance == nil || !*status.Maintenance {
		t.Fatalf("maintenance = %v, want explicit true", status.Maintenance)
	}
	if status.ActiveOperationID == nil || *status.ActiveOperationID != "" {
		t.Fatalf("active_operation_id = %v, want explicit empty string", status.ActiveOperationID)
	}
	if status.FinalizePendingOperationID == nil || *status.FinalizePendingOperationID != "op_finalize_pending" {
		t.Fatalf("finalize_pending_operation_id = %v", status.FinalizePendingOperationID)
	}
	if status.OperationID == nil || *status.OperationID != "op_finalize_pending" {
		t.Fatalf("operation_id = %v, want finalize-pending operation", status.OperationID)
	}
}
