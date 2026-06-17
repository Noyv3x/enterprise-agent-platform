import os
import shutil
import subprocess
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from test_platform import (
    make_config,
    make_fake_firecrawl_repo,
    RecordingLauncher,
    RecordingCommandRunner,
)

from enterprise_agent_platform.runtimes import PlatformRuntimeManager


class ExitedProcess:
    """ProcessLike fake whose poll() reports a non-zero exit code."""

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
        # REGRESSION GUARD: with runtime_startup_wait_seconds=0 and no env
        # override, the heavy 300s/120s cold-start floor must NOT be forced on,
        # so async startup / the test suite never blocks on a long deadline.
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            for key in ("ENTERPRISE_FIRECRAWL_STARTUP_WAIT_SECONDS", "ENTERPRISE_CAMOFOX_STARTUP_WAIT_SECONDS"):
                os.environ.pop(key, None)
            _, manager = _make_manager(tmp, wait=0)
            self.assertEqual(manager._runtime_startup_wait_seconds("firecrawl"), 0.0)
            self.assertEqual(manager._runtime_startup_wait_seconds("camofox"), 0.0)

    def test_positive_config_wait_applies_heavy_floor(self):
        # When a startup wait is actually requested, the heavier cold-start
        # floor (Firecrawl 300s, Camofox 120s) is applied as a minimum.
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            for key in ("ENTERPRISE_FIRECRAWL_STARTUP_WAIT_SECONDS", "ENTERPRISE_CAMOFOX_STARTUP_WAIT_SECONDS"):
                os.environ.pop(key, None)
            _, manager = _make_manager(tmp, wait=5)
            self.assertEqual(manager._runtime_startup_wait_seconds("firecrawl"), 300.0)
            self.assertEqual(manager._runtime_startup_wait_seconds("camofox"), 120.0)
            # A wait larger than the floor wins over the default.
            _, manager_big = _make_manager(tmp, wait=500)
            self.assertEqual(manager_big._runtime_startup_wait_seconds("firecrawl"), 500.0)
            self.assertEqual(manager_big._runtime_startup_wait_seconds("camofox"), 500.0)

    def test_env_override_takes_precedence_over_floor(self):
        # The per-runtime env override wins even when a positive config wait
        # would otherwise apply the heavy floor.
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            os.environ["ENTERPRISE_FIRECRAWL_STARTUP_WAIT_SECONDS"] = "0"
            try:
                _, manager = _make_manager(tmp, wait=5)
                self.assertEqual(manager._runtime_startup_wait_seconds("firecrawl"), 0.0)
                # camofox env not set -> heavy floor still applies for camofox.
                os.environ.pop("ENTERPRISE_CAMOFOX_STARTUP_WAIT_SECONDS", None)
                self.assertEqual(manager._runtime_startup_wait_seconds("camofox"), 120.0)
            finally:
                os.environ.pop("ENTERPRISE_FIRECRAWL_STARTUP_WAIT_SECONDS", None)


class HermesProcessEnvTests(unittest.TestCase):
    def test_process_env_points_tmpdir_at_managed_scratch(self):
        # Managed Hermes must write generated MEDIA: attachments into a trusted
        # media root, so TMPDIR/TEMP/TMP are redirected to <home>/tmp and that
        # directory is created.
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            _, manager = _make_manager(tmp, wait=0)
            scratch = manager.config.managed_hermes_home / "tmp"
            self.assertFalse(scratch.exists())
            env = manager._hermes_process_env()
            self.assertEqual(env["TMPDIR"], str(scratch))
            self.assertEqual(env["TEMP"], str(scratch))
            self.assertEqual(env["TMP"], str(scratch))
            self.assertTrue(scratch.is_dir())
            # The managed HERMES_HOME is still threaded through.
            self.assertEqual(env["HERMES_HOME"], str(manager.config.managed_hermes_home))


class HermesRuntimePatchCompatibilityTests(unittest.TestCase):
    def test_managed_hermes_patch_applies_to_pinned_submodule(self):
        if shutil.which("git") is None:
            self.skipTest("git is required to verify the Hermes runtime patch")

        platform_root = Path(__file__).resolve().parents[1]
        repo_root = platform_root.parent
        hermes_repo = repo_root / "hermes-agent"
        patch_path = platform_root / "enterprise_agent_platform" / "hermes_runtime_patch" / "hermes_agent_isolation.patch"

        if not (hermes_repo / "gateway" / "platforms" / "api_server.py").exists():
            self.skipTest("Hermes submodule is not initialized")
        self.assertTrue(patch_path.exists(), f"managed Hermes patch is missing: {patch_path}")

        before = subprocess.run(
            ["git", "status", "--short"],
            cwd=hermes_repo,
            text=True,
            capture_output=True,
            check=False,
        )
        result = subprocess.run(
            ["git", "apply", "--check", "--whitespace=nowarn", str(patch_path)],
            cwd=hermes_repo,
            text=True,
            capture_output=True,
            check=False,
        )
        after = subprocess.run(
            ["git", "status", "--short"],
            cwd=hermes_repo,
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertEqual(before.returncode, 0, before.stderr)
        self.assertEqual(after.returncode, 0, after.stderr)
        self.assertEqual(before.stdout, after.stdout)
        if result.returncode != 0:
            self.fail(
                "Managed Hermes runtime patch no longer applies to the pinned hermes-agent submodule.\n"
                f"stdout:\n{result.stdout}\n"
                f"stderr:\n{result.stderr}"
            )


class FirecrawlEnvLocationTests(unittest.TestCase):
    def test_managed_env_written_under_runtime_dir_not_submodule(self):
        # The generated Firecrawl .env (carrying a BULL_AUTH_KEY secret) must
        # live under config.firecrawl_runtime_dir, NOT inside the firecrawl
        # submodule working tree.
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            repo = tmp / "firecrawl"
            make_fake_firecrawl_repo(repo)
            config, manager = _make_manager(tmp, wait=0)
            env_path = manager._ensure_firecrawl_env()
            self.assertEqual(env_path, config.firecrawl_runtime_dir / ".env")
            self.assertTrue(env_path.exists())
            # The secret-bearing env must not be planted in the submodule tree.
            self.assertFalse((repo / ".env").exists())
            text = env_path.read_text(encoding="utf-8")
            self.assertIn("BULL_AUTH_KEY=", text)
            self.assertIn('PORT="13002"', text)
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
    def test_firecrawl_nonzero_exit_surfaces_error_not_running(self):
        # A managed Firecrawl process that has exited non-zero must be reported
        # as not-available with an error state, never as running/starting.
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_fake_firecrawl_repo(tmp / "firecrawl")
            _, manager = _make_manager(tmp, wait=0)
            manager._firecrawl_process = ExitedProcess(returncode=9)
            status = manager.firecrawl_status(refresh=False)
            self.assertFalse(status.available)
            self.assertEqual(status.state, "error")
            self.assertIn("exited with code 9", status.error)
            self.assertNotEqual(status.state, "running")
            self.assertNotEqual(status.state, "starting")

    def test_camofox_nonzero_exit_surfaces_error_not_running(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            _, manager = _make_manager(tmp, wait=0)
            manager._camofox_process = ExitedProcess(returncode=3)
            status = manager.camofox_status(refresh=False)
            self.assertFalse(status.available)
            self.assertEqual(status.state, "error")
            self.assertIn("exited with code 3", status.error)
            self.assertNotEqual(status.state, "running")
            self.assertNotEqual(status.state, "starting")


class FirecrawlComposeTeardownTests(unittest.TestCase):
    def test_stop_runs_compose_down_for_managed_stack(self):
        # Stopping a managed Firecrawl compose stack must run
        # `docker compose ... down --remove-orphans` (mirroring the up argv)
        # rather than orphaning the daemon-owned containers.
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_fake_firecrawl_repo(tmp / "firecrawl")
            launcher = RecordingLauncher()
            runner = RecordingCommandRunner()
            os.environ["ENTERPRISE_FIRECRAWL_STARTUP_WAIT_SECONDS"] = "0"
            try:
                _, manager = _make_manager(tmp, wait=0, launcher=launcher, runner=runner)
                manager.ensure_firecrawl_ready(wait=False)
                up_calls = [c for c in launcher.calls if c["cmd"][:2] == ["docker", "compose"] and "up" in c["cmd"]]
                self.assertTrue(up_calls, "expected a managed docker compose up launch")
                # Sanity: teardown command recorded for the managed stack.
                self.assertIsNotNone(manager._firecrawl_compose_teardown)

                manager.stop_firecrawl()
                down_calls = [
                    c for c in runner.calls
                    if c["cmd"][:2] == ["docker", "compose"] and "down" in c["cmd"]
                ]
                self.assertTrue(down_calls, "stop_firecrawl must run docker compose down")
                down_cmd = down_calls[-1]["cmd"]
                self.assertIn("--remove-orphans", down_cmd)
                # The down argv preserves the --env-file from the up argv.
                self.assertIn("--env-file", down_cmd)
                # Teardown state cleared after stop so a second stop is a no-op.
                self.assertIsNone(manager._firecrawl_compose_teardown)
            finally:
                os.environ.pop("ENTERPRISE_FIRECRAWL_STARTUP_WAIT_SECONDS", None)
                manager.close()

    def test_user_command_firecrawl_is_not_compose_torn_down(self):
        # A user-configured Firecrawl command is left to the operator: no
        # compose teardown command should be recorded.
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
