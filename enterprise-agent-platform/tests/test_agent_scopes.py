from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from enterprise_agent_platform.agent_scopes import AgentScopeManager
from enterprise_agent_platform.db import Database

from test_platform import make_config


class AgentScopeSessionTests(unittest.TestCase):
    def test_repeated_ensure_uses_read_only_scope_fast_path(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            db = Database(config.db_path)
            try:
                manager = AgentScopeManager(config, db)
                first = manager.ensure_private_scope(1)
                updated_at = db.scalar(
                    "SELECT updated_at FROM agent_scopes WHERE scope_key = ?",
                    (first.scope_key,),
                )
                with (
                    mock.patch.object(manager, "_write_scope_marker") as write_marker,
                    mock.patch.object(db, "transaction", wraps=db.transaction) as transaction,
                ):
                    second = manager.ensure_private_scope(1)
                self.assertEqual(second, first)
                write_marker.assert_not_called()
                transaction.assert_not_called()
                self.assertEqual(
                    db.scalar(
                        "SELECT updated_at FROM agent_scopes WHERE scope_key = ?",
                        (first.scope_key,),
                    ),
                    updated_at,
                )
            finally:
                db.close()

    def test_cached_scope_rejects_workspace_replaced_by_symlink(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            db = Database(config.db_path)
            try:
                manager = AgentScopeManager(config, db)
                scope = manager.ensure_private_scope(1)
                workspace = Path(scope.workspace_path)
                original = workspace.with_name(f"{workspace.name}-original")
                workspace.rename(original)
                escape = Path(td) / "outside-workspace"
                escape.mkdir()
                workspace.symlink_to(escape, target_is_directory=True)

                with self.assertRaisesRegex(
                    ValueError,
                    "outside the managed workspace root|must not contain symlink",
                ):
                    manager.ensure_private_scope(1)
            finally:
                db.close()

    def test_existing_valid_scope_is_reused_after_manager_restart(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            db = Database(config.db_path)
            try:
                first = AgentScopeManager(config, db).ensure_private_scope(1)
                restarted = AgentScopeManager(config, db)
                with (
                    mock.patch.object(restarted, "_write_scope_marker") as write_marker,
                    mock.patch.object(db, "transaction", wraps=db.transaction) as transaction,
                ):
                    second = restarted.ensure_private_scope(1)
                self.assertEqual(second, first)
                write_marker.assert_not_called()
                transaction.assert_not_called()
            finally:
                db.close()

    def test_session_update_refreshes_scope_cache(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            db = Database(config.db_path)
            try:
                manager = AgentScopeManager(config, db)
                original = manager.ensure_private_scope(1)
                manager.update_session_id(original.scope_key, "updated-session")
                self.assertEqual(
                    manager.ensure_private_scope(1).session_id,
                    "updated-session",
                )
            finally:
                db.close()

    def test_session_updates_are_scoped_and_recorded_for_current_lifecycle(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            db = Database(config.db_path)
            try:
                db.execute(
                    """
                    INSERT INTO users(
                        id, username, display_name, password_hash, role,
                        permission_group, created_at
                    ) VALUES (1, 'one', 'One', 'hash', 'member', 'member', 1)
                    """
                )
                manager = AgentScopeManager(config, db)
                private = manager.ensure_private_scope(1)
                channel = manager.ensure_channel_scope("7")

                self.assertEqual(private.session_id, "ubitech-private-u1")
                self.assertEqual(channel.session_id, "ubitech-channel-7-main-agent")

                manager.update_session_id(private.scope_key, "private-compacted")
                manager.update_session_id(channel.scope_key, "channel-compacted")

                updated_private = manager.get_scope(private.scope_key)
                updated_channel = manager.get_scope(channel.scope_key)
                self.assertEqual(updated_private.session_id, "private-compacted")
                self.assertEqual(updated_channel.session_id, "channel-compacted")
                self.assertTrue(
                    manager.session_belongs_to_current_lifecycle(
                        private.scope_key,
                        "private-compacted",
                    )
                )
                self.assertTrue(
                    manager.session_belongs_to_current_lifecycle(
                        channel.scope_key,
                        "channel-compacted",
                    )
                )
                self.assertFalse(
                    manager.session_belongs_to_current_lifecycle(
                        private.scope_key,
                        "channel-compacted",
                    )
                )
            finally:
                db.close()

    def test_runtime_session_state_persists_across_database_reopen(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            db = Database(config.db_path)
            try:
                table_names = {
                    row["name"]
                    for row in db.query("SELECT name FROM sqlite_master WHERE type = 'table'")
                }
                self.assertNotIn("private_agents", table_names)
                self.assertNotIn("agent_scope_sessions", table_names)
                scope_columns = {
                    row["name"] for row in db.query("PRAGMA table_info(agent_scopes)")
                }
                self.assertFalse(any(name.startswith("legacy_container") for name in scope_columns))

                db.execute(
                    """
                    INSERT INTO users(
                        id, username, display_name, password_hash, role,
                        permission_group, created_at
                    ) VALUES (1, 'one', 'One', 'hash', 'member', 'member', 1)
                    """
                )
                manager = AgentScopeManager(config, db)
                initial = manager.ensure_private_scope(1)
                manager.update_session_id(initial.scope_key, "runtime-compacted-session")
                db.execute(
                    """
                    INSERT INTO agent_memories(
                        scope_key, target, owner_user_id, content, tags_json,
                        created_at, updated_at
                    ) VALUES (?, 'memory', 1, 'persistent memory', '[]', 1, 1)
                    """,
                    (initial.scope_key,),
                )
                db.execute(
                    """
                    UPDATE agent_scopes
                    SET session_id = 'metadata-session', lifecycle_id = 'metadata-lifecycle'
                    WHERE scope_key = ?
                    """,
                    (initial.scope_key,),
                )
                expected_lifecycle_id = initial.lifecycle_id
            finally:
                db.close()

            reopened = Database(config.db_path)
            try:
                manager = AgentScopeManager(config, reopened)
                persisted = manager.ensure_private_scope(1)
                self.assertEqual(persisted.session_id, "runtime-compacted-session")
                self.assertEqual(persisted.lifecycle_id, expected_lifecycle_id)
                self.assertTrue(
                    manager.session_belongs_to_current_lifecycle(
                        persisted.scope_key,
                        persisted.session_id,
                    )
                )
                self.assertEqual(
                    reopened.scalar(
                        "SELECT content FROM agent_memories WHERE scope_key = ?",
                        (persisted.scope_key,),
                    ),
                    "persistent memory",
                )

                rotated = manager.rotate_session(persisted.scope_key)
                self.assertNotEqual(rotated.session_id, persisted.session_id)
                self.assertNotEqual(rotated.lifecycle_id, persisted.lifecycle_id)
            finally:
                reopened.close()

            verified = Database(config.db_path)
            try:
                manager = AgentScopeManager(config, verified)
                persisted = manager.get_private_scope(1)
                self.assertIsNotNone(persisted)
                self.assertEqual(persisted.session_id, rotated.session_id)
                self.assertEqual(persisted.lifecycle_id, rotated.lifecycle_id)
                self.assertTrue(
                    manager.session_belongs_to_current_lifecycle(
                        persisted.scope_key,
                        persisted.session_id,
                    )
                )
            finally:
                verified.close()

    def test_attachment_sources_are_normalized_without_losing_metadata(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            db = Database(config.db_path)
            try:
                db.execute(
                    """
                    INSERT INTO messages(
                        id, scope_type, scope_id, author_type, content, created_at
                    ) VALUES (7, 'private', '1', 'agent', 'generated file', 10)
                    """
                )
            finally:
                db.close()

            raw = sqlite3.connect(config.db_path)
            try:
                raw.executescript(
                    """
                    DROP INDEX idx_attachments_message;
                    DROP INDEX idx_attachments_scope;
                    DROP TABLE attachments;
                    CREATE TABLE attachments (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
                        scope_type TEXT NOT NULL CHECK(scope_type IN ('channel', 'private')),
                        scope_id TEXT NOT NULL,
                        uploader_user_id INTEGER REFERENCES users(id),
                        source TEXT NOT NULL DEFAULT 'upload'
                            CHECK(source IN ('upload', 'runtime_output')),
                        filename TEXT NOT NULL,
                        storage_path TEXT NOT NULL UNIQUE,
                        mime_type TEXT NOT NULL,
                        size_bytes INTEGER NOT NULL,
                        sha256 TEXT NOT NULL,
                        created_at INTEGER NOT NULL
                    );
                    CREATE INDEX idx_attachments_message ON attachments(message_id, id);
                    CREATE INDEX idx_attachments_scope ON attachments(scope_type, scope_id, id);
                    INSERT INTO attachments(
                        id, message_id, scope_type, scope_id, uploader_user_id, source,
                        filename, storage_path, mime_type, size_bytes, sha256, created_at
                    ) VALUES (
                        11, 7, 'private', '1', NULL, 'runtime_output',
                        'report.txt', '/managed/report.txt', 'text/plain', 12,
                        'abc123', 20
                    );
                    """
                )
                raw.commit()
            finally:
                raw.close()

            normalized = Database(config.db_path)
            try:
                self.assertEqual(
                    normalized.query_one(
                        """
                        SELECT id, message_id, scope_type, scope_id, uploader_user_id,
                               source, filename, storage_path, mime_type, size_bytes,
                               sha256, created_at
                        FROM attachments WHERE id = 11
                        """
                    ),
                    {
                        "id": 11,
                        "message_id": 7,
                        "scope_type": "private",
                        "scope_id": "1",
                        "uploader_user_id": None,
                        "source": "agent_generated",
                        "filename": "report.txt",
                        "storage_path": "/managed/report.txt",
                        "mime_type": "text/plain",
                        "size_bytes": 12,
                        "sha256": "abc123",
                        "created_at": 20,
                    },
                )
                schema = normalized.scalar(
                    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'attachments'"
                )
                compact_schema = "".join(str(schema).lower().split())
                self.assertIn(
                    "check(sourcein('upload','agent_generated'))",
                    compact_schema,
                )
                self.assertNotIn("runtime_output", compact_schema)
                self.assertEqual(normalized.query("PRAGMA foreign_key_check"), [])
                with self.assertRaises(sqlite3.IntegrityError):
                    normalized.execute(
                        """
                        INSERT INTO attachments(
                            message_id, scope_type, scope_id, source, filename,
                            storage_path, mime_type, size_bytes, sha256, created_at
                        ) VALUES (7, 'private', '1', 'runtime_output', 'bad.txt',
                                  '/managed/bad.txt', 'text/plain', 1, 'bad', 21)
                        """
                    )
            finally:
                normalized.close()


if __name__ == "__main__":
    unittest.main()
