package selfupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/journal"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

type Version struct {
	Version           string    `json:"version"`
	SourceCommit      string    `json:"source_commit"`
	Path              string    `json:"path"`
	SHA256            string    `json:"sha256"`
	VerifiedAt        time.Time `json:"verified_at"`
	PlatformCommitted bool      `json:"platform_committed"`
}

type Activation struct {
	PlanPath      string    `json:"plan_path"`
	CandidateSHA  string    `json:"candidate_sha256"`
	CandidatePath string    `json:"candidate_path"`
	StartedAt     time.Time `json:"started_at"`
}

type State struct {
	SchemaVersion int         `json:"schema_version"`
	Current       *Version    `json:"current,omitempty"`
	Previous      *Version    `json:"previous,omitempty"`
	Candidate     *Version    `json:"candidate,omitempty"`
	Activation    *Activation `json:"activation,omitempty"`
	UpdatedAt     time.Time   `json:"updated_at"`
}

type Plan struct {
	SchemaVersion         int       `json:"schema_version"`
	Mode                  string    `json:"mode,omitempty"`
	PlanPath              string    `json:"plan_path"`
	Status                string    `json:"status"`
	StatePath             string    `json:"state_path"`
	InstallPath           string    `json:"install_path"`
	SocketPath            string    `json:"socket_path"`
	ControlTokenFile      string    `json:"control_token_file"`
	UnitName              string    `json:"unit_name"`
	CandidateVersion      string    `json:"candidate_version"`
	CandidateSHA          string    `json:"candidate_sha256"`
	CandidatePath         string    `json:"candidate_path,omitempty"`
	PlatformCommit        string    `json:"platform_commit,omitempty"`
	RecoveryTransactionID string    `json:"recovery_transaction_id,omitempty"`
	RecoveryJournalPath   string    `json:"recovery_journal_path,omitempty"`
	SupersededPlanPath    string    `json:"superseded_plan_path,omitempty"`
	SupersededPlanSHA     string    `json:"superseded_plan_sha256,omitempty"`
	PreviousPath          string    `json:"previous_path"`
	Activated             bool      `json:"activated"`
	Acknowledged          bool      `json:"acknowledged"`
	CreatedAt             time.Time `json:"created_at"`
	UpdatedAt             time.Time `json:"updated_at"`
	HealthTimeoutMS       int       `json:"health_timeout_ms"`
	BootID                string    `json:"boot_id,omitempty"`
	Error                 string    `json:"error,omitempty"`
}

const ordinaryRolledBackStatus = "rolled_back"

// withOrdinaryActivationMutationLock serializes all cross-process mutations of
// one ordinary activation plan, its Candidate/Activation state and the stable
// executable. Callers must not perform blocking systemd or network operations
// while holding this lock. Activate acquires the broader recovery lock first;
// acknowledgement and watchdog paths never acquire that broader lock.
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

type Runner interface {
	Run(context.Context, string, ...string) error
}

type CommandRunner struct{}

func (CommandRunner) Run(ctx context.Context, name string, args ...string) error {
	output, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %w: %s", name, err, strings.TrimSpace(string(output)))
	}
	return nil
}

type Manager struct {
	Profile                  identity.ActiveProfile
	ConfigPath               string
	Root                     string
	StatePath                string
	InstallPath              string
	SocketPath               string
	ControlTokenFile         string
	UnitName                 string
	RunningVersion           string
	Client                   release.Client
	Runner                   Runner
	Now                      func() time.Time
	BootID                   func() string
	RecoveryProcessVerifier  func(context.Context, string, string, string) error
	RecoveryUnitQuiescer     func(context.Context, string, []string, string) error
	RecoveryUnitActive       func(context.Context, string) (bool, error)
	RecoveryUnitEnabled      func(context.Context, string) (bool, error)
	RecoveryUnitFencer       func(context.Context, string, bool) error
	RecoveryWatchdogVerifier func(context.Context, string, string, string, string) error
	OrdinaryWatchdogVerifier func(context.Context, string, string, string, string) error
	recoveryExecutableReader func(string, string) ([]byte, error)
}

// ProbeTransientUnit proves that the current user-systemd session can host
// the independent watchdog required for a safe Manager activation. --wait
// verifies the oneshot result and --collect removes the transient unit after
// the side-effect-free true command exits.
func (m *Manager) ProbeTransientUnit(ctx context.Context) error {
	if err := m.runner().Run(ctx, "systemd-run", "--user", "--quiet", "--wait", "--collect", "--property=Type=oneshot", "/usr/bin/true"); err != nil {
		return fmt.Errorf("probe user-systemd transient unit: %w", err)
	}
	return nil
}

func (m *Manager) Prepare(ctx context.Context, manifest release.Manifest) error {
	if len(manifest.SourceCommit) < 12 {
		return errors.New("release source commit is invalid")
	}
	rejected, err := m.activationRejected(manifest)
	if err != nil {
		return fmt.Errorf("check rejected Manager activation: %w", err)
	}
	if rejected {
		return errors.New("Manager candidate was rejected by its activation watchdog and cannot be retried")
	}
	if err := ensureRecoveryDirectory(m.Root); err != nil {
		return fmt.Errorf("prepare Manager binary root: %w", err)
	}
	releaseRecoveryLock, err := acquireRecoveryLock(m.Root)
	if err != nil {
		return fmt.Errorf("coordinate Manager update with external recovery: %w", err)
	}
	defer releaseRecoveryLock()
	artifact, ok := manifest.Manager.Artifacts[runtime.GOARCH]
	if !ok {
		return errors.New("manager artifact is missing")
	}
	data, err := m.Client.FetchArtifact(ctx, artifact, 128<<20)
	if err != nil {
		return err
	}
	id := safeID(manifest.Manager.Version + "-" + manifest.SourceCommit[:12])
	dir := filepath.Join(m.Root, "versions", id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	path := filepath.Join(dir, m.managerBinaryName())
	if err := atomicfile.WriteFile(path, data, 0o700); err != nil {
		return err
	}
	candidate := Version{Version: manifest.Manager.Version, SourceCommit: manifest.SourceCommit, Path: path, SHA256: sha256Hex(data), VerifiedAt: m.now()}
	if err := m.ensureVersionMetadata(candidate); err != nil {
		return fmt.Errorf("record verified Manager candidate artifact: %w", err)
	}
	probeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	output, err := exec.CommandContext(probeCtx, path, "version").CombinedOutput()
	if err != nil {
		return fmt.Errorf("verify staged manager: %w", err)
	}
	reportedVersion := strings.TrimSpace(string(output))
	if reportedVersion == "" {
		return errors.New("staged manager returned an empty version")
	}
	if reportedVersion != manifest.Manager.Version {
		return fmt.Errorf("staged manager version %q does not match release version %q", reportedVersion, manifest.Manager.Version)
	}
	state, err := m.load()
	if err != nil {
		return err
	}
	if state.Current == nil {
		current, backupErr := m.backupRunningVersion()
		if backupErr != nil {
			return backupErr
		}
		state.Current = current
	}
	state.Candidate = &candidate
	state.Activation = nil
	state.UpdatedAt = m.now()
	return atomicfile.WriteJSON(m.StatePath, state, 0o600)
}

// DiscardPrepared removes only the exact uncommitted Candidate created for the
// supplied immutable manifest. It deliberately leaves the verified version
// directory in place: the normal retention-aware maintenance loop owns artifact
// deletion. The recovery lock serializes this inverse transition with Prepare,
// Activate and external recovery.
func (m *Manager) DiscardPrepared(manifest release.Manifest) error {
	if !validSourceCommit(manifest.SourceCommit) || manifest.Manager.Version == "" {
		return errors.New("release Manager identity is invalid")
	}
	artifact, ok := manifest.Manager.Artifacts[runtime.GOARCH]
	if !ok || !validSHA256(artifact.SHA256) {
		return errors.New("release Manager artifact identity is invalid")
	}
	expectedPath := filepath.Join(m.Root, "versions", safeID(manifest.Manager.Version+"-"+manifest.SourceCommit[:12]), m.managerBinaryName())
	if _, err := os.Lstat(m.Root); err != nil {
		if os.IsNotExist(err) {
			if _, stateErr := os.Lstat(m.StatePath); os.IsNotExist(stateErr) {
				return nil
			}
			return errors.New("Manager self-update state exists without its binary root")
		}
		return fmt.Errorf("inspect Manager binary root before prepared cleanup: %w", err)
	}
	if err := validateRecoveryDirectory(m.Root, true); err != nil {
		return fmt.Errorf("validate Manager binary root before prepared cleanup: %w", err)
	}
	releaseRecoveryLock, err := acquireRecoveryLock(m.Root)
	if err != nil {
		return fmt.Errorf("coordinate prepared Manager cleanup with external recovery: %w", err)
	}
	defer releaseRecoveryLock()

	state, err := m.load()
	if err != nil {
		return err
	}
	if state.Candidate == nil {
		if state.Activation != nil {
			return errors.New("Manager activation exists without a Candidate during prepared cleanup")
		}
		return nil
	}
	candidate := *state.Candidate
	if state.Activation != nil {
		return errors.New("prepared Manager Candidate already has an activation")
	}
	if candidate.PlatformCommitted {
		return errors.New("prepared Manager Candidate is already Platform-committed")
	}
	if candidate.Version != manifest.Manager.Version || candidate.SourceCommit != manifest.SourceCommit ||
		candidate.SHA256 != artifact.SHA256 || candidate.Path != expectedPath || candidate.VerifiedAt.IsZero() {
		return errors.New("prepared Manager Candidate does not exactly match the release manifest")
	}
	if !filepath.IsAbs(candidate.Path) || filepath.Clean(candidate.Path) != candidate.Path {
		return errors.New("prepared Manager Candidate path is not canonical")
	}
	if digest, hashErr := fileSHA256(candidate.Path); hashErr != nil || digest != candidate.SHA256 {
		return errors.New("prepared Manager Candidate artifact no longer matches its verified checksum")
	}
	var metadata Version
	if err := atomicfile.ReadJSON(filepath.Join(filepath.Dir(candidate.Path), "metadata.json"), &metadata); err != nil || metadata != candidate {
		return errors.New("prepared Manager Candidate metadata does not exactly match state")
	}
	if err := validateVersionDirectoryContents(filepath.Dir(candidate.Path), m.managerBinaryName()); err != nil {
		return fmt.Errorf("validate prepared Manager Candidate directory: %w", err)
	}
	state.Candidate = nil
	state.UpdatedAt = m.now()
	if err := atomicfile.WriteJSON(m.StatePath, state, 0o600); err != nil {
		return err
	}
	settled, err := m.load()
	if err != nil {
		return fmt.Errorf("re-read Manager state after prepared cleanup: %w", err)
	}
	if settled.Candidate != nil || settled.Activation != nil {
		return errors.New("prepared Manager Candidate cleanup did not settle both candidate references")
	}
	return nil
}

func (m *Manager) MarkPlatformCommitted(manifest release.Manifest) error {
	state, err := m.load()
	if err != nil {
		return err
	}
	if state.Current != nil && state.Current.SourceCommit == manifest.SourceCommit {
		return nil
	}
	if state.Candidate == nil || state.Candidate.SourceCommit != manifest.SourceCommit {
		return errors.New("verified manager candidate does not match committed release")
	}
	state.Candidate.PlatformCommitted = true
	state.UpdatedAt = m.now()
	return atomicfile.WriteJSON(m.StatePath, state, 0o600)
}

// Activate atomically switches the stable ExecStart path only after the
// Platform generation has committed. A watchdog running from the immutable active
// binary lives in a separate transient user-systemd unit, so it survives the
// Manager service restart and restores the previous binary if the candidate never
// acknowledges startup and passes the control-socket health check.
func (m *Manager) Activate(ctx context.Context, manifest release.Manifest) error {
	state, err := m.load()
	if err != nil {
		return err
	}
	if state.Current != nil && state.Current.SourceCommit == manifest.SourceCommit {
		return nil
	}
	releaseRecoveryLock, err := acquireRecoveryLock(m.Root)
	if err != nil {
		return fmt.Errorf("coordinate Manager activation with external recovery: %w", err)
	}
	defer releaseRecoveryLock()
	// The recovery lock serializes every transition, but a current-generation
	// fast path does not mutate self-update state and must also work for an
	// installation whose binary root has not needed an activation yet. Re-read
	// after taking the lock so a concurrent recovery cannot invalidate the first
	// observation.
	state, err = m.load()
	if err != nil {
		return err
	}
	if state.Current != nil && state.Current.SourceCommit == manifest.SourceCommit {
		return nil
	}
	if state.Current == nil || state.Candidate == nil || !state.Candidate.PlatformCommitted || state.Candidate.SourceCommit != manifest.SourceCommit {
		return errors.New("manager candidate is not ready for activation")
	}
	installPath, err := m.installPath()
	if err != nil {
		return err
	}
	unit := m.UnitName
	if unit == "" {
		unit = m.managerUnitName()
	}
	activationsRoot := filepath.Join(m.Root, "activations")
	if err := ensureRecoveryDirectory(activationsRoot); err != nil {
		return fmt.Errorf("prepare owner-only Manager activation directory: %w", err)
	}
	planPath := filepath.Join(activationsRoot, safeID(manifest.SourceCommit)+".json")
	if m.ControlTokenFile == "" {
		return errors.New("manager control token file is required for safe activation")
	}
	var plan Plan
	var previous Version
	if err := withOrdinaryActivationMutationLock(planPath, func() error {
		latest, readErr := m.load()
		if readErr != nil {
			return readErr
		}
		if latest.Current != nil && latest.Current.SourceCommit == manifest.SourceCommit {
			return nil
		}
		if latest.Current == nil || latest.Candidate == nil || !latest.Candidate.PlatformCommitted || latest.Candidate.SourceCommit != manifest.SourceCommit {
			return errors.New("manager candidate is not ready for activation")
		}
		expected := Plan{SchemaVersion: 1, PlanPath: planPath, Status: "prepared", StatePath: m.StatePath, InstallPath: installPath, SocketPath: m.SocketPath, ControlTokenFile: m.ControlTokenFile, UnitName: unit, CandidateVersion: latest.Candidate.Version, CandidateSHA: latest.Candidate.SHA256, CandidatePath: latest.Candidate.Path, PlatformCommit: manifest.SourceCommit, PreviousPath: latest.Current.Path, CreatedAt: m.now(), UpdatedAt: m.now(), HealthTimeoutMS: 45_000, BootID: m.bootID()}
		if _, statErr := os.Lstat(planPath); statErr == nil {
			var existing Plan
			if err := atomicfile.ReadJSON(planPath, &existing); err != nil {
				return fmt.Errorf("read existing Manager activation plan: %w", err)
			}
			if err := validateOrdinaryActivationIdentity(expected, existing); err != nil {
				return fmt.Errorf("existing Manager activation plan is not reusable: %w", err)
			}
			switch existing.Status {
			case "prepared", "activated", "acknowledged":
				expected = existing
			case ordinaryRolledBackStatus, recoverySupersededStatus:
				return fmt.Errorf("Manager candidate has terminal activation status %q and cannot be reactivated", existing.Status)
			default:
				return fmt.Errorf("existing Manager activation plan has unsupported status %q", existing.Status)
			}
			if err := m.validateRecoveryPlanBinding(expected, latest, *latest.Candidate, manifest.SourceCommit, false); err != nil {
				return fmt.Errorf("validate existing Manager activation plan: %w", err)
			}
		} else if !os.IsNotExist(statErr) {
			return fmt.Errorf("inspect Manager activation plan: %w", statErr)
		} else {
			if latest.Activation != nil {
				return errors.New("Manager activation state references a missing plan")
			}
			if err := persistActivationPlan(planPath, expected); err != nil {
				return err
			}
		}
		if latest.Activation == nil {
			latest.Activation = &Activation{PlanPath: planPath, CandidateSHA: latest.Candidate.SHA256, CandidatePath: latest.Candidate.Path, StartedAt: m.now()}
			latest.UpdatedAt = m.now()
			if err := atomicfile.WriteJSON(m.StatePath, latest, 0o600); err != nil {
				return err
			}
		} else if latest.Activation.PlanPath != planPath || latest.Activation.CandidateSHA != latest.Candidate.SHA256 || latest.Activation.CandidatePath != latest.Candidate.Path {
			return errors.New("Manager activation state belongs to another plan")
		}
		plan = expected
		previous = *latest.Current
		return nil
	}); err != nil {
		return err
	}
	if plan.PlanPath == "" {
		return nil
	}
	// Starting and inspecting systemd are intentionally outside the plan flock.
	// The final mutation below re-reads every durable binding after this call.
	if err := m.ensureOrdinaryWatchdog(ctx, plan, previous); err != nil {
		return err
	}
	return withOrdinaryActivationMutationLock(planPath, func() error {
		latest, readErr := m.load()
		if readErr != nil {
			return readErr
		}
		if latest.Current != nil && latest.Current.SourceCommit == manifest.SourceCommit {
			return nil
		}
		if latest.Current == nil || latest.Candidate == nil || latest.Activation == nil ||
			!latest.Candidate.PlatformCommitted || latest.Candidate.SourceCommit != manifest.SourceCommit {
			return errors.New("manager candidate lost activation ownership before stable replacement")
		}
		var durable Plan
		if err := atomicfile.ReadJSON(planPath, &durable); err != nil {
			return fmt.Errorf("re-read Manager activation plan before stable replacement: %w", err)
		}
		if err := validateOrdinaryActivationIdentity(plan, durable); err != nil {
			return err
		}
		switch durable.Status {
		case "prepared", "activated", "acknowledged":
		case ordinaryRolledBackStatus, recoverySupersededStatus:
			return fmt.Errorf("Manager activation reached terminal status %q before stable replacement", durable.Status)
		default:
			return fmt.Errorf("Manager activation has unsupported status %q before stable replacement", durable.Status)
		}
		if err := m.validateRecoveryPlanBinding(durable, latest, *latest.Candidate, manifest.SourceCommit, false); err != nil {
			return fmt.Errorf("revalidate Manager activation before stable replacement: %w", err)
		}
		candidate, err := os.ReadFile(latest.Candidate.Path)
		if err != nil {
			return err
		}
		if sha256Hex(candidate) != latest.Candidate.SHA256 {
			return errors.New("staged manager changed after verification")
		}
		stableSHA, err := fileSHA256(installPath)
		if err != nil {
			return fmt.Errorf("inspect stable Manager before activation: %w", err)
		}
		if stableSHA != latest.Candidate.SHA256 {
			if durable.Activated {
				return errors.New("activated Manager plan no longer matches the stable candidate binary")
			}
			if stableSHA != latest.Current.SHA256 {
				return errors.New("stable Manager matches neither Current nor Candidate during activation")
			}
			if err := atomicfile.WriteFile(installPath, candidate, 0o755); err != nil {
				return err
			}
		}
		if durable.Activated {
			return nil
		}
		durable.Activated = true
		durable.Status = "activated"
		durable.UpdatedAt = m.now()
		if err := persistActivationPlan(planPath, durable); err != nil {
			durable.Error = "persist activated Manager plan: " + err.Error()
			_, rollbackErr := restoreOrdinaryPreviousLocked(durable)
			return errors.Join(err, rollbackErr)
		}
		return nil
	})
}

func (m *Manager) ensureOrdinaryWatchdog(ctx context.Context, plan Plan, previous Version) error {
	if !validSourceCommit(plan.PlatformCommit) || !validSHA256(previous.SHA256) || previous.Path == "" {
		return errors.New("ordinary Manager watchdog identity is incomplete")
	}
	unit := m.watchdogUnitPrefix() + safeID(plan.PlatformCommit[:12])
	active, err := m.recoveryUnitIsActive(ctx, unit)
	if err != nil {
		return fmt.Errorf("inspect ordinary Manager activation watchdog: %w", err)
	}
	if !active {
		if !validManagerConfigPath(m.ConfigPath) {
			return errors.New("ordinary Manager watchdog config binding is invalid")
		}
		watchdogArguments := []string{"self-update-watchdog", "--plan", plan.PlanPath, "--config", m.ConfigPath}
		arguments := append([]string{"--user", "--quiet", "--collect", "--unit", unit, "--property=Type=exec", previous.Path}, watchdogArguments...)
		if err := m.runner().Run(ctx, "systemd-run", arguments...); err != nil {
			return fmt.Errorf("start manager activation watchdog: %w", err)
		}
		active, err = m.recoveryUnitIsActive(ctx, unit)
		if err != nil {
			return fmt.Errorf("verify ordinary Manager activation watchdog after launch: %w", err)
		}
		if !active {
			return errors.New("ordinary Manager activation watchdog was not proven active after launch")
		}
	}
	return m.verifyOrdinaryWatchdogProcess(ctx, unit, previous.Path, previous.SHA256, plan.PlanPath)
}

func (m *Manager) verifyOrdinaryWatchdogProcess(ctx context.Context, unit, executablePath, expectedSHA, planPath string) error {
	if m.OrdinaryWatchdogVerifier != nil {
		return m.OrdinaryWatchdogVerifier(ctx, unit, executablePath, expectedSHA, planPath)
	}
	mainPIDText, err := recoverySystemdProperty(ctx, unit, "MainPID")
	if err != nil {
		return err
	}
	controlPIDText, err := recoverySystemdProperty(ctx, unit, "ControlPID")
	if err != nil {
		return err
	}
	controlGroup, err := recoverySystemdProperty(ctx, unit, "ControlGroup")
	if err != nil {
		return err
	}
	mainPID, mainErr := strconv.Atoi(mainPIDText)
	controlPID, controlErr := strconv.Atoi(controlPIDText)
	if mainErr != nil || mainPID <= 1 || controlErr != nil || controlPID != 0 || controlGroup == "" || controlGroup == "/" {
		return errors.New("ordinary Manager watchdog has invalid systemd process metadata")
	}
	processExecutable := filepath.Join("/proc", strconv.Itoa(mainPID), "exe")
	processSHA, err := fileSHA256(processExecutable)
	if err != nil || processSHA != expectedSHA {
		return errors.New("ordinary Manager watchdog executable checksum does not match Current")
	}
	immutableInfo, err := os.Stat(executablePath)
	if err != nil {
		return err
	}
	processInfo, err := os.Stat(processExecutable)
	if err != nil || !os.SameFile(immutableInfo, processInfo) {
		return errors.New("ordinary Manager watchdog is not executing the immutable Current inode")
	}
	commandData, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(mainPID), "cmdline"))
	if err != nil {
		return fmt.Errorf("read ordinary Manager watchdog command line: %w", err)
	}
	arguments := strings.Split(strings.TrimRight(string(commandData), "\x00"), "\x00")
	want := []string{arguments[0], "self-update-watchdog", "--plan", planPath}
	if validManagerConfigPath(m.ConfigPath) {
		want = append(want, "--config", m.ConfigPath)
	}
	if !reflect.DeepEqual(arguments, want) {
		return errors.New("ordinary Manager watchdog command line does not exactly own the activation plan")
	}
	cgroupData, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(mainPID), "cgroup"))
	if err != nil || !recoveryProcessInExactControlGroup(cgroupData, controlGroup) {
		return errors.New("ordinary Manager watchdog process is outside its systemd control group")
	}
	return nil
}

func validManagerConfigPath(path string) bool {
	return path != "" && filepath.IsAbs(path) && filepath.Clean(path) == path && !strings.ContainsRune(path, 0)
}

// AcknowledgeStartup is called only after the new process is listening on its
// owner-only control socket. Hashing /proc/self/exe prevents an old process
// from acknowledging a candidate merely because the stable path was replaced.
func (m *Manager) AcknowledgeStartup() error {
	return m.acknowledgeExecutable("/proc/self/exe")
}

func (m *Manager) acknowledgeExecutable(executable string) error {
	hash, err := fileSHA256(executable)
	if err != nil {
		return err
	}
	state, err := m.load()
	if err != nil {
		return err
	}
	if state.Activation == nil {
		if state.Current != nil && hash != state.Current.SHA256 {
			return errors.New("running Manager is not the registered Current after activation settlement")
		}
		return nil
	}
	var plan Plan
	if err := atomicfile.ReadJSON(state.Activation.PlanPath, &plan); err != nil {
		return err
	}
	if plan.CandidateSHA != state.Activation.CandidateSHA {
		return errors.New("manager activation plan does not match running binary")
	}
	if plan.Mode == recoveryActivationMode {
		if hash != state.Activation.CandidateSHA {
			return errors.New("current recovery activation can only be settled by its recovery watchdog")
		}
		if plan.InstallPath != m.InstallPath || plan.UnitName != m.recoveryUnitName() {
			return errors.New("current recovery activation does not match Manager service configuration")
		}
		return m.acknowledgeRecoveryExecutable(plan)
	}
	if plan.Mode != "" {
		return errors.New("unsupported Manager activation mode")
	}
	var candidatePlan Plan
	var previous Version
	var restartRequired bool
	var validationErr error
	if err := withOrdinaryActivationMutationLock(plan.PlanPath, func() error {
		candidatePlan, previous, restartRequired, validationErr = m.validateOrdinaryAcknowledgementLocked(plan, hash, false)
		return nil
	}); err != nil {
		return err
	}
	if restartRequired {
		return restartOrdinaryManagerAfterUnlock(m.runner(), plan, validationErr)
	}
	if validationErr != nil {
		return validationErr
	}
	if candidatePlan.PlanPath == "" {
		return nil
	}
	// systemd inspection/launch is outside the plan flock. A rollback can win
	// here; the final locked validation below must then reject this stale proof.
	if err := m.ensureOrdinaryWatchdog(context.Background(), candidatePlan, previous); err != nil {
		candidatePlan.Error = "could not prove Manager activation watchdog before startup acknowledgement: " + err.Error()
		var rollbackErr error
		var shouldRestart bool
		if lockErr := withOrdinaryActivationMutationLock(plan.PlanPath, func() error {
			shouldRestart, rollbackErr = restoreOrdinaryPreviousLocked(candidatePlan)
			return nil
		}); lockErr != nil {
			return errors.New(journal.BoundDiagnostic(errors.Join(err, lockErr).Error()))
		}
		if shouldRestart {
			return restartOrdinaryManagerAfterUnlock(m.runner(), candidatePlan, rollbackErr)
		}
		if rollbackErr != nil {
			return rollbackErr
		}
		return errors.New(journal.BoundDiagnostic(err.Error()))
	}
	restartRequired = false
	validationErr = nil
	if err := withOrdinaryActivationMutationLock(plan.PlanPath, func() error {
		_, _, restartRequired, validationErr = m.validateOrdinaryAcknowledgementLocked(candidatePlan, hash, true)
		return nil
	}); err != nil {
		return err
	}
	if restartRequired {
		return restartOrdinaryManagerAfterUnlock(m.runner(), candidatePlan, validationErr)
	}
	return validationErr
}

// validateOrdinaryAcknowledgementLocked re-reads all durable activation
// bindings while the caller owns the per-plan flock. The first pass returns a
// snapshot used only for out-of-lock watchdog proof; the final pass repeats the
// validation and is the only path that writes acknowledged.
func (m *Manager) validateOrdinaryAcknowledgementLocked(expected Plan, executableSHA string, finalize bool) (Plan, Version, bool, error) {
	state, err := m.load()
	if err != nil {
		return Plan{}, Version{}, false, err
	}
	if state.Activation == nil {
		if state.Current != nil && state.Current.SHA256 == executableSHA && binaryMatches(expected.InstallPath, executableSHA) {
			return Plan{}, Version{}, false, nil
		}
		return Plan{}, Version{}, false, errors.New("ordinary Manager activation ownership was settled before candidate acknowledgement")
	}
	var plan Plan
	if err := atomicfile.ReadJSON(state.Activation.PlanPath, &plan); err != nil {
		return Plan{}, Version{}, false, err
	}
	if err := validateOrdinaryActivationIdentity(expected, plan); err != nil {
		return Plan{}, Version{}, false, err
	}
	if plan.Status == ordinaryRolledBackStatus {
		if state.Current == nil || executableSHA != state.Current.SHA256 || !binaryMatches(plan.InstallPath, executableSHA) {
			return Plan{}, Version{}, false, errors.New("rolled-back Manager activation does not match the registered Current binary")
		}
		return Plan{}, Version{}, false, settleOrdinaryRollbackState(plan)
	}
	if plan.Status == recoverySupersededStatus || plan.Status == "committed" {
		return Plan{}, Version{}, false, fmt.Errorf("ordinary Manager activation reached terminal status %q before acknowledgement", plan.Status)
	}
	if executableSHA != state.Activation.CandidateSHA {
		// A restart before stable replacement is a standard durable rejection. It
		// does not need a systemd restart because this process is already Current.
		if state.Current != nil && executableSHA == state.Current.SHA256 && binaryMatches(plan.InstallPath, executableSHA) {
			if plan.Error == "" {
				if plan.Activated {
					plan.Error = "candidate Manager was restored before startup acknowledgement"
				} else {
					plan.Error = "activation stopped before stable binary replacement"
				}
			}
			plan.Status = ordinaryRolledBackStatus
			plan.UpdatedAt = m.now()
			if err := persistActivationPlan(plan.PlanPath, plan); err != nil {
				return Plan{}, Version{}, false, err
			}
			return Plan{}, Version{}, false, settleOrdinaryRollbackState(plan)
		}
		plan.Error = "running Manager matches neither activation candidate nor previous binary"
		shouldRestart, rollbackErr := restoreOrdinaryPreviousLocked(plan)
		return Plan{}, Version{}, shouldRestart, rollbackErr
	}
	if state.Current == nil || state.Candidate == nil || !state.Candidate.PlatformCommitted ||
		state.Candidate.SHA256 != state.Activation.CandidateSHA ||
		state.Candidate.Path != state.Activation.CandidatePath ||
		!validSourceCommit(state.Candidate.SourceCommit) {
		return Plan{}, Version{}, false, errors.New("ordinary Manager activation has no committed Candidate binding")
	}
	if err := m.validateRecoveryPlanBinding(plan, state, *state.Candidate, state.Candidate.SourceCommit, false); err != nil {
		return Plan{}, Version{}, false, err
	}
	if !binaryMatches(plan.InstallPath, executableSHA) {
		return Plan{}, Version{}, false, errors.New("stable Manager no longer matches the acknowledging candidate")
	}
	if !finalize {
		return plan, *state.Current, false, nil
	}
	// Crash after atomic replacement but before plan.Activated was durable is a
	// safe roll-forward: the candidate itself proves the persisted intent by its
	// executable hash and completes the missing transition idempotently.
	plan.Activated = true
	plan.Acknowledged = true
	plan.Status = "acknowledged"
	plan.UpdatedAt = m.now()
	if err := persistActivationPlan(state.Activation.PlanPath, plan); err != nil {
		return Plan{}, Version{}, false, err
	}
	return plan, *state.Current, false, nil
}

func restartOrdinaryManagerAfterUnlock(runner Runner, plan Plan, result error) error {
	if err := runner.Run(context.Background(), "systemctl", "--user", "restart", "--no-block", plan.UnitName); err != nil {
		return errors.New(journal.BoundDiagnostic(errors.Join(result, fmt.Errorf("previous Manager restored but restart failed: %w", err)).Error()))
	}
	return result
}

func (m *Manager) acknowledgeRecoveryExecutable(plan Plan) error {
	ownership, err := readRecoveryTakeoverOwnership(m.Profile, plan)
	if err != nil {
		return fmt.Errorf("validate current recovery activation ownership: %w", err)
	}
	return withRecoveryTakeoverMutationLock(ownership.Path, func() error {
		latestOwnership, readErr := readRecoveryTakeoverOwnership(m.Profile, plan)
		if readErr != nil {
			return readErr
		}
		if recoveryPhaseBefore(latestOwnership.Phase, recoveryTakeoverWatchdogOwned) ||
			latestOwnership.Phase == recoveryTakeoverRolledBack || latestOwnership.Phase == recoveryTakeoverCommitted {
			return errors.New("current recovery activation watchdog has not retained acknowledgement ownership")
		}
		_, state, readErr := readRecoverySelfUpdateState(plan.StatePath)
		if readErr != nil {
			return readErr
		}
		_, durablePlan, readErr := readRecoveryActivationPlan(plan.PlanPath)
		if readErr != nil {
			return readErr
		}
		if err := validateRecoveryPlanOwnership(durablePlan, latestOwnership); err != nil {
			return err
		}
		if !recoveryStateHasOriginalBase(state, latestOwnership) || !recoveryCandidateMatches(state.Candidate, latestOwnership) ||
			!recoveryActivationMatches(state.Activation, latestOwnership) {
			return errors.New("current recovery activation state does not match its transaction")
		}
		if durablePlan.Status != "activated" && durablePlan.Status != "acknowledged" {
			return errors.New("current recovery activation plan is not ready for acknowledgement")
		}
		verifyCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := m.verifyRecoveryServiceProcess(verifyCtx, durablePlan.UnitName, durablePlan.CandidateSHA); err != nil {
			return fmt.Errorf("verify current recovery activation process: %w", err)
		}
		if durablePlan.BootID != m.bootID() {
			if err := m.ensureRecoveryWatchdog(verifyCtx, latestOwnership); err != nil {
				return fmt.Errorf("re-arm current recovery watchdog after reboot: %w", err)
			}
		}
		durablePlan.Activated = true
		durablePlan.Acknowledged = true
		durablePlan.Status = "acknowledged"
		durablePlan.UpdatedAt = m.now()
		return persistActivationPlan(durablePlan.PlanPath, durablePlan)
	})
}

func (m *Manager) recoveryUnitName() string {
	if m.UnitName != "" {
		return m.UnitName
	}
	return m.managerUnitName()
}

func RunWatchdog(
	ctx context.Context,
	binding WatchdogBinding,
	planPath string,
	runner Runner,
) error {
	if err := binding.validate(); err != nil {
		return err
	}
	active := binding.active
	if runner == nil {
		runner = CommandRunner{}
	}
	_, plan, err := readRecoveryActivationPlan(planPath)
	if err != nil {
		return err
	}
	if err := binding.validatePlan(planPath, plan); err != nil {
		return err
	}
	lastOwnedPlan := plan
	var lastRecoveryOwnership *recoveryTakeoverJournal
	activeStatus := plan.Status == "prepared" || plan.Status == "activated" || plan.Status == "acknowledged"
	if plan.Mode == "" && activeStatus {
		state, validationErr := validateOrdinaryWatchdogBinding(planPath, plan)
		if validationErr != nil {
			if ordinaryActivationStateAlreadyCommitted(plan) {
				_, committed, readErr := readRecoverySelfUpdateState(plan.StatePath)
				if readErr != nil || committed.Previous == nil || committed.Previous.Path != plan.PreviousPath ||
					!validSHA256(committed.Previous.SHA256) {
					return errors.Join(validationErr, errors.New("committed activation has no immutable watchdog executable owner"), readErr)
				}
				if err := binding.verifyCurrentProcess(ctx, plan, committed.Previous.Path, committed.Previous.SHA256); err != nil {
					return fmt.Errorf("verify committed ordinary watchdog executable: %w", err)
				}
				return commitActivation(active, planPath, plan)
			}
			return fmt.Errorf("validate ordinary Manager activation watchdog ownership: %w", validationErr)
		}
		if state.Current == nil || state.Current.Path != plan.PreviousPath || !validSHA256(state.Current.SHA256) {
			return errors.New("ordinary watchdog Current does not match its immutable previous executable")
		}
		if err := binding.verifyCurrentProcess(ctx, plan, state.Current.Path, state.Current.SHA256); err != nil {
			return fmt.Errorf("verify ordinary watchdog executable: %w", err)
		}
	} else if plan.Mode == recoveryActivationMode && activeStatus {
		ownership, err := readRecoveryTakeoverOwnership(active, plan)
		if err != nil {
			return fmt.Errorf("validate current recovery activation watchdog ownership: %w", err)
		}
		if err := binding.verifyCurrentProcess(ctx, plan, ownership.RecoveryPath, ownership.RecoverySHA256); err != nil {
			return fmt.Errorf("verify current recovery watchdog executable: %w", err)
		}
		lastRecoveryOwnership = &ownership
	} else {
		switch plan.Status {
		case "committed":
			return nil
		case ordinaryRolledBackStatus, recoverySupersededStatus:
			if plan.Error == "" {
				return fmt.Errorf("Manager activation reached terminal status %q", plan.Status)
			}
			return errors.New(plan.Error)
		default:
			return fmt.Errorf("unsupported Manager activation watchdog status %q", plan.Status)
		}
	}
	timeout := time.Duration(plan.HealthTimeoutMS) * time.Millisecond
	if timeout < time.Second {
		timeout = time.Second
	}
	deadline := time.Now().Add(timeout)
	consecutive := 0
	restartSubmitted := false
	restartAttempts := 0
	nextRestartAttempt := time.Time{}
	var lastRestartError error
	for time.Now().Before(deadline) {
		if err := atomicfile.ReadJSON(planPath, &plan); err != nil {
			readErr := fmt.Errorf("read Manager activation plan while watching candidate: %w", err)
			if lastOwnedPlan.Mode == "" {
				lastOwnedPlan.Error = readErr.Error()
				return restoreOrdinaryPreviousAfterPlanLoss(lastOwnedPlan, runner)
			}
			if lastOwnedPlan.Mode == recoveryActivationMode && lastRecoveryOwnership != nil {
				lastOwnedPlan.Error = readErr.Error()
				return restoreRecoveryPreviousAfterPlanLoss(active, lastOwnedPlan, runner, *lastRecoveryOwnership)
			}
			return readErr
		}
		switch plan.Status {
		case "committed":
			return nil
		case ordinaryRolledBackStatus:
			if plan.Error == "" {
				return fmt.Errorf("Manager activation reached terminal status %q", plan.Status)
			}
			return errors.New(plan.Error)
		case recoverySupersededStatus:
			return errors.New("activation ownership was superseded by controlled Current recovery")
		case "prepared", "activated", "acknowledged":
		default:
			return fmt.Errorf("unsupported Manager activation watchdog status %q", plan.Status)
		}
		if plan.Mode == "" {
			if err := validateOrdinaryActivationIdentity(lastOwnedPlan, plan); err != nil {
				return fmt.Errorf("ordinary Manager activation identity changed while watched: %w", err)
			}
			if _, err := validateOrdinaryWatchdogBinding(planPath, plan); err != nil {
				if ordinaryActivationStateAlreadyCommitted(plan) {
					return commitActivation(active, planPath, plan)
				}
				return fmt.Errorf("ordinary Manager activation ownership changed while watched: %w", err)
			}
			lastOwnedPlan = plan
		} else if plan.Mode == recoveryActivationMode {
			ownership, err := readRecoveryTakeoverOwnership(active, plan)
			if err != nil {
				return fmt.Errorf("current recovery activation ownership changed while watched: %w", err)
			}
			lastOwnedPlan = plan
			lastRecoveryOwnership = &ownership
		}
		if plan.Mode == "" && plan.Activated && !plan.Acknowledged && !restartSubmitted && !time.Now().Before(nextRestartAttempt) {
			restartAttempts++
			if err := runner.Run(ctx, "systemctl", "--user", "restart", "--no-block", plan.UnitName); err != nil {
				lastRestartError = err
				delay := time.Duration(1<<min(restartAttempts-1, 4)) * 250 * time.Millisecond
				nextRestartAttempt = time.Now().Add(delay)
			} else {
				restartSubmitted = true
				lastRestartError = nil
			}
		}
		if plan.Activated && plan.Acknowledged && managerHealthy(ctx, plan.SocketPath, plan.ControlTokenFile, plan.CandidateVersion, plan.CandidateSHA) && binaryMatches(plan.InstallPath, plan.CandidateSHA) {
			consecutive++
			if consecutive >= 3 {
				if err := commitActivation(active, planPath, plan); err != nil {
					return err
				}
				return nil
			}
		} else {
			consecutive = 0
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
	if lastRestartError != nil && !restartSubmitted {
		plan.Error = "could not submit candidate Manager restart from activation watchdog: " + lastRestartError.Error()
	} else {
		plan.Error = "candidate did not acknowledge a healthy startup before the watchdog deadline"
	}
	return restorePrevious(active, plan, runner)
}

func ordinaryActivationStateAlreadyCommitted(plan Plan) bool {
	var state State
	if atomicfile.ReadJSON(plan.StatePath, &state) != nil {
		return false
	}
	return state.Activation == nil && state.Candidate == nil && state.Current != nil &&
		state.Current.SourceCommit == plan.PlatformCommit && state.Current.Version == plan.CandidateVersion &&
		state.Current.Path == plan.CandidatePath && state.Current.SHA256 == plan.CandidateSHA &&
		binaryMatches(plan.InstallPath, plan.CandidateSHA)
}

func restoreRecoveryPreviousAfterPlanLoss(active identity.ActiveProfile, plan Plan, runner Runner, ownership recoveryTakeoverJournal) error {
	return withRecoveryTakeoverMutationLock(ownership.Path, func() error {
		latest, err := readRecoveryTakeoverOwnership(active, plan)
		if err != nil {
			return fmt.Errorf("activation plan became unreadable and recovery watchdog ownership could not be revalidated: %w", err)
		}
		if latest.TransactionID != ownership.TransactionID || latest.Path != ownership.Path ||
			!sameRecoveryTakeoverBinding(latest, ownership) {
			return errors.New("activation plan became unreadable after recovery watchdog ownership changed")
		}
		if recoveryPhaseBefore(latest.Phase, recoveryTakeoverWatchdogOwned) {
			return errors.New("activation plan became unreadable before the recovery watchdog owned rollback")
		}
		_, state, stateErr := readRecoverySelfUpdateState(plan.StatePath)
		if stateErr != nil {
			return stateErr
		}
		if recoveryCommittedStateMatches(state, latest) {
			return completeRecoveryActivationCommitFromVerifiedPlan(plan, latest)
		}
		if latest.Phase == recoveryTakeoverCommitted {
			return errors.New("committed current recovery journal does not match Manager state")
		}
		if latest.Phase == recoveryTakeoverRolledBack {
			// A terminal rolled-back journal is still the exact durable owner. Re-run
			// only the idempotent rollback checkpoint so a subsequently lost plan is
			// reconstructed; it cannot rotate Current/Previous or reactivate Candidate.
			return restoreRecoveryActivationPreviousFromVerifiedPlan(plan, runner, latest)
		}
		return restoreRecoveryActivationPreviousFromVerifiedPlan(plan, runner, latest)
	})
}

func validateOrdinaryWatchdogBinding(planPath string, plan Plan) (State, error) {
	if plan.Mode != "" || plan.SchemaVersion != 1 || plan.PlanPath != planPath || !filepath.IsAbs(planPath) || filepath.Clean(planPath) != planPath ||
		plan.StatePath == "" || !filepath.IsAbs(plan.StatePath) || plan.InstallPath == "" || !filepath.IsAbs(plan.InstallPath) ||
		plan.SocketPath == "" || plan.ControlTokenFile == "" || plan.UnitName == "" || plan.CandidateVersion == "" ||
		!validSHA256(plan.CandidateSHA) || plan.CandidatePath == "" || !filepath.IsAbs(plan.CandidatePath) ||
		!validSourceCommit(plan.PlatformCommit) || plan.PreviousPath == "" || !filepath.IsAbs(plan.PreviousPath) ||
		plan.CreatedAt.IsZero() || plan.UpdatedAt.IsZero() || plan.UpdatedAt.Before(plan.CreatedAt) ||
		plan.HealthTimeoutMS < 1_000 || plan.HealthTimeoutMS > 10*60*1_000 {
		return State{}, errors.New("ordinary Manager activation plan has incomplete watchdog identity")
	}
	switch plan.Status {
	case "prepared":
		if plan.Activated || plan.Acknowledged {
			return State{}, errors.New("prepared Manager activation has invalid flags")
		}
	case "activated":
		if !plan.Activated || plan.Acknowledged {
			return State{}, errors.New("activated Manager activation has invalid flags")
		}
	case "acknowledged":
		if !plan.Activated || !plan.Acknowledged {
			return State{}, errors.New("acknowledged Manager activation has invalid flags")
		}
	default:
		return State{}, fmt.Errorf("ordinary Manager activation status %q is not watchdog-owned", plan.Status)
	}
	var state State
	if err := atomicfile.ReadJSON(plan.StatePath, &state); err != nil {
		return State{}, fmt.Errorf("read Manager state for activation watchdog: %w", err)
	}
	if state.Current == nil || state.Candidate == nil || state.Activation == nil ||
		state.Current.Path != plan.PreviousPath || !validSHA256(state.Current.SHA256) ||
		state.Candidate.SourceCommit != plan.PlatformCommit || state.Candidate.Version != plan.CandidateVersion ||
		state.Candidate.Path != plan.CandidatePath || state.Candidate.SHA256 != plan.CandidateSHA || !state.Candidate.PlatformCommitted ||
		state.Activation.PlanPath != plan.PlanPath || state.Activation.CandidateSHA != plan.CandidateSHA ||
		state.Activation.CandidatePath != plan.CandidatePath || state.Activation.StartedAt.IsZero() ||
		!binaryMatches(state.Current.Path, state.Current.SHA256) || !binaryMatches(state.Candidate.Path, state.Candidate.SHA256) {
		return State{}, errors.New("ordinary Manager activation state is not owned by this watchdog")
	}
	stableSHA, err := fileSHA256(plan.InstallPath)
	if err != nil || stableSHA != state.Current.SHA256 && stableSHA != state.Candidate.SHA256 {
		return State{}, errors.New("stable Manager matches neither watchdog Current nor Candidate")
	}
	return state, nil
}

func restoreOrdinaryPreviousAfterPlanLoss(plan Plan, runner Runner) error {
	var shouldRestart bool
	var rollbackErr error
	if err := withOrdinaryActivationMutationLock(plan.PlanPath, func() error {
		if ordinaryActivationStateAlreadyCommitted(plan) {
			if plan.Mode != "" || plan.SchemaVersion != 1 || plan.PlanPath == "" ||
				(plan.Status != "acknowledged" && plan.Status != "committed") || !plan.Activated || !plan.Acknowledged {
				return errors.New("last verified ordinary plan is not an acknowledged commit checkpoint")
			}
			durablePlan := plan
			planData, _, readErr := readRecoveryRegularFile(plan.PlanPath, recoveryMaxJSONBytes, true)
			switch {
			case readErr == nil:
				var observed Plan
				if decodeErr := decodeRecoveryJSON(planData, &observed); decodeErr == nil {
					if err := validateOrdinaryActivationIdentity(plan, observed); err != nil {
						return fmt.Errorf("ordinary activation plan changed before commit reconstruction: %w", err)
					}
					if observed.SchemaVersion != 1 ||
						(observed.Status != "acknowledged" && observed.Status != "committed") ||
						!observed.Activated || !observed.Acknowledged {
						return errors.New("durable ordinary plan is not an acknowledged commit checkpoint")
					}
					durablePlan = observed
				}
			case !os.IsNotExist(readErr):
				return readErr
			}
			durablePlan.Status = "committed"
			durablePlan.UpdatedAt = time.Now().UTC()
			if err := persistActivationPlan(plan.PlanPath, durablePlan); err != nil {
				return fmt.Errorf("recreate committed Manager activation plan after plan loss: %w", err)
			}
			return nil
		}
		state, err := validateOrdinaryWatchdogBinding(plan.PlanPath, plan)
		if err != nil {
			return fmt.Errorf("activation plan became unreadable and watchdog ownership could not be revalidated: %w", err)
		}
		previous, err := os.ReadFile(plan.PreviousPath)
		if err != nil || sha256Hex(previous) != state.Current.SHA256 {
			return errors.New("activation plan became unreadable and the immutable Current binary is invalid")
		}
		if err := atomicfile.WriteFile(plan.InstallPath, previous, 0o755); err != nil {
			return fmt.Errorf("restore Current Manager after activation plan loss: %w", err)
		}
		shouldRestart = true
		plan.Error = journal.BoundDiagnostic(plan.Error)
		plan.Status = ordinaryRolledBackStatus
		plan.UpdatedAt = time.Now().UTC()
		if err := persistActivationPlan(plan.PlanPath, plan); err != nil {
			return fmt.Errorf("recreate terminal Manager activation plan after plan loss: %w", err)
		}
		if err := settleOrdinaryRollbackState(plan); err != nil {
			return fmt.Errorf("clear Manager candidate after activation plan loss: %w", err)
		}
		rollbackErr = errors.New(plan.Error)
		return nil
	}); err != nil {
		rollbackErr = err
	}
	if shouldRestart {
		if err := runner.Run(context.Background(), "systemctl", "--user", "restart", "--no-block", plan.UnitName); err != nil {
			return errors.Join(rollbackErr, fmt.Errorf("Current Manager restored after activation plan loss but restart failed: %w", err))
		}
	}
	return rollbackErr
}

func commitActivation(active identity.ActiveProfile, planPath string, plan Plan) error {
	if plan.Mode == recoveryActivationMode {
		journal, err := readRecoveryTakeoverOwnership(active, plan)
		if err != nil {
			return err
		}
		return withRecoveryTakeoverMutationLock(journal.Path, func() error {
			latest, readErr := readRecoveryTakeoverOwnership(active, plan)
			if readErr != nil {
				return readErr
			}
			if recoveryPhaseBefore(latest.Phase, recoveryTakeoverWatchdogOwned) || latest.Phase == recoveryTakeoverRolledBack {
				return errors.New("current recovery watchdog does not own activation commit")
			}
			return commitActivationWithOwnership(planPath, plan, &latest)
		})
	}
	return withOrdinaryActivationMutationLock(planPath, func() error {
		return commitActivationWithOwnership(planPath, plan, nil)
	})
}

func commitActivationWithOwnership(planPath string, plan Plan, ownership *recoveryTakeoverJournal) error {
	var durablePlan Plan
	if err := atomicfile.ReadJSON(planPath, &durablePlan); err != nil {
		return err
	}
	if durablePlan.Status == recoverySupersededStatus {
		return errors.New("activation plan was superseded before watchdog commit")
	}
	var state State
	if plan.Mode == recoveryActivationMode {
		if err := validateRecoveryPlanOwnership(durablePlan, *ownership); err != nil {
			return err
		}
		if err := atomicfile.ReadJSON(plan.StatePath, &state); err != nil {
			return err
		}
	} else {
		if err := validateOrdinaryActivationIdentity(plan, durablePlan); err != nil {
			return fmt.Errorf("revalidate ordinary activation identity before commit: %w", err)
		}
		switch durablePlan.Status {
		case "committed", "acknowledged":
		case ordinaryRolledBackStatus:
			return fmt.Errorf("ordinary activation reached terminal status %q before commit", durablePlan.Status)
		default:
			return fmt.Errorf("ordinary activation status %q is not ready for commit", durablePlan.Status)
		}
		if err := atomicfile.ReadJSON(plan.StatePath, &state); err != nil {
			return err
		}
		if state.Activation == nil && state.Candidate == nil && state.Current != nil &&
			state.Current.SourceCommit == durablePlan.PlatformCommit && state.Current.Version == durablePlan.CandidateVersion &&
			state.Current.Path == durablePlan.CandidatePath && state.Current.SHA256 == durablePlan.CandidateSHA &&
			binaryMatches(durablePlan.InstallPath, durablePlan.CandidateSHA) {
			// Crash replay after the atomic state promotion but before the terminal
			// ordinary plan write. Complete metadata only; never rotate Previous twice.
			durablePlan.Status = "committed"
			durablePlan.UpdatedAt = time.Now().UTC()
			return persistActivationPlan(planPath, durablePlan)
		}
		if durablePlan.Status == "committed" {
			return errors.New("committed ordinary activation does not match Manager Current")
		}
		validatedState, err := validateOrdinaryWatchdogBinding(planPath, durablePlan)
		if err != nil {
			return fmt.Errorf("revalidate ordinary activation ownership before commit: %w", err)
		}
		state = validatedState
		plan = durablePlan
	}
	if ownership != nil && recoveryCommittedStateMatches(state, *ownership) {
		// Crash replay after the atomic self-update state commit but before the
		// plan/journal terminal writes. Complete only the missing metadata; never
		// rotate Current/Previous a second time.
		durablePlan.Status = "committed"
		durablePlan.UpdatedAt = time.Now().UTC()
		if err := persistActivationPlan(planPath, durablePlan); err != nil {
			return err
		}
		return persistRecoveryTakeoverTerminalLocked(*ownership, recoveryTakeoverCommitted)
	}
	if state.Activation == nil || state.Candidate == nil || state.Candidate.SHA256 != plan.CandidateSHA {
		return errors.New("activation state changed before watchdog commit")
	}
	if ownership != nil && (!recoveryStateHasOriginalBase(state, *ownership) ||
		!recoveryCandidateMatches(state.Candidate, *ownership) || !recoveryActivationMatches(state.Activation, *ownership)) {
		return errors.New("current recovery activation state lost transaction ownership")
	}
	if ownership == nil && !binaryMatches(durablePlan.InstallPath, durablePlan.CandidateSHA) {
		return errors.New("stable Manager does not match Candidate immediately before ordinary activation commit")
	}
	state.Previous = state.Current
	state.Current = state.Candidate
	state.Candidate = nil
	state.Activation = nil
	state.UpdatedAt = time.Now().UTC()
	if err := atomicfile.WriteJSON(plan.StatePath, state, 0o600); err != nil {
		return err
	}
	durablePlan.Status = "committed"
	durablePlan.UpdatedAt = time.Now().UTC()
	if err := persistActivationPlan(planPath, durablePlan); err != nil {
		return err
	}
	if ownership != nil {
		return persistRecoveryTakeoverTerminalLocked(*ownership, recoveryTakeoverCommitted)
	}
	return nil
}

func restorePrevious(active identity.ActiveProfile, plan Plan, runner Runner) error {
	plan.Error = journal.BoundDiagnostic(plan.Error)
	if plan.Mode == recoveryActivationMode {
		ownership, err := readRecoveryTakeoverOwnership(active, plan)
		if err != nil {
			return err
		}
		return withRecoveryTakeoverMutationLock(ownership.Path, func() error {
			latest, readErr := readRecoveryTakeoverOwnership(active, plan)
			if readErr != nil {
				return readErr
			}
			if recoveryPhaseBefore(latest.Phase, recoveryTakeoverWatchdogOwned) || latest.Phase == recoveryTakeoverCommitted {
				return errors.New("current recovery watchdog does not own activation rollback")
			}
			return restoreRecoveryActivationPrevious(plan, runner, latest)
		})
	}
	var shouldRestart bool
	var rollbackErr error
	if err := withOrdinaryActivationMutationLock(plan.PlanPath, func() error {
		shouldRestart, rollbackErr = restoreOrdinaryPreviousLocked(plan)
		return nil
	}); err != nil {
		return err
	}
	if shouldRestart {
		if err := runner.Run(context.Background(), "systemctl", "--user", "restart", "--no-block", plan.UnitName); err != nil {
			return errors.Join(rollbackErr, fmt.Errorf("previous Manager restored but restart failed: %w", err))
		}
	}
	return rollbackErr
}

// restoreOrdinaryPreviousLocked performs only durable local mutations. The
// caller owns the plan flock and submits any required systemd restart after
// releasing it. The boolean reports whether stable was restored and a restart
// should be submitted even when a later checkpoint write failed.
func restoreOrdinaryPreviousLocked(plan Plan) (bool, error) {
	plan.Error = journal.BoundDiagnostic(plan.Error)
	rollbackError := plan.Error
	var durablePlan Plan
	if plan.PlanPath != "" {
		if err := atomicfile.ReadJSON(plan.PlanPath, &durablePlan); err != nil {
			return false, fmt.Errorf("revalidate activation ownership before rollback: %w", err)
		}
		if durablePlan.Status == recoverySupersededStatus {
			return false, errors.New("activation rollback was superseded by controlled Current recovery")
		}
		if err := validateOrdinaryActivationIdentity(plan, durablePlan); err != nil {
			return false, fmt.Errorf("revalidate activation identity before rollback: %w", err)
		}
		switch durablePlan.Status {
		case "committed":
			return false, nil
		case ordinaryRolledBackStatus:
			if durablePlan.Error == "" {
				return false, fmt.Errorf("Manager activation already reached terminal status %q", durablePlan.Status)
			}
			return false, errors.New(durablePlan.Error)
		case "prepared", "activated", "acknowledged":
		default:
			return false, fmt.Errorf("Manager activation rollback cannot claim status %q", durablePlan.Status)
		}
		plan = durablePlan
		plan.Error = rollbackError
		var state State
		if err := atomicfile.ReadJSON(plan.StatePath, &state); err != nil {
			return false, fmt.Errorf("revalidate Manager state before activation rollback: %w", err)
		}
		if state.Activation == nil && state.Candidate == nil && state.Current != nil &&
			state.Current.SourceCommit == plan.PlatformCommit && state.Current.Version == plan.CandidateVersion &&
			state.Current.Path == plan.CandidatePath && state.Current.SHA256 == plan.CandidateSHA &&
			binaryMatches(plan.InstallPath, plan.CandidateSHA) {
			// Another exact watchdog committed state in the narrow window before it
			// could persist the terminal plan. A stale watchdog has lost rollback
			// ownership and must not rotate Current/Previous back.
			return false, nil
		}
		if _, err := validateOrdinaryWatchdogBinding(plan.PlanPath, durablePlan); err != nil {
			return false, fmt.Errorf("revalidate ordinary watchdog ownership before rollback: %w", err)
		}
	}
	previous, readErr := os.ReadFile(plan.PreviousPath)
	if readErr != nil {
		return false, fmt.Errorf("read previous Manager for rollback: %w", readErr)
	}
	if err := atomicfile.WriteFile(plan.InstallPath, previous, 0o755); err != nil {
		return false, fmt.Errorf("restore previous Manager: %w", err)
	}
	if plan.Error == "" {
		plan.Error = "candidate Manager activation was rejected by its watchdog"
	}
	plan.Status = ordinaryRolledBackStatus
	plan.UpdatedAt = time.Now().UTC()
	if plan.PlanPath != "" {
		if err := persistActivationPlan(plan.PlanPath, plan); err != nil {
			return true, fmt.Errorf("persist terminal Manager rollback plan: %w", err)
		}
	}
	if err := settleOrdinaryRollbackState(plan); err != nil {
		return true, fmt.Errorf("clear rejected Manager candidate: %w", err)
	}
	return true, errors.New(plan.Error)
}

func validateOrdinaryActivationIdentity(expected, actual Plan) error {
	if actual.Mode != "" || expected.PlanPath == "" || actual.PlanPath != expected.PlanPath ||
		actual.StatePath != expected.StatePath || actual.InstallPath != expected.InstallPath ||
		actual.SocketPath != expected.SocketPath || actual.ControlTokenFile != expected.ControlTokenFile ||
		actual.UnitName != expected.UnitName || actual.CandidateVersion != expected.CandidateVersion ||
		actual.CandidateSHA != expected.CandidateSHA || actual.CandidatePath != expected.CandidatePath ||
		actual.PlatformCommit != expected.PlatformCommit || actual.PreviousPath != expected.PreviousPath {
		return errors.New("ordinary activation plan identity changed")
	}
	return nil
}

func settleOrdinaryRollbackState(plan Plan) error {
	if plan.Mode != "" || plan.Status != ordinaryRolledBackStatus || plan.PlanPath == "" ||
		plan.CandidateSHA == "" || plan.CandidatePath == "" || plan.PlatformCommit == "" {
		return errors.New("ordinary activation rollback evidence is incomplete")
	}
	var state State
	if err := atomicfile.ReadJSON(plan.StatePath, &state); err != nil {
		return err
	}
	if state.Activation != nil && (state.Activation.PlanPath != plan.PlanPath ||
		state.Activation.CandidateSHA != plan.CandidateSHA || state.Activation.CandidatePath != plan.CandidatePath) {
		return errors.New("ordinary activation ownership changed before rollback state commit")
	}
	if state.Candidate != nil && (state.Candidate.SourceCommit != plan.PlatformCommit ||
		state.Candidate.Version != plan.CandidateVersion || state.Candidate.SHA256 != plan.CandidateSHA ||
		state.Candidate.Path != plan.CandidatePath) {
		return errors.New("Manager candidate changed before rollback state commit")
	}
	if state.Activation == nil && state.Candidate == nil {
		return nil
	}
	state.Activation = nil
	state.Candidate = nil
	state.UpdatedAt = time.Now().UTC()
	return atomicfile.WriteJSON(plan.StatePath, state, 0o600)
}

func persistActivationPlan(path string, plan Plan) error {
	plan.Error = journal.BoundDiagnostic(plan.Error)
	return atomicfile.WriteJSON(path, plan, 0o600)
}

func (m *Manager) backupRunningVersion() (*Version, error) {
	source, err := m.installPath()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(source)
	if err != nil {
		return nil, fmt.Errorf("read running Manager: %w", err)
	}
	hash := sha256Hex(data)
	dir := filepath.Join(m.Root, "versions", "running-"+hash[:12])
	path := filepath.Join(dir, m.managerBinaryName())
	if err := atomicfile.WriteFile(path, data, 0o700); err != nil {
		return nil, err
	}
	version := &Version{Version: m.RunningVersion, Path: path, SHA256: hash, VerifiedAt: m.now(), PlatformCommitted: true}
	if err := m.ensureVersionMetadata(*version); err != nil {
		return nil, fmt.Errorf("record running Manager backup: %w", err)
	}
	return version, nil
}

func (m *Manager) installPath() (string, error) {
	if m.InstallPath != "" {
		return m.InstallPath, nil
	}
	return os.Executable()
}

func (m *Manager) State() (State, error) { return m.load() }

// PruneVersions removes only expired version directories carrying metadata
// whose path and binary hash have been revalidated. Referenced versions and
// activation rollback binaries are always protected; unknown directories are
// retained for diagnosis instead of being guessed to be temporary.
func (m *Manager) PruneVersions(ctx context.Context, now time.Time, retention time.Duration) (int, error) {
	if retention <= 0 {
		retention = 7 * 24 * time.Hour
	}
	releaseRecoveryLock, err := acquireRecoveryLock(m.Root)
	if err != nil {
		return 0, fmt.Errorf("coordinate Manager binary cleanup with recovery: %w", err)
	}
	defer releaseRecoveryLock()
	state, err := m.load()
	if err != nil {
		return 0, err
	}
	agedResidueErr := m.cleanupAgedAtomicResiduesLocked(now, retention, state)
	versionResidueErr := m.cleanupVersionAtomicResiduesLocked(now, state)
	if err := errors.Join(agedResidueErr, versionResidueErr); err != nil {
		return 0, fmt.Errorf("clean Manager atomic residues: %w", err)
	}
	protected := map[string]struct{}{}
	for _, item := range []*Version{state.Current, state.Previous, state.Candidate} {
		if item == nil || item.Path == "" {
			continue
		}
		path, pathErr := filepath.Abs(filepath.Clean(item.Path))
		if pathErr != nil {
			return 0, pathErr
		}
		protected[path] = struct{}{}
		if err := m.ensureVersionMetadata(*item); err != nil {
			return 0, err
		}
	}
	if state.Activation != nil {
		candidatePath, pathErr := filepath.Abs(filepath.Clean(state.Activation.CandidatePath))
		if pathErr != nil {
			return 0, pathErr
		}
		protected[candidatePath] = struct{}{}
		var plan Plan
		if err := atomicfile.ReadJSON(state.Activation.PlanPath, &plan); err != nil {
			return 0, fmt.Errorf("read active Manager activation during cleanup: %w", err)
		}
		if plan.PreviousPath != "" {
			previousPath, previousErr := filepath.Abs(filepath.Clean(plan.PreviousPath))
			if previousErr != nil {
				return 0, previousErr
			}
			protected[previousPath] = struct{}{}
		}
	}
	root, err := filepath.Abs(filepath.Join(m.Root, "versions"))
	if err != nil {
		return 0, err
	}
	entries, err := os.ReadDir(root)
	if os.IsNotExist(err) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, entry := range entries {
		select {
		case <-ctx.Done():
			return removed, ctx.Err()
		default:
		}
		if entry.Type()&os.ModeSymlink != 0 || !entry.IsDir() || safeID(entry.Name()) != entry.Name() {
			continue
		}
		dir := filepath.Join(root, entry.Name())
		binary := filepath.Join(dir, m.managerBinaryName())
		if _, keep := protected[binary]; keep {
			continue
		}
		var metadata Version
		if err := atomicfile.ReadJSON(filepath.Join(dir, "metadata.json"), &metadata); err != nil {
			continue
		}
		if !validVersionDirectoryIdentity(entry.Name(), metadata) || !filepath.IsAbs(metadata.Path) || filepath.Clean(metadata.Path) != binary || metadata.VerifiedAt.IsZero() || now.Sub(metadata.VerifiedAt) <= retention {
			continue
		}
		if err := validateVersionDirectoryContents(dir, m.managerBinaryName()); err != nil {
			continue
		}
		digest, err := fileSHA256(binary)
		if err != nil || digest != metadata.SHA256 || !validSHA256(metadata.SHA256) {
			continue
		}
		// Repeat the exact-content and checksum checks immediately before the
		// recursive removal. Unknown evidence appearing during maintenance is a
		// reason to retain the directory, never a reason to delete it.
		var latest Version
		if err := atomicfile.ReadJSON(filepath.Join(dir, "metadata.json"), &latest); err != nil || latest != metadata {
			continue
		}
		if err := validateVersionDirectoryContents(dir, m.managerBinaryName()); err != nil {
			continue
		}
		if latestDigest, err := fileSHA256(binary); err != nil || latestDigest != metadata.SHA256 {
			continue
		}
		if err := os.RemoveAll(dir); err != nil {
			return removed, err
		}
		removed++
	}
	if removed > 0 {
		directory, err := os.Open(root)
		if err != nil {
			return removed, err
		}
		err = directory.Sync()
		_ = directory.Close()
		if err != nil {
			return removed, fmt.Errorf("sync Manager version root after cleanup: %w", err)
		}
	}
	return removed, nil
}

func (m *Manager) ensureVersionMetadata(version Version) error {
	root, err := filepath.Abs(filepath.Join(m.Root, "versions"))
	if err != nil {
		return err
	}
	rootInfo, err := os.Lstat(root)
	if err != nil || !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return errors.New("Manager version root is not a regular directory")
	}
	path, err := filepath.Abs(filepath.Clean(version.Path))
	if err != nil {
		return err
	}
	if filepath.Dir(filepath.Dir(path)) != root || filepath.Base(path) != m.managerBinaryName() {
		return errors.New("referenced Manager version is outside the version root")
	}
	dir := filepath.Dir(path)
	dirInfo, err := os.Lstat(dir)
	if err != nil || !dirInfo.IsDir() || dirInfo.Mode()&os.ModeSymlink != 0 {
		return errors.New("referenced Manager version directory is not a regular directory")
	}
	if !validVersionDirectoryIdentity(filepath.Base(dir), version) || !validSHA256(version.SHA256) {
		return errors.New("referenced Manager version identity is invalid")
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("referenced Manager version is not a regular file")
	}
	digest, err := fileSHA256(path)
	if err != nil {
		return err
	}
	if digest != version.SHA256 {
		return errors.New("referenced Manager version checksum changed")
	}
	version.Path = path
	if version.VerifiedAt.IsZero() {
		version.VerifiedAt = m.now()
	}
	if err := atomicfile.WriteJSON(filepath.Join(dir, "metadata.json"), version, 0o600); err != nil {
		return err
	}
	return validateVersionDirectoryContents(dir, m.managerBinaryName())
}

func validateVersionDirectoryContents(dir, managerBinaryName string) error {
	contents, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	allowed := map[string]struct{}{managerBinaryName: {}, "metadata.json": {}}
	if len(contents) != len(allowed) {
		return errors.New("Manager version directory contains unknown files")
	}
	for _, content := range contents {
		if _, ok := allowed[content.Name()]; !ok {
			return fmt.Errorf("unknown file in Manager version directory: %s", content.Name())
		}
		info, err := os.Lstat(filepath.Join(dir, content.Name()))
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("Manager version content %s is not a regular file", content.Name())
		}
	}
	return nil
}

func validVersionDirectoryIdentity(name string, version Version) bool {
	if !validSHA256(version.SHA256) {
		return false
	}
	if name == "running-"+version.SHA256[:12] || name == "recovery-"+version.SHA256[:12] {
		return true
	}
	if !validSourceCommit(version.SourceCommit) {
		return false
	}
	return name == safeID(version.Version+"-"+version.SourceCommit[:12])
}

func (m *Manager) PendingActivation() (bool, error) {
	state, err := m.load()
	return err == nil && state.Activation != nil, err
}

// ActivationCommitted is the generation-finalization barrier. An activation
// intent, an acknowledged process, or a replaced stable path is insufficient:
// only the independent active-binary watchdog can promote Candidate to Current
// after repeated health checks.
func (m *Manager) ActivationCommitted(manifest release.Manifest) (bool, error) {
	state, err := m.load()
	if err != nil {
		return false, err
	}
	if state.Activation != nil || state.Candidate != nil || state.Current == nil || state.Current.SourceCommit != manifest.SourceCommit {
		return false, nil
	}
	if !validSourceCommit(manifest.SourceCommit) || manifest.Manager.Version == "" {
		return false, errors.New("release Manager identity is invalid at activation barrier")
	}
	artifact, ok := manifest.Manager.Artifacts[runtime.GOARCH]
	if !ok || !validSHA256(artifact.SHA256) {
		return false, errors.New("release Manager artifact identity is invalid at activation barrier")
	}
	planPath := filepath.Join(m.Root, "activations", safeID(manifest.SourceCommit)+".json")
	if _, err := os.Lstat(planPath); err != nil {
		if os.IsNotExist(err) {
			// A Manager already registered for this Platform generation without a
			// self-update plan remains the read-only fast path.
			return true, nil
		}
		return false, fmt.Errorf("inspect Manager activation plan at commit barrier: %w", err)
	}
	committed := false
	err = withOrdinaryActivationMutationLock(planPath, func() error {
		latest, loadErr := m.load()
		if loadErr != nil {
			return loadErr
		}
		if latest.Activation != nil || latest.Candidate != nil || latest.Current == nil || latest.Current.SourceCommit != manifest.SourceCommit {
			return nil
		}
		_, plan, readErr := readRecoveryActivationPlan(planPath)
		if readErr != nil {
			return fmt.Errorf("read Manager activation plan at commit barrier: %w", readErr)
		}
		installPath, pathErr := m.installPath()
		if pathErr != nil {
			return pathErr
		}
		unit := m.UnitName
		if unit == "" {
			unit = m.managerUnitName()
		}
		expectedCandidatePath := filepath.Join(m.Root, "versions", safeID(manifest.Manager.Version+"-"+manifest.SourceCommit[:12]), m.managerBinaryName())
		if plan.Mode != "" || plan.SchemaVersion != 1 || plan.PlanPath != planPath ||
			plan.StatePath != m.StatePath || plan.InstallPath != installPath || plan.SocketPath != m.SocketPath ||
			plan.ControlTokenFile != m.ControlTokenFile || plan.UnitName != unit ||
			plan.CandidateVersion != manifest.Manager.Version || plan.CandidateSHA != artifact.SHA256 ||
			plan.CandidatePath != expectedCandidatePath || plan.PlatformCommit != manifest.SourceCommit ||
			plan.CreatedAt.IsZero() || plan.UpdatedAt.IsZero() || plan.UpdatedAt.Before(plan.CreatedAt) ||
			plan.HealthTimeoutMS < 1_000 || plan.HealthTimeoutMS > 10*60*1_000 || plan.BootID == "" {
			return errors.New("Manager activation plan identity conflicts with the committed release")
		}
		if latest.Previous == nil || plan.PreviousPath != latest.Previous.Path ||
			latest.Current.Version != manifest.Manager.Version || latest.Current.Path != expectedCandidatePath ||
			latest.Current.SHA256 != artifact.SHA256 || !latest.Current.PlatformCommitted || latest.Current.VerifiedAt.IsZero() ||
			!binaryMatches(latest.Current.Path, latest.Current.SHA256) ||
			!binaryMatches(latest.Previous.Path, latest.Previous.SHA256) ||
			!binaryMatches(installPath, artifact.SHA256) {
			return errors.New("Manager Current/stable identity conflicts with the acknowledged activation plan")
		}
		if !plan.Activated || !plan.Acknowledged {
			return fmt.Errorf("Manager activation plan status %q lacks acknowledged commit flags", plan.Status)
		}
		switch plan.Status {
		case "committed":
			committed = true
			return nil
		case "acknowledged":
			plan.Status = "committed"
			plan.UpdatedAt = m.now()
			if err := persistActivationPlan(planPath, plan); err != nil {
				return fmt.Errorf("terminalize Manager activation at generation barrier: %w", err)
			}
			committed = true
			return nil
		default:
			return fmt.Errorf("Manager activation plan status %q conflicts with committed Current", plan.Status)
		}
	})
	return committed, err
}

// ActivationRolledBack is the durable negative activation barrier consumed by
// operation recovery. It reports true only when the exact release candidate was
// rejected, both candidate references were cleared atomically, and the stable
// executable is the still-registered previous Manager.
func (m *Manager) ActivationRolledBack(manifest release.Manifest) (bool, error) {
	if len(manifest.SourceCommit) < 12 {
		return false, errors.New("release source commit is invalid")
	}
	artifact, ok := manifest.Manager.Artifacts[runtime.GOARCH]
	if !ok {
		return false, errors.New("manager artifact is missing")
	}
	planPath := filepath.Join(m.Root, "activations", safeID(manifest.SourceCommit)+".json")
	activationsRoot := filepath.Dir(planPath)
	if _, err := os.Lstat(activationsRoot); err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, fmt.Errorf("inspect Manager activation directory before rollback query: %w", err)
	}
	if err := validateRecoveryDirectory(activationsRoot, true); err != nil {
		return false, fmt.Errorf("validate Manager activation directory before rollback query: %w", err)
	}
	if _, err := os.Lstat(planPath); err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, fmt.Errorf("inspect Manager activation plan before rollback query: %w", err)
	}
	if err := withOrdinaryActivationMutationLock(planPath, func() error {
		var plan Plan
		if err := atomicfile.ReadJSON(planPath, &plan); err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		expectedCandidatePath := filepath.Join(m.Root, "versions", safeID(manifest.Manager.Version+"-"+manifest.SourceCommit[:12]), m.managerBinaryName())
		if plan.Mode != "" || plan.PlanPath != planPath || plan.StatePath != m.StatePath ||
			plan.InstallPath != m.InstallPath || plan.CandidateVersion != manifest.Manager.Version ||
			!strings.EqualFold(plan.CandidateSHA, artifact.SHA256) || plan.CandidatePath != expectedCandidatePath ||
			plan.PlatformCommit != manifest.SourceCommit {
			return errors.New("Manager activation plan does not match the release candidate")
		}
		switch plan.Status {
		case "prepared", "committed", recoverySupersededStatus:
			return nil
		case "activated", "acknowledged":
			state, err := validateOrdinaryWatchdogBinding(planPath, plan)
			if err != nil {
				return fmt.Errorf("reconcile interrupted Manager rollback: %w", err)
			}
			if state.Current == nil || state.Current.SourceCommit == manifest.SourceCommit ||
				!binaryMatches(plan.InstallPath, state.Current.SHA256) {
				// Stable Candidate still represents a live activation, not a rollback.
				return nil
			}
			if plan.Error == "" {
				plan.Error = "candidate Manager activation was interrupted after Current restoration"
			}
			plan.Status = ordinaryRolledBackStatus
			plan.UpdatedAt = m.now()
			if err := persistActivationPlan(planPath, plan); err != nil {
				return fmt.Errorf("persist interrupted Manager rollback plan: %w", err)
			}
			return settleOrdinaryRollbackState(plan)
		case ordinaryRolledBackStatus:
			state, err := m.load()
			if err != nil {
				return err
			}
			if state.Candidate == nil && state.Activation == nil {
				return nil
			}
			if state.Current == nil || state.Candidate == nil || state.Activation == nil ||
				state.Current.SourceCommit == manifest.SourceCommit || state.Current.Path != plan.PreviousPath ||
				!binaryMatches(state.Current.Path, state.Current.SHA256) || !binaryMatches(m.InstallPath, state.Current.SHA256) ||
				!state.Candidate.PlatformCommitted || state.Candidate.SourceCommit != plan.PlatformCommit ||
				state.Candidate.Version != plan.CandidateVersion || state.Candidate.Path != plan.CandidatePath ||
				state.Candidate.SHA256 != plan.CandidateSHA ||
				state.Activation.PlanPath != plan.PlanPath || state.Activation.CandidatePath != plan.CandidatePath ||
				state.Activation.CandidateSHA != plan.CandidateSHA || state.Activation.StartedAt.IsZero() {
				return errors.New("rolled-back Manager activation half-commit does not match its exact state and stable binding")
			}
			return settleOrdinaryRollbackState(plan)
		default:
			return fmt.Errorf("unsupported Manager activation status %q", plan.Status)
		}
	}); err != nil {
		return false, err
	}
	rejected, err := m.activationRejected(manifest)
	if err != nil || !rejected {
		return false, err
	}
	state, err := m.load()
	if err != nil {
		return false, err
	}
	if state.Activation != nil || state.Candidate != nil {
		return false, nil
	}
	if state.Current == nil || state.Current.SourceCommit == manifest.SourceCommit ||
		!binaryMatches(state.Current.Path, state.Current.SHA256) || !binaryMatches(m.InstallPath, state.Current.SHA256) {
		return false, nil
	}
	return true, nil
}

func (m *Manager) activationRejected(manifest release.Manifest) (bool, error) {
	if len(manifest.SourceCommit) < 12 {
		return false, errors.New("release source commit is invalid")
	}
	artifact, ok := manifest.Manager.Artifacts[runtime.GOARCH]
	if !ok {
		return false, errors.New("manager artifact is missing")
	}
	planPath := filepath.Join(m.Root, "activations", safeID(manifest.SourceCommit)+".json")
	var plan Plan
	if err := atomicfile.ReadJSON(planPath, &plan); err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	if plan.Status != ordinaryRolledBackStatus {
		return false, nil
	}
	expectedCandidatePath := filepath.Join(m.Root, "versions", safeID(manifest.Manager.Version+"-"+manifest.SourceCommit[:12]), m.managerBinaryName())
	if plan.Mode != "" || plan.PlanPath != planPath || plan.StatePath != m.StatePath ||
		plan.InstallPath != m.InstallPath || plan.CandidateVersion != manifest.Manager.Version ||
		!strings.EqualFold(plan.CandidateSHA, artifact.SHA256) || plan.CandidatePath != expectedCandidatePath ||
		plan.PlatformCommit != manifest.SourceCommit {
		return false, errors.New("terminal Manager activation plan does not match the release candidate")
	}
	return true, nil
}

// AwaitStartupCommit keeps the candidate control socket alive while the
// independent watchdog performs its consecutive health checks. It also proves
// that this process, rather than a rolled-back predecessor, became Current.
func (m *Manager) AwaitStartupCommit(ctx context.Context) error {
	runningSHA, err := fileSHA256("/proc/self/exe")
	if err != nil {
		return err
	}
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		state, loadErr := m.load()
		if loadErr != nil {
			return loadErr
		}
		if state.Activation == nil {
			if state.Current != nil && state.Current.SHA256 == runningSHA {
				return nil
			}
			return errors.New("manager activation ended without promoting the running binary")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
func (m *Manager) load() (State, error) {
	var state State
	err := atomicfile.ReadJSON(m.StatePath, &state)
	if os.IsNotExist(err) {
		return State{SchemaVersion: 1}, nil
	}
	return state, err
}
func (m *Manager) runner() Runner {
	if m.Runner != nil {
		return m.Runner
	}
	return CommandRunner{}
}
func (m *Manager) now() time.Time {
	if m.Now != nil {
		return m.Now().UTC()
	}
	return time.Now().UTC()
}
func (m *Manager) bootID() string {
	if m.BootID != nil {
		return m.BootID()
	}
	data, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(string(data))
}

func managerHealthy(ctx context.Context, socketPath, tokenFile, expectedVersion, expectedSHA string) bool {
	return recoveryManagerIdentityMatches(ctx, socketPath, tokenFile, expectedVersion, expectedSHA)
}

func binaryMatches(path, expected string) bool {
	actual, err := fileSHA256(path)
	return err == nil && actual == expected
}
func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, io.LimitReader(f, 128<<20)); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
func sha256Hex(data []byte) string {
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}
func safeID(value string) string {
	var b strings.Builder
	for _, r := range value {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-' {
			b.WriteRune(r)
		} else {
			b.WriteByte('-')
		}
	}
	result := strings.Trim(b.String(), "-")
	if result == "" {
		return "unknown"
	}
	if len(result) > 120 {
		return result[:120]
	}
	return result
}
