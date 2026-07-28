from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from enterprise_agent_platform import db as db_module
from enterprise_agent_platform.agent_scopes import AgentScopeManager
from enterprise_agent_platform.container_contract_generated import DATABASE_SCHEMA_VERSION
from enterprise_agent_platform.db import Database

from test_platform import make_config


class AgentScopeSessionTests(unittest.TestCase):
    @staticmethod
    def _mark_previous_container_baseline(path: Path) -> None:
        with sqlite3.connect(path) as connection:
            connection.execute(
                "ALTER TABLE agent_scopes ADD COLUMN execution_backend "
                "TEXT NOT NULL DEFAULT 'sandbox' "
                "CHECK(execution_backend = 'sandbox')"
            )
            connection.execute(
                "UPDATE schema_migrations SET version = 2026072402, "
                "name = 'agent-scopes-container-sandbox-v2'"
            )

    @staticmethod
    def _create_retired_private_agents(path: Path, user_id: int = 1) -> None:
        with sqlite3.connect(path) as connection:
            connection.execute(
                """
                CREATE TABLE private_agents (
                    user_id INTEGER PRIMARY KEY
                        REFERENCES users(id) ON DELETE CASCADE,
                    session_id TEXT NOT NULL,
                    container_name TEXT NOT NULL DEFAULT '',
                    container_id TEXT NOT NULL DEFAULT '',
                    container_status TEXT NOT NULL DEFAULT 'unknown',
                    workspace_path TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                )
                """
            )
            connection.execute(
                """
                INSERT INTO private_agents(
                    user_id, session_id, container_name, container_id,
                    container_status, workspace_path, created_at, updated_at
                ) VALUES (?, 'retired-session', 'retired-container',
                          'retired-container-id', 'running',
                          '/retired/absolute/workspace', 1, 2)
                """,
                (user_id,),
            )

    def test_scope_uses_stable_sandbox_identity_and_relative_database_workspace(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            db = Database(config.db_path)
            try:
                manager = AgentScopeManager(config, db)
                scope = manager.ensure_private_scope(1)
                stored = db.query_one(
                    "SELECT workspace_path, sandbox_id "
                    "FROM agent_scopes WHERE scope_key = ?",
                    (scope.scope_key,),
                )
                self.assertEqual(stored["workspace_path"], "user-1")
                self.assertEqual(stored["sandbox_id"], scope.sandbox_id)
                self.assertNotIn(
                    "execution_backend",
                    {row["name"] for row in db.query("PRAGMA table_info(agent_scopes)")},
                )
                self.assertTrue(Path(scope.workspace_path).is_absolute())
                execution = scope.to_execution_dict()
                self.assertEqual(execution["backend"], "sandbox")
                self.assertEqual(execution["workspace_path"], "/workspace")
                self.assertEqual(execution["workspace_id"], "user-1")
            finally:
                db.close()

    def test_new_database_records_the_only_supported_baseline(self):
        with tempfile.TemporaryDirectory() as td:
            path = make_config(Path(td)).db_path
            db = Database(path)
            try:
                self.assertEqual(
                    db.query_one(
                        "SELECT version, name FROM schema_migrations"
                    ),
                    {
                        "version": DATABASE_SCHEMA_VERSION,
                        "name": "ubitech-agent-container-baseline-v1",
                    },
                )
                self.assertFalse(db.query("PRAGMA foreign_key_check"))
                tables = {
                    row["name"]
                    for row in db.query(
                        "SELECT name FROM sqlite_master WHERE type = 'table'"
                    )
                }
                self.assertTrue(
                    {
                        "durable_jobs",
                        "agent_run_inputs",
                        "agent_schedules",
                        "agent_schedule_runs",
                    }.issubset(tables)
                )
            finally:
                db.close()

            reopened = Database(path)
            reopened.close()

    def test_nonempty_database_without_current_marker_is_rejected_unchanged(self):
        with tempfile.TemporaryDirectory() as td:
            path = make_config(Path(td)).db_path
            connection = sqlite3.connect(path)
            connection.execute("CREATE TABLE unrelated_data(id INTEGER PRIMARY KEY)")
            connection.execute("INSERT INTO unrelated_data VALUES (7)")
            connection.commit()
            connection.close()

            with self.assertRaisesRegex(
                sqlite3.DatabaseError,
                "missing a supported baseline marker",
            ):
                Database(path)

            verification = sqlite3.connect(path)
            try:
                self.assertEqual(
                    verification.execute("SELECT id FROM unrelated_data").fetchall(),
                    [(7,)],
                )
                self.assertIsNone(
                    verification.execute(
                        "SELECT name FROM sqlite_master "
                        "WHERE type = 'table' AND name = 'users'"
                    ).fetchone()
                )
            finally:
                verification.close()

    def test_fresh_baseline_failure_leaves_no_partial_tables(self):
        class FailingBaselineConnection(sqlite3.Connection):
            def executescript(self, script: str):
                if "BEGIN IMMEDIATE;" in script:
                    script = script.replace(
                        "CREATE TABLE IF NOT EXISTS agent_schedules (",
                        "THIS IS NOT VALID SQL;\n"
                        "CREATE TABLE IF NOT EXISTS agent_schedules (",
                        1,
                    )
                return super().executescript(script)

        real_connect = sqlite3.connect

        def failing_connect(*args, **kwargs):
            return real_connect(*args, **kwargs, factory=FailingBaselineConnection)

        with tempfile.TemporaryDirectory() as td:
            path = make_config(Path(td)).db_path
            with mock.patch.object(
                db_module.sqlite3,
                "connect",
                side_effect=failing_connect,
            ):
                with self.assertRaises(sqlite3.OperationalError):
                    Database(path)

            with real_connect(path) as verification:
                tables = verification.execute(
                    "SELECT name FROM sqlite_master "
                    "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
                ).fetchall()
            self.assertEqual(tables, [])

    def test_current_marker_with_forbidden_scope_table_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            path = make_config(Path(td)).db_path
            db = Database(path)
            db.execute(
                "CREATE TABLE agent_scope_sessions("
                "scope_key TEXT, lifecycle_id TEXT, session_id TEXT)"
            )
            db.close()

            with self.assertRaisesRegex(
                sqlite3.DatabaseError,
                "outside the current baseline: agent_scope_sessions",
            ):
                Database(path)

    def test_current_marker_with_retired_private_agents_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            path = config.db_path
            db = Database(path)
            try:
                db.execute(
                    """
                    INSERT INTO users(
                        id, username, display_name, password_hash, role,
                        permission_group, created_at
                    ) VALUES (1, 'one', 'One', 'hash', 'member', 'member', 1)
                    """
                )
                AgentScopeManager(config, db).ensure_private_scope(1)
            finally:
                db.close()
            self._create_retired_private_agents(path)

            with self.assertRaisesRegex(
                sqlite3.DatabaseError,
                "outside the current baseline: private_agents",
            ):
                Database(path)

    def test_current_marker_with_missing_job_table_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            path = make_config(Path(td)).db_path
            db = Database(path)
            db.execute("DROP TABLE agent_run_inputs")
            db.close()

            with self.assertRaisesRegex(
                sqlite3.DatabaseError,
                "missing current baseline table agent_run_inputs",
            ):
                Database(path)

    def test_current_marker_with_extra_column_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            path = make_config(Path(td)).db_path
            db = Database(path)
            db.execute("ALTER TABLE users ADD COLUMN retired_value TEXT")
            db.close()

            with self.assertRaisesRegex(
                sqlite3.DatabaseError,
                "users has non-current columns: unexpected retired_value",
            ):
                Database(path)

    def test_conflicting_baseline_marker_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            path = make_config(Path(td)).db_path
            db = Database(path)
            db.execute(
                "UPDATE schema_migrations SET name = 'unexpected-baseline' "
                "WHERE version = ?",
                (DATABASE_SCHEMA_VERSION,),
            )
            db.close()

            with self.assertRaisesRegex(
                sqlite3.DatabaseError,
                "does not match a supported baseline marker",
            ):
                Database(path)

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

    def test_previous_container_baseline_is_upgraded_once(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            path = config.db_path
            db = Database(path)
            try:
                db.execute(
                    """
                    INSERT INTO users(
                        id, username, display_name, password_hash, role,
                        permission_group, created_at
                    ) VALUES (1, 'one', 'One', 'hash', 'member', 'member', 1)
                    """
                )
                previous_scope = AgentScopeManager(config, db).ensure_private_scope(1)
                previous_runtime = db.query_one(
                    "SELECT session_id, lifecycle_id FROM agent_runtime_scopes "
                    "WHERE scope_key = 'private:1'"
                )
                db.execute(
                    """
                    INSERT INTO agent_memories(
                        scope_key, content, source_type, content_hash,
                        created_at, updated_at
                    ) VALUES ('private:1', 'remember me', 'manual', 'hash-1', 1, 1)
                    """
                )
                memory_id = int(db.scalar("SELECT id FROM agent_memories"))
                db.execute(
                    """
                    INSERT INTO agent_memory_candidates(
                        scope_key, content, dedupe_key, status, memory_id, created_at
                    ) VALUES ('private:1', 'remember me', 'candidate-1',
                              'approved', ?, 1)
                    """,
                    (memory_id,),
                )
                db.execute(
                    "UPDATE settings SET value = '17' "
                    "WHERE key = 'durable_agent_jobs_start_message_id'"
                )
            finally:
                db.close()

            marker_path = Path(previous_scope.workspace_path) / ".ubitech-agent-scope.json"
            previous_marker = json.loads(marker_path.read_text(encoding="utf-8"))
            previous_marker["execution_backend"] = "sandbox"
            marker_path.write_text(
                json.dumps(previous_marker, ensure_ascii=False, sort_keys=True) + "\n",
                encoding="utf-8",
            )

            connection = sqlite3.connect(path)
            try:
                schema = str(
                    connection.execute(
                        "SELECT sql FROM sqlite_master "
                        "WHERE type = 'table' AND name = 'agent_memories'"
                    ).fetchone()[0]
                )
                current_source = (
                    "source_type TEXT NOT NULL DEFAULT 'manual'\n"
                    "                        CHECK(source_type IN "
                    "('manual', 'tool', 'candidate', 'imported'))"
                )
                self.assertIn(current_source, schema)
                source_schema = schema.replace(
                    current_source,
                    "source_type TEXT NOT NULL DEFAULT 'unclassified'",
                )
                connection.execute("PRAGMA writable_schema=ON")
                connection.execute(
                    "UPDATE sqlite_master SET sql = ? "
                    "WHERE type = 'table' AND name = 'agent_memories'",
                    (source_schema,),
                )
                schema_version = int(
                    connection.execute("PRAGMA schema_version").fetchone()[0]
                )
                connection.execute(f"PRAGMA schema_version={schema_version + 1}")
                connection.commit()
            finally:
                connection.close()

            self._mark_previous_container_baseline(path)
            self._create_retired_private_agents(path)

            connection = sqlite3.connect(path)
            try:
                connection.execute(
                    "UPDATE agent_memories SET source_type = 'unclassified'"
                )
                connection.commit()
            finally:
                connection.close()

            upgraded = Database(path)
            try:
                self.assertEqual(
                    upgraded.query_one(
                        "SELECT version, name FROM schema_migrations"
                    ),
                    {
                        "version": DATABASE_SCHEMA_VERSION,
                        "name": "ubitech-agent-container-baseline-v1",
                    },
                )
                self.assertEqual(
                    upgraded.scalar("SELECT source_type FROM agent_memories"),
                    "imported",
                )
                self.assertEqual(
                    upgraded.scalar(
                        "SELECT memory_id FROM agent_memory_candidates"
                    ),
                    memory_id,
                )
                self.assertEqual(
                    upgraded.scalar(
                        "SELECT value FROM settings WHERE key = "
                        "'durable_agent_jobs_start_message_id'"
                    ),
                    "17",
                )
                self.assertFalse(upgraded.query("PRAGMA foreign_key_check"))
                self.assertIsNone(
                    upgraded.query_one(
                        "SELECT name FROM sqlite_master "
                        "WHERE type = 'table' AND name = 'private_agents'"
                    )
                )
                self.assertEqual(
                    upgraded.scalar("SELECT count(*) FROM users WHERE id = 1"),
                    1,
                )
                self.assertNotIn(
                    "execution_backend",
                    {
                        row["name"]
                        for row in upgraded.query("PRAGMA table_info(agent_scopes)")
                    },
                )
                migrated_scope = AgentScopeManager(config, upgraded).ensure_private_scope(1)
                self.assertEqual(migrated_scope.sandbox_id, previous_scope.sandbox_id)
                self.assertEqual(migrated_scope.session_id, previous_scope.session_id)
                self.assertEqual(migrated_scope.lifecycle_id, previous_scope.lifecycle_id)
                self.assertEqual(
                    upgraded.query_one(
                        "SELECT session_id, lifecycle_id "
                        "FROM agent_runtime_scopes WHERE scope_key = 'private:1'"
                    ),
                    previous_runtime,
                )
                self.assertNotEqual(migrated_scope.session_id, "retired-session")
                current_marker = json.loads(marker_path.read_text(encoding="utf-8"))
                self.assertNotIn("execution_backend", current_marker)
            finally:
                upgraded.close()

    def test_previous_container_baseline_without_retired_table_still_upgrades(self):
        with tempfile.TemporaryDirectory() as td:
            path = make_config(Path(td)).db_path
            db = Database(path)
            db.close()

            self._mark_previous_container_baseline(path)
            upgraded = Database(path)
            try:
                self.assertEqual(
                    upgraded.query_one(
                        "SELECT version, name FROM schema_migrations"
                    ),
                    {
                        "version": DATABASE_SCHEMA_VERSION,
                        "name": "ubitech-agent-container-baseline-v1",
                    },
                )
                self.assertIsNone(
                    upgraded.query_one(
                        "SELECT name FROM sqlite_master "
                        "WHERE type = 'table' AND name = 'private_agents'"
                    )
                )
            finally:
                upgraded.close()

    def test_previous_baseline_keeps_unmapped_private_agents_unchanged(self):
        with tempfile.TemporaryDirectory() as td:
            path = make_config(Path(td)).db_path
            db = Database(path)
            try:
                db.execute(
                    """
                    INSERT INTO users(
                        id, username, display_name, password_hash, role,
                        permission_group, created_at
                    ) VALUES (1, 'one', 'One', 'hash', 'member', 'member', 1)
                    """
                )
            finally:
                db.close()

            self._mark_previous_container_baseline(path)
            self._create_retired_private_agents(path)

            with self.assertRaisesRegex(
                sqlite3.DatabaseError,
                "cannot retire private_agents safely",
            ):
                Database(path)

            with sqlite3.connect(path) as verification:
                self.assertEqual(
                    verification.execute(
                        "SELECT version, name FROM schema_migrations"
                    ).fetchone(),
                    (2026072402, "agent-scopes-container-sandbox-v2"),
                )
                self.assertEqual(
                    verification.execute(
                        "SELECT user_id, session_id FROM private_agents"
                    ).fetchall(),
                    [(1, "retired-session")],
                )
                self.assertIn(
                    "execution_backend",
                    {
                        row[1]
                        for row in verification.execute(
                            "PRAGMA table_info(agent_scopes)"
                        ).fetchall()
                    },
                )

    def test_previous_baseline_rolls_back_retired_table_when_marker_write_fails(self):
        class FailingMigrationConnection(sqlite3.Connection):
            def execute(self, sql: str, parameters=()):
                if (
                    "INSERT INTO schema_migrations" in sql
                    and parameters
                    and int(parameters[0]) == DATABASE_SCHEMA_VERSION
                ):
                    raise sqlite3.OperationalError("injected marker failure")
                return super().execute(sql, parameters)

        real_connect = sqlite3.connect

        def failing_connect(*args, **kwargs):
            return real_connect(
                *args,
                **kwargs,
                factory=FailingMigrationConnection,
            )

        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            path = config.db_path
            db = Database(path)
            try:
                db.execute(
                    """
                    INSERT INTO users(
                        id, username, display_name, password_hash, role,
                        permission_group, created_at
                    ) VALUES (1, 'one', 'One', 'hash', 'member', 'member', 1)
                    """
                )
                AgentScopeManager(config, db).ensure_private_scope(1)
            finally:
                db.close()

            self._mark_previous_container_baseline(path)
            self._create_retired_private_agents(path)

            with mock.patch.object(
                db_module.sqlite3,
                "connect",
                side_effect=failing_connect,
            ):
                with self.assertRaisesRegex(
                    sqlite3.OperationalError,
                    "injected marker failure",
                ):
                    Database(path)

            with real_connect(path) as verification:
                self.assertEqual(
                    verification.execute(
                        "SELECT version, name FROM schema_migrations"
                    ).fetchone(),
                    (2026072402, "agent-scopes-container-sandbox-v2"),
                )
                self.assertEqual(
                    verification.execute(
                        "SELECT user_id, session_id FROM private_agents"
                    ).fetchall(),
                    [(1, "retired-session")],
                )
                self.assertIn(
                    "execution_backend",
                    {
                        row[1]
                        for row in verification.execute(
                            "PRAGMA table_info(agent_scopes)"
                        ).fetchall()
                    },
                )

    def test_previous_baseline_rejects_missing_or_invalid_durable_high_water(self):
        for stored_value in (None, "not-an-integer", "-1"):
            with self.subTest(stored_value=stored_value), tempfile.TemporaryDirectory() as td:
                path = make_config(Path(td)).db_path
                db = Database(path)
                db.close()

                self._mark_previous_container_baseline(path)
                with sqlite3.connect(path) as connection:
                    if stored_value is None:
                        connection.execute(
                            "DELETE FROM settings WHERE key = "
                            "'durable_agent_jobs_start_message_id'"
                        )
                    else:
                        connection.execute(
                            "UPDATE settings SET value = ? WHERE key = "
                            "'durable_agent_jobs_start_message_id'",
                            (stored_value,),
                        )

                with self.assertRaisesRegex(
                    sqlite3.DatabaseError,
                    "high-water mark is invalid",
                ):
                    Database(path)

                connection = sqlite3.connect(path)
                try:
                    self.assertEqual(
                        connection.execute(
                            "SELECT version, name FROM schema_migrations"
                        ).fetchone(),
                        (2026072402, "agent-scopes-container-sandbox-v2"),
                    )
                finally:
                    connection.close()

    def test_scope_manager_rejects_noncanonical_workspace_record(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            db = Database(config.db_path)
            try:
                manager = AgentScopeManager(config, db)
                scope = manager.ensure_private_scope(1)
                db.execute(
                    "UPDATE agent_scopes SET workspace_path = ? WHERE scope_key = ?",
                    (str(config.workspace_dir / "user-1"), scope.scope_key),
                )
                with self.assertRaisesRegex(
                    sqlite3.DatabaseError,
                    "workspace does not match the current baseline",
                ):
                    AgentScopeManager(config, db)
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

    def test_runtime_session_state_persists_across_database_reopen(self):
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
                initial = manager.ensure_private_scope(1)
                manager.update_session_id(initial.scope_key, "runtime-compacted-session")
                expected_lifecycle = initial.lifecycle_id
            finally:
                db.close()

            reopened = Database(config.db_path)
            try:
                persisted = AgentScopeManager(config, reopened).ensure_private_scope(1)
                self.assertEqual(persisted.session_id, "runtime-compacted-session")
                self.assertEqual(persisted.lifecycle_id, expected_lifecycle)
            finally:
                reopened.close()


if __name__ == "__main__":
    unittest.main()
