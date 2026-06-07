from __future__ import annotations

import tempfile
import time
import unittest
from unittest.mock import patch
from pathlib import Path

from enterprise_agent_platform.oauth_flows import (
    CODEX_DEVICE_TOKEN_URL,
    CODEX_DEVICE_USER_CODE_URL,
    CODEX_TOKEN_URL,
    MAX_OAUTH_SESSIONS,
    OAuthFlowError,
    OAuthFlowManager,
    OAuthHTTPClient,
    OAuthHTTPResponse,
    OAUTH_HTTP_USER_AGENT,
    XAI_OAUTH_DISCOVERY_URL,
)
from enterprise_agent_platform.runtimes import HERMES_SETTING_PROVIDER
from enterprise_agent_platform.service import EnterpriseService, ServiceError

from test_platform import make_config, make_fake_hermes_repo, RecordingAgent


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


class _FakeHermesOAuthBridge:
    def __init__(self):
        self.calls = []

    def available(self):
        return True

    def start(self, provider):
        self.calls.append(("start", provider))
        if provider == "openai-codex":
            return {
                "provider": "openai-codex",
                "kind": "device_code",
                "status": "waiting_for_user",
                "complete": False,
                "user_code": "HERMES-CODE",
                "device_auth_id": "hermes-device",
                "verification_url": "https://auth.openai.com/codex/device",
                "poll_interval": 3,
                "expires_in": 900,
            }
        return {
            "provider": "xai-oauth",
            "kind": "manual_callback",
            "status": "waiting_for_callback",
            "complete": False,
            "authorize_url": "https://auth.x.ai/authorize?state=hermes-state",
            "redirect_uri": "http://127.0.0.1:56121/callback",
            "token_endpoint": "https://auth.x.ai/token",
            "discovery": {"token_endpoint": "https://auth.x.ai/token"},
            "code_verifier": "hermes-verifier",
            "code_challenge": "hermes-challenge",
            "state": "hermes-state",
        }

    def poll_codex(self, session):
        self.calls.append(("poll_codex", session["device_auth_id"], session["user_code"]))
        return {
            "provider": "openai-codex",
            "kind": "device_code",
            "status": "complete",
            "complete": True,
            "tokens": {"access_token": "hermes-codex-access", "refresh_token": "hermes-codex-refresh"},
        }

    def complete_xai(self, session, callback_url):
        self.calls.append(("complete_xai", session["state"], callback_url))
        return {
            "provider": "xai-oauth",
            "kind": "manual_callback",
            "status": "complete",
            "complete": True,
            "tokens": {
                "access_token": "hermes-xai-access",
                "refresh_token": "hermes-xai-refresh",
                "id_token": "hermes-xai-id",
            },
        }


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

            def read(self):
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

    def test_codex_flow_uses_hermes_bridge_when_available(self):
        http_client = _ScriptedOAuthHTTPClient()
        bridge = _FakeHermesOAuthBridge()
        manager = OAuthFlowManager(http_client, hermes_bridge=bridge)

        started = manager.start("openai-codex")
        self.assertEqual(started["user_code"], "HERMES-CODE")
        completed = manager.poll("openai-codex", started["flow_id"])

        self.assertTrue(completed["complete"])
        self.assertEqual(completed["tokens"]["access_token"], "hermes-codex-access")
        self.assertEqual(http_client.calls, [])
        self.assertEqual(bridge.calls[0], ("start", "openai-codex"))
        self.assertEqual(bridge.calls[1], ("poll_codex", "hermes-device", "HERMES-CODE"))

    def test_xai_flow_uses_hermes_bridge_when_available(self):
        http_client = _ScriptedOAuthHTTPClient()
        bridge = _FakeHermesOAuthBridge()
        manager = OAuthFlowManager(http_client, hermes_bridge=bridge)

        started = manager.start("xai-oauth")
        self.assertEqual(started["authorize_url"], "https://auth.x.ai/authorize?state=hermes-state")
        completed = manager.complete(
            "xai-oauth",
            started["flow_id"],
            "http://127.0.0.1:56121/callback?code=ok&state=hermes-state",
        )

        self.assertTrue(completed["complete"])
        self.assertEqual(completed["tokens"]["access_token"], "hermes-xai-access")
        self.assertEqual(http_client.calls, [])
        self.assertEqual(bridge.calls[0], ("start", "xai-oauth"))
        self.assertEqual(
            bridge.calls[1],
            ("complete_xai", "hermes-state", "http://127.0.0.1:56121/callback?code=ok&state=hermes-state"),
        )

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
            make_fake_hermes_repo(tmp / "hermes-agent")
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
                # Default active provider is openai-codex; the persisted setting is
                # unset until a provider is actually selected.
                self.assertIsNone(service.get_setting(HERMES_SETTING_PROVIDER))
                self.assertEqual(service._active_oauth_provider(), "openai-codex")

                started = service.start_oauth_verification(admin, "xai-oauth")
                # The flow reports the in-progress target for the UI...
                self.assertEqual(started["flow"]["target_provider"], "xai-oauth")
                self.assertEqual(started["flow"]["kind"], "manual_callback")
                # ...but the live provider must NOT have switched to xai-oauth and
                # no tokens were stored, so status still reports openai-codex active.
                self.assertEqual(started["active_provider"], "openai-codex")
                self.assertIsNone(service.get_setting(HERMES_SETTING_PROVIDER))
                self.assertEqual(service.get_secret("GROK_OAUTH_ACCESS_TOKEN"), "")
                self.assertFalse(service._oauth_tokens_configured("xai-oauth"))
            finally:
                service.close()

    def test_poll_pending_through_service_keeps_provider_unswitched(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_fake_hermes_repo(tmp / "hermes-agent")
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
            make_fake_hermes_repo(tmp / "hermes-agent")
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
