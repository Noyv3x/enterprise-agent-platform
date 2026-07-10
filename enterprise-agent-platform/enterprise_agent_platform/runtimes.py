from __future__ import annotations

import hashlib
import fcntl
import os
import json
import re
import secrets
import signal
import shlex
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol

from . import internal_config as _internal_config
from .config import PlatformConfig
from .hermes_relay import _is_loopback_host, managed_relay_auth
from .oauth_flows import OAUTH_PROVIDER_INFO, SUPPORTED_OAUTH_PROVIDERS, normalize_oauth_provider
from .db import now_ts


HERMES_PLUGIN_KEY = "enterprise-kb"
HERMES_PLUGIN_DIR = "enterprise_kb"
HERMES_INSTALL_MARKER = "install.json"
HERMES_SETTING_MANAGED = "hermes_manage"
HERMES_SETTING_REPO = "hermes_repo"
HERMES_SETTING_API_URL = "hermes_api_url"
HERMES_SETTING_MODEL = "hermes_model"
HERMES_SETTING_INSTALL_EXTRAS = "hermes_install_extras"
HERMES_SETTING_STARTUP_WAIT = "hermes_startup_wait_seconds"
HERMES_SETTING_PROVIDER = "hermes_provider"
HERMES_SETTING_PROVIDER_BASE_URL = "hermes_provider_base_url"
HERMES_SETTING_TIMEOUT = "hermes_timeout_seconds"
COGNEE_SETTING_MANAGED = "cognee_manage"
COGNEE_SETTING_REPO = "cognee_repo"
COGNEE_SETTING_BACKEND = "cognee_backend"
COGNEE_SETTING_DATASET = "cognee_dataset"
COGNEE_SETTING_INGEST_BACKGROUND = "cognee_ingest_background"
COGNEE_SETTING_DATA_ROOT = "cognee_data_root_directory"
COGNEE_SETTING_SYSTEM_ROOT = "cognee_system_root_directory"
COGNEE_SETTING_CACHE_ROOT = "cognee_cache_root_directory"
COGNEE_SETTING_LOGS_DIR = "cognee_logs_dir"
COGNEE_SETTING_SKIP_CONNECTION_TEST = "cognee_skip_connection_test"
CAMOFOX_SETTING_MANAGED = "camofox_manage"
CAMOFOX_SETTING_URL = "camofox_url"
CAMOFOX_SETTING_COMMAND = "camofox_command"
FIRECRAWL_SETTING_MANAGED = "firecrawl_manage"
FIRECRAWL_SETTING_REPO = "firecrawl_repo"
FIRECRAWL_SETTING_API_URL = "firecrawl_api_url"
FIRECRAWL_SETTING_COMMAND = "firecrawl_command"
FIRECRAWL_COMPOSE_OVERRIDE = "docker-compose.enterprise.yaml"
CAMOFOX_MANAGED_VERSION = "1.11.2"
FIRECRAWL_IMAGE = "ghcr.io/firecrawl/firecrawl@sha256:c2e8fc46fbc9dba57463b4b4f5c23fffe2aaf578a7691c5aaaf2cae58a01f80c"
FIRECRAWL_PLAYWRIGHT_IMAGE = "ghcr.io/firecrawl/playwright-service@sha256:6359b0d9070f27400b4a9b615509be06919e40121fc1fdc42d4efeddf02653d2"
FIRECRAWL_POSTGRES_IMAGE = "ghcr.io/firecrawl/nuq-postgres@sha256:aed86f62858f29bd971abddcdeb301c12888098d2cf5d33c1ba42b053bc460f6"
# Manifest-list digests corresponding to the upstream redis:alpine,
# rabbitmq:3-management, and foundationdb/foundationdb:7.3.63 references.
FIRECRAWL_REDIS_IMAGE = "redis@sha256:9d317178eceac8454a2284a9e6df2466b93c745529947f0cd42a0fa9609d7005"
FIRECRAWL_RABBITMQ_IMAGE = "rabbitmq@sha256:e582c0bc7766f3342496d8485efb5a1df782b5ce3886ad017e2eaae442311f69"
FIRECRAWL_FOUNDATIONDB_IMAGE = "foundationdb/foundationdb@sha256:df1a2310c6dbe0d56def526b73606cc8fd414ecc42c50fba2588f13292f82d48"
FIRECRAWL_SERVICE_IMAGES = (
    ("api", FIRECRAWL_IMAGE),
    ("playwright-service", FIRECRAWL_PLAYWRIGHT_IMAGE),
    ("nuq-postgres", FIRECRAWL_POSTGRES_IMAGE),
    ("redis", FIRECRAWL_REDIS_IMAGE),
    ("rabbitmq", FIRECRAWL_RABBITMQ_IMAGE),
    ("foundationdb", FIRECRAWL_FOUNDATIONDB_IMAGE),
    ("foundationdb-init", FIRECRAWL_FOUNDATIONDB_IMAGE),
)
_MANAGED_HERMES_RELAY_ENV_KEYS = frozenset(
    {
        "GATEWAY_RELAY_URL",
        "GATEWAY_RELAY_PLATFORMS",
        "GATEWAY_RELAY_BOT_IDS",
        "GATEWAY_RELAY_ID",
        "GATEWAY_RELAY_SECRET",
    }
)
_PLATFORM_SECRET_ENV_SUFFIXES = ("_SECRET", "_TOKEN", "_PASSWORD", "_API_KEY")

class ProcessLike(Protocol):
    pid: int

    def poll(self) -> int | None:
        ...

    def terminate(self) -> None:
        ...

    def wait(self, timeout: float | None = None) -> int:
        ...

    def kill(self) -> None:
        ...


class ProcessLauncher(Protocol):
    def start(self, cmd: list[str], *, cwd: Path | None, env: dict[str, str], log_path: Path) -> ProcessLike:
        ...


class CommandRunner(Protocol):
    def run(self, cmd: list[str], *, cwd: Path | None, env: dict[str, str], log_path: Path, timeout: float) -> subprocess.CompletedProcess:
        ...


class SubprocessLauncher:
    def start(self, cmd: list[str], *, cwd: Path | None, env: dict[str, str], log_path: Path) -> ProcessLike:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("ab") as log:
            return subprocess.Popen(
                cmd,
                cwd=str(cwd) if cwd else None,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=log,
                start_new_session=True,
            )


class SubprocessCommandRunner:
    def run(self, cmd: list[str], *, cwd: Path | None, env: dict[str, str], log_path: Path, timeout: float) -> subprocess.CompletedProcess:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("ab") as log:
            return subprocess.run(
                cmd,
                cwd=str(cwd) if cwd else None,
                env=env,
                stdout=log,
                stderr=log,
                timeout=timeout,
                check=False,
            )


@dataclass(frozen=True)
class RuntimeStatus:
    name: str
    managed: bool
    available: bool
    state: str
    detail: str = ""
    pid: int | None = None
    url: str = ""
    path: str = ""
    error: str = ""
    last_started_at: int | None = None
    source: str = ""
    install_state: str = ""
    patch_status: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "managed": self.managed,
            "available": self.available,
            "state": self.state,
            "detail": self.detail,
            "pid": self.pid,
            "url": self.url,
            "path": self.path,
            "error": self.error,
            "last_started_at": self.last_started_at,
            "source": self.source,
            "install_state": self.install_state,
            "patch_status": dict(self.patch_status or {}),
        }


class PlatformRuntimeManager:
    """Prepare and run the Hermes/Cognee foundations owned by the platform."""

    def __init__(
        self,
        config: PlatformConfig,
        secret_provider,
        *,
        process_launcher: ProcessLauncher | None = None,
        command_runner: CommandRunner | None = None,
        setting_provider=None,
    ):
        self.config = config
        self.secret_provider = secret_provider
        self.process_launcher = process_launcher or SubprocessLauncher()
        self.command_runner = command_runner or SubprocessCommandRunner()
        self.setting_provider = setting_provider
        self._lock = threading.RLock()
        # Cached "Hermes was healthy at <monotonic ts>" so the steady-state hot
        # path can skip the heavy prepare()+probe under the broad lock within a
        # short TTL. See _hermes_recent_health / ensure_hermes_ready.
        self._hermes_health_checked_at: float | None = None
        # Fingerprint of the inputs that prepare_hermes() materializes; lets the
        # hot path skip the rmtree/copytree + config/env rewrite when nothing
        # has changed since the last successful prepare.
        self._hermes_prepared_fingerprint: str | None = None
        self._hermes_patch_status: dict[str, Any] = {}
        self._hermes_process: ProcessLike | None = None
        self._camofox_process: ProcessLike | None = None
        self._firecrawl_process: ProcessLike | None = None
        # When Firecrawl was launched via the managed `docker compose up` stack,
        # remember the (compose argv, cwd) needed to tear it down so stop/close
        # can run `docker compose down` instead of orphaning the containers.
        self._firecrawl_compose_teardown: tuple[list[str], Path | None] | None = None
        self._hermes_last_started_at: int | None = None
        self._camofox_last_started_at: int | None = None
        self._firecrawl_last_started_at: int | None = None
        self._hermes_last_error = ""
        self._cognee_last_error = ""
        self._camofox_last_error = ""
        self._firecrawl_last_error = ""

    def prepare(self) -> dict[str, Any]:
        with self._lock:
            hermes = self.prepare_hermes()
            cognee = self.prepare_cognee()
            camofox = self.prepare_camofox()
            firecrawl = self.prepare_firecrawl()
            return {
                "hermes": hermes.to_dict(),
                "cognee": cognee.to_dict(),
                "camofox": camofox.to_dict(),
                "firecrawl": firecrawl.to_dict(),
            }

    def status(self, *, refresh: bool = True) -> dict[str, Any]:
        with self._lock:
            hermes = self.hermes_status(refresh=refresh)
            cognee = self.cognee_status()
            camofox = self.camofox_status(refresh=refresh)
            firecrawl = self.firecrawl_status(refresh=refresh)
            return {
                "hermes": hermes.to_dict(),
                "cognee": cognee.to_dict(),
                "camofox": camofox.to_dict(),
                "firecrawl": firecrawl.to_dict(),
            }

    def prepare_hermes(self) -> RuntimeStatus:
        if not self._managed_hermes_enabled():
            return RuntimeStatus("hermes", False, False, "external", "managed Hermes disabled")

        home = self.config.managed_hermes_home
        home.mkdir(parents=True, exist_ok=True)
        (home / "logs").mkdir(parents=True, exist_ok=True)
        self._install_enterprise_plugin(home)
        self._ensure_hermes_config(home)
        self._write_hermes_auth(home)
        self._write_hermes_env(home)
        install_status = self.ensure_hermes_installed(force=False)
        if not install_status.available:
            self._hermes_last_error = install_status.error
            return install_status
        command, _cwd, detail = self._hermes_command()
        available = bool(command)
        state = "prepared" if available else "missing"
        error = "" if available else detail
        self._hermes_last_error = error
        # Record the fingerprint of what we just materialized so the hot path can
        # detect when nothing changed and skip a redundant prepare.
        self._hermes_prepared_fingerprint = self._hermes_prepare_fingerprint() if available else None
        return RuntimeStatus(
            "hermes",
            True,
            available,
            state,
            detail=detail if available else "",
            path=str(home),
            url=self._hermes_health_url(),
            error=error,
            last_started_at=self._hermes_last_started_at,
            source=detail if available else "",
            install_state=install_status.install_state,
        )

    def ensure_hermes_ready(self, *, wait: bool = True) -> RuntimeStatus:
        if not self._managed_hermes_enabled():
            return self.hermes_status(refresh=False)
        # Steady-state hot path: when Hermes was confirmed healthy very recently
        # and nothing the platform materializes has changed, skip the expensive
        # prepare() (plugin rmtree/copytree + config/.env rewrite) and the
        # serialized health probe. Every agent message hits this method, so this
        # avoids per-message filesystem churn and lock-held probing.
        if self._hermes_steady_state_ready():
            cached = self._cached_hermes_running_status()
            if cached is not None:
                return cached
        with self._lock:
            if not self._managed_hermes_enabled():
                return self.hermes_status(refresh=False)
            self.ensure_managed_tooling_ready(wait=False)
            prepared = self.prepare_hermes()
            if not prepared.available:
                return prepared
            current = self.hermes_status(refresh=True)
            if current.available:
                return current
            if current.state == "degraded":
                return current
            if self._hermes_process is None or self._hermes_process.poll() is not None:
                self._start_hermes()
            started_process = self._hermes_process
            should_wait = wait and self._effective_startup_wait_seconds() > 0
        # Release the broad lock before the blocking startup wait so status
        # polls, other runtimes' ensure_*_ready, and graceful shutdown stay
        # responsive while Hermes is warming up.
        if should_wait:
            return self._wait_for_hermes(started_process)
        return self.hermes_status(refresh=True)

    def _hermes_steady_state_ready(self) -> bool:
        """True when a recent successful probe + unchanged inputs let us skip prepare."""
        checked_at = self._hermes_health_checked_at
        if checked_at is None:
            return False
        ttl = self._hermes_health_cache_ttl()
        if ttl <= 0 or (time.monotonic() - checked_at) > ttl:
            return False
        if self._hermes_prepared_fingerprint is None:
            return False
        return self._hermes_prepared_fingerprint == self._hermes_prepare_fingerprint()

    def _cached_hermes_running_status(self) -> RuntimeStatus | None:
        """Synthesize the 'running' status from a recent successful probe.

        Returns None when there is no live process backing the cache, so a
        stale cache can never report a dead Hermes as healthy.
        """
        proc = self._hermes_process
        if proc is None or proc.poll() is not None:
            return None
        home = self.config.managed_hermes_home
        return RuntimeStatus(
            "hermes",
            True,
            True,
            "running",
            "Hermes API server is reachable",
            pid=proc.pid,
            url=self._hermes_health_url(),
            path=str(home),
            last_started_at=self._hermes_last_started_at,
            source=self._hermes_source_label(),
            install_state=self._hermes_install_state(),
            patch_status=self._hermes_patch_status,
        )

    @staticmethod
    def _hermes_health_cache_ttl() -> float:
        raw = os.environ.get("ENTERPRISE_HERMES_HEALTH_CACHE_SECONDS")
        if raw:
            try:
                return max(0.0, float(raw))
            except ValueError:
                pass
        return 5.0

    def _hermes_prepare_fingerprint(self) -> str:
        """Fingerprint of the inputs prepare_hermes() materializes into HERMES_HOME."""
        try:
            parts = [
                str(self.config.managed_hermes_home),
                str(self._effective_hermes_repo()),
                self._effective_hermes_model(),
                self._effective_hermes_provider(),
                self._effective_hermes_provider_base_url(),
                self._effective_hermes_api_url(),
                self._effective_install_extras(),
                "1" if self._managed_hermes_relay_enabled() else "0",
                self._effective_hermes_relay_url(),
                "1" if self._managed_venv_ready() else "0",
            ]
        except Exception:
            return ""
        return "\0".join(parts)

    def restart_hermes(self) -> RuntimeStatus:
        with self._lock:
            self.stop_hermes()
            return self.ensure_hermes_ready(wait=True)

    def stop_hermes(self) -> RuntimeStatus:
        with self._lock:
            proc = self._hermes_process
            if proc is not None:
                self._terminate_process(proc, timeout=8)
            self._hermes_process = None
            # Invalidate the steady-state caches so the hot path re-prepares and
            # re-probes after a stop/restart instead of trusting a stale flag.
            self._hermes_health_checked_at = None
            self._hermes_prepared_fingerprint = None
            return self.hermes_status(refresh=False)

    def hermes_status(self, *, refresh: bool = True) -> RuntimeStatus:
        if not self._managed_hermes_enabled():
            return RuntimeStatus("hermes", False, False, "external", "managed Hermes disabled")

        home = self.config.managed_hermes_home
        pid: int | None = None
        process_running = False
        if self._hermes_process is not None:
            pid = self._hermes_process.pid
            process_running = self._hermes_process.poll() is None
        install_state = self._hermes_install_state()
        if refresh:
            healthy = self._probe_hermes_health()
            # A healthy HTTP endpoint is not enough: the managed runtime also
            # needs every required integration patch. Only cache readiness after
            # both probes succeed, otherwise the hot path could turn a degraded
            # result back into a synthetic "running" status.
            self._hermes_health_checked_at = None
        else:
            healthy = False
        if healthy:
            if refresh:
                self._hermes_patch_status = self._probe_hermes_patch_status()
            patch_status = dict(self._hermes_patch_status or {})
            if patch_status.get("available") is not True or patch_status.get("ok") is not True:
                failed = patch_status.get("failed")
                if isinstance(failed, dict) and failed:
                    failure_detail = ", ".join(
                        f"{name}={state}" for name, state in sorted(failed.items())
                    )
                else:
                    failure_detail = str(patch_status.get("error") or "patch status endpoint unavailable")
                error = f"Required Hermes runtime patches are unavailable: {failure_detail}"
                self._hermes_last_error = error
                return RuntimeStatus(
                    "hermes",
                    True,
                    False,
                    "degraded",
                    "Hermes API is reachable but required runtime patches are not healthy",
                    pid=pid,
                    url=self._hermes_health_url(),
                    path=str(home),
                    error=error,
                    last_started_at=self._hermes_last_started_at,
                    source=self._hermes_source_label(),
                    install_state=install_state,
                    patch_status=patch_status,
                )
            if refresh:
                self._hermes_health_checked_at = time.monotonic()
            self._hermes_last_error = ""
            return RuntimeStatus(
                "hermes",
                True,
                True,
                "running",
                "Hermes API server is reachable",
                pid=pid,
                url=self._hermes_health_url(),
                path=str(home),
                last_started_at=self._hermes_last_started_at,
                source=self._hermes_source_label(),
                install_state=install_state,
                patch_status=self._hermes_patch_status,
            )
        if process_running:
            return RuntimeStatus(
                "hermes",
                True,
                False,
                "starting",
                "Hermes gateway process is running; API health check is not ready yet",
                pid=pid,
                url=self._hermes_health_url(),
                path=str(home),
                error=self._hermes_last_error,
                last_started_at=self._hermes_last_started_at,
                source=self._hermes_source_label(),
                install_state=install_state,
            )
        prepared = (home / "plugins" / HERMES_PLUGIN_DIR / "plugin.yaml").exists()
        if prepared and install_state != "installed":
            return RuntimeStatus(
                "hermes",
                True,
                False,
                "missing",
                "Hermes source install is not ready",
                pid=pid,
                url=self._hermes_health_url(),
                path=str(home),
                error=self._hermes_last_error or self._hermes_install_error(),
                last_started_at=self._hermes_last_started_at,
                source=self._hermes_source_label(),
                install_state=install_state,
            )
        return RuntimeStatus(
            "hermes",
            True,
            False,
            "prepared" if prepared else "missing",
            "Hermes is prepared but not running" if prepared else "Hermes runtime has not been prepared",
            pid=pid,
            url=self._hermes_health_url(),
            path=str(home),
            error=self._hermes_last_error,
            last_started_at=self._hermes_last_started_at,
            source=self._hermes_source_label(),
            install_state=install_state,
        )

    def install_hermes(self, *, force: bool = False) -> RuntimeStatus:
        with self._lock:
            self.stop_hermes()
            return self.ensure_hermes_installed(force=force)

    def ensure_hermes_installed(self, *, force: bool = False) -> RuntimeStatus:
        repo = self._effective_hermes_repo()
        home = self.config.managed_hermes_home
        home.mkdir(parents=True, exist_ok=True)
        (home / "logs").mkdir(parents=True, exist_ok=True)
        if not repo.exists():
            return RuntimeStatus(
                "hermes",
                True,
                False,
                "missing",
                "Hermes source repository is required for managed installation",
                path=str(home),
                error=f"Hermes source not found: {repo}",
                source=str(repo),
                install_state="missing-source",
            )
        if not (repo / "pyproject.toml").exists():
            return RuntimeStatus(
                "hermes",
                True,
                False,
                "missing",
                "Hermes source repository is missing pyproject.toml",
                path=str(home),
                error=f"Invalid Hermes source: {repo}",
                source=str(repo),
                install_state="invalid-source",
            )
        runtime_source = self._managed_hermes_source_dir()
        if not force and self._managed_venv_ready():
            return RuntimeStatus(
                "hermes",
                True,
                True,
                "installed",
                "Hermes is installed from a platform-managed patched source copy",
                path=str(home),
                source=str(runtime_source),
                install_state="installed",
            )
        venv_dir = self._hermes_venv_dir()
        log_path = home / "logs" / "managed-install.log"
        env = os.environ.copy()
        try:
            if force and venv_dir.exists():
                shutil.rmtree(venv_dir)
            runtime_source = self._prepare_managed_hermes_source(repo, force=force)
            result = self.command_runner.run(
                [sys.executable, "-m", "venv", str(venv_dir)],
                cwd=None,
                env=env,
                log_path=log_path,
                timeout=180,
            )
            if result.returncode != 0:
                raise RuntimeError(f"venv creation failed with exit code {result.returncode}")
            install_target = self._editable_install_target(runtime_source)
            result = self.command_runner.run(
                [str(self._hermes_venv_python()), "-m", "pip", "install", "-e", install_target],
                cwd=runtime_source,
                env=env,
                log_path=log_path,
                timeout=900,
            )
            if result.returncode != 0:
                raise RuntimeError(f"Hermes source install failed with exit code {result.returncode}")
            if self._managed_hermes_relay_enabled():
                result = self.command_runner.run(
                    [str(self._hermes_venv_python()), "-m", "pip", "install", "websockets>=14,<16"],
                    cwd=runtime_source,
                    env=env,
                    log_path=log_path,
                    timeout=300,
                )
                if result.returncode != 0:
                    raise RuntimeError(f"Hermes relay dependency install failed with exit code {result.returncode}")
            self._write_install_marker(repo, runtime_source)
            self._hermes_last_error = ""
            return RuntimeStatus(
                "hermes",
                True,
                True,
                "installed",
                "Hermes is installed from a platform-managed patched source copy",
                path=str(home),
                source=str(runtime_source),
                install_state="installed",
            )
        except Exception as exc:
            self._hermes_last_error = str(exc)
            return RuntimeStatus(
                "hermes",
                True,
                False,
                "install_failed",
                "Hermes installation failed; see managed-install.log",
                path=str(home),
                error=str(exc),
                source=str(repo),
                install_state="failed",
            )

    def hermes_runtime_config(self) -> dict[str, Any]:
        api_url = self._effective_hermes_api_url()
        parsed = urllib.parse.urlparse(api_url)
        provider = self._effective_hermes_provider()
        return {
            "manage_hermes": self._managed_hermes_enabled(),
            "repo_path": str(self._effective_hermes_repo()),
            "hermes_home": str(self.config.managed_hermes_home),
            "api_url": api_url,
            "api_host": parsed.hostname or "127.0.0.1",
            "api_port": parsed.port or 8642,
            "model": self._effective_hermes_model(),
            "provider": provider,
            "provider_base_url": self._effective_hermes_provider_base_url(provider),
            "install_extras": self._effective_install_extras(),
            "startup_wait_seconds": self._effective_startup_wait_seconds(),
            "timeout_seconds": self._effective_hermes_timeout_seconds(),
            "relay": {
                "enabled": self._managed_hermes_relay_enabled(),
                "url": self._effective_hermes_relay_url(),
                "host": self.config.hermes_relay_host,
                "port": self.config.hermes_relay_port,
            },
            "source_install": True,
            "venv_path": str(self._hermes_venv_dir()),
            "config_path": str(self.config.managed_hermes_home / "config.yaml"),
            "env_path": str(self.config.managed_hermes_home / ".env"),
            "auth_store": str(self.config.managed_hermes_home / "auth.json"),
            "logs_dir": str(self.config.managed_hermes_home / "logs"),
            "installed": self._managed_venv_ready(),
            "oauth": self._oauth_status(),
            "browser": {
                "backend": "camofox",
                "camofox_url": self._effective_camofox_url(),
                "managed": self._managed_camofox_enabled(),
            },
            "web": {
                "backend": "firecrawl",
                "firecrawl_api_url": self._effective_firecrawl_api_url(),
                "managed": self._managed_firecrawl_enabled(),
            },
        }

    def cognee_runtime_config(self) -> dict[str, Any]:
        env_values = self._cognee_env_values()
        return {
            "manage_cognee": self._managed_cognee_enabled(),
            "repo_path": str(self._effective_cognee_repo()),
            "runtime_dir": str(self.config.cognee_runtime_dir),
            "backend": self._effective_cognee_backend(),
            "dataset": self._effective_cognee_dataset(),
            "ingest_background": self._effective_cognee_ingest_background(),
            "data_root_directory": env_values["DATA_ROOT_DIRECTORY"],
            "system_root_directory": env_values["SYSTEM_ROOT_DIRECTORY"],
            "cache_root_directory": env_values["CACHE_ROOT_DIRECTORY"],
            "logs_dir": env_values["COGNEE_LOGS_DIR"],
            "skip_connection_test": env_values["COGNEE_SKIP_CONNECTION_TEST"].lower() in {"1", "true", "yes", "on"},
            "env_path": str(self._cognee_env_path()),
        }

    def prepare_cognee(self) -> RuntimeStatus:
        if not self._managed_cognee_enabled():
            return RuntimeStatus("cognee", False, False, "external", "managed Cognee disabled")
        try:
            self._seed_cognee_env()
            repo = self._effective_cognee_repo()
            if repo.exists() and str(repo) not in sys.path:
                sys.path.insert(0, str(repo))
            available = repo.exists() or _module_importable("cognee")
            if not available:
                self._cognee_last_error = f"Cognee repository/package not found at {repo}"
                return RuntimeStatus(
                    "cognee",
                    True,
                    False,
                    "missing",
                    path=str(self.config.cognee_runtime_dir),
                    error=self._cognee_last_error,
                    source=str(repo),
                )
            self._cognee_last_error = ""
            return RuntimeStatus(
                "cognee",
                True,
                True,
                "prepared",
                "Cognee local storage and import path are managed by the platform",
                path=str(self.config.cognee_runtime_dir),
                source=str(repo),
            )
        except Exception as exc:
            self._cognee_last_error = str(exc)
            return RuntimeStatus("cognee", True, False, "error", path=str(self.config.cognee_runtime_dir), error=str(exc))

    def ensure_cognee_ready(self) -> RuntimeStatus:
        with self._lock:
            return self.prepare_cognee()

    def cognee_status(self) -> RuntimeStatus:
        """Report Cognee readiness without side effects.

        Unlike prepare_cognee(), this does not seed os.environ, create
        directories, or mutate sys.path, so the status/settings UI poll stays a
        read-only query. Seeding stays on the explicit prepare/ensure path that
        actually materializes the runtime before use.
        """
        if not self._managed_cognee_enabled():
            return RuntimeStatus("cognee", False, False, "external", "managed Cognee disabled")
        repo = self._effective_cognee_repo()
        available = repo.exists() or str(repo) in sys.path or _module_importable("cognee")
        if not available:
            error = self._cognee_last_error or f"Cognee repository/package not found at {repo}"
            return RuntimeStatus(
                "cognee",
                True,
                False,
                "missing",
                path=str(self.config.cognee_runtime_dir),
                error=error,
                source=str(repo),
            )
        return RuntimeStatus(
            "cognee",
            True,
            True,
            "prepared",
            "Cognee local storage and import path are managed by the platform",
            path=str(self.config.cognee_runtime_dir),
            error=self._cognee_last_error,
            source=str(repo),
        )

    def prepare_camofox(self) -> RuntimeStatus:
        if not self._managed_camofox_enabled():
            return RuntimeStatus("camofox", False, False, "external", "managed Camofox disabled")
        runtime_dir = self.config.runtime_dir / "camofox"
        (runtime_dir / "logs").mkdir(parents=True, exist_ok=True)
        for directory in (
            runtime_dir,
            runtime_dir / "profiles",
            runtime_dir / "cookies",
            runtime_dir / "traces",
        ):
            directory.mkdir(parents=True, exist_ok=True)
            try:
                directory.chmod(0o700)
            except OSError:
                pass
        url_error = self._managed_loopback_url_error("Camofox", self._effective_camofox_url())
        if url_error:
            self._camofox_last_error = url_error
            return RuntimeStatus(
                "camofox",
                True,
                False,
                "invalid_config",
                path=str(runtime_dir),
                url=self._effective_camofox_url(),
                error=url_error,
            )
        command, _cwd, detail = self._camofox_command()
        available = bool(command)
        self._camofox_last_error = "" if available else detail
        return RuntimeStatus(
            "camofox",
            True,
            available,
            "prepared" if available else "missing",
            detail=detail if available else "",
            path=str(runtime_dir),
            url=self._effective_camofox_url(),
            error="" if available else detail,
            last_started_at=self._camofox_last_started_at,
            source=detail,
        )

    def ensure_camofox_ready(self, *, wait: bool = True) -> RuntimeStatus:
        with self._lock:
            if not self._managed_camofox_enabled():
                return self.camofox_status(refresh=False)
            prepared = self.prepare_camofox()
            if not prepared.available:
                return prepared
            current = self.camofox_status(refresh=True)
            if current.available:
                return current
            if self._camofox_process is None or self._camofox_process.poll() is not None:
                self._start_camofox()
            started_process = self._camofox_process
            should_wait = wait
        # Release the broad lock before the (now much larger) cold-start wait so
        # status polls, the Hermes/Firecrawl ensure_* paths, and shutdown stay
        # responsive while the browser package downloads.
        if should_wait:
            return self._wait_for_runtime("camofox", started_process)
        return self.camofox_status(refresh=True)

    def restart_camofox(self) -> RuntimeStatus:
        with self._lock:
            self.stop_camofox()
        # ensure_camofox_ready manages the lock itself and releases it across the
        # cold-start wait, so do not hold the broad lock around it here.
        return self.ensure_camofox_ready(wait=True)

    def stop_camofox(self) -> RuntimeStatus:
        with self._lock:
            self._stop_process("_camofox_process")
            return self.camofox_status(refresh=False)

    def camofox_status(self, *, refresh: bool = True) -> RuntimeStatus:
        if not self._managed_camofox_enabled():
            return RuntimeStatus("camofox", False, False, "external", "managed Camofox disabled")
        runtime_dir = self.config.runtime_dir / "camofox"
        pid, process_running, returncode = self._process_state(self._camofox_process)
        healthy = self._probe_camofox_health() if refresh else False
        if healthy:
            return RuntimeStatus(
                "camofox",
                True,
                True,
                "running",
                "Camofox browser API is reachable",
                pid=pid,
                url=self._effective_camofox_url(),
                path=str(runtime_dir),
                last_started_at=self._camofox_last_started_at,
                source=self._camofox_source_label(),
            )
        if process_running:
            return RuntimeStatus(
                "camofox",
                True,
                False,
                "starting",
                "Camofox process is running; health check is not ready yet "
                "(first launch downloads the browser package and may take a few minutes)",
                pid=pid,
                url=self._effective_camofox_url(),
                path=str(runtime_dir),
                error=self._camofox_last_error,
                last_started_at=self._camofox_last_started_at,
                source=self._camofox_source_label(),
            )
        command, _cwd, detail = self._camofox_command()
        exited = self._process_exit_error("Camofox", returncode, runtime_dir / "logs" / "managed-camofox.log")
        state = "error" if exited else ("prepared" if command else "missing")
        runtime_detail = exited or ("Camofox is prepared but not running" if command else detail)
        error = exited or (self._camofox_last_error if command else detail)
        return RuntimeStatus(
            "camofox",
            True,
            False,
            state,
            runtime_detail,
            pid=pid,
            url=self._effective_camofox_url(),
            path=str(runtime_dir),
            error=error,
            last_started_at=self._camofox_last_started_at,
            source=self._camofox_source_label(),
        )

    def prepare_firecrawl(self) -> RuntimeStatus:
        if not self._managed_firecrawl_enabled():
            return RuntimeStatus("firecrawl", False, False, "external", "managed Firecrawl disabled")
        self.config.firecrawl_runtime_dir.mkdir(parents=True, exist_ok=True)
        (self.config.firecrawl_runtime_dir / "logs").mkdir(parents=True, exist_ok=True)
        url_error = self._managed_loopback_url_error("Firecrawl", self._effective_firecrawl_api_url())
        if url_error:
            self._firecrawl_last_error = url_error
            return RuntimeStatus(
                "firecrawl",
                True,
                False,
                "invalid_config",
                path=str(self.config.firecrawl_runtime_dir),
                url=self._effective_firecrawl_api_url(),
                error=url_error,
            )
        command, cwd, detail = self._firecrawl_command()
        available = bool(command)
        if available and cwd is not None:
            self._ensure_firecrawl_env()
        self._firecrawl_last_error = "" if available else detail
        return RuntimeStatus(
            "firecrawl",
            True,
            available,
            "prepared" if available else "missing",
            detail=detail if available else "",
            path=str(cwd or self.config.firecrawl_runtime_dir),
            url=self._effective_firecrawl_api_url(),
            error="" if available else detail,
            last_started_at=self._firecrawl_last_started_at,
            source=str(cwd or ""),
        )

    def ensure_firecrawl_ready(self, *, wait: bool = True) -> RuntimeStatus:
        with self._lock:
            if not self._managed_firecrawl_enabled():
                return self.firecrawl_status(refresh=False)
            prepared = self.prepare_firecrawl()
            if not prepared.available:
                return prepared
            current = self.firecrawl_status(refresh=True)
            if current.available:
                return current
            if self._firecrawl_process is None or self._firecrawl_process.poll() is not None:
                self._start_firecrawl()
            started_process = self._firecrawl_process
            should_wait = wait
        # Release the broad lock before the (now much larger) cold-start wait so
        # status polls, the Hermes/Camofox ensure_* paths, and shutdown stay
        # responsive while docker pulls the multi-hundred-MB images.
        if should_wait:
            return self._wait_for_runtime("firecrawl", started_process)
        return self.firecrawl_status(refresh=True)

    def restart_firecrawl(self) -> RuntimeStatus:
        with self._lock:
            self.stop_firecrawl()
        # ensure_firecrawl_ready manages the lock itself and releases it across
        # the cold-start wait, so do not hold the broad lock around it here.
        return self.ensure_firecrawl_ready(wait=True)

    def stop_firecrawl(self) -> RuntimeStatus:
        with self._lock:
            self._teardown_firecrawl_compose()
            self._stop_process("_firecrawl_process")
            return self.firecrawl_status(refresh=False)

    def _teardown_firecrawl_compose(self) -> None:
        """Tear down the managed Firecrawl compose stack before dropping the CLI.

        `docker compose up` is an attached client; the api/playwright/postgres/
        redis/rabbitmq containers are owned by the daemon, not the CLI's process
        group, so killing the CLI orphans them and leaks port 3002 and DB
        volumes. Run `docker compose down --remove-orphans` first so the stack is
        actually stopped and removed.
        """
        teardown = self._firecrawl_compose_teardown
        if teardown is None:
            return
        down_command, cwd = teardown
        log_path = self.config.firecrawl_runtime_dir / "logs" / "managed-firecrawl.log"
        env = os.environ.copy()
        env["DOCKER_BUILDKIT"] = env.get("DOCKER_BUILDKIT") or "1"
        env["COMPOSE_DOCKER_CLI_BUILD"] = env.get("COMPOSE_DOCKER_CLI_BUILD") or "1"
        try:
            self.command_runner.run(
                down_command,
                cwd=cwd,
                env=env,
                log_path=log_path,
                timeout=self._firecrawl_compose_down_timeout(),
            )
        except Exception as exc:
            self._firecrawl_last_error = f"Firecrawl compose teardown failed: {exc}"
        finally:
            self._firecrawl_compose_teardown = None

    @staticmethod
    def _firecrawl_compose_down_timeout() -> float:
        raw = os.environ.get("ENTERPRISE_FIRECRAWL_COMPOSE_DOWN_TIMEOUT_SECONDS")
        if raw:
            try:
                return max(1.0, float(raw))
            except ValueError:
                pass
        return 90.0

    def firecrawl_status(self, *, refresh: bool = True) -> RuntimeStatus:
        if not self._managed_firecrawl_enabled():
            return RuntimeStatus("firecrawl", False, False, "external", "managed Firecrawl disabled")
        pid, process_running, returncode = self._process_state(self._firecrawl_process)
        command, cwd, detail = self._firecrawl_command()
        healthy = self._probe_firecrawl_health() if refresh else False
        if healthy:
            return RuntimeStatus(
                "firecrawl",
                True,
                True,
                "running",
                "Self-hosted Firecrawl API is reachable",
                pid=pid,
                url=self._effective_firecrawl_api_url(),
                path=str(cwd or self.config.firecrawl_runtime_dir),
                last_started_at=self._firecrawl_last_started_at,
                source=str(cwd or ""),
            )
        if process_running:
            return RuntimeStatus(
                "firecrawl",
                True,
                False,
                "starting",
                "Firecrawl process is running; API health check is not ready yet "
                "(first launch pulls the Docker images and may take several minutes)",
                pid=pid,
                url=self._effective_firecrawl_api_url(),
                path=str(cwd or self.config.firecrawl_runtime_dir),
                error=self._firecrawl_last_error,
                last_started_at=self._firecrawl_last_started_at,
                source=str(cwd or ""),
            )
        exited = self._process_exit_error("Firecrawl", returncode, self.config.firecrawl_runtime_dir / "logs" / "managed-firecrawl.log")
        state = "error" if exited else ("prepared" if command else "missing")
        runtime_detail = exited or ("Firecrawl is prepared but not running" if command else detail)
        error = exited or (self._firecrawl_last_error if command else detail)
        return RuntimeStatus(
            "firecrawl",
            True,
            False,
            state,
            runtime_detail,
            pid=pid,
            url=self._effective_firecrawl_api_url(),
            path=str(cwd or self.config.firecrawl_runtime_dir),
            error=error,
            last_started_at=self._firecrawl_last_started_at,
            source=str(cwd or ""),
        )

    def ensure_managed_tooling_ready(self, *, wait: bool = False) -> dict[str, Any]:
        with self._lock:
            return {
                "camofox": self.ensure_camofox_ready(wait=wait).to_dict(),
                "firecrawl": self.ensure_firecrawl_ready(wait=wait).to_dict(),
            }

    def close(self) -> None:
        self.stop_hermes()
        self.stop_camofox()
        self.stop_firecrawl()

    def _start_hermes(self) -> None:
        command, cwd, detail = self._hermes_command()
        if not command:
            self._hermes_last_error = detail
            return
        env = self._hermes_process_env()
        log_path = self.config.managed_hermes_home / "logs" / "managed-gateway.log"
        try:
            self._hermes_process = self.process_launcher.start(command, cwd=cwd, env=env, log_path=log_path)
            self._hermes_last_started_at = now_ts()
            self._hermes_last_error = ""
        except Exception as exc:
            self._hermes_last_error = str(exc)
            self._hermes_process = None

    def _start_camofox(self) -> None:
        command, cwd, detail = self._camofox_command()
        if not command:
            self._camofox_last_error = detail
            return
        env = os.environ.copy()
        env["CAMOFOX_PORT"] = str(urllib.parse.urlparse(self._effective_camofox_url()).port or 9377)
        runtime_dir = self.config.runtime_dir / "camofox"
        access_key = self._camofox_access_key()
        env.update(
            {
                # Upstream accepts CAMOFOX_API_KEY in its Hermes client and
                # CAMOFOX_ACCESS_KEY in the server-wide auth middleware. Use
                # one generated value so every non-health route is protected.
                "CAMOFOX_ACCESS_KEY": access_key,
                "CAMOFOX_API_KEY": access_key,
                "CAMOFOX_ADMIN_KEY": access_key,
                "CAMOFOX_PROFILE_DIR": str(runtime_dir / "profiles"),
                "CAMOFOX_COOKIES_DIR": str(runtime_dir / "cookies"),
                "CAMOFOX_TRACES_DIR": str(runtime_dir / "traces"),
                "CAMOFOX_CRASH_REPORT_ENABLED": "false",
                "HOST": "127.0.0.1",
                "CAMOFOX_HOST": "127.0.0.1",
            }
        )
        preload = Path(__file__).resolve().parent / "hermes_runtime_patch" / "camofox_loopback.cjs"
        existing_node_options = env.get("NODE_OPTIONS", "").strip()
        preload_option = f"--require={preload}"
        env["NODE_OPTIONS"] = " ".join(part for part in (existing_node_options, preload_option) if part)
        log_path = runtime_dir / "logs" / "managed-camofox.log"
        try:
            self._camofox_process = self.process_launcher.start(command, cwd=cwd, env=env, log_path=log_path)
            self._camofox_last_started_at = now_ts()
            self._camofox_last_error = ""
        except Exception as exc:
            self._camofox_last_error = str(exc)
            self._camofox_process = None

    def _start_firecrawl(self) -> None:
        command, cwd, detail = self._firecrawl_command()
        if not command:
            self._firecrawl_last_error = detail
            return
        # Materialize the managed .env (under the data dir) before launch so the
        # --env-file argv resolves to a real file.
        self._ensure_firecrawl_env()
        env = os.environ.copy()
        teardown = self._firecrawl_compose_teardown_command(command, cwd)
        api_port = str(urllib.parse.urlparse(self._effective_firecrawl_api_url()).port or 3002)
        env.update({
            "DOCKER_BUILDKIT": env.get("DOCKER_BUILDKIT") or "1",
            "COMPOSE_DOCKER_CLI_BUILD": env.get("COMPOSE_DOCKER_CLI_BUILD") or "1",
            "USE_DB_AUTHENTICATION": "false",
            "HOST": "0.0.0.0" if teardown is not None else "127.0.0.1",
            # Firecrawl's compose file interpolates PORT into the host-side
            # ports entry. A three-part value binds only the loopback address;
            # custom non-compose commands continue to receive a numeric port.
            "PORT": f"127.0.0.1:{api_port}" if teardown is not None else api_port,
        })
        log_path = self.config.firecrawl_runtime_dir / "logs" / "managed-firecrawl.log"
        try:
            self._firecrawl_process = self.process_launcher.start(command, cwd=cwd, env=env, log_path=log_path)
            self._firecrawl_last_started_at = now_ts()
            self._firecrawl_last_error = ""
            self._firecrawl_compose_teardown = teardown
        except Exception as exc:
            self._firecrawl_last_error = str(exc)
            self._firecrawl_process = None
            self._firecrawl_compose_teardown = None

    def _firecrawl_compose_teardown_command(
        self, up_command: list[str], cwd: Path | None
    ) -> tuple[list[str], Path | None] | None:
        """Build the `docker compose ... down` argv mirroring the launch command.

        Only the managed compose stack (no user-configured command) is torn
        down; a user-provided _effective_firecrawl_command is left to the
        operator and handled by the plain _stop_process path.
        """
        if self._effective_firecrawl_command():
            return None
        if up_command[:2] != ["docker", "compose"]:
            return None
        # Preserve the `--env-file`/`-f` flags from the up argv (everything
        # before the trailing `up ...` verb) and swap the verb for `down`.
        try:
            up_index = up_command.index("up")
        except ValueError:
            return None
        prefix = up_command[1:up_index]  # drop the leading "docker"
        down_command = ["docker", *prefix, "down", "--remove-orphans"]
        return (down_command, cwd)

    def _stop_process(self, attr: str) -> None:
        proc = getattr(self, attr)
        if proc is not None:
            self._terminate_process(proc, timeout=12)
        setattr(self, attr, None)

    @staticmethod
    def _terminate_process(proc: ProcessLike, *, timeout: float) -> None:
        if proc.poll() is not None:
            return
        signaled_group = False
        if os.name != "nt" and isinstance(proc, subprocess.Popen):
            try:
                os.killpg(proc.pid, signal.SIGTERM)
                signaled_group = True
            except Exception:
                signaled_group = False
        if not signaled_group:
            try:
                proc.terminate()
            except Exception:
                pass
        try:
            proc.wait(timeout=timeout)
            return
        except Exception:
            pass
        if os.name != "nt" and signaled_group:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=3)
                return
            except Exception:
                pass
        try:
            proc.kill()
        except Exception:
            pass

    @staticmethod
    def _process_state(proc: ProcessLike | None) -> tuple[int | None, bool, int | None]:
        if proc is None:
            return None, False, None
        returncode = proc.poll()
        return proc.pid, returncode is None, returncode

    @staticmethod
    def _process_exit_error(name: str, returncode: int | None, log_path: Path) -> str:
        if returncode is None:
            return ""
        return f"{name} process exited with code {returncode}; see {log_path}"

    def _wait_for_hermes(self, process: ProcessLike | None = None) -> RuntimeStatus:
        # Snapshot the launched process handle so the wait loop does not need the
        # broad lock; default to the current handle for direct/legacy callers.
        proc = process if process is not None else self._hermes_process
        deadline = time.monotonic() + self._effective_startup_wait_seconds()
        while time.monotonic() < deadline:
            status = self.hermes_status(refresh=True)
            if status.available or status.state == "degraded":
                return status
            # No live process to wait for (launch failed or never started, or it
            # has already exited): the failure is already known, so return the
            # freshly refreshed status immediately instead of sleeping out the
            # whole startup window.
            if proc is None or proc.poll() is not None:
                return status
            time.sleep(0.25)
        return self.hermes_status(refresh=True)

    def _wait_for_runtime(self, name: str, process: ProcessLike | None = None) -> RuntimeStatus:
        # Snapshot the launched process handle so the busy-poll does not need the
        # broad lock held; default to the current handle for direct callers.
        process_attr = "_camofox_process" if name == "camofox" else "_firecrawl_process"
        proc = process if process is not None else getattr(self, process_attr)
        status_fn = self.camofox_status if name == "camofox" else self.firecrawl_status
        deadline = time.monotonic() + self._runtime_startup_wait_seconds(name)
        while time.monotonic() < deadline:
            status = status_fn(refresh=True)
            if status.available:
                return status
            if proc is None or proc.poll() is not None:
                return status
            time.sleep(0.25)
        return status_fn(refresh=True)

    def _install_enterprise_plugin(self, home: Path) -> None:
        source = Path(__file__).resolve().parents[1] / "hermes_plugin" / HERMES_PLUGIN_DIR
        dest = home / "plugins" / HERMES_PLUGIN_DIR
        if not source.exists():
            raise FileNotFoundError(f"enterprise Hermes plugin source not found: {source}")
        signature = self._plugin_source_signature(source)
        marker = dest / ".enterprise_plugin_signature"
        if dest.exists():
            try:
                if marker.read_text(encoding="utf-8").strip() == signature:
                    # Already up to date — skip the rmtree/copytree so the hot
                    # path does not churn the filesystem (and so a live Hermes
                    # process never sees the plugin dir momentarily vanish).
                    return
            except OSError:
                pass
        dest.parent.mkdir(parents=True, exist_ok=True)
        # Copy into a sibling temp dir and atomically swap it in, so a running
        # process scanning the plugins dir never observes a half-copied or
        # missing directory.
        staging = dest.with_name(f"{dest.name}.tmp.{os.getpid()}")
        if staging.exists():
            shutil.rmtree(staging)
        shutil.copytree(source, staging, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        (staging / ".enterprise_plugin_signature").write_text(signature, encoding="utf-8")
        previous = dest.with_name(f"{dest.name}.old.{os.getpid()}")
        if dest.exists():
            os.replace(str(dest), str(previous))
        try:
            os.replace(str(staging), str(dest))
        except OSError:
            # Restore the previous copy if the swap-in failed.
            if previous.exists() and not dest.exists():
                os.replace(str(previous), str(dest))
            if staging.exists():
                shutil.rmtree(staging, ignore_errors=True)
            raise
        if previous.exists():
            shutil.rmtree(previous, ignore_errors=True)

    @staticmethod
    def _plugin_source_signature(source: Path) -> str:
        """Content fingerprint of the plugin source tree (excluding caches)."""
        import hashlib

        digest = hashlib.sha256()
        for path in sorted(source.rglob("*")):
            rel = path.relative_to(source)
            if any(part == "__pycache__" for part in rel.parts) or path.suffix == ".pyc":
                continue
            digest.update(str(rel).encode("utf-8"))
            digest.update(b"\0")
            if path.is_file():
                try:
                    digest.update(path.read_bytes())
                except OSError:
                    pass
            digest.update(b"\0")
        return digest.hexdigest()

    def _ensure_hermes_config(self, home: Path) -> None:
        # Share internal_config's transaction lock so an admin field update and
        # the runtime's managed-key refresh cannot both read the same old YAML
        # and then overwrite one another.
        with _internal_config._CONFIG_UPDATE_LOCK:
            path = home / "config.yaml"
            data: dict[str, Any] = {}
            if path.exists():
                loaded = _read_yaml_mapping(path)
                if loaded is not None:
                    data = loaded
            plugins = data.setdefault("plugins", {})
            if not isinstance(plugins, dict):
                plugins = {}
                data["plugins"] = plugins
            enabled = plugins.setdefault("enabled", [])
            if not isinstance(enabled, list):
                enabled = []
            enabled_set = {str(item) for item in enabled}
            enabled_set.add(HERMES_PLUGIN_KEY)
            plugins["enabled"] = sorted(enabled_set)
            self._apply_managed_model_config(data)
            self._apply_managed_tool_config(data)
            _write_yaml_mapping(path, data)

    def _apply_managed_model_config(self, data: dict[str, Any]) -> None:
        model_setting = self._runtime_setting(HERMES_SETTING_MODEL)
        provider_setting = self._runtime_setting(HERMES_SETTING_PROVIDER)
        base_url_setting = self._runtime_setting(HERMES_SETTING_PROVIDER_BASE_URL)
        if model_setting is None and provider_setting is None and base_url_setting is None:
            return

        existing = data.get("model")
        if isinstance(existing, dict):
            model_config = existing
        elif isinstance(existing, str) and existing.strip():
            model_config = {"default": existing.strip()}
        else:
            model_config = {}
        data["model"] = model_config

        if model_setting is not None:
            model_config["default"] = self._effective_hermes_model()

        if provider_setting is not None:
            provider = self._effective_hermes_provider()
            model_config["provider"] = provider
            base_url = self._effective_hermes_provider_base_url(provider)
            if base_url:
                model_config["base_url"] = base_url
            else:
                model_config.pop("base_url", None)
        elif base_url_setting is not None:
            base_url = self._effective_hermes_provider_base_url(self._effective_hermes_provider())
            if base_url:
                model_config["base_url"] = base_url
            else:
                model_config.pop("base_url", None)

    @staticmethod
    def _mapping_at(data: dict[str, Any], key: str) -> dict[str, Any]:
        value = data.get(key)
        if isinstance(value, dict):
            return value
        value = {}
        data[key] = value
        return value

    def _apply_managed_tool_config(self, data: dict[str, Any]) -> None:
        terminal = self._mapping_at(data, "terminal")
        terminal["backend"] = "local"
        terminal["persistent_shell"] = False

        web = self._mapping_at(data, "web")
        web["backend"] = "firecrawl"
        web["search_backend"] = "firecrawl"
        web["extract_backend"] = "firecrawl"
        web["crawl_backend"] = "firecrawl"

        browser = self._mapping_at(data, "browser")
        browser["cloud_provider"] = "local"
        camofox = browser.get("camofox")
        if not isinstance(camofox, dict):
            camofox = {}
            browser["camofox"] = camofox
        camofox["managed_persistence"] = True

    def _write_hermes_env(self, home: Path) -> None:
        with _internal_config._CONFIG_UPDATE_LOCK:
            env_values = self._hermes_child_values()
            path = home / ".env"
            existing = _read_env_file(path)
            # These keys are wholly platform-managed. Remove the previous set
            # before applying current values so an upgrade from relay=true to
            # the new relay=false default cannot leave a live connector and its
            # authentication secret behind in Hermes' override-loaded .env.
            for key in _MANAGED_HERMES_RELAY_ENV_KEYS:
                existing.pop(key, None)
            existing.update(env_values)
            _write_env_file(path, existing)
            if not self._managed_hermes_relay_enabled():
                try:
                    (home / "relay-auth.json").unlink()
                except FileNotFoundError:
                    pass

    def _write_hermes_auth(self, home: Path) -> None:
        auth_path = home / "auth.json"
        # Hermes refreshes one-time OAuth tokens under auth.lock. Share that
        # exact cross-process lock across our full read/merge/replace sequence;
        # otherwise a platform refresh can overwrite a token rotation that
        # committed after our stale read.
        with _internal_config._CONFIG_UPDATE_LOCK, _hermes_auth_store_lock(auth_path):
            auth_store = _read_json_mapping(auth_path)
            providers = auth_store.setdefault("providers", {})
            if not isinstance(providers, dict):
                providers = {}
                auth_store["providers"] = providers

            changed = False
            changed |= self._upsert_codex_oauth(providers)
            changed |= self._upsert_xai_oauth(providers)

            provider = self._effective_hermes_provider()
            if provider in SUPPORTED_OAUTH_PROVIDERS and isinstance(providers.get(provider), dict):
                if auth_store.get("active_provider") != provider:
                    auth_store["active_provider"] = provider
                    changed = True

            if changed:
                auth_store["version"] = auth_store.get("version") or 2
                auth_store["updated_at"] = _iso_now()
                _write_json_secure(auth_path, auth_store)

    def _upsert_codex_oauth(self, providers: dict[str, Any]) -> bool:
        access_token = self._first_secret(
            "CODEX_OAUTH_ACCESS_TOKEN",
        )
        refresh_token = self._first_secret(
            "CODEX_OAUTH_REFRESH_TOKEN",
        )
        if not access_token or not refresh_token:
            return False
        state = providers.get("openai-codex")
        if not isinstance(state, dict):
            state = {}
        if self._oauth_relogin_error_matches_synced_db(state, refresh_token):
            providers["openai-codex"] = state
            return self._clear_provider_tokens_after_relogin_error(state)
        if not self._db_oauth_supersedes(state, refresh_token):
            # auth.json already holds a populated token block that the platform
            # has not been told to replace (the DB still carries the same token
            # the platform previously synced). Managed Hermes rotates Codex
            # refresh tokens on every refresh and writes the new pair back into
            # auth.json; overwriting with the stale DB copy here would replay a
            # consumed refresh token and force re-login, so leave it untouched.
            return False
        original = json.dumps(state, sort_keys=True)
        tokens = dict(state.get("tokens") or {})
        tokens["access_token"] = access_token
        tokens["refresh_token"] = refresh_token
        state["tokens"] = tokens
        state["auth_mode"] = "chatgpt"
        state["last_refresh"] = _iso_now()
        state["platform_synced_refresh_token"] = refresh_token
        state.pop("last_auth_error", None)
        changed = original != json.dumps(state, sort_keys=True)
        providers["openai-codex"] = state
        return changed

    def _upsert_xai_oauth(self, providers: dict[str, Any]) -> bool:
        access_token = self._first_secret("GROK_OAUTH_ACCESS_TOKEN")
        refresh_token = self._first_secret("GROK_OAUTH_REFRESH_TOKEN")
        if not access_token or not refresh_token:
            return False
        state = providers.get("xai-oauth")
        if not isinstance(state, dict):
            state = {}
        if self._oauth_relogin_error_matches_synced_db(state, refresh_token):
            providers["xai-oauth"] = state
            return self._clear_provider_tokens_after_relogin_error(state)
        if not self._db_oauth_supersedes(state, refresh_token):
            # See _upsert_codex_oauth: keep the Hermes-rotated token in auth.json
            # authoritative unless the DB carries a genuinely new credential
            # (a fresh interactive login changes the stored refresh token).
            return False
        original = json.dumps(state, sort_keys=True)
        tokens = dict(state.get("tokens") or {})
        tokens["access_token"] = access_token
        tokens["refresh_token"] = refresh_token
        id_token = self._first_secret("GROK_OAUTH_ID_TOKEN")
        if id_token:
            tokens["id_token"] = id_token
        tokens.setdefault("token_type", "Bearer")
        state["tokens"] = tokens
        state["auth_mode"] = "oauth_pkce"
        state["last_refresh"] = _iso_now()
        state["platform_synced_refresh_token"] = refresh_token
        state.pop("last_auth_error", None)
        changed = original != json.dumps(state, sort_keys=True)
        providers["xai-oauth"] = state
        return changed

    @staticmethod
    def _oauth_relogin_error_matches_synced_db(state: dict[str, Any], db_refresh_token: str) -> bool:
        """Return True when Hermes quarantined the DB credential we last synced."""
        last_error = state.get("last_auth_error")
        if not isinstance(last_error, dict) or not last_error.get("relogin_required"):
            return False
        synced = str(state.get("platform_synced_refresh_token") or "")
        return bool(synced and db_refresh_token == synced)

    @staticmethod
    def _clear_provider_tokens_after_relogin_error(state: dict[str, Any]) -> bool:
        original = json.dumps(state, sort_keys=True)
        tokens = state.get("tokens")
        if not isinstance(tokens, dict):
            tokens = {}
        else:
            tokens = dict(tokens)
        for key in ("access_token", "refresh_token", "id_token"):
            tokens.pop(key, None)
        state["tokens"] = tokens
        return original != json.dumps(state, sort_keys=True)

    @staticmethod
    def _db_oauth_supersedes(state: dict[str, Any], db_refresh_token: str) -> bool:
        """Decide whether the DB credential should overwrite the auth.json block.

        Managed Hermes owns refresh-token rotation and persists the rotated pair
        into auth.json, while the platform settings DB is only written by an
        interactive login. To keep Hermes rotations from being clobbered without
        a service.py-side change, the platform records the refresh token it last
        synced into auth.json as ``platform_synced_refresh_token``. The DB copy
        wins only when:

        * auth.json has no populated refresh token yet (first-time bootstrap), or
        * the DB refresh token differs from the one the platform last synced,
          which only happens after a fresh interactive login (Hermes rotations
          never touch the DB, so the synced marker keeps matching the DB).

        When the DB token still equals the synced marker but the live auth.json
        token has moved on, that is a Hermes rotation and auth.json stays
        authoritative.
        """
        tokens = state.get("tokens") if isinstance(state.get("tokens"), dict) else {}
        existing_refresh = str(tokens.get("refresh_token") or "")
        if not existing_refresh:
            return True
        synced = str(state.get("platform_synced_refresh_token") or "")
        if not synced:
            # Pre-existing auth.json from before this marker was introduced: only
            # overwrite if the DB credential actually differs, so an identical
            # value is left in place and a genuinely fresh login still wins.
            return db_refresh_token != existing_refresh
        return db_refresh_token != synced

    def _first_secret(self, *keys: str) -> str:
        for key in keys:
            value = self.secret_provider(key)
            if value:
                return str(value).strip()
        return ""

    def _hermes_process_env(self) -> dict[str, str]:
        env = os.environ.copy()
        # The platform service may have bootstrap/admin/integration secrets in
        # its own environment. Hermes receives only the explicit values below;
        # unrelated ENTERPRISE_* credentials must not be inherited wholesale
        # and later become visible to plugins or terminal subprocesses.
        for key in list(env):
            upper = key.upper()
            if upper.startswith("ENTERPRISE_") and upper.endswith(_PLATFORM_SECRET_ENV_SUFFIXES):
                env.pop(key, None)
        env.update(self._hermes_child_values())
        env["HERMES_HOME"] = str(self.config.managed_hermes_home)
        # Point the managed Hermes process at a dedicated scratch dir under the
        # platform data dir (mirrored by EnterpriseService._managed_media_tmp_dir)
        # so generated media lands in a trusted media root. The shared system
        # temp dir is intentionally NOT an allowed media root, so without this
        # MEDIA: attachments written to the default /tmp would be refused.
        scratch = self.config.managed_hermes_home / "tmp"
        try:
            scratch.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
        scratch_str = str(scratch)
        env["TMPDIR"] = scratch_str
        env["TEMP"] = scratch_str
        env["TMP"] = scratch_str
        source = self._effective_hermes_runtime_source()
        patch_path = Path(__file__).resolve().parent / "hermes_runtime_patch"
        python_path_parts = [str(patch_path)]
        if source.exists():
            current = env.get("PYTHONPATH", "")
            python_path_parts.append(str(source))
            if current:
                python_path_parts.append(current)
        elif env.get("PYTHONPATH"):
            python_path_parts.append(env["PYTHONPATH"])
        env["PYTHONPATH"] = os.pathsep.join(python_path_parts)
        provider = self._effective_hermes_provider()
        provider_base_url = self._effective_hermes_provider_base_url(provider)
        env["HERMES_INFERENCE_PROVIDER"] = provider
        if provider == "openai-codex" and provider_base_url:
            env["HERMES_CODEX_BASE_URL"] = provider_base_url
        if provider == "xai-oauth" and provider_base_url:
            env["HERMES_XAI_BASE_URL"] = provider_base_url
            env["XAI_BASE_URL"] = provider_base_url
        return env

    def _hermes_child_values(self) -> dict[str, str]:
        parsed = urllib.parse.urlparse(self._effective_hermes_api_url())
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or 8642
        api_key = self.config.hermes_api_key or self.secret_provider("ENTERPRISE_HERMES_API_KEY") or self.secret_provider("API_SERVER_KEY")
        values = {
            "HERMES_HOME": str(self.config.managed_hermes_home),
            "API_SERVER_ENABLED": "true",
            "API_SERVER_HOST": host,
            "API_SERVER_PORT": str(port),
            "API_SERVER_MODEL_NAME": self._effective_hermes_model(),
            "ENTERPRISE_PLATFORM_URL": self._effective_platform_url(),
            "ENTERPRISE_AGENT_TOOL_TOKEN": self.secret_provider("agent_tool_token") or "",
            "HERMES_ACCEPT_HOOKS": "1",
            "COGNEE_SKIP_CONNECTION_TEST": "true",
            "TERMINAL_ENV": "local",
            "TERMINAL_LOCAL_PERSISTENT": "false",
            "TERMINAL_PERSISTENT_SHELL": "false",
            "CAMOFOX_URL": self._effective_camofox_url(),
            "CAMOFOX_API_KEY": self._camofox_access_key(),
            "FIRECRAWL_API_URL": self._effective_firecrawl_api_url(),
        }
        provider = self._effective_hermes_provider()
        provider_base_url = self._effective_hermes_provider_base_url(provider)
        values["HERMES_INFERENCE_PROVIDER"] = provider
        if provider == "openai-codex" and provider_base_url:
            values["HERMES_CODEX_BASE_URL"] = provider_base_url
        if provider == "xai-oauth" and provider_base_url:
            values["HERMES_XAI_BASE_URL"] = provider_base_url
            values["XAI_BASE_URL"] = provider_base_url
        if api_key:
            values["API_SERVER_KEY"] = api_key
        if self._managed_hermes_relay_enabled():
            relay_id, relay_secret = managed_relay_auth(self.config)
            values["GATEWAY_RELAY_URL"] = self._effective_hermes_relay_url()
            values["GATEWAY_RELAY_PLATFORMS"] = "relay"
            values["GATEWAY_RELAY_BOT_IDS"] = json.dumps({"relay": {"botId": "enterprise-web"}})
            values["GATEWAY_RELAY_ID"] = relay_id
            values["GATEWAY_RELAY_SECRET"] = relay_secret
        return values

    def _hermes_command(self) -> tuple[list[str], Path | None, str]:
        source = self._effective_hermes_runtime_source()
        venv_python = self._hermes_venv_python()
        if self._managed_venv_ready():
            return (
                [str(venv_python), "-m", "hermes_cli.main", "gateway", "run", "--replace", "--quiet"],
                source,
                f"managed patched source install: {source}",
            )
        return ([], None, f"Hermes is not installed from managed source: {source}")

    def _camofox_command(self) -> tuple[list[str], Path | None, str]:
        configured = self._effective_camofox_command()
        if configured:
            return (shlex.split(configured), None, configured)
        return (
            [
                "npx",
                "-y",
                f"@askjo/camofox-browser@{CAMOFOX_MANAGED_VERSION}",
            ],
            None,
            f"npm package: @askjo/camofox-browser@{CAMOFOX_MANAGED_VERSION}",
        )

    def _firecrawl_command(self) -> tuple[list[str], Path | None, str]:
        configured = self._effective_firecrawl_command()
        repo = self._effective_firecrawl_repo()
        if configured:
            return (shlex.split(configured), repo if repo.exists() else None, configured)
        if not repo.exists():
            return ([], repo, f"Firecrawl source not found: {repo}")
        compose_file = self._firecrawl_compose_file(repo)
        if compose_file is None:
            return ([], repo, f"Firecrawl repository is missing a Docker Compose file: {repo}")
        override = self._ensure_firecrawl_compose_override()
        # Source the managed .env from the platform data dir instead of letting
        # compose pick up repo/.env, so the generated secret never lands in the
        # submodule working tree. The file is materialized by prepare_firecrawl /
        # _start_firecrawl; building the argv stays side-effect free for status
        # polls (which also call this helper).
        env_file = self._firecrawl_env_path()
        return (
            [
                "docker",
                "compose",
                "--env-file",
                str(env_file),
                "-f",
                compose_file.name,
                "-f",
                str(override),
                "up",
                "--no-build",
                "--pull",
                "missing",
            ],
            repo,
            f"self-hosted Firecrawl compose stack: {repo}",
        )

    @staticmethod
    def _firecrawl_compose_file(repo: Path) -> Path | None:
        for name in ("docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"):
            path = repo / name
            if path.exists():
                return path
        return None

    def _ensure_firecrawl_compose_override(self) -> Path:
        override = self.config.firecrawl_runtime_dir / FIRECRAWL_COMPOSE_OVERRIDE
        lines = [
            "# Generated by Enterprise Agent Platform for managed local runtime.",
            "# Every image is pinned to an immutable registry digest.",
            "services:",
        ]
        for service, image in FIRECRAWL_SERVICE_IMAGES:
            lines.extend((f"  {service}:", f"    image: {image}"))
        lines.append("")
        text = "\n".join(lines)
        override.parent.mkdir(parents=True, exist_ok=True)
        if not override.exists() or override.read_text(encoding="utf-8") != text:
            override.write_text(text, encoding="utf-8")
        return override

    def _firecrawl_env_path(self) -> Path:
        # Keep the managed Firecrawl .env (which carries a generated
        # BULL_AUTH_KEY secret) under the platform data directory rather than
        # inside the firecrawl submodule working tree, per AGENTS.md guidance to
        # keep managed runtime state out of the repo.
        return self.config.firecrawl_runtime_dir / ".env"

    def _ensure_firecrawl_env(self) -> Path:
        env_path = self._firecrawl_env_path()
        values = _read_env_file(env_path)
        port = str(urllib.parse.urlparse(self._effective_firecrawl_api_url()).port or 3002)
        defaults = {
            "PORT": f"127.0.0.1:{port}",
            "HOST": "0.0.0.0",
            "USE_DB_AUTHENTICATION": "false",
            "BULL_AUTH_KEY": self._firecrawl_bull_auth_key(),
        }
        changed = False
        for key, value in defaults.items():
            # PORT/HOST are managed security boundaries and must also repair
            # files generated by older releases. Secrets remain stable once
            # materialized.
            if (key in {"PORT", "HOST"} and values.get(key) != value) or not values.get(key):
                values[key] = value
                changed = True
        if changed or not env_path.exists():
            env_path.parent.mkdir(parents=True, exist_ok=True)
            _write_env_file(env_path, values)
        return env_path

    def _firecrawl_bull_auth_key(self) -> str:
        for key in ("FIRECRAWL_BULL_AUTH_KEY", "BULL_AUTH_KEY"):
            try:
                value = self.secret_provider(key)
            except Exception:
                value = ""
            if value:
                return str(value)
        return secrets.token_urlsafe(24)

    def _camofox_access_key(self) -> str:
        value = self._first_secret("CAMOFOX_ACCESS_KEY", "CAMOFOX_API_KEY")
        if value:
            return value
        path = self.config.runtime_dir / "camofox" / "access-key"
        try:
            current = path.read_text(encoding="utf-8").strip()
        except OSError:
            current = ""
        if len(current) >= 32:
            try:
                path.chmod(0o600)
            except OSError:
                pass
            return current
        value = secrets.token_urlsafe(48)
        _write_text_secure(path, value + "\n")
        return value

    @staticmethod
    def _managed_loopback_url_error(name: str, url: str) -> str:
        try:
            parsed = urllib.parse.urlparse(url)
        except ValueError:
            parsed = None
        if parsed is None or parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return f"Managed {name} URL must be an http(s) loopback URL"
        if not _is_loopback_host(parsed.hostname):
            return f"Managed {name} must listen on a loopback address"
        return ""

    def _probe_hermes_health(self) -> bool:
        try:
            request = urllib.request.Request(self._hermes_health_url(), method="GET")
            with urllib.request.urlopen(request, timeout=0.6) as response:
                return 200 <= response.status < 300
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            return False

    def _probe_hermes_patch_status(self) -> dict[str, Any]:
        parsed = urllib.parse.urlparse(self._hermes_health_url())
        url = urllib.parse.urlunparse(
            (parsed.scheme or "http", parsed.netloc, "/api/enterprise-patch-status", "", "", "")
        )
        headers: dict[str, str] = {}
        api_key = (
            self.config.hermes_api_key
            or self.secret_provider("ENTERPRISE_HERMES_API_KEY")
            or self.secret_provider("API_SERVER_KEY")
        )
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        try:
            request = urllib.request.Request(url, headers=headers, method="GET")
            with urllib.request.urlopen(request, timeout=0.8) as response:
                if not 200 <= response.status < 300:
                    return {"available": False, "error": f"HTTP {response.status}"}
                payload = json.loads(response.read(64 * 1024).decode("utf-8"))
            if not isinstance(payload, dict) or payload.get("object") != "enterprise.hermes_patch_status":
                return {"available": False, "error": "unexpected response"}
            return {
                "available": True,
                "ok": bool(payload.get("ok")),
                "components": dict(payload.get("status") or {}),
                "failed": dict(payload.get("failed") or {}),
            }
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError) as exc:
            return {"available": False, "error": str(exc)[:300]}

    def _probe_camofox_health(self) -> bool:
        return self._probe_json_health(
            self._effective_camofox_url(),
            ("/health",),
            lambda payload: payload.get("ok") is True and payload.get("engine") == "camoufox",
        )

    def _probe_firecrawl_health(self) -> bool:
        return self._probe_json_health(
            self._effective_firecrawl_api_url(),
            ("/v0/health/liveness", "/"),
            lambda payload: payload.get("status") == "ok" or payload.get("message") == "Firecrawl API",
        )

    @staticmethod
    def _probe_json_health(base_url: str, paths: tuple[str, ...], validator) -> bool:
        base = base_url.rstrip("/")
        if not base:
            return False
        for path in paths:
            try:
                request = urllib.request.Request(f"{base}{path}", method="GET")
                with urllib.request.urlopen(request, timeout=0.8) as response:
                    if not 200 <= response.status < 300:
                        continue
                    raw = response.read(64 * 1024)
                    payload = json.loads(raw.decode("utf-8"))
                    if isinstance(payload, dict) and bool(validator(payload)):
                        return True
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError):
                continue
        return False

    def _hermes_health_url(self) -> str:
        parsed = urllib.parse.urlparse(self._effective_hermes_api_url())
        scheme = parsed.scheme or "http"
        netloc = parsed.netloc
        if not netloc:
            return "http://127.0.0.1:8642/health"
        return urllib.parse.urlunparse((scheme, netloc, "/health", "", "", ""))

    # Cognee env keys that name a directory the platform should materialize.
    _COGNEE_DIR_KEYS = (
        "DATA_ROOT_DIRECTORY",
        "SYSTEM_ROOT_DIRECTORY",
        "CACHE_ROOT_DIRECTORY",
        "COGNEE_LOGS_DIR",
    )

    def _seed_cognee_env(self) -> None:
        values = self._cognee_env_values()
        # Only mkdir the known directory keys. Iterating every merged .env value
        # would blindly create directory trees for arbitrary path-like values
        # (e.g. a sqlite file path or migration db path that starts with "/"),
        # which can later break Cognee when it opens that path as a file.
        for key in self._COGNEE_DIR_KEYS:
            path = values.get(key)
            if path and (path.startswith("/") or path.startswith("~")):
                Path(path).expanduser().mkdir(parents=True, exist_ok=True)
        for key, value in values.items():
            os.environ[key] = value

    def _managed_hermes_enabled(self) -> bool:
        value = self._runtime_setting(HERMES_SETTING_MANAGED)
        if value is None:
            return self.config.manage_hermes
        return str(value).strip().lower() in {"1", "true", "yes", "on"}

    def _managed_hermes_relay_enabled(self) -> bool:
        return self._managed_hermes_enabled() and bool(self.config.hermes_relay_enabled)

    def _managed_cognee_enabled(self) -> bool:
        value = self._runtime_setting(COGNEE_SETTING_MANAGED)
        if value is None:
            return self.config.manage_cognee
        return str(value).strip().lower() in {"1", "true", "yes", "on"}

    def _managed_camofox_enabled(self) -> bool:
        value = self._runtime_setting(CAMOFOX_SETTING_MANAGED)
        if value is None:
            return self.config.manage_camofox
        return str(value).strip().lower() in {"1", "true", "yes", "on"}

    def _managed_firecrawl_enabled(self) -> bool:
        value = self._runtime_setting(FIRECRAWL_SETTING_MANAGED)
        if value is None:
            return self.config.manage_firecrawl
        return str(value).strip().lower() in {"1", "true", "yes", "on"}

    def _effective_hermes_repo(self) -> Path:
        value = self._runtime_setting(HERMES_SETTING_REPO)
        return Path(value).expanduser() if value else self.config.hermes_repo

    def _effective_hermes_api_url(self) -> str:
        return self._runtime_setting(HERMES_SETTING_API_URL) or self.config.hermes_api_url

    def _effective_hermes_model(self) -> str:
        return self._runtime_setting(HERMES_SETTING_MODEL) or self.config.hermes_model

    def _effective_hermes_provider(self) -> str:
        value = self._runtime_setting(HERMES_SETTING_PROVIDER) or self.config.hermes_provider
        provider = normalize_hermes_provider(value)
        return provider if provider in SUPPORTED_OAUTH_PROVIDERS else "openai-codex"

    def _effective_hermes_provider_base_url(self, provider: str | None = None) -> str:
        provider = normalize_hermes_provider(provider or self._effective_hermes_provider())
        value = self._runtime_setting(HERMES_SETTING_PROVIDER_BASE_URL) or self.config.hermes_provider_base_url
        if value:
            return str(value).strip().rstrip("/")
        return default_base_url_for_provider(provider)

    def _effective_platform_url(self) -> str:
        return (self._runtime_setting("platform_public_base_url") or self.config.public_base_url).strip().rstrip("/")

    def _effective_hermes_relay_url(self) -> str:
        host = (self.config.hermes_relay_host or "127.0.0.1").strip() or "127.0.0.1"
        port = int(self.config.hermes_relay_port or 18766)
        return f"ws://{host}:{port}/relay"

    def _effective_install_extras(self) -> str:
        return self._runtime_setting(HERMES_SETTING_INSTALL_EXTRAS) or self.config.hermes_install_extras

    def _effective_startup_wait_seconds(self) -> float:
        raw = self._runtime_setting(HERMES_SETTING_STARTUP_WAIT)
        if not raw:
            return self.config.runtime_startup_wait_seconds
        try:
            return max(0.0, float(raw))
        except ValueError:
            return self.config.runtime_startup_wait_seconds

    def _runtime_startup_wait_seconds(self, name: str) -> float:
        """Warm-up budget for the heavier managed runtimes.

        Camofox (npx package + browser download) and Firecrawl
        (``docker compose up --pull missing`` over multi-hundred-MB images) take
        far longer than Hermes to become healthy on a cold start, so they get
        their own, larger budgets instead of reusing the Hermes-tuned value.
        Both honour the Hermes startup wait as a floor and an env override.
        """
        env_key = f"ENTERPRISE_{name.upper()}_STARTUP_WAIT_SECONDS"
        raw = os.environ.get(env_key)
        if raw:
            try:
                return max(0.0, float(raw))
            except ValueError:
                pass
        # Honour an explicit no-wait configuration (0): operators who opt into
        # async startup — and the test suite — must not be forced to block on
        # the larger cold-start floor. Only apply the heavier default when a
        # startup wait is actually requested.
        base = self._effective_startup_wait_seconds()
        if base <= 0:
            return 0.0
        default = 300.0 if name == "firecrawl" else 120.0
        return max(default, base)

    def _effective_hermes_timeout_seconds(self) -> float:
        raw = self._runtime_setting(HERMES_SETTING_TIMEOUT)
        if not raw:
            return self.config.hermes_timeout_seconds
        try:
            return max(1.0, float(raw))
        except ValueError:
            return self.config.hermes_timeout_seconds

    def _effective_camofox_url(self) -> str:
        return (self._runtime_setting(CAMOFOX_SETTING_URL) or self.config.camofox_url or "http://127.0.0.1:9377").strip().rstrip("/")

    def _effective_camofox_command(self) -> str:
        return self._runtime_setting(CAMOFOX_SETTING_COMMAND) or self.config.camofox_command

    def _effective_firecrawl_repo(self) -> Path:
        value = self._runtime_setting(FIRECRAWL_SETTING_REPO)
        if value:
            return Path(value).expanduser()
        if self.config.firecrawl_repo is not None:
            return self.config.firecrawl_repo
        return self.config.data_dir.parent / "firecrawl"

    def _effective_firecrawl_api_url(self) -> str:
        return (self._runtime_setting(FIRECRAWL_SETTING_API_URL) or self.config.firecrawl_api_url or "http://127.0.0.1:3002").strip().rstrip("/")

    def _effective_firecrawl_command(self) -> str:
        return self._runtime_setting(FIRECRAWL_SETTING_COMMAND) or self.config.firecrawl_command

    def _effective_cognee_repo(self) -> Path:
        value = self._runtime_setting(COGNEE_SETTING_REPO)
        return Path(value).expanduser() if value else self.config.cognee_repo

    def _effective_cognee_backend(self) -> str:
        value = (self._runtime_setting(COGNEE_SETTING_BACKEND) or self.config.knowledge_backend).strip().lower()
        return value if value in {"local", "hybrid", "cognee"} else "hybrid"

    def _effective_cognee_dataset(self) -> str:
        return self._runtime_setting(COGNEE_SETTING_DATASET) or self.config.cognee_dataset

    def _effective_cognee_ingest_background(self) -> bool:
        value = self._runtime_setting(COGNEE_SETTING_INGEST_BACKGROUND)
        if value is None:
            return self.config.cognee_ingest_background
        return str(value).strip().lower() in {"1", "true", "yes", "on"}

    def _cognee_env_values(self) -> dict[str, str]:
        root = self.config.cognee_runtime_dir
        values = {
            "DATA_ROOT_DIRECTORY": self._runtime_setting(COGNEE_SETTING_DATA_ROOT) or str(root / "data"),
            "SYSTEM_ROOT_DIRECTORY": self._runtime_setting(COGNEE_SETTING_SYSTEM_ROOT) or str(root / "system"),
            "CACHE_ROOT_DIRECTORY": self._runtime_setting(COGNEE_SETTING_CACHE_ROOT) or str(root / "cache"),
            "COGNEE_LOGS_DIR": self._runtime_setting(COGNEE_SETTING_LOGS_DIR) or str(root / "logs"),
            "COGNEE_SKIP_CONNECTION_TEST": self._runtime_setting(COGNEE_SETTING_SKIP_CONNECTION_TEST) or "true",
        }
        values.update(_read_env_file(self._cognee_env_path()))
        return values

    def _cognee_env_path(self) -> Path:
        return self.config.cognee_runtime_dir / ".env"

    def _runtime_setting(self, key: str) -> str | None:
        if self.setting_provider is None:
            return None
        try:
            value = self.setting_provider(key)
        except Exception:
            return None
        return str(value) if value not in {None, ""} else None

    def _hermes_venv_dir(self) -> Path:
        return self.config.managed_hermes_home / "venv"

    def _hermes_venv_python(self) -> Path:
        if os.name == "nt":
            return self._hermes_venv_dir() / "Scripts" / "python.exe"
        return self._hermes_venv_dir() / "bin" / "python"

    def _managed_hermes_source_dir(self) -> Path:
        return self.config.managed_hermes_home / "source" / "hermes-agent"

    def _managed_hermes_source_marker_path(self) -> Path:
        return self.config.managed_hermes_home / "source" / "source.json"

    def _hermes_platform_patch_path(self) -> Path:
        return Path(__file__).resolve().parent / "hermes_runtime_patch" / "hermes_agent_isolation.patch"

    def _hermes_platform_patch_digest(self) -> str:
        patch_path = self._hermes_platform_patch_path()
        try:
            return hashlib.sha256(patch_path.read_bytes()).hexdigest()
        except OSError:
            return ""

    def _hermes_repo_revision(self, repo: Path) -> str:
        try:
            result = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=str(repo),
                text=True,
                capture_output=True,
                timeout=5,
                check=False,
            )
        except Exception:
            return ""
        if result.returncode != 0:
            return ""
        return result.stdout.strip()

    def _hermes_source_metadata(self, repo: Path) -> dict[str, Any]:
        patch_path = self._hermes_platform_patch_path()
        return {
            "source": str(repo),
            "source_revision": self._hermes_repo_revision(repo),
            "patch_path": str(patch_path),
            "patch_digest": self._hermes_platform_patch_digest(),
            "patch_applicable": self._hermes_platform_patch_applicable(repo),
        }

    def _hermes_platform_patch_applicable(self, source: Path) -> bool:
        # Tiny fake repos in tests do not contain the upstream API server files
        # this patch targets. Real Hermes sources do; if they drift, git apply
        # will fail and surface the incompatibility during managed install.
        return (source / "gateway" / "platforms" / "api_server.py").exists()

    def _managed_hermes_source_ready(self, repo: Path) -> bool:
        source = self._managed_hermes_source_dir()
        marker_path = self._managed_hermes_source_marker_path()
        if not (source / "pyproject.toml").exists() or not marker_path.exists():
            return False
        try:
            marker = json.loads(marker_path.read_text(encoding="utf-8"))
        except Exception:
            return False
        expected = self._hermes_source_metadata(repo)
        return all(marker.get(key) == value for key, value in expected.items())

    def _prepare_managed_hermes_source(self, repo: Path, *, force: bool = False) -> Path:
        source = self._managed_hermes_source_dir()
        if not force and self._managed_hermes_source_ready(repo):
            return source

        tmp_source = source.with_name(f"{source.name}.tmp")
        if tmp_source.exists():
            shutil.rmtree(tmp_source)
        source.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(
            repo,
            tmp_source,
            ignore=shutil.ignore_patterns(
                ".git",
                ".venv",
                "__pycache__",
                ".pytest_cache",
                ".mypy_cache",
                ".ruff_cache",
                "node_modules",
            ),
        )

        metadata = self._hermes_source_metadata(repo)
        if metadata["patch_applicable"]:
            patch_path = self._hermes_platform_patch_path()
            if not patch_path.exists():
                raise RuntimeError(f"Managed Hermes patch not found: {patch_path}")
            log_path = self.config.managed_hermes_home / "logs" / "managed-install.log"
            result = self.command_runner.run(
                ["git", "apply", "--whitespace=nowarn", str(patch_path)],
                cwd=tmp_source,
                env=os.environ.copy(),
                log_path=log_path,
                timeout=120,
            )
            if result.returncode != 0:
                raise RuntimeError(f"Managed Hermes patch failed with exit code {result.returncode}")

        if source.exists():
            shutil.rmtree(source)
        tmp_source.rename(source)
        marker_path = self._managed_hermes_source_marker_path()
        marker_path.parent.mkdir(parents=True, exist_ok=True)
        marker_path.write_text(json.dumps(metadata, sort_keys=True), encoding="utf-8")
        return source

    def _effective_hermes_runtime_source(self) -> Path:
        source = self._managed_hermes_source_dir()
        return source if source.exists() else self._effective_hermes_repo()

    def _install_marker_path(self) -> Path:
        return self.config.managed_hermes_home / HERMES_INSTALL_MARKER

    def _managed_venv_ready(self) -> bool:
        marker_path = self._install_marker_path()
        if not self._hermes_venv_python().exists() or not marker_path.exists():
            return False
        try:
            marker = json.loads(marker_path.read_text(encoding="utf-8"))
        except Exception:
            return False
        repo = self._effective_hermes_repo()
        source = self._managed_hermes_source_dir()
        return (
            self._managed_hermes_source_ready(repo)
            and marker.get("source") == str(repo)
            and marker.get("runtime_source") == str(source)
            and marker.get("source_revision", "") == self._hermes_repo_revision(repo)
            and marker.get("patch_digest", "") == self._hermes_platform_patch_digest()
            and marker.get("extras", "") == self._effective_install_extras()
        )

    def _hermes_install_state(self) -> str:
        if self._managed_venv_ready():
            return "installed"
        repo = self._effective_hermes_repo()
        if not repo.exists():
            return "missing-source"
        if not (repo / "pyproject.toml").exists():
            return "invalid-source"
        return "not-installed"

    def _hermes_install_error(self) -> str:
        state = self._hermes_install_state()
        repo = self._effective_hermes_repo()
        if state == "missing-source":
            return f"Hermes source not found: {repo}"
        if state == "invalid-source":
            return f"Invalid Hermes source: {repo}"
        if state == "not-installed":
            return f"Hermes source has not been installed into the managed venv: {repo}"
        return ""

    def _write_install_marker(self, repo: Path, runtime_source: Path) -> None:
        marker = {
            "source": str(repo),
            "runtime_source": str(runtime_source),
            "source_revision": self._hermes_repo_revision(repo),
            "patch_digest": self._hermes_platform_patch_digest(),
            "extras": self._effective_install_extras(),
            "installed_at": now_ts(),
        }
        self._install_marker_path().parent.mkdir(parents=True, exist_ok=True)
        self._install_marker_path().write_text(json.dumps(marker, sort_keys=True), encoding="utf-8")

    def _editable_install_target(self, repo: Path) -> str:
        extras = self._effective_install_extras().strip()
        return f"{repo}[{extras}]" if extras else str(repo)

    def _hermes_source_label(self) -> str:
        source = self._effective_hermes_runtime_source()
        repo = self._effective_hermes_repo()
        return f"{source} (patched from {repo})" if source != repo else str(repo)

    def _camofox_source_label(self) -> str:
        command, _cwd, detail = self._camofox_command()
        return detail if command else ""

    def _oauth_status(self) -> dict[str, dict[str, Any]]:
        path = self.config.managed_hermes_home / "auth.json"
        store = _read_json_mapping(path)
        providers = store.get("providers") if isinstance(store, dict) else {}
        result: dict[str, dict[str, Any]] = {}
        for provider in ("openai-codex", "xai-oauth"):
            state = providers.get(provider) if isinstance(providers, dict) else None
            tokens = state.get("tokens") if isinstance(state, dict) else None
            last_auth_error = state.get("last_auth_error") if isinstance(state, dict) else None
            if not isinstance(last_auth_error, dict):
                last_auth_error = None
            relogin_required = bool(last_auth_error and last_auth_error.get("relogin_required"))
            result[provider] = {
                "configured": bool(
                    isinstance(tokens, dict)
                    and tokens.get("access_token")
                    and tokens.get("refresh_token")
                    and not relogin_required
                ),
                "auth_store": str(path),
                "last_refresh": state.get("last_refresh") if isinstance(state, dict) else None,
                "active": store.get("active_provider") == provider,
                "last_auth_error": dict(last_auth_error) if last_auth_error else None,
            }
        return result


def _module_importable(name: str) -> bool:
    try:
        __import__(name)
        return True
    except Exception:
        return False


def normalize_hermes_provider(value: str | None) -> str:
    clean = (value or "openai-codex").strip().lower().replace("_", "-")
    aliases = {
        "": "openai-codex",
        "auto": "openai-codex",
        "default": "openai-codex",
        "codex": "openai-codex",
        "openai-codex-oauth": "openai-codex",
        "grok": "xai-oauth",
        "grok-oauth": "xai-oauth",
        "x-ai-oauth": "xai-oauth",
        "xai-grok-oauth": "xai-oauth",
    }
    return aliases.get(clean, clean)


def default_base_url_for_provider(provider: str) -> str:
    provider = normalize_hermes_provider(provider)
    info = OAUTH_PROVIDER_INFO.get(provider)
    return str(info.get("base_url", "")) if info else ""


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _read_json_mapping(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": 2, "providers": {}}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"version": 2, "providers": {}}
    return loaded if isinstance(loaded, dict) else {"version": 2, "providers": {}}


@contextmanager
def _hermes_auth_store_lock(auth_path: Path):
    """Share Hermes' ``auth.lock`` advisory lock for auth.json mutations."""

    lock_path = auth_path.with_suffix(".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(lock_path), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        os.chmod(lock_path, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def _write_text_secure(path: Path, text: str) -> None:
    """Atomically write text to ``path`` with owner-only (0600) permissions.

    The temp file is created with 0600 from the start (via os.open) so secrets
    are never briefly world/group readable, then atomically renamed into place.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp.{os.getpid()}.{secrets.token_hex(6)}")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise
    os.replace(str(tmp), str(path))
    try:
        path.chmod(0o600)
    except OSError:
        pass


def _write_json_secure(path: Path, data: dict[str, Any]) -> None:
    _write_text_secure(path, json.dumps(data, indent=2, sort_keys=True) + "\n")


def _read_yaml_mapping(path: Path) -> dict[str, Any] | None:
    try:
        import yaml
    except Exception:
        return {} if not path.exists() else None
    try:
        loaded = yaml.safe_load(path.read_text(encoding="utf-8")) if path.exists() else {}
    except Exception:
        return None
    return loaded if isinstance(loaded, dict) else {}


def _write_text_if_changed(path: Path, text: str) -> None:
    """Write ``text`` only when it differs from the current file content.

    Avoids rewriting managed config/.env files on every hot-path prepare when
    nothing actually changed (reduces I/O churn and lock-held work).
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        if path.exists() and path.read_text(encoding="utf-8") == text:
            try:
                path.chmod(0o600)
            except OSError:
                pass
            return
    except OSError:
        pass
    _internal_config._atomic_write_text(path, text)


def _write_yaml_mapping(path: Path, data: dict[str, Any]) -> None:
    try:
        import yaml
    except Exception:
        enabled = data.get("plugins", {}).get("enabled", [HERMES_PLUGIN_KEY])
        lines = ["plugins:", "  enabled:"]
        lines.extend(f"    - {item}" for item in enabled)
        model = data.get("model")
        if isinstance(model, dict) and model:
            lines.extend(["model:"])
            for key in ("default", "provider", "base_url"):
                value = model.get(key)
                if value is not None and str(value) != "":
                    lines.append(f"  {key}: {_quote_yaml_scalar(str(value))}")
        text = "\n".join(lines) + "\n"
    else:
        text = yaml.safe_dump(data, sort_keys=False, allow_unicode=True)
    _write_text_if_changed(path, text)


def _quote_yaml_scalar(value: str) -> str:
    if re.fullmatch(r"[A-Za-z0-9_.:/-]+", value):
        return value
    return json.dumps(value, ensure_ascii=False)


def _read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        values[key.strip()] = _unquote_env(value.strip())
    return values


def _write_env_file(path: Path, values: dict[str, str]) -> None:
    # Managed runtime .env files hold API_SERVER_KEY, the agent tool token and
    # provider URLs, so they are written 0600 like auth.json rather than with
    # the default umask.
    lines = [f"{key}={_quote_env(value)}" for key, value in sorted(values.items())]
    text = "\n".join(lines) + "\n"
    try:
        if path.exists() and path.read_text(encoding="utf-8") == text:
            return
    except OSError:
        pass
    _write_text_secure(path, text)


def _quote_env(value: str) -> str:
    safe = value.replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')
    return f'"{safe}"'


def _unquote_env(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] == '"':
        return value[1:-1].replace("\\n", "\n").replace('\\"', '"').replace("\\\\", "\\")
    return value
