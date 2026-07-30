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
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/contract"
	"github.com/ubitech/agent-platform/manager/internal/driver"
	"github.com/ubitech/agent-platform/manager/internal/journal"
	"github.com/ubitech/agent-platform/manager/internal/model"
	"github.com/ubitech/agent-platform/manager/internal/release"
)

type fakeEngine struct {
	mu              sync.Mutex
	calls           []string
	started         []string
	failAt          string
	diagnostic      string
	diagnosticCalls int
}

type observedLocker struct {
	mu        sync.Mutex
	attempted chan struct{}
	once      sync.Once
}

func newObservedHeldLocker() *observedLocker {
	locker := &observedLocker{attempted: make(chan struct{})}
	locker.mu.Lock()
	return locker
}

func (l *observedLocker) Lock() {
	l.once.Do(func() { close(l.attempted) })
	l.mu.Lock()
}

func (l *observedLocker) Unlock() { l.mu.Unlock() }

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
func (e *fakeEngine) Preflight(context.Context) error                 { return e.add("preflight") }
func (e *fakeEngine) Pull(context.Context, release.Manifest) error    { return e.add("pull") }
func (e *fakeEngine) Prepare(context.Context, release.Manifest) error { return e.add("prepare") }
func (e *fakeEngine) StopFixed(context.Context) error                 { return e.add("stop") }
func (e *fakeEngine) StartFixed(_ context.Context, manifest release.Manifest) error {
	e.mu.Lock()
	e.started = append(e.started, manifest.ID())
	e.mu.Unlock()
	return e.add("start")
}
func (e *fakeEngine) Migrate(context.Context, release.Manifest) error   { return e.add("migrate") }
func (e *fakeEngine) Probe(context.Context, release.Manifest) error     { return e.add("probe") }
func (e *fakeEngine) Logs(context.Context, string, int) (string, error) { return "", nil }
func (e *fakeEngine) CandidateFailureDiagnostics(context.Context, release.Manifest) string {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.diagnosticCalls++
	if e.diagnostic != "" {
		e.calls = append(e.calls, "diagnostic")
	}
	return e.diagnostic
}
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

type scriptedCapacityChecker struct {
	errors []error
	calls  int
}

func (c *scriptedCapacityChecker) CheckCapacity(context.Context, string, release.Manifest) error {
	index := c.calls
	c.calls++
	if index < len(c.errors) {
		return c.errors[index]
	}
	return nil
}

type capacityEngine struct {
	*fakeEngine
	capacity *scriptedCapacityChecker
}

func (e *capacityEngine) CheckCapacity(ctx context.Context, stage string, manifest release.Manifest) error {
	return e.capacity.CheckCapacity(ctx, stage, manifest)
}

type capacityPullEngine struct {
	*fakeEngine
	errors []error
	calls  int
}

func (e *capacityPullEngine) Pull(context.Context, release.Manifest) error {
	index := e.calls
	e.calls++
	if index < len(e.errors) {
		return e.errors[index]
	}
	return nil
}

func TestCapacityShortfallRunsOneControlledMaintenanceThenRechecks(t *testing.T) {
	checker := &scriptedCapacityChecker{errors: []error{
		&driver.CapacityError{Stage: driver.CapacityPreDownload, Path: "/var/lib/docker", Resource: "space", Have: 1, Require: 2},
		nil,
	}}
	reclaims := 0
	manifest := release.Manifest{SourceCommit: strings.Repeat("a", 40)}
	orchestrator := &Orchestrator{ReclaimCapacity: func(_ context.Context, operationID string, protected release.Manifest) error {
		reclaims++
		if operationID != "op_capacity" || protected.ID() != manifest.ID() {
			t.Fatalf("capacity reclaim identity = %q/%q", operationID, protected.ID())
		}
		return nil
	}}
	if err := orchestrator.checkCapacity(context.Background(), checker, "op_capacity", driver.CapacityPreDownload, manifest); err != nil {
		t.Fatal(err)
	}
	if checker.calls != 2 || reclaims != 1 {
		t.Fatalf("capacity checks/reclaims = %d/%d, want 2/1", checker.calls, reclaims)
	}
}

func TestNonCapacityFailureDoesNotRunMaintenance(t *testing.T) {
	checker := &scriptedCapacityChecker{errors: []error{errors.New("Docker unavailable")}}
	reclaims := 0
	orchestrator := &Orchestrator{ReclaimCapacity: func(context.Context, string, release.Manifest) error {
		reclaims++
		return nil
	}}
	err := orchestrator.checkCapacity(context.Background(), checker, "op_error", driver.CapacityPreDownload, release.Manifest{})
	if err == nil || err.Error() != "Docker unavailable" || checker.calls != 1 || reclaims != 0 {
		t.Fatalf("non-capacity failure = %v, checks=%d reclaims=%d", err, checker.calls, reclaims)
	}
}

func TestAtomicImagePullCapacityShortfallRunsOneControlledMaintenanceRetry(t *testing.T) {
	capacityErr := &driver.CapacityError{Stage: driver.CapacityPreDownload, Path: "/var/lib/docker", Resource: "space", Have: 1, Require: 2}
	engine := &capacityPullEngine{fakeEngine: &fakeEngine{}, errors: []error{capacityErr, nil}}
	reclaims := 0
	manifest := release.Manifest{SourceCommit: strings.Repeat("a", 40)}
	orchestrator := &Orchestrator{Engine: engine, ReclaimCapacity: func(_ context.Context, operationID string, protected release.Manifest) error {
		reclaims++
		if operationID != "op_pull" || protected.ID() != manifest.ID() {
			t.Fatalf("pull reclaim identity = %q/%q", operationID, protected.ID())
		}
		return nil
	}}
	if err := orchestrator.pullWithCapacityRetry(context.Background(), "op_pull", manifest); err != nil {
		t.Fatal(err)
	}
	if engine.calls != 2 || reclaims != 1 {
		t.Fatalf("pull calls/reclaims = %d/%d, want 2/1", engine.calls, reclaims)
	}
}

func TestCapacityGrowthAfterInitialCheckReleasesReservationBeforeRetryableFailure(t *testing.T) {
	server, manifestURL := testReleaseServer(t)
	defer server.Close()
	store, err := journal.Open(t.TempDir(), time.Unix(10, 0))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.MutateState(time.Unix(11, 0), func(state *model.ManagerState) error {
		state.Current = &model.Generation{ID: strings.Repeat("a", 40)}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	op, _, err := store.Begin(model.OperationRequest{
		Kind: model.OperationUpdate, IdempotencyKey: "capacity-growth", ExpectedGeneration: store.State().Generation,
	}, time.Unix(12, 0))
	if err != nil {
		t.Fatal(err)
	}
	checker := &scriptedCapacityChecker{errors: []error{
		nil,
		nil,
		&driver.CapacityError{Stage: driver.CapacityPreCutover, Path: "/data", Resource: "space", Have: 4, Require: 8},
	}}
	engine := &capacityEngine{fakeEngine: &fakeEngine{}, capacity: checker}
	gate := &scriptedGate{
		onReserve: func(int) {
			if checker.calls != 2 {
				t.Fatalf("reservation began after %d capacity checks, want initial pre-download and pre-cutover", checker.calls)
			}
		},
		onRelease: func(int) {
			if checker.calls != 3 {
				t.Fatalf("reservation release began before the post-reservation capacity recheck: %d checks", checker.calls)
			}
		},
	}
	orchestrator := &Orchestrator{
		Store: store, Engine: engine, Gate: gate, Snapshots: fakeSnapshot{},
		ReleasesDir: t.TempDir(), ManifestURL: manifestURL, Channel: "main",
		ReleaseClient: release.Client{HTTP: server.Client()}, Now: func() time.Time { return time.Unix(13, 0) },
	}
	orchestrator.runUpdate(context.Background(), op)
	if checker.calls != 3 {
		t.Fatalf("capacity checks = %d, want pre-download plus two pre-cutover checks", checker.calls)
	}
	if len(gate.releaseIDs) != 1 || gate.releaseIDs[0] != op.ID {
		t.Fatalf("reservation releases = %#v, want the active operation once", gate.releaseIDs)
	}
	finished, err := store.Operation(op.ID)
	if err != nil {
		t.Fatal(err)
	}
	if finished.Status != model.OperationFailed || !finished.Finalized || !finished.Retryable {
		t.Fatalf("capacity operation did not finish retryably: %#v", finished)
	}
	finalState := store.State()
	if finalState.Maintenance || finalState.PublicState != model.StateIdle || finalState.ActiveOperationID != "" {
		t.Fatalf("capacity failure left current generation unavailable: %#v", finalState)
	}
	engine.mu.Lock()
	calls := strings.Join(engine.calls, ",")
	engine.mu.Unlock()
	if strings.Contains(calls, "stop") || strings.Contains(calls, "migrate") {
		t.Fatalf("post-reservation capacity shortfall crossed destructive boundary: %s", calls)
	}
}

func TestCapacityRecheckKeepsMaintenanceWhenReservationReleaseIsUncertain(t *testing.T) {
	store, err := journal.Open(t.TempDir(), time.Unix(20, 0))
	if err != nil {
		t.Fatal(err)
	}
	op, _, err := store.Begin(model.OperationRequest{
		Kind: model.OperationUpdate, IdempotencyKey: "capacity-release-uncertain", ExpectedGeneration: store.State().Generation,
	}, time.Unix(21, 0))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SetPhase(op.ID, model.PhaseDraining, model.StateUpdating, true, "reserved", time.Unix(22, 0)); err != nil {
		t.Fatal(err)
	}
	gate := &retryGate{failOnce: true}
	orchestrator := &Orchestrator{Store: store, Gate: gate, Now: func() time.Time { return time.Unix(23, 0) }}
	orchestrator.failReservedCapacityRecheck(op, &driver.CapacityError{
		Stage: driver.CapacityPreCutover, Path: "/data", Resource: "space", Have: 4, Require: 8,
	})
	state := store.State()
	if !state.Maintenance || state.PublicState != model.StateFailed || state.ActiveOperationID != op.ID {
		t.Fatalf("uncertain reservation release reopened the platform: %#v", state)
	}
	current, err := store.Operation(op.ID)
	if err != nil {
		t.Fatal(err)
	}
	if current.Status != model.OperationRunning || current.Finalized || current.ReservationStatus != model.ReservationReleaseUncertain {
		t.Fatalf("uncertain capacity release lost recovery intent: %#v", current)
	}
}

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
	activationErr       error
	commitChecks        int
	rolledBack          bool
	rollbackChecks      int
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
	s.commitChecks++
	if s.activationErr != nil {
		return false, s.activationErr
	}
	if s.pendingCommitChecks > 0 {
		s.pendingCommitChecks--
		return false, nil
	}
	return true, nil
}
func (s *recordingSelfUpdate) ActivationRolledBack(release.Manifest) (bool, error) {
	s.rollbackChecks++
	return s.rolledBack, nil
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
		for _, name := range []string{"platform", "agent-runtime", "camofox", "agent-sandbox", "searxng", "firecrawl-api", "firecrawl-playwright", "firecrawl-postgres", "firecrawl-redis", "firecrawl-rabbitmq"} {
			images[name] = "registry/" + name + "@sha256:" + strings.Repeat("a", 64)
		}
		manifest := release.Manifest{SchemaVersion: contract.SchemaVersion, Channel: contract.ReleaseChannel, SourceCommit: strings.Repeat("b", 40), GeneratedAt: generatedAt, ProtocolVersion: contract.SchemaVersion, DatabaseSchemaVersion: 2, Manager: release.ManagerRelease{Version: "v1", Artifacts: map[string]release.Artifact{runtime.GOARCH: {URL: server.URL + "/manager", SHA256: hex.EncodeToString(managerSum[:])}}}, Compose: release.Artifact{URL: server.URL + "/compose", SHA256: hex.EncodeToString(composeSum[:])}, Images: images}
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

func TestUpdatePreparesAndReservesBeforeTakingFixedStackMutex(t *testing.T) {
	server, url := testReleaseServer(t)
	defer server.Close()
	store, err := journal.Open(t.TempDir(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.MutateState(time.Now(), func(state *model.ManagerState) error {
		state.Current = &model.Generation{ID: strings.Repeat("a", 40)}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	engine := &fakeEngine{}
	gate := &reserveCountingGate{}
	fixedStackMu := newObservedHeldLocker()
	locked := true
	defer func() {
		if locked {
			fixedStackMu.mu.Unlock()
		}
	}()
	orchestrator := &Orchestrator{
		Store: store, Engine: engine, Gate: gate, Snapshots: fakeSnapshot{},
		ReleasesDir: t.TempDir(), ManifestURL: url, Channel: "main",
		ReleaseClient: release.Client{HTTP: server.Client()}, FixedStackMu: fixedStackMu,
	}
	op, _, err := orchestrator.Start(model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: "fixed-stack-lock", ExpectedGeneration: store.State().Generation})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-fixedStackMu.attempted:
	case <-time.After(time.Second):
		t.Fatal("operation did not attempt to acquire the fixed-stack mutex")
	}
	engine.mu.Lock()
	callsWhileLocked := append([]string(nil), engine.calls...)
	engine.mu.Unlock()
	if !reflect.DeepEqual(callsWhileLocked, []string{"pull", "prepare"}) {
		t.Fatalf("pre-maintenance work under an unavailable fixed-stack mutex = %v, want pull and prepare", callsWhileLocked)
	}
	if gate.reservations != 2 || !store.State().Maintenance {
		t.Fatalf("fixed-stack lock was attempted before durable reservation: reservations=%d state=%#v", gate.reservations, store.State())
	}
	if strings.Contains(strings.Join(callsWhileLocked, ","), "stop") {
		t.Fatalf("update crossed the destructive boundary before taking the fixed-stack mutex: %v", callsWhileLocked)
	}
	fixedStackMu.mu.Unlock()
	locked = false
	completed, err := orchestrator.Await(context.Background(), op.ID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != model.OperationSucceeded {
		t.Fatalf("operation did not resume after fixed-stack mutex release: %#v", completed)
	}
}

func TestRestartWaitsForTasksBeforeTakingFixedStackMutex(t *testing.T) {
	dir := t.TempDir()
	store, err := journal.Open(filepath.Join(dir, "state"), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	currentID := strings.Repeat("a", 40)
	currentPath := writeRollbackManifest(t, dir, currentID)
	if _, err := store.MutateState(time.Now(), func(state *model.ManagerState) error {
		state.Current = &model.Generation{ID: currentID, ManifestPath: currentPath}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	waiting := make(chan struct{})
	continueReservation := make(chan struct{})
	var waitingOnce sync.Once
	gate := &scriptedGate{steps: []gateStep{
		{reservation: Reservation{Reserved: false, RetryAfterSeconds: 1}},
		{reservation: Reservation{Reserved: true}},
		{reservation: Reservation{Reserved: true}},
	}}
	engine := &fakeEngine{}
	locker := &observedLocker{attempted: make(chan struct{})}
	orchestrator := &Orchestrator{
		Store: store, Engine: engine, Gate: gate, Snapshots: fakeSnapshot{},
		FixedStackMu: locker, Channel: "main",
		Sleep: func(ctx context.Context, _ time.Duration) error {
			waitingOnce.Do(func() { close(waiting) })
			select {
			case <-continueReservation:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		},
	}
	op, _, err := orchestrator.Start(model.OperationRequest{
		Kind: model.OperationRestart, IdempotencyKey: "restart-lock-handoff",
		ExpectedGeneration: store.State().Generation,
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-waiting:
	case <-time.After(time.Second):
		t.Fatal("restart did not enter the task-waiting phase")
	}

	// Acquire the same mutex through its underlying test lock, representing a
	// current-generation capability reconciler. This must remain possible until
	// the admission reservation has durably entered maintenance.
	reconcilerHeldLock := locker.mu.TryLock()
	close(continueReservation)
	if reconcilerHeldLock {
		select {
		case <-locker.attempted:
		case <-time.After(time.Second):
			locker.mu.Unlock()
			t.Fatal("restart did not request the fixed-stack lock after reservation")
		}
		state := store.State()
		engine.mu.Lock()
		callsWhileReconcilerHeldLock := append([]string(nil), engine.calls...)
		engine.mu.Unlock()
		if !state.Maintenance || state.PublicState != model.StateUpdating {
			locker.mu.Unlock()
			t.Fatalf("restart requested the fixed-stack lock before durable maintenance: %#v", state)
		}
		if len(callsWhileReconcilerHeldLock) != 0 {
			locker.mu.Unlock()
			t.Fatalf("restart mutated the fixed stack before the reconciler yielded: %v", callsWhileReconcilerHeldLock)
		}
		locker.mu.Unlock()
	}

	awaitCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	completed, awaitErr := orchestrator.Await(awaitCtx, op.ID)
	if awaitErr != nil || completed.Status != model.OperationSucceeded {
		t.Fatalf("restart did not complete after fixed-stack handoff: operation=%#v err=%v", completed, awaitErr)
	}
	if !reconcilerHeldLock {
		t.Fatal("restart held the fixed-stack mutex while it was still waiting for tasks")
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
		for _, name := range []string{"platform", "agent-runtime", "camofox", "agent-sandbox", "searxng", "firecrawl-api", "firecrawl-playwright", "firecrawl-postgres", "firecrawl-redis", "firecrawl-rabbitmq"} {
			images[name] = "registry/" + name + "@sha256:" + strings.Repeat("a", 64)
		}
		manifest := release.Manifest{
			SchemaVersion: contract.SchemaVersion, Channel: contract.ReleaseChannel, SourceCommit: strings.Repeat("c", 40), GeneratedAt: time.Now(), ProtocolVersion: contract.SchemaVersion, DatabaseSchemaVersion: 2,
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
	if calls != "pull,prepare,stop,migrate,start,probe,probe" {
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
		LocalActiveProcesses: func() int {
			checks++
			if checks == 1 {
				// Both the host and Sandbox terminals delay cutover. The Manager
				// never kills either one to make an update proceed.
				return 2
			}
			return 0
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
	if err := orchestrator.reserve(context.Background(), op.ID); err != nil {
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
		LocalActiveProcesses: func() int {
			checks++
			if checks == 2 {
				return 1
			}
			return 0
		},
		Sleep: func(context.Context, time.Duration) error {
			waits++
			if len(gate.reserveIDs) != 1 || len(gate.releaseIDs) != 1 || store.State().Maintenance {
				t.Fatalf("post-reservation process race was not released before waiting: gate=%#v state=%#v", gate, store.State())
			}
			return nil
		},
	}
	if err := orchestrator.reserve(context.Background(), op.ID); err != nil {
		t.Fatal(err)
	}
	if checks != 4 || waits != 1 || len(gate.reserveIDs) != 3 || len(gate.releaseIDs) != 1 {
		t.Fatalf("unexpected two-control-plane reservation sequence: checks=%d waits=%d gate=%#v", checks, waits, gate)
	}
	if state := store.State(); !state.Maintenance || state.PublicState != model.StateUpdating {
		t.Fatalf("replacement reservation was not durably confirmed: %#v", state)
	}
}

func TestUpdateConfirmsReservationBeforeCutover(t *testing.T) {
	for _, kind := range []model.OperationKind{model.OperationUpdate} {
		t.Run(string(kind), func(t *testing.T) {
			server, url := testReleaseServer(t)
			defer server.Close()
			store, _ := journal.Open(t.TempDir(), time.Now())
			engine := &fakeEngine{}
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
				}
			}}
			orchestrator := &Orchestrator{
				Store: store, Engine: engine, Gate: gate, Snapshots: fakeSnapshot{}, ReleasesDir: t.TempDir(),
				ManifestURL: url, Channel: "main", ReleaseClient: release.Client{HTTP: server.Client()},
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

func TestUpdateReservationAuthenticationRejectionIsPermanent(t *testing.T) {
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
	gate := HTTPGate{BaseURL: gateServer.URL, Token: "wrong-manager-token", Client: gateServer.Client()}
	orchestrator := &Orchestrator{
		Store: store, Engine: engine, Gate: gate,
		Snapshots: fakeSnapshot{}, ReleasesDir: t.TempDir(), ManifestURL: manifestURL,
		Channel: "main", ReleaseClient: release.Client{HTTP: releaseServer.Client()},
	}
	op, _, err := orchestrator.Start(model.OperationRequest{
		Kind: model.OperationUpdate, IdempotencyKey: "update-auth-rejection",
		ExpectedGeneration: store.State().Generation,
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

func TestHTTPAuthenticationRecoveryReleasesSameReservationAndAllowsNextAttempt(t *testing.T) {
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
	gate := HTTPGate{BaseURL: gateServer.URL, Token: token, Client: gateServer.Client()}
	orchestrator := &Orchestrator{
		Store: store, Engine: &fakeEngine{}, Gate: gate,
		Snapshots: fakeSnapshot{}, ReleasesDir: t.TempDir(), ManifestURL: manifestURL,
		Channel: "main", ReleaseClient: release.Client{HTTP: releaseServer.Client()},
	}
	request := model.OperationRequest{
		Kind: model.OperationUpdate, IdempotencyKey: "auth-incident-recovery",
		ExpectedGeneration: store.State().Generation,
	}
	first, reused, err := store.Begin(request, time.Now())
	if err != nil || reused {
		t.Fatalf("begin first operation: operation=%#v reused=%v err=%v", first, reused, err)
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
		t.Fatalf("recovered operation did not start a new idempotent attempt: first=%#v second=%#v reused=%v err=%v", first, second, reused, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	retried, err := orchestrator.Await(ctx, second.ID)
	if err != nil || retried.Status != model.OperationSucceeded || !retried.Finalized {
		t.Fatalf("recovered operation attempt did not complete: operation=%#v err=%v", retried, err)
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

func TestRepeatedReservationRecoveryReplacesLatestErrorWithoutGrowth(t *testing.T) {
	store, err := journal.Open(t.TempDir(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	gate := &scriptedGate{releaseErr: errors.New("release-000")}
	orchestrator := &Orchestrator{Store: store, Gate: gate}
	op, _, err := store.Begin(model.OperationRequest{
		Kind:               model.OperationUpdate,
		IdempotencyKey:     "bounded-reservation-recovery",
		ExpectedGeneration: store.State().Generation,
	}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	const rootCause = "confirm reservation release: original token rejection"
	if err := orchestrator.holdUnconfirmedReservation(op, errors.New(rootCause)); err != nil {
		t.Fatal(err)
	}

	wantLength := 0
	for attempt := 0; attempt < 12; attempt++ {
		gate.releaseErr = fmt.Errorf("release-%03d", attempt)
		current, err := store.Operation(op.ID)
		if err != nil {
			t.Fatal(err)
		}
		if err := orchestrator.recoverUnconfirmedReservation(context.Background(), current); err != nil {
			t.Fatal(err)
		}
		current, err = store.Operation(op.ID)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(current.Error, rootCause+reservationRetrySeparator) ||
			!strings.HasSuffix(current.Error, fmt.Sprintf("retry reservation release: release-%03d", attempt)) ||
			strings.Count(current.Error, reservationRetrySeparator) != 1 ||
			strings.Count(current.Error, "retry reservation release:") != 1 {
			t.Fatalf("retry %d recursively amplified or lost its root: %q", attempt, current.Error)
		}
		if attempt == 0 {
			wantLength = len(current.Error)
		} else if len(current.Error) != wantLength {
			t.Fatalf("retry diagnostic grew from %d to %d bytes", wantLength, len(current.Error))
		}
		state := store.State()
		if state.LastError != current.Error || !state.Maintenance || state.ActiveOperationID != op.ID {
			t.Fatalf("retry %d lost fail-closed state: state=%#v operation=%#v", attempt, state, current)
		}
	}

	gate.releaseErr = nil
	current, _ := store.Operation(op.ID)
	if err := orchestrator.recoverUnconfirmedReservation(context.Background(), current); err != nil {
		t.Fatal(err)
	}
	completed, _ := store.Operation(op.ID)
	state := store.State()
	if completed.Status != model.OperationFailed || !completed.Finalized || completed.Error != state.LastError ||
		state.ActiveOperationID != "" || state.Maintenance || state.PublicState != model.StateIdle {
		t.Fatalf("confirmed release did not converge bounded failure: state=%#v operation=%#v", state, completed)
	}
}

func TestReservationRecoveryBoundsTheOriginalDiagnosticOnce(t *testing.T) {
	original := strings.Repeat("reservation response was lost\n", 100000)
	latest := "retry reservation release: current connection failure"
	bounded := reservationRetryDiagnostic(original, latest)
	if len(bounded) > journal.MaxDiagnosticBytes {
		t.Fatalf("bounded retry diagnostic has %d bytes", len(bounded))
	}
	if !strings.Contains(bounded, fmt.Sprintf("original_bytes=%d", len(original))) ||
		!strings.Contains(bounded, "sha256=") ||
		!strings.HasSuffix(bounded, latest) ||
		strings.Count(bounded, reservationRetrySeparator) != 1 {
		t.Fatalf("first recovery did not preserve traceable root and latest retry: %q", bounded)
	}
	replaced := reservationRetryDiagnostic(bounded, "retry reservation release: next connection failure")
	if strings.Count(replaced, reservationRetrySeparator) != 1 ||
		!strings.Contains(replaced, fmt.Sprintf("original_bytes=%d", len(original))) ||
		!strings.HasSuffix(replaced, "retry reservation release: next connection failure") {
		t.Fatalf("subsequent recovery damaged the original truncation marker: %q", replaced)
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

func TestCandidateDiagnosticsArePersistedBeforeFailedContainerRemoval(t *testing.T) {
	server, url := testReleaseServer(t)
	defer server.Close()
	store, _ := journal.Open(t.TempDir(), time.Now())
	engine := &fakeEngine{failAt: "probe", diagnostic: "health=unhealthy\nprobe output: database unavailable"}
	orchestrator := &Orchestrator{
		Store: store, Engine: engine, Gate: fakeGate{}, Snapshots: fakeSnapshot{},
		ReleasesDir: t.TempDir(), ManifestURL: url, Channel: "main",
		ReleaseClient: release.Client{HTTP: server.Client()},
	}
	op, _, err := orchestrator.Start(model.OperationRequest{
		Kind: model.OperationInstall, IdempotencyKey: "candidate-diagnostics",
		ExpectedGeneration: store.State().Generation,
	})
	if err != nil {
		t.Fatal(err)
	}
	completed, err := orchestrator.Await(context.Background(), op.ID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != model.OperationFailed ||
		!strings.Contains(completed.Error, "injected probe failure") ||
		!strings.Contains(completed.Error, "candidate failure diagnostics") ||
		!strings.Contains(completed.Error, "database unavailable") {
		t.Fatalf("candidate diagnostic was not retained in the operation: %#v", completed)
	}
	engine.mu.Lock()
	diagnosticCalls := engine.diagnosticCalls
	calls := append([]string(nil), engine.calls...)
	engine.mu.Unlock()
	if diagnosticCalls != 1 {
		t.Fatalf("candidate diagnostics were collected %d times", diagnosticCalls)
	}
	probeIndex, diagnosticIndex := -1, -1
	for index, call := range calls {
		if call == "probe" && probeIndex < 0 {
			probeIndex = index
		}
		if call == "diagnostic" && diagnosticIndex < 0 {
			diagnosticIndex = index
		}
	}
	if probeIndex < 0 || diagnosticIndex <= probeIndex || diagnosticIndex >= len(calls)-1 || calls[len(calls)-1] != "stop" {
		t.Fatalf("candidate was not removed after diagnostics: %v", calls)
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
	finalized := 0
	orchestrator := &Orchestrator{Store: store, Engine: &fakeEngine{}, Gate: gate, Snapshots: fakeSnapshot{}, SelfUpdate: selfUpdate, ReleasesDir: t.TempDir(), ManifestURL: url, Channel: "main", ReleaseClient: release.Client{HTTP: server.Client()}, OnCommit: func(release.Manifest) { commits++ }, OnFinalized: func(release.Manifest) { finalized++ }}
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
	if gate.releases != 1 || selfUpdate.marked != 1 || selfUpdate.activated != 1 || commits != 1 || finalized != 1 {
		t.Fatalf("recovery skipped finalize hooks: gate=%d self=%#v commits=%d finalized=%d", gate.releases, selfUpdate, commits, finalized)
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

func TestRejectedManagerCandidateRestoresPreviousCommittedGeneration(t *testing.T) {
	dir := t.TempDir()
	store, err := journal.Open(filepath.Join(dir, "state"), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	previousID, rejectedID := strings.Repeat("a", 40), strings.Repeat("b", 40)
	previousPath := writeRollbackManifest(t, dir, previousID)
	rejectedPath := writeRollbackManifest(t, dir, rejectedID)
	_, err = store.MutateState(time.Now(), func(state *model.ManagerState) error {
		state.Current = &model.Generation{ID: previousID, ManifestPath: previousPath}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	op, _, err := store.Begin(model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: "manager-watchdog-rollback", ExpectedGeneration: store.State().Generation}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.UpdateOperation(op.ID, func(value *model.Operation) error {
		value.Status = model.OperationSucceeded
		value.TargetGeneration = rejectedID
		value.SnapshotPath = "/snapshots/before-rejected-manager"
		value.ReservationStatus = model.ReservationMutationStarted
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.MutateState(time.Now(), func(state *model.ManagerState) error {
		state.ActiveOperationID = ""
		state.Previous = state.Current
		state.Current = &model.Generation{ID: rejectedID, ManifestPath: rejectedPath, RollbackSnapshotPath: "/snapshots/before-rejected-manager"}
		state.FinalizePendingOperationID = op.ID
		state.PublicState = model.StateUpdating
		state.Maintenance = true
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	engine := &fakeEngine{}
	snapshots := &scriptedSnapshot{}
	gate := &recordingGate{}
	selfUpdate := &recordingSelfUpdate{rolledBack: true}
	orchestrator := &Orchestrator{Store: store, Engine: engine, Gate: gate, Snapshots: snapshots, SelfUpdate: selfUpdate, Channel: contract.ReleaseChannel}

	if err := orchestrator.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	state := store.State()
	completed, err := store.Operation(op.ID)
	if err != nil {
		t.Fatal(err)
	}
	if state.Current == nil || state.Current.ID != previousID || state.Previous != nil || state.ActiveOperationID != "" ||
		state.FinalizePendingOperationID != "" || state.Maintenance || state.PublicState != model.StateIdle {
		t.Fatalf("Manager watchdog rollback did not restore the previous Platform generation: %#v", state)
	}
	if completed.Status != model.OperationFailed || !completed.Finalized || !completed.Retryable ||
		!completed.ManagerActivationRollback || completed.ManagerRollbackGeneration != previousID ||
		!completed.SnapshotRestored || !completed.ReservationReleased {
		t.Fatalf("original update did not become a terminal retryable failure: %#v", completed)
	}
	if strings.Join(snapshots.restores, ",") != "/snapshots/before-rejected-manager" || gate.releases != 1 ||
		selfUpdate.marked != 0 || selfUpdate.activated != 0 || selfUpdate.rollbackChecks != 1 {
		t.Fatalf("rollback side effects are incomplete: restores=%v gate=%d self=%#v", snapshots.restores, gate.releases, selfUpdate)
	}
	engine.mu.Lock()
	started := append([]string(nil), engine.started...)
	engine.mu.Unlock()
	if !reflect.DeepEqual(started, []string{previousID}) {
		t.Fatalf("rollback started generations %v, want only %s", started, previousID)
	}
	if err := orchestrator.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(snapshots.restores) != 1 || gate.releases != 1 {
		t.Fatalf("terminal rollback replay repeated external effects: restores=%v releases=%d", snapshots.restores, gate.releases)
	}
}

func TestRecoverManagerRollbackIntentPersistedBeforeStateTransition(t *testing.T) {
	dir := t.TempDir()
	store, err := journal.Open(filepath.Join(dir, "state"), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	previousID, rejectedID := strings.Repeat("c", 40), strings.Repeat("d", 40)
	previousPath := writeRollbackManifest(t, dir, previousID)
	rejectedPath := writeRollbackManifest(t, dir, rejectedID)
	_, _ = store.MutateState(time.Now(), func(state *model.ManagerState) error {
		state.Current = &model.Generation{ID: previousID, ManifestPath: previousPath}
		return nil
	})
	op, _, err := store.Begin(model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: "manager-watchdog-crash", ExpectedGeneration: store.State().Generation}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.UpdateOperation(op.ID, func(value *model.Operation) error {
		value.Status = model.OperationRunning
		value.Finalized = false
		value.Retryable = true
		value.TargetGeneration = rejectedID
		value.SnapshotPath = "/snapshots/crash-before-state"
		value.ReservationStatus = model.ReservationMutationStarted
		value.ManagerActivationRollback = true
		value.ManagerRollbackGeneration = previousID
		value.Phase = model.PhaseRollingBack
		value.Error = "Manager candidate was rejected"
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.MutateState(time.Now(), func(state *model.ManagerState) error {
		state.ActiveOperationID = ""
		state.Previous = state.Current
		state.Current = &model.Generation{ID: rejectedID, ManifestPath: rejectedPath}
		state.FinalizePendingOperationID = op.ID
		state.PublicState = model.StateUpdating
		state.Maintenance = true
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	snapshots := &scriptedSnapshot{}
	gate := &recordingGate{}
	orchestrator := &Orchestrator{Store: store, Engine: &fakeEngine{}, Gate: gate, Snapshots: snapshots, Channel: contract.ReleaseChannel}
	if err := orchestrator.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	state := store.State()
	completed, err := store.Operation(op.ID)
	if err != nil {
		t.Fatal(err)
	}
	if state.Current == nil || state.Current.ID != previousID || state.FinalizePendingOperationID != "" || state.ActiveOperationID != "" || state.Maintenance ||
		completed.Status != model.OperationFailed || !completed.Finalized || !completed.Retryable || !completed.SnapshotRestored || !completed.ReservationReleased {
		t.Fatalf("crash-replayed Manager rollback did not converge: state=%#v operation=%#v", state, completed)
	}
	if !reflect.DeepEqual(snapshots.restores, []string{"/snapshots/crash-before-state"}) || gate.releases != 1 {
		t.Fatalf("crash replay effects = restores %v, releases %d", snapshots.restores, gate.releases)
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
	for _, name := range []string{"platform", "agent-runtime", "camofox", "agent-sandbox", "searxng", "firecrawl-api", "firecrawl-playwright", "firecrawl-postgres", "firecrawl-redis", "firecrawl-rabbitmq"} {
		images[name] = "registry/" + name + "@sha256:" + strings.Repeat("a", 64)
	}
	manifest := release.Manifest{
		SchemaVersion: contract.SchemaVersion, Channel: contract.ReleaseChannel, SourceCommit: commit, GeneratedAt: time.Now(), ProtocolVersion: contract.SchemaVersion, DatabaseSchemaVersion: 2,
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

func TestRollbackImagePreparationFailureKeepsCurrentOnlineAndRetryable(t *testing.T) {
	dir := t.TempDir()
	store, _ := journal.Open(filepath.Join(dir, "state"), time.Now())
	previousID, currentID := strings.Repeat("a", 40), strings.Repeat("b", 40)
	previousPath := writeRollbackManifest(t, dir, previousID)
	currentPath := writeRollbackManifest(t, dir, currentID)
	_, _ = store.MutateState(time.Now(), func(state *model.ManagerState) error {
		state.Current = &model.Generation{ID: currentID, ManifestPath: currentPath, RollbackSnapshotPath: "/snapshots/previous"}
		state.Previous = &model.Generation{ID: previousID, ManifestPath: previousPath}
		return nil
	})
	engine := &fakeEngine{failAt: "pull"}
	gate := &reserveCountingGate{}
	orchestrator := &Orchestrator{Store: store, Engine: engine, Gate: gate, Snapshots: fakeSnapshot{}, Channel: "main"}
	op, _, err := store.Begin(model.OperationRequest{
		Kind: model.OperationRollback, IdempotencyKey: "rollback-image-failure",
		ExpectedGeneration: store.State().Generation,
	}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	orchestrator.runRollback(context.Background(), op)
	state := store.State()
	completed, err := store.Operation(op.ID)
	if err != nil {
		t.Fatal(err)
	}
	if state.Current == nil || state.Current.ID != currentID || state.Maintenance || state.PublicState != model.StateIdle || state.ActiveOperationID != "" {
		t.Fatalf("rollback image failure disturbed the current generation: %#v", state)
	}
	if completed.Status != model.OperationFailed || !completed.Retryable || !strings.Contains(completed.Error, "prepare previous generation images") {
		t.Fatalf("rollback image failure was not retryable: %#v", completed)
	}
	if gate.reservations != 0 {
		t.Fatalf("rollback reserved maintenance before images were ready: %d", gate.reservations)
	}
	engine.mu.Lock()
	defer engine.mu.Unlock()
	if !reflect.DeepEqual(engine.calls, []string{"pull"}) {
		t.Fatalf("rollback mutated the fixed stack after image failure: %v", engine.calls)
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
