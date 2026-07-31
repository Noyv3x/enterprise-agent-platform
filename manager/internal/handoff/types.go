// Package handoff owns the durable namespace-handoff transaction journal.
//
// The package deliberately does not discover XDG or home-directory state. Its
// caller must resolve the state home first and pass the canonical journal root
// to Open. After Create, only a Helper lease can mutate a journal.
package handoff

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

const (
	SchemaVersion = 1

	MaxJournalBytes = 1 << 20
	MaxErrorBytes   = 64 << 10
	MaxNoteBytes    = 2 << 10
)

var (
	transactionIDPattern = regexp.MustCompile(`^handoff_[0-9a-f]{32}$`)
	commitPattern        = regexp.MustCompile(`^[0-9a-f]{40}$`)
	sha256Pattern        = regexp.MustCompile(`^[0-9a-f]{64}$`)
	bootIDPattern        = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	dockerIDPattern      = regexp.MustCompile(`^[0-9a-f]{12,64}$`)
)

type Status string

const (
	StatusRunning    Status = "running"
	StatusRecovering Status = "recovering"
	StatusCommitted  Status = "committed"
	StatusRolledBack Status = "rolled_back"
	StatusAborted    Status = "aborted"
)

func (s Status) Terminal() bool {
	switch s {
	case StatusCommitted, StatusRolledBack, StatusAborted:
		return true
	default:
		return false
	}
}

type DesiredOutcome string

const (
	OutcomeForward  DesiredOutcome = "forward"
	OutcomeRollback DesiredOutcome = "rollback"
)

type Phase string

const (
	PhasePlanned             Phase = "planned"
	PhaseHelperArmed         Phase = "helper_armed"
	PhaseAdmissionReserved   Phase = "admission_reserved"
	PhaseWritersStopped      Phase = "writers_stopped"
	PhaseSnapshotReady       Phase = "snapshot_ready"
	PhaseSourceFenced        Phase = "source_fenced"
	PhaseTargetStaged        Phase = "target_staged"
	PhaseDataRelocated       Phase = "data_relocated"
	PhaseTargetStarted       Phase = "target_started"
	PhaseTargetVerified      Phase = "target_verified"
	PhaseSourceRetired       Phase = "source_retired"
	PhaseTargetCommitPlanned Phase = "target_commit_planned"
	PhaseCommitted           Phase = "committed"
	PhaseRollbackPlanned     Phase = "rollback_planned"
	PhaseTargetStopped       Phase = "target_stopped"
	PhaseDataRestored        Phase = "data_restored"
	PhaseSourceStarted       Phase = "source_started"
	PhaseRolledBack          Phase = "rolled_back"
	PhaseAborted             Phase = "aborted"
)

type ReleaseBinding struct {
	PredecessorGeneration string `json:"predecessor_generation"`
	BridgeGeneration      string `json:"bridge_generation"`
	ManifestPath          string `json:"manifest_path"`
	ManifestSHA256        string `json:"manifest_sha256"`
	TargetManagerSHA256   string `json:"target_manager_sha256"`
	TargetManagerVersion  string `json:"target_manager_version"`
	TargetComposeSHA256   string `json:"target_compose_sha256"`
}

type SourceBinding struct {
	Namespace      string `json:"namespace"`
	Unit           string `json:"unit"`
	UnitEnabled    bool   `json:"unit_enabled"`
	UnitPath       string `json:"unit_path"`
	UnitSHA256     string `json:"unit_sha256"`
	StableBinary   string `json:"stable_binary"`
	StableSHA256   string `json:"stable_sha256"`
	ConfigPath     string `json:"config_path"`
	ConfigSHA256   string `json:"config_sha256"`
	ManifestPath   string `json:"manifest_path"`
	ManifestSHA256 string `json:"manifest_sha256"`
	ComposePath    string `json:"compose_path"`
	ComposeSHA256  string `json:"compose_sha256"`
	DataRoot       string `json:"data_root"`
	SocketPath     string `json:"socket_path"`
	ComposeProject string `json:"compose_project"`
	CoreNetwork    string `json:"core_network"`
	CoreNetworkID  string `json:"core_network_id"`
	LabelPrefix    string `json:"label_prefix"`
}

type TargetBinding struct {
	Namespace      string `json:"namespace"`
	Unit           string `json:"unit"`
	UnitPath       string `json:"unit_path"`
	StableBinary   string `json:"stable_binary"`
	ConfigPath     string `json:"config_path"`
	ConfigSHA256   string `json:"config_sha256"`
	DataRoot       string `json:"data_root"`
	SocketPath     string `json:"socket_path"`
	ComposeProject string `json:"compose_project"`
	CoreNetwork    string `json:"core_network"`
	LabelPrefix    string `json:"label_prefix"`
}

type Evidence struct {
	ManagerStateSHA256      string `json:"manager_state_sha256"`
	SelfUpdateStateSHA256   string `json:"self_update_state_sha256"`
	SandboxRegistrySHA256   string `json:"sandbox_registry_sha256"`
	DockerInventorySHA256   string `json:"docker_inventory_sha256"`
	DatabaseSchemaVersion   int    `json:"database_schema_version"`
	DatabaseIntegrity       string `json:"database_integrity"`
	RuntimeIdentitySHA256   string `json:"runtime_identity_sha256"`
	WorkspaceIdentitySHA256 string `json:"workspace_identity_sha256"`
	BootID                  string `json:"boot_id"`
}

type Snapshot struct {
	Path           string `json:"path"`
	ManifestSHA256 string `json:"manifest_sha256"`
}

type HelperEvidence struct {
	Unit         string `json:"unit"`
	UnitSHA256   string `json:"unit_sha256"`
	Executable   string `json:"executable"`
	SHA256       string `json:"sha256"`
	ArgvSHA256   string `json:"argv_sha256"`
	ControlGroup string `json:"control_group"`
}

type TargetAck struct {
	ManagerVersion    string    `json:"manager_version"`
	ExecutableSHA256  string    `json:"executable_sha256"`
	SourceCommit      string    `json:"source_commit"`
	PID               int       `json:"pid"`
	SocketPath        string    `json:"socket_path"`
	AutoUpdateCheckAt time.Time `json:"auto_update_check_at"`
	IssuedAt          time.Time `json:"issued_at"`
	ProofSHA256       string    `json:"proof_sha256"`
}

// TargetPlatformCommit is the durable Platform receipt that closes the
// forward-only cutover. ReceiptSHA256 authenticates the canonical JSON of all
// preceding fields; it is persisted by Platform before admission is opened.
type TargetPlatformCommit struct {
	SchemaVersion         int    `json:"schema_version"`
	OperationID           string `json:"operation_id"`
	TargetGeneration      string `json:"target_generation"`
	BindingSHA256         string `json:"binding_sha256"`
	DatabaseSchemaVersion int    `json:"database_schema_version"`
	CommittedAt           string `json:"committed_at"`
	ReceiptSHA256         string `json:"receipt_sha256"`
}

type AbortCleanup struct {
	ReservationReleased    bool `json:"reservation_released"`
	StagingRemoved         bool `json:"staging_removed"`
	ListenersRestored      bool `json:"listeners_restored"`
	SourceIdentityVerified bool `json:"source_identity_verified"`
	SourcePublicReady      bool `json:"source_public_ready"`
}

func (a AbortCleanup) Complete() bool {
	return a.ReservationReleased && a.StagingRemoved && a.ListenersRestored &&
		a.SourceIdentityVerified && a.SourcePublicReady
}

type PhaseEvent struct {
	Phase Phase     `json:"phase"`
	At    time.Time `json:"at"`
	Note  string    `json:"note"`
}

type Journal struct {
	SchemaVersion        int                   `json:"schema_version"`
	Revision             uint64                `json:"revision"`
	TransactionID        string                `json:"transaction_id"`
	Status               Status                `json:"status"`
	DesiredOutcome       DesiredOutcome        `json:"desired_outcome"`
	Phase                Phase                 `json:"phase"`
	BindingSHA256        string                `json:"binding_sha256"`
	Release              ReleaseBinding        `json:"release"`
	Source               SourceBinding         `json:"source"`
	Target               TargetBinding         `json:"target"`
	Evidence             Evidence              `json:"evidence"`
	Snapshot             *Snapshot             `json:"snapshot"`
	Helper               *HelperEvidence       `json:"helper"`
	TargetAck            *TargetAck            `json:"target_ack"`
	TargetPlatformCommit *TargetPlatformCommit `json:"target_platform_commit"`
	AbortCleanup         *AbortCleanup         `json:"abort_cleanup"`
	History              []PhaseEvent          `json:"history"`
	Error                string                `json:"error"`
	CreatedAt            time.Time             `json:"created_at"`
	UpdatedAt            time.Time             `json:"updated_at"`
	CompletedAt          *time.Time            `json:"completed_at"`
}

func (j Journal) Terminal() bool { return j.Status.Terminal() }

// NewJournal creates the only valid initial schema-1 journal. Create still
// revalidates every field and its binding before persisting it.
func NewJournal(release ReleaseBinding, source SourceBinding, target TargetBinding, evidence Evidence, now time.Time) (Journal, error) {
	id, err := randomTransactionID()
	if err != nil {
		return Journal{}, err
	}
	now = now.UTC()
	j := Journal{
		SchemaVersion:  SchemaVersion,
		Revision:       1,
		TransactionID:  id,
		Status:         StatusRunning,
		DesiredOutcome: OutcomeForward,
		Phase:          PhasePlanned,
		Release:        release,
		Source:         source,
		Target:         target,
		Evidence:       evidence,
		History:        []PhaseEvent{{Phase: PhasePlanned, At: now, Note: ""}},
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	j.BindingSHA256, err = ComputeBindingSHA256(j)
	if err != nil {
		return Journal{}, err
	}
	if err := Validate(j); err != nil {
		return Journal{}, err
	}
	return j, nil
}

func randomTransactionID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("generate handoff transaction id: %w", err)
	}
	return "handoff_" + hex.EncodeToString(raw[:]), nil
}

// ComputeTargetPlatformCommitSHA256 returns the canonical digest used by the
// Platform receipt. ReceiptSHA256 itself is deliberately excluded.
func ComputeTargetPlatformCommitSHA256(receipt TargetPlatformCommit) (string, error) {
	material := map[string]any{
		"binding_sha256":          receipt.BindingSHA256,
		"committed_at":            receipt.CommittedAt,
		"database_schema_version": receipt.DatabaseSchemaVersion,
		"schema_version":          receipt.SchemaVersion,
		"target_generation":       receipt.TargetGeneration,
		"operation_id":            receipt.OperationID,
	}
	raw, err := json.Marshal(material)
	if err != nil {
		return "", fmt.Errorf("encode target Platform commit receipt: %w", err)
	}
	var decoded any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&decoded); err != nil {
		return "", fmt.Errorf("decode target Platform commit receipt: %w", err)
	}
	canonical, err := appendCanonicalJSON(nil, decoded)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(canonical)
	return hex.EncodeToString(digest[:]), nil
}

// ComputeBindingSHA256 hashes the canonical JSON form of the immutable
// release/source/target/evidence binding. The canonical encoder sorts every
// object key and only accepts the integer/scalar types used by schema 1.
func ComputeBindingSHA256(j Journal) (string, error) {
	material := map[string]any{
		"evidence": j.Evidence,
		"release":  j.Release,
		"source":   j.Source,
		"target":   j.Target,
	}
	raw, err := json.Marshal(material)
	if err != nil {
		return "", fmt.Errorf("encode handoff binding: %w", err)
	}
	var decoded any
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.UseNumber()
	if err := decoder.Decode(&decoded); err != nil {
		return "", fmt.Errorf("decode handoff binding: %w", err)
	}
	canonical := make([]byte, 0, len(raw))
	canonical, err = appendCanonicalJSON(canonical, decoded)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(canonical)
	return hex.EncodeToString(digest[:]), nil
}

func appendCanonicalJSON(dst []byte, value any) ([]byte, error) {
	switch typed := value.(type) {
	case nil:
		return append(dst, "null"...), nil
	case bool:
		return strconv.AppendBool(dst, typed), nil
	case string:
		return appendCanonicalString(dst, typed), nil
	case json.Number:
		if _, err := strconv.ParseInt(string(typed), 10, 64); err != nil {
			return nil, fmt.Errorf("handoff binding contains non-integer number %q", typed)
		}
		return append(dst, string(typed)...), nil
	case []any:
		dst = append(dst, '[')
		for index, item := range typed {
			if index != 0 {
				dst = append(dst, ',')
			}
			var err error
			dst, err = appendCanonicalJSON(dst, item)
			if err != nil {
				return nil, err
			}
		}
		return append(dst, ']'), nil
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		dst = append(dst, '{')
		for index, key := range keys {
			if index != 0 {
				dst = append(dst, ',')
			}
			dst = appendCanonicalString(dst, key)
			dst = append(dst, ':')
			var err error
			dst, err = appendCanonicalJSON(dst, typed[key])
			if err != nil {
				return nil, err
			}
		}
		return append(dst, '}'), nil
	default:
		return nil, fmt.Errorf("handoff binding contains unsupported JSON type %T", value)
	}
}

func appendCanonicalString(dst []byte, value string) []byte {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value) // Encoding a Go string cannot fail.
	encoded := buffer.Bytes()
	if len(encoded) > 0 && encoded[len(encoded)-1] == '\n' {
		encoded = encoded[:len(encoded)-1]
	}
	return append(dst, encoded...)
}

func validateBinding(j Journal) error {
	if !commitPattern.MatchString(j.Release.PredecessorGeneration) || !commitPattern.MatchString(j.Release.BridgeGeneration) {
		return errors.New("handoff release generations must be lowercase 40-character commit ids")
	}
	if j.Release.PredecessorGeneration == j.Release.BridgeGeneration {
		return errors.New("handoff bridge generation must differ from its predecessor")
	}
	if !canonicalAbsolutePath(j.Release.ManifestPath) {
		return errors.New("handoff manifest path must be canonical and absolute")
	}
	if !validSHA(j.Release.ManifestSHA256) || !validSHA(j.Release.TargetManagerSHA256) || !validSHA(j.Release.TargetComposeSHA256) {
		return errors.New("handoff release digests must be lowercase SHA-256 values")
	}
	if j.Release.TargetManagerVersion != j.Release.BridgeGeneration {
		return errors.New("handoff target Manager version must equal the bridge generation")
	}
	if err := validateSource(j.Release, j.Source); err != nil {
		return err
	}
	if err := validateTarget(j.Target); err != nil {
		return err
	}
	if err := validateEvidence(j.Evidence); err != nil {
		return err
	}
	computed, err := ComputeBindingSHA256(j)
	if err != nil {
		return err
	}
	if j.BindingSHA256 != computed {
		return errors.New("handoff immutable binding digest does not match its content")
	}
	return nil
}

func validateSource(release ReleaseBinding, source SourceBinding) error {
	profile := identity.SourceProfile()
	if source.Namespace != profile.ProfileID || source.Unit != profile.ManagerUnit ||
		source.ComposeProject != profile.ComposeProject || source.CoreNetwork != profile.CoreNetwork ||
		source.LabelPrefix != profile.LabelPrefix {
		return errors.New("handoff source identity does not match the source profile")
	}
	for label, path := range map[string]string{
		"source unit": source.UnitPath, "source stable binary": source.StableBinary,
		"source config": source.ConfigPath, "source manifest": source.ManifestPath,
		"source Compose": source.ComposePath, "source data root": source.DataRoot,
		"source socket": source.SocketPath,
	} {
		if !canonicalAbsolutePath(path) {
			return fmt.Errorf("handoff %s path must be canonical and absolute", label)
		}
	}
	if filepath.Base(source.UnitPath) != profile.ManagerUnit || filepath.Base(source.StableBinary) != profile.ManagerBinary ||
		release.ManifestPath != filepath.Join(profile.ManagerStateRoot(source.DataRoot), "releases", release.BridgeGeneration, "manifest.json") ||
		source.ManifestPath != filepath.Join(profile.ManagerStateRoot(source.DataRoot), "releases", release.PredecessorGeneration, "manifest.json") ||
		source.ComposePath != filepath.Join(profile.ManagerStateRoot(source.DataRoot), "releases", release.PredecessorGeneration, "compose.yaml") ||
		source.SocketPath != filepath.Join(source.DataRoot, filepath.FromSlash(profile.DataRootSocketPath)) {
		return errors.New("handoff source paths do not match the source profile")
	}
	if !validSHA(source.UnitSHA256) || !validSHA(source.StableSHA256) || !validSHA(source.ConfigSHA256) ||
		!validSHA(source.ManifestSHA256) || !validSHA(source.ComposeSHA256) {
		return errors.New("handoff source digests must be lowercase SHA-256 values")
	}
	if !dockerIDPattern.MatchString(source.CoreNetworkID) {
		return errors.New("handoff source network id is invalid")
	}
	return nil
}

func validateTarget(target TargetBinding) error {
	profile := identity.TargetProfile()
	if target.Namespace != profile.ProfileID || target.Unit != profile.ManagerUnit ||
		target.ComposeProject != profile.ComposeProject || target.CoreNetwork != profile.CoreNetwork ||
		target.LabelPrefix != profile.LabelPrefix {
		return errors.New("handoff target identity does not match the target profile")
	}
	for label, path := range map[string]string{
		"target unit": target.UnitPath, "target stable binary": target.StableBinary,
		"target config": target.ConfigPath, "target data root": target.DataRoot,
		"target socket": target.SocketPath,
	} {
		if !canonicalAbsolutePath(path) {
			return fmt.Errorf("handoff %s path must be canonical and absolute", label)
		}
	}
	if filepath.Base(target.UnitPath) != profile.ManagerUnit || filepath.Base(target.StableBinary) != profile.ManagerBinary ||
		filepath.Base(filepath.Dir(target.ConfigPath)) != profile.ConfigDirectory || filepath.Base(target.ConfigPath) != profile.ConfigFile ||
		filepath.Base(target.DataRoot) != profile.DataDirectory ||
		!strings.HasSuffix(target.SocketPath, string(filepath.Separator)+filepath.FromSlash(profile.RuntimeSocketPath)) {
		return errors.New("handoff target paths do not match the target profile")
	}
	if !validSHA(target.ConfigSHA256) {
		return errors.New("handoff target config digest must be a lowercase SHA-256 value")
	}
	return nil
}

func validateEvidence(evidence Evidence) error {
	for _, digest := range []string{
		evidence.ManagerStateSHA256, evidence.SelfUpdateStateSHA256, evidence.SandboxRegistrySHA256,
		evidence.DockerInventorySHA256, evidence.RuntimeIdentitySHA256, evidence.WorkspaceIdentitySHA256,
	} {
		if !validSHA(digest) {
			return errors.New("handoff planned evidence contains an invalid SHA-256 value")
		}
	}
	if evidence.DatabaseSchemaVersion <= 0 || evidence.DatabaseIntegrity != "ok" {
		return errors.New("handoff database evidence is invalid")
	}
	if !bootIDPattern.MatchString(evidence.BootID) {
		return errors.New("handoff boot id is invalid")
	}
	return nil
}

func validSHA(value string) bool { return sha256Pattern.MatchString(value) }

func canonicalAbsolutePath(path string) bool {
	return path != "" && filepath.IsAbs(path) && filepath.Clean(path) == path
}
