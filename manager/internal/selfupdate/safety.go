package selfupdate

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const recoveryMaxBinaryBytes = 128 << 20
const recoveryMaxJSONBytes = 1 << 20

func withOrdinaryActivationMutationLock(planPath string, mutate func() error) error {
	if planPath == "" || !filepath.IsAbs(planPath) || filepath.Clean(planPath) != planPath {
		return errors.New("ordinary Manager activation plan path is invalid")
	}
	lockPath := planPath + ".lock"
	fd, err := syscall.Open(lockPath, syscall.O_CREAT|syscall.O_RDWR|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return fmt.Errorf("open ordinary Manager activation lock: %w", err)
	}
	file := os.NewFile(uintptr(fd), lockPath)
	if file == nil {
		_ = syscall.Close(fd)
		return errors.New("open ordinary Manager activation lock: invalid file descriptor")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return fmt.Errorf("inspect ordinary Manager activation lock: %w", err)
	}
	if !info.Mode().IsRegular() {
		return errors.New("ordinary Manager activation lock is not a regular file")
	}
	if err := validateRecoveryOwner(lockPath, info); err != nil {
		return err
	}
	if info.Mode().Perm()&0o077 != 0 {
		return errors.New("ordinary Manager activation lock is accessible by another host identity")
	}
	if err := file.Chmod(0o600); err != nil {
		return fmt.Errorf("restrict ordinary Manager activation lock: %w", err)
	}
	if err := syscall.Flock(fd, syscall.LOCK_EX); err != nil {
		return fmt.Errorf("lock ordinary Manager activation plan: %w", err)
	}
	defer syscall.Flock(fd, syscall.LOCK_UN) //nolint:errcheck -- best-effort unlock while closing the descriptor
	return mutate()
}
func waitRecoveryLock(ctx context.Context, root string) (func(), error) {
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		release, err := acquireRecoveryLock(root)
		if err == nil {
			return release, nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, err
		}
		timer := time.NewTimer(10 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}
func acquireRecoveryLock(root string) (func(), error) {
	path := filepath.Join(root, "recovery.lock")
	fd, err := syscall.Open(path, syscall.O_CREAT|syscall.O_RDWR|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open external recovery lock: %w", err)
	}
	file := os.NewFile(uintptr(fd), path)
	if file == nil {
		_ = syscall.Close(fd)
		return nil, errors.New("open external recovery lock: invalid file descriptor")
	}
	closeFile := true
	defer func() {
		if closeFile {
			_ = file.Close()
		}
	}()
	info, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("inspect external recovery lock: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("external recovery lock is not a regular file")
	}
	if err := validateRecoveryOwner(path, info); err != nil {
		return nil, err
	}
	if info.Mode().Perm()&0o077 != 0 {
		return nil, errors.New("external recovery lock is accessible by another host identity")
	}
	if err := file.Chmod(0o600); err != nil {
		return nil, fmt.Errorf("restrict external recovery lock: %w", err)
	}
	if err := syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return nil, fmt.Errorf("another external Manager recovery is already running: %w", err)
	}
	closeFile = false
	return func() {
		_ = syscall.Flock(fd, syscall.LOCK_UN)
		_ = file.Close()
	}, nil
}
func decodeRecoveryJSON(data []byte, value any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(value); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("trailing JSON value")
		}
		return err
	}
	return nil
}

func readRecoveryControlToken(path string) (string, error) {
	data, _, err := readRecoveryRegularFile(path, 4096, true)
	if err != nil {
		return "", fmt.Errorf("validate Manager control token: %w", err)
	}
	value := strings.TrimSpace(string(data))
	if len(value) < 32 || strings.ContainsAny(value, " \t\r\n\x00") {
		return "", errors.New("Manager control token is invalid")
	}
	return value, nil
}

func readRecoveryRegularFile(path string, maxBytes int64, private bool) ([]byte, os.FileInfo, error) {
	if path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, nil, errors.New("path must be absolute and canonical")
	}
	if err := validateRecoveryDirectory(filepath.Dir(path), private); err != nil {
		return nil, nil, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, nil, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return nil, nil, errors.New("path must be a non-symlink regular file")
	}
	return readRecoveryInspectedFile(path, info, maxBytes, private)
}

// readRecoveryInspectedFile opens the inspected path without following a
// replacement symlink or waiting for a replacement FIFO, then trusts only the fd.
func readRecoveryInspectedFile(path string, info os.FileInfo, maxBytes int64, private bool) ([]byte, os.FileInfo, error) {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	if file == nil {
		_ = syscall.Close(fd)
		return nil, nil, errors.New("open recovery file: invalid file descriptor")
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil {
		return nil, nil, err
	}
	if !opened.Mode().IsRegular() {
		return nil, nil, errors.New("path must be a non-symlink regular file")
	}
	if !os.SameFile(info, opened) {
		return nil, nil, errors.New("recovery file changed while it was opened")
	}
	if err := validateRecoveryOwner(path, opened); err != nil {
		return nil, nil, err
	}
	if private {
		if opened.Mode().Perm()&0o077 != 0 {
			return nil, nil, errors.New("private recovery file is accessible by another host identity")
		}
	} else if opened.Mode().Perm()&0o022 != 0 {
		return nil, nil, errors.New("recovery file is writable by another host identity")
	}
	if opened.Size() < 0 || opened.Size() > maxBytes {
		return nil, nil, fmt.Errorf("recovery file exceeds %d-byte limit", maxBytes)
	}
	data, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return nil, nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, nil, fmt.Errorf("recovery file exceeds %d-byte limit", maxBytes)
	}
	return data, opened, nil
}
func validateRecoveryDirectory(path string, private bool) error {
	if path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return errors.New("directory path must be absolute and canonical")
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return err
	}
	if resolved != path {
		return errors.New("directory path contains a symbolic link")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("path must be a non-symlink directory")
	}
	if err := validateRecoveryOwner(path, info); err != nil {
		return err
	}
	if private {
		if info.Mode().Perm()&0o077 != 0 {
			return errors.New("private recovery directory is accessible by another host identity")
		}
	} else if info.Mode().Perm()&0o022 != 0 {
		return errors.New("recovery directory is writable by another host identity")
	}
	return nil
}

func validateRecoveryOwner(path string, info os.FileInfo) error {
	metadata, ok := info.Sys().(*syscall.Stat_t)
	if !ok || metadata.Uid != uint32(os.Getuid()) {
		return fmt.Errorf("recovery path %s is not owned by the invoking user", path)
	}
	return nil
}
func recoveryManagerIdentityMatches(ctx context.Context, socketPath, tokenPath, expectedVersion, expectedSHA string) bool {
	token, err := readRecoveryControlToken(tokenPath)
	if err != nil {
		return false
	}
	if err := validateRecoverySocket(socketPath); err != nil {
		return false
	}
	requestCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{Timeout: time.Second}).DialContext(ctx, "unix", socketPath)
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 2 * time.Second}
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, "http://manager/v1/identity", nil)
	if err != nil {
		return false
	}
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := client.Do(request)
	if err != nil {
		return false
	}
	data, readErr := io.ReadAll(io.LimitReader(response.Body, (4<<10)+1))
	_ = response.Body.Close()
	if readErr != nil || response.StatusCode != http.StatusOK || len(data) > 4<<10 {
		return false
	}
	var identity struct {
		Status  string `json:"status"`
		Version string `json:"version"`
		SHA256  string `json:"sha256"`
	}
	if decodeRecoveryJSON(data, &identity) != nil {
		return false
	}
	return identity.Status == "healthy" && identity.Version == expectedVersion && identity.SHA256 == expectedSHA
}
func validateRecoverySocket(path string) error {
	if path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return errors.New("Manager control socket path must be absolute and canonical")
	}
	if err := validateRecoveryDirectory(filepath.Dir(path), true); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSocket == 0 || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("Manager control path is not a Unix socket")
	}
	if info.Mode().Perm()&0o077 != 0 {
		return errors.New("Manager control socket is accessible by another host identity")
	}
	return validateRecoveryOwner(path, info)
}

func validSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, character := range value {
		if !(character >= '0' && character <= '9' || character >= 'a' && character <= 'f') {
			return false
		}
	}
	return true
}

func validSourceCommit(value string) bool {
	if len(value) != 40 {
		return false
	}
	for _, character := range value {
		if !(character >= '0' && character <= '9' || character >= 'a' && character <= 'f') {
			return false
		}
	}
	return true
}
