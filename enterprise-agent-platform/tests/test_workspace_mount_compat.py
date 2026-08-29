from __future__ import annotations

import os
import sqlite3
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from enterprise_agent_platform.workspace_mount_compat import (
    WorkspaceMountCompatibilityError,
    _source_database_requires_compatibility,
    normalize_legacy_workspace_mounts,
)
from enterprise_agent_platform.technical_profile import TARGET_DATABASE_BASELINE


def _mkdir(path: Path, mode: int = 0o700) -> None:
    path.mkdir(mode=mode, parents=True)
    path.chmod(mode)


def _root_fixture(directory: str) -> tuple[Path, Path, Path, int, int]:
    data = Path(directory) / "data"
    workspaces = data / "workspaces"
    workspace = workspaces / "user-1"
    internal = workspace / ".agent-platform"
    attachments = internal / "attachments"
    _mkdir(attachments, 0o755)
    target_uid = 12345
    target_gid = 12345
    for path in (data, workspaces, workspace):
        os.chown(path, target_uid, target_gid)
        path.chmod(0o700)
    return data, internal, attachments, target_uid, target_gid


class WorkspaceMountCompatibilityTests(unittest.TestCase):
    @unittest.skipIf(os.geteuid() == 0, "runs under the deployment identity")
    def test_only_source_database_marker_enables_compatibility(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / "data"
            _mkdir(data)
            self.assertFalse(_source_database_requires_compatibility(data))

            database = data / "platform.db"
            with sqlite3.connect(database) as connection:
                connection.execute(
                    "CREATE TABLE schema_migrations ("
                    "version INTEGER PRIMARY KEY, name TEXT NOT NULL, "
                    "applied_at INTEGER NOT NULL)"
                )
                connection.execute(
                    "INSERT INTO schema_migrations VALUES (?, ?, 1)",
                    (2026080801, TARGET_DATABASE_BASELINE),
                )
            self.assertTrue(_source_database_requires_compatibility(data))

            with sqlite3.connect(database) as connection:
                connection.execute(
                    "UPDATE schema_migrations SET version = 2026082901"
                )
            self.assertFalse(_source_database_requires_compatibility(data))

            with sqlite3.connect(database) as connection:
                connection.execute(
                    "UPDATE schema_migrations SET version = 1"
                )
            with self.assertRaises(WorkspaceMountCompatibilityError):
                _source_database_requires_compatibility(data)

    @unittest.skipIf(os.geteuid() == 0, "runs under the deployment identity")
    def test_tightens_owned_parent_without_touching_contents(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / "data"
            workspace = data / "workspaces" / "user-1"
            internal = workspace / ".agent-platform"
            _mkdir(data)
            _mkdir(data / "workspaces")
            _mkdir(workspace)
            _mkdir(internal, 0o755)
            content = internal / "plans"
            _mkdir(content)
            marker = content / "keep.txt"
            marker.write_text("keep\n", encoding="utf-8")
            marker.chmod(0o600)
            inode = internal.stat().st_ino

            with mock.patch(
                "enterprise_agent_platform.workspace_mount_compat.os.geteuid",
                return_value=0,
            ):
                changed = normalize_legacy_workspace_mounts(
                    data,
                    target_uid=os.getuid(),
                    target_gid=os.getgid(),
                )

            self.assertEqual(changed, 1)
            self.assertEqual(internal.stat().st_ino, inode)
            self.assertEqual(stat.S_IMODE(internal.stat().st_mode), 0o700)
            self.assertEqual(marker.read_text(encoding="utf-8"), "keep\n")

    @unittest.skipIf(os.geteuid() == 0, "runs under the deployment identity")
    def test_preflights_every_workspace_before_changing_any(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / "data"
            first = data / "workspaces" / "user-1" / ".agent-platform"
            second = data / "workspaces" / "user-2" / ".agent-platform"
            _mkdir(data)
            _mkdir(data / "workspaces")
            _mkdir(first.parent)
            _mkdir(second.parent)
            _mkdir(first, 0o755)
            _mkdir(second, 0o711)

            with (
                mock.patch(
                    "enterprise_agent_platform.workspace_mount_compat.os.geteuid",
                    return_value=0,
                ),
                self.assertRaises(WorkspaceMountCompatibilityError),
            ):
                normalize_legacy_workspace_mounts(
                    data,
                    target_uid=os.getuid(),
                    target_gid=os.getgid(),
                )

            self.assertEqual(stat.S_IMODE(first.stat().st_mode), 0o755)

    @unittest.skipIf(os.geteuid() == 0, "runs under the deployment identity")
    def test_rejects_symlinked_internal_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / "data"
            workspace = data / "workspaces" / "user-1"
            outside = data / "outside"
            _mkdir(data)
            _mkdir(data / "workspaces")
            _mkdir(workspace)
            _mkdir(outside)
            (workspace / ".agent-platform").symlink_to(outside, target_is_directory=True)

            with (
                mock.patch(
                    "enterprise_agent_platform.workspace_mount_compat.os.geteuid",
                    return_value=0,
                ),
                self.assertRaises(WorkspaceMountCompatibilityError),
            ):
                normalize_legacy_workspace_mounts(
                    data,
                    target_uid=os.getuid(),
                    target_gid=os.getgid(),
                )

            self.assertEqual(stat.S_IMODE(outside.stat().st_mode), 0o700)

    @unittest.skipUnless(os.geteuid() == 0, "requires root ownership fixtures")
    def test_adopts_exact_root_docker_residue_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            data, internal, attachments, target_uid, target_gid = _root_fixture(
                directory
            )

            self.assertEqual(
                normalize_legacy_workspace_mounts(
                    data,
                    target_uid=target_uid,
                    target_gid=target_gid,
                ),
                1,
            )
            self.assertEqual(
                (internal.stat().st_uid, internal.stat().st_gid),
                (target_uid, target_gid),
            )
            self.assertEqual(stat.S_IMODE(internal.stat().st_mode), 0o700)
            self.assertEqual(
                (attachments.stat().st_uid, attachments.stat().st_gid),
                (target_uid, target_gid),
            )
            self.assertEqual(stat.S_IMODE(attachments.stat().st_mode), 0o700)
            self.assertEqual(
                normalize_legacy_workspace_mounts(
                    data,
                    target_uid=target_uid,
                    target_gid=target_gid,
                ),
                1,
            )

    @unittest.skipUnless(os.geteuid() == 0, "requires root ownership fixtures")
    def test_rejects_nonempty_root_residue_before_owner_change(self):
        with tempfile.TemporaryDirectory() as directory:
            data, internal, attachments, target_uid, target_gid = _root_fixture(
                directory
            )
            (attachments / "unexpected").write_text("data", encoding="utf-8")

            with self.assertRaises(WorkspaceMountCompatibilityError):
                normalize_legacy_workspace_mounts(
                    data,
                    target_uid=target_uid,
                    target_gid=target_gid,
                )
            self.assertEqual((internal.stat().st_uid, internal.stat().st_gid), (0, 0))
            self.assertEqual(
                (attachments.stat().st_uid, attachments.stat().st_gid),
                (0, 0),
            )

    @unittest.skipUnless(os.geteuid() == 0, "requires root ownership fixtures")
    def test_resumes_each_safe_crash_identity(self):
        for child_mode in (0o755, 0o700):
            with self.subTest(parent="root", child_mode=oct(child_mode)):
                with tempfile.TemporaryDirectory() as directory:
                    data, internal, attachments, target_uid, target_gid = (
                        _root_fixture(directory)
                    )
                    os.chown(attachments, target_uid, target_gid)
                    attachments.chmod(child_mode)
                    normalize_legacy_workspace_mounts(
                        data,
                        target_uid=target_uid,
                        target_gid=target_gid,
                    )
                    self.assertEqual(
                        (internal.stat().st_uid, stat.S_IMODE(internal.stat().st_mode)),
                        (target_uid, 0o700),
                    )
                    self.assertEqual(
                        (
                            attachments.stat().st_uid,
                            stat.S_IMODE(attachments.stat().st_mode),
                        ),
                        (target_uid, 0o700),
                    )

        with self.subTest(parent="target", child_mode="0o700"):
            with tempfile.TemporaryDirectory() as directory:
                data, internal, attachments, target_uid, target_gid = _root_fixture(
                    directory
                )
                os.chown(attachments, target_uid, target_gid)
                attachments.chmod(0o700)
                os.chown(internal, target_uid, target_gid)
                normalize_legacy_workspace_mounts(
                    data,
                    target_uid=target_uid,
                    target_gid=target_gid,
                )
                self.assertEqual(stat.S_IMODE(internal.stat().st_mode), 0o700)

    @unittest.skipUnless(os.geteuid() == 0, "requires root ownership fixtures")
    def test_rejects_unknown_root_residue_without_mutation(self):
        for case in ("extra", "mode", "symlink"):
            with self.subTest(case=case):
                with tempfile.TemporaryDirectory() as directory:
                    data, internal, attachments, target_uid, target_gid = (
                        _root_fixture(directory)
                    )
                    if case == "extra":
                        (internal / "unexpected").write_text("data", encoding="utf-8")
                    elif case == "mode":
                        internal.chmod(0o700)
                    else:
                        attachments.rmdir()
                        (internal / "attachments").symlink_to("outside")
                    with self.assertRaises(WorkspaceMountCompatibilityError):
                        normalize_legacy_workspace_mounts(
                            data,
                            target_uid=target_uid,
                            target_gid=target_gid,
                        )
                    self.assertEqual((internal.stat().st_uid, internal.stat().st_gid), (0, 0))


if __name__ == "__main__":
    unittest.main()
