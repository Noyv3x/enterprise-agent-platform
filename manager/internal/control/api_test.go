package control

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/atomicfile"
	"github.com/ubitech/agent-platform/manager/internal/journal"
	"github.com/ubitech/agent-platform/manager/internal/migration"
	"github.com/ubitech/agent-platform/manager/internal/model"
	"github.com/ubitech/agent-platform/manager/internal/operation"
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

func TestAPIProjectsLegacyOversizedDiagnosticsWithoutRewritingJournal(t *testing.T) {
	dir := t.TempDir()
	seed, err := journal.Open(dir, time.Unix(100, 0))
	if err != nil {
		t.Fatal(err)
	}
	op, _, err := seed.Begin(model.OperationRequest{
		Kind:               model.OperationUpdate,
		IdempotencyKey:     "legacy-oversized-diagnostic",
		ExpectedGeneration: seed.State().Generation,
	}, time.Unix(101, 0))
	if err != nil {
		t.Fatal(err)
	}
	legacyDiagnostic := strings.Repeat("retry reservation release\n", 110000)
	completedAt := time.Unix(102, 0).UTC()
	op.Status = model.OperationFailed
	op.Finalized = true
	op.Error = legacyDiagnostic
	op.CompletedAt = &completedAt
	for i := 0; i < journal.MaxOperationHistoryEntries+20; i++ {
		op.History = append(op.History, model.PhaseEvent{
			Phase: model.PhaseDraining,
			At:    time.Unix(int64(200+i), 0).UTC(),
			Note:  strings.Repeat("legacy-history-note\x1b", 256),
		})
	}
	state := seed.State()
	state.ActiveOperationID = ""
	state.FinalizePendingOperationID = ""
	state.Phase = ""
	state.PublicState = model.StateIdle
	state.Maintenance = false
	state.LastError = legacyDiagnostic
	statePath := filepath.Join(dir, "state.json")
	opPath := filepath.Join(dir, "operations", op.ID+".json")
	if err := atomicfile.WriteJSON(statePath, state, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := atomicfile.WriteJSON(opPath, op, 0o600); err != nil {
		t.Fatal(err)
	}
	stateBefore, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	opBefore, err := os.ReadFile(opPath)
	if err != nil {
		t.Fatal(err)
	}

	store, err := journal.Open(dir, time.Unix(103, 0))
	if err != nil {
		t.Fatal(err)
	}
	api := &API{
		Store:        store,
		Operations:   &operation.Orchestrator{Store: store},
		ControlToken: "control-token-0123456789abcdef",
	}
	request := func(method, path, body string) *httptest.ResponseRecorder {
		var reader *strings.Reader
		if body != "" {
			reader = strings.NewReader(body)
		} else {
			reader = strings.NewReader("")
		}
		req := httptest.NewRequest(method, path, reader)
		req.Header.Set("Authorization", "Bearer control-token-0123456789abcdef")
		response := httptest.NewRecorder()
		api.ServeHTTP(response, req)
		return response
	}
	wantDiagnostic := journal.BoundDiagnostic(legacyDiagnostic)

	statusResponse := request(http.MethodGet, "/v1/status", "")
	if statusResponse.Code != http.StatusOK || statusResponse.Body.Len() >= 1<<20 {
		t.Fatalf("oversized status projection: status=%d bytes=%d", statusResponse.Code, statusResponse.Body.Len())
	}
	var status struct {
		Error                      string            `json:"error"`
		PublicState                model.PublicState `json:"public_state"`
		Maintenance                bool              `json:"maintenance"`
		ActiveOperationID          string            `json:"active_operation_id"`
		FinalizePendingOperationID string            `json:"finalize_pending_operation_id"`
	}
	if err := json.NewDecoder(statusResponse.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	if status.Error != wantDiagnostic || status.PublicState != model.StateIdle || status.Maintenance || status.ActiveOperationID != "" || status.FinalizePendingOperationID != "" {
		t.Fatalf("status projection changed durable semantics: %#v", status)
	}

	operationResponse := request(http.MethodGet, "/v1/operations/"+op.ID, "")
	if operationResponse.Code != http.StatusOK || operationResponse.Body.Len() >= 1<<20 {
		t.Fatalf("oversized operation projection: status=%d bytes=%d", operationResponse.Code, operationResponse.Body.Len())
	}
	var projected model.Operation
	if err := json.NewDecoder(operationResponse.Body).Decode(&projected); err != nil {
		t.Fatal(err)
	}
	if projected.ID != op.ID || projected.Status != model.OperationFailed || projected.Error != wantDiagnostic || len(projected.History) != journal.MaxOperationHistoryEntries {
		t.Fatalf("operation projection changed durable semantics: %#v", projected)
	}
	for _, event := range projected.History {
		if len(event.Note) > journal.MaxHistoryNoteBytes {
			t.Fatalf("operation projection left an oversized history note: %d", len(event.Note))
		}
	}

	postBody := `{"operation":"update","idempotency_key":"legacy-oversized-diagnostic","expected_generation":0}`
	startResponse := request(http.MethodPost, "/v1/operations", postBody)
	if startResponse.Code != http.StatusAccepted || startResponse.Body.Len() >= 1<<20 {
		t.Fatalf("oversized idempotent operation response: status=%d bytes=%d body=%s", startResponse.Code, startResponse.Body.Len(), startResponse.Body.String())
	}
	var started struct {
		Operation model.Operation `json:"operation"`
		Reused    bool            `json:"reused"`
	}
	if err := json.NewDecoder(startResponse.Body).Decode(&started); err != nil {
		t.Fatal(err)
	}
	if !started.Reused || started.Operation.ID != op.ID || started.Operation.Error != wantDiagnostic {
		t.Fatalf("idempotent operation was not safely projected: %#v", started)
	}

	stateAfter, _ := os.ReadFile(statePath)
	opAfter, _ := os.ReadFile(opPath)
	if !bytes.Equal(stateBefore, stateAfter) || !bytes.Equal(opBefore, opAfter) {
		t.Fatal("API observation rewrote legacy journal evidence")
	}
}

func TestLegacyMigrationStatusReturnsOnlyBoundedProgressProjection(t *testing.T) {
	dir := t.TempDir()
	statePath := filepath.Join(dir, "migration.json")
	largeError := strings.Repeat("external migration failure\x1b\n", 5000)
	plan := migration.Plan{
		SchemaVersion: 1,
		ID:            "legacy-bounded-status",
		OperationID:   "op_legacy",
		Status:        "failed",
		Entries:       make([]migration.FileRecord, 10000),
		Quarantined:   make([]string, 10000),
		Error:         largeError,
		Retirement: &migration.Retirement{
			CampaignID:         "source-v1-retirement-2026-07",
			GenerationID:       strings.Repeat("a", 40),
			Status:             "source_state_removed",
			SystemdRemoved:     true,
			SourceStateRemoved: true,
			Error:              largeError,
			StartedAt:          time.Unix(100, 0).UTC(),
		},
		CreatedAt: time.Unix(100, 0).UTC(),
		UpdatedAt: time.Unix(101, 0).UTC(),
	}
	for index := range plan.Entries {
		plan.Entries[index].Path = strings.Repeat("inventory-path/", 5)
		plan.Quarantined[index] = strings.Repeat("quarantine-path/", 5)
	}
	if err := atomicfile.WriteJSON(statePath, plan, 0o600); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	api := &API{
		Legacy:       &migration.Service{StatePath: statePath},
		ControlToken: "control-token-0123456789abcdef",
	}
	request := httptest.NewRequest(http.MethodGet, "/v1/migrations/legacy", nil)
	request.Header.Set("Authorization", "Bearer control-token-0123456789abcdef")
	response := httptest.NewRecorder()
	api.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.Len() >= 1<<20 {
		t.Fatalf("migration projection status=%d bytes=%d", response.Code, response.Body.Len())
	}
	var projected map[string]any
	if err := json.NewDecoder(response.Body).Decode(&projected); err != nil {
		t.Fatal(err)
	}
	if projected["id"] != plan.ID || projected["status"] != plan.Status || projected["entry_count"] != float64(len(plan.Entries)) || projected["quarantined_count"] != float64(len(plan.Quarantined)) {
		t.Fatalf("migration progress semantics changed: %#v", projected)
	}
	errorText, _ := projected["error"].(string)
	if errorText != journal.BoundDiagnostic(largeError) {
		t.Fatalf("migration diagnostic was not bounded: %d bytes", len(errorText))
	}
	if _, exists := projected["entries"]; exists {
		t.Fatal("migration status exposed the unbounded inventory")
	}
	retirement, ok := projected["retirement"].(map[string]any)
	if !ok || retirement["campaign_id"] != plan.Retirement.CampaignID || retirement["status"] != plan.Retirement.Status || retirement["systemd_removed"] != true {
		t.Fatalf("retirement receipt was not safely projected: %#v", projected["retirement"])
	}
	if retirement["error"] != journal.BoundDiagnostic(largeError) {
		t.Fatal("retirement diagnostic was not bounded")
	}
	for _, forbidden := range []string{"legacy_root", "legacy_data", "archive_path", "unit_path"} {
		if _, exists := retirement[forbidden]; exists {
			t.Fatalf("retirement projection exposed host path field %s", forbidden)
		}
	}
	after, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("migration status observation rewrote durable evidence")
	}
}

func TestWriteJSONEncodesBeforeCommittingSuccess(t *testing.T) {
	t.Parallel()
	response := httptest.NewRecorder()
	writeJSON(response, http.StatusAccepted, make(chan int))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusInternalServerError)
	}
	var failure map[string]string
	if err := json.NewDecoder(response.Body).Decode(&failure); err != nil {
		t.Fatalf("decode structured encoding failure: %v", err)
	}
	if failure["error"] != "encode manager response" {
		t.Fatalf("unexpected failure response: %#v", failure)
	}
}

func TestMigrationConfigurationAcknowledgementIsBounded(t *testing.T) {
	t.Parallel()
	plan := migration.Plan{
		ID:                   "migration-1",
		Status:               "configured",
		ExpectedSourceCommit: strings.Repeat("a", 40),
		Entries:              []migration.FileRecord{{Path: strings.Repeat("large-entry", 1<<18)}},
	}
	data, err := json.Marshal(migrationConfigurationAcknowledgement(plan))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(data, []byte("large-entry")) || bytes.Contains(data, []byte("entries")) {
		t.Fatalf("configuration acknowledgement leaked the unbounded migration inventory")
	}
	if len(data) > 512 {
		t.Fatalf("configuration acknowledgement is unexpectedly large: %d bytes", len(data))
	}
}
