//go:build linux

package handoffevidence

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const maxPlatformEvidenceBytes int64 = 256 << 10

type PlatformEvidence struct {
	SchemaVersion           int    `json:"schema_version"`
	TechnicalProfile        string `json:"technical_profile"`
	DatabaseSchemaVersion   int    `json:"database_schema_version"`
	DatabaseIntegrity       string `json:"database_integrity"`
	DatabaseForeignKeys     string `json:"database_foreign_keys"`
	PlatformReservationIdle bool   `json:"platform_reservation_idle"`
	ActiveAgentTasks        int    `json:"active_agent_tasks"`
	ActiveLearningReviews   int    `json:"active_learning_reviews"`
	QueuedAgentJobs         int    `json:"queued_agent_jobs"`
	RunningAgentJobs        int    `json:"running_agent_jobs"`
	AdmissionsInProgress    int    `json:"admissions_in_progress"`
	RuntimeSchemaReady      bool   `json:"runtime_schema_ready"`
	WorkspaceSchemaReady    bool   `json:"workspace_schema_ready"`
	CamofoxSchemaReady      bool   `json:"camofox_schema_ready"`
	RuntimeIdentitySHA256   string `json:"runtime_identity_sha256"`
	WorkspaceIdentitySHA256 string `json:"workspace_identity_sha256"`
}

func (value PlatformEvidence) idle() bool {
	return value.PlatformReservationIdle && value.ActiveAgentTasks == 0 &&
		value.ActiveLearningReviews == 0 && value.QueuedAgentJobs == 0 &&
		value.RunningAgentJobs == 0 && value.AdmissionsInProgress == 0
}

type PlatformClient struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

func (client PlatformClient) Evidence(ctx context.Context) (PlatformEvidence, error) {
	endpoint, err := client.endpoint()
	if err != nil {
		return PlatformEvidence{}, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return PlatformEvidence{}, err
	}
	request.Header.Set("Authorization", "Bearer "+client.Token)
	httpClient := client.HTTP
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 10 * time.Second}
	}
	response, err := httpClient.Do(request)
	if err != nil {
		return PlatformEvidence{}, fmt.Errorf("request Platform handoff evidence: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4<<10))
		return PlatformEvidence{}, fmt.Errorf("Platform handoff evidence returned HTTP %d", response.StatusCode)
	}
	if response.ContentLength > maxPlatformEvidenceBytes {
		return PlatformEvidence{}, errors.New("Platform handoff evidence exceeds the response limit")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxPlatformEvidenceBytes+1))
	if err != nil {
		return PlatformEvidence{}, fmt.Errorf("read Platform handoff evidence: %w", err)
	}
	if len(data) == 0 || int64(len(data)) > maxPlatformEvidenceBytes {
		return PlatformEvidence{}, errors.New("Platform handoff evidence has an invalid response size")
	}
	var value PlatformEvidence
	if err := decodeClosedJSON(data, &value); err != nil {
		return PlatformEvidence{}, fmt.Errorf("decode Platform handoff evidence: %w", err)
	}
	if err := validatePlatformEvidence(value); err != nil {
		return PlatformEvidence{}, err
	}
	return value, nil
}

// Probe performs the same authenticated, strict endpoint read used by the
// collector and returns the local completion instant for receipt ordering.
func (client PlatformClient) Probe(ctx context.Context) (time.Time, error) {
	if _, err := client.Evidence(ctx); err != nil {
		return time.Time{}, err
	}
	return time.Now().UTC(), nil
}

func (client PlatformClient) endpoint() (string, error) {
	if strings.TrimSpace(client.Token) == "" || strings.ContainsAny(client.Token, "\r\n\x00") {
		return "", errors.New("Platform handoff evidence token is invalid")
	}
	parsed, err := url.Parse(client.BaseURL)
	if err != nil || parsed.Scheme != "http" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("Platform handoff evidence URL must be a plain loopback HTTP origin")
	}
	host := parsed.Hostname()
	address := net.ParseIP(strings.Trim(host, "[]"))
	if address == nil || !address.IsLoopback() || parsed.Host == "" {
		return "", errors.New("Platform handoff evidence URL is not loopback")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/internal/manager/handoff/evidence"
	return parsed.String(), nil
}

func validatePlatformEvidence(value PlatformEvidence) error {
	if value.SchemaVersion != 1 || value.TechnicalProfile == "" || value.DatabaseSchemaVersion <= 0 ||
		value.DatabaseIntegrity != "ok" || value.DatabaseForeignKeys != "ok" ||
		!admissionSHA256.MatchString(value.RuntimeIdentitySHA256) ||
		!admissionSHA256.MatchString(value.WorkspaceIdentitySHA256) {
		return errors.New("Platform handoff evidence has an invalid identity or schema")
	}
	for _, count := range []int{
		value.ActiveAgentTasks, value.ActiveLearningReviews, value.QueuedAgentJobs,
		value.RunningAgentJobs, value.AdmissionsInProgress,
	} {
		if count < 0 {
			return errors.New("Platform handoff evidence contains a negative activity count")
		}
	}
	return nil
}

func decodeClosedJSON(data []byte, destination any) error {
	if err := rejectDuplicateJSON(data); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("JSON contains a trailing value")
		}
		return err
	}
	return nil
}

func rejectDuplicateJSON(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	var walk func() error
	walk = func() error {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		delimiter, compound := token.(json.Delim)
		if !compound {
			return nil
		}
		switch delimiter {
		case '{':
			keys := map[string]struct{}{}
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return err
				}
				key, ok := keyToken.(string)
				if !ok {
					return errors.New("JSON object key is invalid")
				}
				if _, exists := keys[key]; exists {
					return fmt.Errorf("duplicate JSON object key %q", key)
				}
				keys[key] = struct{}{}
				if err := walk(); err != nil {
					return err
				}
			}
			end, err := decoder.Token()
			if err != nil || end != json.Delim('}') {
				return errors.New("JSON object is unterminated")
			}
		case '[':
			for decoder.More() {
				if err := walk(); err != nil {
					return err
				}
			}
			end, err := decoder.Token()
			if err != nil || end != json.Delim(']') {
				return errors.New("JSON array is unterminated")
			}
		default:
			return errors.New("JSON delimiter is invalid")
		}
		return nil
	}
	if err := walk(); err != nil {
		return err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("JSON contains a trailing value")
		}
		return err
	}
	return nil
}
