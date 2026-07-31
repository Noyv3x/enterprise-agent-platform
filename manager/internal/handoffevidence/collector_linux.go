//go:build linux

package handoffevidence

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	pathpkg "path"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"syscall"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffsource"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/journal"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/runtimegate"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/sandbox"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/selfupdate"
)

const maxSandboxEvidenceBytes int64 = 8 << 20

type PlatformObserver interface {
	Evidence(context.Context) (PlatformEvidence, error)
}

type DockerRequest struct {
	Source           identity.Profile
	Target           identity.Profile
	Images           map[string]string
	PlatformDataRoot string
	Sandboxes        []sandbox.Record
}

type DockerEvidence struct {
	SourceComposeOwned       bool
	SourceCoreNetworkOwned   bool
	TargetComposeAbsent      bool
	TargetCoreNetworkAbsent  bool
	TargetLabelObjectsAbsent bool
	SourceCoreNetworkID      string
	InventorySHA256          string
}

type DockerObserver interface {
	Observe(context.Context, DockerRequest) (DockerEvidence, error)
}

type CollectorOptions struct {
	Journal    *journal.Store
	SelfUpdate *selfupdate.Manager
	Runtime    *runtimegate.Gate
	Sandboxes  SandboxObserver
	Background func() int
	Platform   PlatformObserver
	Docker     DockerObserver
}

type Collector struct {
	journal    *journal.Store
	selfUpdate *selfupdate.Manager
	runtime    *runtimegate.Gate
	sandboxes  SandboxObserver
	background func() int
	platform   PlatformObserver
	docker     DockerObserver
}

var _ handoffsource.EvidenceCollector = (*Collector)(nil)

func NewCollector(options CollectorOptions) (*Collector, error) {
	if options.Journal == nil || options.SelfUpdate == nil || options.Runtime == nil ||
		options.Sandboxes == nil || options.Background == nil || options.Platform == nil || options.Docker == nil {
		return nil, errors.New("handoff evidence collector dependencies are incomplete")
	}
	return &Collector{
		journal: options.Journal, selfUpdate: options.SelfUpdate, runtime: options.Runtime,
		sandboxes: options.Sandboxes, background: options.Background,
		platform: options.Platform, docker: options.Docker,
	}, nil
}

func (collector *Collector) Collect(ctx context.Context, request handoffsource.EvidenceRequest) (handoffsource.DeploymentEvidence, error) {
	if collector == nil {
		return handoffsource.DeploymentEvidence{}, errors.New("handoff evidence collector is unavailable")
	}
	if err := validateEvidenceRequest(request); err != nil {
		return handoffsource.DeploymentEvidence{}, err
	}
	if !collector.runtime.Frozen() || collector.runtime.Active() != 0 {
		return handoffsource.DeploymentEvidence{}, errors.New("runtime admission is not retained for evidence collection")
	}
	boundary, err := collector.journal.ObserveOperationBoundary()
	if err != nil {
		return handoffsource.DeploymentEvidence{}, err
	}
	if boundary.StateSHA256 != request.ManagerStateSHA256 {
		return handoffsource.DeploymentEvidence{}, errors.New("Manager state changed after its retained identity was opened")
	}
	if boundary.State.Current == nil || boundary.State.Current.SourceCommit != request.Runtime.Generation {
		return handoffsource.DeploymentEvidence{}, errors.New("Manager journal generation differs from admitted runtime")
	}
	if boundary.State.Current.ManifestPath != request.SourceManifestPath || !reflect.DeepEqual(boundary.State.Current.Images, request.SourceImages) {
		return handoffsource.DeploymentEvidence{}, errors.New("Manager Current manifest identity differs from the secured predecessor manifest")
	}
	selfData, _, err := readSecureFile(collector.selfUpdate.StatePath, 32<<20, 0o600)
	if err != nil {
		return handoffsource.DeploymentEvidence{}, fmt.Errorf("read retained self-update identity: %w", err)
	}
	if digestBytes(selfData) != request.SelfUpdateSHA256 {
		return handoffsource.DeploymentEvidence{}, errors.New("self-update state changed after its retained identity was opened")
	}
	selfState, err := collector.selfUpdate.State()
	if err != nil {
		return handoffsource.DeploymentEvidence{}, fmt.Errorf("read self-update evidence: %w", err)
	}
	selfStable := selfState.Current != nil && selfState.Current.SourceCommit == request.Runtime.Generation &&
		selfState.Current.SHA256 == request.Runtime.ManagerSHA256 && selfState.Current.PlatformCommitted &&
		selfState.Candidate == nil && selfState.Activation == nil
	if !selfStable {
		return handoffsource.DeploymentEvidence{}, errors.New("self-update state is not the admitted stable Current")
	}

	registryPath := filepath.Join(request.SourceProfile.ManagerStateRoot(request.SourceDataRoot), "sandboxes.json")
	registry, registryData, err := observeSandboxRegistry(registryPath, request.SourceProfile, filepath.Join(request.SourceDataRoot, "data"))
	if err != nil {
		return handoffsource.DeploymentEvidence{}, err
	}
	if digestBytes(registryData) != request.SandboxRegistrySHA256 {
		return handoffsource.DeploymentEvidence{}, errors.New("Sandbox registry changed after its retained identity was opened")
	}
	liveRecords := collector.sandboxes.Records()
	if err := compareSandboxRecords(registry.Records, liveRecords); err != nil {
		return handoffsource.DeploymentEvidence{}, err
	}
	activeCalls, sandboxBackground, err := sandboxActivity(liveRecords)
	if err != nil {
		return handoffsource.DeploymentEvidence{}, err
	}
	processBackground := collector.background()
	if processBackground < 0 {
		return handoffsource.DeploymentEvidence{}, errors.New("background process evidence is negative")
	}

	platformEvidence, err := collector.platform.Evidence(ctx)
	if err != nil {
		return handoffsource.DeploymentEvidence{}, err
	}
	if platformEvidence.TechnicalProfile != request.SourceProfile.ProfileID ||
		platformEvidence.DatabaseSchemaVersion != request.Bridge.Manifest.DatabaseSchemaVersion {
		return handoffsource.DeploymentEvidence{}, errors.New("Platform evidence differs from the source release identity")
	}
	dockerEvidence, err := collector.docker.Observe(ctx, DockerRequest{
		Source: request.SourceProfile, Target: request.TargetProfile,
		Images: cloneStrings(boundary.State.Current.Images), PlatformDataRoot: filepath.Join(request.SourceDataRoot, "data"),
		Sandboxes: liveRecords,
	})
	if err != nil {
		return handoffsource.DeploymentEvidence{}, err
	}
	relocationSafe, err := observeRelocationBoundary(request.SourceDataRoot, request.TargetDataRoot)
	if err != nil {
		return handoffsource.DeploymentEvidence{}, err
	}
	machineSchemas := registry.SchemaVersion == 2 && registry.TechnicalProfile == request.SourceProfile.ProfileID &&
		platformEvidence.RuntimeSchemaReady && platformEvidence.WorkspaceSchemaReady && platformEvidence.CamofoxSchemaReady
	return handoffsource.DeploymentEvidence{
		SourceComposeOwned:       dockerEvidence.SourceComposeOwned,
		SourceCoreNetworkOwned:   dockerEvidence.SourceCoreNetworkOwned,
		TargetComposeAbsent:      dockerEvidence.TargetComposeAbsent,
		TargetCoreNetworkAbsent:  dockerEvidence.TargetCoreNetworkAbsent,
		TargetLabelObjectsAbsent: dockerEvidence.TargetLabelObjectsAbsent,
		AllOperationsTerminal:    boundary.AllTerminal,
		PlatformReservationIdle:  platformEvidence.idle(),
		SandboxCallsIdle:         activeCalls == 0,
		BackgroundProcessesIdle:  sandboxBackground == 0 && processBackground == 0,
		FileCommitWindowsIdle:    collector.runtime.Frozen() && collector.runtime.Active() == 0,
		MachineSchemasReady:      machineSchemas,
		RelocationBoundarySafe:   relocationSafe,
		SelfUpdateCurrentStable:  selfStable,
		SelfUpdateGeneration:     selfState.Current.SourceCommit,
		SelfUpdateManagerSHA256:  selfState.Current.SHA256,
		SourceCoreNetworkID:      dockerEvidence.SourceCoreNetworkID,
		DockerInventorySHA256:    dockerEvidence.InventorySHA256,
		DatabaseSchemaVersion:    platformEvidence.DatabaseSchemaVersion,
		DatabaseIntegrity:        platformEvidence.DatabaseIntegrity,
		RuntimeIdentitySHA256:    platformEvidence.RuntimeIdentitySHA256,
		WorkspaceIdentitySHA256:  platformEvidence.WorkspaceIdentitySHA256,
	}, nil
}

func validateEvidenceRequest(request handoffsource.EvidenceRequest) error {
	if request.SourceProfile.ProfileID == "" || request.TargetProfile.ProfileID == "" ||
		request.SourceProfile.ProfileID == request.TargetProfile.ProfileID ||
		request.Runtime.Profile.ProfileID != request.SourceProfile.ProfileID ||
		!admissionSHA256.MatchString(request.ManagerStateSHA256) ||
		!admissionSHA256.MatchString(request.SelfUpdateSHA256) ||
		!admissionSHA256.MatchString(request.SandboxRegistrySHA256) ||
		!admissionSHA256.MatchString(request.SourceManifestSHA256) || request.SourceManifestPath == "" || len(request.SourceImages) == 0 {
		return errors.New("handoff evidence request has an invalid retained identity")
	}
	for _, root := range []string{request.SourceDataRoot, request.TargetDataRoot} {
		if root == "" || !filepath.IsAbs(root) || filepath.Clean(root) != root {
			return errors.New("handoff evidence data roots must be canonical absolute paths")
		}
	}
	return nil
}

type sandboxRegistry struct {
	SchemaVersion    int                       `json:"schema_version"`
	TechnicalProfile string                    `json:"technical_profile"`
	Records          map[string]sandbox.Record `json:"records"`
}

func observeSandboxRegistry(path string, profile identity.Profile, dataRoot string) (sandboxRegistry, []byte, error) {
	data, info, err := readSecureFile(path, maxSandboxEvidenceBytes, 0o600)
	if err != nil {
		return sandboxRegistry{}, nil, fmt.Errorf("read Sandbox registry evidence: %w", err)
	}
	if info.Size() == 0 {
		return sandboxRegistry{}, nil, errors.New("Sandbox registry evidence is empty")
	}
	var value sandboxRegistry
	if err := decodeClosedJSON(data, &value); err != nil {
		return sandboxRegistry{}, nil, fmt.Errorf("decode Sandbox registry evidence: %w", err)
	}
	if value.SchemaVersion != 2 || value.TechnicalProfile != profile.ProfileID || value.Records == nil {
		return sandboxRegistry{}, nil, errors.New("Sandbox registry is outside the current machine schema")
	}
	for key, record := range value.Records {
		if err := validateSandboxRecord(key, record, profile, dataRoot); err != nil {
			return sandboxRegistry{}, nil, err
		}
	}
	return value, data, nil
}

func validateSandboxRecord(key string, record sandbox.Record, profile identity.Profile, dataRoot string) error {
	if key == "" || record.SandboxID != key || record.SandboxHash != digestBytes([]byte(key)) ||
		record.ContainerName != profile.SandboxContainerPrefix+record.SandboxHash[:16] ||
		record.Image == "" || record.UID != os.Getuid() || record.GID != os.Getgid() ||
		record.ActiveCalls < 0 || record.BackgroundProcesses < 0 {
		return fmt.Errorf("Sandbox registry record %q has an invalid durable identity", key)
	}
	workspace := pathpkg.Join("workspaces", filepath.ToSlash(filepath.Clean(record.WorkspaceID)))
	environmentRoot := pathpkg.Join("agent-envs", record.SandboxHash)
	attachments, ok := sandboxAttachmentPath(record.WorkspaceID)
	if !ok || record.WorkspacePath != workspace || record.HomePath != pathpkg.Join(environmentRoot, "home") ||
		record.EnvironmentPath != pathpkg.Join(environmentRoot, "env") || record.AttachmentsPath != attachments {
		return fmt.Errorf("Sandbox registry record %q has an invalid relative binding", key)
	}
	for _, relative := range []string{record.WorkspacePath, record.HomePath, record.EnvironmentPath, record.AttachmentsPath} {
		if err := inspectRelativeDirectory(dataRoot, relative, record.UID, record.GID); err != nil {
			return fmt.Errorf("Sandbox registry record %q cannot prove %q: %w", key, relative, err)
		}
	}
	return nil
}

func sandboxAttachmentPath(workspaceID string) (string, bool) {
	clean := filepath.ToSlash(filepath.Clean(workspaceID))
	if strings.HasPrefix(clean, "user-") && safePathSegment(strings.TrimPrefix(clean, "user-")) {
		return pathpkg.Join("attachments", "private", strings.TrimPrefix(clean, "user-")), true
	}
	for _, prefix := range []string{"channels/channel-", "channel-"} {
		if strings.HasPrefix(clean, prefix) && safePathSegment(strings.TrimPrefix(clean, prefix)) {
			return pathpkg.Join("attachments", "channel", strings.TrimPrefix(clean, prefix)), true
		}
	}
	return "", false
}

func safePathSegment(value string) bool {
	return value != "" && value != "." && value != ".." && !strings.ContainsAny(value, "/\\\x00\r\n")
}

func inspectRelativeDirectory(root, relative string, uid, gid int) error {
	if !filepath.IsAbs(root) || filepath.Clean(root) != root || relative == "" || filepath.IsAbs(relative) ||
		pathpkg.Clean(relative) != relative || strings.HasPrefix(relative, "../") {
		return errors.New("directory binding is not canonical")
	}
	current := root
	parts := strings.Split(filepath.FromSlash(relative), string(filepath.Separator))
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return errors.New("directory binding contains an invalid segment")
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err != nil {
			return err
		}
		metadata, ok := info.Sys().(*syscall.Stat_t)
		if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || metadata.Uid != uint32(uid) || metadata.Gid != uint32(gid) || info.Mode().Perm()&0o077 != 0 {
			return errors.New("directory binding has unsafe metadata")
		}
	}
	return nil
}

func compareSandboxRecords(persisted map[string]sandbox.Record, live []sandbox.Record) error {
	observed := make(map[string]sandbox.Record, len(live))
	for _, record := range live {
		if _, duplicate := observed[record.SandboxID]; duplicate {
			return fmt.Errorf("live Sandbox registry duplicates %q", record.SandboxID)
		}
		observed[record.SandboxID] = record
	}
	if !reflect.DeepEqual(persisted, observed) {
		return errors.New("live Sandbox registry differs from its retained durable state")
	}
	return nil
}

func observeRelocationBoundary(source, target string) (bool, error) {
	if source == target || pathContains(source, target) || pathContains(target, source) {
		return false, errors.New("source and target data roots overlap")
	}
	if _, err := os.Lstat(target); err == nil || !os.IsNotExist(err) {
		if err == nil {
			return false, errors.New("target data root already exists")
		}
		return false, err
	}
	sourceInfo, err := inspectOwnedDirectory(source)
	if err != nil {
		return false, fmt.Errorf("inspect source data root: %w", err)
	}
	targetParent, err := inspectOwnedDirectory(filepath.Dir(target))
	if err != nil {
		return false, fmt.Errorf("inspect target data parent: %w", err)
	}
	sourceMetadata, sourceOK := sourceInfo.Sys().(*syscall.Stat_t)
	targetMetadata, targetOK := targetParent.Sys().(*syscall.Stat_t)
	if !sourceOK || !targetOK || sourceMetadata.Dev != targetMetadata.Dev {
		return false, errors.New("source and target data roots do not share a relocation filesystem")
	}
	return true, nil
}

func pathContains(parent, child string) bool {
	relative, err := filepath.Rel(parent, child)
	return err == nil && relative != "." && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func inspectOwnedDirectory(path string) (os.FileInfo, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	metadata, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || metadata.Uid != uint32(os.Getuid()) || info.Mode().Perm()&0o022 != 0 {
		return nil, errors.New("directory is not a private owned real directory")
	}
	return info, nil
}

func readSecureFile(path string, maximum int64, mode os.FileMode) ([]byte, os.FileInfo, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, nil, err
	}
	metadata, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || metadata.Uid != uint32(os.Getuid()) ||
		metadata.Gid != uint32(os.Getgid()) || metadata.Nlink != 1 || info.Mode().Perm() != mode || info.Size() < 0 || info.Size() > maximum {
		return nil, nil, errors.New("file has unsafe evidence metadata")
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, nil, err
	}
	file := os.NewFile(uintptr(fd), filepath.Base(path))
	if file == nil {
		_ = syscall.Close(fd)
		return nil, nil, errors.New("open evidence file: invalid descriptor")
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return nil, nil, errors.New("evidence file changed while opening")
	}
	data, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil || int64(len(data)) > maximum {
		return nil, nil, errors.New("evidence file exceeds its read limit")
	}
	return data, opened, nil
}

func digestBytes(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func cloneStrings(values map[string]string) map[string]string {
	result := make(map[string]string, len(values))
	for key, value := range values {
		result[key] = value
	}
	return result
}

func canonicalDigest(value any) (string, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var normalized any
	if err := decoder.Decode(&normalized); err != nil {
		return "", err
	}
	data, err = json.Marshal(normalized)
	if err != nil {
		return "", err
	}
	return digestBytes(data), nil
}

func sortedSandboxRecords(records []sandbox.Record) []sandbox.Record {
	result := append([]sandbox.Record(nil), records...)
	sort.Slice(result, func(left, right int) bool { return result[left].SandboxID < result[right].SandboxID })
	return result
}
