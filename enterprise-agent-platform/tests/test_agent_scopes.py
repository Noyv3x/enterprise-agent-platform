from __future__ import annotations

import json
import os
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from enterprise_agent_platform import db as db_module
from enterprise_agent_platform import agent_scopes as agent_scopes_module
from enterprise_agent_platform import secure_fs
from enterprise_agent_platform.agent_scopes import AgentScopeManager
from enterprise_agent_platform.container_contract_generated import DATABASE_SCHEMA_VERSION
from enterprise_agent_platform.db import Database

from test_platform import make_config


class AgentScopeSessionTests(unittest.TestCase):
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
                original = marker.read_bytes()

                with self.assertRaisesRegex(
                    sqlite3.DatabaseError,
                    "scope marker does not match",
                ):
                    AgentScopeManager(config, db)
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

                candidate = AgentScopeManager(
                    config,
                    db,
                    commit_schema_upgrade=False,
                    allow_unmaterialized_p1_workspaces=True,
                )
                candidate.commit_schema_upgrade()

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
                    allow_unmaterialized_p1_workspaces=True,
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
                candidate = AgentScopeManager(
                    config,
                    db,
                    commit_schema_upgrade=False,
                    allow_unmaterialized_p1_workspaces=True,
                )
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
                with self.assertRaisesRegex(
                    sqlite3.DatabaseError,
                    "scope marker does not match",
                ):
                    AgentScopeManager(config, db)
                with self.assertRaisesRegex(
                    sqlite3.DatabaseError,
                    "scope marker does not match",
                ):
                    AgentScopeManager(
                        config,
                        db,
                        commit_schema_upgrade=False,
                    )
                self.assertFalse(marker.exists())
                candidate = AgentScopeManager(
                    config,
                    db,
                    commit_schema_upgrade=False,
                    allow_unmaterialized_p1_workspaces=True,
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

    def test_p1_commit_rejects_same_bytes_marker_inode_replacement(self):
        for marker_state in ("current", "legacy"):
            with self.subTest(marker_state=marker_state):
                with tempfile.TemporaryDirectory() as td:
                    config = make_config(Path(td))
                    db = Database(config.db_path)
                    try:
                        scope = AgentScopeManager(config, db).ensure_private_scope(1)
                        marker = (
                            Path(scope.workspace_path)
                            / ".ubitech-agent-scope.json"
                        )
                        if marker_state == "legacy":
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

                        candidate = AgentScopeManager(
                            config,
                            db,
                            commit_schema_upgrade=False,
                            allow_unmaterialized_p1_workspaces=True,
                        )
                        observed = marker.stat()
                        original = marker.read_bytes()
                        replacement = marker.with_name(".same-bytes-replacement")
                        replacement.write_bytes(original)
                        replacement.chmod(0o600)
                        replacement_identity = replacement.stat()
                        self.assertNotEqual(
                            (observed.st_dev, observed.st_ino),
                            (
                                replacement_identity.st_dev,
                                replacement_identity.st_ino,
                            ),
                        )
                        os.replace(replacement, marker)

                        with self.assertRaisesRegex(
                            sqlite3.DatabaseError,
                            "marker identity changed",
                        ):
                            candidate.commit_schema_upgrade()
                        self.assertEqual(marker.read_bytes(), original)
                        self.assertEqual(
                            (marker.stat().st_dev, marker.stat().st_ino),
                            (
                                replacement_identity.st_dev,
                                replacement_identity.st_ino,
                            ),
                        )
                    finally:
                        db.close()

    def test_candidate_keeps_unmaterialized_p1_scope_read_only_until_commit(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            db = Database(config.db_path)
            try:
                scope = AgentScopeManager(config, db).ensure_channel_scope(1)
                workspace = Path(scope.workspace_path)
                channel_root = workspace.parent
                shutil.rmtree(channel_root)

                candidate = AgentScopeManager(
                    config,
                    db,
                    commit_schema_upgrade=False,
                    allow_unmaterialized_p1_workspaces=True,
                )
                self.assertFalse(channel_root.exists())

                candidate.commit_schema_upgrade()
                self.assertEqual(channel_root.stat().st_mode & 0o777, 0o700)
                self.assertEqual(workspace.stat().st_mode & 0o777, 0o700)
                marker = workspace / ".ubitech-agent-scope.json"
                payload = json.loads(marker.read_text(encoding="utf-8"))
                self.assertEqual(payload["schema_version"], 1)
                self.assertEqual(payload["scope_key"], "channel:1:main-agent")
                self.assertEqual(payload["workspace_id"], "channels/channel-1")
            finally:
                db.close()

    def test_candidate_rejects_unsafe_prefix_for_unmaterialized_p1_scope(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            db = Database(config.db_path)
            try:
                scope = AgentScopeManager(config, db).ensure_channel_scope(1)
                channel_root = Path(scope.workspace_path).parent
                shutil.rmtree(channel_root)
                redirect = Path(td) / "redirect"
                redirect.mkdir(mode=0o700)
                channel_root.symlink_to(redirect, target_is_directory=True)

                with self.assertRaisesRegex(
                    sqlite3.DatabaseError,
                    "workspace directory has unsafe metadata",
                ):
                    AgentScopeManager(
                        config,
                        db,
                        commit_schema_upgrade=False,
                        allow_unmaterialized_p1_workspaces=True,
                    )
                self.assertTrue(channel_root.is_symlink())
            finally:
                db.close()

    def test_unmaterialized_p1_commit_replays_after_marker_failure(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            db = Database(config.db_path)
            try:
                scope = AgentScopeManager(config, db).ensure_channel_scope(1)
                workspace = Path(scope.workspace_path)
                shutil.rmtree(workspace.parent)
                candidate = AgentScopeManager(
                    config,
                    db,
                    commit_schema_upgrade=False,
                    allow_unmaterialized_p1_workspaces=True,
                )

                with mock.patch.object(
                    candidate,
                    "_write_scope_marker",
                    side_effect=RuntimeError("simulated marker failure"),
                ):
                    with self.assertRaisesRegex(RuntimeError, "marker failure"):
                        candidate.commit_schema_upgrade()
                self.assertTrue(workspace.is_dir())
                self.assertFalse(
                    (workspace / ".ubitech-agent-scope.json").exists()
                )

                candidate.commit_schema_upgrade()
                self.assertEqual(
                    json.loads(
                        (workspace / ".ubitech-agent-scope.json").read_text(
                            encoding="utf-8"
                        )
                    )["scope_key"],
                    scope.scope_key,
                )
            finally:
                db.close()

    def test_unmaterialized_p1_commit_retries_after_directory_durability_failure(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            db = Database(config.db_path)
            try:
                scope = AgentScopeManager(config, db).ensure_channel_scope(1)
                second_scope = AgentScopeManager(config, db).ensure_channel_scope(2)
                workspace = Path(scope.workspace_path)
                second_workspace = Path(second_scope.workspace_path)
                db.execute(
                    "DELETE FROM agent_runtime_scope_sessions "
                    "WHERE scope_key = ? AND session_id = ?",
                    (scope.scope_key, scope.session_id),
                )
                shutil.rmtree(workspace.parent)
                candidate = AgentScopeManager(
                    config,
                    db,
                    commit_schema_upgrade=False,
                    allow_unmaterialized_p1_workspaces=True,
                )
                real_rename = secure_fs._rename_noreplace
                real_fsync = secure_fs.os.fsync
                renamed = False
                failed = False
                post_rename_syncs = 0

                def rename_then_arm(*args, **kwargs):
                    nonlocal renamed
                    result = real_rename(*args, **kwargs)
                    renamed = True
                    return result

                def fail_first_post_rename_fsync(fd):
                    nonlocal failed, post_rename_syncs
                    if renamed:
                        post_rename_syncs += 1
                        if post_rename_syncs == 3 and not failed:
                            failed = True
                            raise OSError(
                                "simulated destination durability failure"
                            )
                    return real_fsync(fd)

                with mock.patch.object(
                    secure_fs,
                    "_rename_noreplace",
                    side_effect=rename_then_arm,
                ), mock.patch.object(
                    secure_fs.os,
                    "fsync",
                    side_effect=fail_first_post_rename_fsync,
                ):
                    with self.assertRaisesRegex(
                        sqlite3.DatabaseError,
                        "publication was not durable",
                    ):
                        candidate.commit_schema_upgrade()

                self.assertEqual(post_rename_syncs, 3)
                self.assertTrue(workspace.parent.is_dir())
                self.assertFalse(workspace.exists())
                self.assertEqual(
                    db.scalar(
                        "SELECT COUNT(*) FROM agent_runtime_scope_sessions "
                        "WHERE scope_key = ? AND session_id = ?",
                        (scope.scope_key, scope.session_id),
                    ),
                    0,
                )
                candidate.commit_schema_upgrade()
                self.assertTrue(workspace.is_dir())
                self.assertTrue(second_workspace.is_dir())
                self.assertTrue(
                    (workspace / ".ubitech-agent-scope.json").is_file()
                )
                self.assertTrue(
                    (second_workspace / ".ubitech-agent-scope.json").is_file()
                )
                self.assertEqual(
                    candidate._workspace_directory_empty_recovery,
                    {},
                )
                self.assertEqual(
                    db.scalar(
                        "SELECT COUNT(*) FROM agent_runtime_scope_sessions "
                        "WHERE scope_key = ? AND session_id = ?",
                        (scope.scope_key, scope.session_id),
                    ),
                    1,
                )
            finally:
                db.close()

    def test_existing_nonempty_prefix_retry_does_not_require_empty_recovery(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            db = Database(config.db_path)
            try:
                first = AgentScopeManager(config, db).ensure_channel_scope(1)
                second = AgentScopeManager(config, db).ensure_channel_scope(2)
                channels = Path(first.workspace_path).parent
                channels_identity = (
                    channels.stat().st_dev,
                    channels.stat().st_ino,
                )
                candidate = AgentScopeManager(
                    config,
                    db,
                    commit_schema_upgrade=False,
                    allow_unmaterialized_p1_workspaces=True,
                )
                real_fsync = secure_fs.os.fsync
                failed = False

                def fail_existing_prefix_once(fd):
                    nonlocal failed
                    opened = os.fstat(fd)
                    if (
                        not failed
                        and (opened.st_dev, opened.st_ino) == channels_identity
                    ):
                        failed = True
                        raise OSError("simulated existing prefix durability failure")
                    return real_fsync(fd)

                with mock.patch.object(
                    secure_fs.os,
                    "fsync",
                    side_effect=fail_existing_prefix_once,
                ):
                    with self.assertRaisesRegex(
                        sqlite3.DatabaseError,
                        "publication was not durable",
                    ):
                        candidate.commit_schema_upgrade()

                self.assertEqual(
                    candidate._workspace_directory_empty_recovery,
                    {},
                )
                candidate.commit_schema_upgrade()
                self.assertTrue(Path(first.workspace_path).is_dir())
                self.assertTrue(Path(second.workspace_path).is_dir())
                self.assertTrue(
                    (
                        Path(first.workspace_path)
                        / ".ubitech-agent-scope.json"
                    ).is_file()
                )
                self.assertTrue(
                    (
                        Path(second.workspace_path)
                        / ".ubitech-agent-scope.json"
                    ).is_file()
                )
                self.assertEqual(
                    candidate._workspace_directory_empty_recovery,
                    {},
                )
            finally:
                db.close()

    def test_missing_p1_marker_retries_after_link_durability_failure(self):
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
                    allow_unmaterialized_p1_workspaces=True,
                )
                real_link = secure_fs._link_anonymous_file_at
                real_fsync = secure_fs.os.fsync
                linked = False
                failed = False

                def link_then_arm(file_fd, parent_fd, name):
                    nonlocal linked
                    result = real_link(file_fd, parent_fd, name)
                    if name == marker.name:
                        linked = True
                    return result

                def fail_first_post_link_fsync(fd):
                    nonlocal failed
                    if linked and not failed:
                        failed = True
                        raise OSError("simulated post-link durability failure")
                    return real_fsync(fd)

                with mock.patch.object(
                    secure_fs,
                    "_link_anonymous_file_at",
                    side_effect=link_then_arm,
                ), mock.patch.object(
                    secure_fs.os,
                    "fsync",
                    side_effect=fail_first_post_link_fsync,
                ):
                    with self.assertRaisesRegex(
                        sqlite3.DatabaseError,
                        "publication was not durable",
                    ):
                        candidate.commit_schema_upgrade()

                published = marker.stat()
                candidate.commit_schema_upgrade()
                self.assertEqual(
                    (marker.stat().st_dev, marker.stat().st_ino),
                    (published.st_dev, published.st_ino),
                )
                self.assertEqual(
                    json.loads(marker.read_text(encoding="utf-8"))["schema_version"],
                    1,
                )
            finally:
                db.close()

    def test_legacy_p1_marker_retries_after_old_inode_cleanup_failure(self):
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
                candidate = AgentScopeManager(
                    config,
                    db,
                    commit_schema_upgrade=False,
                    allow_unmaterialized_p1_workspaces=True,
                )
                real_unlink = secure_fs.os.unlink
                failed = False

                def fail_first_old_inode_cleanup(name, *args, **kwargs):
                    nonlocal failed
                    if (
                        not failed
                        and isinstance(name, str)
                        and name.startswith(".platform-machine-scope-")
                    ):
                        failed = True
                        raise OSError("simulated old inode cleanup failure")
                    return real_unlink(name, *args, **kwargs)

                with mock.patch.object(
                    secure_fs.os,
                    "unlink",
                    side_effect=fail_first_old_inode_cleanup,
                ):
                    with self.assertRaisesRegex(
                        sqlite3.DatabaseError,
                        "publication was not durable",
                    ):
                        candidate.commit_schema_upgrade()

                published = marker.stat()
                self.assertEqual(
                    len(list(config.data_dir.glob(".platform-machine-scope-*.stage"))),
                    1,
                )
                candidate.commit_schema_upgrade()
                self.assertEqual(
                    (marker.stat().st_dev, marker.stat().st_ino),
                    (published.st_dev, published.st_ino),
                )
                self.assertEqual(
                    list(config.data_dir.glob(".platform-machine-scope-*.stage")),
                    [],
                )
            finally:
                db.close()

    def test_unmaterialized_p1_commit_rejects_workspace_replacement_after_marker(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            db = Database(config.db_path)
            try:
                scope = AgentScopeManager(config, db).ensure_channel_scope(1)
                workspace = Path(scope.workspace_path)
                shutil.rmtree(workspace.parent)
                candidate = AgentScopeManager(
                    config,
                    db,
                    commit_schema_upgrade=False,
                    allow_unmaterialized_p1_workspaces=True,
                )
                displaced = workspace.parent / "channel-1-created-away"
                real_write = candidate._write_scope_marker

                def write_then_replace(marker_scope, **kwargs):
                    real_write(marker_scope, **kwargs)
                    workspace.rename(displaced)
                    workspace.mkdir(mode=0o700)

                with mock.patch.object(
                    candidate,
                    "_write_scope_marker",
                    side_effect=write_then_replace,
                ):
                    with self.assertRaisesRegex(
                        sqlite3.DatabaseError,
                        "changed during schema commit",
                    ):
                        candidate.commit_schema_upgrade()
                with self.assertRaisesRegex(
                    sqlite3.DatabaseError,
                    "could not be committed safely",
                ):
                    candidate.commit_schema_upgrade()
                self.assertTrue(
                    (displaced / ".ubitech-agent-scope.json").is_file()
                )
                self.assertFalse(
                    (workspace / ".ubitech-agent-scope.json").exists()
                )
            finally:
                db.close()

    def test_p1_commit_never_recreates_a_candidate_observed_workspace(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            db = Database(config.db_path)
            try:
                scope = AgentScopeManager(config, db).ensure_private_scope(1)
                workspace = Path(scope.workspace_path)
                sentinel = workspace / "user-file.txt"
                sentinel.write_text("preserve", encoding="utf-8")
                displaced = workspace.with_name("user-1-displaced")
                candidate = AgentScopeManager(
                    config,
                    db,
                    commit_schema_upgrade=False,
                    allow_unmaterialized_p1_workspaces=True,
                )
                workspace.rename(displaced)

                for _ in range(2):
                    with self.assertRaisesRegex(
                        sqlite3.DatabaseError,
                        "could not be committed safely",
                    ):
                        candidate.commit_schema_upgrade()
                    self.assertFalse(workspace.exists())
                    self.assertEqual(
                        (displaced / sentinel.name).read_text(encoding="utf-8"),
                        "preserve",
                    )
            finally:
                db.close()

    def test_p1_commit_rejects_an_externally_materialized_missing_prefix_on_retry(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            db = Database(config.db_path)
            try:
                scope = AgentScopeManager(config, db).ensure_channel_scope(1)
                channel_root = Path(scope.workspace_path).parent
                shutil.rmtree(channel_root)
                candidate = AgentScopeManager(
                    config,
                    db,
                    commit_schema_upgrade=False,
                    allow_unmaterialized_p1_workspaces=True,
                )
                channel_root.mkdir(mode=0o700)

                for _ in range(2):
                    with self.assertRaisesRegex(
                        sqlite3.DatabaseError,
                        "could not be committed safely",
                    ):
                        candidate.commit_schema_upgrade()
                self.assertTrue(channel_root.is_dir())
                self.assertFalse(Path(scope.workspace_path).exists())
            finally:
                db.close()

    def test_non_p1_candidate_rejects_unmaterialized_scope(self):
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
