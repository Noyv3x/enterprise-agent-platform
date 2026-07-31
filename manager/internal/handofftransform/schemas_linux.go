//go:build linux

package handofftransform

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/url"
	"os"
	pathpkg "path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/sandbox"
	_ "modernc.org/sqlite"
)

const (
	SourceDatabaseBaselineName = "ubitech-agent-container-baseline-v2"
	TargetDatabaseBaselineName = "agent-platform-container-baseline-v1"
	SourceWorkspaceMarkerName  = ".ubitech-agent-scope.json"
	TargetWorkspaceMarkerName  = ".agent-platform-scope.json"
	SourceCamofoxSidecarName   = ".ubitech-agent-runtime.json"
	TargetCamofoxSidecarName   = ".agent-platform-runtime.json"

	platformDatabaseSchema = 1
	runtimeSchema          = 1
	workspaceSchema        = 1
	camofoxSchema          = 1
	sandboxSchema          = 2
)

var hexadecimalDigest = regexpMust(`^[0-9a-f]{64}$`)

// ScopeIdentity is the SQLite-authoritative binding for one workspace and its
// current Runtime identity. It intentionally contains no host absolute path.
type ScopeIdentity struct {
	ScopeKey    string
	ScopeType   string
	ScopeID     string
	LifecycleID string
	SandboxID   string
	WorkspaceID string
}

// RuntimeIdentities is a closed source of truth used by the Runtime JSON/JSONL
// validator. Sessions contains every durable alias, not only the current one.
type RuntimeIdentities struct {
	Scopes   map[string]ScopeIdentity
	Sessions map[string]map[string]map[string]struct{}
}

// CurrentSchemaGaps constructs every current machine-owned production rule
// and verifies that it still exposes a versioned transformer, an independent
// validator, and a semantic identity. This makes the source-owner startup gate
// executable instead of a manually maintained empty assertion.
func CurrentSchemaGaps() []UnsupportedSchemaError {
	identities := RuntimeIdentities{
		Scopes: map[string]ScopeIdentity{}, Sessions: map[string]map[string]map[string]struct{}{},
	}
	resources := []Resource{
		PlatformDatabaseResource(1), AgentRuntimeResource(identities), WorkspaceResource(identities),
		CamofoxSidecarResource(), SandboxRegistryResource("registry.invalid/sandbox@sha256:"+strings.Repeat("a", 64), time.Unix(1, 0).UTC()),
	}
	expected := map[string]struct {
		schema  string
		version int
	}{
		"platform_database": {"platform-database", platformDatabaseSchema},
		"agent_runtime":     {"agent-runtime-state", runtimeSchema},
		"workspaces":        {"workspace-markers", workspaceSchema},
		"camofox_sidecar":   {"platform-camofox-sidecar", camofoxSchema},
		"sandbox_registry":  {"sandbox-registry", sandboxSchema},
	}
	gaps := make([]UnsupportedSchemaError, 0)
	for _, resource := range resources {
		want, exists := expected[resource.Name]
		if !exists {
			gaps = append(gaps, UnsupportedSchemaError{Resource: resource.Name, Schema: "unknown", Reason: "resource is not registered as a current machine-owned schema"})
			continue
		}
		if resource.Kind != Structured || resource.SchemaIdentifier != want.schema || resource.SchemaVersion != want.version ||
			resource.Transformer == nil || resource.Validator == nil || !sha256Pattern.MatchString(resource.TransformationSHA256) {
			gaps = append(gaps, UnsupportedSchemaError{
				Resource: resource.Name, Schema: fmt.Sprintf("%s/%d", want.schema, want.version),
				Reason: "reviewed transformer, independent validator, or semantic identity is absent",
			})
		}
		delete(expected, resource.Name)
	}
	for name, want := range expected {
		gaps = append(gaps, UnsupportedSchemaError{Resource: name, Schema: fmt.Sprintf("%s/%d", want.schema, want.version), Reason: "current schema resource constructor is absent"})
	}
	sort.Slice(gaps, func(i, j int) bool { return gaps[i].Resource < gaps[j].Resource })
	return gaps
}

// CheckpointPlatformDatabase folds a stopped source WAL into platform.db and
// proves that the resulting main file is a complete current baseline. It is
// idempotent and is the only source write performed by the data boundary.
func CheckpointPlatformDatabase(ctx context.Context, path string, databaseVersion int) error {
	database, err := openSQLite(path, "rwc")
	if err != nil {
		return err
	}
	defer database.Close()
	if _, err := database.ExecContext(ctx, "PRAGMA busy_timeout=30000"); err != nil {
		return err
	}
	var busy, logFrames, checkpointed int
	if err := database.QueryRowContext(ctx, "PRAGMA wal_checkpoint(TRUNCATE)").Scan(&busy, &logFrames, &checkpointed); err != nil {
		return fmt.Errorf("checkpoint source Platform WAL: %w", err)
	}
	if busy != 0 || logFrames != checkpointed {
		return fmt.Errorf("source Platform WAL did not checkpoint completely: busy=%d log=%d checkpointed=%d", busy, logFrames, checkpointed)
	}
	if err := verifySQLiteHealth(ctx, database); err != nil {
		return err
	}
	return verifyDatabaseBaseline(ctx, database, databaseVersion, SourceDatabaseBaselineName)
}

// LoadAuthoritativeIdentities reads the exact scope/session graph after the
// WAL checkpoint. The returned maps are fresh copies suitable for immutable
// transformer construction.
func LoadAuthoritativeIdentities(ctx context.Context, path string, databaseVersion int) (RuntimeIdentities, error) {
	database, err := openSQLite(path, "ro")
	if err != nil {
		return RuntimeIdentities{}, err
	}
	defer database.Close()
	if err := verifyDatabaseBaseline(ctx, database, databaseVersion, SourceDatabaseBaselineName); err != nil {
		return RuntimeIdentities{}, err
	}
	identities := RuntimeIdentities{Scopes: map[string]ScopeIdentity{}, Sessions: map[string]map[string]map[string]struct{}{}}
	workspaceIDs := map[string]string{}
	rows, err := database.QueryContext(ctx, `SELECT scope_key, scope_type, scope_id, lifecycle_id, sandbox_id, workspace_path FROM agent_scopes ORDER BY scope_key LIMIT ?`, contract.AgentRuntimeMaximumIdentityRecords+1)
	if err != nil {
		return RuntimeIdentities{}, err
	}
	scopeCount := 0
	for rows.Next() {
		scopeCount++
		if scopeCount > contract.AgentRuntimeMaximumIdentityRecords {
			rows.Close()
			return RuntimeIdentities{}, errors.New("Agent scope count exceeds the handoff limit")
		}
		var item ScopeIdentity
		if err := rows.Scan(&item.ScopeKey, &item.ScopeType, &item.ScopeID, &item.LifecycleID, &item.SandboxID, &item.WorkspaceID); err != nil {
			rows.Close()
			return RuntimeIdentities{}, err
		}
		if err := validateScopeIdentity(item); err != nil {
			rows.Close()
			return RuntimeIdentities{}, err
		}
		if _, exists := identities.Scopes[item.ScopeKey]; exists {
			rows.Close()
			return RuntimeIdentities{}, errors.New("Platform database contains duplicate Agent scope identity")
		}
		if prior, exists := workspaceIDs[item.WorkspaceID]; exists {
			rows.Close()
			return RuntimeIdentities{}, fmt.Errorf("Platform database binds workspace %q to both %q and %q", item.WorkspaceID, prior, item.ScopeKey)
		}
		identities.Scopes[item.ScopeKey] = item
		workspaceIDs[item.WorkspaceID] = item.ScopeKey
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return RuntimeIdentities{}, err
	}
	if err := rows.Close(); err != nil {
		return RuntimeIdentities{}, err
	}
	rows, err = database.QueryContext(ctx, `SELECT scope_key, lifecycle_id, session_id FROM agent_runtime_scope_sessions ORDER BY scope_key, lifecycle_id, session_id LIMIT ?`, contract.AgentRuntimeMaximumIdentityRecords+1)
	if err != nil {
		return RuntimeIdentities{}, err
	}
	count := 0
	for rows.Next() {
		count++
		if count > contract.AgentRuntimeMaximumIdentityRecords {
			rows.Close()
			return RuntimeIdentities{}, errors.New("Agent Runtime alias count exceeds the handoff limit")
		}
		var scope, lifecycle, session string
		if err := rows.Scan(&scope, &lifecycle, &session); err != nil {
			rows.Close()
			return RuntimeIdentities{}, err
		}
		if _, exists := identities.Scopes[scope]; !exists || scope == "" || lifecycle == "" || session == "" {
			rows.Close()
			return RuntimeIdentities{}, errors.New("Agent Runtime alias references an unknown or empty identity")
		}
		byLifecycle := identities.Sessions[scope]
		if byLifecycle == nil {
			byLifecycle = map[string]map[string]struct{}{}
			identities.Sessions[scope] = byLifecycle
		}
		bySession := byLifecycle[lifecycle]
		if bySession == nil {
			bySession = map[string]struct{}{}
			byLifecycle[lifecycle] = bySession
		}
		if _, duplicate := bySession[session]; duplicate {
			rows.Close()
			return RuntimeIdentities{}, errors.New("Agent Runtime alias identity is duplicated")
		}
		bySession[session] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return RuntimeIdentities{}, err
	}
	if err := rows.Close(); err != nil {
		return RuntimeIdentities{}, err
	}
	rows, err = database.QueryContext(ctx, `SELECT scope_key, lifecycle_id, session_id FROM agent_runtime_scopes ORDER BY scope_key LIMIT ?`, contract.AgentRuntimeMaximumIdentityRecords+1)
	if err != nil {
		return RuntimeIdentities{}, err
	}
	current := 0
	for rows.Next() {
		current++
		if current > contract.AgentRuntimeMaximumIdentityRecords {
			rows.Close()
			return RuntimeIdentities{}, errors.New("current Agent Runtime scope count exceeds the handoff limit")
		}
		var scope, lifecycle, session string
		if err := rows.Scan(&scope, &lifecycle, &session); err != nil {
			rows.Close()
			return RuntimeIdentities{}, err
		}
		if _, exists := identities.Sessions[scope][lifecycle][session]; !exists {
			rows.Close()
			return RuntimeIdentities{}, errors.New("current Agent Runtime session has no durable alias")
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return RuntimeIdentities{}, err
	}
	if err := rows.Close(); err != nil {
		return RuntimeIdentities{}, err
	}
	if current != len(identities.Scopes) {
		return RuntimeIdentities{}, errors.New("current Agent Runtime scope identity is incomplete")
	}
	return identities, nil
}

func PlatformDatabaseResource(databaseVersion int) Resource {
	transformer := &platformDatabaseTransformer{databaseVersion: databaseVersion}
	validator := &platformDatabaseValidator{databaseVersion: databaseVersion}
	return Resource{
		Name: "platform_database", Kind: Structured, Source: "data/platform.db", Target: "data/platform.db",
		Type: RegularFile, Required: true, SchemaIdentifier: "platform-database", SchemaVersion: platformDatabaseSchema,
		Transformer: transformer, Validator: validator,
		TransformationSHA256: semanticDigest(struct {
			Version int    `json:"version"`
			Source  string `json:"source"`
			Target  string `json:"target"`
		}{databaseVersion, SourceDatabaseBaselineName, TargetDatabaseBaselineName}),
	}
}

func AgentRuntimeResource(identities RuntimeIdentities) Resource {
	validator := &runtimeValidator{identities: cloneRuntimeIdentities(identities)}
	exclude := runtimeSourceOnlyPath
	return Resource{
		Name: "agent_runtime", Kind: Structured, Source: "data/runtimes/agent", Target: "data/runtimes/agent",
		Type: Directory, Required: true, SchemaIdentifier: "agent-runtime-state", SchemaVersion: runtimeSchema,
		Transformer: filteredStructuredTree{exclude: exclude}, Validator: Validators(filteredStructuredValidator{exclude: exclude}, validator),
		SourceExclude: exclude, SourceValidator: runtimeSourceValidator{},
		TransformationSHA256: semanticDigest(struct {
			Identities  RuntimeIdentities `json:"identities"`
			P1Inventory string            `json:"p1_inventory"`
		}{cloneRuntimeIdentities(identities), contract.AgentRuntimeP1AppInventorySHA256}),
	}
}

func WorkspaceResource(identities RuntimeIdentities, deploymentOwners ...Owner) Resource {
	deployment := Owner{UID: uint32(os.Getuid()), GID: uint32(os.Getgid())}
	if len(deploymentOwners) != 0 {
		deployment = deploymentOwners[0]
	}
	scopes := make(map[string]ScopeIdentity, len(identities.Scopes))
	for key, value := range identities.Scopes {
		scopes[key] = value
	}
	root := Owner{UID: uint32(contract.P1WorkspaceRootOwnedUID), GID: uint32(contract.P1WorkspaceRootOwnedGID)}
	sourceOwners := []Owner{deployment}
	if root != deployment {
		sourceOwners = append(sourceOwners, root)
	}
	transformer := &workspaceTransformer{scopes: scopes, deployment: deployment}
	validator := &workspaceValidator{scopes: scopes, deployment: deployment}
	return Resource{
		Name: "workspaces", Kind: Structured, Source: "data/workspaces", Target: "data/workspaces",
		Type: Directory, Required: true, SchemaIdentifier: "workspace-markers", SchemaVersion: workspaceSchema,
		SourceOwners: sourceOwners, Transformer: transformer, Validator: validator,
		SourceInventoryValidator: &workspaceSourceInventoryValidator{scopes: scopes, deployment: deployment},
		TransformationSHA256: semanticDigest(struct {
			Scopes                map[string]ScopeIdentity `json:"scopes"`
			SourceDirectory       string                   `json:"source_directory"`
			TargetDirectory       string                   `json:"target_directory"`
			NamespaceRequired     bool                     `json:"namespace_required"`
			NamespaceMode         uint32                   `json:"namespace_mode"`
			RootOwnedMountPath    string                   `json:"root_owned_mount_path"`
			RootOwnedMountMode    uint32                   `json:"root_owned_mount_mode"`
			RootOwnedMountOwner   Owner                    `json:"root_owned_mount_owner"`
			NormalizedTargetOwner Owner                    `json:"normalized_target_owner"`
		}{
			Scopes: scopes, SourceDirectory: contract.P1WorkspaceSourceDirectory,
			TargetDirectory:     contract.P1WorkspaceTargetDirectory,
			NamespaceRequired:   contract.P1WorkspaceNamespaceRequired,
			NamespaceMode:       uint32(contract.P1WorkspaceNamespaceMode),
			RootOwnedMountPath:  contract.P1WorkspaceRootOwnedMountPath,
			RootOwnedMountMode:  uint32(contract.P1WorkspaceRootOwnedMountMode),
			RootOwnedMountOwner: root, NormalizedTargetOwner: deployment,
		}),
	}
}

func CamofoxSidecarResource() Resource {
	transformer := &camofoxTransformer{}
	validator := &camofoxValidator{}
	return Resource{
		Name: "camofox_sidecar", Kind: Structured,
		Source: "data/runtimes/camofox/" + SourceCamofoxSidecarName,
		Target: "data/runtimes/camofox/" + TargetCamofoxSidecarName,
		Type:   RegularFile, Required: true, SchemaIdentifier: "platform-camofox-sidecar", SchemaVersion: camofoxSchema,
		Transformer: transformer, Validator: validator,
		TransformationSHA256: semanticDigest([]string{SourceCamofoxSidecarName, TargetCamofoxSidecarName, identity.SourceProfile().ProfileID, identity.TargetProfile().ProfileID}),
	}
}

func SandboxRegistryResource(targetImage string, stoppedAt time.Time) Resource {
	transformer := &sandboxTransformer{targetImage: targetImage, stoppedAt: stoppedAt.UTC()}
	validator := &sandboxValidator{targetImage: targetImage, stoppedAt: stoppedAt.UTC()}
	return Resource{
		Name: "sandbox_registry", Kind: Structured, Source: "manager/sandboxes.json", Target: "manager/sandboxes.json",
		Type: RegularFile, Required: true, SchemaIdentifier: "sandbox-registry", SchemaVersion: sandboxSchema,
		Transformer: transformer, Validator: validator,
		TransformationSHA256: semanticDigest(struct {
			Image     string    `json:"image"`
			StoppedAt time.Time `json:"stopped_at"`
		}{targetImage, stoppedAt.UTC()}),
	}
}

// ExactTreeResource is used only for explicitly reviewed opaque/user-owned
// paths. Its allow-list is enforced again by Engine.validateDataBoundary.
func ExactTreeResource(name, path string, required bool) Resource {
	return Resource{Name: name, Kind: ByteExactTree, Source: path, Target: path, Type: Directory, Required: required}
}

func SecretResource(name, source, target string, required bool) Resource {
	return Resource{Name: name, Kind: SecretFile, Source: source, Target: target, Type: RegularFile, Required: required}
}

// GeneratedFileResource creates one exact target-only file. The byte digest is
// part of the immutable request identity and is checked again by an independent
// validator after generation.
func GeneratedFileResource(name, target string, data []byte, mode os.FileMode) Resource {
	copyOfData := append([]byte(nil), data...)
	digest := sha256.Sum256(copyOfData)
	return Resource{
		Name: name, Kind: Generated, Target: target, Type: RegularFile, Required: true,
		SchemaIdentifier: "generated-file", SchemaVersion: 1,
		TransformationSHA256: hex.EncodeToString(digest[:]),
		Transformer:          generatedFile{data: copyOfData, mode: mode.Perm()},
		Validator:            generatedFileValidator{data: copyOfData, mode: mode.Perm()},
	}
}

// GeneratedDirectoryResource creates one exact empty owner-only directory.
func GeneratedDirectoryResource(name, target string, mode os.FileMode) Resource {
	identityDigest := semanticDigest(struct {
		Target string `json:"target"`
		Mode   uint32 `json:"mode"`
	}{target, uint32(mode.Perm())})
	return Resource{
		Name: name, Kind: Generated, Target: target, Type: Directory, Required: true,
		SchemaIdentifier: "generated-directory", SchemaVersion: 1,
		TransformationSHA256: identityDigest,
		Transformer:          generatedDirectory{mode: mode.Perm()}, Validator: generatedDirectoryValidator{mode: mode.Perm()},
	}
}

type generatedFile struct {
	data []byte
	mode os.FileMode
}

func (value generatedFile) Transform(_ context.Context, input TransformInput) error {
	file, err := os.OpenFile(input.TargetPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, value.mode)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(value.data)
	chmodErr := file.Chmod(value.mode)
	syncErr := file.Sync()
	closeErr := file.Close()
	return errors.Join(writeErr, chmodErr, syncErr, closeErr)
}

type generatedFileValidator struct {
	data []byte
	mode os.FileMode
}

func (value generatedFileValidator) Validate(_ context.Context, input ValidationInput) error {
	if len(input.TargetEntries) != 1 || input.TargetEntries[0].Path != "." || input.TargetEntries[0].Type != RegularFile ||
		os.FileMode(input.TargetEntries[0].Mode).Perm() != value.mode.Perm() {
		return errors.New("generated file metadata differs from its closed schema")
	}
	raw, err := readBoundedRegular(input.TargetPath, int64(len(value.data)), int64(len(value.data)))
	if err != nil {
		return err
	}
	if !bytes.Equal(raw, value.data) {
		return errors.New("generated file bytes differ from their immutable input")
	}
	return nil
}

type generatedDirectory struct{ mode os.FileMode }

func (value generatedDirectory) Transform(_ context.Context, input TransformInput) error {
	return os.Mkdir(input.TargetPath, value.mode)
}

type generatedDirectoryValidator struct{ mode os.FileMode }

func (value generatedDirectoryValidator) Validate(_ context.Context, input ValidationInput) error {
	if len(input.TargetEntries) != 1 || input.TargetEntries[0].Path != "." || input.TargetEntries[0].Type != Directory ||
		os.FileMode(input.TargetEntries[0].Mode).Perm() != value.mode.Perm() {
		return errors.New("generated directory is not empty with the required metadata")
	}
	return nil
}

type platformDatabaseTransformer struct{ databaseVersion int }

func (transformer *platformDatabaseTransformer) Transform(ctx context.Context, input TransformInput) error {
	if len(input.SourceEntries) != 1 || input.SourceEntries[0].Path != "." || input.SourceEntries[0].Type != RegularFile {
		return errors.New("Platform database source manifest is invalid")
	}
	if err := copyStructuredFile(ctx, input.SourcePath, input.TargetPath, input.SourceEntries[0]); err != nil {
		return err
	}
	database, err := openSQLite(input.TargetPath, "rw")
	if err != nil {
		return err
	}
	defer database.Close()
	if err := verifyDatabaseBaseline(ctx, database, transformer.databaseVersion, SourceDatabaseBaselineName); err != nil {
		return err
	}
	result, err := database.ExecContext(ctx, `UPDATE schema_migrations SET name = ? WHERE version = ? AND name = ?`, TargetDatabaseBaselineName, transformer.databaseVersion, SourceDatabaseBaselineName)
	if err != nil {
		return fmt.Errorf("write target Platform baseline marker: %w", err)
	}
	changed, err := result.RowsAffected()
	if err != nil || changed != 1 {
		return errors.New("target Platform baseline marker update did not affect exactly one row")
	}
	if _, err := database.ExecContext(ctx, "PRAGMA journal_mode=DELETE"); err != nil {
		return fmt.Errorf("finalize target Platform database journal mode: %w", err)
	}
	if err := verifySQLiteHealth(ctx, database); err != nil {
		return err
	}
	return verifyDatabaseBaseline(ctx, database, transformer.databaseVersion, TargetDatabaseBaselineName)
}

type platformDatabaseValidator struct{ databaseVersion int }

func (validator *platformDatabaseValidator) Validate(ctx context.Context, input ValidationInput) error {
	// Both files are immutable at the validation boundary. Opening a copied WAL
	// database with a normal read-only SQLite connection can still create
	// sibling -wal/-shm files, which would mutate the transaction input and
	// escape the declared resource root.
	source, err := openImmutableSQLite(input.SourcePath)
	if err != nil {
		return err
	}
	defer source.Close()
	target, err := openImmutableSQLite(input.TargetPath)
	if err != nil {
		return err
	}
	defer target.Close()
	if err := verifySQLiteHealth(ctx, source); err != nil {
		return fmt.Errorf("source Platform database: %w", err)
	}
	if err := verifySQLiteHealth(ctx, target); err != nil {
		return fmt.Errorf("target Platform database: %w", err)
	}
	if err := verifyDatabaseBaseline(ctx, source, validator.databaseVersion, SourceDatabaseBaselineName); err != nil {
		return err
	}
	if err := verifyDatabaseBaseline(ctx, target, validator.databaseVersion, TargetDatabaseBaselineName); err != nil {
		return err
	}
	sourceProjection, err := databaseProjection(ctx, source, validator.databaseVersion, SourceDatabaseBaselineName)
	if err != nil {
		return err
	}
	targetProjection, err := databaseProjection(ctx, target, validator.databaseVersion, TargetDatabaseBaselineName)
	if err != nil {
		return err
	}
	if sourceProjection != targetProjection {
		return errors.New("target Platform database changed content outside the registered baseline marker")
	}
	return nil
}

type exactStructuredTree struct{}

func (exactStructuredTree) Transform(ctx context.Context, input TransformInput) error {
	return copyStructuredTree(ctx, input, structuredTreeRewrite{}, nil)
}

type exactStructuredValidator struct{}

func (exactStructuredValidator) Validate(_ context.Context, input ValidationInput) error {
	return validateMappedEntries(input.SourceEntries, input.TargetEntries, nil, nil)
}

type filteredStructuredTree struct{ exclude func(string) bool }

func (transformer filteredStructuredTree) Transform(ctx context.Context, input TransformInput) error {
	return copyStructuredTree(ctx, input, structuredTreeRewrite{}, transformer.exclude)
}

type filteredStructuredValidator struct{ exclude func(string) bool }

func (validator filteredStructuredValidator) Validate(_ context.Context, input ValidationInput) error {
	source := make([]Entry, 0, len(input.SourceEntries))
	for _, entry := range input.SourceEntries {
		if validator.exclude != nil && validator.exclude(entry.Path) {
			continue
		}
		source = append(source, entry)
	}
	return validateMappedEntries(source, input.TargetEntries, nil, nil)
}

type workspaceSourceInventoryValidator struct {
	scopes     map[string]ScopeIdentity
	deployment Owner
}

func (validator *workspaceSourceInventoryValidator) ValidateSourceInventory(entries []Entry) error {
	byPath := entriesByPath(entries)
	rootOwner := Owner{UID: uint32(contract.P1WorkspaceRootOwnedUID), GID: uint32(contract.P1WorkspaceRootOwnedGID)}
	for _, entry := range entries {
		owner := Owner{UID: entry.UID, GID: entry.GID}
		if owner == validator.deployment {
			continue
		}
		if owner != rootOwner || !workspaceRootOwnedPath(validator.scopes, entry.Path) {
			return fmt.Errorf("workspace path %s has an owner outside its exact P1 placeholder rule", entry.Path)
		}
	}
	for _, scope := range validator.scopes {
		sourceNamespace := pathpkg.Join(scope.WorkspaceID, contract.P1WorkspaceSourceDirectory)
		targetNamespace := pathpkg.Join(scope.WorkspaceID, contract.P1WorkspaceTargetDirectory)
		mount := pathpkg.Join(sourceNamespace, contract.P1WorkspaceRootOwnedMountPath)
		namespace, exists := byPath[sourceNamespace]
		if contract.P1WorkspaceNamespaceRequired && !exists {
			return fmt.Errorf("workspace %s lacks required source namespace %s", scope.WorkspaceID, contract.P1WorkspaceSourceDirectory)
		}
		if !exists {
			continue
		}
		if namespace.Type != Directory || namespace.Mode != uint32(contract.P1WorkspaceNamespaceMode) {
			return fmt.Errorf("workspace namespace %s has an unexpected type or mode", sourceNamespace)
		}
		for path := range byPath {
			if path == targetNamespace || strings.HasPrefix(path, targetNamespace+"/") {
				return fmt.Errorf("workspace %s already contains conflicting target namespace %s", scope.WorkspaceID, contract.P1WorkspaceTargetDirectory)
			}
		}
		mountEntry, mountExists := byPath[mount]
		mountOwner := Owner{}
		if mountExists {
			mountOwner = Owner{UID: mountEntry.UID, GID: mountEntry.GID}
		}
		if mountOwner == rootOwner {
			if mountEntry.Type != Directory || mountEntry.Mode != uint32(contract.P1WorkspaceRootOwnedMountMode) {
				return fmt.Errorf("workspace root-owned mount placeholder %s has an unexpected type or mode", mount)
			}
			for path := range byPath {
				if strings.HasPrefix(path, mount+"/") {
					return fmt.Errorf("workspace root-owned mount placeholder %s is not empty", mount)
				}
			}
		}
		if (Owner{UID: namespace.UID, GID: namespace.GID}) == rootOwner {
			if !mountExists || mountOwner != rootOwner {
				return fmt.Errorf("root-owned workspace namespace %s lacks its exact root-owned empty mount", sourceNamespace)
			}
			for path := range byPath {
				if strings.HasPrefix(path, sourceNamespace+"/") && path != mount {
					return fmt.Errorf("root-owned workspace namespace %s contains non-placeholder data", sourceNamespace)
				}
			}
		}
	}
	return nil
}

func workspaceScopeForRootFile(scopes map[string]ScopeIdentity, relative, name string) (ScopeIdentity, bool) {
	relative = filepath.ToSlash(relative)
	if pathpkg.Base(relative) != name {
		return ScopeIdentity{}, false
	}
	workspaceID := pathpkg.Dir(relative)
	for _, scope := range scopes {
		if scope.WorkspaceID == workspaceID {
			return scope, true
		}
	}
	return ScopeIdentity{}, false
}

func workspaceRootOwnedPath(scopes map[string]ScopeIdentity, relative string) bool {
	relative = filepath.ToSlash(relative)
	for _, scope := range scopes {
		namespace := pathpkg.Join(scope.WorkspaceID, contract.P1WorkspaceSourceDirectory)
		if relative == namespace || relative == pathpkg.Join(namespace, contract.P1WorkspaceRootOwnedMountPath) {
			return true
		}
	}
	return false
}

func mapWorkspaceEntry(scopes map[string]ScopeIdentity, deployment Owner, source Entry, targetRelative string) (Entry, error) {
	targetRelative = filepath.ToSlash(targetRelative)
	sourcePath := filepath.ToSlash(source.Path)
	for _, scope := range scopes {
		sourceNamespace := pathpkg.Join(scope.WorkspaceID, contract.P1WorkspaceSourceDirectory)
		if sourcePath != sourceNamespace && !strings.HasPrefix(sourcePath, sourceNamespace+"/") {
			continue
		}
		targetNamespace := pathpkg.Join(scope.WorkspaceID, contract.P1WorkspaceTargetDirectory)
		targetRelative = targetNamespace + strings.TrimPrefix(sourcePath, sourceNamespace)
		break
	}
	mapped := source
	mapped.Path = targetRelative
	rootOwner := Owner{UID: uint32(contract.P1WorkspaceRootOwnedUID), GID: uint32(contract.P1WorkspaceRootOwnedGID)}
	owner := Owner{UID: source.UID, GID: source.GID}
	if owner == rootOwner {
		if !workspaceRootOwnedPath(scopes, sourcePath) {
			return Entry{}, fmt.Errorf("workspace path %s has a non-canonical root owner", sourcePath)
		}
		mapped.UID, mapped.GID = deployment.UID, deployment.GID
	}
	if mapped.UID != deployment.UID || mapped.GID != deployment.GID {
		return Entry{}, fmt.Errorf("workspace path %s owner cannot be preserved by the deployment identity", sourcePath)
	}
	return mapped, nil
}

type workspaceTransformer struct {
	scopes     map[string]ScopeIdentity
	deployment Owner
}

func (transformer *workspaceTransformer) Transform(ctx context.Context, input TransformInput) error {
	rewrite := func(relative string, raw []byte) (string, []byte, error) {
		relative = filepath.ToSlash(relative)
		if filepath.Base(relative) != SourceWorkspaceMarkerName {
			return relative, raw, nil
		}
		workspaceID := filepath.ToSlash(filepath.Dir(relative))
		var expected ScopeIdentity
		found := false
		for _, scope := range transformer.scopes {
			if scope.WorkspaceID == workspaceID {
				expected, found = scope, true
				break
			}
		}
		if !found {
			// The source marker filename is only platform-owned at a
			// SQLite-authoritative workspace root. Elsewhere it is user data.
			return relative, raw, nil
		}
		marker, err := decodeWorkspaceMarker(raw, input.Mapping.Source.ProfileID)
		if err != nil {
			return "", nil, err
		}
		if expected.ScopeKey != marker.ScopeKey || !workspaceMarkerMatches(marker, expected) {
			return "", nil, errors.New("workspace marker differs from the SQLite-authoritative scope binding")
		}
		marker.TechnicalProfile = input.Mapping.Target.ProfileID
		encoded, err := json.Marshal(marker)
		if err != nil {
			return "", nil, err
		}
		return filepath.Join(workspaceID, TargetWorkspaceMarkerName), append(encoded, '\n'), nil
	}
	shouldRewrite := func(relative string) bool {
		_, found := workspaceScopeForRootFile(transformer.scopes, relative, SourceWorkspaceMarkerName)
		return found
	}
	mapEntry := func(source Entry, targetRelative string) (Entry, error) {
		return mapWorkspaceEntry(transformer.scopes, transformer.deployment, source, targetRelative)
	}
	return copyStructuredTree(ctx, input, structuredTreeRewrite{File: rewrite, RewriteFile: shouldRewrite, Entry: mapEntry}, nil)
}

type workspaceValidator struct {
	scopes     map[string]ScopeIdentity
	deployment Owner
}

func (validator *workspaceValidator) Validate(_ context.Context, input ValidationInput) error {
	seen := map[string]struct{}{}
	targets := entriesByPath(input.TargetEntries)
	mappedPaths := make(map[string]struct{}, len(input.SourceEntries))
	for _, source := range input.SourceEntries {
		targetRelative := source.Path
		_, markerChanged := workspaceScopeForRootFile(validator.scopes, source.Path, SourceWorkspaceMarkerName)
		if markerChanged {
			targetRelative = filepath.ToSlash(filepath.Join(filepath.Dir(source.Path), TargetWorkspaceMarkerName))
		}
		expected, err := mapWorkspaceEntry(validator.scopes, validator.deployment, source, targetRelative)
		if err != nil {
			return err
		}
		if _, duplicate := mappedPaths[expected.Path]; duplicate {
			return fmt.Errorf("workspace mapping produced duplicate target %s", expected.Path)
		}
		mappedPaths[expected.Path] = struct{}{}
		candidate, exists := targets[expected.Path]
		if !exists {
			return fmt.Errorf("target is missing workspace source entry %s", expected.Path)
		}
		if expected.Type != candidate.Type || expected.Mode != candidate.Mode || expected.UID != candidate.UID || expected.GID != candidate.GID {
			return fmt.Errorf("workspace entry %s metadata changed unexpectedly", source.Path)
		}
		if markerChanged {
			if expected.ModifiedNanos != candidate.ModifiedNanos {
				return fmt.Errorf("workspace marker %s mtime changed unexpectedly", source.Path)
			}
		} else if !contentInvariantEqual(expected, candidate) {
			return fmt.Errorf("workspace entry %s content or timestamps changed unexpectedly", source.Path)
		}
	}
	if len(mappedPaths) != len(input.TargetEntries) {
		return errors.New("workspace target contains unexpected entries")
	}
	for _, entry := range input.TargetEntries {
		if filepath.Base(entry.Path) != TargetWorkspaceMarkerName {
			continue
		}
		workspaceID := filepath.ToSlash(filepath.Dir(entry.Path))
		var expected ScopeIdentity
		found := false
		for _, scope := range validator.scopes {
			if scope.WorkspaceID == workspaceID {
				expected, found = scope, true
				break
			}
		}
		if !found {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(input.TargetPath, filepath.FromSlash(entry.Path)))
		if err != nil {
			return err
		}
		marker, err := decodeWorkspaceMarker(raw, input.Mapping.Target.ProfileID)
		if err != nil {
			return err
		}
		if expected.ScopeKey != marker.ScopeKey || !workspaceMarkerMatches(marker, expected) {
			return errors.New("target workspace marker differs from the SQLite-authoritative scope binding")
		}
		seen[marker.ScopeKey] = struct{}{}
	}
	if len(seen) != len(validator.scopes) {
		return errors.New("target workspace marker set is incomplete")
	}
	return nil
}

type workspaceMarker struct {
	SchemaVersion         int    `json:"schema_version"`
	Kind                  string `json:"kind"`
	TechnicalProfile      string `json:"technical_profile"`
	ScopeKey              string `json:"scope_key"`
	ScopeType             string `json:"scope_type"`
	ScopeID               string `json:"scope_id"`
	LifecycleID           string `json:"lifecycle_id"`
	SandboxID             string `json:"sandbox_id"`
	WorkspaceID           string `json:"workspace_id"`
	WorkspaceRelativePath string `json:"workspace_relative_path"`
	Isolation             string `json:"isolation"`
}

func decodeWorkspaceMarker(raw []byte, profile string) (workspaceMarker, error) {
	var marker workspaceMarker
	if err := decodeStrictJSON(raw, &marker); err != nil {
		return workspaceMarker{}, err
	}
	if marker.SchemaVersion != workspaceSchema || marker.Kind != "agent-workspace-scope" || marker.TechnicalProfile != profile ||
		marker.ScopeKey == "" || (marker.ScopeType != "private" && marker.ScopeType != "channel") || marker.ScopeID == "" ||
		marker.LifecycleID == "" || marker.SandboxID == "" || marker.WorkspaceID == "" ||
		marker.WorkspaceRelativePath != "workspaces/"+marker.WorkspaceID || marker.Isolation != "container-workspace" {
		return workspaceMarker{}, errors.New("workspace marker is outside schema 1")
	}
	return marker, nil
}

func workspaceMarkerMatches(marker workspaceMarker, expected ScopeIdentity) bool {
	return marker.ScopeKey == expected.ScopeKey && marker.ScopeType == expected.ScopeType && marker.ScopeID == expected.ScopeID &&
		marker.LifecycleID == expected.LifecycleID && marker.SandboxID == expected.SandboxID && marker.WorkspaceID == expected.WorkspaceID
}

type camofoxSidecar struct {
	SchemaVersion          int    `json:"schema_version"`
	Kind                   string `json:"kind"`
	TechnicalProfile       string `json:"technical_profile"`
	RuntimeRelativePath    string `json:"runtime_relative_path"`
	ProfilesRelativePath   string `json:"profiles_relative_path"`
	CookiesRelativePath    string `json:"cookies_relative_path"`
	TracesRelativePath     string `json:"traces_relative_path"`
	ProfileDirectoryFormat string `json:"profile_directory_format"`
}

type camofoxTransformer struct{}

func (*camofoxTransformer) Transform(_ context.Context, input TransformInput) error {
	if len(input.SourceEntries) != 1 || input.SourceEntries[0].Path != "." || input.SourceEntries[0].Type != RegularFile {
		return errors.New("Camoufox sidecar source manifest is invalid")
	}
	raw, err := os.ReadFile(input.SourcePath)
	if err != nil {
		return err
	}
	value, err := decodeCamofox(raw, input.Mapping.Source.ProfileID)
	if err != nil {
		return err
	}
	value.TechnicalProfile = input.Mapping.Target.ProfileID
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return writeStructuredOutput(input.TargetPath, append(encoded, '\n'), input.SourceEntries[0])
}

type camofoxValidator struct{}

func (*camofoxValidator) Validate(_ context.Context, input ValidationInput) error {
	raw, err := os.ReadFile(input.TargetPath)
	if err != nil {
		return err
	}
	_, err = decodeCamofox(raw, input.Mapping.Target.ProfileID)
	return err
}

func decodeCamofox(raw []byte, profile string) (camofoxSidecar, error) {
	var value camofoxSidecar
	if err := decodeStrictJSON(raw, &value); err != nil {
		return camofoxSidecar{}, err
	}
	if value.SchemaVersion != camofoxSchema || value.Kind != "platform-camofox-runtime" || value.TechnicalProfile != profile ||
		value.RuntimeRelativePath != "runtimes/camofox" || value.ProfilesRelativePath != "runtimes/camofox/profiles" ||
		value.CookiesRelativePath != "runtimes/camofox/cookies" || value.TracesRelativePath != "runtimes/camofox/traces" ||
		value.ProfileDirectoryFormat != "sha256-user-id-32" {
		return camofoxSidecar{}, errors.New("Camoufox sidecar is outside schema 1")
	}
	return value, nil
}

type sandboxRegistry struct {
	SchemaVersion    int                       `json:"schema_version"`
	TechnicalProfile string                    `json:"technical_profile"`
	Records          map[string]sandbox.Record `json:"records"`
}

type sandboxTransformer struct {
	targetImage string
	stoppedAt   time.Time
}

func (transformer *sandboxTransformer) Transform(_ context.Context, input TransformInput) error {
	raw, err := os.ReadFile(input.SourcePath)
	if err != nil {
		return err
	}
	value, err := decodeSandboxRegistry(raw, input.Mapping.Source, "")
	if err != nil {
		return err
	}
	value.TechnicalProfile = input.Mapping.Target.ProfileID
	for key, record := range value.Records {
		record.ContainerName = input.Mapping.Target.SandboxContainerPrefix + record.SandboxHash[:16]
		record.Image = transformer.targetImage
		record.ActiveCalls = 0
		record.BackgroundProcesses = 0
		stopped := transformer.stoppedAt
		record.StoppedAt = &stopped
		value.Records[key] = record
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return writeStructuredOutput(input.TargetPath, append(encoded, '\n'), input.SourceEntries[0])
}

type sandboxValidator struct {
	targetImage string
	stoppedAt   time.Time
}

func (validator *sandboxValidator) Validate(_ context.Context, input ValidationInput) error {
	sourceRaw, err := os.ReadFile(input.SourcePath)
	if err != nil {
		return err
	}
	source, err := decodeSandboxRegistry(sourceRaw, input.Mapping.Source, "")
	if err != nil {
		return err
	}
	raw, err := os.ReadFile(input.TargetPath)
	if err != nil {
		return err
	}
	value, err := decodeSandboxRegistry(raw, input.Mapping.Target, validator.targetImage)
	if err != nil {
		return err
	}
	if len(source.Records) != len(value.Records) {
		return errors.New("target Sandbox registry changed its stable record set")
	}
	for key, record := range value.Records {
		if record.ActiveCalls != 0 || record.BackgroundProcesses != 0 || record.StoppedAt == nil || !record.StoppedAt.Equal(validator.stoppedAt) {
			return errors.New("target Sandbox registry retained volatile execution state")
		}
		before, exists := source.Records[key]
		if !exists || before.SandboxID != record.SandboxID || before.SandboxHash != record.SandboxHash ||
			before.WorkspaceID != record.WorkspaceID || before.UID != record.UID || before.GID != record.GID ||
			before.WorkspacePath != record.WorkspacePath || before.HomePath != record.HomePath ||
			before.EnvironmentPath != record.EnvironmentPath || before.AttachmentsPath != record.AttachmentsPath ||
			!before.LastActivityAt.Equal(record.LastActivityAt) {
			return errors.New("target Sandbox registry changed a stable persistent binding")
		}
	}
	return nil
}

func decodeSandboxRegistry(raw []byte, profile identity.Profile, expectedImage string) (sandboxRegistry, error) {
	var value sandboxRegistry
	if err := decodeStrictJSON(raw, &value); err != nil {
		return sandboxRegistry{}, err
	}
	if value.SchemaVersion != sandboxSchema || value.TechnicalProfile != profile.ProfileID || value.Records == nil {
		return sandboxRegistry{}, errors.New("Sandbox registry is outside schema 2")
	}
	for key, record := range value.Records {
		hash := sha256.Sum256([]byte(key))
		wantHash := hex.EncodeToString(hash[:])
		workspaceID := filepath.ToSlash(filepath.Clean(record.WorkspaceID))
		attachments, attachmentsOK := sandboxAttachmentPath(workspaceID)
		if key == "" || record.SandboxID != key || record.SandboxHash != wantHash || record.ContainerName != profile.SandboxContainerPrefix+wantHash[:16] ||
			record.WorkspaceID == "" || workspaceID != record.WorkspaceID || !validWorkspaceID(workspaceID) || record.UID != os.Getuid() || record.GID != os.Getgid() ||
			record.WorkspacePath != "workspaces/"+workspaceID ||
			record.HomePath != "agent-envs/"+wantHash+"/home" || record.EnvironmentPath != "agent-envs/"+wantHash+"/env" ||
			!attachmentsOK || record.AttachmentsPath != attachments || record.Image == "" || record.LastActivityAt.IsZero() || record.ActiveCalls < 0 || record.BackgroundProcesses < 0 {
			return sandboxRegistry{}, fmt.Errorf("Sandbox registry record %q violates its stable identity", key)
		}
		if expectedImage != "" && record.Image != expectedImage {
			return sandboxRegistry{}, fmt.Errorf("Sandbox registry record %q does not use the target image", key)
		}
	}
	return value, nil
}

func validWorkspaceID(value string) bool {
	if value == "" || value == "." || strings.HasPrefix(value, "/") {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

func sandboxAttachmentPath(workspaceID string) (string, bool) {
	if strings.HasPrefix(workspaceID, "user-") && safeIdentitySegment(strings.TrimPrefix(workspaceID, "user-")) {
		return "attachments/private/" + strings.TrimPrefix(workspaceID, "user-"), true
	}
	for _, prefix := range []string{"channels/channel-", "channel-"} {
		if strings.HasPrefix(workspaceID, prefix) && safeIdentitySegment(strings.TrimPrefix(workspaceID, prefix)) {
			return "attachments/channel/" + strings.TrimPrefix(workspaceID, prefix), true
		}
	}
	return "", false
}

func safeIdentitySegment(value string) bool {
	if value == "" {
		return false
	}
	for _, character := range value {
		if !(character >= '0' && character <= '9' || character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character == '_' || character == '-') {
			return false
		}
	}
	return true
}

func runtimeSourceOnlyPath(value string) bool {
	first := strings.SplitN(filepath.ToSlash(value), "/", 2)[0]
	if containsString(contract.AgentRuntimeEphemeralRoots, first) {
		return true
	}
	return containsString(contract.AgentRuntimeP1RetiredRoots, first)
}

func readRuntimeDirectory(path string) ([]os.DirEntry, error) {
	directory, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer directory.Close()
	entries, readErr := directory.ReadDir(contract.AgentRuntimeMaximumDirectoryEntries + 1)
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		return nil, readErr
	}
	if len(entries) > contract.AgentRuntimeMaximumDirectoryEntries {
		return nil, errors.New("Agent Runtime directory entry count exceeds the handoff limit")
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	return entries, nil
}

type runtimeSourceValidator struct{}

func (runtimeSourceValidator) ValidateSource(ctx context.Context, root string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	entries, err := readRuntimeDirectory(root)
	if err != nil {
		return err
	}
	allowed := map[string]struct{}{}
	for _, name := range append(append([]string{}, contract.AgentRuntimeCurrentRoots...), append(contract.AgentRuntimeEphemeralRoots, contract.AgentRuntimeP1RetiredRoots...)...) {
		allowed[name] = struct{}{}
	}
	retired := map[string]bool{}
	for _, entry := range entries {
		if _, ok := allowed[entry.Name()]; !ok || !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("Agent Runtime source contains unknown top-level state %q", entry.Name())
		}
		if containsString(contract.AgentRuntimeP1RetiredRoots, entry.Name()) {
			retired[entry.Name()] = true
		}
		if containsString(contract.AgentRuntimeEphemeralRoots, entry.Name()) {
			if err := requireRuntimeRetiredDirectory(filepath.Join(root, entry.Name()), 0o700); err != nil {
				return err
			}
		}
	}
	if len(retired) == 0 {
		return nil
	}
	if len(retired) != len(contract.AgentRuntimeP1RetiredRoots) {
		return errors.New("Agent Runtime P1 retired roots are incomplete")
	}
	return validateP1RetiredRuntime(ctx, root)
}

func validateP1RetiredRuntime(ctx context.Context, root string) error {
	app := filepath.Join(root, "app")
	if err := requireRuntimeRetiredDirectory(app, os.FileMode(contract.AgentRuntimeP1AppMode)); err != nil {
		return err
	}
	top, err := readRuntimeDirectory(app)
	if err != nil {
		return err
	}
	actualTop := make([]string, 0, len(top))
	for _, entry := range top {
		actualTop = append(actualTop, entry.Name())
	}
	if !equalStringSlices(actualTop, contract.AgentRuntimeP1AppTopLevelEntries) {
		return errors.New("Agent Runtime retired app top-level inventory is invalid")
	}
	var install struct {
		InstalledAt     string `json:"installed_at"`
		SourceSignature string `json:"source_signature"`
	}
	if err := readStrictJSONFile(filepath.Join(app, "install.json"), 64<<10, &install); err != nil || install.InstalledAt == "" || install.SourceSignature != contract.AgentRuntimeP1InstallSignature {
		return errors.New("Agent Runtime retired app installation identity is invalid")
	}
	packageRaw, err := readBoundedRegular(filepath.Join(app, "package.json"), -1, 1<<20)
	if err != nil {
		return err
	}
	var packageValue map[string]json.RawMessage
	if err := decodeStrictJSON(packageRaw, &packageValue); err != nil {
		return err
	}
	var packageName, packageVersion string
	if json.Unmarshal(packageValue["name"], &packageName) != nil || json.Unmarshal(packageValue["version"], &packageVersion) != nil || packageName != contract.AgentRuntimeP1PackageName || packageVersion != contract.AgentRuntimeP1PackageVersion {
		return errors.New("Agent Runtime retired app package identity is invalid")
	}
	if err := validateP1RuntimeInventory(ctx, app); err != nil {
		return err
	}
	if err := validateEmptyRetiredRuntimeDirectory(filepath.Join(root, "home"), os.FileMode(contract.AgentRuntimeP1HomeMode)); err != nil {
		return err
	}
	if err := validateEmptyRetiredRuntimeDirectory(filepath.Join(root, "memory"), os.FileMode(contract.AgentRuntimeP1MemoryMode)); err != nil {
		return err
	}
	migration := filepath.Join(root, "migration")
	if err := requireRuntimeRetiredDirectory(migration, os.FileMode(contract.AgentRuntimeP1MigrationMode)); err != nil {
		return err
	}
	migrationEntries, err := readRuntimeDirectory(migration)
	if err != nil || len(migrationEntries) != 1 || migrationEntries[0].Name() != contract.AgentRuntimeP1MigrationFile || !migrationEntries[0].Type().IsRegular() {
		return errors.New("Agent Runtime retired migration inventory is invalid")
	}
	migrationPath := filepath.Join(migration, contract.AgentRuntimeP1MigrationFile)
	info, err := os.Lstat(migrationPath)
	if err != nil || info.Mode().Perm() != os.FileMode(contract.AgentRuntimeP1MigrationFileMode) {
		return errors.New("Agent Runtime retired migration file mode is invalid")
	}
	raw, err := readBoundedRegular(migrationPath, -1, 1<<20)
	if err != nil {
		return err
	}
	var migrationValue map[string]json.RawMessage
	if err := decodeStrictJSON(raw, &migrationValue); err != nil || !sameStringSet(mapKeys(migrationValue), contract.AgentRuntimeP1MigrationFields) {
		return errors.New("Agent Runtime retired migration record is invalid")
	}
	for field, encoded := range migrationValue {
		if field == "phase" {
			var phase string
			if json.Unmarshal(encoded, &phase) != nil || phase != contract.AgentRuntimeP1MigrationPhase {
				return errors.New("Agent Runtime retired migration phase is invalid")
			}
			continue
		}
		var value int64
		if json.Unmarshal(encoded, &value) != nil || value < 0 || (field == "version" && value != int64(contract.AgentRuntimeP1MigrationSchema)) {
			return fmt.Errorf("Agent Runtime retired migration field %s is invalid", field)
		}
	}
	return nil
}

func validateP1RuntimeInventory(ctx context.Context, root string) error {
	rootInfo, err := os.Lstat(root)
	if err != nil {
		return err
	}
	rootStat, ok := rootInfo.Sys().(*syscall.Stat_t)
	if !ok {
		return errors.New("Agent Runtime retired app filesystem identity is unavailable")
	}
	digest := sha256.New()
	entries := uint64(0)
	leafBytes := uint64(0)
	seenSymlinks := map[string]bool{}
	reserveRecord := func(kind byte, size uint64) error {
		if entries >= uint64(contract.AgentRuntimeP1AppInventoryEntries) {
			return errors.New("Agent Runtime retired app entry budget exceeded")
		}
		if kind != 'D' && (leafBytes > uint64(contract.AgentRuntimeP1AppRegularBytes) ||
			size > uint64(contract.AgentRuntimeP1AppRegularBytes)-leafBytes) {
			return errors.New("Agent Runtime retired app byte budget exceeded")
		}
		return nil
	}
	writeRecord := func(kind byte, relative string, info os.FileInfo, size uint64, detail []byte) {
		digest.Write([]byte{kind})
		_ = binary.Write(digest, binary.BigEndian, uint32(len([]byte(relative))))
		digest.Write([]byte(relative))
		_ = binary.Write(digest, binary.BigEndian, uint32(info.Mode().Perm()))
		_ = binary.Write(digest, binary.BigEndian, size)
		_ = binary.Write(digest, binary.BigEndian, uint32(len(detail)))
		digest.Write(detail)
		entries++
		if kind != 'D' {
			leafBytes += size
		}
	}
	if err := requireRuntimeRetiredEntry(rootInfo, uint64(rootStat.Dev), false); err != nil {
		return err
	}
	if err := reserveRecord('D', 0); err != nil {
		return err
	}
	writeRecord('D', ".", rootInfo, 0, nil)
	var walk func(string, string) error
	walk = func(directory, relative string) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		children, err := readRuntimeDirectory(directory)
		if err != nil {
			return err
		}
		if entries > uint64(contract.AgentRuntimeP1AppInventoryEntries) ||
			uint64(len(children)) > uint64(contract.AgentRuntimeP1AppInventoryEntries)-entries {
			return errors.New("Agent Runtime retired app layer exceeds the remaining entry budget")
		}
		type childEvidence struct {
			path     string
			relative string
			info     os.FileInfo
		}
		directories := make([]childEvidence, 0)
		leaves := make([]childEvidence, 0)
		layerLeafBytes := uint64(0)
		for _, child := range children {
			path := filepath.Join(directory, child.Name())
			info, err := os.Lstat(path)
			if err != nil {
				return err
			}
			childRelative := child.Name()
			if relative != "." {
				childRelative = relative + "/" + child.Name()
			}
			evidence := childEvidence{path: path, relative: childRelative, info: info}
			if info.IsDir() && info.Mode()&os.ModeSymlink == 0 {
				if err := requireRuntimeRetiredEntry(info, uint64(rootStat.Dev), false); err != nil {
					return err
				}
				directories = append(directories, evidence)
				continue
			}
			if !info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0 {
				return errors.New("Agent Runtime retired app contains a special file")
			}
			if err := requireRuntimeRetiredEntry(info, uint64(rootStat.Dev), true); err != nil {
				return err
			}
			if info.Size() < 0 || uint64(info.Size()) > ^uint64(0)-layerLeafBytes {
				return errors.New("Agent Runtime retired app layer byte size is invalid")
			}
			layerLeafBytes += uint64(info.Size())
			leaves = append(leaves, evidence)
		}
		if leafBytes > uint64(contract.AgentRuntimeP1AppRegularBytes) ||
			layerLeafBytes > uint64(contract.AgentRuntimeP1AppRegularBytes)-leafBytes {
			return errors.New("Agent Runtime retired app layer exceeds the remaining byte budget")
		}
		for _, child := range directories {
			if err := reserveRecord('D', 0); err != nil {
				return err
			}
			writeRecord('D', child.relative, child.info, 0, nil)
		}
		for _, child := range leaves {
			switch {
			case child.info.Mode().IsRegular():
				if err := reserveRecord('F', uint64(child.info.Size())); err != nil {
					return err
				}
				hexDigest, err := hashRegularNoFollowBounded(child.path, child.info, child.info.Size())
				if err != nil {
					return err
				}
				contentDigest, err := hex.DecodeString(hexDigest)
				if err != nil {
					return err
				}
				writeRecord('F', child.relative, child.info, uint64(child.info.Size()), contentDigest)
			case child.info.Mode()&os.ModeSymlink != 0:
				if err := reserveRecord('L', uint64(child.info.Size())); err != nil {
					return err
				}
				target, err := os.Readlink(child.path)
				if err != nil {
					return err
				}
				after, err := os.Lstat(child.path)
				if err != nil || !sameIdentityAndContentMetadata(child.info, after) {
					return errors.New("Agent Runtime retired symlink changed while reading")
				}
				expected, allowed := contract.AgentRuntimeP1AppAllowedSymlinks[child.relative]
				normalized := pathpkg.Clean(pathpkg.Join(pathpkg.Dir(child.relative), target))
				if !allowed || target != expected || pathpkg.IsAbs(target) || normalized == ".." || strings.HasPrefix(normalized, "../") || int64(len([]byte(target))) != child.info.Size() {
					return errors.New("Agent Runtime retired symlink is outside the contract")
				}
				seenSymlinks[child.relative] = true
				writeRecord('L', child.relative, child.info, uint64(len([]byte(target))), []byte(target))
			default:
				return errors.New("Agent Runtime retired app contains a special file")
			}
		}
		for _, child := range directories {
			if err := walk(child.path, child.relative); err != nil {
				return err
			}
		}
		return nil
	}
	if err := walk(root, "."); err != nil {
		return err
	}
	if len(seenSymlinks) != len(contract.AgentRuntimeP1AppAllowedSymlinks) {
		return errors.New("Agent Runtime retired symlink inventory is incomplete")
	}
	actualDigest := hex.EncodeToString(digest.Sum(nil))
	if actualDigest != contract.AgentRuntimeP1AppInventorySHA256 || entries != uint64(contract.AgentRuntimeP1AppInventoryEntries) || leafBytes != uint64(contract.AgentRuntimeP1AppRegularBytes) {
		return fmt.Errorf("Agent Runtime retired app inventory mismatch: digest=%s entries=%d bytes=%d", actualDigest, entries, leafBytes)
	}
	return nil
}

func requireRuntimeRetiredDirectory(path string, mode os.FileMode) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	statValue, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != mode || statValue.Uid != uint32(os.Getuid()) || statValue.Gid != uint32(os.Getgid()) {
		return fmt.Errorf("Agent Runtime retired directory metadata is unsafe: %s", path)
	}
	return nil
}

func requireRuntimeRetiredEntry(info os.FileInfo, device uint64, singleLink bool) error {
	statValue, ok := info.Sys().(*syscall.Stat_t)
	if !ok || uint64(statValue.Dev) != device || statValue.Uid != uint32(os.Getuid()) || statValue.Gid != uint32(os.Getgid()) || (singleLink && statValue.Nlink != 1) {
		return errors.New("Agent Runtime retired entry metadata is unsafe")
	}
	return nil
}

func validateEmptyRetiredRuntimeDirectory(path string, mode os.FileMode) error {
	if err := requireRuntimeRetiredDirectory(path, mode); err != nil {
		return err
	}
	entries, err := readRuntimeDirectory(path)
	if err != nil {
		return err
	}
	if len(entries) != 0 {
		return fmt.Errorf("Agent Runtime retired directory is not empty: %s", path)
	}
	return nil
}

func equalStringSlices(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func mapKeys(value map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func sameStringSet(left, right []string) bool {
	leftCopy := append([]string(nil), left...)
	rightCopy := append([]string(nil), right...)
	sort.Strings(leftCopy)
	sort.Strings(rightCopy)
	return equalStringSlices(leftCopy, rightCopy)
}

type runtimeValidator struct{ identities RuntimeIdentities }

func (validator *runtimeValidator) Validate(_ context.Context, input ValidationInput) error {
	if err := validateRuntimeTree(input.TargetPath, validator.identities); err != nil {
		return err
	}
	return validateMappedEntries(input.SourceEntries, input.TargetEntries, nil, nil)
}

func validateRuntimeTree(root string, identities RuntimeIdentities) error {
	if err := requireRuntimeCurrentPath(root, true); err != nil {
		return err
	}
	entries, err := readRuntimeDirectory(root)
	if err != nil {
		return err
	}
	allowed := map[string]bool{"sessions": true, "approvals": true, "idempotency": true}
	for _, entry := range entries {
		if !allowed[entry.Name()] || !entry.IsDir() || requireRuntimeCurrentPath(filepath.Join(root, entry.Name()), true) != nil {
			return fmt.Errorf("Agent Runtime contains unknown top-level state %q", entry.Name())
		}
	}
	if err := validateRuntimeSingletonDirectory(filepath.Join(root, "approvals"), "always.json"); err != nil {
		return err
	}
	if err := validateRuntimeSingletonDirectory(filepath.Join(root, "idempotency"), "index.json"); err != nil {
		return err
	}
	if err := validateAlwaysApprovals(filepath.Join(root, "approvals", "always.json"), identities); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := validateIdempotency(filepath.Join(root, "idempotency", "index.json"), identities); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	sessionsRoot := filepath.Join(root, "sessions")
	if _, err := os.Lstat(sessionsRoot); os.IsNotExist(err) {
		return nil
	}
	scopesByHash := scopeByHash(identities)
	for scopeKey := range identities.Scopes {
		scopeHash := stableHash(scopeKey)
		scopePath := filepath.Join(sessionsRoot, scopeHash)
		if _, err := os.Lstat(scopePath); os.IsNotExist(err) {
			continue
		}
		var manifest struct {
			ScopeKey string `json:"scope_key"`
		}
		if err := readStrictJSONFile(filepath.Join(scopePath, "scope.json"), 16<<10, &manifest); err != nil || manifest.ScopeKey != scopeKey {
			return fmt.Errorf("Agent Runtime scope manifest %s is invalid", scopeHash)
		}
	}
	seenSessionFiles := map[string]map[string]struct{}{}
	err = walkDirectoryBounded(context.Background(), sessionsRoot, contract.AgentRuntimeMaximumDirectoryEntries, func(path string, info os.FileInfo) (bool, error) {
		if path == sessionsRoot {
			return false, nil
		}
		rel, err := filepath.Rel(sessionsRoot, path)
		if err != nil {
			return false, err
		}
		parts := strings.Split(filepath.ToSlash(rel), "/")
		if info.IsDir() {
			if err := requireRuntimeCurrentPath(path, true); err != nil {
				return false, err
			}
			if len(parts) == 1 {
				if _, exists := scopesByHash[parts[0]]; !exists || !hexadecimalDigest.MatchString(parts[0]) {
					return false, errors.New("Agent Runtime contains an unknown scope directory")
				}
				return false, nil
			}
			if len(parts) == 2 {
				scopeKey, exists := scopesByHash[parts[0]]
				if !exists {
					return false, errors.New("Agent Runtime contains an unknown scope directory")
				}
				if _, _, exists := lifecycleByHash(identities.Sessions[scopeKey], parts[1]); !exists || !hexadecimalDigest.MatchString(parts[1]) {
					return false, errors.New("Agent Runtime contains an unknown lifecycle directory")
				}
				return false, nil
			}
			return false, fmt.Errorf("Agent Runtime contains an unknown nested directory %s", rel)
		}
		if err := requireRuntimeCurrentPath(path, false); err != nil {
			return false, err
		}
		if len(parts) == 2 && parts[1] == "scope.json" {
			if _, exists := scopesByHash[parts[0]]; !exists {
				return false, errors.New("Agent Runtime disk contains an unknown scope identity")
			}
			return false, nil
		}
		if len(parts) != 3 || !hexadecimalDigest.MatchString(parts[0]) || !hexadecimalDigest.MatchString(parts[1]) {
			return false, fmt.Errorf("Agent Runtime session path is outside the schema: %s", rel)
		}
		scopeKey, exists := scopesByHash[parts[0]]
		if !exists {
			return false, errors.New("Agent Runtime disk contains an unknown scope identity")
		}
		lifecycle, sessions, exists := lifecycleByHash(identities.Sessions[scopeKey], parts[1])
		if !exists {
			return false, errors.New("Agent Runtime disk contains an unknown lifecycle identity")
		}
		if parts[2] == "approvals.jsonl" {
			return false, validateApprovalJSONL(path, sessions)
		}
		sessionHash, suffix := runtimeSessionFilename(parts[2])
		session, exists := sessionByHash(sessions, sessionHash)
		if !exists || suffix == "" {
			return false, errors.New("Agent Runtime lifecycle contains an unknown file")
		}
		key := parts[0] + "/" + parts[1] + "/" + sessionHash
		if seenSessionFiles[key] == nil {
			seenSessionFiles[key] = map[string]struct{}{}
		}
		if _, duplicate := seenSessionFiles[key][suffix]; duplicate {
			return false, errors.New("Agent Runtime session file identity is duplicated")
		}
		seenSessionFiles[key][suffix] = struct{}{}
		if suffix == ".manifest.json" {
			return false, validateRuntimeManifest(path, scopeKey, lifecycle, session)
		}
		return false, validateSessionJSONL(path, scopeKey, lifecycle, session)
	})
	if err != nil {
		return err
	}
	for _, suffixes := range seenSessionFiles {
		if _, manifest := suffixes[".manifest.json"]; !manifest {
			return errors.New("Agent Runtime session journal or archive has no matching manifest")
		}
	}
	return nil
}

func validateRuntimeSingletonDirectory(path, allowedFile string) error {
	entries, err := readRuntimeDirectory(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := requireRuntimeCurrentPath(path, true); err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() != allowedFile || !entry.Type().IsRegular() || requireRuntimeCurrentPath(filepath.Join(path, entry.Name()), false) != nil {
			return fmt.Errorf("Agent Runtime contains unknown state %s/%s", filepath.Base(path), entry.Name())
		}
	}
	return nil
}

func requireRuntimeCurrentPath(path string, directory bool) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	statValue, ok := info.Sys().(*syscall.Stat_t)
	if !ok || info.Mode()&os.ModeSymlink != 0 || statValue.Uid != uint32(os.Getuid()) || statValue.Gid != uint32(os.Getgid()) {
		return fmt.Errorf("Agent Runtime current path has unsafe metadata: %s", path)
	}
	if directory {
		if !info.IsDir() || info.Mode().Perm() != 0o700 {
			return fmt.Errorf("Agent Runtime current directory has unsafe metadata: %s", path)
		}
		return nil
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 || statValue.Nlink != 1 {
		return fmt.Errorf("Agent Runtime current file has unsafe metadata: %s", path)
	}
	return nil
}

func validateAlwaysApprovals(path string, identities RuntimeIdentities) error {
	var value struct {
		Version int `json:"version"`
		Grants  []struct {
			ScopeKey    string `json:"scope_key"`
			ApprovalKey string `json:"approval_key"`
			ToolName    string `json:"tool_name"`
			CreatedAt   string `json:"created_at"`
		} `json:"grants"`
	}
	if err := readStrictJSONFile(path, 8<<20, &value); err != nil {
		return err
	}
	if value.Version != 2 || len(value.Grants) > contract.AgentRuntimeMaximumIdentityRecords {
		return errors.New("Agent Runtime permanent approvals are outside schema 2")
	}
	seen := map[string]struct{}{}
	for _, grant := range value.Grants {
		if _, exists := identities.Scopes[grant.ScopeKey]; !exists || !strings.HasPrefix(grant.ApprovalKey, "v2:") || grant.ToolName == "" || grant.CreatedAt == "" {
			return errors.New("Agent Runtime permanent approval is invalid")
		}
		key := grant.ScopeKey + "\x00" + grant.ApprovalKey
		if _, duplicate := seen[key]; duplicate {
			return errors.New("Agent Runtime permanent approval is duplicated")
		}
		seen[key] = struct{}{}
	}
	return nil
}

func validateIdempotency(path string, identities RuntimeIdentities) error {
	var value struct {
		Version int               `json:"version"`
		Records []json.RawMessage `json:"records"`
	}
	if err := readStrictJSONFile(path, 8<<20, &value); err != nil {
		return err
	}
	if value.Version != 1 || len(value.Records) > contract.AgentRuntimeMaximumIdentityRecords {
		return errors.New("Agent Runtime idempotency index is outside schema 1")
	}
	allowed := map[string]struct{}{"lookup_hash": {}, "run_id": {}, "session_id": {}, "status": {}, "created_at": {}, "updated_at": {}, "expires_at": {}, "result": {}, "inputs": {}, "error": {}}
	knownSessions := map[string]struct{}{}
	for _, lifecycles := range identities.Sessions {
		for _, sessions := range lifecycles {
			for session := range sessions {
				knownSessions[session] = struct{}{}
			}
		}
	}
	seen := map[string]struct{}{}
	for _, raw := range value.Records {
		var record map[string]json.RawMessage
		if err := decodeStrictJSON(raw, &record); err != nil {
			return err
		}
		for key := range record {
			if _, ok := allowed[key]; !ok {
				return fmt.Errorf("Agent Runtime idempotency record has unknown field %q", key)
			}
		}
		var lookup, run, session, status string
		if err := json.Unmarshal(record["lookup_hash"], &lookup); err != nil || !hexadecimalDigest.MatchString(lookup) {
			return errors.New("Agent Runtime idempotency lookup identity is invalid")
		}
		if err := json.Unmarshal(record["run_id"], &run); err != nil || run == "" {
			return errors.New("Agent Runtime idempotency run identity is invalid")
		}
		if err := json.Unmarshal(record["session_id"], &session); err != nil || session == "" {
			return errors.New("Agent Runtime idempotency session identity is invalid")
		}
		if _, exists := knownSessions[session]; !exists {
			return errors.New("Agent Runtime idempotency record references an unknown session")
		}
		if err := json.Unmarshal(record["status"], &status); err != nil || !containsString([]string{"completed", "failed", "cancelled", "needs_review"}, status) {
			return errors.New("Agent Runtime idempotency record is active or unknown")
		}
		var created, updated, expires int64
		if json.Unmarshal(record["created_at"], &created) != nil || json.Unmarshal(record["updated_at"], &updated) != nil ||
			json.Unmarshal(record["expires_at"], &expires) != nil || created < 0 || updated < created || expires < updated {
			return errors.New("Agent Runtime idempotency timestamps are invalid")
		}
		if _, duplicate := seen[lookup]; duplicate {
			return errors.New("Agent Runtime idempotency identity is duplicated")
		}
		seen[lookup] = struct{}{}
	}
	return nil
}

func validateRuntimeManifest(path, scope, lifecycle, session string) error {
	var value struct {
		ScopeKey    string `json:"scope_key"`
		LifecycleID string `json:"lifecycle_id"`
		SessionID   string `json:"session_id"`
		UpdatedAt   string `json:"updated_at"`
	}
	if err := readStrictJSONFile(path, 16<<10, &value); err != nil {
		return err
	}
	if value.ScopeKey != scope || value.LifecycleID != lifecycle || value.SessionID != session || value.UpdatedAt == "" {
		return errors.New("Agent Runtime session manifest identity is invalid")
	}
	return nil
}

func validateSessionJSONL(path, scope, lifecycle, session string) error {
	return scanJSONL(path, func(raw []byte) error {
		var value map[string]json.RawMessage
		if err := decodeStrictJSON(raw, &value); err != nil {
			return err
		}
		allowed := map[string]struct{}{"id": {}, "type": {}, "timestamp": {}, "scope_key": {}, "lifecycle_id": {}, "session_id": {}, "model_content_security_version": {}, "payload": {}}
		for key := range value {
			if _, ok := allowed[key]; !ok {
				return fmt.Errorf("Agent Runtime session entry has unknown field %q", key)
			}
		}
		var id, kind, timestamp, actualScope, actualLifecycle, actualSession string
		for field, target := range map[string]*string{"id": &id, "type": &kind, "timestamp": &timestamp, "scope_key": &actualScope, "lifecycle_id": &actualLifecycle, "session_id": &actualSession} {
			if err := json.Unmarshal(value[field], target); err != nil || *target == "" {
				return fmt.Errorf("Agent Runtime session entry %s is invalid", field)
			}
		}
		if !containsString([]string{"header", "message", "compaction", "run"}, kind) || actualScope != scope || actualLifecycle != lifecycle || actualSession != session || value["payload"] == nil {
			return errors.New("Agent Runtime session entry identity is invalid")
		}
		return nil
	})
}

func validateApprovalJSONL(path string, sessions map[string]struct{}) error {
	return scanJSONL(path, func(raw []byte) error {
		var value map[string]json.RawMessage
		if err := decodeStrictJSON(raw, &value); err != nil {
			return err
		}
		allowed := map[string]struct{}{"id": {}, "type": {}, "timestamp": {}, "session_id": {}, "tool_name": {}, "approval_key": {}}
		for key := range value {
			if _, ok := allowed[key]; !ok {
				return fmt.Errorf("Agent Runtime approval entry has unknown field %q", key)
			}
		}
		var id, kind, timestamp string
		if json.Unmarshal(value["id"], &id) != nil || json.Unmarshal(value["type"], &kind) != nil || json.Unmarshal(value["timestamp"], &timestamp) != nil || id == "" || timestamp == "" || (kind != "grant" && kind != "clear") {
			return errors.New("Agent Runtime approval entry is invalid")
		}
		if kind == "clear" {
			if value["session_id"] != nil || value["tool_name"] != nil || value["approval_key"] != nil {
				return errors.New("Agent Runtime approval clear entry contains grant fields")
			}
			return nil
		}
		var session, tool, approval string
		if json.Unmarshal(value["session_id"], &session) != nil || json.Unmarshal(value["tool_name"], &tool) != nil ||
			json.Unmarshal(value["approval_key"], &approval) != nil || tool == "" || !strings.HasPrefix(approval, "v2:") {
			return errors.New("Agent Runtime approval grant entry is invalid")
		}
		if _, exists := sessions[session]; !exists {
			return errors.New("Agent Runtime approval references an unknown session")
		}
		return nil
	})
}

type structuredTreeRewrite struct {
	File        func(string, []byte) (string, []byte, error)
	RewriteFile func(string) bool
	Entry       func(Entry, string) (Entry, error)
}

func copyStructuredTree(ctx context.Context, input TransformInput, rewrite structuredTreeRewrite, exclude func(string) bool) error {
	if len(input.SourceEntries) == 0 || input.SourceEntries[0].Path != "." || input.SourceEntries[0].Type != Directory {
		return errors.New("structured tree source manifest is invalid")
	}
	if err := os.Mkdir(input.TargetPath, 0o700); err != nil {
		return err
	}
	entries := append([]Entry(nil), input.SourceEntries...)
	sort.SliceStable(entries, func(i, j int) bool {
		left, right := pathDepth(entries[i].Path), pathDepth(entries[j].Path)
		if left != right {
			return left < right
		}
		if entries[i].Type != entries[j].Type {
			return entries[i].Type == Directory
		}
		return entries[i].Path < entries[j].Path
	})
	seenTargets := map[string]struct{}{".": {}}
	mappedDirectories := make([]Entry, 0)
	for _, entry := range entries {
		if exclude != nil && exclude(entry.Path) {
			continue
		}
		source := filepath.Join(input.SourcePath, filepath.FromSlash(entry.Path))
		targetRelative := entry.Path
		var payload []byte
		var err error
		if entry.Type == RegularFile && rewrite.File != nil && (rewrite.RewriteFile == nil || rewrite.RewriteFile(entry.Path)) {
			payload, err = readBoundedRegular(source, entry.Size, maximumMetadataSize)
			if err != nil {
				return err
			}
			targetRelative, payload, err = rewrite.File(entry.Path, payload)
			if err != nil {
				return err
			}
		}
		mapped := entry
		mapped.Path = filepath.ToSlash(targetRelative)
		if rewrite.Entry != nil {
			mapped, err = rewrite.Entry(entry, targetRelative)
			if err != nil {
				return err
			}
		}
		if mapped.UID != uint32(os.Getuid()) || mapped.GID != uint32(os.Getgid()) {
			return fmt.Errorf("structured target %s cannot be owned by the deployment identity", mapped.Path)
		}
		if mapped.Path != "." {
			if validateRelative(mapped.Path) != nil {
				return fmt.Errorf("structured transformer produced invalid target path %q", mapped.Path)
			}
			if _, duplicate := seenTargets[mapped.Path]; duplicate {
				return fmt.Errorf("structured transformer produced duplicate target %q", mapped.Path)
			}
			seenTargets[mapped.Path] = struct{}{}
		}
		if mapped.Type == Directory {
			mappedDirectories = append(mappedDirectories, mapped)
		}
		if mapped.Path == "." {
			continue
		}
		target := filepath.Join(input.TargetPath, filepath.FromSlash(mapped.Path))
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		if mapped.Type == Directory {
			if err := os.Mkdir(target, 0o700); err != nil {
				return err
			}
			continue
		}
		if payload != nil {
			if err := writeStructuredOutput(target, payload, mapped); err != nil {
				return err
			}
		} else if err := copyStructuredFile(ctx, source, target, mapped); err != nil {
			return err
		}
	}
	sort.Slice(mappedDirectories, func(i, j int) bool {
		return pathDepth(mappedDirectories[i].Path) > pathDepth(mappedDirectories[j].Path)
	})
	for _, entry := range mappedDirectories {
		path := input.TargetPath
		if entry.Path != "." {
			path = filepath.Join(input.TargetPath, filepath.FromSlash(entry.Path))
		}
		if err := os.Chmod(path, os.FileMode(entry.Mode)); err != nil {
			return err
		}
		when := time.Unix(0, entry.ModifiedNanos)
		if err := os.Chtimes(path, when, when); err != nil {
			return err
		}
	}
	return nil
}

func copyStructuredFile(ctx context.Context, source, target string, entry Entry) error {
	if entry.Size < 0 {
		return errors.New("structured source has a negative expected size")
	}
	sourceInfo, err := os.Lstat(source)
	if err != nil {
		return err
	}
	sourceFile, err := os.Open(source)
	if err != nil {
		return err
	}
	defer sourceFile.Close()
	if err := sameOpenFile(sourceFile, sourceInfo); err != nil {
		return err
	}
	targetFile, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	hash := sha256.New()
	written, copyErr := io.CopyBuffer(
		io.MultiWriter(targetFile, hash),
		&contextReader{ctx: ctx, reader: io.LimitReader(sourceFile, entry.Size)},
		make([]byte, defaultCopyBuffer),
	)
	if copyErr == nil {
		if contextErr := ctx.Err(); contextErr != nil {
			copyErr = contextErr
		} else {
			var extra [1]byte
			extraBytes, extraErr := sourceFile.Read(extra[:])
			if extraBytes != 0 || !errors.Is(extraErr, io.EOF) {
				copyErr = errors.Join(extraErr, errors.New("structured source exceeded its exact copy bound"))
			}
		}
	}
	after, metadataErr := os.Lstat(source)
	if metadataErr != nil || !sameIdentityAndContentMetadata(sourceInfo, after) {
		copyErr = errors.Join(copyErr, metadataErr, errors.New("structured source changed while copying"))
	}
	syncErr := targetFile.Sync()
	closeErr := targetFile.Close()
	if err := errors.Join(copyErr, syncErr, closeErr); err != nil {
		return err
	}
	if written != entry.Size || hex.EncodeToString(hash.Sum(nil)) != entry.SHA256 {
		return errors.New("structured source content differs from its preflight manifest")
	}
	if err := os.Chmod(target, os.FileMode(entry.Mode)); err != nil {
		return err
	}
	when := time.Unix(0, entry.ModifiedNanos)
	return os.Chtimes(target, when, when)
}

func writeStructuredOutput(path string, data []byte, entry Entry) error {
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return err
	}
	if err := os.Chmod(path, os.FileMode(entry.Mode)); err != nil {
		return err
	}
	when := time.Unix(0, entry.ModifiedNanos)
	return os.Chtimes(path, when, when)
}

func validateMappedEntries(sourceEntries, targetEntries []Entry, rewritePath func(string) (string, bool), changed map[string]struct{}) error {
	target := entriesByPath(targetEntries)
	seen := map[string]struct{}{}
	for _, source := range sourceEntries {
		path, rewritten := source.Path, false
		if rewritePath != nil {
			path, rewritten = rewritePath(path)
		}
		candidate, exists := target[path]
		if !exists {
			return fmt.Errorf("target is missing structured source entry %s", path)
		}
		seen[path] = struct{}{}
		_, contentChanged := changed[source.Path]
		if !rewritten && !contentChanged && !contentInvariantEqual(source, candidate) {
			return fmt.Errorf("structured entry %s changed unexpectedly (source mode=%#o size=%d mtime=%d sha=%s, target mode=%#o size=%d mtime=%d sha=%s)",
				source.Path, source.Mode, source.Size, source.ModifiedNanos, source.SHA256,
				candidate.Mode, candidate.Size, candidate.ModifiedNanos, candidate.SHA256)
		}
		if source.Type != candidate.Type || source.Mode != candidate.Mode || source.UID != candidate.UID || source.GID != candidate.GID {
			return fmt.Errorf("structured entry %s metadata changed unexpectedly", source.Path)
		}
	}
	if len(seen) != len(target) {
		return errors.New("structured target contains unexpected entries")
	}
	return nil
}

func openSQLite(path, mode string) (*sql.DB, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || (mode != "ro" && mode != "rw" && mode != "rwc") {
		return nil, errors.New("SQLite path or mode is invalid")
	}
	uri := (&url.URL{Scheme: "file", Path: path}).String() + "?mode=" + mode + "&_pragma=busy_timeout(30000)"
	database, err := sql.Open("sqlite", uri)
	if err != nil {
		return nil, err
	}
	database.SetMaxOpenConns(1)
	if err := database.Ping(); err != nil {
		database.Close()
		return nil, err
	}
	return database, nil
}

func openImmutableSQLite(path string) (*sql.DB, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, errors.New("immutable SQLite path is invalid")
	}
	uri := (&url.URL{Scheme: "file", Path: path}).String() + "?mode=ro&immutable=1&_pragma=busy_timeout(30000)"
	database, err := sql.Open("sqlite", uri)
	if err != nil {
		return nil, err
	}
	database.SetMaxOpenConns(1)
	if err := database.Ping(); err != nil {
		database.Close()
		return nil, err
	}
	return database, nil
}

func verifySQLiteHealth(ctx context.Context, database *sql.DB) error {
	var integrity string
	if err := database.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&integrity); err != nil || integrity != "ok" {
		return fmt.Errorf("SQLite integrity_check failed: %q (%v)", integrity, err)
	}
	rows, err := database.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		return err
	}
	defer rows.Close()
	if rows.Next() {
		return errors.New("SQLite foreign_key_check returned violations")
	}
	return rows.Err()
}

func verifyDatabaseBaseline(ctx context.Context, database *sql.DB, version int, name string) error {
	var count int
	var actualVersion int
	var actualName string
	if err := database.QueryRowContext(ctx, "SELECT count(*), COALESCE(max(version), 0), COALESCE(max(name), '') FROM schema_migrations").Scan(&count, &actualVersion, &actualName); err != nil {
		return err
	}
	if count != 1 || actualVersion != version || actualName != name {
		return fmt.Errorf("Platform database baseline is %d/%q, expected %d/%q", actualVersion, actualName, version, name)
	}
	return nil
}

func databaseProjection(ctx context.Context, database *sql.DB, version int, baseline string) (string, error) {
	hash := sha256.New()
	rows, err := database.QueryContext(ctx, `SELECT type, name, tbl_name, COALESCE(sql, '') FROM sqlite_master ORDER BY type, name, tbl_name, sql`)
	if err != nil {
		return "", err
	}
	var tables []string
	for rows.Next() {
		var kind, name, table, statement string
		if err := rows.Scan(&kind, &name, &table, &statement); err != nil {
			rows.Close()
			return "", err
		}
		fmt.Fprintf(hash, "schema\x00%s\x00%s\x00%s\x00%s\n", kind, name, table, statement)
		if kind == "table" {
			tables = append(tables, name)
		}
	}
	if err := rows.Close(); err != nil {
		return "", err
	}
	for _, table := range tables {
		projection, err := tableProjection(ctx, database, table, version, baseline)
		if err != nil {
			return "", err
		}
		fmt.Fprintf(hash, "table\x00%s\x00%s\n", table, projection)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func tableProjection(ctx context.Context, database *sql.DB, table string, version int, baseline string) (string, error) {
	rows, err := database.QueryContext(ctx, "SELECT * FROM "+quoteSQLiteIdentifier(table))
	if err != nil {
		return "", err
	}
	columns, err := rows.Columns()
	if err != nil {
		rows.Close()
		return "", err
	}
	var records []string
	for rows.Next() {
		values := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for index := range values {
			pointers[index] = &values[index]
		}
		if err := rows.Scan(pointers...); err != nil {
			rows.Close()
			return "", err
		}
		rowHash := sha256.New()
		for index, value := range values {
			if table == "schema_migrations" && columns[index] == "name" {
				value = "<technical-baseline>"
			}
			writeSQLValue(rowHash, value)
		}
		records = append(records, hex.EncodeToString(rowHash.Sum(nil)))
	}
	if err := rows.Close(); err != nil {
		return "", err
	}
	if table == "schema_migrations" {
		if len(records) != 1 {
			return "", errors.New("schema_migrations must contain exactly one baseline row")
		}
		if err := verifyDatabaseBaseline(ctx, database, version, baseline); err != nil {
			return "", err
		}
	}
	sort.Strings(records)
	hash := sha256.New()
	for _, record := range records {
		fmt.Fprintln(hash, record)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func writeSQLValue(writer io.Writer, value any) {
	switch typed := value.(type) {
	case nil:
		fmt.Fprint(writer, "n:")
	case int64:
		fmt.Fprintf(writer, "i:%d", typed)
	case float64:
		fmt.Fprintf(writer, "f:%016x", mathFloat64bits(typed))
	case bool:
		fmt.Fprintf(writer, "b:%t", typed)
	case []byte:
		fmt.Fprintf(writer, "x:%x", typed)
	case string:
		fmt.Fprintf(writer, "s:%x", []byte(typed))
	default:
		fmt.Fprintf(writer, "u:%T:%v", value, value)
	}
	fmt.Fprint(writer, "\x00")
}

func quoteSQLiteIdentifier(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}

func decodeStrictJSON(raw []byte, target any) error {
	if len(raw) == 0 || len(raw) > maximumMetadataSize {
		return errors.New("JSON size is outside the handoff schema limit")
	}
	if err := rejectDuplicateJSONKeys(raw); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	return requireJSONEOF(decoder)
}

func readStrictJSONFile(path string, maximum int64, target any) error {
	raw, err := readBoundedRegular(path, -1, maximum)
	if err != nil {
		return err
	}
	return decodeStrictJSON(raw, target)
}

func readBoundedRegular(path string, exact, maximum int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || stat.Nlink != 1 || info.Size() < 0 || info.Size() > maximum || (exact >= 0 && info.Size() != exact) {
		return nil, errors.New("file is not a safe bounded regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return nil, errors.New("file identity changed while opening")
	}
	raw, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil || int64(len(raw)) > maximum {
		return nil, errors.New("file changed or exceeded its handoff size limit")
	}
	after, err := file.Stat()
	if err != nil || !os.SameFile(opened, after) || after.Size() != int64(len(raw)) || (exact >= 0 && after.Size() != exact) {
		return nil, errors.New("file identity or size changed while reading")
	}
	return raw, nil
}

func scanJSONL(path string, validate func([]byte) error) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || stat.Nlink != 1 || info.Size() < 0 || info.Size() > contract.AgentRuntimeMaximumJSONLBytes {
		return errors.New("Agent Runtime JSONL is not a safe bounded regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return errors.New("Agent Runtime JSONL identity changed while opening")
	}
	limited := &io.LimitedReader{R: file, N: contract.AgentRuntimeMaximumJSONLBytes + 1}
	reader := bufio.NewReader(limited)
	count := 0
	for {
		line, readErr := reader.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) != 0 {
			count++
			if count > contract.AgentRuntimeMaximumJSONLRecords {
				return errors.New("Agent Runtime JSONL entry count exceeds the limit")
			}
			if err := validate(bytes.TrimSpace(line)); err != nil {
				return err
			}
		}
		if errors.Is(readErr, io.EOF) {
			if limited.N <= 0 {
				return errors.New("Agent Runtime JSONL exceeded the handoff size limit")
			}
			after, statErr := file.Stat()
			if statErr != nil || !os.SameFile(opened, after) || after.Size() != info.Size() {
				return errors.New("Agent Runtime JSONL changed while reading")
			}
			return nil
		}
		if readErr != nil {
			return readErr
		}
	}
}

func stableHash(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

func scopeByHash(identities RuntimeIdentities) map[string]string {
	out := make(map[string]string, len(identities.Scopes))
	for scope := range identities.Scopes {
		out[stableHash(scope)] = scope
	}
	return out
}

func lifecycleByHash(values map[string]map[string]struct{}, hash string) (string, map[string]struct{}, bool) {
	for lifecycle, sessions := range values {
		if stableHash(lifecycle) == hash {
			return lifecycle, sessions, true
		}
	}
	return "", nil, false
}

func sessionByHash(values map[string]struct{}, hash string) (string, bool) {
	for session := range values {
		if stableHash(session) == hash {
			return session, true
		}
	}
	return "", false
}

func runtimeSessionFilename(name string) (string, string) {
	for _, suffix := range []string{".manifest.json", ".archive.jsonl", ".jsonl"} {
		if strings.HasSuffix(name, suffix) {
			return strings.TrimSuffix(name, suffix), suffix
		}
	}
	return "", ""
}

func validateScopeIdentity(value ScopeIdentity) error {
	if value.ScopeKey == "" || value.ScopeID == "" || value.LifecycleID == "" || value.SandboxID == "" || value.WorkspaceID == "" ||
		(value.ScopeType != "private" && value.ScopeType != "channel") || filepath.IsAbs(value.WorkspaceID) || filepath.Clean(value.WorkspaceID) != value.WorkspaceID || strings.Contains(value.WorkspaceID, "..") {
		return errors.New("Platform database contains an invalid Agent scope identity")
	}
	return nil
}

func cloneRuntimeIdentities(input RuntimeIdentities) RuntimeIdentities {
	out := RuntimeIdentities{Scopes: map[string]ScopeIdentity{}, Sessions: map[string]map[string]map[string]struct{}{}}
	for key, value := range input.Scopes {
		out.Scopes[key] = value
	}
	for scope, lifecycles := range input.Sessions {
		out.Sessions[scope] = map[string]map[string]struct{}{}
		for lifecycle, sessions := range lifecycles {
			out.Sessions[scope][lifecycle] = map[string]struct{}{}
			for session := range sessions {
				out.Sessions[scope][lifecycle][session] = struct{}{}
			}
		}
	}
	return out
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func semanticDigest(value any) string {
	raw, err := json.Marshal(value)
	if err != nil {
		panic(fmt.Sprintf("encode compile-time handoff transformation identity: %v", err))
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

// Tiny wrappers keep the schema file dependency surface explicit.
func regexpMust(pattern string) *regexp.Regexp { return regexp.MustCompile(pattern) }
func mathFloat64bits(value float64) uint64     { return math.Float64bits(value) }
