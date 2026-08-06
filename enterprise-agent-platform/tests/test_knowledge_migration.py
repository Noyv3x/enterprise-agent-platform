from __future__ import annotations

import sqlite3
import struct
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from enterprise_agent_platform import db as db_module
from enterprise_agent_platform.db import Database, migrate_database


LEGACY_SOURCE_SCHEMA_VERSION = 2026072901
SOURCE_SCHEMA_VERSION = 2026080601
TARGET_SCHEMA_VERSION = 2026080602


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
    finally:
        database.close()
    with sqlite3.connect(path) as connection:
        connection.execute("DROP TABLE knowledge_document_files")
        connection.execute(
            "UPDATE schema_migrations SET version = ?",
            (SOURCE_SCHEMA_VERSION,),
        )


def create_legacy_source_database(path: Path) -> None:
    database = Database(path)
    try:
        database.execute(
            "INSERT INTO knowledge_documents("
            "id, title, summary, content, source, created_at, updated_at, content_hash"
            ") VALUES (11, 'Legacy', 'Preserved', 'legacy source', 'wiki', 1, 2, ?)",
            ("e" * 64,),
        )
        database.execute(
            "INSERT INTO durable_jobs("
            "kind, dedupe_key, payload_json, status, created_at, updated_at"
            ") VALUES ('cognee', 'retired:1', '{}', 'failed', 1, 1)"
        )
        database.execute(
            "INSERT INTO settings(key, value, secret, updated_at) "
            "VALUES ('cognee_backend', 'retired', 0, 1)"
        )
    finally:
        database.close()
    with sqlite3.connect(path) as connection:
        for table_name in (
            "knowledge_document_files",
            "knowledge_chunk_embeddings",
            "knowledge_chunks",
            "knowledge_document_index",
            "knowledge_index_generations",
        ):
            connection.execute(f'DROP TABLE "{table_name}"')
        connection.execute(
            "CREATE VIRTUAL TABLE knowledge_fts USING fts5("
            "title, summary, content, content='knowledge_documents', content_rowid='id')"
        )
        connection.executescript(
            """
            CREATE TRIGGER knowledge_ai AFTER INSERT ON knowledge_documents BEGIN
                INSERT INTO knowledge_fts(rowid, title, summary, content)
                VALUES (new.id, new.title, new.summary, new.content);
            END;
            CREATE TRIGGER knowledge_ad AFTER DELETE ON knowledge_documents BEGIN
                INSERT INTO knowledge_fts(knowledge_fts, rowid, title, summary, content)
                VALUES ('delete', old.id, old.title, old.summary, old.content);
            END;
            CREATE TRIGGER knowledge_au AFTER UPDATE ON knowledge_documents BEGIN
                INSERT INTO knowledge_fts(knowledge_fts, rowid, title, summary, content)
                VALUES ('delete', old.id, old.title, old.summary, old.content);
                INSERT INTO knowledge_fts(rowid, title, summary, content)
                VALUES (new.id, new.title, new.summary, new.content);
            END;
            """
        )
        connection.execute("INSERT INTO knowledge_fts(knowledge_fts) VALUES('rebuild')")
        connection.execute(
            "UPDATE schema_migrations SET version = ?",
            (LEGACY_SOURCE_SCHEMA_VERSION,),
        )


class KnowledgeFileMigrationTests(unittest.TestCase):
    def test_skipped_release_migration_replaces_retired_index_and_adds_files(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "platform.db"
            create_legacy_source_database(path)

            self.assertEqual(migrate_database(path), TARGET_SCHEMA_VERSION)
            database = Database(path)
            try:
                self.assertEqual(
                    database.query_one(
                        "SELECT id, title, content FROM knowledge_documents WHERE id = 11"
                    ),
                    {"id": 11, "title": "Legacy", "content": "legacy source"},
                )
                self.assertEqual(
                    database.scalar("SELECT count(*) FROM durable_jobs WHERE kind = 'cognee'"),
                    0,
                )
                self.assertIsNone(
                    database.query_one(
                        "SELECT value FROM settings WHERE key = 'cognee_backend'"
                    )
                )
                names = {
                    row["name"]
                    for row in database.query(
                        "SELECT name FROM sqlite_master WHERE name LIKE 'knowledge_%'"
                    )
                }
                self.assertNotIn("knowledge_fts", names)
                self.assertTrue(
                    {
                        "knowledge_index_generations",
                        "knowledge_document_index",
                        "knowledge_chunks",
                        "knowledge_chunk_embeddings",
                        "knowledge_document_files",
                    }.issubset(names)
                )
            finally:
                database.close()

    def test_direct_migration_preserves_native_knowledge_and_adds_file_table(self):
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
                self.assertIsNone(
                    connection.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'table' "
                        "AND name = 'knowledge_document_files'"
                    ).fetchone()
                )

    def test_migration_rejects_any_other_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "platform.db"
            create_source_database(path)
            with sqlite3.connect(path) as connection:
                connection.execute("UPDATE schema_migrations SET version = 2026080501")
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
                self.assertIsNone(
                    connection.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'table' "
                        "AND name = 'knowledge_document_files'"
                    ).fetchone()
                )

    def test_skipped_release_migration_failure_restores_legacy_baseline(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "platform.db"
            create_legacy_source_database(path)
            original = db_module._execute_transactional_schema

            def fail_after_schema(connection, schema):
                original(connection, schema)
                raise RuntimeError("simulated skipped-release interruption")

            with mock.patch.object(
                db_module,
                "_execute_transactional_schema",
                side_effect=fail_after_schema,
            ):
                with self.assertRaisesRegex(RuntimeError, "skipped-release"):
                    migrate_database(path)
            with sqlite3.connect(path) as connection:
                self.assertEqual(
                    connection.execute("SELECT version FROM schema_migrations").fetchone()[0],
                    LEGACY_SOURCE_SCHEMA_VERSION,
                )
                self.assertIsNotNone(
                    connection.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'table' "
                        "AND name = 'knowledge_fts'"
                    ).fetchone()
                )
                self.assertIsNone(
                    connection.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'table' "
                        "AND name = 'knowledge_index_generations'"
                    ).fetchone()
                )


if __name__ == "__main__":
    unittest.main()
