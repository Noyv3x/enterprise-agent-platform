from __future__ import annotations

import http.client
import json
import os
import socket
import sys
import tempfile
import textwrap
import threading
import time
import unittest
import urllib.error
import urllib.request
from dataclasses import replace
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from enterprise_agent_platform.config import PlatformConfig
from enterprise_agent_platform.gateway import (
    BackendTarget,
    BusinessRequestAdmission,
    GatewaySupervisor,
    GatewayHTTPServer,
    GatewayRequestHandler,
    MAX_PROXY_BODY_BYTES,
    _atomic_json_write,
    _gateway_exec_argv,
    gateway_process_is_live,
    gateway_state_path,
    read_gateway_state,
    wait_for_gateway_drain,
)
from enterprise_agent_platform.update_state import (
    mark_failure,
    mark_success,
    mark_updating,
    update_state_lock,
)


class _BackendHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def do_GET(self):
        if self.path == "/stream":
            first = b"first\n"
            second = b"second\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Set-Cookie", "gateway-test=1; Path=/")
            self.send_header("Content-Length", str(len(first) + len(second)))
            self.end_headers()
            self.wfile.write(first)
            self.wfile.flush()
            self.wfile.write(second)
            return
        body = json.dumps(
            {
                "path": self.path,
                "forwarded_for": self.headers.get("X-Forwarded-For"),
                "forwarded_proto": self.headers.get("X-Forwarded-Proto"),
            }
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        response = json.dumps({
            "body": body.decode("utf-8"),
            "content_length": self.headers.get("Content-Length"),
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)


class _FakeSupervisor:
    def __init__(self, config: PlatformConfig, target: BackendTarget):
        self.config = config
        self.target = target

    def public_update_status(self):
        from enterprise_agent_platform.update_state import read_public

        return read_public(self.config.data_dir, instance_id="gateway:1")

    def blocks_product_use(self):
        from enterprise_agent_platform.update_state import is_blocking, read_state

        return is_blocking(read_state(self.config.data_dir))

    def backend_target(self):
        return self.target

    def admit_business_request(self, method):
        if self.blocks_product_use():
            return None
        return BusinessRequestAdmission(
            self.target,
            method.upper() in {"POST", "PUT", "PATCH", "DELETE"},
        )

    def end_business_request(self, admission):
        return None


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data_dir = Path(self.temp.name) / "data"
        base = PlatformConfig.from_env(Path(self.temp.name))
        self.config = replace(
            base,
            data_dir=self.data_dir,
            host="127.0.0.1",
            port=0,
            public_base_url="https://agent.example.test",
        )
        self.backend = ThreadingHTTPServer(("127.0.0.1", 0), _BackendHandler)
        self.backend_thread = threading.Thread(target=self.backend.serve_forever, daemon=True)
        self.backend_thread.start()
        self.addCleanup(self._stop_backend)
        target = BackendTarget("127.0.0.1", self.backend.server_address[1])
        self.gateway = GatewayHTTPServer(
            ("127.0.0.1", 0),
            GatewayRequestHandler,
            _FakeSupervisor(self.config, target),
        )
        self.gateway_thread = threading.Thread(target=self.gateway.serve_forever, daemon=True)
        self.gateway_thread.start()
        self.addCleanup(self._stop_gateway)
        self.base_url = f"http://127.0.0.1:{self.gateway.server_address[1]}"

    def _stop_backend(self):
        self.backend.shutdown()
        self.backend.server_close()
        self.backend_thread.join(timeout=5)

    def _stop_gateway(self):
        self.gateway.shutdown()
        self.gateway.server_close()
        self.gateway_thread.join(timeout=5)

    def _raw_gateway_request(self, request: bytes) -> tuple[int, dict[str, str], bytes]:
        with socket.create_connection(("127.0.0.1", self.gateway.server_address[1]), timeout=5) as client:
            client.sendall(request)
            client.shutdown(socket.SHUT_WR)
            chunks: list[bytes] = []
            while True:
                chunk = client.recv(64 * 1024)
                if not chunk:
                    break
                chunks.append(chunk)
        raw = b"".join(chunks)
        head, _, body = raw.partition(b"\r\n\r\n")
        lines = head.decode("iso-8859-1").split("\r\n")
        status = int(lines[0].split(" ", 2)[1])
        headers = {}
        for line in lines[1:]:
            key, _, value = line.partition(":")
            headers[key.lower()] = value.strip()
        return status, headers, body

    def test_normal_requests_stream_through_gateway(self):
        with urllib.request.urlopen(self.base_url + "/stream", timeout=5) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.read(), b"first\nsecond\n")
            self.assertIn("gateway-test=1", response.headers.get("Set-Cookie", ""))

        with urllib.request.urlopen(self.base_url + "/hello?x=1", timeout=5) as response:
            payload = json.load(response)
        self.assertEqual(payload["path"], "/hello?x=1")
        self.assertEqual(payload["forwarded_for"], "127.0.0.1")
        self.assertEqual(payload["forwarded_proto"], "https")

    def test_request_framing_rejects_ambiguous_or_invalid_lengths_and_closes(self):
        cases = [
            (
                b"Content-Length: 3\r\nContent-Length: 4\r\n",
                HTTPStatus.BAD_REQUEST,
                "conflicting content lengths",
            ),
            (
                b"Content-Length: 3\r\nTransfer-Encoding: chunked\r\n",
                HTTPStatus.BAD_REQUEST,
                "ambiguous request framing",
            ),
            (
                b"Transfer-Encoding: gzip\r\n",
                HTTPStatus.BAD_REQUEST,
                "unsupported transfer encoding",
            ),
            (
                b"Content-Length: +3\r\n",
                HTTPStatus.BAD_REQUEST,
                "invalid content length",
            ),
            (
                f"Content-Length: {MAX_PROXY_BODY_BYTES + 1}\r\n".encode(),
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                "request body too large",
            ),
        ]
        for framing, expected_status, expected_error in cases:
            with self.subTest(framing=framing):
                status, headers, body = self._raw_gateway_request(
                    b"POST /echo HTTP/1.1\r\n"
                    b"Host: gateway.test\r\n"
                    + framing
                    + b"Connection: keep-alive\r\n\r\nabc",
                )
                self.assertEqual(status, expected_status)
                self.assertEqual(headers.get("connection"), "close")
                self.assertIn(expected_error, json.loads(body)["error"])

    def test_request_framing_accepts_identical_duplicate_lengths_and_chunked(self):
        duplicate_status, duplicate_headers, duplicate_body = self._raw_gateway_request(
            b"POST /echo HTTP/1.1\r\n"
            b"Host: gateway.test\r\n"
            b"Content-Length: 3\r\n"
            b"Content-Length: 3\r\n"
            b"Connection: close\r\n\r\nabc",
        )
        self.assertEqual(duplicate_status, HTTPStatus.OK)
        self.assertEqual(json.loads(duplicate_body)["body"], "abc")
        self.assertEqual(duplicate_headers.get("content-type"), "application/json")

        chunked_status, _, chunked_body = self._raw_gateway_request(
            b"POST /echo HTTP/1.1\r\n"
            b"Host: gateway.test\r\n"
            b"Transfer-Encoding: chunked\r\n"
            b"Connection: close\r\n\r\n"
            b"3\r\nabc\r\n0\r\n\r\n",
        )
        self.assertEqual(chunked_status, HTTPStatus.OK)
        self.assertEqual(json.loads(chunked_body)["body"], "abc")

    def test_update_state_blocks_pages_and_business_api(self):
        mark_updating(
            self.data_dir,
            update_id="update-1",
            instance_id="old-instance",
            reason="test",
            target_revision="abc",
            remote="origin",
            branch="main",
        )
        with self.assertRaises(urllib.error.HTTPError) as page_error:
            urllib.request.urlopen(self.base_url + "/", timeout=5)
        self.assertEqual(page_error.exception.code, 503)
        page = page_error.exception.read().decode()
        self.assertIn("ubitech agent", page)
        self.assertIn("正在更新", page)
        self.assertIn("Updating", page)
        self.assertIn("服務", page)

        request = urllib.request.Request(
            self.base_url + "/api/messages",
            data=b"{}",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with self.assertRaises(urllib.error.HTTPError) as api_error:
            urllib.request.urlopen(request, timeout=5)
        self.assertEqual(api_error.exception.code, 503)
        self.assertEqual(json.load(api_error.exception)["code"], "platform_updating")
        self.assertEqual(api_error.exception.headers["Retry-After"], "2")

        with urllib.request.urlopen(self.base_url + "/healthz", timeout=5) as response:
            self.assertEqual(
                json.load(response),
                {"status": "ok", "service": "ubitech-agent-platform"},
            )
        with urllib.request.urlopen(
            self.base_url + "/api/platform/update-status",
            timeout=5,
        ) as response:
            self.assertEqual(json.load(response)["state"], "updating")

    def test_failed_update_remains_blocked_until_rollback_or_success(self):
        mark_updating(
            self.data_dir,
            update_id="update-2",
            instance_id="old-instance",
            reason="test",
            target_revision="abc",
            remote="origin",
            branch="main",
        )
        mark_failure(self.data_dir, update_id="update-2", error="hidden")
        with urllib.request.urlopen(
            self.base_url + "/api/platform/update-status",
            timeout=5,
        ) as response:
            status = json.load(response)
        self.assertEqual(status["state"], "failed")
        self.assertNotIn("hidden", status)
        mark_success(self.data_dir, update_id="update-2", outcome="operator_recovered")
        with urllib.request.urlopen(self.base_url + "/hello", timeout=5) as response:
            self.assertEqual(response.status, 200)

    def test_gateway_state_validation_and_liveness(self):
        path = gateway_state_path(self.data_dir)
        _atomic_json_write(
            path,
            {
                "schema_version": 1,
                "pid": os.getpid(),
                "heartbeat_at": time.time(),
                "generation": 3,
            },
        )
        state = read_gateway_state(self.data_dir)
        self.assertEqual(state["generation"], 3)
        self.assertTrue(gateway_process_is_live(state))
        stale = {**state, "heartbeat_at": time.time() - 100}
        self.assertFalse(gateway_process_is_live(stale))

    def test_admission_and_update_marker_share_one_cross_process_boundary(self):
        target = BackendTarget("127.0.0.1", self.backend.server_address[1])
        supervisor = GatewaySupervisor(
            self.config,
            mode="foreground",
            backend_command=["unused"],
        )
        with supervisor._lock:
            supervisor._target = target
            supervisor._backend_ready = True

        write_started = threading.Event()
        release_write = threading.Event()
        original_write = supervisor._write_state

        def delayed_write():
            write_started.set()
            self.assertTrue(release_write.wait(5))
            original_write()

        supervisor._write_state = delayed_write
        admitted: list[BusinessRequestAdmission | None] = []
        admission_thread = threading.Thread(
            target=lambda: admitted.append(supervisor.admit_business_request("POST")),
        )
        admission_thread.start()
        self.assertTrue(write_started.wait(5))

        marker_thread = threading.Thread(
            target=lambda: mark_updating(
                self.data_dir,
                update_id="atomic-1",
                instance_id="old",
                reason="test",
                target_revision="new",
                remote="origin",
                branch="main",
            ),
        )
        marker_thread.start()
        time.sleep(0.05)
        self.assertTrue(marker_thread.is_alive(), "marker bypassed the admission lock")

        release_write.set()
        admission_thread.join(timeout=5)
        marker_thread.join(timeout=5)
        supervisor._write_state = original_write
        self.assertFalse(admission_thread.is_alive())
        self.assertFalse(marker_thread.is_alive())
        self.assertIsNotNone(admitted[0])
        self.assertFalse(wait_for_gateway_drain(self.data_dir, timeout=0.05))

        supervisor.end_business_request(admitted[0])
        self.assertTrue(wait_for_gateway_drain(self.data_dir, timeout=1))

    def test_inherited_listener_remains_bound_and_becomes_close_on_exec(self):
        target = BackendTarget("127.0.0.1", self.backend.server_address[1])
        fake = _FakeSupervisor(self.config, target)
        original = GatewayHTTPServer(
            ("127.0.0.1", 0),
            GatewayRequestHandler,
            fake,
        )
        address = original.server_address
        descriptor = original.listener_fd_for_exec()
        self.assertTrue(os.get_inheritable(descriptor))
        self.assertEqual(original.socket.detach(), descriptor)

        adopted = GatewayHTTPServer(
            address,
            GatewayRequestHandler,
            fake,
            inherited_socket_fd=descriptor,
        )
        self.assertFalse(os.get_inheritable(descriptor))
        thread = threading.Thread(target=adopted.serve_forever, daemon=True)
        thread.start()
        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{address[1]}/inherited",
                timeout=5,
            ) as response:
                self.assertEqual(json.load(response)["path"], "/inherited")
        finally:
            adopted.shutdown()
            adopted.server_close()
            thread.join(timeout=5)

    def test_gateway_exec_command_recreates_the_same_public_configuration(self):
        command = _gateway_exec_argv(self.config, "service")
        self.assertEqual(command[:4], [sys.executable, "-m", "enterprise_agent_platform", "gateway"])
        self.assertIn(str(self.config.data_dir), command)
        self.assertEqual(command[-2:], ["--mode", "service"])

    def test_gateway_drain_waits_for_mutating_request_count(self):
        path = gateway_state_path(self.data_dir)
        state = {
            "schema_version": 1,
            "pid": os.getpid(),
            "heartbeat_at": time.time(),
            "generation": 3,
            "active_mutating_requests": 1,
        }
        _atomic_json_write(path, state)

        def release():
            time.sleep(0.1)
            _atomic_json_write(
                path,
                {
                    **state,
                    "heartbeat_at": time.time(),
                    "active_mutating_requests": 0,
                },
            )

        thread = threading.Thread(target=release)
        thread.start()
        try:
            self.assertTrue(wait_for_gateway_drain(self.data_dir, timeout=2))
        finally:
            thread.join(timeout=2)

    def test_supervisor_keeps_public_listener_during_backend_reload(self):
        script_template = textwrap.dedent(
            """
            import json, os
            from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
            class Handler(BaseHTTPRequestHandler):
                def log_message(self, fmt, *args):
                    return
                def do_GET(self):
                    if self.path == "/healthz":
                        payload = {"status": "ok", "service": "ubitech-agent-platform"}
                    else:
                        payload = {"backend": PORT, "pid": os.getpid(), "path": self.path}
                    body = json.dumps(payload).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
            ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
            """
        )

        def command(target: BackendTarget):
            return [
                sys.executable,
                "-c",
                f"PORT={target.port}\n{script_template}",
            ]

        supervisor = GatewaySupervisor(
            self.config,
            mode="foreground",
            backend_command=command,
        )
        thread = threading.Thread(target=supervisor.run)
        thread.start()
        try:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                state = read_gateway_state(self.data_dir)
                if state and state.get("backend_ready"):
                    break
                time.sleep(0.05)
            else:
                self.fail("gateway backend did not become ready")
            public_port = supervisor._server.server_address[1]
            public_url = f"http://127.0.0.1:{public_port}"
            with urllib.request.urlopen(public_url + "/before", timeout=5) as response:
                before = json.load(response)

            mark_updating(
                self.data_dir,
                update_id="reload-1",
                instance_id="old",
                reason="test",
                target_revision="new",
                remote="origin",
                branch="main",
            )
            supervisor.request_reload()
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                state = read_gateway_state(self.data_dir)
                if state and state.get("backend_ready") and int(state.get("generation") or 0) >= 2:
                    break
                time.sleep(0.05)
            else:
                self.fail("gateway did not activate the replacement backend")

            with self.assertRaises(urllib.error.HTTPError) as maintenance:
                urllib.request.urlopen(public_url + "/during", timeout=5)
            self.assertEqual(maintenance.exception.code, 503)
            mark_success(self.data_dir, update_id="reload-1")
            with urllib.request.urlopen(public_url + "/after", timeout=5) as response:
                after = json.load(response)
            self.assertEqual(after["path"], "/after")
            self.assertNotEqual(before["pid"], after["pid"])
        finally:
            supervisor.request_stop()
            thread.join(timeout=10)
            self.assertFalse(thread.is_alive())


if __name__ == "__main__":
    unittest.main()
