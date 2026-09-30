package driver

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

var exactImageID = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

// RetainImages only considers references from verified deployment manifests.
// Admission excludes updates; ManagedImageMu excludes image pulls. Non-force
// deletion also fences containers created after the running-container snapshot.
// Returned generations preserve ownership evidence for deferred sandbox images.
func (d DockerCLI) RetainImages(ctx context.Context, retained, obsolete []release.Manifest) (map[string]bool, error) {
	if d.ManagedImageMu != nil {
		d.ManagedImageMu.Lock()
		defer d.ManagedImageMu.Unlock()
	}
	keep := map[string]bool{}
	candidates := map[string][]string{}
	deferred := map[string]bool{}
	resolve := func(manifests []release.Manifest, protect bool) error {
		for _, manifest := range manifests {
			for name, image := range manifest.Images {
				if !release.IsManagedImageName(name) || !release.IsDigestReference(image) {
					return fmt.Errorf("invalid retained image reference %q", image)
				}
				result, err := d.runner().Run(ctx, d.binary(), []string{"image", "inspect", "--format", "{{.Id}}", image}, nil)
				if err != nil {
					if dockerObjectMissing(result, err) {
						continue
					}
					return err
				}
				id := strings.TrimSpace(result.Stdout)
				if !exactImageID.MatchString(id) {
					return fmt.Errorf("invalid Docker image ID %q", id)
				}
				if protect {
					keep[id] = true
				} else {
					candidates[id] = append(candidates[id], manifest.ID())
				}
			}
		}
		return nil
	}
	if err := resolve(retained, true); err != nil {
		return nil, err
	}
	if err := resolve(obsolete, false); err != nil {
		return nil, err
	}
	if len(candidates) == 0 {
		return deferred, nil
	}
	// Protect all running containers, including other deployments.
	result, err := d.runner().Run(ctx, d.binary(), []string{"ps", "--quiet", "--no-trunc"}, nil)
	if err != nil {
		return nil, err
	}
	containers := strings.Fields(result.Stdout)
	if len(containers) != 0 {
		args := append([]string{"container", "inspect", "--format", "{{json .Image}}"}, containers...)
		result, err = d.runner().Run(ctx, d.binary(), args, nil)
		if err != nil {
			return nil, err
		}
		for _, line := range strings.Split(strings.TrimSpace(result.Stdout), "\n") {
			var id string
			if json.Unmarshal([]byte(line), &id) != nil || !exactImageID.MatchString(id) {
				return nil, fmt.Errorf("invalid running container image ID %q", line)
			}
			if !keep[id] {
				for _, generation := range candidates[id] {
					deferred[generation] = true
				}
			}
			keep[id] = true
		}
	}
	ids := make([]string, 0, len(candidates))
	for id := range candidates {
		if !keep[id] {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	for _, id := range ids {
		if _, err := d.runner().Run(ctx, d.binary(), []string{"image", "rm", id}, nil); err != nil {
			return nil, fmt.Errorf("remove obsolete deployment image %s: %w", id, err)
		}
	}
	return deferred, nil
}
