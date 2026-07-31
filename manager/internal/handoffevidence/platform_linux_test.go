//go:build linux

package handoffevidence

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPlatformClientUsesAuthenticatedBoundedClosedEvidence(t *testing.T) {
	payload, err := json.Marshal(validPlatformEvidence())
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/internal/manager/handoff/evidence" || request.Header.Get("Authorization") != "Bearer secret" {
			http.Error(writer, "unauthorized", http.StatusUnauthorized)
			return
		}
		_, _ = writer.Write(payload)
	}))
	defer server.Close()
	client := PlatformClient{BaseURL: server.URL, Token: "secret", HTTP: server.Client()}
	value, err := client.Evidence(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !value.idle() || !value.RuntimeSchemaReady || value.TechnicalProfile != "ubitech-agent-v1" {
		t.Fatalf("unexpected Platform evidence: %+v", value)
	}
}

func TestPlatformClientRejectsDuplicateUnknownAndOversizedJSON(t *testing.T) {
	valid, err := json.Marshal(validPlatformEvidence())
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string][]byte{
		"duplicate": append(valid[:len(valid)-1], []byte(`,"schema_version":1}`)...),
		"unknown":   append(valid[:len(valid)-1], []byte(`,"future":true}`)...),
		"oversized": []byte(`{"padding":"` + strings.Repeat("x", int(maxPlatformEvidenceBytes)) + `"}`),
	}
	for name, payload := range cases {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				_, _ = writer.Write(payload)
			}))
			defer server.Close()
			client := PlatformClient{BaseURL: server.URL, Token: "secret", HTTP: server.Client()}
			if _, err := client.Evidence(context.Background()); err == nil {
				t.Fatal("invalid Platform evidence was accepted")
			}
		})
	}
}

func validPlatformEvidence() PlatformEvidence {
	return PlatformEvidence{
		SchemaVersion: 1, TechnicalProfile: "ubitech-agent-v1", DatabaseSchemaVersion: 7,
		DatabaseIntegrity: "ok", DatabaseForeignKeys: "ok", PlatformReservationIdle: true,
		RuntimeSchemaReady: true, WorkspaceSchemaReady: true, CamofoxSchemaReady: true,
		RuntimeIdentitySHA256: strings.Repeat("a", 64), WorkspaceIdentitySHA256: strings.Repeat("b", 64),
	}
}
