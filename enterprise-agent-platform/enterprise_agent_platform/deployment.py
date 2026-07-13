from __future__ import annotations

import argparse
import fcntl
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
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, replace
from pathlib import Path
from pathlib import PurePosixPath
from typing import Any, Iterator, Protocol

from .config import PlatformConfig
from .db import Database
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
MAX_CUTOVER_MARKER_BYTES = 64 * 1024
MAX_LEGACY_SESSION_MANIFEST_BYTES = 64 * 1024 * 1024
MAX_EXISTING_SERVICE_UNIT_BYTES = 1024 * 1024
INTERNAL_ROLLBACK_EXIT_CODE = 75
ACTIVATED_CLEANUP_PENDING_EXIT_CODE = 76
HANDOFF_UNIT_PREFIX = "ubitech-agent-cutover-"
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
LEGACY_HERMES_DIRECTORY = "hermes"
LEGACY_HERMES_QUARANTINE_PREFIX = ".retired-hermes-"
CUTOVER_MARKER_VERSION = 1
CUTOVER_PHASES = frozenset({"migrated", "quarantined", "activated", "finalized"})
PRODUCT_AGENT_MODELS = {
    "openai-codex": ("gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"),
    "xai-oauth": (
        "grok-4.3",
        "grok-4.20-0309-reasoning",
        "grok-4.20-0309-non-reasoning",
    ),
}
AGENT_PROVIDER_ALIASES = {
    "openai-codex": "openai-codex",
    "codex": "openai-codex",
    "openai-codex-oauth": "openai-codex",
    "xai-oauth": "xai-oauth",
    "xai": "xai-oauth",
    "grok": "xai-oauth",
    "grok-oauth": "xai-oauth",
    "xai-grok-oauth": "xai-oauth",
}


class DeploymentError(RuntimeError):
    pass


class ActivatedCleanupPending(DeploymentError):
    """Pi is committed and healthy, but retired Hermes cleanup must retry."""


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

    @property
    def legacy_hermes_home(self) -> Path:
        return self.data_dir / "runtimes" / LEGACY_HERMES_DIRECTORY

    @property
    def cutover_marker(self) -> Path:
        return self.data_dir / "runtimes" / "agent" / "migration" / "hermes-cutover.json"


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
        previous_revision: str | None = None,
        internal_first_hop_owner: bool = False,
    ):
        self.paths = paths
        self.runner = runner or SubprocessRunner()
        self.previous_revision = previous_revision
        self.internal_first_hop_owner = internal_first_hop_owner

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

        # The pre-Pi updater could fall back to a detached child that remained
        # inside the platform service cgroup. Stopping that service here would
        # kill the updater halfway through the migration. Move the work to its
        # own user-systemd unit before any recovery or stop operation instead.
        legacy_before_recovery = self._legacy_hermes_present()
        marker_before_recovery = self._read_cutover_marker()
        precommit_recovery = bool(
            marker_before_recovery
            and marker_before_recovery.get("phase") in {"migrated", "quarantined"}
        )
        if (
            mode in {"auto", "service"}
            and (legacy_before_recovery or precommit_recovery)
            and (
                (self.previous_revision is not None and not self.internal_first_hop_owner)
                or self._running_inside_target_service()
            )
        ):
            try:
                self._launch_independent_cutover(host=host, port=port)
            except Exception as exc:
                print(
                    f"WARNING: independent migration handoff failed: {exc}",
                    file=sys.stderr,
                    flush=True,
                )
                if self.rollback_first_hop_update(
                    host=host,
                    port=port,
                    restart_service=False,
                ):
                    return DeploymentResult(
                        mode="rollback",
                        url=self.effective_public_url(host, port),
                    )
                raise
            return DeploymentResult(
                mode="handoff",
                url=self.effective_public_url(host, port),
                service_path=str(self.paths.service_path),
            )
        self.recover_interrupted_cutover()

        legacy_present = self._legacy_hermes_present()

        if mode == "prepare":
            # No service is (re)started in this mode, so the runtime must be
            # prepared here from the deploy process.  A live Hermes service
            # may still own the platform database, so the first-hop update is
            # limited to building the new sidecar without opening SQLite.
            if prepare_runtime:
                self.prepare_agent_runtime_artifact(host=host, port=port)
            return DeploymentResult(mode=mode, url=self.effective_public_url(host, port))
        if legacy_present:
            if mode == "foreground":
                raise DeploymentError(
                    "the Hermes-to-Pi migration requires the managed user service; "
                    "run './deploy.sh service' once, then use foreground mode if desired"
                )
            if mode not in {"service", "auto"}:
                raise DeploymentError(f"unknown deploy mode: {mode}")
            if not self.user_systemd_available():
                raise DeploymentError(
                    "the Hermes-to-Pi migration cannot safely stop the existing instance "
                    "because the user systemd manager is unavailable"
                )
            service_path = self.cutover_legacy_hermes(host=host, port=port)
            return DeploymentResult(
                mode="service",
                url=self.effective_public_url(host, port),
                service_path=str(service_path),
                service_started=True,
            )
        if mode == "service":
            # Publish the sidecar that matches the checked-out source before
            # restarting the platform. The installer compares its persisted
            # source signature, so this is cheap when nothing changed and is
            # also what restores the matching sidecar after an update rollback.
            self.prepare_agent_runtime_artifact(host=host, port=port)
            service_path = self.install_user_service(host=host, port=port)
            return DeploymentResult(mode=mode, url=self.effective_public_url(host, port), service_path=str(service_path), service_started=True)
        if mode == "foreground":
            # The foreground server prepares the runtime on startup in its own
            # single process, so no separate prepare step is needed here.
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

        Deployments made before the Pi runtime did not require Node at all.  An
        automatic Hermes-to-Pi update therefore cannot assume a suitable
        binary is already present.  The managed fallback is checksum pinned,
        lives below the platform data directory, and never modifies the host's
        package manager or global PATH.
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

    def prepare_platform_runtime(self, *, host: str, port: int) -> dict[str, object]:
        """Prepare all runtimes when the platform database may be migrated.

        Call this only for a fresh/offline deployment or after the old service
        has stopped.  ``Database`` intentionally runs schema migrations, which
        must not race the pre-update service during the Hermes cutover.
        """

        config = self._platform_config(host=host, port=port)
        database = Database(config.db_path)

        def setting_provider(key: str) -> str | None:
            row = database.query_one("SELECT value FROM settings WHERE key = ?", (key,))
            return str(row["value"]) if row else None

        def secret_provider(key: str) -> str:
            row = database.query_one(
                "SELECT value FROM settings WHERE key = ? AND secret = 1",
                (key,),
            )
            return str(row["value"]) if row else os.getenv(key, "")

        runtimes = PlatformRuntimeManager(
            config,
            secret_provider,
            setting_provider=setting_provider,
        )
        try:
            agent_status = runtimes.agent_runtime_status(refresh=False)
            if runtimes.agent_runtime_config().get("managed"):
                agent_status = runtimes.install_agent_runtime(force=False)
                if not agent_status.available:
                    raise DeploymentError(
                        agent_status.error or "Agent runtime preparation failed"
                    )
            statuses = runtimes.prepare()
            statuses["agent"] = agent_status.to_dict()
            return statuses
        finally:
            runtimes.close()
            database.close()

    def prepare_agent_runtime_artifact(self, *, host: str, port: int) -> dict[str, object]:
        """Build/publish Pi without opening the live database in migration mode."""

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
            status = runtimes.install_agent_runtime(force=False)
            if not status.available:
                raise DeploymentError(status.error or "Agent runtime preparation failed")
            return status.to_dict()
        finally:
            runtimes.close()

    def cutover_legacy_hermes(self, *, host: str, port: int) -> Path:
        """Perform the one-time, rollback-safe Hermes-to-Pi service cutover.

        The sidecar is published while the old service is live.  Everything
        that reads mutable Hermes state happens only after systemd has stopped
        the service and this process owns the platform instance lock.  Hermes
        is then atomically moved out of its operational path; it is restored
        before an error is returned unless the new platform and Pi runtime have
        both passed their strict health probes.
        """

        self.prepare_agent_runtime_artifact(host=host, port=port)
        self._stop_user_service()
        quarantine: Path | None = None
        marker: dict[str, Any] = {
            "version": CUTOVER_MARKER_VERSION,
            "phase": "migrated",
            "updated_at": int(time.time()),
        }
        activated = False
        try:
            with self._exclusive_instance_lock():
                config = self._platform_config(host=host, port=port)
                database = Database(config.db_path)
                try:
                    migration = self._migrate_legacy_hermes(database, config=config)
                finally:
                    database.close()
                marker.update(self._migration_counts(migration))
                self._write_cutover_marker(marker)

                # Prepare non-Agent managed runtime state only after the old
                # service is stopped; this also applies any new DB schema.
                self.prepare_platform_runtime(host=host, port=port)
                quarantine = self._quarantine_legacy_hermes()
                marker.update(
                    {
                        "phase": "quarantined",
                        "quarantine_name": quarantine.name,
                        "updated_at": int(time.time()),
                    }
                )
                self._write_cutover_marker(marker)

            service_path = self.install_user_service(host=host, port=port)
            marker.update({"phase": "activated", "updated_at": int(time.time())})
            self._write_cutover_marker(marker)
            activated = True
        except BaseException:
            if not activated:
                try:
                    self._stop_user_service()
                except Exception:
                    # The instance lock below is the authoritative proof that
                    # no platform process can still touch SQLite or Hermes.
                    pass
                with self._exclusive_instance_lock():
                    if quarantine is not None:
                        self._restore_legacy_quarantine(quarantine)
                    marker.pop("quarantine_name", None)
                    marker.update({"phase": "migrated", "updated_at": int(time.time())})
                    self._write_cutover_marker(marker)
            raise

        # The durable activated marker is the irreversible commit point. Any
        # remaining bookkeeping or deletion failure is reported as a distinct
        # retryable state: the persistent handoff unit must restart this code,
        # while neither Python nor deploy.sh may roll source back to Hermes.
        try:
            database = Database(self._platform_config(host=host, port=port).db_path)
            try:
                from .legacy_migration import finalize_legacy_hermes_migration

                finalize_legacy_hermes_migration(database, migration)
            finally:
                database.close()
            if not self._remove_legacy_quarantine(quarantine):
                raise ActivatedCleanupPending(
                    "retired Hermes runtime cleanup is pending"
                )
            marker.pop("quarantine_name", None)
            marker.update({"phase": "finalized", "updated_at": int(time.time())})
            self._write_cutover_marker(marker)
        except Exception:
            print(
                "WARNING: activated Hermes cleanup will be retried by the migration owner.",
                file=sys.stderr,
                flush=True,
            )
            raise ActivatedCleanupPending(
                "activated Hermes cleanup is pending"
            ) from None
        self._retire_legacy_source_checkout()
        return service_path

    def _migrate_legacy_hermes(self, database: Database, *, config: PlatformConfig):
        from .legacy_migration import migrate_legacy_hermes_data

        provider, model = self._ensure_agent_runtime_settings(database, config=config)
        return migrate_legacy_hermes_data(
            database,
            self.paths.data_dir,
            hermes_home=self.paths.legacy_hermes_home,
            session_importer=lambda manifests: self._import_legacy_sessions(
                manifests,
                runtime_home=config.managed_agent_runtime_home,
                provider=provider,
                model=model,
            ),
        )

    @staticmethod
    def _ensure_agent_runtime_settings(
        database: Database,
        *,
        config: PlatformConfig,
    ) -> tuple[str, str]:
        def setting(*keys: str) -> str:
            for key in keys:
                row = database.query_one("SELECT value FROM settings WHERE key = ?", (key,))
                if row and str(row["value"] or "").strip():
                    return str(row["value"]).strip()
            return ""

        raw_provider = setting("hermes_provider", "agent_runtime_provider") or config.agent_runtime_provider
        provider = AGENT_PROVIDER_ALIASES.get(raw_provider.strip().lower())
        if provider is None:
            raise DeploymentError(
                "unsupported legacy Agent provider; choose Codex OAuth or Grok OAuth before updating"
            )
        allowed_models = PRODUCT_AGENT_MODELS[provider]
        requested_model = setting("hermes_model", "agent_runtime_model")
        configured_default = str(config.agent_runtime_model or "").strip()
        model = requested_model if requested_model in allowed_models else configured_default
        if model not in allowed_models:
            model = allowed_models[0]
        timeout_value = setting("hermes_timeout_seconds", "agent_runtime_timeout_seconds")
        try:
            timeout = str(max(1.0, float(timeout_value or config.agent_runtime_timeout_seconds)))
        except ValueError:
            timeout = str(max(1.0, config.agent_runtime_timeout_seconds))
        timestamp = int(time.time())
        with database.transaction() as connection:
            connection.execute("BEGIN IMMEDIATE")
            for key, value in (
                ("agent_runtime_provider", provider),
                ("agent_runtime_model", model),
                ("agent_runtime_timeout_seconds", timeout),
            ):
                connection.execute(
                    """
                    INSERT INTO settings(key, value, secret, updated_at)
                    VALUES (?, ?, 0, ?)
                    ON CONFLICT(key) DO UPDATE SET
                        value=excluded.value,
                        secret=0,
                        updated_at=excluded.updated_at
                    """,
                    (key, value, timestamp),
                )
        return provider, model

    @staticmethod
    def _migration_counts(result: object) -> dict[str, int]:
        counts: dict[str, int] = {}
        for name in (
            "imported",
            "skipped",
            "session_manifests",
            "session_messages",
            "memories_imported",
            "memories_skipped",
            "oauth_imported",
            "oauth_skipped",
            "oauth_cleared",
            "workspaces_verified",
            "workspaces_skipped",
            "attachments_verified",
            "attachments_skipped",
        ):
            value = getattr(result, name, None)
            if isinstance(value, int) and value >= 0:
                counts[name] = value
        return counts

    def _import_legacy_sessions(
        self,
        manifests: list[object],
        *,
        runtime_home: Path,
        provider: str,
        model: str,
    ):
        from .legacy_migration import LegacySessionImportResult

        if not manifests:
            return LegacySessionImportResult(imported=0, skipped=0)
        sessions: list[dict[str, Any]] = []
        for item in manifests:
            messages = [
                {
                    "role": str(message.role),
                    "content": str(message.content),
                    "timestamp": int(message.timestamp),
                }
                for message in item.messages
            ]
            sessions.append(
                {
                    "scope_key": str(item.scope_key),
                    "session_id": str(item.session_id),
                    "lifecycle_id": str(item.lifecycle_id),
                    "model": {"provider": provider, "id": model},
                    "messages": messages,
                }
            )
        payload = {"version": 1, "sessions": sessions}
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(encoded) > MAX_LEGACY_SESSION_MANIFEST_BYTES:
            raise DeploymentError("legacy session migration manifest exceeds the size limit")
        migration_dir = runtime_home / "migration"
        self._ensure_private_runtime_directories(migration_dir)
        self._remove_stale_session_manifests(migration_dir)
        descriptor, raw_path = tempfile.mkstemp(prefix="legacy-sessions-", suffix=".json", dir=migration_dir)
        manifest_path = Path(raw_path)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            node = shutil.which("node")
            importer = runtime_home / "app" / "dist" / "src" / "legacy-session-importer.js"
            if node is None or not importer.is_file():
                raise DeploymentError("legacy session importer is not available in the managed Agent runtime")
            result = subprocess.run(
                [
                    node,
                    str(importer),
                    "--manifest",
                    str(manifest_path),
                    "--home",
                    str(runtime_home),
                ],
                cwd=str(runtime_home / "app"),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=300,
                check=False,
            )
            if result.returncode != 0:
                detail = (result.stderr or result.stdout or "").strip()[:1000]
                raise DeploymentError(
                    "legacy session import failed"
                    + (f": {detail}" if detail else f" with exit code {result.returncode}")
                )
            try:
                summary = json.loads(result.stdout or "{}")
                imported = int(summary.get("created", 0)) + int(summary.get("replaced", 0))
                skipped = int(summary.get("skipped", 0))
                invalid = int(summary.get("invalid", 0))
                total = int(summary.get("total", -1))
            except (TypeError, ValueError, json.JSONDecodeError) as exc:
                raise DeploymentError("legacy session importer returned an invalid summary") from exc
            if invalid or total != len(sessions) or imported + skipped != total:
                raise DeploymentError("legacy session importer did not account for every session")
            return LegacySessionImportResult(imported=imported, skipped=skipped)
        finally:
            manifest_path.unlink(missing_ok=True)

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

    @staticmethod
    def _remove_stale_session_manifests(migration_dir: Path) -> None:
        """Remove only private regular manifests left by an interrupted import."""

        try:
            candidates = list(migration_dir.glob("legacy-sessions-*.json"))
        except OSError as exc:
            raise DeploymentError(f"unable to inspect legacy session manifests: {exc}") from exc
        if len(candidates) > 10_000:
            raise DeploymentError("too many stale legacy session manifests")
        for candidate in candidates:
            try:
                metadata = candidate.lstat()
            except FileNotFoundError:
                continue
            except OSError as exc:
                raise DeploymentError(f"unable to inspect stale legacy session manifest: {exc}") from exc
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
                raise DeploymentError("stale legacy session manifest must be a regular file")
            if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
                raise DeploymentError("stale legacy session manifest is not owned by the service user")
            try:
                candidate.unlink()
            except OSError as exc:
                raise DeploymentError(f"unable to remove stale legacy session manifest: {exc}") from exc

    def _legacy_hermes_present(self) -> bool:
        path = self.paths.legacy_hermes_home
        self._ensure_private_runtime_directories(path.parent)
        try:
            metadata = path.lstat()
        except FileNotFoundError:
            return False
        if stat.S_ISLNK(metadata.st_mode):
            raise DeploymentError(f"legacy Hermes path must not be a symlink: {path}")
        if not stat.S_ISDIR(metadata.st_mode):
            raise DeploymentError(f"legacy Hermes path is not a directory: {path}")
        return True

    def _quarantine_legacy_hermes(self) -> Path:
        if not self._legacy_hermes_present():
            raise DeploymentError("legacy Hermes runtime disappeared before cutover")
        runtime_root = self.paths.legacy_hermes_home.parent
        quarantine = runtime_root / f"{LEGACY_HERMES_QUARANTINE_PREFIX}{uuid.uuid4().hex}"
        os.replace(self.paths.legacy_hermes_home, quarantine)
        _fsync_directory(runtime_root)
        return quarantine

    def _restore_legacy_quarantine(self, quarantine: Path) -> None:
        self._validate_quarantine_path(quarantine)
        legacy = self.paths.legacy_hermes_home
        if os.path.lexists(legacy):
            raise DeploymentError(
                f"cannot restore Hermes because its runtime path already exists: {legacy}"
            )
        os.replace(quarantine, legacy)
        _fsync_directory(legacy.parent)

    def _remove_legacy_quarantine(self, quarantine: Path | None) -> bool:
        if quarantine is None or not os.path.lexists(quarantine):
            return True
        self._validate_quarantine_path(quarantine)
        try:
            shutil.rmtree(quarantine)
            _fsync_directory(quarantine.parent)
            return True
        except OSError as exc:
            print(
                f"WARNING: retired Hermes runtime cleanup will be retried later: {exc}",
                file=sys.stderr,
                flush=True,
            )
            return False

    def _validate_quarantine_path(self, path: Path) -> None:
        expected_parent = self.paths.legacy_hermes_home.parent
        if path.parent != expected_parent or not path.name.startswith(LEGACY_HERMES_QUARANTINE_PREFIX):
            raise DeploymentError("invalid retired Hermes quarantine path")
        try:
            metadata = path.lstat()
        except FileNotFoundError:
            return
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise DeploymentError("retired Hermes quarantine is not a regular directory")

    def recover_interrupted_cutover(self) -> None:
        marker = self._read_cutover_marker()
        quarantines = self._legacy_quarantines()
        if marker is None:
            if quarantines:
                raise DeploymentError(
                    "retired Hermes data exists without a cutover marker; manual inspection is required"
                )
            return
        phase = str(marker.get("phase") or "")
        named = str(marker.get("quarantine_name") or "")
        quarantine = self.paths.legacy_hermes_home.parent / named if named else None
        if quarantine is not None:
            self._validate_quarantine_path(quarantine)
        elif len(quarantines) == 1:
            quarantine = quarantines[0]
        elif len(quarantines) > 1:
            raise DeploymentError("multiple retired Hermes directories require manual inspection")

        legacy_present = self._legacy_hermes_present()
        quarantine_present = quarantine is not None and os.path.lexists(quarantine)
        if phase in {"migrated", "quarantined"} and legacy_present and quarantine_present:
            raise DeploymentError(
                "both active and quarantined Hermes runtimes exist; manual inspection is required"
            )
        if phase in {"migrated", "quarantined"} and not legacy_present:
            if quarantine is None or not os.path.lexists(quarantine):
                raise DeploymentError("interrupted Hermes cutover cannot locate the quarantined runtime")
            self._stop_user_service()
            with self._exclusive_instance_lock():
                self._restore_legacy_quarantine(quarantine)
                marker.pop("quarantine_name", None)
                marker.update({"phase": "migrated", "updated_at": int(time.time())})
                self._write_cutover_marker(marker)
            return
        if phase in {"activated", "finalized"} and legacy_present:
            raise DeploymentError(
                "Hermes runtime reappeared after Pi activation; manual inspection is required"
            )
        if phase in {"activated", "finalized"}:
            try:
                if phase == "activated":
                    database = Database(self.paths.data_dir / "platform.db")
                    try:
                        from .legacy_migration import finalize_legacy_hermes_migration

                        finalize_legacy_hermes_migration(database)
                    finally:
                        database.close()
                if quarantine is not None and not self._remove_legacy_quarantine(quarantine):
                    raise ActivatedCleanupPending(
                        "retired Hermes runtime cleanup is pending"
                    )
                marker.pop("quarantine_name", None)
                marker.update({"phase": "finalized", "updated_at": int(time.time())})
                self._write_cutover_marker(marker)
                self._retire_legacy_source_checkout()
            except Exception:
                # Activation is the durable commit point. Tell the persistent
                # owner to retry without exposing source rollback semantics.
                print(
                    "WARNING: activated Hermes cleanup will be retried by the migration owner.",
                    file=sys.stderr,
                    flush=True,
                )
                raise ActivatedCleanupPending(
                    "activated Hermes cleanup is pending"
                ) from None
            return

    def _legacy_quarantines(self) -> list[Path]:
        root = self.paths.legacy_hermes_home.parent
        if not root.is_dir():
            return []
        found = sorted(root.glob(f"{LEGACY_HERMES_QUARANTINE_PREFIX}*"))
        for path in found:
            self._validate_quarantine_path(path)
        return found

    def _read_cutover_marker(self) -> dict[str, Any] | None:
        path = self.paths.cutover_marker
        self._ensure_private_runtime_directories(path.parent)
        try:
            metadata = path.lstat()
        except FileNotFoundError:
            return None
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise DeploymentError("Hermes cutover marker must be a regular file")
        if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
            raise DeploymentError("Hermes cutover marker is not owned by the service user")
        if metadata.st_size > MAX_CUTOVER_MARKER_BYTES:
            raise DeploymentError("Hermes cutover marker exceeds the size limit")
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise DeploymentError(f"unable to read Hermes cutover marker: {exc}") from exc
        if (
            not isinstance(payload, dict)
            or payload.get("version") != CUTOVER_MARKER_VERSION
            or payload.get("phase") not in CUTOVER_PHASES
        ):
            raise DeploymentError("Hermes cutover marker has an unsupported format")
        return payload

    def _write_cutover_marker(self, payload: dict[str, Any]) -> None:
        path = self.paths.cutover_marker
        self._ensure_private_runtime_directories(path.parent)
        encoded = (json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
        if len(encoded) > MAX_CUTOVER_MARKER_BYTES:
            raise DeploymentError("Hermes cutover marker exceeds the size limit")
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(temporary, flags, 0o600)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
            _fsync_directory(path.parent)
        finally:
            temporary.unlink(missing_ok=True)

    @contextmanager
    def _exclusive_instance_lock(self) -> Iterator[None]:
        self._ensure_private_runtime_directories(self.paths.data_dir)
        lock_path = self.paths.data_dir / ".enterprise-platform.lock"
        flags = os.O_RDWR | os.O_CREAT
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            descriptor = os.open(lock_path, flags, 0o600)
        except OSError as exc:
            raise DeploymentError(f"unable to open the platform instance lock: {exc}") from exc
        deadline = time.monotonic() + service_stop_timeout_seconds()
        try:
            while True:
                try:
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError as exc:
                    if time.monotonic() >= deadline:
                        raise DeploymentError(
                            "the old platform process did not release its instance lock"
                        ) from exc
                    time.sleep(0.25)
            os.fchmod(descriptor, 0o600)
            os.ftruncate(descriptor, 0)
            os.write(descriptor, f"migration:{os.getpid()}\n".encode("ascii"))
            yield
        finally:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
            finally:
                os.close(descriptor)

    def _stop_user_service(self) -> None:
        result = self.runner.run(
            ["systemctl", "--user", "stop", self.paths.service_name],
            timeout=service_stop_timeout_seconds() + 30,
            check=False,
        )
        if result.returncode != 0:
            raise DeploymentError("unable to stop the existing platform service")
        deadline = time.monotonic() + service_stop_timeout_seconds()
        while True:
            active = self.runner.run(
                ["systemctl", "--user", "is-active", self.paths.service_name],
                timeout=20,
                check=False,
            )
            if active.returncode != 0:
                return
            if time.monotonic() >= deadline:
                raise DeploymentError("the existing platform service did not stop in time")
            time.sleep(0.5)

    def _running_inside_target_service(self) -> bool:
        """Return whether this updater would kill itself by stopping the service."""

        current_invocation = os.getenv("INVOCATION_ID", "").strip()
        target_invocation = _capture_command_stdout(
            [
                "systemctl",
                "--user",
                "show",
                self.paths.service_name,
                "--property=InvocationID",
                "--value",
            ]
        ).strip()
        if current_invocation and target_invocation:
            return current_invocation == target_invocation

        target_group = _capture_command_stdout(
            [
                "systemctl",
                "--user",
                "show",
                self.paths.service_name,
                "--property=ControlGroup",
                "--value",
            ]
        ).strip().rstrip("/")
        try:
            lines = Path("/proc/self/cgroup").read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError):
            return False
        for line in lines:
            parts = line.split(":", 2)
            if len(parts) != 3:
                continue
            current_group = parts[2].strip().rstrip("/")
            if target_group and (
                current_group == target_group or current_group.startswith(target_group + "/")
            ):
                return True
            # If the manager query itself failed, the cgroup component still
            # identifies a child inherited from the target service. A
            # transient updater has its own, different unit component.
            if not target_group and self.paths.service_name in current_group.split("/"):
                return True
        return False

    def _launch_independent_cutover(self, *, host: str, port: int) -> None:
        """Hand the first hop to a boot-persistent, restartable systemd unit."""

        previous = self.previous_revision
        if not previous:
            raise DeploymentError(
                "the legacy updater could not verify its previous revision"
            )
        if not host or any(char in host for char in "\x00\r\n") or not 1 <= int(port) <= 65535:
            raise DeploymentError("invalid platform address for migration handoff")
        target_revision = _canonical_commit(self.paths.root, "HEAD")
        git = shutil.which("git")
        bash = shutil.which("bash")
        flock = shutil.which("flock")
        if target_revision is None or git is None or bash is None or flock is None:
            raise DeploymentError("unable to pin the migration handoff source revision")
        update_lock = _git_update_lock_path(self.paths.root, git=git)
        unit_name = f"{HANDOFF_UNIT_PREFIX}{time.time_ns()}-{os.getpid()}.service"
        command = [
            str(self.paths.root / "deploy.sh"),
            "update",
            "--data",
            str(self.paths.data_dir),
            "--service-name",
            self.paths.service_name,
            "--host",
            host,
            "--port",
            str(port),
        ]
        environment = {
            "ENTERPRISE_PLATFORM_DATA": str(self.paths.data_dir),
            "ENTERPRISE_SERVICE_NAME": self.paths.service_name,
            "ENTERPRISE_UPDATE_PREV_SHA": previous,
            "ENTERPRISE_UPDATE_TARGET_SHA": target_revision,
            "ENTERPRISE_INTERNAL_FIRST_HOP_OWNER": "1",
            "ENTERPRISE_INTERNAL_HANDOFF_UNIT": unit_name,
            "PYTHON_BIN": sys.executable,
        }
        owner_script = "; ".join(
            (
                "set -euo pipefail",
                f"exec 9>{shlex.quote(str(update_lock))}",
                f"{shlex.quote(flock)} -n 9",
                "worktree_status=$("
                + shlex.join(
                    [
                        git,
                        "-C",
                        str(self.paths.root),
                        "status",
                        "--porcelain=v1",
                        "--untracked-files=all",
                    ]
                )
                + ")",
                "if [ -n \"$worktree_status\" ]; then echo 'Migration owner found local repository changes; retrying without overwrite.' >&2; exit 1; fi",
                shlex.join(
                    [
                        git,
                        "-C",
                        str(self.paths.root),
                        "reset",
                        "--keep",
                        target_revision,
                    ]
                ),
                shlex.join(
                    [
                        git,
                        "-C",
                        str(self.paths.root),
                        "submodule",
                        "update",
                        "--init",
                        "--recursive",
                    ]
                ),
                "export ENTERPRISE_INTERNAL_UPDATE_LOCK_HELD=1",
                "exec " + shlex.join(command),
            )
        )
        self.paths.service_dir.mkdir(parents=True, exist_ok=True)
        unit_path = self.paths.service_dir / unit_name
        lines = [
            "[Unit]",
            "Description=ubitech agent one-time migration handoff",
            "After=network-online.target",
            "Wants=network-online.target",
            "",
            "[Service]",
            "Type=oneshot",
            f"WorkingDirectory={_systemd_path_value(self.paths.root)}",
            *[
                f"Environment={_systemd_quote(f'{key}={value}')}"
                for key, value in environment.items()
            ],
            # This stable unit-owned shell keeps the repository lock across
            # source pinning, submodule sync, and deploy execution. It remains
            # safe even if a prior recovery restored the old deploy.sh or a
            # concurrent updater published a newer remote commit.
            # ':' is systemd's no-environment-expansion prefix. Bash, not
            # systemd, must receive the command substitutions and local
            # $worktree_status variable in owner_script verbatim.
            "ExecStart=:"
            + " ".join(_systemd_quote(part) for part in (bash, "-c", owner_script)),
            "Restart=on-failure",
            "RestartSec=5",
            "TimeoutStartSec=0",
            "",
            "[Install]",
            "WantedBy=default.target",
            "",
        ]
        temporary = unit_path.with_name(f".{unit_path.name}.{uuid.uuid4().hex}.tmp")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            descriptor = os.open(temporary, flags, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write("\n".join(lines))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, unit_path)
            _fsync_directory(unit_path.parent)
            self.runner.run(["systemctl", "--user", "daemon-reload"], timeout=30)
            self.runner.run(
                ["systemctl", "--user", "enable", unit_name],
                timeout=30,
            )
            started = self.runner.run(
                ["systemctl", "--user", "start", "--no-block", unit_name],
                timeout=30,
                check=False,
            )
            if started.returncode != 0:
                raise DeploymentError("unable to start the independent migration handoff unit")
        except BaseException:
            try:
                self.runner.run(
                    ["systemctl", "--user", "disable", unit_name],
                    timeout=30,
                    check=False,
                )
            except Exception:
                pass
            unit_path.unlink(missing_ok=True)
            try:
                self.runner.run(
                    ["systemctl", "--user", "daemon-reload"], timeout=30, check=False
                )
            except Exception:
                pass
            raise
        finally:
            temporary.unlink(missing_ok=True)
        print("Hermes migration handed to an independent update unit.", flush=True)

    def rollback_first_hop_update(
        self,
        *,
        host: str,
        port: int,
        restart_service: bool,
    ) -> bool:
        """Restore the verified pre-update checkout and, when safe, its service."""

        previous = self.previous_revision
        if not previous or not _revision_is_valid_update_base(self.paths.root, previous):
            return False
        try:
            marker = self._read_cutover_marker()
            legacy_present = self._legacy_hermes_present()
        except DeploymentError:
            print(
                "CRITICAL: refusing source rollback because Hermes cutover state could not be verified.",
                file=sys.stderr,
                flush=True,
            )
            return False
        if marker is not None and marker.get("phase") in {"activated", "finalized"}:
            print(
                "CRITICAL: refusing source rollback after the Pi activation commit point.",
                file=sys.stderr,
                flush=True,
            )
            return False
        if not legacy_present:
            print(
                "CRITICAL: refusing source rollback because the legacy Hermes runtime is unavailable.",
                file=sys.stderr,
                flush=True,
            )
            return False
        quarantines = self._legacy_quarantines()
        if quarantines:
            print(
                "CRITICAL: refusing source rollback while retired Hermes quarantine still exists.",
                file=sys.stderr,
                flush=True,
            )
            return False
        try:
            worktree = subprocess.run(
                [
                    "git",
                    "-C",
                    str(self.paths.root),
                    "status",
                    "--porcelain=v1",
                    "--untracked-files=all",
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=30,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            return False
        if worktree.returncode != 0 or worktree.stdout.strip():
            print(
                "CRITICAL: refusing automatic source rollback because the repository gained local changes.",
                file=sys.stderr,
                flush=True,
            )
            return False
        print(
            f"The new runtime did not activate; restoring revision {previous}.",
            file=sys.stderr,
            flush=True,
        )
        reset = subprocess.run(
            ["git", "-C", str(self.paths.root), "reset", "--keep", previous],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=120,
            check=False,
        )
        if reset.returncode != 0:
            return False
        submodules = subprocess.run(
            [
                "git",
                "-C",
                str(self.paths.root),
                "submodule",
                "update",
                "--init",
                "--recursive",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=1800,
            check=False,
        )
        if submodules.returncode != 0:
            print(
                "CRITICAL: previous source was restored but its submodules could not be restored.",
                file=sys.stderr,
                flush=True,
            )
            if not restart_service:
                return True
        if not restart_service:
            print("The running Hermes service was left untouched; the update will retry later.", flush=True)
            return True

        env = os.environ.copy()
        env["PYTHONPATH"] = str(self.paths.platform_dir)
        command = [
            sys.executable,
            "-m",
            "enterprise_agent_platform.deployment",
            "bootstrap",
            "--root",
            str(self.paths.root),
            "--mode",
            "auto",
            "--data",
            str(self.paths.data_dir),
            "--service-name",
            self.paths.service_name,
            "--host",
            host,
            "--port",
            str(port),
        ]
        restored = subprocess.run(
            command,
            cwd=str(self.paths.root),
            env=env,
            timeout=1800,
            check=False,
        )
        if restored.returncode != 0:
            print(
                "CRITICAL: previous source and Hermes data were restored, but the old service redeploy failed.",
                file=sys.stderr,
                flush=True,
            )
            return False
        print(f"Rolled back safely to {previous}.", file=sys.stderr, flush=True)
        return True

    def _stop_user_service_best_effort(self) -> None:
        try:
            self.runner.run(
                ["systemctl", "--user", "stop", self.paths.service_name],
                timeout=service_stop_timeout_seconds() + 30,
                check=False,
            )
        except Exception:
            pass

    def _retire_legacy_source_checkout(self) -> None:
        checkout = self.paths.root / "hermes-agent"
        try:
            metadata = checkout.lstat()
        except FileNotFoundError:
            return
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            print(f"WARNING: not removing unexpected legacy checkout: {checkout}", file=sys.stderr)
            return
        try:
            result = subprocess.run(
                [
                    "git",
                    "-C",
                    str(checkout),
                    "status",
                    "--porcelain=v1",
                    "--untracked-files=all",
                    "--ignored=matching",
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=30,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            return
        if result.returncode != 0 or result.stdout.strip():
            print(
                f"WARNING: keeping legacy Hermes source checkout because it is not clean: {checkout}",
                file=sys.stderr,
                flush=True,
            )
            return
        try:
            shutil.rmtree(checkout)
        except OSError as exc:
            print(f"WARNING: unable to remove legacy Hermes source checkout: {exc}", file=sys.stderr)

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
        """Require systemd, platform HTTP, and Pi runtime readiness.

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
    """Read legacy settings without running new-code schema migrations."""

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
    parser.add_argument(
        "--internal-first-hop-owner",
        action="store_true",
        default=_env_bool("ENTERPRISE_INTERNAL_FIRST_HOP_OWNER", False),
        help=argparse.SUPPRESS,
    )
    parser.add_argument("--internal-previous-revision", default="", help=argparse.SUPPRESS)
    parser.add_argument(
        "--internal-handoff-unit",
        default=os.getenv("ENTERPRISE_INTERNAL_HANDOFF_UNIT", ""),
        help=argparse.SUPPRESS,
    )


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
    previous_revision = _detect_previous_update_revision(
        root,
        explicit=str(getattr(args, "internal_previous_revision", "") or ""),
        internal_owner=bool(getattr(args, "internal_first_hop_owner", False)),
    )
    manager = DeploymentManager(
        paths,
        previous_revision=previous_revision,
        internal_first_hop_owner=bool(getattr(args, "internal_first_hop_owner", False)),
    )
    try:
        result = manager.bootstrap(
            host=args.host,
            port=args.port,
            mode=args.mode,
            skip_submodules=args.skip_submodules,
            prepare_runtime=not args.skip_runtime_prepare,
        )
    except ActivatedCleanupPending:
        return DeploymentResult(
            mode="cleanup-pending",
            url=DeploymentManager.public_url(args.host, args.port),
        )
    except BaseException:
        inside_target_service = False
        if previous_revision:
            try:
                inside_target_service = manager._running_inside_target_service()
            except Exception:
                inside_target_service = False
        if previous_revision:
            restored = manager.rollback_first_hop_update(
                host=args.host,
                port=args.port,
                restart_service=not inside_target_service,
            )
            if not restored:
                print(
                    "CRITICAL: automatic update recovery was incomplete; the old deploy shell is being suppressed to protect the discovered service context.",
                    file=sys.stderr,
                    flush=True,
                )
                if bool(getattr(args, "internal_first_hop_owner", False)):
                    # Keep the restartable owner alive until recovery can
                    # actually complete. Its deploy.sh explicitly suppresses
                    # shell-level hard resets for every non-zero child exit.
                    raise
            return DeploymentResult(
                mode="rollback",
                url=DeploymentManager.public_url(args.host, args.port),
            )
        raise
    if result.service_started:
        print(f"ubitech agent service started: {result.url}")
        print(f"Service file: {result.service_path}")
    elif result.mode == "prepare":
        print(f"ubitech agent prepared: {result.url}")
    elif result.mode == "handoff":
        print("ubitech agent migration continues in an independent update unit.")
    return result


def _existing_service_data_dir(service_name: str) -> Path | None:
    """Recover the old unit's data path during a first-hop auto update.

    Pre-Pi transient update units did not copy the service environment.  The
    persisted user unit is therefore the only reliable source for a custom
    data directory after the repository has already advanced to new code.
    Explicit ``--data``/environment input always wins over this fallback.
    """

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
    """Recover first-hop service identity from a unique unit for this checkout."""

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


def _cleanup_handoff_unit(root: Path, unit_name: str) -> None:
    """Disable/remove a persistent cutover owner only after a handled finish."""

    clean = _validate_service_name(unit_name)
    if not clean.startswith(HANDOFF_UNIT_PREFIX):
        raise DeploymentError("invalid migration handoff unit name")
    service_dir = _user_service_directory()
    unit_path = service_dir / clean
    try:
        metadata = unit_path.lstat()
    except FileNotFoundError:
        metadata = None
    if metadata is not None:
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise DeploymentError("migration handoff unit must be a regular file")
        if metadata.st_size > MAX_EXISTING_SERVICE_UNIT_BYTES:
            raise DeploymentError("migration handoff unit is too large")
        try:
            unit_text = unit_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            raise DeploymentError("unable to validate migration handoff unit") from exc
        if (
            f"WorkingDirectory={_systemd_path_value(root)}" not in unit_text
            or str(root / "deploy.sh") not in unit_text
        ):
            raise DeploymentError("migration handoff unit does not belong to this checkout")
    disabled = subprocess.run(
        ["systemctl", "--user", "disable", clean],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=30,
        check=False,
    )
    if disabled.returncode != 0 and metadata is not None:
        raise DeploymentError("unable to disable migration handoff unit")
    if metadata is not None:
        unit_path.unlink()
        _fsync_directory(service_dir)
    reloaded = subprocess.run(
        ["systemctl", "--user", "daemon-reload"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=30,
        check=False,
    )
    if reloaded.returncode != 0:
        raise DeploymentError("unable to unload migration handoff unit")


def _validate_service_name(value: str) -> str:
    clean = str(value or "").strip()
    if (
        len(clean) > 255
        or not re.fullmatch(r"[A-Za-z0-9_.@:-]+\.service", clean)
        or clean.startswith((".", "-"))
    ):
        raise DeploymentError(f"invalid platform service name: {value!r}")
    return clean


def _git_update_lock_path(root: Path, *, git: str) -> Path:
    try:
        result = subprocess.run(
            [git, "-C", str(root), "rev-parse", "--git-path", "ubitech-agent-update.lock"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        raise DeploymentError("unable to locate the repository update lock") from None
    value = (result.stdout or "").strip()
    if result.returncode != 0 or not value or any(char in value for char in "\x00\r\n"):
        raise DeploymentError("unable to locate the repository update lock")
    path = Path(value)
    if not path.is_absolute():
        path = root / path
    return path.resolve(strict=False)


def _detect_previous_update_revision(
    root: Path,
    *,
    explicit: str,
    internal_owner: bool,
) -> str | None:
    """Find a verified rollback base without trusting a stale ORIG_HEAD."""

    supplied = explicit.strip() or os.getenv("ENTERPRISE_UPDATE_PREV_SHA", "").strip()
    if supplied:
        candidate = _canonical_commit(root, supplied)
        if candidate is None or not _revision_is_valid_update_base(root, candidate):
            raise DeploymentError("the supplied pre-update revision is not a valid rollback base")
        if not _is_hermes_removal_transition(root, candidate):
            if internal_owner:
                raise DeploymentError(
                    "the internal first-hop owner requires a Hermes-removal update"
                )
            # Ordinary Pi-to-Pi updates retain deploy.sh's generic rollback
            # path. Python owns rollback only for the one Hermes cutover where
            # data and source recovery must be coordinated as one transaction.
            return None
        return candidate
    if internal_owner:
        raise DeploymentError("the internal first-hop owner requires a verified previous revision")
    if not _parent_is_legacy_deploy_update(root):
        return None
    candidate = _canonical_commit(root, "ORIG_HEAD")
    previous_reflog = _canonical_commit(root, "HEAD@{1}")
    if candidate is None or candidate != previous_reflog:
        return None
    if not _revision_is_valid_update_base(root, candidate):
        return None
    if not _is_hermes_removal_transition(root, candidate):
        return None
    return candidate


def _parent_is_legacy_deploy_update(root: Path) -> bool:
    try:
        raw = Path(f"/proc/{os.getppid()}/cmdline").read_bytes()
    except OSError:
        return False
    parts = [part.decode("utf-8", "replace") for part in raw.split(b"\0") if part]
    if not parts or not any(part in {"update", "upgrade"} for part in parts):
        return False
    expected = str((root / "deploy.sh").resolve(strict=False))
    return any(
        part == expected or Path(part).name == "deploy.sh"
        for part in parts
        if part and not part.startswith("-")
    )


def _canonical_commit(root: Path, revision: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--verify", f"{revision}^{{commit}}"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    value = (result.stdout or "").strip().lower()
    if result.returncode != 0 or not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", value):
        return None
    return value


def _revision_is_valid_update_base(root: Path, previous: str) -> bool:
    canonical = _canonical_commit(root, previous)
    current = _canonical_commit(root, "HEAD")
    if canonical is None or current is None or canonical == current:
        return False
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "merge-base", "--is-ancestor", canonical, current],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def _is_hermes_removal_transition(root: Path, previous: str) -> bool:
    def entry(revision: str) -> str:
        try:
            result = subprocess.run(
                ["git", "-C", str(root), "ls-tree", revision, "--", "hermes-agent"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=20,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            return ""
        return (result.stdout or "").strip() if result.returncode == 0 else ""

    old_entry = entry(previous)
    new_entry = entry("HEAD")
    return old_entry.startswith("160000 commit ") and not new_entry


def main(argv: list[str] | None = None) -> None:
    if argv is None:
        argv = sys.argv[1:]
    if not argv:
        argv = ["bootstrap"]
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.cmd in {None, "bootstrap"}:
        result = bootstrap_from_args(args)
        internal_owner = bool(getattr(args, "internal_first_hop_owner", False))
        if result.mode == "cleanup-pending":
            raise SystemExit(ACTIVATED_CLEANUP_PENDING_EXIT_CODE)
        if internal_owner:
            try:
                _cleanup_handoff_unit(
                    Path(args.root).expanduser().resolve(),
                    str(getattr(args, "internal_handoff_unit", "") or ""),
                )
            except Exception:
                print(
                    "WARNING: migration owner cleanup is pending and will be retried.",
                    file=sys.stderr,
                    flush=True,
                )
                raise SystemExit(ACTIVATED_CLEANUP_PENDING_EXIT_CODE) from None
        if result.mode == "rollback":
            if internal_owner:
                return
            if os.getenv("ENTERPRISE_UPDATE_PREV_SHA", "").strip():
                raise SystemExit(INTERNAL_ROLLBACK_EXIT_CODE)
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
