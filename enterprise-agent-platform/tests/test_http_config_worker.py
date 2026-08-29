from __future__ import annotations

import http.client
import json
import os
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

from enterprise_agent_platform.config import PlatformConfig
from enterprise_agent_platform.agent_runtime_client import AgentResult
from enterprise_agent_platform.design_contract_generated import (
    RUN_IDLE_TIMEOUT_DEFAULT_SECONDS,
    RUN_IDLE_TIMEOUT_MAXIMUM_SECONDS,
    RUN_IDLE_TIMEOUT_MINIMUM_SECONDS,
    RUN_IDLE_TIMEOUT_PLATFORM_ENVIRONMENT_VARIABLE,
)
from enterprise_agent_platform.server import serve_in_thread
from enterprise_agent_platform.service import EnterpriseService
from enterprise_agent_platform.technical_profile import (
    TARGET_TECHNICAL_PROFILE,
)

from test_platform import RecordingAgent, make_config


class FailingThenRecoveringAgent(RecordingAgent):
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
    def test_target_profile_uses_target_health_cookie_and_workspace_namespace(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            config = replace(
                make_config(Path(td)),
                technical_profile=TARGET_TECHNICAL_PROFILE,
            )
            service = EnterpriseService(config, agent_client=agent)
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            origin = f"http://{host}:{port}"
            try:
                conn = http.client.HTTPConnection(host, port, timeout=5)
                conn.request("GET", "/healthz")
                response = conn.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(
                    json.loads(response.read().decode("utf-8")),
                    {"status": "ok", "service": "agent-platform"},
                )

                conn.request(
                    "POST",
                    "/api/auth/login",
                    body=json.dumps({"username": "admin", "password": "admin"}),
                    headers={"Content-Type": "application/json", "Origin": origin},
                )
                response = conn.getresponse()
                response.read()
                cookie = response.getheader("Set-Cookie") or ""
                self.assertEqual(response.status, 200)
                self.assertTrue(cookie.startswith("agent_platform_session="))
                self.assertNotIn("enterprise_session", cookie)

                _, admin = service.authenticate("admin", "admin")
                service.send_private_message(admin, "target workspace")
                service.wait_for_agent_idle("private", str(admin["id"]))
                self.assertIn(
                    "/workspace/.agent-platform/attachments",
                    agent.calls[-1]["system_prompt"],
                )
                self.assertNotIn(
                    "/workspace/.ubitech/attachments",
                    agent.calls[-1]["system_prompt"],
                )
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)

    def test_health_endpoint_is_exact_public_readiness_contract(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            service = EnterpriseService(config, agent_client=RecordingAgent())
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            try:
                conn = http.client.HTTPConnection(host, port, timeout=5)
                conn.request("GET", "/healthz")
                response = conn.getresponse()
                payload = json.loads(response.read().decode("utf-8"))
                self.assertEqual(response.status, 200)
                self.assertEqual(
                    payload,
                    {"status": "ok", "service": "agent-platform"},
                )
                self.assertIn("application/json", response.getheader("Content-Type"))

                service.runtimes.cached_searxng_status = mock.Mock(
                    return_value={
                        "available": True,
                        "stale": False,
                    }
                )
                conn.request("GET", "/healthz/search")
                response = conn.getresponse()
                payload = json.loads(response.read().decode("utf-8"))
                self.assertEqual(response.status, 200)
                self.assertEqual(
                    payload,
                    {"status": "ok", "service": "agent-platform-search"},
                )
                service.runtimes.cached_searxng_status.assert_called_once_with(
                    max_age_seconds=1.0
                )

                service.runtimes.cached_searxng_status.return_value = {
                    "available": False,
                    "stale": False,
                }
                conn.request("GET", "/healthz/search")
                response = conn.getresponse()
                payload = json.loads(response.read().decode("utf-8"))
                self.assertEqual(response.status, 503)
                self.assertEqual(
                    payload,
                    {
                        "status": "unavailable",
                        "service": "agent-platform-search",
                    },
                )

                service.runtimes.cached_searxng_status.return_value = {
                    "available": True,
                    "stale": True,
                }
                conn.request("GET", "/healthz/search")
                response = conn.getresponse()
                payload = json.loads(response.read().decode("utf-8"))
                self.assertEqual(response.status, 503)
                self.assertEqual(
                    payload,
                    {
                        "status": "unavailable",
                        "service": "agent-platform-search",
                    },
                )
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
                    res.getheader("Allow"),
                    "GET, POST, PUT, PATCH, DELETE, OPTIONS",
                )
                self.assertEqual(res.getheader("X-Frame-Options"), "DENY")
                self.assertEqual(res.getheader("X-Content-Type-Options"), "nosniff")

                # PATCH is routed for memory editing and therefore receives the
                # same write-origin protection and JSON security envelope.
                conn2 = http.client.HTTPConnection(host, port, timeout=5)
                conn2.request("PATCH", "/api/channels")
                res2 = conn2.getresponse()
                patch_body = res2.read().decode("utf-8")
                self.assertEqual(res2.status, 403)
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


class ConfigFromEnvTests(unittest.TestCase):
    def setUp(self):
        self._container_env = mock.patch.dict(
            os.environ,
            {"AGENT_PLATFORM_DEPLOYMENT_MODE": "container"},
        )
        self._container_env.start()

    def tearDown(self):
        self._container_env.stop()

    def test_container_mode_requires_and_exposes_absolute_manager_paths(self):
        socket_path = Path("/run/agent-platform-manager/manager.sock")
        token_path = Path("/run/secrets/agent-platform/manager-token")
        with mock.patch.dict(
            os.environ,
            {
                "AGENT_PLATFORM_DEPLOYMENT_MODE": "container",
                "AGENT_PLATFORM_MANAGER_SOCKET": str(socket_path),
                "AGENT_PLATFORM_MANAGER_TOKEN_FILE": str(token_path),
            },
            clear=True,
        ):
            config = PlatformConfig.from_env()
        self.assertEqual(config.manager_socket, socket_path)
        self.assertEqual(config.manager_token_file, token_path)
        self.assertEqual(config.firecrawl_api_url, "http://firecrawl-api:3002")

        with mock.patch.dict(
            os.environ,
            {
                "AGENT_PLATFORM_DEPLOYMENT_MODE": "container",
                "AGENT_PLATFORM_MANAGER_SOCKET": "relative.sock",
                "AGENT_PLATFORM_MANAGER_TOKEN_FILE": str(token_path),
            },
            clear=True,
        ):
            with self.assertRaisesRegex(ValueError, "must be absolute"):
                PlatformConfig.from_env()

    def test_target_profile_uses_only_target_configuration_namespace(self):
        with mock.patch.dict(
            os.environ,
            {
                "AGENT_PLATFORM_TECHNICAL_PROFILE": "agent-platform-v1",
                "AGENT_PLATFORM_DEPLOYMENT_MODE": "container",
                "AGENT_PLATFORM_HOST": "0.0.0.0",
                "AGENT_PLATFORM_PORT": "9876",
                "AGENT_PLATFORM_SESSION_SECRET": "target-secret",
            },
            clear=True,
        ):
            config = PlatformConfig.from_env()

        self.assertEqual(config.technical_profile, TARGET_TECHNICAL_PROFILE)
        self.assertEqual(config.data_dir, Path("/var/lib/agent-platform"))
        self.assertEqual(
            config.manager_socket,
            Path("/run/agent-platform-manager/manager.sock"),
        )
        self.assertEqual(
            config.manager_token_file,
            Path("/run/secrets/agent-platform/manager-token"),
        )
        self.assertEqual(config.host, "0.0.0.0")
        self.assertEqual(config.port, 9876)
        self.assertEqual(config.token_secret, "target-secret")
        self.assertEqual(config.session_cookie_name, "agent_platform_session")

    def test_target_profile_is_the_only_default_and_accepts_exact_selector(self):
        for environment in (
            {"AGENT_PLATFORM_DEPLOYMENT_MODE": "container"},
            {
                "AGENT_PLATFORM_TECHNICAL_PROFILE": "agent-platform-v1",
                "AGENT_PLATFORM_DEPLOYMENT_MODE": "container",
            },
        ):
            with self.subTest(environment=environment):
                with mock.patch.dict(os.environ, environment, clear=True):
                    config = PlatformConfig.from_env()
                self.assertEqual(config.technical_profile, TARGET_TECHNICAL_PROFILE)
                self.assertEqual(config.data_dir, Path("/var/lib/agent-platform"))

    def test_unknown_technical_profile_is_rejected(self):
        environments = (
            {
                "AGENT_PLATFORM_TECHNICAL_PROFILE": "unknown-profile",
                "AGENT_PLATFORM_DEPLOYMENT_MODE": "container",
            },
        )
        for environment in environments:
            with self.subTest(environment=environment):
                with mock.patch.dict(os.environ, environment, clear=True):
                    with self.assertRaisesRegex(
                        ValueError,
                        "technical profile",
                    ):
                        PlatformConfig.from_env()

    def test_target_profile_rejects_unbound_paths(self):
        for key, value in (
            ("AGENT_PLATFORM_DATA", "/tmp/unmanaged-data"),
            ("AGENT_PLATFORM_MANAGER_SOCKET", "/tmp/unmanaged-manager.sock"),
            ("AGENT_PLATFORM_MANAGER_TOKEN_FILE", "/tmp/unmanaged-token"),
        ):
            with self.subTest(key=key):
                environment = {
                    "AGENT_PLATFORM_TECHNICAL_PROFILE": "agent-platform-v1",
                    "AGENT_PLATFORM_DEPLOYMENT_MODE": "container",
                    key: value,
                }
                with mock.patch.dict(os.environ, environment, clear=True):
                    with self.assertRaisesRegex(ValueError, "must be"):
                        PlatformConfig.from_env()

    def test_container_mode_exposes_only_an_absolute_trusted_host_data_root(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            host_data_root = root / "managed-data"
            with mock.patch.dict(
                os.environ,
                {
                    "AGENT_PLATFORM_DEPLOYMENT_MODE": "container",
                    "AGENT_PLATFORM_HOST_DATA_ROOT": str(host_data_root),
                },
                clear=True,
            ):
                self.assertEqual(
                    PlatformConfig.from_env().host_data_root,
                    host_data_root,
                )

            with mock.patch.dict(
                os.environ,
                {
                    "AGENT_PLATFORM_DEPLOYMENT_MODE": "container",
                    "AGENT_PLATFORM_HOST_DATA_ROOT": "relative-data",
                },
                clear=True,
            ):
                with self.assertRaisesRegex(
                    ValueError, "AGENT_PLATFORM_HOST_DATA_ROOT must be absolute"
                ):
                    PlatformConfig.from_env()

    def test_missing_container_mode_is_rejected(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, "must be 'container'"):
                PlatformConfig.from_env()

    def test_non_numeric_port_raises_descriptive_value_error(self):
        previous = os.environ.get("AGENT_PLATFORM_PORT")
        os.environ["AGENT_PLATFORM_PORT"] = "not-a-number"
        try:
            with self.assertRaises(ValueError) as ctx:
                PlatformConfig.from_env()
            message = str(ctx.exception)
            # The error must name the offending variable and explain it clearly,
            # not surface a bare int() ValueError.
            self.assertIn("AGENT_PLATFORM_PORT", message)
            self.assertIn("integer", message)
        finally:
            if previous is None:
                os.environ.pop("AGENT_PLATFORM_PORT", None)
            else:
                os.environ["AGENT_PLATFORM_PORT"] = previous

    def test_out_of_range_port_raises_descriptive_value_error(self):
        previous = os.environ.get("AGENT_PLATFORM_PORT")
        os.environ["AGENT_PLATFORM_PORT"] = "99999"
        try:
            with self.assertRaises(ValueError) as ctx:
                PlatformConfig.from_env()
            self.assertIn("AGENT_PLATFORM_PORT", str(ctx.exception))
        finally:
            if previous is None:
                os.environ.pop("AGENT_PLATFORM_PORT", None)
            else:
                os.environ["AGENT_PLATFORM_PORT"] = previous

    def test_agent_idle_timeout_uses_contract_default_and_allows_contract_minimum(self):
        key = RUN_IDLE_TIMEOUT_PLATFORM_ENVIRONMENT_VARIABLE
        previous = os.environ.pop(key, None)
        try:
            self.assertEqual(
                PlatformConfig.from_env().agent_runtime_idle_timeout_seconds,
                float(RUN_IDLE_TIMEOUT_DEFAULT_SECONDS),
            )
            os.environ[key] = str(RUN_IDLE_TIMEOUT_MINIMUM_SECONDS)
            self.assertEqual(
                PlatformConfig.from_env().agent_runtime_idle_timeout_seconds,
                float(RUN_IDLE_TIMEOUT_MINIMUM_SECONDS),
            )
        finally:
            if previous is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = previous

    def test_agent_runtime_model_has_no_versioned_bootstrap_default(self):
        with mock.patch.dict(
            os.environ,
            {"AGENT_PLATFORM_DEPLOYMENT_MODE": "container"},
            clear=True,
        ):
            self.assertEqual(
                PlatformConfig.from_env().agent_runtime_model,
                "",
            )

        with mock.patch.dict(
            os.environ,
            {
                "AGENT_PLATFORM_DEPLOYMENT_MODE": "container",
                "AGENT_PLATFORM_AGENT_RUNTIME_MODEL": " explicit-model ",
            },
            clear=True,
        ):
            self.assertEqual(
                PlatformConfig.from_env().agent_runtime_model,
                "explicit-model",
            )

    def test_agent_idle_timeout_rejects_values_above_contract_maximum(self):
        key = RUN_IDLE_TIMEOUT_PLATFORM_ENVIRONMENT_VARIABLE
        previous = os.environ.get(key)
        os.environ[key] = str(RUN_IDLE_TIMEOUT_MAXIMUM_SECONDS + 1)
        try:
            with self.assertRaises(ValueError) as ctx:
                PlatformConfig.from_env()
            self.assertIn(key, str(ctx.exception))
        finally:
            if previous is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = previous


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
                before = service.agent_scopes.get_scope(service.agent_scopes.private_scope_key(bob["id"]))
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
                after = service.agent_scopes.get_scope(service.agent_scopes.private_scope_key(bob["id"]))
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
                before = service.agent_scopes.get_scope(service.agent_scopes.private_scope_key(carol["id"]))
                self.assertIsNotNone(before)

                service.deactivate_user(admin, carol["id"])
                after = service.agent_scopes.get_scope(service.agent_scopes.private_scope_key(carol["id"]))
                self.assertEqual(after, before)
            finally:
                service.close()


if __name__ == "__main__":
    unittest.main()
