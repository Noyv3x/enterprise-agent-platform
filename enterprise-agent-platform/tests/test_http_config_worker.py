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

import yaml

from enterprise_agent_platform import internal_config as internal_config_module
from enterprise_agent_platform import runtimes as runtimes_module
from enterprise_agent_platform.config import PlatformConfig
from enterprise_agent_platform.hermes import AgentResult
from enterprise_agent_platform.internal_config import (
    REDACTED_PLACEHOLDER,
    read_env_file,
    read_yaml_mapping_with_text,
    redact_yaml_text,
    update_env_file,
    update_yaml_text,
    update_yaml_values,
)
from enterprise_agent_platform.server import serve_in_thread
from enterprise_agent_platform.service import EnterpriseService
from enterprise_agent_platform.runtimes import PlatformRuntimeManager

from test_platform import RecordingAgent, RecordingLauncher, make_config


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

    def test_clearing_numeric_field_unsets_key_instead_of_writing_zero(self):
        with tempfile.TemporaryDirectory() as td:
            cfg = Path(td) / "config.yaml"
            cfg.write_text(
                yaml.safe_dump(
                    {"agent": {"max_turns": 25, "api_max_retries": 4}, "model": {"default": "m"}},
                    sort_keys=False,
                ),
                encoding="utf-8",
            )

            update_yaml_values(cfg, {"agent.max_turns": ""})

            loaded = yaml.safe_load(cfg.read_text(encoding="utf-8"))
            # Clearing must remove the key (fall back to runtime default), never
            # persist a semantically different literal 0.
            self.assertNotIn("max_turns", loaded.get("agent", {}))
            self.assertNotEqual(loaded.get("agent", {}).get("max_turns"), 0)
            # Sibling keys and unrelated sections are untouched.
            self.assertEqual(loaded["agent"]["api_max_retries"], 4)
            self.assertEqual(loaded["model"]["default"], "m")

    def test_redacted_yaml_text_roundtrip_preserves_real_secret(self):
        with tempfile.TemporaryDirectory() as td:
            cfg = Path(td) / "config.yaml"
            original = {
                "providers": {
                    "openai": {"api_key": "sk-REAL-SECRET-123", "base_url": "https://api"}
                },
                "model": {"default": "m"},
            }
            cfg.write_text(yaml.safe_dump(original, sort_keys=False), encoding="utf-8")

            mapping, text, error = read_yaml_mapping_with_text(cfg)
            self.assertEqual(error, "")
            redacted_text = redact_yaml_text(mapping, text)
            # The dump shipped to the client masks the inline secret.
            self.assertIn(REDACTED_PLACEHOLDER, redacted_text)
            self.assertNotIn("sk-REAL-SECRET-123", redacted_text)

            # Operator edits a non-secret field and PUTs the redacted text back.
            edited = redacted_text.replace("https://api", "https://api2")
            update_yaml_text(cfg, edited)

            after = yaml.safe_load(cfg.read_text(encoding="utf-8"))
            # The redacted round-trip must NOT clobber the real on-disk secret
            # with the placeholder, while the genuine edit is applied.
            self.assertEqual(after["providers"]["openai"]["api_key"], "sk-REAL-SECRET-123")
            self.assertEqual(after["providers"]["openai"]["base_url"], "https://api2")
            self.assertNotEqual(after["providers"]["openai"]["api_key"], REDACTED_PLACEHOLDER)

    def test_redacted_field_value_roundtrip_preserves_secret_in_json_block(self):
        with tempfile.TemporaryDirectory() as td:
            cfg = Path(td) / "config.yaml"
            original = {
                "providers": {"openai": {"api_key": "sk-FIELD-SECRET-999", "base_url": "https://x"}}
            }
            cfg.write_text(yaml.safe_dump(original, sort_keys=False), encoding="utf-8")

            # Submit the structured `providers` block with the api_key still set
            # to the redaction placeholder (as the masked render would send it).
            update_yaml_values(
                cfg,
                {
                    "providers": {
                        "openai": {"api_key": REDACTED_PLACEHOLDER, "base_url": "https://y"}
                    }
                },
            )

            after = yaml.safe_load(cfg.read_text(encoding="utf-8"))
            self.assertEqual(after["providers"]["openai"]["api_key"], "sk-FIELD-SECRET-999")
            self.assertEqual(after["providers"]["openai"]["base_url"], "https://y")

    def test_yaml_atomic_write_failures_keep_old_file_and_remove_temporary(self):
        for failing_call in ("fsync", "replace"):
            with self.subTest(failing_call=failing_call), tempfile.TemporaryDirectory() as td:
                cfg = Path(td) / "config.yaml"
                original = "model:\n  default: old-model\n"
                cfg.write_text(original, encoding="utf-8")

                with mock.patch.object(
                    internal_config_module.os,
                    failing_call,
                    side_effect=OSError("injected write failure"),
                ):
                    with self.assertRaisesRegex(OSError, "injected write failure"):
                        update_yaml_text(cfg, "model:\n  default: new-model\n")

                self.assertEqual(cfg.read_text(encoding="utf-8"), original)
                self.assertEqual(list(cfg.parent.glob(f".{cfg.name}.tmp-*")), [])

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
    def test_successful_yaml_and_env_updates_are_owner_only(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            cfg = root / "config.yaml"
            env = root / ".env"
            cfg.write_text("model:\n  default: old\n", encoding="utf-8")
            env.write_text('API_SERVER_HOST="127.0.0.1"\n', encoding="utf-8")
            cfg.chmod(0o644)
            env.chmod(0o644)

            update_yaml_values(cfg, {"model.default": "new"})
            update_env_file(env, {"API_SERVER_PORT": "8642"})

            self.assertEqual(stat.S_IMODE(cfg.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(env.stat().st_mode), 0o600)

    def test_concurrent_yaml_field_updates_do_not_lose_siblings(self):
        with tempfile.TemporaryDirectory() as td:
            cfg = Path(td) / "config.yaml"
            cfg.write_text("model:\n  default: base\n", encoding="utf-8")
            updates = {
                "agent.max_turns": 31,
                "agent.api_max_retries": 4,
                "agent.gateway_timeout": 90,
                "terminal.timeout": 45,
                "compression.threshold": 0.8,
                "compression.protect_last_n": 6,
                "display.compact": True,
                "memory.memory_enabled": True,
            }
            real_safe_dump = yaml.safe_dump

            def slow_safe_dump(*args, **kwargs):
                # Widen the old read-then-write race: without a lock, every
                # writer can read the same base document before any replace.
                time.sleep(0.01)
                return real_safe_dump(*args, **kwargs)

            operations = [
                lambda key=key, value=value: update_yaml_values(cfg, {key: value})
                for key, value in updates.items()
            ]
            with mock.patch.object(yaml, "safe_dump", side_effect=slow_safe_dump):
                errors = self._run_concurrently(operations)

            self.assertEqual(errors, [])
            loaded = yaml.safe_load(cfg.read_text(encoding="utf-8"))
            for key, expected in updates.items():
                found, actual = internal_config_module.get_nested(loaded, key)
                self.assertTrue(found, key)
                self.assertEqual(actual, expected, key)

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

    def test_runtime_refresh_and_admin_update_share_yaml_transaction(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            config = make_config(tmp)
            home = config.managed_hermes_home
            home.mkdir(parents=True, exist_ok=True)
            cfg = home / "config.yaml"
            cfg.write_text("agent:\n  api_max_retries: 3\n", encoding="utf-8")
            cfg.chmod(0o644)
            manager = PlatformRuntimeManager(
                config,
                lambda _key: "",
                process_launcher=RecordingLauncher(),
            )

            runtime_read = threading.Event()
            real_read = runtimes_module._read_yaml_mapping
            errors: list[BaseException] = []

            def slow_runtime_read(path):
                mapping = real_read(path)
                runtime_read.set()
                # Without the shared transaction lock this gives the admin
                # writer time to commit agent.max_turns before the runtime
                # overwrites it with the stale mapping it just read.
                time.sleep(0.1)
                return mapping

            def refresh_runtime():
                try:
                    manager._ensure_hermes_config(home)
                except BaseException as exc:  # pragma: no cover - asserted below
                    errors.append(exc)

            def update_admin_field():
                try:
                    update_yaml_values(cfg, {"agent.max_turns": 73})
                except BaseException as exc:  # pragma: no cover - asserted below
                    errors.append(exc)

            with mock.patch.object(
                runtimes_module,
                "_read_yaml_mapping",
                side_effect=slow_runtime_read,
            ):
                runtime_thread = threading.Thread(target=refresh_runtime)
                runtime_thread.start()
                self.assertTrue(runtime_read.wait(timeout=2))
                admin_thread = threading.Thread(target=update_admin_field)
                admin_thread.start()
                runtime_thread.join(timeout=3)
                admin_thread.join(timeout=3)

            self.assertFalse(runtime_thread.is_alive())
            self.assertFalse(admin_thread.is_alive())
            self.assertEqual(errors, [])
            loaded = yaml.safe_load(cfg.read_text(encoding="utf-8"))
            self.assertEqual(loaded["agent"]["max_turns"], 73)
            self.assertEqual(loaded["agent"]["api_max_retries"], 3)
            self.assertIn("enterprise-kb", loaded["plugins"]["enabled"])
            if os.name == "posix":
                self.assertEqual(stat.S_IMODE(cfg.stat().st_mode), 0o600)
            self.assertEqual(list(home.glob(".config.yaml.tmp-*")), [])


class ConfigFromEnvTests(unittest.TestCase):
    def test_host_execution_defaults_disable_relay_and_warn_for_legacy_container_env(self):
        key = "ENTERPRISE_CONTAINER_BACKEND"
        previous = os.environ.get(key)
        os.environ[key] = "docker"
        try:
            with self.assertWarnsRegex(RuntimeWarning, "deprecated and ignored"):
                config = PlatformConfig.from_env(Path("/tmp"))
            self.assertFalse(config.hermes_relay_enabled)
            # Retained for one-release keyword-constructor compatibility only;
            # the runtime never consumes this value.
            self.assertEqual(config.container_backend, "docker")
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
