//go:build linux

package handoffsource

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
	containerdriver "github.com/Noyv3x/enterprise-agent-platform/manager/internal/driver"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handofffd"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffhost"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffowner"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

const (
	testSourceGeneration = "1111111111111111111111111111111111111111"
	testBridgeGeneration = "2222222222222222222222222222222222222222"
	testBootID           = "12345678-1234-1234-1234-123456789abc"
)

type testAdmission struct {
	mu           sync.Mutex
	held         bool
	acquisitions int
	closes       int
	observation  handoffowner.RuntimeObservation
}

func (admission *testAdmission) Acquire(context.Context) (handoffowner.RuntimeObservationLease, error) {
	admission.mu.Lock()
	defer admission.mu.Unlock()
	if admission.held {
		return nil, errors.New("admission already held")
	}
	admission.held = true
	admission.acquisitions++
	return &testRuntimeLease{owner: admission}, nil
}

func (admission *testAdmission) isHeld() bool {
	admission.mu.Lock()
	defer admission.mu.Unlock()
	return admission.held
}

type testRuntimeLease struct{ owner *testAdmission }

type testTargetConfigRenderer struct{}

func (testTargetConfigRenderer) RenderTargetConfig(sourcePath string, sourceRaw []byte, targetConfigPath, targetDataRoot, targetSocketPath string) ([]byte, error) {
	if sourcePath == "" || string(sourceRaw) != "source-config\n" || targetConfigPath == "" || targetDataRoot == "" || targetSocketPath == "" {
		return nil, errors.New("unexpected target config render binding")
	}
	return []byte("target-config\n"), nil
}

func (lease *testRuntimeLease) Observe(context.Context) (handoffowner.RuntimeObservation, error) {
	lease.owner.mu.Lock()
	defer lease.owner.mu.Unlock()
	if !lease.owner.held {
		return handoffowner.RuntimeObservation{}, errors.New("admission is not held")
	}
	return lease.owner.observation, nil
}

func (lease *testRuntimeLease) Close() error {
	lease.owner.mu.Lock()
	defer lease.owner.mu.Unlock()
	if !lease.owner.held {
		return errors.New("admission already closed")
	}
	lease.owner.held = false
	lease.owner.closes++
	return nil
}

type testUnits struct {
	admission *testAdmission
	states    map[string]UnitState
	active    []string
}

func (units testUnits) Show(_ context.Context, name string) (UnitState, error) {
	if !units.admission.isHeld() {
		return UnitState{}, errors.New("systemd inspected before admission")
	}
	state, ok := units.states[name]
	if !ok {
		return UnitState{}, errors.New("unknown test unit")
	}
	return state, nil
}

func (units testUnits) ActiveUnits(context.Context, []string) ([]string, error) {
	if !units.admission.isHeld() {
		return nil, errors.New("watchdogs inspected before admission")
	}
	return append([]string(nil), units.active...), nil
}

type testEvidence struct {
	admission *testAdmission
	result    DeploymentEvidence
	calls     int
}

func (collector *testEvidence) Collect(_ context.Context, request EvidenceRequest) (DeploymentEvidence, error) {
	if !collector.admission.isHeld() {
		return DeploymentEvidence{}, errors.New("evidence collected before admission")
	}
	if request.Runtime.Generation != testSourceGeneration || request.ManagerStateSHA256 == "" ||
		request.SelfUpdateSHA256 == "" || request.SandboxRegistrySHA256 == "" {
		return DeploymentEvidence{}, errors.New("evidence request is incomplete")
	}
	collector.calls++
	return collector.result, nil
}

type testArtifacts struct {
	store *handoff.Store
	data  []byte
	calls int
}

type testImages struct {
	calls             int
	verifyCalls       int
	name              string
	image             string
	err               error
	failName          string
	contextErr        error
	deadlineRemaining time.Duration
}

type sourceRecoveryDockerRunner struct {
	networkID string
	calls     [][]string
}

func (runner *sourceRecoveryDockerRunner) Run(_ context.Context, _ string, args []string, _ []string) (containerdriver.Result, error) {
	runner.calls = append(runner.calls, append([]string(nil), args...))
	if len(args) == 5 && args[0] == "image" && args[1] == "inspect" && args[3] == "{{json .RepoDigests}}" {
		return containerdriver.Result{Stdout: "[\"" + args[4] + "\"]\n"}, nil
	}
	if len(args) >= 2 && args[0] == "network" && args[1] == "inspect" {
		return containerdriver.Result{Stdout: runner.networkID + "\tbridge\tcore\n"}, nil
	}
	if len(args) > 0 && args[0] == "compose" {
		return containerdriver.Result{}, nil
	}
	return containerdriver.Result{}, errors.New("unexpected Docker command: " + strings.Join(args, " "))
}

func (images *testImages) VerifyManagedImagePresent(ctx context.Context, name, image string) error {
	images.verifyCalls++
	images.name, images.image = name, image
	images.contextErr = ctx.Err()
	if deadline, ok := ctx.Deadline(); ok {
		images.deadlineRemaining = time.Until(deadline)
	}
	if images.err != nil && (images.failName == "" || images.failName == name) {
		return images.err
	}
	return nil
}

func (images *testImages) PrepareManagedImage(ctx context.Context, name, image string) error {
	images.calls++
	images.name, images.image = name, image
	images.contextErr = ctx.Err()
	if deadline, ok := ctx.Deadline(); ok {
		images.deadlineRemaining = time.Until(deadline)
	}
	if images.err != nil && (images.failName == "" || images.failName == name) {
		return images.err
	}
	return nil
}

func (fetcher *testArtifacts) FetchArtifact(_ context.Context, artifact release.Artifact, _ int64) ([]byte, error) {
	fetcher.calls++
	if _, found, err := fetcher.store.DiscoverNonTerminal(); err != nil || !found {
		return nil, errors.New("artifact fetched before planned journal was durable")
	}
	if digestBytes(fetcher.data) != artifact.SHA256 {
		return nil, errors.New("test artifact does not match release")
	}
	return append([]byte(nil), fetcher.data...), nil
}

type testHelperHost struct {
	proof handoffhost.HelperProof
	arms  int
}

func (host *testHelperHost) Resolve(request handoffhost.ArmRequest) (handoffhost.HelperSpec, error) {
	suffix := strings.TrimPrefix(request.TransactionID, "handoff_")[:12]
	unit := identity.TargetProfile().DataDirectory + "-namespace-handoff-" + suffix + ".service"
	executable := filepath.Join(request.TransactionDirectory, "helper", identity.TargetProfile().ManagerBinary)
	socket := filepath.Join("/tmp", "test-handoff-"+suffix+".sock")
	return handoffhost.HelperSpec{
		TransactionID: request.TransactionID, TargetProfileID: request.TargetProfile.ProfileID,
		TransactionDirectory: request.TransactionDirectory, UnitName: unit,
		UnitPath: filepath.Join(request.UnitDirectory, unit), UnitSHA256: strings.Repeat("8", 64),
		ExecutablePath: executable, ExecutableSHA256: request.ArtifactSHA256,
		JournalPath: request.JournalPath, ListenerSocketPath: socket,
		Argv: []string{executable, handoffhost.HelperSubcommand, "--transaction", request.TransactionID,
			"--journal", request.JournalPath, "--listener-socket", socket},
	}, nil
}

func (host *testHelperHost) Arm(_ context.Context, request handoffhost.ArmRequest) (handoffhost.ArmResult, error) {
	host.arms++
	spec, err := host.Resolve(request)
	if err != nil {
		return handoffhost.ArmResult{}, err
	}
	if artifact, err := inspectRegular(request.ArtifactPath, defaultMaxManagerArtifactBytes, true); err != nil || artifact.sha256 != request.ArtifactSHA256 {
		return handoffhost.ArmResult{}, errors.New("helper arm did not receive a verified staged artifact")
	}
	host.proof = handoffhost.HelperProof{
		TransactionID: spec.TransactionID, UnitName: spec.UnitName, UnitPath: spec.UnitPath,
		UnitSHA256: spec.UnitSHA256, ExecutablePath: spec.ExecutablePath,
		ExecutableSHA256: spec.ExecutableSHA256, Argv: append([]string(nil), spec.Argv...),
		Enabled: true, Active: true, MainPID: 4242, ControlGroup: "/user.slice/test-handoff.service", BootID: testBootID,
	}
	return handoffhost.ArmResult{Spec: spec, Proof: host.proof}, nil
}

func (host *testHelperHost) Inspect(_ context.Context, spec handoffhost.HelperSpec) (handoffhost.HelperProof, error) {
	if host.proof.TransactionID != spec.TransactionID {
		return handoffhost.HelperProof{}, errors.New("helper was not armed")
	}
	return host.proof, nil
}

func (*testHelperHost) Remove(context.Context, handoffhost.RemovalRequest) (handoffhost.RemovalResult, error) {
	return handoffhost.RemovalResult{}, errors.New("not used by source driver")
}
func (*testHelperHost) OpenListenerReceiver(string, string) (handoffhost.ListenerAcceptor, error) {
	return nil, errors.New("not used by source driver")
}
func (*testHelperHost) SendListeners(context.Context, string, string, []handoffhost.NamedListener) error {
	return errors.New("not used by source driver")
}

type testListeners struct{}

func (testListeners) EnsureMaintenance(context.Context, handoff.Journal, handoff.StartupLease, handoffowner.ListenerState) (handoffowner.ListenerState, error) {
	return handoffowner.ListenerState{}, errors.New("not used during Begin")
}
func (testListeners) CommitToTarget(context.Context, handoff.Journal, handoff.StartupLease, []handofffd.NamedListener) error {
	return errors.New("not used during Begin")
}
func (testListeners) RestoreToSource(context.Context, handoff.Journal, handoff.StartupLease, []handofffd.NamedListener) error {
	return errors.New("not used during Begin")
}

type sourceFixture struct {
	t               *testing.T
	root            string
	store           *handoff.Store
	driver          *Driver
	coordinator     *handoffowner.Coordinator
	request         handoffowner.BridgeRequest
	admission       *testAdmission
	evidence        *testEvidence
	artifacts       *testArtifacts
	images          *testImages
	helper          *testHelperHost
	targetConfigDir string
	socket          net.Listener
}

func newSourceFixture(t *testing.T) *sourceFixture {
	t.Helper()
	root, err := os.MkdirTemp("/tmp", "h")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	mustMkdir(t, filepath.Join(root, "s"), 0o700)
	mustMkdir(t, filepath.Join(root, "d"), 0o700)
	mustMkdir(t, filepath.Join(root, "config"), 0o700)
	mustMkdir(t, filepath.Join(root, "custom"), 0o700)
	mustMkdir(t, filepath.Join(root, "b"), 0o700)
	mustMkdir(t, filepath.Join(root, "r"), 0o700)
	mustMkdir(t, filepath.Join(root, "u"), 0o700)

	sourceProfile := identity.SourceProfile()
	targetProfile := identity.TargetProfile()
	sourceData := filepath.Join(root, "d", sourceProfile.DataDirectory)
	targetData := filepath.Join(root, "d", targetProfile.DataDirectory)
	mustMkdir(t, filepath.Join(sourceData, "manager", "control"), 0o700)
	sourceStable := filepath.Join(root, "b", sourceProfile.ManagerBinary)
	targetStable := filepath.Join(root, "b", targetProfile.ManagerBinary)
	// P1 allows an arbitrary source config destination.  The target config is
	// instead derived from the independently verified user-systemd FragmentPath.
	targetConfigDir := filepath.Join(root, "config", targetProfile.ConfigDirectory)
	sourceConfig := filepath.Join(root, "custom", "installed-manager.toml")
	unitDir := filepath.Join(root, "config", "systemd", "user")
	mustMkdir(t, unitDir, 0o700)
	sourceUnit := filepath.Join(unitDir, sourceProfile.ManagerUnit)
	managerState := filepath.Join(sourceData, "manager", "state.json")
	selfUpdate := filepath.Join(sourceData, "manager", "manager-binaries.json")
	sandboxRegistry := filepath.Join(sourceData, "manager", "sandboxes.json")
	bootID := filepath.Join(root, "boot-id")

	sourceBinary := []byte("source-manager-binary")
	targetBinary := []byte("target-manager-binary")
	sourceCompose := []byte("services:\n  platform:\n    image: source\n")
	targetCompose := []byte("services:\n  platform:\n    image: target\n")
	mustWrite(t, sourceStable, sourceBinary, 0o700)
	mustWrite(t, sourceConfig, []byte("source-config\n"), 0o600)
	mustWrite(t, sourceUnit, []byte("[Service]\nExecStart="+sourceStable+"\n"), 0o600)
	mustWrite(t, managerState, []byte(`{"schema_version":1}`), 0o600)
	mustWrite(t, selfUpdate, []byte(`{"schema_version":1}`), 0o600)
	mustWrite(t, sandboxRegistry, []byte(`{"schema_version":2}`), 0o600)
	mustWrite(t, bootID, []byte(testBootID+"\n"), 0o600)
	sourceComposePath := filepath.Join(sourceProfile.ManagerStateRoot(sourceData), "releases", testSourceGeneration, "compose.yaml")
	mustMkdir(t, filepath.Dir(sourceComposePath), 0o700)
	mustWrite(t, sourceComposePath, sourceCompose, 0o600)

	sourceSocket := filepath.Join(sourceData, filepath.FromSlash(sourceProfile.DataRootSocketPath))
	listener, err := net.Listen("unix", sourceSocket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	targetSocket, err := targetProfile.ControlSocketPath(targetData, filepath.Join(root, "r"))
	if err != nil {
		t.Fatal(err)
	}
	store, err := handoff.Open(filepath.Join(root, "s", "agent-platform", "handoff"), sourceData, targetData)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })

	sourceSHA := shaHex(sourceBinary)
	targetSHA := shaHex(targetBinary)
	manifest := testBridgeManifest(sourceSHA, targetSHA, shaHex(sourceCompose))
	manifest.Compose.SHA256 = shaHex(targetCompose)
	manifest.NamespaceHandoff.Target.Compose = manifest.Compose
	sourceManifest := manifest
	sourceManifest.SourceCommit = testSourceGeneration
	sourceManifest.Manager = manifest.NamespaceHandoff.Source.Manager
	sourceManifest.Compose = manifest.NamespaceHandoff.Source.Compose
	sourceManifest.NamespaceHandoff = nil
	sourceManifestData, err := json.Marshal(sourceManifest)
	if err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(filepath.Dir(sourceComposePath), "manifest.json"), sourceManifestData, 0o600)
	manifestData, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(sourceProfile.ManagerStateRoot(sourceData), "releases", testBridgeGeneration, "manifest.json")
	mustMkdir(t, filepath.Dir(manifestPath), 0o700)
	mustWrite(t, manifestPath, manifestData, 0o600)
	mustWrite(t, filepath.Join(filepath.Dir(manifestPath), "compose.yaml"), targetCompose, 0o600)
	request := handoffowner.BridgeRequest{Manifest: manifest, ManifestPath: manifestPath, ManifestSHA256: shaHex(manifestData)}
	admission := &testAdmission{observation: handoffowner.RuntimeObservation{
		Profile: sourceProfile, Generation: testSourceGeneration, ManagerSHA256: sourceSHA,
		Architecture: runtime.GOARCH, Idle: true,
	}}
	evidence := &testEvidence{admission: admission, result: completeEvidence(manifest.DatabaseSchemaVersion)}
	artifacts := &testArtifacts{store: store, data: targetBinary}
	images := &testImages{}
	helper := &testHelperHost{}
	driver, err := New(Options{
		Store: store, Admission: admission, Evidence: evidence, HelperHost: helper, Artifacts: artifacts, Images: images,
		TargetConfig: testTargetConfigRenderer{},
		Units: testUnits{admission: admission, states: map[string]UnitState{
			sourceProfile.ManagerUnit: {LoadState: "loaded", ActiveState: "active", UnitFileState: "enabled", FragmentPath: sourceUnit, MainPID: 1234},
			targetProfile.ManagerUnit: {LoadState: "not-found", ActiveState: "inactive"},
		}},
		SourceProfile: identity.SourceActiveProfile(), TargetProfile: targetProfile,
		Channel: contract.ReleaseChannel, GOOS: "linux", GOARCH: runtime.GOARCH,
		SourceStableBinary: sourceStable, SourceConfigPath: sourceConfig, SourceDataRoot: sourceData,
		SourceSocketPath: sourceSocket, SourceManagerStatePath: managerState, SourceSelfUpdatePath: selfUpdate,
		SourceSandboxRegistryPath: sandboxRegistry, TargetStableBinary: targetStable,
		TargetDataRoot:    targetData,
		TargetRuntimeRoot: filepath.Join(root, "r"), TargetSocketPath: targetSocket,
		BootIDPath: bootID,
	})
	if err != nil {
		t.Fatal(err)
	}
	coordinator, err := handoffowner.New(handoffowner.Options{
		Store: store, Host: driver, Listeners: testListeners{}, SourceProfile: identity.SourceActiveProfile(),
		TargetProfile: targetProfile, Channel: contract.ReleaseChannel, GOOS: "linux", GOARCH: runtime.GOARCH,
	})
	if err != nil {
		t.Fatal(err)
	}
	return &sourceFixture{t: t, root: root, store: store, driver: driver, coordinator: coordinator,
		request: request, admission: admission, evidence: evidence, artifacts: artifacts, images: images, helper: helper,
		targetConfigDir: targetConfigDir, socket: listener}
}

func TestSourceDriverBeginPersistsBeforeArtifactAndRearmsIdempotently(t *testing.T) {
	fixture := newSourceFixture(t)
	journal, err := fixture.coordinator.Begin(context.Background(), fixture.request)
	if err != nil {
		t.Fatal(err)
	}
	if journal.Phase != handoff.PhasePlanned || fixture.artifacts.calls != 1 || fixture.images.calls != len(fixture.request.Manifest.Images) || fixture.helper.arms != 1 ||
		fixture.admission.acquisitions != 1 || fixture.admission.closes != 1 || fixture.admission.isHeld() {
		t.Fatalf("unexpected begin result: journal=%+v fetch=%d arm=%d admission=%d/%d", journal, fixture.artifacts.calls,
			fixture.helper.arms, fixture.admission.acquisitions, fixture.admission.closes)
	}
	if journal.Target.ConfigSHA256 != shaHex([]byte("target-config\n")) {
		t.Fatalf("target config digest = %q", journal.Target.ConfigSHA256)
	}
	if journal.Source.ConfigPath != fixture.driver.sourceConfigPath || filepath.Base(journal.Source.ConfigPath) != "installed-manager.toml" ||
		journal.Target.ConfigPath != filepath.Join(fixture.targetConfigDir, identity.TargetProfile().ConfigFile) {
		t.Fatalf("config bindings were not derived from independent authorities: source=%q target=%q", journal.Source.ConfigPath, journal.Target.ConfigPath)
	}
	artifactPath := fixture.driver.managerArtifactPath(journal.TransactionID)
	artifact, err := inspectRegular(artifactPath, defaultMaxManagerArtifactBytes, true)
	if err != nil || artifact.mode != 0o700 || artifact.sha256 != journal.Release.TargetManagerSHA256 {
		t.Fatalf("staged helper artifact not exact: %+v %v", artifact, err)
	}
	recovered, err := fixture.coordinator.RecoverStartup(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !recovered.Active || recovered.TransactionID != journal.TransactionID || fixture.artifacts.calls != 1 || fixture.helper.arms != 2 {
		t.Fatalf("re-arm was not idempotent: %+v fetch=%d arm=%d", recovered, fixture.artifacts.calls, fixture.helper.arms)
	}
	proof, err := fixture.driver.VerifyPersistentHelper(context.Background(), journal)
	if err != nil || proof.UnitSHA256 == "" || proof.ArgvSHA256 == "" || proof.SHA256 != journal.Release.TargetManagerSHA256 {
		t.Fatalf("helper proof mismatch: %+v %v", proof, err)
	}
}

func TestSourceDriverRejectsFragmentOutsideUserSystemdLayout(t *testing.T) {
	fixture := newSourceFixture(t)
	units := fixture.driver.units.(testUnits)
	source := units.states[identity.SourceProfile().ManagerUnit]
	source.FragmentPath = filepath.Join(fixture.root, "untrusted", identity.SourceProfile().ManagerUnit)
	units.states[identity.SourceProfile().ManagerUnit] = source
	fixture.driver.units = units
	if _, err := fixture.coordinator.Begin(context.Background(), fixture.request); err == nil || !strings.Contains(err.Error(), "user-systemd") {
		t.Fatalf("untrusted FragmentPath was accepted: %v", err)
	}
	if fixture.artifacts.calls != 0 || fixture.evidence.calls != 0 || fixture.helper.arms != 0 {
		t.Fatalf("FragmentPath rejection happened after side effects: fetch=%d evidence=%d arm=%d", fixture.artifacts.calls, fixture.evidence.calls, fixture.helper.arms)
	}
}

func TestRecoveryBundleSurvivesReleaseRemovalAndRestoresCanonicalSource(t *testing.T) {
	fixture := newSourceFixture(t)
	journal, err := fixture.coordinator.Begin(context.Background(), fixture.request)
	if err != nil {
		t.Fatal(err)
	}
	transactionDirectory := filepath.Join(fixture.store.Root(), journal.TransactionID)
	paths, err := handoff.DeriveRecoveryBundlePaths(transactionDirectory, journal.TransactionID)
	if err != nil {
		t.Fatal(err)
	}
	// Model a process exit after creating a fixed-name staging file. The
	// originals are then retired, so successful re-arm must consume only the
	// durable external bundle and clean the known residual safely.
	mustWrite(t, filepath.Join(paths.SourceDirectory, ".manifest.json.staging"), []byte("interrupted"), 0o600)
	if err := os.RemoveAll(filepath.Dir(journal.Source.ManifestPath)); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Dir(journal.Release.ManifestPath)); err != nil {
		t.Fatal(err)
	}
	if err := fixture.driver.ArmPersistentHelper(context.Background(), journal); err != nil {
		t.Fatalf("re-arm from external recovery bundle: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(paths.SourceDirectory, ".manifest.json.staging")); !os.IsNotExist(err) {
		t.Fatalf("recovery staging residue survived re-arm: %v", err)
	}

	releaseDirectory := filepath.Dir(journal.Source.ManifestPath)
	mustMkdir(t, releaseDirectory, 0o700)
	mustWrite(t, filepath.Join(releaseDirectory, ".manifest.json.staging"), []byte("interrupted"), 0o600)
	mustWrite(t, filepath.Join(releaseDirectory, ".compose.yaml.staging"), []byte("interrupted"), 0o600)
	restorer, err := NewCanonicalSourceReleaseRestorer(transactionDirectory, contract.ReleaseChannel, "linux", runtime.GOARCH)
	if err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		if err := restorer.RestoreCanonicalSourceRelease(context.Background(), journal); err != nil {
			t.Fatalf("restore canonical source release attempt %d: %v", attempt+1, err)
		}
	}
	for path, expected := range map[string]string{
		journal.Source.ManifestPath: journal.Source.ManifestSHA256,
		journal.Source.ComposePath:  journal.Source.ComposeSHA256,
	} {
		identity, err := inspectRegular(path, recoveryComposeLimit, true)
		if err != nil || identity.sha256 != expected || identity.mode != recoveryFileMode {
			t.Fatalf("restored canonical artifact %s = %+v, %v", path, identity, err)
		}
	}
	for _, name := range []string{".manifest.json.staging", ".compose.yaml.staging"} {
		if _, err := os.Lstat(filepath.Join(releaseDirectory, name)); !os.IsNotExist(err) {
			t.Fatalf("canonical staging residue %s survived restore: %v", name, err)
		}
	}

	runner := &sourceRecoveryDockerRunner{networkID: journal.Source.CoreNetworkID}
	sourceManifestRaw, err := os.ReadFile(paths.SourceManifest)
	if err != nil {
		t.Fatal(err)
	}
	sourceManifest, err := release.DecodeManifest(sourceManifestRaw, contract.ReleaseChannel, "linux", runtime.GOARCH)
	if err != nil {
		t.Fatal(err)
	}
	docker := containerdriver.DockerCLI{
		Profile: identity.SourceActiveProfile(), Runner: runner, Binary: "docker",
		ComposeFile: paths.SourceCompose, ComposeSHA256: journal.Source.ComposeSHA256,
		ManifestFile: paths.SourceManifest, ManifestSHA256: journal.Source.ManifestSHA256,
		ManifestChannel: contract.ReleaseChannel, RequireLocalImages: true,
		ComposeProject: journal.Source.ComposeProject,
		GenerationDir:  filepath.Dir(releaseDirectory), DataRoot: journal.Source.DataRoot,
		StateDir: identity.SourceProfile().ManagerStateRoot(journal.Source.DataRoot), CoreNetwork: journal.Source.CoreNetwork,
		ExpectedCoreNetworkID: journal.Source.CoreNetworkID, UID: os.Getuid(), GID: os.Getgid(),
	}
	if err := docker.StartFixed(context.Background(), sourceManifest); err != nil {
		t.Fatalf("start source from restored canonical release: %v", err)
	}
	joined := make([]string, 0, len(runner.calls))
	for _, call := range runner.calls {
		joined = append(joined, strings.Join(call, " "))
	}
	commands := strings.Join(joined, "\n")
	if !strings.Contains(commands, "image inspect --format {{json .RepoDigests}} "+sourceManifest.Images["platform"]) ||
		!strings.Contains(commands, "image inspect --format {{json .RepoDigests}} "+sourceManifest.Images["agent-runtime"]) ||
		!strings.Contains(commands, "network inspect") ||
		!strings.Contains(commands, " up --pull never --detach --wait platform agent-runtime") ||
		strings.Contains(commands, " pull ") {
		t.Fatalf("source recovery command sequence is incomplete or network-dependent:\n%s", commands)
	}
}

func TestRecoveryStagingIdentityReplacementIsNotDeleted(t *testing.T) {
	directory := t.TempDir()
	name := ".manifest.json.staging"
	path := filepath.Join(directory, name)
	mustWrite(t, path, []byte("original"), 0o600)
	fd, err := syscall.Open(directory, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.Close(fd)
	original, err := lstatAt(fd, name)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path, filepath.Join(directory, "retained-original")); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, path, []byte("replacement"), 0o600)
	if err := unlinkIfIdentity(fd, name, original); err == nil || !strings.Contains(err.Error(), "replaced temporary") {
		t.Fatalf("replaced staging file was not rejected: %v", err)
	}
	content, err := os.ReadFile(path)
	if err != nil || string(content) != "replacement" {
		t.Fatalf("replacement staging file was removed or changed: %q, %v", content, err)
	}
}

func TestRecoveryBundleRejectsChangedOriginalBeforeFirstStage(t *testing.T) {
	fixture := newSourceFixture(t)
	journal, err := fixture.coordinator.Begin(context.Background(), fixture.request)
	if err != nil {
		t.Fatal(err)
	}
	paths, err := handoff.DeriveRecoveryBundlePaths(filepath.Join(fixture.store.Root(), journal.TransactionID), journal.TransactionID)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(paths.Root); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(journal.Source.ComposePath, []byte("services: {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := fixture.driver.ArmPersistentHelper(context.Background(), journal); err == nil || !strings.Contains(err.Error(), "original source Compose differs") {
		t.Fatalf("changed original was accepted before recovery staging: %v", err)
	}
	if _, err := os.Lstat(paths.SourceManifest); !os.IsNotExist(err) {
		t.Fatalf("failed first stage published recovery bytes: %v", err)
	}
}

func TestSourceDriverImagePreparationFailureLeavesPlannedSourceOwnedHandoff(t *testing.T) {
	fixture := newSourceFixture(t)
	fixture.images.failName = "agent-runtime"
	fixture.images.err = errors.New("registry unavailable")
	journal, err := fixture.coordinator.Begin(context.Background(), fixture.request)
	if err == nil || !strings.Contains(err.Error(), "agent-runtime") {
		t.Fatalf("image preparation failure = journal=%+v err=%v", journal, err)
	}
	loaded, loadErr := fixture.store.Load(journal.TransactionID)
	if loadErr != nil {
		t.Fatal(loadErr)
	}
	if loaded.Phase != handoff.PhasePlanned || loaded.Status != handoff.StatusRunning || loaded.Helper != nil ||
		fixture.helper.arms != 0 || fixture.artifacts.calls != 0 || fixture.admission.isHeld() {
		t.Fatalf("image failure crossed helper ownership boundary: journal=%+v arms=%d fetches=%d", loaded, fixture.helper.arms, fixture.artifacts.calls)
	}
}

func TestPersistentArmPreparationDoesNotInheritExpiredControlDeadline(t *testing.T) {
	fixture := newSourceFixture(t)
	journal, err := fixture.coordinator.Begin(context.Background(), fixture.request)
	if err != nil {
		t.Fatal(err)
	}
	before := fixture.images.calls
	expired, cancel := context.WithCancel(context.Background())
	cancel()
	if err := fixture.driver.ArmPersistentHelper(expired, journal); err != nil {
		t.Fatalf("persistent arm inherited request cancellation: %v", err)
	}
	if fixture.images.calls-before != len(fixture.request.Manifest.Images) || fixture.images.contextErr != nil ||
		fixture.images.deadlineRemaining < 5*time.Hour {
		t.Fatalf("persistent arm context calls=%d err=%v remaining=%s", fixture.images.calls-before, fixture.images.contextErr, fixture.images.deadlineRemaining)
	}
}

func TestSourceDriverPreflightFailureHasNoHandoffSideEffects(t *testing.T) {
	fixture := newSourceFixture(t)
	mustMkdir(t, fixture.targetConfigDir, 0o700)
	_, err := fixture.coordinator.Begin(context.Background(), fixture.request)
	if err == nil || !strings.Contains(err.Error(), "target config directory") {
		t.Fatalf("expected target absence failure, got %v", err)
	}
	if _, found, discoverErr := fixture.store.DiscoverNonTerminal(); discoverErr != nil || found {
		t.Fatalf("preflight failure persisted a handoff: found=%v err=%v", found, discoverErr)
	}
	if fixture.artifacts.calls != 0 || fixture.helper.arms != 0 || fixture.evidence.calls != 0 || fixture.admission.isHeld() ||
		fixture.admission.acquisitions != 1 || fixture.admission.closes != 1 {
		t.Fatalf("preflight failure had side effects: fetch=%d arm=%d evidence=%d admission=%d/%d held=%v",
			fixture.artifacts.calls, fixture.helper.arms, fixture.evidence.calls,
			fixture.admission.acquisitions, fixture.admission.closes, fixture.admission.isHeld())
	}
}

func TestSourceDriverRejectsSymlinkedSourceIdentity(t *testing.T) {
	fixture := newSourceFixture(t)
	real := fixture.driver.sourceConfigPath + ".real"
	if err := os.Rename(fixture.driver.sourceConfigPath, real); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, fixture.driver.sourceConfigPath); err != nil {
		t.Fatal(err)
	}
	_, err := fixture.coordinator.Begin(context.Background(), fixture.request)
	if err == nil || !strings.Contains(err.Error(), "source Manager config") {
		t.Fatalf("expected symlink rejection, got %v", err)
	}
	if _, found, discoverErr := fixture.store.DiscoverNonTerminal(); discoverErr != nil || found {
		t.Fatalf("symlink failure persisted a handoff: found=%v err=%v", found, discoverErr)
	}
}

func TestInspectRegularNeverReturnsMixedIdentityDuringReplacement(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "state.json")
	left := []byte(strings.Repeat("a", 1<<20))
	right := []byte(strings.Repeat("b", 1<<20))
	mustWrite(t, path, left, 0o600)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for index := 0; index < 40; index++ {
			value := left
			if index%2 != 0 {
				value = right
			}
			temporary := filepath.Join(directory, "replacement")
			_ = os.WriteFile(temporary, value, 0o600)
			_ = os.Rename(temporary, path)
		}
	}()
	for index := 0; index < 40; index++ {
		identity, err := inspectRegular(path, 2<<20, true)
		if err == nil && identity.sha256 != shaHex(left) && identity.sha256 != shaHex(right) {
			t.Fatalf("inspection returned a mixed identity: %s", identity.sha256)
		}
	}
	<-done
}

func TestSourceDriverHelperOnlyMethodsFailClosed(t *testing.T) {
	fixture := newSourceFixture(t)
	if err := fixture.driver.StageTarget(context.Background(), handoff.Journal{}); !errors.Is(err, ErrHelperOnly) {
		t.Fatalf("helper-only mutation did not fail closed: %v", err)
	}
	if _, err := fixture.driver.CreateSnapshot(context.Background(), handoff.Journal{}); !errors.Is(err, ErrHelperOnly) {
		t.Fatalf("helper-only snapshot did not fail closed: %v", err)
	}
}

func TestSystemdParsersAreClosedWorld(t *testing.T) {
	valid := []byte("LoadState=loaded\nActiveState=active\nUnitFileState=enabled\nFragmentPath=/tmp/a.service\nMainPID=1\n")
	properties, err := parseProperties(valid, []string{"LoadState", "ActiveState", "UnitFileState", "FragmentPath", "MainPID"})
	if err != nil || properties["MainPID"] != "1" {
		t.Fatalf("valid properties rejected: %v %+v", err, properties)
	}
	for _, invalid := range [][]byte{
		[]byte("LoadState=loaded\nLoadState=loaded\n"),
		[]byte("LoadState=loaded\nUnknown=x\n"),
	} {
		if _, err := parseProperties(invalid, []string{"LoadState"}); err == nil {
			t.Fatalf("invalid properties accepted: %q", invalid)
		}
	}
}

func completeEvidence(schema int) DeploymentEvidence {
	return DeploymentEvidence{
		SourceComposeOwned: true, SourceCoreNetworkOwned: true, TargetComposeAbsent: true,
		TargetCoreNetworkAbsent: true, TargetLabelObjectsAbsent: true, AllOperationsTerminal: true,
		PlatformReservationIdle: true, SandboxCallsIdle: true, BackgroundProcessesIdle: true,
		FileCommitWindowsIdle: true, MachineSchemasReady: true, RelocationBoundarySafe: true,
		SelfUpdateCurrentStable: true, SelfUpdateGeneration: testSourceGeneration,
		SelfUpdateManagerSHA256: shaHex([]byte("source-manager-binary")),
		SourceCoreNetworkID:     strings.Repeat("a", 64), DockerInventorySHA256: strings.Repeat("b", 64),
		DatabaseSchemaVersion: schema, DatabaseIntegrity: "ok", RuntimeIdentitySHA256: strings.Repeat("c", 64),
		WorkspaceIdentitySHA256: strings.Repeat("d", 64),
	}
}

func testBridgeManifest(sourceSHA, targetSHA, sourceComposeSHA string) release.Manifest {
	artifact := func(name, digest string) release.Artifact {
		return release.Artifact{URL: "https://example.invalid/" + name, SHA256: digest}
	}
	manager := func(version, name, digest string) release.ManagerRelease {
		return release.ManagerRelease{Version: version, Artifacts: map[string]release.Artifact{
			"amd64": artifact(name+"-amd64", digest), "arm64": artifact(name+"-arm64", digest),
		}}
	}
	images := map[string]string{}
	for _, name := range []string{"platform", "agent-runtime", "camofox", "agent-sandbox", "searxng", "firecrawl-api", "firecrawl-playwright", "firecrawl-postgres", "firecrawl-redis", "firecrawl-rabbitmq", "handoff-fs-helper"} {
		images[name] = "example.invalid/" + name + "@sha256:" + strings.Repeat("e", 64)
	}
	targetManager := manager(testBridgeGeneration, "target", targetSHA)
	targetCompose := artifact("target-compose", strings.Repeat("f", 64))
	return release.Manifest{
		SchemaVersion: contract.SchemaVersion, Channel: contract.ReleaseChannel, SourceCommit: testBridgeGeneration,
		GeneratedAt: time.Unix(100, 0).UTC(), ProtocolVersion: contract.SchemaVersion, DatabaseSchemaVersion: 7,
		Manager: targetManager, Compose: targetCompose, Images: images,
		NamespaceHandoff: &release.NamespaceHandoff{
			SchemaVersion: 1, PredecessorGeneration: testSourceGeneration, BridgeGeneration: testBridgeGeneration,
			Source: release.NamespaceBinding{ProfileID: identity.SourceProfile().ProfileID,
				Manager: manager(testSourceGeneration, "source", sourceSHA), Compose: artifact("source-compose", sourceComposeSHA)},
			Target: release.NamespaceBinding{ProfileID: identity.TargetProfile().ProfileID, Manager: targetManager, Compose: targetCompose},
		},
	}
}

func mustMkdir(t *testing.T, path string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(path, mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

func mustWrite(t *testing.T, path string, data []byte, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, data, mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

func shaHex(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}
