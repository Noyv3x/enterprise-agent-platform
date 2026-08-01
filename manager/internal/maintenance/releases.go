package maintenance

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

const (
	maxManifestBytes = 1 << 20
	maxComposeBytes  = 5 << 20
)

type ImagePruner interface {
	PruneManagedImages(context.Context, []string, map[string]struct{}, RemovalGuard) (map[string]bool, error)
}

// RemovalGuard is called only after slow candidate validation. A successful
// guard keeps the admission lock until its returned release function is
// invoked, so publication cannot race the exact destructive boundary.
type RemovalGuard = release.RemovalGuard

type ReleasePolicy struct {
	Root            string
	Channel         string
	Profile         identity.ActiveProfile
	Retention       time.Duration
	ProtectedIDs    map[string]struct{}
	ProtectedImages map[string]struct{}
	HeldImages      map[string]struct{}
	Images          ImagePruner
	RemovalGuard    RemovalGuard
}

type verifiedRelease struct {
	path     string
	manifest release.Manifest
	images   []string
}

// PruneReleases removes only expired immutable release directories whose
// manifest and Compose checksum are valid and whose managed image digests are
// either protected elsewhere or have been removed without force. Unknown,
// malformed and runtime-held generations remain untouched.
func PruneReleases(ctx context.Context, now time.Time, policy ReleasePolicy) (int, error) {
	active := policy.Profile
	if active.Validate() != nil {
		// The zero value is deliberately source-only. It preserves conservative
		// cleanup behavior for old internal callers while never granting access to
		// target-only schema v2; production wiring always supplies the routed value.
		active = identity.SourceActiveProfile()
	}
	retention := policy.Retention
	if retention <= 0 {
		retention = 7 * 24 * time.Hour
	}
	entries, err := os.ReadDir(policy.Root)
	if os.IsNotExist(err) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	candidates := make([]verifiedRelease, 0)
	staging := make([]string, 0)
	allImages := map[string]struct{}{}
	protectedImages := cloneStringSet(policy.ProtectedImages)
	var pruneErr error
	for _, entry := range entries {
		select {
		case <-ctx.Done():
			return 0, errors.Join(ctx.Err(), pruneErr)
		default:
		}
		if validReleaseStagingName(entry.Name()) && entry.Type()&os.ModeSymlink == 0 && entry.IsDir() {
			info, infoErr := entry.Info()
			path := filepath.Join(policy.Root, entry.Name())
			if infoErr == nil && now.Sub(info.ModTime()) > retention && validateReleaseStaging(path) == nil {
				staging = append(staging, path)
			}
			continue
		}
		if entry.Type()&os.ModeSymlink != 0 || !entry.IsDir() || !validCommit(entry.Name()) {
			continue
		}
		if _, keep := policy.ProtectedIDs[entry.Name()]; keep {
			continue
		}
		path := filepath.Join(policy.Root, entry.Name())
		containsAtomicResidue, residueScanErr := releaseContainsAtomicResidue(path)
		if residueScanErr != nil {
			pruneErr = errors.Join(pruneErr, fmt.Errorf("inspect release %s for atomic residues: %w", entry.Name(), residueScanErr))
			protectReleaseCoreImages(path, entry.Name(), policy.Channel, active, protectedImages)
			continue
		}
		if containsAtomicResidue {
			directoryInfo, infoErr := entry.Info()
			if infoErr != nil {
				pruneErr = errors.Join(pruneErr, fmt.Errorf("inspect release %s directory identity before atomic cleanup: %w", entry.Name(), infoErr))
				protectReleaseCoreImages(path, entry.Name(), policy.Channel, active, protectedImages)
				continue
			}
			result, admitted, cleanupErr := cleanupReleaseAtomicResidues(path, entry.Name(), directoryInfo, now, retention, policy.RemovalGuard)
			if cleanupErr != nil {
				pruneErr = errors.Join(pruneErr, fmt.Errorf("clean release %s atomic residues: %w", entry.Name(), cleanupErr))
				protectReleaseCoreImages(path, entry.Name(), policy.Channel, active, protectedImages)
				continue
			}
			if !admitted || result.Retained != 0 {
				protectReleaseCoreImages(path, entry.Name(), policy.Channel, active, protectedImages)
				continue
			}
		}
		item, verifyErr := verifyRelease(path, entry.Name(), policy.Channel, active)
		if verifyErr != nil {
			protectReleaseCoreImages(path, entry.Name(), policy.Channel, active, protectedImages)
			continue
		}
		if item.manifest.GeneratedAt.IsZero() || now.Sub(item.manifest.GeneratedAt) <= retention {
			protectImages(item.images, protectedImages)
			continue
		}
		held := false
		for _, image := range item.images {
			if _, isHeld := policy.HeldImages[image]; isHeld {
				held = true
				break
			}
		}
		if held {
			protectImages(item.images, protectedImages)
			continue
		}
		for _, image := range item.images {
			allImages[image] = struct{}{}
		}
		candidates = append(candidates, item)
	}
	removed := 0
	for _, path := range staging {
		select {
		case <-ctx.Done():
			return removed, errors.Join(ctx.Err(), pruneErr)
		default:
		}
		if err := validateReleaseStaging(path); err != nil {
			continue
		}
		releaseGuard := func() {}
		if policy.RemovalGuard != nil {
			var ok bool
			releaseGuard, ok = policy.RemovalGuard()
			if !ok {
				continue
			}
		}
		err := os.RemoveAll(path)
		releaseGuard()
		if err != nil {
			pruneErr = errors.Join(pruneErr, fmt.Errorf("remove abandoned release staging %s: %w", filepath.Base(path), err))
			continue
		}
		removed++
	}
	if len(candidates) > 0 && policy.Images != nil {
		images := make([]string, 0, len(allImages))
		for image := range allImages {
			images = append(images, image)
		}
		sort.Strings(images)
		disposition, imageErr := policy.Images.PruneManagedImages(ctx, images, protectedImages, policy.RemovalGuard)
		pruneErr = errors.Join(pruneErr, imageErr)
		for _, item := range candidates {
			safe := true
			for _, image := range item.images {
				if !disposition[image] {
					safe = false
					break
				}
			}
			if !safe {
				continue
			}
			rechecked, verifyErr := verifyRelease(item.path, item.manifest.ID(), policy.Channel, active)
			if verifyErr != nil || !sameStrings(rechecked.images, item.images) || rechecked.manifest.Compose.SHA256 != item.manifest.Compose.SHA256 {
				continue
			}
			releaseGuard := func() {}
			if policy.RemovalGuard != nil {
				var ok bool
				releaseGuard, ok = policy.RemovalGuard()
				if !ok {
					continue
				}
			}
			err := os.RemoveAll(rechecked.path)
			releaseGuard()
			if err != nil {
				pruneErr = errors.Join(pruneErr, fmt.Errorf("remove obsolete release %s: %w", item.manifest.ID(), err))
				continue
			}
			removed++
		}
	}
	if removed > 0 {
		if err := syncDirectory(policy.Root); err != nil {
			pruneErr = errors.Join(pruneErr, fmt.Errorf("sync release root after cleanup: %w", err))
		}
	}
	return removed, pruneErr
}

// releaseContainsAtomicResidue is an advisory, non-destructive prefilter. The
// authoritative directory and candidate checks happen again after the
// maintenance admission guard is held by cleanupReleaseAtomicResidues.
func releaseContainsAtomicResidue(path string) (bool, error) {
	contents, err := os.ReadDir(path)
	if err != nil {
		return false, err
	}
	for _, content := range contents {
		if strings.HasPrefix(content.Name(), ".tmp-") {
			return true, nil
		}
	}
	return false, nil
}

func cleanupReleaseAtomicResidues(
	path string,
	expectedID string,
	expectedDirectory os.FileInfo,
	now time.Time,
	grace time.Duration,
	guard RemovalGuard,
) (atomicfile.ManagedTempCleanupResult, bool, error) {
	var empty atomicfile.ManagedTempCleanupResult
	if !validCommit(expectedID) || path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path || filepath.Base(path) != expectedID {
		return empty, false, errors.New("release atomic cleanup path is not an absolute canonical generation directory")
	}
	if expectedDirectory == nil || !expectedDirectory.IsDir() || expectedDirectory.Mode()&os.ModeSymlink != 0 {
		return empty, false, errors.New("release atomic cleanup directory identity is invalid")
	}
	if guard == nil {
		return empty, false, errors.New("release atomic cleanup requires a maintenance removal guard")
	}
	releaseAdmission, ok := guard()
	if !ok {
		return empty, false, nil
	}
	if releaseAdmission == nil {
		return empty, false, errors.New("release atomic cleanup guard returned a nil release function")
	}
	defer releaseAdmission()

	pathInfo, err := os.Lstat(path)
	if err != nil {
		return empty, true, fmt.Errorf("inspect release atomic cleanup directory: %w", err)
	}
	if !os.SameFile(expectedDirectory, pathInfo) {
		return empty, true, errors.New("release atomic cleanup directory changed before admission")
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return empty, true, fmt.Errorf("open release atomic cleanup directory: %w", err)
	}
	directory := os.NewFile(uintptr(fd), path)
	if directory == nil {
		_ = syscall.Close(fd)
		return empty, true, errors.New("open release atomic cleanup directory: invalid file descriptor")
	}
	openedInfo, err := directory.Stat()
	if err != nil {
		_ = directory.Close()
		return empty, true, fmt.Errorf("inspect opened release atomic cleanup directory: %w", err)
	}
	if !os.SameFile(expectedDirectory, openedInfo) || !os.SameFile(pathInfo, openedInfo) {
		_ = directory.Close()
		return empty, true, errors.New("release atomic cleanup directory changed while it was opened")
	}

	result, cleanupErr := atomicfile.CleanupManagedTemps(directory, path, atomicfile.ManagedTempCleanupPolicy{
		Now:   now,
		Grace: grace,
		DurableReferences: []string{
			filepath.Join(path, "manifest.json"),
			filepath.Join(path, "compose.yaml"),
			filepath.Join(path, "compose.env"),
		},
	})
	closeErr := directory.Close()
	if cleanupErr != nil {
		return result, true, cleanupErr
	}
	if closeErr != nil {
		return result, true, fmt.Errorf("close release atomic cleanup directory: %w", closeErr)
	}
	return result, true, nil
}

func validReleaseStagingName(name string) bool {
	const prefix = ".release-"
	if !strings.HasPrefix(name, prefix) {
		return false
	}
	remainder := strings.TrimPrefix(name, prefix)
	if len(remainder) < 42 || !validCommit(remainder[:40]) || remainder[40] != '-' {
		return false
	}
	for _, character := range remainder[41:] {
		if character < '0' || character > '9' {
			return false
		}
	}
	return len(remainder[41:]) > 0
}

func validateReleaseStaging(path string) error {
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || !validReleaseStagingName(filepath.Base(path)) {
		return errors.New("release staging path is not a recognized regular directory")
	}
	contents, err := os.ReadDir(path)
	if err != nil {
		return err
	}
	limits := map[string]int64{"manifest.json": maxManifestBytes, "compose.yaml": maxComposeBytes}
	for _, content := range contents {
		limit, ok := limits[content.Name()]
		if !ok {
			return fmt.Errorf("unknown file in release staging directory: %s", content.Name())
		}
		if _, err := readRegularFile(filepath.Join(path, content.Name()), limit); err != nil {
			return err
		}
	}
	return nil
}

func verifyRelease(path, expectedID, channel string, active identity.ActiveProfile) (verifiedRelease, error) {
	item, err := verifyReleaseCore(path, expectedID, channel, active)
	if err != nil {
		return verifiedRelease{}, err
	}
	contents, err := os.ReadDir(path)
	if err != nil {
		return verifiedRelease{}, err
	}
	allowed := map[string]struct{}{"manifest.json": {}, "compose.yaml": {}, "compose.env": {}}
	for _, content := range contents {
		if _, ok := allowed[content.Name()]; !ok {
			return verifiedRelease{}, fmt.Errorf("unknown file in release directory: %s", content.Name())
		}
		if content.Name() == "compose.env" {
			if _, err := readRegularFile(filepath.Join(path, content.Name()), maxManifestBytes); err != nil {
				return verifiedRelease{}, fmt.Errorf("validate release Compose environment: %w", err)
			}
		}
	}
	return item, nil
}

func verifyReleaseCore(path, expectedID, channel string, active identity.ActiveProfile) (verifiedRelease, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return verifiedRelease{}, errors.New("release path is not a regular directory")
	}
	manifestPath := filepath.Join(path, "manifest.json")
	manifestData, err := readRegularFile(manifestPath, maxManifestBytes)
	if err != nil {
		return verifiedRelease{}, err
	}
	manifest, err := release.DecodeManifestForProfile(manifestData, channel, runtime.GOOS, runtime.GOARCH, active)
	if err != nil {
		return verifiedRelease{}, err
	}
	if manifest.ID() != expectedID {
		return verifiedRelease{}, errors.New("release identity does not match its directory")
	}
	compose, err := readRegularFile(filepath.Join(path, "compose.yaml"), maxComposeBytes)
	if err != nil {
		return verifiedRelease{}, err
	}
	digest := sha256.Sum256(compose)
	if hex.EncodeToString(digest[:]) != manifest.Compose.SHA256 {
		return verifiedRelease{}, errors.New("release Compose checksum mismatch")
	}
	images := make([]string, 0, len(manifest.Images))
	for name, image := range manifest.Images {
		if release.IsManagedImageName(name) {
			images = append(images, image)
		}
	}
	sort.Strings(images)
	return verifiedRelease{path: path, manifest: manifest, images: images}, nil
}

func cloneStringSet(source map[string]struct{}) map[string]struct{} {
	result := make(map[string]struct{}, len(source))
	for value := range source {
		result[value] = struct{}{}
	}
	return result
}

func protectImages(images []string, protected map[string]struct{}) {
	for _, image := range images {
		protected[image] = struct{}{}
	}
}

func protectReleaseCoreImages(path, expectedID, channel string, active identity.ActiveProfile, protected map[string]struct{}) {
	item, err := verifyReleaseCore(path, expectedID, channel, active)
	if err == nil {
		protectImages(item.images, protected)
	}
}

func sameStrings(left, right []string) bool {
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

func readRegularFile(path string, limit int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() < 0 || info.Size() > limit {
		return nil, errors.New("release artifact is not a bounded regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return io.ReadAll(io.LimitReader(file, limit+1))
}

func validCommit(value string) bool {
	if len(value) != 40 {
		return false
	}
	for _, char := range value {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
