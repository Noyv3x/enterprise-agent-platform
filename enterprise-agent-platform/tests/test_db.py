from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from enterprise_agent_platform.db import Database


class DatabaseMemoryFtsContractTests(unittest.TestCase):
    def test_startup_repairs_legacy_tags_projection_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "memory.db"
            db = Database(path)
            try:
                if not db.fts_available:
                    self.skipTest("FTS5 not available in this SQLite build")
                memory_id = db.insert(
                    """
                    INSERT INTO agent_memories(
                        scope_key, target, content, tags_json, created_at, updated_at
                    ) VALUES (?, 'memory', ?, ?, ?, ?)
                    """,
                    (
                        "private:1",
                        "stable deployment preference",
                        '["ocean","urgent"]',
                        1,
                        1,
                    ),
                )

                # Reproduce the shipped legacy definition. Its FTS projection
                # names the source column `tags`, although agent_memories only
                # has `tags_json`, so a rebuild or query cannot read content.
                for trigger_name in (
                    "agent_memory_ai",
                    "agent_memory_ad",
                    "agent_memory_au",
                ):
                    db._conn.execute(f'DROP TRIGGER "{trigger_name}"')
                db._conn.execute('DROP TABLE "agent_memory_fts"')
                db._conn.execute(
                    "CREATE VIRTUAL TABLE agent_memory_fts "
                    "USING fts5(content, tags, "
                    "content='agent_memories', content_rowid='id')"
                )
                db._conn.executescript(
                    """
                    CREATE TRIGGER agent_memory_ai AFTER INSERT ON agent_memories BEGIN
                        INSERT INTO agent_memory_fts(rowid, content, tags)
                        VALUES (new.id, new.content, new.tags_json);
                    END;
                    CREATE TRIGGER agent_memory_ad AFTER DELETE ON agent_memories BEGIN
                        INSERT INTO agent_memory_fts(
                            agent_memory_fts, rowid, content, tags
                        ) VALUES ('delete', old.id, old.content, old.tags_json);
                    END;
                    CREATE TRIGGER agent_memory_au AFTER UPDATE ON agent_memories BEGIN
                        INSERT INTO agent_memory_fts(
                            agent_memory_fts, rowid, content, tags
                        ) VALUES ('delete', old.id, old.content, old.tags_json);
                        INSERT INTO agent_memory_fts(rowid, content, tags)
                        VALUES (new.id, new.content, new.tags_json);
                    END;
                    """
                )
                db._conn.commit()
                self.assertEqual(
                    [
                        str(row["name"])
                        for row in db._conn.execute(
                            'PRAGMA table_info("agent_memory_fts")'
                        ).fetchall()
                    ],
                    ["content", "tags"],
                )
            finally:
                db.close()

            repaired = Database(path)
            try:
                self.assertTrue(repaired.fts_available)
                self.assertEqual(
                    [
                        str(row["name"])
                        for row in repaired._conn.execute(
                            'PRAGMA table_info("agent_memory_fts")'
                        ).fetchall()
                    ],
                    ["content", "tags_json"],
                )
                self.assertEqual(
                    repaired.scalar(
                        "SELECT count(*) FROM agent_memory_fts_docsize"
                    ),
                    1,
                )
                result = repaired.query_one(
                    """
                    SELECT m.id FROM agent_memory_fts
                    JOIN agent_memories m ON m.id = agent_memory_fts.rowid
                    WHERE agent_memory_fts MATCH ?
                    """,
                    ("ocean",),
                )
                self.assertEqual(int(result["id"]), memory_id)

                # The repaired UPDATE trigger must delete old terms and index
                # the new tags_json value using the same canonical projection.
                repaired.execute(
                    "UPDATE agent_memories SET tags_json = ? WHERE id = ?",
                    ('["violet"]', memory_id),
                )
                self.assertIsNotNone(
                    repaired.query_one(
                        "SELECT rowid FROM agent_memory_fts "
                        "WHERE agent_memory_fts MATCH ?",
                        ("violet",),
                    )
                )
                schema_version = int(repaired.scalar("PRAGMA schema_version"))
            finally:
                repaired.close()

            reopened = Database(path)
            try:
                # A second startup proves the canonical objects and performs no
                # replacement DDL.
                self.assertEqual(
                    int(reopened.scalar("PRAGMA schema_version")), schema_version
                )
            finally:
                reopened.close()


class DatabaseTransactionTests(unittest.TestCase):
    @staticmethod
    def _count(db: Database) -> int:
        return int(
            db.scalar(
                "SELECT count(*) FROM settings WHERE key LIKE 'transaction:%'"
            )
            or 0
        )

    def test_transaction_rolls_back_on_exception(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Database(Path(directory) / "platform.db")
            try:
                with self.assertRaises(RuntimeError):
                    with db.transaction() as connection:
                        connection.execute(
                            "INSERT INTO settings(key, value, updated_at) "
                            "VALUES ('transaction:first', 'one', 1)"
                        )
                        connection.execute(
                            "INSERT INTO settings(key, value, updated_at) "
                            "VALUES ('transaction:second', 'two', 1)"
                        )
                        raise RuntimeError("boom")
                self.assertEqual(self._count(db), 0)
            finally:
                db.close()

    def test_transaction_commits_on_success(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Database(Path(directory) / "platform.db")
            try:
                with db.transaction() as connection:
                    connection.execute(
                        "INSERT INTO settings(key, value, updated_at) "
                        "VALUES ('transaction:first', 'one', 1)"
                    )
                    connection.execute(
                        "INSERT INTO settings(key, value, updated_at) "
                        "VALUES ('transaction:second', 'two', 1)"
                    )
                self.assertEqual(self._count(db), 2)
            finally:
                db.close()

    def test_commit_failure_rolls_back_and_connection_remains_reusable(self):
        class FailFirstCommit:
            def __init__(self, connection):
                self.connection = connection
                self.failed = False
                self.rollbacks = 0

            def __getattr__(self, name):
                return getattr(self.connection, name)

            def commit(self):
                if not self.failed:
                    self.failed = True
                    raise sqlite3.OperationalError("simulated disk full during commit")
                return self.connection.commit()

            def rollback(self):
                self.rollbacks += 1
                return self.connection.rollback()

        with tempfile.TemporaryDirectory() as directory:
            db = Database(Path(directory) / "platform.db")
            try:
                holder = db._local.holder
                proxy = FailFirstCommit(holder.conn)
                holder.conn = proxy
                with self.assertRaises(sqlite3.OperationalError):
                    with db.transaction() as connection:
                        connection.execute(
                            "INSERT INTO settings(key, value, updated_at) "
                            "VALUES ('transaction:failed', 'one', 1)"
                        )
                self.assertEqual(proxy.rollbacks, 1)
                self.assertEqual(self._count(db), 0)

                with db.transaction() as connection:
                    connection.execute(
                        "INSERT INTO settings(key, value, updated_at) "
                        "VALUES ('transaction:recovered', 'one', 1)"
                    )
                self.assertEqual(self._count(db), 1)
            finally:
                db.close()


if __name__ == "__main__":
    unittest.main()
