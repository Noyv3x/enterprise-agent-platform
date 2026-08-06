from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from enterprise_agent_platform import db as db_module
from enterprise_agent_platform.container_contract_generated import (
    DATABASE_SCHEMA_VERSION,
)
from enterprise_agent_platform.db import Database, migrate_database


SOURCE_SCHEMA_VERSION = 2026072901


def create_source_database(path: Path) -> dict[str, int]:
    database = Database(path)
    document_id = database.insert(
        "INSERT INTO knowledge_documents("
        "title, summary, content, source, created_at, updated_at, content_hash"
        ") VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            "Preserved runbook",
            "migration source",
            "alpha source content",
            "wiki",
            11,
            12,
            "a" * 64,
        ),
    )
    for index, status in enumerate(
        ("queued", "running", "succeeded", "failed", "needs_review"),
        start=1,
    ):
        database.execute(
            "INSERT INTO durable_jobs("
            "kind, dedupe_key, payload_json, status, created_at, updated_at"
            ") VALUES ('cognee', ?, ?, ?, 1, 1)",
            (f"retired:{index}", '{"content":"copied source"}', status),
        )
    unrelated_job_id = database.insert(
        "INSERT INTO durable_jobs("
        "kind, dedupe_key, payload_json, status, created_at, updated_at"
        ") VALUES ('agent', 'preserved', '{}', 'succeeded', 1, 1)"
    )
    for key in (
        "cognee_backend",
        "cognee_dataset",
        "cognee_ingest_background",
        "cognee_data_root_directory",
        "cognee_system_root_directory",
        "cognee_cache_root_directory",
        "cognee_logs_dir",
        "cognee_skip_connection_test",
    ):
        database.execute(
            "INSERT INTO settings(key, value, secret, updated_at) "
            "VALUES (?, 'retired', 0, 1)",
            (key,),
        )
    database.execute(
        "INSERT INTO settings(key, value, secret, updated_at) "
        "VALUES ('preserved_setting', 'yes', 0, 1)"
    )
    connection = database._conn
    for table_name in (
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
    connection.execute(
        "INSERT INTO knowledge_fts(knowledge_fts) VALUES('rebuild')"
    )
    connection.execute(
        "UPDATE schema_migrations SET version = ?",
        (SOURCE_SCHEMA_VERSION,),
    )
    connection.commit()
    database.close()
    return {"document_id": document_id, "unrelated_job_id": unrelated_job_id}


class KnowledgeBaselineMigrationTests(unittest.TestCase):
    def test_direct_migration_preserves_sources_and_removes_retired_index_data(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "platform.db"
            expected = create_source_database(path)

            version = migrate_database(path)

            self.assertEqual(version, DATABASE_SCHEMA_VERSION)
            self.assertEqual(migrate_database(path), DATABASE_SCHEMA_VERSION)
            database = Database(path)
            try:
                document = database.query_one(
                    "SELECT id, title, content, source, created_at, updated_at "
                    "FROM knowledge_documents WHERE id = ?",
                    (expected["document_id"],),
                )
                self.assertEqual(document, {
                    "id": expected["document_id"],
                    "title": "Preserved runbook",
                    "content": "alpha source content",
                    "source": "wiki",
                    "created_at": 11,
                    "updated_at": 12,
                })
                self.assertEqual(
                    database.scalar(
                        "SELECT count(*) FROM durable_jobs WHERE kind = 'cognee'"
                    ),
                    0,
                )
                self.assertIsNotNone(database.query_one(
                    "SELECT id FROM durable_jobs WHERE id = ?",
                    (expected["unrelated_job_id"],),
                ))
                self.assertEqual(
                    database.scalar(
                        "SELECT count(*) FROM settings WHERE key LIKE 'cognee_%'"
                    ),
                    0,
                )
                self.assertEqual(
                    database.scalar(
                        "SELECT value FROM settings WHERE key = 'preserved_setting'"
                    ),
                    "yes",
                )
                names = {
                    row["name"]
                    for row in database.query(
                        "SELECT name FROM sqlite_master WHERE name LIKE 'knowledge_%'"
                    )
                }
                self.assertNotIn("knowledge_fts", names)
                self.assertFalse(any(name.startswith("knowledge_fts_") for name in names))
                self.assertTrue({
                    "knowledge_documents",
                    "knowledge_index_generations",
                    "knowledge_document_index",
                    "knowledge_chunks",
                    "knowledge_chunk_embeddings",
                }.issubset(names))
                self.assertEqual(
                    database.scalar("SELECT count(*) FROM knowledge_index_generations"),
                    0,
                )
            finally:
                database.close()

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
                    connection.execute(
                        "SELECT version FROM schema_migrations"
                    ).fetchone()[0],
                    SOURCE_SCHEMA_VERSION,
                )
                self.assertIsNotNone(connection.execute(
                    "SELECT name FROM sqlite_master "
                    "WHERE type = 'table' AND name = 'knowledge_fts'"
                ).fetchone())

    def test_migration_rejects_any_other_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "platform.db"
            create_source_database(path)
            with sqlite3.connect(path) as connection:
                connection.execute(
                    "UPDATE schema_migrations SET version = 2026072801"
                )

            with self.assertRaisesRegex(
                sqlite3.DatabaseError,
                "does not match the current baseline marker",
            ):
                migrate_database(path)

    def test_migration_failure_rolls_back_retired_objects_and_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "platform.db"
            create_source_database(path)
            with mock.patch.object(
                db_module,
                "_execute_transactional_schema",
                side_effect=sqlite3.OperationalError("injected DDL failure"),
            ):
                with self.assertRaisesRegex(
                    sqlite3.OperationalError,
                    "injected DDL failure",
                ):
                    migrate_database(path)

            with sqlite3.connect(path) as connection:
                self.assertEqual(
                    connection.execute(
                        "SELECT version FROM schema_migrations"
                    ).fetchone()[0],
                    SOURCE_SCHEMA_VERSION,
                )
                self.assertEqual(
                    connection.execute(
                        "SELECT count(*) FROM durable_jobs WHERE kind = 'cognee'"
                    ).fetchone()[0],
                    5,
                )
                self.assertIsNotNone(connection.execute(
                    "SELECT name FROM sqlite_master "
                    "WHERE type = 'table' AND name = 'knowledge_fts'"
                ).fetchone())
                self.assertIsNone(connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table' "
                    "AND name = 'knowledge_index_generations'"
                ).fetchone())


if __name__ == "__main__":
    unittest.main()
