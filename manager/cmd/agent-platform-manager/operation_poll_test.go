package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/control"
)

func TestAwaitOperationReconnectsAfterSocketReplacement(t *testing.T) {
	for _, outcome := range []string{"succeeded", "failed"} {
		t.Run(outcome, func(t *testing.T) {
			socket := filepath.Join(t.TempDir(), "manager.sock")
			listener, err := net.Listen("unix", socket)
			if err != nil {
				t.Fatal(err)
			}
			interrupted := make(chan struct{})
			requests := 0
			server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.URL.Path != "/v1/operations/op_update" {
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
				}
				requests++
				if requests == 1 {
					io.WriteString(w, `{"status":"running"}`)
					return
				}
				listener.Close()
				conn, _, err := w.(http.Hijacker).Hijack()
				if err != nil {
					t.Error(err)
				} else {
					conn.Close()
				}
				close(interrupted)
			})}
			go server.Serve(listener)
			defer server.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			defer cancel()
			result := make(chan error, 1)
			client := control.Client{SocketPath: socket, Token: "0123456789abcdef0123456789abcdef", Timeout: time.Second}
			go func() { result <- awaitOperationContext(ctx, client, "op_update") }()
			select {
			case <-interrupted:
			case <-ctx.Done():
				t.Fatal("poll did not reach child interruption")
			}
			// Keep the socket absent across the next retry, as during launcher cutover.
			timer := time.NewTimer(750 * time.Millisecond)
			defer timer.Stop()
			select {
			case err := <-result:
				t.Fatalf("poll exited during restart: %v", err)
			case <-timer.C:
			}
			replacement, err := net.Listen("unix", socket)
			if err != nil {
				t.Fatal(err)
			}
			resumed := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.URL.Path != "/v1/operations/op_update" {
					t.Errorf("mutation replay or identity drift: %s %s", r.Method, r.URL.Path)
				}
				io.WriteString(w, `{"status":"`+outcome+`","error":"candidate rejected"}`)
			})}
			go resumed.Serve(replacement)
			defer resumed.Close()
			err = <-result
			if outcome == "succeeded" && err != nil {
				t.Fatal(err)
			}
			if outcome == "failed" && (err == nil || err.Error() != "candidate rejected") {
				t.Fatalf("lost terminal failure: %v", err)
			}
		})
	}
}

func TestAwaitOperationUnavailableDeadline(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	client := control.Client{SocketPath: filepath.Join(t.TempDir(), "absent.sock"), Token: "valid-token"}
	if err := awaitOperationContext(ctx, client, "op_update"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("deadline error = %v", err)
	}
}

func TestAwaitOperationConnectionRefused(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "manager.sock")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socket, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	listener.SetUnlinkOnClose(false)
	listener.Close()
	defer os.Remove(socket)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	client := control.Client{SocketPath: socket, Token: "valid-token"}
	if err := awaitOperationContext(ctx, client, "op_update"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("connection refusal was not retried: %v", err)
	}
}
