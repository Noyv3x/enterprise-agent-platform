//go:build linux

package handoffevidence

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/driver"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/sandbox"
)

const (
	defaultMaxDockerEvidenceObjects = 1024
	containerInspectProjection      = `[{{json .Id}},{{json .Name}},{{json .Config.Image}},{{json .Image}},{{json .State.Status}},{{json .Config.User}},{{json .Config.Labels}},{{json .NetworkSettings.Networks}},{{json .Mounts}}]`
	networkInspectProjection        = `[{{json .Id}},{{json .Name}},{{json .Driver}},{{json .Labels}}]`
	volumeInspectProjection         = `[{{json .Name}},{{json .Driver}},{{json .Labels}}]`
)

var (
	dockerEvidenceID = regexp.MustCompile(`^[0-9a-f]{12,64}$`)
	dockerObjectName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$`)
	fixedServices    = []string{
		"platform", "agent-runtime", "camofox", "searxng", "firecrawl-api",
		"firecrawl-playwright", "firecrawl-postgres", "firecrawl-redis", "firecrawl-rabbitmq",
	}
	catalogOnlyImages = []string{"agent-sandbox", "handoff-fs-helper"}
)

type DockerCLI struct {
	Binary     string
	Runner     driver.Runner
	MaxObjects int
}

var _ DockerObserver = DockerCLI{}

type dockerContainer struct {
	ID       string
	Name     string
	Image    string
	ImageID  string
	Status   string
	User     string
	Labels   map[string]string
	Networks map[string]json.RawMessage
	Mounts   []dockerMount
}

type dockerMount struct {
	Type        string `json:"Type"`
	Source      string `json:"Source"`
	Destination string `json:"Destination"`
	RW          bool   `json:"RW"`
}

type dockerNetwork struct {
	ID     string
	Name   string
	Driver string
	Labels map[string]string
}

type dockerVolume struct {
	Name   string
	Driver string
	Labels map[string]string
}

func (docker DockerCLI) Observe(ctx context.Context, request DockerRequest) (DockerEvidence, error) {
	if err := validateDockerRequest(request); err != nil {
		return DockerEvidence{}, err
	}
	containers, err := docker.containers(ctx)
	if err != nil {
		return DockerEvidence{}, err
	}
	networks, err := docker.networks(ctx)
	if err != nil {
		return DockerEvidence{}, err
	}
	volumes, err := docker.volumes(ctx)
	if err != nil {
		return DockerEvidence{}, err
	}
	return reconcileDockerEvidence(request, containers, networks, volumes)
}

func validateDockerRequest(request DockerRequest) error {
	if request.Source.ProfileID == "" || request.Target.ProfileID == "" || request.Source.ProfileID == request.Target.ProfileID ||
		request.Source.ComposeProject == "" || request.Target.ComposeProject == "" || request.Source.CoreNetwork == "" || request.Target.CoreNetwork == "" ||
		!filepath.IsAbs(request.PlatformDataRoot) || filepath.Clean(request.PlatformDataRoot) != request.PlatformDataRoot {
		return errors.New("Docker evidence request has an invalid technical binding")
	}
	expected := append(append([]string(nil), fixedServices...), catalogOnlyImages...)
	if len(request.Images) != len(expected) {
		return errors.New("Docker evidence image set is not closed")
	}
	for _, service := range expected {
		image := request.Images[service]
		if !immutableImageReference(image) {
			return fmt.Errorf("Docker evidence image %q is not immutable", service)
		}
	}
	return nil
}

func reconcileDockerEvidence(request DockerRequest, containers []dockerContainer, networks []dockerNetwork, volumes []dockerVolume) (DockerEvidence, error) {
	targetLabelsAbsent, targetComposeAbsent := true, true
	sourceByService := map[string]dockerContainer{}
	sandboxByName := make(map[string]sandbox.Record, len(request.Sandboxes))
	for _, record := range request.Sandboxes {
		if _, exists := sandboxByName[record.ContainerName]; exists {
			return DockerEvidence{}, fmt.Errorf("Docker evidence duplicates Sandbox container %q", record.ContainerName)
		}
		sandboxByName[record.ContainerName] = record
	}
	relevantContainers := make([]dockerContainer, 0, len(fixedServices)+len(request.Sandboxes))
	for _, container := range containers {
		name := strings.TrimPrefix(container.Name, "/")
		project := container.Labels["com.docker.compose.project"]
		if project == request.Target.ComposeProject {
			targetComposeAbsent = false
		}
		if hasLabelPrefix(container.Labels, request.Target.LabelPrefix) || strings.HasPrefix(name, request.Target.SandboxContainerPrefix) || strings.HasPrefix(name, request.Target.MigrationContainerPrefix) {
			targetLabelsAbsent = false
		}
		if project == request.Source.ComposeProject {
			service := container.Labels["com.docker.compose.service"]
			if _, known := request.Images[service]; !known || service == "agent-sandbox" || service == "handoff-fs-helper" {
				return DockerEvidence{}, fmt.Errorf("source Compose contains unknown service %q", service)
			}
			if _, duplicate := sourceByService[service]; duplicate {
				return DockerEvidence{}, fmt.Errorf("source Compose service %q is duplicated", service)
			}
			if container.Image != request.Images[service] || container.Networks[request.Source.CoreNetwork] == nil {
				return DockerEvidence{}, fmt.Errorf("source Compose service %q has a mismatched image or network", service)
			}
			sourceByService[service] = container
			relevantContainers = append(relevantContainers, container)
			continue
		}
		if strings.HasPrefix(name, request.Source.MigrationContainerPrefix) {
			return DockerEvidence{}, errors.New("source migration container exists at the idle evidence boundary")
		}
		if strings.HasPrefix(name, request.Source.SandboxContainerPrefix) || container.Labels[request.Source.Label("sandbox")] != "" {
			record, exists := sandboxByName[name]
			if !exists {
				return DockerEvidence{}, fmt.Errorf("Docker Sandbox %q has no durable registry identity", name)
			}
			if err := validateSandboxContainer(container, record, request); err != nil {
				return DockerEvidence{}, err
			}
			relevantContainers = append(relevantContainers, container)
		}
	}
	sourceComposeOwned := len(sourceByService) == len(fixedServices)
	if sourceComposeOwned {
		for _, service := range fixedServices {
			if _, exists := sourceByService[service]; !exists {
				sourceComposeOwned = false
				break
			}
		}
	}

	var sourceNetwork *dockerNetwork
	targetNetworkAbsent := true
	relevantNetworks := []dockerNetwork{}
	for index := range networks {
		network := &networks[index]
		if network.Name == request.Target.CoreNetwork {
			targetNetworkAbsent = false
		}
		if network.Labels["com.docker.compose.project"] == request.Target.ComposeProject {
			targetComposeAbsent = false
		}
		if hasLabelPrefix(network.Labels, request.Target.LabelPrefix) {
			targetLabelsAbsent = false
		}
		if network.Name == request.Source.CoreNetwork {
			if sourceNetwork != nil {
				return DockerEvidence{}, errors.New("source core Docker network is duplicated")
			}
			sourceNetwork = network
			relevantNetworks = append(relevantNetworks, *network)
		}
	}
	for _, volume := range volumes {
		if volume.Labels["com.docker.compose.project"] == request.Target.ComposeProject {
			targetComposeAbsent = false
		}
		if hasLabelPrefix(volume.Labels, request.Target.LabelPrefix) {
			targetLabelsAbsent = false
		}
	}
	sourceNetworkOwned := sourceNetwork != nil && sourceNetwork.Driver == "bridge" &&
		sourceNetwork.Labels[request.Source.Label("network")] == "core" && dockerEvidenceID.MatchString(sourceNetwork.ID)
	networkID := ""
	if sourceNetwork != nil {
		networkID = sourceNetwork.ID
	}
	sort.Slice(relevantContainers, func(left, right int) bool { return relevantContainers[left].ID < relevantContainers[right].ID })
	digest, err := canonicalDigest(struct {
		Containers []dockerContainer `json:"containers"`
		Networks   []dockerNetwork   `json:"networks"`
	}{relevantContainers, relevantNetworks})
	if err != nil {
		return DockerEvidence{}, err
	}
	return DockerEvidence{
		SourceComposeOwned: sourceComposeOwned, SourceCoreNetworkOwned: sourceNetworkOwned,
		TargetComposeAbsent: targetComposeAbsent, TargetCoreNetworkAbsent: targetNetworkAbsent,
		TargetLabelObjectsAbsent: targetLabelsAbsent, SourceCoreNetworkID: networkID, InventorySHA256: digest,
	}, nil
}

func validateSandboxContainer(container dockerContainer, record sandbox.Record, request DockerRequest) error {
	name := strings.TrimPrefix(container.Name, "/")
	if name != record.ContainerName || container.Image != record.Image || container.User != "0:0" ||
		container.Labels[request.Source.Label("sandbox")] != "true" ||
		container.Labels[request.Source.Label("id")] != record.SandboxHash ||
		container.Networks[request.Source.CoreNetwork] == nil {
		return fmt.Errorf("Docker Sandbox %q has a mismatched identity", name)
	}
	expected := map[string]dockerMount{
		contract.ContainerWorkspace: {Type: "bind", Source: filepath.Join(request.PlatformDataRoot, filepath.FromSlash(record.WorkspacePath)), Destination: contract.ContainerWorkspace, RW: true},
		contract.ContainerAgentHome: {Type: "bind", Source: filepath.Join(request.PlatformDataRoot, filepath.FromSlash(record.HomePath)), Destination: contract.ContainerAgentHome, RW: true},
		contract.ContainerAgentEnv:  {Type: "bind", Source: filepath.Join(request.PlatformDataRoot, filepath.FromSlash(record.EnvironmentPath)), Destination: contract.ContainerAgentEnv, RW: true},
		contract.ContainerWorkspace + "/" + request.Source.InternalWorkspaceDirectory + "/attachments": {
			Type: "bind", Source: filepath.Join(request.PlatformDataRoot, filepath.FromSlash(record.AttachmentsPath)),
			Destination: contract.ContainerWorkspace + "/" + request.Source.InternalWorkspaceDirectory + "/attachments", RW: false,
		},
	}
	if len(container.Mounts) != len(expected) {
		return fmt.Errorf("Docker Sandbox %q has an unexpected mount set", name)
	}
	for _, mount := range container.Mounts {
		wanted, exists := expected[mount.Destination]
		if !exists || mount != wanted {
			return fmt.Errorf("Docker Sandbox %q has an unexpected persistent mount", name)
		}
	}
	return nil
}

func (docker DockerCLI) containers(ctx context.Context) ([]dockerContainer, error) {
	ids, err := docker.objectList(ctx, []string{"container", "ls", "--all", "--quiet", "--no-trunc"}, true)
	if err != nil {
		return nil, err
	}
	values := make([]dockerContainer, 0, len(ids))
	for _, id := range ids {
		line, err := docker.inspect(ctx, "container", id, containerInspectProjection, 9)
		if err != nil {
			return nil, err
		}
		var value dockerContainer
		if err := decodeFields(line, &value.ID, &value.Name, &value.Image, &value.ImageID, &value.Status, &value.User, &value.Labels, &value.Networks, &value.Mounts); err != nil {
			return nil, fmt.Errorf("decode Docker container %s: %w", id, err)
		}
		if value.Labels == nil {
			value.Labels = map[string]string{}
		}
		if value.ID != id || !dockerEvidenceID.MatchString(value.ID) || value.Name == "" || value.Image == "" || value.Networks == nil {
			return nil, fmt.Errorf("Docker container %s returned an invalid identity", id)
		}
		values = append(values, value)
	}
	return values, nil
}

func (docker DockerCLI) networks(ctx context.Context) ([]dockerNetwork, error) {
	ids, err := docker.objectList(ctx, []string{"network", "ls", "--quiet", "--no-trunc"}, true)
	if err != nil {
		return nil, err
	}
	values := make([]dockerNetwork, 0, len(ids))
	for _, id := range ids {
		line, err := docker.inspect(ctx, "network", id, networkInspectProjection, 4)
		if err != nil {
			return nil, err
		}
		var value dockerNetwork
		if err := decodeFields(line, &value.ID, &value.Name, &value.Driver, &value.Labels); err != nil {
			return nil, fmt.Errorf("decode Docker network %s: %w", id, err)
		}
		if value.Labels == nil {
			value.Labels = map[string]string{}
		}
		if value.ID != id || !dockerEvidenceID.MatchString(value.ID) || !dockerObjectName.MatchString(value.Name) || value.Driver == "" {
			return nil, fmt.Errorf("Docker network %s returned an invalid identity", id)
		}
		values = append(values, value)
	}
	return values, nil
}

func (docker DockerCLI) volumes(ctx context.Context) ([]dockerVolume, error) {
	names, err := docker.objectList(ctx, []string{"volume", "ls", "--quiet"}, false)
	if err != nil {
		return nil, err
	}
	values := make([]dockerVolume, 0, len(names))
	for _, name := range names {
		line, err := docker.inspect(ctx, "volume", name, volumeInspectProjection, 3)
		if err != nil {
			return nil, err
		}
		var value dockerVolume
		if err := decodeFields(line, &value.Name, &value.Driver, &value.Labels); err != nil {
			return nil, fmt.Errorf("decode Docker volume %s: %w", name, err)
		}
		if value.Labels == nil {
			value.Labels = map[string]string{}
		}
		if value.Name != name || !dockerObjectName.MatchString(value.Name) || value.Driver == "" {
			return nil, fmt.Errorf("Docker volume %s returned an invalid identity", name)
		}
		values = append(values, value)
	}
	return values, nil
}

func (docker DockerCLI) objectList(ctx context.Context, args []string, requireID bool) ([]string, error) {
	result, err := docker.runner().Run(ctx, docker.binary(), args, nil)
	if err != nil {
		return nil, err
	}
	trimmed := strings.TrimSpace(result.Stdout)
	if trimmed == "" {
		return nil, nil
	}
	lines := strings.Split(trimmed, "\n")
	maximum := docker.MaxObjects
	if maximum == 0 {
		maximum = defaultMaxDockerEvidenceObjects
	}
	if maximum < 1 || maximum > defaultMaxDockerEvidenceObjects || len(lines) > maximum {
		return nil, errors.New("Docker evidence object count exceeds the closed-world limit")
	}
	seen := map[string]struct{}{}
	for index, line := range lines {
		line = strings.TrimSpace(line)
		valid := dockerObjectName.MatchString(line)
		if requireID {
			valid = dockerEvidenceID.MatchString(line)
		}
		if !valid {
			return nil, fmt.Errorf("Docker evidence returned invalid object %q", line)
		}
		if _, duplicate := seen[line]; duplicate {
			return nil, fmt.Errorf("Docker evidence returned duplicate object %q", line)
		}
		seen[line] = struct{}{}
		lines[index] = line
	}
	sort.Strings(lines)
	return lines, nil
}

func (docker DockerCLI) inspect(ctx context.Context, kind, object, format string, fields int) ([]json.RawMessage, error) {
	result, err := docker.runner().Run(ctx, docker.binary(), []string{kind, "inspect", "--format", format, object}, nil)
	if err != nil {
		return nil, err
	}
	var values []json.RawMessage
	if err := json.Unmarshal([]byte(result.Stdout), &values); err != nil {
		return nil, fmt.Errorf("Docker inspect returned an invalid JSON projection: %w", err)
	}
	if len(values) != fields {
		return nil, errors.New("Docker inspect returned an incomplete projection")
	}
	return values, nil
}

func decodeFields(fields []json.RawMessage, destinations ...any) error {
	if len(fields) != len(destinations) {
		return errors.New("Docker inspect field count differs from its decoder")
	}
	for index := range fields {
		if err := json.Unmarshal(fields[index], destinations[index]); err != nil {
			return err
		}
	}
	return nil
}

func hasLabelPrefix(labels map[string]string, prefix string) bool {
	for key := range labels {
		if strings.HasPrefix(key, prefix+".") {
			return true
		}
	}
	return false
}

func immutableImageReference(value string) bool {
	before, digest, found := strings.Cut(value, "@sha256:")
	return found && before != "" && len(digest) == 64 && admissionSHA256.MatchString(digest)
}

func (docker DockerCLI) runner() driver.Runner {
	if docker.Runner != nil {
		return docker.Runner
	}
	return driver.CommandRunner{MaxOutputBytes: 16 << 20}
}

func (docker DockerCLI) binary() string {
	if strings.TrimSpace(docker.Binary) != "" {
		return docker.Binary
	}
	return "docker"
}
