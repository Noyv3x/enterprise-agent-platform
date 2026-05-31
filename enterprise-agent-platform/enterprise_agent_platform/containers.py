from __future__ import annotations

import hashlib
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .config import PlatformConfig
from .db import Database, now_ts


@dataclass(frozen=True)
class PrivateContainer:
    user_id: int
    session_id: str
    container_name: str
    container_id: str
    container_status: str
    workspace_path: str
    backend: str

    def to_dict(self) -> dict:
        return {
            "user_id": self.user_id,
            "session_id": self.session_id,
            "container_name": self.container_name,
            "container_id": self.container_id,
            "container_status": self.container_status,
            "workspace_path": self.workspace_path,
            "backend": self.backend,
        }


class ContainerManager:
    def __init__(self, config: PlatformConfig, db: Database, *, runner=None):
        self.config = config
        self.db = db
        # Injectable for tests; defaults to the real subprocess.run.
        self._run = runner or subprocess.run
        self.config.workspace_dir.mkdir(parents=True, exist_ok=True)

    def ensure_private_container(
        self,
        *,
        user_id: int,
        username: str,
        secrets_env: dict[str, str],
    ) -> PrivateContainer:
        session_id = f"enterprise-private-u{user_id}"
        workspace = self.config.workspace_dir / f"user-{user_id}"
        workspace.mkdir(parents=True, exist_ok=True)
        existing = self.db.query_one("SELECT * FROM private_agents WHERE user_id = ?", (user_id,))
        backend = self._resolve_backend()
        if backend == "docker":
            container = self._ensure_docker(user_id, username, workspace, secrets_env, existing)
        else:
            container = PrivateContainer(
                user_id=user_id,
                session_id=session_id,
                container_name="",
                container_id="",
                container_status="local-workspace",
                workspace_path=str(workspace),
                backend="local",
            )
        ts = now_ts()
        self.db.execute(
            """
            INSERT INTO private_agents(
                user_id, session_id, container_name, container_id, container_status,
                workspace_path, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                session_id=excluded.session_id,
                container_name=excluded.container_name,
                container_id=excluded.container_id,
                container_status=excluded.container_status,
                workspace_path=excluded.workspace_path,
                updated_at=excluded.updated_at
            """,
            (
                user_id,
                container.session_id,
                container.container_name,
                container.container_id,
                container.container_status,
                container.workspace_path,
                ts,
                ts,
            ),
        )
        return container

    def get_private_container(self, user_id: int) -> PrivateContainer | None:
        row = self.db.query_one("SELECT * FROM private_agents WHERE user_id = ?", (user_id,))
        if not row:
            return None
        backend = "docker" if row["container_name"] else "local"
        return PrivateContainer(
            user_id=user_id,
            session_id=row["session_id"],
            container_name=row["container_name"],
            container_id=row["container_id"],
            container_status=row["container_status"],
            workspace_path=row["workspace_path"],
            backend=backend,
        )

    def remove_private_container(self, user_id: int) -> None:
        """Tear down a user's sandbox and forget it.

        Best-effort: force-removes the docker container (a single ``docker rm
        -f`` both stops and deletes it) and always clears the ``private_agents``
        row so a re-activated user gets a fresh container/name. Docker errors
        are swallowed (with a timeout) so this never raises into the
        deactivation/admin flow that calls it.
        """
        row = self.db.query_one("SELECT * FROM private_agents WHERE user_id = ?", (user_id,))
        if row and row["container_name"]:
            try:
                self._run(
                    ["docker", "rm", "-f", row["container_name"]],
                    check=False,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=30,
                )
            except Exception:
                # Never let a failed teardown block the caller; the row is
                # cleared below regardless so state stays consistent.
                pass
        self.db.execute("DELETE FROM private_agents WHERE user_id = ?", (user_id,))

    def reap_idle_containers(self, *, idle_hours: float | None = None) -> int:
        """Reclaim per-user docker containers that have been idle (no private
        message refreshing ``updated_at``) for longer than ``idle_hours``.

        This catches users who simply stopped messaging without being
        deactivated. Returns the number of containers torn down. Best-effort:
        individual failures are swallowed so one bad container cannot stall the
        sweep. Disabled when the resolved idle threshold is <= 0.
        """
        if idle_hours is None:
            try:
                idle_hours = float(os.getenv("ENTERPRISE_CONTAINER_IDLE_HOURS", "0") or "0")
            except ValueError:
                idle_hours = 0.0
        if not idle_hours or idle_hours <= 0:
            return 0
        cutoff = now_ts() - int(idle_hours * 3600)
        rows = self.db.query(
            "SELECT user_id FROM private_agents WHERE container_name != '' AND updated_at < ?",
            (cutoff,),
        )
        reaped = 0
        for row in rows:
            try:
                self.remove_private_container(int(row["user_id"]))
                reaped += 1
            except Exception:
                continue
        return reaped

    def _resolve_backend(self) -> str:
        if self.config.container_backend == "local":
            return "local"
        if self.config.container_backend == "docker":
            return "docker"
        try:
            self._run(
                ["docker", "info"],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=4,
            )
            return "docker"
        except Exception:
            return "local"

    def _hardened_user_flag(self) -> list[str]:
        """Run the sandbox as the same non-root identity that owns the
        bind-mounted workspace, so files written into /workspace are not
        root-owned on the host and a container escape does not start as uid 0.

        Operators can override with ENTERPRISE_CONTAINER_USER (e.g. ``""`` to
        disable, or ``1000:1000``); on non-POSIX hosts os.getuid is absent and
        we simply omit the flag.
        """
        override = os.getenv("ENTERPRISE_CONTAINER_USER")
        if override is not None:
            override = override.strip()
            return ["--user", override] if override else []
        getuid = getattr(os, "getuid", None)
        getgid = getattr(os, "getgid", None)
        if getuid is None or getgid is None:
            return []
        uid = getuid()
        # Running as root on the host gains nothing from --user 0:0, so skip it
        # and let the image's own user apply.
        if uid == 0:
            return []
        return ["--user", f"{uid}:{getgid()}"]

    def _hardening_flags(self) -> list[str]:
        """Restrict the per-user agent sandbox so a compromised agent has a
        narrow host foothold: drop all capabilities, forbid privilege
        escalation, run as a non-root user, and cap pids/memory (incl. swap)/cpu.

        Network is restricted only when hardening is enabled: it defaults to a
        deny-by-default value (``none``) unless an explicit network is
        configured via ``container_network`` / ``ENTERPRISE_CONTAINER_NETWORK``
        (or ``ENTERPRISE_CONTAINER_HARDEN_NETWORK`` to change the hardened
        default). A read-only rootfs with tmpfs scratch dirs can be enabled via
        ``ENTERPRISE_CONTAINER_READONLY`` for workloads that do not write to the
        image (it defaults off because ``pip install`` and similar need a
        writable rootfs).
        """
        flags: list[str] = []
        if self.config.container_harden:
            flags += ["--cap-drop", "ALL", "--security-opt", "no-new-privileges"]
            flags += self._hardened_user_flag()
            if self.config.container_pids_limit and self.config.container_pids_limit > 0:
                flags += ["--pids-limit", str(int(self.config.container_pids_limit))]
            if self.config.container_memory:
                flags += ["--memory", self.config.container_memory]
                # Pin total memory+swap to the RAM cap so the limit cannot be
                # bypassed by swapping. ENTERPRISE_CONTAINER_MEMORY_SWAP lets
                # operators deliberately grant swap headroom (or "-1" for
                # unlimited swap, matching docker's semantics).
                swap = os.getenv("ENTERPRISE_CONTAINER_MEMORY_SWAP", "").strip() or self.config.container_memory
                flags += ["--memory-swap", swap]
            # Apply a CPU cap by default (1.0) so the documented cap actually
            # holds. To DISABLE it, set container_cpus (ENTERPRISE_CONTAINER_CPUS)
            # or ENTERPRISE_CONTAINER_CPUS_DEFAULT to the literal "0"/"0.0"; an
            # empty value falls back to the 1.0 default rather than disabling.
            cpus = self.config.container_cpus or os.getenv("ENTERPRISE_CONTAINER_CPUS_DEFAULT", "1.0").strip()
            if cpus and cpus not in {"0", "0.0"}:
                flags += ["--cpus", cpus]
            # Optional writable-layer disk quota. Off by default because
            # --storage-opt size= only works on specific storage drivers
            # (overlay2 on xfs with pquota, devicemapper) and otherwise makes
            # `docker run` fail; operators opt in by setting a size string such
            # as "2G".
            storage_size = os.getenv("ENTERPRISE_CONTAINER_STORAGE_SIZE", "").strip()
            if storage_size:
                flags += ["--storage-opt", f"size={storage_size}"]
            if self._env_truthy("ENTERPRISE_CONTAINER_READONLY", False):
                flags += ["--read-only"]
                # Provide writable scratch space so the keep-alive process and
                # common tooling (tmp, pip cache under HOME) still function.
                for mount in ("/tmp", "/run", "/home"):
                    flags += ["--tmpfs", f"{mount}:rw,nosuid,nodev"]
            network = (
                self.config.container_network
                or os.getenv("ENTERPRISE_CONTAINER_HARDEN_NETWORK", "none").strip()
                or "none"
            )
            flags += ["--network", network]
        elif self.config.container_network:
            flags += ["--network", self.config.container_network]
        return flags

    @staticmethod
    def _env_truthy(name: str, default: bool) -> bool:
        raw = os.getenv(name)
        if raw is None:
            return default
        return raw.strip().lower() in {"1", "true", "yes", "on"}

    def _ensure_docker(
        self,
        user_id: int,
        username: str,
        workspace: Path,
        secrets_env: dict[str, str],
        existing: dict | None,
    ) -> PrivateContainer:
        session_id = f"enterprise-private-u{user_id}"
        name = existing.get("container_name") if existing else ""
        if not name:
            suffix = hashlib.sha256(f"{user_id}:{username}".encode("utf-8")).hexdigest()[:10]
            name = f"enterprise-agent-u{user_id}-{suffix}"

        inspect = self._run(
            ["docker", "inspect", "-f", "{{.Id}} {{.State.Status}}", name],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=8,
        )
        if inspect.returncode == 0:
            parts = inspect.stdout.strip().split(maxsplit=1)
            container_id = parts[0] if parts else ""
            status = parts[1] if len(parts) > 1 else "unknown"
            if status != "running":
                started = self._run(
                    ["docker", "start", name],
                    check=False,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    text=True,
                    timeout=15,
                )
                # Reflect reality instead of asserting "running": a failed start
                # (image gone, daemon error, OOM on prior run) must not be
                # reported to the agent prompt/UI as a live container.
                if started.returncode == 0:
                    status = "running"
                # else: keep the inspected status (e.g. "exited"/"created").
            return PrivateContainer(user_id, session_id, name, container_id, status, str(workspace), "docker")

        cmd = [
            "docker",
            "run",
            "-d",
            "--name",
            name,
            "-v",
            f"{workspace.resolve()}:/workspace",
            "-w",
            "/workspace",
            *self._hardening_flags(),
        ]
        for key, value in sorted(secrets_env.items()):
            if value:
                cmd.extend(["-e", f"{key}={value}"])
        cmd.extend([self.config.container_image, "tail", "-f", "/dev/null"])
        env = os.environ.copy()
        created = self._run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=60, env=env)
        container_id = created.stdout.strip()
        return PrivateContainer(user_id, session_id, name, container_id, "running", str(workspace), "docker")
