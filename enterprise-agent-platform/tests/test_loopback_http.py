from __future__ import annotations

import http.server
import os
import threading
import unittest
import urllib.error
import urllib.request
from unittest import mock

from enterprise_agent_platform.loopback_http import (
    open_loopback_url,
    open_private_service_url,
    open_trusted_service_url,
)


class _LoopbackHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header(
                "Location",
                f"http://127.0.0.1:{self.server.server_port}/ok",
            )
            self.end_headers()
            return
        body = b"OK"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format, *_args):
        return


class LoopbackHTTPTests(unittest.TestCase):
    def setUp(self):
        self.server = http.server.ThreadingHTTPServer(
            ("127.0.0.1", 0),
            _LoopbackHandler,
        )
        self.thread = threading.Thread(
            target=self.server.serve_forever,
            daemon=True,
        )
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def test_loopback_request_ignores_process_proxy_configuration(self):
        request = urllib.request.Request(self.base_url + "/ok", method="GET")
        with mock.patch.dict(
            os.environ,
            {
                "HTTP_PROXY": "http://127.0.0.1:1",
                "http_proxy": "http://127.0.0.1:1",
                "NO_PROXY": "",
                "no_proxy": "",
            },
            clear=False,
        ):
            with open_loopback_url(request, timeout=2) as response:
                self.assertEqual(response.read(), b"OK")

    def test_loopback_request_rejects_redirects(self):
        request = urllib.request.Request(
            self.base_url + "/redirect",
            method="GET",
        )
        with self.assertRaises(urllib.error.HTTPError) as raised:
            open_loopback_url(request, timeout=2)
        self.assertEqual(raised.exception.code, 302)

    def test_trusted_service_request_rejects_redirects(self):
        request = urllib.request.Request(
            self.base_url + "/redirect",
            headers={"Authorization": "Bearer must-not-be-forwarded"},
            method="GET",
        )
        with self.assertRaises(urllib.error.HTTPError) as raised:
            open_trusted_service_url(request, timeout=2)
        self.assertEqual(raised.exception.code, 302)

    def test_private_service_request_ignores_proxies_and_rejects_redirects(self):
        request = urllib.request.Request(self.base_url + "/ok", method="GET")
        with mock.patch.dict(
            os.environ,
            {"HTTP_PROXY": "http://127.0.0.1:1", "NO_PROXY": ""},
            clear=False,
        ):
            with open_private_service_url(request, timeout=2) as response:
                self.assertEqual(response.read(), b"OK")
        with self.assertRaises(urllib.error.HTTPError) as raised:
            open_private_service_url(
                urllib.request.Request(self.base_url + "/redirect", method="GET"),
                timeout=2,
            )
        self.assertEqual(raised.exception.code, 302)

    def test_loopback_request_rejects_public_and_hostname_targets(self):
        for url in (
            "https://example.com/search",
            f"http://localhost:{self.server.server_port}/ok",
            f"http://user:secret@127.0.0.1:{self.server.server_port}/ok",
            "http://127.0.0.1:0/ok",
        ):
            with self.subTest(url=url), self.assertRaisesRegex(
                ValueError,
                "numeric loopback URL",
            ):
                open_loopback_url(
                    urllib.request.Request(url, method="GET"),
                    timeout=2,
                )


if __name__ == "__main__":
    unittest.main()
