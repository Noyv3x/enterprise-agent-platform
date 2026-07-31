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

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/driver"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/journal"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/operation"
)

type statusReporter struct {
	driver.Engine
	services map[string]driver.FixedServiceState
}

type statusReporterFunc struct {
	driver.Engine
	report func(context.Context) map[string]driver.FixedServiceState
}

type identityMustNotProbeDocker struct{ driver.Engine }

func (identityMustNotProbeDocker) FixedServiceStatus(context.Context) map[string]driver.FixedServiceState {
	panic("identity endpoint called Docker service reporter")
}

func (s statusReporter) FixedServiceStatus(context.Context) map[string]driver.FixedServiceState {
	return s.services
}

func (s statusReporterFunc) FixedServiceStatus(ctx context.Context) map[string]driver.FixedServiceState {
	return s.report(ctx)
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

func TestStatusProjectsExactWorkspaceSchemaCommitCapabilities(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name     string
		finalize bool
	}{
		{name: "active P1 update", finalize: false},
		{name: "durable post-complete finalize", finalize: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			store, operationID, targetGeneration := workspaceSchemaCommitStore(t, test.finalize)
			status, _ := requestManagerStatus(t, &API{
				Store:        store,
				ControlToken: "control-token-0123456789abcdef",
			})
			projected, ok := status["workspace_schema_commit"].(map[string]any)
			if !ok {
				t.Fatalf("workspace_schema_commit = %#v", status["workspace_schema_commit"])
			}
			want := map[string]any{
				"schema_version":         float64(1),
				"operation_id":           operationID,
				"predecessor_generation": contract.SourceOwnerCompatGeneration,
				"target_generation":      targetGeneration,
			}
			if len(projected) != len(want) {
				t.Fatalf("workspace_schema_commit fields = %#v, want exactly %#v", projected, want)
			}
			for key, value := range want {
				if projected[key] != value {
					t.Fatalf("workspace_schema_commit[%s] = %#v, want %#v", key, projected[key], value)
				}
			}
		})
	}
}

func TestWorkspaceSchemaCommitProjectionFailsClosedOnJournalOrStateDrift(t *testing.T) {
	t.Parallel()
	mutations := []struct {
		name   string
		mutate func(*model.ManagerState, *model.Operation)
	}{
		{name: "maintenance ended", mutate: func(state *model.ManagerState, _ *model.Operation) {
			state.Maintenance = false
		}},
		{name: "public state changed", mutate: func(state *model.ManagerState, _ *model.Operation) {
			state.PublicState = model.StateIdle
		}},
		{name: "state schema changed", mutate: func(state *model.ManagerState, _ *model.Operation) {
			state.SchemaVersion = 2
		}},
		{name: "active slot appeared", mutate: func(state *model.ManagerState, _ *model.Operation) {
			state.ActiveOperationID = state.FinalizePendingOperationID
		}},
		{name: "finalize slot missing", mutate: func(state *model.ManagerState, _ *model.Operation) {
			state.FinalizePendingOperationID = ""
		}},
		{name: "candidate reappeared", mutate: func(state *model.ManagerState, operation *model.Operation) {
			state.Candidate = targetGeneration(operation.TargetGeneration)
		}},
		{name: "previous id changed", mutate: func(state *model.ManagerState, _ *model.Operation) {
			state.Previous.ID = strings.Repeat("d", 40)
		}},
		{name: "previous source changed", mutate: func(state *model.ManagerState, _ *model.Operation) {
			state.Previous.SourceCommit = strings.Repeat("d", 40)
		}},
		{name: "current source changed", mutate: func(state *model.ManagerState, _ *model.Operation) {
			state.Current.SourceCommit = strings.Repeat("d", 40)
		}},
		{name: "operation kind changed", mutate: func(_ *model.ManagerState, operation *model.Operation) {
			operation.Kind = model.OperationRestart
		}},
		{name: "operation schema changed", mutate: func(_ *model.ManagerState, operation *model.Operation) {
			operation.SchemaVersion = 2
		}},
		{name: "operation id changed", mutate: func(state *model.ManagerState, operation *model.Operation) {
			operation.ID = state.FinalizePendingOperationID[:len(state.FinalizePendingOperationID)-1] + "g"
		}},
		{name: "operation status changed", mutate: func(_ *model.ManagerState, operation *model.Operation) {
			operation.Status = model.OperationRunning
		}},
		{name: "operation finalized", mutate: func(_ *model.ManagerState, operation *model.Operation) {
			operation.Finalized = true
		}},
		{name: "operation phase changed", mutate: func(_ *model.ManagerState, operation *model.Operation) {
			operation.Phase = model.PhaseProbing
		}},
		{name: "reservation not mutation started", mutate: func(_ *model.ManagerState, operation *model.Operation) {
			operation.ReservationStatus = model.ReservationConfirmed
		}},
		{name: "reservation already released", mutate: func(_ *model.ManagerState, operation *model.Operation) {
			operation.ReservationReleased = true
		}},
		{name: "snapshot already restored", mutate: func(_ *model.ManagerState, operation *model.Operation) {
			operation.SnapshotRestored = true
		}},
		{name: "operation target changed", mutate: func(_ *model.ManagerState, operation *model.Operation) {
			operation.TargetGeneration = strings.Repeat("e", 40)
		}},
		{name: "completion evidence missing", mutate: func(_ *model.ManagerState, operation *model.Operation) {
			operation.CompletedAt = nil
		}},
	}
	for _, test := range mutations {
		t.Run(test.name, func(t *testing.T) {
			state, operation := validWorkspaceSchemaCommitFinalize()
			test.mutate(&state, &operation)
			if got := projectWorkspaceSchemaCommit(state, operation); got != nil {
				t.Fatalf("workspace schema capability survived drift: %#v", got)
			}
		})
	}
}

func TestStatusMakesWorkspaceSchemaCommitExplicitlyNullByDefault(t *testing.T) {
	t.Parallel()
	store, err := journal.Open(t.TempDir(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	status, _ := requestManagerStatus(t, &API{
		Store:        store,
		ControlToken: "control-token-0123456789abcdef",
	})
	value, exists := status["workspace_schema_commit"]
	if !exists || value != nil {
		t.Fatalf("workspace_schema_commit = %#v, want explicit null", value)
	}
}

func TestStatusProjectsExactFinalizedGateSettlement(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		kind   model.OperationKind
		action string
	}{
		{kind: model.OperationInstall, action: "commit"},
		{kind: model.OperationUpdate, action: "commit"},
		{kind: model.OperationRestart, action: "abort"},
		{kind: model.OperationRollback, action: "abort"},
		{kind: model.OperationRepair, action: "abort"},
	} {
		t.Run(string(test.kind), func(t *testing.T) {
			state, operation := validGateSettlement(test.kind)
			projected := projectGateSettlement(state, operation)
			if projected == nil || projected.SchemaVersion != 1 ||
				projected.OperationID != operation.ID || projected.Action != test.action {
				t.Fatalf("gate settlement = %#v, want action %q", projected, test.action)
			}
		})
	}
	state, operation := validGateSettlement(model.OperationUpdate)
	operation.GateSettlementAction = model.GateSettlementAbort
	if projected := projectGateSettlement(state, operation); projected == nil || projected.Action != "abort" {
		t.Fatalf("generation operation did not retain its durable abort action: %#v", projected)
	}
	state, operation = validGateSettlement(model.OperationInstall)
	state.Previous = targetGeneration(strings.Repeat("d", 40))
	operation.ReservationStatus = model.ReservationMutationStarted
	if projected := projectGateSettlement(state, operation); projected == nil {
		t.Fatal("non-fresh install lost its durable mutation settlement")
	}
}

func TestGateSettlementProjectionFailsClosedOnJournalOrStateDrift(t *testing.T) {
	t.Parallel()
	mutations := []struct {
		name   string
		mutate func(*model.ManagerState, *model.Operation)
	}{
		{name: "maintenance ended", mutate: func(state *model.ManagerState, _ *model.Operation) { state.Maintenance = false }},
		{name: "public state changed", mutate: func(state *model.ManagerState, _ *model.Operation) { state.PublicState = model.StateIdle }},
		{name: "state phase appeared", mutate: func(state *model.ManagerState, _ *model.Operation) { state.Phase = model.PhaseCommitting }},
		{name: "active slot appeared", mutate: func(state *model.ManagerState, operation *model.Operation) { state.ActiveOperationID = operation.ID }},
		{name: "finalize slot changed", mutate: func(state *model.ManagerState, _ *model.Operation) {
			state.FinalizePendingOperationID = "op_ffffffffffffffffffffffffffffffff"
		}},
		{name: "candidate appeared", mutate: func(state *model.ManagerState, operation *model.Operation) {
			state.Candidate = targetGeneration(operation.TargetGeneration)
		}},
		{name: "current changed", mutate: func(state *model.ManagerState, _ *model.Operation) {
			state.Current.SourceCommit = strings.Repeat("b", 40)
		}},
		{name: "operation schema changed", mutate: func(_ *model.ManagerState, operation *model.Operation) { operation.SchemaVersion = 2 }},
		{name: "operation kind unknown", mutate: func(_ *model.ManagerState, operation *model.Operation) {
			operation.Kind = model.OperationKind("future")
		}},
		{name: "operation not finalized", mutate: func(_ *model.ManagerState, operation *model.Operation) { operation.Finalized = false }},
		{name: "operation failed", mutate: func(_ *model.ManagerState, operation *model.Operation) { operation.Status = model.OperationFailed }},
		{name: "operation phase changed", mutate: func(_ *model.ManagerState, operation *model.Operation) { operation.Phase = model.PhaseProbing }},
		{name: "settlement action missing", mutate: func(_ *model.ManagerState, operation *model.Operation) { operation.GateSettlementAction = "" }},
		{name: "settlement action unknown", mutate: func(_ *model.ManagerState, operation *model.Operation) {
			operation.GateSettlementAction = model.GateSettlementAction("release")
		}},
		{name: "reservation checkpoint changed", mutate: func(_ *model.ManagerState, operation *model.Operation) {
			operation.ReservationStatus = model.ReservationConfirmed
		}},
		{name: "completion missing", mutate: func(_ *model.ManagerState, operation *model.Operation) { operation.CompletedAt = nil }},
		{name: "reservation released", mutate: func(_ *model.ManagerState, operation *model.Operation) { operation.ReservationReleased = true }},
		{name: "snapshot restored", mutate: func(_ *model.ManagerState, operation *model.Operation) { operation.SnapshotRestored = true }},
		{name: "cleanup pending", mutate: func(_ *model.ManagerState, operation *model.Operation) { operation.PreparedCleanupPending = true }},
		{name: "manager rollback pending", mutate: func(_ *model.ManagerState, operation *model.Operation) { operation.ManagerActivationRollback = true }},
	}
	for _, test := range mutations {
		t.Run(test.name, func(t *testing.T) {
			state, operation := validGateSettlement(model.OperationUpdate)
			test.mutate(&state, &operation)
			if projected := projectGateSettlement(state, operation); projected != nil {
				t.Fatalf("gate settlement survived drift: %#v", projected)
			}
		})
	}
}

func TestStatusMakesGateSettlementExplicitlyNullByDefault(t *testing.T) {
	t.Parallel()
	store, err := journal.Open(t.TempDir(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	status, _ := requestManagerStatus(t, &API{Store: store, ControlToken: "control-token-0123456789abcdef"})
	if value, exists := status["gate_settlement"]; !exists || value != nil {
		t.Fatalf("gate_settlement = %#v, want explicit null", value)
	}
}

func TestStatusSnapshotsReferencedOperationAfterServiceProbe(t *testing.T) {
	t.Parallel()
	store, operationID, _ := workspaceSchemaCommitStore(t, true)
	api := &API{
		Store: store,
		Engine: statusReporterFunc{report: func(context.Context) map[string]driver.FixedServiceState {
			if _, err := store.UpdateOperation(operationID, func(operation *model.Operation) error {
				operation.Finalized = true
				operation.GateSettlementAction = model.GateSettlementCommit
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			return map[string]driver.FixedServiceState{}
		}},
		ControlToken: "control-token-0123456789abcdef",
	}
	status, _ := requestManagerStatus(t, api)
	if status["workspace_schema_commit"] != nil {
		t.Fatalf("status projected a capability from before its service probe: %#v", status["workspace_schema_commit"])
	}
	settlement, ok := status["gate_settlement"].(map[string]any)
	if !ok || settlement["operation_id"] != operationID || settlement["action"] != "commit" {
		t.Fatalf("status did not project the post-probe settlement snapshot: %#v", status["gate_settlement"])
	}
}

func workspaceSchemaCommitStore(t *testing.T, finalize bool) (*journal.Store, string, string) {
	t.Helper()
	store, err := journal.Open(t.TempDir(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	operation, _, err := store.Begin(model.OperationRequest{
		Kind:               model.OperationUpdate,
		IdempotencyKey:     "workspace-schema-commit",
		ExpectedGeneration: store.State().Generation,
	}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	target := strings.Repeat("a", 40)
	completed := time.Now().UTC()
	operation, err = store.UpdateOperation(operation.ID, func(value *model.Operation) error {
		value.TargetGeneration = target
		value.Status = model.OperationRunning
		value.Finalized = false
		value.Phase = model.PhaseStarting
		value.ReservationStatus = model.ReservationMutationStarted
		value.SnapshotPath = "/snapshot/before-a2"
		value.CompletedAt = nil
		if finalize {
			value.Status = model.OperationSucceeded
			value.Phase = model.PhaseCommitting
			value.CompletedAt = &completed
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.MutateState(time.Now(), func(state *model.ManagerState) error {
		state.PublicState = model.StateUpdating
		state.Maintenance = true
		if finalize {
			state.ActiveOperationID = ""
			state.FinalizePendingOperationID = operation.ID
			state.Phase = ""
			state.Current = targetGeneration(target)
			state.Current.RollbackSnapshotPath = operation.SnapshotPath
			state.Previous = targetGeneration(contract.SourceOwnerCompatGeneration)
			state.Candidate = nil
			return nil
		}
		state.ActiveOperationID = operation.ID
		state.FinalizePendingOperationID = ""
		state.Phase = model.PhaseStarting
		state.Current = targetGeneration(contract.SourceOwnerCompatGeneration)
		state.Candidate = targetGeneration(target)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return store, operation.ID, target
}

func validWorkspaceSchemaCommitFinalize() (model.ManagerState, model.Operation) {
	target := strings.Repeat("a", 40)
	completed := time.Now().UTC()
	operation := model.Operation{
		SchemaVersion:     1,
		ID:                "op_0123456789abcdef0123456789abcdef",
		Kind:              model.OperationUpdate,
		TargetGeneration:  target,
		Status:            model.OperationSucceeded,
		Finalized:         false,
		Phase:             model.PhaseCommitting,
		ReservationStatus: model.ReservationMutationStarted,
		SnapshotPath:      "/snapshot/before-a2",
		CompletedAt:       &completed,
	}
	state := model.ManagerState{
		SchemaVersion:              1,
		Generation:                 17,
		PublicState:                model.StateUpdating,
		Maintenance:                true,
		Current:                    targetGeneration(target),
		Previous:                   targetGeneration(contract.SourceOwnerCompatGeneration),
		FinalizePendingOperationID: operation.ID,
	}
	state.Current.RollbackSnapshotPath = operation.SnapshotPath
	return state, operation
}

func validGateSettlement(kind model.OperationKind) (model.ManagerState, model.Operation) {
	state, operation := validWorkspaceSchemaCommitFinalize()
	operation.Kind = kind
	operation.Finalized = true
	operation.GateSettlementAction = model.GateSettlementAbort
	if kind == model.OperationInstall || kind == model.OperationUpdate {
		operation.GateSettlementAction = model.GateSettlementCommit
	}
	if kind == model.OperationInstall || kind == model.OperationRepair {
		operation.ReservationStatus = ""
	}
	if kind == model.OperationInstall {
		state.Previous = nil
	}
	return state, operation
}

func targetGeneration(generation string) *model.Generation {
	return &model.Generation{ID: generation, SourceCommit: generation}
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
				"future-service": "registry.example/future@sha256:" + strings.Repeat("a", 64),
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
	if !ok || images["platform"] == nil || len(images) != 1 || images["future-service"] != nil ||
		images["registry-port"] != nil || images["official-image"] != nil || images["absolute-path"] != nil ||
		images["file-uri"] != nil || images["embedded-path"] != nil {
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
