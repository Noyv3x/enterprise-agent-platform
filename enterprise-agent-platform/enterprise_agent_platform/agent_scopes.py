from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import sqlite3
import stat
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import PlatformConfig
from .container_contract_generated import CONTAINER_PATHS
from .db import Database, now_ts
from .secure_fs import (
    PrivatePublicationCommittedError,
    UnsafePrivatePathError,
    ensure_private_directory,
    open_private_child_directory_fd,
    open_private_directory_fd,
    publish_private_file_at,
    read_private_file_at,
)
from .technical_profile import other_technical_profile


_MAX_SESSION_ID_LENGTH = 512
_SCOPE_MARKER_SCHEMA_VERSION = 1
_SCOPE_MARKER_KIND = "agent-workspace-scope"
_MAX_SCOPE_MARKER_BYTES = 16 * 1024
_SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")
_SCOPE_SELECT = """
    SELECT scopes.*,
           runtime.session_id AS runtime_session_id,
           runtime.lifecycle_id AS runtime_lifecycle_id
    FROM agent_scopes AS scopes
    JOIN agent_runtime_scopes AS runtime ON runtime.scope_key = scopes.scope_key
"""


def _scope_marker_payload_for_profile(
    scope: AgentExecutionScope,
    profile_id: str,
) -> dict[str, Any]:
    return {
        "schema_version": _SCOPE_MARKER_SCHEMA_VERSION,
        "kind": _SCOPE_MARKER_KIND,
        "technical_profile": profile_id,
        "scope_key": scope.scope_key,
        "scope_type": scope.scope_type,
        "scope_id": scope.scope_id,
        "lifecycle_id": scope.lifecycle_id,
        "sandbox_id": scope.sandbox_id,
        "workspace_id": scope.workspace_id,
        "workspace_relative_path": f"workspaces/{scope.workspace_id}",
        "isolation": "container-workspace",
    }


def assert_existing_workspace_profile(config: PlatformConfig) -> None:
    """Pure-read rejection of cross-profile workspace markers.

    Target data has already passed the handoff transformer, so every recorded
    workspace must carry its target marker before the Platform may start any
    writer. Source inventory must likewise remain entirely source-profile.
    """

    try:
        database_info = os.lstat(config.db_path)
    except FileNotFoundError:
        return
    if not stat.S_ISREG(database_info.st_mode) or database_info.st_size == 0:
        return
    uri = config.db_path.absolute().as_uri() + "?mode=ro"
    try:
        connection = sqlite3.connect(uri, uri=True)
        try:
            connection.row_factory = sqlite3.Row
            rows = connection.execute(
                _SCOPE_SELECT + " ORDER BY scopes.scope_key"
            ).fetchall()
            scope_count = int(
                connection.execute("SELECT COUNT(*) FROM agent_scopes").fetchone()[0]
            )
        finally:
            connection.close()
    except sqlite3.Error as exc:
        raise sqlite3.DatabaseError(
            "Agent workspace inventory is unavailable for profile validation"
        ) from exc
    if not rows and scope_count == 0:
        return
    if len(rows) != scope_count:
        raise sqlite3.DatabaseError(
            "Agent workspace runtime identity is incomplete for profile validation"
        )

    selected = config.technical_profile
    other_marker_name = other_technical_profile(selected).scope_marker_name
    try:
        root_fd = open_private_directory_fd(config.workspace_dir)
    except (FileNotFoundError, UnsafePrivatePathError) as exc:
        if selected.is_target:
            raise sqlite3.DatabaseError(
                "target Agent workspace root is missing or unsafe"
            ) from exc
        return
    try:
        other_internal_directory = other_technical_profile(
            selected
        ).workspace_internal_directory
        for row in rows:
            scope_key = str(row["scope_key"])
            scope_type = str(row["scope_type"])
            scope_id = str(row["scope_id"])
            if scope_type == "private":
                try:
                    workspace_id = f"user-{int(scope_id)}"
                except ValueError as exc:
                    raise sqlite3.DatabaseError(
                        "Agent workspace inventory has an invalid private scope"
                    ) from exc
            elif scope_type == "channel":
                workspace_id = (
                    "channels/channel-"
                    + AgentScopeManager._safe_channel_id(scope_id)
                )
            else:
                raise sqlite3.DatabaseError(
                    "Agent workspace inventory has an invalid scope type"
                )
            workspace_path = str(row["workspace_path"])
            if workspace_path != workspace_id:
                raise sqlite3.DatabaseError(
                    "Agent workspace inventory does not match its scope identity"
                )
            relative = Path(str(workspace_path))
            if relative.is_absolute() or any(
                part in {"", ".", ".."} for part in relative.parts
            ):
                raise sqlite3.DatabaseError(
                    "Agent workspace inventory contains an unsafe path"
                )
            current_fd = os.dup(root_fd)
            try:
                try:
                    for part in relative.parts:
                        next_fd = open_private_child_directory_fd(current_fd, part)
                        os.close(current_fd)
                        current_fd = next_fd
                except (FileNotFoundError, UnsafePrivatePathError) as exc:
                    if selected.is_target:
                        raise sqlite3.DatabaseError(
                            "target Agent workspace is missing or unsafe: "
                            + str(scope_key)
                        ) from exc
                    continue
                try:
                    os.stat(
                        other_marker_name,
                        dir_fd=current_fd,
                        follow_symlinks=False,
                    )
                except FileNotFoundError:
                    pass
                else:
                    raise sqlite3.DatabaseError(
                        "Agent workspace contains another technical profile marker: "
                        + str(scope_key)
                    )
                try:
                    os.stat(
                        other_internal_directory,
                        dir_fd=current_fd,
                        follow_symlinks=False,
                    )
                except FileNotFoundError:
                    pass
                else:
                    raise sqlite3.DatabaseError(
                        "Agent workspace contains another technical profile directory: "
                        + str(scope_key)
                    )
                if selected.is_target:
                    try:
                        raw, _ = read_private_file_at(
                            current_fd,
                            selected.scope_marker_name,
                            maximum_bytes=_MAX_SCOPE_MARKER_BYTES,
                        )
                        payload = AgentScopeManager._decode_scope_marker(
                            raw,
                            config.workspace_dir
                            / relative
                            / selected.scope_marker_name,
                        )
                    except (FileNotFoundError, UnsafePrivatePathError) as exc:
                        raise sqlite3.DatabaseError(
                            "target Agent workspace marker is missing or unsafe: "
                            + str(scope_key)
                        ) from exc
                    scope = AgentExecutionScope(
                        scope_key=scope_key,
                        scope_type=scope_type,
                        scope_id=scope_id,
                        session_id=str(row["runtime_session_id"]),
                        lifecycle_id=str(row["runtime_lifecycle_id"]),
                        workspace_path=str(config.workspace_dir / relative),
                        workspace_id=workspace_id,
                        sandbox_id=str(row["sandbox_id"]),
                    )
                    expected = _scope_marker_payload_for_profile(
                        scope,
                        selected.profile_id,
                    )
                    if not AgentScopeManager._scope_marker_payload_matches(
                        payload,
                        expected,
                    ):
                        raise sqlite3.DatabaseError(
                            "target Agent workspace marker does not match its database identity: "
                            + str(scope_key)
                        )
            finally:
                os.close(current_fd)
    finally:
        os.close(root_fd)


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

    def __init__(
        self,
        config: PlatformConfig,
        db: Database,
        *,
        commit_schema_upgrade: bool = True,
    ):
        self.config = config
        self.db = db
        self._technical_profile = self.config.technical_profile
        self._scope_marker_name = self._technical_profile.scope_marker_name
        self._other_scope_marker_name = other_technical_profile(
            self._technical_profile
        ).scope_marker_name
        self._other_workspace_internal_directory = other_technical_profile(
            self._technical_profile
        ).workspace_internal_directory
        self._schema_writes_enabled = bool(commit_schema_upgrade)
        self._workspace_root = Path(
            os.path.abspath(os.fspath(self.config.workspace_dir.expanduser()))
        )
        # Manager owns creation of the shared root for a proven fresh install.
        # Every Platform startup, including ordinary current startup, only
        # validates it and must never create or repair it.
        workspace_root_fd = open_private_directory_fd(self._workspace_root)
        os.close(workspace_root_fd)
        # The data root is owner-only and is not mounted into an Agent. Reuse
        # its already-existing directory inode for transient exchange staging
        # so candidate startup remains read-only and cannot leave a newly
        # created directory before Manager admits the commit.
        self._machine_staging_root = Path(
            os.path.abspath(os.fspath(self.config.data_dir.expanduser()))
        )
        self._scope_cache: dict[str, AgentExecutionScope] = {}
        self._scope_cache_lock = threading.RLock()
        self._assert_workspace_records()
        if self._missing_current_runtime_aliases():
            raise sqlite3.DatabaseError(
                "Agent Runtime current alias is missing from the current baseline"
            )
        self._assert_scope_markers()

    @staticmethod
    def private_scope_key(user_id: int) -> str:
        return f"private:{int(user_id)}"

    @staticmethod
    def channel_scope_key(channel_id: str | int) -> str:
        return f"channel:{channel_id}:main-agent"

    @staticmethod
    def _safe_channel_id(channel_id: str | int) -> str:
        return re.sub(r"[^A-Za-z0-9_.-]+", "-", str(channel_id)).strip(".-") or "default"

    def _private_session_prefix(self, user_id: int | str) -> str:
        return f"{self._technical_profile.session_namespace}-private-u{int(user_id)}"

    def _channel_session_prefix(self, channel_id: str | int) -> str:
        return (
            f"{self._technical_profile.session_namespace}-channel-"
            f"{self._safe_channel_id(channel_id)}-main-agent"
        )

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

    def _assert_workspace_records(self) -> None:
        """Reject scope rows outside the current relative-workspace contract."""

        rows = self.db.query(
            "SELECT scope_key, scope_type, scope_id, workspace_path FROM agent_scopes"
        )
        for row in rows:
            expected = self._workspace_id(str(row["scope_type"]), str(row["scope_id"]))
            if str(row.get("workspace_path") or "") != expected:
                raise sqlite3.DatabaseError(
                    "Agent scope workspace does not match the current baseline: "
                    + str(row["scope_key"])
                )

    def _assert_scope_markers(self) -> None:
        rows = self.db.query(_SCOPE_SELECT + " ORDER BY scopes.scope_key")
        expected_count = int(self.db.scalar("SELECT COUNT(*) FROM agent_scopes") or 0)
        if len(rows) != expected_count:
            raise sqlite3.DatabaseError(
                "Agent scope runtime identity is incomplete in the current baseline"
            )
        for row in rows:
            scope = self._from_row(row)
            self._validate_existing_workspace(
                scope.scope_type,
                scope.scope_id,
            )
            self._require_scope_marker(scope)

    def _missing_current_runtime_aliases(self) -> list[tuple[str, str, str, int]]:
        rows = self.db.query(
            """
            SELECT runtime.scope_key, runtime.lifecycle_id, runtime.session_id,
                   runtime.created_at
            FROM agent_runtime_scopes AS runtime
            LEFT JOIN agent_runtime_scope_sessions AS aliases
              ON aliases.scope_key = runtime.scope_key
             AND aliases.lifecycle_id = runtime.lifecycle_id
             AND aliases.session_id = runtime.session_id
            WHERE aliases.scope_key IS NULL
            ORDER BY runtime.scope_key
            """
        )
        return [
            (
                str(row["scope_key"]),
                str(row["lifecycle_id"]),
                str(row["session_id"]),
                int(row["created_at"]),
            )
            for row in rows
        ]

    def commit_schema_upgrade(self) -> None:
        """Revalidate the current baseline before opening its write gate."""

        if self._schema_writes_enabled:
            return
        if self._missing_current_runtime_aliases():
            raise sqlite3.DatabaseError(
                "Agent Runtime current alias is missing from the current baseline"
            )
        self._assert_scope_markers()
        self._schema_writes_enabled = True

    def release_schema_write_gate_after_abort(self) -> None:
        """Reopen a candidate only after pure-read current-schema validation."""

        if self._schema_writes_enabled:
            return
        if self._missing_current_runtime_aliases():
            raise sqlite3.DatabaseError(
                "Agent Runtime current alias is missing from the current baseline"
            )
        self._assert_scope_markers()
        self._schema_writes_enabled = True

    def handoff_workspace_identity(self) -> str:
        """Pure-read, closed-world workspace identity for Manager handoff.

        Unlike the startup compatibility path, this method never accepts or
        upgrades a legacy marker.  It reopens every marker and hashes only the
        canonical relative identity, never a host absolute workspace path.
        """

        rows = self.db.query(_SCOPE_SELECT + " ORDER BY scopes.scope_key")
        expected_count = int(self.db.scalar("SELECT COUNT(*) FROM agent_scopes") or 0)
        if len(rows) != expected_count:
            raise sqlite3.DatabaseError(
                "Agent scope runtime identity is incomplete in the current baseline"
            )
        identities: list[dict[str, Any]] = []
        for row in rows:
            self._validate_existing_workspace(
                str(row["scope_type"]),
                str(row["scope_id"]),
            )
            scope = self._from_row(row)
            expected = self._scope_marker_payload(scope)
            self._reject_other_profile_marker(None, scope)
            marker = Path(scope.workspace_path) / self._scope_marker_name
            if not self._scope_marker_payload_matches(
                self._read_scope_marker(marker), expected
            ):
                raise sqlite3.DatabaseError(
                    "Agent workspace scope marker is not the committed current schema: "
                    + scope.scope_key
                )
            identities.append(expected)
        encoded = json.dumps(
            identities,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    def _validate_existing_workspace(
        self,
        scope_type: str,
        scope_id: str,
        *,
        allow_missing: bool = False,
    ) -> bool:
        relative = Path(self._workspace_id(scope_type, scope_id))
        root_fd = open_private_directory_fd(self._workspace_root)
        current_fd = root_fd
        traversed = self._workspace_root
        try:
            for part in relative.parts:
                traversed = traversed / part
                try:
                    next_fd = open_private_child_directory_fd(current_fd, part)
                except FileNotFoundError as exc:
                    if allow_missing:
                        return False
                    raise sqlite3.DatabaseError(
                        f"Agent workspace directory is missing: {traversed}"
                    ) from exc
                except (OSError, UnsafePrivatePathError) as exc:
                    raise sqlite3.DatabaseError(
                        f"Agent workspace directory has unsafe metadata: {traversed}"
                    ) from exc
                if current_fd != root_fd:
                    os.close(current_fd)
                current_fd = next_fd
            return True
        finally:
            if current_fd != root_fd:
                os.close(current_fd)
            os.close(root_fd)

    def ensure_private_scope(self, user_id: int) -> AgentExecutionScope:
        uid = int(user_id)
        return self._ensure_scope(
            scope_key=self.private_scope_key(uid),
            scope_type="private",
            scope_id=str(uid),
            default_session_id=self._private_session_prefix(uid),
        )

    def ensure_channel_scope(
        self,
        channel_id: str | int,
    ) -> AgentExecutionScope:
        scope_id = str(channel_id)
        default_session_id = self._channel_session_prefix(scope_id)
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
        if not self._schema_writes_enabled:
            raise sqlite3.DatabaseError(
                "Agent scope writes are unavailable before schema commit"
            )
        workspace_id = self._workspace_id(scope_type, scope_id)
        workspace = self._workspace_root / workspace_id
        with self._scope_cache_lock:
            cached = self._scope_cache.get(scope_key)
        if (
            cached is not None
            and cached.scope_type == scope_type
            and cached.scope_id == scope_id
            and Path(cached.workspace_path) == workspace
        ):
            self._validate_existing_workspace(scope_type, scope_id)
            self._require_scope_marker(
                cached,
            )
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
        ):
            self._validate_existing_workspace(scope_type, scope_id)
            self._require_scope_marker(
                existing,
            )
            with self._scope_cache_lock:
                self._scope_cache[scope_key] = existing
            return existing
        if existing is not None:
            raise sqlite3.DatabaseError(
                "Agent scope identity does not match the requested workspace: "
                + scope_key
            )

        # Only an identity absent from the authoritative DB may materialize a
        # new workspace. Cached or DB-backed scopes above are validation-only,
        # so deletion or metadata drift cannot be disguised as first use.
        workspace = self._expected_workspace(scope_type, scope_id)
        ts = now_ts()
        scope_lifecycle_id = secrets.token_hex(16)
        runtime_lifecycle_id = secrets.token_hex(16)
        with self.db.transaction() as conn:
            conn.execute(
                """
                INSERT INTO agent_scopes(
                    scope_key, scope_type, scope_id, session_id, lifecycle_id, workspace_path,
                    sandbox_id, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(scope_key) DO UPDATE SET
                    workspace_path=excluded.workspace_path,
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

        if not self._schema_writes_enabled:
            raise sqlite3.DatabaseError(
                "Agent scope writes are unavailable before schema commit"
            )
        row = self.db.query_one(
            _SCOPE_SELECT + " WHERE scopes.scope_key = ?",
            (str(scope_key),),
        )
        if row is None:
            raise ValueError(f"Agent scope does not exist: {scope_key}")
        scope = self._from_row(row)
        self._validate_existing_workspace(scope.scope_type, scope.scope_id)
        self._require_scope_marker(
            scope,
        )
        if scope.scope_type == "private":
            prefix = self._private_session_prefix(scope.scope_id)
        else:
            prefix = self._channel_session_prefix(scope.scope_id)
        session_id = f"{prefix}-{secrets.token_urlsafe(12)}"
        lifecycle_id = secrets.token_hex(16)
        ts = now_ts()
        planned = AgentExecutionScope(
            scope_key=scope.scope_key,
            scope_type=scope.scope_type,
            scope_id=scope.scope_id,
            session_id=session_id,
            lifecycle_id=lifecycle_id,
            workspace_path=scope.workspace_path,
            workspace_id=scope.workspace_id,
            sandbox_id=scope.sandbox_id,
        )
        self._prepare_scope_marker_transition(scope, planned)
        try:
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
        except BaseException:
            # If SQLite did not commit, the old DB/current marker pair proves
            # that the prepared new inode is abandoned and can be removed.
            self._cleanup_scope_marker_residue_from_marker(
                scope,
                Path(scope.workspace_path) / self._scope_marker_name,
            )
            raise
        refreshed = self.get_scope(scope.scope_key)
        if refreshed is None:
            raise RuntimeError(f"failed to rotate Agent session {scope.scope_key}")
        self._write_scope_marker(
            refreshed,
            expected_previous=self._scope_marker_payload(scope),
        )
        with self._scope_cache_lock:
            self._scope_cache[scope.scope_key] = refreshed
        return refreshed

    def _prepare_scope_marker_transition(
        self,
        previous: AgentExecutionScope,
        planned: AgentExecutionScope,
    ) -> None:
        self._reject_other_profile_marker(None, previous)
        marker = Path(previous.workspace_path) / self._scope_marker_name
        marker_fd = open_private_directory_fd(marker.parent)
        staging_fd: int | None = None
        try:
            staging_fd = open_private_directory_fd(self._machine_staging_root)
            previous_raw, _ = read_private_file_at(
                marker_fd,
                marker.name,
                maximum_bytes=_MAX_SCOPE_MARKER_BYTES,
            )
            if not self._scope_marker_payload_matches(
                self._decode_scope_marker(previous_raw, marker),
                self._scope_marker_payload(previous),
            ):
                raise sqlite3.DatabaseError(
                    "Agent workspace scope marker changed before rotation: "
                    + previous.scope_key
                )
            planned_raw = self._encoded_scope_marker(planned)
            name = self._scope_marker_staging_name(
                planned,
                previous_raw,
                planned_raw,
            )
            try:
                publish_private_file_at(
                    staging_fd,
                    name,
                    planned_raw,
                    replace_identity=None,
                )
            except PrivatePublicationCommittedError:
                raise
            except UnsafePrivatePathError as exc:
                raise sqlite3.DatabaseError(
                    "Agent workspace scope marker transition could not be prepared: "
                    + previous.scope_key
                ) from exc
        finally:
            if staging_fd is not None:
                os.close(staging_fd)
            os.close(marker_fd)

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
        expected_workspace_id = self._workspace_id(
            str(row["scope_type"]), str(row["scope_id"])
        )
        if workspace_id != expected_workspace_id:
            raise sqlite3.DatabaseError(
                "Agent scope workspace does not match the current baseline: "
                + str(row["scope_key"])
            )
        stored = Path(workspace_id)
        if stored.is_absolute() or ".." in stored.parts:
            raise sqlite3.DatabaseError(
                "Agent scope workspace does not match the current baseline: "
                + str(row["scope_key"])
            )
        # Preserve the lexical path until the fd-based traversal below proves
        # every component. Path.resolve() would follow an attacker-controlled
        # symlink before the no-follow validation has a chance to reject it.
        workspace = self._workspace_root / stored
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

    def _write_scope_marker(
        self,
        scope: AgentExecutionScope,
        *,
        expected_previous: dict[str, Any] | None = None,
        directory_fd: int | None = None,
    ) -> None:
        self._reject_other_profile_marker(directory_fd, scope)
        marker = Path(scope.workspace_path) / self._scope_marker_name
        encoded = self._encoded_scope_marker(scope)
        owns_directory_fd = directory_fd is None
        if directory_fd is None:
            directory_fd = open_private_directory_fd(marker.parent)
        staging_fd: int | None = None
        try:
            staging_fd = open_private_directory_fd(self._machine_staging_root)
            try:
                raw, existing = read_private_file_at(
                    directory_fd,
                    marker.name,
                    maximum_bytes=_MAX_SCOPE_MARKER_BYTES,
                )
            except FileNotFoundError:
                existing = None
            else:
                actual = self._decode_scope_marker(raw, marker)
                if self._scope_marker_payload_matches(
                    actual, self._scope_marker_payload(scope)
                ):
                    self._cleanup_scope_marker_residue(
                        scope,
                        final_raw=raw,
                    )
                    return
                if expected_previous is None or not self._scope_marker_payload_matches(
                    actual, expected_previous
                ):
                    raise sqlite3.DatabaseError(
                        "Agent workspace scope marker changed before publication: "
                        + scope.scope_key
                    )
            try:
                publish_private_file_at(
                    directory_fd,
                    marker.name,
                    encoded,
                    replace_identity=(existing.st_dev, existing.st_ino)
                    if existing is not None
                    else None,
                    replace_data=raw if existing is not None else None,
                    staging_fd=staging_fd if existing is not None else None,
                    staging_name=self._scope_marker_staging_name(
                        scope,
                        raw,
                        encoded,
                    )
                    if existing is not None
                    else None,
                )
            except PrivatePublicationCommittedError:
                raise
            except UnsafePrivatePathError as exc:
                raise sqlite3.DatabaseError(
                    "Agent workspace scope marker could not be published safely: "
                    + scope.scope_key
                ) from exc
        finally:
            if staging_fd is not None:
                os.close(staging_fd)
            if owns_directory_fd:
                os.close(directory_fd)

    def _reject_other_profile_marker(
        self,
        directory_fd: int | None,
        scope: AgentExecutionScope,
    ) -> None:
        owns_directory_fd = directory_fd is None
        if directory_fd is None:
            directory_fd = open_private_directory_fd(Path(scope.workspace_path))
        try:
            try:
                os.stat(
                    self._other_scope_marker_name,
                    dir_fd=directory_fd,
                    follow_symlinks=False,
                )
            except FileNotFoundError:
                pass
            except OSError as exc:
                raise sqlite3.DatabaseError(
                    "Agent workspace profile marker could not be inspected: "
                    + scope.scope_key
                ) from exc
            else:
                raise sqlite3.DatabaseError(
                    "Agent workspace contains another technical profile marker: "
                    + scope.scope_key
                )
            try:
                os.stat(
                    self._other_workspace_internal_directory,
                    dir_fd=directory_fd,
                    follow_symlinks=False,
                )
            except FileNotFoundError:
                return
            except OSError as exc:
                raise sqlite3.DatabaseError(
                    "Agent workspace profile directory could not be inspected: "
                    + scope.scope_key
                ) from exc
            raise sqlite3.DatabaseError(
                "Agent workspace contains another technical profile directory: "
                + scope.scope_key
            )
        finally:
            if owns_directory_fd:
                os.close(directory_fd)

    def _encoded_scope_marker(self, scope: AgentExecutionScope) -> bytes:
        return (
            json.dumps(
                self._scope_marker_payload(scope),
                ensure_ascii=False,
                sort_keys=True,
            )
            + "\n"
        ).encode("utf-8")

    @staticmethod
    def _scope_marker_staging_name(
        scope: AgentExecutionScope,
        previous_raw: bytes,
        current_raw: bytes,
    ) -> str:
        return (
            ".platform-machine-scope-"
            + hashlib.sha256(scope.scope_key.encode("utf-8")).hexdigest()
            + "-"
            + hashlib.sha256(previous_raw).hexdigest()
            + "-"
            + hashlib.sha256(current_raw).hexdigest()
            + ".stage"
        )

    def _cleanup_scope_marker_residue(
        self,
        scope: AgentExecutionScope,
        *,
        final_raw: bytes,
    ) -> None:
        """Replay the post-exchange checkpoint from closed-world evidence."""

        staging_fd = open_private_directory_fd(self._machine_staging_root)
        scope_hash = hashlib.sha256(scope.scope_key.encode("utf-8")).hexdigest()
        current_hash = hashlib.sha256(final_raw).hexdigest()
        prefix = f".platform-machine-scope-{scope_hash}-"
        try:
            candidates = sorted(
                name
                for name in os.listdir(staging_fd)
                if name.startswith(prefix)
            )
            for name in candidates:
                remainder = name[len(prefix) :]
                parts = remainder[: -len(".stage")].split("-") if remainder.endswith(".stage") else []
                if len(parts) != 2 or not all(_SHA256_HEX.fullmatch(value) for value in parts):
                    raise sqlite3.DatabaseError(
                        "Agent workspace scope marker has an unknown recovery residue: "
                        + scope.scope_key
                    )
                try:
                    previous_raw, _ = read_private_file_at(
                        staging_fd,
                        name,
                        maximum_bytes=_MAX_SCOPE_MARKER_BYTES,
                    )
                except (FileNotFoundError, UnsafePrivatePathError) as exc:
                    raise sqlite3.DatabaseError(
                        "Agent workspace scope marker recovery residue is unsafe: "
                        + scope.scope_key
                    ) from exc
                old_hash, new_hash = parts
                staged_hash = hashlib.sha256(previous_raw).hexdigest()
                if staged_hash not in {old_hash, new_hash}:
                    raise sqlite3.DatabaseError(
                        "Agent workspace scope marker recovery residue changed: "
                        + scope.scope_key
                    )
                staged_payload = self._decode_scope_marker(
                    previous_raw,
                    self._machine_staging_root / name,
                )
                if current_hash == new_hash and staged_hash == old_hash:
                    authorized = self._authorized_previous_scope_marker(
                        scope, staged_payload
                    )
                elif current_hash == old_hash and staged_hash == new_hash:
                    authorized = self._authorized_future_scope_marker(
                        scope, staged_payload
                    )
                else:
                    authorized = False
                if not authorized:
                    raise sqlite3.DatabaseError(
                        "Agent workspace scope marker recovery residue is not authoritative: "
                        + scope.scope_key
                    )
                os.unlink(name, dir_fd=staging_fd)
                os.fsync(staging_fd)
        finally:
            os.close(staging_fd)

    def _cleanup_scope_marker_residue_from_marker(
        self,
        scope: AgentExecutionScope,
        marker: Path,
        *,
        directory_fd: int | None = None,
    ) -> None:
        owns_directory_fd = directory_fd is None
        if directory_fd is None:
            directory_fd = open_private_directory_fd(marker.parent)
        try:
            try:
                final_raw, _ = read_private_file_at(
                    directory_fd,
                    marker.name,
                    maximum_bytes=_MAX_SCOPE_MARKER_BYTES,
                )
            except (FileNotFoundError, UnsafePrivatePathError) as exc:
                raise sqlite3.DatabaseError(
                    "Agent workspace scope marker could not be replayed: "
                    + scope.scope_key
                ) from exc
        finally:
            if owns_directory_fd:
                os.close(directory_fd)
        if not self._scope_marker_payload_matches(
            self._decode_scope_marker(final_raw, marker),
            self._scope_marker_payload(scope),
        ):
            raise sqlite3.DatabaseError(
                "Agent workspace scope marker changed before replay: "
                + scope.scope_key
            )
        self._cleanup_scope_marker_residue(scope, final_raw=final_raw)

    def _replay_pre_exchange_scope_marker(
        self,
        scope: AgentExecutionScope,
        marker: Path,
        *,
        directory_fd: int | None = None,
    ) -> bool:
        """Complete a durable DB-new/marker-old transition after restart."""

        owns_marker_fd = directory_fd is None
        marker_fd = (
            open_private_directory_fd(marker.parent)
            if directory_fd is None
            else directory_fd
        )
        staging_fd: int | None = None
        try:
            staging_fd = open_private_directory_fd(self._machine_staging_root)
            final_raw, final_info = read_private_file_at(
                marker_fd,
                marker.name,
                maximum_bytes=_MAX_SCOPE_MARKER_BYTES,
            )
            final_payload = self._decode_scope_marker(final_raw, marker)
            expected_raw = self._encoded_scope_marker(scope)
            expected_hash = hashlib.sha256(expected_raw).hexdigest()
            scope_hash = hashlib.sha256(scope.scope_key.encode("utf-8")).hexdigest()
            prefix = f".platform-machine-scope-{scope_hash}-"
            matches: list[tuple[str, str]] = []
            for name in sorted(os.listdir(staging_fd)):
                if not name.startswith(prefix) or not name.endswith(".stage"):
                    continue
                parts = name[len(prefix) : -len(".stage")].split("-")
                if len(parts) != 2 or not all(
                    _SHA256_HEX.fullmatch(value) for value in parts
                ):
                    raise sqlite3.DatabaseError(
                        "Agent workspace scope marker has an unknown recovery residue: "
                        + scope.scope_key
                    )
                old_hash, new_hash = parts
                if (
                    new_hash == expected_hash
                    and old_hash == hashlib.sha256(final_raw).hexdigest()
                ):
                    matches.append((name, old_hash))
            if not matches:
                return False
            if len(matches) != 1 or not self._authorized_previous_scope_marker(
                scope, final_payload
            ):
                raise sqlite3.DatabaseError(
                    "Agent workspace scope marker transition is ambiguous: "
                    + scope.scope_key
                )
            name, _ = matches[0]
            staged_raw, _ = read_private_file_at(
                staging_fd,
                name,
                maximum_bytes=_MAX_SCOPE_MARKER_BYTES,
            )
            if staged_raw != expected_raw:
                raise sqlite3.DatabaseError(
                    "Agent workspace scope marker transition target changed: "
                    + scope.scope_key
                )
            try:
                publish_private_file_at(
                    marker_fd,
                    marker.name,
                    expected_raw,
                    replace_identity=(final_info.st_dev, final_info.st_ino),
                    replace_data=final_raw,
                    staging_fd=staging_fd,
                    staging_name=name,
                )
            except UnsafePrivatePathError as exc:
                raise sqlite3.DatabaseError(
                    "Agent workspace scope marker transition could not be replayed: "
                    + scope.scope_key
                ) from exc
            return True
        finally:
            if staging_fd is not None:
                os.close(staging_fd)
            if owns_marker_fd:
                os.close(marker_fd)

    def _authorized_previous_scope_marker(
        self,
        scope: AgentExecutionScope,
        payload: dict[str, Any],
    ) -> bool:
        lifecycle_id = payload.get("lifecycle_id")
        if not isinstance(lifecycle_id, str) or not lifecycle_id:
            return False
        historical = AgentExecutionScope(
            scope_key=scope.scope_key,
            scope_type=scope.scope_type,
            scope_id=scope.scope_id,
            session_id=scope.session_id,
            lifecycle_id=lifecycle_id,
            workspace_path=scope.workspace_path,
            workspace_id=scope.workspace_id,
            sandbox_id=scope.sandbox_id,
        )
        return self._scope_marker_payload_matches(
            payload,
            self._scope_marker_payload(historical),
        )

    def _authorized_future_scope_marker(
        self,
        scope: AgentExecutionScope,
        payload: dict[str, Any],
    ) -> bool:
        lifecycle_id = payload.get("lifecycle_id")
        if not isinstance(lifecycle_id, str) or not lifecycle_id:
            return False
        planned = AgentExecutionScope(
            scope_key=scope.scope_key,
            scope_type=scope.scope_type,
            scope_id=scope.scope_id,
            session_id=scope.session_id,
            lifecycle_id=lifecycle_id,
            workspace_path=scope.workspace_path,
            workspace_id=scope.workspace_id,
            sandbox_id=scope.sandbox_id,
        )
        return self._scope_marker_payload_matches(
            payload, self._scope_marker_payload(planned)
        )

    @staticmethod
    def _scope_marker_payload_matches(
        actual: Any,
        expected: dict[str, Any],
    ) -> bool:
        """Compare a marker without Python's bool/int numeric coercion."""

        if not isinstance(actual, dict):
            return False
        if "schema_version" in expected and type(actual.get("schema_version")) is not int:
            return False
        return actual == expected

    def _scope_marker_payload(self, scope: AgentExecutionScope) -> dict[str, Any]:
        return _scope_marker_payload_for_profile(
            scope,
            self._technical_profile.profile_id,
        )

    def _require_scope_marker(
        self,
        scope: AgentExecutionScope,
        *,
        directory_fd: int | None = None,
    ) -> None:
        self._reject_other_profile_marker(directory_fd, scope)
        marker = Path(scope.workspace_path) / self._scope_marker_name
        payload = self._read_scope_marker(
            marker,
            allow_missing=True,
            directory_fd=directory_fd,
        )
        if self._scope_marker_payload_matches(
            payload, self._scope_marker_payload(scope)
        ):
            if self._schema_writes_enabled:
                self._cleanup_scope_marker_residue_from_marker(
                    scope,
                    marker,
                    directory_fd=directory_fd,
                )
            return
        # A committed current process may finish only the exact DB-new / marker-
        # old session-rotation checkpoint. Candidate startup is pure read and
        # therefore rejects the same half checkpoint until the current writer
        # has converged it.
        if self._schema_writes_enabled and payload is not None:
            if self._replay_pre_exchange_scope_marker(
                scope,
                marker,
                directory_fd=directory_fd,
            ):
                if not self._scope_marker_payload_matches(
                    self._read_scope_marker(marker, directory_fd=directory_fd),
                    self._scope_marker_payload(scope),
                ):
                    raise sqlite3.DatabaseError(
                        "Agent workspace scope marker replay did not commit: "
                        + scope.scope_key
                    )
                return
        if payload is None:
            raise sqlite3.DatabaseError(
                "Agent workspace scope marker is missing from the current baseline: "
                + scope.scope_key
            )
        raise sqlite3.DatabaseError(
            "Agent workspace scope marker does not match the current baseline: "
            + scope.scope_key
        )

    @staticmethod
    def _read_scope_marker(
        marker: Path,
        *,
        allow_missing: bool = False,
        directory_fd: int | None = None,
    ) -> dict[str, Any] | None:
        payload, _ = AgentScopeManager._read_scope_marker_with_identity(
            marker,
            allow_missing=allow_missing,
            directory_fd=directory_fd,
        )
        return payload

    @staticmethod
    def _read_scope_marker_with_identity(
        marker: Path,
        *,
        allow_missing: bool = False,
        directory_fd: int | None = None,
    ) -> tuple[dict[str, Any] | None, tuple[int, int] | None]:
        owns_directory_fd = directory_fd is None
        if directory_fd is None:
            try:
                directory_fd = open_private_directory_fd(marker.parent)
            except UnsafePrivatePathError as exc:
                raise sqlite3.DatabaseError(
                    f"Agent workspace scope marker parent is unsafe: {marker.parent}"
                ) from exc
        try:
            try:
                raw, info = read_private_file_at(
                    directory_fd,
                    marker.name,
                    maximum_bytes=_MAX_SCOPE_MARKER_BYTES,
                )
            except FileNotFoundError as exc:
                if allow_missing:
                    return None, None
                raise sqlite3.DatabaseError(
                    f"Agent workspace scope marker is missing: {marker}"
                ) from exc
            except UnsafePrivatePathError as exc:
                raise sqlite3.DatabaseError(
                    f"Agent workspace scope marker has unsafe file metadata: {marker}"
                ) from exc
        finally:
            if owns_directory_fd:
                os.close(directory_fd)
        return (
            AgentScopeManager._decode_scope_marker(raw, marker),
            (info.st_dev, info.st_ino),
        )

    @staticmethod
    def _decode_scope_marker(raw: bytes, marker: Path) -> dict[str, Any]:
        def closed_object(pairs):
            result: dict[str, Any] = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError(f"duplicate key {key}")
                result[key] = value
            return result

        try:
            payload = json.loads(raw.decode("utf-8"), object_pairs_hook=closed_object)
        except (UnicodeDecodeError, ValueError, TypeError) as exc:
            raise sqlite3.DatabaseError(
                f"Agent workspace scope marker is invalid JSON: {marker}"
            ) from exc
        if not isinstance(payload, dict):
            raise sqlite3.DatabaseError(
                f"Agent workspace scope marker must be an object: {marker}"
            )
        return payload
