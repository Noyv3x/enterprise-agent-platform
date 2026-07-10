from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from enterprise_agent_platform.hermes_oauth_bridge import HermesOAuthBridge


class HermesOAuthBridgeCatalogCacheTests(unittest.TestCase):
    def test_model_catalog_reuses_and_copies_cached_result(self):
        bridge = HermesOAuthBridge(object())
        calls: list[tuple[str, dict]] = []

        def fake_run(action: str, payload: dict):
            calls.append((action, payload))
            return {"provider": "openai-codex", "models": ["model-a"], "default_model": "model-a"}

        bridge._run = fake_run  # type: ignore[method-assign]
        first = bridge.model_catalog("openai-codex")
        first["models"].append("mutated")
        second = bridge.model_catalog("openai-codex")

        self.assertEqual(len(calls), 1)
        self.assertEqual(second["models"], ["model-a"])

    def test_force_refresh_bypasses_cache(self):
        bridge = HermesOAuthBridge(object())
        calls = 0

        def fake_run(_action: str, _payload: dict):
            nonlocal calls
            calls += 1
            return {"provider": "xai-oauth", "models": [f"model-{calls}"], "default_model": f"model-{calls}"}

        bridge._run = fake_run  # type: ignore[method-assign]
        bridge.model_catalog("xai-oauth")
        refreshed = bridge.model_catalog("xai-oauth", force_refresh=True)

        self.assertEqual(calls, 2)
        self.assertEqual(refreshed["models"], ["model-2"])

    def test_zero_ttl_disables_cache(self):
        bridge = HermesOAuthBridge(object())
        calls = 0

        def fake_run(_action: str, _payload: dict):
            nonlocal calls
            calls += 1
            return {"models": [], "default_model": ""}

        bridge._run = fake_run  # type: ignore[method-assign]
        with patch.dict(os.environ, {"ENTERPRISE_HERMES_MODEL_CATALOG_TTL_SECONDS": "0"}):
            bridge.model_catalog("openai-codex")
            bridge.model_catalog("openai-codex")
        self.assertEqual(calls, 2)


if __name__ == "__main__":
    unittest.main()
