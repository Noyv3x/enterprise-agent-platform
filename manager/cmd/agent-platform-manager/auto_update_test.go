package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/config"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/control"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/journal"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/logstore"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/operation"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/releasetest"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/sandbox"
)

type retryOncePullEngine struct {
	wiringEngine
	mu        sync.Mutex
	pullCalls int
}

func (e *retryOncePullEngine) Pull(context.Context, release.Manifest) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.pullCalls++
	if e.pullCalls == 1 {
		return errors.New("transient image pull failure")
	}
	return nil
}

type autoUpdateGate struct{}

func (autoUpdateGate) Reserve(context.Context, string) (operation.Reservation, error) {
	return operation.Reservation{Ready: true, Reserved: true}, nil
}
func (autoUpdateGate) Commit(context.Context, string) error  { return nil }
func (autoUpdateGate) Release(context.Context, string) error { return nil }
func (autoUpdateGate) Health(context.Context) error          { return nil }

type autoUpdateSnapshot struct{}

func (autoUpdateSnapshot) Create(context.Context, string) (string, error) {
	return "/snapshot", nil
}
func (autoUpdateSnapshot) Restore(context.Context, string) error { return nil }

func TestAutoUpdateIdempotencyKeySeparatesReleaseURLsWithinHour(t *testing.T) {
	now := time.Date(2026, time.September, 2, 10, 30, 0, 0, time.UTC)
	target := strings.Repeat("2", 40)
	first := autoUpdateIdempotencyKey("https://releases.example/one.json", target, now)
	second := autoUpdateIdempotencyKey("https://releases.example/two.json", target, now.Add(20*time.Minute))
	if first == second {
		t.Fatalf("same-hour release URL change reused idempotency key %q", first)
	}
	if repeated := autoUpdateIdempotencyKey("https://releases.example/one.json", target, now.Add(20*time.Minute)); repeated != first {
		t.Fatalf("same URL and target lost hourly idempotency: first=%q repeated=%q", first, repeated)
	}
}

func TestAutoUpdateRetriesAcceptedTargetAfterConditionalNotModified(t *testing.T) {
	currentID := strings.Repeat("1", 40)
	targetID := strings.Repeat("2", 40)
	var fixture releasetest.Fixture
	var manifestData []byte
	var requestMu sync.Mutex
	conditionalNotModified := 0

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/manifest.json":
			if request.Header.Get("If-None-Match") == `"target"` {
				requestMu.Lock()
				conditionalNotModified++
				requestMu.Unlock()
				response.WriteHeader(http.StatusNotModified)
				return
			}
			response.Header().Set("Content-Type", "application/json")
			response.Header().Set("ETag", `"target"`)
			_, _ = response.Write(manifestData)
		case "/agent-platform-compose.yaml":
			_, _ = response.Write(fixture.Compose)
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()
	fixture = releasetest.NewTarget(targetID, releasetest.WithArtifactBaseURL(server.URL))
	var err error
	manifestData, err = json.Marshal(fixture.Manifest)
	if err != nil {
		t.Fatal(err)
	}

	root := t.TempDir()
	store, err := journal.Open(filepath.Join(root, "journal"), time.Unix(10, 0))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.MutateState(time.Unix(11, 0), func(state *model.ManagerState) error {
		state.Current = &model.Generation{ID: currentID}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	engine := &retryOncePullEngine{}
	orchestrator := &operation.Orchestrator{
		Store: store, Engine: engine, Gate: autoUpdateGate{}, Snapshots: autoUpdateSnapshot{},
		ReleasesDir: filepath.Join(root, "releases"), ManifestURL: server.URL + "/manifest.json",
		Channel: fixture.Manifest.Channel, ReleaseClient: release.Client{HTTP: server.Client()},
	}
	cfg := config.Config{UpdateEnabled: true, ReleaseURL: server.URL + "/manifest.json"}
	app := &application{configs: config.NewManager(cfg), state: store, operations: orchestrator}

	app.autoUpdate(context.Background())
	firstID := store.State().ActiveOperationID
	if firstID == "" {
		t.Fatal("initial modified response did not start an update")
	}
	first, err := orchestrator.Await(context.Background(), firstID)
	if err != nil || first.Status != model.OperationFailed || !first.Finalized || !first.Retryable {
		t.Fatalf("first update did not reach a retryable pull failure: operation=%#v err=%v", first, err)
	}

	app.autoUpdate(context.Background())
	secondID := store.State().ActiveOperationID
	if secondID == "" || secondID == firstID {
		t.Fatalf("conditional 304 did not start a new attempt: first=%q second=%q", firstID, secondID)
	}
	second, err := orchestrator.Await(context.Background(), secondID)
	if err != nil || second.Status != model.OperationSucceeded || !second.Finalized || second.Attempt != 2 {
		t.Fatalf("retry did not commit: operation=%#v err=%v", second, err)
	}
	if current := store.State().Current; current == nil || current.ID != targetID {
		t.Fatalf("retry committed current=%#v, want %s", current, targetID)
	}

	app.autoUpdate(context.Background())
	if app.pendingAutoUpdate.targetID != "" || app.pendingAutoUpdate.operationID != "" {
		t.Fatalf("committed target remained pending: %#v", app.pendingAutoUpdate)
	}
	requestMu.Lock()
	gotNotModified := conditionalNotModified
	requestMu.Unlock()
	if gotNotModified < 1 {
		t.Fatal("retry was not composed with a conditional 304 response")
	}
}

func TestAutoUpdateUsesCurrentObservedAfterBlockedManifestFetch(t *testing.T) {
	targetID := strings.Repeat("4", 40)
	rolledBackID := strings.Repeat("3", 40)
	var fixture releasetest.Fixture
	var manifestData []byte
	fetchStarted := make(chan struct{})
	releaseFetch := make(chan struct{})

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/manifest.json":
			close(fetchStarted)
			<-releaseFetch
			response.Header().Set("Content-Type", "application/json")
			response.Header().Set("ETag", `"target"`)
			_, _ = response.Write(manifestData)
		case "/agent-platform-compose.yaml":
			_, _ = response.Write(fixture.Compose)
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()
	fixture = releasetest.NewTarget(targetID, releasetest.WithArtifactBaseURL(server.URL))
	var err error
	manifestData, err = json.Marshal(fixture.Manifest)
	if err != nil {
		t.Fatal(err)
	}

	root := t.TempDir()
	store, err := journal.Open(filepath.Join(root, "journal"), time.Unix(20, 0))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.MutateState(time.Unix(21, 0), func(state *model.ManagerState) error {
		state.Current = &model.Generation{ID: rolledBackID}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	orchestrator := &operation.Orchestrator{
		Store: store, Engine: wiringEngine{}, ReleasesDir: filepath.Join(root, "releases"),
		ManifestURL: server.URL + "/manifest.json", Channel: fixture.Manifest.Channel,
		ReleaseClient: release.Client{HTTP: server.Client()},
	}
	cfg := config.Config{UpdateEnabled: true, ReleaseURL: server.URL + "/manifest.json"}
	app := &application{configs: config.NewManager(cfg), state: store, operations: orchestrator}
	done := make(chan struct{})
	go func() {
		app.autoUpdate(context.Background())
		close(done)
	}()
	select {
	case <-fetchStarted:
	case <-time.After(time.Second):
		t.Fatal("manifest fetch did not block")
	}
	if _, err := store.MutateState(time.Unix(22, 0), func(state *model.ManagerState) error {
		state.Current = &model.Generation{ID: targetID}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Begin(model.OperationRequest{
		Kind: model.OperationRestart, IdempotencyKey: "concurrent-rollback",
		ExpectedGeneration: store.State().Generation,
	}, time.Unix(23, 0)); err != nil {
		t.Fatal(err)
	}
	close(releaseFetch)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("auto-update did not finish after manifest fetch resumed")
	}
	if app.pendingAutoUpdate.targetID != targetID || app.pendingAutoUpdate.operationID != "" {
		t.Fatalf("active Current transition cleared the accepted target: pending=%#v", app.pendingAutoUpdate)
	}
}

type blockedReapEngine struct {
	wiringEngine
	started chan struct{}
}

func (e blockedReapEngine) StopSandbox(ctx context.Context, _ string) error {
	close(e.started)
	<-ctx.Done()
	return ctx.Err()
}

func newPeriodicUpdateApplication(t *testing.T) (*application, string) {
	t.Helper()
	targetID := strings.Repeat("7", 40)
	var fixture releasetest.Fixture
	var manifestData []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/manifest.json":
			_, _ = w.Write(manifestData)
		case "/agent-platform-compose.yaml":
			_, _ = w.Write(fixture.Compose)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	fixture = releasetest.NewTarget(targetID, releasetest.WithArtifactBaseURL(server.URL))
	var err error
	manifestData, err = json.Marshal(fixture.Manifest)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	store, err := journal.Open(filepath.Join(root, "journal"), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.MutateState(time.Now(), func(state *model.ManagerState) error {
		state.Current = &model.Generation{ID: strings.Repeat("6", 40)}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{UpdateEnabled: true, UpdateInterval: time.Second, ReleaseURL: server.URL + "/manifest.json"}
	orchestrator := &operation.Orchestrator{
		Store: store, Engine: wiringEngine{}, Gate: autoUpdateGate{}, Snapshots: autoUpdateSnapshot{},
		ReleasesDir: filepath.Join(root, "releases"), ManifestURL: cfg.ReleaseURL,
		Channel: fixture.Manifest.Channel, ReleaseClient: release.Client{HTTP: server.Client()},
	}
	return &application{
		configs: config.NewManager(cfg), state: store, operations: orchestrator,
		audit: logstore.New(filepath.Join(root, "audit.jsonl"), 1<<20, 2),
	}, targetID
}

func TestPeriodicAutoUpdateCommitsWhileSandboxReapingIsBlocked(t *testing.T) {
	app, targetID := newPeriodicUpdateApplication(t)
	app.operations.MaintenanceMu = &sync.Mutex{}
	root := t.TempDir()
	engine := blockedReapEngine{started: make(chan struct{})}
	var err error
	app.sandboxes, err = sandbox.Open(identity.CompileTimeActiveProfile(), engine,
		filepath.Join(root, "data"), filepath.Join(root, "sandboxes.json"),
		"registry.invalid/sandbox@sha256:"+strings.Repeat("a", 64), "agent-platform_core", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.sandboxes.Ensure(context.Background(), "private-1", "user-1", time.Unix(1, 0)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	sandboxTicks := make(chan time.Time)
	updateTicks := make(chan time.Time)
	done := make(chan struct{})
	go func() {
		app.runBackground(ctx, sandboxTicks, updateTicks)
		close(done)
	}()
	defer func() {
		cancel()
		<-done
	}()
	select {
	case sandboxTicks <- time.Now():
	case <-time.After(5 * time.Second):
		t.Fatal("sandbox loop did not start")
	}
	select {
	case <-engine.started:
	case <-time.After(5 * time.Second):
		t.Fatal("sandbox reaping did not enter blocked engine")
	}
	select {
	case updateTicks <- time.Now().Add(time.Minute):
	case <-time.After(5 * time.Second):
		t.Fatal("blocked sandbox reaping starved automatic release polling")
	}
	deadline := time.After(5 * time.Second)
	poll := time.NewTicker(time.Millisecond)
	defer poll.Stop()
	for {
		state := app.state.State()
		if state.Current != nil && state.Current.ID == targetID && state.ActiveOperationID == "" && state.FinalizePendingOperationID == "" {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("periodic update did not commit while sandbox cleanup blocked: %#v", state)
		case <-poll.C:
		}
	}
}

func TestPeriodicAutoUpdateDefersAdmissionUntilRecoverySettles(t *testing.T) {
	app, _ := newPeriodicUpdateApplication(t)
	if _, err := app.state.MutateState(time.Now(), func(state *model.ManagerState) error {
		state.FinalizePendingOperationID = "pending-recovery"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	admitted := make(chan struct{})
	app.operations.AdmissionCheck = func(model.ManagerState) error {
		close(admitted)
		return errors.New("test admission rejection after recovery")
	}
	ctx, cancel := context.WithCancel(context.Background())
	ticks := make(chan time.Time)
	done := make(chan struct{})
	go func() {
		app.runAutoUpdateLoop(ctx, ticks)
		close(done)
	}()
	defer func() {
		cancel()
		<-done
	}()
	tick := func() {
		t.Helper()
		select {
		case ticks <- time.Now().Add(time.Hour):
		case <-time.After(5 * time.Second):
			t.Fatal("periodic update loop stopped accepting ticks")
		}
	}
	// Receiving the second tick proves the first was fully processed.
	tick()
	tick()
	if state := app.state.State(); state.Candidate != nil || state.ActiveOperationID != "" {
		t.Fatalf("periodic update crossed pending recovery: %#v", state)
	}
	if _, err := app.state.MutateState(time.Now(), func(state *model.ManagerState) error {
		state.FinalizePendingOperationID = ""
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	tick()
	select {
	case <-admitted:
	case <-time.After(5 * time.Second):
		t.Fatal("settled recovery did not resume automatic update admission")
	}
}

func TestAutoUpdateAuditsCheckAndStartFailuresWithoutCredentials(t *testing.T) {
	t.Run("check", func(t *testing.T) {
		app, _ := newPeriodicUpdateApplication(t)
		app.operations.ReleaseClient.HTTP = &http.Client{Transport: autoUpdateFailingTransport{}}
		app.autoUpdate(context.Background())
		assertAutoUpdateAudit(t, app, "auto_update.check_failed", "transport unavailable", "password", "query-secret")
	})
	t.Run("start", func(t *testing.T) {
		app, _ := newPeriodicUpdateApplication(t)
		cfg := app.configs.Config()
		cfg.InternalToken = "internal-secret"
		app.configs = config.NewManager(cfg)
		app.api = &control.API{ControlToken: "control-secret", ExecutorToken: "executor-secret"}
		app.operations.AdmissionCheck = func(model.ManagerState) error {
			return errors.New("admission blocked internal-secret control-secret executor-secret " + cfg.ReleaseURL + strings.Repeat(" diagnostic", 5000))
		}
		app.autoUpdate(context.Background())
		assertAutoUpdateAudit(t, app, "auto_update.start_failed", "admission blocked", "internal-secret", "control-secret", "executor-secret", cfg.ReleaseURL)
		if app.state.State().ActiveOperationID != "" {
			t.Fatal("rejected automatic update created an active operation")
		}
	})
}

type autoUpdateFailingTransport struct{}

func (autoUpdateFailingTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, &url.Error{Op: "Get", URL: "https://user:password@release.invalid/manifest.json?token=query-secret", Err: errors.New("transport unavailable")}
}

func assertAutoUpdateAudit(t *testing.T, app *application, eventType, cause string, secrets ...string) {
	t.Helper()
	events, err := app.audit.Tail(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("automatic update failure events = %d, want 1", len(events))
	}
	var event logstore.Event
	if err := json.Unmarshal(events[0], &event); err != nil {
		t.Fatal(err)
	}
	if event.Type != eventType || !strings.Contains(event.Error, cause) {
		t.Fatalf("automatic update error lost stage or cause: %#v", event)
	}
	if event.Error != journal.BoundDiagnostic(event.Error) {
		t.Fatal("automatic update error was not bounded")
	}
	for _, secret := range secrets {
		if strings.Contains(string(events[0]), secret) {
			t.Fatalf("automatic update audit exposed credential %q", secret)
		}
	}
}
