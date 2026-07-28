package main

import (
	"context"
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

	"github.com/ubitech/agent-platform/manager/internal/control"
	"github.com/ubitech/agent-platform/manager/internal/driver"
	"github.com/ubitech/agent-platform/manager/internal/journal"
	"github.com/ubitech/agent-platform/manager/internal/model"
)

type observedFixedStackLocker struct {
	mu        sync.Mutex
	attempted chan struct{}
	once      sync.Once
}

func newObservedFixedStackLocker() *observedFixedStackLocker {
	locker := &observedFixedStackLocker{attempted: make(chan struct{})}
	locker.mu.Lock()
	return locker
}

func (l *observedFixedStackLocker) Lock() {
	l.once.Do(func() { close(l.attempted) })
	l.mu.Lock()
}

func (l *observedFixedStackLocker) Unlock() { l.mu.Unlock() }

type firecrawlRunner struct{ calls chan []string }

func (r firecrawlRunner) Run(_ context.Context, _ string, args []string, _ []string) (driver.Result, error) {
	r.calls <- append([]string(nil), args...)
	return driver.Result{}, nil
}

func TestAutoUpdateDueUsesConfiguredInterval(t *testing.T) {
	last := time.Unix(100, 0)
	if autoUpdateDue(last, last.Add(4*time.Minute+59*time.Second), 5*time.Minute) {
		t.Fatal("auto update ran before the configured interval")
	}
	if !autoUpdateDue(last, last.Add(5*time.Minute), 5*time.Minute) {
		t.Fatal("auto update did not run at the configured interval")
	}
	if !autoUpdateDue(last, last.Add(31*time.Second), 30*time.Second) {
		t.Fatal("a shorter patched interval was not effective")
	}
}

func TestFirecrawlRetryDelayBacksOffAndCaps(t *testing.T) {
	tests := map[int]time.Duration{
		0: time.Minute,
		1: time.Minute,
		2: 2 * time.Minute,
		3: 4 * time.Minute,
		6: 30 * time.Minute,
		9: 30 * time.Minute,
	}
	for failures, expected := range tests {
		if got := firecrawlRetryDelay(failures); got != expected {
			t.Fatalf("firecrawlRetryDelay(%d) = %s, want %s", failures, got, expected)
		}
	}
}

func TestFirecrawlReconciliationRequiresAnIdleCommittedGeneration(t *testing.T) {
	current := &model.Generation{
		ID:     strings.Repeat("a", 40),
		Images: map[string]string{"firecrawl-api": "registry/firecrawl@sha256:" + strings.Repeat("b", 64)},
	}
	ready, ok := firecrawlManifest(model.ManagerState{Current: current})
	if !ok || ready.SourceCommit != current.ID || ready.Images["firecrawl-api"] != current.Images["firecrawl-api"] {
		t.Fatalf("idle generation was not eligible: manifest=%#v ok=%v", ready, ok)
	}
	ready.Images["firecrawl-api"] = "changed"
	if current.Images["firecrawl-api"] == "changed" {
		t.Fatal("reconciliation manifest aliases durable state")
	}

	blocked := []model.ManagerState{
		{},
		{Current: current, ActiveOperationID: "op_active"},
		{Current: current, FinalizePendingOperationID: "op_pending"},
		{Current: current, Maintenance: true},
	}
	for _, state := range blocked {
		if manifest, ok := firecrawlManifest(state); ok {
			t.Fatalf("non-idle state was eligible: state=%#v manifest=%#v", state, manifest)
		}
	}
}

func TestFirecrawlReconciliationLocksBeforeReadingCurrentGeneration(t *testing.T) {
	store, err := journal.Open(t.TempDir(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	firstID := strings.Repeat("a", 40)
	secondID := strings.Repeat("b", 40)
	if _, err := store.MutateState(time.Now(), func(state *model.ManagerState) error {
		state.Current = &model.Generation{ID: firstID, Images: map[string]string{"firecrawl-api": "registry/firecrawl@sha256:" + strings.Repeat("c", 64)}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	locker := newObservedFixedStackLocker()
	locked := true
	defer func() {
		if locked {
			locker.mu.Unlock()
		}
	}()
	calls := make(chan []string, 1)
	root := t.TempDir()
	app := &application{
		state: store,
		docker: &driver.DockerCLI{
			Runner: firecrawlRunner{calls: calls}, ComposeProject: "test", ComposeFile: filepath.Join(root, "compose.yaml"),
			GenerationDir: filepath.Join(root, "releases"), DataRoot: filepath.Join(root, "data"), StateDir: filepath.Join(root, "state"),
		},
		fixedStackMu: locker,
	}
	done := make(chan struct{})
	go func() {
		app.reconcileFirecrawl(context.Background())
		close(done)
	}()
	select {
	case <-locker.attempted:
	case <-time.After(time.Second):
		t.Fatal("Firecrawl reconciliation did not attempt to acquire the fixed-stack mutex")
	}
	select {
	case args := <-calls:
		t.Fatalf("Firecrawl touched Compose while the fixed-stack mutex was held: %v", args)
	default:
	}
	if _, err := store.MutateState(time.Now(), func(state *model.ManagerState) error {
		state.Current = &model.Generation{ID: secondID, Images: map[string]string{"firecrawl-api": "registry/firecrawl@sha256:" + strings.Repeat("d", 64)}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	locker.mu.Unlock()
	locked = false

	select {
	case args := <-calls:
		joined := strings.Join(args, " ")
		if !strings.Contains(joined, filepath.Join("releases", secondID, "compose.env")) || strings.Contains(joined, filepath.Join("releases", firstID, "compose.env")) {
			t.Fatalf("reconciliation did not use the generation selected under the mutex: %s", joined)
		}
	case <-time.After(time.Second):
		t.Fatal("Firecrawl reconciliation did not reach Compose after mutex release")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Firecrawl reconciliation did not finish")
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

func TestInstallUsesCurrentOperationAPIOnly(t *testing.T) {
	root := t.TempDir()
	dataRoot := filepath.Join(root, "data")
	configPath := filepath.Join(root, "manager.toml")
	socketPath := filepath.Join(root, "manager.sock")
	manifestURL := "https://releases.example/release.json"
	configBody := "data_root = \"" + dataRoot + "\"\n" +
		"socket_path = \"" + socketPath + "\"\n" +
		"release_manifest_url = \"" + manifestURL + "\"\n"
	if err := os.WriteFile(configPath, []byte(configBody), 0o600); err != nil {
		t.Fatal(err)
	}
	secrets := filepath.Join(dataRoot, "manager", "secrets")
	if err := os.MkdirAll(secrets, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(secrets, "manager-token"), []byte("control-token-0123456789abcdef0123456789abcdef\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	var routes []string
	server := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		routes = append(routes, request.Method+" "+request.URL.Path)
		response.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodGet && request.URL.Path == "/v1/status":
			_, _ = response.Write([]byte(`{"public_state":"idle"}`))
		case request.Method == http.MethodPost && request.URL.Path == "/v1/operations":
			var body map[string]any
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Errorf("decode operation request: %v", err)
			}
			if body["operation"] != "install" || body["manifest_url"] != manifestURL {
				t.Errorf("unexpected install request: %#v", body)
			}
			if len(body) != 3 {
				t.Errorf("install request contains unsupported fields: %#v", body)
			}
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

	if err := installCommand([]string{"--config", configPath}); err != nil {
		t.Fatal(err)
	}
	got := strings.Join(routes, ",")
	want := "GET /v1/status,POST /v1/operations,GET /v1/operations/op_test"
	if got != want {
		t.Fatalf("install routes = %s, want %s", got, want)
	}
}

func TestAwaitOperationReturnsTerminalFailure(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "manager.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"status":"failed","retryable":true,"error":"image pull failed"}`))
	})}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	client := control.Client{SocketPath: socket, Token: "0123456789abcdef0123456789abcdef", Timeout: time.Second}
	if err := awaitOperation(client, "op_failed"); err == nil || err.Error() != "image pull failed" {
		t.Fatalf("terminal operation error = %v", err)
	}
}

func TestWaitForManagerRejectsDeterministicHTTPFailureImmediately(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "manager.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
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
