from __future__ import annotations

import sqlite3
import struct
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from enterprise_agent_platform import db as db_module
from enterprise_agent_platform.db import Database, migrate_database


SOURCE_SCHEMA_VERSION = 2026080602
TARGET_SCHEMA_VERSION = 2026080801


def create_source_database(path: Path) -> None:
    database = Database(path)
    try:
        with database.transaction(immediate=True) as connection:
            connection.execute(
                "INSERT INTO knowledge_documents("
                "id, title, summary, content, source, created_at, updated_at, content_hash"
                ") VALUES (7, 'Existing', 'Summary', 'alpha source', 'manual', 1, 1, ?)",
                ("a" * 64,),
            )
            connection.execute(
                "INSERT INTO knowledge_index_generations("
                "id, config_hash, embedding_base_url, embedding_model, "
                "embedding_dimensions, chunker_version, status, document_count, "
                "ready_document_count, created_at, updated_at, activated_at"
                ") VALUES (3, ?, 'https://embeddings.example/v1', 'model', 3, "
                "'markdown-structure-v1', 'active', 1, 1, 1, 1, 1)",
                ("b" * 64,),
            )
            connection.execute(
                "INSERT INTO knowledge_document_index("
                "generation_id, document_id, expected_hash, status, chunk_count, "
                "created_at, updated_at) VALUES (3, 7, ?, 'ready', 1, 1, 1)",
                ("a" * 64,),
            )
            connection.execute(
                "INSERT INTO knowledge_chunks("
                "generation_id, chunk_id, document_id, chunk_index, title_path, "
                "content, char_start, char_end, chunk_hash, created_at"
                ") VALUES (3, ?, 7, 0, 'Existing', 'alpha source', 0, 12, ?, 1)",
                ("c" * 64, "d" * 64),
            )
            connection.execute(
                "INSERT INTO knowledge_chunk_embeddings("
                "generation_id, chunk_id, dimensions, vector, norm, created_at"
                ") VALUES (3, ?, 3, ?, 1.0, 1)",
                ("c" * 64, struct.pack("<3f", 1.0, 0.0, 0.0)),
            )
            connection.execute(
                "INSERT INTO users(id, username, display_name, password_hash, "
                "role, permission_group, created_at) "
                "VALUES (7, 'existing-user', 'Existing User', 'hash', "
                "'member', 'member', 1)"
            )
    finally:
        database.close()
    with sqlite3.connect(path) as connection:
        connection.execute("DROP TABLE sylver_platform_credentials")
        connection.execute("DROP TABLE sylver_platform_connections")
        connection.execute(
            "UPDATE schema_migrations SET version = ?",
            (SOURCE_SCHEMA_VERSION,),
        )


class SylverPlatformMigrationTests(unittest.TestCase):
    def test_direct_migration_preserves_existing_data_and_adds_connection_tables(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "platform.db"
            create_source_database(path)

            self.assertEqual(migrate_database(path), TARGET_SCHEMA_VERSION)
            database = Database(path)
            try:
                self.assertEqual(database.scalar("SELECT id FROM knowledge_documents"), 7)
                self.assertEqual(
                    database.scalar("SELECT id FROM knowledge_index_generations"), 3
                )
                self.assertEqual(database.scalar("SELECT count(*) FROM knowledge_chunks"), 1)
                self.assertEqual(
                    database.scalar("SELECT count(*) FROM knowledge_chunk_embeddings"), 1
                )
                self.assertEqual(
                    database.scalar("SELECT count(*) FROM knowledge_document_files"), 0
                )
                self.assertEqual(database.scalar("SELECT count(*) FROM users"), 1)
                self.assertEqual(
                    database.scalar("SELECT count(*) FROM sylver_platform_connections"), 0
                )
                self.assertEqual(
                    database.scalar("SELECT count(*) FROM sylver_platform_credentials"), 0
                )
            finally:
                database.close()

            self.assertEqual(migrate_database(path), TARGET_SCHEMA_VERSION)

    def test_normal_database_open_refuses_the_source_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "platform.db"
            create_source_database(path)
            with self.assertRaisesRegex(
                sqlite3.DatabaseError,
                "does not match the current baseline marker",
            ):
                Database(path)

    def test_migration_rejects_unknown_source_structure_without_modification(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "platform.db"
            create_source_database(path)
            with sqlite3.connect(path) as connection:
                connection.execute(
                    "CREATE TABLE unexpected_business_table(id INTEGER PRIMARY KEY)"
                )

            with self.assertRaisesRegex(
                sqlite3.DatabaseError,
                "outside the current baseline: unexpected_business_table",
            ):
                migrate_database(path)
            with sqlite3.connect(path) as connection:
                self.assertEqual(
                    connection.execute("SELECT version FROM schema_migrations").fetchone()[0],
                    SOURCE_SCHEMA_VERSION,
                )
                for table_name in (
                    "sylver_platform_connections",
                    "sylver_platform_credentials",
                ):
                    self.assertIsNone(
                        connection.execute(
                            "SELECT name FROM sqlite_master WHERE type = 'table' "
                            "AND name = ?",
                            (table_name,),
                        ).fetchone()
                    )

    def test_migration_rejects_any_other_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "platform.db"
            create_source_database(path)
            with sqlite3.connect(path) as connection:
                connection.execute("UPDATE schema_migrations SET version = 2026080601")
            with self.assertRaisesRegex(
                sqlite3.DatabaseError,
                "does not match the current baseline marker",
            ):
                migrate_database(path)

    def test_migration_failure_rolls_back_table_and_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "platform.db"
            create_source_database(path)
            original = db_module._execute_transactional_schema

            def fail_after_schema(connection, schema):
                original(connection, schema)
                raise RuntimeError("simulated migration interruption")

            with mock.patch.object(
                db_module,
                "_execute_transactional_schema",
                side_effect=fail_after_schema,
            ):
                with self.assertRaisesRegex(RuntimeError, "simulated"):
                    migrate_database(path)
            with sqlite3.connect(path) as connection:
                self.assertEqual(
                    connection.execute("SELECT version FROM schema_migrations").fetchone()[0],
                    SOURCE_SCHEMA_VERSION,
                )
                for table_name in (
                    "sylver_platform_connections",
                    "sylver_platform_credentials",
                ):
                    self.assertIsNone(
                        connection.execute(
                            "SELECT name FROM sqlite_master WHERE type = 'table' "
                            "AND name = ?",
                            (table_name,),
                        ).fetchone()
                    )

    def test_current_baseline_rejects_missing_connection_primary_keys(self):
        for table_name in (
            "sylver_platform_connections",
            "sylver_platform_credentials",
        ):
            with self.subTest(table_name=table_name), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "platform.db"
                database = Database(path)
                database.close()
                with sqlite3.connect(path) as connection:
                    connection.execute("PRAGMA foreign_keys = OFF")
                    if table_name == "sylver_platform_credentials":
                        connection.execute("DROP TABLE sylver_platform_credentials")
                        connection.execute(
                            """
                            CREATE TABLE sylver_platform_credentials (
                                owner_user_id INTEGER NOT NULL
                                    REFERENCES sylver_platform_connections(owner_user_id)
                                    ON DELETE CASCADE,
                                token TEXT NOT NULL CHECK (length(token) > 0),
                                updated_at INTEGER NOT NULL
                            )
                            """
                        )
                    else:
                        connection.execute("DROP TABLE sylver_platform_credentials")
                        connection.execute("DROP TABLE sylver_platform_connections")
                        connection.execute(
                            """
                            CREATE TABLE sylver_platform_connections (
                                owner_user_id INTEGER NOT NULL
                                    REFERENCES users(id) ON DELETE CASCADE,
                                base_url TEXT NOT NULL CHECK (length(base_url) > 0),
                                remote_user_id INTEGER NOT NULL CHECK (remote_user_id > 0),
                                username TEXT NOT NULL CHECK (length(username) > 0),
                                full_name TEXT NOT NULL DEFAULT '',
                                title TEXT NOT NULL DEFAULT '',
                                email TEXT NOT NULL DEFAULT '',
                                role TEXT NOT NULL DEFAULT '',
                                verified_at INTEGER NOT NULL,
                                created_at INTEGER NOT NULL,
                                updated_at INTEGER NOT NULL,
                                UNIQUE(base_url, remote_user_id)
                            )
                            """
                        )
                        connection.execute(
                            """
                            CREATE TABLE sylver_platform_credentials (
                                owner_user_id INTEGER PRIMARY KEY
                                    REFERENCES sylver_platform_connections(owner_user_id)
                                    ON DELETE CASCADE,
                                token TEXT NOT NULL CHECK (length(token) > 0),
                                updated_at INTEGER NOT NULL
                            )
                            """
                        )
                with self.assertRaisesRegex(
                    sqlite3.DatabaseError,
                    "non-current primary key",
                ):
                    Database(path)


if __name__ == "__main__":
    unittest.main()
