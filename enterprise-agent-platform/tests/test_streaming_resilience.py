from __future__ import annotations

import json
import tempfile
import threading
import unittest
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from enterprise_agent_platform.hermes import (
    HermesAgentClient,
    HermesStreamError,
    is_substantive_tool_start,
    terminal_failure_message,
    text_from_stream_payload,
)

from test_platform import make_config


def _sse_handler(events: list[str]):
    """Build a BaseHTTPRequestHandler subclass that emits the given SSE frames."""

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for event in events:
                self.wfile.write(event.encode("utf-8"))
                self.wfile.flush()

        def log_message(self, format, *args):
            return

    return Handler


class StreamingResilienceTests(unittest.TestCase):
    def _run_stream(self, events: list[str], *, capture=True):
        """Serve the SSE events over a real loopback server and run generate().

        Returns (result, exception, chunks). Exactly one of result/exception is
        set; chunks holds the streamed content_callback values.
        """
        server = ThreadingHTTPServer(("127.0.0.1", 0), _sse_handler(events))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        chunks: list = []
        progress: list = []
        try:
            with tempfile.TemporaryDirectory() as td:
                config = replace(
                    make_config(Path(td)),
                    agent_mode="hermes",
                    hermes_api_url=f"http://127.0.0.1:{server.server_port}/v1/chat/completions",
                )
                client = HermesAgentClient(config, lambda name: "")
                try:
                    result = client.generate(
                        system_prompt="system",
                        user_message="question",
                        history=[],
                        session_id="session-1",
                        session_key="channel:1:main-agent",
                        progress_callback=progress.append,
                        content_callback=(chunks.append if capture else (lambda chunk: None)),
                    )
                    return result, None, chunks
                except Exception as exc:  # noqa: BLE001 - intentionally surfaced to caller
                    return None, exc, chunks
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=1)

    def test_malformed_data_frame_does_not_abort_stream(self):
        events = [
            "data: " + json.dumps({"choices": [{"delta": {"content": "before "}}]}) + "\n\n",
            # A non-JSON data frame in the middle of the stream. Old code that
            # let json.JSONDecodeError escape would lose the surrounding text.
            "data: {this is not valid json}\n\n",
            "data: " + json.dumps({"choices": [{"delta": {"content": "after"}}]}) + "\n\n",
            "data: [DONE]\n\n",
        ]
        result, exc, chunks = self._run_stream(events)
        self.assertIsNone(exc, msg=f"stream should not abort, got {exc!r}")
        self.assertIsNotNone(result)
        # Good frames on both sides of the malformed one are preserved.
        self.assertEqual(result.content, "before after")
        self.assertFalse(result.degraded)
        self.assertEqual(chunks, ["before ", "after"])
        # The malformed frame is retained as a parse-error breadcrumb, not silently dropped.
        parse_errors = [
            ev for ev in result.raw["events"] if isinstance(ev["data"], dict) and "_parse_error" in ev["data"]
        ]
        self.assertEqual(len(parse_errors), 1)

    def test_finish_reason_error_after_content_surfaces_degraded_failure(self):
        events = [
            "data: " + json.dumps({"choices": [{"delta": {"content": "partial answer so far"}}]}) + "\n\n",
            # Chat-completions terminal error chunk: content already streamed must
            # not be presented as a successful, complete answer.
            "data: " + json.dumps({"choices": [{"delta": {}, "finish_reason": "error"}]}) + "\n\n",
            "data: [DONE]\n\n",
        ]
        result, exc, _chunks = self._run_stream(events)
        self.assertIsNone(exc, msg=f"partial content should degrade, not raise, got {exc!r}")
        self.assertIsNotNone(result)
        self.assertTrue(result.degraded, msg="mid-stream error after content must mark result degraded")
        self.assertEqual(result.content, "partial answer so far")
        # The terminal failure cause is recorded on the raw payload.
        self.assertIn("error", result.raw)
        self.assertTrue(result.raw["error"])

    def test_finish_reason_error_with_no_content_raises_descriptive_error(self):
        events = [
            "data: " + json.dumps({"choices": [{"delta": {}, "finish_reason": "error"}]}) + "\n\n",
            "data: [DONE]\n\n",
        ]
        result, exc, _chunks = self._run_stream(events)
        self.assertIsNone(result)
        self.assertIsInstance(exc, ValueError)
        # The real mid-stream cause is surfaced, not the generic empty-stream message.
        self.assertIn("mid-stream", str(exc).lower())

    def test_response_failed_event_surfaces_error_message(self):
        message = "model provider returned 500 internal error"
        events = [
            "event: response.failed\n"
            + "data: "
            + json.dumps({"type": "response.failed", "response": {"error": {"message": message}}})
            + "\n\n",
        ]
        result, exc, _chunks = self._run_stream(events)
        # No usable content streamed, so the descriptive server error is raised.
        self.assertIsNone(result)
        self.assertIsInstance(exc, ValueError)
        self.assertIn(message, str(exc))

    def test_chat_completion_error_chunk_surfaces_error_message(self):
        message = "Provider authentication failed: No Codex credentials stored. Run `hermes auth` to authenticate."
        events = [
            "data: " + json.dumps({"choices": [{"delta": {"role": "assistant"}, "finish_reason": None}]}) + "\n\n",
            "data: "
            + json.dumps(
                {
                    "choices": [{"delta": {}, "finish_reason": "error"}],
                    "error": {"message": message, "type": "server_error"},
                }
            )
            + "\n\n",
            "data: [DONE]\n\n",
        ]
        result, exc, _chunks = self._run_stream(events)
        self.assertIsNone(result)
        self.assertIsInstance(exc, ValueError)
        self.assertIn(message, str(exc))
        self.assertNotIn("empty streaming response", str(exc))

    def test_response_failed_after_content_degrades_and_preserves_message(self):
        message = "tool execution aborted by sandbox"
        events = [
            "event: response\n"
            + "data: "
            + json.dumps({"type": "response.output_text.delta", "delta": "draft text"})
            + "\n\n",
            "event: response.failed\n"
            + "data: "
            + json.dumps({"type": "response.failed", "response": {"error": {"message": message}}})
            + "\n\n",
        ]
        result, exc, _chunks = self._run_stream(events)
        self.assertIsNone(exc, msg=f"should degrade, not raise, got {exc!r}")
        self.assertIsNotNone(result)
        self.assertTrue(result.degraded)
        self.assertEqual(result.content, "draft text")
        self.assertEqual(result.raw["error"], message)

    def test_empty_stream_raises_descriptive_value_error(self):
        events = [
            ": keep-alive comment\n\n",
            "data: [DONE]\n\n",
        ]
        result, exc, _chunks = self._run_stream(events)
        self.assertIsNone(result)
        self.assertIsInstance(exc, ValueError)
        self.assertIn("empty streaming response", str(exc))

    def test_eof_after_partial_content_is_degraded_without_done(self):
        events = [
            "data: " + json.dumps({"choices": [{"delta": {"content": "partial only"}}]}) + "\n\n",
        ]
        result, exc, chunks = self._run_stream(events)
        self.assertIsNone(exc)
        self.assertIsNotNone(result)
        self.assertTrue(result.degraded)
        self.assertEqual(result.content, "partial only")
        self.assertEqual(chunks, ["partial only"])
        self.assertIn("terminal completion", result.raw["error"])

    def test_eof_without_content_or_terminal_raises_stream_error(self):
        result, exc, _chunks = self._run_stream([": keep-alive\n\n"])
        self.assertIsNone(result)
        self.assertIsInstance(exc, HermesStreamError)
        self.assertIn("terminal completion", str(exc))

    def test_response_completed_is_a_terminal_success_without_done(self):
        events = [
            "data: "
            + json.dumps(
                {
                    "type": "response.completed",
                    "response": {"choices": [{"message": {"content": "complete"}}]},
                }
            )
            + "\n\n",
        ]
        result, exc, chunks = self._run_stream(events)
        self.assertIsNone(exc)
        self.assertIsNotNone(result)
        self.assertFalse(result.degraded)
        self.assertEqual(result.content, "complete")
        self.assertEqual(chunks, ["complete"])

    def test_run_events_eof_after_delta_is_degraded(self):
        with tempfile.TemporaryDirectory() as td:
            client = HermesAgentClient(make_config(Path(td)), lambda name: "")
            response = [
                (
                    "data: "
                    + json.dumps({"event": "message.delta", "delta": "partial run"})
                    + "\n\n"
                ).encode("utf-8")
            ]
            result = client._read_run_events(
                response,
                "session-1",
                "run-1",
                None,
                None,
                start_payload={},
                model="test-model",
            )
        self.assertTrue(result.degraded)
        self.assertEqual(result.content, "partial run")
        self.assertIn("run.completed", result.raw["error"])

    # --- Pure-function coverage for the new terminal-failure detection ---

    def test_terminal_failure_message_response_failed_with_message(self):
        payload = {"type": "response.failed", "response": {"error": {"message": "boom"}}}
        self.assertEqual(terminal_failure_message(payload), "boom")

    def test_terminal_failure_message_response_failed_without_message_has_default(self):
        payload = {"type": "response.failed", "response": {}}
        result = terminal_failure_message(payload)
        self.assertIsNotNone(result)
        self.assertIn("failed mid-stream", result)

    def test_terminal_failure_message_finish_reason_error(self):
        payload = {"choices": [{"delta": {}, "finish_reason": "error"}]}
        result = terminal_failure_message(payload)
        self.assertIsNotNone(result)
        self.assertIn("crashed mid-stream", result)

    def test_terminal_failure_message_finish_reason_error_uses_error_message(self):
        payload = {
            "choices": [{"delta": {}, "finish_reason": "error"}],
            "error": {"message": "Provider authentication failed: token expired"},
        }
        self.assertEqual(terminal_failure_message(payload), "Provider authentication failed: token expired")

    def test_terminal_failure_message_normal_chunk_is_none(self):
        # A normal terminal chunk (finish_reason "stop") is not a failure.
        self.assertIsNone(terminal_failure_message({"choices": [{"delta": {}, "finish_reason": "stop"}]}))
        self.assertIsNone(terminal_failure_message({"choices": [{"delta": {"content": "hi"}}]}))
        self.assertIsNone(terminal_failure_message({"type": "response.output_text.delta", "delta": "x"}))

    def test_text_from_stream_payload_suppresses_terminal_replay_when_streaming(self):
        # While already streaming, a terminal full-text event must not re-emit
        # the already-streamed prose (returns "").
        completed = {
            "type": "response.completed",
            "response": {"choices": [{"message": {"content": "full text"}}]},
        }
        self.assertEqual(text_from_stream_payload(completed, already_streaming=True), "")
        # But before any streaming, the same event yields its text.
        self.assertEqual(text_from_stream_payload(completed, already_streaming=False), "full text")

    def test_is_substantive_tool_start_excludes_housekeeping_and_internal(self):
        self.assertTrue(is_substantive_tool_start({"tool": "browser_vision", "status": "running"}))
        # Housekeeping tools and underscore-prefixed internal tools are not segment breaks.
        self.assertFalse(is_substantive_tool_start({"tool": "memory", "status": "running"}))
        self.assertFalse(is_substantive_tool_start({"tool": "_internal", "status": "running"}))
        # A completed status is not a "start".
        self.assertFalse(is_substantive_tool_start({"tool": "browser_vision", "status": "completed"}))

    def test_hermes_stream_error_is_runtime_error_subclass(self):
        # The new public error type exists and is a RuntimeError for callers
        # that want to catch it specifically.
        self.assertTrue(issubclass(HermesStreamError, RuntimeError))


if __name__ == "__main__":
    unittest.main()
