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
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/config"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/control"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/driver"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/executor"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/gateway"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/journal"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/logstore"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/operation"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/sandbox"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/selfupdate"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/snapshot"
)

var version = "development"

const managerDisplayName = "Agent Platform Manager"

type pendingAutoUpdate struct {
	targetID    string
	operationID string
}

type application struct {
	config            config.Config
	configs           *config.Manager
	state             *journal.Store
	docker            *driver.DockerCLI
	operations        *operation.Orchestrator
	sandboxes         *sandbox.Manager
	selfUpdate        *selfupdate.Manager
	snapshots         snapshot.Store
	audit             *logstore.Store
	api               *control.API
	fixedStackMu      sync.Locker
	maintenanceMu     *sync.Mutex
	maintenanceWake   chan struct{}
	autoUpdateMu      sync.Mutex
	pendingAutoUpdate pendingAutoUpdate
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
	if command == "version" || command == "--version" || command == "-version" {
		if len(arguments) != 1 {
			fmt.Fprintln(os.Stderr, "version accepts no arguments")
			return 1
		}
		fmt.Println(version)
		return 0
	}
	if _, known := startupCommandArguments[command]; !known {
		usage()
		return 64
	}
	if _, err := parseStartupArguments(command, arguments[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	var err error
	switch command {
	case "inspect-release":
		err = inspectReleaseCommand(arguments[1:], os.Stdout)
	case "serve":
		err = serveCommand(arguments[1:])
	case "launcher", "bootstrap-launcher":
		err = launcherCommand(command, arguments[1:])
	case "preflight":
		err = preflightCommand(arguments[1:])
	case "install":
		err = installCommand(arguments[1:])
	case "status":
		err = simpleGetCommand("status", arguments[1:], "/v1/status")
	case "check":
		err = checkCommand(arguments[1:])
	case "update", "restart", "rollback", "repair":
		err = operationCommand(command, arguments[1:])
	case "logs":
		err = logsCommand(arguments[1:])
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
	profile := identity.TargetProfile()
	fmt.Fprintln(os.Stderr, managerDisplayName)
	fmt.Fprintf(os.Stderr, "usage: %s <launcher|bootstrap-launcher|serve|preflight|install|status|check|update|restart|rollback|repair|logs|inspect-release|version> [options]\n", profile.ManagerBinary)
}

func commonFlags(name string) (*flag.FlagSet, *string) {
	set := flag.NewFlagSet(name, flag.ContinueOnError)
	path := set.String("config", "", "manager.toml path")
	return set, path
}
func load(path string) (config.Config, error) {
	return resolveTargetConfiguration(path)
}

func build(path string) (*application, error) {
	cfg, err := load(path)
	if err != nil {
		return nil, err
	}
	return buildWithConfig(cfg)
}

func buildWithConfig(cfg config.Config) (*application, error) {
	active := identity.CompileTimeActiveProfile()
	docker := &driver.DockerCLI{Profile: active, Binary: cfg.DockerBinary, ComposeFile: cfg.ComposeFile, ComposeProject: cfg.ComposeProject, GenerationDir: filepath.Join(cfg.StateDir, "releases"), DataRoot: cfg.DataRoot, StateDir: cfg.StateDir, ControlDir: filepath.Dir(cfg.SocketPath), GatewayAddress: cfg.GatewayAddress, PlatformBind: "127.0.0.1:18080", CoreNetwork: cfg.SandboxNetwork, LogMaxSize: dockerLogSize(cfg.LogMaxBytes), LogMaxFiles: cfg.LogBackups, UID: os.Getuid(), GID: os.Getgid(), Runner: driver.CommandRunner{MaxOutputBytes: cfg.CommandMaxBytes}, ManagedImageMu: &sync.Mutex{}}
	if err := docker.EnsureHostLayout(); err != nil {
		return nil, err
	}
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
	selfUpdater := supervisorManager(cfg)
	if err := selfUpdater.RequireSupervisor(); err != nil {
		return nil, err
	}
	if _, err := selfUpdater.SupervisedStartup(); err != nil {
		return nil, err
	}
	state, err := journal.Open(cfg.StateDir, time.Now())
	if err != nil {
		return nil, err
	}
	audit := logstore.New(filepath.Join(cfg.StateDir, "logs", "audit.jsonl"), cfg.LogMaxBytes, cfg.LogBackups)
	dataDir := cfg.PlatformDataDir()
	snapshots := snapshot.Store{DataDir: dataDir, BackupDir: filepath.Join(cfg.DataRoot, "backups"), Retention: time.Duration(contract.MigrationBackupRetentionSeconds) * time.Second}
	fixedStackMu := &sync.Mutex{}
	maintenanceMu := &sync.Mutex{}
	ops := &operation.Orchestrator{Store: state, Engine: docker, Gate: operation.HTTPGate{BaseURL: cfg.PlatformGateURL, Token: cfg.InternalToken}, Snapshots: snapshots, SelfUpdate: selfUpdater, TechnicalProfile: active, DataRoot: cfg.DataRoot, ReleasesDir: filepath.Join(cfg.StateDir, "releases"), ManifestURL: cfg.ReleaseURL, Channel: cfg.ReleaseChannel, Log: audit, PollInterval: cfg.UpdateInterval, FixedStackMu: fixedStackMu, MaintenanceMu: maintenanceMu}
	selfUpdater.Client = ops.ReleaseClient
	ops.AdmissionCheck = func(snapshot model.ManagerState) error {
		if snapshot.Current == nil {
			return nil
		}
		return selfUpdater.RequireSupervisor()
	}
	image := cfg.SandboxImage
	if current := state.State().Current; current != nil && current.Images["agent-sandbox"] != "" {
		image = current.Images["agent-sandbox"]
	}
	sandboxes, err := sandbox.Open(active, docker, dataDir, filepath.Join(cfg.StateDir, "sandboxes.json"), image, cfg.SandboxNetwork, cfg.SandboxIdle)
	if err != nil {
		return nil, err
	}
	sandboxes.AgentResources, sandboxes.ChatResources, sandboxes.ChatIdle = cfg.SandboxAgent, cfg.SandboxChat, cfg.SandboxChatIdle
	// Retention only owns release artifacts and rollback snapshots. Sandbox
	// lifecycle locks must not block release admission on Docker I/O.
	maintenanceWake := make(chan struct{}, 1)
	ops.OnCommit = func(manifest release.Manifest) { sandboxes.SetImage(manifest.Images["agent-sandbox"]) }
	ops.OnFinalized = func(release.Manifest) {
		select {
		case maintenanceWake <- struct{}{}:
		default:
		}
	}
	execution, err := newExecutionService(active, docker, sandboxes, filepath.Join(cfg.StateDir, "control"), audit, cfg.CommandMaxBytes)
	if err != nil {
		return nil, err
	}
	configs := config.NewManager(cfg)
	runningSHA, err := runningExecutableSHA256()
	if err != nil {
		return nil, fmt.Errorf("identify running Manager executable: %w", err)
	}
	api := &control.API{Store: state, Operations: ops, Engine: docker, Executor: execution, Config: configs, AuditLog: audit, ControlToken: controlToken, ExecutorToken: executorToken, ManagerVersion: version, ManagerSHA256: runningSHA}
	app := &application{config: cfg, configs: configs, state: state, docker: docker, operations: ops, sandboxes: sandboxes, selfUpdate: selfUpdater, snapshots: snapshots, audit: audit, api: api, fixedStackMu: fixedStackMu, maintenanceMu: maintenanceMu, maintenanceWake: maintenanceWake}
	sandboxes.ReclaimCapacity = app.reconcileMaintenance
	return app, nil
}

func newExecutionService(active identity.ActiveProfile, engine driver.Engine, sandboxes *sandbox.Manager, auditDir string, audit *logstore.Store, commandMaxBytes int64) (*executor.Service, error) {
	processes, err := executor.NewProcessManager(active, engine, sandboxes, commandMaxBytes)
	if err != nil {
		return nil, err
	}
	files, err := executor.NewFileService(active, sandboxes, 10<<20)
	if err != nil {
		return nil, err
	}
	return &executor.Service{Audits: executor.AuditStore{Dir: auditDir, Log: audit}, Processes: processes, Files: files}, nil
}

func preflightCommand(arguments []string) error {
	set, path := commonFlags("preflight")
	if err := set.Parse(arguments); err != nil {
		return err
	}
	app, err := build(*path)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	if err := app.operations.Preflight(ctx); err != nil {
		return err
	}
	fmt.Println("preflight ok")
	return nil
}

func serveCommand(arguments []string) error {
	set, path := commonFlags("serve")
	if err := set.Parse(arguments); err != nil {
		return err
	}
	cfg, err := load(*path)
	if err != nil {
		return err
	}
	return serveCommandWithBuild(arguments, cfg, buildWithConfig)
}

func serveCommandWithBuild(arguments []string, cfg config.Config, builder func(config.Config) (*application, error)) error {
	set, path := commonFlags("serve")
	if err := set.Parse(arguments); err != nil {
		return err
	}
	if *path != "" && *path != cfg.ConfigPath {
		return errors.New("Manager config argument differs from the retained startup configuration")
	}
	manager := supervisorManager(cfg)
	lease, err := manager.AcquireServeLock()
	if err != nil {
		return err
	}
	defer lease.Release()
	if err := manager.RequireSupervisor(); err != nil {
		return fmt.Errorf("require completed launcher cutover: %w", err)
	}
	supervised, err := manager.SupervisedStartup()
	if err != nil {
		return err
	}
	if !supervised {
		return errors.New("Manager serve requires an authenticated immutable launcher parent")
	}
	app, err := builder(cfg)
	if err != nil {
		return err
	}
	cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 15*time.Second)
	err = app.sandboxes.StopRunning(cleanupCtx)
	cleanupCancel()
	if err != nil {
		return fmt.Errorf("stop managed sandboxes before executor startup: %w", err)
	}
	listener, err := control.Listen(app.config.SocketPath)
	if err != nil {
		return err
	}
	defer func() { _ = listener.Close() }()
	gatewayControl := newGatewayController(app)
	app.configs.SetLANApply(gatewayControl.ApplyLANConfig)
	app.operations.PublicProbe = gatewayControl.Health
	readiness := &startupReadiness{api: app.api}
	server := &http.Server{Handler: readiness, ReadHeaderTimeout: 15 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 32 << 10}
	serveErrors := make(chan error, 1)
	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErrors <- err
		}
	}()
	go gatewayControl.Run()
	defer gatewayControl.Stop()
	candidate, err := app.selfUpdate.SupervisedCandidateStartup()
	if err != nil {
		return err
	}
	recoveryCtx, recoveryCancel := context.WithTimeout(context.Background(), 2*time.Minute)
	if candidate {
		err = app.operations.RecoverBeforeActivation(recoveryCtx)
	} else {
		err = app.operations.RecoverBeforeSupervisorProof(recoveryCtx)
	}
	recoveryCancel()
	if err != nil {
		return fmt.Errorf("recover checkpoint before launcher readiness: %w", err)
	}
	if app.state.State().Current != nil {
		coreCtx, coreCancel := context.WithTimeout(context.Background(), 30*time.Second)
		err = app.operations.ProbeCurrentGeneration(coreCtx)
		coreCancel()
		if err != nil {
			return fmt.Errorf("prove supervised core readiness: %w", err)
		}
	}
	healthCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	err = gatewayControl.Health(healthCtx)
	cancel()
	if err != nil {
		return fmt.Errorf("prove public gateway readiness: %w", err)
	}
	if err := app.selfUpdate.AcknowledgeStartup(); err != nil {
		return fmt.Errorf("acknowledge launcher startup: %w", err)
	}
	proofCtx, proofCancel := context.WithTimeout(context.Background(), 45*time.Second)
	err = app.selfUpdate.AwaitStartupCommit(proofCtx)
	proofCancel()
	if err != nil {
		return fmt.Errorf("wait for launcher startup proof: %w", err)
	}
	readiness.ready.Store(true)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	// Keep the authenticated control API and maintenance gateway available while
	// a committed generation retries durable gate settlement.
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
		shutdown, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		return server.Shutdown(shutdown)
	case err := <-serveErrors:
		return err
	}
}

func managerInstallPath() string {
	binary := identity.TargetProfile().ManagerBinary
	account, err := currentDeploymentAccount()
	if err != nil {
		return ""
	}
	return filepath.Join(account.HomeDir, ".local", "bin", binary)
}

func runCurrentRecoveryAttempt(ctx context.Context, timeout time.Duration, recover func(context.Context) error) error {
	attemptCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	return recover(attemptCtx)
}

// recoverCurrent keeps committed-generation recovery failures visible without
// turning a healthy Manager control service into a restart loop.
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
	defer sandboxTicker.Stop()
	defer updateTicker.Stop()
	go runReconciliationLoop(ctx, 2*time.Second, capabilityRetryDelay, a.reconcileCapabilities)
	go runTriggeredReconciliationLoop(ctx, 3*time.Minute, maintenanceRetryDelay, a.maintenanceWake, a.reconcileMaintenance)
	a.runBackground(ctx, sandboxTicker.C, updateTicker.C)
}

func (a *application) runBackground(ctx context.Context, sandboxTicks, updateTicks <-chan time.Time) {
	// Sandbox cleanup can wait for Docker or a sandbox lock. Release polling
	// must remain live independently, including after a launcher-child restart.
	go a.runAutoUpdateLoop(ctx, updateTicks)
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-sandboxTicks:
			if current := a.state.State().Current; current != nil && current.Images["agent-sandbox"] != "" {
				a.sandboxes.SetImage(current.Images["agent-sandbox"])
			}
			_, reapErr := a.sandboxes.Reap(ctx, now)
			refreshed, refreshErr := a.sandboxes.ReconcileImages(ctx, now)
			if err := errors.Join(reapErr, refreshErr); err != nil && a.audit != nil {
				_ = a.audit.Append(logstore.Event{At: now.UTC(), Type: "sandbox.reconcile_failed", Details: map[string]any{"images_refreshed": len(refreshed)}, Error: journal.BoundDiagnostic(err.Error())})
			}
		}
	}
}

func (a *application) runAutoUpdateLoop(ctx context.Context, ticks <-chan time.Time) {
	lastUpdateCheck := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticks:
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

func capabilityManifest(state model.ManagerState) (release.Manifest, bool) {
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

func (a *application) reconcileCapabilities(ctx context.Context) error {
	err := a.reconcileCapabilitiesAttempt(ctx)
	if driver.IsInsufficientCapacity(err) {
		if reclaimErr := a.reconcileMaintenance(ctx); reclaimErr != nil {
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
	manifest, ready := capabilityManifest(a.state.State())
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

// Retention is owned by the transaction coordinator and runs only after gate
// settlement, retaining current/previous artifacts and linked rollback data.
func (a *application) reconcileMaintenance(ctx context.Context) error {
	return a.operations.Retain(ctx)
}

func autoUpdateDue(last, now time.Time, interval time.Duration) bool {
	if interval <= 0 {
		interval = time.Minute
	}
	return !now.Before(last.Add(interval))
}
func autoUpdateIdempotencyKey(url, target string, now time.Time) string {
	return "auto-" + stableKey(url, target, now.UTC().Format("2006010215"))
}

func (a *application) autoUpdate(ctx context.Context) {
	cfg := a.configs.Config()
	if !cfg.UpdateEnabled || cfg.ReleaseURL == "" {
		return
	}

	a.autoUpdateMu.Lock()
	defer a.autoUpdateMu.Unlock()

	state := a.state.State()
	if state.ActiveOperationID != "" || state.Current == nil {
		return
	}
	checkCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	manifest, modified, err := a.operations.CheckIfChanged(checkCtx, cfg.ReleaseURL)
	cancel()
	if err != nil {
		a.recordAutoUpdateFailure("auto_update.check_failed", cfg, err)
		return
	}
	state = a.state.State()
	if modified && manifest.ID() != a.pendingAutoUpdate.targetID {
		a.pendingAutoUpdate = pendingAutoUpdate{targetID: manifest.ID()}
	}
	a.reconcilePendingAutoUpdate(state)
	if a.pendingAutoUpdate.targetID == "" || a.pendingAutoUpdate.operationID != "" {
		return
	}

	fresh := a.state.State()
	if fresh.ActiveOperationID != "" || fresh.FinalizePendingOperationID != "" || fresh.Current == nil {
		return
	}
	if fresh.Current.ID == a.pendingAutoUpdate.targetID {
		a.pendingAutoUpdate = pendingAutoUpdate{}
		return
	}
	op, _, startErr := a.operations.Start(model.OperationRequest{
		Kind:               model.OperationUpdate,
		IdempotencyKey:     autoUpdateIdempotencyKey(cfg.ReleaseURL, a.pendingAutoUpdate.targetID, time.Now()),
		ExpectedGeneration: fresh.Generation,
		ManifestURL:        cfg.ReleaseURL,
	})
	if startErr != nil {
		a.recordAutoUpdateFailure("auto_update.start_failed", cfg, startErr)
		return
	}
	a.pendingAutoUpdate.operationID = op.ID
}

func (a *application) recordAutoUpdateFailure(eventType string, cfg config.Config, err error) {
	if a.audit == nil {
		return
	}
	// net/http includes the request URL (including credentials) in errors.
	// Keep the transport cause, not that URL, in the retained audit.
	var requestError *url.Error
	for errors.As(err, &requestError) {
		err = requestError.Err
	}
	diagnostic := err.Error()
	secrets := []string{cfg.ReleaseURL, cfg.InternalToken}
	if a.api != nil {
		secrets = append(secrets, a.api.ControlToken, a.api.ExecutorToken)
	}
	for _, secret := range secrets {
		if secret != "" {
			diagnostic = strings.ReplaceAll(diagnostic, secret, "[redacted]")
		}
	}
	_ = a.audit.Append(logstore.Event{
		At:    time.Now().UTC(),
		Type:  eventType,
		Error: journal.BoundDiagnostic(diagnostic),
	})
}

func (a *application) reconcilePendingAutoUpdate(state model.ManagerState) {
	pending := a.pendingAutoUpdate
	if pending.targetID == "" {
		return
	}
	if state.ActiveOperationID == "" && state.FinalizePendingOperationID == "" &&
		state.Current != nil && state.Current.ID == pending.targetID {
		a.pendingAutoUpdate = pendingAutoUpdate{}
		return
	}
	if pending.operationID == "" {
		return
	}
	op, err := a.state.Operation(pending.operationID)
	if err != nil || !op.Finalized {
		return
	}
	switch op.Status {
	case model.OperationFailed:
		if op.Retryable {
			a.pendingAutoUpdate.operationID = ""
		} else {
			a.pendingAutoUpdate = pendingAutoUpdate{}
		}
	case model.OperationSucceeded:
		// A committed operation normally matched Current above. If it did not,
		// retain the accepted target but do not duplicate a successful attempt;
		// a later manifest response can supersede it.
	default:
		return
	}
}

type gatewayController struct {
	app            *application
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
}

func newGatewayController(app *application) *gatewayController { return &gatewayController{app: app} }
func (g *gatewayController) Run() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for range ticker.C {
		state := g.app.state.State()
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
	trusted, err := config.TrustedIngressPrefixes(cfg.TrustedIngressCIDRs)
	if err != nil {
		return false, nil, err
	}
	if g.listener == nil {
		listener, listenErr := gateway.Listener(g.app.config.GatewayAddress)
		if listenErr != nil {
			return false, nil, listenErr
		}
		handler, handlerErr := gateway.NewHandlerWithAccess(identity.CompileTimeActiveProfile(), g.app.state, g.app.config.PlatformURL, gateway.AccessPolicy{TrustedIngressPrefixes: trusted})
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
	handler, err := gateway.NewHandlerWithAccess(identity.CompileTimeActiveProfile(), g.app.state, g.app.config.PlatformURL, access)
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
	cfg, err := load(configPath)
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
func waitForManager(client control.Client) error {
	deadline := time.Now().Add(2 * time.Minute)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		// Socket/status availability alone does not prove launcher commitment.
		err := client.Do(ctx, http.MethodGet, "/v1/ready", nil, nil)
		cancel()
		if err == nil {
			return nil
		}
		var responseErr *control.HTTPError
		starting := errors.As(err, &responseErr) && responseErr.Status == http.StatusServiceUnavailable
		if !starting && !control.IsUnavailable(err) {
			return err
		}
		if time.Now().After(deadline) {
			return err
		}
		time.Sleep(200 * time.Millisecond)
	}
}
func installCommand(arguments []string) error {
	set, path := commonFlags("install")
	manifestURL := set.String("release-manifest-url", "", "release manifest URL")
	if err := set.Parse(arguments); err != nil {
		return err
	}
	client, cfg, err := managerClient(*path)
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
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	return awaitOperationContext(ctx, client, id)
}

func awaitOperationContext(ctx context.Context, client control.Client, id string) error {
	delay := 500 * time.Millisecond
	for {
		var op model.Operation
		err := client.Do(ctx, http.MethodGet, "/v1/operations/"+id, nil, &op)
		if ctx.Err() != nil {
			return fmt.Errorf("waiting for operation %s: %w", id, ctx.Err())
		}
		if err != nil {
			// Only the read is replayed: a child swap must never resubmit the
			// mutation. Socket interruptions and the selected child's pending
			// startup proof are transient; other HTTP failures are deterministic.
			var responseErr *control.HTTPError
			starting := errors.As(err, &responseErr) && responseErr.Status == http.StatusServiceUnavailable &&
				strings.TrimSpace(responseErr.Message) == "launcher startup proof pending"
			if !starting && !errors.Is(err, syscall.ECONNREFUSED) && !errors.Is(err, syscall.ECONNRESET) &&
				!errors.Is(err, os.ErrNotExist) && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
				return err
			}
		} else {
			switch op.Status {
			case model.OperationSucceeded:
				return nil
			case model.OperationFailed:
				return errors.New(op.Error)
			}
			delay = 500 * time.Millisecond
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return fmt.Errorf("waiting for operation %s: %w", id, ctx.Err())
		case <-timer.C:
		}
		if err != nil && delay < 4*time.Second {
			delay *= 2
		}
	}
}

func simpleGetCommand(name string, arguments []string, pathValue string) error {
	set, path := commonFlags(name)
	if err := set.Parse(arguments); err != nil {
		return err
	}
	client, _, err := managerClient(*path)
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
	set, path := commonFlags("check")
	url := set.String("release-manifest-url", "", "override manifest URL")
	if err := set.Parse(arguments); err != nil {
		return err
	}
	client, _, err := managerClient(*path)
	if err != nil {
		return err
	}
	value, err := requestReleaseCheck(client, *url, stableKey("check", *url, time.Now().UTC().Format("200601021504")))
	if err != nil {
		return err
	}
	return printJSON(value)
}

type releaseCheckResponse struct {
	Manifest release.Manifest `json:"manifest"`
	Reused   bool             `json:"reused"`
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
	set, path := commonFlags(kind)
	url := set.String("release-manifest-url", "", "override manifest URL")
	if err := set.Parse(arguments); err != nil {
		return err
	}
	client, _, err := managerClient(*path)
	if err != nil {
		return err
	}
	if kind == "update" {
		if _, err := requestReleaseCheck(client, *url, stableKey("manual-update-check", *url, time.Now().UTC().Format("200601021504"))); err != nil {
			return fmt.Errorf("check release before update: %w", err)
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
	set, path := commonFlags("logs")
	service := set.String("service", "", "Compose service")
	tail := set.Int("tail", 200, "line count")
	if err := set.Parse(arguments); err != nil {
		return err
	}
	client, _, err := managerClient(*path)
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
