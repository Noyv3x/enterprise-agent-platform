package control

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handofffd"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handofflisteners"
)

func ownershipChallenge(t *testing.T, role handofflisteners.PublicOwner) handofflisteners.OwnershipChallenge {
	t.Helper()
	challenge := handofflisteners.OwnershipChallenge{
		SchemaVersion: handofflisteners.OwnershipSchemaVersion,
		TransactionID: "handoff_0123456789abcdef0123456789abcdef",
		Role:          role,
		Nonce:         strings.Repeat("a", 64),
		Listeners: []handofffd.ListenerIdentity{
			{Name: "primary", Address: "127.0.0.1:18765"},
		},
	}
	if err := handofflisteners.ValidateOwnershipChallenge(challenge); err != nil {
		t.Fatal(err)
	}
	return challenge
}

func ownershipRequest(t *testing.T, challenge handofflisteners.OwnershipChallenge, token string) *http.Request {
	t.Helper()
	body, err := handofflisteners.EncodeOwnershipChallenge(challenge)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, handofflisteners.OwnershipControlPath, bytes.NewReader(body))
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	return request
}

func TestListenerOwnershipAPIIsOwnerAuthenticatedAndClosedWorld(t *testing.T) {
	challenge := ownershipChallenge(t, handofflisteners.OwnerSource)
	called := 0
	api := &API{
		ControlToken: "control-token-0123456789abcdef",
		OwnershipProof: OwnershipProofProviderFunc(func(_ context.Context, got handofflisteners.OwnershipChallenge) (handofflisteners.OwnershipProof, error) {
			called++
			if got.Nonce != challenge.Nonce || got.TransactionID != challenge.TransactionID {
				t.Fatal("provider received a different challenge")
			}
			return handofflisteners.OwnershipProof{
				SchemaVersion: handofflisteners.OwnershipSchemaVersion,
				TransactionID: got.TransactionID,
				Role:          got.Role,
				Nonce:         got.Nonce,
				Owns:          true,
				Listeners:     append([]handofffd.ListenerIdentity(nil), got.Listeners...),
			}, nil
		}),
	}

	unauthorized := httptest.NewRecorder()
	api.ServeHTTP(unauthorized, ownershipRequest(t, challenge, ""))
	if unauthorized.Code != http.StatusUnauthorized || called != 0 {
		t.Fatalf("unauthorized proof status=%d provider_calls=%d", unauthorized.Code, called)
	}

	response := httptest.NewRecorder()
	api.ServeHTTP(response, ownershipRequest(t, challenge, "control-token-0123456789abcdef"))
	if response.Code != http.StatusOK || called != 1 {
		t.Fatalf("proof status=%d provider_calls=%d body=%s", response.Code, called, response.Body.String())
	}
	proof, err := handofflisteners.DecodeOwnershipProof(challenge, bytes.TrimSpace(response.Body.Bytes()))
	if err != nil || !proof.Owns {
		t.Fatalf("proof=%#v err=%v", proof, err)
	}
}

func TestListenerOwnershipAPIRejectsSpoofedProviderAndInvalidBodies(t *testing.T) {
	challenge := ownershipChallenge(t, handofflisteners.OwnerTarget)
	api := &API{
		ControlToken: "control-token-0123456789abcdef",
		OwnershipProof: OwnershipProofProviderFunc(func(_ context.Context, got handofflisteners.OwnershipChallenge) (handofflisteners.OwnershipProof, error) {
			return handofflisteners.OwnershipProof{
				SchemaVersion: handofflisteners.OwnershipSchemaVersion,
				TransactionID: got.TransactionID,
				Role:          got.Role,
				Nonce:         strings.Repeat("b", 64),
				Listeners:     []handofffd.ListenerIdentity{},
			}, nil
		}),
	}
	spoofed := httptest.NewRecorder()
	api.ServeHTTP(spoofed, ownershipRequest(t, challenge, "control-token-0123456789abcdef"))
	if spoofed.Code != http.StatusConflict {
		t.Fatalf("spoofed provider status=%d body=%s", spoofed.Code, spoofed.Body.String())
	}

	encoded, err := handofflisteners.EncodeOwnershipChallenge(challenge)
	if err != nil {
		t.Fatal(err)
	}
	var object map[string]any
	if err := json.Unmarshal(encoded, &object); err != nil {
		t.Fatal(err)
	}
	object["unknown"] = true
	unknown, _ := json.Marshal(object)
	for name, body := range map[string][]byte{
		"unknown":  unknown,
		"oversize": bytes.Repeat([]byte("x"), handofflisteners.MaximumOwnershipPayloadBytes+1),
		"trailing": append(encoded, []byte(` {}`)...),
	} {
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, handofflisteners.OwnershipControlPath, bytes.NewReader(body))
			request.Header.Set("Authorization", "Bearer control-token-0123456789abcdef")
			response := httptest.NewRecorder()
			api.ServeHTTP(response, request)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestIdentityOnlyControlDoesNotExposeListenerOwnership(t *testing.T) {
	api := &API{
		ControlToken: "control-token-0123456789abcdef",
		IdentityOnly: true,
		OwnershipProof: OwnershipProofProviderFunc(func(context.Context, handofflisteners.OwnershipChallenge) (handofflisteners.OwnershipProof, error) {
			t.Fatal("identity-only API invoked ownership provider")
			return handofflisteners.OwnershipProof{}, nil
		}),
	}
	response := httptest.NewRecorder()
	api.ServeHTTP(response, ownershipRequest(t, ownershipChallenge(t, handofflisteners.OwnerSource), "control-token-0123456789abcdef"))
	if response.Code != http.StatusNotFound {
		t.Fatalf("identity-only ownership route status=%d", response.Code)
	}
}
