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

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

const (
	maxManifestBytes = 1 << 20
	maxComposeBytes  = 5 << 20
)

// ReleasePolicy selects the two committed generations. Callers hold the update
// lifecycle lock and must not run retention while a transaction is unfinished.
type ReleasePolicy struct {
	Root       string
	Channel    string
	Profile    identity.ActiveProfile
	CurrentID  string
	PreviousID string
}

// PruneReleases retains the verified current and previous generations. Unknown
// directories and damaged artifacts are left alone. Docker images are never
// removed: a sandbox may still hold an older release's image.
func PruneReleases(ctx context.Context, policy ReleasePolicy) (int, error) {
	active := policy.Profile
	if active.Validate() != nil {
		active = identity.CompileTimeActiveProfile()
	}
	if !validCommit(policy.CurrentID) || (policy.PreviousID != "" && !validCommit(policy.PreviousID)) {
		return 0, errors.New("retention requires committed release identities")
	}
	for _, id := range []string{policy.CurrentID, policy.PreviousID} {
		if id == "" {
			continue
		}
		if err := verifyRelease(filepath.Join(policy.Root, id), id, policy.Channel, active); err != nil {
			return 0, fmt.Errorf("verify retained release %s: %w", id, err)
		}
	}
	entries, err := os.ReadDir(policy.Root)
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return removed, err
		}
		if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 || !validCommit(entry.Name()) ||
			entry.Name() == policy.CurrentID || entry.Name() == policy.PreviousID {
			continue
		}
		path := filepath.Join(policy.Root, entry.Name())
		plan, err := atomicfile.PlanDirectoryRemoval(path, func() error {
			return verifyRelease(path, entry.Name(), policy.Channel, active)
		})
		if err != nil {
			continue
		}
		if err := plan.Remove(); err != nil {
			return removed, err
		}
		removed++
		if err := syncDirectory(policy.Root); err != nil {
			return removed, err
		}
	}
	return removed, nil
}

func verifyRelease(path, expectedID, channel string, active identity.ActiveProfile) error {
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("release path is not a regular directory")
	}
	contents, err := os.ReadDir(path)
	if err != nil {
		return err
	}
	for _, content := range contents {
		switch content.Name() {
		case "manifest.json", "compose.yaml":
		case "compose.env":
			if _, err := readRegularFile(filepath.Join(path, content.Name()), maxManifestBytes); err != nil {
				return fmt.Errorf("validate release Compose environment: %w", err)
			}
		default:
			return fmt.Errorf("unknown file in release directory: %s", content.Name())
		}
	}
	manifestData, err := readRegularFile(filepath.Join(path, "manifest.json"), maxManifestBytes)
	if err != nil {
		return err
	}
	manifest, err := release.DecodeManifestForProfile(manifestData, channel, runtime.GOOS, runtime.GOARCH, active)
	if err != nil {
		return err
	}
	if manifest.ID() != expectedID {
		return errors.New("release identity does not match its directory")
	}
	compose, err := readRegularFile(filepath.Join(path, "compose.yaml"), maxComposeBytes)
	if err != nil {
		return err
	}
	digest := sha256.Sum256(compose)
	if hex.EncodeToString(digest[:]) != manifest.Compose.SHA256 {
		return errors.New("release Compose checksum mismatch")
	}
	return nil
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
