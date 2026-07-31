//go:build linux

package handoffhost

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
)

const (
	maxCommandOutput = 64 << 10
	maxPropertyBytes = 4 << 10
	maxProcBytes     = 64 << 10
	ownerFileMode    = 0o600
	ownerExecMode    = 0o700
	ownerDirMode     = 0o700
)

type LinuxHost struct {
	Runner     Runner
	ProcRoot   string
	BootIDPath string
}

type CommandRunner struct{}

func (CommandRunner) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, name, args...)
	output := &boundedBuffer{limit: maxCommandOutput}
	command.Stdout = output
	command.Stderr = output
	err := command.Run()
	if output.overflow {
		return nil, fmt.Errorf("%s output exceeded %d bytes", name, maxCommandOutput)
	}
	if err != nil {
		return nil, fmt.Errorf("%s: %w: %s", name, err, strings.TrimSpace(output.String()))
	}
	return append([]byte(nil), output.Bytes()...), nil
}

type boundedBuffer struct {
	bytes.Buffer
	limit    int
	overflow bool
}

func (buffer *boundedBuffer) Write(value []byte) (int, error) {
	original := len(value)
	remaining := buffer.limit - buffer.Len()
	if remaining <= 0 {
		buffer.overflow = true
		return original, nil
	}
	if len(value) > remaining {
		value = value[:remaining]
		buffer.overflow = true
	}
	_, _ = buffer.Buffer.Write(value)
	return original, nil
}

func (host *LinuxHost) runner() Runner {
	if host != nil && host.Runner != nil {
		return host.Runner
	}
	return CommandRunner{}
}

func (host *LinuxHost) procRoot() string {
	if host != nil && host.ProcRoot != "" {
		return host.ProcRoot
	}
	return "/proc"
}

func (host *LinuxHost) bootIDPath() string {
	if host != nil && host.BootIDPath != "" {
		return host.BootIDPath
	}
	return "/proc/sys/kernel/random/boot_id"
}

// Resolve deterministically binds an already verified release artifact to one
// transaction without writing files or invoking systemd.
func (host *LinuxHost) Resolve(request ArmRequest) (HelperSpec, error) {
	if request.TargetProfile != identityTargetProfile() {
		return HelperSpec{}, errors.New("handoff helper target profile is not canonical")
	}
	if !transactionPattern.MatchString(request.TransactionID) {
		return HelperSpec{}, errors.New("handoff helper transaction id is invalid")
	}
	for label, path := range map[string]string{
		"transaction directory":       request.TransactionDirectory,
		"verified artifact":           request.ArtifactPath,
		"user systemd unit directory": request.UnitDirectory,
		"handoff journal":             request.JournalPath,
	} {
		if err := validateCanonicalAbsolute(path, label); err != nil {
			return HelperSpec{}, err
		}
	}
	if filepath.Base(request.TransactionDirectory) != request.TransactionID {
		return HelperSpec{}, errors.New("handoff helper transaction directory is not bound to its transaction id")
	}
	if filepath.Dir(request.JournalPath) != request.TransactionDirectory || filepath.Base(request.JournalPath) != journalBasename {
		return HelperSpec{}, errors.New("handoff helper journal is not the canonical transaction journal")
	}
	if !sha256Pattern.MatchString(request.ArtifactSHA256) {
		return HelperSpec{}, errors.New("handoff helper artifact SHA-256 is invalid")
	}
	unitName, err := helperUnitName(request.TargetProfile, request.TransactionID)
	if err != nil {
		return HelperSpec{}, err
	}
	executable := filepath.Join(request.TransactionDirectory, helperDirectory, request.TargetProfile.ManagerBinary)
	socketPath, err := TransferSocketPath(request.TransactionDirectory, request.TransactionID)
	if err != nil {
		return HelperSpec{}, err
	}
	argv := helperArgv(executable, request.TransactionID, request.JournalPath, socketPath)
	unitPath := filepath.Join(request.UnitDirectory, unitName)
	unit, err := renderUnit(unitName, request.TransactionID, request.TransactionDirectory, argv)
	if err != nil {
		return HelperSpec{}, err
	}
	unitHash := sha256.Sum256(unit)
	return HelperSpec{
		TransactionID: request.TransactionID, TargetProfileID: request.TargetProfile.ProfileID,
		TransactionDirectory: request.TransactionDirectory, UnitName: unitName, UnitPath: unitPath,
		UnitSHA256: hex.EncodeToString(unitHash[:]), ExecutablePath: executable,
		ExecutableSHA256: request.ArtifactSHA256, JournalPath: request.JournalPath,
		ListenerSocketPath: socketPath, Argv: argv,
	}, nil
}

// Arm installs the helper and persistent unit, enables it across reboot,
// starts it, and returns a complete process proof.
func (host *LinuxHost) Arm(ctx context.Context, request ArmRequest) (ArmResult, error) {
	spec, err := host.Resolve(request)
	if err != nil {
		return ArmResult{}, err
	}
	transactionDir, err := openSecureDirectory(spec.TransactionDirectory, ownerDirMode, true)
	if err != nil {
		return ArmResult{}, fmt.Errorf("open handoff transaction directory: %w", err)
	}
	defer transactionDir.Close()
	unitDir, err := openSecureDirectory(filepath.Dir(spec.UnitPath), 0, true)
	if err != nil {
		return ArmResult{}, fmt.Errorf("open user systemd unit directory: %w", err)
	}
	defer unitDir.Close()
	if err := validateSecureFile(spec.JournalPath, ownerFileMode, "handoff journal"); err != nil {
		return ArmResult{}, err
	}
	artifact, err := openSecureFile(request.ArtifactPath, ownerExecMode, "verified helper artifact")
	if err != nil {
		return ArmResult{}, err
	}
	defer artifact.file.Close()
	actualArtifactSHA, err := hashOpenFile(artifact.file)
	if err != nil || actualArtifactSHA != spec.ExecutableSHA256 {
		return ArmResult{}, errors.New("verified helper artifact SHA-256 changed before installation")
	}
	if err := artifact.verifyPath(); err != nil {
		return ArmResult{}, fmt.Errorf("revalidate verified helper artifact: %w", err)
	}

	helperDir, err := ensureSecureChildDirectory(transactionDir, helperDirectory)
	if err != nil {
		return ArmResult{}, fmt.Errorf("prepare transaction helper directory: %w", err)
	}
	defer helperDir.Close()
	if err := installExecutable(helperDir, filepath.Base(spec.ExecutablePath), artifact, spec.ExecutableSHA256); err != nil {
		return ArmResult{}, err
	}
	if err := artifact.verifyPath(); err != nil {
		return ArmResult{}, fmt.Errorf("verified helper artifact path changed during installation: %w", err)
	}
	unit, err := unitBytes(spec)
	if err != nil {
		return ArmResult{}, err
	}
	if err := installStaticFile(unitDir, filepath.Base(spec.UnitPath), unit, ownerFileMode, spec.UnitSHA256); err != nil {
		return ArmResult{}, fmt.Errorf("install persistent handoff helper unit: %w", err)
	}
	if _, err := host.runner().Run(ctx, "systemctl", "--user", "daemon-reload"); err != nil {
		return ArmResult{}, fmt.Errorf("reload user systemd after installing handoff helper: %w", err)
	}
	if _, err := host.runner().Run(ctx, "systemctl", "--user", "enable", spec.UnitName); err != nil {
		return ArmResult{}, fmt.Errorf("enable persistent handoff helper: %w", err)
	}
	if _, err := host.runner().Run(ctx, "systemctl", "--user", "start", spec.UnitName); err != nil {
		return ArmResult{}, fmt.Errorf("start persistent handoff helper: %w", err)
	}
	proof, err := host.Inspect(ctx, spec)
	if err != nil {
		return ArmResult{}, fmt.Errorf("prove persistent handoff helper: %w", err)
	}
	return ArmResult{Spec: spec, Proof: proof}, nil
}

// Inspect fails closed unless the unit, installed executable and live process
// all still exactly match the transaction-derived spec.
func (host *LinuxHost) Inspect(ctx context.Context, spec HelperSpec) (HelperProof, error) {
	return host.inspect(ctx, spec, true)
}

func (host *LinuxHost) inspect(ctx context.Context, spec HelperSpec, requireEnabled bool) (HelperProof, error) {
	unit, executable, err := host.inspectStatic(spec)
	if err != nil {
		return HelperProof{}, err
	}
	defer unit.file.Close()
	defer executable.file.Close()
	if requireEnabled {
		if _, err := host.runner().Run(ctx, "systemctl", "--user", "is-enabled", "--quiet", spec.UnitName); err != nil {
			return HelperProof{}, fmt.Errorf("handoff helper unit is not enabled: %w", err)
		}
	}
	if _, err := host.runner().Run(ctx, "systemctl", "--user", "is-active", "--quiet", spec.UnitName); err != nil {
		return HelperProof{}, fmt.Errorf("handoff helper unit is not active: %w", err)
	}
	properties, err := host.systemdProperties(ctx, spec.UnitName)
	if err != nil {
		return HelperProof{}, err
	}
	enabled := properties["UnitFileState"] == "enabled"
	if properties["ActiveState"] != "active" || requireEnabled && !enabled ||
		!requireEnabled && properties["UnitFileState"] != "enabled" && properties["UnitFileState"] != "disabled" {
		return HelperProof{}, errors.New("handoff helper systemd enablement/active state is not exact")
	}
	if properties["FragmentPath"] != spec.UnitPath {
		return HelperProof{}, errors.New("handoff helper systemd fragment path does not match the installed unit")
	}
	pid, err := parsePositivePID(properties["MainPID"])
	if err != nil || properties["ControlPID"] != "0" {
		return HelperProof{}, errors.New("handoff helper systemd process metadata is invalid")
	}
	controlGroup := properties["ControlGroup"]
	if !validControlGroup(controlGroup) {
		return HelperProof{}, errors.New("handoff helper systemd control group is invalid")
	}
	processExecutable := filepath.Join(host.procRoot(), strconv.Itoa(pid), "exe")
	processFile, err := os.Open(processExecutable)
	if err != nil {
		return HelperProof{}, fmt.Errorf("open handoff helper process executable: %w", err)
	}
	defer processFile.Close()
	processInfo, err := processFile.Stat()
	if err != nil {
		return HelperProof{}, fmt.Errorf("inspect handoff helper process executable: %w", err)
	}
	executableInfo, err := executable.file.Stat()
	if err != nil || !os.SameFile(executableInfo, processInfo) {
		return HelperProof{}, errors.New("handoff helper process is not executing the immutable installed inode")
	}
	processSHA, err := hashOpenFile(processFile)
	if err != nil || processSHA != spec.ExecutableSHA256 {
		return HelperProof{}, errors.New("handoff helper process executable SHA-256 does not match the installed helper")
	}
	commandData, err := readBoundedFile(filepath.Join(host.procRoot(), strconv.Itoa(pid), "cmdline"), maxProcBytes)
	if err != nil {
		return HelperProof{}, fmt.Errorf("read handoff helper command line: %w", err)
	}
	argv, err := parseCmdline(commandData)
	if err != nil || !reflect.DeepEqual(argv, spec.Argv) {
		return HelperProof{}, errors.New("handoff helper command line does not exactly own the transaction")
	}
	cgroupData, err := readBoundedFile(filepath.Join(host.procRoot(), strconv.Itoa(pid), "cgroup"), maxProcBytes)
	if err != nil || !processInExactControlGroup(cgroupData, controlGroup) {
		return HelperProof{}, errors.New("handoff helper process is outside its exact systemd control group")
	}
	bootData, err := readBoundedFile(host.bootIDPath(), 256)
	if err != nil {
		return HelperProof{}, fmt.Errorf("read host boot id: %w", err)
	}
	bootID := strings.TrimSpace(string(bootData))
	if !bootIDPattern.MatchString(bootID) {
		return HelperProof{}, errors.New("host boot id is invalid")
	}
	if err := unit.verifyPath(); err != nil {
		return HelperProof{}, fmt.Errorf("revalidate handoff helper unit after process proof: %w", err)
	}
	if err := executable.verifyPath(); err != nil {
		return HelperProof{}, fmt.Errorf("revalidate installed handoff helper after process proof: %w", err)
	}
	return HelperProof{
		TransactionID: spec.TransactionID, UnitName: spec.UnitName, UnitPath: spec.UnitPath,
		UnitSHA256: spec.UnitSHA256, ExecutablePath: spec.ExecutablePath,
		ExecutableSHA256: spec.ExecutableSHA256, Argv: append([]string(nil), spec.Argv...),
		Enabled: enabled, Active: true, MainPID: pid, ControlGroup: controlGroup, BootID: bootID,
	}, nil
}

// DisableForExit is the terminal action performed by the helper process on
// itself. It proves the exact active process and static identity, removes only
// the boot-enable relationship, and verifies that the same process remains
// active. It deliberately never stops or unlinks its own executable: a stable
// source/target Manager calls Remove after this process has exited.
func (host *LinuxHost) DisableForExit(ctx context.Context, spec HelperSpec, expected HelperProof) error {
	if err := validateSpec(spec); err != nil {
		return err
	}
	if err := validateDisableProof(spec, expected); err != nil {
		return err
	}
	current, err := host.inspect(ctx, spec, false)
	if err != nil {
		return fmt.Errorf("prove active handoff helper before disabling: %w", err)
	}
	if !sameStaticHelperIdentity(current, expected) || current.MainPID != expected.MainPID {
		return errors.New("active handoff helper changed during terminal self-disable")
	}
	if current.Enabled {
		if _, err := host.runner().Run(ctx, "systemctl", "--user", "disable", spec.UnitName); err != nil {
			return fmt.Errorf("disable terminal handoff helper: %w", err)
		}
	}
	properties, err := host.systemdProperties(ctx, spec.UnitName)
	if err != nil {
		return err
	}
	pid, pidErr := parsePositivePID(properties["MainPID"])
	if properties["UnitFileState"] != "disabled" || properties["ActiveState"] != "active" || pidErr != nil || pid != expected.MainPID ||
		properties["ControlPID"] != "0" || properties["FragmentPath"] != spec.UnitPath || properties["ControlGroup"] != expected.ControlGroup {
		return errors.New("terminal handoff helper disable state is not exact")
	}
	unit, executable, err := host.inspectStatic(spec)
	if err != nil {
		return err
	}
	unit.file.Close()
	executable.file.Close()
	return nil
}

// Remove stops and disables only a helper whose immutable identity matches a
// previously persisted static proof. It supports retry after a partial removal, but
// never removes a present path whose inode, owner, mode, link count or digest
// cannot be proven.
func (host *LinuxHost) Remove(ctx context.Context, request RemovalRequest) (RemovalResult, error) {
	return host.remove(ctx, request, true)
}

// RemoveInactive is the stable-Manager cleanup boundary. It refuses to stop
// an active helper and accepts only an already disabled, PID-less unit whose
// static files still match the transaction proof.
func (host *LinuxHost) RemoveInactive(ctx context.Context, request RemovalRequest) (RemovalResult, error) {
	return host.remove(ctx, request, false)
}

func (host *LinuxHost) remove(ctx context.Context, request RemovalRequest, allowStop bool) (RemovalResult, error) {
	if err := validateSpec(request.Spec); err != nil {
		return RemovalResult{}, err
	}
	if err := validateStaticProof(request.Spec, request.ExpectedProof); err != nil {
		return RemovalResult{}, err
	}
	if _, err := os.Lstat(request.Spec.UnitPath); os.IsNotExist(err) {
		return host.finishRemovalAfterUnitUnlink(ctx, request)
	} else if err != nil {
		return RemovalResult{}, fmt.Errorf("inspect handoff helper unit before removal: %w", err)
	}
	properties, err := host.systemdProperties(ctx, request.Spec.UnitName)
	if err != nil {
		return RemovalResult{}, err
	}
	active := properties["ActiveState"] == "active"
	if active && !allowStop {
		return RemovalResult{}, errors.New("refusing stable cleanup while the handoff helper is active")
	}
	if !allowStop && properties["UnitFileState"] != "disabled" {
		return RemovalResult{}, errors.New("refusing stable cleanup before the handoff helper disabled boot enablement")
	}
	if active {
		current, inspectErr := host.Inspect(ctx, request.Spec)
		if inspectErr != nil {
			return RemovalResult{}, fmt.Errorf("refuse to stop an unproven handoff helper: %w", inspectErr)
		}
		if !sameStaticHelperIdentity(current, request.ExpectedProof) {
			return RemovalResult{}, errors.New("running handoff helper no longer matches its persisted static identity")
		}
	} else if properties["MainPID"] != "0" || properties["ControlPID"] != "0" || properties["FragmentPath"] != request.Spec.UnitPath {
		return RemovalResult{}, errors.New("inactive handoff helper has ambiguous systemd process metadata")
	}
	unit, executable, err := host.inspectStatic(request.Spec)
	if err != nil {
		return RemovalResult{}, err
	}
	unitIdentity := unit.identity
	executableIdentity := executable.identity
	unit.file.Close()
	executable.file.Close()
	if active {
		if _, err := host.runner().Run(ctx, "systemctl", "--user", "stop", request.Spec.UnitName); err != nil {
			return RemovalResult{}, fmt.Errorf("stop persistent handoff helper: %w", err)
		}
	}
	properties, err = host.systemdProperties(ctx, request.Spec.UnitName)
	if err != nil || properties["ActiveState"] == "active" || properties["MainPID"] != "0" || properties["ControlPID"] != "0" {
		return RemovalResult{}, errors.New("persistent handoff helper did not become inactive")
	}
	if properties["UnitFileState"] != "disabled" {
		if _, err := host.runner().Run(ctx, "systemctl", "--user", "disable", request.Spec.UnitName); err != nil {
			return RemovalResult{}, fmt.Errorf("disable persistent handoff helper: %w", err)
		}
	}
	properties, err = host.systemdProperties(ctx, request.Spec.UnitName)
	if err != nil || properties["UnitFileState"] != "disabled" || properties["ActiveState"] == "active" {
		return RemovalResult{}, errors.New("persistent handoff helper disable state is not proven")
	}

	unitDir, err := openSecureDirectory(filepath.Dir(request.Spec.UnitPath), 0, true)
	if err != nil {
		return RemovalResult{}, err
	}
	defer unitDir.Close()
	helperDir, err := openSecureDirectory(filepath.Dir(request.Spec.ExecutablePath), ownerDirMode, true)
	if err != nil {
		return RemovalResult{}, err
	}
	defer helperDir.Close()
	if err := removeExactFile(unitDir, filepath.Base(request.Spec.UnitPath), unitIdentity); err != nil {
		return RemovalResult{}, fmt.Errorf("remove exact handoff helper unit: %w", err)
	}
	result := RemovalResult{UnitRemoved: true}
	if err := removeExactFile(helperDir, filepath.Base(request.Spec.ExecutablePath), executableIdentity); err != nil {
		return result, fmt.Errorf("remove exact handoff helper executable: %w", err)
	}
	result.ExecutableRemoved = true
	if _, err := host.runner().Run(ctx, "systemctl", "--user", "daemon-reload"); err != nil {
		return result, fmt.Errorf("reload user systemd after removing handoff helper: %w", err)
	}
	return result, nil
}

// finishRemovalAfterUnitUnlink is the sole partial-removal replay accepted by
// this package. Remove unlinks the unit before the executable, so a missing
// unit plus an exact executable is a deterministic crash checkpoint. Every
// parent and remaining file is still re-opened and proven before mutation.
func (host *LinuxHost) finishRemovalAfterUnitUnlink(ctx context.Context, request RemovalRequest) (RemovalResult, error) {
	unitDir, err := openSecureDirectory(filepath.Dir(request.Spec.UnitPath), 0, true)
	if err != nil {
		return RemovalResult{}, err
	}
	defer unitDir.Close()
	if err := unitDir.verifyPath(); err != nil {
		return RemovalResult{}, err
	}
	if _, err := os.Lstat(request.Spec.UnitPath); !os.IsNotExist(err) {
		if err == nil {
			return RemovalResult{}, errors.New("handoff helper unit reappeared during removal replay")
		}
		return RemovalResult{}, err
	}
	helperDir, err := openSecureDirectory(filepath.Dir(request.Spec.ExecutablePath), ownerDirMode, true)
	if err != nil {
		return RemovalResult{}, err
	}
	defer helperDir.Close()
	var executableIdentity *fileIdentity
	executable, err := openSecureFile(request.Spec.ExecutablePath, ownerExecMode, "remaining handoff helper executable")
	if err == nil {
		actualSHA, hashErr := hashOpenFile(executable.file)
		identity := executable.identity
		executable.file.Close()
		if hashErr != nil || actualSHA != request.Spec.ExecutableSHA256 {
			return RemovalResult{}, errors.New("remaining handoff helper executable does not match its persisted proof")
		}
		executableIdentity = &identity
	} else if !errors.Is(underlyingPathError(err), syscall.ENOENT) {
		return RemovalResult{}, err
	}
	properties, err := host.systemdProperties(ctx, request.Spec.UnitName)
	if err != nil {
		return RemovalResult{}, err
	}
	if properties["ActiveState"] == "active" || properties["MainPID"] != "0" || properties["ControlPID"] != "0" ||
		properties["FragmentPath"] != "" && properties["FragmentPath"] != request.Spec.UnitPath {
		return RemovalResult{}, errors.New("unit-less handoff helper has ambiguous systemd ownership")
	}
	if properties["UnitFileState"] != "" && properties["UnitFileState"] != "disabled" {
		if _, err := host.runner().Run(ctx, "systemctl", "--user", "disable", request.Spec.UnitName); err != nil {
			return RemovalResult{}, fmt.Errorf("disable partially removed handoff helper: %w", err)
		}
		properties, err = host.systemdProperties(ctx, request.Spec.UnitName)
		if err != nil || properties["UnitFileState"] != "disabled" && properties["UnitFileState"] != "" {
			return RemovalResult{}, errors.New("partially removed handoff helper disable state is not proven")
		}
	}
	result := RemovalResult{UnitRemoved: true, ExecutableRemoved: executableIdentity == nil}
	if executableIdentity != nil {
		if err := removeExactFile(helperDir, filepath.Base(request.Spec.ExecutablePath), *executableIdentity); err != nil {
			return result, fmt.Errorf("remove remaining exact handoff helper executable: %w", err)
		}
		result.ExecutableRemoved = true
	}
	if _, err := host.runner().Run(ctx, "systemctl", "--user", "daemon-reload"); err != nil {
		return result, fmt.Errorf("reload user systemd after finishing helper removal: %w", err)
	}
	return result, nil
}

func (host *LinuxHost) inspectStatic(spec HelperSpec) (*secureFile, *secureFile, error) {
	if err := validateSpec(spec); err != nil {
		return nil, nil, err
	}
	unit, err := openSecureFile(spec.UnitPath, ownerFileMode, "handoff helper unit")
	if err != nil {
		return nil, nil, err
	}
	unitSHA, err := hashOpenFile(unit.file)
	if err != nil || unitSHA != spec.UnitSHA256 {
		unit.file.Close()
		return nil, nil, errors.New("handoff helper unit SHA-256 does not match its spec")
	}
	executable, err := openSecureFile(spec.ExecutablePath, ownerExecMode, "installed handoff helper")
	if err != nil {
		unit.file.Close()
		return nil, nil, err
	}
	executableSHA, err := hashOpenFile(executable.file)
	if err != nil || executableSHA != spec.ExecutableSHA256 {
		unit.file.Close()
		executable.file.Close()
		return nil, nil, errors.New("installed handoff helper SHA-256 does not match its spec")
	}
	return unit, executable, nil
}

func (host *LinuxHost) systemdProperties(ctx context.Context, unit string) (map[string]string, error) {
	properties := make(map[string]string, 6)
	for _, property := range []string{"MainPID", "ControlPID", "ControlGroup", "FragmentPath", "ActiveState", "UnitFileState"} {
		output, err := host.runner().Run(ctx, "systemctl", "--user", "show", unit, "--property="+property, "--value")
		if err != nil {
			return nil, fmt.Errorf("read handoff helper systemd property %s: %w", property, err)
		}
		if len(output) > maxPropertyBytes {
			return nil, fmt.Errorf("handoff helper systemd property %s exceeds its limit", property)
		}
		value := strings.TrimSpace(string(output))
		if strings.ContainsAny(value, "\r\n\x00") {
			return nil, fmt.Errorf("handoff helper systemd property %s is malformed", property)
		}
		properties[property] = value
	}
	return properties, nil
}

func validateSpec(spec HelperSpec) error {
	profile := identityTargetProfile()
	unitName, err := helperUnitName(profile, spec.TransactionID)
	if err != nil {
		return err
	}
	if spec.TargetProfileID != profile.ProfileID || spec.UnitName != unitName || filepath.Base(spec.TransactionDirectory) != spec.TransactionID {
		return errors.New("handoff helper spec does not match the canonical target identity")
	}
	for label, path := range map[string]string{
		"transaction directory": spec.TransactionDirectory, "unit path": spec.UnitPath,
		"executable path": spec.ExecutablePath, "journal path": spec.JournalPath,
		"listener socket path": spec.ListenerSocketPath,
	} {
		if err := validateCanonicalAbsolute(path, label); err != nil {
			return err
		}
	}
	if filepath.Base(spec.UnitPath) != unitName || filepath.Dir(spec.JournalPath) != spec.TransactionDirectory || filepath.Base(spec.JournalPath) != journalBasename ||
		filepath.Dir(filepath.Dir(spec.ExecutablePath)) != spec.TransactionDirectory || filepath.Base(filepath.Dir(spec.ExecutablePath)) != helperDirectory ||
		filepath.Base(spec.ExecutablePath) != profile.ManagerBinary {
		return errors.New("handoff helper spec paths are not transaction-bound")
	}
	wantedSocket, err := TransferSocketPath(spec.TransactionDirectory, spec.TransactionID)
	if err != nil || wantedSocket != spec.ListenerSocketPath {
		return errors.New("handoff helper listener socket path is not canonical")
	}
	wantedArgv := helperArgv(spec.ExecutablePath, spec.TransactionID, spec.JournalPath, spec.ListenerSocketPath)
	if !reflect.DeepEqual(spec.Argv, wantedArgv) || !sha256Pattern.MatchString(spec.ExecutableSHA256) || !sha256Pattern.MatchString(spec.UnitSHA256) {
		return errors.New("handoff helper spec arguments or digests are invalid")
	}
	unit, err := renderUnit(spec.UnitName, spec.TransactionID, spec.TransactionDirectory, spec.Argv)
	if err != nil {
		return err
	}
	hash := sha256.Sum256(unit)
	if hex.EncodeToString(hash[:]) != spec.UnitSHA256 {
		return errors.New("handoff helper unit digest is not deterministic")
	}
	return nil
}

func validateStaticProof(spec HelperSpec, proof HelperProof) error {
	if proof.TransactionID != spec.TransactionID || proof.UnitName != spec.UnitName || proof.UnitPath != spec.UnitPath ||
		proof.UnitSHA256 != spec.UnitSHA256 || proof.ExecutablePath != spec.ExecutablePath ||
		proof.ExecutableSHA256 != spec.ExecutableSHA256 || !reflect.DeepEqual(proof.Argv, spec.Argv) ||
		!validControlGroup(proof.ControlGroup) {
		return errors.New("persisted handoff helper static proof is incomplete or does not match its spec")
	}
	return nil
}

func validateLiveProof(spec HelperSpec, proof HelperProof) error {
	if err := validateStaticProof(spec, proof); err != nil {
		return err
	}
	if !proof.Active || proof.MainPID <= 1 || !bootIDPattern.MatchString(proof.BootID) {
		return errors.New("handoff helper live proof is incomplete")
	}
	return nil
}

func validateDisableProof(spec HelperSpec, proof HelperProof) error {
	if err := validateStaticProof(spec, proof); err != nil {
		return err
	}
	if proof.MainPID <= 1 {
		return errors.New("handoff helper self-disable proof has no calling PID")
	}
	return nil
}

func sameStaticHelperIdentity(left, right HelperProof) bool {
	return left.TransactionID == right.TransactionID && left.UnitName == right.UnitName && left.UnitPath == right.UnitPath &&
		left.UnitSHA256 == right.UnitSHA256 && left.ExecutablePath == right.ExecutablePath &&
		left.ExecutableSHA256 == right.ExecutableSHA256 && reflect.DeepEqual(left.Argv, right.Argv) &&
		left.ControlGroup == right.ControlGroup
}

func helperArgv(executable, transactionID, journalPath, socketPath string) []string {
	return []string{executable, HelperSubcommand, "--transaction", transactionID, "--journal", journalPath, "--listener-socket", socketPath}
}

func renderUnit(unitName, transactionID, workingDirectory string, argv []string) ([]byte, error) {
	quoted := make([]string, len(argv))
	for index, value := range argv {
		encoded, err := quoteSystemd(value)
		if err != nil {
			return nil, err
		}
		quoted[index] = encoded
	}
	working, err := quoteSystemd(workingDirectory)
	if err != nil {
		return nil, err
	}
	if strings.ContainsAny(unitName+transactionID, "\r\n\x00") {
		return nil, errors.New("handoff helper unit identity contains control bytes")
	}
	content := fmt.Sprintf(`[Unit]
Description=Namespace handoff owner %s
After=default.target
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=%s
WorkingDirectory=%s
Restart=on-failure
RestartSec=2s
KillMode=mixed
UMask=0077
NoNewPrivileges=yes

[Install]
WantedBy=default.target
`, transactionID, strings.Join(quoted, " "), working)
	return []byte(content), nil
}

func quoteSystemd(value string) (string, error) {
	if value == "" || strings.IndexByte(value, 0) >= 0 {
		return "", errors.New("systemd argument is empty or contains NUL")
	}
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return "", errors.New("systemd argument contains a control character")
		}
	}
	value = strings.ReplaceAll(value, "\\", "\\\\")
	value = strings.ReplaceAll(value, "\"", "\\\"")
	value = strings.ReplaceAll(value, "%", "%%")
	return "\"" + value + "\"", nil
}

func unitBytes(spec HelperSpec) ([]byte, error) {
	if err := validateSpec(spec); err != nil {
		return nil, err
	}
	return renderUnit(spec.UnitName, spec.TransactionID, spec.TransactionDirectory, spec.Argv)
}

func parsePositivePID(value string) (int, error) {
	pid, err := strconv.Atoi(value)
	if err != nil || pid <= 1 {
		return 0, errors.New("invalid process id")
	}
	return pid, nil
}

func validControlGroup(value string) bool {
	return strings.HasPrefix(value, "/") && value != "/" && !strings.ContainsAny(value, "\r\n\x00") && filepath.Clean(value) == value
}

func processInExactControlGroup(data []byte, wanted string) bool {
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		parts := strings.SplitN(line, ":", 3)
		if len(parts) == 3 && parts[2] == wanted {
			return true
		}
	}
	return false
}

func parseCmdline(data []byte) ([]string, error) {
	if len(data) == 0 || data[len(data)-1] != 0 {
		return nil, errors.New("process command line is not NUL terminated")
	}
	parts := bytes.Split(data[:len(data)-1], []byte{0})
	argv := make([]string, len(parts))
	for index, part := range parts {
		if len(part) == 0 {
			return nil, errors.New("process command line contains an empty argument")
		}
		argv[index] = string(part)
	}
	return argv, nil
}

func readBoundedFile(path string, limit int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("file exceeds its bounded read limit")
	}
	return data, nil
}

func hashOpenFile(file *os.File) (string, error) {
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

type fileIdentity struct {
	device uint64
	inode  uint64
	uid    uint32
	mode   os.FileMode
	nlink  uint64
}

type secureFile struct {
	path     string
	file     *os.File
	identity fileIdentity
}

func openSecureFile(path string, requiredMode os.FileMode, label string) (*secureFile, error) {
	if err := validateCanonicalAbsolute(path, label); err != nil {
		return nil, err
	}
	if err := rejectSymlinkComponents(path); err != nil {
		return nil, fmt.Errorf("%s path is unsafe: %w", label, err)
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", label, err)
	}
	file := os.NewFile(uintptr(fd), path)
	if file == nil {
		_ = syscall.Close(fd)
		return nil, fmt.Errorf("open %s: invalid file descriptor", label)
	}
	identity, err := inspectFile(file, requiredMode)
	if err != nil {
		file.Close()
		return nil, fmt.Errorf("inspect %s: %w", label, err)
	}
	secure := &secureFile{path: path, file: file, identity: identity}
	if err := secure.verifyPath(); err != nil {
		file.Close()
		return nil, fmt.Errorf("verify %s path identity: %w", label, err)
	}
	return secure, nil
}

func validateSecureFile(path string, mode os.FileMode, label string) error {
	file, err := openSecureFile(path, mode, label)
	if err != nil {
		return err
	}
	return file.file.Close()
}

func (file *secureFile) verifyPath() error {
	info, err := os.Lstat(file.path)
	if err != nil {
		return err
	}
	actual, err := identityFromInfo(info)
	if err != nil || actual != file.identity {
		return errors.New("path no longer names the opened regular file")
	}
	return nil
}

func inspectFile(file *os.File, requiredMode os.FileMode) (fileIdentity, error) {
	info, err := file.Stat()
	if err != nil {
		return fileIdentity{}, err
	}
	identity, err := identityFromInfo(info)
	if err != nil {
		return fileIdentity{}, err
	}
	if identity.uid != uint32(os.Getuid()) || identity.nlink != 1 || info.Mode().Perm() != requiredMode {
		return fileIdentity{}, errors.New("file owner, mode, or link count is unsafe")
	}
	return identity, nil
}

func identityFromInfo(info os.FileInfo) (fileIdentity, error) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fileIdentity{}, errors.New("object is not a non-symlink regular file")
	}
	return fileIdentity{device: uint64(stat.Dev), inode: uint64(stat.Ino), uid: stat.Uid, mode: info.Mode().Perm(), nlink: uint64(stat.Nlink)}, nil
}

type secureDirectory struct {
	path     string
	file     *os.File
	identity directoryIdentity
}

type directoryIdentity struct {
	device uint64
	inode  uint64
	uid    uint32
	mode   os.FileMode
}

func openSecureDirectory(path string, exactMode os.FileMode, requireOwner bool) (*secureDirectory, error) {
	if err := validateCanonicalAbsolute(path, "directory"); err != nil {
		return nil, err
	}
	if err := rejectSymlinkComponents(path); err != nil {
		return nil, err
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	if file == nil {
		_ = syscall.Close(fd)
		return nil, errors.New("open directory returned an invalid descriptor")
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || requireOwner && stat.Uid != uint32(os.Getuid()) ||
		exactMode != 0 && info.Mode().Perm() != exactMode || exactMode == 0 && info.Mode().Perm()&0o022 != 0 {
		file.Close()
		return nil, errors.New("directory owner, type, or mode is unsafe")
	}
	directory := &secureDirectory{path: path, file: file, identity: directoryIdentity{device: uint64(stat.Dev), inode: uint64(stat.Ino), uid: stat.Uid, mode: info.Mode().Perm()}}
	if err := directory.verifyPath(); err != nil {
		file.Close()
		return nil, err
	}
	return directory, nil
}

func (directory *secureDirectory) Close() error { return directory.file.Close() }
func (directory *secureDirectory) fd() int      { return int(directory.file.Fd()) }

func (directory *secureDirectory) verifyPath() error {
	info, err := os.Lstat(directory.path)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 ||
		uint64(stat.Dev) != directory.identity.device || uint64(stat.Ino) != directory.identity.inode || stat.Uid != directory.identity.uid || info.Mode().Perm() != directory.identity.mode {
		return errors.New("directory path identity changed")
	}
	return nil
}

func ensureSecureChildDirectory(parent *secureDirectory, name string) (*secureDirectory, error) {
	if name == "" || filepath.Base(name) != name || name == "." || name == ".." {
		return nil, errors.New("child directory name is invalid")
	}
	if err := parent.verifyPath(); err != nil {
		return nil, err
	}
	err := syscall.Mkdirat(parent.fd(), name, ownerDirMode)
	if err != nil && !errors.Is(err, syscall.EEXIST) {
		return nil, err
	}
	if err == nil {
		if err := parent.file.Sync(); err != nil {
			return nil, err
		}
	}
	return openSecureDirectory(filepath.Join(parent.path, name), ownerDirMode, true)
}

func rejectSymlinkComponents(path string) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return errors.New("path is not canonical and absolute")
	}
	current := string(filepath.Separator)
	parts := strings.Split(strings.TrimPrefix(path, current), current)
	for _, part := range parts {
		if part == "" {
			continue
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("path component %s is a symbolic link", current)
		}
		if info.IsDir() {
			stat, ok := info.Sys().(*syscall.Stat_t)
			if !ok || stat.Uid != 0 && stat.Uid != uint32(os.Getuid()) {
				return fmt.Errorf("path component %s has an unexpected owner", current)
			}
			if info.Mode().Perm()&0o022 != 0 && !(stat.Uid == 0 && info.Mode()&os.ModeSticky != 0) {
				return fmt.Errorf("path component %s is writable by another identity", current)
			}
		}
	}
	return nil
}

func installExecutable(directory *secureDirectory, name string, artifact *secureFile, expectedSHA string) error {
	if existing, err := openSecureFile(filepath.Join(directory.path, name), ownerExecMode, "installed handoff helper"); err == nil {
		defer existing.file.Close()
		hash, hashErr := hashOpenFile(existing.file)
		if hashErr != nil || hash != expectedSHA {
			return errors.New("existing handoff helper executable does not match its immutable artifact")
		}
		return nil
	} else if !errors.Is(underlyingPathError(err), syscall.ENOENT) {
		return err
	}
	if _, err := artifact.file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	return atomicInstall(directory, name, artifact.file, ownerExecMode, expectedSHA)
}

func installStaticFile(directory *secureDirectory, name string, content []byte, mode os.FileMode, expectedSHA string) error {
	if existing, err := openSecureFile(filepath.Join(directory.path, name), mode, "persistent handoff helper file"); err == nil {
		defer existing.file.Close()
		hash, hashErr := hashOpenFile(existing.file)
		if hashErr != nil || hash != expectedSHA {
			return errors.New("existing persistent handoff helper file has conflicting content")
		}
		return nil
	} else if !errors.Is(underlyingPathError(err), syscall.ENOENT) {
		return err
	}
	return atomicInstall(directory, name, bytes.NewReader(content), mode, expectedSHA)
}

func atomicInstall(directory *secureDirectory, name string, source io.Reader, mode os.FileMode, expectedSHA string) (returnErr error) {
	if name == "" || filepath.Base(name) != name || strings.HasPrefix(name, ".") {
		return errors.New("atomic install basename is invalid")
	}
	if err := directory.verifyPath(); err != nil {
		return err
	}
	temporary, err := randomTemporaryName()
	if err != nil {
		return err
	}
	fd, err := syscall.Openat(directory.fd(), temporary, syscall.O_CREAT|syscall.O_EXCL|syscall.O_WRONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, uint32(mode))
	if err != nil {
		return err
	}
	file := os.NewFile(uintptr(fd), filepath.Join(directory.path, temporary))
	if file == nil {
		_ = syscall.Close(fd)
		return errors.New("atomic install returned an invalid descriptor")
	}
	defer func() {
		_ = file.Close()
		if returnErr != nil {
			_ = syscall.Unlinkat(directory.fd(), temporary)
		}
	}()
	hash := sha256.New()
	if _, err := io.Copy(io.MultiWriter(file, hash), source); err != nil {
		return err
	}
	if hex.EncodeToString(hash.Sum(nil)) != expectedSHA {
		return errors.New("atomic install source changed while copying")
	}
	if err := file.Chmod(mode); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := directory.verifyPath(); err != nil {
		return err
	}
	if err := renameAtNoReplace(directory.fd(), temporary, name); err != nil {
		return err
	}
	if err := directory.file.Sync(); err != nil {
		return err
	}
	installed, err := openSecureFile(filepath.Join(directory.path, name), mode, "atomically installed handoff helper file")
	if err != nil {
		return err
	}
	defer installed.file.Close()
	actualSHA, err := hashOpenFile(installed.file)
	if err != nil || actualSHA != expectedSHA {
		return errors.New("atomically installed handoff helper file failed final verification")
	}
	return nil
}

func randomTemporaryName() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return ".handoff-tmp-" + hex.EncodeToString(value), nil
}

func removeExactFile(directory *secureDirectory, name string, expected fileIdentity) error {
	if err := directory.verifyPath(); err != nil {
		return err
	}
	file, err := openSecureFile(filepath.Join(directory.path, name), expected.mode, "handoff helper removal target")
	if err != nil {
		return err
	}
	actual := file.identity
	file.file.Close()
	if actual != expected {
		return errors.New("handoff helper removal target identity changed")
	}
	if err := directory.verifyPath(); err != nil {
		return err
	}
	if err := syscall.Unlinkat(directory.fd(), name); err != nil {
		return err
	}
	return directory.file.Sync()
}

func underlyingPathError(err error) error {
	for err != nil {
		var pathError *os.PathError
		if errors.As(err, &pathError) {
			err = pathError.Err
			continue
		}
		return err
	}
	return nil
}
