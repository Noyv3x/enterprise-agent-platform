# Generated from docs/contracts/container-platform.json by scripts/docs_sync.py; do not edit.
from __future__ import annotations

CONTAINER_PLATFORM_SCHEMA_VERSION = 1
RELEASE_CHANNEL = 'main'
DATABASE_SCHEMA_VERSION = 2026072402
CONTAINER_PATHS = {'data_root': '/var/lib/ubitech-agent', 'workspace': '/workspace', 'agent_home': '/home/agent', 'agent_env': '/opt/agent-env'}
EXECUTION_TARGETS = ('sandbox', 'host')
SANDBOX_IDLE_SECONDS = 1800
MIGRATION_BACKUP_RETENTION_SECONDS = 604800
PUBLIC_UPDATE_STATES = ('idle', 'waiting_for_tasks', 'updating', 'failed')
MANAGER_OPERATIONS = ('install', 'update', 'restart', 'rollback', 'repair')
MANAGER_OPERATION_PHASES = ('validating', 'pulling', 'preparing', 'draining', 'snapshotting', 'migrating', 'starting', 'probing', 'committing', 'rolling_back')
