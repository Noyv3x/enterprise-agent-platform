//go:build linux

package control

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handofffd"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffhelper"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handofflisteners"
)

func participantChallenge(role handoffhelper.ParticipantRole) handoffhelper.ParticipantChallenge {
	return handoffhelper.ParticipantChallenge{
		SchemaVersion: 1,
		TransactionID: "handoff_0123456789abcdef0123456789abcdef",
		Revision:      7,
		BindingSHA256: strings.Repeat("a", 64),
		Role:          role,
		Nonce:         strings.Repeat("b", 64),
	}
}

func participantObservation(t *testing.T, challenge handoffhelper.ParticipantChallenge) handoffhelper.ParticipantObservation {
	t.Helper()
	observation := handoffhelper.ParticipantObservation{
		SchemaVersion:       1,
		TransactionID:       challenge.TransactionID,
		StartupRevision:     challenge.Revision,
		BindingSHA256:       challenge.BindingSHA256,
		Role:                challenge.Role,
		Nonce:               challenge.Nonce,
		ManagerVersion:      strings.Repeat("c", 40),
		SourceCommit:        strings.Repeat("d", 40),
		ExecutableSHA256:    strings.Repeat("e", 64),
		PID:                 1234,
		SocketPath:          "/run/user/1001/participant-control.sock",
		CoreReady:           true,
		PublicListenerOwned: true,
		ReadyToCommit:       challenge.Role == handoffhelper.ParticipantTarget,
		AutoUpdateCheckAt:   time.Now().UTC().Add(-time.Second),
		IssuedAt:            time.Now().UTC(),
	}
	proof, err := handoffhelper.ComputeParticipantProof(observation)
	if err != nil {
		t.Fatal(err)
	}
	observation.ProofSHA256 = proof
	return observation
}

func participantRequest(t *testing.T, method string, body []byte, token string) *http.Request {
	t.Helper()
	request := httptest.NewRequest(method, handoffhelper.ParticipantObservePath, bytes.NewReader(body))
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	request.Header.Set("Content-Type", "application/json")
	return request
}

func TestParticipantObservationAPIIsOwnerAuthenticatedAndValidatesProvider(t *testing.T) {
	challenge := participantChallenge(handoffhelper.ParticipantTarget)
	body, err := json.Marshal(challenge)
	if err != nil {
		t.Fatal(err)
	}
	providerCalls := 0
	api := &API{
		ControlToken: "control-token-0123456789abcdef",
		ParticipantObserver: ParticipantObservationProviderFunc(func(_ context.Context, got handoffhelper.ParticipantChallenge) (handoffhelper.ParticipantObservation, error) {
			providerCalls++
			if got != challenge {
				t.Fatalf("provider challenge = %+v, want %+v", got, challenge)
			}
			return participantObservation(t, got), nil
		}),
	}

	unauthorized := httptest.NewRecorder()
	api.ServeHTTP(unauthorized, participantRequest(t, http.MethodPost, body, ""))
	if unauthorized.Code != http.StatusUnauthorized || providerCalls != 0 {
		t.Fatalf("unauthorized status=%d provider_calls=%d", unauthorized.Code, providerCalls)
	}

	response := httptest.NewRecorder()
	api.ServeHTTP(response, participantRequest(t, http.MethodPost, body, api.ControlToken))
	if response.Code != http.StatusOK || providerCalls != 1 {
		t.Fatalf("observation status=%d provider_calls=%d body=%s", response.Code, providerCalls, response.Body.String())
	}
	decoded, err := handoffhelper.DecodeParticipantObservation(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if err := handoffhelper.ValidateParticipantObservation(challenge, decoded); err != nil {
		t.Fatal(err)
	}

	api.ParticipantObserver = ParticipantObservationProviderFunc(func(_ context.Context, got handoffhelper.ParticipantChallenge) (handoffhelper.ParticipantObservation, error) {
		spoofed := participantObservation(t, got)
		spoofed.Nonce = strings.Repeat("f", 64)
		spoofed.ProofSHA256, _ = handoffhelper.ComputeParticipantProof(spoofed)
		return spoofed, nil
	})
	spoofed := httptest.NewRecorder()
	api.ServeHTTP(spoofed, participantRequest(t, http.MethodPost, body, api.ControlToken))
	if spoofed.Code != http.StatusConflict {
		t.Fatalf("spoofed provider status=%d body=%s", spoofed.Code, spoofed.Body.String())
	}

	api.ParticipantObserver = ParticipantObservationProviderFunc(func(context.Context, handoffhelper.ParticipantChallenge) (handoffhelper.ParticipantObservation, error) {
		return handoffhelper.ParticipantObservation{}, errors.New("participant unavailable")
	})
	failed := httptest.NewRecorder()
	api.ServeHTTP(failed, participantRequest(t, http.MethodPost, body, api.ControlToken))
	if failed.Code != http.StatusConflict {
		t.Fatalf("provider error status=%d body=%s", failed.Code, failed.Body.String())
	}
}

func TestParticipantObservationAPIRejectsMalformedBodiesBeforeProvider(t *testing.T) {
	challenge := participantChallenge(handoffhelper.ParticipantSource)
	encoded, err := json.Marshal(challenge)
	if err != nil {
		t.Fatal(err)
	}
	unknown := bytes.Replace(encoded, []byte(`"revision":7`), []byte(`"revision":7,"unknown":true`), 1)
	duplicate := bytes.Replace(encoded, []byte(`"revision":7`), []byte(`"revision":7,"revision":7`), 1)
	providerCalls := 0
	api := &API{
		ControlToken: "control-token-0123456789abcdef",
		ParticipantObserver: ParticipantObservationProviderFunc(func(context.Context, handoffhelper.ParticipantChallenge) (handoffhelper.ParticipantObservation, error) {
			providerCalls++
			return handoffhelper.ParticipantObservation{}, nil
		}),
	}
	for name, body := range map[string][]byte{
		"empty":     nil,
		"unknown":   unknown,
		"duplicate": duplicate,
		"trailing":  append(append([]byte(nil), encoded...), []byte(` {}`)...),
		"oversized": bytes.Repeat([]byte("x"), (8<<10)+1),
	} {
		t.Run(name, func(t *testing.T) {
			response := httptest.NewRecorder()
			api.ServeHTTP(response, participantRequest(t, http.MethodPost, body, api.ControlToken))
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
	if providerCalls != 0 {
		t.Fatalf("provider called %d times for invalid requests", providerCalls)
	}

	unavailable := &API{ControlToken: api.ControlToken}
	response := httptest.NewRecorder()
	unavailable.ServeHTTP(response, participantRequest(t, http.MethodPost, encoded, api.ControlToken))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing provider status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestHandoffParticipantOnlyControlClosesAllOtherRoutes(t *testing.T) {
	challenge := participantChallenge(handoffhelper.ParticipantSource)
	participantBody, err := json.Marshal(challenge)
	if err != nil {
		t.Fatal(err)
	}
	ownership := ownershipChallenge(t, handofflisteners.OwnerSource)
	api := &API{
		ControlToken:           "control-token-0123456789abcdef",
		ExecutorToken:          "executor-token-0123456789abcdef",
		ManagerVersion:         strings.Repeat("c", 40),
		ManagerSHA256:          strings.Repeat("d", 64),
		HandoffParticipantOnly: true,
		HandoffTransactionID:   challenge.TransactionID,
		ParticipantObserver: ParticipantObservationProviderFunc(func(_ context.Context, got handoffhelper.ParticipantChallenge) (handoffhelper.ParticipantObservation, error) {
			return participantObservation(t, got), nil
		}),
		OwnershipProof: OwnershipProofProviderFunc(func(_ context.Context, got handofflisteners.OwnershipChallenge) (handofflisteners.OwnershipProof, error) {
			return handofflisteners.OwnershipProof{
				SchemaVersion: handofflisteners.OwnershipSchemaVersion,
				TransactionID: got.TransactionID,
				Role:          got.Role,
				Nonce:         got.Nonce,
				Owns:          false,
				Listeners:     []handofffd.ListenerIdentity{},
			}, nil
		}),
	}

	identity := httptest.NewRequest(http.MethodGet, "/v1/identity", nil)
	identity.Header.Set("Authorization", "Bearer "+api.ControlToken)
	ownershipRequest := ownershipRequest(t, ownership, api.ControlToken)
	allowed := []*http.Request{
		identity,
		httptest.NewRequest(http.MethodGet, "/v1/status", nil),
		ownershipRequest,
		participantRequest(t, http.MethodPost, participantBody, api.ControlToken),
	}
	for _, request := range allowed {
		request.Header.Set("Authorization", "Bearer "+api.ControlToken)
		response := httptest.NewRecorder()
		api.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("allowed %s %s status=%d body=%s", request.Method, request.URL.Path, response.Code, response.Body.String())
		}
	}

	closed := []struct {
		method string
		path   string
		token  string
	}{
		{http.MethodPost, "/v1/status", api.ControlToken},
		{http.MethodGet, "/v1/config", api.ControlToken},
		{http.MethodPost, "/v1/check", api.ControlToken},
		{http.MethodPost, "/v1/operations", api.ControlToken},
		{http.MethodPost, "/v1/release-transition/observation", api.ControlToken},
		{http.MethodGet, handoffhelper.ParticipantObservePath, api.ControlToken},
		{http.MethodPost, "/v1/executor/process", api.ControlToken},
		{http.MethodPost, "/v1/executor/process", api.ExecutorToken},
		{http.MethodGet, "/v1/not-found", api.ControlToken},
	}
	for _, test := range closed {
		request := httptest.NewRequest(test.method, test.path, nil)
		request.Header.Set("Authorization", "Bearer "+test.token)
		response := httptest.NewRecorder()
		api.ServeHTTP(response, request)
		want := http.StatusNotFound
		if test.token == api.ExecutorToken {
			want = http.StatusUnauthorized
		}
		if response.Code != want {
			t.Fatalf("closed %s %s status=%d want=%d body=%s", test.method, test.path, response.Code, want, response.Body.String())
		}
	}

	status := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/v1/status", nil)
	request.Header.Set("Authorization", "Bearer "+api.ControlToken)
	api.ServeHTTP(status, request)
	var projected map[string]any
	if err := json.Unmarshal(status.Body.Bytes(), &projected); err != nil {
		t.Fatal(err)
	}
	if projected["maintenance"] != true || projected["public_state"] != "updating" ||
		projected["active_operation_id"] != challenge.TransactionID ||
		projected["operation_id"] != challenge.TransactionID ||
		projected["finalize_pending_operation_id"] != "" {
		t.Fatalf("restricted status = %#v", projected)
	}

	boundTransactionID := api.HandoffTransactionID
	api.HandoffTransactionID = ""
	unavailable := httptest.NewRecorder()
	api.ServeHTTP(unavailable, request)
	api.HandoffTransactionID = boundTransactionID
	if unavailable.Code != http.StatusServiceUnavailable {
		t.Fatalf("unbound participant status=%d body=%s", unavailable.Code, unavailable.Body.String())
	}

	for _, path := range []string{"/v1/identity", "/v1/status", handofflisteners.OwnershipControlPath, handoffhelper.ParticipantObservePath} {
		response := httptest.NewRecorder()
		api.ServeHTTP(response, httptest.NewRequest(http.MethodPost, path, nil))
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("unauthenticated %s status=%d", path, response.Code)
		}
	}
}

func TestIdentityOnlyTakesPrecedenceOverHandoffParticipantMode(t *testing.T) {
	api := &API{
		ControlToken:           "control-token-0123456789abcdef",
		IdentityOnly:           true,
		HandoffParticipantOnly: true,
		ParticipantObserver: ParticipantObservationProviderFunc(func(context.Context, handoffhelper.ParticipantChallenge) (handoffhelper.ParticipantObservation, error) {
			t.Fatal("identity-only API invoked participant provider")
			return handoffhelper.ParticipantObservation{}, nil
		}),
	}
	body, _ := json.Marshal(participantChallenge(handoffhelper.ParticipantSource))
	response := httptest.NewRecorder()
	api.ServeHTTP(response, participantRequest(t, http.MethodPost, body, api.ControlToken))
	if response.Code != http.StatusNotFound {
		t.Fatalf("identity-only participant route status=%d body=%s", response.Code, response.Body.String())
	}
}
