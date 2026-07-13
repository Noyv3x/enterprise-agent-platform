from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import tempfile
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Callable, Literal

from .db import Database, encode_json, now_ts


LEGACY_HERMES_MIGRATION_KEY = "migration:hermes-to-pi:v1"

_MIGRATION_VERSION = 1
_MEMORY_ENTRY_DELIMITER = "\n§\n"
_MAX_SCOPES = 10_000
_MAX_MESSAGES_PER_SESSION = 30
_MAX_MESSAGE_CHARACTERS = 20_000
_MAX_SESSION_CHARACTERS = 256_000
_MAX_TOTAL_SESSION_MESSAGES = 100_000
_MAX_TOTAL_SESSION_CONTENT_BYTES = 32 * 1024 * 1024
_MAX_MEMORY_FILE_BYTES = 2 * 1024 * 1024
_MAX_MEMORY_ENTRIES_PER_FILE = 2_000
_MAX_MEMORY_CHARACTERS = 20_000
_MAX_TOTAL_MEMORY_ENTRIES = 100_000
_MAX_TOTAL_MEMORY_BYTES = 64 * 1024 * 1024
_MAX_AUTH_FILE_BYTES = 2 * 1024 * 1024
_MAX_TOKEN_CHARACTERS = 1024 * 1024
_MAX_ATTACHMENTS = 100_000
_MAX_SAFE_JAVASCRIPT_INTEGER = 9_007_199_254_740_991
_SAFE_SCOPE_COMPONENT = re.compile(r"[^A-Za-z0-9_.-]+")


class LegacyMigrationError(RuntimeError):
    """A safe-to-display failure from the offline legacy data migration."""


@dataclass(frozen=True)
class LegacySessionMessage:
    """One bounded visible platform message passed to the session importer."""

    item_hash: str
    source_message_id: int
    role: Literal["user", "assistant"]
    content: str = field(repr=False)
    timestamp: int


@dataclass(frozen=True)
class LegacySessionManifest:
    """One idempotent unit of work for the external Pi session importer."""

    item_hash: str
    scope_key: str
    scope_type: Literal["private", "channel"]
    scope_id: str
    session_id: str
    lifecycle_id: str
    workspace_path: str
    messages: tuple[LegacySessionMessage, ...] = field(repr=False)


@dataclass(frozen=True)
class LegacySessionImportResult:
    """Batch importer outcome, counted in session manifests."""

    imported: int
    skipped: int


@dataclass(frozen=True)
class LegacyMigrationResult:
    """Content-free migration report safe for settings and deployment logs."""

    phase: Literal["prepared", "complete"]
    imported: int = 0
    skipped: int = 0
    session_manifests: int = 0
    session_messages: int = 0
    memories_imported: int = 0
    memories_skipped: int = 0
    oauth_imported: int = 0
    oauth_skipped: int = 0
    oauth_cleared: int = 0
    workspaces_verified: int = 0
    workspaces_skipped: int = 0
    attachments_verified: int = 0
    attachments_skipped: int = 0
    hermes_detected: bool = False
    already_complete: bool = False
    version: int = _MIGRATION_VERSION

    def to_dict(self) -> dict[str, int | bool | str]:
        """Return an explicit allow-list of non-sensitive report fields."""

        return {
            "version": self.version,
            "phase": self.phase,
            "imported": self.imported,
            "skipped": self.skipped,
            "session_manifests": self.session_manifests,
            "session_messages": self.session_messages,
            "memories_imported": self.memories_imported,
            "memories_skipped": self.memories_skipped,
            "oauth_imported": self.oauth_imported,
            "oauth_skipped": self.oauth_skipped,
            "oauth_cleared": self.oauth_cleared,
            "workspaces_verified": self.workspaces_verified,
            "workspaces_skipped": self.workspaces_skipped,
            "attachments_verified": self.attachments_verified,
            "attachments_skipped": self.attachments_skipped,
            "hermes_detected": self.hermes_detected,
            "already_complete": self.already_complete,
        }


SessionImporter = Callable[
    [list[LegacySessionManifest]], LegacySessionImportResult | None
]


@dataclass(frozen=True)
class _Scope:
    scope_key: str
    scope_type: Literal["private", "channel"]
    scope_id: str
    session_id: str
    lifecycle_id: str
    workspace_path: str


@dataclass(frozen=True)
class _MemoryItem:
    item_hash: str
    scope_key: str
    target: Literal["memory", "user"]
    owner_user_id: int | None
    content: str = field(repr=False)
    source_tag: str


@dataclass(frozen=True)
class _OAuthState:
    access_token: str = field(default="", repr=False)
    refresh_token: str = field(default="", repr=False)
    id_token: str = field(default="", repr=False)
    synced_refresh_token: str = field(default="", repr=False)
    relogin_required: bool = False


@dataclass(frozen=True)
class _OAuthSpec:
    provider: str
    access_key: str
    refresh_key: str
    expires_key: str
    id_key: str | None = None

    @property
    def setting_keys(self) -> tuple[str, ...]:
        keys = [self.access_key, self.refresh_key, self.expires_key]
        if self.id_key:
            keys.append(self.id_key)
        return tuple(keys)


_OAUTH_SPECS = (
    _OAuthSpec(
        provider="openai-codex",
        access_key="CODEX_OAUTH_ACCESS_TOKEN",
        refresh_key="CODEX_OAUTH_REFRESH_TOKEN",
        expires_key="CODEX_OAUTH_EXPIRES_AT",
    ),
    _OAuthSpec(
        provider="xai-oauth",
        access_key="GROK_OAUTH_ACCESS_TOKEN",
        refresh_key="GROK_OAUTH_REFRESH_TOKEN",
        expires_key="GROK_OAUTH_EXPIRES_AT",
        id_key="GROK_OAUTH_ID_TOKEN",
    ),
)


def migrate_legacy_hermes_data(
    db: Database,
    data_dir: Path,
    *,
    hermes_home: Path | None = None,
    session_importer: SessionImporter,
) -> LegacyMigrationResult:
    """Migrate durable legacy data while the platform service is stopped.

    Memory and OAuth changes are committed with a ``prepared`` marker before
    the external session importer is called.  The importer receives all session
    manifests in one batch and must use ``item_hash`` to make retries safe.
    Deployment advances the marker to ``complete`` only after Pi activation.

    This function never moves, renames, or deletes the legacy runtime home,
    workspaces, attachment files, or their database rows.  Runtime quarantine
    and removal belong to the deployment cutover that runs after this returns.
    """

    if not callable(session_importer):
        raise TypeError("session_importer must be callable")

    existing = _read_migration_state(db)
    if existing is not None and existing.phase == "complete":
        return replace(existing, already_complete=True)

    data_dir = Path(data_dir).expanduser()
    home = Path(hermes_home).expanduser() if hermes_home is not None else data_dir / "runtimes" / "hermes"
    _materialize_all_legacy_scopes(db, data_dir)
    scopes, manifests, workspace_counts = _build_session_manifests(db, data_dir)
    attachment_counts = _validate_attachments(db, data_dir)

    # ``prepared`` is deliberately non-terminal. If Pi activation later fails,
    # Hermes can run again and rotate OAuth credentials or add memory/messages.
    # Every retry therefore re-reads the stopped legacy runtime. Memory writes
    # are item-hash idempotent and OAuth lineage prevents an older auth.json
    # from overwriting a newer platform login.
    hermes_detected = _validate_legacy_home(home)
    memory_items = _read_memory_items(db, home, scopes) if hermes_detected else []
    oauth_states = _read_oauth_states(home) if hermes_detected else {}
    with db.transaction() as conn:
        conn.execute("BEGIN IMMEDIATE")
        memories_imported, memories_skipped = _apply_memory_items(conn, memory_items)
        oauth_imported, oauth_skipped, oauth_cleared = _apply_oauth_states(
            conn, oauth_states
        )
        prepared = LegacyMigrationResult(
            phase="prepared",
            session_manifests=len(manifests),
            session_messages=sum(len(manifest.messages) for manifest in manifests),
            memories_imported=memories_imported,
            memories_skipped=memories_skipped,
            oauth_imported=oauth_imported,
            oauth_skipped=oauth_skipped,
            oauth_cleared=oauth_cleared,
            workspaces_verified=workspace_counts[0],
            workspaces_skipped=workspace_counts[1],
            attachments_verified=attachment_counts[0],
            attachments_skipped=attachment_counts[1],
            hermes_detected=hermes_detected,
        )
        _write_migration_state(conn, prepared)
    if hermes_detected:
        _synchronize_auth_lineage(db, home, oauth_states)

    try:
        raw_import_result = session_importer(manifests)
        import_result = _normalize_import_result(raw_import_result, len(manifests))
    except Exception:
        # Importer exceptions can contain serialized prompts or credentials.
        # Suppress their text and leave the content-free prepared state intact.
        raise LegacyMigrationError("legacy session import failed") from None

    prepared = replace(
        prepared,
        imported=import_result.imported,
        skipped=import_result.skipped,
        already_complete=False,
    )
    with db.transaction() as conn:
        conn.execute("BEGIN IMMEDIATE")
        _write_migration_state(conn, prepared)
    return prepared


def _materialize_all_legacy_scopes(db: Database, data_dir: Path) -> None:
    """Create migration identities for every durable private/channel history.

    Older databases materialized channel scopes lazily, so a quiet channel can
    have visible messages and Hermes state without an ``agent_scopes`` row.
    The offline migration must enumerate the durable data set, not only scopes
    that happened to run recently.
    """

    private_ids = {
        str(int(row["id"]))
        for row in db.query("SELECT id FROM users WHERE id > 0")
    }
    channel_ids = {
        str(row["id"])
        for row in db.query("SELECT id FROM channels")
        if str(row.get("id") or "").strip()
    }
    for row in db.query(
        "SELECT DISTINCT scope_type, scope_id FROM messages "
        "WHERE scope_type IN ('private', 'channel')"
    ):
        scope_id = str(row.get("scope_id") or "").strip()
        if not scope_id:
            continue
        if str(row.get("scope_type")) == "private":
            try:
                if int(scope_id) > 0:
                    private_ids.add(str(int(scope_id)))
            except ValueError:
                raise LegacyMigrationError("legacy private scope id is invalid") from None
        else:
            channel_ids.add(scope_id)
    if len(private_ids) + len(channel_ids) > _MAX_SCOPES:
        raise LegacyMigrationError("legacy migration scope limit exceeded")

    private_sessions = {
        str(int(row["user_id"])): str(row.get("session_id") or "").strip()
        for row in db.query("SELECT user_id, session_id FROM private_agents")
        if int(row["user_id"]) > 0
    }
    channel_sessions: dict[str, str] = {}
    for row in db.query(
        "SELECT key, value FROM settings WHERE key LIKE 'hermes_session:channel:%:main-agent'"
    ):
        key = str(row.get("key") or "")
        prefix = "hermes_session:channel:"
        suffix = ":main-agent"
        if key.startswith(prefix) and key.endswith(suffix):
            channel_sessions[key[len(prefix) : -len(suffix)]] = str(
                row.get("value") or ""
            ).strip()

    def valid_legacy_session(candidate: str, fallback: str) -> str:
        if (
            candidate
            and len(candidate) <= 512
            and not any(char in candidate for char in "\x00\r\n")
        ):
            return candidate
        return fallback

    timestamp = now_ts()
    candidates = [
        ("private", scope_id) for scope_id in sorted(private_ids, key=int)
    ] + [
        ("channel", scope_id) for scope_id in sorted(channel_ids)
    ]
    with db.transaction() as conn:
        conn.execute("BEGIN IMMEDIATE")
        for scope_type, scope_id in candidates:
            safe_id = _safe_scope_component(scope_id)
            if scope_type == "private":
                scope_key = f"private:{scope_id}"
                workspace = data_dir / "workspaces" / f"user-{scope_id}"
                legacy_session_id = valid_legacy_session(
                    private_sessions.get(scope_id, ""),
                    f"enterprise-private-u{scope_id}",
                )
                runtime_session_id = f"ubitech-private-u{scope_id}"
            else:
                scope_key = f"channel:{scope_id}:main-agent"
                workspace = data_dir / "workspaces" / "channels" / f"channel-{safe_id}"
                legacy_session_id = valid_legacy_session(
                    channel_sessions.get(scope_id, ""),
                    f"enterprise-channel-{safe_id}-main-agent",
                )
                runtime_session_id = f"ubitech-channel-{safe_id}-main-agent"
            lifecycle = hashlib.sha256(
                f"legacy-scope:{_MIGRATION_VERSION}:{scope_key}".encode("utf-8")
            ).hexdigest()[:32]
            runtime_lifecycle = hashlib.sha256(
                f"pi-scope:{_MIGRATION_VERSION}:{scope_key}".encode("utf-8")
            ).hexdigest()[:32]
            conn.execute(
                """
                INSERT OR IGNORE INTO agent_scopes(
                    scope_key, scope_type, scope_id, session_id, lifecycle_id,
                    workspace_path, execution_backend, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'host', ?, ?)
                """,
                (
                    scope_key,
                    scope_type,
                    scope_id,
                    legacy_session_id,
                    lifecycle,
                    str(workspace),
                    timestamp,
                    timestamp,
                ),
            )
            conn.execute(
                """
                INSERT OR IGNORE INTO agent_runtime_scopes(
                    scope_key, session_id, lifecycle_id, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (scope_key, runtime_session_id, runtime_lifecycle, timestamp, timestamp),
            )


def _safe_scope_component(value: str) -> str:
    safe = _SAFE_SCOPE_COMPONENT.sub("-", str(value)).strip(".-") or "default"
    return safe[:80].rstrip(".-") or "default"


def finalize_legacy_hermes_migration(
    db: Database,
    result: LegacyMigrationResult | None = None,
) -> LegacyMigrationResult:
    """Commit the migration only after the deployment activation health gate.

    When recovering an activated cutover after a process crash, the in-memory
    result is unavailable. In that case the content-free prepared state is the
    durable source of truth. Re-finalizing an already complete state is safe.
    """

    current = result if result is not None else _read_migration_state(db)
    if not isinstance(current, LegacyMigrationResult):
        raise LegacyMigrationError("legacy migration cannot be finalized from this state")
    if current.phase == "complete":
        return replace(current, already_complete=True)
    if current.phase != "prepared":
        raise LegacyMigrationError("legacy migration cannot be finalized from this state")
    complete = replace(current, phase="complete", already_complete=False)
    with db.transaction() as conn:
        conn.execute("BEGIN IMMEDIATE")
        _write_migration_state(conn, complete)
    return complete


def _normalize_import_result(
    result: LegacySessionImportResult | None,
    manifest_count: int,
) -> LegacySessionImportResult:
    if result is None:
        return LegacySessionImportResult(imported=manifest_count, skipped=0)
    if not isinstance(result, LegacySessionImportResult):
        raise LegacyMigrationError("session importer returned an invalid result")
    for value in (result.imported, result.skipped):
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise LegacyMigrationError("session importer returned invalid counts")
    if result.imported + result.skipped != manifest_count:
        raise LegacyMigrationError("session importer did not account for every manifest")
    return result


def _build_session_manifests(
    db: Database,
    data_dir: Path,
) -> tuple[list[_Scope], list[LegacySessionManifest], tuple[int, int]]:
    rows = db.query(
        """
        SELECT scopes.scope_key, scopes.scope_type, scopes.scope_id,
               scopes.workspace_path,
               runtime.session_id AS runtime_session_id,
               runtime.lifecycle_id AS runtime_lifecycle_id
        FROM agent_scopes AS scopes
        LEFT JOIN agent_runtime_scopes AS runtime
          ON runtime.scope_key = scopes.scope_key
        ORDER BY scopes.scope_key
        """
    )
    if len(rows) > _MAX_SCOPES:
        raise LegacyMigrationError("legacy migration scope limit exceeded")

    scopes: list[_Scope] = []
    manifests: list[LegacySessionManifest] = []
    workspaces_verified = 0
    workspaces_skipped = 0
    total_messages = 0
    total_content_bytes = 0
    for row in rows:
        scope_type = str(row.get("scope_type") or "")
        if scope_type not in {"private", "channel"}:
            raise LegacyMigrationError("legacy scope has an invalid type")
        scope_key = _bounded_identity(row.get("scope_key"), "scope key")
        scope_id = _bounded_identity(row.get("scope_id"), "scope id")
        session_id = _bounded_identity(row.get("runtime_session_id"), "session id")
        lifecycle_id = _bounded_identity(row.get("runtime_lifecycle_id"), "lifecycle id")
        workspace_path, workspace_exists = _validate_workspace(
            data_dir, row.get("workspace_path")
        )
        if workspace_exists:
            workspaces_verified += 1
        else:
            workspaces_skipped += 1
        scope = _Scope(
            scope_key=scope_key,
            scope_type=scope_type,  # type: ignore[arg-type]
            scope_id=scope_id,
            session_id=session_id,
            lifecycle_id=lifecycle_id,
            workspace_path=workspace_path,
        )
        messages = _bounded_messages(db, scope)
        total_messages += len(messages)
        total_content_bytes += sum(
            len(message.content.encode("utf-8")) for message in messages
        )
        if total_messages > _MAX_TOTAL_SESSION_MESSAGES:
            raise LegacyMigrationError("legacy session message limit exceeded")
        if total_content_bytes > _MAX_TOTAL_SESSION_CONTENT_BYTES:
            raise LegacyMigrationError("legacy session content limit exceeded")
        scopes.append(scope)
        # An empty scope has no Hermes conversation to import. Keeping it in
        # ``scopes`` still makes its memory ownership and workspace explicit,
        # but avoids creating a synthetic empty Pi session journal.
        if not messages:
            continue
        manifest_hash = _stable_hash(
            {
                "migration": _MIGRATION_VERSION,
                "scope_key": scope.scope_key,
                "session_id": scope.session_id,
                "lifecycle_id": scope.lifecycle_id,
                "messages": [message.item_hash for message in messages],
            }
        )
        manifests.append(
            LegacySessionManifest(
                item_hash=manifest_hash,
                scope_key=scope.scope_key,
                scope_type=scope.scope_type,
                scope_id=scope.scope_id,
                session_id=scope.session_id,
                lifecycle_id=scope.lifecycle_id,
                workspace_path=scope.workspace_path,
                messages=tuple(messages),
            )
        )
    return scopes, manifests, (workspaces_verified, workspaces_skipped)


def _bounded_messages(db: Database, scope: _Scope) -> list[LegacySessionMessage]:
    rows = db.query(
        """
        SELECT id, author_type, content, created_at
        FROM messages
        WHERE scope_type = ? AND scope_id = ?
          AND author_type IN ('user', 'agent')
        ORDER BY id DESC
        LIMIT ?
        """,
        (scope.scope_type, scope.scope_id, _MAX_MESSAGES_PER_SESSION),
    )
    remaining = _MAX_SESSION_CHARACTERS
    newest_first: list[LegacySessionMessage] = []
    for row in rows:
        content = str(row.get("content") or "")
        if not content.strip() or remaining <= 0:
            continue
        bounded = content[: min(_MAX_MESSAGE_CHARACTERS, remaining)]
        remaining -= len(bounded)
        source_id = int(row["id"])
        role: Literal["user", "assistant"] = (
            "assistant" if str(row.get("author_type")) == "agent" else "user"
        )
        timestamp = _timestamp_milliseconds(row.get("created_at"))
        item_hash = _stable_hash(
            {
                "migration": _MIGRATION_VERSION,
                "scope_key": scope.scope_key,
                "source_message_id": source_id,
                "role": role,
                "content": bounded,
                "timestamp": timestamp,
            }
        )
        newest_first.append(
            LegacySessionMessage(
                item_hash=item_hash,
                source_message_id=source_id,
                role=role,
                content=bounded,
                timestamp=timestamp,
            )
        )
    return list(reversed(newest_first))


def _timestamp_milliseconds(value: object) -> int:
    try:
        timestamp = max(0, int(value))
    except (TypeError, ValueError):
        return 0
    milliseconds = timestamp if timestamp >= 10_000_000_000 else timestamp * 1000
    return min(milliseconds, _MAX_SAFE_JAVASCRIPT_INTEGER)


def _bounded_identity(value: object, label: str) -> str:
    clean = str(value or "").strip()
    if not clean or len(clean) > 512 or any(char in clean for char in "\x00\r\n"):
        raise LegacyMigrationError(f"legacy {label} is invalid")
    return clean


def _validate_workspace(data_dir: Path, raw_path: object) -> tuple[str, bool]:
    clean = str(raw_path or "").strip()
    if not clean or "\x00" in clean:
        raise LegacyMigrationError("legacy workspace path is invalid")
    root = _absolute_path(data_dir / "workspaces")
    candidate = _absolute_path(Path(clean).expanduser())
    _require_lexically_below(root, candidate, "workspace")
    _reject_symlink_components(root, candidate, "workspace")
    try:
        resolved_root = root.resolve(strict=False)
        resolved_candidate = candidate.resolve(strict=False)
        resolved_candidate.relative_to(resolved_root)
    except (OSError, ValueError):
        raise LegacyMigrationError("legacy workspace path is outside managed storage") from None
    try:
        info = candidate.lstat()
    except FileNotFoundError:
        return str(resolved_candidate), False
    except OSError:
        raise LegacyMigrationError("legacy workspace could not be validated") from None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise LegacyMigrationError("legacy workspace is not a regular directory")
    return str(resolved_candidate), True


def _validate_attachments(db: Database, data_dir: Path) -> tuple[int, int]:
    count = int(db.scalar("SELECT count(*) FROM attachments") or 0)
    if count > _MAX_ATTACHMENTS:
        raise LegacyMigrationError("legacy attachment validation limit exceeded")
    rows = db.query("SELECT storage_path, size_bytes FROM attachments ORDER BY id")
    root = _absolute_path(data_dir / "attachments")
    if _is_symlink(root):
        raise LegacyMigrationError("legacy attachment root must not be a symlink")
    verified = 0
    skipped = 0
    for row in rows:
        storage_path = str(row.get("storage_path") or "")
        relative = Path(storage_path)
        if (
            not storage_path
            or "\x00" in storage_path
            or relative.is_absolute()
            or ".." in relative.parts
        ):
            raise LegacyMigrationError("legacy attachment path is invalid")
        candidate = _absolute_path(root / relative)
        _require_lexically_below(root, candidate, "attachment")
        _reject_symlink_components(root, candidate, "attachment")
        try:
            info = candidate.lstat()
        except FileNotFoundError:
            skipped += 1
            continue
        except OSError:
            raise LegacyMigrationError("legacy attachment could not be validated") from None
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            raise LegacyMigrationError("legacy attachment is not a regular file")
        try:
            expected_size = int(row.get("size_bytes"))
        except (TypeError, ValueError):
            expected_size = -1
        if expected_size < 0 or info.st_size != expected_size:
            skipped += 1
        else:
            verified += 1
    return verified, skipped


def _validate_legacy_home(home: Path) -> bool:
    try:
        info = home.lstat()
    except FileNotFoundError:
        return False
    except OSError:
        raise LegacyMigrationError("legacy runtime home could not be validated") from None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise LegacyMigrationError("legacy runtime home is not a regular directory")
    return True


def _read_memory_items(
    db: Database,
    home: Path,
    scopes: list[_Scope],
) -> list[_MemoryItem]:
    user_ids = {
        int(row["id"])
        for row in db.query("SELECT id FROM users")
        if int(row["id"]) > 0
    }
    items: list[_MemoryItem] = []
    total_bytes = 0

    def read_entries(path: Path) -> list[str]:
        nonlocal total_bytes
        payload = _read_regular_bytes(
            home,
            path,
            _MAX_MEMORY_FILE_BYTES,
            "legacy memory file",
        )
        if payload is None:
            return []
        total_bytes += len(payload)
        if total_bytes > _MAX_TOTAL_MEMORY_BYTES:
            raise LegacyMigrationError("legacy memory total limit exceeded")
        try:
            text = payload.decode("utf-8").replace("\r\n", "\n")
        except UnicodeDecodeError:
            raise LegacyMigrationError("legacy memory file is not valid UTF-8") from None
        entries = [part.strip() for part in text.split(_MEMORY_ENTRY_DELIMITER)]
        entries = [entry for entry in entries if entry]
        if len(entries) > _MAX_MEMORY_ENTRIES_PER_FILE:
            raise LegacyMigrationError("legacy memory entry limit exceeded")
        return entries

    def append_entries(
        scope: _Scope,
        filename: str,
        source_tag: str,
        entries: list[str],
    ) -> None:
        for content in entries:
            if len(content) > _MAX_MEMORY_CHARACTERS or "\x00" in content:
                raise LegacyMigrationError("legacy memory entry is invalid")
            if len(items) >= _MAX_TOTAL_MEMORY_ENTRIES:
                raise LegacyMigrationError("legacy memory total limit exceeded")
            target: Literal["memory", "user"] = "memory"
            owner_user_id: int | None = None
            if filename == "USER.md" and scope.scope_type == "private":
                try:
                    candidate_owner = int(scope.scope_id)
                except ValueError:
                    candidate_owner = 0
                if candidate_owner in user_ids:
                    target = "user"
                    owner_user_id = candidate_owner
            item_hash = _stable_hash(
                {
                    "migration": _MIGRATION_VERSION,
                    "scope_key": scope.scope_key,
                    "target": target,
                    "owner_user_id": owner_user_id,
                    "source": source_tag,
                    "content": content,
                }
            )
            items.append(
                _MemoryItem(
                    item_hash=item_hash,
                    scope_key=scope.scope_key,
                    target=target,
                    owner_user_id=owner_user_id,
                    content=content,
                    source_tag=source_tag,
                )
            )

    for scope in scopes:
        memory_dir = home / "memories" / "agents" / _memory_scope_dir_name(scope.scope_key)
        for filename, source_tag in (
            ("MEMORY.md", "memory"),
            ("USER.md", "user-profile"),
        ):
            append_entries(
                scope,
                filename,
                source_tag,
                read_entries(memory_dir / filename),
            )

    # Before per-Agent scoping existed Hermes stored one profile-level pair.
    # The compatibility files predate per-Agent scoping. Attribute them to the
    # earliest administrator (or earliest user when no administrator exists),
    # which matches the original single-owner bootstrap model without copying
    # potentially private profile data into every member's scope.
    global_files = [
        ("MEMORY.md", "legacy-global-memory", read_entries(home / "memories" / "MEMORY.md")),
        ("USER.md", "legacy-global-user-profile", read_entries(home / "memories" / "USER.md")),
    ]
    if any(entries for _, _, entries in global_files):
        global_scope = _global_memory_scope(db, scopes)
        if global_scope is None:
            raise LegacyMigrationError(
                "legacy global memory has no platform user scope"
            )
        for filename, source_tag, entries in global_files:
            append_entries(global_scope, filename, source_tag, entries)
    return items


def _global_memory_scope(db: Database, scopes: list[_Scope]) -> _Scope | None:
    private_by_id = {
        scope.scope_id: scope for scope in scopes if scope.scope_type == "private"
    }
    rows = db.query(
        "SELECT id, role FROM users WHERE id > 0 ORDER BY created_at, id"
    )
    for role in ("admin", None):
        for row in rows:
            if role is not None and str(row.get("role") or "") != role:
                continue
            scope = private_by_id.get(str(int(row["id"])))
            if scope is not None:
                return scope
    return None


def _apply_memory_items(conn, items: list[_MemoryItem]) -> tuple[int, int]:
    imported = 0
    skipped = 0
    timestamp = now_ts()
    for item in items:
        marker = f"migration-item:{item.item_hash}"
        row = conn.execute(
            """
            SELECT id FROM agent_memories
            WHERE scope_key = ? AND target = ? AND owner_user_id IS ?
              AND (content = ? OR tags_json LIKE ?)
            LIMIT 1
            """,
            (
                item.scope_key,
                item.target,
                item.owner_user_id,
                item.content,
                f'%"{marker}"%',
            ),
        ).fetchone()
        if row is not None:
            skipped += 1
            continue
        tags_json = encode_json(
            ["migration:runtime-v1", f"source:{item.source_tag}", marker]
        )
        conn.execute(
            """
            INSERT INTO agent_memories(
                scope_key, target, owner_user_id, content, tags_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                item.scope_key,
                item.target,
                item.owner_user_id,
                item.content,
                tags_json,
                timestamp,
                timestamp,
            ),
        )
        imported += 1
    return imported, skipped


def _memory_scope_dir_name(scope_key: str) -> str:
    digest = hashlib.sha256(scope_key.encode("utf-8")).hexdigest()[:12]
    safe = _SAFE_SCOPE_COMPONENT.sub("-", scope_key).strip(".-") or "agent"
    if len(safe) > 80:
        safe = safe[:80].rstrip(".-") or "agent"
    return f"{safe}-{digest}"


def _read_oauth_states(home: Path) -> dict[str, _OAuthState]:
    payload = _read_regular_bytes(
        home,
        home / "auth.json",
        _MAX_AUTH_FILE_BYTES,
        "legacy OAuth store",
    )
    if payload is None:
        return {}
    try:
        document = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise LegacyMigrationError("legacy OAuth store is malformed") from None
    if not isinstance(document, dict):
        raise LegacyMigrationError("legacy OAuth store is malformed")
    providers = document.get("providers", {})
    if not isinstance(providers, dict):
        raise LegacyMigrationError("legacy OAuth store is malformed")

    result: dict[str, _OAuthState] = {}
    for spec in _OAUTH_SPECS:
        if spec.provider not in providers:
            continue
        raw_state = providers[spec.provider]
        if not isinstance(raw_state, dict):
            raise LegacyMigrationError("legacy OAuth provider state is malformed")
        raw_tokens = raw_state.get("tokens", {})
        if not isinstance(raw_tokens, dict):
            raise LegacyMigrationError("legacy OAuth provider tokens are malformed")
        last_error = raw_state.get("last_auth_error")
        if last_error is not None and not isinstance(last_error, dict):
            raise LegacyMigrationError("legacy OAuth provider error state is malformed")
        result[spec.provider] = _OAuthState(
            access_token=_optional_token(raw_tokens, "access_token"),
            refresh_token=_optional_token(raw_tokens, "refresh_token"),
            id_token=_optional_token(raw_tokens, "id_token"),
            synced_refresh_token=_optional_token(
                raw_state, "platform_synced_refresh_token"
            ),
            relogin_required=bool(
                isinstance(last_error, dict)
                and last_error.get("relogin_required") is True
            ),
        )
    return result


def _optional_token(mapping: dict[object, object], key: str) -> str:
    value = mapping.get(key)
    if value is None:
        return ""
    if not isinstance(value, str):
        raise LegacyMigrationError("legacy OAuth token value is malformed")
    clean = value.strip()
    if len(clean) > _MAX_TOKEN_CHARACTERS or any(char in clean for char in "\x00\r\n"):
        raise LegacyMigrationError("legacy OAuth token value is malformed")
    return clean


def _apply_oauth_states(
    conn,
    states: dict[str, _OAuthState],
) -> tuple[int, int, int]:
    imported = 0
    skipped = 0
    cleared = 0
    timestamp = now_ts()
    for spec in _OAUTH_SPECS:
        state = states.get(spec.provider, _OAuthState())
        rows = conn.execute(
            f"SELECT key, value FROM settings WHERE key IN ({','.join('?' for _ in spec.setting_keys)})",
            spec.setting_keys,
        ).fetchall()
        current = {str(row["key"]): str(row["value"] or "") for row in rows}
        db_access = current.get(spec.access_key, "").strip()
        db_refresh = current.get(spec.refresh_key, "").strip()

        if (
            state.relogin_required
            and state.synced_refresh_token
            and db_refresh == state.synced_refresh_token
        ):
            if rows:
                conn.execute(
                    f"DELETE FROM settings WHERE key IN ({','.join('?' for _ in spec.setting_keys)})",
                    spec.setting_keys,
                )
                cleared += 1
            else:
                skipped += 1
            continue

        auth_complete = bool(state.access_token and state.refresh_token)
        db_complete = bool(db_access and db_refresh)
        if not auth_complete:
            skipped += 1
            continue

        auth_is_authoritative = False
        if not db_complete:
            auth_is_authoritative = True
        elif state.synced_refresh_token:
            # Matching the last platform-synced refresh token means auth.json
            # owns any subsequent access/refresh rotation.  A different DB
            # refresh token is a newer interactive login and must win.
            auth_is_authoritative = db_refresh in {
                state.synced_refresh_token,
                state.refresh_token,
            }
        else:
            # Before lineage markers existed, only a matching refresh token can
            # safely let auth.json refresh the associated access/ID token.
            auth_is_authoritative = db_refresh == state.refresh_token

        if not auth_is_authoritative:
            skipped += 1
            continue

        current_id = current.get(spec.id_key, "").strip() if spec.id_key else ""
        token_changed = (
            db_access != state.access_token
            or db_refresh != state.refresh_token
            or (spec.id_key is not None and current_id != state.id_token)
        )
        if not token_changed and db_complete:
            skipped += 1
            continue

        _upsert_setting(conn, spec.access_key, state.access_token, True, timestamp)
        _upsert_setting(conn, spec.refresh_key, state.refresh_token, True, timestamp)
        if spec.id_key:
            if state.id_token:
                _upsert_setting(conn, spec.id_key, state.id_token, True, timestamp)
            else:
                conn.execute("DELETE FROM settings WHERE key = ?", (spec.id_key,))
        # The legacy expiry representation is not portable.  Force the new
        # runtime to validate/refresh the imported coherent credential pair.
        _upsert_setting(conn, spec.expires_key, "0", False, timestamp)
        imported += 1
    return imported, skipped, cleared


def _synchronize_auth_lineage(
    db: Database,
    home: Path,
    states: dict[str, _OAuthState],
) -> None:
    """Record which refresh token is now durably synchronized with SQLite.

    The stopped Hermes runtime may be restored after a failed activation. By
    advancing its lineage marker after a coherent token pair is copied to the
    platform DB, a later Hermes rotation remains distinguishable from a newer
    interactive platform login on the next migration attempt.
    """

    auth_path = home / "auth.json"
    payload = _read_regular_bytes(home, auth_path, _MAX_AUTH_FILE_BYTES, "legacy OAuth store")
    if payload is None:
        return
    try:
        document = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise LegacyMigrationError("legacy OAuth store is malformed") from None
    if not isinstance(document, dict) or not isinstance(document.get("providers", {}), dict):
        raise LegacyMigrationError("legacy OAuth store is malformed")
    providers = document["providers"]
    changed = False
    for spec in _OAUTH_SPECS:
        state = states.get(spec.provider)
        raw_provider = providers.get(spec.provider)
        if state is None or not state.access_token or not state.refresh_token or not isinstance(raw_provider, dict):
            continue
        row = db.query_one("SELECT value FROM settings WHERE key = ?", (spec.refresh_key,))
        db_refresh = str(row["value"] or "").strip() if row else ""
        if db_refresh != state.refresh_token:
            continue
        if raw_provider.get("platform_synced_refresh_token") == db_refresh:
            continue
        raw_provider["platform_synced_refresh_token"] = db_refresh
        changed = True
    if changed:
        _write_regular_json_atomic(home, auth_path, document, "legacy OAuth store")


def _write_regular_json_atomic(
    home: Path,
    path: Path,
    document: object,
    label: str,
) -> None:
    _require_path_under_home(home, path, label)
    _reject_symlink_components(home, path.parent, label)
    encoded = (json.dumps(document, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    if len(encoded) > _MAX_AUTH_FILE_BYTES:
        raise LegacyMigrationError(f"{label} is too large")
    temporary: Path | None = None
    descriptor: int | None = None
    try:
        # mkstemp chooses an unpredictable name and uses O_EXCL internally,
        # retrying candidate collisions instead of reusing a PID/timestamp
        # name that a crashed migration may have left behind.
        descriptor, raw_temporary = tempfile.mkstemp(
            prefix=f".{path.name}.",
            suffix=".tmp",
            dir=path.parent,
        )
        temporary = Path(raw_temporary)
        try:
            os.fchmod(descriptor, 0o600)
            handle = os.fdopen(descriptor, "wb")
            descriptor = None
            with handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
            directory = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if descriptor is not None:
                os.close(descriptor)
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    except OSError:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
        raise LegacyMigrationError(f"{label} could not be updated safely") from None


def _upsert_setting(
    conn,
    key: str,
    value: str,
    secret: bool,
    timestamp: int,
) -> None:
    conn.execute(
        """
        INSERT INTO settings(key, value, secret, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            secret = excluded.secret,
            updated_at = excluded.updated_at
        """,
        (key, value, 1 if secret else 0, timestamp),
    )


def _read_migration_state(db: Database) -> LegacyMigrationResult | None:
    row = db.query_one(
        "SELECT value FROM settings WHERE key = ?",
        (LEGACY_HERMES_MIGRATION_KEY,),
    )
    if row is None:
        return None
    try:
        document = json.loads(str(row["value"]))
    except (TypeError, json.JSONDecodeError):
        raise LegacyMigrationError("legacy migration state is malformed") from None
    if not isinstance(document, dict):
        raise LegacyMigrationError("legacy migration state is malformed")
    phase = document.get("phase")
    if phase not in {"prepared", "complete"}:
        raise LegacyMigrationError("legacy migration state has an invalid phase")
    version = document.get("version", _MIGRATION_VERSION)
    if version != _MIGRATION_VERSION:
        raise LegacyMigrationError("legacy migration state has an unsupported version")

    numeric_fields = (
        "imported",
        "skipped",
        "session_manifests",
        "session_messages",
        "memories_imported",
        "memories_skipped",
        "oauth_imported",
        "oauth_skipped",
        "oauth_cleared",
        "workspaces_verified",
        "workspaces_skipped",
        "attachments_verified",
        "attachments_skipped",
    )
    counts: dict[str, int] = {}
    for name in numeric_fields:
        value = document.get(name, 0)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise LegacyMigrationError("legacy migration state has invalid counts")
        counts[name] = value
    hermes_detected = document.get("hermes_detected", False)
    if not isinstance(hermes_detected, bool):
        raise LegacyMigrationError("legacy migration state is malformed")
    return LegacyMigrationResult(
        phase=phase,
        hermes_detected=hermes_detected,
        already_complete=phase == "complete",
        **counts,
    )


def _write_migration_state(conn, result: LegacyMigrationResult) -> None:
    document = result.to_dict()
    document.pop("already_complete", None)
    _upsert_setting(
        conn,
        LEGACY_HERMES_MIGRATION_KEY,
        encode_json(document),
        False,
        now_ts(),
    )


def _read_regular_bytes(
    home: Path,
    path: Path,
    maximum_bytes: int,
    label: str,
) -> bytes | None:
    _require_path_under_home(home, path, label)
    _reject_symlink_components(home, path.parent, label)
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except FileNotFoundError:
        return None
    except OSError:
        raise LegacyMigrationError(f"{label} could not be opened safely") from None
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > maximum_bytes:
            raise LegacyMigrationError(f"{label} is invalid or too large")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            payload = stream.read(maximum_bytes + 1)
        if len(payload) > maximum_bytes:
            raise LegacyMigrationError(f"{label} is too large")
        return payload
    finally:
        os.close(descriptor)


def _require_path_under_home(home: Path, path: Path, label: str) -> None:
    absolute_home = _absolute_path(home)
    absolute_path = _absolute_path(path)
    _require_lexically_below(absolute_home, absolute_path, label)
    try:
        resolved_home = absolute_home.resolve(strict=False)
        resolved_path = absolute_path.resolve(strict=False)
        resolved_path.relative_to(resolved_home)
    except (OSError, ValueError):
        raise LegacyMigrationError(f"{label} resolves outside the legacy runtime home") from None


def _require_lexically_below(root: Path, candidate: Path, label: str) -> None:
    try:
        candidate.relative_to(root)
    except ValueError:
        raise LegacyMigrationError(f"{label} path is outside managed storage") from None


def _reject_symlink_components(root: Path, candidate: Path, label: str) -> None:
    absolute_root = _absolute_path(root)
    absolute_candidate = _absolute_path(candidate)
    _require_lexically_below(absolute_root, absolute_candidate, label)
    if _is_symlink(absolute_root):
        raise LegacyMigrationError(f"{label} path contains a symlink")
    current = absolute_root
    for component in absolute_candidate.relative_to(absolute_root).parts:
        current = current / component
        try:
            if stat.S_ISLNK(current.lstat().st_mode):
                raise LegacyMigrationError(f"{label} path contains a symlink")
        except FileNotFoundError:
            return
        except LegacyMigrationError:
            raise
        except OSError:
            raise LegacyMigrationError(f"{label} path could not be validated") from None


def _is_symlink(path: Path) -> bool:
    try:
        return stat.S_ISLNK(path.lstat().st_mode)
    except FileNotFoundError:
        return False
    except OSError:
        raise LegacyMigrationError("managed path could not be validated") from None


def _absolute_path(path: Path) -> Path:
    return Path(os.path.abspath(os.fspath(path)))


def _stable_hash(value: object) -> str:
    payload = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()
