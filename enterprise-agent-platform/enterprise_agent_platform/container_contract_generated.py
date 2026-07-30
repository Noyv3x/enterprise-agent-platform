# Generated from docs/contracts/container-platform.json by scripts/docs_sync.py; do not edit.
from __future__ import annotations

CONTAINER_PLATFORM_SCHEMA_VERSION = 1
RELEASE_CHANNEL = 'main'
DATABASE_SCHEMA_VERSION = 2026072901
CONTAINER_PATHS = {'data_root': '/var/lib/ubitech-agent', 'workspace': '/workspace', 'agent_home': '/home/agent', 'agent_env': '/opt/agent-env'}
EXECUTION_TARGETS = ('sandbox', 'host')
SANDBOX_IDLE_SECONDS = 1800
MIGRATION_BACKUP_RETENTION_SECONDS = 604800
OBSOLETE_ARTIFACT_RETENTION_SECONDS = 3600
UPDATE_PRE_DOWNLOAD_MIN_FREE_BYTES = 8589934592
UPDATE_PRE_CUTOVER_MIN_FREE_BYTES = 2147483648
UPDATE_MIN_FREE_INODES = 4096
UPDATE_CORE_IMAGE_CAPACITY_ESTIMATES = {'platform': {'compressed_bytes': 8589934592, 'unpacked_bytes': 17179869184}, 'agent-runtime': {'compressed_bytes': 4294967296, 'unpacked_bytes': 8589934592}}
PUBLIC_UPDATE_STATES = ('idle', 'waiting_for_tasks', 'updating', 'failed')
MANAGER_OPERATIONS = ('install', 'update', 'restart', 'rollback', 'repair')
MANAGER_OPERATION_PHASES = ('validating', 'pulling', 'preparing', 'draining', 'snapshotting', 'migrating', 'starting', 'probing', 'committing', 'rolling_back')
