"""Runtime patches for managed Hermes Agent processes.

This module is loaded by Python's sitecustomize hook when Enterprise Agent
Platform starts the managed Hermes gateway. Keep it narrow: it patches only
known integration issues in the embedded Hermes runtime and leaves standalone
Hermes installs untouched.
"""

from __future__ import annotations

import logging
from types import SimpleNamespace
from typing import Any

logger = logging.getLogger(__name__)


def _event_value(event: Any, name: str, default: Any = None) -> Any:
    if isinstance(event, dict):
        return event.get(name, default)
    return getattr(event, name, default)


def _message_text(item: Any) -> str:
    if _event_value(item, "type") != "message":
        return ""
    content = _event_value(item, "content")
    if not isinstance(content, list):
        return ""
    chunks: list[str] = []
    for part in content:
        part_type = _event_value(part, "type")
        if part_type not in {"output_text", "text"}:
            continue
        text = _event_value(part, "text")
        if isinstance(text, str) and text:
            chunks.append(text)
    return "".join(chunks).strip()


def _synthesized_message(text: str) -> Any:
    return SimpleNamespace(
        type="message",
        role="assistant",
        status="completed",
        content=[SimpleNamespace(type="output_text", text=text)],
    )


def _backfill_response_output(response: Any, output_items: list[Any], text_deltas: list[str]) -> Any:
    if response is None:
        return SimpleNamespace(
            status="completed",
            output=[_synthesized_message("".join(text_deltas))] if text_deltas else list(output_items),
        )

    output = _event_value(response, "output")
    if isinstance(output, list) and output:
        return response

    items = list(output_items)
    text = "".join(text_deltas)
    if text and not any(_message_text(item) for item in items):
        items.append(_synthesized_message(text))

    try:
        response.output = items
    except Exception:
        response = SimpleNamespace(
            status=_event_value(response, "status", "completed"),
            output=items,
            error=_event_value(response, "error"),
            incomplete_details=_event_value(response, "incomplete_details"),
        )
    return response


def _stream_error_event(message: str, *, code: Any = None, param: Any = None) -> Exception:
    try:
        from run_agent import _StreamErrorEvent

        return _StreamErrorEvent(message, code=code, param=param)
    except Exception:
        return RuntimeError(message)


def _run_raw_responses_stream(agent: Any, api_kwargs: dict[str, Any], client: Any = None, on_first_delta: Any = None) -> Any:
    active_client = client or agent._ensure_primary_openai_client(reason="codex_raw_stream")
    stream_kwargs = dict(api_kwargs)
    stream_kwargs["stream"] = True
    try:
        stream_kwargs = agent._get_transport().preflight_kwargs(stream_kwargs, allow_stream=True)
    except Exception:
        pass

    stream_or_response = active_client.responses.create(**stream_kwargs)
    if hasattr(stream_or_response, "output"):
        return _backfill_response_output(stream_or_response, [], [])
    if not hasattr(stream_or_response, "__iter__"):
        return stream_or_response

    output_items: list[Any] = []
    text_deltas: list[str] = []
    terminal_response = None
    has_tool_calls = False
    first_delta_fired = False

    try:
        for event in stream_or_response:
            agent._touch_activity("receiving stream response")
            if getattr(agent, "_interrupt_requested", False):
                break

            event_type = str(_event_value(event, "type", "") or "")

            if event_type == "error":
                message = str(_event_value(event, "message", "") or "stream emitted error event").strip()
                raise _stream_error_event(
                    message,
                    code=_event_value(event, "code"),
                    param=_event_value(event, "param"),
                )

            if "function_call" in event_type:
                has_tool_calls = True

            if event_type == "response.output_item.done":
                item = _event_value(event, "item")
                if item is not None:
                    output_items.append(item)
            elif event_type == "response.content_part.done":
                part = _event_value(event, "part")
                if part is not None and _event_value(part, "type") in {"output_text", "text"}:
                    text = _event_value(part, "text")
                    if isinstance(text, str) and text and not text_deltas:
                        text_deltas.append(text)
            elif "output_text.delta" in event_type:
                delta = _event_value(event, "delta", "")
                if isinstance(delta, str) and delta:
                    text_deltas.append(delta)
                    if not has_tool_calls:
                        if not first_delta_fired:
                            first_delta_fired = True
                            if on_first_delta:
                                try:
                                    on_first_delta()
                                except Exception:
                                    pass
                        agent._fire_stream_delta(delta)
            elif "reasoning" in event_type and "delta" in event_type:
                reasoning = _event_value(event, "delta", "")
                if isinstance(reasoning, str) and reasoning:
                    agent._fire_reasoning_delta(reasoning)

            if event_type not in {"response.completed", "response.incomplete", "response.failed"}:
                continue

            terminal_response = _event_value(event, "response")
            return _backfill_response_output(terminal_response, output_items, text_deltas)
    finally:
        close_fn = getattr(stream_or_response, "close", None)
        if callable(close_fn):
            try:
                close_fn()
            except Exception:
                pass

    return _backfill_response_output(terminal_response, output_items, text_deltas)


def _install_codex_response_stream_patch() -> None:
    try:
        from agent import codex_runtime
    except Exception:
        return
    if getattr(codex_runtime, "_enterprise_response_stream_patch", False):
        return

    def run_codex_stream(agent: Any, api_kwargs: dict[str, Any], client: Any = None, on_first_delta: Any = None) -> Any:
        return _run_raw_responses_stream(agent, api_kwargs, client=client, on_first_delta=on_first_delta)

    def run_codex_create_stream_fallback(agent: Any, api_kwargs: dict[str, Any], client: Any = None) -> Any:
        return _run_raw_responses_stream(agent, api_kwargs, client=client)

    codex_runtime.run_codex_stream = run_codex_stream
    codex_runtime.run_codex_create_stream_fallback = run_codex_create_stream_fallback
    codex_runtime._enterprise_response_stream_patch = True


try:
    _install_codex_response_stream_patch()
except Exception as exc:
    logger.debug("Enterprise Hermes runtime patch did not install: %s", exc)
