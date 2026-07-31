package control

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/operation"
)

type testExecutorAdmission struct {
	mu       sync.Mutex
	entered  int
	released int
	err      error
}

func TestPreflightFailsClosedAtHandoffAdmission(t *testing.T) {
	api := &API{
		ControlToken: "control-token-0123456789abcdef",
		Operations: &operation.Orchestrator{HandoffAdmission: func(context.Context) (func(), error) {
			return nil, errors.New("namespace handoff is active")
		}},
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/preflight", nil)
	request.Header.Set("Authorization", "Bearer control-token-0123456789abcdef")
	response := httptest.NewRecorder()
	api.ServeHTTP(response, request)
	if response.Code != http.StatusConflict {
		t.Fatalf("preflight status = %d; body=%s", response.Code, response.Body.String())
	}
}

func (gate *testExecutorAdmission) Enter(context.Context) (func(), error) {
	gate.mu.Lock()
	defer gate.mu.Unlock()
	if gate.err != nil {
		return nil, gate.err
	}
	gate.entered++
	var once sync.Once
	return func() {
		once.Do(func() {
			gate.mu.Lock()
			gate.released++
			gate.mu.Unlock()
		})
	}, nil
}

func TestExecutorRouteIsHeldInsideRuntimeAdmission(t *testing.T) {
	gate := &testExecutorAdmission{}
	api := &API{ExecutorToken: "executor-token-0123456789abcdef", ExecutorAdmission: gate}
	request := httptest.NewRequest(http.MethodPost, "/v1/executor/not-found", nil)
	request.Header.Set("Authorization", "Bearer executor-token-0123456789abcdef")
	response := httptest.NewRecorder()
	api.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("executor status = %d; body=%s", response.Code, response.Body.String())
	}
	gate.mu.Lock()
	defer gate.mu.Unlock()
	if gate.entered != 1 || gate.released != 1 {
		t.Fatalf("executor admission = entered %d released %d", gate.entered, gate.released)
	}
}

func TestExecutorRouteFailsClosedWhenRuntimeIsFrozen(t *testing.T) {
	gate := &testExecutorAdmission{err: errors.New("frozen")}
	api := &API{ExecutorToken: "executor-token-0123456789abcdef", ExecutorAdmission: gate}
	request := httptest.NewRequest(http.MethodPost, "/v1/executor/not-found", nil)
	request.Header.Set("Authorization", "Bearer executor-token-0123456789abcdef")
	response := httptest.NewRecorder()
	api.ServeHTTP(response, request)
	if response.Code != http.StatusConflict {
		t.Fatalf("frozen executor status = %d; body=%s", response.Code, response.Body.String())
	}
}
