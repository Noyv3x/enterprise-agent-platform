from __future__ import annotations

import base64
import hashlib
import json
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any


CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
CODEX_DEVICE_USER_CODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode"
CODEX_DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token"
CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token"
CODEX_DEVICE_VERIFICATION_URL = "https://auth.openai.com/codex/device"
OAUTH_HTTP_USER_AGENT = "enterprise-agent-platform/0.1"

XAI_OAUTH_DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration"
XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access"
XAI_REDIRECT_URI = "http://127.0.0.1:56121/callback"

SUPPORTED_OAUTH_PROVIDERS = ("openai-codex", "xai-oauth")

OAUTH_PROVIDER_INFO = {
    "openai-codex": {
        "id": "openai-codex",
        "label": "Codex OAuth",
        "model": "gpt-5.3-codex",
        "base_url": "https://chatgpt.com/backend-api/codex",
        "flow": "device_code",
    },
    "xai-oauth": {
        "id": "xai-oauth",
        "label": "Grok OAuth",
        "model": "grok-4.3",
        "base_url": "https://api.x.ai/v1",
        "flow": "manual_callback",
    },
}


class OAuthFlowError(RuntimeError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass(frozen=True)
class OAuthHTTPResponse:
    status: int
    data: dict[str, Any]
    text: str = ""


class OAuthHTTPClient:
    def get_json(self, url: str, *, timeout: float = 20.0) -> OAuthHTTPResponse:
        request = urllib.request.Request(url, headers=_oauth_headers("application/json"), method="GET")
        return self._open(request, timeout=timeout)

    def post_json(self, url: str, body: dict[str, Any], *, timeout: float = 20.0) -> OAuthHTTPResponse:
        request = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers=_oauth_headers("application/json"),
            method="POST",
        )
        return self._open(request, timeout=timeout)

    def post_form(self, url: str, body: dict[str, Any], *, timeout: float = 20.0) -> OAuthHTTPResponse:
        request = urllib.request.Request(
            url,
            data=urllib.parse.urlencode(body).encode("utf-8"),
            headers=_oauth_headers("application/x-www-form-urlencoded"),
            method="POST",
        )
        return self._open(request, timeout=timeout)

    def _open(self, request: urllib.request.Request, *, timeout: float) -> OAuthHTTPResponse:
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                text = response.read().decode("utf-8")
                return OAuthHTTPResponse(response.status, _json_object(text), text)
        except urllib.error.HTTPError as exc:
            text = exc.read().decode("utf-8", errors="replace")
            return OAuthHTTPResponse(exc.code, _json_object(text), text)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise OAuthFlowError(502, f"OAuth network request failed: {exc}") from exc


def _oauth_headers(content_type: str) -> dict[str, str]:
    return {
        "Accept": "application/json",
        "Content-Type": content_type,
        "User-Agent": OAUTH_HTTP_USER_AGENT,
    }


MAX_OAUTH_SESSIONS = 100


class OAuthFlowManager:
    def __init__(self, http_client: OAuthHTTPClient | None = None, hermes_bridge: Any | None = None):
        self.http = http_client or OAuthHTTPClient()
        self.hermes_bridge = hermes_bridge
        self._sessions: dict[str, dict[str, Any]] = {}
        # Guards every read/mutation of ``_sessions``. The server is a
        # ThreadingHTTPServer (one thread per request), so overlapping start/
        # poll/complete calls mutate this dict concurrently. The lock is only
        # ever held around in-memory dict touches, never around the blocking
        # urllib network calls, so unrelated flows are not serialized.
        self._lock = threading.Lock()

    def _prune_sessions(self) -> None:
        """Evict timed-out flow sessions (and the oldest if still over cap).

        Without this, abandoned verification flows accumulate forever because a
        session is otherwise only removed when it is explicitly polled/completed.
        """
        now = time.time()
        with self._lock:
            for flow_id in [fid for fid, s in self._sessions.items() if now > float(s.get("expires_at", 0))]:
                self._sessions.pop(flow_id, None)
            if len(self._sessions) > MAX_OAUTH_SESSIONS:
                ordered = sorted(self._sessions.items(), key=lambda kv: float(kv[1].get("expires_at", 0)))
                for flow_id, _ in ordered[: len(self._sessions) - MAX_OAUTH_SESSIONS]:
                    self._sessions.pop(flow_id, None)

    def start(self, provider: str) -> dict[str, Any]:
        provider = normalize_oauth_provider(provider)
        self._prune_sessions()
        if provider == "openai-codex":
            if self._hermes_bridge_available():
                return self._start_codex_via_hermes()
            return self._start_codex()
        if provider == "xai-oauth":
            if self._hermes_bridge_available():
                return self._start_xai_via_hermes()
            return self._start_xai()
        raise OAuthFlowError(400, f"unsupported OAuth provider: {provider}")

    def poll(self, provider: str, flow_id: str) -> dict[str, Any]:
        provider = normalize_oauth_provider(provider)
        session = self._get_session(provider, flow_id)
        if provider != "openai-codex":
            raise OAuthFlowError(400, "this provider does not use polling")
        if time.time() > float(session["expires_at"]):
            self._drop_session(flow_id)
            raise OAuthFlowError(410, "OAuth verification timed out; start again")
        if session.get("auth_source") == "hermes" and self.hermes_bridge is not None:
            result = self.hermes_bridge.poll_codex(session)
            if not result.get("complete"):
                return self._pending_response(session, str(result.get("status") or "waiting_for_user"))
            self._drop_session(flow_id)
            result["flow_id"] = flow_id
            result.setdefault("provider", provider)
            result.setdefault("status", "complete")
            result.setdefault("complete", True)
            return result
        response = self.http.post_json(
            CODEX_DEVICE_TOKEN_URL,
            {"device_auth_id": session["device_auth_id"], "user_code": session["user_code"]},
            timeout=20.0,
        )
        if response.status in {403, 404}:
            return self._pending_response(session, "waiting_for_user")
        if response.status != 200:
            raise OAuthFlowError(502, f"Codex device verification failed with HTTP {response.status}: {response.text}")
        authorization_code = str(response.data.get("authorization_code") or "").strip()
        code_verifier = str(response.data.get("code_verifier") or "").strip()
        if not authorization_code or not code_verifier:
            raise OAuthFlowError(502, "Codex device verification response was missing authorization data")
        tokens = self.http.post_form(
            CODEX_TOKEN_URL,
            {
                "grant_type": "authorization_code",
                "code": authorization_code,
                "redirect_uri": "https://auth.openai.com/deviceauth/callback",
                "client_id": CODEX_OAUTH_CLIENT_ID,
                "code_verifier": code_verifier,
            },
            timeout=20.0,
        )
        if tokens.status != 200:
            raise OAuthFlowError(502, f"Codex token exchange failed with HTTP {tokens.status}: {tokens.text}")
        access_token = str(tokens.data.get("access_token") or "").strip()
        refresh_token = str(tokens.data.get("refresh_token") or "").strip()
        if not access_token or not refresh_token:
            raise OAuthFlowError(502, "Codex token exchange did not return access and refresh tokens")
        self._drop_session(flow_id)
        return {
            "flow_id": flow_id,
            "provider": provider,
            "status": "complete",
            "complete": True,
            "tokens": {"access_token": access_token, "refresh_token": refresh_token},
        }

    def complete(self, provider: str, flow_id: str, callback_url: str) -> dict[str, Any]:
        provider = normalize_oauth_provider(provider)
        session = self._get_session(provider, flow_id)
        if provider != "xai-oauth":
            raise OAuthFlowError(400, "this provider does not use callback paste completion")
        if time.time() > float(session["expires_at"]):
            self._drop_session(flow_id)
            raise OAuthFlowError(410, "OAuth verification timed out; start again")
        if session.get("auth_source") == "hermes" and self.hermes_bridge is not None:
            result = self.hermes_bridge.complete_xai(session, callback_url)
            self._drop_session(flow_id)
            result["flow_id"] = flow_id
            result.setdefault("provider", provider)
            result.setdefault("status", "complete")
            result.setdefault("complete", True)
            return result
        callback = _parse_callback_url(callback_url)
        if callback.get("error"):
            detail = callback.get("error_description") or callback["error"]
            raise OAuthFlowError(400, f"Grok authorization failed: {detail}")
        if callback.get("state") != session["state"]:
            raise OAuthFlowError(400, "Grok authorization failed: state mismatch")
        code = str(callback.get("code") or "").strip()
        if not code:
            raise OAuthFlowError(400, "Grok callback URL did not contain an authorization code")
        token_endpoint = str(session["token_endpoint"])
        response = self.http.post_form(
            token_endpoint,
            {
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": session["redirect_uri"],
                "client_id": XAI_OAUTH_CLIENT_ID,
                "code_verifier": session["code_verifier"],
                "code_challenge": session["code_challenge"],
                "code_challenge_method": "S256",
            },
            timeout=30.0,
        )
        if response.status != 200:
            raise OAuthFlowError(502, f"Grok token exchange failed with HTTP {response.status}: {response.text}")
        access_token = str(response.data.get("access_token") or "").strip()
        refresh_token = str(response.data.get("refresh_token") or "").strip()
        if not access_token or not refresh_token:
            raise OAuthFlowError(502, "Grok token exchange did not return access and refresh tokens")
        self._drop_session(flow_id)
        return {
            "flow_id": flow_id,
            "provider": provider,
            "status": "complete",
            "complete": True,
            "tokens": {
                "access_token": access_token,
                "refresh_token": refresh_token,
                "id_token": str(response.data.get("id_token") or "").strip(),
                "token_type": str(response.data.get("token_type") or "Bearer").strip() or "Bearer",
                "expires_in": response.data.get("expires_in"),
            },
        }

    def _start_codex(self) -> dict[str, Any]:
        response = self.http.post_json(
            CODEX_DEVICE_USER_CODE_URL,
            {"client_id": CODEX_OAUTH_CLIENT_ID},
            timeout=20.0,
        )
        if response.status != 200:
            raise OAuthFlowError(502, f"Codex device code request failed with HTTP {response.status}: {response.text}")
        user_code = str(response.data.get("user_code") or "").strip()
        device_auth_id = str(response.data.get("device_auth_id") or "").strip()
        if not user_code or not device_auth_id:
            raise OAuthFlowError(502, "Codex device code response was missing required fields")
        interval = _positive_int(response.data.get("interval"), 5)
        expires_in = _positive_int(response.data.get("expires_in") or response.data.get("expires_in_seconds"), 900)
        flow_id = secrets.token_urlsafe(18)
        session = {
            "flow_id": flow_id,
            "provider": "openai-codex",
            "kind": "device_code",
            "user_code": user_code,
            "device_auth_id": device_auth_id,
            "verification_url": CODEX_DEVICE_VERIFICATION_URL,
            "poll_interval": max(3, interval),
            "expires_at": time.time() + max(60, expires_in),
        }
        self._store_session(session)
        return self._pending_response(session, "waiting_for_user")

    def _start_codex_via_hermes(self) -> dict[str, Any]:
        flow = self.hermes_bridge.start("openai-codex")
        flow_id = secrets.token_urlsafe(18)
        session = {
            "flow_id": flow_id,
            "provider": "openai-codex",
            "kind": "device_code",
            "auth_source": "hermes",
            "user_code": str(flow.get("user_code") or "").strip(),
            "device_auth_id": str(flow.get("device_auth_id") or "").strip(),
            "verification_url": str(flow.get("verification_url") or CODEX_DEVICE_VERIFICATION_URL).strip(),
            "poll_interval": max(3, _positive_int(flow.get("poll_interval") or flow.get("interval"), 5)),
            "expires_at": float(flow.get("expires_at") or (time.time() + _positive_int(flow.get("expires_in"), 900))),
        }
        if not session["user_code"] or not session["device_auth_id"]:
            raise OAuthFlowError(502, "Hermes Codex device code response was missing required fields")
        self._store_session(session)
        return self._pending_response(session, str(flow.get("status") or "waiting_for_user"))

    def _start_xai(self) -> dict[str, Any]:
        discovery = self.http.get_json(XAI_OAUTH_DISCOVERY_URL, timeout=20.0)
        if discovery.status != 200:
            raise OAuthFlowError(502, f"Grok OAuth discovery failed with HTTP {discovery.status}: {discovery.text}")
        authorization_endpoint = str(discovery.data.get("authorization_endpoint") or "").strip()
        token_endpoint = str(discovery.data.get("token_endpoint") or "").strip()
        if not authorization_endpoint or not token_endpoint:
            raise OAuthFlowError(502, "Grok OAuth discovery response was missing endpoints")
        code_verifier = _pkce_code_verifier()
        code_challenge = _pkce_code_challenge(code_verifier)
        state = uuid.uuid4().hex
        nonce = uuid.uuid4().hex
        authorize_url = authorization_endpoint + "?" + urllib.parse.urlencode(
            {
                "response_type": "code",
                "client_id": XAI_OAUTH_CLIENT_ID,
                "redirect_uri": XAI_REDIRECT_URI,
                "scope": XAI_OAUTH_SCOPE,
                "code_challenge": code_challenge,
                "code_challenge_method": "S256",
                "state": state,
                "nonce": nonce,
                "plan": "generic",
                "referrer": "hermes-agent",
            }
        )
        flow_id = secrets.token_urlsafe(18)
        session = {
            "flow_id": flow_id,
            "provider": "xai-oauth",
            "kind": "manual_callback",
            "authorize_url": authorize_url,
            "redirect_uri": XAI_REDIRECT_URI,
            "token_endpoint": token_endpoint,
            "code_verifier": code_verifier,
            "code_challenge": code_challenge,
            "state": state,
            "expires_at": time.time() + 900,
        }
        self._store_session(session)
        return self._pending_response(session, "waiting_for_callback")

    def _start_xai_via_hermes(self) -> dict[str, Any]:
        flow = self.hermes_bridge.start("xai-oauth")
        flow_id = secrets.token_urlsafe(18)
        session = {
            "flow_id": flow_id,
            "provider": "xai-oauth",
            "kind": "manual_callback",
            "auth_source": "hermes",
            "authorize_url": str(flow.get("authorize_url") or "").strip(),
            "redirect_uri": str(flow.get("redirect_uri") or XAI_REDIRECT_URI).strip(),
            "token_endpoint": str(flow.get("token_endpoint") or "").strip(),
            "discovery": flow.get("discovery") if isinstance(flow.get("discovery"), dict) else {},
            "code_verifier": str(flow.get("code_verifier") or "").strip(),
            "code_challenge": str(flow.get("code_challenge") or "").strip(),
            "state": str(flow.get("state") or "").strip(),
            "expires_at": float(flow.get("expires_at") or (time.time() + 900)),
        }
        required = ("authorize_url", "redirect_uri", "token_endpoint", "code_verifier", "code_challenge", "state")
        if any(not session[key] for key in required):
            raise OAuthFlowError(502, "Hermes Grok OAuth start response was missing required fields")
        self._store_session(session)
        return self._pending_response(session, str(flow.get("status") or "waiting_for_callback"))

    def _pending_response(self, session: dict[str, Any], status: str) -> dict[str, Any]:
        response = {
            "flow_id": session["flow_id"],
            "provider": session["provider"],
            "kind": session["kind"],
            "status": status,
            "complete": False,
            "expires_at": int(float(session["expires_at"])),
        }
        for key in ("verification_url", "user_code", "poll_interval", "authorize_url", "redirect_uri"):
            if key in session:
                response[key] = session[key]
        return response

    def _get_session(self, provider: str, flow_id: str) -> dict[str, Any]:
        with self._lock:
            session = self._sessions.get(flow_id)
        if not session or session.get("provider") != provider:
            raise OAuthFlowError(404, "OAuth verification session not found; start again")
        return session

    def _drop_session(self, flow_id: str) -> None:
        with self._lock:
            self._sessions.pop(flow_id, None)

    def _store_session(self, session: dict[str, Any]) -> None:
        with self._lock:
            self._sessions[session["flow_id"]] = session

    def _hermes_bridge_available(self) -> bool:
        if self.hermes_bridge is None:
            return False
        try:
            return bool(self.hermes_bridge.available())
        except Exception:
            return False


def normalize_oauth_provider(value: str | None) -> str:
    clean = (value or "").strip().lower().replace("_", "-")
    aliases = {
        "codex": "openai-codex",
        "openai-codex-oauth": "openai-codex",
        "grok": "xai-oauth",
        "grok-oauth": "xai-oauth",
        "xai-grok-oauth": "xai-oauth",
    }
    return aliases.get(clean, clean)


def oauth_provider_info(provider: str) -> dict[str, Any]:
    provider = normalize_oauth_provider(provider)
    return dict(OAUTH_PROVIDER_INFO[provider])


def _json_object(text: str) -> dict[str, Any]:
    try:
        data = json.loads(text) if text else {}
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _positive_int(value: Any, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def _pkce_code_verifier(length: int = 64) -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(length)).decode("ascii").rstrip("=")


def _pkce_code_challenge(code_verifier: str) -> str:
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def _parse_callback_url(callback_url: str) -> dict[str, str]:
    raw = callback_url.strip()
    if not raw:
        raise OAuthFlowError(400, "callback URL is required")
    parsed = urllib.parse.urlparse(raw)
    query = parsed.query or raw.lstrip("?")
    values = urllib.parse.parse_qs(query, keep_blank_values=True)
    return {key: vals[0] for key, vals in values.items() if vals}
