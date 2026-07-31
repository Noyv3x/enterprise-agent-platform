// Generated from docs/contracts/container-platform.json by scripts/docs_sync.py; do not edit.
export const CONTAINER_PLATFORM_SCHEMA_VERSION = 1 as const;
export const RELEASE_CHANNEL = "main" as const;
export const DATABASE_SCHEMA_VERSION = 2026072901 as const;
export const CONTAINER_PATHS = {
  "data_root": "/var/lib/ubitech-agent",
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
export const AGENT_RUNTIME_HANDOFF = {
  "validation_limits": {
    "maximum_identity_records": 16384,
    "maximum_jsonl_bytes": 268435456,
    "maximum_jsonl_records": 1048576,
    "maximum_directory_entries": 65536
  },
  "current_roots": [
    "sessions",
    "approvals",
    "idempotency"
  ],
  "ephemeral_roots": [
    "logs"
  ],
  "p1_retired_roots": {
    "app": {
      "mode": 493,
      "top_level_entries": [
        ".gitignore",
        "README.md",
        "dist",
        "install.json",
        "node_modules",
        "package-lock.json",
        "package.json",
        "src",
        "test",
        "tsconfig.json"
      ],
      "inventory_algorithm": "runtime-retired-tree-v1",
      "inventory_sha256": "8ddfd45d49b94bb73fb06ac968c84b2e82d9a4408381401fc48c6ddca76a5a15",
      "inventory_entries": 18439,
      "inventory_regular_bytes": 89075179,
      "install_source_signature": "84c4f8be8ff7b2b9391a109cc857e7a2ac5a9f673d992522e258b715585454da",
      "package_name": "@ubitech/agent-runtime",
      "package_version": "0.1.0",
      "allowed_symlinks": {
        "node_modules/.bin/anthropic-ai-sdk": "../@anthropic-ai/sdk/bin/cli",
        "node_modules/.bin/openai": "../openai/bin/cli",
        "node_modules/.bin/pi-ai": "../@earendil-works/pi-ai/dist/cli.js",
        "node_modules/.bin/yaml": "../yaml/bin.mjs"
      }
    },
    "home": {
      "mode": 493,
      "empty": true
    },
    "memory": {
      "mode": 448,
      "empty": true
    },
    "migration": {
      "mode": 448,
      "file_name": "hermes-cutover.json",
      "file_mode": 384,
      "schema_version": 1,
      "phase": "finalized",
      "fields": [
        "attachments_skipped",
        "attachments_verified",
        "imported",
        "memories_imported",
        "memories_skipped",
        "oauth_cleared",
        "oauth_imported",
        "oauth_skipped",
        "phase",
        "session_manifests",
        "session_messages",
        "skipped",
        "updated_at",
        "version",
        "workspaces_skipped",
        "workspaces_verified"
      ]
    }
  }
} as const;
export const P1_SOURCE_HANDOFF = {
  "layouts": {
    ".": {
      "mode": 448,
      "entries": {
        "backups": {
          "type": "directory",
          "disposition": "retired",
          "mode": 448,
          "required": true
        },
        "data": {
          "type": "directory",
          "disposition": "retained",
          "mode": 448,
          "required": true
        },
        "manager": {
          "type": "directory",
          "disposition": "retained",
          "mode": 448,
          "required": true
        }
      }
    },
    "data": {
      "mode": 448,
      "entries": {
        ".enterprise-platform.lock": {
          "type": "file",
          "disposition": "generated",
          "mode": 384,
          "required": true
        },
        ".home": {
          "type": "directory",
          "disposition": "generated",
          "mode": 493,
          "required": true
        },
        "agent-envs": {
          "type": "directory",
          "disposition": "copied",
          "mode": 448,
          "required": true
        },
        "agent-skills": {
          "type": "directory",
          "disposition": "copied",
          "mode": 448,
          "required": true
        },
        "attachments": {
          "type": "directory",
          "disposition": "copied",
          "mode": 448,
          "required": true
        },
        "bootstrap-admin-password.txt": {
          "type": "file",
          "disposition": "copied",
          "mode": 384,
          "required": false
        },
        "logs": {
          "type": "directory",
          "disposition": "generated",
          "mode": 448,
          "required": false
        },
        "platform.db": {
          "type": "file",
          "disposition": "retained",
          "mode": 384,
          "required": true
        },
        "platform.db-shm": {
          "type": "file",
          "disposition": "generated",
          "mode": 384,
          "required": false
        },
        "platform.db-wal": {
          "type": "file",
          "disposition": "generated",
          "mode": 384,
          "required": false
        },
        "runtimes": {
          "type": "directory",
          "disposition": "retained",
          "mode": 448,
          "required": true
        },
        "upload-staging": {
          "type": "directory",
          "disposition": "generated",
          "mode": 448,
          "required": true
        },
        "workspaces": {
          "type": "directory",
          "disposition": "retained",
          "mode": 448,
          "required": true
        }
      }
    },
    "data/runtimes": {
      "mode": 448,
      "entries": {
        ".upstream-sources.lock": {
          "type": "file",
          "disposition": "ephemeral",
          "mode": 384,
          "required": true
        },
        "agent": {
          "type": "directory",
          "disposition": "retained",
          "mode": 448,
          "required": true
        },
        "camofox": {
          "type": "directory",
          "disposition": "retained",
          "mode": 448,
          "required": true
        },
        "cognee": {
          "type": "directory",
          "disposition": "retained",
          "mode": 448,
          "required": true
        },
        "firecrawl": {
          "type": "directory",
          "disposition": "retained",
          "mode": 448,
          "required": true
        },
        "searxng": {
          "type": "directory",
          "disposition": "retained",
          "mode": 448,
          "required": true
        }
      }
    },
    "data/runtimes/camofox": {
      "mode": 448,
      "entries": {
        ".install.lock": {
          "type": "file",
          "disposition": "ephemeral",
          "mode": 384,
          "required": true
        },
        ".ubitech-agent-runtime.json": {
          "type": "file",
          "disposition": "retained",
          "mode": 384,
          "required": true
        },
        "access-key": {
          "type": "file",
          "disposition": "retired",
          "mode": 384,
          "required": true
        },
        "cache": {
          "type": "directory",
          "disposition": "generated",
          "mode": 448,
          "required": true
        },
        "cookies": {
          "type": "directory",
          "disposition": "copied",
          "mode": 448,
          "required": true
        },
        "home": {
          "type": "directory",
          "disposition": "generated",
          "mode": 493,
          "required": true
        },
        "logs": {
          "type": "directory",
          "disposition": "generated",
          "mode": 448,
          "required": true
        },
        "profiles": {
          "type": "directory",
          "disposition": "copied",
          "mode": 448,
          "required": true
        },
        "traces": {
          "type": "directory",
          "disposition": "copied",
          "mode": 448,
          "required": true
        }
      }
    },
    "data/runtimes/cognee": {
      "mode": 448,
      "entries": {
        "cache": {
          "type": "directory",
          "disposition": "copied",
          "mode": 493,
          "required": true
        },
        "data": {
          "type": "directory",
          "disposition": "copied",
          "mode": 493,
          "required": true
        },
        "logs": {
          "type": "directory",
          "disposition": "generated",
          "mode": 493,
          "required": true
        },
        "python-install.json": {
          "type": "file",
          "disposition": "retired",
          "mode": 384,
          "required": true
        },
        "system": {
          "type": "directory",
          "disposition": "copied",
          "mode": 493,
          "required": true
        }
      }
    },
    "data/runtimes/firecrawl": {
      "mode": 448,
      "entries": {
        ".env": {
          "type": "file",
          "disposition": "retired",
          "mode": 384,
          "required": true
        },
        "docker-compose.enterprise.yaml": {
          "type": "file",
          "disposition": "retired",
          "mode": 420,
          "required": true
        },
        "docker-compose.ubitech.yaml": {
          "type": "file",
          "disposition": "retired",
          "mode": 420,
          "required": true
        },
        "logs": {
          "type": "directory",
          "disposition": "generated",
          "mode": 448,
          "required": true
        },
        "postgres": {
          "type": "directory",
          "disposition": "copied",
          "mode": 448,
          "required": true
        },
        "rabbitmq": {
          "type": "directory",
          "disposition": "copied",
          "mode": 493,
          "required": true
        },
        "redis": {
          "type": "directory",
          "disposition": "copied",
          "mode": 493,
          "required": true
        }
      }
    },
    "data/runtimes/searxng": {
      "mode": 448,
      "entries": {
        "cache": {
          "type": "directory",
          "disposition": "copied",
          "mode": 448,
          "required": true
        },
        "config": {
          "type": "directory",
          "disposition": "copied",
          "mode": 448,
          "required": true
        },
        "docker-compose.ubitech.yaml": {
          "type": "file",
          "disposition": "retired",
          "mode": 384,
          "required": true
        },
        "logs": {
          "type": "directory",
          "disposition": "generated",
          "mode": 448,
          "required": true
        },
        "secret-key": {
          "type": "file",
          "disposition": "retired",
          "mode": 384,
          "required": true
        }
      }
    },
    "manager": {
      "mode": 448,
      "entries": {
        "active-generation": {
          "type": "file",
          "disposition": "generated",
          "mode": 384,
          "required": true
        },
        "control": {
          "type": "directory",
          "disposition": "ephemeral",
          "mode": 448,
          "required": true
        },
        "logs": {
          "type": "directory",
          "disposition": "generated",
          "mode": 448,
          "required": true
        },
        "manager-binaries": {
          "type": "directory",
          "disposition": "generated",
          "mode": 448,
          "required": true
        },
        "manager-binaries.json": {
          "type": "file",
          "disposition": "generated",
          "mode": 384,
          "required": true
        },
        "migration.json": {
          "type": "file",
          "disposition": "retired",
          "mode": 384,
          "required": true
        },
        "operations": {
          "type": "directory",
          "disposition": "generated",
          "mode": 448,
          "required": true
        },
        "processes": {
          "type": "directory",
          "disposition": "ephemeral",
          "mode": 448,
          "required": true
        },
        "releases": {
          "type": "directory",
          "disposition": "generated",
          "mode": 448,
          "required": true
        },
        "sandboxes.json": {
          "type": "file",
          "disposition": "retained",
          "mode": 384,
          "required": true
        },
        "secrets": {
          "type": "directory",
          "disposition": "copied",
          "mode": 448,
          "required": true
        },
        "state.json": {
          "type": "file",
          "disposition": "generated",
          "mode": 384,
          "required": true
        }
      }
    }
  },
  "empty_files": [
    "data/runtimes/.upstream-sources.lock",
    "data/runtimes/camofox/.install.lock"
  ],
  "empty_directories": [
    "data/.home",
    "manager/processes"
  ],
  "fixed_sha256": {
    "data/runtimes/cognee/python-install.json": "0a02646ac897273b2dfb3795c48ad5f22e76b49b0d868b15765c7925369163dc",
    "data/runtimes/firecrawl/docker-compose.enterprise.yaml": "0f7d098e886cd9c3895b477c6adcf0eb836ddfc8e1eb33def2f972c138581b5b",
    "data/runtimes/firecrawl/docker-compose.ubitech.yaml": "80e2399b34efaa238953b6ec5000d8dc4abe81f56eee0861ea83ee07d8f3f5cc",
    "data/runtimes/searxng/docker-compose.ubitech.yaml": "78fedfd5ab49918f1e6cc27acdc17a0bd99ef9918d4aeb6a55d35ee9811e181a"
  },
  "secret_files": [
    "data/runtimes/camofox/access-key",
    "data/runtimes/searxng/secret-key"
  ],
  "secret_line_pattern": "^[A-Za-z0-9_-]{64}\\n$",
  "manager_secret_names": [
    "agent-runtime-token",
    "agent-tool-token",
    "camofox-access-key",
    "firecrawl-bull-auth-key",
    "firecrawl-postgres-password",
    "manager-executor-token",
    "manager-token",
    "session-secret"
  ],
  "workspace_namespace": {
    "source_directory": ".ubitech",
    "target_directory": ".agent-platform",
    "required": true,
    "mode": 493,
    "root_owned_empty_mount": {
      "relative_path": "attachments",
      "mode": 493,
      "uid": 0,
      "gid": 0
    }
  },
  "camofox_home": {
    "path": "data/runtimes/camofox/home",
    "mode": 493,
    "top_level_entries": [
      ".cache",
      ".camoufox",
      "Downloads",
      "camoufox"
    ],
    "allowed_symlinks": {
      ".cache/camoufox/camofox-bin": "/opt/camofox/browser/camoufox",
      ".cache/camoufox/fontconfig": "/opt/camofox/browser/fontconfig",
      ".cache/camoufox/properties.json": "/opt/camofox/browser/properties.json"
    }
  },
  "manager_migration": {
    "path": "manager/migration.json",
    "mode": 384,
    "schema_version": 1,
    "status": "purged",
    "legacy_id_pattern": "^legacy-[0-9a-f]{16}$",
    "operation_id_pattern": "^op_[0-9a-f]{32}$",
    "commit_pattern": "^[0-9a-f]{40}$",
    "campaign_pattern": "^source-v1-retirement-[0-9]{4}-[0-9]{2}$",
    "fields": [
      "created_at",
      "expected_source_commit",
      "id",
      "operation_id",
      "retirement",
      "schema_version",
      "status",
      "updated_at"
    ],
    "retirement_status": "completed",
    "retirement_fields": [
      "campaign_id",
      "completed_at",
      "docker_removed",
      "generation_id",
      "recovery_removed",
      "source_state_removed",
      "started_at",
      "status",
      "systemd_removed"
    ]
  },
  "firecrawl_environment": {
    "path": "data/runtimes/firecrawl/.env",
    "mode": 384,
    "keys": [
      "BULL_AUTH_KEY",
      "HOST",
      "PORT",
      "USE_DB_AUTHENTICATION"
    ],
    "bull_auth_pattern": "^[A-Za-z0-9_-]{32}$",
    "literal_values": {
      "HOST": "\"0.0.0.0\"",
      "PORT": "\"127.0.0.1:3002\"",
      "USE_DB_AUTHENTICATION": "\"false\""
    }
  }
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
  },
  "handoff-fs-helper": {
    "compressed_bytes": 536870912,
    "unpacked_bytes": 1073741824
  }
} as const;
export const PUBLIC_UPDATE_STATES = ["idle", "waiting_for_tasks", "updating", "failed"] as const;
export type PublicUpdateState = (typeof PUBLIC_UPDATE_STATES)[number];
export const MANAGER_OPERATIONS = ["install", "update", "restart", "rollback", "repair"] as const;
export type ManagerOperation = (typeof MANAGER_OPERATIONS)[number];
export const MANAGER_OPERATION_PHASES = ["validating", "pulling", "preparing", "draining", "snapshotting", "migrating", "starting", "probing", "committing", "rolling_back"] as const;
export type ManagerOperationPhase = (typeof MANAGER_OPERATION_PHASES)[number];
