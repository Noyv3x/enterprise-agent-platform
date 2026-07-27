from __future__ import annotations

import http.client
import json
import socket
from pathlib import Path
from typing import Any


MAX_MANAGER_RESPONSE_BYTES = 8 * 1024 * 1024


class ManagerClientError(RuntimeError):
    pass


class ManagerResponseUncertainError(ManagerClientError):
    """A successful status was received but its response cannot be trusted."""


class _UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, socket_path: Path, timeout: float):
        super().__init__("localhost", timeout=timeout)
        self.socket_path = socket_path

    def connect(self) -> None:
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.settimeout(self.timeout)
        try:
            connection.connect(str(self.socket_path))
        except Exception:
            connection.close()
            raise
        self.sock = connection


class ManagerClient:
    """Small fail-closed client for the host manager's owner-only UDS API."""

    def __init__(
        self,
        socket_path: Path,
        token_file: Path | None = None,
        *,
        timeout_seconds: float = 10.0,
    ):
        self.socket_path = Path(socket_path)
        self.token_file = Path(token_file) if token_file else None
        self.timeout_seconds = float(timeout_seconds)
        if self.timeout_seconds <= 0:
            raise ValueError("manager timeout must be positive")

    def _token(self) -> str:
        if self.token_file is None:
            return ""
        try:
            token = self.token_file.read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise ManagerClientError(f"manager token is unavailable: {exc}") from exc
        if not token or any(character in token for character in "\r\n\x00"):
            raise ManagerClientError("manager token file is empty or invalid")
        return token

    def _request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not path.startswith("/") or "\r" in path or "\n" in path:
            raise ValueError("manager API path is invalid")
        payload = b"" if body is None else json.dumps(
            body, ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")
        headers = {"Accept": "application/json", "Connection": "close"}
        if payload:
            headers["Content-Type"] = "application/json"
            headers["Content-Length"] = str(len(payload))
        token = self._token()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        connection = _UnixHTTPConnection(self.socket_path, self.timeout_seconds)
        response: http.client.HTTPResponse | None = None
        try:
            connection.request(method, path, body=payload, headers=headers)
            response = connection.getresponse()
            raw = response.read(MAX_MANAGER_RESPONSE_BYTES + 1)
        except (OSError, TimeoutError, http.client.HTTPException) as exc:
            if response is not None and 200 <= response.status < 300:
                raise ManagerResponseUncertainError(
                    f"manager {method} {path} HTTP {response.status} response read "
                    "failed; outcome is uncertain"
                ) from exc
            raise ManagerClientError(f"manager request failed: {exc}") from exc
        finally:
            connection.close()
        successful = 200 <= response.status < 300
        if len(raw) > MAX_MANAGER_RESPONSE_BYTES:
            error_type = ManagerResponseUncertainError if successful else ManagerClientError
            raise error_type(
                f"manager {method} {path} HTTP {response.status} response exceeded "
                "the size limit; outcome is uncertain"
            )
        if successful and not raw.strip():
            raise ManagerResponseUncertainError(
                f"manager {method} {path} HTTP {response.status} returned an empty "
                "response; outcome is uncertain"
            )
        try:
            decoded = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            error_type = ManagerResponseUncertainError if successful else ManagerClientError
            raise error_type(
                f"manager {method} {path} HTTP {response.status} returned invalid JSON"
                + ("; outcome is uncertain" if successful else "")
            ) from exc
        if not isinstance(decoded, dict):
            error_type = ManagerResponseUncertainError if successful else ManagerClientError
            raise error_type(
                f"manager {method} {path} HTTP {response.status} response must be a JSON object"
                + ("; outcome is uncertain" if successful else "")
            )
        if not successful:
            message = str(decoded.get("error") or decoded.get("message") or response.reason)
            raise ManagerClientError(f"manager HTTP {response.status}: {message}")
        return decoded

    def status(self) -> dict[str, Any]:
        return self._request("GET", "/v1/status")

    def config(self) -> dict[str, Any]:
        return self._request("GET", "/v1/config")

    def update_config(self, updates: dict[str, Any]) -> dict[str, Any]:
        return self._request("PATCH", "/v1/config", updates)

    def check(self, *, idempotency_key: str) -> dict[str, Any]:
        return self._request("POST", "/v1/check", {"idempotency_key": idempotency_key})

    def operation(
        self,
        operation: str,
        *,
        idempotency_key: str,
        expected_generation: int | None = None,
    ) -> dict[str, Any]:
        body = {"operation": operation, "idempotency_key": idempotency_key}
        if expected_generation is not None:
            body["expected_generation"] = int(expected_generation)
        return self._request("POST", "/v1/operations", body)
