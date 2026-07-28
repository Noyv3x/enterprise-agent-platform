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
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/config"
	"github.com/ubitech/agent-platform/manager/internal/contract"
	"github.com/ubitech/agent-platform/manager/internal/control"
	"github.com/ubitech/agent-platform/manager/internal/driver"
	"github.com/ubitech/agent-platform/manager/internal/executor"
	"github.com/ubitech/agent-platform/manager/internal/gateway"
	"github.com/ubitech/agent-platform/manager/internal/journal"
	"github.com/ubitech/agent-platform/manager/internal/logstore"
	"github.com/ubitech/agent-platform/manager/internal/model"
	"github.com/ubitech/agent-platform/manager/internal/operation"
	"github.com/ubitech/agent-platform/manager/internal/release"
	"github.com/ubitech/agent-platform/manager/internal/sandbox"
	"github.com/ubitech/agent-platform/manager/internal/selfupdate"
	"github.com/ubitech/agent-platform/manager/internal/snapshot"
)

var version = "development"

type application struct {
	config       config.Config
	configs      *config.Manager
	state        *journal.Store
	docker       *driver.DockerCLI
	operations   *operation.Orchestrator
	sandboxes    *sandbox.Manager
	selfUpdate   *selfupdate.Manager
	processes    *executor.ProcessManager
	audit        *logstore.Store
	api          *control.API
	fixedStackMu sync.Locker
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
	case "serve":
		err = serveCommand(arguments[1:])
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
	case "version", "--version", "-version":
		fmt.Println(version)
		return 0
	case "self-update-watchdog":
		err = selfUpdateWatchdogCommand(arguments[1:])
	case "recover-current":
		err = recoverCurrentCommand(arguments[1:])
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
	fmt.Fprintln(os.Stderr, "usage: ubitech-manager <serve|preflight|install|status|check|update|restart|rollback|repair|recover-current|logs|version> [options]")
}

func commonFlags(name string) (*flag.FlagSet, *string) {
	set := flag.NewFlagSet(name, flag.ContinueOnError)
	path := set.String("config", "", "manager.toml path")
	return set, path
}
func load(path string) (config.Config, error) { return config.Load(path) }

func recoverCurrentCommand(arguments []string) error {
	set, path := commonFlags("recover-current")
	expectedSHA := set.String("expected-sha256", "", "expected SHA-256 of this recovery Manager executable")
	confirmed := set.Bool("yes", false, "confirm the controlled Manager replacement")
	if err := set.Parse(arguments); err != nil {
		return err
	}
	if !*confirmed {
		return errors.New("recover-current requires explicit --yes confirmation")
	}
	if *path == "" {
		return errors.New("recover-current requires an explicit --config path")
	}
	if *expectedSHA == "" {
		return errors.New("recover-current requires --expected-sha256")
	}
	if err := validateRecoveryConfigFile(*path); err != nil {
		return err
	}
	cfg, err := load(*path)
	if err != nil {
		return err
	}
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve recovery Manager executable: %w", err)
	}
	selfUpdater := &selfupdate.Manager{
		Root:             filepath.Join(cfg.StateDir, "manager-binaries"),
		StatePath:        filepath.Join(cfg.StateDir, "manager-binaries.json"),
		InstallPath:      managerInstallPath(),
		SocketPath:       cfg.SocketPath,
		ControlTokenFile: cfg.ControlTokenFile(),
		UnitName:         "ubitech-agent-manager.service",
		RunningVersion:   version,
	}
	timeout := cfg.HealthTimeout
	if timeout < 30*time.Second {
		timeout = 2 * time.Minute
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	if err := selfUpdater.RecoverCurrent(
		ctx,
		filepath.Clean(executable),
		filepath.Join(cfg.StateDir, "state.json"),
		*expectedSHA,
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

func build(path string) (*application, error) {
	cfg, err := load(path)
	if err != nil {
		return nil, err
	}
	docker := &driver.DockerCLI{Binary: cfg.DockerBinary, ComposeFile: cfg.ComposeFile, ComposeProject: cfg.ComposeProject, GenerationDir: filepath.Join(cfg.StateDir, "releases"), DataRoot: cfg.DataRoot, StateDir: cfg.StateDir, GatewayAddress: cfg.GatewayAddress, PlatformBind: "127.0.0.1:18080", CoreNetwork: cfg.SandboxNetwork, LogMaxSize: dockerLogSize(cfg.LogMaxBytes), LogMaxFiles: cfg.LogBackups, UID: os.Getuid(), GID: os.Getgid(), Runner: driver.CommandRunner{MaxOutputBytes: cfg.CommandMaxBytes}}
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
	state, err := journal.Open(cfg.StateDir, time.Now())
	if err != nil {
		return nil, err
	}
	audit := logstore.New(filepath.Join(cfg.StateDir, "logs", "audit.jsonl"), cfg.LogMaxBytes, cfg.LogBackups)
	dataDir := cfg.PlatformDataDir()
	snapshots := snapshot.Store{DataDir: dataDir, BackupDir: filepath.Join(cfg.DataRoot, "backups"), Retention: time.Duration(contract.MigrationBackupRetentionSeconds) * time.Second}
	selfUpdater := &selfupdate.Manager{Root: filepath.Join(cfg.StateDir, "manager-binaries"), StatePath: filepath.Join(cfg.StateDir, "manager-binaries.json"), InstallPath: managerInstallPath(), SocketPath: cfg.SocketPath, ControlTokenFile: controlTokenPath, UnitName: "ubitech-agent-manager.service", RunningVersion: version}
	fixedStackMu := &sync.Mutex{}
	ops := &operation.Orchestrator{Store: state, Engine: docker, Gate: operation.HTTPGate{BaseURL: cfg.PlatformGateURL, Token: cfg.InternalToken}, Snapshots: snapshots, SelfUpdate: selfUpdater, ReleasesDir: filepath.Join(cfg.StateDir, "releases"), ManifestURL: cfg.ReleaseURL, Channel: cfg.ReleaseChannel, Log: audit, PollInterval: cfg.UpdateInterval, FixedStackMu: fixedStackMu}
	selfUpdater.Client = ops.ReleaseClient
	image := cfg.SandboxImage
	if current := state.State().Current; current != nil && current.Images["agent-sandbox"] != "" {
		image = current.Images["agent-sandbox"]
	}
	sandboxes, err := sandbox.Open(docker, dataDir, filepath.Join(cfg.StateDir, "sandboxes.json"), image, cfg.SandboxNetwork, cfg.SandboxIdle)
	if err != nil {
		return nil, err
	}
	ops.OnCommit = func(manifest release.Manifest) { sandboxes.SetImage(manifest.Images["agent-sandbox"]) }
	processes := executor.NewProcessManager(docker, sandboxes, cfg.CommandMaxBytes)
	ops.LocalActiveProcesses = processes.ActiveBackgroundCount
	execution := &executor.Service{Audits: executor.AuditStore{Dir: filepath.Join(cfg.StateDir, "control"), Log: audit}, Processes: processes, Files: executor.FileService{Sandboxes: sandboxes, MaxBytes: 10 << 20}}
	configs := config.NewManager(cfg)
	runningSHA, err := runningExecutableSHA256()
	if err != nil {
		return nil, fmt.Errorf("identify running Manager executable: %w", err)
	}
	api := &control.API{Store: state, Operations: ops, Engine: docker, Executor: execution, Config: configs, AuditLog: audit, ControlToken: controlToken, ExecutorToken: executorToken, ManagerVersion: version, ManagerSHA256: runningSHA}
	return &application{config: cfg, configs: configs, state: state, docker: docker, operations: ops, sandboxes: sandboxes, selfUpdate: selfUpdater, processes: processes, audit: audit, api: api, fixedStackMu: fixedStackMu}, nil
}

func preflightCommand(arguments []string) error {
	set, path := commonFlags("preflight")
	probeTransientUnit := set.Bool("probe-user-systemd-transient", false, "verify user-systemd transient watchdog support")
	if err := set.Parse(arguments); err != nil {
		return err
	}
	app, err := build(*path)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	if *probeTransientUnit {
		if err := app.selfUpdate.ProbeTransientUnit(ctx); err != nil {
			return err
		}
	}
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
	app, err := build(*path)
	if err != nil {
		return err
	}
	pendingActivation, err := app.selfUpdate.PendingActivation()
	if err != nil {
		return err
	}
	listener, err := control.Listen(app.config.SocketPath)
	if err != nil {
		return err
	}
	defer func() { _ = listener.Close(); _ = os.Remove(app.config.SocketPath) }()
	server := &http.Server{Handler: app.api, ReadHeaderTimeout: 15 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 32 << 10}
	serveErrors := make(chan error, 1)
	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErrors <- err
		}
	}()
	gatewayControl := newGatewayController(app)
	app.operations.PublicProbe = gatewayControl.Health
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
	}
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

func managerInstallPath() string {
	if root := os.Getenv("XDG_BIN_HOME"); root != "" {
		return filepath.Join(root, "ubitech-manager")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".local", "bin", "ubitech-manager")
}

func selfUpdateWatchdogCommand(arguments []string) error {
	set := flag.NewFlagSet("self-update-watchdog", flag.ContinueOnError)
	plan := set.String("plan", "", "activation plan")
	if err := set.Parse(arguments); err != nil {
		return err
	}
	if *plan == "" {
		return errors.New("activation plan is required")
	}
	return selfupdate.RunWatchdog(context.Background(), *plan, nil)
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
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-sandboxTicker.C:
			_, _ = a.sandboxes.Reap(ctx, now)
			if current := a.state.State().Current; current != nil && current.Images["agent-sandbox"] != "" {
				a.sandboxes.SetImage(current.Images["agent-sandbox"])
			}
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

func firecrawlManifest(state model.ManagerState) (release.Manifest, bool) {
	if state.Current == nil || state.ActiveOperationID != "" || state.FinalizePendingOperationID != "" || state.Maintenance {
		return release.Manifest{}, false
	}
	images := make(map[string]string, len(state.Current.Images))
	for name, image := range state.Current.Images {
		images[name] = image
	}
	return release.Manifest{SourceCommit: state.Current.ID, Images: images}, true
}

func (a *application) reconcileFirecrawl(ctx context.Context) error {
	if a.fixedStackMu != nil {
		a.fixedStackMu.Lock()
		defer a.fixedStackMu.Unlock()
	}
	manifest, ready := firecrawlManifest(a.state.State())
	if !ready {
		return nil
	}
	reconcileCtx, cancel := context.WithTimeout(ctx, 25*time.Minute)
	defer cancel()
	err := a.docker.ReconcileFirecrawl(reconcileCtx, manifest)
	if err != nil && a.audit != nil {
		_ = a.audit.Append(logstore.Event{
			At:      time.Now().UTC(),
			Type:    "firecrawl.reconcile_failed",
			Details: map[string]any{"generation": manifest.ID()},
			Error:   journal.BoundDiagnostic(err.Error()),
		})
	}
	return err
}

func (a *application) reconcileCapabilities(ctx context.Context) error {
	if a.fixedStackMu != nil {
		a.fixedStackMu.Lock()
		defer a.fixedStackMu.Unlock()
	}
	manifest, ready := firecrawlManifest(a.state.State())
	if !ready {
		return nil
	}
	reconcileCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	err := a.docker.ReconcileCapabilities(reconcileCtx, manifest)
	if err != nil && a.audit != nil {
		_ = a.audit.Append(logstore.Event{
			At:      time.Now().UTC(),
			Type:    "capability.reconcile_failed",
			Details: map[string]any{"generation": manifest.ID()},
			Error:   journal.BoundDiagnostic(err.Error()),
		})
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
	fresh := a.state.State()
	_, _, _ = a.operations.Start(model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: "auto-" + manifest.ID() + "-" + time.Now().UTC().Format("2006010215"), ExpectedGeneration: fresh.Generation, ManifestURL: cfg.ReleaseURL})
}

type gatewayController struct {
	app      *application
	mu       sync.Mutex
	server   *http.Server
	listener net.Listener
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
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.listener != nil {
		return nil
	}
	listener, err := gateway.Listener(g.app.config.GatewayAddress)
	if err != nil {
		return err
	}
	handler, err := gateway.NewHandler(g.app.state, g.app.config.PlatformURL)
	if err != nil {
		_ = listener.Close()
		return err
	}
	g.listener = listener
	g.server = gateway.Server(listener, handler)
	return nil
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
	defer g.mu.Unlock()
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
}

func managerClient(configPath string) (control.Client, config.Config, error) {
	cfg, err := load(configPath)
	if err != nil {
		return control.Client{}, config.Config{}, err
	}
	tokenPath := cfg.ControlTokenFile()
	token, err := driver.ReadOwnerSecret(tokenPath)
	if err != nil {
		return control.Client{}, config.Config{}, err
	}
	return control.Client{SocketPath: cfg.SocketPath, Token: token, Timeout: 35 * time.Second}, cfg, nil
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
	var value any
	body := map[string]any{"idempotency_key": stableKey("check", *url, time.Now().UTC().Format("200601021504"))}
	if *url != "" {
		body["manifest_url"] = *url
	}
	if err := client.Do(context.Background(), http.MethodPost, "/v1/check", body, &value); err != nil {
		return err
	}
	return printJSON(value)
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
