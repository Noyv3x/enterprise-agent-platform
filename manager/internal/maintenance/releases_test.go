package maintenance

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/contract"
	"github.com/ubitech/agent-platform/manager/internal/release"
)

type recordingImagePruner struct {
	candidates  []string
	disposition map[string]bool
}

func (p *recordingImagePruner) PruneManagedImages(_ context.Context, candidates []string, protected map[string]struct{}, _ RemovalGuard) (map[string]bool, error) {
	p.candidates = append([]string(nil), candidates...)
	result := make(map[string]bool, len(candidates))
	for _, candidate := range candidates {
		if p.disposition != nil {
			result[candidate] = p.disposition[candidate]
		} else {
			result[candidate] = true
		}
		if _, keep := protected[candidate]; keep {
			result[candidate] = true
		}
	}
	return result, nil
}

func TestPruneReleasesRemovesOnlyExpiredVerifiedUnprotectedGeneration(t *testing.T) {
	root := t.TempDir()
	now := time.Unix(20_000, 0).UTC()
	oldID := strings.Repeat("a", 40)
	protectedID := strings.Repeat("b", 40)
	recentID := strings.Repeat("c", 40)
	old := writeRelease(t, root, oldID, now.Add(-2*time.Hour), "a")
	protected := writeRelease(t, root, protectedID, now.Add(-2*time.Hour), "b")
	recent := writeRelease(t, root, recentID, now.Add(-30*time.Minute), "c")
	pruner := &recordingImagePruner{}

	removed, err := PruneReleases(context.Background(), now, ReleasePolicy{
		Root: root, Channel: "main", Retention: time.Hour,
		ProtectedIDs: map[string]struct{}{protectedID: {}}, Images: pruner,
	})
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("removed releases = %d, want 1", removed)
	}
	if _, err := os.Lstat(old); !os.IsNotExist(err) {
		t.Fatalf("expired release remains: %v", err)
	}
	for _, path := range []string{protected, recent} {
		if _, err := os.Lstat(path); err != nil {
			t.Fatalf("retained release %s is unavailable: %v", path, err)
		}
	}
	if len(pruner.candidates) == 0 || !sort.StringsAreSorted(pruner.candidates) {
		t.Fatalf("image cleanup candidates are missing or unstable: %#v", pruner.candidates)
	}
}

func TestPruneReleasesRetainsUnknownDirectoryContent(t *testing.T) {
	root := t.TempDir()
	now := time.Unix(20_000, 0).UTC()
	path := writeRelease(t, root, strings.Repeat("d", 40), now.Add(-2*time.Hour), "d")
	if err := os.WriteFile(filepath.Join(path, "operator-note.txt"), []byte("retain"), 0o600); err != nil {
		t.Fatal(err)
	}
	pruner := &recordingImagePruner{}

	removed, err := PruneReleases(context.Background(), now, ReleasePolicy{Root: root, Channel: "main", Retention: time.Hour, Images: pruner})
	if err != nil {
		t.Fatal(err)
	}
	if removed != 0 || len(pruner.candidates) != 0 {
		t.Fatalf("unknown release content crossed cleanup boundary: removed=%d images=%#v", removed, pruner.candidates)
	}
	if content, err := os.ReadFile(filepath.Join(path, "operator-note.txt")); err != nil || string(content) != "retain" {
		t.Fatalf("unknown release evidence changed: %q %v", content, err)
	}
}

func TestPruneReleasesRetainsGenerationWhenAnyImageCannotBeRemoved(t *testing.T) {
	root := t.TempDir()
	now := time.Unix(20_000, 0).UTC()
	path := writeRelease(t, root, strings.Repeat("e", 40), now.Add(-2*time.Hour), "e")
	verified, err := verifyRelease(path, strings.Repeat("e", 40), "main")
	if err != nil {
		t.Fatal(err)
	}
	disposition := make(map[string]bool, len(verified.images))
	for _, image := range verified.images {
		disposition[image] = true
	}
	disposition[verified.images[0]] = false
	pruner := &recordingImagePruner{disposition: disposition}

	removed, err := PruneReleases(context.Background(), now, ReleasePolicy{Root: root, Channel: "main", Retention: time.Hour, Images: pruner})
	if err != nil {
		t.Fatal(err)
	}
	if removed != 0 {
		t.Fatalf("release with an image consumer was removed: %d", removed)
	}
	if _, err := os.Lstat(path); err != nil {
		t.Fatalf("release with an image consumer was not retained: %v", err)
	}
}

func TestPruneReleasesAbortsWhenAdmissionEpochChanges(t *testing.T) {
	root := t.TempDir()
	now := time.Unix(20_000, 0).UTC()
	path := writeRelease(t, root, strings.Repeat("f", 40), now.Add(-2*time.Hour), "f")
	guardCalls := 0
	guard := RemovalGuard(func() (func(), bool) {
		guardCalls++
		return func() {}, false
	})
	removed, err := PruneReleases(context.Background(), now, ReleasePolicy{
		Root: root, Channel: "main", Retention: time.Hour,
		Images: &recordingImagePruner{}, RemovalGuard: guard,
	})
	if err != nil {
		t.Fatal(err)
	}
	if removed != 0 || guardCalls == 0 {
		t.Fatalf("epoch change removal/guards = %d/%d, want 0/>0", removed, guardCalls)
	}
	if _, err := os.Lstat(path); err != nil {
		t.Fatalf("generation changed after guard refusal: %v", err)
	}
}

func TestPruneReleasesRemovesOnlyRecognizedExpiredStaging(t *testing.T) {
	root := t.TempDir()
	now := time.Unix(20_000, 0).UTC()
	old := filepath.Join(root, ".release-"+strings.Repeat("a", 40)+"-123456789")
	unknown := filepath.Join(root, ".release-"+strings.Repeat("b", 40)+"-987654321")
	for _, path := range []string{old, unknown} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(old, "manifest.json"), []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(unknown, "operator-note.txt"), []byte("retain"), 0o600); err != nil {
		t.Fatal(err)
	}
	oldTime := now.Add(-2 * time.Hour)
	for _, path := range []string{old, unknown} {
		if err := os.Chtimes(path, oldTime, oldTime); err != nil {
			t.Fatal(err)
		}
	}

	removed, err := PruneReleases(context.Background(), now, ReleasePolicy{Root: root, Channel: "main", Retention: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("removed staging directories = %d, want 1", removed)
	}
	if _, err := os.Lstat(old); !os.IsNotExist(err) {
		t.Fatalf("recognized abandoned staging remains: %v", err)
	}
	if content, err := os.ReadFile(filepath.Join(unknown, "operator-note.txt")); err != nil || string(content) != "retain" {
		t.Fatalf("unknown staging evidence changed: %q %v", content, err)
	}
}

func writeRelease(t *testing.T, root, id string, generatedAt time.Time, digestDigit string) string {
	t.Helper()
	compose := []byte("services: {}\n")
	composeDigest := sha256.Sum256(compose)
	images := map[string]string{}
	for _, name := range []string{
		"platform", "agent-runtime", "camofox", "agent-sandbox", "searxng",
		"firecrawl-api", "firecrawl-playwright", "firecrawl-postgres",
		"firecrawl-redis", "firecrawl-rabbitmq",
	} {
		images[name] = "registry.example/" + name + "@sha256:" + strings.Repeat(digestDigit, 64)
	}
	manifest := release.Manifest{
		SchemaVersion:         contract.SchemaVersion,
		Channel:               "main",
		SourceCommit:          id,
		GeneratedAt:           generatedAt,
		ProtocolVersion:       contract.SchemaVersion,
		DatabaseSchemaVersion: 1,
		Manager: release.ManagerRelease{Version: id, Artifacts: map[string]release.Artifact{
			runtime.GOARCH: {URL: "https://example.invalid/manager", SHA256: strings.Repeat("f", 64)},
		}},
		Compose: release.Artifact{URL: "https://example.invalid/compose", SHA256: hex.EncodeToString(composeDigest[:])},
		Images:  images,
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, id)
	if err := os.MkdirAll(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "manifest.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "compose.yaml"), compose, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "compose.env"), []byte("UBITECH_UID=1000\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
