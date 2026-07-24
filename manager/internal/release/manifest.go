package release

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/contract"
)

const maxManifestBytes = 1 << 20

var commitPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)
var digestPattern = regexp.MustCompile(`^[^@[:space:]]+@sha256:[0-9a-f]{64}$`)

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
	if m.SchemaVersion != contract.SchemaVersion {
		return fmt.Errorf("unsupported manifest schema %d", m.SchemaVersion)
	}
	if m.Channel != channel {
		return fmt.Errorf("manifest channel %q does not match %q", m.Channel, channel)
	}
	if !commitPattern.MatchString(m.SourceCommit) {
		return errors.New("manifest source_commit must be a full 40-character commit")
	}
	if m.ProtocolVersion != contract.SchemaVersion {
		return fmt.Errorf("unsupported manager protocol %d", m.ProtocolVersion)
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
	required := []string{"platform", "agent-runtime", "camofox", "agent-sandbox", "searxng", "firecrawl-api", "firecrawl-playwright", "firecrawl-postgres", "firecrawl-redis", "firecrawl-rabbitmq", "firecrawl-foundationdb"}
	for _, name := range required {
		digest, ok := m.Images[name]
		if !ok || !digestPattern.MatchString(digest) {
			return fmt.Errorf("image %q must use a complete registry sha256 digest", name)
		}
	}
	for name, digest := range m.Images {
		if name == "" || !digestPattern.MatchString(digest) {
			return fmt.Errorf("image %q has invalid digest", name)
		}
	}
	if m.Manager.Version == "" {
		return errors.New("manager version is required")
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
func (a Artifact) Validate() error {
	if !strings.HasPrefix(a.URL, "https://") && !strings.HasPrefix(a.URL, "http://127.0.0.1") && !strings.HasPrefix(a.URL, "http://[::1]") {
		return errors.New("URL must use https or loopback http")
	}
	if len(a.SHA256) != 64 {
		return errors.New("sha256 must contain 64 hexadecimal characters")
	}
	if _, err := hex.DecodeString(a.SHA256); err != nil {
		return errors.New("sha256 is not hexadecimal")
	}
	return nil
}
func (m Manifest) CanonicalImages() []string {
	names := make([]string, 0, len(m.Images))
	for name := range m.Images {
		names = append(names, name)
	}
	sort.Strings(names)
	result := make([]string, 0, len(names))
	for _, name := range names {
		result = append(result, m.Images[name])
	}
	return result
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
	data, err := c.fetch(ctx, url, maxManifestBytes)
	if err != nil {
		return Manifest{}, nil, err
	}
	var manifest Manifest
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return Manifest{}, nil, fmt.Errorf("decode release manifest: %w", err)
	}
	if err := manifest.Validate(channel, runtime.GOOS, runtime.GOARCH); err != nil {
		return Manifest{}, nil, err
	}
	return manifest, data, nil
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
func (c Client) fetch(ctx context.Context, url string, limit int64) ([]byte, error) {
	if !strings.HasPrefix(url, "https://") && !strings.HasPrefix(url, "http://127.0.0.1") && !strings.HasPrefix(url, "http://[::1]") {
		return nil, errors.New("release URL must use https (or loopback http)")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	response, err := client.Do(request)
	if err != nil {
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
