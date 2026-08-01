//go:build linux

package handoffhelper

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testParticipantChallenge() ParticipantChallenge {
	return ParticipantChallenge{
		SchemaVersion: participantProtocolSchema,
		TransactionID: "handoff_0123456789abcdef0123456789abcdef",
		Revision:      7,
		BindingSHA256: strings.Repeat("a", 64),
		Role:          ParticipantSource,
		Nonce:         strings.Repeat("b", 64),
	}
}

func testParticipantObservation(challenge ParticipantChallenge, socket string) ParticipantObservation {
	observation := ParticipantObservation{
		SchemaVersion: participantProtocolSchema, TransactionID: challenge.TransactionID,
		StartupRevision: challenge.Revision, BindingSHA256: challenge.BindingSHA256,
		Role: challenge.Role, Nonce: challenge.Nonce, ManagerVersion: testPredecessor,
		SourceCommit: testPredecessor, ExecutableSHA256: testSourceSHA, PID: os.Getpid(),
		SocketPath: socket, CoreReady: true, PublicListenerOwned: true,
		IssuedAt: time.Now().UTC(),
	}
	observation.ProofSHA256, _ = ComputeParticipantProof(observation)
	return observation
}

func TestParticipantCodecsRejectUnknownDuplicateTrailingAndOversizedJSON(t *testing.T) {
	challenge := testParticipantChallenge()
	encoded, err := json.Marshal(challenge)
	if err != nil {
		t.Fatal(err)
	}
	if decoded, err := DecodeParticipantChallenge(bytes.NewReader(encoded)); err != nil || decoded != challenge {
		t.Fatalf("challenge round trip = %+v, %v", decoded, err)
	}
	for _, malformed := range [][]byte{
		bytes.Replace(encoded, []byte(`"revision":7`), []byte(`"revision":7,"revision":7`), 1),
		bytes.Replace(encoded, []byte(`"revision":7`), []byte(`"revision":7,"unknown":true`), 1),
		append(append([]byte(nil), encoded...), []byte(` {}`)...),
		bytes.Repeat([]byte("x"), maxParticipantRequest+1),
	} {
		if _, err := DecodeParticipantChallenge(bytes.NewReader(malformed)); err == nil {
			t.Fatalf("accepted malformed challenge: %.100q", malformed)
		}
	}
	observation := testParticipantObservation(challenge, filepath.Join(t.TempDir(), "manager.sock"))
	response, err := EncodeParticipantObservation(observation)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeParticipantObservation(bytes.NewReader(response))
	if err != nil || ValidateParticipantObservation(challenge, decoded) != nil {
		t.Fatalf("observation round trip: %v", err)
	}
}

func TestUnixParticipantObserverBindsTokenFileSocketInodeAndPeerPID(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(root, "participant.sock")
	tokenPath := filepath.Join(root, "token")
	if err := os.WriteFile(tokenPath, []byte("secret-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	server := &http.Server{Handler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != ParticipantObservePath || request.Header.Get("Authorization") != "Bearer secret-token" {
			http.Error(writer, "forbidden", http.StatusForbidden)
			return
		}
		challenge, err := DecodeParticipantChallenge(request.Body)
		if err != nil {
			http.Error(writer, err.Error(), http.StatusBadRequest)
			return
		}
		encoded, err := EncodeParticipantObservation(testParticipantObservation(challenge, socket))
		if err != nil {
			http.Error(writer, err.Error(), http.StatusInternalServerError)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write(encoded)
	})}
	defer server.Close()
	go func() { _ = server.Serve(listener) }()
	resolver := ParticipantControlResolverFunc(func(context.Context, ParticipantRole) (ParticipantControlBinding, error) {
		return ParticipantControlBinding{SocketPath: socket, TokenPath: tokenPath, MainPID: os.Getpid()}, nil
	})
	observer := UnixParticipantObserver{Resolver: resolver, Timeout: time.Second}
	challenge := testParticipantChallenge()
	if _, err := observer.Observe(context.Background(), challenge.Role, challenge); err != nil {
		t.Fatal(err)
	}
	observer.Resolver = ParticipantControlResolverFunc(func(context.Context, ParticipantRole) (ParticipantControlBinding, error) {
		return ParticipantControlBinding{SocketPath: socket, TokenPath: tokenPath, MainPID: os.Getpid() + 10000}, nil
	})
	if _, err := observer.Observe(context.Background(), challenge.Role, challenge); err == nil || !strings.Contains(err.Error(), "MainPID") {
		t.Fatalf("wrong peer PID error = %v", err)
	}
}
