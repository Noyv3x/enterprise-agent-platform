"""SQLite schema and ordered forward migrations.

The schema block is idempotent and describes the live tables. Migrations are an
ordered, version-gated list recorded in ``schema_migrations``; each runs once,
inside the same transaction and lock as the schema block, on every ``migrate``.
"""
from __future__ import annotations

import fcntl
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


_SCHEMA = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    position TEXT NOT NULL DEFAULT '',
    permission_group TEXT NOT NULL DEFAULT 'member',
    model_name TEXT NOT NULL DEFAULT '',
    thinking_depth TEXT NOT NULL DEFAULT 'medium',
    timezone TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    token_version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id),
    created_at INTEGER NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_type TEXT NOT NULL CHECK(scope_type IN ('channel', 'private')),
    scope_id TEXT NOT NULL,
    author_type TEXT NOT NULL CHECK(author_type IN ('user', 'agent', 'system')),
    user_id INTEGER REFERENCES users(id),
    username TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    hidden_at INTEGER,
    hidden_by_user_id INTEGER REFERENCES users(id),
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_scope ON messages(scope_type, scope_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_visible_scope
    ON messages(scope_type, scope_id, hidden_at, id);

CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    scope_type TEXT NOT NULL CHECK(scope_type IN ('channel', 'private')),
    scope_id TEXT NOT NULL,
    uploader_user_id INTEGER REFERENCES users(id),
    source TEXT NOT NULL DEFAULT 'upload'
        CHECK(source IN ('upload', 'agent_generated')),
    filename TEXT NOT NULL,
    storage_path TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id, id);
CREATE INDEX IF NOT EXISTS idx_attachments_scope ON attachments(scope_type, scope_id, id);

CREATE TABLE IF NOT EXISTS token_usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL DEFAULT '',
    scope_type TEXT NOT NULL CHECK(scope_type IN ('channel', 'private')),
    scope_id TEXT NOT NULL,
    scope_name TEXT NOT NULL DEFAULT '',
    request_message_id INTEGER,
    response_message_id INTEGER,
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    raw_usage_json TEXT NOT NULL DEFAULT '{}',
    degraded INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_token_usage_user_time ON token_usage_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_scope_time ON token_usage_events(scope_type, scope_id, created_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_model_time ON token_usage_events(provider, model, created_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_created_at ON token_usage_events(created_at);

CREATE TABLE IF NOT EXISTS agent_scopes (
    scope_key TEXT PRIMARY KEY,
    scope_type TEXT NOT NULL CHECK(scope_type IN ('channel', 'private')),
    scope_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    lifecycle_id TEXT NOT NULL DEFAULT '',
    workspace_path TEXT NOT NULL,
    sandbox_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(scope_type, scope_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_scopes_type_id
    ON agent_scopes(scope_type, scope_id);


CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    secret INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS durable_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    scope_type TEXT NOT NULL DEFAULT '',
    scope_id TEXT NOT NULL DEFAULT '',
    dedupe_key TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK(status IN ('queued', 'running', 'succeeded', 'failed', 'needs_review')),
    attempts INTEGER NOT NULL DEFAULT 0,
    available_at INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(kind, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_durable_jobs_ready
    ON durable_jobs(kind, status, available_at, id);
CREATE INDEX IF NOT EXISTS idx_durable_jobs_scope
    ON durable_jobs(scope_type, scope_id, id);

CREATE TABLE IF NOT EXISTS agent_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    schedule_json TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    delivery TEXT NOT NULL DEFAULT 'chat'
        CHECK(delivery IN ('chat', 'chat_and_telegram')),
    state TEXT NOT NULL DEFAULT 'active'
        CHECK(state IN ('active', 'paused', 'completed')),
    enabled INTEGER NOT NULL DEFAULT 1,
    next_run_at INTEGER,
    last_run_id INTEGER,
    revision INTEGER NOT NULL DEFAULT 1,
    retry_after INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_schedules_due
    ON agent_schedules(enabled, next_run_at, id);
CREATE INDEX IF NOT EXISTS idx_agent_schedules_owner
    ON agent_schedules(owner_user_id, deleted_at, id);

CREATE TABLE IF NOT EXISTS agent_schedule_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id INTEGER NOT NULL REFERENCES agent_schedules(id) ON DELETE CASCADE,
    schedule_revision INTEGER NOT NULL DEFAULT 1,
    occurrence_key TEXT,
    scheduled_for INTEGER NOT NULL,
    trigger TEXT NOT NULL DEFAULT 'scheduled'
        CHECK(trigger IN ('scheduled', 'manual')),
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK(status IN ('queued', 'running', 'succeeded', 'failed',
                         'needs_review', 'blocked', 'skipped', 'cancelled')),
    durable_job_id INTEGER REFERENCES durable_jobs(id),
    source_message_id INTEGER REFERENCES messages(id),
    response_message_id INTEGER REFERENCES messages(id),
    started_at INTEGER,
    finished_at INTEGER,
    error TEXT NOT NULL DEFAULT '',
    delivery_warning TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(schedule_id, schedule_revision, occurrence_key)
);
CREATE INDEX IF NOT EXISTS idx_agent_schedule_runs_schedule
    ON agent_schedule_runs(schedule_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_agent_schedule_runs_job
    ON agent_schedule_runs(durable_job_id);

INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
    VALUES (
        2026082901,
        'agent-platform-container-baseline-v1',
        CAST(strftime('%s', 'now') AS INTEGER)
    );

CREATE TABLE IF NOT EXISTS chat_conversations(
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL, model_id TEXT NOT NULL, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_user ON chat_conversations(user_id, updated_at);
CREATE TABLE IF NOT EXISTS chat_messages(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES chat_conversations(id),
    role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
    content TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages(conversation_id, id);
CREATE TABLE IF NOT EXISTS chat_model_policies(
    user_id INTEGER PRIMARY KEY REFERENCES users(id), allowed_models_json TEXT NOT NULL,
    default_model_id TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chat_attachments(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES chat_conversations(id),
    message_id INTEGER REFERENCES chat_messages(id), uploader_user_id INTEGER REFERENCES users(id),
    source TEXT NOT NULL DEFAULT 'upload' CHECK(source IN ('upload','agent_generated')),
    filename TEXT NOT NULL, storage_path TEXT NOT NULL UNIQUE, mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_chat_attachments_message ON chat_attachments(message_id, id);
CREATE TABLE IF NOT EXISTS pending_attachments(
    id INTEGER PRIMARY KEY, message_id INTEGER,
    scope_type TEXT NOT NULL CHECK(scope_type IN ('private','channel')), scope_id TEXT NOT NULL,
    uploader_user_id INTEGER REFERENCES users(id),
    source TEXT NOT NULL DEFAULT 'upload' CHECK(source IN ('upload','agent_generated')),
    filename TEXT NOT NULL, storage_path TEXT NOT NULL UNIQUE, mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS queue_sessions(scope_key TEXT PRIMARY KEY, sid TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS queue_events(
    id INTEGER PRIMARY KEY AUTOINCREMENT, scope_key TEXT NOT NULL,
    event_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_queue_events_scope ON queue_events(scope_key, id);
"""

_FTS_TRIGGERS = ('agent_memory_ai', 'agent_memory_ad', 'agent_memory_au',
                 'message_fts_ai', 'message_fts_ad', 'message_fts_au',
                 'message_fts_trigram_ai', 'message_fts_trigram_ad', 'message_fts_trigram_au',
                 'conversation_revision_ai', 'conversation_revision_hidden_au',
                 'conversation_revision_metadata_au', 'conversation_revision_ad')
_DEAD_TABLES = ('message_fts_trigram', 'message_fts', 'agent_memory_fts',
                'agent_run_inputs', 'agent_runtime_scope_sessions', 'agent_runtime_scopes',
                'agent_memories', 'conversation_revisions', 'external_identities',
                'telegram_link_challenges', 'telegram_updates',
                'mail_account_credentials', 'mail_accounts')

# (version, name, statements). Append only; versions must increase.
_MIGRATIONS = (
    (2026100101, 'drop-pre-pi-rollback-compat', (
        *(f'DROP TRIGGER IF EXISTS {name}' for name in _FTS_TRIGGERS),
        *(f'DROP TABLE IF EXISTS {name}' for name in _DEAD_TABLES),
        "DELETE FROM durable_jobs WHERE kind != 'agent'",
        "DELETE FROM settings WHERE key='durable_agent_jobs_start_message_id'",
        'DROP TABLE IF EXISTS pi_schema_migrations',
    )),
)


class _Connection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


class Database:
    def __init__(self, path: Path):
        self.path = Path(path)

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=30, factory=_Connection)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def schema_version(self) -> int:
        with self.connect() as conn:
            return conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0]

    def migrate(self, data_dir: Path) -> None:
        data_dir = Path(data_dir)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data_dir.mkdir(parents=True, exist_ok=True)
        # Concurrent starts serialize here; the schema block and every pending
        # migration commit together or not at all.
        with (data_dir / '.pi-migration.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            with self.connect() as conn:
                conn.execute("PRAGMA journal_mode=WAL")
                conn.executescript("BEGIN IMMEDIATE;\n" + _SCHEMA)
                for version, name, statements in _MIGRATIONS:
                    if conn.execute("SELECT 1 FROM schema_migrations WHERE version=?", (version,)).fetchone():
                        continue
                    for statement in statements:
                        conn.execute(statement)
                    conn.execute("INSERT INTO schema_migrations(version,name,applied_at) "
                                 "VALUES (?,?,CAST(strftime('%s','now') AS INTEGER))", (version, name))
                conn.commit()
