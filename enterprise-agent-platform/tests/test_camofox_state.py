from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from enterprise_agent_platform.camofox_state import (
    CAMOFOX_SIDECAR_NAME,
    ensure_camofox_runtime_sidecar,
    expected_camofox_sidecar,
)
from enterprise_agent_platform.technical_profile import TARGET_TECHNICAL_PROFILE


class CamofoxPlatformSidecarTests(unittest.TestCase):
    def test_target_profile_creates_current_sidecar(self):
        with tempfile.TemporaryDirectory() as td:
            data = Path(td) / "data"
            sidecar = ensure_camofox_runtime_sidecar(
                data,
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
                commit_schema_upgrade=False,
            )
            self.assertFalse(sidecar.exists())
            self.assertFalse(data.exists())

            committed = ensure_camofox_runtime_sidecar(
                data,
                commit_schema_upgrade=True,
            )
            self.assertTrue(committed.is_file())

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

            sidecar = ensure_camofox_runtime_sidecar(data)

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
            sidecar = ensure_camofox_runtime_sidecar(data)
            payload = expected_camofox_sidecar()
            payload["unknown"] = "do-not-guess"
            original = (json.dumps(payload, sort_keys=True) + "\n").encode("utf-8")
            sidecar.write_bytes(original)
            sidecar.chmod(0o600)

            with self.assertRaisesRegex(
                sqlite3.DatabaseError,
                "does not match the current technical profile",
            ):
                ensure_camofox_runtime_sidecar(data)
            self.assertEqual(sidecar.read_bytes(), original)

    def test_sidecar_requires_json_integer_schema_version(self):
        for invalid_version in (True, 1.0):
            with self.subTest(invalid_version=invalid_version):
                with tempfile.TemporaryDirectory() as td:
                    data = Path(td) / "data"
                    sidecar = ensure_camofox_runtime_sidecar(data)
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
                        ensure_camofox_runtime_sidecar(data)
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
                ensure_camofox_runtime_sidecar(data)

            sidecar.unlink()
            outside = Path(td) / "outside.json"
            outside.write_text("{}\n", encoding="utf-8")
            sidecar.symlink_to(outside)
            with self.assertRaisesRegex(sqlite3.DatabaseError, "unsafe file metadata"):
                ensure_camofox_runtime_sidecar(data)


if __name__ == "__main__":
    unittest.main()
