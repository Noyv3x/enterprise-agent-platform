from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from enterprise_agent_platform.container_contract_generated import DATABASE_SCHEMA_VERSION
from enterprise_agent_platform.db import Database, assert_existing_database_version, migrate_database


class DatabaseMigrationTests(unittest.TestCase):
    def test_fresh_migration_and_current_retry_preserve_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "platform.db"
            self.assertEqual(migrate_database(path, data_dir=root), DATABASE_SCHEMA_VERSION)
            database = Database(path)
            database.execute("INSERT INTO settings VALUES ('retained', 'value', 0, 1)")
            before = list(database._conn.iterdump())
            database.close()
            self.assertEqual(migrate_database(path, data_dir=root), DATABASE_SCHEMA_VERSION)
            database = Database(path)
            try:
                self.assertEqual(list(database._conn.iterdump()), before)
                self.assertEqual(database.scalar("PRAGMA journal_mode"), "wal")
                self.assertEqual(database.scalar("PRAGMA foreign_keys"), 1)
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            finally:
                database.close()

    def test_unsupported_versions_are_rejected_without_writes(self):
        for version in (2026080801, DATABASE_SCHEMA_VERSION + 1):
            with self.subTest(version=version), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                path = root / "platform.db"
                database = Database(path)
                database.execute("UPDATE schema_migrations SET version = ?", (version,))
                database.close()
                original = path.read_bytes()
                for action in (lambda: assert_existing_database_version(path),
                               lambda: Database(path),
                               lambda: migrate_database(path, data_dir=root)):
                    with self.assertRaises(sqlite3.DatabaseError):
                        action()
                    self.assertEqual(path.read_bytes(), original)

    def test_missing_or_malformed_version_is_not_fresh(self):
        for statement in ("DROP TABLE schema_migrations", "DELETE FROM schema_migrations",
                          "UPDATE schema_migrations SET version = 1"):
            with self.subTest(statement=statement), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "platform.db"
                database = Database(path)
                database.execute(statement)
                database.close()
                original = path.read_bytes()
                with self.assertRaises(sqlite3.DatabaseError):
                    migrate_database(path, data_dir=path.parent)
                self.assertEqual(path.read_bytes(), original)

    def test_nonzero_unversioned_database_is_never_initialized(self):
        for schema in (
            "CREATE VIEW retained_view AS SELECT 7",
            "CREATE TABLE discarded(id INTEGER PRIMARY KEY AUTOINCREMENT); DROP TABLE discarded",
            "PRAGMA user_version = 7",
        ):
            with self.subTest(schema=schema), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "platform.db"
                with sqlite3.connect(path) as connection:
                    connection.executescript(schema)
                path.chmod(0o600)
                original = path.read_bytes()
                self.assertGreater(len(original), 0)
                for action in (lambda: assert_existing_database_version(path),
                               lambda: Database(path),
                               lambda: migrate_database(path, data_dir=path.parent)):
                    with self.assertRaises(sqlite3.DatabaseError):
                        action()
                    self.assertEqual(path.read_bytes(), original)
                    self.assertFalse(Path(str(path) + "-wal").exists())
                    self.assertFalse(Path(str(path) + "-shm").exists())

    def test_invalid_queue_watermark_does_not_replay_history(self):
        for watermark in ("-1", "not-an-integer", "1.5", None):
            with self.subTest(watermark=watermark), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "platform.db"
                database = Database(path)
                database.execute("INSERT INTO users(id, username, display_name, password_hash, created_at) "
                                 "VALUES (1, 'member', 'Member', 'unused', 1)")
                database.execute("INSERT INTO messages(scope_type, scope_id, author_type, user_id, content, created_at) "
                                 "VALUES ('private', '1', 'user', 1, 'historical request', 1)")
                if watermark is None:
                    database.execute("DELETE FROM settings WHERE key = 'durable_agent_jobs_start_message_id'")
                else:
                    database.execute("UPDATE settings SET value = ? "
                                     "WHERE key = 'durable_agent_jobs_start_message_id'", (watermark,))
                before = list(database._conn.iterdump())
                database.close()
                with self.assertRaises(sqlite3.DatabaseError):
                    migrate_database(path, data_dir=path.parent)
                database = Database(path)
                try:
                    self.assertEqual(list(database._conn.iterdump()), before)
                    self.assertEqual(database.scalar("SELECT COUNT(*) FROM durable_jobs"), 0)
                    self.assertIsNone(database.scalar(
                        "SELECT value FROM settings WHERE key = 'durable_work_queue_v1'"
                    ))
                finally:
                    database.close()

    def test_current_queue_migration_rolls_back_and_can_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "platform.db"
            database = Database(path)
            database.execute("INSERT INTO users(id, username, display_name, password_hash, created_at) "
                             "VALUES (1, 'member', 'Member', 'unused', 1)")
            database.execute("INSERT INTO messages(scope_type, scope_id, author_type, user_id, content, created_at) "
                             "VALUES ('private', '1', 'user', 1, 'pending request', 1)")
            database.execute("CREATE TRIGGER reject_queue_marker BEFORE INSERT ON settings "
                             "WHEN new.key = 'durable_work_queue_v1' BEGIN "
                             "SELECT RAISE(ABORT, 'injected failure'); END")
            database.close()
            with self.assertRaises(sqlite3.IntegrityError):
                migrate_database(path, data_dir=root)
            database = Database(path)
            self.assertEqual(database.scalar("SELECT COUNT(*) FROM durable_jobs"), 0)
            self.assertIsNone(database.scalar("SELECT value FROM settings WHERE key = 'durable_work_queue_v1'"))
            database.execute("DROP TRIGGER reject_queue_marker")
            database.close()
            migrate_database(path, data_dir=root)
            database = Database(path)
            try:
                job = database.query_one("SELECT dedupe_key, status, payload_json FROM durable_jobs")
                assert job is not None
                self.assertEqual(job["dedupe_key"], "message:1")
                self.assertEqual(job["status"], "queued")
                self.assertIn('pending request', job["payload_json"])
            finally:
                database.close()


if __name__ == "__main__":
    unittest.main()
