//go:build linux

package handoffsource

import (
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

const (
	ownerDirectoryMode = 0o700
	ownerArtifactMode  = 0o700
	artifactDirectory  = "source-owner"
	artifactBasename   = "target-manager"
)

type fileIdentity struct {
	dev    uint64
	ino    uint64
	uid    uint32
	mode   os.FileMode
	size   int64
	sha256 string
}

func inspectRegular(path string, maxBytes int64, ownerOnly bool) (fileIdentity, error) {
	identity, _, err := inspectRegularWithBytes(path, maxBytes, ownerOnly)
	return identity, err
}

func inspectRegularWithBytes(path string, maxBytes int64, ownerOnly bool) (fileIdentity, []byte, error) {
	first, data, err := readRegularOnce(path, maxBytes, ownerOnly)
	if err != nil {
		return fileIdentity{}, nil, err
	}
	second, secondData, err := readRegularOnce(path, maxBytes, ownerOnly)
	if err != nil {
		return fileIdentity{}, nil, fmt.Errorf("revalidate file identity: %w", err)
	}
	if first.dev != second.dev || first.ino != second.ino || first.uid != second.uid || first.mode != second.mode ||
		first.size != second.size || first.sha256 != second.sha256 || !equalBytes(data, secondData) {
		return fileIdentity{}, nil, errors.New("file identity or content changed while it was inspected")
	}
	return first, data, nil
}

func readRegularOnce(path string, maxBytes int64, ownerOnly bool) (fileIdentity, []byte, error) {
	if maxBytes <= 0 {
		return fileIdentity{}, nil, errors.New("file size limit must be positive")
	}
	fd, err := openAbsolute(path, false)
	if err != nil {
		return fileIdentity{}, nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	if file == nil {
		_ = syscall.Close(fd)
		return fileIdentity{}, nil, errors.New("open file returned an invalid descriptor")
	}
	defer file.Close()
	stat, err := statFile(file)
	if err != nil {
		return fileIdentity{}, nil, err
	}
	if stat.Uid != uint32(os.Getuid()) || stat.Nlink != 1 || stat.Mode&syscall.S_IFMT != syscall.S_IFREG {
		return fileIdentity{}, nil, errors.New("file is not a single-link regular file owned by the deployment user")
	}
	permissions := os.FileMode(stat.Mode & 0o777)
	if permissions&0o022 != 0 || (ownerOnly && permissions&0o077 != 0) {
		return fileIdentity{}, nil, errors.New("file permissions allow an untrusted identity")
	}
	if stat.Size < 0 || stat.Size > maxBytes {
		return fileIdentity{}, nil, fmt.Errorf("file exceeds %d bytes", maxBytes)
	}
	data, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return fileIdentity{}, nil, err
	}
	if int64(len(data)) != stat.Size || int64(len(data)) > maxBytes {
		return fileIdentity{}, nil, errors.New("file size changed while it was read")
	}
	var after syscall.Stat_t
	if err := syscall.Fstat(fd, &after); err != nil {
		return fileIdentity{}, nil, err
	}
	if after.Dev != stat.Dev || after.Ino != stat.Ino || after.Size != stat.Size || after.Mode != stat.Mode || after.Uid != stat.Uid {
		return fileIdentity{}, nil, errors.New("file metadata changed while it was read")
	}
	return fileIdentity{
		dev: uint64(stat.Dev), ino: stat.Ino, uid: stat.Uid, mode: os.FileMode(stat.Mode & 0o777),
		size: stat.Size, sha256: digestBytes(data),
	}, data, nil
}

func inspectDirectory(path string, ownerOnly bool) (fileIdentity, error) {
	fd, err := openAbsolute(path, true)
	if err != nil {
		return fileIdentity{}, err
	}
	defer syscall.Close(fd)
	var stat syscall.Stat_t
	if err := syscall.Fstat(fd, &stat); err != nil {
		return fileIdentity{}, err
	}
	permissions := os.FileMode(stat.Mode & 0o777)
	if stat.Uid != uint32(os.Getuid()) || stat.Mode&syscall.S_IFMT != syscall.S_IFDIR ||
		permissions&0o022 != 0 || (ownerOnly && permissions&0o077 != 0) {
		return fileIdentity{}, errors.New("directory is not an owner-controlled real directory")
	}
	return fileIdentity{dev: uint64(stat.Dev), ino: stat.Ino, uid: stat.Uid, mode: permissions}, nil
}

func inspectUnixSocket(path string) error {
	parentFD, err := openAbsolute(filepath.Dir(path), true)
	if err != nil {
		return err
	}
	defer syscall.Close(parentFD)
	first, err := lstatAt(parentFD, filepath.Base(path))
	if err != nil {
		return err
	}
	if first.Mode&syscall.S_IFMT != syscall.S_IFSOCK || first.Uid != uint32(os.Getuid()) || first.Nlink != 1 {
		return errors.New("control socket is not a single-link Unix socket owned by the deployment user")
	}
	second, err := lstatAt(parentFD, filepath.Base(path))
	if err != nil || first.Dev != second.Dev || first.Ino != second.Ino || first.Mode != second.Mode || first.Uid != second.Uid {
		return errors.New("control socket identity changed while it was inspected")
	}
	return nil
}

// requireAbsent walks from an already opened root and rejects symlinks in
// every existing component. The nearest existing parent must be owned by the
// deployment user and not writable by another identity.
func requireAbsent(path string) error {
	if !canonicalAbsolute(path) || path == "/" {
		return errors.New("absence path must be a non-root canonical absolute path")
	}
	components := splitAbsolute(path)
	fd, err := syscall.Open("/", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer func() { _ = syscall.Close(fd) }()
	for index, component := range components {
		last := index == len(components)-1
		if last {
			_, err := lstatAt(fd, component)
			if errors.Is(err, os.ErrNotExist) {
				return validateWritableParent(fd)
			}
			if err != nil {
				return err
			}
			return errors.New("path already exists")
		}
		next, openErr := syscall.Openat(fd, component, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
		if errors.Is(openErr, syscall.ENOENT) {
			return validateWritableParent(fd)
		}
		if openErr != nil {
			return fmt.Errorf("open path component %q without following links: %w", component, openErr)
		}
		_ = syscall.Close(fd)
		fd = next
	}
	return errors.New("absence path unexpectedly resolved")
}

func validateWritableParent(fd int) error {
	var stat syscall.Stat_t
	if err := syscall.Fstat(fd, &stat); err != nil {
		return err
	}
	if stat.Mode&syscall.S_IFMT != syscall.S_IFDIR || stat.Uid != uint32(os.Getuid()) || stat.Mode&0o022 != 0 {
		return errors.New("nearest existing target parent is not controlled by the deployment user")
	}
	return nil
}

func openAbsolute(path string, directory bool) (int, error) {
	if !canonicalAbsolute(path) {
		return -1, errors.New("path must be canonical and absolute")
	}
	components := splitAbsolute(path)
	fd, err := syscall.Open("/", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return -1, err
	}
	if len(components) == 0 {
		if directory {
			return fd, nil
		}
		_ = syscall.Close(fd)
		return -1, errors.New("root is not a regular file")
	}
	for index, component := range components {
		flags := syscall.O_RDONLY | syscall.O_CLOEXEC | syscall.O_NOFOLLOW
		if index != len(components)-1 || directory {
			flags |= syscall.O_DIRECTORY
		}
		next, openErr := syscall.Openat(fd, component, flags, 0)
		_ = syscall.Close(fd)
		if openErr != nil {
			return -1, fmt.Errorf("open path component %q without following links: %w", component, openErr)
		}
		fd = next
	}
	return fd, nil
}

func splitAbsolute(path string) []string {
	trimmed := strings.TrimPrefix(path, "/")
	if trimmed == "" {
		return nil
	}
	return strings.Split(trimmed, "/")
}

func statFile(file *os.File) (syscall.Stat_t, error) {
	var stat syscall.Stat_t
	if err := syscall.Fstat(int(file.Fd()), &stat); err != nil {
		return syscall.Stat_t{}, err
	}
	return stat, nil
}

func lstatAt(directoryFD int, name string) (syscall.Stat_t, error) {
	if name == "" || name == "." || name == ".." || strings.ContainsRune(name, '/') || strings.ContainsRune(name, 0) {
		return syscall.Stat_t{}, errors.New("directory entry name is invalid")
	}
	info, err := os.Lstat(filepath.Join("/proc/self/fd", fmt.Sprint(directoryFD), name))
	if err != nil {
		return syscall.Stat_t{}, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return syscall.Stat_t{}, errors.New("directory entry has no Linux stat identity")
	}
	return *stat, nil
}

func equalBytes(left, right []byte) bool {
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

func (driver *Driver) stageManagerArtifact(transactionID string, data []byte, expectedSHA string) (string, error) {
	if digestBytes(data) != expectedSHA {
		return "", errors.New("downloaded target Manager checksum changed before staging")
	}
	rootFD, err := openAbsolute(driver.store.Root(), true)
	if err != nil {
		return "", fmt.Errorf("open handoff root: %w", err)
	}
	defer syscall.Close(rootFD)
	if err := requireExactOwnerDirectoryFD(rootFD); err != nil {
		return "", fmt.Errorf("validate handoff root: %w", err)
	}
	txFD, err := syscall.Openat(rootFD, transactionID, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return "", fmt.Errorf("open handoff transaction: %w", err)
	}
	defer syscall.Close(txFD)
	if err := requireExactOwnerDirectoryFD(txFD); err != nil {
		return "", fmt.Errorf("validate handoff transaction: %w", err)
	}
	artifactFD, err := ensureOwnerDirectoryAt(txFD, artifactDirectory)
	if err != nil {
		return "", fmt.Errorf("prepare source-owner artifact staging: %w", err)
	}
	defer syscall.Close(artifactFD)
	path := filepath.Join(driver.store.Root(), transactionID, artifactDirectory, artifactBasename)
	if existing, openErr := inspectRegular(path, driver.maxManagerArtifactBytes, true); openErr == nil {
		if existing.mode != ownerArtifactMode || existing.sha256 != expectedSHA {
			return "", errors.New("existing transaction Manager artifact has a conflicting identity")
		}
		return path, nil
	} else if !errors.Is(unwrapPathError(openErr), syscall.ENOENT) {
		return "", fmt.Errorf("inspect existing transaction Manager artifact: %w", openErr)
	}

	temporary, err := randomTemporaryName()
	if err != nil {
		return "", err
	}
	fd, err := syscall.Openat(artifactFD, temporary, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, ownerArtifactMode)
	if err != nil {
		return "", fmt.Errorf("create transaction Manager artifact: %w", err)
	}
	file := os.NewFile(uintptr(fd), temporary)
	if file == nil {
		_ = syscall.Close(fd)
		return "", errors.New("create transaction Manager artifact returned an invalid descriptor")
	}
	created, statErr := statFile(file)
	if statErr != nil {
		_ = file.Close()
		return "", statErr
	}
	committed := false
	defer func() {
		_ = file.Close()
		if !committed {
			_ = unlinkIfIdentity(artifactFD, temporary, created)
		}
	}()
	if created.Uid != uint32(os.Getuid()) || created.Nlink != 1 || created.Mode&syscall.S_IFMT != syscall.S_IFREG {
		return "", errors.New("new transaction Manager artifact has an unsafe identity")
	}
	if err := writeAll(file, data); err != nil {
		return "", fmt.Errorf("write transaction Manager artifact: %w", err)
	}
	if err := file.Sync(); err != nil {
		return "", fmt.Errorf("sync transaction Manager artifact: %w", err)
	}
	if err := file.Close(); err != nil {
		return "", fmt.Errorf("close transaction Manager artifact: %w", err)
	}
	if err := renameAtNoReplace(artifactFD, temporary, artifactBasename); err != nil {
		if errors.Is(err, syscall.EEXIST) {
			existing, inspectErr := inspectRegular(path, driver.maxManagerArtifactBytes, true)
			if inspectErr == nil && existing.mode == ownerArtifactMode && existing.sha256 == expectedSHA {
				_ = unlinkIfIdentity(artifactFD, temporary, created)
				committed = true
				return path, nil
			}
		}
		return "", fmt.Errorf("publish transaction Manager artifact: %w", err)
	}
	committed = true
	if err := syscall.Fsync(artifactFD); err != nil {
		return "", fmt.Errorf("sync transaction artifact directory: %w", err)
	}
	identity, err := inspectRegular(path, driver.maxManagerArtifactBytes, true)
	if err != nil || identity.mode != ownerArtifactMode || identity.sha256 != expectedSHA {
		return "", errors.New("published transaction Manager artifact failed identity verification")
	}
	return path, nil
}

func requireExactOwnerDirectoryFD(fd int) error {
	var stat syscall.Stat_t
	if err := syscall.Fstat(fd, &stat); err != nil {
		return err
	}
	if stat.Mode&syscall.S_IFMT != syscall.S_IFDIR || stat.Uid != uint32(os.Getuid()) || stat.Mode&0o777 != ownerDirectoryMode {
		return errors.New("directory is not an exact owner-only directory")
	}
	return nil
}

func ensureOwnerDirectoryAt(parentFD int, name string) (int, error) {
	if err := syscall.Mkdirat(parentFD, name, ownerDirectoryMode); err != nil && !errors.Is(err, syscall.EEXIST) {
		return -1, err
	}
	fd, err := syscall.Openat(parentFD, name, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return -1, err
	}
	if err := requireExactOwnerDirectoryFD(fd); err != nil {
		_ = syscall.Close(fd)
		return -1, err
	}
	if err := syscall.Fsync(parentFD); err != nil {
		_ = syscall.Close(fd)
		return -1, err
	}
	return fd, nil
}

func randomTemporaryName() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	const alphabet = "0123456789abcdef"
	encoded := make([]byte, len(raw)*2)
	for index, value := range raw {
		encoded[index*2] = alphabet[value>>4]
		encoded[index*2+1] = alphabet[value&15]
	}
	return ".target-manager." + string(encoded) + ".tmp", nil
}

func writeAll(file *os.File, data []byte) error {
	for len(data) > 0 {
		written, err := file.Write(data)
		if err != nil {
			return err
		}
		if written <= 0 {
			return io.ErrShortWrite
		}
		data = data[written:]
	}
	return nil
}

func unlinkIfIdentity(directoryFD int, name string, expected syscall.Stat_t) error {
	observed, err := lstatAt(directoryFD, name)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if observed.Dev != expected.Dev || observed.Ino != expected.Ino || observed.Uid != expected.Uid || observed.Mode != expected.Mode {
		return errors.New("refuse to remove a replaced temporary artifact")
	}
	if err := syscall.Unlinkat(directoryFD, name); err != nil {
		return err
	}
	return syscall.Fsync(directoryFD)
}

func unwrapPathError(err error) error {
	var pathErr *os.PathError
	if errors.As(err, &pathErr) {
		return pathErr.Err
	}
	return err
}
