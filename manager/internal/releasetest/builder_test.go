package releasetest

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

func TestTargetFixtureUsesCanonicalCatalogAndExactBytes(t *testing.T) {
	generation := strings.Repeat("a", 40)
	compose := []byte("services:\n  platform: {}\n")
	manager := []byte("exact target Manager\n")
	fixture := NewTarget(
		generation,
		WithCompose(compose),
		WithManagerBinary("amd64", manager),
	)
	manifest := fixture.Manifest
	if manifest.SchemaVersion != release.ManifestSchemaVersion ||
		manifest.ProtocolVersion != release.ManifestSchemaVersion ||
		manifest.Channel != contract.ReleaseChannel ||
		manifest.DatabaseSchemaVersion != contract.DatabaseSchemaVersion ||
		manifest.SourceCommit != generation || len(manifest.Images) != 10 {
		t.Fatalf("fixture drifted from canonical contract: %#v", manifest)
	}
	wantCompose := sha256.Sum256(compose)
	wantManager := sha256.Sum256(manager)
	if manifest.Compose.SHA256 != hex.EncodeToString(wantCompose[:]) ||
		manifest.Manager.Artifacts["amd64"].SHA256 != hex.EncodeToString(wantManager[:]) ||
		!strings.HasSuffix(manifest.Compose.URL, "/agent-platform-compose.yaml") ||
		!strings.HasSuffix(manifest.Manager.Artifacts["arm64"].URL, "/agent-platform-manager-linux-arm64") {
		t.Fatalf("fixture artifacts do not bind their exact bytes: %#v", manifest)
	}
}

func TestSemanticOptionsRemainStrict(t *testing.T) {
	generation := strings.Repeat("c", 40)
	generatedAt := time.Date(2026, time.August, 1, 12, 0, 0, 0, time.UTC)
	digest := strings.Repeat("d", 64)
	fixture := NewTarget(
		generation,
		WithGeneratedAt(generatedAt),
		WithDatabaseSchemaVersion(7),
		WithImageDigest(digest),
	)
	if fixture.Manifest.GeneratedAt != generatedAt || fixture.Manifest.DatabaseSchemaVersion != 7 || fixture.Manifest.Manager.Version != generation {
		t.Fatalf("semantic options were not retained: %#v", fixture.Manifest)
	}
	for name, image := range fixture.Manifest.Images {
		if !strings.HasSuffix(image, "@sha256:"+digest) {
			t.Fatalf("image %s does not use the requested shared digest: %s", name, image)
		}
	}
}
