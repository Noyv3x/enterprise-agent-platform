from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .config import PlatformConfig


ProgressCallback = Callable[[dict[str, Any]], None]
ContentCallback = Callable[[str | None], None]
_MEDIA_FALLBACK_RE = re.compile(r"^(?P<label>.*(?:Image|Audio|Video|File):)\s*(?P<path>(?:~/|/).+?)\s*$")
_MANAGED_RELAY_ID = "enterprise-managed-hermes"
_MANAGED_RELAY_AUTH_FILE = "relay-auth.json"
_RELAY_TOKEN_MAX_FUTURE_SECONDS = 10 * 60
_relay_auth_lock = threading.Lock()


def _is_loopback_host(host: str) -> bool:
    clean = str(host or "").strip().strip("[]").lower()
    if clean in {"localhost", "localhost.localdomain"}:
        return True
    try:
        return ipaddress.ip_address(clean).is_loopback
    except ValueError:
        return False


def managed_relay_auth(config: PlatformConfig) -> tuple[str, str]:
    """Return stable credentials shared by the local connector and Hermes.

    Operators may supply both values through the environment. Otherwise the
    platform creates an owner-only credential file under managed HERMES_HOME.
    Keeping this outside the settings database lets the connector and runtime
    manager share a secret without exposing it through an admin API.
    """

    configured_id = os.environ.get("ENTERPRISE_HERMES_RELAY_ID", "").strip()
    configured_secret = os.environ.get("ENTERPRISE_HERMES_RELAY_SECRET", "").strip()
    if bool(configured_id) != bool(configured_secret):
        raise ValueError(
            "ENTERPRISE_HERMES_RELAY_ID and ENTERPRISE_HERMES_RELAY_SECRET "
            "must be configured together"
        )
    if configured_id and configured_secret:
        if len(configured_secret) < 32:
            raise ValueError("ENTERPRISE_HERMES_RELAY_SECRET must contain at least 32 characters")
        return configured_id, configured_secret

    home = config.managed_hermes_home
    path = home / _MANAGED_RELAY_AUTH_FILE
    with _relay_auth_lock:
        home.mkdir(parents=True, exist_ok=True)
        try:
            home.chmod(0o700)
        except OSError:
            pass
        try:
            raw = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        except (OSError, ValueError, TypeError):
            raw = {}
        relay_id = str(raw.get("gateway_id") or "").strip() if isinstance(raw, dict) else ""
        relay_secret = str(raw.get("secret") or "").strip() if isinstance(raw, dict) else ""
        if relay_id and len(relay_secret) >= 32:
            try:
                path.chmod(0o600)
            except OSError:
                pass
            return relay_id, relay_secret

        relay_id = _MANAGED_RELAY_ID
        relay_secret = secrets.token_urlsafe(48)
        payload = json.dumps(
            {"gateway_id": relay_id, "secret": relay_secret, "version": 1},
            sort_keys=True,
        ) + "\n"
        tmp = path.with_name(f"{path.name}.tmp.{os.getpid()}.{secrets.token_hex(6)}")
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(payload)
            os.replace(str(tmp), str(path))
            path.chmod(0o600)
        except Exception:
            try:
                tmp.unlink()
            except OSError:
                pass
            raise
        return relay_id, relay_secret


def verify_relay_upgrade_token(
    token: str,
    *,
    gateway_id: str,
    secret: str,
    now: int | None = None,
) -> bool:
    """Verify the HMAC bearer emitted by Hermes' relay transport."""

    clean = str(token or "").strip()
    if not clean or not re.fullmatch(r"[A-Za-z0-9_-]+", clean):
        return False
    try:
        padded = clean + "=" * (-len(clean) % 4)
        decoded = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
        payload, expiry_text, signature = decoded.rsplit(":", 2)
        expiry = int(expiry_text)
    except (ValueError, TypeError, UnicodeDecodeError):
        return False
    current = int(time.time()) if now is None else int(now)
    if payload != gateway_id or expiry <= current or expiry > current + _RELAY_TOKEN_MAX_FUTURE_SECONDS:
        return False
    signed = f"{payload}:{expiry}"
    expected = hmac.new(secret.encode("utf-8"), signed.encode("utf-8"), hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature, expected)


@dataclass
class RelayTurnResult:
    content: str
    session_id: str
    raw: dict[str, Any]
    degraded: bool = False


@dataclass
class _RelayTurn:
    turn_id: str
    chat_id: str
    chat_type: str
    chat_name: str
    user_id: str
    user_name: str
    text: str
    session_id: str
    session_key: str
    system_prompt: str
    metadata: dict[str, Any]
    media_urls: list[str]
    media_types: list[str]
    model: str | None
    reasoning_config: dict[str, Any] | None
    progress_callback: ProgressCallback | None
    content_callback: ContentCallback | None
    done: threading.Event = field(default_factory=threading.Event)
    lock: threading.Lock = field(default_factory=threading.Lock)
    content: str = ""
    fallback_content: str = ""
    final_message_id: str = ""
    outbound_count: int = 0
    progress_count: int = 0

    def inbound_frame(self) -> dict[str, Any]:
        event = {
            "text": self.text,
            "message_type": "document" if self.media_urls else "text",
            "message_id": self.turn_id,
            "source": {
                "platform": "relay",
                "chat_id": self.chat_id,
                "chat_type": self.chat_type,
                "chat_name": self.chat_name,
                "user_id": self.user_id,
                "user_name": self.user_name,
                "message_id": self.turn_id,
            },
            "media_urls": self.media_urls,
            "media_types": self.media_types,
            "channel_prompt": self.system_prompt,
            "enterprise_turn_id": self.turn_id,
            "enterprise_session_id": self.session_id,
            "enterprise_session_key": self.session_key,
            "raw_message": {
                "metadata": self.metadata,
                "session_id": self.session_id,
                "session_key": self.session_key,
            },
        }
        if self.model:
            event["enterprise_model"] = self.model
        if self.reasoning_config:
            event["enterprise_reasoning_config"] = self.reasoning_config
        return {"type": "inbound", "event": event}

    def apply_send(self, action: dict[str, Any]) -> dict[str, Any]:
        metadata = action.get("metadata") if isinstance(action.get("metadata"), dict) else {}
        content = str(action.get("content") or "")
        message_id = str(action.get("message_id") or f"relay-out-{uuid.uuid4().hex[:12]}")
        notify = bool(metadata.get("notify") or metadata.get("enterprise_final"))
        if notify:
            content = self._normalize_final_content(content)
        with self.lock:
            self.outbound_count += 1
            if notify:
                self.content = content
                self.final_message_id = message_id
                self.done.set()
            else:
                self.progress_count += 1
                if content:
                    self.fallback_content = content
        if notify:
            self._emit_content(content)
        else:
            self._emit_progress(content, metadata)
        return {"success": True, "message_id": message_id}

    def _emit_content(self, content: str) -> None:
        callback = self.content_callback
        if callback is None or not content:
            return
        try:
            callback(content)
        except Exception:
            return

    @staticmethod
    def _normalize_final_content(content: str) -> str:
        lines: list[str] = []
        changed = False
        for line in str(content or "").splitlines():
            match = _MEDIA_FALLBACK_RE.match(line.strip())
            if not match:
                lines.append(line)
                continue
            path = match.group("path").strip()
            try:
                exists = Path(path).expanduser().exists()
            except OSError:
                exists = False
            if exists:
                lines.append(f"MEDIA:{path}")
                changed = True
            else:
                lines.append(line)
        return "\n".join(lines) if changed else content

    def _emit_progress(self, content: str, metadata: dict[str, Any]) -> None:
        callback = self.progress_callback
        if callback is None:
            return
        label = str(metadata.get("label") or metadata.get("event") or "").strip()
        if not label and content:
            label = content.strip().splitlines()[0][:160]
        if not label:
            label = "Hermes relay update"
        try:
            callback(
                {
                    "event": "relay.message",
                    "status": "running",
                    "tool": "relay",
                    "label": label,
                    "preview": content[:500],
                }
            )
        except Exception:
            return


class HermesRelayConnector:
    """Local WebSocket connector for the managed Hermes relay adapter."""

    def __init__(self, config: PlatformConfig):
        self.config = config
        self._lock = threading.RLock()
        self._turn_lock = threading.RLock()
        self._connection_ready = threading.Event()
        self._started = False
        self._thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._server: Any = None
        self._connections: set[Any] = set()
        self._active_connection: Any = None
        self._turns_by_chat: dict[str, _RelayTurn] = {}
        self._turns_by_id: dict[str, _RelayTurn] = {}
        self._start_error: BaseException | None = None
        self._relay_id: str | None = None
        self._relay_secret: str | None = None

    @property
    def enabled(self) -> bool:
        return bool(self.config.hermes_relay_enabled)

    @property
    def url(self) -> str:
        host = (self.config.hermes_relay_host or "127.0.0.1").strip() or "127.0.0.1"
        return f"ws://{host}:{int(self.config.hermes_relay_port)}/relay"

    def start(self) -> None:
        if not self.enabled:
            return
        host = (self.config.hermes_relay_host or "127.0.0.1").strip() or "127.0.0.1"
        if not _is_loopback_host(host):
            raise ValueError("Managed Hermes relay must listen on a loopback address")
        self._relay_id, self._relay_secret = managed_relay_auth(self.config)
        with self._lock:
            if self._started:
                if self._start_error is not None:
                    raise RuntimeError(f"Hermes relay connector failed to start: {self._start_error}")
                return
            self._started = True
            self._start_error = None
            self._thread = threading.Thread(target=self._run_thread, name="hermes-relay-connector", daemon=True)
            self._thread.start()
        ready_at = time.monotonic() + 5.0
        while time.monotonic() < ready_at:
            if self._loop is not None and self._server is not None:
                return
            if self._start_error is not None:
                raise RuntimeError(f"Hermes relay connector failed to start: {self._start_error}")
            time.sleep(0.02)
        raise TimeoutError("Hermes relay connector did not start in time")

    def stop(self) -> None:
        with self._lock:
            loop = self._loop
            if loop is None:
                self._started = False
                return
            thread = self._thread
            if loop.is_closed():
                self._started = False
                self._thread = None
                self._loop = None
                self._server = None
                self._connections.clear()
                self._active_connection = None
                self._connection_ready.clear()
                return
            try:
                future = asyncio.run_coroutine_threadsafe(self._stop_async(), loop)
            except RuntimeError:
                self._started = False
                self._thread = None
                self._loop = None
                self._server = None
                self._connections.clear()
                self._active_connection = None
                self._connection_ready.clear()
                return
        try:
            future.result(timeout=5)
        except Exception:
            pass
        with self._lock:
            if self._loop is not None:
                self._loop.call_soon_threadsafe(self._loop.stop)
        if thread is not None and thread.is_alive():
            thread.join(timeout=5)
        with self._lock:
            self._started = False
            self._thread = None
            self._loop = None
            self._server = None
            self._connections.clear()
            self._active_connection = None
            self._connection_ready.clear()

    def submit_turn(
        self,
        *,
        system_prompt: str,
        user_message: str,
        session_id: str,
        session_key: str,
        metadata: dict[str, Any] | None,
        attachments: list[dict[str, Any]] | None,
        model: str | None,
        reasoning_config: dict[str, Any] | None,
        timeout_seconds: float,
        progress_callback: ProgressCallback | None,
        content_callback: ContentCallback | None,
    ) -> RelayTurnResult:
        self.start()
        turn = self._build_turn(
            system_prompt=system_prompt,
            user_message=user_message,
            session_id=session_id,
            session_key=session_key,
            metadata=metadata or {},
            attachments=attachments or [],
            model=model,
            reasoning_config=reasoning_config,
            progress_callback=progress_callback,
            content_callback=content_callback,
        )
        with self._turn_lock:
            if turn.chat_id in self._turns_by_chat:
                raise RuntimeError("A Hermes relay turn is already active for this Agent")
            self._turns_by_chat[turn.chat_id] = turn
            self._turns_by_id[turn.turn_id] = turn
        try:
            if not self._connection_ready.wait(timeout=max(1.0, min(30.0, timeout_seconds))):
                raise TimeoutError("Hermes relay adapter did not connect to the platform connector")
            loop = self._loop
            if loop is None:
                raise RuntimeError("Hermes relay connector loop is not running")
            future = asyncio.run_coroutine_threadsafe(self._send_to_gateway(turn.inbound_frame()), loop)
            future.result(timeout=10)
            if not turn.done.wait(timeout=max(1.0, timeout_seconds)):
                raise TimeoutError("Hermes relay turn timed out before a final reply")
            with turn.lock:
                content = turn.content
                raw = {
                    "mode": "relay",
                    "turn_id": turn.turn_id,
                    "chat_id": turn.chat_id,
                    "session_key": turn.session_key,
                    "model": turn.model,
                    "message_id": turn.final_message_id,
                    "outbound_count": turn.outbound_count,
                    "progress_count": turn.progress_count,
                    "relay_url": self.url,
                }
            return RelayTurnResult(content=content, session_id=session_id, raw=raw)
        finally:
            with self._turn_lock:
                if self._turns_by_chat.get(turn.chat_id) is turn:
                    self._turns_by_chat.pop(turn.chat_id, None)
                if self._turns_by_id.get(turn.turn_id) is turn:
                    self._turns_by_id.pop(turn.turn_id, None)

    def _run_thread(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        with self._lock:
            self._loop = loop
        try:
            loop.run_until_complete(self._start_async())
            loop.run_forever()
        except BaseException as exc:  # noqa: BLE001 - surface startup/runtime failure to callers
            self._start_error = exc
        finally:
            try:
                loop.run_until_complete(self._stop_async())
            except Exception:
                pass
            loop.close()

    async def _start_async(self) -> None:
        serve = self._websocket_serve()
        self._server = await serve(
            self._handle_socket,
            self.config.hermes_relay_host,
            int(self.config.hermes_relay_port),
            max_size=16 * 1024 * 1024,
        )

    async def _stop_async(self) -> None:
        server = self._server
        if server is not None:
            server.close()
            await server.wait_closed()
            self._server = None
        for websocket in list(self._connections):
            try:
                await websocket.close()
            except Exception:
                pass
        self._connections.clear()
        self._active_connection = None
        self._connection_ready.clear()

    @staticmethod
    def _websocket_serve():
        try:
            from websockets.asyncio.server import serve
        except ImportError:
            from websockets.server import serve  # type: ignore[no-redef]
        return serve

    async def _handle_socket(self, websocket: Any, path: str | None = None) -> None:
        path = path or str(getattr(getattr(websocket, "request", None), "path", "") or "/relay")
        if path and not path.startswith("/relay"):
            try:
                await websocket.close(code=1008, reason="unsupported path")
            finally:
                return
        if not self._authenticate_socket(websocket):
            await websocket.close(code=4401, reason="unauthorized")
            return
        if self._active_connection is not None and self._active_connection is not websocket:
            await websocket.close(code=4409, reason="managed relay adapter already connected")
            return
        self._active_connection = websocket
        self._connections.add(websocket)
        buffer = ""
        try:
            async for chunk in websocket:
                buffer += chunk.decode("utf-8") if isinstance(chunk, (bytes, bytearray)) else str(chunk)
                *lines, buffer = buffer.split("\n")
                for line in lines:
                    if line.strip():
                        await self._handle_frame(websocket, line)
        finally:
            self._connections.discard(websocket)
            if self._active_connection is websocket:
                self._active_connection = None
                self._connection_ready.clear()

    def _authenticate_socket(self, websocket: Any) -> bool:
        relay_id = self._relay_id
        relay_secret = self._relay_secret
        if not relay_id or not relay_secret:
            try:
                relay_id, relay_secret = managed_relay_auth(self.config)
            except (OSError, ValueError):
                return False
            self._relay_id, self._relay_secret = relay_id, relay_secret
        request = getattr(websocket, "request", None)
        headers = getattr(request, "headers", None) or getattr(websocket, "request_headers", None)
        try:
            authorization = str(headers.get("Authorization") or "") if headers is not None else ""
        except Exception:
            authorization = ""
        scheme, separator, token = authorization.partition(" ")
        if not separator or scheme.lower() != "bearer":
            return False
        return verify_relay_upgrade_token(
            token,
            gateway_id=relay_id,
            secret=relay_secret,
        )

    async def _handle_frame(self, websocket: Any, line: str) -> None:
        try:
            frame = json.loads(line)
        except json.JSONDecodeError:
            return
        frame_type = str(frame.get("type") or "")
        if frame_type == "hello":
            if websocket is not self._active_connection:
                return
            if str(frame.get("platform") or "") != "relay" or str(frame.get("botId") or "") != "enterprise-web":
                await websocket.close(code=1008, reason="unsupported managed relay identity")
                return
            self._connection_ready.set()
            await self._send_frame(websocket, {"type": "descriptor", "descriptor": self._descriptor()})
            return
        if frame_type == "outbound":
            request_id = str(frame.get("requestId") or "")
            action = frame.get("action") if isinstance(frame.get("action"), dict) else {}
            result = self._handle_outbound_action(action)
            await self._send_frame(
                websocket,
                {"type": "outbound_result", "requestId": request_id, "result": result},
            )
            return
        if frame_type == "interrupt":
            return

    async def _send_to_gateway(self, frame: dict[str, Any]) -> None:
        websocket = self._active_connection if self._connection_ready.is_set() else None
        if websocket is None:
            raise RuntimeError("Hermes relay adapter is not connected")
        await self._send_frame(websocket, frame)

    @staticmethod
    async def _send_frame(websocket: Any, frame: dict[str, Any]) -> None:
        await websocket.send(json.dumps(frame, ensure_ascii=False) + "\n")

    def _handle_outbound_action(self, action: dict[str, Any]) -> dict[str, Any]:
        op = str(action.get("op") or "")
        if op == "send":
            turn = self._turn_for_action(action)
            if turn is None:
                return {"success": False, "error": "unknown or mismatched relay turn"}
            return turn.apply_send(action)
        if op in {"typing", "edit"}:
            return {"success": True}
        if op == "get_chat_info":
            chat_id = str(action.get("chat_id") or "")
            turn = self._turn_for_action(action)
            return {
                "success": True,
                "chat_info": {
                    "name": turn.chat_name if turn is not None else chat_id,
                    "type": turn.chat_type if turn is not None else "dm",
                },
            }
        if op == "follow_up":
            return {"success": False, "error": "follow_up is not supported by the platform relay connector"}
        return {"success": False, "error": f"unsupported relay action: {op or 'unknown'}"}

    def _turn_for_action(self, action: dict[str, Any]) -> _RelayTurn | None:
        metadata = action.get("metadata") if isinstance(action.get("metadata"), dict) else {}
        turn_id = str(metadata.get("enterprise_turn_id") or "").strip()
        chat_id = str(action.get("chat_id") or metadata.get("chat_id") or "").strip()
        with self._turn_lock:
            if not turn_id:
                return None
            turn = self._turns_by_id.get(turn_id)
            if turn is None or (chat_id and chat_id != turn.chat_id):
                return None
            return turn
        return None

    def _build_turn(
        self,
        *,
        system_prompt: str,
        user_message: str,
        session_id: str,
        session_key: str,
        metadata: dict[str, Any],
        attachments: list[dict[str, Any]],
        model: str | None,
        reasoning_config: dict[str, Any] | None,
        progress_callback: ProgressCallback | None,
        content_callback: ContentCallback | None,
    ) -> _RelayTurn:
        chat_id, chat_type, chat_name, user_id = self._chat_identity(session_key=session_key, session_id=session_id)
        media_urls, media_types = self._attachment_media(attachments)
        turn_id = f"enterprise-relay-{secrets.token_urlsafe(32)}"
        raw_actor = metadata.get("actor") if isinstance(metadata.get("actor"), dict) else {}
        actor_id = str(raw_actor.get("id") or "").strip()
        if actor_id:
            user_id = f"u{_safe_identifier(actor_id)}"
        user_name = str(raw_actor.get("display_name") or raw_actor.get("username") or user_id or "Enterprise User")
        return _RelayTurn(
            turn_id=turn_id,
            chat_id=chat_id,
            chat_type=chat_type,
            chat_name=chat_name,
            user_id=user_id,
            user_name=user_name,
            text=user_message,
            session_id=session_id,
            session_key=session_key,
            system_prompt=system_prompt,
            metadata=dict(metadata),
            media_urls=media_urls,
            media_types=media_types,
            model=model,
            reasoning_config=dict(reasoning_config) if reasoning_config else None,
            progress_callback=progress_callback,
            content_callback=content_callback,
        )

    @staticmethod
    def _chat_identity(*, session_key: str, session_id: str) -> tuple[str, str, str, str]:
        if session_key.startswith("channel:") and session_key.endswith(":main-agent"):
            scope_id = session_key[len("channel:") : -len(":main-agent")]
            safe = _safe_identifier(scope_id)
            return f"enterprise-channel-{safe}-main-agent", "group", f"Channel {scope_id}", f"channel-user-{safe}"
        if session_key.startswith("private:"):
            user_id = session_key[len("private:") :]
            safe = _safe_identifier(user_id)
            return f"enterprise-private-u{safe}", "dm", f"Private Agent u{user_id}", f"u{safe}"
        safe = _safe_identifier(session_id or session_key or "default")
        return f"enterprise-session-{safe}", "dm", "Enterprise Web", f"user-{safe}"

    @staticmethod
    def _attachment_media(attachments: list[dict[str, Any]]) -> tuple[list[str], list[str]]:
        urls: list[str] = []
        types: list[str] = []
        for attachment in attachments:
            path = str(attachment.get("local_path") or "").strip()
            if not path:
                continue
            try:
                if not Path(path).exists():
                    continue
            except OSError:
                continue
            urls.append(path)
            types.append(str(attachment.get("mime_type") or "application/octet-stream"))
        return urls, types

    @staticmethod
    def _descriptor() -> dict[str, Any]:
        return {
            "contract_version": 1,
            "platform": "relay",
            "label": "Enterprise Web",
            "max_message_length": 12000,
            "supports_draft_streaming": False,
            "supports_edit": False,
            "supports_threads": False,
            "markdown_dialect": "plain",
            "len_unit": "chars",
            "emoji": "",
            "platform_hint": "enterprise-web",
            "pii_safe": True,
        }


def _safe_identifier(value: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(value or "").strip()).strip("-")
    return safe or "default"
