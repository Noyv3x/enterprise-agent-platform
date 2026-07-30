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

	"github.com/ubitech/agent-platform/manager/internal/contract"
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

type pullTestRunner struct {
	calls   [][]string
	present map[string]bool
	pull    func(context.Context, string, func()) (Result, error)
}

func (r *pullTestRunner) Run(_ context.Context, _ string, args []string, _ []string) (Result, error) {
	if reflect.DeepEqual(args, []string{"info", "--format", "{{.DockerRootDir}}"}) {
		return Result{Stdout: os.TempDir() + "\n"}, nil
	}
	r.calls = append(r.calls, append([]string(nil), args...))
	if len(args) >= 2 && args[0] == "image" && args[1] == "inspect" {
		image := args[len(args)-1]
		if r.present[image] {
			return Result{Stdout: fmt.Sprintf("[%q]\n", image)}, nil
		}
		return Result{Stderr: "Error response from daemon: No such image: " + image, ExitCode: 1}, errors.New("docker exited with 1")
	}
	return Result{}, nil
}

func pullTestDocker(runner Runner, idle, absolute time.Duration) DockerCLI {
	return DockerCLI{
		Runner: runner, Binary: "docker", PullIdleTimeout: idle, PullAbsoluteTimeout: absolute,
		FilesystemStat: func(context.Context, string) (CapacityFilesystemStat, error) {
			return CapacityFilesystemStat{BlockSize: 1, AvailableBlock: 1 << 40, Favail: 1 << 20, FilesystemID: "pull-test"}, nil
		},
	}
}

func (r *pullTestRunner) RunWithActivity(ctx context.Context, _ string, args []string, _ []string, activity func()) (Result, error) {
	r.calls = append(r.calls, append([]string(nil), args...))
	if r.pull == nil {
		return Result{}, nil
	}
	return r.pull(ctx, args[len(args)-1], activity)
}

func pullTestManifest() release.Manifest {
	return release.Manifest{Images: map[string]string{
		"platform":      "registry.example/platform@sha256:" + strings.Repeat("a", 64),
		"agent-runtime": "registry.example/runtime@sha256:" + strings.Repeat("b", 64),
		"agent-sandbox": "registry.example/sandbox@sha256:" + strings.Repeat("c", 64),
		"camofox":       "registry.example/camofox@sha256:" + strings.Repeat("d", 64),
		"firecrawl-api": "registry.example/firecrawl@sha256:" + strings.Repeat("e", 64),
		"searxng":       "registry.example/searxng@sha256:" + strings.Repeat("f", 64),
	}}
}

func TestGenerationEnvironmentExcludesOpaqueExtraImages(t *testing.T) {
	root := t.TempDir()
	platform := "registry.example/platform@sha256:" + strings.Repeat("a", 64)
	opaque := "registry.example/future@sha256:" + strings.Repeat("b", 64)
	docker := DockerCLI{
		GenerationDir: filepath.Join(root, "releases"),
		DataRoot:      filepath.Join(root, "data"),
		StateDir:      filepath.Join(root, "manager"),
		UID:           os.Getuid(),
		GID:           os.Getgid(),
	}
	path, err := docker.writeGenerationEnvironment(release.Manifest{
		SourceCommit: strings.Repeat("c", 40),
		Images: map[string]string{
			"platform":       platform,
			"future-service": opaque,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(content), "UBITECH_PLATFORM_IMAGE="+platform+"\n") {
		t.Fatalf("managed platform image is absent from Compose environment: %s", content)
	}
	if strings.Contains(string(content), "FUTURE_SERVICE") || strings.Contains(string(content), opaque) {
		t.Fatalf("opaque image metadata entered Compose environment: %s", content)
	}
}

func TestPullSkipsExactLocalDigestAndOnlyPullsMissingCoreImages(t *testing.T) {
	manifest := pullTestManifest()
	runner := &pullTestRunner{present: map[string]bool{manifest.Images["platform"]: true}}
	docker := pullTestDocker(runner, time.Second, 2*time.Second)
	if err := docker.Pull(context.Background(), manifest); err != nil {
		t.Fatal(err)
	}
	if len(runner.calls) != 4 {
		t.Fatalf("pull commands = %#v, want initial inspections, one ownership recheck, and one pull", runner.calls)
	}
	if got := runner.calls[0]; !reflect.DeepEqual(got, []string{"image", "inspect", "--format", "{{json .RepoDigests}}", manifest.Images["platform"]}) {
		t.Fatalf("platform inspection = %v", got)
	}
	if got := runner.calls[1]; !reflect.DeepEqual(got, []string{"image", "inspect", "--format", "{{json .RepoDigests}}", manifest.Images["agent-runtime"]}) {
		t.Fatalf("runtime inspection = %v", got)
	}
	if got := runner.calls[2]; !reflect.DeepEqual(got, []string{"image", "inspect", "--format", "{{json .RepoDigests}}", manifest.Images["agent-runtime"]}) {
		t.Fatalf("runtime ownership recheck = %v", got)
	}
	if got := runner.calls[3]; !reflect.DeepEqual(got, []string{"pull", manifest.Images["agent-runtime"]}) {
		t.Fatalf("runtime pull = %v", got)
	}
	joined := fmt.Sprint(runner.calls)
	for _, capability := range []string{"agent-sandbox", "camofox", "firecrawl-api", "searxng"} {
		if strings.Contains(joined, manifest.Images[capability]) {
			t.Fatalf("capability image %s entered the core pull path: %s", capability, joined)
		}
	}
}

func TestPullFailsAfterOutputIdleTimeoutWithLogicalImageName(t *testing.T) {
	manifest := pullTestManifest()
	returned := make(chan struct{})
	runner := &pullTestRunner{
		present: map[string]bool{},
		pull: func(ctx context.Context, _ string, _ func()) (Result, error) {
			defer close(returned)
			<-ctx.Done()
			return Result{}, ctx.Err()
		},
	}
	docker := pullTestDocker(runner, 250*time.Millisecond, 2*time.Second)
	started := time.Now()
	err := docker.Pull(context.Background(), manifest)
	if err == nil || !strings.Contains(err.Error(), "managed image platform") || !strings.Contains(err.Error(), "no output for 250ms") {
		t.Fatalf("idle pull error = %v", err)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("idle pull timeout took %s", elapsed)
	}
	select {
	case <-returned:
	default:
		t.Fatal("pull timeout returned before its command goroutine was reaped")
	}
}

func TestPullProgressRefreshesIdleDeadline(t *testing.T) {
	manifest := pullTestManifest()
	runner := &pullTestRunner{
		present: map[string]bool{manifest.Images["agent-runtime"]: true},
		pull: func(ctx context.Context, _ string, activity func()) (Result, error) {
			for index := 0; index < 5; index++ {
				select {
				case <-ctx.Done():
					return Result{}, ctx.Err()
				case <-time.After(25 * time.Millisecond):
					activity()
				}
			}
			return Result{}, nil
		},
	}
	docker := pullTestDocker(runner, 250*time.Millisecond, 2*time.Second)
	if err := docker.Pull(context.Background(), manifest); err != nil {
		t.Fatalf("progressing pull was treated as idle: %v", err)
	}
}

func TestPullAbsoluteLimitWinsDespiteContinuousProgress(t *testing.T) {
	manifest := pullTestManifest()
	runner := &pullTestRunner{
		present: map[string]bool{manifest.Images["agent-runtime"]: true},
		pull: func(ctx context.Context, _ string, activity func()) (Result, error) {
			ticker := time.NewTicker(25 * time.Millisecond)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return Result{}, ctx.Err()
				case <-ticker.C:
					activity()
				}
			}
		},
	}
	docker := pullTestDocker(runner, 250*time.Millisecond, 400*time.Millisecond)
	err := docker.Pull(context.Background(), manifest)
	if err == nil || !strings.Contains(err.Error(), "managed image platform") || !strings.Contains(err.Error(), "exceeded absolute limit 400ms") {
		t.Fatalf("absolute pull error = %v", err)
	}
}

func TestPullFailureRedactsCredentialsAndBoundsPersistedDiagnostic(t *testing.T) {
	manifest := pullTestManifest()
	secrets := []string{"bearer-secret", "database-secret", "cookie-secret"}
	diagnostic := "Authorization: Bearer " + secrets[0] +
		"\nPASSWORD=" + secrets[1] +
		"\n" + strings.Repeat("registry failure detail ", pullDiagnosticMaxBytes) +
		"\nSet-Cookie: session=" + secrets[2] + "; HttpOnly"
	runner := &pullTestRunner{
		present: map[string]bool{manifest.Images["agent-runtime"]: true},
		pull: func(context.Context, string, func()) (Result, error) {
			return Result{}, errors.New(diagnostic)
		},
	}
	docker := pullTestDocker(runner, time.Second, 2*time.Second)
	err := docker.Pull(context.Background(), manifest)
	if err == nil {
		t.Fatal("credential-bearing pull failure unexpectedly succeeded")
	}
	message := err.Error()
	for _, secret := range secrets {
		if strings.Contains(message, secret) {
			t.Fatalf("pull failure leaked %q: %s", secret, message)
		}
	}
	if strings.Count(message, "[redacted]") < len(secrets) {
		t.Fatalf("pull failure did not retain every redaction marker: %s", message)
	}
	if !strings.Contains(message, "[diagnostic truncated;") {
		t.Fatalf("pull failure was not marked as truncated: %s", message)
	}
	if len(message) > pullDiagnosticMaxBytes+512 {
		t.Fatalf("pull failure exceeded its bounded diagnostic budget: %d bytes", len(message))
	}
}

func TestPullFailureRemovesOnlyNewExactCandidateImagesWithoutForce(t *testing.T) {
	manifest := pullTestManifest()
	platform := manifest.Images["platform"]
	runtimeImage := manifest.Images["agent-runtime"]
	platformPulled := false
	runner := &recordingRunner{results: func(args []string) (Result, error) {
		switch {
		case reflect.DeepEqual(args, []string{"info", "--format", "{{.DockerRootDir}}"}):
			return Result{Stdout: os.TempDir() + "\n"}, nil
		case len(args) >= 4 && args[0] == "image" && args[1] == "inspect" && args[3] == "{{json .RepoDigests}}":
			return Result{ExitCode: 1, Stderr: "No such image"}, errors.New("docker exited with 1")
		case reflect.DeepEqual(args, []string{"pull", platform}):
			platformPulled = true
			return Result{}, nil
		case reflect.DeepEqual(args, []string{"pull", runtimeImage}):
			return Result{ExitCode: 1, Stderr: "registry unavailable"}, errors.New("docker exited with 1")
		case reflect.DeepEqual(args, []string{"ps", "--all", "--quiet", "--no-trunc"}):
			return Result{}, nil
		case len(args) >= 4 && args[0] == "image" && args[1] == "inspect" && args[3] == "{{.Id}}":
			if args[4] == platform && platformPulled {
				return Result{Stdout: "sha256:" + strings.Repeat("c", 64)}, nil
			}
			return Result{ExitCode: 1, Stderr: "No such image"}, errors.New("docker exited with 1")
		case reflect.DeepEqual(args, []string{"image", "rm", platform}):
			return Result{}, nil
		default:
			return Result{}, fmt.Errorf("unexpected command: %v", args)
		}
	}}
	docker := pullTestDocker(runner, time.Second, 2*time.Second)
	err := docker.Pull(context.Background(), manifest)
	if err == nil || !strings.Contains(err.Error(), "managed image agent-runtime") {
		t.Fatalf("pull failure = %v", err)
	}
	foundRemoval := false
	for _, call := range runner.calls {
		if reflect.DeepEqual(call.args, []string{"image", "rm", platform}) {
			foundRemoval = true
		}
		if strings.Contains(strings.Join(call.args, " "), "--force") {
			t.Fatalf("candidate cleanup forced a removal: %v", call.args)
		}
	}
	if !foundRemoval {
		t.Fatalf("new candidate image was not cleaned after the later pull failed: %#v", runner.calls)
	}
}

func TestEnsureSandboxUsesRootEntrypointAndExecUsesMappedUser(t *testing.T) {
	image := "sandbox@sha256:" + strings.Repeat("a", 64)
	runner := &recordingRunner{results: func(args []string) (Result, error) {
		if len(args) > 1 && args[0] == "image" && args[1] == "inspect" {
			return Result{Stdout: fmt.Sprintf("[%q]", image)}, nil
		}
		if len(args) > 0 && args[0] == "inspect" {
			return Result{}, errors.New("not found")
		}
		return Result{}, nil
	}}
	docker := DockerCLI{Runner: runner, Binary: "docker"}
	spec := SandboxSpec{
		ContainerName: "ubitech-sandbox-test",
		AgentHash:     "abc",
		Image:         image,
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
	image := "sandbox@sha256:" + strings.Repeat("a", 64)
	runner := &recordingRunner{results: func(args []string) (Result, error) {
		switch args[0] {
		case "image":
			return Result{Stdout: fmt.Sprintf("[%q]", image)}, nil
		case "inspect":
			return Result{}, errors.New("not found")
		case "start":
			return Result{}, errors.New("entrypoint failed")
		default:
			return Result{}, nil
		}
	}}
	docker := DockerCLI{Runner: runner, Binary: "docker"}
	spec := SandboxSpec{ContainerName: "ubitech-sandbox-test", AgentHash: "abc", Image: image, Network: "core", Workspace: "/data/workspace", Home: "/data/home", Environment: "/data/env", UID: 12345, GID: 23456}
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

func TestEnsureSandboxPullsMissingExactImageBeforeCreate(t *testing.T) {
	const image = "registry.example/sandbox@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	root := t.TempDir()
	runner := &recordingRunner{results: func(args []string) (Result, error) {
		if reflect.DeepEqual(args, []string{"info", "--format", "{{.DockerRootDir}}"}) {
			return Result{Stdout: root + "\n"}, nil
		}
		switch args[0] {
		case "inspect":
			return Result{}, errors.New("container not found")
		case "image":
			return Result{Stderr: "No such image", ExitCode: 1}, errors.New("image not found")
		default:
			return Result{}, nil
		}
	}}
	docker := DockerCLI{
		Runner: runner, Binary: "docker", DataRoot: root,
		PullIdleTimeout: time.Second, PullAbsoluteTimeout: 2 * time.Second,
		FilesystemStat: func(context.Context, string) (CapacityFilesystemStat, error) {
			return CapacityFilesystemStat{BlockSize: 1, AvailableBlock: 32 << 30, Favail: 10000, FilesystemID: "test"}, nil
		},
	}
	spec := SandboxSpec{
		ContainerName: "ubitech-sandbox-test", AgentHash: "abc", Image: image,
		Network: "core", Workspace: "/data/workspace", Home: "/data/home",
		Environment: "/data/env", UID: 12345, GID: 23456,
	}
	if _, err := docker.EnsureSandboxWithResult(context.Background(), spec); err != nil {
		t.Fatal(err)
	}
	var commands []string
	for _, call := range runner.calls {
		commands = append(commands, strings.Join(call.args, " "))
	}
	joined := strings.Join(commands, "\n")
	for _, required := range []string{
		"image inspect --format {{json .RepoDigests}} " + image,
		"pull " + image,
		"create --name " + spec.ContainerName,
		"start " + spec.ContainerName,
	} {
		if !strings.Contains(joined, required) {
			t.Fatalf("sandbox image lifecycle lacks %q:\n%s", required, joined)
		}
	}
	if strings.Index(joined, "pull "+image) > strings.Index(joined, "create --name "+spec.ContainerName) {
		t.Fatalf("sandbox was created before its image was available:\n%s", joined)
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

func TestReconcileFirecrawlStartsPostgreSQLStackOnce(t *testing.T) {
	runner := &recordingRunner{}
	docker := DockerCLI{Runner: runner, Binary: "docker", ComposeFile: "/release/compose.yaml", ComposeProject: "ubitech-agent"}
	if err := docker.reconcileFirecrawl(context.Background(), "/state/compose.env"); err != nil {
		t.Fatal(err)
	}
	if len(runner.calls) != 1 {
		t.Fatalf("Firecrawl reconciliation made %d calls, want one: %#v", len(runner.calls), runner.calls)
	}
	command := strings.Join(runner.calls[0].args, " ")
	if !strings.Contains(command, "up --detach --wait --wait-timeout 600 firecrawl-api") {
		t.Fatalf("unexpected Firecrawl start command: %s", command)
	}
	if strings.Contains(strings.ToLower(command), "foundationdb") {
		t.Fatalf("PostgreSQL Firecrawl start referenced FoundationDB: %s", command)
	}
}

func TestReconcileFirecrawlReportsFailureWithoutMutatingServices(t *testing.T) {
	services := []string{
		"firecrawl-playwright", "firecrawl-redis", "firecrawl-rabbitmq",
		"firecrawl-postgres", "firecrawl-api",
	}
	ids := make(map[string]string, len(services))
	for index, service := range services {
		ids[service] = strings.Repeat(string("abcdef0123456789"[index]), 64)
	}
	starts := 0
	runner := &recordingRunner{results: func(args []string) (Result, error) {
		joined := strings.Join(args, " ")
		switch {
		case strings.Contains(joined, " up --detach --wait --wait-timeout 600 firecrawl-api"):
			starts++
			return Result{}, errors.New("Firecrawl API is unhealthy")
		case slicesContain(args, "logs"):
			return Result{Stdout: "api failed"}, nil
		case slicesContain(args, "ps"):
			return Result{Stdout: ids[args[len(args)-1]]}, nil
		case len(args) > 0 && args[0] == "inspect":
			return Result{Stdout: `{}`}, nil
		}
		return Result{}, nil
	}}
	docker := DockerCLI{Runner: runner, Binary: "docker", ComposeFile: "/release/compose.yaml", ComposeProject: "ubitech-agent"}
	err := docker.reconcileFirecrawl(context.Background(), "/state/compose.env")
	if err == nil || !strings.Contains(err.Error(), "start Firecrawl PostgreSQL stack: Firecrawl API is unhealthy") || !strings.Contains(err.Error(), "api failed") {
		t.Fatalf("reconcileFirecrawl() error = %v", err)
	}
	if starts != 1 {
		t.Fatalf("failed Firecrawl start was attempted %d times in one reconciliation, want one", starts)
	}
	for _, call := range runner.calls {
		joined := strings.Join(call.args, " ")
		if strings.Contains(joined, " rm ") || strings.Contains(joined, " restart ") || strings.Contains(strings.ToLower(joined), "foundationdb") {
			t.Fatalf("failed PostgreSQL Firecrawl reconciliation mutated services: %s", joined)
		}
	}
}

func TestStartFixedOnlyStartsCoreServices(t *testing.T) {
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
	runner := &recordingRunner{results: func(args []string) (Result, error) {
		switch {
		case len(args) > 1 && args[0] == "network" && args[1] == "inspect":
			return Result{Stdout: "bridge core\n"}, nil
		default:
			return Result{}, nil
		}
	}}
	docker := DockerCLI{
		Runner: runner, Binary: "docker", ComposeProject: "ubitech-agent",
		GenerationDir: filepath.Join(root, "releases"), DataRoot: filepath.Join(root, "data-root"),
		StateDir: stateDir, CoreNetwork: "ubitech-agent-core",
	}
	if err := docker.StartFixed(context.Background(), release.Manifest{SourceCommit: generation, Images: map[string]string{}}); err != nil {
		t.Fatalf("StartFixed() failed to start core services: %v", err)
	}
	var commands []string
	for _, call := range runner.calls {
		commands = append(commands, strings.Join(call.args, " "))
	}
	joined := strings.Join(commands, "\n")
	if !strings.Contains(joined, " up --detach --wait platform agent-runtime") {
		t.Fatalf("StartFixed() did not wait for the two core services: %s", joined)
	}
	for _, capability := range []string{"camofox", "searxng", "firecrawl"} {
		if strings.Contains(joined, " up --detach "+capability) || strings.Contains(joined, " "+capability+" ") {
			t.Fatalf("StartFixed() synchronously attempted capability %s: %s", capability, joined)
		}
	}
}

func TestReconcileCapabilitiesRetriesEveryServiceAndJoinsFailures(t *testing.T) {
	root := t.TempDir()
	generation := strings.Repeat("b", 40)
	releaseDir := filepath.Join(root, "releases", generation)
	if err := os.MkdirAll(releaseDir, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"manifest.json", "compose.yaml"} {
		if err := os.WriteFile(filepath.Join(releaseDir, name), []byte("test\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	attempts := map[string]int{}
	runner := &recordingRunner{results: func(args []string) (Result, error) {
		joined := strings.Join(args, " ")
		if len(args) >= 2 && args[0] == "image" && args[1] == "inspect" {
			return Result{Stdout: "[\"" + args[len(args)-1] + "\"]\n"}, nil
		}
		for _, service := range capabilityServices {
			if strings.Contains(joined, " up --detach "+service) {
				attempts[service]++
				if attempts[service] == 1 {
					return Result{}, fmt.Errorf("%s transient failure", service)
				}
				return Result{}, nil
			}
		}
		return Result{}, fmt.Errorf("unexpected Docker arguments: %v", args)
	}}
	docker := DockerCLI{
		Runner: runner, Binary: "docker", ComposeProject: "ubitech-agent",
		GenerationDir: filepath.Join(root, "releases"), DataRoot: filepath.Join(root, "data-root"),
		StateDir: filepath.Join(root, "manager"), CoreNetwork: "ubitech-agent-core",
	}
	manifest := release.Manifest{SourceCommit: generation, Images: map[string]string{
		"camofox": "registry/camofox@sha256:" + strings.Repeat("c", 64),
		"searxng": "registry/searxng@sha256:" + strings.Repeat("d", 64),
	}}
	firstErr := docker.ReconcileCapabilities(context.Background(), manifest)
	if firstErr == nil || !strings.Contains(firstErr.Error(), "start capability service camofox: camofox transient failure") ||
		!strings.Contains(firstErr.Error(), "start capability service searxng: searxng transient failure") {
		t.Fatalf("ReconcileCapabilities() did not join independent failures: %v", firstErr)
	}
	if err := docker.ReconcileCapabilities(context.Background(), manifest); err != nil {
		t.Fatalf("ReconcileCapabilities() did not converge on retry: %v", err)
	}
	for _, service := range capabilityServices {
		if attempts[service] != 2 {
			t.Fatalf("capability service %s attempts = %d, want 2", service, attempts[service])
		}
	}
	for _, call := range runner.calls {
		joined := strings.Join(call.args, " ")
		if strings.Contains(joined, "--wait") || strings.Contains(joined, "firecrawl") {
			t.Fatalf("capability reconciliation crossed its lifecycle boundary: %s", joined)
		}
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
	services := []string{"platform", "agent-runtime"}
	ids := map[string]string{}
	states := map[string]string{}
	images := map[string]string{}
	hexDigits := "abcdef0123456789"
	for index, service := range services {
		id := strings.Repeat(string(hexDigits[index]), 64)
		ids[service] = id
		states[id] = "running healthy\n"
		images[service] = "registry.example/" + service + "@sha256:" + strings.Repeat(string(hexDigits[index+2]), 64)
	}
	runner := &recordingRunner{results: func(args []string) (Result, error) {
		if len(args) > 0 && args[0] == "compose" && slicesContain(args, "ps") {
			service := args[len(args)-1]
			id, ok := ids[service]
			if !ok {
				t.Fatalf("Probe() inspected capability service %q", service)
			}
			return Result{Stdout: id + "\n"}, nil
		}
		if len(args) > 0 && args[0] == "inspect" {
			if slicesContain(args, "{{.Config.Image}}\t{{index .Config.Labels \"com.docker.compose.project\"}}\t{{index .Config.Labels \"com.docker.compose.service\"}}") {
				id := args[len(args)-1]
				for service, serviceID := range ids {
					if id == serviceID {
						return Result{Stdout: images[service] + "\tubitech-agent\t" + service + "\n"}, nil
					}
				}
			}
			return Result{Stdout: states[args[len(args)-1]]}, nil
		}
		return Result{}, nil
	}}
	docker := DockerCLI{
		Runner: runner, Binary: "docker", ComposeFile: "/release/compose.yaml",
		ComposeProject: "ubitech-agent", GenerationDir: t.TempDir(),
	}
	manifest := release.Manifest{SourceCommit: strings.Repeat("f", 40), Images: images}
	if err := docker.Probe(context.Background(), manifest); err != nil {
		t.Fatal(err)
	}
	if len(runner.calls) != len(services)*3 {
		t.Fatalf("probe made %d calls, want %d: %#v", len(runner.calls), len(services)*3, runner.calls)
	}
	for index, service := range services {
		list := strings.Join(runner.calls[index*3].args, " ")
		if !strings.Contains(list, " ps --all --quiet "+service) {
			t.Fatalf("service %s was not listed including stopped and duplicate containers: %s", service, list)
		}
		inspect := runner.calls[index*3+1].args
		if inspect[0] != "inspect" || inspect[len(inspect)-1] != ids[service] {
			t.Fatalf("service %s container was not inspected directly: %v", service, inspect)
		}
		identity := runner.calls[index*3+2].args
		if identity[0] != "inspect" || identity[len(identity)-1] != ids[service] || !strings.Contains(strings.Join(identity, " "), "com.docker.compose.project") {
			t.Fatalf("service %s immutable identity was not inspected: %v", service, identity)
		}
	}
}

func TestFixedServiceStatusReportsFirecrawlComponentsIndependently(t *testing.T) {
	services := []string{
		"platform", "agent-runtime", "camofox", "searxng",
		"firecrawl-playwright", "firecrawl-redis", "firecrawl-rabbitmq", "firecrawl-postgres",
		"firecrawl-api",
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
	if len(status) != len(services) {
		t.Fatalf("fixed service status exposed %d services, want %d: %#v", len(status), len(services), status)
	}
	for _, retired := range []string{"firecrawl-foundationdb", "firecrawl-foundationdb-init"} {
		if _, exists := status[retired]; exists {
			t.Fatalf("fixed service status exposed retired service %s", retired)
		}
	}
	if status["firecrawl-redis"].Status != "unavailable" ||
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
			manifest := release.Manifest{SourceCommit: strings.Repeat("f", 40), Images: map[string]string{
				"platform":      "registry.example/platform@sha256:" + strings.Repeat("c", 64),
				"agent-runtime": "registry.example/runtime@sha256:" + strings.Repeat("d", 64),
			}}
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

func TestCheckCapacityRejectsLowDiskBeforePull(t *testing.T) {
	root := t.TempDir()
	runner := &recordingRunner{results: func(args []string) (Result, error) {
		if reflect.DeepEqual(args, []string{"info", "--format", "{{.DockerRootDir}}"}) {
			return Result{Stdout: root + "\n"}, nil
		}
		return Result{}, nil
	}}
	docker := DockerCLI{
		Runner:   runner,
		DataRoot: root,
		FilesystemStat: func(_ context.Context, _ string) (CapacityFilesystemStat, error) {
			return CapacityFilesystemStat{BlockSize: 4096, AvailableBlock: 1024, Favail: 10000, FilesystemID: "same"}, nil
		},
	}
	if err := docker.CheckCapacity(context.Background(), CapacityPreCutover, release.Manifest{}); err == nil || !strings.Contains(err.Error(), "insufficient free space") {
		t.Fatalf("low disk capacity was accepted: %v", err)
	}
}

func TestPrepareManagedImageAppliesCapacityGateBeforeSandboxPull(t *testing.T) {
	root := t.TempDir()
	image := "registry.example/sandbox@sha256:" + strings.Repeat("a", 64)
	runner := &recordingRunner{results: func(args []string) (Result, error) {
		switch {
		case len(args) >= 2 && args[0] == "image" && args[1] == "inspect":
			return Result{ExitCode: 1, Stderr: "No such image"}, errors.New("not found")
		case reflect.DeepEqual(args, []string{"info", "--format", "{{.DockerRootDir}}"}):
			return Result{Stdout: root + "\n"}, nil
		default:
			return Result{}, fmt.Errorf("unexpected command: %v", args)
		}
	}}
	docker := DockerCLI{
		Runner: runner, DataRoot: root,
		FilesystemStat: func(context.Context, string) (CapacityFilesystemStat, error) {
			return CapacityFilesystemStat{BlockSize: 1, AvailableBlock: 19 << 30, Favail: 10000, FilesystemID: "same"}, nil
		},
	}
	err := docker.PrepareManagedImage(context.Background(), "agent-sandbox", image)
	if !IsInsufficientCapacity(err) {
		t.Fatalf("low-capacity Sandbox image preparation error = %v", err)
	}
	for _, call := range runner.calls {
		if len(call.args) > 0 && call.args[0] == "pull" {
			t.Fatalf("Sandbox image was pulled before the capacity gate: %#v", runner.calls)
		}
	}
}

func TestPrepareManagedImageSkipsCapacityProbeForExactLocalDigest(t *testing.T) {
	image := "registry.example/sandbox@sha256:" + strings.Repeat("b", 64)
	runner := &recordingRunner{results: func(args []string) (Result, error) {
		if len(args) >= 2 && args[0] == "image" && args[1] == "inspect" {
			return Result{Stdout: "[\"" + image + "\"]\n"}, nil
		}
		return Result{}, fmt.Errorf("unexpected command: %v", args)
	}}
	if err := (DockerCLI{Runner: runner}).PrepareManagedImage(context.Background(), "agent-sandbox", image); err != nil {
		t.Fatalf("exact local digest required unrelated free capacity: %v", err)
	}
	if len(runner.calls) != 1 {
		t.Fatalf("exact local digest caused extra Docker calls: %#v", runner.calls)
	}
}

func TestCheckCapacityRejectsLowAvailableInodes(t *testing.T) {
	root := t.TempDir()
	runner := &recordingRunner{results: func(args []string) (Result, error) {
		if reflect.DeepEqual(args, []string{"info", "--format", "{{.DockerRootDir}}"}) {
			return Result{Stdout: root + "\n"}, nil
		}
		return Result{}, nil
	}}
	docker := DockerCLI{
		Runner: runner, DataRoot: root,
		FilesystemStat: func(_ context.Context, _ string) (CapacityFilesystemStat, error) {
			return CapacityFilesystemStat{BlockSize: 4096, AvailableBlock: 10 << 20, Favail: 100, FilesystemID: "same"}, nil
		},
	}
	if err := docker.CheckCapacity(context.Background(), CapacityPreCutover, release.Manifest{}); err == nil || !strings.Contains(err.Error(), "insufficient free inodes") {
		t.Fatalf("low available inode capacity was accepted: %v", err)
	}
}

func TestCheckCapacityBudgetsOnlyMissingCoreDigests(t *testing.T) {
	root := t.TempDir()
	platform := "registry.example/platform@sha256:" + strings.Repeat("a", 64)
	runtimeImage := "registry.example/runtime@sha256:" + strings.Repeat("b", 64)
	runtimePresent := false
	runner := &recordingRunner{results: func(args []string) (Result, error) {
		switch {
		case reflect.DeepEqual(args, []string{"info", "--format", "{{.DockerRootDir}}"}):
			return Result{Stdout: root + "\n"}, nil
		case len(args) >= 4 && args[0] == "image" && args[1] == "inspect":
			image := args[len(args)-1]
			if image == platform || runtimePresent {
				return Result{Stdout: "[\"" + image + "\"]\n"}, nil
			}
			return Result{ExitCode: 1, Stderr: "Error: No such image"}, errors.New("docker exited with 1")
		default:
			return Result{}, fmt.Errorf("unexpected command: %v", args)
		}
	}}
	available := uint64(19 << 30)
	docker := DockerCLI{
		Runner: runner, DataRoot: root,
		FilesystemStat: func(_ context.Context, _ string) (CapacityFilesystemStat, error) {
			return CapacityFilesystemStat{BlockSize: 1, AvailableBlock: available, Favail: 10000, FilesystemID: "same"}, nil
		},
	}
	manifest := release.Manifest{Images: map[string]string{"platform": platform, "agent-runtime": runtimeImage}}
	err := docker.CheckCapacity(context.Background(), CapacityPreDownload, manifest)
	var capacityErr *CapacityError
	if !errors.As(err, &capacityErr) {
		t.Fatalf("missing runtime image did not produce a capacity error: %v", err)
	}
	want := uint64(20 << 30)
	if capacityErr.Require != want {
		t.Fatalf("required capacity = %d, want %d", capacityErr.Require, want)
	}
	runtimePresent = true
	if err := docker.CheckCapacity(context.Background(), CapacityPreDownload, manifest); err != nil {
		t.Fatalf("locally present digests still consumed pull budget: %v", err)
	}
}

func TestCheckCapacityAddsConservativeSnapshotBytesOnlyToDataFilesystem(t *testing.T) {
	root := t.TempDir()
	dockerRoot := filepath.Join(root, "docker")
	if err := os.MkdirAll(dockerRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	runner := &recordingRunner{results: func(args []string) (Result, error) {
		if reflect.DeepEqual(args, []string{"info", "--format", "{{.DockerRootDir}}"}) {
			return Result{Stdout: dockerRoot + "\n"}, nil
		}
		return Result{}, fmt.Errorf("unexpected command: %v", args)
	}}
	snapshotBytes := uint64(5 << 30)
	dataAvailable := uint64(contract.UpdatePreCutoverMinFreeBytes) + snapshotBytes - 1
	dockerAvailable := uint64(contract.UpdatePreCutoverMinFreeBytes)
	docker := DockerCLI{
		Runner: runner, DataRoot: root,
		SnapshotRequired: func(_ context.Context, path string) (uint64, error) {
			if path != filepath.Join(root, "data") {
				t.Fatalf("snapshot data path = %q", path)
			}
			return snapshotBytes, nil
		},
		FilesystemStat: func(_ context.Context, path string) (CapacityFilesystemStat, error) {
			if filepath.Clean(path) == filepath.Clean(root) {
				return CapacityFilesystemStat{BlockSize: 1, AvailableBlock: dataAvailable, Favail: 10000, FilesystemID: "data"}, nil
			}
			return CapacityFilesystemStat{BlockSize: 1, AvailableBlock: dockerAvailable, Favail: 10000, FilesystemID: "docker"}, nil
		},
	}
	err := docker.CheckCapacity(context.Background(), CapacityPreCutover, release.Manifest{})
	var capacityErr *CapacityError
	if !errors.As(err, &capacityErr) || capacityErr.Path != root || capacityErr.Require != uint64(contract.UpdatePreCutoverMinFreeBytes)+snapshotBytes {
		t.Fatalf("snapshot capacity failure = %#v / %v", capacityErr, err)
	}
	dataAvailable++
	if err := docker.CheckCapacity(context.Background(), CapacityPreCutover, release.Manifest{}); err != nil {
		t.Fatalf("sufficient per-filesystem snapshot capacity was rejected: %v", err)
	}
}

func TestCheckCapacityDeduplicatesSnapshotAndDockerOnSameFilesystem(t *testing.T) {
	root := t.TempDir()
	runner := &recordingRunner{results: func(args []string) (Result, error) {
		if reflect.DeepEqual(args, []string{"info", "--format", "{{.DockerRootDir}}"}) {
			return Result{Stdout: root + "\n"}, nil
		}
		return Result{}, fmt.Errorf("unexpected command: %v", args)
	}}
	snapshotBytes := uint64(3 << 30)
	want := uint64(contract.UpdatePreCutoverMinFreeBytes) + snapshotBytes
	docker := DockerCLI{
		Runner: runner, DataRoot: root,
		SnapshotRequired: func(context.Context, string) (uint64, error) { return snapshotBytes, nil },
		FilesystemStat: func(context.Context, string) (CapacityFilesystemStat, error) {
			return CapacityFilesystemStat{BlockSize: 1, AvailableBlock: want, Favail: 10000, FilesystemID: "same"}, nil
		},
	}
	if err := docker.CheckCapacity(context.Background(), CapacityPreCutover, release.Manifest{}); err != nil {
		t.Fatalf("same-filesystem requirements were summed twice: %v", err)
	}
}

func TestPruneManagedImagesKeepsContainerReferencesAndNeverForces(t *testing.T) {
	inUse := "registry.example/platform@sha256:" + strings.Repeat("a", 64)
	obsolete := "registry.example/runtime@sha256:" + strings.Repeat("b", 64)
	containerID := strings.Repeat("c", 64)
	inUseImageID := "sha256:" + strings.Repeat("d", 64)
	obsoleteImageID := "sha256:" + strings.Repeat("e", 64)
	runner := &recordingRunner{results: func(args []string) (Result, error) {
		switch {
		case reflect.DeepEqual(args, []string{"ps", "--all", "--quiet", "--no-trunc"}):
			return Result{Stdout: containerID + "\n"}, nil
		case len(args) > 0 && args[0] == "inspect":
			return Result{Stdout: inUse + "\t" + inUseImageID + "\n"}, nil
		case len(args) > 1 && args[0] == "image" && args[1] == "inspect":
			return Result{Stdout: obsoleteImageID + "\n"}, nil
		}
		return Result{}, nil
	}}
	disposition, err := (DockerCLI{Runner: runner}).PruneManagedImages(context.Background(), []string{inUse, obsolete}, map[string]struct{}{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if disposition[inUse] || !disposition[obsolete] {
		t.Fatalf("unexpected image dispositions: %#v", disposition)
	}
	if len(runner.calls) != 4 || !reflect.DeepEqual(runner.calls[3].args, []string{"image", "rm", obsolete}) {
		t.Fatalf("cleanup used an unsafe command sequence: %#v", runner.calls)
	}
}

func TestPruneManagedImagesProtectsContainerByResolvedImageID(t *testing.T) {
	candidate := "registry.example/platform@sha256:" + strings.Repeat("a", 64)
	containerID := strings.Repeat("b", 64)
	imageID := "sha256:" + strings.Repeat("c", 64)
	runner := &recordingRunner{results: func(args []string) (Result, error) {
		switch {
		case reflect.DeepEqual(args, []string{"ps", "--all", "--quiet", "--no-trunc"}):
			return Result{Stdout: containerID + "\n"}, nil
		case len(args) > 0 && args[0] == "inspect":
			return Result{Stdout: "registry.example/platform:local\t" + imageID + "\n"}, nil
		case len(args) > 1 && args[0] == "image" && args[1] == "inspect":
			return Result{Stdout: imageID + "\n"}, nil
		default:
			return Result{}, errors.New("unexpected mutation")
		}
	}}
	disposition, err := (DockerCLI{Runner: runner}).PruneManagedImages(context.Background(), []string{candidate}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if disposition[candidate] {
		t.Fatalf("container image ID consumer was ignored: %#v", disposition)
	}
	for _, call := range runner.calls {
		if len(call.args) > 1 && call.args[0] == "image" && call.args[1] == "rm" {
			t.Fatalf("in-use image was removed: %#v", runner.calls)
		}
	}
}
