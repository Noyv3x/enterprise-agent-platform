from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from enterprise_agent_platform.agent_scopes import AgentScopeManager
from enterprise_agent_platform.container_contract_generated import DATABASE_SCHEMA_VERSION
from enterprise_agent_platform.db import Database

from test_platform import make_config


class AgentScopeSessionTests(unittest.TestCase):
    def test_scope_uses_stable_sandbox_identity_and_relative_database_workspace(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            db = Database(config.db_path)
            try:
                manager = AgentScopeManager(config, db)
                scope = manager.ensure_private_scope(1)
                stored = db.query_one(
                    "SELECT workspace_path, sandbox_id, execution_backend FROM agent_scopes WHERE scope_key = ?",
                    (scope.scope_key,),
                )
                self.assertEqual(stored["workspace_path"], "user-1")
                self.assertEqual(stored["execution_backend"], "sandbox")
                self.assertEqual(stored["sandbox_id"], scope.sandbox_id)
                self.assertTrue(Path(scope.workspace_path).is_absolute())
                execution = scope.to_execution_dict()
                self.assertEqual(execution["backend"], "sandbox")
                self.assertEqual(execution["workspace_path"], "/workspace")
                self.assertEqual(execution["workspace_id"], "user-1")
            finally:
                db.close()

    def test_legacy_host_scope_schema_is_rebuilt_and_preserves_sessions(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            connection = sqlite3.connect(config.db_path)
            connection.executescript(
                """
                PRAGMA foreign_keys=OFF;
                CREATE TABLE agent_scopes (
                    scope_key TEXT PRIMARY KEY,
                    scope_type TEXT NOT NULL,
                    scope_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    lifecycle_id TEXT NOT NULL DEFAULT '',
                    workspace_path TEXT NOT NULL,
                    execution_backend TEXT NOT NULL DEFAULT 'host' CHECK(execution_backend = 'host'),
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    UNIQUE(scope_type, scope_id)
                );
                CREATE TABLE agent_runtime_scopes (
                    scope_key TEXT PRIMARY KEY REFERENCES agent_scopes(scope_key) ON DELETE CASCADE,
                    session_id TEXT NOT NULL,
                    lifecycle_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE agent_scope_sessions (
                    scope_key TEXT NOT NULL REFERENCES agent_scopes(scope_key) ON DELETE CASCADE,
                    lifecycle_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY(scope_key, lifecycle_id, session_id)
                );
                CREATE INDEX idx_agent_scope_sessions_lookup
                    ON agent_scope_sessions(scope_key, lifecycle_id, session_id);
                CREATE TABLE agent_runtime_scope_sessions (
                    scope_key TEXT NOT NULL REFERENCES agent_runtime_scopes(scope_key) ON DELETE CASCADE,
                    lifecycle_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY(scope_key, lifecycle_id, session_id)
                );
                INSERT INTO agent_scopes VALUES(
                    'private:1', 'private', '1', 'legacy-meta', 'legacy-meta-life',
                    '/old/source/data/workspaces/user-1', 'host', 1, 1
                );
                INSERT INTO agent_runtime_scopes VALUES(
                    'private:1', 'legacy-runtime', 'legacy-runtime-life', 1, 1
                );
                INSERT INTO agent_scope_sessions VALUES
                    ('private:1', 'retired-life', 'retired-session-1', 1),
                    ('private:1', 'retired-life', 'retired-session-2', 2);
                INSERT INTO agent_runtime_scope_sessions VALUES(
                    'private:1', 'legacy-runtime-life', 'legacy-runtime', 1
                );
                """
            )
            connection.commit()
            connection.close()

            db = Database(config.db_path)
            try:
                manager = AgentScopeManager(config, db)
                scope = manager.get_scope("private:1")
                self.assertIsNotNone(scope)
                self.assertEqual(scope.session_id, "legacy-runtime")
                self.assertEqual(scope.lifecycle_id, "legacy-runtime-life")
                self.assertEqual(scope.workspace_id, "user-1")
                self.assertTrue(scope.sandbox_id.startswith("agent-"))
                self.assertEqual(
                    db.scalar("SELECT execution_backend FROM agent_scopes WHERE scope_key = 'private:1'"),
                    "sandbox",
                )
                self.assertEqual(
                    db.scalar(
                        "SELECT COUNT(*) FROM schema_migrations WHERE version = ?",
                        (DATABASE_SCHEMA_VERSION,),
                    ),
                    1,
                )
                self.assertIsNone(
                    db.query_one(
                        "SELECT name FROM sqlite_master "
                        "WHERE type = 'table' AND name = 'agent_scope_sessions'"
                    )
                )
                self.assertEqual(
                    db.query_one(
                        "SELECT session_id, lifecycle_id "
                        "FROM agent_runtime_scopes WHERE scope_key = 'private:1'"
                    ),
                    {
                        "session_id": "legacy-runtime",
                        "lifecycle_id": "legacy-runtime-life",
                    },
                )
                self.assertFalse(db.query("PRAGMA foreign_key_check"))
                sandbox_id = scope.sandbox_id
            finally:
                db.close()

            reopened = Database(config.db_path)
            try:
                self.assertEqual(
                    reopened.scalar(
                        "SELECT sandbox_id FROM agent_scopes "
                        "WHERE scope_key = 'private:1'"
                    ),
                    sandbox_id,
                )
                self.assertEqual(
                    reopened.scalar(
                        "SELECT COUNT(*) FROM schema_migrations WHERE version = ?",
                        (DATABASE_SCHEMA_VERSION,),
                    ),
                    1,
                )
                self.assertFalse(reopened.query("PRAGMA foreign_key_check"))
            finally:
                reopened.close()

            with mock.patch(
                "enterprise_agent_platform.db.DATABASE_SCHEMA_VERSION",
                DATABASE_SCHEMA_VERSION + 1,
            ):
                future_reopen = Database(config.db_path)
            try:
                self.assertEqual(
                    future_reopen.scalar(
                        "SELECT COUNT(*) FROM schema_migrations "
                        "WHERE name = 'agent-scopes-container-sandbox-v2'"
                    ),
                    1,
                )
            finally:
                future_reopen.close()

    def test_legacy_scope_migration_rolls_back_on_foreign_key_violation(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            connection = sqlite3.connect(config.db_path)
            connection.executescript(
                """
                PRAGMA foreign_keys=OFF;
                CREATE TABLE agent_scopes (
                    scope_key TEXT PRIMARY KEY,
                    scope_type TEXT NOT NULL,
                    scope_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    lifecycle_id TEXT NOT NULL DEFAULT '',
                    workspace_path TEXT NOT NULL,
                    execution_backend TEXT NOT NULL DEFAULT 'host'
                        CHECK(execution_backend = 'host'),
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    UNIQUE(scope_type, scope_id)
                );
                CREATE TABLE agent_runtime_scopes (
                    scope_key TEXT PRIMARY KEY
                        REFERENCES agent_scopes(scope_key) ON DELETE CASCADE,
                    session_id TEXT NOT NULL,
                    lifecycle_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE agent_scope_sessions (
                    scope_key TEXT NOT NULL
                        REFERENCES agent_scopes(scope_key) ON DELETE CASCADE,
                    lifecycle_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY(scope_key, lifecycle_id, session_id)
                );
                CREATE TABLE agent_runtime_scope_sessions (
                    scope_key TEXT NOT NULL
                        REFERENCES agent_runtime_scopes(scope_key) ON DELETE CASCADE,
                    lifecycle_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY(scope_key, lifecycle_id, session_id)
                );
                INSERT INTO agent_scopes VALUES(
                    'private:1', 'private', '1', 'legacy-meta', 'legacy-meta-life',
                    '/old/source/data/workspaces/user-1', 'host', 1, 1
                );
                INSERT INTO agent_scope_sessions VALUES
                    ('private:1', 'legacy-meta-life', 'retired-session-1', 1),
                    ('private:1', 'legacy-meta-life', 'retired-session-2', 2);
                INSERT INTO agent_runtime_scopes VALUES(
                    'private:missing', 'orphan', 'orphan-life', 1, 1
                );
                """
            )
            connection.commit()
            connection.close()

            with self.assertRaisesRegex(
                sqlite3.IntegrityError,
                "foreign-key violations",
            ):
                Database(config.db_path)

            verification = sqlite3.connect(config.db_path)
            try:
                columns = {
                    row[1]
                    for row in verification.execute(
                        "PRAGMA table_info(agent_scopes)"
                    ).fetchall()
                }
                tables = {
                    row[0]
                    for row in verification.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'table'"
                    ).fetchall()
                }
                self.assertNotIn("sandbox_id", columns)
                self.assertNotIn("agent_scopes_legacy", tables)
                self.assertEqual(
                    verification.execute(
                        "SELECT COUNT(*) FROM agent_runtime_scopes "
                        "WHERE scope_key = 'private:missing'"
                    ).fetchone()[0],
                    1,
                )
                self.assertEqual(
                    verification.execute(
                        "SELECT lifecycle_id, session_id, created_at "
                        "FROM agent_scope_sessions ORDER BY created_at"
                    ).fetchall(),
                    [
                        ("legacy-meta-life", "retired-session-1", 1),
                        ("legacy-meta-life", "retired-session-2", 2),
                    ],
                )
                self.assertEqual(
                    verification.execute(
                        "PRAGMA foreign_key_list(agent_scope_sessions)"
                    ).fetchone()[2],
                    "agent_scopes",
                )
                self.assertEqual(
                    verification.execute(
                        "SELECT COUNT(*) FROM schema_migrations WHERE version = ?",
                        (DATABASE_SCHEMA_VERSION,),
                    ).fetchone()[0],
                    0,
                )
            finally:
                verification.close()

    def test_new_schema_version_removes_empty_retired_scope_session_table(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            connection = sqlite3.connect(config.db_path)
            connection.executescript(
                """
                PRAGMA foreign_keys=OFF;
                CREATE TABLE schema_migrations (
                    version INTEGER PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE,
                    applied_at INTEGER NOT NULL
                );
                INSERT INTO schema_migrations VALUES(
                    2026072401, 'agent-scopes-container-sandbox', 1
                );
                CREATE TABLE agent_scopes (
                    scope_key TEXT PRIMARY KEY,
                    scope_type TEXT NOT NULL CHECK(scope_type IN ('channel', 'private')),
                    scope_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    lifecycle_id TEXT NOT NULL DEFAULT '',
                    workspace_path TEXT NOT NULL,
                    sandbox_id TEXT NOT NULL,
                    execution_backend TEXT NOT NULL DEFAULT 'sandbox'
                        CHECK(execution_backend = 'sandbox'),
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    UNIQUE(scope_type, scope_id)
                );
                CREATE TABLE agent_runtime_scopes (
                    scope_key TEXT PRIMARY KEY
                        REFERENCES agent_scopes(scope_key) ON DELETE CASCADE,
                    session_id TEXT NOT NULL,
                    lifecycle_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE agent_runtime_scope_sessions (
                    scope_key TEXT NOT NULL
                        REFERENCES agent_runtime_scopes(scope_key) ON DELETE CASCADE,
                    lifecycle_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY(scope_key, lifecycle_id, session_id)
                );
                CREATE TABLE agent_scope_sessions (
                    scope_key TEXT NOT NULL
                        REFERENCES agent_scopes_legacy(scope_key) ON DELETE CASCADE,
                    lifecycle_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY(scope_key, lifecycle_id, session_id)
                );
                INSERT INTO agent_scopes VALUES(
                    'private:1', 'private', '1', 'metadata-session',
                    'metadata-life', 'user-1', 'agent-stable', 'sandbox', 1, 1
                );
                INSERT INTO agent_runtime_scopes VALUES(
                    'private:1', 'runtime-session', 'runtime-life', 1, 1
                );
                INSERT INTO agent_runtime_scope_sessions VALUES(
                    'private:1', 'runtime-life', 'runtime-session', 1
                );
                """
            )
            connection.commit()
            connection.close()

            db = Database(config.db_path)
            try:
                self.assertIsNone(
                    db.query_one(
                        "SELECT name FROM sqlite_master "
                        "WHERE type = 'table' AND name = 'agent_scope_sessions'"
                    )
                )
                self.assertEqual(
                    db.query_one(
                        "SELECT session_id, lifecycle_id "
                        "FROM agent_runtime_scopes WHERE scope_key = 'private:1'"
                    ),
                    {"session_id": "runtime-session", "lifecycle_id": "runtime-life"},
                )
                self.assertEqual(
                    db.scalar(
                        "SELECT COUNT(*) FROM schema_migrations WHERE version = ?",
                        (DATABASE_SCHEMA_VERSION,),
                    ),
                    1,
                )
                self.assertFalse(db.query("PRAGMA foreign_key_check"))
            finally:
                db.close()

            reopened = Database(config.db_path)
            try:
                self.assertEqual(
                    reopened.scalar(
                        "SELECT sandbox_id FROM agent_scopes "
                        "WHERE scope_key = 'private:1'"
                    ),
                    "agent-stable",
                )
                self.assertEqual(
                    reopened.scalar(
                        "SELECT COUNT(*) FROM schema_migrations WHERE version = ?",
                        (DATABASE_SCHEMA_VERSION,),
                    ),
                    1,
                )
            finally:
                reopened.close()

    def test_scope_migration_rejects_unknown_foreign_key_dependents(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            connection = sqlite3.connect(config.db_path)
            connection.executescript(
                """
                PRAGMA foreign_keys=OFF;
                CREATE TABLE agent_scopes (
                    scope_key TEXT PRIMARY KEY,
                    scope_type TEXT NOT NULL,
                    scope_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    lifecycle_id TEXT NOT NULL DEFAULT '',
                    workspace_path TEXT NOT NULL,
                    execution_backend TEXT NOT NULL DEFAULT 'host'
                        CHECK(execution_backend = 'host'),
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    UNIQUE(scope_type, scope_id)
                );
                CREATE TABLE unexpected_scope_child (
                    scope_key TEXT PRIMARY KEY
                        REFERENCES agent_scopes(scope_key) ON DELETE CASCADE
                );
                INSERT INTO agent_scopes VALUES(
                    'private:1', 'private', '1', 'legacy-meta', 'legacy-life',
                    '/old/source/data/workspaces/user-1', 'host', 1, 1
                );
                INSERT INTO unexpected_scope_child VALUES('private:1');
                """
            )
            connection.commit()
            connection.close()

            with self.assertRaisesRegex(
                sqlite3.IntegrityError,
                "unsupported agent_scopes dependents: unexpected_scope_child",
            ):
                Database(config.db_path)

            verification = sqlite3.connect(config.db_path)
            try:
                columns = {
                    row[1]
                    for row in verification.execute(
                        "PRAGMA table_info(agent_scopes)"
                    ).fetchall()
                }
                self.assertNotIn("sandbox_id", columns)
                self.assertEqual(
                    verification.execute(
                        "SELECT scope_key FROM unexpected_scope_child"
                    ).fetchall(),
                    [("private:1",)],
                )
                self.assertEqual(
                    verification.execute(
                        "SELECT COUNT(*) FROM schema_migrations WHERE version = ?",
                        (DATABASE_SCHEMA_VERSION,),
                    ).fetchone()[0],
                    0,
                )
            finally:
                verification.close()

    def test_scope_migration_rejects_children_of_retired_session_table(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            connection = sqlite3.connect(config.db_path)
            connection.executescript(
                """
                PRAGMA foreign_keys=OFF;
                CREATE TABLE agent_scopes (
                    scope_key TEXT PRIMARY KEY,
                    scope_type TEXT NOT NULL,
                    scope_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    lifecycle_id TEXT NOT NULL DEFAULT '',
                    workspace_path TEXT NOT NULL,
                    execution_backend TEXT NOT NULL DEFAULT 'host'
                        CHECK(execution_backend = 'host'),
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    UNIQUE(scope_type, scope_id)
                );
                CREATE TABLE agent_scope_sessions (
                    scope_key TEXT NOT NULL
                        REFERENCES agent_scopes(scope_key) ON DELETE CASCADE,
                    lifecycle_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY(scope_key, lifecycle_id, session_id)
                );
                CREATE TABLE unexpected_retired_child (
                    scope_key TEXT NOT NULL,
                    lifecycle_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    FOREIGN KEY(scope_key, lifecycle_id, session_id)
                        REFERENCES agent_scope_sessions(
                            scope_key, lifecycle_id, session_id
                        ) ON DELETE CASCADE
                );
                """
            )
            connection.commit()
            connection.close()

            with self.assertRaisesRegex(
                sqlite3.IntegrityError,
                "unsupported agent_scope_sessions dependents: "
                "unexpected_retired_child",
            ):
                Database(config.db_path)

            verification = sqlite3.connect(config.db_path)
            try:
                tables = {
                    row[0]
                    for row in verification.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'table'"
                    ).fetchall()
                }
                self.assertIn("agent_scope_sessions", tables)
                self.assertIn("unexpected_retired_child", tables)
                self.assertNotIn("agent_scopes_legacy", tables)
                self.assertEqual(
                    verification.execute(
                        "SELECT COUNT(*) FROM schema_migrations WHERE version = ?",
                        (DATABASE_SCHEMA_VERSION,),
                    ).fetchone()[0],
                    0,
                )
            finally:
                verification.close()

    def test_scope_migration_rejects_a_conflicting_version_owner(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            connection = sqlite3.connect(config.db_path)
            connection.executescript(
                f"""
                CREATE TABLE schema_migrations (
                    version INTEGER PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE,
                    applied_at INTEGER NOT NULL
                );
                INSERT INTO schema_migrations VALUES(
                    {DATABASE_SCHEMA_VERSION}, 'unexpected-migration', 1
                );
                """
            )
            connection.commit()
            connection.close()

            with self.assertRaisesRegex(
                sqlite3.IntegrityError,
                "is owned by 'unexpected-migration'",
            ):
                Database(config.db_path)

            verification = sqlite3.connect(config.db_path)
            try:
                self.assertEqual(
                    verification.execute(
                        "SELECT name FROM schema_migrations WHERE version = ?",
                        (DATABASE_SCHEMA_VERSION,),
                    ).fetchone()[0],
                    "unexpected-migration",
                )
            finally:
                verification.close()

    def test_foreign_key_schema_validation_matches_sqlite_identifier_case(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            connection = sqlite3.connect(config.db_path)
            connection.executescript(
                """
                PRAGMA foreign_keys=ON;
                CREATE TABLE "MixedParent" (id INTEGER PRIMARY KEY);
                CREATE TABLE "MixedChild" (
                    id INTEGER PRIMARY KEY,
                    parent_id INTEGER REFERENCES mixedparent(id)
                );
                INSERT INTO "MixedParent" VALUES(1);
                INSERT INTO "MixedChild" VALUES(1, 1);
                """
            )
            connection.commit()
            connection.close()

            db = Database(config.db_path)
            try:
                self.assertFalse(db.query("PRAGMA foreign_key_check"))
                self.assertEqual(
                    db.scalar('SELECT parent_id FROM "MixedChild" WHERE id = 1'),
                    1,
                )
            finally:
                db.close()

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
