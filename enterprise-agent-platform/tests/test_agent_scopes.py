from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from enterprise_agent_platform import db as db_module
from enterprise_agent_platform import secure_fs
from enterprise_agent_platform.agent_scopes import AgentScopeManager
from enterprise_agent_platform.container_contract_generated import DATABASE_SCHEMA_VERSION
from enterprise_agent_platform.db import Database

from test_platform import make_config


class AgentScopeSessionTests(unittest.TestCase):
    def test_scope_marker_has_versioned_technical_and_relative_identity(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            db = Database(config.db_path)
            try:
                scope = AgentScopeManager(config, db).ensure_private_scope(1)
                marker = Path(scope.workspace_path) / ".ubitech-agent-scope.json"
                payload = json.loads(marker.read_text(encoding="utf-8"))
                self.assertEqual(payload["schema_version"], 1)
                self.assertEqual(payload["kind"], "agent-workspace-scope")
                self.assertEqual(payload["technical_profile"], "ubitech-agent-v1")
                self.assertEqual(payload["workspace_id"], "user-1")
                self.assertEqual(
                    payload["workspace_relative_path"],
                    "workspaces/user-1",
                )
                self.assertEqual(marker.stat().st_mode & 0o777, 0o600)
            finally:
                db.close()

    def test_current_scope_marker_requires_json_integer_schema_version(self):
        for invalid_version in (True, 1.0):
            with self.subTest(invalid_version=invalid_version):
                with tempfile.TemporaryDirectory() as td:
                    config = make_config(Path(td))
                    db = Database(config.db_path)
                    try:
                        scope = AgentScopeManager(config, db).ensure_private_scope(1)
                        marker = (
                            Path(scope.workspace_path)
                            / ".ubitech-agent-scope.json"
                        )
                        payload = json.loads(marker.read_text(encoding="utf-8"))
                        payload["schema_version"] = invalid_version
                        original = (
                            json.dumps(payload, sort_keys=True) + "\n"
                        ).encode("utf-8")
                        marker.write_bytes(original)
                        marker.chmod(0o600)

                        with self.assertRaisesRegex(
                            sqlite3.DatabaseError,
                            "scope marker does not match",
                        ):
                            AgentScopeManager(
                                config,
                                db,
                                commit_schema_upgrade=False,
                            )
                        self.assertEqual(marker.read_bytes(), original)
                    finally:
                        db.close()

    def test_exact_legacy_scope_marker_is_atomically_upgraded(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            db = Database(config.db_path)
            try:
                scope = AgentScopeManager(config, db).ensure_private_scope(1)
                marker = Path(scope.workspace_path) / ".ubitech-agent-scope.json"
                current = json.loads(marker.read_text(encoding="utf-8"))
                legacy = {
                    key: current[key]
                    for key in (
                        "scope_key",
                        "scope_type",
                        "scope_id",
                        "lifecycle_id",
                        "sandbox_id",
                        "workspace_id",
                        "isolation",
                    )
                }
                marker.write_text(
                    json.dumps(legacy, sort_keys=True) + "\n",
                    encoding="utf-8",
                )
                marker.chmod(0o600)

                AgentScopeManager(config, db)

                upgraded = json.loads(marker.read_text(encoding="utf-8"))
                self.assertEqual(upgraded["schema_version"], 1)
                self.assertEqual(upgraded["technical_profile"], "ubitech-agent-v1")
                self.assertEqual(upgraded["workspace_relative_path"], "workspaces/user-1")
            finally:
                db.close()

    def test_candidate_startup_validates_but_does_not_publish_marker_upgrade(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            db = Database(config.db_path)
            try:
                scope = AgentScopeManager(config, db).ensure_private_scope(1)
                marker = Path(scope.workspace_path) / ".ubitech-agent-scope.json"
                current = json.loads(marker.read_text(encoding="utf-8"))
                legacy = {
                    key: current[key]
                    for key in (
                        "scope_key",
                        "scope_type",
                        "scope_id",
                        "lifecycle_id",
                        "sandbox_id",
                        "workspace_id",
                        "isolation",
                    )
                }
                original = (json.dumps(legacy, sort_keys=True) + "\n").encode("utf-8")
                marker.write_bytes(original)
                marker.chmod(0o600)

                candidate = AgentScopeManager(
                    config,
                    db,
                    commit_schema_upgrade=False,
                )
                self.assertEqual(marker.read_bytes(), original)
                candidate.commit_schema_upgrade()
                self.assertEqual(
                    json.loads(marker.read_text(encoding="utf-8"))["schema_version"],
                    1,
                )
            finally:
                db.close()

    def test_post_exchange_crash_is_replayed_by_a_new_manager(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            db = Database(config.db_path)
            try:
                scope = AgentScopeManager(config, db).ensure_private_scope(1)
                marker = Path(scope.workspace_path) / ".ubitech-agent-scope.json"
                current = json.loads(marker.read_text(encoding="utf-8"))
                legacy = {
                    key: current[key]
                    for key in (
                        "scope_key",
                        "scope_type",
                        "scope_id",
                        "lifecycle_id",
                        "sandbox_id",
                        "workspace_id",
                        "isolation",
                    )
                }
                marker.write_text(json.dumps(legacy, sort_keys=True) + "\n", encoding="utf-8")
                marker.chmod(0o600)
                candidate = AgentScopeManager(config, db, commit_schema_upgrade=False)
                real_unlink = secure_fs.os.unlink

                def crash_before_old_inode_cleanup(name, *args, **kwargs):
                    if isinstance(name, str) and name.startswith(".platform-machine-scope-"):
                        raise RuntimeError("simulated post-exchange crash")
                    return real_unlink(name, *args, **kwargs)

                with mock.patch.object(
                    secure_fs.os,
                    "unlink",
                    side_effect=crash_before_old_inode_cleanup,
                ):
                    with self.assertRaisesRegex(RuntimeError, "post-exchange crash"):
                        candidate.commit_schema_upgrade()

                self.assertEqual(
                    json.loads(marker.read_text(encoding="utf-8"))["schema_version"],
                    1,
                )
                residues = list(config.data_dir.glob(".platform-machine-scope-*.stage"))
                self.assertEqual(len(residues), 1)

                # A fresh owner reconstructs the DB/marker transition and
                # removes only the exact old->new residue.
                AgentScopeManager(config, db)
                self.assertEqual(
                    list(config.data_dir.glob(".platform-machine-scope-*.stage")),
                    [],
                )
            finally:
                db.close()

    def test_rotate_session_pre_exchange_crash_is_completed_by_fresh_manager(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            db = Database(config.db_path)
            try:
                manager = AgentScopeManager(config, db)
                original = manager.ensure_private_scope(1)
                marker = Path(original.workspace_path) / ".ubitech-agent-scope.json"
                def crash_before_exchange(left_fd, left_name, right_fd, right_name):
                    raise RuntimeError("simulated rotate pre-exchange crash")

                with mock.patch.object(
                    secure_fs,
                    "_rename_exchange",
                    side_effect=crash_before_exchange,
                ):
                    with self.assertRaisesRegex(RuntimeError, "pre-exchange crash"):
                        manager.rotate_session(original.scope_key)

                current = manager.get_scope(original.scope_key)
                self.assertIsNotNone(current)
                self.assertNotEqual(current.lifecycle_id, original.lifecycle_id)
                self.assertEqual(
                    json.loads(marker.read_text(encoding="utf-8"))["lifecycle_id"],
                    original.lifecycle_id,
                )
                self.assertEqual(
                    len(list(config.data_dir.glob(".platform-machine-scope-*.stage"))),
                    1,
                )

                fresh = AgentScopeManager(config, db)
                recovered = fresh.get_scope(original.scope_key)
                self.assertEqual(
                    json.loads(marker.read_text(encoding="utf-8"))["lifecycle_id"],
                    recovered.lifecycle_id,
                )
                self.assertEqual(
                    list(config.data_dir.glob(".platform-machine-scope-*.stage")),
                    [],
                )
            finally:
                db.close()

    def test_rotate_session_post_exchange_crash_cleans_old_without_alias(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            db = Database(config.db_path)
            try:
                manager = AgentScopeManager(config, db)
                original = manager.ensure_private_scope(1)
                marker = Path(original.workspace_path) / ".ubitech-agent-scope.json"
                real_unlink = secure_fs.os.unlink

                def crash_before_old_cleanup(name, *args, **kwargs):
                    if isinstance(name, str) and name.startswith(".platform-machine-scope-"):
                        raise RuntimeError("simulated rotate post-exchange crash")
                    return real_unlink(name, *args, **kwargs)

                with mock.patch.object(
                    secure_fs.os,
                    "unlink",
                    side_effect=crash_before_old_cleanup,
                ):
                    with self.assertRaisesRegex(RuntimeError, "post-exchange crash"):
                        manager.rotate_session(original.scope_key)

                current = manager.get_scope(original.scope_key)
                self.assertNotEqual(current.lifecycle_id, original.lifecycle_id)
                self.assertFalse(
                    db.query_one(
                        "SELECT 1 FROM agent_runtime_scope_sessions "
                        "WHERE scope_key = ? AND lifecycle_id = ?",
                        (original.scope_key, original.lifecycle_id),
                    )
                )
                self.assertEqual(
                    json.loads(marker.read_text(encoding="utf-8"))["lifecycle_id"],
                    current.lifecycle_id,
                )
                self.assertEqual(
                    len(list(config.data_dir.glob(".platform-machine-scope-*.stage"))),
                    1,
                )

                AgentScopeManager(config, db)
                self.assertEqual(
                    list(config.data_dir.glob(".platform-machine-scope-*.stage")),
                    [],
                )
            finally:
                db.close()

    def test_legacy_scope_marker_conflict_is_rejected_without_rewrite(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            db = Database(config.db_path)
            try:
                scope = AgentScopeManager(config, db).ensure_private_scope(1)
                marker = Path(scope.workspace_path) / ".ubitech-agent-scope.json"
                payload = json.loads(marker.read_text(encoding="utf-8"))
                payload.pop("schema_version")
                payload.pop("kind")
                payload.pop("technical_profile")
                payload.pop("workspace_relative_path")
                payload["sandbox_id"] = "conflicting-sandbox"
                original = (json.dumps(payload, sort_keys=True) + "\n").encode("utf-8")
                marker.write_bytes(original)
                marker.chmod(0o600)

                with self.assertRaisesRegex(
                    sqlite3.DatabaseError,
                    "scope marker does not match",
                ):
                    AgentScopeManager(config, db)
                self.assertEqual(marker.read_bytes(), original)
            finally:
                db.close()

    def test_candidate_accepts_missing_p1_marker_but_commit_publishes_it(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            db = Database(config.db_path)
            try:
                scope = AgentScopeManager(config, db).ensure_private_scope(1)
                marker = Path(scope.workspace_path) / ".ubitech-agent-scope.json"
                marker.unlink()
                candidate = AgentScopeManager(
                    config,
                    db,
                    commit_schema_upgrade=False,
                )
                self.assertFalse(marker.exists())
                candidate.commit_schema_upgrade()
                self.assertEqual(
                    json.loads(marker.read_text(encoding="utf-8"))["schema_version"],
                    1,
                )

                # Directory metadata remains part of the binding rather than
                # being repaired by either candidate or commit.
                Path(scope.workspace_path).chmod(0o755)
                with self.assertRaisesRegex(
                    sqlite3.DatabaseError,
                    "workspace directory has unsafe metadata",
                ):
                    AgentScopeManager(config, db)
            finally:
                db.close()

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
