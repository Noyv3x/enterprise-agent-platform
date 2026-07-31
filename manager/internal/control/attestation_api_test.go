//go:build linux

package control

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/attestation"
)

type transitionObserver func(context.Context, attestation.Challenge) (attestation.Observation, error)

func (observer transitionObserver) ObserveTransition(ctx context.Context, challenge attestation.Challenge) (attestation.Observation, error) {
	return observer(ctx, challenge)
}

func testObservationAPI() *API {
	return &API{
		ControlToken: "0123456789abcdef0123456789abcdef",
		TransitionObserver: transitionObserver(func(_ context.Context, challenge attestation.Challenge) (attestation.Observation, error) {
			return attestation.Observation{
				ObservedGeneration: challenge.ExpectedObservedGeneration,
				ProfileID:          challenge.ExpectedProfileID,
				Capability:         challenge.ExpectedCapability,
				Status:             challenge.ExpectedStatus,
				ManagerSHA256:      strings.Repeat("a", 64),
				EvidenceSHA256:     strings.Repeat("b", 64),
			}, nil
		}),
	}
}

func validObservationChallenge(now time.Time) attestation.Challenge {
	return attestation.Challenge{
		SchemaVersion:              1,
		TransitionID:               attestation.TransitionID,
		ChallengeID:                "challenge_0123456789abcdef0123456789abcdef",
		Nonce:                      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		ReceiptType:                attestation.ReceiptSourceOwnerReady,
		DeploymentID:               "deployment_0123456789abcdef0123456789abcdef",
		KeyID:                      "key_0123456789abcdef0123456789abcdef",
		PredecessorGeneration:      strings.Repeat("1", 40),
		CandidateGeneration:        strings.Repeat("2", 40),
		ExpectedObservedGeneration: strings.Repeat("1", 40),
		ExpectedProfileID:          "ubitech-agent-v1",
		ExpectedCapability:         "source_owner",
		ExpectedStatus:             "idle",
		IssuedAt:                   now.Add(-time.Minute).UTC().Format(time.RFC3339Nano),
		ExpiresAt:                  now.Add(time.Minute).UTC().Format(time.RFC3339Nano),
	}
}

func authorizedTransitionRequest(method, path string, body []byte) *http.Request {
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer 0123456789abcdef0123456789abcdef")
	return request
}

func TestReleaseTransitionControlExposesOnlyAuthenticatedNonSecretObservation(t *testing.T) {
	api := testObservationAPI()
	body, err := json.Marshal(validObservationChallenge(time.Now()))
	if err != nil {
		t.Fatal(err)
	}

	unauthorized := httptest.NewRecorder()
	api.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodPost, "/v1/release-transition/observation", bytes.NewReader(body)))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized observation status=%d", unauthorized.Code)
	}

	response := httptest.NewRecorder()
	api.ServeHTTP(response, authorizedTransitionRequest(http.MethodPost, "/v1/release-transition/observation", body))
	if response.Code != http.StatusOK {
		t.Fatalf("observation status=%d body=%s", response.Code, response.Body.String())
	}
	var observation attestation.Observation
	if err := json.Unmarshal(response.Body.Bytes(), &observation); err != nil {
		t.Fatal(err)
	}
	if observation.Capability != "source_owner" || observation.ManagerSHA256 != strings.Repeat("a", 64) {
		t.Fatalf("unexpected observation: %#v", observation)
	}
	for _, forbidden := range []string{"signature", "private", "public_key", "deployment_id", "key_id"} {
		if strings.Contains(response.Body.String(), forbidden) {
			t.Fatalf("observation leaked attestation material %q: %s", forbidden, response.Body.String())
		}
	}

	for _, path := range []string{"/v1/release-transition/identity", "/v1/release-transition/attest"} {
		removed := httptest.NewRecorder()
		api.ServeHTTP(removed, authorizedTransitionRequest(http.MethodPost, path, body))
		if removed.Code != http.StatusNotFound {
			t.Fatalf("removed signing route %s status=%d body=%s", path, removed.Code, removed.Body.String())
		}
	}
}

func TestReleaseTransitionObservationRejectsUnavailableOversizedAndInvalidChallenge(t *testing.T) {
	missing := &API{ControlToken: "0123456789abcdef0123456789abcdef"}
	response := httptest.NewRecorder()
	responseRequest := authorizedTransitionRequest(http.MethodPost, "/v1/release-transition/observation", []byte(`{}`))
	missing.ServeHTTP(response, responseRequest)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing observer status=%d", response.Code)
	}

	api := testObservationAPI()
	response = httptest.NewRecorder()
	api.ServeHTTP(response, authorizedTransitionRequest(http.MethodPost, "/v1/release-transition/observation", bytes.Repeat([]byte("x"), (32<<10)+1)))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("oversized challenge status=%d", response.Code)
	}

	response = httptest.NewRecorder()
	api.ServeHTTP(response, authorizedTransitionRequest(http.MethodPost, "/v1/release-transition/observation", []byte(`{"schema_version":1,"unknown":true}`)))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid challenge status=%d body=%s", response.Code, response.Body.String())
	}
}
