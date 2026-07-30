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

	"github.com/ubitech/agent-platform/manager/internal/config"
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

type blockingFirecrawlRunner struct {
	started chan struct{}
	once    sync.Once
	mu      sync.Mutex
	calls   [][]string
}

func TestTriggeredReconciliationRunsBeforeThePeriodicDelay(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	trigger := make(chan struct{}, 1)
	called := make(chan struct{}, 1)
	go runTriggeredReconciliationLoop(
		ctx,
		time.Hour,
		func(int) time.Duration { return time.Hour },
		trigger,
		func(context.Context) error {
			called <- struct{}{}
			return nil
		},
	)
	trigger <- struct{}{}
	select {
	case <-called:
	case <-time.After(time.Second):
		t.Fatal("finalized-generation trigger did not start maintenance")
	}
}

func (r *blockingFirecrawlRunner) Run(ctx context.Context, _ string, args []string, _ []string) (driver.Result, error) {
	r.mu.Lock()
	r.calls = append(r.calls, append([]string(nil), args...))
	r.mu.Unlock()
	if strings.Contains(strings.Join(args, " "), " up --detach --wait --wait-timeout 600 firecrawl-api") {
		r.once.Do(func() { close(r.started) })
		<-ctx.Done()
		return driver.Result{}, ctx.Err()
	}
	return driver.Result{}, errors.New("unexpected diagnostic command after reconciliation cancellation")
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

func TestCurrentRecoveryRetryDelayBacksOffAndCaps(t *testing.T) {
	policy := currentRecoveryPolicy{
		idlePoll:     time.Second,
		initialDelay: 5 * time.Second,
		maxDelay:     time.Minute,
	}
	tests := map[int]time.Duration{
		0: time.Second,
		1: 5 * time.Second,
		2: 10 * time.Second,
		3: 20 * time.Second,
		4: 40 * time.Second,
		5: time.Minute,
		9: time.Minute,
	}
	for failures, expected := range tests {
		if got := currentRecoveryRetryDelay(failures, policy); got != expected {
			t.Fatalf("currentRecoveryRetryDelay(%d) = %s, want %s", failures, got, expected)
		}
	}
}

func TestInitialCurrentRecoveryKeepsFailureForBackgroundRetry(t *testing.T) {
	want := errors.New("readiness is temporarily unavailable")
	calls := 0
	failures := initialCurrentRecovery(
		context.Background(),
		currentRecoveryPolicy{attemptTimeout: time.Second},
		func(context.Context) error {
			calls++
			return want
		},
	)
	if failures != 1 || calls != 1 {
		t.Fatalf("initial recovery = failures %d, calls %d; want 1, 1", failures, calls)
	}
}

func TestCurrentRecoveryAttemptHasIndependentTimeout(t *testing.T) {
	timeout := 20 * time.Millisecond
	started := time.Now()
	err := runCurrentRecoveryAttempt(context.Background(), timeout, func(ctx context.Context) error {
		deadline, ok := ctx.Deadline()
		if !ok {
			t.Fatal("recovery attempt did not receive a deadline")
		}
		if remaining := time.Until(deadline); remaining <= 0 || remaining > timeout {
			t.Fatalf("recovery deadline remaining = %s, want within (0, %s]", remaining, timeout)
		}
		<-ctx.Done()
		return ctx.Err()
	})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("recovery attempt error = %v, want deadline exceeded", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("bounded recovery took %s", elapsed)
	}
}

func TestCurrentRecoveryLoopRetriesUntilPendingStateConverges(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	policy := currentRecoveryPolicy{
		attemptTimeout: 100 * time.Millisecond,
		idlePoll:       time.Millisecond,
		initialDelay:   2 * time.Millisecond,
		maxDelay:       8 * time.Millisecond,
	}
	var mu sync.Mutex
	calls := 0
	converged := make(chan struct{})
	pending := func() bool {
		mu.Lock()
		defer mu.Unlock()
		return calls < 3
	}
	recover := func(context.Context) error {
		mu.Lock()
		defer mu.Unlock()
		calls++
		if calls < 3 {
			return errors.New("injected transient recovery failure")
		}
		close(converged)
		return nil
	}
	done := make(chan struct{})
	go func() {
		runCurrentRecoveryLoop(ctx, 0, policy, pending, recover)
		close(done)
	}()
	select {
	case <-converged:
	case <-time.After(time.Second):
		t.Fatal("current recovery did not retry to convergence")
	}
	mu.Lock()
	if calls != 3 {
		t.Fatalf("recovery calls = %d, want 3", calls)
	}
	mu.Unlock()
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("current recovery loop did not stop with its Manager context")
	}
}

func TestCapabilityReconciliationAllowsPreMaintenanceUpdate(t *testing.T) {
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
	active, ok := firecrawlManifest(model.ManagerState{Current: current, ActiveOperationID: "op_pulling", Phase: model.PhasePulling})
	if !ok || active.SourceCommit != current.ID {
		t.Fatalf("pre-maintenance pull blocked current capability repair: manifest=%#v ok=%v", active, ok)
	}

	blocked := []model.ManagerState{
		{},
		{Current: current, FinalizePendingOperationID: "op_pending"},
		{Current: current, Maintenance: true},
	}
	for _, state := range blocked {
		if manifest, ok := firecrawlManifest(state); ok {
			t.Fatalf("non-idle state was eligible: state=%#v manifest=%#v", state, manifest)
		}
	}
}

func TestReconciliationContextCancelsWhenMaintenanceBegins(t *testing.T) {
	store, err := journal.Open(t.TempDir(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	generation := strings.Repeat("a", 40)
	if _, err := store.MutateState(time.Now(), func(state *model.ManagerState) error {
		state.Current = &model.Generation{ID: generation}
		state.ActiveOperationID = "op_pulling"
		state.Phase = model.PhasePulling
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	app := &application{state: store}
	ctx, finish := app.reconciliationContext(context.Background(), generation, time.Minute)
	defer finish()
	if _, err := store.MutateState(time.Now(), func(state *model.ManagerState) error {
		state.Maintenance = true
		state.PublicState = model.StateUpdating
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ctx.Done():
		if !errors.Is(ctx.Err(), context.Canceled) {
			t.Fatalf("reconciliation context error = %v, want cancellation", ctx.Err())
		}
	case <-time.After(time.Second):
		t.Fatal("maintenance did not cancel current-generation reconciliation")
	}
}

func TestFirecrawlReconciliationCancellationYieldsToMaintenanceWithoutDiagnostics(t *testing.T) {
	store, err := journal.Open(t.TempDir(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	generation := strings.Repeat("a", 40)
	if _, err := store.MutateState(time.Now(), func(state *model.ManagerState) error {
		state.Current = &model.Generation{ID: generation, Images: map[string]string{
			"firecrawl-api": "registry/firecrawl@sha256:" + strings.Repeat("b", 64),
		}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	runner := &blockingFirecrawlRunner{started: make(chan struct{})}
	app := &application{
		state: store,
		docker: &driver.DockerCLI{
			Runner: runner, Binary: "docker", ComposeProject: "test",
			ComposeFile:   filepath.Join(root, "compose.yaml"),
			GenerationDir: filepath.Join(root, "releases"), DataRoot: filepath.Join(root, "data"),
			StateDir: filepath.Join(root, "state"),
		},
		fixedStackMu: &sync.Mutex{},
	}
	result := make(chan error, 1)
	go func() { result <- app.reconcileFirecrawl(context.Background()) }()
	select {
	case <-runner.started:
	case <-time.After(time.Second):
		t.Fatal("Firecrawl reconciliation did not start")
	}
	if _, err := store.MutateState(time.Now(), func(state *model.ManagerState) error {
		state.Maintenance = true
		state.PublicState = model.StateUpdating
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("maintenance cancellation was reported as a reconciliation failure: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("maintenance cancellation did not promptly release Firecrawl reconciliation")
	}
	runner.mu.Lock()
	defer runner.mu.Unlock()
	if len(runner.calls) != 1 {
		t.Fatalf("maintenance cancellation ran diagnostics or another mutation: %#v", runner.calls)
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
		state.ActiveOperationID = "op_pulling"
		state.Phase = model.PhasePulling
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
	currentRecoveryAt := strings.Index(text, "initialRecoveryFailures := initialCurrentRecovery(")
	retryAt := strings.Index(text, "go runCurrentRecoveryLoop(")
	backgroundAt := strings.Index(text, "go app.background(ctx)")
	if recoverAt < 0 || acknowledgeAt < 0 || awaitAt < 0 || currentRecoveryAt < 0 || retryAt < 0 || backgroundAt < 0 || !(recoverAt < acknowledgeAt && acknowledgeAt < awaitAt && awaitAt < currentRecoveryAt && currentRecoveryAt < retryAt && retryAt < backgroundAt) {
		t.Fatalf("unsafe candidate/current startup ordering: recovery=%d acknowledgement=%d watchdog=%d current=%d retry=%d background=%d", recoverAt, acknowledgeAt, awaitAt, currentRecoveryAt, retryAt, backgroundAt)
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

func TestRecoverCurrentCommandRequiresExplicitSafetyInputs(t *testing.T) {
	tests := []struct {
		arguments []string
		want      string
	}{
		{arguments: nil, want: "--yes"},
		{arguments: []string{"--yes"}, want: "--config"},
		{arguments: []string{"--yes", "--config", "/tmp/manager.toml"}, want: "--expected-sha256"},
	}
	for _, test := range tests {
		if err := recoverCurrentCommand(test.arguments); err == nil || !strings.Contains(err.Error(), test.want) {
			t.Fatalf("recoverCurrentCommand(%v) error = %v, want containing %q", test.arguments, err, test.want)
		}
	}
}

func TestRecoveryConfigRejectsSymbolicLink(t *testing.T) {
	directory := t.TempDir()
	configPath := filepath.Join(directory, "manager.toml")
	if err := os.WriteFile(configPath, []byte("data_root = \"/tmp/data\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	linkPath := filepath.Join(directory, "manager-link.toml")
	if err := os.Symlink(configPath, linkPath); err != nil {
		t.Fatal(err)
	}
	if err := validateRecoveryConfigFile(linkPath); err == nil {
		t.Fatal("symbolic-link recovery config was accepted")
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

func TestGatewayControllerHotReconcilesIndependentLANListener(t *testing.T) {
	primary := reserveTCPAddress(t)
	lanLoopback := reserveTCPAddress(t)
	_, port, err := net.SplitHostPort(lanLoopback)
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Defaults()
	if err != nil {
		t.Fatal(err)
	}
	cfg.GatewayAddress = primary
	cfg.ConfigPath = filepath.Join(t.TempDir(), "manager.toml")
	cfg.LANEnabled = true
	cfg.LANAddress = "127.0.0.1:" + port
	cfg.DirectAccessCIDRs = []string{"127.0.0.0/8"}
	cfg.TrustedIngressCIDRs = []string{"127.0.0.0/8"}
	store, err := journal.Open(t.TempDir(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	configs := config.NewManager(cfg)
	controller := newGatewayController(&application{config: cfg, configs: configs, state: store})
	t.Cleanup(controller.Stop)
	if err := controller.Start(); err != nil {
		t.Fatal(err)
	}
	configs.SetLANApply(controller.ApplyLANConfig)
	if status := configs.Public(); !status.LANActive || status.LANError != "" {
		t.Fatalf("LAN status after start = %#v", status)
	}
	assertHTTPStatus(t, "http://"+cfg.LANAddress+"/__ubitech/health", http.StatusOK)
	enabled := false
	if _, err := configs.Patch(config.Patch{LANEnabled: &enabled}); err != nil {
		t.Fatal(err)
	}
	if status := configs.Public(); status.LANActive || status.LANError != "" {
		t.Fatalf("LAN status after disable = %#v", status)
	}
	if connection, err := net.DialTimeout("tcp", cfg.LANAddress, 100*time.Millisecond); err == nil {
		_ = connection.Close()
		t.Fatal("disabled LAN listener still accepts connections")
	}

	enabled = true
	if _, err := configs.Patch(config.Patch{LANEnabled: &enabled}); err != nil {
		t.Fatal(err)
	}
	assertHTTPStatus(t, "http://"+cfg.LANAddress+"/__ubitech/health", http.StatusOK)

	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = occupied.Close() })
	occupiedAddress := occupied.Addr().String()
	if _, err := configs.Patch(config.Patch{LANListen: &occupiedAddress}); err == nil {
		t.Fatal("occupied LAN listener update unexpectedly succeeded")
	}
	status := configs.Public()
	if status.LANListen != cfg.LANAddress || !status.LANActive || status.LANError == "" {
		t.Fatalf("failed bind did not retain active LAN configuration: %#v", status)
	}
	assertHTTPStatus(t, "http://"+cfg.LANAddress+"/__ubitech/health", http.StatusOK)
	assertHTTPStatus(t, "http://"+primary+"/__ubitech/health", http.StatusOK)
}

func assertHTTPStatus(t *testing.T, address string, want int) {
	t.Helper()
	client := &http.Client{Timeout: time.Second}
	response, err := client.Get(address)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != want {
		t.Fatalf("GET %s = %d, want %d", address, response.StatusCode, want)
	}
}

func reserveTCPAddress(t *testing.T) string {
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
