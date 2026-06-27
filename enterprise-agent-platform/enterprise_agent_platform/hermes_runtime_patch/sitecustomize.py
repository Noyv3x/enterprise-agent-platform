"""Runtime patches for managed Hermes Agent processes.

This module is loaded by Python's sitecustomize hook when Enterprise Agent
Platform starts the managed Hermes gateway. Keep it narrow: it patches only
known integration issues in the embedded Hermes runtime and leaves standalone
Hermes installs untouched.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections import deque
from types import SimpleNamespace
from typing import Any

logger = logging.getLogger(__name__)

# Aggregated, process-visible status string the platform can surface after the
# managed Hermes gateway starts. ``sitecustomize`` runs at interpreter startup
# before logging is configured, so a log record may never reach a handler; an
# environment marker survives so operators can detect a silent no-op patch.
_PATCH_STATUS_ENV = "ENTERPRISE_HERMES_PATCH_STATUS"
_patch_status: dict[str, str] = {}


def _record_patch_status(component: str, state: str) -> None:
    """Record per-component patch status and publish it to the environment."""

    _patch_status[component] = state
    try:
        os.environ[_PATCH_STATUS_ENV] = ";".join(
            f"{name}={value}" for name, value in sorted(_patch_status.items())
        )
    except Exception:
        pass


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


def _backfill_response_output(
    response: Any,
    output_items: list[Any],
    text_deltas: list[str],
    *,
    synthesize_text: bool = True,
) -> Any:
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
    if synthesize_text and text and not any(_message_text(item) for item in items):
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


class _RawResponsesStreamContext:
    """Small Responses.stream() substitute backed by responses.create(stream=True)."""

    def __init__(self, responses_resource: Any, stream_kwargs: dict[str, Any]):
        self._responses_resource = responses_resource
        self._stream_kwargs = dict(stream_kwargs)
        self._stream_kwargs["stream"] = True
        self._stream_or_response = None
        self._iterator = None
        self._output_items: list[Any] = []
        self._text_deltas: list[str] = []
        self._terminal_response = None
        self._has_function_calls = False

    def __enter__(self) -> "_RawResponsesStreamContext":
        self._stream_or_response = self._responses_resource.create(**self._stream_kwargs)
        if hasattr(self._stream_or_response, "output") or not hasattr(self._stream_or_response, "__iter__"):
            self._terminal_response = self._stream_or_response
            self._iterator = iter(())
        else:
            self._iterator = iter(self._stream_or_response)
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.close()

    def __iter__(self) -> "_RawResponsesStreamContext":
        return self

    def __next__(self) -> Any:
        if self._iterator is None:
            raise StopIteration

        event = next(self._iterator)
        event_type = str(_event_value(event, "type", "") or "")

        if event_type == "error":
            message = str(_event_value(event, "message", "") or "stream emitted error event").strip()
            raise _stream_error_event(
                message,
                code=_event_value(event, "code"),
                param=_event_value(event, "param"),
            )

        if "function_call" in event_type:
            self._has_function_calls = True

        if event_type == "response.output_item.done":
            item = _event_value(event, "item")
            if item is not None:
                self._output_items.append(item)
        elif event_type == "response.content_part.done":
            part = _event_value(event, "part")
            if part is not None and _event_value(part, "type") in {"output_text", "text"}:
                text = _event_value(part, "text")
                if isinstance(text, str) and text and not self._text_deltas:
                    self._text_deltas.append(text)
        elif "output_text.delta" in event_type:
            delta = _event_value(event, "delta", "")
            if isinstance(delta, str) and delta:
                self._text_deltas.append(delta)

        if event_type in {"response.completed", "response.incomplete", "response.failed"}:
            self._terminal_response = _event_value(event, "response")

        return event

    def get_final_response(self) -> Any:
        if self._terminal_response is None:
            get_final_response = getattr(self._stream_or_response, "get_final_response", None)
            if callable(get_final_response):
                self._terminal_response = get_final_response()
        return _backfill_response_output(
            self._terminal_response,
            self._output_items,
            self._text_deltas,
            synthesize_text=not self._has_function_calls,
        )

    def close(self) -> None:
        close_fn = getattr(self._stream_or_response, "close", None)
        if callable(close_fn):
            try:
                close_fn()
            except Exception:
                pass


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
        # Standalone Hermes installs lack this module; expected, not an error.
        _record_patch_status("codex", "no_module")
        return
    if getattr(codex_runtime, "_enterprise_response_stream_patch", False):
        _record_patch_status("codex", "ok")
        return

    def run_codex_stream(agent: Any, api_kwargs: dict[str, Any], client: Any = None, on_first_delta: Any = None) -> Any:
        return _run_raw_responses_stream(agent, api_kwargs, client=client, on_first_delta=on_first_delta)

    def run_codex_create_stream_fallback(agent: Any, api_kwargs: dict[str, Any], client: Any = None) -> Any:
        return _run_raw_responses_stream(agent, api_kwargs, client=client)

    codex_runtime.run_codex_stream = run_codex_stream
    codex_runtime.run_codex_create_stream_fallback = run_codex_create_stream_fallback
    codex_runtime._enterprise_response_stream_patch = True
    _record_patch_status("codex", "ok")


# Thread-local stash of the per-call raw-stream factory. The auxiliary patch
# installs a single permanent ``stream`` shim on each Responses resource (the
# OpenAI client exposes ``responses`` as a cached_property, so it is a shared
# singleton). Each ``create()`` call publishes its own factory here, so
# concurrent worker threads (async aux calls dispatched via asyncio.to_thread
# onto a shared sync adapter) each resolve their own substitute with no shared
# mutation, no restore window, and no global lock serializing parallel streams.
_aux_stream_state = threading.local()


def _install_auxiliary_response_stream_patch() -> None:
    try:
        from agent import auxiliary_client
    except Exception:
        # Standalone Hermes installs lack this module; expected, not an error.
        _record_patch_status("aux", "no_module")
        return

    adapter_cls = getattr(auxiliary_client, "_CodexCompletionsAdapter", None)
    if adapter_cls is None:
        # The module is present but the private symbol this monkeypatch depends
        # on is gone — almost certainly upstream drift at the next submodule
        # bump. This silently disables the auxiliary Codex raw-stream/backfill
        # behavior, so make it operator-visible rather than a quiet no-op.
        logger.warning(
            "Enterprise Hermes patch: auxiliary_client present but "
            "_CodexCompletionsAdapter missing; auxiliary Codex stream patch "
            "not applied (upstream drift?)"
        )
        _record_patch_status("aux", "missing_adapter")
        return
    if getattr(adapter_cls, "_enterprise_response_stream_patch", False):
        _record_patch_status("aux", "ok")
        return

    original_create = adapter_cls.create

    def create(self: Any, **kwargs: Any) -> Any:
        responses_resource = getattr(getattr(self, "_client", None), "responses", None)
        if responses_resource is None or not callable(getattr(responses_resource, "create", None)):
            return original_create(self, **kwargs)

        def raw_stream(**stream_kwargs: Any) -> _RawResponsesStreamContext:
            return _RawResponsesStreamContext(responses_resource, stream_kwargs)

        # Install a permanent, thread-aware ``stream`` shim on the shared
        # Responses singleton exactly once. The shim consults a thread-local
        # for the active raw-stream factory, so it never mutates shared state
        # per call and there is no restore window to clobber.
        stash = getattr(responses_resource, "_enterprise_stream_stash", None)
        if stash is None:
            class_stream = type(responses_resource).__dict__.get("stream")

            def stream_shim(*args: Any, **stream_kwargs: Any) -> Any:
                factory = getattr(_aux_stream_state, "factory", None)
                if factory is not None:
                    return factory(**stream_kwargs)
                # No active substitute on this thread: fall back to the real
                # SDK ``stream`` (a bound method when ``stream`` was an own
                # instance attribute, else the class descriptor).
                if class_stream is not None:
                    return class_stream(responses_resource, *args, **stream_kwargs)
                return _RawResponsesStreamContext(responses_resource, stream_kwargs)

            try:
                responses_resource.stream = stream_shim
                responses_resource._enterprise_stream_stash = stream_shim
            except Exception:
                # Read-only resource: fall back to the unpatched upstream path
                # rather than failing the auxiliary call.
                return original_create(self, **kwargs)

        previous = getattr(_aux_stream_state, "factory", None)
        _aux_stream_state.factory = raw_stream
        try:
            return original_create(self, **kwargs)
        finally:
            _aux_stream_state.factory = previous

    adapter_cls.create = create
    adapter_cls._enterprise_response_stream_patch = True
    _record_patch_status("aux", "ok")


def _install_api_async_delegation_patch() -> None:
    """Expose API-server async delegation completions for platform polling.

    Hermes' native gateway path reinjects ``delegate_task(background=true)``
    completions into chat adapters. The API server adapter has no push channel
    (`send()` is intentionally unsupported), so managed platform clients need a
    small authenticated poll endpoint instead.
    """

    try:
        from gateway.platforms import api_server as api_server_mod
        from gateway import run as gateway_run_mod
    except ModuleNotFoundError:
        _record_patch_status("api_async", "no_module")
        return
    except Exception as exc:
        _record_patch_status("api_async", f"import_error:{type(exc).__name__}")
        return

    adapter_cls = getattr(api_server_mod, "APIServerAdapter", None)
    runner_cls = getattr(gateway_run_mod, "GatewayRunner", None)
    if adapter_cls is None or runner_cls is None:
        _record_patch_status("api_async", "missing_symbols")
        return
    if getattr(adapter_cls, "_enterprise_async_delegation_patch", False):
        _record_patch_status("api_async", "ok")
        return

    try:
        max_events = max(1, int(os.environ.get("ENTERPRISE_HERMES_ASYNC_QUEUE_MAX", "500") or "500"))
    except (TypeError, ValueError):
        max_events = 500
    max_seen = max_events * 4
    original_init = adapter_cls.__init__
    original_connect = adapter_cls.connect
    original_inject = runner_cls._inject_watch_notification

    def _event_key(evt: dict[str, Any]) -> str:
        delegation_id = str(evt.get("delegation_id") or "").strip()
        if delegation_id:
            return delegation_id
        session_key = str(evt.get("session_key") or "").strip()
        completed_at = str(evt.get("completed_at") or evt.get("duration_seconds") or "")
        return f"{session_key}:{completed_at}:{evt.get('status') or ''}:{evt.get('goal') or ''}"

    def _is_api_async_event(evt: Any) -> bool:
        if not isinstance(evt, dict) or evt.get("type") != "async_delegation":
            return False
        platform = str(evt.get("platform") or "").strip().lower()
        if platform == "api_server":
            return True
        session_key = str(evt.get("session_key") or "").strip()
        if not session_key:
            return False
        if session_key.startswith("agent:main:api_server:"):
            return True
        return not session_key.startswith("agent:main:")

    def _init(self: Any, *args: Any, **kwargs: Any) -> None:
        original_init(self, *args, **kwargs)
        self._enterprise_async_delegation_events = deque()
        self._enterprise_async_delegation_seen = set()
        self._enterprise_async_delegation_seen_order = deque()
        self._enterprise_async_delegation_lock = threading.Lock()

    def record_async_delegation_event(self: Any, evt: dict[str, Any], message: str = "") -> bool:
        if not _is_api_async_event(evt):
            return False
        session_key = str(evt.get("session_key") or "").strip()
        if not session_key:
            return False
        item = dict(evt)
        if message:
            item["message"] = message
        item.setdefault("created_at", time.time())
        key = _event_key(item)
        with self._enterprise_async_delegation_lock:
            if key in self._enterprise_async_delegation_seen:
                return True
            self._enterprise_async_delegation_seen.add(key)
            self._enterprise_async_delegation_seen_order.append(key)
            while len(self._enterprise_async_delegation_seen_order) > max_seen:
                old_key = self._enterprise_async_delegation_seen_order.popleft()
                self._enterprise_async_delegation_seen.discard(old_key)
            self._enterprise_async_delegation_events.append(item)
            while len(self._enterprise_async_delegation_events) > max_events:
                self._enterprise_async_delegation_events.popleft()
        return True

    def _matching_async_events(
        self: Any,
        *,
        session_key: str = "",
        prefixes: list[str] | None = None,
        consume: bool = False,
    ) -> list[dict[str, Any]]:
        clean_prefixes = [p for p in (prefixes or []) if p]

        def matches(evt: dict[str, Any]) -> bool:
            evt_key = str(evt.get("session_key") or "")
            if session_key and evt_key != session_key:
                return False
            if clean_prefixes and not any(evt_key.startswith(prefix) for prefix in clean_prefixes):
                return False
            return True

        with self._enterprise_async_delegation_lock:
            matched: list[dict[str, Any]] = []
            remaining = deque()
            for evt in self._enterprise_async_delegation_events:
                if matches(evt):
                    matched.append(dict(evt))
                    if not consume:
                        remaining.append(evt)
                else:
                    remaining.append(evt)
            if consume:
                self._enterprise_async_delegation_events = remaining
            return matched

    async def _handle_async_delegations(self: Any, request: Any) -> Any:
        auth_err = self._check_auth(request)
        if auth_err:
            return auth_err
        query = request.rel_url.query
        consume_raw = str(query.get("consume", "")).strip().lower()
        consume = consume_raw in {"1", "true", "yes", "on"}
        session_key = str(query.get("session_key") or request.headers.get("X-Hermes-Session-Key", "")).strip()
        try:
            prefixes = [str(p).strip() for p in query.getall("session_key_prefix") if str(p).strip()]
        except Exception:
            prefixes = []
        events = self._matching_async_events(
            session_key=session_key,
            prefixes=prefixes,
            consume=consume,
        )
        return api_server_mod.web.json_response(
            {
                "object": "hermes.async_delegations",
                "count": len(events),
                "events": events,
            }
        )

    async def connect(self: Any, *args: Any, **kwargs: Any) -> Any:
        web_mod = getattr(api_server_mod, "web", None)
        dispatcher_cls = getattr(web_mod, "UrlDispatcher", None)
        if dispatcher_cls is None:
            return await original_connect(self, *args, **kwargs)

        original_add_get = dispatcher_cls.add_get
        route_added = False

        def add_get(router: Any, path: str, handler: Any, *h_args: Any, **h_kwargs: Any) -> Any:
            nonlocal route_added
            if not route_added and getattr(handler, "__self__", None) is self:
                original_add_get(router, "/api/async-delegations", self._handle_async_delegations)
                route_added = True
            return original_add_get(router, path, handler, *h_args, **h_kwargs)

        dispatcher_cls.add_get = add_get
        try:
            return await original_connect(self, *args, **kwargs)
        finally:
            dispatcher_cls.add_get = original_add_get

    def _record_on_api_adapter(runner: Any, evt: dict[str, Any], synth_text: str) -> bool:
        if not _is_api_async_event(evt):
            return False
        for platform, adapter in getattr(runner, "adapters", {}).items():
            platform_name = getattr(platform, "value", str(platform))
            if platform_name != "api_server":
                continue
            recorder = getattr(adapter, "record_async_delegation_event", None)
            if callable(recorder):
                return bool(recorder(evt, synth_text))
        return False

    async def _inject_watch_notification(self: Any, synth_text: str, evt: dict[str, Any]) -> None:
        if _record_on_api_adapter(self, evt, synth_text):
            logger.info(
                "Enterprise Hermes patch: queued async delegation completion for API session %s",
                evt.get("session_key", ""),
            )
            return
        return await original_inject(self, synth_text, evt)

    adapter_cls.__init__ = _init
    adapter_cls.record_async_delegation_event = record_async_delegation_event
    adapter_cls._matching_async_events = _matching_async_events
    adapter_cls._handle_async_delegations = _handle_async_delegations
    adapter_cls.connect = connect
    adapter_cls._enterprise_async_delegation_patch = True
    runner_cls._inject_watch_notification = _inject_watch_notification
    runner_cls._enterprise_async_delegation_patch = True
    _record_patch_status("api_async", "ok")


try:
    _install_codex_response_stream_patch()
    _install_auxiliary_response_stream_patch()
    _install_api_async_delegation_patch()
except Exception as exc:
    # A genuine failure while installing (as opposed to the expected
    # "standalone Hermes, module absent" path, which is handled quietly inside
    # each installer) silently disables Codex streaming/backfill. Surface it at
    # WARNING and record a process-visible marker the platform can read.
    logger.warning("Enterprise Hermes runtime patch did not install: %s", exc)
    _record_patch_status("install_error", repr(exc))
