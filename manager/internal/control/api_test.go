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

func TestStatusProjectsWaitingLegacyMigrationSafely(t *testing.T) {
	dir := t.TempDir()
	store, err := journal.Open(filepath.Join(dir, "state"), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(dir, "migration.json")
	legacyPath := filepath.Join(dir, "obsolete-source-checkout")
	largeError := "inspect " + filepath.Join(legacyPath, "recovery-pack") + ": " + strings.Repeat("waiting\x1b\n", 5000)
	plan := migration.Plan{
		SchemaVersion:        1,
		ID:                   "legacy-waiting",
		LegacyRoot:           legacyPath,
		LegacyData:           filepath.Join(legacyPath, "data"),
		DestinationData:      filepath.Join(dir, "current-data"),
		LegacyService:        "enterprise-agent-platform.service",
		ExpectedSourceCommit: strings.Repeat("a", 40),
		OperationID:          "op_install",
		Status:               "committed",
		Entries:              []migration.FileRecord{{Path: filepath.Join(legacyPath, "secret")}},
		Retirement: &migration.Retirement{
			CampaignID: "source-v1-retirement-2026-07",
			Status:     "waiting_readiness",
			StartedAt:  time.Unix(100, 0).UTC(),
			Error:      largeError,
		},
		Error:     largeError,
		CreatedAt: time.Unix(100, 0).UTC(),
		UpdatedAt: time.Unix(101, 0).UTC(),
	}
	if err := atomicfile.WriteJSON(statePath, plan, 0o600); err != nil {
		t.Fatal(err)
	}
	api := &API{
		Store:        store,
		Legacy:       &migration.Service{StatePath: statePath},
		ControlToken: "control-token-0123456789abcdef",
	}
	status, body := requestManagerStatus(t, api)
	projected, ok := status["legacy_migration"].(map[string]any)
	if !ok {
		t.Fatalf("waiting migration projection is missing: %#v", status["legacy_migration"])
	}
	retirement, ok := projected["retirement"].(map[string]any)
	if projected["status"] != "committed" || !ok || retirement["status"] != "waiting_readiness" ||
		retirement["generation_id"] != "" || retirement["error"] != "source retirement preconditions are not satisfied" ||
		projected["error"] != "source retirement preconditions are not satisfied" {
		t.Fatalf("unexpected waiting migration projection: %#v", projected)
	}
	if bytes.Contains(body, []byte(legacyPath)) || bytes.Contains(body, []byte("obsolete-source-checkout")) {
		t.Fatalf("status exposed a legacy host path: %s", body)
	}
	if status["public_state"] != string(model.StateIdle) || status["maintenance"] != false {
		t.Fatalf("migration projection changed serving state: %#v", status)
	}
	if len(body) > 32<<10 {
		t.Fatalf("bounded waiting migration expanded status to %d bytes", len(body))
	}
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

func TestStatusBoundsMalformedLegacyMigrationScalars(t *testing.T) {
	dir := t.TempDir()
	store, err := journal.Open(filepath.Join(dir, "state"), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(dir, "migration.json")
	plan := migration.Plan{
		SchemaVersion: 1,
		ID:            strings.Repeat("<", 64<<10),
		OperationID:   strings.Repeat("<", 64<<10),
		Status:        strings.Repeat("<", 64<<10),
		Retirement: &migration.Retirement{
			CampaignID:   strings.Repeat("<", 64<<10),
			GenerationID: strings.Repeat("<", 64<<10),
			Status:       strings.Repeat("<", 64<<10),
			StartedAt:    time.Unix(100, 0).UTC(),
		},
		CreatedAt: time.Unix(100, 0).UTC(),
		UpdatedAt: time.Unix(101, 0).UTC(),
	}
	if err := atomicfile.WriteJSON(statePath, plan, 0o600); err != nil {
		t.Fatal(err)
	}
	status, body := requestManagerStatus(t, &API{
		Store:        store,
		Legacy:       &migration.Service{StatePath: statePath},
		ControlToken: "control-token-0123456789abcdef",
	})
	projected, ok := status["legacy_migration"].(map[string]any)
	if !ok || projected["status"] != "unavailable" || projected["id"] != "" || projected["operation_id"] != "" {
		t.Fatalf("malformed migration scalars were exposed: %#v", status["legacy_migration"])
	}
	if len(body) > 32<<10 || bytes.Contains(body, []byte("\\u003c\\u003c\\u003c")) {
		t.Fatalf("malformed migration amplified status to %d bytes", len(body))
	}
}

func TestStatusProjectsCompletedLegacyRetirementReceipt(t *testing.T) {
	dir := t.TempDir()
	store, err := journal.Open(filepath.Join(dir, "state"), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	startedAt := time.Unix(100, 0).UTC()
	completedAt := time.Unix(110, 0).UTC()
	plan := migration.Plan{
		SchemaVersion:        1,
		ID:                   "legacy-purged",
		ExpectedSourceCommit: strings.Repeat("a", 40),
		OperationID:          "op_install",
		Status:               "purged",
		Retirement: &migration.Retirement{
			CampaignID:         "source-v1-retirement-2026-07",
			GenerationID:       strings.Repeat("b", 40),
			Status:             "completed",
			SystemdRemoved:     true,
			SourceStateRemoved: true,
			DockerRemoved:      true,
			RecoveryRemoved:    true,
			StartedAt:          startedAt,
			CompletedAt:        completedAt,
		},
		CreatedAt: startedAt,
		UpdatedAt: completedAt,
	}
	statePath := filepath.Join(dir, "migration.json")
	if err := atomicfile.WriteJSON(statePath, plan, 0o600); err != nil {
		t.Fatal(err)
	}
	api := &API{
		Store:        store,
		Legacy:       &migration.Service{StatePath: statePath},
		ControlToken: "control-token-0123456789abcdef",
	}
	status, _ := requestManagerStatus(t, api)
	projected, ok := status["legacy_migration"].(map[string]any)
	if !ok || projected["status"] != "purged" {
		t.Fatalf("completed migration projection is missing: %#v", status["legacy_migration"])
	}
	retirement, ok := projected["retirement"].(map[string]any)
	if !ok || retirement["status"] != "completed" || retirement["generation_id"] != strings.Repeat("b", 40) || retirement["recovery_removed"] != true {
		t.Fatalf("completed retirement receipt changed: %#v", projected["retirement"])
	}
	if status["public_state"] != string(model.StateIdle) || status["maintenance"] != false {
		t.Fatalf("completed retirement changed serving state: %#v", status)
	}
}

func TestStatusProjectsNoLegacyMigrationAsNull(t *testing.T) {
	for _, test := range []struct {
		name   string
		legacy *migration.Service
	}{
		{name: "integration disabled"},
		{name: "journal absent", legacy: &migration.Service{StatePath: filepath.Join(t.TempDir(), "missing-migration.json")}},
	} {
		t.Run(test.name, func(t *testing.T) {
			store, err := journal.Open(t.TempDir(), time.Now())
			if err != nil {
				t.Fatal(err)
			}
			api := &API{Store: store, Legacy: test.legacy, ControlToken: "control-token-0123456789abcdef"}
			status, _ := requestManagerStatus(t, api)
			value, exists := status["legacy_migration"]
			if !exists || value != nil {
				t.Fatalf("legacy_migration = %#v, want explicit null", value)
			}
		})
	}
}

func TestStatusBoundsUnreadableLegacyMigrationWithoutExposingPath(t *testing.T) {
	dir := t.TempDir()
	store, err := journal.Open(filepath.Join(dir, "state"), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	secretRoot := filepath.Join(dir, "private-host-layout")
	statePath := filepath.Join(secretRoot, "migration.json")
	if err := os.MkdirAll(statePath, 0o700); err != nil {
		t.Fatal(err)
	}
	api := &API{
		Store:        store,
		Legacy:       &migration.Service{StatePath: statePath},
		ControlToken: "control-token-0123456789abcdef",
	}
	status, body := requestManagerStatus(t, api)
	projected, ok := status["legacy_migration"].(map[string]any)
	if !ok || projected["status"] != "unavailable" || projected["error"] != "legacy migration status is unavailable" {
		t.Fatalf("unreadable migration was not safely projected: %#v", status["legacy_migration"])
	}
	if bytes.Contains(body, []byte(secretRoot)) || bytes.Contains(body, []byte(statePath)) || bytes.Contains(body, []byte("private-host-layout")) {
		t.Fatalf("unreadable migration exposed its host path: %s", body)
	}
	if len(projected["error"].(string)) > journal.MaxDiagnosticBytes {
		t.Fatalf("unreadable migration diagnostic is unbounded: %d", len(projected["error"].(string)))
	}
	if status["public_state"] != string(model.StateIdle) || status["maintenance"] != false {
		t.Fatalf("unreadable migration changed serving state: %#v", status)
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
