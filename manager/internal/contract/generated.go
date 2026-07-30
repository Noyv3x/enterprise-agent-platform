// Code generated from docs/contracts/container-platform.json by scripts/docs_sync.py; DO NOT EDIT.
package contract

const (
	SchemaVersion                    = 1
	ReleaseChannel                   = "main"
	DatabaseSchemaVersion            = 2026072901
	ContainerDataRoot                = "/var/lib/ubitech-agent"
	ContainerWorkspace               = "/workspace"
	ContainerAgentHome               = "/home/agent"
	ContainerAgentEnv                = "/opt/agent-env"
	SandboxIdleSeconds               = 1800
	MigrationBackupRetentionSeconds  = 604800
	ObsoleteArtifactRetentionSeconds = 3600
	UpdatePreDownloadMinFreeBytes    = 8589934592
	UpdatePreCutoverMinFreeBytes     = 2147483648
	UpdateMinFreeInodes              = 4096
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
	"platform": {
		CompressedBytes: 8589934592,
		UnpackedBytes:   17179869184,
	},
	"searxng": {
		CompressedBytes: 2147483648,
		UnpackedBytes:   4294967296,
	},
}

var ExecutionTargets = []string{"sandbox", "host"}
var PublicUpdateStates = []string{"idle", "waiting_for_tasks", "updating", "failed"}
var Operations = []string{"install", "update", "restart", "rollback", "repair"}
var OperationPhases = []string{"validating", "pulling", "preparing", "draining", "snapshotting", "migrating", "starting", "probing", "committing", "rolling_back"}
