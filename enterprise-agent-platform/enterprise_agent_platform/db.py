from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Iterable


def now_ts() -> int:
    return int(time.time())


class Database:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        self.init_schema()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def init_schema(self) -> None:
        with self._lock:
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
        except sqlite3.OperationalError:
            pass

    def execute(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
        with self._lock:
            cur = self._conn.execute(sql, tuple(params))
            self._conn.commit()
            return cur

    def executemany(self, sql: str, seq: Iterable[Iterable[Any]]) -> None:
        with self._lock:
            self._conn.executemany(sql, seq)
            self._conn.commit()

    def query(self, sql: str, params: Iterable[Any] = ()) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(sql, tuple(params)).fetchall()
            return [dict(row) for row in rows]

    def query_one(self, sql: str, params: Iterable[Any] = ()) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(sql, tuple(params)).fetchone()
            return dict(row) if row else None

    def scalar(self, sql: str, params: Iterable[Any] = ()) -> Any:
        with self._lock:
            row = self._conn.execute(sql, tuple(params)).fetchone()
            return row[0] if row else None

    def insert(self, sql: str, params: Iterable[Any] = ()) -> int:
        with self._lock:
            cur = self._conn.execute(sql, tuple(params))
            self._conn.commit()
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
