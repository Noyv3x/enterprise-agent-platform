from __future__ import annotations

import json
import sqlite3
import threading
import time
import weakref
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Iterator


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
        self.path.parent.mkdir(parents=True, exist_ok=True)
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
                    source TEXT NOT NULL DEFAULT 'upload' CHECK(source IN ('upload', 'hermes')),
                    filename TEXT NOT NULL,
                    storage_path TEXT NOT NULL UNIQUE,
                    mime_type TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    sha256 TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id, id);
                CREATE INDEX IF NOT EXISTS idx_attachments_scope ON attachments(scope_type, scope_id, id);

                CREATE TABLE IF NOT EXISTS private_agents (
                    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                    session_id TEXT NOT NULL,
                    container_name TEXT NOT NULL DEFAULT '',
                    container_id TEXT NOT NULL DEFAULT '',
                    container_status TEXT NOT NULL DEFAULT 'unknown',
                    workspace_path TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );

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
                """
            )
            self._ensure_user_columns()
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
    return json.dumps(value or {}, ensure_ascii=False, separators=(",", ":"))


def decode_json(value: str | None) -> Any:
    if not value:
        return {}
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return {}
