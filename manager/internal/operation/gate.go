package operation

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
)

const (
	targetHandoffSchemaVersion = 1
	targetHandoffResponseLimit = 64 << 10
)

var (
	targetHandoffOperationPattern  = regexp.MustCompile(`^handoff_[0-9a-f]{32}$`)
	targetHandoffGenerationPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)
	targetHandoffSHA256Pattern     = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

type Reservation struct {
	Ready             bool   `json:"ready"`
	Reserved          bool   `json:"reserved"`
	Reason            string `json:"reason,omitempty"`
	RetryAfterSeconds int    `json:"retry_after_seconds,omitempty"`
}
type Gate interface {
	Reserve(context.Context, string) (Reservation, error)
	// Commit releases admission and commits generation-owned machine schemas.
	// It is only callable after the Manager watchdog is durably committed.
	Commit(context.Context, string) error
	// Release aborts/cancels a reservation without committing machine schemas.
	Release(context.Context, string) error
	Health(context.Context) error
}

type HTTPStatusError struct {
	StatusCode int
	Body       string
}

func (e *HTTPStatusError) Error() string {
	return fmt.Sprintf("platform gate HTTP %d: %s", e.StatusCode, e.Body)
}

// isDefinitiveAuthenticationRejection identifies a response which proves that
// the Platform rejected the request before its authenticated reservation
// handler ran. Callers must still release on transport errors and on failures
// after any successful reservation response, because those cases can leave an
// admission reservation behind even when the Manager did not receive it.
func isDefinitiveAuthenticationRejection(err error) bool {
	var statusErr *HTTPStatusError
	return errors.As(err, &statusErr) && statusErr.StatusCode == http.StatusUnauthorized
}

type HTTPGate struct {
	BaseURL, Token string
	Client         *http.Client
}

// TargetHandoffCommitRequest is the exact journal identity authorized to make
// the target Platform's machine schemas irreversible.
type TargetHandoffCommitRequest struct {
	OperationID      string `json:"operation_id"`
	TargetGeneration string `json:"target_generation"`
	BindingSHA256    string `json:"binding_sha256"`
}

// TargetHandoffCommitReceipt is persisted by Platform before it reopens
// admission. ReceiptSHA256 covers the other fields in canonical key order.
type TargetHandoffCommitReceipt struct {
	SchemaVersion         int    `json:"schema_version"`
	OperationID           string `json:"operation_id"`
	TargetGeneration      string `json:"target_generation"`
	BindingSHA256         string `json:"binding_sha256"`
	DatabaseSchemaVersion int    `json:"database_schema_version"`
	CommittedAt           string `json:"committed_at"`
	ReceiptSHA256         string `json:"receipt_sha256"`
}

type targetHandoffCommitResponse struct {
	Released bool                       `json:"released"`
	Receipt  TargetHandoffCommitReceipt `json:"receipt"`
}

type retainedPredecessorReleaseResponse struct {
	Released bool `json:"released"`
}

// TargetHandoffReservationObservation is a read-only reconciliation view. A
// receipt can coexist with a reservation only in the crash window after the
// durable receipt and before admission release.
type TargetHandoffReservationObservation struct {
	SchemaVersion    int                         `json:"schema_version"`
	Reserved         bool                        `json:"reserved"`
	ReservationID    string                      `json:"reservation_id"`
	ReservationOwner string                      `json:"reservation_owner"`
	Receipt          *TargetHandoffCommitReceipt `json:"receipt"`
}

type targetHandoffReceiptMaterial struct {
	BindingSHA256         string `json:"binding_sha256"`
	CommittedAt           string `json:"committed_at"`
	DatabaseSchemaVersion int    `json:"database_schema_version"`
	OperationID           string `json:"operation_id"`
	SchemaVersion         int    `json:"schema_version"`
	TargetGeneration      string `json:"target_generation"`
}

func (g HTTPGate) Reserve(ctx context.Context, id string) (Reservation, error) {
	var result Reservation
	err := g.call(ctx, http.MethodPost, "/internal/manager/update/readiness", map[string]string{"operation_id": id}, &result)
	return result, err
}
func (g HTTPGate) Release(ctx context.Context, id string) error {
	return g.call(ctx, http.MethodPost, "/internal/manager/update/abort-release", map[string]string{"operation_id": id}, nil)
}

// releaseRetainedSourcePredecessor is the sole HTTP compatibility branch for
// the fixed source-owner predecessor. It always tries the current abort API
// first and reaches the old release endpoint only when the authenticated old
// Platform proves that the new endpoint is absent with its exact 404 body.
func (g HTTPGate) releaseRetainedSourcePredecessor(ctx context.Context, id, generation string) error {
	if generation != contract.SourceOwnerCompatGeneration {
		return errors.New("retained source predecessor generation is not canonical")
	}
	if strings.TrimSpace(g.Token) == "" {
		return errors.New("retained source predecessor release requires a Manager token")
	}
	err := g.Release(ctx, id)
	if err == nil {
		return nil
	}
	if !isRetainedPredecessorEndpointMissing(err) {
		return err
	}
	var response retainedPredecessorReleaseResponse
	if fallbackErr := g.callStrict(ctx, http.MethodPost, "/internal/manager/update/release", map[string]string{"operation_id": id}, &response); fallbackErr != nil {
		return fmt.Errorf("release retained source predecessor through its legacy endpoint: %w", fallbackErr)
	}
	if !response.Released {
		return errors.New("retained source predecessor legacy endpoint did not release admission")
	}
	return nil
}
func (g HTTPGate) Commit(ctx context.Context, id string) error {
	return g.call(ctx, http.MethodPost, "/internal/manager/update/commit-release", map[string]string{"operation_id": id}, nil)
}
func (g HTTPGate) Health(ctx context.Context) error {
	return g.call(ctx, http.MethodGet, "/internal/manager/health", nil, nil)
}

func isRetainedPredecessorEndpointMissing(err error) bool {
	var statusErr *HTTPStatusError
	if !errors.As(err, &statusErr) || statusErr.StatusCode != http.StatusNotFound {
		return false
	}
	data := []byte(statusErr.Body)
	if len(data) == 0 || len(data) > 4096 || rejectDuplicateGateJSONFields(data) != nil {
		return false
	}
	var response struct {
		Error string `json:"error"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decodeErr := decoder.Decode(&response); decodeErr != nil || response.Error != "manager endpoint not found" {
		return false
	}
	var trailing any
	return errors.Is(decoder.Decode(&trailing), io.EOF)
}

// CommitTargetHandoff retries safely after an ambiguous HTTP response because
// Platform persists and returns the same identity-bound receipt across process
// restarts. It does not alter the ordinary update Gate.Commit contract.
func (g HTTPGate) CommitTargetHandoff(ctx context.Context, request TargetHandoffCommitRequest) (TargetHandoffCommitReceipt, error) {
	if err := validateTargetHandoffRequest(request); err != nil {
		return TargetHandoffCommitReceipt{}, err
	}
	var response targetHandoffCommitResponse
	if err := g.callStrict(ctx, http.MethodPost, "/internal/manager/handoff/commit-release", request, &response); err != nil {
		return TargetHandoffCommitReceipt{}, err
	}
	if !response.Released {
		return TargetHandoffCommitReceipt{}, errors.New("target handoff Platform response did not release admission")
	}
	if err := validateTargetHandoffReceipt(response.Receipt, request); err != nil {
		return TargetHandoffCommitReceipt{}, err
	}
	return response.Receipt, nil
}

// ObserveTargetHandoff returns only the exact reservation/receipt projection
// and rejects a response belonging to another transaction or target binding.
func (g HTTPGate) ObserveTargetHandoff(ctx context.Context, expected TargetHandoffCommitRequest) (TargetHandoffReservationObservation, error) {
	if err := validateTargetHandoffRequest(expected); err != nil {
		return TargetHandoffReservationObservation{}, err
	}
	var observation TargetHandoffReservationObservation
	if err := g.callStrict(ctx, http.MethodGet, "/internal/manager/handoff/reservation", nil, &observation); err != nil {
		return TargetHandoffReservationObservation{}, err
	}
	if observation.SchemaVersion != targetHandoffSchemaVersion {
		return TargetHandoffReservationObservation{}, errors.New("target handoff reservation schema is unsupported")
	}
	if observation.Reserved {
		if observation.ReservationID != expected.OperationID || observation.ReservationOwner != "manager" {
			return TargetHandoffReservationObservation{}, errors.New("target handoff reservation identity differs from the journal")
		}
	} else if observation.ReservationID != "" || observation.ReservationOwner != "" {
		return TargetHandoffReservationObservation{}, errors.New("unreserved target handoff response retains an owner identity")
	}
	if observation.Receipt != nil {
		if err := validateTargetHandoffReceipt(*observation.Receipt, expected); err != nil {
			return TargetHandoffReservationObservation{}, err
		}
	}
	return observation, nil
}

func validateTargetHandoffRequest(request TargetHandoffCommitRequest) error {
	if !targetHandoffOperationPattern.MatchString(request.OperationID) ||
		!targetHandoffGenerationPattern.MatchString(request.TargetGeneration) ||
		!targetHandoffSHA256Pattern.MatchString(request.BindingSHA256) {
		return errors.New("target handoff commit identity is invalid")
	}
	return nil
}

func validateTargetHandoffReceipt(receipt TargetHandoffCommitReceipt, expected TargetHandoffCommitRequest) error {
	if receipt.SchemaVersion != targetHandoffSchemaVersion || receipt.OperationID != expected.OperationID ||
		receipt.TargetGeneration != expected.TargetGeneration || receipt.BindingSHA256 != expected.BindingSHA256 ||
		receipt.DatabaseSchemaVersion <= 0 || !targetHandoffSHA256Pattern.MatchString(receipt.ReceiptSHA256) {
		return errors.New("target handoff commit receipt differs from the journal identity")
	}
	parsed, err := time.Parse(time.RFC3339Nano, receipt.CommittedAt)
	if err != nil || parsed.Location() != time.UTC {
		return errors.New("target handoff commit receipt timestamp is invalid")
	}
	material := targetHandoffReceiptMaterial{
		BindingSHA256: receipt.BindingSHA256, CommittedAt: receipt.CommittedAt,
		DatabaseSchemaVersion: receipt.DatabaseSchemaVersion, OperationID: receipt.OperationID,
		SchemaVersion: receipt.SchemaVersion, TargetGeneration: receipt.TargetGeneration,
	}
	encoded, err := json.Marshal(material)
	if err != nil {
		return fmt.Errorf("encode target handoff receipt material: %w", err)
	}
	digest := fmt.Sprintf("%x", sha256.Sum256(encoded))
	if digest != receipt.ReceiptSHA256 {
		return errors.New("target handoff commit receipt digest is invalid")
	}
	return nil
}

func (g HTTPGate) callStrict(ctx context.Context, method, path string, body any, result any) error {
	if g.BaseURL == "" {
		return errors.New("platform gate URL is not configured")
	}
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(g.BaseURL, "/")+path, reader)
	if err != nil {
		return err
	}
	if g.Token != "" {
		request.Header.Set("Authorization", "Bearer "+g.Token)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	client := g.Client
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return &HTTPStatusError{StatusCode: response.StatusCode, Body: strings.TrimSpace(string(data))}
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, targetHandoffResponseLimit+1))
	if err != nil {
		return fmt.Errorf("read target handoff Platform response: %w", err)
	}
	if len(data) == 0 || len(data) > targetHandoffResponseLimit {
		return errors.New("target handoff Platform response has an invalid size")
	}
	if err := rejectDuplicateGateJSONFields(data); err != nil {
		return fmt.Errorf("decode target handoff Platform response: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(result); err != nil {
		return fmt.Errorf("decode target handoff Platform response: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("decode target handoff Platform response: trailing JSON value")
		}
		return fmt.Errorf("decode target handoff Platform response: %w", err)
	}
	return nil
}

func rejectDuplicateGateJSONFields(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := scanGateJSONValue(decoder); err != nil {
		return err
	}
	if token, err := decoder.Token(); !errors.Is(err, io.EOF) {
		if err == nil {
			return fmt.Errorf("unexpected trailing token %v", token)
		}
		return err
	}
	return nil
}

func scanGateJSONValue(decoder *json.Decoder) error {
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
				return errors.New("JSON object key is not a string")
			}
			if _, duplicate := seen[key]; duplicate {
				return fmt.Errorf("duplicate JSON field %q", key)
			}
			seen[key] = struct{}{}
			if err := scanGateJSONValue(decoder); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim('}') {
			return errors.New("unterminated JSON object")
		}
	case '[':
		for decoder.More() {
			if err := scanGateJSONValue(decoder); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim(']') {
			return errors.New("unterminated JSON array")
		}
	default:
		return errors.New("unexpected JSON delimiter")
	}
	return nil
}

func (g HTTPGate) call(ctx context.Context, method, path string, body any, result any) error {
	if g.BaseURL == "" {
		return errors.New("platform gate URL is not configured")
	}
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(g.BaseURL, "/")+path, reader)
	if err != nil {
		return err
	}
	if g.Token != "" {
		req.Header.Set("Authorization", "Bearer "+g.Token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	client := g.Client
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	response, err := client.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return &HTTPStatusError{StatusCode: response.StatusCode, Body: strings.TrimSpace(string(data))}
	}
	if result == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return nil
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 1<<20))
	if err := decoder.Decode(result); err != nil {
		return fmt.Errorf("decode platform gate response: %w", err)
	}
	return nil
}
