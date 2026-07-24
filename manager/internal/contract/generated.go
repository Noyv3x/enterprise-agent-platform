// Code generated from docs/contracts/container-platform.json by scripts/docs_sync.py; DO NOT EDIT.
package contract

const (
	SchemaVersion                   = 1
	ReleaseChannel                  = "main"
	DatabaseSchemaVersion           = 2026072401
	ContainerDataRoot               = "/var/lib/ubitech-agent"
	ContainerWorkspace              = "/workspace"
	ContainerAgentHome              = "/home/agent"
	ContainerAgentEnv               = "/opt/agent-env"
	SandboxIdleSeconds              = 1800
	MigrationBackupRetentionSeconds = 604800
)

var ExecutionTargets = []string{"sandbox", "host"}
var PublicUpdateStates = []string{"idle", "waiting_for_tasks", "updating", "failed"}
var Operations = []string{"install", "update", "restart", "rollback", "repair"}
var OperationPhases = []string{"validating", "pulling", "preparing", "draining", "snapshotting", "migrating", "starting", "probing", "committing", "rolling_back"}
