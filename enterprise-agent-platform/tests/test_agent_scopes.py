from __future__ import annotations

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
                        "name": "ubitech-agent-container-baseline-v2",
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
                "does not match the current baseline marker",
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

    def test_current_marker_with_unknown_business_table_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            path = make_config(Path(td)).db_path
            db = Database(path)
            db.execute("CREATE TABLE unexpected_business_table(id INTEGER PRIMARY KEY)")
            db.close()

            with self.assertRaisesRegex(
                sqlite3.DatabaseError,
                "outside the current baseline: unexpected_business_table",
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
                "does not match the current baseline marker",
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
                    manager.get_scope(scope.scope_key)
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
