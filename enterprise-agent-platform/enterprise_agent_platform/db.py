from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import weakref
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Iterator

from .camofox_state import ensure_camofox_runtime_sidecar
from .container_contract_generated import DATABASE_SCHEMA_VERSION
from .secure_fs import (
    open_private_directory_fd,
    open_private_file_fd_at,
    tighten_sqlite_files_at,
    verify_private_directory_path_fd,
    verify_private_file_fd_at,
    ensure_private_directory,
)
from .technical_profile import (
    TARGET_DATABASE_BASELINE,
    TARGET_TECHNICAL_PROFILE,
    TechnicalProfile,
    technical_profile,
)


_DATABASE_BASELINE_VERSION = 2026082901
if _DATABASE_BASELINE_VERSION != DATABASE_SCHEMA_VERSION:
    raise RuntimeError("Database baseline does not match the container contract")


_AGENT_MEMORY_FTS_TABLE_SQL = (
    "CREATE VIRTUAL TABLE agent_memory_fts "
    "USING fts5(content, tags_json, content='agent_memories', content_rowid='id')"
)
_AGENT_MEMORY_FTS_TRIGGER_SQL = {
    "agent_memory_ai": """
        CREATE TRIGGER agent_memory_ai AFTER INSERT ON agent_memories BEGIN
            INSERT INTO agent_memory_fts(rowid, content, tags_json)
            VALUES (new.id, new.content, new.tags_json);
        END
    """.strip(),
    "agent_memory_ad": """
        CREATE TRIGGER agent_memory_ad AFTER DELETE ON agent_memories BEGIN
            INSERT INTO agent_memory_fts(
                agent_memory_fts, rowid, content, tags_json
            ) VALUES ('delete', old.id, old.content, old.tags_json);
        END
    """.strip(),
    "agent_memory_au": """
        CREATE TRIGGER agent_memory_au AFTER UPDATE ON agent_memories BEGIN
            INSERT INTO agent_memory_fts(
                agent_memory_fts, rowid, content, tags_json
            ) VALUES ('delete', old.id, old.content, old.tags_json);
            INSERT INTO agent_memory_fts(rowid, content, tags_json)
            VALUES (new.id, new.content, new.tags_json);
        END
    """.strip(),
}


def now_ts() -> int:
    return int(time.time())


def _normalized_schema_sql(value: object) -> str:
    return "".join(str(value or "").casefold().split())


def _close_database_descriptors(database_fd: int, directory_fd: int) -> None:
    for fd in (database_fd, directory_fd):
        try:
            os.close(fd)
        except OSError:
            pass


def _sqlite_fd_uri(database_fd: int, *, mode: str) -> str:
    if mode not in {"ro", "rw"}:  # pragma: no cover - internal programming error
        raise ValueError("SQLite fd mode is invalid")
    proc_path = Path(f"/proc/self/fd/{database_fd}")
    if not proc_path.exists():
        raise RuntimeError("pinned SQLite file descriptors are unavailable")
    return f"file:{proc_path}?mode={mode}"


def _validate_existing_sqlite_sidecars(parent_fd: int, database_name: str) -> None:
    for name in (f"{database_name}-wal", f"{database_name}-shm"):
        try:
            sidecar_fd = open_private_file_fd_at(
                parent_fd,
                name,
                writable=False,
                mode=None,
            )
        except FileNotFoundError:
            continue
        os.close(sidecar_fd)


def _supported_schema_version(connection: sqlite3.Connection) -> int:
    try:
        version = connection.execute(
            "SELECT MAX(version) FROM schema_migrations"
        ).fetchone()[0]
    except sqlite3.Error as exc:
        raise sqlite3.DatabaseError("database schema_version is missing") from exc
    if not isinstance(version, int):
        raise sqlite3.DatabaseError("database schema_version is invalid")
    if version > DATABASE_SCHEMA_VERSION:
        raise sqlite3.DatabaseError("database schema_version is newer than supported")
    if version != DATABASE_SCHEMA_VERSION:
        raise sqlite3.DatabaseError("database schema_version is no longer supported")
    return version


def _assert_pinned_database_version(
    parent_fd: int,
    database_name: str,
    database_fd: int,
) -> int | None:
    """Read the supported schema version through a pinned database inode."""

    info = verify_private_file_fd_at(
        parent_fd,
        database_name,
        database_fd,
        mode=None,
    )
    if info.st_size == 0:
        return None
    connection: sqlite3.Connection | None = None
    try:
        connection = sqlite3.connect(
            _sqlite_fd_uri(database_fd, mode="ro"),
            uri=True,
        )
        verify_private_file_fd_at(
            parent_fd,
            database_name,
            database_fd,
            mode=None,
        )
        version = _supported_schema_version(connection)
        verify_private_file_fd_at(
            parent_fd,
            database_name,
            database_fd,
            mode=None,
        )
    finally:
        if connection is not None:
            connection.close()
    return version


def assert_existing_database_version(path: Path) -> int | None:
    """Reject unsupported versions without opening a writable handle."""

    path = Path(path).expanduser()
    directory_fd = -1
    database_fd = -1
    try:
        try:
            directory_fd = open_private_directory_fd(path.parent, mode=None)
        except FileNotFoundError:
            return None
        verify_private_directory_path_fd(path.parent, directory_fd, mode=None)
        try:
            database_fd = open_private_file_fd_at(
                directory_fd,
                path.name,
                writable=False,
                mode=None,
            )
        except FileNotFoundError:
            return None
        _validate_existing_sqlite_sidecars(directory_fd, path.name)
        baseline = _assert_pinned_database_version(
            directory_fd,
            path.name,
            database_fd,
        )
        verify_private_directory_path_fd(path.parent, directory_fd, mode=None)
        return baseline
    finally:
        if database_fd >= 0:
            os.close(database_fd)
        if directory_fd >= 0:
            os.close(directory_fd)


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

    def __init__(
        self,
        path: Path,
        technical_profile_value: TechnicalProfile | str = TARGET_TECHNICAL_PROFILE,
    ):
        self.path = Path(path).expanduser()
        self.technical_profile = technical_profile(technical_profile_value)
        self._database_baseline_name = TARGET_DATABASE_BASELINE
        self._directory_fd = -1
        self._database_fd = -1
        self._pin_finalizer: weakref.finalize | None = None
        ensure_private_directory(self.path.parent)
        try:
            self._directory_fd = open_private_directory_fd(self.path.parent)
            verify_private_directory_path_fd(
                self.path.parent,
                self._directory_fd,
            )
            self._database_fd = open_private_file_fd_at(
                self._directory_fd,
                self.path.name,
                writable=True,
                create=True,
                mode=0o600,
                tighten_mode=True,
            )
            self._pin_finalizer = weakref.finalize(
                self,
                _close_database_descriptors,
                self._database_fd,
                self._directory_fd,
            )
            # Existing WAL/SHM leaves are verified before even a read-only
            # version query can make SQLite discover them.
            tighten_sqlite_files_at(
                self._directory_fd,
                self.path.name,
                database_fd=self._database_fd,
            )
            schema_version = _assert_pinned_database_version(
                self._directory_fd,
                self.path.name,
                self._database_fd,
            )
            verify_private_directory_path_fd(
                self.path.parent,
                self._directory_fd,
            )
            self._local = threading.local()
            self._init_lock = threading.RLock()
            self._holders: "weakref.WeakSet[_ConnectionHolder]" = weakref.WeakSet()
            self._holders_lock = threading.Lock()
            self.fts_available = False
            self.message_fts_available = False
            self.message_fts_trigram_available = False
            self._closed = False
            self.init_schema(fresh_database=schema_version is None)
        except BaseException:
            holder = getattr(self, "_local", None)
            if holder is not None:
                connection_holder = getattr(holder, "holder", None)
                if connection_holder is not None:
                    connection_holder.close()
            self._close_pinned_files()
            raise

    def _verify_database_identity(self) -> None:
        verify_private_directory_path_fd(self.path.parent, self._directory_fd)
        verify_private_file_fd_at(
            self._directory_fd,
            self.path.name,
            self._database_fd,
            mode=0o600,
        )

    def _close_pinned_files(self) -> None:
        finalizer = self._pin_finalizer
        self._pin_finalizer = None
        database_fd, self._database_fd = self._database_fd, -1
        directory_fd, self._directory_fd = self._directory_fd, -1
        if finalizer is not None and finalizer.alive:
            finalizer.detach()
        _close_database_descriptors(database_fd, directory_fd)

    def _new_connection(self) -> sqlite3.Connection:
        self._verify_database_identity()
        tighten_sqlite_files_at(
            self._directory_fd,
            self.path.name,
            database_fd=self._database_fd,
        )
        conn: sqlite3.Connection | None = None
        try:
            conn = sqlite3.connect(
                _sqlite_fd_uri(self._database_fd, mode="rw"),
                uri=True,
                check_same_thread=False,
                timeout=30,
            )
            # sqlite3_open has acquired its own handle to the pinned inode, but
            # no WAL pragma or schema statement has run yet. Reprove the named
            # leaf now so a connect-window replacement fails without a writer.
            self._verify_database_identity()
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("PRAGMA busy_timeout=30000")
            self._verify_database_identity()
            tighten_sqlite_files_at(
                self._directory_fd,
                self.path.name,
                database_fd=self._database_fd,
            )
            return conn
        except BaseException:
            if conn is not None:
                conn.close()
            raise

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
        try:
            self._verify_database_identity()
            tighten_sqlite_files_at(
                self._directory_fd,
                self.path.name,
                database_fd=self._database_fd,
            )
        finally:
            self._close_pinned_files()

    def init_schema(self, *, fresh_database: bool = False) -> None:
        with self._init_lock:
            if not fresh_database:
                _supported_schema_version(self._conn)
            if fresh_database:
                try:
                    schema = """
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

                INSERT INTO schema_migrations(version, name, applied_at)
                    VALUES (
                        __CURRENT_DATABASE_BASELINE_VERSION__,
                        '__CURRENT_DATABASE_BASELINE__',
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
                    if schema.count("__CURRENT_DATABASE_BASELINE__") != 1:
                        raise RuntimeError("database baseline placeholder is invalid")
                    if schema.count("__CURRENT_DATABASE_BASELINE_VERSION__") != 1:
                        raise RuntimeError("database baseline version placeholder is invalid")
                    self._conn.executescript(
                        schema.replace(
                            "__CURRENT_DATABASE_BASELINE__",
                            self._database_baseline_name,
                        ).replace(
                            "__CURRENT_DATABASE_BASELINE_VERSION__",
                            str(_DATABASE_BASELINE_VERSION),
                        )
                    )
                except BaseException:
                    self._conn.rollback()
                    raise
            self._ensure_fts()
            self._ensure_message_fts()
            self._conn.commit()

    def _ensure_fts(self) -> None:
        try:
            memory_fts_rebuilt = self._ensure_agent_memory_fts_contract()
            memory_count = self._conn.execute(
                "SELECT count(*) FROM agent_memories"
            ).fetchone()[0]
            if memory_count > 0 and not memory_fts_rebuilt:
                indexed = self._conn.execute(
                    "SELECT count(*) FROM agent_memory_fts_docsize"
                ).fetchone()[0]
                if indexed != memory_count:
                    self._conn.execute(
                        "INSERT INTO agent_memory_fts(agent_memory_fts) "
                        "VALUES('rebuild')"
                    )
            self.fts_available = True
        except sqlite3.OperationalError:
            self.fts_available = False

    def _ensure_agent_memory_fts_contract(self) -> bool:
        """Repair the derived memory index when its projection has drifted.

        The authoritative table stores ``tags_json``. An earlier FTS definition
        exposed that source value through a non-existent external-content column
        named ``tags``, so FTS5 tried to read ``agent_memories.tags`` during a
        rebuild or query. Validate the complete owned schema rather than trusting
        ``CREATE ... IF NOT EXISTS`` and replace only these derived objects when
        they differ.

        Returns True when the index was recreated and already rebuilt.
        """

        table = self._conn.execute(
            "SELECT sql FROM sqlite_master "
            "WHERE type = 'table' AND name = 'agent_memory_fts'"
        ).fetchone()
        columns = tuple(
            str(row["name"])
            for row in self._conn.execute(
                'PRAGMA table_info("agent_memory_fts")'
            ).fetchall()
        )
        matches = (
            table is not None
            and columns == ("content", "tags_json")
            and _normalized_schema_sql(table["sql"])
            == _normalized_schema_sql(_AGENT_MEMORY_FTS_TABLE_SQL)
        )
        if matches:
            for trigger_name, expected_sql in _AGENT_MEMORY_FTS_TRIGGER_SQL.items():
                trigger = self._conn.execute(
                    "SELECT tbl_name, sql FROM sqlite_master "
                    "WHERE type = 'trigger' AND name = ?",
                    (trigger_name,),
                ).fetchone()
                if (
                    trigger is None
                    or str(trigger["tbl_name"]) != "agent_memories"
                    or _normalized_schema_sql(trigger["sql"])
                    != _normalized_schema_sql(expected_sql)
                ):
                    matches = False
                    break
        if matches:
            return False

        savepoint = "agent_memory_fts_contract"
        self._conn.execute(f"SAVEPOINT {savepoint}")
        try:
            for trigger_name in _AGENT_MEMORY_FTS_TRIGGER_SQL:
                self._conn.execute(f'DROP TRIGGER IF EXISTS "{trigger_name}"')
            self._conn.execute('DROP TABLE IF EXISTS "agent_memory_fts"')
            self._conn.execute(_AGENT_MEMORY_FTS_TABLE_SQL)
            for trigger_sql in _AGENT_MEMORY_FTS_TRIGGER_SQL.values():
                self._conn.execute(trigger_sql)
            self._conn.execute(
                "INSERT INTO agent_memory_fts(agent_memory_fts) VALUES('rebuild')"
            )
        except sqlite3.OperationalError as exc:
            self._conn.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
            self._conn.execute(f"RELEASE SAVEPOINT {savepoint}")
            # A partially present memory FTS schema is a broken derived
            # contract, not an optional-capability fallback.
            raise sqlite3.DatabaseError(
                "agent memory FTS contract repair failed"
            ) from exc
        except BaseException:
            self._conn.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
            self._conn.execute(f"RELEASE SAVEPOINT {savepoint}")
            raise
        self._conn.execute(f"RELEASE SAVEPOINT {savepoint}")
        return True

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
            self._commit_or_rollback(conn)

    @staticmethod
    def _commit_or_rollback(conn: sqlite3.Connection) -> None:
        """Commit one write, restoring a reusable connection on failure."""

        try:
            conn.commit()
        except BaseException:
            try:
                conn.rollback()
            except Exception:
                pass
            raise

    def execute(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
        conn = self._conn
        try:
            cur = conn.execute(sql, tuple(params))
        except BaseException:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        self._commit_or_rollback(conn)
        return cur

    def executemany(self, sql: str, seq: Iterable[Iterable[Any]]) -> None:
        conn = self._conn
        try:
            conn.executemany(sql, seq)
        except BaseException:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        self._commit_or_rollback(conn)

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
        cur = self.execute(sql, params)
        return int(cur.lastrowid)


def _migrate_durable_work(database: Database, data_dir: Path) -> None:
    """One explicit, additive cutover; normal startup never repairs job gaps."""
    # Reuse pure projections without constructing a service or starting workers.
    from .service import (
        EnterpriseService, CONTAINER_PATHS, normalize_attachment_mime,
        is_safe_inline_attachment_mime, rfc3339_utc,
    )
    marker = "durable_work_queue_v1"
    with database.transaction(immediate=True) as conn:
        if conn.execute("SELECT 1 FROM settings WHERE key = ?", (marker,)).fetchone():
            return
        start = conn.execute(
            "SELECT value FROM settings WHERE key = 'durable_agent_jobs_start_message_id'"
        ).fetchone()
        try:
            start_id = int(start["value"]) if start is not None else -1
        except (TypeError, ValueError) as exc:
            raise sqlite3.DatabaseError("durable job high-water mark is invalid") from exc
        if start_id < 0:
            raise sqlite3.DatabaseError("durable job high-water mark is invalid")
        timestamp = now_ts()
        for legacy in conn.execute("SELECT * FROM agent_run_inputs").fetchall():
            association = dict(legacy)
            for key in ("job_id", "created_at", "updated_at", "last_error"):
                association.pop(key, None)
            conn.execute(
                "UPDATE durable_jobs SET payload_json = json_set(payload_json, '$._input', json(?)) "
                "WHERE id = ? AND json_type(payload_json, '$._input') IS NULL",
                (json.dumps(association), int(legacy["job_id"])),
            )
        replied = set()
        for reply in conn.execute("SELECT metadata_json FROM messages WHERE author_type = 'agent'"):
            metadata = decode_json(reply["metadata_json"])
            for value in [metadata.get("reply_to_message_id"), (metadata.get("reply_to") or {}).get("message_id"), *(metadata.get("reply_to_message_ids") or [])]:
                if value is not None:
                    replied.add(int(value))
        runs = {
            int(row["source_message_id"]): dict(row)
            for row in conn.execute(
                "SELECT r.*, s.schedule_json FROM agent_schedule_runs r "
                "JOIN agent_schedules s ON s.id = r.schedule_id "
                "WHERE r.durable_job_id IS NULL AND r.source_message_id IS NOT NULL "
                "AND r.status IN ('queued', 'running')"
            )
        }
        rows = conn.execute(
            "SELECT * FROM messages WHERE (id > ? AND author_type = 'user') "
            "OR id IN (SELECT source_message_id FROM agent_schedule_runs "
            "WHERE durable_job_id IS NULL AND status IN ('queued', 'running')) ORDER BY id",
            (start_id,),
        ).fetchall()
        for row in rows:
            message_id = int(row["id"])
            metadata = decode_json(row["metadata_json"])
            run = runs.get(message_id)
            existing = conn.execute(
                "SELECT id FROM durable_jobs WHERE kind = 'agent' AND dedupe_key = ?",
                (f"message:{message_id}",),
            ).fetchone()
            if existing:
                if run:
                    conn.execute(
                        "UPDATE agent_schedule_runs SET durable_job_id = ?, updated_at = ? WHERE id = ?",
                        (existing["id"], timestamp, run["id"]),
                    )
                continue
            if not run and row["scope_type"] == "channel" and not metadata.get("agent_mention"):
                continue
            if message_id in replied:
                continue
            actor_row = conn.execute("SELECT * FROM users WHERE id = ? AND active = 1", (row["user_id"],)).fetchone()
            if actor_row is None:
                if run:
                    conn.execute(
                        "UPDATE agent_schedule_runs SET status = 'cancelled', error = ?, updated_at = ? WHERE id = ?",
                        ("schedule owner is missing or inactive", timestamp, run["id"]),
                    )
                continue
            attachments = []
            for stored in conn.execute("SELECT * FROM attachments WHERE message_id = ? ORDER BY id", (message_id,)):
                attachment = dict(stored)
                storage = Path(attachment["storage_path"])
                parts = storage.parts
                if storage.is_absolute() or len(parts) < 3 or parts[:2] != (row["scope_type"], row["scope_id"]) or ".." in parts:
                    raise sqlite3.DatabaseError("attachment storage path does not match its scope")
                mime = normalize_attachment_mime(attachment["filename"], attachment["mime_type"])
                item = {key: attachment[key] for key in (
                    "id", "message_id", "scope_type", "scope_id", "source", "filename",
                    "size_bytes", "sha256", "created_at",
                )}
                item.update({
                    "mime_type": mime, "is_image": is_safe_inline_attachment_mime(mime),
                    "url": f"/api/attachments/{attachment['id']}",
                    "download_url": f"/api/attachments/{attachment['id']}?download=1",
                    "local_path": str(data_dir / "attachments" / storage),
                    "path": str(Path(CONTAINER_PATHS["workspace"]) / database.technical_profile.workspace_internal_directory / "attachments" / Path(*parts[2:])),
                })
                attachments.append(item)
            message = {key: row[key] for key in (
                "id", "scope_type", "scope_id", "author_type", "user_id", "username", "content", "created_at",
            )}
            message.update({"metadata": metadata, "attachments": [
                {key: value for key, value in item.items() if key not in {"path", "local_path"}}
                for item in attachments
            ]})
            payload = {
                "scope_type": row["scope_type"], "scope_id": row["scope_id"],
                "actor": EnterpriseService.public_user(dict(actor_row)),
                "content": str(metadata.get("agent_request_content") or row["content"] or ""),
                "attachments": attachments,
                "generation": metadata.get("generation") if isinstance(metadata.get("generation"), dict) else {},
                "user_message": message,
            }
            if row["scope_type"] == "channel":
                channel = conn.execute("SELECT * FROM channels WHERE id = ? AND archived = 0", (row["scope_id"],)).fetchone()
                if channel is None:
                    continue
                payload["channel"] = dict(channel)
            if run:
                payload["schedule_run_id"] = int(run["id"])
                payload["runtime_metadata"] = {
                    "trigger": "scheduled", "unattended": True,
                    "schedule_id": str(run["schedule_id"]), "schedule_run_id": str(run["id"]),
                    "schedule_recurring": decode_json(run["schedule_json"]).get("type") in {"interval", "cron"},
                    "scheduled_for": str((metadata.get("scheduled_task") or {}).get("scheduled_for") or rfc3339_utc(run["scheduled_for"]) or ""),
                }
            conn.execute(
                "INSERT INTO durable_jobs(kind, scope_type, scope_id, dedupe_key, payload_json, "
                "status, available_at, created_at, updated_at) "
                "VALUES ('agent', ?, ?, ?, ?, 'queued', ?, ?, ?) "
                "ON CONFLICT(kind, dedupe_key) DO NOTHING",
                (row["scope_type"], row["scope_id"], f"message:{message_id}",
                 json.dumps(payload), timestamp, timestamp, timestamp),
            )
            if run:
                conn.execute(
                    "UPDATE agent_schedule_runs SET durable_job_id = "
                    "(SELECT id FROM durable_jobs WHERE kind = 'agent' AND dedupe_key = ?), "
                    "updated_at = ? WHERE id = ?",
                    (f"message:{message_id}", timestamp, int(run["id"])),
                )
        conn.execute(
            "INSERT INTO settings(key, value, secret, updated_at) VALUES (?, '1', 0, ?)",
            (marker, timestamp),
        )


def migrate_database(
    path: Path,
    technical_profile_value: TechnicalProfile | str = TARGET_TECHNICAL_PROFILE,
    *,
    data_dir: Path,
) -> int:
    """Initialize or migrate a supported version with the current writer stopped."""

    # Preserve fresh evidence before Database creates the file. Existing
    # migrations retain their managed sidecar; they must never invent one.
    fresh_initialization = not os.path.lexists(Path(path).expanduser())
    if fresh_initialization:
        ensure_camofox_runtime_sidecar(
            data_dir,
            fresh_initialization=True,
            commit_schema_upgrade=False,
            technical_profile_value=technical_profile_value,
        )

    database = Database(
        path,
        technical_profile_value,
    )
    try:
        if fresh_initialization:
            ensure_camofox_runtime_sidecar(
                data_dir,
                fresh_initialization=True,
                technical_profile_value=technical_profile_value,
            )
        _migrate_durable_work(database, data_dir)
        return int(
            database.scalar(
                "SELECT COALESCE(MAX(version), 0) FROM schema_migrations"
            )
            or 0
        )
    finally:
        database.close()


def encode_json(value: dict[str, Any] | list[Any] | None) -> str:
    return json.dumps({} if value is None else value, ensure_ascii=False, separators=(",", ":"))


def decode_json(value: str | None) -> Any:
    if not value:
        return {}
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return {}
