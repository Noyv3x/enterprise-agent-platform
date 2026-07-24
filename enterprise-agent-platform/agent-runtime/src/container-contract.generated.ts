// Generated from docs/contracts/container-platform.json by scripts/docs_sync.py; do not edit.
export const CONTAINER_PLATFORM_SCHEMA_VERSION = 1 as const;
export const RELEASE_CHANNEL = "main" as const;
export const DATABASE_SCHEMA_VERSION = 2026072402 as const;
export const CONTAINER_PATHS = {
  "data_root": "/var/lib/ubitech-agent",
  "workspace": "/workspace",
  "agent_home": "/home/agent",
  "agent_env": "/opt/agent-env"
} as const;
export const EXECUTION_TARGETS = ["sandbox", "host"] as const;
export type ExecutionTarget = (typeof EXECUTION_TARGETS)[number];
export const SANDBOX_IDLE_SECONDS = 1800 as const;
export const MIGRATION_BACKUP_RETENTION_SECONDS = 604800 as const;
export const PUBLIC_UPDATE_STATES = ["idle", "waiting_for_tasks", "updating", "failed"] as const;
export type PublicUpdateState = (typeof PUBLIC_UPDATE_STATES)[number];
export const MANAGER_OPERATIONS = ["install", "update", "restart", "rollback", "repair"] as const;
export type ManagerOperation = (typeof MANAGER_OPERATIONS)[number];
export const MANAGER_OPERATION_PHASES = ["validating", "pulling", "preparing", "draining", "snapshotting", "migrating", "starting", "probing", "committing", "rolling_back"] as const;
export type ManagerOperationPhase = (typeof MANAGER_OPERATION_PHASES)[number];
