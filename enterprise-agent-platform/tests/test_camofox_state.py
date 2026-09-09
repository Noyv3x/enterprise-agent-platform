from __future__ import annotations

import json
import errno
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from enterprise_agent_platform import secure_fs

from enterprise_agent_platform.camofox_state import (
    CAMOFOX_SIDECAR_NAME,
    ensure_camofox_runtime_sidecar,
    expected_camofox_sidecar,
)
from enterprise_agent_platform.db import Database
from enterprise_agent_platform.technical_profile import TARGET_TECHNICAL_PROFILE


class CamofoxPlatformSidecarTests(unittest.TestCase):
    def test_initialization_replay_must_finish_durability_but_candidate_is_read_only(self):
        with tempfile.TemporaryDirectory() as td:
            data = Path(td) / "data"
            sidecar = ensure_camofox_runtime_sidecar(data, fresh_initialization=True)
            identity = sidecar.parent.stat()
            real_sync = os.fsync

            def fail_parent(fd):
                info = os.fstat(fd)
                if (info.st_dev, info.st_ino) == (identity.st_dev, identity.st_ino):
                    raise OSError(errno.EIO, "directory sync failed")
                real_sync(fd)

            with mock.patch.object(secure_fs.os, "fsync", side_effect=fail_parent):
                for _ in range(2):
                    with self.assertRaises(sqlite3.DatabaseError):
                        ensure_camofox_runtime_sidecar(data, fresh_initialization=True)
            with mock.patch.object(secure_fs.os, "fsync", side_effect=AssertionError("candidate writes")):
                self.assertEqual(
                    ensure_camofox_runtime_sidecar(
                        data, fresh_initialization=False, commit_schema_upgrade=False,
                    ), sidecar,
                )
            self.assertEqual(
                ensure_camofox_runtime_sidecar(data, fresh_initialization=True), sidecar,
            )

    def test_target_profile_creates_current_sidecar(self):
        with tempfile.TemporaryDirectory() as td:
            data = Path(td) / "data"
            sidecar = ensure_camofox_runtime_sidecar(
                data,
                fresh_initialization=True,
                technical_profile_value=TARGET_TECHNICAL_PROFILE,
            )
            self.assertEqual(sidecar.name, CAMOFOX_SIDECAR_NAME)
            self.assertEqual(
                json.loads(sidecar.read_text(encoding="utf-8")),
                expected_camofox_sidecar(TARGET_TECHNICAL_PROFILE),
            )

    def test_candidate_validation_does_not_create_sidecar_before_commit(self):
        with tempfile.TemporaryDirectory() as td:
            data = Path(td) / "data"
            sidecar = ensure_camofox_runtime_sidecar(
                data,
                fresh_initialization=True,
                commit_schema_upgrade=False,
            )
            self.assertFalse(sidecar.exists())
            self.assertFalse(data.exists())

            committed = ensure_camofox_runtime_sidecar(
                data,
                fresh_initialization=True,
                commit_schema_upgrade=True,
            )
            self.assertTrue(committed.is_file())

    def test_current_database_missing_sidecar_or_parents_fails_closed(self):
        for commit in (False, True):
            for missing in ("sidecar", "camofox", "runtimes"):
                with self.subTest(commit=commit, missing=missing), tempfile.TemporaryDirectory() as td:
                    data = Path(td) / "data"
                    sidecar = ensure_camofox_runtime_sidecar(data, fresh_initialization=True)
                    database_path = data / "platform.db"
                    Database(database_path, TARGET_TECHNICAL_PROFILE).close()
                    before_database = database_path.read_bytes()
                    sidecar.unlink()
                    if missing in ("camofox", "runtimes"):
                        sidecar.parent.rmdir()
                    if missing == "runtimes":
                        sidecar.parent.parent.rmdir()

                    with self.assertRaises(sqlite3.DatabaseError):
                        ensure_camofox_runtime_sidecar(
                            data,
                            fresh_initialization=False,
                            commit_schema_upgrade=commit,
                        )

                    self.assertEqual(database_path.read_bytes(), before_database)
                    self.assertFalse(sidecar.exists())
                    if missing in ("camofox", "runtimes"):
                        self.assertFalse(sidecar.parent.exists())
                    if missing == "runtimes":
                        self.assertFalse(sidecar.parent.parent.exists())

    def test_fresh_initialization_survives_database_creation_until_commit(self):
        for prepared_layout in (False, True):
            with self.subTest(prepared_layout=prepared_layout), tempfile.TemporaryDirectory() as td:
                data = Path(td) / "data"
                data.mkdir(mode=0o700)
                runtime = data / "runtimes" / "camofox"
                if prepared_layout:
                    runtime.parent.mkdir(mode=0o700)
                    runtime.mkdir(mode=0o700)
                database_path = data / "platform.db"
                sidecar = ensure_camofox_runtime_sidecar(
                    data, fresh_initialization=True, commit_schema_upgrade=False,
                )
                self.assertFalse(database_path.exists())
                self.assertFalse(sidecar.exists())
                self.assertEqual(runtime.exists(), prepared_layout)

                Database(database_path, TARGET_TECHNICAL_PROFILE).close()
                before_database = database_path.read_bytes()
                self.assertEqual(
                    ensure_camofox_runtime_sidecar(
                        data, fresh_initialization=True, commit_schema_upgrade=False,
                    ),
                    sidecar,
                )
                self.assertFalse(sidecar.exists())
                self.assertEqual(runtime.exists(), prepared_layout)
                self.assertEqual(
                    ensure_camofox_runtime_sidecar(
                        data, fresh_initialization=True, commit_schema_upgrade=True,
                    ),
                    sidecar,
                )
                self.assertEqual(
                    json.loads(sidecar.read_text(encoding="utf-8")),
                    expected_camofox_sidecar(),
                )
                self.assertEqual(database_path.read_bytes(), before_database)

    def test_creates_versioned_closed_world_sidecar_without_touching_browser_data(self):
        with tempfile.TemporaryDirectory() as td:
            data = Path(td) / "data"
            profile = data / "runtimes" / "camofox" / "profiles" / "abc"
            profile.mkdir(parents=True, mode=0o700)
            storage = profile / "storage-state.json"
            metadata = profile / "meta.json"
            storage.write_bytes(b'{"cookies":[{"name":"kept"}],"origins":[]}\n')
            metadata.write_bytes(b'{"userId":"third-party"}\n')
            before = (storage.read_bytes(), metadata.read_bytes())

            sidecar = ensure_camofox_runtime_sidecar(data, fresh_initialization=True)

            self.assertEqual(sidecar.name, CAMOFOX_SIDECAR_NAME)
            self.assertEqual(
                json.loads(sidecar.read_text(encoding="utf-8")),
                expected_camofox_sidecar(),
            )
            self.assertEqual((storage.read_bytes(), metadata.read_bytes()), before)
            self.assertEqual(sidecar.stat().st_mode & 0o777, 0o600)

    def test_unknown_or_conflicting_sidecar_is_rejected_unchanged(self):
        with tempfile.TemporaryDirectory() as td:
            data = Path(td) / "data"
            sidecar = ensure_camofox_runtime_sidecar(data, fresh_initialization=True)
            payload = expected_camofox_sidecar()
            payload["unknown"] = "do-not-guess"
            original = (json.dumps(payload, sort_keys=True) + "\n").encode("utf-8")
            sidecar.write_bytes(original)
            sidecar.chmod(0o600)

            with self.assertRaisesRegex(
                sqlite3.DatabaseError,
                "does not match the current technical profile",
            ):
                ensure_camofox_runtime_sidecar(data, fresh_initialization=False)
            self.assertEqual(sidecar.read_bytes(), original)

    def test_sidecar_requires_json_integer_schema_version(self):
        for invalid_version in (True, 1.0):
            with self.subTest(invalid_version=invalid_version):
                with tempfile.TemporaryDirectory() as td:
                    data = Path(td) / "data"
                    sidecar = ensure_camofox_runtime_sidecar(data, fresh_initialization=True)
                    payload = expected_camofox_sidecar()
                    payload["schema_version"] = invalid_version
                    original = (
                        json.dumps(payload, sort_keys=True) + "\n"
                    ).encode("utf-8")
                    sidecar.write_bytes(original)
                    sidecar.chmod(0o600)

                    with self.assertRaisesRegex(
                        sqlite3.DatabaseError,
                        "does not match the current technical profile",
                    ):
                        ensure_camofox_runtime_sidecar(data, fresh_initialization=False)
                    self.assertEqual(sidecar.read_bytes(), original)

    def test_duplicate_key_and_symlink_sidecars_fail_closed(self):
        with tempfile.TemporaryDirectory() as td:
            data = Path(td) / "data"
            runtime = data / "runtimes" / "camofox"
            runtime.mkdir(parents=True, mode=0o700)
            sidecar = runtime / CAMOFOX_SIDECAR_NAME
            sidecar.write_text(
                '{"schema_version":1,"schema_version":1}\n',
                encoding="utf-8",
            )
            sidecar.chmod(0o600)
            with self.assertRaisesRegex(sqlite3.DatabaseError, "invalid JSON"):
                ensure_camofox_runtime_sidecar(data, fresh_initialization=True)

            sidecar.unlink()
            outside = Path(td) / "outside.json"
            outside.write_text("{}\n", encoding="utf-8")
            sidecar.symlink_to(outside)
            with self.assertRaisesRegex(sqlite3.DatabaseError, "unsafe file metadata"):
                ensure_camofox_runtime_sidecar(data, fresh_initialization=True)


if __name__ == "__main__":
    unittest.main()
