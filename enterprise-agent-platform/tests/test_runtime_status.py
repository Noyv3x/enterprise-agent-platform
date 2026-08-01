from __future__ import annotations

import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from enterprise_agent_platform.runtimes import PlatformRuntimeManager, RuntimeStatus
from enterprise_agent_platform.technical_profile import (
    SOURCE_TECHNICAL_PROFILE,
    TARGET_TECHNICAL_PROFILE,
)


class RuntimeStatusContractTests(unittest.TestCase):
    @staticmethod
    def _manager(profile, secrets=None):
        values = dict(secrets or {})
        return PlatformRuntimeManager(
            SimpleNamespace(technical_profile=profile),
            lambda key: values.get(key, ""),
        )

    def test_camofox_secret_uses_the_active_profile_namespace(self):
        with mock.patch.dict(
            os.environ,
            {"CAMOFOX_ACCESS_KEY": "source-key"},
            clear=True,
        ):
            self.assertEqual(
                self._manager(SOURCE_TECHNICAL_PROFILE)._camofox_access_key(),
                "source-key",
            )
        with mock.patch.dict(
            os.environ,
            {"AGENT_PLATFORM_CAMOFOX_ACCESS_KEY": "target-key"},
            clear=True,
        ):
            self.assertEqual(
                self._manager(TARGET_TECHNICAL_PROFILE)._camofox_access_key(),
                "target-key",
            )

    def test_target_camofox_secret_accepts_only_the_exact_target_file(self):
        manager = self._manager(TARGET_TECHNICAL_PROFILE)
        exact = "/run/secrets/agent-platform/camofox-access-key"
        with (
            mock.patch.dict(
                os.environ,
                {"AGENT_PLATFORM_CAMOFOX_ACCESS_KEY_FILE": exact},
                clear=True,
            ),
            mock.patch.object(
                manager,
                "_read_secret_file",
                return_value="file-key",
            ) as read_secret,
        ):
            self.assertEqual(manager._camofox_access_key(), "file-key")
            read_secret.assert_called_once_with(
                exact,
                "AGENT_PLATFORM_CAMOFOX_ACCESS_KEY_FILE",
            )

        with mock.patch.dict(
            os.environ,
            {"AGENT_PLATFORM_CAMOFOX_ACCESS_KEY_FILE": "/tmp/source-key"},
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "must be"):
                manager._camofox_access_key()

    def test_camofox_secret_mixed_profiles_fail_closed(self):
        cases = (
            (
                SOURCE_TECHNICAL_PROFILE,
                {"AGENT_PLATFORM_CAMOFOX_ACCESS_KEY": "target-key"},
            ),
            (
                TARGET_TECHNICAL_PROFILE,
                {"CAMOFOX_ACCESS_KEY": "source-key"},
            ),
            (
                TARGET_TECHNICAL_PROFILE,
                {
                    "AGENT_PLATFORM_CAMOFOX_ACCESS_KEY": "target-key",
                    "AGENT_PLATFORM_CAMOFOX_ACCESS_KEY_FILE": (
                        "/run/secrets/agent-platform/camofox-access-key"
                    ),
                },
            ),
        )
        for profile, environment in cases:
            with self.subTest(profile=profile.profile_id, environment=environment):
                with mock.patch.dict(os.environ, environment, clear=True):
                    with self.assertRaisesRegex(
                        RuntimeError,
                        "cannot be mixed|cannot both be set",
                    ):
                        self._manager(profile)._camofox_access_key()

    def test_camofox_secret_file_reader_rejects_symlinks_and_empty_files(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            secret = root / "secret"
            secret.write_text("secret-value\n", encoding="utf-8")
            self.assertEqual(
                PlatformRuntimeManager._read_secret_file(str(secret), "TEST_FILE"),
                "secret-value",
            )
            empty = root / "empty"
            empty.touch()
            with self.assertRaisesRegex(RuntimeError, "empty"):
                PlatformRuntimeManager._read_secret_file(str(empty), "TEST_FILE")
            link = root / "link"
            link.symlink_to(secret)
            with self.assertRaisesRegex(RuntimeError, "readable secret file"):
                PlatformRuntimeManager._read_secret_file(str(link), "TEST_FILE")

    def test_public_shape_contains_only_current_health_fields(self):
        status = RuntimeStatus(
            name="agent",
            available=True,
            state="running",
            detail="ready",
        )

        self.assertEqual(
            status.to_dict(),
            {
                "name": "agent",
                "available": True,
                "state": "running",
                "detail": "ready",
                "error": "",
            },
        )

    def test_service_helpers_emit_current_states(self):
        self.assertEqual(
            PlatformRuntimeManager._service_status("agent", True, "ready").state,
            "running",
        )
        self.assertEqual(
            PlatformRuntimeManager._service_status("agent", False, "not ready").state,
            "unavailable",
        )
        invalid = PlatformRuntimeManager._invalid_status("agent", "bad endpoint")
        self.assertEqual(invalid.state, "invalid_config")
        self.assertEqual(invalid.error, "bad endpoint")

    def test_close_waits_for_active_status_refresh_threads(self):
        manager = PlatformRuntimeManager(object(), lambda _key: "")
        status_started = threading.Event()
        searxng_started = threading.Event()
        release = threading.Event()

        def blocked_status(*, refresh=True):
            status_started.set()
            release.wait(timeout=2)
            return {}

        def blocked_searxng(*, refresh=True):
            searxng_started.set()
            release.wait(timeout=2)
            return RuntimeStatus("searxng", True, "running")

        manager._searxng_cache = RuntimeStatus(
            "searxng", False, "unavailable"
        ).to_dict()
        with (
            mock.patch.object(manager, "status", side_effect=blocked_status),
            mock.patch.object(
                manager,
                "searxng_status",
                side_effect=blocked_searxng,
            ),
        ):
            manager.refresh_status_async()
            manager.cached_searxng_status(max_age_seconds=0)
            self.assertTrue(status_started.wait(timeout=1))
            self.assertTrue(searxng_started.wait(timeout=1))

            closer = threading.Thread(target=manager.close)
            closer.start()
            time.sleep(0.05)
            self.assertTrue(closer.is_alive())
            release.set()
            closer.join(timeout=2)
            self.assertFalse(closer.is_alive())


if __name__ == "__main__":
    unittest.main()
