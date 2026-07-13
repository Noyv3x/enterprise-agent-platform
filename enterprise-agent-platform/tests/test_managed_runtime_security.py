from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

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

from test_platform import (
    RecordingCommandRunner,
    RecordingLauncher,
    make_config,
    make_fake_firecrawl_repo,
)


def _no_secret(_key: str) -> str:
    return ""


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


class ManagedToolRuntimeSecurityTests(unittest.TestCase):
    def _manager(self, tmp: Path, *, config=None, launcher=None, secret_provider=None) -> PlatformRuntimeManager:
        return PlatformRuntimeManager(
            config or make_config(tmp),
            secret_provider or _no_secret,
            process_launcher=launcher or RecordingLauncher(),
        )

    def test_agent_runtime_health_probe_authenticates_with_runtime_token(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            config = replace(make_config(tmp), agent_runtime_token="runtime-secret")
            manager = self._manager(tmp, config=config)
            captured = []

            def open_request(request, timeout):
                captured.append((request, timeout))
                return _FakeHTTPResponse(200, {"ok": True})

            with mock.patch(
                "enterprise_agent_platform.runtimes.urllib.request.urlopen",
                side_effect=open_request,
            ):
                self.assertTrue(manager._probe_agent_health())

            self.assertEqual(captured[0][0].full_url, "http://127.0.0.1:8766/health")
            self.assertEqual(captured[0][0].get_header("Authorization"), "Bearer runtime-secret")
            self.assertEqual(captured[0][1], 1.0)

    def test_agent_runtime_env_keeps_oauth_credentials_out_of_child(self):
        secrets = {
            "CODEX_OAUTH_ACCESS_TOKEN": "access",
            "CODEX_OAUTH_REFRESH_TOKEN": "refresh",
            "GROK_OAUTH_ACCESS_TOKEN": "grok-access",
            "GROK_OAUTH_REFRESH_TOKEN": "grok-refresh",
            "agent_tool_token": "internal-token",
            "agent_runtime_token": "runtime-bearer",
        }
        with tempfile.TemporaryDirectory() as td:
            manager = self._manager(Path(td), secret_provider=lambda key: secrets.get(key, ""))
            with mock.patch.dict(
                os.environ,
                {**secrets, "UNRELATED_PASSWORD": "must-not-leak"},
            ):
                env = manager._agent_runtime_process_env()

            self.assertEqual(env["AGENT_PLATFORM_INTERNAL_TOKEN"], "internal-token")
            self.assertEqual(env["AGENT_RUNTIME_TOKEN"], "runtime-token")
            self.assertNotEqual(env["AGENT_RUNTIME_TOKEN"], env["AGENT_PLATFORM_INTERNAL_TOKEN"])
            self.assertEqual(env["AGENT_RUNTIME_RUN_TIMEOUT_MS"], "2000")
            self.assertNotIn("CODEX_OAUTH_ACCESS_TOKEN", env)
            self.assertNotIn("CODEX_OAUTH_REFRESH_TOKEN", env)
            self.assertNotIn("GROK_OAUTH_ACCESS_TOKEN", env)
            self.assertNotIn("GROK_OAUTH_REFRESH_TOKEN", env)
            self.assertNotIn("UNRELATED_PASSWORD", env)

    def test_agent_runtime_internal_gateway_never_uses_public_base_url(self):
        with tempfile.TemporaryDirectory() as td:
            config = replace(
                make_config(Path(td)),
                host="0.0.0.0",
                port=8765,
                public_base_url="https://agents.example",
            )
            manager = self._manager(Path(td), config=config)

            env = manager._agent_runtime_process_env()

            self.assertEqual(env["AGENT_PLATFORM_INTERNAL_URL"], "http://127.0.0.1:8765")
            self.assertNotIn("agents.example", env["AGENT_PLATFORM_INTERNAL_URL"])

    def test_agent_runtime_installer_scrubs_parent_secrets_from_npm_environment(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            runner = RecordingCommandRunner()
            manager = PlatformRuntimeManager(
                replace(make_config(tmp), manage_agent_runtime=True),
                _no_secret,
                process_launcher=RecordingLauncher(),
                command_runner=runner,
            )
            with mock.patch.dict(
                os.environ,
                {
                    "DEPLOY_PASSWORD": "must-not-leak",
                    "CODEX_OAUTH_ACCESS_TOKEN": "must-not-leak",
                    "SAFE_BUILD_FLAG": "enabled",
                },
            ):
                status = manager.install_agent_runtime(force=True)

            self.assertFalse(status.available)
            self.assertTrue(runner.calls)
            install_env = runner.calls[0]["env"]
            self.assertNotIn("DEPLOY_PASSWORD", install_env)
            self.assertNotIn("CODEX_OAUTH_ACCESS_TOKEN", install_env)
            self.assertEqual(install_env["SAFE_BUILD_FLAG"], "enabled")

    def test_camofox_is_exactly_pinned_authenticated_and_state_scoped(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            launcher = RecordingLauncher()
            manager = self._manager(tmp, launcher=launcher)
            command, _, _ = manager._camofox_command()
            self.assertEqual(command[-1], f"@askjo/camofox-browser@{CAMOFOX_MANAGED_VERSION}")
            manager._start_camofox()
            env = launcher.calls[-1]["env"]
            self.assertEqual(env["CAMOFOX_ACCESS_KEY"], env["CAMOFOX_API_KEY"])
            self.assertGreaterEqual(len(env["CAMOFOX_ACCESS_KEY"]), 32)
            self.assertEqual(env["HOST"], "127.0.0.1")
            self.assertEqual(env["CAMOFOX_CRASH_REPORT_ENABLED"], "false")
            self.assertNotIn("NODE_OPTIONS", env)
            for name in ("profiles", "cookies", "traces"):
                key = f"CAMOFOX_{name.upper() if name != 'profiles' else 'PROFILE'}_DIR"
                self.assertEqual(Path(env[key]).parent, tmp / "runtimes" / "camofox")
            self.assertEqual(
                stat.S_IMODE((tmp / "runtimes" / "camofox" / "access-key").stat().st_mode),
                0o600,
            )

    @unittest.skipUnless(shutil.which("node"), "Node is required to exercise the loopback preload")

    def test_managed_tool_urls_must_be_loopback(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agent = self._manager(
                tmp,
                config=replace(
                    make_config(tmp),
                    manage_agent_runtime=True,
                    agent_runtime_url="http://0.0.0.0:8766",
                ),
            ).prepare_agent_runtime()
            self.assertEqual(agent.state, "invalid_config")
            self.assertIn("loopback", agent.error)

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
                    "docker", "compose", "--env-file", str(env_path),
                    "-f", str(compose_file), "config", "--services",
                ],
                cwd=repository,
                text=True,
                capture_output=True,
                timeout=30,
                check=False,
            )
            self.assertEqual(service_result.returncode, 0, service_result.stderr)
            upstream_services = {line.strip() for line in service_result.stdout.splitlines() if line.strip()}
            self.assertEqual(upstream_services, {service for service, _ in FIRECRAWL_SERVICE_IMAGES})
            result = subprocess.run(
                [
                    "docker", "compose", "--env-file", str(env_path),
                    "-f", str(compose_file), "-f", str(override),
                    "config", "--format", "json",
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


if __name__ == "__main__":
    unittest.main()
