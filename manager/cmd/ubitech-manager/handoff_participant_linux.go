//go:build linux

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"reflect"
	"runtime"
	"sync"
	"syscall"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/config"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/control"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/driver"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/gateway"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handofffd"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffhelper"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffhost"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handofflisteners"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/journal"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/logstore"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/operation"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

const participantManifestMaximum = 1 << 20

type participantPublicState struct {
	transactionID string
}

func (state participantPublicState) State() model.ManagerState {
	now := time.Now().UTC()
	return model.ManagerState{
		SchemaVersion: 1, PublicState: model.StateUpdating, Maintenance: true,
		ActiveOperationID: state.transactionID, HeartbeatAt: now, UpdatedAt: now,
	}
}

type participantObservationService struct {
	mu sync.Mutex

	transactionID string
	startupRev    uint64
	bindingSHA    string
	role          handoffhelper.ParticipantRole
	generation    string
	executableSHA string
	socketPath    string
	manifestSHA   string
	active        identity.ActiveProfile
	config        config.Config
	manifest      release.Manifest
	docker        *driver.DockerCLI
	gateway       *gatewayController
	autoUpdateAt  time.Time
	now           func() time.Time
}

func (service *participantObservationService) ObserveParticipant(ctx context.Context, challenge handoffhelper.ParticipantChallenge) (handoffhelper.ParticipantObservation, error) {
	if service == nil || service.docker == nil || service.gateway == nil {
		return handoffhelper.ParticipantObservation{}, errors.New("handoff participant observation is unavailable")
	}
	if challenge.TransactionID != service.transactionID || challenge.BindingSHA256 != service.bindingSHA ||
		challenge.Role != service.role || challenge.Revision < service.startupRev {
		return handoffhelper.ParticipantObservation{}, errors.New("participant challenge differs from the consumed startup capability")
	}
	if err := validateParticipantSocketBinding(service.socketPath, service.config.SocketPath); err != nil {
		return handoffhelper.ParticipantObservation{}, err
	}
	coreReady := service.docker.Probe(ctx, service.manifest) == nil
	publicOwned, ownershipErr := service.gateway.PublicListenerOwned()
	if ownershipErr != nil {
		return handoffhelper.ParticipantObservation{}, ownershipErr
	}
	service.mu.Lock()
	defer service.mu.Unlock()
	if service.role == handoffhelper.ParticipantTarget && coreReady && !publicOwned && service.autoUpdateAt.IsZero() {
		if err := service.checkTargetChannel(ctx); err != nil {
			return handoffhelper.ParticipantObservation{}, err
		}
		service.autoUpdateAt = service.clock().UTC()
	}
	// Readiness remains true after the exact listener set is adopted. The helper
	// may have received the SCM_RIGHTS acknowledgement immediately before a crash
	// prevented `target_commit_planned` from being written; ownership itself is
	// challenged independently by the listener boundary on replay.
	ready := service.role == handoffhelper.ParticipantTarget && coreReady && !service.autoUpdateAt.IsZero()
	observation := handoffhelper.ParticipantObservation{
		SchemaVersion: 1, TransactionID: service.transactionID, StartupRevision: service.startupRev,
		BindingSHA256: service.bindingSHA, Role: service.role, Nonce: challenge.Nonce,
		ManagerVersion: version, SourceCommit: service.generation, ExecutableSHA256: service.executableSHA,
		PID: os.Getpid(), SocketPath: service.socketPath, CoreReady: coreReady,
		PublicListenerOwned: publicOwned, ReadyToCommit: ready,
		AutoUpdateCheckAt: service.autoUpdateAt.UTC(), IssuedAt: service.clock().UTC(),
	}
	proof, err := handoffhelper.ComputeParticipantProof(observation)
	if err != nil {
		return handoffhelper.ParticipantObservation{}, err
	}
	observation.ProofSHA256 = proof
	if err := handoffhelper.ValidateParticipantObservation(challenge, observation); err != nil {
		return handoffhelper.ParticipantObservation{}, err
	}
	return observation, nil
}

func (service *participantObservationService) clock() time.Time {
	if service.now != nil {
		return service.now().UTC()
	}
	return time.Now().UTC()
}

func (service *participantObservationService) checkTargetChannel(ctx context.Context) error {
	latest, raw, err := (release.Client{}).FetchForProfile(ctx, service.config.ReleaseURL, service.config.ReleaseChannel, service.active)
	if err != nil {
		return fmt.Errorf("verify target auto-update channel: %w", err)
	}
	digest := sha256.Sum256(raw)
	if latest.ID() != service.generation || latest.SourceCommit != service.generation ||
		hex.EncodeToString(digest[:]) != service.manifestSHA || latest.NamespaceHandoff == nil ||
		latest.NamespaceHandoff.BridgeGeneration != service.generation {
		return errors.New("auto-update channel no longer resolves to the immutable bridge release")
	}
	return nil
}

type participantListenerResolver struct {
	role         handoffhelper.ParticipantRole
	active       identity.ActiveProfile
	config       *config.Manager
	configSHA256 string
}

type targetPlatformCommitter struct {
	gate operation.HTTPGate
}

func (committer targetPlatformCommitter) CommitHandoff(ctx context.Context, transactionID, generation, binding string) (handoff.TargetPlatformCommit, error) {
	receipt, err := committer.gate.CommitTargetHandoff(ctx, operation.TargetHandoffCommitRequest{
		OperationID: transactionID, TargetGeneration: generation, BindingSHA256: binding,
	})
	if err != nil {
		return handoff.TargetPlatformCommit{}, err
	}
	committedAt, err := time.Parse(time.RFC3339Nano, receipt.CommittedAt)
	if err != nil || committedAt.Location() != time.UTC {
		return handoff.TargetPlatformCommit{}, errors.New("target Platform commit timestamp is invalid")
	}
	return handoff.TargetPlatformCommit{
		SchemaVersion: receipt.SchemaVersion, OperationID: receipt.OperationID,
		TargetGeneration: receipt.TargetGeneration, BindingSHA256: receipt.BindingSHA256,
		DatabaseSchemaVersion: receipt.DatabaseSchemaVersion, CommittedAt: receipt.CommittedAt,
		ReceiptSHA256: receipt.ReceiptSHA256,
	}, nil
}

func (resolver participantListenerResolver) ExpectedListeners(_ context.Context, handoffJournal handoff.Journal) ([]handofffd.ListenerIdentity, error) {
	if resolver.config == nil {
		return nil, errors.New("participant listener configuration is unavailable")
	}
	cfg := resolver.config.Config()
	profile, err := resolver.active.Profile()
	if err != nil {
		return nil, err
	}
	switch resolver.role {
	case handoffhelper.ParticipantSource:
		if profile != identity.SourceProfile() || cfg.ConfigPath != handoffJournal.Source.ConfigPath ||
			cfg.DataRoot != handoffJournal.Source.DataRoot || cfg.ComposeProject != handoffJournal.Source.ComposeProject ||
			cfg.SandboxNetwork != handoffJournal.Source.CoreNetwork {
			return nil, errors.New("source participant configuration differs from the handoff journal")
		}
		if resolver.configSHA256 != handoffJournal.Source.ConfigSHA256 {
			return nil, errors.New("source participant configuration digest differs from the handoff journal")
		}
	case handoffhelper.ParticipantTarget:
		if profile != identity.TargetProfile() || cfg.ConfigPath != handoffJournal.Target.ConfigPath ||
			cfg.DataRoot != handoffJournal.Target.DataRoot || cfg.ComposeProject != handoffJournal.Target.ComposeProject ||
			cfg.SandboxNetwork != handoffJournal.Target.CoreNetwork {
			return nil, errors.New("target participant configuration differs from the handoff journal")
		}
		if resolver.configSHA256 != handoffJournal.Target.ConfigSHA256 {
			return nil, errors.New("target participant configuration digest differs from the handoff journal")
		}
	default:
		return nil, errors.New("participant listener role is invalid")
	}
	listeners := []handofffd.ListenerIdentity{{Name: "primary", Address: cfg.GatewayAddress}}
	if cfg.LANEnabled {
		listeners = append(listeners, handofffd.ListenerIdentity{Name: "lan", Address: cfg.LANAddress})
	}
	return handofffd.ValidateIdentities(listeners)
}

// serveHandoffParticipant owns the restricted startup path. It never opens
// the ordinary Manager journal or starts recovery/background mutation until
// the persistent helper has written a terminal handoff journal and released
// its global writer lease.
func serveHandoffParticipant(arguments []string, startup invocationStartup, builder func(identity.ActiveProfile, config.Config, string, bool) (*application, error)) error {
	set := flag.NewFlagSet("serve", flag.ContinueOnError)
	path := set.String("config", "", "manager.toml path")
	if err := set.Parse(arguments); err != nil {
		return err
	}
	if set.NArg() != 0 {
		return errors.New("serve accepts no positional arguments")
	}
	expectedConfig, err := selectedInvocationConfig(startup)
	if err != nil {
		return err
	}
	if *path != "" && filepath.Clean(*path) != expectedConfig {
		return errors.New("Manager config argument differs from the routed technical identity")
	}
	*path = expectedConfig
	active := startup.activeProfile()
	if !startup.configBound || startup.configuration.ConfigPath != expectedConfig {
		return errors.New("participant startup did not retain its authenticated Manager configuration")
	}
	routedStable := startup.selectedStableBinary()
	if err := verifyStartupConfigSnapshotStillBound(startup.configSnapshot); err != nil {
		return fmt.Errorf("revalidate participant configuration before restricted startup: %w", err)
	}
	cfg := startup.configuration
	profile, err := active.Profile()
	if err != nil {
		return err
	}
	role := handoffhelper.ParticipantSource
	listenerRole := handofflisteners.OwnerSource
	if profile == identity.TargetProfile() {
		role = handoffhelper.ParticipantTarget
		listenerRole = handofflisteners.OwnerTarget
	} else if profile != identity.SourceProfile() {
		return errors.New("handoff participant technical profile is not canonical")
	}
	transactionID, revision, bindingSHA, generation, executableSHA, err := participantStartupIdentity(startup, role)
	if err != nil {
		return err
	}
	initialJournal, err := handoff.ReadParticipantJournal(startup.txDir, transactionID, bindingSHA, revision)
	if err != nil {
		return err
	}
	if err := validateParticipantJournal(initialJournal, startup, role, generation, executableSHA); err != nil {
		return err
	}
	journalSocketPath := initialJournal.Source.SocketPath
	if role == handoffhelper.ParticipantTarget {
		journalSocketPath = initialJournal.Target.SocketPath
	}
	if err := validateParticipantSocketBinding(journalSocketPath, cfg.SocketPath); err != nil {
		return err
	}
	manifest, rawManifest, err := loadHandoffParticipantManifest(active, cfg, generation, role, startup.txDir, transactionID)
	if err != nil {
		return err
	}
	if manifest.SourceCommit != generation {
		return errors.New("participant retained manifest differs from its startup generation")
	}
	retainedDigest := sha256.Sum256(rawManifest)
	expectedManifestSHA := initialJournal.Release.ManifestSHA256
	if role == handoffhelper.ParticipantSource {
		expectedManifestSHA = initialJournal.Source.ManifestSHA256
	}
	if hex.EncodeToString(retainedDigest[:]) != expectedManifestSHA {
		return errors.New("participant retained manifest digest differs from the handoff journal")
	}
	controlToken, err := driver.ReadOwnerSecret(cfg.ControlTokenFile())
	if err != nil {
		return err
	}
	runningSHA, err := runningExecutableSHA256()
	if err != nil || runningSHA != executableSHA {
		return errors.Join(err, errors.New("participant running executable differs from its startup capability"))
	}
	configs := config.NewManager(cfg)
	participantDocker := newDockerDriver(active, cfg)
	if role == handoffhelper.ParticipantSource {
		recoveryPaths, pathErr := handoff.DeriveRecoveryBundlePaths(startup.txDir, transactionID)
		if pathErr != nil {
			return pathErr
		}
		participantDocker.ComposeFile = recoveryPaths.SourceCompose
		participantDocker.ComposeSHA256 = initialJournal.Source.ComposeSHA256
		participantDocker.ManifestFile = recoveryPaths.SourceManifest
		participantDocker.ManifestSHA256 = initialJournal.Source.ManifestSHA256
		participantDocker.ManifestChannel = cfg.ReleaseChannel
		participantDocker.RequireLocalImages = true
		participantDocker.ExpectedCoreNetworkID = initialJournal.Source.CoreNetworkID
	} else {
		participantDocker.ManifestFile = filepath.Join(cfg.StateDir, "releases", generation, "manifest.json")
		participantDocker.ManifestSHA256 = initialJournal.Release.ManifestSHA256
		participantDocker.ManifestChannel = cfg.ReleaseChannel
		participantDocker.ComposeFile = filepath.Join(cfg.StateDir, "releases", generation, "compose.yaml")
		participantDocker.ComposeSHA256 = initialJournal.Release.TargetComposeSHA256
	}
	restricted := &application{
		profile: active, config: cfg, configs: configs, docker: participantDocker,
		publicState: participantPublicState{transactionID: transactionID},
	}
	gatewayControl := newGatewayController(restricted)
	if err := gatewayControl.WaitForHandoffListeners(); err != nil {
		return err
	}
	if err := gatewayControl.ConfigureHandoffParticipant(initialJournal, listenerRole); err != nil {
		return err
	}
	retainedConfigDigest, err := startupConfigSnapshotSHA256(startup.configSnapshot)
	if err != nil {
		return fmt.Errorf("digest retained participant configuration: %w", err)
	}
	resolver := participantListenerResolver{role: role, active: active, config: configs, configSHA256: retainedConfigDigest}
	receiverRole := handofflisteners.ParticipantSource
	if role == handoffhelper.ParticipantTarget {
		receiverRole = handofflisteners.ParticipantTarget
	}
	receiver, err := handofflisteners.OpenParticipantReceiver(handofflisteners.ParticipantOptions{
		TransactionDirectory: startup.txDir, TransactionID: transactionID, Role: receiverRole, Expected: resolver,
	})
	if err != nil {
		return err
	}
	defer receiver.Close()
	observer := &participantObservationService{
		transactionID: transactionID, startupRev: revision, bindingSHA: bindingSHA, role: role,
		generation: generation, executableSHA: executableSHA, socketPath: journalSocketPath,
		manifestSHA: initialJournal.Release.ManifestSHA256, active: active, config: cfg, manifest: manifest,
		docker: restricted.docker, gateway: gatewayControl,
	}
	restrictedAPI := &control.API{
		ControlToken: controlToken, ManagerVersion: version, ManagerSHA256: runningSHA,
		HandoffParticipantOnly: true, HandoffTransactionID: transactionID, ParticipantObserver: observer,
		OwnershipProof: control.OwnershipProofProviderFunc(gatewayControl.ProveListenerOwnership),
	}
	listener, err := control.Listen(cfg.SocketPath)
	if err != nil {
		return err
	}
	defer listener.Close()
	controlHandler := newAtomicControlHandler(restrictedAPI)
	server := &http.Server{Handler: controlHandler, ReadHeaderTimeout: 15 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 32 << 10}
	serveErrors := make(chan error, 1)
	go func() {
		if serveErr := server.Serve(listener); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			serveErrors <- serveErr
		}
	}()
	defer server.Close()

	ctx, stop := signalContext()
	defer stop()
	adopted := make(chan error, 1)
	go func() { adopted <- receiver.ReceiveAndAdopt(ctx, initialJournal, gatewayControl.AdoptHandoffListeners) }()
	select {
	case err := <-adopted:
		if err != nil && !errors.Is(err, handofffd.ErrPostAdoptionAcknowledgement) {
			return err
		}
	case err := <-serveErrors:
		return err
	case <-ctx.Done():
		return nil
	}
	terminal, err := awaitParticipantTerminal(ctx, startup, role)
	if err != nil {
		return err
	}
	revalidationContext, cancelRevalidation := context.WithTimeout(context.Background(), 35*time.Second)
	startupOwnership, err := acquireServeStartupOwnershipWithConfigAndRevalidation(active, cfg, routedStable, func() error {
		return verifyRoutedStartupDecision(revalidationContext, startup, true)
	})
	cancelRevalidation()
	if err != nil {
		return fmt.Errorf("acquire terminal Manager startup ownership: %w", err)
	}
	defer startupOwnership.release()
	full, err := builder(active, cfg, routedStable, false)
	if err != nil {
		return err
	}
	if full.handoffStore == nil {
		return errors.New("terminal Manager did not open the namespace handoff store")
	}
	defer full.handoffStore.Close()
	startupOwnership.lease, err = ensureServeStartupOwnership(full.selfUpdate, startupOwnership.lease)
	if err != nil {
		return err
	}
	if pending, err := full.selfUpdate.PendingActivation(); err != nil {
		return err
	} else if pending {
		return errors.New("namespace handoff terminal promotion cannot overlap a Manager activation")
	}
	if err := full.sandboxes.CommitRegistryUpgrade(); err != nil {
		return err
	}
	if err := gatewayControl.PromoteApplication(full); err != nil {
		return err
	}
	full.api.OwnershipProof = control.OwnershipProofProviderFunc(gatewayControl.ProveListenerOwnership)
	full.configs.SetLANApply(gatewayControl.ApplyLANConfig)
	full.operations.PublicProbe = gatewayControl.Health
	var sourceTransfer *sourceListenerHandoff
	if role == handoffhelper.ParticipantSource {
		sourceTransfer, err = newSourceListenerHandoff(gatewayControl, full.configs)
		if err != nil {
			return err
		}
		defer sourceTransfer.Close()
		full.startSourceHandoff = sourceTransfer.Start
	}
	if err := gatewayControl.CompleteHandoffParticipant(transactionID); err != nil {
		return err
	}
	controlHandler.promote(full.api)
	startupOwnership.lease.Release()
	go gatewayControl.Run()
	defer gatewayControl.Stop()
	go retryTerminalHelperCleanup(ctx, full, terminal)
	initialFailures := initialCurrentRecovery(ctx, defaultCurrentRecoveryPolicy, full.recoverCurrent)
	go runCurrentRecoveryLoop(ctx, initialFailures, defaultCurrentRecoveryPolicy, full.operations.RecoveryPending, full.recoverCurrent)
	go full.background(ctx)
	select {
	case <-ctx.Done():
		if !full.processes.ShutdownHost() {
			return errors.New("one or more host process groups could not be terminated during Manager shutdown")
		}
		shutdown, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		return server.Shutdown(shutdown)
	case err := <-serveErrors:
		return err
	}
}

func validateParticipantSocketBinding(journalPath, actualPath string) error {
	for label, path := range map[string]string{"journal": journalPath, "runtime": actualPath} {
		if path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path {
			return fmt.Errorf("participant %s control socket is not canonical and absolute", label)
		}
	}
	if journalPath != actualPath {
		return errors.New("participant control socket differs from its journal binding")
	}
	return nil
}

func signalContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
}

func participantStartupIdentity(startup invocationStartup, role handoffhelper.ParticipantRole) (string, uint64, string, string, string, error) {
	if startup.mode == invocationStartupFormalParticipant && startup.decision.Snapshot != nil {
		snapshot := startup.decision.Snapshot
		return snapshot.TransactionID, snapshot.Revision, snapshot.BindingSHA256, snapshot.Generation, snapshot.ManagerSHA256, nil
	}
	if startup.mode == invocationStartupAbortParticipant && startup.abort != nil && role == handoffhelper.ParticipantSource {
		return startup.abort.TransactionID, startup.abort.Revision, startup.abort.BindingSHA256, version, startup.abort.ManagerSHA256, nil
	}
	return "", 0, "", "", "", errors.New("handoff participant startup decision is incomplete")
}

func validateParticipantJournal(value handoff.Journal, startup invocationStartup, role handoffhelper.ParticipantRole, generation, executableSHA string) error {
	if value.TransactionID == "" || value.BindingSHA256 == "" || value.Revision == 0 {
		return errors.New("participant journal identity is incomplete")
	}
	switch role {
	case handoffhelper.ParticipantTarget:
		if startup.mode != invocationStartupFormalParticipant || value.Release.BridgeGeneration != generation ||
			value.Release.TargetManagerSHA256 != executableSHA || value.Target.Namespace != identity.TargetProfile().ProfileID ||
			startup.decision.ConfigSHA256 != value.Target.ConfigSHA256 {
			return errors.New("target participant journal differs from its startup capability")
		}
	case handoffhelper.ParticipantSource:
		if value.Release.PredecessorGeneration != generation || value.Source.StableSHA256 != executableSHA ||
			value.Source.Namespace != identity.SourceProfile().ProfileID {
			return errors.New("source participant journal differs from its startup capability")
		}
		configSHA256 := startup.decision.ConfigSHA256
		if startup.mode == invocationStartupAbortParticipant && startup.abort != nil {
			configSHA256 = startup.abort.ConfigSHA256
		}
		if configSHA256 != value.Source.ConfigSHA256 {
			return errors.New("source participant config digest differs from its startup capability")
		}
	default:
		return errors.New("participant journal role is invalid")
	}
	return nil
}

func loadParticipantManifest(active identity.ActiveProfile, cfg config.Config, generation string) (release.Manifest, []byte, error) {
	path := filepath.Join(cfg.StateDir, "releases", generation, "manifest.json")
	raw, err := readOwnerInputFile(path, participantManifestMaximum)
	if err != nil {
		return release.Manifest{}, nil, fmt.Errorf("read participant retained manifest: %w", err)
	}
	manifest, err := release.DecodeManifestForProfile(raw, cfg.ReleaseChannel, runtime.GOOS, runtime.GOARCH, active)
	if err != nil {
		return release.Manifest{}, nil, err
	}
	return manifest, raw, nil
}

func loadHandoffParticipantManifest(active identity.ActiveProfile, cfg config.Config, generation string, role handoffhelper.ParticipantRole, transactionDirectory, transactionID string) (release.Manifest, []byte, error) {
	if role == handoffhelper.ParticipantTarget {
		return loadParticipantManifest(active, cfg, generation)
	}
	if role != handoffhelper.ParticipantSource {
		return release.Manifest{}, nil, errors.New("participant manifest role is invalid")
	}
	paths, err := handoff.DeriveRecoveryBundlePaths(transactionDirectory, transactionID)
	if err != nil {
		return release.Manifest{}, nil, err
	}
	raw, err := readOwnerInputFile(paths.SourceManifest, participantManifestMaximum)
	if err != nil {
		return release.Manifest{}, nil, fmt.Errorf("read bundled source participant manifest: %w", err)
	}
	manifest, err := release.DecodeManifestForProfile(raw, cfg.ReleaseChannel, runtime.GOOS, runtime.GOARCH, active)
	if err != nil {
		return release.Manifest{}, nil, err
	}
	return manifest, raw, nil
}

func awaitParticipantTerminal(ctx context.Context, startup invocationStartup, role handoffhelper.ParticipantRole) (handoff.Journal, error) {
	transactionID, revision, binding, _, _, err := participantStartupIdentity(startup, role)
	if err != nil {
		return handoff.Journal{}, err
	}
	configPath, err := selectedInvocationConfig(startup)
	if err != nil {
		return handoff.Journal{}, err
	}
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		current, readErr := handoff.ReadParticipantJournal(startup.txDir, transactionID, binding, revision)
		if readErr == nil && current.Terminal() {
			route, routeErr := resolveInvocationStartupMode(ctx, "", true, configPath)
			if routeErr == nil && route.mode == invocationStartupStable && route.decision.TransactionID == transactionID &&
				reflect.DeepEqual(route.activeProfile(), startup.activeProfile()) {
				if role == handoffhelper.ParticipantTarget && current.Status != handoff.StatusCommitted {
					return handoff.Journal{}, errors.New("target participant reached a non-committed terminal journal")
				}
				if role == handoffhelper.ParticipantSource && current.Status == handoff.StatusCommitted {
					return handoff.Journal{}, errors.New("source participant cannot promote a committed target journal")
				}
				return current, nil
			}
		}
		select {
		case <-ctx.Done():
			return handoff.Journal{}, ctx.Err()
		case <-ticker.C:
		}
	}
}

func retryTerminalHelperCleanup(ctx context.Context, app *application, value handoff.Journal) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		if err := cleanupTerminalHelper(ctx, value); err == nil {
			return
		} else if app != nil && app.audit != nil {
			_ = app.audit.Append(logstore.Event{At: time.Now().UTC(), Type: "handoff.helper_cleanup_failed", Error: journal.BoundDiagnostic(err.Error())})
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func cleanupTerminalHelper(ctx context.Context, value handoff.Journal) error {
	if !value.Terminal() || value.Helper == nil {
		return errors.New("terminal helper cleanup requires durable helper evidence")
	}
	host := &handoffhost.LinuxHost{}
	request := handoffhost.ArmRequest{
		TargetProfile: identity.TargetProfile(), TransactionID: value.TransactionID,
		TransactionDirectory: filepath.Dir(value.Release.ManifestPath), ArtifactPath: value.Helper.Executable,
		ArtifactSHA256: value.Release.TargetManagerSHA256, UnitDirectory: filepath.Dir(value.Target.UnitPath),
		JournalPath: filepath.Join(filepath.Dir(value.Release.ManifestPath), "journal.json"),
	}
	// The retained bridge manifest is stored below the transaction root only in
	// tests; production journals bind ManifestPath elsewhere. Derive the helper
	// transaction directory from its installed executable instead.
	request.TransactionDirectory = filepath.Dir(filepath.Dir(value.Helper.Executable))
	request.JournalPath = filepath.Join(request.TransactionDirectory, "journal.json")
	spec, err := host.Resolve(request)
	if err != nil {
		return err
	}
	if value.Helper.Unit != spec.UnitName || value.Helper.UnitSHA256 != spec.UnitSHA256 ||
		value.Helper.Executable != spec.ExecutablePath || value.Helper.SHA256 != spec.ExecutableSHA256 ||
		value.Helper.ArgvSHA256 != handoffhost.ArgvSHA256(spec.Argv) {
		return errors.New("terminal helper static evidence differs from its transaction-derived spec")
	}
	proof := handoffhost.HelperProof{
		TransactionID: spec.TransactionID, UnitName: spec.UnitName, UnitPath: spec.UnitPath,
		UnitSHA256: spec.UnitSHA256, ExecutablePath: spec.ExecutablePath,
		ExecutableSHA256: spec.ExecutableSHA256, Argv: append([]string(nil), spec.Argv...),
		ControlGroup: value.Helper.ControlGroup,
	}
	result, err := host.RemoveInactive(ctx, handoffhost.RemovalRequest{Spec: spec, ExpectedProof: proof})
	if err != nil {
		return err
	}
	if !result.UnitRemoved || !result.ExecutableRemoved {
		return errors.New("terminal helper cleanup did not remove both static artifacts")
	}
	return nil
}

var _ gateway.StateProvider = participantPublicState{}
var _ control.ParticipantObservationProvider = (*participantObservationService)(nil)
