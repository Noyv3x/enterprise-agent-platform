package control

import (
	"bytes"
	"context"
	"errors"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestClientSendsControlBearer(t *testing.T) {
	t.Parallel()
	socketPath := filepath.Join(t.TempDir(), "manager.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer control-token-0123456789abcdef" {
			http.Error(response, "wrong authorization", http.StatusUnauthorized)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"ok":true}`))
	})}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })

	client := Client{SocketPath: socketPath, Token: "control-token-0123456789abcdef", Timeout: time.Second}
	var result map[string]any
	if err := client.Do(context.Background(), http.MethodGet, "/v1/status", nil, &result); err != nil {
		t.Fatal(err)
	}
	if result["ok"] != true {
		t.Fatalf("unexpected response: %#v", result)
	}
}

func TestClientRejectsMissingOrMalformedControlToken(t *testing.T) {
	t.Parallel()
	for _, token := range []string{"", "bad token", "bad\ntoken"} {
		client := Client{SocketPath: filepath.Join(t.TempDir(), "missing.sock"), Token: token}
		if err := client.Do(context.Background(), http.MethodGet, "/v1/status", nil, nil); err == nil {
			t.Fatalf("token %q was accepted", token)
		}
	}
}

func TestClientClassifiesInvalidSuccessfulJSONAsAmbiguous(t *testing.T) {
	t.Parallel()
	for _, body := range []string{"", `{"operation":`} {
		body := body
		t.Run(body, func(t *testing.T) {
			socketPath := filepath.Join(t.TempDir(), "manager.sock")
			listener, err := net.Listen("unix", socketPath)
			if err != nil {
				t.Fatal(err)
			}
			server := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				response.Header().Set("Content-Type", "application/json")
				response.WriteHeader(http.StatusAccepted)
				_, _ = response.Write([]byte(body))
			})}
			go func() { _ = server.Serve(listener) }()
			t.Cleanup(func() { _ = server.Close() })

			client := Client{SocketPath: socketPath, Token: "control-token-0123456789abcdef", Timeout: time.Second}
			var result map[string]any
			err = client.Do(context.Background(), http.MethodPost, "/v1/operations", map[string]any{"idempotency_key": "stable"}, &result)
			var ambiguous *AmbiguousResponseError
			if !errors.As(err, &ambiguous) {
				t.Fatalf("error = %v, want AmbiguousResponseError", err)
			}
			if !IsUnavailable(err) {
				t.Fatalf("ambiguous response was not classified as unavailable: %v", err)
			}
			if ambiguous.Status != http.StatusAccepted || ambiguous.Method != http.MethodPost || ambiguous.Path != "/v1/operations" {
				t.Fatalf("unexpected ambiguity metadata: %#v", ambiguous)
			}
			if !strings.Contains(err.Error(), "outcome uncertain") {
				t.Fatalf("error does not explain uncertain outcome: %v", err)
			}
		})
	}
}

func TestClientKeepsStructuredHTTPFailureDeterministic(t *testing.T) {
	t.Parallel()
	socketPath := filepath.Join(t.TempDir(), "manager.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(http.StatusBadRequest)
		_, _ = response.Write([]byte(`{"error":"invalid migration input"}`))
	})}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })

	client := Client{SocketPath: socketPath, Token: "control-token-0123456789abcdef", Timeout: time.Second}
	var result map[string]any
	err = client.Do(context.Background(), http.MethodPost, "/v1/migrations/legacy", map[string]any{}, &result)
	var httpErr *HTTPError
	if !errors.As(err, &httpErr) || httpErr.Status != http.StatusBadRequest {
		t.Fatalf("error = %v, want HTTP 400", err)
	}
	if IsUnavailable(err) {
		t.Fatalf("deterministic HTTP failure was classified as unavailable: %v", err)
	}
}

func TestClientDetectsOversizedSuccessfulResponse(t *testing.T) {
	t.Parallel()
	socketPath := filepath.Join(t.TempDir(), "manager.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(http.StatusOK)
		_, _ = response.Write(bytes.Repeat([]byte("x"), int(maxManagerResponseBytes)+1))
	})}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })

	client := Client{SocketPath: socketPath, Token: "control-token-0123456789abcdef", Timeout: time.Second}
	var result map[string]any
	err = client.Do(context.Background(), http.MethodPost, "/v1/migrations/legacy", map[string]any{}, &result)
	var ambiguous *AmbiguousResponseError
	if !errors.As(err, &ambiguous) || !IsUnavailable(err) {
		t.Fatalf("oversized success error = %v, want ambiguous unavailable response", err)
	}
	if !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("oversized response reason was lost: %v", err)
	}
}

func TestClientClassifiesTruncatedSuccessfulBodyReadAsAmbiguous(t *testing.T) {
	t.Parallel()
	socketPath := filepath.Join(t.TempDir(), "manager.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		response.Header().Set("Content-Length", "100")
		response.WriteHeader(http.StatusAccepted)
		_, _ = response.Write([]byte(`{"operation":`))
	})}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })

	client := Client{SocketPath: socketPath, Token: "control-token-0123456789abcdef", Timeout: time.Second}
	var result map[string]any
	err = client.Do(context.Background(), http.MethodPost, "/v1/operations", map[string]any{}, &result)
	var ambiguous *AmbiguousResponseError
	if !errors.As(err, &ambiguous) || !IsUnavailable(err) {
		t.Fatalf("truncated success error = %v, want ambiguous unavailable response", err)
	}
}
