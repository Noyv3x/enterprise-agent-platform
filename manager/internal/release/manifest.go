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
		"url", "sha256", "version", "artifacts", "manager", "compose", "schema_version",
		"channel", "source_commit", "generated_at", "protocol_version", "database_schema_version",
		"images",
	}
	result := make(map[string]string, len(keys))
	for _, key := range keys {
		result[strings.ToLower(key)] = key
	}
	return result
}()

const ManifestSchemaVersion = 2

var managedImageNames = []string{
	"platform", "agent-runtime", "camofox", "agent-sandbox", "searxng",
	"firecrawl-api", "firecrawl-playwright", "firecrawl-postgres",
	"firecrawl-redis", "firecrawl-rabbitmq",
}

var managedImageNameSet = func() map[string]struct{} {
	result := make(map[string]struct{}, len(managedImageNames))
	for _, name := range managedImageNames {
		result[name] = struct{}{}
	}
	return result
}()

// IsManagedImageName identifies every logical image in the current release
// schema. Cleanup uses the same closed set as manifest validation.
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
}

func (m Manifest) ID() string { return m.SourceCommit }
func (m Manifest) Validate(channel, goos, goarch string) error {
	return m.ValidateForProfile(channel, goos, goarch, identity.CompileTimeActiveProfile())
}

// ValidateForProfile applies the target-only manifest/protocol barrier using
// the compile-time technical identity supplied by the caller.
func (m Manifest) ValidateForProfile(channel, goos, goarch string, active identity.ActiveProfile) error {
	profile, err := active.Profile()
	if err != nil {
		return fmt.Errorf("validate release technical profile: %w", err)
	}
	if profile.ProfileID != identity.TargetProfileID() {
		return errors.New("release manifest requires the target technical profile")
	}
	if m.SchemaVersion != ManifestSchemaVersion {
		return fmt.Errorf("unsupported manifest schema %d", m.SchemaVersion)
	}
	if m.ProtocolVersion != ManifestSchemaVersion {
		return fmt.Errorf("unsupported manager protocol %d for manifest schema %d", m.ProtocolVersion, m.SchemaVersion)
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
	if len(m.Images) != len(managedImageNames) {
		return fmt.Errorf("manifest schema %d images must contain exactly %d managed entries", m.SchemaVersion, len(managedImageNames))
	}
	for _, name := range managedImageNames {
		digest, ok := m.Images[name]
		if !ok || !digestPattern.MatchString(digest) {
			return fmt.Errorf("image %q must use a complete registry sha256 digest", name)
		}
	}
	for name, digest := range m.Images {
		if _, ok := managedImageNameSet[name]; !ok {
			return fmt.Errorf("image %q is outside the managed release set", name)
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
	if err := m.validateTargetArtifactCatalog(); err != nil {
		return err
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
	return c.FetchForProfile(ctx, url, channel, identity.CompileTimeActiveProfile())
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
// validation as Client.Fetch to retained immutable bytes.
func DecodeManifest(data []byte, channel, goos, goarch string) (Manifest, error) {
	return DecodeManifestForProfile(data, channel, goos, goarch, identity.CompileTimeActiveProfile())
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
