//go:build linux

package handoffsource

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffhost"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

func (driver *Driver) ArmPersistentHelper(ctx context.Context, journal handoff.Journal) error {
	bundle, artifact, err := driver.validateHelperJournal(journal, true)
	if err != nil {
		return err
	}
	// Once the planned journal is durable, preparing the immutable recovery set
	// is a persistent source-owner operation. It must not inherit the 45-second
	// HTTP/control request deadline, but remains bounded by an explicit absolute
	// timeout and process lifetime.
	armCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), driver.persistentArmTimeout)
	defer cancel()
	// Everything needed after source writers are stopped must already exist by
	// exact RepoDigest. The persistent helper has no authority to turn a crash
	// recovery into an implicit registry/network operation.
	for _, manifest := range []release.Manifest{bundle.sourceManifest, bundle.bridgeManifest} {
		for name := range manifest.Images {
			if !release.IsManagedImageName(name) {
				return errors.New("recovery bundle manifest contains an unmanaged image")
			}
		}
	}
	sourceNames := []string{"agent-runtime", "platform"}
	for _, name := range sourceNames {
		image := bundle.sourceManifest.Images[name]
		if !release.IsDigestReference(image) {
			return fmt.Errorf("recovery bundle manifest lacks immutable %s image", name)
		}
		if err := driver.images.VerifyManagedImagePresent(armCtx, name, image); err != nil {
			return fmt.Errorf("prove handoff source recovery image %s: %w", name, err)
		}
	}
	for _, name := range sortedImageNames(bundle.bridgeManifest) {
		image := bundle.bridgeManifest.Images[name]
		if !release.IsDigestReference(image) {
			return fmt.Errorf("recovery bundle manifest lacks immutable %s image", name)
		}
		if err := driver.images.PrepareManagedImage(armCtx, name, image); err != nil {
			return fmt.Errorf("prepare handoff recovery image %s: %w", name, err)
		}
	}
	artifactPath := driver.managerArtifactPath(journal.TransactionID)
	identity, inspectErr := inspectRegular(artifactPath, driver.maxManagerArtifactBytes, true)
	if inspectErr == nil {
		if identity.mode != ownerArtifactMode || identity.sha256 != artifact.SHA256 {
			return errors.New("staged target Manager artifact conflicts with the handoff journal")
		}
	} else {
		if !errors.Is(inspectErr, os.ErrNotExist) {
			return fmt.Errorf("inspect staged target Manager artifact: %w", inspectErr)
		}
		data, fetchErr := driver.artifacts.FetchArtifact(armCtx, artifact, driver.maxManagerArtifactBytes)
		if fetchErr != nil {
			return fmt.Errorf("download target Manager helper artifact: %w", fetchErr)
		}
		artifactPath, err = driver.stageManagerArtifact(journal.TransactionID, data, artifact.SHA256)
		if err != nil {
			return err
		}
	}
	request := driver.armRequest(journal, artifactPath, artifact.SHA256)
	expected, err := driver.helperHost.Resolve(request)
	if err != nil {
		return fmt.Errorf("resolve persistent helper identity: %w", err)
	}
	result, err := driver.helperHost.Arm(armCtx, request)
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(result.Spec, expected) {
		return errors.New("persistent helper arm returned a different static identity")
	}
	if err := validateProof(expected, result.Proof); err != nil {
		return fmt.Errorf("persistent helper arm proof: %w", err)
	}
	return nil
}

func sortedImageNames(manifest release.Manifest) []string {
	names := make([]string, 0, len(manifest.Images))
	for name := range manifest.Images {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func (driver *Driver) VerifyPersistentHelper(ctx context.Context, journal handoff.Journal) (handoff.HelperEvidence, error) {
	_, artifact, err := driver.validateHelperJournal(journal, false)
	if err != nil {
		return handoff.HelperEvidence{}, err
	}
	artifactPath := driver.managerArtifactPath(journal.TransactionID)
	identity, err := inspectRegular(artifactPath, driver.maxManagerArtifactBytes, true)
	if err != nil || identity.mode != ownerArtifactMode || identity.sha256 != artifact.SHA256 {
		return handoff.HelperEvidence{}, errors.New("persistent helper source artifact is absent or no longer transaction-bound")
	}
	request := driver.armRequest(journal, artifactPath, artifact.SHA256)
	spec, err := driver.helperHost.Resolve(request)
	if err != nil {
		return handoff.HelperEvidence{}, fmt.Errorf("resolve persistent helper identity: %w", err)
	}
	proof, err := driver.helperHost.Inspect(ctx, spec)
	if err != nil {
		return handoff.HelperEvidence{}, err
	}
	if err := validateProof(spec, proof); err != nil {
		return handoff.HelperEvidence{}, err
	}
	return handoff.HelperEvidence{
		Unit: proof.UnitName, UnitSHA256: proof.UnitSHA256,
		Executable: proof.ExecutablePath, SHA256: proof.ExecutableSHA256,
		ArgvSHA256: handoffhost.ArgvSHA256(proof.Argv), ControlGroup: proof.ControlGroup,
	}, nil
}

func (driver *Driver) validateHelperJournal(journal handoff.Journal, createBundle bool) (bundle recoveryBundle, artifact release.Artifact, resultErr error) {
	if err := handoff.Validate(journal); err != nil {
		return recoveryBundle{}, release.Artifact{}, fmt.Errorf("validate handoff journal: %w", err)
	}
	if !driver.journalPathsMatch(journal) {
		return recoveryBundle{}, release.Artifact{}, errors.New("handoff journal paths differ from the source-owner configuration")
	}
	var err error
	if createBundle {
		bundle, err = driver.ensureRecoveryBundle(journal)
	} else {
		bundle, err = driver.loadRecoveryBundle(journal)
	}
	if err != nil {
		return recoveryBundle{}, release.Artifact{}, err
	}
	manifest := bundle.bridgeManifest
	if manifest.NamespaceHandoff == nil {
		return recoveryBundle{}, release.Artifact{}, errors.New("bundled helper manifest has no namespace_handoff descriptor")
	}
	descriptor := *manifest.NamespaceHandoff
	targetArtifact, ok := descriptor.Target.Manager.Artifacts[driver.goarch]
	if !ok {
		return recoveryBundle{}, release.Artifact{}, errors.New("bundled helper manifest lacks this architecture")
	}
	sourceArtifact, ok := descriptor.Source.Manager.Artifacts[driver.goarch]
	if !ok || descriptor.Source.ProfileID != driver.source.ProfileID || descriptor.Target.ProfileID != driver.target.ProfileID ||
		descriptor.PredecessorGeneration != journal.Release.PredecessorGeneration || descriptor.BridgeGeneration != journal.Release.BridgeGeneration ||
		targetArtifact.SHA256 != journal.Release.TargetManagerSHA256 || descriptor.Target.Manager.Version != journal.Release.TargetManagerVersion ||
		descriptor.Target.Compose.SHA256 != journal.Release.TargetComposeSHA256 || sourceArtifact.SHA256 != journal.Source.StableSHA256 ||
		descriptor.Source.Compose.SHA256 != journal.Source.ComposeSHA256 {
		return recoveryBundle{}, release.Artifact{}, errors.New("bundled helper manifest differs from the immutable handoff binding")
	}
	return bundle, targetArtifact, nil
}

func (driver *Driver) journalPathsMatch(journal handoff.Journal) bool {
	unitDirectory := filepath.Dir(journal.Source.UnitPath)
	_, targetConfigPath, err := deriveTargetPathsFromSourceUnit(journal.Source.UnitPath, driver.source, driver.target)
	if err != nil {
		return false
	}
	return journal.Source.Namespace == driver.source.ProfileID && journal.Source.Unit == driver.source.ManagerUnit &&
		filepath.Base(journal.Source.UnitPath) == driver.source.ManagerUnit &&
		journal.Source.StableBinary == driver.sourceStableBinary && journal.Source.ConfigPath == driver.sourceConfigPath &&
		journal.Source.ManifestPath == filepath.Join(driver.source.ManagerStateRoot(driver.sourceDataRoot), "releases", journal.Release.PredecessorGeneration, "manifest.json") &&
		journal.Source.ComposePath == filepath.Join(driver.source.ManagerStateRoot(driver.sourceDataRoot), "releases", journal.Release.PredecessorGeneration, "compose.yaml") &&
		journal.Release.ManifestPath == filepath.Join(driver.source.ManagerStateRoot(driver.sourceDataRoot), "releases", journal.Release.BridgeGeneration, "manifest.json") &&
		journal.Source.DataRoot == driver.sourceDataRoot && journal.Source.SocketPath == driver.sourceSocketPath &&
		journal.Source.ComposeProject == driver.source.ComposeProject && journal.Source.CoreNetwork == driver.source.CoreNetwork &&
		journal.Source.LabelPrefix == driver.source.LabelPrefix && journal.Target.Namespace == driver.target.ProfileID &&
		journal.Target.Unit == driver.target.ManagerUnit && journal.Target.UnitPath == filepath.Join(unitDirectory, driver.target.ManagerUnit) &&
		journal.Target.StableBinary == driver.targetStableBinary && journal.Target.ConfigPath == targetConfigPath &&
		journal.Target.DataRoot == driver.targetDataRoot && journal.Target.SocketPath == driver.targetSocketPath &&
		journal.Target.ComposeProject == driver.target.ComposeProject && journal.Target.CoreNetwork == driver.target.CoreNetwork &&
		journal.Target.LabelPrefix == driver.target.LabelPrefix
}

func (driver *Driver) armRequest(journal handoff.Journal, artifactPath, artifactSHA string) handoffhost.ArmRequest {
	transactionDirectory := filepath.Join(driver.store.Root(), journal.TransactionID)
	return handoffhost.ArmRequest{
		TargetProfile: driver.target, TransactionID: journal.TransactionID, TransactionDirectory: transactionDirectory,
		ArtifactPath: artifactPath, ArtifactSHA256: artifactSHA, UnitDirectory: filepath.Dir(journal.Source.UnitPath),
		JournalPath: filepath.Join(transactionDirectory, "journal.json"),
	}
}

func (driver *Driver) managerArtifactPath(transactionID string) string {
	return filepath.Join(driver.store.Root(), transactionID, artifactDirectory, artifactBasename)
}

func validateProof(spec handoffhost.HelperSpec, proof handoffhost.HelperProof) error {
	if proof.TransactionID != spec.TransactionID || proof.UnitName != spec.UnitName || proof.UnitPath != spec.UnitPath ||
		proof.UnitSHA256 != spec.UnitSHA256 || proof.ExecutablePath != spec.ExecutablePath ||
		proof.ExecutableSHA256 != spec.ExecutableSHA256 || !reflect.DeepEqual(proof.Argv, spec.Argv) ||
		!proof.Enabled || !proof.Active || proof.MainPID <= 0 || !strings.HasPrefix(proof.ControlGroup, "/") || !bootIDPattern.MatchString(proof.BootID) {
		return errors.New("persistent helper proof does not match its transaction-derived static identity")
	}
	return nil
}

// The source Manager is deliberately incapable of invoking helper-owned host
// mutations. Keeping these methods explicit makes accidental use fail closed
// at the first call while still satisfying the coordinator's shared surface.
func (*Driver) FinalizePersistentHelper(context.Context, handoff.Journal) error { return ErrHelperOnly }
func (*Driver) ReserveAdmission(context.Context, handoff.Journal) error         { return ErrHelperOnly }
func (*Driver) DrainAndStopWriters(context.Context, handoff.Journal) error      { return ErrHelperOnly }
func (*Driver) CreateSnapshot(context.Context, handoff.Journal) (handoff.Snapshot, error) {
	return handoff.Snapshot{}, ErrHelperOnly
}
func (*Driver) FenceSource(context.Context, handoff.Journal) error   { return ErrHelperOnly }
func (*Driver) StageTarget(context.Context, handoff.Journal) error   { return ErrHelperOnly }
func (*Driver) TransformData(context.Context, handoff.Journal) error { return ErrHelperOnly }
func (*Driver) StartTarget(context.Context, handoff.Journal, handoff.StartupLease) error {
	return ErrHelperOnly
}
func (*Driver) ProbeTarget(context.Context, handoff.Journal) error { return ErrHelperOnly }
func (*Driver) TargetAcknowledgement(context.Context, handoff.Journal) (handoff.TargetAck, error) {
	return handoff.TargetAck{}, ErrHelperOnly
}
func (*Driver) RetireSource(context.Context, handoff.Journal) error { return ErrHelperOnly }
func (*Driver) VerifyTargetCommitBoundary(context.Context, handoff.Journal) error {
	return ErrHelperOnly
}
func (*Driver) CommitTargetPlatform(context.Context, handoff.Journal) (handoff.TargetPlatformCommit, error) {
	return handoff.TargetPlatformCommit{}, ErrHelperOnly
}
func (*Driver) StopTarget(context.Context, handoff.Journal) error  { return ErrHelperOnly }
func (*Driver) RestoreData(context.Context, handoff.Journal) error { return ErrHelperOnly }
func (*Driver) StartSource(context.Context, handoff.Journal, handoff.StartupLease) error {
	return ErrHelperOnly
}
func (*Driver) RestoreSourceBeforeFence(context.Context, handoff.Journal, handoff.StartupLease) error {
	return ErrHelperOnly
}
func (*Driver) ReleaseAdmission(context.Context, handoff.Journal) error        { return ErrHelperOnly }
func (*Driver) RemoveTargetStaging(context.Context, handoff.Journal) error     { return ErrHelperOnly }
func (*Driver) VerifySourceIdentity(context.Context, handoff.Journal) error    { return ErrHelperOnly }
func (*Driver) VerifySourcePublicReady(context.Context, handoff.Journal) error { return ErrHelperOnly }
