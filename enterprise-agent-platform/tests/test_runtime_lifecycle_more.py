from __future__ import annotations

import os
import tempfile
import threading
import time
import unittest
from dataclasses import replace
from pathlib import Path

from enterprise_agent_platform.runtimes import PlatformRuntimeManager, RuntimeStatus

from test_platform import (
    RecordingCommandRunner,
    RecordingLauncher,
    make_config,
    make_fake_firecrawl_repo,
)


class ExitedProcess:
    """Process fake whose ``poll`` reports a non-zero exit code."""

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
            for key in ("ENTERPRISE_FIRECRAWL_STARTUP_WAIT_SECONDS", "ENTERPRISE_CAMOFOX_STARTUP_WAIT_SECONDS"):
                os.environ.pop(key, None)
            _, manager = _make_manager(tmp, wait=0)
            self.assertEqual(manager._runtime_startup_wait_seconds("firecrawl"), 0.0)
            self.assertEqual(manager._runtime_startup_wait_seconds("camofox"), 0.0)

    def test_positive_config_wait_applies_heavy_floor(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            for key in ("ENTERPRISE_FIRECRAWL_STARTUP_WAIT_SECONDS", "ENTERPRISE_CAMOFOX_STARTUP_WAIT_SECONDS"):
                os.environ.pop(key, None)
            _, manager = _make_manager(tmp, wait=5)
            self.assertEqual(manager._runtime_startup_wait_seconds("firecrawl"), 300.0)
            self.assertEqual(manager._runtime_startup_wait_seconds("camofox"), 120.0)
            _, manager_big = _make_manager(tmp, wait=500)
            self.assertEqual(manager_big._runtime_startup_wait_seconds("firecrawl"), 500.0)
            self.assertEqual(manager_big._runtime_startup_wait_seconds("camofox"), 500.0)

    def test_env_override_takes_precedence_over_floor(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            os.environ["ENTERPRISE_FIRECRAWL_STARTUP_WAIT_SECONDS"] = "0"
            try:
                _, manager = _make_manager(tmp, wait=5)
                self.assertEqual(manager._runtime_startup_wait_seconds("firecrawl"), 0.0)
                os.environ.pop("ENTERPRISE_CAMOFOX_STARTUP_WAIT_SECONDS", None)
                self.assertEqual(manager._runtime_startup_wait_seconds("camofox"), 120.0)
            finally:
                os.environ.pop("ENTERPRISE_FIRECRAWL_STARTUP_WAIT_SECONDS", None)


class AgentRuntimeProcessEnvTests(unittest.TestCase):
    def test_process_env_is_scoped_to_managed_runtime_and_never_contains_refresh_tokens(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            config, manager = _make_manager(tmp)
            env = manager._agent_runtime_process_env()

            self.assertEqual(env["AGENT_RUNTIME_HOME"], str(config.managed_agent_runtime_home))
            self.assertEqual(env["AGENT_RUNTIME_HOST"], "127.0.0.1")
            self.assertEqual(env["AGENT_RUNTIME_PORT"], "8766")
            self.assertEqual(env["AGENT_RUNTIME_RUN_TIMEOUT_MS"], "2000")
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
            env_path = manager._ensure_firecrawl_env()
            self.assertEqual(env_path, config.firecrawl_runtime_dir / ".env")
            self.assertTrue(env_path.exists())
            self.assertFalse((repo / ".env").exists())
            text = env_path.read_text(encoding="utf-8")
            self.assertIn("BULL_AUTH_KEY=", text)
            self.assertIn('PORT="127.0.0.1:13002"', text)
            self.assertIn('USE_DB_AUTHENTICATION="false"', text)

    def test_prepare_firecrawl_materializes_env_in_runtime_dir(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            repo = tmp / "firecrawl"
            make_fake_firecrawl_repo(repo)
            config, manager = _make_manager(tmp, wait=0)
            status = manager.prepare_firecrawl()
            self.assertTrue(status.available)
            self.assertTrue((config.firecrawl_runtime_dir / ".env").exists())
            self.assertFalse((repo / ".env").exists())


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
                    for name in ("agent", "cognee", "camofox", "firecrawl")
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
                    for name in ("agent", "cognee", "camofox", "firecrawl")
                }

            manager.status = fake_status
            for _ in range(10):
                manager.cached_status(max_age_seconds=0)
            self.assertTrue(refresh_started.wait(1))
            self.assertEqual(refresh_calls, 1)
            release_refresh.set()
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
                    for name in ("agent", "cognee", "camofox", "firecrawl")
                }

            manager.status = fake_status
            with manager._status_cache_lock:
                manager._status_cache = {
                    name: {"name": name, "state": "cached"}
                    for name in ("agent", "cognee", "camofox", "firecrawl")
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
                    for name in ("agent", "cognee", "camofox", "firecrawl")
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


class FirecrawlComposeTeardownTests(unittest.TestCase):
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
                manager.ensure_firecrawl_ready(wait=False)
                up_calls = [c for c in launcher.calls if c["cmd"][:2] == ["docker", "compose"] and "up" in c["cmd"]]
                self.assertTrue(up_calls, "expected a managed docker compose up launch")
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
                manager.ensure_firecrawl_ready(wait=False)
                self.assertIsNone(manager._firecrawl_compose_teardown)
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
