from __future__ import annotations

import importlib.util
import json
import math
import os
import stat
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import PlatformConfig
from .design_contract_generated import (
    RUN_IDLE_TIMEOUT_MAXIMUM_SECONDS,
    RUN_IDLE_TIMEOUT_MINIMUM_SECONDS,
)
from .loopback_http import (
    open_loopback_url,
    open_private_service_url,
    validate_http_base_url,
    validate_loopback_url,
)


AGENT_SETTING_MODEL = "agent_runtime_model"
AGENT_SETTING_PROVIDER = "agent_runtime_provider"
AGENT_SETTING_IDLE_TIMEOUT = "agent_runtime_idle_timeout_seconds"
AGENT_SETTING_MAX_CONCURRENCY = "agent_runtime_max_concurrency"
AGENT_SETTING_COMPACTION_THRESHOLD = "agent_runtime_compaction_threshold"

COGNEE_SETTING_BACKEND = "cognee_backend"
COGNEE_SETTING_DATASET = "cognee_dataset"
COGNEE_SETTING_INGEST_BACKGROUND = "cognee_ingest_background"
COGNEE_SETTING_DATA_ROOT = "cognee_data_root_directory"
COGNEE_SETTING_SYSTEM_ROOT = "cognee_system_root_directory"
COGNEE_SETTING_CACHE_ROOT = "cognee_cache_root_directory"
COGNEE_SETTING_LOGS_DIR = "cognee_logs_dir"
COGNEE_SETTING_SKIP_CONNECTION_TEST = "cognee_skip_connection_test"

RUNTIME_STATUS_CACHE_SECONDS = 10.0
_MAX_HEALTH_BODY_BYTES = 64 * 1024


@dataclass(frozen=True)
class RuntimeStatus:
    name: str
    available: bool
    state: str
    detail: str = ""
    error: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "available": self.available,
            "state": self.state,
            "detail": self.detail,
            "error": self.error,
        }


class PlatformRuntimeManager:
    """HTTP health and configuration adapters for Manager-owned services."""

    def __init__(
        self,
        config: PlatformConfig,
        secret_provider,
        *,
        setting_provider=None,
    ):
        self.config = config
        self.secret_provider = secret_provider
        self.setting_provider = setting_provider
        self._status_cache_lock = threading.Lock()
        self._status_cache: dict[str, Any] | None = None
        self._status_cache_checked_at = 0.0
        self._status_cache_generation = 0
        self._status_refresh_thread: threading.Thread | None = None
        self._searxng_cache_lock = threading.Lock()
        self._searxng_cache: dict[str, Any] | None = None
        self._searxng_cache_checked_at = 0.0
        self._searxng_refresh_thread: threading.Thread | None = None
        self._closed = False

    def status(self, *, refresh: bool = True) -> dict[str, Any]:
        if refresh:
            with ThreadPoolExecutor(
                max_workers=4,
                thread_name_prefix="runtime-health",
            ) as executor:
                futures = {
                    "agent": executor.submit(self.agent_runtime_status, refresh=True),
                    "camofox": executor.submit(self.camofox_status, refresh=True),
                    "searxng": executor.submit(self.searxng_status, refresh=True),
                    "firecrawl": executor.submit(self.firecrawl_status, refresh=True),
                }
                statuses = {name: future.result() for name, future in futures.items()}
        else:
            statuses = {
                "agent": self.agent_runtime_status(refresh=False),
                "camofox": self.camofox_status(refresh=False),
                "searxng": self.searxng_status(refresh=False),
                "firecrawl": self.firecrawl_status(refresh=False),
            }
        statuses["cognee"] = self.cognee_status()
        return {name: status.to_dict() for name, status in statuses.items()}

    def cached_status(
        self,
        *,
        max_age_seconds: float = RUNTIME_STATUS_CACHE_SECONDS,
    ) -> dict[str, Any]:
        now = time.time()
        with self._status_cache_lock:
            if self._status_cache is None:
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

    def _refresh_status_cache(self, generation: int) -> None:
        try:
            snapshot = self.status(refresh=True)
            checked_at = time.time()
            with self._status_cache_lock:
                if not self._closed and generation == self._status_cache_generation:
                    self._status_cache = deepcopy(snapshot)
                    self._status_cache_checked_at = checked_at
        finally:
            with self._status_cache_lock:
                if self._status_refresh_thread is threading.current_thread():
                    self._status_refresh_thread = None

    def cached_searxng_status(
        self,
        *,
        max_age_seconds: float = 1.0,
    ) -> dict[str, Any]:
        now = time.time()
        with self._searxng_cache_lock:
            if self._searxng_cache is None:
                self._searxng_cache = self.searxng_status(refresh=False).to_dict()
            snapshot = deepcopy(self._searxng_cache)
            checked_at = self._searxng_cache_checked_at
            stale = checked_at <= 0 or now - checked_at >= max(
                0.0, float(max_age_seconds)
            )
            refresh_running = self._searxng_refresh_thread is not None
            if stale and not refresh_running and not self._closed:
                thread = threading.Thread(
                    target=self._refresh_searxng_cache,
                    name="searxng-status-refresh",
                    daemon=True,
                )
                self._searxng_refresh_thread = thread
                thread.start()
        return {
            **snapshot,
            "checked_at": int(checked_at) if checked_at > 0 else None,
            "stale": stale,
        }

    def _refresh_searxng_cache(self) -> None:
        try:
            snapshot = self.searxng_status(refresh=True).to_dict()
            with self._searxng_cache_lock:
                if not self._closed:
                    self._searxng_cache = deepcopy(snapshot)
                    self._searxng_cache_checked_at = time.time()
        finally:
            with self._searxng_cache_lock:
                if self._searxng_refresh_thread is threading.current_thread():
                    self._searxng_refresh_thread = None

    def invalidate_status_cache(self) -> None:
        with self._status_cache_lock:
            self._status_cache_generation += 1
            self._status_cache_checked_at = 0.0
        with self._searxng_cache_lock:
            self._searxng_cache_checked_at = 0.0

    def agent_runtime_config(self) -> dict[str, Any]:
        return {
            "runtime_url": self._effective_agent_runtime_url(),
            "provider": self._runtime_setting(AGENT_SETTING_PROVIDER)
            or self.config.agent_runtime_provider,
            "model": self._runtime_setting(AGENT_SETTING_MODEL)
            or self.config.agent_runtime_model,
            "idle_timeout_seconds": self._effective_agent_idle_timeout_seconds(),
            "max_concurrency": self._effective_agent_max_concurrency(),
            "compaction_threshold": self._effective_compaction_threshold(),
        }

    def ensure_agent_runtime_ready(self, *, wait: bool = True) -> RuntimeStatus:
        return self._wait_for_status(self.agent_runtime_status, wait=wait)

    def agent_runtime_status(self, *, refresh: bool = True) -> RuntimeStatus:
        url = self._effective_agent_runtime_url()
        error = self._endpoint_error("Agent Runtime", url)
        if error:
            return self._invalid_status("agent", error)
        available = self._probe_agent_health() if refresh else False
        return self._service_status(
            "agent",
            available,
            "Agent Runtime is managed by the platform manager",
        )

    def cognee_runtime_config(self) -> dict[str, Any]:
        values = self._cognee_env_values()
        return {
            "runtime_dir": str(self.config.cognee_runtime_dir),
            "backend": self._effective_cognee_backend(),
            "dataset": self._effective_cognee_dataset(),
            "ingest_background": self._effective_cognee_ingest_background(),
            "data_root_directory": values["DATA_ROOT_DIRECTORY"],
            "system_root_directory": values["SYSTEM_ROOT_DIRECTORY"],
            "cache_root_directory": values["CACHE_ROOT_DIRECTORY"],
            "logs_dir": values["COGNEE_LOGS_DIR"],
            "skip_connection_test": values[
                "COGNEE_SKIP_CONNECTION_TEST"
            ].lower()
            in {"1", "true", "yes", "on"},
            "env_path": str(self._cognee_env_path()),
        }

    def ensure_cognee_ready(self) -> RuntimeStatus:
        try:
            self._seed_cognee_env()
        except OSError as exc:
            return RuntimeStatus(
                name="cognee",
                available=False,
                state="error",
                error=str(exc),
            )
        return self.cognee_status()

    def cognee_status(self) -> RuntimeStatus:
        available = importlib.util.find_spec("cognee") is not None
        return RuntimeStatus(
            name="cognee",
            available=available,
            state="available" if available else "missing",
            detail="Cognee is built into the Platform image" if available else "",
            error="" if available else "Cognee package is missing from the Platform image",
        )

    def ensure_camofox_ready(self, *, wait: bool = True) -> RuntimeStatus:
        return self._wait_for_status(self.camofox_status, wait=wait)

    def camofox_status(self, *, refresh: bool = True) -> RuntimeStatus:
        url = self._effective_camofox_url()
        error = self._endpoint_error("Camoufox", url)
        if not error and not self._camofox_access_key():
            error = "Camoufox access key is unavailable"
        if error:
            return self._invalid_status("camofox", error)
        available = self._probe_camofox_health() if refresh else False
        return self._service_status(
            "camofox",
            available,
            "Camoufox is managed by the platform manager",
        )

    def searxng_status(self, *, refresh: bool = True) -> RuntimeStatus:
        url = self._effective_searxng_api_url()
        error = self._endpoint_error("SearXNG", url)
        if error:
            return self._invalid_status("searxng", error)
        available = self._probe_searxng_health() if refresh else False
        return self._service_status(
            "searxng",
            available,
            "SearXNG is managed by the platform manager",
        )

    def firecrawl_status(self, *, refresh: bool = True) -> RuntimeStatus:
        url = self._effective_firecrawl_api_url()
        error = self._endpoint_error("Firecrawl", url)
        if error:
            return self._invalid_status("firecrawl", error)
        available = self._probe_firecrawl_health() if refresh else False
        return self._service_status(
            "firecrawl",
            available,
            "Firecrawl is managed by the platform manager",
        )

    def close(self) -> None:
        with self._status_cache_lock:
            self._closed = True
            self._status_cache_generation += 1
            status_thread = self._status_refresh_thread
        with self._searxng_cache_lock:
            searxng_thread = self._searxng_refresh_thread

        deadline = time.monotonic() + 4.0
        current = threading.current_thread()
        seen: set[int] = set()
        for thread in (status_thread, searxng_thread):
            if thread is None or thread is current or id(thread) in seen:
                continue
            seen.add(id(thread))
            thread.join(timeout=max(0.0, deadline - time.monotonic()))

    def _wait_for_status(self, probe, *, wait: bool) -> RuntimeStatus:
        status = probe(refresh=True)
        if status.available or not wait:
            return status
        deadline = time.monotonic() + max(
            0.0, float(self.config.runtime_startup_wait_seconds)
        )
        while time.monotonic() < deadline:
            time.sleep(0.25)
            status = probe(refresh=True)
            if status.available:
                return status
        return status

    @staticmethod
    def _service_status(
        name: str,
        available: bool,
        detail: str,
    ) -> RuntimeStatus:
        return RuntimeStatus(
            name=name,
            available=available,
            state="running" if available else "unavailable",
            detail=detail,
            error="" if available else f"{name} service is unavailable",
        )

    @staticmethod
    def _invalid_status(name: str, error: str) -> RuntimeStatus:
        return RuntimeStatus(
            name=name,
            available=False,
            state="invalid_config",
            error=error,
        )

    def _probe_agent_health(self) -> bool:
        token = self._agent_runtime_token()
        if not token:
            return False
        request = urllib.request.Request(
            self._effective_agent_runtime_url() + "/health",
            headers={"Authorization": f"Bearer {token}"},
            method="GET",
        )
        def healthy(body: bytes) -> bool:
            payload = json.loads(body.decode("utf-8"))
            return (
                isinstance(payload, dict)
                and payload.get("status") == "ok"
                and payload.get("service")
                == self.config.technical_profile.agent_runtime_health_service
            )

        return self._probe_request(request, healthy)

    def _probe_camofox_health(self) -> bool:
        request = urllib.request.Request(
            self._effective_camofox_url() + "/health",
            headers={"Accept": "application/json"},
            method="GET",
        )

        def healthy(body: bytes) -> bool:
            payload = json.loads(body.decode("utf-8"))
            return (
                isinstance(payload, dict)
                and payload.get("ok") is True
                and payload.get("engine") == "camoufox"
            )

        return self._probe_request(request, healthy)

    def _probe_searxng_health(self) -> bool:
        request = urllib.request.Request(
            self._effective_searxng_api_url() + "/healthz",
            headers={"Accept": "text/plain"},
            method="GET",
        )
        return self._probe_request(request, lambda body: body.strip() == b"OK")

    def _probe_firecrawl_health(self) -> bool:
        base = self._effective_firecrawl_api_url()
        for path in ("/v0/health/liveness", "/"):
            request = urllib.request.Request(base + path, method="GET")

            def healthy(body: bytes) -> bool:
                payload = json.loads(body.decode("utf-8"))
                return isinstance(payload, dict) and (
                    payload.get("status") == "ok"
                    or payload.get("message") == "Firecrawl API"
                )

            if self._probe_request(request, healthy):
                return True
        return False

    def _probe_request(self, request: urllib.request.Request, validator) -> bool:
        try:
            with self._open_service_request(request, timeout=1.0) as response:
                if not 200 <= response.status < 300:
                    return False
                body = response.read(_MAX_HEALTH_BODY_BYTES + 1)
            return len(body) <= _MAX_HEALTH_BODY_BYTES and bool(validator(body))
        except (
            urllib.error.HTTPError,
            urllib.error.URLError,
            TimeoutError,
            OSError,
            ValueError,
            json.JSONDecodeError,
        ):
            return False

    def _open_service_request(
        self,
        request: urllib.request.Request,
        *,
        timeout: float,
    ):
        parsed = urllib.parse.urlsplit(request.full_url)
        candidate = urllib.parse.urlunsplit(
            (parsed.scheme, parsed.netloc, "", "", "")
        )
        if self._uses_loopback_transport(candidate):
            return open_loopback_url(request, timeout=timeout)
        return open_private_service_url(request, timeout=timeout)

    @staticmethod
    def _endpoint_error(name: str, url: str) -> str:
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

    def _effective_agent_runtime_url(self) -> str:
        return self.config.agent_runtime_url.strip().rstrip("/")

    def _effective_camofox_url(self) -> str:
        return self.config.camofox_url.strip().rstrip("/")

    def _effective_searxng_api_url(self) -> str:
        return self.config.searxng_api_url.strip().rstrip("/")

    def _effective_firecrawl_api_url(self) -> str:
        return self.config.firecrawl_api_url.strip().rstrip("/")

    def searxng_service_url(self) -> str:
        url = self._effective_searxng_api_url()
        error = self._endpoint_error("SearXNG", url)
        if error:
            raise ValueError(error)
        return url

    def firecrawl_service_url(self) -> str:
        url = self._effective_firecrawl_api_url()
        error = self._endpoint_error("Firecrawl", url)
        if error:
            raise ValueError(error)
        return url

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
            "agent_runtime_token",
            "AGENT_PLATFORM_AGENT_RUNTIME_TOKEN",
        )

    def _camofox_access_key(self) -> str:
        target_name = "AGENT_PLATFORM_CAMOFOX_ACCESS_KEY"
        target_file_name = target_name + "_FILE"
        target_value = os.getenv(target_name, "")
        target_file = os.getenv(target_file_name, "")

        if target_value and target_file:
            raise RuntimeError(
                f"{target_name} and {target_file_name} cannot both be set"
            )
        if target_file:
            expected = "/run/secrets/agent-platform/camofox-access-key"
            if target_file != expected:
                raise RuntimeError(f"{target_file_name} must be {expected}")
            return self._read_secret_file(target_file, target_file_name)
        if target_value:
            return target_value
        return self._first_secret(target_name)

    @staticmethod
    def _read_secret_file(path: str, label: str) -> str:
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(path, flags)
        except OSError as exc:
            raise RuntimeError(f"{label} does not name a readable secret file") from exc
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 4096:
                raise RuntimeError(f"{label} does not name a bounded regular secret file")
            raw = os.read(descriptor, 4097)
        finally:
            os.close(descriptor)
        if len(raw) > 4096:
            raise RuntimeError(f"{label} exceeds the secret size limit")
        try:
            value = raw.decode("utf-8").strip()
        except UnicodeDecodeError as exc:
            raise RuntimeError(f"{label} is not valid UTF-8") from exc
        if not value:
            raise RuntimeError(f"{label} is empty")
        return value

    def _first_secret(self, *keys: str) -> str:
        for key in keys:
            try:
                value = self.secret_provider(key)
            except Exception:
                value = ""
            if value:
                return str(value)
            value = os.getenv(key, "")
            if value:
                return value
        return ""

    def _effective_cognee_backend(self) -> str:
        value = (
            self._runtime_setting(COGNEE_SETTING_BACKEND)
            or self.config.knowledge_backend
        ).strip().lower()
        return value if value in {"local", "hybrid", "cognee"} else "hybrid"

    def _effective_cognee_dataset(self) -> str:
        return self._runtime_setting(COGNEE_SETTING_DATASET) or self.config.cognee_dataset

    def _effective_cognee_ingest_background(self) -> bool:
        value = self._runtime_setting(COGNEE_SETTING_INGEST_BACKGROUND)
        if value is None:
            return self.config.cognee_ingest_background
        return value.strip().lower() in {"1", "true", "yes", "on"}

    def _cognee_env_values(self) -> dict[str, str]:
        root = self.config.cognee_runtime_dir
        values = {
            "DATA_ROOT_DIRECTORY": self._runtime_setting(COGNEE_SETTING_DATA_ROOT)
            or str(root / "data"),
            "SYSTEM_ROOT_DIRECTORY": self._runtime_setting(COGNEE_SETTING_SYSTEM_ROOT)
            or str(root / "system"),
            "CACHE_ROOT_DIRECTORY": self._runtime_setting(COGNEE_SETTING_CACHE_ROOT)
            or str(root / "cache"),
            "COGNEE_LOGS_DIR": self._runtime_setting(COGNEE_SETTING_LOGS_DIR)
            or str(root / "logs"),
            "COGNEE_SKIP_CONNECTION_TEST": self._runtime_setting(
                COGNEE_SETTING_SKIP_CONNECTION_TEST
            )
            or "true",
        }
        values.update(_read_env_file(self._cognee_env_path()))
        return values

    def _cognee_env_path(self) -> Path:
        return self.config.cognee_runtime_dir / ".env"

    def _seed_cognee_env(self) -> None:
        values = self._cognee_env_values()
        for key in (
            "DATA_ROOT_DIRECTORY",
            "SYSTEM_ROOT_DIRECTORY",
            "CACHE_ROOT_DIRECTORY",
            "COGNEE_LOGS_DIR",
        ):
            value = values.get(key, "")
            if value:
                Path(value).expanduser().mkdir(parents=True, exist_ok=True)
        for key, value in values.items():
            os.environ[key] = value

    def _runtime_setting(self, key: str) -> str | None:
        if self.setting_provider is None:
            return None
        try:
            value = self.setting_provider(key)
        except Exception:
            return None
        return str(value) if value not in {None, ""} else None


def _read_env_file(path: Path) -> dict[str, str]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return {}
    values: dict[str, str] = {}
    for line in lines:
        clean = line.strip()
        if not clean or clean.startswith("#") or "=" not in clean:
            continue
        key, value = clean.split("=", 1)
        key = key.strip()
        if key and key.replace("_", "").isalnum():
            values[key] = value.strip()
    return values
