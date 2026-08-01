//go:build linux

package handofftransform

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
)

func inventoryResource(ctx context.Context, resource, root string, expectedType NodeType, owners []Owner) ([]Entry, error) {
	return inventoryResourceFiltered(ctx, resource, root, expectedType, owners, nil)
}

func inventoryResourceFiltered(ctx context.Context, resource, root string, expectedType NodeType, owners []Owner, exclude func(string) bool) ([]Entry, error) {
	rootInfo, err := os.Lstat(root)
	if err != nil {
		return nil, err
	}
	if err := validateNodeType(rootInfo, expectedType); err != nil {
		return nil, err
	}
	rootStat, ok := rootInfo.Sys().(*syscall.Stat_t)
	if !ok {
		return nil, errors.New("resource root filesystem metadata is unavailable")
	}
	entries := make([]Entry, 0, 16)
	err = walkDirectoryBounded(ctx, root, contract.AgentRuntimeMaximumDirectoryEntries, func(path string, info os.FileInfo) (bool, error) {
		relative := displayRelative(root, path)
		if path != root && exclude != nil && exclude(relative) {
			return info.IsDir(), nil
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return false, fmt.Errorf("resource %s contains a symbolic link at %s", resource, displayRelative(root, path))
		}
		entry, err := inspectEntry(path, info, owners, uint64(rootStat.Dev))
		if err != nil {
			return false, fmt.Errorf("resource %s path %s: %w", resource, displayRelative(root, path), err)
		}
		entry.Resource = resource
		entry.Path = displayRelative(root, path)
		if entry.Type == RegularFile {
			digest, err := hashRegularNoFollowBounded(path, info, info.Size())
			if err != nil {
				return false, fmt.Errorf("hash resource %s path %s: %w", resource, entry.Path, err)
			}
			entry.SHA256 = digest
		}
		entries = append(entries, entry)
		return false, nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })
	return entries, nil
}

func walkDirectoryBounded(ctx context.Context, root string, maximumEntries int, visit func(string, os.FileInfo) (bool, error)) error {
	var walk func(string) error
	walk = func(path string) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		before, err := os.Lstat(path)
		if err != nil {
			return err
		}
		skip, err := visit(path, before)
		if err != nil || skip || !before.IsDir() || before.Mode()&os.ModeSymlink != 0 {
			return err
		}
		descriptor, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
		if err != nil {
			return err
		}
		directory := os.NewFile(uintptr(descriptor), path)
		if directory == nil {
			syscall.Close(descriptor)
			return errors.New("construct bounded directory reader")
		}
		opened, statErr := directory.Stat()
		if statErr != nil || !os.SameFile(before, opened) || !opened.IsDir() {
			directory.Close()
			return errors.Join(statErr, errors.New("bounded directory identity changed while opening"))
		}
		children, readErr := directory.ReadDir(maximumEntries + 1)
		closeErr := directory.Close()
		if readErr != nil && !errors.Is(readErr, io.EOF) || closeErr != nil {
			return errors.Join(readErr, closeErr)
		}
		if len(children) > maximumEntries {
			return errors.New("resource directory entry count exceeds the canonical handoff limit")
		}
		sort.Slice(children, func(i, j int) bool { return children[i].Name() < children[j].Name() })
		for _, child := range children {
			if err := walk(filepath.Join(path, child.Name())); err != nil {
				return err
			}
		}
		after, err := os.Lstat(path)
		if err != nil || !sameIdentityAndContentMetadata(before, after) {
			return errors.Join(err, errors.New("resource directory changed during bounded traversal"))
		}
		return nil
	}
	return walk(root)
}

func validateNodeType(info os.FileInfo, expected NodeType) error {
	switch expected {
	case RegularFile:
		if !info.Mode().IsRegular() {
			return errors.New("resource root is not a regular file")
		}
	case Directory:
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("resource root is not a non-symlink directory")
		}
	default:
		return fmt.Errorf("unsupported resource node type %q", expected)
	}
	return nil
}

func inspectEntry(path string, info os.FileInfo, owners []Owner, rootDevice uint64) (Entry, error) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Blocks < 0 || stat.Nlink < 1 {
		return Entry{}, errors.New("filesystem identity metadata is unavailable")
	}
	if uint64(stat.Dev) != rootDevice {
		return Entry{}, errors.New("resource crosses a filesystem or mount boundary")
	}
	if !ownerAllowed(uint32(stat.Uid), uint32(stat.Gid), owners) {
		return Entry{}, fmt.Errorf("owner %d:%d is outside the declared owner set", stat.Uid, stat.Gid)
	}
	entryType := NodeType("")
	switch {
	case info.Mode().IsRegular():
		entryType = RegularFile
		if stat.Nlink != 1 {
			return Entry{}, fmt.Errorf("regular file has unsafe link count %d", stat.Nlink)
		}
	case info.IsDir() && info.Mode()&os.ModeSymlink == 0:
		entryType = Directory
	default:
		return Entry{}, fmt.Errorf("unsupported filesystem object type %s", info.Mode().String())
	}
	blocks := uint64(stat.Blocks)
	if blocks > ^uint64(0)/512 {
		return Entry{}, errors.New("allocated size overflows")
	}
	return Entry{
		Type: entryType, Mode: uint32(info.Mode().Perm()), UID: uint32(stat.Uid), GID: uint32(stat.Gid),
		LinkCount: uint64(stat.Nlink), Size: info.Size(), AllocatedSize: blocks * 512,
		ModifiedNanos: info.ModTime().UnixNano(),
	}, nil
}

func ownerAllowed(uid, gid uint32, owners []Owner) bool {
	for _, owner := range owners {
		if owner.UID == uid && owner.GID == gid {
			return true
		}
	}
	return false
}

func displayRelative(root, path string) string {
	value, err := filepath.Rel(root, path)
	if err != nil || value == "" {
		return "."
	}
	return filepath.ToSlash(value)
}

func hashRegularNoFollow(path string, before os.FileInfo) (string, error) {
	return hashRegularNoFollowBounded(path, before, before.Size())
}

func hashRegularNoFollowBounded(path string, before os.FileInfo, maximum int64) (string, error) {
	if maximum < 0 || before.Size() < 0 || before.Size() > maximum || maximum == int64(^uint64(0)>>1) {
		return "", errors.New("file size exceeds its hash bound")
	}
	descriptor, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return "", err
	}
	file := os.NewFile(uintptr(descriptor), path)
	if file == nil {
		syscall.Close(descriptor)
		return "", errors.New("construct source file handle")
	}
	defer file.Close()
	if err := sameOpenFile(file, before); err != nil {
		return "", err
	}
	hash := sha256.New()
	written, err := io.CopyBuffer(hash, io.LimitReader(file, maximum+1), make([]byte, defaultCopyBuffer))
	if err != nil {
		return "", err
	}
	if written != before.Size() {
		return "", errors.New("file changed or exceeded its exact hash bound")
	}
	after, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if !sameIdentityAndContentMetadata(before, after) {
		return "", errors.New("file changed while hashing")
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func sameOpenFile(file *os.File, expected os.FileInfo) error {
	actual, err := file.Stat()
	if err != nil {
		return err
	}
	if !sameIdentityAndContentMetadata(expected, actual) {
		return errors.New("opened file identity differs from inspected path")
	}
	stat, ok := actual.Sys().(*syscall.Stat_t)
	if !ok || stat.Nlink != 1 || !actual.Mode().IsRegular() {
		return errors.New("opened source is not an unlinked regular file")
	}
	return nil
}

func sameIdentityAndContentMetadata(left, right os.FileInfo) bool {
	leftStat, leftOK := left.Sys().(*syscall.Stat_t)
	rightStat, rightOK := right.Sys().(*syscall.Stat_t)
	return leftOK && rightOK && leftStat.Dev == rightStat.Dev && leftStat.Ino == rightStat.Ino &&
		leftStat.Nlink == rightStat.Nlink && left.Mode() == right.Mode() && left.Size() == right.Size() &&
		left.ModTime().UnixNano() == right.ModTime().UnixNano()
}

func (e Engine) copyFile(ctx context.Context, source, target string, resource Resource, expected []Entry) error {
	if len(expected) != 1 || expected[0].Path != "." || expected[0].Type != RegularFile {
		return errors.New("source file manifest is invalid")
	}
	return e.streamFile(ctx, source, target, expected[0])
}

func (e Engine) copyTree(ctx context.Context, source, target string, resource Resource, expected []Entry) error {
	return e.copyTreeWithTargetOwner(ctx, source, target, resource, expected, nil)
}

func (e Engine) copyTreeWithTargetOwner(ctx context.Context, source, target string, resource Resource, expected []Entry, targetOwner *Owner) error {
	if len(expected) == 0 || expected[0].Path != "." || expected[0].Type != Directory {
		return errors.New("source tree manifest is invalid")
	}
	if err := mkdirExact(target, 0o700, e.effectiveUID()); err != nil {
		return err
	}
	directories := make([]Entry, 0)
	for _, entry := range expected {
		if err := ctx.Err(); err != nil {
			return err
		}
		path := target
		if entry.Path != "." {
			path = filepath.Join(target, filepath.FromSlash(entry.Path))
		}
		sourcePath := source
		if entry.Path != "." {
			sourcePath = filepath.Join(source, filepath.FromSlash(entry.Path))
		}
		switch entry.Type {
		case Directory:
			if entry.Path != "." {
				if err := mkdirExact(path, 0o700, e.effectiveUID()); err != nil {
					return err
				}
			}
			directories = append(directories, entry)
		case RegularFile:
			if err := e.streamFileWithTargetOwner(ctx, sourcePath, path, entry, targetOwner); err != nil {
				return err
			}
		default:
			return fmt.Errorf("unsupported source entry type %q", entry.Type)
		}
	}
	// Finalize directories from leaves to root so no later create operation is
	// affected by a source directory's restrictive or writable mode.
	sort.Slice(directories, func(i, j int) bool {
		return pathDepth(directories[i].Path) > pathDepth(directories[j].Path)
	})
	for _, entry := range directories {
		path := target
		if entry.Path != "." {
			path = filepath.Join(target, filepath.FromSlash(entry.Path))
		}
		uid, gid := int(entry.UID), int(entry.GID)
		if targetOwner != nil {
			uid, gid = int(targetOwner.UID), int(targetOwner.GID)
		}
		if err := os.Chown(path, uid, gid); err != nil {
			return fmt.Errorf("preserve directory owner for %s: %w", entry.Path, err)
		}
		if err := os.Chmod(path, os.FileMode(entry.Mode)); err != nil {
			return err
		}
		when := time.Unix(0, entry.ModifiedNanos)
		if err := os.Chtimes(path, when, when); err != nil {
			return err
		}
		if err := syncDirectory(path); err != nil {
			return err
		}
	}
	return nil
}

func (e Engine) streamFile(ctx context.Context, source, target string, expected Entry) (resultErr error) {
	return e.streamFileWithTargetOwner(ctx, source, target, expected, nil)
}

func (e Engine) streamFileWithTargetOwner(ctx context.Context, source, target string, expected Entry, targetOwner *Owner) (resultErr error) {
	if err := ctx.Err(); err != nil {
		return err
	}
	sourceInfo, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if !entryMatchesInfo(expected, sourceInfo) {
		return errors.New("source file no longer matches preflight manifest")
	}
	sourceFD, err := syscall.Open(source, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	sourceFile := os.NewFile(uintptr(sourceFD), source)
	if sourceFile == nil {
		syscall.Close(sourceFD)
		return errors.New("construct source file handle")
	}
	defer sourceFile.Close()
	if err := sameOpenFile(sourceFile, sourceInfo); err != nil {
		return err
	}
	targetFD, err := syscall.Open(target, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	targetFile := os.NewFile(uintptr(targetFD), target)
	if targetFile == nil {
		syscall.Close(targetFD)
		return errors.New("construct target file handle")
	}
	defer func() {
		closeErr := targetFile.Close()
		if resultErr == nil && closeErr != nil {
			resultErr = closeErr
		}
	}()
	hash := sha256.New()
	bufferSize := e.CopyBuffer
	if bufferSize <= 0 {
		bufferSize = defaultCopyBuffer
	}
	if expected.Size < 0 {
		return errors.New("source file has a negative expected size")
	}
	reader := &contextReader{ctx: ctx, reader: io.LimitReader(sourceFile, expected.Size)}
	written, err := io.CopyBuffer(io.MultiWriter(targetFile, hash), reader, make([]byte, bufferSize))
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	var extra [1]byte
	extraBytes, extraErr := sourceFile.Read(extra[:])
	if extraBytes != 0 || !errors.Is(extraErr, io.EOF) {
		return errors.Join(extraErr, errors.New("source file exceeded its exact copy bound"))
	}
	if written != expected.Size || hex.EncodeToString(hash.Sum(nil)) != expected.SHA256 {
		return errors.New("streamed source content differs from preflight manifest")
	}
	if err := targetFile.Sync(); err != nil {
		return err
	}
	uid, gid := int(expected.UID), int(expected.GID)
	if targetOwner != nil {
		uid, gid = int(targetOwner.UID), int(targetOwner.GID)
	}
	if err := targetFile.Chown(uid, gid); err != nil {
		return fmt.Errorf("preserve file owner: %w", err)
	}
	if err := targetFile.Chmod(os.FileMode(expected.Mode)); err != nil {
		return err
	}
	when := time.Unix(0, expected.ModifiedNanos)
	if err := os.Chtimes(target, when, when); err != nil {
		return err
	}
	if err := targetFile.Sync(); err != nil {
		return err
	}
	after, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if !sameIdentityAndContentMetadata(sourceInfo, after) {
		return errors.New("source file changed while copying")
	}
	return nil
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *contextReader) Read(buffer []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(buffer)
}

func entryMatchesInfo(entry Entry, info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && info.Mode().IsRegular() && stat.Nlink == 1 &&
		entry.Mode == uint32(info.Mode().Perm()) && entry.UID == uint32(stat.Uid) && entry.GID == uint32(stat.Gid) &&
		entry.LinkCount == uint64(stat.Nlink) && entry.Size == info.Size() && entry.ModifiedNanos == info.ModTime().UnixNano()
}

func pathDepth(path string) int {
	if path == "." {
		return 0
	}
	depth := 1
	for _, character := range path {
		if character == '/' {
			depth++
		}
	}
	return depth
}

func validateByteExact(input ValidationInput) error {
	if len(input.SourceEntries) != len(input.TargetEntries) {
		return errors.New("source and target entry counts differ")
	}
	for index := range input.SourceEntries {
		source, target := input.SourceEntries[index], input.TargetEntries[index]
		if source.Path != target.Path || source.Type != target.Type || source.Mode != target.Mode || source.UID != target.UID || source.GID != target.GID ||
			source.Size != target.Size || source.ModifiedNanos != target.ModifiedNanos || source.SHA256 != target.SHA256 {
			return fmt.Errorf("target entry %s differs from source", source.Path)
		}
	}
	return nil
}

func entriesEqual(left, right []Entry) bool {
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

func cloneEntries(entries []Entry) []Entry { return append([]Entry(nil), entries...) }

func syncResource(root string, entries []Entry) error {
	directories := make([]Entry, 0)
	for _, entry := range entries {
		path := root
		if entry.Path != "." {
			path = filepath.Join(root, filepath.FromSlash(entry.Path))
		}
		if entry.Type == Directory {
			directories = append(directories, entry)
			continue
		}
		descriptor, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
		if err != nil {
			return err
		}
		file := os.NewFile(uintptr(descriptor), path)
		if file == nil {
			syscall.Close(descriptor)
			return errors.New("construct target sync handle")
		}
		syncErr := file.Sync()
		closeErr := file.Close()
		if syncErr != nil {
			return syncErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	sort.Slice(directories, func(i, j int) bool { return pathDepth(directories[i].Path) > pathDepth(directories[j].Path) })
	for _, entry := range directories {
		path := root
		if entry.Path != "." {
			path = filepath.Join(root, filepath.FromSlash(entry.Path))
		}
		if err := syncDirectory(path); err != nil {
			return err
		}
	}
	return nil
}

func makeResourceReadOnly(root string) error {
	return filepath.WalkDir(root, func(path string, item os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 || (!info.IsDir() && !info.Mode().IsRegular()) {
			return errors.New("structured input contains an unsafe object")
		}
		mode := info.Mode().Perm() &^ 0o222
		if info.IsDir() {
			mode |= 0o500
		} else {
			mode |= 0o400
		}
		return os.Chmod(path, mode)
	})
}

func removeOwnedResource(root string, entries []Entry, uid int) error {
	// Restore owner write permission only on verified directories so their
	// children can be unlinked. Files remain read-only until removal.
	for _, entry := range entries {
		if entry.Type != Directory {
			continue
		}
		path := root
		if entry.Path != "." {
			path = filepath.Join(root, filepath.FromSlash(entry.Path))
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || stat.Uid != uint32(uid) || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || uint32(info.Mode().Perm()) != entry.Mode {
			return errors.New("structured input directory changed before removal")
		}
		if err := os.Chmod(path, 0o700); err != nil {
			return err
		}
	}
	ordered := append([]Entry(nil), entries...)
	sort.Slice(ordered, func(i, j int) bool {
		leftDepth, rightDepth := pathDepth(ordered[i].Path), pathDepth(ordered[j].Path)
		if leftDepth == rightDepth {
			return ordered[i].Path > ordered[j].Path
		}
		return leftDepth > rightDepth
	})
	for _, entry := range ordered {
		path := root
		if entry.Path != "." {
			path = filepath.Join(root, filepath.FromSlash(entry.Path))
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || stat.Uid != uint32(uid) || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("structured input changed before removal")
		}
		if entry.Type == RegularFile {
			if !info.Mode().IsRegular() || stat.Nlink != 1 || info.Size() != entry.Size {
				return errors.New("structured input file identity changed before removal")
			}
		} else if !info.IsDir() {
			return errors.New("structured input directory type changed before removal")
		}
		if err := os.Remove(path); err != nil {
			return err
		}
	}
	return syncDirectory(filepath.Dir(root))
}

func validateAbsoluteRoot(path, label string, uid int) error {
	if path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return fmt.Errorf("%s root must be an absolute canonical path", label)
	}
	current := string(filepath.Separator)
	parts := splitAbsolute(path)
	for _, part := range parts {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err != nil {
			return fmt.Errorf("inspect %s path component: %w", label, err)
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("%s path contains a non-directory or symbolic link", label)
		}
	}
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("inspect %s root: %w", label, err)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(uid) {
		return fmt.Errorf("%s root must be owned by deployment uid %d", label, uid)
	}
	if info.Mode().Perm()&0o022 != 0 {
		return fmt.Errorf("%s root must not be group/world writable", label)
	}
	return nil
}

func splitAbsolute(path string) []string {
	clean := filepath.Clean(path)
	volume := filepath.VolumeName(clean)
	clean = clean[len(volume):]
	for len(clean) > 0 && clean[0] == filepath.Separator {
		clean = clean[1:]
	}
	if clean == "" {
		return nil
	}
	return strings.Split(clean, string(filepath.Separator))
}

func mkdirExact(path string, mode os.FileMode, uid int) error {
	if err := os.Mkdir(path, mode); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(uid) || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("new staging directory identity is invalid")
	}
	return nil
}

func ensureParents(stage, parent string, uid int) error {
	relative, err := filepath.Rel(stage, parent)
	if err != nil || relative == ".." || filepath.IsAbs(relative) || (relative != "." && len(relative) >= 3 && relative[:3] == ".."+string(filepath.Separator)) {
		return errors.New("target parent escapes staging root")
	}
	current := stage
	if relative == "." {
		return verifyStagingDirectory(current, uid)
	}
	parts := splitRelative(relative)
	for _, part := range parts {
		current = filepath.Join(current, part)
		if err := os.Mkdir(current, 0o700); err != nil && !os.IsExist(err) {
			return err
		}
		if err := verifyStagingDirectory(current, uid); err != nil {
			return err
		}
	}
	return nil
}

func splitRelative(path string) []string {
	parts := make([]string, 0, 8)
	for path != "." && path != "" {
		directory, base := filepath.Split(path)
		if base != "" {
			parts = append(parts, base)
		}
		path = filepath.Clean(directory)
		if path == string(filepath.Separator) {
			break
		}
	}
	for left, right := 0, len(parts)-1; left < right; left, right = left+1, right-1 {
		parts[left], parts[right] = parts[right], parts[left]
	}
	return parts
}

func verifyStagingDirectory(path string, uid int) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(uid) || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o022 != 0 {
		return fmt.Errorf("unsafe staging directory %s", path)
	}
	return nil
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func writeAtomicOwnerFile(path string, contents []byte, mode os.FileMode, uid int) (resultErr error) {
	if len(contents) > maximumMetadataSize {
		return errors.New("handoff metadata exceeds the maximum size")
	}
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return err
	}
	temporary := path + ".tmp-" + hex.EncodeToString(suffix[:])
	descriptor, err := syscall.Open(temporary, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, uint32(mode.Perm()))
	if err != nil {
		return err
	}
	file := os.NewFile(uintptr(descriptor), temporary)
	if file == nil {
		syscall.Close(descriptor)
		return errors.New("construct metadata file handle")
	}
	defer func() {
		if file != nil {
			if closeErr := file.Close(); resultErr == nil && closeErr != nil {
				resultErr = closeErr
			}
		}
		if resultErr != nil {
			_ = os.Remove(temporary)
		}
	}()
	if _, err := file.Write(contents); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	info, err := file.Stat()
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(uid) || stat.Nlink != 1 || !info.Mode().IsRegular() {
		return errors.New("metadata temporary file identity is invalid")
	}
	if err := file.Close(); err != nil {
		return err
	}
	file = nil
	if err := os.Rename(temporary, path); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(path))
}
