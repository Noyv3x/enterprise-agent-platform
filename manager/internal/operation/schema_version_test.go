package operation

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/journal"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/releasetest"
)

type schemaFixtureTransport map[string][]byte

func (transport schemaFixtureTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	data, ok := transport[request.URL.String()]
	if !ok {
		return nil, fmt.Errorf("unregistered synthetic URL %s", request.URL)
	}
	return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(data)), Request: request}, nil
}

func TestRejectDatabaseSchemaRegression(t *testing.T) {
	for _, action := range []string{"check", "update"} {
		t.Run(action, func(t *testing.T) {
			for _, downgrade := range []bool{false, true} {
				name := "same_schema"
				if downgrade {
					name = "downgrade"
				}
				t.Run(name, func(t *testing.T) {
					root := t.TempDir()
					fixture := releasetest.NewTarget(strings.Repeat("b", 40))
					encoded, err := json.Marshal(fixture.Manifest)
					if err != nil {
						t.Fatal(err)
					}
					const manifestURL = "https://example.invalid/schema/manifest"
					client := release.Client{HTTP: &http.Client{Transport: schemaFixtureTransport{manifestURL: encoded, fixture.Manifest.Compose.URL: fixture.Compose}}}
					ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
					defer cancel()
					// Exercise the real decoder/profile checks before introducing current-state precedence.
					if _, _, err := client.FetchForProfile(ctx, manifestURL, contract.ReleaseChannel, identity.CompileTimeActiveProfile()); err != nil {
						t.Fatalf("invalid candidate fixture: %v", err)
					}
					store, err := journal.Open(filepath.Join(root, "state"), time.Unix(100, 0))
					if err != nil {
						t.Fatal(err)
					}
					currentSchema := fixture.Manifest.DatabaseSchemaVersion
					if downgrade {
						currentSchema++
					}
					currentID := strings.Repeat("a", 40)
					if _, err := store.MutateState(time.Unix(101, 0), func(state *model.ManagerState) error {
						state.Current = &model.Generation{ID: currentID, SourceCommit: currentID, DatabaseVersion: currentSchema}
						return nil
					}); err != nil {
						t.Fatal(err)
					}
					// A fake preparation failure bounds execution before reserve/stop/migrate.
					engine := &fakeEngine{failAt: "prepare"}
					selfUpdate := &recordingSelfUpdate{}
					o := &Orchestrator{Store: store, Engine: engine, SelfUpdate: selfUpdate, Gate: fakeGate{}, Snapshots: fakeSnapshot{}, ReleasesDir: filepath.Join(root, "releases"), ManifestURL: manifestURL, Channel: contract.ReleaseChannel, ReleaseClient: client, TechnicalProfile: identity.CompileTimeActiveProfile()}
					if action == "check" {
						_, checkErr := o.Check(ctx, manifestURL)
						if downgrade {
							if checkErr == nil {
								t.Error("Check accepted candidate older than current database schema")
							}
							if store.State().Candidate != nil {
								t.Error("Check published schema-regressing candidate")
							}
						} else if checkErr != nil || store.State().Candidate == nil {
							t.Fatalf("valid same-schema check fixture rejected: %v", checkErr)
						}
						return
					}
					op, _, err := store.Begin(model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: "schema-regression", ExpectedGeneration: store.State().Generation, ManifestURL: manifestURL}, time.Unix(102, 0))
					if err != nil {
						t.Fatal(err)
					}
					o.runUpdate(ctx, op)
					terminal, err := store.Operation(op.ID)
					if err != nil {
						t.Fatal(err)
					}
					if terminal.Status != model.OperationFailed {
						t.Errorf("update must reject before cutover: status=%s", terminal.Status)
					}
					if downgrade {
						if selfUpdate.prepared != 0 {
							t.Errorf("Manager Prepare ran for schema downgrade: %d", selfUpdate.prepared)
						}
						for _, call := range engine.calls {
							if call == "prepare" || call == "pull" || call == "stop" || call == "migrate" {
								t.Errorf("schema downgrade crossed side-effect boundary: %s", call)
							}
						}
					} else {
						prepared := false
						for _, call := range engine.calls {
							if call == "prepare" {
								prepared = true
							}
						}
						if !prepared {
							t.Fatalf("valid update did not reach intentional fake preparation failure: calls=%v error=%s", engine.calls, terminal.Error)
						}
					}
				})
			}
		})
	}
}
