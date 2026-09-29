package selfupdate

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
)

// BootstrapLauncher provisions only a new installation. Existing installations
// must finish release N's handoff; bootstrap never converts their records.
func (m *Manager) BootstrapLauncher(ctx context.Context) (Version, error) {
	lease, err := m.AcquireServeLock()
	if err != nil {
		return Version{}, err
	}
	defer lease.Release()
	unlock, err := m.acquireLauncherMutation()
	if err != nil {
		return Version{}, err
	}
	defer unlock()
	for _, path := range []string{m.StatePath, m.launcherPath(), filepath.Join(m.Root, "launcher"), filepath.Join(filepath.Dir(m.StatePath), "state.json"), filepath.Join(filepath.Dir(m.StatePath), "update.json")} {
		if _, err := os.Lstat(path); err == nil {
			return Version{}, fmt.Errorf("bootstrap requires a fresh installation; existing state: %s", path)
		} else if !os.IsNotExist(err) {
			return Version{}, err
		}
	}
	if !validSourceCommit(m.RunningVersion) {
		return Version{}, errors.New("bootstrap Manager version must be a release commit")
	}
	data, _, err := readRecoveryRegularFile(m.InstallPath, recoveryMaxBinaryBytes, false)
	if err != nil {
		return Version{}, err
	}
	hash := sha256Hex(data)
	if !binaryMatches("/proc/self/exe", hash) {
		return Version{}, errors.New("bootstrap stable executable differs from running Manager")
	}
	probe, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	output, err := exec.CommandContext(probe, m.InstallPath, "version").CombinedOutput()
	if err != nil || strings.TrimSpace(string(output)) != m.RunningVersion {
		return Version{}, errors.New("bootstrap Manager version verification failed")
	}
	dir := filepath.Join(m.Root, "versions", safeID(m.RunningVersion+"-"+m.RunningVersion[:12]))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return Version{}, err
	}
	if err := validateRecoveryDirectory(dir, true); err != nil {
		return Version{}, err
	}
	current := Version{Version: m.RunningVersion, SourceCommit: m.RunningVersion, Path: filepath.Join(dir, m.managerBinaryName()), SHA256: hash, VerifiedAt: m.now(), PlatformCommitted: true}
	if err := atomicfile.WriteFile(current.Path, data, 0o700); err != nil {
		return Version{}, err
	}
	if err := m.ensureVersionMetadata(current); err != nil {
		return Version{}, err
	}
	launcher := current
	launcher.Path = filepath.Join(m.Root, "launcher")
	if err := atomicfile.WriteFile(launcher.Path, data, 0o700); err != nil {
		return Version{}, err
	}
	state := State{SchemaVersion: 1, Current: &current, Previous: &current, UpdatedAt: m.now()}
	if err := atomicfile.WriteJSON(m.StatePath, state, 0o600); err != nil {
		return Version{}, err
	}
	selected := launcherState{SchemaVersion: 1, Launcher: launcher, Selected: current, Previous: &current, Bootstrap: true}
	return launcher, atomicfile.WriteJSON(m.launcherPath(), selected, 0o600)
}
