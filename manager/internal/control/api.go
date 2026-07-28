package control

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
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
	activeOperationID := safeStatusToken(state.ActiveOperationID, 160)
	finalizeOperationID := safeStatusToken(state.FinalizePendingOperationID, 160)
	operationID := activeOperationID
	if operationID == "" {
		operationID = finalizeOperationID
	}
	publicState := safePublicState(state.PublicState)
	services := map[string]any{"manager": map[string]any{"status": "healthy"}, "platform": map[string]any{"status": func() string {
		if publicState == model.StateFailed {
			return "unavailable"
		}
		if state.Maintenance {
			return "maintenance"
		}
		return "running"
	}()}}
	writeJSON(response, http.StatusOK, map[string]any{"generation": state.Generation, "current": generationStatusProjection(state.Current), "previous": generationStatusProjection(state.Previous), "target": generationStatusProjection(state.Candidate), "public_state": publicState, "phase": safeOperationPhase(state.Phase), "services": services, "error": safeManagerDiagnostic(state.LastError), "maintenance": state.Maintenance, "active_operation_id": activeOperationID, "finalize_pending_operation_id": finalizeOperationID, "operation_id": operationID, "checked_at": state.HeartbeatAt, "legacy_migration": a.legacyMigrationStatus()})
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

func (a *API) legacyMigrationStatus() any {
	if a.Legacy == nil {
		return nil
	}
	plan, err := a.Legacy.Plan()
	if err == nil {
		return migrationStatusProjection(plan)
	}
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	// Status is an operationally safe projection, not a filesystem diagnostic.
	// The concrete read error may contain an obsolete checkout or state path, so
	// expose a fixed bounded signal and leave detailed evidence owner-local.
	return map[string]any{
		"status": "unavailable",
		"error":  journal.BoundDiagnostic("legacy migration status is unavailable"),
	}
}

func migrationStatusProjection(plan migration.Plan) map[string]any {
	projection := migrationPlanProjection(plan)
	projection["id"] = safeStatusToken(plan.ID, 160)
	projection["operation_id"] = safeStatusToken(plan.OperationID, 160)
	projection["expected_source_commit"] = safeCommit(plan.ExpectedSourceCommit)
	projection["status"] = safeMigrationStatus(plan.Status)
	projection["error"] = safeMigrationDiagnostic(plan)
	if retirement, ok := projection["retirement"].(map[string]any); ok && plan.Retirement != nil {
		retirement["campaign_id"] = safeStatusToken(plan.Retirement.CampaignID, 160)
		retirement["generation_id"] = safeCommit(plan.Retirement.GenerationID)
		retirement["status"] = safeRetirementStatus(plan.Retirement.Status)
		retirement["error"] = safeMigrationDiagnostic(plan)
	}
	return projection
}

func safeMigrationDiagnostic(plan migration.Plan) string {
	if plan.Error == "" && (plan.Retirement == nil || plan.Retirement.Error == "") {
		return ""
	}
	if plan.Retirement == nil {
		return "legacy migration requires attention"
	}
	if plan.Retirement.Status == "waiting_readiness" {
		return "source retirement preconditions are not satisfied"
	}
	return "source retirement cleanup requires attention"
}

func safeMigrationStatus(value string) string {
	switch value {
	case "configured", "stopping_legacy", "copying", "installing_copy", "migrated", "cleanup_pending", "committed", "rolled_back", "failed", "purged":
		return value
	default:
		return "unavailable"
	}
}

func safeRetirementStatus(value string) string {
	switch value {
	case "waiting_readiness", "prepared", "systemd_removed", "source_state_removed", "docker_removed", "recovery_removed", "completed":
		return value
	default:
		return "unavailable"
	}
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
		IdempotencyKey       string `json:"idempotency_key"`
		ManifestURL          string `json:"manifest_url,omitempty"`
		ExpectedSourceCommit string `json:"expected_source_commit,omitempty"`
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
		if body.ExpectedSourceCommit != "" && cached.SourceCommit != body.ExpectedSourceCommit {
			writeError(response, http.StatusConflict, "source migration release mismatch")
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{"manifest": cached, "reused": true})
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 45*time.Second)
	defer cancel()
	manifest, err := a.Operations.CheckExpected(ctx, body.ManifestURL, body.ExpectedSourceCommit)
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
	if body.Operation == model.OperationInstall && a.Legacy != nil {
		expectedCommit, required, planErr := a.Legacy.RequiredSourceCommit()
		if planErr != nil {
			writeError(response, http.StatusConflict, "source migration is missing its expected source commit")
			return
		}
		if required && body.ExpectedSourceCommit != "" && body.ExpectedSourceCommit != expectedCommit {
			writeError(response, http.StatusConflict, "install expected source commit does not match the legacy migration plan")
			return
		}
		if required {
			body.ExpectedSourceCommit = expectedCommit
		}
	}
	op, reused, err := a.Operations.Start(model.OperationRequest{Kind: body.Operation, IdempotencyKey: body.IdempotencyKey, ExpectedGeneration: expected, ManifestURL: body.ManifestURL, ExpectedSourceCommit: body.ExpectedSourceCommit})
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
	writeJSON(response, http.StatusOK, migrationConfigurationAcknowledgement(plan))
}

func migrationConfigurationAcknowledgement(plan migration.Plan) map[string]any {
	return map[string]any{
		"id":                     plan.ID,
		"status":                 plan.Status,
		"expected_source_commit": plan.ExpectedSourceCommit,
	}
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
	writeJSON(response, http.StatusOK, migrationPlanProjection(plan))
}

func migrationPlanProjection(plan migration.Plan) map[string]any {
	var retirement any
	if plan.Retirement != nil {
		retirement = map[string]any{
			"campaign_id":          plan.Retirement.CampaignID,
			"generation_id":        plan.Retirement.GenerationID,
			"status":               plan.Retirement.Status,
			"systemd_removed":      plan.Retirement.SystemdRemoved,
			"source_state_removed": plan.Retirement.SourceStateRemoved,
			"docker_removed":       plan.Retirement.DockerRemoved,
			"recovery_removed":     plan.Retirement.RecoveryRemoved,
			"started_at":           plan.Retirement.StartedAt,
			"completed_at":         plan.Retirement.CompletedAt,
			"error":                journal.BoundDiagnostic(plan.Retirement.Error),
		}
	}
	return map[string]any{
		"schema_version":         plan.SchemaVersion,
		"id":                     plan.ID,
		"operation_id":           plan.OperationID,
		"status":                 plan.Status,
		"expected_source_commit": plan.ExpectedSourceCommit,
		"copied":                 plan.Copied,
		"copy_prepared":          plan.CopyPrepared,
		"old_service_stopped":    plan.OldServiceStopped,
		"unit_state_recorded":    plan.UnitStateRecorded,
		"archive_ready":          plan.ArchiveReady,
		"archive_restored":       plan.ArchiveRestored,
		"entry_count":            len(plan.Entries),
		"archive_tree_count":     len(plan.ArchiveTrees),
		"archive_file_count":     len(plan.ArchiveFiles),
		"retired_cache_count":    len(plan.RetiredCaches),
		"compose_project_count":  len(plan.ComposeProjects),
		"compose_volume_count":   len(plan.ComposeVolumes),
		"compose_error_count":    len(plan.ComposeCleanupErrors),
		"quarantined_count":      len(plan.Quarantined),
		"retirement":             retirement,
		"error":                  journal.BoundDiagnostic(plan.Error),
		"created_at":             plan.CreatedAt,
		"updated_at":             plan.UpdatedAt,
	}
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
