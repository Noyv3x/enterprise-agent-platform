from __future__ import annotations

import json
import base64
import mimetypes
import os
import random
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Protocol

from .config import PlatformConfig


HOUSEKEEPING_TOOLS = frozenset({"memory", "todo", "skill_manage", "session_search"})

# HTTP statuses worth retrying because they typically indicate a transient,
# server-side condition (e.g. the managed runtime still warming up).
_RETRYABLE_HTTP_STATUSES = frozenset({502, 503, 504})


class HermesStreamError(RuntimeError):
    """Raised when a Hermes stream reports a terminal mid-stream failure."""


@dataclass(frozen=True)
class AgentResult:
    content: str
    session_id: str
    raw: dict[str, Any]
    degraded: bool = False


AgentProgressCallback = Callable[[dict[str, Any]], None]
AgentContentCallback = Callable[[str | None], None]


def emit_content(content_callback: AgentContentCallback | None, content: str) -> None:
    if content_callback is None or not content:
        return
    try:
        content_callback(content)
    except Exception:
        return


def emit_content_segment_break(content_callback: AgentContentCallback | None) -> None:
    if content_callback is None:
        return
    try:
        content_callback(None)
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
        # Build the request once so the Idempotency-Key stays constant across
        # retries — a rebuilt key (which embeds the current millisecond clock)
        # would defeat server-side dedup.
        request = urllib.request.Request(
            self._effective_api_url(),
            data=json.dumps(body).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        # Only non-streaming requests may be retried on a transient connect
        # failure: the Hermes server dedups them via the Idempotency-Key. A
        # streaming request is NOT deduped server-side, so a retry after the
        # first attempt may already have started an agent run could double-run
        # the agent / double-post a reply. Retrying streaming is therefore unsafe.
        response = self._open_with_retry(request, allow_retry=not body["stream"])
        with response:
            response_session = response.headers.get("X-Hermes-Session-Id") or session_id
            content_type = str(response.headers.get("Content-Type") or "")
            if body["stream"] and "text/event-stream" in content_type:
                # Once we begin consuming the streamed body it is no longer safe
                # to retry, so streaming is handled outside the retry loop.
                return self._read_streaming_response(response, response_session, progress_callback, content_callback)
            raw = json.loads(response.read().decode("utf-8"))
        result = self._result_from_completion(raw, response_session)
        emit_content(content_callback, result.content)
        return result

    def _open_with_retry(self, request: urllib.request.Request, *, allow_retry: bool = True):
        """Open the request with bounded retries for transient connect failures.

        Retries only cover the connect/initial-status phase (before any response
        body byte is consumed), so streamed output is never duplicated. The
        request object — and therefore its Idempotency-Key — is reused unchanged
        across attempts so the server can safely dedup any in-flight duplicate.

        ``allow_retry`` must be False for streaming requests: those are not
        deduped server-side, so a retry after a transient failure on the first
        attempt could start a second agent run.
        """
        attempts = self._retry_attempts() if allow_retry else 1
        base_delay = self._retry_base_delay()
        timeout = self._effective_timeout_seconds()
        last_exc: BaseException | None = None
        for attempt in range(attempts):
            try:
                return urllib.request.urlopen(request, timeout=timeout)
            except urllib.error.HTTPError as exc:
                if exc.code in _RETRYABLE_HTTP_STATUSES and attempt + 1 < attempts:
                    last_exc = exc
                    self._sleep_backoff(base_delay, attempt)
                    continue
                # Surface the server-provided error detail rather than the bare
                # status line, which is all str(HTTPError) exposes.
                raise self._http_error_to_value_error(exc) from exc
            except (TimeoutError, urllib.error.URLError, OSError) as exc:
                if attempt + 1 < attempts:
                    last_exc = exc
                    self._sleep_backoff(base_delay, attempt)
                    continue
                raise
        # Defensive: the loop always returns or raises, but keep mypy/readers happy.
        if last_exc is not None:
            raise last_exc
        raise RuntimeError("Hermes request failed without raising")

    @staticmethod
    def _sleep_backoff(base_delay: float, attempt: int) -> None:
        delay = base_delay * (2 ** attempt)
        # Full jitter avoids synchronized retry storms across concurrent turns.
        time.sleep(delay * (0.5 + random.random() * 0.5))

    @staticmethod
    def _http_error_to_value_error(exc: urllib.error.HTTPError) -> ValueError:
        detail = ""
        try:
            body = exc.read(8192).decode("utf-8", "replace").strip()
        except Exception:
            body = ""
        if body:
            try:
                parsed = json.loads(body)
            except json.JSONDecodeError:
                detail = body[:500]
            else:
                if isinstance(parsed, dict):
                    error = parsed.get("error")
                    if isinstance(error, dict):
                        detail = str(error.get("message") or "").strip()
                    elif isinstance(error, str):
                        detail = error.strip()
                    if not detail:
                        detail = str(parsed.get("message") or "").strip()
                if not detail:
                    detail = body[:500]
        header_detail = ""
        try:
            header_detail = str(exc.headers.get("X-Hermes-Error") or "").strip()
        except Exception:
            header_detail = ""
        if header_detail and header_detail not in detail:
            detail = f"{detail} ({header_detail})" if detail else header_detail
        if detail:
            return ValueError(f"Hermes HTTP {exc.code}: {detail}")
        return ValueError(f"Hermes HTTP {exc.code}: {exc.reason}")

    def _retry_attempts(self) -> int:
        raw = os.environ.get("ENTERPRISE_HERMES_RETRY_ATTEMPTS")
        try:
            return max(1, int(raw)) if raw is not None else 3
        except (TypeError, ValueError):
            return 3

    def _retry_base_delay(self) -> float:
        raw = os.environ.get("ENTERPRISE_HERMES_RETRY_BASE_DELAY")
        try:
            return max(0.0, float(raw)) if raw is not None else 0.25
        except (TypeError, ValueError):
            return 0.25

    @staticmethod
    def _result_from_completion(raw: dict[str, Any], response_session: str) -> AgentResult:
        content = text_from_response_payload(raw)
        if not content:
            raise ValueError("Hermes returned an empty response")
        return AgentResult(content=content, session_id=response_session, raw=raw)

    @staticmethod
    def _content_with_images(user_message: str, attachments: list[dict[str, Any]]) -> Any:
        image_parts = []
        skipped = []
        total_inline_bytes = 0
        budget = 5 * 1024 * 1024
        for attachment in attachments:
            if not attachment.get("is_image"):
                continue
            local_path = str(attachment.get("local_path") or "").strip()
            if not local_path:
                continue
            path = Path(local_path)
            try:
                size = path.stat().st_size
                # base64 expands payload to ceil(n/3)*4 bytes (~33% larger); the
                # budget must reflect the encoded bytes that actually go on the
                # wire, not the raw file size. Estimate conservatively before
                # reading so oversized files are skipped without a full read.
                estimated_encoded = ((size + 2) // 3) * 4
                if size <= 0 or total_inline_bytes + estimated_encoded > budget:
                    skipped.append(str(attachment.get("filename") or path.name))
                    continue
                data = path.read_bytes()
            except OSError:
                skipped.append(str(attachment.get("filename") or local_path))
                continue
            mime_type = str(attachment.get("mime_type") or mimetypes.guess_type(path.name)[0] or "image/png")
            encoded = base64.b64encode(data).decode("ascii")
            encoded_len = len(encoded)
            if total_inline_bytes + encoded_len > budget:
                skipped.append(str(attachment.get("filename") or path.name))
                continue
            image_parts.append({"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{encoded}"}})
            total_inline_bytes += encoded_len

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
        last_cleared = ""
        failure_message: str | None = None
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
            nonlocal event_name, data_lines, last_cleared, failure_message
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
                # Skip malformed frames instead of aborting the whole stream;
                # one bad SSE frame must never discard an otherwise-complete
                # response (mirrors the swallow-and-continue pattern used by
                # _emit_progress / emit_content).
                try:
                    payload = json.loads(data)
                except json.JSONDecodeError:
                    remember(event, {"_parse_error": data[:500]})
                    return False
                if isinstance(payload, dict):
                    remember(event, payload)
                    if is_substantive_tool_start(payload) and content_parts:
                        # Break the live stream into a new segment, but keep the
                        # pre-tool prose as a fallback so it is never lost from
                        # the final result (the previous code cleared it, which
                        # discarded legitimate text and could spuriously raise
                        # "no final streaming response").
                        last_cleared = "".join(content_parts)
                        content_parts.clear()
                        emit_content_segment_break(content_callback)
                    self._emit_progress(progress_callback, payload)
                return False
            try:
                payload = json.loads(data)
            except json.JSONDecodeError:
                remember(event, {"_parse_error": data[:500]})
                return False
            remember(event, payload)
            if isinstance(payload, dict):
                # Detect a terminal mid-stream failure before any text extraction
                # so the server error is surfaced rather than masked (or, worse,
                # returned verbatim as if it were assistant content).
                detected = terminal_failure_message(payload)
                if detected is not None:
                    failure_message = detected
                    return True
                text = text_from_stream_payload(payload, already_streaming=bool(content_parts))
                if text:
                    # After a substantive tool break, a terminal full-text event
                    # re-carries the pre-tool prose that was already streamed to
                    # the live consumer. Keep the complete text in the final
                    # result, but emit only the not-yet-streamed tail to the
                    # callback so the live UI does not show the prose twice.
                    new_text = text
                    if not content_parts and last_cleared and text.startswith(last_cleared):
                        new_text = text[len(last_cleared):]
                    content_parts.append(text)
                    emit_content(content_callback, new_text)
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
        # Prefer post-tool text; fall back to the last pre-tool prose so a
        # tool-only tail does not lose the model's earlier answer.
        content = "".join(content_parts) or last_cleared
        if failure_message is not None:
            raw["error"] = failure_message
            if content:
                # Some answer streamed before the agent crashed: surface it as a
                # degraded partial rather than presenting it as complete.
                return AgentResult(
                    content=content,
                    session_id=response_session,
                    raw=raw,
                    degraded=True,
                )
            # Nothing usable streamed: raise the real server-provided cause so it
            # is preserved through AutoAgentClient's fallback path instead of the
            # generic empty-stream message.
            raise ValueError(f"Hermes agent failed mid-stream: {failure_message}")
        if not content:
            raise ValueError(f"Hermes returned an empty streaming response after {event_count} events")
        return AgentResult(content=content, session_id=response_session, raw=raw)

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


def text_from_response_payload(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""
    choices = payload.get("choices") or []
    for choice in choices:
        if not isinstance(choice, dict):
            continue
        message = choice.get("message") or {}
        text = text_from_content(message.get("content"))
        if text:
            return text
        text = text_from_content(choice.get("text"))
        if text:
            return text
    for key in ("final_response", "output_text", "text", "content"):
        text = text_from_content(payload.get(key))
        if text:
            return text
    output = payload.get("output")
    if isinstance(output, list):
        text = "".join(text_from_content(item) for item in output).strip()
        if text:
            return text
    response = payload.get("response")
    if isinstance(response, dict):
        return text_from_response_payload(response)
    return ""


def is_substantive_tool_start(payload: dict[str, Any]) -> bool:
    if not isinstance(payload, dict):
        return False
    status = str(payload.get("status") or payload.get("event_type") or "running").strip().lower()
    if status not in {"running", "started", "start", "tool.started"}:
        return False
    tool = str(payload.get("tool") or payload.get("tool_name") or "").strip()
    return bool(tool) and not tool.startswith("_") and tool not in HOUSEKEEPING_TOOLS


def terminal_failure_message(payload: dict[str, Any]) -> str | None:
    """Return a failure message if the payload is a terminal failure signal.

    Handles both stream shapes Hermes can emit on a mid-stream agent crash:
    the Responses-API ``response.failed`` event (which carries
    ``response.error.message``) and a chat-completions chunk whose
    ``choices[0].finish_reason`` is ``"error"`` (which carries no message).
    Returns ``None`` when the payload is not a terminal failure.
    """
    if not isinstance(payload, dict):
        return None
    event_type = str(payload.get("type") or "")
    if event_type == "response.failed":
        response = payload.get("response")
        message = ""
        if isinstance(response, dict):
            error = response.get("error")
            if isinstance(error, dict):
                message = str(error.get("message") or "").strip()
            elif isinstance(error, str):
                message = error.strip()
        return message or "Hermes agent failed mid-stream"
    choices = payload.get("choices") or []
    if isinstance(choices, list):
        for choice in choices:
            if isinstance(choice, dict) and str(choice.get("finish_reason") or "") == "error":
                return "Hermes agent crashed mid-stream"
    return None


def text_from_stream_payload(payload: dict[str, Any], *, already_streaming: bool) -> str:
    event_type = str(payload.get("type") or "")
    if event_type in {"response.output_text.delta", "response.refusal.delta"}:
        return text_from_content(payload.get("delta"))
    if event_type in {"response.content_part.done", "response.output_item.done"}:
        return "" if already_streaming else text_from_content(payload.get("part") or payload.get("item"))
    if event_type in {"response.completed", "response.done"}:
        return "" if already_streaming else text_from_response_payload(payload.get("response"))

    choices = payload.get("choices") or []
    for choice in choices:
        if not isinstance(choice, dict):
            continue
        delta = choice.get("delta") or {}
        text = text_from_content(delta.get("content"))
        if text:
            return text
        message = choice.get("message") or {}
        text = text_from_content(message.get("content"))
        if text:
            return text
    if already_streaming:
        return ""
    return text_from_response_payload(payload)


def text_from_content(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(text_from_content(item) for item in value)
    if isinstance(value, dict):
        for key in ("text", "output_text", "content", "final_response"):
            text = text_from_content(value.get(key))
            if text:
                return text
        if value.get("type") in {"output_text", "text"}:
            return text_from_content(value.get("value"))
    return ""
