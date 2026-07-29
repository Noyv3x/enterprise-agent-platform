package driver

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/atomicfile"
	"github.com/ubitech/agent-platform/manager/internal/contract"
	"github.com/ubitech/agent-platform/manager/internal/journal"
	"github.com/ubitech/agent-platform/manager/internal/release"
)

type Result struct {
	Stdout   string
	Stderr   string
	ExitCode int
}

type Runner interface {
	Run(ctx context.Context, name string, args []string, env []string) (Result, error)
}

// ActivityRunner exposes command output activity without requiring callers to
// retain or persist the command's raw output. Docker pull uses it to distinguish
// a slow transfer that is still making progress from a registry request that has
// gone silent. CommandRunner implements this interface; the narrower Runner
// interface remains useful for deterministic unit fakes.
type ActivityRunner interface {
	RunWithActivity(ctx context.Context, name string, args []string, env []string, activity func()) (Result, error)
}

type CommandRunner struct {
	MaxOutputBytes int64
}

func (r CommandRunner) Run(ctx context.Context, name string, args []string, env []string) (Result, error) {
	return r.run(ctx, name, args, env, nil)
}

func (r CommandRunner) RunWithActivity(ctx context.Context, name string, args []string, env []string, activity func()) (Result, error) {
	return r.run(ctx, name, args, env, activity)
}

func (r CommandRunner) run(ctx context.Context, name string, args []string, env []string, activity func()) (Result, error) {
	command := exec.CommandContext(ctx, name, args...)
	// Bound the post-cancellation reap window as well as inherited pipe cleanup.
	// This keeps a cancelled Docker CLI from retaining the Manager's operation
	// goroutine merely because a helper process kept a descriptor open.
	command.WaitDelay = 5 * time.Second
	if env != nil {
		command.Env = append(os.Environ(), env...)
	}
	limit := r.MaxOutputBytes
	if limit <= 0 {
		limit = 2 << 20
	}
	stdout, stderr := &limitedBuffer{limit: limit}, &limitedBuffer{limit: limit}
	if activity != nil {
		command.Stdout = activityWriter{Writer: stdout, Activity: activity}
		command.Stderr = activityWriter{Writer: stderr, Activity: activity}
	} else {
		command.Stdout, command.Stderr = stdout, stderr
	}
	err := command.Run()
	result := Result{Stdout: stdout.String(), Stderr: stderr.String()}
	if err == nil {
		return result, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		result.ExitCode = exitErr.ExitCode()
		return result, fmt.Errorf("%s exited with %d: %s", name, result.ExitCode, strings.TrimSpace(result.Stderr))
	}
	return result, fmt.Errorf("run %s: %w", name, err)
}

type activityWriter struct {
	io.Writer
	Activity func()
}

func (w activityWriter) Write(value []byte) (int, error) {
	if len(value) > 0 {
		w.Activity()
	}
	return w.Writer.Write(value)
}

type limitedBuffer struct {
	bytes.Buffer
	limit     int64
	truncated bool
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	original := len(p)
	remaining := b.limit - int64(b.Len())
	if remaining > 0 {
		if int64(len(p)) > remaining {
			_, _ = b.Buffer.Write(p[:remaining])
			b.truncated = true
		} else {
			_, _ = b.Buffer.Write(p)
		}
	} else {
		b.truncated = true
	}
	return original, nil
}
func (b *limitedBuffer) String() string {
	value := b.Buffer.String()
	if b.truncated {
		value += "\n[output truncated by ubitech-manager]\n"
	}
	return value
}

type SandboxSpec struct {
	ContainerName string
	AgentHash     string
	Image         string
	Network       string
	Workspace     string
	Home          string
	Environment   string
	Attachments   string
	UID           int
	GID           int
}

// SandboxEnsureResult describes the Docker state changed by one ensure call so
// callers can compensate precisely if their own persistence boundary fails.
type SandboxEnsureResult struct {
	Created    bool
	Started    bool
	WasRunning bool
}

type Engine interface {
	Preflight(context.Context) error
	Pull(context.Context, release.Manifest) error
	Prepare(context.Context, release.Manifest) error
	StopFixed(context.Context) error
	StartFixed(context.Context, release.Manifest) error
	Migrate(context.Context, release.Manifest) error
	Probe(context.Context, release.Manifest) error
	Logs(context.Context, string, int) (string, error)
	EnsureSandbox(context.Context, SandboxSpec) error
	StopSandbox(context.Context, string) error
	RemoveSandbox(context.Context, string) error
	SandboxRunning(context.Context, string) (bool, error)
	ExecArgs(SandboxSpec, string, string, []string) (string, []string)
}

type FixedServiceState struct {
	Status string `json:"status"`
}

type FixedServiceReporter interface {
	FixedServiceStatus(context.Context) map[string]FixedServiceState
}

// CandidateFailureDiagnoser is an optional Engine capability. Keeping it
// separate from Engine lets non-Docker test engines and alternate backends omit
// host-specific diagnostics while callers can still collect them when present.
type CandidateFailureDiagnoser interface {
	CandidateFailureDiagnostics(context.Context, release.Manifest) string
}

const (
	candidateDiagnosticMaxBytes = 48 << 10
	candidateLogsMaxBytes       = 32 << 10
	candidateHealthMaxBytes     = 12 << 10
	candidateDiagnosticTimeout  = 10 * time.Second
	firecrawlComposeWaitSeconds = 600
	defaultPullIdleTimeout      = 15 * time.Minute
	defaultPullAbsoluteTimeout  = 6 * time.Hour
	imageInspectTimeout         = 30 * time.Second
	pullDiagnosticMaxBytes      = 8 << 10
)

var coreUpdateImageNames = []string{"platform", "agent-runtime"}

var firecrawlHealthyServices = []string{
	"firecrawl-playwright",
	"firecrawl-redis",
	"firecrawl-rabbitmq",
	"firecrawl-postgres",
	"firecrawl-api",
}

var capabilityServices = []string{"camofox", "searxng"}

var candidateCredentialPatterns = []struct {
	expression  *regexp.Regexp
	replacement string
}{
	{regexp.MustCompile(`(?i)("[^"]*(api[_-]?key|access[_-]?key|token|password|passwd|secret|credential|private[_-]?key|session|signature|cookie)[^"]*"\s*:\s*)("[^"]*"|[^,}\s]+)`), `${1}"[redacted]"`},
	{regexp.MustCompile(`(?i)(\b[A-Z0-9_]*(API[_-]?KEY|ACCESS[_-]?KEY|TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIAL|PRIVATE[_-]?KEY|SESSION|SIGNATURE|COOKIE)\s*[:=]\s*)(Bearer[ \t]+)?("[^"]*"|'[^']*'|[^\s,;]+)`), `${1}${3}[redacted]`},
	{regexp.MustCompile(`(?i)(--(api-key|access-key|token|password|secret|credential|private-key|session|signature|cookie)(=|[ \t]+))("[^"]*"|'[^']*'|[^\s]+)`), `${1}[redacted]`},
	{regexp.MustCompile(`(?i)(\b(Authorization|Proxy-Authorization)\s*[:=]\s*)(Basic|Bearer)[ \t]+([^\s,;]+)`), `${1}${3} [redacted]`},
	{regexp.MustCompile(`(?i)(\b(Set-Cookie|Cookie)\s*:\s*)[^\r\n]+`), `${1}[redacted]`},
	{regexp.MustCompile(`(?s)(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----).*?(-----END [A-Z0-9 ]*PRIVATE KEY-----)`), `${1}\n[redacted]\n${2}`},
}

type DockerCLI struct {
	Runner              Runner
	Binary              string
	ComposeFile         string
	ComposeProject      string
	GenerationDir       string
	DataRoot            string
	StateDir            string
	GatewayAddress      string
	PlatformBind        string
	CoreNetwork         string
	LogMaxSize          string
	LogMaxFiles         int
	UID                 int
	GID                 int
	PullIdleTimeout     time.Duration
	PullAbsoluteTimeout time.Duration
}

func (d DockerCLI) runner() Runner {
	if d.Runner != nil {
		return d.Runner
	}
	return CommandRunner{}
}
func (d DockerCLI) binary() string {
	if d.Binary != "" {
		return d.Binary
	}
	return "docker"
}

func (d DockerCLI) Preflight(ctx context.Context) error {
	if err := d.EnsureHostLayout(); err != nil {
		return err
	}
	if _, err := d.runner().Run(ctx, d.binary(), []string{"version", "--format", "{{.Server.Version}}"}, nil); err != nil {
		return fmt.Errorf("Docker Engine is unavailable: %w", err)
	}
	if _, err := d.runner().Run(ctx, d.binary(), []string{"compose", "version", "--short"}, nil); err != nil {
		return fmt.Errorf("Docker Compose v2 is unavailable: %w", err)
	}
	if err := d.EnsureCoreNetwork(ctx); err != nil {
		return err
	}
	if d.ComposeFile != "" {
		if _, err := os.Stat(d.ComposeFile); err != nil {
			return fmt.Errorf("compose file: %w", err)
		}
	}
	return nil
}

func (d DockerCLI) Pull(ctx context.Context, manifest release.Manifest) error {
	for _, name := range coreUpdateImageNames {
		image := manifest.Images[name]
		if image == "" {
			return fmt.Errorf("core image %s is missing from the release manifest", name)
		}
		if err := d.ensureImage(ctx, name, image); err != nil {
			return err
		}
	}
	return nil
}

func (d DockerCLI) ensureImage(ctx context.Context, name, image string) error {
	present, err := d.imagePresent(ctx, name, image)
	if err != nil {
		return err
	}
	if present {
		return nil
	}
	return d.pullImage(ctx, name, image)
}

func (d DockerCLI) imagePresent(ctx context.Context, name, image string) (bool, error) {
	inspectCtx, cancel := context.WithTimeout(ctx, imageInspectTimeout)
	defer cancel()
	result, err := d.runner().Run(inspectCtx, d.binary(), []string{"image", "inspect", "--format", "{{json .RepoDigests}}", image}, nil)
	if err != nil {
		if inspectCtx.Err() != nil {
			return false, fmt.Errorf("inspect managed image %s (%s): %w", name, image, inspectCtx.Err())
		}
		if imageInspectMissing(result) {
			return false, nil
		}
		return false, fmt.Errorf("inspect managed image %s (%s): %w", name, image, err)
	}
	var digests []string
	if err := json.Unmarshal([]byte(strings.TrimSpace(result.Stdout)), &digests); err != nil {
		return false, fmt.Errorf("inspect managed image %s (%s): decode RepoDigests: %w", name, image, err)
	}
	for _, digest := range digests {
		if digest == image {
			return true, nil
		}
	}
	return false, nil
}

func imageInspectMissing(result Result) bool {
	if result.ExitCode != 1 {
		return false
	}
	diagnostic := strings.ToLower(result.Stderr + "\n" + result.Stdout)
	return strings.Contains(diagnostic, "no such image") || strings.Contains(diagnostic, "no such object")
}

type pullResult struct {
	result Result
	err    error
}

func (d DockerCLI) pullFailure(name, image string, outcome pullResult) error {
	diagnostic := d.redactCandidateDiagnostic(outcome.err.Error())
	diagnostic = journal.BoundDiagnosticWithLimit(diagnostic, pullDiagnosticMaxBytes)
	return fmt.Errorf("pull managed image %s (%s): %s", name, image, diagnostic)
}

func (d DockerCLI) pullImage(ctx context.Context, name, image string) error {
	idleTimeout := d.PullIdleTimeout
	if idleTimeout <= 0 {
		idleTimeout = defaultPullIdleTimeout
	}
	absoluteTimeout := d.PullAbsoluteTimeout
	if absoluteTimeout <= 0 {
		absoluteTimeout = defaultPullAbsoluteTimeout
	}
	if absoluteTimeout < idleTimeout {
		return fmt.Errorf("pull managed image %s (%s): absolute timeout %s is shorter than idle timeout %s", name, image, absoluteTimeout, idleTimeout)
	}

	pullCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	activity := make(chan struct{}, 1)
	notifyActivity := func() {
		select {
		case activity <- struct{}{}:
		default:
		}
	}
	completed := make(chan pullResult, 1)
	runner := d.runner()
	go func() {
		var result Result
		var err error
		if observed, ok := runner.(ActivityRunner); ok {
			result, err = observed.RunWithActivity(pullCtx, d.binary(), []string{"pull", image}, nil, notifyActivity)
		} else {
			result, err = runner.Run(pullCtx, d.binary(), []string{"pull", image}, nil)
		}
		completed <- pullResult{result: result, err: err}
	}()

	idleTimer := time.NewTimer(idleTimeout)
	absoluteTimer := time.NewTimer(absoluteTimeout)
	defer idleTimer.Stop()
	defer absoluteTimer.Stop()
	resetIdle := func() {
		if !idleTimer.Stop() {
			select {
			case <-idleTimer.C:
			default:
			}
		}
		idleTimer.Reset(idleTimeout)
	}
	waitAfterCancel := func() { <-completed }

	for {
		select {
		case outcome := <-completed:
			if outcome.err != nil {
				return d.pullFailure(name, image, outcome)
			}
			return nil
		case <-activity:
			resetIdle()
		case <-idleTimer.C:
			select {
			case outcome := <-completed:
				if outcome.err != nil {
					return d.pullFailure(name, image, outcome)
				}
				return nil
			case <-activity:
				resetIdle()
				continue
			default:
			}
			cancel()
			waitAfterCancel()
			return fmt.Errorf("pull managed image %s (%s): no output for %s", name, image, idleTimeout)
		case <-absoluteTimer.C:
			select {
			case outcome := <-completed:
				if outcome.err != nil {
					return d.pullFailure(name, image, outcome)
				}
				return nil
			default:
			}
			cancel()
			waitAfterCancel()
			return fmt.Errorf("pull managed image %s (%s): exceeded absolute limit %s", name, image, absoluteTimeout)
		case <-ctx.Done():
			cancel()
			waitAfterCancel()
			return fmt.Errorf("pull managed image %s (%s): %w", name, image, ctx.Err())
		}
	}
}

func (d DockerCLI) Prepare(ctx context.Context, manifest release.Manifest) error {
	if err := d.EnsureHostLayout(); err != nil {
		return err
	}
	env, err := d.writeGenerationEnvironment(manifest)
	if err != nil {
		return err
	}
	_, err = d.runner().Run(ctx, d.binary(), d.composeArgs(env, "config", "--quiet"), nil)
	if err != nil {
		return fmt.Errorf("validate Compose generation: %w", err)
	}
	return nil
}

func (d DockerCLI) StopFixed(ctx context.Context) error {
	// Compose intentionally excludes one-off `run` containers from stop/rm.
	// Remove every Manager-labelled migration writer first so crash recovery can
	// never restore SQLite while an orphaned migration still has it open.
	if err := d.stopMigrationContainers(ctx); err != nil {
		return err
	}
	if d.ComposeFile == "" {
		if _, err := d.activeEnvironment(); err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
	}
	// The core network is owned by the Manager rather than Compose because
	// independently-lived Agent sandboxes remain attached while the fixed stack
	// is upgraded. `compose down` would try to remove that network and fail as
	// soon as any running or stopped sandbox retained an endpoint.
	if _, err := d.runner().Run(ctx, d.binary(), d.composeArgs("", "stop", "--timeout", "30"), nil); err != nil {
		return err
	}
	_, err := d.runner().Run(ctx, d.binary(), d.composeArgs("", "rm", "--force", "--stop"), nil)
	return err
}

func (d DockerCLI) StartFixed(ctx context.Context, manifest release.Manifest) error {
	if err := d.EnsureCoreNetwork(ctx); err != nil {
		return err
	}
	if err := d.ensureDataLayout(); err != nil {
		return err
	}
	env, err := d.writeGenerationEnvironment(manifest)
	if err != nil {
		return err
	}
	// Persist the exact Compose generation before starting it. If the Manager
	// exits between this boundary and `compose up`, recovery can stop the same
	// candidate deterministically instead of guessing from directory mtimes.
	if err := d.setActiveGeneration(manifest.ID()); err != nil {
		return err
	}
	_, err = d.runner().Run(ctx, d.binary(), d.composeArgs(env, "up", "--detach", "--wait", "platform", "agent-runtime"), nil)
	if err != nil {
		return err
	}
	// Capability services are intentionally left to the post-commit background
	// reconcilers. Starting them here could make a slow third-party registry hold
	// the fixed-stack lock and the public maintenance gate.
	return nil
}

// ReconcileCapabilities idempotently asks Compose to converge every lightweight
// capability service for one immutable generation. Services are attempted
// independently so one failure does not prevent the others from starting. The
// caller decides how to report and retry the joined error; generation readiness
// never depends on this method. Firecrawl uses its own bounded reconciler.
func (d DockerCLI) ReconcileCapabilities(ctx context.Context, manifest release.Manifest) error {
	env, err := d.writeGenerationEnvironment(manifest)
	if err != nil {
		return err
	}
	return d.reconcileCapabilities(ctx, env)
}

func (d DockerCLI) reconcileCapabilities(ctx context.Context, env string) error {
	var failures []error
	for _, service := range capabilityServices {
		if _, err := d.runner().Run(ctx, d.binary(), d.composeArgs(env, "up", "--detach", service), nil); err != nil {
			failures = append(failures, fmt.Errorf("start capability service %s: %w", service, err))
		}
	}
	return errors.Join(failures...)
}

// ReconcileFirecrawl converges the PostgreSQL-backed extraction stack for the
// active generation. It is safe to call again after Manager activation because
// Compose is idempotent and the Manager never removes or rewrites service data.
func (d DockerCLI) ReconcileFirecrawl(ctx context.Context, manifest release.Manifest) error {
	env, err := d.writeGenerationEnvironment(manifest)
	if err != nil {
		return err
	}
	return d.reconcileFirecrawl(ctx, env)
}

func (d DockerCLI) reconcileFirecrawl(ctx context.Context, env string) error {
	startArgs := d.composeArgs(env, "up", "--detach", "--wait", "--wait-timeout", strconv.Itoa(firecrawlComposeWaitSeconds), "firecrawl-api")
	_, err := d.runner().Run(ctx, d.binary(), startArgs, nil)
	if err == nil {
		return nil
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return errors.Join(
		fmt.Errorf("start Firecrawl PostgreSQL stack: %w", err),
		errors.New(d.firecrawlFailureDiagnostics(env)),
	)
}

func (d DockerCLI) firecrawlFailureDiagnostics(env string) string {
	ctx, cancel := context.WithTimeout(context.Background(), candidateDiagnosticTimeout)
	defer cancel()
	logServices := append([]string{"logs", "--no-color", "--timestamps", "--tail", "120"}, firecrawlHealthyServices...)
	logsResult, logsErr := d.runner().Run(
		ctx,
		d.binary(),
		d.composeArgs(env, logServices...),
		nil,
	)
	parts := []string{"Firecrawl compose logs:\n" + d.boundedCommandDiagnostic(logsResult, logsErr, candidateLogsMaxBytes)}
	services := append([]string{}, firecrawlHealthyServices...)
	for _, service := range services {
		id, err := d.composeServiceContainerID(ctx, env, service)
		if err != nil {
			parts = append(parts, service+" Docker state:\n"+err.Error())
			continue
		}
		state, inspectErr := d.runner().Run(ctx, d.binary(), []string{"inspect", "--format", "{{json .State}}", id}, nil)
		parts = append(parts, service+" Docker state:\n"+d.boundedCommandDiagnostic(state, inspectErr, candidateHealthMaxBytes))
	}
	diagnostic := d.redactCandidateDiagnostic(strings.Join(parts, "\n"))
	return journal.BoundDiagnosticWithLimit(diagnostic, candidateDiagnosticMaxBytes)
}

func (d DockerCLI) Migrate(ctx context.Context, manifest release.Manifest) error {
	if err := d.ensureDataLayout(); err != nil {
		return err
	}
	env, err := d.writeGenerationEnvironment(manifest)
	if err != nil {
		return err
	}
	if err := d.stopMigrationContainers(ctx); err != nil {
		return err
	}
	name := d.migrationContainerName(manifest.ID())
	_, runErr := d.runner().Run(ctx, d.binary(), d.composeArgs(
		env,
		"run", "--rm", "--no-deps",
		"--name", name,
		"--label", "org.ubitech.agent.migration=true",
		"platform", "migrate",
	), nil)
	cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cleanupErr := d.stopMigrationContainers(cleanupCtx)
	return errors.Join(runErr, cleanupErr)
}

func (d DockerCLI) migrationContainerName(generation string) string {
	project := sha256.Sum256([]byte(d.ComposeProject))
	if !validGenerationID(generation) {
		generation = strings.Repeat("0", 40)
	}
	return "ubitech-migration-" + hex.EncodeToString(project[:8]) + "-" + generation[:12]
}

func (d DockerCLI) stopMigrationContainers(ctx context.Context) error {
	filters := []string{
		"ps", "-aq",
		"--filter", "label=org.ubitech.agent.migration=true",
		"--filter", "label=com.docker.compose.project=" + d.ComposeProject,
	}
	result, err := d.runner().Run(ctx, d.binary(), filters, nil)
	if err != nil {
		return fmt.Errorf("list managed migration containers: %w", err)
	}
	ids := strings.Fields(result.Stdout)
	var removeErrors []error
	for _, id := range ids {
		if !validContainerID(id) {
			return errors.New("Docker returned an invalid managed migration container ID")
		}
		if _, removeErr := d.runner().Run(ctx, d.binary(), []string{"rm", "--force", id}, nil); removeErr != nil {
			removeErrors = append(removeErrors, removeErr)
		}
	}
	remaining, checkErr := d.runner().Run(ctx, d.binary(), filters, nil)
	if checkErr != nil {
		return errors.Join(fmt.Errorf("confirm managed migration containers stopped: %w", checkErr), errors.Join(removeErrors...))
	}
	if values := strings.Fields(remaining.Stdout); len(values) > 0 {
		return errors.Join(fmt.Errorf("%d managed migration container(s) remain", len(values)), errors.Join(removeErrors...))
	}
	// A concurrent --rm can make an individual force-remove report not-found;
	// the empty authoritative recheck is the successful cleanup boundary.
	return nil
}

func (d DockerCLI) Probe(ctx context.Context, manifest release.Manifest) error {
	env, err := d.writeGenerationEnvironment(manifest)
	if err != nil {
		return err
	}
	required := []string{"platform", "agent-runtime"}
	for _, service := range required {
		if err := d.probeHealthyComposeService(ctx, env, service); err != nil {
			return err
		}
	}
	return nil
}

func (d DockerCLI) FixedServiceStatus(ctx context.Context) map[string]FixedServiceState {
	result := make(map[string]FixedServiceState, 9)
	env, envErr := d.activeEnvironment()
	if d.ComposeFile != "" {
		env = ""
		envErr = nil
	}
	services := []string{
		"platform",
		"agent-runtime",
		"camofox",
		"searxng",
	}
	services = append(services, firecrawlHealthyServices...)
	for _, service := range services {
		status := "unknown"
		if envErr == nil {
			status = d.healthyServiceStatus(ctx, env, service)
		}
		result[service] = FixedServiceState{Status: status}
	}
	return result
}

func (d DockerCLI) healthyServiceStatus(ctx context.Context, env, service string) string {
	id, err := d.composeServiceContainerID(ctx, env, service)
	if err != nil {
		return "unavailable"
	}
	state, err := d.runner().Run(ctx, d.binary(), []string{
		"inspect", "--format",
		"{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
		id,
	}, nil)
	if err != nil {
		return "unavailable"
	}
	fields := strings.Fields(state.Stdout)
	if len(fields) != 2 {
		return "unknown"
	}
	if fields[0] == "running" && fields[1] == "healthy" {
		return "healthy"
	}
	if fields[0] == "running" && fields[1] == "starting" {
		return "starting"
	}
	return "unavailable"
}

func (d DockerCLI) composeServiceContainerID(ctx context.Context, env, service string) (string, error) {
	result, err := d.runner().Run(ctx, d.binary(), d.composeArgs(env, "ps", "--all", "--quiet", service), nil)
	if err != nil {
		return "", fmt.Errorf("list required service %s containers: %w", service, err)
	}
	ids := strings.Fields(result.Stdout)
	if len(ids) != 1 {
		return "", fmt.Errorf("required service %s must have exactly one container, found %d", service, len(ids))
	}
	if !validContainerID(ids[0]) {
		return "", fmt.Errorf("required service %s returned an invalid container ID", service)
	}
	return ids[0], nil
}

func (d DockerCLI) probeHealthyComposeService(ctx context.Context, env, service string) error {
	id, err := d.composeServiceContainerID(ctx, env, service)
	if err != nil {
		return err
	}
	state, err := d.runner().Run(ctx, d.binary(), []string{
		"inspect", "--format",
		"{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
		id,
	}, nil)
	if err != nil {
		return fmt.Errorf("inspect required service %s container: %w", service, err)
	}
	fields := strings.Fields(state.Stdout)
	if len(fields) != 2 {
		return fmt.Errorf("required service %s returned an invalid container state", service)
	}
	if fields[0] != "running" {
		return fmt.Errorf("required service %s container status is %s, want running", service, fields[0])
	}
	if fields[1] != "healthy" {
		return fmt.Errorf("required service %s container health is %s, want healthy", service, fields[1])
	}
	return nil
}

func (d DockerCLI) Logs(ctx context.Context, service string, tail int) (string, error) {
	if tail < 1 {
		tail = 200
	}
	if tail > 1000 {
		tail = 1000
	}
	args := d.composeArgs("", "logs", "--no-color", "--tail", strconv.Itoa(tail))
	if service != "" {
		if !safeName(service) {
			return "", errors.New("invalid service name")
		}
		args = append(args, service)
	}
	result, err := d.runner().Run(ctx, d.binary(), args, nil)
	return result.Stdout + result.Stderr, err
}

// CandidateFailureDiagnostics captures the exact candidate Platform's bounded
// Compose logs and Docker healthcheck history. Diagnostics are best-effort: a
// failed Docker command is itself rendered into the result instead of hiding
// the original candidate failure behind a second error.
func (d DockerCLI) CandidateFailureDiagnostics(ctx context.Context, manifest release.Manifest) string {
	if !validGenerationID(manifest.ID()) {
		return "candidate diagnostics unavailable: release generation ID is invalid"
	}
	diagnosticCtx, cancel := context.WithTimeout(ctx, candidateDiagnosticTimeout)
	defer cancel()

	envFile := filepath.Join(d.GenerationDir, manifest.ID(), "compose.env")
	// Healthcheck output is the most direct explanation for an unhealthy
	// candidate and is typically tiny. Capture it before logs can consume the
	// shared best-effort diagnostic deadline.
	health := d.candidatePlatformHealthDiagnostic(diagnosticCtx, envFile)
	logsResult, logsErr := d.runner().Run(
		diagnosticCtx,
		d.binary(),
		d.composeArgs(envFile, "logs", "--no-color", "--timestamps", "--tail", "200", "platform"),
		nil,
	)
	logs := d.boundedCommandDiagnostic(logsResult, logsErr, candidateLogsMaxBytes)

	diagnostic := "platform compose logs:\n" + logs + "\nplatform Docker healthcheck:\n" + health
	diagnostic = d.redactCandidateDiagnostic(diagnostic)
	return journal.BoundDiagnosticWithLimit(diagnostic, candidateDiagnosticMaxBytes)
}

func (d DockerCLI) redactCandidateDiagnostic(value string) string {
	// Replace exact Manager-generated capabilities first. Pattern redaction then
	// covers common third-party credential forms that may appear in application
	// logs without requiring the Manager to read arbitrary container files.
	for _, name := range []string{
		"session-secret", "agent-tool-token", "agent-runtime-token",
		"camofox-access-key", "manager-token", "manager-executor-token",
		"firecrawl-postgres-password", "firecrawl-bull-auth-key",
	} {
		secret, err := ReadOwnerSecret(filepath.Join(d.StateDir, "secrets", name))
		if err == nil && secret != "" {
			value = strings.ReplaceAll(value, secret, "[redacted]")
		}
	}
	for _, pattern := range candidateCredentialPatterns {
		value = pattern.expression.ReplaceAllString(value, pattern.replacement)
	}
	return value
}

func (d DockerCLI) candidatePlatformHealthDiagnostic(ctx context.Context, envFile string) string {
	listResult, listErr := d.runner().Run(
		ctx,
		d.binary(),
		d.composeArgs(envFile, "ps", "--all", "--quiet", "platform"),
		nil,
	)
	if listErr != nil {
		return journal.BoundDiagnosticWithLimit(
			"container lookup failed:\n"+d.boundedCommandDiagnostic(listResult, listErr, candidateHealthMaxBytes),
			candidateHealthMaxBytes,
		)
	}
	ids := strings.Fields(listResult.Stdout)
	if len(ids) != 1 {
		return fmt.Sprintf("unavailable: expected exactly one Platform container, found %d", len(ids))
	}
	if !validContainerID(ids[0]) {
		return "unavailable: Docker returned an invalid Platform container ID"
	}

	inspectResult, inspectErr := d.runner().Run(
		ctx,
		d.binary(),
		[]string{"inspect", "--format", "{{json .State.Health}}", ids[0]},
		nil,
	)
	return journal.BoundDiagnosticWithLimit(
		"container_id="+ids[0]+"\n"+d.boundedCommandDiagnostic(inspectResult, inspectErr, candidateHealthMaxBytes),
		candidateHealthMaxBytes,
	)
}

func (d DockerCLI) boundedCommandDiagnostic(result Result, err error, limit int) string {
	var parts []string
	// Put the structured execution failure first so head/tail truncation cannot
	// hide the fact that collection itself failed behind a large stderr stream.
	if err != nil {
		parts = append(parts, "command_error: "+d.redactCandidateDiagnostic(err.Error()))
	}
	if value := strings.TrimSpace(result.Stdout); value != "" {
		parts = append(parts, "stdout:\n"+d.redactCandidateDiagnostic(value))
	}
	if value := strings.TrimSpace(result.Stderr); value != "" {
		parts = append(parts, "stderr:\n"+d.redactCandidateDiagnostic(value))
	}
	if len(parts) == 0 {
		parts = append(parts, "no output")
	}
	return journal.BoundDiagnosticWithLimit(strings.Join(parts, "\n"), limit)
}

func (d DockerCLI) EnsureSandbox(ctx context.Context, spec SandboxSpec) error {
	_, err := d.EnsureSandboxWithResult(ctx, spec)
	return err
}

func (d DockerCLI) EnsureSandboxWithResult(ctx context.Context, spec SandboxSpec) (SandboxEnsureResult, error) {
	running, err := d.SandboxRunning(ctx, spec.ContainerName)
	if err == nil && running {
		return SandboxEnsureResult{WasRunning: true}, nil
	}
	if err == nil {
		_, err = d.runner().Run(ctx, d.binary(), []string{"start", spec.ContainerName}, nil)
		if err != nil {
			return SandboxEnsureResult{}, err
		}
		return SandboxEnsureResult{Started: true}, nil
	}
	if err := d.ensureImage(ctx, "agent-sandbox", spec.Image); err != nil {
		return SandboxEnsureResult{}, fmt.Errorf("prepare sandbox image: %w", err)
	}
	args := []string{"create", "--name", spec.ContainerName, "--label", "org.ubitech.agent.sandbox=true", "--label", "org.ubitech.agent.id=" + spec.AgentHash,
		"--network", spec.Network, "--user", "0:0", "--env", fmt.Sprintf("UBITECH_AGENT_UID=%d", spec.UID), "--env", fmt.Sprintf("UBITECH_AGENT_GID=%d", spec.GID), "--workdir", contract.ContainerWorkspace,
		"--mount", bindMount(spec.Workspace, contract.ContainerWorkspace), "--mount", bindMount(spec.Home, contract.ContainerAgentHome), "--mount", bindMount(spec.Environment, contract.ContainerAgentEnv)}
	if spec.Attachments != "" {
		args = append(args, "--mount", bindMount(spec.Attachments, contract.ContainerWorkspace+"/.ubitech/attachments")+",readonly")
	}
	args = append(args, spec.Image, "sleep", "infinity")
	_, err = d.runner().Run(ctx, d.binary(), args, nil)
	if err != nil {
		return SandboxEnsureResult{}, fmt.Errorf("create sandbox: %w", err)
	}
	_, err = d.runner().Run(ctx, d.binary(), []string{"start", spec.ContainerName}, nil)
	if err != nil {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_, cleanupErr := d.runner().Run(cleanupCtx, d.binary(), []string{"rm", "--force", spec.ContainerName}, nil)
		if cleanupErr == nil {
			return SandboxEnsureResult{}, err
		}
		return SandboxEnsureResult{Created: true}, errors.Join(err, cleanupErr)
	}
	return SandboxEnsureResult{Created: true, Started: true}, nil
}

func (d DockerCLI) StopSandbox(ctx context.Context, name string) error {
	if !safeName(name) {
		return errors.New("invalid sandbox name")
	}
	_, err := d.runner().Run(ctx, d.binary(), []string{"stop", "--time", "15", name}, nil)
	return err
}
func (d DockerCLI) RemoveSandbox(ctx context.Context, name string) error {
	if !safeName(name) {
		return errors.New("invalid sandbox name")
	}
	_, err := d.runner().Run(ctx, d.binary(), []string{"rm", "--force", name}, nil)
	return err
}
func (d DockerCLI) SandboxRunning(ctx context.Context, name string) (bool, error) {
	if !safeName(name) {
		return false, errors.New("invalid sandbox name")
	}
	result, err := d.runner().Run(ctx, d.binary(), []string{"inspect", "--format", "{{.State.Running}}", name}, nil)
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(result.Stdout) == "true", nil
}
func (d DockerCLI) ExecArgs(spec SandboxSpec, cwd, command string, args []string) (string, []string) {
	if cwd == "" {
		cwd = contract.ContainerWorkspace
	}
	dockerArgs := []string{"exec", "--interactive", "--user", fmt.Sprintf("%d:%d", spec.UID, spec.GID), "--workdir", cwd, spec.ContainerName, command}
	dockerArgs = append(dockerArgs, args...)
	return d.binary(), dockerArgs
}

// EnsureCoreNetwork creates the one lifecycle-independent bridge shared by
// fixed services and Agent sandboxes. An existing network is accepted only
// when it has the expected driver and Manager ownership label; this avoids
// silently attaching trusted Agent workloads to an unrelated Docker network.
func (d DockerCLI) EnsureCoreNetwork(ctx context.Context) error {
	if !safeName(d.CoreNetwork) {
		return errors.New("invalid core network name")
	}
	format := `{{.Driver}} {{index .Labels "org.ubitech.agent.network"}}`
	result, inspectErr := d.runner().Run(ctx, d.binary(), []string{"network", "inspect", "--format", format, d.CoreNetwork}, nil)
	if inspectErr == nil {
		if strings.TrimSpace(result.Stdout) != "bridge core" {
			return fmt.Errorf("Docker network %s exists but is not a Manager-owned core bridge", d.CoreNetwork)
		}
		return nil
	}
	if _, err := d.runner().Run(ctx, d.binary(), []string{"network", "create", "--driver", "bridge", "--label", "org.ubitech.agent.network=core", d.CoreNetwork}, nil); err != nil {
		return fmt.Errorf("create core Docker network %s: %w", d.CoreNetwork, err)
	}
	return nil
}

func (d DockerCLI) composeArgs(envFile string, args ...string) []string {
	if envFile == "" && d.ComposeFile == "" {
		if active, err := d.activeEnvironment(); err == nil {
			envFile = active
		}
	}
	composeFile := d.ComposeFile
	if composeFile == "" && envFile != "" {
		composeFile = filepath.Join(filepath.Dir(envFile), "compose.yaml")
	}
	if composeFile == "" {
		composeFile = filepath.Join(d.GenerationDir, "current", "compose.yaml")
	}
	base := []string{"compose", "--project-name", d.ComposeProject, "--file", composeFile}
	if envFile != "" {
		base = append(base, "--env-file", envFile)
	}
	return append(base, args...)
}
func (d DockerCLI) activeEnvironment() (string, error) {
	pointer := filepath.Join(d.StateDir, "active-generation")
	info, err := os.Lstat(pointer)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 128 {
		return "", errors.New("active generation pointer is not a small regular file")
	}
	data, err := os.ReadFile(pointer)
	if err != nil {
		return "", err
	}
	id := strings.TrimSpace(string(data))
	if !validGenerationID(id) {
		return "", errors.New("active generation pointer is invalid")
	}
	dir := filepath.Join(d.GenerationDir, id)
	dirInfo, err := os.Lstat(dir)
	if err != nil {
		return "", err
	}
	if !dirInfo.IsDir() || dirInfo.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("active generation directory is invalid")
	}
	for _, name := range []string{"manifest.json", "compose.yaml", "compose.env"} {
		artifact, statErr := os.Lstat(filepath.Join(dir, name))
		if statErr != nil {
			return "", statErr
		}
		if !artifact.Mode().IsRegular() || artifact.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("active generation %s is not a regular file", name)
		}
	}
	return filepath.Join(dir, "compose.env"), nil
}

func (d DockerCLI) setActiveGeneration(id string) error {
	if !validGenerationID(id) {
		return errors.New("active generation ID is invalid")
	}
	dir := filepath.Join(d.GenerationDir, id)
	for _, name := range []string{"manifest.json", "compose.yaml", "compose.env"} {
		info, err := os.Lstat(filepath.Join(dir, name))
		if err != nil {
			return fmt.Errorf("activate generation %s: %w", name, err)
		}
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("activate generation %s: artifact is not a regular file", name)
		}
	}
	return atomicfile.WriteFile(filepath.Join(d.StateDir, "active-generation"), []byte(id+"\n"), 0o600)
}
func (d DockerCLI) writeGenerationEnvironment(manifest release.Manifest) (string, error) {
	dir := filepath.Join(d.GenerationDir, manifest.ID())
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "compose.env")
	names := make([]string, 0, len(manifest.Images))
	for name := range manifest.Images {
		names = append(names, name)
	}
	sort.Strings(names)
	var content strings.Builder
	fixed := map[string]string{"UBITECH_DATA_ROOT": d.DataRoot, "UBITECH_SECRETS_DIR": filepath.Join(d.StateDir, "secrets"), "UBITECH_MANAGER_CONTROL_DIR": filepath.Join(d.StateDir, "control"), "UBITECH_UID": strconv.Itoa(d.UID), "UBITECH_GID": strconv.Itoa(d.GID), "UBITECH_PLATFORM_BIND": d.PlatformBind, "UBITECH_PUBLIC_BASE_URL": "http://" + d.GatewayAddress, "UBITECH_CORE_NETWORK": d.CoreNetwork, "UBITECH_LOG_MAX_SIZE": d.LogMaxSize, "UBITECH_LOG_MAX_FILES": strconv.Itoa(d.LogMaxFiles), "UBITECH_COMPOSE_PROJECT": d.ComposeProject}
	fixedNames := make([]string, 0, len(fixed))
	for name := range fixed {
		fixedNames = append(fixedNames, name)
	}
	sort.Strings(fixedNames)
	for _, name := range fixedNames {
		if fixed[name] != "" {
			fmt.Fprintf(&content, "%s=%s\n", name, fixed[name])
		}
	}
	for _, name := range names {
		key := "UBITECH_" + strings.ToUpper(strings.NewReplacer("-", "_", ".", "_").Replace(name)) + "_IMAGE"
		fmt.Fprintf(&content, "%s=%s\n", key, manifest.Images[name])
	}
	return path, atomicfile.WriteFile(path, []byte(content.String()), 0o600)
}

func (d DockerCLI) EnsureHostLayout() error {
	if d.DataRoot == "" || d.StateDir == "" {
		return errors.New("data root and state directory are required")
	}
	directories := []string{d.DataRoot, d.StateDir, filepath.Join(d.StateDir, "secrets"), filepath.Join(d.StateDir, "control")}
	for _, path := range directories {
		if err := ensureOwnerDirectory(path); err != nil {
			return err
		}
	}
	for _, name := range []string{"session-secret", "agent-tool-token", "agent-runtime-token", "camofox-access-key", "manager-token", "manager-executor-token", "firecrawl-postgres-password", "firecrawl-bull-auth-key"} {
		if _, err := ensureSecret(filepath.Join(d.StateDir, "secrets", name)); err != nil {
			return err
		}
	}
	return nil
}
func (d DockerCLI) ensureDataLayout() error {
	directories := []string{filepath.Join(d.DataRoot, "data"), filepath.Join(d.DataRoot, "data", "runtimes", "agent"), filepath.Join(d.DataRoot, "data", "runtimes", "camofox"), filepath.Join(d.DataRoot, "data", "runtimes", "searxng", "config"), filepath.Join(d.DataRoot, "data", "runtimes", "searxng", "cache"), filepath.Join(d.DataRoot, "data", "runtimes", "firecrawl")}
	for _, path := range directories {
		if err := os.MkdirAll(path, 0o700); err != nil {
			return err
		}
	}
	settings := filepath.Join(d.DataRoot, "data", "runtimes", "searxng", "config", "settings.yml")
	if _, err := os.Stat(settings); os.IsNotExist(err) {
		secret, err := randomSecret()
		if err != nil {
			return err
		}
		content := fmt.Sprintf("use_default_settings: true\nserver:\n  secret_key: %q\nsearch:\n  formats:\n    - html\n    - json\n", secret)
		if err := atomicfile.WriteFile(settings, []byte(content), 0o600); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	return nil
}
func ensureSecret(path string) (string, error) {
	if _, err := os.Lstat(path); err == nil {
		return ReadOwnerSecret(path)
	} else if !os.IsNotExist(err) {
		return "", fmt.Errorf("inspect secret %s: %w", path, err)
	}
	value, err := randomSecret()
	if err != nil {
		return "", err
	}
	if err := atomicfile.WriteFile(path, []byte(value+"\n"), 0o600); err != nil {
		return "", err
	}
	return ReadOwnerSecret(path)
}

// ReadOwnerSecret reads a Manager capability only after checking the actual
// filesystem object. Callers must not follow a token symlink or accept a token
// owned by another host user merely because the containing path is private.
func ReadOwnerSecret(path string) (string, error) {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return "", fmt.Errorf("open private secret %s without following links: %w", path, err)
	}
	file := os.NewFile(uintptr(fd), path)
	if file == nil {
		_ = syscall.Close(fd)
		return "", fmt.Errorf("open private secret %s: invalid file descriptor", path)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", fmt.Errorf("inspect private secret %s: %w", path, err)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("private path %s must be a non-symlink regular file", path)
	}
	if err := requireOwner(path, info); err != nil {
		return "", err
	}
	if err := file.Chmod(0o600); err != nil {
		return "", fmt.Errorf("restrict private secret %s: %w", path, err)
	}
	data, err := io.ReadAll(io.LimitReader(file, 4097))
	if err != nil {
		return "", fmt.Errorf("read secret %s: %w", path, err)
	}
	if len(data) > 4096 {
		return "", fmt.Errorf("secret %s exceeds 4096 bytes", filepath.Base(path))
	}
	value := strings.TrimSpace(string(data))
	if len(value) < 32 || strings.ContainsAny(value, "\r\n\x00") {
		return "", fmt.Errorf("secret %s is invalid", filepath.Base(path))
	}
	return value, nil
}

func ensureOwnerDirectory(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return fmt.Errorf("create private directory %s: %w", path, err)
	}
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("inspect private directory %s: %w", path, err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("private path %s must be a non-symlink directory", path)
	}
	if err := requireOwner(path, info); err != nil {
		return err
	}
	if err := os.Chmod(path, 0o700); err != nil {
		return fmt.Errorf("restrict private directory %s: %w", path, err)
	}
	return nil
}

func requireOwner(path string, info os.FileInfo) error {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Getuid()) {
		return fmt.Errorf("private path %s is not owned by the Manager user", path)
	}
	return nil
}
func randomSecret() (string, error) {
	data := make([]byte, 32)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return hex.EncodeToString(data), nil
}
func bindMount(source, target string) string { return "type=bind,src=" + source + ",dst=" + target }
func safeName(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, r := range value {
		if !(r == '-' || r == '_' || r == '.' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') {
			return false
		}
	}
	return true
}

func validGenerationID(value string) bool {
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

func validContainerID(value string) bool {
	if len(value) < 12 || len(value) > 64 {
		return false
	}
	for _, r := range value {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			return false
		}
	}
	return true
}
