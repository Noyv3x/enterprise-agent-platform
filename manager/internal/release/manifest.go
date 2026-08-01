package release

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	pathpkg "path"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

const maxManifestBytes = 1 << 20

var errReleaseURLPolicy = errors.New("URL must use https or loopback http")

var commitPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)
var digestPattern = regexp.MustCompile(`^[^@[:space:]]+@sha256:[0-9a-f]{64}$`)
var imageNamePattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
var sha256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

var canonicalManifestJSONKeys = func() map[string]string {
	keys := []string{
		"url", "sha256", "version", "artifacts", "profile_id", "manager", "compose",
		"schema_version", "predecessor_generation", "bridge_generation", "source", "target",
		"channel", "source_commit", "generated_at", "protocol_version", "database_schema_version",
		"images", "namespace_handoff",
	}
	result := make(map[string]string, len(keys))
	for _, key := range keys {
		result[strings.ToLower(key)] = key
	}
	return result
}()

const (
	// ManifestSchemaVersionV1 is the source-owner and one-time Bridge catalog
	// shape. It retains the handoff helper image and may carry the signed
	// namespace_handoff descriptor.
	ManifestSchemaVersionV1 = 1
	// ManifestSchemaVersionV2 is the target-only cleanup/baseline catalog shape.
	// It cannot carry the one-time handoff descriptor or helper image.
	ManifestSchemaVersionV2       = 2
	namespaceHandoffSchemaVersion = 1
)

var managedImageNamesV1 = []string{
	"platform", "agent-runtime", "camofox", "agent-sandbox", "searxng",
	"firecrawl-api", "firecrawl-playwright", "firecrawl-postgres",
	"firecrawl-redis", "firecrawl-rabbitmq",
	"handoff-fs-helper",
}

var managedImageNamesV2 = []string{
	"platform", "agent-runtime", "camofox", "agent-sandbox", "searxng",
	"firecrawl-api", "firecrawl-playwright", "firecrawl-postgres",
	"firecrawl-redis", "firecrawl-rabbitmq",
}

var managedImageNameSet = func() map[string]struct{} {
	result := make(map[string]struct{}, len(managedImageNamesV1))
	for _, name := range managedImageNamesV1 {
		result[name] = struct{}{}
	}
	return result
}()

// IsManagedImageName identifies every logical image name recognized by one of
// the supported release schemas. Manifest validation applies the narrower
// schema-specific closed set; this union remains useful for exact cleanup of a
// retained schema-v1 handoff helper after the target switches to schema v2.
func IsManagedImageName(name string) bool {
	_, ok := managedImageNameSet[name]
	return ok
}

// IsDigestReference reports whether value is an immutable registry reference.
// It is intentionally narrower than Docker's accepted image syntax so cleanup
// code can never act on tags, IDs, or broad repository names.
func IsDigestReference(value string) bool { return digestPattern.MatchString(value) }

// RemovalGuard holds the Manager admission boundary around one exact removal.
// Candidate discovery and checksum work must happen before acquiring it.
type RemovalGuard func() (release func(), ok bool)

type Artifact struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
}
type ManagerRelease struct {
	Version   string              `json:"version"`
	Artifacts map[string]Artifact `json:"artifacts"`
}

// NamespaceBinding binds one fixed technical identity to the immutable
// Manager and Compose artifacts needed on that side of a handoff.
type NamespaceBinding struct {
	ProfileID string         `json:"profile_id"`
	Manager   ManagerRelease `json:"manager"`
	Compose   Artifact       `json:"compose"`
}

// NamespaceHandoff is the inert, signed manifest capability for a future
// namespace handoff. Parsing it does not start or schedule a handoff.
type NamespaceHandoff struct {
	SchemaVersion         int              `json:"schema_version"`
	PredecessorGeneration string           `json:"predecessor_generation"`
	BridgeGeneration      string           `json:"bridge_generation"`
	Source                NamespaceBinding `json:"source"`
	Target                NamespaceBinding `json:"target"`
}

type Manifest struct {
	SchemaVersion         int               `json:"schema_version"`
	Channel               string            `json:"channel"`
	SourceCommit          string            `json:"source_commit"`
	GeneratedAt           time.Time         `json:"generated_at"`
	ProtocolVersion       int               `json:"protocol_version"`
	DatabaseSchemaVersion int               `json:"database_schema_version"`
	Manager               ManagerRelease    `json:"manager"`
	Compose               Artifact          `json:"compose"`
	Images                map[string]string `json:"images"`
	NamespaceHandoff      *NamespaceHandoff `json:"namespace_handoff,omitempty"`
}

func (m Manifest) ID() string { return m.SourceCommit }
func (m Manifest) Validate(channel, goos, goarch string) error {
	active, err := identity.CompileTimeActiveProfile()
	if err != nil {
		return err
	}
	return m.ValidateForProfile(channel, goos, goarch, active)
}

// ValidateForProfile applies the manifest/protocol barrier using the active
// technical identity selected by the startup Router. Schema v2 is deliberately
// unavailable to source Managers, even when every other field is well formed.
func (m Manifest) ValidateForProfile(channel, goos, goarch string, active identity.ActiveProfile) error {
	profile, err := active.Profile()
	if err != nil {
		return fmt.Errorf("validate release technical profile: %w", err)
	}
	if contract.ReleaseTransitionStage != "bridge" && m.SchemaVersion != ManifestSchemaVersionV2 {
		return fmt.Errorf("release stage %q accepts only target manifest schema 2", contract.ReleaseTransitionStage)
	}
	var managedImages []string
	switch m.SchemaVersion {
	case ManifestSchemaVersionV1:
		managedImages = managedImageNamesV1
		if m.ProtocolVersion != ManifestSchemaVersionV1 {
			return fmt.Errorf("unsupported manager protocol %d for manifest schema %d", m.ProtocolVersion, m.SchemaVersion)
		}
	case ManifestSchemaVersionV2:
		if profile.ProfileID != identity.TargetProfileID() {
			return errors.New("manifest schema 2 requires the verified target technical profile")
		}
		managedImages = managedImageNamesV2
		if m.ProtocolVersion != ManifestSchemaVersionV2 {
			return fmt.Errorf("unsupported manager protocol %d for manifest schema %d", m.ProtocolVersion, m.SchemaVersion)
		}
		if m.NamespaceHandoff != nil {
			return errors.New("manifest schema 2 must not contain namespace_handoff")
		}
	default:
		return fmt.Errorf("unsupported manifest schema %d", m.SchemaVersion)
	}
	if m.Channel != channel {
		return fmt.Errorf("manifest channel %q does not match %q", m.Channel, channel)
	}
	if !commitPattern.MatchString(m.SourceCommit) {
		return errors.New("manifest source_commit must be a full 40-character commit")
	}
	if m.DatabaseSchemaVersion < 1 {
		return errors.New("manifest database version is invalid")
	}
	if goos != "linux" {
		return fmt.Errorf("manager releases support linux, not %s", goos)
	}
	if m.GeneratedAt.IsZero() {
		return errors.New("manifest generated_at is required")
	}
	if len(m.Images) != len(managedImages) {
		return fmt.Errorf("manifest schema %d images must contain exactly %d managed entries", m.SchemaVersion, len(managedImages))
	}
	managedImageSet := make(map[string]struct{}, len(managedImages))
	for _, name := range managedImages {
		managedImageSet[name] = struct{}{}
		digest, ok := m.Images[name]
		if !ok || !digestPattern.MatchString(digest) {
			return fmt.Errorf("image %q must use a complete registry sha256 digest", name)
		}
	}
	for name, digest := range m.Images {
		if _, ok := managedImageSet[name]; !ok {
			return fmt.Errorf("image %q is outside manifest schema %d managed release set", name, m.SchemaVersion)
		}
		if !imageNamePattern.MatchString(name) {
			return fmt.Errorf("image name %q must use lowercase kebab-case", name)
		}
		if !digestPattern.MatchString(digest) {
			return fmt.Errorf("image %q has invalid digest", name)
		}
	}
	if m.Manager.Version == "" {
		return errors.New("manager version is required")
	}
	if m.SchemaVersion == ManifestSchemaVersionV2 {
		if err := m.validateTargetArtifactCatalog(); err != nil {
			return err
		}
	}
	artifact, ok := m.Manager.Artifacts[goarch]
	if !ok {
		return fmt.Errorf("manager artifact for %s is missing", goarch)
	}
	if err := artifact.Validate(); err != nil {
		return fmt.Errorf("manager artifact for %s: %w", goarch, err)
	}
	if err := m.Compose.Validate(); err != nil {
		return fmt.Errorf("compose artifact: %w", err)
	}
	if m.NamespaceHandoff != nil {
		if err := m.NamespaceHandoff.Validate(m); err != nil {
			return fmt.Errorf("namespace_handoff: %w", err)
		}
	}
	return nil
}

func (m Manifest) validateTargetArtifactCatalog() error {
	if m.Manager.Version != m.SourceCommit {
		return errors.New("target manager version must match manifest source_commit")
	}
	if len(m.Manager.Artifacts) != 2 {
		return errors.New("target manager artifacts must contain exactly amd64 and arm64")
	}
	for _, arch := range []string{"amd64", "arm64"} {
		artifact, ok := m.Manager.Artifacts[arch]
		if !ok {
			return fmt.Errorf("target manager artifact for %s is missing", arch)
		}
		if err := validateTargetArtifact(artifact, "agent-platform-manager-linux-"+arch); err != nil {
			return fmt.Errorf("target manager artifact for %s: %w", arch, err)
		}
	}
	if err := validateTargetArtifact(m.Compose, "agent-platform-compose.yaml"); err != nil {
		return fmt.Errorf("target compose artifact: %w", err)
	}
	return nil
}

func validateTargetArtifact(artifact Artifact, expectedBase string) error {
	if err := artifact.Validate(); err != nil {
		return err
	}
	parsed, err := url.Parse(artifact.URL)
	if err != nil {
		return errReleaseURLPolicy
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("URL must not contain a query or fragment")
	}
	if pathpkg.Base(parsed.EscapedPath()) != expectedBase {
		return fmt.Errorf("URL basename must be %q", expectedBase)
	}
	return nil
}

func (h NamespaceHandoff) Validate(manifest Manifest) error {
	if h.SchemaVersion != namespaceHandoffSchemaVersion {
		return fmt.Errorf("unsupported schema %d", h.SchemaVersion)
	}
	if !commitPattern.MatchString(h.PredecessorGeneration) {
		return errors.New("predecessor_generation must be a full 40-character commit")
	}
	if !commitPattern.MatchString(h.BridgeGeneration) {
		return errors.New("bridge_generation must be a full 40-character commit")
	}
	if h.BridgeGeneration != manifest.SourceCommit {
		return errors.New("bridge_generation must match manifest source_commit")
	}
	if h.PredecessorGeneration == h.BridgeGeneration {
		return errors.New("predecessor_generation and bridge_generation must differ")
	}
	if h.Source.ProfileID == h.Target.ProfileID {
		return errors.New("source and target profile_id must differ")
	}
	sourceProfileID := identity.SourceProfile().ProfileID
	targetProfileID := identity.TargetProfileID()
	if h.Source.ProfileID != sourceProfileID {
		return fmt.Errorf("source profile_id must be %q", sourceProfileID)
	}
	if h.Target.ProfileID != targetProfileID {
		return fmt.Errorf("target profile_id must be %q", targetProfileID)
	}
	if h.Source.Manager.Version != h.PredecessorGeneration {
		return errors.New("source manager version must match predecessor_generation")
	}
	if h.Target.Manager.Version != h.BridgeGeneration {
		return errors.New("target manager version must match bridge_generation")
	}
	if err := h.Source.validate("source"); err != nil {
		return err
	}
	if err := h.Target.validate("target"); err != nil {
		return err
	}
	if !managerReleasesEqual(h.Target.Manager, manifest.Manager) {
		return errors.New("target manager must exactly match the top-level manager")
	}
	if h.Target.Compose != manifest.Compose {
		return errors.New("target compose must exactly match the top-level compose")
	}
	return nil
}

func (b NamespaceBinding) validate(name string) error {
	if strings.TrimSpace(b.Manager.Version) == "" {
		return fmt.Errorf("%s manager version is required", name)
	}
	if len(b.Manager.Artifacts) != 2 {
		return fmt.Errorf("%s manager artifacts must contain exactly amd64 and arm64", name)
	}
	for _, arch := range []string{"amd64", "arm64"} {
		artifact, ok := b.Manager.Artifacts[arch]
		if !ok {
			return fmt.Errorf("%s manager artifact for %s is missing", name, arch)
		}
		if err := validateBoundArtifact(artifact); err != nil {
			return fmt.Errorf("%s manager artifact for %s: %w", name, arch, err)
		}
	}
	if err := validateBoundArtifact(b.Compose); err != nil {
		return fmt.Errorf("%s compose artifact: %w", name, err)
	}
	return nil
}

func validateBoundArtifact(artifact Artifact) error {
	if err := artifact.Validate(); err != nil {
		return err
	}
	if !sha256Pattern.MatchString(artifact.SHA256) {
		return errors.New("sha256 must use 64 lowercase hexadecimal characters")
	}
	return nil
}

func managerReleasesEqual(left, right ManagerRelease) bool {
	if left.Version != right.Version || len(left.Artifacts) != len(right.Artifacts) {
		return false
	}
	for arch, artifact := range left.Artifacts {
		if candidate, ok := right.Artifacts[arch]; !ok || candidate != artifact {
			return false
		}
	}
	return true
}

func (a Artifact) Validate() error {
	if err := validateReleaseURL(a.URL); err != nil {
		return err
	}
	if !sha256Pattern.MatchString(a.SHA256) {
		return errors.New("sha256 must use 64 lowercase hexadecimal characters")
	}
	return nil
}

func validateReleaseURL(rawURL string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Host == "" || parsed.User != nil {
		return errReleaseURLPolicy
	}
	switch parsed.Scheme {
	case "https":
		return nil
	case "http":
		if hostname := parsed.Hostname(); hostname == "127.0.0.1" || hostname == "::1" {
			return nil
		}
	}
	return errReleaseURLPolicy
}
func (m Manifest) Digest() (string, error) {
	data, err := json.Marshal(m)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

type Client struct{ HTTP *http.Client }

// AvailabilityError identifies a valid release location that cannot be read
// yet. Callers may safely retry these failures, unlike schema, digest, size, or
// transport-policy validation failures.
type AvailabilityError struct{ Err error }

func (e *AvailabilityError) Error() string { return e.Err.Error() }
func (e *AvailabilityError) Unwrap() error { return e.Err }

func IsTemporarilyUnavailable(err error) bool {
	var unavailable *AvailabilityError
	return errors.As(err, &unavailable)
}

func (c Client) Fetch(ctx context.Context, url, channel string) (Manifest, []byte, error) {
	active, err := identity.CompileTimeActiveProfile()
	if err != nil {
		return Manifest{}, nil, err
	}
	return c.FetchForProfile(ctx, url, channel, active)
}

// FetchForProfile downloads and validates a catalog for the already-routed
// technical profile. Callers must never derive active from manifest contents.
func (c Client) FetchForProfile(ctx context.Context, url, channel string, active identity.ActiveProfile) (Manifest, []byte, error) {
	data, err := c.fetch(ctx, url, maxManifestBytes)
	if err != nil {
		return Manifest{}, nil, err
	}
	manifest, err := DecodeManifestForProfile(data, channel, runtime.GOOS, runtime.GOARCH, active)
	if err != nil {
		return Manifest{}, nil, err
	}
	return manifest, data, nil
}

// DecodeManifest applies the same closed-world parser and cross-field
// validation as Client.Fetch to already retained immutable bytes. The handoff
// helper uses it after the source Manager has stopped; it must never reinterpret
// a journal-bound manifest through a weaker decoder.
func DecodeManifest(data []byte, channel, goos, goarch string) (Manifest, error) {
	active, err := identity.CompileTimeActiveProfile()
	if err != nil {
		return Manifest{}, err
	}
	return DecodeManifestForProfile(data, channel, goos, goarch, active)
}

// DecodeManifestForProfile applies the same target-only schema barrier to
// retained immutable bytes as FetchForProfile applies to a remote catalog.
func DecodeManifestForProfile(data []byte, channel, goos, goarch string, active identity.ActiveProfile) (Manifest, error) {
	manifest, err := decodeManifestDocument(data)
	if err != nil {
		return Manifest{}, err
	}
	if err := manifest.ValidateForProfile(channel, goos, goarch, active); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

func decodeManifestDocument(data []byte) (Manifest, error) {
	if len(data) == 0 || len(data) > maxManifestBytes {
		return Manifest{}, errors.New("release manifest has an invalid size")
	}
	if err := rejectDuplicateJSONKeys(data); err != nil {
		return Manifest{}, fmt.Errorf("decode release manifest: %w", err)
	}
	var manifest Manifest
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return Manifest{}, fmt.Errorf("decode release manifest: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return Manifest{}, errors.New("decode release manifest: trailing JSON value")
		}
		return Manifest{}, fmt.Errorf("decode release manifest: %w", err)
	}
	var envelope struct {
		NamespaceHandoff json.RawMessage `json:"namespace_handoff"`
	}
	if err := json.Unmarshal(data, &envelope); err == nil {
		if envelope.NamespaceHandoff != nil && strings.TrimSpace(string(envelope.NamespaceHandoff)) == "null" {
			return Manifest{}, errors.New("decode release manifest: namespace_handoff must not be null")
		}
	}
	return manifest, nil
}

func rejectDuplicateJSONKeys(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	var visit func() error
	visit = func() error {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		delimiter, ok := token.(json.Delim)
		if !ok {
			return nil
		}
		switch delimiter {
		case '{':
			seen := map[string]struct{}{}
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return err
				}
				key, ok := keyToken.(string)
				if !ok {
					return errors.New("object key is not a string")
				}
				for _, character := range key {
					if character > 0x7f {
						return fmt.Errorf("object key %q must use ASCII", key)
					}
				}
				if canonical, known := canonicalManifestJSONKeys[strings.ToLower(key)]; known && key != canonical {
					return fmt.Errorf("non-canonical object key %q; use %q", key, canonical)
				}
				if _, exists := seen[key]; exists {
					return fmt.Errorf("duplicate object key %q", key)
				}
				seen[key] = struct{}{}
				if err := visit(); err != nil {
					return err
				}
			}
			closing, err := decoder.Token()
			if err != nil || closing != json.Delim('}') {
				return errors.New("object is not terminated")
			}
		case '[':
			for decoder.More() {
				if err := visit(); err != nil {
					return err
				}
			}
			closing, err := decoder.Token()
			if err != nil || closing != json.Delim(']') {
				return errors.New("array is not terminated")
			}
		default:
			return errors.New("unexpected JSON delimiter")
		}
		return nil
	}
	if err := visit(); err != nil {
		return err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("trailing JSON value")
		}
		return err
	}
	return nil
}

func (c Client) FetchArtifact(ctx context.Context, artifact Artifact, maxBytes int64) ([]byte, error) {
	if err := artifact.Validate(); err != nil {
		return nil, err
	}
	data, err := c.fetch(ctx, artifact.URL, maxBytes)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(data)
	if !strings.EqualFold(hex.EncodeToString(sum[:]), artifact.SHA256) {
		return nil, errors.New("artifact checksum mismatch")
	}
	return data, nil
}
func (c Client) fetch(ctx context.Context, rawURL string, limit int64) ([]byte, error) {
	if err := validateReleaseURL(rawURL); err != nil {
		return nil, fmt.Errorf("release URL policy: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	clientCopy := *client
	previousRedirectPolicy := client.CheckRedirect
	clientCopy.CheckRedirect = func(request *http.Request, via []*http.Request) error {
		if err := validateReleaseURL(request.URL.String()); err != nil {
			return fmt.Errorf("release redirect policy: %w", err)
		}
		if previousRedirectPolicy != nil {
			return previousRedirectPolicy(request, via)
		}
		return nil
	}
	response, err := clientCopy.Do(request)
	if err != nil {
		if errors.Is(err, errReleaseURLPolicy) {
			return nil, err
		}
		return nil, &AvailabilityError{Err: fmt.Errorf("fetch release artifact: %w", err)}
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		failure := fmt.Errorf("fetch release artifact: HTTP %d", response.StatusCode)
		if response.StatusCode == http.StatusNotFound || response.StatusCode == http.StatusRequestTimeout || response.StatusCode == http.StatusTooEarly || response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500 {
			return nil, &AvailabilityError{Err: failure}
		}
		return nil, failure
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, &AvailabilityError{Err: fmt.Errorf("read release artifact: %w", err)}
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("release artifact exceeds %d bytes", limit)
	}
	return data, nil
}
