//go:build linux

package handoffhost

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"golang.org/x/sys/unix"
)

const maximumTargetConfigBytes = 1 << 20

// TargetInstallationRequest is the complete transaction-bound input for the
// helper-owned target host installation. ConfigBytes must already have been
// deterministically generated from the immutable journal and its verified
// source configuration.
type TargetInstallationRequest struct {
	TargetProfile        identity.Profile
	TransactionID        string
	TransactionDirectory string
	ArtifactPath         string
	ArtifactSHA256       string
	StableBinary         string
	ConfigPath           string
	UnitPath             string
	DataRoot             string
	StateHome            string
	SocketPath           string
	ConfigBytes          []byte
}

// TargetInstallationSpec is the deterministic proof used for install replay
// and rollback. It intentionally contains no ambient HOME/XDG input.
type TargetInstallationSpec struct {
	TransactionID        string
	TransactionDirectory string
	ArtifactPath         string
	ArtifactSHA256       string
	StableBinary         string
	ConfigPath           string
	ConfigSHA256         string
	UnitName             string
	UnitPath             string
	UnitSHA256           string
	DataRoot             string
	StateHome            string
	SocketPath           string
	ConfigBytes          []byte
	UnitBytes            []byte
}

// ResolveTargetInstallation validates and deterministically renders the exact
// three target host objects without touching the filesystem.
func (host *LinuxHost) ResolveTargetInstallation(request TargetInstallationRequest) (TargetInstallationSpec, error) {
	target := identity.TargetProfile()
	if request.TargetProfile != target {
		return TargetInstallationSpec{}, errors.New("target installation profile is not canonical")
	}
	if !transactionPattern.MatchString(request.TransactionID) {
		return TargetInstallationSpec{}, errors.New("target installation transaction id is invalid")
	}
	for label, path := range map[string]string{
		"transaction directory": request.TransactionDirectory,
		"target artifact":       request.ArtifactPath,
		"target stable binary":  request.StableBinary,
		"target config":         request.ConfigPath,
		"target unit":           request.UnitPath,
		"target data root":      request.DataRoot,
		"target state home":     request.StateHome,
		"target control socket": request.SocketPath,
	} {
		if err := validateCanonicalAbsolute(path, label); err != nil {
			return TargetInstallationSpec{}, err
		}
	}
	if filepath.Base(request.TransactionDirectory) != request.TransactionID {
		return TargetInstallationSpec{}, errors.New("target installation directory is not bound to its transaction")
	}
	wantedArtifact := filepath.Join(request.TransactionDirectory, helperDirectory, target.ManagerBinary)
	if request.ArtifactPath != wantedArtifact || filepath.Base(request.StableBinary) != target.ManagerBinary ||
		filepath.Base(request.UnitPath) != target.ManagerUnit || filepath.Base(request.ConfigPath) != target.ConfigFile ||
		filepath.Base(filepath.Dir(request.ConfigPath)) != target.ConfigDirectory || filepath.Base(request.DataRoot) != target.DataDirectory ||
		!strings.HasSuffix(request.SocketPath, string(filepath.Separator)+filepath.FromSlash(target.RuntimeSocketPath)) {
		return TargetInstallationSpec{}, errors.New("target installation paths differ from the canonical target binding")
	}
	if !sha256Pattern.MatchString(request.ArtifactSHA256) {
		return TargetInstallationSpec{}, errors.New("target installation artifact SHA-256 is invalid")
	}
	if len(request.ConfigBytes) == 0 || len(request.ConfigBytes) > maximumTargetConfigBytes || request.ConfigBytes[len(request.ConfigBytes)-1] != '\n' {
		return TargetInstallationSpec{}, errors.New("target installation config is empty, unbounded, or not newline terminated")
	}
	unit, err := renderTargetManagerUnit(request.StableBinary, request.ConfigPath, request.StateHome, filepath.Dir(filepath.Dir(request.SocketPath)))
	if err != nil {
		return TargetInstallationSpec{}, err
	}
	configHash := sha256.Sum256(request.ConfigBytes)
	unitHash := sha256.Sum256(unit)
	return TargetInstallationSpec{
		TransactionID: request.TransactionID, TransactionDirectory: request.TransactionDirectory,
		ArtifactPath: request.ArtifactPath, ArtifactSHA256: request.ArtifactSHA256,
		StableBinary: request.StableBinary, ConfigPath: request.ConfigPath,
		ConfigSHA256: hex.EncodeToString(configHash[:]), UnitName: target.ManagerUnit,
		UnitPath: request.UnitPath, UnitSHA256: hex.EncodeToString(unitHash[:]), DataRoot: request.DataRoot,
		StateHome: request.StateHome, SocketPath: request.SocketPath,
		ConfigBytes: append([]byte(nil), request.ConfigBytes...), UnitBytes: unit,
	}, nil
}

// EnsureTargetInstallation atomically installs or exactly verifies each
// transaction-derived target object, then reloads user systemd. A crash at any
// point is replayed only when every existing object is byte-identical.
func (host *LinuxHost) EnsureTargetInstallation(ctx context.Context, request TargetInstallationRequest) error {
	spec, err := host.ResolveTargetInstallation(request)
	if err != nil {
		return err
	}
	if err := validateTargetInstallationTransaction(spec); err != nil {
		return err
	}
	artifact, err := openSecureFile(spec.ArtifactPath, ownerExecMode, "target Manager artifact")
	if err != nil {
		return err
	}
	defer artifact.file.Close()
	actualArtifact, err := hashOpenFile(artifact.file)
	if err != nil || actualArtifact != spec.ArtifactSHA256 {
		return errors.Join(err, errors.New("target Manager artifact differs from the journal digest"))
	}
	stableDir, configParent, configDir, unitDir, err := openTargetInstallationDirectories(spec, true)
	if err != nil {
		return err
	}
	defer stableDir.Close()
	defer configParent.Close()
	defer configDir.Close()
	defer unitDir.Close()
	if err := installExecutable(stableDir, filepath.Base(spec.StableBinary), artifact, spec.ArtifactSHA256); err != nil {
		return fmt.Errorf("install target stable Manager: %w", err)
	}
	if err := installStaticFile(configDir, filepath.Base(spec.ConfigPath), spec.ConfigBytes, ownerFileMode, spec.ConfigSHA256); err != nil {
		return fmt.Errorf("install target Manager config: %w", err)
	}
	if err := installStaticFile(unitDir, filepath.Base(spec.UnitPath), spec.UnitBytes, ownerFileMode, spec.UnitSHA256); err != nil {
		return fmt.Errorf("install target Manager unit: %w", err)
	}
	if _, err := host.runner().Run(ctx, "systemctl", "--user", "daemon-reload"); err != nil {
		return fmt.Errorf("reload user systemd after target installation: %w", err)
	}
	return host.VerifyTargetInstallation(ctx, request)
}

func (host *LinuxHost) VerifyTargetInstallation(_ context.Context, request TargetInstallationRequest) error {
	spec, err := host.ResolveTargetInstallation(request)
	if err != nil {
		return err
	}
	if err := validateTargetInstallationTransaction(spec); err != nil {
		return err
	}
	for _, expected := range []struct {
		path, digest, label string
		mode                os.FileMode
	}{
		{spec.StableBinary, spec.ArtifactSHA256, "target stable Manager", ownerExecMode},
		{spec.ConfigPath, spec.ConfigSHA256, "target Manager config", ownerFileMode},
		{spec.UnitPath, spec.UnitSHA256, "target Manager unit", ownerFileMode},
	} {
		file, err := openSecureFile(expected.path, expected.mode, expected.label)
		if err != nil {
			return err
		}
		digest, hashErr := hashOpenFile(file.file)
		verifyErr := file.verifyPath()
		closeErr := file.file.Close()
		if hashErr != nil || verifyErr != nil || closeErr != nil || digest != expected.digest {
			return errors.Join(hashErr, verifyErr, closeErr, fmt.Errorf("%s differs from its transaction proof", expected.label))
		}
	}
	configDir, err := openSecureDirectory(filepath.Dir(spec.ConfigPath), ownerDirMode, true)
	if err != nil {
		return fmt.Errorf("verify target config directory: %w", err)
	}
	return configDir.Close()
}

// RemoveTargetInstallation is rollback-only. It independently proves systemd
// inactivity, verifies every extant object against the transaction spec, then
// removes the unit first, followed by config and stable binary.
func (host *LinuxHost) RemoveTargetInstallation(ctx context.Context, request TargetInstallationRequest) error {
	spec, err := host.ResolveTargetInstallation(request)
	if err != nil {
		return err
	}
	if err := validateTargetInstallationTransaction(spec); err != nil {
		return err
	}
	if err := host.verifyTargetUnitInactive(ctx, spec); err != nil {
		return err
	}
	stableDir, configParent, configDir, unitDir, err := openTargetInstallationDirectories(spec, false)
	if err != nil {
		return err
	}
	if stableDir != nil {
		defer stableDir.Close()
	}
	if configParent != nil {
		defer configParent.Close()
	}
	if configDir != nil {
		defer configDir.Close()
	}
	if unitDir != nil {
		defer unitDir.Close()
	}
	unitRemoved, err := removeInstallationFile(unitDir, filepath.Base(spec.UnitPath), ownerFileMode, spec.UnitSHA256)
	if err != nil {
		return fmt.Errorf("remove target Manager unit: %w", err)
	}
	if unitRemoved {
		if _, err := host.runner().Run(ctx, "systemctl", "--user", "daemon-reload"); err != nil {
			return fmt.Errorf("reload user systemd after target rollback: %w", err)
		}
	}
	if configDir != nil {
		entries, err := configDir.file.Readdirnames(-1)
		if err != nil {
			return fmt.Errorf("enumerate target config directory: %w", err)
		}
		for _, entry := range entries {
			if entry != filepath.Base(spec.ConfigPath) {
				return fmt.Errorf("target config directory contains unknown object %q", entry)
			}
		}
		if _, err := removeInstallationFile(configDir, filepath.Base(spec.ConfigPath), ownerFileMode, spec.ConfigSHA256); err != nil {
			return fmt.Errorf("remove target Manager config: %w", err)
		}
		if err := configDir.verifyPath(); err != nil {
			return err
		}
		if err := unix.Unlinkat(configParent.fd(), filepath.Base(configDir.path), unix.AT_REMOVEDIR); err != nil {
			return fmt.Errorf("remove target config directory: %w", err)
		}
		if err := configParent.file.Sync(); err != nil {
			return err
		}
	}
	if _, err := removeInstallationFile(stableDir, filepath.Base(spec.StableBinary), ownerExecMode, spec.ArtifactSHA256); err != nil {
		return fmt.Errorf("remove target stable Manager: %w", err)
	}
	return nil
}

func openTargetInstallationDirectories(spec TargetInstallationSpec, createConfig bool) (stable, configParent, configDirectory, unit *secureDirectory, resultErr error) {
	stable, resultErr = openSecureDirectory(filepath.Dir(spec.StableBinary), 0, true)
	if resultErr != nil {
		return nil, nil, nil, nil, fmt.Errorf("open target binary directory: %w", resultErr)
	}
	defer func() {
		if resultErr != nil {
			_ = stable.Close()
			if configParent != nil {
				_ = configParent.Close()
			}
			if configDirectory != nil {
				_ = configDirectory.Close()
			}
			if unit != nil {
				_ = unit.Close()
			}
		}
	}()
	configParent, resultErr = openSecureDirectory(filepath.Dir(filepath.Dir(spec.ConfigPath)), 0, true)
	if resultErr != nil {
		return nil, nil, nil, nil, fmt.Errorf("open target config parent: %w", resultErr)
	}
	if createConfig {
		configDirectory, resultErr = ensureSecureChildDirectory(configParent, filepath.Base(filepath.Dir(spec.ConfigPath)))
	} else {
		configDirectory, resultErr = openSecureDirectory(filepath.Dir(spec.ConfigPath), ownerDirMode, true)
		if errors.Is(underlyingPathError(resultErr), syscall.ENOENT) {
			resultErr = nil
		}
	}
	if resultErr != nil {
		return nil, nil, nil, nil, fmt.Errorf("open target config directory: %w", resultErr)
	}
	unit, resultErr = openSecureDirectory(filepath.Dir(spec.UnitPath), 0, true)
	if resultErr != nil {
		return nil, nil, nil, nil, fmt.Errorf("open target unit directory: %w", resultErr)
	}
	return stable, configParent, configDirectory, unit, nil
}

func removeInstallationFile(directory *secureDirectory, name string, mode os.FileMode, digest string) (bool, error) {
	if directory == nil {
		return false, nil
	}
	file, err := openSecureFile(filepath.Join(directory.path, name), mode, "target installation rollback object")
	if errors.Is(underlyingPathError(err), syscall.ENOENT) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	actualDigest, hashErr := hashOpenFile(file.file)
	identity := file.identity
	verifyErr := file.verifyPath()
	closeErr := file.file.Close()
	if hashErr != nil || verifyErr != nil || closeErr != nil || actualDigest != digest {
		return false, errors.Join(hashErr, verifyErr, closeErr, errors.New("target installation rollback object differs from its transaction proof"))
	}
	if err := removeExactFile(directory, name, identity); err != nil {
		return false, err
	}
	return true, nil
}

func (host *LinuxHost) verifyTargetUnitInactive(ctx context.Context, spec TargetInstallationSpec) error {
	output, err := host.runner().Run(ctx, "systemctl", "--user", "show", spec.UnitName, "--no-pager",
		"--property=LoadState", "--property=ActiveState", "--property=UnitFileState", "--property=FragmentPath", "--property=MainPID")
	if err != nil {
		return fmt.Errorf("inspect target unit before installation rollback: %w", err)
	}
	properties := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		key, value, ok := strings.Cut(line, "=")
		if !ok || key == "" {
			return errors.New("systemd returned malformed target unit properties")
		}
		if _, duplicate := properties[key]; duplicate {
			return errors.New("systemd returned duplicate target unit properties")
		}
		properties[key] = value
	}
	pid, err := strconv.Atoi(properties["MainPID"])
	if err != nil || pid != 0 || properties["ActiveState"] != "inactive" || properties["UnitFileState"] == "enabled" {
		return errors.New("target unit is not inactive and boot-disabled before installation rollback")
	}
	switch properties["LoadState"] {
	case "loaded":
		if properties["FragmentPath"] != spec.UnitPath {
			return errors.New("loaded target unit fragment differs from the transaction")
		}
	case "not-found":
		if properties["FragmentPath"] != "" {
			return errors.New("absent target unit unexpectedly has a fragment path")
		}
	default:
		return errors.New("target unit load state is not safely classifiable")
	}
	return nil
}

func renderTargetManagerUnit(stableBinary, configPath, stateHome, runtimeDirectory string) ([]byte, error) {
	stable, err := quoteSystemd(stableBinary)
	if err != nil {
		return nil, err
	}
	config, err := quoteSystemd(configPath)
	if err != nil {
		return nil, err
	}
	stateEnvironment, err := quoteSystemd("XDG_STATE_HOME=" + stateHome)
	if err != nil {
		return nil, err
	}
	runtimeEnvironment, err := quoteSystemd("XDG_RUNTIME_DIR=" + runtimeDirectory)
	if err != nil {
		return nil, err
	}
	return []byte(`[Unit]
Description=Agent Platform Manager
After=docker.service

[Service]
Type=simple
ExecStart=` + stable + ` serve --config ` + config + `
Environment=` + stateEnvironment + `
Environment=` + runtimeEnvironment + `
Restart=on-failure
RestartSec=3s
TimeoutStopSec=60s
PrivateTmp=true
UMask=0077

[Install]
WantedBy=default.target
`), nil
}

func validateTargetInstallationTransaction(spec TargetInstallationSpec) error {
	transaction, err := openSecureDirectory(spec.TransactionDirectory, ownerDirMode, true)
	if err != nil {
		return fmt.Errorf("open target installation transaction: %w", err)
	}
	defer transaction.Close()
	helper, err := openSecureDirectory(filepath.Join(spec.TransactionDirectory, helperDirectory), ownerDirMode, true)
	if err != nil {
		return fmt.Errorf("open target installation helper directory: %w", err)
	}
	defer helper.Close()
	artifact, err := openSecureFile(spec.ArtifactPath, ownerExecMode, "target installation artifact")
	if err != nil {
		return err
	}
	digest, hashErr := hashOpenFile(artifact.file)
	verifyErr := artifact.verifyPath()
	closeErr := artifact.file.Close()
	if hashErr != nil || verifyErr != nil || closeErr != nil || digest != spec.ArtifactSHA256 {
		return errors.Join(hashErr, verifyErr, closeErr, errors.New("target installation artifact differs from its transaction proof"))
	}
	return nil
}
