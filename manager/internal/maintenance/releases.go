package maintenance

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/release"
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
	for _, entry := range entries {
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
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
		item, verifyErr := verifyRelease(filepath.Join(policy.Root, entry.Name()), entry.Name(), policy.Channel)
		if verifyErr != nil {
			continue
		}
		if item.manifest.GeneratedAt.IsZero() || now.Sub(item.manifest.GeneratedAt) <= retention {
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
			continue
		}
		for _, image := range item.images {
			allImages[image] = struct{}{}
		}
		candidates = append(candidates, item)
	}
	removed := 0
	var pruneErr error
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
		disposition, imageErr := policy.Images.PruneManagedImages(ctx, images, policy.ProtectedImages, policy.RemovalGuard)
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
			rechecked, verifyErr := verifyRelease(item.path, item.manifest.ID(), policy.Channel)
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

func verifyRelease(path, expectedID, channel string) (verifiedRelease, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return verifiedRelease{}, errors.New("release path is not a regular directory")
	}
	manifestPath := filepath.Join(path, "manifest.json")
	manifestData, err := readRegularFile(manifestPath, maxManifestBytes)
	if err != nil {
		return verifiedRelease{}, err
	}
	var manifest release.Manifest
	decoder := json.NewDecoder(strings.NewReader(string(manifestData)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return verifiedRelease{}, err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return verifiedRelease{}, errors.New("release manifest contains trailing JSON")
	}
	if manifest.ID() != expectedID {
		return verifiedRelease{}, errors.New("release identity does not match its directory")
	}
	if err := manifest.Validate(channel, runtime.GOOS, runtime.GOARCH); err != nil {
		return verifiedRelease{}, err
	}
	compose, err := readRegularFile(filepath.Join(path, "compose.yaml"), maxComposeBytes)
	if err != nil {
		return verifiedRelease{}, err
	}
	digest := sha256.Sum256(compose)
	if hex.EncodeToString(digest[:]) != manifest.Compose.SHA256 {
		return verifiedRelease{}, errors.New("release Compose checksum mismatch")
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
	images := make([]string, 0, len(manifest.Images))
	for name, image := range manifest.Images {
		if release.IsManagedImageName(name) {
			images = append(images, image)
		}
	}
	sort.Strings(images)
	return verifiedRelease{path: path, manifest: manifest, images: images}, nil
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
