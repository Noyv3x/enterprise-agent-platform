from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
import platform
import re
import shlex
import shutil
import sqlite3
import stat
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, replace
from pathlib import Path
from pathlib import PurePosixPath
from typing import Protocol

from .config import PlatformConfig
from .runtimes import PlatformRuntimeManager
from .secure_fs import ensure_private_directory


DEFAULT_SERVICE_NAME = "enterprise-agent-platform.service"
DEFAULT_PIP_INSTALL_ATTEMPTS = 3
DEFAULT_PIP_NETWORK_RETRIES = 8
DEFAULT_PIP_TIMEOUT_SECONDS = 120
DEFAULT_SERVICE_READY_TIMEOUT_SECONDS = 60
DEFAULT_SERVICE_STOP_TIMEOUT_SECONDS = 120
MINIMUM_NODE_VERSION = (22, 19)
MANAGED_NODE_VERSION = "22.19.0"
MAX_MANAGED_NODE_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_EXISTING_SERVICE_UNIT_BYTES = 1024 * 1024
MANAGED_NODE_RELEASES = {
    "x86_64": (
        "linux-x64",
        "c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2",
    ),
    "amd64": (
        "linux-x64",
        "c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2",
    ),
    "aarch64": (
        "linux-arm64",
        "0b2d9f564b6594222a62c82e1df2efe119dd4a4aff29644f4dd325bf360b6bcc",
    ),
    "arm64": (
        "linux-arm64",
        "0b2d9f564b6594222a62c82e1df2efe119dd4a4aff29644f4dd325bf360b6bcc",
    ),
}
CAMOFOX_APT_PACKAGES = (
    "xvfb",
    "fontconfig",
    "fonts-liberation",
    "fonts-noto-color-emoji",
    "libgtk-3-0",
    "libdbus-glib-1-2",
    "libxt6",
    "libasound2",
    "libx11-xcb1",
    "libxcomposite1",
    "libxcursor1",
    "libxdamage1",
    "libxfixes3",
    "libxi6",
    "libxrandr2",
    "libxrender1",
    "libxss1",
    "libxtst6",
    "libegl1-mesa",
    "libgl1-mesa-dri",
    "libgbm1",
    "ca-certificates",
)
CAMOFOX_APT_PACKAGES_T64 = tuple(
    "libgtk-3-0t64" if name == "libgtk-3-0" else
    "libasound2t64" if name == "libasound2" else
    name
    for name in CAMOFOX_APT_PACKAGES
)


class DeploymentError(RuntimeError):
    pass


@dataclass(frozen=True)
class ExistingServiceDeployment:
    service_name: str
    data_dir: Path | None


class CommandRunner(Protocol):
    def run(
        self,
        cmd: list[str],
        *,
        cwd: Path | None = None,
        env: dict[str, str] | None = None,
        timeout: float | None = None,
        check: bool = True,
    ) -> subprocess.CompletedProcess:
        ...


class SubprocessRunner:
    def run(
        self,
        cmd: list[str],
        *,
        cwd: Path | None = None,
        env: dict[str, str] | None = None,
        timeout: float | None = None,
        check: bool = True,
    ) -> subprocess.CompletedProcess:
        print("+ " + " ".join(_quote_arg(part) for part in cmd), flush=True)
        result = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd else None,
            env=env,
            timeout=timeout,
            check=False,
        )
        if check and result.returncode != 0:
            raise DeploymentError(f"command failed with exit code {result.returncode}: {' '.join(cmd)}")
        return result


@dataclass(frozen=True)
class DeploymentPaths:
    root: Path
    platform_dir: Path
    agent_runtime_dir: Path
    cognee_repo: Path
    firecrawl_repo: Path
    venv_dir: Path
    data_dir: Path
    service_dir: Path
    service_name: str = DEFAULT_SERVICE_NAME

    @classmethod
    def from_root(cls, root: Path, *, data_dir: Path | None = None, service_name: str = DEFAULT_SERVICE_NAME) -> "DeploymentPaths":
        clean_root = root.expanduser().resolve()
        clean_service_name = _validate_service_name(service_name)
        return cls(
            root=clean_root,
            platform_dir=clean_root / "enterprise-agent-platform",
            agent_runtime_dir=clean_root / "enterprise-agent-platform" / "agent-runtime",
            cognee_repo=clean_root / "cognee",
            firecrawl_repo=clean_root / "firecrawl",
            venv_dir=clean_root / ".venv",
            data_dir=(data_dir or clean_root / "enterprise-agent-platform" / "data").expanduser().resolve(),
            service_dir=Path(os.getenv("XDG_CONFIG_HOME", "~/.config")).expanduser() / "systemd" / "user",
            service_name=clean_service_name,
        )

    @property
    def venv_python(self) -> Path:
        return _venv_executable(self.venv_dir, "python")

    @property
    def platform_cli(self) -> Path:
        return _venv_executable(self.venv_dir, "enterprise-agent-platform")

    @property
    def service_path(self) -> Path:
        return self.service_dir / self.service_name

    @property
    def managed_node_root(self) -> Path:
        return self.data_dir / "runtimes" / "node"

    @property
    def managed_node_current(self) -> Path:
        return self.managed_node_root / "current"

@dataclass(frozen=True)
class DeploymentResult:
    mode: str
    url: str
    service_path: str = ""
    service_started: bool = False
    foreground_started: bool = False


class DeploymentManager:
    def __init__(
        self,
        paths: DeploymentPaths,
        *,
        runner: CommandRunner | None = None,
    ):
        self.paths = paths
        self.runner = runner or SubprocessRunner()

    def bootstrap(
        self,
        *,
        host: str,
        port: int,
        mode: str = "auto",
        skip_submodules: bool = False,
        prepare_runtime: bool = True,
    ) -> DeploymentResult:
        self.ensure_python_version()
        self.ensure_node_version()
        self.ensure_layout()
        if not skip_submodules:
            self.ensure_submodules()
        self.ensure_source_repos()
        self.ensure_platform_venv()

        if mode == "prepare":
            if prepare_runtime:
                self.prepare_agent_runtime_artifact(host=host, port=port)
            return DeploymentResult(mode=mode, url=self.effective_public_url(host, port))
        if mode == "service":
            # Publish the sidecar that matches the checked-out source before
            # restarting the platform. The installer compares its persisted
            # source signature, so this is cheap when nothing changed and is
            # also what restores the matching sidecar after an update rollback.
            self.prepare_agent_runtime_artifact(host=host, port=port)
            service_path = self.install_user_service(host=host, port=port)
            return DeploymentResult(mode=mode, url=self.effective_public_url(host, port), service_path=str(service_path), service_started=True)
        if mode == "foreground":
            # Foreground is a supported deployment path, not a development
            # shortcut. Publish the locked sidecars and preflight/install the
            # native Camoufox dependencies before starting the platform. The
            # preparation is signature/idempotency guarded, so a healthy
            # installation does not repeat downloads or apt mutations.
            self.prepare_agent_runtime_artifact(host=host, port=port)
            self.run_foreground(host=host, port=port)
            return DeploymentResult(mode=mode, url=self.effective_public_url(host, port), foreground_started=True)
        if mode != "auto":
            raise DeploymentError(f"unknown deploy mode: {mode}")

        # ``auto`` may choose either systemd or foreground execution. Prepare
        # the managed sidecar first in both cases so a subsequent service
        # switch can never observe a build from a different source revision.
        self.prepare_agent_runtime_artifact(host=host, port=port)
        if self.user_systemd_available():
            service_path = self.install_user_service(host=host, port=port)
            return DeploymentResult(mode="service", url=self.effective_public_url(host, port), service_path=str(service_path), service_started=True)
        self.run_foreground(host=host, port=port)
        return DeploymentResult(mode="foreground", url=self.effective_public_url(host, port), foreground_started=True)

    def ensure_python_version(self) -> None:
        if sys.version_info < (3, 11):
            raise DeploymentError("Python 3.11 or newer is required")

    def ensure_node_version(self) -> None:
        """Select a compatible system Node or install the pinned managed build.

        The managed fallback is checksum pinned, lives below the platform data
        directory, and never modifies the host's package manager or global
        PATH.
        """

        node = shutil.which("node")
        npm = shutil.which("npm")
        if node is not None and npm is not None:
            raw_version = _capture_command_stdout([node, "--version"]).strip()
            version = _parse_node_version(raw_version)
            if version is not None and version >= MINIMUM_NODE_VERSION:
                return

        managed_bin = self._managed_node_bin()
        if self._node_install_is_usable(managed_bin):
            self._activate_managed_node(managed_bin)
            return
        if not _env_bool("ENTERPRISE_DEPLOY_AUTO_NODE", True):
            found = _capture_command_stdout([node, "--version"]).strip() if node else "missing"
            raise DeploymentError(
                f"Node.js 22.19 or newer and npm are required (found {found or 'unknown'}); "
                "automatic managed Node installation is disabled"
            )
        managed_bin = self.install_managed_node()
        self._activate_managed_node(managed_bin)

    def install_managed_node(self) -> Path:
        if sys.platform != "linux":
            raise DeploymentError(
                "automatic managed Node installation currently supports Linux x64 and arm64"
            )
        release = MANAGED_NODE_RELEASES.get(platform.machine().strip().lower())
        if release is None:
            raise DeploymentError(
                f"automatic managed Node installation does not support architecture {platform.machine()!r}"
            )
        distribution, expected_sha256 = release
        archive_name = f"node-v{MANAGED_NODE_VERSION}-{distribution}.tar.xz"
        source_url = f"https://nodejs.org/dist/v{MANAGED_NODE_VERSION}/{archive_name}"
        install_name = archive_name.removesuffix(".tar.xz")
        root = self.paths.managed_node_root
        self._ensure_private_runtime_directories(root)
        target = root / install_name
        if os.path.lexists(target):
            try:
                ensure_private_directory(target)
            except RuntimeError as exc:
                raise DeploymentError(str(exc)) from exc
        if self._node_install_is_usable(target / "bin"):
            self._publish_managed_node_current(target)
            return target / "bin"

        archive = root / f".{archive_name}.{uuid.uuid4().hex}.download"
        staging = root / f".staging-{uuid.uuid4().hex}"
        try:
            _download_file_bounded(
                source_url,
                archive,
                expected_sha256=expected_sha256,
                max_bytes=MAX_MANAGED_NODE_ARCHIVE_BYTES,
            )
            staging.mkdir(mode=0o700)
            with tarfile.open(archive, mode="r:xz") as bundle:
                _validate_node_archive(bundle, install_name)
                # Python 3.11 does not expose the 3.12 ``filter`` argument.
                # The complete member list, paths and link targets were
                # validated immediately above before any extraction occurs.
                bundle.extractall(staging)
            extracted = staging / install_name
            if not self._node_install_is_usable(extracted / "bin"):
                raise DeploymentError("managed Node archive did not contain usable node and npm binaries")
            try:
                extracted.rename(target)
            except FileExistsError:
                try:
                    ensure_private_directory(target)
                except RuntimeError as validation_error:
                    raise DeploymentError(str(validation_error)) from validation_error
                if not self._node_install_is_usable(target / "bin"):
                    raise
            self._publish_managed_node_current(target)
            return target / "bin"
        except (OSError, tarfile.TarError) as exc:
            raise DeploymentError(f"managed Node installation failed: {exc}") from exc
        finally:
            archive.unlink(missing_ok=True)
            shutil.rmtree(staging, ignore_errors=True)

    def _managed_node_bin(self) -> Path:
        current = self.paths.managed_node_current
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            return current / "bin"
        if not stat.S_ISLNK(metadata.st_mode):
            return self.paths.managed_node_root / ".invalid-current" / "bin"
        try:
            target = Path(os.readlink(current))
        except OSError:
            return self.paths.managed_node_root / ".invalid-current" / "bin"
        if target.is_absolute() or len(target.parts) != 1 or target.name in {"", ".", ".."}:
            return self.paths.managed_node_root / ".invalid-current" / "bin"
        resolved = self.paths.managed_node_root / target
        try:
            info = resolved.lstat()
        except FileNotFoundError:
            return current / "bin"
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            return self.paths.managed_node_root / ".invalid-current" / "bin"
        if hasattr(os, "getuid") and info.st_uid != os.getuid():
            return self.paths.managed_node_root / ".invalid-current" / "bin"
        return current / "bin"

    @staticmethod
    def _node_install_is_usable(bin_dir: Path) -> bool:
        node = bin_dir / "node"
        npm = bin_dir / "npm"
        if not node.is_file() or not os.access(node, os.X_OK) or not npm.exists():
            return False
        version = _parse_node_version(_capture_command_stdout([str(node), "--version"]))
        return bool(version is not None and version >= MINIMUM_NODE_VERSION)

    def _publish_managed_node_current(self, target: Path) -> None:
        current = self.paths.managed_node_current
        temporary = current.with_name(f".{current.name}.{uuid.uuid4().hex}.tmp")
        try:
            temporary.symlink_to(target.name, target_is_directory=True)
            os.replace(temporary, current)
            _fsync_directory(current.parent)
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def _activate_managed_node(bin_dir: Path) -> None:
        current = os.environ.get("PATH", "")
        prefix = str(bin_dir)
        os.environ["PATH"] = prefix if not current else prefix + os.pathsep + current

    def ensure_layout(self) -> None:
        if not (self.paths.platform_dir / "enterprise_agent_platform").is_dir():
            raise DeploymentError(f"platform source not found: {self.paths.platform_dir}")
        if not (self.paths.agent_runtime_dir / "package.json").is_file() or not (
            self.paths.agent_runtime_dir / "package-lock.json"
        ).is_file():
            raise DeploymentError(
                f"Agent runtime source not found: {self.paths.agent_runtime_dir}"
            )

    def ensure_submodules(self) -> None:
        if not (self.paths.root / ".git").exists():
            return
        if not shutil.which("git"):
            raise DeploymentError("git is required to initialize submodules")
        self.runner.run(["git", "submodule", "update", "--init", "--recursive"], cwd=self.paths.root, timeout=1800)

    def ensure_source_repos(self) -> None:
        missing = []
        if not (self.paths.cognee_repo / "pyproject.toml").exists():
            missing.append(str(self.paths.cognee_repo))
        if not any(
            (self.paths.firecrawl_repo / name).exists()
            for name in ("docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml")
        ):
            missing.append(str(self.paths.firecrawl_repo))
        if missing:
            raise DeploymentError("required adjacent source repositories are missing: " + ", ".join(missing))

    def ensure_platform_venv(self) -> None:
        if not self.paths.venv_python.exists():
            self.recreate_platform_venv()
        if not self.venv_pip_available():
            print(f"Existing platform virtual environment is incomplete; recreating {self.paths.venv_dir}", flush=True)
            self.recreate_platform_venv()
            if not self.venv_pip_available():
                raise DeploymentError(venv_package_hint(sys.executable, self.paths.venv_dir, existing_broken=True))
        self.run_pip_install(["--upgrade", "pip", "setuptools", "wheel"], timeout=900)
        self.run_pip_install(["--no-build-isolation", "-e", str(self.paths.platform_dir)], timeout=900)

    def run_pip_install(self, args: list[str], *, timeout: float) -> None:
        attempts = positive_int_env("ENTERPRISE_PIP_INSTALL_ATTEMPTS", DEFAULT_PIP_INSTALL_ATTEMPTS)
        cmd = [
            str(self.paths.venv_python),
            "-m",
            "pip",
            "install",
            "--retries",
            str(positive_int_env("ENTERPRISE_PIP_RETRIES", DEFAULT_PIP_NETWORK_RETRIES)),
            "--timeout",
            str(positive_int_env("ENTERPRISE_PIP_TIMEOUT", DEFAULT_PIP_TIMEOUT_SECONDS)),
            *args,
        ]
        env = os.environ.copy()
        env.setdefault("PIP_DISABLE_PIP_VERSION_CHECK", "1")
        for attempt in range(1, attempts + 1):
            result = self.runner.run(cmd, cwd=self.paths.root, env=env, timeout=timeout, check=False)
            if result.returncode == 0:
                return
            if attempt < attempts:
                print(f"pip install failed with exit code {result.returncode}; retrying ({attempt + 1}/{attempts}).", flush=True)
        raise DeploymentError(f"command failed after {attempts} attempts with exit code {result.returncode}: {' '.join(cmd)}")

    def recreate_platform_venv(self) -> None:
        self.ensure_venv_module_available()
        if self.paths.venv_dir.exists():
            shutil.rmtree(self.paths.venv_dir)
        self.runner.run([sys.executable, "-m", "venv", str(self.paths.venv_dir)], cwd=self.paths.root, timeout=180)

    def ensure_venv_module_available(self) -> None:
        result = self.runner.run(
            [sys.executable, "-c", "import ensurepip"],
            cwd=self.paths.root,
            timeout=30,
            check=False,
        )
        if result.returncode == 0:
            return
        if self.install_venv_system_package():
            retry = self.runner.run(
                [sys.executable, "-c", "import ensurepip"],
                cwd=self.paths.root,
                timeout=30,
                check=False,
            )
            if retry.returncode == 0:
                return
        raise DeploymentError(venv_package_hint(sys.executable, self.paths.venv_dir))

    def install_venv_system_package(self) -> bool:
        command_base = apt_get_command_base()
        if command_base is None:
            return False
        package_names = python_venv_package_names()
        print(
            "Python venv support is missing; attempting to install "
            + " or ".join(package_names)
            + ".",
            flush=True,
        )
        update = self.runner.run([*command_base, "update"], cwd=self.paths.root, timeout=1800, check=False)
        if update.returncode != 0:
            return False
        for package_name in package_names:
            result = self.runner.run([*command_base, "install", "-y", package_name], cwd=self.paths.root, timeout=1800, check=False)
            if result.returncode == 0:
                return True
        return False

    def venv_pip_available(self) -> bool:
        if not self.paths.venv_python.exists():
            return False
        result = self.runner.run(
            [str(self.paths.venv_python), "-m", "pip", "--version"],
            cwd=self.paths.root,
            timeout=30,
            check=False,
        )
        return result.returncode == 0

    def prepare_agent_runtime_artifact(self, *, host: str, port: int) -> dict[str, object]:
        """Publish the locked Agent and Camoufox runtimes without opening the live database."""

        config = self._platform_config(host=host, port=port)
        snapshot = _read_settings_snapshot(config.db_path)

        def setting_provider(key: str) -> str | None:
            found = snapshot.get(key)
            return str(found[0]) if found else None

        def secret_provider(key: str) -> str:
            found = snapshot.get(key)
            if found and found[1]:
                return str(found[0])
            return os.getenv(key, "")

        runtimes = PlatformRuntimeManager(
            config,
            secret_provider,
            setting_provider=setting_provider,
        )
        try:
            managed_camofox = runtimes._managed_camofox_enabled()
            platform_camofox = managed_camofox and not runtimes._effective_camofox_command()
            if platform_camofox:
                self.ensure_camofox_system_dependencies()
            status = runtimes.install_agent_runtime(force=False)
            if not status.available:
                raise DeploymentError(status.error or "Agent runtime preparation failed")
            camofox = runtimes.install_camofox(force=False)
            if camofox.managed and not camofox.available:
                raise DeploymentError(camofox.error or "Camofox runtime preparation failed")
            if platform_camofox:
                self.ensure_camofox_system_dependencies(
                    browser_executable=runtimes._camofox_browser_executable()
                )
            result = status.to_dict()
            result["camofox"] = camofox.to_dict()
            return result
        finally:
            runtimes.close()

    def ensure_camofox_system_dependencies(
        self,
        *,
        browser_executable: Path | None = None,
    ) -> None:
        """Prepare native dependencies only when the managed browser needs them."""

        missing = _camofox_system_dependency_problems(browser_executable)
        if not missing:
            return
        command_base = apt_get_command_base()
        if command_base is None:
            raise DeploymentError(_camofox_dependency_hint(missing))

        print(
            "Managed Camofox system dependencies are missing; attempting Debian/Ubuntu installation.",
            flush=True,
        )
        update = self.runner.run(
            [*command_base, "update"],
            cwd=self.paths.root,
            timeout=1800,
            check=False,
        )
        if update.returncode != 0:
            raise DeploymentError(_camofox_dependency_hint(missing, apt_failed=True))

        installed = False
        for packages in (CAMOFOX_APT_PACKAGES, CAMOFOX_APT_PACKAGES_T64):
            result = self.runner.run(
                [*command_base, "install", "-y", "--no-install-recommends", *packages],
                cwd=self.paths.root,
                timeout=1800,
                check=False,
            )
            if result.returncode == 0:
                installed = True
                break
        if not installed:
            raise DeploymentError(_camofox_dependency_hint(missing, apt_failed=True))

        remaining = _camofox_system_dependency_problems(browser_executable)
        if remaining:
            raise DeploymentError(_camofox_dependency_hint(remaining, apt_failed=True))

    def _ensure_private_runtime_directories(self, target: Path) -> None:
        """Validate every managed directory component without following links."""

        try:
            relative = target.relative_to(self.paths.data_dir)
        except ValueError as exc:
            raise DeploymentError("managed runtime path is outside the platform data directory") from exc
        current = self.paths.data_dir
        try:
            ensure_private_directory(current)
            for component in relative.parts:
                current = current / component
                ensure_private_directory(current)
        except RuntimeError as exc:
            raise DeploymentError(str(exc)) from exc

    def _platform_config(self, *, host: str, port: int) -> PlatformConfig:
        env_values = runtime_env(self.paths, host=host, port=port)
        effective_host = env_values["ENTERPRISE_PLATFORM_HOST"]
        effective_port = int(env_values["ENTERPRISE_PLATFORM_PORT"])
        public_base_url = env_values["ENTERPRISE_PUBLIC_BASE_URL"].rstrip("/")
        config = PlatformConfig.from_env(self.paths.root)
        return replace(
            config,
            data_dir=self.paths.data_dir,
            host=effective_host,
            port=effective_port,
            public_base_url=public_base_url,
            trust_forwarded_headers=env_values.get("ENTERPRISE_TRUSTED_PROXY", "").strip().lower() in {"1", "true", "yes", "on"},
            token_ttl_seconds=int(env_values.get("ENTERPRISE_SESSION_TTL_SECONDS") or config.token_ttl_seconds),
            cognee_repo=self.paths.cognee_repo,
            firecrawl_repo=self.paths.firecrawl_repo,
            agent_runtime_home=self.paths.data_dir / "runtimes" / "agent",
        )

    def user_systemd_available(self) -> bool:
        if not shutil.which("systemctl"):
            return False
        result = self.runner.run(["systemctl", "--user", "show-environment"], timeout=20, check=False)
        return result.returncode == 0

    def install_user_service(self, *, host: str, port: int) -> Path:
        self.paths.service_dir.mkdir(parents=True, exist_ok=True)
        self.paths.service_path.write_text(user_service_unit(self.paths, host=host, port=port), encoding="utf-8")
        self.runner.run(["systemctl", "--user", "daemon-reload"], timeout=30)
        self.runner.run(["systemctl", "--user", "enable", self.paths.service_name], timeout=60)
        self.runner.run(["systemctl", "--user", "restart", self.paths.service_name], timeout=60)
        self.ensure_user_linger()
        self.wait_for_service_ready(host=host, port=port)
        return self.paths.service_path

    def ensure_user_linger(self) -> None:
        """Best-effort enable systemd user linger so the service survives logout.

        A ``systemctl --user`` instance is created at login and torn down when the
        user's last session ends unless linger is enabled; without it user units
        also do not start at boot. Enabling linger can be polkit-gated, so every
        step is best-effort and never raises.
        """
        if not shutil.which("loginctl"):
            self._warn_linger_disabled("loginctl is not available")
            return
        username = _current_username()
        if not username:
            self._warn_linger_disabled("could not determine the current username")
            return
        if self._linger_enabled(username):
            return
        self.runner.run(["loginctl", "enable-linger", username], timeout=20, check=False)
        if self._linger_enabled(username):
            return
        self._warn_linger_disabled(f"run: loginctl enable-linger {username} (may require sudo)")

    def _linger_enabled(self, username: str) -> bool:
        # This query needs captured stdout to read the Linger value, which the
        # streaming SubprocessRunner does not capture. Only probe linger state
        # for real deployments; with an injected runner (tests) degrade to
        # "unknown/off" so behaviour stays deterministic and offline.
        if not isinstance(self.runner, SubprocessRunner):
            return False
        stdout = _capture_command_stdout(
            ["loginctl", "show-user", "--value", "--property=Linger", username]
        )
        return stdout.strip().lower() == "yes"

    @staticmethod
    def _warn_linger_disabled(detail: str) -> None:
        print(
            "WARNING: systemd user linger is not enabled. The platform will stop "
            "when your login session ends and will NOT start at boot. "
            f"To make it durable, {detail}.",
            file=sys.stderr,
            flush=True,
        )

    def wait_for_service_ready(self, *, host: str, port: int) -> None:
        """Require systemd, platform HTTP, Pi, and managed browser readiness.

        ``Type=simple`` units are reported active as soon as the main process is
        forked, so ``systemctl restart`` succeeds even for a crash-looping
        service. Poll ``systemctl --user is-active`` to catch a service that
        never stays up, and probe the configured host/port so a deploy does not
        report success for a platform that never becomes reachable.
        """
        deadline = time.monotonic() + service_ready_timeout_seconds()
        active = False
        while True:
            state = self.runner.run(
                ["systemctl", "--user", "is-active", self.paths.service_name],
                timeout=20,
                check=False,
            )
            if state.returncode == 0:
                active = True
                break
            failed = self.runner.run(
                ["systemctl", "--user", "is-failed", self.paths.service_name],
                timeout=20,
                check=False,
            )
            if failed.returncode == 0:
                self._raise_service_failed("the systemd unit reported a failed state")
            if time.monotonic() >= deadline:
                break
            time.sleep(1.0)
        if not active:
            self._raise_service_failed("the systemd unit did not become active in time")
        if not self._wait_for_service_http(host=host, port=port, deadline=deadline):
            self._raise_service_failed("the platform health endpoint did not become ready")
        if not self._wait_for_agent_http(host=host, port=port, deadline=deadline):
            self._raise_service_failed("the Pi Agent runtime health endpoint did not become ready")
        if not self._wait_for_camofox_http(host=host, port=port, deadline=deadline):
            self._raise_service_failed("the managed Camoufox browser capability did not become ready")

    def _wait_for_service_http(self, *, host: str, port: int, deadline: float) -> bool:
        env = runtime_env(self.paths, host=host, port=port)
        url = _loopback_http_url(
            env["ENTERPRISE_PLATFORM_HOST"],
            int(env["ENTERPRISE_PLATFORM_PORT"]),
        ) + "/healthz"
        while True:
            if _probe_json_health(url, expected_service="ubitech-agent-platform"):
                return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.5)

    def _wait_for_agent_http(self, *, host: str, port: int, deadline: float) -> bool:
        config = self._platform_config(host=host, port=port)
        while True:
            settings = _read_settings_snapshot(config.db_path)
            runtime_url = (
                settings.get("agent_runtime_url", (config.agent_runtime_url, False))[0]
                or config.agent_runtime_url
            ).rstrip("/")
            runtime_url = _loopback_base_url(runtime_url)
            token_row = settings.get("agent_runtime_token")
            token = str(token_row[0]) if token_row and token_row[1] else config.agent_runtime_token
            headers = {"Authorization": f"Bearer {token}"} if token else {}
            if _probe_json_health(
                runtime_url + "/health",
                expected_service="ubitech-agent-runtime",
                headers=headers,
            ):
                return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.5)

    def _wait_for_camofox_http(self, *, host: str, port: int, deadline: float) -> bool:
        """Probe a real authenticated tab/snapshot/screenshot capability chain."""

        config = self._platform_config(host=host, port=port)
        snapshot = _read_settings_snapshot(config.db_path)

        def setting_provider(key: str) -> str | None:
            found = snapshot.get(key)
            return str(found[0]) if found else None

        def secret_provider(key: str) -> str:
            found = snapshot.get(key)
            if found and found[1]:
                return str(found[0])
            return os.getenv(key, "")

        runtimes = PlatformRuntimeManager(
            config,
            secret_provider,
            setting_provider=setting_provider,
        )
        try:
            if not runtimes._managed_camofox_enabled():
                return True
            while True:
                # This uses the same authenticated capability probe as runtime
                # status: create a scoped tab, take an accessibility snapshot
                # and PNG screenshot, then always delete the probe session.
                if runtimes._probe_camofox_capability():
                    return True
                if time.monotonic() >= deadline:
                    return False
                time.sleep(0.5)
        finally:
            runtimes.close()

    def _raise_service_failed(self, reason: str) -> None:
        tail = self._service_log_tail()
        message = f"the platform service did not start cleanly: {reason}."
        if tail:
            message += f"\nRecent logs:\n{tail}"
        message += "\nInspect with './deploy.sh status' and './deploy.sh logs'."
        raise DeploymentError(message)

    def _service_log_tail(self) -> str:
        # Diagnostic tail needs captured stdout; only gather it for real
        # deployments so an injected runner (tests) is never asked to shell out.
        if not isinstance(self.runner, SubprocessRunner) or not shutil.which("journalctl"):
            return ""
        return _capture_command_stdout(
            ["journalctl", "--user", "-u", self.paths.service_name, "-n", "50", "--no-pager"]
        ).strip()

    def run_foreground(self, *, host: str, port: int) -> None:
        env = os.environ.copy()
        env_values = runtime_env(self.paths, host=host, port=port)
        env.update(env_values)
        host = env_values["ENTERPRISE_PLATFORM_HOST"]
        port = int(env_values["ENTERPRISE_PLATFORM_PORT"])
        try:
            result = self.runner.run(
                [str(self.paths.platform_cli), "serve", "--host", host, "--port", str(port), "--data", str(self.paths.data_dir)],
                cwd=self.paths.platform_dir,
                env=env,
                timeout=None,
                check=False,
            )
        except KeyboardInterrupt:
            # Operator stopped the foreground server (Ctrl-C); the child handles
            # its own shutdown, so exit cleanly without a traceback.
            return
        returncode = getattr(result, "returncode", 0) or 0
        # A clean exit (0) or a signal-driven shutdown (negative returncode, or the
        # 130/143 SIGINT/SIGTERM conventions) is a normal stop. A positive exit
        # code means the server failed to start (e.g. the port is already in use
        # or the config is invalid) and must surface rather than being silently
        # reported as a successful foreground deploy.
        if returncode > 0 and returncode not in (130, 143):
            self._raise_service_failed(f"the foreground server exited with code {returncode}")

    @staticmethod
    def public_url(host: str, port: int) -> str:
        return os.getenv("ENTERPRISE_PUBLIC_BASE_URL", f"http://{host}:{port}").rstrip("/")

    def effective_public_url(self, host: str, port: int) -> str:
        return runtime_env(self.paths, host=host, port=port)["ENTERPRISE_PUBLIC_BASE_URL"].rstrip("/")


def runtime_env(paths: DeploymentPaths, *, host: str, port: int) -> dict[str, str]:
    settings = _deployment_platform_settings(paths.data_dir)
    effective_host = settings.get("platform_host") or host
    try:
        effective_port = int(settings.get("platform_port") or port)
    except ValueError:
        effective_port = port
    values = {
        "ENTERPRISE_PLATFORM_DATA": str(paths.data_dir),
        "ENTERPRISE_SERVICE_NAME": paths.service_name,
        "ENTERPRISE_AGENT_RUNTIME_HOME": str(paths.data_dir / "runtimes" / "agent"),
        "ENTERPRISE_COGNEE_REPO": str(paths.cognee_repo),
        "ENTERPRISE_FIRECRAWL_REPO": str(paths.firecrawl_repo),
        "ENTERPRISE_PLATFORM_HOST": effective_host,
        "ENTERPRISE_PLATFORM_PORT": str(effective_port),
        "ENTERPRISE_PUBLIC_BASE_URL": settings.get("platform_public_base_url") or DeploymentManager.public_url(effective_host, effective_port),
    }
    if "platform_trusted_proxy" in settings:
        values["ENTERPRISE_TRUSTED_PROXY"] = settings["platform_trusted_proxy"]
    if "platform_session_ttl_seconds" in settings:
        values["ENTERPRISE_SESSION_TTL_SECONDS"] = settings["platform_session_ttl_seconds"]
    return values


def user_service_unit(paths: DeploymentPaths, *, host: str, port: int) -> str:
    env = runtime_env(paths, host=host, port=port)
    if any(any(char in value for char in "\x00\r\n") for value in env.values()):
        raise DeploymentError("service environment contains unsupported control characters")
    env_lines = [f"Environment={_systemd_quote(f'{key}={value}')}" for key, value in env.items()]
    process_path = os.environ.get("PATH", "")
    managed_node_bin = str(paths.managed_node_current / "bin")
    service_path = managed_node_bin + (os.pathsep + process_path if process_path else "")
    if any(char in service_path for char in "\x00\r\n"):
        raise DeploymentError("PATH contains characters that cannot be written to a systemd unit")
    exec_start = " ".join(
        [
            _systemd_quote(str(paths.platform_cli)),
            "serve",
            "--host",
            _systemd_quote(env["ENTERPRISE_PLATFORM_HOST"]),
            "--port",
            env["ENTERPRISE_PLATFORM_PORT"],
            "--data",
            _systemd_quote(str(paths.data_dir)),
        ]
    )
    lines = [
        "[Unit]",
        "Description=ubitech agent",
        "After=network-online.target",
        "Wants=network-online.target",
        "",
        "[Service]",
        "Type=simple",
        f"WorkingDirectory={_systemd_path_value(paths.platform_dir)}",
        "Environment=PYTHONUNBUFFERED=1",
        f"Environment={_systemd_quote(f'PATH={service_path}')}",
        *env_lines,
        f"ExecStart={exec_start}",
        "Restart=on-failure",
        "RestartSec=5",
        # Give the platform room to bring managed runtimes (Agent/Firecrawl)
        # up and down; the default 90s stop window can be too short to stop
        # them gracefully, which would otherwise escalate to SIGKILL.
        f"TimeoutStopSec={service_stop_timeout_seconds()}",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
    ]
    return "\n".join(lines)


def _deployment_platform_settings(data_dir: Path) -> dict[str, str]:
    db_path = data_dir / "platform.db"
    if not db_path.exists():
        return {}
    keys = {
        "platform_host",
        "platform_port",
        "platform_public_base_url",
        "platform_trusted_proxy",
        "platform_session_ttl_seconds",
    }
    try:
        conn = sqlite3.connect(str(db_path))
        try:
            rows = conn.execute(
                f"SELECT key, value FROM settings WHERE key IN ({','.join('?' for _ in keys)})",
                tuple(sorted(keys)),
            ).fetchall()
        finally:
            conn.close()
    except sqlite3.Error:
        return {}
    return {str(key): str(value) for key, value in rows if value is not None}


def _read_settings_snapshot(db_path: Path) -> dict[str, tuple[str, bool]]:
    """Read persisted settings without running schema migrations."""

    if not db_path.is_file():
        return {}
    try:
        connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=30)
        try:
            rows = connection.execute("SELECT key, value, secret FROM settings").fetchall()
        finally:
            connection.close()
    except sqlite3.Error as exc:
        raise DeploymentError(f"unable to read existing platform settings: {exc}") from exc
    return {
        str(key): (str(value), bool(secret))
        for key, value, secret in rows
        if key is not None and value is not None
    }


def venv_package_hint(python_executable: str, venv_dir: Path, *, existing_broken: bool = False) -> str:
    package = python_venv_package_names()[0]
    prefix = (
        f"Existing virtual environment appears incomplete: {venv_dir}"
        if existing_broken
        else "Python venv support is not available for this interpreter, and automatic installation did not complete."
    )
    return "\n".join(
        [
            prefix,
            "",
            "On Debian/Ubuntu install the venv package, remove any partial venv, then rerun deploy:",
            f"  sudo apt update && sudo apt install -y {package}",
            f"  rm -rf {venv_dir}",
            "  ./deploy.sh",
            "",
            f"Python executable: {python_executable}",
            f"Fallback package name if needed: python3-venv",
        ]
    )


def python_venv_package_names() -> list[str]:
    version = f"{sys.version_info.major}.{sys.version_info.minor}"
    names = [f"python{version}-venv", "python3-venv"]
    return list(dict.fromkeys(names))


def _camofox_system_dependency_problems(browser_executable: Path | None) -> list[str]:
    problems: list[str] = []
    xvfb = shutil.which("Xvfb")
    fontconfig = shutil.which("fc-match")
    if xvfb is None:
        problems.append("Xvfb executable")
    if fontconfig is None:
        problems.append("fontconfig (fc-match)")
    elif not _command_succeeds([fontconfig, "--version"]):
        problems.append("working fontconfig runtime")

    if browser_executable is None:
        return problems
    executable = browser_executable.expanduser().resolve()
    if not executable.is_file() or not os.access(executable, os.X_OK):
        problems.append(f"executable managed browser at {executable}")
        return problems
    bundle = executable.parent
    env = os.environ.copy()
    existing_library_path = env.get("LD_LIBRARY_PATH", "")
    env["LD_LIBRARY_PATH"] = str(bundle) + (
        os.pathsep + existing_library_path if existing_library_path else ""
    )
    if not _command_succeeds([str(executable), "--version"], env=env, cwd=bundle):
        problems.append("managed browser loader/runtime libraries")

    ldd = shutil.which("ldd")
    if ldd is None:
        problems.append("ldd dependency checker")
        return problems
    targets = (
        executable,
        bundle / "libxul.so",
        bundle / "libmozgtk.so",
        bundle / "libmozwayland.so",
    )
    for target in targets:
        if not target.is_file():
            problems.append(f"managed browser component {target.name}")
            continue
        try:
            result = subprocess.run(
                [ldd, str(target)],
                cwd=str(bundle),
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=30,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            problems.append(f"dependency preflight for {target.name}")
            continue
        output = result.stdout or ""
        unresolved = sorted(
            {
                line.strip()
                for line in output.splitlines()
                if "not found" in line.lower()
            }
        )
        if result.returncode != 0 or unresolved:
            detail = "; ".join(unresolved[:3]) or f"ldd exited {result.returncode}"
            problems.append(f"{target.name}: {detail}")
    return list(dict.fromkeys(problems))


def _command_succeeds(
    cmd: list[str],
    *,
    env: dict[str, str] | None = None,
    cwd: Path | None = None,
) -> bool:
    try:
        result = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd else None,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def _camofox_dependency_hint(missing: list[str], *, apt_failed: bool = False) -> str:
    package_text = " ".join(CAMOFOX_APT_PACKAGES)
    reason = "Automatic apt installation did not complete." if apt_failed else (
        "Automatic apt installation is unavailable, disabled, or this host is not Debian/Ubuntu."
    )
    return "\n".join(
        [
            "Managed Camofox cannot start because native browser dependencies are missing:",
            *(f"  - {item}" for item in missing),
            "",
            reason,
            "On Debian/Ubuntu install the runtime packages, then rerun deploy:",
            f"  sudo apt update && sudo apt install -y --no-install-recommends {package_text}",
        ]
    )


def apt_get_command_base() -> list[str] | None:
    if os.getenv("ENTERPRISE_DEPLOY_AUTO_APT", "1").lower() in {"0", "false", "no"}:
        return None
    apt_get = shutil.which("apt-get")
    if not apt_get:
        return None
    if getattr(os, "geteuid", lambda: 1)() == 0:
        return [apt_get]
    sudo = shutil.which("sudo")
    if sudo:
        return [sudo, apt_get]
    return None


def positive_int_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def service_ready_timeout_seconds() -> int:
    return positive_int_env(
        "ENTERPRISE_SERVICE_READY_TIMEOUT", DEFAULT_SERVICE_READY_TIMEOUT_SECONDS
    )


def service_stop_timeout_seconds() -> int:
    return positive_int_env(
        "ENTERPRISE_SERVICE_STOP_TIMEOUT", DEFAULT_SERVICE_STOP_TIMEOUT_SECONDS
    )


def _current_username() -> str:
    try:
        return getpass.getuser()
    except Exception:  # pragma: no cover - depends on the host environment
        return os.getenv("USER", "") or os.getenv("LOGNAME", "")


def _capture_command_stdout(cmd: list[str], *, timeout: float = 20.0) -> str:
    """Run a read-only query command and return its stdout (best-effort)."""
    try:
        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return result.stdout or ""


def _download_file_bounded(
    url: str,
    destination: Path,
    *,
    expected_sha256: str,
    max_bytes: int,
) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "ubitech-agent-deploy/1"})
    digest = hashlib.sha256()
    total = 0
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            length = response.headers.get("Content-Length")
            if length:
                try:
                    if int(length) > max_bytes:
                        raise DeploymentError("managed Node download exceeds the size limit")
                except ValueError:
                    pass
            descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                with os.fdopen(descriptor, "wb") as handle:
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > max_bytes:
                            raise DeploymentError("managed Node download exceeds the size limit")
                        digest.update(chunk)
                        handle.write(chunk)
                    handle.flush()
                    os.fsync(handle.fileno())
            except BaseException:
                destination.unlink(missing_ok=True)
                raise
    except DeploymentError:
        raise
    except (OSError, urllib.error.URLError, TimeoutError) as exc:
        destination.unlink(missing_ok=True)
        raise DeploymentError(f"unable to download managed Node from nodejs.org: {exc}") from exc
    if digest.hexdigest() != expected_sha256:
        destination.unlink(missing_ok=True)
        raise DeploymentError("managed Node archive checksum verification failed")


def _validate_node_archive(bundle: tarfile.TarFile, expected_root: str) -> None:
    """Reject path traversal and special files before extracting Node."""

    root = PurePosixPath(expected_root)
    members = bundle.getmembers()
    if not members or len(members) > 100_000:
        raise DeploymentError("managed Node archive has an invalid member count")
    for member in members:
        name = PurePosixPath(member.name)
        if name.is_absolute() or not name.parts or name.parts[0] != expected_root or ".." in name.parts:
            raise DeploymentError("managed Node archive contains an unsafe path")
        if member.isdev() or member.isfifo():
            raise DeploymentError("managed Node archive contains an unsupported special file")
        if member.issym():
            target = name.parent.joinpath(PurePosixPath(member.linkname))
            normalized: list[str] = []
            for part in target.parts:
                if part in {"", "."}:
                    continue
                if part == "..":
                    if not normalized:
                        raise DeploymentError("managed Node archive contains an escaping symlink")
                    normalized.pop()
                else:
                    normalized.append(part)
            if not normalized or normalized[0] != root.parts[0]:
                raise DeploymentError("managed Node archive contains an escaping symlink")
        if member.islnk():
            target = PurePosixPath(member.linkname)
            if target.is_absolute() or not target.parts or target.parts[0] != expected_root or ".." in target.parts:
                raise DeploymentError("managed Node archive contains an unsafe hard link")


def _parse_node_version(raw: str) -> tuple[int, int] | None:
    value = raw.strip().removeprefix("v")
    parts = value.split(".")
    if len(parts) < 2:
        return None
    try:
        return int(parts[0]), int(parts[1])
    except ValueError:
        return None


def _probe_json_health(
    url: str,
    *,
    expected_service: str,
    headers: dict[str, str] | None = None,
) -> bool:
    try:
        request = urllib.request.Request(url, headers=headers or {}, method="GET")
        with urllib.request.urlopen(request, timeout=1.0) as response:
            if response.status != 200:
                return False
            content_type = str(response.headers.get("Content-Type") or "").lower()
            if "application/json" not in content_type:
                return False
            body = response.read(64 * 1024 + 1)
            if len(body) > 64 * 1024:
                return False
        payload = json.loads(body.decode("utf-8"))
        return bool(
            isinstance(payload, dict)
            and payload.get("status") == "ok"
            and payload.get("service") == expected_service
        )
    except (
        urllib.error.HTTPError,
        urllib.error.URLError,
        TimeoutError,
        OSError,
        ValueError,
        UnicodeDecodeError,
        json.JSONDecodeError,
    ):
        return False


def _loopback_http_url(host: str, port: int) -> str:
    clean_host = str(host or "").strip()
    if clean_host in {"", "0.0.0.0", "::", "[::]"}:
        clean_host = "127.0.0.1"
    if ":" in clean_host and not clean_host.startswith("["):
        clean_host = f"[{clean_host}]"
    return f"http://{clean_host}:{int(port)}"


def _loopback_base_url(base_url: str) -> str:
    parsed = urllib.parse.urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return base_url.rstrip("/")
    hostname = parsed.hostname
    if hostname in {"0.0.0.0", "::"}:
        hostname = "127.0.0.1"
    if ":" in hostname and not hostname.startswith("["):
        hostname = f"[{hostname}]"
    authority = hostname
    if parsed.port is not None:
        authority += f":{parsed.port}"
    return urllib.parse.urlunparse(
        (parsed.scheme, authority, parsed.path.rstrip("/"), "", "", "")
    )


def _fsync_directory(path: Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Bootstrap and manage the ubitech agent deployment")
    sub = parser.add_subparsers(dest="cmd")
    bootstrap = sub.add_parser("bootstrap", help="One-command deployment bootstrap")
    add_bootstrap_args(bootstrap)
    return parser


def add_bootstrap_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--root", default=os.getenv("ENTERPRISE_REPO_ROOT", _default_repo_root()))
    parser.add_argument("--host", default=os.getenv("ENTERPRISE_PLATFORM_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("ENTERPRISE_PLATFORM_PORT", "8765")))
    parser.add_argument("--data", default=os.getenv("ENTERPRISE_PLATFORM_DATA") or None)
    parser.add_argument("--mode", choices=("auto", "service", "foreground", "prepare"), default=os.getenv("ENTERPRISE_DEPLOY_MODE", "auto"))
    parser.add_argument("--service-name", default=os.getenv("ENTERPRISE_SERVICE_NAME") or None)
    parser.add_argument("--skip-submodules", action="store_true")
    parser.add_argument("--skip-runtime-prepare", action="store_true")


def bootstrap_from_args(args: argparse.Namespace) -> DeploymentResult:
    root = Path(args.root).expanduser().resolve()
    requested_data = Path(args.data).expanduser() if args.data else None
    requested_service = str(args.service_name).strip() if args.service_name else None
    existing = _resolve_existing_service_deployment(
        root,
        requested_service=requested_service,
        requested_data=requested_data,
    )
    service_name = requested_service or existing.service_name
    data_dir = requested_data or existing.data_dir
    paths = DeploymentPaths.from_root(root, data_dir=data_dir, service_name=service_name)
    manager = DeploymentManager(paths)
    result = manager.bootstrap(
        host=args.host,
        port=args.port,
        mode=args.mode,
        skip_submodules=args.skip_submodules,
        prepare_runtime=not args.skip_runtime_prepare,
    )
    if result.service_started:
        print(f"ubitech agent service started: {result.url}")
        print(f"Service file: {result.service_path}")
    elif result.mode == "prepare":
        print(f"ubitech agent prepared: {result.url}")
    return result


def _existing_service_data_dir(service_name: str) -> Path | None:
    """Recover a managed service's persisted data directory."""

    service_name = _validate_service_name(service_name)
    service_dir = _user_service_directory()
    parsed = _read_existing_service_unit(service_dir / service_name)
    return parsed.data_dir if parsed is not None else None


def _resolve_existing_service_deployment(
    root: Path,
    *,
    requested_service: str | None,
    requested_data: Path | None,
) -> ExistingServiceDeployment:
    """Recover service identity from a unique unit for this checkout."""

    service_dir = _user_service_directory()
    if requested_service:
        name = _validate_service_name(requested_service)
        parsed = _read_existing_service_unit(service_dir / name)
        if parsed is not None and requested_data is not None and parsed.data_dir is not None:
            if parsed.data_dir != requested_data.expanduser().resolve(strict=False):
                raise DeploymentError("explicit platform data directory conflicts with the existing service unit")
        return ExistingServiceDeployment(
            service_name=name,
            data_dir=requested_data or (parsed.data_dir if parsed is not None else None),
        )

    candidates: list[ExistingServiceDeployment] = []
    try:
        unit_paths = sorted(service_dir.glob("*.service"))
    except OSError:
        unit_paths = []
    if len(unit_paths) > 10_000:
        raise DeploymentError("too many user service units to identify the existing platform service")
    for service_path in unit_paths:
        parsed = _read_existing_service_unit(service_path)
        if parsed is None or not _service_unit_matches_root(service_path, root):
            continue
        if requested_data is not None and parsed.data_dir is not None:
            if parsed.data_dir != requested_data.expanduser().resolve(strict=False):
                continue
        candidates.append(parsed)
    if len(candidates) > 1:
        names = ", ".join(item.service_name for item in candidates[:5])
        raise DeploymentError(
            f"multiple platform user services match this checkout ({names}); pass --service-name explicitly"
        )
    if candidates:
        candidate = candidates[0]
        return ExistingServiceDeployment(
            service_name=candidate.service_name,
            data_dir=requested_data or candidate.data_dir,
        )
    return ExistingServiceDeployment(
        service_name=DEFAULT_SERVICE_NAME,
        data_dir=requested_data,
    )


def _read_existing_service_unit(service_path: Path) -> ExistingServiceDeployment | None:
    try:
        metadata = service_path.lstat()
    except FileNotFoundError:
        return None
    if (
        stat.S_ISLNK(metadata.st_mode)
        or not stat.S_ISREG(metadata.st_mode)
        or metadata.st_size > MAX_EXISTING_SERVICE_UNIT_BYTES
    ):
        return None
    try:
        lines = service_path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        return None
    candidates: list[str] = []
    for raw_line in lines:
        line = raw_line.strip()
        if line.startswith("Environment="):
            try:
                tokens = shlex.split(line.removeprefix("Environment="), posix=True)
            except ValueError:
                continue
            for token in tokens:
                if token.startswith("ENTERPRISE_PLATFORM_DATA="):
                    candidates.append(token.split("=", 1)[1])
        elif line.startswith("ExecStart="):
            try:
                tokens = shlex.split(line.removeprefix("ExecStart="), posix=True)
            except ValueError:
                continue
            for index, token in enumerate(tokens[:-1]):
                if token == "--data":
                    candidates.append(tokens[index + 1])
    for value in candidates:
        if not value or any(char in value for char in "\x00\r\n"):
            continue
        candidate = Path(value).expanduser()
        if candidate.is_absolute():
            try:
                name = _validate_service_name(service_path.name)
            except DeploymentError:
                return None
            return ExistingServiceDeployment(
                service_name=name,
                data_dir=candidate.resolve(strict=False),
            )
    try:
        name = _validate_service_name(service_path.name)
    except DeploymentError:
        return None
    return ExistingServiceDeployment(service_name=name, data_dir=None)


def _service_unit_matches_root(service_path: Path, root: Path) -> bool:
    try:
        lines = service_path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        return False
    expected_working = str((root / "enterprise-agent-platform").resolve(strict=False))
    expected_cli = str((root / ".venv" / "bin" / "enterprise-agent-platform").resolve(strict=False))
    for raw_line in lines:
        line = raw_line.strip()
        if line.startswith("WorkingDirectory="):
            value = line.removeprefix("WorkingDirectory=").strip().strip('"')
            value = value.replace("\\x20", " ").replace("%%", "%")
            if str(Path(value).expanduser().resolve(strict=False)) == expected_working:
                return True
        if line.startswith("ExecStart="):
            try:
                tokens = shlex.split(line.removeprefix("ExecStart="), posix=True)
            except ValueError:
                continue
            if tokens and str(Path(tokens[0]).expanduser().resolve(strict=False)) == expected_cli:
                return True
    return False


def _user_service_directory() -> Path:
    return Path(os.getenv("XDG_CONFIG_HOME", "~/.config")).expanduser() / "systemd" / "user"



def _validate_service_name(value: str) -> str:
    clean = str(value or "").strip()
    if (
        len(clean) > 255
        or not re.fullmatch(r"[A-Za-z0-9_.@:-]+\.service", clean)
        or clean.startswith((".", "-"))
    ):
        raise DeploymentError(f"invalid platform service name: {value!r}")
    return clean



def main(argv: list[str] | None = None) -> None:
    if argv is None:
        argv = sys.argv[1:]
    if not argv:
        argv = ["bootstrap"]
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.cmd in {None, "bootstrap"}:
        bootstrap_from_args(args)
        return
    parser.error(f"unknown command: {args.cmd}")


def _venv_executable(venv_dir: Path, name: str) -> Path:
    suffix = ".exe" if os.name == "nt" and not name.endswith(".exe") else ""
    folder = "Scripts" if os.name == "nt" else "bin"
    return venv_dir / folder / f"{name}{suffix}"


def _default_repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _quote_arg(value: str) -> str:
    if not value or any(ch.isspace() for ch in value):
        return '"' + value.replace('"', '\\"') + '"'
    return value


def _systemd_quote(value: str) -> str:
    if any(char in value for char in "\x00\r\n"):
        raise DeploymentError("systemd unit value contains unsupported control characters")
    return (
        '"'
        + value.replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%")
        + '"'
    )


def _systemd_path_value(path: Path) -> str:
    value = str(path)
    if any(char in value for char in "\x00\r\n"):
        raise DeploymentError("systemd path contains unsupported control characters")
    return value.replace("\\", "\\\\").replace(" ", "\\x20").replace("%", "%%")


if __name__ == "__main__":
    main()
