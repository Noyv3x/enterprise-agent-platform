#!/usr/bin/env python3
"""Exercise human browser control through the real Platform/Camoufox stack."""

from __future__ import annotations

import argparse
import http.cookiejar
import ipaddress
import json
import os
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


MAX_RESPONSE_BYTES = 10 * 1024 * 1024
CONTROL_TEXT = "AGENT-PLATFORM-HUMAN-CONTROL"


class SmokeError(RuntimeError):
    pass


class HTTPStatusError(SmokeError):
    def __init__(self, path: str, status: int):
        super().__init__(f"{path} returned HTTP {status}")
        self.status = status


def _read_secret(path: Path) -> str:
    try:
        metadata = path.lstat()
    except OSError as exc:
        raise SmokeError(f"required credential file is unavailable: {path}") from exc
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise SmokeError(f"credential path is not a regular file: {path}")
    value = path.read_text(encoding="utf-8").strip()
    if not value or any(character in value for character in "\r\n\x00"):
        raise SmokeError(f"credential file is empty or malformed: {path}")
    return value


def _loopback_platform_url(value: str) -> str:
    clean = value.rstrip("/")
    parsed = urllib.parse.urlsplit(clean)
    try:
        address = ipaddress.ip_address(parsed.hostname or "")
    except ValueError as exc:
        raise SmokeError("platform smoke URL must use a literal loopback address") from exc
    if parsed.scheme != "http" or not address.is_loopback or parsed.username or parsed.password:
        raise SmokeError("platform smoke URL must be an unauthenticated loopback HTTP origin")
    if parsed.path or parsed.query or parsed.fragment:
        raise SmokeError("platform smoke URL must contain only an origin")
    return clean


def _fixture_url(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    if (
        parsed.scheme != "http"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise SmokeError("fixture URL must be a credential-free HTTP URL")
    return value


class PlatformClient:
    def __init__(self, base_url: str, agent_tool_token: str):
        self.base_url = base_url
        self.origin = base_url
        self.agent_tool_token = agent_tool_token
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cookies)
        )

    def _request(
        self,
        path: str,
        *,
        method: str = "GET",
        payload: dict[str, Any] | None = None,
        internal: bool = False,
        timeout: float = 30,
    ) -> tuple[bytes, Any]:
        headers = {"Accept": "application/json"}
        data = None
        if payload is not None:
            data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if internal:
            headers["Authorization"] = f"Bearer {self.agent_tool_token}"
        elif method != "GET":
            headers["Origin"] = self.origin
        request = urllib.request.Request(
            self.base_url + path,
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with self.opener.open(request, timeout=timeout) as response:
                body = response.read(MAX_RESPONSE_BYTES + 1)
                if len(body) > MAX_RESPONSE_BYTES:
                    raise SmokeError(f"{path} response exceeds the smoke-test limit")
                return body, response.headers
        except urllib.error.HTTPError as exc:
            # Drain a bounded amount so keep-alive state remains clean, but do
            # not copy potentially sensitive response text into CI logs.
            exc.read(4096)
            raise HTTPStatusError(path, int(exc.code)) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise SmokeError(f"{path} request failed: {type(exc).__name__}") from exc

    def json(
        self,
        path: str,
        *,
        method: str = "GET",
        payload: dict[str, Any] | None = None,
        internal: bool = False,
        timeout: float = 30,
    ) -> dict[str, Any]:
        body, _headers = self._request(
            path,
            method=method,
            payload=payload,
            internal=internal,
            timeout=timeout,
        )
        try:
            decoded = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise SmokeError(f"{path} returned invalid JSON") from exc
        if not isinstance(decoded, dict):
            raise SmokeError(f"{path} returned a non-object JSON response")
        return decoded

    def gateway(self, action: str, arguments: dict[str, Any]) -> dict[str, Any]:
        response = self.json(
            "/internal/agent/tools/browser",
            method="POST",
            internal=True,
            payload={
                "action": action,
                "arguments": arguments,
                "context": {"scope_key": self.scope_key},
            },
            timeout=75,
        )
        data = response.get("data")
        if not isinstance(data, dict):
            raise SmokeError(f"browser {action} returned no structured data")
        return data

    def control(self, payload: dict[str, Any]) -> dict[str, Any]:
        response = self.json(
            "/api/agent-previews/browser/control",
            method="POST",
            payload=payload,
            timeout=40,
        )
        return response

    def frame(self, actor_id: int, tab_id: str) -> tuple[bytes, Any]:
        query = urllib.parse.urlencode(
            {"scope_type": "private", "scope_id": str(actor_id), "tab_id": tab_id}
        )
        return self._request(
            f"/api/agent-previews/browser?{query}",
            timeout=20,
        )


def _expect(condition: bool, message: str) -> None:
    if not condition:
        raise SmokeError(message)


def run(args: argparse.Namespace) -> None:
    platform_url = _loopback_platform_url(args.platform_url)
    fixture_url = _fixture_url(args.fixture_url)
    admin_password = _read_secret(args.bootstrap_password_file)
    agent_tool_token = _read_secret(args.agent_tool_token_file)
    client = PlatformClient(platform_url, agent_tool_token)
    actor_id = 0
    tab_id = ""
    lease_id = ""

    try:
        login = client.json(
            "/api/auth/login",
            method="POST",
            payload={"username": "admin", "password": admin_password},
        )
        user = login.get("user")
        _expect(isinstance(user, dict), "login response omitted the authenticated user")
        try:
            actor_id = int(user.get("id"))
        except (TypeError, ValueError) as exc:
            raise SmokeError("login response contained an invalid user id") from exc
        _expect(actor_id > 0, "login response contained an invalid user id")

        # This user-facing endpoint is the supported way to materialize the
        # private scope; the test does not write SQLite or derive browser IDs.
        status = client.json("/api/private-agent/status")
        execution = status.get("execution")
        _expect(
            isinstance(execution, dict) and execution.get("scope_key") == f"private:{actor_id}",
            "private scope was not materialized through Platform",
        )
        client.scope_key = str(execution["scope_key"])

        created = client.gateway("new_tab", {"url": fixture_url})
        tab_id = str(created.get("tabId") or "")
        _expect(bool(tab_id), "browser Gateway did not return a tab id")
        _expect(str(created.get("url") or "").startswith(fixture_url), "browser opened an unexpected URL")

        scope = {
            "scope_type": "private",
            "scope_id": str(actor_id),
            "tab_id": tab_id,
        }
        acquired = client.control({"command": "acquire", **scope})
        lease_id = str(acquired.get("lease_id") or "")
        _expect(bool(lease_id), "Platform did not issue a browser assistance lease")
        _expect(int(acquired.get("expires_in_ms") or 0) > 0, "browser lease has no usable lifetime")

        try:
            client.gateway("refresh", {"tab_id": tab_id})
        except HTTPStatusError as exc:
            _expect(exc.status == 409, "Agent mutation returned the wrong lease conflict status")
        else:
            raise SmokeError("Agent mutation was not blocked by the human lease")

        def send(sequence: int, action: str, **details: Any) -> dict[str, Any]:
            response = client.control(
                {
                    "command": "input",
                    **scope,
                    "lease_id": lease_id,
                    "sequence": sequence,
                    "action": action,
                    **details,
                }
            )
            _expect(response.get("ok") is True, f"human {action} input did not succeed")
            _expect(response.get("sequence") == sequence, f"human {action} sequence was not preserved")
            return response

        drag_points = [
            {"x": 52, "y": 218, "at_ms": 0},
            {"x": 180, "y": 218, "at_ms": 50},
            {"x": 330, "y": 218, "at_ms": 100},
            {"x": 480, "y": 218, "at_ms": 150},
        ]
        send(1, "drag", points=drag_points)
        replay = client.control(
            {
                "command": "input",
                **scope,
                "lease_id": lease_id,
                "sequence": 1,
                "action": "drag",
                "points": drag_points,
            }
        )
        _expect(replay.get("duplicate") is True, "duplicate drag sequence was replayed")
        send(2, "click", x=96, y=64)
        send(3, "text", text=CONTROL_TEXT)
        send(4, "key", key="Enter")
        send(5, "wheel", delta_x=0, delta_y=900)

        snapshot = client.gateway("snapshot", {"tab_id": tab_id})
        snapshot_text = str(snapshot.get("snapshot") or "")
        for marker in (
            "focus=1",
            f"text={CONTROL_TEXT}",
            "key=Enter",
            "scroll=1",
            "drag=1",
            "drag_count=1",
            "pointer_down=0",
        ):
            _expect(marker in snapshot_text, f"browser snapshot did not observe {marker}")

        frame, headers = client.frame(actor_id, tab_id)
        content_type = str(headers.get("Content-Type") or "").split(";", 1)[0].lower()
        _expect(content_type == "image/jpeg", "browser preview did not return the low-bandwidth JPEG frame")
        _expect(frame.startswith(b"\xff\xd8") and frame.endswith(b"\xff\xd9"), "browser preview frame is not a complete JPEG")
        _expect(len(frame) > 512, "browser preview frame is unexpectedly small")
        _expect(headers.get("X-Preview-State") == "live", "browser preview is not live")
        _expect(
            urllib.parse.unquote(str(headers.get("X-Preview-Tab-Id") or "")) == tab_id,
            "browser preview frame belongs to another tab",
        )
        _expect(int(headers.get("X-Preview-Width") or 0) > 0, "browser preview width is missing")
        _expect(int(headers.get("X-Preview-Height") or 0) > 0, "browser preview height is missing")
        _expect(
            int(headers.get("X-Preview-Refresh-Ms") or 0) == 250,
            "browser control preview did not advertise its bounded faster interval",
        )

        released = client.control(
            {"command": "release", **scope, "lease_id": lease_id}
        )
        _expect(released.get("released") is True, "browser assistance lease was not released")
        lease_id = ""

        # A real mutation after release proves the operation gate reopened.
        refreshed = client.gateway("refresh", {"tab_id": tab_id})
        _expect(str(refreshed.get("url") or "").startswith(fixture_url), "Agent browser did not resume after release")
        client.gateway("close", {"tab_id": tab_id})
        tab_id = ""
    finally:
        # Preserve the primary failure while preventing a failed acceptance run
        # from keeping a tab or lease alive for the remainder of the job.
        if lease_id and tab_id and actor_id:
            try:
                client.control(
                    {
                        "command": "release",
                        "scope_type": "private",
                        "scope_id": str(actor_id),
                        "tab_id": tab_id,
                        "lease_id": lease_id,
                    }
                )
            except Exception:
                pass
        if tab_id and hasattr(client, "scope_key"):
            try:
                client.gateway("close", {"tab_id": tab_id})
            except Exception:
                pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--platform-url", required=True)
    parser.add_argument("--bootstrap-password-file", required=True, type=Path)
    parser.add_argument("--agent-tool-token-file", required=True, type=Path)
    parser.add_argument("--fixture-url", required=True)
    return parser.parse_args()


if __name__ == "__main__":
    try:
        run(parse_args())
    except SmokeError as exc:
        print(f"browser control compose smoke failed: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
    print("browser control compose smoke passed")
