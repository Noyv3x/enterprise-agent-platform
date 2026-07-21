from __future__ import annotations

import base64
import json
import threading
import unittest

from enterprise_agent_platform.model_catalog import ModelCatalogManager
from enterprise_agent_platform.oauth_flows import OAuthHTTPResponse


def runtime_payload() -> dict:
    def model(model_id: str) -> dict:
        return {
            "id": model_id,
            "name": model_id,
            "reasoning": True,
            "input": ["text", "image"],
            "context_window": 100_000,
            "max_tokens": 20_000,
        }

    return {
        "version": 1,
        "source": "pi-runtime",
        "providers": {
            "openai-codex": {
                "provider": "openai-codex",
                "default_model": "gpt-5.5",
                "models": [model("gpt-5.5"), model("gpt-5.6-sol")],
            },
            "xai-oauth": {
                "provider": "xai-oauth",
                "default_model": "grok-4.3",
                "models": [model("grok-4.3"), model("grok-4.5")],
            },
        },
    }


class FakeHTTP:
    def __init__(self):
        self.responses: dict[str, OAuthHTTPResponse] = {}
        self.calls: list[tuple[str, str, dict[str, str]]] = []

    def get_bearer_json(
        self,
        url,
        access_token,
        *,
        additional_headers=None,
        timeout=20.0,
    ):
        self.calls.append((url, access_token, dict(additional_headers or {})))
        return self.responses[url]


class ModelCatalogManagerTests(unittest.TestCase):
    def manager(
        self,
        *,
        configured=(),
        http=None,
        cache="",
        runtime_loader=runtime_payload,
        now=1_000,
    ):
        saved: list[str] = []
        revisions = {"openai-codex": 11, "xai-oauth": 22}
        manager = ModelCatalogManager(
            runtime_loader=runtime_loader,
            credential_loader=lambda provider: (
                f"{provider}-token",
                revisions[provider],
            ),
            oauth_configured=lambda provider: provider in configured,
            credential_revision=lambda provider: revisions[provider],
            http_client=http or FakeHTTP(),
            cache_loader=lambda: cache,
            cache_saver=saved.append,
            clock=lambda: now,
        )
        return manager, saved

    def test_unconfigured_provider_uses_runtime_catalog_without_oauth(self):
        http = FakeHTTP()
        manager, _ = self.manager(http=http)

        result = manager.catalog("openai-codex")

        self.assertEqual(result["models"], ["gpt-5.5", "gpt-5.6-sol"])
        self.assertEqual(result["default_model"], "gpt-5.5")
        self.assertEqual(result["source"], "agent-runtime")
        self.assertEqual(http.calls, [])

    def test_codex_uses_account_visible_intersection_in_provider_priority_order(self):
        http = FakeHTTP()
        http.responses[
            "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0"
        ] = OAuthHTTPResponse(
            200,
            {
                "models": [
                    {"slug": "future-model", "priority": 0},
                    {"slug": "gpt-5.6-sol", "priority": 1},
                    {"slug": "hidden-model", "priority": 2, "visibility": "hidden"},
                    {"slug": "gpt-5.5", "priority": 3},
                ]
            },
        )
        payload = base64.urlsafe_b64encode(
            json.dumps(
                {
                    "https://api.openai.com/auth": {
                        "chatgpt_account_id": "account-123",
                    }
                }
            ).encode()
        ).decode().rstrip("=")
        manager = ModelCatalogManager(
            runtime_loader=runtime_payload,
            credential_loader=lambda _provider: (f"header.{payload}.signature", 1),
            oauth_configured=lambda provider: provider == "openai-codex",
            credential_revision=lambda _provider: 1,
            http_client=http,
            cache_loader=lambda: "",
            cache_saver=lambda _value: None,
            clock=lambda: 1_000,
        )

        result = manager.catalog("openai-codex")

        self.assertEqual(result["models"], ["gpt-5.6-sol", "gpt-5.5"])
        self.assertEqual(result["default_model"], "gpt-5.5")
        self.assertEqual(result["oauth_verified_models"], result["models"])
        self.assertEqual(result["source"], "oauth-live")
        self.assertIn("hidden until Runtime metadata", result["error"])
        self.assertEqual(http.calls[0][2], {"ChatGPT-Account-Id": "account-123"})

    def test_grok_live_listing_is_an_annotation_not_an_exclusive_allowlist(self):
        http = FakeHTTP()
        http.responses["https://api.x.ai/v1/models"] = OAuthHTTPResponse(
            200,
            {"data": [{"id": "grok-4.5"}]},
        )
        manager, _ = self.manager(configured={"xai-oauth"}, http=http)

        result = manager.catalog("xai-oauth")

        self.assertEqual(result["models"], ["grok-4.3", "grok-4.5"])
        self.assertEqual(result["oauth_verified_models"], ["grok-4.5"])
        self.assertEqual(result["source"], "agent-runtime+oauth")

    def test_failed_refresh_uses_persisted_last_known_good_snapshots(self):
        seed_http = FakeHTTP()
        seed_http.responses[
            "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0"
        ] = OAuthHTTPResponse(200, {"models": [{"slug": "gpt-5.6-sol", "priority": 1}]})
        seed, saved = self.manager(configured={"openai-codex"}, http=seed_http, now=1_000)
        self.assertEqual(seed.catalog("openai-codex")["models"], ["gpt-5.6-sol"])
        persisted = saved[-1]

        failed_http = FakeHTTP()
        failed_http.responses[
            "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0"
        ] = OAuthHTTPResponse(503, {}, "unavailable")

        def unavailable_runtime():
            raise OSError("runtime offline")

        restored, _ = self.manager(
            configured={"openai-codex"},
            http=failed_http,
            cache=persisted,
            runtime_loader=unavailable_runtime,
            now=2_000,
        )
        result = restored.catalog("openai-codex")

        self.assertEqual(result["models"], ["gpt-5.6-sol"])
        self.assertTrue(result["stale"])
        self.assertEqual(result["source"], "oauth-cache")
        self.assertIn("HTTP 503", result["error"])

    def test_invalid_persisted_cache_is_ignored(self):
        manager, _ = self.manager(cache=json.dumps({"version": 999}))
        self.assertEqual(manager.catalog("openai-codex")["models"], ["gpt-5.5", "gpt-5.6-sol"])

    def test_failed_refreshes_are_briefly_throttled_without_hiding_runtime_fallback(self):
        http = FakeHTTP()
        http.responses[
            "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0"
        ] = OAuthHTTPResponse(503, {}, "unavailable")
        runtime_calls = []

        def load_runtime():
            runtime_calls.append(True)
            return runtime_payload()

        manager, _ = self.manager(
            configured={"openai-codex"},
            http=http,
            runtime_loader=load_runtime,
        )

        first = manager.catalog("openai-codex")
        second = manager.catalog("openai-codex")

        self.assertEqual(first["models"], ["gpt-5.5", "gpt-5.6-sol"])
        self.assertEqual(second["models"], first["models"])
        self.assertTrue(first["stale"])
        self.assertEqual(len(runtime_calls), 1)
        self.assertEqual(len(http.calls), 1)

    def test_runtime_failure_takes_priority_over_still_fresh_last_known_good_cache(self):
        failing = False
        runtime_calls = 0

        def load_runtime():
            nonlocal runtime_calls
            runtime_calls += 1
            if failing:
                raise OSError("runtime unavailable")
            return runtime_payload()

        manager, _ = self.manager(runtime_loader=load_runtime)
        self.assertFalse(manager.catalog("openai-codex")["stale"])

        failing = True
        manager.invalidate_runtime()
        first = manager.catalog("openai-codex")
        second = manager.catalog("openai-codex")

        self.assertEqual(first["models"], ["gpt-5.5", "gpt-5.6-sol"])
        self.assertTrue(first["stale"])
        self.assertIn("runtime unavailable", first["error"])
        self.assertEqual(second, first)
        self.assertEqual(runtime_calls, 2)

    def test_runtime_failure_retries_after_backoff_even_when_cache_is_fresh(self):
        failing = False
        runtime_calls = 0
        now = 1_000

        def load_runtime():
            nonlocal runtime_calls
            runtime_calls += 1
            if failing:
                raise OSError("runtime unavailable")
            return runtime_payload()

        manager = ModelCatalogManager(
            runtime_loader=load_runtime,
            credential_loader=lambda provider: (f"{provider}-token", 1),
            oauth_configured=lambda _provider: False,
            credential_revision=lambda _provider: 1,
            http_client=FakeHTTP(),
            cache_loader=lambda: "",
            cache_saver=lambda _value: None,
            clock=lambda: now,
        )
        self.assertFalse(manager.catalog("openai-codex")["stale"])

        failing = True
        manager.invalidate_runtime()
        now = 1_001
        first_failure = manager.catalog("openai-codex")
        now = 1_062
        retry_failure = manager.catalog("openai-codex")

        self.assertTrue(first_failure["stale"])
        self.assertTrue(retry_failure["stale"])
        self.assertIn("runtime unavailable", retry_failure["error"])
        self.assertEqual(runtime_calls, 3)

    def test_runtime_refresh_is_single_flight(self):
        entered = threading.Event()
        release = threading.Event()
        runtime_calls = 0

        def load_runtime():
            nonlocal runtime_calls
            runtime_calls += 1
            entered.set()
            release.wait(2)
            return runtime_payload()

        manager, _ = self.manager(runtime_loader=load_runtime)
        results: list[dict] = []
        errors: list[BaseException] = []

        def load_catalog():
            try:
                results.append(manager.catalog("openai-codex"))
            except BaseException as exc:  # pragma: no cover - asserted below
                errors.append(exc)

        threads = [threading.Thread(target=load_catalog) for _ in range(4)]
        for thread in threads:
            thread.start()
        self.assertTrue(entered.wait(1))
        release.set()
        for thread in threads:
            thread.join(2)

        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertEqual(errors, [])
        self.assertEqual(len(results), 4)
        self.assertEqual(runtime_calls, 1)

    def test_provider_refreshes_are_independent_and_single_flight_per_provider(self):
        class BlockingHTTP(FakeHTTP):
            def __init__(self):
                super().__init__()
                self.codex_started = threading.Event()
                self.codex_release = threading.Event()

            def get_bearer_json(
                self,
                url,
                access_token,
                *,
                additional_headers=None,
                timeout=20.0,
            ):
                self.calls.append((url, access_token, dict(additional_headers or {})))
                if "chatgpt.com" in url:
                    self.codex_started.set()
                    self.codex_release.wait(2)
                return self.responses[url]

        configured: set[str] = set()
        http = BlockingHTTP()
        http.responses[
            "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0"
        ] = OAuthHTTPResponse(200, {"models": [{"slug": "gpt-5.5"}]})
        http.responses["https://api.x.ai/v1/models"] = OAuthHTTPResponse(
            200,
            {"data": [{"id": "grok-4.5"}]},
        )
        manager = ModelCatalogManager(
            runtime_loader=runtime_payload,
            credential_loader=lambda provider: (f"{provider}-token", 1),
            oauth_configured=lambda provider: provider in configured,
            credential_revision=lambda _provider: 1,
            http_client=http,
            cache_loader=lambda: "",
            cache_saver=lambda _value: None,
            clock=lambda: 1_000,
        )
        manager.catalog("openai-codex")  # Warm the shared Runtime catalog.
        configured.update({"openai-codex", "xai-oauth"})

        codex_results: list[dict] = []
        codex_threads = [
            threading.Thread(
                target=lambda: codex_results.append(manager.catalog("openai-codex"))
            )
            for _ in range(2)
        ]
        for thread in codex_threads:
            thread.start()
        self.assertTrue(http.codex_started.wait(1))

        xai_done = threading.Event()
        xai_results: list[dict] = []

        def load_xai():
            xai_results.append(manager.catalog("xai-oauth"))
            xai_done.set()

        xai_thread = threading.Thread(target=load_xai)
        xai_thread.start()
        try:
            self.assertTrue(xai_done.wait(1), "xAI refresh was blocked by Codex I/O")
            self.assertEqual(
                len([call for call in http.calls if "chatgpt.com" in call[0]]),
                1,
            )
        finally:
            http.codex_release.set()

        for thread in codex_threads:
            thread.join(2)
        xai_thread.join(2)
        self.assertFalse(any(thread.is_alive() for thread in [*codex_threads, xai_thread]))
        self.assertEqual(len(codex_results), 2)
        self.assertEqual(len(xai_results), 1)
        self.assertEqual(
            len([call for call in http.calls if "chatgpt.com" in call[0]]),
            1,
        )
        self.assertEqual(
            len([call for call in http.calls if "api.x.ai" in call[0]]),
            1,
        )

    def test_token_refresh_revision_is_used_for_failure_backoff(self):
        revision = 1
        token_calls = 0
        http = FakeHTTP()
        http.responses[
            "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0"
        ] = OAuthHTTPResponse(503, {}, "unavailable")

        def load_credentials(_provider: str) -> tuple[str, int]:
            nonlocal revision, token_calls
            token_calls += 1
            revision = 2
            return "refreshed-token", revision

        manager = ModelCatalogManager(
            runtime_loader=runtime_payload,
            credential_loader=load_credentials,
            oauth_configured=lambda provider: provider == "openai-codex",
            credential_revision=lambda _provider: revision,
            http_client=http,
            cache_loader=lambda: "",
            cache_saver=lambda _value: None,
            clock=lambda: 1_000,
        )

        first = manager.catalog("openai-codex")
        second = manager.catalog("openai-codex")

        self.assertTrue(first["stale"])
        self.assertEqual(second, first)
        self.assertEqual(token_calls, 1)
        self.assertEqual(len(http.calls), 1)

    def test_failed_credential_load_is_retried_when_revision_changes(self):
        revision = 1
        credential_calls = 0
        http = FakeHTTP()
        http.responses[
            "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0"
        ] = OAuthHTTPResponse(200, {"models": [{"slug": "gpt-5.5"}]})

        def load_credentials(_provider: str) -> tuple[str, int]:
            nonlocal revision, credential_calls
            credential_calls += 1
            if credential_calls == 1:
                revision = 2
                raise OSError("old credential failed while a new one was stored")
            return "new-token", revision

        manager = ModelCatalogManager(
            runtime_loader=runtime_payload,
            credential_loader=load_credentials,
            oauth_configured=lambda provider: provider == "openai-codex",
            credential_revision=lambda _provider: revision,
            http_client=http,
            cache_loader=lambda: "",
            cache_saver=lambda _value: None,
            clock=lambda: 1_000,
        )

        result = manager.catalog("openai-codex")

        self.assertFalse(result["stale"])
        self.assertEqual(result["models"], ["gpt-5.5"])
        self.assertEqual(credential_calls, 2)
        self.assertEqual([call[1] for call in http.calls], ["new-token"])

    def test_damaged_and_future_dated_cache_entries_are_refreshed_safely(self):
        cached = json.dumps(
            {
                "version": 1,
                "runtime": {"fetched_at": [], "providers": "damaged"},
                "oauth": {
                    "openai-codex": {
                        "fetched_at": 99_999,
                        "credential_revision": 11,
                        "models": ["gpt-5.5"],
                    },
                    "xai-oauth": {
                        "fetched_at": 99_999,
                        "credential_revision": {"damaged": True},
                        "models": ["grok-4.3"],
                    },
                },
            }
        )
        http = FakeHTTP()
        http.responses[
            "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0"
        ] = OAuthHTTPResponse(200, {"models": [{"slug": "gpt-5.6-sol"}]})
        http.responses["https://api.x.ai/v1/models"] = OAuthHTTPResponse(
            200,
            {"data": [{"id": "grok-4.5"}]},
        )
        runtime_calls = 0

        def load_runtime():
            nonlocal runtime_calls
            runtime_calls += 1
            return runtime_payload()

        manager, _ = self.manager(
            configured={"openai-codex", "xai-oauth"},
            http=http,
            cache=cached,
            runtime_loader=load_runtime,
            now=1_000,
        )

        codex = manager.catalog("openai-codex")
        xai = manager.catalog("xai-oauth")

        self.assertEqual(codex["models"], ["gpt-5.6-sol"])
        self.assertEqual(xai["oauth_verified_models"], ["grok-4.5"])
        self.assertEqual(runtime_calls, 1)
        self.assertEqual(len(http.calls), 2)


if __name__ == "__main__":
    unittest.main()
