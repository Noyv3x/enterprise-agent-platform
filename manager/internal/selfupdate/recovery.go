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
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/atomicfile"
	"github.com/ubitech/agent-platform/manager/internal/model"
)

const (
	recoveryMaxBinaryBytes = int64(128 << 20)
	recoveryMaxJSONBytes   = int64(8 << 20)
	recoveryRollbackTime   = 30 * time.Second
	recoveryHealthPoll     = 500 * time.Millisecond
	recoveryIdentityChecks = 7
)

// RecoverCurrent is the deliberately external escape hatch for a Current
// Manager which cannot stay alive long enough to self-update. The caller is a
// separately downloaded and checksum-verified Manager binary; normal updates
// must continue to use Prepare/Activate and the independent watchdog.
//
// The stable executable is the only pre-commit recovery marker. Before the
// final self-update state write it may contain either the old Current bytes or
// the requested recovery bytes, so interruption at every earlier boundary is
// safe to retry. Candidate/Activation state is rejected because that state is
// owned by the regular watchdog protocol.
func (m *Manager) RecoverCurrent(ctx context.Context, executablePath, platformStatePath, expectedSHA256 string) error {
	if !validSHA256(expectedSHA256) {
		return errors.New("expected Manager SHA-256 must be 64 lowercase hexadecimal characters")
	}
	if !validSourceCommit(m.RunningVersion) {
		return errors.New("recovery Manager version must be a 40-character lowercase source commit")
	}
	if err := validateRecoveryManagerPaths(m, platformStatePath); err != nil {
		return err
	}
	releaseLock, err := acquireRecoveryLock(m.Root)
	if err != nil {
		return err
	}
	defer releaseLock()
	unit := m.UnitName
	if unit == "" {
		unit = "ubitech-agent-manager.service"
	}
	if !validRecoveryUnit(unit) {
		return errors.New("Manager user service name is invalid")
	}

	originalStateData, state, err := readRecoverySelfUpdateState(m.StatePath)
	if err != nil {
		return err
	}
	if state.Candidate != nil || state.Activation != nil {
		return errors.New("refusing external recovery while a Manager candidate or activation is active")
	}
	if state.Current == nil {
		return errors.New("external recovery requires a registered Current Manager")
	}
	platformCommit, err := readRecoveryPlatformCommit(platformStatePath)
	if err != nil {
		return err
	}

	newBinary, _, err := readRecoveryRegularFile(executablePath, recoveryMaxBinaryBytes, false)
	if err != nil {
		return fmt.Errorf("validate recovery Manager executable: %w", err)
	}
	if len(newBinary) == 0 {
		return errors.New("recovery Manager executable is empty")
	}
	newSHA := sha256Hex(newBinary)
	if newSHA != expectedSHA256 {
		return fmt.Errorf("recovery Manager checksum mismatch: expected %s, found %s", expectedSHA256, newSHA)
	}

	oldCurrent := *state.Current
	if !validSourceCommit(oldCurrent.Version) || !validSourceCommit(oldCurrent.SourceCommit) || !oldCurrent.PlatformCommitted {
		return errors.New("registered Current Manager identity is incomplete")
	}
	oldBinary, _, err := readRecoveryRegularFile(oldCurrent.Path, recoveryMaxBinaryBytes, false)
	if err != nil {
		return fmt.Errorf("validate registered Current Manager: %w", err)
	}
	if !validSHA256(oldCurrent.SHA256) || sha256Hex(oldBinary) != oldCurrent.SHA256 {
		return errors.New("registered Current Manager checksum does not match its immutable executable")
	}
	if !pathWithin(filepath.Join(m.Root, "versions"), oldCurrent.Path) {
		return errors.New("registered Current Manager path is outside the Manager versions directory")
	}

	stableBinary, _, err := readRecoveryRegularFile(m.InstallPath, recoveryMaxBinaryBytes, false)
	if err != nil {
		return fmt.Errorf("validate stable Manager executable: %w", err)
	}
	stableSHA := sha256Hex(stableBinary)
	if stableSHA != oldCurrent.SHA256 && stableSHA != newSHA {
		return errors.New("stable Manager matches neither registered Current nor requested recovery executable")
	}
	if _, err := readRecoveryControlToken(m.ControlTokenFile); err != nil {
		return err
	}
	if oldCurrent.SHA256 != newSHA && recoveryManagerIdentityMatches(ctx, m.SocketPath, m.ControlTokenFile, oldCurrent.Version, oldCurrent.SHA256) {
		return errors.New("Current Manager control is healthy; use the normal update path instead of external recovery")
	}

	stagedPath, err := m.stageRecoveryBinary(newBinary, newSHA)
	if err != nil {
		return err
	}

	// A completed invocation is a safe no-op. Starting an already active unit is
	// idempotent and also recovers the narrow interruption after state commit but
	// before the caller observed success.
	if oldCurrent.SHA256 == newSHA && oldCurrent.SourceCommit == platformCommit && stableSHA == newSHA {
		if err := m.runner().Run(ctx, "systemctl", "--user", "start", unit); err != nil {
			return fmt.Errorf("ensure recovered Manager service is started: %w", err)
		}
		if err := waitRecoveryManagerIdentity(ctx, m.SocketPath, m.ControlTokenFile, m.RunningVersion, newSHA); err != nil {
			return fmt.Errorf("verify recovered Manager control health: %w", err)
		}
		if err := m.verifyRecoveryServiceProcess(ctx, unit, newSHA); err != nil {
			return fmt.Errorf("verify recovered Manager service process: %w", err)
		}
		return nil
	}

	if err := m.runner().Run(ctx, "systemctl", "--user", "stop", unit); err != nil {
		return errors.Join(
			fmt.Errorf("stop Current Manager service: %w", err),
			m.restoreRecoveryCurrent(oldBinary, unit),
		)
	}
	rollback := func(cause error) error {
		return errors.Join(cause, m.restoreRecoveryCurrent(oldBinary, unit))
	}
	if stableSHA != newSHA {
		if err := validateRecoveryWritableTarget(m.InstallPath); err != nil {
			return rollback(err)
		}
		if err := atomicfile.WriteFile(m.InstallPath, newBinary, 0o755); err != nil {
			return rollback(fmt.Errorf("replace stable Manager executable: %w", err))
		}
	}
	if !binaryMatches(m.InstallPath, newSHA) {
		return rollback(errors.New("stable Manager changed after recovery replacement"))
	}
	if err := m.runner().Run(ctx, "systemctl", "--user", "start", unit); err != nil {
		return rollback(fmt.Errorf("start recovered Manager service: %w", err))
	}
	if err := waitRecoveryManagerIdentity(ctx, m.SocketPath, m.ControlTokenFile, m.RunningVersion, newSHA); err != nil {
		return rollback(fmt.Errorf("wait for recovered Manager control health: %w", err))
	}
	if err := m.verifyRecoveryServiceProcess(ctx, unit, newSHA); err != nil {
		return rollback(fmt.Errorf("verify recovered Manager service process: %w", err))
	}

	// The running service must not have started a normal self-update while the
	// external transaction was in progress. Byte equality is intentional: the
	// final write is the first and only self-update state mutation by this path.
	latestStateData, latestState, err := readRecoverySelfUpdateState(m.StatePath)
	if err != nil {
		return rollback(fmt.Errorf("revalidate Manager state before recovery commit: %w", err))
	}
	if !bytes.Equal(latestStateData, originalStateData) || latestState.Candidate != nil || latestState.Activation != nil {
		return rollback(errors.New("Manager self-update state changed during external recovery"))
	}
	latestPlatformCommit, err := readRecoveryPlatformCommit(platformStatePath)
	if err != nil {
		return rollback(fmt.Errorf("revalidate Platform generation before recovery commit: %w", err))
	}
	if latestPlatformCommit != platformCommit {
		return rollback(errors.New("Platform generation changed during external Manager recovery"))
	}
	if !binaryMatches(m.InstallPath, newSHA) {
		return rollback(errors.New("stable Manager changed before recovery state commit"))
	}

	now := m.now()
	next := state
	next.Previous = &oldCurrent
	next.Current = &Version{
		Version:           m.RunningVersion,
		SourceCommit:      platformCommit,
		Path:              stagedPath,
		SHA256:            newSHA,
		VerifiedAt:        now,
		PlatformCommitted: true,
	}
	next.Candidate = nil
	next.Activation = nil
	next.UpdatedAt = now
	if err := atomicfile.WriteJSON(m.StatePath, next, 0o600); err != nil {
		stateRestoreErr := atomicfile.WriteFile(m.StatePath, originalStateData, 0o600)
		return errors.Join(
			fmt.Errorf("commit externally recovered Manager state: %w", err),
			wrapRecoveryError("restore Manager state after failed recovery commit", stateRestoreErr),
			m.restoreRecoveryCurrent(oldBinary, unit),
		)
	}
	return nil
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

func validateRecoveryManagerPaths(m *Manager, platformStatePath string) error {
	for name, path := range map[string]string{
		"Manager binary root":      m.Root,
		"Manager state":            m.StatePath,
		"stable Manager":           m.InstallPath,
		"Manager control socket":   m.SocketPath,
		"Manager control token":    m.ControlTokenFile,
		"Platform Manager journal": platformStatePath,
	} {
		if path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path {
			return fmt.Errorf("%s path must be absolute and canonical", name)
		}
	}
	stateDir := filepath.Dir(m.StatePath)
	if m.Root != filepath.Join(stateDir, "manager-binaries") {
		return errors.New("Manager binary root is inconsistent with Manager state path")
	}
	if platformStatePath != filepath.Join(stateDir, "state.json") {
		return errors.New("Platform Manager journal path is inconsistent with Manager state path")
	}
	if err := validateRecoveryDirectory(m.Root, true); err != nil {
		return fmt.Errorf("validate Manager binary root: %w", err)
	}
	if err := validateRecoveryDirectory(filepath.Dir(m.InstallPath), false); err != nil {
		return fmt.Errorf("validate stable Manager directory: %w", err)
	}
	return nil
}

func (m *Manager) stageRecoveryBinary(data []byte, digest string) (string, error) {
	versions := filepath.Join(m.Root, "versions")
	if err := validateRecoveryDirectory(versions, true); err != nil {
		return "", fmt.Errorf("validate Manager versions directory: %w", err)
	}
	dir := filepath.Join(versions, "recovery-"+digest[:12])
	if err := ensureRecoveryDirectory(dir); err != nil {
		return "", fmt.Errorf("prepare recovered Manager version directory: %w", err)
	}
	path := filepath.Join(dir, "ubitech-manager")
	if info, err := os.Lstat(path); err == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("recovered Manager version path is not a regular file")
		}
		current, _, readErr := readRecoveryRegularFile(path, recoveryMaxBinaryBytes, false)
		if readErr != nil {
			return "", readErr
		}
		if sha256Hex(current) != digest {
			return "", errors.New("immutable recovered Manager version has different contents")
		}
		return path, nil
	} else if !os.IsNotExist(err) {
		return "", err
	}
	if err := atomicfile.WriteFile(path, data, 0o700); err != nil {
		return "", fmt.Errorf("stage recovered Manager executable: %w", err)
	}
	if !binaryMatches(path, digest) {
		return "", errors.New("staged recovered Manager checksum mismatch")
	}
	return path, nil
}

func (m *Manager) restoreRecoveryCurrent(oldBinary []byte, unit string) error {
	ctx, cancel := context.WithTimeout(context.Background(), recoveryRollbackTime)
	defer cancel()
	stopErr := m.runner().Run(ctx, "systemctl", "--user", "stop", unit)
	writeErr := validateRecoveryWritableTarget(m.InstallPath)
	if writeErr == nil {
		writeErr = atomicfile.WriteFile(m.InstallPath, oldBinary, 0o755)
	}
	var startErr, healthErr error
	if writeErr == nil {
		startErr = m.runner().Run(ctx, "systemctl", "--user", "start", unit)
		if startErr == nil {
			healthErr = waitLegacyRecoveryManagerHealthy(ctx, m.SocketPath, m.ControlTokenFile)
		}
	}
	return errors.Join(
		wrapRecoveryError("stop failed recovered Manager", stopErr),
		wrapRecoveryError("restore previous stable Manager", writeErr),
		wrapRecoveryError("restart previous Manager", startErr),
		wrapRecoveryError("verify restored Manager control health", healthErr),
	)
}

func readRecoverySelfUpdateState(path string) ([]byte, State, error) {
	var state State
	data, _, err := readRecoveryRegularFile(path, recoveryMaxJSONBytes, true)
	if err != nil {
		return nil, state, fmt.Errorf("read Manager self-update state: %w", err)
	}
	if err := decodeRecoveryJSON(data, &state); err != nil {
		return nil, state, fmt.Errorf("decode Manager self-update state: %w", err)
	}
	if state.SchemaVersion != 1 {
		return nil, state, fmt.Errorf("unsupported Manager self-update schema %d", state.SchemaVersion)
	}
	return data, state, nil
}

func readRecoveryPlatformCommit(path string) (string, error) {
	var state model.ManagerState
	data, _, err := readRecoveryRegularFile(path, recoveryMaxJSONBytes, true)
	if err != nil {
		return "", fmt.Errorf("read Platform Manager journal: %w", err)
	}
	if err := decodeRecoveryJSON(data, &state); err != nil {
		return "", fmt.Errorf("decode Platform Manager journal: %w", err)
	}
	if state.SchemaVersion != 1 || state.Current == nil || !validSourceCommit(state.Current.SourceCommit) || state.Current.ID != state.Current.SourceCommit {
		return "", errors.New("Platform Manager journal has no valid Current source commit")
	}
	return state.Current.SourceCommit, nil
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
	if err := validateRecoveryOwner(path, info); err != nil {
		return nil, nil, err
	}
	if private {
		if info.Mode().Perm()&0o077 != 0 {
			return nil, nil, errors.New("private recovery file is accessible by another host identity")
		}
	} else if info.Mode().Perm()&0o022 != 0 {
		return nil, nil, errors.New("recovery file is writable by another host identity")
	}
	if info.Size() < 0 || info.Size() > maxBytes {
		return nil, nil, fmt.Errorf("recovery file exceeds %d-byte limit", maxBytes)
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil {
		return nil, nil, err
	}
	if !os.SameFile(info, opened) {
		return nil, nil, errors.New("recovery file changed while it was opened")
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

func validateRecoveryWritableTarget(path string) error {
	_, _, err := readRecoveryRegularFile(path, recoveryMaxBinaryBytes, false)
	if err != nil {
		return fmt.Errorf("revalidate stable Manager target: %w", err)
	}
	return nil
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

func ensureRecoveryDirectory(path string) error {
	parent := filepath.Dir(path)
	if err := validateRecoveryDirectory(parent, true); err != nil {
		return err
	}
	if err := os.Mkdir(path, 0o700); err != nil && !os.IsExist(err) {
		return err
	}
	return validateRecoveryDirectory(path, true)
}

func validateRecoveryOwner(path string, info os.FileInfo) error {
	metadata, ok := info.Sys().(*syscall.Stat_t)
	if !ok || metadata.Uid != uint32(os.Getuid()) {
		return fmt.Errorf("recovery path %s is not owned by the invoking user", path)
	}
	return nil
}

func waitRecoveryManagerIdentity(ctx context.Context, socketPath, tokenPath, expectedVersion, expectedSHA string) error {
	ticker := time.NewTicker(recoveryHealthPoll)
	defer ticker.Stop()
	consecutive := 0
	for {
		if recoveryManagerIdentityMatches(ctx, socketPath, tokenPath, expectedVersion, expectedSHA) {
			consecutive++
			if consecutive >= recoveryIdentityChecks {
				return nil
			}
		} else {
			consecutive = 0
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
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

func waitLegacyRecoveryManagerHealthy(ctx context.Context, socketPath, tokenPath string) error {
	ticker := time.NewTicker(recoveryHealthPoll)
	defer ticker.Stop()
	for {
		if legacyRecoveryManagerHealthy(ctx, socketPath, tokenPath) {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func legacyRecoveryManagerHealthy(ctx context.Context, socketPath, tokenPath string) bool {
	token, err := readRecoveryControlToken(tokenPath)
	if err != nil || validateRecoverySocket(socketPath) != nil {
		return false
	}
	requestCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{Timeout: time.Second}).DialContext(ctx, "unix", socketPath)
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second}
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, "http://manager/v1/status", nil)
	if err != nil {
		return false
	}
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := client.Do(request)
	if err != nil {
		return false
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4<<10))
	_ = response.Body.Close()
	return response.StatusCode == http.StatusOK
}

func (m *Manager) verifyRecoveryServiceProcess(ctx context.Context, unit, expectedSHA string) error {
	if m.RecoveryProcessVerifier != nil {
		return m.RecoveryProcessVerifier(ctx, unit, m.InstallPath, expectedSHA)
	}
	if err := exec.CommandContext(ctx, "systemctl", "--user", "is-active", "--quiet", unit).Run(); err != nil {
		return fmt.Errorf("Manager service is not active: %w", err)
	}
	output, err := exec.CommandContext(ctx, "systemctl", "--user", "show", unit, "--property=MainPID", "--value").Output()
	if err != nil {
		return fmt.Errorf("read Manager service MainPID: %w", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(output)))
	if err != nil || pid <= 1 {
		return errors.New("Manager service has no valid MainPID")
	}
	processExecutable := filepath.Join("/proc", strconv.Itoa(pid), "exe")
	processSHA, err := fileSHA256(processExecutable)
	if err != nil {
		return fmt.Errorf("hash Manager service executable: %w", err)
	}
	if processSHA != expectedSHA {
		return fmt.Errorf("Manager service executable checksum mismatch: expected %s, found %s", expectedSHA, processSHA)
	}
	stableInfo, err := os.Stat(m.InstallPath)
	if err != nil {
		return fmt.Errorf("inspect stable Manager executable: %w", err)
	}
	processInfo, err := os.Stat(processExecutable)
	if err != nil {
		return fmt.Errorf("inspect Manager service executable: %w", err)
	}
	if !os.SameFile(stableInfo, processInfo) {
		return errors.New("Manager service MainPID is not executing the stable candidate inode")
	}
	return nil
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

func pathWithin(root, path string) bool {
	if !filepath.IsAbs(root) || !filepath.IsAbs(path) {
		return false
	}
	relative, err := filepath.Rel(filepath.Clean(root), filepath.Clean(path))
	return err == nil && relative != "." && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
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

func validRecoveryUnit(value string) bool {
	if !strings.HasSuffix(value, ".service") || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if !(character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' || character == '-' || character == '_' || character == '.' || character == '@') {
			return false
		}
	}
	return true
}

func wrapRecoveryError(message string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s: %w", message, err)
}
