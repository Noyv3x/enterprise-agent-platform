"""Additive SQLite schema and one-time Pi resource exports.

Legacy declarations are a data-format contract, not a legacy execution engine.
The previous release rejects newer schema_migrations versions, so Pi additions
have their own ledger. Never change the legacy shapes or rewrite old rows.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import logging
import os
import sqlite3
import secrets
import stat
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


_LEGACY_SCHEMA = """




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

CREATE TABLE IF NOT EXISTS conversation_revisions (
    scope_type TEXT NOT NULL CHECK(scope_type IN ('channel', 'private')),
    scope_id TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    reset_revision INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(scope_type, scope_id)
);

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

-- Runtime session state is separate from logical scope metadata:
-- workspaces remain stable while a conversation lifecycle can be
-- rotated independently.
CREATE TABLE IF NOT EXISTS agent_runtime_scopes (
    scope_key TEXT PRIMARY KEY REFERENCES agent_scopes(scope_key) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    lifecycle_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_runtime_scope_sessions (
    scope_key TEXT NOT NULL REFERENCES agent_runtime_scopes(scope_key) ON DELETE CASCADE,
    lifecycle_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(scope_key, lifecycle_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_runtime_scope_sessions_lookup
    ON agent_runtime_scope_sessions(scope_key, lifecycle_id, session_id);

CREATE TABLE IF NOT EXISTS agent_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_key TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT 'memory' CHECK(target IN ('memory', 'user')),
    owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    tags_json TEXT NOT NULL DEFAULT '[]',
    source_type TEXT NOT NULL DEFAULT 'manual'
        CHECK(source_type IN ('manual', 'automatic')),
    source_run_id TEXT NOT NULL DEFAULT '',
    source_message_id TEXT NOT NULL DEFAULT '',
    content_hash TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_memories_scope
    ON agent_memories(scope_key, target, owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_memories_content_hash
    ON agent_memories(scope_key, target, owner_user_id, content_hash);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_memories_dedupe
    ON agent_memories(
        scope_key, target, COALESCE(owner_user_id, 0), content_hash
    )
    WHERE content_hash != '';

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    secret INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS external_identities (
    provider TEXT NOT NULL,
    external_id TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(provider, external_id)
);
CREATE INDEX IF NOT EXISTS idx_external_identities_user ON external_identities(user_id);

CREATE TABLE IF NOT EXISTS telegram_link_challenges (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telegram_link_challenges_expiry
    ON telegram_link_challenges(expires_at);

CREATE TABLE IF NOT EXISTS telegram_updates (
    update_id INTEGER PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK(status IN ('queued', 'processing', 'succeeded', 'failed', 'ignored')),
    received_at INTEGER NOT NULL,
    processed_at INTEGER,
    last_error TEXT NOT NULL DEFAULT '',
    result_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_telegram_updates_status
    ON telegram_updates(status, update_id);

CREATE TABLE IF NOT EXISTS mail_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    email_address TEXT NOT NULL,
    username TEXT NOT NULL,
    imap_host TEXT NOT NULL,
    imap_port INTEGER NOT NULL CHECK(imap_port BETWEEN 1 AND 65535),
    imap_security TEXT NOT NULL CHECK(imap_security IN ('tls', 'starttls')),
    smtp_host TEXT NOT NULL,
    smtp_port INTEGER NOT NULL CHECK(smtp_port BETWEEN 1 AND 65535),
    smtp_security TEXT NOT NULL CHECK(smtp_security IN ('tls', 'starttls')),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
    wake_enabled INTEGER NOT NULL DEFAULT 0 CHECK(wake_enabled IN (0, 1)),
    wake_folder TEXT NOT NULL DEFAULT 'INBOX',
    poll_interval_seconds INTEGER NOT NULL DEFAULT 300
        CHECK(poll_interval_seconds BETWEEN 60 AND 3600),
    checkpoint_initialized INTEGER NOT NULL DEFAULT 0
        CHECK(checkpoint_initialized IN (0, 1)),
    uid_validity INTEGER,
    last_uid INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 1,
    last_checked_at INTEGER,
    last_error TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(owner_user_id, email_address)
);
CREATE INDEX IF NOT EXISTS idx_mail_accounts_poll
    ON mail_accounts(enabled, wake_enabled, last_checked_at, id);
CREATE INDEX IF NOT EXISTS idx_mail_accounts_owner
    ON mail_accounts(owner_user_id, id);

CREATE TABLE IF NOT EXISTS mail_account_credentials (
    account_id INTEGER PRIMARY KEY
        REFERENCES mail_accounts(id) ON DELETE CASCADE,
    password TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS agent_run_inputs (
    message_id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL UNIQUE,
    parent_job_id INTEGER NOT NULL,
    input_group_id TEXT NOT NULL,
    runtime_run_id TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL
        CHECK(state IN (
            'running', 'reserved', 'submitting', 'accepted',
            'injected', 'unconsumed', 'succeeded', 'failed',
            'needs_review'
        )),
    turn_id TEXT NOT NULL DEFAULT '',
    turn_index INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_run_inputs_group
    ON agent_run_inputs(input_group_id, message_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_inputs_parent
    ON agent_run_inputs(parent_job_id, message_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_inputs_runtime
    ON agent_run_inputs(runtime_run_id, message_id);

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
INSERT OR IGNORE INTO settings(key, value, secret, updated_at)
    VALUES (
        'durable_agent_jobs_start_message_id',
        '0',
        0,
        CAST(strftime('%s', 'now') AS INTEGER)
    );

CREATE TRIGGER IF NOT EXISTS conversation_revision_ai
AFTER INSERT ON messages BEGIN
    INSERT INTO conversation_revisions(
        scope_type, scope_id, revision, reset_revision, updated_at
    ) VALUES (
        new.scope_type, new.scope_id, 1, 0,
        CAST(strftime('%s', 'now') AS INTEGER)
    )
    ON CONFLICT(scope_type, scope_id) DO UPDATE SET
        revision = conversation_revisions.revision + 1,
        updated_at = CAST(strftime('%s', 'now') AS INTEGER);
END;

CREATE TRIGGER IF NOT EXISTS conversation_revision_hidden_au
AFTER UPDATE OF hidden_at ON messages
WHEN old.hidden_at IS NOT new.hidden_at BEGIN
    INSERT INTO conversation_revisions(
        scope_type, scope_id, revision, reset_revision, updated_at
    ) VALUES (
        new.scope_type, new.scope_id, 1, 1,
        CAST(strftime('%s', 'now') AS INTEGER)
    )
    ON CONFLICT(scope_type, scope_id) DO UPDATE SET
        revision = conversation_revisions.revision + 1,
        reset_revision = conversation_revisions.revision + 1,
        updated_at = CAST(strftime('%s', 'now') AS INTEGER);
END;

CREATE TRIGGER IF NOT EXISTS conversation_revision_metadata_au
AFTER UPDATE OF metadata_json ON messages
WHEN old.metadata_json IS NOT new.metadata_json BEGIN
    INSERT INTO conversation_revisions(
        scope_type, scope_id, revision, reset_revision, updated_at
    ) VALUES (
        new.scope_type, new.scope_id, 1, 1,
        CAST(strftime('%s', 'now') AS INTEGER)
    )
    ON CONFLICT(scope_type, scope_id) DO UPDATE SET
        revision = conversation_revisions.revision + 1,
        reset_revision = conversation_revisions.revision + 1,
        updated_at = CAST(strftime('%s', 'now') AS INTEGER);
END;

CREATE TRIGGER IF NOT EXISTS conversation_revision_ad
AFTER DELETE ON messages BEGIN
    INSERT INTO conversation_revisions(
        scope_type, scope_id, revision, reset_revision, updated_at
    ) VALUES (
        old.scope_type, old.scope_id, 1, 1,
        CAST(strftime('%s', 'now') AS INTEGER)
    )
    ON CONFLICT(scope_type, scope_id) DO UPDATE SET
        revision = conversation_revisions.revision + 1,
        reset_revision = conversation_revisions.revision + 1,
        updated_at = CAST(strftime('%s', 'now') AS INTEGER);
END;

"""

_PI_SCHEMA = """
CREATE TABLE IF NOT EXISTS pi_schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
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
        # The CLI can be retried after interruption; serialize file publication
        # as well as SQL, and publish the completion marker last.
        with (data_dir / '.pi-migration.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            with self.connect() as conn:
                conn.execute("PRAGMA journal_mode=WAL")
                conn.executescript("BEGIN IMMEDIATE;\n" + _LEGACY_SCHEMA + _PI_SCHEMA)
                self._indexes(conn)
                conn.commit()
                if conn.execute("SELECT 1 FROM pi_schema_migrations WHERE version=1").fetchone():
                    return
                self._export(conn, data_dir)
                conn.execute("INSERT INTO pi_schema_migrations VALUES(1, ?)", (now(),))

    @staticmethod
    def _indexes(conn: sqlite3.Connection) -> None:
        for table, source, columns, tokenizer in (
            ('agent_memory_fts', 'agent_memories', 'content, tags_json', ''),
            ('message_fts', 'messages', 'content', ''),
            ('message_fts_trigram', 'messages', 'content', ", tokenize='trigram'"),
        ):
            if conn.execute("SELECT 1 FROM sqlite_master WHERE name=?", (table,)).fetchone():
                continue
            conn.execute(f"CREATE VIRTUAL TABLE {table} USING fts5({columns}, "
                         f"content='{source}', content_rowid='id'{tokenizer})")
            values = ', '.join('new.' + c.strip() for c in columns.split(','))
            old = ', '.join('old.' + c.strip() for c in columns.split(','))
            prefix = 'agent_memory' if source == 'agent_memories' else table
            insert = f"INSERT INTO {table}(rowid,{columns}) VALUES(new.id,{values});"
            delete = f"INSERT INTO {table}({table},rowid,{columns}) VALUES('delete',old.id,{old});"
            for suffix, action, body in (
                ('ai', 'INSERT', insert), ('ad', 'DELETE', delete),
                ('au', 'UPDATE' if source == 'agent_memories' else 'UPDATE OF content', delete + insert),
            ):
                conn.execute(f"CREATE TRIGGER {prefix}_{suffix} AFTER {action} ON {source} BEGIN {body} END")
            conn.execute(f"INSERT INTO {table}({table}) VALUES('rebuild')")

    @staticmethod
    def _export(conn: sqlite3.Connection, root: Path) -> None:
        workspaces: dict[str, Path] = {}
        active = []
        for row in conn.execute("SELECT s.*, r.session_id AS runtime_session, "
                                "r.lifecycle_id AS runtime_lifecycle FROM agent_scopes s "
                                "LEFT JOIN agent_runtime_scopes r USING(scope_key) ORDER BY s.scope_key"):
            workspace = _workspace(root, row['scope_key'])
            workspaces[row['scope_key']] = workspace
            active.append(dict(
                sid=f"agent-{row['scope_type']}-{row['scope_id']}", scope_key=row['scope_key'],
                lifecycle_id=row['runtime_lifecycle'] if row['runtime_lifecycle'] is not None else row['lifecycle_id'],
                session_id=row['runtime_session'] if row['runtime_session'] is not None else row['session_id'],
            ))
        memories: dict[Path, list[str]] = {}
        for row in conn.execute("SELECT * FROM agent_memories ORDER BY id"):
            if row['target'] == 'user':
                if row['owner_user_id'] is None:
                    raise ValueError('user memory has no owner')
                key = f"private:{row['owner_user_id']}"
            else:
                key = row['scope_key']
            workspace = workspaces.setdefault(key, _workspace(root, key))
            memories.setdefault(workspace, []).append(row['content'])
        # This inventory survives Manager's DB-only rollback, including scopes
        # whose last memory was deleted in the restored release.
        migration = root / 'runtimes' / 'agent' / 'migration'
        with _directory(root, migration, create=True) as directory:
            previous = json.loads(_read_at(directory, 'memory-scopes.json') or '[]')
            keys = sorted(set(previous) | set(workspaces))
            for key in keys:
                workspaces.setdefault(key, _workspace(root, key))
            # Publish before any workspace so interrupted exports remain discoverable.
            _atomic(directory, 'memory-scopes.json', json.dumps(keys) + '\n')
        for workspace in workspaces.values():
            contents = memories.get(workspace, [])
            with _directory(root, workspace, create=bool(contents)) as directory:
                if directory is None:
                    continue
                existing = _read_at(directory, 'AGENTS.md') or ''
                updated = _memory_section(existing, contents)
                if updated is None:
                    _memory_conflict(root, workspace, directory, contents)
                elif updated != existing:
                    _atomic(directory, 'AGENTS.md', updated)
        for key, workspace in workspaces.items():
            with _directory(root, workspace / '.agent-platform' / 'skills') as source:
                if source is None:
                    continue
                state = root / 'agent-skill-state' / hashlib.sha256(key.encode()).hexdigest()
                for name in sorted(os.listdir(source)):
                    with _directory(root, state / name) as sidecar:
                        metadata = _read_at(sidecar, '.skill.json') if sidecar is not None else None
                    if metadata is None or json.loads(metadata).get('enabled', True):
                        continue
                    with _directory(root, workspace / '.agent-platform' / 'skills-disabled',
                                    create=True) as target:
                        if name in os.listdir(target):
                            raise FileExistsError(name)
                        # renameat moves the entry itself, never follows a swapped
                        # symlink. Both parents remain pinned throughout the move.
                        os.rename(name, name, src_dir_fd=source, dst_dir_fd=target)
                        os.fsync(source)
                        os.fsync(target)
        with _directory(root, root / 'runtimes' / 'agent' / 'migration', create=True) as directory:
            _atomic(directory, 'active-sessions.json', json.dumps(active, ensure_ascii=False, indent=2) + '\n')



def _memory_section(existing: str, contents: list[str]) -> str | None:
    """Refresh only a bounded, byte-identical migration-owned section.

    The embedded digest describes the exported body, not the whole document:
    Pi may freely add instructions before/after it. An edited body belongs to
    Pi and is left alone when the source is unchanged. Concurrent source edits
    return a conflict sentinel so the caller can publish a separate source copy.
    """
    start = '<!-- pi-memory-migration-v2 sha256='
    end = '<!-- /pi-memory-migration-v2 -->'
    body = '\n## Memory (migrated)\n\n' + '\n\n'.join(contents) + '\n'
    source_digest = hashlib.sha256(body.encode()).hexdigest()
    section = start + source_digest + ' -->' + body + end
    offset = existing.find(start)
    if offset < 0:
        if not contents:
            return existing
        return existing + '\n\n' + section + '\n'
    header_end = existing.find(' -->', offset + len(start))
    finish = existing.find(end, header_end) if header_end >= 0 else -1
    if header_end < 0 or finish < 0:
        return existing
    digest = existing[offset + len(start):header_end]
    old_body = existing[header_end + len(' -->'):finish]
    if hashlib.sha256(old_body.encode()).hexdigest() != digest:
        if source_digest != digest:
            return None
        return existing
    return existing[:offset] + (section if contents else '') + existing[finish + len(end):]


def _memory_conflict(root: Path, workspace: Path, directory: int, contents: list[str]) -> None:
    body = '## Memory (migrated source conflict)\n\n' + (
        '\n\n'.join(contents) if contents else 'The legacy source now contains no memories.'
    ) + '\n'
    digest = hashlib.sha256(body.encode()).hexdigest()
    key = workspace.relative_to(root).as_posix()
    migration = root / 'runtimes' / 'agent' / 'migration'
    with _directory(root, migration, create=True) as state:
        inventory = json.loads(_read_at(state, 'memory-conflicts.json') or '{}')
        versions = inventory.setdefault(key, {})
        filename = versions.get(digest)
        if filename is None:
            stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
            filename = f'AGENTS.migrated-conflict-{stamp}.md'
            versions[digest] = filename
            # Reserve the name first; retry after interruption reuses it.
            _atomic(state, 'memory-conflicts.json', json.dumps(inventory) + '\n')
        if Path(filename).name != filename or not filename.startswith('AGENTS.migrated-conflict-'):
            raise ValueError('Invalid memory conflict filename')
        if _read_at(directory, filename) is None:
            _atomic(directory, filename, body)
    logging.getLogger(__name__).warning(
        'Preserved Pi-edited %s; refreshed legacy memory source saved to %s',
        workspace / 'AGENTS.md', workspace / filename)

def _workspace(root: Path, key: str) -> Path:
    parts = key.split(':')
    if len(parts) == 2 and parts[0] == 'private' and parts[1].isdigit():
        return root / 'workspaces' / f'user-{parts[1]}'
    if len(parts) == 3 and parts[0] == 'channel' and parts[1].isdigit() and parts[2] == 'main-agent':
        return root / 'workspaces' / 'channels' / f'channel-{parts[1]}'
    raise ValueError(f'Invalid legacy scope key: {key}')


@contextmanager
def _directory(root: Path, path: Path, *, create: bool = False):
    """Pin every component without following tenant-controlled symlinks."""
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open(root, flags)
    try:
        for name in path.relative_to(root).parts:
            if name in ('.', '..'):
                raise ValueError('Invalid migration directory')
            if create:
                try:
                    os.mkdir(name, mode=0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            try:
                child = os.open(name, flags, dir_fd=fd)
            except FileNotFoundError:
                if create:
                    raise
                yield None
                return
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def _read_at(directory: int, name: str) -> str | None:
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, 'r') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError('Migration input is not a regular file')
        return stream.read()


def _atomic(directory: int, name: str, content: str) -> None:
    temporary = '.pi-migration-' + secrets.token_hex(16)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                 0o600, dir_fd=directory)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass
