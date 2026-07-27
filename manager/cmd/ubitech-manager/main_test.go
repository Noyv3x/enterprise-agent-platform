package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/config"
	"github.com/ubitech/agent-platform/manager/internal/control"
	"github.com/ubitech/agent-platform/manager/internal/driver"
	"github.com/ubitech/agent-platform/manager/internal/journal"
	"github.com/ubitech/agent-platform/manager/internal/migration"
	"github.com/ubitech/agent-platform/manager/internal/model"
	"github.com/ubitech/agent-platform/manager/internal/snapshot"
)

const legacyE0DiagnosticBytes = 3_019_000 // approximately 2.88 MiB

type recoveryLegacyRunner struct{}

func (recoveryLegacyRunner) Run(_ context.Context, _ string, args []string, _ []string) (driver.Result, error) {
	if strings.Contains(strings.Join(args, " "), "--property=UnitFileState") {
		return driver.Result{Stdout: "enabled\n"}, nil
	}
	return driver.Result{}, nil
}

func encodeLegacyE0Response(response http.ResponseWriter, value any) {
	response.Header().Set("Content-Type", "application/json")
	// Deliberately omit Content-Length, matching the old Unix-socket HTTP
	// service. A response this large is emitted with chunked framing.
	response.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(response).Encode(value)
}

func TestAutoUpdateDueUsesConfiguredInterval(t *testing.T) {
	last := time.Unix(100, 0)
	if autoUpdateDue(last, last.Add(4*time.Minute+59*time.Second), 5*time.Minute) {
		t.Fatal("auto update ran before the configured interval")
	}
	if !autoUpdateDue(last, last.Add(5*time.Minute), 5*time.Minute) {
		t.Fatal("auto update did not run at the configured interval")
	}
	// PATCH is observed by the one-second scheduler on its next tick: lowering
	// the interval immediately makes the same elapsed duration eligible.
	if !autoUpdateDue(last, last.Add(31*time.Second), 30*time.Second) {
		t.Fatal("a shorter patched interval was not effective")
	}
}

func TestBackgroundCannotBypassDurableFinalizeForLegacyCleanup(t *testing.T) {
	source, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(source), "a.legacy.FinalizeCleanup(") {
		t.Fatal("background loop bypasses finalize_pending watchdog barrier")
	}
}

func TestCandidateRecoversOperationsBeforeWatchdogAcknowledgement(t *testing.T) {
	source, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	recoverAt := strings.Index(text, "app.operations.RecoverBeforeActivation(")
	acknowledgeAt := strings.Index(text, "app.selfUpdate.AcknowledgeStartup(")
	awaitAt := strings.Index(text, "app.selfUpdate.AwaitStartupCommit(")
	finalizeAt := strings.LastIndex(text, "app.operations.Recover(context.Background())")
	if recoverAt < 0 || acknowledgeAt < 0 || awaitAt < 0 || finalizeAt < 0 || !(recoverAt < acknowledgeAt && acknowledgeAt < awaitAt && awaitAt < finalizeAt) {
		t.Fatalf("unsafe candidate startup ordering: recovery=%d acknowledgement=%d watchdog=%d finalize=%d", recoverAt, acknowledgeAt, awaitAt, finalizeAt)
	}
}

func TestManagerCLIClientLoadsControlCapability(t *testing.T) {
	root := t.TempDir()
	dataRoot := filepath.Join(root, "data")
	configPath := filepath.Join(root, "manager.toml")
	if err := os.WriteFile(configPath, []byte("data_root = \""+dataRoot+"\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	secrets := filepath.Join(dataRoot, "manager", "secrets")
	if err := os.MkdirAll(secrets, 0o700); err != nil {
		t.Fatal(err)
	}
	token := "control-token-0123456789abcdef0123456789abcdef"
	if err := os.WriteFile(filepath.Join(secrets, "manager-token"), []byte(token+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	client, _, err := managerClient(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if client.Token != token {
		t.Fatal("CLI did not load the Manager control capability")
	}
}

func TestValidatePreflightConfigUsesManagerParserAndFailsClosed(t *testing.T) {
	root := t.TempDir()
	dataRoot := filepath.Join(root, "data")
	configPath := filepath.Join(root, "manager.toml")
	manifestURL := "https://releases.example/main.json"
	legacyURL := "http://127.0.0.1:18765"
	content := "data_root = \"" + dataRoot + "\"\n" +
		"data_dir = \"" + filepath.Join(dataRoot, "data") + "/\"\n" +
		"listen = \"127.0.0.1:8765\"\n" +
		"release_manifest_url = \"" + manifestURL + "\"\n" +
		"release_channel = \"main\"\n" +
		"legacy_platform_gate_url = \"" + legacyURL + "\"\n"
	if err := os.WriteFile(configPath, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	expected := config.SourceMigrationExpectations{
		DataRoot:           dataRoot,
		GatewayAddress:     "127.0.0.1:8765",
		ReleaseManifestURL: manifestURL,
		ReleaseChannel:     "main",
		LegacyPlatformURL:  legacyURL,
		ControlSocketPath:  filepath.Join(dataRoot, "manager", "control", "manager.sock"),
		ControlTokenFile:   filepath.Join(dataRoot, "manager", "secrets", "manager-token"),
	}
	if err := validatePreflightConfig(configPath, true, expected); err != nil {
		t.Fatal(err)
	}
	legacyExpected := expected
	legacyExpected.ControlTokenFile = ""
	if err := validatePreflightConfig(configPath, true, legacyExpected); err != nil {
		t.Fatalf("legacy bridge token path was not safely derived: %v", err)
	}
	expected.ReleaseChannel = "candidate"
	if err := validatePreflightConfig(configPath, true, expected); err == nil || !strings.Contains(err.Error(), "mismatch for release_channel") {
		t.Fatalf("expected release channel mismatch, got %v", err)
	}
	expected.ReleaseChannel = "main"
	staleTokenFile := filepath.Join(root, "stale", "manager-token")
	if err := os.WriteFile(configPath, []byte(content+"internal_token_file = \""+staleTokenFile+"\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := validatePreflightConfig(configPath, true, expected); err == nil || !strings.Contains(err.Error(), "mismatch for internal_token_file") {
		t.Fatalf("expected control token path mismatch, got %v", err)
	}
	if err := validatePreflightConfig(configPath, true, legacyExpected); err == nil || !strings.Contains(err.Error(), "mismatch for internal_token_file") {
		t.Fatalf("legacy bridge compatibility accepted a divergent token path: %v", err)
	}
}

func TestSourceMigrationPreflightRejectsDivergentPlatformDataDir(t *testing.T) {
	root := t.TempDir()
	dataRoot := filepath.Join(root, "manager-data")
	configPath := filepath.Join(root, "manager.toml")
	manifestURL := "https://releases.example/main.json"
	legacyURL := "http://127.0.0.1:18765"
	content := "data_root = \"" + dataRoot + "\"\n" +
		"data_dir = \"" + filepath.Join(root, "detached-platform-data") + "\"\n" +
		"listen = \"127.0.0.1:8765\"\n" +
		"release_manifest_url = \"" + manifestURL + "\"\n" +
		"release_channel = \"main\"\n" +
		"legacy_platform_gate_url = \"" + legacyURL + "\"\n"
	if err := os.WriteFile(configPath, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	expected := config.SourceMigrationExpectations{
		DataRoot:           dataRoot,
		GatewayAddress:     "127.0.0.1:8765",
		ReleaseManifestURL: manifestURL,
		ReleaseChannel:     "main",
		LegacyPlatformURL:  legacyURL,
		ControlSocketPath:  filepath.Join(dataRoot, "manager", "control", "manager.sock"),
		ControlTokenFile:   filepath.Join(dataRoot, "manager", "secrets", "manager-token"),
	}
	if err := validatePreflightConfig(configPath, true, expected); err == nil || !strings.Contains(err.Error(), "data_dir must equal data_root/data") {
		t.Fatalf("source migration accepted a data directory outside the Compose bind root: %v", err)
	}
}

func TestValidatePreflightConfigRejectsUnboundExpectations(t *testing.T) {
	expected := config.SourceMigrationExpectations{DataRoot: "/tmp/data"}
	if err := validatePreflightConfig("", false, expected); err == nil || !strings.Contains(err.Error(), "--verify-source-migration-config") {
		t.Fatalf("expected unbound expectation rejection, got %v", err)
	}
	if err := validatePreflightConfig("", false, config.SourceMigrationExpectations{}); err != nil {
		t.Fatalf("ordinary preflight was changed: %v", err)
	}
}

func TestValidateRollingBackRecoveryBindsExactOfflineState(t *testing.T) {
	operationID := "op_f6482db1853eed6b3584accd65c3a8b9"
	commit := strings.Repeat("a", 40)
	root := "/home/ubitech/source"
	legacyData := "/home/ubitech/source/data"
	destination := "/home/ubitech/.local/share/ubitech-agent/data"
	status := rollingBackRecoveryStatus{
		PublicState: model.StateFailed, Phase: model.PhaseRollingBack,
		Maintenance: true, ActiveOperationID: operationID,
	}
	operation := model.Operation{
		ID: operationID, Kind: model.OperationInstall, Status: model.OperationRunning,
		Phase: model.PhaseRollingBack, ExpectedSourceCommit: commit,
	}
	plan := migration.Plan{
		LegacyRoot: root, LegacyData: legacyData, DestinationData: destination,
		ExpectedSourceCommit: commit, OperationID: operationID, Status: "rolled_back",
		LegacyService: "enterprise-agent-platform.service",
	}
	if err := validateRollingBackRecovery(status, operation, plan, operationID, commit, root, legacyData, destination, "enterprise-agent-platform.service", true); err != nil {
		t.Fatal(err)
	}
	// A legacy timer may have idempotently returned the same plan after an old
	// Manager already erased OperationID. The active journal remains the exact
	// authority and this compatibility state is still recoverable.
	plan.OperationID = ""
	plan.Status = "configured"
	if err := validateRollingBackRecovery(status, operation, plan, operationID, commit, root, legacyData, destination, "enterprise-agent-platform.service", true); err != nil {
		t.Fatal(err)
	}
	plan.DestinationData = "/tmp/unrelated"
	if err := validateRollingBackRecovery(status, operation, plan, operationID, commit, root, legacyData, destination, "enterprise-agent-platform.service", true); err == nil {
		t.Fatal("offline recovery accepted a divergent destination")
	}
	plan.LegacyRoot, plan.LegacyData, plan.DestinationData, plan.LegacyService = "", "", "", ""
	if err := validateRollingBackRecovery(status, operation, plan, operationID, commit, root, legacyData, destination, "enterprise-agent-platform.service", false); err != nil {
		t.Fatalf("online bounded migration projection was rejected: %v", err)
	}
	if err := validateRollingBackRecovery(status, operation, plan, operationID, commit, root, legacyData, destination, "enterprise-agent-platform.service", true); err == nil {
		t.Fatal("offline recovery accepted a migration plan without exact path bindings")
	}
}

func TestProbeLegacyPlatformUsesOwnerToken(t *testing.T) {
	tokenPath := filepath.Join(t.TempDir(), "manager-token")
	token := strings.Repeat("t", 40)
	if err := os.WriteFile(tokenPath, []byte(token+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/internal/manager/health" || request.Header.Get("Authorization") != "Bearer "+token {
			http.Error(response, "unexpected recovery health request", http.StatusUnauthorized)
			return
		}
		response.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	if err := probeLegacyPlatform(config.Config{
		LegacyPlatformGateURL: server.URL,
		InternalTokenFile:     tokenPath,
	}); err != nil {
		t.Fatal(err)
	}
}

func TestLegacyCheckFallbackRequiresExactUnknownFieldResponse(t *testing.T) {
	unsupported := &control.HTTPError{Status: http.StatusBadRequest, Message: `invalid JSON body: json: unknown field "expected_source_commit"`}
	if !legacyCheckDoesNotSupportExpectedCommit(unsupported) {
		t.Fatal("exact old-Manager unknown-field response was not recognized")
	}
	for _, err := range []error{
		&control.HTTPError{Status: http.StatusBadRequest, Message: "manifest is invalid"},
		&control.HTTPError{Status: http.StatusUnauthorized, Message: `unknown field "expected_source_commit"`},
		errors.New(`unknown field "expected_source_commit"`),
	} {
		if legacyCheckDoesNotSupportExpectedCommit(err) {
			t.Fatalf("unsafe compatibility fallback accepted %T: %v", err, err)
		}
	}
}

func TestRecoverRollingBackCommandRestoresServicesAndHoldsSourceLock(t *testing.T) {
	root, err := os.MkdirTemp("", "ubitech-recovery-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	legacyRoot := filepath.Join(root, "source")
	legacyData := filepath.Join(legacyRoot, "enterprise-agent-platform", "data")
	if err := os.MkdirAll(legacyData, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacyData, "platform.db"), []byte("authoritative-legacy-db"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, arguments := range [][]string{
		{"init", "-q"},
		{"config", "user.email", "recovery@example.invalid"},
		{"config", "user.name", "Recovery Test"},
		{"add", "."},
		{"commit", "-q", "-m", "frozen source"},
	} {
		command := exec.Command("git", append([]string{"-C", legacyRoot}, arguments...)...)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", arguments, err, output)
		}
	}
	head, err := exec.Command("git", "-C", legacyRoot, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatal(err)
	}
	expectedCommit := strings.TrimSpace(string(head))

	dataRoot := filepath.Join(root, "managed")
	stateDir := filepath.Join(dataRoot, "manager")
	store, err := journal.Open(stateDir, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	legacy := &migration.Service{
		StatePath: filepath.Join(stateDir, "migration.json"), DestinationData: filepath.Join(dataRoot, "data"),
		BackupRoot: filepath.Join(dataRoot, "backups"), QuarantineRoot: filepath.Join(dataRoot, "quarantine"),
		LegacyService: "enterprise-agent-platform.service", Runner: recoveryLegacyRunner{},
	}
	if _, err := legacy.Configure(legacyRoot, legacyData, "enterprise-agent-platform.service", expectedCommit); err != nil {
		t.Fatal(err)
	}
	op, _, err := store.Begin(model.OperationRequest{
		Kind: model.OperationInstall, IdempotencyKey: "stuck-rollback",
		ExpectedGeneration: store.State().Generation, ExpectedSourceCommit: expectedCommit,
	}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if err := legacy.Cutover(context.Background(), op.ID); err != nil {
		t.Fatal(err)
	}
	snapshots := snapshot.Store{DataDir: filepath.Join(dataRoot, "data"), BackupDir: filepath.Join(dataRoot, "backups")}
	snapshotPath, err := snapshots.Create(context.Background(), op.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := legacy.Rollback(context.Background(), op.ID); err != nil {
		t.Fatal(err)
	}
	legacy.CanRearm = func(migration.Plan, string) bool { return true }
	if err := legacy.Rearm("old-timer"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpdateOperation(op.ID, func(value *model.Operation) error {
		value.Status = model.OperationRunning
		value.Phase = model.PhaseRollingBack
		value.ReservationStatus = model.ReservationMutationStarted
		value.SnapshotPath = snapshotPath
		value.Error = "container ubitech-agent-platform-1 is unhealthy"
		value.UpdatedAt = time.Now().UTC()
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.MutateState(time.Now(), func(value *model.ManagerState) error {
		value.Phase = model.PhaseRollingBack
		value.PublicState = model.StateFailed
		value.Maintenance = true
		value.LastError = "container unhealthy; rollback failed: data directory missing"
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	token := strings.Repeat("m", 40)
	secretsDir := filepath.Join(stateDir, "secrets")
	controlDir := filepath.Join(stateDir, "control")
	if err := os.MkdirAll(secretsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(controlDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(secretsDir, "manager-token"), []byte(token+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	legacyReleases := 0
	legacyGate := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer "+token {
			http.Error(response, "unauthorized", http.StatusUnauthorized)
			return
		}
		switch request.URL.Path {
		case "/internal/manager/health":
			response.WriteHeader(http.StatusOK)
		case "/internal/manager/update/release":
			legacyReleases++
			response.WriteHeader(http.StatusOK)
		default:
			http.NotFound(response, request)
		}
	}))
	defer legacyGate.Close()

	socketPath := filepath.Join(controlDir, "manager.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		freshStore, openErr := journal.Open(stateDir, time.Now())
		if openErr != nil {
			http.Error(response, openErr.Error(), http.StatusInternalServerError)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodGet && request.URL.Path == "/v1/status":
			state := freshStore.State()
			_ = json.NewEncoder(response).Encode(map[string]any{
				"public_state": state.PublicState, "phase": state.Phase, "maintenance": state.Maintenance,
				"active_operation_id": state.ActiveOperationID, "finalize_pending_operation_id": state.FinalizePendingOperationID,
			})
		case request.Method == http.MethodGet && request.URL.Path == "/v1/operations/"+op.ID:
			value, readErr := freshStore.Operation(op.ID)
			if readErr != nil {
				http.Error(response, readErr.Error(), http.StatusNotFound)
				return
			}
			_ = json.NewEncoder(response).Encode(value)
		case request.Method == http.MethodGet && request.URL.Path == "/v1/migrations/legacy":
			value, readErr := (&migration.Service{StatePath: legacy.StatePath}).Plan()
			if readErr != nil {
				http.Error(response, readErr.Error(), http.StatusNotFound)
				return
			}
			_ = json.NewEncoder(response).Encode(value)
		default:
			http.NotFound(response, request)
		}
	})}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })

	configPath := filepath.Join(root, "manager.toml")
	configBody := strings.Join([]string{
		`data_root = "` + dataRoot + `"`,
		`socket_path = "` + socketPath + `"`,
		`internal_token_file = "` + filepath.Join(secretsDir, "manager-token") + `"`,
		`legacy_platform_gate_url = "` + legacyGate.URL + `"`,
		`docker_binary = "/bin/true"`,
	}, "\n") + "\n"
	if err := os.WriteFile(configPath, []byte(configBody), 0o600); err != nil {
		t.Fatal(err)
	}

	lockValue, err := exec.Command("git", "-C", legacyRoot, "rev-parse", "--git-path", "ubitech-agent-update.lock").Output()
	if err != nil {
		t.Fatal(err)
	}
	lockPath := strings.TrimSpace(string(lockValue))
	if !filepath.IsAbs(lockPath) {
		lockPath = filepath.Join(legacyRoot, lockPath)
	}
	oldSystemctl := userSystemctl
	defer func() { userSystemctl = oldSystemctl }()
	activeUnits := map[string]bool{
		"ubitech-agent-manager.service": true, "ubitech-agent-migrate.timer": true,
		"ubitech-agent-migrate.service": false, "enterprise-agent-platform.service": true,
	}
	var systemctlCalls []string
	lockHeldWhenTimerRestored := false
	userSystemctl = func(ctx context.Context, arguments ...string) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		systemctlCalls = append(systemctlCalls, strings.Join(arguments, " "))
		switch arguments[0] {
		case "is-active":
			if activeUnits[arguments[len(arguments)-1]] {
				return nil
			}
			return errors.New("inactive")
		case "stop":
			for _, unit := range arguments[1:] {
				activeUnits[unit] = false
			}
		case "start", "restart":
			unit := arguments[len(arguments)-1]
			activeUnits[unit] = true
			if unit == "ubitech-agent-migrate.timer" {
				file, openErr := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o600)
				if openErr != nil {
					return openErr
				}
				flockErr := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
				lockHeldWhenTimerRestored = flockErr != nil
				if flockErr == nil {
					_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
				}
				_ = file.Close()
			}
		}
		return nil
	}

	err = recoverRollingBackCommand([]string{
		"--config", configPath,
		"--operation-id", op.ID,
		"--expected-source-commit", expectedCommit,
		"--legacy-root", legacyRoot,
		"--legacy-data", legacyData,
		"--legacy-service", "enterprise-agent-platform.service",
		"--recovery-timeout", "1m",
	})
	if err != nil {
		t.Fatalf("offline rollback recovery failed: %v; systemctl=%v", err, systemctlCalls)
	}
	finalStore, err := journal.Open(stateDir, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	finalOperation, err := finalStore.Operation(op.ID)
	if err != nil {
		t.Fatal(err)
	}
	finalState := finalStore.State()
	if finalOperation.Status != model.OperationFailed || !finalOperation.Finalized ||
		finalState.ActiveOperationID != "" || finalState.Maintenance || finalState.PublicState != model.StateIdle {
		t.Fatalf("offline command did not finalize rollback: operation=%#v state=%#v", finalOperation, finalState)
	}
	if _, err := os.Lstat(filepath.Join(dataRoot, "data")); !os.IsNotExist(err) {
		t.Fatalf("offline source rollback retained uncommitted destination: %v", err)
	}
	if legacyReleases != 1 || !activeUnits["ubitech-agent-manager.service"] || !activeUnits["ubitech-agent-migrate.timer"] || !lockHeldWhenTimerRestored {
		t.Fatalf("services/lock were not restored safely: releases=%d active=%v lockHeld=%v calls=%v", legacyReleases, activeUnits, lockHeldWhenTimerRestored, systemctlCalls)
	}
	lockFile, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer lockFile.Close()
	if err := syscall.Flock(int(lockFile.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatalf("source recovery lock remained held after command: %v", err)
	}
}

func TestAwaitOperationQueuesOnlyExplicitlyRetryableFailure(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "manager.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		if strings.Contains(request.URL.Path, "permanent") {
			_, _ = response.Write([]byte(`{"status":"failed","error":"source migration config mismatch"}`))
			return
		}
		_, _ = response.Write([]byte(`{"status":"failed","retryable":true,"error":"image pull is temporarily unavailable"}`))
	})}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	client := control.Client{SocketPath: socket, Token: "0123456789abcdef0123456789abcdef", Timeout: time.Second}

	if err := awaitOperation(client, "op_retry", 0, true); !errors.Is(err, errTemporary) {
		t.Fatalf("retryable source migration failure did not return temporary exit semantics: %v", err)
	}
	if err := awaitOperation(client, "op_permanent", 0, true); err == nil || errors.Is(err, errTemporary) {
		t.Fatalf("permanent source migration failure was incorrectly queued: %v", err)
	}
}

func TestWaitForManagerRejectsDeterministicHTTPFailureImmediately(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "manager.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(http.StatusUnauthorized)
		_, _ = response.Write([]byte(`{"error":"control authentication failed"}`))
	})}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })

	started := time.Now()
	err = waitForManager(control.Client{SocketPath: socket, Token: "wrong-token", Timeout: time.Second})
	var httpErr *control.HTTPError
	if !errors.As(err, &httpErr) || httpErr.Status != http.StatusUnauthorized {
		t.Fatalf("wait error = %v, want HTTP 401", err)
	}
	if time.Since(started) >= time.Second {
		t.Fatalf("deterministic authentication failure was retried: %s", time.Since(started))
	}
}

func TestWaitForManagerDoesNotDecodeLegacyE0OversizedStatus(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "manager.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	encoded := make(chan struct{}, 1)
	releaseHandler := make(chan struct{})
	server := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/v1/status" {
			http.NotFound(response, request)
			return
		}
		encodeLegacyE0Response(response, map[string]any{
			"generation":                    17,
			"public_state":                  "idle",
			"maintenance":                   false,
			"active_operation_id":           "",
			"finalize_pending_operation_id": "",
			"error":                         strings.Repeat("e", legacyE0DiagnosticBytes),
		})
		encoded <- struct{}{}
		// Keep the chunked response open. A caller attempting to ReadAll/decode it
		// cannot finish; a status-only caller has already accepted the 2xx header.
		<-releaseHandler
	})}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })

	result := make(chan error, 1)
	go func() {
		result <- waitForManager(control.Client{SocketPath: socket, Token: "control-token-0123456789abcdef", Timeout: 2 * time.Second})
	}()
	select {
	case err := <-result:
		if err != nil {
			close(releaseHandler)
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		close(releaseHandler)
		t.Fatal("readiness waited for or decoded the legacy status body")
	}
	select {
	case <-encoded:
	case <-time.After(time.Second):
		close(releaseHandler)
		t.Fatal("legacy status JSON encoder did not emit its oversized body")
	}
	close(releaseHandler)
}

func TestLegacyInstallQueuesAmbiguousSuccessfulManagerResponse(t *testing.T) {
	for _, ambiguousRoute := range []string{"operation", "poll"} {
		t.Run(ambiguousRoute, func(t *testing.T) {
			root := t.TempDir()
			dataRoot := filepath.Join(root, "data")
			configPath := filepath.Join(root, "manager.toml")
			socketPath := filepath.Join(root, "manager.sock")
			if err := os.WriteFile(configPath, []byte("data_root = \""+dataRoot+"\"\nsocket_path = \""+socketPath+"\"\nrelease_manifest_url = \"https://releases.example/release.json\"\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			secrets := filepath.Join(dataRoot, "manager", "secrets")
			controlDir := filepath.Join(dataRoot, "manager", "control")
			if err := os.MkdirAll(secrets, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(controlDir, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(secrets, "manager-token"), []byte("control-token-0123456789abcdef0123456789abcdef\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			listener, err := net.Listen("unix", socketPath)
			if err != nil {
				t.Fatal(err)
			}
			server := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				response.Header().Set("Content-Type", "application/json")
				switch {
				case request.Method == http.MethodGet && request.URL.Path == "/v1/status":
					_, _ = response.Write([]byte(`{"public_state":"idle"}`))
				case request.Method == http.MethodPost && request.URL.Path == "/v1/check":
					_, _ = response.Write([]byte(`{"manifest":{"source_commit":"` + strings.Repeat("a", 40) + `"}}`))
				case request.Method == http.MethodPost && request.URL.Path == "/v1/migrations/legacy":
					if ambiguousRoute != "migration" {
						_, _ = response.Write([]byte(`{"status":"configured"}`))
					}
				case request.Method == http.MethodPost && request.URL.Path == "/v1/operations":
					response.WriteHeader(http.StatusAccepted)
					if ambiguousRoute != "operation" {
						_, _ = response.Write([]byte(`{"operation":{"id":"op_test","status":"running"}}`))
					}
				case request.Method == http.MethodGet && request.URL.Path == "/v1/operations/op_test":
					if ambiguousRoute != "poll" {
						_, _ = response.Write([]byte(`{"id":"op_test","status":"failed","retryable":true,"error":"retry later"}`))
					}
				default:
					http.NotFound(response, request)
				}
			})}
			go func() { _ = server.Serve(listener) }()
			t.Cleanup(func() { _ = server.Close() })

			err = installCommand([]string{
				"--config", configPath,
				"--release-manifest-url", "https://releases.example/release.json",
				"--legacy-root", filepath.Join(root, "legacy"),
				"--legacy-data", filepath.Join(root, "legacy", "data"),
				"--legacy-service", "enterprise-agent-platform.service",
				"--expected-source-commit", strings.Repeat("a", 40),
			})
			if !errors.Is(err, errTemporary) {
				t.Fatalf("ambiguous %s response did not queue source migration: %v", ambiguousRoute, err)
			}
		})
	}
}

func TestLegacyInstallContinuesPastLegacyE0OversizedStatusAndConfigure(t *testing.T) {
	root := t.TempDir()
	dataRoot := filepath.Join(root, "data")
	configPath := filepath.Join(root, "manager.toml")
	socketPath := filepath.Join(root, "manager.sock")
	if err := os.WriteFile(configPath, []byte("data_root = \""+dataRoot+"\"\nsocket_path = \""+socketPath+"\"\nrelease_manifest_url = \"https://releases.example/release.json\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	secrets := filepath.Join(dataRoot, "manager", "secrets")
	if err := os.MkdirAll(secrets, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(secrets, "manager-token"), []byte("control-token-0123456789abcdef0123456789abcdef\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	largeDiagnostic := strings.Repeat("e", legacyE0DiagnosticBytes)
	encoded := make(chan string, 2)
	releaseHandlers := make(chan struct{})
	var routeMu sync.Mutex
	var routes []string
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		routeMu.Lock()
		routes = append(routes, request.Method+" "+request.URL.Path)
		routeMu.Unlock()
		switch {
		case request.Method == http.MethodGet && request.URL.Path == "/v1/status":
			encodeLegacyE0Response(response, map[string]any{
				"generation":                    17,
				"public_state":                  "idle",
				"maintenance":                   false,
				"active_operation_id":           "",
				"finalize_pending_operation_id": "",
				"error":                         largeDiagnostic,
			})
			encoded <- "status"
			<-releaseHandlers
		case request.Method == http.MethodPost && request.URL.Path == "/v1/check":
			_, _ = response.Write([]byte(`{"manifest":{"source_commit":"` + strings.Repeat("a", 40) + `"}}`))
		case request.Method == http.MethodPost && request.URL.Path == "/v1/migrations/legacy":
			encodeLegacyE0Response(response, map[string]any{
				"id":       "legacy-plan",
				"status":   "configured",
				"entries":  []map[string]any{{"path": largeDiagnostic, "action": "copy"}},
				"warnings": []string{},
			})
			encoded <- "configure"
			<-releaseHandlers
		case request.Method == http.MethodPost && request.URL.Path == "/v1/operations":
			response.WriteHeader(http.StatusAccepted)
			_, _ = response.Write([]byte(`{"operation":{"id":"op_test","status":"running"}}`))
		case request.Method == http.MethodGet && request.URL.Path == "/v1/operations/op_test":
			_, _ = response.Write([]byte(`{"id":"op_test","status":"succeeded","finalized":true}`))
		default:
			http.NotFound(response, request)
		}
	})}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })

	result := make(chan error, 1)
	go func() {
		result <- installCommand([]string{
			"--config", configPath,
			"--release-manifest-url", "https://releases.example/release.json",
			"--legacy-root", filepath.Join(root, "legacy"),
			"--legacy-data", filepath.Join(root, "legacy", "data"),
			"--legacy-service", "enterprise-agent-platform.service",
			"--expected-source-commit", strings.Repeat("a", 40),
		})
	}()
	select {
	case err := <-result:
		if err != nil {
			close(releaseHandlers)
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		close(releaseHandlers)
		t.Fatal("install waited for or decoded a legacy oversized response")
	}
	for range 2 {
		select {
		case <-encoded:
		case <-time.After(time.Second):
			close(releaseHandlers)
			t.Fatal("legacy JSON encoder did not emit both oversized responses")
		}
	}
	close(releaseHandlers)

	routeMu.Lock()
	gotRoutes := strings.Join(routes, ",")
	routeMu.Unlock()
	wantRoutes := "GET /v1/status,POST /v1/check,POST /v1/migrations/legacy,POST /v1/operations,GET /v1/operations/op_test"
	if gotRoutes != wantRoutes {
		t.Fatalf("install did not continue through start and poll: got %s, want %s", gotRoutes, wantRoutes)
	}
}
