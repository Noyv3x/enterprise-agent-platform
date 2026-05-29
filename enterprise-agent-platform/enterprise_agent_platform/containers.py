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

    def _hardening_flags(self) -> list[str]:
        """Restrict the per-user agent sandbox so a compromised agent has a
        narrow host foothold: drop all capabilities, forbid privilege
        escalation, and cap pids/memory/cpu/network."""
        flags: list[str] = []
        if self.config.container_harden:
            flags += ["--cap-drop", "ALL", "--security-opt", "no-new-privileges"]
            if self.config.container_pids_limit and self.config.container_pids_limit > 0:
                flags += ["--pids-limit", str(int(self.config.container_pids_limit))]
            if self.config.container_memory:
                flags += ["--memory", self.config.container_memory]
            if self.config.container_cpus:
                flags += ["--cpus", self.config.container_cpus]
        if self.config.container_network:
            flags += ["--network", self.config.container_network]
        return flags

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
                self._run(["docker", "start", name], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
                status = "running"
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
