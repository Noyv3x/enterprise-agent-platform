package driver

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/release"
)

type recordedCall struct {
	name string
	args []string
}

type recordingRunner struct {
	calls   []recordedCall
	results func([]string) (Result, error)
}

func (r *recordingRunner) Run(_ context.Context, name string, args []string, _ []string) (Result, error) {
	r.calls = append(r.calls, recordedCall{name: name, args: append([]string(nil), args...)})
	if r.results != nil {
		return r.results(args)
	}
	return Result{}, nil
}

func TestEnsureSandboxUsesRootEntrypointAndExecUsesMappedUser(t *testing.T) {
	runner := &recordingRunner{results: func(args []string) (Result, error) {
		if len(args) > 0 && args[0] == "inspect" {
			return Result{}, errors.New("not found")
		}
		return Result{}, nil
	}}
	docker := DockerCLI{Runner: runner, Binary: "docker"}
	spec := SandboxSpec{
		ContainerName: "ubitech-sandbox-test",
		AgentHash:     "abc",
		Image:         "sandbox@sha256:abc",
		Network:       "ubitech-agent-core",
		Workspace:     "/data/workspace",
		Home:          "/data/home",
		Environment:   "/data/env",
		UID:           12345,
		GID:           23456,
	}
	outcome, err := docker.EnsureSandboxWithResult(context.Background(), spec)
	if err != nil {
		t.Fatal(err)
	}
	if !outcome.Created || !outcome.Started || outcome.WasRunning {
		t.Fatalf("new sandbox returned the wrong ensure outcome: %#v", outcome)
	}
	var create []string
	for _, call := range runner.calls {
		if len(call.args) > 0 && call.args[0] == "create" {
			create = call.args
		}
	}
	joined := strings.Join(create, " ")
	for _, required := range []string{"--user 0:0", "UBITECH_AGENT_UID=12345", "UBITECH_AGENT_GID=23456"} {
		if !strings.Contains(joined, required) {
			t.Fatalf("create arguments lack %q: %v", required, create)
		}
	}
	name, args := docker.ExecArgs(spec, "/workspace", "sudo", []string{"-n", "true"})
	if name != "docker" || !reflect.DeepEqual(args[:7], []string{"exec", "--interactive", "--user", "12345:23456", "--workdir", "/workspace", "ubitech-sandbox-test"}) {
		t.Fatalf("exec does not use the mapped identity: %s %v", name, args)
	}
}

func TestEnsureSandboxRemovesCreatedContainerWhenStartFails(t *testing.T) {
	runner := &recordingRunner{results: func(args []string) (Result, error) {
		switch args[0] {
		case "inspect":
			return Result{}, errors.New("not found")
		case "start":
			return Result{}, errors.New("entrypoint failed")
		default:
			return Result{}, nil
		}
	}}
	docker := DockerCLI{Runner: runner, Binary: "docker"}
	spec := SandboxSpec{ContainerName: "ubitech-sandbox-test", AgentHash: "abc", Image: "sandbox@sha256:abc", Network: "core", Workspace: "/data/workspace", Home: "/data/home", Environment: "/data/env", UID: 12345, GID: 23456}
	outcome, err := docker.EnsureSandboxWithResult(context.Background(), spec)
	if err == nil || !strings.Contains(err.Error(), "entrypoint failed") {
		t.Fatalf("sandbox start failure was not returned: %v", err)
	}
	if outcome != (SandboxEnsureResult{}) {
		t.Fatalf("successfully compensated create reported live changes: %#v", outcome)
	}
	last := runner.calls[len(runner.calls)-1].args
	if !reflect.DeepEqual(last, []string{"rm", "--force", spec.ContainerName}) {
		t.Fatalf("failed sandbox start was not removed: %v", last)
	}
}

func TestStopFixedNeverRemovesLifecycleIndependentNetwork(t *testing.T) {
	runner := &recordingRunner{}
	docker := DockerCLI{Runner: runner, Binary: "docker", ComposeFile: "/release/compose.yaml", ComposeProject: "ubitech-agent"}
	if err := docker.StopFixed(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(runner.calls) != 4 {
		t.Fatalf("expected migration recheck, stop and rm, got %#v", runner.calls)
	}
	commands := strings.Join(append(runner.calls[2].args, runner.calls[3].args...), " ")
	if strings.Contains(commands, "down") || strings.Contains(commands, "network") || strings.Contains(commands, "--remove-orphans") {
		t.Fatalf("fixed-stack stop can disturb independent sandboxes: %s", commands)
	}
	if !strings.Contains(strings.Join(runner.calls[0].args, " "), "org.ubitech.agent.migration=true") ||
		!strings.Contains(strings.Join(runner.calls[1].args, " "), "org.ubitech.agent.migration=true") {
		t.Fatalf("migration cleanup was not authoritatively rechecked: %#v", runner.calls[:2])
	}
	if !strings.Contains(strings.Join(runner.calls[2].args, " "), " stop --timeout 30") ||
		!strings.Contains(strings.Join(runner.calls[3].args, " "), " rm --force --stop") {
		t.Fatalf("unexpected fixed-stack lifecycle commands: %#v", runner.calls)
	}
}

func TestStopFixedRemovesManagedMigrationWriterBeforeCompose(t *testing.T) {
	const migrationID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	listed := false
	runner := &recordingRunner{results: func(args []string) (Result, error) {
		if len(args) >= 2 && args[0] == "ps" && args[1] == "-aq" {
			if !listed {
				listed = true
				return Result{Stdout: migrationID + "\n"}, nil
			}
			return Result{}, nil
		}
		return Result{}, nil
	}}
	docker := DockerCLI{Runner: runner, Binary: "docker", ComposeFile: "/release/compose.yaml", ComposeProject: "ubitech-agent"}
	if err := docker.StopFixed(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(runner.calls) < 5 {
		t.Fatalf("unexpected cleanup calls: %#v", runner.calls)
	}
	if got := strings.Join(runner.calls[1].args, " "); got != "rm --force "+migrationID {
		t.Fatalf("migration writer was not force-removed: %s", got)
	}
	if !strings.Contains(strings.Join(runner.calls[3].args, " "), " stop --timeout 30") {
		t.Fatalf("fixed stack stopped before migration cleanup completed: %#v", runner.calls)
	}
}

func TestReconcileFirecrawlRecreatesFailedInitWithoutRestartingHealthyFoundationDB(t *testing.T) {
	const initID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const foundationDBID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	starts := 0
	runner := &recordingRunner{results: func(args []string) (Result, error) {
		joined := strings.Join(args, " ")
		switch {
		case strings.Contains(joined, " up --detach --wait --wait-timeout 600 firecrawl-api"):
			starts++
			if starts == 1 {
				return Result{Stderr: "dependency failed"}, errors.New("dependency failed")
			}
		case slicesContain(args, "ps") && args[len(args)-1] == "firecrawl-foundationdb-init":
			return Result{Stdout: initID}, nil
		case slicesContain(args, "ps") && args[len(args)-1] == "firecrawl-foundationdb":
			return Result{Stdout: foundationDBID}, nil
		case len(args) > 0 && args[0] == "inspect" && args[len(args)-1] == initID:
			return Result{Stdout: "exited 1"}, nil
		case len(args) > 0 && args[0] == "inspect" && args[len(args)-1] == foundationDBID:
			return Result{Stdout: "running healthy"}, nil
		}
		return Result{}, nil
	}}
	docker := DockerCLI{Runner: runner, Binary: "docker", ComposeFile: "/release/compose.yaml", ComposeProject: "ubitech-agent"}
	if err := docker.reconcileFirecrawl(context.Background(), "/state/compose.env"); err != nil {
		t.Fatal(err)
	}
	if starts != 2 {
		t.Fatalf("Firecrawl start attempts = %d, want 2", starts)
	}
	var lifecycle []string
	for _, call := range runner.calls {
		lifecycle = append(lifecycle, strings.Join(call.args, " "))
	}
	if len(lifecycle) != 7 ||
		!strings.Contains(lifecycle[0], "up --detach --wait --wait-timeout 600 firecrawl-api") ||
		!strings.Contains(lifecycle[5], "rm --force --stop firecrawl-foundationdb-init") ||
		!strings.Contains(lifecycle[6], "up --detach --wait --wait-timeout 600 firecrawl-api") {
		t.Fatalf("unexpected Firecrawl reconciliation sequence: %#v", lifecycle)
	}
	for _, call := range lifecycle {
		if strings.Contains(call, "restart --timeout 30 firecrawl-foundationdb") {
			t.Fatalf("healthy FoundationDB was restarted: %#v", lifecycle)
		}
	}
}

func TestReconcileFirecrawlDoesNotMutateFoundationDBForAPIOnlyFailure(t *testing.T) {
	const initID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const foundationDBID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	starts := 0
	runner := &recordingRunner{results: func(args []string) (Result, error) {
		joined := strings.Join(args, " ")
		switch {
		case strings.Contains(joined, " up --detach --wait --wait-timeout 600 firecrawl-api"):
			starts++
			return Result{}, errors.New("Firecrawl API is unhealthy")
		case slicesContain(args, "ps") && args[len(args)-1] == "firecrawl-foundationdb-init":
			return Result{Stdout: initID}, nil
		case slicesContain(args, "ps") && args[len(args)-1] == "firecrawl-foundationdb":
			return Result{Stdout: foundationDBID}, nil
		case len(args) > 0 && args[0] == "inspect" && args[len(args)-1] == initID:
			return Result{Stdout: "exited 0"}, nil
		case len(args) > 0 && args[0] == "inspect" && args[len(args)-1] == foundationDBID:
			return Result{Stdout: "running healthy"}, nil
		case slicesContain(args, "logs"):
			return Result{Stdout: "api failed"}, nil
		case len(args) > 0 && args[0] == "inspect":
			return Result{Stdout: `{}`}, nil
		}
		return Result{}, nil
	}}
	docker := DockerCLI{Runner: runner, Binary: "docker", ComposeFile: "/release/compose.yaml", ComposeProject: "ubitech-agent"}
	err := docker.reconcileFirecrawl(context.Background(), "/state/compose.env")
	if err == nil || !strings.Contains(err.Error(), "outside the FoundationDB/init repair boundary") {
		t.Fatalf("reconcileFirecrawl() error = %v", err)
	}
	if starts != 1 {
		t.Fatalf("API-only failure was retried %d times, want one attempt", starts)
	}
	for _, call := range runner.calls {
		joined := strings.Join(call.args, " ")
		if strings.Contains(joined, " rm --force --stop ") || strings.Contains(joined, " restart ") {
			t.Fatalf("API-only failure mutated FoundationDB/init state: %s", joined)
		}
	}
}

func TestStartFixedReturnsBothFirecrawlAttemptFailures(t *testing.T) {
	const initID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const foundationDBID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	const apiID = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	root := t.TempDir()
	generation := strings.Repeat("a", 40)
	releaseDir := filepath.Join(root, "releases", generation)
	stateDir := filepath.Join(root, "manager")
	if err := os.MkdirAll(releaseDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"manifest.json", "compose.yaml"} {
		if err := os.WriteFile(filepath.Join(releaseDir, name), []byte("test\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	starts := 0
	runner := &recordingRunner{results: func(args []string) (Result, error) {
		joined := strings.Join(args, " ")
		switch {
		case len(args) > 1 && args[0] == "network" && args[1] == "inspect":
			return Result{Stdout: "bridge core\n"}, nil
		case strings.Contains(joined, " up --detach --wait --wait-timeout 600 firecrawl-api"):
			starts++
			return Result{}, fmt.Errorf("dependency failure %d", starts)
		case slicesContain(args, "ps"):
			switch args[len(args)-1] {
			case "firecrawl-foundationdb-init":
				return Result{Stdout: initID}, nil
			case "firecrawl-foundationdb":
				return Result{Stdout: foundationDBID}, nil
			case "firecrawl-api":
				return Result{Stdout: apiID}, nil
			}
			return Result{}, nil
		case len(args) > 0 && args[0] == "inspect":
			if strings.Contains(joined, ".State.ExitCode") {
				return Result{Stdout: "exited 1"}, nil
			}
			if strings.Contains(joined, ".State.Health") {
				return Result{Stdout: "running healthy"}, nil
			}
			return Result{Stdout: `{}`}, nil
		default:
			return Result{}, nil
		}
	}}
	docker := DockerCLI{
		Runner: runner, Binary: "docker", ComposeProject: "ubitech-agent",
		GenerationDir: filepath.Join(root, "releases"), DataRoot: filepath.Join(root, "data-root"),
		StateDir: stateDir, CoreNetwork: "ubitech-agent-core",
	}
	err := docker.StartFixed(context.Background(), release.Manifest{SourceCommit: generation, Images: map[string]string{}})
	if err == nil || !strings.Contains(err.Error(), "initial Firecrawl start: dependency failure 1") ||
		!strings.Contains(err.Error(), "Firecrawl retry after init reconciliation: dependency failure 2") ||
		!strings.Contains(err.Error(), "Firecrawl compose logs:") ||
		!strings.Contains(err.Error(), "firecrawl-foundationdb Docker state:") {
		t.Fatalf("StartFixed() error = %v, want both Firecrawl attempt failures", err)
	}
	if starts != 2 {
		t.Fatalf("Firecrawl start attempts = %d, want 2", starts)
	}
}

func TestMigrateUsesManagedIdentityAndCleansAfterRunnerFailure(t *testing.T) {
	const migrationID = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
	psCalls := 0
	runner := &recordingRunner{results: func(args []string) (Result, error) {
		if len(args) >= 2 && args[0] == "ps" && args[1] == "-aq" {
			psCalls++
			if psCalls == 3 {
				return Result{Stdout: migrationID + "\n"}, nil
			}
			return Result{}, nil
		}
		if slicesContain(args, "run") {
			return Result{}, errors.New("manager interrupted")
		}
		return Result{}, nil
	}}
	root := t.TempDir()
	generation := strings.Repeat("a", 40)
	dir := filepath.Join(root, generation)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"manifest.json", "compose.yaml"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("test\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	docker := DockerCLI{
		Runner: runner, Binary: "docker", ComposeProject: "ubitech-agent",
		GenerationDir: root, DataRoot: filepath.Join(root, "data-root"), StateDir: filepath.Join(root, "state"),
	}
	manifest := release.Manifest{SourceCommit: generation, Images: map[string]string{}}
	err := docker.Migrate(context.Background(), manifest)
	if err == nil || !strings.Contains(err.Error(), "manager interrupted") {
		t.Fatalf("runner failure was not returned: %v", err)
	}
	var runArgs []string
	for _, call := range runner.calls {
		if slicesContain(call.args, "run") {
			runArgs = call.args
		}
	}
	joined := strings.Join(runArgs, " ")
	if !strings.Contains(joined, "--name ubitech-migration-") || !strings.Contains(joined, "--label org.ubitech.agent.migration=true") {
		t.Fatalf("migration run lacks durable identity: %v", runArgs)
	}
	removed := false
	for _, call := range runner.calls {
		if reflect.DeepEqual(call.args, []string{"rm", "--force", migrationID}) {
			removed = true
		}
	}
	if !removed || psCalls != 4 {
		t.Fatalf("failed migration was not removed and rechecked: calls=%#v ps=%d", runner.calls, psCalls)
	}
}

func TestProbeInspectsExactlyOneHealthyRunningContainerPerCoreService(t *testing.T) {
	healthyServices := []string{
		"platform", "agent-runtime", "camofox", "searxng",
		"firecrawl-playwright", "firecrawl-redis", "firecrawl-rabbitmq", "firecrawl-postgres",
		"firecrawl-foundationdb", "firecrawl-api",
	}
	services := append(append([]string{}, healthyServices...), "firecrawl-foundationdb-init")
	ids := map[string]string{}
	states := map[string]string{}
	hexDigits := "abcdef0123456789"
	for index, service := range services {
		id := strings.Repeat(string(hexDigits[index]), 64)
		ids[service] = id
		states[id] = "running healthy\n"
	}
	states[ids["firecrawl-foundationdb-init"]] = "exited 0\n"
	runner := &recordingRunner{results: func(args []string) (Result, error) {
		if len(args) > 0 && args[0] == "compose" && slicesContain(args, "ps") {
			return Result{Stdout: ids[args[len(args)-1]] + "\n"}, nil
		}
		if len(args) > 0 && args[0] == "inspect" {
			return Result{Stdout: states[args[len(args)-1]]}, nil
		}
		return Result{}, nil
	}}
	docker := DockerCLI{
		Runner: runner, Binary: "docker", ComposeFile: "/release/compose.yaml",
		ComposeProject: "ubitech-agent", GenerationDir: t.TempDir(),
	}
	manifest := release.Manifest{SourceCommit: strings.Repeat("f", 40), Images: map[string]string{}}
	if err := docker.Probe(context.Background(), manifest); err != nil {
		t.Fatal(err)
	}
	if len(runner.calls) != len(services)*2 {
		t.Fatalf("probe made %d calls, want %d: %#v", len(runner.calls), len(services)*2, runner.calls)
	}
	for index, service := range services {
		list := strings.Join(runner.calls[index*2].args, " ")
		if !strings.Contains(list, " ps --all --quiet "+service) {
			t.Fatalf("service %s was not listed including stopped and duplicate containers: %s", service, list)
		}
		inspect := runner.calls[index*2+1].args
		if inspect[0] != "inspect" || inspect[len(inspect)-1] != ids[service] {
			t.Fatalf("service %s container was not inspected directly: %v", service, inspect)
		}
	}
}

func TestProbeRejectsIncompleteOrFailedFirecrawlInit(t *testing.T) {
	const healthyID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const initID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	tests := []struct {
		name  string
		ids   string
		state string
		want  string
	}{
		{name: "missing", ids: "", state: "exited 0", want: "exactly one container, found 0"},
		{name: "still running", ids: initID, state: "running 0", want: "status is running, want exited"},
		{name: "failed", ids: initID, state: "exited 1", want: "exited with 1, want 0"},
		{name: "invalid exit", ids: initID, state: "exited unknown", want: "invalid exit code"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			runner := &recordingRunner{results: func(args []string) (Result, error) {
				if len(args) > 0 && args[0] == "compose" && slicesContain(args, "ps") {
					if args[len(args)-1] == "firecrawl-foundationdb-init" {
						return Result{Stdout: test.ids}, nil
					}
					return Result{Stdout: healthyID}, nil
				}
				if len(args) > 0 && args[0] == "inspect" {
					if args[len(args)-1] == initID {
						return Result{Stdout: test.state}, nil
					}
					return Result{Stdout: "running healthy"}, nil
				}
				return Result{}, nil
			}}
			docker := DockerCLI{
				Runner: runner, Binary: "docker", ComposeFile: "/release/compose.yaml",
				ComposeProject: "ubitech-agent", GenerationDir: t.TempDir(),
			}
			manifest := release.Manifest{SourceCommit: strings.Repeat("f", 40), Images: map[string]string{}}
			err := docker.Probe(context.Background(), manifest)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("Probe() error = %v, want containing %q", err, test.want)
			}
		})
	}
}

func TestFixedServiceStatusReportsFirecrawlComponentsIndependently(t *testing.T) {
	services := []string{
		"platform", "agent-runtime", "camofox", "searxng",
		"firecrawl-playwright", "firecrawl-redis", "firecrawl-rabbitmq", "firecrawl-postgres",
		"firecrawl-foundationdb", "firecrawl-api", "firecrawl-foundationdb-init",
	}
	ids := map[string]string{}
	for index, service := range services {
		ids[service] = strings.Repeat(string("abcdef0123456789"[index]), 64)
	}
	runner := &recordingRunner{results: func(args []string) (Result, error) {
		if slicesContain(args, "ps") {
			return Result{Stdout: ids[args[len(args)-1]]}, nil
		}
		if len(args) > 0 && args[0] == "inspect" {
			id := args[len(args)-1]
			switch id {
			case ids["firecrawl-redis"]:
				return Result{Stdout: "running unhealthy"}, nil
			case ids["firecrawl-foundationdb"]:
				return Result{Stdout: "running unhealthy"}, nil
			case ids["firecrawl-foundationdb-init"]:
				return Result{Stdout: "exited 1"}, nil
			default:
				return Result{Stdout: "running healthy"}, nil
			}
		}
		return Result{}, nil
	}}
	docker := DockerCLI{
		Runner: runner, Binary: "docker", ComposeFile: "/release/compose.yaml",
		ComposeProject: "ubitech-agent", GenerationDir: t.TempDir(),
	}
	status := docker.FixedServiceStatus(context.Background())
	if status["firecrawl-redis"].Status != "unavailable" ||
		status["firecrawl-foundationdb"].Status != "unavailable" ||
		status["firecrawl-foundationdb-init"].Status != "unavailable" ||
		status["firecrawl-api"].Status != "healthy" {
		t.Fatalf("independent Firecrawl service status = %#v", status)
	}
	for _, service := range []string{"platform", "agent-runtime", "camofox", "searxng", "firecrawl-playwright", "firecrawl-rabbitmq", "firecrawl-postgres"} {
		if status[service].Status != "healthy" {
			t.Fatalf("service %s status = %#v", service, status[service])
		}
	}
}

func TestProbeRejectsMissingDuplicateStoppedOrUnhealthyCoreContainer(t *testing.T) {
	const healthyID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	tests := []struct {
		name          string
		platformIDs   string
		platformState string
		want          string
	}{
		{name: "missing", platformIDs: "", platformState: "running healthy", want: "exactly one container, found 0"},
		{name: "duplicate", platformIDs: healthyID + "\n" + strings.Repeat("b", 64), platformState: "running healthy", want: "exactly one container, found 2"},
		{name: "stopped", platformIDs: healthyID, platformState: "exited healthy", want: "status is exited, want running"},
		{name: "unhealthy", platformIDs: healthyID, platformState: "running unhealthy", want: "health is unhealthy, want healthy"},
		{name: "healthcheck missing", platformIDs: healthyID, platformState: "running none", want: "health is none, want healthy"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			runner := &recordingRunner{results: func(args []string) (Result, error) {
				if len(args) > 0 && args[0] == "compose" && slicesContain(args, "ps") {
					service := args[len(args)-1]
					if service == "platform" {
						return Result{Stdout: test.platformIDs}, nil
					}
					return Result{Stdout: healthyID}, nil
				}
				if len(args) > 0 && args[0] == "inspect" {
					return Result{Stdout: test.platformState}, nil
				}
				return Result{}, nil
			}}
			docker := DockerCLI{
				Runner: runner, Binary: "docker", ComposeFile: "/release/compose.yaml",
				ComposeProject: "ubitech-agent", GenerationDir: t.TempDir(),
			}
			manifest := release.Manifest{SourceCommit: strings.Repeat("f", 40), Images: map[string]string{}}
			err := docker.Probe(context.Background(), manifest)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("Probe() error = %v, want containing %q", err, test.want)
			}
		})
	}
}

func TestCandidateFailureDiagnosticsCapturesPlatformLogsAndHealthHistory(t *testing.T) {
	const containerID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	root := t.TempDir()
	generation := strings.Repeat("f", 40)
	runner := &recordingRunner{results: func(args []string) (Result, error) {
		switch {
		case len(args) > 0 && args[0] == "compose" && slicesContain(args, "logs"):
			return Result{Stdout: "platform booted\n", Stderr: "migration warning\n"}, nil
		case len(args) > 0 && args[0] == "compose" && slicesContain(args, "ps"):
			return Result{Stdout: containerID + "\n"}, nil
		case len(args) > 0 && args[0] == "inspect":
			return Result{Stdout: `{"Status":"unhealthy","FailingStreak":3,"Log":[{"ExitCode":1,"Output":"database rejected startup"}]}` + "\n"}, nil
		default:
			return Result{}, fmt.Errorf("unexpected Docker arguments: %v", args)
		}
	}}
	docker := DockerCLI{
		Runner: runner, Binary: "docker", ComposeProject: "ubitech-agent",
		GenerationDir: root,
	}
	diagnostic := docker.CandidateFailureDiagnostics(
		context.Background(),
		release.Manifest{SourceCommit: generation},
	)
	for _, expected := range []string{
		"platform compose logs:",
		"platform booted",
		"migration warning",
		"platform Docker healthcheck:",
		"container_id=" + containerID,
		`"Status":"unhealthy"`,
		"database rejected startup",
	} {
		if !strings.Contains(diagnostic, expected) {
			t.Fatalf("candidate diagnostic is missing %q:\n%s", expected, diagnostic)
		}
	}
	if len(runner.calls) != 3 {
		t.Fatalf("candidate diagnostic made %d calls, want 3: %#v", len(runner.calls), runner.calls)
	}
	envFile := filepath.Join(root, generation, "compose.env")
	logs := strings.Join(runner.calls[2].args, " ")
	for _, expected := range []string{
		"--env-file " + envFile,
		"logs --no-color --timestamps --tail 200 platform",
	} {
		if !strings.Contains(logs, expected) {
			t.Fatalf("Platform log command is missing %q: %s", expected, logs)
		}
	}
	if got := runner.calls[1].args; !reflect.DeepEqual(got, []string{"inspect", "--format", "{{json .State.Health}}", containerID}) {
		t.Fatalf("unexpected Platform health inspect: %v", got)
	}
}

func TestCandidateFailureDiagnosticsBoundsSuccessAndCollectionFailures(t *testing.T) {
	const containerID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	generation := strings.Repeat("e", 40)

	t.Run("oversized command output", func(t *testing.T) {
		runner := &recordingRunner{results: func(args []string) (Result, error) {
			switch {
			case len(args) > 0 && args[0] == "compose" && slicesContain(args, "logs"):
				return Result{Stdout: strings.Repeat("log-output\n", 20_000)}, nil
			case len(args) > 0 && args[0] == "compose" && slicesContain(args, "ps"):
				return Result{Stdout: containerID}, nil
			case len(args) > 0 && args[0] == "inspect":
				return Result{Stdout: strings.Repeat("health-output\n", 10_000)}, nil
			default:
				return Result{}, nil
			}
		}}
		diagnostic := (DockerCLI{Runner: runner, Binary: "docker", ComposeProject: "ubitech-agent", GenerationDir: t.TempDir()}).CandidateFailureDiagnostics(
			context.Background(),
			release.Manifest{SourceCommit: generation},
		)
		if len(diagnostic) > candidateDiagnosticMaxBytes {
			t.Fatalf("candidate diagnostic has %d bytes, limit is %d", len(diagnostic), candidateDiagnosticMaxBytes)
		}
		if strings.Count(diagnostic, "diagnostic truncated") < 2 {
			t.Fatalf("oversized log and health output were not independently bounded:\n%s", diagnostic)
		}
		if !strings.Contains(diagnostic, "platform compose logs:") || !strings.Contains(diagnostic, "platform Docker healthcheck:") {
			t.Fatalf("bounded diagnostic lost a section heading:\n%s", diagnostic)
		}
	})

	t.Run("Docker command failures", func(t *testing.T) {
		hugeFailure := strings.Repeat("daemon unavailable ", 10_000)
		runner := &recordingRunner{results: func(args []string) (Result, error) {
			if len(args) > 0 && args[0] == "compose" && slicesContain(args, "logs") {
				return Result{Stderr: hugeFailure}, errors.New(hugeFailure)
			}
			if len(args) > 0 && args[0] == "compose" && slicesContain(args, "ps") {
				return Result{Stderr: hugeFailure}, errors.New(hugeFailure)
			}
			return Result{}, nil
		}}
		diagnostic := (DockerCLI{Runner: runner, Binary: "docker", ComposeProject: "ubitech-agent", GenerationDir: t.TempDir()}).CandidateFailureDiagnostics(
			context.Background(),
			release.Manifest{SourceCommit: generation},
		)
		if len(diagnostic) > candidateDiagnosticMaxBytes {
			t.Fatalf("failed collection diagnostic has %d bytes, limit is %d", len(diagnostic), candidateDiagnosticMaxBytes)
		}
		for _, expected := range []string{"platform compose logs:", "command_error:", "platform Docker healthcheck:", "container lookup failed:", "diagnostic truncated"} {
			if !strings.Contains(diagnostic, expected) {
				t.Fatalf("failed collection diagnostic is missing %q:\n%s", expected, diagnostic)
			}
		}
		if len(runner.calls) != 2 {
			t.Fatalf("health inspection should stop after a failed lookup: %#v", runner.calls)
		}
	})
}

func TestCandidateFailureDiagnosticsRedactsKnownAndPatternCredentials(t *testing.T) {
	const containerID = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	generation := strings.Repeat("d", 40)
	stateDir := t.TempDir()
	secretsDir := filepath.Join(stateDir, "secrets")
	if err := os.MkdirAll(secretsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	known := strings.Repeat("k", 40)
	if err := os.WriteFile(filepath.Join(secretsDir, "manager-token"), []byte(known+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runner := &recordingRunner{results: func(args []string) (Result, error) {
		switch {
		case len(args) > 0 && args[0] == "compose" && slicesContain(args, "logs"):
			return Result{Stdout: strings.Join([]string{
				"manager capability=" + known,
				`{"api_key":"third-party-json-secret"}`,
				"Authorization: Basic opaque-header-token",
				"worker --password plain-command-secret",
				"Set-Cookie: sid=cookie-secret; HttpOnly",
				"-----BEGIN PRIVATE KEY-----\nprivate-key-secret\n-----END PRIVATE KEY-----",
			}, "\n")}, nil
		case len(args) > 0 && args[0] == "compose" && slicesContain(args, "ps"):
			return Result{Stdout: containerID}, nil
		case len(args) > 0 && args[0] == "inspect":
			return Result{Stdout: `{"Status":"unhealthy","Log":[{"Output":"token=health-secret"}]}`}, nil
		default:
			return Result{}, nil
		}
	}}
	diagnostic := (DockerCLI{
		Runner: runner, Binary: "docker", ComposeProject: "ubitech-agent",
		GenerationDir: t.TempDir(), StateDir: stateDir,
	}).CandidateFailureDiagnostics(context.Background(), release.Manifest{SourceCommit: generation})
	for _, secret := range []string{known, "third-party-json-secret", "opaque-header-token", "plain-command-secret", "cookie-secret", "private-key-secret", "health-secret"} {
		if strings.Contains(diagnostic, secret) {
			t.Fatalf("candidate diagnostic leaked %q:\n%s", secret, diagnostic)
		}
	}
	if strings.Count(diagnostic, "[redacted]") < 7 {
		t.Fatalf("candidate diagnostic did not retain redaction markers:\n%s", diagnostic)
	}
}

func TestCandidateFailureDiagnosticsRejectsInvalidGenerationWithoutDocker(t *testing.T) {
	runner := &recordingRunner{}
	diagnostic := (DockerCLI{Runner: runner}).CandidateFailureDiagnostics(
		context.Background(),
		release.Manifest{SourceCommit: "../../outside"},
	)
	if !strings.Contains(diagnostic, "generation ID is invalid") || len(runner.calls) != 0 {
		t.Fatalf("invalid candidate generation reached Docker: diagnostic=%q calls=%#v", diagnostic, runner.calls)
	}
}

func slicesContain(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func TestActiveEnvironmentUsesDurableGenerationPointer(t *testing.T) {
	root := t.TempDir()
	docker := DockerCLI{StateDir: filepath.Join(root, "manager"), GenerationDir: filepath.Join(root, "manager", "releases")}
	oldID := strings.Repeat("a", 40)
	newID := strings.Repeat("b", 40)
	for _, id := range []string{oldID, newID} {
		dir := filepath.Join(docker.GenerationDir, id)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		for _, name := range []string{"manifest.json", "compose.yaml", "compose.env"} {
			if err := os.WriteFile(filepath.Join(dir, name), []byte(id+"\n"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}
	// The unrelated candidate is deliberately newer; mtimes must not select it.
	future := time.Now().Add(time.Hour)
	if err := os.Chtimes(filepath.Join(docker.GenerationDir, newID, "compose.env"), future, future); err != nil {
		t.Fatal(err)
	}
	if err := docker.setActiveGeneration(oldID); err != nil {
		t.Fatal(err)
	}
	active, err := docker.activeEnvironment()
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(docker.GenerationDir, oldID, "compose.env")
	if active != want {
		t.Fatalf("active generation was guessed from mtime: got %s want %s", active, want)
	}
}

func TestEnsureCoreNetworkFailsClosedForUnownedNetwork(t *testing.T) {
	runner := &recordingRunner{results: func(args []string) (Result, error) {
		return Result{Stdout: "bridge \n"}, nil
	}}
	docker := DockerCLI{Runner: runner, Binary: "docker", CoreNetwork: "ubitech-agent-core"}
	if err := docker.EnsureCoreNetwork(context.Background()); err == nil {
		t.Fatal("expected an existing unowned network to be rejected")
	}
	if len(runner.calls) != 1 {
		t.Fatalf("unowned network must not be modified: %#v", runner.calls)
	}
}

func TestEnsureCoreNetworkCreatesMissingManagedBridge(t *testing.T) {
	runner := &recordingRunner{results: func(args []string) (Result, error) {
		if len(args) > 1 && args[0] == "network" && args[1] == "inspect" {
			return Result{}, errors.New("not found")
		}
		return Result{}, nil
	}}
	docker := DockerCLI{Runner: runner, Binary: "docker", CoreNetwork: "ubitech-agent-core"}
	if err := docker.EnsureCoreNetwork(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(runner.calls[1].args, " "); got != "network create --driver bridge --label org.ubitech.agent.network=core ubitech-agent-core" {
		t.Fatalf("unexpected network creation: %s", got)
	}
}
