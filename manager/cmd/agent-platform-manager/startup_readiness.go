package main

import (
	"crypto/subtle"
	"net/http"
	"sync/atomic"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/control"
)

// startupReadiness keeps Platform's authenticated recovery reads available,
// without exposing executor or mutation routes until launcher proof is durable.
type startupReadiness struct {
	api   *control.API
	ready atomic.Bool
}

func (s *startupReadiness) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && r.URL.Path == "/v1/ready" {
		w.Header().Set("Cache-Control", "no-store")
		if s.api.ControlToken == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+s.api.ControlToken)) != 1 {
			http.Error(w, "control authentication failed", http.StatusUnauthorized)
			return
		}
		if !s.ready.Load() {
			http.Error(w, "launcher startup proof pending", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if !s.ready.Load() {
		if r.Method != http.MethodGet || (r.URL.Path != "/v1/identity" && r.URL.Path != "/v1/status" && r.URL.Path != "/v1/config") {
			http.Error(w, "launcher startup proof pending", http.StatusServiceUnavailable)
			return
		}
	}
	s.api.ServeHTTP(w, r)
}
