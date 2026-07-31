package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"os/user"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/attestation"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/config"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/control"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/driver"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/executor"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/gateway"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffevidence"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handofffd"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffhost"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handofflisteners"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffowner"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffsource"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/journal"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/logstore"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/maintenance"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/operation"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/runtimegate"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/sandbox"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/selfupdate"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/snapshot"
)

var version = "development"

const managerDisplayName = "Agent Platform Manager"

type application struct {
	profile                    identity.ActiveProfile
	config                     config.Config
	configs                    *config.Manager
	state                      *journal.Store
	docker                     *driver.DockerCLI
	operations                 *operation.Orchestrator
	sandboxes                  *sandbox.Manager
	selfUpdate                 *selfupdate.Manager
	snapshots                  snapshot.Store
	processes                  *executor.ProcessManager
	audit                      *logstore.Store
	api                        *control.API
	fixedStackMu               sync.Locker
	maintenanceMu              *maintenance.Admission
	maintenanceWake            chan struct{}
	maintenanceJobs            maintenanceCleanup
	maintenanceActiveProcesses func() int
	handoffStore               *handoff.Store
	handoffOwner               *handoffowner.Coordinator
	startSourceHandoff         func(context.Context, handoff.Journal) error
	handoffAdmission           handoffMutationAdmission
	// publicState is set only by the restricted handoff participant. Ordinary
	// Managers use state directly. Keeping this as the narrow gateway
	// projection lets a participant serve adopted listeners without opening the
	// ordinary operation journal before the helper reaches a terminal phase.
	publicState gateway.StateProvider
}

type maintenanceCleanup interface {
	PruneSnapshots(context.Context, time.Time, map[string]struct{}, release.RemovalGuard) (int, error)
	PruneReleases(context.Context, time.Time, map[string]struct{}, map[string]struct{}, map[string]struct{}, release.RemovalGuard) (int, error)
	PruneTerminalOperations(context.Context, time.Time, release.RemovalGuard) (int, error)
	PruneManagerVersions(context.Context, time.Time, time.Duration) (int, error)
}

// handoffMutationAdmission is the outermost lease for every ordinary Manager
// mutation, including work started by background loops rather than an HTTP
// request. Keeping the application on this narrow interface also makes it
// possible to prove fail-closed behavior without weakening routedHandoffAdmission.
type handoffMutationAdmission interface {
	Acquire(context.Context) (release func(), err error)
}

func (a *application) withHandoffMutation(ctx context.Context, mutate func() error) error {
	if a == nil || a.handoffAdmission == nil {
		return errors.New("background handoff admission is unavailable")
	}
	releaseAdmission, err := a.handoffAdmission.Acquire(ctx)
	if err != nil {
		return err
	}
	if releaseAdmission == nil {
		return errors.New("background handoff admission returned a nil release function")
	}
	defer releaseAdmission()
	if err := ctx.Err(); err != nil {
		return err
	}
	return mutate()
}

type liveMaintenanceCleanup struct {
	config     config.Config
	operations *journal.Store
	snapshots  snapshot.Store
	selfUpdate *selfupdate.Manager
	images     maintenance.ImagePruner
}

func (c liveMaintenanceCleanup) PruneSnapshots(ctx context.Context, now time.Time, protected map[string]struct{}, guard release.RemovalGuard) (int, error) {
	snapshots := c.snapshots
	snapshots.RemovalGuard = guard
	return snapshots.Prune(ctx, now, protected)
}

func (c liveMaintenanceCleanup) PruneReleases(ctx context.Context, now time.Time, protectedIDs, protectedImages, heldImages map[string]struct{}, guard release.RemovalGuard) (int, error) {
	return maintenance.PruneReleases(ctx, now, maintenance.ReleasePolicy{
		Root:            filepath.Join(c.config.StateDir, "releases"),
		Channel:         c.config.ReleaseChannel,
		Retention:       time.Duration(contract.ObsoleteArtifactRetentionSeconds) * time.Second,
		ProtectedIDs:    protectedIDs,
		ProtectedImages: protectedImages,
		HeldImages:      heldImages,
		Images:          c.images,
		RemovalGuard:    guard,
	})
}

func (c liveMaintenanceCleanup) PruneTerminalOperations(ctx context.Context, now time.Time, guard release.RemovalGuard) (int, error) {
	if c.operations == nil {
		return 0, errors.New("operation journal cleanup store is unavailable")
	}
	return c.operations.PruneTerminalOperations(ctx, now, journal.TerminalOperationRemovalGuard(guard))
}

func (c liveMaintenanceCleanup) PruneManagerVersions(ctx context.Context, now time.Time, retention time.Duration) (int, error) {
	return c.selfUpdate.PruneVersions(ctx, now, retention)
}

type currentRecoveryPolicy struct {
	attemptTimeout time.Duration
	idlePoll       time.Duration
	initialDelay   time.Duration
	maxDelay       time.Duration
}

var defaultCurrentRecoveryPolicy = currentRecoveryPolicy{
	attemptTimeout: 2 * time.Minute,
	idlePoll:       time.Second,
	initialDelay:   5 * time.Second,
	maxDelay:       time.Minute,
}

func main() { code := run(os.Args[1:]); os.Exit(code) }
func run(arguments []string) int {
	if len(arguments) == 0 {
		usage()
		return 64
	}
	command := arguments[0]
	var err error
	switch command {
	case handoffhost.HelperSubcommand:
		err = executeHandoffHelper(arguments[1:])
	case "serve":
		err = serveCommand(arguments[1:])
	case "version", "--version", "-version":
		fmt.Println(version)
		return 0
	case "self-update-watchdog":
		parsed, parseErr := parseStartupArguments(command, arguments[1:])
		if parseErr != nil {
			err = parseErr
		} else if startup, routeErr := resolveInvocationAuthorityWithConfig(context.Background(), parsed.ConfigPath); routeErr != nil {
			err = fmt.Errorf("route watchdog technical identity: %w", routeErr)
		} else {
			routedArguments, bindErr := bindInvocationConfig(arguments[1:], startup)
			if bindErr != nil {
				err = bindErr
			} else if routedConfig, configErr := retainedInvocationConfig(context.Background(), startup, false); configErr != nil {
				err = configErr
			} else {
				err = selfUpdateWatchdogCommandWithConfig(
					startup.decision.ActiveProfile, routedConfig, startup.selectedStableBinary(), routedArguments,
					func() error { return startup.transferAuthority(context.Background()) },
				)
			}
			err = errors.Join(err, startup.closeAuthority())
		}
	case "recover-current":
		parsed, parseErr := parseStartupArguments(command, arguments[1:])
		if parseErr != nil {
			err = parseErr
		} else if startup, routeErr := resolveInvocationAuthorityWithConfig(context.Background(), parsed.ConfigPath); routeErr != nil {
			err = fmt.Errorf("route recovery technical identity: %w", routeErr)
		} else {
			routedArguments, bindErr := bindRequiredInvocationConfig(arguments[1:], startup)
			if bindErr != nil {
				err = bindErr
			} else if routedConfig, configErr := retainedInvocationConfig(context.Background(), startup, false); configErr != nil {
				err = configErr
			} else {
				err = recoverCurrentCommandWithConfig(
					startup.decision.ActiveProfile, routedConfig, startup.selectedStableBinary(), routedArguments,
					func() error { return startup.transferAuthority(context.Background()) },
				)
			}
			err = errors.Join(err, startup.closeAuthority())
		}
	case "preflight", "install", "status", "check", "update", "restart", "rollback", "repair", "logs", "release-transition":
		parsed, parseErr := parseStartupArguments(command, arguments[1:])
		if parseErr != nil {
			err = parseErr
			break
		}
		startup, routeErr := resolveInvocationStartupWithConfig(context.Background(), "", parsed.ConfigPath)
		if routeErr != nil {
			err = fmt.Errorf("route Manager command technical identity: %w", routeErr)
			break
		}
		routedArguments, bindErr := bindInvocationConfig(arguments[1:], startup)
		if bindErr != nil {
			err = bindErr
			break
		}
		routedConfig, configErr := retainedInvocationConfig(context.Background(), startup, true)
		if configErr != nil {
			err = configErr
			break
		}
		switch command {
		case "preflight":
			err = preflightCommandWithConfig(startup.decision.ActiveProfile, routedConfig, routedArguments)
		case "install":
			err = installCommandWithConfig(routedConfig, routedArguments)
		case "status":
			err = simpleGetCommandWithConfig(routedConfig, "status", routedArguments, "/v1/status")
		case "check":
			err = checkCommandWithConfig(routedConfig, routedArguments)
		case "update", "restart", "rollback", "repair":
			err = operationCommandWithConfig(routedConfig, command, routedArguments)
		case "logs":
			err = logsCommandWithConfig(routedConfig, routedArguments)
		case "release-transition":
			err = releaseTransitionCommandWithConfig(routedConfig, routedArguments)
		}
	default:
		usage()
		return 64
	}
	if err == nil {
		return 0
	}
	fmt.Fprintln(os.Stderr, err)
	return 1
}
func usage() {
	profile, _ := identity.SourceActiveProfile().Profile()
	fmt.Fprintln(os.Stderr, managerDisplayName)
	fmt.Fprintf(os.Stderr, "usage: %s <serve|preflight|install|status|check|update|restart|rollback|repair|recover-current|release-transition|logs|version> [options]\n", profile.ManagerBinary)
}

func commonFlags(name string) (*flag.FlagSet, *string) {
	set := flag.NewFlagSet(name, flag.ContinueOnError)
	path := set.String("config", "", "manager.toml path")
	return set, path
}
func load(path string) (config.Config, error) {
	return loadWithProfile(identity.SourceActiveProfile(), path)
}

func loadWithProfile(active identity.ActiveProfile, path string) (config.Config, error) {
	return config.Load(active, path)
}

func recoverCurrentCommandWithConfig(
	active identity.ActiveProfile,
	cfg config.Config,
	routedStable string,
	arguments []string,
	transferStartupAuthority func() error,
) error {
	path, expectedSHA, err := parseRecoverCurrentArguments(arguments)
	if err != nil {
		return err
	}
	if path != cfg.ConfigPath {
		return errors.New("recovery config argument differs from the routed technical identity")
	}
	// This reinspection preserves recover-current's stricter owner-only path
	// admission, but its bytes are never parsed or used as authority.  The
	// authenticated in-memory snapshot remains the only Config consumed below.
	if err := validateRecoveryConfigFile(path); err != nil {
		return err
	}
	if err := cfg.ValidateFor(active); err != nil {
		return err
	}
	return recoverCurrentWithConfig(active, cfg, routedStable, expectedSHA, transferStartupAuthority)
}

func parseRecoverCurrentArguments(arguments []string) (string, string, error) {
	set, path := commonFlags("recover-current")
	expectedSHA := set.String("expected-sha256", "", "expected SHA-256 of this recovery Manager executable")
	confirmed := set.Bool("yes", false, "confirm the controlled Manager replacement")
	if err := set.Parse(arguments); err != nil {
		return "", "", err
	}
	if !*confirmed {
		return "", "", errors.New("recover-current requires explicit --yes confirmation")
	}
	if *path == "" {
		return "", "", errors.New("recover-current requires an explicit --config path")
	}
	if *expectedSHA == "" {
		return "", "", errors.New("recover-current requires --expected-sha256")
	}
	if set.NArg() != 0 {
		return "", "", errors.New("recover-current accepts no positional arguments")
	}
	return *path, *expectedSHA, nil
}

func recoverCurrentWithConfig(
	active identity.ActiveProfile,
	cfg config.Config,
	routedStable string,
	expectedSHA string,
	transferStartupAuthority func() error,
) error {
	profile, err := active.Profile()
	if err != nil {
		return fmt.Errorf("validate recovery technical profile: %w", err)
	}
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve recovery Manager executable: %w", err)
	}
	if routedStable == "" || !filepath.IsAbs(routedStable) || filepath.Clean(routedStable) != routedStable ||
		filepath.Base(routedStable) != profile.ManagerBinary {
		return errors.New("routed stable Manager path is invalid during recovery")
	}
	selfUpdater := &selfupdate.Manager{
		Profile:          active,
		ConfigPath:       cfg.ConfigPath,
		Root:             filepath.Join(cfg.StateDir, "manager-binaries"),
		StatePath:        filepath.Join(cfg.StateDir, "manager-binaries.json"),
		InstallPath:      routedStable,
		SocketPath:       cfg.SocketPath,
		ControlTokenFile: cfg.ControlTokenFile(),
		UnitName:         profile.ManagerUnit,
		RunningVersion:   version,
	}
	timeout := cfg.HealthTimeout
	if timeout < 30*time.Second {
		timeout = 2 * time.Minute
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	if err := selfUpdater.RecoverCurrentWithAuthorityTransfer(
		ctx,
		filepath.Clean(executable),
		filepath.Join(cfg.StateDir, "state.json"),
		expectedSHA,
		transferStartupAuthority,
	); err != nil {
		return err
	}
	fmt.Println("current Manager recovery completed")
	return nil
}

func validateRecoveryConfigFile(path string) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return errors.New("recovery config path must be absolute and canonical")
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return fmt.Errorf("resolve recovery config: %w", err)
	}
	if resolved != path {
		return errors.New("recovery config path must not contain symbolic links")
	}
	parentInfo, err := os.Lstat(filepath.Dir(path))
	if err != nil {
		return fmt.Errorf("inspect recovery config directory: %w", err)
	}
	parentMetadata, parentOwned := parentInfo.Sys().(*syscall.Stat_t)
	if !parentInfo.IsDir() || parentInfo.Mode()&os.ModeSymlink != 0 || !parentOwned || parentMetadata.Uid != uint32(os.Getuid()) || parentInfo.Mode().Perm()&0o022 != 0 {
		return errors.New("recovery config directory must be an owner-owned non-symlink directory")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("inspect recovery config: %w", err)
	}
	metadata, ok := info.Sys().(*syscall.Stat_t)
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || !ok || metadata.Uid != uint32(os.Getuid()) {
		return errors.New("recovery config must be an owner-owned non-symlink regular file")
	}
	if info.Mode().Perm()&0o077 != 0 {
		return errors.New("recovery config must be owner-only")
	}
	return nil
}

// buildWithRuntimeConfig is the routed serve construction boundary.  The
// startup router supplies an authenticated in-memory Config and the exact
// stable binary path so application construction cannot reopen or recompute a
// technical identity after routing.
func buildWithRuntimeConfig(active identity.ActiveProfile, cfg config.Config, routedStable string, helperParticipant bool) (*application, error) {
	if err := cfg.ValidateFor(active); err != nil {
		return nil, fmt.Errorf("validate routed Manager configuration: %w", err)
	}
	profile, err := active.Profile()
	if err != nil {
		return nil, err
	}
	selfUpdater, err := routedSelfUpdateManager(active, cfg, routedStable)
	if err != nil {
		return nil, err
	}
	docker := newDockerDriver(active, cfg)
	if err := docker.EnsureHostLayout(); err != nil {
		return nil, err
	}
	var handoffStore *handoff.Store
	if !helperParticipant {
		if reflect.DeepEqual(profile, identity.SourceProfile()) {
			handoffStore, err = handoff.Open(cfg.HandoffRoot(), cfg.DataRoot, cfg.TargetDataRoot())
		} else {
			handoffStore, err = handoff.OpenExisting(cfg.HandoffRoot())
		}
		if err != nil {
			return nil, fmt.Errorf("open namespace handoff state: %w", err)
		}
	}
	handoffReturned := false
	defer func() {
		if handoffStore != nil && !handoffReturned {
			_ = handoffStore.Close()
		}
	}()
	controlTokenPath := cfg.ControlTokenFile()
	controlToken, err := driver.ReadOwnerSecret(controlTokenPath)
	if err != nil {
		return nil, err
	}
	executorTokenPath := filepath.Join(cfg.StateDir, "secrets", "manager-executor-token")
	executorToken, err := driver.ReadOwnerSecret(executorTokenPath)
	if err != nil {
		return nil, err
	}
	if controlToken == executorToken {
		return nil, errors.New("manager control and executor tokens must be distinct")
	}
	cfg.InternalToken = controlToken
	cfg.InternalTokenFile = controlTokenPath
	state, err := journal.Open(cfg.StateDir, time.Now())
	if err != nil {
		return nil, err
	}
	audit := logstore.New(filepath.Join(cfg.StateDir, "logs", "audit.jsonl"), cfg.LogMaxBytes, cfg.LogBackups)
	dataDir := cfg.PlatformDataDir()
	snapshots := snapshot.Store{DataDir: dataDir, BackupDir: filepath.Join(cfg.DataRoot, "backups"), Retention: time.Duration(contract.MigrationBackupRetentionSeconds) * time.Second, StagingRetention: time.Duration(contract.ObsoleteArtifactRetentionSeconds) * time.Second}
	selfUpdater.ControlTokenFile = controlTokenPath
	fixedStackMu := &sync.Mutex{}
	maintenanceMu := &maintenance.Admission{}
	executionGate := runtimegate.New()
	ops := &operation.Orchestrator{Store: state, Engine: docker, Gate: operation.HTTPGate{BaseURL: cfg.PlatformGateURL, Token: cfg.InternalToken}, Snapshots: snapshots, SelfUpdate: selfUpdater, TechnicalProfile: active, DataRoot: cfg.DataRoot, ReleasesDir: filepath.Join(cfg.StateDir, "releases"), ManifestURL: cfg.ReleaseURL, Channel: cfg.ReleaseChannel, Log: audit, PollInterval: cfg.UpdateInterval, FixedStackMu: fixedStackMu, MaintenanceMu: maintenanceMu}
	handoffAdmission := &routedHandoffAdmission{}
	if handoffStore != nil {
		if err := handoffAdmission.SetStore(handoffStore); err != nil {
			return nil, err
		}
	}
	ops.HandoffAdmission = handoffAdmission.Acquire
	selfUpdater.Client = ops.ReleaseClient
	image := cfg.SandboxImage
	if current := state.State().Current; current != nil && current.Images["agent-sandbox"] != "" {
		image = current.Images["agent-sandbox"]
	}
	sandboxes, err := sandbox.Open(active, docker, dataDir, filepath.Join(cfg.StateDir, "sandboxes.json"), image, cfg.SandboxNetwork, cfg.SandboxIdle)
	if err != nil {
		return nil, err
	}
	sandboxes.MaintenanceMu = maintenanceMu
	maintenanceWake := make(chan struct{}, 1)
	ops.OnCommit = func(manifest release.Manifest) { sandboxes.SetImage(manifest.Images["agent-sandbox"]) }
	ops.OnFinalized = func(release.Manifest) {
		select {
		case maintenanceWake <- struct{}{}:
		default:
		}
	}
	processes, err := executor.NewProcessManager(active, docker, sandboxes, cfg.CommandMaxBytes, handoffAdmission.Acquire)
	if err != nil {
		return nil, err
	}
	ops.LocalActiveProcesses = processes.ActiveBackgroundCount
	files, err := executor.NewFileService(active, sandboxes, 10<<20)
	if err != nil {
		return nil, err
	}
	execution := &executor.Service{Audits: executor.AuditStore{Dir: filepath.Join(cfg.StateDir, "control"), Log: audit}, Processes: processes, Files: files}
	configs := config.NewManager(cfg)
	runningSHA, err := runningExecutableSHA256()
	if err != nil {
		return nil, fmt.Errorf("identify running Manager executable: %w", err)
	}
	api := &control.API{Store: state, Operations: ops, Engine: docker, Executor: execution, Config: configs, AuditLog: audit, ControlToken: controlToken, ExecutorToken: executorToken, ManagerVersion: version, ManagerSHA256: runningSHA, ExecutorAdmission: handoffExecutionAdmission{handoff: handoffAdmission, runtime: executionGate}}
	app := &application{profile: active, config: cfg, configs: configs, state: state, docker: docker, operations: ops, sandboxes: sandboxes, selfUpdate: selfUpdater, snapshots: snapshots, processes: processes, audit: audit, api: api, fixedStackMu: fixedStackMu, maintenanceMu: maintenanceMu, maintenanceWake: maintenanceWake, maintenanceActiveProcesses: processes.ActiveBackgroundCount, handoffStore: handoffStore, handoffAdmission: handoffAdmission}
	if handoffStore != nil {
		platformEvidence := handoffevidence.PlatformClient{BaseURL: cfg.PlatformGateURL, Token: cfg.InternalToken}
		admission, admissionErr := handoffevidence.NewAdmission(handoffevidence.AdmissionOptions{
			Profile: active, Runtime: executionGate, Maintenance: maintenanceMu, Journal: state,
			SelfUpdate: selfUpdater, Units: handoffsource.SystemdCLI{}, Sandboxes: sandboxes,
			Background: processes.ActiveBackgroundCount, ChannelProbe: platformEvidence.Probe,
			ManagerSHA256: runningSHA, Architecture: runtime.GOARCH,
		})
		if admissionErr != nil {
			return nil, admissionErr
		}
		evidence, evidenceErr := handoffevidence.NewCollector(handoffevidence.CollectorOptions{
			Journal: state, SelfUpdate: selfUpdater, Runtime: executionGate, Sandboxes: sandboxes,
			Background: processes.ActiveBackgroundCount, Platform: platformEvidence,
			Docker: handoffevidence.DockerCLI{Binary: cfg.DockerBinary, Runner: driver.CommandRunner{MaxOutputBytes: 16 << 20}},
		})
		if evidenceErr != nil {
			return nil, evidenceErr
		}
		owner, ownerErr := configureHandoffOwnership(active, cfg, app, admission, evidence, runningSHA)
		if ownerErr != nil {
			return nil, ownerErr
		}
		app.handoffOwner = owner
		api.TransitionObserver = transitionObservationAdapter{owner: owner, managerSHA256: runningSHA}
		if reflect.DeepEqual(profile, identity.SourceProfile()) {
			ops.NamespaceHandoffCheck = func(ctx context.Context, manifest release.Manifest, path, digest string) error {
				journal, beginErr := owner.Begin(ctx, handoffowner.BridgeRequest{Manifest: manifest, ManifestPath: path, ManifestSHA256: digest})
				if beginErr != nil {
					return beginErr
				}
				if app.startSourceHandoff == nil {
					return errors.New("source listener handoff boundary is unavailable")
				}
				return app.startSourceHandoff(ctx, journal)
			}
		}
	}
	app.maintenanceJobs = liveMaintenanceCleanup{config: cfg, operations: state, snapshots: snapshots, selfUpdate: selfUpdater, images: docker}
	// Sandbox Ensure is reached only from the executor HTTP boundary, which
	// retains handoff -> runtime for the complete call. Re-entering routed
	// handoff admission here would recursively flock the global journal; enter
	// only the admitted maintenance core and preserve global -> runtime ->
	// maintenance ordering.
	sandboxes.ReclaimCapacity = func(ctx context.Context) error {
		return app.reconcileMaintenanceWithProtectionAdmitted(ctx, "", nil)
	}
	ops.ReclaimCapacity = func(ctx context.Context, operationID string, manifest release.Manifest) error {
		return app.reconcileMaintenanceWithProtection(ctx, operationID, &manifest)
	}
	handoffReturned = true
	return app, nil
}

// routedSelfUpdateManager is the single serve-time construction boundary for
// self-update ownership. routedStable comes from the startup Router; this
// function deliberately does not consult HOME, XDG_BIN_HOME, or profile
// defaults after that decision has been made.
func routedSelfUpdateManager(active identity.ActiveProfile, cfg config.Config, routedStable string) (*selfupdate.Manager, error) {
	if err := cfg.ValidateFor(active); err != nil {
		return nil, fmt.Errorf("validate routed self-update configuration: %w", err)
	}
	profile, err := active.Profile()
	if err != nil {
		return nil, err
	}
	if routedStable == "" || !filepath.IsAbs(routedStable) || filepath.Clean(routedStable) != routedStable ||
		filepath.Base(routedStable) != profile.ManagerBinary {
		return nil, errors.New("routed stable Manager path differs from the technical profile")
	}
	manager := &selfupdate.Manager{
		Profile: active, ConfigPath: cfg.ConfigPath,
		Root: filepath.Join(cfg.StateDir, "manager-binaries"), StatePath: filepath.Join(cfg.StateDir, "manager-binaries.json"),
		InstallPath: routedStable, SocketPath: cfg.SocketPath, ControlTokenFile: cfg.ControlTokenFile(),
		UnitName: profile.ManagerUnit, RunningVersion: version,
	}
	if err := manager.ValidateTechnicalProfile(); err != nil {
		return nil, err
	}
	return manager, nil
}

func newDockerDriver(active identity.ActiveProfile, cfg config.Config) *driver.DockerCLI {
	return &driver.DockerCLI{
		Profile: active, Binary: cfg.DockerBinary, ComposeFile: cfg.ComposeFile,
		ComposeProject: cfg.ComposeProject, GenerationDir: filepath.Join(cfg.StateDir, "releases"),
		DataRoot: cfg.DataRoot, StateDir: cfg.StateDir, ControlDir: filepath.Dir(cfg.SocketPath), GatewayAddress: cfg.GatewayAddress,
		PlatformBind: "127.0.0.1:18080", CoreNetwork: cfg.SandboxNetwork,
		LogMaxSize: dockerLogSize(cfg.LogMaxBytes), LogMaxFiles: cfg.LogBackups,
		UID: os.Getuid(), GID: os.Getgid(), Runner: driver.CommandRunner{MaxOutputBytes: cfg.CommandMaxBytes},
		ManagedImageMu: &sync.Mutex{},
	}
}

func preflightCommand(arguments []string) error {
	return preflightCommandWithProfile(identity.SourceActiveProfile(), arguments)
}

func preflightCommandWithProfile(active identity.ActiveProfile, arguments []string) error {
	set, path := commonFlags("preflight")
	probeTransientUnit := set.Bool("probe-user-systemd-transient", false, "verify user-systemd transient watchdog support")
	if err := set.Parse(arguments); err != nil {
		return err
	}
	cfg, err := loadWithProfile(active, *path)
	if err != nil {
		return err
	}
	return runPreflightWithConfig(active, cfg, *probeTransientUnit)
}

func preflightCommandWithConfig(active identity.ActiveProfile, cfg config.Config, arguments []string) error {
	set, path := commonFlags("preflight")
	probeTransientUnit := set.Bool("probe-user-systemd-transient", false, "verify user-systemd transient watchdog support")
	if err := set.Parse(arguments); err != nil {
		return err
	}
	if set.NArg() != 0 {
		return errors.New("preflight accepts no positional arguments")
	}
	if *path != cfg.ConfigPath {
		return errors.New("preflight config argument differs from the routed technical identity")
	}
	return runPreflightWithConfig(active, cfg, *probeTransientUnit)
}

func runPreflightWithConfig(active identity.ActiveProfile, cfg config.Config, probeTransientUnit bool) error {
	if err := cfg.ValidateFor(active); err != nil {
		return fmt.Errorf("validate routed Manager configuration for preflight: %w", err)
	}
	profile, err := active.Profile()
	if err != nil {
		return err
	}
	var store *handoff.Store
	if reflect.DeepEqual(profile, identity.SourceProfile()) {
		store, err = handoff.Open(cfg.HandoffRoot(), cfg.DataRoot, cfg.TargetDataRoot())
	} else {
		store, err = handoff.OpenExisting(cfg.HandoffRoot())
	}
	if err != nil {
		return fmt.Errorf("open namespace handoff admission for preflight: %w", err)
	}
	defer store.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	return preflightUnderHandoffAdmission(ctx, store, func() error {
		docker := newDockerDriver(active, cfg)
		selfUpdater := &selfupdate.Manager{
			Profile: active, ConfigPath: cfg.ConfigPath,
			Root: filepath.Join(cfg.StateDir, "manager-binaries"), StatePath: filepath.Join(cfg.StateDir, "manager-binaries.json"),
			InstallPath: managerInstallPath(active), SocketPath: cfg.SocketPath, ControlTokenFile: cfg.ControlTokenFile(),
			UnitName: profile.ManagerUnit, RunningVersion: version,
		}
		if probeTransientUnit {
			if err := selfUpdater.ProbeTransientUnit(ctx); err != nil {
				return err
			}
		}
		if err := docker.Preflight(ctx); err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Join(cfg.StateDir, "releases"), 0o700); err != nil {
			return err
		}
		fmt.Println("preflight ok")
		return nil
	})
}

func serveCommand(arguments []string) error {
	parsed, err := parseStartupArguments("serve", arguments)
	if err != nil {
		return err
	}
	transactionDirectory := os.Getenv(handoffTransactionEnvironment)
	if err := os.Unsetenv(handoffTransactionEnvironment); err != nil {
		return fmt.Errorf("clear namespace handoff startup locator: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	startup, err := resolveInvocationStartupWithConfig(ctx, transactionDirectory, parsed.ConfigPath)
	if err != nil {
		return fmt.Errorf("route Manager startup identity: %w", err)
	}
	return serveCommandWithRuntime(arguments, startup, buildWithRuntimeConfig)
}

func serveCommandWithRuntime(arguments []string, startup invocationStartup, builder func(identity.ActiveProfile, config.Config, string, bool) (*application, error)) error {
	configPath, err := selectedInvocationConfig(startup)
	if err != nil {
		return err
	}
	if startup.participant() {
		return serveHandoffParticipant(arguments, startup, builder)
	}
	if !startup.configBound || startup.configuration.ConfigPath != configPath {
		return errors.New("startup router did not retain its authenticated Manager configuration")
	}
	return serveCommandWithResolvedConfig(arguments, startup, false, builder)
}

func serveCommandWithResolvedConfig(arguments []string, routed invocationStartup, helperParticipant bool, builder func(identity.ActiveProfile, config.Config, string, bool) (*application, error)) error {
	set, path := commonFlags("serve")
	if err := set.Parse(arguments); err != nil {
		return err
	}
	if set.NArg() != 0 {
		return errors.New("serve accepts no positional arguments")
	}
	resolvedConfig, err := selectedInvocationConfig(routed)
	if err != nil {
		return err
	}
	if *path != "" && filepath.Clean(*path) != resolvedConfig {
		return errors.New("Manager config argument differs from the routed technical identity")
	}
	*path = resolvedConfig
	active := routed.activeProfile()
	routedStable := routed.selectedStableBinary()
	revalidationContext, cancelRevalidation := context.WithTimeout(context.Background(), 35*time.Second)
	startup, err := acquireServeStartupOwnershipWithConfigAndRevalidation(active, routed.configuration, routedStable, func() error {
		return verifyRoutedStartupDecision(revalidationContext, routed, true)
	})
	cancelRevalidation()
	if err != nil {
		return fmt.Errorf("validate Manager startup ownership before construction: %w", err)
	}
	defer startup.release()
	if startup.lease.ExternalRecoveryProbe() {
		startup.lease, err = serveExternalRecoveryProbe(startup)
		if err != nil {
			return fmt.Errorf("serve fenced external recovery identity: %w", err)
		}
	}
	app, err := builder(active, routed.configuration, routedStable, helperParticipant)
	if err != nil {
		return err
	}
	if app.handoffStore != nil {
		defer app.handoffStore.Close()
	}
	startup.lease, err = ensureServeStartupOwnership(app.selfUpdate, startup.lease)
	if err != nil {
		return fmt.Errorf("validate Manager startup ownership after construction: %w", err)
	}
	pendingActivation, err := app.selfUpdate.PendingActivation()
	if err != nil {
		return err
	}
	// A recovery watchdog may settle between the ownership snapshot and the
	// pending read. Revalidation makes that transition part of the gate rather
	// than allowing a rolled-back candidate to enter normal background work.
	startup.lease, err = ensureServeStartupOwnership(app.selfUpdate, startup.lease)
	if err != nil {
		return fmt.Errorf("revalidate Manager startup ownership after pending activation read: %w", err)
	}
	if !pendingActivation {
		if err := app.sandboxes.CommitRegistryUpgrade(); err != nil {
			return fmt.Errorf("commit Sandbox registry startup upgrade: %w", err)
		}
	}
	listener, err := control.Listen(app.config.SocketPath)
	if err != nil {
		return err
	}
	defer func() { _ = listener.Close() }()
	gatewayControl := newGatewayController(app)
	app.api.OwnershipProof = control.OwnershipProofProviderFunc(gatewayControl.ProveListenerOwnership)
	var sourceTransfer *sourceListenerHandoff
	if app.handoffOwner != nil && startupParticipantProfile(app.profile) == handofflisteners.OwnerSource && !helperParticipant {
		recoveryCtx, recoveryCancel := context.WithTimeout(context.Background(), 30*time.Second)
		_, recoveryErr := app.handoffOwner.RecoverStartup(recoveryCtx)
		recoveryCancel()
		if recoveryErr != nil {
			return fmt.Errorf("recover namespace handoff ownership: %w", recoveryErr)
		}
		sourceTransfer, err = newSourceListenerHandoff(gatewayControl, app.configs)
		if err != nil {
			return err
		}
		defer sourceTransfer.Close()
		app.startSourceHandoff = sourceTransfer.Start
	}
	app.configs.SetLANApply(gatewayControl.ApplyLANConfig)
	app.operations.PublicProbe = gatewayControl.Health
	controlHandler := newServeControlHandler(app.api, pendingActivation)
	server := &http.Server{Handler: controlHandler, ReadHeaderTimeout: 15 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 32 << 10}
	serveErrors := make(chan error, 1)
	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErrors <- err
		}
	}()
	go gatewayControl.Run()
	defer gatewayControl.Stop()
	if pendingActivation {
		// Validate and converge every durable operation state that does not depend
		// on watchdog promotion before acknowledging the candidate binary.  A bad
		// journal or unhealthy committed Platform must leave the old watchdog able
		// to restore the previous Manager.
		recoveryCtx, recoveryCancel := context.WithTimeout(context.Background(), 15*time.Second)
		err = app.operations.RecoverBeforeActivation(recoveryCtx)
		recoveryCancel()
		if err != nil {
			return fmt.Errorf("validate operation recovery before Manager acknowledgement: %w", err)
		}
		healthCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		err = gatewayControl.Health(healthCtx)
		cancel()
		if err != nil {
			return fmt.Errorf("activate public gateway before Manager acknowledgement: %w", err)
		}
		if err := app.selfUpdate.AcknowledgeStartup(); err != nil {
			return fmt.Errorf("acknowledge Manager self-update: %w", err)
		}
		watchdogCtx, watchdogCancel := context.WithTimeout(context.Background(), 45*time.Second)
		err = app.selfUpdate.AwaitStartupCommit(watchdogCtx)
		watchdogCancel()
		if err != nil {
			return fmt.Errorf("wait for Manager watchdog commit: %w", err)
		}
		if err := app.sandboxes.CommitRegistryUpgrade(); err != nil {
			return fmt.Errorf("commit Sandbox registry after Manager activation: %w", err)
		}
		controlHandler.promote(app.api)
	}
	// A free-lock startup retains exclusion until its control identity is live
	// and any pending candidate is durably promoted. A busy-lock startup is
	// already protected by the external recover-current process probing it.
	startup.lease.Release()
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	// Once the watchdog has promoted this binary to Current, a child-service or
	// finalize failure can no longer be repaired by repeatedly killing the same
	// Manager. Keep the owner-only control API and public maintenance gateway
	// online while durable recovery retries in the background. Candidate startup
	// above remains strict so the watchdog can still reject an unsafe binary.
	initialRecoveryFailures := initialCurrentRecovery(
		ctx,
		defaultCurrentRecoveryPolicy,
		app.recoverCurrent,
	)
	go runCurrentRecoveryLoop(
		ctx,
		initialRecoveryFailures,
		defaultCurrentRecoveryPolicy,
		app.operations.RecoveryPending,
		app.recoverCurrent,
	)
	go app.background(ctx)
	select {
	case <-ctx.Done():
		if !app.processes.ShutdownHost() {
			return errors.New("one or more host process groups could not be terminated during Manager shutdown")
		}
		shutdown, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		return server.Shutdown(shutdown)
	case err := <-serveErrors:
		return err
	}
}

type serveStartupAdmission struct {
	config     config.Config
	manager    *selfupdate.Manager
	serveLease *selfupdate.ServeLease
	lease      *selfupdate.StartupOwnershipLease
}

func (s *serveStartupAdmission) release() {
	if s == nil {
		return
	}
	s.lease.Release()
	s.serveLease.Release()
}

func acquireServeStartupOwnershipWithConfig(active identity.ActiveProfile, cfg config.Config, routedStable string) (*serveStartupAdmission, error) {
	return acquireServeStartupOwnershipWithConfigAndRevalidation(active, cfg, routedStable, nil)
}

func acquireServeStartupOwnershipWithConfigAndRevalidation(active identity.ActiveProfile, cfg config.Config, routedStable string, revalidate func() error) (*serveStartupAdmission, error) {
	manager, err := routedSelfUpdateManager(active, cfg, routedStable)
	if err != nil {
		return nil, err
	}
	serveLease, err := manager.AcquireServeLock()
	if err != nil {
		return nil, err
	}
	releaseServe := true
	defer func() {
		if releaseServe {
			serveLease.Release()
		}
	}()
	if revalidate != nil {
		if err := revalidate(); err != nil {
			return nil, fmt.Errorf("revalidate routed identity after acquiring serve singleton: %w", err)
		}
	}
	// Keep the requested public guard in the pre-construction path, then close
	// its point-in-time race by acquiring and retaining a freshly revalidated
	// lease for the rest of serve startup.
	if err := manager.ValidateStartupOwnership(); err != nil {
		return nil, err
	}
	lease, err := manager.AcquireStartupOwnership()
	if err != nil {
		return nil, err
	}
	releaseServe = false
	return &serveStartupAdmission{config: cfg, manager: manager, serveLease: serveLease, lease: lease}, nil
}

func ensureServeStartupOwnership(manager *selfupdate.Manager, lease *selfupdate.StartupOwnershipLease) (*selfupdate.StartupOwnershipLease, error) {
	if lease != nil && lease.RetainsRecoveryLock() {
		if err := manager.ValidateStartupOwnershipWithLease(lease); err != nil {
			return lease, err
		}
		return lease, nil
	}
	next, err := manager.AcquireStartupOwnership()
	if err != nil {
		return lease, err
	}
	if next.ExternalRecoveryProbe() {
		return next, errors.New("external recovery began after full Manager construction")
	}
	return next, nil
}

func serveExternalRecoveryProbe(startup *serveStartupAdmission) (*selfupdate.StartupOwnershipLease, error) {
	token, err := driver.ReadOwnerSecret(startup.config.ControlTokenFile())
	if err != nil {
		return nil, fmt.Errorf("read Manager control capability for recovery identity: %w", err)
	}
	runningSHA, err := runningExecutableSHA256()
	if err != nil {
		return nil, fmt.Errorf("identify recovery Manager executable: %w", err)
	}
	listener, err := control.Listen(startup.config.SocketPath)
	if err != nil {
		return nil, err
	}
	defer func() { _ = listener.Close() }()
	api := &control.API{
		ControlToken: token, ManagerVersion: version, ManagerSHA256: runningSHA, IdentityOnly: true,
	}
	server := &http.Server{Handler: api, ReadHeaderTimeout: 15 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8 << 10}
	serveErrors := make(chan error, 1)
	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErrors <- err
		}
	}()
	defer server.Close()

	waitContext, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	type ownershipResult struct {
		lease *selfupdate.StartupOwnershipLease
		err   error
	}
	results := make(chan ownershipResult, 1)
	go func() {
		lease, waitErr := startup.manager.AwaitExternalRecoveryOwnership(waitContext, 50*time.Millisecond)
		results <- ownershipResult{lease: lease, err: waitErr}
	}()
	select {
	case result := <-results:
		return result.lease, result.err
	case serveErr := <-serveErrors:
		stop()
		result := <-results
		result.lease.Release()
		return nil, serveErr
	case <-waitContext.Done():
		result := <-results
		result.lease.Release()
		return nil, waitContext.Err()
	}
}

func managerInstallPath(active identity.ActiveProfile) string {
	profile, err := active.Profile()
	if err != nil {
		return ""
	}
	if root := os.Getenv("XDG_BIN_HOME"); root != "" {
		if !filepath.IsAbs(root) || filepath.Clean(root) != root {
			return ""
		}
		return profile.ManagerInstallPath(root)
	}
	account, err := user.Current()
	if err != nil || account.Uid != strconv.Itoa(os.Getuid()) || !filepath.IsAbs(account.HomeDir) || filepath.Clean(account.HomeDir) != account.HomeDir {
		return ""
	}
	return profile.ManagerInstallPath(filepath.Join(account.HomeDir, ".local", "bin"))
}

func selfUpdateWatchdogCommandWithConfig(
	active identity.ActiveProfile,
	cfg config.Config,
	routedStable string,
	arguments []string,
	transferStartupAuthority func() error,
) error {
	set := flag.NewFlagSet("self-update-watchdog", flag.ContinueOnError)
	configPath := set.String("config", "", "manager.toml path (startup binding only)")
	plan := set.String("plan", "", "activation plan")
	if err := set.Parse(arguments); err != nil {
		return err
	}
	if set.NArg() != 0 || *plan == "" {
		return errors.New("activation plan is required")
	}
	if *configPath != cfg.ConfigPath {
		return errors.New("watchdog config argument differs from the routed technical identity")
	}
	profile, err := active.Profile()
	if err != nil {
		return err
	}
	manager := &selfupdate.Manager{
		Profile: active, ConfigPath: cfg.ConfigPath,
		Root: filepath.Join(cfg.StateDir, "manager-binaries"), StatePath: filepath.Join(cfg.StateDir, "manager-binaries.json"),
		InstallPath: routedStable, SocketPath: cfg.SocketPath, ControlTokenFile: cfg.ControlTokenFile(),
		UnitName: profile.ManagerUnit, RunningVersion: version,
	}
	binding, err := manager.WatchdogBinding()
	if err != nil {
		return err
	}
	return selfupdate.RunWatchdog(context.Background(), binding, *plan, nil, transferStartupAuthority)
}

func runCurrentRecoveryAttempt(ctx context.Context, timeout time.Duration, recover func(context.Context) error) error {
	attemptCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	return recover(attemptCtx)
}

// recoverCurrent keeps recovery failures visible without turning a current
// Manager into a systemd crash loop. Candidate startup deliberately does not
// use this wrapper: before watchdog promotion, recovery remains a strict gate.
func (a *application) recoverCurrent(ctx context.Context) error {
	err := a.operations.Recover(ctx)
	if err == nil {
		return nil
	}
	a.recordCurrentRecoveryFailure(err)
	return err
}

func (a *application) recordCurrentRecoveryFailure(recoveryErr error) {
	if recoveryErr == nil || a.state == nil {
		return
	}
	// Recover releases its operation admission before returning. Reacquire the
	// global observation for the diagnostic publication so a handoff which won
	// that gap cannot be followed by a LastError or audit write.
	_ = a.withHandoffMutation(context.Background(), func() error {
		a.recordCurrentRecoveryFailureAdmitted(recoveryErr)
		return nil
	})
}

func (a *application) recordCurrentRecoveryFailureAdmitted(recoveryErr error) {
	diagnostic := journal.BoundDiagnostic(recoveryErr.Error())
	state := a.state.State()
	operationID := state.FinalizePendingOperationID
	if operationID == "" {
		operationID = state.ActiveOperationID
	}
	persistErr := error(nil)
	if state.LastError != diagnostic {
		_, persistErr = a.state.MutateState(time.Now().UTC(), func(value *model.ManagerState) error {
			// Preserve the durable recovery intent exactly. This write exists only
			// to expose a direct recovery error that the orchestrator could not
			// persist itself.
			value.LastError = diagnostic
			return nil
		})
	}
	if a.audit == nil {
		return
	}
	auditErr := recoveryErr
	if persistErr != nil {
		auditErr = errors.Join(recoveryErr, fmt.Errorf("persist recovery diagnostic: %w", persistErr))
	}
	generationID := ""
	if state.Current != nil {
		generationID = state.Current.ID
	}
	_ = a.audit.Append(logstore.Event{
		At:          time.Now().UTC(),
		Type:        "manager.recovery_failed",
		OperationID: operationID,
		Details:     map[string]any{"generation": generationID},
		Error:       journal.BoundDiagnostic(auditErr.Error()),
	})
}

// initialCurrentRecovery deliberately returns a retry count rather than an
// error. At this point the binary is already Current: recovery errors must keep
// the Manager serving its control API instead of propagating to serveCommand.
func initialCurrentRecovery(ctx context.Context, policy currentRecoveryPolicy, recover func(context.Context) error) int {
	if err := runCurrentRecoveryAttempt(ctx, policy.attemptTimeout, recover); err != nil {
		return 1
	}
	return 0
}

func currentRecoveryRetryDelay(failures int, policy currentRecoveryPolicy) time.Duration {
	if failures <= 0 {
		return policy.idlePoll
	}
	delay := policy.initialDelay
	for attempt := 1; attempt < failures && delay < policy.maxDelay; attempt++ {
		if delay > policy.maxDelay/2 {
			return policy.maxDelay
		}
		delay *= 2
	}
	if delay > policy.maxDelay {
		return policy.maxDelay
	}
	return delay
}

func runCurrentRecoveryLoop(
	ctx context.Context,
	initialFailures int,
	policy currentRecoveryPolicy,
	pending func() bool,
	recover func(context.Context) error,
) {
	failures := initialFailures
	timer := time.NewTimer(currentRecoveryRetryDelay(failures, policy))
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			nextDelay := policy.idlePoll
			if pending() {
				if err := runCurrentRecoveryAttempt(ctx, policy.attemptTimeout, recover); err != nil {
					failures++
					nextDelay = currentRecoveryRetryDelay(failures, policy)
				} else {
					failures = 0
				}
			} else {
				failures = 0
			}
			timer.Reset(nextDelay)
		}
	}
}

func (a *application) background(ctx context.Context) {
	sandboxTicker := time.NewTicker(time.Minute)
	updateTicker := time.NewTicker(time.Second)
	lastUpdateCheck := time.Now()
	defer sandboxTicker.Stop()
	defer updateTicker.Stop()
	go runReconciliationLoop(ctx, 2*time.Second, capabilityRetryDelay, a.reconcileCapabilities)
	go runReconciliationLoop(ctx, 5*time.Second, firecrawlRetryDelay, a.reconcileFirecrawl)
	go runTriggeredReconciliationLoop(ctx, 3*time.Minute, maintenanceRetryDelay, a.maintenanceWake, a.reconcileMaintenance)
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-sandboxTicker.C:
			// Admission rejection is deliberately silent: appending a failure audit
			// would itself cross the namespace handoff write boundary.
			_ = a.reconcileSandboxes(ctx, now)
		case now := <-updateTicker.C:
			if a.operations.RecoveryPending() {
				continue
			}
			interval := a.configs.Config().UpdateInterval
			if autoUpdateDue(lastUpdateCheck, now, interval) {
				lastUpdateCheck = now
				a.autoUpdate(ctx)
			}
		}
	}
}

func (a *application) reconcileSandboxes(ctx context.Context, now time.Time) error {
	return a.withHandoffMutation(ctx, func() error {
		if a.state == nil || a.sandboxes == nil {
			return errors.New("Sandbox reconciliation dependencies are unavailable")
		}
		if current := a.state.State().Current; current != nil && current.Images["agent-sandbox"] != "" {
			a.sandboxes.SetImage(current.Images["agent-sandbox"])
		}
		_, reapErr := a.sandboxes.Reap(ctx, now)
		refreshed, refreshErr := a.sandboxes.ReconcileImages(ctx, now)
		err := errors.Join(reapErr, refreshErr)
		if err != nil && a.audit != nil {
			_ = a.audit.Append(logstore.Event{At: now.UTC(), Type: "sandbox.reconcile_failed", Details: map[string]any{"images_refreshed": len(refreshed)}, Error: journal.BoundDiagnostic(err.Error())})
		}
		return err
	})
}

func runReconciliationLoop(
	ctx context.Context,
	initialDelay time.Duration,
	retryDelay func(int) time.Duration,
	reconcile func(context.Context) error,
) {
	timer := time.NewTimer(initialDelay)
	defer timer.Stop()
	failures := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			if err := reconcile(ctx); err != nil {
				failures++
			} else {
				failures = 0
			}
			timer.Reset(retryDelay(failures))
		}
	}
}

func runTriggeredReconciliationLoop(
	ctx context.Context,
	initialDelay time.Duration,
	retryDelay func(int) time.Duration,
	trigger <-chan struct{},
	reconcile func(context.Context) error,
) {
	timer := time.NewTimer(initialDelay)
	defer timer.Stop()
	failures := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		case <-trigger:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
		}
		if err := reconcile(ctx); err != nil {
			failures++
		} else {
			failures = 0
		}
		timer.Reset(retryDelay(failures))
	}
}

func firecrawlManifest(state model.ManagerState) (release.Manifest, bool) {
	if state.Current == nil || state.FinalizePendingOperationID != "" || state.Maintenance {
		return release.Manifest{}, false
	}
	images := make(map[string]string, len(state.Current.Images))
	for name, image := range state.Current.Images {
		images[name] = image
	}
	return release.Manifest{SourceCommit: state.Current.ID, Images: images}, true
}

const reconciliationStatePollInterval = 100 * time.Millisecond

// reconciliationContext lets current-generation capability repair continue
// throughout validation, image pulling and task waiting, but promptly cancels
// it once a durable maintenance reservation begins. That cancellation releases
// the fixed-stack mutex before the updater waits to enter its cutover section.
func (a *application) reconciliationContext(parent context.Context, generation string, timeout time.Duration) (context.Context, func()) {
	ctx, cancel := context.WithTimeout(parent, timeout)
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		ticker := time.NewTicker(reconciliationStatePollInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				state := a.state.State()
				if state.Current == nil || state.Current.ID != generation || state.FinalizePendingOperationID != "" || state.Maintenance {
					cancel()
					return
				}
			}
		}
	}()
	return ctx, func() {
		cancel()
		<-stopped
	}
}

func (a *application) reconcileFirecrawl(ctx context.Context) error {
	return a.withHandoffMutation(ctx, func() error {
		return a.reconcileFirecrawlAdmitted(ctx)
	})
}

// reconcileFirecrawlAdmitted runs beneath an already-retained handoff lease.
// Capacity recovery must use the admitted maintenance core to avoid taking the
// deployment-wide lock in reverse or recursively.
func (a *application) reconcileFirecrawlAdmitted(ctx context.Context) error {
	err := a.reconcileFirecrawlAttempt(ctx)
	if driver.IsInsufficientCapacity(err) {
		if reclaimErr := a.reconcileMaintenanceWithProtectionAdmitted(ctx, "", nil); reclaimErr != nil {
			err = errors.Join(err, fmt.Errorf("reclaim capacity before Firecrawl retry: %w", reclaimErr))
		} else {
			err = a.reconcileFirecrawlAttempt(ctx)
		}
	}
	if err != nil && a.audit != nil {
		state := a.state.State()
		generation := ""
		if state.Current != nil {
			generation = state.Current.ID
		}
		_ = a.audit.Append(logstore.Event{
			At:      time.Now().UTC(),
			Type:    "firecrawl.reconcile_failed",
			Details: map[string]any{"generation": generation},
			Error:   journal.BoundDiagnostic(err.Error()),
		})
	}
	return err
}

func (a *application) reconcileFirecrawlAttempt(ctx context.Context) error {
	if a.fixedStackMu != nil {
		a.fixedStackMu.Lock()
		defer a.fixedStackMu.Unlock()
	}
	manifest, ready := firecrawlManifest(a.state.State())
	if !ready {
		return nil
	}
	reconcileCtx, finish := a.reconciliationContext(ctx, manifest.ID(), 25*time.Minute)
	defer finish()
	err := a.docker.ReconcileFirecrawl(reconcileCtx, manifest)
	if errors.Is(reconcileCtx.Err(), context.Canceled) {
		return nil
	}
	return err
}

func (a *application) reconcileCapabilities(ctx context.Context) error {
	return a.withHandoffMutation(ctx, func() error {
		return a.reconcileCapabilitiesAdmitted(ctx)
	})
}

func (a *application) reconcileCapabilitiesAdmitted(ctx context.Context) error {
	err := a.reconcileCapabilitiesAttempt(ctx)
	if driver.IsInsufficientCapacity(err) {
		if reclaimErr := a.reconcileMaintenanceWithProtectionAdmitted(ctx, "", nil); reclaimErr != nil {
			err = errors.Join(err, fmt.Errorf("reclaim capacity before capability retry: %w", reclaimErr))
		} else {
			err = a.reconcileCapabilitiesAttempt(ctx)
		}
	}
	if err != nil && a.audit != nil {
		state := a.state.State()
		generation := ""
		if state.Current != nil {
			generation = state.Current.ID
		}
		_ = a.audit.Append(logstore.Event{
			At:      time.Now().UTC(),
			Type:    "capability.reconcile_failed",
			Details: map[string]any{"generation": generation},
			Error:   journal.BoundDiagnostic(err.Error()),
		})
	}
	return err
}

func (a *application) reconcileCapabilitiesAttempt(ctx context.Context) error {
	if a.fixedStackMu != nil {
		a.fixedStackMu.Lock()
		defer a.fixedStackMu.Unlock()
	}
	manifest, ready := firecrawlManifest(a.state.State())
	if !ready {
		return nil
	}
	reconcileCtx, finish := a.reconciliationContext(ctx, manifest.ID(), 2*time.Minute)
	defer finish()
	err := a.docker.ReconcileCapabilities(reconcileCtx, manifest)
	if errors.Is(reconcileCtx.Err(), context.Canceled) {
		return nil
	}
	return err
}

func capabilityRetryDelay(failures int) time.Duration {
	if failures <= 0 {
		return time.Minute
	}
	delay := 15 * time.Second
	for attempt := 1; attempt < failures && delay < 10*time.Minute; attempt++ {
		delay *= 2
	}
	if delay > 10*time.Minute {
		return 10 * time.Minute
	}
	return delay
}

func firecrawlRetryDelay(failures int) time.Duration {
	if failures <= 0 {
		return time.Minute
	}
	delay := time.Minute
	for attempt := 1; attempt < failures && delay < 30*time.Minute; attempt++ {
		delay *= 2
	}
	if delay > 30*time.Minute {
		return 30 * time.Minute
	}
	return delay
}

func maintenanceRetryDelay(failures int) time.Duration {
	if failures <= 0 {
		return 30 * time.Minute
	}
	delay := 15 * time.Minute
	for attempt := 1; attempt < failures && delay < 6*time.Hour; attempt++ {
		delay *= 2
	}
	if delay > 6*time.Hour {
		return 6 * time.Hour
	}
	return delay
}

// reconcileMaintenance runs only at an idle, fully-finalized generation
// boundary. Every removable path is revalidated by its owning subsystem; an
// unknown directory or image is retained rather than guessed to be obsolete.
func (a *application) reconcileMaintenance(ctx context.Context) error {
	return a.reconcileMaintenanceWithProtection(ctx, "", nil)
}

func (a *application) reconcileMaintenanceForOperation(ctx context.Context, allowedOperationID string) error {
	return a.reconcileMaintenanceWithProtection(ctx, allowedOperationID, nil)
}

func (a *application) reconcileMaintenanceWithProtection(ctx context.Context, allowedOperationID string, additional *release.Manifest) error {
	return a.withHandoffMutation(ctx, func() error {
		return a.reconcileMaintenanceWithProtectionAdmitted(ctx, allowedOperationID, additional)
	})
}

// reconcileMaintenanceWithProtectionAdmitted assumes the handoff observation
// is the outermost retained lease. It is used only by mutation paths which
// already proved that fact, such as executor-owned Sandbox capacity recovery
// and capability reconciliation.
func (a *application) reconcileMaintenanceWithProtectionAdmitted(ctx context.Context, allowedOperationID string, additional *release.Manifest) error {
	if a.maintenanceMu == nil {
		return errors.New("maintenance admission is unavailable")
	}
	if a.state == nil || a.sandboxes == nil || a.selfUpdate == nil {
		return errors.New("maintenance state dependencies are unavailable")
	}
	jobs := a.maintenanceJobs
	if jobs == nil {
		jobs = liveMaintenanceCleanup{config: a.config, operations: a.state, snapshots: a.snapshots, selfUpdate: a.selfUpdate, images: a.docker}
	}
	a.maintenanceMu.Lock()
	state := a.state.State()
	if !maintenanceStateEligible(state, allowedOperationID) {
		a.maintenanceMu.Unlock()
		return nil
	}
	unfinished, err := a.state.UnfinishedOperations()
	if err != nil {
		a.maintenanceMu.Unlock()
		return fmt.Errorf("inspect unfinished operations before maintenance: %w", err)
	}
	operationReferences, operationsEligible := maintenanceOperationReferences(unfinished, allowedOperationID)
	if !operationsEligible {
		a.maintenanceMu.Unlock()
		return nil
	}
	if a.activeMaintenanceProcesses() > 0 {
		a.maintenanceMu.Unlock()
		return nil
	}
	selfState, err := a.selfUpdate.State()
	if err != nil {
		a.maintenanceMu.Unlock()
		return fmt.Errorf("inspect Manager self-update state before maintenance: %w", err)
	}
	if selfState.Activation != nil {
		a.maintenanceMu.Unlock()
		return nil
	}
	protectedSnapshots := map[string]struct{}{}
	protectedIDs := map[string]struct{}{}
	protectedImages := map[string]struct{}{}
	for _, operation := range operationReferences {
		if operation.TargetGeneration != "" {
			protectedIDs[operation.TargetGeneration] = struct{}{}
		}
		if operation.SnapshotPath != "" {
			protectedSnapshots[operation.SnapshotPath] = struct{}{}
		}
	}
	for _, generation := range []*model.Generation{state.Current, state.Previous, state.Candidate} {
		if generation == nil {
			continue
		}
		if generation.ID != "" {
			protectedIDs[generation.ID] = struct{}{}
		}
		if generation.RollbackSnapshotPath != "" {
			protectedSnapshots[generation.RollbackSnapshotPath] = struct{}{}
		}
		for name, image := range generation.Images {
			if release.IsManagedImageName(name) && release.IsDigestReference(image) {
				protectedImages[image] = struct{}{}
			}
		}
	}
	if additional != nil {
		if additional.ID() != "" {
			protectedIDs[additional.ID()] = struct{}{}
		}
		for name, image := range additional.Images {
			if release.IsManagedImageName(name) && release.IsDigestReference(image) {
				protectedImages[image] = struct{}{}
			}
		}
	}
	heldImages := map[string]struct{}{}
	for _, record := range a.sandboxes.Records() {
		if record.ActiveCalls > 0 || record.BackgroundProcesses > 0 {
			a.maintenanceMu.Unlock()
			return nil
		}
		if release.IsDigestReference(record.Image) {
			heldImages[record.Image] = struct{}{}
		}
	}
	for _, version := range []*selfupdate.Version{selfState.Current, selfState.Previous, selfState.Candidate} {
		if version != nil && len(version.SourceCommit) == 40 {
			protectedIDs[version.SourceCommit] = struct{}{}
		}
	}
	planGeneration := state.Generation
	expectedEpoch := a.maintenanceMu.Epoch() + 1
	a.maintenanceMu.Unlock()
	aborted := false
	removalGuard := release.RemovalGuard(func() (func(), bool) {
		if aborted {
			return func() {}, false
		}
		a.maintenanceMu.Lock()
		current := a.state.State()
		valid := a.maintenanceMu.Epoch() == expectedEpoch && current.Generation == planGeneration && maintenanceStateEligible(current, allowedOperationID) && a.activeMaintenanceProcesses() == 0
		if valid {
			currentOperations, operationErr := a.state.UnfinishedOperations()
			currentReferences, currentEligible := maintenanceOperationReferences(currentOperations, allowedOperationID)
			valid = operationErr == nil && currentEligible && sameMaintenanceOperationReferences(operationReferences, currentReferences)
		}
		if valid {
			currentSelfState, selfStateErr := a.selfUpdate.State()
			valid = selfStateErr == nil && currentSelfState.Activation == nil && sameMaintenanceSelfUpdateState(selfState, currentSelfState)
		}
		if !valid {
			aborted = true
			nextEpoch := a.maintenanceMu.Epoch() + 1
			a.maintenanceMu.Unlock()
			expectedEpoch = nextEpoch
			return func() {}, false
		}
		for _, record := range a.sandboxes.Records() {
			if record.ActiveCalls > 0 || record.BackgroundProcesses > 0 {
				aborted = true
				nextEpoch := a.maintenanceMu.Epoch() + 1
				a.maintenanceMu.Unlock()
				expectedEpoch = nextEpoch
				return func() {}, false
			}
		}
		return func() {
			nextEpoch := a.maintenanceMu.Epoch() + 1
			a.maintenanceMu.Unlock()
			expectedEpoch = nextEpoch
		}, true
	})
	now := time.Now().UTC()
	snapshotCount, snapshotErr := jobs.PruneSnapshots(ctx, now, protectedSnapshots, removalGuard)
	releaseCount, releaseErr := jobs.PruneReleases(ctx, now, protectedIDs, protectedImages, heldImages, removalGuard)
	operationCount, operationErr := jobs.PruneTerminalOperations(ctx, now, removalGuard)
	// Manager binaries are serialized by their dedicated recovery lock inside
	// PruneManagerVersions. The admission guard is released before taking that
	// lock, while the cleanup itself re-reads Manager state under the recovery
	// lock before deleting any version.
	managerVersionCount := 0
	var managerVersionErr error
	if releaseAdmission, ok := removalGuard(); ok {
		releaseAdmission()
		managerVersionCount, managerVersionErr = jobs.PruneManagerVersions(ctx, now, time.Duration(contract.ObsoleteArtifactRetentionSeconds)*time.Second)
	}
	err = errors.Join(snapshotErr, releaseErr, operationErr, managerVersionErr)
	if a.audit != nil && (snapshotCount > 0 || releaseCount > 0 || operationCount > 0 || managerVersionCount > 0 || err != nil) {
		event := logstore.Event{
			At:      now,
			Type:    "manager.maintenance",
			Details: map[string]any{"snapshots_removed": snapshotCount, "releases_removed": releaseCount, "operations_removed": operationCount, "manager_versions_removed": managerVersionCount},
		}
		if err != nil {
			event.Error = journal.BoundDiagnostic(err.Error())
		}
		_ = a.audit.Append(event)
	}
	return err
}

type maintenanceOperationReference struct {
	ID               string
	TargetGeneration string
	SnapshotPath     string
	Status           model.OperationStatus
	Phase            model.OperationPhase
	Finalized        bool
	UpdatedAt        time.Time
}

func maintenanceOperationReferences(operations []model.Operation, allowedOperationID string) ([]maintenanceOperationReference, bool) {
	if len(operations) == 0 {
		return nil, allowedOperationID == ""
	}
	if allowedOperationID == "" || len(operations) != 1 || operations[0].ID != allowedOperationID {
		return nil, false
	}
	operation := operations[0]
	return []maintenanceOperationReference{{
		ID: operation.ID, TargetGeneration: operation.TargetGeneration, SnapshotPath: operation.SnapshotPath,
		Status: operation.Status, Phase: operation.Phase, Finalized: operation.Finalized, UpdatedAt: operation.UpdatedAt,
	}}, true
}

func sameMaintenanceOperationReferences(left, right []maintenanceOperationReference) bool {
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

func sameMaintenanceSelfUpdateState(left, right selfupdate.State) bool {
	return left.SchemaVersion == right.SchemaVersion && left.UpdatedAt.Equal(right.UpdatedAt) &&
		sameMaintenanceVersion(left.Current, right.Current) && sameMaintenanceVersion(left.Previous, right.Previous) &&
		sameMaintenanceVersion(left.Candidate, right.Candidate) && sameMaintenanceActivation(left.Activation, right.Activation)
}

func sameMaintenanceVersion(left, right *selfupdate.Version) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func sameMaintenanceActivation(left, right *selfupdate.Activation) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func (a *application) activeMaintenanceProcesses() int {
	if a.maintenanceActiveProcesses != nil {
		return a.maintenanceActiveProcesses()
	}
	if a.processes != nil {
		return a.processes.ActiveBackgroundCount()
	}
	return 0
}

func maintenanceStateEligible(state model.ManagerState, allowedOperationID string) bool {
	if state.FinalizePendingOperationID != "" || state.Maintenance {
		return false
	}
	if state.ActiveOperationID != "" && state.ActiveOperationID != allowedOperationID {
		return false
	}
	if allowedOperationID == "" {
		return state.ActiveOperationID == "" && state.PublicState == model.StateIdle && state.Current != nil
	}
	if state.ActiveOperationID != allowedOperationID {
		return false
	}
	return state.PublicState == model.StateIdle || state.PublicState == model.StateWaitingForTasks
}

func autoUpdateDue(last, now time.Time, interval time.Duration) bool {
	if interval <= 0 {
		interval = 5 * time.Minute
	}
	return !now.Before(last.Add(interval))
}
func (a *application) autoUpdate(ctx context.Context) {
	cfg := a.configs.Config()
	if !cfg.UpdateEnabled || cfg.ReleaseURL == "" {
		return
	}
	state := a.state.State()
	if state.ActiveOperationID != "" || state.Current == nil {
		return
	}
	checkCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	manifest, err := a.operations.Check(checkCtx, cfg.ReleaseURL)
	cancel()
	if err != nil || manifest.ID() == state.Current.ID {
		return
	}
	if manifest.NamespaceHandoff != nil {
		// Check has already routed this manifest to the independent handoff
		// coordinator. It must never be replayed through ordinary runUpdate.
		return
	}
	fresh := a.state.State()
	_, _, _ = a.operations.Start(model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: "auto-" + manifest.ID() + "-" + time.Now().UTC().Format("2006010215"), ExpectedGeneration: fresh.Generation, ManifestURL: cfg.ReleaseURL})
}

type gatewayController struct {
	app            *application
	state          *gatewayStateSwitch
	mu             sync.Mutex
	server         *http.Server
	listener       net.Listener
	handler        *gateway.Handler
	lanServer      *http.Server
	lanListener    net.Listener
	lanHandler     *gateway.Handler
	lanAddress     string
	lanInitialized bool
	lanLastError   error
	handoffWaiting bool
	handoffID      string
	handoffRole    handofflisteners.PublicOwner
}

type gatewayStateSwitch struct {
	mu      sync.RWMutex
	current gateway.StateProvider
}

func (state *gatewayStateSwitch) State() model.ManagerState {
	state.mu.RLock()
	current := state.current
	state.mu.RUnlock()
	if current == nil {
		return model.ManagerState{SchemaVersion: 1, PublicState: model.StateFailed, Maintenance: true}
	}
	return current.State()
}

func (state *gatewayStateSwitch) set(current gateway.StateProvider) {
	state.mu.Lock()
	state.current = current
	state.mu.Unlock()
}

func newGatewayController(app *application) *gatewayController {
	provider := app.publicState
	if provider == nil {
		provider = app.state
	}
	return &gatewayController{app: app, state: &gatewayStateSwitch{current: provider}}
}

// WaitForHandoffListeners prevents this participant from racing the persistent
// helper for the public addresses. It must be called before Run or Start.
func (g *gatewayController) WaitForHandoffListeners() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.listener != nil || g.lanListener != nil || g.server != nil || g.lanServer != nil {
		return errors.New("public gateway already owns listeners")
	}
	g.handoffWaiting = true
	return nil
}
func (g *gatewayController) Run() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for range ticker.C {
		state := g.state.State()
		wanted := state.Current != nil || state.Maintenance
		if wanted {
			_ = g.Start()
		} else {
			g.Stop()
		}
	}
}
func (g *gatewayController) Start() error {
	cfg := g.app.configs.Config()
	g.mu.Lock()
	active, lanErr, err := g.startLocked(cfg)
	g.mu.Unlock()
	if err != nil {
		return err
	}
	g.app.configs.SetLANStatus(active, lanErr)
	return nil
}

func (g *gatewayController) startLocked(cfg config.Config) (bool, error, error) {
	if g.handoffWaiting {
		return false, nil, nil
	}
	trusted, err := config.TrustedIngressPrefixes(cfg.TrustedIngressCIDRs)
	if err != nil {
		return false, nil, err
	}
	if g.listener == nil {
		listener, listenErr := gateway.Listener(g.app.config.GatewayAddress)
		if listenErr != nil {
			return false, nil, listenErr
		}
		handler, handlerErr := gateway.NewHandlerWithAccess(g.app.profile, g.state, g.app.config.PlatformURL, gateway.AccessPolicy{TrustedIngressPrefixes: trusted})
		if handlerErr != nil {
			_ = listener.Close()
			return false, nil, handlerErr
		}
		g.listener = listener
		g.handler = handler
		g.server = gateway.Server(listener, handler)
	} else {
		g.handler.SetAccessPolicy(gateway.AccessPolicy{TrustedIngressPrefixes: trusted})
	}
	if g.lanInitialized {
		return g.lanListener != nil, g.lanLastError, nil
	}
	active, lanErr := g.applyLANConfigLocked(cfg, trusted)
	if lanErr == nil {
		g.lanInitialized = true
	}
	g.lanLastError = lanErr
	return active, lanErr, nil
}

// ApplyLANConfig is the synchronous configuration commit hook. It binds a new
// listener before replacing the old one and does not call back into the config
// manager, which holds its transaction lock while invoking this method.
func (g *gatewayController) ApplyLANConfig(cfg config.Config) (bool, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.handoffWaiting {
		return false, errors.New("public listener configuration is frozen during namespace handoff")
	}
	trusted, err := config.TrustedIngressPrefixes(cfg.TrustedIngressCIDRs)
	if err != nil {
		return g.lanListener != nil, err
	}
	active, err := g.applyLANConfigLocked(cfg, trusted)
	if err == nil {
		g.lanInitialized = true
	}
	g.lanLastError = err
	return active, err
}

// CurrentHandoffListeners returns the exact live public listener set while
// retaining ownership in this process. handofffd duplicates the descriptors
// before transfer, so callers must never close values returned here.
func (g *gatewayController) CurrentHandoffListeners() ([]handofffd.NamedListener, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.currentHandoffListenersLocked()
}

func (g *gatewayController) currentHandoffListenersLocked() ([]handofffd.NamedListener, error) {
	if g.handoffWaiting || g.listener == nil {
		return nil, errors.New("public gateway listener ownership is unavailable")
	}
	listeners := []handofffd.NamedListener{{Name: "primary", Listener: g.listener}}
	if g.app.configs.Config().LANEnabled {
		if g.lanListener == nil {
			return nil, errors.New("configured LAN listener is unavailable")
		}
		// The wire protocol is lexicographically ordered.
		listeners = []handofffd.NamedListener{{Name: "lan", Listener: g.lanListener}, {Name: "primary", Listener: g.listener}}
	} else if g.lanListener != nil {
		return nil, errors.New("an unconfigured LAN listener is active")
	}
	return listeners, nil
}

// ConfigureHandoffParticipant binds the gateway's ownership answers to one
// immutable journal and role. It neither opens nor closes a listener.
func (g *gatewayController) ConfigureHandoffParticipant(journal handoff.Journal, role handofflisteners.PublicOwner) error {
	if err := handoff.Validate(journal); err != nil {
		return fmt.Errorf("validate gateway handoff participant: %w", err)
	}
	wantedProfile := journal.Source.Namespace
	if role == handofflisteners.OwnerTarget {
		wantedProfile = journal.Target.Namespace
	} else if role != handofflisteners.OwnerSource {
		return errors.New("gateway handoff participant role is invalid")
	}
	profile, err := g.app.profile.Profile()
	if err != nil || profile.ProfileID != wantedProfile {
		return errors.New("gateway handoff participant profile differs from the journal")
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.handoffID != "" && (g.handoffID != journal.TransactionID || g.handoffRole != role) {
		return errors.New("gateway is already bound to another handoff participant")
	}
	g.handoffID = journal.TransactionID
	g.handoffRole = role
	return nil
}

// PublicListenerOwned reports the participant's complete listener ownership
// under the same mutex used for SCM_RIGHTS adoption and relinquishment. A
// partial listener set is an error, never a successful ownership claim.
func (g *gatewayController) PublicListenerOwned() (bool, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.handoffWaiting {
		return false, nil
	}
	if _, err := g.currentHandoffListenersLocked(); err != nil {
		return false, err
	}
	return true, nil
}

// PromoteApplication swaps a restricted participant to the fully constructed
// terminal Manager without closing or rebinding its adopted public listeners.
// Every externally visible listener setting must remain byte-for-byte equal;
// namespace handoff is not a configuration-change mechanism.
func (g *gatewayController) PromoteApplication(app *application) error {
	if app == nil || app.state == nil || app.configs == nil {
		return errors.New("terminal Manager application is incomplete")
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	oldProfile, oldErr := g.app.profile.Profile()
	newProfile, newErr := app.profile.Profile()
	oldConfig := g.app.configs.Config()
	newConfig := app.configs.Config()
	if oldErr != nil || newErr != nil || !reflect.DeepEqual(oldProfile, newProfile) ||
		oldConfig.GatewayAddress != newConfig.GatewayAddress ||
		oldConfig.LANEnabled != newConfig.LANEnabled ||
		oldConfig.LANAddress != newConfig.LANAddress ||
		oldConfig.PlatformURL != newConfig.PlatformURL {
		return errors.New("terminal Manager public configuration differs from the handoff participant")
	}
	g.app = app
	g.state.set(app.state)
	return nil
}

func (g *gatewayController) CompleteHandoffParticipant(transactionID string) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if transactionID == "" || g.handoffID != transactionID {
		return errors.New("gateway handoff completion differs from the active participant")
	}
	if g.handoffWaiting {
		return errors.New("gateway cannot complete handoff without public listener ownership")
	}
	g.handoffID = ""
	g.handoffRole = handofflisteners.OwnerUnknown
	return nil
}

// ProveListenerOwnership is served only on the owner-authenticated control
// socket. The proof and listener snapshot are produced under the same mutex
// used by adoption, relinquishment and teardown.
func (g *gatewayController) ProveListenerOwnership(_ context.Context, challenge handofflisteners.OwnershipChallenge) (handofflisteners.OwnershipProof, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.handoffID == "" || challenge.TransactionID != g.handoffID || challenge.Role != g.handoffRole {
		return handofflisteners.OwnershipProof{}, errors.New("listener ownership challenge differs from the active handoff participant")
	}
	if g.handoffWaiting {
		return handofflisteners.BuildOwnershipProof(challenge, g.handoffRole, nil)
	}
	listeners, err := g.currentHandoffListenersLocked()
	if err != nil {
		return handofflisteners.OwnershipProof{}, err
	}
	return handofflisteners.BuildOwnershipProof(challenge, g.handoffRole, listeners)
}

// RelinquishHandoffListeners closes the source's originals only after the
// helper has acknowledged its duplicated descriptor set. The gateway remains
// in waiting mode so ordinary reconciliation cannot race to rebind the public
// addresses while the helper owns them.
func (g *gatewayController) RelinquishHandoffListeners() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.handoffID == "" || g.handoffRole != handofflisteners.OwnerSource || g.handoffWaiting {
		return errors.New("source gateway is not in a transferable handoff state")
	}
	g.stopLANLocked()
	shutdownListener(g.server, g.listener)
	g.server = nil
	g.listener = nil
	g.handler = nil
	g.handoffWaiting = true
	return nil
}

// AdoptHandoffListeners installs descriptors received from the persistent
// helper without rebinding either address. HTTP servers are started before the
// method returns, which makes the SCM_RIGHTS acknowledgement the final gapless
// ownership boundary from the participant's perspective.
func (g *gatewayController) AdoptHandoffListeners(listeners []handofffd.NamedListener) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.handoffWaiting {
		return errors.New("public gateway is not waiting for handoff listeners")
	}
	if g.listener != nil || g.lanListener != nil || g.server != nil || g.lanServer != nil {
		return errors.New("public gateway already owns listeners")
	}
	cfg := g.app.configs.Config()
	wanted := map[string]string{"primary": cfg.GatewayAddress}
	if cfg.LANEnabled {
		wanted["lan"] = cfg.LANAddress
	}
	actual := make(map[string]net.Listener, len(listeners))
	for _, named := range listeners {
		if named.Listener == nil || named.Listener.Addr() == nil {
			return errors.New("handoff supplied a nil public listener")
		}
		if _, duplicate := actual[named.Name]; duplicate {
			return errors.New("handoff supplied a duplicate public listener")
		}
		expected, known := wanted[named.Name]
		if !known || named.Listener.Addr().Network() != "tcp" || named.Listener.Addr().String() != expected {
			return errors.New("handoff public listener does not match the active configuration")
		}
		actual[named.Name] = named.Listener
	}
	if len(actual) != len(wanted) || actual["primary"] == nil || (cfg.LANEnabled && actual["lan"] == nil) {
		return errors.New("handoff public listener set is incomplete")
	}
	trusted, err := config.TrustedIngressPrefixes(cfg.TrustedIngressCIDRs)
	if err != nil {
		return err
	}
	primaryHandler, err := gateway.NewHandlerWithAccess(g.app.profile, g.state, g.app.config.PlatformURL, gateway.AccessPolicy{TrustedIngressPrefixes: trusted})
	if err != nil {
		return err
	}
	var lanHandler *gateway.Handler
	if cfg.LANEnabled {
		direct, parseErr := config.DirectAccessPrefixes(cfg.DirectAccessCIDRs)
		if parseErr != nil {
			return parseErr
		}
		lanHandler, err = gateway.NewHandlerWithAccess(g.app.profile, g.state, g.app.config.PlatformURL, gateway.AccessPolicy{AllowedRemotePrefixes: direct, TrustedIngressPrefixes: trusted})
		if err != nil {
			return err
		}
	}
	g.listener = actual["primary"]
	g.handler = primaryHandler
	g.server = gateway.Server(g.listener, primaryHandler)
	if cfg.LANEnabled {
		g.lanListener = actual["lan"]
		g.lanHandler = lanHandler
		g.lanAddress = cfg.LANAddress
		g.lanServer = gateway.Server(g.lanListener, lanHandler)
		g.lanInitialized = true
		g.lanLastError = nil
	}
	g.handoffWaiting = false
	g.app.configs.SetLANStatus(cfg.LANEnabled, nil)
	return nil
}

func (g *gatewayController) applyLANConfigLocked(cfg config.Config, trusted []netip.Prefix) (bool, error) {
	if !cfg.LANEnabled {
		g.stopLANLocked()
		if g.handler != nil {
			g.handler.SetAccessPolicy(gateway.AccessPolicy{TrustedIngressPrefixes: trusted})
		}
		return false, nil
	}
	direct, err := config.DirectAccessPrefixes(cfg.DirectAccessCIDRs)
	if err != nil {
		return g.lanListener != nil, err
	}
	access := gateway.AccessPolicy{AllowedRemotePrefixes: direct, TrustedIngressPrefixes: trusted}
	if g.lanListener != nil && g.lanAddress == cfg.LANAddress {
		g.lanHandler.SetAccessPolicy(access)
		if g.handler != nil {
			g.handler.SetAccessPolicy(gateway.AccessPolicy{TrustedIngressPrefixes: trusted})
		}
		return true, nil
	}
	listener, err := gateway.TCPListener(cfg.LANAddress)
	if err != nil {
		return g.lanListener != nil, err
	}
	handler, err := gateway.NewHandlerWithAccess(g.app.profile, g.state, g.app.config.PlatformURL, access)
	if err != nil {
		_ = listener.Close()
		return g.lanListener != nil, err
	}
	oldServer, oldListener := g.lanServer, g.lanListener
	g.lanAddress = cfg.LANAddress
	g.lanListener = listener
	g.lanHandler = handler
	g.lanServer = gateway.Server(listener, handler)
	if g.handler != nil {
		g.handler.SetAccessPolicy(gateway.AccessPolicy{TrustedIngressPrefixes: trusted})
	}
	shutdownListener(oldServer, oldListener)
	return true, nil
}
func (g *gatewayController) Health(ctx context.Context) error {
	if err := g.Start(); err != nil {
		return err
	}
	g.mu.Lock()
	listener := g.listener
	g.mu.Unlock()
	if listener == nil {
		return errors.New("public gateway listener is unavailable")
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
		return nil
	}
}
func (g *gatewayController) Stop() {
	g.mu.Lock()
	g.stopLANLocked()
	if g.server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		_ = g.server.Shutdown(ctx)
		cancel()
	}
	if g.listener != nil {
		_ = g.listener.Close()
	}
	g.server = nil
	g.listener = nil
	g.handler = nil
	g.mu.Unlock()
}

func (g *gatewayController) stopLANLocked() {
	shutdownListener(g.lanServer, g.lanListener)
	g.lanServer = nil
	g.lanListener = nil
	g.lanHandler = nil
	g.lanAddress = ""
	g.lanInitialized = false
	g.lanLastError = nil
}

func shutdownListener(server *http.Server, listener net.Listener) {
	if server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		_ = server.Shutdown(ctx)
		cancel()
	}
	if listener != nil {
		_ = listener.Close()
	}
}

func managerClient(configPath string) (control.Client, config.Config, error) {
	return managerClientWithProfile(identity.SourceActiveProfile(), configPath)
}

func managerClientWithProfile(active identity.ActiveProfile, configPath string) (control.Client, config.Config, error) {
	cfg, err := loadWithProfile(active, configPath)
	if err != nil {
		return control.Client{}, config.Config{}, err
	}
	return managerClientWithConfig(cfg)
}

func managerClientWithConfig(cfg config.Config) (control.Client, config.Config, error) {
	tokenPath := cfg.ControlTokenFile()
	token, err := driver.ReadOwnerSecret(tokenPath)
	if err != nil {
		return control.Client{}, config.Config{}, err
	}
	return control.Client{SocketPath: cfg.SocketPath, Token: token, Timeout: 35 * time.Second}, cfg, nil
}

func releaseTransitionCommand(arguments []string) error {
	return releaseTransitionCommandWithProfile(identity.SourceActiveProfile(), arguments)
}

func releaseTransitionCommandWithProfile(active identity.ActiveProfile, arguments []string) error {
	if len(arguments) == 0 {
		return errors.New("release-transition requires identity or attest")
	}
	switch arguments[0] {
	case "identity":
		set, path := commonFlags("release-transition identity")
		publicKeyPath := set.String("public-key-pem", "", "new owner-only Ed25519 public key PEM path")
		if err := set.Parse(arguments[1:]); err != nil {
			return err
		}
		cfg, err := loadWithProfile(active, *path)
		if err != nil {
			return err
		}
		service := releaseTransitionAttestationService(cfg, nil)
		value, err := service.Identity()
		if err != nil {
			return err
		}
		if *publicKeyPath != "" {
			encoded, err := attestation.PublicKeyPEM(value)
			if err != nil {
				return err
			}
			if err := writeNewOwnerFile(*publicKeyPath, encoded); err != nil {
				return fmt.Errorf("write release transition public key: %w", err)
			}
		}
		return printJSON(value)
	case "attest":
		return releaseTransitionAttestCommandWithProfile(active, arguments[1:])
	default:
		return fmt.Errorf("unknown release-transition command %q", arguments[0])
	}
}

func releaseTransitionCommandWithConfig(cfg config.Config, arguments []string) error {
	if len(arguments) == 0 {
		return errors.New("release-transition requires identity or attest")
	}
	switch arguments[0] {
	case "identity":
		set, path := commonFlags("release-transition identity")
		publicKeyPath := set.String("public-key-pem", "", "new owner-only Ed25519 public key PEM path")
		if err := set.Parse(arguments[1:]); err != nil {
			return err
		}
		if set.NArg() != 0 {
			return errors.New("release-transition identity accepts no positional arguments")
		}
		if *path != cfg.ConfigPath {
			return errors.New("release-transition config argument differs from the routed technical identity")
		}
		service := releaseTransitionAttestationService(cfg, nil)
		value, err := service.Identity()
		if err != nil {
			return err
		}
		if *publicKeyPath != "" {
			encoded, err := attestation.PublicKeyPEM(value)
			if err != nil {
				return err
			}
			if err := writeNewOwnerFile(*publicKeyPath, encoded); err != nil {
				return fmt.Errorf("write release transition public key: %w", err)
			}
		}
		return printJSON(value)
	case "attest":
		return releaseTransitionAttestCommandWithConfig(cfg, arguments[1:])
	default:
		return fmt.Errorf("unknown release-transition command %q", arguments[0])
	}
}

func releaseTransitionAttestCommand(arguments []string) error {
	return releaseTransitionAttestCommandWithProfile(identity.SourceActiveProfile(), arguments)
}

func releaseTransitionAttestCommandWithProfile(active identity.ActiveProfile, arguments []string) error {
	set, path := commonFlags("release-transition attest")
	challengePath := set.String("challenge", "", "owner-only challenge JSON path")
	receiptPath := set.String("receipt", "", "new owner-only receipt JSON path")
	signaturePath := set.String("signature", "", "new owner-only signature path")
	if err := set.Parse(arguments); err != nil {
		return err
	}
	if *challengePath == "" || *receiptPath == "" || *signaturePath == "" {
		return errors.New("release-transition attest requires --challenge, --receipt and --signature")
	}
	challenge, err := readOwnerInputFile(*challengePath, 32<<10)
	if err != nil {
		return fmt.Errorf("read release transition challenge: %w", err)
	}
	client, cfg, err := managerClientWithProfile(active, *path)
	if err != nil {
		return err
	}
	service := releaseTransitionAttestationService(cfg, controlTransitionObserver{client: client})
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	signed, err := service.Attest(ctx, challenge)
	if err != nil {
		return err
	}
	receipt, err := attestation.CanonicalReceipt(signed.Receipt)
	if err != nil {
		return fmt.Errorf("encode signed release transition receipt: %w", err)
	}
	receipt = append(receipt, '\n')
	signature := append([]byte(signed.Signature), '\n')
	if err := writeOwnerOutputPair(*receiptPath, receipt, *signaturePath, signature); err != nil {
		return err
	}
	fmt.Printf("release transition receipt written to %s\n", filepath.Clean(*receiptPath))
	return nil
}

func releaseTransitionAttestCommandWithConfig(cfg config.Config, arguments []string) error {
	set, path := commonFlags("release-transition attest")
	challengePath := set.String("challenge", "", "owner-only challenge JSON path")
	receiptPath := set.String("receipt", "", "new owner-only receipt JSON path")
	signaturePath := set.String("signature", "", "new owner-only signature path")
	if err := set.Parse(arguments); err != nil {
		return err
	}
	if set.NArg() != 0 {
		return errors.New("release-transition attest accepts no positional arguments")
	}
	if *path != cfg.ConfigPath {
		return errors.New("release-transition config argument differs from the routed technical identity")
	}
	if *challengePath == "" || *receiptPath == "" || *signaturePath == "" {
		return errors.New("release-transition attest requires --challenge, --receipt and --signature")
	}
	challenge, err := readOwnerInputFile(*challengePath, 32<<10)
	if err != nil {
		return fmt.Errorf("read release transition challenge: %w", err)
	}
	client, cfg, err := managerClientWithConfig(cfg)
	if err != nil {
		return err
	}
	service := releaseTransitionAttestationService(cfg, controlTransitionObserver{client: client})
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	signed, err := service.Attest(ctx, challenge)
	if err != nil {
		return err
	}
	receipt, err := attestation.CanonicalReceipt(signed.Receipt)
	if err != nil {
		return fmt.Errorf("encode signed release transition receipt: %w", err)
	}
	receipt = append(receipt, '\n')
	signature := append([]byte(signed.Signature), '\n')
	if err := writeOwnerOutputPair(*receiptPath, receipt, *signaturePath, signature); err != nil {
		return err
	}
	fmt.Printf("release transition receipt written to %s\n", filepath.Clean(*receiptPath))
	return nil
}

func waitForManager(client control.Client) error {
	deadline := time.Now().Add(10 * time.Second)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		// Readiness needs only an authenticated success status, so the body is not
		// decoded here.
		err := client.Do(ctx, http.MethodGet, "/v1/status", nil, nil)
		cancel()
		if err == nil {
			return nil
		}
		if !control.IsUnavailable(err) {
			return err
		}
		if time.Now().After(deadline) {
			return err
		}
		time.Sleep(200 * time.Millisecond)
	}
}
func installCommand(arguments []string) error {
	return installCommandWithProfile(identity.SourceActiveProfile(), arguments)
}

func installCommandWithProfile(active identity.ActiveProfile, arguments []string) error {
	set, path := commonFlags("install")
	manifestURL := set.String("release-manifest-url", "", "release manifest URL")
	if err := set.Parse(arguments); err != nil {
		return err
	}
	client, cfg, err := managerClientWithProfile(active, *path)
	if err != nil {
		return err
	}
	if err := waitForManager(client); err != nil {
		return err
	}
	if *manifestURL == "" {
		*manifestURL = cfg.ReleaseURL
	}
	if *manifestURL == "" {
		return errors.New("release manifest URL is required")
	}
	key := stableKey("install", *manifestURL)
	var response struct {
		Operation model.Operation `json:"operation"`
		Reused    bool            `json:"reused"`
	}
	if err := client.Do(context.Background(), http.MethodPost, "/v1/operations", map[string]any{"operation": "install", "idempotency_key": key, "manifest_url": *manifestURL}, &response); err != nil {
		return err
	}
	return awaitOperation(client, response.Operation.ID)
}

func installCommandWithConfig(cfg config.Config, arguments []string) error {
	set, path := commonFlags("install")
	manifestURL := set.String("release-manifest-url", "", "release manifest URL")
	if err := set.Parse(arguments); err != nil {
		return err
	}
	if set.NArg() != 0 || *path != cfg.ConfigPath {
		return errors.New("install config or arguments differ from the routed technical identity")
	}
	client, cfg, err := managerClientWithConfig(cfg)
	if err != nil {
		return err
	}
	if err := waitForManager(client); err != nil {
		return err
	}
	if *manifestURL == "" {
		*manifestURL = cfg.ReleaseURL
	}
	if *manifestURL == "" {
		return errors.New("release manifest URL is required")
	}
	key := stableKey("install", *manifestURL)
	var response struct {
		Operation model.Operation `json:"operation"`
		Reused    bool            `json:"reused"`
	}
	if err := client.Do(context.Background(), http.MethodPost, "/v1/operations", map[string]any{"operation": "install", "idempotency_key": key, "manifest_url": *manifestURL}, &response); err != nil {
		return err
	}
	return awaitOperation(client, response.Operation.ID)
}

func awaitOperation(client control.Client, id string) error {
	for {
		var op model.Operation
		if err := client.Do(context.Background(), http.MethodGet, "/v1/operations/"+id, nil, &op); err != nil {
			return err
		}
		switch op.Status {
		case model.OperationSucceeded:
			return nil
		case model.OperationFailed:
			return errors.New(op.Error)
		}
		time.Sleep(500 * time.Millisecond)
	}
}

func simpleGetCommand(name string, arguments []string, pathValue string) error {
	return simpleGetCommandWithProfile(identity.SourceActiveProfile(), name, arguments, pathValue)
}

func simpleGetCommandWithProfile(active identity.ActiveProfile, name string, arguments []string, pathValue string) error {
	set, path := commonFlags(name)
	if err := set.Parse(arguments); err != nil {
		return err
	}
	client, _, err := managerClientWithProfile(active, *path)
	if err != nil {
		return err
	}
	var value any
	if err := client.Do(context.Background(), http.MethodGet, pathValue, nil, &value); err != nil {
		return err
	}
	return printJSON(value)
}

func simpleGetCommandWithConfig(cfg config.Config, name string, arguments []string, pathValue string) error {
	set, path := commonFlags(name)
	if err := set.Parse(arguments); err != nil {
		return err
	}
	if set.NArg() != 0 || *path != cfg.ConfigPath {
		return fmt.Errorf("%s config or arguments differ from the routed technical identity", name)
	}
	client, _, err := managerClientWithConfig(cfg)
	if err != nil {
		return err
	}
	var value any
	if err := client.Do(context.Background(), http.MethodGet, pathValue, nil, &value); err != nil {
		return err
	}
	return printJSON(value)
}
func checkCommand(arguments []string) error {
	return checkCommandWithProfile(identity.SourceActiveProfile(), arguments)
}

type releaseCheckResponse struct {
	Manifest release.Manifest `json:"manifest"`
	Reused   bool             `json:"reused"`
}

func checkCommandWithProfile(active identity.ActiveProfile, arguments []string) error {
	set, path := commonFlags("check")
	url := set.String("release-manifest-url", "", "override manifest URL")
	if err := set.Parse(arguments); err != nil {
		return err
	}
	client, _, err := managerClientWithProfile(active, *path)
	if err != nil {
		return err
	}
	value, err := requestReleaseCheck(client, *url, stableKey("check", *url, time.Now().UTC().Format("200601021504")))
	if err != nil {
		return err
	}
	return printJSON(value)
}

func checkCommandWithConfig(cfg config.Config, arguments []string) error {
	set, path := commonFlags("check")
	url := set.String("release-manifest-url", "", "override manifest URL")
	if err := set.Parse(arguments); err != nil {
		return err
	}
	if set.NArg() != 0 || *path != cfg.ConfigPath {
		return errors.New("check config or arguments differ from the routed technical identity")
	}
	client, _, err := managerClientWithConfig(cfg)
	if err != nil {
		return err
	}
	value, err := requestReleaseCheck(client, *url, stableKey("check", *url, time.Now().UTC().Format("200601021504")))
	if err != nil {
		return err
	}
	return printJSON(value)
}

func requestReleaseCheck(client control.Client, manifestURL, idempotencyKey string) (releaseCheckResponse, error) {
	body := map[string]any{"idempotency_key": idempotencyKey}
	if manifestURL != "" {
		body["manifest_url"] = manifestURL
	}
	var value releaseCheckResponse
	if err := client.Do(context.Background(), http.MethodPost, "/v1/check", body, &value); err != nil {
		return releaseCheckResponse{}, err
	}
	return value, nil
}
func operationCommand(kind string, arguments []string) error {
	return operationCommandWithProfile(identity.SourceActiveProfile(), kind, arguments)
}

func operationCommandWithProfile(active identity.ActiveProfile, kind string, arguments []string) error {
	set, path := commonFlags(kind)
	url := set.String("release-manifest-url", "", "override manifest URL")
	if err := set.Parse(arguments); err != nil {
		return err
	}
	client, _, err := managerClientWithProfile(active, *path)
	if err != nil {
		return err
	}
	if kind == "update" {
		checked, err := requestReleaseCheck(client, *url, stableKey("manual-update-check", *url, time.Now().UTC().Format("200601021504")))
		if err != nil {
			return fmt.Errorf("check release before update: %w", err)
		}
		if checked.Manifest.NamespaceHandoff != nil {
			return printJSON(checked)
		}
	}
	body := map[string]any{"operation": kind, "idempotency_key": stableKey(kind, *url, strconv.FormatInt(time.Now().UnixNano(), 10))}
	if *url != "" {
		body["manifest_url"] = *url
	}
	var response struct {
		Operation model.Operation `json:"operation"`
	}
	if err := client.Do(context.Background(), http.MethodPost, "/v1/operations", body, &response); err != nil {
		return err
	}
	return awaitOperation(client, response.Operation.ID)
}

func operationCommandWithConfig(cfg config.Config, kind string, arguments []string) error {
	set, path := commonFlags(kind)
	url := set.String("release-manifest-url", "", "override manifest URL")
	if err := set.Parse(arguments); err != nil {
		return err
	}
	if set.NArg() != 0 || *path != cfg.ConfigPath {
		return fmt.Errorf("%s config or arguments differ from the routed technical identity", kind)
	}
	client, _, err := managerClientWithConfig(cfg)
	if err != nil {
		return err
	}
	if kind == "update" {
		checked, err := requestReleaseCheck(client, *url, stableKey("manual-update-check", *url, time.Now().UTC().Format("200601021504")))
		if err != nil {
			return fmt.Errorf("check release before update: %w", err)
		}
		if checked.Manifest.NamespaceHandoff != nil {
			return printJSON(checked)
		}
	}
	body := map[string]any{"operation": kind, "idempotency_key": stableKey(kind, *url, strconv.FormatInt(time.Now().UnixNano(), 10))}
	if *url != "" {
		body["manifest_url"] = *url
	}
	var response struct {
		Operation model.Operation `json:"operation"`
	}
	if err := client.Do(context.Background(), http.MethodPost, "/v1/operations", body, &response); err != nil {
		return err
	}
	return awaitOperation(client, response.Operation.ID)
}
func logsCommand(arguments []string) error {
	return logsCommandWithProfile(identity.SourceActiveProfile(), arguments)
}

func logsCommandWithProfile(active identity.ActiveProfile, arguments []string) error {
	set, path := commonFlags("logs")
	service := set.String("service", "", "Compose service")
	tail := set.Int("tail", 200, "line count")
	if err := set.Parse(arguments); err != nil {
		return err
	}
	client, _, err := managerClientWithProfile(active, *path)
	if err != nil {
		return err
	}
	var value map[string]any
	url := "/v1/logs?tail=" + strconv.Itoa(*tail) + "&service=" + *service
	if err := client.Do(context.Background(), http.MethodGet, url, nil, &value); err != nil {
		return err
	}
	if content, ok := value["content"].(string); ok {
		fmt.Print(content)
		return nil
	}
	return printJSON(value)
}

func logsCommandWithConfig(cfg config.Config, arguments []string) error {
	set, path := commonFlags("logs")
	service := set.String("service", "", "Compose service")
	tail := set.Int("tail", 200, "line count")
	if err := set.Parse(arguments); err != nil {
		return err
	}
	if set.NArg() != 0 || *path != cfg.ConfigPath {
		return errors.New("logs config or arguments differ from the routed technical identity")
	}
	client, _, err := managerClientWithConfig(cfg)
	if err != nil {
		return err
	}
	var value map[string]any
	url := "/v1/logs?tail=" + strconv.Itoa(*tail) + "&service=" + *service
	if err := client.Do(context.Background(), http.MethodGet, url, nil, &value); err != nil {
		return err
	}
	if content, ok := value["content"].(string); ok {
		fmt.Print(content)
		return nil
	}
	return printJSON(value)
}
func printJSON(value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(data))
	return nil
}
func stableKey(values ...string) string {
	hash := sha256.New()
	for _, value := range values {
		_, _ = hash.Write([]byte(value))
		_, _ = hash.Write([]byte{0})
	}
	return hex.EncodeToString(hash.Sum(nil))
}

func runningExecutableSHA256() (string, error) {
	// /proc/self/exe keeps referring to the executing inode even if the stable
	// path is atomically replaced by a later self-update.
	file, err := os.Open("/proc/self/exe")
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	written, err := io.Copy(hash, io.LimitReader(file, (128<<20)+1))
	if err != nil {
		return "", err
	}
	if written > 128<<20 {
		return "", errors.New("running Manager executable exceeds 128 MiB")
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
func dockerLogSize(bytes int64) string {
	mib := bytes / (1 << 20)
	if mib < 1 {
		mib = 1
	}
	return fmt.Sprintf("%dm", mib)
}
