from __future__ import annotations

import fcntl
import json
import os
import signal
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import tomllib
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from enterprise_agent_platform.cognee_bridge import CogneeBridge
from enterprise_agent_platform.config import PlatformConfig
from enterprise_agent_platform.deployment import (
    DeploymentError,
    DeploymentManager,
    DeploymentPaths,
    UpstreamSourceSpec,
    _camofox_system_dependency_problems,
    _existing_service_data_dir,
    _probe_json_health,
    _resolve_existing_service_deployment,
    apt_get_command_base,
    python_venv_package_names,
    runtime_env,
    searxng_ready_timeout_seconds,
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


def bypass_managed_upstreams(manager: DeploymentManager) -> None:
    manager.ensure_managed_sources = mock.Mock()
    manager.ensure_cognee_dependencies = mock.Mock()


def write_platform_settings(data_dir: Path, values: dict[str, str]) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(data_dir / "platform.db")
    try:
        connection.execute(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, secret INTEGER NOT NULL DEFAULT 0)"
        )
        connection.executemany(
            "INSERT INTO settings (key, value, secret) VALUES (?, ?, 0)",
            tuple(values.items()),
        )
        connection.commit()
    finally:
        connection.close()


def make_git_source(path: Path, required: tuple[str, ...]) -> str:
    path.mkdir(parents=True)
    subprocess.run(["git", "init", "--quiet"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.email", "source@example.invalid"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.name", "Source Test"], cwd=path, check=True)
    for relative in required:
        target = path / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(f"fixture for {relative}\n", encoding="utf-8")
    subprocess.run(["git", "add", "--all"], cwd=path, check=True)
    subprocess.run(["git", "commit", "--quiet", "-m", "source"], cwd=path, check=True)
    return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=path, text=True).strip()



def make_update_checkout(base: Path, source_script: Path) -> tuple[Path, str, str]:
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

    checkout = base / "checkout"
    subprocess.run(["git", "clone", "-q", str(upstream), str(checkout)], check=True)
    (upstream / "version.txt").write_text("new\n", encoding="utf-8")
    subprocess.run(["git", "add", "version.txt"], cwd=upstream, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "new"], cwd=upstream, check=True)
    new_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=upstream, text=True).strip()
    return checkout, old_sha, new_sha


def make_fake_deploy_python(base: Path) -> Path:
    executable = base / "fake-python"
    executable.write_text(
        """#!/bin/sh
case "${1:-}" in
  */scripts/docs_sync.py)
    root="${1%/scripts/docs_sync.py}"
    version="$(tr -d '\\n' < "$root/version.txt")"
    mode="${2:-}"
    if [ -n "${FAKE_DOCS_LOG:-}" ]; then
      printf '%s:%s' "$version" "$mode" >> "$FAKE_DOCS_LOG"
      shift 2
      for argument in "$@"; do
        printf ':%s' "$argument" >> "$FAKE_DOCS_LOG"
      done
      printf '\\n' >> "$FAKE_DOCS_LOG"
    fi
    if [ "${FAKE_FAIL_DOCS_MODE:-}" = "$mode" ]; then
      exit 1
    fi
    exit 0
    ;;
esac
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
if [ "$version" = "new" ]; then
  if [ "${FAKE_CREATE_LOCAL_CHANGE:-}" = "1" ]; then
    printf 'preserve\\n' > "$root/local-after-pull.txt"
  fi
  if [ "${FAKE_FAIL_NEW:-}" = "1" ]; then
    exit 1
  fi
fi
exit 0
""",
        encoding="utf-8",
    )
    executable.chmod(0o755)
    return executable

class DeploymentTests(unittest.TestCase):
    def test_managed_cognee_real_import_keeps_source_clean_and_reusable(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            root = tmp / "checkout"
            data = tmp / "state"
            seed = tmp / "cognee-source"
            package = seed / "cognee"
            package.mkdir(parents=True)
            (seed / "pyproject.toml").write_text(
                "[project]\nname = 'cognee'\nversion = '1.0.0'\n",
                encoding="utf-8",
            )
            (package / "__init__.py").write_text(
                "IMPORT_ORIGIN = 'managed-source'\n",
                encoding="utf-8",
            )
            subprocess.run(["git", "init", "--quiet"], cwd=seed, check=True)
            subprocess.run(
                ["git", "add", "--all"], cwd=seed, check=True
            )
            subprocess.run(
                [
                    "git",
                    "-c",
                    "user.name=Source Test",
                    "-c",
                    "user.email=source@example.invalid",
                    "commit",
                    "--quiet",
                    "-m",
                    "source",
                ],
                cwd=seed,
                check=True,
            )
            revision = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=seed, text=True
            ).strip()
            target = data / "runtimes" / "cognee" / "source" / revision
            target.parent.mkdir(parents=True)
            seed.rename(target)

            installed = tmp / "site-packages"
            installed_package = installed / "cognee"
            installed_package.mkdir(parents=True)
            (installed_package / "__init__.py").write_text(
                "IMPORT_ORIGIN = 'verified-install'\n",
                encoding="utf-8",
            )
            config = SimpleNamespace(
                manage_cognee=True,
                cognee_repo=target,
                knowledge_backend="hybrid",
                cognee_dataset="test",
                cognee_ingest_background=False,
            )
            runtime = SimpleNamespace(
                cognee_runtime_config=lambda: {
                    "manage_cognee": True,
                    "repo_path": str(target),
                }
            )
            bridge = CogneeBridge(config, lambda _key: "", runtime)

            original_path = list(sys.path)
            saved_modules = {
                name: module
                for name, module in sys.modules.items()
                if name == "cognee" or name.startswith("cognee.")
            }
            for name in saved_modules:
                sys.modules.pop(name, None)
            sys.path.insert(0, str(installed))
            try:
                imported = bridge._import_cognee()
                self.assertEqual(imported.IMPORT_ORIGIN, "verified-install")
                self.assertNotIn(str(target), sys.path)
                self.assertFalse(any(target.rglob("__pycache__")))

                spec = UpstreamSourceSpec(
                    name="cognee",
                    repository_url="https://example.invalid/cognee.git",
                    revision=revision,
                    required_paths=("pyproject.toml", "cognee/__init__.py"),
                )
                manager = DeploymentManager(
                    DeploymentPaths.from_root(root, data_dir=data)
                )
                self.assertEqual(manager._ensure_managed_source(spec), target)
            finally:
                sys.path[:] = original_path
                for name in list(sys.modules):
                    if name == "cognee" or name.startswith("cognee."):
                        sys.modules.pop(name, None)
                sys.modules.update(saved_modules)

    def test_external_cognee_repo_remains_importable_when_management_is_disabled(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            external = tmp / "external"
            package = external / "cognee"
            package.mkdir(parents=True)
            (package / "__init__.py").write_text(
                "IMPORT_ORIGIN = 'external-repo'\n",
                encoding="utf-8",
            )
            config = SimpleNamespace(
                manage_cognee=False,
                cognee_repo=external,
                knowledge_backend="hybrid",
                cognee_dataset="test",
                cognee_ingest_background=False,
            )
            runtime = SimpleNamespace(
                cognee_runtime_config=lambda: {
                    "manage_cognee": False,
                    "repo_path": str(external),
                },
                ensure_cognee_ready=lambda: SimpleNamespace(
                    managed=False,
                    available=False,
                    error="",
                ),
            )
            bridge = CogneeBridge(config, lambda _key: "", runtime)

            original_path = list(sys.path)
            saved_modules = {
                name: module
                for name, module in sys.modules.items()
                if name == "cognee" or name.startswith("cognee.")
            }
            for name in saved_modules:
                sys.modules.pop(name, None)
            try:
                status = bridge.status()
                self.assertTrue(status.available)
                self.assertEqual(bridge._module.IMPORT_ORIGIN, "external-repo")
                self.assertEqual(sys.path[0], str(external))
            finally:
                sys.path[:] = original_path
                for name in list(sys.modules):
                    if name == "cognee" or name.startswith("cognee."):
                        sys.modules.pop(name, None)
                sys.modules.update(saved_modules)

    def test_managed_config_ignores_repo_environment_overrides(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            data = root / "state"
            with mock.patch.dict(
                os.environ,
                {
                    "ENTERPRISE_PLATFORM_DATA": str(data),
                    "ENTERPRISE_MANAGE_COGNEE": "1",
                    "ENTERPRISE_MANAGE_FIRECRAWL": "1",
                    "ENTERPRISE_COGNEE_REPO": str(root / "legacy-cognee"),
                    "ENTERPRISE_FIRECRAWL_REPO": str(root / "legacy-firecrawl"),
                },
                clear=False,
            ):
                managed = PlatformConfig.from_env(root)
            paths = DeploymentPaths.from_root(root, data_dir=data)
            self.assertEqual(managed.cognee_repo, paths.cognee_repo)
            self.assertEqual(managed.firecrawl_repo, paths.firecrawl_repo)

            with mock.patch.dict(
                os.environ,
                {
                    "ENTERPRISE_PLATFORM_DATA": str(data),
                    "ENTERPRISE_MANAGE_COGNEE": "0",
                    "ENTERPRISE_MANAGE_FIRECRAWL": "0",
                    "ENTERPRISE_COGNEE_REPO": str(root / "external-cognee"),
                    "ENTERPRISE_FIRECRAWL_REPO": str(root / "external-firecrawl"),
                },
                clear=False,
            ):
                external = PlatformConfig.from_env(root)
            self.assertEqual(external.cognee_repo, root / "external-cognee")
            self.assertEqual(external.firecrawl_repo, root / "external-firecrawl")

    def test_platform_config_preserves_external_repo_paths_when_management_is_disabled(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            paths = DeploymentPaths.from_root(root, data_dir=root / "state")
            external_cognee = root / "external-cognee"
            external_firecrawl = root / "external-firecrawl"
            manager = DeploymentManager(paths)

            with mock.patch.dict(
                os.environ,
                {
                    "ENTERPRISE_PLATFORM_DATA": str(paths.data_dir),
                    "ENTERPRISE_MANAGE_COGNEE": "0",
                    "ENTERPRISE_COGNEE_REPO": str(external_cognee),
                    "ENTERPRISE_MANAGE_FIRECRAWL": "0",
                    "ENTERPRISE_FIRECRAWL_REPO": str(external_firecrawl),
                },
                clear=False,
            ):
                config = manager._platform_config(host="127.0.0.1", port=8765)

            self.assertFalse(config.manage_cognee)
            self.assertFalse(config.manage_firecrawl)
            self.assertEqual(config.cognee_repo, external_cognee)
            self.assertEqual(config.firecrawl_repo, external_firecrawl)

    def test_empty_managed_source_selection_needs_no_git_or_download(self):
        with tempfile.TemporaryDirectory() as td:
            manager = DeploymentManager(
                DeploymentPaths.from_root(Path(td)),
                runner=RecordingDeployRunner(),
            )
            manager._ensure_managed_source = mock.Mock()

            with mock.patch(
                "enterprise_agent_platform.deployment.shutil.which",
                side_effect=AssertionError("disabled integrations must not probe git"),
            ):
                manager.ensure_managed_sources(())

            manager._ensure_managed_source.assert_not_called()

    def test_managed_source_uses_clean_legacy_checkout_as_seed_without_deleting_it(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            required = ("pyproject.toml", "cognee/__init__.py")
            revision = make_git_source(root / "cognee", required)
            spec = UpstreamSourceSpec(
                name="cognee",
                repository_url="https://example.invalid/cognee.git",
                revision=revision,
                required_paths=required,
            )
            paths = DeploymentPaths.from_root(root, data_dir=root / "state")
            manager = DeploymentManager(paths)

            target = manager._ensure_managed_source(spec)

            self.assertEqual(target, root / "state" / "runtimes" / "cognee" / "source" / revision)
            self.assertTrue((root / "cognee").is_dir())
            self.assertEqual(
                subprocess.check_output(
                    ["git", "rev-parse", "HEAD"],
                    cwd=root / "cognee",
                    text=True,
                ).strip(),
                revision,
            )
            self.assertEqual(
                subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=target, text=True).strip(),
                revision,
            )

            class NoNetworkRunner(RecordingDeployRunner):
                def run(self, cmd, **kwargs):
                    if "fetch" in cmd:
                        raise AssertionError("validated source reuse must not fetch")
                    return super().run(cmd, **kwargs)

            offline = DeploymentManager(paths, runner=NoNetworkRunner())
            self.assertEqual(offline._ensure_managed_source(spec), target)

    def test_dirty_or_unknown_legacy_checkout_is_never_deleted(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            required = ("docker-compose.yaml",)
            legacy_revision = make_git_source(root / "firecrawl", required)
            (root / "firecrawl" / ".env").write_text("SECRET=value\n", encoding="utf-8")
            spec = UpstreamSourceSpec(
                name="firecrawl",
                repository_url="https://example.invalid/firecrawl.git",
                revision=legacy_revision,
                required_paths=required,
            )
            paths = DeploymentPaths.from_root(root, data_dir=root / "state")
            target = root / "state" / "runtimes" / "firecrawl" / "source" / legacy_revision
            target.parent.mkdir(parents=True)
            subprocess.run(["git", "clone", "--quiet", str(root / "firecrawl"), str(target)], check=True)
            manager = DeploymentManager(paths)

            self.assertEqual(manager._ensure_managed_source(spec), target)
            self.assertTrue((root / "firecrawl" / ".env").is_file())

    def test_managed_source_rejects_wrong_revision_and_required_symlink(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            revision = make_git_source(root / "repository", ("required.txt",))
            paths = DeploymentPaths.from_root(root, data_dir=root / "state")
            manager = DeploymentManager(paths)
            wrong = UpstreamSourceSpec(
                name="cognee",
                repository_url="https://example.invalid/cognee.git",
                revision="0" * 40,
                required_paths=("required.txt",),
            )
            with self.assertRaisesRegex(DeploymentError, "revision mismatch"):
                manager._validate_managed_source(root / "repository", wrong)

            (root / "repository" / "required.txt").unlink()
            (root / "repository" / "required.txt").symlink_to("outside")
            linked = UpstreamSourceSpec(
                name="cognee",
                repository_url="https://example.invalid/cognee.git",
                revision=revision,
                required_paths=("required.txt",),
            )
            with self.assertRaisesRegex(DeploymentError, "modified|regular file"):
                manager._validate_managed_source(root / "repository", linked)

    def test_managed_firecrawl_source_requires_exact_compose_service_inventory(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "firecrawl-source"
            source.mkdir()
            (source / "docker-compose.yaml").write_text(
                "services:\n  api:\n    image: example/api\n  redis:\n    image: redis\n",
                encoding="utf-8",
            )
            subprocess.run(["git", "init", "--quiet"], cwd=source, check=True)
            subprocess.run(["git", "add", "docker-compose.yaml"], cwd=source, check=True)
            subprocess.run(
                [
                    "git",
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.invalid",
                    "commit",
                    "--quiet",
                    "-m",
                    "compose",
                ],
                cwd=source,
                check=True,
            )
            revision = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=source, text=True
            ).strip()
            manager = DeploymentManager(
                DeploymentPaths.from_root(root, data_dir=root / "state")
            )
            valid = UpstreamSourceSpec(
                name="firecrawl",
                repository_url="https://example.invalid/firecrawl.git",
                revision=revision,
                required_paths=("docker-compose.yaml",),
                compose_services=("api", "redis"),
            )
            manager._validate_managed_source(source, valid)

            mismatched = replace(valid, compose_services=("api",))
            with self.assertRaisesRegex(DeploymentError, "Compose services mismatch"):
                manager._validate_managed_source(source, mismatched)

    def test_cognee_dependencies_are_installed_once_and_verified_for_offline_reuse(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            required = ("pyproject.toml", "cognee/__init__.py")
            source = root / "managed-cognee"
            revision = make_git_source(source, required)
            spec = UpstreamSourceSpec(
                name="cognee",
                repository_url="https://example.invalid/cognee.git",
                revision=revision,
                required_paths=required,
            )
            paths = replace(
                DeploymentPaths.from_root(root, data_dir=root / "state"),
                cognee_repo=source,
            )
            paths.venv_python.parent.mkdir(parents=True)
            paths.venv_python.write_text("#!/usr/bin/env python3\n", encoding="utf-8")
            class CogneeInstallRunner(RecordingDeployRunner):
                installed = False

                def run(self, cmd, *, cwd=None, env=None, timeout=None, check=True):
                    result = super().run(
                        cmd,
                        cwd=cwd,
                        env=env,
                        timeout=timeout,
                        check=check,
                    )
                    if cmd[-1:] == [str(source)] and "pip" in cmd:
                        self.installed = True
                    if "-c" in cmd and "direct_url.json" in cmd[-1]:
                        return subprocess.CompletedProcess(cmd, 0 if self.installed else 1)
                    return result

            runner = CogneeInstallRunner()
            manager = DeploymentManager(paths, runner=runner)

            with mock.patch(
                "enterprise_agent_platform.deployment.upstream_source_specs",
                return_value=(spec,),
            ):
                manager.ensure_cognee_dependencies()
                manager.ensure_cognee_dependencies()

            installs = [
                call
                for call in runner.calls
                if call["cmd"][-1:] == [str(source)] and "pip" in call["cmd"]
            ]
            self.assertEqual(len(installs), 1)
            self.assertNotIn("--force-reinstall", installs[0]["cmd"])
            self.assertNotIn("--no-build-isolation", installs[0]["cmd"])
            marker = root / "state" / "runtimes" / "cognee" / "python-install.json"
            self.assertEqual(json.loads(marker.read_text(encoding="utf-8"))["revision"], revision)
            marker.unlink()
            with mock.patch(
                "enterprise_agent_platform.deployment.upstream_source_specs",
                return_value=(spec,),
            ):
                manager.ensure_cognee_dependencies()
            self.assertTrue(marker.is_file())
            installs = [
                call
                for call in runner.calls
                if call["cmd"][-1:] == [str(source)] and "pip" in call["cmd"]
            ]
            self.assertEqual(len(installs), 1)
            probes = [call for call in runner.calls if "-c" in call["cmd"]]
            self.assertTrue(probes)
            self.assertEqual(probes[-1]["env"]["PYTHONDONTWRITEBYTECODE"], "1")

    def test_node_runtime_requires_node_and_npm_at_supported_version(self):
        with tempfile.TemporaryDirectory() as td:
            manager = DeploymentManager(DeploymentPaths.from_root(Path(td)), runner=RecordingDeployRunner())
            with mock.patch.dict(os.environ, {"ENTERPRISE_DEPLOY_AUTO_NODE": "0"}), mock.patch(
                "enterprise_agent_platform.deployment.shutil.which",
                side_effect=lambda name: None if name == "npm" else f"/tools/{name}",
            ):
                with self.assertRaisesRegex(DeploymentError, "Node.js 22.19"):
                    manager.ensure_node_version()

            with mock.patch.dict(os.environ, {"ENTERPRISE_DEPLOY_AUTO_NODE": "0"}), mock.patch(
                "enterprise_agent_platform.deployment.shutil.which",
                side_effect=lambda name: f"/tools/{name}",
            ), mock.patch(
                "enterprise_agent_platform.deployment._capture_command_stdout",
                return_value="v22.18.0",
            ):
                with self.assertRaisesRegex(DeploymentError, "found v22.18.0"):
                    manager.ensure_node_version()

            with mock.patch.dict(os.environ, {"ENTERPRISE_DEPLOY_AUTO_NODE": "0"}), mock.patch(
                "enterprise_agent_platform.deployment.shutil.which",
                side_effect=lambda name: f"/tools/{name}",
            ), mock.patch(
                "enterprise_agent_platform.deployment._capture_command_stdout",
                return_value="v22.19.0",
            ):
                manager.ensure_node_version()

    def test_missing_system_node_is_installed_and_activated_under_data_directory(self):
        with tempfile.TemporaryDirectory() as td:
            paths = DeploymentPaths.from_root(Path(td), data_dir=Path(td) / "state")
            manager = DeploymentManager(paths, runner=RecordingDeployRunner())
            managed_bin = paths.managed_node_root / "node-v22.19.0-linux-x64" / "bin"
            manager.install_managed_node = mock.Mock(return_value=managed_bin)
            original_path = os.environ.get("PATH", "")

            with mock.patch.dict(os.environ, {"PATH": original_path}), mock.patch(
                "enterprise_agent_platform.deployment.shutil.which",
                return_value=None,
            ), mock.patch.object(manager, "_node_install_is_usable", return_value=False):
                manager.ensure_node_version()
                self.assertEqual(os.environ["PATH"].split(os.pathsep)[0], str(managed_bin))

            manager.install_managed_node.assert_called_once_with()

    def test_bootstrap_prepare_initializes_managed_sources_and_platform_venv(self):
        if not shutil.which("git"):
            self.skipTest("git is not available")
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            make_deploy_root(root)
            runner = RecordingDeployRunner()
            paths = DeploymentPaths.from_root(root)
            manager = DeploymentManager(paths, runner=runner)
            manager.ensure_node_version = mock.Mock()
            bypass_managed_upstreams(manager)

            result = manager.bootstrap(host="127.0.0.1", port=8765, mode="prepare", prepare_runtime=False)

            commands = [call["cmd"] for call in runner.calls]
            self.assertEqual(result.mode, "prepare")
            manager.ensure_managed_sources.assert_called_once_with(("cognee", "firecrawl"))
            manager.ensure_cognee_dependencies.assert_called_once_with()
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

    def test_bootstrap_only_prepares_enabled_upstream_sources(self):
        cases = (
            ("1", "0", ("cognee",), True),
            ("0", "1", ("firecrawl",), False),
            ("0", "0", (), False),
        )
        for manage_cognee, manage_firecrawl, expected, install_cognee in cases:
            with self.subTest(
                manage_cognee=manage_cognee,
                manage_firecrawl=manage_firecrawl,
            ), tempfile.TemporaryDirectory() as td:
                root = Path(td)
                paths = DeploymentPaths.from_root(root, data_dir=root / "state")
                manager = DeploymentManager(paths, runner=RecordingDeployRunner())
                manager.ensure_python_version = mock.Mock()
                manager.ensure_node_version = mock.Mock()
                manager.ensure_layout = mock.Mock()
                manager.ensure_managed_sources = mock.Mock()
                manager.ensure_platform_venv = mock.Mock()
                manager.ensure_cognee_dependencies = mock.Mock()

                with mock.patch.dict(
                    os.environ,
                    {
                        "ENTERPRISE_PLATFORM_DATA": str(paths.data_dir),
                        "ENTERPRISE_MANAGE_COGNEE": manage_cognee,
                        "ENTERPRISE_MANAGE_FIRECRAWL": manage_firecrawl,
                    },
                    clear=False,
                ):
                    result = manager.bootstrap(
                        host="127.0.0.1",
                        port=8765,
                        mode="prepare",
                        prepare_runtime=False,
                    )

                self.assertEqual(result.mode, "prepare")
                manager.ensure_managed_sources.assert_called_once_with(expected)
                if install_cognee:
                    manager.ensure_cognee_dependencies.assert_called_once_with()
                else:
                    manager.ensure_cognee_dependencies.assert_not_called()

    def test_bootstrap_managed_sources_use_persisted_settings_before_environment(self):
        cases = (
            (
                "persisted disabled with environment unset",
                {"cognee_manage": "0", "firecrawl_manage": "0"},
                {},
                (),
                False,
            ),
            (
                "persisted enabled overrides disabled environment",
                {"cognee_manage": "1", "firecrawl_manage": "1"},
                {
                    "ENTERPRISE_MANAGE_COGNEE": "0",
                    "ENTERPRISE_MANAGE_FIRECRAWL": "0",
                },
                ("cognee", "firecrawl"),
                True,
            ),
            (
                "first deployment defaults to managed",
                None,
                {},
                ("cognee", "firecrawl"),
                True,
            ),
        )
        for label, persisted, environment, expected, install_cognee in cases:
            with self.subTest(label=label), tempfile.TemporaryDirectory() as td:
                root = Path(td)
                paths = DeploymentPaths.from_root(root, data_dir=root / "state")
                if persisted is not None:
                    write_platform_settings(paths.data_dir, persisted)
                manager = DeploymentManager(paths, runner=RecordingDeployRunner())
                manager.ensure_python_version = mock.Mock()
                manager.ensure_node_version = mock.Mock()
                manager.ensure_layout = mock.Mock()
                manager.ensure_managed_sources = mock.Mock()
                manager.ensure_platform_venv = mock.Mock()
                manager.ensure_cognee_dependencies = mock.Mock()

                with mock.patch.dict(os.environ, environment, clear=True):
                    result = manager.bootstrap(
                        host="127.0.0.1",
                        port=8765,
                        mode="prepare",
                        prepare_runtime=False,
                    )

                self.assertEqual(result.mode, "prepare")
                manager.ensure_managed_sources.assert_called_once_with(expected)
                if install_cognee:
                    manager.ensure_cognee_dependencies.assert_called_once_with()
                else:
                    manager.ensure_cognee_dependencies.assert_not_called()

    def test_platform_pip_install_retries_transient_failure(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            make_deploy_root(root)
            runner = TransientPipFailureRunner()
            paths = DeploymentPaths.from_root(root)
            manager = DeploymentManager(paths, runner=runner)
            manager.ensure_node_version = mock.Mock()
            bypass_managed_upstreams(manager)

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
            bypass_managed_upstreams(manager)

            def fake_which(name):
                if name in {"apt-get", "git", "sudo"}:
                    return f"/usr/bin/{name}"
                return None

            with mock.patch("enterprise_agent_platform.deployment.shutil.which", side_effect=fake_which):
                with mock.patch("enterprise_agent_platform.deployment.os.geteuid", return_value=1000):
                    with mock.patch(
                        "enterprise_agent_platform.deployment.sys.stdin",
                        SimpleNamespace(isatty=lambda: True),
                    ):
                        result = manager.bootstrap(host="127.0.0.1", port=8765, mode="prepare", prepare_runtime=False)

            commands = [call["cmd"] for call in runner.calls]
            self.assertEqual(result.mode, "prepare")
            self.assertIn(["/usr/bin/sudo", "/usr/bin/apt-get", "update"], commands)
            self.assertIn(
                [
                    "/usr/bin/sudo",
                    "/usr/bin/apt-get",
                    "install",
                    "-y",
                    python_venv_package_names()[0],
                ],
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
            bypass_managed_upstreams(manager)

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
            bypass_managed_upstreams(manager)

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

            with mock.patch.dict(
                os.environ,
                {
                    "ENTERPRISE_MANAGE_SEARXNG": "0",
                    "ENTERPRISE_SEARXNG_API_URL": "http://127.0.0.1:14567",
                    "ENTERPRISE_SEARXNG_TIMEOUT_SECONDS": "37.5",
                    "ENTERPRISE_SEARXNG_STARTUP_WAIT_SECONDS": "420",
                },
            ):
                unit = user_service_unit(paths, host="0.0.0.0", port=8765)

            self.assertIn("Restart=on-failure", unit)
            self.assertIn(f"ENTERPRISE_PLATFORM_DATA={root / 'state'}", unit)
            self.assertIn(f"ENTERPRISE_AGENT_RUNTIME_HOME={root / 'state' / 'runtimes' / 'agent'}", unit)
            self.assertIn(str(paths.managed_node_current / "bin"), unit)
            self.assertIn(f"ENTERPRISE_SERVICE_NAME={paths.service_name}", unit)
            self.assertIn(f"ENTERPRISE_COGNEE_REPO={paths.cognee_repo}", unit)
            self.assertIn(f"ENTERPRISE_FIRECRAWL_REPO={paths.firecrawl_repo}", unit)
            self.assertIn("ENTERPRISE_MANAGE_SEARXNG=0", unit)
            self.assertIn("ENTERPRISE_SEARXNG_API_URL=http://127.0.0.1:14567", unit)
            self.assertIn("ENTERPRISE_SEARXNG_TIMEOUT_SECONDS=37.5", unit)
            self.assertIn("ENTERPRISE_SEARXNG_STARTUP_WAIT_SECONDS=420", unit)
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
            bypass_managed_upstreams(manager)
            manager.prepare_agent_runtime_artifact = mock.Mock(return_value={})
            manager.wait_for_service_ready = mock.Mock()

            result = manager.bootstrap(host="127.0.0.1", port=8765, mode="service", prepare_runtime=False)

            commands = [call["cmd"] for call in runner.calls]
            self.assertEqual(result.mode, "service")
            manager.prepare_agent_runtime_artifact.assert_called_once_with(host="127.0.0.1", port=8765)
            self.assertIn(["systemctl", "--user", "daemon-reload"], commands)
            self.assertIn(["systemctl", "--user", "enable", paths.service_name], commands)
            self.assertIn(["systemctl", "--user", "restart", paths.service_name], commands)
            self.assertNotIn(["systemctl", "--user", "enable", "--now", paths.service_name], commands)

    def test_live_gateway_reload_waits_for_gateway_exec_and_updated_code(self):
        with tempfile.TemporaryDirectory() as td:
            manager = DeploymentManager(
                DeploymentPaths.from_root(Path(td)),
                runner=RecordingDeployRunner(),
            )
            manager._wait_for_service_http = mock.Mock(return_value=True)
            manager._wait_for_agent_http = mock.Mock(return_value=True)
            manager._wait_for_camofox_http = mock.Mock(return_value=True)
            manager._wait_for_camofox_liveness_http = mock.Mock(return_value=True)
            manager._wait_for_searxng_http = mock.Mock(return_value=True)
            old_process_state = {
                "pid": os.getpid(),
                "heartbeat_at": time.time(),
                "backend_ready": True,
                "generation": 8,
                "exec_generation": 2,
                "code_signature": "new-code",
            }
            reexecuted_state = {
                **old_process_state,
                "exec_generation": 3,
            }

            with (
                mock.patch(
                    "enterprise_agent_platform.deployment.request_gateway_reload",
                ) as reload_gateway,
                mock.patch(
                    "enterprise_agent_platform.deployment.gateway_process_is_live",
                    return_value=True,
                ),
                mock.patch(
                    "enterprise_agent_platform.deployment.gateway_code_signature",
                    return_value="new-code",
                ),
                mock.patch(
                    "enterprise_agent_platform.deployment.read_gateway_state",
                    side_effect=[
                        old_process_state,
                        reexecuted_state,
                        reexecuted_state,
                    ],
                ) as read_state,
                mock.patch("enterprise_agent_platform.deployment.time.sleep"),
            ):
                manager._reload_live_gateway(
                    host="127.0.0.1",
                    port=8765,
                    previous_generation=7,
                    previous_exec_generation=2,
                    mode="foreground",
                )

            reload_gateway.assert_called_once_with(manager.paths.data_dir)
            self.assertEqual(read_state.call_count, 3)
            self.assertEqual(manager._wait_for_service_http.call_count, 2)
            self.assertEqual(manager._wait_for_searxng_http.call_count, 2)
            manager._wait_for_camofox_liveness_http.assert_called_once()

    def test_auto_bootstrap_hands_legacy_foreground_instance_to_detached_gateway(self):
        with tempfile.TemporaryDirectory() as td:
            paths = DeploymentPaths.from_root(Path(td))
            manager = DeploymentManager(paths, runner=RecordingDeployRunner())
            for name in (
                "ensure_python_version",
                "ensure_node_version",
                "ensure_layout",
                "ensure_managed_sources",
                "ensure_platform_venv",
                "ensure_cognee_dependencies",
            ):
                setattr(manager, name, mock.Mock())
            manager.prepare_agent_runtime_artifact = mock.Mock(return_value={})
            manager._handoff_foreground_update = mock.Mock()
            manager.user_systemd_available = mock.Mock(
                side_effect=AssertionError("legacy foreground handoff must preserve its mode")
            )

            with mock.patch.dict(
                os.environ,
                {
                    "ENTERPRISE_AUTO_UPDATE_SOURCE_MODE": "foreground",
                    "ENTERPRISE_AUTO_UPDATE_SOURCE_PID": "424242",
                },
                clear=False,
            ):
                result = manager.bootstrap(
                    host="127.0.0.1",
                    port=8765,
                    mode="auto",
                )

            self.assertEqual(result.mode, "foreground")
            manager._handoff_foreground_update.assert_called_once_with(
                source_pid=424242,
                host="127.0.0.1",
                port=8765,
            )
            manager.user_systemd_available.assert_not_called()

    def test_foreground_handoff_signals_only_the_verified_instance_lock_owner(self):
        with tempfile.TemporaryDirectory() as td:
            paths = DeploymentPaths.from_root(Path(td), data_dir=Path(td) / "state")
            paths.data_dir.mkdir()
            manager = DeploymentManager(paths, runner=RecordingDeployRunner())
            lock_path = paths.data_dir / ".enterprise-platform.lock"
            child_code = (
                "import fcntl, os, signal, sys\n"
                "fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o600)\n"
                "fcntl.flock(fd, fcntl.LOCK_EX)\n"
                "os.ftruncate(fd, 0)\n"
                "os.write(fd, (str(os.getpid()) + '\\n').encode('ascii'))\n"
                "print('ready', flush=True)\n"
                "signal.pause()\n"
            )
            child = subprocess.Popen(
                [sys.executable, "-c", child_code, str(lock_path)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                self.assertEqual(child.stdout.readline().strip(), "ready")
                manager._stop_foreground_source(child.pid)
                self.assertEqual(child.wait(timeout=5), -signal.SIGTERM)
                probe = os.open(lock_path, os.O_RDWR)
                try:
                    fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                finally:
                    os.close(probe)
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=5)
                if child.stdout is not None:
                    child.stdout.close()
                if child.stderr is not None:
                    child.stderr.close()

    def test_service_switches_prepare_matching_agent_runtime_before_restart(self):
        with tempfile.TemporaryDirectory() as td:
            paths = DeploymentPaths.from_root(Path(td))
            for mode in ("service", "auto"):
                with self.subTest(mode=mode):
                    manager = DeploymentManager(paths, runner=RecordingDeployRunner())
                    manager.ensure_python_version = mock.Mock()
                    manager.ensure_node_version = mock.Mock()
                    manager.ensure_layout = mock.Mock()
                    manager.ensure_managed_sources = mock.Mock()
                    manager.ensure_platform_venv = mock.Mock()
                    manager.ensure_cognee_dependencies = mock.Mock()
                    manager.user_systemd_available = mock.Mock(return_value=True)
                    sequence = mock.Mock()
                    sequence.restart.return_value = paths.service_path
                    manager.prepare_agent_runtime_artifact = sequence.prepare
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

    def test_explicit_foreground_prepares_matching_runtimes_before_start(self):
        with tempfile.TemporaryDirectory() as td:
            paths = DeploymentPaths.from_root(Path(td))
            manager = DeploymentManager(paths, runner=RecordingDeployRunner())
            manager.ensure_python_version = mock.Mock()
            manager.ensure_node_version = mock.Mock()
            manager.ensure_layout = mock.Mock()
            manager.ensure_managed_sources = mock.Mock()
            manager.ensure_platform_venv = mock.Mock()
            manager.ensure_cognee_dependencies = mock.Mock()
            sequence = mock.Mock()
            manager.prepare_agent_runtime_artifact = sequence.prepare
            manager.run_foreground = sequence.start

            result = manager.bootstrap(
                host="127.0.0.1",
                port=8765,
                mode="foreground",
                prepare_runtime=False,
            )

            self.assertEqual(result.mode, "foreground")
            self.assertEqual(
                sequence.mock_calls,
                [
                    mock.call.prepare(host="127.0.0.1", port=8765),
                    mock.call.start(host="127.0.0.1", port=8765),
                ],
            )

    def test_service_readiness_requires_platform_and_agent_health(self):
        with tempfile.TemporaryDirectory() as td:
            paths = DeploymentPaths.from_root(Path(td))
            manager = DeploymentManager(paths, runner=RecordingDeployRunner())
            manager._wait_for_service_http = mock.Mock(return_value=True)
            manager._wait_for_agent_http = mock.Mock(return_value=False)
            manager._raise_service_failed = mock.Mock(side_effect=DeploymentError("not ready"))

            with self.assertRaisesRegex(DeploymentError, "not ready"):
                manager.wait_for_service_ready(host="127.0.0.1", port=8765)

            manager._wait_for_service_http.assert_called_once()
            manager._wait_for_agent_http.assert_called_once()

    def test_service_readiness_requires_managed_camofox_capability(self):
        with tempfile.TemporaryDirectory() as td:
            paths = DeploymentPaths.from_root(Path(td))
            manager = DeploymentManager(paths, runner=RecordingDeployRunner())
            manager._wait_for_service_http = mock.Mock(return_value=True)
            manager._wait_for_agent_http = mock.Mock(return_value=True)
            manager._wait_for_camofox_http = mock.Mock(return_value=False)
            manager._raise_service_failed = mock.Mock(side_effect=DeploymentError("not ready"))

            with self.assertRaisesRegex(DeploymentError, "not ready"):
                manager.wait_for_service_ready(host="127.0.0.1", port=8765)

            manager._wait_for_camofox_http.assert_called_once()
            self.assertIn(
                "Camoufox browser capability",
                manager._raise_service_failed.call_args.args[0],
            )

    def test_service_readiness_requires_managed_searxng_health(self):
        with tempfile.TemporaryDirectory() as td:
            paths = DeploymentPaths.from_root(Path(td))
            manager = DeploymentManager(paths, runner=RecordingDeployRunner())
            manager._wait_for_service_http = mock.Mock(return_value=True)
            manager._wait_for_agent_http = mock.Mock(return_value=True)
            manager._wait_for_camofox_http = mock.Mock(return_value=True)
            manager._wait_for_searxng_http = mock.Mock(return_value=False)
            manager._raise_service_failed = mock.Mock(
                side_effect=DeploymentError("not ready")
            )

            with self.assertRaisesRegex(DeploymentError, "not ready"):
                manager.wait_for_service_ready(host="127.0.0.1", port=8765)

            manager._wait_for_searxng_http.assert_called_once()
            self.assertIn(
                "SearXNG search health endpoint",
                manager._raise_service_failed.call_args.args[0],
            )

    def test_service_readiness_gives_searxng_an_independent_cold_start_budget(self):
        with tempfile.TemporaryDirectory() as td:
            paths = DeploymentPaths.from_root(Path(td))
            manager = DeploymentManager(paths, runner=RecordingDeployRunner())
            manager._wait_for_service_http = mock.Mock(return_value=True)
            manager._wait_for_agent_http = mock.Mock(return_value=True)
            manager._wait_for_camofox_http = mock.Mock(return_value=True)
            manager._wait_for_camofox_liveness_http = mock.Mock(return_value=True)
            manager._wait_for_searxng_http = mock.Mock(return_value=True)

            with (
                mock.patch(
                    "enterprise_agent_platform.deployment.time.monotonic",
                    side_effect=[100.0, 125.0, 126.0],
                ),
                mock.patch(
                    "enterprise_agent_platform.deployment.searxng_ready_timeout_seconds",
                    return_value=300,
                ),
            ):
                manager.wait_for_service_ready(host="127.0.0.1", port=8765)

            self.assertEqual(
                manager._wait_for_searxng_http.call_args_list[0].kwargs["deadline"],
                425.0,
            )
            self.assertEqual(manager._wait_for_service_http.call_count, 2)
            self.assertEqual(manager._wait_for_agent_http.call_count, 2)
            manager._wait_for_camofox_http.assert_called_once()
            manager._wait_for_camofox_liveness_http.assert_called_once()
            self.assertEqual(manager._wait_for_searxng_http.call_count, 2)
            self.assertEqual(
                manager._wait_for_searxng_http.call_args_list[1].kwargs["deadline"],
                136.0,
            )
            self.assertEqual(
                manager._wait_for_service_http.call_args.kwargs["deadline"],
                136.0,
            )

    def test_service_readiness_rechecks_platform_after_slow_searxng_start(self):
        with tempfile.TemporaryDirectory() as td:
            paths = DeploymentPaths.from_root(Path(td))
            manager = DeploymentManager(paths, runner=RecordingDeployRunner())
            manager._wait_for_service_http = mock.Mock(
                side_effect=[True, False]
            )
            manager._wait_for_agent_http = mock.Mock(return_value=True)
            manager._wait_for_camofox_http = mock.Mock(return_value=True)
            manager._wait_for_camofox_liveness_http = mock.Mock(return_value=True)
            manager._wait_for_searxng_http = mock.Mock(return_value=True)
            manager._raise_service_failed = mock.Mock(
                side_effect=DeploymentError("not ready")
            )

            with self.assertRaisesRegex(DeploymentError, "not ready"):
                manager.wait_for_service_ready(host="127.0.0.1", port=8765)

            self.assertEqual(manager._wait_for_service_http.call_count, 2)
            self.assertIn(
                "stopped while",
                manager._raise_service_failed.call_args.args[0],
            )

    def test_camofox_readiness_uses_runtime_capability_probe_and_skips_when_disabled(self):
        with tempfile.TemporaryDirectory() as td:
            paths = DeploymentPaths.from_root(Path(td), data_dir=Path(td) / "state")
            paths.data_dir.mkdir(parents=True)
            manager = DeploymentManager(paths, runner=RecordingDeployRunner())
            runtime = mock.Mock()
            runtime._managed_camofox_enabled.return_value = True
            runtime._probe_camofox_capability.side_effect = [False, True]

            with (
                mock.patch(
                    "enterprise_agent_platform.deployment.PlatformRuntimeManager",
                    return_value=runtime,
                ),
                mock.patch("enterprise_agent_platform.deployment.time.sleep"),
            ):
                ready = manager._wait_for_camofox_http(
                    host="127.0.0.1",
                    port=8765,
                    deadline=time.monotonic() + 30,
                )

            self.assertTrue(ready)
            self.assertEqual(runtime._probe_camofox_capability.call_count, 2)
            runtime.close.assert_called_once_with()

            disabled = mock.Mock()
            disabled._managed_camofox_enabled.return_value = False
            with mock.patch(
                "enterprise_agent_platform.deployment.PlatformRuntimeManager",
                return_value=disabled,
            ):
                self.assertTrue(
                    manager._wait_for_camofox_http(
                        host="127.0.0.1",
                        port=8765,
                        deadline=time.monotonic(),
                    )
                )
            disabled._probe_camofox_capability.assert_not_called()
            disabled.close.assert_called_once_with()

    def test_final_camofox_recheck_uses_lightweight_loopback_liveness(self):
        with tempfile.TemporaryDirectory() as td:
            paths = DeploymentPaths.from_root(
                Path(td),
                data_dir=Path(td) / "state",
            )
            paths.data_dir.mkdir(parents=True)
            manager = DeploymentManager(paths, runner=RecordingDeployRunner())
            runtime = mock.Mock()
            runtime._managed_camofox_enabled.return_value = True
            runtime._effective_camofox_url.return_value = "http://localhost:9377"

            with (
                mock.patch(
                    "enterprise_agent_platform.deployment.PlatformRuntimeManager",
                    return_value=runtime,
                ),
                mock.patch(
                    "enterprise_agent_platform.deployment._probe_camofox_service_health",
                    side_effect=[False, True],
                ) as probe,
                mock.patch("enterprise_agent_platform.deployment.time.sleep"),
            ):
                ready = manager._wait_for_camofox_liveness_http(
                    host="127.0.0.1",
                    port=8765,
                    deadline=time.monotonic() + 30,
                )

            self.assertTrue(ready)
            self.assertEqual(probe.call_count, 2)
            probe.assert_called_with("http://127.0.0.1:9377/health")
            runtime._probe_camofox_capability.assert_not_called()
            runtime.close.assert_called_once_with()

    def test_search_readiness_uses_platform_owned_health_for_managed_and_external_modes(self):
        with tempfile.TemporaryDirectory() as td:
            paths = DeploymentPaths.from_root(
                Path(td),
                data_dir=Path(td) / "state",
            )
            manager = DeploymentManager(paths, runner=RecordingDeployRunner())
            with (
                mock.patch.dict(
                    os.environ,
                    {
                        "ENTERPRISE_MANAGE_SEARXNG": "1",
                        "ENTERPRISE_SEARXNG_API_URL": "http://127.0.0.1:14567",
                    },
                ),
                mock.patch(
                    "enterprise_agent_platform.deployment._probe_json_health",
                    side_effect=[False, True],
                ) as probe,
                mock.patch("enterprise_agent_platform.deployment.time.sleep"),
            ):
                ready = manager._wait_for_searxng_http(
                    host="127.0.0.1",
                    port=8765,
                    deadline=time.monotonic() + 30,
                )

            self.assertTrue(ready)
            self.assertEqual(
                probe.call_args_list,
                [
                    mock.call(
                        "http://127.0.0.1:8765/healthz/search",
                        expected_service="ubitech-agent-search",
                    ),
                    mock.call(
                        "http://127.0.0.1:8765/healthz/search",
                        expected_service="ubitech-agent-search",
                    ),
                ],
            )

            with (
                mock.patch.dict(
                    os.environ,
                    {"ENTERPRISE_MANAGE_SEARXNG": "0"},
                ),
                mock.patch(
                    "enterprise_agent_platform.deployment._probe_json_health",
                    return_value=True,
                ) as external_probe,
            ):
                self.assertTrue(
                    manager._wait_for_searxng_http(
                        host="127.0.0.1",
                        port=8765,
                        deadline=time.monotonic(),
                    )
                )
            external_probe.assert_called_once_with(
                "http://127.0.0.1:8765/healthz/search",
                expected_service="ubitech-agent-search",
            )

            with (
                mock.patch(
                    "enterprise_agent_platform.deployment._probe_json_health",
                    return_value=False,
                ) as unavailable_probe,
            ):
                self.assertFalse(
                    manager._wait_for_searxng_http(
                        host="127.0.0.1",
                        port=8765,
                        deadline=time.monotonic(),
                    )
                )
            unavailable_probe.assert_called_once()

    def test_json_health_bypasses_proxies_only_for_loopback_targets(self):
        payload = b'{"status":"ok","service":"ubitech-agent-runtime"}'

        def response():
            value = mock.MagicMock()
            value.status = 200
            value.headers = {"Content-Type": "application/json"}
            value.read.return_value = payload
            value.__enter__.return_value = value
            return value

        with (
            mock.patch(
                "enterprise_agent_platform.deployment.open_loopback_url",
                return_value=response(),
            ) as loopback_open,
            mock.patch(
                "enterprise_agent_platform.deployment.urllib.request.urlopen",
            ) as external_open,
        ):
            self.assertTrue(
                _probe_json_health(
                    "http://127.0.0.1:8766/health",
                    expected_service="ubitech-agent-runtime",
                )
            )
        loopback_open.assert_called_once()
        external_open.assert_not_called()

        with (
            mock.patch(
                "enterprise_agent_platform.deployment.open_loopback_url",
            ) as loopback_open,
            mock.patch(
                "enterprise_agent_platform.deployment.urllib.request.urlopen",
                return_value=response(),
            ) as external_open,
        ):
            self.assertTrue(
                _probe_json_health(
                    "https://runtime.example.test/health",
                    expected_service="ubitech-agent-runtime",
                )
            )
        loopback_open.assert_not_called()
        external_open.assert_called_once()

    def test_existing_service_data_directory_is_discovered_from_unit(self):
        with tempfile.TemporaryDirectory() as td:
            xdg = Path(td)
            unit_dir = xdg / "systemd" / "user"
            unit_dir.mkdir(parents=True)
            custom = Path(td) / "custom state"
            (unit_dir / "custom.service").write_text(
                '[Service]\nEnvironment="ENTERPRISE_PLATFORM_DATA=' + str(custom) + '"\n',
                encoding="utf-8",
            )

            with mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": str(xdg)}):
                discovered = _existing_service_data_dir("custom.service")

            self.assertEqual(discovered, custom.resolve())

    def test_existing_service_deployment_discovers_unique_custom_service(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            root = base / "checkout"
            xdg = base / "config"
            unit_dir = xdg / "systemd" / "user"
            unit_dir.mkdir(parents=True)
            custom = base / "custom state"
            (unit_dir / "ubitech-custom.service").write_text(
                "[Service]\n"
                f"WorkingDirectory={root / 'enterprise-agent-platform'}\n"
                f'Environment="ENTERPRISE_PLATFORM_DATA={custom}"\n',
                encoding="utf-8",
            )
            (unit_dir / "unrelated.service").write_text(
                "[Service]\nWorkingDirectory=/srv/other\n",
                encoding="utf-8",
            )

            with mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": str(xdg)}):
                discovered = _resolve_existing_service_deployment(
                    root,
                    requested_service=None,
                    requested_data=None,
                )

            self.assertEqual(discovered.service_name, "ubitech-custom.service")
            self.assertEqual(discovered.data_dir, custom.resolve())

    def test_existing_service_deployment_rejects_ambiguous_matches(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            root = base / "checkout"
            xdg = base / "config"
            unit_dir = xdg / "systemd" / "user"
            unit_dir.mkdir(parents=True)
            for name in ("first.service", "second.service"):
                (unit_dir / name).write_text(
                    "[Service]\n"
                    f"WorkingDirectory={root / 'enterprise-agent-platform'}\n",
                    encoding="utf-8",
                )

            with mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": str(xdg)}):
                with self.assertRaisesRegex(DeploymentError, "multiple platform user services"):
                    _resolve_existing_service_deployment(
                        root,
                        requested_service=None,
                        requested_data=None,
                    )

    def test_existing_service_discovery_ignores_symlink_units(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            root = base / "checkout"
            xdg = base / "config"
            unit_dir = xdg / "systemd" / "user"
            unit_dir.mkdir(parents=True)
            target = base / "outside.service"
            target.write_text(
                "[Service]\n"
                f"WorkingDirectory={root / 'enterprise-agent-platform'}\n",
                encoding="utf-8",
            )
            (unit_dir / "linked.service").symlink_to(target)

            with mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": str(xdg)}):
                discovered = _resolve_existing_service_deployment(
                    root,
                    requested_service=None,
                    requested_data=None,
                )

            self.assertEqual(discovered.service_name, "enterprise-agent-platform.service")
            self.assertIsNone(discovered.data_dir)

    def test_agent_artifact_prepare_does_not_contend_for_platform_lock(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            make_deploy_root(root)
            paths = DeploymentPaths.from_root(root, data_dir=root / "state")
            paths.data_dir.mkdir(parents=True)
            lock_path = paths.data_dir / ".enterprise-platform.lock"
            descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            runtime = mock.Mock()
            installed = SimpleNamespace(
                available=True,
                managed=True,
                error="",
                to_dict=lambda: {"available": True, "install_state": "ready"},
            )
            runtime.install_agent_runtime.return_value = installed
            runtime.install_camofox.return_value = installed
            runtime._managed_camofox_enabled.return_value = True
            runtime._effective_camofox_command.return_value = "custom-camofox"
            try:
                with mock.patch(
                    "enterprise_agent_platform.deployment.PlatformRuntimeManager",
                    return_value=runtime,
                ):
                    status = DeploymentManager(paths).prepare_agent_runtime_artifact(
                        host="127.0.0.1",
                        port=8765,
                    )
            finally:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
                os.close(descriptor)

            self.assertTrue(status["available"])
            runtime.install_agent_runtime.assert_called_once_with(force=False)
            runtime.install_camofox.assert_called_once_with(force=False)
            runtime.prepare.assert_not_called()
            runtime.close.assert_called_once_with()

    def test_artifact_prepare_skips_camofox_dependencies_when_management_is_disabled(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            make_deploy_root(root)
            paths = DeploymentPaths.from_root(root, data_dir=root / "state")
            paths.data_dir.mkdir(parents=True)
            runtime = mock.Mock()
            agent = SimpleNamespace(
                available=True,
                managed=True,
                error="",
                to_dict=lambda: {"available": True},
            )
            external_camofox = SimpleNamespace(
                available=False,
                managed=False,
                error="",
                to_dict=lambda: {"available": False, "managed": False, "state": "external"},
            )
            runtime.install_agent_runtime.return_value = agent
            runtime.install_camofox.return_value = external_camofox
            runtime._managed_camofox_enabled.return_value = False
            manager = DeploymentManager(paths, runner=RecordingDeployRunner())

            with (
                mock.patch(
                    "enterprise_agent_platform.deployment.PlatformRuntimeManager",
                    return_value=runtime,
                ),
                mock.patch.object(manager, "ensure_camofox_system_dependencies") as dependencies,
            ):
                status = manager.prepare_agent_runtime_artifact(host="127.0.0.1", port=8765)

            self.assertFalse(status["camofox"]["managed"])
            dependencies.assert_not_called()
            runtime.install_camofox.assert_called_once_with(force=False)

    def test_camofox_system_dependencies_do_not_run_apt_when_preflight_passes(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            runner = RecordingDeployRunner()
            manager = DeploymentManager(DeploymentPaths.from_root(root), runner=runner)
            with mock.patch(
                "enterprise_agent_platform.deployment._camofox_system_dependency_problems",
                return_value=[],
            ):
                manager.ensure_camofox_system_dependencies()
            self.assertEqual(runner.calls, [])

    def test_camofox_system_dependency_preflight_executes_xvfb(self):
        def fake_which(name):
            return {
                "Xvfb": "/usr/bin/Xvfb",
                "fc-match": "/usr/bin/fc-match",
            }.get(name)

        def fake_command_succeeds(cmd, **_kwargs):
            return cmd != ["/usr/bin/Xvfb", "-help"]

        with (
            mock.patch(
                "enterprise_agent_platform.deployment.shutil.which",
                side_effect=fake_which,
            ),
            mock.patch(
                "enterprise_agent_platform.deployment._command_succeeds",
                side_effect=fake_command_succeeds,
            ) as command,
        ):
            problems = _camofox_system_dependency_problems(None)

        self.assertEqual(problems, ["working Xvfb runtime"])
        self.assertIn(mock.call(["/usr/bin/Xvfb", "-help"]), command.call_args_list)

    def test_camofox_system_dependencies_install_only_after_failed_preflight(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            runner = RecordingDeployRunner()
            manager = DeploymentManager(DeploymentPaths.from_root(root), runner=runner)
            with (
                mock.patch(
                    "enterprise_agent_platform.deployment._camofox_system_dependency_problems",
                    side_effect=[["Xvfb executable"], []],
                ),
                mock.patch(
                    "enterprise_agent_platform.deployment.apt_get_command_base",
                    return_value=["/usr/bin/apt-get"],
                ),
            ):
                manager.ensure_camofox_system_dependencies()

            commands = [call["cmd"] for call in runner.calls]
            self.assertEqual(commands[0], ["/usr/bin/apt-get", "update"])
            self.assertEqual(commands[1][:4], ["/usr/bin/apt-get", "install", "-y", "--no-install-recommends"])
            self.assertIn("xvfb", commands[1])
            self.assertIn("fontconfig", commands[1])

    def test_camofox_system_dependencies_use_noninteractive_sudo_without_a_tty(self):
        with tempfile.TemporaryDirectory() as td:
            runner = RecordingDeployRunner()
            manager = DeploymentManager(
                DeploymentPaths.from_root(Path(td)),
                runner=runner,
            )

            def fake_which(name):
                if name in {"apt-get", "sudo"}:
                    return f"/usr/bin/{name}"
                return None

            with (
                mock.patch(
                    "enterprise_agent_platform.deployment._camofox_system_dependency_problems",
                    side_effect=[["Xvfb executable"], []],
                ),
                mock.patch(
                    "enterprise_agent_platform.deployment.shutil.which",
                    side_effect=fake_which,
                ),
                mock.patch(
                    "enterprise_agent_platform.deployment.os.geteuid",
                    return_value=1000,
                ),
                mock.patch(
                    "enterprise_agent_platform.deployment.sys.stdin",
                    SimpleNamespace(isatty=lambda: False),
                ),
            ):
                manager.ensure_camofox_system_dependencies()

            commands = [call["cmd"] for call in runner.calls]
            self.assertEqual(
                commands[0],
                ["/usr/bin/sudo", "-n", "/usr/bin/apt-get", "update"],
            )
            self.assertEqual(
                commands[1][:6],
                [
                    "/usr/bin/sudo",
                    "-n",
                    "/usr/bin/apt-get",
                    "install",
                    "-y",
                    "--no-install-recommends",
                ],
            )

    def test_apt_uses_interactive_sudo_when_a_tty_is_available(self):
        def fake_which(name):
            if name in {"apt-get", "sudo"}:
                return f"/usr/bin/{name}"
            return None

        with (
            mock.patch.dict(os.environ, {"ENTERPRISE_DEPLOY_AUTO_APT": "1"}),
            mock.patch(
                "enterprise_agent_platform.deployment.shutil.which",
                side_effect=fake_which,
            ),
            mock.patch(
                "enterprise_agent_platform.deployment.os.geteuid",
                return_value=1000,
            ),
            mock.patch(
                "enterprise_agent_platform.deployment.sys.stdin",
                SimpleNamespace(isatty=lambda: True),
            ),
        ):
            command = apt_get_command_base()

        self.assertEqual(command, ["/usr/bin/sudo", "/usr/bin/apt-get"])

    def test_apt_uses_noninteractive_sudo_when_no_tty_is_available(self):
        def fake_which(name):
            if name in {"apt-get", "sudo"}:
                return f"/usr/bin/{name}"
            return None

        with (
            mock.patch.dict(os.environ, {"ENTERPRISE_DEPLOY_AUTO_APT": "1"}),
            mock.patch(
                "enterprise_agent_platform.deployment.shutil.which",
                side_effect=fake_which,
            ),
            mock.patch(
                "enterprise_agent_platform.deployment.os.geteuid",
                return_value=1000,
            ),
            mock.patch(
                "enterprise_agent_platform.deployment.sys.stdin",
                SimpleNamespace(isatty=lambda: False),
            ),
        ):
            command = apt_get_command_base()

        self.assertEqual(command, ["/usr/bin/sudo", "-n", "/usr/bin/apt-get"])

    def test_camofox_system_dependencies_fall_back_to_ubuntu_t64_packages(self):
        with tempfile.TemporaryDirectory() as td:
            runner = mock.Mock()
            runner.run.side_effect = [
                subprocess.CompletedProcess(["apt-get", "update"], 0),
                subprocess.CompletedProcess(["apt-get", "install"], 100),
                subprocess.CompletedProcess(["apt-get", "install"], 0),
            ]
            manager = DeploymentManager(
                DeploymentPaths.from_root(Path(td)),
                runner=runner,
            )
            with (
                mock.patch(
                    "enterprise_agent_platform.deployment._camofox_system_dependency_problems",
                    side_effect=[["managed browser loader/runtime libraries"], []],
                ),
                mock.patch(
                    "enterprise_agent_platform.deployment.apt_get_command_base",
                    return_value=["/usr/bin/apt-get"],
                ),
            ):
                manager.ensure_camofox_system_dependencies()

            commands = [call.args[0] for call in runner.run.call_args_list]
            self.assertIn("libgtk-3-0", commands[1])
            self.assertIn("libasound2", commands[1])
            self.assertNotIn("libgtk-3-0t64", commands[1])
            self.assertIn("libgtk-3-0t64", commands[2])
            self.assertIn("libasound2t64", commands[2])
            self.assertNotIn("libgtk-3-0", commands[2])

    def test_camofox_system_dependencies_fail_when_postinstall_preflight_still_fails(self):
        with tempfile.TemporaryDirectory() as td:
            browser = Path(td) / "camoufox"
            runner = RecordingDeployRunner()
            manager = DeploymentManager(
                DeploymentPaths.from_root(Path(td)),
                runner=runner,
            )
            preflight = mock.Mock(
                side_effect=[
                    ["managed browser loader/runtime libraries"],
                    ["libxul.so: libgtk-3.so.0 => not found"],
                ]
            )
            with (
                mock.patch(
                    "enterprise_agent_platform.deployment._camofox_system_dependency_problems",
                    preflight,
                ),
                mock.patch(
                    "enterprise_agent_platform.deployment.apt_get_command_base",
                    return_value=["/usr/bin/apt-get"],
                ),
                self.assertRaisesRegex(DeploymentError, "libgtk-3.so.0 => not found"),
            ):
                manager.ensure_camofox_system_dependencies(browser_executable=browser)

            self.assertEqual(preflight.call_args_list, [mock.call(browser), mock.call(browser)])

    def test_camofox_system_dependency_error_is_actionable_without_apt(self):
        with tempfile.TemporaryDirectory() as td:
            manager = DeploymentManager(
                DeploymentPaths.from_root(Path(td)),
                runner=RecordingDeployRunner(),
            )
            raised = self.assertRaisesRegex(DeploymentError, "sudo apt update")
            with (
                mock.patch(
                    "enterprise_agent_platform.deployment._camofox_system_dependency_problems",
                    return_value=["Xvfb executable", "fontconfig (fc-match)"],
                ),
                mock.patch(
                    "enterprise_agent_platform.deployment.apt_get_command_base",
                    return_value=None,
                ),
                raised,
            ):
                manager.ensure_camofox_system_dependencies()

            self.assertIn("libgtk-3-0t64", str(raised.exception))
            self.assertIn("libasound2t64", str(raised.exception))

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

    def test_runtime_env_exposes_managed_sources(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            paths = DeploymentPaths.from_root(root)

            with mock.patch.dict(
                os.environ,
                {
                    "ENTERPRISE_MANAGE_SEARXNG": "0",
                    "ENTERPRISE_SEARXNG_API_URL": "http://127.0.0.1:14567",
                    "ENTERPRISE_SEARXNG_TIMEOUT_SECONDS": "7.5",
                    "ENTERPRISE_SEARXNG_STARTUP_WAIT_SECONDS": "420",
                },
            ):
                env = runtime_env(paths, host="127.0.0.1", port=9999)

            self.assertEqual(env["ENTERPRISE_AGENT_RUNTIME_HOME"], str(paths.data_dir / "runtimes" / "agent"))
            self.assertEqual(env["ENTERPRISE_MANAGE_COGNEE"], "1")
            self.assertEqual(env["ENTERPRISE_COGNEE_REPO"], str(paths.cognee_repo))
            self.assertEqual(env["ENTERPRISE_MANAGE_FIRECRAWL"], "1")
            self.assertEqual(env["ENTERPRISE_FIRECRAWL_REPO"], str(paths.firecrawl_repo))
            self.assertEqual(env["ENTERPRISE_MANAGE_SEARXNG"], "0")
            self.assertEqual(
                env["ENTERPRISE_SEARXNG_API_URL"],
                "http://127.0.0.1:14567",
            )
            self.assertEqual(env["ENTERPRISE_SEARXNG_TIMEOUT_SECONDS"], "7.5")
            self.assertEqual(env["ENTERPRISE_SEARXNG_STARTUP_WAIT_SECONDS"], "420")
            self.assertEqual(env["ENTERPRISE_PLATFORM_PORT"], "9999")

    def test_runtime_env_preserves_disabled_external_repositories(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            paths = DeploymentPaths.from_root(root, data_dir=root / "state")
            external_cognee = root / "external-cognee"
            external_firecrawl = root / "external-firecrawl"

            with mock.patch.dict(
                os.environ,
                {
                    "ENTERPRISE_MANAGE_COGNEE": "0",
                    "ENTERPRISE_COGNEE_REPO": str(external_cognee),
                    "ENTERPRISE_MANAGE_FIRECRAWL": "0",
                    "ENTERPRISE_FIRECRAWL_REPO": str(external_firecrawl),
                },
                clear=False,
            ):
                env = runtime_env(paths, host="127.0.0.1", port=8765)

            self.assertEqual(env["ENTERPRISE_MANAGE_COGNEE"], "0")
            self.assertEqual(env["ENTERPRISE_COGNEE_REPO"], str(external_cognee))
            self.assertEqual(env["ENTERPRISE_MANAGE_FIRECRAWL"], "0")
            self.assertEqual(
                env["ENTERPRISE_FIRECRAWL_REPO"], str(external_firecrawl)
            )

    def test_runtime_env_managed_sources_use_persisted_settings_before_environment(self):
        cases = (
            (
                "persisted enabled pins managed repositories",
                "1",
                "0",
                True,
            ),
            (
                "persisted disabled preserves external repositories",
                "0",
                "1",
                False,
            ),
        )
        for label, persisted, environment, expected_managed in cases:
            with self.subTest(label=label), tempfile.TemporaryDirectory() as td:
                root = Path(td)
                paths = DeploymentPaths.from_root(root, data_dir=root / "state")
                external_cognee = root / "external-cognee"
                external_firecrawl = root / "external-firecrawl"
                write_platform_settings(
                    paths.data_dir,
                    {
                        "cognee_manage": persisted,
                        "firecrawl_manage": persisted,
                    },
                )

                with mock.patch.dict(
                    os.environ,
                    {
                        "ENTERPRISE_MANAGE_COGNEE": environment,
                        "ENTERPRISE_COGNEE_REPO": str(external_cognee),
                        "ENTERPRISE_MANAGE_FIRECRAWL": environment,
                        "ENTERPRISE_FIRECRAWL_REPO": str(external_firecrawl),
                    },
                    clear=True,
                ):
                    env = runtime_env(paths, host="127.0.0.1", port=8765)

                expected_cognee = paths.cognee_repo if expected_managed else external_cognee
                expected_firecrawl = (
                    paths.firecrawl_repo if expected_managed else external_firecrawl
                )
                self.assertEqual(
                    env["ENTERPRISE_MANAGE_COGNEE"],
                    "1" if expected_managed else "0",
                )
                self.assertEqual(env["ENTERPRISE_COGNEE_REPO"], str(expected_cognee))
                self.assertEqual(
                    env["ENTERPRISE_MANAGE_FIRECRAWL"],
                    "1" if expected_managed else "0",
                )
                self.assertEqual(
                    env["ENTERPRISE_FIRECRAWL_REPO"], str(expected_firecrawl)
                )

                with mock.patch.dict(os.environ, env, clear=True):
                    config = PlatformConfig.from_env(root)

                self.assertEqual(config.manage_cognee, expected_managed)
                self.assertEqual(config.cognee_repo, expected_cognee)
                self.assertEqual(config.manage_firecrawl, expected_managed)
                self.assertEqual(config.firecrawl_repo, expected_firecrawl)

                with mock.patch.dict(
                    os.environ,
                    {
                        "ENTERPRISE_MANAGE_COGNEE": environment,
                        "ENTERPRISE_COGNEE_REPO": str(external_cognee),
                        "ENTERPRISE_MANAGE_FIRECRAWL": environment,
                        "ENTERPRISE_FIRECRAWL_REPO": str(external_firecrawl),
                    },
                    clear=True,
                ):
                    deployment_config = DeploymentManager(
                        paths,
                        runner=RecordingDeployRunner(),
                    )._platform_config(host="127.0.0.1", port=8765)

                self.assertEqual(deployment_config.manage_cognee, expected_managed)
                self.assertEqual(deployment_config.cognee_repo, expected_cognee)
                self.assertEqual(deployment_config.manage_firecrawl, expected_managed)
                self.assertEqual(deployment_config.firecrawl_repo, expected_firecrawl)

    def test_runtime_env_normalizes_empty_searxng_values_consistently(self):
        with tempfile.TemporaryDirectory() as td:
            paths = DeploymentPaths.from_root(Path(td))
            with mock.patch.dict(
                os.environ,
                {
                    "ENTERPRISE_MANAGE_SEARXNG": "",
                    "ENTERPRISE_SEARXNG_API_URL": " ",
                    "ENTERPRISE_SEARXNG_TIMEOUT_SECONDS": "",
                    "ENTERPRISE_SEARXNG_STARTUP_WAIT_SECONDS": " ",
                },
            ):
                env = runtime_env(paths, host="127.0.0.1", port=8765)

            self.assertEqual(env["ENTERPRISE_MANAGE_SEARXNG"], "0")
            self.assertEqual(
                env["ENTERPRISE_SEARXNG_API_URL"],
                "http://127.0.0.1:13003",
            )
            self.assertEqual(env["ENTERPRISE_SEARXNG_TIMEOUT_SECONDS"], "20")
            self.assertEqual(
                env["ENTERPRISE_SEARXNG_STARTUP_WAIT_SECONDS"],
                "300",
            )

    def test_searxng_ready_timeout_is_configurable_with_safe_default(self):
        with mock.patch.dict(
            os.environ,
            {"ENTERPRISE_SEARXNG_STARTUP_WAIT_SECONDS": "420"},
        ):
            self.assertEqual(searxng_ready_timeout_seconds(), 420)
        for invalid in ("0", "-1", "not-a-number"):
            with self.subTest(invalid=invalid), mock.patch.dict(
                os.environ,
                {"ENTERPRISE_SEARXNG_STARTUP_WAIT_SECONDS": invalid},
            ):
                self.assertEqual(searxng_ready_timeout_seconds(), 300)

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

    def test_ordinary_deploy_modes_check_docs_and_changes_before_bootstrap(self):
        source_script = Path(__file__).resolve().parents[2] / "deploy.sh"
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            shutil.copy2(source_script, root / "deploy.sh")
            fake_python = root / "fake-python"
            fake_python.write_text(
                """#!/bin/sh
case "${1:-}" in
  */scripts/docs_sync.py)
    printf 'docs:%s\\n' "${2:-}" >> "$FAKE_DEPLOY_EVENTS"
    if [ "${2:-}" = "check-change" ]; then
      exit "${FAKE_DOCS_CHANGE_EXIT:-${FAKE_DOCS_EXIT:-0}}"
    fi
    exit "${FAKE_DOCS_EXIT:-0}"
    ;;
esac
mode=''
previous=''
for argument in "$@"; do
  if [ "$previous" = '--mode' ]; then
    mode="$argument"
    break
  fi
  previous="$argument"
done
printf 'bootstrap:%s\\n' "$mode" >> "$FAKE_DEPLOY_EVENTS"
exit 0
""",
                encoding="utf-8",
            )
            fake_python.chmod(0o755)

            for command, expected_mode in (
                ("deploy", "auto"),
                ("up", "auto"),
                ("service", "service"),
                ("foreground", "foreground"),
                ("prepare", "prepare"),
            ):
                with self.subTest(command=command):
                    event_log = root / f"{command}.log"
                    env = os.environ.copy()
                    env.update(
                        {
                            "PYTHON_BIN": str(fake_python),
                            "FAKE_DEPLOY_EVENTS": str(event_log),
                        }
                    )
                    result = subprocess.run(
                        ["bash", str(root / "deploy.sh"), command],
                        cwd=root,
                        env=env,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        text=True,
                        check=False,
                    )

                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(
                        event_log.read_text(encoding="utf-8").splitlines(),
                        [
                            "docs:check",
                            "docs:check-change",
                            "docs:check-change",
                            "docs:check-change",
                            f"bootstrap:{expected_mode}",
                        ],
                    )

            failed_log = root / "failed-docs.log"
            failed_env = os.environ.copy()
            failed_env.update(
                {
                    "PYTHON_BIN": str(fake_python),
                    "FAKE_DEPLOY_EVENTS": str(failed_log),
                    "FAKE_DOCS_EXIT": "1",
                }
            )
            failed = subprocess.run(
                ["bash", str(root / "deploy.sh"), "deploy"],
                cwd=root,
                env=failed_env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )

            self.assertNotEqual(failed.returncode, 0)
            self.assertEqual(
                failed_log.read_text(encoding="utf-8").splitlines(),
                ["docs:check"],
            )

            failed_change_log = root / "failed-docs-change.log"
            failed_change_env = os.environ.copy()
            failed_change_env.update(
                {
                    "PYTHON_BIN": str(fake_python),
                    "FAKE_DEPLOY_EVENTS": str(failed_change_log),
                    "FAKE_DOCS_CHANGE_EXIT": "1",
                }
            )
            failed_change = subprocess.run(
                ["bash", str(root / "deploy.sh"), "deploy"],
                cwd=root,
                env=failed_change_env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )

            self.assertNotEqual(failed_change.returncode, 0)
            self.assertEqual(
                failed_change_log.read_text(encoding="utf-8").splitlines(),
                ["docs:check", "docs:check-change"],
            )

    def test_deploy_test_checks_commits_worktree_runtime_and_frontend(self):
        if not shutil.which("git"):
            self.skipTest("git is not available")
        source_script = Path(__file__).resolve().parents[2] / "deploy.sh"
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            root = base / "checkout"
            root.mkdir()
            shutil.copy2(source_script, root / "deploy.sh")
            (root / "scripts").mkdir()
            (root / "scripts" / "docs_sync.py").write_text("# fake\n", encoding="utf-8")
            platform = root / "enterprise-agent-platform"
            runtime = platform / "agent-runtime"
            frontend = platform / "frontend"
            runtime.mkdir(parents=True)
            frontend.mkdir()
            (runtime / "package.json").write_text("{}\n", encoding="utf-8")
            (frontend / "package.json").write_text("{}\n", encoding="utf-8")
            tracked = root / "tracked.txt"
            tracked.write_text("base\n", encoding="utf-8")

            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            subprocess.run(["git", "checkout", "-q", "-b", "main"], cwd=root, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=root, check=True)
            subprocess.run(["git", "config", "user.name", "Deploy Test"], cwd=root, check=True)
            subprocess.run(["git", "add", "."], cwd=root, check=True)
            subprocess.run(["git", "commit", "-q", "-m", "base"], cwd=root, check=True)
            upstream_sha = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=root, text=True
            ).strip()

            remote = base / "remote.git"
            subprocess.run(["git", "init", "-q", "--bare", str(remote)], check=True)
            subprocess.run(["git", "remote", "add", "origin", str(remote)], cwd=root, check=True)
            subprocess.run(["git", "push", "-q", "-u", "origin", "main"], cwd=root, check=True)

            for index in (1, 2):
                tracked.write_text(f"local-{index}\n", encoding="utf-8")
                subprocess.run(["git", "add", "tracked.txt"], cwd=root, check=True)
                subprocess.run(["git", "commit", "-q", "-m", f"local {index}"], cwd=root, check=True)
            parent_sha = subprocess.check_output(
                ["git", "rev-parse", "HEAD^"], cwd=root, text=True
            ).strip()

            tools = base / "tools"
            tools.mkdir()
            python_log = base / "python.log"
            npm_log = base / "npm.log"
            fake_python = tools / "python"
            fake_python.write_text(
                "#!/bin/sh\nprintf '%s|%s\\n' \"$PWD\" \"$*\" >> \"$FAKE_PYTHON_LOG\"\n",
                encoding="utf-8",
            )
            fake_node = tools / "node"
            fake_node.write_text("#!/bin/sh\nprintf '22.19.0\\n'\n", encoding="utf-8")
            fake_npm = tools / "npm"
            fake_npm.write_text(
                "#!/bin/sh\nprintf '%s|%s\\n' \"$PWD\" \"$*\" >> \"$FAKE_NPM_LOG\"\n",
                encoding="utf-8",
            )
            for executable in (fake_python, fake_node, fake_npm):
                executable.chmod(0o755)
            env = os.environ.copy()
            env.update(
                {
                    "PATH": f"{tools}{os.pathsep}{env.get('PATH', '')}",
                    "PYTHON_BIN": str(fake_python),
                    "FAKE_PYTHON_LOG": str(python_log),
                    "FAKE_NPM_LOG": str(npm_log),
                }
            )

            def run_test_and_assert_base(expected_base: str) -> None:
                python_log.unlink(missing_ok=True)
                npm_log.unlink(missing_ok=True)
                result = subprocess.run(
                    ["bash", str(root / "deploy.sh"), "test"],
                    cwd=root,
                    env=env,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                python_calls = python_log.read_text(encoding="utf-8").splitlines()
                self.assertEqual(
                    python_calls[:4],
                    [
                        f"{root}|{root / 'scripts' / 'docs_sync.py'} check",
                        f"{root}|{root / 'scripts' / 'docs_sync.py'} check-change --base {expected_base} --head HEAD",
                        f"{root}|{root / 'scripts' / 'docs_sync.py'} check-change --base HEAD --head INDEX",
                        f"{root}|{root / 'scripts' / 'docs_sync.py'} check-change --base HEAD --head WORKTREE",
                    ],
                )
                self.assertEqual(
                    python_calls[4:],
                    [
                        f"{platform}|-m unittest discover -s tests",
                        f"{platform}|-m compileall enterprise_agent_platform tests",
                    ],
                )
                self.assertEqual(
                    npm_log.read_text(encoding="utf-8").splitlines(),
                    [
                        f"{runtime}|ci",
                        f"{runtime}|run check",
                        f"{runtime}|test",
                        f"{runtime}|run build",
                        f"{frontend}|ci",
                        f"{frontend}|run check",
                        f"{frontend}|test",
                        f"{frontend}|run build",
                    ],
                )

            # A branch ahead of upstream uses their merge-base, covering the
            # complete unpublished series rather than only the tip commit.
            run_test_and_assert_base(upstream_sha)

            # Once upstream is synchronized there is no merge-base diff, so
            # the gate must still inspect HEAD^..HEAD on a clean worktree.
            subprocess.run(["git", "push", "-q", "origin", "main"], cwd=root, check=True)
            run_test_and_assert_base(parent_sha)

    def test_deploy_script_prefers_managed_node_before_runtime_check(self):
        source_script = Path(__file__).resolve().parents[2] / "deploy.sh"
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            shutil.copy2(source_script, root / "deploy.sh")
            managed_bin = root / "enterprise-agent-platform" / "data" / "runtimes" / "node" / "current" / "bin"
            managed_bin.mkdir(parents=True)
            marker = root / "managed-node-used.txt"
            (managed_bin / "node").write_text(
                "#!/bin/sh\nprintf 'managed\\n' >> \"$FAKE_NODE_MARKER\"\nprintf '22.19.0\\n'\n",
                encoding="utf-8",
            )
            (managed_bin / "npm").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            fake_python = root / "python"
            event_log = root / "deploy-events.txt"
            fake_python.write_text(
                """#!/bin/sh
case "${1:-}" in
  */scripts/docs_sync.py)
    printf 'docs:%s\\n' "${2:-}" >> "$FAKE_DEPLOY_EVENTS"
    exit 0
    ;;
esac
printf 'bootstrap\\n' >> "$FAKE_DEPLOY_EVENTS"
node --version >/dev/null
""",
                encoding="utf-8",
            )
            for executable in (managed_bin / "node", managed_bin / "npm", fake_python):
                executable.chmod(0o755)
            env = os.environ.copy()
            env.update(
                {
                    "PYTHON_BIN": str(fake_python),
                    "FAKE_NODE_MARKER": str(marker),
                    "FAKE_DEPLOY_EVENTS": str(event_log),
                }
            )

            result = subprocess.run(
                ["bash", str(root / "deploy.sh"), "prepare"],
                cwd=root,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(marker.read_text(encoding="utf-8"), "managed\n")
            self.assertEqual(
                event_log.read_text(encoding="utf-8").splitlines(),
                [
                    "docs:check",
                    "docs:check-change",
                    "docs:check-change",
                    "docs:check-change",
                    "bootstrap",
                ],
            )

    def test_deploy_update_refuses_a_second_concurrent_update(self):
        if not shutil.which("git") or not shutil.which("flock"):
            self.skipTest("git and flock are required")
        source_script = Path(__file__).resolve().parents[2] / "deploy.sh"
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            shutil.copy2(source_script, root / "deploy.sh")
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=root, check=True)
            subprocess.run(["git", "config", "user.name", "Deploy Test"], cwd=root, check=True)
            subprocess.run(["git", "add", "deploy.sh"], cwd=root, check=True)
            subprocess.run(["git", "commit", "-q", "-m", "initial"], cwd=root, check=True)
            lock_file = root / ".git" / "ubitech-agent-update.lock"
            lock_fd = lock_file.open("w")
            fcntl.flock(lock_fd.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                result = subprocess.run(
                    ["bash", str(root / "deploy.sh"), "update"],
                    cwd=root,
                    env=os.environ.copy(),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    check=False,
                )
            finally:
                fcntl.flock(lock_fd.fileno(), fcntl.LOCK_UN)
                lock_fd.close()

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("update is already in progress", result.stderr)

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


    def test_deploy_update_fast_forwards_to_upstream(self):
        if not shutil.which("git") or not shutil.which("flock"):
            self.skipTest("git and flock are required")
        source_script = Path(__file__).resolve().parents[2] / "deploy.sh"
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            checkout, old_sha, new_sha = make_update_checkout(base, source_script)
            fake_python = make_fake_deploy_python(base)
            deploy_log = base / "deploy.log"
            docs_log = base / "docs.log"
            env = os.environ.copy()
            env.update(
                {
                    "PYTHON_BIN": str(fake_python),
                    "FAKE_DEPLOY_LOG": str(deploy_log),
                    "FAKE_DOCS_LOG": str(docs_log),
                }
            )

            result = subprocess.run(
                ["bash", str(checkout / "deploy.sh"), "update"],
                cwd=checkout,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=checkout, text=True).strip(),
                new_sha,
            )
            self.assertEqual((checkout / "version.txt").read_text(encoding="utf-8"), "new\n")
            self.assertEqual(deploy_log.read_text(encoding="utf-8").splitlines(), ["new"])
            self.assertEqual(
                docs_log.read_text(encoding="utf-8").splitlines(),
                [
                    "new:check",
                    f"new:check-change:--base:{old_sha}:--head:HEAD",
                ],
            )

    def test_failed_update_documentation_gate_uses_existing_rollback(self):
        if not shutil.which("git") or not shutil.which("flock"):
            self.skipTest("git and flock are required")
        source_script = Path(__file__).resolve().parents[2] / "deploy.sh"
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            checkout, old_sha, _ = make_update_checkout(base, source_script)
            fake_python = make_fake_deploy_python(base)
            deploy_log = base / "deploy.log"
            docs_log = base / "docs.log"
            env = os.environ.copy()
            env.update(
                {
                    "PYTHON_BIN": str(fake_python),
                    "FAKE_DEPLOY_LOG": str(deploy_log),
                    "FAKE_DOCS_LOG": str(docs_log),
                    "FAKE_FAIL_DOCS_MODE": "check-change",
                }
            )

            result = subprocess.run(
                ["bash", str(checkout / "deploy.sh"), "update"],
                cwd=checkout,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("failed the canonical documentation gate", result.stderr)
            self.assertIn(f"Rolled back to {old_sha}", result.stderr)
            self.assertEqual(
                subprocess.check_output(
                    ["git", "rev-parse", "HEAD"], cwd=checkout, text=True
                ).strip(),
                old_sha,
            )
            self.assertEqual(
                docs_log.read_text(encoding="utf-8").splitlines(),
                [
                    "new:check",
                    f"new:check-change:--base:{old_sha}:--head:HEAD",
                ],
            )
            # The new version never bootstraps; rollback redeploys only the
            # previously known-good revision, which may predate docs/domains.
            self.assertEqual(
                deploy_log.read_text(encoding="utf-8").splitlines(),
                ["old"],
            )

    def test_failed_update_shell_rollback_restores_preupdate_commit(self):
        if not shutil.which("git") or not shutil.which("flock"):
            self.skipTest("git and flock are required")
        source_script = Path(__file__).resolve().parents[2] / "deploy.sh"
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            checkout, old_sha, _ = make_update_checkout(base, source_script)
            fake_python = make_fake_deploy_python(base)
            deploy_log = base / "deploy.log"
            env = os.environ.copy()
            env.update(
                {
                    "PYTHON_BIN": str(fake_python),
                    "FAKE_DEPLOY_LOG": str(deploy_log),
                    "FAKE_FAIL_NEW": "1",
                }
            )

            result = subprocess.run(
                ["bash", str(checkout / "deploy.sh"), "update"],
                cwd=checkout,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn(f"Rolled back to {old_sha}", result.stderr)
            self.assertEqual(
                subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=checkout, text=True).strip(),
                old_sha,
            )
            self.assertEqual((checkout / "version.txt").read_text(encoding="utf-8"), "old\n")
            self.assertEqual(deploy_log.read_text(encoding="utf-8").splitlines(), ["new", "old"])

    def test_failed_update_shell_rollback_preserves_new_local_changes(self):
        if not shutil.which("git") or not shutil.which("flock"):
            self.skipTest("git and flock are required")
        source_script = Path(__file__).resolve().parents[2] / "deploy.sh"
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            checkout, _, new_sha = make_update_checkout(base, source_script)
            fake_python = make_fake_deploy_python(base)
            deploy_log = base / "deploy.log"
            env = os.environ.copy()
            env.update(
                {
                    "PYTHON_BIN": str(fake_python),
                    "FAKE_DEPLOY_LOG": str(deploy_log),
                    "FAKE_FAIL_NEW": "1",
                    "FAKE_CREATE_LOCAL_CHANGE": "1",
                }
            )

            result = subprocess.run(
                ["bash", str(checkout / "deploy.sh"), "update"],
                cwd=checkout,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("automatic rollback was refused", result.stderr)
            self.assertEqual(
                subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=checkout, text=True).strip(),
                new_sha,
            )
            self.assertEqual(
                (checkout / "local-after-pull.txt").read_text(encoding="utf-8"),
                "preserve\n",
            )
            self.assertEqual(deploy_log.read_text(encoding="utf-8").splitlines(), ["new"])

    def test_platform_pyproject_supports_editable_install(self):
        pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
        data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
        package_finder = data["tool"]["setuptools"]["packages"]["find"]
        self.assertEqual(package_finder["where"], ["."])
        self.assertEqual(package_finder["include"], ["enterprise_agent_platform*"])
        self.assertNotIn("exclude", package_finder)
        self.assertTrue(package_finder["namespaces"])
        package_data = data["tool"]["setuptools"]["package-data"]
        self.assertEqual(
            package_data["enterprise_agent_platform"],
            ["static/*", "bundled_skills/**/*"],
        )
        excluded_package_data = data["tool"]["setuptools"][
            "exclude-package-data"
        ]
        self.assertEqual(
            excluded_package_data["enterprise_agent_platform"],
            [
                "bundled_skills/**/__pycache__/*",
                "bundled_skills/**/*.pyc",
                "bundled_skills/**/*.pyo",
            ],
        )


if __name__ == "__main__":
    unittest.main()
