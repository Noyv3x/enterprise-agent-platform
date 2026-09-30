package driver

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

func TestRetainImagesProtectsCommittedAndRunningImages(t *testing.T) {
	image := func(c string) string { return "registry.example/image@sha256:" + strings.Repeat(c, 64) }
	id := func(c string) string { return "sha256:" + strings.Repeat(c, 64) }
	manifest := func(c string) release.Manifest {
		return release.Manifest{SourceCommit: strings.Repeat(c, 40), Images: map[string]string{"agent-sandbox": image(c)}}
	}
	var removed []string
	running := true
	runner := &recordingRunner{results: func(args []string) (Result, error) {
		switch {
		case args[0] == "image" && args[1] == "inspect":
			return Result{Stdout: strings.Split(args[len(args)-1], "@")[1]}, nil
		case args[0] == "ps":
			if running {
				return Result{Stdout: strings.Repeat("f", 64)}, nil
			}
			return Result{}, nil
		case args[0] == "container":
			return Result{Stdout: fmt.Sprintf("%q", id("c"))}, nil
		case args[0] == "image" && args[1] == "rm":
			if len(args) != 3 {
				t.Fatalf("unsafe removal: %v", args)
			}
			removed = append(removed, args[2])
			return Result{}, nil
		default:
			t.Fatalf("unexpected Docker action: %v", args)
			return Result{}, nil
		}
	}}
	docker := DockerCLI{Runner: runner}
	retained := []release.Manifest{manifest("a"), manifest("b")}
	obsolete := []release.Manifest{manifest("a"), manifest("b"), manifest("c"), manifest("d")}
	deferred, err := docker.RetainImages(context.Background(), retained, obsolete)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(removed, []string{id("d")}) || !deferred[strings.Repeat("c", 40)] {
		t.Fatalf("removed=%v deferred=%v", removed, deferred)
	}
	running = false
	removed = nil
	deferred, err = docker.RetainImages(context.Background(), retained, []release.Manifest{manifest("c")})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(removed, []string{id("c")}) || len(deferred) != 0 {
		t.Fatalf("retired sandbox image not reclaimed: removed=%v deferred=%v", removed, deferred)
	}
}

func TestFirecrawlAbsentDoesNotInvokeDocker(t *testing.T) {
	runner := &recordingRunner{}
	docker := DockerCLI{Runner: runner}
	if err := docker.ReconcileFirecrawl(context.Background(), release.Manifest{Images: map[string]string{"platform": "unused"}}); err != nil {
		t.Fatal(err)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("absent Firecrawl invoked Docker: %v", runner.calls)
	}
}

func TestLegacyImageCapacityFallbackWithoutGeneratedMap(t *testing.T) {
	estimates := contract.ManagedImageCapacityEstimates
	contract.ManagedImageCapacityEstimates = nil
	defer func() { contract.ManagedImageCapacityEstimates = estimates }()
	image := "registry.example/firecrawl@sha256:" + strings.Repeat("a", 64)
	runner := &pullTestRunner{present: map[string]bool{}}
	docker := pullTestDocker(runner, time.Second, 2*time.Second)
	if err := docker.PrepareManagedImage(context.Background(), "firecrawl-api", image); err != nil {
		t.Fatal(err)
	}
	if !runner.present[image] {
		t.Fatal("legacy image not prepared without generated capacity entries")
	}
}

func TestReducedCatalogOmitsFirecrawlStatusAndProbes(t *testing.T) {
	root := t.TempDir()
	generation := strings.Repeat("a", 40)
	dir := filepath.Join(root, "releases", generation)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{
		"manifest.json": `{"images":{"platform":"present"}}`,
		"compose.yaml":  "services: {}",
		"compose.env":   "",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "active-generation"), []byte(generation), 0o600); err != nil {
		t.Fatal(err)
	}
	runner := &recordingRunner{}
	docker := DockerCLI{Runner: runner, StateDir: root, GenerationDir: filepath.Join(root, "releases")}
	status := docker.FixedServiceStatus(context.Background())
	for service := range status {
		if strings.HasPrefix(service, "firecrawl") {
			t.Fatalf("absent capability reported: %v", status)
		}
	}
	for _, call := range runner.calls {
		if strings.Contains(strings.Join(call.args, " "), "firecrawl") {
			t.Fatalf("absent capability probed: %v", call)
		}
	}
}
