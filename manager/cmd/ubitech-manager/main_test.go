package main

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/config"
	"github.com/ubitech/agent-platform/manager/internal/control"
)

const legacyE0DiagnosticBytes = 3_019_000 // approximately 2.88 MiB

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
	wantRoutes := "GET /v1/status,POST /v1/migrations/legacy,POST /v1/operations,GET /v1/operations/op_test"
	if gotRoutes != wantRoutes {
		t.Fatalf("install did not continue through start and poll: got %s, want %s", gotRoutes, wantRoutes)
	}
}
