package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
)

type stateStub struct{ value model.ManagerState }

func (s stateStub) State() model.ManagerState { return s.value }
func TestMaintenancePageContainsOnlyPublicState(t *testing.T) {
	state := model.NewState(time.Now())
	state.PublicState = model.StateUpdating
	state.Maintenance = true
	state.Phase = model.PhaseMigrating
	state.ActiveOperationID = "op_public"
	state.LastError = "/secret/host/path"
	handler, err := NewHandler(stateStub{state}, "http://127.0.0.1:1")
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))
	body := response.Body.String()
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(body, "op_public") {
		t.Fatalf("unexpected maintenance response: %d %s", response.Code, body)
	}
	if got := response.Header().Get("Refresh"); got != "5" {
		t.Fatalf("Refresh = %q", got)
	}
	if strings.Contains(body, "<script") {
		t.Fatal("maintenance page must not depend on inline script under its strict CSP")
	}
	if strings.Contains(body, "secret/host") {
		t.Fatal("private diagnostic leaked to public maintenance page")
	}
	if !strings.Contains(body, "Agent Platform") || strings.Contains(strings.ToLower(body), "ubitech") {
		t.Fatalf("maintenance page is not neutral public copy: %s", body)
	}
}

func TestUnavailableFallbackUsesNeutralPublicCopy(t *testing.T) {
	t.Parallel()
	handler, err := NewHandler(stateStub{model.NewState(time.Now())}, "http://127.0.0.1:1")
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))
	body := response.Body.String()
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d; body=%s", response.Code, http.StatusServiceUnavailable, body)
	}
	if !strings.Contains(body, "Agent Platform") || strings.Contains(strings.ToLower(body), "ubitech") {
		t.Fatalf("fallback page is not neutral public copy: %s", body)
	}
}

func TestLANAccessUsesPeerAddressAndRejectsDisallowedSources(t *testing.T) {
	t.Parallel()
	state := model.NewState(time.Now())
	handler, err := NewHandlerWithAccess(stateStub{state}, "http://127.0.0.1:1", AccessPolicy{
		AllowedRemotePrefixes: []netip.Prefix{netip.MustParsePrefix("192.168.0.0/16")},
	})
	if err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodGet, "/__ubitech/health", nil)
	request.RemoteAddr = "203.0.113.9:43000"
	request.Header.Set("X-Forwarded-For", "192.168.1.10")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("spoofed LAN request status = %d, want 403", response.Code)
	}

	request = httptest.NewRequest(http.MethodGet, "/__ubitech/health", nil)
	request.RemoteAddr = "192.168.1.10:43000"
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("private LAN request status = %d, want 200", response.Code)
	}
}

func TestProxyRebuildsForwardingHeadersAcrossTrustBoundary(t *testing.T) {
	t.Parallel()
	type observed struct {
		For       string
		Proto     string
		Host      string
		Forwarded string
		RealIP    string
	}
	seen := make(chan observed, 2)
	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		seen <- observed{
			For:       request.Header.Get("X-Forwarded-For"),
			Proto:     request.Header.Get("X-Forwarded-Proto"),
			Host:      request.Header.Get("X-Forwarded-Host"),
			Forwarded: request.Header.Get("Forwarded"),
			RealIP:    request.Header.Get("X-Real-Ip"),
		}
		response.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	state := model.NewState(time.Now())
	handler, err := NewHandlerWithAccess(stateStub{state}, upstream.URL, AccessPolicy{
		TrustedIngressPrefixes: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")},
	})
	if err != nil {
		t.Fatal(err)
	}

	trusted := httptest.NewRequest(http.MethodGet, "/", nil)
	trusted.RemoteAddr = "127.0.0.1:44100"
	trusted.Host = "gateway.internal:8080"
	trusted.Header.Set("X-Forwarded-For", "198.51.100.24, 127.0.0.2")
	trusted.Header.Set("X-Forwarded-Proto", "https")
	trusted.Header.Set("X-Forwarded-Host", "agent.lan.example")
	trusted.Header.Set("Forwarded", "for=attacker;host=evil.example")
	trusted.Header.Set("X-Real-Ip", "203.0.113.8")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, trusted)
	if response.Code != http.StatusNoContent {
		t.Fatalf("trusted proxy status = %d", response.Code)
	}
	got := <-seen
	if got.For != "198.51.100.24" || got.Proto != "https" || got.Host != "agent.lan.example" || got.Forwarded != "" || got.RealIP != "" {
		t.Fatalf("trusted forwarding metadata = %#v", got)
	}

	untrusted := httptest.NewRequest(http.MethodGet, "/", nil)
	untrusted.RemoteAddr = "192.168.50.7:44200"
	untrusted.Host = "192.168.50.1:8081"
	untrusted.Header.Set("X-Forwarded-For", "203.0.113.99")
	untrusted.Header.Set("X-Forwarded-Proto", "https")
	untrusted.Header.Set("X-Forwarded-Host", "evil.example")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, untrusted)
	if response.Code != http.StatusNoContent {
		t.Fatalf("direct request status = %d", response.Code)
	}
	got = <-seen
	if got.For != "192.168.50.7" || got.Proto != "http" || got.Host != "192.168.50.1:8081" {
		t.Fatalf("untrusted forwarding metadata was not rebuilt: %#v", got)
	}
}

func TestMaintenanceStatusUsesFinalizePendingOperation(t *testing.T) {
	t.Parallel()
	state := model.NewState(time.Now())
	state.PublicState = model.StateUpdating
	state.Maintenance = true
	state.FinalizePendingOperationID = "op_finalize_pending"
	handler, err := NewHandler(stateStub{state}, "http://127.0.0.1:1")
	if err != nil {
		t.Fatal(err)
	}

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/__ubitech/status", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
	var status struct {
		OperationID string `json:"operation_id"`
	}
	if err := json.NewDecoder(response.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	if status.OperationID != "op_finalize_pending" {
		t.Fatalf("operation_id = %q, want finalize-pending operation", status.OperationID)
	}

	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))
	if !strings.Contains(response.Body.String(), "op_finalize_pending") {
		t.Fatalf("maintenance page omitted finalize-pending operation: %s", response.Body.String())
	}
}
