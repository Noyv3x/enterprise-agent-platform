//go:build linux

package handoffsource

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"syscall"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

const (
	recoveryFileMode      = 0o600
	recoveryManifestLimit = 1 << 20
	recoveryComposeLimit  = 4 << 20
)

type recoveryBundle struct {
	paths                            handoff.RecoveryBundlePaths
	sourceManifest, bridgeManifest   release.Manifest
	sourceManifestRaw, sourceCompose []byte
	bridgeManifestRaw, bridgeCompose []byte
}

// CanonicalSourceReleaseRestorer republishes only the journal-bound source
// manifest and Compose from the external transaction bundle. The persistent
// helper invokes it before every source fixed-stack start and repeats the proof
// immediately before promoting the restricted participant to the terminal
// abort/rollback owner.
type CanonicalSourceReleaseRestorer struct {
	transactionDirectory  string
	channel, goos, goarch string
}

func NewCanonicalSourceReleaseRestorer(transactionDirectory, channel, goos, goarch string) (*CanonicalSourceReleaseRestorer, error) {
	transactionID := filepath.Base(transactionDirectory)
	if _, err := handoff.DeriveRecoveryBundlePaths(transactionDirectory, transactionID); err != nil {
		return nil, err
	}
	if channel == "" || goos != "linux" || (goarch != "amd64" && goarch != "arm64") {
		return nil, errors.New("canonical source release restorer platform is invalid")
	}
	return &CanonicalSourceReleaseRestorer{transactionDirectory: transactionDirectory, channel: channel, goos: goos, goarch: goarch}, nil
}

func (restorer *CanonicalSourceReleaseRestorer) RestoreCanonicalSourceRelease(ctx context.Context, journal handoff.Journal) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if restorer == nil || filepath.Base(restorer.transactionDirectory) != journal.TransactionID {
		return errors.New("canonical source release restorer differs from the handoff transaction")
	}
	if err := handoff.Validate(journal); err != nil {
		return err
	}
	paths, err := handoff.DeriveRecoveryBundlePaths(restorer.transactionDirectory, journal.TransactionID)
	if err != nil {
		return err
	}
	manifestIdentity, manifestRaw, err := inspectRegularWithBytes(paths.SourceManifest, recoveryManifestLimit, true)
	if err != nil || manifestIdentity.mode != recoveryFileMode || manifestIdentity.sha256 != journal.Source.ManifestSHA256 {
		return errors.Join(err, errors.New("bundled source manifest is not transaction-bound"))
	}
	manifest, err := release.DecodeManifest(manifestRaw, restorer.channel, restorer.goos, restorer.goarch)
	if err != nil || manifest.ID() != journal.Release.PredecessorGeneration || manifest.SourceCommit != journal.Release.PredecessorGeneration {
		return errors.Join(err, errors.New("bundled source manifest generation is invalid"))
	}
	composeIdentity, composeRaw, err := inspectRegularWithBytes(paths.SourceCompose, recoveryComposeLimit, true)
	if err != nil || composeIdentity.mode != recoveryFileMode || composeIdentity.sha256 != journal.Source.ComposeSHA256 ||
		manifest.Compose.SHA256 != journal.Source.ComposeSHA256 {
		return errors.Join(err, errors.New("bundled source Compose is not transaction-bound"))
	}
	releaseDirectory := filepath.Dir(journal.Source.ManifestPath)
	if releaseDirectory != filepath.Dir(journal.Source.ComposePath) || filepath.Base(releaseDirectory) != journal.Release.PredecessorGeneration {
		return errors.New("canonical source release paths differ from the handoff binding")
	}
	releasesDirectory := filepath.Dir(releaseDirectory)
	releasesFD, err := openAbsolute(releasesDirectory, true)
	if err != nil {
		return fmt.Errorf("open canonical source releases directory: %w", err)
	}
	defer syscall.Close(releasesFD)
	if err := requireExactOwnerDirectoryFD(releasesFD); err != nil {
		return err
	}
	generationFD, err := ensureOwnerDirectoryAt(releasesFD, journal.Release.PredecessorGeneration)
	if err != nil {
		return fmt.Errorf("prepare canonical source release directory: %w", err)
	}
	defer syscall.Close(generationFD)
	for _, name := range []string{"." + handoff.RecoveryManifestName + ".staging", "." + handoff.RecoveryComposeName + ".staging"} {
		if err := cleanupRecoveryTemporary(generationFD, name); err != nil {
			return fmt.Errorf("clean canonical source release staging: %w", err)
		}
	}
	if err := requireSafeCanonicalReleaseEntries(generationFD); err != nil {
		return err
	}
	if err := stageRecoveryFile(generationFD, journal.Source.ManifestPath, handoff.RecoveryManifestName, manifestRaw, journal.Source.ManifestSHA256, recoveryManifestLimit); err != nil {
		return fmt.Errorf("restore canonical source manifest: %w", err)
	}
	if err := stageRecoveryFile(generationFD, journal.Source.ComposePath, handoff.RecoveryComposeName, composeRaw, journal.Source.ComposeSHA256, recoveryComposeLimit); err != nil {
		return fmt.Errorf("restore canonical source Compose: %w", err)
	}
	if err := syscall.Fsync(generationFD); err != nil {
		return err
	}
	if err := syscall.Fsync(releasesFD); err != nil {
		return err
	}
	return nil
}

func requireSafeCanonicalReleaseEntries(directoryFD int) error {
	duplicate, err := syscall.Dup(directoryFD)
	if err != nil {
		return err
	}
	directory := os.NewFile(uintptr(duplicate), "canonical source release")
	if directory == nil {
		_ = syscall.Close(duplicate)
		return errors.New("duplicate canonical source release descriptor failed")
	}
	defer directory.Close()
	entries, err := directory.Readdirnames(-1)
	if err != nil {
		return err
	}
	allowed := map[string]struct{}{handoff.RecoveryManifestName: {}, handoff.RecoveryComposeName: {}, "compose.env": {}}
	for _, name := range entries {
		if _, ok := allowed[name]; !ok {
			return fmt.Errorf("canonical source release contains unknown entry %q", name)
		}
		stat, err := lstatAt(directoryFD, name)
		if err != nil {
			return err
		}
		if stat.Mode&syscall.S_IFMT != syscall.S_IFREG || stat.Uid != uint32(os.Getuid()) || stat.Nlink != 1 || stat.Mode&0o077 != 0 {
			return fmt.Errorf("canonical source release entry %q has an unsafe identity", name)
		}
	}
	return nil
}

func (driver *Driver) recoveryPaths(transactionID string) handoff.RecoveryBundlePaths {
	paths, _ := handoff.DeriveRecoveryBundlePaths(filepath.Join(driver.store.Root(), transactionID), transactionID)
	return paths
}

func (driver *Driver) ensureRecoveryBundle(journal handoff.Journal) (recoveryBundle, error) {
	// A crash can leave only the two deterministic staging basenames. Remove
	// those exact owner-only files before deciding whether the completed bundle
	// is reusable. This lets a helper re-arm from the durable bundle even after
	// the original release directories have already been retired.
	if err := driver.cleanupRecoveryBundleStaging(journal); err != nil {
		return recoveryBundle{}, err
	}
	if bundle, err := driver.loadRecoveryBundle(journal); err == nil {
		return bundle, nil
	}
	original, err := driver.loadOriginalRecoveryInputs(journal)
	if err != nil {
		return recoveryBundle{}, err
	}
	if err := driver.stageRecoveryBundle(journal, original); err != nil {
		return recoveryBundle{}, err
	}
	return driver.loadRecoveryBundle(journal)
}

func (driver *Driver) cleanupRecoveryBundleStaging(journal handoff.Journal) error {
	paths := driver.recoveryPaths(journal.TransactionID)
	for _, directory := range []string{paths.SourceDirectory, paths.BridgeDirectory} {
		fd, err := openAbsolute(directory, true)
		if err != nil {
			if errors.Is(unwrapPathError(err), syscall.ENOENT) {
				continue
			}
			return fmt.Errorf("open recovery bundle directory for staging cleanup: %w", err)
		}
		if err := requireExactOwnerDirectoryFD(fd); err != nil {
			_ = syscall.Close(fd)
			return err
		}
		for _, name := range []string{"." + handoff.RecoveryManifestName + ".staging", "." + handoff.RecoveryComposeName + ".staging"} {
			if err := cleanupRecoveryTemporary(fd, name); err != nil {
				_ = syscall.Close(fd)
				return fmt.Errorf("clean recovery bundle staging file: %w", err)
			}
		}
		if err := syscall.Close(fd); err != nil {
			return err
		}
	}
	return nil
}

func (driver *Driver) loadOriginalRecoveryInputs(journal handoff.Journal) (recoveryBundle, error) {
	bridgeManifest, bridgeRaw, err := driver.retainedManifest(journal.Release.ManifestPath, journal.Release.ManifestSHA256)
	if err != nil {
		return recoveryBundle{}, err
	}
	bridgeComposePath := filepath.Join(filepath.Dir(journal.Release.ManifestPath), handoff.RecoveryComposeName)
	bridgeComposeIdentity, bridgeCompose, err := inspectRegularWithBytes(bridgeComposePath, recoveryComposeLimit, true)
	if err != nil {
		return recoveryBundle{}, fmt.Errorf("read original bridge Compose: %w", err)
	}
	if bridgeComposeIdentity.sha256 != journal.Release.TargetComposeSHA256 {
		return recoveryBundle{}, errors.New("original bridge Compose differs from the handoff journal")
	}
	sourceManifestIdentity, sourceRaw, err := inspectRegularWithBytes(journal.Source.ManifestPath, recoveryManifestLimit, true)
	if err != nil {
		return recoveryBundle{}, fmt.Errorf("read original source manifest: %w", err)
	}
	if sourceManifestIdentity.sha256 != journal.Source.ManifestSHA256 {
		return recoveryBundle{}, errors.New("original source manifest differs from the handoff journal")
	}
	sourceManifest, err := release.DecodeManifest(sourceRaw, driver.channel, driver.goos, driver.goarch)
	if err != nil {
		return recoveryBundle{}, fmt.Errorf("decode original source manifest: %w", err)
	}
	sourceComposeIdentity, sourceCompose, err := inspectRegularWithBytes(journal.Source.ComposePath, recoveryComposeLimit, true)
	if err != nil {
		return recoveryBundle{}, fmt.Errorf("read original source Compose: %w", err)
	}
	if sourceComposeIdentity.sha256 != journal.Source.ComposeSHA256 {
		return recoveryBundle{}, errors.New("original source Compose differs from the handoff journal")
	}
	bundle := recoveryBundle{
		paths: driver.recoveryPaths(journal.TransactionID), sourceManifest: sourceManifest, bridgeManifest: bridgeManifest,
		sourceManifestRaw: sourceRaw, sourceCompose: sourceCompose,
		bridgeManifestRaw: bridgeRaw, bridgeCompose: bridgeCompose,
	}
	if err := driver.validateRecoveryBundleContent(journal, bundle); err != nil {
		return recoveryBundle{}, err
	}
	return bundle, nil
}

func (driver *Driver) loadRecoveryBundle(journal handoff.Journal) (recoveryBundle, error) {
	paths := driver.recoveryPaths(journal.TransactionID)
	if err := requireClosedRecoveryDirectory(paths.Root, []string{handoff.RecoverySourceDirectory, handoff.RecoveryBridgeDirectory}, true); err != nil {
		return recoveryBundle{}, fmt.Errorf("validate recovery bundle root: %w", err)
	}
	for _, directory := range []string{paths.SourceDirectory, paths.BridgeDirectory} {
		if err := requireClosedRecoveryDirectory(directory, []string{handoff.RecoveryManifestName, handoff.RecoveryComposeName}, false); err != nil {
			return recoveryBundle{}, fmt.Errorf("validate recovery bundle directory: %w", err)
		}
	}
	read := func(path string, limit int64) ([]byte, error) {
		identity, raw, err := inspectRegularWithBytes(path, limit, true)
		if err != nil {
			return nil, err
		}
		if identity.mode != recoveryFileMode {
			return nil, errors.New("recovery bundle file mode is not 0600")
		}
		return raw, nil
	}
	sourceRaw, err := read(paths.SourceManifest, recoveryManifestLimit)
	if err != nil {
		return recoveryBundle{}, fmt.Errorf("read bundled source manifest: %w", err)
	}
	sourceCompose, err := read(paths.SourceCompose, recoveryComposeLimit)
	if err != nil {
		return recoveryBundle{}, fmt.Errorf("read bundled source Compose: %w", err)
	}
	bridgeRaw, err := read(paths.BridgeManifest, recoveryManifestLimit)
	if err != nil {
		return recoveryBundle{}, fmt.Errorf("read bundled bridge manifest: %w", err)
	}
	bridgeCompose, err := read(paths.BridgeCompose, recoveryComposeLimit)
	if err != nil {
		return recoveryBundle{}, fmt.Errorf("read bundled bridge Compose: %w", err)
	}
	sourceManifest, err := release.DecodeManifest(sourceRaw, driver.channel, driver.goos, driver.goarch)
	if err != nil {
		return recoveryBundle{}, fmt.Errorf("decode bundled source manifest: %w", err)
	}
	bridgeManifest, err := release.DecodeManifest(bridgeRaw, driver.channel, driver.goos, driver.goarch)
	if err != nil {
		return recoveryBundle{}, fmt.Errorf("decode bundled bridge manifest: %w", err)
	}
	bundle := recoveryBundle{
		paths: paths, sourceManifest: sourceManifest, bridgeManifest: bridgeManifest,
		sourceManifestRaw: sourceRaw, sourceCompose: sourceCompose,
		bridgeManifestRaw: bridgeRaw, bridgeCompose: bridgeCompose,
	}
	if err := driver.validateRecoveryBundleContent(journal, bundle); err != nil {
		return recoveryBundle{}, err
	}
	return bundle, nil
}

func (driver *Driver) validateRecoveryBundleContent(journal handoff.Journal, bundle recoveryBundle) error {
	if digestBytes(bundle.sourceManifestRaw) != journal.Source.ManifestSHA256 ||
		digestBytes(bundle.sourceCompose) != journal.Source.ComposeSHA256 ||
		digestBytes(bundle.bridgeManifestRaw) != journal.Release.ManifestSHA256 ||
		digestBytes(bundle.bridgeCompose) != journal.Release.TargetComposeSHA256 {
		return errors.New("recovery bundle bytes differ from the immutable handoff binding")
	}
	if bundle.sourceManifest.ID() != journal.Release.PredecessorGeneration ||
		bundle.sourceManifest.SourceCommit != journal.Release.PredecessorGeneration ||
		bundle.bridgeManifest.ID() != journal.Release.BridgeGeneration ||
		bundle.bridgeManifest.SourceCommit != journal.Release.BridgeGeneration ||
		bundle.bridgeManifest.NamespaceHandoff == nil {
		return errors.New("recovery bundle generations differ from the immutable handoff binding")
	}
	descriptor := *bundle.bridgeManifest.NamespaceHandoff
	targetArtifact, targetOK := descriptor.Target.Manager.Artifacts[driver.goarch]
	sourceArtifact, sourceOK := descriptor.Source.Manager.Artifacts[driver.goarch]
	if !targetOK || !sourceOK || descriptor.PredecessorGeneration != journal.Release.PredecessorGeneration ||
		descriptor.BridgeGeneration != journal.Release.BridgeGeneration || descriptor.Source.ProfileID != driver.source.ProfileID ||
		descriptor.Target.ProfileID != driver.target.ProfileID || targetArtifact.SHA256 != journal.Release.TargetManagerSHA256 ||
		descriptor.Target.Manager.Version != journal.Release.TargetManagerVersion || descriptor.Target.Compose.SHA256 != journal.Release.TargetComposeSHA256 ||
		sourceArtifact.SHA256 != journal.Source.StableSHA256 || descriptor.Source.Compose.SHA256 != journal.Source.ComposeSHA256 ||
		!reflect.DeepEqual(bundle.sourceManifest.Manager, descriptor.Source.Manager) || bundle.sourceManifest.Compose != descriptor.Source.Compose ||
		bundle.sourceManifest.DatabaseSchemaVersion != bundle.bridgeManifest.DatabaseSchemaVersion {
		return errors.New("recovery bundle manifests differ from the immutable handoff binding")
	}
	return nil
}

func (driver *Driver) stageRecoveryBundle(journal handoff.Journal, bundle recoveryBundle) error {
	rootFD, err := openAbsolute(driver.store.Root(), true)
	if err != nil {
		return fmt.Errorf("open handoff root for recovery bundle: %w", err)
	}
	defer syscall.Close(rootFD)
	if err := requireExactOwnerDirectoryFD(rootFD); err != nil {
		return err
	}
	txFD, err := syscall.Openat(rootFD, journal.TransactionID, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return fmt.Errorf("open handoff transaction for recovery bundle: %w", err)
	}
	defer syscall.Close(txFD)
	if err := requireExactOwnerDirectoryFD(txFD); err != nil {
		return err
	}
	bundleFD, err := ensureOwnerDirectoryAt(txFD, handoff.RecoveryBundleDirectory)
	if err != nil {
		return fmt.Errorf("prepare recovery bundle: %w", err)
	}
	defer syscall.Close(bundleFD)
	sourceFD, err := ensureOwnerDirectoryAt(bundleFD, handoff.RecoverySourceDirectory)
	if err != nil {
		return err
	}
	defer syscall.Close(sourceFD)
	bridgeFD, err := ensureOwnerDirectoryAt(bundleFD, handoff.RecoveryBridgeDirectory)
	if err != nil {
		return err
	}
	defer syscall.Close(bridgeFD)
	files := []struct {
		fd       int
		path     string
		name     string
		data     []byte
		expected string
		limit    int64
	}{
		{sourceFD, bundle.paths.SourceManifest, handoff.RecoveryManifestName, bundle.sourceManifestRaw, journal.Source.ManifestSHA256, recoveryManifestLimit},
		{sourceFD, bundle.paths.SourceCompose, handoff.RecoveryComposeName, bundle.sourceCompose, journal.Source.ComposeSHA256, recoveryComposeLimit},
		{bridgeFD, bundle.paths.BridgeManifest, handoff.RecoveryManifestName, bundle.bridgeManifestRaw, journal.Release.ManifestSHA256, recoveryManifestLimit},
		{bridgeFD, bundle.paths.BridgeCompose, handoff.RecoveryComposeName, bundle.bridgeCompose, journal.Release.TargetComposeSHA256, recoveryComposeLimit},
	}
	for _, file := range files {
		if err := stageRecoveryFile(file.fd, file.path, file.name, file.data, file.expected, file.limit); err != nil {
			return err
		}
	}
	for _, fd := range []int{sourceFD, bridgeFD, bundleFD, txFD} {
		if err := syscall.Fsync(fd); err != nil {
			return fmt.Errorf("sync recovery bundle directory: %w", err)
		}
	}
	return nil
}

func stageRecoveryFile(directoryFD int, path, name string, data []byte, expected string, limit int64) error {
	if int64(len(data)) > limit || digestBytes(data) != expected {
		return fmt.Errorf("recovery bundle input %s differs from its binding", name)
	}
	temporary := "." + name + ".staging"
	if err := cleanupRecoveryTemporary(directoryFD, temporary); err != nil {
		return fmt.Errorf("clean recovery bundle staging file %s: %w", name, err)
	}
	if existing, err := inspectRegular(path, limit, true); err == nil {
		if existing.mode != recoveryFileMode || existing.sha256 != expected {
			return fmt.Errorf("existing recovery bundle file %s conflicts with its binding", name)
		}
		return nil
	} else if !errors.Is(unwrapPathError(err), syscall.ENOENT) {
		return fmt.Errorf("inspect recovery bundle file %s: %w", name, err)
	}
	fd, err := syscall.Openat(directoryFD, temporary, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, recoveryFileMode)
	if err != nil {
		return err
	}
	file := os.NewFile(uintptr(fd), temporary)
	if file == nil {
		_ = syscall.Close(fd)
		return errors.New("create recovery bundle file returned an invalid descriptor")
	}
	created, err := statFile(file)
	if err != nil {
		_ = file.Close()
		return err
	}
	committed := false
	defer func() {
		_ = file.Close()
		if !committed {
			_ = unlinkIfIdentity(directoryFD, temporary, created)
		}
	}()
	if created.Mode&syscall.S_IFMT != syscall.S_IFREG || created.Uid != uint32(os.Getuid()) ||
		created.Nlink != 1 || created.Mode&0o777 != recoveryFileMode {
		return errors.New("new recovery bundle staging file has an unsafe identity")
	}
	if err := writeAll(file, data); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := renameAtNoReplace(directoryFD, temporary, name); err != nil {
		if errors.Is(err, syscall.EEXIST) {
			if existing, inspectErr := inspectRegular(path, limit, true); inspectErr == nil && existing.mode == recoveryFileMode && existing.sha256 == expected {
				_ = unlinkIfIdentity(directoryFD, temporary, created)
				committed = true
				return nil
			}
		}
		return err
	}
	committed = true
	return syscall.Fsync(directoryFD)
}

func cleanupRecoveryTemporary(directoryFD int, name string) error {
	observed, err := lstatAt(directoryFD, name)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if observed.Mode&syscall.S_IFMT != syscall.S_IFREG || observed.Uid != uint32(os.Getuid()) ||
		observed.Nlink != 1 || observed.Mode&0o777 != recoveryFileMode {
		return errors.New("existing recovery bundle staging file has an unsafe identity")
	}
	return unlinkIfIdentity(directoryFD, name, observed)
}

func requireClosedRecoveryDirectory(path string, expected []string, directories bool) error {
	fd, err := openAbsolute(path, true)
	if err != nil {
		return err
	}
	file := os.NewFile(uintptr(fd), path)
	if file == nil {
		_ = syscall.Close(fd)
		return errors.New("open recovery directory returned an invalid descriptor")
	}
	defer file.Close()
	if err := requireExactOwnerDirectoryFD(fd); err != nil {
		return err
	}
	entries, err := file.Readdirnames(-1)
	if err != nil {
		return err
	}
	want := make(map[string]struct{}, len(expected))
	for _, name := range expected {
		want[name] = struct{}{}
	}
	if len(entries) != len(want) {
		return errors.New("recovery bundle directory has an unexpected entry count")
	}
	for _, name := range entries {
		if _, ok := want[name]; !ok {
			return fmt.Errorf("recovery bundle directory contains unknown entry %q", name)
		}
		stat, err := lstatAt(fd, name)
		if err != nil {
			return err
		}
		kind := uint32(syscall.S_IFREG)
		if directories {
			kind = syscall.S_IFDIR
		}
		if stat.Mode&syscall.S_IFMT != kind || stat.Uid != uint32(os.Getuid()) || (!directories && stat.Nlink != 1) {
			return fmt.Errorf("recovery bundle entry %q has an unsafe identity", name)
		}
	}
	return nil
}
