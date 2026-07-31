//go:build linux

package handoffevidence

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

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

func evidenceImages() map[string]string {
	values := map[string]string{}
	for index, service := range append(append([]string(nil), fixedServices...), "agent-sandbox") {
		digit := "abcdef0123"[index%10]
		values[service] = "registry.invalid/" + service + "@sha256:" + strings.Repeat(string(digit), 64)
	}
	return values
}
