package control

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestIdentityOnlyAPIClosesEveryMutationRoute(t *testing.T) {
	api := &API{
		ControlToken: "control-token-0123456789abcdef", ExecutorToken: "executor-token-0123456789abcdef",
		ManagerVersion: strings.Repeat("a", 40), ManagerSHA256: strings.Repeat("b", 64), IdentityOnly: true,
	}
	tests := []struct {
		name     string
		method   string
		path     string
		token    string
		wantCode int
	}{
		{name: "identity", method: http.MethodGet, path: "/v1/identity", token: api.ControlToken, wantCode: http.StatusOK},
		{name: "status", method: http.MethodGet, path: "/v1/status", token: api.ControlToken, wantCode: http.StatusNotFound},
		{name: "operation mutation", method: http.MethodPost, path: "/v1/operations", token: api.ControlToken, wantCode: http.StatusNotFound},
		{name: "executor mutation with executor token", method: http.MethodPost, path: "/v1/executor/processes", token: api.ExecutorToken, wantCode: http.StatusUnauthorized},
		{name: "executor mutation with control token", method: http.MethodPost, path: "/v1/executor/processes", token: api.ControlToken, wantCode: http.StatusNotFound},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(test.method, test.path, nil)
			request.Header.Set("Authorization", "Bearer "+test.token)
			response := httptest.NewRecorder()
			api.ServeHTTP(response, request)
			if response.Code != test.wantCode {
				t.Fatalf("status = %d, want %d; body=%s", response.Code, test.wantCode, response.Body.String())
			}
		})
	}
}
