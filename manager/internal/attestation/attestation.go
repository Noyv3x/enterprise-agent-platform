//go:build linux

// Package attestation creates owner-authenticated deployment receipts for the
// one-time technical namespace transition. It deliberately has no network
// transport: callers provide an authenticated challenge and move the signed
// result through the release promotion workflow.
package attestation

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

const (
	SchemaVersion = 1
	TransitionID  = "technical-namespace-v1"
	maxJSONBytes  = 32 << 10
	maxTTL        = 5 * time.Minute
)

const (
	ReceiptSourceOwnerReady       = "source_owner_ready"
	ReceiptTargetHandoffCommitted = "target_handoff_committed"
)

var (
	challengeIDPattern = regexp.MustCompile(`^challenge_[0-9a-f]{32}$`)
	noncePattern       = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	identityPattern    = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
	commitPattern      = regexp.MustCompile(`^[0-9a-f]{40}$`)
	shaPattern         = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// Challenge is the exact closed object produced by the serialized promotion
// evaluator. String timestamps are retained so schema validation and signature
// evidence never depend on a lossy JSON time round-trip.
type Challenge struct {
	SchemaVersion              int    `json:"schema_version"`
	TransitionID               string `json:"transition_id"`
	ChallengeID                string `json:"challenge_id"`
	Nonce                      string `json:"nonce"`
	ReceiptType                string `json:"receipt_type"`
	DeploymentID               string `json:"deployment_id"`
	KeyID                      string `json:"key_id"`
	PredecessorGeneration      string `json:"predecessor_generation"`
	CandidateGeneration        string `json:"candidate_generation"`
	ExpectedObservedGeneration string `json:"expected_observed_generation"`
	ExpectedProfileID          string `json:"expected_profile_id"`
	ExpectedCapability         string `json:"expected_capability"`
	ExpectedStatus             string `json:"expected_status"`
	IssuedAt                   string `json:"issued_at"`
	ExpiresAt                  string `json:"expires_at"`
}

// Receipt is signed after the live Manager re-observes all authoritative
// state. Its JSON canonicalization is RFC 8785 for this closed, ASCII-keyed,
// integer/string-only schema.
type Receipt struct {
	SchemaVersion         int    `json:"schema_version"`
	TransitionID          string `json:"transition_id"`
	ChallengeID           string `json:"challenge_id"`
	Nonce                 string `json:"nonce"`
	ReceiptType           string `json:"receipt_type"`
	DeploymentID          string `json:"deployment_id"`
	KeyID                 string `json:"key_id"`
	PredecessorGeneration string `json:"predecessor_generation"`
	CandidateGeneration   string `json:"candidate_generation"`
	ObservedGeneration    string `json:"observed_generation"`
	ProfileID             string `json:"profile_id"`
	Capability            string `json:"capability"`
	Status                string `json:"status"`
	Architecture          string `json:"architecture"`
	ManagerSHA256         string `json:"manager_sha256"`
	EvidenceSHA256        string `json:"evidence_sha256"`
	IssuedAt              string `json:"issued_at"`
	ExpiresAt             string `json:"expires_at"`
}

type Identity struct {
	SchemaVersion int    `json:"schema_version"`
	DeploymentID  string `json:"deployment_id"`
	KeyID         string `json:"key_id"`
	Algorithm     string `json:"algorithm"`
	PublicKey     string `json:"public_key"`
}

type SignedReceipt struct {
	Receipt   Receipt `json:"receipt"`
	Signature string  `json:"signature"`
}

// PublicKeyPEM converts the identity projection into the standard Subject
// Public Key Info PEM consumed by the serialized promotion evaluator.
func PublicKeyPEM(identity Identity) ([]byte, error) {
	if identity.SchemaVersion != SchemaVersion || identity.Algorithm != "Ed25519" ||
		!identityPattern.MatchString(identity.DeploymentID) || !identityPattern.MatchString(identity.KeyID) {
		return nil, errors.New("release transition deployment identity is invalid")
	}
	publicKey, err := base64.StdEncoding.DecodeString(identity.PublicKey)
	if err != nil || len(publicKey) != ed25519.PublicKeySize {
		return nil, errors.New("release transition Ed25519 public key is invalid")
	}
	encoded, err := x509.MarshalPKIXPublicKey(ed25519.PublicKey(publicKey))
	if err != nil {
		return nil, fmt.Errorf("encode release transition Ed25519 public key: %w", err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: encoded}), nil
}

// Observation is a single authoritative snapshot produced by the live
// Manager. EvidenceSHA256 binds the domain-specific state proof without
// exposing operation details or secrets to CI.
type Observation struct {
	ObservedGeneration string `json:"observed_generation"`
	ProfileID          string `json:"profile_id"`
	Capability         string `json:"capability"`
	Status             string `json:"status"`
	ManagerSHA256      string `json:"manager_sha256"`
	EvidenceSHA256     string `json:"evidence_sha256"`
}

type Observer interface {
	ObserveTransition(context.Context, Challenge) (Observation, error)
}

type Service struct {
	Root           string
	StateHome      string
	ForbiddenRoots []string
	Observer       Observer
	Now            func() time.Time

	mu sync.Mutex
}

type persistedReceipt struct {
	SchemaVersion   int           `json:"schema_version"`
	ChallengeSHA256 string        `json:"challenge_sha256"`
	Signed          SignedReceipt `json:"signed"`
}

func DecodeChallenge(data []byte) (Challenge, error) {
	if len(data) == 0 || len(data) > maxJSONBytes {
		return Challenge{}, errors.New("release transition challenge has an invalid size")
	}
	if err := rejectDuplicateJSONFields(data); err != nil {
		return Challenge{}, fmt.Errorf("decode release transition challenge: %w", err)
	}
	decoder := json.NewDecoder(io.LimitReader(bytes.NewReader(data), maxJSONBytes+1))
	decoder.DisallowUnknownFields()
	var challenge Challenge
	if err := decoder.Decode(&challenge); err != nil {
		return Challenge{}, fmt.Errorf("decode release transition challenge: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return Challenge{}, errors.New("decode release transition challenge: trailing JSON value")
		}
		return Challenge{}, fmt.Errorf("decode release transition challenge: %w", err)
	}
	return challenge, nil
}

func rejectDuplicateJSONFields(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := scanJSONValue(decoder); err != nil {
		return err
	}
	if token, err := decoder.Token(); !errors.Is(err, io.EOF) {
		if err == nil {
			return fmt.Errorf("unexpected trailing token %v", token)
		}
		return err
	}
	return nil
}

func scanJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delimiter {
	case '{':
		seen := map[string]struct{}{}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("JSON object key is not a string")
			}
			if _, exists := seen[key]; exists {
				return fmt.Errorf("duplicate JSON field %q", key)
			}
			seen[key] = struct{}{}
			if err := scanJSONValue(decoder); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim('}') {
			return errors.New("unterminated JSON object")
		}
	case '[':
		for decoder.More() {
			if err := scanJSONValue(decoder); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim(']') {
			return errors.New("unterminated JSON array")
		}
	default:
		return fmt.Errorf("unexpected JSON delimiter %q", delimiter)
	}
	return nil
}

func (s *Service) Identity() (Identity, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	root, err := s.openRoot()
	if err != nil {
		return Identity{}, err
	}
	defer root.close()
	_, publicKey, deploymentID, keyID, err := s.material(root)
	if err != nil {
		return Identity{}, err
	}
	if err := root.verify(); err != nil {
		return Identity{}, err
	}
	return Identity{
		SchemaVersion: SchemaVersion,
		DeploymentID:  deploymentID,
		KeyID:         keyID,
		Algorithm:     "Ed25519",
		PublicKey:     base64.StdEncoding.EncodeToString(publicKey),
	}, nil
}

func (s *Service) Attest(ctx context.Context, data []byte) (SignedReceipt, error) {
	challenge, err := DecodeChallenge(data)
	if err != nil {
		return SignedReceipt{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now().UTC()
	_, expires, err := validateChallenge(challenge, now)
	if err != nil {
		return SignedReceipt{}, err
	}
	root, err := s.openRoot()
	if err != nil {
		return SignedReceipt{}, err
	}
	defer root.close()
	privateKey, publicKey, deploymentID, keyID, err := s.material(root)
	if err != nil {
		return SignedReceipt{}, err
	}
	if challenge.DeploymentID != deploymentID || challenge.KeyID != keyID {
		return SignedReceipt{}, errors.New("release transition challenge targets a different deployment key")
	}
	canonicalChallenge, err := CanonicalChallenge(challenge)
	if err != nil {
		return SignedReceipt{}, err
	}
	challengeHash := sha256.Sum256(canonicalChallenge)
	if existing, ok, err := s.existingReceipt(root, challenge, hex.EncodeToString(challengeHash[:]), publicKey); err != nil {
		return SignedReceipt{}, err
	} else if ok {
		return existing, nil
	}
	if s.Observer == nil {
		return SignedReceipt{}, errors.New("release transition observer is unavailable")
	}
	observation, err := s.Observer.ObserveTransition(ctx, challenge)
	if err != nil {
		return SignedReceipt{}, fmt.Errorf("observe release transition state: %w", err)
	}
	if err := validateObservation(challenge, observation); err != nil {
		return SignedReceipt{}, err
	}
	receiptExpiry := expires
	if bounded := now.Add(maxTTL); receiptExpiry.After(bounded) {
		receiptExpiry = bounded
	}
	receipt := Receipt{
		SchemaVersion:         SchemaVersion,
		TransitionID:          TransitionID,
		ChallengeID:           challenge.ChallengeID,
		Nonce:                 challenge.Nonce,
		ReceiptType:           challenge.ReceiptType,
		DeploymentID:          deploymentID,
		KeyID:                 keyID,
		PredecessorGeneration: challenge.PredecessorGeneration,
		CandidateGeneration:   challenge.CandidateGeneration,
		ObservedGeneration:    observation.ObservedGeneration,
		ProfileID:             observation.ProfileID,
		Capability:            observation.Capability,
		Status:                observation.Status,
		Architecture:          runtime.GOARCH,
		ManagerSHA256:         observation.ManagerSHA256,
		EvidenceSHA256:        observation.EvidenceSHA256,
		IssuedAt:              now.Format(time.RFC3339Nano),
		ExpiresAt:             receiptExpiry.UTC().Format(time.RFC3339Nano),
	}
	canonicalReceipt, err := CanonicalReceipt(receipt)
	if err != nil {
		return SignedReceipt{}, err
	}
	signed := SignedReceipt{
		Receipt:   receipt,
		Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, canonicalReceipt)),
	}
	if err := s.persist(root, challenge, canonicalChallenge, hex.EncodeToString(challengeHash[:]), signed); err != nil {
		return SignedReceipt{}, err
	}
	if err := root.verify(); err != nil {
		return SignedReceipt{}, err
	}
	return signed, nil
}

func validateChallenge(challenge Challenge, now time.Time) (time.Time, time.Time, error) {
	if challenge.SchemaVersion != SchemaVersion || challenge.TransitionID != TransitionID {
		return time.Time{}, time.Time{}, errors.New("release transition challenge has an unsupported contract")
	}
	if !challengeIDPattern.MatchString(challenge.ChallengeID) || !noncePattern.MatchString(challenge.Nonce) ||
		!identityPattern.MatchString(challenge.DeploymentID) || !identityPattern.MatchString(challenge.KeyID) ||
		!commitPattern.MatchString(challenge.PredecessorGeneration) || !commitPattern.MatchString(challenge.CandidateGeneration) ||
		!commitPattern.MatchString(challenge.ExpectedObservedGeneration) {
		return time.Time{}, time.Time{}, errors.New("release transition challenge contains an invalid identity")
	}
	if challenge.PredecessorGeneration == challenge.CandidateGeneration {
		return time.Time{}, time.Time{}, errors.New("release transition challenge candidate must follow a distinct predecessor")
	}
	issued, err := time.Parse(time.RFC3339Nano, challenge.IssuedAt)
	if err != nil {
		return time.Time{}, time.Time{}, errors.New("release transition challenge issued_at is invalid")
	}
	expires, err := time.Parse(time.RFC3339Nano, challenge.ExpiresAt)
	if err != nil {
		return time.Time{}, time.Time{}, errors.New("release transition challenge expires_at is invalid")
	}
	issued, expires = issued.UTC(), expires.UTC()
	if !expires.After(issued) || expires.Sub(issued) > maxTTL {
		return time.Time{}, time.Time{}, errors.New("release transition challenge lifetime exceeds the contract")
	}
	if issued.After(now) || !expires.After(now) {
		return time.Time{}, time.Time{}, errors.New("release transition challenge is not currently valid")
	}
	switch challenge.ReceiptType {
	case ReceiptSourceOwnerReady:
		if challenge.ExpectedObservedGeneration != challenge.PredecessorGeneration ||
			challenge.ExpectedProfileID != identity.SourceProfile().ProfileID || challenge.ExpectedCapability != "source_owner" || challenge.ExpectedStatus != "idle" {
			return time.Time{}, time.Time{}, errors.New("source-owner challenge has inconsistent expected state")
		}
	case ReceiptTargetHandoffCommitted:
		if challenge.ExpectedObservedGeneration != challenge.PredecessorGeneration ||
			challenge.ExpectedProfileID != identity.TargetProfile().ProfileID || challenge.ExpectedCapability != "target_owner" || challenge.ExpectedStatus != "committed" {
			return time.Time{}, time.Time{}, errors.New("target-owner challenge has inconsistent expected state")
		}
	default:
		return time.Time{}, time.Time{}, errors.New("release transition challenge has an unsupported receipt_type")
	}
	return issued, expires, nil
}

// ValidateChallengeAt applies the closed release-transition challenge
// contract without accessing deployment key material. It is used by the
// long-running control process before returning a non-secret observation.
func ValidateChallengeAt(challenge Challenge, now time.Time) error {
	_, _, err := validateChallenge(challenge, now.UTC())
	return err
}

func validateObservation(challenge Challenge, observation Observation) error {
	if observation.ObservedGeneration != challenge.ExpectedObservedGeneration ||
		observation.ProfileID != challenge.ExpectedProfileID ||
		observation.Capability != challenge.ExpectedCapability ||
		observation.Status != challenge.ExpectedStatus {
		return errors.New("authoritative deployment state does not satisfy the release transition challenge")
	}
	if !shaPattern.MatchString(observation.ManagerSHA256) || !shaPattern.MatchString(observation.EvidenceSHA256) {
		return errors.New("release transition observation has an invalid evidence digest")
	}
	if runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64" {
		return fmt.Errorf("release transition receipts do not support architecture %s", runtime.GOARCH)
	}
	return nil
}

// ValidateObservation verifies the non-secret authoritative projection before
// it crosses the owner control socket. Receipt signing remains local to the
// short-lived CLI process.
func ValidateObservation(challenge Challenge, observation Observation) error {
	return validateObservation(challenge, observation)
}

func (s *Service) existingReceipt(root *secureStateRoot, challenge Challenge, challengeHash string, publicKey ed25519.PublicKey) (SignedReceipt, bool, error) {
	receiptDirectory, err := openOwnerChildDirectory(root.root, "receipts")
	if errors.Is(err, os.ErrNotExist) {
		return SignedReceipt{}, false, nil
	}
	if err != nil {
		return SignedReceipt{}, false, err
	}
	defer receiptDirectory.close()
	var record persistedReceipt
	err = readOwnerJSONAt(receiptDirectory, challenge.ChallengeID+".json", &record, maxJSONBytes)
	if os.IsNotExist(err) {
		return SignedReceipt{}, false, nil
	}
	if err != nil {
		return SignedReceipt{}, false, err
	}
	if record.SchemaVersion != SchemaVersion || record.ChallengeSHA256 != challengeHash || record.Signed.Receipt.ChallengeID != challenge.ChallengeID {
		return SignedReceipt{}, false, errors.New("release transition challenge id collides with a different persisted receipt")
	}
	expires, err := time.Parse(time.RFC3339Nano, record.Signed.Receipt.ExpiresAt)
	if err != nil || !expires.After(s.now().UTC()) {
		return SignedReceipt{}, false, errors.New("persisted release transition receipt has expired")
	}
	canonical, err := CanonicalReceipt(record.Signed.Receipt)
	if err != nil {
		return SignedReceipt{}, false, err
	}
	signature, err := base64.StdEncoding.DecodeString(record.Signed.Signature)
	if err != nil || !ed25519.Verify(publicKey, canonical, signature) {
		return SignedReceipt{}, false, errors.New("persisted release transition receipt signature is invalid")
	}
	return record.Signed, true, nil
}

func (s *Service) persist(root *secureStateRoot, challenge Challenge, canonicalChallenge []byte, challengeHash string, signed SignedReceipt) error {
	challengeDirectory, err := openOrCreateOwnerDirectory(root.root, "challenges")
	if err != nil {
		return err
	}
	defer challengeDirectory.close()
	receiptDirectory, err := openOrCreateOwnerDirectory(root.root, "receipts")
	if err != nil {
		return err
	}
	defer receiptDirectory.close()
	if err := writeImmutableOwnerFileAt(challengeDirectory, challenge.ChallengeID+".json", append(append([]byte(nil), canonicalChallenge...), '\n')); err != nil {
		return fmt.Errorf("persist release transition challenge: %w", err)
	}
	record := persistedReceipt{SchemaVersion: SchemaVersion, ChallengeSHA256: challengeHash, Signed: signed}
	data, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if err := writeImmutableOwnerFileAt(receiptDirectory, challenge.ChallengeID+".json", data); err != nil {
		return fmt.Errorf("persist release transition receipt: %w", err)
	}
	return nil
}

func (s *Service) material(root *secureStateRoot) (ed25519.PrivateKey, ed25519.PublicKey, string, string, error) {
	keyBytes, err := readOwnerFileAt(root.root, "deployment-ed25519.key", ed25519.PrivateKeySize)
	if os.IsNotExist(err) {
		_, generated, generateErr := ed25519.GenerateKey(rand.Reader)
		if generateErr != nil {
			return nil, nil, "", "", generateErr
		}
		if createErr := writeImmutableOwnerFileAt(root.root, "deployment-ed25519.key", generated); createErr != nil {
			if !errors.Is(createErr, os.ErrExist) {
				return nil, nil, "", "", createErr
			}
		}
		keyBytes, err = readOwnerFileAt(root.root, "deployment-ed25519.key", ed25519.PrivateKeySize)
	}
	if err != nil || len(keyBytes) != ed25519.PrivateKeySize {
		if err == nil {
			err = errors.New("deployment Ed25519 key has an invalid size")
		}
		return nil, nil, "", "", err
	}
	privateKey := ed25519.PrivateKey(append([]byte(nil), keyBytes...))
	publicKey := append(ed25519.PublicKey(nil), privateKey.Public().(ed25519.PublicKey)...)
	publicHash := sha256.Sum256(publicKey)
	keyID := "key_" + hex.EncodeToString(publicHash[:16])

	deploymentBytes, err := readOwnerFileAt(root.root, "deployment-id", 128)
	if os.IsNotExist(err) {
		random := make([]byte, 16)
		if _, randomErr := io.ReadFull(rand.Reader, random); randomErr != nil {
			return nil, nil, "", "", randomErr
		}
		generated := []byte("deployment_" + hex.EncodeToString(random) + "\n")
		if createErr := writeImmutableOwnerFileAt(root.root, "deployment-id", generated); createErr != nil && !errors.Is(createErr, os.ErrExist) {
			return nil, nil, "", "", createErr
		}
		deploymentBytes, err = readOwnerFileAt(root.root, "deployment-id", 128)
	}
	if err != nil {
		return nil, nil, "", "", err
	}
	deploymentID := strings.TrimSpace(string(deploymentBytes))
	if !identityPattern.MatchString(deploymentID) || !strings.HasPrefix(deploymentID, "deployment_") {
		return nil, nil, "", "", errors.New("deployment id is invalid")
	}
	return privateKey, publicKey, deploymentID, keyID, nil
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// CanonicalChallenge returns RFC 8785 bytes for the closed challenge schema.
func CanonicalChallenge(value Challenge) ([]byte, error) {
	return canonicalObject([]canonicalField{
		{"candidate_generation", value.CandidateGeneration},
		{"challenge_id", value.ChallengeID},
		{"deployment_id", value.DeploymentID},
		{"expected_capability", value.ExpectedCapability},
		{"expected_observed_generation", value.ExpectedObservedGeneration},
		{"expected_profile_id", value.ExpectedProfileID},
		{"expected_status", value.ExpectedStatus},
		{"expires_at", value.ExpiresAt},
		{"issued_at", value.IssuedAt},
		{"key_id", value.KeyID},
		{"nonce", value.Nonce},
		{"predecessor_generation", value.PredecessorGeneration},
		{"receipt_type", value.ReceiptType},
		{"schema_version", value.SchemaVersion},
		{"transition_id", value.TransitionID},
	})
}

// CanonicalReceipt returns the exact bytes covered by the Ed25519 signature.
func CanonicalReceipt(value Receipt) ([]byte, error) {
	return canonicalObject([]canonicalField{
		{"architecture", value.Architecture},
		{"candidate_generation", value.CandidateGeneration},
		{"capability", value.Capability},
		{"challenge_id", value.ChallengeID},
		{"deployment_id", value.DeploymentID},
		{"evidence_sha256", value.EvidenceSHA256},
		{"expires_at", value.ExpiresAt},
		{"issued_at", value.IssuedAt},
		{"key_id", value.KeyID},
		{"manager_sha256", value.ManagerSHA256},
		{"nonce", value.Nonce},
		{"observed_generation", value.ObservedGeneration},
		{"predecessor_generation", value.PredecessorGeneration},
		{"profile_id", value.ProfileID},
		{"receipt_type", value.ReceiptType},
		{"schema_version", value.SchemaVersion},
		{"status", value.Status},
		{"transition_id", value.TransitionID},
	})
}

type canonicalField struct {
	name  string
	value any
}

func canonicalObject(fields []canonicalField) ([]byte, error) {
	var buffer bytes.Buffer
	buffer.WriteByte('{')
	for index, field := range fields {
		if index > 0 {
			buffer.WriteByte(',')
		}
		name, _ := json.Marshal(field.name)
		value, err := json.Marshal(field.value)
		if err != nil {
			return nil, err
		}
		buffer.Write(name)
		buffer.WriteByte(':')
		buffer.Write(value)
	}
	buffer.WriteByte('}')
	return buffer.Bytes(), nil
}
