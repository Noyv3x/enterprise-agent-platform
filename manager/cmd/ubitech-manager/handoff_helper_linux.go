//go:build linux

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/config"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/driver"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffcontrol"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handofffd"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffhelper"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffhost"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handofflisteners"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffowner"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffsource"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffstartup"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handofftransform"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/operation"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/sandbox"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/snapshot"
)

const (
	helperManifestMaximum = 1 << 20
	helperComposeMaximum  = 8 << 20
	helperManagerMaximum  = 128 << 20
)

var executeHandoffHelper = handoffHelperCommand

type handoffHelperArguments struct {
	transactionID        string
	journalPath          string
	listenerSocketPath   string
	transactionDirectory string
}

func parseHandoffHelperArguments(arguments []string) (handoffHelperArguments, error) {
	if len(arguments) != 6 {
		return handoffHelperArguments{}, errors.New("namespace handoff helper requires exactly three flag/value pairs")
	}
	values := map[string]string{}
	for index := 0; index < len(arguments); index += 2 {
		flag, value := arguments[index], arguments[index+1]
		switch flag {
		case "--transaction", "--journal", "--listener-socket":
		default:
			return handoffHelperArguments{}, fmt.Errorf("namespace handoff helper rejects unknown argument %q", flag)
		}
		if _, duplicate := values[flag]; duplicate {
			return handoffHelperArguments{}, fmt.Errorf("namespace handoff helper argument %s was supplied more than once", flag)
		}
		if value == "" || strings.HasPrefix(value, "-") || strings.ContainsRune(value, 0) {
			return handoffHelperArguments{}, fmt.Errorf("namespace handoff helper argument %s has an invalid value", flag)
		}
		values[flag] = value
	}
	for _, required := range []string{"--transaction", "--journal", "--listener-socket"} {
		if values[required] == "" {
			return handoffHelperArguments{}, fmt.Errorf("namespace handoff helper is missing %s", required)
		}
	}
	journalPath, listenerPath := values["--journal"], values["--listener-socket"]
	for label, path := range map[string]string{"journal": journalPath, "listener socket": listenerPath} {
		if !filepath.IsAbs(path) || filepath.Clean(path) != path {
			return handoffHelperArguments{}, fmt.Errorf("namespace handoff helper %s path is not canonical and absolute", label)
		}
	}
	txDir := filepath.Dir(journalPath)
	if filepath.Base(txDir) != values["--transaction"] || filepath.Base(journalPath) != "journal.json" {
		return handoffHelperArguments{}, errors.New("namespace handoff helper journal is not bound to its transaction")
	}
	wantedListener, err := handoffhost.TransferSocketPath(txDir, values["--transaction"])
	if err != nil || wantedListener != listenerPath {
		return handoffHelperArguments{}, errors.Join(err, errors.New("namespace handoff helper listener socket differs from its transaction binding"))
	}
	return handoffHelperArguments{
		transactionID: values["--transaction"], journalPath: journalPath,
		listenerSocketPath: listenerPath, transactionDirectory: txDir,
	}, nil
}

// handoffHelperCommand is deliberately routed before any ordinary startup,
// profile, config, or operation-state reader. The ambient participant locator
// is ignored even when inherited from a failed systemd invocation.
func handoffHelperCommand(arguments []string) error {
	_ = os.Unsetenv(handoffTransactionEnvironment)
	parsed, err := parseHandoffHelperArguments(arguments)
	if err != nil {
		return err
	}
	store, err := handoff.OpenExisting(filepath.Dir(parsed.transactionDirectory))
	if err != nil {
		return fmt.Errorf("open existing namespace handoff root: %w", err)
	}
	defer store.Close()
	lease, journal, err := store.OpenHelper(parsed.transactionID)
	if err != nil {
		return fmt.Errorf("open helper journal for production assembly: %w", err)
	}
	closeErr := lease.Close()
	if closeErr != nil {
		return fmt.Errorf("release helper assembly journal lease: %w", closeErr)
	}
	if parsed.journalPath != filepath.Join(parsed.transactionDirectory, "journal.json") || journal.TransactionID != parsed.transactionID {
		return errors.New("helper argv differs from the opened transaction journal")
	}
	assembly, err := assembleProductionHandoffHelper(journal, parsed)
	if err != nil {
		return err
	}
	defer assembly.listeners.Close()
	coordinator, err := handoffowner.New(handoffowner.Options{
		Store: store, Host: assembly.driver, Listeners: assembly.listeners,
		SourceProfile: identity.SourceActiveProfile(), TargetProfile: identity.TargetProfile(),
		Channel: assembly.sourceConfig.ReleaseChannel,
	})
	if err != nil {
		return err
	}
	ctx, stop := signalContext()
	defer stop()
	_, err = coordinator.Resume(ctx, parsed.transactionID)
	return err
}

type productionHelperAssembly struct {
	driver       *handoffhelper.Driver
	listeners    *handofflisteners.HelperDriver
	sourceConfig config.Config
}

func assembleProductionHandoffHelper(journal handoff.Journal, parsed handoffHelperArguments) (productionHelperAssembly, error) {
	if err := handoff.Validate(journal); err != nil {
		return productionHelperAssembly{}, err
	}
	if journal.TransactionID != parsed.transactionID || parsed.transactionDirectory != filepath.Join(filepath.Dir(parsed.transactionDirectory), journal.TransactionID) {
		return productionHelperAssembly{}, errors.New("helper production assembly transaction identity differs from the journal")
	}
	sourceActive := identity.SourceActiveProfile()
	targetActive, err := identity.ActivateVerifiedHandoffTarget(identity.TargetProfile())
	if err != nil {
		return productionHelperAssembly{}, err
	}
	sourceSnapshot, err := locateStartupConfigSnapshot(journal.Source.ConfigPath)
	if err != nil {
		return productionHelperAssembly{}, fmt.Errorf("capture journal-bound source config: %w", err)
	}
	sourceDigest, err := startupConfigSnapshotSHA256(sourceSnapshot)
	if err != nil || sourceDigest != journal.Source.ConfigSHA256 {
		return productionHelperAssembly{}, errors.Join(err, errors.New("source config digest differs from the helper journal"))
	}
	sourceConfig, err := config.LoadStartupSnapshot(sourceActive, journal.Source.ConfigPath, sourceSnapshot.Raw, sourceSnapshot.Exists, sourceSnapshot.StateHome)
	if err != nil {
		return productionHelperAssembly{}, fmt.Errorf("parse journal-bound source config snapshot: %w", err)
	}
	if err := validateHelperSourceConfig(journal, sourceConfig, sourceDigest); err != nil {
		return productionHelperAssembly{}, err
	}
	targetConfig, err := config.DeriveHandoffTarget(sourceConfig, targetActive, journal.Target.ConfigPath, journal.Target.DataRoot, journal.Target.SocketPath)
	if err != nil {
		return productionHelperAssembly{}, err
	}
	targetConfigBytes, err := config.RenderHandoffTarget(targetConfig)
	if err != nil {
		return productionHelperAssembly{}, err
	}
	targetConfigDigest := sha256.Sum256(targetConfigBytes)
	if hex.EncodeToString(targetConfigDigest[:]) != journal.Target.ConfigSHA256 {
		return productionHelperAssembly{}, errors.New("derived target config digest differs from the helper journal")
	}
	bindings, err := helperBindingsFromJournal(journal, sourceConfig, targetConfig, sourceDigest)
	if err != nil {
		return productionHelperAssembly{}, err
	}

	recoveryPaths, err := handoff.DeriveRecoveryBundlePaths(parsed.transactionDirectory, journal.TransactionID)
	if err != nil {
		return productionHelperAssembly{}, err
	}
	bridgeRaw, err := readOwnerInputFile(recoveryPaths.BridgeManifest, helperManifestMaximum)
	if err != nil {
		return productionHelperAssembly{}, fmt.Errorf("read bridge manifest for helper: %w", err)
	}
	bridgeDigest := sha256.Sum256(bridgeRaw)
	if hex.EncodeToString(bridgeDigest[:]) != journal.Release.ManifestSHA256 {
		return productionHelperAssembly{}, errors.New("helper bridge manifest differs from the journal digest")
	}
	bridgeManifest, err := release.DecodeManifestForProfile(
		bridgeRaw,
		sourceConfig.ReleaseChannel,
		runtime.GOOS,
		runtime.GOARCH,
		sourceActive,
	)
	if err != nil {
		return productionHelperAssembly{}, err
	}
	if bridgeManifest.ID() != journal.Release.BridgeGeneration || bridgeManifest.SourceCommit != journal.Release.BridgeGeneration {
		return productionHelperAssembly{}, errors.New("helper bridge manifest generation differs from the journal")
	}
	targetCompose, err := readOwnerInputFile(recoveryPaths.BridgeCompose, helperComposeMaximum)
	if err != nil {
		return productionHelperAssembly{}, fmt.Errorf("read bridge Compose artifact: %w", err)
	}
	targetManagerPath := filepath.Join(parsed.transactionDirectory, "helper", identity.TargetProfile().ManagerBinary)
	targetManager, err := readOwnerInputFile(targetManagerPath, helperManagerMaximum)
	if err != nil {
		return productionHelperAssembly{}, fmt.Errorf("read installed target Manager artifact: %w", err)
	}
	sourceManifestRaw, err := readOwnerInputFile(recoveryPaths.SourceManifest, helperManifestMaximum)
	if err != nil {
		return productionHelperAssembly{}, fmt.Errorf("read bundled source predecessor manifest: %w", err)
	}
	if digest := sha256.Sum256(sourceManifestRaw); hex.EncodeToString(digest[:]) != journal.Source.ManifestSHA256 {
		return productionHelperAssembly{}, errors.New("bundled source predecessor manifest differs from the journal digest")
	}
	sourceManifest, err := release.DecodeManifestForProfile(
		sourceManifestRaw,
		sourceConfig.ReleaseChannel,
		runtime.GOOS,
		runtime.GOARCH,
		sourceActive,
	)
	if err != nil {
		return productionHelperAssembly{}, fmt.Errorf("load source predecessor manifest: %w", err)
	}
	if sourceManifest.ID() != journal.Release.PredecessorGeneration || sourceManifest.SourceCommit != journal.Release.PredecessorGeneration {
		return productionHelperAssembly{}, errors.New("source predecessor manifest differs from the helper journal")
	}

	sourceToken, err := driver.ReadOwnerSecret(sourceConfig.ControlTokenFile())
	if err != nil {
		return productionHelperAssembly{}, fmt.Errorf("read source Manager control token: %w", err)
	}
	sourceStack := newDockerDriver(sourceActive, sourceConfig)
	targetStack := newDockerDriver(targetActive, targetConfig)
	sourceStack.ComposeFile = recoveryPaths.SourceCompose
	sourceStack.ComposeSHA256 = journal.Source.ComposeSHA256
	sourceStack.ManifestFile = recoveryPaths.SourceManifest
	sourceStack.ManifestSHA256 = journal.Source.ManifestSHA256
	sourceStack.ManifestChannel = sourceConfig.ReleaseChannel
	sourceStack.RequireLocalImages = true
	sourceStack.ExpectedCoreNetworkID = journal.Source.CoreNetworkID
	targetStack.ComposeSHA256 = journal.Release.TargetComposeSHA256
	targetStack.ManifestFile = filepath.Join(targetConfig.StateDir, "releases", journal.Release.BridgeGeneration, "manifest.json")
	targetStack.ManifestSHA256 = journal.Release.ManifestSHA256
	targetStack.ManifestChannel = targetConfig.ReleaseChannel
	targetStack.HandoffTransactionID = journal.TransactionID
	targetStack.HandoffBindingSHA256 = journal.BindingSHA256
	units := handoffhelper.SystemdController{}
	helperHost := &handoffhost.LinuxHost{}
	installation := &helperTargetInstallation{host: helperHost, request: handoffhost.TargetInstallationRequest{
		TargetProfile: identity.TargetProfile(), TransactionID: journal.TransactionID,
		TransactionDirectory: parsed.transactionDirectory, ArtifactPath: targetManagerPath,
		ArtifactSHA256: journal.Release.TargetManagerSHA256, StableBinary: journal.Target.StableBinary,
		ConfigPath: journal.Target.ConfigPath, UnitPath: journal.Target.UnitPath,
		DataRoot: journal.Target.DataRoot, StateHome: targetConfig.StateHome,
		SocketPath: journal.Target.SocketPath, ConfigBytes: targetConfigBytes,
	}}
	targetFence := helperTargetWriterFence{units: units, stack: targetStack, manifest: bridgeManifest}
	privileged, err := handofftransform.NewDockerPrivilegedTreeFS(handofftransform.DockerPrivilegedTreeFSOptions{
		Runner: driver.CommandRunner{MaxOutputBytes: sourceConfig.CommandMaxBytes}, DockerBinary: sourceConfig.DockerBinary,
		ControlRoot: parsed.transactionDirectory, UID: os.Getuid(), GID: os.Getgid(),
	})
	if err != nil {
		return productionHelperAssembly{}, err
	}
	dataBoundary, err := handofftransform.NewProductionBoundary(handofftransform.ProductionBoundaryOptions{
		Engine:         handofftransform.Engine{UID: os.Getuid(), GID: os.Getgid(), PrivilegedTreeFS: privileged},
		ReleaseChannel: sourceConfig.ReleaseChannel, TargetManifest: bridgeRaw, TargetCompose: targetCompose, TargetManager: targetManager,
		Environment: handofftransform.ProductionEnvironment{
			GatewayAddress: targetConfig.GatewayAddress, PlatformBind: "127.0.0.1:18080",
			LogMaxSize: dockerLogSize(targetConfig.LogMaxBytes), LogMaxFiles: targetConfig.LogBackups,
		},
		TargetFence: targetFence,
	})
	if err != nil {
		return productionHelperAssembly{}, err
	}
	sourceSandboxes, err := sandbox.Open(sourceActive, sourceStack, sourceConfig.PlatformDataDir(),
		filepath.Join(sourceConfig.StateDir, "sandboxes.json"), sourceManifest.Images["agent-sandbox"],
		sourceConfig.SandboxNetwork, sourceConfig.SandboxIdle)
	if err != nil {
		return productionHelperAssembly{}, fmt.Errorf("open source Sandbox registry for quiescence: %w", err)
	}
	snapshots := snapshot.Store{DataDir: sourceConfig.PlatformDataDir(), BackupDir: filepath.Join(sourceConfig.DataRoot, "backups")}
	runtimeBoundary, err := handoffhelper.NewProductionRuntime(handoffhelper.ProductionRuntimeOptions{
		Gate:        operation.HTTPGate{BaseURL: sourceConfig.PlatformGateURL, Token: sourceToken},
		SourceStack: sourceStack, SourceManifest: sourceManifest, Bindings: bindings,
		Snapshots: snapshots, SnapshotRoot: filepath.Join(sourceConfig.DataRoot, "backups"),
		Sandboxes: handoffhelper.RegisteredSandboxQuiescer{Registry: sourceSandboxes, Engine: sourceStack}, Units: units,
	})
	if err != nil {
		return productionHelperAssembly{}, err
	}
	participantResolver := helperParticipantControlResolver{units: units, source: sourceConfig, target: targetConfig, journal: journal}
	participants, err := handoffhelper.NewProductionParticipant(handoffhelper.ProductionParticipantOptions{
		Units: units, Observer: handoffhelper.UnixParticipantObserver{Resolver: participantResolver},
		SourceStack: sourceStack, TargetStack: targetStack, SourceManifest: sourceManifest, TargetManifest: bridgeManifest,
		TargetCommitter:    targetPlatformCommitter{gate: operation.HTTPGate{BaseURL: targetConfig.PlatformGateURL, Token: sourceToken}},
		TargetInstallation: installation,
	})
	if err != nil {
		return productionHelperAssembly{}, err
	}
	sourceRelease, err := handoffsource.NewCanonicalSourceReleaseRestorer(parsed.transactionDirectory, sourceConfig.ReleaseChannel, runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return productionHelperAssembly{}, err
	}
	helperDriver, err := handoffhelper.New(handoffhelper.Options{
		TransactionDirectory: parsed.transactionDirectory, Bindings: bindings, Runtime: runtimeBoundary,
		Data: dataBoundary, Participants: participants, SourceRelease: sourceRelease, HelperHost: helperHost,
	})
	if err != nil {
		return productionHelperAssembly{}, err
	}
	endpointResolver := helperOwnershipEndpointResolver{units: units, source: sourceConfig, target: targetConfig}
	probe, err := handofflisteners.NewClosedWorldOwnershipProbe(handofflisteners.ClosedWorldProbeOptions{
		Control: handoffcontrol.Client{Resolver: endpointResolver}, Reachability: handofflisteners.TCPReachability{},
	})
	if err != nil {
		return productionHelperAssembly{}, err
	}
	listeners, err := handofflisteners.NewHelper(handofflisteners.HelperOptions{
		TransactionDirectory: parsed.transactionDirectory, TransactionID: journal.TransactionID,
		Expected: helperExpectedListenerResolver{source: sourceConfig, target: targetConfig, sourceConfigSHA256: sourceDigest}, Probe: probe,
	})
	if err != nil {
		return productionHelperAssembly{}, err
	}
	return productionHelperAssembly{driver: helperDriver, listeners: listeners, sourceConfig: sourceConfig}, nil
}

func validateHelperSourceConfig(journal handoff.Journal, source config.Config, retainedDigest string) error {
	if retainedDigest != journal.Source.ConfigSHA256 {
		return errors.New("source config digest differs from the helper journal")
	}
	profile := identity.SourceProfile()
	if source.ConfigPath != journal.Source.ConfigPath || source.DataRoot != journal.Source.DataRoot ||
		source.StateDir != profile.ManagerStateRoot(journal.Source.DataRoot) || source.SocketPath != journal.Source.SocketPath ||
		source.ComposeProject != journal.Source.ComposeProject || source.SandboxNetwork != journal.Source.CoreNetwork {
		return errors.New("loaded source configuration differs from the helper journal")
	}
	return nil
}

func helperBindingsFromJournal(journal handoff.Journal, source, target config.Config, retainedSourceDigest string) (handoffstartup.Bindings, error) {
	if err := validateHelperSourceConfig(journal, source, retainedSourceDigest); err != nil {
		return handoffstartup.Bindings{}, err
	}
	if target.ConfigPath != journal.Target.ConfigPath || target.DataRoot != journal.Target.DataRoot ||
		target.StateDir != identity.TargetProfile().ManagerStateRoot(journal.Target.DataRoot) ||
		target.SocketPath != journal.Target.SocketPath ||
		target.ComposeProject != journal.Target.ComposeProject || target.SandboxNetwork != journal.Target.CoreNetwork {
		return handoffstartup.Bindings{}, errors.New("derived target configuration differs from the helper journal")
	}
	targetRaw, err := config.RenderHandoffTarget(target)
	if err != nil {
		return handoffstartup.Bindings{}, err
	}
	targetDigest := sha256.Sum256(targetRaw)
	if hex.EncodeToString(targetDigest[:]) != journal.Target.ConfigSHA256 {
		return handoffstartup.Bindings{}, errors.New("derived target configuration digest differs from the helper journal")
	}
	bindings := handoffstartup.Bindings{
		Source: handoffstartup.RuntimePaths{
			StableBinary: journal.Source.StableBinary, ConfigPath: journal.Source.ConfigPath,
			DataRoot: journal.Source.DataRoot, StateRoot: source.StateDir, SocketPath: journal.Source.SocketPath,
		},
		Target: handoffstartup.RuntimePaths{
			StableBinary: journal.Target.StableBinary, ConfigPath: journal.Target.ConfigPath,
			DataRoot: journal.Target.DataRoot, StateRoot: target.StateDir, SocketPath: target.SocketPath,
		},
	}
	if _, err := handoffstartup.NewHelperRouter(bindings); err != nil {
		return handoffstartup.Bindings{}, err
	}
	return bindings, nil
}

type helperTargetInstallation struct {
	host    *handoffhost.LinuxHost
	request handoffhost.TargetInstallationRequest
}

func (installation *helperTargetInstallation) validate(operation handoffhelper.Operation) error {
	if installation == nil || installation.host == nil || operation.TransactionID != installation.request.TransactionID ||
		operation.TransactionDirectory != installation.request.TransactionDirectory || operation.Release.TargetManagerSHA256 != installation.request.ArtifactSHA256 ||
		operation.Target.StableBinary != installation.request.StableBinary || operation.Target.ConfigPath != installation.request.ConfigPath ||
		operation.Target.UnitPath != installation.request.UnitPath || operation.Target.DataRoot != installation.request.DataRoot {
		return errors.New("target installation request differs from the helper operation")
	}
	spec, err := installation.host.ResolveTargetInstallation(installation.request)
	if err != nil {
		return err
	}
	if spec.ConfigSHA256 != operation.Target.ConfigSHA256 {
		return errors.New("target installation config digest differs from the helper operation")
	}
	return nil
}

func (installation *helperTargetInstallation) EnsureTarget(ctx context.Context, operation handoffhelper.Operation) error {
	if err := installation.validate(operation); err != nil {
		return err
	}
	return installation.host.EnsureTargetInstallation(ctx, installation.request)
}
func (installation *helperTargetInstallation) VerifyTarget(ctx context.Context, operation handoffhelper.Operation) error {
	if err := installation.validate(operation); err != nil {
		return err
	}
	return installation.host.VerifyTargetInstallation(ctx, installation.request)
}
func (installation *helperTargetInstallation) RemoveTarget(ctx context.Context, operation handoffhelper.Operation) error {
	if err := installation.validate(operation); err != nil {
		return err
	}
	return installation.host.RemoveTargetInstallation(ctx, installation.request)
}

type helperTargetWriterFence struct {
	units    handoffhelper.SystemdController
	stack    *driver.DockerCLI
	manifest release.Manifest
}

func (fence helperTargetWriterFence) VerifyTargetWritersStopped(ctx context.Context, operation handoffhelper.Operation) (handofftransform.TargetFenceProof, error) {
	state, err := fence.units.Inspect(ctx, operation.Target.Unit, operation.Target.UnitPath)
	if err != nil {
		return handofftransform.TargetFenceProof{}, err
	}
	if state.ActiveState != "inactive" || state.MainPID != 0 || state.UnitFileState == "enabled" ||
		(state.LoadState != "loaded" && state.LoadState != "not-found") {
		return handofftransform.TargetFenceProof{}, errors.New("target Manager writer is not fenced before data rollback")
	}
	if err := fence.stack.VerifyFixedWritersStopped(ctx, fence.manifest); err != nil {
		return handofftransform.TargetFenceProof{}, fmt.Errorf("prove target fixed writers stopped: %w", err)
	}
	return handofftransform.NewTargetFenceProof(operation)
}

type helperParticipantControlResolver struct {
	units          handoffhelper.SystemdController
	source, target config.Config
	journal        handoff.Journal
}

func (resolver helperParticipantControlResolver) ResolveParticipantControl(ctx context.Context, role handoffhelper.ParticipantRole) (handoffhelper.ParticipantControlBinding, error) {
	binding, unit, path, cfg := resolver.journal.Source.SocketPath, resolver.journal.Source.Unit, resolver.journal.Source.UnitPath, resolver.source
	if role == handoffhelper.ParticipantTarget {
		binding, unit, path, cfg = resolver.journal.Target.SocketPath, resolver.journal.Target.Unit, resolver.journal.Target.UnitPath, resolver.target
	} else if role != handoffhelper.ParticipantSource {
		return handoffhelper.ParticipantControlBinding{}, errors.New("participant control role is invalid")
	}
	if err := validateParticipantSocketBinding(binding, cfg.SocketPath); err != nil {
		return handoffhelper.ParticipantControlBinding{}, err
	}
	state, err := resolver.units.Inspect(ctx, unit, path)
	if err != nil {
		return handoffhelper.ParticipantControlBinding{}, err
	}
	if state.LoadState != "loaded" || state.ActiveState != "active" || state.MainPID <= 1 {
		return handoffhelper.ParticipantControlBinding{}, errors.New("participant control unit is not active")
	}
	return handoffhelper.ParticipantControlBinding{SocketPath: cfg.SocketPath, TokenPath: cfg.ControlTokenFile(), MainPID: state.MainPID}, nil
}

type helperOwnershipEndpointResolver struct {
	units          handoffhelper.SystemdController
	source, target config.Config
}

func (resolver helperOwnershipEndpointResolver) ResolveOwnershipEndpoint(ctx context.Context, journal handoff.Journal, role handofflisteners.PublicOwner) (handoffcontrol.Endpoint, error) {
	journalSocket, unit, unitPath, cfg := journal.Source.SocketPath, journal.Source.Unit, journal.Source.UnitPath, resolver.source
	if role == handofflisteners.OwnerTarget {
		journalSocket, unit, unitPath, cfg = journal.Target.SocketPath, journal.Target.Unit, journal.Target.UnitPath, resolver.target
	} else if role != handofflisteners.OwnerSource {
		return handoffcontrol.Endpoint{}, errors.New("ownership endpoint role is invalid")
	}
	if err := validateParticipantSocketBinding(journalSocket, cfg.SocketPath); err != nil {
		return handoffcontrol.Endpoint{}, err
	}
	state, err := resolver.units.Inspect(ctx, unit, unitPath)
	if err != nil {
		return handoffcontrol.Endpoint{}, err
	}
	endpoint := handoffcontrol.Endpoint{SocketPath: cfg.SocketPath, TokenFile: cfg.ControlTokenFile()}
	if state.LoadState == "not-found" && state.ActiveState == "inactive" && state.MainPID == 0 ||
		state.LoadState == "loaded" && state.ActiveState == "inactive" && state.MainPID == 0 {
		endpoint.ProcessAbsent = true
		return endpoint, nil
	}
	if state.LoadState != "loaded" || state.ActiveState != "active" || state.MainPID <= 1 {
		return handoffcontrol.Endpoint{}, errors.New("ownership endpoint process state is ambiguous")
	}
	endpoint.PID = state.MainPID
	return endpoint, nil
}

type helperExpectedListenerResolver struct {
	source, target     config.Config
	sourceConfigSHA256 string
}

func (resolver helperExpectedListenerResolver) ExpectedListeners(_ context.Context, journal handoff.Journal) ([]handofffd.ListenerIdentity, error) {
	if err := validateHelperSourceConfig(journal, resolver.source, resolver.sourceConfigSHA256); err != nil {
		return nil, err
	}
	if resolver.source.GatewayAddress != resolver.target.GatewayAddress || resolver.source.LANEnabled != resolver.target.LANEnabled ||
		resolver.source.LANAddress != resolver.target.LANAddress {
		return nil, errors.New("source and target public listener configurations differ")
	}
	listeners := []handofffd.ListenerIdentity{{Name: "primary", Address: resolver.source.GatewayAddress}}
	if resolver.source.LANEnabled {
		listeners = append(listeners, handofffd.ListenerIdentity{Name: "lan", Address: resolver.source.LANAddress})
	}
	return handofffd.ValidateIdentities(listeners)
}

var (
	_ handoffhelper.TargetInstallationBoundary = (*helperTargetInstallation)(nil)
	_ handofftransform.TargetFenceVerifier     = helperTargetWriterFence{}
	_ handoffhelper.ParticipantControlResolver = helperParticipantControlResolver{}
	_ handoffcontrol.EndpointResolver          = helperOwnershipEndpointResolver{}
	_ handofflisteners.ExpectedResolver        = helperExpectedListenerResolver{}
)
