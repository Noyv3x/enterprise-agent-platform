from __future__ import annotations

import json
import os
import re
import secrets
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import PlatformConfig
from .db import Database, now_ts
from .secure_fs import ensure_private_directory, write_private_file_exclusive


_LEGACY_CONTAINER_NAME_RE = re.compile(r"enterprise-agent-u[1-9][0-9]*-[0-9a-f]{10}")
_MAX_SESSION_ID_LENGTH = 512
_LEGACY_CHANNEL_SESSION_PREFIX = "hermes_session:channel:"


@dataclass(frozen=True)
class AgentExecutionScope:
    """Stable host-execution identity for one private or channel Agent.

    A scope separates normal file, memory, session and process state.  It is a
    logical product boundary, not an OS security sandbox: every scope executes
    as the same trusted host service account.
    """

    scope_key: str
    scope_type: str
    scope_id: str
    session_id: str
    lifecycle_id: str
    workspace_path: str

    def to_execution_dict(self) -> dict[str, Any]:
        return {
            "backend": "host",
            "isolation": "logical",
            "scope_key": self.scope_key,
            "session_id": self.session_id,
            "lifecycle_id": self.lifecycle_id,
            "workspace_path": self.workspace_path,
            "approval_policy": "sensitive",
        }


class AgentScopeManager:
    """Own stable Agent workspaces and sessions without provisioning Docker.

    The only Docker operation retained here is a one-time, tightly constrained
    cleanup of containers recorded by installations that predate host
    execution.  Cleanup progress is stored in ``agent_scopes`` and is never
    performed by a background reaper.
    """

    def __init__(self, config: PlatformConfig, db: Database, *, cleanup_runner=None):
        self.config = config
        self.db = db
        self._cleanup_runner = cleanup_runner or subprocess.run
        self._workspace_root = self.config.workspace_dir.expanduser()
        ensure_private_directory(self._workspace_root)
        self._workspace_root = self._workspace_root.resolve()

    @staticmethod
    def private_scope_key(user_id: int) -> str:
        return f"private:{int(user_id)}"

    @staticmethod
    def channel_scope_key(channel_id: str | int) -> str:
        return f"channel:{channel_id}:main-agent"

    @staticmethod
    def _safe_channel_id(channel_id: str | int) -> str:
        return re.sub(r"[^A-Za-z0-9_.-]+", "-", str(channel_id)).strip(".-") or "default"

    @staticmethod
    def _valid_session_id(session_id: str | None) -> bool:
        return bool(
            isinstance(session_id, str)
            and session_id
            and len(session_id) <= _MAX_SESSION_ID_LENGTH
            and not any(ch in session_id for ch in "\r\n\x00")
        )

    def _expected_workspace(self, scope_type: str, scope_id: str) -> Path:
        if scope_type == "private":
            user_id = int(scope_id)
            if user_id <= 0:
                raise ValueError("private Agent scope requires a positive user id")
            candidate = self._workspace_root / f"user-{user_id}"
        elif scope_type == "channel":
            candidate = self._workspace_root / "channels" / f"channel-{self._safe_channel_id(scope_id)}"
        else:
            raise ValueError(f"unsupported Agent scope type: {scope_type}")

        ensure_private_directory(candidate.parent)
        candidate.mkdir(parents=True, mode=0o700, exist_ok=True)
        resolved = candidate.resolve()
        try:
            resolved.relative_to(self._workspace_root)
        except ValueError as exc:
            raise ValueError("Agent workspace resolves outside the managed workspace root") from exc
        # A symlink anywhere below the managed root could redirect a nominally
        # scoped path into another workspace.  Reject it at the platform
        # boundary; this is defensive path hygiene, not a shell sandbox.
        relative = candidate.relative_to(self._workspace_root)
        current = self._workspace_root
        for part in relative.parts:
            current = current / part
            if current.is_symlink():
                raise ValueError("Agent workspace must not contain symlink path components")
        ensure_private_directory(resolved)
        return resolved

    def ensure_private_scope(self, user_id: int) -> AgentExecutionScope:
        uid = int(user_id)
        return self._ensure_scope(
            scope_key=self.private_scope_key(uid),
            scope_type="private",
            scope_id=str(uid),
            default_session_id=f"enterprise-private-u{uid}",
        )

    def ensure_channel_scope(
        self,
        channel_id: str | int,
        *,
        legacy_session_id: str | None = None,
    ) -> AgentExecutionScope:
        scope_id = str(channel_id)
        default_session_id = f"enterprise-channel-{self._safe_channel_id(scope_id)}-main-agent"
        if self._valid_session_id(legacy_session_id):
            default_session_id = str(legacy_session_id)
        return self._ensure_scope(
            scope_key=self.channel_scope_key(scope_id),
            scope_type="channel",
            scope_id=scope_id,
            default_session_id=default_session_id,
        )

    def _ensure_scope(
        self,
        *,
        scope_key: str,
        scope_type: str,
        scope_id: str,
        default_session_id: str,
    ) -> AgentExecutionScope:
        workspace = self._expected_workspace(scope_type, scope_id)
        ts = now_ts()
        lifecycle_id = secrets.token_hex(16)
        with self.db.transaction() as conn:
            conn.execute(
                """
                INSERT INTO agent_scopes(
                    scope_key, scope_type, scope_id, session_id, lifecycle_id, workspace_path,
                    execution_backend, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'host', ?, ?)
                ON CONFLICT(scope_key) DO UPDATE SET
                    workspace_path=excluded.workspace_path,
                    execution_backend='host',
                    updated_at=excluded.updated_at
                """,
                (scope_key, scope_type, scope_id, default_session_id, lifecycle_id, str(workspace), ts, ts),
            )
            row = conn.execute(
                "SELECT * FROM agent_scopes WHERE scope_key = ?",
                (scope_key,),
            ).fetchone()
        if row is None:
            raise RuntimeError(f"failed to create Agent scope {scope_key}")
        scope = self._from_row(dict(row))
        self._record_session_alias(scope)
        self._sync_legacy_session(scope)
        self._write_scope_marker(scope)
        return scope

    def get_scope(self, scope_key: str) -> AgentExecutionScope | None:
        row = self.db.query_one("SELECT * FROM agent_scopes WHERE scope_key = ?", (scope_key,))
        return self._from_row(row) if row else None

    def get_private_scope(self, user_id: int) -> AgentExecutionScope | None:
        return self.get_scope(self.private_scope_key(int(user_id)))

    def update_session_id(self, scope_key: str, session_id: str) -> None:
        if not self._valid_session_id(session_id):
            raise ValueError("invalid Hermes session id")
        ts = now_ts()
        with self.db.transaction() as conn:
            conn.execute(
                "UPDATE agent_scopes SET session_id = ?, updated_at = ? WHERE scope_key = ?",
                (session_id, ts, scope_key),
            )
            row = conn.execute("SELECT * FROM agent_scopes WHERE scope_key = ?", (scope_key,)).fetchone()
            if row is not None:
                scope = self._from_row(dict(row))
                self._record_session_alias(scope, conn=conn, timestamp=ts)
                self._sync_legacy_session(scope, conn=conn, timestamp=ts)

    def rotate_session(self, scope_key: str) -> AgentExecutionScope:
        """Start a fresh Hermes conversation while preserving its workspace.

        Administrative chat clearing is a lifecycle boundary, not only a UI
        row deletion. A random suffix prevents Hermes from reopening the prior
        transcript/memory snapshot if the same logical Agent is used again.
        """

        row = self.db.query_one("SELECT * FROM agent_scopes WHERE scope_key = ?", (str(scope_key),))
        if row is None:
            raise ValueError(f"Agent scope does not exist: {scope_key}")
        scope = self._from_row(row)
        if scope.scope_type == "private":
            prefix = f"enterprise-private-u{int(scope.scope_id)}"
        else:
            prefix = f"enterprise-channel-{self._safe_channel_id(scope.scope_id)}-main-agent"
        session_id = f"{prefix}-{secrets.token_urlsafe(12)}"
        lifecycle_id = secrets.token_hex(16)
        ts = now_ts()
        with self.db.transaction() as conn:
            conn.execute(
                """
                UPDATE agent_scopes
                SET session_id = ?, lifecycle_id = ?, updated_at = ?
                WHERE scope_key = ?
                """,
                (session_id, lifecycle_id, ts, scope.scope_key),
            )
            conn.execute("DELETE FROM agent_scope_sessions WHERE scope_key = ?", (scope.scope_key,))
            row = conn.execute(
                "SELECT * FROM agent_scopes WHERE scope_key = ?",
                (scope.scope_key,),
            ).fetchone()
            if row is None:
                raise RuntimeError(f"failed to rotate Agent session {scope.scope_key}")
            rotated = self._from_row(dict(row))
            self._record_session_alias(rotated, conn=conn, timestamp=ts)
            self._sync_legacy_session(rotated, conn=conn, timestamp=ts)
        refreshed = self.get_scope(scope.scope_key)
        if refreshed is None:
            raise RuntimeError(f"failed to rotate Agent session {scope.scope_key}")
        self._write_scope_marker(refreshed)
        return refreshed

    def deactivate_private_scope(self, user_id: int) -> None:
        """Preserve private state for later account reactivation.

        Hermes owns the scoped process registry.  Account deactivation prevents
        new work from being queued; the durable workspace/session record remains
        intact as required by the trusted internal deployment model.
        """

        self.db.execute(
            "UPDATE agent_scopes SET updated_at = ? WHERE scope_key = ?",
            (now_ts(), self.private_scope_key(int(user_id))),
        )

    def cleanup_legacy_containers(self) -> dict[str, int]:
        """Best-effort cleanup for containers recorded before this migration.

        Only the platform's exact historical generated-name format is accepted;
        arbitrary database values can never become Docker CLI arguments.
        Failed cleanup remains pending as operator-visible database state and is
        retried on a later service start.  No new containers are inspected,
        created or started.
        """

        rows = self.db.query(
            """
            SELECT scope_key, legacy_container_name
            FROM agent_scopes
            WHERE legacy_cleanup_status IN ('pending', 'failed')
              AND legacy_container_name != ''
            """
        )
        result = {"removed": 0, "failed": 0, "skipped": 0}
        for row in rows:
            scope_key = str(row["scope_key"])
            name = str(row["legacy_container_name"])
            if not _LEGACY_CONTAINER_NAME_RE.fullmatch(name):
                self._set_cleanup_status(scope_key, "skipped", "legacy container name is not platform-generated")
                result["skipped"] += 1
                continue
            try:
                completed = self._cleanup_runner(
                    ["docker", "rm", "-f", name],
                    check=False,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    text=True,
                    timeout=30,
                )
                if int(getattr(completed, "returncode", 1)) == 0:
                    self._set_cleanup_status(scope_key, "removed", "")
                    result["removed"] += 1
                else:
                    error = str(getattr(completed, "stderr", "") or "docker rm failed").strip()[:500]
                    self._set_cleanup_status(scope_key, "failed", error)
                    result["failed"] += 1
            except Exception as exc:
                self._set_cleanup_status(scope_key, "failed", str(exc)[:500])
                result["failed"] += 1
        return result

    def _set_cleanup_status(self, scope_key: str, status: str, error: str) -> None:
        self.db.execute(
            """
            UPDATE agent_scopes
            SET legacy_cleanup_status = ?, legacy_cleanup_error = ?, updated_at = ?
            WHERE scope_key = ?
            """,
            (status, error, now_ts(), scope_key),
        )

    def _sync_legacy_session(
        self,
        scope: AgentExecutionScope,
        *,
        conn=None,
        timestamp: int | None = None,
    ) -> None:
        """Dual-write one release of rollback-compatible session state."""

        ts = now_ts() if timestamp is None else int(timestamp)

        def write(connection) -> None:
            if scope.scope_type == "private":
                connection.execute(
                    """
                    INSERT INTO private_agents(
                        user_id, session_id, container_name, container_id,
                        container_status, workspace_path, created_at, updated_at
                    ) VALUES (?, ?, '', '', 'host-workspace', ?, ?, ?)
                    ON CONFLICT(user_id) DO UPDATE SET
                        session_id = excluded.session_id,
                        workspace_path = excluded.workspace_path,
                        updated_at = excluded.updated_at
                    """,
                    (int(scope.scope_id), scope.session_id, scope.workspace_path, ts, ts),
                )
                return
            key = f"{_LEGACY_CHANNEL_SESSION_PREFIX}{scope.scope_id}:main-agent"
            connection.execute(
                """
                INSERT INTO settings(key, value, secret, updated_at)
                VALUES (?, ?, 0, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value, secret = 0, updated_at = excluded.updated_at
                """,
                (key, scope.session_id, ts),
            )

        if conn is not None:
            write(conn)
            return
        with self.db.transaction() as transaction:
            write(transaction)

    def session_belongs_to_current_lifecycle(self, scope_key: str, session_id: str) -> bool:
        scope = self.get_scope(str(scope_key))
        if scope is None or not self._valid_session_id(session_id):
            return False
        return bool(
            self.db.scalar(
                """
                SELECT 1 FROM agent_scope_sessions
                WHERE scope_key = ? AND lifecycle_id = ? AND session_id = ?
                """,
                (scope.scope_key, scope.lifecycle_id, str(session_id)),
            )
        )

    def _record_session_alias(self, scope: AgentExecutionScope, *, conn=None, timestamp: int | None = None) -> None:
        ts = now_ts() if timestamp is None else int(timestamp)

        def write(connection) -> None:
            connection.execute(
                """
                INSERT OR IGNORE INTO agent_scope_sessions(
                    scope_key, lifecycle_id, session_id, created_at
                ) VALUES (?, ?, ?, ?)
                """,
                (scope.scope_key, scope.lifecycle_id, scope.session_id, ts),
            )

        if conn is not None:
            write(conn)
            return
        with self.db.transaction() as transaction:
            write(transaction)

    @staticmethod
    def _from_row(row: dict[str, Any]) -> AgentExecutionScope:
        return AgentExecutionScope(
            scope_key=str(row["scope_key"]),
            scope_type=str(row["scope_type"]),
            scope_id=str(row["scope_id"]),
            session_id=str(row["session_id"]),
            lifecycle_id=str(row["lifecycle_id"]),
            workspace_path=str(row["workspace_path"]),
        )

    @staticmethod
    def _write_scope_marker(scope: AgentExecutionScope) -> None:
        marker = Path(scope.workspace_path) / ".enterprise-agent-scope.json"
        payload = json.dumps(
            {
                "scope_key": scope.scope_key,
                "scope_type": scope.scope_type,
                "scope_id": scope.scope_id,
                "lifecycle_id": scope.lifecycle_id,
                "execution_backend": "host",
                "isolation": "logical",
            },
            ensure_ascii=False,
            sort_keys=True,
        )
        temporary = marker.with_name(f"{marker.name}.tmp.{os.getpid()}.{secrets.token_hex(6)}")
        write_private_file_exclusive(temporary, (payload + "\n").encode("utf-8"))
        os.replace(temporary, marker)
        marker.chmod(0o600)
