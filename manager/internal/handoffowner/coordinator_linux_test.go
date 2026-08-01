//go:build linux

package handoffowner

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handofffd"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

const (
	testPredecessor = "1111111111111111111111111111111111111111"
	testBridge      = "2222222222222222222222222222222222222222"
	testSourceSHA   = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testTargetSHA   = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	testSourceYAML  = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	testTargetYAML  = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	testManifestSHA = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
	testProofSHA    = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
)

type crashMarker struct{ step string }

type steppingClock struct {
	mu  sync.Mutex
	now time.Time
}

func (clock *steppingClock) Next() time.Time {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	clock.now = clock.now.Add(time.Second)
	return clock.now
}

type fakeHost struct {
	mu              sync.Mutex
	events          []string
	failures        map[string]int
	crashes         map[string]int
	plan            PreflightPlan
	store           *handoff.Store
	armSawJournal   bool
	helperLeaseHeld bool
	runtime         RuntimeObservation
	observationHook func()
	afterStopTarget func()
}

func (host *fakeHost) hit(step string) error {
	host.mu.Lock()
	host.events = append(host.events, step)
	if host.crashes[step] > 0 {
		host.crashes[step]--
		host.mu.Unlock()
		panic(crashMarker{step: step})
	}
	if host.failures[step] > 0 {
		host.failures[step]--
		host.mu.Unlock()
		return fmt.Errorf("injected %s failure", step)
	}
	host.mu.Unlock()
	return nil
}

func (host *fakeHost) count(step string) int {
	host.mu.Lock()
	defer host.mu.Unlock()
	count := 0
	for _, event := range host.events {
		if event == step {
			count++
		}
	}
	return count
}

func (host *fakeHost) filteredEvents() []string {
	host.mu.Lock()
	defer host.mu.Unlock()
	result := make([]string, 0, len(host.events))
	for _, event := range host.events {
		if event != "verify_helper" {
			result = append(result, event)
		}
	}
	return result
}

func (host *fakeHost) Preflight(_ context.Context, _ BridgeRequest, _, _ identity.Profile) (PreflightPlan, error) {
	if err := host.hit("preflight"); err != nil {
		return PreflightPlan{}, err
	}
	plan := host.plan
	plan.Admission = noOpRuntimeAdmission{observation: plan.Runtime}
	return plan, nil
}

type noOpRuntimeAdmission struct{ observation RuntimeObservation }

func (lease noOpRuntimeAdmission) Observe(context.Context) (RuntimeObservation, error) {
	return lease.observation, nil
}
func (noOpRuntimeAdmission) Close() error { return nil }

func (host *fakeHost) ArmPersistentHelper(_ context.Context, journal handoff.Journal) error {
	if host.store != nil {
		loaded, err := host.store.Load(journal.TransactionID)
		if err == nil && loaded.Revision >= 1 {
			host.mu.Lock()
			host.armSawJournal = true
			host.mu.Unlock()
		}
	}
	return host.hit("arm")
}

func (host *fakeHost) VerifyPersistentHelper(_ context.Context, journal handoff.Journal) (handoff.HelperEvidence, error) {
	if err := host.hit("verify_helper"); err != nil {
		return handoff.HelperEvidence{}, err
	}
	suffix := strings.TrimPrefix(journal.TransactionID, "handoff_")[:12]
	return handoff.HelperEvidence{
		Unit:       identity.TargetProfile().DataDirectory + "-namespace-handoff-" + suffix + ".service",
		UnitSHA256: testProofSHA,
		Executable: filepath.Join(filepath.Dir(journal.Target.StableBinary), "handoff-helper"),
		SHA256:     journal.Release.TargetManagerSHA256, ArgvSHA256: testProofSHA,
		ControlGroup: "/user.slice/handoff.service",
	}, nil
}

func (host *fakeHost) FinalizePersistentHelper(context.Context, handoff.Journal) error {
	return host.hit("finalize")
}
func (host *fakeHost) ReserveAdmission(context.Context, handoff.Journal) error {
	return host.hit("reserve")
}
func (host *fakeHost) DrainAndStopWriters(context.Context, handoff.Journal) error {
	return host.hit("drain")
}
func (host *fakeHost) CreateSnapshot(_ context.Context, journal handoff.Journal) (handoff.Snapshot, error) {
	if err := host.hit("snapshot"); err != nil {
		return handoff.Snapshot{}, err
	}
	return handoff.Snapshot{Path: filepath.Join(filepath.Dir(journal.Source.DataRoot), "snapshot"), ManifestSHA256: testProofSHA}, nil
}
func (host *fakeHost) FenceSource(_ context.Context, journal handoff.Journal) error {
	if host.store != nil {
		other, _, err := host.store.OpenHelper(journal.TransactionID)
		if other != nil {
			_ = other.Close()
		}
		if errors.Is(err, handoff.ErrBusy) {
			host.mu.Lock()
			host.helperLeaseHeld = true
			host.mu.Unlock()
		}
	}
	return host.hit("fence")
}
func (host *fakeHost) StageTarget(context.Context, handoff.Journal) error {
	return host.hit("stage")
}
func (host *fakeHost) TransformData(context.Context, handoff.Journal) error {
	return host.hit("transform")
}

func (host *fakeHost) StartTarget(_ context.Context, journal handoff.Journal, lease handoff.StartupLease) error {
	locked, err := lease.Load()
	if err != nil || locked.TransactionID != journal.TransactionID || locked.Revision != journal.Revision {
		if err == nil {
			err = errors.New("target startup lease does not match coordinator journal")
		}
		return err
	}
	return host.hit("start_target")
}
func (host *fakeHost) ProbeTarget(context.Context, handoff.Journal) error {
	return host.hit("probe")
}
func (host *fakeHost) TargetAcknowledgement(_ context.Context, journal handoff.Journal) (handoff.TargetAck, error) {
	if err := host.hit("target_ack"); err != nil {
		return handoff.TargetAck{}, err
	}
	issuedAt := journal.UpdatedAt.Add(100 * time.Millisecond)
	return handoff.TargetAck{
		ManagerVersion:   journal.Release.TargetManagerVersion,
		ExecutableSHA256: journal.Release.TargetManagerSHA256,
		SourceCommit:     journal.Release.BridgeGeneration,
		PID:              2222, SocketPath: journal.Target.SocketPath,
		AutoUpdateCheckAt: issuedAt, IssuedAt: issuedAt, ProofSHA256: testProofSHA,
	}, nil
}
func (host *fakeHost) RetireSource(context.Context, handoff.Journal) error {
	return host.hit("retire")
}
func (host *fakeHost) VerifyTargetCommitBoundary(context.Context, handoff.Journal) error {
	return host.hit("verify_commit")
}
func (host *fakeHost) CommitTargetPlatform(_ context.Context, journal handoff.Journal) (handoff.TargetPlatformCommit, error) {
	if err := host.hit("commit_platform"); err != nil {
		return handoff.TargetPlatformCommit{}, err
	}
	receipt := handoff.TargetPlatformCommit{
		SchemaVersion: 1, OperationID: journal.TransactionID,
		TargetGeneration: journal.Release.BridgeGeneration, BindingSHA256: journal.BindingSHA256,
		DatabaseSchemaVersion: journal.Evidence.DatabaseSchemaVersion, CommittedAt: journal.UpdatedAt.Add(100 * time.Millisecond).Format(time.RFC3339Nano),
	}
	receipt.ReceiptSHA256, _ = handoff.ComputeTargetPlatformCommitSHA256(receipt)
	return receipt, nil
}
func (host *fakeHost) StopTarget(context.Context, handoff.Journal) error {
	if err := host.hit("stop_target"); err != nil {
		return err
	}
	if host.afterStopTarget != nil {
		host.afterStopTarget()
	}
	return nil
}
func (host *fakeHost) RestoreData(context.Context, handoff.Journal) error {
	return host.hit("restore_data")
}

func (host *fakeHost) StartSource(_ context.Context, journal handoff.Journal, lease handoff.StartupLease) error {
	locked, err := lease.Load()
	if err != nil || locked.TransactionID != journal.TransactionID || locked.Revision != journal.Revision {
		if err == nil {
			err = errors.New("source startup lease does not match coordinator journal")
		}
		return err
	}
	return host.hit("start_source")
}
func (host *fakeHost) RestoreSourceBeforeFence(context.Context, handoff.Journal, handoff.StartupLease) error {
	return host.hit("restore_source_before_fence")
}
func (host *fakeHost) ReleaseAdmission(context.Context, handoff.Journal) error {
	return host.hit("release_admission")
}
func (host *fakeHost) RemoveTargetStaging(context.Context, handoff.Journal) error {
	return host.hit("remove_staging")
}
func (host *fakeHost) VerifySourceIdentity(context.Context, handoff.Journal) error {
	return host.hit("verify_source")
}
func (host *fakeHost) VerifySourcePublicReady(context.Context, handoff.Journal) error {
	return host.hit("verify_source_public")
}
func (host *fakeHost) AcquireRuntimeObservationLease(context.Context) (RuntimeObservationLease, error) {
	if err := host.hit("acquire_observation"); err != nil {
		return nil, err
	}
	return &fakeRuntimeLease{host: host}, nil
}

type fakeRuntimeLease struct{ host *fakeHost }

func (lease *fakeRuntimeLease) Observe(context.Context) (RuntimeObservation, error) {
	if err := lease.host.hit("observe_runtime"); err != nil {
		return RuntimeObservation{}, err
	}
	lease.host.mu.Lock()
	hook := lease.host.observationHook
	runtimeObservation := lease.host.runtime
	lease.host.mu.Unlock()
	if hook != nil {
		hook()
	}
	return runtimeObservation, nil
}

func (lease *fakeRuntimeLease) Close() error { return lease.host.hit("release_observation") }

type fakeListeners struct{ host *fakeHost }

func (listeners *fakeListeners) EnsureMaintenance(_ context.Context, journal handoff.Journal, lease handoff.StartupLease, current ListenerState) (ListenerState, error) {
	if current, err := lease.Load(); err != nil || current.TransactionID != journal.TransactionID || current.Revision != journal.Revision {
		if err != nil {
			return ListenerState{}, err
		}
		return ListenerState{}, errors.New("listener acquisition lease differs from coordinator journal")
	}
	if current.Owner != ListenerOwnerUnknown {
		return current, nil
	}
	if err := listeners.host.hit("acquire_listeners"); err != nil {
		return ListenerState{}, err
	}
	return ListenerState{Owner: ListenerOwnerHelper, Listeners: []handofffd.NamedListener{{Name: "primary"}}}, nil
}
func (listeners *fakeListeners) CommitToTarget(_ context.Context, journal handoff.Journal, lease handoff.StartupLease, _ []handofffd.NamedListener) error {
	if current, err := lease.Load(); err != nil || current.TransactionID != journal.TransactionID || current.Revision != journal.Revision {
		if err != nil {
			return err
		}
		return errors.New("target listener commit lease differs from coordinator journal")
	}
	return listeners.host.hit("commit_target")
}
func (listeners *fakeListeners) RestoreToSource(_ context.Context, journal handoff.Journal, lease handoff.StartupLease, _ []handofffd.NamedListener) error {
	if current, err := lease.Load(); err != nil || current.TransactionID != journal.TransactionID || current.Revision != journal.Revision {
		if err != nil {
			return err
		}
		return errors.New("source listener restore lease differs from coordinator journal")
	}
	return listeners.host.hit("restore_listeners")
}

// replayListeners models custody independently from Coordinator's in-process
// descriptor slice, as a real participant does across helper crashes.
type replayListeners struct {
	host  *fakeHost
	mu    sync.Mutex
	owner ListenerOwner
}

func (listeners *replayListeners) EnsureMaintenance(_ context.Context, journal handoff.Journal, lease handoff.StartupLease, _ ListenerState) (ListenerState, error) {
	if current, err := lease.Load(); err != nil || current.TransactionID != journal.TransactionID || current.Revision != journal.Revision {
		return ListenerState{}, errors.Join(err, errors.New("replay listener lease differs from coordinator journal"))
	}
	listeners.mu.Lock()
	owner := listeners.owner
	if owner == ListenerOwnerUnknown {
		owner = ListenerOwnerHelper
		listeners.owner = owner
	}
	listeners.mu.Unlock()
	if err := listeners.host.hit("ensure_" + string(owner)); err != nil {
		return ListenerState{}, err
	}
	if owner == ListenerOwnerHelper {
		return ListenerState{Owner: owner, Listeners: []handofffd.NamedListener{{Name: "primary"}}}, nil
	}
	return ListenerState{Owner: owner}, nil
}

func (listeners *replayListeners) CommitToTarget(_ context.Context, journal handoff.Journal, lease handoff.StartupLease, _ []handofffd.NamedListener) error {
	if current, err := lease.Load(); err != nil || current.TransactionID != journal.TransactionID || current.Revision != journal.Revision {
		return errors.Join(err, errors.New("replay target transfer lease differs from coordinator journal"))
	}
	listeners.mu.Lock()
	listeners.owner = ListenerOwnerTarget
	listeners.mu.Unlock()
	return listeners.host.hit("commit_target")
}

func (listeners *replayListeners) RestoreToSource(_ context.Context, journal handoff.Journal, lease handoff.StartupLease, _ []handofffd.NamedListener) error {
	if current, err := lease.Load(); err != nil || current.TransactionID != journal.TransactionID || current.Revision != journal.Revision {
		return errors.Join(err, errors.New("replay source transfer lease differs from coordinator journal"))
	}
	listeners.mu.Lock()
	listeners.owner = ListenerOwnerSource
	listeners.mu.Unlock()
	return listeners.host.hit("restore_listeners")
}

func (listeners *replayListeners) dropProcessDescriptors() {
	listeners.mu.Lock()
	listeners.owner = ListenerOwnerUnknown
	listeners.mu.Unlock()
}

func (listeners *replayListeners) setOwner(owner ListenerOwner) {
	listeners.mu.Lock()
	listeners.owner = owner
	listeners.mu.Unlock()
}

func (listeners *replayListeners) currentOwner() ListenerOwner {
	listeners.mu.Lock()
	defer listeners.mu.Unlock()
	return listeners.owner
}

type ownerFixture struct {
	store       *handoff.Store
	coordinator *Coordinator
	host        *fakeHost
	request     BridgeRequest
	clock       *steppingClock
}

func newOwnerFixture(t *testing.T) ownerFixture {
	t.Helper()
	root := t.TempDir()
	stateHome := filepath.Join(root, "state")
	shareHome := filepath.Join(root, ".local", "share")
	for _, directory := range []string{stateHome, shareHome} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	sourceProfile, targetProfile := identity.SourceProfile(), identity.TargetProfile()
	sourceRoot := filepath.Join(shareHome, sourceProfile.DataDirectory)
	targetRoot := filepath.Join(shareHome, targetProfile.DataDirectory)
	if err := os.Mkdir(sourceRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	journalRoot := filepath.Join(stateHome, targetProfile.DataDirectory, "handoff")
	store, err := handoff.Open(journalRoot, sourceRoot, targetRoot)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })

	managerArtifact := func(version, digest, name string) release.ManagerRelease {
		return release.ManagerRelease{Version: version, Artifacts: map[string]release.Artifact{
			"amd64": {URL: "https://example.invalid/" + name + "-amd64", SHA256: digest},
			"arm64": {URL: "https://example.invalid/" + name + "-arm64", SHA256: digest},
		}}
	}
	sourceManager := managerArtifact(testPredecessor, testSourceSHA, "source")
	targetManager := managerArtifact(testBridge, testTargetSHA, "target")
	sourceCompose := release.Artifact{URL: "https://example.invalid/source-compose", SHA256: testSourceYAML}
	targetCompose := release.Artifact{URL: "https://example.invalid/target-compose", SHA256: testTargetYAML}
	images := make(map[string]string)
	for _, name := range []string{
		"platform", "agent-runtime", "camofox", "agent-sandbox", "searxng",
		"firecrawl-api", "firecrawl-playwright", "firecrawl-postgres", "firecrawl-redis", "firecrawl-rabbitmq", "handoff-fs-helper",
	} {
		images[name] = "registry.invalid/" + name + "@sha256:" + strings.Repeat("9", 64)
	}
	manifest := release.Manifest{
		SchemaVersion: 1, Channel: "main", SourceCommit: testBridge,
		GeneratedAt:     time.Date(2026, 7, 31, 10, 0, 0, 0, time.UTC),
		ProtocolVersion: 1, DatabaseSchemaVersion: 2026072901,
		Manager: targetManager, Compose: targetCompose, Images: images,
		NamespaceHandoff: &release.NamespaceHandoff{
			SchemaVersion: 1, PredecessorGeneration: testPredecessor, BridgeGeneration: testBridge,
			Source: release.NamespaceBinding{ProfileID: sourceProfile.ProfileID, Manager: sourceManager, Compose: sourceCompose},
			Target: release.NamespaceBinding{ProfileID: targetProfile.ProfileID, Manager: targetManager, Compose: targetCompose},
		},
	}
	unitHome := filepath.Join(root, ".config", "systemd", "user")
	configHome := filepath.Join(root, ".config")
	binHome := filepath.Join(root, ".local", "bin")
	request := BridgeRequest{
		Manifest: manifest, ManifestPath: filepath.Join(sourceProfile.ManagerStateRoot(sourceRoot), "releases", testBridge, "manifest.json"),
		ManifestSHA256: testManifestSHA,
	}
	plan := PreflightPlan{
		Source: handoff.SourceBinding{
			Namespace: sourceProfile.ProfileID, Unit: sourceProfile.ManagerUnit, UnitEnabled: true,
			UnitPath: filepath.Join(unitHome, sourceProfile.ManagerUnit), UnitSHA256: strings.Repeat("1", 64),
			StableBinary: sourceProfile.ManagerInstallPath(binHome), StableSHA256: testSourceSHA,
			ConfigPath: sourceProfile.DefaultConfigPath(configHome), ConfigSHA256: strings.Repeat("2", 64),
			ManifestPath: filepath.Join(sourceProfile.ManagerStateRoot(sourceRoot), "releases", testPredecessor, "manifest.json"), ManifestSHA256: strings.Repeat("d", 64),
			ComposePath: filepath.Join(sourceProfile.ManagerStateRoot(sourceRoot), "releases", testPredecessor, "compose.yaml"), ComposeSHA256: testSourceYAML,
			DataRoot: sourceRoot, SocketPath: filepath.Join(sourceRoot, filepath.FromSlash(sourceProfile.DataRootSocketPath)),
			ComposeProject: sourceProfile.ComposeProject, CoreNetwork: sourceProfile.CoreNetwork,
			CoreNetworkID: "abcdefabcdef", LabelPrefix: sourceProfile.LabelPrefix,
		},
		Target: handoff.TargetBinding{
			Namespace: targetProfile.ProfileID, Unit: targetProfile.ManagerUnit,
			UnitPath:     filepath.Join(unitHome, targetProfile.ManagerUnit),
			StableBinary: targetProfile.ManagerInstallPath(binHome),
			ConfigPath:   targetProfile.DefaultConfigPath(configHome), ConfigSHA256: strings.Repeat("9", 64), DataRoot: targetRoot,
			SocketPath:     filepath.Join(root, "runtime", filepath.FromSlash(targetProfile.RuntimeSocketPath)),
			ComposeProject: targetProfile.ComposeProject, CoreNetwork: targetProfile.CoreNetwork,
			LabelPrefix: targetProfile.LabelPrefix,
		},
		Evidence: handoff.Evidence{
			ManagerStateSHA256: strings.Repeat("3", 64), SelfUpdateStateSHA256: strings.Repeat("4", 64),
			SandboxRegistrySHA256: strings.Repeat("5", 64), DockerInventorySHA256: strings.Repeat("6", 64),
			DatabaseSchemaVersion: manifest.DatabaseSchemaVersion, DatabaseIntegrity: "ok",
			RuntimeIdentitySHA256: strings.Repeat("7", 64), WorkspaceIdentitySHA256: strings.Repeat("8", 64),
			BootID: "12345678-1234-1234-1234-123456789abc",
		},
		Runtime: RuntimeObservation{
			Profile: sourceProfile, Generation: testPredecessor, ManagerSHA256: testSourceSHA,
			Architecture: "amd64", Idle: true,
		},
	}
	host := &fakeHost{
		failures: make(map[string]int), crashes: make(map[string]int), plan: plan, store: store,
		runtime: RuntimeObservation{
			Profile: sourceProfile, Generation: testPredecessor, ManagerSHA256: testSourceSHA,
			Architecture: "amd64", Idle: true,
		},
	}
	clock := &steppingClock{now: time.Date(2026, 7, 31, 11, 0, 0, 0, time.UTC)}
	coordinator, err := New(Options{
		Store: store, Host: host, Listeners: &fakeListeners{host: host},
		SourceProfile: identity.SourceActiveProfile(), TargetProfile: targetProfile,
		Channel: "main", GOOS: "linux", GOARCH: "amd64", Clock: clock.Next,
	})
	if err != nil {
		t.Fatal(err)
	}
	return ownerFixture{store: store, coordinator: coordinator, host: host, request: request, clock: clock}
}

func TestBeginRejectsOrdinaryManifestBeforeInspection(t *testing.T) {
	fixture := newOwnerFixture(t)
	request := fixture.request
	request.Manifest.NamespaceHandoff = nil
	if _, err := fixture.coordinator.Begin(context.Background(), request); !errors.Is(err, ErrOrdinaryManifest) {
		t.Fatalf("ordinary manifest error = %v", err)
	}
	if got := fixture.host.filteredEvents(); len(got) != 0 {
		t.Fatalf("ordinary manifest caused host calls: %v", got)
	}
	if _, found, err := fixture.store.DiscoverNonTerminal(); err != nil || found {
		t.Fatalf("ordinary manifest created a journal: found=%v err=%v", found, err)
	}
}

func TestBeginPersistsBeforeArmAndReplaysSameTransaction(t *testing.T) {
	fixture := newOwnerFixture(t)
	first, err := fixture.coordinator.Begin(context.Background(), fixture.request)
	if err != nil {
		t.Fatal(err)
	}
	fixture.host.mu.Lock()
	armSawJournal := fixture.host.armSawJournal
	fixture.host.mu.Unlock()
	if !armSawJournal {
		t.Fatal("persistent helper was armed before its durable journal existed")
	}
	second, err := fixture.coordinator.Begin(context.Background(), fixture.request)
	if err != nil {
		t.Fatal(err)
	}
	if second.TransactionID != first.TransactionID || second.Revision != first.Revision {
		t.Fatalf("replay created a different transaction: first=%+v second=%+v", first, second)
	}
	if fixture.host.count("preflight") != 1 || fixture.host.count("arm") != 2 {
		t.Fatalf("unexpected replay calls: %v", fixture.host.filteredEvents())
	}
}

func TestSuccessfulHandoffUsesOrderedDurablePhases(t *testing.T) {
	fixture := newOwnerFixture(t)
	planned, err := fixture.coordinator.Begin(context.Background(), fixture.request)
	if err != nil {
		t.Fatal(err)
	}
	final, err := fixture.coordinator.Resume(context.Background(), planned.TransactionID)
	if err != nil {
		t.Fatal(err)
	}
	if final.Status != handoff.StatusCommitted || final.Phase != handoff.PhaseCommitted ||
		final.Helper == nil || final.Snapshot == nil || final.TargetAck == nil || final.TargetPlatformCommit == nil {
		t.Fatalf("incomplete committed journal: %+v", final)
	}
	fixture.host.mu.Lock()
	leaseHeld := fixture.host.helperLeaseHeld
	fixture.host.mu.Unlock()
	if !leaseHeld {
		t.Fatal("source fencing ran without the durable helper lease")
	}
	wantHistory := []handoff.Phase{
		handoff.PhasePlanned, handoff.PhaseHelperArmed, handoff.PhaseAdmissionReserved,
		handoff.PhaseWritersStopped, handoff.PhaseSnapshotReady, handoff.PhaseSourceFenced,
		handoff.PhaseTargetStaged, handoff.PhaseDataRelocated, handoff.PhaseTargetStarted,
		handoff.PhaseTargetVerified, handoff.PhaseSourceRetired, handoff.PhaseTargetCommitPlanned, handoff.PhaseCommitted,
	}
	gotHistory := make([]handoff.Phase, 0, len(final.History))
	for _, event := range final.History {
		gotHistory = append(gotHistory, event.Phase)
	}
	if !reflect.DeepEqual(gotHistory, wantHistory) {
		t.Fatalf("history = %v, want %v", gotHistory, wantHistory)
	}
	wantCalls := []string{
		"preflight", "arm", "reserve", "drain", "snapshot", "acquire_listeners", "fence",
		"stage", "transform", "start_target", "probe", "target_ack", "probe", "retire",
		"verify_commit", "commit_target", "start_target", "commit_target", "commit_platform", "finalize",
	}
	if got := fixture.host.filteredEvents(); !reflect.DeepEqual(got, wantCalls) {
		t.Fatalf("host calls = %v, want %v", got, wantCalls)
	}
}

func TestForwardFailureMatrixAbortsOrRollsBackDeterministically(t *testing.T) {
	cases := []struct {
		step string
		want handoff.Status
	}{
		{"reserve", handoff.StatusAborted}, {"drain", handoff.StatusAborted},
		{"snapshot", handoff.StatusAborted}, {"acquire_listeners", handoff.StatusAborted},
		{"fence", handoff.StatusAborted}, {"stage", handoff.StatusRolledBack},
		{"transform", handoff.StatusRolledBack}, {"start_target", handoff.StatusRolledBack},
		{"probe", handoff.StatusRolledBack}, {"target_ack", handoff.StatusRolledBack},
		{"retire", handoff.StatusRolledBack}, {"verify_commit", handoff.StatusRolledBack},
		{"commit_target", handoff.StatusRolledBack},
	}
	for _, test := range cases {
		t.Run(test.step, func(t *testing.T) {
			fixture := newOwnerFixture(t)
			fixture.host.failures[test.step] = 1
			planned, err := fixture.coordinator.Begin(context.Background(), fixture.request)
			if err != nil {
				t.Fatal(err)
			}
			final, err := fixture.coordinator.Resume(context.Background(), planned.TransactionID)
			if err != nil {
				t.Fatalf("safely settled terminal handoff returned a helper failure: %v", err)
			}
			if final.Status != test.want || !final.Terminal() {
				t.Fatalf("status = %s phase=%s, want %s", final.Status, final.Phase, test.want)
			}
			if test.want == handoff.StatusAborted {
				if final.AbortCleanup == nil || !final.AbortCleanup.Complete() || sourceFenceRecorded(final) {
					t.Fatalf("unsafe abort evidence: %+v", final)
				}
				if fixture.host.count("restore_source_before_fence") != 1 || fixture.host.count("start_source") != 0 {
					t.Fatalf("pre-fence abort used rollback startup capability: %v", fixture.host.filteredEvents())
				}
			} else if !historyHasPhase(final, handoff.PhaseRollbackPlanned) || !historyHasPhase(final, handoff.PhaseSourceStarted) {
				t.Fatalf("rollback phases absent: %v", final.History)
			}
		})
	}
}

func TestRollbackFailureRemainsRecoveringAndResumesFromCheckpoint(t *testing.T) {
	fixture := newOwnerFixture(t)
	fixture.host.failures["stage"] = 1
	fixture.host.failures["restore_data"] = 1
	planned, err := fixture.coordinator.Begin(context.Background(), fixture.request)
	if err != nil {
		t.Fatal(err)
	}
	intermediate, err := fixture.coordinator.Resume(context.Background(), planned.TransactionID)
	if err == nil || intermediate.Status != handoff.StatusRecovering || intermediate.Phase != handoff.PhaseTargetStopped {
		t.Fatalf("rollback failure = status %s phase %s err %v", intermediate.Status, intermediate.Phase, err)
	}
	final, err := fixture.coordinator.Resume(context.Background(), planned.TransactionID)
	if err != nil || final.Status != handoff.StatusRolledBack {
		t.Fatalf("recovered rollback = status %s err %v", final.Status, err)
	}
	if fixture.host.count("stage") != 1 || fixture.host.count("stop_target") != 1 || fixture.host.count("restore_data") != 2 {
		t.Fatalf("rollback replay repeated completed effects: %v", fixture.host.filteredEvents())
	}
}

func TestTargetCommitResponseFailureStaysForwardOnlyAndRetriesSameReceiptBoundary(t *testing.T) {
	fixture := newOwnerFixture(t)
	fixture.host.failures["commit_platform"] = 1
	planned, err := fixture.coordinator.Begin(context.Background(), fixture.request)
	if err != nil {
		t.Fatal(err)
	}
	intermediate, err := fixture.coordinator.Resume(context.Background(), planned.TransactionID)
	if err == nil || intermediate.Status != handoff.StatusRunning || intermediate.Phase != handoff.PhaseTargetCommitPlanned ||
		intermediate.DesiredOutcome != handoff.OutcomeForward || historyHasPhase(intermediate, handoff.PhaseRollbackPlanned) {
		t.Fatalf("uncertain target commit crossed rollback boundary: status=%s phase=%s outcome=%s err=%v", intermediate.Status, intermediate.Phase, intermediate.DesiredOutcome, err)
	}
	final, err := fixture.coordinator.Resume(context.Background(), planned.TransactionID)
	if err != nil || final.Status != handoff.StatusCommitted || final.TargetPlatformCommit == nil {
		t.Fatalf("target commit retry did not settle: status=%s phase=%s err=%v", final.Status, final.Phase, err)
	}
	if fixture.host.count("commit_platform") != 2 || fixture.host.count("start_target") != 3 {
		t.Fatalf("forward-only retry calls = %v", fixture.host.filteredEvents())
	}
}

func TestCrashAfterListenerAckBeforePhaseWriteProvesTargetAndMovesForward(t *testing.T) {
	fixture := newOwnerFixture(t)
	listeners := &replayListeners{host: fixture.host}
	fixture.coordinator.listeners = listeners
	fixture.host.crashes["commit_target"] = 1
	planned, err := fixture.coordinator.Begin(context.Background(), fixture.request)
	if err != nil {
		t.Fatal(err)
	}
	crashed := false
	func() {
		defer func() { crashed = recover() != nil }()
		_, _ = fixture.coordinator.Resume(context.Background(), planned.TransactionID)
	}()
	if !crashed || listeners.currentOwner() != ListenerOwnerTarget {
		t.Fatalf("listener acknowledgement crash was not retained: crashed=%v owner=%q", crashed, listeners.currentOwner())
	}
	checkpoint, err := fixture.store.Load(planned.TransactionID)
	if err != nil || checkpoint.Phase != handoff.PhaseSourceRetired {
		t.Fatalf("listener acknowledgement unexpectedly advanced journal: phase=%s err=%v", checkpoint.Phase, err)
	}
	before := len(fixture.host.filteredEvents())
	final, err := fixture.coordinator.Resume(context.Background(), planned.TransactionID)
	if err != nil || final.Status != handoff.StatusCommitted {
		t.Fatalf("target-owner replay did not commit: status=%s phase=%s err=%v", final.Status, final.Phase, err)
	}
	replayed := fixture.host.filteredEvents()[before:]
	wantPrefix := []string{"ensure_target", "verify_commit", "commit_target", "ensure_target", "start_target", "commit_target", "commit_platform"}
	if len(replayed) < len(wantPrefix) || !reflect.DeepEqual(replayed[:len(wantPrefix)], wantPrefix) {
		t.Fatalf("target-owner replay order = %v, want prefix %v", replayed, wantPrefix)
	}
}

func TestTargetCommitPlannedRebootRestoresListenerBeforePlatformCommit(t *testing.T) {
	fixture := newOwnerFixture(t)
	listeners := &replayListeners{host: fixture.host}
	fixture.coordinator.listeners = listeners
	fixture.host.failures["commit_platform"] = 1
	planned, err := fixture.coordinator.Begin(context.Background(), fixture.request)
	if err != nil {
		t.Fatal(err)
	}
	intermediate, err := fixture.coordinator.Resume(context.Background(), planned.TransactionID)
	if err == nil || intermediate.Phase != handoff.PhaseTargetCommitPlanned || listeners.currentOwner() != ListenerOwnerTarget {
		t.Fatalf("target commit checkpoint = phase %s owner %q err %v", intermediate.Phase, listeners.currentOwner(), err)
	}
	// A host reboot drops both target and helper process descriptors. The new
	// helper must rebind maintenance and transfer it to the restarted target
	// before issuing another Platform commit request.
	listeners.dropProcessDescriptors()
	before := len(fixture.host.filteredEvents())
	final, err := fixture.coordinator.Resume(context.Background(), planned.TransactionID)
	if err != nil || final.Status != handoff.StatusCommitted {
		t.Fatalf("target commit reboot replay did not commit: status=%s phase=%s err=%v", final.Status, final.Phase, err)
	}
	replayed := fixture.host.filteredEvents()[before:]
	wantPrefix := []string{"ensure_helper", "start_target", "commit_target", "commit_platform"}
	if len(replayed) < len(wantPrefix) || !reflect.DeepEqual(replayed[:len(wantPrefix)], wantPrefix) {
		t.Fatalf("target commit reboot order = %v, want prefix %v", replayed, wantPrefix)
	}
}

func TestRollbackProvesTargetBeforeStopThenRebindsMaintenance(t *testing.T) {
	fixture := newOwnerFixture(t)
	listeners := &replayListeners{host: fixture.host}
	fixture.coordinator.listeners = listeners
	fixture.host.failures["stage"] = 1
	fixture.host.failures["stop_target"] = 1
	planned, err := fixture.coordinator.Begin(context.Background(), fixture.request)
	if err != nil {
		t.Fatal(err)
	}
	intermediate, err := fixture.coordinator.Resume(context.Background(), planned.TransactionID)
	if err == nil || intermediate.Status != handoff.StatusRecovering || intermediate.Phase != handoff.PhaseRollbackPlanned {
		t.Fatalf("rollback checkpoint = status %s phase %s err %v", intermediate.Status, intermediate.Phase, err)
	}
	// Model a transfer-ack/phase-write crash: restricted target is the current
	// authenticated owner even though rollback intent is already durable.
	listeners.setOwner(ListenerOwnerTarget)
	fixture.host.afterStopTarget = listeners.dropProcessDescriptors
	before := len(fixture.host.filteredEvents())
	final, err := fixture.coordinator.Resume(context.Background(), planned.TransactionID)
	if err != nil || final.Status != handoff.StatusRolledBack {
		t.Fatalf("rollback listener replay did not settle: status=%s phase=%s err=%v", final.Status, final.Phase, err)
	}
	replayed := fixture.host.filteredEvents()[before:]
	wantPrefix := []string{"ensure_target", "stop_target", "ensure_helper", "ensure_helper", "restore_data"}
	if len(replayed) < len(wantPrefix) || !reflect.DeepEqual(replayed[:len(wantPrefix)], wantPrefix) {
		t.Fatalf("rollback listener replay order = %v, want prefix %v", replayed, wantPrefix)
	}
}

func TestCrashAfterEffectReplaysCurrentCheckpoint(t *testing.T) {
	steps := []string{
		"reserve", "drain", "snapshot", "acquire_listeners", "fence", "stage", "transform",
		"start_target", "probe", "target_ack", "retire", "verify_commit", "commit_target",
	}
	for _, step := range steps {
		t.Run(step, func(t *testing.T) {
			fixture := newOwnerFixture(t)
			fixture.host.crashes[step] = 1
			planned, err := fixture.coordinator.Begin(context.Background(), fixture.request)
			if err != nil {
				t.Fatal(err)
			}
			func() {
				defer func() {
					if recovered := recover(); recovered == nil {
						t.Fatalf("%s did not inject a crash", step)
					}
				}()
				_, _ = fixture.coordinator.Resume(context.Background(), planned.TransactionID)
			}()
			final, err := fixture.coordinator.Resume(context.Background(), planned.TransactionID)
			if err != nil || final.Status != handoff.StatusCommitted {
				t.Fatalf("crash replay did not commit: status=%s phase=%s err=%v", final.Status, final.Phase, err)
			}
			if fixture.host.count(step) < 2 {
				t.Fatalf("crashed effect %s was not reconciled: %v", step, fixture.host.filteredEvents())
			}
		})
	}
}

func TestStartupRecoveryRearmsWithoutTakingMigrationOwnership(t *testing.T) {
	fixture := newOwnerFixture(t)
	planned, err := fixture.coordinator.Begin(context.Background(), fixture.request)
	if err != nil {
		t.Fatal(err)
	}
	disposition, err := fixture.coordinator.RecoverStartup(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !disposition.Active || disposition.TransactionID != planned.TransactionID ||
		!disposition.BlockOrdinaryOperations || !disposition.PersistentHelperRequired ||
		!disposition.SourceParticipantRequired || disposition.TargetParticipantRequired || disposition.MaintenanceRequired {
		t.Fatalf("unexpected startup disposition: %+v", disposition)
	}
	if fixture.host.count("arm") != 2 || fixture.host.count("reserve") != 0 {
		t.Fatalf("startup recovery executed migration work: %v", fixture.host.filteredEvents())
	}
}

func TestStartupRecoveryKeepsForwardOnlyCommitCheckpointInMaintenance(t *testing.T) {
	fixture := newOwnerFixture(t)
	fixture.host.failures["commit_platform"] = 1
	planned, err := fixture.coordinator.Begin(context.Background(), fixture.request)
	if err != nil {
		t.Fatal(err)
	}
	checkpoint, err := fixture.coordinator.Resume(context.Background(), planned.TransactionID)
	if err == nil || checkpoint.Status != handoff.StatusRunning ||
		checkpoint.DesiredOutcome != handoff.OutcomeForward || checkpoint.Phase != handoff.PhaseTargetCommitPlanned {
		t.Fatalf("forward-only checkpoint = status %s outcome %s phase %s err %v", checkpoint.Status, checkpoint.DesiredOutcome, checkpoint.Phase, err)
	}
	disposition, err := fixture.coordinator.RecoverStartup(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !disposition.Active || disposition.TransactionID != planned.TransactionID ||
		disposition.Status != handoff.StatusRunning || disposition.DesiredOutcome != handoff.OutcomeForward ||
		disposition.Phase != handoff.PhaseTargetCommitPlanned || !disposition.BlockOrdinaryOperations ||
		!disposition.MaintenanceRequired || !disposition.PersistentHelperRequired ||
		disposition.SourceParticipantRequired || !disposition.TargetParticipantRequired {
		t.Fatalf("unexpected forward-only startup disposition: %+v", disposition)
	}
}

func TestReceiptObservationsRequireAuthoritativeIdleState(t *testing.T) {
	fixture := newOwnerFixture(t)
	globalBusy := false
	fixture.host.mu.Lock()
	fixture.host.observationHook = func() {
		_, _, lockErr := fixture.store.DiscoverNonTerminal()
		globalBusy = errors.Is(lockErr, handoff.ErrBusy)
	}
	fixture.host.mu.Unlock()
	source, err := fixture.coordinator.ObserveSourceOwner(context.Background(), testPredecessor, testSourceSHA)
	if err != nil {
		t.Fatal(err)
	}
	if !globalBusy {
		t.Fatal("source receipt observation did not hold the global handoff lease")
	}
	fixture.host.mu.Lock()
	fixture.host.observationHook = nil
	fixture.host.mu.Unlock()
	if source.Capability != "source_owner" || source.Status != "idle" || !sha256Pattern.MatchString(source.EvidenceSHA256) {
		t.Fatalf("source observation = %+v", source)
	}
	repeated, err := fixture.coordinator.ObserveSourceOwner(context.Background(), testPredecessor, testSourceSHA)
	if err != nil || repeated.EvidenceSHA256 != source.EvidenceSHA256 {
		t.Fatalf("source evidence is not deterministic: first=%+v next=%+v err=%v", source, repeated, err)
	}

	planned, err := fixture.coordinator.Begin(context.Background(), fixture.request)
	if err != nil {
		t.Fatal(err)
	}
	final, err := fixture.coordinator.Resume(context.Background(), planned.TransactionID)
	if err != nil {
		t.Fatal(err)
	}
	fixture.host.mu.Lock()
	fixture.host.runtime = RuntimeObservation{
		Profile: identity.TargetProfile(), Generation: testBridge, ManagerSHA256: testTargetSHA,
		Architecture: "amd64", Idle: true,
		AuthenticatedChannelCheck: final.TargetAck.AutoUpdateCheckAt,
	}
	fixture.host.mu.Unlock()
	if _, err := fixture.coordinator.ObserveTargetCommitted(context.Background(), testBridge, testTargetSHA); err == nil {
		t.Fatal("pre-commit target channel check produced a committed receipt observation")
	}
	fixture.host.mu.Lock()
	fixture.host.runtime.AuthenticatedChannelCheck = final.CompletedAt.Add(time.Second)
	fixture.host.mu.Unlock()
	target, err := fixture.coordinator.ObserveTargetCommitted(context.Background(), testBridge, testTargetSHA)
	if err != nil {
		t.Fatal(err)
	}
	if target.Capability != "target_owner" || target.Status != "committed" || target.ProfileID != identity.TargetProfile().ProfileID {
		t.Fatalf("target observation = %+v", target)
	}
	materialWithCommit := struct {
		SchemaVersion  int                          `json:"schema_version"`
		Capability     string                       `json:"capability"`
		Status         string                       `json:"status"`
		TransactionID  string                       `json:"transaction_id"`
		Revision       uint64                       `json:"revision"`
		BindingSHA256  string                       `json:"binding_sha256"`
		CompletedAt    any                          `json:"completed_at"`
		TargetAck      handoff.TargetAck            `json:"target_ack"`
		PlatformCommit handoff.TargetPlatformCommit `json:"target_platform_commit"`
		Runtime        RuntimeObservation           `json:"runtime"`
	}{1, "target_owner", "committed", final.TransactionID, final.Revision, final.BindingSHA256,
		final.CompletedAt, *final.TargetAck, *final.TargetPlatformCommit, fixture.host.runtime}
	wantEvidence, err := digestJSON(materialWithCommit)
	if err != nil || target.EvidenceSHA256 != wantEvidence {
		t.Fatalf("target receipt evidence omitted Platform commit: got=%s want=%s err=%v", target.EvidenceSHA256, wantEvidence, err)
	}
	fixture.host.mu.Lock()
	fixture.host.runtime.Maintenance = true
	fixture.host.mu.Unlock()
	if _, err := fixture.coordinator.ObserveTargetCommitted(context.Background(), testBridge, testTargetSHA); err == nil {
		t.Fatal("maintenance target produced a committed receipt observation")
	}
}
