from __future__ import annotations

import os
import stat
import tempfile
import threading
import time
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

from enterprise_agent_platform.runtimes import (
    SEARXNG_COMPOSE_FILE,
    SEARXNG_COMPOSE_WAIT_MIN_SECONDS,
    PlatformRuntimeManager,
    RuntimeStatus,
)

from test_platform import (
    RecordingCommandRunner,
    RecordingLauncher,
    make_config,
    make_fake_firecrawl_repo,
)


class ExitedProcess:
    """Process fake whose ``poll`` reports a configurable exit state."""

    def __init__(self, pid=55001, returncode=7):
        self.pid = pid
        self._returncode = returncode

    def poll(self):
        return self._returncode

    def terminate(self):
        pass

    def wait(self, timeout=None):
        return self._returncode

    def kill(self):
        pass


def _no_secret(_key):
    return ""


def _make_manager(tmp, *, wait=0, launcher=None, runner=None, settings=None):
    config = replace(make_config(tmp), runtime_startup_wait_seconds=wait)
    manager = PlatformRuntimeManager(
        config,
        _no_secret,
        process_launcher=launcher or RecordingLauncher(),
        command_runner=runner or RecordingCommandRunner(),
        setting_provider=(settings.get if settings is not None else None),
    )
    return config, manager


class RuntimeStartupWaitTests(unittest.TestCase):
    def test_zero_config_wait_does_not_apply_heavy_floor(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            for key in (
                "ENTERPRISE_FIRECRAWL_STARTUP_WAIT_SECONDS",
                "ENTERPRISE_CAMOFOX_STARTUP_WAIT_SECONDS",
                "ENTERPRISE_SEARXNG_STARTUP_WAIT_SECONDS",
            ):
                os.environ.pop(key, None)
            _, manager = _make_manager(tmp, wait=0)
            self.assertEqual(manager._runtime_startup_wait_seconds("firecrawl"), 0.0)
            self.assertEqual(manager._runtime_startup_wait_seconds("camofox"), 0.0)
            self.assertEqual(manager._runtime_startup_wait_seconds("searxng"), 0.0)

    def test_positive_config_wait_applies_heavy_floor(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            for key in (
                "ENTERPRISE_FIRECRAWL_STARTUP_WAIT_SECONDS",
                "ENTERPRISE_CAMOFOX_STARTUP_WAIT_SECONDS",
                "ENTERPRISE_SEARXNG_STARTUP_WAIT_SECONDS",
            ):
                os.environ.pop(key, None)
            _, manager = _make_manager(tmp, wait=5)
            self.assertEqual(manager._runtime_startup_wait_seconds("firecrawl"), 300.0)
            self.assertEqual(manager._runtime_startup_wait_seconds("camofox"), 120.0)
            self.assertEqual(manager._runtime_startup_wait_seconds("searxng"), 120.0)
            _, manager_big = _make_manager(tmp, wait=500)
            self.assertEqual(manager_big._runtime_startup_wait_seconds("firecrawl"), 500.0)
            self.assertEqual(manager_big._runtime_startup_wait_seconds("camofox"), 500.0)
            self.assertEqual(manager_big._runtime_startup_wait_seconds("searxng"), 500.0)

    def test_env_override_takes_precedence_over_floor(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            os.environ["ENTERPRISE_FIRECRAWL_STARTUP_WAIT_SECONDS"] = "0"
            os.environ["ENTERPRISE_SEARXNG_STARTUP_WAIT_SECONDS"] = "17"
            try:
                _, manager = _make_manager(tmp, wait=5)
                self.assertEqual(manager._runtime_startup_wait_seconds("firecrawl"), 0.0)
                os.environ.pop("ENTERPRISE_CAMOFOX_STARTUP_WAIT_SECONDS", None)
                self.assertEqual(manager._runtime_startup_wait_seconds("camofox"), 120.0)
                self.assertEqual(manager._runtime_startup_wait_seconds("searxng"), 17.0)
            finally:
                os.environ.pop("ENTERPRISE_FIRECRAWL_STARTUP_WAIT_SECONDS", None)
                os.environ.pop("ENTERPRISE_SEARXNG_STARTUP_WAIT_SECONDS", None)

    def test_successful_firecrawl_compose_exit_keeps_waiting_for_http(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_fake_firecrawl_repo(tmp / "firecrawl")
            launcher = mock.MagicMock()
            launcher.start.return_value = ExitedProcess(returncode=0)
            _, manager = _make_manager(tmp, wait=1, launcher=launcher)
            try:
                with (
                    mock.patch.object(
                        manager,
                        "_runtime_startup_wait_seconds",
                        return_value=1.0,
                    ),
                    mock.patch.object(
                        manager,
                        "_probe_firecrawl_health",
                        side_effect=[False, True],
                    ) as health,
                    mock.patch(
                        "enterprise_agent_platform.runtimes.time.sleep"
                    ),
                ):
                    status = manager.ensure_firecrawl_ready(wait=True)

                self.assertTrue(status.available)
                self.assertEqual(status.state, "running")
                self.assertEqual(health.call_count, 2)
                self.assertTrue(manager._firecrawl_launch_confirmed)
            finally:
                manager.close()


class AgentRuntimeProcessEnvTests(unittest.TestCase):
    def test_process_env_is_scoped_to_managed_runtime_and_never_contains_refresh_tokens(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            config, manager = _make_manager(tmp)
            env = manager._agent_runtime_process_env()

            self.assertEqual(env["AGENT_RUNTIME_HOME"], str(config.managed_agent_runtime_home))
            self.assertEqual(env["AGENT_RUNTIME_HOST"], "127.0.0.1")
            self.assertEqual(env["AGENT_RUNTIME_PORT"], "8766")
            self.assertEqual(env["AGENT_RUNTIME_RUN_IDLE_TIMEOUT_MS"], "2000")
            self.assertNotIn("AGENT_RUNTIME_RUN_TIMEOUT_MS", env)
            self.assertEqual(env["AGENT_PLATFORM_INTERNAL_TOKEN"], "")
            self.assertNotIn("CODEX_OAUTH_REFRESH_TOKEN", env)
            self.assertNotIn("GROK_OAUTH_REFRESH_TOKEN", env)


class FirecrawlEnvLocationTests(unittest.TestCase):
    def test_managed_env_written_under_runtime_dir_not_submodule(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            repo = tmp / "firecrawl"
            make_fake_firecrawl_repo(repo)
            config, manager = _make_manager(tmp, wait=0)
            config.firecrawl_runtime_dir.mkdir(parents=True, exist_ok=True)
            (config.firecrawl_runtime_dir / ".env").write_text(
                'SEARXNG_ENDPOINT="http://searxng:8080"\n'
                'SEARXNG_PORT="127.0.0.1:13003"\n',
                encoding="utf-8",
            )
            env_path = manager._ensure_firecrawl_env()
            self.assertEqual(env_path, config.firecrawl_runtime_dir / ".env")
            self.assertTrue(env_path.exists())
            self.assertFalse((repo / ".env").exists())
            text = env_path.read_text(encoding="utf-8")
            self.assertIn("BULL_AUTH_KEY=", text)
            self.assertIn('PORT="127.0.0.1:13002"', text)
            self.assertNotIn("SEARXNG_ENDPOINT", text)
            self.assertNotIn("SEARXNG_PORT", text)
            self.assertIn('USE_DB_AUTHENTICATION="false"', text)
            manager._ensure_firecrawl_env()
            self.assertFalse((config.firecrawl_runtime_dir / "searxng").exists())
            self.assertFalse((repo / "searxng").exists())

    def test_managed_sources_ignore_legacy_database_repo_settings(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            config = replace(
                make_config(tmp),
                cognee_repo=tmp / "managed-cognee",
                firecrawl_repo=tmp / "managed-firecrawl",
                manage_cognee=True,
                manage_firecrawl=True,
            )
            settings = {
                "cognee_repo": str(tmp / "legacy-cognee"),
                "firecrawl_repo": str(tmp / "legacy-firecrawl"),
            }
            manager = PlatformRuntimeManager(
                config,
                _no_secret,
                process_launcher=RecordingLauncher(),
                command_runner=RecordingCommandRunner(),
                setting_provider=settings.get,
            )

            self.assertEqual(manager._effective_cognee_repo(), config.cognee_repo)
            self.assertEqual(manager._effective_firecrawl_repo(), config.firecrawl_repo)

    def test_prepare_firecrawl_materializes_env_in_runtime_dir(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            repo = tmp / "firecrawl"
            make_fake_firecrawl_repo(repo)
            config, manager = _make_manager(tmp, wait=0)
            status = manager.prepare_firecrawl()
            self.assertTrue(status.available)
            self.assertTrue((config.firecrawl_runtime_dir / ".env").exists())
            self.assertFalse((config.firecrawl_runtime_dir / "searxng").exists())
            self.assertFalse((repo / ".env").exists())
            self.assertFalse((repo / "searxng").exists())


class SearXNGRuntimeLocationTests(unittest.TestCase):
    def test_prepare_materializes_independent_private_config_and_cache(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            config = replace(
                make_config(tmp),
                manage_searxng=True,
                runtime_startup_wait_seconds=0,
            )
            manager = PlatformRuntimeManager(
                config,
                _no_secret,
                process_launcher=RecordingLauncher(),
                command_runner=RecordingCommandRunner(),
            )

            status = manager.prepare_searxng()

            self.assertTrue(status.available)
            runtime_dir = config.runtime_dir / "searxng"
            config_dir = runtime_dir / "config"
            cache_dir = runtime_dir / "cache"
            logs_dir = runtime_dir / "logs"
            settings_path = config_dir / "settings.yml"
            secret_path = runtime_dir / "secret-key"
            compose_path = runtime_dir / SEARXNG_COMPOSE_FILE
            for directory in (runtime_dir, config_dir, cache_dir, logs_dir):
                self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
            for path in (settings_path, secret_path, compose_path):
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            compose = compose_path.read_text(encoding="utf-8")
            self.assertIn(f'"{config_dir}:/etc/searxng:ro"', compose)
            self.assertIn(f'"{cache_dir}:/var/cache/searxng"', compose)
            self.assertNotIn(str(config.firecrawl_runtime_dir), compose)
            self.assertIn(
                "  formats:\n    - json",
                settings_path.read_text(encoding="utf-8"),
            )

            settings_inode = settings_path.stat().st_ino
            secret = secret_path.read_text(encoding="utf-8")
            manager.prepare_searxng()
            self.assertEqual(settings_path.stat().st_ino, settings_inode)
            self.assertEqual(secret_path.read_text(encoding="utf-8"), secret)


class ProcessCrashDetectionTests(unittest.TestCase):
    def test_agent_runtime_nonzero_exit_surfaces_stopped_not_available(self):
        with tempfile.TemporaryDirectory() as td:
            _, manager = _make_manager(Path(td), wait=0)
            manager._agent_process = ExitedProcess(returncode=11)
            status = manager.agent_runtime_status(refresh=False)
            self.assertFalse(status.available)
            self.assertEqual(status.state, "stopped")
            self.assertIn("exited with code 11", status.error)

    def test_firecrawl_nonzero_exit_surfaces_error_not_running(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_fake_firecrawl_repo(tmp / "firecrawl")
            _, manager = _make_manager(tmp, wait=0)
            manager._firecrawl_process = ExitedProcess(returncode=9)
            status = manager.firecrawl_status(refresh=False)
            self.assertFalse(status.available)
            self.assertEqual(status.state, "error")
            self.assertIn("exited with code 9", status.error)
            self.assertNotIn(status.state, {"running", "starting"})

    def test_camofox_nonzero_exit_surfaces_error_not_running(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            _, manager = _make_manager(tmp, wait=0)
            manager._camofox_process = ExitedProcess(returncode=3)
            status = manager.camofox_status(refresh=False)
            self.assertFalse(status.available)
            self.assertEqual(status.state, "error")
            self.assertIn("exited with code 3", status.error)
            self.assertNotIn(status.state, {"running", "starting"})

    def test_searxng_nonzero_exit_surfaces_error_not_running(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            config = replace(
                make_config(tmp),
                manage_searxng=True,
                runtime_startup_wait_seconds=0,
            )
            manager = PlatformRuntimeManager(
                config,
                _no_secret,
                process_launcher=RecordingLauncher(),
                command_runner=RecordingCommandRunner(),
            )
            manager._searxng_process = ExitedProcess(returncode=13)

            status = manager.searxng_status(refresh=False)

            self.assertFalse(status.available)
            self.assertEqual(status.state, "error")
            self.assertIn("exited with code 13", status.error)
            self.assertNotIn(status.state, {"running", "starting"})


class RuntimeStatusCacheTests(unittest.TestCase):
    def test_healthy_ensure_fast_path_does_not_invalidate_status_cache(self):
        with tempfile.TemporaryDirectory() as td:
            _, manager = _make_manager(Path(td), wait=0)
            with manager._status_cache_lock:
                manager._status_cache_checked_at = time.time()
                generation = manager._status_cache_generation
                checked_at = manager._status_cache_checked_at
            manager.agent_runtime_status = lambda **_kwargs: RuntimeStatus(
                "agent",
                True,
                True,
                "running",
            )

            result = manager.ensure_agent_runtime_ready()

            self.assertTrue(result.available)
            with manager._status_cache_lock:
                self.assertEqual(manager._status_cache_generation, generation)
                self.assertEqual(manager._status_cache_checked_at, checked_at)
            manager.close()

    def test_cached_status_returns_immediately_and_refreshes_in_background(self):
        with tempfile.TemporaryDirectory() as td:
            _, manager = _make_manager(Path(td), wait=0)
            refresh_started = threading.Event()
            release_refresh = threading.Event()
            calls = []

            def fake_status(*, refresh=True):
                calls.append(refresh)
                if refresh:
                    refresh_started.set()
                    release_refresh.wait(2)
                state = "running" if refresh else "unknown"
                return {
                    name: {"name": name, "state": state}
                    for name in (
                        "agent",
                        "cognee",
                        "camofox",
                        "searxng",
                        "firecrawl",
                    )
                }

            manager.status = fake_status
            started = time.monotonic()
            first = manager.cached_status()
            elapsed = time.monotonic() - started
            self.assertLess(elapsed, 0.2)
            self.assertTrue(first["stale"])
            self.assertIsNone(first["checked_at"])
            self.assertTrue(refresh_started.wait(1))

            release_refresh.set()
            deadline = time.monotonic() + 2
            while manager.cached_status()["stale"] and time.monotonic() < deadline:
                time.sleep(0.01)
            refreshed = manager.cached_status()
            self.assertFalse(refreshed["stale"])
            self.assertIsNotNone(refreshed["checked_at"])
            self.assertEqual(refreshed["agent"]["state"], "running")
            self.assertEqual(calls.count(True), 1)
            manager.close()

    def test_cached_status_refresh_is_single_flight(self):
        with tempfile.TemporaryDirectory() as td:
            _, manager = _make_manager(Path(td), wait=0)
            refresh_started = threading.Event()
            release_refresh = threading.Event()
            refresh_calls = 0

            def fake_status(*, refresh=True):
                nonlocal refresh_calls
                if refresh:
                    refresh_calls += 1
                    refresh_started.set()
                    release_refresh.wait(2)
                return {
                    name: {"name": name, "state": "ready"}
                    for name in (
                        "agent",
                        "cognee",
                        "camofox",
                        "searxng",
                        "firecrawl",
                    )
                }

            manager.status = fake_status
            for _ in range(10):
                manager.cached_status(max_age_seconds=0)
            self.assertTrue(refresh_started.wait(1))
            self.assertEqual(refresh_calls, 1)
            release_refresh.set()
            manager.close()

    def test_concurrent_first_cached_status_builds_initial_snapshot_once(self):
        with tempfile.TemporaryDirectory() as td:
            _, manager = _make_manager(Path(td), wait=0)
            calls = 0
            calls_lock = threading.Lock()
            start = threading.Barrier(9)
            failures = []

            def fake_status(*, refresh=True):
                nonlocal calls
                self.assertFalse(refresh)
                with calls_lock:
                    calls += 1
                time.sleep(0.05)
                return {
                    name: {"name": name, "state": "initial"}
                    for name in (
                        "agent",
                        "cognee",
                        "camofox",
                        "searxng",
                        "firecrawl",
                    )
                }

            def read_cached_status():
                try:
                    start.wait()
                    manager.cached_status()
                except Exception as exc:  # pragma: no cover - assertion aid.
                    failures.append(exc)

            manager.status = fake_status
            manager.refresh_status_async = mock.Mock()
            threads = [
                threading.Thread(target=read_cached_status)
                for _ in range(8)
            ]
            for thread in threads:
                thread.start()
            start.wait()
            for thread in threads:
                thread.join(1)

            self.assertFalse(failures)
            self.assertTrue(all(not thread.is_alive() for thread in threads))
            self.assertEqual(calls, 1)
            manager.close()

    def test_cached_searxng_status_is_single_flight_and_searxng_only(self):
        with tempfile.TemporaryDirectory() as td:
            _, manager = _make_manager(Path(td), wait=0)
            refresh_started = threading.Event()
            release_refresh = threading.Event()
            calls = []

            def fake_searxng_status(*, refresh=True):
                calls.append(refresh)
                if refresh:
                    refresh_started.set()
                    release_refresh.wait(2)
                return RuntimeStatus(
                    "searxng",
                    True,
                    refresh,
                    "running" if refresh else "prepared",
                )

            manager.searxng_status = fake_searxng_status
            manager.status = mock.Mock(
                side_effect=AssertionError(
                    "SearXNG cache must not refresh all runtimes"
                )
            )
            for _ in range(10):
                manager.cached_searxng_status(max_age_seconds=0)
            self.assertTrue(refresh_started.wait(1))
            self.assertEqual(calls.count(False), 1)
            self.assertEqual(calls.count(True), 1)
            manager.status.assert_not_called()

            release_refresh.set()
            with manager._searxng_status_cache_lock:
                refresh_thread = manager._searxng_status_refresh_thread
            self.assertIsNotNone(refresh_thread)
            refresh_thread.join(1)
            self.assertFalse(refresh_thread.is_alive())

            manager.invalidate_status_cache()
            with manager._searxng_status_cache_lock:
                self.assertEqual(
                    manager._searxng_status_cache_checked_at,
                    0.0,
                )
            manager.close()

    def test_invalidated_refresh_generation_cannot_commit_stale_result(self):
        with tempfile.TemporaryDirectory() as td:
            _, manager = _make_manager(Path(td), wait=0)
            refresh_started = threading.Event()
            release_refresh = threading.Event()
            refresh_finished = threading.Event()

            def fake_status(*, refresh=True):
                if refresh:
                    refresh_started.set()
                    release_refresh.wait(2)
                    refresh_finished.set()
                state = "refreshed" if refresh else "uncached"
                return {
                    name: {"name": name, "state": state}
                    for name in (
                        "agent",
                        "cognee",
                        "camofox",
                        "searxng",
                        "firecrawl",
                    )
                }

            manager.status = fake_status
            with manager._status_cache_lock:
                manager._status_cache = {
                    name: {"name": name, "state": "cached"}
                    for name in (
                        "agent",
                        "cognee",
                        "camofox",
                        "searxng",
                        "firecrawl",
                    )
                }
                manager._status_cache_checked_at = time.time()

            try:
                manager.cached_status(max_age_seconds=0)
                self.assertTrue(refresh_started.wait(1))
                with manager._status_cache_lock:
                    refresh_thread = manager._status_refresh_thread
                self.assertIsNotNone(refresh_thread)

                manager.invalidate_status_cache()
                release_refresh.set()
                self.assertTrue(refresh_finished.wait(1))
                refresh_thread.join(1)
                self.assertFalse(refresh_thread.is_alive())

                with manager._status_cache_lock:
                    self.assertEqual(manager._status_cache_checked_at, 0.0)
                    self.assertEqual(
                        manager._status_cache["agent"]["state"],
                        "cached",
                    )
            finally:
                release_refresh.set()
                manager.close()

    def test_runtime_mutation_invalidates_a_fresh_status_snapshot(self):
        with tempfile.TemporaryDirectory() as td:
            _, manager = _make_manager(Path(td), wait=0)
            with manager._status_cache_lock:
                manager._status_cache = {
                    name: {"name": name, "state": "running"}
                    for name in (
                        "agent",
                        "cognee",
                        "camofox",
                        "searxng",
                        "firecrawl",
                    )
                }
                manager._status_cache_checked_at = time.time()

            manager.invalidate_status_cache()

            with manager._status_cache_lock:
                self.assertEqual(manager._status_cache_checked_at, 0.0)
                self.assertEqual(
                    manager._status_cache["agent"]["state"],
                    "running",
                )
            manager.close()


class SearXNGComposeLifecycleTests(unittest.TestCase):
    def _manager(self, tmp, *, launcher=None, runner=None):
        config = replace(
            make_config(tmp),
            manage_searxng=True,
            runtime_startup_wait_seconds=0,
        )
        return PlatformRuntimeManager(
            config,
            _no_secret,
            process_launcher=launcher or RecordingLauncher(),
            command_runner=runner or RecordingCommandRunner(),
        )

    def test_stop_runs_compose_down_for_managed_stack_without_deleting_cache(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            launcher = RecordingLauncher()
            runner = RecordingCommandRunner()
            manager = self._manager(tmp, launcher=launcher, runner=runner)
            with mock.patch.object(
                manager,
                "_probe_searxng_health",
                return_value=False,
            ):
                manager.ensure_searxng_ready(wait=False)

            up_calls = [
                call
                for call in launcher.calls
                if call["cmd"][:2] == ["docker", "compose"]
                and "up" in call["cmd"]
            ]
            self.assertEqual(len(up_calls), 1)
            up_cmd = up_calls[0]["cmd"]
            self.assertIn("--project-name", up_cmd)
            self.assertIn(manager._searxng_compose_project(), up_cmd)
            self.assertIn("--detach", up_cmd)
            self.assertIn("--wait", up_cmd)
            self.assertIn("--wait-timeout", up_cmd)
            wait_timeout_index = up_cmd.index("--wait-timeout")
            self.assertEqual(
                up_cmd[wait_timeout_index + 1],
                str(SEARXNG_COMPOSE_WAIT_MIN_SECONDS),
            )
            self.assertIn(
                str(tmp / "runtimes" / "searxng" / SEARXNG_COMPOSE_FILE),
                up_cmd,
            )
            self.assertIsNotNone(manager._searxng_compose_teardown)

            manager.stop_searxng()

            down_calls = [
                call
                for call in runner.calls
                if call["cmd"][:2] == ["docker", "compose"]
                and "down" in call["cmd"]
            ]
            self.assertEqual(len(down_calls), 1)
            down_cmd = down_calls[0]["cmd"]
            self.assertIn("--project-name", down_cmd)
            self.assertIn(manager._searxng_compose_project(), down_cmd)
            self.assertIn("--remove-orphans", down_cmd)
            self.assertNotIn("-v", down_cmd)
            self.assertNotIn("--volumes", down_cmd)
            self.assertIsNone(manager._searxng_compose_teardown)
            self.assertTrue((tmp / "runtimes" / "searxng" / "cache").is_dir())

    def test_prepare_rejects_compose_without_up_wait_support(self):
        class UnsupportedComposeRunner(RecordingCommandRunner):
            def run(self, cmd, *, cwd, env, log_path, timeout):
                result = super().run(
                    cmd,
                    cwd=cwd,
                    env=env,
                    log_path=log_path,
                    timeout=timeout,
                )
                if "--help" in cmd and "--wait" in cmd:
                    return type(result)(cmd, 2)
                return result

        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            launcher = RecordingLauncher()
            runner = UnsupportedComposeRunner()
            manager = self._manager(
                tmp,
                launcher=launcher,
                runner=runner,
            )

            status = manager.prepare_searxng()

            self.assertFalse(status.available)
            self.assertEqual(status.state, "missing")
            self.assertIn("`up --wait` support is required", status.error)
            self.assertIn("update Docker Compose", status.error)
            self.assertFalse(launcher.calls)
            capability_calls = [
                call
                for call in runner.calls
                if "--help" in call["cmd"] and "--wait" in call["cmd"]
            ]
            self.assertEqual(len(capability_calls), 1)
            capability_command = capability_calls[0]["cmd"]
            self.assertIn("--wait-timeout", capability_command)
            self.assertEqual(
                capability_command[
                    capability_command.index("--wait-timeout") + 1
                ],
                "1",
            )

    def test_stop_reaps_compose_up_before_compose_down(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            events = []

            class OrderedProcess:
                pid = 68123

                def __init__(self):
                    self.running = True

                def poll(self):
                    return None if self.running else 0

                def terminate(self):
                    events.append("terminate")
                    self.running = False

                def wait(self, timeout=None):
                    events.append("wait")
                    return 0

                def kill(self):
                    events.append("kill")
                    self.running = False

            class OrderedRunner(RecordingCommandRunner):
                def run(self, cmd, *, cwd, env, log_path, timeout):
                    if "down" in cmd:
                        events.append("down")
                    return super().run(
                        cmd,
                        cwd=cwd,
                        env=env,
                        log_path=log_path,
                        timeout=timeout,
                    )

            launcher = mock.MagicMock()
            launcher.start.return_value = OrderedProcess()
            manager = self._manager(
                tmp,
                launcher=launcher,
                runner=OrderedRunner(),
            )
            with mock.patch.object(
                manager,
                "_probe_searxng_health",
                return_value=False,
            ):
                manager.ensure_searxng_ready(wait=False)

            manager.stop_searxng()

            self.assertIn("terminate", events)
            self.assertIn("wait", events)
            self.assertIn("down", events)
            self.assertLess(events.index("wait"), events.index("down"))

    def test_status_probe_cannot_publish_state_from_before_concurrent_stop(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            manager = self._manager(
                tmp,
                runner=RecordingCommandRunner(),
            )
            command, cwd, _detail = manager._searxng_command()
            teardown = manager._searxng_compose_teardown_command(command, cwd)
            self.assertIsNotNone(teardown)
            with manager._searxng_state_lock:
                manager._searxng_compose_teardown = teardown
                manager._searxng_launch_confirmed = True
                manager._searxng_state_generation += 1

            probe_started = threading.Event()
            release_probe = threading.Event()
            stop_done = threading.Event()
            results = []
            probe_calls = 0

            def probe():
                nonlocal probe_calls
                probe_calls += 1
                if probe_calls == 1:
                    probe_started.set()
                    release_probe.wait(2)
                    return True
                return False

            def read_status():
                results.append(manager.searxng_status(refresh=True))

            def stop_runtime():
                manager.stop_searxng()
                stop_done.set()

            with mock.patch.object(
                manager,
                "_probe_searxng_health",
                side_effect=probe,
            ):
                status_thread = threading.Thread(target=read_status)
                status_thread.start()
                self.assertTrue(probe_started.wait(1))

                stop_thread = threading.Thread(target=stop_runtime)
                stop_thread.start()
                stopped_without_probe = stop_done.wait(1)
                release_probe.set()
                status_thread.join(1)
                stop_thread.join(1)

            self.assertTrue(
                stopped_without_probe,
                "stop must not wait for in-flight health network I/O",
            )
            self.assertFalse(status_thread.is_alive())
            self.assertFalse(stop_thread.is_alive())
            self.assertEqual(len(results), 1)
            self.assertFalse(results[0].available)
            self.assertNotEqual(results[0].state, "running")

    def test_external_searxng_status_reflects_endpoint_health(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            config = replace(
                make_config(tmp),
                manage_searxng=False,
                searxng_api_url="http://127.0.0.1:14567",
            )
            manager = PlatformRuntimeManager(config, _no_secret)
            with mock.patch.object(
                manager,
                "_probe_searxng_health",
                return_value=True,
            ):
                healthy = manager.prepare_searxng()
                ensured = manager.ensure_searxng_ready(wait=True)
            self.assertFalse(healthy.managed)
            self.assertTrue(healthy.available)
            self.assertEqual(healthy.state, "running")
            self.assertTrue(ensured.available)

            with mock.patch.object(
                manager,
                "_probe_searxng_health",
                return_value=False,
            ):
                unavailable = manager.searxng_status(refresh=True)
            self.assertFalse(unavailable.available)
            self.assertEqual(unavailable.state, "external")
            self.assertIn("not reachable", unavailable.error)

    def test_healthy_untracked_stack_is_reconciled_and_owned(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            compose_process = ExitedProcess(returncode=None)
            launcher = mock.MagicMock()
            launcher.start.return_value = compose_process
            runner = RecordingCommandRunner()
            manager = self._manager(tmp, launcher=launcher, runner=runner)
            with mock.patch.object(
                manager,
                "_probe_searxng_health",
                return_value=True,
            ):
                first = manager.ensure_searxng_ready(wait=False)
                self.assertFalse(first.available)
                self.assertEqual(first.state, "starting")
                self.assertEqual(launcher.start.call_count, 1)
                self.assertIsNotNone(manager._searxng_compose_teardown)

                compose_process._returncode = 0
                second = manager.ensure_searxng_ready(wait=False)
                self.assertTrue(second.available)
                self.assertEqual(
                    launcher.start.call_count,
                    1,
                    "Compose-confirmed healthy stack must use the fast path",
                )

            manager.stop_searxng()
            self.assertTrue(
                any("down" in call["cmd"] for call in runner.calls),
                "reconciled stack must gain teardown ownership",
            )

    def test_healthy_untracked_stack_reports_compose_launch_failure(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            launcher = mock.MagicMock()
            launcher.start.side_effect = OSError("simulated compose launch failure")
            runner = RecordingCommandRunner()
            manager = self._manager(tmp, launcher=launcher, runner=runner)

            with mock.patch.object(
                manager,
                "_probe_searxng_health",
                return_value=True,
            ):
                status = manager.ensure_searxng_ready(wait=False)

            self.assertFalse(status.available)
            self.assertEqual(status.state, "error")
            self.assertIn("simulated compose launch failure", status.error)
            self.assertIsNone(manager._searxng_process)
            self.assertIsNotNone(
                manager._searxng_compose_teardown,
                "deterministic project teardown must remain available",
            )
            manager.stop_searxng()

    def test_healthy_untracked_stack_reports_immediate_compose_exit(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            launcher = mock.MagicMock()
            launcher.start.return_value = ExitedProcess(returncode=41)
            manager = self._manager(
                tmp,
                launcher=launcher,
                runner=RecordingCommandRunner(),
            )

            with mock.patch.object(
                manager,
                "_probe_searxng_health",
                return_value=True,
            ):
                status = manager.ensure_searxng_ready(wait=False)

            self.assertFalse(status.available)
            self.assertEqual(status.state, "error")
            self.assertIn("exited with code 41", status.error)
            self.assertIsNotNone(manager._searxng_compose_teardown)
            manager.stop_searxng()

    def test_failed_compose_down_retains_retryable_ownership(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            launcher = RecordingLauncher()
            runner = mock.MagicMock()
            runner.run.side_effect = lambda cmd, **_kwargs: mock.Mock(
                returncode=0 if "--help" in cmd else 23
            )
            manager = self._manager(tmp, launcher=launcher, runner=runner)
            with mock.patch.object(
                manager,
                "_probe_searxng_health",
                return_value=False,
            ):
                manager.ensure_searxng_ready(wait=False)

            failed_restart = manager.restart_searxng()

            self.assertFalse(failed_restart.available)
            self.assertEqual(failed_restart.state, "error")
            self.assertIn("exit code 23", failed_restart.error)
            self.assertIsNotNone(manager._searxng_compose_teardown)
            self.assertEqual(
                len(launcher.calls),
                1,
                "restart must not launch a second stack after down failed",
            )

            runner.run.side_effect = TimeoutError("simulated compose down timeout")
            timed_out = manager.stop_searxng()
            self.assertFalse(timed_out.available)
            self.assertEqual(timed_out.state, "error")
            self.assertIn("simulated compose down timeout", timed_out.error)
            self.assertIsNotNone(manager._searxng_compose_teardown)

            runner.run.side_effect = None
            runner.run.return_value = mock.Mock(returncode=0)
            recovered = manager.stop_searxng()
            self.assertIsNone(manager._searxng_compose_teardown)
            self.assertEqual(recovered.state, "prepared")


class FirecrawlComposeTeardownTests(unittest.TestCase):
    def test_healthy_existing_stack_is_reconciled_before_health_is_trusted(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_fake_firecrawl_repo(tmp / "firecrawl")
            launcher = RecordingLauncher()
            _, manager = _make_manager(tmp, wait=0, launcher=launcher)
            try:
                with mock.patch.object(
                    manager,
                    "_probe_firecrawl_health",
                    return_value=True,
                ):
                    reconciling = manager.ensure_firecrawl_ready(wait=False)
                    self.assertEqual(reconciling.state, "starting")
                    self.assertFalse(reconciling.available)
                    self.assertEqual(len(launcher.calls), 1)
                    up_command = launcher.calls[0]["cmd"]
                    self.assertIn("--project-name", up_command)
                    self.assertEqual(
                        up_command[up_command.index("--project-name") + 1],
                        "firecrawl",
                    )
                    self.assertIn("--detach", up_command)
                    self.assertIn("--wait", up_command)
                    self.assertIsNotNone(manager._firecrawl_compose_teardown)

                    launcher.processes[0].running = False
                    owned = manager.firecrawl_status(refresh=True)
                self.assertTrue(owned.available)
                self.assertEqual(owned.state, "running")
                self.assertTrue(manager._firecrawl_launch_confirmed)
            finally:
                manager.close()

    def test_stop_runs_compose_down_for_managed_stack(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_fake_firecrawl_repo(tmp / "firecrawl")
            launcher = RecordingLauncher()
            runner = RecordingCommandRunner()
            os.environ["ENTERPRISE_FIRECRAWL_STARTUP_WAIT_SECONDS"] = "0"
            manager = None
            try:
                _, manager = _make_manager(tmp, wait=0, launcher=launcher, runner=runner)
                with mock.patch.dict(
                    os.environ,
                    {
                        "SEARXNG_ENDPOINT": "http://stale-search:8080",
                        "SEARXNG_PORT": "0.0.0.0:13003",
                    },
                ):
                    manager.ensure_firecrawl_ready(wait=False)
                up_calls = [c for c in launcher.calls if c["cmd"][:2] == ["docker", "compose"] and "up" in c["cmd"]]
                self.assertTrue(up_calls, "expected a managed docker compose up launch")
                self.assertNotIn("SEARXNG_ENDPOINT", up_calls[-1]["env"])
                self.assertNotIn("SEARXNG_PORT", up_calls[-1]["env"])
                self.assertIsNotNone(manager._firecrawl_compose_teardown)

                manager.stop_firecrawl()
                down_calls = [
                    c for c in runner.calls
                    if c["cmd"][:2] == ["docker", "compose"] and "down" in c["cmd"]
                ]
                self.assertTrue(down_calls, "stop_firecrawl must run docker compose down")
                down_cmd = down_calls[-1]["cmd"]
                self.assertIn("--remove-orphans", down_cmd)
                self.assertIn("--env-file", down_cmd)
                self.assertIsNone(manager._firecrawl_compose_teardown)
            finally:
                os.environ.pop("ENTERPRISE_FIRECRAWL_STARTUP_WAIT_SECONDS", None)
                if manager is not None:
                    manager.close()

    def test_failed_firecrawl_teardown_keeps_ownership_for_retry(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_fake_firecrawl_repo(tmp / "firecrawl")
            launcher = RecordingLauncher()
            runner = RecordingCommandRunner()
            _, manager = _make_manager(
                tmp,
                wait=0,
                launcher=launcher,
                runner=runner,
            )
            manager.ensure_firecrawl_ready(wait=False)
            runner.run = mock.Mock(side_effect=TimeoutError("simulated down timeout"))

            failed = manager.stop_firecrawl()
            self.assertEqual(failed.state, "error")
            self.assertIn("simulated down timeout", failed.error)
            self.assertIsNotNone(manager._firecrawl_compose_teardown)

            runner.run = mock.Mock(return_value=mock.Mock(returncode=0))
            recovered = manager.stop_firecrawl()
            self.assertEqual(recovered.state, "prepared")
            self.assertIsNone(manager._firecrawl_compose_teardown)

    def test_user_command_firecrawl_is_not_compose_torn_down(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_fake_firecrawl_repo(tmp / "firecrawl")
            config = replace(
                make_config(tmp),
                runtime_startup_wait_seconds=0,
                firecrawl_command="my-firecrawl serve",
            )
            launcher = RecordingLauncher()
            runner = RecordingCommandRunner()
            manager = PlatformRuntimeManager(
                config,
                _no_secret,
                process_launcher=launcher,
                command_runner=runner,
            )
            try:
                with mock.patch.dict(
                    os.environ,
                    {
                        "SEARXNG_ENDPOINT": "http://custom-search:8080",
                        "SEARXNG_PORT": "custom-port-value",
                    },
                ):
                    manager.ensure_firecrawl_ready(wait=False)
                self.assertIsNone(manager._firecrawl_compose_teardown)
                launch_env = launcher.calls[-1]["env"]
                self.assertEqual(
                    launch_env["SEARXNG_ENDPOINT"],
                    "http://custom-search:8080",
                )
                self.assertEqual(
                    launch_env["SEARXNG_PORT"],
                    "custom-port-value",
                )
                manager.stop_firecrawl()
                down_calls = [
                    c for c in runner.calls
                    if c["cmd"][:2] == ["docker", "compose"] and "down" in c["cmd"]
                ]
                self.assertEqual(down_calls, [])
            finally:
                manager.close()


if __name__ == "__main__":
    unittest.main()
