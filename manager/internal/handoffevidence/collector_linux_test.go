//go:build linux

package handoffevidence

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffowner"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffsource"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/journal"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/runtimegate"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/selfupdate"
)

type collectorPlatform struct{ value PlatformEvidence }

func (platform collectorPlatform) Evidence(context.Context) (PlatformEvidence, error) {
	return platform.value, nil
}

type collectorDocker struct{ value DockerEvidence }

func (docker collectorDocker) Observe(context.Context, DockerRequest) (DockerEvidence, error) {
	return docker.value, nil
}

func TestCollectorCrossChecksRetainedManagerPlatformAndRegistryEvidence(t *testing.T) {
	collector, runtimeGate, request, registryPath := newCollectorFixture(t)
	unfreeze, err := runtimeGate.Freeze(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer unfreeze()
	value, err := collector.Collect(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if !value.SourceComposeOwned || !value.AllOperationsTerminal || !value.PlatformReservationIdle ||
		!value.MachineSchemasReady || !value.RelocationBoundarySafe || !value.SelfUpdateCurrentStable {
		t.Fatalf("collector returned incomplete evidence: %+v", value)
	}

	request.SourceImages["platform"] = "example.invalid/platform@sha256:" + strings.Repeat("9", 64)
	if _, err := collector.Collect(context.Background(), request); err == nil || !strings.Contains(err.Error(), "Current manifest identity differs") {
		t.Fatalf("source manifest image substitution was accepted: %v", err)
	}
	request.SourceImages = evidenceImages()

	if err := atomicfile.WriteJSON(registryPath, map[string]any{
		"schema_version": 2, "technical_profile": identity.SourceProfile().ProfileID,
		"records": map[string]any{"unexpected": map[string]any{}},
	}, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := collector.Collect(context.Background(), request); err == nil {
		t.Fatal("retained Sandbox registry mutation was accepted")
	}
}

func newCollectorFixture(t *testing.T) (*Collector, *runtimegate.Gate, handoffsource.EvidenceRequest, string) {
	t.Helper()
	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	sourceRoot := filepath.Join(root, identity.SourceProfile().DataDirectory)
	if err := os.Mkdir(sourceRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(sourceRoot, "data"), 0o700); err != nil {
		t.Fatal(err)
	}
	stateRoot := identity.SourceProfile().ManagerStateRoot(sourceRoot)
	store, err := journal.Open(stateRoot, time.Unix(1, 0))
	if err != nil {
		t.Fatal(err)
	}
	generation := strings.Repeat("a", 40)
	managerSHA := strings.Repeat("b", 64)
	manifestPath := filepath.Join(stateRoot, "releases", generation, "manifest.json")
	if _, err := store.MutateState(time.Unix(2, 0), func(state *model.ManagerState) error {
		state.Current = &model.Generation{
			ID: generation, SourceCommit: generation, ManifestPath: manifestPath, DatabaseVersion: 7, Images: evidenceImages(),
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	selfPath := filepath.Join(stateRoot, "manager-binaries.json")
	if err := atomicfile.WriteJSON(selfPath, selfupdate.State{SchemaVersion: 1, Current: &selfupdate.Version{
		Version: generation, SourceCommit: generation, Path: filepath.Join(root, "manager"),
		SHA256: managerSHA, VerifiedAt: time.Unix(2, 0).UTC(), PlatformCommitted: true,
	}, UpdatedAt: time.Unix(2, 0).UTC()}, 0o600); err != nil {
		t.Fatal(err)
	}
	selfRoot := filepath.Join(stateRoot, "manager-binaries")
	if err := os.Mkdir(selfRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	registryPath := filepath.Join(stateRoot, "sandboxes.json")
	if err := atomicfile.WriteJSON(registryPath, map[string]any{
		"schema_version": 2, "technical_profile": identity.SourceProfile().ProfileID,
		"records": map[string]any{},
	}, 0o600); err != nil {
		t.Fatal(err)
	}
	managerData, err := os.ReadFile(filepath.Join(stateRoot, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	selfData, err := os.ReadFile(selfPath)
	if err != nil {
		t.Fatal(err)
	}
	registryData, err := os.ReadFile(registryPath)
	if err != nil {
		t.Fatal(err)
	}
	runtimeGate := runtimegate.New()
	collector, err := NewCollector(CollectorOptions{
		Journal: store, SelfUpdate: &selfupdate.Manager{Root: selfRoot, StatePath: selfPath},
		Runtime: runtimeGate, Sandboxes: admissionSandboxes{}, Background: func() int { return 0 },
		Platform: collectorPlatform{value: PlatformEvidence{
			SchemaVersion: 1, TechnicalProfile: identity.SourceProfile().ProfileID,
			DatabaseSchemaVersion: 7, DatabaseIntegrity: "ok", DatabaseForeignKeys: "ok",
			PlatformReservationIdle: true, RuntimeSchemaReady: true, WorkspaceSchemaReady: true,
			CamofoxSchemaReady: true, RuntimeIdentitySHA256: strings.Repeat("c", 64),
			WorkspaceIdentitySHA256: strings.Repeat("d", 64),
		}},
		Docker: collectorDocker{value: DockerEvidence{
			SourceComposeOwned: true, SourceCoreNetworkOwned: true, TargetComposeAbsent: true,
			TargetCoreNetworkAbsent: true, TargetLabelObjectsAbsent: true,
			SourceCoreNetworkID: strings.Repeat("e", 64), InventorySHA256: strings.Repeat("f", 64),
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	request := handoffsource.EvidenceRequest{
		Bridge:        handoffowner.BridgeRequest{Manifest: release.Manifest{DatabaseSchemaVersion: 7}},
		SourceProfile: identity.SourceProfile(), TargetProfile: identity.TargetProfile(),
		Runtime: handoffowner.RuntimeObservation{
			Profile: identity.SourceProfile(), Generation: generation, ManagerSHA256: managerSHA,
		},
		ManagerStateSHA256: digestBytes(managerData), SelfUpdateSHA256: digestBytes(selfData),
		SandboxRegistrySHA256: digestBytes(registryData), SourceManifestPath: manifestPath,
		SourceManifestSHA256: strings.Repeat("1", 64), SourceImages: evidenceImages(), SourceDataRoot: sourceRoot,
		TargetDataRoot: filepath.Join(root, identity.TargetProfile().DataDirectory),
	}
	return collector, runtimeGate, request, registryPath
}
