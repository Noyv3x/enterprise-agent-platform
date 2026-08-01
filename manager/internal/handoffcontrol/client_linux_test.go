//go:build linux

package handoffcontrol

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/control"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handofffd"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handofflisteners"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

const (
	testSHA256 = "1111111111111111111111111111111111111111111111111111111111111111"
	testOld    = "1111111111111111111111111111111111111111"
	testNew    = "2222222222222222222222222222222222222222"
)

func shortRoot(t *testing.T) string {
	t.Helper()
	root, err := os.MkdirTemp("/tmp", "hc-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	return root
}

func ownershipJournal(t *testing.T, sourceSocket string) handoff.Journal {
	t.Helper()
	sourceRoot := filepath.Dir(filepath.Dir(filepath.Dir(sourceSocket)))
	root := filepath.Dir(sourceRoot)
	targetRoot := filepath.Join(root, "agent-platform")
	for _, path := range []string{sourceRoot, targetRoot} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	journal, err := handoff.NewJournal(
		handoff.ReleaseBinding{
			PredecessorGeneration: testOld,
			BridgeGeneration:      testNew,
			ManifestPath:          filepath.Join(identity.SourceProfile().ManagerStateRoot(sourceRoot), "releases", testNew, "manifest.json"),
			ManifestSHA256:        testSHA256,
			TargetManagerSHA256:   strings.Repeat("2", 64),
			TargetManagerVersion:  testNew,
			TargetComposeSHA256:   strings.Repeat("3", 64),
		},
		handoff.SourceBinding{
			Namespace: "ubitech-agent-v1", Unit: "ubitech-agent-manager.service", UnitEnabled: true,
			UnitPath: filepath.Join(root, "systemd", "ubitech-agent-manager.service"), UnitSHA256: testSHA256,
			StableBinary: filepath.Join(root, "bin", "ubitech-manager"), StableSHA256: testSHA256,
			ConfigPath: filepath.Join(root, "config", "ubitech-agent", "manager.toml"), ConfigSHA256: testSHA256,
			ManifestPath: filepath.Join(identity.SourceProfile().ManagerStateRoot(sourceRoot), "releases", testOld, "manifest.json"), ManifestSHA256: testSHA256,
			ComposePath: filepath.Join(identity.SourceProfile().ManagerStateRoot(sourceRoot), "releases", testOld, "compose.yaml"), ComposeSHA256: testSHA256,
			DataRoot: sourceRoot, SocketPath: sourceSocket, ComposeProject: "ubitech-agent",
			CoreNetwork: "ubitech-agent_core", CoreNetworkID: strings.Repeat("c", 64), LabelPrefix: "org.ubitech.agent",
		},
		handoff.TargetBinding{
			Namespace: "agent-platform-v1", Unit: "agent-platform-manager.service",
			UnitPath: filepath.Join(root, "systemd", "agent-platform-manager.service"), StableBinary: filepath.Join(root, "bin", "agent-platform-manager"),
			ConfigPath: filepath.Join(root, "config", "agent-platform", "manager.toml"), ConfigSHA256: testSHA256, DataRoot: targetRoot,
			SocketPath: filepath.Join(root, "runtime", "agent-platform-manager", "manager.sock"), ComposeProject: "agent-platform",
			CoreNetwork: "agent-platform_core", LabelPrefix: "io.agent-platform",
		},
		handoff.Evidence{
			ManagerStateSHA256: testSHA256, SelfUpdateStateSHA256: testSHA256, SandboxRegistrySHA256: testSHA256,
			DockerInventorySHA256: testSHA256, DatabaseSchemaVersion: 27, DatabaseIntegrity: "ok",
			RuntimeIdentitySHA256: testSHA256, WorkspaceIdentitySHA256: testSHA256,
			BootID: "12345678-1234-1234-1234-123456789abc",
		},
		time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC),
	)
	if err != nil {
		t.Fatal(err)
	}
	return journal
}

func testChallenge(journal handoff.Journal, role handofflisteners.PublicOwner) handofflisteners.OwnershipChallenge {
	return handofflisteners.OwnershipChallenge{
		SchemaVersion: handofflisteners.OwnershipSchemaVersion,
		TransactionID: journal.TransactionID,
		Role:          role,
		Nonce:         strings.Repeat("a", 64),
		Listeners: []handofffd.ListenerIdentity{
			{Name: "primary", Address: "127.0.0.1:18765"},
		},
	}
}

func writeToken(t *testing.T, path, value string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := atomicfile.WriteFile(path, []byte(value+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func serveControl(t *testing.T, socketPath string, handler http.Handler) func() {
	t.Helper()
	listener, err := control.Listen(socketPath)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: handler, ReadHeaderTimeout: time.Second}
	go func() { _ = server.Serve(listener) }()
	return func() { _ = server.Close() }
}

func endpointResolver(socketPath, tokenFile string, pid int) EndpointResolver {
	return EndpointResolverFunc(func(_ context.Context, journal handoff.Journal, role handofflisteners.PublicOwner) (Endpoint, error) {
		return Endpoint{
			SocketPath: socketPath,
			TokenFile:  tokenFile,
			PID:        pid,
		}, nil
	})
}

func TestClientGetsStrictProofFromJournalBoundAuthenticatedPeer(t *testing.T) {
	directory := filepath.Join(shortRoot(t), "ubitech-agent", "manager", "control")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	socketPath := filepath.Join(directory, "manager.sock")
	tokenFile := filepath.Join(t.TempDir(), "secrets", "manager-token")
	token := "control-token-0123456789abcdef0123456789abcdef"
	writeToken(t, tokenFile, token)
	api := &control.API{
		ControlToken: token,
		OwnershipProof: control.OwnershipProofProviderFunc(func(_ context.Context, challenge handofflisteners.OwnershipChallenge) (handofflisteners.OwnershipProof, error) {
			return handofflisteners.BuildOwnershipProof(challenge, handofflisteners.OwnerSource, nil)
		}),
	}
	stop := serveControl(t, socketPath, api)
	defer stop()
	journal := ownershipJournal(t, socketPath)
	challenge := testChallenge(journal, handofflisteners.OwnerSource)
	client := Client{Resolver: endpointResolver(socketPath, tokenFile, os.Getpid()), Timeout: time.Second}
	proof, err := client.Challenge(context.Background(), journal, handofflisteners.OwnerSource, challenge)
	if err != nil {
		t.Fatal(err)
	}
	if proof.Owns || proof.Listeners == nil || len(proof.Listeners) != 0 || proof.Nonce != challenge.Nonce {
		t.Fatalf("unexpected ownership proof: %#v", proof)
	}
}

func TestClientRejectsSpoofPeerBeforeSendingToken(t *testing.T) {
	directory := filepath.Join(shortRoot(t), "ubitech-agent", "manager", "control")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	socketPath := filepath.Join(directory, "manager.sock")
	tokenFile := filepath.Join(t.TempDir(), "secrets", "manager-token")
	writeToken(t, tokenFile, "control-token-0123456789abcdef0123456789abcdef")
	var requests atomic.Int32
	stop := serveControl(t, socketPath, http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		response.WriteHeader(http.StatusOK)
	}))
	defer stop()
	journal := ownershipJournal(t, socketPath)
	client := Client{Resolver: endpointResolver(socketPath, tokenFile, os.Getpid()+1000), Timeout: time.Second}
	_, err := client.Challenge(context.Background(), journal, handofflisteners.OwnerSource, testChallenge(journal, handofflisteners.OwnerSource))
	if err == nil || errors.Is(err, handofflisteners.ErrOwnershipControlUnavailable) {
		t.Fatalf("spoof peer error = %v", err)
	}
	if requests.Load() != 0 {
		t.Fatal("ownership token was sent before peer PID verification")
	}
}

func TestClientNeverClassifiesAuthenticationTimeoutOrInvalidJSONAsAbsent(t *testing.T) {
	for name, handler := range map[string]http.Handler{
		"authentication": http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
			http.Error(response, "no", http.StatusUnauthorized)
		}),
		"invalid-json": http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
			response.WriteHeader(http.StatusOK)
			_, _ = response.Write([]byte(`{"schema_version":1,"unknown":true}`))
		}),
		"oversize": http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
			response.WriteHeader(http.StatusOK)
			_, _ = response.Write([]byte(strings.Repeat("x", handofflisteners.MaximumOwnershipPayloadBytes+1)))
		}),
		"timeout": http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			<-request.Context().Done()
		}),
	} {
		t.Run(name, func(t *testing.T) {
			directory := filepath.Join(shortRoot(t), "ubitech-agent", "manager", "control")
			if err := os.MkdirAll(directory, 0o700); err != nil {
				t.Fatal(err)
			}
			socketPath := filepath.Join(directory, "manager.sock")
			tokenFile := filepath.Join(t.TempDir(), "secrets", "manager-token")
			writeToken(t, tokenFile, "control-token-0123456789abcdef0123456789abcdef")
			stop := serveControl(t, socketPath, handler)
			defer stop()
			journal := ownershipJournal(t, socketPath)
			timeout := time.Second
			if name == "timeout" {
				timeout = 30 * time.Millisecond
			}
			client := Client{Resolver: endpointResolver(socketPath, tokenFile, os.Getpid()), Timeout: timeout}
			_, err := client.Challenge(context.Background(), journal, handofflisteners.OwnerSource, testChallenge(journal, handofflisteners.OwnerSource))
			if err == nil || errors.Is(err, handofflisteners.ErrOwnershipControlUnavailable) {
				t.Fatalf("error = %v, want non-absent failure", err)
			}
		})
	}
}

func TestClientRequiresProvenProcessAbsenceAndExactEndpointState(t *testing.T) {
	root := shortRoot(t)
	directory := filepath.Join(root, "ubitech-agent", "manager", "control")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	socketPath := filepath.Join(directory, "manager.sock")
	tokenFile := filepath.Join(root, "secrets", "manager-token")
	journal := ownershipJournal(t, socketPath)
	challenge := testChallenge(journal, handofflisteners.OwnerSource)
	resolver := EndpointResolverFunc(func(context.Context, handoff.Journal, handofflisteners.PublicOwner) (Endpoint, error) {
		return Endpoint{
			SocketPath:    socketPath,
			TokenFile:     tokenFile,
			ProcessAbsent: true,
		}, nil
	})
	client := Client{Resolver: resolver, Timeout: time.Second}
	if _, err := client.Challenge(context.Background(), journal, handofflisteners.OwnerSource, challenge); !errors.Is(err, handofflisteners.ErrOwnershipControlUnavailable) {
		t.Fatalf("missing proven-absent endpoint error = %v", err)
	}

	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socketPath, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	listener.SetUnlinkOnClose(false)
	if err := os.Chmod(socketPath, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(socketPath)
	if _, err := client.Challenge(context.Background(), journal, handofflisteners.OwnerSource, challenge); !errors.Is(err, handofflisteners.ErrOwnershipControlUnavailable) {
		t.Fatalf("stale proven-absent endpoint error = %v", err)
	}

	if err := os.Remove(socketPath); err != nil {
		t.Fatal(err)
	}
	live, err := net.ListenUnix("unix", &net.UnixAddr{Name: socketPath, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer live.Close()
	if err := os.Chmod(socketPath, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Challenge(context.Background(), journal, handofflisteners.OwnerSource, challenge); err == nil || errors.Is(err, handofflisteners.ErrOwnershipControlUnavailable) {
		t.Fatalf("live endpoint under absent process proof error = %v", err)
	}
}
