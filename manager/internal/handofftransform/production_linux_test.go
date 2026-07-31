//go:build linux

package handofftransform

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	pathpkg "path"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffhelper"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/sandbox"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/selfupdate"
	"golang.org/x/sys/unix"
)

const productionDatabaseVersion = 2026072402

type productionFence struct {
	err          error
	calls        int
	invalidProof bool
}

type productionPrivilegedFS struct{ removes int }

func (*productionPrivilegedFS) inventory(ctx context.Context, request PrivilegedTreeRequest) (PrivilegedTreeResult, error) {
	entries, err := inventoryResource(ctx, request.ResourceName, request.SourcePath, Directory, request.SourceOwners)
	return PrivilegedTreeResult{Entries: entries}, err
}

func (*productionPrivilegedFS) copy(ctx context.Context, request PrivilegedTreeRequest) (PrivilegedTreeResult, error) {
	target := filepath.Join(request.TargetRoot, filepath.FromSlash(request.TargetRelative))
	engine := Engine{UID: os.Getuid(), GID: os.Getgid()}
	resource := Resource{Name: request.ResourceName, Kind: ByteExactTree, Access: NativeAccess, Type: Directory}
	if err := engine.copyTree(ctx, request.SourcePath, target, resource, request.ExpectedSource); err != nil {
		return PrivilegedTreeResult{}, err
	}
	targetEntries, err := inventoryResource(ctx, request.ResourceName, target, Directory, request.TargetOwners)
	return PrivilegedTreeResult{SourceEntries: cloneEntries(request.ExpectedSource), TargetEntries: targetEntries}, err
}

func (filesystem *productionPrivilegedFS) remove(_ context.Context, request PrivilegedTreeRequest) (PrivilegedTreeResult, error) {
	filesystem.removes++
	path := filepath.Join(request.TargetRoot, filepath.FromSlash(request.TargetRelative))
	if err := removeOwnedResource(path, request.ExpectedTarget, os.Getuid()); err != nil {
		return PrivilegedTreeResult{}, err
	}
	return PrivilegedTreeResult{Removed: true}, nil
}

func (fence *productionFence) VerifyTargetWritersStopped(_ context.Context, operation handoffhelper.Operation) (TargetFenceProof, error) {
	fence.calls++
	if fence.err != nil {
		return TargetFenceProof{}, fence.err
	}
	if fence.invalidProof {
		return TargetFenceProof{}, nil
	}
	return NewTargetFenceProof(operation)
}

func TestProductionBoundaryStagesPublishesReplaysAndRestores(t *testing.T) {
	fixture := newProductionFixture(t)
	if err := fixture.boundary.StageTarget(context.Background(), fixture.operation); err != nil {
		t.Fatal(err)
	}
	stage := productionStagingPath(fixture.operation.Target.DataRoot, fixture.operation.TransactionID)
	if _, err := os.Lstat(stage); err != nil {
		t.Fatalf("production staging was not created: %v", err)
	}
	if _, err := os.Lstat(fixture.operation.Target.DataRoot); !os.IsNotExist(err) {
		t.Fatalf("StageTarget published the target: %v", err)
	}

	if err := fixture.boundary.TransformAndPublish(context.Background(), fixture.operation); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(stage); !os.IsNotExist(err) {
		t.Fatalf("staging survived atomic publication: %v", err)
	}
	if err := fixture.boundary.TransformAndPublish(context.Background(), fixture.operation); err != nil {
		t.Fatalf("rename-crash replay did not verify the published target: %v", err)
	}

	var state model.ManagerState
	if err := readStrictOwnerJSON(filepath.Join(fixture.operation.Target.DataRoot, "manager", "state.json"), os.Getuid(), &state); err != nil {
		t.Fatal(err)
	}
	if state.Current == nil || state.Current.ID != fixture.operation.Release.BridgeGeneration || state.Previous != nil || state.Candidate != nil || state.Maintenance {
		t.Fatalf("target Manager state is not a fresh bridge Current: %#v", state)
	}
	assertFreshTargetManagerArtifacts(t, fixture)
	if _, err := os.Lstat(filepath.Join(fixture.operation.Target.DataRoot, "manager", "control")); !os.IsNotExist(err) {
		t.Fatalf("unused data-root Manager control directory was generated: %v", err)
	}
	environmentPath := filepath.Join(fixture.operation.Target.DataRoot, "manager", "releases", fixture.operation.Release.BridgeGeneration, "compose.env")
	environment, err := os.ReadFile(environmentPath)
	if err != nil {
		t.Fatal(err)
	}
	wantControl := "AGENT_PLATFORM_MANAGER_CONTROL_DIR=" + filepath.Dir(fixture.operation.Target.SocketPath) + "\n"
	if !strings.Contains(string(environment), wantControl) {
		t.Fatalf("target Compose control mount does not match participant socket: env=%q want=%q", environment, wantControl)
	}
	assertTargetDatabaseBaseline(t, filepath.Join(fixture.operation.Target.DataRoot, "data", "platform.db"))
	markerPath := filepath.Join(fixture.operation.Target.DataRoot, "data", "workspaces", "user-1", TargetWorkspaceMarkerName)
	markerRaw, err := os.ReadFile(markerPath)
	if err != nil || !strings.Contains(string(markerRaw), `"technical_profile":"agent-platform-v1"`) {
		t.Fatalf("target workspace marker was not structurally transformed: %q %v", markerRaw, err)
	}
	sourceNamespace := filepath.Join(fixture.operation.Target.DataRoot, "data", "workspaces", "user-1", contract.P1WorkspaceSourceDirectory)
	if _, err := os.Lstat(sourceNamespace); !os.IsNotExist(err) {
		t.Fatalf("source workspace namespace survived target transform: %v", err)
	}
	targetNamespace := filepath.Join(fixture.operation.Target.DataRoot, "data", "workspaces", "user-1", contract.P1WorkspaceTargetDirectory)
	if raw, err := os.ReadFile(filepath.Join(targetNamespace, "plans", "retained.md")); err != nil || string(raw) != "agent-owned plan data\n" {
		t.Fatalf("Agent data under the workspace namespace was not retained: %q %v", raw, err)
	}
	if entries, err := os.ReadDir(filepath.Join(targetNamespace, contract.P1WorkspaceRootOwnedMountPath)); err != nil || len(entries) != 0 {
		t.Fatalf("target attachment placeholder was not mapped as an empty directory: entries=%v err=%v", entries, err)
	}
	environmentRoot := filepath.Join(fixture.operation.Target.DataRoot, "data", "agent-envs", "scope-hash")
	if raw, err := os.ReadFile(filepath.Join(environmentRoot, "home", "profile.txt")); err != nil || string(raw) != "retained\n" {
		t.Fatalf("Agent environment payload was not retained: %q %v", raw, err)
	}
	if _, err := os.Lstat(filepath.Join(environmentRoot, "logs")); !os.IsNotExist(err) {
		t.Fatalf("disposable Agent environment logs were migrated: %v", err)
	}
	simulateTargetStartupMutations(t, fixture.operation.Target.DataRoot)

	if err := fixture.boundary.RestoreData(context.Background(), fixture.operation); err != nil {
		t.Fatal(err)
	}
	if fixture.fence.calls != 1 {
		t.Fatalf("target writer fence calls = %d, want 1", fixture.fence.calls)
	}
	if _, err := os.Lstat(fixture.operation.Target.DataRoot); !os.IsNotExist(err) {
		t.Fatalf("transaction target survived rollback: %v", err)
	}
	if _, err := os.Lstat(fixture.operation.Source.DataRoot); err != nil {
		t.Fatalf("source root changed during target rollback: %v", err)
	}
}

func TestProductionBoundaryRollbackRejectsUnknownPostStartPath(t *testing.T) {
	fixture := newProductionFixture(t)
	if err := fixture.boundary.StageTarget(context.Background(), fixture.operation); err != nil {
		t.Fatal(err)
	}
	if err := fixture.boundary.TransformAndPublish(context.Background(), fixture.operation); err != nil {
		t.Fatal(err)
	}
	unknown := filepath.Join(fixture.operation.Target.DataRoot, "data", "unregistered-runtime")
	mustWrite(t, unknown, []byte("unknown\n"), 0o600)
	err := fixture.boundary.RestoreData(context.Background(), fixture.operation)
	if err == nil || !strings.Contains(err.Error(), "unknown or unsafe object") {
		t.Fatalf("rollback accepted an unknown target path: %v", err)
	}
	if _, statErr := os.Lstat(fixture.operation.Target.DataRoot); statErr != nil {
		t.Fatalf("failed-closed rollback removed the target root: %v", statErr)
	}
}

func TestProductionBoundaryRollbackFailsClosedBeforeRemoval(t *testing.T) {
	fixture := newProductionFixture(t)
	if err := fixture.boundary.StageTarget(context.Background(), fixture.operation); err != nil {
		t.Fatal(err)
	}
	if err := fixture.boundary.TransformAndPublish(context.Background(), fixture.operation); err != nil {
		t.Fatal(err)
	}
	fixture.fence.err = errors.New("target Manager is still active")
	err := fixture.boundary.RestoreData(context.Background(), fixture.operation)
	if err == nil || !strings.Contains(err.Error(), "still active") {
		t.Fatalf("live target writer was accepted: %v", err)
	}
	if _, statErr := os.Lstat(fixture.operation.Target.DataRoot); statErr != nil {
		t.Fatalf("failed fence removed target data: %v", statErr)
	}
	if fixture.privileged.removes != 0 {
		t.Fatalf("failed fence invoked privileged deletion %d times", fixture.privileged.removes)
	}
}

func TestProductionBoundaryRejectsForgedFenceProofWithoutDeletion(t *testing.T) {
	fixture := newProductionFixture(t)
	if err := fixture.boundary.StageTarget(context.Background(), fixture.operation); err != nil {
		t.Fatal(err)
	}
	if err := fixture.boundary.TransformAndPublish(context.Background(), fixture.operation); err != nil {
		t.Fatal(err)
	}
	fixture.fence.invalidProof = true
	err := fixture.boundary.RestoreData(context.Background(), fixture.operation)
	if err == nil || !strings.Contains(err.Error(), "fence proof") {
		t.Fatalf("forged target-writer fence proof was accepted: %v", err)
	}
	if fixture.privileged.removes != 0 {
		t.Fatalf("forged fence proof invoked privileged deletion %d times", fixture.privileged.removes)
	}
	if _, statErr := os.Lstat(fixture.operation.Target.DataRoot); statErr != nil {
		t.Fatalf("forged fence proof removed target data: %v", statErr)
	}
}

func TestProductionBoundaryRejectsMissingFenceAndComposeDrift(t *testing.T) {
	fixture := newProductionFixture(t)
	_, err := NewProductionBoundary(ProductionBoundaryOptions{
		ReleaseChannel: "main", TargetManifest: fixture.boundary.targetManifest, TargetCompose: fixture.compose, TargetManager: fixture.manager,
		Environment: ProductionEnvironment{GatewayAddress: "127.0.0.1:8080", PlatformBind: "127.0.0.1:18080", LogMaxSize: "10m", LogMaxFiles: 5},
	})
	if err == nil || !strings.Contains(err.Error(), "writer fence") {
		t.Fatalf("production boundary without rollback fence was accepted: %v", err)
	}
	fixture.boundary.targetCompose = []byte("changed compose\n")
	if err := fixture.boundary.StageTarget(context.Background(), fixture.operation); err == nil || !strings.Contains(err.Error(), "Compose bytes") {
		t.Fatalf("Compose drift was accepted: %v", err)
	}
	fixture.boundary.targetCompose = append([]byte(nil), fixture.compose...)
	fixture.boundary.targetManager = []byte("changed Manager\n")
	if err := fixture.boundary.StageTarget(context.Background(), fixture.operation); err == nil || !strings.Contains(err.Error(), "Manager bytes") {
		t.Fatalf("Manager drift was accepted: %v", err)
	}
}

func TestProductionBoundaryPreFenceCleanupDoesNotReadSourceAndRetainsUnexpectedStaging(t *testing.T) {
	fixture := newProductionFixture(t)
	unavailable := fixture.operation.Source.DataRoot + ".unavailable"
	if err := os.Rename(fixture.operation.Source.DataRoot, unavailable); err != nil {
		t.Fatal(err)
	}
	if err := fixture.boundary.RemoveTargetStaging(context.Background(), fixture.operation); err != nil {
		t.Fatalf("absent pre-fence target state required source access: %v", err)
	}
	stage := productionStagingPath(fixture.operation.Target.DataRoot, fixture.operation.TransactionID)
	mustMkdirAll(t, stage, 0o700)
	err := fixture.boundary.RemoveTargetStaging(context.Background(), fixture.operation)
	if err == nil || !strings.Contains(err.Error(), "unexpectedly exists") {
		t.Fatalf("unexpected pre-fence staging was not retained fail-closed: %v", err)
	}
	if _, statErr := os.Lstat(stage); statErr != nil {
		t.Fatalf("pre-fence cleanup removed conflicting staging evidence: %v", statErr)
	}
}

func TestProductionBoundaryUsesPerResourceContainerOwnerContract(t *testing.T) {
	fixture := newProductionFixture(t)
	deployment := Owner{UID: uint32(os.Getuid()), GID: uint32(os.Getgid())}
	want := map[string][]Owner{
		"cognee":             {deployment},
		"searxng":            {deployment},
		"firecrawl-redis":    {{UID: 999, GID: 0}, {UID: 999, GID: 1000}, deployment},
		"firecrawl-rabbitmq": {{UID: 999, GID: 0}, {UID: 999, GID: 999}, deployment},
		"firecrawl-postgres": {{UID: 999, GID: 0}, {UID: 999, GID: 999}, deployment},
	}
	for service, expected := range want {
		actual := fixture.boundary.runtimeOwners[service]
		if !reflect.DeepEqual(actual, ownerSet(expected, os.Getuid(), os.Getgid())) {
			t.Fatalf("%s owners = %#v, want %#v", service, actual, expected)
		}
	}
	unknown := []Entry{{Resource: "firecrawl_redis", Path: ".", Type: Directory, Mode: 0o700, UID: 998, GID: 998, LinkCount: 1}}
	resource := Resource{Name: "firecrawl_redis", Type: Directory}
	if err := validatePrivilegedEntries(resource, unknown, fixture.boundary.runtimeOwners["firecrawl-redis"]); err == nil {
		t.Fatal("owner outside the Redis image/Compose contract was accepted")
	}
}

func TestWorkspaceP1RootOwnerExceptionIsExactAndEmpty(t *testing.T) {
	deployment := Owner{UID: 1001, GID: 1001}
	root := Owner{UID: uint32(contract.P1WorkspaceRootOwnedUID), GID: uint32(contract.P1WorkspaceRootOwnedGID)}
	scopes := map[string]ScopeIdentity{"private:1": {ScopeKey: "private:1", WorkspaceID: "user-1"}}
	validator := &workspaceSourceInventoryValidator{scopes: scopes, deployment: deployment}
	entry := func(path string, owner Owner, kind NodeType, mode uint32) Entry {
		return Entry{Path: path, UID: owner.UID, GID: owner.GID, Type: kind, Mode: mode, LinkCount: 1}
	}
	namespace := pathpkg.Join("user-1", contract.P1WorkspaceSourceDirectory)
	mount := pathpkg.Join(namespace, contract.P1WorkspaceRootOwnedMountPath)
	rootPlaceholder := []Entry{
		entry(".", deployment, Directory, 0o700),
		entry("user-1", deployment, Directory, 0o700),
		entry(namespace, root, Directory, uint32(contract.P1WorkspaceNamespaceMode)),
		entry(mount, root, Directory, uint32(contract.P1WorkspaceRootOwnedMountMode)),
	}
	if err := validator.ValidateSourceInventory(rootPlaceholder); err != nil {
		t.Fatalf("exact audited root-owned placeholder tree was rejected: %v", err)
	}
	withRootOwnedUserData := append(cloneEntries(rootPlaceholder), entry(pathpkg.Join(namespace, "plans"), root, Directory, 0o700))
	if err := validator.ValidateSourceInventory(withRootOwnedUserData); err == nil || !strings.Contains(err.Error(), "exact P1 placeholder") {
		t.Fatalf("root owner was generalized to Agent user data: %v", err)
	}
	deployNamespace := cloneEntries(rootPlaceholder)
	deployNamespace[2].UID, deployNamespace[2].GID = deployment.UID, deployment.GID
	if err := validator.ValidateSourceInventory(deployNamespace); err != nil {
		t.Fatalf("root-owned empty mount below a deployment-owned namespace was rejected: %v", err)
	}
	nonemptyMount := append(deployNamespace, entry(pathpkg.Join(mount, "secret.txt"), deployment, RegularFile, 0o600))
	if err := validator.ValidateSourceInventory(nonemptyMount); err == nil || !strings.Contains(err.Error(), "is not empty") {
		t.Fatalf("nonempty root-owned mount placeholder was accepted: %v", err)
	}
}

func TestProductionBoundaryRejectsUnknownSourceRuntimeBeforeStaging(t *testing.T) {
	fixture := newProductionFixture(t)
	unknown := filepath.Join(fixture.operation.Source.DataRoot, "data", "runtimes", "firecrawl", "foundationdb")
	mustMkdirAll(t, unknown, 0o700)
	err := fixture.boundary.StageTarget(context.Background(), fixture.operation)
	if err == nil || !strings.Contains(err.Error(), "unknown object \"foundationdb\"") {
		t.Fatalf("unknown source Runtime was silently omitted: %v", err)
	}
	if _, statErr := os.Lstat(productionStagingPath(fixture.operation.Target.DataRoot, fixture.operation.TransactionID)); !os.IsNotExist(statErr) {
		t.Fatalf("source layout rejection created staging: %v", statErr)
	}
}

func TestProductionDirectoryValidationRejectsOversizedDirectChildInventory(t *testing.T) {
	root := filepath.Join(t.TempDir(), "closed")
	mustMkdirAll(t, root, 0o700)
	mustWrite(t, filepath.Join(root, "known"), []byte("known\n"), 0o600)
	for index := 0; index < p1CamofoxDirectoryBatchSize*2+1; index++ {
		mustWrite(t, filepath.Join(root, fmt.Sprintf("unknown-%04d", index)), nil, 0o600)
	}
	layout := contract.P1SourceDirectory{Mode: 0o700, Entries: map[string]contract.P1SourceObject{
		"known": {Type: "file", Disposition: "copied", Mode: 0o600, Required: true},
	}}
	err := validateProductionDirectory(root, layout, os.Getuid(), os.Getgid())
	if err == nil || !strings.Contains(err.Error(), "unknown object") {
		t.Fatalf("oversized closed-world directory inventory was accepted: %v", err)
	}
}

func TestValidateP1CamofoxHomeStreamsLargeDirectChildDirectory(t *testing.T) {
	source := filepath.Join(t.TempDir(), "source")
	mustMkdirAll(t, source, 0o700)
	createP1ProductionSourceLayout(t, source)
	home := filepath.Join(source, filepath.FromSlash(contract.P1CamofoxHomePath))
	bulk := filepath.Join(home, ".camoufox")
	for index := 0; index < p1CamofoxDirectoryBatchSize*2+1; index++ {
		mustWrite(t, filepath.Join(bulk, fmt.Sprintf("profile-%04d", index)), []byte("profile\n"), 0o600)
	}
	if err := validateP1CamofoxHome(home, os.Getuid(), os.Getgid()); err != nil {
		t.Fatalf("valid Camoufox direct children spanning multiple fixed batches were rejected: %v", err)
	}
}

func TestValidateP1CamofoxDirectoryRejectsRepeatedIdentity(t *testing.T) {
	parent := t.TempDir()
	child := filepath.Join(parent, "child")
	mustMkdirAll(t, child, 0o700)
	parentFD, err := unix.Open(parent, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(parentFD)
	var childStat unix.Stat_t
	if err := unix.Fstatat(parentFD, "child", &childStat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		t.Fatal(err)
	}
	identity := p1CamofoxDirectoryIdentity{device: uint64(childStat.Dev), inode: childStat.Ino}
	err = validateP1CamofoxDirectory(
		parentFD, "child", "child", childStat, uint64(childStat.Dev), os.Getuid(), os.Getgid(),
		map[string]bool{}, map[p1CamofoxDirectoryIdentity]struct{}{identity: {}},
	)
	if err == nil || !strings.Contains(err.Error(), "repeated directory identity") {
		t.Fatalf("repeated Camoufox directory identity was accepted: %v", err)
	}
}

func TestProductionBoundaryRejectsP1RetiredAndEphemeralDriftBeforeStaging(t *testing.T) {
	tests := []struct {
		name    string
		mutate  func(*testing.T, productionFixture)
		message string
	}{
		{
			name: "fixed retired bytes",
			mutate: func(t *testing.T, fixture productionFixture) {
				path := filepath.Join(fixture.operation.Source.DataRoot, "data", "runtimes", "searxng", "docker-compose.ubitech.yaml")
				mustWrite(t, path, []byte("changed\n"), 0o600)
			},
			message: "differs from its audited bytes",
		},
		{
			name: "nonempty process state",
			mutate: func(t *testing.T, fixture productionFixture) {
				mustWrite(t, filepath.Join(fixture.operation.Source.DataRoot, "manager", "processes", "stale.json"), []byte("{}\n"), 0o600)
			},
			message: "is not empty",
		},
		{
			name: "missing retired secret",
			mutate: func(t *testing.T, fixture productionFixture) {
				if err := os.Remove(filepath.Join(fixture.operation.Source.DataRoot, "data", "runtimes", "camofox", "access-key")); err != nil {
					t.Fatal(err)
				}
			},
			message: "required production object \"access-key\" is absent",
		},
		{
			name: "missing Manager secret",
			mutate: func(t *testing.T, fixture productionFixture) {
				if err := os.Remove(filepath.Join(fixture.operation.Source.DataRoot, "manager", "secrets", "manager-token")); err != nil {
					t.Fatal(err)
				}
			},
			message: "required Manager secret \"manager-token\" is absent",
		},
		{
			name: "extra Manager secret",
			mutate: func(t *testing.T, fixture productionFixture) {
				mustWrite(t, filepath.Join(fixture.operation.Source.DataRoot, "manager", "secrets", "legacy-token"), []byte("do-not-copy\n"), 0o600)
			},
			message: "unknown Manager secret \"legacy-token\"",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newProductionFixture(t)
			test.mutate(t, fixture)
			err := fixture.boundary.StageTarget(context.Background(), fixture.operation)
			if err == nil || !strings.Contains(err.Error(), test.message) {
				t.Fatalf("P1 source drift was accepted: %v", err)
			}
			if _, statErr := os.Lstat(productionStagingPath(fixture.operation.Target.DataRoot, fixture.operation.TransactionID)); !os.IsNotExist(statErr) {
				t.Fatalf("P1 source rejection created staging: %v", statErr)
			}
		})
	}
}

func TestSemanticDigestIsStableAcrossMapInsertionOrder(t *testing.T) {
	left := RuntimeIdentities{
		Scopes: map[string]ScopeIdentity{
			"private:2": {ScopeKey: "private:2", WorkspaceID: "user-2"},
			"private:1": {ScopeKey: "private:1", WorkspaceID: "user-1"},
		},
		Sessions: map[string]map[string]map[string]struct{}{
			"private:2": {"life-2": {"session-2": {}}},
			"private:1": {"life-1": {"session-1": {}}},
		},
	}
	right := RuntimeIdentities{
		Scopes: map[string]ScopeIdentity{
			"private:1": {ScopeKey: "private:1", WorkspaceID: "user-1"},
			"private:2": {ScopeKey: "private:2", WorkspaceID: "user-2"},
		},
		Sessions: map[string]map[string]map[string]struct{}{
			"private:1": {"life-1": {"session-1": {}}},
			"private:2": {"life-2": {"session-2": {}}},
		},
	}
	if semanticDigest(left) != semanticDigest(right) {
		t.Fatal("semantic transformation digest depends on Go map insertion order")
	}
	right.Sessions["private:2"]["life-2"]["session-3"] = struct{}{}
	if semanticDigest(left) == semanticDigest(right) {
		t.Fatal("semantic transformation digest ignored a durable session identity")
	}
}

func TestLoadAuthoritativeIdentitiesRejectsEveryOverLimitTable(t *testing.T) {
	tests := []struct {
		table   string
		message string
	}{
		{table: "scopes", message: "Agent scope count exceeds the handoff limit"},
		{table: "aliases", message: "Agent Runtime alias count exceeds the handoff limit"},
		{table: "current", message: "current Agent Runtime scope count exceeds the handoff limit"},
	}
	for _, test := range tests {
		t.Run(test.table, func(t *testing.T) {
			path := createOverLimitIdentityDatabase(t, test.table)
			_, err := LoadAuthoritativeIdentities(context.Background(), path, productionDatabaseVersion)
			if err == nil || !strings.Contains(err.Error(), test.message) {
				t.Fatalf("over-limit %s identity table was accepted: %v", test.table, err)
			}
		})
	}
}

func createOverLimitIdentityDatabase(t *testing.T, overload string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "platform.db")
	database, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`CREATE TABLE schema_migrations (version INTEGER, name TEXT)`,
		`INSERT INTO schema_migrations VALUES (` + strconv.Itoa(productionDatabaseVersion) + `, '` + SourceDatabaseBaselineName + `')`,
		`CREATE TABLE agent_scopes (scope_key TEXT, scope_type TEXT, scope_id TEXT, lifecycle_id TEXT, sandbox_id TEXT, workspace_path TEXT)`,
		`CREATE TABLE agent_runtime_scope_sessions (scope_key TEXT, lifecycle_id TEXT, session_id TEXT)`,
		`CREATE TABLE agent_runtime_scopes (scope_key TEXT, lifecycle_id TEXT, session_id TEXT)`,
	} {
		if _, err := database.Exec(statement); err != nil {
			database.Close()
			t.Fatalf("create identity-limit fixture: %v", err)
		}
	}
	transaction, err := database.Begin()
	if err != nil {
		database.Close()
		t.Fatal(err)
	}
	insertScope := func(index int) {
		_, err := transaction.Exec(
			`INSERT INTO agent_scopes VALUES (?, 'private', ?, ?, ?, ?)`,
			fmt.Sprintf("private:%05d", index), strconv.Itoa(index), fmt.Sprintf("life-%05d", index),
			fmt.Sprintf("sandbox-%05d", index), fmt.Sprintf("workspace-%05d", index),
		)
		if err != nil {
			t.Fatalf("insert identity-limit scope: %v", err)
		}
	}
	switch overload {
	case "scopes":
		for index := 0; index <= contract.AgentRuntimeMaximumIdentityRecords; index++ {
			insertScope(index)
		}
	case "aliases":
		insertScope(0)
		for index := 0; index <= contract.AgentRuntimeMaximumIdentityRecords; index++ {
			if _, err := transaction.Exec(`INSERT INTO agent_runtime_scope_sessions VALUES ('private:00000', 'life-00000', ?)`, fmt.Sprintf("session-%05d", index)); err != nil {
				t.Fatalf("insert identity-limit alias: %v", err)
			}
		}
	case "current":
		insertScope(0)
		if _, err := transaction.Exec(`INSERT INTO agent_runtime_scope_sessions VALUES ('private:00000', 'life-00000', 'session-00000')`); err != nil {
			t.Fatal(err)
		}
		for index := 0; index <= contract.AgentRuntimeMaximumIdentityRecords; index++ {
			if _, err := transaction.Exec(`INSERT INTO agent_runtime_scopes VALUES ('private:00000', 'life-00000', 'session-00000')`); err != nil {
				t.Fatalf("insert identity-limit current scope: %v", err)
			}
		}
	default:
		t.Fatalf("unknown identity-limit fixture %q", overload)
	}
	if err := transaction.Commit(); err != nil {
		database.Close()
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

type productionFixture struct {
	operation  handoffhelper.Operation
	boundary   *ProductionBoundary
	fence      *productionFence
	privileged *productionPrivilegedFS
	compose    []byte
	manager    []byte
}

func newProductionFixture(t *testing.T) productionFixture {
	t.Helper()
	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, identity.SourceProfile().DataDirectory)
	target := filepath.Join(root, identity.TargetProfile().DataDirectory)
	mustMkdirAll(t, source, 0o700)
	createProductionSource(t, source)

	compose := []byte("services:\n  platform:\n    image: ${AGENT_PLATFORM_PLATFORM_IMAGE}\n")
	targetManager := []byte("#!/bin/sh\nprintf '%s\\n' target-manager\n")
	composeSHA := shaHexBytes(compose)
	predecessor := strings.Repeat("a", 40)
	bridge := strings.Repeat("b", 40)
	targetManagerSHA := shaHexBytes(targetManager)
	manifest := productionBridgeManifest(predecessor, bridge, targetManagerSHA, composeSHA)
	manifestRaw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(root, "release.json")
	mustWrite(t, manifestPath, manifestRaw, 0o600)
	createdAt := time.Unix(1_800_000_000, 0).UTC()
	operation := handoffhelper.Operation{
		TransactionID:        testTransaction,
		TransactionDirectory: filepath.Join(root, testTransaction),
		Revision:             10,
		BindingSHA256:        strings.Repeat("d", 64),
		Status:               handoff.StatusRunning,
		DesiredOutcome:       handoff.OutcomeForward,
		Phase:                handoff.PhaseSourceFenced,
		Release: handoff.ReleaseBinding{
			PredecessorGeneration: predecessor, BridgeGeneration: bridge,
			ManifestPath: manifestPath, ManifestSHA256: shaHexBytes(manifestRaw),
			TargetManagerSHA256: targetManagerSHA, TargetManagerVersion: bridge,
			TargetComposeSHA256: composeSHA,
		},
		Source: handoff.SourceBinding{Namespace: identity.SourceProfile().ProfileID, DataRoot: source},
		Target: handoff.TargetBinding{
			Namespace: identity.TargetProfile().ProfileID, DataRoot: target,
			StableBinary: filepath.Join(root, "bin", identity.TargetProfile().ManagerBinary),
			SocketPath:   filepath.Join(root, "runtime", filepath.FromSlash(identity.TargetProfile().RuntimeSocketPath)),
		},
		Evidence:  handoff.Evidence{DatabaseSchemaVersion: productionDatabaseVersion},
		CreatedAt: createdAt, UpdatedAt: createdAt,
	}
	fence := &productionFence{}
	privileged := &productionPrivilegedFS{}
	boundary, err := NewProductionBoundary(ProductionBoundaryOptions{
		Engine:         Engine{PrivilegedTreeFS: privileged},
		ReleaseChannel: "main", TargetManifest: manifestRaw, TargetCompose: compose, TargetManager: targetManager, TargetFence: fence, ReserveBytes: 1,
		Environment: ProductionEnvironment{
			GatewayAddress: "127.0.0.1:8080", PlatformBind: "127.0.0.1:18080",
			LogMaxSize: "10m", LogMaxFiles: 5,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return productionFixture{operation: operation, boundary: boundary, fence: fence, privileged: privileged, compose: compose, manager: targetManager}
}

func assertFreshTargetManagerArtifacts(t *testing.T, fixture productionFixture) {
	t.Helper()
	root := filepath.Join(fixture.operation.Target.DataRoot, "manager")
	for _, name := range []string{"operations", "logs"} {
		entries, err := os.ReadDir(filepath.Join(root, name))
		if err != nil || len(entries) != 0 {
			t.Fatalf("fresh target Manager %s directory is not empty: entries=%v err=%v", name, entries, err)
		}
	}
	var state selfupdate.State
	if err := readStrictOwnerJSON(filepath.Join(root, "manager-binaries.json"), os.Getuid(), &state); err != nil {
		t.Fatal(err)
	}
	if state.Current == nil || state.Previous != nil || state.Candidate != nil || state.Activation != nil ||
		state.Current.SourceCommit != fixture.operation.Release.BridgeGeneration ||
		state.Current.SHA256 != fixture.operation.Release.TargetManagerSHA256 || !state.Current.PlatformCommitted {
		t.Fatalf("target self-update state is not a fresh bridge Current: %#v", state)
	}
	wantDirectory := productionSafeID(fixture.operation.Release.TargetManagerVersion + "-" + fixture.operation.Release.BridgeGeneration[:12])
	wantPath := filepath.Join(root, "manager-binaries", "versions", wantDirectory, identity.TargetProfile().ManagerBinary)
	if state.Current.Path != wantPath {
		t.Fatalf("target Current path = %q, want %q", state.Current.Path, wantPath)
	}
	raw, err := os.ReadFile(wantPath)
	if err != nil || !strings.EqualFold(shaHexBytes(raw), fixture.operation.Release.TargetManagerSHA256) {
		t.Fatalf("target Manager version artifact differs from the manifest: %v", err)
	}
	var metadata selfupdate.Version
	if err := readStrictOwnerJSON(filepath.Join(filepath.Dir(wantPath), "metadata.json"), os.Getuid(), &metadata); err != nil {
		t.Fatal(err)
	}
	if metadata != *state.Current {
		t.Fatalf("target Manager metadata differs from Current: metadata=%#v current=%#v", metadata, *state.Current)
	}
	for _, name := range []string{"serve.lock", "recovery.lock"} {
		info, err := os.Lstat(filepath.Join(root, "manager-binaries", name))
		if err != nil || !info.Mode().IsRegular() || info.Size() != 0 || info.Mode().Perm() != 0o600 {
			t.Fatalf("target Manager %s is not a fresh owner-only lock: info=%v err=%v", name, info, err)
		}
	}
}

func simulateTargetStartupMutations(t *testing.T, root string) {
	t.Helper()
	mustWrite(t, filepath.Join(root, "data", ".enterprise-platform.lock"), []byte("4321\n"), 0o600)
	mustWrite(t, filepath.Join(root, "data", "platform.db-wal"), []byte("runtime wal bytes\n"), 0o600)
	if err := os.Remove(filepath.Join(root, "data", "platform.db-shm")); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		filepath.Join(root, "data", ".home", ".cache", "platform-startup.cache"),
		filepath.Join(root, "data", "runtimes", "agent", "logs", "runtime.log"),
		filepath.Join(root, "data", "runtimes", "camofox", "cache", "startup.cache"),
		filepath.Join(root, "data", "runtimes", "camofox", "home", ".cache", "camoufox", "version.json"),
		filepath.Join(root, "data", "runtimes", "camofox", "home", "Downloads", "placeholder"),
		filepath.Join(root, "data", "logs", "platform.log"),
		filepath.Join(root, "manager", "logs", "audit.jsonl"),
	} {
		mustMkdirAll(t, filepath.Dir(path), 0o700)
		mustWrite(t, path, []byte("target startup state\n"), 0o600)
	}
}

func createProductionSource(t *testing.T, root string) {
	t.Helper()
	createP1ProductionSourceLayout(t, root)
	databasePath := filepath.Join(root, "data", "platform.db")
	mustMkdirAll(t, filepath.Dir(databasePath), 0o700)
	database, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatal(err)
	}
	statements := []string{
		`PRAGMA journal_mode=WAL`,
		`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL)`,
		`INSERT INTO schema_migrations(version, name) VALUES (` + strconv.Itoa(productionDatabaseVersion) + `, '` + SourceDatabaseBaselineName + `')`,
		`CREATE TABLE agent_scopes (scope_key TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, lifecycle_id TEXT NOT NULL, sandbox_id TEXT NOT NULL, workspace_path TEXT NOT NULL)`,
		`INSERT INTO agent_scopes VALUES ('private:1', 'private', '1', 'life-1', 'sandbox-1', 'user-1')`,
		`CREATE TABLE agent_runtime_scope_sessions (scope_key TEXT NOT NULL, lifecycle_id TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(scope_key, lifecycle_id, session_id))`,
		`INSERT INTO agent_runtime_scope_sessions VALUES ('private:1', 'life-1', 'session-1')`,
		`CREATE TABLE agent_runtime_scopes (scope_key TEXT PRIMARY KEY, lifecycle_id TEXT NOT NULL, session_id TEXT NOT NULL)`,
		`INSERT INTO agent_runtime_scopes VALUES ('private:1', 'life-1', 'session-1')`,
		`CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT NOT NULL)`,
		`INSERT INTO messages(body) VALUES ('user text containing ubitech-agent must remain unchanged')`,
	}
	for _, statement := range statements {
		if _, err := database.Exec(statement); err != nil {
			database.Close()
			t.Fatalf("execute fixture statement %q: %v", statement, err)
		}
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(databasePath, 0o600); err != nil {
		t.Fatal(err)
	}

	runtimeRoot := filepath.Join(root, "data", "runtimes", "agent")
	mustMkdirAll(t, runtimeRoot, 0o700)
	workspace := filepath.Join(root, "data", "workspaces", "user-1")
	mustMkdirAll(t, workspace, 0o700)
	marker := workspaceMarker{
		SchemaVersion: workspaceSchema, Kind: "agent-workspace-scope", TechnicalProfile: identity.SourceProfile().ProfileID,
		ScopeKey: "private:1", ScopeType: "private", ScopeID: "1", LifecycleID: "life-1",
		SandboxID: "sandbox-1", WorkspaceID: "user-1", WorkspaceRelativePath: "workspaces/user-1", Isolation: "container-workspace",
	}
	markerRaw, _ := json.Marshal(marker)
	mustWrite(t, filepath.Join(workspace, SourceWorkspaceMarkerName), append(markerRaw, '\n'), 0o600)
	mustWrite(t, filepath.Join(workspace, "user-note.txt"), []byte("do not rewrite ubitech-agent in user files\n"), 0o600)
	workspaceNamespace := filepath.Join(workspace, contract.P1WorkspaceSourceDirectory)
	mustMkdirAll(t, filepath.Join(workspaceNamespace, contract.P1WorkspaceRootOwnedMountPath), os.FileMode(contract.P1WorkspaceRootOwnedMountMode))
	mustMkdirAll(t, filepath.Join(workspaceNamespace, "plans"), 0o700)
	mustWrite(t, filepath.Join(workspaceNamespace, "plans", "retained.md"), []byte("agent-owned plan data\n"), 0o600)
	environmentRoot := filepath.Join(root, "data", "agent-envs", "scope-hash")
	mustMkdirAll(t, filepath.Join(environmentRoot, "home"), 0o700)
	mustMkdirAll(t, filepath.Join(environmentRoot, "logs"), 0o700)
	mustWrite(t, filepath.Join(environmentRoot, "home", "profile.txt"), []byte("retained\n"), 0o600)
	mustWrite(t, filepath.Join(environmentRoot, "logs", "discard.log"), []byte("discarded\n"), 0o600)

	camofoxRoot := filepath.Join(root, "data", "runtimes", "camofox")
	mustMkdirAll(t, camofoxRoot, 0o700)
	sidecar := camofoxSidecar{
		SchemaVersion: camofoxSchema, Kind: "platform-camofox-runtime", TechnicalProfile: identity.SourceProfile().ProfileID,
		RuntimeRelativePath: "runtimes/camofox", ProfilesRelativePath: "runtimes/camofox/profiles",
		CookiesRelativePath: "runtimes/camofox/cookies", TracesRelativePath: "runtimes/camofox/traces",
		ProfileDirectoryFormat: "sha256-user-id-32",
	}
	sidecarRaw, _ := json.Marshal(sidecar)
	mustWrite(t, filepath.Join(camofoxRoot, SourceCamofoxSidecarName), append(sidecarRaw, '\n'), 0o600)

	manager := filepath.Join(root, "manager")
	mustMkdirAll(t, filepath.Join(manager, "secrets"), 0o700)
	registry := sandboxRegistry{SchemaVersion: sandboxSchema, TechnicalProfile: identity.SourceProfile().ProfileID, Records: map[string]sandbox.Record{}}
	registryRaw, _ := json.Marshal(registry)
	mustWrite(t, filepath.Join(manager, "sandboxes.json"), append(registryRaw, '\n'), 0o600)
	for _, name := range contract.P1ManagerSecretNames {
		mustWrite(t, filepath.Join(manager, "secrets", name), []byte(strings.Repeat(name[:1], 64)+"\n"), 0o600)
	}
}

func createP1ProductionSourceLayout(t *testing.T, root string) {
	t.Helper()
	for path, mode := range map[string]os.FileMode{
		"backups":         0o700,
		"data/.home":      0o755,
		"data/agent-envs": 0o700, "data/agent-skills": 0o700, "data/attachments": 0o700,
		"data/upload-staging":   0o700,
		"data/runtimes":         0o700,
		"data/runtimes/camofox": 0o700, "data/runtimes/camofox/cache": 0o700,
		"data/runtimes/camofox/cookies": 0o700, "data/runtimes/camofox/home": 0o755,
		"data/runtimes/camofox/home/.cache/camoufox": 0o755,
		"data/runtimes/camofox/home/.camoufox":       0o700, "data/runtimes/camofox/home/Downloads": 0o755,
		"data/runtimes/camofox/home/camoufox": 0o700, "data/runtimes/camofox/logs": 0o700,
		"data/runtimes/camofox/profiles": 0o700, "data/runtimes/camofox/traces": 0o700,
		"data/runtimes/cognee": 0o700, "data/runtimes/cognee/cache": 0o755,
		"data/runtimes/cognee/data": 0o755, "data/runtimes/cognee/logs": 0o755,
		"data/runtimes/cognee/system": 0o755,
		"data/runtimes/searxng":       0o700, "data/runtimes/searxng/cache": 0o700,
		"data/runtimes/searxng/config": 0o700, "data/runtimes/searxng/logs": 0o700,
		"data/runtimes/firecrawl": 0o700, "data/runtimes/firecrawl/logs": 0o700,
		"data/runtimes/firecrawl/postgres": 0o700, "data/runtimes/firecrawl/rabbitmq": 0o755,
		"data/runtimes/firecrawl/redis": 0o755,
		"manager":                       0o700, "manager/control": 0o700, "manager/logs": 0o700,
		"manager/manager-binaries": 0o700, "manager/operations": 0o700, "manager/processes": 0o700,
		"manager/releases": 0o700, "manager/secrets": 0o700,
	} {
		mustMkdirAll(t, filepath.Join(root, filepath.FromSlash(path)), mode)
	}
	for path, target := range map[string]string{
		"data/runtimes/camofox/home/.cache/camoufox/camofox-bin":     "/opt/camofox/browser/camoufox",
		"data/runtimes/camofox/home/.cache/camoufox/fontconfig":      "/opt/camofox/browser/fontconfig",
		"data/runtimes/camofox/home/.cache/camoufox/properties.json": "/opt/camofox/browser/properties.json",
	} {
		if err := os.Symlink(target, filepath.Join(root, filepath.FromSlash(path))); err != nil {
			t.Fatal(err)
		}
	}
	for _, path := range []string{"data/.enterprise-platform.lock", "data/runtimes/.upstream-sources.lock", "data/runtimes/camofox/.install.lock"} {
		mustWrite(t, filepath.Join(root, filepath.FromSlash(path)), nil, 0o600)
	}
	for _, path := range []string{"data/runtimes/camofox/access-key", "data/runtimes/searxng/secret-key"} {
		mustWrite(t, filepath.Join(root, filepath.FromSlash(path)), []byte(strings.Repeat("k", 64)+"\n"), 0o600)
	}
	for path, encoded := range p1RetiredFixtureBase64 {
		raw, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			t.Fatal(err)
		}
		mode := os.FileMode(0o644)
		if strings.Contains(path, "cognee/") || strings.Contains(path, "searxng/") {
			mode = 0o600
		}
		mustWrite(t, filepath.Join(root, filepath.FromSlash(path)), raw, mode)
	}
	mustWrite(t, filepath.Join(root, "data", "runtimes", "firecrawl", ".env"), []byte("BULL_AUTH_KEY=\""+strings.Repeat("b", 32)+"\"\nHOST=\"0.0.0.0\"\nPORT=\"127.0.0.1:3002\"\nUSE_DB_AUTHENTICATION=\"false\"\n"), 0o600)
	migration := map[string]any{
		"schema_version": 1, "id": "legacy-0123456789abcdef", "status": "purged",
		"operation_id":           "op_0123456789abcdef0123456789abcdef",
		"expected_source_commit": strings.Repeat("a", 40),
		"created_at":             "2026-07-28T00:00:00.000000000Z", "updated_at": "2026-07-28T01:00:00Z",
		"retirement": map[string]any{
			"campaign_id": "source-v1-retirement-2026-07", "generation_id": strings.Repeat("b", 40),
			"started_at": "2026-07-28T00:10:00Z", "completed_at": "2026-07-28T00:20:00Z", "status": "completed",
			"systemd_removed": true, "docker_removed": true, "recovery_removed": true, "source_state_removed": true,
		},
	}
	migrationRaw, err := json.Marshal(migration)
	if err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(root, "manager", "migration.json"), append(migrationRaw, '\n'), 0o600)
	for _, path := range []string{"active-generation", "manager-binaries.json", "sandboxes.json", "state.json"} {
		mustWrite(t, filepath.Join(root, "manager", path), []byte("{}\n"), 0o600)
	}
}

var p1RetiredFixtureBase64 = map[string]string{
	"data/runtimes/cognee/python-install.json":               "eyJweXRob24iOiAiL2hvbWUvdWJpdGVjaC9lbnRlcnByaXNlLWFnZW50LXBsYXRmb3JtLy52ZW52L2Jpbi9weXRob24iLCAicmV2aXNpb24iOiAiMjUyZjJjM2VmYjE4NDUzM2EwOTU1ZTMxZTgzYTI4ZWE3ZGI5ODEzZCIsICJzb3VyY2UiOiAiL2hvbWUvdWJpdGVjaC9lbnRlcnByaXNlLWFnZW50LXBsYXRmb3JtL2VudGVycHJpc2UtYWdlbnQtcGxhdGZvcm0vZGF0YS9ydW50aW1lcy9jb2duZWUvc291cmNlLzI1MmYyYzNlZmIxODQ1MzNhMDk1NWUzMWU4M2EyOGVhN2RiOTgxM2QifQo=",
	"data/runtimes/searxng/docker-compose.ubitech.yaml":      "IyBHZW5lcmF0ZWQgYnkgdWJpdGVjaCBhZ2VudCBmb3IgdGhlIG1hbmFnZWQgbG9jYWwgcnVudGltZS4KIyBUaGUgaG9zdCBwdWJsaWNhdGlvbiBpcyBhIHZhbGlkYXRlZCBsaXRlcmFsIGxvb3BiYWNrIGFkZHJlc3MuCnNlcnZpY2VzOgogIHNlYXJ4bmc6CiAgICBpbWFnZTogZ2hjci5pby9zZWFyeG5nL3NlYXJ4bmdAc2hhMjU2OmI4Y2EzOGJhMDZlZWE1NDRkNzU1NWU4ODMyMWUyMTJkZGMwZDVjM2M3ZGUwNTU0MTljZmIyZTVjNmJmMzA4MTIKICAgIGxhYmVsczoKICAgICAgb3JnLnViaXRlY2guYWdlbnQubWFuYWdlZDogInRydWUiCiAgICByZXN0YXJ0OiB1bmxlc3Mtc3RvcHBlZAogICAgZW52aXJvbm1lbnQ6CiAgICAgIEZPUkNFX09XTkVSU0hJUDogImZhbHNlIgogICAgcG9ydHM6CiAgICAgIC0gIjEyNy4wLjAuMToxMzAwMzo4MDgwIgogICAgdm9sdW1lczoKICAgICAgLSAiL2hvbWUvdWJpdGVjaC9lbnRlcnByaXNlLWFnZW50LXBsYXRmb3JtL2VudGVycHJpc2UtYWdlbnQtcGxhdGZvcm0vZGF0YS9ydW50aW1lcy9zZWFyeG5nL2NvbmZpZzovZXRjL3NlYXJ4bmc6cm8iCiAgICAgIC0gIi9ob21lL3ViaXRlY2gvZW50ZXJwcmlzZS1hZ2VudC1wbGF0Zm9ybS9lbnRlcnByaXNlLWFnZW50LXBsYXRmb3JtL2RhdGEvcnVudGltZXMvc2VhcnhuZy9jYWNoZTovdmFyL2NhY2hlL3NlYXJ4bmciCiAgICBoZWFsdGhjaGVjazoKICAgICAgdGVzdDoKICAgICAgICAtICJDTUQiCiAgICAgICAgLSAid2dldCIKICAgICAgICAtICItLXF1aWV0IgogICAgICAgIC0gIi0tdHJpZXM9MSIKICAgICAgICAtICItLXNwaWRlciIKICAgICAgICAtICJodHRwOi8vMTI3LjAuMC4xOjgwODAvaGVhbHRoeiIKICAgICAgaW50ZXJ2YWw6IDEwcwogICAgICB0aW1lb3V0OiAzcwogICAgICByZXRyaWVzOiAxMgogICAgICBzdGFydF9wZXJpb2Q6IDIwcwo=",
	"data/runtimes/firecrawl/docker-compose.enterprise.yaml": "IyBHZW5lcmF0ZWQgYnkgdWJpdGVjaCBhZ2VudCBmb3IgdGhlIG1hbmFnZWQgbG9jYWwgcnVudGltZS4KIyBFdmVyeSBpbWFnZSBpcyBwaW5uZWQgdG8gYW4gaW1tdXRhYmxlIHJlZ2lzdHJ5IGRpZ2VzdC4Kc2VydmljZXM6CiAgYXBpOgogICAgaW1hZ2U6IGdoY3IuaW8vZmlyZWNyYXdsL2ZpcmVjcmF3bEBzaGEyNTY6YzJlOGZjNDZmYmM5ZGJhNTc0NjNiNGI0ZjVjMjNmZmZlMmFhZjU3OGE3NjkxYzVhYWFmMmNhZTU4YTAxZjgwYwogIHBsYXl3cmlnaHQtc2VydmljZToKICAgIGltYWdlOiBnaGNyLmlvL2ZpcmVjcmF3bC9wbGF5d3JpZ2h0LXNlcnZpY2VAc2hhMjU2OjYzNTliMGQ5MDcwZjI3NDAwYjRhOWI2MTU1MDliZTA2OTE5ZTQwMTIxZmMxZmRjNDJkNGVmZWRkZjAyNjUzZDIKICBudXEtcG9zdGdyZXM6CiAgICBpbWFnZTogZ2hjci5pby9maXJlY3Jhd2wvbnVxLXBvc3RncmVzQHNoYTI1NjphZWQ4NmY2Mjg1OGYyOWJkOTcxYWJkZGNkZWIzMDFjMTI4ODgwOThkMmNmNWQzM2MxYmE0MmIwNTNiYzQ2MGY2CiAgcmVkaXM6CiAgICBpbWFnZTogcmVkaXNAc2hhMjU2OjlkMzE3MTc4ZWNlYWM4NDU0YTIyODRhOWU2ZGYyNDY2YjkzYzc0NTUyOTk0N2YwY2Q0MmEwZmE5NjA5ZDcwMDUKICByYWJiaXRtcToKICAgIGltYWdlOiByYWJiaXRtcUBzaGEyNTY6ZTU4MmMwYmM3NzY2ZjMzNDI0OTZkODQ4NWVmYjVhMWRmNzgyYjVjZTM4ODZhZDAxN2UyZWFhZTQ0MjMxMWY2OQogIGZvdW5kYXRpb25kYjoKICAgIGltYWdlOiBmb3VuZGF0aW9uZGIvZm91bmRhdGlvbmRiQHNoYTI1NjpkZjFhMjMxMGM2ZGJlMGQ1NmRlZjUyNmI3MzYwNmNjOGZkNDE0ZWNjNDJjNTBmYmEyNTg4ZjEzMjkyZjgyZDQ4CiAgZm91bmRhdGlvbmRiLWluaXQ6CiAgICBpbWFnZTogZm91bmRhdGlvbmRiL2ZvdW5kYXRpb25kYkBzaGEyNTY6ZGYxYTIzMTBjNmRiZTBkNTZkZWY1MjZiNzM2MDZjYzhmZDQxNGVjYzQyYzUwZmJhMjU4OGYxMzI5MmY4MmQ0OAo=",
	"data/runtimes/firecrawl/docker-compose.ubitech.yaml":    "IyBHZW5lcmF0ZWQgYnkgdWJpdGVjaCBhZ2VudCBmb3IgdGhlIG1hbmFnZWQgbG9jYWwgcnVudGltZS4KIyBFdmVyeSBpbWFnZSBpcyBwaW5uZWQgdG8gYW4gaW1tdXRhYmxlIHJlZ2lzdHJ5IGRpZ2VzdC4Kc2VydmljZXM6CiAgYXBpOgogICAgaW1hZ2U6IGdoY3IuaW8vZmlyZWNyYXdsL2ZpcmVjcmF3bEBzaGEyNTY6YzJlOGZjNDZmYmM5ZGJhNTc0NjNiNGI0ZjVjMjNmZmZlMmFhZjU3OGE3NjkxYzVhYWFmMmNhZTU4YTAxZjgwYwogICAgbGFiZWxzOgogICAgICBvcmcudWJpdGVjaC5hZ2VudC5tYW5hZ2VkOiAidHJ1ZSIKICAgIGRlcGVuZHNfb246CiAgICAgIGZvdW5kYXRpb25kYi1pbml0OgogICAgICAgIGNvbmRpdGlvbjogc2VydmljZV9jb21wbGV0ZWRfc3VjY2Vzc2Z1bGx5CiAgcGxheXdyaWdodC1zZXJ2aWNlOgogICAgaW1hZ2U6IGdoY3IuaW8vZmlyZWNyYXdsL3BsYXl3cmlnaHQtc2VydmljZUBzaGEyNTY6NjM1OWIwZDkwNzBmMjc0MDBiNGE5YjYxNTUwOWJlMDY5MTllNDAxMjFmYzFmZGM0MmQ0ZWZlZGRmMDI2NTNkMgogICAgbGFiZWxzOgogICAgICBvcmcudWJpdGVjaC5hZ2VudC5tYW5hZ2VkOiAidHJ1ZSIKICBudXEtcG9zdGdyZXM6CiAgICBpbWFnZTogZ2hjci5pby9maXJlY3Jhd2wvbnVxLXBvc3RncmVzQHNoYTI1NjphZWQ4NmY2Mjg1OGYyOWJkOTcxYWJkZGNkZWIzMDFjMTI4ODgwOThkMmNmNWQzM2MxYmE0MmIwNTNiYzQ2MGY2CiAgICBsYWJlbHM6CiAgICAgIG9yZy51Yml0ZWNoLmFnZW50Lm1hbmFnZWQ6ICJ0cnVlIgogIHJlZGlzOgogICAgaW1hZ2U6IHJlZGlzQHNoYTI1Njo5ZDMxNzE3OGVjZWFjODQ1NGEyMjg0YTllNmRmMjQ2NmI5M2M3NDU1Mjk5NDdmMGNkNDJhMGZhOTYwOWQ3MDA1CiAgICBsYWJlbHM6CiAgICAgIG9yZy51Yml0ZWNoLmFnZW50Lm1hbmFnZWQ6ICJ0cnVlIgogIHJhYmJpdG1xOgogICAgaW1hZ2U6IHJhYmJpdG1xQHNoYTI1NjplNTgyYzBiYzc3NjZmMzM0MjQ5NmQ4NDg1ZWZiNWExZGY3ODJiNWNlMzg4NmFkMDE3ZTJlYWFlNDQyMzExZjY5CiAgICBsYWJlbHM6CiAgICAgIG9yZy51Yml0ZWNoLmFnZW50Lm1hbmFnZWQ6ICJ0cnVlIgogIGZvdW5kYXRpb25kYjoKICAgIGltYWdlOiBmb3VuZGF0aW9uZGIvZm91bmRhdGlvbmRiQHNoYTI1NjpkZjFhMjMxMGM2ZGJlMGQ1NmRlZjUyNmI3MzYwNmNjOGZkNDE0ZWNjNDJjNTBmYmEyNTg4ZjEzMjkyZjgyZDQ4CiAgICBsYWJlbHM6CiAgICAgIG9yZy51Yml0ZWNoLmFnZW50Lm1hbmFnZWQ6ICJ0cnVlIgogIGZvdW5kYXRpb25kYi1pbml0OgogICAgaW1hZ2U6IGZvdW5kYXRpb25kYi9mb3VuZGF0aW9uZGJAc2hhMjU2OmRmMWEyMzEwYzZkYmUwZDU2ZGVmNTI2YjczNjA2Y2M4ZmQ0MTRlY2M0MmM1MGZiYTI1ODhmMTMyOTJmODJkNDgKICAgIGxhYmVsczoKICAgICAgb3JnLnViaXRlY2guYWdlbnQubWFuYWdlZDogInRydWUiCg==",
}

func productionBridgeManifest(predecessor, bridge, managerSHA, composeSHA string) release.Manifest {
	artifact := func(name, digest string) release.Artifact {
		return release.Artifact{URL: "https://example.invalid/" + name, SHA256: digest}
	}
	manager := func(version, prefix, digest string) release.ManagerRelease {
		return release.ManagerRelease{Version: version, Artifacts: map[string]release.Artifact{
			"amd64": artifact(prefix+"-amd64", digest), "arm64": artifact(prefix+"-arm64", digest),
		}}
	}
	images := map[string]string{}
	for index, name := range []string{
		"platform", "agent-runtime", "camofox", "agent-sandbox", "searxng",
		"firecrawl-api", "firecrawl-playwright", "firecrawl-postgres", "firecrawl-redis", "firecrawl-rabbitmq", "handoff-fs-helper",
	} {
		images[name] = "registry.example.invalid/" + name + "@sha256:" + strings.Repeat(string("0123456789abcdef"[index]), 64)
	}
	targetManager := manager(bridge, "target-manager", managerSHA)
	targetCompose := artifact("target-compose", composeSHA)
	return release.Manifest{
		SchemaVersion: 1, Channel: "main", SourceCommit: bridge,
		GeneratedAt: time.Unix(1_800_000_000, 0).UTC(), ProtocolVersion: 1,
		DatabaseSchemaVersion: productionDatabaseVersion, Manager: targetManager, Compose: targetCompose, Images: images,
		NamespaceHandoff: &release.NamespaceHandoff{
			SchemaVersion: 1, PredecessorGeneration: predecessor, BridgeGeneration: bridge,
			Source: release.NamespaceBinding{
				ProfileID: identity.SourceProfile().ProfileID,
				Manager:   manager(predecessor, "source-manager", strings.Repeat("e", 64)),
				Compose:   artifact("source-compose", strings.Repeat("f", 64)),
			},
			Target: release.NamespaceBinding{ProfileID: identity.TargetProfile().ProfileID, Manager: targetManager, Compose: targetCompose},
		},
	}
}

func assertTargetDatabaseBaseline(t *testing.T, path string) {
	t.Helper()
	database, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	var baseline, body string
	if err := database.QueryRow(`SELECT name FROM schema_migrations WHERE version = ?`, productionDatabaseVersion).Scan(&baseline); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`SELECT body FROM messages`).Scan(&body); err != nil {
		t.Fatal(err)
	}
	if baseline != TargetDatabaseBaselineName || !strings.Contains(body, "ubitech-agent") {
		t.Fatalf("database transform changed the wrong content: baseline=%q body=%q", baseline, body)
	}
}

func shaHexBytes(raw []byte) string {
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}
