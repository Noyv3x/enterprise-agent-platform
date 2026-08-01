//go:build linux

// Package handoffsource implements the source-Manager half of the technical
// namespace handoff.  It is intentionally incapable of performing any of the
// helper-owned destructive phases.
package handoffsource

import (
	"context"
	"errors"
	"runtime"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffhost"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffowner"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

const (
	defaultMaxManagerArtifactBytes int64 = 128 << 20
	defaultPersistentArmTimeout          = 6 * time.Hour
	minimumPersistentArmTimeout          = time.Minute
	maximumPersistentArmTimeout          = 24 * time.Hour
)

var ErrHelperOnly = errors.New("namespace handoff mutation is owned only by the persistent helper")

// Admission acquires the ordinary-operation/runtime boundary. Preflight is
// invoked by Store.CreatePlanned while its global handoff lock is already
// retained, giving the deployment one fixed lock order.
type Admission interface {
	Acquire(context.Context) (handoffowner.RuntimeObservationLease, error)
}

// ArtifactFetcher downloads an immutable release artifact and verifies the
// release-declared checksum before returning bytes.
type ArtifactFetcher interface {
	FetchArtifact(context.Context, release.Artifact, int64) ([]byte, error)
}

// ManagedImagePreparer is the source-owner-only capability which guarantees
// the privileged handoff worker is present by exact RepoDigest before the
// persistent helper can become the journal owner. The helper itself always
// executes the worker with --pull=never.
type ManagedImagePreparer interface {
	PrepareManagedImage(context.Context, string, string) error
	VerifyManagedImagePresent(context.Context, string, string) error
}

// UnitState is a closed projection of systemd identity needed by preflight.
type UnitState struct {
	LoadState     string
	ActiveState   string
	UnitFileState string
	FragmentPath  string
	MainPID       int
}

// UnitInspector provides read-only systemd facts. SystemdCLI is the production
// implementation; tests can inject an in-memory implementation without
// weakening the production checks.
type UnitInspector interface {
	Show(context.Context, string) (UnitState, error)
	ActiveUnits(context.Context, []string) ([]string, error)
}

// EvidenceRequest gives the collector only already-bound identities and
// retained file digests. A collector must observe rather than mutate them.
type EvidenceRequest struct {
	Bridge                handoffowner.BridgeRequest
	SourceProfile         identity.Profile
	TargetProfile         identity.Profile
	Runtime               handoffowner.RuntimeObservation
	ManagerStateSHA256    string
	SelfUpdateSHA256      string
	SandboxRegistrySHA256 string
	SourceManifestPath    string
	SourceManifestSHA256  string
	SourceImages          map[string]string
	SourceDataRoot        string
	TargetDataRoot        string
}

// DeploymentEvidence is the closed-world result for facts that require the
// Platform, Docker, SQLite, Runtime, or workspace-domain readers. Every guard
// must be true; adding a future prerequisite therefore requires an explicit
// source-owner code change instead of silently accepting an unknown fact.
type DeploymentEvidence struct {
	SourceComposeOwned       bool
	SourceCoreNetworkOwned   bool
	TargetComposeAbsent      bool
	TargetCoreNetworkAbsent  bool
	TargetLabelObjectsAbsent bool
	AllOperationsTerminal    bool
	PlatformReservationIdle  bool
	SandboxCallsIdle         bool
	BackgroundProcessesIdle  bool
	FileCommitWindowsIdle    bool
	MachineSchemasReady      bool
	RelocationBoundarySafe   bool
	SelfUpdateCurrentStable  bool
	SelfUpdateGeneration     string
	SelfUpdateManagerSHA256  string
	SourceCoreNetworkID      string
	DockerInventorySHA256    string
	DatabaseSchemaVersion    int
	DatabaseIntegrity        string
	RuntimeIdentitySHA256    string
	WorkspaceIdentitySHA256  string
}

type EvidenceCollector interface {
	Collect(context.Context, EvidenceRequest) (DeploymentEvidence, error)
}

// TargetConfigRenderer parses the exact source configuration bytes retained
// by Preflight and deterministically renders the target technical config.
// Keeping config parsing outside this package avoids ambient profile/default
// discovery in the source-owner host boundary.
type TargetConfigRenderer interface {
	RenderTargetConfig(sourcePath string, sourceRaw []byte, targetConfigPath, targetDataRoot, targetSocketPath string) ([]byte, error)
}

// Options contains only canonical, pre-resolved paths. New performs no host
// inspection; in particular it cannot race with the mandated admission-first
// ordering in Preflight.
type Options struct {
	Store        *handoff.Store
	Admission    Admission
	Evidence     EvidenceCollector
	HelperHost   handoffhost.OwnerHost
	Artifacts    ArtifactFetcher
	Images       ManagedImagePreparer
	Units        UnitInspector
	TargetConfig TargetConfigRenderer

	SourceProfile identity.ActiveProfile
	TargetProfile identity.Profile
	Channel       string
	GOOS          string
	GOARCH        string

	SourceStableBinary        string
	SourceConfigPath          string
	SourceDataRoot            string
	SourceSocketPath          string
	SourceManagerStatePath    string
	SourceSelfUpdatePath      string
	SourceSandboxRegistryPath string

	TargetStableBinary string
	TargetDataRoot     string
	TargetRuntimeRoot  string
	TargetSocketPath   string

	BootIDPath              string
	MaxManagerArtifactBytes int64
	PersistentArmTimeout    time.Duration
}

type Driver struct {
	store        *handoff.Store
	admission    Admission
	evidence     EvidenceCollector
	helperHost   handoffhost.OwnerHost
	artifacts    ArtifactFetcher
	images       ManagedImagePreparer
	units        UnitInspector
	targetConfig TargetConfigRenderer
	source       identity.Profile
	target       identity.Profile
	channel      string
	goos         string
	goarch       string

	sourceStableBinary        string
	sourceConfigPath          string
	sourceDataRoot            string
	sourceSocketPath          string
	sourceManagerStatePath    string
	sourceSelfUpdatePath      string
	sourceSandboxRegistryPath string
	targetStableBinary        string
	targetDataRoot            string
	targetRuntimeRoot         string
	targetSocketPath          string
	bootIDPath                string
	maxManagerArtifactBytes   int64
	persistentArmTimeout      time.Duration
}

func normalizedPlatform(options Options) (string, string) {
	goos := options.GOOS
	if goos == "" {
		goos = runtime.GOOS
	}
	goarch := options.GOARCH
	if goarch == "" {
		goarch = runtime.GOARCH
	}
	return goos, goarch
}

var _ handoffowner.HostDriver = (*Driver)(nil)
