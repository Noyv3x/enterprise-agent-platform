from __future__ import annotations

import json
import base64
import mimetypes
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Protocol

from .config import PlatformConfig


@dataclass(frozen=True)
class AgentResult:
    content: str
    session_id: str
    raw: dict[str, Any]
    degraded: bool = False


AgentProgressCallback = Callable[[dict[str, Any]], None]
AgentContentCallback = Callable[[str], None]


def emit_content(content_callback: AgentContentCallback | None, content: str) -> None:
    if content_callback is None or not content:
        return
    try:
        content_callback(content)
    except Exception:
        return


class AgentClient(Protocol):
    def generate(
        self,
        *,
        system_prompt: str,
        user_message: str,
        history: list[dict[str, Any]],
        session_id: str,
        session_key: str,
        metadata: dict[str, Any] | None = None,
        attachments: list[dict[str, Any]] | None = None,
        model: str | None = None,
        thinking_depth: str | None = None,
        reasoning_config: dict[str, Any] | None = None,
        progress_callback: AgentProgressCallback | None = None,
        content_callback: AgentContentCallback | None = None,
    ) -> AgentResult:
        ...


class LocalAgentClient:
    """Deterministic fallback used for local development and tests."""

    def generate(
        self,
        *,
        system_prompt: str,
        user_message: str,
        history: list[dict[str, Any]],
        session_id: str,
        session_key: str,
        metadata: dict[str, Any] | None = None,
        attachments: list[dict[str, Any]] | None = None,
        model: str | None = None,
        thinking_depth: str | None = None,
        reasoning_config: dict[str, Any] | None = None,
        progress_callback: AgentProgressCallback | None = None,
        content_callback: AgentContentCallback | None = None,
    ) -> AgentResult:
        prefix = "Main agent" if session_key.startswith("channel:") else "Private agent"
        hints = metadata.get("knowledge_suggestions", []) if metadata else []
        hint_text = ""
        if hints:
            titles = ", ".join(str(item.get("title", "")) for item in hints[:3])
            hint_text = f"\n\n知识库提示: {titles}"
        attachment_count = len(attachments or [])
        attachment_text = f"\n\n附件: {attachment_count} 个" if attachment_count else ""
        content = f"{prefix} received: {user_message}{attachment_text}{hint_text}"
        emit_content(content_callback, content)
        return AgentResult(content=content, session_id=session_id, raw={"mode": "local"}, degraded=True)


class HermesAgentClient:
    def __init__(self, config: PlatformConfig, secret_provider, runtime_config_provider=None):
        self.config = config
        self.secret_provider = secret_provider
        self.runtime_config_provider = runtime_config_provider

    def generate(
        self,
        *,
        system_prompt: str,
        user_message: str,
        history: list[dict[str, Any]],
        session_id: str,
        session_key: str,
        metadata: dict[str, Any] | None = None,
        attachments: list[dict[str, Any]] | None = None,
        model: str | None = None,
        thinking_depth: str | None = None,
        reasoning_config: dict[str, Any] | None = None,
        progress_callback: AgentProgressCallback | None = None,
        content_callback: AgentContentCallback | None = None,
    ) -> AgentResult:
        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(history[-30:])
        messages.append({"role": "user", "content": self._content_with_images(user_message, attachments or [])})
        effective_model = str(model or self._effective_model())
        body = {
            "model": effective_model,
            "messages": messages,
            "stream": progress_callback is not None or content_callback is not None,
        }
        if metadata:
            body["metadata"] = metadata
        self._apply_reasoning_config(body, thinking_depth=thinking_depth, reasoning_config=reasoning_config)
        headers = {
            "Content-Type": "application/json",
            "X-Hermes-Session-Id": session_id,
            "X-Hermes-Session-Key": session_key,
            "Idempotency-Key": f"{session_id}:{int(time.time() * 1000)}",
        }
        api_key = self.config.hermes_api_key or self.secret_provider("ENTERPRISE_HERMES_API_KEY") or self.secret_provider("API_SERVER_KEY")
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        request = urllib.request.Request(
            self._effective_api_url(),
            data=json.dumps(body).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=self._effective_timeout_seconds()) as response:
            response_session = response.headers.get("X-Hermes-Session-Id") or session_id
            content_type = str(response.headers.get("Content-Type") or "")
            if body["stream"] and "text/event-stream" in content_type:
                return self._read_streaming_response(response, response_session, progress_callback, content_callback)
            raw = json.loads(response.read().decode("utf-8"))
        result = self._result_from_completion(raw, response_session)
        emit_content(content_callback, result.content)
        return result

    @staticmethod
    def _result_from_completion(raw: dict[str, Any], response_session: str) -> AgentResult:
        choices = raw.get("choices") or []
        content = ""
        if choices:
            message = choices[0].get("message") or {}
            content = str(message.get("content") or "")
        if not content:
            content = str(raw.get("final_response") or "")
        return AgentResult(content=content or "(agent returned an empty response)", session_id=response_session, raw=raw)

    @staticmethod
    def _content_with_images(user_message: str, attachments: list[dict[str, Any]]) -> Any:
        image_parts = []
        skipped = []
        total_inline_bytes = 0
        for attachment in attachments:
            if not attachment.get("is_image"):
                continue
            local_path = str(attachment.get("local_path") or "").strip()
            if not local_path:
                continue
            path = Path(local_path)
            try:
                size = path.stat().st_size
                if size <= 0 or total_inline_bytes + size > 5 * 1024 * 1024:
                    skipped.append(str(attachment.get("filename") or path.name))
                    continue
                data = path.read_bytes()
            except OSError:
                skipped.append(str(attachment.get("filename") or local_path))
                continue
            mime_type = str(attachment.get("mime_type") or mimetypes.guess_type(path.name)[0] or "image/png")
            encoded = base64.b64encode(data).decode("ascii")
            image_parts.append({"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{encoded}"}})
            total_inline_bytes += size

        if not image_parts:
            return user_message
        text = user_message
        if skipped:
            text = f"{text}\n\n[Some image attachments were too large or unreadable for inline vision: {', '.join(skipped[:5])}]"
        return [{"type": "text", "text": text}, *image_parts]

    @staticmethod
    def _emit_progress(progress_callback: AgentProgressCallback | None, payload: dict[str, Any]) -> None:
        if progress_callback is None:
            return
        try:
            progress_callback(payload)
        except Exception:
            return

    def _read_streaming_response(
        self,
        response,
        response_session: str,
        progress_callback: AgentProgressCallback | None,
        content_callback: AgentContentCallback | None,
    ) -> AgentResult:
        content_parts: list[str] = []
        raw_events: list[dict[str, Any]] = []
        event_count = 0
        event_name = "message"
        data_lines: list[str] = []

        def remember(event: str, payload: Any) -> None:
            nonlocal event_count
            event_count += 1
            raw_events.append({"event": event, "data": payload})
            del raw_events[:-50]

        def dispatch_event() -> bool:
            nonlocal event_name, data_lines
            if not data_lines:
                event_name = "message"
                return False
            event = event_name or "message"
            data = "\n".join(data_lines)
            event_name = "message"
            data_lines = []
            if data == "[DONE]":
                remember(event, data)
                return True
            if event == "hermes.tool.progress":
                payload = json.loads(data)
                if isinstance(payload, dict):
                    remember(event, payload)
                    self._emit_progress(progress_callback, payload)
                return False
            payload = json.loads(data)
            remember(event, payload)
            if isinstance(payload, dict):
                choices = payload.get("choices") or []
                if choices:
                    choice = choices[0] or {}
                    delta = choice.get("delta") or {}
                    chunk = delta.get("content")
                    if chunk is not None:
                        text = str(chunk)
                        content_parts.append(text)
                        emit_content(content_callback, text)
                    message = choice.get("message") or {}
                    message_content = message.get("content")
                    if message_content is not None:
                        text = str(message_content)
                        content_parts.append(text)
                        emit_content(content_callback, text)
                elif payload.get("final_response"):
                    text = str(payload.get("final_response") or "")
                    content_parts.append(text)
                    emit_content(content_callback, text)
            return False

        for raw_line in response:
            line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
            if not line:
                if dispatch_event():
                    break
                continue
            if line.startswith(":"):
                continue
            field, sep, value = line.partition(":")
            if not sep:
                continue
            if value.startswith(" "):
                value = value[1:]
            if field == "event":
                event_name = value or "message"
            elif field == "data":
                data_lines.append(value)
        if data_lines:
            dispatch_event()

        raw = {
            "mode": "stream",
            "event_count": event_count,
            "events": raw_events,
        }
        content = "".join(content_parts)
        return AgentResult(content=content or "(agent returned an empty response)", session_id=response_session, raw=raw)

    def _runtime_config(self) -> dict[str, Any]:
        if self.runtime_config_provider is None:
            return {}
        try:
            data = self.runtime_config_provider()
        except Exception:
            return {}
        return data if isinstance(data, dict) else {}

    def _effective_api_url(self) -> str:
        return str(self._runtime_config().get("api_url") or self.config.hermes_api_url)

    def _effective_model(self) -> str:
        return str(self._runtime_config().get("model") or self.config.hermes_model)

    def _effective_timeout_seconds(self) -> float:
        raw = self._runtime_config().get("timeout_seconds")
        try:
            return max(1.0, float(raw)) if raw is not None else self.config.hermes_timeout_seconds
        except (TypeError, ValueError):
            return self.config.hermes_timeout_seconds

    @staticmethod
    def _apply_reasoning_config(
        body: dict[str, Any],
        *,
        thinking_depth: str | None,
        reasoning_config: dict[str, Any] | None,
    ) -> None:
        config = dict(reasoning_config or {})
        depth = str(thinking_depth or "").strip().lower()
        if not config and depth:
            config = {"enabled": False} if depth == "none" else {"enabled": True, "effort": depth}
        if not config:
            return
        body["reasoning_config"] = config
        body["reasoning"] = config
        if config.get("enabled") is False:
            body["reasoning_effort"] = "none"
            return
        effort = str(config.get("effort") or "").strip().lower()
        if effort:
            body["reasoning_effort"] = effort


class AutoAgentClient:
    def __init__(self, config: PlatformConfig, secret_provider, runtime_manager=None):
        self.config = config
        self.runtime_manager = runtime_manager
        runtime_config_provider = runtime_manager.hermes_runtime_config if runtime_manager is not None else None
        self.hermes = HermesAgentClient(config, secret_provider, runtime_config_provider=runtime_config_provider)
        self.local = LocalAgentClient()

    def generate(self, **kwargs: Any) -> AgentResult:
        if self.config.agent_mode == "local":
            return self.local.generate(**kwargs)
        try:
            if self.runtime_manager is not None:
                self.runtime_manager.ensure_hermes_ready(wait=True)
            return self.hermes.generate(**kwargs)
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError, KeyError, ValueError) as exc:
            if self.config.agent_mode == "hermes":
                raise
            fallback_kwargs = dict(kwargs)
            content_callback = fallback_kwargs.pop("content_callback", None)
            fallback = self.local.generate(**fallback_kwargs)
            content = (
                "Hermes API is not reachable, so this response was produced by the local "
                f"platform fallback. Original error: {exc}\n\n{fallback.content}"
            )
            emit_content(content_callback, content)
            return AgentResult(
                content=content,
                session_id=fallback.session_id,
                raw={"mode": "auto-fallback", "error": str(exc)},
                degraded=True,
            )
