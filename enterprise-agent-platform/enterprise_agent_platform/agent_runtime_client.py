from __future__ import annotations

import inspect
import json
import socket
import threading
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Protocol


AgentProgressCallback = Callable[[dict[str, Any]], None]
AgentContentCallback = Callable[..., None]
AgentRunStartedCallback = Callable[[str], None]


@dataclass(frozen=True)
class AgentResult:
    """Completed Agent run returned to the platform."""

    content: str
    session_id: str
    raw: dict[str, Any]
    degraded: bool = False


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
        model: str | dict[str, Any] | None = None,
        thinking_depth: str | None = None,
        reasoning_config: dict[str, Any] | None = None,
        progress_callback: AgentProgressCallback | None = None,
        content_callback: AgentContentCallback | None = None,
        run_started_callback: AgentRunStartedCallback | None = None,
    ) -> AgentResult:
        ...

    def respond_approval(
        self,
        *,
        run_id: str,
        choice: str,
        approval_id: str | None = None,
    ) -> dict[str, Any]:
        ...

    def cancel_run(self, run_id: str) -> dict[str, Any]:
        ...

    def steer_run(
        self,
        *,
        run_id: str,
        message_id: str,
        scope_key: str,
        lifecycle_id: str,
        user_message: str,
        attachments: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        ...

    def cleanup_scope(
        self,
        scope_key: str,
        lifecycle_id: str | None = None,
        *,
        delete_sessions: bool = False,
    ) -> dict[str, Any]:
        ...

    def terminal_previews(
        self,
        scope_key: str,
        lifecycle_id: str,
    ) -> dict[str, Any]:
        ...

    def terminal_preview_summary(
        self,
        scope_key: str,
        lifecycle_id: str,
    ) -> dict[str, Any]:
        ...

    def update_blocker_summary(self) -> dict[str, int]:
        ...


class AgentRuntimeError(RuntimeError):
    """Base error for the platform-owned Agent runtime client."""


class AgentRuntimeConnectionError(AgentRuntimeError):
    """The Agent runtime could not be reached."""


class AgentRuntimeTimeoutError(AgentRuntimeError):
    """The Agent runtime did not respond before the configured timeout."""


class AgentRuntimeProtocolError(AgentRuntimeError):
    """The Agent runtime returned an invalid response or event stream."""


class AgentRuntimeHTTPError(AgentRuntimeError):
    """The Agent runtime returned a non-success HTTP status."""

    def __init__(self, status_code: int, message: str, response_body: str = ""):
        self.status_code = int(status_code)
        self.response_body = response_body
        super().__init__(f"Agent runtime HTTP {self.status_code}: {message}")


class AgentRuntimeRunError(AgentRuntimeError):
    """An accepted Agent run ended in a failed or cancelled state."""

    def __init__(
        self,
        run_id: str,
        state: str,
        message: str,
        *,
        partial_content: str = "",
        session_id: str = "",
        raw: dict[str, Any] | None = None,
    ):
        self.run_id = run_id
        self.state = state
        self.partial_content = partial_content
        self.session_id = session_id
        self.raw = dict(raw or {})
        super().__init__(f"Agent run {run_id} {state}: {message}")


_APPROVAL_CHOICES = frozenset({"once", "session", "always", "deny"})
_TERMINAL_EVENTS = frozenset({"run.completed", "run.failed", "run.cancelled", "run.needs_review"})
_PLATFORM_EVENT_NAMES = {
    "approval.requested": "approval.request",
    "approval.resolved": "approval.responded",
}
_PROGRESS_EVENT_TYPES = frozenset(
    {
        "tool.started",
        "tool.updated",
        "tool.completed",
        "tool.failed",
        "approval.requested",
        "approval.resolved",
        "input.accepted",
        "input.injected",
        "input.unconsumed",
    }
)


class AgentRuntimeClient:
    """Synchronous stdlib client for the platform-owned Node Agent sidecar.

    A run is created with ``POST /v1/runs`` and consumed from its SSE event
    stream. The class is thread-safe: the generation worker may wait on an SSE
    stream while an HTTP request thread submits an approval or cancellation.
    """

    def __init__(
        self,
        base_url: str,
        bearer_token: str = "",
        *,
        timeout_seconds: float = 240.0,
        event_timeout_seconds: float | None = None,
        gateway_base_url: str = "",
        gateway_token: str = "",
        default_provider: str = "",
        default_model: str = "",
    ):
        clean_base = str(base_url or "").strip().rstrip("/")
        parsed = urllib.parse.urlparse(clean_base)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("Agent runtime base_url must be an http(s) URL")
        if parsed.query or parsed.fragment:
            raise ValueError("Agent runtime base_url must not contain a query or fragment")
        if timeout_seconds <= 0:
            raise ValueError("Agent runtime timeout_seconds must be positive")
        if event_timeout_seconds is not None and event_timeout_seconds <= 0:
            raise ValueError("Agent runtime event_timeout_seconds must be positive")
        self._validate_header_value("bearer_token", bearer_token)
        self._validate_header_value("gateway_token", gateway_token)

        self.base_url = clean_base
        self.bearer_token = str(bearer_token or "")
        self.timeout_seconds = float(timeout_seconds)
        self.event_timeout_seconds = float(event_timeout_seconds or timeout_seconds)
        self.gateway_base_url = str(gateway_base_url or "").strip().rstrip("/")
        self.gateway_token = str(gateway_token or "")
        self.default_provider = str(default_provider or "").strip()
        self.default_model = str(default_model or "").strip()
        self._approval_lock = threading.Lock()
        self._pending_approvals: dict[str, str] = {}

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
        model: str | dict[str, Any] | None = None,
        thinking_depth: str | None = None,
        reasoning_config: dict[str, Any] | None = None,
        progress_callback: AgentProgressCallback | None = None,
        content_callback: AgentContentCallback | None = None,
        run_started_callback: AgentRunStartedCallback | None = None,
    ) -> AgentResult:
        clean_session_id = str(session_id or "").strip()
        clean_scope_key = str(session_key or "").strip()
        if not clean_session_id:
            raise ValueError("session_id is required")
        if not clean_scope_key:
            raise ValueError("session_key is required")

        clean_metadata = dict(metadata or {})
        body: dict[str, Any] = {
            "scope_key": clean_scope_key,
            "session_id": clean_session_id,
            "system_prompt": str(system_prompt or ""),
            "input": str(user_message or ""),
            "history": self._normalize_history(history),
            "attachments": self._normalize_attachments(attachments or []),
            "metadata": clean_metadata,
        }
        lifecycle_id = self._lifecycle_id(clean_metadata)
        if lifecycle_id:
            body["lifecycle_id"] = lifecycle_id
        workspace = self._workspace(clean_metadata)
        if workspace:
            body["workspace"] = workspace
        model_payload = self._model_payload(model, reasoning_config, clean_metadata)
        if model_payload:
            body["model"] = model_payload
        thinking_level = str(thinking_depth or "").strip()
        if thinking_level:
            body["thinking_level"] = thinking_level
        if self.gateway_base_url:
            body["gateway"] = {
                "base_url": self.gateway_base_url,
                "token": self.gateway_token,
            }

        idempotency_key = str(clean_metadata.get("idempotency_key") or "").strip()
        attempts = 2 if idempotency_key else 1
        for attempt in range(attempts):
            try:
                start, headers = self._json_request(
                    "POST", "/v1/runs", body, timeout=self.timeout_seconds
                )
                break
            except (AgentRuntimeConnectionError, AgentRuntimeTimeoutError) as exc:
                if attempt + 1 < attempts:
                    continue
                # The server may have durably accepted the request before its
                # response was lost. An idempotent retry closes the common
                # window; if it still fails, quarantine instead of reporting a
                # safe failure or submitting the same side effects again.
                raise AgentRuntimeRunError(
                    f"idempotency:{idempotency_key}" if idempotency_key else "unknown",
                    "needs_review",
                    f"run submission outcome is unknown: {exc}",
                ) from exc
        run_id = str(start.get("run_id") or "").strip()
        if not run_id:
            raise AgentRuntimeRunError(
                f"idempotency:{idempotency_key}" if idempotency_key else "unknown",
                "needs_review",
                "POST /v1/runs returned without a run_id after accepting the request",
                raw={"start": start},
            )
        if run_started_callback is not None:
            # This is the exact submission boundary used by the platform's
            # lifecycle barrier: the runtime has returned a durable run id, so
            # a concurrent scope cleanup can now discover and cancel the run.
            run_started_callback(run_id)
        response_session = str(start.get("session_id") or headers.get("X-Agent-Session-Id") or clean_session_id)
        events_path = self._events_path(start.get("events_url"), run_id)
        request = urllib.request.Request(
            self._url(events_path),
            headers=self._headers(accept="text/event-stream"),
            method="GET",
        )
        try:
            response = self._open(request, timeout=self.event_timeout_seconds)
            try:
                content_type = str(response.headers.get("Content-Type") or "")
                if "text/event-stream" not in content_type.lower():
                    raise AgentRuntimeProtocolError(
                        f"Agent run {run_id} events endpoint returned {content_type or 'no Content-Type'}"
                    )
                return self._read_run_events(
                    response,
                    response_session=response_session,
                    run_id=run_id,
                    start_payload=start,
                    model=model_payload,
                    progress_callback=progress_callback,
                    content_callback=content_callback,
                )
            finally:
                response.close()
        except AgentRuntimeRunError:
            raise
        except (AgentRuntimeTimeoutError, AgentRuntimeConnectionError) as exc:
            self._cancel_after_stream_failure(run_id)
            raise AgentRuntimeRunError(
                run_id,
                "needs_review",
                f"event stream became unavailable and cancellation was requested: {exc}",
            ) from exc
        except (socket.timeout, TimeoutError) as exc:
            self._cancel_after_stream_failure(run_id)
            raise AgentRuntimeRunError(
                run_id,
                "needs_review",
                f"event stream timed out after {self.event_timeout_seconds:g} seconds; cancellation was requested",
            ) from exc
        except OSError as exc:
            self._cancel_after_stream_failure(run_id)
            raise AgentRuntimeRunError(
                run_id,
                "needs_review",
                f"event stream failed and cancellation was requested: {exc}",
            ) from exc
        except Exception:
            self._cancel_after_stream_failure(run_id)
            raise

    def respond_approval(
        self,
        *,
        run_id: str,
        choice: str,
        approval_id: str | None = None,
    ) -> dict[str, Any]:
        clean_run_id = self._required_id("run_id", run_id)
        decision = str(choice or "").strip().lower()
        if decision not in _APPROVAL_CHOICES:
            raise ValueError("choice must be once, session, always, or deny")
        clean_approval_id = str(approval_id or "").strip()
        if not clean_approval_id:
            with self._approval_lock:
                clean_approval_id = self._pending_approvals.get(clean_run_id, "")
        if not clean_approval_id:
            raise ValueError(f"no pending approval is known for run {clean_run_id}")
        result, _ = self._json_request(
            "POST",
            f"/v1/runs/{urllib.parse.quote(clean_run_id, safe='')}/approval",
            {"approval_id": clean_approval_id, "decision": decision},
            timeout=self.timeout_seconds,
        )
        with self._approval_lock:
            if self._pending_approvals.get(clean_run_id) == clean_approval_id:
                self._pending_approvals.pop(clean_run_id, None)
        return result

    def steer_run(
        self,
        *,
        run_id: str,
        message_id: str,
        scope_key: str,
        lifecycle_id: str,
        user_message: str,
        attachments: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        clean_run_id = self._required_id("run_id", run_id)
        clean_message_id = self._required_id("message_id", message_id)
        body = {
            "message_id": clean_message_id,
            "scope_key": self._required_id("scope_key", scope_key),
            "lifecycle_id": self._required_id("lifecycle_id", lifecycle_id),
            "input": str(user_message or ""),
            "attachments": self._normalize_attachments(attachments or []),
        }
        path = f"/v1/runs/{urllib.parse.quote(clean_run_id, safe='')}/input"
        for attempt in range(2):
            try:
                result, _ = self._json_request(
                    "POST",
                    path,
                    body,
                    timeout=min(self.timeout_seconds, 15.0),
                )
                break
            except (AgentRuntimeConnectionError, AgentRuntimeTimeoutError):
                if attempt == 0:
                    continue
                raise
        state = str(result.get("state") or "").strip()
        if (
            str(result.get("run_id") or "") != clean_run_id
            or str(result.get("message_id") or "") != clean_message_id
            or state not in {"accepted", "injected"}
        ):
            raise AgentRuntimeProtocolError(
                f"Agent runtime POST {path} returned an invalid input acknowledgement"
            )
        return result

    def cancel_run(self, run_id: str) -> dict[str, Any]:
        clean_run_id = self._required_id("run_id", run_id)
        result, _ = self._json_request(
            "POST",
            f"/v1/runs/{urllib.parse.quote(clean_run_id, safe='')}/cancel",
            {},
            timeout=min(self.timeout_seconds, 10.0),
        )
        with self._approval_lock:
            self._pending_approvals.pop(clean_run_id, None)
        return result

    def cleanup_scope(
        self,
        scope_key: str,
        lifecycle_id: str | None = None,
        *,
        delete_sessions: bool = False,
    ) -> dict[str, Any]:
        clean_scope_key = self._required_id("scope_key", scope_key)
        body: dict[str, Any] = {
            "scope_key": clean_scope_key,
            "delete_sessions": bool(delete_sessions),
        }
        clean_lifecycle = str(lifecycle_id or "").strip()
        if clean_lifecycle:
            body["lifecycle_id"] = clean_lifecycle
        result, _ = self._json_request(
            "POST",
            "/v1/scopes/cleanup",
            body,
            timeout=min(self.timeout_seconds, 10.0),
        )
        return result

    def health(self) -> dict[str, Any]:
        result, _ = self._json_request(
            "GET",
            "/health",
            None,
            timeout=min(self.timeout_seconds, 10.0),
        )
        return result

    def terminal_previews(
        self,
        scope_key: str,
        lifecycle_id: str,
    ) -> dict[str, Any]:
        """Fetch the bounded read-only process view for one root Agent scope."""

        clean_scope_key = self._required_id("scope_key", scope_key)
        clean_lifecycle_id = self._required_id("lifecycle_id", lifecycle_id)
        query = urllib.parse.urlencode(
            {
                "scope_key": clean_scope_key,
                "lifecycle_id": clean_lifecycle_id,
            }
        )
        result, _ = self._json_request(
            "GET",
            f"/v1/scopes/processes?{query}",
            None,
            timeout=min(self.timeout_seconds, 5.0),
            max_response_bytes=2 * 1024 * 1024,
        )
        if not isinstance(result.get("processes"), list):
            raise AgentRuntimeProtocolError("Agent runtime process preview has no processes list")
        return result

    def terminal_preview_summary(
        self,
        scope_key: str,
        lifecycle_id: str,
    ) -> dict[str, Any]:
        """Fetch the live process count without transferring terminal output."""

        clean_scope_key = self._required_id("scope_key", scope_key)
        clean_lifecycle_id = self._required_id("lifecycle_id", lifecycle_id)
        query = urllib.parse.urlencode(
            {
                "scope_key": clean_scope_key,
                "lifecycle_id": clean_lifecycle_id,
            }
        )
        result, _ = self._json_request(
            "GET",
            f"/v1/scopes/process-summary?{query}",
            None,
            timeout=min(self.timeout_seconds, 5.0),
            max_response_bytes=64 * 1024,
        )
        count = result.get("running_terminal_count")
        if not isinstance(count, int) or isinstance(count, bool) or count < 0:
            raise AgentRuntimeProtocolError(
                "Agent runtime process summary has an invalid running terminal count"
            )
        return {"running_terminal_count": count}

    def update_blocker_summary(self) -> dict[str, int]:
        """Fetch global background-terminal counts without process details."""

        result, _ = self._json_request(
            "GET",
            "/v1/processes/update-blockers",
            None,
            timeout=min(self.timeout_seconds, 5.0),
            max_response_bytes=64 * 1024,
        )
        summary: dict[str, int] = {}
        for field in (
            "running_background_terminal_count",
            "update_blocking_terminal_count",
            "terminable_background_terminal_count",
        ):
            count = result.get(field)
            if not isinstance(count, int) or isinstance(count, bool) or count < 0:
                raise AgentRuntimeProtocolError(
                    f"Agent runtime update blocker summary has an invalid {field}"
                )
            summary[field] = count
        if (
            summary["running_background_terminal_count"]
            != summary["update_blocking_terminal_count"]
            + summary["terminable_background_terminal_count"]
        ):
            raise AgentRuntimeProtocolError(
                "Agent runtime update blocker summary has inconsistent counts"
            )
        return summary

    def _cancel_after_stream_failure(self, run_id: str) -> None:
        """Fail closed when the client can no longer observe a live run."""

        try:
            self.cancel_run(run_id)
        except AgentRuntimeError:
            pass

    def _read_run_events(
        self,
        response: Any,
        *,
        response_session: str,
        run_id: str,
        start_payload: dict[str, Any],
        model: dict[str, Any] | None,
        progress_callback: AgentProgressCallback | None,
        content_callback: AgentContentCallback | None,
    ) -> AgentResult:
        content_parts: list[str] = []
        final_output = ""
        final_session_id = response_session
        usage: dict[str, Any] | None = None
        terminal_type = ""
        terminal_error = ""
        current_turn_id = ""
        raw_events: list[dict[str, Any]] = []
        event_count = 0
        event_name = "message"
        data_lines: list[str] = []

        def dispatch() -> bool:
            nonlocal data_lines, event_name, event_count
            nonlocal final_output, final_session_id, usage, terminal_type, terminal_error
            nonlocal current_turn_id, content_parts
            if not data_lines:
                event_name = "message"
                return False
            data_text = "\n".join(data_lines)
            frame_event = event_name
            data_lines = []
            event_name = "message"
            try:
                wire = json.loads(data_text)
            except json.JSONDecodeError:
                raw_events.append({"event": frame_event, "_parse_error": data_text[:500]})
                del raw_events[:-50]
                event_count += 1
                return False
            if not isinstance(wire, dict):
                raw_events.append({"event": frame_event, "data": wire})
                del raw_events[:-50]
                event_count += 1
                return False

            event_count += 1
            raw_events.append(wire)
            del raw_events[:-50]
            event_type = str(wire.get("type") or wire.get("event") or frame_event or "").strip()
            event_data = wire.get("data")
            if isinstance(event_data, dict):
                payload = dict(event_data)
            else:
                payload = {"data": event_data} if event_data is not None else dict(wire)
            payload.setdefault("run_id", str(wire.get("run_id") or run_id))
            if "sequence" in wire:
                payload.setdefault("sequence", wire["sequence"])
            if "timestamp" in wire:
                payload.setdefault("runtime_timestamp", wire["timestamp"])
                payload.setdefault("timestamp", _callback_timestamp(wire["timestamp"]))
            payload.setdefault("runtime_event_type", event_type)
            payload.setdefault("event", _PLATFORM_EVENT_NAMES.get(event_type, event_type))
            if event_type.startswith("tool."):
                tool_name = str(payload.get("tool") or payload.get("tool_name") or "").strip()
                if tool_name:
                    payload.setdefault("tool", tool_name)

            if event_type == "message.delta":
                turn_id = str(payload.get("turn_id") or "").strip()
                if turn_id and current_turn_id and turn_id != current_turn_id:
                    content_parts = []
                    final_output = ""
                    self._emit_content(
                        content_callback,
                        None,
                        turn_id=turn_id,
                        turn_index=payload.get("turn_index"),
                    )
                if turn_id:
                    current_turn_id = turn_id
                delta = _text_from_content(payload.get("delta", payload.get("content")))
                if delta:
                    content_parts.append(delta)
                    self._emit_content(
                        content_callback,
                        delta,
                        turn_id=turn_id,
                        turn_index=payload.get("turn_index"),
                    )
                return False
            if event_type == "message.final":
                turn_id = str(payload.get("turn_id") or "").strip()
                if turn_id:
                    current_turn_id = turn_id
                final_output = _text_from_content(payload.get("output", payload.get("content")))
                return False
            if event_type == "input.injected":
                turn_id = str(payload.get("turn_id") or "").strip()
                if turn_id and turn_id != current_turn_id:
                    current_turn_id = turn_id
                    content_parts = []
                    final_output = ""
                    self._emit_content(
                        content_callback,
                        None,
                        turn_id=turn_id,
                        turn_index=payload.get("turn_index"),
                    )
            if event_type == "approval.requested":
                approval_id = str(payload.get("approval_id") or payload.get("id") or "").strip()
                payload.setdefault("description", str(payload.get("reason") or "").strip())
                arguments = payload.get("arguments")
                if isinstance(arguments, dict) and arguments.get("command"):
                    payload.setdefault("command", str(arguments["command"]))
                if approval_id:
                    with self._approval_lock:
                        self._pending_approvals[run_id] = approval_id
            elif event_type == "approval.resolved":
                payload.setdefault("choice", str(payload.get("decision") or "").strip())
                approval_id = str(payload.get("approval_id") or payload.get("id") or "").strip()
                with self._approval_lock:
                    if not approval_id or self._pending_approvals.get(run_id) == approval_id:
                        self._pending_approvals.pop(run_id, None)

            if event_type == "run.completed":
                terminal_type = event_type
                completed_output = _text_from_content(payload.get("output", payload.get("content")))
                if completed_output:
                    final_output = completed_output
                event_session = str(payload.get("session_id") or "").strip()
                if event_session:
                    final_session_id = event_session
                raw_usage = payload.get("usage")
                if isinstance(raw_usage, dict):
                    usage = raw_usage
                for key in ("input_message_ids", "unconsumed_input_message_ids"):
                    values = payload.get(key)
                    if isinstance(values, list):
                        raw_values = [str(value) for value in values if str(value or "").strip()]
                        payload[key] = raw_values
                return True
            if event_type in _TERMINAL_EVENTS - {"run.completed"}:
                terminal_type = event_type
                terminal_error = _error_message(payload) or event_type
                for key in ("input_message_ids", "unconsumed_input_message_ids"):
                    values = payload.get(key)
                    if isinstance(values, list):
                        payload[key] = [
                            str(value) for value in values if str(value or "").strip()
                        ]
                return True

            if event_type in _PROGRESS_EVENT_TYPES:
                self._emit_progress(progress_callback, payload)
            return False

        for raw_line in response:
            line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
            if not line:
                if dispatch():
                    break
                continue
            if line.startswith(":"):
                continue
            field, separator, value = line.partition(":")
            if not separator:
                continue
            if value.startswith(" "):
                value = value[1:]
            if field == "event":
                event_name = value or "message"
            elif field == "data":
                data_lines.append(value)
        if data_lines and not terminal_type:
            dispatch()

        content = final_output or "".join(content_parts)
        raw: dict[str, Any] = {
            "mode": "agent-runtime",
            "run_id": run_id,
            "start": start_payload,
            "event_count": event_count,
            "events": raw_events,
        }
        if model:
            raw["model"] = model.get("id") or model
            raw["model_config"] = model
        if usage is not None:
            raw["usage"] = usage
        terminal_payload = next(
            (
                event.get("data")
                for event in reversed(raw_events)
                if isinstance(event, dict)
                and str(event.get("type") or event.get("event") or "") == terminal_type
                and isinstance(event.get("data"), dict)
            ),
            {},
        )
        if isinstance(terminal_payload, dict):
            for key in ("input_message_ids", "unconsumed_input_message_ids"):
                values = terminal_payload.get(key)
                if isinstance(values, list):
                    raw[key] = [
                        str(value) for value in values if str(value or "").strip()
                    ]
        if terminal_type in _TERMINAL_EVENTS - {"run.completed"}:
            raw["error"] = terminal_error
            raw["terminal_event"] = terminal_type
            state = terminal_type.removeprefix("run.")
            raise AgentRuntimeRunError(
                run_id,
                state,
                terminal_error,
                partial_content=content,
                session_id=final_session_id,
                raw=raw,
            )
        if terminal_type != "run.completed":
            message = f"Agent run {run_id} event stream ended before a terminal event"
            raw["error"] = message
            # An EOF is not a successful hand-off: the sidecar may still be
            # running tools after the platform has lost its event stream.
            # Cancel before returning a partial response so execution fails
            # closed and does not continue invisibly in the background.
            self._cancel_after_stream_failure(run_id)
            raise AgentRuntimeRunError(
                run_id,
                "needs_review",
                f"{message}; cancellation was requested",
                partial_content=content,
                session_id=final_session_id,
                raw=raw,
            )
        if not content:
            raise AgentRuntimeProtocolError(
                f"Agent run {run_id} completed without assistant content after {event_count} events"
            )
        return AgentResult(content=content, session_id=final_session_id, raw=raw)

    def _json_request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None,
        *,
        timeout: float,
        max_response_bytes: int | None = None,
    ) -> tuple[dict[str, Any], Any]:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        request = urllib.request.Request(
            self._url(path),
            data=data,
            headers=self._headers(accept="application/json", content_type=body is not None),
            method=method,
        )
        response = self._open(request, timeout=timeout)
        try:
            # HTTPResponse.read(-1) is not equivalent to read() for chunked
            # responses on Python 3.11: the former can bypass chunk decoding
            # and leave the terminating ``0\r\n\r\n`` in the JSON body.
            # Pass an explicit size only when enforcing a response limit.
            raw_bytes = (
                response.read()
                if max_response_bytes is None
                else response.read(max_response_bytes + 1)
            )
            if max_response_bytes is not None and len(raw_bytes) > max_response_bytes:
                raise AgentRuntimeProtocolError(
                    f"Agent runtime {method} {path} response exceeded {max_response_bytes} bytes"
                )
            headers = response.headers
        except (socket.timeout, TimeoutError) as exc:
            raise AgentRuntimeTimeoutError(
                f"Agent runtime {method} {path} timed out after {timeout:g} seconds"
            ) from exc
        except OSError as exc:
            raise AgentRuntimeConnectionError(f"Agent runtime {method} {path} failed: {exc}") from exc
        finally:
            response.close()
        try:
            parsed = json.loads(raw_bytes.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise AgentRuntimeProtocolError(
                f"Agent runtime {method} {path} returned invalid JSON"
            ) from exc
        if not isinstance(parsed, dict):
            raise AgentRuntimeProtocolError(
                f"Agent runtime {method} {path} returned a non-object JSON response"
            )
        return parsed, headers

    def _open(self, request: urllib.request.Request, *, timeout: float) -> Any:
        try:
            return urllib.request.urlopen(request, timeout=timeout)
        except urllib.error.HTTPError as exc:
            try:
                response_body = exc.read(65536).decode("utf-8", errors="replace")
            except OSError:
                response_body = ""
            raise AgentRuntimeHTTPError(
                exc.code,
                _http_error_message(response_body, str(exc.reason or exc)),
                response_body,
            ) from exc
        except urllib.error.URLError as exc:
            if isinstance(exc.reason, (socket.timeout, TimeoutError)):
                raise AgentRuntimeTimeoutError(
                    f"Agent runtime request timed out after {timeout:g} seconds"
                ) from exc
            raise AgentRuntimeConnectionError(f"Unable to reach Agent runtime: {exc.reason}") from exc
        except (socket.timeout, TimeoutError) as exc:
            raise AgentRuntimeTimeoutError(
                f"Agent runtime request timed out after {timeout:g} seconds"
            ) from exc
        except OSError as exc:
            raise AgentRuntimeConnectionError(f"Unable to reach Agent runtime: {exc}") from exc

    def _headers(self, *, accept: str, content_type: bool = False) -> dict[str, str]:
        headers = {"Accept": accept, "User-Agent": "ubitech-agent-platform/agent-runtime-client"}
        if content_type:
            headers["Content-Type"] = "application/json"
        if self.bearer_token:
            headers["Authorization"] = f"Bearer {self.bearer_token}"
        return headers

    def _url(self, path: str) -> str:
        return f"{self.base_url}/{str(path or '').lstrip('/')}"

    def _events_path(self, events_url: Any, run_id: str) -> str:
        default = f"/v1/runs/{urllib.parse.quote(run_id, safe='')}/events"
        candidate = str(events_url or "").strip()
        if not candidate:
            return default
        parsed = urllib.parse.urlparse(candidate)
        if not parsed.scheme and not parsed.netloc:
            return candidate if candidate.startswith("/") else f"/{candidate}"
        base = urllib.parse.urlparse(self.base_url)
        if (parsed.scheme, parsed.netloc) != (base.scheme, base.netloc):
            raise AgentRuntimeProtocolError("Agent runtime returned a cross-origin events_url")
        path = parsed.path or default
        return f"{path}?{parsed.query}" if parsed.query else path

    @staticmethod
    def _normalize_history(history: list[dict[str, Any]]) -> list[dict[str, Any]]:
        normalized: list[dict[str, Any]] = []
        for message in list(history or [])[-30:]:
            if not isinstance(message, dict):
                continue
            role = str(message.get("role") or "").strip()
            content = message.get("content")
            if role and content not in (None, ""):
                normalized.append({"role": role, "content": content})
        return normalized

    @staticmethod
    def _normalize_attachments(attachments: list[dict[str, Any]]) -> list[dict[str, str]]:
        normalized: list[dict[str, str]] = []
        for attachment in attachments:
            if not isinstance(attachment, dict):
                continue
            path = str(attachment.get("path") or attachment.get("local_path") or "").strip()
            if not path:
                continue
            item = {"path": path}
            mime_type = str(attachment.get("mime_type") or "").strip()
            name = str(attachment.get("name") or attachment.get("filename") or "").strip()
            if mime_type:
                item["mime_type"] = mime_type
            if name:
                item["name"] = name
            normalized.append(item)
        return normalized

    def _model_payload(
        self,
        model: str | dict[str, Any] | None,
        reasoning_config: dict[str, Any] | None,
        metadata: dict[str, Any],
    ) -> dict[str, Any] | None:
        if isinstance(model, dict):
            result = dict(model)
        else:
            model_id = str(model or self.default_model).strip()
            result = {"id": model_id} if model_id else {}
        provider = str(
            metadata.get("provider")
            or metadata.get("model_provider")
            or self.default_provider
            or ""
        ).strip()
        if provider and not result.get("provider"):
            result["provider"] = provider
        if reasoning_config:
            result["reasoning"] = bool(reasoning_config.get("enabled", True))
        return result or None

    @staticmethod
    def _lifecycle_id(metadata: dict[str, Any]) -> str:
        execution = metadata.get("execution")
        if isinstance(execution, dict):
            value = execution.get("lifecycle_id")
            if value:
                return str(value).strip()
        return str(metadata.get("lifecycle_id") or "").strip()

    @staticmethod
    def _workspace(metadata: dict[str, Any]) -> str:
        workspace = metadata.get("workspace")
        if isinstance(workspace, dict):
            value = workspace.get("path")
        else:
            value = workspace
        if not value:
            execution = metadata.get("execution")
            value = execution.get("workspace_path") if isinstance(execution, dict) else ""
        return str(value or "").strip()

    @staticmethod
    def _required_id(name: str, value: Any) -> str:
        clean = str(value or "").strip()
        if not clean:
            raise ValueError(f"{name} is required")
        return clean

    @staticmethod
    def _validate_header_value(name: str, value: Any) -> None:
        if "\r" in str(value or "") or "\n" in str(value or ""):
            raise ValueError(f"{name} contains an invalid newline")

    @staticmethod
    def _emit_progress(callback: AgentProgressCallback | None, payload: dict[str, Any]) -> None:
        if callback is None:
            return
        try:
            callback(payload)
        except Exception:
            return

    @staticmethod
    def _emit_content(
        callback: AgentContentCallback | None,
        content: str | None,
        *,
        turn_id: str = "",
        turn_index: Any = 0,
    ) -> None:
        if callback is None:
            return
        try:
            signature = inspect.signature(callback)
            parameters = signature.parameters
            supports_turn_metadata = (
                "turn_id" in parameters
                and "turn_index" in parameters
            ) or any(
                parameter.kind == inspect.Parameter.VAR_KEYWORD
                for parameter in parameters.values()
            )
        except (TypeError, ValueError):
            supports_turn_metadata = False
        try:
            if supports_turn_metadata:
                try:
                    clean_turn_index = max(0, int(turn_index or 0))
                except (TypeError, ValueError):
                    clean_turn_index = 0
                callback(
                    content,
                    turn_id=str(turn_id or ""),
                    turn_index=clean_turn_index,
                )
            else:
                callback(content)
        except Exception:
            return


def _text_from_content(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(_text_from_content(item) for item in value)
    if isinstance(value, dict):
        value_type = str(value.get("type") or "").strip()
        if value_type in {"text", "output_text", "input_text"} and isinstance(value.get("text"), str):
            return str(value["text"])
        for key in ("text", "content", "output"):
            text = _text_from_content(value.get(key))
            if text:
                return text
    return ""


def _error_message(payload: dict[str, Any]) -> str:
    error = payload.get("error")
    if isinstance(error, dict):
        for key in ("message", "detail", "error"):
            value = error.get(key)
            if value:
                return str(value).strip()
        return json.dumps(error, ensure_ascii=False)[:1000]
    if error:
        return str(error).strip()
    for key in ("message", "detail", "reason"):
        value = payload.get(key)
        if value:
            return str(value).strip()
    return ""


def _http_error_message(response_body: str, fallback: str) -> str:
    if response_body:
        try:
            payload = json.loads(response_body)
        except json.JSONDecodeError:
            payload = None
        if isinstance(payload, dict):
            message = _error_message(payload)
            if message:
                return message
        clean_body = response_body.strip()
        if clean_body:
            return clean_body[:1000]
    return str(fallback or "request failed")


def _callback_timestamp(value: Any) -> Any:
    """Return epoch seconds for platform callbacks while retaining wire time separately."""

    if isinstance(value, (int, float)):
        return value
    text = str(value or "").strip()
    if not text:
        return value
    try:
        return float(text)
    except ValueError:
        pass
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return value
