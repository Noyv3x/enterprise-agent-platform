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
	"sort"
	"strings"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
	"golang.org/x/sys/unix"
)

const (
	workerSourceRoot = "/source"
	workerTargetRoot = "/target"
)

// RunPrivilegedTreeWorker is the complete entrypoint of the dedicated helper
// image. It accepts only fixed control paths and a sealed closed-world request.
func RunPrivilegedTreeWorker(ctx context.Context, requestPath, receiptPath string) error {
	if requestPath != "/control/request.json" || receiptPath != "/control/receipt.json" {
		return errors.New("privileged worker requires fixed owner-control paths")
	}
	request, requestOwner, err := readPrivilegedWorkerRequest(requestPath)
	if err != nil {
		return err
	}
	if requestOwner.UID != request.ManagerUID || requestOwner.GID != request.ManagerGID {
		return errors.New("privileged request owner differs from its sealed manager identity")
	}
	if os.Getenv("HANDOFF_FS_IMAGE_DIGEST") != request.ImageDigest {
		return errors.New("running privileged worker image identity differs from its request")
	}
	if err := validateWorkerRequest(request); err != nil {
		return err
	}
	receipt := privilegedWorkerReceipt{
		SchemaVersion: privilegedProtocolSchema, Operation: request.Operation,
		TransactionID: request.TransactionID, DataRequestSHA256: request.DataRequestSHA256,
		ResourceName: request.ResourceName, ImageDigest: request.ImageDigest, RequestSHA256: request.RequestSHA256,
	}
	switch request.Operation {
	case PrivilegedInventory:
		entries, err := workerInventory(ctx, workerSourceRoot, request.ResourceName, request.SourceOwners)
		if err != nil {
			return err
		}
		receipt.Entries = entries
		receipt.EntriesSHA256, err = entryDigest(entries)
		if err != nil {
			return err
		}
	case PrivilegedCopy:
		source, target, err := workerCopy(ctx, request)
		if err != nil {
			return err
		}
		receipt.SourceEntries, receipt.TargetEntries = source, target
		receipt.SourceSHA256, err = entryDigest(source)
		if err != nil {
			return err
		}
		receipt.TargetSHA256, err = entryDigest(target)
		if err != nil {
			return err
		}
	case PrivilegedRemove:
		if err := workerRemove(ctx, request); err != nil {
			return err
		}
		receipt.Removed = true
	default:
		return errors.New("unsupported privileged worker operation")
	}
	receipt, err = sealPrivilegedReceipt(receipt)
	if err != nil {
		return err
	}
	return writePrivilegedWorkerReceipt(receiptPath, receipt, request.ManagerUID, request.ManagerGID)
}

type workerFileOwner struct{ UID, GID uint32 }

func readPrivilegedWorkerRequest(path string) (privilegedWorkerRequest, workerFileOwner, error) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return privilegedWorkerRequest{}, workerFileOwner{}, err
	}
	file := os.NewFile(uintptr(fd), path)
	if file == nil {
		unix.Close(fd)
		return privilegedWorkerRequest{}, workerFileOwner{}, errors.New("construct privileged request reader")
	}
	defer file.Close()
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return privilegedWorkerRequest{}, workerFileOwner{}, err
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Nlink != 1 || stat.Mode&0o077 != 0 || stat.Size < 1 || stat.Size > maximumMetadataSize {
		return privilegedWorkerRequest{}, workerFileOwner{}, errors.New("privileged request is not an owner-only single-link regular file")
	}
	raw, err := io.ReadAll(io.LimitReader(file, maximumMetadataSize+1))
	if err != nil || len(raw) > maximumMetadataSize {
		return privilegedWorkerRequest{}, workerFileOwner{}, errors.Join(err, errors.New("privileged request exceeds its bound"))
	}
	if err := rejectDuplicateJSONKeys(raw); err != nil {
		return privilegedWorkerRequest{}, workerFileOwner{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var request privilegedWorkerRequest
	if err := decoder.Decode(&request); err != nil {
		return privilegedWorkerRequest{}, workerFileOwner{}, err
	}
	if err := requireJSONEOF(decoder); err != nil {
		return privilegedWorkerRequest{}, workerFileOwner{}, err
	}
	return request, workerFileOwner{UID: stat.Uid, GID: stat.Gid}, nil
}

func validateWorkerRequest(request privilegedWorkerRequest) error {
	if request.SchemaVersion != privilegedProtocolSchema || request.Access != ContainerOwnedTree ||
		!transactionIDPattern.MatchString(request.TransactionID) || !sha256Pattern.MatchString(request.DataRequestSHA256) ||
		!resourceNamePattern.MatchString(request.ResourceName) || !releaseDigestPattern(request.ImageDigest) {
		return errors.New("privileged worker request identity is invalid")
	}
	if err := verifyPrivilegedRequest(request); err != nil {
		return err
	}
	if len(request.SourceOwners) == 0 || len(request.TargetOwners) == 0 {
		return errors.New("privileged worker owner sets are empty")
	}
	resource := Resource{Name: request.ResourceName, Kind: ByteExactTree, Access: ContainerOwnedTree, Type: Directory}
	if len(request.ExpectedSource) != 0 {
		if err := validatePrivilegedEntries(resource, request.ExpectedSource, request.SourceOwners); err != nil {
			return err
		}
	}
	if len(request.ExpectedTarget) != 0 {
		if err := validatePrivilegedEntries(resource, request.ExpectedTarget, request.TargetOwners); err != nil {
			return err
		}
	}
	switch request.Operation {
	case PrivilegedInventory:
		if request.TargetRelative != "" || len(request.ExpectedSource) != 0 || len(request.ExpectedTarget) != 0 || request.RemovalProof != nil {
			return errors.New("privileged inventory request fields are not closed")
		}
	case PrivilegedCopy:
		if err := validateRelative(request.TargetRelative); err != nil || len(request.ExpectedSource) == 0 || len(request.ExpectedTarget) != 0 || request.RemovalProof != nil {
			return errors.New("privileged copy request fields are not closed")
		}
	case PrivilegedRemove:
		if err := validateRelative(request.TargetRelative); err != nil || len(request.ExpectedSource) != 0 || len(request.ExpectedTarget) == 0 || request.RemovalProof == nil ||
			validateRemovalProof(*request.RemovalProof) != nil {
			return errors.New("privileged remove request fields are not closed")
		}
	default:
		return errors.New("privileged worker operation is unknown")
	}
	return nil
}

func releaseDigestPattern(value string) bool {
	index := strings.LastIndex(value, "@sha256:")
	return index > 0 && index+8+64 == len(value) && sha256Pattern.MatchString(value[index+8:])
}

func workerInventory(ctx context.Context, root, resource string, owners []Owner) ([]Entry, error) {
	fd, stat, err := workerOpenRoot(root)
	if err != nil {
		return nil, err
	}
	defer unix.Close(fd)
	entries := make([]Entry, 0, 32)
	if err := workerInventoryAt(ctx, fd, uint64(stat.Dev), resource, ".", owners, &entries); err != nil {
		return nil, err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })
	return entries, nil
}

func workerOpenRoot(path string) (int, unix.Stat_t, error) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return -1, unix.Stat_t{}, err
	}
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		unix.Close(fd)
		return -1, unix.Stat_t{}, err
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFDIR {
		unix.Close(fd)
		return -1, unix.Stat_t{}, errors.New("privileged mount root is not a directory")
	}
	return fd, stat, nil
}

func workerInventoryAt(ctx context.Context, fd int, device uint64, resource, relative string, owners []Owner, entries *[]Entry) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	var before unix.Stat_t
	if err := unix.Fstat(fd, &before); err != nil {
		return err
	}
	entry, err := workerEntry(resource, relative, before, owners, device)
	if err != nil {
		return err
	}
	if before.Mode&unix.S_IFMT == unix.S_IFREG {
		digest, err := workerHashFD(ctx, fd, before.Size)
		if err != nil {
			return err
		}
		var after unix.Stat_t
		if err := unix.Fstat(fd, &after); err != nil || !workerSameMetadata(before, after) {
			return errors.Join(err, errors.New("privileged file changed while hashing"))
		}
		entry.SHA256 = digest
		*entries = append(*entries, entry)
		return nil
	}
	*entries = append(*entries, entry)
	duplicate, err := unix.Dup(fd)
	if err != nil {
		return err
	}
	directory := os.NewFile(uintptr(duplicate), relative)
	if directory == nil {
		unix.Close(duplicate)
		return errors.New("construct privileged directory reader")
	}
	children, readErr := directory.ReadDir(contract.AgentRuntimeMaximumDirectoryEntries + 1)
	closeErr := directory.Close()
	if readErr != nil && !errors.Is(readErr, io.EOF) || closeErr != nil {
		return errors.Join(readErr, closeErr)
	}
	if len(children) > contract.AgentRuntimeMaximumDirectoryEntries {
		return errors.New("privileged directory entry count exceeds the canonical handoff limit")
	}
	sort.Slice(children, func(i, j int) bool { return children[i].Name() < children[j].Name() })
	for _, child := range children {
		if child.Name() == "." || child.Name() == ".." || strings.ContainsRune(child.Name(), '/') || strings.ContainsRune(child.Name(), 0) {
			return errors.New("privileged tree contains an invalid directory entry")
		}
		childFD, err := workerOpenChild(fd, child.Name())
		if err != nil {
			return err
		}
		childRelative := child.Name()
		if relative != "." {
			childRelative = relative + "/" + child.Name()
		}
		err = workerInventoryAt(ctx, childFD, device, resource, childRelative, owners, entries)
		closeErr := unix.Close(childFD)
		if err != nil || closeErr != nil {
			return errors.Join(err, closeErr)
		}
	}
	var after unix.Stat_t
	if err := unix.Fstat(fd, &after); err != nil {
		return err
	}
	if !workerSameMetadata(before, after) {
		return errors.New("privileged directory changed during inventory")
	}
	return nil
}

func workerOpenChild(parent int, name string) (int, error) {
	return workerOpenAt(parent, name, "")
}

// workerOpenAt first acquires an O_PATH descriptor and validates the object
// type before opening a readable descriptor. In particular, a FIFO, socket or
// device is never opened for I/O merely because it appeared during a directory
// enumeration. The second fstat closes the rename/swap window between the two
// opens.
func workerOpenAt(parent int, relative string, expected NodeType) (int, error) {
	resolve := uint64(unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_XDEV)
	metadataFD, err := unix.Openat2(parent, relative, &unix.OpenHow{
		Flags:   uint64(unix.O_PATH | unix.O_CLOEXEC | unix.O_NOFOLLOW),
		Resolve: resolve,
	})
	if err != nil {
		return -1, err
	}
	defer unix.Close(metadataFD)
	var metadata unix.Stat_t
	if err := unix.Fstat(metadataFD, &metadata); err != nil {
		return -1, err
	}
	typeValue := NodeType("")
	flags := unix.O_RDONLY | unix.O_CLOEXEC | unix.O_NOFOLLOW | unix.O_NONBLOCK
	switch metadata.Mode & unix.S_IFMT {
	case unix.S_IFDIR:
		typeValue = Directory
		flags |= unix.O_DIRECTORY
	case unix.S_IFREG:
		typeValue = RegularFile
	default:
		return -1, errors.New("privileged tree contains a special filesystem object")
	}
	if expected != "" && typeValue != expected {
		return -1, fmt.Errorf("privileged path has type %s, expected %s", typeValue, expected)
	}
	fd, err := unix.Openat2(parent, relative, &unix.OpenHow{Flags: uint64(flags), Resolve: resolve})
	if err != nil {
		return -1, err
	}
	var opened unix.Stat_t
	if err := unix.Fstat(fd, &opened); err != nil {
		unix.Close(fd)
		return -1, err
	}
	if !workerSameObject(metadata, opened) {
		unix.Close(fd)
		return -1, errors.New("privileged path changed while opening")
	}
	return fd, nil
}

func workerSameObject(left, right unix.Stat_t) bool {
	return left.Dev == right.Dev && left.Ino == right.Ino && left.Nlink == right.Nlink && left.Mode == right.Mode &&
		left.Uid == right.Uid && left.Gid == right.Gid && left.Size == right.Size && left.Mtim == right.Mtim
}

func workerEntry(resource, relative string, stat unix.Stat_t, owners []Owner, device uint64) (Entry, error) {
	if uint64(stat.Dev) != device || !ownerAllowed(stat.Uid, stat.Gid, owners) || stat.Nlink < 1 || stat.Blocks < 0 {
		return Entry{}, errors.New("privileged tree entry has an invalid device, owner, link, or allocation identity")
	}
	typeValue := NodeType("")
	switch stat.Mode & unix.S_IFMT {
	case unix.S_IFREG:
		if stat.Nlink != 1 {
			return Entry{}, errors.New("privileged regular file has more than one link")
		}
		typeValue = RegularFile
	case unix.S_IFDIR:
		typeValue = Directory
	default:
		return Entry{}, errors.New("privileged tree contains a special filesystem object")
	}
	if uint64(stat.Blocks) > ^uint64(0)/512 {
		return Entry{}, errors.New("privileged allocation size overflows")
	}
	return Entry{
		Resource: resource, Path: relative, Type: typeValue, Mode: stat.Mode & 0o777,
		UID: stat.Uid, GID: stat.Gid, LinkCount: uint64(stat.Nlink), Size: stat.Size,
		AllocatedSize: uint64(stat.Blocks) * 512, ModifiedNanos: stat.Mtim.Sec*1_000_000_000 + stat.Mtim.Nsec,
	}, nil
}

func workerHashFD(ctx context.Context, fd int, expectedSize int64) (string, error) {
	if expectedSize < 0 {
		return "", errors.New("privileged file has a negative expected size")
	}
	duplicate, err := unix.Dup(fd)
	if err != nil {
		return "", err
	}
	file := os.NewFile(uintptr(duplicate), "privileged-file")
	if file == nil {
		unix.Close(duplicate)
		return "", errors.New("construct privileged file reader")
	}
	defer file.Close()
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	hash := sha256.New()
	written, err := io.CopyBuffer(hash, &contextReader{ctx: ctx, reader: io.LimitReader(file, expectedSize)}, make([]byte, defaultCopyBuffer))
	if err != nil {
		return "", err
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	var extra [1]byte
	extraBytes, extraErr := file.Read(extra[:])
	if written != expectedSize || extraBytes != 0 || !errors.Is(extraErr, io.EOF) {
		return "", errors.Join(extraErr, errors.New("privileged file changed or exceeded its exact hash bound"))
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func workerSameMetadata(left, right unix.Stat_t) bool {
	return left.Dev == right.Dev && left.Ino == right.Ino && left.Nlink == right.Nlink && left.Mode == right.Mode &&
		left.Uid == right.Uid && left.Gid == right.Gid && left.Size == right.Size && left.Mtim == right.Mtim
}

func workerCopy(ctx context.Context, request privilegedWorkerRequest) ([]Entry, []Entry, error) {
	sourceBefore, err := workerInventory(ctx, workerSourceRoot, request.ResourceName, request.SourceOwners)
	if err != nil {
		return nil, nil, err
	}
	if !entriesEqual(sourceBefore, request.ExpectedSource) {
		return nil, nil, errors.New("privileged source differs from Manager preflight inventory")
	}
	sourceFD, sourceStat, err := workerOpenRoot(workerSourceRoot)
	if err != nil {
		return nil, nil, err
	}
	defer unix.Close(sourceFD)
	targetFD, _, err := workerOpenRoot(workerTargetRoot)
	if err != nil {
		return nil, nil, err
	}
	defer unix.Close(targetFD)
	parentFD, leaf, err := workerOpenParent(targetFD, request.TargetRelative)
	if err != nil {
		return nil, nil, err
	}
	defer unix.Close(parentFD)
	if err := unix.Mkdirat(parentFD, leaf, 0o700); err != nil {
		return nil, nil, fmt.Errorf("create privileged target root: %w", err)
	}
	rootFD, err := workerOpenChild(parentFD, leaf)
	if err != nil {
		return nil, nil, err
	}
	defer unix.Close(rootFD)
	for _, entry := range sourceBefore {
		if entry.Path == "." {
			continue
		}
		if entry.Type == Directory {
			parent, name, err := workerOpenParent(rootFD, entry.Path)
			if err != nil {
				return nil, nil, err
			}
			err = unix.Mkdirat(parent, name, 0o700)
			unix.Close(parent)
			if err != nil {
				return nil, nil, err
			}
			continue
		}
		if err := workerCopyFile(ctx, sourceFD, rootFD, entry, uint64(sourceStat.Dev)); err != nil {
			return nil, nil, err
		}
	}
	directories := make([]Entry, 0)
	for _, entry := range sourceBefore {
		if entry.Type == Directory {
			directories = append(directories, entry)
		}
	}
	sort.Slice(directories, func(i, j int) bool { return pathDepth(directories[i].Path) > pathDepth(directories[j].Path) })
	for _, entry := range directories {
		fd := rootFD
		if entry.Path != "." {
			fd, err = workerOpenRelative(rootFD, entry.Path, true)
			if err != nil {
				return nil, nil, err
			}
		}
		if err := workerApplyMetadata(fd, entry); err != nil {
			if entry.Path != "." {
				unix.Close(fd)
			}
			return nil, nil, err
		}
		if err := unix.Fsync(fd); err != nil {
			if entry.Path != "." {
				unix.Close(fd)
			}
			return nil, nil, err
		}
		if entry.Path != "." {
			unix.Close(fd)
		}
	}
	if err := unix.Fsync(parentFD); err != nil {
		return nil, nil, err
	}
	target, err := workerInventory(ctx, filepath.Join(workerTargetRoot, filepath.FromSlash(request.TargetRelative)), request.ResourceName, request.TargetOwners)
	if err != nil {
		return nil, nil, err
	}
	if err := validateByteExact(ValidationInput{SourceEntries: sourceBefore, TargetEntries: target}); err != nil {
		return nil, nil, err
	}
	sourceAfter, err := workerInventory(ctx, workerSourceRoot, request.ResourceName, request.SourceOwners)
	if err != nil || !entriesEqual(sourceBefore, sourceAfter) {
		return nil, nil, errors.Join(err, errors.New("privileged source changed while copying"))
	}
	return sourceAfter, target, nil
}

func workerCopyFile(ctx context.Context, sourceRoot, targetRoot int, entry Entry, sourceDevice uint64) error {
	sourceFD, err := workerOpenRelative(sourceRoot, entry.Path, false)
	if err != nil {
		return err
	}
	defer unix.Close(sourceFD)
	var sourceStat unix.Stat_t
	if err := unix.Fstat(sourceFD, &sourceStat); err != nil {
		return err
	}
	actual, err := workerEntry(entry.Resource, entry.Path, sourceStat, []Owner{{UID: entry.UID, GID: entry.GID}}, sourceDevice)
	if err != nil || actual.Mode != entry.Mode || actual.Size != entry.Size || actual.ModifiedNanos != entry.ModifiedNanos {
		return errors.Join(err, errors.New("privileged source file differs before copy"))
	}
	parentFD, leaf, err := workerOpenParent(targetRoot, entry.Path)
	if err != nil {
		return err
	}
	defer unix.Close(parentFD)
	targetFD, err := unix.Openat(parentFD, leaf, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	defer unix.Close(targetFD)
	sourceDuplicate, err := unix.Dup(sourceFD)
	if err != nil {
		return err
	}
	targetDuplicate, err := unix.Dup(targetFD)
	if err != nil {
		unix.Close(sourceDuplicate)
		return err
	}
	sourceFile := os.NewFile(uintptr(sourceDuplicate), "source")
	targetFile := os.NewFile(uintptr(targetDuplicate), "target")
	if sourceFile == nil || targetFile == nil {
		if sourceFile != nil {
			_ = sourceFile.Close()
		} else {
			_ = unix.Close(sourceDuplicate)
		}
		if targetFile != nil {
			_ = targetFile.Close()
		} else {
			_ = unix.Close(targetDuplicate)
		}
		return errors.New("construct privileged copy handles")
	}
	defer sourceFile.Close()
	defer targetFile.Close()
	if _, err := sourceFile.Seek(0, io.SeekStart); err != nil {
		return err
	}
	hash := sha256.New()
	if entry.Size < 0 {
		return errors.New("privileged source file has a negative expected size")
	}
	written, err := io.CopyBuffer(io.MultiWriter(targetFile, hash), &contextReader{ctx: ctx, reader: io.LimitReader(sourceFile, entry.Size)}, make([]byte, defaultCopyBuffer))
	if err == nil {
		var extra [1]byte
		extraBytes, extraErr := sourceFile.Read(extra[:])
		if extraBytes != 0 || !errors.Is(extraErr, io.EOF) {
			err = errors.Join(extraErr, errors.New("privileged source exceeded its exact copy bound"))
		}
	}
	if err != nil || written != entry.Size || hex.EncodeToString(hash.Sum(nil)) != entry.SHA256 {
		return errors.Join(err, errors.New("privileged copied bytes differ from inventory"))
	}
	var sourceAfter unix.Stat_t
	if err := unix.Fstat(sourceFD, &sourceAfter); err != nil || !workerSameMetadata(sourceStat, sourceAfter) {
		return errors.Join(err, errors.New("privileged source changed while copying"))
	}
	if err := workerApplyMetadata(targetFD, entry); err != nil {
		return err
	}
	return unix.Fsync(targetFD)
}

func workerApplyMetadata(fd int, entry Entry) error {
	if err := unix.Fchown(fd, int(entry.UID), int(entry.GID)); err != nil {
		return err
	}
	if err := unix.Fchmod(fd, entry.Mode); err != nil {
		return err
	}
	times := []unix.Timespec{{Sec: entry.ModifiedNanos / 1_000_000_000, Nsec: entry.ModifiedNanos % 1_000_000_000}, {Sec: entry.ModifiedNanos / 1_000_000_000, Nsec: entry.ModifiedNanos % 1_000_000_000}}
	return unix.UtimesNanoAt(fd, "", times, unix.AT_EMPTY_PATH)
}

func workerOpenRelative(root int, relative string, directory bool) (int, error) {
	expected := RegularFile
	if directory {
		expected = Directory
	}
	return workerOpenAt(root, relative, expected)
}

func workerOpenParent(root int, relative string) (int, string, error) {
	if err := validateRelative(relative); err != nil {
		return -1, "", err
	}
	directory, leaf := filepath.ToSlash(filepath.Dir(relative)), filepath.Base(relative)
	if directory == "." {
		fd, err := unix.Dup(root)
		return fd, leaf, err
	}
	fd, err := workerOpenRelative(root, directory, true)
	return fd, leaf, err
}

func workerRemove(ctx context.Context, request privilegedWorkerRequest) error {
	if err := workerVerifyRemovalProof(ctx, request); err != nil {
		return err
	}
	targetPath := filepath.Join(workerTargetRoot, filepath.FromSlash(request.TargetRelative))
	entries, err := workerInventory(ctx, targetPath, request.ResourceName, request.TargetOwners)
	if err != nil {
		return err
	}
	if !entriesEqual(entries, request.ExpectedTarget) {
		return errors.New("privileged removal target differs from its fenced inventory")
	}
	rootFD, _, err := workerOpenRoot(workerTargetRoot)
	if err != nil {
		return err
	}
	defer unix.Close(rootFD)
	targetFD, err := workerOpenRelative(rootFD, request.TargetRelative, true)
	if err != nil {
		return err
	}
	ordered := append([]Entry(nil), entries...)
	sort.Slice(ordered, func(i, j int) bool {
		left, right := pathDepth(ordered[i].Path), pathDepth(ordered[j].Path)
		if left == right {
			return ordered[i].Path > ordered[j].Path
		}
		return left > right
	})
	for _, entry := range ordered {
		if err := ctx.Err(); err != nil {
			unix.Close(targetFD)
			return err
		}
		if entry.Path == "." {
			continue
		}
		parent, name, err := workerOpenParent(targetFD, entry.Path)
		if err != nil {
			unix.Close(targetFD)
			return err
		}
		flags := 0
		if entry.Type == Directory {
			flags = unix.AT_REMOVEDIR
		}
		err = unix.Unlinkat(parent, name, flags)
		if syncErr := unix.Fsync(parent); err == nil {
			err = syncErr
		}
		unix.Close(parent)
		if err != nil {
			unix.Close(targetFD)
			return err
		}
	}
	unix.Close(targetFD)
	parent, leaf, err := workerOpenParent(rootFD, request.TargetRelative)
	if err != nil {
		return err
	}
	defer unix.Close(parent)
	if err := unix.Unlinkat(parent, leaf, unix.AT_REMOVEDIR); err != nil {
		return err
	}
	if err := unix.Fsync(parent); err != nil {
		return err
	}
	if fd, err := workerOpenRelative(rootFD, request.TargetRelative, true); err == nil {
		unix.Close(fd)
		return errors.New("privileged removal target still exists")
	} else if !errors.Is(err, unix.ENOENT) {
		return err
	}
	return nil
}

func workerVerifyRemovalProof(ctx context.Context, request privilegedWorkerRequest) error {
	if request.RemovalProof == nil {
		return errors.New("privileged removal has no durable proof")
	}
	rootFD, _, err := workerOpenRoot(workerTargetRoot)
	if err != nil {
		return err
	}
	defer unix.Close(rootFD)
	markerDigest, err := workerMetadataDigest(ctx, rootFD, markerName, request.ManagerUID, request.ManagerGID)
	if err != nil {
		return fmt.Errorf("verify privileged removal marker: %w", err)
	}
	if markerDigest != request.RemovalProof.MarkerSHA256 {
		return errors.New("privileged removal marker digest differs from its proof")
	}
	if request.RemovalProof.Kind == RemovalFencedPublication {
		manifestDigest, err := workerMetadataDigest(ctx, rootFD, manifestName, request.ManagerUID, request.ManagerGID)
		if err != nil {
			return fmt.Errorf("verify privileged removal manifest: %w", err)
		}
		if manifestDigest != request.RemovalProof.ManifestSHA256 {
			return errors.New("privileged removal manifest digest differs from its proof")
		}
	}
	return nil
}

func workerMetadataDigest(ctx context.Context, rootFD int, relative string, uid, gid uint32) (string, error) {
	fd, err := workerOpenAt(rootFD, relative, RegularFile)
	if err != nil {
		return "", err
	}
	defer unix.Close(fd)
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return "", err
	}
	if stat.Uid != uid || stat.Gid != gid || stat.Nlink != 1 || stat.Mode&0o077 != 0 || stat.Size < 1 || stat.Size > maximumMetadataSize {
		return "", errors.New("privileged removal metadata is not owner-only transaction evidence")
	}
	digest, err := workerHashFD(ctx, fd, stat.Size)
	if err != nil {
		return "", err
	}
	var after unix.Stat_t
	if err := unix.Fstat(fd, &after); err != nil || !workerSameMetadata(stat, after) {
		return "", errors.Join(err, errors.New("privileged removal metadata changed while hashing"))
	}
	return digest, nil
}

func writePrivilegedWorkerReceipt(path string, receipt privilegedWorkerReceipt, uid, gid uint32) error {
	raw, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	if len(raw) > maximumMetadataSize {
		return errors.New("privileged receipt exceeds its bound")
	}
	fd, err := unix.Open(path, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	file := os.NewFile(uintptr(fd), path)
	if file == nil {
		unix.Close(fd)
		return errors.New("construct privileged receipt writer")
	}
	remove := true
	defer func() {
		file.Close()
		if remove {
			_ = os.Remove(path)
		}
	}()
	if _, err := file.Write(append(raw, '\n')); err != nil {
		return err
	}
	if err := unix.Fchown(fd, int(uid), int(gid)); err != nil {
		return err
	}
	if err := unix.Fchmod(fd, 0o600); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	remove = false
	return syncDirectory(filepath.Dir(path))
}
