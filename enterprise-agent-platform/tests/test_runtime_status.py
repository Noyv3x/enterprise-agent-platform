from __future__ import annotations

import threading
import time
import unittest
from unittest import mock

from enterprise_agent_platform.runtimes import PlatformRuntimeManager, RuntimeStatus


class RuntimeStatusContractTests(unittest.TestCase):
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
