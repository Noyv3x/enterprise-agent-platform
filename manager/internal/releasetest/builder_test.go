package releasetest

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

func TestTargetFixtureUsesCanonicalTargetCatalogAndExactBytes(t *testing.T) {
	generation := strings.Repeat("a", 40)
	compose := []byte("services:\n  platform: {}\n")
	manager := []byte("exact target Manager\n")
	fixture := NewTarget(
		generation,
		WithCompose(compose),
		WithManagerBinary("amd64", manager),
	)
	manifest := fixture.Manifest
	if manifest.SchemaVersion != release.ManifestSchemaVersionV2 ||
		manifest.ProtocolVersion != release.ManifestSchemaVersionV2 ||
		manifest.Channel != contract.ReleaseChannel ||
		manifest.DatabaseSchemaVersion != contract.DatabaseSchemaVersion ||
		manifest.SourceCommit != generation || len(manifest.Images) != 10 ||
		manifest.NamespaceHandoff != nil {
		t.Fatalf("target fixture drifted from canonical contract: %#v", manifest)
	}
	wantCompose := sha256.Sum256(compose)
	wantManager := sha256.Sum256(manager)
	if manifest.Compose.SHA256 != hex.EncodeToString(wantCompose[:]) ||
		manifest.Manager.Artifacts["amd64"].SHA256 != hex.EncodeToString(wantManager[:]) ||
		!strings.HasSuffix(manifest.Compose.URL, "/agent-platform-compose.yaml") ||
		!strings.HasSuffix(manifest.Manager.Artifacts["arm64"].URL, "/agent-platform-manager-linux-arm64") {
		t.Fatalf("target fixture artifacts do not bind their exact bytes: %#v", manifest)
	}
	target, err := identity.ActivateVerifiedHandoffTarget(identity.TargetProfile())
	if err != nil {
		t.Fatal(err)
	}
	if err := manifest.ValidateForProfile(contract.ReleaseChannel, "linux", "amd64", target); err != nil {
		t.Fatal(err)
	}
}

func TestBridgeFixtureUsesCanonicalTransitionBindings(t *testing.T) {
	generation := strings.Repeat("b", 40)
	fixture := NewBridge(generation, WithArtifactBaseURL("https://release.example/current/"))
	manifest := fixture.Manifest
	if manifest.SchemaVersion != release.ManifestSchemaVersionV1 || len(manifest.Images) != 11 || manifest.NamespaceHandoff == nil {
		t.Fatalf("Bridge fixture is incomplete: %#v", manifest)
	}
	handoff := manifest.NamespaceHandoff
	if handoff.PredecessorGeneration != contract.ReleaseTransitionPredecessorGeneration ||
		handoff.BridgeGeneration != generation ||
		handoff.Source.ProfileID != contract.ReleaseTransitionSourceProfileID ||
		handoff.Target.ProfileID != contract.ReleaseTransitionTargetProfileID ||
		handoff.Target.Manager.Version != generation ||
		handoff.Source.Manager.Version != contract.ReleaseTransitionPredecessorGeneration {
		t.Fatalf("Bridge fixture drifted from canonical transition: %#v", handoff)
	}
	if !strings.HasPrefix(handoff.Target.Compose.URL, "https://release.example/current/") ||
		!strings.HasPrefix(handoff.Source.Compose.URL, "https://release.example/current/source/") {
		t.Fatalf("Bridge fixture did not derive the source artifact base from the release base: %#v", handoff)
	}
	if err := manifest.ValidateForProfile(contract.ReleaseChannel, "linux", "arm64", identity.SourceActiveProfile()); err != nil {
		t.Fatal(err)
	}
}

func TestSemanticOptionsRemainStrict(t *testing.T) {
	generation := strings.Repeat("c", 40)
	generatedAt := time.Date(2026, time.August, 1, 12, 0, 0, 0, time.UTC)
	digest := strings.Repeat("d", 64)
	fixture := NewSource(
		generation,
		WithGeneratedAt(generatedAt),
		WithDatabaseSchemaVersion(7),
		WithManagerVersion("candidate"),
		WithImageDigest(digest),
	)
	if fixture.Manifest.GeneratedAt != generatedAt || fixture.Manifest.DatabaseSchemaVersion != 7 || fixture.Manifest.Manager.Version != "candidate" {
		t.Fatalf("semantic options were not retained: %#v", fixture.Manifest)
	}
	for name, image := range fixture.Manifest.Images {
		if !strings.HasSuffix(image, "@sha256:"+digest) {
			t.Fatalf("image %s does not use the requested shared digest: %s", name, image)
		}
	}
}
