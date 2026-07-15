from __future__ import annotations

import json
import os
import shutil
import socket
import socketserver
import struct
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import unittest
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from enterprise_agent_platform.config import PlatformConfig
from enterprise_agent_platform.runtimes import PlatformRuntimeManager


PROJECT_ROOT = Path(__file__).resolve().parents[1]
RUN_E2E = os.getenv("RUN_CAMOFOX_E2E") == "1"


class _FixtureHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/pixel.png":
            body = bytes.fromhex(
                "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
                "0000000d49444154789c6360f8cfc000000301010018dd8db10000000049454e44ae426082"
            )
            content_type = "image/png"
        elif self.path == "/next":
            body = b'<!doctype html><title>Next page</title><h1>Next page</h1><a href="/">Home</a>'
            content_type = "text/html; charset=utf-8"
        else:
            body = b'''<!doctype html><title>Browser fixture</title><h1>Browser fixture</h1>
            <label>Name <input id="name" aria-label="Name"></label>
            <button id="submit" onclick="document.getElementById('out').textContent='Submitted '+document.getElementById('name').value">Submit</button>
            <div id="out" role="status">Waiting</div><a href="/next">Next page</a>
            <img src="/pixel.png" alt="fixture pixel" width="1" height="1">'''
            content_type = "text/html; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args) -> None:
        pass


class _RebindingDnsServer(socketserver.ThreadingUDPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, address: tuple[str, int]):
        super().__init__(address, _RebindingDnsHandler)
        self.answer = "127.0.0.1"
        self.answer_lock = threading.Lock()

    def set_answer(self, address: str) -> None:
        with self.answer_lock:
            self.answer = address

    def response_for(self, query: bytes) -> bytes:
        if len(query) < 17:
            return b""
        offset = 12
        while offset < len(query):
            length = query[offset]
            offset += 1
            if length == 0:
                break
            offset += length
        if offset + 4 > len(query):
            return b""
        question_end = offset + 4
        query_type = struct.unpack("!H", query[offset : offset + 2])[0]
        answer = b""
        if query_type == 1:
            with self.answer_lock:
                address = self.answer
            answer = (
                b"\xc0\x0c"
                + struct.pack("!HHIH", 1, 1, 0, 4)
                + socket.inet_aton(address)
            )
        header = query[:2] + struct.pack("!HHHHH", 0x8180, 1, int(bool(answer)), 0, 0)
        return header + query[12:question_end] + answer


class _RebindingDnsHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        query, udp_socket = self.request
        response = self.server.response_for(query)
        if response:
            udp_socket.sendto(response, self.client_address)


@unittest.skipUnless(RUN_E2E, "set RUN_CAMOFOX_E2E=1 after preparing the managed browser")
class ManagedCamofoxE2ETests(unittest.TestCase):
    def test_locked_browser_full_action_chain_and_scope_isolation(self) -> None:
        fixture = ThreadingHTTPServer(("127.0.0.1", 0), _FixtureHandler)
        fixture_thread = threading.Thread(target=fixture.serve_forever, daemon=True)
        fixture_thread.start()
        dns_server = _RebindingDnsServer(("127.0.0.1", 0))
        dns_thread = threading.Thread(target=dns_server.serve_forever, daemon=True)
        dns_thread.start()
        with socket.socket() as candidate:
            candidate.bind(("127.0.0.1", 0))
            port = int(candidate.getsockname()[1])
        data_dir = Path(os.getenv("CAMOFOX_E2E_DATA", PROJECT_ROOT / "data"))
        config = replace(
            PlatformConfig.from_env(PROJECT_ROOT),
            data_dir=data_dir,
            camofox_url=f"http://127.0.0.1:{port}",
            runtime_startup_wait_seconds=45,
        )
        manager = PlatformRuntimeManager(config, lambda _key: "")
        key = manager._camofox_access_key()
        headers = {"Authorization": f"Bearer {key}", "Accept": "application/json"}

        def request(method: str, path: str, body=None, *, binary: bool = False):
            data = None if body is None else json.dumps(body).encode("utf-8")
            request_headers = dict(headers)
            if data is not None:
                request_headers["Content-Type"] = "application/json"
            call = urllib.request.Request(
                config.camofox_url + path,
                data=data,
                headers=request_headers,
                method=method,
            )
            with urllib.request.urlopen(call, timeout=30) as response:
                raw = response.read()
            return raw if binary else json.loads(raw or b"{}")

        def request_failure(method: str, path: str, body=None) -> tuple[int, str]:
            try:
                request(method, path, body)
            except urllib.error.HTTPError as exc:
                return exc.code, exc.read().decode("utf-8", errors="replace")
            self.fail(f"expected {method} {path} to fail")

        try:
            with mock.patch.dict(
                os.environ,
                {
                    "UBITECH_CAMOFOX_PINNING_DNS_SERVERS": (
                        f"127.0.0.1:{dns_server.server_address[1]}"
                    )
                },
            ):
                status = manager.ensure_camofox_ready(wait=True)
            self.assertTrue(status.available, status.to_dict())
            health = request("GET", "/health")
            self.assertTrue(health["browserConnected"])
            self.assertTrue(health["browserRunning"])

            with self.assertRaises(urllib.error.HTTPError) as unauthorized:
                urllib.request.urlopen(config.camofox_url + "/tabs?userId=e2e", timeout=5)
            self.assertEqual(unauthorized.exception.code, 401)

            if shutil.which("ss"):
                sockets = subprocess.check_output(
                    ["ss", "-ltn", f"sport = :{port}"], text=True
                )
                self.assertIn(f"127.0.0.1:{port}", sockets)
                self.assertNotIn(f"*:{port}", sockets)

            fixture_url = f"http://127.0.0.1:{fixture.server_port}/"
            camofox_log = config.runtime_dir / "camofox" / "logs" / "managed-camofox.log"
            guard_log_offset = camofox_log.stat().st_size

            # These navigations exercise the preload-installed BrowserContext
            # route, not just its exported address-classification helper.  The
            # managed API creates a real Camoufox page and Playwright reports
            # the route's blocked-by-client abort before a socket is opened.
            for target in (
                "http://169.254.169.254/latest/meta-data/?token=e2e-secret#fragment",
                "http://[fe80::1]/",
            ):
                failure_status, failure_body = request_failure(
                    "POST",
                    "/tabs",
                    {"userId": "e2e-blocked", "sessionKey": "agent", "url": target},
                )
                self.assertGreaterEqual(failure_status, 400)
                self.assertRegex(
                    failure_body.lower(),
                    r"internal server error|ns_error_failure|blockedbyclient|blocked.by.client|blocked network target",
                )

            guard_log = camofox_log.read_bytes()[guard_log_offset:].decode(
                "utf-8", errors="replace"
            )
            self.assertIn(
                "[ubitech-camofox-network-guard] blocked request 169.254.169.254",
                guard_log,
            )
            self.assertIn(
                "[ubitech-camofox-network-guard] blocked request fe80::1",
                guard_log,
            )
            self.assertNotIn("e2e-secret", guard_log)
            self.assertNotIn("#fragment", guard_log)

            # Deterministic DNS rebinding check: Firefox can load the fixture
            # through a hostname known only to the proxy's resolver, proving
            # the real BrowserContext uses the pinning proxy. Changing that
            # same DNS name to metadata space must produce the proxy's local
            # policy page without opening a socket to the rebinding address.
            rebinding_host = "rebinding.ubitech.invalid"
            dns_server.set_answer("127.0.0.1")
            rebound_safe = request(
                "POST",
                "/tabs",
                {
                    "userId": "e2e-rebinding-safe",
                    "sessionKey": "agent",
                    "url": f"http://{rebinding_host}:{fixture.server_port}/next",
                },
            )
            rebound_safe_tab = urllib.parse.quote(rebound_safe["tabId"], safe="")
            rebound_safe_snapshot = request(
                "GET",
                f"/tabs/{rebound_safe_tab}/snapshot?userId=e2e-rebinding-safe",
            )
            self.assertIn("Next page", rebound_safe_snapshot["snapshot"])

            dns_server.set_answer("169.254.169.254")
            rebound_blocked = request(
                "POST",
                "/tabs",
                {
                    "userId": "e2e-rebinding-blocked",
                    "sessionKey": "agent",
                    "url": f"http://{rebinding_host}:{fixture.server_port}/next",
                },
            )
            rebound_blocked_tab = urllib.parse.quote(rebound_blocked["tabId"], safe="")
            rebound_blocked_snapshot = request(
                "GET",
                f"/tabs/{rebound_blocked_tab}/snapshot?userId=e2e-rebinding-blocked",
            )
            self.assertIn("Blocked by managed browser network policy", rebound_blocked_snapshot["snapshot"])
            rebinding_log = camofox_log.read_bytes()[guard_log_offset:].decode(
                "utf-8", errors="replace"
            )
            self.assertIn(
                f"blocked proxy-request {rebinding_host} (dns-resolved-to-metadata-or-link-local)",
                rebinding_log,
            )

            created = request(
                "POST",
                "/tabs",
                {"userId": "e2e-a", "sessionKey": "agent", "url": fixture_url},
            )
            tab_id = created["tabId"]
            tab = urllib.parse.quote(tab_id, safe="")
            snapshot = request("GET", f"/tabs/{tab}/snapshot?userId=e2e-a")
            self.assertIn("Browser fixture", snapshot["snapshot"])
            self.assertGreaterEqual(snapshot["refsCount"], 2)

            request(
                "POST",
                f"/tabs/{tab}/type",
                {"userId": "e2e-a", "selector": "#name", "text": "Camoufox"},
            )
            request(
                "POST",
                f"/tabs/{tab}/click",
                {"userId": "e2e-a", "selector": "#submit"},
            )
            evaluated = request(
                "POST",
                f"/tabs/{tab}/evaluate",
                {"userId": "e2e-a", "expression": "document.querySelector('#out').textContent"},
            )
            self.assertEqual(evaluated["result"], "Submitted Camoufox")

            for route, payload in (
                ("viewport", {"width": 1024, "height": 768}),
                ("scroll", {"direction": "down", "amount": 200}),
                ("press", {"key": "Tab"}),
                ("wait", {"timeout": 5000, "waitForNetwork": False}),
            ):
                request("POST", f"/tabs/{tab}/{route}", {"userId": "e2e-a", **payload})

            links = request("GET", f"/tabs/{tab}/links?userId=e2e-a&limit=10")
            images = request("GET", f"/tabs/{tab}/images?userId=e2e-a&limit=10")
            stats = request("GET", f"/tabs/{tab}/stats?userId=e2e-a")
            downloads = request("GET", f"/tabs/{tab}/downloads?userId=e2e-a")
            self.assertTrue(any(item["url"].endswith("/next") for item in links["links"]))
            self.assertTrue(any(item.get("alt") == "fixture pixel" for item in images["images"]))
            self.assertEqual(stats["tabId"], tab_id)
            self.assertEqual(downloads["downloads"], [])

            screenshot = request(
                "GET", f"/tabs/{tab}/screenshot?userId=e2e-a&fullPage=true", binary=True
            )
            self.assertTrue(screenshot.startswith(b"\x89PNG\r\n\x1a\n"))

            request(
                "POST",
                f"/tabs/{tab}/navigate",
                {
                    "userId": "e2e-a",
                    "sessionKey": "agent",
                    "url": fixture_url + "next?token=navigation-secret#navigation-fragment",
                },
            )
            request("POST", f"/tabs/{tab}/back", {"userId": "e2e-a"})
            request("POST", f"/tabs/{tab}/forward", {"userId": "e2e-a"})
            refreshed = request("POST", f"/tabs/{tab}/refresh", {"userId": "e2e-a"})
            self.assertEqual(urllib.parse.urlparse(refreshed["url"]).path, "/next")

            sanitized_log = camofox_log.read_bytes()[guard_log_offset:].decode(
                "utf-8", errors="replace"
            )
            self.assertNotIn("navigation-secret", sanitized_log)
            self.assertNotIn("navigation-fragment", sanitized_log)
            self.assertIn(f'"url":"{fixture_url}next"', sanitized_log)

            self.assertEqual(request("GET", "/tabs?userId=e2e-b")["tabs"], [])
            request("DELETE", "/sessions/e2e-a")
            self.assertEqual(request("GET", "/tabs?userId=e2e-a")["tabs"], [])

            process = manager._camofox_process
            self.assertIsNotNone(process)
            started_stopping = time.monotonic()
            manager.stop_camofox()
            stopped_in = time.monotonic() - started_stopping
            self.assertLess(stopped_in, 8.0, f"Camofox SIGTERM shutdown took {stopped_in:.2f}s")
            self.assertEqual(process.poll(), 0)
        finally:
            fixture.shutdown()
            fixture.server_close()
            dns_server.shutdown()
            dns_server.server_close()
            manager.close()


if __name__ == "__main__":
    unittest.main()
