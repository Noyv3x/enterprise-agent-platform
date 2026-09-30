package release

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

func validManifest(base string) Manifest {
	generation := strings.Repeat("a", 40)
	artifacts := map[string]Artifact{}
	for _, arch := range []string{"amd64", "arm64"} {
		artifacts[arch] = Artifact{
			URL:    base + "/agent-platform-manager-linux-" + arch,
			SHA256: strings.Repeat("b", 64),
		}
	}
	images := map[string]string{}
	for _, name := range managedImageNames {
		images[name] = "registry.example/" + name + "@sha256:" + strings.Repeat("c", 64)
	}
	return Manifest{
		SchemaVersion:         ManifestSchemaVersion,
		Channel:               contract.ReleaseChannel,
		SourceCommit:          generation,
		GeneratedAt:           time.Unix(1, 0).UTC(),
		ProtocolVersion:       ManifestSchemaVersion,
		DatabaseSchemaVersion: contract.DatabaseSchemaVersion,
		Manager:               ManagerRelease{Version: generation, Artifacts: artifacts},
		Compose:               Artifact{URL: base + "/agent-platform-compose.yaml", SHA256: strings.Repeat("d", 64)},
		Images:                images,
	}
}

func TestTargetManifestValidation(t *testing.T) {
	manifest := validManifest("http://127.0.0.1")
	for _, arch := range []string{"amd64", "arm64"} {
		if err := manifest.Validate(contract.ReleaseChannel, "linux", arch); err != nil {
			t.Fatalf("linux/%s: %v", arch, err)
		}
	}
}

func TestTargetManifestValidationFailsClosed(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Manifest)
	}{
		{name: "old schema", mutate: func(m *Manifest) { m.SchemaVersion-- }},
		{name: "old protocol", mutate: func(m *Manifest) { m.ProtocolVersion-- }},
		{name: "wrong channel", mutate: func(m *Manifest) { m.Channel = "other" }},
		{name: "short commit", mutate: func(m *Manifest) { m.SourceCommit = "short" }},
		{name: "version mismatch", mutate: func(m *Manifest) { m.Manager.Version = strings.Repeat("e", 40) }},
		{name: "missing architecture", mutate: func(m *Manifest) { delete(m.Manager.Artifacts, "arm64") }},
		{name: "extra architecture", mutate: func(m *Manifest) { m.Manager.Artifacts["s390x"] = m.Manager.Artifacts["amd64"] }},
		{name: "wrong manager basename", mutate: func(m *Manifest) {
			a := m.Manager.Artifacts["amd64"]
			a.URL = "http://127.0.0.1/manager"
			m.Manager.Artifacts["amd64"] = a
		}},
		{name: "wrong compose basename", mutate: func(m *Manifest) { m.Compose.URL = "http://127.0.0.1/compose.yaml" }},
		{name: "missing image", mutate: func(m *Manifest) { delete(m.Images, "platform") }},
		{name: "unknown image", mutate: func(m *Manifest) {
			m.Images["unknown"] = "registry.example/unknown@sha256:" + strings.Repeat("f", 64)
		}},
		{name: "mutable image", mutate: func(m *Manifest) { m.Images["platform"] = "registry.example/platform:latest" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			manifest := validManifest("http://127.0.0.1")
			test.mutate(&manifest)
			if err := manifest.Validate(contract.ReleaseChannel, "linux", "amd64"); err == nil {
				t.Fatal("invalid manifest was accepted")
			}
		})
	}
	manifest := validManifest("http://127.0.0.1")
	if err := manifest.Validate(contract.ReleaseChannel, "darwin", "amd64"); err == nil {
		t.Fatal("unsupported operating system was accepted")
	}
}

func TestCatalogsRemainValidWithoutCapacityEstimates(t *testing.T) {
	estimates := contract.ManagedImageCapacityEstimates
	contract.ManagedImageCapacityEstimates = nil
	defer func() { contract.ManagedImageCapacityEstimates = estimates }()
	manifest := validManifest("https://registry.example")
	if err := manifest.Validate(contract.ReleaseChannel, "linux", "amd64"); err != nil {
		t.Fatalf("legacy rollback without capacity map: %v", err)
	}
	for _, name := range managedImageNames[5:] {
		delete(manifest.Images, name)
	}
	if err := manifest.Validate(contract.ReleaseChannel, "linux", "amd64"); err != nil {
		t.Fatalf("reduced catalog: %v", err)
	}
	manifest.Images["firecrawl-api"] = "registry.example/firecrawl@sha256:" + strings.Repeat("a", 64)
	if err := manifest.Validate(contract.ReleaseChannel, "linux", "amd64"); err == nil {
		t.Fatal("partial Firecrawl stack accepted")
	}
}

func TestDecodeManifestRejectsUnknownDuplicateAndRetiredFields(t *testing.T) {
	manifest := validManifest("http://127.0.0.1")
	payload, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeManifest(payload, contract.ReleaseChannel, "linux", "amd64"); err != nil {
		t.Fatal(err)
	}
	doc := string(payload)
	for _, test := range []struct {
		name    string
		payload string
	}{
		{name: "unknown", payload: strings.Replace(doc, "{", `{"unknown":true,`, 1)},
		{name: "unknown top-level field", payload: strings.Replace(doc, "{", `{"unexpected":{},`, 1)},
		{name: "case variant", payload: strings.Replace(doc, `"schema_version"`, `"Schema_Version"`, 1)},
		{name: "duplicate", payload: strings.Replace(doc, "{", `{"schema_version":2,`, 1)},
		{name: "trailing", payload: doc + `{}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := DecodeManifest([]byte(test.payload), contract.ReleaseChannel, "linux", "amd64"); err == nil {
				t.Fatal("invalid document was accepted")
			}
		})
	}
}

func TestFetchValidatesChecksumAndAvailability(t *testing.T) {
	binary := []byte("manager")
	compose := []byte("services: {}\n")
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/manifest":
			manifest := validManifest(server.URL)
			_ = json.NewEncoder(w).Encode(manifest)
		case "/artifact":
			_, _ = w.Write(binary)
		case "/missing":
			http.Error(w, "not ready", http.StatusServiceUnavailable)
		default:
			_, _ = w.Write(compose)
		}
	}))
	defer server.Close()

	client := Client{HTTP: server.Client()}
	manifest, _, err := client.Fetch(context.Background(), server.URL+"/manifest", contract.ReleaseChannel)
	if err != nil || manifest.ID() == "" {
		t.Fatalf("fetch manifest: %#v, %v", manifest, err)
	}
	if _, err := client.FetchArtifact(context.Background(), Artifact{
		URL: server.URL + "/artifact", SHA256: strings.Repeat("0", 64),
	}, 1024); err == nil {
		t.Fatal("checksum mismatch was accepted")
	}
	if _, _, err := client.Fetch(context.Background(), server.URL+"/missing", contract.ReleaseChannel); err == nil || !IsTemporarilyUnavailable(err) {
		t.Fatalf("temporary availability was not classified: %v", err)
	}
}

func TestDefaultFetchUsesFreshTLSConnections(t *testing.T) {
	for _, http2 := range []bool{false, true} {
		name := "http1"
		if http2 {
			name = "http2"
		}
		t.Run(name, func(t *testing.T) {
			var connections atomic.Int32
			artifactData := []byte("manager")
			sum := sha256.Sum256(artifactData)
			var server *httptest.Server
			server = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if (r.ProtoMajor == 2) != http2 {
					t.Errorf("request protocol = %s, HTTP/2 enabled = %t", r.Proto, http2)
				}
				switch r.URL.Path {
				case "/manifest":
					_ = json.NewEncoder(w).Encode(validManifest(server.URL))
				case "/artifact":
					_, _ = w.Write(artifactData)
				}
			}))
			server.EnableHTTP2 = http2
			server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
				if state == http.StateNew {
					connections.Add(1)
				}
			}
			server.StartTLS()
			defer server.Close()

			original := defaultHTTPTransport
			transport := original.Clone()
			transport.TLSClientConfig = server.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
			defaultHTTPTransport = transport
			defer func() {
				defaultHTTPTransport = original
				transport.CloseIdleConnections()
			}()

			client := Client{}
			for i := range 2 {
				manifest, _, err := client.Fetch(context.Background(), server.URL+"/manifest", contract.ReleaseChannel)
				if err != nil || manifest.ID() != strings.Repeat("a", 40) {
					t.Fatalf("manifest fetch %d: id=%q err=%v", i, manifest.ID(), err)
				}
			}
			if got := connections.Load(); got != 2 {
				t.Errorf("two manifest fetches opened %d connections, want 2", got)
			}
			before := connections.Load()
			for i := range 2 {
				data, err := client.FetchArtifact(context.Background(), Artifact{
					URL: server.URL + "/artifact", SHA256: hex.EncodeToString(sum[:]),
				}, 1024)
				if err != nil || string(data) != string(artifactData) {
					t.Fatalf("artifact fetch %d: data=%q err=%v", i, data, err)
				}
			}
			if got := connections.Load() - before; got != 2 {
				t.Errorf("two artifact fetches opened %d connections, want 2", got)
			}
		})
	}
}

func TestConditionalManifestFetchReusesBoundedValidators(t *testing.T) {
	modified := time.Unix(1_700_000_000, 0).UTC().Format(http.TimeFormat)
	requests := 0
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if requests == 1 {
			if r.Header.Get("If-None-Match") != "" || r.Header.Get("If-Modified-Since") != "" {
				t.Errorf("initial request carried validators: %#v", r.Header)
			}
			w.Header().Set("ETag", `W/"generation-a"`)
			w.Header().Set("Last-Modified", modified)
			_ = json.NewEncoder(w).Encode(validManifest(server.URL))
			return
		}
		if r.Header.Get("If-None-Match") != `W/"generation-a"` || r.Header.Get("If-Modified-Since") != modified {
			t.Errorf("conditional request validators = %#v", r.Header)
		}
		w.WriteHeader(http.StatusNotModified)
	}))
	defer server.Close()

	client := Client{HTTP: server.Client()}
	first, err := client.FetchForProfileConditional(
		context.Background(), server.URL, contract.ReleaseChannel,
		identity.CompileTimeActiveProfile(), Validators{},
	)
	if err != nil || !first.Modified || first.Manifest.ID() == "" || len(first.Data) == 0 {
		t.Fatalf("initial conditional fetch = %#v, %v", first, err)
	}
	second, err := client.FetchForProfileConditional(
		context.Background(), server.URL, contract.ReleaseChannel,
		identity.CompileTimeActiveProfile(), first.Validators,
	)
	if err != nil || second.Modified || second.Manifest.ID() != "" || second.Data != nil {
		t.Fatalf("not-modified fetch = %#v, %v", second, err)
	}
	if second.Validators != first.Validators || requests != 2 {
		t.Fatalf("conditional validators were not retained: first=%#v second=%#v requests=%d", first.Validators, second.Validators, requests)
	}
}

func TestConditionalManifestFetchRejectsUnsolicitedNotModified(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotModified)
	}))
	defer server.Close()
	_, err := (Client{HTTP: server.Client()}).FetchForProfileConditional(
		context.Background(), server.URL, contract.ReleaseChannel,
		identity.CompileTimeActiveProfile(), Validators{},
	)
	if err == nil || !strings.Contains(err.Error(), "without request validators") {
		t.Fatalf("unsolicited 304 error = %v", err)
	}
}

func TestReleaseURLPolicyRejectsPublicHTTPAndCredentials(t *testing.T) {
	for _, raw := range []string{
		"http://example.com/release.json",
		"https://user:secret@example.com/release.json",
		"file:///tmp/release.json",
	} {
		if err := validateReleaseURL(raw); err == nil {
			t.Fatalf("unsafe URL accepted: %s", raw)
		}
	}
}
