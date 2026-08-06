package maintenance

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/releasetest"
)

type recordingImagePruner struct {
	candidates  []string
	protected   map[string]struct{}
	disposition map[string]bool
}

func (p *recordingImagePruner) PruneManagedImages(_ context.Context, candidates []string, protected map[string]struct{}, _ RemovalGuard) (map[string]bool, error) {
	p.candidates = append([]string(nil), candidates...)
	p.protected = cloneStringSet(protected)
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

func TestPruneReleasesUsesCompileTimeTargetProfileByDefault(t *testing.T) {
	root := t.TempDir()
	now := time.Unix(20_000, 0).UTC()
	id := strings.Repeat("d", 40)
	path := writeReleaseWithSchema(t, root, id, now.Add(-2*time.Hour), "d", release.ManifestSchemaVersion)
	pruner := &recordingImagePruner{}
	removed, err := PruneReleases(context.Background(), now, ReleasePolicy{
		Root: root, Channel: "main", Retention: time.Hour, Images: pruner,
		RemovalGuard: acceptingRemovalGuard(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 || len(pruner.candidates) != 10 {
		t.Fatalf("maintenance did not consume exact current set: removed=%d images=%#v", removed, pruner.candidates)
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("current release remains: %v", err)
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

func TestPruneReleasesCleansAgedAtomicResidueBeforeStrictImageAndReleasePrune(t *testing.T) {
	root := t.TempDir()
	now := time.Now().UTC().Truncate(time.Second)
	id := strings.Repeat("1", 40)
	path := writeRelease(t, root, id, now.Add(-2*time.Hour), "1")
	for _, name := range []string{".tmp-100", ".tmp-101", ".tmp-102", ".tmp-103", ".tmp-1234567890"} {
		residue := filepath.Join(path, name)
		if err := os.WriteFile(residue, []byte("crash-left compose environment"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(residue, now.Add(-2*time.Hour), now.Add(-2*time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	guardCalls := 0
	guard := RemovalGuard(func() (func(), bool) {
		guardCalls++
		return func() {}, true
	})
	pruner := &recordingImagePruner{}

	removed, err := PruneReleases(context.Background(), now, ReleasePolicy{
		Root: root, Channel: "main", Retention: time.Hour, Images: pruner, RemovalGuard: guard,
	})
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("removed releases = %d, want the cleaned release removed in the same pass", removed)
	}
	if guardCalls < 2 {
		t.Fatalf("maintenance admission calls = %d, want atomic cleanup and destructive prune admission", guardCalls)
	}
	if len(pruner.candidates) == 0 {
		t.Fatal("strict verification after atomic cleanup did not admit managed image pruning")
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("cleaned obsolete release remains: %v", err)
	}
}

func TestPruneReleasesRetainsFreshAtomicResidueAndBlocksImages(t *testing.T) {
	root := t.TempDir()
	now := time.Now().UTC().Truncate(time.Second)
	id := strings.Repeat("2", 40)
	path := writeRelease(t, root, id, now.Add(-2*time.Hour), "2")
	residue := filepath.Join(path, ".tmp-123")
	if err := os.WriteFile(residue, []byte("active-or-recent writer evidence"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(residue, now.Add(-30*time.Minute), now.Add(-30*time.Minute)); err != nil {
		t.Fatal(err)
	}
	pruner := &recordingImagePruner{}

	removed, err := PruneReleases(context.Background(), now, ReleasePolicy{
		Root: root, Channel: "main", Retention: time.Hour, Images: pruner,
		RemovalGuard: acceptingRemovalGuard(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if removed != 0 || len(pruner.candidates) != 0 {
		t.Fatalf("fresh residue crossed strict boundary: removed=%d images=%#v", removed, pruner.candidates)
	}
	if content, err := os.ReadFile(residue); err != nil || string(content) != "active-or-recent writer evidence" {
		t.Fatalf("fresh residue changed: %q %v", content, err)
	}
}

func TestPruneReleasesProtectsFreshResidueImageSharedWithObsoleteRelease(t *testing.T) {
	root := t.TempDir()
	now := time.Now().UTC().Truncate(time.Second)
	sharedDigest := "7"
	blockedID := strings.Repeat("2", 40)
	blockedPath := writeRelease(t, root, blockedID, now.Add(-2*time.Hour), sharedDigest)
	obsoleteID := strings.Repeat("3", 40)
	obsoletePath := writeRelease(t, root, obsoleteID, now.Add(-2*time.Hour), sharedDigest)
	residue := filepath.Join(blockedPath, ".tmp-123")
	if err := os.WriteFile(residue, []byte("recent writer evidence"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(residue, now.Add(-30*time.Minute), now.Add(-30*time.Minute)); err != nil {
		t.Fatal(err)
	}
	pruner := &recordingImagePruner{}

	removed, err := PruneReleases(context.Background(), now, ReleasePolicy{
		Root: root, Channel: "main", Retention: time.Hour, Images: pruner,
		RemovalGuard: acceptingRemovalGuard(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("removed releases = %d, want only the unobstructed release removed", removed)
	}
	if _, err := os.Lstat(blockedPath); err != nil {
		t.Fatalf("release with fresh residue was removed: %v", err)
	}
	if _, err := os.Lstat(obsoletePath); !os.IsNotExist(err) {
		t.Fatalf("unobstructed obsolete release remains: %v", err)
	}
	if len(pruner.candidates) == 0 {
		t.Fatal("unobstructed release did not submit its shared images")
	}
	for _, image := range pruner.candidates {
		if _, protected := pruner.protected[image]; !protected {
			t.Fatalf("fresh-residue release did not protect shared image %q: %#v", image, pruner.protected)
		}
	}
	if _, err := os.Lstat(residue); err != nil {
		t.Fatalf("fresh residue changed: %v", err)
	}
}

func TestPruneReleasesCancellationPreservesEarlierCleanupError(t *testing.T) {
	root := t.TempDir()
	now := time.Now().UTC().Truncate(time.Second)
	unsafeID := strings.Repeat("1", 40)
	unsafePath := writeRelease(t, root, unsafeID, now.Add(-2*time.Hour), "1")
	unsafeResidue := filepath.Join(unsafePath, ".tmp-attacker")
	if err := os.WriteFile(unsafeResidue, []byte("retain"), 0o600); err != nil {
		t.Fatal(err)
	}
	writeRelease(t, root, strings.Repeat("2", 40), now.Add(-2*time.Hour), "2")
	ctx, cancel := context.WithCancel(context.Background())
	guard := RemovalGuard(func() (func(), bool) {
		cancel()
		return func() {}, true
	})

	removed, err := PruneReleases(ctx, now, ReleasePolicy{
		Root: root, Channel: "main", Retention: time.Hour, Images: &recordingImagePruner{}, RemovalGuard: guard,
	})
	if removed != 0 {
		t.Fatalf("removed releases = %d, want none after cancellation", removed)
	}
	if !errors.Is(err, context.Canceled) || !strings.Contains(err.Error(), "unknown atomic temporary") {
		t.Fatalf("cleanup error = %v, want cancellation joined with prior safety error", err)
	}
	if _, statErr := os.Lstat(unsafeResidue); statErr != nil {
		t.Fatalf("unsafe residue changed: %v", statErr)
	}
}

func TestPruneReleasesAtomicResidueRequiresMaintenanceAdmission(t *testing.T) {
	root := t.TempDir()
	now := time.Now().UTC().Truncate(time.Second)
	id := strings.Repeat("3", 40)
	path := writeRelease(t, root, id, now.Add(-2*time.Hour), "3")
	residue := filepath.Join(path, ".tmp-123")
	if err := os.WriteFile(residue, []byte("retain"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(residue, now.Add(-2*time.Hour), now.Add(-2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	pruner := &recordingImagePruner{}

	removed, err := PruneReleases(context.Background(), now, ReleasePolicy{
		Root: root, Channel: "main", Retention: time.Hour, Images: pruner,
		RemovalGuard: func() (func(), bool) { return func() {}, false },
	})
	if err != nil {
		t.Fatal(err)
	}
	if removed != 0 || len(pruner.candidates) != 0 {
		t.Fatalf("unadmitted residue crossed strict boundary: removed=%d images=%#v", removed, pruner.candidates)
	}
	if _, err := os.Lstat(residue); err != nil {
		t.Fatalf("unadmitted residue changed: %v", err)
	}
}

func TestPruneReleasesDoesNotCleanProtectedGenerationResidue(t *testing.T) {
	root := t.TempDir()
	now := time.Now().UTC().Truncate(time.Second)
	id := strings.Repeat("6", 40)
	path := writeRelease(t, root, id, now.Add(-2*time.Hour), "6")
	residue := filepath.Join(path, ".tmp-123")
	if err := os.WriteFile(residue, []byte("protected"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(residue, now.Add(-2*time.Hour), now.Add(-2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	guardCalls := 0
	pruner := &recordingImagePruner{}

	removed, err := PruneReleases(context.Background(), now, ReleasePolicy{
		Root: root, Channel: "main", Retention: time.Hour,
		ProtectedIDs: map[string]struct{}{id: {}}, Images: pruner,
		RemovalGuard: func() (func(), bool) {
			guardCalls++
			return func() {}, true
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if removed != 0 || len(pruner.candidates) != 0 || guardCalls != 0 {
		t.Fatalf("protected release entered cleanup: removed=%d images=%#v guards=%d", removed, pruner.candidates, guardCalls)
	}
	if content, err := os.ReadFile(residue); err != nil || string(content) != "protected" {
		t.Fatalf("protected atomic residue changed: %q %v", content, err)
	}
}

func TestPruneReleasesRejectsAtomicLookalikeAndHardLinkEvidence(t *testing.T) {
	for _, test := range []struct {
		name   string
		create func(*testing.T, string)
		want   string
	}{
		{
			name: "lookalike",
			create: func(t *testing.T, path string) {
				if err := os.WriteFile(filepath.Join(path, ".tmp-attacker"), []byte("retain"), 0o600); err != nil {
					t.Fatal(err)
				}
			},
			want: "unknown atomic temporary",
		},
		{
			name: "hard link",
			create: func(t *testing.T, path string) {
				residue := filepath.Join(path, ".tmp-123")
				if err := os.WriteFile(residue, []byte("retain"), 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.Link(residue, filepath.Join(path, "linked-evidence")); err != nil {
					t.Fatal(err)
				}
			},
			want: "multiple hard links",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			now := time.Now().UTC().Truncate(time.Second)
			id := strings.Repeat("4", 40)
			path := writeRelease(t, root, id, now.Add(-2*time.Hour), "4")
			test.create(t, path)
			for _, entry := range mustReadDirectory(t, path) {
				if strings.HasPrefix(entry.Name(), ".tmp-") {
					old := now.Add(-2 * time.Hour)
					if err := os.Chtimes(filepath.Join(path, entry.Name()), old, old); err != nil {
						t.Fatal(err)
					}
				}
			}
			pruner := &recordingImagePruner{}

			removed, err := PruneReleases(context.Background(), now, ReleasePolicy{
				Root: root, Channel: "main", Retention: time.Hour, Images: pruner,
				RemovalGuard: acceptingRemovalGuard(),
			})
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("cleanup error = %v, want %q", err, test.want)
			}
			if removed != 0 || len(pruner.candidates) != 0 {
				t.Fatalf("unsafe evidence crossed strict boundary: removed=%d images=%#v", removed, pruner.candidates)
			}
			if _, err := os.Lstat(path); err != nil {
				t.Fatalf("release with unsafe evidence changed: %v", err)
			}
		})
	}
}

func TestPruneReleasesRejectsDirectorySwapBeforeAtomicCleanup(t *testing.T) {
	root := t.TempDir()
	now := time.Now().UTC().Truncate(time.Second)
	id := strings.Repeat("5", 40)
	path := writeRelease(t, root, id, now.Add(-2*time.Hour), "5")
	originalResidue := filepath.Join(path, ".tmp-123")
	if err := os.WriteFile(originalResidue, []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(originalResidue, now.Add(-2*time.Hour), now.Add(-2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	moved := filepath.Join(root, "moved-release")
	replacementResidue := filepath.Join(path, ".tmp-456")
	guard := RemovalGuard(func() (func(), bool) {
		if err := os.Rename(path, moved); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(path, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(replacementResidue, []byte("replacement"), 0o600); err != nil {
			t.Fatal(err)
		}
		return func() {}, true
	})
	pruner := &recordingImagePruner{}

	removed, err := PruneReleases(context.Background(), now, ReleasePolicy{
		Root: root, Channel: "main", Retention: time.Hour, Images: pruner, RemovalGuard: guard,
	})
	if err == nil || !strings.Contains(err.Error(), "directory changed before admission") {
		t.Fatalf("cleanup error = %v, want directory identity rejection", err)
	}
	if removed != 0 || len(pruner.candidates) != 0 {
		t.Fatalf("directory swap crossed strict boundary: removed=%d images=%#v", removed, pruner.candidates)
	}
	for _, residue := range []string{filepath.Join(moved, ".tmp-123"), replacementResidue} {
		if _, err := os.Lstat(residue); err != nil {
			t.Fatalf("directory-swap evidence %s changed: %v", residue, err)
		}
	}
}

func TestPruneReleasesRetainsGenerationWhenAnyImageCannotBeRemoved(t *testing.T) {
	root := t.TempDir()
	now := time.Unix(20_000, 0).UTC()
	path := writeRelease(t, root, strings.Repeat("e", 40), now.Add(-2*time.Hour), "e")
	verified, err := verifyRelease(path, strings.Repeat("e", 40), "main", identity.CompileTimeActiveProfile())
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
	return writeReleaseWithSchema(t, root, id, generatedAt, digestDigit, release.ManifestSchemaVersion)
}

func writeReleaseWithSchema(t *testing.T, root, id string, generatedAt time.Time, digestDigit string, schemaVersion int) string {
	t.Helper()
	compose := []byte("services: {}\n")
	options := []releasetest.Option{
		releasetest.WithGeneratedAt(generatedAt),
		releasetest.WithCompose(compose),
		releasetest.WithImageDigest(strings.Repeat(digestDigit, 64)),
	}
	manifest := releasetest.NewTarget(id, options...).Manifest
	manifest.SchemaVersion = schemaVersion
	manifest.ProtocolVersion = schemaVersion
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
	if err := os.WriteFile(filepath.Join(path, "compose.env"), []byte("AGENT_PLATFORM_UID=1000\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func acceptingRemovalGuard() RemovalGuard {
	return func() (func(), bool) { return func() {}, true }
}

func mustReadDirectory(t *testing.T, path string) []os.DirEntry {
	t.Helper()
	entries, err := os.ReadDir(path)
	if err != nil {
		t.Fatal(err)
	}
	return entries
}
