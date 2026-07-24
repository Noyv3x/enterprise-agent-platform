package main

import (
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/config"
	"github.com/ubitech/agent-platform/manager/internal/control"
)

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
	}
	if err := validatePreflightConfig(configPath, true, expected); err != nil {
		t.Fatal(err)
	}
	expected.ReleaseChannel = "candidate"
	if err := validatePreflightConfig(configPath, true, expected); err == nil || !strings.Contains(err.Error(), "mismatch for release_channel") {
		t.Fatalf("expected release channel mismatch, got %v", err)
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
