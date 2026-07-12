from __future__ import annotations

import argparse
import getpass
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Protocol

from .config import PlatformConfig
from .service import EnterpriseService


DEFAULT_SERVICE_NAME = "enterprise-agent-platform.service"
DEFAULT_PIP_INSTALL_ATTEMPTS = 3
DEFAULT_PIP_NETWORK_RETRIES = 8
DEFAULT_PIP_TIMEOUT_SECONDS = 120
DEFAULT_SERVICE_READY_TIMEOUT_SECONDS = 60
DEFAULT_SERVICE_STOP_TIMEOUT_SECONDS = 120


class DeploymentError(RuntimeError):
    pass


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
    hermes_repo: Path
    cognee_repo: Path
    firecrawl_repo: Path
    venv_dir: Path
    data_dir: Path
    service_dir: Path
    service_name: str = DEFAULT_SERVICE_NAME

    @classmethod
    def from_root(cls, root: Path, *, data_dir: Path | None = None, service_name: str = DEFAULT_SERVICE_NAME) -> "DeploymentPaths":
        clean_root = root.expanduser().resolve()
        return cls(
            root=clean_root,
            platform_dir=clean_root / "enterprise-agent-platform",
            hermes_repo=clean_root / "hermes-agent",
            cognee_repo=clean_root / "cognee",
            firecrawl_repo=clean_root / "firecrawl",
            venv_dir=clean_root / ".venv",
            data_dir=(data_dir or clean_root / "enterprise-agent-platform" / "data").expanduser().resolve(),
            service_dir=Path(os.getenv("XDG_CONFIG_HOME", "~/.config")).expanduser() / "systemd" / "user",
            service_name=service_name,
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


@dataclass(frozen=True)
class DeploymentResult:
    mode: str
    url: str
    service_path: str = ""
    service_started: bool = False
    foreground_started: bool = False


class DeploymentManager:
    def __init__(self, paths: DeploymentPaths, *, runner: CommandRunner | None = None):
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
        self.ensure_layout()
        if not skip_submodules:
            self.ensure_submodules()
        self.ensure_source_repos()
        self.ensure_platform_venv()

        if mode == "prepare":
            # No service is (re)started in this mode, so the runtime must be
            # prepared here from the deploy process.
            if prepare_runtime:
                self.prepare_platform_runtime(host=host, port=port)
            return DeploymentResult(mode=mode, url=self.effective_public_url(host, port))
        if mode == "service":
            service_path = self.install_user_service(host=host, port=port)
            return DeploymentResult(mode=mode, url=self.effective_public_url(host, port), service_path=str(service_path), service_started=True)
        if mode == "foreground":
            # The foreground server prepares the runtime on startup in its own
            # single process, so no separate prepare step is needed here.
            self.run_foreground(host=host, port=port)
            return DeploymentResult(mode=mode, url=self.effective_public_url(host, port), foreground_started=True)
        if mode != "auto":
            raise DeploymentError(f"unknown deploy mode: {mode}")

        if self.user_systemd_available():
            service_path = self.install_user_service(host=host, port=port)
            return DeploymentResult(mode="service", url=self.effective_public_url(host, port), service_path=str(service_path), service_started=True)
        self.run_foreground(host=host, port=port)
        return DeploymentResult(mode="foreground", url=self.effective_public_url(host, port), foreground_started=True)

    def ensure_python_version(self) -> None:
        if sys.version_info < (3, 11):
            raise DeploymentError("Python 3.11 or newer is required")

    def ensure_layout(self) -> None:
        if not (self.paths.platform_dir / "enterprise_agent_platform").is_dir():
            raise DeploymentError(f"platform source not found: {self.paths.platform_dir}")

    def ensure_submodules(self) -> None:
        if not (self.paths.root / ".git").exists():
            return
        if not shutil.which("git"):
            raise DeploymentError("git is required to initialize submodules")
        self.runner.run(["git", "submodule", "update", "--init", "--recursive"], cwd=self.paths.root, timeout=1800)

    def ensure_source_repos(self) -> None:
        missing = []
        if not (self.paths.hermes_repo / "pyproject.toml").exists():
            missing.append(str(self.paths.hermes_repo))
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
        env_values = runtime_env(self.paths, host=host, port=port)
        effective_host = env_values["ENTERPRISE_PLATFORM_HOST"]
        effective_port = int(env_values["ENTERPRISE_PLATFORM_PORT"])
        public_base_url = env_values["ENTERPRISE_PUBLIC_BASE_URL"].rstrip("/")
        config = PlatformConfig.from_env(self.paths.root)
        config = replace(
            config,
            data_dir=self.paths.data_dir,
            host=effective_host,
            port=effective_port,
            public_base_url=public_base_url,
            trust_forwarded_headers=env_values.get("ENTERPRISE_TRUSTED_PROXY", "").strip().lower() in {"1", "true", "yes", "on"},
            token_ttl_seconds=int(env_values.get("ENTERPRISE_SESSION_TTL_SECONDS") or config.token_ttl_seconds),
            hermes_repo=self.paths.hermes_repo,
            cognee_repo=self.paths.cognee_repo,
            firecrawl_repo=self.paths.firecrawl_repo,
            hermes_home=self.paths.data_dir / "runtimes" / "hermes",
        )
        service = EnterpriseService(config, autostart_runtime=False)
        try:
            return service.runtimes.status(refresh=False)
        finally:
            service.close()

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
        """Verify the unit is active (and ideally answering HTTP) after restart.

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
            print(
                f"WARNING: the platform unit is active but {self.public_url(host, port)} did "
                "not respond yet. Check './deploy.sh status' and './deploy.sh logs'.",
                file=sys.stderr,
                flush=True,
            )

    def _wait_for_service_http(self, *, host: str, port: int, deadline: float) -> bool:
        # Supplementary HTTP readiness probe. The systemd is-active check above is
        # the authoritative gate; this only confirms the server is answering.
        # Share the full readiness window: runtime prepare (venv/install, plugin
        # copy) runs before the socket is bound, so a hard 5s cap routinely fired
        # a spurious "did not respond" warning on a perfectly healthy deploy.
        probe_deadline = deadline
        url = self.public_url(host, port)
        while True:
            if _probe_http_ready(url):
                return True
            if time.monotonic() >= probe_deadline:
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
        "ENTERPRISE_HERMES_REPO": str(paths.hermes_repo),
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
    env_lines = [f"Environment={_systemd_quote(f'{key}={value}')}" for key, value in env.items()]
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
        *env_lines,
        f"ExecStart={exec_start}",
        "Restart=on-failure",
        "RestartSec=5",
        # Give the platform room to bring managed runtimes (Hermes/Firecrawl)
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


def _probe_http_ready(base_url: str) -> bool:
    base = base_url.rstrip("/")
    if not base:
        return False
    for path in ("/", "/healthz", "/login"):
        try:
            request = urllib.request.Request(f"{base}{path}", method="GET")
            with urllib.request.urlopen(request, timeout=1.0) as response:
                if 200 <= response.status < 500:
                    return True
        except urllib.error.HTTPError as exc:
            if 400 <= exc.code < 500:
                return True
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            continue
    return False


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
    parser.add_argument("--data", default=os.getenv("ENTERPRISE_PLATFORM_DATA", ""))
    parser.add_argument("--mode", choices=("auto", "service", "foreground", "prepare"), default=os.getenv("ENTERPRISE_DEPLOY_MODE", "auto"))
    parser.add_argument("--service-name", default=os.getenv("ENTERPRISE_SERVICE_NAME", DEFAULT_SERVICE_NAME))
    parser.add_argument("--skip-submodules", action="store_true")
    parser.add_argument("--skip-runtime-prepare", action="store_true")


def bootstrap_from_args(args: argparse.Namespace) -> DeploymentResult:
    root = Path(args.root)
    data_dir = Path(args.data).expanduser() if args.data else None
    paths = DeploymentPaths.from_root(root, data_dir=data_dir, service_name=args.service_name)
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
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _systemd_path_value(path: Path) -> str:
    return str(path).replace("\\", "\\\\").replace(" ", "\\x20").replace("%", "%%")


if __name__ == "__main__":
    main()
