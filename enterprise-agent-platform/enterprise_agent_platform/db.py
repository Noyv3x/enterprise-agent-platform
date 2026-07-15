from __future__ import annotations

import json
import secrets
import sqlite3
import threading
import time
import weakref
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Iterator

from .secure_fs import ensure_private_directory, ensure_private_file, tighten_sqlite_files


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
            self._conn.executescript(
                """
                PRAGMA journal_mode=WAL;
                PRAGMA foreign_keys=ON;

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
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_messages_scope ON messages(scope_type, scope_id, id);

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

                CREATE TABLE IF NOT EXISTS agent_scopes (
                    scope_key TEXT PRIMARY KEY,
                    scope_type TEXT NOT NULL CHECK(scope_type IN ('channel', 'private')),
                    scope_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    lifecycle_id TEXT NOT NULL DEFAULT '',
                    workspace_path TEXT NOT NULL,
                    execution_backend TEXT NOT NULL DEFAULT 'host' CHECK(execution_backend = 'host'),
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
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_agent_memories_scope
                    ON agent_memories(scope_key, target, owner_user_id, updated_at DESC);

                CREATE TABLE IF NOT EXISTS knowledge_documents (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    content TEXT NOT NULL,
                    source TEXT NOT NULL DEFAULT '',
                    created_by INTEGER REFERENCES users(id),
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );

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
                """
            )
            self._ensure_user_columns()
            self._ensure_agent_scope_columns()
            self._ensure_agent_runtime_scopes()
            self._normalize_attachment_sources()
            self._ensure_telegram_update_columns()
            self._ensure_fts()
            self._conn.commit()

    def _ensure_user_columns(self) -> None:
        columns = {row["name"] for row in self._conn.execute("PRAGMA table_info(users)").fetchall()}
        additions = {
            "position": "ALTER TABLE users ADD COLUMN position TEXT NOT NULL DEFAULT ''",
            "permission_group": "ALTER TABLE users ADD COLUMN permission_group TEXT NOT NULL DEFAULT 'member'",
            "model_name": "ALTER TABLE users ADD COLUMN model_name TEXT NOT NULL DEFAULT ''",
            "thinking_depth": "ALTER TABLE users ADD COLUMN thinking_depth TEXT NOT NULL DEFAULT 'medium'",
            "token_version": "ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1",
        }
        for name, sql in additions.items():
            if name not in columns:
                self._conn.execute(sql)
        self._conn.execute(
            """
            UPDATE users
            SET permission_group = CASE WHEN role = 'admin' THEN 'admin' ELSE 'member' END
            WHERE permission_group IS NULL OR permission_group = ''
            """
        )
        self._conn.execute(
            "UPDATE users SET permission_group = 'admin' WHERE role = 'admin' AND permission_group != 'admin'"
        )
        self._conn.execute(
            "UPDATE users SET thinking_depth = 'medium' WHERE thinking_depth IS NULL OR thinking_depth = ''"
        )

    def _ensure_agent_scope_columns(self) -> None:
        columns = {row["name"] for row in self._conn.execute("PRAGMA table_info(agent_scopes)").fetchall()}
        if "lifecycle_id" not in columns:
            self._conn.execute(
                "ALTER TABLE agent_scopes ADD COLUMN lifecycle_id TEXT NOT NULL DEFAULT ''"
            )
        self._conn.execute(
            "UPDATE agent_scopes SET lifecycle_id = lower(hex(randomblob(16))) WHERE lifecycle_id = ''"
        )

    def _ensure_agent_runtime_scopes(self) -> None:
        """Ensure every logical Agent scope has authoritative runtime state."""

        rows = self._conn.execute("SELECT scope_key, scope_type FROM agent_scopes").fetchall()
        timestamp = now_ts()
        for row in rows:
            scope_type = str(row["scope_type"] or "agent")
            session_id = f"ubitech-{scope_type}-{secrets.token_urlsafe(18)}"
            self._conn.execute(
                """
                INSERT OR IGNORE INTO agent_runtime_scopes(
                    scope_key, session_id, lifecycle_id, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    str(row["scope_key"]),
                    session_id,
                    secrets.token_hex(16),
                    timestamp,
                    timestamp,
                ),
            )

    def _ensure_telegram_update_columns(self) -> None:
        columns = {row["name"] for row in self._conn.execute("PRAGMA table_info(telegram_updates)").fetchall()}
        if "result_json" not in columns:
            self._conn.execute(
                "ALTER TABLE telegram_updates ADD COLUMN result_json TEXT NOT NULL DEFAULT '{}'"
            )

    def _normalize_attachment_sources(self) -> None:
        """Collapse non-upload attachment origins into the current schema."""

        row = self._conn.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'attachments'"
        ).fetchone()
        schema = str(row[0] or "") if row else ""
        normalized_schema = "".join(schema.lower().split())
        if "check(sourcein('upload','agent_generated'))" in normalized_schema:
            return

        self._conn.execute("SAVEPOINT normalize_attachment_sources")
        try:
            self._conn.execute("DROP TABLE IF EXISTS attachments_new")
            self._conn.execute(
                """
                CREATE TABLE attachments_new (
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
                )
                """
            )
            self._conn.execute(
                """
                INSERT INTO attachments_new(
                    id, message_id, scope_type, scope_id, uploader_user_id, source,
                    filename, storage_path, mime_type, size_bytes, sha256, created_at
                )
                SELECT id, message_id, scope_type, scope_id, uploader_user_id,
                       CASE WHEN source = 'upload' THEN 'upload' ELSE 'agent_generated' END,
                       filename, storage_path, mime_type, size_bytes, sha256, created_at
                FROM attachments
                """
            )
            self._conn.execute("DROP TABLE attachments")
            self._conn.execute("ALTER TABLE attachments_new RENAME TO attachments")
            self._conn.execute(
                "CREATE INDEX idx_attachments_message ON attachments(message_id, id)"
            )
            self._conn.execute(
                "CREATE INDEX idx_attachments_scope ON attachments(scope_type, scope_id, id)"
            )
            self._conn.execute("RELEASE SAVEPOINT normalize_attachment_sources")
        except Exception:
            self._conn.execute("ROLLBACK TO SAVEPOINT normalize_attachment_sources")
            self._conn.execute("RELEASE SAVEPOINT normalize_attachment_sources")
            raise

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
    def transaction(self) -> Iterator[sqlite3.Connection]:
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
