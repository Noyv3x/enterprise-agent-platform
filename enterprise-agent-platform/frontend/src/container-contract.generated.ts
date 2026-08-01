// Generated from docs/contracts/container-platform.json by scripts/docs_sync.py; do not edit.
export const CONTAINER_PLATFORM_SCHEMA_VERSION = 2 as const;
export const RELEASE_CHANNEL = "main" as const;
export const DATABASE_SCHEMA_VERSION = 2026072901 as const;
export const CONTAINER_PATHS = {
  "data_root": "/var/lib/agent-platform",
  "workspace": "/workspace",
  "agent_home": "/home/agent",
  "agent_env": "/opt/agent-env"
} as const;
export const EXECUTION_TARGETS = ["sandbox", "host"] as const;
export type ExecutionTarget = (typeof EXECUTION_TARGETS)[number];
export const PERSISTENT_DATA_OWNERS = {
  "cognee": [],
  "searxng": [],
  "firecrawl-redis": [
    {
      "uid": 999,
      "gid": 0
    },
    {
      "uid": 999,
      "gid": 1000
    }
  ],
  "firecrawl-rabbitmq": [
    {
      "uid": 999,
      "gid": 0
    },
    {
      "uid": 999,
      "gid": 999
    }
  ],
  "firecrawl-postgres": [
    {
      "uid": 999,
      "gid": 0
    },
    {
      "uid": 999,
      "gid": 999
    }
  ]
} as const;
export const SANDBOX_IDLE_SECONDS = 1800 as const;
export const MIGRATION_BACKUP_RETENTION_SECONDS = 604800 as const;
export const OBSOLETE_ARTIFACT_RETENTION_SECONDS = 3600 as const;
export const UPDATE_PRE_DOWNLOAD_MIN_FREE_BYTES = 8589934592 as const;
export const UPDATE_PRE_CUTOVER_MIN_FREE_BYTES = 2147483648 as const;
export const UPDATE_MIN_FREE_INODES = 4096 as const;
export const MANAGED_IMAGE_CAPACITY_ESTIMATES = {
  "agent-sandbox": {
    "compressed_bytes": 4294967296,
    "unpacked_bytes": 8589934592
  },
  "platform": {
    "compressed_bytes": 8589934592,
    "unpacked_bytes": 17179869184
  },
  "agent-runtime": {
    "compressed_bytes": 4294967296,
    "unpacked_bytes": 8589934592
  },
  "camofox": {
    "compressed_bytes": 4294967296,
    "unpacked_bytes": 8589934592
  },
  "searxng": {
    "compressed_bytes": 2147483648,
    "unpacked_bytes": 4294967296
  },
  "firecrawl-api": {
    "compressed_bytes": 8589934592,
    "unpacked_bytes": 17179869184
  },
  "firecrawl-playwright": {
    "compressed_bytes": 8589934592,
    "unpacked_bytes": 17179869184
  },
  "firecrawl-postgres": {
    "compressed_bytes": 2147483648,
    "unpacked_bytes": 4294967296
  },
  "firecrawl-redis": {
    "compressed_bytes": 1073741824,
    "unpacked_bytes": 2147483648
  },
  "firecrawl-rabbitmq": {
    "compressed_bytes": 1073741824,
    "unpacked_bytes": 2147483648
  }
} as const;
export const PUBLIC_UPDATE_STATES = ["idle", "waiting_for_tasks", "updating", "failed"] as const;
export type PublicUpdateState = (typeof PUBLIC_UPDATE_STATES)[number];
export const MANAGER_OPERATIONS = ["install", "update", "restart", "rollback", "repair"] as const;
export type ManagerOperation = (typeof MANAGER_OPERATIONS)[number];
export const MANAGER_OPERATION_PHASES = ["validating", "pulling", "preparing", "draining", "snapshotting", "migrating", "starting", "probing", "committing", "rolling_back"] as const;
export type ManagerOperationPhase = (typeof MANAGER_OPERATION_PHASES)[number];
