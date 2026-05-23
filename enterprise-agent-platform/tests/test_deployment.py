from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path

from enterprise_agent_platform.deployment import DeploymentManager, DeploymentPaths, runtime_env, user_service_unit


class RecordingDeployRunner:
    def __init__(self, *, systemd_available: bool = False):
        self.calls = []
        self.systemd_available = systemd_available

    def run(self, cmd, *, cwd=None, env=None, timeout=None, check=True):
        self.calls.append({"cmd": cmd, "cwd": cwd, "env": env, "timeout": timeout, "check": check})
        if cmd[:3] == ["systemctl", "--user", "show-environment"]:
            return subprocess.CompletedProcess(cmd, 0 if self.systemd_available else 1)
        return subprocess.CompletedProcess(cmd, 0)


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
            self.assertIn([sys.executable, "-m", "venv", str(root / ".venv")], commands)
            self.assertIn([str(paths.venv_python), "-m", "pip", "install", "--upgrade", "pip"], commands)
            self.assertIn([str(paths.venv_python), "-m", "pip", "install", "-e", str(root / "enterprise-agent-platform")], commands)

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
            self.assertIn("--host \"0.0.0.0\" --port 8765", unit)

    def test_runtime_env_exposes_adjacent_sources(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            paths = DeploymentPaths.from_root(root)

            env = runtime_env(paths, host="127.0.0.1", port=9999)

            self.assertEqual(env["ENTERPRISE_HERMES_REPO"], str(root / "hermes-agent"))
            self.assertEqual(env["ENTERPRISE_COGNEE_REPO"], str(root / "cognee"))
            self.assertEqual(env["ENTERPRISE_PLATFORM_PORT"], "9999")

    def test_deploy_script_exposes_one_command_entrypoint(self):
        script = Path(__file__).resolve().parents[2] / "deploy.sh"
        self.assertTrue(script.exists())
        self.assertTrue(os.access(script, os.X_OK))
        result = subprocess.run(["bash", str(script), "help"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False)
        self.assertEqual(result.returncode, 0)
        self.assertIn("./deploy.sh", result.stdout)
        self.assertIn("foreground", result.stdout)

    def test_platform_pyproject_supports_editable_install(self):
        pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
        data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
        package_data = data["tool"]["setuptools"]["package-data"]
        self.assertIn("hermes_plugin.enterprise_kb", package_data)
        self.assertEqual(package_data["hermes_plugin.enterprise_kb"], ["plugin.yaml"])


if __name__ == "__main__":
    unittest.main()
