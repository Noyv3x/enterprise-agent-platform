//go:build linux

package handofftransform

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	pathpkg "path"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffhelper"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/selfupdate"
	"golang.org/x/sys/unix"
)

const (
	maximumProductionComposeBytes = 8 << 20
	maximumProductionManagerBytes = 128 << 20
	p1CamofoxDirectoryBatchSize   = 128
)

// TargetFenceVerifier is the final independent guard before rollback removes
// an atomically published target root. The participant boundary stops the
// target first; this verifier must prove that no target Manager, fixed service,
// Sandbox, or other writer remains.
type TargetFenceVerifier interface {
	VerifyTargetWritersStopped(context.Context, handoffhelper.Operation) (TargetFenceProof, error)
}

// TargetFenceProof is an opaque transaction capability returned only after a
// concrete verifier has independently proven every target writer stopped.
// Its fields are private so callers cannot synthesize a partially bound proof.
type TargetFenceProof struct {
	transactionID string
	bindingSHA256 string
}

// NewTargetFenceProof seals the already-verified operation identity. Concrete
// host verifiers call this only after all unit, container and Sandbox writer
// checks succeed.
func NewTargetFenceProof(operation handoffhelper.Operation) (TargetFenceProof, error) {
	if !transactionIDPattern.MatchString(operation.TransactionID) || !sha256Pattern.MatchString(operation.BindingSHA256) {
		return TargetFenceProof{}, errors.New("target-writer fence operation identity is invalid")
	}
	return TargetFenceProof{transactionID: operation.TransactionID, bindingSHA256: operation.BindingSHA256}, nil
}

func (proof TargetFenceProof) validate(operation handoffhelper.Operation) error {
	if proof.transactionID != operation.TransactionID || proof.bindingSHA256 != operation.BindingSHA256 ||
		!transactionIDPattern.MatchString(proof.transactionID) || !sha256Pattern.MatchString(proof.bindingSHA256) {
		return errors.New("target-writer fence proof differs from the rollback operation")
	}
	return nil
}

// ProductionEnvironment contains the immutable inputs used by DockerCLI's
// target compose.env generator. Keeping them explicit lets the handoff stage
// the exact file which the target driver will later reproduce.
type ProductionEnvironment struct {
	GatewayAddress string
	PlatformBind   string
	LogMaxSize     string
	LogMaxFiles    int
}

// ProductionBoundaryOptions binds one helper-side data transition to the
// signed bridge artifact and the target Docker configuration. TargetCompose
// and TargetManager must be the already downloaded immutable target artifacts;
// the data boundary performs no network I/O.
type ProductionBoundaryOptions struct {
	Engine Engine

	ReleaseChannel string
	GOOS           string
	GOARCH         string
	TargetManifest []byte
	TargetCompose  []byte
	TargetManager  []byte
	Environment    ProductionEnvironment
	ReserveBytes   uint64

	TargetFence TargetFenceVerifier
}

// ProductionBoundary is the helper's production DataBoundary. It builds the
// resource list from current, versioned readers after writers are stopped and
// delegates all filesystem publication/removal to Engine's transaction-bound
// primitives.
type ProductionBoundary struct {
	engine         Engine
	channel        string
	goos           string
	goarch         string
	targetCompose  []byte
	targetManifest []byte
	targetManager  []byte
	environment    ProductionEnvironment
	reserveBytes   uint64
	runtimeOwners  map[string][]Owner
	targetFence    TargetFenceVerifier
	configuration  error
}

var _ handoffhelper.DataBoundary = (*ProductionBoundary)(nil)

func NewProductionBoundary(options ProductionBoundaryOptions) (*ProductionBoundary, error) {
	if options.GOOS == "" {
		options.GOOS = runtime.GOOS
	}
	if options.GOARCH == "" {
		options.GOARCH = runtime.GOARCH
	}
	boundary := &ProductionBoundary{
		engine: options.Engine, channel: strings.TrimSpace(options.ReleaseChannel),
		goos: options.GOOS, goarch: options.GOARCH,
		targetManifest: append([]byte(nil), options.TargetManifest...), targetCompose: append([]byte(nil), options.TargetCompose...),
		targetManager: append([]byte(nil), options.TargetManager...), environment: options.Environment,
		reserveBytes: options.ReserveBytes,
		targetFence:  options.TargetFence,
	}
	boundary.configuration = boundary.validateConfiguration()
	if boundary.configuration != nil {
		return nil, boundary.configuration
	}
	return boundary, nil
}

func (boundary *ProductionBoundary) ValidateConfiguration() error {
	if boundary == nil {
		return errors.New("production handoff data boundary is nil")
	}
	return boundary.configuration
}

// StageTarget creates a complete transaction-owned sibling staging tree but
// never publishes TargetRoot. Replaying this method verifies and rebuilds only
// the same request-bound staging tree.
func (boundary *ProductionBoundary) StageTarget(ctx context.Context, operation handoffhelper.Operation) error {
	request, err := boundary.request(ctx, operation, true)
	if err != nil {
		return err
	}
	if _, err := boundary.engine.Stage(ctx, request); err != nil {
		return fmt.Errorf("stage production target data: %w", err)
	}
	return nil
}

// TransformAndPublish first reopens and validates the complete durable
// staging manifest, then performs one same-filesystem atomic rename. A crash
// after rename is recognized only when the published marker, manifest, and all
// target resources still match this exact immutable request.
func (boundary *ProductionBoundary) TransformAndPublish(ctx context.Context, operation handoffhelper.Operation) error {
	request, err := boundary.request(ctx, operation, false)
	if err != nil {
		return err
	}
	if _, err := os.Lstat(request.TargetRoot); err == nil {
		if _, verifyErr := boundary.engine.VerifyPublished(ctx, request); verifyErr != nil {
			return fmt.Errorf("verify replayed production target publication: %w", verifyErr)
		}
		return nil
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect production target publication: %w", err)
	}
	if _, err := boundary.engine.VerifyStaged(ctx, request); err != nil {
		return fmt.Errorf("verify production target staging before publish: %w", err)
	}
	if _, err := boundary.engine.Publish(ctx, request); err != nil {
		return fmt.Errorf("publish production target data: %w", err)
	}
	return nil
}

// RestoreData is available only after a separate target-writer fence. It
// removes either the exact published target or the exact uncommitted staging
// checkpoint; an unknown/conflicting object is retained and reported.
func (boundary *ProductionBoundary) RestoreData(ctx context.Context, operation handoffhelper.Operation) error {
	fenceProof, err := boundary.targetFence.VerifyTargetWritersStopped(ctx, operation)
	if err != nil {
		return fmt.Errorf("prove target writers stopped before data rollback: %w", err)
	}
	if err := fenceProof.validate(operation); err != nil {
		return fmt.Errorf("validate target-writer fence proof before data rollback: %w", err)
	}
	request, err := boundary.request(ctx, operation, false)
	if err != nil {
		return err
	}
	if _, err := os.Lstat(request.TargetRoot); err == nil {
		if err := boundary.engine.removePublished(ctx, request, fenceProof.bindingSHA256); err != nil {
			return fmt.Errorf("remove transaction-published target data: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect transaction-published target data: %w", err)
	}
	if err := boundary.engine.Cleanup(request); err != nil {
		return fmt.Errorf("remove transaction target staging during rollback: %w", err)
	}
	return nil
}

// RemoveTargetStaging is the pre-fence abort cleanup. It never removes a
// published target. In the normal protocol no staging exists before
// source_fenced. Therefore an existing pre-fence tree is conflicting evidence:
// retain it and fail closed without reading or enumerating the live source.
func (boundary *ProductionBoundary) RemoveTargetStaging(_ context.Context, operation handoffhelper.Operation) error {
	if err := boundary.validateOperation(operation); err != nil {
		return err
	}
	if _, err := os.Lstat(operation.Target.DataRoot); err == nil {
		return errors.New("pre-fence staging cleanup refuses an existing target root")
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect target root during staging cleanup: %w", err)
	}
	stage := productionStagingPath(operation.Target.DataRoot, operation.TransactionID)
	if _, err := os.Lstat(stage); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return fmt.Errorf("inspect transaction staging during abort: %w", err)
	}
	return errors.New("pre-fence transaction staging unexpectedly exists; retain it for recovery")
}

func (boundary *ProductionBoundary) validateConfiguration() error {
	if gaps := CurrentSchemaGaps(); len(gaps) != 0 {
		return fmt.Errorf("current machine-owned handoff schemas are incomplete: %v", gaps)
	}
	if boundary.channel == "" {
		return errors.New("production handoff release channel is required")
	}
	if boundary.goos != "linux" || (boundary.goarch != "amd64" && boundary.goarch != "arm64") {
		return fmt.Errorf("production handoff data boundary does not support %s/%s", boundary.goos, boundary.goarch)
	}
	if len(boundary.targetCompose) == 0 || len(boundary.targetCompose) > maximumProductionComposeBytes {
		return errors.New("target Compose artifact size is outside the production handoff limit")
	}
	if len(boundary.targetManifest) == 0 || len(boundary.targetManifest) > maximumMetadataSize {
		return errors.New("target manifest artifact size is outside the production handoff limit")
	}
	if len(boundary.targetManager) == 0 || len(boundary.targetManager) > maximumProductionManagerBytes {
		return errors.New("target Manager artifact size is outside the production handoff limit")
	}
	if boundary.targetFence == nil {
		return errors.New("production handoff data rollback requires an independent target-writer fence")
	}
	if boundary.engine.PrivilegedTreeFS == nil {
		return errors.New("production handoff data boundary requires a privileged container-owned tree filesystem")
	}
	if err := validateProductionEnvironment(boundary.environment); err != nil {
		return err
	}
	uid, gid := boundary.engine.effectiveUID(), boundary.engine.effectiveGID()
	expectedOwnerSets := []string{"cognee", "searxng", "firecrawl-redis", "firecrawl-rabbitmq", "firecrawl-postgres"}
	if len(contract.PersistentDataOwners) != len(expectedOwnerSets) {
		return errors.New("canonical persistent data owner contract is incomplete")
	}
	boundary.runtimeOwners = make(map[string][]Owner, len(expectedOwnerSets))
	for _, service := range expectedOwnerSets {
		configured, exists := contract.PersistentDataOwners[service]
		if !exists {
			return fmt.Errorf("canonical persistent data owner contract lacks %s", service)
		}
		owners := []Owner{{UID: uint32(uid), GID: uint32(gid)}}
		for _, owner := range configured {
			owners = append(owners, Owner{UID: owner.UID, GID: owner.GID})
		}
		if err := validateOwners(owners, uid, gid, service, "source/target"); err != nil {
			return err
		}
		boundary.runtimeOwners[service] = ownerSet(owners, uid, gid)
	}
	return nil
}

func validateProductionEnvironment(environment ProductionEnvironment) error {
	for label, value := range map[string]string{
		"gateway address": environment.GatewayAddress,
		"Platform bind":   environment.PlatformBind,
		"log size":        environment.LogMaxSize,
	} {
		if strings.TrimSpace(value) == "" || strings.ContainsAny(value, "\r\n\x00=") {
			return fmt.Errorf("production target %s is invalid", label)
		}
	}
	if _, _, err := net.SplitHostPort(environment.GatewayAddress); err != nil {
		return fmt.Errorf("production target gateway address: %w", err)
	}
	if _, _, err := net.SplitHostPort(environment.PlatformBind); err != nil {
		return fmt.Errorf("production target Platform bind: %w", err)
	}
	if environment.LogMaxFiles < 1 || environment.LogMaxFiles > 1000 {
		return errors.New("production target log file count is outside 1..1000")
	}
	return nil
}

func (boundary *ProductionBoundary) request(ctx context.Context, operation handoffhelper.Operation, checkpoint bool) (Request, error) {
	if err := boundary.ValidateConfiguration(); err != nil {
		return Request{}, err
	}
	if err := boundary.validateOperation(operation); err != nil {
		return Request{}, err
	}
	manifest, manifestRaw, err := boundary.bridgeManifest(operation)
	if err != nil {
		return Request{}, err
	}
	if err := validateProductionSourceLayout(operation.Source.DataRoot, boundary.engine.effectiveUID(), boundary.engine.effectiveGID()); err != nil {
		return Request{}, fmt.Errorf("validate closed production source layout: %w", err)
	}
	databasePath := filepath.Join(operation.Source.DataRoot, "data", "platform.db")
	if checkpoint {
		if err := CheckpointPlatformDatabase(ctx, databasePath, manifest.DatabaseSchemaVersion); err != nil {
			return Request{}, fmt.Errorf("checkpoint source Platform database: %w", err)
		}
	}
	identities, err := LoadAuthoritativeIdentities(ctx, databasePath, manifest.DatabaseSchemaVersion)
	if err != nil {
		return Request{}, fmt.Errorf("load authoritative handoff identities: %w", err)
	}
	resources, err := boundary.resources(operation, manifest, manifestRaw, identities)
	if err != nil {
		return Request{}, err
	}
	if err := validateProductionSchemaSet(resources); err != nil {
		return Request{}, err
	}
	return Request{
		TransactionID: operation.TransactionID,
		SourceRoot:    operation.Source.DataRoot,
		TargetRoot:    operation.Target.DataRoot,
		Resources:     resources,
		ReserveBytes:  boundary.reserveBytes,
	}, nil
}

func validateProductionSourceLayout(root string, uid, gid int) error {
	directories := make([]string, 0, len(contract.P1SourceLayouts))
	for relative := range contract.P1SourceLayouts {
		directories = append(directories, relative)
	}
	sort.Strings(directories)
	for _, relative := range directories {
		path := root
		if relative != "." {
			path = filepath.Join(root, filepath.FromSlash(relative))
		}
		if err := validateProductionDirectory(path, contract.P1SourceLayouts[relative], uid, gid); err != nil {
			return err
		}
	}
	return validateP1ProductionSourceArtifacts(root, uid, gid)
}

func validateProductionDirectory(path string, layout contract.P1SourceDirectory, uid, gid int) error {
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("inspect production directory %s: %w", path, err)
	}
	metadata, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != os.FileMode(layout.Mode) || metadata.Uid != uint32(uid) || metadata.Gid != uint32(gid) {
		return fmt.Errorf("production path %s is not a real directory", path)
	}
	entries, err := readProductionDirectoryNoFollow(path, info, len(layout.Entries)+1)
	if err != nil {
		return fmt.Errorf("enumerate production directory %s: %w", path, err)
	}
	seen := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		want, ok := layout.Entries[entry.Name()]
		if !ok {
			return fmt.Errorf("unknown object %q in %s", entry.Name(), path)
		}
		entryInfo, err := os.Lstat(filepath.Join(path, entry.Name()))
		if err != nil || entryInfo.Mode()&os.ModeSymlink != 0 {
			return errors.Join(err, fmt.Errorf("production object %q in %s has an unsafe type", entry.Name(), path))
		}
		if want.Type == "directory" && !entryInfo.IsDir() || want.Type == "file" && !entryInfo.Mode().IsRegular() {
			return fmt.Errorf("production object %q in %s has an unexpected type", entry.Name(), path)
		}
		if entryInfo.Mode().Perm() != os.FileMode(want.Mode) {
			return fmt.Errorf("production object %q in %s has an unexpected mode", entry.Name(), path)
		}
		if want.Disposition != "retained" && want.Disposition != "copied" && want.Disposition != "generated" && want.Disposition != "retired" && want.Disposition != "ephemeral" {
			return fmt.Errorf("production object %q in %s has no reviewed disposition", entry.Name(), path)
		}
		seen[entry.Name()] = struct{}{}
	}
	for name, object := range layout.Entries {
		if _, ok := seen[name]; object.Required && !ok {
			return fmt.Errorf("required production object %q is absent from %s", name, path)
		}
	}
	return nil
}

// readProductionDirectoryNoFollow returns at most maximum entries from the
// directory after binding the enumeration to the object inspected by the
// caller. Closed-world validators intentionally request expected+1 entries:
// that is enough to expose an unknown name without materializing an
// attacker-sized directory before rejection.
func readProductionDirectoryNoFollow(path string, before os.FileInfo, maximum int) ([]os.DirEntry, error) {
	if maximum < 1 {
		return nil, errors.New("production directory read bound is invalid")
	}
	descriptor, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	directory := os.NewFile(uintptr(descriptor), path)
	if directory == nil {
		syscall.Close(descriptor)
		return nil, errors.New("construct production directory reader")
	}
	opened, statErr := directory.Stat()
	if statErr != nil || !sameIdentityAndContentMetadata(before, opened) || !opened.IsDir() {
		directory.Close()
		return nil, errors.Join(statErr, errors.New("production directory changed while opening"))
	}
	entries, readErr := directory.ReadDir(maximum)
	closeErr := directory.Close()
	if readErr != nil && !errors.Is(readErr, io.EOF) || closeErr != nil {
		return nil, errors.Join(readErr, closeErr)
	}
	after, statErr := os.Lstat(path)
	if statErr != nil || !sameIdentityAndContentMetadata(before, after) {
		return nil, errors.Join(statErr, errors.New("production directory changed while enumerating"))
	}
	return entries, nil
}

var (
	p1SecretLinePattern        = regexp.MustCompile(contract.P1SourceSecretLinePattern)
	p1BullAuthPattern          = regexp.MustCompile(contract.P1FirecrawlBullAuthPattern)
	p1LegacyMigrationIDPattern = regexp.MustCompile(contract.P1ManagerLegacyIDPattern)
	p1OperationIDPattern       = regexp.MustCompile(contract.P1ManagerOperationIDPattern)
	p1CommitPattern            = regexp.MustCompile(contract.P1ManagerCommitPattern)
	p1CampaignPattern          = regexp.MustCompile(contract.P1ManagerCampaignPattern)
)

func validateP1ProductionSourceArtifacts(root string, uid, gid int) error {
	if err := validateP1ManagerSecrets(filepath.Join(root, "manager", "secrets"), uid, gid); err != nil {
		return fmt.Errorf("validate P1 Manager secret inventory: %w", err)
	}
	for _, relative := range contract.P1SourceEmptyFiles {
		object, ok := p1SourceObject(relative)
		if !ok {
			return fmt.Errorf("P1 empty file %s is absent from the generated layout contract", relative)
		}
		if _, err := readP1ManagedFile(root, relative, os.FileMode(object.Mode), 0, uid, gid); err != nil {
			return fmt.Errorf("validate P1 ephemeral lock %s: %w", relative, err)
		}
	}
	for _, relative := range contract.P1SourceEmptyDirectories {
		object, ok := p1SourceObject(relative)
		if !ok {
			return fmt.Errorf("P1 empty directory %s is absent from the generated layout contract", relative)
		}
		if err := validateP1EmptyManagedDirectory(filepath.Join(root, filepath.FromSlash(relative)), os.FileMode(object.Mode), uid, gid); err != nil {
			return fmt.Errorf("validate P1 empty directory %s: %w", relative, err)
		}
	}
	for _, relative := range contract.P1SourceSecretFiles {
		object, ok := p1SourceObject(relative)
		if !ok {
			return fmt.Errorf("P1 secret file %s is absent from the generated layout contract", relative)
		}
		raw, err := readP1ManagedFile(root, relative, os.FileMode(object.Mode), 65, uid, gid)
		if err != nil || !p1SecretLinePattern.Match(raw) {
			return fmt.Errorf("validate P1 retired secret %s: invalid owner-only secret shape: %w", relative, err)
		}
	}
	if err := validateP1CamofoxHome(filepath.Join(root, filepath.FromSlash(contract.P1CamofoxHomePath)), uid, gid); err != nil {
		return fmt.Errorf("validate P1 Camoufox home: %w", err)
	}
	if err := validateP1ManagerMigration(root, uid, gid); err != nil {
		return err
	}
	for relative, expected := range contract.P1SourceFixedSHA256 {
		if err := validateP1ManagedFileSHA256(root, relative, expected, uid, gid); err != nil {
			return err
		}
	}
	return validateP1FirecrawlEnvironment(root, uid, gid)
}

func validateP1ManagerSecrets(path string, uid, gid int) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	metadata, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o700 ||
		metadata.Uid != uint32(uid) || metadata.Gid != uint32(gid) {
		return errors.New("Manager secret root is not an owner-only deployment directory")
	}
	want := make(map[string]struct{}, len(contract.P1ManagerSecretNames))
	for _, name := range contract.P1ManagerSecretNames {
		if _, duplicate := want[name]; duplicate || !isSecretName(name) {
			return errors.New("canonical Manager secret inventory is invalid")
		}
		want[name] = struct{}{}
	}
	entries, err := readProductionDirectoryNoFollow(path, info, len(want)+1)
	if err != nil {
		return err
	}
	seen := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		if _, allowed := want[entry.Name()]; !allowed {
			return fmt.Errorf("unknown Manager secret %q", entry.Name())
		}
		secretInfo, err := os.Lstat(filepath.Join(path, entry.Name()))
		if err != nil {
			return err
		}
		secretMetadata, ok := secretInfo.Sys().(*syscall.Stat_t)
		if !ok || !secretInfo.Mode().IsRegular() || secretInfo.Mode()&os.ModeSymlink != 0 ||
			secretInfo.Mode().Perm() != 0o600 || secretMetadata.Nlink != 1 ||
			secretMetadata.Uid != uint32(uid) || secretMetadata.Gid != uint32(gid) {
			return fmt.Errorf("Manager secret %q is not an owner-only, single-link deployment file", entry.Name())
		}
		seen[entry.Name()] = struct{}{}
	}
	for _, name := range contract.P1ManagerSecretNames {
		if _, exists := seen[name]; !exists {
			return fmt.Errorf("required Manager secret %q is absent", name)
		}
	}
	return nil
}

func p1SourceObject(relative string) (contract.P1SourceObject, bool) {
	parent, name := pathpkg.Split(filepath.ToSlash(relative))
	parent = strings.TrimSuffix(parent, "/")
	if parent == "" {
		parent = "."
	}
	layout, ok := contract.P1SourceLayouts[parent]
	if !ok {
		return contract.P1SourceObject{}, false
	}
	object, ok := layout.Entries[name]
	return object, ok
}

func readP1ManagedFile(root, relative string, mode os.FileMode, exact int64, uid, gid int) ([]byte, error) {
	path := filepath.Join(root, filepath.FromSlash(relative))
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	metadata, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != mode ||
		metadata.Uid != uint32(uid) || metadata.Gid != uint32(gid) || metadata.Nlink != 1 {
		return nil, errors.New("P1 source file metadata is unsafe")
	}
	return readBoundedRegular(path, exact, 1<<20)
}

func validateP1ManagedFileSHA256(root, relative, expected string, uid, gid int) error {
	path := filepath.Join(root, filepath.FromSlash(relative))
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	metadata, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || metadata.Uid != uint32(uid) || metadata.Gid != uint32(gid) || metadata.Nlink != 1 {
		return fmt.Errorf("P1 retired file %s has unsafe metadata", relative)
	}
	digest, err := hashRegularNoFollow(path, info)
	if err != nil || digest != expected {
		return fmt.Errorf("P1 retired file %s differs from its audited bytes: %w", relative, err)
	}
	return nil
}

func validateP1EmptyManagedDirectory(path string, mode os.FileMode, uid, gid int) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	metadata, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != mode || metadata.Uid != uint32(uid) || metadata.Gid != uint32(gid) {
		return errors.New("P1 source directory metadata is unsafe")
	}
	entries, err := readProductionDirectoryNoFollow(path, info, 1)
	if err != nil {
		return err
	}
	if len(entries) != 0 {
		return errors.New("P1 source directory is not empty")
	}
	return nil
}

func validateP1CamofoxHome(root string, uid, gid int) error {
	var pathStat unix.Stat_t
	if err := unix.Lstat(root, &pathStat); err != nil {
		return err
	}
	if pathStat.Mode&unix.S_IFMT != unix.S_IFDIR || pathStat.Mode&0o777 != uint32(contract.P1CamofoxHomeMode) ||
		pathStat.Uid != uint32(uid) || pathStat.Gid != uint32(gid) {
		return errors.New("P1 Camoufox home root metadata is unsafe")
	}
	descriptor, err := unix.Open(root, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	directory := os.NewFile(uintptr(descriptor), root)
	if directory == nil {
		unix.Close(descriptor)
		return errors.New("construct P1 Camoufox home directory reader")
	}
	defer directory.Close()
	var opened unix.Stat_t
	if err := unix.Fstat(descriptor, &opened); err != nil || !sameP1CamofoxStat(pathStat, opened) {
		return errors.Join(err, errors.New("P1 Camoufox home root changed while opening"))
	}

	top, err := directory.ReadDir(len(contract.P1CamofoxHomeTopLevelEntries) + 1)
	if err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	actualTop := make([]string, 0, len(top))
	for _, entry := range top {
		actualTop = append(actualTop, entry.Name())
	}
	sort.Strings(actualTop)
	if !equalStringSlices(actualTop, contract.P1CamofoxHomeTopLevelEntries) {
		return errors.New("P1 Camoufox home top-level inventory is invalid")
	}
	seenSymlinks := map[string]bool{}
	seenDirectories := map[p1CamofoxDirectoryIdentity]struct{}{{device: uint64(opened.Dev), inode: opened.Ino}: {}}
	if err := validateP1CamofoxEntries(descriptor, top, "", uint64(pathStat.Dev), uid, gid, seenSymlinks, seenDirectories); err != nil {
		return err
	}
	var after unix.Stat_t
	if err := unix.Fstat(descriptor, &after); err != nil || !sameP1CamofoxStat(opened, after) {
		return errors.Join(err, errors.New("P1 Camoufox home root changed during traversal"))
	}
	if len(seenSymlinks) != len(contract.P1CamofoxHomeAllowedSymlinks) {
		return errors.New("P1 Camoufox home symlink inventory is incomplete")
	}
	return nil
}

type p1CamofoxDirectoryIdentity struct {
	device uint64
	inode  uint64
}

func validateP1CamofoxEntries(parentFD int, entries []os.DirEntry, parentRelative string, rootDevice uint64, uid, gid int, seenSymlinks map[string]bool, seenDirectories map[p1CamofoxDirectoryIdentity]struct{}) error {
	for _, entry := range entries {
		name := entry.Name()
		if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\x00") {
			return errors.New("P1 Camoufox home contains an invalid directory entry")
		}
		var before unix.Stat_t
		if err := unix.Fstatat(parentFD, name, &before, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return err
		}
		if uint64(before.Dev) != rootDevice || before.Uid != uint32(uid) || before.Gid != uint32(gid) {
			return errors.New("P1 Camoufox home entry metadata is unsafe")
		}
		relative := pathpkg.Join(parentRelative, name)
		switch before.Mode & unix.S_IFMT {
		case unix.S_IFDIR:
			if err := validateP1CamofoxDirectory(parentFD, name, relative, before, rootDevice, uid, gid, seenSymlinks, seenDirectories); err != nil {
				return err
			}
		case unix.S_IFREG:
			if before.Nlink != 1 {
				return errors.New("P1 Camoufox home contains a hard-linked file")
			}
		case unix.S_IFLNK:
			target, allowed := contract.P1CamofoxHomeAllowedSymlinks[relative]
			if !allowed || pathpkg.Clean(target) != target || before.Nlink != 1 {
				return errors.New("P1 Camoufox home contains an unknown symlink")
			}
			buffer := make([]byte, len(target)+1)
			read, err := unix.Readlinkat(parentFD, name, buffer)
			if err != nil || read != len(target) || string(buffer[:read]) != target {
				return errors.New("P1 Camoufox home contains an unknown symlink")
			}
			var after unix.Stat_t
			if err := unix.Fstatat(parentFD, name, &after, unix.AT_SYMLINK_NOFOLLOW); err != nil || !sameP1CamofoxStat(before, after) {
				return errors.Join(err, errors.New("P1 Camoufox home symlink changed while reading"))
			}
			seenSymlinks[relative] = true
		default:
			return errors.New("P1 Camoufox home contains a special file")
		}
	}
	return nil
}

func validateP1CamofoxDirectory(parentFD int, name, relative string, before unix.Stat_t, rootDevice uint64, uid, gid int, seenSymlinks map[string]bool, seenDirectories map[p1CamofoxDirectoryIdentity]struct{}) error {
	descriptor, err := unix.Openat(parentFD, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	directory := os.NewFile(uintptr(descriptor), relative)
	if directory == nil {
		unix.Close(descriptor)
		return errors.New("construct P1 Camoufox child directory reader")
	}
	defer directory.Close()
	var opened unix.Stat_t
	if err := unix.Fstat(descriptor, &opened); err != nil || !sameP1CamofoxStat(before, opened) {
		return errors.Join(err, errors.New("P1 Camoufox home directory changed while opening"))
	}
	identity := p1CamofoxDirectoryIdentity{device: uint64(opened.Dev), inode: opened.Ino}
	if _, duplicate := seenDirectories[identity]; duplicate {
		return errors.New("P1 Camoufox home contains a repeated directory identity")
	}
	seenDirectories[identity] = struct{}{}
	for {
		entries, readErr := directory.ReadDir(p1CamofoxDirectoryBatchSize)
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return readErr
		}
		if err := validateP1CamofoxEntries(descriptor, entries, relative, rootDevice, uid, gid, seenSymlinks, seenDirectories); err != nil {
			return err
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
	}
	var afterOpen, afterPath unix.Stat_t
	if err := unix.Fstat(descriptor, &afterOpen); err != nil || !sameP1CamofoxStat(opened, afterOpen) {
		return errors.Join(err, errors.New("P1 Camoufox home directory changed during traversal"))
	}
	if err := unix.Fstatat(parentFD, name, &afterPath, unix.AT_SYMLINK_NOFOLLOW); err != nil || !sameP1CamofoxStat(before, afterPath) {
		return errors.Join(err, errors.New("P1 Camoufox home directory path changed during traversal"))
	}
	return nil
}

func sameP1CamofoxStat(left, right unix.Stat_t) bool {
	return left.Dev == right.Dev && left.Ino == right.Ino && left.Nlink == right.Nlink &&
		left.Mode == right.Mode && left.Uid == right.Uid && left.Gid == right.Gid && left.Size == right.Size &&
		left.Mtim.Sec == right.Mtim.Sec && left.Mtim.Nsec == right.Mtim.Nsec &&
		left.Ctim.Sec == right.Ctim.Sec && left.Ctim.Nsec == right.Ctim.Nsec
}

func validateP1ManagerMigration(root string, uid, gid int) error {
	raw, err := readP1ManagedFile(root, contract.P1ManagerMigrationPath, os.FileMode(contract.P1ManagerMigrationMode), -1, uid, gid)
	if err != nil {
		return fmt.Errorf("validate P1 Manager migration marker: %w", err)
	}
	var fields map[string]json.RawMessage
	if err := decodeStrictJSON(raw, &fields); err != nil || !sameStringSet(mapKeys(fields), contract.P1ManagerMigrationFields) {
		return errors.New("P1 Manager migration marker has an unknown schema")
	}
	type retirementRecord struct {
		CampaignID         string `json:"campaign_id"`
		CompletedAt        string `json:"completed_at"`
		DockerRemoved      bool   `json:"docker_removed"`
		GenerationID       string `json:"generation_id"`
		RecoveryRemoved    bool   `json:"recovery_removed"`
		SourceStateRemoved bool   `json:"source_state_removed"`
		StartedAt          string `json:"started_at"`
		Status             string `json:"status"`
		SystemdRemoved     bool   `json:"systemd_removed"`
	}
	type migrationRecord struct {
		CreatedAt            string           `json:"created_at"`
		ExpectedSourceCommit string           `json:"expected_source_commit"`
		ID                   string           `json:"id"`
		OperationID          string           `json:"operation_id"`
		Retirement           retirementRecord `json:"retirement"`
		SchemaVersion        int              `json:"schema_version"`
		Status               string           `json:"status"`
		UpdatedAt            string           `json:"updated_at"`
	}
	var value migrationRecord
	if err := decodeStrictJSON(raw, &value); err != nil {
		return errors.New("P1 Manager migration marker cannot be decoded")
	}
	var retirementFields map[string]json.RawMessage
	if err := json.Unmarshal(fields["retirement"], &retirementFields); err != nil || !sameStringSet(mapKeys(retirementFields), contract.P1ManagerRetirementFields) {
		return errors.New("P1 Manager retirement marker has an unknown schema")
	}
	if value.SchemaVersion != contract.P1ManagerMigrationSchema || value.Status != contract.P1ManagerMigrationStatus || !p1LegacyMigrationIDPattern.MatchString(value.ID) || !p1OperationIDPattern.MatchString(value.OperationID) ||
		!p1CommitPattern.MatchString(value.ExpectedSourceCommit) || value.Retirement.Status != contract.P1ManagerRetirementStatus || !p1CampaignPattern.MatchString(value.Retirement.CampaignID) ||
		!p1CommitPattern.MatchString(value.Retirement.GenerationID) || !value.Retirement.DockerRemoved || !value.Retirement.RecoveryRemoved ||
		!value.Retirement.SourceStateRemoved || !value.Retirement.SystemdRemoved {
		return errors.New("P1 Manager migration marker is not the completed retirement record")
	}
	for _, timestamp := range []string{value.CreatedAt, value.UpdatedAt, value.Retirement.StartedAt, value.Retirement.CompletedAt} {
		if _, err := time.Parse(time.RFC3339Nano, timestamp); err != nil {
			return errors.New("P1 Manager migration marker has an invalid timestamp")
		}
	}
	return nil
}

func validateP1FirecrawlEnvironment(root string, uid, gid int) error {
	raw, err := readP1ManagedFile(root, contract.P1FirecrawlEnvironmentPath, os.FileMode(contract.P1FirecrawlEnvironmentMode), -1, uid, gid)
	if err != nil {
		return fmt.Errorf("validate P1 Firecrawl environment: %w", err)
	}
	values := map[string]string{}
	for _, line := range strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n") {
		key, value, ok := strings.Cut(line, "=")
		if !ok || key == "" || values[key] != "" {
			return errors.New("P1 Firecrawl environment is not a closed key/value file")
		}
		values[key] = value
	}
	if !sameStringSet(mapKeysString(values), contract.P1FirecrawlEnvironmentKeys) {
		return errors.New("P1 Firecrawl environment contains unknown settings")
	}
	for key, expected := range contract.P1FirecrawlEnvironmentLiteralValues {
		if values[key] != expected {
			return errors.New("P1 Firecrawl environment contains unknown settings")
		}
	}
	bull := values["BULL_AUTH_KEY"]
	if len(bull) != 34 || bull[0] != '"' || bull[len(bull)-1] != '"' || !p1BullAuthPattern.MatchString(bull[1:len(bull)-1]) {
		return errors.New("P1 Firecrawl environment authentication value has an invalid shape")
	}
	return nil
}

func mapKeysString(value map[string]string) []string {
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	return keys
}

func (boundary *ProductionBoundary) validateOperation(operation handoffhelper.Operation) error {
	if !transactionIDPattern.MatchString(operation.TransactionID) || !sha256Pattern.MatchString(operation.BindingSHA256) {
		return errors.New("production data operation has an invalid transaction identity")
	}
	source, target := identity.SourceProfile(), identity.TargetProfile()
	if operation.Source.Namespace != source.ProfileID || operation.Target.Namespace != target.ProfileID ||
		filepath.Base(operation.Source.DataRoot) != source.DataDirectory || filepath.Base(operation.Target.DataRoot) != target.DataDirectory ||
		operation.Release.PredecessorGeneration == "" || operation.Release.BridgeGeneration == "" ||
		!sha256Pattern.MatchString(operation.Release.ManifestSHA256) || !sha256Pattern.MatchString(operation.Release.TargetComposeSHA256) ||
		!sha256Pattern.MatchString(operation.Release.TargetManagerSHA256) || operation.CreatedAt.IsZero() {
		return errors.New("production data operation differs from the canonical source/target binding")
	}
	return nil
}

func (boundary *ProductionBoundary) bridgeManifest(operation handoffhelper.Operation) (release.Manifest, []byte, error) {
	raw := append([]byte(nil), boundary.targetManifest...)
	digest := sha256.Sum256(raw)
	if hex.EncodeToString(digest[:]) != operation.Release.ManifestSHA256 {
		return release.Manifest{}, nil, errors.New("retained bridge manifest digest differs from the handoff journal")
	}
	manifest, err := release.DecodeManifest(raw, boundary.channel, boundary.goos, boundary.goarch)
	if err != nil {
		return release.Manifest{}, nil, fmt.Errorf("decode retained bridge manifest: %w", err)
	}
	if manifest.NamespaceHandoff == nil {
		return release.Manifest{}, nil, errors.New("production data transition requires a namespace_handoff manifest")
	}
	descriptor := *manifest.NamespaceHandoff
	artifact, ok := descriptor.Target.Manager.Artifacts[boundary.goarch]
	if !ok || descriptor.PredecessorGeneration != operation.Release.PredecessorGeneration ||
		descriptor.BridgeGeneration != operation.Release.BridgeGeneration || manifest.SourceCommit != operation.Release.BridgeGeneration ||
		descriptor.Source.ProfileID != operation.Source.Namespace || descriptor.Target.ProfileID != operation.Target.Namespace ||
		descriptor.Target.Manager.Version != operation.Release.TargetManagerVersion || artifact.SHA256 != operation.Release.TargetManagerSHA256 ||
		descriptor.Target.Compose.SHA256 != operation.Release.TargetComposeSHA256 ||
		manifest.DatabaseSchemaVersion != operation.Evidence.DatabaseSchemaVersion {
		return release.Manifest{}, nil, errors.New("retained bridge manifest differs from the immutable data operation")
	}
	composeDigest := sha256.Sum256(boundary.targetCompose)
	if hex.EncodeToString(composeDigest[:]) != operation.Release.TargetComposeSHA256 {
		return release.Manifest{}, nil, errors.New("downloaded target Compose bytes differ from the handoff journal")
	}
	managerDigest := sha256.Sum256(boundary.targetManager)
	if hex.EncodeToString(managerDigest[:]) != operation.Release.TargetManagerSHA256 {
		return release.Manifest{}, nil, errors.New("downloaded target Manager bytes differ from the handoff journal")
	}
	return manifest, raw, nil
}

type productionGeneratedState struct {
	managerState          []byte
	selfUpdateState       []byte
	managerMetadata       []byte
	composeEnvironment    []byte
	managerBinaryRelative string
}

func (boundary *ProductionBoundary) resources(operation handoffhelper.Operation, manifest release.Manifest, manifestRaw []byte, identities RuntimeIdentities) ([]Resource, error) {
	createdAt := operation.CreatedAt.UTC()
	sandboxImage := manifest.Images["agent-sandbox"]
	if !release.IsDigestReference(sandboxImage) {
		return nil, errors.New("bridge manifest has no immutable target Sandbox image")
	}
	privilegedImage := manifest.Images["handoff-fs-helper"]
	if !release.IsDigestReference(privilegedImage) {
		return nil, errors.New("bridge manifest has no immutable handoff filesystem helper image")
	}
	generated, err := boundary.generatedManagerState(operation, manifest, createdAt)
	if err != nil {
		return nil, err
	}
	deployment := Owner{UID: uint32(boundary.engine.effectiveUID()), GID: uint32(boundary.engine.effectiveGID())}
	resources := []Resource{
		PlatformDatabaseResource(manifest.DatabaseSchemaVersion),
		AgentRuntimeResource(identities),
		WorkspaceResource(identities, deployment),
		CamofoxSidecarResource(),
		SandboxRegistryResource(sandboxImage, createdAt),
	}

	resources = append(resources,
		optionalExactTree("attachments", "data/attachments", nil),
		optionalFilteredTree("agent_envs", "data/agent-envs", []string{"logs"}, nil),
		optionalExactTree("agent_skills", "data/agent-skills", nil),
		optionalExactTree("camofox_profiles", "data/runtimes/camofox/profiles", nil),
		optionalExactTree("camofox_cookies", "data/runtimes/camofox/cookies", nil),
		optionalExactTree("camofox_traces", "data/runtimes/camofox/traces", nil),
		optionalPrivilegedExactTree("cognee_data", "data/runtimes/cognee/data", boundary.runtimeOwners["cognee"], privilegedImage),
		optionalPrivilegedExactTree("cognee_system", "data/runtimes/cognee/system", boundary.runtimeOwners["cognee"], privilegedImage),
		optionalPrivilegedExactTree("cognee_cache", "data/runtimes/cognee/cache", boundary.runtimeOwners["cognee"], privilegedImage),
		optionalPrivilegedExactTree("searxng_config", "data/runtimes/searxng/config", boundary.runtimeOwners["searxng"], privilegedImage),
		optionalPrivilegedExactTree("searxng_cache", "data/runtimes/searxng/cache", boundary.runtimeOwners["searxng"], privilegedImage),
		optionalPrivilegedExactTree("firecrawl_redis", "data/runtimes/firecrawl/redis", boundary.runtimeOwners["firecrawl-redis"], privilegedImage),
		optionalPrivilegedExactTree("firecrawl_rabbitmq", "data/runtimes/firecrawl/rabbitmq", boundary.runtimeOwners["firecrawl-rabbitmq"], privilegedImage),
		optionalPrivilegedExactTree("firecrawl_postgres", "data/runtimes/firecrawl/postgres", boundary.runtimeOwners["firecrawl-postgres"], privilegedImage),
		GeneratedFileResource("target_platform_instance_lock", "data/.agent-platform.lock", nil, 0o600),
		GeneratedFileResource("target_platform_wal", "data/platform.db-wal", nil, 0o600),
		GeneratedFileResource("target_platform_shm", "data/platform.db-shm", nil, 0o600),
		GeneratedDirectoryResource("target_platform_home", "data/.home", 0o700),
		GeneratedDirectoryResource("target_upload_staging", "data/upload-staging", 0o700),
		GeneratedDirectoryResource("target_data_logs", "data/logs", 0o700),
		GeneratedDirectoryResource("target_camofox_cache", "data/runtimes/camofox/cache", 0o700),
		GeneratedDirectoryResource("target_camofox_home", "data/runtimes/camofox/home", 0o700),
		GeneratedDirectoryResource("target_camofox_logs", "data/runtimes/camofox/logs", 0o700),
		GeneratedDirectoryResource("target_cognee_logs", "data/runtimes/cognee/logs", 0o700),
		GeneratedDirectoryResource("target_searxng_logs", "data/runtimes/searxng/logs", 0o700),
		GeneratedDirectoryResource("target_firecrawl_logs", "data/runtimes/firecrawl/logs", 0o700),
	)
	bootstrap := SecretResource("bootstrap_admin_password", "data/bootstrap-admin-password.txt", "data/bootstrap-admin-password.txt", false)
	resources = append(resources, bootstrap)
	for _, secret := range contract.P1ManagerSecretNames {
		name := strings.ReplaceAll(secret, "-", "_")
		resources = append(resources, SecretResource(name, "manager/secrets/"+secret, "manager/secrets/"+secret, true))
	}

	releaseRoot := "manager/releases/" + operation.Release.BridgeGeneration
	managerVersionRoot := filepath.Dir(generated.managerBinaryRelative)
	resources = append(resources,
		GeneratedFileResource("target_manager_state", "manager/state.json", generated.managerState, 0o600),
		GeneratedFileResource("target_self_update_state", "manager/manager-binaries.json", generated.selfUpdateState, 0o600),
		GeneratedFileResource("target_manager_binary", generated.managerBinaryRelative, boundary.targetManager, 0o700),
		GeneratedFileResource("target_manager_metadata", managerVersionRoot+"/metadata.json", generated.managerMetadata, 0o600),
		GeneratedFileResource("target_manager_serve_lock", "manager/manager-binaries/serve.lock", nil, 0o600),
		GeneratedFileResource("target_manager_recovery_lock", "manager/manager-binaries/recovery.lock", nil, 0o600),
		GeneratedFileResource("target_active_generation", "manager/active-generation", []byte(operation.Release.BridgeGeneration+"\n"), 0o600),
		GeneratedFileResource("target_release_manifest", releaseRoot+"/manifest.json", manifestRaw, 0o600),
		GeneratedFileResource("target_release_compose", releaseRoot+"/compose.yaml", boundary.targetCompose, 0o600),
		GeneratedFileResource("target_release_environment", releaseRoot+"/compose.env", generated.composeEnvironment, 0o600),
		GeneratedDirectoryResource("target_operation_directory", "manager/operations", 0o700),
		GeneratedDirectoryResource("target_log_directory", "manager/logs", 0o700),
	)
	return resources, nil
}

func (boundary *ProductionBoundary) generatedManagerState(operation handoffhelper.Operation, manifest release.Manifest, at time.Time) (productionGeneratedState, error) {
	releaseManifestPath := filepath.Join(operation.Target.DataRoot, "manager", "releases", operation.Release.BridgeGeneration, "manifest.json")
	versionID := productionSafeID(operation.Release.TargetManagerVersion + "-" + operation.Release.BridgeGeneration[:12])
	managerBinaryRelative := filepath.ToSlash(filepath.Join("manager", "manager-binaries", "versions", versionID, identity.TargetProfile().ManagerBinary))
	managerBinaryPath := filepath.Join(operation.Target.DataRoot, filepath.FromSlash(managerBinaryRelative))
	images := make(map[string]string, len(manifest.Images))
	for name, image := range manifest.Images {
		images[name] = image
	}
	managerState := model.ManagerState{
		SchemaVersion: 1,
		Generation:    1,
		PublicState:   model.StateIdle,
		Current: &model.Generation{
			ID: operation.Release.BridgeGeneration, ManifestPath: releaseManifestPath,
			SourceCommit: operation.Release.BridgeGeneration, DatabaseVersion: manifest.DatabaseSchemaVersion,
			Images: images, ActivatedAt: at,
		},
		Maintenance: false, HeartbeatAt: at, UpdatedAt: at,
	}
	selfUpdateState := selfupdate.State{
		SchemaVersion: 1,
		Current: &selfupdate.Version{
			Version: operation.Release.TargetManagerVersion, SourceCommit: operation.Release.BridgeGeneration,
			Path: managerBinaryPath, SHA256: operation.Release.TargetManagerSHA256,
			VerifiedAt: at, PlatformCommitted: true,
		},
		UpdatedAt: at,
	}
	managerRaw, err := json.Marshal(managerState)
	if err != nil {
		return productionGeneratedState{}, fmt.Errorf("encode target Manager state: %w", err)
	}
	selfUpdateRaw, err := json.Marshal(selfUpdateState)
	if err != nil {
		return productionGeneratedState{}, fmt.Errorf("encode target self-update state: %w", err)
	}
	managerMetadataRaw, err := json.Marshal(selfUpdateState.Current)
	if err != nil {
		return productionGeneratedState{}, fmt.Errorf("encode target Manager version metadata: %w", err)
	}
	environmentRaw, err := boundary.composeEnvironment(operation, manifest)
	if err != nil {
		return productionGeneratedState{}, err
	}
	return productionGeneratedState{
		managerState: append(managerRaw, '\n'), selfUpdateState: append(selfUpdateRaw, '\n'),
		managerMetadata: append(managerMetadataRaw, '\n'), composeEnvironment: environmentRaw,
		managerBinaryRelative: managerBinaryRelative,
	}, nil
}

func (boundary *ProductionBoundary) composeEnvironment(operation handoffhelper.Operation, manifest release.Manifest) ([]byte, error) {
	profile := identity.TargetProfile()
	prefix := profile.EnvironmentPrefix + "_"
	uid, gid := boundary.engine.effectiveUID(), boundary.engine.effectiveGID()
	fixed := map[string]string{
		prefix + "DATA_ROOT":           operation.Target.DataRoot,
		prefix + "SECRETS_DIR":         filepath.Join(operation.Target.DataRoot, "manager", "secrets"),
		prefix + "MANAGER_CONTROL_DIR": filepath.Dir(operation.Target.SocketPath),
		prefix + "UID":                 strconv.Itoa(uid),
		prefix + "GID":                 strconv.Itoa(gid),
		prefix + "PLATFORM_BIND":       boundary.environment.PlatformBind,
		prefix + "PUBLIC_BASE_URL":     "http://" + boundary.environment.GatewayAddress,
		prefix + "CORE_NETWORK":        profile.CoreNetwork,
		prefix + "LOG_MAX_SIZE":        boundary.environment.LogMaxSize,
		prefix + "LOG_MAX_FILES":       strconv.Itoa(boundary.environment.LogMaxFiles),
		prefix + "COMPOSE_PROJECT":     profile.ComposeProject,
	}
	keys := make([]string, 0, len(fixed))
	for key := range fixed {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var output strings.Builder
	for _, key := range keys {
		if fixed[key] != "" {
			fmt.Fprintf(&output, "%s=%s\n", key, fixed[key])
		}
	}
	imageNames := make([]string, 0, len(manifest.Images))
	for name := range manifest.Images {
		if release.IsManagedImageName(name) {
			imageNames = append(imageNames, name)
		}
	}
	sort.Strings(imageNames)
	for _, name := range imageNames {
		key := prefix + strings.ToUpper(strings.NewReplacer("-", "_", ".", "_").Replace(name)) + "_IMAGE"
		fmt.Fprintf(&output, "%s=%s\n", key, manifest.Images[name])
	}
	return []byte(output.String()), nil
}

func optionalExactTree(name, path string, owners []Owner) Resource {
	resource := ExactTreeResource(name, path, false)
	resource.SourceOwners = append([]Owner(nil), owners...)
	resource.TargetOwners = append([]Owner(nil), owners...)
	return resource
}

func optionalPrivilegedExactTree(name, path string, owners []Owner, image string) Resource {
	resource := optionalExactTree(name, path, owners)
	resource.Access = ContainerOwnedTree
	resource.PrivilegedImage = image
	return resource
}

func optionalFilteredTree(name, path string, excludedDirectoryNames []string, owners []Owner) Resource {
	excluded := append([]string(nil), excludedDirectoryNames...)
	sort.Strings(excluded)
	exclude := func(candidate string) bool {
		parts := strings.Split(candidate, "/")
		for _, part := range parts {
			if containsString(excluded, part) {
				return true
			}
		}
		return false
	}
	return Resource{
		Name: name, Kind: Structured, Source: path, Target: path, Type: Directory, Required: false,
		SourceOwners: append([]Owner(nil), owners...), TargetOwners: append([]Owner(nil), owners...),
		SchemaIdentifier: "filtered-opaque-tree", SchemaVersion: 1,
		TransformationSHA256: semanticDigest(struct {
			Path                   string   `json:"path"`
			ExcludedDirectoryNames []string `json:"excluded_directory_names"`
		}{path, excluded}),
		Transformer: filteredStructuredTree{exclude: exclude}, Validator: filteredStructuredValidator{exclude: exclude},
	}
}

func validateProductionSchemaSet(resources []Resource) error {
	required := map[string]struct {
		schema  string
		version int
	}{
		"platform_database": {"platform-database", platformDatabaseSchema},
		"agent_runtime":     {"agent-runtime-state", runtimeSchema},
		"workspaces":        {"workspace-markers", workspaceSchema},
		"camofox_sidecar":   {"platform-camofox-sidecar", camofoxSchema},
		"sandbox_registry":  {"sandbox-registry", sandboxSchema},
	}
	for _, resource := range resources {
		expected, exists := required[resource.Name]
		if !exists {
			continue
		}
		if resource.Kind != Structured || resource.SchemaIdentifier != expected.schema || resource.SchemaVersion != expected.version ||
			resource.Transformer == nil || resource.Validator == nil || !sha256Pattern.MatchString(resource.TransformationSHA256) {
			return fmt.Errorf("production schema %s is not bound to its reviewed transformer and validator", resource.Name)
		}
		delete(required, resource.Name)
	}
	if len(required) != 0 {
		missing := make([]string, 0, len(required))
		for name := range required {
			missing = append(missing, name)
		}
		sort.Strings(missing)
		return fmt.Errorf("production handoff schema set is incomplete: %s", strings.Join(missing, ", "))
	}
	return nil
}

func productionStagingPath(targetRoot, transactionID string) string {
	return filepath.Join(filepath.Dir(targetRoot), "."+filepath.Base(targetRoot)+"."+transactionID+".staging")
}

// productionSafeID mirrors the self-update version-directory identity. The
// handoff cannot call selfupdate's unexported helper, so this copy is kept
// deliberately small and covered by the production startup-artifact test.
func productionSafeID(value string) string {
	var result strings.Builder
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' || character == '.' || character == '_' || character == '-' {
			result.WriteRune(character)
		} else {
			result.WriteByte('-')
		}
	}
	value = strings.Trim(result.String(), "-")
	if value == "" {
		return "unknown"
	}
	if len(value) > 120 {
		return value[:120]
	}
	return value
}
