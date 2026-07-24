from __future__ import annotations

import hashlib
import ipaddress
import json
import math
import os
import platform
import re
import secrets
import signal
import shlex
import shutil
import stat
import subprocess
import sys
import sysconfig
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from contextlib import contextmanager, nullcontext
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path
from typing import Any, Protocol

try:
    import fcntl
except ImportError:  # pragma: no cover - managed Camoufox currently targets Linux.
    fcntl = None

from .config import PlatformConfig
from .db import now_ts
from .design_contract_generated import (
    RUN_IDLE_TIMEOUT_MAXIMUM_SECONDS,
    RUN_IDLE_TIMEOUT_MINIMUM_SECONDS,
    RUN_IDLE_TIMEOUT_RUNTIME_ENVIRONMENT_VARIABLE,
)
from .loopback_http import (
    open_loopback_url,
    open_private_service_url,
    open_trusted_service_url,
    validate_http_base_url,
    validate_loopback_url,
)
from .secure_fs import ensure_private_directory, ensure_private_file
from .upstream_source_validation import (
    UpstreamSourceValidationError,
    parse_compose_service_names,
)
from .upstream_sources_generated import UPSTREAM_SOURCES


AGENT_SETTING_MANAGED = "agent_runtime_manage"
AGENT_SETTING_URL = "agent_runtime_url"
AGENT_SETTING_MODEL = "agent_runtime_model"
AGENT_SETTING_PROVIDER = "agent_runtime_provider"
AGENT_SETTING_IDLE_TIMEOUT = "agent_runtime_idle_timeout_seconds"
AGENT_SETTING_MAX_CONCURRENCY = "agent_runtime_max_concurrency"
AGENT_SETTING_COMPACTION_THRESHOLD = "agent_runtime_compaction_threshold"
AGENT_RUNTIME_INSTALL_MARKER = "install.json"
_SENSITIVE_ENV_NAME_RE = re.compile(
    r"(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL)",
    re.IGNORECASE,
)
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
FIRECRAWL_COMPOSE_OVERRIDE = "docker-compose.ubitech.yaml"
CAMOFOX_MANAGED_VERSION = "1.11.2"
CAMOFOX_JS_VERSION = "0.10.2"
CAMOFOX_PLAYWRIGHT_VERSION = "1.59.1"
CAMOFOX_RUNTIME_INSTALL_MARKER = "install.json"
CAMOFOX_BROWSER_RELEASE = "v150.0.2-beta.25"
CAMOFOX_BROWSER_MAX_ARCHIVE_BYTES = 750 * 1024 * 1024
CAMOFOX_BROWSER_MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024
CAMOFOX_BROWSER_MAX_ARCHIVE_MEMBERS = 50_000
CAMOFOX_BROWSER_MAX_COMPRESSION_RATIO = 1_000
CAMOFOX_BROWSER_DOWNLOAD_DEADLINE_SECONDS = 30 * 60
CAMOFOX_CAPABILITY_REPROBE_AFTER_SECONDS = 30.0
CAMOFOX_CAPABILITY_RETRY_SECONDS = 2.0
RUNTIME_STATUS_CACHE_SECONDS = 10.0
CAMOFOX_BROWSER_ASSETS = {
    ("Linux", "x86_64"): (
        "camoufox-150.0.2-alpha.26-lin.x86_64.zip",
        "b146b98b0c2c41023716feef36451f319a534309f72c54584a4b0b88670f510b",
        661_687_098,
        "150.0.2",
        "beta.25",
    ),
    ("Linux", "aarch64"): (
        "camoufox-150.0.2-alpha.25-lin.arm64.zip",
        "b2870af8cd99721d41bd48f0cce0f949449ab75364b80ee3d389bd35953ea213",
        652_036_669,
        "150.0.2",
        "beta.25",
    ),
}
FIRECRAWL_IMAGE = "ghcr.io/firecrawl/firecrawl@sha256:c2e8fc46fbc9dba57463b4b4f5c23fffe2aaf578a7691c5aaaf2cae58a01f80c"
FIRECRAWL_PLAYWRIGHT_IMAGE = "ghcr.io/firecrawl/playwright-service@sha256:6359b0d9070f27400b4a9b615509be06919e40121fc1fdc42d4efeddf02653d2"
FIRECRAWL_POSTGRES_IMAGE = "ghcr.io/firecrawl/nuq-postgres@sha256:aed86f62858f29bd971abddcdeb301c12888098d2cf5d33c1ba42b053bc460f6"
# Manifest-list digests corresponding to the upstream redis:alpine,
# rabbitmq:3-management, and foundationdb/foundationdb:7.3.63 references.
FIRECRAWL_REDIS_IMAGE = "redis@sha256:9d317178eceac8454a2284a9e6df2466b93c745529947f0cd42a0fa9609d7005"
FIRECRAWL_RABBITMQ_IMAGE = "rabbitmq@sha256:e582c0bc7766f3342496d8485efb5a1df782b5ce3886ad017e2eaae442311f69"
FIRECRAWL_FOUNDATIONDB_IMAGE = "foundationdb/foundationdb@sha256:df1a2310c6dbe0d56def526b73606cc8fd414ecc42c50fba2588f13292f82d48"
# SearXNG 2026.7.19-6da6eee26 multi-architecture manifest (amd64, arm64,
# arm/v7). Keep the platform-owned search runtime immutable, matching the
# digest-pinning policy used by other managed container runtimes.
SEARXNG_IMAGE = "ghcr.io/searxng/searxng@sha256:b8ca38ba06eea544d7555e88321e212ddc0d5c3c7de055419cfb2e5c6bf30812"
SEARXNG_COMPOSE_FILE = "docker-compose.ubitech.yaml"
SEARXNG_LOOPBACK_PUBLISH = "127.0.0.1:13003"
SEARXNG_LOOPBACK_URL = "http://127.0.0.1:13003"
SEARXNG_COMPOSE_WAIT_MIN_SECONDS = 120
SEARXNG_COMPOSE_CAPABILITY_CACHE_SECONDS = 30.0
SEARXNG_COMPOSE_CAPABILITY_TIMEOUT_SECONDS = 15.0
FIRECRAWL_SERVICE_IMAGES = (
    ("api", FIRECRAWL_IMAGE),
    ("playwright-service", FIRECRAWL_PLAYWRIGHT_IMAGE),
    ("nuq-postgres", FIRECRAWL_POSTGRES_IMAGE),
    ("redis", FIRECRAWL_REDIS_IMAGE),
    ("rabbitmq", FIRECRAWL_RABBITMQ_IMAGE),
    ("foundationdb", FIRECRAWL_FOUNDATIONDB_IMAGE),
    ("foundationdb-init", FIRECRAWL_FOUNDATIONDB_IMAGE),
)
FIRECRAWL_COMPOSE_PROJECT = "firecrawl"
FIRECRAWL_COMPOSE_WAIT_MIN_SECONDS = 120


def invalidates_runtime_status_cache(method):
    """Keep lifecycle mutations from publishing transition snapshots as fresh."""

    @wraps(method)
    def wrapped(self, *args, **kwargs):
        self.invalidate_status_cache()
        try:
            return method(self, *args, **kwargs)
        finally:
            self.invalidate_status_cache()

    return wrapped


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
        }


@dataclass(frozen=True)
class _SearXNGStateSnapshot:
    generation: int
    pid: int | None
    process_running: bool
    returncode: int | None
    launch_confirmed: bool
    teardown_owned: bool
    last_error: str
    last_started_at: int | None


@dataclass(frozen=True)
class _FirecrawlStateSnapshot:
    generation: int
    pid: int | None
    process_running: bool
    returncode: int | None
    launch_confirmed: bool
    teardown_owned: bool
    last_error: str
    last_started_at: int | None


class PlatformRuntimeManager:
    """Prepare and supervise the runtimes owned by the platform."""

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
        self._searxng_state_lock = threading.RLock()
        self._searxng_state_generation = 0
        self._searxng_compose_capability_lock = threading.Lock()
        self._searxng_compose_capability_checked_at = 0.0
        self._searxng_compose_capability_error = ""
        self._firecrawl_state_lock = threading.RLock()
        self._firecrawl_state_generation = 0
        self._agent_process: ProcessLike | None = None
        self._camofox_process: ProcessLike | None = None
        self._searxng_process: ProcessLike | None = None
        self._firecrawl_process: ProcessLike | None = None
        self._searxng_compose_teardown: tuple[list[str], Path | None] | None = None
        self._searxng_launch_confirmed = False
        self._firecrawl_launch_confirmed = False
        # When Firecrawl was launched via the managed `docker compose up` stack,
        # remember the (compose argv, cwd) needed to tear it down so stop/close
        # can run `docker compose down` instead of orphaning the containers.
        self._firecrawl_compose_teardown: tuple[list[str], Path | None] | None = None
        self._agent_last_started_at: int | None = None
        self._camofox_last_started_at: int | None = None
        self._searxng_last_started_at: int | None = None
        self._firecrawl_last_started_at: int | None = None
        self._agent_last_error = ""
        self._cognee_last_error = ""
        self._camofox_last_error = ""
        self._searxng_last_error = ""
        self._firecrawl_last_error = ""
        self._camofox_capability_verified = False
        self._camofox_capability_verified_at = 0.0
        self._camofox_capability_next_probe_at = 0.0
        self._camofox_capability_probe_lock = threading.Lock()
        self._camofox_process_generation = 0
        self._status_cache_lock = threading.Lock()
        self._status_cache: dict[str, Any] | None = None
        self._status_cache_checked_at = 0.0
        self._status_cache_generation = 0
        self._status_refresh_thread: threading.Thread | None = None
        self._searxng_status_cache_lock = threading.Lock()
        self._searxng_status_cache: dict[str, Any] | None = None
        self._searxng_status_cache_checked_at = 0.0
        self._searxng_status_cache_generation = 0
        self._searxng_status_refresh_thread: threading.Thread | None = None
        self._closed = False

    def prepare(self) -> dict[str, Any]:
        with self._lock:
            agent = self.prepare_agent_runtime()
            cognee = self.prepare_cognee()
            camofox = self.prepare_camofox()
            searxng = self.prepare_searxng()
            firecrawl = self.prepare_firecrawl()
            return {
                "agent": agent.to_dict(),
                "cognee": cognee.to_dict(),
                "camofox": camofox.to_dict(),
                "searxng": searxng.to_dict(),
                "firecrawl": firecrawl.to_dict(),
            }

    def status(self, *, refresh: bool = True) -> dict[str, Any]:
        if refresh:
            # These probes target independent loopback services. Running them
            # concurrently keeps one unhealthy optional runtime from adding its
            # timeout to every other runtime, and none of the network I/O holds
            # the broad lifecycle lock used by start/stop operations.
            with ThreadPoolExecutor(max_workers=4, thread_name_prefix="runtime-health") as executor:
                agent_future = executor.submit(self.agent_runtime_status, refresh=True)
                camofox_future = executor.submit(self.camofox_status, refresh=True)
                searxng_future = executor.submit(self.searxng_status, refresh=True)
                firecrawl_future = executor.submit(self.firecrawl_status, refresh=True)
                agent = agent_future.result()
                camofox = camofox_future.result()
                searxng = searxng_future.result()
                firecrawl = firecrawl_future.result()
        else:
            agent = self.agent_runtime_status(refresh=False)
            camofox = self.camofox_status(refresh=False)
            searxng = self.searxng_status(refresh=False)
            firecrawl = self.firecrawl_status(refresh=False)
        cognee = self.cognee_status()
        return {
            "agent": agent.to_dict(),
            "cognee": cognee.to_dict(),
            "camofox": camofox.to_dict(),
            "searxng": searxng.to_dict(),
            "firecrawl": firecrawl.to_dict(),
        }

    def cached_status(self, *, max_age_seconds: float = RUNTIME_STATUS_CACHE_SECONDS) -> dict[str, Any]:
        """Return a non-blocking status snapshot and refresh it in one background thread."""

        now = time.time()
        with self._status_cache_lock:
            if self._status_cache is None:
                # The no-I/O snapshot is cheap, but it still needs to be
                # materialized under the cache lock. Otherwise a burst of
                # first requests can all observe ``None`` and independently
                # rebuild the same initial snapshot before the background
                # health refresh has a chance to commit.
                self._status_cache = deepcopy(self.status(refresh=False))
            snapshot = deepcopy(self._status_cache)
            checked_at = self._status_cache_checked_at
            stale = checked_at <= 0 or now - checked_at >= max(
                0.0, float(max_age_seconds)
            )
            refresh_running = self._status_refresh_thread is not None
        if stale and not refresh_running:
            self.refresh_status_async()
        return {
            **snapshot,
            "checked_at": int(checked_at) if checked_at > 0 else None,
            "stale": stale,
        }

    def refresh_status_async(self) -> None:
        """Start a single-flight health refresh without delaying an HTTP request."""

        with self._status_cache_lock:
            if self._closed or self._status_refresh_thread is not None:
                return
            generation = self._status_cache_generation
            thread = threading.Thread(
                target=self._refresh_status_cache,
                args=(generation,),
                name="runtime-status-refresh",
                daemon=True,
            )
            self._status_refresh_thread = thread
            thread.start()

    def cached_searxng_status(
        self,
        *,
        max_age_seconds: float = 1.0,
    ) -> dict[str, Any]:
        """Return a low-cost SearXNG-only snapshot with single-flight refresh."""

        now = time.time()
        with self._searxng_status_cache_lock:
            if self._searxng_status_cache is None:
                self._searxng_status_cache = (
                    self.searxng_status(refresh=False).to_dict()
                )
            snapshot = deepcopy(self._searxng_status_cache)
            checked_at = self._searxng_status_cache_checked_at
            stale = checked_at <= 0 or now - checked_at >= max(
                0.0, float(max_age_seconds)
            )
            refresh_running = self._searxng_status_refresh_thread is not None
        if stale and not refresh_running:
            self._refresh_searxng_status_async()
        return {
            **snapshot,
            "checked_at": int(checked_at) if checked_at > 0 else None,
            "stale": stale,
        }

    def _refresh_searxng_status_async(self) -> None:
        with self._searxng_status_cache_lock:
            if self._closed or self._searxng_status_refresh_thread is not None:
                return
            generation = self._searxng_status_cache_generation
            thread = threading.Thread(
                target=self._refresh_searxng_status_cache,
                args=(generation,),
                name="searxng-status-refresh",
                daemon=True,
            )
            self._searxng_status_refresh_thread = thread
            thread.start()

    def _refresh_searxng_status_cache(self, generation: int) -> None:
        try:
            snapshot = self.searxng_status(refresh=True).to_dict()
            checked_at = time.time()
            with self._searxng_status_cache_lock:
                if (
                    not self._closed
                    and generation == self._searxng_status_cache_generation
                ):
                    self._searxng_status_cache = deepcopy(snapshot)
                    self._searxng_status_cache_checked_at = checked_at
        except Exception:
            pass
        finally:
            with self._searxng_status_cache_lock:
                if (
                    self._searxng_status_refresh_thread
                    is threading.current_thread()
                ):
                    self._searxng_status_refresh_thread = None

    def invalidate_status_cache(self) -> None:
        """Mark the current snapshot stale after a runtime lifecycle mutation."""

        with self._status_cache_lock:
            self._status_cache_generation += 1
            self._status_cache_checked_at = 0.0
        with self._searxng_status_cache_lock:
            self._searxng_status_cache_generation += 1
            self._searxng_status_cache_checked_at = 0.0

    def _refresh_status_cache(self, generation: int) -> None:
        try:
            snapshot = self.status(refresh=True)
            checked_at = time.time()
            with self._status_cache_lock:
                if (
                    not self._closed
                    and generation == self._status_cache_generation
                ):
                    self._status_cache = deepcopy(snapshot)
                    self._status_cache_checked_at = checked_at
        except Exception:
            # Individual RuntimeStatus values normally carry probe errors. If a
            # probe unexpectedly raises, preserve the last snapshot and let the
            # next request schedule another single-flight refresh.
            pass
        finally:
            with self._status_cache_lock:
                if self._status_refresh_thread is threading.current_thread():
                    self._status_refresh_thread = None

    def agent_runtime_config(self) -> dict[str, Any]:
        """Return the platform-owned runtime configuration without secrets."""

        return {
            "managed": self._managed_agent_runtime_enabled(),
            "runtime_url": self._effective_agent_runtime_url(),
            "runtime_home": str(self.config.managed_agent_runtime_home),
            "provider": self._runtime_setting(AGENT_SETTING_PROVIDER)
            or self.config.agent_runtime_provider,
            "model": self._runtime_setting(AGENT_SETTING_MODEL)
            or self.config.agent_runtime_model,
            "idle_timeout_seconds": self._effective_agent_idle_timeout_seconds(),
            "max_concurrency": self._effective_agent_max_concurrency(),
            "compaction_threshold": self._effective_compaction_threshold(),
            "source_path": str(self._agent_runtime_source_dir()),
            "app_path": str(self._agent_runtime_app_dir()),
        }

    def prepare_agent_runtime(self) -> RuntimeStatus:
        home = self.config.managed_agent_runtime_home
        ensure_private_directory(home)
        ensure_private_directory(home / "logs")
        ensure_private_directory(home / "sessions")
        ensure_private_directory(home / "memory")
        managed = self._managed_agent_runtime_enabled()
        url_error = (
            self._managed_loopback_url_error(
                "Agent runtime", self._effective_agent_runtime_url()
            )
            if managed
            else self._trusted_http_url_error(
                "Agent runtime", self._effective_agent_runtime_url()
            )
        )
        if url_error:
            self._agent_last_error = url_error
            return RuntimeStatus(
                "agent",
                managed,
                False,
                "invalid_config",
                url=self._effective_agent_runtime_url(),
                path=str(home),
                error=url_error,
            )
        if not managed:
            available = self._probe_agent_health()
            return RuntimeStatus(
                "agent",
                False,
                available,
                "external" if available else "unavailable",
                url=self._effective_agent_runtime_url(),
                path=str(home),
                error="" if available else "external Agent runtime is unavailable",
            )
        source = self._agent_runtime_source_dir()
        app = self._agent_runtime_app_dir()
        entrypoint = app / "dist" / "src" / "server.js"
        available = entrypoint.is_file()
        error = ""
        if not source.joinpath("package.json").is_file():
            error = f"Agent runtime source is missing: {source}"
        elif not available:
            error = "Agent runtime is not built; run deployment preparation"
        return RuntimeStatus(
            "agent",
            True,
            available,
            "prepared" if available else "missing",
            detail="platform-owned Agent runtime" if available else "",
            url=self._effective_agent_runtime_url(),
            path=str(home),
            error=error,
            last_started_at=self._agent_last_started_at,
            source=str(source),
            install_state="ready" if available else "missing",
        )

    @invalidates_runtime_status_cache
    def install_agent_runtime(self, *, force: bool = False) -> RuntimeStatus:
        """Install the locked Node sidecar into the managed data directory."""

        with self._lock:
            source = self._agent_runtime_source_dir()
            if not source.joinpath("package.json").is_file() or not source.joinpath("package-lock.json").is_file():
                return RuntimeStatus(
                    "agent", True, False, "missing", path=str(source),
                    error="Agent runtime package.json/package-lock.json is missing",
                    install_state="missing",
                )
            if shutil.which("node") is None or shutil.which("npm") is None:
                return RuntimeStatus(
                    "agent", True, False, "missing", path=str(source),
                    error="Node.js >=22.19 and npm are required",
                    install_state="missing",
                )
            app = self._agent_runtime_app_dir()
            marker = app / AGENT_RUNTIME_INSTALL_MARKER
            signature = self._agent_runtime_source_signature(source)
            current = _read_json_mapping(marker)
            if not force and current.get("source_signature") == signature and (app / "dist" / "src" / "server.js").is_file():
                return self.prepare_agent_runtime()
            staging = self.config.managed_agent_runtime_home / f"app.staging-{os.getpid()}"
            shutil.rmtree(staging, ignore_errors=True)
            try:
                shutil.copytree(
                    source,
                    staging,
                    ignore=shutil.ignore_patterns("node_modules", "dist", ".cache", "coverage"),
                )
                log_path = self.config.managed_agent_runtime_home / "logs" / "install.log"
                env = _scrubbed_process_env()
                env.setdefault("NPM_CONFIG_FUND", "false")
                env.setdefault("NPM_CONFIG_AUDIT", "false")
                for command in (["npm", "ci"], ["npm", "run", "build"], ["npm", "prune", "--omit=dev"]):
                    result = self.command_runner.run(
                        command,
                        cwd=staging,
                        env=env,
                        log_path=log_path,
                        timeout=900,
                    )
                    if result.returncode != 0:
                        raise RuntimeError(f"{' '.join(command)} exited with {result.returncode}; see {log_path}")
                if not (staging / "dist" / "src" / "server.js").is_file():
                    raise RuntimeError("Agent runtime build did not produce dist/src/server.js")
                _write_json_secure(
                    staging / AGENT_RUNTIME_INSTALL_MARKER,
                    {"source_signature": signature, "installed_at": _iso_now()},
                )
                previous = self.config.managed_agent_runtime_home / "app.previous"
                shutil.rmtree(previous, ignore_errors=True)
                if app.exists():
                    app.rename(previous)
                try:
                    staging.rename(app)
                except Exception:
                    # Keep the last known-good sidecar available if the final
                    # atomic publish step fails (permissions, disk, or an
                    # unexpected filesystem error).
                    if previous.exists() and not app.exists():
                        previous.rename(app)
                    raise
                shutil.rmtree(previous, ignore_errors=True)
            except Exception as exc:
                shutil.rmtree(staging, ignore_errors=True)
                self._agent_last_error = str(exc)
                return RuntimeStatus(
                    "agent", True, False, "error", path=str(app),
                    error=str(exc), install_state="failed",
                )
            self._agent_last_error = ""
            return self.prepare_agent_runtime()

    def ensure_agent_runtime_ready(self, *, wait: bool = True) -> RuntimeStatus:
        started = False
        try:
            with self._lock:
                current = self.agent_runtime_status(refresh=True)
                if current.available or current.state == "invalid_config":
                    return current
                if not self._managed_agent_runtime_enabled():
                    return current
                if self._managed_agent_runtime_enabled() and not (self._agent_runtime_app_dir() / "dist" / "src" / "server.js").is_file():
                    installed = self.install_agent_runtime(force=False)
                    if not installed.available:
                        return installed
                if self._agent_process is None or self._agent_process.poll() is not None:
                    started = True
                    self.invalidate_status_cache()
                    self._start_agent_runtime()
                process = self._agent_process
            if not wait:
                return self.agent_runtime_status(refresh=True)
            deadline = time.monotonic() + max(0.0, self.config.runtime_startup_wait_seconds)
            while time.monotonic() < deadline:
                status = self.agent_runtime_status(refresh=True)
                if status.available:
                    return status
                if process is None or process.poll() is not None:
                    return status
                time.sleep(0.25)
            return self.agent_runtime_status(refresh=True)
        finally:
            if started:
                self.invalidate_status_cache()

    @invalidates_runtime_status_cache
    def restart_agent_runtime(self) -> RuntimeStatus:
        with self._lock:
            self._stop_process("_agent_process")
        return self.ensure_agent_runtime_ready(wait=True)

    @invalidates_runtime_status_cache
    def stop_agent_runtime(self) -> RuntimeStatus:
        with self._lock:
            self._stop_process("_agent_process")
            return self.agent_runtime_status(refresh=False)

    def agent_runtime_status(self, *, refresh: bool = True) -> RuntimeStatus:
        managed = self._managed_agent_runtime_enabled()
        url_error = (
            self._managed_loopback_url_error(
                "Agent runtime", self._effective_agent_runtime_url()
            )
            if managed
            else self._trusted_http_url_error(
                "Agent runtime", self._effective_agent_runtime_url()
            )
        )
        if url_error:
            self._agent_last_error = url_error
            return RuntimeStatus(
                "agent",
                managed,
                False,
                "invalid_config",
                url=self._effective_agent_runtime_url(),
                path=str(self.config.managed_agent_runtime_home),
                error=url_error,
                source=str(self._agent_runtime_source_dir()) if managed else "external",
            )
        pid, running, returncode = self._process_state(self._agent_process)
        healthy = self._probe_agent_health() if refresh else running
        if healthy:
            state, available, error = "running", True, ""
        elif running:
            state, available, error = "starting", False, self._agent_last_error
        elif returncode is not None:
            state, available = "stopped", False
            error = self._process_exit_error(
                "Agent runtime", returncode,
                self.config.managed_agent_runtime_home / "logs" / "runtime.log",
            )
        else:
            state, available = ("stopped", False) if managed else ("external", False)
            error = self._agent_last_error
        return RuntimeStatus(
            "agent",
            managed,
            available,
            state,
            detail="platform-owned Agent runtime",
            pid=pid,
            url=self._effective_agent_runtime_url(),
            path=str(self.config.managed_agent_runtime_home),
            error=error,
            last_started_at=self._agent_last_started_at,
            source=str(self._agent_runtime_source_dir()),
            install_state="ready" if (self._agent_runtime_app_dir() / "dist" / "src" / "server.js").is_file() else "missing",
        )

    def _start_agent_runtime(self) -> None:
        url_error = self._managed_loopback_url_error(
            "Agent runtime", self._effective_agent_runtime_url()
        )
        if url_error:
            self._agent_last_error = url_error
            return
        app = self._agent_runtime_app_dir()
        entrypoint = app / "dist" / "src" / "server.js"
        if not entrypoint.is_file():
            self._agent_last_error = f"Agent runtime entrypoint is missing: {entrypoint}"
            return
        command = [shutil.which("node") or "node", str(entrypoint)]
        try:
            self._agent_process = self.process_launcher.start(
                command,
                cwd=app,
                env=self._agent_runtime_process_env(),
                log_path=self.config.managed_agent_runtime_home / "logs" / "runtime.log",
            )
            self._agent_last_started_at = int(time.time())
            self._agent_last_error = ""
        except Exception as exc:
            self._agent_process = None
            self._agent_last_error = str(exc)

    def _agent_runtime_process_env(self) -> dict[str, str]:
        env = _scrubbed_process_env()
        parsed = urllib.parse.urlparse(self._effective_agent_runtime_url())
        token = self._agent_runtime_token()
        env.update(
            {
                "AGENT_RUNTIME_HOME": str(self.config.managed_agent_runtime_home),
                "AGENT_RUNTIME_HOST": parsed.hostname or "127.0.0.1",
                "AGENT_RUNTIME_PORT": str(parsed.port or 8766),
                "AGENT_RUNTIME_TOKEN": token,
                "AGENT_PLATFORM_INTERNAL_URL": self._platform_internal_url(),
                "AGENT_PLATFORM_INTERNAL_TOKEN": self._first_secret("agent_tool_token", "ENTERPRISE_AGENT_TOOL_TOKEN"),
                "AGENT_RUNTIME_MAX_CONCURRENCY": str(self._effective_agent_max_concurrency()),
                "AGENT_RUNTIME_EXECUTOR_MODE": "local",
                RUN_IDLE_TIMEOUT_RUNTIME_ENVIRONMENT_VARIABLE: str(
                    round(self._effective_agent_idle_timeout_seconds() * 1000)
                ),
                "AGENT_RUNTIME_COMPACTION_THRESHOLD": str(self._effective_compaction_threshold()),
                "CAMOFOX_URL": self._effective_camofox_url(),
                "FIRECRAWL_API_URL": self._effective_firecrawl_api_url(),
            }
        )
        return {key: value for key, value in env.items() if value is not None}

    def _probe_agent_health(self) -> bool:
        try:
            request = urllib.request.Request(
                self._effective_agent_runtime_url().rstrip("/") + "/health",
                headers={"Authorization": f"Bearer {self._agent_runtime_token()}"},
            )
            open_request = (
                open_loopback_url
                if self._uses_loopback_transport(
                    self._effective_agent_runtime_url()
                )
                else open_trusted_service_url
            )
            with open_request(request, timeout=1.0) as response:
                return 200 <= response.status < 300
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            return False

    def _managed_agent_runtime_enabled(self) -> bool:
        value = self._runtime_setting(AGENT_SETTING_MANAGED)
        return self.config.manage_agent_runtime if value is None else value.strip().lower() in {"1", "true", "yes", "on"}

    def _effective_agent_runtime_url(self) -> str:
        return (self._runtime_setting(AGENT_SETTING_URL) or self.config.agent_runtime_url).strip().rstrip("/")

    def _effective_agent_idle_timeout_seconds(self) -> float:
        raw = self._runtime_setting(AGENT_SETTING_IDLE_TIMEOUT)
        try:
            value = (
                float(raw)
                if raw is not None
                else self.config.agent_runtime_idle_timeout_seconds
            )
            if not math.isfinite(value):
                raise ValueError
            return max(
                float(RUN_IDLE_TIMEOUT_MINIMUM_SECONDS),
                min(float(RUN_IDLE_TIMEOUT_MAXIMUM_SECONDS), value),
            )
        except (TypeError, ValueError):
            return self.config.agent_runtime_idle_timeout_seconds

    def _effective_agent_max_concurrency(self) -> int:
        raw = self._runtime_setting(AGENT_SETTING_MAX_CONCURRENCY)
        try:
            return max(1, min(64, int(raw or "8")))
        except ValueError:
            return 8

    def _effective_compaction_threshold(self) -> float:
        raw = self._runtime_setting(AGENT_SETTING_COMPACTION_THRESHOLD)
        try:
            return max(0.5, min(0.95, float(raw or "0.8")))
        except ValueError:
            return 0.8

    def _agent_runtime_token(self) -> str:
        return self.config.agent_runtime_token or self._first_secret(
            "agent_runtime_token", "ENTERPRISE_AGENT_RUNTIME_TOKEN"
        )

    def _agent_runtime_source_dir(self) -> Path:
        candidates = (
            # Repository and editable-install layout.
            Path(__file__).resolve().parents[1] / "agent-runtime",
            # Wheel installs place the Node source under the interpreter's
            # scheme data directory (normally ``sys.prefix/share``).
            Path(sysconfig.get_path("data"))
            / "share"
            / "ubitech-agent"
            / "agent-runtime",
        )
        for candidate in candidates:
            if (
                candidate.joinpath("package.json").is_file()
                and candidate.joinpath("package-lock.json").is_file()
                and candidate.joinpath("tsconfig.json").is_file()
                and candidate.joinpath("src").is_dir()
            ):
                return candidate
        # Preserve the repository-shaped path in diagnostics when neither
        # candidate is complete; prepare/install will report the missing files.
        return candidates[0]

    def _agent_runtime_app_dir(self) -> Path:
        return self.config.managed_agent_runtime_home / "app"

    @staticmethod
    def _agent_runtime_source_signature(source: Path) -> str:
        digest = hashlib.sha256()
        for path in sorted(source.rglob("*")):
            if not path.is_file() or any(part in {"node_modules", "dist", "coverage", ".cache"} for part in path.parts):
                continue
            digest.update(str(path.relative_to(source)).encode("utf-8"))
            digest.update(path.read_bytes())
        return digest.hexdigest()

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
        if self.config.deployment_mode == "container":
            try:
                self._seed_cognee_env()
                available = _module_importable("cognee")
                return RuntimeStatus(
                    "cognee",
                    True,
                    available,
                    "prepared" if available else "missing",
                    "Cognee is installed in the Platform image" if available else "",
                    path=str(self.config.cognee_runtime_dir),
                    error="" if available else "Cognee package is missing from the Platform image",
                    source="image",
                )
            except Exception as exc:
                return RuntimeStatus(
                    "cognee", True, False, "error",
                    path=str(self.config.cognee_runtime_dir), error=str(exc), source="image"
                )
        if not self._managed_cognee_enabled():
            return RuntimeStatus("cognee", False, False, "external", "managed Cognee disabled")
        try:
            self._seed_cognee_env()
            repo = self._effective_cognee_repo()
            available = repo.exists() and _module_importable("cognee")
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
        if self.config.deployment_mode == "container":
            available = _module_importable("cognee")
            return RuntimeStatus(
                "cognee", True, available,
                "prepared" if available else "missing",
                "Cognee is installed in the Platform image" if available else "",
                path=str(self.config.cognee_runtime_dir),
                error="" if available else "Cognee package is missing from the Platform image",
                source="image",
            )
        if not self._managed_cognee_enabled():
            return RuntimeStatus("cognee", False, False, "external", "managed Cognee disabled")
        repo = self._effective_cognee_repo()
        available = repo.exists() and _module_importable("cognee")
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
            if self.config.deployment_mode == "container":
                return self.camofox_status(refresh=True)
            return RuntimeStatus(
                "camofox",
                False,
                False,
                "external",
                "Camoufox browser capability is disabled; external mode is unsupported",
            )
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
        if not self._effective_camofox_command():
            source = self._camofox_source_dir()
            if not source.joinpath("package.json").is_file() or not source.joinpath("package-lock.json").is_file():
                available = False
                detail = f"Camofox runtime source is missing: {source}"
            elif not self._camofox_install_is_current(source):
                available = False
                detail = "Camofox runtime is not installed from the current lockfile"
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
            install_state="ready" if available else "missing",
        )

    @invalidates_runtime_status_cache
    def install_camofox(self, *, force: bool = False) -> RuntimeStatus:
        """Install the fully locked Camoufox service and browser cache."""

        with self._lock:
            if not self._managed_camofox_enabled():
                # An external/disabled browser is an explicit operator choice.
                # Deployment must neither download the ~GiB managed bundle nor
                # turn that choice into an update failure.
                return self.prepare_camofox()
            runtime_dir = self.config.runtime_dir / "camofox"
            for directory in (runtime_dir, runtime_dir / "logs", runtime_dir / "cache"):
                ensure_private_directory(directory)
            if self._effective_camofox_command():
                return self.prepare_camofox()
            source = self._camofox_source_dir()
            required = (
                "package.json",
                "package-lock.json",
                "loopback-preload.cjs",
                "patch-runtime.cjs",
            )
            if any(not source.joinpath(name).is_file() for name in required):
                return RuntimeStatus(
                    "camofox",
                    True,
                    False,
                    "missing",
                    path=str(source),
                    error="Camofox runtime package.json/package-lock.json/preload is missing",
                    install_state="missing",
                )
            if shutil.which("node") is None or shutil.which("npm") is None:
                return RuntimeStatus(
                    "camofox",
                    True,
                    False,
                    "missing",
                    path=str(source),
                    error="Node.js >=22.19 and npm are required",
                    install_state="missing",
                )
            app = self._camofox_app_dir()
            staging: Path | None = None
            try:
                # The deployment preparer and the still-running platform are
                # separate processes during an update. Serialize only the
                # install/publish transaction; health probes never take this
                # file lock.
                with self._camofox_install_lock():
                    if not force and self._camofox_install_is_current(source):
                        return self.prepare_camofox()
                    signature = self._agent_runtime_source_signature(source)
                    staging = runtime_dir / f"app.staging-{uuid.uuid4().hex}"
                    shutil.copytree(
                        source,
                        staging,
                        ignore=shutil.ignore_patterns("node_modules", ".cache", "coverage"),
                    )
                    log_path = runtime_dir / "logs" / "install.log"
                    env = _scrubbed_process_env()
                    env.update(
                        {
                            "NPM_CONFIG_FUND": "false",
                            "NPM_CONFIG_AUDIT": "false",
                            # Isolate both the downloaded Camoufox binary and its
                            # version marker from unrelated host-level npm tools.
                            "XDG_CACHE_HOME": str(runtime_dir / "cache"),
                            "CAMOFOX_CRASH_REPORT_ENABLED": "false",
                            "CAMOFOX_SKIP_DOWNLOAD": "1",
                        }
                    )
                    commands = (
                        ["npm", "ci", "--omit=dev"],
                        [shutil.which("node") or "node", "patch-runtime.cjs"],
                    )
                    for command in commands:
                        result = self.command_runner.run(
                            command,
                            cwd=staging,
                            env=env,
                            log_path=log_path,
                            timeout=900,
                        )
                        if result.returncode != 0:
                            raise RuntimeError(
                                f"{' '.join(command)} exited with {result.returncode}; see {log_path}"
                            )
                    self._validate_camofox_install(staging)
                    self._install_camofox_browser(force=False, install_lock_held=True)
                    _write_json_secure(
                        staging / CAMOFOX_RUNTIME_INSTALL_MARKER,
                        {
                            "source_signature": signature,
                            "installed_at": _iso_now(),
                            "camofox_browser": CAMOFOX_MANAGED_VERSION,
                            "camoufox_js": CAMOFOX_JS_VERSION,
                            "playwright_core": CAMOFOX_PLAYWRIGHT_VERSION,
                        },
                    )
                    previous = runtime_dir / "app.previous"
                    shutil.rmtree(previous, ignore_errors=True)
                    if app.exists():
                        app.rename(previous)
                    try:
                        staging.rename(app)
                    except Exception:
                        if previous.exists() and not app.exists():
                            previous.rename(app)
                        raise
                    shutil.rmtree(previous, ignore_errors=True)
                    staging = None
            except Exception as exc:
                if staging is not None:
                    shutil.rmtree(staging, ignore_errors=True)
                self._camofox_last_error = str(exc)
                return RuntimeStatus(
                    "camofox",
                    True,
                    False,
                    "error",
                    path=str(app),
                    error=str(exc),
                    install_state="failed",
                )
            self._camofox_last_error = ""
            return self.prepare_camofox()

    def ensure_camofox_ready(self, *, wait: bool = True) -> RuntimeStatus:
        started = False
        try:
            with self._lock:
                if not self._managed_camofox_enabled():
                    return self.camofox_status(
                        refresh=self.config.deployment_mode == "container"
                    )
                # During auto-update the live process still serves requests while a
                # separate deployment process publishes the next locked app. Keep
                # using that known-owned healthy process instead of making the old
                # service contend for the installer lock after git fast-forwards.
                if self._camofox_process is not None and self._camofox_process.poll() is None:
                    current = self.camofox_status(refresh=True)
                    if current.available:
                        return current
                prepared = self.prepare_camofox()
                if (
                    not prepared.available
                    and not self._effective_camofox_command()
                    and prepared.state != "invalid_config"
                ):
                    prepared = self.install_camofox(force=False)
                if not prepared.available:
                    return prepared
                current = self.camofox_status(refresh=True)
                if current.available:
                    return current
                if self._camofox_process is None or self._camofox_process.poll() is not None:
                    started = True
                    self.invalidate_status_cache()
                    self._start_camofox()
                started_process = self._camofox_process
                should_wait = wait
            # Release the broad lock before the (now much larger) cold-start wait so
            # status polls, other runtime startup paths, and shutdown stay
            # responsive while the browser package downloads.
            if should_wait:
                return self._wait_for_runtime("camofox", started_process)
            return self.camofox_status(refresh=True)
        finally:
            if started:
                self.invalidate_status_cache()

    @invalidates_runtime_status_cache
    def restart_camofox(self) -> RuntimeStatus:
        with self._lock:
            self.stop_camofox()
        # ensure_camofox_ready manages the lock itself and releases it across the
        # cold-start wait, so do not hold the broad lock around it here.
        return self.ensure_camofox_ready(wait=True)

    @invalidates_runtime_status_cache
    def stop_camofox(self) -> RuntimeStatus:
        with self._lock:
            self._reset_camofox_capability_state()
            self._stop_process("_camofox_process")
            return self.camofox_status(refresh=False)

    def camofox_status(self, *, refresh: bool = True) -> RuntimeStatus:
        if not self._managed_camofox_enabled():
            if self.config.deployment_mode == "container":
                url_error = self._trusted_http_url_error(
                    "Camofox", self._effective_camofox_url()
                )
                healthy = not url_error and self._probe_camofox_health() if refresh else False
                return RuntimeStatus(
                    "camofox",
                    False,
                    healthy,
                    "running" if healthy else ("invalid_config" if url_error else "external"),
                    "Manager-owned Camoufox API is reachable" if healthy else "Manager owns the Camoufox container",
                    url=self._effective_camofox_url(),
                    path=str(self.config.runtime_dir / "camofox"),
                    error=url_error or ("Manager-owned Camoufox API is not reachable" if refresh and not healthy else ""),
                    source="container",
                )
            return RuntimeStatus(
                "camofox",
                False,
                False,
                "external",
                "Camoufox browser capability is disabled; external mode is unsupported",
            )
        runtime_dir = self.config.runtime_dir / "camofox"
        url_error = self._managed_loopback_url_error(
            "Camoufox", self._effective_camofox_url()
        )
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
                source=self._camofox_source_label(),
            )
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
                install_state="ready",
            )
        if process_running:
            return RuntimeStatus(
                "camofox",
                True,
                False,
                "starting",
                "Camofox process is running; browser capability check is not ready yet",
                pid=pid,
                url=self._effective_camofox_url(),
                path=str(runtime_dir),
                error=self._camofox_last_error,
                last_started_at=self._camofox_last_started_at,
                source=self._camofox_source_label(),
                install_state="ready",
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

    def prepare_searxng(self) -> RuntimeStatus:
        runtime_dir = self._searxng_runtime_dir()
        if not self._managed_searxng_enabled():
            return self.searxng_status(refresh=True)
        ensure_private_directory(runtime_dir)
        ensure_private_directory(runtime_dir / "logs")
        ensure_private_directory(runtime_dir / "config")
        ensure_private_directory(runtime_dir / "cache")
        url_error = self._searxng_loopback_url_error()
        if url_error:
            self._set_searxng_last_error(url_error)
            return RuntimeStatus(
                "searxng",
                True,
                False,
                "invalid_config",
                path=str(runtime_dir),
                url=self._effective_searxng_api_url(),
                error=url_error,
                source=SEARXNG_IMAGE,
            )
        self._ensure_searxng_config()
        capability_error = self._searxng_compose_wait_support_error()
        if capability_error:
            self._set_searxng_last_error(capability_error)
            return RuntimeStatus(
                "searxng",
                True,
                False,
                "missing",
                path=str(runtime_dir),
                url=self._effective_searxng_api_url(),
                error=capability_error,
                source=SEARXNG_IMAGE,
                install_state="missing",
            )
        command, cwd, detail = self._searxng_command()
        available = bool(command)
        self._set_searxng_last_error("" if available else detail)
        with self._searxng_state_lock:
            last_started_at = self._searxng_last_started_at
        return RuntimeStatus(
            "searxng",
            True,
            available,
            "prepared" if available else "missing",
            detail=detail if available else "",
            path=str(cwd or runtime_dir),
            url=self._effective_searxng_api_url(),
            error="" if available else detail,
            last_started_at=last_started_at,
            source=SEARXNG_IMAGE,
            install_state="ready" if available else "missing",
        )

    def ensure_searxng_ready(self, *, wait: bool = True) -> RuntimeStatus:
        started = False
        try:
            if not self._managed_searxng_enabled():
                return self.searxng_status(refresh=True)
            with self._lock:
                prepared = self.prepare_searxng()
                if not prepared.available:
                    return prepared
            current = self.searxng_status(refresh=True)
            if current.available:
                return current
            with self._lock:
                with self._searxng_state_lock:
                    process = self._searxng_process
                    tracked_process_running = (
                        process is not None and process.poll() is None
                    )
                    launch_confirmed = self._searxng_launch_confirmed
                if not tracked_process_running and not launch_confirmed:
                    # Containers using restart: unless-stopped can outlive an
                    # unclean platform restart. Re-run Compose even when the
                    # endpoint is already healthy so pinned configuration is
                    # reconciled and this manager regains teardown ownership.
                    started = True
                    self.invalidate_status_cache()
                    self._start_searxng()
                with self._searxng_state_lock:
                    started_process = self._searxng_process
                should_wait = wait
            if should_wait:
                return self._wait_for_runtime("searxng", started_process)
            return self.searxng_status(refresh=True)
        finally:
            if started:
                self.invalidate_status_cache()

    @invalidates_runtime_status_cache
    def restart_searxng(self) -> RuntimeStatus:
        with self._lock:
            stopped = self.stop_searxng()
            with self._searxng_state_lock:
                teardown_pending = self._searxng_compose_teardown is not None
            if teardown_pending:
                return stopped
        return self.ensure_searxng_ready(wait=True)

    @invalidates_runtime_status_cache
    def stop_searxng(self) -> RuntimeStatus:
        with self._lock:
            # ``compose up --detach --wait`` may still be pulling or waiting.
            # Stop and reap that client before ``compose down``; otherwise the
            # down command can inspect an empty project and return just before
            # the still-running up command creates the service.
            self._stop_searxng_compose_up_process()
            self._teardown_searxng_compose()
            return self.searxng_status(refresh=False)

    def _stop_searxng_compose_up_process(self) -> None:
        with self._searxng_state_lock:
            process = self._searxng_process
            changed = process is not None or self._searxng_launch_confirmed
            self._searxng_process = None
            self._searxng_launch_confirmed = False
            if changed:
                self._searxng_state_generation += 1
        if process is not None:
            self._terminate_process(process, timeout=12)

    def _teardown_searxng_compose(self) -> None:
        with self._searxng_state_lock:
            teardown = self._searxng_compose_teardown
        if teardown is None:
            return
        down_command, cwd = teardown
        log_path = self._searxng_runtime_dir() / "logs" / "managed-searxng.log"
        try:
            result = self.command_runner.run(
                down_command,
                cwd=cwd,
                env=self._searxng_compose_env(),
                log_path=log_path,
                timeout=self._searxng_compose_down_timeout(),
            )
            if result.returncode != 0:
                self._set_searxng_last_error(
                    "SearXNG compose teardown failed with exit code "
                    f"{result.returncode}; see {log_path}"
                )
                return
        except Exception as exc:
            self._set_searxng_last_error(
                f"SearXNG compose teardown failed: {exc}"
            )
            return
        with self._searxng_state_lock:
            if self._searxng_compose_teardown != teardown:
                return
            self._searxng_last_error = ""
            self._searxng_compose_teardown = None
            self._searxng_launch_confirmed = False
            self._searxng_state_generation += 1

    @staticmethod
    def _searxng_compose_down_timeout() -> float:
        raw = os.environ.get("ENTERPRISE_SEARXNG_COMPOSE_DOWN_TIMEOUT_SECONDS")
        if raw:
            try:
                return max(1.0, float(raw))
            except ValueError:
                pass
        return 90.0

    def _searxng_compose_wait_support_error(self) -> str:
        """Return an actionable error when Compose cannot prove service readiness."""

        with self._searxng_compose_capability_lock:
            now = time.monotonic()
            if (
                self._searxng_compose_capability_checked_at > 0
                and now - self._searxng_compose_capability_checked_at
                < SEARXNG_COMPOSE_CAPABILITY_CACHE_SECONDS
            ):
                return self._searxng_compose_capability_error

            log_path = (
                self._searxng_runtime_dir()
                / "logs"
                / "managed-searxng.log"
            )
            command = [
                "docker",
                "compose",
                "up",
                "--detach",
                "--wait",
                "--wait-timeout",
                "1",
                "--help",
            ]
            try:
                result = self.command_runner.run(
                    command,
                    cwd=self._searxng_runtime_dir(),
                    env=self._searxng_compose_env(),
                    log_path=log_path,
                    timeout=SEARXNG_COMPOSE_CAPABILITY_TIMEOUT_SECONDS,
                )
                if result.returncode == 0:
                    error = ""
                else:
                    error = (
                        "Docker Compose with `up --wait` support is required "
                        "for managed SearXNG; update Docker Compose "
                        f"(capability check exited with {result.returncode}; "
                        f"see {log_path})"
                    )
            except Exception as exc:
                error = (
                    "Docker Compose with `up --wait` support is required "
                    f"for managed SearXNG: {exc}"
                )
            self._searxng_compose_capability_checked_at = time.monotonic()
            self._searxng_compose_capability_error = error
            return error

    def _set_searxng_last_error(self, error: str) -> None:
        with self._searxng_state_lock:
            if self._searxng_last_error == error:
                return
            self._searxng_last_error = error
            self._searxng_state_generation += 1

    def searxng_status(self, *, refresh: bool = True) -> RuntimeStatus:
        runtime_dir = self._searxng_runtime_dir()
        managed = self._managed_searxng_enabled()
        url_error = self._searxng_loopback_url_error(managed=managed)
        if url_error:
            self._set_searxng_last_error(url_error)
            return RuntimeStatus(
                "searxng",
                managed,
                False,
                "invalid_config",
                path=str(runtime_dir),
                url=self._effective_searxng_api_url(),
                error=url_error,
                source=SEARXNG_IMAGE if managed else "external",
            )
        if not managed:
            healthy = self._probe_searxng_health() if refresh else False
            error = (
                "External SearXNG search API is not reachable"
                if refresh and not healthy
                else ""
            )
            return RuntimeStatus(
                "searxng",
                False,
                healthy,
                "running" if healthy else "external",
                (
                    "External SearXNG search API is reachable"
                    if healthy
                    else "External SearXNG search API is not managed by the platform"
                ),
                path=str(runtime_dir),
                url=self._effective_searxng_api_url(),
                error=error,
                source="external",
            )

        command, cwd, detail = self._searxng_command()
        snapshot = self._searxng_state_snapshot()
        healthy = False
        if refresh:
            # Health I/O intentionally runs without either the broad lifecycle
            # lock or the SearXNG state lock. Re-snapshot afterwards so a
            # concurrent stop/restart cannot publish readiness from the state
            # that existed before the probe began.
            for _attempt in range(2):
                probed_healthy = self._probe_searxng_health()
                latest = self._searxng_state_snapshot()
                if latest == snapshot:
                    healthy = probed_healthy
                    snapshot = latest
                    break
                snapshot = latest

        return self._searxng_status_from_snapshot(
            snapshot,
            healthy=healthy,
            command=command,
            cwd=cwd,
            detail=detail,
            runtime_dir=runtime_dir,
        )

    def _searxng_state_snapshot(self) -> _SearXNGStateSnapshot:
        with self._searxng_state_lock:
            pid, process_running, returncode = self._process_state(
                self._searxng_process
            )
            if (
                returncode == 0
                and self._searxng_compose_teardown is not None
            ):
                # ``docker compose up --detach --wait`` exits successfully only
                # after the generated project owns a healthy service. Until
                # this point, an unrelated process on the configured port must
                # never satisfy readiness.
                self._searxng_launch_confirmed = True
                self._searxng_process = None
                self._searxng_last_error = ""
                self._searxng_state_generation += 1
                pid = None
                process_running = False
                returncode = None
            return _SearXNGStateSnapshot(
                generation=self._searxng_state_generation,
                pid=pid,
                process_running=process_running,
                returncode=returncode,
                launch_confirmed=self._searxng_launch_confirmed,
                teardown_owned=self._searxng_compose_teardown is not None,
                last_error=self._searxng_last_error,
                last_started_at=self._searxng_last_started_at,
            )

    def _searxng_status_from_snapshot(
        self,
        snapshot: _SearXNGStateSnapshot,
        *,
        healthy: bool,
        command: list[str],
        cwd: Path | None,
        detail: str,
        runtime_dir: Path,
    ) -> RuntimeStatus:
        exited = self._process_exit_error(
            "SearXNG",
            snapshot.returncode,
            runtime_dir / "logs" / "managed-searxng.log",
        )
        ownership_error = exited or (
            snapshot.last_error if not snapshot.process_running else ""
        )
        if healthy and snapshot.launch_confirmed and not ownership_error:
            return RuntimeStatus(
                "searxng",
                True,
                True,
                "running",
                "SearXNG search API is reachable",
                pid=snapshot.pid,
                url=self._effective_searxng_api_url(),
                path=str(cwd or runtime_dir),
                last_started_at=snapshot.last_started_at,
                source=SEARXNG_IMAGE,
                install_state="ready",
            )
        if ownership_error:
            return RuntimeStatus(
                "searxng",
                True,
                False,
                "error",
                ownership_error,
                pid=snapshot.pid,
                url=self._effective_searxng_api_url(),
                path=str(cwd or runtime_dir),
                error=ownership_error,
                last_started_at=snapshot.last_started_at,
                source=SEARXNG_IMAGE,
                install_state="ready" if command else "missing",
            )
        if snapshot.process_running or snapshot.launch_confirmed:
            return RuntimeStatus(
                "searxng",
                True,
                False,
                "starting",
                (
                    "SearXNG Compose project is ready; API health check is not ready yet"
                    if snapshot.launch_confirmed
                    else "SearXNG Compose project is starting"
                ),
                pid=snapshot.pid,
                url=self._effective_searxng_api_url(),
                path=str(cwd or runtime_dir),
                error=snapshot.last_error,
                last_started_at=snapshot.last_started_at,
                source=SEARXNG_IMAGE,
                install_state="ready",
            )
        state = "prepared" if command else "missing"
        runtime_detail = (
            "SearXNG is prepared but not running" if command else detail
        )
        error = snapshot.last_error if command else detail
        return RuntimeStatus(
            "searxng",
            True,
            False,
            state,
            runtime_detail,
            pid=snapshot.pid,
            url=self._effective_searxng_api_url(),
            path=str(cwd or runtime_dir),
            error=error,
            last_started_at=snapshot.last_started_at,
            source=SEARXNG_IMAGE,
            install_state="ready" if command else "missing",
        )

    def prepare_firecrawl(self) -> RuntimeStatus:
        if not self._managed_firecrawl_enabled():
            return self.firecrawl_status(refresh=True)
        ensure_private_directory(self.config.firecrawl_runtime_dir)
        ensure_private_directory(self.config.firecrawl_runtime_dir / "logs")
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
        source_error = self._managed_firecrawl_source_error()
        if source_error:
            self._firecrawl_last_error = source_error
            return RuntimeStatus(
                "firecrawl",
                True,
                False,
                "invalid_source",
                path=str(self._effective_firecrawl_repo()),
                url=self._effective_firecrawl_api_url(),
                error=source_error,
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
        started = False
        try:
            if not self._managed_firecrawl_enabled():
                return self.firecrawl_status(refresh=True)
            with self._lock:
                prepared = self.prepare_firecrawl()
                if not prepared.available:
                    return prepared
                with self._firecrawl_state_lock:
                    process = self._firecrawl_process
                    tracked_process_running = (
                        process is not None and process.poll() is None
                    )
                    launch_confirmed = self._firecrawl_launch_confirmed
                if not tracked_process_running and not launch_confirmed:
                    # A healthy port may belong to containers left by the
                    # previous backend. Re-run the stable Compose project and
                    # wait for it to confirm the current pinned configuration
                    # before accepting endpoint health.
                    started = True
                    self.invalidate_status_cache()
                    self._start_firecrawl()
                with self._firecrawl_state_lock:
                    started_process = self._firecrawl_process
                should_wait = wait
            if should_wait:
                return self._wait_for_runtime("firecrawl", started_process)
            return self.firecrawl_status(refresh=True)
        finally:
            if started:
                self.invalidate_status_cache()

    @invalidates_runtime_status_cache
    def restart_firecrawl(self) -> RuntimeStatus:
        with self._lock:
            stopped = self.stop_firecrawl()
            with self._firecrawl_state_lock:
                teardown_pending = self._firecrawl_compose_teardown is not None
            if teardown_pending:
                return stopped
        return self.ensure_firecrawl_ready(wait=True)

    @invalidates_runtime_status_cache
    def stop_firecrawl(self) -> RuntimeStatus:
        with self._lock:
            self._stop_firecrawl_compose_up_process()
            self._teardown_firecrawl_compose()
            return self.firecrawl_status(refresh=False)

    def _stop_firecrawl_compose_up_process(self) -> None:
        with self._firecrawl_state_lock:
            process = self._firecrawl_process
            changed = process is not None or self._firecrawl_launch_confirmed
            self._firecrawl_process = None
            self._firecrawl_launch_confirmed = False
            if changed:
                self._firecrawl_state_generation += 1
        if process is not None:
            self._terminate_process(process, timeout=12)

    def _teardown_firecrawl_compose(self) -> None:
        """Tear down the managed Firecrawl compose stack before dropping the CLI.

        `docker compose up` is an attached client; the api/playwright/postgres/
        redis/rabbitmq containers are owned by the daemon, not the CLI's process
        group, so killing the CLI orphans them and leaks port 3002 and DB
        volumes. Run `docker compose down --remove-orphans` first so the stack is
        actually stopped and removed.
        """
        with self._firecrawl_state_lock:
            teardown = self._firecrawl_compose_teardown
        if teardown is None:
            return
        down_command, cwd = teardown
        log_path = self.config.firecrawl_runtime_dir / "logs" / "managed-firecrawl.log"
        env = os.environ.copy()
        env["DOCKER_BUILDKIT"] = env.get("DOCKER_BUILDKIT") or "1"
        env["COMPOSE_DOCKER_CLI_BUILD"] = env.get("COMPOSE_DOCKER_CLI_BUILD") or "1"
        try:
            result = self.command_runner.run(
                down_command,
                cwd=cwd,
                env=env,
                log_path=log_path,
                timeout=self._firecrawl_compose_down_timeout(),
            )
            if result.returncode != 0:
                with self._firecrawl_state_lock:
                    self._firecrawl_last_error = (
                        "Firecrawl compose teardown failed with exit code "
                        f"{result.returncode}; see {log_path}"
                    )
                    self._firecrawl_state_generation += 1
                return
        except Exception as exc:
            with self._firecrawl_state_lock:
                self._firecrawl_last_error = f"Firecrawl compose teardown failed: {exc}"
                self._firecrawl_state_generation += 1
            return
        with self._firecrawl_state_lock:
            if self._firecrawl_compose_teardown != teardown:
                return
            self._firecrawl_last_error = ""
            self._firecrawl_compose_teardown = None
            self._firecrawl_launch_confirmed = False
            self._firecrawl_state_generation += 1

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
        managed = self._managed_firecrawl_enabled()
        url_error = (
            self._managed_loopback_url_error(
                "Firecrawl", self._effective_firecrawl_api_url()
            )
            if managed
            else self._trusted_http_url_error(
                "Firecrawl", self._effective_firecrawl_api_url()
            )
        )
        if url_error:
            self._firecrawl_last_error = url_error
            return RuntimeStatus(
                "firecrawl",
                managed,
                False,
                "invalid_config",
                path=str(self.config.firecrawl_runtime_dir),
                url=self._effective_firecrawl_api_url(),
                error=url_error,
                source="" if managed else "external",
            )
        if not managed:
            healthy = self._probe_firecrawl_health() if refresh else False
            return RuntimeStatus(
                "firecrawl",
                False,
                healthy,
                "running" if healthy else "external",
                "External Firecrawl API is reachable" if healthy else "External Firecrawl API is not managed by the platform",
                path=str(self.config.firecrawl_runtime_dir),
                url=self._effective_firecrawl_api_url(),
                error="" if healthy or not refresh else "External Firecrawl API is not reachable",
                source="external",
            )
        command, cwd, detail = self._firecrawl_command()
        snapshot = self._firecrawl_state_snapshot()
        healthy = False
        if refresh:
            for _attempt in range(2):
                probed_healthy = self._probe_firecrawl_health()
                latest = self._firecrawl_state_snapshot()
                if latest == snapshot:
                    healthy = probed_healthy
                    snapshot = latest
                    break
                snapshot = latest
        return self._firecrawl_status_from_snapshot(
            snapshot,
            healthy=healthy,
            command=command,
            cwd=cwd,
            detail=detail,
        )

    def _firecrawl_state_snapshot(self) -> _FirecrawlStateSnapshot:
        with self._firecrawl_state_lock:
            pid, process_running, returncode = self._process_state(
                self._firecrawl_process
            )
            if returncode == 0 and self._firecrawl_compose_teardown is not None:
                # ``compose up --detach --wait`` returns zero only after the
                # stable project has reconciled the current pinned config.
                self._firecrawl_launch_confirmed = True
                self._firecrawl_process = None
                self._firecrawl_last_error = ""
                self._firecrawl_state_generation += 1
                pid = None
                process_running = False
                returncode = None
            return _FirecrawlStateSnapshot(
                generation=self._firecrawl_state_generation,
                pid=pid,
                process_running=process_running,
                returncode=returncode,
                launch_confirmed=self._firecrawl_launch_confirmed,
                teardown_owned=self._firecrawl_compose_teardown is not None,
                last_error=self._firecrawl_last_error,
                last_started_at=self._firecrawl_last_started_at,
            )

    def _firecrawl_status_from_snapshot(
        self,
        snapshot: _FirecrawlStateSnapshot,
        *,
        healthy: bool,
        command: list[str],
        cwd: Path | None,
        detail: str,
    ) -> RuntimeStatus:
        exited = self._process_exit_error(
            "Firecrawl",
            snapshot.returncode,
            self.config.firecrawl_runtime_dir / "logs" / "managed-firecrawl.log",
        )
        ownership_error = exited or (
            snapshot.last_error if not snapshot.process_running else ""
        )
        if healthy and snapshot.launch_confirmed and not ownership_error:
            return RuntimeStatus(
                "firecrawl",
                True,
                True,
                "running",
                "Self-hosted Firecrawl API is reachable and owned by the managed Compose project",
                pid=snapshot.pid,
                url=self._effective_firecrawl_api_url(),
                path=str(cwd or self.config.firecrawl_runtime_dir),
                last_started_at=snapshot.last_started_at,
                source=str(cwd or ""),
            )
        if ownership_error:
            return RuntimeStatus(
                "firecrawl",
                True,
                False,
                "error",
                ownership_error,
                pid=snapshot.pid,
                url=self._effective_firecrawl_api_url(),
                path=str(cwd or self.config.firecrawl_runtime_dir),
                error=ownership_error,
                last_started_at=snapshot.last_started_at,
                source=str(cwd or ""),
            )
        if snapshot.process_running or snapshot.launch_confirmed:
            return RuntimeStatus(
                "firecrawl",
                True,
                False,
                "starting",
                (
                    "Firecrawl Compose project is ready; API health check is not ready yet"
                    if snapshot.launch_confirmed
                    else "Firecrawl Compose project is reconciling pinned images and configuration"
                ),
                pid=snapshot.pid,
                url=self._effective_firecrawl_api_url(),
                path=str(cwd or self.config.firecrawl_runtime_dir),
                last_started_at=snapshot.last_started_at,
                source=str(cwd or ""),
            )
        state = "prepared" if command else "missing"
        runtime_detail = "Firecrawl is prepared but not running" if command else detail
        error = snapshot.last_error if command else detail
        return RuntimeStatus(
            "firecrawl",
            True,
            False,
            state,
            runtime_detail,
            pid=snapshot.pid,
            url=self._effective_firecrawl_api_url(),
            path=str(cwd or self.config.firecrawl_runtime_dir),
            error=error,
            last_started_at=snapshot.last_started_at,
            source=str(cwd or ""),
        )

    def ensure_managed_tooling_ready(self, *, wait: bool = False) -> dict[str, Any]:
        # Each lifecycle method owns its own synchronization. Keeping the
        # broad lock here would accidentally retain it across their health
        # probes and cold-start waits.
        return {
            "camofox": self.ensure_camofox_ready(wait=wait).to_dict(),
            "searxng": self.ensure_searxng_ready(wait=wait).to_dict(),
            "firecrawl": self.ensure_firecrawl_ready(wait=wait).to_dict(),
        }

    def close(self) -> None:
        with self._status_cache_lock:
            self._closed = True
        with self._searxng_status_cache_lock:
            self._closed = True
        self.stop_agent_runtime()
        self.stop_camofox()
        self.stop_firecrawl()
        self.stop_searxng()

    def _start_camofox(self) -> None:
        url_error = self._managed_loopback_url_error(
            "Camoufox", self._effective_camofox_url()
        )
        if url_error:
            self._camofox_last_error = url_error
            return
        command, cwd, detail = self._camofox_command()
        if not command:
            self._camofox_last_error = detail
            return
        env = _scrubbed_process_env()
        env["CAMOFOX_PORT"] = str(urllib.parse.urlparse(self._effective_camofox_url()).port or 9377)
        runtime_dir = self.config.runtime_dir / "camofox"
        access_key = self._camofox_access_key()
        env.update(
            {
                # Upstream accepts CAMOFOX_API_KEY in API clients and
                # CAMOFOX_ACCESS_KEY in the server-wide auth middleware. Use
                # one generated value so every non-health route is protected.
                "CAMOFOX_ACCESS_KEY": access_key,
                "CAMOFOX_API_KEY": access_key,
                "CAMOFOX_ADMIN_KEY": access_key,
                "CAMOFOX_PROFILE_DIR": str(runtime_dir / "profiles"),
                "CAMOFOX_COOKIES_DIR": str(runtime_dir / "cookies"),
                "CAMOFOX_TRACES_DIR": str(runtime_dir / "traces"),
                "CAMOFOX_CRASH_REPORT_ENABLED": "false",
                "NODE_ENV": "production",
                "HOST": "127.0.0.1",
                "CAMOFOX_HOST": "127.0.0.1",
                "UBITECH_CAMOFOX_BIND_HOST": urllib.parse.urlparse(
                    self._effective_camofox_url()
                ).hostname
                or "127.0.0.1",
                "XDG_CACHE_HOME": str(runtime_dir / "cache"),
            }
        )
        if not self._effective_camofox_command():
            # A user-level systemd manager can retain GUI variables long after
            # that login's display has disappeared. Managed Camoufox owns its
            # Xvfb/headless choice, so never let a stale host display make
            # Firefox attempt headed mode against an unrelated X server.
            for key in ("DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"):
                env.pop(key, None)
            browser_executable = self._camofox_browser_executable()
            if browser_executable is None:
                self._camofox_last_error = "managed Camoufox browser executable is missing"
                return
            env["CAMOUFOX_EXECUTABLE_PATH"] = str(browser_executable)
            env["CAMOFOX_EXECUTABLE_PATH"] = str(browser_executable)
        log_path = runtime_dir / "logs" / "managed-camofox.log"
        try:
            self._reset_camofox_capability_state()
            self._camofox_process = self.process_launcher.start(command, cwd=cwd, env=env, log_path=log_path)
            self._camofox_last_started_at = now_ts()
            self._camofox_last_error = ""
        except Exception as exc:
            self._camofox_last_error = str(exc)
            self._camofox_process = None

    def _start_searxng(self) -> None:
        command, cwd, detail = self._searxng_command()
        if not command:
            self._set_searxng_last_error(detail)
            return
        teardown = self._searxng_compose_teardown_command(command, cwd)
        log_path = self._searxng_runtime_dir() / "logs" / "managed-searxng.log"
        try:
            process = self.process_launcher.start(
                command,
                cwd=cwd,
                env=self._searxng_compose_env(),
                log_path=log_path,
            )
            with self._searxng_state_lock:
                self._searxng_process = process
                self._searxng_launch_confirmed = False
                self._searxng_last_started_at = now_ts()
                self._searxng_last_error = ""
                self._searxng_compose_teardown = teardown
                self._searxng_state_generation += 1
        except Exception as exc:
            with self._searxng_state_lock:
                self._searxng_last_error = str(exc)
                self._searxng_process = None
                self._searxng_launch_confirmed = False
                # The deterministic managed project may already exist from an
                # unclean platform restart even when launching the new Compose
                # command fails. Keep its down command so stop/restart can
                # still clean up or retry management of that project.
                self._searxng_compose_teardown = teardown
                self._searxng_state_generation += 1

    def _searxng_compose_env(self) -> dict[str, str]:
        env = _scrubbed_process_env()
        # The generated Compose file contains the validated literal loopback
        # publication. Remove similarly named host variables as defense in
        # depth so neither Compose interpolation nor future image changes can
        # silently replace that boundary.
        for key in (
            "SEARXNG_ENDPOINT",
            "SEARXNG_PORT",
            "SEARXNG_BIND_ADDRESS",
            "UBITECH_SEARXNG_PUBLISH",
        ):
            env.pop(key, None)
        env.update(
            {
                "DOCKER_BUILDKIT": env.get("DOCKER_BUILDKIT") or "1",
                "COMPOSE_DOCKER_CLI_BUILD": env.get("COMPOSE_DOCKER_CLI_BUILD")
                or "1",
                "UBITECH_SEARXNG_PUBLISH": self._searxng_loopback_publish(),
            }
        )
        return env

    @staticmethod
    def _searxng_compose_teardown_command(
        up_command: list[str],
        cwd: Path | None,
    ) -> tuple[list[str], Path | None] | None:
        if up_command[:2] != ["docker", "compose"]:
            return None
        try:
            up_index = up_command.index("up")
        except ValueError:
            return None
        return (
            ["docker", *up_command[1:up_index], "down", "--remove-orphans"],
            cwd,
        )

    def _start_firecrawl(self) -> None:
        url_error = self._managed_loopback_url_error(
            "Firecrawl", self._effective_firecrawl_api_url()
        )
        if url_error:
            self._firecrawl_last_error = url_error
            return
        source_error = self._managed_firecrawl_source_error()
        if source_error:
            self._firecrawl_last_error = source_error
            return
        command, cwd, detail = self._firecrawl_command()
        if not command:
            self._firecrawl_last_error = detail
            return
        # Materialize the managed .env (under the data dir) before launch so the
        # --env-file argv resolves to a real file.
        self._ensure_firecrawl_env()
        env = os.environ.copy()
        teardown = self._firecrawl_compose_teardown_command(command, cwd)
        if teardown is not None:
            # Search is a separate platform runtime. Do not let stale host
            # values reconnect the default managed Firecrawl Compose stack's
            # optional upstream SearXNG integration. Preserve the environment
            # contract of an explicitly configured custom command.
            env.pop("SEARXNG_ENDPOINT", None)
            env.pop("SEARXNG_PORT", None)
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
            process = self.process_launcher.start(
                command,
                cwd=cwd,
                env=env,
                log_path=log_path,
            )
            with self._firecrawl_state_lock:
                self._firecrawl_process = process
                self._firecrawl_launch_confirmed = False
                self._firecrawl_last_started_at = now_ts()
                self._firecrawl_last_error = ""
                self._firecrawl_compose_teardown = teardown
                self._firecrawl_state_generation += 1
        except Exception as exc:
            with self._firecrawl_state_lock:
                self._firecrawl_last_error = str(exc)
                self._firecrawl_process = None
                self._firecrawl_launch_confirmed = False
                # The stable project may exist from an earlier backend even
                # when this launch client fails. Preserve its deterministic
                # down command so stop/restart can still clean it up.
                self._firecrawl_compose_teardown = teardown
                self._firecrawl_state_generation += 1

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

    def _wait_for_runtime(self, name: str, process: ProcessLike | None = None) -> RuntimeStatus:
        # Snapshot the launched process handle so the busy-poll does not need the
        # broad lock held; default to the current handle for direct callers.
        process_attrs = {
            "camofox": "_camofox_process",
            "searxng": "_searxng_process",
            "firecrawl": "_firecrawl_process",
        }
        status_fns = {
            "camofox": self.camofox_status,
            "searxng": self.searxng_status,
            "firecrawl": self.firecrawl_status,
        }
        process_attr = process_attrs[name]
        proc = process if process is not None else getattr(self, process_attr)
        status_fn = status_fns[name]
        deadline = time.monotonic() + self._runtime_startup_wait_seconds(name)
        while time.monotonic() < deadline:
            status = status_fn(refresh=True)
            if status.available:
                return status
            if proc is None:
                return status
            returncode = proc.poll()
            # Compose `up --detach --wait` is a short-lived readiness client.
            # A zero exit confirms the project configuration, while the API
            # can still need a brief warm-up before its HTTP probe succeeds.
            # Only an unsuccessful launcher exit proves that waiting cannot
            # make this startup healthy.
            if returncode is not None and returncode != 0:
                return status
            time.sleep(0.25)
        return status_fn(refresh=True)

    def _first_secret(self, *keys: str) -> str:
        for key in keys:
            value = self.secret_provider(key)
            if value:
                return str(value).strip()
        return ""

    def _camofox_command(self) -> tuple[list[str], Path | None, str]:
        configured = self._effective_camofox_command()
        if configured:
            return (shlex.split(configured), None, configured)
        app = self._camofox_app_dir()
        entrypoint = app / "node_modules" / "@askjo" / "camofox-browser" / "server.js"
        preload = app / "loopback-preload.cjs"
        node = shutil.which("node")
        detail = (
            "locked npm runtime: "
            f"@askjo/camofox-browser@{CAMOFOX_MANAGED_VERSION}, "
            f"camoufox-js@{CAMOFOX_JS_VERSION}, "
            f"playwright-core@{CAMOFOX_PLAYWRIGHT_VERSION}"
        )
        if node is None:
            return ([], app, "Node.js >=22.19 is required for Camofox")
        if not entrypoint.is_file() or not preload.is_file():
            return ([], app, "locked Camofox runtime is not installed; run deployment preparation")
        return (
            [
                node,
                "--require",
                str(preload),
                str(entrypoint),
            ],
            app,
            detail,
        )

    def _camofox_source_dir(self) -> Path:
        candidates = (
            Path(__file__).resolve().parents[1] / "camofox-runtime",
            Path(sysconfig.get_path("data"))
            / "share"
            / "ubitech-agent"
            / "camofox-runtime",
        )
        for candidate in candidates:
            if all(
                candidate.joinpath(name).is_file()
                for name in (
                    "package.json",
                    "package-lock.json",
                    "loopback-preload.cjs",
                    "patch-runtime.cjs",
                )
            ):
                return candidate
        return candidates[0]

    def _camofox_app_dir(self) -> Path:
        return self.config.runtime_dir / "camofox" / "app"

    @contextmanager
    def _camofox_install_lock(self):
        runtime_dir = self.config.runtime_dir / "camofox"
        ensure_private_directory(runtime_dir)
        path = runtime_dir / ".install.lock"
        flags = os.O_RDWR | os.O_CREAT
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(str(path), flags, 0o600)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode):
                raise RuntimeError(f"Camofox install lock is not a regular file: {path}")
            if hasattr(os, "getuid") and info.st_uid != os.getuid():
                raise RuntimeError(f"Camofox install lock is not owned by the service user: {path}")
            os.fchmod(descriptor, 0o600)
            if fcntl is None:
                raise RuntimeError("managed Camofox installation requires POSIX file locking")
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)

    def _camofox_install_is_current(self, source: Path | None = None) -> bool:
        source = source or self._camofox_source_dir()
        app = self._camofox_app_dir()
        marker = _read_json_mapping(app / CAMOFOX_RUNTIME_INSTALL_MARKER)
        if marker.get("source_signature") != self._agent_runtime_source_signature(source):
            return False
        try:
            self._validate_camofox_install(app)
        except RuntimeError:
            return False
        return self._camofox_browser_executable() is not None

    @staticmethod
    def _validate_camofox_install(app: Path) -> None:
        packages = (
            (
                app / "node_modules" / "@askjo" / "camofox-browser" / "package.json",
                CAMOFOX_MANAGED_VERSION,
                "@askjo/camofox-browser",
            ),
            (app / "node_modules" / "camoufox-js" / "package.json", CAMOFOX_JS_VERSION, "camoufox-js"),
            (
                app / "node_modules" / "playwright-core" / "package.json",
                CAMOFOX_PLAYWRIGHT_VERSION,
                "playwright-core",
            ),
        )
        for path, expected, name in packages:
            actual = str(_read_json_mapping(path).get("version") or "")
            if actual != expected:
                raise RuntimeError(f"locked {name} version mismatch: expected {expected}, found {actual or 'missing'}")
        required_files = (
            app / "loopback-preload.cjs",
            app / "patch-runtime.cjs",
            app / "node_modules" / "@askjo" / "camofox-browser" / "server.js",
            app / "node_modules" / "@askjo" / "camofox-browser" / "lib" / "config.js",
            app / "node_modules" / "camoufox-js" / "dist" / "index.js",
            app / "node_modules" / "playwright-core" / "index.js",
        )
        missing = [str(path.relative_to(app)) for path in required_files if not path.is_file()]
        if missing:
            raise RuntimeError("Camofox runtime files are missing: " + ", ".join(missing))
        server = required_files[2].read_text(encoding="utf-8")
        if "reporter.resetNativeMemBaseline?.();" not in server:
            raise RuntimeError("Camofox graceful-shutdown runtime patch is missing")
        if "function sanitizeLogUrl(value)" not in server or "...sanitizeLogFields(fields)" not in server:
            raise RuntimeError("Camofox structured-log URL redaction patch is missing")
        if (
            "Xvfb display readiness timed out" not in server
            or "net.createConnection({ path: socketPath })" not in server
            or "async function stopVirtualDisplay(display)" not in server
            or "await stopVirtualDisplay(displayToClose)" not in server
        ):
            raise RuntimeError("Camofox virtual-display runtime patch is missing")

    def _camofox_browser_asset(self) -> tuple[str, str, int, str, str]:
        machine = platform.machine().lower()
        if machine in {"amd64", "x64"}:
            machine = "x86_64"
        elif machine in {"arm64"}:
            machine = "aarch64"
        asset = CAMOFOX_BROWSER_ASSETS.get((platform.system(), machine))
        if asset is None:
            raise RuntimeError(
                f"managed Camoufox browser is unavailable for {platform.system()} {platform.machine()}"
            )
        return asset

    def _install_camofox_browser(
        self,
        *,
        force: bool,
        install_lock_held: bool = False,
    ) -> Path:
        lock = nullcontext() if install_lock_held else self._camofox_install_lock()
        with lock:
            return self._install_camofox_browser_locked(force=force)

    def _install_camofox_browser_locked(self, *, force: bool) -> Path:
        current = self._camofox_browser_executable()
        if current is not None and not force:
            filename, _sha256, _size, version, release = self._camofox_browser_asset()
            version_path = current.parent / "version.json"
            if not version_path.is_file():
                _write_json_secure(version_path, {"version": version, "release": release})
            return current
        runtime_dir = self.config.runtime_dir / "camofox"
        browser_dir = runtime_dir / "browser"
        filename, expected_sha256, expected_size, version, release = self._camofox_browser_asset()
        url = (
            "https://github.com/daijro/camoufox/releases/download/"
            f"{CAMOFOX_BROWSER_RELEASE}/{filename}"
        )
        unique = uuid.uuid4().hex
        archive = runtime_dir / f"browser-download-{unique}.zip"
        staging = runtime_dir / f"browser.staging-{unique}"
        digest = hashlib.sha256()
        downloaded = 0
        started_at = time.monotonic()
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "ubitech-agent-runtime"})
            with urllib.request.urlopen(request, timeout=120) as response, archive.open("wb") as output:
                raw_length = str(response.headers.get("Content-Length") or "").strip()
                if raw_length:
                    try:
                        declared_length = int(raw_length)
                    except ValueError as exc:
                        raise RuntimeError("managed Camoufox browser response has an invalid Content-Length") from exc
                    if declared_length != expected_size:
                        raise RuntimeError(
                            "managed Camoufox browser Content-Length mismatch: "
                            f"expected {expected_size}, found {declared_length}"
                        )
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    downloaded += len(chunk)
                    if downloaded > expected_size or downloaded > CAMOFOX_BROWSER_MAX_ARCHIVE_BYTES:
                        raise RuntimeError("managed Camoufox browser download exceeds the pinned asset size")
                    if time.monotonic() - started_at > CAMOFOX_BROWSER_DOWNLOAD_DEADLINE_SECONDS:
                        raise RuntimeError("managed Camoufox browser download exceeded its time limit")
                    digest.update(chunk)
                    output.write(chunk)
            if downloaded != expected_size:
                raise RuntimeError(
                    f"managed Camoufox browser size mismatch: expected {expected_size}, found {downloaded}"
                )
            actual_sha256 = digest.hexdigest()
            if actual_sha256 != expected_sha256:
                raise RuntimeError(
                    "managed Camoufox browser checksum mismatch: "
                    f"expected {expected_sha256}, found {actual_sha256}"
                )
            staging.mkdir(mode=0o700, parents=True)
            staging_root = staging.resolve()
            with zipfile.ZipFile(archive) as bundle:
                members = self._validated_camofox_archive_members(bundle, staging_root)
                bundle.extractall(staging, members)
            for path in staging.rglob("*"):
                try:
                    path.chmod(0o755 if path.is_dir() or path.is_file() else 0o700)
                except OSError:
                    pass
            executable = next(
                (
                    path
                    for path in staging.rglob("camoufox")
                    if path.is_file() and path.name == "camoufox"
                ),
                None,
            )
            if executable is None:
                raise RuntimeError("managed Camoufox browser archive has no executable")
            relative_executable = executable.relative_to(staging).as_posix()
            _write_json_secure(executable.parent / "version.json", {"version": version, "release": release})
            _write_json_secure(
                staging / CAMOFOX_RUNTIME_INSTALL_MARKER,
                {
                    "release": CAMOFOX_BROWSER_RELEASE,
                    "asset": filename,
                    "sha256": expected_sha256,
                    "executable": relative_executable,
                    "installed_at": _iso_now(),
                },
            )
            previous = runtime_dir / "browser.previous"
            shutil.rmtree(previous, ignore_errors=True)
            if browser_dir.exists():
                browser_dir.rename(previous)
            try:
                staging.rename(browser_dir)
            except Exception:
                if previous.exists() and not browser_dir.exists():
                    previous.rename(browser_dir)
                raise
            shutil.rmtree(previous, ignore_errors=True)
            installed = browser_dir / relative_executable
            installed.chmod(0o755)
            return installed
        finally:
            archive.unlink(missing_ok=True)
            shutil.rmtree(staging, ignore_errors=True)

    @staticmethod
    def _validated_camofox_archive_members(
        bundle: zipfile.ZipFile,
        staging_root: Path,
    ) -> list[zipfile.ZipInfo]:
        members = bundle.infolist()
        if len(members) > CAMOFOX_BROWSER_MAX_ARCHIVE_MEMBERS:
            raise RuntimeError("managed Camoufox browser archive contains too many entries")
        extracted_bytes = 0
        targets: set[Path] = set()
        for member in members:
            member_mode = (member.external_attr >> 16) & 0xFFFF
            if stat.S_ISLNK(member_mode):
                raise RuntimeError("managed Camoufox browser archive contains a symbolic link")
            file_type = stat.S_IFMT(member_mode)
            if file_type not in {0, stat.S_IFREG, stat.S_IFDIR}:
                raise RuntimeError("managed Camoufox browser archive contains a special file")
            target = (staging_root / member.filename).resolve()
            if target != staging_root and staging_root not in target.parents:
                raise RuntimeError("managed Camoufox browser archive contains an unsafe path")
            if target in targets:
                raise RuntimeError("managed Camoufox browser archive contains a duplicate target")
            targets.add(target)
            extracted_bytes += int(member.file_size)
            if extracted_bytes > CAMOFOX_BROWSER_MAX_EXTRACTED_BYTES:
                raise RuntimeError("managed Camoufox browser archive exceeds the extraction limit")
            if member.file_size > 0:
                if member.compress_size <= 0:
                    raise RuntimeError("managed Camoufox browser archive has an invalid compression ratio")
                if member.file_size / member.compress_size > CAMOFOX_BROWSER_MAX_COMPRESSION_RATIO:
                    raise RuntimeError("managed Camoufox browser archive has an unsafe compression ratio")
        return members

    def _camofox_browser_executable(self) -> Path | None:
        browser_dir = self.config.runtime_dir / "camofox" / "browser"
        marker = _read_json_mapping(browser_dir / CAMOFOX_RUNTIME_INSTALL_MARKER)
        try:
            filename, expected_sha256, _size, _version, _release = self._camofox_browser_asset()
        except RuntimeError:
            return None
        if (
            marker.get("release") != CAMOFOX_BROWSER_RELEASE
            or marker.get("asset") != filename
            or marker.get("sha256") != expected_sha256
        ):
            return None
        relative = str(marker.get("executable") or "")
        if not relative:
            return None
        executable = (browser_dir / relative).resolve()
        try:
            executable.relative_to(browser_dir.resolve())
        except ValueError:
            return None
        bundle_dir = executable.parent
        browser_binary = bundle_dir / "camoufox-bin"
        required_files = (
            bundle_dir / "properties.json",
            bundle_dir / "version.json",
            bundle_dir / "libxul.so",
            bundle_dir / "fontconfig" / "linux" / "fonts.conf",
        )
        if (
            not executable.is_file()
            or not os.access(executable, os.X_OK)
            or not browser_binary.is_file()
            or not os.access(browser_binary, os.X_OK)
            or any(not path.is_file() for path in required_files)
        ):
            return None
        return executable

    def _firecrawl_command(self) -> tuple[list[str], Path | None, str]:
        configured = self._effective_firecrawl_command()
        repo = self._effective_firecrawl_repo()
        if configured:
            return (shlex.split(configured), repo if repo.exists() else None, configured)
        if not repo.exists():
            return ([], repo, f"Firecrawl source not found: {repo}")
        compose_file = (
            repo / "docker-compose.yaml"
            if self._managed_firecrawl_enabled()
            else self._firecrawl_compose_file(repo)
        )
        if not compose_file.is_file() or compose_file.is_symlink():
            compose_file = None
        if compose_file is None:
            return ([], repo, f"Firecrawl repository is missing a Docker Compose file: {repo}")
        override = self._ensure_firecrawl_compose_override()
        # Source the managed .env from the platform data dir instead of letting
        # compose pick up repo/.env, so the generated secret never lands in the
        # managed upstream checkout. The file is materialized by prepare_firecrawl /
        # _start_firecrawl; building the argv stays side-effect free for status
        # polls (which also call this helper).
        env_file = self._firecrawl_env_path()
        return (
            [
                "docker",
                "compose",
                "--project-name",
                FIRECRAWL_COMPOSE_PROJECT,
                "--env-file",
                str(env_file),
                "-f",
                compose_file.name,
                "-f",
                str(override),
                "up",
                "--detach",
                "--wait",
                "--wait-timeout",
                str(self._firecrawl_compose_wait_timeout()),
                "--no-build",
                "--pull",
                "missing",
            ],
            repo,
            f"self-hosted Firecrawl compose stack: {repo}",
        )

    def _firecrawl_compose_wait_timeout(self) -> int:
        return max(
            FIRECRAWL_COMPOSE_WAIT_MIN_SECONDS,
            math.ceil(self._runtime_startup_wait_seconds("firecrawl")),
        )

    def _managed_firecrawl_source_error(self) -> str:
        """Revalidate the deployment-managed source before prepare and start.

        Unit-level/custom ``PlatformConfig`` objects may still name a
        non-canonical repository for compatibility. Standard deployment paths
        are canonical and receive the full immutable-revision check here.
        """

        if self._effective_firecrawl_command():
            return ""
        raw = UPSTREAM_SOURCES.get("firecrawl")
        if not isinstance(raw, dict):
            return "managed Firecrawl source contract is missing"
        revision = str(raw.get("revision") or "")
        expected_services_raw = raw.get("compose_services")
        if not re.fullmatch(r"[0-9a-f]{40}", revision) or not isinstance(
            expected_services_raw, list
        ):
            return "managed Firecrawl source contract is invalid"
        expected_services = tuple(str(value) for value in expected_services_raw)
        image_services = tuple(sorted(service for service, _image in FIRECRAWL_SERVICE_IMAGES))
        if expected_services != image_services:
            return "managed Firecrawl image overrides do not cover the contracted services"

        repo = self._effective_firecrawl_repo()
        canonical = self.config.firecrawl_runtime_dir / "source" / revision
        if repo.absolute() != canonical.absolute():
            # Non-canonical paths are supported only by direct/custom config
            # construction. They are not deployment-managed source caches.
            return ""
        try:
            metadata = repo.lstat()
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
                return "managed Firecrawl source must be a real directory"
            if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
                return "managed Firecrawl source has an unexpected owner"
        except OSError as exc:
            return f"managed Firecrawl source cannot be inspected: {exc}"

        git_env = os.environ.copy()
        git_env["GIT_OPTIONAL_LOCKS"] = "0"
        try:
            head = subprocess.run(
                ["git", "rev-parse", "--verify", "HEAD"],
                cwd=repo,
                env=git_env,
                text=True,
                capture_output=True,
                timeout=30,
                check=False,
            )
            if head.returncode != 0 or head.stdout.strip() != revision:
                return "managed Firecrawl source revision does not match its contract"
            status_result = subprocess.run(
                [
                    "git",
                    "status",
                    "--porcelain=v1",
                    "--untracked-files=all",
                    "--ignored=matching",
                ],
                cwd=repo,
                env=git_env,
                text=True,
                capture_output=True,
                timeout=30,
                check=False,
            )
            if status_result.returncode != 0 or status_result.stdout.strip():
                return "managed Firecrawl source is modified"
            actual_services = parse_compose_service_names(
                repo / "docker-compose.yaml"
            )
        except (OSError, subprocess.SubprocessError, UpstreamSourceValidationError) as exc:
            return f"managed Firecrawl source validation failed: {exc}"
        if actual_services != expected_services:
            return (
                "managed Firecrawl Compose services do not match the source contract"
            )
        return ""

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
            "# Generated by ubitech agent for the managed local runtime.",
            "# Every image is pinned to an immutable registry digest.",
            "services:",
        ]
        for service, image in FIRECRAWL_SERVICE_IMAGES:
            lines.extend(
                (
                    f"  {service}:",
                    f"    image: {image}",
                    "    labels:",
                    '      org.ubitech.agent.managed: "true"',
                )
            )
            if service == "api":
                # The upstream initializer is intentionally a one-shot
                # container.  Declaring it as a successful-completion
                # dependency makes Compose's global `up --wait` use completion
                # semantics instead of treating its clean exit as a crash.
                lines.extend(
                    (
                        "    depends_on:",
                        "      foundationdb-init:",
                        "        condition: service_completed_successfully",
                    )
                )
        lines.append("")
        text = "\n".join(lines)
        override.parent.mkdir(parents=True, exist_ok=True)
        if not override.exists() or override.read_text(encoding="utf-8") != text:
            override.write_text(text, encoding="utf-8")
        return override

    def _firecrawl_env_path(self) -> Path:
        # Keep the managed Firecrawl .env (which carries a generated
        # BULL_AUTH_KEY secret) under the platform data directory rather than
        # inside the managed Firecrawl source checkout. The repository boundary
        # in docs/development/repository.md keeps managed state out of upstream
        # source trees.
        return self.config.firecrawl_runtime_dir / ".env"

    def _ensure_firecrawl_env(self) -> Path:
        env_path = self._firecrawl_env_path()
        values = _read_env_file(env_path)
        changed = False
        for stale_key in ("SEARXNG_ENDPOINT", "SEARXNG_PORT"):
            if stale_key in values:
                values.pop(stale_key, None)
                changed = True
        port = str(urllib.parse.urlparse(self._effective_firecrawl_api_url()).port or 3002)
        defaults = {
            "PORT": f"127.0.0.1:{port}",
            "HOST": "0.0.0.0",
            "USE_DB_AUTHENTICATION": "false",
            "BULL_AUTH_KEY": self._firecrawl_bull_auth_key(),
        }
        for key, value in defaults.items():
            # PORT/HOST are managed security boundaries and must also repair
            # files generated by older releases. Secrets remain stable once
            # materialized.
            if (
                key in {
                    "PORT",
                    "HOST",
                }
                and values.get(key) != value
            ) or not values.get(key):
                values[key] = value
                changed = True
        if changed or not env_path.exists():
            env_path.parent.mkdir(parents=True, exist_ok=True)
            _write_env_file(env_path, values)
        return env_path

    def _searxng_runtime_dir(self) -> Path:
        return self.config.runtime_dir / "searxng"

    def _searxng_command(self) -> tuple[list[str], Path | None, str]:
        runtime_dir = self._searxng_runtime_dir()
        url_error = self._searxng_loopback_url_error()
        if url_error:
            return ([], runtime_dir, url_error)
        compose_path = self._ensure_searxng_compose()
        return (
            [
                "docker",
                "compose",
                "--project-name",
                self._searxng_compose_project(),
                "-f",
                str(compose_path),
                "up",
                "--detach",
                "--wait",
                "--wait-timeout",
                str(self._searxng_compose_wait_timeout()),
                "--no-build",
                "--pull",
                "missing",
            ],
            runtime_dir,
            f"platform-managed SearXNG compose stack: {runtime_dir}",
        )

    def _searxng_compose_wait_timeout(self) -> int:
        return max(
            SEARXNG_COMPOSE_WAIT_MIN_SECONDS,
            math.ceil(self._runtime_startup_wait_seconds("searxng")),
        )

    def _searxng_compose_project(self) -> str:
        runtime_key = os.fsencode(str(self._searxng_runtime_dir().resolve()))
        suffix = hashlib.sha256(runtime_key).hexdigest()[:16]
        return f"ubitech-searxng-{suffix}"

    def _ensure_searxng_compose(self) -> Path:
        runtime_dir = ensure_private_directory(self._searxng_runtime_dir())
        ensure_private_directory(runtime_dir / "logs")
        config_dir = ensure_private_directory(runtime_dir / "config")
        cache_dir = ensure_private_directory(runtime_dir / "cache")
        self._ensure_searxng_config()
        compose_path = runtime_dir / SEARXNG_COMPOSE_FILE
        ensure_private_file(compose_path)
        published_port = self._searxng_loopback_publish()
        text = "\n".join(
            (
                "# Generated by ubitech agent for the managed local runtime.",
                "# The host publication is a validated literal loopback address.",
                "services:",
                "  searxng:",
                f"    image: {SEARXNG_IMAGE}",
                "    labels:",
                '      org.ubitech.agent.managed: "true"',
                "    restart: unless-stopped",
                "    environment:",
                '      FORCE_OWNERSHIP: "false"',
                "    ports:",
                f"      - {json.dumps(published_port + ':8080')}",
                "    volumes:",
                f"      - {json.dumps(str(config_dir) + ':/etc/searxng:ro')}",
                f"      - {json.dumps(str(cache_dir) + ':/var/cache/searxng')}",
                "    healthcheck:",
                "      test:",
                '        - "CMD"',
                '        - "wget"',
                '        - "--quiet"',
                '        - "--tries=1"',
                '        - "--spider"',
                '        - "http://127.0.0.1:8080/healthz"',
                "      interval: 10s",
                "      timeout: 3s",
                "      retries: 12",
                "      start_period: 20s",
                "",
            )
        )
        try:
            if compose_path.read_text(encoding="utf-8") == text:
                compose_path.chmod(0o600)
                return compose_path
        except OSError:
            pass
        _write_text_secure(compose_path, text)
        return compose_path

    def _ensure_searxng_config(self) -> Path:
        runtime_dir = ensure_private_directory(self._searxng_runtime_dir())
        config_dir = ensure_private_directory(runtime_dir / "config")
        ensure_private_directory(runtime_dir / "cache")
        settings_path = config_dir / "settings.yml"
        ensure_private_file(settings_path)
        secret = self._searxng_secret_key(runtime_dir)
        text = "\n".join(
            (
                "# Generated by ubitech agent. Manual changes are overwritten.",
                "use_default_settings: true",
                "",
                "server:",
                f"  secret_key: {json.dumps(secret)}",
                "  limiter: false",
                "  public_instance: false",
                "  image_proxy: false",
                "",
                "search:",
                "  formats:",
                "    - json",
                "",
            )
        )
        try:
            if settings_path.read_text(encoding="utf-8") == text:
                settings_path.chmod(0o600)
                return settings_path
        except OSError:
            pass
        _write_text_secure(settings_path, text)
        return settings_path

    @staticmethod
    def _searxng_secret_key(runtime_dir: Path) -> str:
        path = runtime_dir / "secret-key"
        ensure_private_file(path)
        try:
            current = path.read_text(encoding="utf-8").strip()
        except OSError:
            current = ""
        if len(current) >= 32:
            return current
        value = secrets.token_urlsafe(48)
        _write_text_secure(path, value + "\n")
        return value

    def searxng_loopback_url(self) -> str:
        """Return the host-only endpoint exposed by the managed sidecar."""

        url = self._effective_searxng_api_url()
        error = self._searxng_loopback_url_error(
            managed=self._managed_searxng_enabled()
        )
        if error:
            raise ValueError(error)
        return url

    def _effective_searxng_api_url(self) -> str:
        return str(
            getattr(self.config, "searxng_api_url", SEARXNG_LOOPBACK_URL)
            or SEARXNG_LOOPBACK_URL
        ).strip().rstrip("/")

    def _searxng_loopback_url_error(self, *, managed: bool = True) -> str:
        url = self._effective_searxng_api_url()
        error = (
            self._trusted_http_url_error("SearXNG", url)
            if self.config.deployment_mode == "container" and not managed
            else self._managed_loopback_url_error("SearXNG", url)
        )
        if error:
            return error
        try:
            parsed = urllib.parse.urlsplit(url)
            port = parsed.port
            if port is None:
                return "Managed SearXNG URL must contain an explicit loopback port"
            if not 1 <= port <= 65535:
                return "Managed SearXNG URL loopback port must be between 1 and 65535"
        except ValueError:
            return "Managed SearXNG URL must contain a valid loopback port"
        if self.config.deployment_mode != "container" or managed:
            try:
                if not ipaddress.ip_address(str(parsed.hostname or "")).is_loopback:
                    return "SearXNG URL must use a literal loopback IP address"
            except ValueError:
                return "SearXNG URL must use a literal loopback IP address"
        if managed and parsed.scheme != "http":
            return "Managed SearXNG URL must use http on its private loopback listener"
        if (
            parsed.username is not None
            or parsed.password is not None
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
        ):
            return (
                "Managed SearXNG URL must be a loopback base URL without "
                "credentials, path, query or fragment"
            )
        return ""

    def _searxng_loopback_publish(self) -> str:
        parsed = urllib.parse.urlsplit(self._effective_searxng_api_url())
        host = str(parsed.hostname or "127.0.0.1").strip("[]")
        if host.lower() in {"localhost", "localhost.localdomain"}:
            host = "127.0.0.1"
        port = parsed.port
        if port is None or not 1 <= port <= 65535:
            raise ValueError("Managed SearXNG URL must contain a valid port")
        if ":" in host:
            host = f"[{host}]"
        return f"{host}:{port}"

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
            validate_loopback_url(url, base_url=True)
        except ValueError:
            return (
                f"{name} URL must be a credential-free numeric loopback "
                "base URL"
            )
        return ""

    @staticmethod
    def _trusted_http_url_error(name: str, url: str) -> str:
        try:
            validate_http_base_url(url)
        except ValueError:
            return f"{name} URL must be a credential-free HTTP(S) base URL"
        return ""

    @staticmethod
    def _uses_loopback_transport(url: str) -> bool:
        try:
            validate_loopback_url(url, base_url=True)
            return True
        except ValueError:
            return False

    def _probe_camofox_health(self) -> bool:
        payload = self._camofox_json_request("/health", method="GET", authenticated=False)
        if not (
            isinstance(payload, dict)
            and payload.get("ok") is True
            and payload.get("engine") == "camoufox"
        ):
            return False
        # The upstream API reports ok=true even when the browser failed to
        # launch. A recently verified browser gets a short disconnect grace
        # period for normal idle shutdown; a persistent disconnect triggers a
        # fresh tab/snapshot/screenshot cycle instead of becoming a permanent
        # false-green status.
        if self._camofox_capability_verified:
            if payload.get("browserConnected") is True and payload.get("browserRunning") is True:
                return True
            if (
                time.monotonic() - self._camofox_capability_verified_at
                < CAMOFOX_CAPABILITY_REPROBE_AFTER_SECONDS
            ):
                return True
        return self._probe_camofox_capability()

    def _probe_camofox_capability(self) -> bool:
        now = time.monotonic()
        if now < self._camofox_capability_next_probe_at:
            return False
        generation = self._camofox_process_generation
        with self._camofox_capability_probe_lock:
            now = time.monotonic()
            if now < self._camofox_capability_next_probe_at:
                return False
            # Another status caller may have completed the expensive probe
            # while this caller waited for the per-process probe lock.
            if (
                self._camofox_capability_verified
                and now - self._camofox_capability_verified_at
                < CAMOFOX_CAPABILITY_REPROBE_AFTER_SECONDS
            ):
                return True
            return self._probe_camofox_capability_unlocked(generation)

    def _probe_camofox_capability_unlocked(self, generation: int) -> bool:
        url_scope = hashlib.sha256(self._effective_camofox_url().encode("utf-8")).hexdigest()[:24]
        probe_user = f"ubitech-runtime-health-{url_scope}"
        tab_id = ""
        try:
            created = self._camofox_json_request(
                "/tabs",
                body={"userId": probe_user, "sessionKey": "health"},
                method="POST",
                authenticated=True,
                timeout=8.0,
            )
            tab_id = str((created or {}).get("tabId") or "")
            if not tab_id:
                raise RuntimeError("tab creation returned no tabId")
            encoded = urllib.parse.quote(tab_id, safe="")
            query = urllib.parse.urlencode({"userId": probe_user})
            snapshot = self._camofox_json_request(
                f"/tabs/{encoded}/snapshot?{query}",
                method="GET",
                authenticated=True,
                timeout=8.0,
            )
            if not isinstance((snapshot or {}).get("snapshot"), str):
                raise RuntimeError("snapshot capability is unavailable")
            screenshot = self._camofox_binary_request(
                f"/tabs/{encoded}/screenshot?{query}", timeout=8.0
            )
            if not screenshot.startswith(b"\x89PNG\r\n\x1a\n"):
                raise RuntimeError("screenshot capability did not return a PNG")
        except Exception as exc:
            if generation == self._camofox_process_generation:
                self._camofox_capability_verified = False
                self._camofox_capability_verified_at = 0.0
                self._camofox_capability_next_probe_at = (
                    time.monotonic() + CAMOFOX_CAPABILITY_RETRY_SECONDS
                )
                self._camofox_last_error = f"Camofox browser capability probe failed: {exc}"
            return False
        finally:
            encoded_user = urllib.parse.quote(probe_user, safe="")
            try:
                self._camofox_json_request(
                    f"/sessions/{encoded_user}",
                    method="DELETE",
                    authenticated=True,
                    timeout=3.0,
                )
            except Exception:
                # Cleanup is best-effort, but it is always attempted even when
                # tab creation failed after the upstream session was allocated.
                pass
        if generation != self._camofox_process_generation:
            return False
        self._camofox_capability_verified = True
        self._camofox_capability_verified_at = time.monotonic()
        self._camofox_capability_next_probe_at = 0.0
        self._camofox_last_error = ""
        return True

    def _reset_camofox_capability_state(self) -> None:
        # Do not acquire the potentially long-running probe lock during
        # shutdown. The generation check prevents a racing old probe from
        # publishing success for the replacement process.
        self._camofox_process_generation += 1
        self._camofox_capability_verified = False
        self._camofox_capability_verified_at = 0.0
        self._camofox_capability_next_probe_at = 0.0

    def _camofox_json_request(
        self,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        method: str,
        authenticated: bool,
        timeout: float = 1.0,
    ) -> dict[str, Any] | None:
        headers = {"Accept": "application/json"}
        if authenticated:
            headers["Authorization"] = f"Bearer {self._camofox_access_key()}"
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        try:
            request = urllib.request.Request(
                self._effective_camofox_url().rstrip("/") + path,
                data=data,
                headers=headers,
                method=method,
            )
            open_request = (
                open_private_service_url
                if self.config.deployment_mode == "container"
                else open_loopback_url
            )
            with open_request(request, timeout=timeout) as response:
                if not 200 <= response.status < 300:
                    return None
                raw = response.read(512 * 1024)
            payload = json.loads(raw.decode("utf-8")) if raw else {}
            return payload if isinstance(payload, dict) else None
        except (
            urllib.error.HTTPError,
            urllib.error.URLError,
            TimeoutError,
            OSError,
            ValueError,
            json.JSONDecodeError,
        ):
            return None

    def _camofox_binary_request(self, path: str, *, timeout: float) -> bytes:
        request = urllib.request.Request(
            self._effective_camofox_url().rstrip("/") + path,
            headers={"Authorization": f"Bearer {self._camofox_access_key()}"},
            method="GET",
        )
        open_request = (
            open_private_service_url
            if self.config.deployment_mode == "container"
            else open_loopback_url
        )
        with open_request(request, timeout=timeout) as response:
            if not 200 <= response.status < 300:
                raise RuntimeError(f"HTTP {response.status}")
            content_type = str(response.headers.get("Content-Type") or "").lower()
            if "image/png" not in content_type:
                raise RuntimeError(f"unexpected screenshot content type: {content_type or 'missing'}")
            payload = response.read(2 * 1024 * 1024 + 1)
        if len(payload) > 2 * 1024 * 1024:
            raise RuntimeError("health screenshot exceeded 2 MiB")
        return payload

    def _probe_firecrawl_health(self) -> bool:
        return self._probe_json_health(
            self._effective_firecrawl_api_url(),
            ("/v0/health/liveness", "/"),
            lambda payload: payload.get("status") == "ok" or payload.get("message") == "Firecrawl API",
        )

    def _probe_searxng_health(self) -> bool:
        try:
            request = urllib.request.Request(
                self._effective_searxng_api_url().rstrip("/") + "/healthz",
                headers={"Accept": "text/plain"},
                method="GET",
            )
            open_request = (
                open_private_service_url
                if self.config.deployment_mode == "container"
                else open_loopback_url
            )
            with open_request(request, timeout=0.8) as response:
                if not 200 <= response.status < 300:
                    return False
                # Require SearXNG's exact health marker so an unrelated HTTP
                # process occupying the configured port cannot report this
                # independent runtime as healthy.
                body = response.read(256)
            return body.strip() == b"OK"
        except (
            urllib.error.HTTPError,
            urllib.error.URLError,
            TimeoutError,
            OSError,
            ValueError,
        ):
            return False

    def _probe_json_health(self, base_url: str, paths: tuple[str, ...], validator) -> bool:
        base = base_url.rstrip("/")
        if not base:
            return False
        for path in paths:
            try:
                request = urllib.request.Request(f"{base}{path}", method="GET")
                if PlatformRuntimeManager._uses_loopback_transport(base):
                    open_request = open_loopback_url
                elif self.config.deployment_mode == "container":
                    open_request = open_private_service_url
                else:
                    open_request = open_trusted_service_url
                with open_request(request, timeout=0.8) as response:
                    if not 200 <= response.status < 300:
                        continue
                    raw = response.read(64 * 1024)
                    payload = json.loads(raw.decode("utf-8"))
                    if isinstance(payload, dict) and bool(validator(payload)):
                        return True
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError):
                continue
        return False

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

    def _managed_searxng_enabled(self) -> bool:
        return bool(getattr(self.config, "manage_searxng", True))

    def _platform_internal_url(self) -> str:
        """Return the direct platform listener used by the managed sidecar.

        The public base URL may point at an HTTPS reverse proxy or an external
        hostname. Sending the internal tool bearer there would cross the
        private runtime boundary and can also route the request back through a
        proxy that intentionally does not expose ``/internal``. Use the actual
        platform listener instead, normalizing wildcard binds to loopback.
        """

        host = str(self.config.host or "").strip()
        if host in {"", "0.0.0.0"}:
            host = "127.0.0.1"
        elif host == "::":
            host = "::1"
        if ":" in host and not host.startswith("["):
            host = f"[{host}]"
        return f"http://{host}:{int(self.config.port)}"

    def _runtime_startup_wait_seconds(self, name: str) -> float:
        """Warm-up budget for the heavier managed runtimes.

        Camofox (npx package + browser download), SearXNG and Firecrawl
        (``docker compose up --pull missing``) take long enough to need larger
        defaults than the general runtime startup budget. Per-runtime
        environment overrides take precedence.
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
        base = max(0.0, float(self.config.runtime_startup_wait_seconds))
        if base <= 0:
            return 0.0
        default = 300.0 if name == "firecrawl" else 120.0
        return max(default, base)

    def _effective_camofox_url(self) -> str:
        return (self._runtime_setting(CAMOFOX_SETTING_URL) or self.config.camofox_url or "http://127.0.0.1:9377").strip().rstrip("/")

    def _effective_camofox_command(self) -> str:
        return self._runtime_setting(CAMOFOX_SETTING_COMMAND) or self.config.camofox_command

    def _effective_firecrawl_repo(self) -> Path:
        # Managed source paths are fixed by the canonical upstream contract.
        # Legacy database rows must not redirect a managed runtime back into
        # the former repository-root checkout.
        if not self._managed_firecrawl_enabled():
            value = self._runtime_setting(FIRECRAWL_SETTING_REPO)
            if value:
                return Path(value).expanduser()
        if self.config.firecrawl_repo is not None:
            return self.config.firecrawl_repo
        return self.config.data_dir.parent / "firecrawl"

    def _effective_firecrawl_api_url(self) -> str:
        return (self._runtime_setting(FIRECRAWL_SETTING_API_URL) or self.config.firecrawl_api_url or "http://127.0.0.1:3002").strip().rstrip("/")

    def firecrawl_loopback_url(self) -> str:
        """Return the validated Firecrawl service endpoint used by tools."""

        url = self._effective_firecrawl_api_url()
        error = (
            self._managed_loopback_url_error("Firecrawl", url)
            if self._managed_firecrawl_enabled()
            else self._trusted_http_url_error("Firecrawl", url)
        )
        if error:
            raise ValueError(error)
        return url

    def _effective_firecrawl_command(self) -> str:
        return self._runtime_setting(FIRECRAWL_SETTING_COMMAND) or self.config.firecrawl_command

    def _effective_cognee_repo(self) -> Path:
        if not self._managed_cognee_enabled():
            value = self._runtime_setting(COGNEE_SETTING_REPO)
            if value:
                return Path(value).expanduser()
        return self.config.cognee_repo

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

    def _camofox_source_label(self) -> str:
        command, _cwd, detail = self._camofox_command()
        return detail if command else ""


def _module_importable(name: str) -> bool:
    try:
        __import__(name)
        return True
    except Exception:
        return False


def _scrubbed_process_env() -> dict[str, str]:
    """Copy ordinary host environment without forwarding unrelated secrets."""

    return {
        key: value
        for key, value in os.environ.items()
        if not _SENSITIVE_ENV_NAME_RE.search(key)
    }


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _read_json_mapping(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return loaded if isinstance(loaded, dict) else {}


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
    # Managed runtime env files can contain generated credentials, so keep them
    # owner-only instead of relying on the process umask.
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
