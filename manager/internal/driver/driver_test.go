package driver

import (
	"context"
	"errors"
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
	services := []string{"platform", "agent-runtime", "camofox", "searxng"}
	ids := map[string]string{}
	states := map[string]string{}
	for index, service := range services {
		id := strings.Repeat(string(rune('a'+index)), 64)
		ids[service] = id
		states[id] = "running healthy\n"
	}
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
