package release

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
)

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

func TestManifestAcceptsSafeOpaqueExtraImage(t *testing.T) {
	manifest := validManifest("http://127.0.0.1", []byte("x"))
	manifest.Images["future-service"] = manifest.Images["firecrawl-postgres"]
	if err := manifest.Validate("main", runtime.GOOS, runtime.GOARCH); err != nil {
		t.Fatalf("safe opaque image metadata was rejected: %v", err)
	}
}

func TestManifestRejectsUnsafeExtraImageNames(t *testing.T) {
	for _, name := range []string{"Firecrawl-Extra", "../extra", "extra_image", "extra.image", "extra\nimage", "-extra", "extra-"} {
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
