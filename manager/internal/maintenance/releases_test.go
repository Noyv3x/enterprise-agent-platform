package maintenance

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/releasetest"
)

func TestPruneReleasesRetainsCommittedPairAndUnknownArtifacts(t *testing.T) {
	root := t.TempDir()
	current, previous, obsolete, damaged, unknown := strings.Repeat("a", 40), strings.Repeat("b", 40), strings.Repeat("c", 40), strings.Repeat("d", 40), strings.Repeat("e", 40)
	for _, id := range []string{current, previous, obsolete, damaged, unknown} {
		writeRelease(t, root, id)
	}
	if err := os.WriteFile(filepath.Join(root, damaged, "compose.yaml"), []byte("corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, unknown, "operator-note"), []byte("retain"), 0o600); err != nil {
		t.Fatal(err)
	}
	removed, err := PruneReleases(context.Background(), ReleasePolicy{Root: root, Channel: "main", CurrentID: current, PreviousID: previous})
	if err != nil || removed != 1 {
		t.Fatalf("retention = %d, %v; want one obsolete release removed", removed, err)
	}
	if _, err := os.Lstat(filepath.Join(root, obsolete)); !os.IsNotExist(err) {
		t.Fatalf("obsolete release remains: %v", err)
	}
	for _, id := range []string{current, previous, damaged, unknown} {
		if _, err := os.Lstat(filepath.Join(root, id, "manifest.json")); err != nil {
			t.Fatalf("retained release %s changed: %v", id, err)
		}
	}
}

func TestPruneReleasesRequiresVerifiedCommittedPair(t *testing.T) {
	for _, corrupt := range []string{"current", "previous", "missing-current"} {
		t.Run(corrupt, func(t *testing.T) {
			root := t.TempDir()
			current, previous, obsolete := strings.Repeat("a", 40), strings.Repeat("b", 40), strings.Repeat("c", 40)
			for _, id := range []string{current, previous, obsolete} {
				writeRelease(t, root, id)
			}
			id := current
			if corrupt == "previous" {
				id = previous
			}
			if err := os.WriteFile(filepath.Join(root, id, "compose.yaml"), []byte("corrupt"), 0o600); err != nil {
				t.Fatal(err)
			}
			if corrupt == "missing-current" {
				current = ""
			}
			removed, err := PruneReleases(context.Background(), ReleasePolicy{Root: root, Channel: "main", CurrentID: current, PreviousID: previous})
			if err == nil || removed != 0 {
				t.Fatalf("unverified retention = %d, %v", removed, err)
			}
			if _, err := os.Lstat(filepath.Join(root, obsolete, "manifest.json")); err != nil {
				t.Fatalf("obsolete evidence removed before verifying retained pair: %v", err)
			}
		})
	}
}

func writeRelease(t *testing.T, root, id string) {
	t.Helper()
	compose := []byte("services: {}\n")
	manifest := releasetest.NewTarget(id, releasetest.WithCompose(compose)).Manifest
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, id)
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string][]byte{"manifest.json": data, "compose.yaml": compose} {
		if err := os.WriteFile(filepath.Join(path, name), content, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}
