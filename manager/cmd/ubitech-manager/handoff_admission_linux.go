//go:build linux

package main

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/runtimegate"
)

// routedHandoffAdmission keeps the public operation/executor closures stable
// while a helper-started participant is promoted after terminal handoff. A
// nil Store is an explicit fail-closed participant state, never an invitation
// to skip the deployment-wide journal boundary.
type routedHandoffAdmission struct {
	mu             sync.RWMutex
	store          *handoff.Store
	targetBaseline bool
}

func (admission *routedHandoffAdmission) SetStore(store *handoff.Store) error {
	if admission == nil || store == nil {
		return errors.New("handoff admission store is unavailable")
	}
	admission.mu.Lock()
	defer admission.mu.Unlock()
	if admission.targetBaseline || admission.store != nil && admission.store != store {
		return errors.New("handoff admission store is already bound")
	}
	admission.store = store
	return nil
}

// SetCompileTimeTargetBaseline opens ordinary runtime admission only when the
// generated release stage itself selects the target profile. This is not a
// caller-selectable bypass: Bridge can never enter it, and a journal-backed
// target continues to use the retained Store observation instead.
func (admission *routedHandoffAdmission) SetCompileTimeTargetBaseline(active identity.ActiveProfile) error {
	if admission == nil {
		return errors.New("handoff admission is unavailable")
	}
	compiled, err := identity.CompileTimeActiveProfile()
	if err != nil {
		return err
	}
	profile, err := active.Profile()
	if err != nil {
		return err
	}
	if active != compiled || profile != identity.TargetProfile() {
		return errors.New("journal-free admission requires the compiled target-only baseline")
	}
	admission.mu.Lock()
	defer admission.mu.Unlock()
	if admission.store != nil {
		return errors.New("handoff admission store is already bound")
	}
	admission.targetBaseline = true
	return nil
}

func (admission *routedHandoffAdmission) Acquire(ctx context.Context) (func(), error) {
	if admission == nil {
		return nil, errors.New("handoff admission is unavailable")
	}
	admission.mu.RLock()
	store := admission.store
	targetBaseline := admission.targetBaseline
	admission.mu.RUnlock()
	if targetBaseline {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		var once sync.Once
		return func() { once.Do(func() {}) }, nil
	}
	if store == nil {
		return nil, errors.New("ordinary runtime is unavailable while namespace handoff owns the participant")
	}
	return ordinaryHandoffAdmission(store)(ctx)
}

type handoffExecutionAdmission struct {
	handoff *routedHandoffAdmission
	runtime *runtimegate.Gate
}

func (admission handoffExecutionAdmission) Enter(ctx context.Context) (func(), error) {
	if admission.handoff == nil || admission.runtime == nil {
		return nil, errors.New("executor handoff admission is unavailable")
	}
	releaseHandoff, err := admission.handoff.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	releaseRuntime, err := admission.runtime.Enter(ctx)
	if err != nil {
		releaseHandoff()
		return nil, err
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			releaseRuntime()
			releaseHandoff()
		})
	}, nil
}

// ordinaryHandoffAdmission enforces the one deployment-wide lock order:
// handoff observation first, ordinary runtime admission second. The returned
// closure retains the global handoff lease until the ordinary publication
// boundary has completed.
func ordinaryHandoffAdmission(store *handoff.Store) func(context.Context) (func(), error) {
	return func(ctx context.Context) (func(), error) {
		if store == nil {
			return nil, errors.New("handoff admission store is unavailable")
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		observation, journals, err := store.OpenObservation()
		if err != nil {
			return nil, fmt.Errorf("acquire handoff admission observation: %w", err)
		}
		for _, journal := range journals {
			if !journal.Terminal() {
				_ = observation.Close()
				return nil, errors.New("ordinary operation is blocked by an active namespace handoff")
			}
		}
		if err := ctx.Err(); err != nil {
			_ = observation.Close()
			return nil, err
		}
		var once sync.Once
		return func() { once.Do(func() { _ = observation.Close() }) }, nil
	}
}

// preflightUnderHandoffAdmission keeps every preflight mutation inside the
// same deployment-wide observation. In particular, callers must put host
// layout/secret creation, transient-unit probes, Docker network creation and
// release-directory publication inside action rather than before this gate.
func preflightUnderHandoffAdmission(ctx context.Context, store *handoff.Store, action func() error) error {
	if action == nil {
		return errors.New("preflight action is unavailable")
	}
	release, err := ordinaryHandoffAdmission(store)(ctx)
	if err != nil {
		return err
	}
	if release == nil {
		return errors.New("preflight handoff admission returned no release boundary")
	}
	defer release()
	return action()
}
