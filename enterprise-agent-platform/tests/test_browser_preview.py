from __future__ import annotations

import hashlib
import http.client
import json
import tempfile
import threading
import time
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

from enterprise_agent_platform.server import serve_in_thread
from enterprise_agent_platform.service import EnterpriseService, ServiceError

from test_platform import RecordingAgent, make_config


def png_fixture(width: int = 960, height: int = 540, suffix: bytes = b"") -> bytes:
    return (
        b"\x89PNG\r\n\x1a\n"
        + b"\x00\x00\x00\x0dIHDR"
        + int(width).to_bytes(4, "big")
        + int(height).to_bytes(4, "big")
        + b"\x08\x06\x00\x00\x00"
        + suffix
    )


def jpeg_fixture(width: int = 960, height: int = 540) -> bytes:
    # Minimal marker-complete single-component JPEG fixture. The service parses
    # only SOF dimensions and structural boundaries; it never decodes pixels.
    return (
        b"\xff\xd8"
        + b"\xff\xc0\x00\x0b\x08"
        + int(height).to_bytes(2, "big")
        + int(width).to_bytes(2, "big")
        + b"\x01\x01\x11\x00"
        + b"\xff\xda\x00\x08\x01\x01\x00\x00\x3f\x00"
        + b"\x00\xff\xd9"
    )


class BrowserPreviewServiceTests(unittest.TestCase):
    def _service(self, root: Path) -> EnterpriseService:
        return EnterpriseService(make_config(root), agent_client=RecordingAgent())

    def test_uninitialized_preview_is_idle_and_has_no_runtime_side_effect(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                _, actor = service.authenticate("admin", "admin")
                with (
                    mock.patch.object(service.agent_scopes, "ensure_private_scope") as ensure,
                    mock.patch.object(service, "_runtime_json_request") as runtime_request,
                ):
                    preview = service.browser_preview(
                        actor,
                        "private",
                        str(actor["id"]),
                    )
                self.assertFalse(preview["active"])
                self.assertEqual(preview["reason"], "scope_not_initialized")
                self.assertEqual(preview["status"], "idle")
                self.assertTrue(preview["etag"].startswith('"idle-'))
                ensure.assert_not_called()
                runtime_request.assert_not_called()
            finally:
                service.close()

    def test_human_control_is_leased_scoped_and_sequence_idempotent(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                _, actor = service.authenticate("admin", "admin")
                scope = service.agent_scopes.ensure_private_scope(actor["id"])
                resolved = (
                    scope.scope_key,
                    scope.scope_key,
                    "agent-browser-user",
                    "http://127.0.0.1:9090",
                    {"Authorization": "Bearer test"},
                )
                calls: list[tuple[str, dict[str, object]]] = []

                def request(url, body, **_kwargs):
                    calls.append((url, dict(body or {})))
                    return {"ok": True}

                with (
                    mock.patch.object(service, "_resolve_browser_control_tab", return_value=resolved),
                    mock.patch.object(service, "_runtime_json_request", side_effect=request),
                    mock.patch.object(service, "_agent_browser_validate_tab_url", return_value="https://example.test/"),
                ):
                    acquired = service.browser_preview_control(
                        actor,
                        {
                            "command": "acquire",
                            "scope_type": "private",
                            "scope_id": str(actor["id"]),
                            "tab_id": "tab-1",
                        },
                    )
                    with self.assertRaisesRegex(ServiceError, "human browser assistance"):
                        service._agent_browser_tool(scope.scope_key, "click", {"ref": "e1"})
                    body = {
                        "command": "input",
                        "scope_type": "private",
                        "scope_id": str(actor["id"]),
                        "tab_id": "tab-1",
                        "lease_id": acquired["lease_id"],
                        "sequence": 1,
                        "action": "click",
                        "x": 120,
                        "y": 80,
                    }
                    first = service.browser_preview_control(actor, body)
                    duplicate = service.browser_preview_control(actor, body)

                self.assertTrue(first["ok"])
                self.assertTrue(duplicate["duplicate"])
                self.assertEqual(len(calls), 1)
                self.assertEqual(calls[0][1]["userId"], "agent-browser-user")
                self.assertNotIn("selector", calls[0][1])
            finally:
                service.close()

    def test_human_drag_is_bounded_atomic_and_not_replayed(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                _, actor = service.authenticate("admin", "admin")
                scope = service.agent_scopes.ensure_private_scope(actor["id"])
                resolved = (
                    scope.scope_key,
                    scope.scope_key,
                    "agent-browser-user",
                    "http://127.0.0.1:9090",
                    {"Authorization": "Bearer test"},
                )
                calls: list[tuple[str, dict[str, object]]] = []

                def request(url, body, **_kwargs):
                    calls.append((url, dict(body or {})))
                    return {"ok": True, "points": len((body or {}).get("points") or [])}

                with (
                    mock.patch.object(
                        service,
                        "_resolve_browser_control_tab",
                        return_value=resolved,
                    ),
                    mock.patch.object(
                        service,
                        "_runtime_json_request",
                        side_effect=request,
                    ),
                    mock.patch.object(
                        service,
                        "_agent_browser_validate_tab_url",
                        return_value="https://example.test/",
                    ),
                ):
                    acquired = service.browser_preview_control(
                        actor,
                        {
                            "command": "acquire",
                            "scope_type": "private",
                            "scope_id": str(actor["id"]),
                            "tab_id": "tab-1",
                        },
                    )
                    drag = {
                        "command": "input",
                        "scope_type": "private",
                        "scope_id": str(actor["id"]),
                        "tab_id": "tab-1",
                        "lease_id": acquired["lease_id"],
                        "sequence": 1,
                        "action": "drag",
                        "points": [
                            {"x": 20, "y": 30, "at_ms": 0},
                            {"x": 120.125, "y": 30, "at_ms": 80},
                            {"x": 240, "y": 31, "at_ms": 160},
                        ],
                    }
                    first = service.browser_preview_control(actor, drag)
                    duplicate = service.browser_preview_control(actor, drag)

                self.assertTrue(first["ok"])
                self.assertTrue(duplicate["duplicate"])
                self.assertEqual(len(calls), 1)
                self.assertTrue(calls[0][0].endswith("/tabs/tab-1/pointer"))
                self.assertEqual(calls[0][1]["action"], "drag")
                self.assertEqual(
                    calls[0][1]["points"],
                    [
                        {"x": 20.0, "y": 30.0, "at_ms": 0},
                        {"x": 120.12, "y": 30.0, "at_ms": 80},
                        {"x": 240.0, "y": 31.0, "at_ms": 160},
                    ],
                )
                self.assertNotIn("gestureId", calls[0][1])
            finally:
                service.close()

    def test_invalid_drag_does_not_consume_its_sequence(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                _, actor = service.authenticate("admin", "admin")
                scope = service.agent_scopes.ensure_private_scope(actor["id"])
                resolved = (
                    scope.scope_key,
                    scope.scope_key,
                    "agent-browser-user",
                    "http://127.0.0.1:9090",
                    {"Authorization": "Bearer test"},
                )
                calls: list[str] = []

                def request(url, _body, **_kwargs):
                    calls.append(url)
                    return {"ok": True}

                with (
                    mock.patch.object(
                        service,
                        "_resolve_browser_control_tab",
                        return_value=resolved,
                    ),
                    mock.patch.object(
                        service,
                        "_runtime_json_request",
                        side_effect=request,
                    ),
                    mock.patch.object(
                        service,
                        "_agent_browser_validate_tab_url",
                        return_value="https://example.test/",
                    ),
                ):
                    acquired = service.browser_preview_control(
                        actor,
                        {
                            "command": "acquire",
                            "scope_type": "private",
                            "scope_id": str(actor["id"]),
                            "tab_id": "tab-1",
                        },
                    )
                    common = {
                        "command": "input",
                        "scope_type": "private",
                        "scope_id": str(actor["id"]),
                        "tab_id": "tab-1",
                        "lease_id": acquired["lease_id"],
                        "sequence": 1,
                    }
                    invalid_inputs = (
                        {
                            **common,
                            "action": "drag",
                            "points": [{"x": 1, "y": 2, "at_ms": 0}],
                        },
                        {
                            **common,
                            "action": "drag",
                            "points": [
                                {"x": index, "y": 2, "at_ms": index}
                                for index in range(65)
                            ],
                        },
                        {
                            **common,
                            "action": "drag",
                            "points": [
                                {"x": 1, "y": 2, "at_ms": 1},
                                {"x": 3, "y": 4, "at_ms": 2},
                            ],
                        },
                        {
                            **common,
                            "action": "drag",
                            "points": [
                                {"x": 1, "y": 2, "at_ms": 0},
                                {"x": 3, "y": 4, "at_ms": 0},
                            ],
                        },
                        {
                            **common,
                            "action": "drag",
                            "points": [
                                {"x": 1, "y": 2, "at_ms": 0},
                                {"x": 16_385, "y": 4, "at_ms": 2},
                            ],
                        },
                        {
                            **common,
                            "action": "drag",
                            "points": [
                                {"x": 1, "y": 2, "at_ms": 0},
                                {"x": 3, "y": 4, "at_ms": 10_001},
                            ],
                        },
                        {
                            **common,
                            "action": "drag",
                            "points": [
                                {"x": 1, "y": 2, "at_ms": 0},
                                {"x": 3, "y": 4, "at_ms": 4},
                            ],
                            "gestureId": "client-controlled",
                        },
                    )
                    for invalid in invalid_inputs:
                        with self.assertRaises(ServiceError) as raised:
                            service.browser_preview_control(actor, invalid)
                        self.assertEqual(raised.exception.status, 400)

                    accepted = service.browser_preview_control(
                        actor,
                        {
                            **common,
                            "action": "click",
                            "x": 10,
                            "y": 20,
                        },
                    )

                self.assertTrue(accepted["ok"])
                self.assertEqual(len(calls), 1)
                self.assertTrue(calls[0].endswith("/tabs/tab-1/click"))
            finally:
                service.close()

    def test_private_agent_message_releases_senders_lease_before_enqueue(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                _, actor = service.authenticate("admin", "admin")
                scope = service.agent_scopes.ensure_private_scope(actor["id"])
                resolved = (
                    scope.scope_key,
                    scope.scope_key,
                    "agent-browser-user",
                    "http://127.0.0.1:9090",
                    {"Authorization": "Bearer test"},
                )
                with mock.patch.object(
                    service,
                    "_resolve_browser_control_tab",
                    return_value=resolved,
                ):
                    service.browser_preview_control(
                        actor,
                        {
                            "command": "acquire",
                            "scope_type": "private",
                            "scope_id": str(actor["id"]),
                            "tab_id": "tab-1",
                        },
                    )

                observed: dict[str, object] = {}

                def enqueue(_task):
                    observed["leases"] = dict(service._browser_control_leases)
                    observed["agent_result"] = service._agent_browser_tool(
                        scope.scope_key,
                        "click",
                        {"tab_id": "tab-1", "ref": "e1"},
                    )
                    return {
                        "agent_status": {"state": "queued"},
                        "processing_mode": "queued",
                        "input_group_id": "group-1",
                    }

                with (
                    mock.patch.object(service, "_enqueue_agent_reply", side_effect=enqueue),
                    mock.patch.object(
                        service,
                        "_agent_browser_tool_call",
                        return_value={"ok": True},
                    ) as agent_call,
                ):
                    service.send_private_message(actor, "再试试")

                self.assertEqual(observed["leases"], {})
                self.assertEqual(observed["agent_result"], {"ok": True})
                agent_call.assert_called_once()
            finally:
                service.close()

    def test_message_handoff_keeps_the_browser_gate_through_enqueue(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            contender: threading.Thread | None = None
            try:
                _, actor = service.authenticate("admin", "admin")
                scope = service.agent_scopes.ensure_private_scope(actor["id"])
                resolved = (
                    scope.scope_key,
                    scope.scope_key,
                    "agent-browser-user",
                    "http://127.0.0.1:9090",
                    {"Authorization": "Bearer test"},
                )
                contender_started = threading.Event()
                contender_finished = threading.Event()

                def reacquire():
                    contender_started.set()
                    service.browser_preview_control(
                        actor,
                        {
                            "command": "acquire",
                            "scope_type": "private",
                            "scope_id": str(actor["id"]),
                            "tab_id": "tab-1",
                        },
                    )
                    contender_finished.set()

                def enqueue(_task):
                    nonlocal contender
                    self.assertEqual(service._browser_control_leases, {})
                    contender = threading.Thread(target=reacquire)
                    contender.start()
                    self.assertTrue(contender_started.wait(timeout=1))
                    self.assertFalse(
                        contender_finished.wait(timeout=0.05),
                        "a competing acquire crossed the handoff before enqueue completed",
                    )
                    return {
                        "agent_status": {"state": "queued"},
                        "processing_mode": "queued",
                        "input_group_id": "group-1",
                    }

                with (
                    mock.patch.object(
                        service,
                        "_resolve_browser_control_tab",
                        return_value=resolved,
                    ),
                    mock.patch.object(service, "_enqueue_agent_reply", side_effect=enqueue),
                ):
                    service.browser_preview_control(
                        actor,
                        {
                            "command": "acquire",
                            "scope_type": "private",
                            "scope_id": str(actor["id"]),
                            "tab_id": "tab-1",
                        },
                    )
                    service.send_private_message(actor, "再试试")
                    self.assertTrue(contender_finished.wait(timeout=1))
            finally:
                if contender is not None:
                    contender.join(timeout=1)
                service.close()

    def test_message_handoff_never_releases_another_users_lease(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                _, admin = service.authenticate("admin", "admin")
                member = service.create_user(
                    username="browser-helper",
                    password="member-pass",
                    display_name="Browser Helper",
                    role="member",
                    actor=admin,
                )
                scope = service.agent_scopes.ensure_channel_scope(1)
                resolved = (
                    scope.scope_key,
                    scope.scope_key,
                    "agent-browser-user",
                    "http://127.0.0.1:9090",
                    {"Authorization": "Bearer test"},
                )
                with mock.patch.object(
                    service,
                    "_resolve_browser_control_tab",
                    return_value=resolved,
                ):
                    service.browser_preview_control(
                        admin,
                        {
                            "command": "acquire",
                            "scope_type": "channel",
                            "scope_id": "1",
                            "tab_id": "tab-1",
                        },
                    )

                with mock.patch.object(
                    service,
                    "_enqueue_agent_reply",
                    return_value={"agent_status": {"state": "queued"}},
                ):
                    service._enqueue_after_browser_assistance_handoff(
                        {},
                        scope.scope_key,
                        int(member["id"]),
                    )

                self.assertIn((scope.scope_key, "tab-1"), service._browser_control_leases)
            finally:
                service.close()

    def test_channel_agent_message_releases_senders_lease_before_enqueue(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                _, actor = service.authenticate("admin", "admin")
                scope = service.agent_scopes.ensure_channel_scope(1)
                resolved = (
                    scope.scope_key,
                    scope.scope_key,
                    "agent-browser-user",
                    "http://127.0.0.1:9090",
                    {"Authorization": "Bearer test"},
                )
                with mock.patch.object(
                    service,
                    "_resolve_browser_control_tab",
                    return_value=resolved,
                ):
                    service.browser_preview_control(
                        actor,
                        {
                            "command": "acquire",
                            "scope_type": "channel",
                            "scope_id": "1",
                            "tab_id": "tab-1",
                        },
                    )

                observed: dict[str, object] = {}

                def enqueue(_task):
                    observed["leases"] = dict(service._browser_control_leases)
                    return {
                        "agent_status": {"state": "queued"},
                        "processing_mode": "queued",
                        "input_group_id": "group-1",
                    }

                with mock.patch.object(
                    service,
                    "_enqueue_agent_reply",
                    side_effect=enqueue,
                ):
                    service.send_channel_message(actor, 1, "@agent 再试试")

                self.assertEqual(observed["leases"], {})
            finally:
                service.close()

    def test_normal_channel_message_keeps_the_senders_assistance_lease(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                _, actor = service.authenticate("admin", "admin")
                scope = service.agent_scopes.ensure_channel_scope(1)
                resolved = (
                    scope.scope_key,
                    scope.scope_key,
                    "agent-browser-user",
                    "http://127.0.0.1:9090",
                    {"Authorization": "Bearer test"},
                )
                with mock.patch.object(
                    service,
                    "_resolve_browser_control_tab",
                    return_value=resolved,
                ):
                    service.browser_preview_control(
                        actor,
                        {
                            "command": "acquire",
                            "scope_type": "channel",
                            "scope_id": "1",
                            "tab_id": "tab-1",
                        },
                    )
                    service.send_channel_message(actor, 1, "普通频道消息")

                self.assertIn((scope.scope_key, "tab-1"), service._browser_control_leases)
            finally:
                service.close()

    def test_agent_mutation_and_human_acquire_share_the_real_operation_gate(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                _, actor = service.authenticate("admin", "admin")
                scope = service.agent_scopes.ensure_private_scope(actor["id"])
                entered = threading.Event()
                release_agent = threading.Event()
                acquire_done = threading.Event()
                thread_errors: list[BaseException] = []

                def blocked_agent_call(_scope_key, _action, _arguments):
                    entered.set()
                    self.assertTrue(release_agent.wait(timeout=3))
                    return {"ok": True}

                resolved = (
                    scope.scope_key,
                    scope.scope_key,
                    "agent-browser-user",
                    "http://127.0.0.1:9090",
                    {"Authorization": "Bearer test"},
                )

                def run_agent():
                    try:
                        service._agent_browser_tool(
                            scope.scope_key,
                            "click",
                            {"tab_id": "tab-1", "ref": "e1"},
                        )
                    except BaseException as exc:  # pragma: no cover - asserted below
                        thread_errors.append(exc)

                def acquire():
                    try:
                        service.browser_preview_control(
                            actor,
                            {
                                "command": "acquire",
                                "scope_type": "private",
                                "scope_id": str(actor["id"]),
                                "tab_id": "tab-1",
                            },
                        )
                    except BaseException as exc:  # pragma: no cover - asserted below
                        thread_errors.append(exc)
                    finally:
                        acquire_done.set()

                with (
                    mock.patch.object(
                        service,
                        "_agent_browser_tool_call",
                        side_effect=blocked_agent_call,
                    ),
                    mock.patch.object(
                        service,
                        "_resolve_browser_control_tab",
                        return_value=resolved,
                    ),
                ):
                    agent_thread = threading.Thread(target=run_agent)
                    acquire_thread = threading.Thread(target=acquire)
                    agent_thread.start()
                    self.assertTrue(entered.wait(timeout=3))
                    acquire_thread.start()
                    self.assertFalse(acquire_done.wait(timeout=0.1))
                    release_agent.set()
                    agent_thread.join(timeout=3)
                    acquire_thread.join(timeout=3)

                self.assertFalse(agent_thread.is_alive())
                self.assertFalse(acquire_thread.is_alive())
                self.assertEqual(thread_errors, [])
                self.assertTrue(acquire_done.is_set())
            finally:
                service.close()

    def test_human_input_holds_gate_until_camofox_returns_then_blocks_agent(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                _, actor = service.authenticate("admin", "admin")
                scope = service.agent_scopes.ensure_private_scope(actor["id"])
                resolved = (
                    scope.scope_key,
                    scope.scope_key,
                    "agent-browser-user",
                    "http://127.0.0.1:9090",
                    {"Authorization": "Bearer test"},
                )
                entered = threading.Event()
                release_input = threading.Event()
                agent_done = threading.Event()
                input_errors: list[BaseException] = []
                agent_errors: list[BaseException] = []

                def request(_url, _body, **_kwargs):
                    entered.set()
                    self.assertTrue(release_input.wait(timeout=3))
                    return {"ok": True}

                with (
                    mock.patch.object(
                        service,
                        "_resolve_browser_control_tab",
                        return_value=resolved,
                    ),
                    mock.patch.object(
                        service,
                        "_runtime_json_request",
                        side_effect=request,
                    ),
                    mock.patch.object(
                        service,
                        "_agent_browser_validate_tab_url",
                        return_value="https://example.test/",
                    ),
                    mock.patch.object(service, "_agent_browser_tool_call") as agent_call,
                ):
                    acquired = service.browser_preview_control(
                        actor,
                        {
                            "command": "acquire",
                            "scope_type": "private",
                            "scope_id": str(actor["id"]),
                            "tab_id": "tab-1",
                        },
                    )

                    def send_input():
                        try:
                            service.browser_preview_control(
                                actor,
                                {
                                    "command": "input",
                                    "scope_type": "private",
                                    "scope_id": str(actor["id"]),
                                    "tab_id": "tab-1",
                                    "lease_id": acquired["lease_id"],
                                    "sequence": 1,
                                    "action": "click",
                                    "x": 12,
                                    "y": 24,
                                },
                            )
                        except BaseException as exc:  # pragma: no cover - asserted below
                            input_errors.append(exc)

                    def run_agent():
                        try:
                            service._agent_browser_tool(
                                scope.scope_key,
                                "click",
                                {"tab_id": "tab-1", "ref": "e1"},
                            )
                        except BaseException as exc:
                            agent_errors.append(exc)
                        finally:
                            agent_done.set()

                    input_thread = threading.Thread(target=send_input)
                    agent_thread = threading.Thread(target=run_agent)
                    input_thread.start()
                    self.assertTrue(entered.wait(timeout=3))
                    agent_thread.start()
                    self.assertFalse(agent_done.wait(timeout=0.1))
                    release_input.set()
                    input_thread.join(timeout=3)
                    agent_thread.join(timeout=3)

                self.assertEqual(input_errors, [])
                self.assertEqual(len(agent_errors), 1)
                self.assertIsInstance(agent_errors[0], ServiceError)
                self.assertEqual(agent_errors[0].status, 409)
                agent_call.assert_not_called()
            finally:
                service.close()

    def test_release_succeeds_after_the_leased_tab_disappears(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                _, actor = service.authenticate("admin", "admin")
                scope = service.agent_scopes.ensure_private_scope(actor["id"])
                resolved = (
                    scope.scope_key,
                    scope.scope_key,
                    "agent-browser-user",
                    "http://127.0.0.1:9090",
                    {"Authorization": "Bearer test"},
                )
                with mock.patch.object(
                    service,
                    "_resolve_browser_control_tab",
                    return_value=resolved,
                ) as resolver:
                    acquired = service.browser_preview_control(
                        actor,
                        {
                            "command": "acquire",
                            "scope_type": "private",
                            "scope_id": str(actor["id"]),
                            "tab_id": "tab-1",
                        },
                    )
                    resolver.side_effect = ServiceError(404, "tab disappeared")
                    released = service.browser_preview_control(
                        actor,
                        {
                            "command": "release",
                            "scope_type": "private",
                            "scope_id": str(actor["id"]),
                            "tab_id": "tab-1",
                            "lease_id": acquired["lease_id"],
                        },
                    )

                self.assertTrue(released["released"])
                self.assertEqual(resolver.call_count, 1)
            finally:
                service.close()

    def test_human_control_resolver_does_not_accept_unowned_tab(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                _, actor = service.authenticate("admin", "admin")
                scope = service.agent_scopes.ensure_private_scope(actor["id"])
                requested_users: list[str] = []

                def request(url, _body, **_kwargs):
                    requested_users.extend(urllib.parse.parse_qs(urllib.parse.urlparse(url).query).get("userId", []))
                    return {"tabs": [{"tabId": "owned-tab"}]}

                with (
                    mock.patch.object(service.runtimes, "_effective_camofox_url", return_value="http://127.0.0.1:9090"),
                    mock.patch.object(service, "_browser_preview_existing_access_key", return_value="x" * 32),
                    mock.patch.object(service, "_runtime_json_request", side_effect=request),
                ):
                    with self.assertRaisesRegex(ServiceError, "no longer available"):
                        service.browser_preview_control(
                            actor,
                            {
                                "command": "acquire",
                                "scope_type": "private",
                                "scope_id": str(actor["id"]),
                                "tab_id": "foreign-tab",
                            },
                        )
                self.assertEqual(requested_users, [service._agent_browser_user_id(scope.scope_key)])
            finally:
                service.close()

    def test_preview_uses_most_recent_delegate_without_changing_agent_current_tab(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                _, actor = service.authenticate("admin", "admin")
                root = service.agent_scopes.ensure_private_scope(actor["id"])
                child_scope = root.scope_key + "/delegate/research"
                service._agent_browser_remember_current_tab(root.scope_key, "root-tab")
                service._agent_browser_remember_current_tab(child_scope, "child-tab")
                before_tabs = dict(service._agent_browser_current_tabs)
                child_user = service._agent_browser_user_id(child_scope)
                root_user = service._agent_browser_user_id(root.scope_key)
                calls: list[str] = []
                titles = ["Delegate title", "Delegate title"]

                def request(url, body, *, headers, timeout, method="POST"):
                    calls.append(url)
                    parsed = urllib.parse.urlparse(url)
                    query = urllib.parse.parse_qs(parsed.query)
                    if parsed.path.endswith("/tabs"):
                        user_id = query["userId"][0]
                        if user_id == child_user:
                            return {
                                "tabs": [
                                    {
                                        "tabId": "child-tab",
                                        "title": "Delegate title",
                                        "url": "https://example.test/work?token=secret#fragment",
                                    }
                                ]
                            }
                        if user_id == root_user:
                            return {"tabs": [{"tabId": "root-tab"}]}
                    if "/stats" in parsed.path:
                        return {
                            "url": "https://user:pass@example.test/work?token=secret#fragment",
                            "title": titles.pop(0),
                        }
                    raise AssertionError(url)

                binary = mock.Mock(return_value=(png_fixture(), "image/png"))
                service._runtime_json_request = request
                service._runtime_binary_request = binary
                service._validate_browser_page_url = lambda _value: None
                service._browser_preview_existing_access_key = lambda: "x" * 32

                preview = service.browser_preview(actor, "private", str(actor["id"]))
                cached = service.browser_preview(actor, "private", str(actor["id"]))

                self.assertTrue(preview["active"])
                self.assertEqual(preview["tab_id"], "child-tab")
                self.assertTrue(preview["session"].startswith("delegate-"))
                self.assertNotIn(root.scope_key, preview["session"])
                self.assertEqual(preview["url"], "https://example.test/work")
                self.assertNotIn("secret", json.dumps({key: value for key, value in preview.items() if key != "image"}))
                self.assertEqual((preview["width"], preview["height"]), (960, 540))
                self.assertEqual(cached["etag"], preview["etag"])
                self.assertEqual(binary.call_count, 1)
                self.assertEqual(service._agent_browser_current_tabs, before_tabs)
                self.assertTrue(all("fullPage=false" in call.args[0] for call in binary.call_args_list))
                self.assertEqual(sum("/tabs?" in url for url in calls), 2)
            finally:
                service.close()

    def test_transport_failure_is_not_retried_for_each_delegate(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                _, actor = service.authenticate("admin", "admin")
                root = service.agent_scopes.ensure_private_scope(actor["id"])
                for index in range(20):
                    service._agent_browser_remember_current_tab(
                        f"{root.scope_key}/delegate/{index}",
                        f"tab-{index}",
                    )
                failed = mock.Mock(side_effect=ServiceError(502, "runtime down"))
                service._runtime_json_request = failed
                service._browser_preview_existing_access_key = lambda: "x" * 32

                preview = service.browser_preview(actor, "private", str(actor["id"]))

                self.assertFalse(preview["active"])
                self.assertEqual(preview["reason"], "browser_unavailable")
                failed.assert_called_once()
            finally:
                service.close()

    def test_initialized_preview_fails_closed_without_injected_access_key(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                _, actor = service.authenticate("admin", "admin")
                service.agent_scopes.ensure_private_scope(actor["id"])
                runtime_request = mock.Mock()
                service._runtime_json_request = runtime_request

                preview = service.browser_preview(actor, "private", str(actor["id"]))

                self.assertFalse(preview["active"])
                self.assertEqual(preview["reason"], "browser_unavailable")
                runtime_request.assert_not_called()
            finally:
                service.close()

    def test_etag_includes_public_metadata_not_only_pixel_bytes(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                image = png_fixture()
                common = {
                    "root_scope_key": "private:1",
                    "selected_scope_key": "private:1",
                    "selected_tab_id": "tab-1",
                    "selected_tab": {"title": "first"},
                    "tab_count": 1,
                    "user_id": "agent-test",
                    "base_url": "http://127.0.0.1:9377",
                    "headers": {"Authorization": "Bearer test"},
                }
                current = {"title": "first"}

                def request(*_args, **_kwargs):
                    return {"url": "https://example.test/page", "title": current["title"]}

                service._runtime_json_request = request
                service._runtime_binary_request = lambda *_args, **_kwargs: (image, "image/png")
                service._validate_browser_page_url = lambda _value: None
                first = service._capture_browser_preview_frame(**common)
                with service._agent_browser_tabs_lock:
                    service._browser_preview_cache[("private:1", "tab-1")]["captured_monotonic"] = 0
                current["title"] = "second"
                second = service._capture_browser_preview_frame(**common)

                self.assertNotEqual(first["etag"], second["etag"])
            finally:
                service.close()

    def test_png_with_excessive_declared_dimensions_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                service._runtime_json_request = lambda *_args, **_kwargs: {
                    "url": "https://example.test/page",
                    "title": "Page",
                }
                service._runtime_binary_request = lambda *_args, **_kwargs: (
                    png_fixture(20_000, 20_000),
                    "image/png",
                )
                service._validate_browser_page_url = lambda _value: None

                preview = service._capture_browser_preview_frame(
                    root_scope_key="private:1",
                    selected_scope_key="private:1",
                    selected_tab_id="tab-1",
                    selected_tab={"title": "Page"},
                    tab_count=1,
                    user_id="agent-test",
                    base_url="http://127.0.0.1:9377",
                    headers={"Authorization": "Bearer test"},
                )

                self.assertFalse(preview["active"])
                self.assertEqual(preview["reason"], "browser_unavailable")
                cached = service._browser_preview_cache[("private:1", "tab-1")]
                self.assertFalse(cached["frame"]["active"])
                self.assertEqual(service._browser_preview_cache_bytes, 0)
            finally:
                service.close()

    def test_preview_requests_low_quality_jpeg_and_preserves_media_type(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                service._runtime_json_request = lambda *_args, **_kwargs: {
                    "url": "https://example.test/page",
                    "title": "Page",
                }
                binary = mock.Mock(
                    return_value=(jpeg_fixture(), "image/jpeg")
                )
                service._runtime_binary_request = binary
                service._validate_browser_page_url = lambda _value: None

                preview = service._capture_browser_preview_frame(
                    root_scope_key="private:1",
                    selected_scope_key="private:1",
                    selected_tab_id="tab-1",
                    selected_tab={"title": "Page"},
                    tab_count=1,
                    user_id="agent-test",
                    base_url="http://127.0.0.1:9377",
                    headers={"Authorization": "Bearer test"},
                )

                self.assertTrue(preview["active"])
                self.assertEqual(preview["mime_type"], "image/jpeg")
                self.assertEqual((preview["width"], preview["height"]), (960, 540))
                screenshot_url = binary.call_args.args[0]
                query = urllib.parse.parse_qs(
                    urllib.parse.urlparse(screenshot_url).query
                )
                self.assertEqual(query["format"], ["jpeg"])
                self.assertEqual(query["quality"], ["65"])
                self.assertEqual(
                    binary.call_args.kwargs["allowed_content_types"],
                    {"image/jpeg", "image/png"},
                )
            finally:
                service.close()

    def test_control_preview_uses_faster_bounded_cache_and_lower_jpeg_quality(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                service._runtime_json_request = lambda *_args, **_kwargs: {
                    "url": "https://example.test/page",
                    "title": "Page",
                }
                binary = mock.Mock(return_value=(jpeg_fixture(), "image/jpeg"))
                service._runtime_binary_request = binary
                service._validate_browser_page_url = lambda _value: None
                arguments = {
                    "root_scope_key": "private:1",
                    "selected_scope_key": "private:1",
                    "selected_tab_id": "tab-1",
                    "selected_tab": {"title": "Page"},
                    "tab_count": 1,
                    "user_id": "agent-test",
                    "base_url": "http://127.0.0.1:9377",
                    "headers": {"Authorization": "Bearer test"},
                    "control_active": True,
                }

                first = service._capture_browser_preview_frame(**arguments)
                with service._agent_browser_tabs_lock:
                    service._browser_preview_cache[("private:1", "tab-1")][
                        "captured_monotonic"
                    ] -= 0.25
                second = service._capture_browser_preview_frame(**arguments)

                self.assertTrue(first["active"])
                self.assertTrue(second["active"])
                self.assertEqual(first["refresh_interval_ms"], 250)
                self.assertEqual(binary.call_count, 2)
                for call in binary.call_args_list:
                    query = urllib.parse.parse_qs(
                        urllib.parse.urlparse(call.args[0]).query
                    )
                    self.assertEqual(query["format"], ["jpeg"])
                    self.assertEqual(query["quality"], ["55"])
            finally:
                service.close()

    def test_malformed_or_excessive_jpeg_is_rejected_before_browser_decode(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                service._runtime_json_request = lambda *_args, **_kwargs: {
                    "url": "https://example.test/page",
                    "title": "Page",
                }
                service._validate_browser_page_url = lambda _value: None
                arguments = {
                    "root_scope_key": "private:1",
                    "selected_scope_key": "private:1",
                    "selected_tab_id": "tab-1",
                    "selected_tab": {"title": "Page"},
                    "tab_count": 1,
                    "user_id": "agent-test",
                    "base_url": "http://127.0.0.1:9377",
                    "headers": {"Authorization": "Bearer test"},
                }
                for image in (
                    b"\xff\xd8jpeg-preview",
                    jpeg_fixture(20_000, 20_000),
                ):
                    with self.subTest(size=len(image)):
                        service._runtime_binary_request = (
                            lambda *_args, image=image, **_kwargs: (
                                image,
                                "image/jpeg",
                            )
                        )
                        with service._agent_browser_tabs_lock:
                            service._browser_preview_cache.clear()
                            service._browser_preview_cache_bytes = 0
                        preview = service._capture_browser_preview_frame(
                            **arguments
                        )
                        self.assertFalse(preview["active"])
                        self.assertEqual(
                            preview["reason"],
                            "browser_unavailable",
                        )
            finally:
                service.close()

    def test_capture_failure_is_shortly_negative_cached_for_other_observers(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                stats = mock.Mock(return_value={
                    "url": "https://example.test/page",
                    "title": "Page",
                })
                screenshot = mock.Mock(side_effect=ServiceError(502, "capture failed"))
                service._runtime_json_request = stats
                service._runtime_binary_request = screenshot
                service._validate_browser_page_url = lambda _value: None
                arguments = {
                    "root_scope_key": "private:1",
                    "selected_scope_key": "private:1",
                    "selected_tab_id": "tab-1",
                    "selected_tab": {"title": "Page"},
                    "tab_count": 1,
                    "user_id": "agent-test",
                    "base_url": "http://127.0.0.1:9377",
                    "headers": {"Authorization": "Bearer test"},
                }

                first = service._capture_browser_preview_frame(**arguments)
                second = service._capture_browser_preview_frame(**arguments)

                self.assertFalse(first["active"])
                self.assertEqual(second, first)
                stats.assert_called_once()
                screenshot.assert_called_once()
            finally:
                service.close()

    def test_preview_cache_has_a_global_byte_ceiling(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                with mock.patch(
                    "enterprise_agent_platform.service.MAX_BROWSER_PREVIEW_CACHE_BYTES",
                    10,
                ):
                    with service._agent_browser_tabs_lock:
                        for index in range(3):
                            service._browser_preview_cache_put_unlocked(
                                ("private:1", f"tab-{index}"),
                                {
                                    "captured_monotonic": time.monotonic(),
                                    "frame": {"image": bytes([index]) * 6},
                                },
                            )
                self.assertLessEqual(service._browser_preview_cache_bytes, 10)
                self.assertEqual(len(service._browser_preview_cache), 1)
                self.assertIn(("private:1", "tab-2"), service._browser_preview_cache)
            finally:
                service.close()

    def test_root_cleanup_reclaims_every_tracked_delegate_without_preview_cap(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            root = service.agent_scopes.ensure_private_scope(1)
            children = [f"{root.scope_key}/delegate/{index}" for index in range(70)]
            for index, child in enumerate(children):
                service._agent_browser_remember_current_tab(child, f"tab-{index}")
            cleaned: list[str] = []

            def browser_tool(scope_key, action, arguments):
                self.assertEqual(action, "cleanup")
                cleaned.append(scope_key)
                service._agent_browser_forget_scope(scope_key)
                return {"ok": True}

            try:
                with mock.patch.object(service, "_agent_browser_tool", side_effect=browser_tool):
                    service._cleanup_agent_scope(root.scope_key)
                    self.assertEqual(set(cleaned), {root.scope_key, *children})
                    self.assertFalse(service._agent_browser_current_tabs)
                    self.assertFalse(service._agent_browser_activity)
            finally:
                with mock.patch.object(service, "_agent_browser_tool", return_value={"ok": True}):
                    service.close()


class BrowserPreviewHTTPTests(unittest.TestCase):
    def test_binary_frame_is_authenticated_conditional_and_same_origin_only(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            service = EnterpriseService(config, agent_client=RecordingAgent())
            image = png_fixture(800, 450)
            etag = '"' + hashlib.sha256(b"preview").hexdigest() + '"'
            preview = {
                "active": True,
                "status": "live",
                "state": "live",
                "image": image,
                "mime_type": "image/png",
                "etag": etag,
                "captured_at": 123456789,
                "tab_id": "tab/one",
                "tab_count": 2,
                "session": "main",
                "url": "https://example.test/path",
                "title": "A title 中文",
                "width": 800,
                "height": 450,
                "refresh_interval_ms": 2000,
            }
            service.browser_preview = mock.Mock(return_value=preview)
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            try:
                token, actor = service.authenticate("admin", "admin")
                path = (
                    "/api/agent-previews/browser?scope_type=private&scope_id="
                    + str(actor["id"])
                )
                unauthenticated = http.client.HTTPConnection(host, port, timeout=5)
                unauthenticated.request("GET", path)
                denied = unauthenticated.getresponse()
                denied.read()
                self.assertEqual(denied.status, 401)

                connection = http.client.HTTPConnection(host, port, timeout=5)
                connection.request("GET", path, headers={"Authorization": f"Bearer {token}"})
                response = connection.getresponse()
                self.assertEqual(response.read(), image)
                self.assertEqual(response.status, 200)
                self.assertEqual(response.getheader("Content-Type"), "image/png")
                self.assertEqual(response.getheader("ETag"), etag)
                self.assertEqual(response.getheader("Cache-Control"), "private, no-cache, max-age=0")
                self.assertEqual(response.getheader("Vary"), "Cookie, Authorization")
                self.assertEqual(response.getheader("Content-Disposition"), "inline")
                self.assertEqual(response.getheader("Cross-Origin-Resource-Policy"), "same-origin")
                self.assertEqual(response.getheader("X-Preview-Tab-Id"), "tab%2Fone")
                self.assertEqual(response.getheader("X-Preview-URL"), "https%3A%2F%2Fexample.test%2Fpath")
                self.assertEqual(urllib.parse.unquote(response.getheader("X-Preview-Title")), "A title 中文")

                conditional = http.client.HTTPConnection(host, port, timeout=5)
                conditional.request(
                    "GET",
                    path,
                    headers={
                        "Authorization": f"Bearer {token}",
                        "If-None-Match": "W/" + etag,
                    },
                )
                not_modified = conditional.getresponse()
                self.assertEqual(not_modified.status, 304)
                self.assertEqual(not_modified.read(), b"")
                self.assertEqual(not_modified.getheader("ETag"), etag)
                self.assertEqual(not_modified.getheader("Cross-Origin-Resource-Policy"), "same-origin")
                self.assertEqual(not_modified.getheader("Vary"), "Cookie, Authorization")
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)

    def test_binary_frame_preserves_jpeg_content_type(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            service = EnterpriseService(config, agent_client=RecordingAgent())
            image = b"\xff\xd8jpeg-preview"
            service.browser_preview = mock.Mock(
                return_value={
                    "active": True,
                    "image": image,
                    "mime_type": "image/jpeg",
                    "etag": '"jpeg-preview"',
                    "refresh_interval_ms": 2000,
                }
            )
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            try:
                token, actor = service.authenticate("admin", "admin")
                connection = http.client.HTTPConnection(host, port, timeout=5)
                connection.request(
                    "GET",
                    (
                        "/api/agent-previews/browser?scope_type=private&scope_id="
                        + str(actor["id"])
                    ),
                    headers={"Authorization": f"Bearer {token}"},
                )
                response = connection.getresponse()
                self.assertEqual(response.read(), image)
                self.assertEqual(response.status, 200)
                self.assertEqual(response.getheader("Content-Type"), "image/jpeg")
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)

    def test_idle_preview_is_json_with_public_state_and_etag(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            service = EnterpriseService(config, agent_client=RecordingAgent())
            service.browser_preview = mock.Mock(
                return_value={
                    "active": False,
                    "status": "idle",
                    "state": "idle",
                    "reason": "no_open_tab",
                    "refresh_interval_ms": 2000,
                    "etag": '"idle-test"',
                }
            )
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            try:
                token, actor = service.authenticate("admin", "admin")
                connection = http.client.HTTPConnection(host, port, timeout=5)
                connection.request(
                    "GET",
                    f"/api/agent-previews/browser?scope_type=private&scope_id={actor['id']}",
                    headers={"Authorization": f"Bearer {token}"},
                )
                response = connection.getresponse()
                payload = json.loads(response.read().decode("utf-8"))
                self.assertEqual(response.status, 200)
                self.assertEqual(
                    payload,
                    {
                        "active": False,
                        "status": "idle",
                        "state": "idle",
                        "reason": "no_open_tab",
                        "refresh_interval_ms": 2000,
                    },
                )
                self.assertEqual(response.getheader("ETag"), '"idle-test"')
                self.assertEqual(response.getheader("Cross-Origin-Resource-Policy"), "same-origin")
                self.assertEqual(response.getheader("Cache-Control"), "private, no-cache, max-age=0")
                self.assertEqual(response.getheader("Vary"), "Cookie, Authorization")

                conditional = http.client.HTTPConnection(host, port, timeout=5)
                conditional.request(
                    "GET",
                    f"/api/agent-previews/browser?scope_type=private&scope_id={actor['id']}",
                    headers={
                        "Authorization": f"Bearer {token}",
                        "If-None-Match": '"idle-test"',
                    },
                )
                unchanged = conditional.getresponse()
                self.assertEqual(unchanged.status, 304)
                self.assertEqual(unchanged.read(), b"")
                self.assertEqual(unchanged.getheader("Cache-Control"), "private, no-cache, max-age=0")
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)

    def test_browser_preview_rejects_unknown_and_repeated_query_parameters(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            service = EnterpriseService(config, agent_client=RecordingAgent())
            service.browser_preview = mock.Mock()
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            try:
                token, actor = service.authenticate("admin", "admin")
                headers = {"Authorization": f"Bearer {token}"}
                paths = (
                    f"/api/agent-previews/browser?scope_type=private&scope_id={actor['id']}&extra=",
                    f"/api/agent-previews/browser?scope_type=private&scope_type=channel&scope_id={actor['id']}",
                    f"/api/agent-previews/browser?scope_type=private&scope_id={actor['id']}&tab_id=a&tab_id=b",
                )
                for path in paths:
                    connection = http.client.HTTPConnection(host, port, timeout=5)
                    connection.request("GET", path, headers=headers)
                    response = connection.getresponse()
                    response.read()
                    self.assertEqual(response.status, 400, path)
                service.browser_preview.assert_not_called()
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
