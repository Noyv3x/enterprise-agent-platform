package control

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/atomicfile"
	"github.com/ubitech/agent-platform/manager/internal/driver"
	"github.com/ubitech/agent-platform/manager/internal/journal"
	"github.com/ubitech/agent-platform/manager/internal/model"
	"github.com/ubitech/agent-platform/manager/internal/operation"
)

type statusReporter struct {
	driver.Engine
	services map[string]driver.FixedServiceState
}

type identityMustNotProbeDocker struct{ driver.Engine }

func (identityMustNotProbeDocker) FixedServiceStatus(context.Context) map[string]driver.FixedServiceState {
	panic("identity endpoint called Docker service reporter")
}

func (s statusReporter) FixedServiceStatus(context.Context) map[string]driver.FixedServiceState {
	return s.services
}

func TestAPICapabilityMatrix(t *testing.T) {
	t.Parallel()
	api := &API{
		ControlToken:   "control-token-0123456789abcdef",
		ExecutorToken:  "executor-token-0123456789abcdef",
		ManagerVersion: strings.Repeat("a", 40),
		ManagerSHA256:  strings.Repeat("b", 64),
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
		{name: "identity rejects missing token", path: "/v1/identity", wantStatus: http.StatusUnauthorized},
		{name: "identity rejects executor token", path: "/v1/identity", authority: "Bearer executor-token-0123456789abcdef", wantStatus: http.StatusUnauthorized},
		{name: "identity accepts control token", path: "/v1/identity", authority: "Bearer control-token-0123456789abcdef", wantStatus: http.StatusOK},
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

func TestIdentityIsStrictAndDoesNotProbeManagedServices(t *testing.T) {
	t.Parallel()
	api := &API{
		Engine:         identityMustNotProbeDocker{},
		ControlToken:   "control-token-0123456789abcdef",
		ManagerVersion: strings.Repeat("c", 40),
		ManagerSHA256:  strings.Repeat("d", 64),
	}
	request := httptest.NewRequest(http.MethodGet, "/v1/identity", nil)
	request.Header.Set("Authorization", "Bearer control-token-0123456789abcdef")
	response := httptest.NewRecorder()
	api.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("identity status = %d; body=%s", response.Code, response.Body.String())
	}
	var identity map[string]string
	if err := json.Unmarshal(response.Body.Bytes(), &identity); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"status": "healthy", "version": strings.Repeat("c", 40), "sha256": strings.Repeat("d", 64)}
	if len(identity) != len(want) {
		t.Fatalf("identity fields = %#v, want exactly %#v", identity, want)
	}
	for key, value := range want {
		if identity[key] != value {
			t.Fatalf("identity[%s] = %q, want %q", key, identity[key], value)
		}
	}

	api.ManagerSHA256 = "invalid"
	response = httptest.NewRecorder()
	api.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("invalid identity status = %d, want 503", response.Code)
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

func TestStatusReportsEveryCoreServiceWithoutAssumingUnknownIsHealthy(t *testing.T) {
	store, err := journal.Open(t.TempDir(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	api := &API{
		Store: store,
		Engine: statusReporter{services: map[string]driver.FixedServiceState{
			"platform":                {Status: "healthy"},
			"agent-runtime":           {Status: "healthy"},
			"camofox":                 {Status: "healthy"},
			"searxng":                 {Status: "healthy"},
			"firecrawl-playwright":    {Status: "healthy"},
			"firecrawl-redis":         {Status: "healthy"},
			"firecrawl-rabbitmq":      {Status: "healthy"},
			"firecrawl-postgres":      {Status: "healthy"},
			"firecrawl-api":           {Status: "starting"},
			"not-a-supported-service": {Status: "healthy"},
		}},
		ControlToken: "control-token-0123456789abcdef",
	}
	status, _ := requestManagerStatus(t, api)
	services, ok := status["services"].(map[string]any)
	if !ok {
		t.Fatalf("status services = %#v", status["services"])
	}
	if len(services) != 10 {
		t.Fatalf("status exposed %d services, want Manager plus nine fixed services: %#v", len(services), services)
	}
	for name, expected := range map[string]string{
		"manager":              "healthy",
		"platform":             "healthy",
		"agent-runtime":        "healthy",
		"camofox":              "healthy",
		"searxng":              "healthy",
		"firecrawl-playwright": "healthy",
		"firecrawl-redis":      "healthy",
		"firecrawl-rabbitmq":   "healthy",
		"firecrawl-postgres":   "healthy",
		"firecrawl-api":        "starting",
	} {
		service, ok := services[name].(map[string]any)
		if !ok || service["status"] != expected {
			t.Fatalf("service %s = %#v, want status %s", name, services[name], expected)
		}
	}
	if _, exists := services["not-a-supported-service"]; exists {
		t.Fatal("status exposed an uncontracted service")
	}
}

func requestManagerStatus(t *testing.T, api *API) (map[string]any, []byte) {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/v1/status", nil)
	request.Header.Set("Authorization", "Bearer control-token-0123456789abcdef")
	response := httptest.NewRecorder()
	api.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
	body := append([]byte(nil), response.Body.Bytes()...)
	var status map[string]any
	if err := json.Unmarshal(body, &status); err != nil {
		t.Fatal(err)
	}
	return status, body
}

func TestStatusOmitsGenerationHostPaths(t *testing.T) {
	dir := t.TempDir()
	store, err := journal.Open(filepath.Join(dir, "state"), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(dir, "manager", "releases", "secret", "manifest.json")
	snapshotPath := filepath.Join(dir, "snapshots", "secret")
	_, err = store.MutateState(time.Now(), func(state *model.ManagerState) error {
		state.LastError = "read " + snapshotPath + ": permission denied"
		state.Current = &model.Generation{
			ID:              strings.Repeat("a", 40),
			ManifestPath:    manifestPath,
			SourceCommit:    strings.Repeat("a", 40),
			DatabaseVersion: 7,
			Images: map[string]string{
				"platform":       "ghcr.io/ubitech/platform@sha256:" + strings.Repeat("b", 64),
				"absolute-path":  snapshotPath,
				"file-uri":       "file:///home/ubitech/private@sha256:" + strings.Repeat("c", 64),
				"embedded-path":  "notice:/home/ubitech/private@sha256:" + strings.Repeat("d", 64),
				"registry-port":  "registry.example:5000/ubitech/platform@sha256:" + strings.Repeat("e", 64),
				"official-image": "redis@sha256:" + strings.Repeat("f", 64),
			},
			RollbackSnapshotPath: snapshotPath,
			ActivatedAt:          time.Unix(100, 0).UTC(),
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	status, body := requestManagerStatus(t, &API{Store: store, ControlToken: "control-token-0123456789abcdef"})
	current, ok := status["current"].(map[string]any)
	if !ok || current["id"] != strings.Repeat("a", 40) || current["source_commit"] != strings.Repeat("a", 40) || current["database_version"] != float64(7) {
		t.Fatalf("generation status projection lost public identity: %#v", status["current"])
	}
	if _, exists := current["manifest_path"]; exists {
		t.Fatalf("generation status exposed manifest_path: %#v", current)
	}
	if _, exists := current["rollback_snapshot_path"]; exists {
		t.Fatalf("generation status exposed rollback_snapshot_path: %#v", current)
	}
	images, ok := current["images"].(map[string]any)
	if !ok || images["platform"] == nil || images["registry-port"] == nil || images["official-image"] == nil ||
		images["absolute-path"] != nil || images["file-uri"] != nil || images["embedded-path"] != nil {
		t.Fatalf("generation status did not constrain image references: %#v", current["images"])
	}
	if status["error"] != "manager operation requires attention" {
		t.Fatalf("manager diagnostic was not projected safely: %#v", status["error"])
	}
	if bytes.Contains(body, []byte(manifestPath)) || bytes.Contains(body, []byte(snapshotPath)) {
		t.Fatalf("generation status exposed a host path: %s", body)
	}
}

func TestAPIProjectsOversizedDiagnosticsWithoutRewritingJournal(t *testing.T) {
	dir := t.TempDir()
	seed, err := journal.Open(dir, time.Unix(100, 0))
	if err != nil {
		t.Fatal(err)
	}
	op, _, err := seed.Begin(model.OperationRequest{
		Kind:               model.OperationUpdate,
		IdempotencyKey:     "oversized-diagnostic",
		ExpectedGeneration: seed.State().Generation,
	}, time.Unix(101, 0))
	if err != nil {
		t.Fatal(err)
	}
	diagnostic := strings.Repeat("retry reservation release\n", 110000)
	completedAt := time.Unix(102, 0).UTC()
	op.Status = model.OperationFailed
	op.Finalized = true
	op.Error = diagnostic
	op.CompletedAt = &completedAt
	for i := 0; i < journal.MaxOperationHistoryEntries+20; i++ {
		op.History = append(op.History, model.PhaseEvent{
			Phase: model.PhaseDraining,
			At:    time.Unix(int64(200+i), 0).UTC(),
			Note:  strings.Repeat("history-note\x1b", 256),
		})
	}
	state := seed.State()
	state.ActiveOperationID = ""
	state.FinalizePendingOperationID = ""
	state.Phase = ""
	state.PublicState = model.StateIdle
	state.Maintenance = false
	state.LastError = diagnostic
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
	wantDiagnostic := journal.BoundDiagnostic(diagnostic)

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
	if status.Error != "manager operation requires attention" || status.PublicState != model.StateIdle || status.Maintenance || status.ActiveOperationID != "" || status.FinalizePendingOperationID != "" {
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

	postBody := `{"operation":"update","idempotency_key":"oversized-diagnostic","expected_generation":0}`
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
		t.Fatal("API observation rewrote journal evidence")
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
