package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/model"
)

type stateStub struct{ value model.ManagerState }

func (s stateStub) State() model.ManagerState { return s.value }
func TestMaintenancePageContainsOnlyPublicState(t *testing.T) {
	state := model.NewState(time.Now())
	state.PublicState = model.StateUpdating
	state.Maintenance = true
	state.Phase = model.PhaseMigrating
	state.ActiveOperationID = "op_public"
	state.LastError = "/secret/host/path"
	handler, err := NewHandler(stateStub{state}, "http://127.0.0.1:1")
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))
	body := response.Body.String()
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(body, "op_public") {
		t.Fatalf("unexpected maintenance response: %d %s", response.Code, body)
	}
	if got := response.Header().Get("Refresh"); got != "5" {
		t.Fatalf("Refresh = %q", got)
	}
	if strings.Contains(body, "<script") {
		t.Fatal("maintenance page must not depend on inline script under its strict CSP")
	}
	if strings.Contains(body, "secret/host") {
		t.Fatal("private diagnostic leaked to public maintenance page")
	}
}

func TestMaintenanceStatusUsesFinalizePendingOperation(t *testing.T) {
	t.Parallel()
	state := model.NewState(time.Now())
	state.PublicState = model.StateUpdating
	state.Maintenance = true
	state.FinalizePendingOperationID = "op_finalize_pending"
	handler, err := NewHandler(stateStub{state}, "http://127.0.0.1:1")
	if err != nil {
		t.Fatal(err)
	}

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/__ubitech/status", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
	var status struct {
		OperationID string `json:"operation_id"`
	}
	if err := json.NewDecoder(response.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	if status.OperationID != "op_finalize_pending" {
		t.Fatalf("operation_id = %q, want finalize-pending operation", status.OperationID)
	}

	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))
	if !strings.Contains(response.Body.String(), "op_finalize_pending") {
		t.Fatalf("maintenance page omitted finalize-pending operation: %s", response.Body.String())
	}
}
