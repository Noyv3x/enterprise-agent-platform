package control

import (
	"context"
	"net"
	"net/http"
	"path/filepath"
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
