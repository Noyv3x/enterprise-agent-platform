"""SQLite schema and ordered forward migrations.

The schema block is idempotent and describes the live tables. Migrations are an
ordered, version-gated list recorded in ``schema_migrations``; each runs once,
inside the same transaction and lock as the schema block, on every ``migrate``.
"""
from __future__ import annotations

import fcntl
import json
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
    model_policy TEXT NOT NULL DEFAULT 'default',
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
    title TEXT NOT NULL, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_user ON chat_conversations(user_id, updated_at);
CREATE TABLE IF NOT EXISTS chat_messages(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES chat_conversations(id),
    role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
    content TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages(conversation_id, id);
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


def _chat_model_follows_personal_ai(conn: sqlite3.Connection) -> None:
    """Keep each administrator's explicit chat default; drop the per-conversation model and allowed-list policy."""
    def columns(table):
        return {row[1] for row in conn.execute(f'PRAGMA table_info({table})')}
    if 'chat_model_name' not in columns('users'):
        conn.execute("ALTER TABLE users ADD COLUMN chat_model_name TEXT NOT NULL DEFAULT ''")
    if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_model_policies'").fetchone():
        conn.execute("UPDATE users SET chat_model_name=(SELECT default_model_id FROM chat_model_policies WHERE user_id=users.id) "
                     "WHERE id IN (SELECT user_id FROM chat_model_policies WHERE default_model_id!='')")
        conn.execute('DROP TABLE chat_model_policies')
    if 'model_id' in columns('chat_conversations'):
        conn.execute('ALTER TABLE chat_conversations DROP COLUMN model_id')


MODEL_SLOTS = ('personal', 'channel', 'chat', 'scout', 'worker')
THINKING_DEPTHS = ('off', 'minimal', 'low', 'medium', 'high', 'xhigh')


def _model_policy_groups(conn: sqlite3.Connection) -> None:
    """Replace per-account model/thinking columns with the `default` model policy group every account joins.

    The group is seeded from the lowest-id active administrator (else the lowest-id account);
    with no accounts, every model is the system default and every depth `medium`.
    """
    columns = {row[1] for row in conn.execute('PRAGMA table_info(users)')}
    if 'model_policy' not in columns:
        conn.execute("ALTER TABLE users ADD COLUMN model_policy TEXT NOT NULL DEFAULT 'default'")
    source = None
    if {'model_name', 'chat_model_name', 'thinking_depth'} <= columns:
        source = (conn.execute("SELECT model_name,chat_model_name,thinking_depth FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1").fetchone()
                  or conn.execute('SELECT model_name,chat_model_name,thinking_depth FROM users ORDER BY id LIMIT 1').fetchone())
    model, chat_model, thinking = (source['model_name'], source['chat_model_name'], source['thinking_depth']) if source else ('', '', 'medium')
    thinking = 'off' if thinking == 'none' else thinking if thinking in THINKING_DEPTHS else 'medium'
    chat_model = chat_model or model
    slots = {'personal': model, 'channel': model, 'chat': chat_model, 'scout': chat_model, 'worker': model}
    policies = [{'name': 'default', 'label': '默认', 'slots': {slot: {'model': slots[slot], 'thinking': thinking} for slot in MODEL_SLOTS}}]
    conn.execute("INSERT OR IGNORE INTO settings(key,value,secret,updated_at) VALUES('model_policies_v1',?,0,CAST(strftime('%s','now') AS INTEGER))",
                 (json.dumps(policies, ensure_ascii=False),))
    conn.execute("UPDATE users SET model_policy='default'")
    for column in ('model_name', 'chat_model_name', 'thinking_depth'):
        if column in columns:
            conn.execute(f'ALTER TABLE users DROP COLUMN {column}')


# (version, name, SQL statements or a callable taking the open connection). Append only; versions must increase.
_MIGRATIONS = (
    (2026100101, 'drop-pre-pi-rollback-compat', (
        *(f'DROP TRIGGER IF EXISTS {name}' for name in _FTS_TRIGGERS),
        *(f'DROP TABLE IF EXISTS {name}' for name in _DEAD_TABLES),
        "DELETE FROM durable_jobs WHERE kind != 'agent'",
        "DELETE FROM settings WHERE key='durable_agent_jobs_start_message_id'",
        'DROP TABLE IF EXISTS pi_schema_migrations',
    )),
    (2026100201, 'chat-model-follows-personal-ai', _chat_model_follows_personal_ai),
    (2026101101, 'background-tasks', (
        """CREATE TABLE IF NOT EXISTS background_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK(kind IN ('process', 'agent')),
    external_id TEXT UNIQUE,
    name TEXT,
    label TEXT NOT NULL DEFAULT '',
    agent_type TEXT CHECK(agent_type IS NULL OR agent_type IN ('scout', 'task')),
    prompt TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'running'
        CHECK(status IN ('running', 'completed', 'failed', 'stopped', 'interrupted')),
    reason TEXT NOT NULL DEFAULT '',
    exit_code INTEGER,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    result TEXT NOT NULL DEFAULT '' CHECK(length(CAST(result AS BLOB)) <= 65536),
    work_json TEXT,
    usage_json TEXT,
    created_by_message_id INTEGER,
    created_by_tool_call_id TEXT,
    run_job_id INTEGER,
    delivered_at INTEGER,
    notice_job_id INTEGER,
    updated_at INTEGER NOT NULL
)""",
        'CREATE INDEX IF NOT EXISTS idx_background_tasks_user ON background_tasks(user_id, status, id)',
        'CREATE INDEX IF NOT EXISTS idx_background_tasks_undelivered ON background_tasks(status, delivered_at, notice_job_id)',
    )),
    (2026101201, 'model-policy-groups', _model_policy_groups),
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
                    if callable(statements):
                        statements(conn)
                    else:
                        for statement in statements:
                            conn.execute(statement)
                    conn.execute("INSERT INTO schema_migrations(version,name,applied_at) "
                                 "VALUES (?,?,CAST(strftime('%s','now') AS INTEGER))", (version, name))
                conn.commit()
