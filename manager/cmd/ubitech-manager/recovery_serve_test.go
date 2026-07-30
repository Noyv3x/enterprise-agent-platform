package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/atomicfile"
	"github.com/ubitech/agent-platform/manager/internal/contract"
	"github.com/ubitech/agent-platform/manager/internal/control"
	"github.com/ubitech/agent-platform/manager/internal/journal"
	"github.com/ubitech/agent-platform/manager/internal/logstore"
	"github.com/ubitech/agent-platform/manager/internal/model"
	"github.com/ubitech/agent-platform/manager/internal/release"
	"github.com/ubitech/agent-platform/manager/internal/selfupdate"
)

const managerServeHelperEnvironment = "UBITECH_TEST_MANAGER_SERVE_RECOVERY"

// TestManagerServeRecoveryHelper turns the Go test executable into a real
// Manager process for TestCurrentManagerServeSurvivesFinalizeRetry. Keeping the
// helper in a subprocess matters: an error escaping serveCommand would end this
// process exactly as it ends the systemd service in production.
func TestManagerServeRecoveryHelper(t *testing.T) {
	if os.Getenv(managerServeHelperEnvironment) != "1" {
		t.Skip("subprocess helper")
	}
	defaultCurrentRecoveryPolicy = currentRecoveryPolicy{
		attemptTimeout: time.Second,
		idlePoll:       10 * time.Millisecond,
		initialDelay:   150 * time.Millisecond,
		maxDelay:       150 * time.Millisecond,
	}
	if code := run([]string{"serve", "--config", os.Getenv("UBITECH_TEST_MANAGER_CONFIG")}); code != 0 {
		t.Fatalf("Manager serve returned exit code %d", code)
	}
}

func TestCurrentManagerServeSurvivesFinalizeRetryWithAuxiliaryUnavailable(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Manager process recovery uses Unix sockets and signals")
	}

	root, err := os.MkdirTemp("/tmp", "ubitech-recovery-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	dataRoot := filepath.Join(root, "data-root")
	stateDir := filepath.Join(dataRoot, "manager")
	secretsDir := filepath.Join(stateDir, "secrets")
	controlDir := filepath.Join(stateDir, "control")
	for _, path := range []string{dataRoot, stateDir, secretsDir, controlDir, filepath.Join(dataRoot, "data")} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	controlToken := strings.Repeat("a", 64)
	if err := os.WriteFile(filepath.Join(secretsDir, "manager-token"), []byte(controlToken+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(secretsDir, "manager-executor-token"), []byte(strings.Repeat("b", 64)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	var releaseCalls atomic.Int32
	firstReleaseEntered := make(chan struct{})
	allowFirstRelease := make(chan struct{})
	secondReleaseEntered := make(chan struct{})
	allowSecondRelease := make(chan struct{})
	var releaseIDsMu sync.Mutex
	var releaseIDs []string
	platform := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/internal/manager/update/release":
			var body struct {
				OperationID string `json:"operation_id"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				http.Error(response, "invalid request", http.StatusBadRequest)
				return
			}
			releaseIDsMu.Lock()
			releaseIDs = append(releaseIDs, body.OperationID)
			releaseIDsMu.Unlock()
			switch releaseCalls.Add(1) {
			case 1:
				close(firstReleaseEntered)
				select {
				case <-allowFirstRelease:
				case <-request.Context().Done():
					return
				}
				http.Error(response, "temporary release failure", http.StatusServiceUnavailable)
				return
			case 2:
				close(secondReleaseEntered)
				select {
				case <-allowSecondRelease:
				case <-request.Context().Done():
					return
				}
			}
			response.WriteHeader(http.StatusNoContent)
		case "/internal/manager/health":
			response.WriteHeader(http.StatusNoContent)
		default:
			response.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(response, `{"service":"synthetic-platform"}`)
		}
	}))
	defer platform.Close()

	gatewayAddress := reserveLoopbackAddress(t)
	socketPath := filepath.Join(controlDir, "manager.sock")
	fakeDocker := writeRecoveryFakeDocker(t, root)
	composePath := filepath.Join(root, "compose.yaml")
	if err := os.WriteFile(composePath, []byte("services: {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(root, "manager.toml")
	config := fmt.Sprintf(
		"data_root = %q\nsocket_path = %q\nlisten = %q\nplatform_url = %q\nplatform_gate_url = %q\nupdate_enabled = false\ncompose_file = %q\ncompose_project = %q\ndocker_binary = %q\nsandbox_network = %q\n",
		dataRoot, socketPath, gatewayAddress, platform.URL, platform.URL, composePath,
		"ubitech-recovery-test", fakeDocker, "ubitech-recovery-test-core",
	)
	if err := os.WriteFile(configPath, []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}

	generationID := strings.Repeat("c", 40)
	manifestPath, images := writeRecoveryManifest(t, stateDir, generationID)
	operationID := seedFinalizePendingUpdate(t, stateDir, generationID, manifestPath, images)
	seedCommittedManagerBinary(t, stateDir, generationID)

	logPath := filepath.Join(root, "manager-helper.log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(os.Args[0], "-test.run=^TestManagerServeRecoveryHelper$", "-test.v")
	command.Env = append(os.Environ(),
		managerServeHelperEnvironment+"=1",
		"UBITECH_TEST_MANAGER_CONFIG="+configPath,
		"XDG_BIN_HOME="+filepath.Join(root, "bin"),
	)
	command.Stdout = logFile
	command.Stderr = logFile
	if err := command.Start(); err != nil {
		_ = logFile.Close()
		t.Fatal(err)
	}
	exited := make(chan error, 1)
	go func() { exited <- command.Wait() }()
	stop := func() string {
		if command.Process != nil {
			_ = command.Process.Signal(syscall.SIGTERM)
		}
		select {
		case <-exited:
		case <-time.After(3 * time.Second):
			if command.Process != nil {
				_ = command.Process.Kill()
			}
			<-exited
		}
		_ = logFile.Close()
		content, _ := os.ReadFile(logPath)
		return string(content)
	}
	stopped := false
	t.Cleanup(func() {
		if !stopped {
			_ = stop()
		}
	})

	select {
	case <-firstReleaseEntered:
	case err := <-exited:
		stopped = true
		_ = logFile.Close()
		content, _ := os.ReadFile(logPath)
		t.Fatalf("Manager exited before the first finalize attempt was observed: %v\n%s", err, content)
	case <-time.After(5 * time.Second):
		t.Fatal("Manager did not reach the pending finalize release")
	}

	pending := readRecoveryManagerStatus(t, socketPath, controlToken)
	if !pending.Maintenance || pending.PublicState != model.StateUpdating || pending.FinalizePendingOperationID != operationID {
		t.Fatalf("control API did not expose the recoverable finalize state: %#v", pending)
	}
	if got := pending.Services["firecrawl-api"].Status; got != "unavailable" {
		t.Fatalf("auxiliary Firecrawl status = %q, want unavailable", got)
	}
	if status := httpStatus(t, "http://"+gatewayAddress+"/"); status != http.StatusServiceUnavailable {
		t.Fatalf("maintenance gateway status = %d, want 503", status)
	}

	close(allowFirstRelease)
	select {
	case <-secondReleaseEntered:
	case err := <-exited:
		stopped = true
		_ = logFile.Close()
		content, _ := os.ReadFile(logPath)
		t.Fatalf("current Manager exited before retrying finalize: %v\n%s", err, content)
	case <-time.After(3 * time.Second):
		t.Fatal("current Manager did not retry the transient finalize failure")
	}
	select {
	case err := <-exited:
		stopped = true
		_ = logFile.Close()
		content, _ := os.ReadFile(logPath)
		t.Fatalf("current Manager exited after a transient finalize error: %v\n%s", err, content)
	default:
	}

	retrying, err := journal.Open(stateDir, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if state := retrying.State(); state.LastError == "" || !state.Maintenance || state.FinalizePendingOperationID != operationID {
		t.Fatalf("transient recovery failure was not durably visible without changing intent: %#v", state)
	}
	audit := logstore.New(filepath.Join(stateDir, "logs", "audit.jsonl"), 10<<20, 5)
	events, err := audit.Tail(20)
	if err != nil {
		t.Fatal(err)
	}
	foundRecoveryFailure := false
	for _, raw := range events {
		var event logstore.Event
		if json.Unmarshal(raw, &event) == nil && event.Type == "manager.recovery_failed" && event.OperationID == operationID && event.Error != "" {
			foundRecoveryFailure = true
			break
		}
	}
	if !foundRecoveryFailure {
		t.Fatalf("manager recovery failure was not written to owner-only audit log: %s", events)
	}
	close(allowSecondRelease)

	deadline := time.Now().Add(3 * time.Second)
	var completed recoveryManagerStatus
	for time.Now().Before(deadline) {
		completed = readRecoveryManagerStatus(t, socketPath, controlToken)
		if completed.PublicState == model.StateIdle && !completed.Maintenance && completed.FinalizePendingOperationID == "" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if completed.PublicState != model.StateIdle || completed.Maintenance || completed.FinalizePendingOperationID != "" {
		t.Fatalf("background recovery did not finish finalize: %#v", completed)
	}
	if got := completed.Services["firecrawl-api"].Status; got != "unavailable" {
		t.Fatalf("completed service projection hid degraded Firecrawl: %q", got)
	}
	if status := httpStatus(t, "http://"+gatewayAddress+"/"); status != http.StatusOK {
		t.Fatalf("gateway did not resume proxying after finalize: HTTP %d", status)
	}

	if calls := releaseCalls.Load(); calls != 2 {
		t.Fatalf("reservation release attempts = %d, want one failure and one retry", calls)
	}
	releaseIDsMu.Lock()
	ids := append([]string(nil), releaseIDs...)
	releaseIDsMu.Unlock()
	if len(ids) != 2 || ids[0] != operationID || ids[1] != operationID {
		t.Fatalf("finalize retry did not preserve the operation identity: %v", ids)
	}

	reopened, err := journal.Open(stateDir, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	operationValue, err := reopened.Operation(operationID)
	if err != nil {
		t.Fatal(err)
	}
	if operationValue.Status != model.OperationSucceeded || !operationValue.Finalized {
		t.Fatalf("durable operation was not finalized: %#v", operationValue)
	}
	if state := reopened.State(); state.ActiveOperationID != "" || state.FinalizePendingOperationID != "" || state.Maintenance || state.PublicState != model.StateIdle {
		t.Fatalf("durable Manager state did not converge: %#v", state)
	}

	select {
	case err := <-exited:
		stopped = true
		_ = logFile.Close()
		content, _ := os.ReadFile(logPath)
		t.Fatalf("Manager exited after successful recovery: %v\n%s", err, content)
	default:
	}
	logs := stop()
	stopped = true
	if strings.Contains(logs, "current Manager exited") {
		t.Fatalf("unexpected Manager failure log:\n%s", logs)
	}
}

type recoveryManagerStatus struct {
	PublicState                model.PublicState `json:"public_state"`
	Maintenance                bool              `json:"maintenance"`
	FinalizePendingOperationID string            `json:"finalize_pending_operation_id"`
	Services                   map[string]struct {
		Status string `json:"status"`
	} `json:"services"`
}

func readRecoveryManagerStatus(t *testing.T, socketPath, token string) recoveryManagerStatus {
	t.Helper()
	client := control.Client{SocketPath: socketPath, Token: token, Timeout: 500 * time.Millisecond}
	deadline := time.Now().Add(2 * time.Second)
	for {
		var status recoveryManagerStatus
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		err := client.Do(ctx, http.MethodGet, "/v1/status", nil, &status)
		cancel()
		if err == nil {
			return status
		}
		if time.Now().After(deadline) {
			t.Fatalf("read Manager status: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func reserveLoopbackAddress(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	return address
}

func httpStatus(t *testing.T, url string) int {
	t.Helper()
	client := &http.Client{Timeout: time.Second}
	response, err := client.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, response.Body)
	return response.StatusCode
}

func writeRecoveryManifest(t *testing.T, stateDir, generationID string) (string, map[string]string) {
	t.Helper()
	images := make(map[string]string)
	for index, name := range []string{
		"platform", "agent-runtime", "camofox", "agent-sandbox", "searxng",
		"firecrawl-api", "firecrawl-playwright", "firecrawl-postgres",
		"firecrawl-redis", "firecrawl-rabbitmq",
	} {
		digit := fmt.Sprintf("%x", (index%15)+1)
		images[name] = "registry.example/" + name + "@sha256:" + strings.Repeat(digit, 64)
	}
	manifest := release.Manifest{
		SchemaVersion:         contract.SchemaVersion,
		Channel:               contract.ReleaseChannel,
		SourceCommit:          generationID,
		GeneratedAt:           time.Now().UTC(),
		ProtocolVersion:       contract.SchemaVersion,
		DatabaseSchemaVersion: 1,
		Manager: release.ManagerRelease{
			Version: generationID,
			Artifacts: map[string]release.Artifact{
				runtime.GOARCH: {URL: "http://127.0.0.1:1/manager", SHA256: strings.Repeat("d", 64)},
			},
		},
		Compose: release.Artifact{URL: "http://127.0.0.1:1/compose", SHA256: strings.Repeat("e", 64)},
		Images:  images,
	}
	dir := filepath.Join(stateDir, "releases", generationID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "manifest.json")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "compose.yaml"), []byte("services: {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path, images
}

func seedFinalizePendingUpdate(t *testing.T, stateDir, generationID, manifestPath string, images map[string]string) string {
	t.Helper()
	now := time.Now().UTC()
	store, err := journal.Open(stateDir, now)
	if err != nil {
		t.Fatal(err)
	}
	operationValue, _, err := store.Begin(model.OperationRequest{
		Kind:               model.OperationUpdate,
		IdempotencyKey:     "serve-finalize-recovery",
		ExpectedGeneration: store.State().Generation,
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpdateOperation(operationValue.ID, func(value *model.Operation) error {
		value.TargetGeneration = generationID
		value.ReservationStatus = model.ReservationConfirmed
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Complete(operationValue.ID, true, func(state *model.ManagerState) {
		state.Current = &model.Generation{
			ID:              generationID,
			SourceCommit:    generationID,
			ManifestPath:    manifestPath,
			DatabaseVersion: 1,
			Images:          images,
			ActivatedAt:     now,
		}
		state.FinalizePendingOperationID = operationValue.ID
		state.PublicState = model.StateUpdating
		state.Maintenance = true
	}, "", now); err != nil {
		t.Fatal(err)
	}
	return operationValue.ID
}

func seedCommittedManagerBinary(t *testing.T, stateDir, generationID string) {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(executable)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(data)
	state := selfupdate.State{
		SchemaVersion: 1,
		Current: &selfupdate.Version{
			Version:           generationID,
			SourceCommit:      generationID,
			Path:              executable,
			SHA256:            hex.EncodeToString(digest[:]),
			VerifiedAt:        time.Now().UTC(),
			PlatformCommitted: true,
		},
		UpdatedAt: time.Now().UTC(),
	}
	if err := atomicfile.WriteJSON(filepath.Join(stateDir, "manager-binaries.json"), state, 0o600); err != nil {
		t.Fatal(err)
	}
}

func writeRecoveryFakeDocker(t *testing.T, root string) string {
	t.Helper()
	path := filepath.Join(root, "fake-docker")
	script := `#!/bin/sh
set -eu
last=""
for value in "$@"; do last="$value"; done
case " $* " in
  *" compose "*" ps --all --quiet "*)
    case "$last" in
      platform) printf '%064d\n' 0 | tr 0 a ;;
      agent-runtime) printf '%064d\n' 0 | tr 0 b ;;
      camofox) printf '%064d\n' 0 | tr 0 c ;;
      searxng) printf '%064d\n' 0 | tr 0 d ;;
      *) printf '%064d\n' 0 | tr 0 e ;;
    esac
    exit 0
    ;;
esac
if [ "${1:-}" = inspect ]; then
  case "$*" in
    *com.docker.compose.project*)
      case "$last" in
        a*) printf 'registry.example/platform@sha256:%064d\tubitech-recovery-test\tplatform\n' 0 | tr 0 1 ;;
        b*) printf 'registry.example/agent-runtime@sha256:%064d\tubitech-recovery-test\tagent-runtime\n' 0 | tr 0 2 ;;
      esac
      exit 0
      ;;
  esac
  case "$last" in
    a*|b*) printf 'running healthy\n' ;;
    *) printf 'running unhealthy\n' ;;
  esac
  exit 0
fi
exit 0
`
	if err := os.WriteFile(path, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestRecoveryManifestFixtureIsValid(t *testing.T) {
	stateDir := t.TempDir()
	path, _ := writeRecoveryManifest(t, stateDir, strings.Repeat("f", 40))
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var manifest release.Manifest
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		t.Fatal(err)
	}
	if err := manifest.Validate(contract.ReleaseChannel, runtime.GOOS, runtime.GOARCH); err != nil {
		t.Fatal(err)
	}
}
