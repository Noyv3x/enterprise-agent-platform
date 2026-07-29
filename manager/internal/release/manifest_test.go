package release

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/contract"
)

// This is the exact required-image contract shipped by the only deployed
// Manager at e758a8307435af0ffc3cc3aecd059fe58c6c2db1. Keep it local to this
// one-release handoff test: current validation must not regain FoundationDB as
// a required service merely to prove that the old binary can accept the bridge.
var frozenE758RequiredImages = []string{
	"platform", "agent-runtime", "camofox", "agent-sandbox", "searxng",
	"firecrawl-api", "firecrawl-playwright", "firecrawl-postgres",
	"firecrawl-redis", "firecrawl-rabbitmq", "firecrawl-foundationdb",
}

var frozenE758DigestPattern = regexp.MustCompile(`^[^@[:space:]]+@sha256:[0-9a-f]{64}$`)

func validateFrozenE758RequiredImages(images map[string]string) error {
	for _, name := range frozenE758RequiredImages {
		digest, ok := images[name]
		if !ok || !frozenE758DigestPattern.MatchString(digest) {
			return fmt.Errorf("e758 image %q must use a complete registry sha256 digest", name)
		}
	}
	return nil
}

func validManifest(base string, compose []byte) Manifest {
	sum := sha256.Sum256(compose)
	artifact := Artifact{URL: base + "/compose", SHA256: hex.EncodeToString(sum[:])}
	binary := sha256.Sum256([]byte("manager"))
	images := map[string]string{}
	for _, name := range []string{"platform", "agent-runtime", "camofox", "agent-sandbox", "searxng", "firecrawl-api", "firecrawl-playwright", "firecrawl-postgres", "firecrawl-redis", "firecrawl-rabbitmq"} {
		images[name] = "registry.example/" + name + "@sha256:" + strings.Repeat("a", 64)
	}
	return Manifest{SchemaVersion: contract.SchemaVersion, Channel: contract.ReleaseChannel, SourceCommit: strings.Repeat("b", 40), GeneratedAt: time.Now().UTC(), ProtocolVersion: contract.SchemaVersion, DatabaseSchemaVersion: 1, Manager: ManagerRelease{Version: "v1", Artifacts: map[string]Artifact{runtime.GOARCH: {URL: base + "/manager", SHA256: hex.EncodeToString(binary[:])}}}, Compose: artifact, Images: images}
}

func TestManifestBridgeSatisfiesFrozenE758AndCurrentContracts(t *testing.T) {
	manifest := validManifest("http://127.0.0.1", []byte("x"))
	if err := validateFrozenE758RequiredImages(manifest.Images); err == nil {
		t.Fatal("clean current manifest unexpectedly satisfied the frozen e758 contract")
	}
	manifest.Images["firecrawl-foundationdb"] = manifest.Images["firecrawl-postgres"]
	if manifest.Images["firecrawl-foundationdb"] != manifest.Images["firecrawl-postgres"] {
		t.Fatal("bridge FoundationDB key does not alias the PostgreSQL digest")
	}
	if err := validateFrozenE758RequiredImages(manifest.Images); err != nil {
		t.Fatalf("bridge manifest was rejected by the frozen e758 contract: %v", err)
	}
	if err := manifest.Validate("main", runtime.GOOS, runtime.GOARCH); err != nil {
		t.Fatalf("bridge manifest was rejected by the current contract: %v", err)
	}
}

func TestManifestRejectsUnsafeExtraImageNames(t *testing.T) {
	for _, name := range []string{"Firecrawl-Legacy", "../legacy", "legacy_image", "legacy.image", "legacy\nimage", "-legacy", "legacy-"} {
		t.Run(fmt.Sprintf("%q", name), func(t *testing.T) {
			manifest := validManifest("http://127.0.0.1", []byte("x"))
			manifest.Images[name] = manifest.Images["firecrawl-postgres"]
			if err := manifest.Validate("main", runtime.GOOS, runtime.GOARCH); err == nil {
				t.Fatalf("unsafe extra image name %q was accepted", name)
			}
		})
	}
}

func TestFetchValidatesManifestAndArtifactChecksum(t *testing.T) {
	compose := []byte("services: {}\n")
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/manifest":
			_ = json.NewEncoder(w).Encode(validManifest(server.URL, compose))
		case "/compose":
			_, _ = w.Write(compose)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	client := Client{HTTP: server.Client()}
	manifest, _, err := client.Fetch(context.Background(), server.URL+"/manifest", "main")
	if err != nil {
		t.Fatal(err)
	}
	data, err := client.FetchArtifact(context.Background(), manifest.Compose, 1024)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != string(compose) {
		t.Fatal("compose payload mismatch")
	}
}
func TestManifestRejectsMutableImageTag(t *testing.T) {
	manifest := validManifest("http://127.0.0.1", []byte("x"))
	manifest.Images["platform"] = "registry.example/platform:latest"
	if err := manifest.Validate("main", runtime.GOOS, runtime.GOARCH); err == nil {
		t.Fatal("expected mutable image rejection")
	}
}

func TestManifestRejectsUnsupportedManagerProtocol(t *testing.T) {
	manifest := validManifest("http://127.0.0.1", []byte("x"))
	manifest.ProtocolVersion++
	if err := manifest.Validate("main", runtime.GOOS, runtime.GOARCH); err == nil {
		t.Fatal("expected unsupported manager protocol rejection")
	}
}

func TestFetchClassifiesTemporaryAvailabilityWithoutRetryingInvalidContent(t *testing.T) {
	responses := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		responses++
		if responses == 1 {
			http.NotFound(w, nil)
			return
		}
		_, _ = w.Write([]byte(`{"schema_version":"invalid"}`))
	}))
	defer server.Close()
	client := Client{HTTP: server.Client()}
	if _, _, err := client.Fetch(context.Background(), server.URL, "main"); err == nil || !IsTemporarilyUnavailable(err) {
		t.Fatalf("404 was not classified as temporarily unavailable: %v", err)
	}
	if _, _, err := client.Fetch(context.Background(), server.URL, "main"); err == nil || IsTemporarilyUnavailable(err) {
		t.Fatalf("invalid manifest was incorrectly made retryable: %v", err)
	}
}
