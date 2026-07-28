from __future__ import annotations

import json
import sqlite3
import threading
import time
import weakref
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Iterator

from .container_contract_generated import DATABASE_SCHEMA_VERSION
from .secure_fs import ensure_private_directory, ensure_private_file, tighten_sqlite_files


_PREVIOUS_DATABASE_BASELINE_VERSION = 2026072402
_PREVIOUS_DATABASE_BASELINE_NAME = "agent-scopes-container-sandbox-v2"
_DATABASE_BASELINE_VERSION = 2026072801
_DATABASE_BASELINE_NAME = "ubitech-agent-container-baseline-v1"
if _DATABASE_BASELINE_VERSION != DATABASE_SCHEMA_VERSION:
    raise RuntimeError("Database baseline does not match the container contract")


def now_ts() -> int:
    return int(time.time())


class _ConnectionHolder:
    """Owns one sqlite3 connection and closes it when garbage collected.

    Stored in thread-local storage so a connection is closed automatically when
    its owning thread dies (sqlite3.Connection is not weakref-able, but a plain
    holder object is, which lets the Database track live connections in a
    WeakSet without preventing that cleanup).
    """

    __slots__ = ("conn", "__weakref__")

    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn

    def close(self) -> None:
        conn, self.conn = self.conn, None
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass

    def __del__(self) -> None:
        self.close()


class Database:
    """SQLite access with one connection per thread.

    WAL mode plus a per-connection busy timeout lets reads run concurrently and
    serializes writes at the SQLite level, so no global Python lock is needed on
    the hot path (the previous single-connection + RLock design serialized every
    request and agent-worker thread platform-wide).
    """

    def __init__(self, path: Path):
        self.path = path
        ensure_private_directory(self.path.parent)
        ensure_private_file(self.path)
        self._local = threading.local()
        self._init_lock = threading.RLock()
        self._holders: "weakref.WeakSet[_ConnectionHolder]" = weakref.WeakSet()
        self._holders_lock = threading.Lock()
        self.fts_available = False
        self.message_fts_available = False
        self.message_fts_trigram_available = False
        self._closed = False
        self.init_schema()

    def _new_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.path), check_same_thread=False, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=30000")
        tighten_sqlite_files(self.path)
        return conn

    @property
    def _conn(self) -> sqlite3.Connection:
        if self._closed:
            raise sqlite3.ProgrammingError("Cannot operate on a closed database.")
        holder = getattr(self._local, "holder", None)
        # holder.conn can be None if another thread's close() ran; recreate it.
        if holder is None or holder.conn is None:
            holder = _ConnectionHolder(self._new_connection())
            self._local.holder = holder
            with self._holders_lock:
                self._holders.add(holder)
        return holder.conn

    def close(self) -> None:
        """Mark the database closed and reclaim this thread's connection.

        Callers must join every DB-touching thread (request handlers, agent
        workers, the ingest loop) BEFORE calling close(); otherwise an in-flight
        statement on another thread's connection can race a shutdown that closes
        it. To avoid that cross-thread race we only close the connection owned by
        the calling thread here. Connections owned by other threads are left to
        their _ConnectionHolder.__del__ (invoked when that thread's thread-local
        storage is torn down on thread exit), so a slow worker that has not yet
        finished keeps a valid handle until it does.
        """
        self._closed = True
        own = getattr(self._local, "holder", None)
        with self._holders_lock:
            # Drop tracking references so the holders become eligible for GC; do
            # not force-close other threads' connections out from under them.
            self._holders.clear()
        if own is not None:
            own.close()
        try:
            self._local.holder = None
        except Exception:
            pass
        tighten_sqlite_files(self.path)

    def init_schema(self) -> None:
        with self._init_lock:
            existing_tables = {
                str(row["name"])
                for row in self._conn.execute(
                    "SELECT name FROM sqlite_master "
                    "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
                ).fetchall()
            }
            fresh_database = not existing_tables
            if not fresh_database:
                self._upgrade_previous_container_baseline(existing_tables)
                self._assert_current_database_baseline(existing_tables)
            if fresh_database:
                try:
                    self._conn.executescript(
                """
                PRAGMA journal_mode=WAL;
                PRAGMA foreign_keys=ON;
                BEGIN IMMEDIATE;

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
                        CHECK(source_type IN ('manual', 'tool', 'candidate', 'imported')),
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

                CREATE TABLE IF NOT EXISTS agent_memory_candidates (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    scope_key TEXT NOT NULL,
                    target TEXT NOT NULL DEFAULT 'memory' CHECK(target IN ('memory', 'user')),
                    owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    content TEXT NOT NULL,
                    tags_json TEXT NOT NULL DEFAULT '[]',
                    dedupe_key TEXT NOT NULL UNIQUE,
                    source_run_id TEXT NOT NULL DEFAULT '',
                    source_message_id TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'pending'
                        CHECK(status IN ('pending', 'approved', 'rejected')),
                    memory_id INTEGER REFERENCES agent_memories(id) ON DELETE SET NULL,
                    created_at INTEGER NOT NULL,
                    decided_at INTEGER,
                    decided_by_user_id INTEGER REFERENCES users(id)
                );
                CREATE INDEX IF NOT EXISTS idx_agent_memory_candidates_scope
                    ON agent_memory_candidates(
                        scope_key, owner_user_id, status, created_at DESC
                    );

                CREATE TABLE IF NOT EXISTS knowledge_documents (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    content TEXT NOT NULL,
                    source TEXT NOT NULL DEFAULT '',
                    created_by INTEGER REFERENCES users(id),
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    content_hash TEXT NOT NULL DEFAULT ''
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_documents_content_hash
                    ON knowledge_documents(content_hash) WHERE content_hash != '';

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

                INSERT INTO schema_migrations(version, name, applied_at)
                    VALUES (
                        2026072801,
                        'ubitech-agent-container-baseline-v1',
                        CAST(strftime('%s', 'now') AS INTEGER)
                    );
                INSERT INTO settings(key, value, secret, updated_at)
                    VALUES (
                        'durable_agent_jobs_start_message_id',
                        '0',
                        0,
                        CAST(strftime('%s', 'now') AS INTEGER)
                    );

                CREATE TRIGGER conversation_revision_ai
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

                CREATE TRIGGER conversation_revision_hidden_au
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

                CREATE TRIGGER conversation_revision_metadata_au
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

                CREATE TRIGGER conversation_revision_ad
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
                COMMIT;
                """
                    )
                except BaseException:
                    self._conn.rollback()
                    raise
            self._ensure_fts()
            self._ensure_message_fts()
            self._assert_current_database_baseline()
            self._conn.commit()

    def _upgrade_previous_container_baseline(self, tables: set[str]) -> None:
        """Upgrade exactly one declared container baseline, or reject the DB."""

        markers = [
            (int(row["version"]), str(row["name"]))
            for row in self._conn.execute(
                "SELECT version, name FROM schema_migrations ORDER BY version"
            ).fetchall()
        ] if "schema_migrations" in tables else []
        current = [(_DATABASE_BASELINE_VERSION, _DATABASE_BASELINE_NAME)]
        if markers == current:
            return
        previous = [
            (
                _PREVIOUS_DATABASE_BASELINE_VERSION,
                _PREVIOUS_DATABASE_BASELINE_NAME,
            )
        ]
        if markers != previous:
            if not markers:
                raise sqlite3.DatabaseError(
                    "database is missing a supported baseline marker"
                )
            raise sqlite3.DatabaseError(
                "database does not match a supported baseline marker"
            )

        self._assert_database_structure(
            tables,
            current_memory_sources=False,
            previous_scope_backend=True,
        )
        unexpected_dependents = sorted(
            self._foreign_key_dependents("agent_memories")
            - {"agent_memory_candidates"}
        )
        if unexpected_dependents:
            raise sqlite3.DatabaseError(
                "database has unsupported memory dependents: "
                + ", ".join(unexpected_dependents)
            )

        memory_count = int(
            self._conn.execute("SELECT count(*) FROM agent_memories").fetchone()[0]
        )
        scope_count = int(
            self._conn.execute("SELECT count(*) FROM agent_scopes").fetchone()[0]
        )
        candidate_count = int(
            self._conn.execute(
                "SELECT count(*) FROM agent_memory_candidates"
            ).fetchone()[0]
        )
        self._conn.commit()
        self._conn.execute("PRAGMA foreign_keys=OFF")
        try:
            self._conn.executescript(
                """
                BEGIN IMMEDIATE;
                ALTER TABLE agent_scopes DROP COLUMN execution_backend;
                DROP TRIGGER IF EXISTS agent_memory_ai;
                DROP TRIGGER IF EXISTS agent_memory_ad;
                DROP TRIGGER IF EXISTS agent_memory_au;
                DROP TABLE IF EXISTS agent_memory_fts;
                DROP INDEX IF EXISTS idx_agent_memory_candidates_scope;
                DROP INDEX IF EXISTS idx_agent_memories_scope;
                DROP INDEX IF EXISTS idx_agent_memories_content_hash;
                DROP INDEX IF EXISTS uq_agent_memories_dedupe;
                ALTER TABLE agent_memory_candidates
                    RENAME TO agent_memory_candidates_baseline_source;
                ALTER TABLE agent_memories
                    RENAME TO agent_memories_baseline_source;

                CREATE TABLE agent_memories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    scope_key TEXT NOT NULL,
                    target TEXT NOT NULL DEFAULT 'memory'
                        CHECK(target IN ('memory', 'user')),
                    owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    content TEXT NOT NULL,
                    tags_json TEXT NOT NULL DEFAULT '[]',
                    source_type TEXT NOT NULL DEFAULT 'manual'
                        CHECK(source_type IN ('manual', 'tool', 'candidate', 'imported')),
                    source_run_id TEXT NOT NULL DEFAULT '',
                    source_message_id TEXT NOT NULL DEFAULT '',
                    content_hash TEXT NOT NULL DEFAULT '',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX idx_agent_memories_scope
                    ON agent_memories(
                        scope_key, target, owner_user_id, updated_at DESC
                    );
                CREATE INDEX idx_agent_memories_content_hash
                    ON agent_memories(
                        scope_key, target, owner_user_id, content_hash
                    );
                CREATE UNIQUE INDEX uq_agent_memories_dedupe
                    ON agent_memories(
                        scope_key, target, COALESCE(owner_user_id, 0), content_hash
                    )
                    WHERE content_hash != '';

                CREATE TABLE agent_memory_candidates (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    scope_key TEXT NOT NULL,
                    target TEXT NOT NULL DEFAULT 'memory'
                        CHECK(target IN ('memory', 'user')),
                    owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    content TEXT NOT NULL,
                    tags_json TEXT NOT NULL DEFAULT '[]',
                    dedupe_key TEXT NOT NULL UNIQUE,
                    source_run_id TEXT NOT NULL DEFAULT '',
                    source_message_id TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'pending'
                        CHECK(status IN ('pending', 'approved', 'rejected')),
                    memory_id INTEGER REFERENCES agent_memories(id) ON DELETE SET NULL,
                    created_at INTEGER NOT NULL,
                    decided_at INTEGER,
                    decided_by_user_id INTEGER REFERENCES users(id)
                );
                CREATE INDEX idx_agent_memory_candidates_scope
                    ON agent_memory_candidates(
                        scope_key, owner_user_id, status, created_at DESC
                    );

                INSERT INTO agent_memories(
                    id, scope_key, target, owner_user_id, content, tags_json,
                    source_type, source_run_id, source_message_id, content_hash,
                    created_at, updated_at
                )
                SELECT id, scope_key, target, owner_user_id, content, tags_json,
                       CASE
                           WHEN source_type IN ('manual', 'tool', 'candidate')
                               THEN source_type
                           ELSE 'imported'
                       END,
                       source_run_id, source_message_id, content_hash,
                       created_at, updated_at
                FROM agent_memories_baseline_source;
                INSERT INTO agent_memory_candidates(
                    id, scope_key, target, owner_user_id, content, tags_json,
                    dedupe_key, source_run_id, source_message_id, status,
                    memory_id, created_at, decided_at, decided_by_user_id
                )
                SELECT id, scope_key, target, owner_user_id, content, tags_json,
                       dedupe_key, source_run_id, source_message_id, status,
                       memory_id, created_at, decided_at, decided_by_user_id
                FROM agent_memory_candidates_baseline_source;
                DROP TABLE agent_memory_candidates_baseline_source;
                DROP TABLE agent_memories_baseline_source;
                DELETE FROM schema_migrations;
                """
            )
            if int(
                self._conn.execute("SELECT count(*) FROM agent_memories").fetchone()[0]
            ) != memory_count:
                raise sqlite3.IntegrityError(
                    "container baseline upgrade changed the memory row count"
                )
            if int(
                self._conn.execute("SELECT count(*) FROM agent_scopes").fetchone()[0]
            ) != scope_count:
                raise sqlite3.IntegrityError(
                    "container baseline upgrade changed the Agent scope row count"
                )
            if int(
                self._conn.execute(
                    "SELECT count(*) FROM agent_memory_candidates"
                ).fetchone()[0]
            ) != candidate_count:
                raise sqlite3.IntegrityError(
                    "container baseline upgrade changed the candidate row count"
                )
            violations = self._conn.execute("PRAGMA foreign_key_check").fetchall()
            if violations:
                raise sqlite3.IntegrityError(
                    "container baseline upgrade produced foreign-key violations"
                )
            self._conn.execute(
                "INSERT INTO schema_migrations(version, name, applied_at) "
                "VALUES (?, ?, ?)",
                (_DATABASE_BASELINE_VERSION, _DATABASE_BASELINE_NAME, now_ts()),
            )
            self._conn.commit()
        except BaseException:
            self._conn.rollback()
            raise
        finally:
            self._conn.execute("PRAGMA foreign_keys=ON")

    def _assert_current_database_baseline(
        self,
        existing_tables: set[str] | None = None,
    ) -> None:
        """Reject every non-empty database outside the current product baseline."""

        tables = existing_tables or self._database_tables()
        markers = [
            (int(row["version"]), str(row["name"]))
            for row in self._conn.execute(
                "SELECT version, name FROM schema_migrations ORDER BY version"
            ).fetchall()
        ] if "schema_migrations" in tables else []
        if markers != [(_DATABASE_BASELINE_VERSION, _DATABASE_BASELINE_NAME)]:
            raise sqlite3.DatabaseError(
                "database does not match the current baseline marker"
            )
        self._assert_database_structure(
            tables,
            current_memory_sources=True,
            previous_scope_backend=False,
        )

    def _database_tables(self) -> set[str]:
        return {
            str(row["name"])
            for row in self._conn.execute(
                "SELECT name FROM sqlite_master "
                "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()
        }

    def _assert_database_structure(
        self,
        tables: set[str],
        *,
        current_memory_sources: bool,
        previous_scope_backend: bool,
    ) -> None:
        forbidden = sorted(
            {"agent_scope_sessions", "agent_memories_baseline_source",
             "agent_memory_candidates_baseline_source"} & tables
        )
        if forbidden:
            raise sqlite3.DatabaseError(
                "database contains tables outside the current baseline: "
                + ", ".join(forbidden)
            )

        agent_scope_columns = {
            "scope_key", "scope_type", "scope_id", "session_id",
            "lifecycle_id", "workspace_path", "sandbox_id", "created_at",
            "updated_at",
        }
        if previous_scope_backend:
            agent_scope_columns.add("execution_backend")

        required_columns = {
            "schema_migrations": {"version", "name", "applied_at"},
            "users": {
                "id", "username", "display_name", "password_hash", "role",
                "position", "permission_group", "model_name", "thinking_depth",
                "timezone", "active", "token_version", "created_at", "last_login_at",
            },
            "channels": {
                "id", "name", "description", "created_by", "created_at", "archived",
            },
            "messages": {
                "id", "scope_type", "scope_id", "author_type", "user_id",
                "username", "content", "metadata_json", "hidden_at",
                "hidden_by_user_id", "created_at",
            },
            "conversation_revisions": {
                "scope_type", "scope_id", "revision", "reset_revision", "updated_at",
            },
            "attachments": {
                "id", "message_id", "scope_type", "scope_id", "uploader_user_id",
                "source", "filename", "storage_path", "mime_type", "size_bytes",
                "sha256", "created_at",
            },
            "token_usage_events": {
                "id", "user_id", "username", "display_name", "scope_type",
                "scope_id", "scope_name", "request_message_id",
                "response_message_id", "provider", "model", "input_tokens",
                "output_tokens", "total_tokens", "raw_usage_json", "degraded",
                "created_at",
            },
            "agent_scopes": agent_scope_columns,
            "agent_runtime_scopes": {
                "scope_key", "session_id", "lifecycle_id", "created_at", "updated_at",
            },
            "agent_runtime_scope_sessions": {
                "scope_key", "lifecycle_id", "session_id", "created_at",
            },
            "agent_memories": {
                "id", "scope_key", "target", "owner_user_id", "content",
                "tags_json", "source_type", "source_run_id", "source_message_id",
                "content_hash", "created_at", "updated_at",
            },
            "agent_memory_candidates": {
                "id", "scope_key", "target", "owner_user_id", "content",
                "tags_json", "dedupe_key", "source_run_id", "source_message_id",
                "status", "memory_id", "created_at", "decided_at",
                "decided_by_user_id",
            },
            "knowledge_documents": {
                "id", "title", "summary", "content", "source", "created_by",
                "created_at", "updated_at", "content_hash",
            },
            "settings": {"key", "value", "secret", "updated_at"},
            "external_identities": {
                "provider", "external_id", "user_id", "username",
                "display_name", "metadata_json", "created_at", "updated_at",
            },
            "telegram_link_challenges": {
                "user_id", "code_hash", "expires_at", "created_at", "updated_at",
            },
            "telegram_updates": {
                "update_id", "status", "received_at", "processed_at",
                "last_error", "result_json",
            },
            "durable_jobs": {
                "id", "kind", "scope_type", "scope_id", "dedupe_key",
                "payload_json", "status", "attempts", "available_at",
                "lease_until", "last_error", "created_at", "updated_at",
            },
            "agent_run_inputs": {
                "message_id", "job_id", "parent_job_id", "input_group_id",
                "runtime_run_id", "state", "turn_id", "turn_index",
                "last_error", "created_at", "updated_at",
            },
            "agent_schedules": {
                "id", "owner_user_id", "name", "prompt", "schedule_json",
                "timezone", "delivery", "state", "enabled", "next_run_at",
                "last_run_id", "revision", "retry_after", "last_error",
                "created_at", "updated_at", "deleted_at",
            },
            "agent_schedule_runs": {
                "id", "schedule_id", "schedule_revision", "occurrence_key",
                "scheduled_for", "trigger", "status", "durable_job_id",
                "source_message_id", "response_message_id", "started_at",
                "finished_at", "error", "delivery_warning", "created_at",
                "updated_at",
            },
        }
        fts_tables = {
            f"{prefix}{suffix}"
            for prefix in (
                "knowledge_fts",
                "agent_memory_fts",
                "message_fts",
                "message_fts_trigram",
            )
            for suffix in ("", "_data", "_idx", "_docsize", "_config")
        }
        unexpected_tables = sorted(tables - set(required_columns) - fts_tables)
        if unexpected_tables:
            raise sqlite3.DatabaseError(
                "database contains tables outside the current baseline: "
                + ", ".join(unexpected_tables)
            )
        for table_name, expected in required_columns.items():
            if table_name not in tables:
                raise sqlite3.DatabaseError(
                    f"database is missing current baseline table {table_name}"
                )
            actual = {
                str(row["name"])
                for row in self._conn.execute(
                    f'PRAGMA table_info("{table_name}")'
                ).fetchall()
            }
            if actual != expected:
                missing = sorted(expected - actual)
                extra = sorted(actual - expected)
                differences = []
                if missing:
                    differences.append("missing " + ", ".join(missing))
                if extra:
                    differences.append("unexpected " + ", ".join(extra))
                raise sqlite3.DatabaseError(
                    f"database table {table_name} has non-current columns: "
                    + "; ".join(differences)
                )

        if previous_scope_backend:
            self._assert_table_sql(
                "agent_scopes", "check(execution_backend='sandbox')"
            )
        self._assert_table_sql(
            "attachments", "check(sourcein('upload','agent_generated'))"
        )
        self._assert_table_sql(
            "durable_jobs",
            "check(statusin('queued','running','succeeded','failed','needs_review'))",
        )
        self._assert_table_sql(
            "agent_run_inputs",
            "check(statein('running','reserved','submitting','accepted','injected','unconsumed','succeeded','failed','needs_review'))",
        )
        self._assert_table_sql(
            "agent_schedules",
            "check(deliveryin('chat','chat_and_telegram'))",
        )
        self._assert_table_sql(
            "agent_schedules",
            "check(statein('active','paused','completed'))",
        )
        self._assert_table_sql(
            "agent_schedule_runs",
            "check(triggerin('scheduled','manual'))",
        )
        self._assert_table_sql(
            "agent_schedule_runs",
            "check(statusin('queued','running','succeeded','failed','needs_review','blocked','skipped','cancelled'))",
        )
        if current_memory_sources:
            self._assert_table_sql(
                "agent_memories",
                "check(source_typein('manual','tool','candidate','imported'))",
            )
            invalid_sources = int(
                self._conn.execute(
                    "SELECT count(*) FROM agent_memories "
                    "WHERE source_type NOT IN ('manual', 'tool', 'candidate', 'imported')"
                ).fetchone()[0]
            )
            if invalid_sources:
                raise sqlite3.DatabaseError(
                    "database contains invalid current memory sources"
                )

        required_indexes = {
            "idx_messages_visible_scope",
            "uq_agent_memories_dedupe",
            "idx_knowledge_documents_content_hash",
            "idx_durable_jobs_ready",
            "idx_durable_jobs_scope",
            "idx_agent_run_inputs_group",
            "idx_agent_run_inputs_parent",
            "idx_agent_run_inputs_runtime",
            "idx_agent_schedules_due",
            "idx_agent_schedules_owner",
            "idx_agent_schedule_runs_schedule",
            "idx_agent_schedule_runs_job",
        }
        indexes = {
            str(row["name"])
            for row in self._conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'index'"
            ).fetchall()
        }
        missing_indexes = sorted(required_indexes - indexes)
        if missing_indexes:
            raise sqlite3.DatabaseError(
                "database is missing current baseline indexes: "
                + ", ".join(missing_indexes)
            )
        for index_name, table_name, columns in (
            ("idx_durable_jobs_ready", "durable_jobs", ("kind", "status", "available_at", "id")),
            ("idx_durable_jobs_scope", "durable_jobs", ("scope_type", "scope_id", "id")),
            ("idx_agent_run_inputs_group", "agent_run_inputs", ("input_group_id", "message_id")),
            ("idx_agent_run_inputs_parent", "agent_run_inputs", ("parent_job_id", "message_id")),
            ("idx_agent_run_inputs_runtime", "agent_run_inputs", ("runtime_run_id", "message_id")),
            ("idx_agent_schedules_due", "agent_schedules", ("enabled", "next_run_at", "id")),
            ("idx_agent_schedules_owner", "agent_schedules", ("owner_user_id", "deleted_at", "id")),
            ("idx_agent_schedule_runs_schedule", "agent_schedule_runs", ("schedule_id", "id")),
            ("idx_agent_schedule_runs_job", "agent_schedule_runs", ("durable_job_id",)),
        ):
            self._assert_named_index(index_name, table_name, columns)
        self._assert_unique_columns("durable_jobs", ("kind", "dedupe_key"))
        self._assert_unique_columns("agent_run_inputs", ("job_id",))
        self._assert_unique_columns(
            "agent_schedule_runs",
            ("schedule_id", "schedule_revision", "occurrence_key"),
        )

        self._assert_foreign_keys("durable_jobs", set())
        self._assert_foreign_keys("agent_run_inputs", set())
        self._assert_foreign_keys(
            "agent_schedules",
            {("owner_user_id", "users", "id", "CASCADE")},
        )
        self._assert_foreign_keys(
            "agent_schedule_runs",
            {
                ("schedule_id", "agent_schedules", "id", "CASCADE"),
                ("durable_job_id", "durable_jobs", "id", "NO ACTION"),
                ("source_message_id", "messages", "id", "NO ACTION"),
                ("response_message_id", "messages", "id", "NO ACTION"),
            },
        )

        required_triggers = {
            "conversation_revision_ai",
            "conversation_revision_hidden_au",
            "conversation_revision_metadata_au",
            "conversation_revision_ad",
        }
        triggers = {
            str(row["name"])
            for row in self._conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'trigger'"
            ).fetchall()
        }
        missing_triggers = sorted(required_triggers - triggers)
        if missing_triggers:
            raise sqlite3.DatabaseError(
                "database is missing current baseline triggers: "
                + ", ".join(missing_triggers)
            )

        durable_start = self._conn.execute(
            "SELECT value FROM settings "
            "WHERE key = 'durable_agent_jobs_start_message_id'"
        ).fetchone()
        try:
            durable_start_id = int(durable_start["value"]) if durable_start else -1
        except (TypeError, ValueError):
            durable_start_id = -1
        if durable_start_id < 0:
            raise sqlite3.DatabaseError(
                "database durable Agent message high-water mark is invalid"
            )

        missing_parents = self._missing_foreign_key_parents()
        if missing_parents:
            raise sqlite3.DatabaseError(
                "database has missing foreign-key parents: "
                + ", ".join(missing_parents)
            )
        violations = self._conn.execute("PRAGMA foreign_key_check").fetchall()
        if violations:
            raise sqlite3.IntegrityError(
                f"database has {len(violations)} foreign-key violations"
            )

    def _assert_table_sql(self, table_name: str, required_fragment: str) -> None:
        row = self._conn.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
            (table_name,),
        ).fetchone()
        normalized = "".join(str(row["sql"] or "").casefold().split()) if row else ""
        if required_fragment not in normalized:
            raise sqlite3.DatabaseError(
                f"database table {table_name} is outside the current baseline"
            )

    def _assert_named_index(
        self,
        index_name: str,
        table_name: str,
        columns: tuple[str, ...],
    ) -> None:
        row = self._conn.execute(
            "SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?",
            (index_name,),
        ).fetchone()
        actual_columns = tuple(
            str(item["name"])
            for item in self._conn.execute(
                f'PRAGMA index_info("{index_name}")'
            ).fetchall()
        )
        if row is None or str(row["tbl_name"]) != table_name or actual_columns != columns:
            raise sqlite3.DatabaseError(
                f"database index {index_name} is outside the current baseline"
            )

    def _assert_unique_columns(
        self,
        table_name: str,
        columns: tuple[str, ...],
    ) -> None:
        for index in self._conn.execute(
            f'PRAGMA index_list("{table_name}")'
        ).fetchall():
            if not int(index["unique"]):
                continue
            index_name = str(index["name"])
            actual_columns = tuple(
                str(item["name"])
                for item in self._conn.execute(
                    f'PRAGMA index_info("{index_name}")'
                ).fetchall()
            )
            if actual_columns == columns:
                return
        raise sqlite3.DatabaseError(
            f"database table {table_name} is missing current unique constraint"
        )

    def _assert_foreign_keys(
        self,
        table_name: str,
        expected: set[tuple[str, str, str, str]],
    ) -> None:
        actual = {
            (
                str(row["from"]),
                str(row["table"]),
                str(row["to"]),
                str(row["on_delete"]),
            )
            for row in self._conn.execute(
                f'PRAGMA foreign_key_list("{table_name}")'
            ).fetchall()
        }
        if actual != expected:
            raise sqlite3.DatabaseError(
                f"database table {table_name} has non-current foreign keys"
            )

    def _foreign_key_dependents(self, parent_name: str) -> set[str]:
        dependents: set[str] = set()
        for row in self._conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        ).fetchall():
            child_name = str(row["name"])
            quoted_name = '"' + child_name.replace('"', '""') + '"'
            if any(
                str(foreign_key["table"]) == parent_name
                for foreign_key in self._conn.execute(
                    f"PRAGMA foreign_key_list({quoted_name})"
                ).fetchall()
            ):
                dependents.add(child_name)
        return dependents

    def _missing_foreign_key_parents(self) -> list[str]:
        """Return child-to-parent edges whose declared parent table is absent."""

        rows = self._conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        ).fetchall()
        tables = {str(row["name"]).casefold() for row in rows}
        missing: set[str] = set()
        for row in rows:
            child_name = str(row["name"])
            quoted_name = '"' + child_name.replace('"', '""') + '"'
            foreign_keys = self._conn.execute(
                f"PRAGMA foreign_key_list({quoted_name})"
            ).fetchall()
            for foreign_key in foreign_keys:
                parent_name = str(foreign_key["table"])
                if parent_name.casefold() not in tables:
                    missing.add(f"{child_name}->{parent_name}")
        return sorted(missing)

    def _ensure_fts(self) -> None:
        try:
            self._conn.execute(
                "CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts "
                "USING fts5(title, summary, content, content='knowledge_documents', content_rowid='id')"
            )
            self._conn.executescript(
                """
                CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge_documents BEGIN
                    INSERT INTO knowledge_fts(rowid, title, summary, content)
                    VALUES (new.id, new.title, new.summary, new.content);
                END;
                CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge_documents BEGIN
                    INSERT INTO knowledge_fts(knowledge_fts, rowid, title, summary, content)
                    VALUES ('delete', old.id, old.title, old.summary, old.content);
                END;
                CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge_documents BEGIN
                    INSERT INTO knowledge_fts(knowledge_fts, rowid, title, summary, content)
                    VALUES ('delete', old.id, old.title, old.summary, old.content);
                    INSERT INTO knowledge_fts(rowid, title, summary, content)
                    VALUES (new.id, new.title, new.summary, new.content);
                END;
                """
            )
            self._conn.execute(
                "CREATE VIRTUAL TABLE IF NOT EXISTS agent_memory_fts "
                "USING fts5(content, tags, content='agent_memories', content_rowid='id')"
            )
            self._conn.executescript(
                """
                CREATE TRIGGER IF NOT EXISTS agent_memory_ai AFTER INSERT ON agent_memories BEGIN
                    INSERT INTO agent_memory_fts(rowid, content, tags)
                    VALUES (new.id, new.content, new.tags_json);
                END;
                CREATE TRIGGER IF NOT EXISTS agent_memory_ad AFTER DELETE ON agent_memories BEGIN
                    INSERT INTO agent_memory_fts(agent_memory_fts, rowid, content, tags)
                    VALUES ('delete', old.id, old.content, old.tags_json);
                END;
                CREATE TRIGGER IF NOT EXISTS agent_memory_au AFTER UPDATE ON agent_memories BEGIN
                    INSERT INTO agent_memory_fts(agent_memory_fts, rowid, content, tags)
                    VALUES ('delete', old.id, old.content, old.tags_json);
                    INSERT INTO agent_memory_fts(rowid, content, tags)
                    VALUES (new.id, new.content, new.tags_json);
                END;
                """
            )
            # The AFTER triggers only sync rows changed after they exist, so an
            # index created on a DB that already has documents (migrated from a
            # build without FTS5, or where FTS5 was unavailable on a prior boot)
            # starts empty and never backfills. Detect that divergence and
            # rebuild once. Note: count(*) on an external-content FTS5 table
            # reflects the source table's rowids, not what is actually indexed,
            # so it can never be used to spot an empty index. The internal
            # knowledge_fts_docsize shadow table holds one row per indexed
            # document, which is the reliable signal. 'rebuild' is idempotent
            # and cheap when the index is already in sync.
            doc_count = self._conn.execute(
                "SELECT count(*) FROM knowledge_documents"
            ).fetchone()[0]
            if doc_count > 0 and self._fts_index_is_stale(doc_count):
                self._conn.execute(
                    "INSERT INTO knowledge_fts(knowledge_fts) VALUES('rebuild')"
                )
            memory_count = self._conn.execute("SELECT count(*) FROM agent_memories").fetchone()[0]
            if memory_count > 0:
                indexed = self._conn.execute("SELECT count(*) FROM agent_memory_fts_docsize").fetchone()[0]
                if indexed != memory_count:
                    self._conn.execute("INSERT INTO agent_memory_fts(agent_memory_fts) VALUES('rebuild')")
            self.fts_available = True
        except sqlite3.OperationalError:
            # SQLite build lacks FTS5; KnowledgeBase.search falls back to LIKE.
            self.fts_available = False

    def _ensure_message_fts(self) -> None:
        """Maintain a message index for internal cross-session search.

        Trigram tokenization materially improves CJK substring search, but it
        is optional in some SQLite builds. Keep the normal unicode index
        available even when creation of the trigram variant fails.
        """

        try:
            self._conn.execute(
                "CREATE VIRTUAL TABLE IF NOT EXISTS message_fts "
                "USING fts5(content, content='messages', content_rowid='id')"
            )
            self._conn.executescript(
                """
                CREATE TRIGGER IF NOT EXISTS message_fts_ai AFTER INSERT ON messages BEGIN
                    INSERT INTO message_fts(rowid, content) VALUES (new.id, new.content);
                END;
                CREATE TRIGGER IF NOT EXISTS message_fts_ad AFTER DELETE ON messages BEGIN
                    INSERT INTO message_fts(message_fts, rowid, content)
                    VALUES ('delete', old.id, old.content);
                END;
                CREATE TRIGGER IF NOT EXISTS message_fts_au AFTER UPDATE OF content ON messages BEGIN
                    INSERT INTO message_fts(message_fts, rowid, content)
                    VALUES ('delete', old.id, old.content);
                    INSERT INTO message_fts(rowid, content) VALUES (new.id, new.content);
                END;
                """
            )
            message_count = self._conn.execute(
                "SELECT count(*) FROM messages"
            ).fetchone()[0]
            if message_count > 0:
                indexed = self._conn.execute(
                    "SELECT count(*) FROM message_fts_docsize"
                ).fetchone()[0]
                if indexed != message_count:
                    self._conn.execute(
                        "INSERT INTO message_fts(message_fts) VALUES('rebuild')"
                    )
            self.message_fts_available = True
        except sqlite3.OperationalError:
            self.message_fts_available = False

        if not self.message_fts_available:
            self.message_fts_trigram_available = False
            return
        try:
            self._conn.execute(
                "CREATE VIRTUAL TABLE IF NOT EXISTS message_fts_trigram "
                "USING fts5(content, content='messages', content_rowid='id', tokenize='trigram')"
            )
            self._conn.executescript(
                """
                CREATE TRIGGER IF NOT EXISTS message_fts_trigram_ai AFTER INSERT ON messages BEGIN
                    INSERT INTO message_fts_trigram(rowid, content) VALUES (new.id, new.content);
                END;
                CREATE TRIGGER IF NOT EXISTS message_fts_trigram_ad AFTER DELETE ON messages BEGIN
                    INSERT INTO message_fts_trigram(message_fts_trigram, rowid, content)
                    VALUES ('delete', old.id, old.content);
                END;
                CREATE TRIGGER IF NOT EXISTS message_fts_trigram_au
                AFTER UPDATE OF content ON messages BEGIN
                    INSERT INTO message_fts_trigram(message_fts_trigram, rowid, content)
                    VALUES ('delete', old.id, old.content);
                    INSERT INTO message_fts_trigram(rowid, content)
                    VALUES (new.id, new.content);
                END;
                """
            )
            message_count = self._conn.execute(
                "SELECT count(*) FROM messages"
            ).fetchone()[0]
            if message_count > 0:
                indexed = self._conn.execute(
                    "SELECT count(*) FROM message_fts_trigram_docsize"
                ).fetchone()[0]
                if indexed != message_count:
                    self._conn.execute(
                        "INSERT INTO message_fts_trigram(message_fts_trigram) VALUES('rebuild')"
                    )
            self.message_fts_trigram_available = True
        except sqlite3.OperationalError:
            self.message_fts_trigram_available = False

    def _fts_index_is_stale(self, doc_count: int) -> bool:
        """Report whether the FTS index is missing rows that exist in the source.

        Uses the internal knowledge_fts_docsize shadow table, which holds one
        row per indexed document, because count(*) on an external-content FTS5
        table mirrors the source table and so always matches doc_count. If the
        shadow table cannot be read (an unexpected FTS5 internal layout), assume
        a rebuild is warranted; 'rebuild' is idempotent so the worst case is one
        extra cheap pass.
        """
        try:
            indexed = self._conn.execute(
                "SELECT count(*) FROM knowledge_fts_docsize"
            ).fetchone()[0]
        except sqlite3.OperationalError:
            return True
        return indexed < doc_count

    @contextmanager
    def transaction(
        self, *, immediate: bool = False
    ) -> Iterator[sqlite3.Connection]:
        """Run several writes on this thread's connection as one transaction.

        Yields the thread-local connection. Statements issued through the
        yielded connection (conn.execute/executemany) are committed together on
        clean exit and rolled back on any exception, so a multi-row write such
        as a message plus its attachment rows lands atomically instead of being
        committed one statement at a time. The per-statement helpers below keep
        their immediate commits for single writes; callers that need atomicity
        should issue their statements through this connection directly and avoid
        the auto-committing helpers inside the block.
        """
        conn = self._conn
        try:
            if immediate:
                conn.execute("BEGIN IMMEDIATE")
            yield conn
        except BaseException:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        else:
            conn.commit()

    def execute(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
        conn = self._conn
        cur = conn.execute(sql, tuple(params))
        conn.commit()
        return cur

    def executemany(self, sql: str, seq: Iterable[Iterable[Any]]) -> None:
        conn = self._conn
        conn.executemany(sql, seq)
        conn.commit()

    def query(self, sql: str, params: Iterable[Any] = ()) -> list[dict[str, Any]]:
        rows = self._conn.execute(sql, tuple(params)).fetchall()
        return [dict(row) for row in rows]

    def query_one(self, sql: str, params: Iterable[Any] = ()) -> dict[str, Any] | None:
        row = self._conn.execute(sql, tuple(params)).fetchone()
        return dict(row) if row else None

    def scalar(self, sql: str, params: Iterable[Any] = ()) -> Any:
        row = self._conn.execute(sql, tuple(params)).fetchone()
        return row[0] if row else None

    def insert(self, sql: str, params: Iterable[Any] = ()) -> int:
        conn = self._conn
        cur = conn.execute(sql, tuple(params))
        conn.commit()
        return int(cur.lastrowid)


def encode_json(value: dict[str, Any] | list[Any] | None) -> str:
    return json.dumps({} if value is None else value, ensure_ascii=False, separators=(",", ":"))


def decode_json(value: str | None) -> Any:
    if not value:
        return {}
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return {}
