from __future__ import annotations

import asyncio
import base64
import fcntl
import hashlib
import hmac
import json
import os
import shutil
import stat
import subprocess
import tempfile
import threading
import time
import tomllib
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from test_platform import RecordingLauncher, make_config, make_fake_firecrawl_repo

from enterprise_agent_platform import runtimes as runtime_module
from enterprise_agent_platform.hermes_relay import (
    HermesRelayConnector,
    managed_relay_auth,
    verify_relay_upgrade_token,
)
from enterprise_agent_platform.runtimes import (
    CAMOFOX_MANAGED_VERSION,
    FIRECRAWL_FOUNDATIONDB_IMAGE,
    FIRECRAWL_IMAGE,
    FIRECRAWL_PLAYWRIGHT_IMAGE,
    FIRECRAWL_POSTGRES_IMAGE,
    FIRECRAWL_RABBITMQ_IMAGE,
    FIRECRAWL_REDIS_IMAGE,
    FIRECRAWL_SERVICE_IMAGES,
    PlatformRuntimeManager,
)


def _make_upgrade_token(gateway_id: str, secret: str, *, expiry: int) -> str:
    signed = f"{gateway_id}:{expiry}"
    signature = hmac.new(secret.encode(), signed.encode(), hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(f"{signed}:{signature}".encode()).decode().rstrip("=")


def _no_secret(_key: str) -> str:
    return ""


class _FakeSocket:
    def __init__(self, authorization: str = ""):
        self.request = SimpleNamespace(path="/relay", headers={"Authorization": authorization})
        self.closed: tuple[int, str] | None = None
        self.sent: list[str] = []

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = (code, reason)

    async def send(self, value: str) -> None:
        self.sent.append(value)

    def __aiter__(self):
        async def empty():
            if False:
                yield ""

        return empty()


class _FakeHTTPResponse:
    def __init__(self, status: int, payload: object):
        self.status = int(status)
        self._body = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit: int = -1) -> bytes:
        return self._body


class ManagedRelaySecurityTests(unittest.TestCase):
    def test_generated_relay_credentials_are_stable_and_owner_only(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            first = managed_relay_auth(config)
            second = managed_relay_auth(config)
            self.assertEqual(first, second)
            self.assertGreaterEqual(len(first[1]), 32)
            auth_path = config.managed_hermes_home / "relay-auth.json"
            self.assertEqual(stat.S_IMODE(auth_path.stat().st_mode), 0o600)
            payload = json.loads(auth_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["gateway_id"], first[0])

    def test_upgrade_token_requires_matching_short_lived_hmac(self):
        gateway_id = "enterprise-managed-hermes"
        secret = "s" * 48
        token = _make_upgrade_token(gateway_id, secret, expiry=1300)
        self.assertTrue(
            verify_relay_upgrade_token(token, gateway_id=gateway_id, secret=secret, now=1000)
        )
        self.assertFalse(
            verify_relay_upgrade_token(token, gateway_id="another", secret=secret, now=1000)
        )
        self.assertFalse(
            verify_relay_upgrade_token(token, gateway_id=gateway_id, secret="x" * 48, now=1000)
        )
        self.assertFalse(
            verify_relay_upgrade_token(token, gateway_id=gateway_id, secret=secret, now=1300)
        )
        far_future = _make_upgrade_token(gateway_id, secret, expiry=2000)
        self.assertFalse(
            verify_relay_upgrade_token(far_future, gateway_id=gateway_id, secret=secret, now=1000)
        )

    def test_relay_refuses_non_loopback_listener(self):
        with tempfile.TemporaryDirectory() as td:
            config = replace(
                make_config(Path(td)),
                hermes_relay_enabled=True,
                hermes_relay_host="0.0.0.0",
            )
            with self.assertRaisesRegex(ValueError, "loopback"):
                HermesRelayConnector(config).start()

    def test_relay_rejects_unauthenticated_and_second_adapter(self):
        with tempfile.TemporaryDirectory() as td:
            connector = HermesRelayConnector(make_config(Path(td)))
            relay_id, secret = managed_relay_auth(connector.config)
            connector._relay_id = relay_id
            connector._relay_secret = secret

            unauthorized = _FakeSocket()
            asyncio.run(connector._handle_socket(unauthorized))
            self.assertEqual(unauthorized.closed, (4401, "unauthorized"))

            token = _make_upgrade_token(relay_id, secret, expiry=int(time.time()) + 300)
            second = _FakeSocket(f"Bearer {token}")
            connector._active_connection = object()
            asyncio.run(connector._handle_socket(second))
            self.assertEqual(second.closed, (4409, "managed relay adapter already connected"))

    def test_turn_ids_are_unpredictable_and_explicit_ids_fail_closed(self):
        with tempfile.TemporaryDirectory() as td:
            connector = HermesRelayConnector(make_config(Path(td)))
            kwargs = dict(
                system_prompt="system",
                user_message="hello",
                session_id="enterprise-private-u1",
                session_key="private:1",
                metadata={},
                attachments=[],
                model=None,
                reasoning_config=None,
                progress_callback=None,
                content_callback=None,
            )
            turn = connector._build_turn(**kwargs)
            other = connector._build_turn(**kwargs)
            self.assertNotEqual(turn.turn_id, other.turn_id)
            self.assertGreaterEqual(len(turn.turn_id), 60)
            with connector._turn_lock:
                connector._turns_by_chat[turn.chat_id] = turn
                connector._turns_by_id[turn.turn_id] = turn
            self.assertIs(
                connector._turn_for_action(
                    {
                        "chat_id": turn.chat_id,
                        "metadata": {"enterprise_turn_id": turn.turn_id},
                    }
                ),
                turn,
            )
            self.assertIsNone(
                connector._turn_for_action(
                    {
                        "chat_id": turn.chat_id,
                        "metadata": {"enterprise_turn_id": "unknown"},
                    }
                )
            )
            self.assertIsNone(connector._turn_for_action({"chat_id": turn.chat_id, "metadata": {}}))
            self.assertIsNone(
                connector._turn_for_action(
                    {
                        "chat_id": "wrong-chat",
                        "metadata": {"enterprise_turn_id": turn.turn_id},
                    }
                )
            )
            orphan = connector._handle_outbound_action(
                {
                    "op": "send",
                    "chat_id": turn.chat_id,
                    "metadata": {"enterprise_turn_id": "unknown"},
                }
            )
            self.assertFalse(orphan["success"])
            guessed_chat = connector._handle_outbound_action(
                {"op": "send", "chat_id": turn.chat_id, "metadata": {}}
            )
            self.assertFalse(guessed_chat["success"])


class ManagedToolRuntimeSecurityTests(unittest.TestCase):
    def _manager(self, tmp: Path, *, config=None, launcher=None) -> PlatformRuntimeManager:
        return PlatformRuntimeManager(
            config or make_config(tmp),
            _no_secret,
            process_launcher=launcher or RecordingLauncher(),
        )

    def test_camofox_is_exactly_pinned_authenticated_and_state_scoped(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            launcher = RecordingLauncher()
            manager = self._manager(tmp, launcher=launcher)
            command, _, _ = manager._camofox_command()
            self.assertEqual(command[-1], f"@askjo/camofox-browser@{CAMOFOX_MANAGED_VERSION}")
            manager._start_camofox()
            launch = launcher.calls[-1]
            env = launch["env"]
            self.assertEqual(env["CAMOFOX_ACCESS_KEY"], env["CAMOFOX_API_KEY"])
            self.assertGreaterEqual(len(env["CAMOFOX_ACCESS_KEY"]), 32)
            self.assertEqual(env["HOST"], "127.0.0.1")
            self.assertEqual(env["CAMOFOX_CRASH_REPORT_ENABLED"], "false")
            self.assertIn("camofox_loopback.cjs", env["NODE_OPTIONS"])
            for name in ("profiles", "cookies", "traces"):
                self.assertEqual(Path(env[f"CAMOFOX_{name.upper() if name != 'profiles' else 'PROFILE'}_DIR"]).parent, tmp / "runtimes" / "camofox")
            self.assertEqual(
                stat.S_IMODE((tmp / "runtimes" / "camofox" / "access-key").stat().st_mode),
                0o600,
            )

    def test_platform_auth_refresh_waits_for_hermes_auth_lock(self):
        with tempfile.TemporaryDirectory() as td:
            manager = self._manager(Path(td))
            home = manager.config.managed_hermes_home
            home.mkdir(parents=True, exist_ok=True)
            auth_path = home / "auth.json"
            auth_path.write_text('{"version":2,"providers":{}}', encoding="utf-8")
            lock_path = auth_path.with_suffix(".lock")
            lock_fd = os.open(str(lock_path), os.O_RDWR | os.O_CREAT, 0o600)
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            read_started = threading.Event()
            errors = []
            original_read = runtime_module._read_json_mapping

            def tracked_read(path):
                read_started.set()
                return original_read(path)

            def refresh():
                try:
                    manager._write_hermes_auth(home)
                except BaseException as exc:
                    errors.append(exc)

            try:
                with mock.patch.object(runtime_module, "_read_json_mapping", side_effect=tracked_read):
                    thread = threading.Thread(target=refresh)
                    thread.start()
                    time.sleep(0.1)
                    self.assertFalse(read_started.is_set())
                    fcntl.flock(lock_fd, fcntl.LOCK_UN)
                    thread.join(timeout=3)
                self.assertTrue(read_started.is_set())
                self.assertFalse(thread.is_alive())
                self.assertEqual(errors, [])
            finally:
                try:
                    fcntl.flock(lock_fd, fcntl.LOCK_UN)
                finally:
                    os.close(lock_fd)

    @unittest.skipUnless(shutil.which("node"), "Node is required to exercise the loopback preload")
    def test_camofox_preload_forces_implicit_tcp_listeners_to_loopback(self):
        preload = (
            Path(__file__).resolve().parents[1]
            / "enterprise_agent_platform"
            / "hermes_runtime_patch"
            / "camofox_loopback.cjs"
        )
        env = os.environ.copy()
        env["NODE_OPTIONS"] = f"--require={preload}"
        result = subprocess.run(
            [
                "node",
                "-e",
                "const n=require('node:net');const s=n.createServer();"
                "s.listen(0,()=>{console.log(s.address().address);s.close();});",
            ],
            env=env,
            text=True,
            capture_output=True,
            timeout=10,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "127.0.0.1")

    def test_managed_tool_urls_must_be_loopback(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            camofox = self._manager(
                tmp,
                config=replace(make_config(tmp), camofox_url="http://0.0.0.0:9377"),
            ).prepare_camofox()
            self.assertEqual(camofox.state, "invalid_config")
            self.assertIn("loopback", camofox.error)

            firecrawl = self._manager(
                tmp,
                config=replace(make_config(tmp), firecrawl_api_url="http://192.168.1.2:3002"),
            ).prepare_firecrawl()
            self.assertEqual(firecrawl.state, "invalid_config")
            self.assertIn("loopback", firecrawl.error)

    def test_firecrawl_uses_loopback_publish_and_digest_pins(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_fake_firecrawl_repo(tmp / "firecrawl")
            manager = self._manager(tmp)
            env_path = manager._ensure_firecrawl_env()
            self.assertIn('PORT="127.0.0.1:13002"', env_path.read_text(encoding="utf-8"))
            override = manager._ensure_firecrawl_compose_override().read_text(encoding="utf-8")
            expected_images = (
                FIRECRAWL_IMAGE,
                FIRECRAWL_PLAYWRIGHT_IMAGE,
                FIRECRAWL_POSTGRES_IMAGE,
                FIRECRAWL_REDIS_IMAGE,
                FIRECRAWL_RABBITMQ_IMAGE,
                FIRECRAWL_FOUNDATIONDB_IMAGE,
            )
            for service, image in FIRECRAWL_SERVICE_IMAGES:
                self.assertIn(f"  {service}:\n    image: {image}", override)
            for image in expected_images:
                repository, digest = image.rsplit("@sha256:", 1)
                self.assertTrue(repository)
                self.assertEqual(len(digest), 64)
                self.assertTrue(all(character in "0123456789abcdef" for character in digest))
                self.assertNotIn(":", repository.rsplit("/", 1)[-1])
            override_images = [
                line.split("image:", 1)[1].strip()
                for line in override.splitlines()
                if line.strip().startswith("image:")
            ]
            self.assertEqual(len(override_images), len(FIRECRAWL_SERVICE_IMAGES))
            for image in override_images:
                self.assertRegex(image, r"^[^@\s]+@sha256:[0-9a-f]{64}$")

    @unittest.skipUnless(shutil.which("docker"), "Docker Compose is required to merge Firecrawl config")
    def test_firecrawl_merged_compose_uses_only_digest_pinned_images(self):
        compose_version = subprocess.run(
            ["docker", "compose", "version"],
            text=True,
            capture_output=True,
            check=False,
        )
        if compose_version.returncode != 0:
            self.skipTest("docker compose is unavailable")

        repository = Path(__file__).resolve().parents[2] / "firecrawl"
        compose_file = repository / "docker-compose.yaml"
        if not compose_file.is_file():
            self.skipTest("Firecrawl submodule compose file is unavailable")

        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            config = replace(make_config(tmp), firecrawl_repo=repository)
            manager = self._manager(tmp, config=config)
            env_path = manager._ensure_firecrawl_env()
            override = manager._ensure_firecrawl_compose_override()
            service_result = subprocess.run(
                [
                    "docker",
                    "compose",
                    "--env-file",
                    str(env_path),
                    "-f",
                    str(compose_file),
                    "config",
                    "--services",
                ],
                cwd=repository,
                text=True,
                capture_output=True,
                timeout=30,
                check=False,
            )
            self.assertEqual(service_result.returncode, 0, service_result.stderr)
            upstream_services = {
                line.strip() for line in service_result.stdout.splitlines() if line.strip()
            }
            self.assertEqual(upstream_services, {service for service, _ in FIRECRAWL_SERVICE_IMAGES})
            result = subprocess.run(
                [
                    "docker",
                    "compose",
                    "--env-file",
                    str(env_path),
                    "-f",
                    str(compose_file),
                    "-f",
                    str(override),
                    "config",
                    "--format",
                    "json",
                ],
                cwd=repository,
                text=True,
                capture_output=True,
                timeout=30,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            merged = json.loads(result.stdout)
            services = merged.get("services") or {}
            self.assertEqual(set(services), upstream_services)
            for service, image in FIRECRAWL_SERVICE_IMAGES:
                self.assertEqual(services[service]["image"], image)
                self.assertRegex(image, r"^[^@\s]+@sha256:[0-9a-f]{64}$")

    def test_hermes_env_uses_host_terminal_and_shared_runtime_secrets(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            manager = self._manager(tmp)
            values = manager._hermes_child_values()
            self.assertEqual(values["TERMINAL_ENV"], "local")
            self.assertEqual(values["TERMINAL_LOCAL_PERSISTENT"], "false")
            self.assertEqual(values["TERMINAL_PERSISTENT_SHELL"], "false")
            self.assertNotIn("GATEWAY_RELAY_ID", values)
            self.assertNotIn("GATEWAY_RELAY_SECRET", values)
            self.assertEqual(values["CAMOFOX_API_KEY"], manager._camofox_access_key())

            relay_manager = self._manager(
                tmp,
                config=replace(manager.config, hermes_relay_enabled=True),
            )
            relay_values = relay_manager._hermes_child_values()
            relay_id, relay_secret = managed_relay_auth(relay_manager.config)
            self.assertEqual(relay_values["GATEWAY_RELAY_ID"], relay_id)
            self.assertEqual(relay_values["GATEWAY_RELAY_SECRET"], relay_secret)

    def test_disabling_relay_removes_managed_keys_from_existing_hermes_env(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            enabled = self._manager(
                tmp,
                config=replace(make_config(tmp), hermes_relay_enabled=True),
            )
            enabled._write_hermes_env(enabled.config.managed_hermes_home)
            env_path = enabled.config.managed_hermes_home / ".env"
            relay_auth_path = enabled.config.managed_hermes_home / "relay-auth.json"
            self.assertTrue(relay_auth_path.is_file())
            enabled_keys = {
                line.split("=", 1)[0]
                for line in env_path.read_text(encoding="utf-8").splitlines()
                if "=" in line
            }
            self.assertTrue(
                {
                    "GATEWAY_RELAY_URL",
                    "GATEWAY_RELAY_PLATFORMS",
                    "GATEWAY_RELAY_BOT_IDS",
                    "GATEWAY_RELAY_ID",
                    "GATEWAY_RELAY_SECRET",
                }.issubset(enabled_keys)
            )

            disabled = self._manager(
                tmp,
                config=replace(enabled.config, hermes_relay_enabled=False),
            )
            disabled._write_hermes_env(disabled.config.managed_hermes_home)
            remaining_keys = {
                line.split("=", 1)[0]
                for line in env_path.read_text(encoding="utf-8").splitlines()
                if "=" in line
            }
            self.assertFalse(any(key.startswith("GATEWAY_RELAY_") for key in remaining_keys))
            self.assertFalse(relay_auth_path.exists())

    def test_runtime_patch_assets_are_declared_as_package_data(self):
        root = Path(__file__).resolve().parents[1]
        data = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
        patterns = data["tool"]["setuptools"]["package-data"]["enterprise_agent_platform"]
        self.assertIn("hermes_runtime_patch/*.patch", patterns)
        self.assertIn("hermes_runtime_patch/*.cjs", patterns)
        patch_text = (
            root
            / "enterprise_agent_platform"
            / "hermes_runtime_patch"
            / "hermes_agent_isolation.patch"
        ).read_text(encoding="utf-8")
        self.assertIn('meta["enterprise_turn_id"] = message_id', patch_text)
        self.assertIn('self._message_by_chat[str(chat)] = str(message_id)', patch_text)
        sitecustomize = (
            root / "enterprise_agent_platform" / "hermes_runtime_patch" / "sitecustomize.py"
        ).read_text(encoding="utf-8")
        self.assertIn("/api/enterprise-patch-status", sitecustomize)
        self.assertIn("for _component, _installer in (", sitecustomize)

    def test_managed_health_probe_requires_2xx_and_expected_json_shape(self):
        validator = lambda payload: payload.get("ok") is True and payload.get("engine") == "camoufox"
        with mock.patch(
            "enterprise_agent_platform.runtimes.urllib.request.urlopen",
            return_value=_FakeHTTPResponse(404, {"ok": True, "engine": "camoufox"}),
        ):
            self.assertFalse(
                PlatformRuntimeManager._probe_json_health("http://127.0.0.1:9", ("/health",), validator)
            )
        with mock.patch(
            "enterprise_agent_platform.runtimes.urllib.request.urlopen",
            return_value=_FakeHTTPResponse(200, {"status": "some unrelated service"}),
        ):
            self.assertFalse(
                PlatformRuntimeManager._probe_json_health("http://127.0.0.1:9", ("/health",), validator)
            )
        with mock.patch(
            "enterprise_agent_platform.runtimes.urllib.request.urlopen",
            return_value=_FakeHTTPResponse(200, {"ok": True, "engine": "camoufox"}),
        ):
            self.assertTrue(
                PlatformRuntimeManager._probe_json_health("http://127.0.0.1:9", ("/health",), validator)
            )

    def test_hermes_patch_status_is_authenticated_and_exposed(self):
        with tempfile.TemporaryDirectory() as td:
            manager = PlatformRuntimeManager(
                make_config(Path(td)),
                lambda key: "patch-api-key" if key == "API_SERVER_KEY" else "",
                process_launcher=RecordingLauncher(),
            )
            captured = []

            def open_request(request, timeout):
                captured.append((request, timeout))
                return _FakeHTTPResponse(
                    200,
                    {
                        "object": "enterprise.hermes_patch_status",
                        "ok": True,
                        "status": {"api_async": "ok", "relay": "ok"},
                        "failed": {},
                    },
                )

            with mock.patch(
                "enterprise_agent_platform.runtimes.urllib.request.urlopen",
                side_effect=open_request,
            ):
                status = manager._probe_hermes_patch_status()
            self.assertTrue(status["available"])
            self.assertTrue(status["ok"])
            self.assertEqual(status["components"]["api_async"], "ok")
            self.assertEqual(captured[0][0].get_header("Authorization"), "Bearer patch-api-key")

    def test_relay_no_module_is_a_required_patch_failure(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            from enterprise_agent_platform.hermes_runtime_patch import sitecustomize

            failed = sitecustomize._failed_patch_components(
                {"codex": "ok", "aux": "ok", "api_async": "ok", "relay": "no_module"}
            )
        self.assertEqual(failed, {"relay": "no_module"})

    def test_hermes_health_is_degraded_when_required_patch_status_fails(self):
        with tempfile.TemporaryDirectory() as td:
            manager = self._manager(Path(td))
            manager._probe_hermes_health = lambda: True
            manager._probe_hermes_patch_status = lambda: {
                "available": True,
                "ok": False,
                "components": {"relay": "no_module"},
                "failed": {"relay": "no_module"},
            }

            status = manager.hermes_status(refresh=True)

            self.assertFalse(status.available)
            self.assertEqual(status.state, "degraded")
            self.assertIn("relay=no_module", status.error)
            self.assertFalse(status.patch_status["ok"])
            self.assertIsNone(manager._hermes_health_checked_at)


if __name__ == "__main__":
    unittest.main()
