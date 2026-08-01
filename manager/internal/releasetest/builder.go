// Package releasetest builds closed, valid release fixtures for Manager tests.
//
// The builder exposes only semantic test inputs. Decoder and validation
// negative tests use explicit structs or raw JSON so malformed values cannot be
// repaired while a fixture is assembled.
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
type Fixture struct {
	Manifest        release.Manifest
	Compose         []byte
	ManagerBinaries map[string][]byte
}

type config struct {
	generatedAt     time.Time
	artifactBaseURL string
	databaseSchema  int
	managerBinaries map[string][]byte
	compose         []byte
	imageDigest     string
}

// Option changes one meaningful property while retaining every other
// canonical release field.
type Option func(*config)

func WithGeneratedAt(value time.Time) Option {
	return func(cfg *config) { cfg.generatedAt = value }
}

func WithArtifactBaseURL(value string) Option {
	return func(cfg *config) { cfg.artifactBaseURL = strings.TrimRight(value, "/") }
}

func WithDatabaseSchemaVersion(value int) Option {
	return func(cfg *config) { cfg.databaseSchema = value }
}

func WithManagerBinary(architecture string, value []byte) Option {
	return func(cfg *config) {
		cfg.managerBinaries[architecture] = append([]byte(nil), value...)
	}
}

func WithCompose(value []byte) Option {
	return func(cfg *config) { cfg.compose = append([]byte(nil), value...) }
}

// WithImageDigest sets the lowercase hexadecimal digest used by every managed
// image. It is useful when a cleanup test needs generations to share images.
func WithImageDigest(value string) Option {
	return func(cfg *config) { cfg.imageDigest = value }
}

// NewTarget returns a valid current-baseline fixture.
func NewTarget(generation string, options ...Option) Fixture {
	cfg := newConfig(generation, options...)
	fixture := targetFixture(generation, cfg)
	mustValidate(fixture.Manifest)
	return fixture
}

func newConfig(generation string, options ...Option) config {
	if !isCommit(generation) {
		panic("release fixture generation must be a lowercase 40-character commit")
	}
	cfg := config{
		generatedAt:     defaultGeneratedAt,
		artifactBaseURL: defaultArtifactBaseURL,
		databaseSchema:  contract.DatabaseSchemaVersion,
		managerBinaries: map[string][]byte{
			"amd64": []byte("manager-amd64\n"),
			"arm64": []byte("manager-arm64\n"),
		},
		compose: []byte("services: {}\n"),
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
	if len(cfg.managerBinaries) != 2 || len(cfg.managerBinaries["amd64"]) == 0 || len(cfg.managerBinaries["arm64"]) == 0 {
		panic("release fixture Manager binaries must contain non-empty amd64 and arm64 bytes")
	}
	if len(cfg.compose) == 0 {
		panic("release fixture Compose bytes must not be empty")
	}
	if cfg.imageDigest != "" && !isSHA256(cfg.imageDigest) {
		panic("release fixture image digest must be 64 lowercase hexadecimal characters")
	}
	return cfg
}

func targetFixture(generation string, cfg config) Fixture {
	manager := managerRelease(generation, cfg.artifactBaseURL, cfg.managerBinaries)
	fixture := Fixture{
		Compose:         append([]byte(nil), cfg.compose...),
		ManagerBinaries: cloneBytesMap(cfg.managerBinaries),
	}
	fixture.Manifest = release.Manifest{
		SchemaVersion:         release.ManifestSchemaVersion,
		Channel:               contract.ReleaseChannel,
		SourceCommit:          generation,
		GeneratedAt:           cfg.generatedAt.UTC(),
		ProtocolVersion:       release.ManifestSchemaVersion,
		DatabaseSchemaVersion: cfg.databaseSchema,
		Manager:               manager,
		Compose: release.Artifact{
			URL:    cfg.artifactBaseURL + "/agent-platform-compose.yaml",
			SHA256: sha256Hex(cfg.compose),
		},
		Images: managedImages(cfg.imageDigest),
	}
	return fixture
}

func managerRelease(version, baseURL string, binaries map[string][]byte) release.ManagerRelease {
	artifacts := make(map[string]release.Artifact, 2)
	for _, architecture := range []string{"amd64", "arm64"} {
		binary := binaries[architecture]
		artifacts[architecture] = release.Artifact{
			URL:    baseURL + "/agent-platform-manager-linux-" + architecture,
			SHA256: sha256Hex(binary),
		}
	}
	return release.ManagerRelease{Version: version, Artifacts: artifacts}
}

func managedImages(sharedDigest string) map[string]string {
	names := make([]string, 0, len(contract.ManagedImageCapacityEstimates))
	for name := range contract.ManagedImageCapacityEstimates {
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

func mustValidate(manifest release.Manifest) {
	active := identity.CompileTimeActiveProfile()
	for _, architecture := range []string{"amd64", "arm64"} {
		if err := manifest.ValidateForProfile(contract.ReleaseChannel, "linux", architecture, active); err != nil {
			panic(fmt.Sprintf("invalid shared release fixture for linux/%s: %v", architecture, err))
		}
	}
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
