//go:build !linux

package operation

import (
	"errors"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

func (o *Orchestrator) loadRetainedSourceCompatibility(_ *model.Generation, _ retainedGenerationSlot) (release.Manifest, error) {
	return release.Manifest{}, errors.New("retained source predecessor compatibility requires Linux descriptor validation")
}
