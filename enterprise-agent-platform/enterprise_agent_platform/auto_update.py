from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Protocol


DEFAULT_SERVICE_NAME = "enterprise-agent-platform.service"


class AutoUpdateService(Protocol):
    def auto_update_enabled(self) -> bool:
        ...

    def auto_update_interval_seconds(self) -> int:
        ...

    def auto_update_remote(self) -> str:
        ...

    def auto_update_branch(self) -> str:
        ...


class AutoUpdateManager:
    """Watch the upstream git branch and hand updates to deploy.sh.

    The manager deliberately does not implement deployment itself. It only
    verifies that a fast-forward update is available and then launches the
    existing `deploy.sh update` path, preserving its rollback behavior.
    """

    def __init__(
        self,
        service: AutoUpdateService,
        *,
        repo_root: Path | None = None,
        runner=None,
        launcher=None,
    ):
        self.service = service
        self.repo_root = (repo_root or discover_repo_root()).expanduser().resolve()
        self.deploy_script = self.repo_root / "deploy.sh"
        self._runner = runner or self._run_command
        self._launcher = launcher or self._launch_update_command
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._pending_reason = "startup"
        self._status: dict[str, Any] = {
            "running": False,
            "in_progress": False,
            "last_check_at": None,
            "last_update_requested_at": None,
            "last_trigger": "",
            "last_error": "",
            "current_revision": "",
            "remote_revision": "",
            "remote": "",
            "branch": "",
            "dirty": False,
            "dirty_summary": "",
            "update_available": False,
            "update_started": False,
            "update_command": "",
            "repo_root": str(self.repo_root),
            "deploy_script": str(self.deploy_script),
        }

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="auto-update-listener", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=2)
        self._thread = None
        with self._lock:
            self._status["running"] = False
            self._status["in_progress"] = False

    def trigger(self, reason: str = "manual") -> dict[str, Any]:
        self.start()
        with self._lock:
            self._pending_reason = reason or "manual"
        self._wake.set()
        return self.status()

    def status(self) -> dict[str, Any]:
        with self._lock:
            status = dict(self._status)
        status.update(
            {
                "enabled": bool(self.service.auto_update_enabled()),
                "interval_seconds": int(self.service.auto_update_interval_seconds()),
                "configured_remote": self.service.auto_update_remote(),
                "configured_branch": self.service.auto_update_branch(),
                "thread_alive": bool(self._thread and self._thread.is_alive()),
            }
        )
        return status

    def check_once(self, reason: str = "manual") -> dict[str, Any]:
        if not self._lock.acquire(blocking=False):
            return self.status()
        try:
            self._status.update(
                {
                    "running": bool(self._thread and self._thread.is_alive()),
                    "in_progress": True,
                    "last_check_at": int(time.time()),
                    "last_trigger": reason,
                    "last_error": "",
                    "update_started": False,
                    "update_command": "",
                }
            )
            result = self._inspect_upstream()
            self._status.update(result)
            if result["dirty"]:
                self._status["last_error"] = "working tree has local changes; auto update skipped"
                return dict(self._status)
            if result["update_available"]:
                command = self._launcher(reason)
                self._status.update(
                    {
                        "last_update_requested_at": int(time.time()),
                        "update_started": True,
                        "update_command": " ".join(command),
                    }
                )
            return dict(self._status)
        except Exception as exc:
            self._status["last_error"] = str(exc)
            return dict(self._status)
        finally:
            self._status["in_progress"] = False
            self._lock.release()

    def _loop(self) -> None:
        with self._lock:
            self._status["running"] = True
        while not self._stop.is_set():
            enabled = bool(self.service.auto_update_enabled())
            interval = int(self.service.auto_update_interval_seconds())
            wait_seconds = max(5, interval if enabled else 60)
            woke = self._wake.wait(wait_seconds)
            self._wake.clear()
            if self._stop.is_set():
                break
            if not enabled and not woke:
                continue
            if not self.service.auto_update_enabled():
                continue
            with self._lock:
                reason = self._pending_reason if woke else "poll"
                self._pending_reason = "poll"
            self.check_once(reason=reason)
        with self._lock:
            self._status["running"] = False
            self._status["in_progress"] = False

    def _inspect_upstream(self) -> dict[str, Any]:
        if not (self.repo_root / ".git").exists():
            raise RuntimeError(f"git repository not found: {self.repo_root}")
        remote = _safe_git_name(self.service.auto_update_remote() or "origin", "remote")
        branch = self.service.auto_update_branch().strip() or self._git_stdout(["git", "branch", "--show-current"])
        branch = _safe_git_name(branch or "main", "branch")
        dirty_summary = self._git_stdout(["git", "status", "--porcelain"])
        current = self._git_stdout(["git", "rev-parse", "HEAD"])
        self._git(["git", "fetch", "--quiet", "--recurse-submodules", remote, branch], timeout=120)
        remote_ref = f"{remote}/{branch}"
        remote_revision = self._git_stdout(["git", "rev-parse", remote_ref])
        if current == remote_revision:
            update_available = False
        else:
            ancestor = self._git(["git", "merge-base", "--is-ancestor", current, remote_revision], check=False)
            if ancestor.returncode != 0:
                raise RuntimeError(f"local HEAD is not a fast-forward ancestor of {remote_ref}")
            update_available = True
        return {
            "current_revision": current,
            "remote_revision": remote_revision,
            "remote": remote,
            "branch": branch,
            "dirty": bool(dirty_summary.strip()),
            "dirty_summary": dirty_summary.strip(),
            "update_available": update_available,
        }

    def _launch_update_command(self, reason: str) -> list[str]:
        if not self.deploy_script.exists():
            raise RuntimeError(f"deploy script not found: {self.deploy_script}")
        handoff = self._deployment_handoff()
        systemd_managed = _running_under_systemd()
        systemd_tools = bool(shutil.which("systemd-run") and shutil.which("systemctl"))
        user_systemd = systemd_tools and _user_systemd_available(self._runner)
        if user_systemd:
            systemd_managed = systemd_managed or _user_service_active(
                self._runner,
                handoff["ENTERPRISE_SERVICE_NAME"],
            )
        if user_systemd:
            unit = f"enterprise-agent-platform-auto-update-{time.time_ns()}-{os.getpid()}"
            command = [
                "systemd-run",
                "--user",
                "--collect",
                "--service-type=exec",
                f"--unit={unit}",
                f"--working-directory={self.repo_root}",
                *[f"--setenv={key}={value}" for key, value in handoff.items()],
                str(self.deploy_script),
                "update",
                "--data",
                handoff["ENTERPRISE_PLATFORM_DATA"],
                "--service-name",
                handoff["ENTERPRISE_SERVICE_NAME"],
                "--host",
                handoff["ENTERPRISE_PLATFORM_HOST"],
                "--port",
                handoff["ENTERPRISE_PLATFORM_PORT"],
            ]
            result = self._runner(command, cwd=self.repo_root, timeout=30, check=False)
            if result.returncode == 0:
                return command
            if systemd_managed:
                detail = str(getattr(result, "stderr", "") or getattr(result, "stdout", "") or "").strip()
                raise RuntimeError(
                    "could not launch auto update in an independent systemd unit"
                    + (f": {detail}" if detail else "")
                )
        elif systemd_managed:
            raise RuntimeError(
                "auto update is running under systemd, but an independent user transient unit is unavailable"
            )

        # A detached child is safe only for a standalone/foreground process.
        # A child launched from a systemd service remains in the service cgroup
        # and can be killed by the restart that completes its own update.
        log_path = Path(handoff["ENTERPRISE_PLATFORM_DATA"]) / "logs" / "auto-update.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        command = [
            str(self.deploy_script),
            "update",
            "--data",
            handoff["ENTERPRISE_PLATFORM_DATA"],
            "--service-name",
            handoff["ENTERPRISE_SERVICE_NAME"],
            "--host",
            handoff["ENTERPRISE_PLATFORM_HOST"],
            "--port",
            handoff["ENTERPRISE_PLATFORM_PORT"],
        ]
        with log_path.open("ab") as log:
            log.write(f"\n[{int(time.time())}] auto update triggered by {reason}\n".encode("utf-8"))
            subprocess.Popen(command, cwd=str(self.repo_root), stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        return command

    def _deployment_handoff(self) -> dict[str, str]:
        config = getattr(self.service, "config", None)
        data_dir = Path(
            getattr(config, "data_dir", self.repo_root / "enterprise-agent-platform" / "data")
        ).expanduser().resolve()
        service_name = str(os.getenv("ENTERPRISE_SERVICE_NAME", DEFAULT_SERVICE_NAME)).strip()
        host = str(getattr(config, "host", os.getenv("ENTERPRISE_PLATFORM_HOST", "127.0.0.1"))).strip()
        try:
            port = int(getattr(config, "port", os.getenv("ENTERPRISE_PLATFORM_PORT", "8765")))
        except (TypeError, ValueError) as exc:
            raise RuntimeError("invalid platform port for auto-update handoff") from exc
        if (
            len(service_name) > 255
            or not re.fullmatch(r"[A-Za-z0-9_.@:-]+\.service", service_name)
            or service_name.startswith((".", "-"))
        ):
            raise RuntimeError(f"invalid systemd service name for auto-update handoff: {service_name!r}")
        if not host or any(char in host for char in "\x00\r\n"):
            raise RuntimeError("invalid platform host for auto-update handoff")
        if not 1 <= port <= 65535:
            raise RuntimeError("invalid platform port for auto-update handoff")
        values = {
            "ENTERPRISE_PLATFORM_DATA": str(data_dir),
            "ENTERPRISE_SERVICE_NAME": service_name,
            "ENTERPRISE_PLATFORM_HOST": host,
            "ENTERPRISE_PLATFORM_PORT": str(port),
        }
        if any(any(char in value for char in "\x00\r\n") for value in values.values()):
            raise RuntimeError("invalid value in auto-update deployment handoff")
        return values

    def _git(self, cmd: list[str], *, timeout: float = 30, check: bool = True) -> subprocess.CompletedProcess:
        return self._runner(cmd, cwd=self.repo_root, timeout=timeout, check=check)

    def _git_stdout(self, cmd: list[str], *, timeout: float = 30) -> str:
        return str(self._git(cmd, timeout=timeout).stdout or "").strip()

    @staticmethod
    def _run_command(
        cmd: list[str],
        *,
        cwd: Path | None = None,
        timeout: float | None = None,
        check: bool = True,
    ) -> subprocess.CompletedProcess:
        result = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd else None,
            timeout=timeout,
            text=True,
            capture_output=True,
            check=False,
        )
        if check and result.returncode != 0:
            detail = (result.stderr or result.stdout or "").strip()
            raise RuntimeError(f"command failed ({result.returncode}): {' '.join(cmd)}{': ' + detail if detail else ''}")
        return result


def discover_repo_root() -> Path:
    here = Path(__file__).resolve()
    candidates = [here.parents[2], Path.cwd(), Path.cwd().parent]
    for candidate in candidates:
        if (candidate / "deploy.sh").exists() and (candidate / ".git").exists():
            return candidate
    return here.parents[2]


def _safe_git_name(value: str, label: str) -> str:
    clean = value.strip()
    if not clean or not re.fullmatch(r"[A-Za-z0-9._/-]{1,120}", clean) or clean.startswith("-") or ".." in clean:
        raise RuntimeError(f"invalid git {label}: {value!r}")
    return clean


def _user_systemd_available(runner) -> bool:
    result = runner(["systemctl", "--user", "show-environment"], cwd=None, timeout=20, check=False)
    return result.returncode == 0


def _user_service_active(runner, service_name: str) -> bool:
    result = runner(
        ["systemctl", "--user", "is-active", "--quiet", service_name],
        cwd=None,
        timeout=20,
        check=False,
    )
    return result.returncode == 0


def _running_under_systemd() -> bool:
    return any(os.getenv(name) for name in ("INVOCATION_ID", "JOURNAL_STREAM", "SYSTEMD_EXEC_PID"))
