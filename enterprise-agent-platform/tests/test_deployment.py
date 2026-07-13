from __future__ import annotations

import fcntl
import os
import shutil
import subprocess
import sys
import tempfile
import tomllib
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
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
    runtime = root / "enterprise-agent-platform" / "agent-runtime"
    runtime.mkdir()
    (runtime / "package.json").write_text(
        '{"name":"agent-runtime","private":true,"engines":{"node":">=22.19.0"}}\n',
        encoding="utf-8",
    )
    (runtime / "package-lock.json").write_text(
        '{"name":"agent-runtime","lockfileVersion":3,"packages":{}}\n',
        encoding="utf-8",
    )
    (root / "cognee").mkdir()
    (root / "cognee" / "pyproject.toml").write_text("[project]\nname='cognee'\n", encoding="utf-8")
    (root / "firecrawl").mkdir()
    (root / "firecrawl" / "docker-compose.yaml").write_text("services:\n  api:\n    image: firecrawl\n", encoding="utf-8")


class DeploymentTests(unittest.TestCase):
    def test_node_runtime_requires_node_and_npm_at_supported_version(self):
        with tempfile.TemporaryDirectory() as td:
            manager = DeploymentManager(DeploymentPaths.from_root(Path(td)), runner=RecordingDeployRunner())
            with mock.patch(
                "enterprise_agent_platform.deployment.shutil.which",
                side_effect=lambda name: None if name == "npm" else f"/tools/{name}",
            ):
                with self.assertRaisesRegex(DeploymentError, "Node.js 22.19"):
                    manager.ensure_node_version()

            with mock.patch(
                "enterprise_agent_platform.deployment.shutil.which",
                side_effect=lambda name: f"/tools/{name}",
            ), mock.patch(
                "enterprise_agent_platform.deployment._capture_command_stdout",
                return_value="v22.18.0",
            ):
                with self.assertRaisesRegex(DeploymentError, "found v22.18.0"):
                    manager.ensure_node_version()

            with mock.patch(
                "enterprise_agent_platform.deployment.shutil.which",
                side_effect=lambda name: f"/tools/{name}",
            ), mock.patch(
                "enterprise_agent_platform.deployment._capture_command_stdout",
                return_value="v22.19.0",
            ):
                manager.ensure_node_version()

    def test_bootstrap_prepare_initializes_submodules_and_platform_venv(self):
        if not shutil.which("git"):
            self.skipTest("git is not available")
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            make_deploy_root(root)
            runner = RecordingDeployRunner()
            paths = DeploymentPaths.from_root(root)
            manager = DeploymentManager(paths, runner=runner)
            manager.ensure_node_version = mock.Mock()

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
            manager.ensure_node_version = mock.Mock()

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
            manager.ensure_node_version = mock.Mock()

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
            manager.ensure_node_version = mock.Mock()

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
            manager.ensure_node_version = mock.Mock()

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
            self.assertIn(f"ENTERPRISE_AGENT_RUNTIME_HOME={root / 'state' / 'runtimes' / 'agent'}", unit)
            self.assertIn(f"ENTERPRISE_COGNEE_REPO={root / 'cognee'}", unit)
            self.assertNotIn("ENTERPRISE_HERMES_REPO", unit)
            self.assertIn(str(paths.platform_cli), unit)
            self.assertIn(f"WorkingDirectory={root / 'enterprise-agent-platform'}", unit)
            self.assertNotIn(f"WorkingDirectory=\"{root / 'enterprise-agent-platform'}\"", unit)
            self.assertIn("--host \"0.0.0.0\" --port 8765", unit)

    def test_service_bootstrap_restarts_existing_user_service(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            make_deploy_root(root)
            runner = RecordingDeployRunner(systemd_available=True)
            paths = replace(DeploymentPaths.from_root(root), service_dir=root / "systemd-user")
            manager = DeploymentManager(paths, runner=runner)
            manager.ensure_node_version = mock.Mock()
            manager.prepare_platform_runtime = mock.Mock(return_value={})

            result = manager.bootstrap(host="127.0.0.1", port=8765, mode="service", prepare_runtime=False)

            commands = [call["cmd"] for call in runner.calls]
            self.assertEqual(result.mode, "service")
            manager.prepare_platform_runtime.assert_called_once_with(host="127.0.0.1", port=8765)
            self.assertIn(["systemctl", "--user", "daemon-reload"], commands)
            self.assertIn(["systemctl", "--user", "enable", paths.service_name], commands)
            self.assertIn(["systemctl", "--user", "restart", paths.service_name], commands)
            self.assertNotIn(["systemctl", "--user", "enable", "--now", paths.service_name], commands)

    def test_service_switches_prepare_matching_agent_runtime_before_restart(self):
        with tempfile.TemporaryDirectory() as td:
            paths = DeploymentPaths.from_root(Path(td))
            for mode in ("service", "auto"):
                with self.subTest(mode=mode):
                    manager = DeploymentManager(paths, runner=RecordingDeployRunner())
                    manager.ensure_python_version = mock.Mock()
                    manager.ensure_node_version = mock.Mock()
                    manager.ensure_layout = mock.Mock()
                    manager.ensure_submodules = mock.Mock()
                    manager.ensure_source_repos = mock.Mock()
                    manager.ensure_platform_venv = mock.Mock()
                    manager.user_systemd_available = mock.Mock(return_value=True)
                    sequence = mock.Mock()
                    sequence.restart.return_value = paths.service_path
                    manager.prepare_platform_runtime = sequence.prepare
                    manager.install_user_service = sequence.restart

                    result = manager.bootstrap(
                        host="127.0.0.1",
                        port=8765,
                        mode=mode,
                        # Service-changing paths must not allow the signature
                        # check to be bypassed by this prepare-only test knob.
                        prepare_runtime=False,
                    )

                    self.assertEqual(result.mode, "service")
                    self.assertEqual(
                        sequence.mock_calls,
                        [
                            mock.call.prepare(host="127.0.0.1", port=8765),
                            mock.call.restart(host="127.0.0.1", port=8765),
                        ],
                    )

    def test_runtime_prepare_does_not_contend_with_the_live_service_instance_lock(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            make_deploy_root(root)
            paths = DeploymentPaths.from_root(root, data_dir=root / "state")
            paths.data_dir.mkdir(parents=True)
            lock_path = paths.data_dir / ".enterprise-platform.lock"
            descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            runtime = mock.Mock()
            runtime.agent_runtime_config.return_value = {"managed": True}
            runtime.agent_runtime_status.return_value = SimpleNamespace(
                available=False,
                error="",
                to_dict=lambda: {"available": False},
            )
            installed = SimpleNamespace(
                available=True,
                error="",
                to_dict=lambda: {"available": True, "install_state": "ready"},
            )
            runtime.install_agent_runtime.return_value = installed
            runtime.prepare.return_value = {
                "agent": {"available": True},
                "cognee": {"available": True},
                "camofox": {"available": True},
                "firecrawl": {"available": True},
            }
            try:
                with mock.patch(
                    "enterprise_agent_platform.deployment.PlatformRuntimeManager",
                    return_value=runtime,
                ):
                    statuses = DeploymentManager(paths).prepare_platform_runtime(
                        host="127.0.0.1",
                        port=8765,
                    )
            finally:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
                os.close(descriptor)

            self.assertTrue(statuses["agent"]["available"])
            runtime.install_agent_runtime.assert_called_once_with(force=False)
            runtime.close.assert_called_once_with()

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

            self.assertEqual(env["ENTERPRISE_AGENT_RUNTIME_HOME"], str(paths.data_dir / "runtimes" / "agent"))
            self.assertEqual(env["ENTERPRISE_COGNEE_REPO"], str(root / "cognee"))
            self.assertEqual(env["ENTERPRISE_FIRECRAWL_REPO"], str(root / "firecrawl"))
            self.assertNotIn("ENTERPRISE_HERMES_REPO", env)
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

    def test_deploy_update_rejects_all_dirty_worktree_states_before_pull(self):
        if not shutil.which("git"):
            self.skipTest("git is not available")
        source_script = Path(__file__).resolve().parents[2] / "deploy.sh"
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            tools = base / "tools"
            tools.mkdir()
            for name, body in (
                ("node", "#!/bin/sh\nprintf '22.19.0\\n'\n"),
                ("npm", "#!/bin/sh\nexit 0\n"),
            ):
                executable = tools / name
                executable.write_text(body, encoding="utf-8")
                executable.chmod(0o755)
            env = os.environ.copy()
            env["PATH"] = f"{tools}{os.pathsep}{env.get('PATH', '')}"
            env["PYTHON_BIN"] = str(base / "python-must-not-run")

            for dirty_state in ("unstaged", "staged", "untracked"):
                with self.subTest(dirty_state=dirty_state):
                    root = base / dirty_state
                    root.mkdir()
                    shutil.copy2(source_script, root / "deploy.sh")
                    tracked = root / "tracked.txt"
                    tracked.write_text("original\n", encoding="utf-8")
                    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
                    subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=root, check=True)
                    subprocess.run(["git", "config", "user.name", "Deploy Test"], cwd=root, check=True)
                    subprocess.run(["git", "add", "deploy.sh", "tracked.txt"], cwd=root, check=True)
                    subprocess.run(["git", "commit", "-q", "-m", "initial"], cwd=root, check=True)
                    before = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()

                    if dirty_state == "untracked":
                        (root / "untracked.txt").write_text("keep me\n", encoding="utf-8")
                    else:
                        tracked.write_text(f"{dirty_state} local work\n", encoding="utf-8")
                        if dirty_state == "staged":
                            subprocess.run(["git", "add", "tracked.txt"], cwd=root, check=True)

                    result = subprocess.run(
                        ["bash", str(root / "deploy.sh"), "update"],
                        cwd=root,
                        env=env,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        text=True,
                        check=False,
                    )

                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("staged, unstaged, or untracked changes", result.stderr)
                    self.assertNotIn("couldn't find remote ref", result.stderr.lower())
                    self.assertEqual(
                        subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
                        before,
                    )
                    self.assertTrue(
                        subprocess.check_output(
                            ["git", "status", "--porcelain=v1", "--untracked-files=all"],
                            cwd=root,
                            text=True,
                        ).strip()
                    )

    def test_failed_update_redeploys_previous_revision_after_rollback(self):
        if not shutil.which("git"):
            self.skipTest("git is not available")
        source_script = Path(__file__).resolve().parents[2] / "deploy.sh"
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            upstream = base / "upstream"
            upstream.mkdir()
            subprocess.run(["git", "init", "-q"], cwd=upstream, check=True)
            subprocess.run(["git", "checkout", "-q", "-b", "main"], cwd=upstream, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=upstream, check=True)
            subprocess.run(["git", "config", "user.name", "Deploy Test"], cwd=upstream, check=True)
            shutil.copy2(source_script, upstream / "deploy.sh")
            (upstream / "version.txt").write_text("old\n", encoding="utf-8")
            subprocess.run(["git", "add", "deploy.sh", "version.txt"], cwd=upstream, check=True)
            subprocess.run(["git", "commit", "-q", "-m", "old"], cwd=upstream, check=True)
            old_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=upstream, text=True).strip()

            downstream = base / "downstream"
            subprocess.run(["git", "clone", "-q", str(upstream), str(downstream)], check=True)
            (upstream / "version.txt").write_text("new\n", encoding="utf-8")
            subprocess.run(["git", "add", "version.txt"], cwd=upstream, check=True)
            subprocess.run(["git", "commit", "-q", "-m", "new"], cwd=upstream, check=True)

            tools = base / "tools"
            tools.mkdir()
            (tools / "node").write_text("#!/bin/sh\nprintf '22.19.0\\n'\n", encoding="utf-8")
            (tools / "npm").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            (tools / "python").write_text(
                """#!/bin/sh
root=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--root" ]; then
    root="$2"
    shift 2
  else
    shift
  fi
done
version="$(tr -d '\\n' < "$root/version.txt")"
printf '%s\\n' "$version" >> "$FAKE_DEPLOY_LOG"
printf '%s\\n' "$version" > "$FAKE_SIDECAR"
if [ "$version" = "new" ]; then
  exit 1
fi
exit 0
""",
                encoding="utf-8",
            )
            for executable in tools.iterdir():
                executable.chmod(0o755)
            log = base / "deploy.log"
            sidecar = base / "managed-sidecar.txt"
            env = os.environ.copy()
            env.update(
                {
                    "PATH": f"{tools}{os.pathsep}{env.get('PATH', '')}",
                    "PYTHON_BIN": str(tools / "python"),
                    "FAKE_DEPLOY_LOG": str(log),
                    "FAKE_SIDECAR": str(sidecar),
                }
            )

            result = subprocess.run(
                ["bash", str(downstream / "deploy.sh"), "update"],
                cwd=downstream,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn(f"Rolled back to {old_sha}", result.stderr)
            self.assertEqual(log.read_text(encoding="utf-8").splitlines(), ["new", "old"])
            self.assertEqual(sidecar.read_text(encoding="utf-8"), "old\n")
            self.assertEqual(
                subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=downstream, text=True).strip(),
                old_sha,
            )

    def test_platform_pyproject_supports_editable_install(self):
        pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
        data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
        package_data = data["tool"]["setuptools"]["package-data"]
        self.assertEqual(package_data["enterprise_agent_platform"], ["static/*"])
        self.assertFalse(any("hermes" in name.lower() for name in package_data))


if __name__ == "__main__":
    unittest.main()
