from __future__ import annotations

import tempfile
import threading
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

from enterprise_agent_platform.service import EnterpriseService, ServiceError
from enterprise_agent_platform.sylver_platform_client import SylverPlatformError
from test_platform import RecordingAgent, make_config


TOKEN = "remote-personal-token-not-for-output"


class FakeSylverPlatformClient:
    def __init__(self):
        self.identity: dict[str, Any] = {
            "remote_user_id": 13,
            "username": "operator",
            "full_name": "Platform Operator",
            "title": "Engineer",
            "email": "operator@example.test",
            "role": "member",
        }
        self.verify_error: Exception | None = None
        self.execute_error: Exception | None = None
        self.verify_calls: list[tuple[str, str]] = []
        self.execute_calls: list[tuple[str, str, str, dict[str, Any]]] = []

    def verify_identity(self, base_url: str, token: str) -> dict[str, Any]:
        self.verify_calls.append((base_url, token))
        if self.verify_error is not None:
            raise self.verify_error
        return dict(self.identity)

    def execute(
        self,
        base_url: str,
        token: str,
        action: str,
        arguments: dict[str, Any],
    ) -> Any:
        self.execute_calls.append((base_url, token, action, dict(arguments)))
        if self.execute_error is not None:
            raise self.execute_error
        return {"remote": "data", "action": action}


class SylverPlatformServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        start_mail = mock.patch.object(
            EnterpriseService, "_start_mail_worker", return_value=None
        )
        self.addCleanup(start_mail.stop)
        start_mail.start()
        self.client = FakeSylverPlatformClient()
        self.service = EnterpriseService(
            make_config(Path(self.temporary.name)),
            agent_client=RecordingAgent(),
            sylver_platform_client=self.client,
        )
        self.addCleanup(self.service.close)
        self.actor = self.service.get_user(1)
        assert self.actor is not None

    def connect(self) -> dict[str, Any]:
        return self.service.put_private_sylver_platform_connection(
            self.actor,
            {"token": TOKEN},
        )["connection"]

    def tool_context(self, **updates: Any) -> dict[str, Any]:
        scope = self.service.agent_scopes.ensure_private_scope(1)
        return {
            "scope_key": scope.scope_key,
            "lifecycle_id": scope.lifecycle_id,
            "owner_user_id": 1,
            **updates,
        }

    def test_connection_is_verified_before_atomic_save_and_never_returns_token(self) -> None:
        connection = self.connect()

        self.assertEqual(
            self.client.verify_calls,
            [("https://devops.sylver-lining.org", TOKEN)],
        )
        self.assertEqual(connection["remote_user_id"], 13)
        self.assertEqual(connection["username"], "operator")
        self.assertTrue(connection["credential_configured"])
        self.assertNotIn("owner_user_id", connection)
        self.assertNotIn("token", connection)
        self.assertNotIn(TOKEN, repr(connection))
        loaded = self.service.get_private_sylver_platform_connection(self.actor)
        self.assertEqual(loaded["connection"], connection)

    def test_failed_reconnect_preserves_the_existing_connection_and_token(self) -> None:
        existing = self.connect()
        self.client.verify_error = SylverPlatformError(
            "remote platform returned HTTP 401", status_code=401
        )

        with self.assertRaises(ServiceError) as raised:
            self.service.put_private_sylver_platform_connection(
                self.actor,
                {"token": "replacement"},
            )

        self.assertEqual(raised.exception.status, 502)
        self.assertEqual(
            self.service.get_private_sylver_platform_connection(self.actor)["connection"],
            existing,
        )
        stored = self.service.sylver_platform_connections.get_with_credential(1)
        self.assertIsNotNone(stored)
        self.assertEqual((stored or ({}, ""))[1], TOKEN)

    def test_disconnect_is_idempotent_and_cascades_the_credential(self) -> None:
        self.connect()

        self.assertEqual(
            self.service.delete_private_sylver_platform_connection(self.actor),
            {"ok": True},
        )
        self.assertEqual(
            self.service.delete_private_sylver_platform_connection(self.actor),
            {"ok": True},
        )
        self.assertIsNone(self.service.sylver_platform_connections.get_with_credential(1))

    def test_slow_connect_followed_by_disconnect_finishes_disconnected(self) -> None:
        self.connect()
        slow_verification_started = threading.Event()
        release_slow_verification = threading.Event()
        disconnect_requested = threading.Event()
        disconnect_reached_store = threading.Event()
        errors: list[Exception] = []

        def verify_identity(base_url: str, token: str) -> dict[str, Any]:
            self.assertEqual(base_url, "https://devops.sylver-lining.org")
            self.assertEqual(token, "slow-replacement-token")
            slow_verification_started.set()
            if not release_slow_verification.wait(5):
                raise AssertionError("slow verification was not released")
            return {
                **self.client.identity,
                "remote_user_id": 14,
                "username": "slow-replacement",
            }

        original_delete = self.service.sylver_platform_connections.delete

        def observed_delete(owner_user_id: int) -> bool:
            disconnect_reached_store.set()
            return original_delete(owner_user_id)

        def slow_connect() -> None:
            try:
                self.service.put_private_sylver_platform_connection(
                    self.actor,
                    {"token": "slow-replacement-token"},
                )
            except Exception as exc:  # pragma: no cover - asserted below
                errors.append(exc)

        def disconnect() -> None:
            disconnect_requested.set()
            try:
                self.service.delete_private_sylver_platform_connection(self.actor)
            except Exception as exc:  # pragma: no cover - asserted below
                errors.append(exc)

        slow_thread = threading.Thread(target=slow_connect, daemon=True)
        disconnect_thread = threading.Thread(target=disconnect, daemon=True)
        with (
            mock.patch.object(
                self.client,
                "verify_identity",
                side_effect=verify_identity,
            ),
            mock.patch.object(
                self.service.sylver_platform_connections,
                "delete",
                side_effect=observed_delete,
            ),
        ):
            slow_thread.start()
            try:
                self.assertTrue(slow_verification_started.wait(2))
                disconnect_thread.start()
                self.assertTrue(disconnect_requested.wait(2))
                self.assertFalse(disconnect_reached_store.wait(0.1))
            finally:
                release_slow_verification.set()
                slow_thread.join(5)
                if disconnect_thread.ident is not None:
                    disconnect_thread.join(5)

        self.assertFalse(slow_thread.is_alive())
        self.assertFalse(disconnect_thread.is_alive())
        self.assertEqual(errors, [])
        self.assertTrue(disconnect_reached_store.is_set())
        self.assertIsNone(self.service.sylver_platform_connections.get_with_credential(1))

    def test_slow_connect_followed_by_connect_finishes_with_later_identity(self) -> None:
        self.connect()
        slow_verification_started = threading.Event()
        release_slow_verification = threading.Event()
        later_connect_requested = threading.Event()
        later_verification_started = threading.Event()
        errors: list[Exception] = []

        def verify_identity(base_url: str, token: str) -> dict[str, Any]:
            self.assertEqual(base_url, "https://devops.sylver-lining.org")
            if token == "slow-replacement-token":
                slow_verification_started.set()
                if not release_slow_verification.wait(5):
                    raise AssertionError("slow verification was not released")
                return {
                    **self.client.identity,
                    "remote_user_id": 14,
                    "username": "slow-replacement",
                }
            self.assertEqual(token, "later-replacement-token")
            later_verification_started.set()
            return {
                **self.client.identity,
                "remote_user_id": 15,
                "username": "later-replacement",
                "email": "later@example.test",
            }

        def connect(token: str, *, requested: threading.Event | None = None) -> None:
            if requested is not None:
                requested.set()
            try:
                self.service.put_private_sylver_platform_connection(
                    self.actor,
                    {"token": token},
                )
            except Exception as exc:  # pragma: no cover - asserted below
                errors.append(exc)

        slow_thread = threading.Thread(
            target=connect,
            args=("slow-replacement-token",),
            daemon=True,
        )
        later_thread = threading.Thread(
            target=connect,
            args=("later-replacement-token",),
            kwargs={"requested": later_connect_requested},
            daemon=True,
        )
        with mock.patch.object(
            self.client,
            "verify_identity",
            side_effect=verify_identity,
        ):
            slow_thread.start()
            try:
                self.assertTrue(slow_verification_started.wait(2))
                later_thread.start()
                self.assertTrue(later_connect_requested.wait(2))
                self.assertFalse(later_verification_started.wait(0.1))
            finally:
                release_slow_verification.set()
                slow_thread.join(5)
                if later_thread.ident is not None:
                    later_thread.join(5)

        self.assertFalse(slow_thread.is_alive())
        self.assertFalse(later_thread.is_alive())
        self.assertEqual(errors, [])
        self.assertTrue(later_verification_started.is_set())
        stored = self.service.sylver_platform_connections.get_with_credential(1)
        self.assertIsNotNone(stored)
        connection, token = stored or ({}, "")
        self.assertEqual(token, "later-replacement-token")
        self.assertEqual(connection["remote_user_id"], 15)
        self.assertEqual(connection["username"], "later-replacement")
        self.assertEqual(connection["email"], "later@example.test")

    def test_remote_identity_bound_to_another_user_has_stable_error_code(self) -> None:
        self.connect()
        second_actor = self.service.create_user(
            username="second-user",
            password="second-user-password",
            display_name="Second User",
            role="member",
            actor=self.actor,
        )

        with self.assertRaises(ServiceError) as raised:
            self.service.put_private_sylver_platform_connection(
                second_actor,
                {"token": "second-user-token"},
            )

        self.assertEqual(raised.exception.status, 409)
        self.assertEqual(
            raised.exception.code,
            "sylver_platform_identity_conflict",
        )

    def test_agent_read_uses_trusted_private_identity_and_frames_remote_data(self) -> None:
        self.connect()
        result = self.service.invoke_agent_runtime_tool(
            {
                "tool": "sylver_platform",
                "action": "task",
                "arguments": {"task_id": 9},
                "context": self.tool_context(),
            }
        )["data"]

        self.assertEqual(result["trust"], "untrusted_remote_platform_data")
        self.assertEqual(result["result"]["action"], "task")
        self.assertEqual(
            self.client.execute_calls[-1],
            ("https://devops.sylver-lining.org", TOKEN, "task", {"task_id": 9}),
        )

    def test_agent_rejects_model_credentials_stale_lifecycle_and_non_private_scope(self) -> None:
        self.connect()
        base = {
            "tool": "sylver_platform",
            "action": "projects",
            "arguments": {},
            "context": self.tool_context(),
        }
        cases = (
            ({**base, "arguments": {"token": "injected"}}, 400),
            ({**base, "context": {**base["context"], "lifecycle_id": "stale"}}, 409),
            ({**base, "context": {**base["context"], "scope_key": "channel:1"}}, 403),
        )
        for request, status in cases:
            with self.subTest(status=status), self.assertRaises(ServiceError) as raised:
                self.service.invoke_agent_runtime_tool(request)
            self.assertEqual(raised.exception.status, status)
        self.assertEqual(self.client.execute_calls, [])

    def test_agent_mutations_require_interactive_tool_call_identity(self) -> None:
        self.connect()
        request = {
            "tool": "sylver_platform",
            "action": "start_task",
            "arguments": {"task_id": 9},
            "context": self.tool_context(),
        }
        with self.assertRaises(ServiceError) as missing:
            self.service.invoke_agent_runtime_tool(request)
        self.assertEqual(missing.exception.status, 400)

        with self.assertRaises(ServiceError) as unattended:
            self.service.invoke_agent_runtime_tool(
                {
                    **request,
                    "context": self.tool_context(
                        tool_call_id="call-1", unattended=True
                    ),
                }
            )
        self.assertEqual(unattended.exception.status, 403)

        result = self.service.invoke_agent_runtime_tool(
            {
                **request,
                "context": self.tool_context(tool_call_id="call-2"),
            }
        )["data"]
        self.assertEqual(result["result"]["action"], "start_task")

    def test_remote_failure_is_bounded_and_does_not_expose_the_token(self) -> None:
        self.connect()
        self.client.execute_error = SylverPlatformError(
            "remote platform returned HTTP 503", status_code=503, retryable=True
        )

        with self.assertRaises(ServiceError) as raised:
            self.service.invoke_agent_runtime_tool(
                {
                    "tool": "sylver_platform",
                    "action": "projects",
                    "arguments": {},
                    "context": self.tool_context(),
                }
            )

        self.assertEqual(raised.exception.status, 502)
        self.assertNotIn(TOKEN, raised.exception.message)


if __name__ == "__main__":
    unittest.main()
