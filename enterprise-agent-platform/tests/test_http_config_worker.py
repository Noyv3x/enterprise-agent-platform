from __future__ import annotations

import http.client
import json
import os
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

import yaml

from enterprise_agent_platform.config import PlatformConfig
from enterprise_agent_platform.hermes import AgentResult
from enterprise_agent_platform.internal_config import (
    REDACTED_PLACEHOLDER,
    read_yaml_mapping_with_text,
    redact_yaml_text,
    update_yaml_text,
    update_yaml_values,
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
                self.assertIn("frame-ancestors 'none'", res2.getheader("Content-Security-Policy"))
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


class ConfigFromEnvTests(unittest.TestCase):
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
    def test_deactivate_user_tears_down_private_container(self):
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

                # Provision the user's private (local) sandbox/state.
                service.send_private_message(bob, "set up my workspace")
                service.wait_for_agent_idle("private", str(bob["id"]))
                self.assertIsNotNone(service.containers.get_private_container(bob["id"]))

                # Spy on the teardown call without breaking its real effect.
                recorded: list[int] = []
                real_remove = service.containers.remove_private_container

                def spy(user_id: int) -> None:
                    recorded.append(int(user_id))
                    return real_remove(user_id)

                service.containers.remove_private_container = spy  # type: ignore[method-assign]

                service.deactivate_user(admin, bob["id"])

                # deactivate_user must reclaim the user's container by id, and the
                # private_agents state must be forgotten afterwards.
                self.assertEqual(recorded, [bob["id"]])
                self.assertIsNone(service.containers.get_private_container(bob["id"]))
            finally:
                service.close()

    def test_deactivate_user_clears_private_state_via_local_backend(self):
        # End-to-end check that does not depend on monkeypatching: the local
        # backend's remove_private_container deletes the private_agents row.
        with tempfile.TemporaryDirectory() as td:
            config = replace(make_config(Path(td)), container_backend="local")
            service = EnterpriseService(config, agent_client=RecordingAgent())
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
                self.assertIsNotNone(service.containers.get_private_container(carol["id"]))

                service.deactivate_user(admin, carol["id"])
                self.assertIsNone(service.containers.get_private_container(carol["id"]))
            finally:
                service.close()


if __name__ == "__main__":
    unittest.main()
