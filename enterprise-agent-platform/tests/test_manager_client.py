from __future__ import annotations

import json
import socketserver
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler
from pathlib import Path

from enterprise_agent_platform.manager_client import (
    MAX_MANAGER_RESPONSE_BYTES,
    ManagerClient,
    ManagerClientError,
    ManagerResponseUncertainError,
)


class _Handler(BaseHTTPRequestHandler):
    server_version = "manager-test"

    def log_message(self, _format, *_args):
        return

    def _respond(self, payload, status=200):
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.headers.get("Authorization") != "Bearer test-token":
            self._respond({"error": "unauthorized"}, 401)
            return
        self.server.requests.append(("GET", self.path, None))  # type: ignore[attr-defined]
        if self.path == "/v1/empty":
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()
        elif self.path == "/v1/invalid":
            raw = b'{"status":'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
        elif self.path == "/v1/oversized":
            raw = b"x" * (MAX_MANAGER_RESPONSE_BYTES + 1)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
        elif self.path == "/v1/truncated":
            raw = b'{"status":'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw) + 100))
            self.end_headers()
            self.wfile.write(raw)
            self.close_connection = True
        elif self.path == "/v1/truncated-chunk":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            self.wfile.write(b'20\r\n{"status":')
            self.wfile.flush()
            self.close_connection = True
        elif self.path == "/v1/status":
            self._respond({"public_state": "idle", "generation": "g1"})
        elif self.path == "/v1/config":
            self._respond({"update_enabled": True, "update_interval": 300})
        else:
            self._respond({"error": "missing"}, 404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        self.server.requests.append(("POST", self.path, body))  # type: ignore[attr-defined]
        self._respond({"accepted": True, **body})


class _Server(socketserver.UnixStreamServer):
    allow_reuse_address = True


class ManagerClientTests(unittest.TestCase):
    def test_owner_socket_status_config_and_operation(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            socket_path = root / "manager.sock"
            token_path = root / "token"
            token_path.write_text("test-token\n", encoding="utf-8")
            server = _Server(str(socket_path), _Handler)
            server.requests = []
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                client = ManagerClient(socket_path, token_path)
                self.assertEqual(client.status()["generation"], "g1")
                self.assertEqual(client.config()["update_interval"], 300)
                response = client.operation(
                    "update", idempotency_key="key-1", expected_generation=7
                )
                self.assertTrue(response["accepted"])
                self.assertIn(
                    (
                        "POST",
                        "/v1/operations",
                        {
                            "operation": "update",
                            "idempotency_key": "key-1",
                            "expected_generation": 7,
                        },
                    ),
                    server.requests,
                )
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_missing_token_fails_closed(self):
        with tempfile.TemporaryDirectory() as td:
            client = ManagerClient(Path(td) / "missing.sock", Path(td) / "missing-token")
            with self.assertRaisesRegex(ManagerClientError, "token is unavailable"):
                client.status()

    def test_successful_but_unreadable_response_is_outcome_uncertain(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            socket_path = root / "manager.sock"
            token_path = root / "token"
            token_path.write_text("test-token\n", encoding="utf-8")
            server = _Server(str(socket_path), _Handler)
            server.requests = []
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                client = ManagerClient(socket_path, token_path)
                for path in (
                    "/v1/empty",
                    "/v1/invalid",
                    "/v1/oversized",
                    "/v1/truncated",
                ):
                    with self.subTest(path=path), self.assertRaisesRegex(
                        ManagerResponseUncertainError, "outcome is uncertain"
                    ):
                        client._request("GET", path)
                with self.assertRaisesRegex(
                    ManagerResponseUncertainError, "response read failed"
                ) as caught:
                    client._request("GET", "/v1/truncated-chunk")
                self.assertIsNotNone(caught.exception.__cause__)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)
