// Package releasetest builds closed, valid release fixtures for Manager tests.
//
// The builders intentionally expose only semantic test inputs. Decoder and
// validation negative tests must keep using explicit structs or raw JSON so a
// malformed value cannot be repaired while the fixture is assembled.
package releasetest

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

const (
	defaultArtifactBaseURL = "https://example.invalid/releases/test"
	defaultRegistry        = "registry.example"
)

var defaultGeneratedAt = time.Unix(1, 0).UTC()

// Fixture binds a valid manifest to the exact bytes named by its checksums.
// Source* fields are populated only for a schema-1 Bridge fixture.
type Fixture struct {
	Manifest              release.Manifest
	Compose               []byte
	ManagerBinaries       map[string][]byte
	SourceCompose         []byte
	SourceManagerBinaries map[string][]byte
}

type config struct {
	generatedAt           time.Time
	artifactBaseURL       string
	sourceArtifactBaseURL string
	databaseSchema        int
	managerVersion        string
	managerBinaries       map[string][]byte
	sourceManagerBinaries map[string][]byte
	compose               []byte
	sourceCompose         []byte
	imageDigest           string
	predecessor           string
}

// Option changes one meaningful property while the builder retains every
// other canonical release field.
type Option func(*config)

func WithGeneratedAt(value time.Time) Option {
	return func(cfg *config) { cfg.generatedAt = value }
}

func WithArtifactBaseURL(value string) Option {
	return func(cfg *config) { cfg.artifactBaseURL = strings.TrimRight(value, "/") }
}

func WithSourceArtifactBaseURL(value string) Option {
	return func(cfg *config) { cfg.sourceArtifactBaseURL = strings.TrimRight(value, "/") }
}

func WithDatabaseSchemaVersion(value int) Option {
	return func(cfg *config) { cfg.databaseSchema = value }
}

func WithManagerVersion(value string) Option {
	return func(cfg *config) { cfg.managerVersion = value }
}

func WithManagerBinary(architecture string, value []byte) Option {
	return func(cfg *config) {
		cfg.managerBinaries[architecture] = append([]byte(nil), value...)
	}
}

func WithSourceManagerBinary(architecture string, value []byte) Option {
	return func(cfg *config) {
		cfg.sourceManagerBinaries[architecture] = append([]byte(nil), value...)
	}
}

func WithCompose(value []byte) Option {
	return func(cfg *config) { cfg.compose = append([]byte(nil), value...) }
}

func WithSourceCompose(value []byte) Option {
	return func(cfg *config) { cfg.sourceCompose = append([]byte(nil), value...) }
}

// WithImageDigest sets the lowercase hexadecimal digest used by every managed
// image. It is useful when a cleanup test needs generations to share images.
func WithImageDigest(value string) Option {
	return func(cfg *config) { cfg.imageDigest = value }
}

func WithPredecessorGeneration(value string) Option {
	return func(cfg *config) { cfg.predecessor = value }
}

// NewTarget returns a schema-2 target-only fixture.
func NewTarget(generation string, options ...Option) Fixture {
	cfg := newConfig(generation, options...)
	fixture := targetFixture(generation, cfg, "agent-platform")
	target, err := identity.ActivateVerifiedHandoffTarget(identity.TargetProfile())
	if err != nil {
		panic(fmt.Sprintf("construct target release fixture profile: %v", err))
	}
	mustValidate(fixture.Manifest, target)
	return fixture
}

// NewSource returns the valid schema-1 catalog used by positive source-side
// tests that do not exercise the one-time namespace handoff capability.
func NewSource(generation string, options ...Option) Fixture {
	cfg := newConfig(generation, options...)
	fixture := sourceFixture(generation, cfg)
	mustValidate(fixture.Manifest, identity.SourceActiveProfile())
	return fixture
}

// NewBridge returns the schema-1 Bridge catalog and its complete namespace
// handoff descriptor. The predecessor and profile identities default to the
// current generated release-transition contract.
func NewBridge(generation string, options ...Option) Fixture {
	cfg := newConfig(generation, options...)
	target := targetFixture(generation, cfg, "ubitech")
	source := sourceBinding(cfg.predecessor, cfg)
	targetBinding := release.NamespaceBinding{
		ProfileID: contract.ReleaseTransitionTargetProfileID,
		Manager:   cloneManager(target.Manifest.Manager),
		Compose:   target.Manifest.Compose,
	}
	target.Manifest.SchemaVersion = release.ManifestSchemaVersionV1
	target.Manifest.ProtocolVersion = release.ManifestSchemaVersionV1
	target.Manifest.Images = managedImages(true, cfg.imageDigest)
	target.Manifest.NamespaceHandoff = &release.NamespaceHandoff{
		SchemaVersion:         1,
		PredecessorGeneration: cfg.predecessor,
		BridgeGeneration:      generation,
		Source:                source,
		Target:                targetBinding,
	}
	target.SourceCompose = append([]byte(nil), cfg.sourceCompose...)
	target.SourceManagerBinaries = cloneBytesMap(cfg.sourceManagerBinaries)
	mustValidate(target.Manifest, identity.SourceActiveProfile())
	return target
}

func newConfig(generation string, options ...Option) config {
	if !isCommit(generation) {
		panic("release fixture generation must be a lowercase 40-character commit")
	}
	cfg := config{
		generatedAt:     defaultGeneratedAt,
		artifactBaseURL: defaultArtifactBaseURL,
		databaseSchema:  contract.DatabaseSchemaVersion,
		managerVersion:  generation,
		managerBinaries: map[string][]byte{
			"amd64": []byte("manager-amd64\n"),
			"arm64": []byte("manager-arm64\n"),
		},
		sourceManagerBinaries: map[string][]byte{
			"amd64": []byte("source-manager-amd64\n"),
			"arm64": []byte("source-manager-arm64\n"),
		},
		compose:       []byte("services: {}\n"),
		sourceCompose: []byte("services: {}\n"),
		predecessor:   contract.ReleaseTransitionPredecessorGeneration,
	}
	for _, option := range options {
		if option == nil {
			panic("release fixture option must not be nil")
		}
		option(&cfg)
	}
	if cfg.generatedAt.IsZero() || cfg.databaseSchema < 1 || cfg.artifactBaseURL == "" {
		panic("release fixture semantic options are incomplete")
	}
	if cfg.sourceArtifactBaseURL == "" {
		cfg.sourceArtifactBaseURL = cfg.artifactBaseURL + "/source"
	}
	if cfg.managerVersion == "" || !isCommit(cfg.predecessor) {
		panic("release fixture version or predecessor is invalid")
	}
	for _, binaries := range []map[string][]byte{cfg.managerBinaries, cfg.sourceManagerBinaries} {
		if len(binaries) != 2 || len(binaries["amd64"]) == 0 || len(binaries["arm64"]) == 0 {
			panic("release fixture Manager binaries must contain non-empty amd64 and arm64 bytes")
		}
	}
	if len(cfg.compose) == 0 || len(cfg.sourceCompose) == 0 {
		panic("release fixture Compose bytes must not be empty")
	}
	if cfg.imageDigest != "" && !isSHA256(cfg.imageDigest) {
		panic("release fixture image digest must be 64 lowercase hexadecimal characters")
	}
	return cfg
}

func targetFixture(generation string, cfg config, assetPrefix string) Fixture {
	manager := managerRelease(
		cfg.managerVersion,
		cfg.artifactBaseURL,
		assetPrefix+"-manager-linux",
		cfg.managerBinaries,
	)
	composeName := assetPrefix + "-compose.yaml"
	fixture := Fixture{
		Compose:         append([]byte(nil), cfg.compose...),
		ManagerBinaries: cloneBytesMap(cfg.managerBinaries),
	}
	fixture.Manifest = release.Manifest{
		SchemaVersion:         release.ManifestSchemaVersionV2,
		Channel:               contract.ReleaseChannel,
		SourceCommit:          generation,
		GeneratedAt:           cfg.generatedAt.UTC(),
		ProtocolVersion:       release.ManifestSchemaVersionV2,
		DatabaseSchemaVersion: cfg.databaseSchema,
		Manager:               manager,
		Compose: release.Artifact{
			URL:    cfg.artifactBaseURL + "/" + composeName,
			SHA256: sha256Hex(cfg.compose),
		},
		Images: managedImages(false, cfg.imageDigest),
	}
	return fixture
}

func sourceFixture(generation string, cfg config) Fixture {
	fixture := Fixture{
		Compose:         append([]byte(nil), cfg.compose...),
		ManagerBinaries: cloneBytesMap(cfg.managerBinaries),
	}
	fixture.Manifest = release.Manifest{
		SchemaVersion:         release.ManifestSchemaVersionV1,
		Channel:               contract.ReleaseChannel,
		SourceCommit:          generation,
		GeneratedAt:           cfg.generatedAt.UTC(),
		ProtocolVersion:       release.ManifestSchemaVersionV1,
		DatabaseSchemaVersion: cfg.databaseSchema,
		Manager: managerRelease(
			cfg.managerVersion,
			cfg.artifactBaseURL,
			"ubitech-manager-linux",
			cfg.managerBinaries,
		),
		Compose: release.Artifact{
			URL:    cfg.artifactBaseURL + "/ubitech-compose.yaml",
			SHA256: sha256Hex(cfg.compose),
		},
		Images: managedImages(true, cfg.imageDigest),
	}
	return fixture
}

func sourceBinding(generation string, cfg config) release.NamespaceBinding {
	return release.NamespaceBinding{
		ProfileID: contract.ReleaseTransitionSourceProfileID,
		Manager: managerRelease(
			generation,
			cfg.sourceArtifactBaseURL,
			"ubitech-manager-linux",
			cfg.sourceManagerBinaries,
		),
		Compose: release.Artifact{
			URL:    cfg.sourceArtifactBaseURL + "/ubitech-compose.yaml",
			SHA256: sha256Hex(cfg.sourceCompose),
		},
	}
}

func managerRelease(version, baseURL, prefix string, binaries map[string][]byte) release.ManagerRelease {
	artifacts := make(map[string]release.Artifact, 2)
	for _, architecture := range []string{"amd64", "arm64"} {
		binary := binaries[architecture]
		artifacts[architecture] = release.Artifact{
			URL:    baseURL + "/" + prefix + "-" + architecture,
			SHA256: sha256Hex(binary),
		}
	}
	return release.ManagerRelease{Version: version, Artifacts: artifacts}
}

func managedImages(includeHandoff bool, sharedDigest string) map[string]string {
	names := make([]string, 0, len(contract.ManagedImageCapacityEstimates))
	for name := range contract.ManagedImageCapacityEstimates {
		if name == "handoff-fs-helper" && !includeHandoff {
			continue
		}
		names = append(names, name)
	}
	sort.Strings(names)
	images := make(map[string]string, len(names))
	for _, name := range names {
		digest := sharedDigest
		if digest == "" {
			digest = sha256Hex([]byte("image:" + name))
		}
		images[name] = defaultRegistry + "/" + name + "@sha256:" + digest
	}
	return images
}

func mustValidate(manifest release.Manifest, active identity.ActiveProfile) {
	for _, architecture := range []string{"amd64", "arm64"} {
		if err := manifest.ValidateForProfile(contract.ReleaseChannel, "linux", architecture, active); err != nil {
			panic(fmt.Sprintf("invalid shared release fixture for linux/%s: %v", architecture, err))
		}
	}
}

func cloneManager(value release.ManagerRelease) release.ManagerRelease {
	result := release.ManagerRelease{Version: value.Version, Artifacts: make(map[string]release.Artifact, len(value.Artifacts))}
	for architecture, artifact := range value.Artifacts {
		result.Artifacts[architecture] = artifact
	}
	return result
}

func cloneBytesMap(value map[string][]byte) map[string][]byte {
	result := make(map[string][]byte, len(value))
	for key, data := range value {
		result[key] = append([]byte(nil), data...)
	}
	return result
}

func sha256Hex(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}

func isCommit(value string) bool {
	return len(value) == 40 && isLowerHex(value)
}

func isSHA256(value string) bool {
	return len(value) == 64 && isLowerHex(value)
}

func isLowerHex(value string) bool {
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}
