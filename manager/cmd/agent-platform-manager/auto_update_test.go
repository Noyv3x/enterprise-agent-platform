package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/config"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/journal"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/operation"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/releasetest"
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
