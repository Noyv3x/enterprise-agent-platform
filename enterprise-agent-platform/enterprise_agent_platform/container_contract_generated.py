# Generated from docs/contracts/container-platform.json by scripts/docs_sync.py; do not edit.
from __future__ import annotations

CONTAINER_PLATFORM_SCHEMA_VERSION = 2
RELEASE_CHANNEL = 'main'
DATABASE_SCHEMA_VERSION = 2026082901
CONTAINER_PATHS = {'data_root': '/var/lib/agent-platform', 'workspace': '/workspace', 'agent_home': '/home/agent', 'agent_env': '/opt/agent-env'}
EXECUTION_TARGETS = ('sandbox', 'host')
PERSISTENT_DATA_OWNERS = {'searxng': [], 'firecrawl-redis': [{'uid': 999, 'gid': 0}, {'uid': 999, 'gid': 1000}], 'firecrawl-rabbitmq': [{'uid': 999, 'gid': 0}, {'uid': 999, 'gid': 999}], 'firecrawl-postgres': [{'uid': 999, 'gid': 0}, {'uid': 999, 'gid': 999}]}
SANDBOX_IDLE_SECONDS = 1800
MIGRATION_BACKUP_RETENTION_SECONDS = 604800
OBSOLETE_ARTIFACT_RETENTION_SECONDS = 3600
UPDATE_PRE_DOWNLOAD_MIN_FREE_BYTES = 8589934592
UPDATE_PRE_CUTOVER_MIN_FREE_BYTES = 2147483648
UPDATE_MIN_FREE_INODES = 4096
MANAGED_IMAGE_CAPACITY_ESTIMATES = {'agent-sandbox': {'compressed_bytes': 4294967296, 'unpacked_bytes': 8589934592}, 'platform': {'compressed_bytes': 8589934592, 'unpacked_bytes': 17179869184}, 'agent-runtime': {'compressed_bytes': 4294967296, 'unpacked_bytes': 8589934592}, 'camofox': {'compressed_bytes': 4294967296, 'unpacked_bytes': 8589934592}, 'searxng': {'compressed_bytes': 2147483648, 'unpacked_bytes': 4294967296}, 'firecrawl-api': {'compressed_bytes': 8589934592, 'unpacked_bytes': 17179869184}, 'firecrawl-playwright': {'compressed_bytes': 8589934592, 'unpacked_bytes': 17179869184}, 'firecrawl-postgres': {'compressed_bytes': 2147483648, 'unpacked_bytes': 4294967296}, 'firecrawl-redis': {'compressed_bytes': 1073741824, 'unpacked_bytes': 2147483648}, 'firecrawl-rabbitmq': {'compressed_bytes': 1073741824, 'unpacked_bytes': 2147483648}}
PUBLIC_UPDATE_STATES = ('idle', 'waiting_for_tasks', 'updating', 'failed')
MANAGER_OPERATIONS = ('install', 'update', 'restart', 'rollback', 'repair')
MANAGER_OPERATION_PHASES = ('validating', 'pulling', 'preparing', 'draining', 'snapshotting', 'migrating', 'starting', 'probing', 'committing', 'rolling_back')
