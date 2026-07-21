from __future__ import annotations

import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from unittest import mock

from enterprise_agent_platform.agent_runtime_client import (
    AgentRuntimeClient,
    AgentRuntimeConnectionError,
    AgentRuntimeHTTPError,
    AgentRuntimeProtocolError,
    AgentRuntimeRunError,
)


def _event(sequence: int, event_type: str, data: dict[str, Any]) -> dict[str, Any]:
    return {
        "sequence": sequence,
        "type": event_type,
        "run_id": "run-1",
        "timestamp": f"2026-07-13T14:00:{sequence:02d}.000Z",
        "data": data,
    }


class _FakeRuntime:
    def __init__(self):
        self.events: list[dict[str, Any] | bytes] = []
        self.requests: list[dict[str, Any]] = []
        self.errors: dict[str, tuple[int, dict[str, Any]]] = {}
        self.chunked_paths: set[str] = set()
        self.lock = threading.Lock()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def _handler(self):
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                fake._record(self, None)
                if self.path in fake.errors:
                    status, payload = fake.errors[self.path]
                    self._json(status, payload)
                    return
                if self.path == "/health":
                    self._json(200, {"ok": True, "status": "ready"})
                    return
                if self.path == "/v1/models":
                    self._json(
                        200,
                        {
                            "version": 1,
                            "source": "pi-runtime",
                            "providers": {
                                "openai-codex": {
                                    "provider": "openai-codex",
                                    "runtime_provider": "openai-codex",
                                    "default_model": "gpt-5.5",
                                    "models": [
                                        {
                                            "id": "gpt-5.5",
                                            "name": "GPT-5.5",
                                            "reasoning": True,
                                            "input": ["text", "image"],
                                            "context_window": 272_000,
                                            "max_tokens": 128_000,
                                        }
                                    ],
                                },
                                "xai-oauth": {
                                    "provider": "xai-oauth",
                                    "runtime_provider": "xai",
                                    "default_model": "grok-4.3",
                                    "models": [
                                        {
                                            "id": "grok-4.3",
                                            "name": "Grok 4.3",
                                            "reasoning": True,
                                            "input": ["text", "image"],
                                            "context_window": 1_000_000,
                                            "max_tokens": 30_000,
                                        }
                                    ],
                                },
                            },
                        },
                    )
                    return
                if self.path == "/v1/scopes/processes?scope_key=private%3A7&lifecycle_id=life-7":
                    self._json(
                        200,
                        {
                            "revision": 3,
                            "processes": [
                                {
                                    "id": "process-1",
                                    "status": "running",
                                    "output": "hello",
                                }
                            ]
                        },
                    )
                    return
                if self.path == (
                    "/v1/scopes/processes?scope_key=private%3A7"
                    "&lifecycle_id=life-7&since_revision=3"
                ):
                    self._json(
                        200,
                        {"processes": [], "revision": 3, "unchanged": True},
                    )
                    return
                if self.path == "/v1/scopes/process-summary?scope_key=private%3A7&lifecycle_id=life-7":
                    self._json(200, {"running_terminal_count": 2})
                    return
                if self.path == "/v1/processes/update-blockers":
                    self._json(
                        200,
                        {
                            "running_background_terminal_count": 3,
                            "update_blocking_terminal_count": 2,
                            "terminable_background_terminal_count": 1,
                        },
                    )
                    return
                if self.path == "/v1/runs/run-1/events":
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                    self.end_headers()
                    for item in list(fake.events):
                        if isinstance(item, bytes):
                            self.wfile.write(item)
                            self.wfile.flush()
                            continue
                        sequence = int(item["sequence"])
                        event_type = str(item["type"])
                        frame = (
                            f"id: {sequence}\n"
                            f"event: {event_type}\n"
                            f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
                        )
                        self.wfile.write(frame.encode("utf-8"))
                        self.wfile.flush()
                    return
                self._json(404, {"error": "not found"})

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length)
                body = json.loads(raw.decode("utf-8")) if raw else {}
                fake._record(self, body)
                if self.path in fake.errors:
                    status, payload = fake.errors[self.path]
                    self._json(status, payload)
                    return
                if self.path == "/v1/runs":
                    self._json(
                        202,
                        {
                            "run_id": "run-1",
                            "status": "queued",
                            "events_url": "/v1/runs/run-1/events",
                        },
                    )
                    return
                if self.path == "/v1/runs/run-1/approval":
                    self._json(
                        200,
                        {
                            "ok": True,
                            "approval_id": body.get("approval_id"),
                            "decision": body.get("decision"),
                        },
                    )
                    return
                if self.path == "/v1/runs/run-1/input":
                    self._json(
                        202,
                        {
                            "run_id": "run-1",
                            "message_id": body.get("message_id"),
                            "state": "accepted",
                        },
                    )
                    return
                if self.path == "/v1/runs/run-1/cancel":
                    self._json(200, {"ok": True, "status": "cancelled"})
                    return
                if self.path == "/v1/scopes/cleanup":
                    self._json(200, {"ok": True, "scope_key": body.get("scope_key"), "killed": 2})
                    return
                self._json(404, {"error": "not found"})

            def _json(self, status: int, payload: dict[str, Any]) -> None:
                raw = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                chunked = self.path in fake.chunked_paths
                if chunked:
                    self.send_header("Transfer-Encoding", "chunked")
                else:
                    self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                if not chunked:
                    self.wfile.write(raw)
                    return
                midpoint = max(1, len(raw) // 2)
                for chunk in (raw[:midpoint], raw[midpoint:]):
                    if not chunk:
                        continue
                    self.wfile.write(f"{len(chunk):X}\r\n".encode("ascii"))
                    self.wfile.write(chunk + b"\r\n")
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()

            def log_message(self, format, *args):
                return

        return Handler

    def _record(self, handler: BaseHTTPRequestHandler, body: dict[str, Any] | None) -> None:
        with self.lock:
            self.requests.append(
                {
                    "method": handler.command,
                    "path": handler.path,
                    "body": body,
                    "authorization": handler.headers.get("Authorization"),
                    "accept": handler.headers.get("Accept"),
                }
            )

    def request(self, method: str, path: str) -> dict[str, Any]:
        with self.lock:
            return next(item for item in self.requests if item["method"] == method and item["path"] == path)


class AgentRuntimeClientTests(unittest.TestCase):
    def setUp(self):
        self.runtime = _FakeRuntime()
        self.client = AgentRuntimeClient(
            self.runtime.base_url,
            "runtime-secret",
            request_timeout_seconds=3,
        )

    def tearDown(self):
        self.runtime.close()

    def test_transport_timeouts_are_independent_of_agent_run_lifetime(self):
        client = AgentRuntimeClient(self.runtime.base_url, "runtime-secret")

        self.assertEqual(client.request_timeout_seconds, 30.0)
        self.assertEqual(client.event_timeout_seconds, 60.0)

    def test_runtime_endpoint_accepts_trusted_http_but_rejects_embedded_credentials(self):
        for url in (
            "https://runtime.example:8766",
            "http://localhost:8766",
            "https://runtime.example:8766/agent-api",
        ):
            with self.subTest(url=url):
                self.assertEqual(
                    AgentRuntimeClient(url, "runtime-secret").base_url,
                    url,
                )

        for url in (
            "ftp://runtime.example:8766",
            "http://user:secret@127.0.0.1:8766",
            "http://127.0.0.1:0",
            "http://127.0.0.1:8766?target=remote",
            "http://127.0.0.1:8766#fragment",
        ):
            with self.subTest(url=url), self.assertRaisesRegex(
                ValueError,
                "credential-free HTTP",
            ):
                AgentRuntimeClient(url, "runtime-secret")

    def test_external_runtime_transport_rejects_redirects_before_forwarding_auth(self):
        client = AgentRuntimeClient(
            "https://runtime.example:8766",
            "runtime-secret",
        )
        response = mock.MagicMock()
        request = mock.MagicMock()
        with (
            mock.patch(
                "enterprise_agent_platform.agent_runtime_client.open_trusted_service_url",
                return_value=response,
            ) as trusted_open,
            mock.patch(
                "enterprise_agent_platform.agent_runtime_client.open_loopback_url",
            ) as loopback_open,
        ):
            self.assertIs(client._open(request, timeout=2), response)
        trusted_open.assert_called_once_with(request, timeout=2)
        loopback_open.assert_not_called()

    def test_generate_posts_run_and_consumes_completion_events(self):
        self.runtime.events = [
            _event(1, "run.started", {"status": "running"}),
            _event(2, "message.delta", {"delta": "Hello "}),
            _event(3, "tool.started", {"tool": "read_file", "tool_call_id": "tool-1"}),
            _event(4, "message.delta", {"delta": "world"}),
            _event(
                5,
                "run.completed",
                {
                    "output": "Hello world",
                    "session_id": "session-2",
                    "usage": {"input_tokens": 4, "output_tokens": 2, "total_tokens": 6},
                },
            ),
        ]
        progress: list[dict[str, Any]] = []
        content: list[str | None] = []
        started: list[str] = []

        result = self.client.generate(
            system_prompt="You are ubitech agent.",
            user_message="Hello",
            history=[{"role": "user", "content": "Earlier"}],
            session_id="session-1",
            session_key="private:7",
            metadata={
                "provider": "openai-codex",
                "execution": {"lifecycle_id": "life-1"},
                "workspace": {"path": "/tmp/workspace-7"},
            },
            attachments=[
                {"local_path": "/tmp/workspace-7/input.txt", "filename": "input.txt", "mime_type": "text/plain"}
            ],
            model="gpt-5",
            thinking_depth="high",
            reasoning_config={"enabled": True},
            progress_callback=progress.append,
            content_callback=content.append,
            run_started_callback=started.append,
        )

        self.assertEqual(result.content, "Hello world")
        self.assertEqual(result.session_id, "session-2")
        self.assertFalse(result.degraded)
        self.assertEqual(result.raw["usage"]["total_tokens"], 6)
        self.assertEqual(content, ["Hello ", "world"])
        self.assertEqual([item["event"] for item in progress], ["tool.started"])
        self.assertEqual(progress[0]["tool"], "read_file")
        self.assertEqual(started, ["run-1"])

        request = self.runtime.request("POST", "/v1/runs")
        self.assertEqual(request["authorization"], "Bearer runtime-secret")
        self.assertEqual(request["body"]["scope_key"], "private:7")
        self.assertEqual(request["body"]["lifecycle_id"], "life-1")
        self.assertEqual(request["body"]["workspace"], "/tmp/workspace-7")
        self.assertEqual(request["body"]["model"]["id"], "gpt-5")
        self.assertEqual(request["body"]["model"]["provider"], "openai-codex")
        self.assertIs(request["body"]["model"]["reasoning"], True)
        self.assertEqual(request["body"]["thinking_level"], "high")
        self.assertEqual(request["body"]["attachments"][0]["name"], "input.txt")

    def test_generate_decodes_a_chunked_run_creation_response(self):
        self.runtime.chunked_paths.add("/v1/runs")
        self.runtime.events = [
            _event(
                1,
                "run.completed",
                {"output": "Chunked response accepted", "session_id": "session-2"},
            )
        ]

        result = self.client.generate(
            system_prompt="system",
            user_message="question",
            history=[],
            session_id="session-1",
            session_key="private:7",
        )

        self.assertEqual(result.content, "Chunked response accepted")
        self.assertEqual(result.session_id, "session-2")

    def test_steer_run_posts_an_idempotent_scoped_input(self):
        result = self.client.steer_run(
            run_id="run-1",
            message_id="42",
            scope_key="private:7",
            lifecycle_id="life-7",
            user_message="also add a checklist",
            attachments=[
                {
                    "local_path": "/tmp/workspace-7/brief.txt",
                    "filename": "brief.txt",
                    "mime_type": "text/plain",
                }
            ],
        )

        self.assertEqual(result["state"], "accepted")
        request = self.runtime.request("POST", "/v1/runs/run-1/input")
        self.assertEqual(
            request["body"],
            {
                "message_id": "42",
                "scope_key": "private:7",
                "lifecycle_id": "life-7",
                "input": "also add a checklist",
                "attachments": [
                    {
                        "path": "/tmp/workspace-7/brief.txt",
                        "name": "brief.txt",
                        "mime_type": "text/plain",
                    }
                ],
            },
        )

    def test_new_runtime_turn_replaces_stream_fallback_and_preserves_input_ids(self):
        self.runtime.events = [
            _event(1, "message.delta", {"delta": "old draft", "turn_id": "run-1:1", "turn_index": 1}),
            _event(2, "message.final", {"content": "old draft", "turn_id": "run-1:1", "turn_index": 1}),
            _event(3, "input.injected", {"message_id": "42", "turn_id": "run-1:2", "turn_index": 2}),
            _event(4, "message.delta", {"delta": "new answer", "turn_id": "run-1:2", "turn_index": 2}),
            _event(
                5,
                "run.completed",
                {
                    "output": "new answer",
                    "session_id": "session-2",
                    "input_message_ids": ["42"],
                    "unconsumed_input_message_ids": [],
                    "context_usage": {
                        "used_tokens": 24_000,
                        "max_tokens": 128_000,
                        "percent": 19,
                        "estimated": False,
                    },
                },
            ),
        ]
        content: list[str | None] = []
        content_turns: list[tuple[str | None, str, int]] = []
        progress: list[dict[str, Any]] = []

        def on_content(
            value: str | None,
            *,
            turn_id: str = "",
            turn_index: int = 0,
        ) -> None:
            content.append(value)
            content_turns.append((value, turn_id, turn_index))

        result = self.client.generate(
            system_prompt="system",
            user_message="question",
            history=[],
            session_id="session-1",
            session_key="private:7",
            content_callback=on_content,
            progress_callback=progress.append,
        )

        self.assertEqual(result.content, "new answer")
        self.assertEqual(content, ["old draft", None, "new answer"])
        self.assertEqual(
            content_turns,
            [
                ("old draft", "run-1:1", 1),
                (None, "run-1:2", 2),
                ("new answer", "run-1:2", 2),
            ],
        )
        self.assertEqual(result.raw["input_message_ids"], ["42"])
        self.assertEqual(result.raw["unconsumed_input_message_ids"], [])
        self.assertEqual(
            result.raw["context_usage"],
            {
                "used_tokens": 24_000,
                "max_tokens": 128_000,
                "percent": 19,
                "estimated": False,
            },
        )
        self.assertEqual([item["event"] for item in progress], ["input.injected"])

    def test_unbounded_json_response_uses_an_argumentless_read(self):
        response = mock.Mock()
        response.read.return_value = b'{"ok":true}'
        response.headers = {}

        with mock.patch.object(self.client, "_open", return_value=response):
            payload, _headers = self.client._json_request(
                "GET",
                "/health",
                None,
                timeout=1,
            )

        self.assertEqual(payload, {"ok": True})
        response.read.assert_called_once_with()
        response.close.assert_called_once_with()

    def test_bounded_json_response_reads_one_extra_byte(self):
        response = mock.Mock()
        response.read.return_value = b"1234"
        response.headers = {}

        with (
            mock.patch.object(self.client, "_open", return_value=response),
            self.assertRaisesRegex(AgentRuntimeProtocolError, "exceeded 3 bytes"),
        ):
            self.client._json_request(
                "GET",
                "/health",
                None,
                timeout=1,
                max_response_bytes=3,
            )

        response.read.assert_called_once_with(4)
        response.close.assert_called_once_with()

    def test_failed_run_raises_explicit_error(self):
        self.runtime.events = [
            _event(1, "run.started", {}),
            _event(2, "run.failed", {"error": {"message": "provider rejected credentials"}}),
        ]

        with self.assertRaises(AgentRuntimeRunError) as raised:
            self.client.generate(
                system_prompt="system",
                user_message="question",
                history=[],
                session_id="session-1",
                session_key="channel:9:main-agent",
            )

        self.assertEqual(raised.exception.run_id, "run-1")
        self.assertEqual(raised.exception.state, "failed")
        self.assertIn("provider rejected credentials", str(raised.exception))

    def test_non_success_terminal_states_raise_and_preserve_diagnostics(self):
        cases = (
            ("run.failed", "failed", "tool process crashed"),
            ("run.cancelled", "cancelled", "cancelled after tool execution"),
            ("run.needs_review", "needs_review", "side effects require review"),
        )
        for terminal_event, expected_state, message in cases:
            with self.subTest(terminal_event=terminal_event):
                self.runtime.events = [
                    _event(1, "message.delta", {"delta": "Useful partial answer"}),
                    _event(2, terminal_event, {"error": {"message": message}}),
                ]

                with self.assertRaises(AgentRuntimeRunError) as raised:
                    self.client.generate(
                        system_prompt="system",
                        user_message="question",
                        history=[],
                        session_id="session-1",
                        session_key="private:7",
                    )

                error = raised.exception
                self.assertEqual(error.run_id, "run-1")
                self.assertEqual(error.state, expected_state)
                self.assertEqual(error.partial_content, "Useful partial answer")
                self.assertEqual(error.session_id, "session-1")
                self.assertEqual(error.raw["terminal_event"], terminal_event)
                self.assertEqual(error.raw["error"], message)
                self.assertEqual(error.raw["event_count"], 2)
                self.assertEqual(error.raw["events"][-1]["type"], terminal_event)

    def test_malformed_event_frame_does_not_abort_later_completion(self):
        self.runtime.events = [
            b"event: message.delta\ndata: {not valid json}\n\n",
            _event(2, "run.completed", {"output": "Recovered", "session_id": "session-2"}),
        ]

        result = self.client.generate(
            system_prompt="system",
            user_message="question",
            history=[],
            session_id="session-1",
            session_key="private:7",
        )

        self.assertEqual(result.content, "Recovered")
        self.assertEqual(result.session_id, "session-2")
        self.assertEqual(result.raw["event_count"], 2)
        self.assertIn("_parse_error", result.raw["events"][0])

    def test_completed_run_without_assistant_content_is_protocol_error(self):
        self.runtime.events = [
            _event(1, "run.completed", {"output": "", "session_id": "session-1"}),
        ]

        with self.assertRaisesRegex(AgentRuntimeProtocolError, "without assistant content"):
            self.client.generate(
                system_prompt="system",
                user_message="question",
                history=[],
                session_id="session-1",
                session_key="private:7",
            )

    def test_event_stream_eof_before_terminal_event_cancels_run_best_effort(self):
        self.runtime.events = [
            _event(1, "run.started", {"status": "running"}),
            _event(2, "tool.started", {"tool": "terminal", "tool_call_id": "tool-1"}),
            _event(3, "message.delta", {"delta": "partial response"}),
        ]

        with self.assertRaises(AgentRuntimeRunError) as raised:
            self.client.generate(
                system_prompt="system",
                user_message="run it",
                history=[],
                session_id="session-1",
                session_key="private:7",
            )

        error = raised.exception
        self.assertEqual(error.run_id, "run-1")
        self.assertEqual(error.state, "needs_review")
        self.assertEqual(error.partial_content, "partial response")
        self.assertEqual(error.session_id, "session-1")
        self.assertIn("before a terminal event", error.raw["error"])
        self.assertEqual(error.raw["event_count"], 3)
        cancel = self.runtime.request("POST", "/v1/runs/run-1/cancel")
        self.assertEqual(cancel["body"], {})
        self.assertEqual(cancel["authorization"], "Bearer runtime-secret")

    def test_uncertain_run_submission_retries_by_idempotency_key_then_needs_review(self):
        calls: list[dict[str, Any]] = []

        def fail_submission(method, path, body, *, timeout):
            calls.append({"method": method, "path": path, "body": body, "timeout": timeout})
            raise AgentRuntimeConnectionError("connection reset after request body")

        with mock.patch.object(self.client, "_json_request", side_effect=fail_submission):
            with self.assertRaises(AgentRuntimeRunError) as raised:
                self.client.generate(
                    system_prompt="system",
                    user_message="run it once",
                    history=[],
                    session_id="session-1",
                    session_key="private:7",
                    metadata={"idempotency_key": "agent-job:42"},
                )

        error = raised.exception
        self.assertEqual(error.run_id, "idempotency:agent-job:42")
        self.assertEqual(error.state, "needs_review")
        self.assertIn("outcome is unknown", str(error))
        self.assertEqual(len(calls), 2)
        for call in calls:
            self.assertEqual(call["method"], "POST")
            self.assertEqual(call["path"], "/v1/runs")
            self.assertEqual(call["body"]["metadata"]["idempotency_key"], "agent-job:42")

    def test_progress_callback_only_receives_tool_and_approval_events(self):
        self.runtime.events = [
            _event(1, "run.started", {"status": "running"}),
            _event(2, "message.delta", {"delta": "Done"}),
            _event(3, "tool.arguments.delta", {"delta": '{"path":', "content_index": 0}),
            _event(4, "tool.arguments.delta", {"delta": '"README.md"}', "content_index": 0}),
            _event(5, "tool.started", {"tool_name": "read_file", "tool_call_id": "tool-1"}),
            _event(6, "tool.updated", {"tool_name": "read_file", "tool_call_id": "tool-1"}),
            _event(7, "tool.completed", {"tool_name": "read_file", "tool_call_id": "tool-1"}),
            _event(
                8,
                "approval.requested",
                {"approval_id": "approval-1", "description": "Allow command"},
            ),
            _event(
                9,
                "approval.resolved",
                {"approval_id": "approval-1", "decision": "once"},
            ),
            _event(10, "run.completed", {"output": "Done", "session_id": "session-2"}),
        ]
        progress: list[dict[str, Any]] = []

        result = self.client.generate(
            system_prompt="system",
            user_message="question",
            history=[],
            session_id="session-1",
            session_key="private:7",
            progress_callback=progress.append,
        )

        self.assertEqual(result.content, "Done")
        self.assertEqual(
            [item["event"] for item in progress],
            ["tool.started", "tool.updated", "tool.completed", "approval.request", "approval.responded"],
        )
        self.assertEqual(
            [item["runtime_event_type"] for item in progress],
            ["tool.started", "tool.updated", "tool.completed", "approval.requested", "approval.resolved"],
        )
        self.assertEqual([item.get("tool") for item in progress[:3]], ["read_file"] * 3)

    def test_approval_callback_maps_platform_choice_to_runtime_decision(self):
        self.runtime.events = [
            _event(
                1,
                "approval.requested",
                {
                    "approval_id": "approval-9",
                    "command": "rm file.txt",
                    "description": "Delete a file",
                },
            ),
            _event(2, "message.delta", {"delta": "Done"}),
            _event(3, "run.completed", {"output": "Done", "session_id": "session-1"}),
        ]
        seen: list[dict[str, Any]] = []
        approval_response: list[dict[str, Any]] = []

        def on_progress(event: dict[str, Any]) -> None:
            seen.append(event)
            if event["event"] == "approval.request":
                approval_response.append(
                    self.client.respond_approval(run_id=event["run_id"], choice="once")
                )

        result = self.client.generate(
            system_prompt="system",
            user_message="delete it",
            history=[],
            session_id="session-1",
            session_key="private:7",
            progress_callback=on_progress,
        )

        self.assertEqual(result.content, "Done")
        self.assertEqual(seen[0]["event"], "approval.request")
        self.assertEqual(seen[0]["runtime_event_type"], "approval.requested")
        self.assertEqual(seen[0]["description"], "Delete a file")
        self.assertIsInstance(seen[0]["timestamp"], float)
        self.assertEqual(approval_response[0]["decision"], "once")
        request = self.runtime.request("POST", "/v1/runs/run-1/approval")
        self.assertEqual(
            request["body"],
            {"approval_id": "approval-9", "decision": "once"},
        )

    def test_health_cancel_and_cleanup(self):
        self.assertTrue(self.client.health()["ok"])
        self.assertEqual(self.client.cancel_run("run-1")["status"], "cancelled")
        cleanup = self.client.cleanup_scope("private:7", lifecycle_id="life-2")
        self.assertEqual(cleanup["killed"], 2)
        cleanup_request = self.runtime.request("POST", "/v1/scopes/cleanup")
        self.assertEqual(
            cleanup_request["body"],
            {
                "scope_key": "private:7",
                "lifecycle_id": "life-2",
                "delete_sessions": False,
            },
        )
        self.client.cleanup_scope(
            "private:7", lifecycle_id="life-1", delete_sessions=True
        )
        cleanup_request = [
            request
            for request in self.runtime.requests
            if request["method"] == "POST"
            and request["path"] == "/v1/scopes/cleanup"
        ][-1]
        self.assertEqual(
            cleanup_request["body"],
            {
                "scope_key": "private:7",
                "lifecycle_id": "life-1",
                "delete_sessions": True,
            },
        )

    def test_model_catalog_uses_bounded_authenticated_runtime_endpoint(self):
        catalog = self.client.model_catalog()

        self.assertEqual(catalog["version"], 1)
        self.assertEqual(catalog["source"], "pi-runtime")
        self.assertEqual(
            catalog["providers"]["openai-codex"]["models"][0]["id"],
            "gpt-5.5",
        )
        self.assertEqual(
            catalog["providers"]["xai-oauth"]["default_model"],
            "grok-4.3",
        )
        request = self.runtime.request("GET", "/v1/models")
        self.assertEqual(request["authorization"], "Bearer runtime-secret")

    def test_model_catalog_rejects_invalid_runtime_capability_metadata(self):
        valid = self.client.model_catalog()
        invalid = json.loads(json.dumps(valid))
        invalid["providers"]["xai-oauth"]["runtime_provider"] = "openai-codex"

        with (
            mock.patch.object(self.client, "_json_request", return_value=(invalid, {})),
            self.assertRaisesRegex(AgentRuntimeProtocolError, "no valid xai-oauth provider"),
        ):
            self.client.model_catalog()

        invalid = json.loads(json.dumps(valid))
        del invalid["providers"]["openai-codex"]["models"][0]["context_window"]
        with (
            mock.patch.object(self.client, "_json_request", return_value=(invalid, {})),
            self.assertRaisesRegex(AgentRuntimeProtocolError, "invalid model metadata"),
        ):
            self.client.model_catalog()

        for mutate, expected in (
            (lambda payload: payload.__setitem__("version", True), "unsupported version"),
            (
                lambda payload: payload["providers"]["openai-codex"]["models"][0].__setitem__("id", 123),
                "invalid model id",
            ),
            (
                lambda payload: payload["providers"]["openai-codex"].__setitem__("default_model", 123),
                "invalid default model",
            ),
            (lambda payload: payload.__setitem__("source", 123), "invalid source"),
        ):
            with self.subTest(expected=expected):
                invalid = json.loads(json.dumps(valid))
                mutate(invalid)
                with (
                    mock.patch.object(self.client, "_json_request", return_value=(invalid, {})),
                    self.assertRaisesRegex(AgentRuntimeProtocolError, expected),
                ):
                    self.client.model_catalog()

    def test_terminal_previews_use_the_bounded_read_only_scope_endpoint(self):
        result = self.client.terminal_previews("private:7", "life-7")

        self.assertEqual(result["processes"][0]["id"], "process-1")
        self.assertEqual(result["revision"], 3)
        request = self.runtime.request(
            "GET",
            "/v1/scopes/processes?scope_key=private%3A7&lifecycle_id=life-7",
        )
        self.assertEqual(request["authorization"], "Bearer runtime-secret")
        self.assertEqual(request["accept"], "application/json")

        unchanged = self.client.terminal_previews(
            "private:7",
            "life-7",
            since_revision=3,
        )
        self.assertEqual(
            unchanged,
            {"processes": [], "revision": 3, "unchanged": True},
        )
        self.runtime.request(
            "GET",
            "/v1/scopes/processes?scope_key=private%3A7"
            "&lifecycle_id=life-7&since_revision=3",
        )

    def test_terminal_previews_validate_revision_schema(self):
        cases = [
            {"processes": [], "revision": True},
            {"processes": [], "revision": -1},
            {"processes": [], "revision": 1, "unchanged": False},
            {
                "processes": [{"id": "process-1"}],
                "revision": 1,
                "unchanged": True,
            },
        ]
        for payload in cases:
            with self.subTest(payload=payload), mock.patch.object(
                self.client,
                "_json_request",
                return_value=(payload, {}),
            ), self.assertRaises(AgentRuntimeProtocolError):
                self.client.terminal_previews("private:7", "life-7")

        for invalid in (
            -1,
            True,
            9_007_199_254_740_992,
            "",
            "bad token",
            "slash/value",
            "x" * 129,
        ):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.client.terminal_previews(
                    "private:7",
                    "life-7",
                    since_revision=invalid,
                )

    def test_terminal_previews_accept_restart_safe_opaque_revisions(self):
        payload = {
            "processes": [],
            "revision": "preview_abcdef0123456789:42",
            "unchanged": True,
        }
        with mock.patch.object(
            self.client,
            "_json_request",
            return_value=(payload, {}),
        ) as request:
            result = self.client.terminal_previews(
                "private:7",
                "life-7",
                since_revision="preview_abcdef0123456789:42",
            )

        self.assertEqual(result, payload)
        self.assertIn(
            "since_revision=preview_abcdef0123456789%3A42",
            request.call_args.args[1],
        )

    def test_terminal_previews_accept_a_legacy_snapshot_without_revision(self):
        legacy = {"processes": [{"id": "process-1", "output": "legacy"}]}
        with mock.patch.object(
            self.client,
            "_json_request",
            return_value=(legacy, {}),
        ):
            self.assertEqual(
                self.client.terminal_previews("private:7", "life-7"),
                legacy,
            )

    def test_terminal_preview_summary_uses_the_lightweight_scope_endpoint(self):
        result = self.client.terminal_preview_summary("private:7", "life-7")

        self.assertEqual(result, {"running_terminal_count": 2})
        request = self.runtime.request(
            "GET",
            "/v1/scopes/process-summary?scope_key=private%3A7&lifecycle_id=life-7",
        )
        self.assertEqual(request["authorization"], "Bearer runtime-secret")
        self.assertEqual(request["accept"], "application/json")

    def test_update_blocker_summary_uses_the_global_metadata_only_endpoint(self):
        result = self.client.update_blocker_summary()

        self.assertEqual(
            result,
            {
                "running_background_terminal_count": 3,
                "update_blocking_terminal_count": 2,
                "terminable_background_terminal_count": 1,
            },
        )
        request = self.runtime.request("GET", "/v1/processes/update-blockers")
        self.assertEqual(request["authorization"], "Bearer runtime-secret")
        self.assertEqual(request["accept"], "application/json")

    def test_update_blocker_summary_rejects_invalid_or_inconsistent_counts(self):
        cases = [
            {
                "running_background_terminal_count": True,
                "update_blocking_terminal_count": 0,
                "terminable_background_terminal_count": 1,
            },
            {
                "running_background_terminal_count": 2,
                "update_blocking_terminal_count": -1,
                "terminable_background_terminal_count": 3,
            },
            {
                "running_background_terminal_count": 4,
                "update_blocking_terminal_count": 2,
                "terminable_background_terminal_count": 1,
            },
        ]
        for payload in cases:
            with self.subTest(payload=payload), mock.patch.object(
                self.client,
                "_json_request",
                return_value=(payload, {}),
            ):
                with self.assertRaises(AgentRuntimeProtocolError):
                    self.client.update_blocker_summary()

    def test_http_error_exposes_status_and_runtime_message(self):
        self.runtime.errors["/health"] = (503, {"error": {"message": "runtime is warming up"}})

        with self.assertRaises(AgentRuntimeHTTPError) as raised:
            self.client.health()

        self.assertEqual(raised.exception.status_code, 503)
        self.assertIn("runtime is warming up", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
