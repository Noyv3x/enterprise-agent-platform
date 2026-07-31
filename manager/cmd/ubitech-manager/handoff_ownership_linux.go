//go:build linux

package main

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"runtime"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/config"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handofffd"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffhost"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handofflisteners"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffowner"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffsource"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

// sourceOwnerListenerBoundary exists only on the stable Manager side. Begin
// stops after arming the persistent helper, and receipt observation never
// mutates listeners; every actual listener mutation is owned by the helper's
// separately constructed HelperDriver. Keeping this boundary fail-closed
// prevents an accidental call from moving public ownership in the source
// process.
type sourceOwnerListenerBoundary struct{}

func startupParticipantProfile(active identity.ActiveProfile) handofflisteners.PublicOwner {
	profile, err := active.Profile()
	if err != nil {
		return handofflisteners.OwnerUnknown
	}
	if reflect.DeepEqual(profile, identity.SourceProfile()) {
		return handofflisteners.OwnerSource
	}
	if reflect.DeepEqual(profile, identity.TargetProfile()) {
		return handofflisteners.OwnerTarget
	}
	return handofflisteners.OwnerUnknown
}

func (sourceOwnerListenerBoundary) EnsureMaintenance(context.Context, handoff.Journal, handoff.StartupLease, handoffowner.ListenerState) (handoffowner.ListenerState, error) {
	return handoffowner.ListenerState{}, errors.New("public listener mutation belongs to the persistent handoff helper")
}

func (sourceOwnerListenerBoundary) CommitToTarget(context.Context, handoff.Journal, handoff.StartupLease, []handofffd.NamedListener) error {
	return errors.New("public listener mutation belongs to the persistent handoff helper")
}

func (sourceOwnerListenerBoundary) RestoreToSource(context.Context, handoff.Journal, handoff.StartupLease, []handofffd.NamedListener) error {
	return errors.New("public listener mutation belongs to the persistent handoff helper")
}

func configureHandoffOwnership(
	active identity.ActiveProfile,
	cfg config.Config,
	app *application,
	admission handoffsource.Admission,
	evidence handoffsource.EvidenceCollector,
	runningSHA256 string,
) (*handoffowner.Coordinator, error) {
	if app == nil || app.handoffStore == nil || admission == nil || evidence == nil || runningSHA256 == "" {
		return nil, errors.New("namespace handoff ownership dependencies are incomplete")
	}
	activeProfile, err := active.Profile()
	if err != nil {
		return nil, err
	}
	sourceActive := identity.SourceActiveProfile()
	targetActive, err := identity.ActivateVerifiedHandoffTarget(identity.TargetProfile())
	if err != nil {
		return nil, err
	}
	sourceStableBinary := managerInstallPath(sourceActive)
	sourceConfigPath := ""
	sourceDataRoot := ""
	sourceSocketPath := ""
	targetStableBinary := managerInstallPath(targetActive)
	targetDataRoot := ""
	targetSocketPath := ""
	if reflect.DeepEqual(activeProfile, identity.SourceProfile()) {
		targetDefaults, defaultsErr := config.Defaults(targetActive)
		if defaultsErr != nil {
			return nil, fmt.Errorf("resolve target handoff defaults: %w", defaultsErr)
		}
		sourceConfigPath = cfg.ConfigPath
		sourceDataRoot = cfg.DataRoot
		sourceSocketPath = cfg.SocketPath
		targetDataRoot = cfg.TargetDataRoot()
		targetSocketPath = targetDefaults.SocketPath
	} else if reflect.DeepEqual(activeProfile, identity.TargetProfile()) {
		source, target, bindingErr := terminalHandoffBindings(app.handoffStore, cfg)
		if bindingErr != nil {
			return nil, bindingErr
		}
		sourceStableBinary = source.StableBinary
		sourceConfigPath = source.ConfigPath
		sourceDataRoot = source.DataRoot
		sourceSocketPath = source.SocketPath
		targetStableBinary = target.StableBinary
		targetDataRoot = target.DataRoot
		targetSocketPath = target.SocketPath
	} else {
		return nil, errors.New("active handoff ownership profile is not canonical")
	}

	targetRuntimeRoot := filepath.Dir(filepath.Dir(targetSocketPath))
	sourceProfile := identity.SourceProfile()
	driver, err := handoffsource.New(handoffsource.Options{
		Store: app.handoffStore, Admission: admission, Evidence: evidence,
		HelperHost: &handoffhost.LinuxHost{}, Artifacts: release.Client{}, Images: app.docker, Units: handoffsource.SystemdCLI{},
		TargetConfig:  sourceTargetConfigRenderer{source: cfg},
		SourceProfile: sourceActive, TargetProfile: identity.TargetProfile(), Channel: cfg.ReleaseChannel,
		GOOS: runtime.GOOS, GOARCH: runtime.GOARCH,
		SourceStableBinary: sourceStableBinary, SourceConfigPath: sourceConfigPath,
		SourceDataRoot: sourceDataRoot, SourceSocketPath: sourceSocketPath,
		SourceManagerStatePath:    filepath.Join(sourceProfile.ManagerStateRoot(sourceDataRoot), "state.json"),
		SourceSelfUpdatePath:      filepath.Join(sourceProfile.ManagerStateRoot(sourceDataRoot), "manager-binaries.json"),
		SourceSandboxRegistryPath: filepath.Join(sourceProfile.ManagerStateRoot(sourceDataRoot), "sandboxes.json"),
		TargetStableBinary:        targetStableBinary,
		TargetDataRoot:            targetDataRoot, TargetRuntimeRoot: targetRuntimeRoot, TargetSocketPath: targetSocketPath,
	})
	if err != nil {
		return nil, fmt.Errorf("construct source handoff owner: %w", err)
	}
	owner, err := handoffowner.New(handoffowner.Options{
		Store: app.handoffStore, Host: driver, Listeners: sourceOwnerListenerBoundary{},
		SourceProfile: sourceActive, TargetProfile: identity.TargetProfile(), Channel: cfg.ReleaseChannel,
		GOOS: runtime.GOOS, GOARCH: runtime.GOARCH,
	})
	if err != nil {
		return nil, fmt.Errorf("construct namespace handoff coordinator: %w", err)
	}
	return owner, nil
}

type sourceTargetConfigRenderer struct {
	source config.Config
}

func (renderer sourceTargetConfigRenderer) RenderTargetConfig(sourcePath string, sourceRaw []byte, targetConfigPath, targetDataRoot, targetSocketPath string) ([]byte, error) {
	parsed, err := config.LoadStartupSnapshot(identity.SourceActiveProfile(), sourcePath, sourceRaw, true, renderer.source.StateHome)
	if err != nil {
		return nil, fmt.Errorf("parse retained source Manager config: %w", err)
	}
	if parsed.ConfigPath != renderer.source.ConfigPath || parsed.DataRoot != renderer.source.DataRoot ||
		parsed.StateDir != renderer.source.StateDir || parsed.StateHome != renderer.source.StateHome || parsed.SocketPath != renderer.source.SocketPath {
		return nil, errors.New("retained source Manager config differs from the owner startup snapshot")
	}
	targetActive, err := identity.ActivateVerifiedHandoffTarget(identity.TargetProfile())
	if err != nil {
		return nil, err
	}
	target, err := config.DeriveHandoffTarget(parsed, targetActive, targetConfigPath, targetDataRoot, targetSocketPath)
	if err != nil {
		return nil, err
	}
	rendered, err := config.RenderHandoffTarget(target)
	if err != nil {
		return nil, err
	}
	ownerTarget, err := config.DeriveHandoffTarget(renderer.source, targetActive, targetConfigPath, targetDataRoot, targetSocketPath)
	if err != nil {
		return nil, err
	}
	ownerRendered, err := config.RenderHandoffTarget(ownerTarget)
	if err != nil {
		return nil, err
	}
	if !reflect.DeepEqual(rendered, ownerRendered) {
		return nil, errors.New("retained source Manager operations differ from the owner startup snapshot")
	}
	return rendered, nil
}

// terminalHandoffBindings freezes the committed journal while a target
// Manager is constructed.  The target config is only an equality check; it
// cannot be used to reconstruct the retired source or the user-systemd root.
func terminalHandoffBindings(store *handoff.Store, targetConfig config.Config) (handoff.SourceBinding, handoff.TargetBinding, error) {
	lease, before, err := store.OpenObservation()
	if err != nil {
		return handoff.SourceBinding{}, handoff.TargetBinding{}, fmt.Errorf("observe terminal handoff ownership: %w", err)
	}
	defer lease.Close()
	var selected *handoff.Journal
	for index := range before {
		journal := before[index]
		if err := handoff.Validate(journal); err != nil {
			return handoff.SourceBinding{}, handoff.TargetBinding{}, err
		}
		if !journal.Terminal() {
			return handoff.SourceBinding{}, handoff.TargetBinding{}, errors.New("target ownership requires terminal handoff journals")
		}
		if journal.Status != handoff.StatusCommitted {
			continue
		}
		if selected != nil {
			return handoff.SourceBinding{}, handoff.TargetBinding{}, errors.New("target ownership found multiple committed handoffs")
		}
		copy := journal
		selected = &copy
	}
	if selected == nil {
		return handoff.SourceBinding{}, handoff.TargetBinding{}, errors.New("target ownership requires one committed handoff")
	}
	for _, journal := range before {
		if journal.TransactionID != selected.TransactionID && journal.CreatedAt.After(selected.CreatedAt) {
			return handoff.SourceBinding{}, handoff.TargetBinding{}, errors.New("target ownership found a later terminal transaction")
		}
	}
	targetProfile := identity.TargetProfile()
	if selected.Target.Namespace != targetProfile.ProfileID || selected.Target.Unit != targetProfile.ManagerUnit ||
		selected.Target.ConfigPath != targetConfig.ConfigPath || selected.Target.DataRoot != targetConfig.DataRoot ||
		selected.Target.SocketPath != targetConfig.SocketPath || selected.Target.ComposeProject != targetProfile.ComposeProject ||
		selected.Target.CoreNetwork != targetProfile.CoreNetwork || selected.Target.LabelPrefix != targetProfile.LabelPrefix {
		return handoff.SourceBinding{}, handoff.TargetBinding{}, errors.New("target config differs from the committed handoff binding")
	}
	targetDigest, err := secureStartupConfigSnapshotSHA256(targetConfig.ConfigPath)
	if err != nil || targetDigest != selected.Target.ConfigSHA256 {
		return handoff.SourceBinding{}, handoff.TargetBinding{}, errors.Join(err, errors.New("target config digest differs from the committed handoff binding"))
	}
	after, err := lease.Read()
	if err != nil {
		return handoff.SourceBinding{}, handoff.TargetBinding{}, err
	}
	if !reflect.DeepEqual(before, after) {
		return handoff.SourceBinding{}, handoff.TargetBinding{}, errors.New("handoff journals changed while constructing target ownership")
	}
	return selected.Source, selected.Target, nil
}
