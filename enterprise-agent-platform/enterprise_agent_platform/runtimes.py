from __future__ import annotations

import os
import json
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from .config import MODEL_SECRET_KEYS, PlatformConfig
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
        self._hermes_process: ProcessLike | None = None
        self._hermes_last_started_at: int | None = None
        self._hermes_last_error = ""
        self._cognee_last_error = ""
        self._managed_llm_api_key: str | None = None

    def prepare(self) -> dict[str, Any]:
        with self._lock:
            hermes = self.prepare_hermes()
            cognee = self.prepare_cognee()
            return {"hermes": hermes.to_dict(), "cognee": cognee.to_dict()}

    def status(self, *, refresh: bool = True) -> dict[str, Any]:
        with self._lock:
            hermes = self.hermes_status(refresh=refresh)
            cognee = self.cognee_status()
            return {"hermes": hermes.to_dict(), "cognee": cognee.to_dict()}

    def prepare_hermes(self) -> RuntimeStatus:
        if not self._managed_hermes_enabled():
            return RuntimeStatus("hermes", False, False, "external", "managed Hermes disabled")

        home = self.config.managed_hermes_home
        home.mkdir(parents=True, exist_ok=True)
        (home / "logs").mkdir(parents=True, exist_ok=True)
        self._install_enterprise_plugin(home)
        self._ensure_hermes_config(home)
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
        with self._lock:
            if not self._managed_hermes_enabled():
                return self.hermes_status(refresh=False)
            prepared = self.prepare_hermes()
            if not prepared.available:
                return prepared
            current = self.hermes_status(refresh=True)
            if current.available:
                return current
            if self._hermes_process is None or self._hermes_process.poll() is not None:
                self._start_hermes()
            if wait and self._effective_startup_wait_seconds() > 0:
                return self._wait_for_hermes()
            return self.hermes_status(refresh=True)

    def restart_hermes(self) -> RuntimeStatus:
        with self._lock:
            self.stop_hermes()
            return self.ensure_hermes_ready(wait=True)

    def stop_hermes(self) -> RuntimeStatus:
        with self._lock:
            proc = self._hermes_process
            if proc is not None and proc.poll() is None:
                try:
                    proc.terminate()
                    proc.wait(timeout=8)
                except Exception:
                    try:
                        proc.kill()
                    except Exception:
                        pass
            self._hermes_process = None
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
        healthy = self._probe_hermes_health() if refresh else False
        if healthy:
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
        if not force and self._managed_venv_ready():
            return RuntimeStatus(
                "hermes",
                True,
                True,
                "installed",
                "Hermes is installed from the adjacent source repository",
                path=str(home),
                source=str(repo),
                install_state="installed",
            )
        venv_dir = self._hermes_venv_dir()
        log_path = home / "logs" / "managed-install.log"
        env = os.environ.copy()
        try:
            if force and venv_dir.exists():
                shutil.rmtree(venv_dir)
            result = self.command_runner.run(
                [sys.executable, "-m", "venv", str(venv_dir)],
                cwd=None,
                env=env,
                log_path=log_path,
                timeout=180,
            )
            if result.returncode != 0:
                raise RuntimeError(f"venv creation failed with exit code {result.returncode}")
            install_target = self._editable_install_target(repo)
            result = self.command_runner.run(
                [str(self._hermes_venv_python()), "-m", "pip", "install", "-e", install_target],
                cwd=repo,
                env=env,
                log_path=log_path,
                timeout=900,
            )
            if result.returncode != 0:
                raise RuntimeError(f"Hermes source install failed with exit code {result.returncode}")
            self._write_install_marker(repo)
            self._hermes_last_error = ""
            return RuntimeStatus(
                "hermes",
                True,
                True,
                "installed",
                "Hermes is installed from the adjacent source repository",
                path=str(home),
                source=str(repo),
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
        return {
            "manage_hermes": self._managed_hermes_enabled(),
            "repo_path": str(self._effective_hermes_repo()),
            "hermes_home": str(self.config.managed_hermes_home),
            "api_url": api_url,
            "api_host": parsed.hostname or "127.0.0.1",
            "api_port": parsed.port or 8642,
            "model": self._effective_hermes_model(),
            "install_extras": self._effective_install_extras(),
            "startup_wait_seconds": self._effective_startup_wait_seconds(),
            "source_install": True,
            "venv_path": str(self._hermes_venv_dir()),
            "installed": self._managed_venv_ready(),
        }

    def prepare_cognee(self) -> RuntimeStatus:
        if not self.config.manage_cognee:
            return RuntimeStatus("cognee", False, False, "external", "managed Cognee disabled")
        try:
            self._seed_cognee_env()
            repo = self.config.cognee_repo
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
                )
            self._cognee_last_error = ""
            return RuntimeStatus(
                "cognee",
                True,
                True,
                "prepared",
                "Cognee local storage and import path are managed by the platform",
                path=str(self.config.cognee_runtime_dir),
            )
        except Exception as exc:
            self._cognee_last_error = str(exc)
            return RuntimeStatus("cognee", True, False, "error", path=str(self.config.cognee_runtime_dir), error=str(exc))

    def ensure_cognee_ready(self) -> RuntimeStatus:
        with self._lock:
            return self.prepare_cognee()

    def cognee_status(self) -> RuntimeStatus:
        return self.prepare_cognee()

    def close(self) -> None:
        self.stop_hermes()

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

    def _wait_for_hermes(self) -> RuntimeStatus:
        deadline = time.monotonic() + self._effective_startup_wait_seconds()
        while time.monotonic() < deadline:
            status = self.hermes_status(refresh=True)
            if status.available:
                return status
            if self._hermes_process is not None and self._hermes_process.poll() is not None:
                return status
            time.sleep(0.25)
        return self.hermes_status(refresh=True)

    def _install_enterprise_plugin(self, home: Path) -> None:
        source = Path(__file__).resolve().parents[1] / "hermes_plugin" / HERMES_PLUGIN_DIR
        dest = home / "plugins" / HERMES_PLUGIN_DIR
        if not source.exists():
            raise FileNotFoundError(f"enterprise Hermes plugin source not found: {source}")
        if dest.exists():
            shutil.rmtree(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source, dest)

    def _ensure_hermes_config(self, home: Path) -> None:
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
        _write_yaml_mapping(path, data)

    def _write_hermes_env(self, home: Path) -> None:
        env_values = self._hermes_child_values()
        path = home / ".env"
        existing = _read_env_file(path)
        existing.update(env_values)
        _write_env_file(path, existing)

    def _hermes_process_env(self) -> dict[str, str]:
        env = os.environ.copy()
        env.update(self._hermes_child_values())
        env["HERMES_HOME"] = str(self.config.managed_hermes_home)
        repo = self._effective_hermes_repo()
        if repo.exists():
            current = env.get("PYTHONPATH", "")
            parts = [str(repo)] + ([current] if current else [])
            env["PYTHONPATH"] = os.pathsep.join(parts)
        for key in MODEL_SECRET_KEYS:
            value = self.secret_provider(key)
            if value:
                env[key] = value
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
            "ENTERPRISE_PLATFORM_URL": self.config.public_base_url,
            "ENTERPRISE_AGENT_TOOL_TOKEN": self.secret_provider("agent_tool_token") or "",
            "HERMES_ACCEPT_HOOKS": "1",
            "COGNEE_SKIP_CONNECTION_TEST": "true",
        }
        if api_key:
            values["API_SERVER_KEY"] = api_key
        return values

    def _hermes_command(self) -> tuple[list[str], Path | None, str]:
        repo = self._effective_hermes_repo()
        venv_python = self._hermes_venv_python()
        if self._managed_venv_ready():
            return (
                [str(venv_python), "-m", "hermes_cli.main", "gateway", "run", "--replace", "--quiet"],
                repo,
                f"managed source install: {repo}",
            )
        return ([], None, f"Hermes is not installed from source: {repo}")

    def _probe_hermes_health(self) -> bool:
        try:
            request = urllib.request.Request(self._hermes_health_url(), method="GET")
            with urllib.request.urlopen(request, timeout=0.6) as response:
                return 200 <= response.status < 300
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            return False

    def _hermes_health_url(self) -> str:
        parsed = urllib.parse.urlparse(self._effective_hermes_api_url())
        scheme = parsed.scheme or "http"
        netloc = parsed.netloc
        if not netloc:
            return "http://127.0.0.1:8642/health"
        return urllib.parse.urlunparse((scheme, netloc, "/health", "", "", ""))

    def _seed_cognee_env(self) -> None:
        root = self.config.cognee_runtime_dir
        values = {
            "DATA_ROOT_DIRECTORY": str(root / "data"),
            "SYSTEM_ROOT_DIRECTORY": str(root / "system"),
            "CACHE_ROOT_DIRECTORY": str(root / "cache"),
            "COGNEE_LOGS_DIR": str(root / "logs"),
            "COGNEE_SKIP_CONNECTION_TEST": "true",
        }
        for path in values.values():
            if path.startswith("/") or path.startswith("~"):
                Path(path).expanduser().mkdir(parents=True, exist_ok=True)
        for key, value in values.items():
            os.environ.setdefault(key, value)
        selected_key = ""
        for key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "NOUS_API_KEY", "OPENROUTER_API_KEY"):
            value = self.secret_provider(key)
            if value:
                selected_key = value
                break
        current_key = os.getenv("LLM_API_KEY")
        if selected_key and (not current_key or current_key == self._managed_llm_api_key):
            os.environ["LLM_API_KEY"] = selected_key
            self._managed_llm_api_key = selected_key

    def _managed_hermes_enabled(self) -> bool:
        value = self._runtime_setting(HERMES_SETTING_MANAGED)
        if value is None:
            return self.config.manage_hermes
        return str(value).strip().lower() in {"1", "true", "yes", "on"}

    def _effective_hermes_repo(self) -> Path:
        value = self._runtime_setting(HERMES_SETTING_REPO)
        return Path(value).expanduser() if value else self.config.hermes_repo

    def _effective_hermes_api_url(self) -> str:
        return self._runtime_setting(HERMES_SETTING_API_URL) or self.config.hermes_api_url

    def _effective_hermes_model(self) -> str:
        return self._runtime_setting(HERMES_SETTING_MODEL) or self.config.hermes_model

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
        return (
            marker.get("source") == str(self._effective_hermes_repo())
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

    def _write_install_marker(self, repo: Path) -> None:
        marker = {
            "source": str(repo),
            "extras": self._effective_install_extras(),
            "installed_at": now_ts(),
        }
        self._install_marker_path().parent.mkdir(parents=True, exist_ok=True)
        self._install_marker_path().write_text(json.dumps(marker, sort_keys=True), encoding="utf-8")

    def _editable_install_target(self, repo: Path) -> str:
        extras = self._effective_install_extras().strip()
        return f"{repo}[{extras}]" if extras else str(repo)

    def _hermes_source_label(self) -> str:
        return str(self._effective_hermes_repo())


def _module_importable(name: str) -> bool:
    try:
        __import__(name)
        return True
    except Exception:
        return False


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


def _write_yaml_mapping(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        import yaml

        path.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True), encoding="utf-8")
    except Exception:
        enabled = data.get("plugins", {}).get("enabled", [HERMES_PLUGIN_KEY])
        lines = ["plugins:", "  enabled:"]
        lines.extend(f"    - {item}" for item in enabled)
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")


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
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [f"{key}={_quote_env(value)}" for key, value in sorted(values.items())]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _quote_env(value: str) -> str:
    safe = value.replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')
    return f'"{safe}"'


def _unquote_env(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] == '"':
        return value[1:-1].replace("\\n", "\n").replace('\\"', '"').replace("\\\\", "\\")
    return value
