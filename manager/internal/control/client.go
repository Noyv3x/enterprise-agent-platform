package control

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

type Client struct {
	SocketPath string
	Token      string
	Timeout    time.Duration
}

// Manager control responses are bounded at twice the default combined Docker
// log budget so ordinary JSON escaping still fits. Status and operation
// projections are substantially smaller.
const maxManagerResponseBytes int64 = 4 << 20

func (c Client) Do(ctx context.Context, method, path string, body, out any) error {
	if strings.TrimSpace(c.Token) == "" || strings.ContainsAny(c.Token, " \t\r\n") {
		return errors.New("manager control token is missing or invalid")
	}
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, "http://manager"+path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	request.Header.Set("Authorization", "Bearer "+c.Token)
	timeout := c.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	transport := &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		dialer := net.Dialer{Timeout: timeout}
		return dialer.DialContext(ctx, "unix", c.SocketPath)
	}}
	client := &http.Client{Transport: transport, Timeout: timeout}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	// Callers that only need the HTTP commit status can explicitly skip response
	// decoding and avoid buffering an unused body.
	if response.StatusCode >= 200 && response.StatusCode < 300 && out == nil {
		return nil
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxManagerResponseBytes+1))
	if err != nil {
		if response.StatusCode >= 200 && response.StatusCode < 300 {
			return &AmbiguousResponseError{Method: method, Path: path, Status: response.StatusCode, Cause: fmt.Errorf("read manager response: %w", err)}
		}
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var failure struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(data, &failure)
		if failure.Error == "" {
			failure.Error = string(data)
		}
		return &HTTPError{Status: response.StatusCode, Message: failure.Error}
	}
	if int64(len(data)) > maxManagerResponseBytes {
		return &AmbiguousResponseError{
			Method: method,
			Path:   path,
			Status: response.StatusCode,
			Cause:  fmt.Errorf("manager response exceeds %d-byte limit", maxManagerResponseBytes),
		}
	}
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return &AmbiguousResponseError{Method: method, Path: path, Status: response.StatusCode, Cause: io.ErrUnexpectedEOF}
	}
	if out != nil {
		if err := json.Unmarshal(data, out); err != nil {
			return &AmbiguousResponseError{Method: method, Path: path, Status: response.StatusCode, Cause: err}
		}
	}
	return nil
}

// AmbiguousResponseError means the Manager committed a successful HTTP status
// but the client could not prove what response body accompanied it. The
// request may already have crossed its durable mutation boundary, so callers
// must reconcile with the same idempotency identity instead of treating it as
// a deterministic failure.
type AmbiguousResponseError struct {
	Method string
	Path   string
	Status int
	Cause  error
}

func (e *AmbiguousResponseError) Error() string {
	return fmt.Sprintf("decode manager response for %s %s (HTTP %d; outcome uncertain): %v", e.Method, e.Path, e.Status, e.Cause)
}

func (e *AmbiguousResponseError) Unwrap() error { return e.Cause }

type HTTPError struct {
	Status  int
	Message string
}

func (e *HTTPError) Error() string { return fmt.Sprintf("manager HTTP %d: %s", e.Status, e.Message) }
func IsUnavailable(err error) bool {
	var netErr net.Error
	var ambiguous *AmbiguousResponseError
	return errors.As(err, &netErr) || errors.As(err, &ambiguous)
}
