//go:build linux

package handofftransform

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
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"syscall"
)

var metadataTemporaryPattern = regexp.MustCompile(`^(?:\.handoff-staging\.json|handoff-manifest\.json)\.tmp-[0-9a-f]{16}$`)

type cleanupNode struct {
	path string
	rel  string
	info os.FileInfo
	dev  uint64
	ino  uint64
}

func (e Engine) cleanupPrepared(prepared preparedRequest) error {
	if err := e.removePrivilegedResourcesForCleanup(context.Background(), prepared); err != nil {
		return err
	}
	return e.cleanupNativePrepared(prepared)
}

func (e Engine) removePrivilegedResourcesForCleanup(ctx context.Context, prepared preparedRequest) error {
	privileged := make([]Resource, 0)
	for _, resource := range prepared.resources {
		if resource.Access == ContainerOwnedTree {
			privileged = append(privileged, resource)
		}
	}
	if len(privileged) == 0 {
		return nil
	}
	stageInfo, err := os.Lstat(prepared.stage)
	if err != nil {
		return err
	}
	stageStat, ok := stageInfo.Sys().(*syscall.Stat_t)
	if !ok || !stageInfo.IsDir() || stageInfo.Mode()&os.ModeSymlink != 0 || stageStat.Uid != uint32(prepared.uid) || stageInfo.Mode().Perm()&0o022 != 0 {
		return errors.New("handoff staging root is not a safe transaction-owned directory")
	}
	var marker stagingMarker
	if err := readStrictOwnerJSON(filepath.Join(prepared.stage, markerName), prepared.uid, &marker); err != nil {
		return fmt.Errorf("read handoff staging marker before privileged cleanup: %w", err)
	}
	if !reflect.DeepEqual(marker, prepared.marker) {
		return errors.New("handoff staging marker does not match the immutable privileged cleanup request")
	}
	if err := validatePublicationTree(prepared.stage, prepared.marker.Resources, prepared.uid, prepared.gid); err != nil {
		return fmt.Errorf("validate closed staging tree before privileged cleanup: %w", err)
	}

	published := prepared.stage == prepared.request.TargetRoot
	expected := make(map[string][]Entry)
	var manifest Manifest
	manifestPresent := false
	if err := readStrictOwnerJSON(filepath.Join(prepared.stage, manifestName), prepared.uid, &manifest); err == nil {
		manifestPresent = true
		if manifest.TransactionID != prepared.request.TransactionID || manifest.SourceRoot != prepared.request.SourceRoot || manifest.TargetRoot != prepared.request.TargetRoot {
			return errors.New("handoff manifest differs from the privileged cleanup request")
		}
		for _, evidence := range manifest.Resources {
			expected[evidence.Name] = cloneEntries(evidence.TargetEntries)
		}
	} else if published || !os.IsNotExist(err) {
		return fmt.Errorf("read privileged cleanup manifest: %w", err)
	}

	type removal struct {
		resource Resource
		entries  []Entry
	}
	removals := make([]removal, 0, len(privileged))
	for _, resource := range privileged {
		path := filepath.Join(prepared.stage, filepath.FromSlash(resource.Target))
		if _, err := os.Lstat(path); os.IsNotExist(err) {
			continue
		} else if err != nil {
			return fmt.Errorf("inspect privileged cleanup resource %s: %w", resource.Name, err)
		}
		entries, err := e.inventory(ctx, prepared, resource, path, false)
		if err != nil {
			return fmt.Errorf("inventory privileged cleanup resource %s: %w", resource.Name, err)
		}
		if want := expected[resource.Name]; !published && len(want) != 0 && !entriesEqual(want, entries) {
			return fmt.Errorf("privileged staging resource %s differs from its durable manifest", resource.Name)
		}
		removals = append(removals, removal{resource: resource, entries: entries})
	}
	markerDigest, err := metadataValueSHA256(marker)
	if err != nil {
		return fmt.Errorf("digest privileged cleanup marker: %w", err)
	}
	proof := PrivilegedRemovalProof{Kind: RemovalStagingMarker, MarkerSHA256: markerDigest}
	if published {
		if !manifestPresent || !sha256Pattern.MatchString(prepared.fenceBindingSHA256) {
			return errors.New("published privileged cleanup lacks manifest or target-writer fence proof")
		}
		manifestDigest, err := metadataValueSHA256(manifest)
		if err != nil {
			return fmt.Errorf("digest privileged cleanup manifest: %w", err)
		}
		proof = PrivilegedRemovalProof{
			Kind: RemovalFencedPublication, MarkerSHA256: markerDigest,
			ManifestSHA256: manifestDigest, FenceBindingSHA256: prepared.fenceBindingSHA256,
		}
	}
	for _, removal := range removals {
		if err := e.removePrivilegedTree(ctx, prepared, prepared.stage, removal.resource, removal.entries, proof); err != nil {
			return fmt.Errorf("remove privileged resource %s: %w", removal.resource.Name, err)
		}
	}
	return nil
}

func metadataValueSHA256(value any) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	raw = append(raw, '\n')
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:]), nil
}

func (e Engine) cleanupNativePrepared(prepared preparedRequest) error {
	stageInfo, err := os.Lstat(prepared.stage)
	if err != nil {
		return err
	}
	stageStat, ok := stageInfo.Sys().(*syscall.Stat_t)
	if !ok || !stageInfo.IsDir() || stageInfo.Mode()&os.ModeSymlink != 0 || stageStat.Uid != uint32(prepared.uid) || stageInfo.Mode().Perm()&0o022 != 0 {
		return errors.New("handoff staging root is not a safe transaction-owned directory")
	}
	markerPath := filepath.Join(prepared.stage, markerName)
	var marker stagingMarker
	markerPresent := true
	if err := readStrictOwnerJSON(markerPath, prepared.uid, &marker); os.IsNotExist(err) {
		markerPresent = false
	} else if err != nil {
		return fmt.Errorf("read handoff staging marker: %w", err)
	}
	if markerPresent && !reflect.DeepEqual(marker, prepared.marker) {
		return errors.New("handoff staging marker does not match the immutable request")
	}

	nodes := make([]cleanupNode, 0, 32)
	err = filepath.WalkDir(prepared.stage, func(path string, item os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == prepared.stage {
			return nil
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || uint64(stat.Dev) != uint64(stageStat.Dev) {
			return errors.New("staging entry crosses a filesystem boundary")
		}
		relative, err := filepath.Rel(prepared.stage, path)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		owners, expectedType, allowed := cleanupPolicy(relative, prepared.marker.Resources, prepared.uid, prepared.gid, markerPresent)
		if !allowed {
			return fmt.Errorf("unknown file in transaction staging: %s", relative)
		}
		if info.Mode()&os.ModeSymlink != 0 || (!info.IsDir() && !info.Mode().IsRegular()) {
			return fmt.Errorf("unsafe object in transaction staging: %s", relative)
		}
		if !ownerAllowed(uint32(stat.Uid), uint32(stat.Gid), owners) {
			return fmt.Errorf("unexpected owner for transaction staging object %s", relative)
		}
		if info.Mode().IsRegular() && stat.Nlink != 1 {
			return fmt.Errorf("unsafe link count for transaction staging object %s", relative)
		}
		if expectedType != "" {
			if err := validateNodeType(info, expectedType); err != nil {
				return fmt.Errorf("staging object %s: %w", relative, err)
			}
		}
		nodes = append(nodes, cleanupNode{path: path, rel: relative, info: info, dev: uint64(stat.Dev), ino: uint64(stat.Ino)})
		return nil
	})
	if err != nil {
		return err
	}
	if !markerPresent {
		for _, node := range nodes {
			if !metadataTemporaryPattern.MatchString(node.rel) {
				return errors.New("unmarked staging tree is not empty")
			}
		}
	}
	for index := range nodes {
		if !nodes[index].info.IsDir() {
			continue
		}
		if err := os.Chmod(nodes[index].path, 0o700); err != nil {
			return fmt.Errorf("prepare staging directory %s for cleanup: %w", nodes[index].rel, err)
		}
		refreshed, err := os.Lstat(nodes[index].path)
		if err != nil {
			return err
		}
		stat, ok := refreshed.Sys().(*syscall.Stat_t)
		if !ok || uint64(stat.Dev) != nodes[index].dev || uint64(stat.Ino) != nodes[index].ino || !refreshed.IsDir() {
			return fmt.Errorf("staging directory %s changed while preparing cleanup", nodes[index].rel)
		}
		nodes[index].info = refreshed
	}
	sort.Slice(nodes, func(i, j int) bool {
		leftDepth, rightDepth := pathDepth(nodes[i].rel), pathDepth(nodes[j].rel)
		if leftDepth == rightDepth {
			return nodes[i].rel > nodes[j].rel
		}
		return leftDepth > rightDepth
	})
	for _, node := range nodes {
		current, err := os.Lstat(node.path)
		if err != nil {
			return fmt.Errorf("reinspect staging object %s: %w", node.rel, err)
		}
		stat, ok := current.Sys().(*syscall.Stat_t)
		if !ok || uint64(stat.Dev) != node.dev || uint64(stat.Ino) != node.ino || current.Mode() != node.info.Mode() {
			return fmt.Errorf("staging object %s changed during cleanup", node.rel)
		}
		if err := os.Remove(node.path); err != nil {
			return fmt.Errorf("remove staging object %s: %w", node.rel, err)
		}
	}
	currentRoot, err := os.Lstat(prepared.stage)
	if err != nil {
		return err
	}
	currentStat, ok := currentRoot.Sys().(*syscall.Stat_t)
	if !ok || currentStat.Dev != stageStat.Dev || currentStat.Ino != stageStat.Ino || !currentRoot.IsDir() {
		return errors.New("handoff staging root changed during cleanup")
	}
	if err := os.Remove(prepared.stage); err != nil {
		return fmt.Errorf("remove handoff staging root: %w", err)
	}
	return syncDirectory(filepath.Dir(prepared.stage))
}

func cleanupPolicy(relative string, resources []markerResource, uid, gid int, markerPresent bool) ([]Owner, NodeType, bool) {
	defaultOwners := []Owner{{UID: uint32(uid), GID: uint32(gid)}}
	if relative == markerName || relative == manifestName || metadataTemporaryPattern.MatchString(relative) {
		return defaultOwners, RegularFile, true
	}
	if !markerPresent {
		return nil, "", false
	}
	if relative == inputDirectoryName {
		return defaultOwners, Directory, true
	}
	if strings.HasPrefix(relative, inputDirectoryName+"/") {
		return defaultOwners, "", true
	}
	for _, resource := range resources {
		if relative == resource.Target {
			return resource.TargetOwners, resource.Type, true
		}
		if strings.HasPrefix(resource.Target, relative+"/") {
			return defaultOwners, Directory, true
		}
		if resource.Type == Directory && strings.HasPrefix(relative, resource.Target+"/") {
			return resource.TargetOwners, "", true
		}
		if strings.HasPrefix(relative, resource.Target+".tmp-") && validResourceTemporary(relative, resource.Target) {
			return resource.TargetOwners, RegularFile, true
		}
	}
	return nil, "", false
}

func validResourceTemporary(relative, target string) bool {
	suffix := strings.TrimPrefix(relative, target+".tmp-")
	if len(suffix) != 16 {
		return false
	}
	for _, character := range suffix {
		if !(character >= '0' && character <= '9' || character >= 'a' && character <= 'f') {
			return false
		}
	}
	return true
}

func readStrictOwnerJSON(path string, uid int, target any) error {
	descriptor, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return &os.PathError{Op: "open", Path: path, Err: err}
	}
	file := os.NewFile(uintptr(descriptor), path)
	if file == nil {
		syscall.Close(descriptor)
		return errors.New("construct metadata reader")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || stat.Nlink != 1 || stat.Uid != uint32(uid) || info.Mode().Perm()&0o077 != 0 {
		return errors.New("metadata must be an owner-only, unlinked regular file")
	}
	if info.Size() < 1 || info.Size() > maximumMetadataSize {
		return errors.New("metadata size is outside the allowed range")
	}
	raw, err := io.ReadAll(io.LimitReader(file, maximumMetadataSize+1))
	if err != nil {
		return err
	}
	if len(raw) > maximumMetadataSize {
		return errors.New("metadata exceeds the maximum size")
	}
	if err := rejectDuplicateJSONKeys(raw); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := requireJSONEOF(decoder); err != nil {
		return err
	}
	return nil
}

func rejectDuplicateJSONKeys(raw []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := walkJSONValue(decoder); err != nil {
		return err
	}
	return requireJSONEOF(decoder)
}

func walkJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, compound := token.(json.Delim)
	if !compound {
		return nil
	}
	switch delimiter {
	case '{':
		seen := map[string]struct{}{}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("JSON object key is not a string")
			}
			if _, exists := seen[key]; exists {
				return fmt.Errorf("duplicate JSON object key %q", key)
			}
			seen[key] = struct{}{}
			if err := walkJSONValue(decoder); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil || closing != json.Delim('}') {
			return errors.New("invalid JSON object terminator")
		}
	case '[':
		for decoder.More() {
			if err := walkJSONValue(decoder); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil || closing != json.Delim(']') {
			return errors.New("invalid JSON array terminator")
		}
	default:
		return errors.New("invalid JSON delimiter")
	}
	return nil
}

func requireJSONEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("JSON contains trailing data")
		}
		return err
	}
	return nil
}
