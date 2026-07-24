from __future__ import annotations

import json
import os
import re
import secrets
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import PlatformConfig
from .container_contract_generated import CONTAINER_PATHS
from .db import Database, now_ts
from .secure_fs import ensure_private_directory, write_private_file_exclusive


_MAX_SESSION_ID_LENGTH = 512
_SCOPE_SELECT = """
    SELECT scopes.*,
           runtime.session_id AS runtime_session_id,
           runtime.lifecycle_id AS runtime_lifecycle_id
    FROM agent_scopes AS scopes
    JOIN agent_runtime_scopes AS runtime ON runtime.scope_key = scopes.scope_key
"""


@dataclass(frozen=True)
class AgentExecutionScope:
    """Stable container-execution identity for one private or channel Agent.

    A scope separates normal file, memory, session and process state.  It is a
    logical product boundary and isolated work environment, not an adversarial
    multi-tenant security boundary.
    """

    scope_key: str
    scope_type: str
    scope_id: str
    session_id: str
    lifecycle_id: str
    workspace_path: str
    workspace_id: str
    sandbox_id: str

    def to_execution_dict(self) -> dict[str, Any]:
        return {
            "backend": "sandbox",
            "isolation": "container-workspace",
            "scope_key": self.scope_key,
            "session_id": self.session_id,
            "lifecycle_id": self.lifecycle_id,
            "sandbox_id": self.sandbox_id,
            "workspace_id": self.workspace_id,
            "workspace_path": CONTAINER_PATHS["workspace"],
            "default_target": "sandbox",
        }


class AgentScopeManager:
    """Own stable Agent workspaces, sandbox identities and runtime sessions."""

    def __init__(self, config: PlatformConfig, db: Database):
        self.config = config
        self.db = db
        self._workspace_root = self.config.workspace_dir.expanduser()
        ensure_private_directory(self._workspace_root)
        self._workspace_root = self._workspace_root.resolve()
        self._scope_cache: dict[str, AgentExecutionScope] = {}
        self._scope_cache_lock = threading.RLock()
        self._normalize_workspace_records()

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

    def _workspace_id(self, scope_type: str, scope_id: str) -> str:
        if scope_type == "private":
            user_id = int(scope_id)
            if user_id <= 0:
                raise ValueError("private Agent scope requires a positive user id")
            return f"user-{user_id}"
        elif scope_type == "channel":
            return f"channels/channel-{self._safe_channel_id(scope_id)}"
        else:
            raise ValueError(f"unsupported Agent scope type: {scope_type}")

    def _expected_workspace(self, scope_type: str, scope_id: str) -> Path:
        candidate = self._workspace_root / self._workspace_id(scope_type, scope_id)

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

    def _normalize_workspace_records(self) -> None:
        """Replace legacy absolute workspace values with relative identifiers."""

        rows = self.db.query(
            "SELECT scope_key, scope_type, scope_id, workspace_path FROM agent_scopes"
        )
        timestamp = now_ts()
        updates: list[tuple[str, int, str]] = []
        for row in rows:
            expected = self._workspace_id(str(row["scope_type"]), str(row["scope_id"]))
            if str(row.get("workspace_path") or "") != expected:
                updates.append((expected, timestamp, str(row["scope_key"])))
        if updates:
            with self.db.transaction() as conn:
                conn.executemany(
                    "UPDATE agent_scopes SET workspace_path = ?, updated_at = ? WHERE scope_key = ?",
                    updates,
                )

    def ensure_private_scope(self, user_id: int) -> AgentExecutionScope:
        uid = int(user_id)
        return self._ensure_scope(
            scope_key=self.private_scope_key(uid),
            scope_type="private",
            scope_id=str(uid),
            default_session_id=f"ubitech-private-u{uid}",
        )

    def ensure_channel_scope(
        self,
        channel_id: str | int,
    ) -> AgentExecutionScope:
        scope_id = str(channel_id)
        default_session_id = f"ubitech-channel-{self._safe_channel_id(scope_id)}-main-agent"
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
        # Always re-resolve and lstat the workspace components. The metadata
        # cache removes repeated SQLite transactions and marker rewrites, but it
        # must not turn a later directory-to-symlink replacement into a durable
        # cross-scope workspace escape.
        workspace = self._expected_workspace(scope_type, scope_id)
        workspace_id = self._workspace_id(scope_type, scope_id)
        with self._scope_cache_lock:
            cached = self._scope_cache.get(scope_key)
        if (
            cached is not None
            and cached.scope_type == scope_type
            and cached.scope_id == scope_id
            and Path(cached.workspace_path) == workspace
            and self._scope_marker_matches(cached)
        ):
            return cached
        if cached is not None:
            with self._scope_cache_lock:
                self._scope_cache.pop(scope_key, None)

        existing = self.get_scope(scope_key)
        if (
            existing is not None
            and existing.scope_type == scope_type
            and existing.scope_id == scope_id
            and Path(existing.workspace_path) == workspace
            and self._scope_marker_matches(existing)
        ):
            with self._scope_cache_lock:
                self._scope_cache[scope_key] = existing
            return existing

        ts = now_ts()
        scope_lifecycle_id = secrets.token_hex(16)
        runtime_lifecycle_id = secrets.token_hex(16)
        with self.db.transaction() as conn:
            conn.execute(
                """
                INSERT INTO agent_scopes(
                    scope_key, scope_type, scope_id, session_id, lifecycle_id, workspace_path,
                    sandbox_id, execution_backend, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'sandbox', ?, ?)
                ON CONFLICT(scope_key) DO UPDATE SET
                    workspace_path=excluded.workspace_path,
                    execution_backend='sandbox',
                    updated_at=excluded.updated_at
                """,
                (
                    scope_key,
                    scope_type,
                    scope_id,
                    default_session_id,
                    scope_lifecycle_id,
                    workspace_id,
                    f"agent-{secrets.token_hex(16)}",
                    ts,
                    ts,
                ),
            )
            conn.execute(
                """
                INSERT OR IGNORE INTO agent_runtime_scopes(
                    scope_key, session_id, lifecycle_id, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (scope_key, default_session_id, runtime_lifecycle_id, ts, ts),
            )
            row = conn.execute(
                _SCOPE_SELECT + " WHERE scopes.scope_key = ?",
                (scope_key,),
            ).fetchone()
        if row is None:
            raise RuntimeError(f"failed to create Agent scope {scope_key}")
        scope = self._from_row(dict(row))
        self._record_session_alias(scope)
        self._write_scope_marker(scope)
        with self._scope_cache_lock:
            self._scope_cache[scope_key] = scope
        return scope

    def get_scope(self, scope_key: str) -> AgentExecutionScope | None:
        row = self.db.query_one(
            _SCOPE_SELECT + " WHERE scopes.scope_key = ?",
            (scope_key,),
        )
        return self._from_row(row) if row else None

    def get_private_scope(self, user_id: int) -> AgentExecutionScope | None:
        return self.get_scope(self.private_scope_key(int(user_id)))

    def update_session_id(self, scope_key: str, session_id: str) -> None:
        if not self._valid_session_id(session_id):
            raise ValueError("invalid Agent session id")
        ts = now_ts()
        updated_scope: AgentExecutionScope | None = None
        with self.db.transaction() as conn:
            conn.execute(
                "UPDATE agent_runtime_scopes SET session_id = ?, updated_at = ? WHERE scope_key = ?",
                (session_id, ts, scope_key),
            )
            row = conn.execute(
                _SCOPE_SELECT + " WHERE scopes.scope_key = ?",
                (scope_key,),
            ).fetchone()
            if row is not None:
                scope = self._from_row(dict(row))
                self._record_session_alias(scope, conn=conn, timestamp=ts)
                updated_scope = scope
        if updated_scope is not None:
            with self._scope_cache_lock:
                self._scope_cache[scope_key] = updated_scope

    def rotate_session(self, scope_key: str) -> AgentExecutionScope:
        """Explicitly start a fresh Agent lifecycle while preserving its workspace.

        Product-message hiding and administrative chat clearing do not call this
        method. Callers that intentionally reset Runtime context use a random
        suffix so the prior transcript cannot be reopened accidentally.
        """

        row = self.db.query_one(
            _SCOPE_SELECT + " WHERE scopes.scope_key = ?",
            (str(scope_key),),
        )
        if row is None:
            raise ValueError(f"Agent scope does not exist: {scope_key}")
        scope = self._from_row(row)
        if scope.scope_type == "private":
            prefix = f"ubitech-private-u{int(scope.scope_id)}"
        else:
            prefix = f"ubitech-channel-{self._safe_channel_id(scope.scope_id)}-main-agent"
        session_id = f"{prefix}-{secrets.token_urlsafe(12)}"
        lifecycle_id = secrets.token_hex(16)
        ts = now_ts()
        with self.db.transaction() as conn:
            conn.execute(
                """
                UPDATE agent_runtime_scopes
                SET session_id = ?, lifecycle_id = ?, updated_at = ?
                WHERE scope_key = ?
                """,
                (session_id, lifecycle_id, ts, scope.scope_key),
            )
            conn.execute(
                "DELETE FROM agent_runtime_scope_sessions WHERE scope_key = ?",
                (scope.scope_key,),
            )
            row = conn.execute(
                _SCOPE_SELECT + " WHERE scopes.scope_key = ?",
                (scope.scope_key,),
            ).fetchone()
            if row is None:
                raise RuntimeError(f"failed to rotate Agent session {scope.scope_key}")
            rotated = self._from_row(dict(row))
            self._record_session_alias(rotated, conn=conn, timestamp=ts)
        refreshed = self.get_scope(scope.scope_key)
        if refreshed is None:
            raise RuntimeError(f"failed to rotate Agent session {scope.scope_key}")
        self._write_scope_marker(refreshed)
        with self._scope_cache_lock:
            self._scope_cache[scope.scope_key] = refreshed
        return refreshed

    def deactivate_private_scope(self, user_id: int) -> None:
        """Preserve private state for later account reactivation.

        The runtime owns the scoped process registry. Account deactivation prevents
        new work from being queued; the durable workspace/session record remains
        intact for later use.
        """

        self.db.execute(
            "UPDATE agent_runtime_scopes SET updated_at = ? WHERE scope_key = ?",
            (now_ts(), self.private_scope_key(int(user_id))),
        )

    def session_belongs_to_current_lifecycle(self, scope_key: str, session_id: str) -> bool:
        scope = self.get_scope(str(scope_key))
        if scope is None or not self._valid_session_id(session_id):
            return False
        return bool(
            self.db.scalar(
                """
                SELECT 1 FROM agent_runtime_scope_sessions
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
                INSERT OR IGNORE INTO agent_runtime_scope_sessions(
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

    def _from_row(self, row: dict[str, Any]) -> AgentExecutionScope:
        workspace_id = str(row["workspace_path"])
        stored = Path(workspace_id)
        if stored.is_absolute():
            workspace_id = self._workspace_id(str(row["scope_type"]), str(row["scope_id"]))
            workspace = self._expected_workspace(str(row["scope_type"]), str(row["scope_id"]))
        else:
            workspace = (self._workspace_root / stored).resolve()
            try:
                workspace.relative_to(self._workspace_root)
            except ValueError as exc:
                raise ValueError("stored Agent workspace escapes the workspace root") from exc
        return AgentExecutionScope(
            scope_key=str(row["scope_key"]),
            scope_type=str(row["scope_type"]),
            scope_id=str(row["scope_id"]),
            session_id=str(row["runtime_session_id"]),
            lifecycle_id=str(row["runtime_lifecycle_id"]),
            workspace_path=str(workspace),
            workspace_id=workspace_id,
            sandbox_id=str(row["sandbox_id"]),
        )

    @staticmethod
    def _write_scope_marker(scope: AgentExecutionScope) -> None:
        marker = Path(scope.workspace_path) / ".ubitech-agent-scope.json"
        payload = json.dumps(
            {
                "scope_key": scope.scope_key,
                "scope_type": scope.scope_type,
                "scope_id": scope.scope_id,
                "lifecycle_id": scope.lifecycle_id,
                "sandbox_id": scope.sandbox_id,
                "workspace_id": scope.workspace_id,
                "execution_backend": "sandbox",
                "isolation": "container-workspace",
            },
            ensure_ascii=False,
            sort_keys=True,
        )
        temporary = marker.with_name(f"{marker.name}.tmp.{os.getpid()}.{secrets.token_hex(6)}")
        write_private_file_exclusive(temporary, (payload + "\n").encode("utf-8"))
        os.replace(temporary, marker)
        marker.chmod(0o600)

    @staticmethod
    def _scope_marker_matches(scope: AgentExecutionScope) -> bool:
        marker = Path(scope.workspace_path) / ".ubitech-agent-scope.json"
        try:
            payload = json.loads(marker.read_text(encoding="utf-8"))
            return bool(
                isinstance(payload, dict)
                and payload.get("scope_key") == scope.scope_key
                and payload.get("scope_type") == scope.scope_type
                and str(payload.get("scope_id")) == scope.scope_id
                and payload.get("lifecycle_id") == scope.lifecycle_id
                and payload.get("sandbox_id") == scope.sandbox_id
                and payload.get("workspace_id") == scope.workspace_id
                and payload.get("execution_backend") == "sandbox"
                and payload.get("isolation") == "container-workspace"
            )
        except (OSError, ValueError, TypeError):
            return False
