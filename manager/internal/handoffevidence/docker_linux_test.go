//go:build linux

package handoffevidence

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"text/template"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/driver"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

type dockerProjectionFixture struct {
	listArgs []string
	object   string
	value    any
	calls    int
}

type dockerProjectionRunner struct {
	t        *testing.T
	fixtures map[string]*dockerProjectionFixture
}

func (runner *dockerProjectionRunner) Run(_ context.Context, name string, args []string, env []string) (driver.Result, error) {
	runner.t.Helper()
	if name != "docker" || len(env) != 0 || len(args) < 2 {
		runner.t.Fatalf("unexpected Docker invocation: name=%q args=%#v env=%#v", name, args, env)
	}
	fixture := runner.fixtures[args[0]]
	if fixture == nil {
		runner.t.Fatalf("unexpected Docker object kind: %#v", args)
	}
	fixture.calls++
	if args[1] == "ls" {
		if strings.Join(args, "\x00") != strings.Join(fixture.listArgs, "\x00") {
			runner.t.Fatalf("unexpected Docker list invocation: got=%#v want=%#v", args, fixture.listArgs)
		}
		return driver.Result{Stdout: fixture.object + "\n"}, nil
	}
	if len(args) != 5 || args[1] != "inspect" || args[2] != "--format" || args[4] != fixture.object {
		runner.t.Fatalf("unexpected Docker inspect invocation: %#v", args)
	}
	projection, err := template.New("docker-inspect").Funcs(template.FuncMap{
		"json": func(value any) (string, error) {
			encoded, encodeErr := json.Marshal(value)
			return string(encoded), encodeErr
		},
	}).Parse(args[3])
	if err != nil {
		runner.t.Fatalf("parse Docker inspect template: %v", err)
	}
	var output bytes.Buffer
	if err := projection.Execute(&output, fixture.value); err != nil {
		runner.t.Fatalf("render Docker inspect template: %v", err)
	}
	return driver.Result{Stdout: output.String() + "\n"}, nil
}

type dockerProjectionResult string

func (result dockerProjectionResult) Run(context.Context, string, []string, []string) (driver.Result, error) {
	return driver.Result{Stdout: string(result)}, nil
}

func TestDockerCLIParsesStructuredInspectProjections(t *testing.T) {
	containerID := strings.Repeat("a", 64)
	networkID := strings.Repeat("b", 64)
	special := "comma, bracket ], quote \" and slash \\, literal \\t, tab\t, newline\n"
	networks := map[string]json.RawMessage{"source-core": json.RawMessage(`{"Aliases":["alias,]"]}`)}
	mounts := []dockerMount{{Type: "bind", Source: "/source,]\t", Destination: "/target", RW: true}}
	runner := &dockerProjectionRunner{t: t, fixtures: map[string]*dockerProjectionFixture{
		"container": {
			listArgs: []string{"container", "ls", "--all", "--quiet", "--no-trunc"}, object: containerID,
			value: map[string]any{
				"Id": containerID, "Name": "/source-platform", "Image": strings.Repeat("c", 64),
				"Config":          map[string]any{"Image": "registry.invalid/platform@sha256:" + strings.Repeat("d", 64), "User": "", "Labels": map[string]string{"edge": special}},
				"State":           map[string]any{"Status": "running"},
				"NetworkSettings": map[string]any{"Networks": networks},
				"Mounts":          mounts,
			},
		},
		"network": {
			listArgs: []string{"network", "ls", "--quiet", "--no-trunc"}, object: networkID,
			value: map[string]any{"Id": networkID, "Name": "source-core", "Driver": "bridge", "Labels": map[string]string{"edge": special}},
		},
		"volume": {
			listArgs: []string{"volume", "ls", "--quiet"}, object: "source-volume",
			value: map[string]any{"Name": "source-volume", "Driver": "local", "Labels": map[string]string(nil)},
		},
	}}
	docker := DockerCLI{Binary: "docker", Runner: runner}

	containers, err := docker.containers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(containers) != 1 || containers[0].ID != containerID || containers[0].User != "" ||
		containers[0].Labels["edge"] != special || string(containers[0].Networks["source-core"]) != `{"Aliases":["alias,]"]}` ||
		len(containers[0].Mounts) != 1 || containers[0].Mounts[0] != mounts[0] {
		t.Fatalf("container projection changed structured or empty fields: %#v", containers)
	}
	networkValues, err := docker.networks(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(networkValues) != 1 || networkValues[0].ID != networkID || networkValues[0].Labels["edge"] != special {
		t.Fatalf("network projection changed escaped fields: %#v", networkValues)
	}
	volumes, err := docker.volumes(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(volumes) != 1 || volumes[0].Name != "source-volume" || volumes[0].Labels == nil || len(volumes[0].Labels) != 0 {
		t.Fatalf("volume projection did not normalize an empty label value: %#v", volumes)
	}
	for kind, fixture := range runner.fixtures {
		if fixture.calls != 2 {
			t.Fatalf("Docker %s projection used %d calls, want list plus inspect", kind, fixture.calls)
		}
	}
}

func TestDockerInspectRejectsInvalidStructuredProjection(t *testing.T) {
	tests := []struct {
		name    string
		output  string
		wantErr string
	}{
		{name: "missing element", output: `["one"]` + "\n", wantErr: "incomplete projection"},
		{name: "extra element", output: `["one","two","three"]` + "\n", wantErr: "incomplete projection"},
		{name: "trailing JSON", output: `["one","two"]` + "\n" + `["three","four"]` + "\n", wantErr: "invalid JSON projection"},
		{name: "literal escaped delimiter", output: `"one"\t"two"` + "\n", wantErr: "invalid JSON projection"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			docker := DockerCLI{Binary: "docker", Runner: dockerProjectionResult(test.output)}
			if _, err := docker.inspect(context.Background(), "container", strings.Repeat("a", 64), containerInspectProjection, 2); err == nil || !strings.Contains(err.Error(), test.wantErr) {
				t.Fatalf("invalid projection returned %v, want %q", err, test.wantErr)
			}
		})
	}
}

func TestDockerEvidenceReconcilesExactSourceAndTargetAbsence(t *testing.T) {
	source, target := identity.SourceProfile(), identity.TargetProfile()
	images := evidenceImages()
	containers := make([]dockerContainer, 0, len(fixedServices))
	for index, service := range fixedServices {
		containers = append(containers, dockerContainer{
			ID: strings.Repeat(string(rune('a'+index)), 64), Name: "/source-" + service,
			Image: images[service], Labels: map[string]string{
				"com.docker.compose.project": source.ComposeProject,
				"com.docker.compose.service": service,
			}, Networks: map[string]json.RawMessage{source.CoreNetwork: json.RawMessage(`{}`)},
		})
	}
	networks := []dockerNetwork{{
		ID: strings.Repeat("f", 64), Name: source.CoreNetwork, Driver: "bridge",
		Labels: map[string]string{source.Label("network"): "core"},
	}}
	value, err := reconcileDockerEvidence(DockerRequest{
		Source: source, Target: target, Images: images, PlatformDataRoot: "/data",
	}, containers, networks, []dockerVolume{{Name: "unrelated", Driver: "local", Labels: map[string]string{}}})
	if err != nil {
		t.Fatal(err)
	}
	if !value.SourceComposeOwned || !value.SourceCoreNetworkOwned || !value.TargetComposeAbsent ||
		!value.TargetCoreNetworkAbsent || !value.TargetLabelObjectsAbsent || !admissionSHA256.MatchString(value.InventorySHA256) {
		t.Fatalf("incomplete Docker evidence: %+v", value)
	}

	containers = append(containers, dockerContainer{
		ID: strings.Repeat("1", 64), Name: "/foreign", Image: images["platform"],
		Labels: map[string]string{target.Label("sandbox"): "true"}, Networks: map[string]json.RawMessage{},
	})
	value, err = reconcileDockerEvidence(DockerRequest{
		Source: source, Target: target, Images: images, PlatformDataRoot: "/data",
	}, containers, networks, nil)
	if err != nil {
		t.Fatal(err)
	}
	if value.TargetLabelObjectsAbsent {
		t.Fatal("target ownership label was accepted")
	}
}

func TestDockerEvidenceRejectsUnknownSourceComposeService(t *testing.T) {
	source, target := identity.SourceProfile(), identity.TargetProfile()
	_, err := reconcileDockerEvidence(DockerRequest{
		Source: source, Target: target, Images: evidenceImages(), PlatformDataRoot: "/data",
	}, []dockerContainer{{
		ID: strings.Repeat("a", 64), Name: "/unknown", Image: evidenceImages()["platform"],
		Labels:   map[string]string{"com.docker.compose.project": source.ComposeProject, "com.docker.compose.service": "future"},
		Networks: map[string]json.RawMessage{source.CoreNetwork: json.RawMessage(`{}`)},
	}}, nil, nil)
	if err == nil {
		t.Fatal("unknown source Compose service was accepted")
	}
}

func TestDockerEvidenceRequiresCompleteSchemaV1ImageCatalog(t *testing.T) {
	source, target := identity.SourceProfile(), identity.TargetProfile()
	valid := DockerRequest{Source: source, Target: target, Images: evidenceImages(), PlatformDataRoot: "/data"}
	if err := validateDockerRequest(valid); err != nil {
		t.Fatalf("complete schema-v1 catalog rejected: %v", err)
	}

	tests := map[string]func(map[string]string){
		"missing helper": func(images map[string]string) { delete(images, "handoff-fs-helper") },
		"unknown replacement": func(images map[string]string) {
			delete(images, "handoff-fs-helper")
			images["unknown"] = images["platform"]
		},
		"mutable helper": func(images map[string]string) { images["handoff-fs-helper"] = "registry.invalid/helper:latest" },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			images := evidenceImages()
			mutate(images)
			request := valid
			request.Images = images
			if err := validateDockerRequest(request); err == nil {
				t.Fatal("invalid schema-v1 image catalog was accepted")
			}
		})
	}
}

func TestDockerEvidenceRejectsCatalogOnlyImagesAsComposeServices(t *testing.T) {
	source, target := identity.SourceProfile(), identity.TargetProfile()
	for _, service := range catalogOnlyImages {
		t.Run(service, func(t *testing.T) {
			_, err := reconcileDockerEvidence(DockerRequest{
				Source: source, Target: target, Images: evidenceImages(), PlatformDataRoot: "/data",
			}, []dockerContainer{{
				ID: strings.Repeat("a", 64), Name: "/source-" + service, Image: evidenceImages()[service],
				Labels:   map[string]string{"com.docker.compose.project": source.ComposeProject, "com.docker.compose.service": service},
				Networks: map[string]json.RawMessage{source.CoreNetwork: json.RawMessage(`{}`)},
			}}, nil, nil)
			if err == nil {
				t.Fatal("catalog-only image was accepted as a source Compose service")
			}
		})
	}
}

func evidenceImages() map[string]string {
	values := map[string]string{}
	for index, service := range append(append([]string(nil), fixedServices...), catalogOnlyImages...) {
		digit := "abcdef0123"[index%10]
		values[service] = "registry.invalid/" + service + "@sha256:" + strings.Repeat(string(digit), 64)
	}
	return values
}
