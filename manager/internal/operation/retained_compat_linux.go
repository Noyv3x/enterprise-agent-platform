//go:build linux

package operation

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"syscall"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

const (
	retainedManifestLimit    = 1 << 20
	retainedComposeLimit     = 5 << 20
	retainedEnvironmentLimit = 1 << 20
)

type retainedDirectoryIdentity struct {
	device uint64
	inode  uint64
	uid    uint32
	mode   uint32
}

// loadRetainedSourceCompatibility accepts one deliberately fixed historical
// release. Authority comes from the local source-profile journal and pinned
// owner-controlled release directory, never from remote or Candidate bytes.
func (o *Orchestrator) loadRetainedSourceCompatibility(generation *model.Generation, slot retainedGenerationSlot) (release.Manifest, error) {
	if generation == nil || o.Store == nil {
		return release.Manifest{}, errors.New("retained source predecessor has no authoritative journal binding")
	}
	profile, err := o.TechnicalProfile.Profile()
	if err != nil || !reflect.DeepEqual(profile, identity.SourceProfile()) {
		return release.Manifest{}, errors.New("retained source predecessor is available only to the source technical profile")
	}
	if !canonicalRetainedPath(o.DataRoot) {
		return release.Manifest{}, errors.New("source data root is not canonical and absolute")
	}
	expectedReleases := filepath.Join(profile.ManagerStateRoot(o.DataRoot), "releases")
	if !canonicalRetainedPath(o.ReleasesDir) || o.ReleasesDir != expectedReleases {
		return release.Manifest{}, errors.New("release root is not the canonical source-profile directory")
	}
	if generation.ID != contract.SourceOwnerCompatGeneration || generation.SourceCommit != contract.SourceOwnerCompatGeneration {
		return release.Manifest{}, errors.New("retained generation is not the fixed source predecessor")
	}
	expectedManifestPath := filepath.Join(expectedReleases, contract.SourceOwnerCompatGeneration, "manifest.json")
	if generation.ManifestPath != expectedManifestPath {
		return release.Manifest{}, errors.New("retained manifest path is not canonical")
	}
	if err := o.requireAuthoritativeRetainedGeneration(generation, slot); err != nil {
		return release.Manifest{}, err
	}

	releasesFD, releasesIdentity, err := openRetainedDirectoryAbsolute(expectedReleases)
	if err != nil {
		return release.Manifest{}, fmt.Errorf("open retained release root: %w", err)
	}
	defer syscall.Close(releasesFD)
	if err := requireOwnerRetainedDirectory(releasesIdentity); err != nil {
		return release.Manifest{}, fmt.Errorf("validate retained release root: %w", err)
	}
	generationFD, generationIdentity, err := openRetainedChildDirectory(releasesFD, contract.SourceOwnerCompatGeneration)
	if err != nil {
		return release.Manifest{}, fmt.Errorf("open retained generation: %w", err)
	}
	defer syscall.Close(generationFD)
	if err := requireOwnerRetainedDirectory(generationIdentity); err != nil {
		return release.Manifest{}, fmt.Errorf("validate retained generation: %w", err)
	}

	entriesBefore, err := retainedDirectoryEntries(generationFD)
	if err != nil {
		return release.Manifest{}, fmt.Errorf("enumerate retained generation: %w", err)
	}
	if err := validateRetainedEntries(entriesBefore); err != nil {
		return release.Manifest{}, err
	}
	manifestBytes, err := readRetainedRegularAt(generationFD, "manifest.json", retainedManifestLimit)
	if err != nil {
		return release.Manifest{}, fmt.Errorf("read retained manifest: %w", err)
	}
	composeBytes, err := readRetainedRegularAt(generationFD, "compose.yaml", retainedComposeLimit)
	if err != nil {
		return release.Manifest{}, fmt.Errorf("read retained Compose artifact: %w", err)
	}
	if retainedEntryPresent(entriesBefore, "compose.env") {
		if _, err := readRetainedRegularAt(generationFD, "compose.env", retainedEnvironmentLimit); err != nil {
			return release.Manifest{}, fmt.Errorf("read retained Compose environment: %w", err)
		}
	}
	entriesAfter, err := retainedDirectoryEntries(generationFD)
	if err != nil || !reflect.DeepEqual(entriesBefore, entriesAfter) {
		return release.Manifest{}, errors.New("retained generation entries changed while they were inspected")
	}

	manifest, err := release.DecodeRetainedHandoffPredecessorManifest(manifestBytes, o.Channel, runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return release.Manifest{}, err
	}
	composeDigest := sha256.Sum256(composeBytes)
	if hex.EncodeToString(composeDigest[:]) != contract.SourceOwnerCompatComposeSHA256 ||
		manifest.Compose.SHA256 != contract.SourceOwnerCompatComposeSHA256 {
		return release.Manifest{}, errors.New("retained source predecessor Compose checksum is not canonical")
	}
	if manifest.ID() != generation.ID || manifest.SourceCommit != generation.SourceCommit ||
		manifest.DatabaseSchemaVersion != generation.DatabaseVersion || !reflect.DeepEqual(manifest.Images, generation.Images) {
		return release.Manifest{}, errors.New("retained source predecessor differs from its journal generation")
	}

	if err := verifyRetainedDirectoryPath(expectedReleases, releasesIdentity); err != nil {
		return release.Manifest{}, err
	}
	if err := verifyRetainedChildDirectory(releasesFD, contract.SourceOwnerCompatGeneration, generationIdentity); err != nil {
		return release.Manifest{}, err
	}
	if err := o.requireAuthoritativeRetainedGeneration(generation, slot); err != nil {
		return release.Manifest{}, err
	}
	return manifest, nil
}

func (o *Orchestrator) requireAuthoritativeRetainedGeneration(generation *model.Generation, slot retainedGenerationSlot) error {
	state := o.Store.State()
	var authoritative *model.Generation
	switch slot {
	case retainedGenerationCurrent:
		authoritative = state.Current
	case retainedGenerationPrevious:
		authoritative = state.Previous
	default:
		return errors.New("retained generation slot is not authorized")
	}
	if authoritative == nil || !reflect.DeepEqual(authoritative, generation) {
		return errors.New("retained generation is not the authoritative journal slot")
	}
	return nil
}

func canonicalRetainedPath(path string) bool {
	return path != "" && filepath.IsAbs(path) && filepath.Clean(path) == path
}

func openRetainedDirectoryAbsolute(path string) (int, retainedDirectoryIdentity, error) {
	if !canonicalRetainedPath(path) || path == string(filepath.Separator) {
		return -1, retainedDirectoryIdentity{}, errors.New("directory path must be non-root, canonical and absolute")
	}
	fd, err := syscall.Open(string(filepath.Separator), syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return -1, retainedDirectoryIdentity{}, err
	}
	for _, component := range strings.Split(strings.TrimPrefix(path, string(filepath.Separator)), string(filepath.Separator)) {
		next, openErr := syscall.Openat(fd, component, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
		_ = syscall.Close(fd)
		if openErr != nil {
			return -1, retainedDirectoryIdentity{}, fmt.Errorf("open path component %q without following links: %w", component, openErr)
		}
		fd = next
	}
	identity, err := retainedDirectoryStat(fd)
	if err != nil {
		_ = syscall.Close(fd)
		return -1, retainedDirectoryIdentity{}, err
	}
	return fd, identity, nil
}

func openRetainedChildDirectory(parentFD int, name string) (int, retainedDirectoryIdentity, error) {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\x00") {
		return -1, retainedDirectoryIdentity{}, errors.New("retained directory name is invalid")
	}
	fd, err := syscall.Openat(parentFD, name, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return -1, retainedDirectoryIdentity{}, err
	}
	identity, err := retainedDirectoryStat(fd)
	if err != nil {
		_ = syscall.Close(fd)
		return -1, retainedDirectoryIdentity{}, err
	}
	return fd, identity, nil
}

func retainedDirectoryStat(fd int) (retainedDirectoryIdentity, error) {
	var stat syscall.Stat_t
	if err := syscall.Fstat(fd, &stat); err != nil {
		return retainedDirectoryIdentity{}, err
	}
	if stat.Mode&syscall.S_IFMT != syscall.S_IFDIR {
		return retainedDirectoryIdentity{}, errors.New("retained path is not a directory")
	}
	return retainedDirectoryIdentity{device: uint64(stat.Dev), inode: stat.Ino, uid: stat.Uid, mode: stat.Mode}, nil
}

func requireOwnerRetainedDirectory(identity retainedDirectoryIdentity) error {
	if identity.uid != uint32(os.Getuid()) || identity.mode&0o7777 != 0o700 {
		return errors.New("directory must be owned by the current account with mode 0700")
	}
	return nil
}

func retainedDirectoryEntries(fd int) ([]string, error) {
	duplicate, err := syscall.Openat(fd, ".", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(duplicate), "retained-generation")
	if file == nil {
		_ = syscall.Close(duplicate)
		return nil, errors.New("duplicate retained generation descriptor failed")
	}
	defer file.Close()
	entries, err := file.Readdirnames(-1)
	if err != nil {
		return nil, err
	}
	sort.Strings(entries)
	return entries, nil
}

func validateRetainedEntries(entries []string) error {
	allowed := map[string]bool{"manifest.json": false, "compose.yaml": false, "compose.env": false}
	for _, name := range entries {
		if _, ok := allowed[name]; !ok {
			return fmt.Errorf("unknown file in retained source predecessor directory: %s", name)
		}
		allowed[name] = true
	}
	if !allowed["manifest.json"] || !allowed["compose.yaml"] {
		return errors.New("retained source predecessor artifacts are incomplete")
	}
	return nil
}

func retainedEntryPresent(entries []string, name string) bool {
	index := sort.SearchStrings(entries, name)
	return index < len(entries) && entries[index] == name
}

func readRetainedRegularAt(directoryFD int, name string, limit int64) ([]byte, error) {
	if limit <= 0 || name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\x00") {
		return nil, errors.New("retained artifact request is invalid")
	}
	fd, err := syscall.Openat(directoryFD, name, syscall.O_RDONLY|syscall.O_NONBLOCK|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), name)
	if file == nil {
		_ = syscall.Close(fd)
		return nil, errors.New("open retained artifact returned an invalid descriptor")
	}
	defer file.Close()
	var before syscall.Stat_t
	if err := syscall.Fstat(fd, &before); err != nil {
		return nil, err
	}
	permissions := os.FileMode(before.Mode).Perm()
	if before.Mode&syscall.S_IFMT != syscall.S_IFREG || before.Uid != uint32(os.Getuid()) || before.Nlink != 1 ||
		permissions&0o077 != 0 || permissions&0o400 == 0 || before.Mode&(syscall.S_ISUID|syscall.S_ISGID|syscall.S_ISVTX) != 0 ||
		before.Size < 0 || before.Size > limit {
		return nil, errors.New("retained artifact is not an owner-only single-link regular file within its size limit")
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) != before.Size || int64(len(data)) > limit {
		return nil, errors.New("retained artifact size changed while it was read")
	}
	var after syscall.Stat_t
	if err := syscall.Fstat(fd, &after); err != nil {
		return nil, err
	}
	if before.Dev != after.Dev || before.Ino != after.Ino || before.Mode != after.Mode || before.Nlink != after.Nlink ||
		before.Uid != after.Uid || before.Gid != after.Gid || before.Size != after.Size {
		return nil, errors.New("retained artifact identity changed while it was read")
	}
	pathFD, err := syscall.Openat(directoryFD, name, syscall.O_RDONLY|syscall.O_NONBLOCK|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, errors.New("retained artifact path identity changed while it was read")
	}
	var pathStat syscall.Stat_t
	pathErr := syscall.Fstat(pathFD, &pathStat)
	_ = syscall.Close(pathFD)
	if pathErr != nil || before.Dev != pathStat.Dev || before.Ino != pathStat.Ino || before.Mode != pathStat.Mode ||
		before.Nlink != pathStat.Nlink || before.Uid != pathStat.Uid || before.Gid != pathStat.Gid || before.Size != pathStat.Size {
		return nil, errors.New("retained artifact path identity changed while it was read")
	}
	return data, nil
}

func verifyRetainedDirectoryPath(path string, expected retainedDirectoryIdentity) error {
	fd, actual, err := openRetainedDirectoryAbsolute(path)
	if err != nil {
		return errors.New("retained release root path identity changed")
	}
	_ = syscall.Close(fd)
	if actual != expected {
		return errors.New("retained release root path identity changed")
	}
	return nil
}

func verifyRetainedChildDirectory(parentFD int, name string, expected retainedDirectoryIdentity) error {
	fd, actual, err := openRetainedChildDirectory(parentFD, name)
	if err != nil {
		return errors.New("retained generation path identity changed")
	}
	_ = syscall.Close(fd)
	if actual != expected {
		return errors.New("retained generation path identity changed")
	}
	return nil
}
