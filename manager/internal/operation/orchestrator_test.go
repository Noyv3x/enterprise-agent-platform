package operation

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/driver"
	"github.com/ubitech/agent-platform/manager/internal/journal"
	"github.com/ubitech/agent-platform/manager/internal/model"
	"github.com/ubitech/agent-platform/manager/internal/release"
)

type fakeEngine struct {
	mu     sync.Mutex
	calls  []string
	failAt string
}

type temporaryManifestTransport struct {
	base     http.RoundTripper
	attempts int
}

func (t *temporaryManifestTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.URL.Path == "/manifest" && t.attempts == 0 {
		t.attempts++
		return &http.Response{
			StatusCode: http.StatusNotFound,
			Status:     "404 Not Found",
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader("")),
			Request:    request,
		}, nil
	}
	t.attempts++
	return t.base.RoundTrip(request)
}

func (e *fakeEngine) add(value string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.calls = append(e.calls, value)
	if e.failAt == value {
		return errors.New("injected " + value + " failure")
	}
	return nil
}
func (e *fakeEngine) Preflight(context.Context) error                         { return e.add("preflight") }
func (e *fakeEngine) Pull(context.Context, release.Manifest) error            { return e.add("pull") }
func (e *fakeEngine) Prepare(context.Context, release.Manifest) error         { return e.add("prepare") }
func (e *fakeEngine) StopFixed(context.Context) error                         { return e.add("stop") }
func (e *fakeEngine) StartFixed(context.Context, release.Manifest) error      { return e.add("start") }
func (e *fakeEngine) Migrate(context.Context, release.Manifest) error         { return e.add("migrate") }
func (e *fakeEngine) Probe(context.Context, release.Manifest) error           { return e.add("probe") }
func (e *fakeEngine) Logs(context.Context, string, int) (string, error)       { return "", nil }
func (e *fakeEngine) EnsureSandbox(context.Context, driver.SandboxSpec) error { return nil }
func (e *fakeEngine) StopSandbox(context.Context, string) error               { return nil }
func (e *fakeEngine) RemoveSandbox(context.Context, string) error             { return nil }
func (e *fakeEngine) SandboxRunning(context.Context, string) (bool, error)    { return true, nil }
func (e *fakeEngine) ExecArgs(driver.SandboxSpec, string, string, []string) (string, []string) {
	return "true", nil
}

type fakeSnapshot struct{}

func (fakeSnapshot) Create(context.Context, string) (string, error) { return "/snapshot", nil }
func (fakeSnapshot) Restore(context.Context, string) error          { return nil }

type scriptedSnapshot struct {
	creates      []string
	restores     []string
	failRestores int
}

type readOnlyJournalSnapshot struct {
	operationsDir string
	restores      []string
}

func (s *readOnlyJournalSnapshot) Create(context.Context, string) (string, error) {
	if err := os.Chmod(s.operationsDir, 0o500); err != nil {
		return "", err
	}
	return "/snapshots/rescue", nil
}

func (s *readOnlyJournalSnapshot) Restore(_ context.Context, path string) error {
	s.restores = append(s.restores, path)
	return nil
}

func (s *scriptedSnapshot) Create(context.Context, string) (string, error) {
	if len(s.creates) == 0 {
		return "", errors.New("no scripted snapshot")
	}
	path := s.creates[0]
	s.creates = s.creates[1:]
	return path, nil
}

func (s *scriptedSnapshot) Restore(_ context.Context, path string) error {
	s.restores = append(s.restores, path)
	if s.failRestores > 0 {
		s.failRestores--
		return errors.New("injected snapshot restore failure")
	}
	return nil
}

type fakeGate struct{}

func (fakeGate) Reserve(context.Context, string) (Reservation, error) {
	return Reservation{Reserved: true}, nil
}
func (fakeGate) Release(context.Context, string) error { return nil }
func (fakeGate) Health(context.Context) error          { return nil }

type reserveCountingGate struct{ reservations int }

func (g *reserveCountingGate) Reserve(context.Context, string) (Reservation, error) {
	g.reservations++
	return Reservation{Reserved: true}, nil
}
func (*reserveCountingGate) Release(context.Context, string) error { return nil }
func (*reserveCountingGate) Health(context.Context) error          { return nil }

type recordingGate struct{ releases int }

func (g *recordingGate) Reserve(context.Context, string) (Reservation, error) {
	return Reservation{Reserved: true}, nil
}
func (g *recordingGate) Release(context.Context, string) error { g.releases++; return nil }
func (g *recordingGate) Health(context.Context) error          { return nil }

type retryGate struct {
	releases int
	failOnce bool
}

func (g *retryGate) Reserve(context.Context, string) (Reservation, error) {
	return Reservation{Reserved: true}, nil
}
func (g *retryGate) Release(context.Context, string) error {
	g.releases++
	if g.failOnce {
		g.failOnce = false
		return errors.New("injected reservation release failure")
	}
	return nil
}
func (g *retryGate) Health(context.Context) error { return nil }

type gateStep struct {
	reservation Reservation
	err         error
}

type scriptedGate struct {
	steps           []gateStep
	reserveIDs      []string
	releaseIDs      []string
	releaseErr      error
	releaseHasBound bool
	onReserve       func(int)
	onRelease       func(int)
}

func (g *scriptedGate) Reserve(_ context.Context, id string) (Reservation, error) {
	g.reserveIDs = append(g.reserveIDs, id)
	call := len(g.reserveIDs)
	if g.onReserve != nil {
		g.onReserve(call)
	}
	if len(g.steps) == 0 {
		return Reservation{Reserved: true}, nil
	}
	step := g.steps[0]
	g.steps = g.steps[1:]
	return step.reservation, step.err
}

func (g *scriptedGate) Release(ctx context.Context, id string) error {
	g.releaseIDs = append(g.releaseIDs, id)
	if _, ok := ctx.Deadline(); ok {
		g.releaseHasBound = true
	}
	if g.onRelease != nil {
		g.onRelease(len(g.releaseIDs))
	}
	return g.releaseErr
}

func (*scriptedGate) Health(context.Context) error { return nil }

type recordingSelfUpdate struct {
	marked, activated   int
	failActivateOnce    bool
	pendingCommitChecks int
}

func (s *recordingSelfUpdate) Prepare(context.Context, release.Manifest) error { return nil }
func (s *recordingSelfUpdate) MarkPlatformCommitted(release.Manifest) error {
	s.marked++
	return nil
}
func (s *recordingSelfUpdate) Activate(context.Context, release.Manifest) error {
	s.activated++
	if s.failActivateOnce {
		s.failActivateOnce = false
		return errors.New("injected manager activation failure")
	}
	return nil
}
func (s *recordingSelfUpdate) ActivationCommitted(release.Manifest) (bool, error) {
	if s.pendingCommitChecks > 0 {
		s.pendingCommitChecks--
		return false, nil
	}
	return true, nil
}

type retryLegacy struct {
	commits   int
	failOnce  bool
	committed bool
}

func (*retryLegacy) Active() bool                             { return false }
func (*retryLegacy) PreCutover(context.Context, string) error { return nil }
func (*retryLegacy) Cutover(context.Context, string) error    { return nil }
func (*retryLegacy) Rollback(context.Context, string) error   { return nil }
func (l *retryLegacy) FinalizeCleanup(context.Context, string) error {
	if l.committed {
		return nil
	}
	l.commits++
	if l.failOnce {
		l.failOnce = false
		return errors.New("injected legacy cleanup failure")
	}
	l.committed = true
	return nil
}

type preflightLegacy struct {
	preflightErr error
	preflights   int
	cutovers     int
	rollbacks    int
}

func (*preflightLegacy) Active() bool { return true }
func (l *preflightLegacy) PreCutover(context.Context, string) error {
	l.preflights++
	return l.preflightErr
}
func (l *preflightLegacy) Cutover(context.Context, string) error { l.cutovers++; return nil }
func (l *preflightLegacy) Rollback(context.Context, string) error {
	l.rollbacks++
	return nil
}
func (*preflightLegacy) FinalizeCleanup(context.Context, string) error {
	return nil
}

func testReleaseServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	compose := []byte("services: {}\n")
	composeSum := sha256.Sum256(compose)
	managerSum := sha256.Sum256([]byte("manager"))
	generatedAt := time.Now()
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/compose" {
			_, _ = w.Write(compose)
			return
		}
		images := map[string]string{}
		for _, name := range []string{"platform", "agent-runtime", "camofox", "agent-sandbox", "searxng", "firecrawl-api", "firecrawl-playwright", "firecrawl-postgres", "firecrawl-redis", "firecrawl-rabbitmq", "firecrawl-foundationdb"} {
			images[name] = "registry/" + name + "@sha256:" + strings.Repeat("a", 64)
		}
		manifest := release.Manifest{SchemaVersion: 1, Channel: "main", SourceCommit: strings.Repeat("b", 40), GeneratedAt: generatedAt, ProtocolVersion: 1, DatabaseSchemaVersion: 2, Manager: release.ManagerRelease{Version: "v1", Artifacts: map[string]release.Artifact{runtime.GOARCH: {URL: server.URL + "/manager", SHA256: hex.EncodeToString(managerSum[:])}}}, Compose: release.Artifact{URL: server.URL + "/compose", SHA256: hex.EncodeToString(composeSum[:])}, Images: images}
		_ = json.NewEncoder(w).Encode(manifest)
	}))
	return server, server.URL + "/manifest"
}

func TestInstallWaitsWhenManagerExistsBeforeManifestPublication(t *testing.T) {
	server, url := testReleaseServer(t)
	defer server.Close()
	base := server.Client()
	transport := &temporaryManifestTransport{base: base.Transport}
	store, _ := journal.Open(t.TempDir(), time.Now())
	orchestrator := &Orchestrator{
		Store: store, Engine: &fakeEngine{}, Gate: fakeGate{}, Snapshots: fakeSnapshot{},
		ReleasesDir: t.TempDir(), ManifestURL: url, Channel: "main",
		ReleaseClient: release.Client{HTTP: &http.Client{Transport: transport}},
		PollInterval:  time.Millisecond,
		Sleep:         func(context.Context, time.Duration) error { return nil },
	}
	op, _, err := orchestrator.Start(model.OperationRequest{Kind: model.OperationInstall, IdempotencyKey: "manifest-publication-race", ExpectedGeneration: store.State().Generation})
	if err != nil {
		t.Fatal(err)
	}
	completed, err := orchestrator.Await(context.Background(), op.ID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != model.OperationSucceeded || !completed.Finalized || transport.attempts < 2 {
		t.Fatalf("temporary manifest absence was not retried: operation=%#v requests=%d", completed, transport.attempts)
	}
}

func TestRetryableImagePullFailureStartsNewIdempotentAttempt(t *testing.T) {
	server, url := testReleaseServer(t)
	defer server.Close()
	store, _ := journal.Open(t.TempDir(), time.Now())
	engine := &fakeEngine{failAt: "pull"}
	orchestrator := &Orchestrator{Store: store, Engine: engine, Gate: fakeGate{}, Snapshots: fakeSnapshot{}, ReleasesDir: t.TempDir(), ManifestURL: url, Channel: "main", ReleaseClient: release.Client{HTTP: server.Client()}}
	request := model.OperationRequest{Kind: model.OperationInstall, IdempotencyKey: "retry-image-pull", ExpectedGeneration: store.State().Generation}
	first, _, err := orchestrator.Start(request)
	if err != nil {
		t.Fatal(err)
	}
	failed, err := orchestrator.Await(context.Background(), first.ID)
	if err != nil {
		t.Fatal(err)
	}
	if failed.Status != model.OperationFailed || !failed.Retryable || failed.Attempt != 1 {
		t.Fatalf("image availability failure was not queued for retry: %#v", failed)
	}
	engine.failAt = ""
	request.ExpectedGeneration = store.State().Generation
	second, reused, err := orchestrator.Start(request)
	if err != nil || reused || second.ID == first.ID || second.Attempt != 2 {
		t.Fatalf("timer retry did not start a new attempt: operation=%#v reused=%v err=%v", second, reused, err)
	}
	completed, err := orchestrator.Await(context.Background(), second.ID)
	if err != nil || completed.Status != model.OperationSucceeded {
		t.Fatalf("second attempt did not complete: operation=%#v err=%v", completed, err)
	}
}

func TestCheckPublishesReleaseArtifactsImmutably(t *testing.T) {
	server, url := testReleaseServer(t)
	defer server.Close()
	store, err := journal.Open(t.TempDir(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	releases := t.TempDir()
	orchestrator := &Orchestrator{
		Store:         store,
		ReleasesDir:   releases,
		Channel:       "main",
		ReleaseClient: release.Client{HTTP: server.Client()},
	}
	manifest, err := orchestrator.Check(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(releases, manifest.ID())
	manifestBytes, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	composeBytes, err := os.ReadFile(filepath.Join(dir, "compose.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := orchestrator.Check(context.Background(), url); err != nil {
		t.Fatalf("byte-identical generation was not reusable: %v", err)
	}
	afterManifest, _ := os.ReadFile(filepath.Join(dir, "manifest.json"))
	afterCompose, _ := os.ReadFile(filepath.Join(dir, "compose.yaml"))
	if !bytes.Equal(afterManifest, manifestBytes) || !bytes.Equal(afterCompose, composeBytes) {
		t.Fatal("rechecking a release rewrote its immutable artifacts")
	}

	if err := os.WriteFile(filepath.Join(dir, "compose.yaml"), []byte("tampered\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := orchestrator.Check(context.Background(), url); err == nil || !strings.Contains(err.Error(), "immutable release collision") {
		t.Fatalf("expected immutable-ID collision, got %v", err)
	}
	actual, err := os.ReadFile(filepath.Join(dir, "compose.yaml"))
	if err != nil || string(actual) != "tampered\n" {
		t.Fatalf("collision overwrote the existing artifact: %q, %v", actual, err)
	}
}

func TestCheckDoesNotPublishAPartialReleaseWhenComposeFetchFails(t *testing.T) {
	compose := []byte("services: {}\n")
	composeSum := sha256.Sum256(compose)
	managerSum := sha256.Sum256([]byte("manager"))
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/compose" {
			http.Error(w, "not ready", http.StatusServiceUnavailable)
			return
		}
		images := map[string]string{}
		for _, name := range []string{"platform", "agent-runtime", "camofox", "agent-sandbox", "searxng", "firecrawl-api", "firecrawl-playwright", "firecrawl-postgres", "firecrawl-redis", "firecrawl-rabbitmq", "firecrawl-foundationdb"} {
			images[name] = "registry/" + name + "@sha256:" + strings.Repeat("a", 64)
		}
		manifest := release.Manifest{
			SchemaVersion: 1, Channel: "main", SourceCommit: strings.Repeat("c", 40), GeneratedAt: time.Now(), ProtocolVersion: 1, DatabaseSchemaVersion: 2,
			Manager: release.ManagerRelease{Version: "v1", Artifacts: map[string]release.Artifact{runtime.GOARCH: {URL: server.URL + "/manager", SHA256: hex.EncodeToString(managerSum[:])}}},
			Compose: release.Artifact{URL: server.URL + "/compose", SHA256: hex.EncodeToString(composeSum[:])}, Images: images,
		}
		_ = json.NewEncoder(w).Encode(manifest)
	}))
	defer server.Close()
	store, err := journal.Open(t.TempDir(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	releases := t.TempDir()
	orchestrator := &Orchestrator{Store: store, ReleasesDir: releases, Channel: "main", ReleaseClient: release.Client{HTTP: server.Client()}}
	if _, err := orchestrator.Check(context.Background(), server.URL+"/manifest"); err == nil {
		t.Fatal("expected Compose fetch failure")
	}
	if _, err := os.Lstat(filepath.Join(releases, strings.Repeat("c", 40))); !os.IsNotExist(err) {
		t.Fatalf("failed check left a published or partial generation: %v", err)
	}
	entries, err := os.ReadDir(releases)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("failed check left staging content: %#v", entries)
	}
}

func TestFreshInstallCommitsOnlyAfterProbe(t *testing.T) {
	server, url := testReleaseServer(t)
	defer server.Close()
	store, err := journal.Open(t.TempDir(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	engine := &fakeEngine{}
	orchestrator := &Orchestrator{Store: store, Engine: engine, Gate: fakeGate{}, Snapshots: fakeSnapshot{}, ReleasesDir: t.TempDir(), ManifestURL: url, Channel: "main", ReleaseClient: release.Client{HTTP: server.Client()}}
	op, _, err := orchestrator.Start(model.OperationRequest{Kind: model.OperationInstall, IdempotencyKey: "install", ExpectedGeneration: store.State().Generation})
	if err != nil {
		t.Fatal(err)
	}
	completed, err := orchestrator.Await(context.Background(), op.ID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != model.OperationSucceeded {
		t.Fatalf("operation failed: %#v", completed)
	}
	state := store.State()
	if state.Current == nil || state.Current.ID != strings.Repeat("b", 40) || state.PublicState != model.StateIdle || state.Maintenance {
		t.Fatalf("unexpected committed state: %#v", state)
	}
	engine.mu.Lock()
	calls := strings.Join(engine.calls, ",")
	engine.mu.Unlock()
	if calls != "pull,prepare,stop,migrate,start,probe" {
		t.Fatalf("unexpected engine sequence: %s", calls)
	}
}

func TestReserveWaitsForLocalHostAndSandboxTerminalsBeforePlatformGate(t *testing.T) {
	store, err := journal.Open(t.TempDir(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	op, _, err := store.Begin(model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: "local-terminal-readiness", ExpectedGeneration: store.State().Generation}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	gate := &reserveCountingGate{}
	checks, waits := 0, 0
	orchestrator := &Orchestrator{
		Store: store,
		Gate:  gate,
		LocalUpdateBlockers: func() (running, blocking, terminable int) {
			checks++
			if checks == 1 {
				// One protected host terminal and one terminable Sandbox terminal
				// both delay cutover. The Manager never kills either one.
				return 2, 1, 1
			}
			return 0, 0, 0
		},
		Sleep: func(context.Context, time.Duration) error {
			waits++
			if gate.reservations != 0 {
				t.Fatal("platform reservation was attempted while a local terminal was running")
			}
			state := store.State()
			if state.PublicState != model.StateWaitingForTasks || state.Maintenance || state.RetryAfterSeconds != 5 {
				t.Fatalf("local terminal wait did not remain publicly available: %#v", state)
			}
			return nil
		},
	}
	if err := orchestrator.reserve(context.Background(), op.ID, false); err != nil {
		t.Fatal(err)
	}
	if checks != 3 || waits != 1 || gate.reservations != 2 {
		t.Fatalf("unexpected local readiness sequence: checks=%d waits=%d reservations=%d", checks, waits, gate.reservations)
	}
	if state := store.State(); !state.Maintenance || state.PublicState != model.StateUpdating {
		t.Fatalf("confirmed reservation was not durably closed: %#v", state)
	}
}

func TestReserveRechecksLocalProcessesAfterPlatformAdmissionIsFrozen(t *testing.T) {
	store, err := journal.Open(t.TempDir(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	op, _, err := store.Begin(model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: "post-gate-local-terminal", ExpectedGeneration: store.State().Generation}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	gate := &scriptedGate{}
	checks, waits := 0, 0
	orchestrator := &Orchestrator{
		Store: store,
		Gate:  gate,
		LocalUpdateBlockers: func() (running, blocking, terminable int) {
			checks++
			if checks == 2 {
				return 1, 1, 0
			}
			return 0, 0, 0
		},
		Sleep: func(context.Context, time.Duration) error {
			waits++
			if len(gate.reserveIDs) != 1 || len(gate.releaseIDs) != 1 || store.State().Maintenance {
				t.Fatalf("post-reservation process race was not released before waiting: gate=%#v state=%#v", gate, store.State())
			}
			return nil
		},
	}
	if err := orchestrator.reserve(context.Background(), op.ID, false); err != nil {
		t.Fatal(err)
	}
	if checks != 4 || waits != 1 || len(gate.reserveIDs) != 3 || len(gate.releaseIDs) != 1 {
		t.Fatalf("unexpected two-control-plane reservation sequence: checks=%d waits=%d gate=%#v", checks, waits, gate)
	}
	if state := store.State(); !state.Maintenance || state.PublicState != model.StateUpdating {
		t.Fatalf("replacement reservation was not durably confirmed: %#v", state)
	}
}

func TestUpdateAndLegacyInstallConfirmReservationBeforeCutover(t *testing.T) {
	for _, kind := range []model.OperationKind{model.OperationUpdate, model.OperationInstall} {
		t.Run(string(kind), func(t *testing.T) {
			server, url := testReleaseServer(t)
			defer server.Close()
			store, _ := journal.Open(t.TempDir(), time.Now())
			engine := &fakeEngine{}
			legacy := &preflightLegacy{}
			var observation string
			gate := &scriptedGate{onReserve: func(call int) {
				if call != 2 {
					return
				}
				state := store.State()
				engine.mu.Lock()
				calls := append([]string(nil), engine.calls...)
				engine.mu.Unlock()
				if !state.Maintenance || state.PublicState != model.StateUpdating {
					observation = fmt.Sprintf("second reserve preceded durable maintenance: %#v", state)
				} else if strings.Contains(strings.Join(calls, ","), "stop") {
					observation = fmt.Sprintf("destructive engine work preceded confirmation: %v", calls)
				} else if kind == model.OperationInstall && (legacy.preflights != 0 || legacy.cutovers != 0) {
					observation = fmt.Sprintf("legacy cutover work preceded confirmation: %#v", legacy)
				}
			}}
			orchestrator := &Orchestrator{
				Store: store, Engine: engine, Gate: gate, Snapshots: fakeSnapshot{}, ReleasesDir: t.TempDir(),
				ManifestURL: url, Channel: "main", ReleaseClient: release.Client{HTTP: server.Client()},
			}
			if kind == model.OperationInstall {
				orchestrator.Legacy = legacy
				orchestrator.LegacyGate = gate
			}
			op, _, err := orchestrator.Start(model.OperationRequest{Kind: kind, IdempotencyKey: "two-stage-" + string(kind), ExpectedGeneration: store.State().Generation})
			if err != nil {
				t.Fatal(err)
			}
			completed, err := orchestrator.Await(context.Background(), op.ID)
			if err != nil || completed.Status != model.OperationSucceeded {
				t.Fatalf("operation did not complete: operation=%#v err=%v", completed, err)
			}
			if observation != "" {
				t.Fatal(observation)
			}
			if len(gate.reserveIDs) != 2 || gate.reserveIDs[0] != op.ID || gate.reserveIDs[1] != op.ID {
				t.Fatalf("reservation was not confirmed with the same operation id: %v", gate.reserveIDs)
			}
			if kind == model.OperationInstall && (legacy.preflights != 1 || legacy.cutovers != 1) {
				t.Fatalf("legacy cutover did not run after confirmation: %#v", legacy)
			}
		})
	}
}

func TestRestartAndRollbackConfirmReservationBeforeDestructiveWork(t *testing.T) {
	for _, kind := range []model.OperationKind{model.OperationRestart, model.OperationRollback} {
		t.Run(string(kind), func(t *testing.T) {
			dir := t.TempDir()
			store, _ := journal.Open(filepath.Join(dir, "state"), time.Now())
			aID, bID := strings.Repeat("a", 40), strings.Repeat("b", 40)
			aPath := writeRollbackManifest(t, dir, aID)
			bPath := writeRollbackManifest(t, dir, bID)
			_, _ = store.MutateState(time.Now(), func(state *model.ManagerState) error {
				state.Current = &model.Generation{ID: bID, ManifestPath: bPath, RollbackSnapshotPath: "/snapshots/a"}
				state.Previous = &model.Generation{ID: aID, ManifestPath: aPath}
				return nil
			})
			engine := &fakeEngine{}
			snapshots := &scriptedSnapshot{creates: []string{"/snapshots/rescue"}}
			var observation string
			gate := &scriptedGate{onReserve: func(call int) {
				if call != 2 {
					return
				}
				state := store.State()
				engine.mu.Lock()
				calls := append([]string(nil), engine.calls...)
				engine.mu.Unlock()
				if !state.Maintenance || state.PublicState != model.StateUpdating {
					observation = fmt.Sprintf("second reserve preceded durable maintenance: %#v", state)
				} else if strings.Contains(strings.Join(calls, ","), "stop") || len(snapshots.creates) != 1 || len(snapshots.restores) != 0 {
					observation = fmt.Sprintf("destructive work preceded confirmation: calls=%v snapshots=%#v", calls, snapshots)
				}
			}}
			orchestrator := &Orchestrator{Store: store, Engine: engine, Gate: gate, Snapshots: snapshots, Channel: "main"}
			op, _, err := store.Begin(model.OperationRequest{Kind: kind, IdempotencyKey: "two-stage-" + string(kind), ExpectedGeneration: store.State().Generation}, time.Now())
			if err != nil {
				t.Fatal(err)
			}
			if kind == model.OperationRestart {
				orchestrator.runRestart(context.Background(), op)
			} else {
				orchestrator.runRollback(context.Background(), op)
			}
			completed, err := store.Operation(op.ID)
			if err != nil || completed.Status != model.OperationSucceeded {
				t.Fatalf("operation did not complete: operation=%#v err=%v", completed, err)
			}
			if observation != "" {
				t.Fatal(observation)
			}
			if len(gate.reserveIDs) != 2 || gate.reserveIDs[0] != op.ID || gate.reserveIDs[1] != op.ID {
				t.Fatalf("reservation was not confirmed with the same operation id: %v", gate.reserveIDs)
			}
		})
	}
}

func TestRestartAndRollbackStopWhenMaintenancePersistenceFails(t *testing.T) {
	for _, kind := range []model.OperationKind{model.OperationRestart, model.OperationRollback} {
		t.Run(string(kind), func(t *testing.T) {
			dir := t.TempDir()
			stateDir := filepath.Join(dir, "state")
			statePath := filepath.Join(stateDir, "state.json")
			store, _ := journal.Open(stateDir, time.Now())
			aID, bID := strings.Repeat("a", 40), strings.Repeat("b", 40)
			aPath := writeRollbackManifest(t, dir, aID)
			bPath := writeRollbackManifest(t, dir, bID)
			_, _ = store.MutateState(time.Now(), func(state *model.ManagerState) error {
				state.Current = &model.Generation{ID: bID, ManifestPath: bPath, RollbackSnapshotPath: "/snapshots/a"}
				state.Previous = &model.Generation{ID: aID, ManifestPath: aPath}
				return nil
			})

			var originalState []byte
			var callbackErr error
			restoreState := func() {
				if originalState == nil {
					return
				}
				if err := os.RemoveAll(statePath); err != nil && callbackErr == nil {
					callbackErr = err
					return
				}
				if err := os.WriteFile(statePath, originalState, 0o600); err != nil && callbackErr == nil {
					callbackErr = err
					return
				}
				originalState = nil
			}
			t.Cleanup(restoreState)
			gate := &scriptedGate{
				onReserve: func(call int) {
					if call != 1 {
						return
					}
					originalState, callbackErr = os.ReadFile(statePath)
					if callbackErr != nil {
						return
					}
					if callbackErr = os.Remove(statePath); callbackErr != nil {
						return
					}
					callbackErr = os.Mkdir(statePath, 0o700)
				},
				onRelease: func(int) { restoreState() },
			}
			engine := &fakeEngine{}
			snapshots := &scriptedSnapshot{creates: []string{"/snapshots/rescue"}}
			orchestrator := &Orchestrator{Store: store, Engine: engine, Gate: gate, Snapshots: snapshots, Channel: "main"}
			op, _, err := store.Begin(model.OperationRequest{Kind: kind, IdempotencyKey: "maintenance-fsync-" + string(kind), ExpectedGeneration: store.State().Generation}, time.Now())
			if err != nil {
				t.Fatal(err)
			}
			if kind == model.OperationRestart {
				orchestrator.runRestart(context.Background(), op)
			} else {
				orchestrator.runRollback(context.Background(), op)
			}
			if callbackErr != nil {
				t.Fatal(callbackErr)
			}
			completed, err := store.Operation(op.ID)
			state := store.State()
			if err != nil || completed.Status != model.OperationFailed || state.Maintenance || state.PublicState != model.StateIdle {
				t.Fatalf("maintenance persistence failure did not stop reversibly: state=%#v operation=%#v err=%v", state, completed, err)
			}
			engine.mu.Lock()
			calls := strings.Join(engine.calls, ",")
			engine.mu.Unlock()
			if strings.Contains(calls, "stop") || len(snapshots.creates) != 1 || len(snapshots.restores) != 0 {
				t.Fatalf("persistence failure crossed a destructive boundary: calls=%q snapshots=%#v", calls, snapshots)
			}
			if len(gate.reserveIDs) != 1 || len(gate.releaseIDs) != 1 || gate.releaseIDs[0] != op.ID {
				t.Fatalf("failed maintenance persistence did not release the first reservation: %#v", gate)
			}
		})
	}
}

func TestReservationResponseUncertaintyIsReleasedBeforeFailure(t *testing.T) {
	for _, test := range []struct {
		name  string
		steps []gateStep
	}{
		{name: "first response lost", steps: []gateStep{{err: errors.New("connection reset after request")}}},
		{name: "confirmation response lost", steps: []gateStep{{reservation: Reservation{Reserved: true}}, {err: errors.New("connection reset after confirmation")}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			server, url := testReleaseServer(t)
			defer server.Close()
			store, _ := journal.Open(t.TempDir(), time.Now())
			engine := &fakeEngine{}
			gate := &scriptedGate{steps: append([]gateStep(nil), test.steps...)}
			orchestrator := &Orchestrator{Store: store, Engine: engine, Gate: gate, Snapshots: fakeSnapshot{}, ReleasesDir: t.TempDir(), ManifestURL: url, Channel: "main", ReleaseClient: release.Client{HTTP: server.Client()}}
			op, _, err := store.Begin(model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: test.name, ExpectedGeneration: store.State().Generation}, time.Now())
			if err != nil {
				t.Fatal(err)
			}
			orchestrator.runUpdate(context.Background(), op)
			completed, err := store.Operation(op.ID)
			state := store.State()
			if err != nil || completed.Status != model.OperationFailed || state.Maintenance || state.PublicState != model.StateIdle {
				t.Fatalf("confirmed cleanup did not fail open safely: state=%#v operation=%#v err=%v", state, completed, err)
			}
			if len(gate.releaseIDs) != 1 || gate.releaseIDs[0] != op.ID || !gate.releaseHasBound {
				t.Fatalf("uncertain response did not use a bounded same-id release: %#v", gate)
			}
			engine.mu.Lock()
			calls := strings.Join(engine.calls, ",")
			engine.mu.Unlock()
			if strings.Contains(calls, "stop") {
				t.Fatalf("uncertain reservation reached destructive work: %s", calls)
			}
		})
	}
}

func TestInitialSourceMigrationAuthenticationRejectionIsPermanent(t *testing.T) {
	releaseServer, manifestURL := testReleaseServer(t)
	defer releaseServer.Close()
	var reserveCalls, releaseCalls int
	gateServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/internal/manager/update/readiness":
			reserveCalls++
			http.Error(response, "invalid manager token", http.StatusUnauthorized)
		case "/internal/manager/update/release":
			releaseCalls++
			http.Error(response, "invalid manager token", http.StatusUnauthorized)
		default:
			http.NotFound(response, request)
		}
	}))
	defer gateServer.Close()

	store, err := journal.Open(t.TempDir(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	engine := &fakeEngine{}
	legacy := &preflightLegacy{}
	gate := HTTPGate{BaseURL: gateServer.URL, Token: "wrong-manager-token", Client: gateServer.Client()}
	orchestrator := &Orchestrator{
		Store: store, Engine: engine, Gate: gate, LegacyGate: gate, Legacy: legacy,
		Snapshots: fakeSnapshot{}, ReleasesDir: t.TempDir(), ManifestURL: manifestURL,
		Channel: "main", ReleaseClient: release.Client{HTTP: releaseServer.Client()},
	}
	op, _, err := orchestrator.Start(model.OperationRequest{
		Kind: model.OperationInstall, IdempotencyKey: "source-auth-rejection",
		ExpectedGeneration: store.State().Generation, ExpectedSourceCommit: strings.Repeat("b", 40),
	})
	if err != nil {
		t.Fatal(err)
	}
	completed, err := orchestrator.Await(context.Background(), op.ID)
	if err != nil {
		t.Fatal(err)
	}
	state := store.State()
	if completed.Status != model.OperationFailed || completed.Retryable ||
		state.ActiveOperationID != "" || state.Maintenance || state.PublicState != model.StateIdle {
		t.Fatalf("authentication rejection was not a permanent reversible failure: operation=%#v state=%#v", completed, state)
	}
	if !strings.Contains(completed.Error, "authentication configuration was rejected") ||
		!strings.Contains(completed.Error, "HTTP 401") {
		t.Fatalf("authentication failure was not diagnosed clearly: %q", completed.Error)
	}
	if reserveCalls != 1 || releaseCalls != 0 {
		t.Fatalf("definitive first-reserve rejection used the uncertainty release path: reserve=%d release=%d", reserveCalls, releaseCalls)
	}
	if legacy.preflights != 0 || legacy.cutovers != 0 || legacy.rollbacks != 0 {
		t.Fatalf("authentication failure crossed the source cutover boundary: %#v", legacy)
	}
	engine.mu.Lock()
	calls := strings.Join(engine.calls, ",")
	engine.mu.Unlock()
	if strings.Contains(calls, "stop") || strings.Contains(calls, "migrate") {
		t.Fatalf("authentication failure reached destructive engine work: %s", calls)
	}
}

func TestConfirmationAuthenticationRejectionStillReleasesFailClosed(t *testing.T) {
	releaseServer, manifestURL := testReleaseServer(t)
	defer releaseServer.Close()
	var reserveCalls, releaseCalls int
	gateServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/internal/manager/update/readiness":
			reserveCalls++
			if reserveCalls == 1 {
				_, _ = response.Write([]byte(`{"ready":true,"reserved":true}`))
				return
			}
			http.Error(response, "invalid manager token", http.StatusUnauthorized)
		case "/internal/manager/update/release":
			releaseCalls++
			http.Error(response, "invalid manager token", http.StatusUnauthorized)
		default:
			http.NotFound(response, request)
		}
	}))
	defer gateServer.Close()

	store, err := journal.Open(t.TempDir(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	engine := &fakeEngine{}
	gate := HTTPGate{BaseURL: gateServer.URL, Token: "rotated-manager-token", Client: gateServer.Client()}
	orchestrator := &Orchestrator{
		Store: store, Engine: engine, Gate: gate, Snapshots: fakeSnapshot{},
		ReleasesDir: t.TempDir(), ManifestURL: manifestURL, Channel: "main",
		ReleaseClient: release.Client{HTTP: releaseServer.Client()},
	}
	op, _, err := store.Begin(model.OperationRequest{
		Kind: model.OperationUpdate, IdempotencyKey: "confirmation-auth-rejection",
		ExpectedGeneration: store.State().Generation,
	}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	orchestrator.runUpdate(context.Background(), op)
	pending, err := store.Operation(op.ID)
	if err != nil {
		t.Fatal(err)
	}
	state := store.State()
	if pending.Status != model.OperationRunning ||
		pending.ReservationStatus != model.ReservationReleaseUncertain ||
		state.ActiveOperationID != op.ID || !state.Maintenance || state.PublicState != model.StateFailed {
		t.Fatalf("post-reservation authentication failure did not remain fail-closed: operation=%#v state=%#v", pending, state)
	}
	if reserveCalls != 2 || releaseCalls != 1 {
		t.Fatalf("post-reservation authentication failure skipped same-id release: reserve=%d release=%d", reserveCalls, releaseCalls)
	}
	engine.mu.Lock()
	calls := strings.Join(engine.calls, ",")
	engine.mu.Unlock()
	if strings.Contains(calls, "stop") || strings.Contains(calls, "migrate") {
		t.Fatalf("unconfirmed release reached destructive engine work: %s", calls)
	}
}

func TestHTTPAuthenticationRecoveryReleasesSameReservationAndAllowsNextInstallAttempt(t *testing.T) {
	releaseServer, manifestURL := testReleaseServer(t)
	defer releaseServer.Close()

	const token = "manager-token"
	type gateRequest struct {
		path        string
		operationID string
		authorized  bool
	}
	var gateMu sync.Mutex
	acceptToken := true
	requests := make([]gateRequest, 0, 7)
	gateServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		var body struct {
			OperationID string `json:"operation_id"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			http.Error(response, "invalid request", http.StatusBadRequest)
			return
		}

		gateMu.Lock()
		authorized := acceptToken && request.Header.Get("Authorization") == "Bearer "+token
		requests = append(requests, gateRequest{
			path: request.URL.Path, operationID: body.OperationID, authorized: authorized,
		})
		if authorized && request.URL.Path == "/internal/manager/update/readiness" {
			successfulReserves := 0
			for _, item := range requests {
				if item.path == "/internal/manager/update/readiness" && item.authorized {
					successfulReserves++
				}
			}
			if successfulReserves == 1 {
				// Reproduce the incident: the first reservation reaches Platform,
				// then the long-lived Gateway keeps a stale token for both the
				// confirmation request and the Manager's bounded release attempt.
				acceptToken = false
			}
		}
		gateMu.Unlock()

		if !authorized {
			http.Error(response, "invalid manager token", http.StatusUnauthorized)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/internal/manager/update/readiness":
			_, _ = response.Write([]byte(`{"ready":true,"reserved":true}`))
		case "/internal/manager/update/release":
			_, _ = response.Write([]byte(`{"released":true}`))
		default:
			http.NotFound(response, request)
		}
	}))
	defer gateServer.Close()

	store, err := journal.Open(t.TempDir(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	legacy := &preflightLegacy{}
	gate := HTTPGate{BaseURL: gateServer.URL, Token: token, Client: gateServer.Client()}
	orchestrator := &Orchestrator{
		Store: store, Engine: &fakeEngine{}, Gate: gate, LegacyGate: gate, Legacy: legacy,
		Snapshots: fakeSnapshot{}, ReleasesDir: t.TempDir(), ManifestURL: manifestURL,
		Channel: "main", ReleaseClient: release.Client{HTTP: releaseServer.Client()},
	}
	request := model.OperationRequest{
		Kind: model.OperationInstall, IdempotencyKey: "source-auth-incident-recovery",
		ExpectedGeneration: store.State().Generation, ExpectedSourceCommit: strings.Repeat("b", 40),
	}
	first, reused, err := store.Begin(request, time.Now())
	if err != nil || reused {
		t.Fatalf("begin first install: operation=%#v reused=%v err=%v", first, reused, err)
	}
	orchestrator.runUpdate(context.Background(), first)
	pending, err := store.Operation(first.ID)
	if err != nil {
		t.Fatal(err)
	}
	state := store.State()
	if pending.Status != model.OperationRunning ||
		pending.ReservationStatus != model.ReservationReleaseUncertain ||
		state.ActiveOperationID != first.ID || !state.Maintenance || state.PublicState != model.StateFailed {
		t.Fatalf("HTTP authentication incident was not held fail-closed: operation=%#v state=%#v", pending, state)
	}

	gateMu.Lock()
	acceptToken = true
	incidentRequests := append([]gateRequest(nil), requests...)
	gateMu.Unlock()
	if len(incidentRequests) != 3 ||
		incidentRequests[0].path != "/internal/manager/update/readiness" || !incidentRequests[0].authorized ||
		incidentRequests[1].path != "/internal/manager/update/readiness" || incidentRequests[1].authorized ||
		incidentRequests[2].path != "/internal/manager/update/release" || incidentRequests[2].authorized {
		t.Fatalf("unexpected HTTP incident sequence: %#v", incidentRequests)
	}
	for _, item := range incidentRequests {
		if item.operationID != first.ID {
			t.Fatalf("incident request changed operation id: want=%s request=%#v", first.ID, item)
		}
	}

	if err := orchestrator.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	completed, err := store.Operation(first.ID)
	if err != nil {
		t.Fatal(err)
	}
	state = store.State()
	if completed.Status != model.OperationFailed || state.ActiveOperationID != "" ||
		state.Maintenance || state.PublicState != model.StateIdle {
		t.Fatalf("authenticated same-id release did not converge recovery: operation=%#v state=%#v", completed, state)
	}
	gateMu.Lock()
	recoveredRequests := append([]gateRequest(nil), requests...)
	gateMu.Unlock()
	if len(recoveredRequests) != 4 ||
		recoveredRequests[3].path != "/internal/manager/update/release" ||
		!recoveredRequests[3].authorized || recoveredRequests[3].operationID != first.ID {
		t.Fatalf("recovery did not release the original reservation id: %#v", recoveredRequests)
	}

	request.ExpectedGeneration = state.Generation
	second, reused, err := orchestrator.Start(request)
	if err != nil || reused || second.ID == first.ID || second.Attempt != first.Attempt+1 {
		t.Fatalf("recovered install did not start a new idempotent attempt: first=%#v second=%#v reused=%v err=%v", first, second, reused, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	retried, err := orchestrator.Await(ctx, second.ID)
	if err != nil || retried.Status != model.OperationSucceeded || !retried.Finalized {
		t.Fatalf("recovered install attempt did not complete: operation=%#v err=%v", retried, err)
	}
}

func TestUnconfirmedReservationReleaseStaysClosedUntilRecovery(t *testing.T) {
	server, url := testReleaseServer(t)
	defer server.Close()
	store, _ := journal.Open(t.TempDir(), time.Now())
	engine := &fakeEngine{}
	gate := &scriptedGate{
		steps:      []gateStep{{reservation: Reservation{Reserved: true}}, {err: errors.New("confirmation response lost")}},
		releaseErr: errors.New("release response lost"),
	}
	orchestrator := &Orchestrator{Store: store, Engine: engine, Gate: gate, Snapshots: fakeSnapshot{}, ReleasesDir: t.TempDir(), ManifestURL: url, Channel: "main", ReleaseClient: release.Client{HTTP: server.Client()}}
	op, _, err := store.Begin(model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: "uncertain-release", ExpectedGeneration: store.State().Generation}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	orchestrator.runUpdate(context.Background(), op)
	pending, err := store.Operation(op.ID)
	state := store.State()
	if err != nil || pending.Status != model.OperationRunning || pending.ReservationStatus != model.ReservationReleaseUncertain || state.ActiveOperationID != op.ID || state.PublicState != model.StateFailed || !state.Maintenance {
		t.Fatalf("unconfirmed release was not held closed: state=%#v operation=%#v err=%v", state, pending, err)
	}
	if !orchestrator.RecoveryPending() {
		t.Fatal("in-process recovery loop did not observe the uncertain reservation")
	}
	engine.mu.Lock()
	calls := strings.Join(engine.calls, ",")
	engine.mu.Unlock()
	if strings.Contains(calls, "stop") {
		t.Fatalf("unconfirmed release triggered destructive rollback work: %s", calls)
	}

	gate.releaseErr = nil
	if err := orchestrator.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	completed, _ := store.Operation(op.ID)
	state = store.State()
	if completed.Status != model.OperationFailed || state.ActiveOperationID != "" || state.Maintenance || state.PublicState != model.StateIdle || len(gate.releaseIDs) != 2 {
		t.Fatalf("confirmed recovery release did not reopen safely: state=%#v operation=%#v releases=%v", state, completed, gate.releaseIDs)
	}
}

func TestRecoveredRunIsRemovedFromLiveMapBeforeAnotherRecoveryAttempt(t *testing.T) {
	server, url := testReleaseServer(t)
	defer server.Close()
	store, _ := journal.Open(t.TempDir(), time.Now())
	gate := &scriptedGate{
		steps:      []gateStep{{err: errors.New("reserve response lost")}},
		releaseErr: errors.New("release response lost"),
	}
	orchestrator := &Orchestrator{Store: store, Engine: &fakeEngine{}, Gate: gate, Snapshots: fakeSnapshot{}, ReleasesDir: t.TempDir(), ManifestURL: url, Channel: "main", ReleaseClient: release.Client{HTTP: server.Client()}}
	op, _, err := store.Begin(model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: "recovered-run-cleanup", ExpectedGeneration: store.State().Generation}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if err := orchestrator.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if state := store.State(); state.PublicState == model.StateFailed && state.Maintenance {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	state := store.State()
	if state.PublicState != model.StateFailed || !state.Maintenance {
		t.Fatalf("recovered run did not reach release uncertainty: %#v", state)
	}
	deadline = time.Now().Add(time.Second)
	for time.Now().Before(deadline) && !orchestrator.RecoveryPending() {
		time.Sleep(time.Millisecond)
	}
	if !orchestrator.RecoveryPending() {
		t.Fatal("completed recovery goroutine remained registered as live")
	}

	gate.releaseErr = nil
	if err := orchestrator.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	completed, _ := store.Operation(op.ID)
	state = store.State()
	if completed.Status != model.OperationFailed || state.ActiveOperationID != "" || state.Maintenance {
		t.Fatalf("second in-process recovery did not converge: state=%#v operation=%#v", state, completed)
	}
}

func TestReservationIntentJournalFailureDoesNotInventMaintenance(t *testing.T) {
	server, url := testReleaseServer(t)
	defer server.Close()
	stateDir := t.TempDir()
	operationsDir := filepath.Join(stateDir, "operations")
	store, _ := journal.Open(stateDir, time.Now())
	engine := &fakeEngine{}
	gate := &scriptedGate{
		steps:      []gateStep{{err: errors.New("reserve response lost")}},
		releaseErr: errors.New("release response lost"),
		onRelease: func(call int) {
			if call == 1 {
				_ = os.Chmod(operationsDir, 0o500)
			}
		},
	}
	t.Cleanup(func() { _ = os.Chmod(operationsDir, 0o700) })
	orchestrator := &Orchestrator{Store: store, Engine: engine, Gate: gate, Snapshots: fakeSnapshot{}, ReleasesDir: t.TempDir(), ManifestURL: url, Channel: "main", ReleaseClient: release.Client{HTTP: server.Client()}}
	op, _, err := store.Begin(model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: "uncertain-intent-fsync", ExpectedGeneration: store.State().Generation}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	orchestrator.runUpdate(context.Background(), op)
	state := store.State()
	pending, err := store.Operation(op.ID)
	if err != nil {
		t.Fatal(err)
	}
	if state.Maintenance || state.PublicState != model.StateWaitingForTasks || pending.ReservationStatus != "" || pending.Status != model.OperationRunning {
		t.Fatalf("failed uncertainty journal write invented durable maintenance: state=%#v operation=%#v", state, pending)
	}
	engine.mu.Lock()
	beforeRecovery := strings.Join(engine.calls, ",")
	engine.mu.Unlock()
	if strings.Contains(beforeRecovery, "stop") {
		t.Fatalf("journal failure crossed a destructive boundary: %s", beforeRecovery)
	}
	if !orchestrator.RecoveryPending() {
		t.Fatal("abandoned active operation was not scheduled for in-process recovery")
	}

	if err := os.Chmod(operationsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	gate.releaseErr = nil
	var recoveryObservation string
	gate.onRelease = nil
	gate.onReserve = func(call int) {
		if call != 2 {
			return
		}
		engine.mu.Lock()
		defer engine.mu.Unlock()
		if strings.Contains(strings.Join(engine.calls, ","), "stop") {
			recoveryObservation = "recovery ran destructive work before reacquiring the same reservation"
		}
	}
	if err := orchestrator.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	completed, err := orchestrator.Await(context.Background(), op.ID)
	if err != nil || completed.Status != model.OperationSucceeded {
		t.Fatalf("same-id recovery did not converge: operation=%#v err=%v", completed, err)
	}
	if recoveryObservation != "" {
		t.Fatal(recoveryObservation)
	}
	if len(gate.reserveIDs) != 3 || gate.reserveIDs[0] != op.ID || gate.reserveIDs[1] != op.ID || gate.reserveIDs[2] != op.ID {
		t.Fatalf("recovery did not reuse and confirm the same reservation id: %v", gate.reserveIDs)
	}
}

func TestConfirmedReservationWithoutMutationMarkerRecoversByReleaseOnly(t *testing.T) {
	store, _ := journal.Open(t.TempDir(), time.Now())
	op, _, err := store.Begin(model.OperationRequest{Kind: model.OperationRestart, IdempotencyKey: "confirmed-before-mutation", ExpectedGeneration: store.State().Generation}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.UpdateOperation(op.ID, func(value *model.Operation) error {
		value.Status = model.OperationRunning
		value.Phase = model.PhaseDraining
		value.ReservationStatus = model.ReservationConfirmed
		value.Error = "reservation cleanup response was lost"
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.MutateState(time.Now(), func(state *model.ManagerState) error {
		state.PublicState = model.StateUpdating
		state.Maintenance = true
		state.Phase = model.PhaseDraining
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	engine := &fakeEngine{}
	gate := &scriptedGate{}
	orchestrator := &Orchestrator{Store: store, Engine: engine, Gate: gate, Snapshots: fakeSnapshot{}}
	if !orchestrator.RecoveryPending() {
		t.Fatal("confirmed pre-mutation reservation was not recoverable")
	}
	if err := orchestrator.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	completed, _ := store.Operation(op.ID)
	state := store.State()
	if completed.Status != model.OperationFailed || state.Maintenance || state.PublicState != model.StateIdle || len(gate.releaseIDs) != 1 || gate.releaseIDs[0] != op.ID {
		t.Fatalf("confirmed pre-mutation recovery did not release safely: state=%#v operation=%#v gate=%#v", state, completed, gate)
	}
	engine.mu.Lock()
	calls := strings.Join(engine.calls, ",")
	engine.mu.Unlock()
	if strings.Contains(calls, "stop") {
		t.Fatalf("pre-mutation recovery stopped workloads before confirming release: %s", calls)
	}
}

func TestReservationConflictDoesNotConfirmAbsence(t *testing.T) {
	server, url := testReleaseServer(t)
	defer server.Close()
	store, _ := journal.Open(t.TempDir(), time.Now())
	gate := &scriptedGate{
		steps:      []gateStep{{err: errors.New("dial failed before response")}},
		releaseErr: &HTTPStatusError{StatusCode: http.StatusConflict, Body: "reservation does not match"},
	}
	orchestrator := &Orchestrator{Store: store, Engine: &fakeEngine{}, Gate: gate, Snapshots: fakeSnapshot{}, ReleasesDir: t.TempDir(), ManifestURL: url, Channel: "main", ReleaseClient: release.Client{HTTP: server.Client()}}
	op, _, err := store.Begin(model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: "missing-reservation", ExpectedGeneration: store.State().Generation}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	orchestrator.runUpdate(context.Background(), op)
	completed, _ := store.Operation(op.ID)
	state := store.State()
	if completed.Status != model.OperationRunning || completed.ReservationStatus != model.ReservationReleaseUncertain || !state.Maintenance || state.PublicState != model.StateFailed {
		t.Fatalf("reservation conflict did not remain fail-closed: state=%#v operation=%#v", state, completed)
	}
}

func TestPullFailureNeverEntersMaintenance(t *testing.T) {
	server, url := testReleaseServer(t)
	defer server.Close()
	store, _ := journal.Open(t.TempDir(), time.Now())
	engine := &fakeEngine{failAt: "pull"}
	orchestrator := &Orchestrator{Store: store, Engine: engine, Gate: fakeGate{}, Snapshots: fakeSnapshot{}, ReleasesDir: t.TempDir(), ManifestURL: url, Channel: "main", ReleaseClient: release.Client{HTTP: server.Client()}}
	op, _, _ := orchestrator.Start(model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: "update", ExpectedGeneration: store.State().Generation})
	completed, err := orchestrator.Await(context.Background(), op.ID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != model.OperationFailed {
		t.Fatalf("expected failure: %#v", completed)
	}
	state := store.State()
	if state.Maintenance || state.PublicState != model.StateIdle {
		t.Fatalf("pull failure entered maintenance: %#v", state)
	}
}

func TestSourceMigrationManifestMismatchFailsBeforePullAndMaintenance(t *testing.T) {
	server, url := testReleaseServer(t)
	defer server.Close()
	store, _ := journal.Open(t.TempDir(), time.Now())
	engine := &fakeEngine{}
	orchestrator := &Orchestrator{Store: store, Engine: engine, Gate: fakeGate{}, Snapshots: fakeSnapshot{}, ReleasesDir: t.TempDir(), ManifestURL: url, Channel: "main", ReleaseClient: release.Client{HTTP: server.Client()}}
	expected := strings.Repeat("c", 40)
	op, _, err := orchestrator.Start(model.OperationRequest{Kind: model.OperationInstall, IdempotencyKey: "source-mismatch", ExpectedGeneration: store.State().Generation, ManifestURL: url, ExpectedSourceCommit: expected})
	if err != nil {
		t.Fatal(err)
	}
	completed, err := orchestrator.Await(context.Background(), op.ID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != model.OperationFailed || completed.ExpectedSourceCommit != expected || !strings.Contains(completed.Error, "source migration release mismatch") {
		t.Fatalf("mismatched source release was not durably rejected: %#v", completed)
	}
	state := store.State()
	if state.Maintenance || state.Candidate != nil || state.PublicState != model.StateIdle {
		t.Fatalf("source mismatch entered maintenance or saved a candidate: %#v", state)
	}
	engine.mu.Lock()
	calls := append([]string(nil), engine.calls...)
	engine.mu.Unlock()
	if len(calls) != 0 {
		t.Fatalf("source mismatch reached image or cutover operations: %v", calls)
	}
}

func TestSourceMigrationRechecksPreflightAfterReservationBeforeCutover(t *testing.T) {
	server, url := testReleaseServer(t)
	defer server.Close()
	store, _ := journal.Open(t.TempDir(), time.Now())
	engine := &fakeEngine{}
	gate := &recordingGate{}
	legacy := &preflightLegacy{preflightErr: errors.New("configuration fingerprint changed")}
	orchestrator := &Orchestrator{Store: store, Engine: engine, Gate: gate, LegacyGate: gate, Legacy: legacy, Snapshots: fakeSnapshot{}, ReleasesDir: t.TempDir(), ManifestURL: url, Channel: "main", ReleaseClient: release.Client{HTTP: server.Client()}}
	op, _, err := orchestrator.Start(model.OperationRequest{Kind: model.OperationInstall, IdempotencyKey: "stale-source-preflight", ExpectedGeneration: store.State().Generation, ExpectedSourceCommit: strings.Repeat("b", 40)})
	if err != nil {
		t.Fatal(err)
	}
	completed, err := orchestrator.Await(context.Background(), op.ID)
	if err != nil {
		t.Fatal(err)
	}
	state := store.State()
	if completed.Status != model.OperationFailed || !strings.Contains(completed.Error, "configuration fingerprint changed") || state.Maintenance || state.PublicState != model.StateIdle {
		t.Fatalf("stale preflight did not fail at the reversible boundary: operation=%#v state=%#v", completed, state)
	}
	if legacy.preflights != 1 || legacy.cutovers != 0 || gate.releases != 1 {
		t.Fatalf("unexpected cutover preflight sequence: preflights=%d cutovers=%d releases=%d", legacy.preflights, legacy.cutovers, gate.releases)
	}
	engine.mu.Lock()
	calls := append([]string(nil), engine.calls...)
	engine.mu.Unlock()
	if strings.Contains(strings.Join(calls, ","), "stop") || strings.Contains(strings.Join(calls, ","), "migrate") {
		t.Fatalf("failed cutover preflight reached destructive engine work: %v", calls)
	}
}

func TestSourcePreCutoverFailureWithUnconfirmedReleaseNeverStartsRollback(t *testing.T) {
	server, url := testReleaseServer(t)
	defer server.Close()
	store, _ := journal.Open(t.TempDir(), time.Now())
	engine := &fakeEngine{}
	gate := &scriptedGate{releaseErr: errors.New("release response lost")}
	legacy := &preflightLegacy{preflightErr: errors.New("configuration fingerprint changed")}
	orchestrator := &Orchestrator{Store: store, Engine: engine, Gate: gate, LegacyGate: gate, Legacy: legacy, Snapshots: fakeSnapshot{}, ReleasesDir: t.TempDir(), ManifestURL: url, Channel: "main", ReleaseClient: release.Client{HTTP: server.Client()}}
	op, _, err := store.Begin(model.OperationRequest{Kind: model.OperationInstall, IdempotencyKey: "uncertain-pre-cutover-release", ExpectedGeneration: store.State().Generation, ExpectedSourceCommit: strings.Repeat("b", 40)}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	orchestrator.runUpdate(context.Background(), op)
	pending, err := store.Operation(op.ID)
	state := store.State()
	if err != nil || pending.Status != model.OperationRunning || pending.ReservationStatus != model.ReservationReleaseUncertain || state.PublicState != model.StateFailed || !state.Maintenance {
		t.Fatalf("uncertain pre-cutover release was not held closed: state=%#v operation=%#v err=%v", state, pending, err)
	}
	if legacy.preflights != 1 || legacy.cutovers != 0 || legacy.rollbacks != 0 || len(gate.releaseIDs) != 1 || !gate.releaseHasBound {
		t.Fatalf("pre-cutover failure crossed the mutation boundary: legacy=%#v gate=%#v", legacy, gate)
	}
	engine.mu.Lock()
	calls := strings.Join(engine.calls, ",")
	engine.mu.Unlock()
	if strings.Contains(calls, "stop") {
		t.Fatalf("pre-cutover release uncertainty stopped workloads: %s", calls)
	}
}

func TestRecoveredSourceMigrationRetainsExpectedCommit(t *testing.T) {
	server, url := testReleaseServer(t)
	defer server.Close()
	dir := t.TempDir()
	store, _ := journal.Open(dir, time.Now())
	expected := strings.Repeat("d", 40)
	op, _, err := store.Begin(model.OperationRequest{Kind: model.OperationInstall, IdempotencyKey: "source-recovery", ExpectedGeneration: store.State().Generation, ManifestURL: url, ExpectedSourceCommit: expected}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	reopened, err := journal.Open(dir, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	engine := &fakeEngine{}
	orchestrator := &Orchestrator{Store: reopened, Engine: engine, Gate: fakeGate{}, Snapshots: fakeSnapshot{}, ReleasesDir: t.TempDir(), Channel: "main", ReleaseClient: release.Client{HTTP: server.Client()}}
	if err := orchestrator.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	completed, err := orchestrator.Await(context.Background(), op.ID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != model.OperationFailed || completed.ExpectedSourceCommit != expected {
		t.Fatalf("recovery lost source commit binding: %#v", completed)
	}
	engine.mu.Lock()
	calls := append([]string(nil), engine.calls...)
	engine.mu.Unlock()
	if len(calls) != 0 {
		t.Fatalf("recovered mismatch executed destructive work: %v", calls)
	}
}

func TestPublicGatewayFailurePreventsGenerationCommit(t *testing.T) {
	server, url := testReleaseServer(t)
	defer server.Close()
	store, _ := journal.Open(t.TempDir(), time.Now())
	engine := &fakeEngine{}
	orchestrator := &Orchestrator{Store: store, Engine: engine, Gate: fakeGate{}, Snapshots: fakeSnapshot{}, ReleasesDir: t.TempDir(), ManifestURL: url, Channel: "main", ReleaseClient: release.Client{HTTP: server.Client()}, PublicProbe: func(context.Context) error { return errors.New("bind failed") }}
	op, _, err := orchestrator.Start(model.OperationRequest{Kind: model.OperationInstall, IdempotencyKey: "gateway-failure", ExpectedGeneration: store.State().Generation})
	if err != nil {
		t.Fatal(err)
	}
	completed, err := orchestrator.Await(context.Background(), op.ID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != model.OperationFailed || store.State().Current != nil {
		t.Fatalf("generation committed without public gateway: op=%#v state=%#v", completed, store.State())
	}
	engine.mu.Lock()
	calls := append([]string(nil), engine.calls...)
	engine.mu.Unlock()
	if len(calls) < 2 || calls[len(calls)-1] != "stop" {
		t.Fatalf("failed first-install candidate was not stopped before rollback: %v", calls)
	}
}

func TestCheckClearsCandidateWhenReleaseMatchesCurrentGeneration(t *testing.T) {
	server, url := testReleaseServer(t)
	defer server.Close()
	store, _ := journal.Open(t.TempDir(), time.Now())
	_, _ = store.MutateState(time.Now(), func(state *model.ManagerState) error {
		state.Current = &model.Generation{ID: strings.Repeat("b", 40)}
		state.Candidate = &model.Generation{ID: "stale-target"}
		return nil
	})
	orchestrator := &Orchestrator{Store: store, ReleasesDir: t.TempDir(), ManifestURL: url, Channel: "main", ReleaseClient: release.Client{HTTP: server.Client()}}
	if _, err := orchestrator.Check(context.Background(), url); err != nil {
		t.Fatal(err)
	}
	if candidate := store.State().Candidate; candidate != nil {
		t.Fatalf("same-generation check left a false update target: %#v", candidate)
	}
}

func TestRecoverFinalizesCrashBetweenOperationAndStateCommit(t *testing.T) {
	server, url := testReleaseServer(t)
	defer server.Close()
	store, _ := journal.Open(t.TempDir(), time.Now())
	gate := &recordingGate{}
	selfUpdate := &recordingSelfUpdate{}
	commits := 0
	orchestrator := &Orchestrator{Store: store, Engine: &fakeEngine{}, Gate: gate, Snapshots: fakeSnapshot{}, SelfUpdate: selfUpdate, ReleasesDir: t.TempDir(), ManifestURL: url, Channel: "main", ReleaseClient: release.Client{HTTP: server.Client()}, OnCommit: func(release.Manifest) { commits++ }}
	manifest, err := orchestrator.Check(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	state := store.State()
	op, _, err := store.Begin(model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: "crash-window", ExpectedGeneration: state.Generation}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.UpdateOperation(op.ID, func(value *model.Operation) error {
		value.Status = model.OperationSucceeded
		value.TargetGeneration = manifest.ID()
		value.SnapshotPath = "/backup/before-update"
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := orchestrator.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	state = store.State()
	if state.Current == nil || state.Current.ID != manifest.ID() || state.Current.RollbackSnapshotPath != "/backup/before-update" || state.Candidate != nil || state.ActiveOperationID != "" {
		t.Fatalf("recovery did not finish durable state commit: %#v", state)
	}
	if gate.releases != 1 || selfUpdate.marked != 1 || selfUpdate.activated != 1 || commits != 1 {
		t.Fatalf("recovery skipped finalize hooks: gate=%d self=%#v commits=%d", gate.releases, selfUpdate, commits)
	}
}

func TestRecoverFailedTerminalOperationClearsHalfCommittedActiveState(t *testing.T) {
	store, err := journal.Open(t.TempDir(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	op, _, err := store.Begin(model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: "failed-half-commit", ExpectedGeneration: store.State().Generation}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.UpdateOperation(op.ID, func(value *model.Operation) error {
		value.Status = model.OperationFailed
		value.Phase = model.PhasePulling
		value.Error = "injected pull failure"
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	orchestrator := &Orchestrator{Store: store, Engine: &fakeEngine{}, Gate: fakeGate{}, Snapshots: fakeSnapshot{}}
	if err := orchestrator.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	state := store.State()
	if state.ActiveOperationID != "" || state.Maintenance || state.PublicState != model.StateIdle || state.LastError != "injected pull failure" {
		t.Fatalf("failed half-commit did not converge without re-execution: %#v", state)
	}
	final, err := store.Operation(op.ID)
	if err != nil || final.Status != model.OperationFailed {
		t.Fatalf("failed operation terminal state changed: %#v %v", final, err)
	}
}

func TestRecoverRetriesDurableFinalizePendingAfterStateCommit(t *testing.T) {
	server, url := testReleaseServer(t)
	defer server.Close()
	store, _ := journal.Open(t.TempDir(), time.Now())
	gate := &retryGate{failOnce: true}
	selfUpdate := &recordingSelfUpdate{}
	commits := 0
	orchestrator := &Orchestrator{Store: store, Engine: &fakeEngine{}, Gate: gate, Snapshots: fakeSnapshot{}, SelfUpdate: selfUpdate, ReleasesDir: t.TempDir(), ManifestURL: url, Channel: "main", ReleaseClient: release.Client{HTTP: server.Client()}, OnCommit: func(release.Manifest) { commits++ }}
	manifest, err := orchestrator.Check(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	state := store.State()
	op, _, err := store.Begin(model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: "finalize-after-state", ExpectedGeneration: state.Generation}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.UpdateOperation(op.ID, func(value *model.Operation) error {
		value.Status = model.OperationSucceeded
		value.TargetGeneration = manifest.ID()
		value.SnapshotPath = "/backup/finalize"
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.MutateState(time.Now(), func(value *model.ManagerState) error {
		value.ActiveOperationID = ""
		value.Current = value.Candidate
		value.Current.RollbackSnapshotPath = "/backup/finalize"
		value.Candidate = nil
		value.FinalizePendingOperationID = op.ID
		value.PublicState = model.StateUpdating
		value.Maintenance = true
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := orchestrator.Recover(context.Background()); err == nil {
		t.Fatal("expected injected first finalize failure")
	}
	state = store.State()
	if state.FinalizePendingOperationID != op.ID || !state.Maintenance || state.PublicState != model.StateUpdating {
		t.Fatalf("failed finalize was not kept durable and closed: %#v", state)
	}
	if err := orchestrator.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	state = store.State()
	if state.FinalizePendingOperationID != "" || state.Maintenance || state.PublicState != model.StateIdle {
		t.Fatalf("retried finalize did not open the committed generation: %#v", state)
	}
	if gate.releases != 2 || selfUpdate.activated != 2 || commits != 2 {
		t.Fatalf("unexpected idempotent finalize calls: gate=%d self=%#v commits=%d", gate.releases, selfUpdate, commits)
	}
}

func TestRecoverFinalizeWaitsForGateLegacyCleanupAndSelfUpdate(t *testing.T) {
	server, url := testReleaseServer(t)
	defer server.Close()
	store, _ := journal.Open(t.TempDir(), time.Now())
	gate := &retryGate{failOnce: true}
	legacy := &retryLegacy{failOnce: true}
	selfUpdate := &recordingSelfUpdate{failActivateOnce: true, pendingCommitChecks: 1}
	orchestrator := &Orchestrator{Store: store, Engine: &fakeEngine{}, Gate: gate, Legacy: legacy, Snapshots: fakeSnapshot{}, SelfUpdate: selfUpdate, ReleasesDir: t.TempDir(), ManifestURL: url, Channel: "main", ReleaseClient: release.Client{HTTP: server.Client()}}
	manifest, err := orchestrator.Check(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	op, _, err := store.Begin(model.OperationRequest{Kind: model.OperationInstall, IdempotencyKey: "all-finalize-hooks", ExpectedGeneration: store.State().Generation}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.UpdateOperation(op.ID, func(value *model.Operation) error {
		value.Status = model.OperationSucceeded
		value.TargetGeneration = manifest.ID()
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.MutateState(time.Now(), func(value *model.ManagerState) error {
		value.ActiveOperationID = ""
		value.Current = value.Candidate
		value.Candidate = nil
		value.FinalizePendingOperationID = op.ID
		value.PublicState = model.StateUpdating
		value.Maintenance = true
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	// Each injected hook failure must leave a closed, durable pending state. A
	// later startup retries idempotently from the beginning of the hook chain.
	for attempt := 1; attempt <= 4; attempt++ {
		if err := orchestrator.Recover(context.Background()); err == nil {
			t.Fatalf("attempt %d unexpectedly finalized", attempt)
		}
		state := store.State()
		if state.FinalizePendingOperationID != op.ID || !state.Maintenance {
			t.Fatalf("attempt %d lost durable finalize state: %#v", attempt, state)
		}
		current, readErr := store.Operation(op.ID)
		if readErr != nil || current.Finalized {
			t.Fatalf("attempt %d acknowledged incomplete hooks: %#v %v", attempt, current, readErr)
		}
		switch attempt {
		case 1, 2:
			if legacy.commits != 0 || gate.releases != 0 {
				t.Fatalf("finalize cleanup or reservation release ran before watchdog commit on attempt %d: cleanup=%d release=%d", attempt, legacy.commits, gate.releases)
			}
		case 3:
			if legacy.commits != 1 || legacy.committed || gate.releases != 0 {
				t.Fatalf("failed cleanup released admission on attempt %d: cleanup=%d committed=%v release=%d", attempt, legacy.commits, legacy.committed, gate.releases)
			}
		case 4:
			if legacy.commits != 2 || !legacy.committed || gate.releases != 1 {
				t.Fatalf("reservation was not attempted strictly after durable cleanup: cleanup=%d committed=%v release=%d", legacy.commits, legacy.committed, gate.releases)
			}
		}
	}
	if err := orchestrator.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	state := store.State()
	completed, err := store.Operation(op.ID)
	if err != nil {
		t.Fatal(err)
	}
	if state.FinalizePendingOperationID != "" || state.Maintenance || state.PublicState != model.StateIdle || !completed.Finalized {
		t.Fatalf("finalize protocol did not acknowledge every hook: state=%#v op=%#v", state, completed)
	}
	if gate.releases != 2 || legacy.commits != 2 || !legacy.committed || selfUpdate.marked != 5 || selfUpdate.activated != 5 {
		t.Fatalf("unexpected retry sequence: gate=%d legacy=%d self=%#v", gate.releases, legacy.commits, selfUpdate)
	}
}

func TestSourceCleanupIsDurableBeforeReservationRelease(t *testing.T) {
	server, url := testReleaseServer(t)
	defer server.Close()
	store, _ := journal.Open(t.TempDir(), time.Now())
	gate := &recordingGate{}
	legacy := &retryLegacy{failOnce: true}
	orchestrator := &Orchestrator{Store: store, Engine: &fakeEngine{}, Gate: gate, Legacy: legacy, Snapshots: fakeSnapshot{}, ReleasesDir: t.TempDir(), ManifestURL: url, Channel: "main", ReleaseClient: release.Client{HTTP: server.Client()}}
	manifest, err := orchestrator.Check(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	op, _, err := store.Begin(model.OperationRequest{Kind: model.OperationInstall, IdempotencyKey: "cleanup-before-release", ExpectedGeneration: store.State().Generation}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.UpdateOperation(op.ID, func(value *model.Operation) error {
		value.Status = model.OperationSucceeded
		value.TargetGeneration = manifest.ID()
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.MutateState(time.Now(), func(value *model.ManagerState) error {
		value.ActiveOperationID = ""
		value.Current = value.Candidate
		value.Candidate = nil
		value.FinalizePendingOperationID = op.ID
		value.PublicState = model.StateUpdating
		value.Maintenance = true
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	if err := orchestrator.Recover(context.Background()); err == nil {
		t.Fatal("expected injected cleanup persistence failure")
	}
	pending := store.State()
	if gate.releases != 0 || legacy.committed || pending.FinalizePendingOperationID != op.ID || !pending.Maintenance {
		t.Fatalf("cleanup failure released admission: gate=%d legacy=%#v state=%#v", gate.releases, legacy, pending)
	}
	if err := orchestrator.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	final := store.State()
	completed, err := store.Operation(op.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !legacy.committed || legacy.commits != 2 || gate.releases != 1 || final.FinalizePendingOperationID != "" || final.Maintenance || !completed.Finalized {
		t.Fatalf("cleanup recovery did not release exactly after durable completion: gate=%d legacy=%#v state=%#v operation=%#v", gate.releases, legacy, final, completed)
	}
}

func TestRecoverClearsPendingStateWithoutRepeatingFinalizedHooks(t *testing.T) {
	server, url := testReleaseServer(t)
	defer server.Close()
	store, _ := journal.Open(t.TempDir(), time.Now())
	gate := &recordingGate{}
	selfUpdate := &recordingSelfUpdate{}
	orchestrator := &Orchestrator{Store: store, Engine: &fakeEngine{}, Gate: gate, Snapshots: fakeSnapshot{}, SelfUpdate: selfUpdate, ReleasesDir: t.TempDir(), ManifestURL: url, Channel: "main", ReleaseClient: release.Client{HTTP: server.Client()}}
	manifest, err := orchestrator.Check(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	op, _, err := store.Begin(model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: "finalized-before-state", ExpectedGeneration: store.State().Generation}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.UpdateOperation(op.ID, func(value *model.Operation) error {
		value.Status = model.OperationSucceeded
		value.TargetGeneration = manifest.ID()
		value.Finalized = true
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.MutateState(time.Now(), func(value *model.ManagerState) error {
		value.ActiveOperationID = ""
		value.Current = value.Candidate
		value.Candidate = nil
		value.FinalizePendingOperationID = op.ID
		value.PublicState = model.StateUpdating
		value.Maintenance = true
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := orchestrator.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	if state := store.State(); state.FinalizePendingOperationID != "" || state.Maintenance {
		t.Fatalf("finalized/state split did not converge: %#v", state)
	}
	if gate.releases != 0 || selfUpdate.marked != 0 || selfUpdate.activated != 0 {
		t.Fatalf("already finalized hooks were repeated: gate=%d self=%#v", gate.releases, selfUpdate)
	}
}

func writeRollbackManifest(t *testing.T, dir, commit string) string {
	t.Helper()
	images := map[string]string{}
	for _, name := range []string{"platform", "agent-runtime", "camofox", "agent-sandbox", "searxng", "firecrawl-api", "firecrawl-playwright", "firecrawl-postgres", "firecrawl-redis", "firecrawl-rabbitmq", "firecrawl-foundationdb"} {
		images[name] = "registry/" + name + "@sha256:" + strings.Repeat("a", 64)
	}
	manifest := release.Manifest{
		SchemaVersion: 1, Channel: "main", SourceCommit: commit, GeneratedAt: time.Now(), ProtocolVersion: 1, DatabaseSchemaVersion: 2,
		Manager: release.ManagerRelease{Version: "v1", Artifacts: map[string]release.Artifact{runtime.GOARCH: {URL: "http://127.0.0.1/manager", SHA256: strings.Repeat("b", 64)}}},
		Compose: release.Artifact{URL: "http://127.0.0.1/compose", SHA256: strings.Repeat("c", 64)}, Images: images,
	}
	path := filepath.Join(dir, commit+".json")
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestConsecutiveRollbacksBindSnapshotToNewCurrentGeneration(t *testing.T) {
	dir := t.TempDir()
	store, _ := journal.Open(filepath.Join(dir, "state"), time.Now())
	aID, bID := strings.Repeat("a", 40), strings.Repeat("b", 40)
	aPath := writeRollbackManifest(t, dir, aID)
	bPath := writeRollbackManifest(t, dir, bID)
	_, _ = store.MutateState(time.Now(), func(state *model.ManagerState) error {
		state.Current = &model.Generation{ID: bID, ManifestPath: bPath, RollbackSnapshotPath: "/snapshots/a"}
		state.Previous = &model.Generation{ID: aID, ManifestPath: aPath}
		return nil
	})
	snapshots := &scriptedSnapshot{creates: []string{"/snapshots/b", "/snapshots/a-second"}}
	orchestrator := &Orchestrator{Store: store, Engine: &fakeEngine{}, Gate: fakeGate{}, Snapshots: snapshots, Channel: "main"}

	first, _, err := store.Begin(model.OperationRequest{Kind: model.OperationRollback, IdempotencyKey: "rollback-to-a", ExpectedGeneration: store.State().Generation}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	orchestrator.runRollback(context.Background(), first)
	state := store.State()
	if state.Current == nil || state.Current.ID != aID || state.Current.RollbackSnapshotPath != "/snapshots/b" || state.Previous == nil || state.Previous.ID != bID {
		t.Fatalf("first rollback bound the snapshot to the wrong generation: %#v", state)
	}

	second, _, err := store.Begin(model.OperationRequest{Kind: model.OperationRollback, IdempotencyKey: "rollback-back-to-b", ExpectedGeneration: state.Generation}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	orchestrator.runRollback(context.Background(), second)
	state = store.State()
	if state.Current == nil || state.Current.ID != bID || state.Current.RollbackSnapshotPath != "/snapshots/a-second" || state.Previous == nil || state.Previous.ID != aID {
		t.Fatalf("second rollback did not restore the matching data generation: %#v", state)
	}
	wantRestores := []string{"/snapshots/a", "/snapshots/b"}
	if strings.Join(snapshots.restores, ",") != strings.Join(wantRestores, ",") {
		t.Fatalf("unexpected restore sequence: got %v want %v", snapshots.restores, wantRestores)
	}
}

func TestRollbackFailureRemainsDurablyActiveUntilRecoverySucceeds(t *testing.T) {
	dir := t.TempDir()
	store, _ := journal.Open(filepath.Join(dir, "state"), time.Now())
	aID, bID := strings.Repeat("a", 40), strings.Repeat("b", 40)
	aPath := writeRollbackManifest(t, dir, aID)
	bPath := writeRollbackManifest(t, dir, bID)
	_, _ = store.MutateState(time.Now(), func(state *model.ManagerState) error {
		state.Current = &model.Generation{ID: bID, ManifestPath: bPath, RollbackSnapshotPath: "/snapshots/a"}
		state.Previous = &model.Generation{ID: aID, ManifestPath: aPath}
		return nil
	})
	snapshots := &scriptedSnapshot{creates: []string{"/snapshots/b"}, failRestores: 2}
	orchestrator := &Orchestrator{Store: store, Engine: &fakeEngine{}, Gate: fakeGate{}, Snapshots: snapshots, Channel: "main"}
	op, _, err := store.Begin(model.OperationRequest{Kind: model.OperationRollback, IdempotencyKey: "durable-rollback", ExpectedGeneration: store.State().Generation}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	orchestrator.runRollback(context.Background(), op)
	failedState := store.State()
	pending, _ := store.Operation(op.ID)
	if failedState.ActiveOperationID != op.ID || failedState.PublicState != model.StateFailed || !failedState.Maintenance || failedState.Phase != model.PhaseRollingBack || pending.Status != model.OperationRunning || pending.Phase != model.PhaseRollingBack {
		t.Fatalf("failed rollback was not kept durable: state=%#v operation=%#v", failedState, pending)
	}
	if _, _, err := orchestrator.Start(model.OperationRequest{Kind: model.OperationRepair, IdempotencyKey: "unsafe-repair", ExpectedGeneration: failedState.Generation}); !errors.Is(err, journal.ErrOperationInProgress) {
		t.Fatalf("repair bypassed pending rollback: %v", err)
	}
	if err := orchestrator.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	recovered := store.State()
	completed, _ := store.Operation(op.ID)
	if recovered.ActiveOperationID != "" || recovered.Maintenance || recovered.PublicState != model.StateIdle || recovered.Current == nil || recovered.Current.ID != bID || completed.Status != model.OperationFailed {
		t.Fatalf("rollback retry did not safely restore the starting generation: state=%#v operation=%#v", recovered, completed)
	}
}

func TestRecoverFinalizeRequiresFreshCoreReadiness(t *testing.T) {
	server, url := testReleaseServer(t)
	defer server.Close()
	store, _ := journal.Open(t.TempDir(), time.Now())
	engine := &fakeEngine{failAt: "probe"}
	gate := &recordingGate{}
	orchestrator := &Orchestrator{Store: store, Engine: engine, Gate: gate, Snapshots: fakeSnapshot{}, ReleasesDir: t.TempDir(), ManifestURL: url, Channel: "main", ReleaseClient: release.Client{HTTP: server.Client()}}
	manifest, err := orchestrator.Check(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	op, _, err := store.Begin(model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: "probe-before-finalize", ExpectedGeneration: store.State().Generation}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	_, _ = store.UpdateOperation(op.ID, func(value *model.Operation) error {
		value.Status = model.OperationSucceeded
		value.TargetGeneration = manifest.ID()
		return nil
	})
	_, _ = store.MutateState(time.Now(), func(value *model.ManagerState) error {
		value.ActiveOperationID = ""
		value.Current = value.Candidate
		value.Candidate = nil
		value.FinalizePendingOperationID = op.ID
		value.PublicState = model.StateUpdating
		value.Maintenance = true
		return nil
	})
	if err := orchestrator.Recover(context.Background()); err == nil || !strings.Contains(err.Error(), "core readiness") {
		t.Fatalf("expected fresh readiness failure, got %v", err)
	}
	state := store.State()
	if state.FinalizePendingOperationID != op.ID || !state.Maintenance || gate.releases != 0 {
		t.Fatalf("unhealthy generation was finalized: state=%#v releases=%d", state, gate.releases)
	}
}

func TestActivationPreflightCommitsJournalStateWithoutRunningFinalizeHooks(t *testing.T) {
	server, url := testReleaseServer(t)
	defer server.Close()
	store, _ := journal.Open(t.TempDir(), time.Now())
	engine := &fakeEngine{}
	gate := &recordingGate{}
	selfUpdate := &recordingSelfUpdate{}
	commits := 0
	orchestrator := &Orchestrator{
		Store: store, Engine: engine, Gate: gate, Snapshots: fakeSnapshot{}, SelfUpdate: selfUpdate,
		ReleasesDir: t.TempDir(), ManifestURL: url, Channel: "main", ReleaseClient: release.Client{HTTP: server.Client()},
		OnCommit: func(release.Manifest) { commits++ },
	}
	manifest, err := orchestrator.Check(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	op, _, err := store.Begin(model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: "activation-preflight", ExpectedGeneration: store.State().Generation}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.UpdateOperation(op.ID, func(value *model.Operation) error {
		value.Status = model.OperationSucceeded
		value.TargetGeneration = manifest.ID()
		value.SnapshotPath = "/snapshots/before-update"
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	if err := orchestrator.RecoverBeforeActivation(context.Background()); err != nil {
		t.Fatal(err)
	}
	state := store.State()
	if state.Current == nil || state.Current.ID != manifest.ID() || state.FinalizePendingOperationID != op.ID || !state.Maintenance || state.ActiveOperationID != "" {
		t.Fatalf("activation preflight did not converge the independent journal commit: %#v", state)
	}
	if gate.releases != 0 || selfUpdate.marked != 0 || selfUpdate.activated != 0 || commits != 0 {
		t.Fatalf("activation preflight ran post-watchdog hooks: gate=%d self=%#v commits=%d", gate.releases, selfUpdate, commits)
	}

	if err := orchestrator.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	state = store.State()
	completed, err := store.Operation(op.ID)
	if err != nil {
		t.Fatal(err)
	}
	if state.FinalizePendingOperationID != "" || state.Maintenance || state.PublicState != model.StateIdle || !completed.Finalized {
		t.Fatalf("post-watchdog recovery did not finalize: state=%#v operation=%#v", state, completed)
	}
	if gate.releases != 1 || selfUpdate.marked != 1 || selfUpdate.activated != 1 || commits != 1 {
		t.Fatalf("post-watchdog hooks were not run exactly once: gate=%d self=%#v commits=%d", gate.releases, selfUpdate, commits)
	}
}

func TestRollbackDoesNotRestoreWhenRescueSnapshotCannotBeJournaled(t *testing.T) {
	dir := t.TempDir()
	stateDir := filepath.Join(dir, "state")
	store, _ := journal.Open(stateDir, time.Now())
	aID, bID := strings.Repeat("a", 40), strings.Repeat("b", 40)
	aPath := writeRollbackManifest(t, dir, aID)
	bPath := writeRollbackManifest(t, dir, bID)
	_, _ = store.MutateState(time.Now(), func(state *model.ManagerState) error {
		state.Current = &model.Generation{ID: bID, ManifestPath: bPath, RollbackSnapshotPath: "/snapshots/a"}
		state.Previous = &model.Generation{ID: aID, ManifestPath: aPath}
		return nil
	})
	op, _, err := store.Begin(model.OperationRequest{Kind: model.OperationRollback, IdempotencyKey: "journal-before-restore", ExpectedGeneration: store.State().Generation}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	operationsDir := filepath.Join(stateDir, "operations")
	snapshots := &readOnlyJournalSnapshot{operationsDir: operationsDir}
	t.Cleanup(func() { _ = os.Chmod(operationsDir, 0o700) })
	engine := &fakeEngine{}
	orchestrator := &Orchestrator{Store: store, Engine: engine, Gate: fakeGate{}, Snapshots: snapshots, Channel: "main"}
	orchestrator.runRollback(context.Background(), op)
	if len(snapshots.restores) != 0 {
		t.Fatalf("rollback restored data without a durable rescue snapshot journal: %v", snapshots.restores)
	}
	state := store.State()
	if state.PublicState != model.StateFailed || !state.Maintenance || !strings.Contains(state.LastError, "persist rollback rescue snapshot") {
		t.Fatalf("snapshot journal failure did not halt behind maintenance: %#v", state)
	}
	engine.mu.Lock()
	calls := append([]string(nil), engine.calls...)
	engine.mu.Unlock()
	if strings.Contains(strings.Join(calls, ","), "start") {
		t.Fatalf("snapshot journal failure restarted a writer: %v", calls)
	}
}

func TestOperationalMutationsKeepMaintenanceUntilGateReleaseIsDurable(t *testing.T) {
	for _, kind := range []model.OperationKind{model.OperationRestart, model.OperationRollback, model.OperationRepair} {
		t.Run(string(kind), func(t *testing.T) {
			dir := t.TempDir()
			store, _ := journal.Open(filepath.Join(dir, "state"), time.Now())
			aID, bID := strings.Repeat("a", 40), strings.Repeat("b", 40)
			aPath := writeRollbackManifest(t, dir, aID)
			bPath := writeRollbackManifest(t, dir, bID)
			_, _ = store.MutateState(time.Now(), func(state *model.ManagerState) error {
				state.Current = &model.Generation{ID: bID, ManifestPath: bPath, RollbackSnapshotPath: "/snapshots/a"}
				state.Previous = &model.Generation{ID: aID, ManifestPath: aPath}
				if kind == model.OperationRepair {
					state.PublicState = model.StateFailed
					state.Maintenance = true
					state.LastError = "repair requested"
				}
				return nil
			})
			op, _, err := store.Begin(model.OperationRequest{Kind: kind, IdempotencyKey: "durable-" + string(kind), ExpectedGeneration: store.State().Generation}, time.Now())
			if err != nil {
				t.Fatal(err)
			}
			gate := &retryGate{failOnce: true}
			snapshots := &scriptedSnapshot{creates: []string{"/snapshots/rescue"}}
			orchestrator := &Orchestrator{Store: store, Engine: &fakeEngine{}, Gate: gate, Snapshots: snapshots, Channel: "main"}
			switch kind {
			case model.OperationRestart:
				orchestrator.runRestart(context.Background(), op)
			case model.OperationRollback:
				orchestrator.runRollback(context.Background(), op)
			case model.OperationRepair:
				orchestrator.runRepair(context.Background(), op)
			}

			pendingState := store.State()
			pending, err := store.Operation(op.ID)
			if err != nil {
				t.Fatal(err)
			}
			if pending.Status != model.OperationSucceeded || pending.Finalized || pendingState.FinalizePendingOperationID != op.ID || !pendingState.Maintenance || pendingState.PublicState != model.StateUpdating {
				t.Fatalf("failed gate release opened %s early: state=%#v operation=%#v", kind, pendingState, pending)
			}
			if gate.releases != 1 {
				t.Fatalf("expected one failed release, got %d", gate.releases)
			}

			if err := orchestrator.Recover(context.Background()); err != nil {
				t.Fatal(err)
			}
			finalState := store.State()
			completed, err := store.Operation(op.ID)
			if err != nil {
				t.Fatal(err)
			}
			if finalState.FinalizePendingOperationID != "" || finalState.Maintenance || finalState.PublicState != model.StateIdle || !completed.Finalized {
				t.Fatalf("recovered gate release did not finalize %s: state=%#v operation=%#v", kind, finalState, completed)
			}
			if gate.releases != 2 {
				t.Fatalf("release retry count for %s = %d", kind, gate.releases)
			}
		})
	}
}
