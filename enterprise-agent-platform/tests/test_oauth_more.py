from __future__ import annotations

import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from pathlib import Path

from enterprise_agent_platform.oauth_flows import (
    CODEX_DEVICE_TOKEN_URL,
    CODEX_DEVICE_USER_CODE_URL,
    CODEX_TOKEN_URL,
    MAX_OAUTH_RESPONSE_BYTES,
    MAX_OAUTH_SESSIONS,
    OAuthFlowError,
    OAuthFlowManager,
    OAuthHTTPClient,
    OAuthHTTPResponse,
    OAUTH_HTTP_USER_AGENT,
    XAI_OAUTH_DISCOVERY_URL,
)
from enterprise_agent_platform.runtimes import AGENT_SETTING_PROVIDER
from enterprise_agent_platform.service import EnterpriseService, ServiceError

from test_platform import make_config, RecordingAgent


class _ScriptedOAuthHTTPClient:
    """Deterministic OAuth HTTP fake whose responses are configured per-test.

    ``responses`` maps a request URL to either an OAuthHTTPResponse or a list of
    OAuthHTTPResponse objects consumed one-per-call (so polling can return
    pending first and complete later). Any unmapped URL yields a 404.
    """

    def __init__(self, responses=None):
        self.responses = responses or {}
        self.calls = []

    def _next(self, url):
        value = self.responses.get(url)
        if isinstance(value, list):
            if not value:
                return OAuthHTTPResponse(404, {}, "exhausted")
            return value.pop(0)
        if value is None:
            return OAuthHTTPResponse(404, {}, "not found")
        return value

    def get_json(self, url, *, timeout=20.0):
        self.calls.append(("get_json", url))
        return self._next(url)

    def post_json(self, url, body, *, timeout=20.0):
        self.calls.append(("post_json", url, dict(body)))
        return self._next(url)

    def post_form(self, url, body, *, timeout=20.0):
        self.calls.append(("post_form", url, dict(body)))
        return self._next(url)


def _codex_started_manager(token_responses):
    """Return a manager with a started Codex flow and its flow_id.

    ``token_responses`` is the list (or single response) returned for the device
    token poll URL; the user-code start always succeeds.
    """
    client = _ScriptedOAuthHTTPClient(
        {
            CODEX_DEVICE_USER_CODE_URL: OAuthHTTPResponse(
                200,
                {"user_code": "CODE-1234", "device_auth_id": "device-1", "interval": 1, "expires_in": 900},
            ),
            CODEX_DEVICE_TOKEN_URL: token_responses,
        }
    )
    manager = OAuthFlowManager(client)
    started = manager.start("openai-codex")
    return manager, client, started["flow_id"]


class OAuthPollTests(unittest.TestCase):
    def test_oauth_http_client_sets_explicit_user_agent(self):
        captured = {}

        class FakeResponse:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def read(self, _limit=-1):
                return b'{"ok": true}'

        def fake_urlopen(request, timeout):
            captured["headers"] = dict(request.header_items())
            captured["timeout"] = timeout
            return FakeResponse()

        with patch("urllib.request.urlopen", fake_urlopen):
            response = OAuthHTTPClient().post_json(
                CODEX_DEVICE_USER_CODE_URL,
                {"client_id": "client"},
                timeout=7.0,
            )

        self.assertEqual(response.status, 200)
        self.assertEqual(captured["headers"]["User-agent"], OAUTH_HTTP_USER_AGENT)
        self.assertEqual(captured["headers"]["Content-type"], "application/json")
        self.assertEqual(captured["timeout"], 7.0)

    def test_oauth_http_client_adds_bearer_token_for_model_discovery(self):
        captured = {}

        class FakeResponse:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def read(self, _limit=-1):
                return b'{"models": []}'

        class FakeOpener:
            def open(self, request, timeout):
                captured["headers"] = dict(request.header_items())
                captured["timeout"] = timeout
                return FakeResponse()

        with patch("urllib.request.build_opener", return_value=FakeOpener()) as build_opener:
            response = OAuthHTTPClient().get_bearer_json(
                "https://provider.example/models",
                "access-token",
                additional_headers={"ChatGPT-Account-Id": "account-123"},
                timeout=6.0,
            )

        self.assertEqual(response.status, 200)
        self.assertEqual(captured["headers"]["Authorization"], "Bearer access-token")
        self.assertEqual(captured["headers"]["Chatgpt-account-id"], "account-123")
        self.assertEqual(captured["headers"]["User-agent"], OAUTH_HTTP_USER_AGENT)
        self.assertEqual(captured["timeout"], 6.0)
        self.assertEqual(len(build_opener.call_args.args), 1)
        redirect_handler = build_opener.call_args.args[0]
        self.assertIsNone(
            redirect_handler.redirect_request(None, None, 302, "Found", {}, "https://evil.test")
        )
        with self.assertRaisesRegex(OAuthFlowError, "access token is invalid"):
            OAuthHTTPClient().get_bearer_json(
                "https://provider.example/models",
                "token\r\ninjected",
            )
        with self.assertRaisesRegex(OAuthFlowError, "discovery header is invalid"):
            OAuthHTTPClient().get_bearer_json(
                "https://provider.example/models",
                "access-token",
                additional_headers={"Authorization": "replacement"},
            )

    def test_oauth_http_client_rejects_oversized_response(self):
        class OversizedResponse:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def read(self, limit=-1):
                self.requested_limit = limit
                return b"x" * limit

        response = OversizedResponse()
        with patch("urllib.request.urlopen", return_value=response):
            with self.assertRaisesRegex(OAuthFlowError, "2 MiB limit"):
                OAuthHTTPClient().get_json("https://provider.example/models")

        self.assertEqual(response.requested_limit, MAX_OAUTH_RESPONSE_BYTES + 1)

    def test_codex_flow_uses_platform_http_client(self):
        http_client = _ScriptedOAuthHTTPClient(
            {
                CODEX_DEVICE_USER_CODE_URL: OAuthHTTPResponse(
                    200,
                    {"user_code": "HTTP-CODE", "device_auth_id": "http-device", "interval": 5, "expires_in": 900},
                ),
            }
        )
        manager = OAuthFlowManager(http_client)

        started = manager.start("openai-codex")

        self.assertEqual(started["user_code"], "HTTP-CODE")
        self.assertEqual(http_client.calls[0][0], "post_json")

    def test_xai_flow_uses_platform_http_client(self):
        http_client = _ScriptedOAuthHTTPClient(
            {
                XAI_OAUTH_DISCOVERY_URL: OAuthHTTPResponse(
                    200,
                    {
                        "authorization_endpoint": "https://xai.example/authorize",
                        "token_endpoint": "https://xai.example/token",
                    },
                ),
            }
        )
        manager = OAuthFlowManager(http_client)

        started = manager.start("xai-oauth")

        self.assertIn("https://xai.example/authorize?", started["authorize_url"])
        self.assertEqual(http_client.calls[0], ("get_json", XAI_OAUTH_DISCOVERY_URL))

    def test_poll_pending_returns_not_complete_without_dropping_session(self):
        # 403 from the device-token endpoint means the user has not yet approved.
        manager, _client, flow_id = _codex_started_manager([OAuthHTTPResponse(403, {}, "authorization_pending")])
        result = manager.poll("openai-codex", flow_id)
        self.assertFalse(result["complete"])
        self.assertEqual(result["status"], "waiting_for_user")
        # The session must survive a pending poll so the client can keep polling.
        # Swap in a fresh client that still reports pending and poll again.
        second_client = _ScriptedOAuthHTTPClient(
            {CODEX_DEVICE_TOKEN_URL: OAuthHTTPResponse(404, {}, "still pending")}
        )
        manager.http = second_client
        pending_again = manager.poll("openai-codex", flow_id)
        self.assertFalse(pending_again["complete"])
        self.assertEqual(pending_again["status"], "waiting_for_user")

    def test_poll_token_exchange_failure_surfaces_error(self):
        # Device verification succeeds (returns auth code) but the token exchange
        # at CODEX_TOKEN_URL fails -> a 502 OAuthFlowError must be raised.
        client = _ScriptedOAuthHTTPClient(
            {
                CODEX_DEVICE_USER_CODE_URL: OAuthHTTPResponse(
                    200, {"user_code": "CODE", "device_auth_id": "dev", "interval": 1, "expires_in": 900}
                ),
                CODEX_DEVICE_TOKEN_URL: OAuthHTTPResponse(
                    200, {"authorization_code": "auth-code", "code_verifier": "verifier"}
                ),
                CODEX_TOKEN_URL: OAuthHTTPResponse(400, {}, "invalid_grant"),
            }
        )
        manager = OAuthFlowManager(client)
        flow_id = manager.start("openai-codex")["flow_id"]
        with self.assertRaises(OAuthFlowError) as ctx:
            manager.poll("openai-codex", flow_id)
        self.assertEqual(ctx.exception.status, 502)
        self.assertIn("token exchange failed", ctx.exception.message)

    def test_poll_after_expiry_times_out_and_drops_session(self):
        manager, _client, flow_id = _codex_started_manager([OAuthHTTPResponse(403, {}, "pending")])
        # Force the stored session to be expired.
        with manager._lock:
            manager._sessions[flow_id]["expires_at"] = time.time() - 1
        with self.assertRaises(OAuthFlowError) as ctx:
            manager.poll("openai-codex", flow_id)
        self.assertEqual(ctx.exception.status, 410)
        # Session is dropped, so a follow-up poll reports it as not found (no crash).
        with self.assertRaises(OAuthFlowError) as ctx2:
            manager.poll("openai-codex", flow_id)
        self.assertEqual(ctx2.exception.status, 404)


class OAuthGrokCompleteTests(unittest.TestCase):
    def _started_xai_manager(self):
        client = _ScriptedOAuthHTTPClient(
            {
                XAI_OAUTH_DISCOVERY_URL: OAuthHTTPResponse(
                    200,
                    {
                        "authorization_endpoint": "https://xai.example/authorize",
                        "token_endpoint": "https://xai.example/token",
                    },
                ),
                "https://xai.example/token": OAuthHTTPResponse(
                    200, {"access_token": "grok-access", "refresh_token": "grok-refresh"}
                ),
            }
        )
        manager = OAuthFlowManager(client)
        started = manager.start("xai-oauth")
        return manager, client, started

    def test_complete_rejects_state_mismatch(self):
        manager, client, started = self._started_xai_manager()
        flow_id = started["flow_id"]
        callback = f"{started['redirect_uri']}?code=grok-code&state=not-the-real-state"
        with self.assertRaises(OAuthFlowError) as ctx:
            manager.complete("xai-oauth", flow_id, callback)
        self.assertEqual(ctx.exception.status, 400)
        self.assertIn("state mismatch", ctx.exception.message)
        # A rejected state mismatch must NOT trigger a token exchange.
        self.assertFalse(any(call[0] == "post_form" for call in client.calls))

    def test_complete_rejects_provider_error_callback(self):
        manager, client, started = self._started_xai_manager()
        flow_id = started["flow_id"]
        callback = f"{started['redirect_uri']}?error=access_denied&error_description=user+declined"
        with self.assertRaises(OAuthFlowError) as ctx:
            manager.complete("xai-oauth", flow_id, callback)
        self.assertEqual(ctx.exception.status, 400)
        self.assertIn("user declined", ctx.exception.message)
        self.assertFalse(any(call[0] == "post_form" for call in client.calls))


class OAuthCredentialResolutionTests(unittest.TestCase):
    def test_expired_codex_token_is_refreshed_once_for_concurrent_runtime_requests(self):
        client = _ScriptedOAuthHTTPClient(
            {
                CODEX_TOKEN_URL: OAuthHTTPResponse(
                    200,
                    {
                        "access_token": "rotated-access",
                        "refresh_token": "rotated-refresh",
                        "expires_in": 7200,
                    },
                )
            }
        )
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(
                make_config(Path(td)),
                agent_client=RecordingAgent(),
                oauth_http_client=client,
            )
            try:
                _, admin = service.authenticate("admin", "admin")
                service.set_secret(admin, "CODEX_OAUTH_ACCESS_TOKEN", "expired-access")
                service.set_secret(admin, "CODEX_OAUTH_REFRESH_TOKEN", "refresh-token")
                service.set_setting("CODEX_OAUTH_EXPIRES_AT", "1")
                barrier = threading.Barrier(5)
                results = []
                errors = []

                def resolve():
                    try:
                        barrier.wait(timeout=3)
                        results.append(service.resolve_agent_credentials({"provider": "openai-codex"}))
                    except BaseException as exc:
                        errors.append(exc)

                threads = [threading.Thread(target=resolve) for _ in range(4)]
                for thread in threads:
                    thread.start()
                barrier.wait(timeout=3)
                for thread in threads:
                    thread.join(timeout=3)

                self.assertEqual(errors, [])
                self.assertEqual(len(results), 4)
                self.assertEqual({result["access_token"] for result in results}, {"rotated-access"})
                refresh_calls = [call for call in client.calls if call[0] == "post_form"]
                self.assertEqual(len(refresh_calls), 1)
                self.assertEqual(service.get_secret("CODEX_OAUTH_ACCESS_TOKEN"), "rotated-access")
                self.assertEqual(service.get_secret("CODEX_OAUTH_REFRESH_TOKEN"), "rotated-refresh")
            finally:
                service.close()

    def test_runtime_credential_resolution_rejects_unconnected_provider(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                with self.assertRaises(ServiceError) as raised:
                    service.resolve_agent_credentials({"provider": "xai-oauth"})
                self.assertEqual(raised.exception.status, 409)
                self.assertIn("not connected", raised.exception.message)
            finally:
                service.close()


class OAuthSessionPruningTests(unittest.TestCase):
    def test_prune_evicts_oldest_when_over_cap(self):
        manager = OAuthFlowManager(_ScriptedOAuthHTTPClient())
        now = time.time()
        # Seed one more than the cap, all unexpired, with distinct expiries so the
        # oldest (smallest expires_at) is deterministic.
        total = MAX_OAUTH_SESSIONS + 5
        with manager._lock:
            for i in range(total):
                fid = f"flow-{i:04d}"
                manager._sessions[fid] = {"flow_id": fid, "provider": "openai-codex", "expires_at": now + 1000 + i}
        manager._prune_sessions()
        with manager._lock:
            remaining = set(manager._sessions)
        self.assertEqual(len(remaining), MAX_OAUTH_SESSIONS)
        # The 5 oldest (lowest expires_at) must have been evicted.
        for i in range(5):
            self.assertNotIn(f"flow-{i:04d}", remaining)
        self.assertIn(f"flow-{total - 1:04d}", remaining)

    def test_prune_drops_expired_sessions(self):
        manager = OAuthFlowManager(_ScriptedOAuthHTTPClient())
        now = time.time()
        with manager._lock:
            manager._sessions["live"] = {"flow_id": "live", "provider": "xai-oauth", "expires_at": now + 500}
            manager._sessions["dead"] = {"flow_id": "dead", "provider": "xai-oauth", "expires_at": now - 5}
        manager._prune_sessions()
        with manager._lock:
            remaining = set(manager._sessions)
        self.assertEqual(remaining, {"live"})


class OAuthLiveProviderInvariantTests(unittest.TestCase):
    def test_start_oauth_verification_does_not_switch_live_provider(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            client = _ScriptedOAuthHTTPClient(
                {
                    XAI_OAUTH_DISCOVERY_URL: OAuthHTTPResponse(
                        200,
                        {
                            "authorization_endpoint": "https://xai.example/authorize",
                            "token_endpoint": "https://xai.example/token",
                        },
                    )
                }
            )
            service = EnterpriseService(
                make_config(tmp),
                agent_client=RecordingAgent(),
                oauth_http_client=client,
            )
            try:
                _, admin = service.authenticate("admin", "admin")
                # Bootstrap persists the default provider so the sidecar and UI
                # resolve the same configuration before the first OAuth flow.
                self.assertEqual(service.get_setting(AGENT_SETTING_PROVIDER), "openai-codex")
                self.assertEqual(service._active_oauth_provider(), "openai-codex")

                started = service.start_oauth_verification(admin, "xai-oauth")
                # The flow reports the in-progress target for the UI...
                self.assertEqual(started["flow"]["target_provider"], "xai-oauth")
                self.assertEqual(started["flow"]["kind"], "manual_callback")
                # ...but the live provider must NOT have switched to xai-oauth and
                # no tokens were stored, so status still reports openai-codex active.
                self.assertEqual(started["active_provider"], "openai-codex")
                self.assertEqual(service.get_setting(AGENT_SETTING_PROVIDER), "openai-codex")
                self.assertEqual(service.get_secret("GROK_OAUTH_ACCESS_TOKEN"), "")
                self.assertFalse(service._oauth_tokens_configured("xai-oauth"))
            finally:
                service.close()

    def test_poll_pending_through_service_keeps_provider_unswitched(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            client = _ScriptedOAuthHTTPClient(
                {
                    CODEX_DEVICE_USER_CODE_URL: OAuthHTTPResponse(
                        200,
                        {"user_code": "CODE-1234", "device_auth_id": "device-1", "interval": 1, "expires_in": 900},
                    ),
                    CODEX_DEVICE_TOKEN_URL: OAuthHTTPResponse(403, {}, "authorization_pending"),
                }
            )
            service = EnterpriseService(
                make_config(tmp),
                agent_client=RecordingAgent(),
                oauth_http_client=client,
            )
            try:
                _, admin = service.authenticate("admin", "admin")
                started = service.start_oauth_verification(admin, "openai-codex")
                flow_id = started["flow"]["flow_id"]
                polled = service.poll_oauth_verification(admin, "openai-codex", {"flow_id": flow_id})
                # Pending poll: not complete, and no tokens were stored.
                self.assertFalse(polled["flow"]["complete"])
                self.assertEqual(service.get_secret("CODEX_OAUTH_ACCESS_TOKEN"), "")
                self.assertFalse(service._oauth_tokens_configured("openai-codex"))
            finally:
                service.close()

    def test_complete_state_mismatch_through_service_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            client = _ScriptedOAuthHTTPClient(
                {
                    XAI_OAUTH_DISCOVERY_URL: OAuthHTTPResponse(
                        200,
                        {
                            "authorization_endpoint": "https://xai.example/authorize",
                            "token_endpoint": "https://xai.example/token",
                        },
                    )
                }
            )
            service = EnterpriseService(
                make_config(tmp),
                agent_client=RecordingAgent(),
                oauth_http_client=client,
            )
            try:
                _, admin = service.authenticate("admin", "admin")
                started = service.start_oauth_verification(admin, "xai-oauth")
                flow_id = started["flow"]["flow_id"]
                bad_callback = f"{started['flow']['redirect_uri']}?code=grok-code&state=wrong"
                with self.assertRaises(ServiceError) as ctx:
                    service.complete_oauth_verification(
                        admin, "xai-oauth", {"flow_id": flow_id, "callback_url": bad_callback}
                    )
                self.assertEqual(ctx.exception.status, 400)
                self.assertEqual(service.get_secret("GROK_OAUTH_ACCESS_TOKEN"), "")
                self.assertFalse(service._oauth_tokens_configured("xai-oauth"))
            finally:
                service.close()


if __name__ == "__main__":
    unittest.main()
