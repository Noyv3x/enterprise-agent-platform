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
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
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

func testArtifact(base, name string) Artifact {
	sum := sha256.Sum256([]byte(name))
	return Artifact{URL: base + "/" + name, SHA256: hex.EncodeToString(sum[:])}
}

func testManagerRelease(base, version, prefix string) ManagerRelease {
	return ManagerRelease{
		Version: version,
		Artifacts: map[string]Artifact{
			"amd64": testArtifact(base, prefix+"-amd64"),
			"arm64": testArtifact(base, prefix+"-arm64"),
		},
	}
}

func cloneManagerRelease(release ManagerRelease) ManagerRelease {
	artifacts := make(map[string]Artifact, len(release.Artifacts))
	for arch, artifact := range release.Artifacts {
		artifacts[arch] = artifact
	}
	return ManagerRelease{Version: release.Version, Artifacts: artifacts}
}

func validNamespaceHandoffManifest(base string) Manifest {
	manifest := validManifest(base, []byte("target compose"))
	manifest.Manager = testManagerRelease(base, manifest.SourceCommit, "target-manager")
	manifest.Compose = testArtifact(base, "target-compose")
	manifest.NamespaceHandoff = &NamespaceHandoff{
		SchemaVersion:         namespaceHandoffSchemaVersion,
		PredecessorGeneration: strings.Repeat("a", 40),
		BridgeGeneration:      manifest.SourceCommit,
		Source: NamespaceBinding{
			ProfileID: identity.SourceProfile().ProfileID,
			Manager:   testManagerRelease(base, strings.Repeat("a", 40), "source-manager"),
			Compose:   testArtifact(base, "source-compose"),
		},
		Target: NamespaceBinding{
			ProfileID: identity.TargetProfileID(),
			Manager:   cloneManagerRelease(manifest.Manager),
			Compose:   manifest.Compose,
		},
	}
	return manifest
}

func fetchManifestDocument(t *testing.T, document any) (Manifest, error) {
	t.Helper()
	payload, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(payload)
	}))
	defer server.Close()
	manifest, _, err := (Client{HTTP: server.Client()}).Fetch(context.Background(), server.URL, contract.ReleaseChannel)
	return manifest, err
}

func manifestDocument(t *testing.T, manifest Manifest) map[string]any {
	t.Helper()
	payload, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(payload, &document); err != nil {
		t.Fatal(err)
	}
	return document
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
	if manifest.NamespaceHandoff != nil {
		t.Fatal("ordinary manifest unexpectedly enabled namespace handoff")
	}
	data, err := client.FetchArtifact(context.Background(), manifest.Compose, 1024)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != string(compose) {
		t.Fatal("compose payload mismatch")
	}
}

func TestFetchAcceptsCompleteNamespaceHandoffDescriptor(t *testing.T) {
	want := validNamespaceHandoffManifest("http://127.0.0.1")
	got, err := fetchManifestDocument(t, want)
	if err != nil {
		t.Fatal(err)
	}
	if got.NamespaceHandoff == nil {
		t.Fatal("namespace handoff descriptor was not parsed")
	}
	if got.NamespaceHandoff.Source.ProfileID != identity.SourceProfile().ProfileID || got.NamespaceHandoff.Target.ProfileID != identity.TargetProfileID() {
		t.Fatalf("unexpected namespace profiles: %#v", got.NamespaceHandoff)
	}
}

func TestFetchRejectsTrailingJSONValue(t *testing.T) {
	payload, err := json.Marshal(validManifest("http://127.0.0.1", []byte("x")))
	if err != nil {
		t.Fatal(err)
	}
	payload = append(payload, []byte("\n{}\n")...)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(payload)
	}))
	defer server.Close()
	if _, _, err := (Client{HTTP: server.Client()}).Fetch(context.Background(), server.URL, contract.ReleaseChannel); err == nil || !strings.Contains(err.Error(), "trailing JSON") {
		t.Fatalf("trailing manifest JSON was accepted: %v", err)
	}
}

func TestFetchRejectsDuplicateJSONKeys(t *testing.T) {
	payload, err := json.Marshal(validNamespaceHandoffManifest("http://127.0.0.1"))
	if err != nil {
		t.Fatal(err)
	}
	needle := `"profile_id":"` + identity.TargetProfileID() + `"`
	duplicate := needle + `,"profile_id":"` + identity.TargetProfileID() + `"`
	payload = []byte(strings.Replace(string(payload), needle, duplicate, 1))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(payload)
	}))
	defer server.Close()
	if _, _, err := (Client{HTTP: server.Client()}).Fetch(context.Background(), server.URL, contract.ReleaseChannel); err == nil || !strings.Contains(err.Error(), "duplicate object key") {
		t.Fatalf("duplicate manifest key was accepted: %v", err)
	}
}

func TestFetchRejectsNonCanonicalAndCaseAliasJSONKeys(t *testing.T) {
	payload, err := json.Marshal(validNamespaceHandoffManifest("http://127.0.0.1"))
	if err != nil {
		t.Fatal(err)
	}
	canonical := `"profile_id":"` + identity.TargetProfileID() + `"`
	tests := map[string]string{
		"case alias":         `"Profile_ID":"` + identity.TargetProfileID() + `"`,
		"semantic duplicate": canonical + `,"PROFILE_ID":"` + identity.TargetProfileID() + `"`,
	}
	for name, replacement := range tests {
		t.Run(name, func(t *testing.T) {
			document := []byte(strings.Replace(string(payload), canonical, replacement, 1))
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write(document)
			}))
			defer server.Close()
			if _, _, err := (Client{HTTP: server.Client()}).Fetch(context.Background(), server.URL, contract.ReleaseChannel); err == nil || !strings.Contains(err.Error(), "non-canonical object key") {
				t.Fatalf("non-canonical manifest key was accepted: %v", err)
			}
		})
	}
}

func TestFetchRejectsUnicodeCaseFoldJSONKeys(t *testing.T) {
	payload, err := json.Marshal(validManifest("http://127.0.0.1", []byte("x")))
	if err != nil {
		t.Fatal(err)
	}
	for _, replacement := range []string{"ſchema_verſion", "ſource_commit"} {
		t.Run(replacement, func(t *testing.T) {
			canonical := "schema_version"
			if strings.Contains(replacement, "ource") {
				canonical = "source_commit"
			}
			document := []byte(strings.Replace(string(payload), `"`+canonical+`"`, `"`+replacement+`"`, 1))
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write(document)
			}))
			defer server.Close()
			if _, _, err := (Client{HTTP: server.Client()}).Fetch(context.Background(), server.URL, contract.ReleaseChannel); err == nil || !strings.Contains(err.Error(), "must use ASCII") {
				t.Fatalf("Unicode case-fold key was accepted: %v", err)
			}
		})
	}
}

func TestArtifactURLPolicyUsesParsedLoopbackIdentity(t *testing.T) {
	digest := strings.Repeat("a", 64)
	accepted := []string{
		"https://releases.example/artifact",
		"http://127.0.0.1:8080/artifact",
		"http://[::1]:8080/artifact",
	}
	for _, rawURL := range accepted {
		if err := (Artifact{URL: rawURL, SHA256: digest}).Validate(); err != nil {
			t.Fatalf("valid artifact URL %q rejected: %v", rawURL, err)
		}
	}
	rejected := []string{
		"http://127.0.0.1.evil.example/artifact",
		"http://localhost/artifact",
		"http://[::1].evil.example/artifact",
		"https://user:password@releases.example/artifact",
		"ftp://127.0.0.1/artifact",
	}
	for _, rawURL := range rejected {
		if err := (Artifact{URL: rawURL, SHA256: digest}).Validate(); err == nil {
			t.Fatalf("unsafe artifact URL %q accepted", rawURL)
		}
	}
}

func TestFetchArtifactRejectsRedirectToNonLoopbackHTTP(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		http.Redirect(w, request, "http://127.0.0.1.evil.example/artifact", http.StatusFound)
	}))
	defer server.Close()
	artifact := Artifact{URL: server.URL, SHA256: strings.Repeat("a", 64)}
	_, err := (Client{HTTP: server.Client()}).FetchArtifact(context.Background(), artifact, 1024)
	if err == nil || !strings.Contains(err.Error(), "redirect") {
		t.Fatalf("unsafe redirect was not rejected: %v", err)
	}
	if IsTemporarilyUnavailable(err) {
		t.Fatalf("unsafe redirect was classified as retryable: %v", err)
	}
}

func TestNamespaceHandoffValidationFailsClosed(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Manifest)
	}{
		{
			name: "unsupported schema",
			mutate: func(manifest *Manifest) {
				manifest.NamespaceHandoff.SchemaVersion++
			},
		},
		{
			name: "invalid predecessor generation",
			mutate: func(manifest *Manifest) {
				manifest.NamespaceHandoff.PredecessorGeneration = "short"
			},
		},
		{
			name: "bridge generation differs from source commit",
			mutate: func(manifest *Manifest) {
				manifest.NamespaceHandoff.BridgeGeneration = strings.Repeat("c", 40)
			},
		},
		{
			name: "predecessor equals bridge",
			mutate: func(manifest *Manifest) {
				manifest.NamespaceHandoff.PredecessorGeneration = manifest.SourceCommit
			},
		},
		{
			name: "source and target profiles are equal",
			mutate: func(manifest *Manifest) {
				manifest.NamespaceHandoff.Source.ProfileID = identity.TargetProfileID()
			},
		},
		{
			name: "unexpected target profile",
			mutate: func(manifest *Manifest) {
				manifest.NamespaceHandoff.Target.ProfileID = "other-platform-v1"
			},
		},
		{
			name: "source manager version differs from predecessor",
			mutate: func(manifest *Manifest) {
				manifest.NamespaceHandoff.Source.Manager.Version = strings.Repeat("d", 40)
			},
		},
		{
			name: "target and top-level manager version differ from bridge",
			mutate: func(manifest *Manifest) {
				version := strings.Repeat("d", 40)
				manifest.Manager.Version = version
				manifest.NamespaceHandoff.Target.Manager.Version = version
			},
		},
		{
			name: "source manager architecture missing",
			mutate: func(manifest *Manifest) {
				delete(manifest.NamespaceHandoff.Source.Manager.Artifacts, "arm64")
			},
		},
		{
			name: "source manager architecture added",
			mutate: func(manifest *Manifest) {
				manifest.NamespaceHandoff.Source.Manager.Artifacts["s390x"] = testArtifact("http://127.0.0.1", "source-manager-s390x")
			},
		},
		{
			name: "source artifact uses noncanonical digest",
			mutate: func(manifest *Manifest) {
				artifact := manifest.NamespaceHandoff.Source.Manager.Artifacts["amd64"]
				artifact.SHA256 = strings.ToUpper(artifact.SHA256)
				manifest.NamespaceHandoff.Source.Manager.Artifacts["amd64"] = artifact
			},
		},
		{
			name: "source compose incomplete",
			mutate: func(manifest *Manifest) {
				manifest.NamespaceHandoff.Source.Compose = Artifact{}
			},
		},
		{
			name: "target manager differs from top level",
			mutate: func(manifest *Manifest) {
				manifest.NamespaceHandoff.Target.Manager.Version = "different"
			},
		},
		{
			name: "target compose differs from top level",
			mutate: func(manifest *Manifest) {
				manifest.NamespaceHandoff.Target.Compose = testArtifact("http://127.0.0.1", "different-target-compose")
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			manifest := validNamespaceHandoffManifest("http://127.0.0.1")
			test.mutate(&manifest)
			if err := manifest.Validate(contract.ReleaseChannel, runtime.GOOS, runtime.GOARCH); err == nil {
				t.Fatal("invalid namespace handoff descriptor was accepted")
			}
		})
	}
}

func TestFetchRejectsIncompleteNullAndUnknownNamespaceHandoffFields(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{
			name: "null descriptor",
			mutate: func(document map[string]any) {
				document["namespace_handoff"] = nil
			},
		},
		{
			name: "missing target binding",
			mutate: func(document map[string]any) {
				delete(document["namespace_handoff"].(map[string]any), "target")
			},
		},
		{
			name: "unknown descriptor field",
			mutate: func(document map[string]any) {
				document["namespace_handoff"].(map[string]any)["unexpected"] = true
			},
		},
		{
			name: "unknown binding field",
			mutate: func(document map[string]any) {
				handoff := document["namespace_handoff"].(map[string]any)
				handoff["source"].(map[string]any)["unexpected"] = true
			},
		},
		{
			name: "unknown manager field",
			mutate: func(document map[string]any) {
				handoff := document["namespace_handoff"].(map[string]any)
				target := handoff["target"].(map[string]any)
				target["manager"].(map[string]any)["unexpected"] = true
			},
		},
		{
			name: "unknown artifact field",
			mutate: func(document map[string]any) {
				handoff := document["namespace_handoff"].(map[string]any)
				source := handoff["source"].(map[string]any)
				source["compose"].(map[string]any)["unexpected"] = true
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			document := manifestDocument(t, validNamespaceHandoffManifest("http://127.0.0.1"))
			test.mutate(document)
			if _, err := fetchManifestDocument(t, document); err == nil {
				t.Fatal("malformed namespace handoff descriptor was accepted")
			}
		})
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
