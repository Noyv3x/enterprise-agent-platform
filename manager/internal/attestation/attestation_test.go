//go:build linux

package attestation

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
)

type observationFunc func(context.Context, Challenge) (Observation, error)

func (function observationFunc) ObserveTransition(ctx context.Context, challenge Challenge) (Observation, error) {
	return function(ctx, challenge)
}

func testService(t *testing.T, now time.Time) (*Service, *int) {
	t.Helper()
	root := t.TempDir()
	stateHome := filepath.Join(root, "state")
	if err := os.MkdirAll(stateHome, 0o700); err != nil {
		t.Fatal(err)
	}
	count := 0
	service := &Service{
		Root:           filepath.Join(stateHome, "agent-platform", "release-transition"),
		StateHome:      stateHome,
		ForbiddenRoots: []string{filepath.Join(root, "source-data"), filepath.Join(root, "target-data")},
		Now:            func() time.Time { return now },
		Observer: observationFunc(func(_ context.Context, challenge Challenge) (Observation, error) {
			count++
			return Observation{
				ObservedGeneration: challenge.ExpectedObservedGeneration,
				ProfileID:          challenge.ExpectedProfileID,
				Capability:         challenge.ExpectedCapability,
				Status:             challenge.ExpectedStatus,
				ManagerSHA256:      strings.Repeat("a", 64),
				EvidenceSHA256:     strings.Repeat("b", 64),
			}, nil
		}),
	}
	return service, &count
}

func testChallenge(t *testing.T, service *Service, now time.Time) Challenge {
	t.Helper()
	identity, err := service.Identity()
	if err != nil {
		t.Fatal(err)
	}
	return Challenge{
		SchemaVersion:              SchemaVersion,
		TransitionID:               TransitionID,
		ChallengeID:                "challenge_0123456789abcdef0123456789abcdef",
		Nonce:                      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		ReceiptType:                ReceiptSourceOwnerReady,
		DeploymentID:               identity.DeploymentID,
		KeyID:                      identity.KeyID,
		PredecessorGeneration:      strings.Repeat("1", 40),
		CandidateGeneration:        strings.Repeat("2", 40),
		ExpectedObservedGeneration: strings.Repeat("1", 40),
		ExpectedProfileID:          "ubitech-agent-v1",
		ExpectedCapability:         "source_owner",
		ExpectedStatus:             "idle",
		IssuedAt:                   now.Add(-time.Minute).Format(time.RFC3339Nano),
		ExpiresAt:                  now.Add(4 * time.Minute).Format(time.RFC3339Nano),
	}
}

func TestAttestSignsCanonicalReceiptAndPersistsIdempotently(t *testing.T) {
	now := time.Date(2026, 7, 31, 11, 0, 0, 123, time.UTC)
	service, observations := testService(t, now)
	challenge := testChallenge(t, service, now)
	data, err := json.MarshalIndent(challenge, "", "  ")
	if err != nil {
		t.Fatal(err)
	}

	first, err := service.Attest(context.Background(), data)
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.Attest(context.Background(), data)
	if err != nil {
		t.Fatal(err)
	}
	if first != second || *observations != 1 {
		t.Fatalf("attestation was not idempotent: first=%#v second=%#v observations=%d", first, second, *observations)
	}
	if first.Receipt.Architecture != runtime.GOARCH || first.Receipt.ObservedGeneration != challenge.PredecessorGeneration {
		t.Fatalf("unexpected receipt: %#v", first.Receipt)
	}
	identity, err := service.Identity()
	if err != nil {
		t.Fatal(err)
	}
	publicKey, err := base64.StdEncoding.DecodeString(identity.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	signature, err := base64.StdEncoding.DecodeString(first.Signature)
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := CanonicalReceipt(first.Receipt)
	if err != nil {
		t.Fatal(err)
	}
	if !ed25519.Verify(publicKey, canonical, signature) {
		t.Fatal("receipt signature does not verify")
	}

	for _, path := range []string{
		filepath.Join(service.Root, "deployment-ed25519.key"),
		filepath.Join(service.Root, "deployment-id"),
		filepath.Join(service.Root, "challenges", challenge.ChallengeID+".json"),
		filepath.Join(service.Root, "receipts", challenge.ChallengeID+".json"),
	} {
		info, err := os.Lstat(path)
		if err != nil {
			t.Fatal(err)
		}
		if !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
			t.Fatalf("unsafe persisted attestation file %s: %v", path, info.Mode())
		}
	}
}

func TestCanonicalReceiptUsesRFC8785PropertyOrder(t *testing.T) {
	receipt := Receipt{
		SchemaVersion: 1, TransitionID: "technical-namespace-v1", ChallengeID: "challenge_0123456789abcdef0123456789abcdef",
		Nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", ReceiptType: "source_owner_ready", DeploymentID: "deployment_a",
		KeyID: "key_a", PredecessorGeneration: strings.Repeat("1", 40), CandidateGeneration: strings.Repeat("2", 40),
		ObservedGeneration: strings.Repeat("1", 40), ProfileID: "ubitech-agent-v1", Capability: "source_owner", Status: "idle",
		Architecture: "amd64", ManagerSHA256: strings.Repeat("a", 64), EvidenceSHA256: strings.Repeat("b", 64),
		IssuedAt: "2026-07-31T11:00:00Z", ExpiresAt: "2026-07-31T11:05:00Z",
	}
	canonical, err := CanonicalReceipt(receipt)
	if err != nil {
		t.Fatal(err)
	}
	wantPrefix := `{"architecture":"amd64","candidate_generation":"`
	wantSuffix := `,"status":"idle","transition_id":"technical-namespace-v1"}`
	if !strings.HasPrefix(string(canonical), wantPrefix) || !strings.HasSuffix(string(canonical), wantSuffix) {
		t.Fatalf("canonical order is wrong: %s", canonical)
	}
}

func TestPublicKeyPEMRoundTrip(t *testing.T) {
	service, _ := testService(t, time.Date(2026, 7, 31, 11, 0, 0, 0, time.UTC))
	identity, err := service.Identity()
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := PublicKeyPEM(identity)
	if err != nil {
		t.Fatal(err)
	}
	block, rest := pem.Decode(encoded)
	if block == nil || block.Type != "PUBLIC KEY" || len(rest) != 0 {
		t.Fatalf("invalid public key PEM: %q", encoded)
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	want, _ := base64.StdEncoding.DecodeString(identity.PublicKey)
	if got, ok := parsed.(ed25519.PublicKey); !ok || !bytes.Equal(got, want) {
		t.Fatalf("PEM key = %T %x, want %x", parsed, got, want)
	}
}

func TestDecodeChallengeRejectsUnknownAndTrailingFields(t *testing.T) {
	for name, data := range map[string]string{
		"unknown":   `{"schema_version":1,"unexpected":true}`,
		"duplicate": `{"schema_version":1,"schema_version":1}`,
		"trailing":  `{} {}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := DecodeChallenge([]byte(data)); err == nil {
				t.Fatal("unsafe challenge was accepted")
			}
		})
	}
}

func TestAttestRejectsExpiredCollisionAndObservationMismatch(t *testing.T) {
	now := time.Date(2026, 7, 31, 11, 0, 0, 0, time.UTC)
	service, _ := testService(t, now)
	challenge := testChallenge(t, service, now)

	expired := challenge
	expired.IssuedAt = now.Add(-6 * time.Minute).Format(time.RFC3339Nano)
	expired.ExpiresAt = now.Add(-time.Minute).Format(time.RFC3339Nano)
	data, _ := json.Marshal(expired)
	if _, err := service.Attest(context.Background(), data); err == nil || !strings.Contains(err.Error(), "not currently valid") {
		t.Fatalf("expired challenge result: %v", err)
	}

	future := challenge
	future.IssuedAt = now.Add(time.Second).Format(time.RFC3339Nano)
	future.ExpiresAt = now.Add(4 * time.Minute).Format(time.RFC3339Nano)
	data, _ = json.Marshal(future)
	if _, err := service.Attest(context.Background(), data); err == nil || !strings.Contains(err.Error(), "not currently valid") {
		t.Fatalf("future challenge result: %v", err)
	}

	data, _ = json.Marshal(challenge)
	if _, err := service.Attest(context.Background(), data); err != nil {
		t.Fatal(err)
	}
	collision := challenge
	collision.Nonce = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
	data, _ = json.Marshal(collision)
	if _, err := service.Attest(context.Background(), data); err == nil || !strings.Contains(err.Error(), "collides") {
		t.Fatalf("challenge collision result: %v", err)
	}

	other, _ := testService(t, now)
	otherChallenge := testChallenge(t, other, now)
	other.Observer = observationFunc(func(context.Context, Challenge) (Observation, error) {
		return Observation{
			ObservedGeneration: strings.Repeat("9", 40), ProfileID: "ubitech-agent-v1", Capability: "source_owner", Status: "idle",
			ManagerSHA256: strings.Repeat("a", 64), EvidenceSHA256: strings.Repeat("b", 64),
		}, nil
	})
	data, _ = json.Marshal(otherChallenge)
	if _, err := other.Attest(context.Background(), data); err == nil || !strings.Contains(err.Error(), "does not satisfy") {
		t.Fatalf("observation mismatch result: %v", err)
	}
}

func TestIdentityRejectsDataRootOverlapAndSymlinkRootWithoutWritingThrough(t *testing.T) {
	root := t.TempDir()
	stateHome := filepath.Join(root, "state")
	if err := os.MkdirAll(stateHome, 0o700); err != nil {
		t.Fatal(err)
	}
	overlap := &Service{
		StateHome: stateHome,
		Root:      filepath.Join(stateHome, "agent-platform", "release-transition"),
		ForbiddenRoots: []string{
			filepath.Join(stateHome, "agent-platform"),
		},
	}
	if _, err := overlap.Identity(); err == nil || !strings.Contains(err.Error(), "overlaps") {
		t.Fatalf("overlapping root result: %v", err)
	}

	external := filepath.Join(root, "external")
	if err := os.Mkdir(external, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, filepath.Join(stateHome, "agent-platform")); err != nil {
		t.Fatal(err)
	}
	service := &Service{StateHome: stateHome, Root: filepath.Join(stateHome, "agent-platform", "release-transition")}
	if _, err := service.Identity(); err == nil {
		t.Fatal("symlinked state root was accepted")
	}
	if _, err := os.Lstat(filepath.Join(external, "release-transition")); !os.IsNotExist(err) {
		t.Fatalf("validation wrote through a symlink before rejecting it: %v", err)
	}
}

func TestAttestRejectsSymlinkedEvidenceDirectoryWithoutWritingThrough(t *testing.T) {
	now := time.Date(2026, 7, 31, 11, 0, 0, 0, time.UTC)
	service, _ := testService(t, now)
	challenge := testChallenge(t, service, now)
	external := filepath.Join(t.TempDir(), "external")
	if err := os.Mkdir(external, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, filepath.Join(service.Root, "receipts")); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(challenge)
	if _, err := service.Attest(context.Background(), data); err == nil {
		t.Fatal("symlinked receipt directory was accepted")
	}
	entries, err := os.ReadDir(external)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("attestation wrote through symlinked receipt directory: %v", entries)
	}
}

func TestAttestationInodeAwareCleanupPreservesReplacement(t *testing.T) {
	service, _ := testService(t, time.Date(2026, 7, 31, 11, 0, 0, 0, time.UTC))
	root, err := service.openRoot()
	if err != nil {
		t.Fatal(err)
	}
	defer root.close()
	directory, err := openOrCreateOwnerDirectory(root.root, "receipts")
	if err != nil {
		t.Fatal(err)
	}
	defer directory.close()
	name := "challenge_0123456789abcdef0123456789abcdef.json"
	if err := writeImmutableOwnerFileAt(directory, name, []byte("original\n")); err != nil {
		t.Fatal(err)
	}
	fd, err := syscall.Openat(int(directory.file.Fd()), name, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		t.Fatal(err)
	}
	original, err := validateOwnerFileDescriptor(fd, 0o600)
	_ = syscall.Close(fd)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(directory.path, name), filepath.Join(directory.path, "moved")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory.path, name), []byte("replacement\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := unlinkOwnedIdentityAt(directory, name, original); err == nil {
		t.Fatal("inode-aware cleanup removed or accepted a replacement")
	}
	data, err := os.ReadFile(filepath.Join(directory.path, name))
	if err != nil || string(data) != "replacement\n" {
		t.Fatalf("replacement after cleanup = %q, %v", data, err)
	}
}

func TestIdentityRejectsUnsafeExistingStateNamespaceInsteadOfRepairingIt(t *testing.T) {
	stateHome := filepath.Join(t.TempDir(), "state")
	if err := os.MkdirAll(filepath.Join(stateHome, "agent-platform"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(stateHome, "agent-platform"), 0o755); err != nil {
		t.Fatal(err)
	}
	service := &Service{StateHome: stateHome, Root: filepath.Join(stateHome, "agent-platform", "release-transition")}
	if _, err := service.Identity(); err == nil {
		t.Fatal("pre-existing state namespace with broad permissions was repaired or accepted")
	}
	info, err := os.Stat(filepath.Join(stateHome, "agent-platform"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o755 {
		t.Fatalf("unsafe pre-existing directory was mutated to %o", info.Mode().Perm())
	}
}

func TestIdentityRejectsHardLinkedPrivateMaterial(t *testing.T) {
	service, _ := testService(t, time.Date(2026, 7, 31, 11, 0, 0, 0, time.UTC))
	if _, err := service.Identity(); err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(service.Root, "deployment-ed25519.key")
	if err := os.Link(keyPath, filepath.Join(service.Root, "key-copy")); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Identity(); err == nil {
		t.Fatal("hard-linked deployment key was accepted")
	}
}
