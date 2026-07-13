from __future__ import annotations

import http.client
import json
import os
import stat
import tempfile
import threading
import time
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

from enterprise_agent_platform import internal_config as internal_config_module
from enterprise_agent_platform.config import PlatformConfig
from enterprise_agent_platform.agent_runtime_client import AgentResult
from enterprise_agent_platform.internal_config import (
    read_env_file,
    update_env_file,
)
from enterprise_agent_platform.server import serve_in_thread
from enterprise_agent_platform.service import EnterpriseService

from test_platform import RecordingAgent, make_config


class FailingThenRecoveringAgent:
    """Raises on the first generate() call and succeeds afterwards so the
    worker's error-recovery path (surface last_error, then drain next task) can
    be exercised deterministically."""

    def __init__(self):
        self.calls = []
        self.fail_next = True

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        if self.fail_next:
            self.fail_next = False
            raise RuntimeError("boom from agent")
        return AgentResult(
            content="recovered reply",
            session_id=kwargs["session_id"],
            raw={"ok": True},
        )


class HTTPServerBehaviorTests(unittest.TestCase):
    def test_non_numeric_limit_query_returns_400_json_not_500(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            service = EnterpriseService(config, agent_client=RecordingAgent())
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            try:
                token, _ = service.authenticate("admin", "admin")
                conn = http.client.HTTPConnection(host, port, timeout=5)
                conn.request(
                    "GET",
                    "/api/knowledge/search?q=vpn&limit=not-a-number",
                    headers={"Authorization": f"Bearer {token}"},
                )
                res = conn.getresponse()
                body = json.loads(res.read().decode("utf-8"))
                # A bad ?limit is a client error (400), not an unhandled 500.
                self.assertEqual(res.status, 400)
                self.assertEqual(body["error"], "invalid limit parameter")
                self.assertIn("application/json", res.getheader("Content-Type"))

                # A well-formed limit on the same route still succeeds.
                conn.request(
                    "GET",
                    "/api/knowledge/search?q=vpn&limit=3",
                    headers={"Authorization": f"Bearer {token}"},
                )
                res = conn.getresponse()
                ok_body = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 200)
                self.assertIn("results", ok_body)
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)

    def test_options_returns_204_and_unimplemented_method_is_json_with_security_headers(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            service = EnterpriseService(config, agent_client=RecordingAgent())
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            try:
                conn = http.client.HTTPConnection(host, port, timeout=5)
                conn.request("OPTIONS", "/api/channels")
                res = conn.getresponse()
                options_body = res.read()
                self.assertEqual(res.status, 204)
                self.assertEqual(len(options_body), 0)
                self.assertEqual(
                    res.getheader("Allow"), "GET, POST, PUT, DELETE, OPTIONS"
                )
                self.assertEqual(res.getheader("X-Frame-Options"), "DENY")
                self.assertEqual(res.getheader("X-Content-Type-Options"), "nosniff")

                # PATCH has no do_PATCH handler, so the stdlib raises 501. The
                # overridden send_error routes it through the JSON envelope with
                # the standard security headers instead of a bare HTML 501 page.
                conn2 = http.client.HTTPConnection(host, port, timeout=5)
                conn2.request("PATCH", "/api/channels")
                res2 = conn2.getresponse()
                patch_body = res2.read().decode("utf-8")
                self.assertEqual(res2.status, 501)
                self.assertIn("application/json", res2.getheader("Content-Type"))
                self.assertEqual(res2.getheader("X-Frame-Options"), "DENY")
                self.assertEqual(res2.getheader("X-Content-Type-Options"), "nosniff")
                csp = res2.getheader("Content-Security-Policy")
                self.assertIn("frame-ancestors 'none'", csp)
                self.assertIn("script-src 'self';", csp)
                self.assertNotIn("script-src 'self' 'unsafe-inline'", csp)
                parsed = json.loads(patch_body)
                self.assertIn("error", parsed)
                # JSON envelope, not the stdlib default text/html error page.
                self.assertNotIn("<html", patch_body.lower())
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)


class InternalConfigTests(unittest.TestCase):
    @staticmethod
    def _run_concurrently(operations) -> list[BaseException]:
        barrier = threading.Barrier(len(operations) + 1)
        errors: list[BaseException] = []

        def run(operation) -> None:
            try:
                barrier.wait(timeout=5)
                operation()
            except BaseException as exc:
                errors.append(exc)

        threads = [threading.Thread(target=run, args=(operation,)) for operation in operations]
        for thread in threads:
            thread.start()
        barrier.wait(timeout=5)
        for thread in threads:
            thread.join(timeout=5)
        if any(thread.is_alive() for thread in threads):
            errors.append(TimeoutError("concurrent config update did not finish"))
        return errors





    def test_env_atomic_write_failure_keeps_old_file(self):
        with tempfile.TemporaryDirectory() as td:
            env = Path(td) / ".env"
            original = 'API_SERVER_HOST="127.0.0.1"\n'
            env.write_text(original, encoding="utf-8")

            with mock.patch.object(
                internal_config_module.os,
                "fsync",
                side_effect=OSError("injected fsync failure"),
            ):
                with self.assertRaisesRegex(OSError, "injected fsync failure"):
                    update_env_file(env, {"API_SERVER_PORT": "8642"})

            self.assertEqual(env.read_text(encoding="utf-8"), original)
            self.assertEqual(list(env.parent.glob(f".{env.name}.tmp-*")), [])

    @unittest.skipUnless(os.name == "posix", "POSIX mode bits are required")
    def test_successful_env_updates_are_owner_only(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            env = root / ".env"
            env.write_text('API_SERVER_HOST="127.0.0.1"\n', encoding="utf-8")
            env.chmod(0o644)

            update_env_file(env, {"API_SERVER_PORT": "8642"})

            self.assertEqual(stat.S_IMODE(env.stat().st_mode), 0o600)


    def test_concurrent_env_updates_do_not_lose_keys(self):
        with tempfile.TemporaryDirectory() as td:
            env = Path(td) / ".env"
            env.write_text('BASE_VALUE="kept"\n', encoding="utf-8")
            updates = {f"WORKER_{index}": str(index) for index in range(12)}
            real_atomic_write = internal_config_module._atomic_write_text

            def slow_atomic_write(path, text, **kwargs):
                # As above, keep writers in the read/write window long enough
                # for a missing transaction lock to deterministically lose keys.
                time.sleep(0.01)
                return real_atomic_write(path, text, **kwargs)

            operations = [
                lambda key=key, value=value: update_env_file(env, {key: value})
                for key, value in updates.items()
            ]
            with mock.patch.object(
                internal_config_module,
                "_atomic_write_text",
                side_effect=slow_atomic_write,
            ):
                errors = self._run_concurrently(operations)

            self.assertEqual(errors, [])
            values = read_env_file(env)
            self.assertEqual(values["BASE_VALUE"], "kept")
            for key, expected in updates.items():
                self.assertEqual(values.get(key), expected, key)

class ConfigFromEnvTests(unittest.TestCase):
    def test_host_execution_defaults_enable_agent_runtime_and_ignore_removed_container_env(self):
        key = "ENTERPRISE_CONTAINER_BACKEND"
        previous = os.environ.get(key)
        os.environ[key] = "docker"
        try:
            config = PlatformConfig.from_env(Path("/tmp"))
            self.assertTrue(config.manage_agent_runtime)
            self.assertEqual(config.agent_runtime_url, "http://127.0.0.1:8766")
            self.assertFalse(hasattr(config, "container_backend"))
        finally:
            if previous is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = previous

    def test_non_numeric_port_raises_descriptive_value_error(self):
        previous = os.environ.get("ENTERPRISE_PLATFORM_PORT")
        os.environ["ENTERPRISE_PLATFORM_PORT"] = "not-a-number"
        try:
            with self.assertRaises(ValueError) as ctx:
                PlatformConfig.from_env(Path("/tmp"))
            message = str(ctx.exception)
            # The error must name the offending variable and explain it clearly,
            # not surface a bare int() ValueError.
            self.assertIn("ENTERPRISE_PLATFORM_PORT", message)
            self.assertIn("integer", message)
        finally:
            if previous is None:
                os.environ.pop("ENTERPRISE_PLATFORM_PORT", None)
            else:
                os.environ["ENTERPRISE_PLATFORM_PORT"] = previous

    def test_out_of_range_port_raises_descriptive_value_error(self):
        previous = os.environ.get("ENTERPRISE_PLATFORM_PORT")
        os.environ["ENTERPRISE_PLATFORM_PORT"] = "99999"
        try:
            with self.assertRaises(ValueError) as ctx:
                PlatformConfig.from_env(Path("/tmp"))
            self.assertIn("ENTERPRISE_PLATFORM_PORT", str(ctx.exception))
        finally:
            if previous is None:
                os.environ.pop("ENTERPRISE_PLATFORM_PORT", None)
            else:
                os.environ["ENTERPRISE_PLATFORM_PORT"] = previous


class AgentWorkerRecoveryTests(unittest.TestCase):
    def test_generation_failure_surfaces_last_error_and_worker_recovers(self):
        with tempfile.TemporaryDirectory() as td:
            agent = FailingThenRecoveringAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, user = service.authenticate("admin", "admin")

                service.send_private_message(user, "first task")
                status = service.wait_for_agent_idle("private", str(user["id"]))

                # The failure is surfaced in the conversation status and persisted
                # as an agent message rather than vanishing silently.
                self.assertEqual(status["state"], "idle")
                self.assertEqual(status["last_error"], "boom from agent")
                failed_message = service.list_messages(user, "private", str(user["id"]))[-1]
                self.assertIn("boom from agent", failed_message["content"])
                self.assertEqual(failed_message["metadata"]["error"], "boom from agent")
                self.assertEqual(
                    failed_message["metadata"]["agent_work"]["state"], "error"
                )

                # The worker recovers: the very next message is handled normally.
                service.send_private_message(user, "second task")
                recovered_status = service.wait_for_agent_idle("private", str(user["id"]))
                self.assertEqual(recovered_status["state"], "idle")
                self.assertEqual(recovered_status["last_error"], "")
                recovered_message = service.list_messages(user, "private", str(user["id"]))[-1]
                self.assertEqual(recovered_message["content"], "recovered reply")
                self.assertEqual(len(agent.calls), 2)
            finally:
                service.close()


class DeactivateUserTeardownTests(unittest.TestCase):
    def test_deactivate_user_preserves_private_scope(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                member = service.create_user(
                    username="bob",
                    password="bob-pass",
                    display_name="Bob",
                    permission_group="member",
                    actor=admin,
                )
                _, bob = service.authenticate("bob", "bob-pass")

                # Provision the user's private host-execution scope.
                service.send_private_message(bob, "set up my workspace")
                service.wait_for_agent_idle("private", str(bob["id"]))
                before = service.agent_scopes.get_private_scope(bob["id"])
                self.assertIsNotNone(before)

                # Deactivation records lifecycle state without deleting the
                # user's workspace/session, allowing a later reactivation.
                recorded: list[int] = []
                real_deactivate = service.agent_scopes.deactivate_private_scope

                def spy(user_id: int) -> None:
                    recorded.append(int(user_id))
                    return real_deactivate(user_id)

                service.agent_scopes.deactivate_private_scope = spy  # type: ignore[method-assign]

                service.deactivate_user(admin, bob["id"])

                self.assertEqual(recorded, [bob["id"]])
                after = service.agent_scopes.get_private_scope(bob["id"])
                self.assertIsNotNone(after)
                self.assertEqual(after.session_id, before.session_id)
                self.assertEqual(after.workspace_path, before.workspace_path)
            finally:
                service.close()

    def test_deactivate_user_retains_private_state_end_to_end(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                member = service.create_user(
                    username="carol",
                    password="carol-pass",
                    display_name="Carol",
                    permission_group="member",
                    actor=admin,
                )
                _, carol = service.authenticate("carol", "carol-pass")
                service.send_private_message(carol, "workspace please")
                service.wait_for_agent_idle("private", str(carol["id"]))
                before = service.agent_scopes.get_private_scope(carol["id"])
                self.assertIsNotNone(before)

                service.deactivate_user(admin, carol["id"])
                after = service.agent_scopes.get_private_scope(carol["id"])
                self.assertEqual(after, before)
            finally:
                service.close()


if __name__ == "__main__":
    unittest.main()
