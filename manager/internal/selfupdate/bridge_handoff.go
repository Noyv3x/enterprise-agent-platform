package selfupdate

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
)

var ErrBridgeNotReady = errors.New("legacy Manager watchdog has not exited")

type bridgeHandoff struct {
	UnitPath    string  `json:"unit_path"`
	Original    []byte  `json:"original"`
	Replacement []byte  `json:"replacement"`
	Launcher    Version `json:"launcher"`
	Stable      Version `json:"stable"`
	Status      string  `json:"status"`
	Error       string  `json:"error,omitempty"`
}

func (m *Manager) bridgeHandoffPath() string { return filepath.Join(m.Root, "bridge-handoff.json") }

// BridgeAdmissionReady keeps the original stable bridge protected until the
// supervisor proof AND the handoff worker's terminal checkpoint are durable.
func (m *Manager) BridgeAdmissionReady() (bool, error) {
	launcher, err := m.readLauncher()
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil || !launcher.Proven {
		return false, err
	}
	record, err := m.readBridgeHandoff()
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil || record.Status != "proven" {
		return false, err
	}
	if record.Launcher.Path != filepath.Join(m.Root, "launcher") ||
		record.Launcher.Path != launcher.Launcher.Path ||
		record.Launcher.SHA256 != launcher.Launcher.SHA256 ||
		record.Launcher.Version != launcher.Launcher.Version {
		return false, errors.New("Manager handoff proof does not bind the immutable launcher")
	}
	return true, nil
}

// BeginBridgeHandoff is called with operation admission held. The independent
// process, not the service being stopped, owns reload, restart and recovery.
func (m *Manager) BeginBridgeHandoff(ctx context.Context) error {
	proven, err := m.BridgeAdmissionReady()
	if err != nil || proven {
		return err
	}
	if _, err := os.Lstat(m.bridgeHandoffPath()); err == nil {
		return m.ResumeBridgeHandoff(ctx)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := m.bridgeLegacySettled(ctx); err != nil {
		return err
	}
	lease, err := m.AcquireStartupOwnership()
	if err != nil {
		return err
	}
	defer lease.Release()
	if !lease.RetainsRecoveryLock() {
		return errors.New("external Manager recovery owns launcher handoff")
	}
	unitPath, err := recoverySystemdProperty(ctx, m.recoveryUnitName(), "FragmentPath")
	if err != nil {
		return err
	}
	original, err := readBridgePrivateFile(unitPath)
	if err != nil {
		return fmt.Errorf("validate private Manager unit: %w", err)
	}
	if _, err := readBridgePrivateFile(m.ConfigPath); err != nil {
		return err
	}
	lease.Release()
	launcher, err := m.StageLauncher()
	if err != nil {
		return err
	}
	_, state, err := readRecoverySelfUpdateState(m.StatePath)
	if err != nil || state.Current == nil {
		return errors.New("handoff requires settled current Manager")
	}
	replacement, err := bridgeUnit(original, m.InstallPath, launcher.Path, m.ConfigPath)
	if err != nil {
		return err
	}
	verifyDir := filepath.Join(m.Root, "handoff-unit")
	if err := os.MkdirAll(verifyDir, 0o700); err != nil {
		return err
	}
	verifyPath := filepath.Join(verifyDir, m.recoveryUnitName())
	if err := atomicfile.WriteFile(verifyPath, replacement, 0o600); err != nil {
		return err
	}
	if err := m.runner().Run(ctx, "systemd-analyze", "--user", "verify", verifyPath); err != nil {
		return fmt.Errorf("verify launcher unit: %w", err)
	}
	record := bridgeHandoff{UnitPath: unitPath, Original: original, Replacement: replacement, Launcher: launcher, Stable: *state.Current, Status: "prepared"}
	if err := atomicfile.WriteJSON(m.bridgeHandoffPath(), record, 0o600); err != nil {
		return err
	}
	lease.Release()
	return m.ResumeBridgeHandoff(ctx)
}

func bridgeUnit(original []byte, stable, launcher, config string) ([]byte, error) {
	for _, path := range []string{stable, launcher, config} {
		if !filepath.IsAbs(path) || filepath.Clean(path) != path || strings.ContainsAny(path, "\x00\n\r\t\"\\%$") {
			return nil, errors.New("unit executable/config path is not safely representable")
		}
	}
	lines := strings.Split(string(original), "\n")
	count, restartCount := 0, 0
	section := ""
	for index, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") {
			section = trimmed
		}
		if strings.HasPrefix(trimmed, "Restart=") {
			if section != "[Service]" || trimmed != "Restart=on-failure" {
				return nil, errors.New("Manager unit restart policy is not on-failure")
			}
			restartCount++
		}
		if strings.HasPrefix(trimmed, "ExecStart=") {
			if section != "[Service]" || (trimmed != "ExecStart="+stable+" serve --config "+config && trimmed != "ExecStart=\""+stable+"\" serve --config \""+config+"\"") {
				return nil, errors.New("Manager unit does not contain the exact legacy service command")
			}
			count++
			lines[index] = "ExecStart=\"" + launcher + "\" launcher --config \"" + config + "\""
		}
	}
	if count != 1 || restartCount != 1 {
		return nil, errors.New("Manager unit has an unsupported service/restart contract")
	}
	return []byte(strings.Join(lines, "\n")), nil
}

func (m *Manager) bridgeLegacySettled(ctx context.Context) error {
	_, _, alive, err := recoveryAnyWatchdogProcess()
	if err != nil {
		return err
	}
	if alive {
		return ErrBridgeNotReady
	}
	// Only legacy watchdog units are observed here; never stop or collect a
	// live old watchdog, including one in systemd's deactivating state.
	output, err := exec.CommandContext(ctx, "systemctl", "--user", "list-units", "--plain", "--no-legend", "--state=active,activating,reloading,deactivating", m.watchdogUnitPrefix()+"*", m.recoveryWatchdogUnitPrefix()+"*").CombinedOutput()
	if err != nil {
		return fmt.Errorf("observe legacy watchdog units: %w: %s", err, strings.TrimSpace(string(output)))
	}
	if strings.TrimSpace(string(output)) != "" {
		return ErrBridgeNotReady
	}
	_, binaries, err := readRecoverySelfUpdateState(m.StatePath)
	if err != nil {
		return err
	}
	if binaries.Activation != nil || binaries.Candidate != nil || binaries.Current == nil {
		return errors.New("legacy Manager activation remains unsettled")
	}
	data, _, err := readRecoveryRegularFile(filepath.Join(filepath.Dir(m.StatePath), "state.json"), 1<<20, true)
	if err != nil {
		return err
	}
	var state model.ManagerState
	if err := json.Unmarshal(data, &state); err != nil {
		return err
	}
	return bridgePlatformSettled(state)
}

func bridgePlatformSettled(state model.ManagerState) error {
	// /check publishes a catalog candidate without owning a transaction.
	// Only durable operation owners/maintenance, plus the binary activation
	// checked by the caller, exclude supervisor handoff.
	if state.SchemaVersion != 1 || state.Current == nil || state.ActiveOperationID != "" || state.FinalizePendingOperationID != "" || state.Maintenance {
		return errors.New("legacy operation and Platform gate are not settled")
	}
	return nil
}

// RunBridgeHandoff runs outside the service cgroup and is bounded even when
// the new launcher or child never reaches readiness.
func (m *Manager) RunBridgeHandoff(parent context.Context) error {
	release, err := m.acquireBridgeWorker()
	if errors.Is(err, syscall.EWOULDBLOCK) {
		return nil
	}
	if err != nil {
		return err
	}
	defer release()
	ctx, cancel := context.WithTimeout(parent, 90*time.Second)
	defer cancel()
	record, err := m.readBridgeHandoff()
	if err != nil {
		return err
	}
	if record.Status == "proven" || record.Status == "failed" {
		return m.disableBridgeRecovery(ctx, record)
	}
	unitPath, err := recoverySystemdProperty(ctx, m.recoveryUnitName(), "FragmentPath")
	if err != nil || unitPath != record.UnitPath {
		return errors.New("Manager unit fragment binding mismatch")
	}
	actual, err := readBridgePrivateFile(record.UnitPath)
	if err != nil {
		return err
	}
	if err := validateBridgeCheckpoint(record, actual); err != nil {
		return err
	}
	if record.Launcher.Path != filepath.Join(m.Root, "launcher") {
		return errors.New("Manager launcher path binding mismatch")
	}
	expected, err := bridgeUnit(record.Original, m.InstallPath, record.Launcher.Path, m.ConfigPath)
	if err != nil || !bytes.Equal(expected, record.Replacement) {
		return errors.New("Manager launcher replacement unit binding mismatch")
	}
	if err := bridgeVerifyBinary(m.InstallPath, record.Stable); err != nil {
		return err
	}
	if record.Status == "recovering" {
		return m.recoverBridgeHandoff(record, errors.New(record.Error))
	}
	if err := m.bridgeLegacySettled(ctx); err != nil {
		return err
	}
	if err := bridgeVerifyBinary(record.Launcher.Path, record.Launcher); err != nil {
		return m.recoverBridgeHandoff(record, fmt.Errorf("immutable launcher is unavailable: %w", err))
	}
	var switchErr error
	if record.Status == "prepared" {
		lease, err := m.AcquireStartupOwnership()
		if err != nil {
			return err
		}
		if !lease.RetainsRecoveryLock() {
			lease.Release()
			return errors.New("external Manager recovery owns launcher handoff")
		}
		record.Status = "switching"
		err = atomicfile.WriteJSON(m.bridgeHandoffPath(), record, 0o600)
		lease.Release()
		if err != nil {
			return err
		}
		switchErr = atomicfile.WriteFile(record.UnitPath, record.Replacement, 0o600)
		if switchErr == nil {
			switchErr = m.runner().Run(ctx, "systemctl", "--user", "daemon-reload")
		}
		if switchErr == nil {
			switchErr = m.runner().Run(ctx, "systemctl", "--user", "restart", "--no-block", m.recoveryUnitName())
		}
	} else if bytes.Equal(actual, record.Original) {
		// The switch checkpoint preceded the unit write, or recovery already
		// restored it. Never repeat an interrupted switch.
		switchErr = errors.New("Manager launcher handoff was interrupted before unit switch")
	}
	if switchErr == nil {
		for {
			switchErr = m.ConfirmLauncherHandoff(ctx)
			if switchErr == nil || ctx.Err() != nil {
				break
			}
			select {
			case <-ctx.Done():
			case <-time.After(250 * time.Millisecond):
			}
		}
	}
	if switchErr == nil {
		record.Status = "proven"
		return m.finishBridgeHandoff(ctx, record)
	}
	return m.recoverBridgeHandoff(record, switchErr)
}

func (m *Manager) recoverBridgeHandoff(record bridgeHandoff, cause error) error {
	recovery, stop := context.WithTimeout(context.Background(), 60*time.Second)
	defer stop()
	record.Status, record.Error = "recovering", cause.Error()
	if err := atomicfile.WriteJSON(m.bridgeHandoffPath(), record, 0o600); err != nil {
		return errors.Join(cause, err)
	}
	if err := bridgeVerifyBinary(m.InstallPath, record.Stable); err != nil {
		return errors.Join(cause, err)
	}
	if err := atomicfile.WriteFile(record.UnitPath, record.Original, 0o600); err != nil {
		return errors.Join(cause, err)
	}
	if err := m.runner().Run(recovery, "systemctl", "--user", "daemon-reload"); err != nil {
		return errors.Join(cause, err)
	}
	// A corrupt launcher may have exhausted the main unit's start limit.
	// This is one verified original-unit recovery attempt, not a retry loop.
	if err := m.runner().Run(recovery, "systemctl", "--user", "reset-failed", m.recoveryUnitName()); err != nil {
		return errors.Join(cause, err)
	}
	if err := m.runner().Run(recovery, "systemctl", "--user", "restart", "--no-block", m.recoveryUnitName()); err != nil {
		return errors.Join(cause, err)
	}
	for recovery.Err() == nil {
		active, _ := m.recoveryUnitIsActive(recovery, m.recoveryUnitName())
		if err := m.verifyRecoveryServiceProcess(recovery, m.recoveryUnitName(), record.Stable.SHA256); err == nil && active && managerHealthy(recovery, m.SocketPath, m.ControlTokenFile, record.Stable.Version, record.Stable.SHA256) {
			record.Status = "failed"
			return m.finishBridgeHandoff(recovery, record)
		}
		select {
		case <-recovery.Done():
		case <-time.After(250 * time.Millisecond):
		}
	}
	record.Status = "failed"
	record.Error += ": saved Manager unit recovery could not be proven"
	return errors.Join(cause, m.finishBridgeHandoff(context.Background(), record), errors.New(record.Error))
}

func validateBridgeCheckpoint(record bridgeHandoff, actual []byte) error {
	switch record.Status {
	case "prepared":
		if bytes.Equal(actual, record.Original) {
			return nil
		}
	case "switching", "recovering":
		if bytes.Equal(actual, record.Original) || bytes.Equal(actual, record.Replacement) {
			return nil
		}
	default:
		return errors.New("unknown Manager handoff checkpoint")
	}
	return errors.New("Manager unit changed outside the recorded handoff")
}

func (m *Manager) readBridgeHandoff() (bridgeHandoff, error) {
	var record bridgeHandoff
	data, _, err := readRecoveryRegularFile(m.bridgeHandoffPath(), 3<<20, true)
	if err == nil {
		err = json.Unmarshal(data, &record)
	}
	return record, err
}

// RetryBridgeHandoff is an explicit operator action, never called by startup.
// Only a recovered failed checkpoint may be re-armed for one new switch.
func (m *Manager) RetryBridgeHandoff(ctx context.Context) error {
	release, err := m.acquireBridgeWorker()
	if err != nil {
		return fmt.Errorf("exclude active Manager handoff worker: %w", err)
	}
	defer release()
	record, err := m.readBridgeHandoff()
	if err != nil {
		return err
	}
	proven, err := m.LauncherEnabled()
	if err != nil {
		return err
	}
	unitPath, err := recoverySystemdProperty(ctx, m.recoveryUnitName(), "FragmentPath")
	if err != nil || unitPath != record.UnitPath {
		return errors.New("Manager retry unit fragment binding mismatch")
	}
	actual, err := readBridgePrivateFile(unitPath)
	if err != nil {
		return err
	}
	if err := validateBridgeRetry(record, actual, proven); err != nil {
		return err
	}
	workerState, err := recoverySystemdProperty(ctx, m.recoveryUnitName()+"-bridge-handoff.service", "ActiveState")
	if err != nil {
		return err
	}
	if workerState != "inactive" && workerState != "failed" {
		return errors.New("Manager handoff worker has not exited")
	}
	if err := m.bridgeLegacySettled(ctx); err != nil {
		return err
	}
	lease, err := m.AcquireStartupOwnership()
	if err != nil {
		return err
	}
	defer lease.Release()
	if !lease.RetainsRecoveryLock() {
		return errors.New("external Manager recovery owns launcher retry")
	}
	if _, err := readBridgePrivateFile(m.ConfigPath); err != nil {
		return err
	}
	if record.Launcher.Path != filepath.Join(m.Root, "launcher") {
		return errors.New("Manager retry launcher path mismatch")
	}
	expected, err := bridgeUnit(record.Original, m.InstallPath, record.Launcher.Path, m.ConfigPath)
	if err != nil || !bytes.Equal(expected, record.Replacement) {
		return errors.New("Manager retry replacement unit binding mismatch")
	}
	if err := bridgeVerifyBinary(record.Launcher.Path, record.Launcher); err != nil {
		return err
	}
	if err := bridgeVerifyBinary(m.InstallPath, record.Stable); err != nil {
		return err
	}
	active, err := m.recoveryUnitIsActive(ctx, m.recoveryUnitName())
	if err != nil || !active {
		return errors.New("original Manager service is not active")
	}
	if err := m.verifyRecoveryServiceProcess(ctx, m.recoveryUnitName(), record.Stable.SHA256); err != nil {
		return err
	}
	if !managerHealthy(ctx, m.SocketPath, m.ControlTokenFile, record.Stable.Version, record.Stable.SHA256) {
		return errors.New("original Manager authenticated identity is not healthy")
	}
	if workerState == "failed" {
		if err := m.runner().Run(ctx, "systemctl", "--user", "reset-failed", m.recoveryUnitName()+"-bridge-handoff.service"); err != nil {
			return err
		}
	}
	record.Status, record.Error = "prepared", ""
	if err := atomicfile.WriteJSON(m.bridgeHandoffPath(), record, 0o600); err != nil {
		return err
	}
	lease.Release()
	release()
	return m.ResumeBridgeHandoff(ctx)
}

func validateBridgeRetry(record bridgeHandoff, actual []byte, proven bool) error {
	if record.Status != "failed" || proven {
		return errors.New("only an unproven failed Manager handoff can be explicitly retried")
	}
	if !bytes.Equal(actual, record.Original) {
		return errors.New("Manager handoff retry requires the exact recovered original unit")
	}
	return nil
}

// ResumeBridgeHandoff is also called before the launcher starts its child, so
// recovery survives a reboot even when no healthy serve process can start.
func (m *Manager) ResumeBridgeHandoff(ctx context.Context) error {
	record, err := m.readBridgeHandoff()
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	switch record.Status {
	case "proven", "failed":
		return nil
	case "prepared", "switching", "recovering":
	default:
		return errors.New("unknown Manager handoff checkpoint")
	}
	if record.Launcher.Path != filepath.Join(m.Root, "launcher") {
		return errors.New("Manager handoff launcher path mismatch")
	}
	if err := bridgeVerifyBinary(m.InstallPath, record.Stable); err != nil {
		return err
	}
	unit := m.recoveryUnitName() + "-bridge-handoff.service"
	if active, err := recoverySystemdProperty(ctx, unit, "ActiveState"); err == nil && (active == "active" || active == "activating" || active == "deactivating") {
		return nil
	}
	if err := m.installBridgeRecovery(ctx, record); err != nil {
		return err
	}
	err = m.runner().Run(ctx, "systemctl", "--user", "start", "--no-block", unit)
	if err != nil {
		if active, inspectErr := recoverySystemdProperty(ctx, unit, "ActiveState"); inspectErr == nil && (active == "active" || active == "activating") {
			return nil
		}
	}
	return err
}

func (m *Manager) bridgeRecoveryUnitPath(record bridgeHandoff) string {
	return filepath.Join(filepath.Dir(record.UnitPath), m.recoveryUnitName()+"-bridge-handoff.service")
}

// The recovery entrypoint is enabled before changing the main unit and executes
// the verified stable bridge, not the new launcher. It therefore survives reboot
// and can restore the old unit even when the launcher cannot be executed.
func (m *Manager) installBridgeRecovery(ctx context.Context, record bridgeHandoff) error {
	fragment, err := recoverySystemdProperty(ctx, m.recoveryUnitName(), "FragmentPath")
	if err != nil || fragment != record.UnitPath {
		return errors.New("Manager recovery unit fragment binding mismatch")
	}
	if _, err := bridgeUnit(record.Original, m.InstallPath, record.Launcher.Path, m.ConfigPath); err != nil {
		return err
	}
	path := m.bridgeRecoveryUnitPath(record)
	if err := validateRecoveryDirectory(filepath.Dir(path), false); err != nil {
		return err
	}
	data := []byte("[Unit]\nDescription=Manager launcher handoff recovery\nBefore=" + m.recoveryUnitName() +
		"\nStartLimitBurst=2\nStartLimitIntervalSec=300\n\n[Service]\nType=exec\nExecStart=\"" + m.InstallPath +
		"\" bridge-handoff --config \"" + m.ConfigPath +
		"\"\nRestart=on-failure\nRestartSec=1\nRuntimeMaxSec=180\n\n[Install]\nWantedBy=default.target\n")
	if existing, err := readBridgePrivateFile(path); err == nil {
		if !bytes.Equal(existing, data) {
			return errors.New("Manager handoff recovery unit was changed")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	} else if err := atomicfile.WriteFile(path, data, 0o600); err != nil {
		return err
	}
	if err := m.runner().Run(ctx, "systemd-analyze", "--user", "verify", path); err != nil {
		return err
	}
	if err := m.runner().Run(ctx, "systemctl", "--user", "daemon-reload"); err != nil {
		return err
	}
	return m.runner().Run(ctx, "systemctl", "--user", "enable", path)
}

func (m *Manager) finishBridgeHandoff(ctx context.Context, record bridgeHandoff) error {
	if err := atomicfile.WriteJSON(m.bridgeHandoffPath(), record, 0o600); err != nil {
		return err
	}
	return m.disableBridgeRecovery(ctx, record)
}

func (m *Manager) disableBridgeRecovery(parent context.Context, record bridgeHandoff) error {
	if _, err := readBridgePrivateFile(m.bridgeRecoveryUnitPath(record)); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	return m.runner().Run(ctx, "systemctl", "--user", "disable", m.recoveryUnitName()+"-bridge-handoff.service")
}

func (m *Manager) acquireBridgeWorker() (func(), error) {
	if err := validateRecoveryDirectory(m.Root, true); err != nil {
		return nil, err
	}
	path := filepath.Join(m.Root, "bridge-handoff.lock")
	fd, err := syscall.Open(path, syscall.O_CREAT|syscall.O_RDWR|syscall.O_CLOEXEC|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0o600)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	info, err := file.Stat()
	if err == nil && (!info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0) {
		err = errors.New("unsafe Manager handoff lock")
	}
	if err == nil {
		err = validateRecoveryOwner(path, info)
	}
	if err == nil {
		err = syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB)
	}
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	released := false
	return func() {
		if released {
			return
		}
		released = true
		_ = syscall.Flock(fd, syscall.LOCK_UN)
		_ = file.Close()
	}, nil
}

func bridgeVerifyBinary(path string, version Version) error {
	data, info, err := readRecoveryRegularFile(path, recoveryMaxBinaryBytes, false)
	if err != nil {
		return err
	}
	if info.Mode().Perm()&0o111 == 0 || sha256Hex(data) != version.SHA256 {
		return errors.New("handoff Manager executable checksum or mode mismatch")
	}
	return nil
}

// Existing config and user-unit directories may be 0755. Their files remain
// private; directory traversal must not permit another identity to replace them.
func readBridgePrivateFile(path string) ([]byte, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, errors.New("Manager handoff file path must be canonical and absolute")
	}
	if err := validateRecoveryDirectory(filepath.Dir(path), false); err != nil {
		return nil, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("Manager handoff file must be a non-symlink regular file")
	}
	data, _, err := readRecoveryInspectedFile(path, info, 1<<20, true)
	return data, err
}
