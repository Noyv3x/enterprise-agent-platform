//go:build linux

package main

import (
	"context"
	"net/http"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/attestation"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/config"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/control"
)

// controlTransitionObserver obtains only the non-secret authoritative state
// projection from the live Manager. Deployment key material is opened and
// used exclusively by the short-lived local CLI process.
type controlTransitionObserver struct {
	client control.Client
}

func (observer controlTransitionObserver) ObserveTransition(ctx context.Context, challenge attestation.Challenge) (attestation.Observation, error) {
	var observation attestation.Observation
	if err := observer.client.Do(ctx, http.MethodPost, "/v1/release-transition/observation", challenge, &observation); err != nil {
		return attestation.Observation{}, err
	}
	return observation, nil
}

func releaseTransitionAttestationService(cfg config.Config, observer attestation.Observer) *attestation.Service {
	return &attestation.Service{
		Root:           cfg.TransitionStateRoot(),
		StateHome:      cfg.StateHome,
		ForbiddenRoots: []string{cfg.DataRoot, cfg.TargetDataRoot()},
		Observer:       observer,
	}
}
