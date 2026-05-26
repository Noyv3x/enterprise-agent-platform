from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Protocol

from .config import PlatformConfig
from .service import EnterpriseService


DEFAULT_SERVICE_NAME = "enterprise-agent-platform.service"
DEFAULT_PIP_INSTALL_ATTEMPTS = 3
DEFAULT_PIP_NETWORK_RETRIES = 8
DEFAULT_PIP_TIMEOUT_SECONDS = 120


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
        if prepare_runtime:
            self.prepare_platform_runtime(host=host, port=port)

        if mode == "prepare":
            return DeploymentResult(mode=mode, url=self.public_url(host, port))
        if mode == "service":
            service_path = self.install_user_service(host=host, port=port)
            return DeploymentResult(mode=mode, url=self.public_url(host, port), service_path=str(service_path), service_started=True)
        if mode == "foreground":
            self.run_foreground(host=host, port=port)
            return DeploymentResult(mode=mode, url=self.public_url(host, port), foreground_started=True)
        if mode != "auto":
            raise DeploymentError(f"unknown deploy mode: {mode}")

        if self.user_systemd_available():
            service_path = self.install_user_service(host=host, port=port)
            return DeploymentResult(mode="service", url=self.public_url(host, port), service_path=str(service_path), service_started=True)
        self.run_foreground(host=host, port=port)
        return DeploymentResult(mode="foreground", url=self.public_url(host, port), foreground_started=True)

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
        public_base_url = os.getenv("ENTERPRISE_PUBLIC_BASE_URL", self.public_url(host, port)).rstrip("/")
        config = PlatformConfig.from_env(self.paths.root)
        config = replace(
            config,
            data_dir=self.paths.data_dir,
            host=host,
            port=port,
            public_base_url=public_base_url,
            hermes_repo=self.paths.hermes_repo,
            cognee_repo=self.paths.cognee_repo,
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
        self.runner.run(["systemctl", "--user", "enable", "--now", self.paths.service_name], timeout=60)
        return self.paths.service_path

    def run_foreground(self, *, host: str, port: int) -> None:
        env = os.environ.copy()
        env.update(runtime_env(self.paths, host=host, port=port))
        self.runner.run(
            [str(self.paths.platform_cli), "serve", "--host", host, "--port", str(port), "--data", str(self.paths.data_dir)],
            cwd=self.paths.platform_dir,
            env=env,
            timeout=None,
        )

    @staticmethod
    def public_url(host: str, port: int) -> str:
        return os.getenv("ENTERPRISE_PUBLIC_BASE_URL", f"http://{host}:{port}").rstrip("/")


def runtime_env(paths: DeploymentPaths, *, host: str, port: int) -> dict[str, str]:
    return {
        "ENTERPRISE_PLATFORM_DATA": str(paths.data_dir),
        "ENTERPRISE_HERMES_REPO": str(paths.hermes_repo),
        "ENTERPRISE_COGNEE_REPO": str(paths.cognee_repo),
        "ENTERPRISE_PLATFORM_HOST": host,
        "ENTERPRISE_PLATFORM_PORT": str(port),
        "ENTERPRISE_PUBLIC_BASE_URL": DeploymentManager.public_url(host, port),
    }


def user_service_unit(paths: DeploymentPaths, *, host: str, port: int) -> str:
    env_lines = [f"Environment={_systemd_quote(f'{key}={value}')}" for key, value in runtime_env(paths, host=host, port=port).items()]
    exec_start = " ".join(
        [
            _systemd_quote(str(paths.platform_cli)),
            "serve",
            "--host",
            _systemd_quote(host),
            "--port",
            str(port),
            "--data",
            _systemd_quote(str(paths.data_dir)),
        ]
    )
    lines = [
        "[Unit]",
        "Description=Enterprise Agent Platform",
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
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
    ]
    return "\n".join(lines)


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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Bootstrap and manage Enterprise Agent Platform deployment")
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
        print(f"Enterprise Agent Platform service started: {result.url}")
        print(f"Service file: {result.service_path}")
    elif result.mode == "prepare":
        print(f"Enterprise Agent Platform prepared: {result.url}")
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
