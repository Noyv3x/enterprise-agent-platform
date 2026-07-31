//go:build linux

package selfupdate

import (
	"errors"
	"fmt"
	"io"
	"os"
	"syscall"
)

// readBoundRunningExecutable proves that runningPath and immutablePath name
// the same retained regular-file inode and that the executing bytes have the
// expected digest. The final path observation closes replacement races after
// both descriptors have been read. Returned bytes always come from the
// running descriptor rather than from a replaceable pathname.
func readBoundRunningExecutable(runningPath, immutablePath, expectedSHA string) ([]byte, error) {
	if !validSHA256(expectedSHA) {
		return nil, errors.New("running Manager executable checksum is invalid")
	}
	immutableBytes, immutableInfo, err := readRecoveryRegularFile(immutablePath, recoveryMaxBinaryBytes, false)
	if err != nil {
		return nil, fmt.Errorf("open immutable Manager executable: %w", err)
	}
	if sha256Hex(immutableBytes) != expectedSHA {
		return nil, errors.New("immutable Manager executable checksum differs from its owner record")
	}

	fd, err := syscall.Open(runningPath, syscall.O_RDONLY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("open running Manager executable: %w", err)
	}
	running := os.NewFile(uintptr(fd), runningPath)
	if running == nil {
		_ = syscall.Close(fd)
		return nil, errors.New("open running Manager executable: invalid file descriptor")
	}
	defer running.Close()
	runningInfo, err := running.Stat()
	if err != nil {
		return nil, fmt.Errorf("inspect running Manager executable: %w", err)
	}
	if !runningInfo.Mode().IsRegular() || !os.SameFile(immutableInfo, runningInfo) {
		return nil, errors.New("running Manager executable is not the immutable owner inode")
	}
	runningBytes, err := io.ReadAll(io.LimitReader(running, recoveryMaxBinaryBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read running Manager executable: %w", err)
	}
	if int64(len(runningBytes)) > recoveryMaxBinaryBytes {
		return nil, fmt.Errorf("running Manager executable exceeds %d-byte limit", recoveryMaxBinaryBytes)
	}
	if sha256Hex(runningBytes) != expectedSHA {
		return nil, errors.New("running Manager executable checksum differs from its owner record")
	}
	latest, err := os.Lstat(immutablePath)
	if err != nil {
		return nil, fmt.Errorf("reinspect immutable Manager executable: %w", err)
	}
	if latest.Mode()&os.ModeSymlink != 0 || !latest.Mode().IsRegular() || !os.SameFile(immutableInfo, latest) {
		return nil, errors.New("immutable Manager executable path changed during identity proof")
	}
	return runningBytes, nil
}
