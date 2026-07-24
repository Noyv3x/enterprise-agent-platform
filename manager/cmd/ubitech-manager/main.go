package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
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
	"github.com/ubitech/agent-platform/manager/internal/migration"
	"github.com/ubitech/agent-platform/manager/internal/model"
	"github.com/ubitech/agent-platform/manager/internal/operation"
	"github.com/ubitech/agent-platform/manager/internal/release"
	"github.com/ubitech/agent-platform/manager/internal/sandbox"
	"github.com/ubitech/agent-platform/manager/internal/selfupdate"
	"github.com/ubitech/agent-platform/manager/internal/snapshot"
)

var version = "development"
var errTemporary = errors.New("operation is queued")

type application struct {
	config     config.Config
	configs    *config.Manager
	state      *journal.Store
	docker     *driver.DockerCLI
	operations *operation.Orchestrator
	sandboxes  *sandbox.Manager
	legacy     *migration.Service
	selfUpdate *selfupdate.Manager
	processes  *executor.ProcessManager
	api        *control.API
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
	default:
		usage()
		return 64
	}
	if err == nil {
		return 0
	}
	if errors.Is(err, errTemporary) {
		fmt.Fprintln(os.Stderr, "install is queued; the existing source service remains online")
		return 75
	}
	fmt.Fprintln(os.Stderr, err)
	return 1
}
func usage() {
	fmt.Fprintln(os.Stderr, "usage: ubitech-manager <serve|preflight|install|status|check|update|restart|rollback|repair|logs|version> [options]")
}

func commonFlags(name string) (*flag.FlagSet, *string) {
	set := flag.NewFlagSet(name, flag.ContinueOnError)
	path := set.String("config", "", "manager.toml path")
	return set, path
}
func load(path string) (config.Config, error) { return config.Load(path) }

func build(path string) (*application, error) {
	cfg, err := load(path)
	if err != nil {
		return nil, err
	}
	docker := &driver.DockerCLI{Binary: cfg.DockerBinary, ComposeFile: cfg.ComposeFile, ComposeProject: cfg.ComposeProject, GenerationDir: filepath.Join(cfg.StateDir, "releases"), DataRoot: cfg.DataRoot, StateDir: cfg.StateDir, GatewayAddress: cfg.GatewayAddress, PlatformBind: "127.0.0.1:18080", CoreNetwork: cfg.SandboxNetwork, LogMaxSize: dockerLogSize(cfg.LogMaxBytes), LogMaxFiles: cfg.LogBackups, UID: os.Getuid(), GID: os.Getgid(), Runner: driver.CommandRunner{MaxOutputBytes: cfg.CommandMaxBytes}}
	if err := docker.EnsureHostLayout(); err != nil {
		return nil, err
	}
	controlTokenPath := cfg.InternalTokenFile
	if controlTokenPath == "" {
		controlTokenPath = filepath.Join(cfg.StateDir, "secrets", "manager-token")
	}
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
	legacy := &migration.Service{StatePath: filepath.Join(cfg.StateDir, "migration.json"), DestinationData: dataDir, BackupRoot: filepath.Join(cfg.DataRoot, "backups"), QuarantineRoot: filepath.Join(cfg.DataRoot, "quarantine"), LegacyService: "enterprise-agent-platform.service"}
	snapshots := snapshot.Store{DataDir: dataDir, BackupDir: filepath.Join(cfg.DataRoot, "backups"), Retention: time.Duration(contract.MigrationBackupRetentionSeconds) * time.Second}
	legacyGateURL := cfg.LegacyPlatformGateURL
	if legacyGateURL == "" {
		legacyGateURL = cfg.PlatformGateURL
	}
	selfUpdater := &selfupdate.Manager{Root: filepath.Join(cfg.StateDir, "manager-binaries"), StatePath: filepath.Join(cfg.StateDir, "manager-binaries.json"), InstallPath: managerInstallPath(), SocketPath: cfg.SocketPath, ControlTokenFile: controlTokenPath, UnitName: "ubitech-agent-manager.service", RunningVersion: version}
	sourceExpectations := config.SourceMigrationExpectations{
		DataRoot: cfg.DataRoot, GatewayAddress: cfg.GatewayAddress,
		ReleaseManifestURL: cfg.ReleaseURL, ReleaseChannel: cfg.ReleaseChannel,
		LegacyPlatformURL: cfg.LegacyPlatformGateURL, ControlSocketPath: cfg.SocketPath,
	}
	legacy.PreCutoverCheck = func(ctx context.Context, _ migration.Plan) error {
		current, err := config.Load(cfg.ConfigPath)
		if err != nil {
			return fmt.Errorf("reload Manager configuration: %w", err)
		}
		if err := current.ValidateSourceMigration(sourceExpectations); err != nil {
			return err
		}
		return selfUpdater.ProbeTransientUnit(ctx)
	}
	ops := &operation.Orchestrator{Store: state, Engine: docker, Gate: operation.HTTPGate{BaseURL: cfg.PlatformGateURL, Token: cfg.InternalToken}, LegacyGate: operation.HTTPGate{BaseURL: legacyGateURL, Token: cfg.InternalToken}, Snapshots: snapshots, Legacy: legacy, SelfUpdate: selfUpdater, ReleasesDir: filepath.Join(cfg.StateDir, "releases"), ManifestURL: cfg.ReleaseURL, Channel: cfg.ReleaseChannel, Log: audit, PollInterval: cfg.UpdateInterval}
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
	ops.LocalUpdateBlockers = processes.UpdateBlockers
	execution := &executor.Service{Audits: executor.AuditStore{Dir: filepath.Join(cfg.StateDir, "control"), Log: audit}, Processes: processes, Files: executor.FileService{Sandboxes: sandboxes, MaxBytes: 10 << 20}}
	configs := config.NewManager(cfg)
	api := &control.API{Store: state, Operations: ops, Engine: docker, Executor: execution, Config: configs, AuditLog: audit, Legacy: legacy, ControlToken: controlToken, ExecutorToken: executorToken}
	return &application{config: cfg, configs: configs, state: state, docker: docker, operations: ops, sandboxes: sandboxes, legacy: legacy, selfUpdate: selfUpdater, processes: processes, api: api}, nil
}

func preflightCommand(arguments []string) error {
	set, path := commonFlags("preflight")
	verifySourceMigration := set.Bool("verify-source-migration-config", false, "compare effective Manager config with source bridge inputs")
	probeTransientUnit := set.Bool("probe-user-systemd-transient", false, "verify user-systemd transient watchdog support")
	expected := config.SourceMigrationExpectations{}
	set.StringVar(&expected.DataRoot, "expect-data-root", "", "expected source migration data root")
	set.StringVar(&expected.GatewayAddress, "expect-listen", "", "expected source migration gateway listener")
	set.StringVar(&expected.ReleaseManifestURL, "expect-release-manifest-url", "", "expected persistent release catalog")
	set.StringVar(&expected.ReleaseChannel, "expect-release-channel", "", "expected release channel")
	set.StringVar(&expected.LegacyPlatformURL, "expect-legacy-platform-url", "", "expected legacy Platform gate URL")
	set.StringVar(&expected.ControlSocketPath, "expect-control-socket", "", "expected shared control and executor socket")
	if err := set.Parse(arguments); err != nil {
		return err
	}
	if err := validatePreflightConfig(*path, *verifySourceMigration, expected); err != nil {
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

func validatePreflightConfig(path string, verify bool, expected config.SourceMigrationExpectations) error {
	provided := expected.DataRoot != "" || expected.GatewayAddress != "" || expected.ReleaseManifestURL != "" || expected.ReleaseChannel != "" || expected.LegacyPlatformURL != "" || expected.ControlSocketPath != ""
	if provided && !verify {
		return errors.New("source migration expectations require --verify-source-migration-config")
	}
	if !verify {
		return nil
	}
	cfg, err := load(path)
	if err != nil {
		return err
	}
	return cfg.ValidateSourceMigration(expected)
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
	app.legacy.ReleaseGateway = gatewayControl.Stop
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
	// Recovery may now run post-commit hooks such as admission release and
	// irreversible legacy cleanup. On a self-update restart this is deliberately
	// after the old-binary watchdog promoted the healthy candidate to Current.
	if err := app.operations.Recover(context.Background()); err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
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

func (a *application) background(ctx context.Context) {
	sandboxTicker := time.NewTicker(time.Minute)
	updateTicker := time.NewTicker(time.Second)
	lastUpdateCheck := time.Now()
	defer sandboxTicker.Stop()
	defer updateTicker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-sandboxTicker.C:
			_, _ = a.sandboxes.Reap(ctx, now)
			_ = a.legacy.Prune(now, time.Duration(contract.MigrationBackupRetentionSeconds)*time.Second)
			if current := a.state.State().Current; current != nil && current.Images["agent-sandbox"] != "" {
				a.sandboxes.SetImage(current.Images["agent-sandbox"])
			}
		case now := <-updateTicker.C:
			state := a.state.State()
			if state.FinalizePendingOperationID != "" || (state.ActiveOperationID != "" && state.Phase == model.PhaseRollingBack && state.PublicState == model.StateFailed) {
				_ = a.operations.Recover(ctx)
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
		wanted := state.Current != nil
		if state.Maintenance && !wanted {
			plan, err := g.app.legacy.Plan()
			wanted = err != nil || plan.OldServiceStopped
		}
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
	tokenPath := cfg.InternalTokenFile
	if tokenPath == "" {
		tokenPath = filepath.Join(cfg.StateDir, "secrets", "manager-token")
	}
	token, err := driver.ReadOwnerSecret(tokenPath)
	if err != nil {
		return control.Client{}, config.Config{}, err
	}
	return control.Client{SocketPath: cfg.SocketPath, Token: token, Timeout: 35 * time.Second}, cfg, nil
}
func waitForManager(client control.Client) error {
	deadline := time.Now().Add(10 * time.Second)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		var response any
		err := client.Do(ctx, http.MethodGet, "/v1/status", nil, &response)
		cancel()
		if err == nil {
			return nil
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
	legacyRoot := set.String("legacy-root", "", "legacy source checkout")
	legacyData := set.String("legacy-data", "", "legacy data directory")
	legacyService := set.String("legacy-service", "", "legacy user-systemd service")
	expectedSourceCommit := set.String("expected-source-commit", "", "required source commit for a legacy migration")
	if err := set.Parse(arguments); err != nil {
		return err
	}
	client, cfg, err := managerClient(*path)
	if err != nil {
		return err
	}
	if err := waitForManager(client); err != nil {
		if *legacyRoot != "" && control.IsUnavailable(err) {
			return fmt.Errorf("%w: Manager is temporarily unavailable: %v", errTemporary, err)
		}
		return err
	}
	if *manifestURL == "" {
		*manifestURL = cfg.ReleaseURL
	}
	if *manifestURL == "" {
		return errors.New("release manifest URL is required")
	}
	if *legacyRoot != "" {
		if !validExpectedSourceCommit(*expectedSourceCommit) {
			return errors.New("--expected-source-commit must be a 40-character lowercase Git commit for source migration")
		}
		var plan any
		if err := client.Do(context.Background(), http.MethodPost, "/v1/migrations/legacy", map[string]any{"legacy_root": *legacyRoot, "legacy_data": *legacyData, "legacy_service": *legacyService, "expected_source_commit": *expectedSourceCommit}, &plan); err != nil {
			if control.IsUnavailable(err) {
				return fmt.Errorf("%w: Manager is temporarily unavailable: %v", errTemporary, err)
			}
			return err
		}
	}
	key := stableKey("install", *manifestURL, *legacyRoot, *legacyData, *legacyService, *expectedSourceCommit)
	var response struct {
		Operation model.Operation `json:"operation"`
		Reused    bool            `json:"reused"`
	}
	if err := client.Do(context.Background(), http.MethodPost, "/v1/operations", map[string]any{"operation": "install", "idempotency_key": key, "manifest_url": *manifestURL, "expected_source_commit": *expectedSourceCommit}, &response); err != nil {
		if *legacyRoot != "" && control.IsUnavailable(err) {
			return fmt.Errorf("%w: Manager is temporarily unavailable: %v", errTemporary, err)
		}
		return err
	}
	timeout := time.Duration(0)
	if *legacyRoot != "" {
		timeout = 3 * time.Second
	}
	return awaitOperation(client, response.Operation.ID, timeout, *legacyRoot != "")
}

func validExpectedSourceCommit(value string) bool {
	if len(value) != 40 {
		return false
	}
	for _, r := range value {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			return false
		}
	}
	return true
}
func awaitOperation(client control.Client, id string, timeout time.Duration, queueRetryableFailure bool) error {
	started := time.Now()
	for {
		var op model.Operation
		if err := client.Do(context.Background(), http.MethodGet, "/v1/operations/"+id, nil, &op); err != nil {
			if queueRetryableFailure && control.IsUnavailable(err) {
				return fmt.Errorf("%w: Manager is temporarily unavailable: %v", errTemporary, err)
			}
			return err
		}
		switch op.Status {
		case model.OperationSucceeded:
			return nil
		case model.OperationFailed:
			if queueRetryableFailure && op.Retryable {
				return fmt.Errorf("%w: %s", errTemporary, op.Error)
			}
			return errors.New(op.Error)
		}
		if timeout > 0 && time.Since(started) >= timeout {
			return errTemporary
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
	return awaitOperation(client, response.Operation.ID, 0, false)
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
func dockerLogSize(bytes int64) string {
	mib := bytes / (1 << 20)
	if mib < 1 {
		mib = 1
	}
	return fmt.Sprintf("%dm", mib)
}
