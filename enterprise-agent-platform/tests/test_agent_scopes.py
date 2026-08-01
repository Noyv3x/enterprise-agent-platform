from __future__ import annotations

import json
import os
import shutil
import sqlite3
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

from enterprise_agent_platform import db as db_module
from enterprise_agent_platform import agent_scopes as agent_scopes_module
from enterprise_agent_platform import secure_fs
from enterprise_agent_platform.agent_scopes import AgentScopeManager
from enterprise_agent_platform.container_contract_generated import DATABASE_SCHEMA_VERSION
from enterprise_agent_platform.db import Database
from enterprise_agent_platform.technical_profile import TARGET_TECHNICAL_PROFILE

from test_platform import make_config


class AgentScopeSessionTests(unittest.TestCase):
    def test_target_database_and_workspace_use_only_target_markers(self):
        with tempfile.TemporaryDirectory() as td:
            config = replace(
                make_config(Path(td)),
                technical_profile=TARGET_TECHNICAL_PROFILE,
            )
            db = Database(config.db_path, TARGET_TECHNICAL_PROFILE)
            try:
                marker_row = db.query_one(
                    "SELECT version, name FROM schema_migrations"
                )
                self.assertEqual(
                    marker_row,
                    {
                        "version": DATABASE_SCHEMA_VERSION,
                        "name": "agent-platform-container-baseline-v1",
                    },
                )
                scope = AgentScopeManager(config, db).ensure_private_scope(1)
                channel_scope = AgentScopeManager(config, db).ensure_channel_scope(7)
                self.assertEqual(scope.session_id, "agent-platform-private-u1")
                self.assertEqual(
                    channel_scope.session_id,
                    "agent-platform-channel-7-main-agent",
                )
                workspace = Path(scope.workspace_path)
                marker = workspace / ".agent-platform-scope.json"
                self.assertTrue(marker.is_file())
                self.assertFalse((workspace / ".ubitech-agent-scope.json").exists())
                payload = json.loads(marker.read_text(encoding="utf-8"))
                self.assertEqual(payload["technical_profile"], "agent-platform-v1")
            finally:
                db.close()

    def test_target_preserves_historical_source_session_until_explicit_rotation(self):
        with tempfile.TemporaryDirectory() as td:
            config = replace(
                make_config(Path(td)),
                technical_profile=TARGET_TECHNICAL_PROFILE,
            )
            db = Database(config.db_path, TARGET_TECHNICAL_PROFILE)
            try:
                created = AgentScopeManager(config, db).ensure_private_scope(1)
                historical_session_id = "ubitech-private-u1"
                with db.transaction(immediate=True) as conn:
                    conn.execute(
                        "UPDATE agent_runtime_scopes SET session_id = ? "
                        "WHERE scope_key = ?",
                        (historical_session_id, created.scope_key),
                    )
                    conn.execute(
                        "UPDATE agent_runtime_scope_sessions SET session_id = ? "
                        "WHERE scope_key = ? AND lifecycle_id = ?",
                        (
                            historical_session_id,
                            created.scope_key,
                            created.lifecycle_id,
                        ),
                    )

                manager = AgentScopeManager(config, db)
                preserved = manager.ensure_private_scope(1)
                self.assertEqual(preserved.session_id, historical_session_id)

                rotated = manager.rotate_session(preserved.scope_key)
                self.assertTrue(
                    rotated.session_id.startswith("agent-platform-private-u1-")
                )
                self.assertFalse(rotated.session_id.startswith("ubitech-"))
            finally:
                db.close()

    def test_database_and_workspace_profile_mismatches_fail_unchanged(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source_config = make_config(root)
            source_db = Database(source_config.db_path)
            try:
                source_scope = AgentScopeManager(
                    source_config, source_db
                ).ensure_private_scope(1)
            finally:
                source_db.close()

            database_before = source_config.db_path.read_bytes()
            with self.assertRaisesRegex(
                sqlite3.DatabaseError,
                "baseline marker",
            ):
                Database(source_config.db_path, TARGET_TECHNICAL_PROFILE)
            self.assertEqual(source_config.db_path.read_bytes(), database_before)

            source_marker = (
                Path(source_scope.workspace_path) / ".ubitech-agent-scope.json"
            )
            source_marker_before = source_marker.read_bytes()
            target_config = replace(
                source_config,
                technical_profile=TARGET_TECHNICAL_PROFILE,
            )
            target_db_path = root / "target.db"
            target_db = Database(target_db_path, TARGET_TECHNICAL_PROFILE)
            try:
                # Reuse the authoritative scope rows only to exercise the
                # marker/profile boundary; the source marker must never be
                # guessed or rewritten as target state.
                source_connection = sqlite3.connect(str(source_config.db_path))
                source_connection.row_factory = sqlite3.Row
                try:
                    for table in (
                        "agent_scopes",
                        "agent_runtime_scopes",
                        "agent_runtime_scope_sessions",
                    ):
                        rows = source_connection.execute(
                            f"SELECT * FROM {table}"
                        ).fetchall()
                        if not rows:
                            continue
                        columns = tuple(rows[0].keys())
                        placeholders = ",".join("?" for _ in columns)
                        target_db.executemany(
                            f"INSERT INTO {table} ({','.join(columns)}) "
                            f"VALUES ({placeholders})",
                            [tuple(row[column] for column in columns) for row in rows],
                        )
                finally:
                    source_connection.close()
                with self.assertRaisesRegex(
                    sqlite3.DatabaseError,
                    "another technical profile marker",
                ):
                    AgentScopeManager(target_config, target_db)
                self.assertEqual(source_marker.read_bytes(), source_marker_before)
                self.assertFalse(
                    (
                        Path(source_scope.workspace_path)
                        / ".agent-platform-scope.json"
                    ).exists()
                )
            finally:
                target_db.close()

    def test_marker_staging_open_failure_does_not_leak_directory_fds(self):
        if not Path("/proc/self/fd").is_dir():
            self.skipTest("file-descriptor accounting requires procfs")
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            db = Database(config.db_path)
            try:
                manager = AgentScopeManager(config, db)
                scope = manager.ensure_private_scope(1)
                marker = Path(scope.workspace_path) / ".ubitech-agent-scope.json"
                real_open = agent_scopes_module.open_private_directory_fd

                def fail_machine_staging(path):
                    if Path(path) == manager._machine_staging_root:
                        raise RuntimeError("simulated staging open failure")
                    return real_open(path)

                calls = (
                    lambda: manager._write_scope_marker(scope),
                    lambda: manager._prepare_scope_marker_transition(scope, scope),
                    lambda: manager._replay_pre_exchange_scope_marker(scope, marker),
                )
                for call in calls:
                    with self.subTest(call=call):
                        before = set(os.listdir("/proc/self/fd"))
                        with mock.patch.object(
                            agent_scopes_module,
                            "open_private_directory_fd",
                            side_effect=fail_machine_staging,
                        ):
                            with self.assertRaisesRegex(
                                RuntimeError,
                                "staging open failure",
                            ):
                                call()
                        after = set(os.listdir("/proc/self/fd"))
                        self.assertFalse(after - before)
            finally:
                db.close()

    def test_candidate_does_not_create_a_missing_workspace_root(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            config.workspace_dir.rmdir()
            db = Database(config.db_path)
            try:
                self.assertFalse(config.workspace_dir.exists())
                with self.assertRaises(FileNotFoundError):
                    AgentScopeManager(
                        config,
                        db,
                        commit_schema_upgrade=False,
                    )
                self.assertFalse(config.workspace_dir.exists())
                with self.assertRaises(FileNotFoundError):
                    AgentScopeManager(config, db)
                self.assertFalse(config.workspace_dir.exists())
            finally:
                db.close()

    def test_candidate_does_not_repair_workspace_root_permissions(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            config.workspace_dir.chmod(0o755)
            sentinel = config.workspace_dir / "sentinel"
            sentinel.write_text("unchanged", encoding="utf-8")
            before = config.workspace_dir.stat()
            db = Database(config.db_path)
            try:
                with self.assertRaises(secure_fs.UnsafePrivatePathError):
                    AgentScopeManager(
                        config,
                        db,
                        commit_schema_upgrade=False,
                    )
                after = config.workspace_dir.stat()
                self.assertEqual((after.st_dev, after.st_ino), (before.st_dev, before.st_ino))
                self.assertEqual(after.st_mode & 0o777, 0o755)
                self.assertEqual(sentinel.read_text(encoding="utf-8"), "unchanged")
            finally:
                db.close()

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

    def test_candidate_rejects_unmaterialized_scope(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            db = Database(config.db_path)
            try:
                scope = AgentScopeManager(config, db).ensure_channel_scope(1)
                channel_root = Path(scope.workspace_path).parent
                shutil.rmtree(channel_root)

                with self.assertRaisesRegex(
                    sqlite3.DatabaseError,
                    "workspace directory is missing",
                ):
                    AgentScopeManager(
                        config,
                        db,
                        commit_schema_upgrade=False,
                    )
                self.assertFalse(channel_root.exists())
            finally:
                db.close()

    def test_current_scope_reads_reject_marker_deletion_or_legacy_downgrade(self):
        for cached, marker_state in (
            (True, "missing"),
            (False, "legacy"),
        ):
            with self.subTest(cached=cached, marker_state=marker_state):
                with tempfile.TemporaryDirectory() as td:
                    config = make_config(Path(td))
                    db = Database(config.db_path)
                    try:
                        manager = AgentScopeManager(config, db)
                        scope = manager.ensure_private_scope(1)
                        marker = (
                            Path(scope.workspace_path)
                            / ".ubitech-agent-scope.json"
                        )
                        if not cached:
                            manager._scope_cache.clear()
                        if marker_state == "missing":
                            marker.unlink()
                            expected = "scope marker is missing"
                        else:
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
                            expected = "scope marker does not match"

                        with self.assertRaisesRegex(sqlite3.DatabaseError, expected):
                            manager.ensure_private_scope(1)
                        if marker_state == "missing":
                            self.assertFalse(marker.exists())
                        else:
                            self.assertEqual(
                                json.loads(marker.read_text(encoding="utf-8")),
                                legacy,
                            )
                    finally:
                        db.close()

    def test_rotate_session_rejects_deleted_or_legacy_marker_without_db_writes(self):
        for marker_state in ("missing", "legacy"):
            with self.subTest(marker_state=marker_state):
                with tempfile.TemporaryDirectory() as td:
                    config = make_config(Path(td))
                    db = Database(config.db_path)
                    try:
                        manager = AgentScopeManager(config, db)
                        scope = manager.ensure_private_scope(1)
                        marker = (
                            Path(scope.workspace_path)
                            / ".ubitech-agent-scope.json"
                        )
                        before = db.query_one(
                            "SELECT session_id, lifecycle_id, updated_at "
                            "FROM agent_runtime_scopes WHERE scope_key = ?",
                            (scope.scope_key,),
                        )
                        aliases_before = db.scalar(
                            "SELECT COUNT(*) FROM agent_runtime_scope_sessions "
                            "WHERE scope_key = ?",
                            (scope.scope_key,),
                        )
                        if marker_state == "missing":
                            marker.unlink()
                            expected = "scope marker is missing"
                            marker_bytes = None
                        else:
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
                            marker_bytes = (
                                json.dumps(legacy, sort_keys=True) + "\n"
                            ).encode("utf-8")
                            marker.write_bytes(marker_bytes)
                            marker.chmod(0o600)
                            expected = "scope marker does not match"

                        with self.assertRaisesRegex(sqlite3.DatabaseError, expected):
                            manager.rotate_session(scope.scope_key)
                        self.assertEqual(
                            db.query_one(
                                "SELECT session_id, lifecycle_id, updated_at "
                                "FROM agent_runtime_scopes WHERE scope_key = ?",
                                (scope.scope_key,),
                            ),
                            before,
                        )
                        self.assertEqual(
                            db.scalar(
                                "SELECT COUNT(*) FROM agent_runtime_scope_sessions "
                                "WHERE scope_key = ?",
                                (scope.scope_key,),
                            ),
                            aliases_before,
                        )
                        if marker_bytes is None:
                            self.assertFalse(marker.exists())
                        else:
                            self.assertEqual(marker.read_bytes(), marker_bytes)
                    finally:
                        db.close()

    def test_existing_scope_never_repairs_missing_or_wrong_mode_workspace(self):
        for cached in (True, False):
            for workspace_state in ("missing", "wrong-mode"):
                with self.subTest(cached=cached, workspace_state=workspace_state):
                    with tempfile.TemporaryDirectory() as td:
                        config = make_config(Path(td))
                        db = Database(config.db_path)
                        try:
                            manager = AgentScopeManager(config, db)
                            scope = manager.ensure_private_scope(1)
                            workspace = Path(scope.workspace_path)
                            before = db.query_one(
                                "SELECT * FROM agent_scopes WHERE scope_key = ?",
                                (scope.scope_key,),
                            )
                            if not cached:
                                manager._scope_cache.clear()
                            if workspace_state == "missing":
                                shutil.rmtree(workspace)
                                expected = "workspace directory is missing"
                            else:
                                workspace.chmod(0o755)
                                expected = "workspace directory has unsafe metadata"

                            with self.assertRaisesRegex(
                                sqlite3.DatabaseError,
                                expected,
                            ):
                                manager.ensure_private_scope(1)
                            self.assertEqual(
                                db.query_one(
                                    "SELECT * FROM agent_scopes WHERE scope_key = ?",
                                    (scope.scope_key,),
                                ),
                                before,
                            )
                            if workspace_state == "missing":
                                self.assertFalse(workspace.exists())
                            else:
                                self.assertEqual(
                                    workspace.stat().st_mode & 0o777,
                                    0o755,
                                )
                        finally:
                            db.close()

    def test_rotate_session_never_repairs_missing_or_wrong_mode_workspace(self):
        for workspace_state in ("missing", "wrong-mode"):
            with self.subTest(workspace_state=workspace_state):
                with tempfile.TemporaryDirectory() as td:
                    config = make_config(Path(td))
                    db = Database(config.db_path)
                    try:
                        manager = AgentScopeManager(config, db)
                        scope = manager.ensure_private_scope(1)
                        workspace = Path(scope.workspace_path)
                        before = db.query_one(
                            "SELECT * FROM agent_runtime_scopes WHERE scope_key = ?",
                            (scope.scope_key,),
                        )
                        if workspace_state == "missing":
                            shutil.rmtree(workspace)
                            expected = "workspace directory is missing"
                        else:
                            workspace.chmod(0o755)
                            expected = "workspace directory has unsafe metadata"

                        with self.assertRaisesRegex(sqlite3.DatabaseError, expected):
                            manager.rotate_session(scope.scope_key)
                        self.assertEqual(
                            db.query_one(
                                "SELECT * FROM agent_runtime_scopes WHERE scope_key = ?",
                                (scope.scope_key,),
                            ),
                            before,
                        )
                        if workspace_state == "missing":
                            self.assertFalse(workspace.exists())
                        else:
                            self.assertEqual(
                                workspace.stat().st_mode & 0o777,
                                0o755,
                            )
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
                    sqlite3.DatabaseError,
                    "workspace directory has unsafe metadata",
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
