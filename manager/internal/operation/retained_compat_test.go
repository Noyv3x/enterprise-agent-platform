//go:build linux

package operation

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/journal"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

type retainedCompatibilityFixture struct {
	orchestrator  *Orchestrator
	store         *journal.Store
	generation    *model.Generation
	generationDir string
	manifestPath  string
	composePath   string
}

func newRetainedCompatibilityFixture(t *testing.T, slot retainedGenerationSlot) retainedCompatibilityFixture {
	t.Helper()
	manifestBytes, err := os.ReadFile(filepath.Join("..", "release", "testdata", contract.SourceOwnerCompatGeneration+"-release.json"))
	if err != nil {
		t.Fatal(err)
	}
	composeBytes, err := os.ReadFile(filepath.Join("..", "release", "testdata", contract.SourceOwnerCompatGeneration+"-compose.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := release.DecodeRetainedHandoffPredecessorManifest(manifestBytes, "main", "linux", runtimeArchitectureForTest())
	if err != nil {
		t.Fatal(err)
	}
	dataRoot := filepath.Join(t.TempDir(), "data")
	stateDir := identity.SourceProfile().ManagerStateRoot(dataRoot)
	store, err := journal.Open(stateDir, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	releasesDir := filepath.Join(stateDir, "releases")
	generationDir := filepath.Join(releasesDir, contract.SourceOwnerCompatGeneration)
	if err := os.MkdirAll(generationDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(releasesDir, 0o700); err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(generationDir, "manifest.json")
	composePath := filepath.Join(generationDir, "compose.yaml")
	if err := os.WriteFile(manifestPath, manifestBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(composePath, composeBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(generationDir, "compose.env"), []byte("UBITECH_UID=1000\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	generation := generation(manifest, manifestPath)
	if _, err := store.MutateState(time.Now(), func(state *model.ManagerState) error {
		switch slot {
		case retainedGenerationCurrent:
			state.Current = generation
		case retainedGenerationPrevious:
			state.Previous = generation
		default:
			return errors.New("unsupported fixture slot")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	state := store.State()
	if slot == retainedGenerationCurrent {
		generation = state.Current
	} else {
		generation = state.Previous
	}
	return retainedCompatibilityFixture{
		orchestrator: &Orchestrator{
			Store: store, TechnicalProfile: identity.SourceActiveProfile(), DataRoot: dataRoot,
			ReleasesDir: releasesDir, Channel: "main",
		},
		store: store, generation: generation, generationDir: generationDir,
		manifestPath: manifestPath, composePath: composePath,
	}
}

func runtimeArchitectureForTest() string {
	// The fixture has artifacts for both supported architectures; use the test
	// process architecture without adding a second compatibility parser path.
	return runtime.GOARCH
}

func TestRetainedSourcePredecessorLoadsOnlyFromAuthoritativeCurrentOrPrevious(t *testing.T) {
	for _, slot := range []retainedGenerationSlot{retainedGenerationCurrent, retainedGenerationPrevious} {
		t.Run(string(slot), func(t *testing.T) {
			fixture := newRetainedCompatibilityFixture(t, slot)
			manifest, err := fixture.orchestrator.loadStateManifest(fixture.generation, slot)
			if err != nil {
				t.Fatal(err)
			}
			if manifest.ID() != contract.SourceOwnerCompatGeneration || manifest.Compose.SHA256 != contract.SourceOwnerCompatComposeSHA256 {
				t.Fatalf("loaded incompatible retained manifest: %#v", manifest)
			}
			if _, err := fixture.orchestrator.loadManifest(fixture.manifestPath); err == nil {
				t.Fatal("fixed predecessor unexpectedly passed the ordinary strict parser")
			}
			if _, err := fixture.orchestrator.loadStateManifest(fixture.generation, retainedGenerationSlot("candidate")); err == nil {
				t.Fatal("fixed predecessor was accepted outside Current/Previous")
			}
		})
	}
}

func TestRetainedSourcePredecessorRejectsNonCanonicalLocalEvidence(t *testing.T) {
	t.Run("target profile", func(t *testing.T) {
		fixture := newRetainedCompatibilityFixture(t, retainedGenerationCurrent)
		target, err := identity.ActivateVerifiedHandoffTarget(identity.TargetProfile())
		if err != nil {
			t.Fatal(err)
		}
		fixture.orchestrator.TechnicalProfile = target
		if _, err := fixture.orchestrator.loadRetainedSourceCompatibility(fixture.generation, retainedGenerationCurrent); err == nil {
			t.Fatal("target profile accepted source compatibility")
		}
	})
	t.Run("noncanonical manifest path", func(t *testing.T) {
		fixture := newRetainedCompatibilityFixture(t, retainedGenerationCurrent)
		if _, err := fixture.store.MutateState(time.Now(), func(state *model.ManagerState) error {
			state.Current.ManifestPath = filepath.Join(filepath.Dir(fixture.generationDir), "manifest.json")
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		current := fixture.store.State().Current
		if _, err := fixture.orchestrator.loadRetainedSourceCompatibility(current, retainedGenerationCurrent); err == nil {
			t.Fatal("noncanonical manifest path was accepted")
		}
	})
	t.Run("tampered compose", func(t *testing.T) {
		fixture := newRetainedCompatibilityFixture(t, retainedGenerationCurrent)
		data, err := os.ReadFile(fixture.composePath)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(fixture.composePath, append(data, []byte("\n# tampered\n")...), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := fixture.orchestrator.loadRetainedSourceCompatibility(fixture.generation, retainedGenerationCurrent); err == nil {
			t.Fatal("tampered Compose artifact was accepted")
		}
	})
	t.Run("journal images differ", func(t *testing.T) {
		fixture := newRetainedCompatibilityFixture(t, retainedGenerationCurrent)
		if _, err := fixture.store.MutateState(time.Now(), func(state *model.ManagerState) error {
			images := make(map[string]string, len(state.Current.Images))
			for name, image := range state.Current.Images {
				images[name] = image
			}
			images["platform"] = "ghcr.io/example/platform@sha256:" + strings.Repeat("0", 64)
			state.Current.Images = images
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		current := fixture.store.State().Current
		if _, err := fixture.orchestrator.loadRetainedSourceCompatibility(current, retainedGenerationCurrent); err == nil {
			t.Fatal("journal image mismatch was accepted")
		}
	})
	t.Run("symlink generation", func(t *testing.T) {
		fixture := newRetainedCompatibilityFixture(t, retainedGenerationCurrent)
		realDirectory := fixture.generationDir + ".real"
		if err := os.Rename(fixture.generationDir, realDirectory); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Base(realDirectory), fixture.generationDir); err != nil {
			t.Fatal(err)
		}
		if _, err := fixture.orchestrator.loadRetainedSourceCompatibility(fixture.generation, retainedGenerationCurrent); err == nil {
			t.Fatal("symlinked generation was accepted")
		}
	})
	t.Run("symlink manifest", func(t *testing.T) {
		fixture := newRetainedCompatibilityFixture(t, retainedGenerationCurrent)
		realManifest := filepath.Join(filepath.Dir(fixture.generationDir), "retained-manifest")
		if err := os.Rename(fixture.manifestPath, realManifest); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(realManifest, fixture.manifestPath); err != nil {
			t.Fatal(err)
		}
		if _, err := fixture.orchestrator.loadRetainedSourceCompatibility(fixture.generation, retainedGenerationCurrent); err == nil {
			t.Fatal("symlinked manifest was accepted")
		}
	})
	t.Run("unknown entry", func(t *testing.T) {
		fixture := newRetainedCompatibilityFixture(t, retainedGenerationCurrent)
		if err := os.WriteFile(filepath.Join(fixture.generationDir, "unexpected"), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := fixture.orchestrator.loadRetainedSourceCompatibility(fixture.generation, retainedGenerationCurrent); err == nil {
			t.Fatal("unknown retained release entry was accepted")
		}
	})
	t.Run("hard linked manifest", func(t *testing.T) {
		fixture := newRetainedCompatibilityFixture(t, retainedGenerationCurrent)
		if err := os.Link(fixture.manifestPath, filepath.Join(filepath.Dir(fixture.generationDir), "manifest-hardlink")); err != nil {
			t.Fatal(err)
		}
		if _, err := fixture.orchestrator.loadRetainedSourceCompatibility(fixture.generation, retainedGenerationCurrent); err == nil {
			t.Fatal("hard-linked manifest was accepted")
		}
	})
}

func TestHTTPGateRetainedSourcePredecessorUsesExact404Fallback(t *testing.T) {
	paths := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer manager-token" {
			t.Fatalf("authorization = %q", request.Header.Get("Authorization"))
		}
		paths = append(paths, request.URL.Path)
		var body map[string]string
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil || body["operation_id"] != "op_exact" {
			t.Fatalf("body=%#v err=%v", body, err)
		}
		switch request.URL.Path {
		case "/internal/manager/update/abort-release":
			response.WriteHeader(http.StatusNotFound)
			_, _ = response.Write([]byte(`{"error":"manager endpoint not found"}`))
		case "/internal/manager/update/release":
			_ = json.NewEncoder(response).Encode(map[string]bool{"released": true})
		default:
			t.Fatalf("unexpected path %s", request.URL.Path)
		}
	}))
	defer server.Close()
	gate := HTTPGate{BaseURL: server.URL, Token: "manager-token", Client: server.Client()}
	if err := gate.releaseRetainedSourcePredecessor(context.Background(), "op_exact", contract.SourceOwnerCompatGeneration); err != nil {
		t.Fatal(err)
	}
	want := []string{"/internal/manager/update/abort-release", "/internal/manager/update/release"}
	if !reflect.DeepEqual(paths, want) {
		t.Fatalf("paths=%v, want %v", paths, want)
	}
}

func TestHTTPGateRetainedSourcePredecessorNeverFallsBackOnOtherFailures(t *testing.T) {
	tests := []struct {
		name   string
		status int
		body   string
	}{
		{name: "unauthorized", status: http.StatusUnauthorized, body: `{"error":"invalid manager token"}`},
		{name: "conflict", status: http.StatusConflict, body: `{"error":"reservation mismatch"}`},
		{name: "wrong 404 body", status: http.StatusNotFound, body: `{"error":"not found"}`},
		{name: "unknown 404 field", status: http.StatusNotFound, body: `{"error":"manager endpoint not found","extra":true}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				calls++
				if request.URL.Path != "/internal/manager/update/abort-release" {
					t.Fatalf("legacy endpoint called after %s", test.name)
				}
				response.WriteHeader(test.status)
				_, _ = response.Write([]byte(test.body))
			}))
			defer server.Close()
			gate := HTTPGate{BaseURL: server.URL, Token: "manager-token", Client: server.Client()}
			if err := gate.releaseRetainedSourcePredecessor(context.Background(), "op_exact", contract.SourceOwnerCompatGeneration); err == nil {
				t.Fatal("failure was accepted")
			}
			if calls != 1 {
				t.Fatalf("calls=%d, want 1", calls)
			}
		})
	}

	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("noncanonical generation made an HTTP request")
	}))
	defer server.Close()
	if err := (HTTPGate{BaseURL: server.URL, Token: "manager-token", Client: server.Client()}).releaseRetainedSourcePredecessor(context.Background(), "op_exact", strings.Repeat("f", 40)); err == nil {
		t.Fatal("noncanonical generation was accepted")
	}
	if err := (HTTPGate{BaseURL: "http://127.0.0.1:1", Token: "manager-token", Client: &http.Client{Timeout: 100 * time.Millisecond}}).releaseRetainedSourcePredecessor(context.Background(), "op_exact", contract.SourceOwnerCompatGeneration); err == nil {
		t.Fatal("transport failure was accepted")
	}
}

func TestHTTPGateRetainedSourcePredecessorRejectsNonClosedLegacyResponse(t *testing.T) {
	for _, body := range []string{
		`{"released":false}`,
		`{"released":true,"unknown":true}`,
		`{"released":true,"released":true}`,
		`{"released":true}{}`,
	} {
		t.Run(body, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				if request.URL.Path == "/internal/manager/update/abort-release" {
					response.WriteHeader(http.StatusNotFound)
					_, _ = response.Write([]byte(`{"error":"manager endpoint not found"}`))
					return
				}
				if request.URL.Path != "/internal/manager/update/release" {
					t.Fatalf("unexpected path %s", request.URL.Path)
				}
				_, _ = response.Write([]byte(body))
			}))
			defer server.Close()
			gate := HTTPGate{BaseURL: server.URL, Token: "manager-token", Client: server.Client()}
			if err := gate.releaseRetainedSourcePredecessor(context.Background(), "op_exact", contract.SourceOwnerCompatGeneration); err == nil {
				t.Fatal("non-closed legacy response was accepted")
			}
		})
	}
}

func TestRetainedSourcePredecessorFallbackRequiresLocalSourceProof(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*testing.T, retainedCompatibilityFixture)
	}{
		{name: "target profile", mutate: func(t *testing.T, fixture retainedCompatibilityFixture) {
			target, err := identity.ActivateVerifiedHandoffTarget(identity.TargetProfile())
			if err != nil {
				t.Fatal(err)
			}
			fixture.orchestrator.TechnicalProfile = target
		}},
		{name: "tampered compose", mutate: func(t *testing.T, fixture retainedCompatibilityFixture) {
			if err := os.WriteFile(fixture.composePath, []byte("tampered"), 0o600); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newRetainedCompatibilityFixture(t, retainedGenerationCurrent)
			test.mutate(t, fixture)
			paths := []string{}
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				paths = append(paths, request.URL.Path)
				if request.URL.Path == "/internal/manager/update/release" {
					t.Fatal("legacy endpoint was reached without exact local source proof")
				}
				response.WriteHeader(http.StatusNotFound)
				_, _ = response.Write([]byte(`{"error":"manager endpoint not found"}`))
			}))
			defer server.Close()
			gate := HTTPGate{BaseURL: server.URL, Token: "manager-token", Client: server.Client()}
			if err := fixture.orchestrator.releaseGate(context.Background(), gate, "op_exact"); err == nil {
				t.Fatal("unproven fallback unexpectedly succeeded")
			}
			if !reflect.DeepEqual(paths, []string{"/internal/manager/update/abort-release"}) {
				t.Fatalf("paths=%v", paths)
			}
		})
	}
}

type retainedFailOnceEngine struct {
	fakeEngine
	failed bool
}

func (engine *retainedFailOnceEngine) StopFixed(ctx context.Context) error {
	if !engine.failed {
		engine.failed = true
		engine.mu.Lock()
		engine.calls = append(engine.calls, "stop")
		engine.mu.Unlock()
		return errors.New("injected transient stop failure")
	}
	return engine.fakeEngine.StopFixed(ctx)
}

func TestRetainedSourcePredecessorRestartCompletesThroughLegacyAbortEndpoint(t *testing.T) {
	fixture := newRetainedCompatibilityFixture(t, retainedGenerationCurrent)
	paths := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer manager-token" {
			t.Fatalf("authorization=%q", request.Header.Get("Authorization"))
		}
		paths = append(paths, request.URL.Path)
		switch request.URL.Path {
		case "/internal/manager/update/readiness":
			_ = json.NewEncoder(response).Encode(Reservation{Ready: true, Reserved: true})
		case "/internal/manager/update/abort-release":
			response.WriteHeader(http.StatusNotFound)
			_, _ = response.Write([]byte(`{"error":"manager endpoint not found"}`))
		case "/internal/manager/update/release":
			_ = json.NewEncoder(response).Encode(map[string]bool{"released": true})
		default:
			t.Fatalf("unexpected endpoint %s", request.URL.Path)
		}
	}))
	defer server.Close()
	engine := &fakeEngine{}
	fixture.orchestrator.Engine = engine
	fixture.orchestrator.Gate = HTTPGate{BaseURL: server.URL, Token: "manager-token", Client: server.Client()}
	fixture.orchestrator.Snapshots = fakeSnapshot{}
	op, _, err := fixture.store.Begin(model.OperationRequest{
		Kind: model.OperationRestart, IdempotencyKey: "retained-restart-success", ExpectedGeneration: fixture.store.State().Generation,
	}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	fixture.orchestrator.runRestart(context.Background(), op)
	completed, err := fixture.store.Operation(op.ID)
	if err != nil {
		t.Fatal(err)
	}
	state := fixture.store.State()
	if completed.Status != model.OperationSucceeded || !completed.Finalized || state.Maintenance || state.PublicState != model.StateIdle {
		t.Fatalf("operation=%#v state=%#v", completed, state)
	}
	wantPaths := []string{
		"/internal/manager/update/readiness", "/internal/manager/update/readiness",
		"/internal/manager/update/abort-release", "/internal/manager/update/release",
		"/internal/manager/update/abort-release", "/internal/manager/update/release",
	}
	if !reflect.DeepEqual(paths, wantPaths) {
		t.Fatalf("paths=%v, want %v", paths, wantPaths)
	}
}

func TestRetainedSourcePredecessorRestartFailureRestoresAndAbortsThroughLegacyEndpoint(t *testing.T) {
	fixture := newRetainedCompatibilityFixture(t, retainedGenerationCurrent)
	paths := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer manager-token" {
			t.Fatalf("authorization=%q", request.Header.Get("Authorization"))
		}
		paths = append(paths, request.URL.Path)
		switch request.URL.Path {
		case "/internal/manager/update/readiness":
			_ = json.NewEncoder(response).Encode(Reservation{Ready: true, Reserved: true})
		case "/internal/manager/update/abort-release":
			response.WriteHeader(http.StatusNotFound)
			_, _ = response.Write([]byte(`{"error":"manager endpoint not found"}`))
		case "/internal/manager/update/release":
			_ = json.NewEncoder(response).Encode(map[string]bool{"released": true})
		default:
			t.Fatalf("unexpected endpoint %s", request.URL.Path)
		}
	}))
	defer server.Close()
	engine := &retainedFailOnceEngine{}
	fixture.orchestrator.Engine = engine
	fixture.orchestrator.Gate = HTTPGate{BaseURL: server.URL, Token: "manager-token", Client: server.Client()}
	fixture.orchestrator.Snapshots = fakeSnapshot{}
	op, _, err := fixture.store.Begin(model.OperationRequest{
		Kind: model.OperationRestart, IdempotencyKey: "retained-restart", ExpectedGeneration: fixture.store.State().Generation,
	}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	fixture.orchestrator.runRestart(context.Background(), op)
	completed, err := fixture.store.Operation(op.ID)
	if err != nil {
		t.Fatal(err)
	}
	state := fixture.store.State()
	if completed.Status != model.OperationFailed || !completed.Finalized || state.Maintenance || state.PublicState != model.StateIdle {
		t.Fatalf("operation=%#v state=%#v", completed, state)
	}
	wantPaths := []string{
		"/internal/manager/update/readiness", "/internal/manager/update/readiness",
		"/internal/manager/update/abort-release", "/internal/manager/update/release",
	}
	if !reflect.DeepEqual(paths, wantPaths) {
		t.Fatalf("paths=%v, want %v", paths, wantPaths)
	}
	engine.mu.Lock()
	started := append([]string(nil), engine.started...)
	engine.mu.Unlock()
	if !reflect.DeepEqual(started, []string{contract.SourceOwnerCompatGeneration}) {
		t.Fatalf("restored generations=%v", started)
	}
}
