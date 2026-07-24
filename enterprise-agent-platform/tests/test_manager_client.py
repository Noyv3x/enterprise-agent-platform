from __future__ import annotations

import json
import socketserver
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler
from pathlib import Path

from enterprise_agent_platform.manager_client import ManagerClient, ManagerClientError


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
        if self.path == "/v1/status":
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
