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
	"runtime"
	"strings"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/atomicfile"
	"github.com/ubitech/agent-platform/manager/internal/journal"
	"github.com/ubitech/agent-platform/manager/internal/release"
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
	if len(manifest.SourceCommit) < 12 {
		return errors.New("release source commit is invalid")
	}
	id := safeID(manifest.Manager.Version + "-" + manifest.SourceCommit[:12])
	dir := filepath.Join(m.Root, "versions", id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	path := filepath.Join(dir, "ubitech-manager")
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
	if strings.TrimSpace(string(output)) == "" {
		return errors.New("staged manager returned an empty version")
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
	if state.Activation != nil && state.Candidate != nil && state.Candidate.SourceCommit == manifest.SourceCommit {
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
		unit = "ubitech-agent-manager.service"
	}
	planPath := filepath.Join(m.Root, "activations", safeID(manifest.SourceCommit)+".json")
	if m.ControlTokenFile == "" {
		return errors.New("manager control token file is required for safe activation")
	}
	plan := Plan{SchemaVersion: 1, PlanPath: planPath, Status: "prepared", StatePath: m.StatePath, InstallPath: installPath, SocketPath: m.SocketPath, ControlTokenFile: m.ControlTokenFile, UnitName: unit, CandidateVersion: state.Candidate.Version, CandidateSHA: state.Candidate.SHA256, PreviousPath: state.Current.Path, CreatedAt: m.now(), UpdatedAt: m.now(), HealthTimeoutMS: 45_000, BootID: m.bootID()}
	if err := persistActivationPlan(planPath, plan); err != nil {
		return err
	}
	watchdogUnit := "ubitech-agent-manager-watchdog-" + safeID(manifest.SourceCommit[:12])
	if err := m.runner().Run(ctx, "systemd-run", "--user", "--quiet", "--collect", "--unit", watchdogUnit, "--property=Type=exec", state.Current.Path, "self-update-watchdog", "--plan", planPath); err != nil {
		return fmt.Errorf("start manager activation watchdog: %w", err)
	}
	state.Activation = &Activation{PlanPath: planPath, CandidateSHA: state.Candidate.SHA256, CandidatePath: state.Candidate.Path, StartedAt: m.now()}
	state.UpdatedAt = m.now()
	if err := atomicfile.WriteJSON(m.StatePath, state, 0o600); err != nil {
		return err
	}
	candidate, err := os.ReadFile(state.Candidate.Path)
	if err != nil {
		return err
	}
	if sha256Hex(candidate) != state.Candidate.SHA256 {
		return errors.New("staged manager changed after verification")
	}
	if err := atomicfile.WriteFile(installPath, candidate, 0o755); err != nil {
		return err
	}
	plan.Activated = true
	plan.Status = "activated"
	plan.UpdatedAt = m.now()
	if err := persistActivationPlan(planPath, plan); err != nil {
		_ = restorePrevious(plan, m.runner())
		return err
	}
	if err := m.runner().Run(ctx, "systemctl", "--user", "restart", "--no-block", unit); err != nil {
		_ = restorePrevious(plan, m.runner())
		return fmt.Errorf("restart activated Manager: %w", err)
	}
	return nil
}

// AcknowledgeStartup is called only after the new process is listening on its
// owner-only control socket. Hashing /proc/self/exe prevents an old process
// from acknowledging a candidate merely because the stable path was replaced.
func (m *Manager) AcknowledgeStartup() error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	return m.acknowledgeExecutable(executable)
}

func (m *Manager) acknowledgeExecutable(executable string) error {
	state, err := m.load()
	if err != nil || state.Activation == nil {
		return err
	}
	hash, err := fileSHA256(executable)
	if err != nil {
		return err
	}
	var plan Plan
	if err := atomicfile.ReadJSON(state.Activation.PlanPath, &plan); err != nil {
		return err
	}
	if plan.CandidateSHA != state.Activation.CandidateSHA {
		return errors.New("manager activation plan does not match running binary")
	}
	if hash != state.Activation.CandidateSHA {
		if plan.Mode == recoveryActivationMode {
			return errors.New("current recovery activation can only be settled by its recovery watchdog")
		}
		// Crash before the stable binary replacement: the active Manager is still
		// authoritative, so abort the durable intent and leave the verified
		// candidate available for a later retry.
		if state.Current != nil && hash == state.Current.SHA256 && binaryMatches(plan.InstallPath, hash) {
			state.Activation = nil
			state.UpdatedAt = m.now()
			plan.Status = "aborted_before_replace"
			plan.Error = "activation stopped before stable binary replacement"
			plan.UpdatedAt = m.now()
			if err := atomicfile.WriteJSON(m.StatePath, state, 0o600); err != nil {
				return err
			}
			return persistActivationPlan(plan.PlanPath, plan)
		}
		plan.Error = "running Manager matches neither activation candidate nor previous binary"
		return restorePrevious(plan, m.runner())
	}
	if plan.Mode == recoveryActivationMode {
		if plan.InstallPath != m.InstallPath || plan.UnitName != m.recoveryUnitName() {
			return errors.New("current recovery activation does not match Manager service configuration")
		}
		return m.acknowledgeRecoveryExecutable(plan)
	}
	// Crash after atomic replacement but before plan.Activated was durable is a
	// safe roll-forward: the candidate itself proves the persisted intent by its
	// executable hash and completes the missing transition idempotently.
	plan.Activated = true
	plan.Acknowledged = true
	plan.Status = "acknowledged"
	plan.UpdatedAt = m.now()
	if err := persistActivationPlan(state.Activation.PlanPath, plan); err != nil {
		return err
	}
	if plan.BootID != m.bootID() {
		// Transient units do not survive a host reboot. Re-arm the watchdog from
		// the immutable previous binary before allowing the candidate to proceed.
		unit := "ubitech-agent-manager-watchdog-recovery-" + safeID(plan.CandidateSHA[:12])
		if err := m.runner().Run(context.Background(), "systemd-run", "--user", "--quiet", "--collect", "--unit", unit, "--property=Type=exec", plan.PreviousPath, "self-update-watchdog", "--plan", plan.PlanPath); err != nil {
			plan.Error = "could not re-arm Manager watchdog after reboot: " + err.Error()
			return restorePrevious(plan, m.runner())
		}
	}
	return nil
}

func (m *Manager) acknowledgeRecoveryExecutable(plan Plan) error {
	ownership, err := readRecoveryTakeoverOwnership(plan)
	if err != nil {
		return fmt.Errorf("validate current recovery activation ownership: %w", err)
	}
	return withRecoveryTakeoverMutationLock(ownership.Path, func() error {
		latestOwnership, readErr := readRecoveryTakeoverOwnership(plan)
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
	return "ubitech-agent-manager.service"
}

func RunWatchdog(ctx context.Context, planPath string, runner Runner) error {
	if runner == nil {
		runner = CommandRunner{}
	}
	var plan Plan
	if err := atomicfile.ReadJSON(planPath, &plan); err != nil {
		return err
	}
	timeout := time.Duration(plan.HealthTimeoutMS) * time.Millisecond
	if timeout < time.Second {
		timeout = time.Second
	}
	deadline := time.Now().Add(timeout)
	consecutive := 0
	for time.Now().Before(deadline) {
		if err := atomicfile.ReadJSON(planPath, &plan); err != nil {
			break
		}
		if plan.Status == recoverySupersededStatus {
			return errors.New("activation ownership was superseded by controlled Current recovery")
		}
		if plan.Activated && plan.Acknowledged && managerHealthy(ctx, plan.SocketPath, plan.ControlTokenFile, plan.CandidateVersion, plan.CandidateSHA) && binaryMatches(plan.InstallPath, plan.CandidateSHA) {
			consecutive++
			if consecutive >= 3 {
				if err := commitActivation(planPath, plan); err != nil {
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
	plan.Error = "candidate did not acknowledge a healthy startup before the watchdog deadline"
	return restorePrevious(plan, runner)
}

func commitActivation(planPath string, plan Plan) error {
	if plan.Mode == recoveryActivationMode {
		journal, err := readRecoveryTakeoverOwnership(plan)
		if err != nil {
			return err
		}
		return withRecoveryTakeoverMutationLock(journal.Path, func() error {
			latest, readErr := readRecoveryTakeoverOwnership(plan)
			if readErr != nil {
				return readErr
			}
			if recoveryPhaseBefore(latest.Phase, recoveryTakeoverWatchdogOwned) || latest.Phase == recoveryTakeoverRolledBack {
				return errors.New("current recovery watchdog does not own activation commit")
			}
			return commitActivationWithOwnership(planPath, plan, &latest)
		})
	}
	return commitActivationWithOwnership(planPath, plan, nil)
}

func commitActivationWithOwnership(planPath string, plan Plan, ownership *recoveryTakeoverJournal) error {
	var durablePlan Plan
	if err := atomicfile.ReadJSON(planPath, &durablePlan); err != nil {
		return err
	}
	if durablePlan.Status == recoverySupersededStatus {
		return errors.New("activation plan was superseded before watchdog commit")
	}
	if plan.Mode == recoveryActivationMode {
		if err := validateRecoveryPlanOwnership(durablePlan, *ownership); err != nil {
			return err
		}
	}
	var state State
	if err := atomicfile.ReadJSON(plan.StatePath, &state); err != nil {
		return err
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

func restorePrevious(plan Plan, runner Runner) error {
	plan.Error = journal.BoundDiagnostic(plan.Error)
	if plan.Mode == recoveryActivationMode {
		ownership, err := readRecoveryTakeoverOwnership(plan)
		if err != nil {
			return err
		}
		return withRecoveryTakeoverMutationLock(ownership.Path, func() error {
			latest, readErr := readRecoveryTakeoverOwnership(plan)
			if readErr != nil {
				return readErr
			}
			if recoveryPhaseBefore(latest.Phase, recoveryTakeoverWatchdogOwned) || latest.Phase == recoveryTakeoverCommitted {
				return errors.New("current recovery watchdog does not own activation rollback")
			}
			return restoreRecoveryActivationPrevious(plan, runner, latest)
		})
	}
	var durablePlan Plan
	if plan.PlanPath != "" {
		if err := atomicfile.ReadJSON(plan.PlanPath, &durablePlan); err != nil {
			return fmt.Errorf("revalidate activation ownership before rollback: %w", err)
		}
		if durablePlan.Status == recoverySupersededStatus {
			return errors.New("activation rollback was superseded by controlled Current recovery")
		}
	}
	previous, readErr := os.ReadFile(plan.PreviousPath)
	if readErr != nil {
		return fmt.Errorf("read previous Manager for rollback: %w", readErr)
	}
	if err := atomicfile.WriteFile(plan.InstallPath, previous, 0o755); err != nil {
		return fmt.Errorf("restore previous Manager: %w", err)
	}
	var state State
	if err := atomicfile.ReadJSON(plan.StatePath, &state); err == nil {
		state.Activation = nil
		state.UpdatedAt = time.Now().UTC()
		_ = atomicfile.WriteJSON(plan.StatePath, state, 0o600)
	}
	plan.Status = "rolled_back"
	plan.UpdatedAt = time.Now().UTC()
	if plan.PlanPath != "" {
		_ = persistActivationPlan(plan.PlanPath, plan)
	}
	if err := runner.Run(context.Background(), "systemctl", "--user", "restart", "--no-block", plan.UnitName); err != nil {
		return fmt.Errorf("previous Manager restored but restart failed: %w", err)
	}
	return errors.New(plan.Error)
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
	path := filepath.Join(dir, "ubitech-manager")
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
		binary := filepath.Join(dir, "ubitech-manager")
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
		if err := validateVersionDirectoryContents(dir); err != nil {
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
		if err := validateVersionDirectoryContents(dir); err != nil {
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
	if filepath.Dir(filepath.Dir(path)) != root || filepath.Base(path) != "ubitech-manager" {
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
	return validateVersionDirectoryContents(dir)
}

func validateVersionDirectoryContents(dir string) error {
	contents, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	allowed := map[string]struct{}{"ubitech-manager": {}, "metadata.json": {}}
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
	return state.Activation == nil && state.Current != nil && state.Current.SourceCommit == manifest.SourceCommit, nil
}

// AwaitStartupCommit keeps the candidate control socket alive while the
// independent watchdog performs its consecutive health checks. It also proves
// that this process, rather than a rolled-back predecessor, became Current.
func (m *Manager) AwaitStartupCommit(ctx context.Context) error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	runningSHA, err := fileSHA256(executable)
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
