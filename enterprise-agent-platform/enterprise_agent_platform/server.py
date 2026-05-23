from __future__ import annotations

import json
import mimetypes
import re
import threading
import urllib.parse
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from .config import PlatformConfig
from .service import EnterpriseService, ServiceError


COOKIE_NAME = "enterprise_session"
MAX_BODY_BYTES = 5 * 1024 * 1024


class EnterpriseHTTPServer(ThreadingHTTPServer):
    def __init__(self, server_address, RequestHandlerClass, service: EnterpriseService):
        super().__init__(server_address, RequestHandlerClass)
        self.service = service


class RequestHandler(BaseHTTPRequestHandler):
    server: EnterpriseHTTPServer

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

    def _dispatch(self, method: str) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        try:
            if path.startswith("/api/agent/tools/"):
                self._handle_agent_tool(method, path, query)
                return
            if path.startswith("/api/"):
                self._handle_api(method, path, query)
                return
            self._serve_static(path)
        except ServiceError as exc:
            self._json({"error": exc.message}, status=exc.status)
        except Exception as exc:
            self._json({"error": f"internal server error: {exc}"}, status=500)

    def _handle_api(self, method: str, path: str, query: dict[str, list[str]]) -> None:
        service = self.server.service
        if path == "/api/auth/login" and method == "POST":
            body = self._body_json()
            token, user = service.authenticate(str(body.get("username", "")), str(body.get("password", "")))
            self._json({"user": user}, headers={"Set-Cookie": self._session_cookie(token)})
            return
        if path == "/api/auth/logout" and method == "POST":
            self._json({"ok": True}, headers={"Set-Cookie": self._clear_cookie()})
            return

        actor = self._require_user()
        if path == "/api/auth/me" and method == "GET":
            self._json({"user": actor})
            return
        if path == "/api/users" and method == "GET":
            self._json({"users": service.list_users(actor)})
            return
        if path == "/api/users" and method == "POST":
            body = self._body_json()
            user = service.create_user(
                username=str(body.get("username", "")),
                password=str(body.get("password", "")),
                display_name=str(body.get("display_name", "")),
                role=str(body.get("role", "member")),
                actor=actor,
            )
            self._json({"user": user}, status=201)
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
            limit = int(first(query, "limit", "100"))
            self._json({"messages": service.list_messages(actor, "channel", m.group(1), limit=limit)})
            return
        if m and method == "POST":
            body = self._body_json()
            self._json(service.send_channel_message(actor, int(m.group(1)), str(body.get("content", ""))), status=201)
            return

        if path == "/api/private-agent/messages" and method == "GET":
            limit = int(first(query, "limit", "100"))
            self._json({"messages": service.list_messages(actor, "private", str(actor["id"]), limit=limit)})
            return
        if path == "/api/private-agent/messages" and method == "POST":
            body = self._body_json()
            self._json(service.send_private_message(actor, str(body.get("content", ""))), status=201)
            return
        if path == "/api/private-agent/status" and method == "GET":
            self._json(service.private_status(actor))
            return

        if path == "/api/knowledge/documents" and method == "GET":
            self._json({"documents": service.knowledge.list_documents()})
            return
        if path == "/api/knowledge/status" and method == "GET":
            self._json(service.knowledge_status())
            return
        if path == "/api/knowledge/documents" and method == "POST":
            self._json({"document": service.add_knowledge_document(actor, self._body_json())}, status=201)
            return
        if path == "/api/knowledge/search" and method == "GET":
            self._json({"results": service.search_knowledge(first(query, "q", ""), int(first(query, "limit", "5")))})
            return
        m = re.fullmatch(r"/api/knowledge/documents/(\d+)", path)
        if m and method == "GET":
            self._json({"document": service.get_knowledge_document(int(m.group(1)))})
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

        raise ServiceError(404, "endpoint not found")

    def _handle_agent_tool(self, method: str, path: str, query: dict[str, list[str]]) -> None:
        service = self.server.service
        token = self.headers.get("X-Enterprise-Agent-Token") or bearer_token(self.headers.get("Authorization", ""))
        if not service.validate_agent_tool_token(token):
            raise ServiceError(401, "invalid agent tool token")
        if path == "/api/agent/tools/knowledge/search" and method == "GET":
            self._json({"results": service.search_knowledge(first(query, "q", ""), int(first(query, "limit", "5")))})
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
        length = int(self.headers.get("Content-Length", "0") or "0")
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

    def _json(self, payload: Any, status: int = 200, headers: dict[str, str] | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

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
        body = target.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mimetypes.guess_type(str(target))[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _not_found(self) -> None:
        self.send_response(HTTPStatus.NOT_FOUND)
        self.end_headers()

    @staticmethod
    def _session_cookie(token: str) -> str:
        return f"{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax"

    @staticmethod
    def _clear_cookie() -> str:
        return f"{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"


def first(query: dict[str, list[str]], key: str, default: str) -> str:
    values = query.get(key)
    return values[0] if values else default


def bearer_token(value: str) -> str | None:
    if value.lower().startswith("bearer "):
        return value[7:].strip()
    return None


def make_server(config: PlatformConfig | None = None, service: EnterpriseService | None = None) -> EnterpriseHTTPServer:
    config = config or PlatformConfig.from_env(Path(__file__).resolve().parents[1])
    service = service or EnterpriseService(config)
    return EnterpriseHTTPServer((config.host, config.port), RequestHandler, service)


def run_server(config: PlatformConfig | None = None) -> None:
    server = make_server(config)
    host, port = server.server_address[:2]
    print(f"Enterprise Agent Platform running at http://{host}:{port}")
    print("Default bootstrap account is admin/admin unless ENTERPRISE_ADMIN_PASSWORD is set before first run.")
    try:
        server.serve_forever()
    finally:
        server.service.close()
        server.server_close()


def serve_in_thread(config: PlatformConfig, service: EnterpriseService | None = None) -> tuple[EnterpriseHTTPServer, threading.Thread]:
    server = make_server(config, service)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread
