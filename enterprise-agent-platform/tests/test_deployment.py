from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest import mock

from enterprise_agent_platform.deployment import (
    DeploymentError,
    DeploymentManager,
    DeploymentPaths,
    python_venv_package_names,
    runtime_env,
    user_service_unit,
)


class RecordingDeployRunner:
    def __init__(self, *, systemd_available: bool = False):
        self.calls = []
        self.systemd_available = systemd_available

    def run(self, cmd, *, cwd=None, env=None, timeout=None, check=True):
        self.calls.append({"cmd": cmd, "cwd": cwd, "env": env, "timeout": timeout, "check": check})
        if cmd[:3] == ["systemctl", "--user", "show-environment"]:
            return subprocess.CompletedProcess(cmd, 0 if self.systemd_available else 1)
        if cmd[:3] == [sys.executable, "-m", "venv"]:
            bin_dir = Path(cmd[3]) / ("Scripts" if os.name == "nt" else "bin")
            bin_dir.mkdir(parents=True, exist_ok=True)
            (bin_dir / "python").write_text("#!/usr/bin/env python3\n", encoding="utf-8")
        return subprocess.CompletedProcess(cmd, 0)


class MissingEnsurepipRunner(RecordingDeployRunner):
    def run(self, cmd, *, cwd=None, env=None, timeout=None, check=True):
        if cmd == [sys.executable, "-c", "import ensurepip"]:
            self.calls.append({"cmd": cmd, "cwd": cwd, "env": env, "timeout": timeout, "check": check})
            return subprocess.CompletedProcess(cmd, 1)
        return super().run(cmd, cwd=cwd, env=env, timeout=timeout, check=check)


class AutoInstallEnsurepipRunner(RecordingDeployRunner):
    def __init__(self):
        super().__init__()
        self.ensurepip_available = False

    def run(self, cmd, *, cwd=None, env=None, timeout=None, check=True):
        if cmd == [sys.executable, "-c", "import ensurepip"]:
            self.calls.append({"cmd": cmd, "cwd": cwd, "env": env, "timeout": timeout, "check": check})
            return subprocess.CompletedProcess(cmd, 0 if self.ensurepip_available else 1)
        if len(cmd) >= 4 and Path(cmd[-4]).name == "apt-get" and cmd[-3:-1] == ["install", "-y"]:
            self.ensurepip_available = True
        return super().run(cmd, cwd=cwd, env=env, timeout=timeout, check=check)


class BrokenExistingVenvRunner(RecordingDeployRunner):
    def __init__(self):
        super().__init__()
        self.pip_checks = 0

    def run(self, cmd, *, cwd=None, env=None, timeout=None, check=True):
        if len(cmd) >= 4 and cmd[-3:] == ["-m", "pip", "--version"]:
            self.calls.append({"cmd": cmd, "cwd": cwd, "env": env, "timeout": timeout, "check": check})
            self.pip_checks += 1
            return subprocess.CompletedProcess(cmd, 1 if self.pip_checks == 1 else 0)
        return super().run(cmd, cwd=cwd, env=env, timeout=timeout, check=check)


class TransientPipFailureRunner(RecordingDeployRunner):
    def __init__(self):
        super().__init__()
        self.platform_install_attempts = 0

    def run(self, cmd, *, cwd=None, env=None, timeout=None, check=True):
        if "-e" in cmd:
            self.calls.append({"cmd": cmd, "cwd": cwd, "env": env, "timeout": timeout, "check": check})
            self.platform_install_attempts += 1
            return subprocess.CompletedProcess(cmd, 1 if self.platform_install_attempts == 1 else 0)
        return super().run(cmd, cwd=cwd, env=env, timeout=timeout, check=check)


def make_deploy_root(root: Path) -> None:
    (root / ".git").mkdir()
    (root / "enterprise-agent-platform" / "enterprise_agent_platform").mkdir(parents=True)
    (root / "enterprise-agent-platform" / "pyproject.toml").write_text("[project]\nname='platform'\n", encoding="utf-8")
    (root / "hermes-agent").mkdir()
    (root / "hermes-agent" / "pyproject.toml").write_text("[project]\nname='hermes'\n", encoding="utf-8")
    (root / "cognee").mkdir()
    (root / "cognee" / "pyproject.toml").write_text("[project]\nname='cognee'\n", encoding="utf-8")


class DeploymentTests(unittest.TestCase):
    def test_bootstrap_prepare_initializes_submodules_and_platform_venv(self):
        if not shutil.which("git"):
            self.skipTest("git is not available")
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            make_deploy_root(root)
            runner = RecordingDeployRunner()
            paths = DeploymentPaths.from_root(root)
            manager = DeploymentManager(paths, runner=runner)

            result = manager.bootstrap(host="127.0.0.1", port=8765, mode="prepare", prepare_runtime=False)

            commands = [call["cmd"] for call in runner.calls]
            self.assertEqual(result.mode, "prepare")
            self.assertEqual(commands[0], ["git", "submodule", "update", "--init", "--recursive"])
            self.assertIn([sys.executable, "-c", "import ensurepip"], commands)
            self.assertIn([sys.executable, "-m", "venv", str(root / ".venv")], commands)
            self.assertIn([str(paths.venv_python), "-m", "pip", "--version"], commands)
            self.assertIn(
                [
                    str(paths.venv_python),
                    "-m",
                    "pip",
                    "install",
                    "--retries",
                    "8",
                    "--timeout",
                    "120",
                    "--upgrade",
                    "pip",
                    "setuptools",
                    "wheel",
                ],
                commands,
            )
            self.assertIn(
                [
                    str(paths.venv_python),
                    "-m",
                    "pip",
                    "install",
                    "--retries",
                    "8",
                    "--timeout",
                    "120",
                    "--no-build-isolation",
                    "-e",
                    str(root / "enterprise-agent-platform"),
                ],
                commands,
            )

    def test_platform_pip_install_retries_transient_failure(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            make_deploy_root(root)
            runner = TransientPipFailureRunner()
            paths = DeploymentPaths.from_root(root)
            manager = DeploymentManager(paths, runner=runner)

            with mock.patch.dict(os.environ, {"ENTERPRISE_PIP_INSTALL_ATTEMPTS": "2"}):
                result = manager.bootstrap(host="127.0.0.1", port=8765, mode="prepare", prepare_runtime=False)

            install_calls = [call for call in runner.calls if "-e" in call["cmd"]]
            self.assertEqual(result.mode, "prepare")
            self.assertEqual(runner.platform_install_attempts, 2)
            self.assertEqual(len(install_calls), 2)
            self.assertEqual(install_calls[0]["check"], False)
            self.assertEqual(install_calls[0]["env"]["PIP_DISABLE_PIP_VERSION_CHECK"], "1")

    def test_missing_ensurepip_auto_installs_debian_venv_package(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            make_deploy_root(root)
            runner = AutoInstallEnsurepipRunner()
            paths = DeploymentPaths.from_root(root)
            manager = DeploymentManager(paths, runner=runner)

            def fake_which(name):
                if name in {"apt-get", "git", "sudo"}:
                    return f"/usr/bin/{name}"
                return None

            with mock.patch("enterprise_agent_platform.deployment.shutil.which", side_effect=fake_which):
                with mock.patch("enterprise_agent_platform.deployment.os.geteuid", return_value=1000):
                    result = manager.bootstrap(host="127.0.0.1", port=8765, mode="prepare", prepare_runtime=False)

            commands = [call["cmd"] for call in runner.calls]
            self.assertEqual(result.mode, "prepare")
            self.assertIn(["/usr/bin/sudo", "/usr/bin/apt-get", "update"], commands)
            self.assertIn(
                ["/usr/bin/sudo", "/usr/bin/apt-get", "install", "-y", python_venv_package_names()[0]],
                commands,
            )
            self.assertIn([sys.executable, "-m", "venv", str(root / ".venv")], commands)

    def test_incomplete_platform_venv_is_recreated(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            make_deploy_root(root)
            paths = DeploymentPaths.from_root(root)
            paths.venv_python.parent.mkdir(parents=True)
            paths.venv_python.write_text("#!/usr/bin/env python3\n", encoding="utf-8")
            marker = paths.venv_dir / "partial-marker"
            marker.write_text("old", encoding="utf-8")
            runner = BrokenExistingVenvRunner()
            manager = DeploymentManager(paths, runner=runner)

            result = manager.bootstrap(host="127.0.0.1", port=8765, mode="prepare", prepare_runtime=False)

            commands = [call["cmd"] for call in runner.calls]
            self.assertEqual(result.mode, "prepare")
            self.assertEqual(runner.pip_checks, 2)
            self.assertIn([sys.executable, "-m", "venv", str(root / ".venv")], commands)
            self.assertFalse(marker.exists())

    def test_missing_ensurepip_reports_debian_venv_package_hint(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            make_deploy_root(root)
            runner = MissingEnsurepipRunner()
            paths = DeploymentPaths.from_root(root)
            manager = DeploymentManager(paths, runner=runner)

            with mock.patch.dict(os.environ, {"ENTERPRISE_DEPLOY_AUTO_APT": "0"}):
                with self.assertRaises(DeploymentError) as ctx:
                    manager.bootstrap(host="127.0.0.1", port=8765, mode="prepare", prepare_runtime=False)

            message = str(ctx.exception)
            self.assertIn("Python venv support is not available", message)
            self.assertIn("sudo apt update && sudo apt install -y", message)
            self.assertIn("python3-venv", message)
            self.assertIn(f"rm -rf {paths.venv_dir}", message)

    def test_user_service_unit_pins_managed_paths_and_restart_policy(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            paths = DeploymentPaths.from_root(root, data_dir=root / "state")

            unit = user_service_unit(paths, host="0.0.0.0", port=8765)

            self.assertIn("Restart=on-failure", unit)
            self.assertIn(f"ENTERPRISE_PLATFORM_DATA={root / 'state'}", unit)
            self.assertIn(f"ENTERPRISE_HERMES_REPO={root / 'hermes-agent'}", unit)
            self.assertIn(f"ENTERPRISE_COGNEE_REPO={root / 'cognee'}", unit)
            self.assertIn(str(paths.platform_cli), unit)
            self.assertIn(f"WorkingDirectory={root / 'enterprise-agent-platform'}", unit)
            self.assertNotIn(f"WorkingDirectory=\"{root / 'enterprise-agent-platform'}\"", unit)
            self.assertIn("--host \"0.0.0.0\" --port 8765", unit)

    def test_user_service_unit_passes_systemd_verify_when_available(self):
        if not shutil.which("systemd-analyze"):
            self.skipTest("systemd-analyze is not available")
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            paths = DeploymentPaths.from_root(root)
            paths.platform_dir.mkdir(parents=True)
            paths.platform_cli.parent.mkdir(parents=True)
            paths.platform_cli.write_text("#!/bin/sh\n", encoding="utf-8")
            paths.platform_cli.chmod(0o755)
            unit_path = root / "enterprise-agent-platform.service"
            unit_path.write_text(user_service_unit(paths, host="127.0.0.1", port=8765), encoding="utf-8")

            result = subprocess.run(
                ["systemd-analyze", "verify", "--user", str(unit_path)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)

    def test_runtime_env_exposes_adjacent_sources(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            paths = DeploymentPaths.from_root(root)

            env = runtime_env(paths, host="127.0.0.1", port=9999)

            self.assertEqual(env["ENTERPRISE_HERMES_REPO"], str(root / "hermes-agent"))
            self.assertEqual(env["ENTERPRISE_COGNEE_REPO"], str(root / "cognee"))
            self.assertEqual(env["ENTERPRISE_FIRECRAWL_REPO"], str(root / "firecrawl"))
            self.assertEqual(env["ENTERPRISE_PLATFORM_PORT"], "9999")

    def test_deploy_script_exposes_one_command_entrypoint(self):
        script = Path(__file__).resolve().parents[2] / "deploy.sh"
        self.assertTrue(script.exists())
        self.assertTrue(os.access(script, os.X_OK))
        result = subprocess.run(["bash", str(script), "help"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False)
        self.assertEqual(result.returncode, 0)
        self.assertIn("./deploy.sh", result.stdout)
        self.assertIn("update", result.stdout)
        self.assertIn("foreground", result.stdout)
        syntax = subprocess.run(["bash", "-n", str(script)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False)
        self.assertEqual(syntax.returncode, 0, syntax.stderr)

    def test_platform_pyproject_supports_editable_install(self):
        pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
        data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
        package_data = data["tool"]["setuptools"]["package-data"]
        self.assertIn("hermes_plugin.enterprise_kb", package_data)
        self.assertEqual(package_data["hermes_plugin.enterprise_kb"], ["plugin.yaml"])


if __name__ == "__main__":
    unittest.main()
