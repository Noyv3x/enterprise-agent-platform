from __future__ import annotations

import fcntl
import os
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

from enterprise_agent_platform import db as db_module
from enterprise_agent_platform import service as service_module
from enterprise_agent_platform.db import Database
from enterprise_agent_platform.secure_fs import UnsafePrivatePathError
from enterprise_agent_platform.service import EnterpriseService
from enterprise_agent_platform.technical_profile import TARGET_TECHNICAL_PROFILE

from test_platform import make_config


class PlatformStorageSafetyTests(unittest.TestCase):
    @staticmethod
    def _target_config(data_dir: Path):
        return replace(
            make_config(data_dir),
            technical_profile=TARGET_TECHNICAL_PROFILE,
        )

    @staticmethod
    def _instance_lock_owner(config) -> EnterpriseService:
        service = object.__new__(EnterpriseService)
        service.config = config
        service._instance_lock_fd = None
        service._instance_lock_directory_fd = None
        service._instance_lock_finalizer = None
        return service

    def test_target_instance_lock_rejects_symlink_without_touching_target(self):
        if not hasattr(os, "symlink"):
            self.skipTest("symlinks are not supported")
        with tempfile.TemporaryDirectory() as td:
            config = self._target_config(Path(td))
            victim = config.data_dir / "outside-lock-target"
            victim.write_bytes(b"do-not-touch")
            victim.chmod(0o644)
            lock_path = config.data_dir / config.technical_profile.instance_lock_name
            lock_path.symlink_to(victim.name)

            owner = self._instance_lock_owner(config)
            with self.assertRaises(UnsafePrivatePathError):
                owner._acquire_instance_lock()

            self.assertEqual(victim.read_bytes(), b"do-not-touch")
            self.assertEqual(victim.stat().st_mode & 0o777, 0o644)

    def test_target_instance_lock_rejects_hardlink_without_touching_inode(self):
        with tempfile.TemporaryDirectory() as td:
            config = self._target_config(Path(td))
            victim = config.data_dir / "outside-lock-target"
            victim.write_bytes(b"do-not-touch")
            victim.chmod(0o644)
            lock_path = config.data_dir / config.technical_profile.instance_lock_name
            os.link(victim, lock_path)

            owner = self._instance_lock_owner(config)
            with self.assertRaisesRegex(UnsafePrivatePathError, "link count"):
                owner._acquire_instance_lock()

            self.assertEqual(victim.read_bytes(), b"do-not-touch")
            self.assertEqual(victim.stat().st_mode & 0o777, 0o644)
            self.assertEqual(victim.stat().st_nlink, 2)

    def test_target_instance_lock_rejects_inode_swap_after_flock(self):
        with tempfile.TemporaryDirectory() as td:
            config = self._target_config(Path(td))
            lock_path = config.data_dir / config.technical_profile.instance_lock_name
            displaced = config.data_dir / "displaced-lock"
            real_flock = service_module.fcntl.flock
            swapped = False

            def swapping_flock(fd: int, operation: int):
                nonlocal swapped
                result = real_flock(fd, operation)
                if not swapped and operation & fcntl.LOCK_EX:
                    swapped = True
                    os.replace(lock_path, displaced)
                    lock_path.write_bytes(b"replacement")
                    lock_path.chmod(0o600)
                return result

            owner = self._instance_lock_owner(config)
            with mock.patch.object(
                service_module.fcntl,
                "flock",
                side_effect=swapping_flock,
            ):
                with self.assertRaisesRegex(UnsafePrivatePathError, "changed identity"):
                    owner._acquire_instance_lock()

            self.assertTrue(swapped)
            self.assertEqual(lock_path.read_bytes(), b"replacement")
            self.assertEqual(displaced.read_bytes(), b"")

    def test_target_database_rejects_symlink_and_hardlink_before_sqlite(self):
        if not hasattr(os, "symlink"):
            self.skipTest("symlinks are not supported")
        for link_kind in ("symlink", "hardlink"):
            with self.subTest(link_kind=link_kind), tempfile.TemporaryDirectory() as td:
                root = Path(td)
                path = root / "platform.db"
                victim = root / "outside-database"
                victim.write_bytes(b"do-not-touch")
                victim.chmod(0o644)
                if link_kind == "symlink":
                    path.symlink_to(victim.name)
                else:
                    os.link(victim, path)

                with self.assertRaises(UnsafePrivatePathError):
                    Database(path, TARGET_TECHNICAL_PROFILE)

                self.assertEqual(victim.read_bytes(), b"do-not-touch")
                self.assertEqual(victim.stat().st_mode & 0o777, 0o644)
                self.assertFalse(Path(f"{path}-wal").exists())
                self.assertFalse(Path(f"{path}-shm").exists())

    def test_target_database_rejects_unsafe_existing_sidecars_before_sqlite(self):
        if not hasattr(os, "symlink"):
            self.skipTest("symlinks are not supported")
        for suffix, link_kind in (("-wal", "hardlink"), ("-shm", "symlink")):
            with (
                self.subTest(suffix=suffix, link_kind=link_kind),
                tempfile.TemporaryDirectory() as td,
            ):
                root = Path(td)
                path = root / "platform.db"
                database = Database(path, TARGET_TECHNICAL_PROFILE)
                database.close()
                victim = root / f"outside{suffix}"
                victim.write_bytes(b"do-not-touch")
                victim.chmod(0o644)
                sidecar = Path(f"{path}{suffix}")
                if link_kind == "hardlink":
                    os.link(victim, sidecar)
                else:
                    sidecar.symlink_to(victim.name)

                with self.assertRaises(UnsafePrivatePathError):
                    Database(path, TARGET_TECHNICAL_PROFILE)

                self.assertEqual(victim.read_bytes(), b"do-not-touch")
                self.assertEqual(victim.stat().st_mode & 0o777, 0o644)

    def test_target_database_rejects_connect_window_inode_swap_before_wal(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            path = root / "platform.db"
            displaced = root / "displaced-database"
            replacement = b"replacement-must-not-be-opened"
            real_connect = db_module.sqlite3.connect
            swapped = False

            def swapping_connect(*args, **kwargs):
                nonlocal swapped
                connection = real_connect(*args, **kwargs)
                if not swapped:
                    swapped = True
                    os.replace(path, displaced)
                    path.write_bytes(replacement)
                    path.chmod(0o600)
                return connection

            with mock.patch.object(
                db_module.sqlite3,
                "connect",
                side_effect=swapping_connect,
            ):
                with self.assertRaisesRegex(UnsafePrivatePathError, "changed identity"):
                    Database(path, TARGET_TECHNICAL_PROFILE)

            self.assertTrue(swapped)
            self.assertEqual(path.read_bytes(), replacement)
            self.assertEqual(displaced.read_bytes(), b"")
            self.assertFalse(Path(f"{path}-wal").exists())
            self.assertFalse(Path(f"{path}-shm").exists())


if __name__ == "__main__":
    unittest.main()
