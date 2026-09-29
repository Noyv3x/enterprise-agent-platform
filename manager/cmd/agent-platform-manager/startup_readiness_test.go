package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/config"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/control"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/journal"
)

func TestStartupReadinessPreservesAuthenticatedReadsAndBlocksSideEffects(t *testing.T) {
	store, err := journal.Open(filepath.Join(t.TempDir(), "manager"), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	gate := &startupReadiness{api: &control.API{Store: store, Config: config.NewManager(config.Config{}), ControlToken: "control", ExecutorToken: "executor", ManagerVersion: strings.Repeat("a", 40), ManagerSHA256: strings.Repeat("b", 64)}}
	request := func(method, path, token string) int {
		r := httptest.NewRequest(method, path, nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		gate.ServeHTTP(w, r)
		return w.Code
	}
	for _, path := range []string{"/v1/identity", "/v1/status", "/v1/config"} {
		if got := request(http.MethodGet, path, "control"); got != http.StatusOK {
			t.Fatalf("recovery read %s: %d", path, got)
		}
		if got := request(http.MethodGet, path, "executor"); got != http.StatusUnauthorized {
			t.Fatalf("executor authorized recovery read %s: %d", path, got)
		}
	}
	for _, route := range []struct{ method, path, token string }{
		{http.MethodPost, "/v1/operations", "control"},
		{http.MethodPost, "/v1/check", "control"},
		{http.MethodPatch, "/v1/config", "control"},
		{http.MethodPost, "/v1/executor/process", "executor"},
		{http.MethodGet, "/v1/executor/process", "executor"},
	} {
		if got := request(route.method, route.path, route.token); got != http.StatusServiceUnavailable {
			t.Fatalf("startup side effect %s %s: %d", route.method, route.path, got)
		}
	}
	if got := request(http.MethodGet, "/v1/ready", "executor"); got != http.StatusUnauthorized {
		t.Fatalf("readiness credential boundary: %d", got)
	}
	if got := request(http.MethodGet, "/v1/ready", "control"); got != http.StatusServiceUnavailable {
		t.Fatalf("startup readiness: %d", got)
	}
	gate.ready.Store(true)
	if got := request(http.MethodGet, "/v1/ready", "control"); got != http.StatusNoContent {
		t.Fatalf("committed readiness: %d", got)
	}
	if got := request(http.MethodPatch, "/v1/config", "wrong"); got != http.StatusUnauthorized {
		t.Fatalf("committed authentication: %d", got)
	}
}

func TestWaitForManagerRequiresLauncherProofNotStatusAvailability(t *testing.T) {
	root := t.TempDir()
	socket := filepath.Join(root, "manager.sock")
	listener, err := control.Listen(socket)
	if err != nil {
		t.Fatal(err)
	}
	gate := &startupReadiness{api: &control.API{ControlToken: "control"}}
	server := &http.Server{Handler: gate}
	go server.Serve(listener)
	defer server.Close()
	done := make(chan error, 1)
	go func() {
		done <- waitForManager(control.Client{SocketPath: socket, Token: "control", Timeout: time.Second})
	}()
	select {
	case err := <-done:
		t.Fatalf("installer proceeded before proof: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	gate.ready.Store(true)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("installer did not observe durable startup readiness")
	}
	if err := server.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}
