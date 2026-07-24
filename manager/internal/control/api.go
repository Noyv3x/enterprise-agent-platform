package control

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/config"
	"github.com/ubitech/agent-platform/manager/internal/driver"
	"github.com/ubitech/agent-platform/manager/internal/executor"
	"github.com/ubitech/agent-platform/manager/internal/journal"
	"github.com/ubitech/agent-platform/manager/internal/logstore"
	"github.com/ubitech/agent-platform/manager/internal/migration"
	"github.com/ubitech/agent-platform/manager/internal/model"
	"github.com/ubitech/agent-platform/manager/internal/operation"
	"github.com/ubitech/agent-platform/manager/internal/release"
)

type API struct {
	Store         *journal.Store
	Operations    *operation.Orchestrator
	Engine        driver.Engine
	Executor      *executor.Service
	Config        *config.Manager
	AuditLog      *logstore.Store
	Legacy        *migration.Service
	ControlToken  string
	ExecutorToken string
	mu            sync.Mutex
	checks        map[string]release.Manifest
}

func (a *API) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Content-Type", "application/json")
	response.Header().Set("Cache-Control", "no-store")
	if strings.HasPrefix(request.URL.Path, "/v1/executor/") {
		if !authorized(request, a.ExecutorToken) {
			writeError(response, http.StatusUnauthorized, "executor authentication failed")
			return
		}
		a.executorRoute(response, request)
		return
	}
	if !authorized(request, a.ControlToken) {
		writeError(response, http.StatusUnauthorized, "control authentication failed")
		return
	}
	switch {
	case request.Method == http.MethodGet && request.URL.Path == "/v1/status":
		a.status(response)
	case request.Method == http.MethodGet && request.URL.Path == "/v1/config":
		writeJSON(response, http.StatusOK, a.Config.Public())
	case request.Method == http.MethodPatch && request.URL.Path == "/v1/config":
		a.patchConfig(response, request)
	case request.Method == http.MethodPost && request.URL.Path == "/v1/preflight":
		a.preflight(response, request)
	case request.Method == http.MethodPost && request.URL.Path == "/v1/check":
		a.check(response, request)
	case request.Method == http.MethodPost && request.URL.Path == "/v1/operations":
		a.startOperation(response, request)
	case request.Method == http.MethodGet && strings.HasPrefix(request.URL.Path, "/v1/operations/"):
		a.operation(response, strings.TrimPrefix(request.URL.Path, "/v1/operations/"))
	case request.Method == http.MethodGet && request.URL.Path == "/v1/logs":
		a.logs(response, request)
	case request.Method == http.MethodPost && request.URL.Path == "/v1/migrations/legacy":
		a.configureLegacy(response, request)
	case request.Method == http.MethodGet && request.URL.Path == "/v1/migrations/legacy":
		a.legacyPlan(response)
	default:
		writeError(response, http.StatusNotFound, "not found")
	}
}

func (a *API) status(response http.ResponseWriter) {
	state := a.Store.State()
	operationID := state.ActiveOperationID
	if operationID == "" {
		operationID = state.FinalizePendingOperationID
	}
	services := map[string]any{"manager": map[string]any{"status": "healthy"}, "platform": map[string]any{"status": func() string {
		if state.PublicState == model.StateFailed {
			return "unavailable"
		}
		if state.Maintenance {
			return "maintenance"
		}
		return "running"
	}()}}
	writeJSON(response, http.StatusOK, map[string]any{"generation": state.Generation, "current": state.Current, "previous": state.Previous, "target": state.Candidate, "public_state": state.PublicState, "phase": state.Phase, "services": services, "error": state.LastError, "maintenance": state.Maintenance, "active_operation_id": state.ActiveOperationID, "finalize_pending_operation_id": state.FinalizePendingOperationID, "operation_id": operationID, "checked_at": state.HeartbeatAt})
}
func (a *API) patchConfig(response http.ResponseWriter, request *http.Request) {
	var patch config.Patch
	if err := decode(request, &patch); err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	value, err := a.Config.Patch(patch)
	if err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	a.Operations.ManifestURL = value.ReleaseManifestURL
	writeJSON(response, http.StatusOK, value)
}
func (a *API) preflight(response http.ResponseWriter, request *http.Request) {
	ctx, cancel := context.WithTimeout(request.Context(), 30*time.Second)
	defer cancel()
	if err := a.Operations.Preflight(ctx); err != nil {
		writeError(response, http.StatusServiceUnavailable, err.Error())
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "checked_at": time.Now().UTC()})
}
func (a *API) check(response http.ResponseWriter, request *http.Request) {
	var body struct {
		IdempotencyKey string `json:"idempotency_key"`
		ManifestURL    string `json:"manifest_url,omitempty"`
	}
	if err := decode(request, &body); err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	if body.IdempotencyKey == "" {
		writeError(response, http.StatusBadRequest, "idempotency_key is required")
		return
	}
	a.mu.Lock()
	cached, ok := a.checks[body.IdempotencyKey]
	a.mu.Unlock()
	if ok {
		writeJSON(response, http.StatusOK, map[string]any{"manifest": cached, "reused": true})
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 45*time.Second)
	defer cancel()
	manifest, err := a.Operations.Check(ctx, body.ManifestURL)
	if err != nil {
		writeError(response, http.StatusBadGateway, err.Error())
		return
	}
	a.mu.Lock()
	if a.checks == nil {
		a.checks = map[string]release.Manifest{}
	}
	a.checks[body.IdempotencyKey] = manifest
	a.mu.Unlock()
	writeJSON(response, http.StatusOK, map[string]any{"manifest": manifest, "reused": false})
}
func (a *API) startOperation(response http.ResponseWriter, request *http.Request) {
	var body struct {
		Operation            model.OperationKind `json:"operation"`
		IdempotencyKey       string              `json:"idempotency_key"`
		ExpectedGeneration   *uint64             `json:"expected_generation,omitempty"`
		ManifestURL          string              `json:"manifest_url,omitempty"`
		ExpectedSourceCommit string              `json:"expected_source_commit,omitempty"`
	}
	if err := decode(request, &body); err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	expected := a.Store.State().Generation
	if body.ExpectedGeneration != nil {
		expected = *body.ExpectedGeneration
	}
	if body.Operation == model.OperationInstall && a.Legacy != nil && a.Legacy.Active() {
		plan, planErr := a.Legacy.Plan()
		if planErr != nil || plan.ExpectedSourceCommit == "" {
			writeError(response, http.StatusConflict, "source migration is missing its expected source commit")
			return
		}
		if body.ExpectedSourceCommit != "" && body.ExpectedSourceCommit != plan.ExpectedSourceCommit {
			writeError(response, http.StatusConflict, "install expected source commit does not match the legacy migration plan")
			return
		}
		body.ExpectedSourceCommit = plan.ExpectedSourceCommit
	}
	op, reused, err := a.Operations.Start(model.OperationRequest{Kind: body.Operation, IdempotencyKey: body.IdempotencyKey, ExpectedGeneration: expected, ManifestURL: body.ManifestURL, ExpectedSourceCommit: body.ExpectedSourceCommit})
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, journal.ErrGenerationConflict) || errors.Is(err, journal.ErrOperationInProgress) {
			status = http.StatusConflict
		}
		writeError(response, status, err.Error())
		return
	}
	writeJSON(response, http.StatusAccepted, map[string]any{"operation": op, "reused": reused})
}
func (a *API) operation(response http.ResponseWriter, id string) {
	op, err := a.Store.Operation(id)
	if err != nil {
		writeError(response, http.StatusNotFound, "operation not found")
		return
	}
	writeJSON(response, http.StatusOK, op)
}
func (a *API) logs(response http.ResponseWriter, request *http.Request) {
	tail, _ := strconv.Atoi(request.URL.Query().Get("tail"))
	service := request.URL.Query().Get("service")
	if service == "manager-audit" {
		values, err := a.AuditLog.Tail(tail)
		if err != nil {
			writeError(response, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{"events": values})
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 15*time.Second)
	defer cancel()
	content, err := a.Engine.Logs(ctx, service, tail)
	if err != nil {
		writeError(response, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"content": content})
}
func (a *API) configureLegacy(response http.ResponseWriter, request *http.Request) {
	if a.Legacy == nil {
		writeError(response, http.StatusNotImplemented, "legacy migration is unavailable")
		return
	}
	var body struct {
		LegacyRoot           string `json:"legacy_root"`
		LegacyData           string `json:"legacy_data,omitempty"`
		LegacyService        string `json:"legacy_service,omitempty"`
		ExpectedSourceCommit string `json:"expected_source_commit"`
	}
	if err := decode(request, &body); err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	if body.ExpectedSourceCommit == "" {
		writeError(response, http.StatusBadRequest, "expected_source_commit is required")
		return
	}
	plan, err := a.Legacy.Configure(body.LegacyRoot, body.LegacyData, body.LegacyService, body.ExpectedSourceCommit)
	if err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(response, http.StatusOK, plan)
}
func (a *API) legacyPlan(response http.ResponseWriter) {
	if a.Legacy == nil {
		writeError(response, http.StatusNotImplemented, "legacy migration is unavailable")
		return
	}
	plan, err := a.Legacy.Plan()
	if err != nil {
		writeError(response, http.StatusNotFound, "legacy migration is not configured")
		return
	}
	writeJSON(response, http.StatusOK, plan)
}

func (a *API) executorRoute(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeError(response, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	switch request.URL.Path {
	case "/v1/executor/audit":
		var body executor.AuditRequest
		if !a.decodeExecutor(response, request, &body) {
			return
		}
		result, err := a.Executor.Audit(body)
		a.executorResult(response, result, err)
	case "/v1/executor/terminal":
		var body executor.Call
		if !a.decodeExecutor(response, request, &body) {
			return
		}
		result, err := a.Executor.Terminal(request.Context(), body)
		a.executorResult(response, result, err)
	case "/v1/executor/process":
		var body executor.Call
		if !a.decodeExecutor(response, request, &body) {
			return
		}
		result, err := a.Executor.Process(body)
		a.executorResult(response, result, err)
	case "/v1/executor/file":
		var body executor.Call
		if !a.decodeExecutor(response, request, &body) {
			return
		}
		result, err := a.Executor.File(request.Context(), body)
		a.executorResult(response, result, err)
	case "/v1/executor/runs/cancel":
		var body executor.RunIdentity
		if !a.decodeExecutor(response, request, &body) {
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{"confirmed": a.Executor.CancelRun(body)})
	case "/v1/executor/scopes/cleanup":
		var body executor.ScopeIdentity
		if !a.decodeExecutor(response, request, &body) {
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{"confirmed": a.Executor.CleanupScope(body)})
	case "/v1/executor/scopes/processes":
		var body executor.ScopeIdentity
		if !a.decodeExecutor(response, request, &body) {
			return
		}
		writeJSON(response, http.StatusOK, a.Executor.Preview(body))
	case "/v1/executor/scopes/process-summary":
		var body executor.ScopeIdentity
		if !a.decodeExecutor(response, request, &body) {
			return
		}
		writeJSON(response, http.StatusOK, a.Executor.Summary(body))
	case "/v1/executor/processes/update-blockers":
		var body map[string]any
		if !a.decodeExecutor(response, request, &body) {
			return
		}
		if len(body) > 0 {
			writeError(response, http.StatusBadRequest, "request body must be empty")
			return
		}
		writeJSON(response, http.StatusOK, a.Executor.UpdateBlockers())
	default:
		writeError(response, http.StatusNotFound, "not found")
	}
}
func (a *API) decodeExecutor(response http.ResponseWriter, request *http.Request, value any) bool {
	if err := decode(request, value); err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return false
	}
	return true
}
func (a *API) executorResult(response http.ResponseWriter, result any, err error) {
	if err != nil {
		writeError(response, http.StatusConflict, err.Error())
		return
	}
	writeJSON(response, http.StatusOK, result)
}
func authorized(request *http.Request, expected string) bool {
	header := request.Header.Get("Authorization")
	scheme, provided, found := strings.Cut(header, " ")
	if !found || !strings.EqualFold(scheme, "Bearer") || provided == "" || strings.ContainsAny(provided, " \t\r\n") {
		return false
	}
	if provided == "" || expected == "" || len(provided) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}
func decode(request *http.Request, value any) error {
	defer request.Body.Close()
	reader := http.MaxBytesReader(nil, request.Body, 2<<20)
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return fmt.Errorf("invalid JSON body: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("request must contain exactly one JSON value")
	}
	return nil
}
func writeJSON(response http.ResponseWriter, status int, value any) {
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}
func writeError(response http.ResponseWriter, status int, message string) {
	writeJSON(response, status, map[string]string{"error": message})
}
