//go:build linux

package handoffsource

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffhost"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffowner"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

var (
	shaPattern      = regexp.MustCompile(`^[0-9a-f]{64}$`)
	dockerIDPattern = regexp.MustCompile(`^[0-9a-f]{12,64}$`)
	bootIDPattern   = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

func New(options Options) (*Driver, error) {
	if options.Store == nil || options.Admission == nil || options.Evidence == nil || options.Images == nil || options.TargetConfig == nil {
		return nil, errors.New("source handoff requires journal, admission, evidence, managed-image, and target-config dependencies")
	}
	source, err := options.SourceProfile.Profile()
	if err != nil || !reflect.DeepEqual(source, identity.SourceProfile()) {
		return nil, errors.New("source handoff requires the canonical active source profile")
	}
	if _, err := identity.ActivateVerifiedHandoffTarget(options.TargetProfile); err != nil {
		return nil, fmt.Errorf("source handoff target profile: %w", err)
	}
	goos, goarch := normalizedPlatform(options)
	if goos != "linux" || (goarch != "amd64" && goarch != "arm64") {
		return nil, fmt.Errorf("source handoff does not support %s/%s", goos, goarch)
	}
	if strings.TrimSpace(options.Channel) == "" {
		return nil, errors.New("source handoff release channel is required")
	}
	if options.HelperHost == nil {
		options.HelperHost = &handoffhost.LinuxHost{}
	}
	if options.Artifacts == nil {
		options.Artifacts = release.Client{}
	}
	if options.Units == nil {
		options.Units = SystemdCLI{}
	}
	if options.BootIDPath == "" {
		options.BootIDPath = "/proc/sys/kernel/random/boot_id"
	}
	if options.MaxManagerArtifactBytes == 0 {
		options.MaxManagerArtifactBytes = defaultMaxManagerArtifactBytes
	}
	if options.MaxManagerArtifactBytes <= 0 || options.MaxManagerArtifactBytes > defaultMaxManagerArtifactBytes {
		return nil, errors.New("source handoff Manager artifact limit is invalid")
	}
	if options.PersistentArmTimeout == 0 {
		options.PersistentArmTimeout = defaultPersistentArmTimeout
	}
	if options.PersistentArmTimeout < minimumPersistentArmTimeout || options.PersistentArmTimeout > maximumPersistentArmTimeout {
		return nil, errors.New("source handoff persistent arm timeout is outside 1m..24h")
	}
	paths := map[string]string{
		"source stable binary":     options.SourceStableBinary,
		"source config":            options.SourceConfigPath,
		"source data root":         options.SourceDataRoot,
		"source socket":            options.SourceSocketPath,
		"source Manager state":     options.SourceManagerStatePath,
		"source self-update state": options.SourceSelfUpdatePath,
		"source Sandbox registry":  options.SourceSandboxRegistryPath,
		"target stable binary":     options.TargetStableBinary,
		"target data root":         options.TargetDataRoot,
		"target runtime root":      options.TargetRuntimeRoot,
		"target socket":            options.TargetSocketPath,
		"boot id":                  options.BootIDPath,
	}
	for label, path := range paths {
		if !canonicalAbsolute(path) {
			return nil, fmt.Errorf("%s must be a canonical absolute path", label)
		}
	}
	if filepath.Base(options.SourceStableBinary) != source.ManagerBinary || options.SourceDataRoot == options.TargetDataRoot {
		return nil, errors.New("source handoff paths do not match the source profile")
	}
	expectedSourceSocket, err := source.ControlSocketPath(options.SourceDataRoot, "")
	if err != nil || expectedSourceSocket != options.SourceSocketPath {
		return nil, errors.New("source handoff socket does not match the source profile")
	}
	sourceStateRoot := source.ManagerStateRoot(options.SourceDataRoot)
	if options.SourceManagerStatePath != filepath.Join(sourceStateRoot, "state.json") ||
		options.SourceSelfUpdatePath != filepath.Join(sourceStateRoot, "manager-binaries.json") ||
		options.SourceSandboxRegistryPath != filepath.Join(sourceStateRoot, "sandboxes.json") {
		return nil, errors.New("source handoff state paths do not match the source Manager root")
	}
	target := options.TargetProfile
	if filepath.Base(options.TargetStableBinary) != target.ManagerBinary || filepath.Base(options.TargetDataRoot) != target.DataDirectory {
		return nil, errors.New("source handoff target paths do not match the target profile")
	}
	expectedTargetSocket, err := target.ControlSocketPath(options.TargetDataRoot, options.TargetRuntimeRoot)
	if err != nil || expectedTargetSocket != options.TargetSocketPath {
		return nil, errors.New("source handoff target socket does not match the target profile")
	}
	return &Driver{
		store: options.Store, admission: options.Admission, evidence: options.Evidence,
		helperHost: options.HelperHost, artifacts: options.Artifacts, images: options.Images, units: options.Units,
		targetConfig: options.TargetConfig,
		source:       source, target: target, channel: options.Channel, goos: goos, goarch: goarch,
		sourceStableBinary: options.SourceStableBinary, sourceConfigPath: options.SourceConfigPath,
		sourceDataRoot: options.SourceDataRoot, sourceSocketPath: options.SourceSocketPath,
		sourceManagerStatePath: options.SourceManagerStatePath, sourceSelfUpdatePath: options.SourceSelfUpdatePath,
		sourceSandboxRegistryPath: options.SourceSandboxRegistryPath,
		targetStableBinary:        options.TargetStableBinary,
		targetDataRoot:            options.TargetDataRoot, targetRuntimeRoot: options.TargetRuntimeRoot,
		targetSocketPath: options.TargetSocketPath,
		bootIDPath:       options.BootIDPath, maxManagerArtifactBytes: options.MaxManagerArtifactBytes,
		persistentArmTimeout: options.PersistentArmTimeout,
	}, nil
}

func (driver *Driver) Preflight(ctx context.Context, request handoffowner.BridgeRequest, source, target identity.Profile) (_ handoffowner.PreflightPlan, resultErr error) {
	// This must remain the first host observation in this method. The caller
	// already holds Store's global lease, establishing global -> admission.
	admission, err := driver.admission.Acquire(ctx)
	if err != nil {
		return handoffowner.PreflightPlan{}, fmt.Errorf("acquire ordinary runtime admission: %w", err)
	}
	returnAdmission := false
	defer func() {
		if !returnAdmission {
			resultErr = errors.Join(resultErr, admission.Close())
		}
	}()
	if !reflect.DeepEqual(source, driver.source) || !reflect.DeepEqual(target, driver.target) {
		return handoffowner.PreflightPlan{}, errors.New("preflight profiles differ from the configured source owner")
	}
	manifest, _, err := driver.retainedManifest(request.ManifestPath, request.ManifestSHA256)
	if err != nil {
		return handoffowner.PreflightPlan{}, err
	}
	if !reflect.DeepEqual(manifest, request.Manifest) {
		return handoffowner.PreflightPlan{}, errors.New("retained bridge manifest differs from the routed manifest")
	}
	if manifest.NamespaceHandoff == nil {
		return handoffowner.PreflightPlan{}, errors.New("source preflight requires a namespace_handoff manifest")
	}
	descriptor := *manifest.NamespaceHandoff
	runtimeObservation, err := admission.Observe(ctx)
	if err != nil {
		return handoffowner.PreflightPlan{}, fmt.Errorf("observe admitted runtime: %w", err)
	}
	sourceArtifact, ok := descriptor.Source.Manager.Artifacts[driver.goarch]
	if !ok {
		return handoffowner.PreflightPlan{}, errors.New("bridge source Manager artifact is absent for this architecture")
	}
	if err := validateRuntime(runtimeObservation, driver.source, descriptor.PredecessorGeneration, sourceArtifact.SHA256, driver.goarch); err != nil {
		return handoffowner.PreflightPlan{}, err
	}

	sourceUnit, err := driver.units.Show(ctx, driver.source.ManagerUnit)
	if err != nil {
		return handoffowner.PreflightPlan{}, fmt.Errorf("inspect source Manager unit: %w", err)
	}
	if sourceUnit.LoadState != "loaded" || sourceUnit.ActiveState != "active" || sourceUnit.UnitFileState != "enabled" ||
		sourceUnit.MainPID <= 0 {
		return handoffowner.PreflightPlan{}, errors.New("source Manager unit is not the exact enabled active owner")
	}
	unitDirectory, targetConfigPath, err := deriveTargetPathsFromSourceUnit(sourceUnit.FragmentPath, driver.source, driver.target)
	if err != nil {
		return handoffowner.PreflightPlan{}, err
	}
	sourceUnitPath := sourceUnit.FragmentPath
	targetUnitPath := filepath.Join(unitDirectory, driver.target.ManagerUnit)
	targetUnit, err := driver.units.Show(ctx, driver.target.ManagerUnit)
	if err != nil {
		return handoffowner.PreflightPlan{}, fmt.Errorf("inspect target Manager unit: %w", err)
	}
	if targetUnit.LoadState != "not-found" || targetUnit.ActiveState == "active" || targetUnit.MainPID != 0 || targetUnit.FragmentPath != "" {
		return handoffowner.PreflightPlan{}, errors.New("target Manager unit already exists or has live ownership")
	}
	watchdogs, err := driver.units.ActiveUnits(ctx, []string{
		driver.source.WatchdogUnitPrefix, driver.source.RecoveryWatchdogUnitPrefix,
		driver.target.WatchdogUnitPrefix, driver.target.RecoveryWatchdogUnitPrefix,
	})
	if err != nil {
		return handoffowner.PreflightPlan{}, fmt.Errorf("inspect Manager watchdog units: %w", err)
	}
	if len(watchdogs) != 0 {
		return handoffowner.PreflightPlan{}, fmt.Errorf("Manager watchdog units remain active: %s", strings.Join(watchdogs, ", "))
	}
	for label, path := range map[string]string{
		"source user unit directory":     unitDirectory,
		"source stable-binary parent":    filepath.Dir(driver.sourceStableBinary),
		"source config directory":        filepath.Dir(driver.sourceConfigPath),
		"source data parent":             filepath.Dir(driver.sourceDataRoot),
		"source control directory":       filepath.Dir(driver.sourceSocketPath),
		"source Manager-state directory": filepath.Dir(driver.sourceManagerStatePath),
	} {
		if _, err := inspectDirectory(path, false); err != nil {
			return handoffowner.PreflightPlan{}, fmt.Errorf("validate %s: %w", label, err)
		}
	}
	if err := requireAbsent(sourceUnitPath + ".d"); err != nil {
		return handoffowner.PreflightPlan{}, fmt.Errorf("source Manager unit drop-ins are not part of the closed binding: %w", err)
	}

	unitIdentity, err := inspectRegular(sourceUnitPath, 1<<20, false)
	if err != nil {
		return handoffowner.PreflightPlan{}, fmt.Errorf("validate source Manager unit: %w", err)
	}
	stableIdentity, err := inspectRegular(driver.sourceStableBinary, defaultMaxManagerArtifactBytes, false)
	if err != nil {
		return handoffowner.PreflightPlan{}, fmt.Errorf("validate source stable Manager: %w", err)
	}
	if stableIdentity.mode&0o111 == 0 || stableIdentity.sha256 != sourceArtifact.SHA256 || stableIdentity.sha256 != runtimeObservation.ManagerSHA256 {
		return handoffowner.PreflightPlan{}, errors.New("source stable Manager does not match the running predecessor artifact")
	}
	configIdentity, sourceConfigRaw, err := inspectRegularWithBytes(driver.sourceConfigPath, 1<<20, true)
	if err != nil {
		return handoffowner.PreflightPlan{}, fmt.Errorf("validate source Manager config: %w", err)
	}
	targetConfigRaw, err := driver.targetConfig.RenderTargetConfig(
		driver.sourceConfigPath, sourceConfigRaw, targetConfigPath, driver.targetDataRoot, driver.targetSocketPath,
	)
	if err != nil {
		return handoffowner.PreflightPlan{}, fmt.Errorf("render journal-bound target Manager config: %w", err)
	}
	if len(targetConfigRaw) == 0 || len(targetConfigRaw) > 1<<20 || targetConfigRaw[len(targetConfigRaw)-1] != '\n' {
		return handoffowner.PreflightPlan{}, errors.New("rendered target Manager config is empty, unbounded, or not newline terminated")
	}
	targetConfigDigest := sha256.Sum256(targetConfigRaw)
	sourceReleaseRoot := filepath.Join(driver.source.ManagerStateRoot(driver.sourceDataRoot), "releases", descriptor.PredecessorGeneration)
	sourceManifestPath := filepath.Join(sourceReleaseRoot, "manifest.json")
	manifestIdentity, sourceManifestRaw, err := inspectRegularWithBytes(sourceManifestPath, 1<<20, true)
	if err != nil {
		return handoffowner.PreflightPlan{}, fmt.Errorf("validate source predecessor manifest: %w", err)
	}
	sourceManifest, err := release.DecodeManifest(sourceManifestRaw, driver.channel, driver.goos, driver.goarch)
	if err != nil {
		return handoffowner.PreflightPlan{}, fmt.Errorf("decode source predecessor manifest: %w", err)
	}
	if sourceManifest.ID() != descriptor.PredecessorGeneration || sourceManifest.SourceCommit != descriptor.PredecessorGeneration ||
		!reflect.DeepEqual(sourceManifest.Manager, descriptor.Source.Manager) || sourceManifest.Compose != descriptor.Source.Compose ||
		sourceManifest.DatabaseSchemaVersion != manifest.DatabaseSchemaVersion {
		return handoffowner.PreflightPlan{}, errors.New("source predecessor manifest differs from the bridge descriptor")
	}
	sourceComposePath := filepath.Join(sourceReleaseRoot, "compose.yaml")
	composeIdentity, err := inspectRegular(sourceComposePath, 4<<20, true)
	if err != nil {
		return handoffowner.PreflightPlan{}, fmt.Errorf("validate source predecessor Compose: %w", err)
	}
	if composeIdentity.sha256 != descriptor.Source.Compose.SHA256 {
		return handoffowner.PreflightPlan{}, errors.New("source predecessor Compose differs from the bridge descriptor")
	}
	if _, err := inspectDirectory(driver.sourceDataRoot, true); err != nil {
		return handoffowner.PreflightPlan{}, fmt.Errorf("validate source data root: %w", err)
	}
	if err := inspectUnixSocket(driver.sourceSocketPath); err != nil {
		return handoffowner.PreflightPlan{}, fmt.Errorf("validate source control socket: %w", err)
	}
	managerState, err := inspectRegular(driver.sourceManagerStatePath, 32<<20, true)
	if err != nil {
		return handoffowner.PreflightPlan{}, fmt.Errorf("validate source Manager state: %w", err)
	}
	selfUpdate, err := inspectRegular(driver.sourceSelfUpdatePath, 32<<20, true)
	if err != nil {
		return handoffowner.PreflightPlan{}, fmt.Errorf("validate source self-update state: %w", err)
	}
	sandboxRegistry, err := inspectRegular(driver.sourceSandboxRegistryPath, 64<<20, true)
	if err != nil {
		return handoffowner.PreflightPlan{}, fmt.Errorf("validate source Sandbox registry: %w", err)
	}
	for label, path := range map[string]string{
		"target Manager unit":          targetUnitPath,
		"target Manager unit drop-ins": targetUnitPath + ".d",
		"target stable Manager":        driver.targetStableBinary,
		"target config directory":      filepath.Dir(targetConfigPath),
		"target data root":             driver.targetDataRoot,
		"target control socket":        driver.targetSocketPath,
	} {
		if err := requireAbsent(path); err != nil {
			return handoffowner.PreflightPlan{}, fmt.Errorf("%s must be absent: %w", label, err)
		}
	}

	collected, err := driver.evidence.Collect(ctx, EvidenceRequest{
		Bridge: request, SourceProfile: driver.source, TargetProfile: driver.target, Runtime: runtimeObservation,
		ManagerStateSHA256: managerState.sha256, SelfUpdateSHA256: selfUpdate.sha256,
		SandboxRegistrySHA256: sandboxRegistry.sha256, SourceManifestPath: sourceManifestPath,
		SourceManifestSHA256: manifestIdentity.sha256, SourceImages: sourceManifest.Images, SourceDataRoot: driver.sourceDataRoot,
		TargetDataRoot: driver.targetDataRoot,
	})
	if err != nil {
		return handoffowner.PreflightPlan{}, fmt.Errorf("collect closed-world deployment evidence: %w", err)
	}
	if err := validateDeploymentEvidence(collected, descriptor.PredecessorGeneration, sourceArtifact.SHA256); err != nil {
		return handoffowner.PreflightPlan{}, err
	}
	bootID, err := readBootID(driver.bootIDPath)
	if err != nil {
		return handoffowner.PreflightPlan{}, err
	}
	plan := handoffowner.PreflightPlan{
		Source: handoff.SourceBinding{
			Namespace: driver.source.ProfileID, Unit: driver.source.ManagerUnit, UnitEnabled: true,
			UnitPath: sourceUnitPath, UnitSHA256: unitIdentity.sha256,
			StableBinary: driver.sourceStableBinary, StableSHA256: stableIdentity.sha256,
			ConfigPath: driver.sourceConfigPath, ConfigSHA256: configIdentity.sha256,
			ManifestPath: sourceManifestPath, ManifestSHA256: manifestIdentity.sha256,
			ComposePath: sourceComposePath, ComposeSHA256: composeIdentity.sha256,
			DataRoot: driver.sourceDataRoot, SocketPath: driver.sourceSocketPath,
			ComposeProject: driver.source.ComposeProject, CoreNetwork: driver.source.CoreNetwork,
			CoreNetworkID: collected.SourceCoreNetworkID, LabelPrefix: driver.source.LabelPrefix,
		},
		Target: handoff.TargetBinding{
			Namespace: driver.target.ProfileID, Unit: driver.target.ManagerUnit, UnitPath: targetUnitPath,
			StableBinary: driver.targetStableBinary, ConfigPath: targetConfigPath,
			ConfigSHA256: hex.EncodeToString(targetConfigDigest[:]), DataRoot: driver.targetDataRoot,
			SocketPath:     driver.targetSocketPath,
			ComposeProject: driver.target.ComposeProject, CoreNetwork: driver.target.CoreNetwork, LabelPrefix: driver.target.LabelPrefix,
		},
		Evidence: handoff.Evidence{
			ManagerStateSHA256: managerState.sha256, SelfUpdateStateSHA256: selfUpdate.sha256,
			SandboxRegistrySHA256: sandboxRegistry.sha256, DockerInventorySHA256: collected.DockerInventorySHA256,
			DatabaseSchemaVersion: collected.DatabaseSchemaVersion, DatabaseIntegrity: collected.DatabaseIntegrity,
			RuntimeIdentitySHA256: collected.RuntimeIdentitySHA256, WorkspaceIdentitySHA256: collected.WorkspaceIdentitySHA256,
			BootID: bootID,
		},
		Runtime: runtimeObservation, Admission: admission,
	}
	returnAdmission = true
	return plan, nil
}

func deriveTargetPathsFromSourceUnit(fragment string, source, target identity.Profile) (string, string, error) {
	if !canonicalAbsolute(fragment) || filepath.Base(fragment) != source.ManagerUnit {
		return "", "", errors.New("source Manager FragmentPath is not canonical")
	}
	unitDirectory := filepath.Dir(fragment)
	if filepath.Base(unitDirectory) != "user" || filepath.Base(filepath.Dir(unitDirectory)) != "systemd" {
		return "", "", errors.New("source Manager FragmentPath is outside the canonical user-systemd layout")
	}
	configHome := filepath.Dir(filepath.Dir(unitDirectory))
	if !canonicalAbsolute(configHome) {
		return "", "", errors.New("source Manager FragmentPath has an invalid config home")
	}
	targetConfigPath := target.DefaultConfigPath(configHome)
	if !canonicalAbsolute(targetConfigPath) || filepath.Base(filepath.Dir(targetConfigPath)) != target.ConfigDirectory || filepath.Base(targetConfigPath) != target.ConfigFile {
		return "", "", errors.New("derived target Manager config path is invalid")
	}
	return unitDirectory, targetConfigPath, nil
}

func validateRuntime(observation handoffowner.RuntimeObservation, profile identity.Profile, generation, managerSHA, architecture string) error {
	if !reflect.DeepEqual(observation.Profile, profile) || observation.Generation != generation ||
		observation.ManagerSHA256 != managerSHA || observation.Architecture != architecture {
		return errors.New("runtime identity differs from the bridge predecessor")
	}
	if !observation.Idle || observation.Maintenance || observation.ActiveOperationID != "" ||
		observation.FinalizePendingOperationID != "" || observation.CandidatePresent || observation.ActivationPresent ||
		observation.WatchdogCount != 0 || observation.ActiveExecutionCount != 0 {
		return errors.New("runtime is not at the source handoff idle boundary")
	}
	return nil
}

func validateDeploymentEvidence(value DeploymentEvidence, predecessorGeneration, sourceManagerSHA string) error {
	guards := []struct {
		name string
		ok   bool
	}{
		{"source Compose ownership", value.SourceComposeOwned},
		{"source core-network ownership", value.SourceCoreNetworkOwned},
		{"target Compose absence", value.TargetComposeAbsent},
		{"target core-network absence", value.TargetCoreNetworkAbsent},
		{"target label-object absence", value.TargetLabelObjectsAbsent},
		{"terminal ordinary operations", value.AllOperationsTerminal},
		{"Platform reservation idle", value.PlatformReservationIdle},
		{"Sandbox calls idle", value.SandboxCallsIdle},
		{"background processes idle", value.BackgroundProcessesIdle},
		{"file commit windows idle", value.FileCommitWindowsIdle},
		{"machine schemas ready", value.MachineSchemasReady},
		{"data relocation boundary", value.RelocationBoundarySafe},
	}
	for _, guard := range guards {
		if !guard.ok {
			return fmt.Errorf("source handoff preflight did not prove %s", guard.name)
		}
	}
	if !dockerIDPattern.MatchString(value.SourceCoreNetworkID) {
		return errors.New("source core-network id is invalid")
	}
	for label, digest := range map[string]string{
		"Docker inventory":   value.DockerInventorySHA256,
		"Runtime identity":   value.RuntimeIdentitySHA256,
		"workspace identity": value.WorkspaceIdentitySHA256,
	} {
		if !shaPattern.MatchString(digest) {
			return fmt.Errorf("%s evidence digest is invalid", label)
		}
	}
	if value.DatabaseSchemaVersion <= 0 || value.DatabaseIntegrity != "ok" {
		return errors.New("database evidence is not an integrity-checked schema")
	}
	if !value.SelfUpdateCurrentStable || value.SelfUpdateGeneration != predecessorGeneration ||
		value.SelfUpdateManagerSHA256 != sourceManagerSHA {
		return errors.New("self-update Current is not the stable bridge predecessor")
	}
	return nil
}

func (driver *Driver) AcquireRuntimeObservationLease(ctx context.Context) (handoffowner.RuntimeObservationLease, error) {
	lease, err := driver.admission.Acquire(ctx)
	if err != nil {
		return nil, fmt.Errorf("acquire ordinary runtime admission: %w", err)
	}
	return lease, nil
}

func (driver *Driver) retainedManifest(path, expectedSHA string) (release.Manifest, []byte, error) {
	if !canonicalAbsolute(path) || !shaPattern.MatchString(expectedSHA) {
		return release.Manifest{}, nil, errors.New("retained bridge manifest identity is invalid")
	}
	identity, data, err := inspectRegularWithBytes(path, 1<<20, true)
	if err != nil {
		return release.Manifest{}, nil, fmt.Errorf("read retained bridge manifest: %w", err)
	}
	if identity.sha256 != expectedSHA {
		return release.Manifest{}, nil, errors.New("retained bridge manifest checksum changed")
	}
	manifest, err := release.DecodeManifest(data, driver.channel, driver.goos, driver.goarch)
	if err != nil {
		return release.Manifest{}, nil, fmt.Errorf("decode retained bridge manifest: %w", err)
	}
	return manifest, data, nil
}

func readBootID(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read host boot id: %w", err)
	}
	if len(data) > 256 {
		return "", errors.New("host boot id exceeds its size limit")
	}
	value := strings.TrimSpace(string(data))
	if !bootIDPattern.MatchString(value) {
		return "", errors.New("host boot id is invalid")
	}
	return value, nil
}

func canonicalAbsolute(path string) bool {
	return path != "" && filepath.IsAbs(path) && filepath.Clean(path) == path && !strings.ContainsRune(path, 0)
}

func digestBytes(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}
