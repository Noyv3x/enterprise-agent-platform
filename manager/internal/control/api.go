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
	"github.com/ubitech/agent-platform/manager/internal/model"
	"github.com/ubitech/agent-platform/manager/internal/operation"
	"github.com/ubitech/agent-platform/manager/internal/release"
)

type API struct {
	Store          *journal.Store
	Operations     *operation.Orchestrator
	Engine         driver.Engine
	Executor       *executor.Service
	Config         *config.Manager
	AuditLog       *logstore.Store
	ControlToken   string
	ExecutorToken  string
	ManagerVersion string
	ManagerSHA256  string
	mu             sync.Mutex
	checks         map[string]release.Manifest
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
	case request.Method == http.MethodGet && request.URL.Path == "/v1/identity":
		a.identity(response)
	case request.Method == http.MethodGet && request.URL.Path == "/v1/status":
		a.status(response, request.Context())
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
	default:
		writeError(response, http.StatusNotFound, "not found")
	}
}

// identity is the constant-time, owner-authenticated process probe used by the
// self-update watchdog and the external Current recovery path. It deliberately
// does not read the operation journal or call Docker: process identity and the
// health of managed child services are separate signals.
func (a *API) identity(response http.ResponseWriter) {
	managerVersion := safeCommit(a.ManagerVersion)
	managerSHA := safeSHA256(a.ManagerSHA256)
	if managerVersion == "" || managerSHA == "" {
		writeError(response, http.StatusServiceUnavailable, "manager identity is unavailable")
		return
	}
	writeJSON(response, http.StatusOK, map[string]string{
		"status":  "healthy",
		"version": managerVersion,
		"sha256":  managerSHA,
	})
}

func (a *API) status(response http.ResponseWriter, requestContext context.Context) {
	state := a.Store.State()
	activeOperationID := safeStatusToken(state.ActiveOperationID, 160)
	finalizeOperationID := safeStatusToken(state.FinalizePendingOperationID, 160)
	operationID := activeOperationID
	if operationID == "" {
		operationID = finalizeOperationID
	}
	publicState := safePublicState(state.PublicState)
	services := map[string]any{"manager": map[string]any{"status": "healthy"}}
	for _, name := range []string{
		"platform",
		"agent-runtime",
		"camofox",
		"searxng",
		"firecrawl-playwright",
		"firecrawl-redis",
		"firecrawl-rabbitmq",
		"firecrawl-postgres",
		"firecrawl-api",
	} {
		services[name] = map[string]any{"status": "unknown"}
	}
	if reporter, ok := a.Engine.(driver.FixedServiceReporter); ok {
		probeContext, cancel := context.WithTimeout(requestContext, 5*time.Second)
		for name, service := range reporter.FixedServiceStatus(probeContext) {
			if _, expected := services[name]; expected {
				services[name] = map[string]any{"status": safeServiceStatus(service.Status)}
			}
		}
		cancel()
	}
	writeJSON(response, http.StatusOK, map[string]any{"generation": state.Generation, "current": generationStatusProjection(state.Current), "previous": generationStatusProjection(state.Previous), "target": generationStatusProjection(state.Candidate), "public_state": publicState, "phase": safeOperationPhase(state.Phase), "services": services, "error": safeManagerDiagnostic(state.LastError), "maintenance": state.Maintenance, "active_operation_id": activeOperationID, "finalize_pending_operation_id": finalizeOperationID, "operation_id": operationID, "checked_at": state.HeartbeatAt})
}

func safeServiceStatus(value string) string {
	switch value {
	case "healthy", "starting", "unavailable", "unknown":
		return value
	default:
		return "unknown"
	}
}

func generationStatusProjection(generation *model.Generation) any {
	if generation == nil {
		return nil
	}
	images := make(map[string]string, len(generation.Images))
	for name, image := range generation.Images {
		if safeStatusToken(name, 64) == "" || !safeImageReference(image) {
			continue
		}
		images[name] = image
	}
	return map[string]any{
		"id":               safeStatusToken(generation.ID, 160),
		"source_commit":    safeCommit(generation.SourceCommit),
		"database_version": generation.DatabaseVersion,
		"images":           images,
		"activated_at":     generation.ActivatedAt,
	}
}

func safeManagerDiagnostic(value string) string {
	if value == "" {
		return ""
	}
	return "manager operation requires attention"
}

func safePublicState(value model.PublicState) model.PublicState {
	switch value {
	case model.StateIdle, model.StateWaitingForTasks, model.StateUpdating, model.StateFailed:
		return value
	default:
		return model.StateFailed
	}
}

func safeOperationPhase(value model.OperationPhase) model.OperationPhase {
	switch value {
	case "", model.PhaseValidating, model.PhasePulling, model.PhasePreparing, model.PhaseDraining,
		model.PhaseSnapshotting, model.PhaseMigrating, model.PhaseStarting, model.PhaseProbing,
		model.PhaseCommitting, model.PhaseRollingBack:
		return value
	default:
		return ""
	}
}

func safeImageReference(value string) bool {
	if len(value) > 512 || strings.ContainsAny(value, "\r\n\x00") {
		return false
	}
	prefix, digest, found := strings.Cut(value, "@sha256:")
	if !found || !safeImageName(prefix) || len(digest) != 64 {
		return false
	}
	for _, character := range digest {
		if !(character >= '0' && character <= '9' || character >= 'a' && character <= 'f') {
			return false
		}
	}
	return true
}

func safeImageName(value string) bool {
	parts := strings.Split(value, "/")
	if len(parts) == 0 {
		return false
	}
	for index, part := range parts {
		if part == "" || part == "." || part == ".." {
			return false
		}
		if index == 0 {
			if host, port, found := strings.Cut(part, ":"); found {
				if host == "" || port == "" {
					return false
				}
				for _, character := range port {
					if character < '0' || character > '9' {
						return false
					}
				}
				part = host
			}
		} else if strings.Contains(part, ":") {
			return false
		}
		for _, character := range part {
			if !(character >= 'a' && character <= 'z' || character >= '0' && character <= '9' ||
				character == '.' || character == '_' || character == '-') {
				return false
			}
		}
	}
	return true
}

func safeCommit(value string) string {
	if len(value) != 40 {
		return ""
	}
	for _, character := range value {
		if !(character >= '0' && character <= '9' || character >= 'a' && character <= 'f') {
			return ""
		}
	}
	return value
}

func safeSHA256(value string) string {
	if len(value) != 64 {
		return ""
	}
	for _, character := range value {
		if !(character >= '0' && character <= '9' || character >= 'a' && character <= 'f') {
			return ""
		}
	}
	return value
}

func safeStatusToken(value string, limit int) string {
	if value == "" || len(value) > limit {
		return ""
	}
	for _, character := range value {
		if !(character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' || character == '_' || character == '-' ||
			character == '.' || character == '@' || character == ':') {
			return ""
		}
	}
	return value
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
		Operation          model.OperationKind `json:"operation"`
		IdempotencyKey     string              `json:"idempotency_key"`
		ExpectedGeneration *uint64             `json:"expected_generation,omitempty"`
		ManifestURL        string              `json:"manifest_url,omitempty"`
	}
	if err := decode(request, &body); err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	expected := a.Store.State().Generation
	if body.ExpectedGeneration != nil {
		expected = *body.ExpectedGeneration
	}
	op, reused, err := a.Operations.Start(model.OperationRequest{Kind: body.Operation, IdempotencyKey: body.IdempotencyKey, ExpectedGeneration: expected, ManifestURL: body.ManifestURL})
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, journal.ErrGenerationConflict) || errors.Is(err, journal.ErrOperationInProgress) || errors.Is(err, journal.ErrIdempotencyConflict) {
			status = http.StatusConflict
		}
		writeError(response, status, err.Error())
		return
	}
	writeJSON(response, http.StatusAccepted, map[string]any{"operation": operationProjection(op), "reused": reused})
}
func (a *API) operation(response http.ResponseWriter, id string) {
	op, err := a.Store.Operation(id)
	if err != nil {
		writeError(response, http.StatusNotFound, "operation not found")
		return
	}
	writeJSON(response, http.StatusOK, operationProjection(op))
}

func operationProjection(op model.Operation) model.Operation {
	return journal.BoundOperation(op)
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
	data, err := json.Marshal(value)
	if err != nil {
		status = http.StatusInternalServerError
		data = []byte(`{"error":"encode manager response"}`)
	}
	data = append(data, '\n')
	response.WriteHeader(status)
	_, _ = response.Write(data)
}
func writeError(response http.ResponseWriter, status int, message string) {
	writeJSON(response, status, map[string]string{"error": journal.BoundDiagnostic(message)})
}
