from __future__ import annotations

import json
import mimetypes
import os
import re
import shutil
import signal
import sys
import threading
import time
import traceback
import urllib.parse
from email import policy
from email.parser import BytesParser
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from .config import PlatformConfig
from .service import BOOTSTRAP_ADMIN_PASSWORD_FILE, EnterpriseService, ServiceError, UploadedFile, is_safe_inline_attachment_mime


COOKIE_NAME = "enterprise_session"
MAX_BODY_BYTES = 5 * 1024 * 1024
MAX_UPLOAD_BODY_BYTES = 55 * 1024 * 1024
# Only methods that are actually routed (none use PATCH today) need CSRF
# same-origin enforcement; a method with no do_<METHOD> handler can never reach
# the dispatcher, so listing it here would be dead.
UNSAFE_METHODS = {"POST", "PUT", "DELETE"}
# Server-sent events: how often the stream checks for scope changes, and the
# max lifetime of one connection before the browser's EventSource reconnects.
SSE_POLL_INTERVAL = 0.4
SSE_MAX_SECONDS = 120
# How often (seconds) an in-flight SSE stream re-validates the live session
# token so deactivation / revocation / password-reset promptly ends the stream
# instead of waiting for SSE_MAX_SECONDS or a client reconnect.
SSE_AUTH_RECHECK_SECONDS = 5.0
# Size of the buffer used when streaming file responses to the client so large
# attachments are not fully materialized in memory.
FILE_STREAM_CHUNK_BYTES = 64 * 1024


def _env_int(name: str, default: int, *, minimum: int = 1) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(minimum, value)


# Admission control: cap concurrent worker threads (and therefore the per-thread
# SQLite connections / file descriptors they hold) and cap concurrent long-lived
# SSE streams both globally and per user, so a scripted client cannot exhaust
# server resources. Tunable via environment with safe defaults.
MAX_CONCURRENT_REQUESTS = _env_int("ENTERPRISE_MAX_CONCURRENT_REQUESTS", 64)
MAX_CONCURRENT_SSE_STREAMS = _env_int("ENTERPRISE_MAX_SSE_STREAMS", 256)
MAX_SSE_STREAMS_PER_USER = _env_int("ENTERPRISE_MAX_SSE_STREAMS_PER_USER", 4)


class EnterpriseHTTPServer(ThreadingHTTPServer):
    # Streaming/SSE worker threads must not keep the process alive on shutdown,
    # and a slightly larger accept backlog smooths bursts of new connections.
    daemon_threads = True
    request_queue_size = 128

    def __init__(self, server_address, RequestHandlerClass, service: EnterpriseService):
        super().__init__(server_address, RequestHandlerClass)
        self.service = service
        # Bounded admission control across all worker threads.
        self._request_slots = threading.BoundedSemaphore(MAX_CONCURRENT_REQUESTS)
        # Per-worker-thread guard so a long-lived SSE stream can hand its general
        # request slot back early (and finish_request won't double-release it).
        self._local = threading.local()
        # Concurrent SSE stream accounting (global + per-user) guarded by a lock.
        self._sse_lock = threading.Lock()
        self._sse_total = 0
        self._sse_per_user: dict[Any, int] = {}

    def process_request(self, request, client_address) -> None:
        # Block new worker threads once the concurrency cap is reached rather
        # than spawning an unbounded number of threads. The slot is released in
        # finish_request below (which runs on the worker thread).
        self._request_slots.acquire()
        try:
            super().process_request(request, client_address)
        except BaseException:
            # super().process_request normally hands the slot off to the worker
            # thread; if it failed to start one, release the slot here so it is
            # not leaked.
            self._request_slots.release()
            raise

    def finish_request(self, request, client_address) -> None:
        self._local.slot_released = False
        try:
            super().finish_request(request, client_address)
        finally:
            # A long-lived SSE stream may have already handed its general request
            # slot back via release_request_slot_once(); only release here if it
            # has not, so the BoundedSemaphore is never over-released.
            if not getattr(self._local, "slot_released", False):
                self._request_slots.release()
            self._local.slot_released = False

    def release_request_slot_once(self) -> None:
        """Release the current worker's general request slot ahead of finish_request.

        Long-lived SSE streams call this once they are admitted (and bounded by
        the separate SSE caps) so they do not pin one of the limited general
        request slots for their entire lifetime — which would let a handful of
        open streams starve all new connections. Idempotent per request."""
        if getattr(self._local, "slot_released", False):
            return
        self._local.slot_released = True
        self._request_slots.release()

    def acquire_sse_slot(self, user_key: Any) -> bool:
        """Reserve a slot for one SSE stream; False if a cap is exceeded."""
        with self._sse_lock:
            if self._sse_total >= MAX_CONCURRENT_SSE_STREAMS:
                return False
            if self._sse_per_user.get(user_key, 0) >= MAX_SSE_STREAMS_PER_USER:
                return False
            self._sse_total += 1
            self._sse_per_user[user_key] = self._sse_per_user.get(user_key, 0) + 1
            return True

    def release_sse_slot(self, user_key: Any) -> None:
        with self._sse_lock:
            self._sse_total = max(0, self._sse_total - 1)
            remaining = self._sse_per_user.get(user_key, 0) - 1
            if remaining > 0:
                self._sse_per_user[user_key] = remaining
            else:
                self._sse_per_user.pop(user_key, None)


class RequestHandler(BaseHTTPRequestHandler):
    server: EnterpriseHTTPServer
    # Bound how long a single connection may stall mid-request so a slow or
    # stuck client cannot hold a worker thread (and its DB connection) forever.
    timeout = 60

    def log_message(self, fmt: str, *args: Any) -> None:
        return

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_PUT(self) -> None:
        self._dispatch("PUT")

    def do_DELETE(self) -> None:
        self._dispatch("DELETE")

    def do_OPTIONS(self) -> None:
        # Same-origin SPA: no CORS preflight is required, but answer cleanly with
        # an Allow advertisement and the standard security headers instead of the
        # stdlib's bare HTML 501 page.
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Allow", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self._send_security_headers()
        self.end_headers()

    def send_error(self, code, message=None, explain=None):
        # Route built-in error responses (e.g. 501 for an unimplemented method,
        # 414 URI-too-long) through the JSON helper so they carry the same JSON
        # envelope, Cache-Control: no-store, and security headers as every other
        # response instead of the stdlib's default text/html error page.
        try:
            status = int(getattr(code, "value", code))
        except (TypeError, ValueError):
            return super().send_error(code, message, explain)
        try:
            text = message if isinstance(message, str) and message else "error"
            self._json({"error": text}, status=status)
        except Exception:
            return super().send_error(code, message, explain)

    def _dispatch(self, method: str) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        try:
            if path.startswith("/api/telegram/webhook/"):
                self._handle_telegram_webhook(method, path)
                return
            if path.startswith("/api/") and method in UNSAFE_METHODS:
                self._require_same_origin()
            if path.startswith("/api/agent/tools/"):
                self._handle_agent_tool(method, path, query)
                return
            if path.startswith("/api/"):
                self._handle_api(method, path, query)
                return
            if method != "GET":
                self._json({"error": "method not allowed"}, status=405)
                return
            self._serve_static(path)
        except ServiceError as exc:
            self._json({"error": exc.message}, status=exc.status)
        except Exception as exc:
            traceback.print_exception(type(exc), exc, exc.__traceback__, file=sys.stderr)
            self._json({"error": "internal server error"}, status=500)

    def _handle_telegram_webhook(self, method: str, path: str) -> None:
        if method != "POST":
            self._json({"error": "method not allowed"}, status=405)
            return
        if not self.server.service.telegram_enabled():
            raise ServiceError(404, "Telegram gateway is disabled")
        if not self.server.service.telegram_bot_token():
            raise ServiceError(503, "Telegram bot token is not configured")
        expected = self.server.service.telegram_webhook_secret()
        supplied = path.rsplit("/", 1)[-1]
        header_secret = self.headers.get("X-Telegram-Bot-Api-Secret-Token", "").strip()
        if not expected or (supplied != expected and header_secret != expected):
            raise ServiceError(403, "invalid Telegram webhook secret")
        body = self._body_json()
        self._json(self.server.service.telegram_gateway_update(body))

    def _handle_api(self, method: str, path: str, query: dict[str, list[str]]) -> None:
        service = self.server.service
        if path == "/api/auth/login" and method == "POST":
            body = self._body_json()
            token, user = service.authenticate(
                str(body.get("username", "")),
                str(body.get("password", "")),
                client_id=self._client_identity(),
            )
            self._json({"user": user}, headers={"Set-Cookie": self._session_cookie(token)})
            return
        if path == "/api/auth/logout" and method == "POST":
            self._json({"ok": True}, headers={"Set-Cookie": self._clear_cookie()})
            return

        actor = self._require_user()
        if path == "/api/auth/me" and method == "GET":
            self._json({"user": actor})
            return
        m = re.fullmatch(r"/api/attachments/(\d+)", path)
        if m and method == "GET":
            self._serve_attachment(actor, int(m.group(1)), download=first(query, "download", "") in {"1", "true", "yes"})
            return
        if path == "/api/mention-targets" and method == "GET":
            self._json({"targets": service.mention_targets(actor)})
            return
        if path == "/api/users" and method == "GET":
            self._json({"users": service.list_users(actor)})
            return
        if path == "/api/permission-groups" and method == "GET":
            self._json({"permission_groups": service.list_permission_groups(actor)})
            return
        if path == "/api/users" and method == "POST":
            body = self._body_json()
            user = service.create_user(
                username=str(body.get("username", "")),
                password=str(body.get("password", "")),
                display_name=str(body.get("display_name", "")),
                role=str(body.get("role", "member")),
                position=str(body.get("position", "")),
                permission_group=str(body.get("permission_group", "")) or None,
                model_name=str(body.get("model_name", body.get("model", ""))),
                thinking_depth=str(body.get("thinking_depth", "medium")),
                actor=actor,
            )
            self._json({"user": user}, status=201)
            return
        m = re.fullmatch(r"/api/users/(\d+)", path)
        if m and method == "PUT":
            self._json({"user": service.update_user(actor, int(m.group(1)), self._body_json())})
            return
        if m and method == "DELETE":
            self._json({"user": service.deactivate_user(actor, int(m.group(1)))})
            return
        if path == "/api/channels" and method == "GET":
            self._json({"channels": service.list_channels(actor)})
            return
        if path == "/api/channels" and method == "POST":
            body = self._body_json()
            channel = service.create_channel(actor, str(body.get("name", "")), str(body.get("description", "")))
            self._json({"channel": channel}, status=201)
            return

        m = re.fullmatch(r"/api/channels/(\d+)/messages", path)
        if m and method == "GET":
            limit = int_arg(query, "limit", 100)
            self._json({
                "messages": service.list_messages(actor, "channel", m.group(1), limit=limit),
                "agent_status": service.agent_status(actor, "channel", m.group(1)),
                "typing": service.typing_users(actor, "channel", m.group(1)),
            })
            return
        if m and method == "POST":
            content, attachments = self._body_message()
            self._json(service.send_channel_message(actor, int(m.group(1)), content, attachments), status=201)
            return
        m = re.fullmatch(r"/api/channels/(\d+)/typing", path)
        if m and method == "POST":
            body = self._body_json()
            self._json(service.update_typing(actor, "channel", m.group(1), bool(body.get("typing"))))
            return
        m = re.fullmatch(r"/api/channels/(\d+)/agent-status", path)
        if m and method == "GET":
            self._json({"agent_status": service.agent_status(actor, "channel", m.group(1))})
            return
        m = re.fullmatch(r"/api/channels/(\d+)/events", path)
        if m and method == "GET":
            self._stream_scope_events(actor, "channel", m.group(1))
            return

        if path == "/api/private-agent/messages" and method == "GET":
            limit = int_arg(query, "limit", 100)
            self._json({
                "messages": service.list_messages(actor, "private", str(actor["id"]), limit=limit),
                "agent_status": service.agent_status(actor, "private", str(actor["id"])),
                "typing": [],
            })
            return
        if path == "/api/private-agent/messages" and method == "POST":
            content, attachments = self._body_message()
            self._json(service.send_private_message(actor, content, attachments), status=201)
            return
        if path == "/api/private-agent/agent-status" and method == "GET":
            self._json({"agent_status": service.agent_status(actor, "private", str(actor["id"]))})
            return
        if path == "/api/private-agent/events" and method == "GET":
            self._stream_scope_events(actor, "private", str(actor["id"]))
            return
        if path == "/api/private-agent/status" and method == "GET":
            self._json(service.private_status(actor))
            return
        if path == "/api/private-agent/telegram" and method == "GET":
            self._json(service.telegram_private_config(actor))
            return
        if path == "/api/private-agent/telegram" and method == "PUT":
            self._json(service.update_telegram_private_config(actor, self._body_json()))
            return
        if path == "/api/private-agent/telegram" and method == "DELETE":
            self._json(service.unlink_telegram_private_config(actor))
            return

        m = re.fullmatch(r"/api/admin/channels/(\d+)/messages/(\d+)", path)
        if m and method == "DELETE":
            self._json(service.delete_channel_message(actor, int(m.group(1)), int(m.group(2))))
            return
        m = re.fullmatch(r"/api/admin/channels/(\d+)/messages", path)
        if m and method == "GET":
            limit = int_arg(query, "limit", 200)
            self._json(service.audit_channel_messages(actor, int(m.group(1)), limit=limit))
            return
        if m and method == "DELETE":
            body = self._body_json()
            if body.get("clear_all"):
                self._json(service.clear_channel_messages(actor, int(m.group(1))))
                return
            before = body.get("before_created_at", first(query, "before_created_at", ""))
            self._json(service.delete_channel_messages_before(actor, int(m.group(1)), before))
            return
        if path == "/api/admin/private-agent/conversations" and method == "GET":
            self._json({"conversations": service.list_private_conversation_audits(actor)})
            return
        m = re.fullmatch(r"/api/admin/private-agent/conversations/(\d+)/messages/(\d+)", path)
        if m and method == "DELETE":
            self._json(service.delete_private_message(actor, int(m.group(1)), int(m.group(2))))
            return
        m = re.fullmatch(r"/api/admin/private-agent/conversations/(\d+)/messages", path)
        if m and method == "GET":
            limit = int_arg(query, "limit", 200)
            self._json(service.audit_private_messages(actor, int(m.group(1)), limit=limit))
            return
        if m and method == "DELETE":
            body = self._body_json()
            if body.get("clear_all"):
                self._json(service.clear_private_messages(actor, int(m.group(1))))
                return
            before = body.get("before_created_at", first(query, "before_created_at", ""))
            self._json(service.delete_private_messages_before(actor, int(m.group(1)), before))
            return
        if path == "/api/admin/token-usage" and method == "GET":
            self._json(service.token_usage_report(actor, days=int_arg(query, "days", 30), limit=int_arg(query, "limit", 200)))
            return

        if path == "/api/knowledge/documents" and method == "GET":
            self._json({"documents": service.list_knowledge_documents(actor)})
            return
        if path == "/api/knowledge/status" and method == "GET":
            self._json(service.knowledge_status())
            return
        if path == "/api/knowledge/documents" and method == "POST":
            self._json({"document": service.add_knowledge_document(actor, self._body_json())}, status=201)
            return
        if path == "/api/knowledge/search" and method == "GET":
            self._json({"results": service.user_search_knowledge(actor, first(query, "q", ""), int_arg(query, "limit", 5))})
            return
        m = re.fullmatch(r"/api/knowledge/documents/(\d+)", path)
        if m and method == "GET":
            self._json({"document": service.user_knowledge_document(actor, int(m.group(1)))})
            return

        if path == "/api/settings/secrets" and method == "GET":
            self._json({"secrets": service.list_secrets(actor)})
            return
        m = re.fullmatch(r"/api/settings/secrets/([A-Za-z0-9_]+)", path)
        if m and method == "PUT":
            body = self._body_json()
            service.set_secret(actor, m.group(1), str(body.get("value", "")))
            self._json({"ok": True})
            return
        if path == "/api/settings/agent-token" and method == "GET":
            self._json(service.agent_tool_token(actor))
            return
        if path == "/api/system/security/config" and method == "GET":
            self._json(service.platform_security_config(actor))
            return
        if path == "/api/system/security/config" and method == "PUT":
            self._json(service.update_platform_security_config(actor, self._body_json()))
            return
        if path == "/api/system/runtime" and method == "GET":
            self._json(service.runtime_status(actor))
            return
        if path == "/api/system/hermes/config" and method == "GET":
            self._json(service.hermes_config(actor))
            return
        if path == "/api/system/hermes/config" and method == "PUT":
            self._json(service.update_hermes_config(actor, self._body_json()))
            return
        if path == "/api/system/telegram/config" and method == "GET":
            self._json(service.telegram_admin_config(actor))
            return
        if path == "/api/system/telegram/config" and method == "PUT":
            self._json(service.update_telegram_admin_config(actor, self._body_json()))
            return
        if path == "/api/system/hermes/internal-config" and method == "GET":
            self._json(service.hermes_internal_config(actor))
            return
        if path == "/api/system/hermes/internal-config" and method == "PUT":
            self._json(service.update_hermes_internal_config(actor, self._body_json()))
            return
        if path == "/api/system/cognee/config" and method == "GET":
            self._json(service.cognee_config(actor))
            return
        if path == "/api/system/cognee/config" and method == "PUT":
            self._json(service.update_cognee_config(actor, self._body_json()))
            return
        if path == "/api/system/oauth/providers" and method == "GET":
            self._json(service.oauth_provider_status(actor))
            return
        if path == "/api/system/oauth/credentials/export" and method == "GET":
            self._json(service.export_oauth_credentials(actor))
            return
        if path == "/api/system/oauth/credentials/import" and method == "POST":
            self._json(service.import_oauth_credentials(actor, self._body_json()))
            return
        m = re.fullmatch(r"/api/system/oauth/([A-Za-z0-9_-]+)/start", path)
        if m and method == "POST":
            self._json(service.start_oauth_verification(actor, m.group(1)), status=201)
            return
        m = re.fullmatch(r"/api/system/oauth/([A-Za-z0-9_-]+)/poll", path)
        if m and method == "POST":
            self._json(service.poll_oauth_verification(actor, m.group(1), self._body_json()))
            return
        m = re.fullmatch(r"/api/system/oauth/([A-Za-z0-9_-]+)/complete", path)
        if m and method == "POST":
            self._json(service.complete_oauth_verification(actor, m.group(1), self._body_json()))
            return
        m = re.fullmatch(r"/api/system/runtime/([A-Za-z0-9_-]+)/install", path)
        if m and method == "POST":
            self._json(service.install_runtime(actor, m.group(1)))
            return
        m = re.fullmatch(r"/api/system/runtime/([A-Za-z0-9_-]+)/restart", path)
        if m and method == "POST":
            self._json(service.restart_runtime(actor, m.group(1)))
            return

        raise ServiceError(404, "endpoint not found")

    def _handle_agent_tool(self, method: str, path: str, query: dict[str, list[str]]) -> None:
        service = self.server.service
        token = self.headers.get("X-Enterprise-Agent-Token") or bearer_token(self.headers.get("Authorization", ""))
        if not service.validate_agent_tool_token(token):
            raise ServiceError(401, "invalid agent tool token")
        if path == "/api/agent/tools/knowledge/search" and method == "GET":
            self._json({"results": service.search_knowledge(first(query, "q", ""), int_arg(query, "limit", 5))})
            return
        m = re.fullmatch(r"/api/agent/tools/knowledge/documents/(\d+)", path)
        if m and method == "GET":
            self._json({"document": service.get_knowledge_document(int(m.group(1)))})
            return
        raise ServiceError(404, "agent tool endpoint not found")

    def _require_user(self) -> dict[str, Any]:
        user = self.server.service.user_from_token(self._read_token())
        if not user:
            raise ServiceError(401, "authentication required")
        return user

    def _read_token(self) -> str | None:
        auth = self.headers.get("Authorization", "")
        token = bearer_token(auth)
        if token:
            return token
        cookie_header = self.headers.get("Cookie", "")
        if not cookie_header:
            return None
        cookie = SimpleCookie()
        cookie.load(cookie_header)
        morsel = cookie.get(COOKIE_NAME)
        return morsel.value if morsel else None

    def _body_json(self) -> dict[str, Any]:
        length = self._content_length()
        if length > MAX_BODY_BYTES:
            raise ServiceError(413, "request body too large")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise ServiceError(400, "invalid JSON body") from exc
        if not isinstance(data, dict):
            raise ServiceError(400, "JSON body must be an object")
        return data

    def _body_message(self) -> tuple[str, list[UploadedFile]]:
        content_type = self.headers.get("Content-Type", "")
        if content_type.lower().startswith("multipart/form-data"):
            return self._body_multipart_message(content_type)
        body = self._body_json()
        return str(body.get("content", "")), []

    def _body_multipart_message(self, content_type: str) -> tuple[str, list[UploadedFile]]:
        length = self._content_length()
        if length > MAX_UPLOAD_BODY_BYTES:
            raise ServiceError(413, "upload body too large")
        raw = self.rfile.read(length) if length else b""
        parser_body = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8") + raw
        try:
            message = BytesParser(policy=policy.default).parsebytes(parser_body)
        except Exception as exc:
            raise ServiceError(400, "invalid multipart body") from exc
        if not message.is_multipart():
            raise ServiceError(400, "invalid multipart body")

        content = ""
        attachments: list[UploadedFile] = []
        for part in message.iter_parts():
            disposition = part.get_content_disposition()
            if disposition not in {"form-data", "attachment", "inline"}:
                continue
            name = part.get_param("name", header="content-disposition")
            filename = part.get_filename()
            data = part.get_payload(decode=True) or b""
            if filename is not None:
                if filename == "" and not data:
                    continue
                attachments.append(UploadedFile(filename=filename or "attachment", content_type=part.get_content_type(), data=data))
            elif name == "content":
                charset = part.get_content_charset() or "utf-8"
                content = data.decode(charset, errors="replace")
        return content, attachments

    def _json(self, payload: Any, status: int = 200, headers: dict[str, str] | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._send_security_headers()
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _stream_file_handle(self, fh) -> None:
        # Stream an already-open file in fixed-size chunks instead of buffering
        # the whole file in memory; swallow client-disconnect errors like the SSE
        # handler does (headers are already sent at this point).
        try:
            shutil.copyfileobj(fh, self.wfile, FILE_STREAM_CHUNK_BYTES)
        except (BrokenPipeError, ConnectionError):
            return

    def _serve_attachment(self, actor: dict[str, Any], attachment_id: int, *, download: bool) -> None:
        attachment, path = self.server.service.get_attachment_file(actor, attachment_id)
        filename = str(attachment.get("filename") or "attachment")
        ascii_name = re.sub(r"[^A-Za-z0-9._ -]", "_", filename).strip(" .") or "attachment"
        mime_type = str(attachment.get("mime_type") or "application/octet-stream")
        disposition = "inline" if not download and is_safe_inline_attachment_mime(mime_type) else "attachment"
        # Open and size the file BEFORE sending any header: an open/stat failure
        # then raises while the response line is still unsent, so _dispatch can
        # emit a clean 500 instead of a corrupt second response written after a
        # 200 + Content-Length is already on the wire.
        with path.open("rb") as fh:
            size = os.fstat(fh.fileno()).st_size
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", mime_type)
            self.send_header("Content-Length", str(size))
            self.send_header("Content-Disposition", f"{disposition}; filename=\"{ascii_name}\"; filename*=UTF-8''{urllib.parse.quote(filename)}")
            self.send_header("Cache-Control", "private, max-age=3600")
            self._send_security_headers()
            self.end_headers()
            self._stream_file_handle(fh)

    def _stream_scope_events(self, actor: dict[str, Any], scope_type: str, scope_id: str) -> None:
        service = self.server.service
        # Authorize before emitting any response so a denial becomes a normal
        # JSON error (no headers are sent yet).
        service.agent_status(actor, scope_type, scope_id)
        # Admission control: bound the number of concurrent long-lived streams
        # globally and per user so a scripted client cannot pin worker threads
        # (and their per-thread SQLite connections) indefinitely. Reject before
        # sending the event-stream headers so the client sees a clean JSON 503.
        user_key = actor.get("id")
        # Capture the raw session token once so the loop can re-validate the live
        # session (active flag / token_version) without re-reading headers.
        token = self._read_token()
        if not self.server.acquire_sse_slot(user_key):
            raise ServiceError(503, "too many concurrent event streams; retry shortly")
        try:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.send_header("X-Accel-Buffering", "no")
            self._send_security_headers()
            self.end_headers()
            # This stream is now bounded by the SSE caps (acquire_sse_slot above),
            # so hand the general request slot back rather than pinning it for the
            # whole stream lifetime — otherwise a handful of open streams could
            # exhaust MAX_CONCURRENT_REQUESTS and starve all new connections.
            self.server.release_request_slot_once()
            deadline = time.time() + SSE_MAX_SECONDS
            next_auth_check = time.time() + SSE_AUTH_RECHECK_SECONDS
            last_token = None
            while time.time() < deadline:
                now = time.time()
                if now >= next_auth_check:
                    # Promptly end the stream if the session was deactivated or
                    # revoked (password reset / role change / explicit revoke)
                    # rather than waiting for the SSE_MAX_SECONDS backstop.
                    if not service.user_from_token(token):
                        return
                    next_auth_check = now + SSE_AUTH_RECHECK_SECONDS
                status = service.agent_status(actor, scope_type, scope_id)
                latest = service.latest_message_id(scope_type, scope_id)
                stream = status.get("stream_message") or {}
                token_tuple = (
                    latest,
                    status.get("state"),
                    status.get("updated_at"),
                    stream.get("content"),
                    len(status.get("stream_messages") or []),
                )
                if token_tuple != last_token:
                    payload = json.dumps(
                        {"agent_status": status, "latest_message_id": latest}, ensure_ascii=False
                    )
                    self.wfile.write(f"event: update\ndata: {payload}\n\n".encode("utf-8"))
                    last_token = token_tuple
                else:
                    self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
                time.sleep(SSE_POLL_INTERVAL)
        except Exception:
            # Client disconnected or the scope became unavailable; just end the
            # stream (the browser's EventSource will reconnect if appropriate).
            return
        finally:
            self.server.release_sse_slot(user_key)

    def _serve_static(self, path: str) -> None:
        static_dir = Path(__file__).resolve().parent / "static"
        if path in {"", "/"}:
            path = "/index.html"
        clean = path.lstrip("/")
        if "/" in clean:
            self._not_found()
            return
        target = static_dir / clean
        if not target.exists() or not target.is_file():
            target = static_dir / "index.html"
        # Open before sending headers (see _serve_attachment) so an open failure
        # cannot produce a corrupt double response after a 200 is already sent.
        try:
            fh = target.open("rb")
        except OSError:
            self._not_found()
            return
        with fh:
            size = os.fstat(fh.fileno()).st_size
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", mimetypes.guess_type(str(target))[0] or "application/octet-stream")
            self.send_header("Content-Length", str(size))
            self._send_security_headers()
            self.end_headers()
            self._stream_file_handle(fh)

    def _not_found(self) -> None:
        self.send_response(HTTPStatus.NOT_FOUND)
        self._send_security_headers()
        self.end_headers()

    def _content_length(self) -> int:
        raw = self.headers.get("Content-Length", "0") or "0"
        try:
            length = int(raw)
        except ValueError as exc:
            raise ServiceError(400, "invalid Content-Length") from exc
        if length < 0:
            raise ServiceError(400, "invalid Content-Length")
        return length

    def _send_security_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; "
            "script-src 'self' 'unsafe-inline'; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; "
            "connect-src 'self'; "
            "object-src 'none'; "
            "base-uri 'self'; "
            "form-action 'self'; "
            "frame-ancestors 'none'",
        )

    def _session_cookie(self, token: str) -> str:
        attrs = [f"{COOKIE_NAME}={token}", "Path=/", "HttpOnly", "SameSite=Lax"]
        if self._secure_cookie_enabled():
            attrs.append("Secure")
        return "; ".join(attrs)

    def _clear_cookie(self) -> str:
        attrs = [f"{COOKIE_NAME}=", "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"]
        if self._secure_cookie_enabled():
            attrs.append("Secure")
        return "; ".join(attrs)

    def _secure_cookie_enabled(self) -> bool:
        return urllib.parse.urlparse(self.server.service.public_base_url()).scheme == "https"

    def _require_same_origin(self) -> None:
        # CSRF defenses only apply to ambient cookie auth. A request that carries
        # its own Authorization: Bearer token is not forgeable cross-origin (an
        # attacker cannot make a victim's browser attach a custom header), so it
        # is exempt — this keeps programmatic/bearer API clients working.
        if bearer_token(self.headers.get("Authorization", "")):
            return
        candidate = self.headers.get("Origin", "").strip() or self.headers.get("Referer", "").strip()
        if not candidate:
            # Reject state-changing cookie requests that omit BOTH headers,
            # rather than silently allowing them.
            raise ServiceError(403, "missing Origin/Referer on state-changing request")
        if not self._origin_allowed(candidate):
            raise ServiceError(403, "cross-origin request denied")

    def _origin_allowed(self, value: str) -> bool:
        origin = normalized_origin(value)
        return bool(origin and origin in self._allowed_origins())

    def _allowed_origins(self) -> set[str]:
        origins = set()
        public_origin = normalized_origin(self.server.service.public_base_url())
        if public_origin:
            origins.add(public_origin)
        request_origin = normalized_origin(self._request_base_url())
        if request_origin:
            origins.add(request_origin)
        return origins

    def _trusts_forwarded_headers(self) -> bool:
        return bool(self.server.service.trust_forwarded_headers())

    def _request_base_url(self) -> str:
        # Only honour X-Forwarded-* when an operator has declared a trusted
        # reverse proxy; otherwise a client could forge X-Forwarded-Host to
        # spoof an allowed origin.
        if self._trusts_forwarded_headers():
            proto = first_forwarded(self.headers.get("X-Forwarded-Proto", "")) or "http"
            host = first_forwarded(self.headers.get("X-Forwarded-Host", "")) or self.headers.get("Host", "")
        else:
            proto = "https" if self._secure_cookie_enabled() else "http"
            host = self.headers.get("Host", "")
        if proto not in {"http", "https"}:
            proto = "http"
        return f"{proto}://{host}" if host else ""

    def _client_identity(self) -> str:
        # Trust X-Forwarded-For only behind a declared proxy; otherwise an
        # attacker could rotate it to evade the login rate limiter.
        if self._trusts_forwarded_headers():
            forwarded = first_forwarded(self.headers.get("X-Forwarded-For", ""))
            if forwarded:
                return forwarded
        try:
            return str(self.client_address[0])
        except Exception:
            return "unknown"


def first(query: dict[str, list[str]], key: str, default: str) -> str:
    values = query.get(key)
    return values[0] if values else default


def int_arg(query: dict[str, list[str]], key: str, default: int) -> int:
    """Parse an integer query parameter, returning a clean 400 (not a 500) when
    the value is non-numeric."""
    raw = first(query, key, str(default))
    try:
        return int(raw)
    except (TypeError, ValueError) as exc:
        raise ServiceError(400, f"invalid {key} parameter") from exc


def bearer_token(value: str) -> str | None:
    if value.lower().startswith("bearer "):
        return value[7:].strip()
    return None


def first_forwarded(value: str) -> str:
    return str(value or "").split(",", 1)[0].strip()


def normalized_origin(value: str) -> str | None:
    try:
        parsed = urllib.parse.urlparse(str(value or "").strip())
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return None
        hostname = parsed.hostname.lower()
        port = parsed.port
    except ValueError:
        return None
    default_port = 443 if parsed.scheme == "https" else 80
    netloc = hostname if port in {None, default_port} else f"{hostname}:{port}"
    return f"{parsed.scheme}://{netloc}"


def make_server(config: PlatformConfig | None = None, service: EnterpriseService | None = None) -> EnterpriseHTTPServer:
    config = config or PlatformConfig.from_env(Path(__file__).resolve().parents[1])
    service = service or EnterpriseService(config)
    return EnterpriseHTTPServer((config.host, config.port), RequestHandler, service)


def run_server(config: PlatformConfig | None = None) -> None:
    server = make_server(config)
    host, port = server.server_address[:2]
    print(f"Enterprise Agent Platform running at http://{host}:{port}")
    bootstrap_password_path = server.service.config.data_dir / BOOTSTRAP_ADMIN_PASSWORD_FILE
    if bootstrap_password_path.exists():
        print(f"Bootstrap admin account is admin; initial password is stored at {bootstrap_password_path}")
    else:
        print("Bootstrap admin account is admin; password came from ENTERPRISE_ADMIN_PASSWORD or existing database state.")
    if not getattr(server.service.db, "fts_available", True):
        print(
            "Warning: SQLite was built without FTS5; knowledge search falls back to a slower LIKE scan.",
            file=sys.stderr,
        )
    previous_handlers: dict[int, signal.Handlers] = {}

    def request_shutdown(signum, _frame) -> None:
        raise KeyboardInterrupt

    for signum in (signal.SIGINT, signal.SIGTERM):
        try:
            previous_handlers[signum] = signal.getsignal(signum)
            signal.signal(signum, request_shutdown)
        except (ValueError, OSError):
            pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for signum, handler in previous_handlers.items():
            try:
                signal.signal(signum, handler)
            except (ValueError, OSError):
                pass
        server.service.close()
        server.server_close()


def serve_in_thread(config: PlatformConfig, service: EnterpriseService | None = None) -> tuple[EnterpriseHTTPServer, threading.Thread]:
    server = make_server(config, service)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread
