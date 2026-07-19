from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
import re
import secrets
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

from .config import PlatformConfig
from .secure_fs import ensure_private_directory
from .update_state import (
    BLOCKING_UPDATE_STATES,
    read_public,
    read_state,
    update_state_lock,
)


GATEWAY_STATE_FILENAME = "gateway-state.json"
GATEWAY_STATE_SCHEMA_VERSION = 1
GATEWAY_HEARTBEAT_SECONDS = 2.0
BACKEND_START_TIMEOUT_SECONDS = 90.0
BACKEND_STOP_TIMEOUT_SECONDS = 120.0
GATEWAY_REEXEC_DRAIN_SECONDS = 10.0
GATEWAY_HANDLER_DRAIN_SECONDS = 3.0
PROXY_BUFFER_BYTES = 64 * 1024
MAX_PROXY_BODY_BYTES = 60 * 1024 * 1024
GATEWAY_LISTEN_FD_ENV = "ENTERPRISE_GATEWAY_LISTEN_FD"
GATEWAY_GENERATION_ENV = "ENTERPRISE_GATEWAY_GENERATION"
GATEWAY_EXEC_GENERATION_ENV = "ENTERPRISE_GATEWAY_EXEC_GENERATION"
GATEWAY_INSTANCE_ID_ENV = "ENTERPRISE_GATEWAY_INSTANCE_ID"
CONTENT_LENGTH_PATTERN = re.compile(r"^[0-9]+$")
try:
    LOADED_GATEWAY_CODE_SIGNATURE = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
except OSError:
    LOADED_GATEWAY_CODE_SIGNATURE = ""
HOP_BY_HOP_HEADERS = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    }
)


def gateway_state_path(data_dir: Path | str) -> Path:
    return Path(data_dir).expanduser().resolve() / GATEWAY_STATE_FILENAME


def read_gateway_state(data_dir: Path | str) -> dict[str, Any] | None:
    path = gateway_state_path(data_dir)
    try:
        if path.is_symlink() or path.stat().st_size > 64 * 1024:
            return None
        value = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict) or value.get("schema_version") != GATEWAY_STATE_SCHEMA_VERSION:
        return None
    return value


def gateway_process_is_live(state: dict[str, Any] | None, *, max_heartbeat_age: float = 15.0) -> bool:
    if not state:
        return False
    try:
        pid = int(state.get("pid") or 0)
        heartbeat_at = float(state.get("heartbeat_at") or 0)
    except (TypeError, ValueError):
        return False
    if pid <= 1 or heartbeat_at <= 0 or time.time() - heartbeat_at > max_heartbeat_age:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def request_gateway_reload(data_dir: Path | str) -> int:
    state = read_gateway_state(data_dir)
    if not gateway_process_is_live(state):
        raise RuntimeError("the platform gateway is not running")
    pid = int((state or {}).get("pid") or 0)
    os.kill(pid, signal.SIGHUP)
    return int((state or {}).get("generation") or 0)


@dataclass(frozen=True)
class BackendTarget:
    host: str
    port: int


@dataclass(frozen=True)
class BusinessRequestAdmission:
    target: BackendTarget
    mutating: bool


class RequestFramingError(ValueError):
    def __init__(self, message: str, *, status: HTTPStatus = HTTPStatus.BAD_REQUEST):
        super().__init__(message)
        self.status = status


class GatewaySupervisor:
    def __init__(
        self,
        config: PlatformConfig,
        *,
        mode: str,
        backend_command: list[str] | Callable[[BackendTarget], list[str]] | None = None,
        inherited_listener_fd: int | None = None,
        initial_generation: int = 0,
        exec_generation: int = 0,
        gateway_instance_id: str = "",
    ):
        self.config = config
        self.mode = mode
        self.gateway_instance_id = gateway_instance_id or secrets.token_urlsafe(18)
        self.backend_command = backend_command
        self.inherited_listener_fd = inherited_listener_fd
        self._lock = threading.RLock()
        self._business_condition = threading.Condition(self._lock)
        self._state_write_lock = threading.Lock()
        self._reload_event = threading.Event()
        self._stop_event = threading.Event()
        self._backend: subprocess.Popen[bytes] | None = None
        self._target: BackendTarget | None = None
        self._backend_ready = False
        self._backend_error = ""
        self._generation = max(0, int(initial_generation))
        self._exec_generation = max(0, int(exec_generation))
        self._accept_business_requests = True
        self._active_business_requests = 0
        self._active_mutating_requests = 0
        self._server: GatewayHTTPServer | None = None

    def public_update_status(self) -> dict[str, Any]:
        stored = read_state(self.config.data_dir)
        with self._lock:
            ready = self._backend_ready
            error = self._backend_error
            accepting = self._accept_business_requests
            instance_id = f"{self.gateway_instance_id}:{self._generation}"
        public = read_public(self.config.data_dir, instance_id=instance_id)
        if stored is None and (not ready or not accepting):
            public["state"] = "failed" if error else "updating"
        return public

    def blocks_product_use(self) -> bool:
        stored = read_state(self.config.data_dir)
        if str((stored or {}).get("state") or "") in BLOCKING_UPDATE_STATES:
            return True
        with self._lock:
            return not self._backend_ready or not self._accept_business_requests

    def backend_target(self) -> BackendTarget | None:
        with self._lock:
            return self._target if self._backend_ready else None

    def admit_business_request(self, method: str) -> BusinessRequestAdmission | None:
        mutating = method.upper() in {"POST", "PUT", "PATCH", "DELETE"}
        # The marker transition and gateway admission use the same cross-process
        # lock. The counter is durably published before that lock is released,
        # so deploy.sh cannot observe a blocking marker plus a stale zero count.
        with update_state_lock(self.config.data_dir):
            with self._lock:
                stored = read_state(self.config.data_dir)
                if (
                    not self._accept_business_requests
                    or str((stored or {}).get("state") or "") in BLOCKING_UPDATE_STATES
                    or not self._backend_ready
                    or self._target is None
                ):
                    return None
                admission = BusinessRequestAdmission(self._target, mutating)
                self._active_business_requests += 1
                if mutating:
                    self._active_mutating_requests += 1
                self._write_state()
                return admission

    def end_business_request(self, admission: BusinessRequestAdmission) -> None:
        with update_state_lock(self.config.data_dir):
            with self._business_condition:
                self._active_business_requests = max(0, self._active_business_requests - 1)
                if admission.mutating:
                    self._active_mutating_requests = max(0, self._active_mutating_requests - 1)
                self._write_state()
                self._business_condition.notify_all()

    def request_reload(self) -> None:
        self._reload_event.set()

    def request_stop(self) -> None:
        self._stop_event.set()
        self._reload_event.set()
        if self._server is not None:
            threading.Thread(target=self._server.shutdown, daemon=True).start()

    def run(self) -> None:
        ensure_private_directory(self.config.data_dir)
        server = GatewayHTTPServer(
            (self.config.host, self.config.port),
            GatewayRequestHandler,
            self,
            inherited_socket_fd=self.inherited_listener_fd,
        )
        self._server = server
        thread = threading.Thread(target=server.serve_forever, name="platform-gateway-http", daemon=True)
        thread.start()
        self._write_state()
        self._restart_backend()
        try:
            while not self._stop_event.wait(GATEWAY_HEARTBEAT_SECONDS):
                if self._reload_event.is_set():
                    self._reload_event.clear()
                    if not self._stop_event.is_set():
                        if self.backend_command is None:
                            self._reexec_gateway(server, thread)
                        else:
                            # Injectable backends are used by focused tests and
                            # local embedders; their callable cannot survive an
                            # exec boundary, so retain the legacy backend-only
                            # reload for that explicitly custom mode.
                            self._restart_backend()
                elif self._backend_exited():
                    self._restart_backend()
                self._write_state()
        finally:
            server.shutdown()
            thread.join(timeout=10)
            server.server_close()
            self._stop_backend()
            self._remove_state()

    def _reexec_gateway(
        self,
        server: "GatewayHTTPServer",
        server_thread: threading.Thread,
    ) -> None:
        with update_state_lock(self.config.data_dir):
            with self._lock:
                self._accept_business_requests = False
                self._write_state()

        deadline = time.monotonic() + GATEWAY_REEXEC_DRAIN_SECONDS
        with self._business_condition:
            while self._active_business_requests > 0 and time.monotonic() < deadline:
                self._business_condition.wait(timeout=max(0.0, deadline - time.monotonic()))

        # A long-lived read (for example SSE) must not keep old Python code
        # resident indefinitely. Stopping the backend releases those proxy
        # handlers; writes have already been drained before the source update.
        self._stop_backend()
        self._write_state()
        server.shutdown()
        server_thread.join(timeout=GATEWAY_HANDLER_DRAIN_SECONDS)
        if not server.wait_for_request_handlers(GATEWAY_HANDLER_DRAIN_SECONDS):
            server.close_active_requests()
            server.wait_for_request_handlers(1.0)

        listener_fd = server.listener_fd_for_exec()
        env = os.environ.copy()
        env.update(
            {
                GATEWAY_LISTEN_FD_ENV: str(listener_fd),
                GATEWAY_GENERATION_ENV: str(self._generation),
                GATEWAY_EXEC_GENERATION_ENV: str(self._exec_generation + 1),
                GATEWAY_INSTANCE_ID_ENV: self.gateway_instance_id,
            }
        )
        argv = _gateway_exec_argv(self.config, self.mode)
        try:
            os.execve(sys.executable, argv, env)
        except BaseException:
            os.set_inheritable(listener_fd, False)
            raise

    def _backend_exited(self) -> bool:
        with self._lock:
            backend = self._backend
        return backend is None or backend.poll() is not None

    def _restart_backend(self) -> None:
        with self._lock:
            self._backend_ready = False
            self._target = None
            self._backend_error = ""
        self._write_state()
        self._stop_backend()
        if self._stop_event.is_set():
            return
        target = BackendTarget("127.0.0.1", _reserve_loopback_port())
        if callable(self.backend_command):
            command = self.backend_command(target)
        else:
            command = self.backend_command or self._default_backend_command(target)
        env = os.environ.copy()
        env.update(
            {
                "ENTERPRISE_GATEWAY_ACTIVE": "1",
                "ENTERPRISE_DEPLOY_MODE": self.mode,
                # The backend only accepts traffic from this platform-owned
                # gateway. Forwarded headers are rebuilt below and are therefore
                # safe for the existing origin/client-address logic to consume.
                "ENTERPRISE_TRUSTED_PROXY": "1",
            }
        )
        try:
            backend = subprocess.Popen(
                command,
                cwd=str(Path(__file__).resolve().parents[1]),
                env=env,
                stdin=subprocess.DEVNULL,
            )
        except OSError as exc:
            with self._lock:
                self._backend_error = str(exc)
            self._write_state()
            return
        with self._lock:
            self._backend = backend
        if self._wait_for_backend(target, backend):
            with self._lock:
                self._target = target
                self._backend_ready = True
                self._backend_error = ""
                self._generation += 1
        else:
            returncode = backend.poll()
            with self._lock:
                self._backend_error = (
                    f"backend exited with code {returncode}"
                    if returncode is not None
                    else "backend readiness timed out"
                )
            self._stop_backend()
        self._write_state()

    def _default_backend_command(self, target: BackendTarget) -> list[str]:
        return [
            sys.executable,
            "-m",
            "enterprise_agent_platform",
            "serve",
            "--host",
            self.config.host,
            "--port",
            str(self.config.port),
            "--listen-host",
            target.host,
            "--listen-port",
            str(target.port),
            "--data",
            str(self.config.data_dir),
        ]

    def _wait_for_backend(self, target: BackendTarget, backend: subprocess.Popen[bytes]) -> bool:
        deadline = time.monotonic() + BACKEND_START_TIMEOUT_SECONDS
        next_heartbeat = time.monotonic()
        while not self._stop_event.is_set() and time.monotonic() < deadline:
            if time.monotonic() >= next_heartbeat:
                self._write_state()
                next_heartbeat = time.monotonic() + GATEWAY_HEARTBEAT_SECONDS
            if backend.poll() is not None:
                return False
            try:
                connection = http.client.HTTPConnection(target.host, target.port, timeout=1.0)
                connection.request("GET", "/healthz", headers={"Connection": "close"})
                response = connection.getresponse()
                body = response.read(16 * 1024)
                connection.close()
                value = json.loads(body)
                if (
                    response.status == HTTPStatus.OK
                    and value.get("status") == "ok"
                    and value.get("service") == "ubitech-agent-platform"
                ):
                    return True
            except (OSError, http.client.HTTPException, json.JSONDecodeError, AttributeError):
                pass
            time.sleep(0.25)
        return False

    def _stop_backend(self) -> None:
        with self._lock:
            backend = self._backend
            self._backend = None
            self._backend_ready = False
            self._target = None
        if backend is None or backend.poll() is not None:
            return
        backend.terminate()
        deadline = time.monotonic() + BACKEND_STOP_TIMEOUT_SECONDS
        while backend.poll() is None and time.monotonic() < deadline:
            try:
                backend.wait(timeout=min(GATEWAY_HEARTBEAT_SECONDS, max(0.1, deadline - time.monotonic())))
            except subprocess.TimeoutExpired:
                self._write_state()
        if backend.poll() is None:
            backend.kill()
            backend.wait(timeout=10)

    def _write_state(self) -> None:
        # All state changes take _lock before the writer lock. Keeping this
        # order avoids a lock inversion with admission, which must publish its
        # counter while holding _lock and the cross-process update-state lock.
        with self._lock:
            with self._state_write_lock:
                backend = self._backend
                target = self._target
                value = {
                    "schema_version": GATEWAY_STATE_SCHEMA_VERSION,
                    "pid": os.getpid(),
                    "mode": self.mode,
                    "gateway_instance_id": self.gateway_instance_id,
                    "generation": self._generation,
                    "exec_generation": self._exec_generation,
                    "code_signature": gateway_code_signature(),
                    "backend_pid": backend.pid if backend is not None and backend.poll() is None else 0,
                    "backend_host": target.host if target is not None else "",
                    "backend_port": target.port if target is not None else 0,
                    "backend_ready": self._backend_ready,
                    "backend_error": self._backend_error[:500],
                    "accepting_business_requests": self._accept_business_requests,
                    "active_business_requests": self._active_business_requests,
                    "active_mutating_requests": self._active_mutating_requests,
                    "heartbeat_at": time.time(),
                }
                _atomic_json_write(gateway_state_path(self.config.data_dir), value)

    def _remove_state(self) -> None:
        path = gateway_state_path(self.config.data_dir)
        current = read_gateway_state(self.config.data_dir)
        if int((current or {}).get("pid") or 0) != os.getpid():
            return
        try:
            path.unlink()
        except FileNotFoundError:
            pass


class GatewayHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 128
    allow_reuse_address = True

    def __init__(
        self,
        server_address,
        handler,
        supervisor: GatewaySupervisor,
        *,
        inherited_socket_fd: int | None = None,
    ):
        self._request_condition = threading.Condition()
        self._active_requests: set[socket.socket] = set()
        if inherited_socket_fd is None:
            super().__init__(server_address, handler)
        else:
            if inherited_socket_fd < 3:
                raise ValueError("inherited gateway listener descriptor is invalid")
            super().__init__(server_address, handler, bind_and_activate=False)
            self.socket.close()
            inherited = socket.socket(fileno=inherited_socket_fd)
            try:
                if inherited.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) != 1:
                    raise ValueError("inherited gateway descriptor is not a listening socket")
                actual_address = inherited.getsockname()
            except BaseException:
                inherited.close()
                raise
            self.socket = inherited
            self.server_address = actual_address
            self.server_name = socket.getfqdn(str(actual_address[0]))
            self.server_port = int(actual_address[1])
            # Backend children must never inherit the public listener.
            os.set_inheritable(inherited_socket_fd, False)
        self.supervisor = supervisor

    def process_request(self, request: socket.socket, client_address) -> None:
        with self._request_condition:
            self._active_requests.add(request)
        try:
            super().process_request(request, client_address)
        except BaseException:
            with self._request_condition:
                self._active_requests.discard(request)
                self._request_condition.notify_all()
            raise

    def process_request_thread(self, request: socket.socket, client_address) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            with self._request_condition:
                self._active_requests.discard(request)
                self._request_condition.notify_all()

    def wait_for_request_handlers(self, timeout: float) -> bool:
        deadline = time.monotonic() + max(0.0, timeout)
        with self._request_condition:
            while self._active_requests and time.monotonic() < deadline:
                self._request_condition.wait(timeout=max(0.0, deadline - time.monotonic()))
            return not self._active_requests

    def close_active_requests(self) -> None:
        with self._request_condition:
            requests = tuple(self._active_requests)
        for request in requests:
            try:
                request.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                request.close()
            except OSError:
                pass

    def listener_fd_for_exec(self) -> int:
        descriptor = self.socket.fileno()
        if descriptor < 3:
            raise RuntimeError("gateway listener is unavailable for exec")
        os.set_inheritable(descriptor, True)
        return descriptor


class GatewayRequestHandler(BaseHTTPRequestHandler):
    server: GatewayHTTPServer
    protocol_version = "HTTP/1.1"
    timeout = 180

    def log_message(self, fmt: str, *args: Any) -> None:
        return

    def do_GET(self) -> None:
        self._dispatch()

    def do_POST(self) -> None:
        self._dispatch()

    def do_PUT(self) -> None:
        self._dispatch()

    def do_PATCH(self) -> None:
        self._dispatch()

    def do_DELETE(self) -> None:
        self._dispatch()

    def do_OPTIONS(self) -> None:
        self._dispatch()

    def _dispatch(self) -> None:
        path = urllib.parse.urlsplit(self.path).path
        if path == "/healthz":
            if self.command != "GET":
                self._json({"error": "method not allowed"}, status=HTTPStatus.METHOD_NOT_ALLOWED)
                return
            self._json({"status": "ok", "service": "ubitech-agent-platform"})
            return
        if path == "/api/platform/update-status":
            if self.command != "GET":
                self._json({"error": "method not allowed"}, status=HTTPStatus.METHOD_NOT_ALLOWED)
                return
            target = self.server.supervisor.backend_target()
            if not self.server.supervisor.blocks_product_use() and target is not None:
                self._proxy(target)
            else:
                self._json(self.server.supervisor.public_update_status())
            return
        admission = self.server.supervisor.admit_business_request(self.command)
        if admission is None:
            self._maintenance(path)
            return
        try:
            self._proxy(admission.target)
        finally:
            self.server.supervisor.end_business_request(admission)

    def _maintenance(self, path: str) -> None:
        if path.startswith("/api/") or path.startswith("/internal/"):
            self._json(
                {
                    "error": "platform is temporarily unavailable while an update is applied",
                    "code": "platform_updating",
                },
                status=HTTPStatus.SERVICE_UNAVAILABLE,
                retry_after=2,
            )
            return
        body = _maintenance_html(self.server.supervisor.public_update_status()).encode("utf-8")
        self.send_response(HTTPStatus.SERVICE_UNAVAILABLE)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Retry-After", "2")
        self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'self'")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def _proxy(self, target: BackendTarget) -> None:
        try:
            framing, content_length = _request_framing(self.headers)
            if framing == "chunked":
                body = self._read_chunked_body()
            elif content_length:
                body = self.rfile.read(content_length)
                if len(body) != content_length:
                    raise RequestFramingError("incomplete request body")
            else:
                body = None
        except RequestFramingError as exc:
            self.close_connection = True
            self._json({"error": str(exc)}, status=exc.status)
            return
        headers = {
            key: value
            for key, value in self.headers.items()
            if key.lower() not in HOP_BY_HOP_HEADERS and key.lower() not in {"content-length", "expect"}
        }
        if body is not None:
            headers["Content-Length"] = str(len(body))
        peer = str(self.client_address[0])
        trusted_upstream = self.server.supervisor.config.trust_forwarded_headers
        incoming_for = self.headers.get("X-Forwarded-For", "").strip() if trusted_upstream else ""
        headers["X-Forwarded-For"] = f"{incoming_for}, {peer}" if incoming_for else peer
        if trusted_upstream:
            forwarded_proto = self.headers.get("X-Forwarded-Proto", "").strip()
            forwarded_host = self.headers.get("X-Forwarded-Host", "").strip()
        else:
            forwarded_proto = ""
            forwarded_host = ""
        headers["X-Forwarded-Proto"] = forwarded_proto or urllib.parse.urlsplit(
            self.server.supervisor.config.public_base_url
        ).scheme or "http"
        headers["X-Forwarded-Host"] = forwarded_host or self.headers.get("Host", "")
        headers["Connection"] = "close"
        connection = http.client.HTTPConnection(target.host, target.port, timeout=self.timeout)
        response_started = False
        try:
            connection.request(self.command, self.path, body=body, headers=headers)
            response = connection.getresponse()
            response_headers = response.getheaders()
            response_transfer_encoding = any(
                key.lower() == "transfer-encoding" for key, _value in response_headers
            )
            response_lengths = _validated_content_lengths(
                response_headers,
                maximum=None,
                error_type=http.client.HTTPException,
            )
            self.send_response(response.status, response.reason)
            response_started = True
            has_length = False
            for key, value in response_headers:
                lower = key.lower()
                if lower in HOP_BY_HOP_HEADERS:
                    continue
                if lower == "content-length":
                    if response_transfer_encoding or has_length:
                        continue
                    has_length = True
                    self.send_header(key, str(response_lengths or 0))
                    continue
                self.send_header(key, value)
            if not has_length:
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()
            reader = getattr(response, "read1", response.read)
            while True:
                chunk = reader(PROXY_BUFFER_BYTES)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except (OSError, http.client.HTTPException):
            if not response_started and not self.wfile.closed:
                try:
                    self._json(
                        {"error": "platform backend unavailable", "code": "platform_updating"},
                        status=HTTPStatus.SERVICE_UNAVAILABLE,
                        retry_after=2,
                    )
                except (BrokenPipeError, ConnectionResetError):
                    pass
            else:
                self.close_connection = True
        finally:
            connection.close()

    def _read_chunked_body(self) -> bytes:
        chunks: list[bytes] = []
        total = 0
        while True:
            line = self.rfile.readline(129)
            if not line or len(line) > 128 or not line.endswith(b"\r\n"):
                raise RequestFramingError("invalid chunked request body")
            size_text = line[:-2].split(b";", 1)[0].strip()
            if not size_text:
                raise RequestFramingError("invalid chunked request body")
            try:
                size = int(size_text, 16)
            except ValueError as exc:
                raise RequestFramingError("invalid chunked request body") from exc
            if size < 0:
                raise RequestFramingError("invalid chunked request body")
            if total + size > MAX_PROXY_BODY_BYTES:
                raise RequestFramingError(
                    "request body too large",
                    status=HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                )
            if size == 0:
                trailer_bytes = 0
                while True:
                    trailer = self.rfile.readline(8193)
                    trailer_bytes += len(trailer)
                    if not trailer or not trailer.endswith(b"\r\n"):
                        raise RequestFramingError("invalid chunked request trailers")
                    if trailer == b"\r\n" or trailer_bytes > 64 * 1024:
                        break
                if trailer_bytes > 64 * 1024:
                    raise RequestFramingError("chunked request trailers are too large")
                return b"".join(chunks)
            chunk = self.rfile.read(size)
            if len(chunk) != size or self.rfile.read(2) != b"\r\n":
                raise RequestFramingError("invalid chunked request body")
            chunks.append(chunk)
            total += size

    def _json(
        self,
        payload: dict[str, Any],
        *,
        status: int | HTTPStatus = HTTPStatus.OK,
        retry_after: int | None = None,
    ) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(int(status))
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if retry_after is not None:
            self.send_header("Retry-After", str(retry_after))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True


def _header_values(headers: Any, name: str) -> list[str]:
    getter = getattr(headers, "get_all", None)
    if callable(getter):
        return [str(value) for value in (getter(name) or [])]
    return [
        str(value)
        for key, value in headers
        if str(key).lower() == name.lower()
    ]


def _validated_content_lengths(
    headers: Any,
    *,
    maximum: int | None,
    error_type: type[Exception] = RequestFramingError,
) -> int | None:
    raw_values = _header_values(headers, "Content-Length")
    if not raw_values:
        return None
    tokens: list[str] = []
    for value in raw_values:
        tokens.extend(part.strip() for part in value.split(","))
    if not tokens or any(not CONTENT_LENGTH_PATTERN.fullmatch(token) for token in tokens):
        raise error_type("invalid content length")
    try:
        lengths = [int(token, 10) for token in tokens]
    except (ValueError, OverflowError) as exc:
        raise error_type("invalid content length") from exc
    if len(set(lengths)) != 1:
        raise error_type("conflicting content lengths")
    length = lengths[0]
    if maximum is not None and length > maximum:
        if error_type is RequestFramingError:
            raise RequestFramingError(
                "request body too large",
                status=HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
            )
        raise error_type("content length exceeds the proxy limit")
    return length


def _request_framing(headers: Any) -> tuple[str, int]:
    transfer_values = _header_values(headers, "Transfer-Encoding")
    content_length = _validated_content_lengths(
        headers,
        maximum=MAX_PROXY_BODY_BYTES,
    )
    if transfer_values and content_length is not None:
        raise RequestFramingError("ambiguous request framing")
    if transfer_values:
        tokens: list[str] = []
        for value in transfer_values:
            tokens.extend(part.strip().lower() for part in value.split(","))
        if tokens != ["chunked"]:
            raise RequestFramingError("unsupported transfer encoding")
        return "chunked", 0
    return "content-length", content_length or 0


def run_gateway(config: PlatformConfig, *, mode: str = "foreground") -> None:
    inherited_listener_fd = _environment_int(GATEWAY_LISTEN_FD_ENV, minimum=3)
    initial_generation = _environment_int(GATEWAY_GENERATION_ENV, minimum=0) or 0
    exec_generation = _environment_int(GATEWAY_EXEC_GENERATION_ENV, minimum=0) or 0
    inherited_instance_id = os.getenv(GATEWAY_INSTANCE_ID_ENV, "").strip()[:160]
    # Do not leak handoff metadata into backend children. The adopted socket is
    # marked close-on-exec by GatewayHTTPServer until the next gateway handoff.
    for name in (
        GATEWAY_LISTEN_FD_ENV,
        GATEWAY_GENERATION_ENV,
        GATEWAY_EXEC_GENERATION_ENV,
        GATEWAY_INSTANCE_ID_ENV,
    ):
        os.environ.pop(name, None)
    supervisor = GatewaySupervisor(
        config,
        mode=mode,
        inherited_listener_fd=inherited_listener_fd,
        initial_generation=initial_generation,
        exec_generation=exec_generation,
        gateway_instance_id=inherited_instance_id,
    )

    def stop(_signum, _frame) -> None:
        supervisor.request_stop()

    def reload_backend(_signum, _frame) -> None:
        supervisor.request_reload()

    previous: dict[int, Any] = {}
    for signum, handler in (
        (signal.SIGINT, stop),
        (signal.SIGTERM, stop),
        (signal.SIGHUP, reload_backend),
    ):
        try:
            previous[signum] = signal.getsignal(signum)
            signal.signal(signum, handler)
        except (OSError, ValueError):
            pass
    try:
        supervisor.run()
    finally:
        for signum, handler in previous.items():
            try:
                signal.signal(signum, handler)
            except (OSError, ValueError):
                pass


def wait_for_gateway_drain(data_dir: Path | str, *, timeout: float = 60.0) -> bool:
    """Wait for writes admitted before maintenance to finish without killing them."""

    deadline = time.monotonic() + max(0.0, float(timeout))
    observed_gateway = False
    while True:
        # Admission publishes its mutating counter while holding this same
        # cross-process lock. Once the update marker is blocking, a zero read
        # here therefore cannot race with a newly admitted business request.
        with update_state_lock(data_dir):
            state = read_gateway_state(data_dir)
        if state is None:
            return not observed_gateway
        observed_gateway = True
        if not gateway_process_is_live(state):
            return False
        try:
            active = int(state.get("active_mutating_requests") or 0)
        except (TypeError, ValueError):
            return False
        if active <= 0:
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.25)


def gateway_code_signature() -> str:
    return LOADED_GATEWAY_CODE_SIGNATURE


def _environment_int(name: str, *, minimum: int) -> int | None:
    raw = os.getenv(name, "").strip()
    if not raw:
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError, OverflowError) as exc:
        raise RuntimeError(f"{name} is invalid") from exc
    if value < minimum:
        raise RuntimeError(f"{name} is invalid")
    return value


def _gateway_exec_argv(config: PlatformConfig, mode: str) -> list[str]:
    return [
        sys.executable,
        "-m",
        "enterprise_agent_platform",
        "gateway",
        "--host",
        config.host,
        "--port",
        str(config.port),
        "--data",
        str(config.data_dir),
        "--mode",
        mode,
    ]


def add_gateway_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--data", default=None)
    parser.add_argument("--mode", choices=("service", "foreground"), default="foreground")


def _reserve_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _atomic_json_write(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8")
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{time.time_ns()}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _maintenance_html(status: dict[str, Any]) -> str:
    failed = str(status.get("state") or "") == "failed"
    title_zh = "更新未完成" if failed else "正在更新 ubitech agent"
    detail_zh = "系统正在等待安全恢复，请稍后再试。" if failed else "服务暂时不可使用，更新完成后页面会自动恢复。"
    title_tw = "更新尚未完成" if failed else "ubitech agent 正在更新"
    detail_tw = "系統正在等待安全恢復，請稍後再試。" if failed else "服務暫時無法使用，更新完成後頁面會自動恢復。"
    title_en = "Update incomplete" if failed else "Updating ubitech agent"
    detail_en = (
        "The system is waiting for a safe recovery. Please try again later."
        if failed
        else "The service is temporarily unavailable and will return automatically."
    )
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>{title_zh}</title>
<style>
:root{{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark}}
*{{box-sizing:border-box}}body{{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:#f4f6fb;color:#172033}}
.card{{width:min(520px,100%);padding:42px 36px;border:1px solid #d9deea;border-radius:24px;background:rgba(255,255,255,.92);box-shadow:0 24px 70px rgba(24,36,65,.12);text-align:center}}
.mark{{width:54px;height:54px;margin:0 auto 24px;border:4px solid #d9e1fb;border-top-color:#6178d5;border-radius:50%;animation:spin 1.2s linear infinite}}
h1{{font-size:clamp(24px,5vw,32px);margin:0 0 14px}}p{{margin:0;color:#65708a;line-height:1.7}}.brand{{margin-top:28px;font-weight:700;letter-spacing:.02em}}
@keyframes spin{{to{{transform:rotate(360deg)}}}}@media(prefers-reduced-motion:reduce){{.mark{{animation:none}}}}
@media(prefers-color-scheme:dark){{body{{background:#0f1118;color:#f4f6fb}}.card{{background:#171b25;border-color:#2a3141;box-shadow:none}}p{{color:#aab3c5}}.mark{{border-color:#29324b;border-top-color:#8ea4ff}}}}
</style>
</head>
<body>
<main class="card" role="status" aria-live="polite">
<div class="mark" aria-hidden="true"></div>
<h1 id="title">{title_zh}</h1><p id="detail">{detail_zh}</p><div class="brand">ubitech agent</div>
</main>
<script>
const copy={{
 "zh-CN":{json.dumps([title_zh, detail_zh], ensure_ascii=False)},
 "zh-TW":{json.dumps([title_tw, detail_tw], ensure_ascii=False)},
 "en":{json.dumps([title_en, detail_en], ensure_ascii=False)}
}};
let locale="zh-CN";try{{const saved=localStorage.getItem("eap-locale");if(saved==="zh-TW"||saved==="en"||saved==="zh-CN")locale=saved;else if(navigator.language.toLowerCase().startsWith("zh-tw")||navigator.language.toLowerCase().startsWith("zh-hk"))locale="zh-TW";else if(!navigator.language.toLowerCase().startsWith("zh"))locale="en"}}catch{{}}
document.documentElement.lang=locale;document.getElementById("title").textContent=copy[locale][0];document.getElementById("detail").textContent=copy[locale][1];
async function check(){{try{{const r=await fetch("/api/platform/update-status",{{cache:"no-store"}});const s=await r.json();if(s.state==="idle"||s.state==="waiting_for_tasks"){{location.reload();return}}}}catch{{}}setTimeout(check,2000)}}setTimeout(check,1200);
</script>
</body>
</html>"""
