// Code generated from docs/contracts/container-platform.json by scripts/docs_sync.py; DO NOT EDIT.
package contract

const (
	SchemaVersion                       = 1
	ReleaseChannel                      = "main"
	DatabaseSchemaVersion               = 2026072901
	ContainerDataRoot                   = "/var/lib/agent-platform"
	ContainerWorkspace                  = "/workspace"
	ContainerAgentHome                  = "/home/agent"
	ContainerAgentEnv                   = "/opt/agent-env"
	SandboxIdleSeconds                  = 1800
	MigrationBackupRetentionSeconds     = 604800
	ObsoleteArtifactRetentionSeconds    = 3600
	UpdatePreDownloadMinFreeBytes       = 8589934592
	UpdatePreCutoverMinFreeBytes        = 2147483648
	UpdateMinFreeInodes                 = 4096
	AgentRuntimeMaximumIdentityRecords  = 16384
	AgentRuntimeMaximumJSONLBytes       = 268435456
	AgentRuntimeMaximumJSONLRecords     = 1048576
	AgentRuntimeMaximumDirectoryEntries = 65536
)

type ImageCapacityEstimate struct {
	CompressedBytes uint64
	UnpackedBytes   uint64
}

var ManagedImageCapacityEstimates = map[string]ImageCapacityEstimate{
	"agent-runtime": {
		CompressedBytes: 4294967296,
		UnpackedBytes:   8589934592,
	},
	"agent-sandbox": {
		CompressedBytes: 4294967296,
		UnpackedBytes:   8589934592,
	},
	"camofox": {
		CompressedBytes: 4294967296,
		UnpackedBytes:   8589934592,
	},
	"firecrawl-api": {
		CompressedBytes: 8589934592,
		UnpackedBytes:   17179869184,
	},
	"firecrawl-playwright": {
		CompressedBytes: 8589934592,
		UnpackedBytes:   17179869184,
	},
	"firecrawl-postgres": {
		CompressedBytes: 2147483648,
		UnpackedBytes:   4294967296,
	},
	"firecrawl-rabbitmq": {
		CompressedBytes: 1073741824,
		UnpackedBytes:   2147483648,
	},
	"firecrawl-redis": {
		CompressedBytes: 1073741824,
		UnpackedBytes:   2147483648,
	},
	"handoff-fs-helper": {
		CompressedBytes: 536870912,
		UnpackedBytes:   1073741824,
	},
	"platform": {
		CompressedBytes: 8589934592,
		UnpackedBytes:   17179869184,
	},
	"searxng": {
		CompressedBytes: 2147483648,
		UnpackedBytes:   4294967296,
	},
}

type PersistentDataOwner struct {
	UID uint32
	GID uint32
}

var PersistentDataOwners = map[string][]PersistentDataOwner{
	"cognee":             {},
	"firecrawl-postgres": {{UID: 999, GID: 0}, {UID: 999, GID: 999}},
	"firecrawl-rabbitmq": {{UID: 999, GID: 0}, {UID: 999, GID: 999}},
	"firecrawl-redis":    {{UID: 999, GID: 0}, {UID: 999, GID: 1000}},
	"searxng":            {},
}

const (
	AgentRuntimeP1AppMode             = 493
	AgentRuntimeP1AppInventorySHA256  = "8ddfd45d49b94bb73fb06ac968c84b2e82d9a4408381401fc48c6ddca76a5a15"
	AgentRuntimeP1AppInventoryEntries = 18439
	AgentRuntimeP1AppRegularBytes     = 89075179
	AgentRuntimeP1InstallSignature    = "84c4f8be8ff7b2b9391a109cc857e7a2ac5a9f673d992522e258b715585454da"
	AgentRuntimeP1PackageName         = "@ubitech/agent-runtime"
	AgentRuntimeP1PackageVersion      = "0.1.0"
	AgentRuntimeP1HomeMode            = 493
	AgentRuntimeP1MemoryMode          = 448
	AgentRuntimeP1MigrationMode       = 448
	AgentRuntimeP1MigrationFile       = "hermes-cutover.json"
	AgentRuntimeP1MigrationFileMode   = 384
	AgentRuntimeP1MigrationSchema     = 1
	AgentRuntimeP1MigrationPhase      = "finalized"
)

var AgentRuntimeCurrentRoots = []string{"sessions", "approvals", "idempotency"}
var AgentRuntimeEphemeralRoots = []string{"logs"}
var AgentRuntimeP1RetiredRoots = []string{"app", "home", "memory", "migration"}
var AgentRuntimeP1AppTopLevelEntries = []string{".gitignore", "README.md", "dist", "install.json", "node_modules", "package-lock.json", "package.json", "src", "test", "tsconfig.json"}
var AgentRuntimeP1AppAllowedSymlinks = map[string]string{
	"node_modules/.bin/anthropic-ai-sdk": "../@anthropic-ai/sdk/bin/cli",
	"node_modules/.bin/openai":           "../openai/bin/cli",
	"node_modules/.bin/pi-ai":            "../@earendil-works/pi-ai/dist/cli.js",
	"node_modules/.bin/yaml":             "../yaml/bin.mjs",
}
var AgentRuntimeP1MigrationFields = []string{"attachments_skipped", "attachments_verified", "imported", "memories_imported", "memories_skipped", "oauth_cleared", "oauth_imported", "oauth_skipped", "phase", "session_manifests", "session_messages", "skipped", "updated_at", "version", "workspaces_skipped", "workspaces_verified"}

type P1SourceObject struct {
	Type        string
	Disposition string
	Mode        uint32
	Required    bool
}

type P1SourceDirectory struct {
	Mode    uint32
	Entries map[string]P1SourceObject
}

var P1SourceLayouts = map[string]P1SourceDirectory{
	".": {Mode: 448, Entries: map[string]P1SourceObject{
		"backups": {Type: "directory", Disposition: "retired", Mode: 448, Required: true},
		"data":    {Type: "directory", Disposition: "retained", Mode: 448, Required: true},
		"manager": {Type: "directory", Disposition: "retained", Mode: 448, Required: true},
	}},
	"data": {Mode: 448, Entries: map[string]P1SourceObject{
		".enterprise-platform.lock":    {Type: "file", Disposition: "generated", Mode: 384, Required: true},
		".home":                        {Type: "directory", Disposition: "generated", Mode: 493, Required: true},
		"agent-envs":                   {Type: "directory", Disposition: "copied", Mode: 448, Required: true},
		"agent-skills":                 {Type: "directory", Disposition: "copied", Mode: 448, Required: true},
		"attachments":                  {Type: "directory", Disposition: "copied", Mode: 448, Required: true},
		"bootstrap-admin-password.txt": {Type: "file", Disposition: "copied", Mode: 384, Required: false},
		"logs":                         {Type: "directory", Disposition: "generated", Mode: 448, Required: false},
		"platform.db":                  {Type: "file", Disposition: "retained", Mode: 384, Required: true},
		"platform.db-shm":              {Type: "file", Disposition: "generated", Mode: 384, Required: false},
		"platform.db-wal":              {Type: "file", Disposition: "generated", Mode: 384, Required: false},
		"runtimes":                     {Type: "directory", Disposition: "retained", Mode: 448, Required: true},
		"upload-staging":               {Type: "directory", Disposition: "generated", Mode: 448, Required: true},
		"workspaces":                   {Type: "directory", Disposition: "retained", Mode: 448, Required: true},
	}},
	"data/runtimes": {Mode: 448, Entries: map[string]P1SourceObject{
		".upstream-sources.lock": {Type: "file", Disposition: "ephemeral", Mode: 384, Required: true},
		"agent":                  {Type: "directory", Disposition: "retained", Mode: 448, Required: true},
		"camofox":                {Type: "directory", Disposition: "retained", Mode: 448, Required: true},
		"cognee":                 {Type: "directory", Disposition: "retained", Mode: 448, Required: true},
		"firecrawl":              {Type: "directory", Disposition: "retained", Mode: 448, Required: true},
		"searxng":                {Type: "directory", Disposition: "retained", Mode: 448, Required: true},
	}},
	"data/runtimes/camofox": {Mode: 448, Entries: map[string]P1SourceObject{
		".install.lock":               {Type: "file", Disposition: "ephemeral", Mode: 384, Required: true},
		".ubitech-agent-runtime.json": {Type: "file", Disposition: "retained", Mode: 384, Required: true},
		"access-key":                  {Type: "file", Disposition: "retired", Mode: 384, Required: true},
		"cache":                       {Type: "directory", Disposition: "generated", Mode: 448, Required: true},
		"cookies":                     {Type: "directory", Disposition: "copied", Mode: 448, Required: true},
		"home":                        {Type: "directory", Disposition: "generated", Mode: 493, Required: true},
		"logs":                        {Type: "directory", Disposition: "generated", Mode: 448, Required: true},
		"profiles":                    {Type: "directory", Disposition: "copied", Mode: 448, Required: true},
		"traces":                      {Type: "directory", Disposition: "copied", Mode: 448, Required: true},
	}},
	"data/runtimes/cognee": {Mode: 448, Entries: map[string]P1SourceObject{
		"cache":               {Type: "directory", Disposition: "copied", Mode: 493, Required: true},
		"data":                {Type: "directory", Disposition: "copied", Mode: 493, Required: true},
		"logs":                {Type: "directory", Disposition: "generated", Mode: 493, Required: true},
		"python-install.json": {Type: "file", Disposition: "retired", Mode: 384, Required: true},
		"system":              {Type: "directory", Disposition: "copied", Mode: 493, Required: true},
	}},
	"data/runtimes/firecrawl": {Mode: 448, Entries: map[string]P1SourceObject{
		".env":                           {Type: "file", Disposition: "retired", Mode: 384, Required: true},
		"docker-compose.enterprise.yaml": {Type: "file", Disposition: "retired", Mode: 420, Required: true},
		"docker-compose.ubitech.yaml":    {Type: "file", Disposition: "retired", Mode: 420, Required: true},
		"logs":                           {Type: "directory", Disposition: "generated", Mode: 448, Required: true},
		"postgres":                       {Type: "directory", Disposition: "copied", Mode: 448, Required: true},
		"rabbitmq":                       {Type: "directory", Disposition: "copied", Mode: 493, Required: true},
		"redis":                          {Type: "directory", Disposition: "copied", Mode: 493, Required: true},
	}},
	"data/runtimes/searxng": {Mode: 448, Entries: map[string]P1SourceObject{
		"cache":                       {Type: "directory", Disposition: "copied", Mode: 448, Required: true},
		"config":                      {Type: "directory", Disposition: "copied", Mode: 448, Required: true},
		"docker-compose.ubitech.yaml": {Type: "file", Disposition: "retired", Mode: 384, Required: true},
		"logs":                        {Type: "directory", Disposition: "generated", Mode: 448, Required: true},
		"secret-key":                  {Type: "file", Disposition: "retired", Mode: 384, Required: true},
	}},
	"manager": {Mode: 448, Entries: map[string]P1SourceObject{
		"active-generation":     {Type: "file", Disposition: "generated", Mode: 384, Required: true},
		"control":               {Type: "directory", Disposition: "ephemeral", Mode: 448, Required: true},
		"logs":                  {Type: "directory", Disposition: "generated", Mode: 448, Required: true},
		"manager-binaries":      {Type: "directory", Disposition: "generated", Mode: 448, Required: true},
		"manager-binaries.json": {Type: "file", Disposition: "generated", Mode: 384, Required: true},
		"migration.json":        {Type: "file", Disposition: "retired", Mode: 384, Required: true},
		"operations":            {Type: "directory", Disposition: "generated", Mode: 448, Required: true},
		"processes":             {Type: "directory", Disposition: "ephemeral", Mode: 448, Required: true},
		"releases":              {Type: "directory", Disposition: "generated", Mode: 448, Required: true},
		"sandboxes.json":        {Type: "file", Disposition: "retained", Mode: 384, Required: true},
		"secrets":               {Type: "directory", Disposition: "copied", Mode: 448, Required: true},
		"state.json":            {Type: "file", Disposition: "generated", Mode: 384, Required: true},
	}},
}

var P1SourceEmptyFiles = []string{"data/runtimes/.upstream-sources.lock", "data/runtimes/camofox/.install.lock"}
var P1SourceEmptyDirectories = []string{"data/.home", "manager/processes"}
var P1SourceSecretFiles = []string{"data/runtimes/camofox/access-key", "data/runtimes/searxng/secret-key"}
var P1ManagerSecretNames = []string{"agent-runtime-token", "agent-tool-token", "camofox-access-key", "firecrawl-bull-auth-key", "firecrawl-postgres-password", "manager-executor-token", "manager-token", "session-secret"}
var P1SourceFixedSHA256 = map[string]string{
	"data/runtimes/cognee/python-install.json":               "0a02646ac897273b2dfb3795c48ad5f22e76b49b0d868b15765c7925369163dc",
	"data/runtimes/firecrawl/docker-compose.enterprise.yaml": "0f7d098e886cd9c3895b477c6adcf0eb836ddfc8e1eb33def2f972c138581b5b",
	"data/runtimes/firecrawl/docker-compose.ubitech.yaml":    "80e2399b34efaa238953b6ec5000d8dc4abe81f56eee0861ea83ee07d8f3f5cc",
	"data/runtimes/searxng/docker-compose.ubitech.yaml":      "78fedfd5ab49918f1e6cc27acdc17a0bd99ef9918d4aeb6a55d35ee9811e181a",
}

const P1SourceSecretLinePattern = "^[A-Za-z0-9_-]{64}\\n$"
const P1WorkspaceSourceDirectory = ".ubitech"
const P1WorkspaceTargetDirectory = ".agent-platform"
const P1WorkspaceNamespaceRequired = true
const P1WorkspaceNamespaceMode = 493
const P1WorkspaceRootOwnedMountPath = "attachments"
const P1WorkspaceRootOwnedMountMode = 493
const P1WorkspaceRootOwnedUID = 0
const P1WorkspaceRootOwnedGID = 0
const P1CamofoxHomePath = "data/runtimes/camofox/home"
const P1CamofoxHomeMode = 493
const P1ManagerMigrationPath = "manager/migration.json"
const P1ManagerMigrationMode = 384
const P1ManagerMigrationSchema = 1
const P1ManagerMigrationStatus = "purged"
const P1ManagerRetirementStatus = "completed"
const P1ManagerLegacyIDPattern = "^legacy-[0-9a-f]{16}$"
const P1ManagerOperationIDPattern = "^op_[0-9a-f]{32}$"
const P1ManagerCommitPattern = "^[0-9a-f]{40}$"
const P1ManagerCampaignPattern = "^source-v1-retirement-[0-9]{4}-[0-9]{2}$"
const P1FirecrawlEnvironmentPath = "data/runtimes/firecrawl/.env"
const P1FirecrawlEnvironmentMode = 384
const P1FirecrawlBullAuthPattern = "^[A-Za-z0-9_-]{32}$"

var P1CamofoxHomeTopLevelEntries = []string{".cache", ".camoufox", "Downloads", "camoufox"}
var P1CamofoxHomeAllowedSymlinks = map[string]string{
	".cache/camoufox/camofox-bin":     "/opt/camofox/browser/camoufox",
	".cache/camoufox/fontconfig":      "/opt/camofox/browser/fontconfig",
	".cache/camoufox/properties.json": "/opt/camofox/browser/properties.json",
}
var P1ManagerMigrationFields = []string{"created_at", "expected_source_commit", "id", "operation_id", "retirement", "schema_version", "status", "updated_at"}
var P1ManagerRetirementFields = []string{"campaign_id", "completed_at", "docker_removed", "generation_id", "recovery_removed", "source_state_removed", "started_at", "status", "systemd_removed"}
var P1FirecrawlEnvironmentKeys = []string{"BULL_AUTH_KEY", "HOST", "PORT", "USE_DB_AUTHENTICATION"}
var P1FirecrawlEnvironmentLiteralValues = map[string]string{
	"HOST":                  "\"0.0.0.0\"",
	"PORT":                  "\"127.0.0.1:3002\"",
	"USE_DB_AUTHENTICATION": "\"false\"",
}

var ExecutionTargets = []string{"sandbox", "host"}
var PublicUpdateStates = []string{"idle", "waiting_for_tasks", "updating", "failed"}
var Operations = []string{"install", "update", "restart", "rollback", "repair"}
var OperationPhases = []string{"validating", "pulling", "preparing", "draining", "snapshotting", "migrating", "starting", "probing", "committing", "rolling_back"}
