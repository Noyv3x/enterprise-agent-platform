from __future__ import annotations

import base64
import binascii
import fcntl
import hashlib
import json
import os
import re
import secrets
import shutil
import stat
import threading
import unicodedata
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, Sequence

from .prompt_security import prompt_threat_reasons
from .secure_fs import (
    UnsafePrivatePathError,
    ensure_private_directory,
    open_private_child_directory_fd,
    open_private_directory_fd,
    verify_private_child_directory_fd,
)


MAX_SKILLS_PER_SCOPE = 100
MAX_SKILL_LIST_RESULTS = MAX_SKILLS_PER_SCOPE * 2
MAX_NAME_CHARS = 64
MAX_DESCRIPTION_CHARS = 1024
MAX_INSTRUCTIONS_BYTES = 64 * 1024
MAX_TAGS = 20
MAX_SUPPORT_FILES = 64
MAX_SUPPORT_DIRECTORIES = MAX_SUPPORT_FILES
MAX_SUPPORT_FILE_BYTES = 512 * 1024
MAX_SUPPORT_TOTAL_BYTES = 5 * 1024 * 1024
DEFAULT_PROMPT_INDEX_CHARS = 32 * 1024
PROMPT_DESCRIPTION_CHARS = 240
MAX_SKILL_QUERY_CHARS = 4000
MAX_PATCH_REPLACEMENTS = 10_000

SUPPORT_DIRECTORIES = frozenset({"references", "templates", "scripts", "assets"})
BUNDLED_METADATA_FILES = frozenset(
    {
        "ATTRIBUTION.md",
        "LICENSE",
        "LICENSE.md",
        "NOTICE",
        "NOTICE.md",
    }
)
DEFAULT_BUNDLED_SKILLS_DIR = Path(__file__).with_name("bundled_skills")
_SKILL_ID_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
_SUPPORT_WRITE_ORPHAN_RE = re.compile(r"^\..+\.[0-9a-f]{16}\.tmp$")
_FRONTMATTER_KEYS = ("name", "description", "version", "category", "tags")
_MAX_SKILL_DOCUMENT_BYTES = MAX_INSTRUCTIONS_BYTES + 16 * 1024
_MAX_SIDECAR_BYTES = 16 * 1024
_MAX_USAGE_STATE_BYTES = 128 * 1024
_USAGE_STATE_FILE = ".skill-usage.json"
_USAGE_CREATED_BY = frozenset({"user", "agent"})
_USAGE_STATES = frozenset({"active", "stale", "archived"})
_PREFIXED_CREDENTIAL_RE = re.compile(
    r"(?<![A-Za-z0-9])(?:"
    r"sk-proj-[A-Za-z0-9_-]{16,512}|"
    r"github_pat_[A-Za-z0-9_]{20,512}|"
    r"gh[pousr]_[A-Za-z0-9]{20,255}|"
    r"glpat-[A-Za-z0-9_-]{20,255}"
    r")(?![A-Za-z0-9_-])"
)
_PRIVATE_KEY_BLOCK_RE = re.compile(
    r"-----BEGIN (?P<label>(?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----"
    r"(?P<body>[A-Za-z0-9+/=\r\n\t ]{64,32768}?)"
    r"-----END (?P=label)-----"
)
_BEARER_CREDENTIAL_RE = re.compile(
    r"\bbearer[ \t]+(?P<value>[A-Za-z0-9][A-Za-z0-9._~+/=-]{19,2047})",
    re.IGNORECASE,
)
_BEARER_PLACEHOLDER_RE = re.compile(
    r"^(?:your|example|sample|placeholder|redacted|replace|token|access[_-]?token)",
    re.IGNORECASE,
)


class SkillStoreError(RuntimeError):
    """A storage error that can be mapped directly to an HTTP response."""

    def __init__(self, status: int, message: str, *, code: str = "skill_error"):
        super().__init__(message)
        self.status = int(status)
        self.status_code = self.status
        self.message = message
        self.code = code


# A concise alias is useful to callers that expose these errors at an API edge.
SkillError = SkillStoreError


class SkillStore:
    """Filesystem-backed, per-Agent Skill packages with bundled defaults.

    User packages live below the current scope's workspace at
    ``.agent-platform/skills``. The package's ``SKILL.md`` is portable; the
    Platform lifecycle state lives outside the Agent-mounted workspace.

    Repository-owned packages below ``bundled_skills`` are a global, read-only
    layer. They are visible in every scope without copying release files into
    mutable platform data. A user Skill with the same id or case-insensitive
    name shadows the bundled package, so upgrades never overwrite user work.
    """

    def __init__(
        self,
        workspace_root: Path | str,
        workspace_for_scope: Callable[[str], Path | str],
        *,
        state_root: Path | str | None = None,
        bundled_skills_dir: Path | str | None = DEFAULT_BUNDLED_SKILLS_DIR,
    ):
        requested_workspace_root = Path(workspace_root).expanduser()
        try:
            self.workspace_root = ensure_private_directory(
                requested_workspace_root
            ).resolve(strict=True)
        except (OSError, RuntimeError) as exc:
            raise SkillStoreError(
                500,
                f"cannot prepare Skill storage: {exc}",
                code="skill_storage_unavailable",
            ) from exc
        self._workspace_for_scope = workspace_for_scope
        requested_state_root = (
            Path(state_root).expanduser()
            if state_root is not None
            else self.workspace_root.parent / "agent-skill-state"
        )
        try:
            self.state_root = ensure_private_directory(requested_state_root).resolve(
                strict=True
            )
            try:
                self.state_root.relative_to(self.workspace_root)
            except ValueError:
                pass
            else:
                raise RuntimeError("Skill state storage must be outside workspaces")
        except (OSError, RuntimeError) as exc:
            raise SkillStoreError(
                500,
                f"cannot prepare Skill state storage: {exc}",
                code="skill_storage_unavailable",
            ) from exc
        self._scope_locks_guard = threading.Lock()
        self._scope_thread_locks: dict[str, threading.RLock] = {}
        self._operation = threading.local()
        self._bundled_root: Path | None = None
        self._bundled_records: dict[str, dict[str, Any]] = {}
        self._bundled_skill_dirs: dict[str, Path] = {}
        if bundled_skills_dir is not None:
            self._load_bundled_catalog(Path(bundled_skills_dir).expanduser())

    def list(
        self,
        scope_key: str,
        *,
        query: str | None = None,
        category: str | None = None,
        limit: int = MAX_SKILL_LIST_RESULTS,
    ) -> list[dict[str, Any]]:
        """Return metadata for every Skill, including disabled Skills."""

        query_filter: str | None = None
        if query is not None:
            if not isinstance(query, str):
                raise SkillStoreError(
                    400,
                    "query must be a string",
                    code="invalid_skill_query",
                )
            if len(query) > MAX_SKILL_QUERY_CHARS:
                raise SkillStoreError(
                    400,
                    f"query may contain at most {MAX_SKILL_QUERY_CHARS} characters",
                    code="invalid_skill_query",
                )
            _reject_surrogates(
                query,
                "query",
                code="invalid_skill_query",
            )
            query_filter = query.strip().casefold() or None
        category_filter: str | None = None
        if category is not None:
            if not isinstance(category, str):
                raise SkillStoreError(
                    400,
                    "category must be a string",
                    code="invalid_skill_query",
                )
            normalized_category = category.strip()
            if normalized_category:
                category_filter = _validate_scalar(
                    normalized_category,
                    "category",
                    max_chars=64,
                ).casefold()
        if (
            isinstance(limit, bool)
            or not isinstance(limit, int)
            or not 1 <= limit <= MAX_SKILL_LIST_RESULTS
        ):
            raise SkillStoreError(
                400,
                f"limit must be between 1 and {MAX_SKILL_LIST_RESULTS}",
                code="invalid_skill_limit",
            )
        with self._locked_scope(scope_key) as scope_dir:
            user_records = [
                self._read_record(skill_dir, include_instructions=False)
                for skill_dir in self._iter_skill_dirs(scope_dir)
            ]
        shadowed_ids = {str(record["id"]) for record in user_records}
        shadowed_names = {
            str(record["name"]).casefold()
            for record in user_records
        }
        records = [
            *user_records,
            *(
                _copy_skill_record(record)
                for skill_id, record in self._bundled_records.items()
                if skill_id not in shadowed_ids
                and str(record["name"]).casefold() not in shadowed_names
            ),
        ]
        if category_filter is not None:
            records = [
                record
                for record in records
                if str(record["category"]).casefold() == category_filter
            ]
        if query_filter is not None:
            records = [
                record
                for record in records
                if query_filter
                in "\n".join(
                    (
                        str(record["id"]),
                        str(record["name"]),
                        str(record["description"]),
                        str(record["category"]),
                        str(record["source"]),
                        *(str(tag) for tag in record["tags"]),
                    )
                ).casefold()
            ]
        records.sort(
            key=lambda item: (
                str(item["category"]).casefold(),
                str(item["name"]).casefold(),
                str(item["id"]),
            )
        )
        return records[:limit]

    def get(self, scope_key: str, skill_id: str) -> dict[str, Any]:
        """Return Skill metadata without loading its instructions."""

        normalized_id = _validate_skill_id(skill_id)
        with self._locked_scope(scope_key) as scope_dir:
            skill_dir = self._find_skill_dir(scope_dir, normalized_id)
            if skill_dir is not None:
                return self._read_record(skill_dir, include_instructions=False)
            bundled = self._visible_bundled_record(scope_dir, normalized_id)
            if bundled is not None:
                return _copy_skill_record(bundled)
        raise SkillStoreError(
            404,
            f"Skill not found: {normalized_id}",
            code="skill_not_found",
        )

    def load(self, scope_key: str, skill_id: str) -> dict[str, Any]:
        """Load a complete Skill and the absolute directory for its resources."""

        normalized_id = _validate_skill_id(skill_id)
        with self._locked_scope(scope_key) as scope_dir:
            skill_dir = self._find_skill_dir(scope_dir, normalized_id)
            if skill_dir is not None:
                record = self._read_record(skill_dir, include_instructions=True)
                self._bump_usage(scope_dir, normalized_id, event="use")
                return record
            if self._visible_bundled_record(scope_dir, normalized_id) is not None:
                return self._read_bundled_record(
                    self._bundled_skill_dirs[normalized_id],
                    include_instructions=True,
                )
        raise SkillStoreError(
            404,
            f"Skill not found: {normalized_id}",
            code="skill_not_found",
        )

    def create(
        self,
        scope_key: str,
        *,
        name: str,
        description: str,
        instructions: str,
        version: str | None = "1.0.0",
        category: str | None = "general",
        tags: Sequence[str] | None = None,
        enabled: bool = True,
        created_by: str = "user",
    ) -> dict[str, Any]:
        """Atomically create a new Skill package."""

        document = _validated_document(
            name=name,
            description=description,
            instructions=instructions,
            version="1.0.0" if version is None else version,
            category="general" if category is None else category,
            tags=tags,
        )
        if not isinstance(enabled, bool):
            raise SkillStoreError(
                400,
                "enabled must be a boolean",
                code="invalid_skill",
            )
        normalized_created_by = _validate_created_by(created_by)

        with self._locked_scope(scope_key) as scope_dir:
            usage_state, old_usage_bytes = self._read_usage_state_snapshot(scope_dir)
            existing_dirs = list(self._iter_skill_dirs(scope_dir))
            if len(existing_dirs) >= MAX_SKILLS_PER_SCOPE:
                raise SkillStoreError(
                    413,
                    f"a scope may contain at most {MAX_SKILLS_PER_SCOPE} Skills",
                    code="skill_quota_exceeded",
                )
            self._ensure_unique_name(
                existing_dirs,
                str(document["name"]),
            )
            skill_id = self._new_skill_id(scope_dir, str(document["name"]))
            if normalized_created_by == "agent":
                self._reject_agent_bundled_conflict(
                    skill_id=skill_id,
                    name=str(document["name"]),
                )
            now = _utc_now()
            sidecar = {
                "schema_version": 1,
                "id": skill_id,
                "enabled": enabled,
                "created_at": now,
                "updated_at": now,
            }
            scope_fd = self._operation.paths[str(scope_dir)]
            staging_name = f".create-{skill_id}-{secrets.token_hex(6)}"
            staging_dir: Path | None = None
            target_created = False

            def rollback_package() -> None:
                if staging_dir is None:
                    return
                entry_name = skill_id if target_created else staging_name
                try:
                    _remove_pinned_directory_entry(
                        scope_fd,
                        entry_name,
                        self._operation.paths[str(staging_dir)],
                    )
                except (OSError, UnsafePrivatePathError):
                    pass
                if target_created:
                    self._restore_usage_state(scope_dir, old_usage_bytes)
                    _remove_tree_quietly(self._state_directory() / skill_id)

            try:
                os.mkdir(staging_name, mode=0o700, dir_fd=scope_fd)
                staging_dir = self._pin_child_directory(scope_dir, staging_name)
                _atomic_write_bytes(
                    staging_dir / "SKILL.md",
                    _render_skill_document(document).encode("utf-8"),
                )
                staging_fd = self._operation.paths[str(staging_dir)]
                verify_private_child_directory_fd(
                    scope_fd,
                    staging_name,
                    staging_fd,
                    mode=None,
                )
                os.rename(
                    staging_name,
                    skill_id,
                    src_dir_fd=scope_fd,
                    dst_dir_fd=scope_fd,
                )
                target_created = True
                verify_private_child_directory_fd(
                    scope_fd,
                    skill_id,
                    staging_fd,
                    mode=None,
                )
                _fsync_directory(scope_dir)
                created_skill_dir = staging_dir
                self._operation.skill_ids[str(created_skill_dir)] = skill_id
                package_info = os.fstat(staging_fd)
                sidecar["package_dev"] = int(package_info.st_dev)
                sidecar["package_ino"] = int(package_info.st_ino)
                sidecar["package_ctime_ns"] = int(package_info.st_ctime_ns)
                state_skill_dir = ensure_private_directory(
                    self._state_directory() / skill_id
                )
                _atomic_write_bytes(
                    state_skill_dir / ".skill.json",
                    _render_sidecar(sidecar),
                )
                usage_state["skills"][skill_id] = _default_usage_record(
                    created_by=normalized_created_by
                )
                self._write_usage_state(scope_dir, usage_state)
            except SkillStoreError:
                rollback_package()
                raise
            except UnsafePrivatePathError as exc:
                rollback_package()
                raise SkillStoreError(
                    409,
                    f"unsafe Skill create path: {exc}",
                    code="unsafe_skill_path",
                ) from exc
            except OSError as exc:
                rollback_package()
                raise SkillStoreError(
                    500,
                    f"cannot create Skill: {exc}",
                    code="skill_write_failed",
                ) from exc
            except BaseException:
                rollback_package()
                raise
            return self._read_record(created_skill_dir, include_instructions=False)

    def update(
        self,
        scope_key: str,
        skill_id: str,
        *,
        name: str | None = None,
        description: str | None = None,
        instructions: str | None = None,
        version: str | None = None,
        category: str | None = None,
        tags: Sequence[str] | None = None,
        enabled: bool | None = None,
    ) -> dict[str, Any]:
        """Update mutable Skill content while preserving its generated id."""

        if enabled is not None and not isinstance(enabled, bool):
            raise SkillStoreError(
                400,
                "enabled must be a boolean",
                code="invalid_skill",
            )
        with self._locked_scope(scope_key) as scope_dir:
            skill_dir = self._require_skill_dir(scope_dir, skill_id)
            current = self._read_record(skill_dir, include_instructions=True)
            document = _validated_document(
                name=current["name"] if name is None else name,
                description=(
                    current["description"] if description is None else description
                ),
                instructions=(
                    current["instructions"] if instructions is None else instructions
                ),
                version=current["version"] if version is None else version,
                category=current["category"] if category is None else category,
                tags=current["tags"] if tags is None else tags,
            )
            document_unchanged = all(
                document[key] == current[key]
                for key in (*_FRONTMATTER_KEYS, "instructions")
            )
            enabled_unchanged = (
                enabled is None or enabled == current["enabled"]
            )
            if document_unchanged and enabled_unchanged:
                return _without_load_fields(current)

            if not document_unchanged:
                self._ensure_unique_name(
                    list(self._iter_skill_dirs(scope_dir)),
                    str(document["name"]),
                    exclude_id=skill_id,
                )
            sidecar = self._read_sidecar(skill_dir, expected_id=skill_id)
            if enabled is not None:
                sidecar["enabled"] = enabled
            sidecar["updated_at"] = _utc_now()
            if document_unchanged:
                try:
                    _atomic_write_bytes(
                        self._sidecar_path(skill_dir),
                        _render_sidecar(sidecar),
                    )
                except OSError as exc:
                    raise SkillStoreError(
                        500,
                        f"cannot update Skill state: {exc}",
                        code="skill_write_failed",
                    ) from exc
            else:
                self._replace_document_and_sidecar(skill_dir, document, sidecar)
            return self._read_record(skill_dir, include_instructions=False)

    def delete(self, scope_key: str, skill_id: str) -> dict[str, Any]:
        """Atomically remove a Skill from its scope, then erase its package."""

        with self._locked_scope(scope_key) as scope_dir:
            skill_dir = self._require_skill_dir(scope_dir, skill_id)
            normalized_id = self._skill_id_for_path(skill_dir)
            record = self._read_record(skill_dir, include_instructions=False)
            usage_state, old_usage_bytes = self._read_usage_state_snapshot(scope_dir)
            self._validate_package_tree(skill_dir)
            scope_fd = self._operation.paths[str(scope_dir)]
            skill_fd = self._operation.paths[str(skill_dir)]
            entry = os.stat(normalized_id, dir_fd=scope_fd, follow_symlinks=False)
            opened = os.fstat(skill_fd)
            if (entry.st_dev, entry.st_ino) != (opened.st_dev, opened.st_ino):
                raise SkillStoreError(
                    409,
                    "refusing to delete a replaced Skill package",
                    code="unsafe_skill_path",
                )
            tombstone_name = f".delete-{normalized_id}-{secrets.token_hex(6)}"
            detached = False

            def rollback_detach() -> None:
                if not detached:
                    return
                try:
                    verify_private_child_directory_fd(
                        scope_fd,
                        tombstone_name,
                        skill_fd,
                        mode=None,
                    )
                    try:
                        os.stat(
                            normalized_id,
                            dir_fd=scope_fd,
                            follow_symlinks=False,
                        )
                    except FileNotFoundError:
                        pass
                    else:
                        return
                    os.rename(
                        tombstone_name,
                        normalized_id,
                        src_dir_fd=scope_fd,
                        dst_dir_fd=scope_fd,
                    )
                    verify_private_child_directory_fd(
                        scope_fd,
                        normalized_id,
                        skill_fd,
                        mode=None,
                    )
                    self._restore_usage_state(scope_dir, old_usage_bytes)
                    _fsync_directory(scope_dir)
                except (OSError, SkillStoreError, UnsafePrivatePathError):
                    pass

            try:
                os.rename(
                    normalized_id,
                    tombstone_name,
                    src_dir_fd=scope_fd,
                    dst_dir_fd=scope_fd,
                )
                detached = True
                verify_private_child_directory_fd(
                    scope_fd,
                    tombstone_name,
                    skill_fd,
                    mode=None,
                )
                _fsync_directory(scope_dir)
                usage_state["skills"].pop(normalized_id, None)
                self._write_usage_state(scope_dir, usage_state)
            except OSError as exc:
                rollback_detach()
                raise SkillStoreError(
                    500,
                    f"cannot delete Skill: {exc}",
                    code="skill_write_failed",
                ) from exc
            except SkillStoreError:
                rollback_detach()
                raise
            except BaseException:
                rollback_detach()
                raise
            try:
                _remove_pinned_directory_entry(
                    scope_fd,
                    tombstone_name,
                    skill_fd,
                )
            except (OSError, UnsafePrivatePathError) as exc:
                _remove_tree_quietly(self._state_directory() / normalized_id)
                raise SkillStoreError(
                    500,
                    "Skill was detached but its private deletion cleanup failed",
                    code="skill_delete_cleanup_failed",
                ) from exc
            _remove_tree_quietly(self._state_directory() / normalized_id)
            return record

    def patch(
        self,
        scope_key: str,
        skill_id: str,
        old_string: str,
        new_string: str,
        *,
        file_path: str | None = None,
        expected_replacements: int = 1,
    ) -> dict[str, Any]:
        """Apply an exact, counted replacement to SKILL.md or one support file."""

        normalized_id = _validate_skill_id(skill_id)
        _validate_patch_arguments(
            old_string,
            new_string,
            expected_replacements,
        )
        relative = None if file_path is None else _validate_support_path(file_path)

        with self._locked_scope(scope_key) as scope_dir:
            return self._patch_locked(
                scope_dir,
                normalized_id,
                old_string,
                new_string,
                relative=relative,
                expected_replacements=expected_replacements,
                require_automatic_eligibility=False,
            )

    def patch_automatic(
        self,
        scope_key: str,
        skill_id: str,
        old_string: str,
        new_string: str,
        *,
        file_path: str | None = None,
        expected_replacements: int = 1,
    ) -> dict[str, Any]:
        """Patch one review-owned Skill after an in-lock eligibility check.

        This is the only write entry point for unattended learning.  The
        package and its usage provenance are reread under the same scope lock
        that protects the exact replacement, so a delete/recreate cannot reuse
        an earlier eligibility decision.
        """

        normalized_id = _validate_skill_id(skill_id)
        _validate_patch_arguments(
            old_string,
            new_string,
            expected_replacements,
        )
        relative = None if file_path is None else _validate_support_path(file_path)

        with self._locked_scope(scope_key) as scope_dir:
            return self._patch_locked(
                scope_dir,
                normalized_id,
                old_string,
                new_string,
                relative=relative,
                expected_replacements=expected_replacements,
                require_automatic_eligibility=True,
            )

    def set_enabled(
        self,
        scope_key: str,
        skill_id: str,
        enabled: bool,
    ) -> dict[str, Any]:
        """Enable or disable a Skill without changing its portable document."""

        return self.update(scope_key, skill_id, enabled=enabled)

    def read_support(
        self,
        scope_key: str,
        skill_id: str,
        file_path: str,
    ) -> dict[str, Any]:
        """Read one UTF-8 supporting file from an allowed package directory."""

        relative = _validate_support_path(file_path)
        normalized_id = _validate_skill_id(skill_id)
        with self._locked_scope(scope_key) as scope_dir:
            skill_dir = self._find_skill_dir(scope_dir, normalized_id)
            if skill_dir is not None:
                self._read_record(skill_dir, include_instructions=False)
                target = self._support_target(
                    skill_dir,
                    relative,
                    must_exist=True,
                )
                content, size_bytes = _read_private_text(
                    target,
                    max_bytes=MAX_SUPPORT_FILE_BYTES,
                    missing_status=404,
                    label="supporting file",
                )
                return {
                    "path": relative,
                    "content": content,
                    "size_bytes": size_bytes,
                }
            if self._visible_bundled_record(scope_dir, normalized_id) is not None:
                skill_dir = self._bundled_skill_dirs[normalized_id]
                self._read_bundled_record(skill_dir, include_instructions=False)
                target = self._support_target(skill_dir, relative, must_exist=True)
                content, size_bytes = _read_private_text(
                    target,
                    max_bytes=MAX_SUPPORT_FILE_BYTES,
                    missing_status=404,
                    label="supporting file",
                )
                return {
                    "path": relative,
                    "content": content,
                    "size_bytes": size_bytes,
                }
        raise SkillStoreError(
            404,
            f"Skill not found: {normalized_id}",
            code="skill_not_found",
        )

    def write_support(
        self,
        scope_key: str,
        skill_id: str,
        file_path: str,
        content: str,
    ) -> dict[str, Any]:
        """Atomically create or replace one UTF-8 supporting file."""

        relative = _validate_support_path(file_path)
        encoded = _validate_support_content(content)
        with self._locked_scope(scope_key) as scope_dir:
            skill_dir = self._require_skill_dir(scope_dir, skill_id)
            self._read_record(skill_dir, include_instructions=False)
            linked = self._scan_linked_files(skill_dir)
            existing_sizes = {path: size for path, size in linked}
            old_size = existing_sizes.get(relative, 0)
            if relative not in existing_sizes and len(existing_sizes) >= MAX_SUPPORT_FILES:
                raise SkillStoreError(
                    413,
                    f"a Skill may contain at most {MAX_SUPPORT_FILES} supporting files",
                    code="support_file_quota_exceeded",
                )
            new_total = sum(existing_sizes.values()) - old_size + len(encoded)
            if new_total > MAX_SUPPORT_TOTAL_BYTES:
                raise SkillStoreError(
                    413,
                    (
                        "supporting files may contain at most "
                        f"{MAX_SUPPORT_TOTAL_BYTES} bytes in total"
                    ),
                    code="support_size_exceeded",
                )

            sidecar = self._read_sidecar(skill_dir, expected_id=skill_id)
            self._ensure_support_parents(skill_dir, relative)
            target = self._support_target(skill_dir, relative, must_exist=False)
            old_bytes: bytes | None = None
            if target.exists():
                old_text, _ = _read_private_text(
                    target,
                    max_bytes=MAX_SUPPORT_FILE_BYTES,
                    missing_status=404,
                    label="supporting file",
                )
                old_bytes = old_text.encode("utf-8")
            sidecar["updated_at"] = _utc_now()
            try:
                _atomic_write_bytes(target, encoded)
                _atomic_write_bytes(
                    self._sidecar_path(skill_dir),
                    _render_sidecar(self._bind_sidecar(sidecar, skill_dir)),
                )
            except (OSError, SkillStoreError) as exc:
                self._rollback_support_write(target, old_bytes)
                if isinstance(exc, SkillStoreError):
                    raise
                raise SkillStoreError(
                    500,
                    f"cannot write supporting file: {exc}",
                    code="skill_write_failed",
                ) from exc
            return self._read_record(skill_dir, include_instructions=False)

    def remove_support(
        self,
        scope_key: str,
        skill_id: str,
        file_path: str,
    ) -> dict[str, Any]:
        """Atomically detach one supporting file and update Skill metadata."""

        relative = _validate_support_path(file_path)
        with self._locked_scope(scope_key) as scope_dir:
            skill_dir = self._require_skill_dir(scope_dir, skill_id)
            self._read_record(skill_dir, include_instructions=False)
            target = self._support_target(skill_dir, relative, must_exist=True)
            _read_private_text(
                target,
                max_bytes=MAX_SUPPORT_FILE_BYTES,
                missing_status=404,
                label="supporting file",
            )
            tombstone = scope_dir / (
                f".support-delete-{skill_id}-{secrets.token_hex(8)}"
            )
            sidecar = self._read_sidecar(skill_dir, expected_id=skill_id)
            sidecar["updated_at"] = _utc_now()
            try:
                os.replace(target, tombstone)
                try:
                    _atomic_write_bytes(
                        self._sidecar_path(skill_dir),
                        _render_sidecar(sidecar),
                    )
                except BaseException:
                    os.replace(tombstone, target)
                    raise
                try:
                    tombstone.unlink()
                except OSError:
                    # The visible removal and sidecar update already committed.
                    # A hidden scope tombstone is safe for later maintenance.
                    pass
                self._remove_empty_support_parents(skill_dir, target.parent)
                _atomic_write_bytes(
                    self._sidecar_path(skill_dir),
                    _render_sidecar(self._bind_sidecar(sidecar, skill_dir)),
                )
            except SkillStoreError:
                raise
            except OSError as exc:
                raise SkillStoreError(
                    500,
                    f"cannot remove supporting file: {exc}",
                    code="skill_write_failed",
                ) from exc
            return self._read_record(skill_dir, include_instructions=False)

    def prompt_index(
        self,
        scope_key: str,
        max_chars: int = DEFAULT_PROMPT_INDEX_CHARS,
    ) -> list[dict[str, str]]:
        """Return a bounded metadata-only index for runtime prompt rendering.

        The budget is measured against compact JSON so callers cannot
        accidentally exceed it simply by serializing this list. Disabled
        Skills are intentionally omitted.
        """

        if isinstance(max_chars, bool) or not isinstance(max_chars, int):
            raise SkillStoreError(
                400,
                "max_chars must be an integer",
                code="invalid_prompt_budget",
            )
        if max_chars < 0:
            raise SkillStoreError(
                400,
                "max_chars must not be negative",
                code="invalid_prompt_budget",
            )
        if max_chars < 2:
            return []

        records = self.list(scope_key)
        result: list[dict[str, str]] = []
        for record in records:
            if not record["enabled"]:
                continue
            description = _prompt_description(str(record["description"]))
            base_item = {
                "id": str(record["id"]),
                "name": str(record["name"]),
                "description": "",
                "category": str(record["category"]),
            }
            item = dict(base_item)
            item["description"] = description
            if _json_char_length([*result, item]) <= max_chars:
                result.append(item)
                continue

            available = _largest_fitting_description(
                result,
                base_item,
                description,
                max_chars,
            )
            if available is not None:
                item["description"] = available
                result.append(item)
            # Continue scanning: a later item can have a shorter id, name, or
            # category and still fit even when this item's base metadata does
            # not.
        return result

    @contextmanager
    def _locked_scope(self, scope_key: str) -> Iterator[Path]:
        normalized_scope = _validate_scope_key(scope_key)
        scope_digest = hashlib.sha256(normalized_scope.encode("utf-8")).hexdigest()
        scope_thread_lock = self._thread_lock_for_scope(scope_digest)
        with scope_thread_lock:
            state_dir = ensure_private_directory(self.state_root / scope_digest).resolve(
                strict=True
            )
            lock_path = state_dir / ".lock"
            flags = os.O_RDWR | os.O_CREAT
            if hasattr(os, "O_NOFOLLOW"):
                flags |= os.O_NOFOLLOW
            try:
                fd = os.open(lock_path, flags, 0o600)
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode):
                    raise OSError("scope lock is not a regular file")
                os.fchmod(fd, 0o600)
                fcntl.flock(fd, fcntl.LOCK_EX)
            except OSError as exc:
                try:
                    os.close(fd)
                except (NameError, OSError):
                    pass
                raise SkillStoreError(
                    409,
                    f"unsafe Skill scope lock: {exc}",
                    code="unsafe_skill_path",
                ) from exc
            try:
                scope_dir = self._scope_directory(normalized_scope)
                try:
                    scope_fd = open_private_directory_fd(scope_dir, mode=None)
                except (OSError, UnsafePrivatePathError) as exc:
                    raise SkillStoreError(
                        409,
                        f"unsafe Skill scope directory: {exc}",
                        code="unsafe_skill_path",
                    ) from exc
                self._operation.fds = [scope_fd]
                self._operation.paths = {f"/proc/self/fd/{scope_fd}": scope_fd}
                self._operation.skill_ids = {}
                self._operation.state_dir = state_dir
                anchored_scope = Path(f"/proc/self/fd/{scope_fd}")
                try:
                    yield anchored_scope
                finally:
                    for opened_fd in reversed(self._operation.fds):
                        try:
                            os.close(opened_fd)
                        except OSError:
                            pass
                    self._operation.fds = []
                    self._operation.paths = {}
                    self._operation.skill_ids = {}
                    self._operation.state_dir = None
            finally:
                try:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                finally:
                    os.close(fd)

    def _state_directory(self) -> Path:
        state_dir = getattr(self._operation, "state_dir", None)
        if not isinstance(state_dir, Path):
            raise RuntimeError("Skill state accessed outside the scope lock")
        return state_dir

    def _pin_child_directory(self, parent: Path, name: str) -> Path:
        parent_fd = getattr(self._operation, "paths", {}).get(str(parent))
        if parent_fd is None:
            raise RuntimeError("Skill directory accessed outside its pinned parent")
        try:
            child_fd = open_private_child_directory_fd(parent_fd, name, mode=None)
        except FileNotFoundError as exc:
            raise SkillStoreError(
                409,
                f"Skill directory changed while opening: {name}",
                code="unsafe_skill_path",
            ) from exc
        except (OSError, UnsafePrivatePathError) as exc:
            raise SkillStoreError(
                409,
                f"unsafe Skill directory {name}: {exc}",
                code="unsafe_skill_path",
            ) from exc
        path = Path(f"/proc/self/fd/{child_fd}")
        self._operation.fds.append(child_fd)
        self._operation.paths[str(path)] = child_fd
        return path

    def _skill_id_for_path(self, skill_dir: Path) -> str:
        skill_id = getattr(self._operation, "skill_ids", {}).get(str(skill_dir))
        return skill_id or skill_dir.name

    def _sidecar_path(self, skill_dir: Path, *, create_parent: bool = False) -> Path:
        parent = self._state_directory() / self._skill_id_for_path(skill_dir)
        if create_parent:
            parent = ensure_private_directory(parent)
        return parent / ".skill.json"

    def _bind_sidecar(self, sidecar: dict[str, Any], skill_dir: Path) -> dict[str, Any]:
        info = os.fstat(self._operation.paths[str(skill_dir)])
        sidecar.update(
            package_dev=int(info.st_dev),
            package_ino=int(info.st_ino),
            package_ctime_ns=int(info.st_ctime_ns),
        )
        return sidecar

    def _pin_skill_directory(self, scope_dir: Path, skill_id: str) -> Path:
        skill_dir = self._pin_child_directory(scope_dir, skill_id)
        if not hasattr(self._operation, "skill_ids"):
            self._operation.skill_ids = {}
        self._operation.skill_ids[str(skill_dir)] = skill_id
        return skill_dir

    def _thread_lock_for_scope(self, scope_digest: str) -> threading.RLock:
        with self._scope_locks_guard:
            lock = self._scope_thread_locks.get(scope_digest)
            if lock is None:
                lock = threading.RLock()
                self._scope_thread_locks[scope_digest] = lock
            return lock

    def _scope_directory(self, scope_key: str) -> Path:
        normalized = _validate_scope_key(scope_key)
        try:
            workspace = Path(self._workspace_for_scope(normalized)).expanduser()
            workspace.relative_to(self.workspace_root)
            workspace_fd = open_private_directory_fd(workspace, mode=None)
            try:
                for name in (".agent-platform", "skills"):
                    try:
                        os.mkdir(name, mode=0o700, dir_fd=workspace_fd)
                    except FileExistsError:
                        pass
                    child_fd = open_private_child_directory_fd(
                        workspace_fd, name, mode=None
                    )
                    os.fchmod(child_fd, 0o700)
                    os.close(workspace_fd)
                    workspace_fd = child_fd
            finally:
                os.close(workspace_fd)
            internal = workspace / ".agent-platform"
            scope_dir = internal / "skills"
        except (OSError, RuntimeError, UnsafePrivatePathError) as exc:
            raise SkillStoreError(
                409,
                f"unsafe Skill scope directory: {exc}",
                code="unsafe_skill_path",
            ) from exc
        except ValueError as exc:
            raise SkillStoreError(
                409,
                "Skill workspace escaped its storage root",
                code="unsafe_skill_path",
            ) from exc
        if internal.parent != workspace or scope_dir.parent != internal:
            raise SkillStoreError(
                409,
                "Skill scope escaped its storage root",
                code="unsafe_skill_path",
            )
        return scope_dir

    def _iter_skill_dirs(self, scope_dir: Path) -> Iterator[Path]:
        scope_fd = getattr(self._operation, "paths", {}).get(str(scope_dir))
        if scope_fd is None:
            raise RuntimeError("Skill scope is not pinned")
        try:
            entry_names: list[str] = []
            with os.scandir(scope_fd) as entries:
                for entry in entries:
                    if entry.name.startswith("."):
                        continue
                    entry_names.append(entry.name)
                    if len(entry_names) > MAX_SKILLS_PER_SCOPE:
                        raise SkillStoreError(
                            413,
                            f"a scope may contain at most {MAX_SKILLS_PER_SCOPE} Skills",
                            code="skill_quota_exceeded",
                        )
        except OSError as exc:
            raise SkillStoreError(
                500,
                f"cannot list Skills: {exc}",
                code="skill_read_failed",
            ) from exc
        for name in sorted(entry_names):
            try:
                info = os.stat(name, dir_fd=scope_fd, follow_symlinks=False)
            except OSError as exc:
                raise SkillStoreError(
                    500,
                    f"cannot inspect Skill package {name}: {exc}",
                    code="corrupt_skill",
                ) from exc
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                raise SkillStoreError(
                    409,
                    f"Skill package must be a non-symlink directory: {name}",
                    code="unsafe_skill_path",
                )
            if not _SKILL_ID_RE.fullmatch(name):
                raise SkillStoreError(
                    500,
                    f"invalid Skill package id on disk: {name}",
                    code="corrupt_skill",
                )
            yield self._pin_skill_directory(scope_dir, name)

    def _find_skill_dir(self, scope_dir: Path, skill_id: str) -> Path | None:
        scope_fd = getattr(self._operation, "paths", {}).get(str(scope_dir))
        if scope_fd is None:
            raise RuntimeError("Skill scope is not pinned")
        try:
            info = os.stat(skill_id, dir_fd=scope_fd, follow_symlinks=False)
        except FileNotFoundError:
            return None
        except OSError as exc:
            raise SkillStoreError(
                500,
                f"cannot inspect Skill: {exc}",
                code="skill_read_failed",
            ) from exc
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise SkillStoreError(
                409,
                "Skill package must be a non-symlink directory",
                code="unsafe_skill_path",
            )
        return self._pin_skill_directory(scope_dir, skill_id)

    def _require_skill_dir(self, scope_dir: Path, skill_id: str) -> Path:
        normalized_id = _validate_skill_id(skill_id)
        candidate = self._find_skill_dir(scope_dir, normalized_id)
        if candidate is None:
            if self._visible_bundled_record(scope_dir, normalized_id) is not None:
                raise SkillStoreError(
                    403,
                    "bundled Skills are read-only; create a user Skill to customize it",
                    code="bundled_skill_read_only",
                )
            raise SkillStoreError(
                404,
                f"Skill not found: {normalized_id}",
                code="skill_not_found",
            )
        return candidate

    def _visible_bundled_record(
        self,
        scope_dir: Path,
        skill_id: str,
    ) -> dict[str, Any] | None:
        bundled = self._bundled_records.get(skill_id)
        if bundled is None:
            return None
        bundled_name = str(bundled["name"]).casefold()
        for skill_dir in self._iter_skill_dirs(scope_dir):
            record = self._read_record(skill_dir, include_instructions=False)
            if (
                str(record["id"]) == skill_id
                or str(record["name"]).casefold() == bundled_name
            ):
                return None
        return bundled

    def _read_record(
        self,
        skill_dir: Path,
        *,
        include_instructions: bool,
    ) -> dict[str, Any]:
        sidecar = self._read_or_materialize_sidecar(skill_dir)
        document = self._read_document(
            skill_dir,
            check_instruction_threats=include_instructions,
        )
        linked = self._scan_linked_files(skill_dir)
        record: dict[str, Any] = {
            "id": sidecar["id"],
            "name": document["name"],
            "description": document["description"],
            "category": document["category"],
            "version": document["version"],
            "tags": list(document["tags"]),
            "enabled": sidecar["enabled"],
            "linked_files": [path for path, _ in linked],
            "created_at": sidecar["created_at"],
            "updated_at": sidecar["updated_at"],
            "source": "user",
            "read_only": False,
        }
        if include_instructions:
            record["instructions"] = document["instructions"]
            record["skill_dir"] = str(skill_dir.resolve(strict=True))
        return record

    def _read_or_materialize_sidecar(self, skill_dir: Path) -> dict[str, Any]:
        skill_id = self._skill_id_for_path(skill_dir)
        sidecar_path = self._sidecar_path(skill_dir)
        try:
            sidecar_path.lstat()
        except FileNotFoundError:
            # Portable Skill packages installed by other clients commonly
            # contain only SKILL.md. Validate the complete untrusted document
            # before publishing Platform-owned lifecycle metadata.
            self._read_document(skill_dir, check_instruction_threats=True)
            self._scan_linked_files(skill_dir, check_sensitive_material=True)
            scope_dir = skill_dir.parent
            usage_state, old_usage_bytes = self._read_usage_state_snapshot(scope_dir)
            timestamp = _utc_now()
            sidecar = {
                "schema_version": 1,
                "id": skill_id,
                "enabled": True,
                "created_at": timestamp,
                "updated_at": timestamp,
                "package_dev": int(
                    os.fstat(self._operation.paths[str(skill_dir)]).st_dev
                ),
                "package_ino": int(
                    os.fstat(self._operation.paths[str(skill_dir)]).st_ino
                ),
                "package_ctime_ns": int(
                    os.fstat(self._operation.paths[str(skill_dir)]).st_ctime_ns
                ),
            }
            try:
                sidecar_path = self._sidecar_path(skill_dir, create_parent=True)
                _atomic_write_bytes(sidecar_path, _render_sidecar(sidecar))
                usage_state["skills"][skill_id] = _default_usage_record(
                    created_by="user"
                )
                self._write_usage_state(scope_dir, usage_state)
            except BaseException:
                try:
                    sidecar_path.unlink(missing_ok=True)
                    _fsync_directory(skill_dir)
                except OSError:
                    pass
                self._restore_usage_state(scope_dir, old_usage_bytes)
                raise
            return sidecar
        except OSError as exc:
            raise SkillStoreError(
                500,
                f"cannot inspect Skill sidecar: {exc}",
                code="skill_read_failed",
            ) from exc
        try:
            return self._read_sidecar(skill_dir, expected_id=skill_id)
        except SkillStoreError as exc:
            if exc.code != "stale_skill_state":
                raise
            # A deleted package may be recreated under the same id. Never let
            # its old agent-owned authorization follow the new directory inode.
            sidecar_path.unlink(missing_ok=True)
            usage_state, _ = self._read_usage_state_snapshot(skill_dir.parent)
            usage_state["skills"].pop(skill_id, None)
            self._write_usage_state(skill_dir.parent, usage_state)
            return self._read_or_materialize_sidecar(skill_dir)

    def _read_usage_state(self, scope_dir: Path) -> dict[str, Any]:
        state, _ = self._read_usage_state_snapshot(scope_dir)
        return state

    def _read_usage_state_snapshot(
        self,
        scope_dir: Path,
    ) -> tuple[dict[str, Any], bytes | None]:
        path = self._state_directory() / _USAGE_STATE_FILE
        try:
            info = path.lstat()
        except FileNotFoundError:
            return _empty_usage_state(), None
        except OSError as exc:
            raise SkillStoreError(
                500,
                f"cannot inspect Skill usage state: {exc}",
                code="skill_usage_read_failed",
            ) from exc
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            raise SkillStoreError(
                409,
                "Skill usage state must be a regular non-symlink file",
                code="unsafe_skill_path",
            )
        raw = _read_private_bytes(
            path,
            max_bytes=_MAX_USAGE_STATE_BYTES,
            missing_status=500,
            label=_USAGE_STATE_FILE,
            require_owner_only=True,
            require_single_link=True,
        )
        return _parse_usage_state(raw), raw

    def _write_usage_state(
        self,
        scope_dir: Path,
        state: dict[str, Any],
    ) -> None:
        validated = _validated_usage_state(state)
        rendered = _render_usage_state(validated)
        if len(rendered) > _MAX_USAGE_STATE_BYTES:
            raise SkillStoreError(
                500,
                "Skill usage state exceeds its size limit",
                code="corrupt_skill_usage",
            )
        try:
            _atomic_write_bytes(
                self._state_directory() / _USAGE_STATE_FILE,
                rendered,
            )
        except OSError as exc:
            raise SkillStoreError(
                500,
                f"cannot write Skill usage state: {exc}",
                code="skill_write_failed",
            ) from exc

    def _restore_usage_state(
        self,
        scope_dir: Path,
        old_bytes: bytes | None,
    ) -> None:
        """Best-effort transaction rollback for a usage-state replacement."""

        path = self._state_directory() / _USAGE_STATE_FILE
        try:
            if old_bytes is None:
                path.unlink(missing_ok=True)
                _fsync_directory(scope_dir)
            else:
                _atomic_write_bytes(path, old_bytes)
        except (OSError, SkillStoreError):
            pass

    @staticmethod
    def _usage_record(
        state: dict[str, Any],
        skill_id: str,
    ) -> dict[str, Any]:
        record = state["skills"].get(skill_id)
        if record is None:
            return _default_usage_record(created_by="user")
        return dict(record)

    def _bump_usage(
        self,
        scope_dir: Path,
        skill_id: str,
        *,
        event: str,
    ) -> None:
        state = self._read_usage_state(scope_dir)
        record = self._usage_record(state, skill_id)
        _bump_usage_record(record, event=event, timestamp=_utc_now())
        state["skills"][skill_id] = record
        self._write_usage_state(scope_dir, state)

    @staticmethod
    def _automatic_patch_eligible(usage_record: dict[str, Any]) -> bool:
        return bool(
            usage_record["created_by"] == "agent"
            and usage_record["state"] == "active"
            and not usage_record["pinned"]
        )

    def _patch_locked(
        self,
        scope_dir: Path,
        skill_id: str,
        old_string: str,
        new_string: str,
        *,
        relative: str | None,
        expected_replacements: int,
        require_automatic_eligibility: bool,
    ) -> dict[str, Any]:
        """Apply one exact patch while the caller holds the scope lock."""

        skill_dir = self._require_skill_dir(scope_dir, skill_id)
        current = self._read_record(skill_dir, include_instructions=False)
        usage_state, old_usage_bytes = self._read_usage_state_snapshot(scope_dir)
        usage_record = self._usage_record(usage_state, skill_id)
        if require_automatic_eligibility:
            if not self._automatic_patch_eligible(usage_record):
                raise SkillStoreError(
                    403,
                    "background learning cannot patch this Skill",
                    code="automatic_skill_patch_forbidden",
                )
            # A human may have renamed an agent-owned package since the review
            # read it.  Recheck both immutable package id and current name here
            # so the unattended path cannot maintain a bundled shadow.
            self._reject_agent_bundled_conflict(
                skill_id=skill_id,
                name=str(current["name"]),
            )

        if relative is None:
            self._patch_document(
                scope_dir,
                skill_dir,
                skill_id,
                old_string,
                new_string,
                expected_replacements,
                usage_state,
                usage_record,
                old_usage_bytes,
                reject_bundled_conflict=require_automatic_eligibility,
            )
        else:
            self._patch_support(
                scope_dir,
                skill_dir,
                skill_id,
                relative,
                old_string,
                new_string,
                expected_replacements,
                usage_state,
                usage_record,
                old_usage_bytes,
            )
        return self._read_record(skill_dir, include_instructions=False)

    def _patch_document(
        self,
        scope_dir: Path,
        skill_dir: Path,
        skill_id: str,
        old_string: str,
        new_string: str,
        expected_replacements: int,
        usage_state: dict[str, Any],
        usage_record: dict[str, Any],
        old_usage_bytes: bytes | None,
        *,
        reject_bundled_conflict: bool = False,
    ) -> None:
        document_path = skill_dir / "SKILL.md"
        sidecar_path = self._sidecar_path(skill_dir)
        old_document = _read_private_bytes(
            document_path,
            max_bytes=_MAX_SKILL_DOCUMENT_BYTES,
            missing_status=500,
            label="SKILL.md",
        )
        try:
            current_text = old_document.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise SkillStoreError(
                500,
                "SKILL.md must be UTF-8 text",
                code="corrupt_skill",
            ) from exc
        replacement_count = current_text.count(old_string)
        _require_patch_count(replacement_count, expected_replacements)
        updated_text = current_text.replace(old_string, new_string)
        updated_document = _validated_document(
            **_parse_skill_document(updated_text)
        )
        self._ensure_unique_name(
            list(self._iter_skill_dirs(scope_dir)),
            str(updated_document["name"]),
            exclude_id=skill_id,
        )
        if reject_bundled_conflict:
            self._reject_agent_bundled_conflict(
                skill_id=skill_id,
                name=str(updated_document["name"]),
            )
        updated_bytes = _render_skill_document(updated_document).encode("utf-8")
        if len(updated_bytes) > _MAX_SKILL_DOCUMENT_BYTES:
            raise SkillStoreError(
                413,
                "patched SKILL.md exceeds its size limit",
                code="skill_size_exceeded",
            )

        sidecar = self._read_sidecar(skill_dir, expected_id=skill_id)
        old_sidecar = _read_private_bytes(
            sidecar_path,
            max_bytes=_MAX_SIDECAR_BYTES,
            missing_status=500,
            label=".skill.json",
        )
        timestamp = _utc_now()
        sidecar["updated_at"] = timestamp
        _bump_usage_record(usage_record, event="patch", timestamp=timestamp)
        usage_state["skills"][skill_id] = usage_record

        try:
            _atomic_write_bytes(document_path, updated_bytes)
            _atomic_write_bytes(
                sidecar_path,
                _render_sidecar(self._bind_sidecar(sidecar, skill_dir)),
            )
            self._write_usage_state(scope_dir, usage_state)
        except BaseException as exc:
            _restore_private_file(document_path, old_document)
            _restore_private_file(sidecar_path, old_sidecar)
            self._restore_usage_state(scope_dir, old_usage_bytes)
            if isinstance(exc, SkillStoreError):
                raise
            if isinstance(exc, OSError):
                raise SkillStoreError(
                    500,
                    f"cannot patch Skill: {exc}",
                    code="skill_write_failed",
                ) from exc
            raise

    def _patch_support(
        self,
        scope_dir: Path,
        skill_dir: Path,
        skill_id: str,
        relative: str,
        old_string: str,
        new_string: str,
        expected_replacements: int,
        usage_state: dict[str, Any],
        usage_record: dict[str, Any],
        old_usage_bytes: bytes | None,
    ) -> None:
        linked = self._scan_linked_files(skill_dir)
        existing_sizes = {path: size for path, size in linked}
        target = self._support_target(skill_dir, relative, must_exist=True)
        current_text, current_size = _read_private_text(
            target,
            max_bytes=MAX_SUPPORT_FILE_BYTES,
            missing_status=404,
            label="supporting file",
        )
        replacement_count = current_text.count(old_string)
        _require_patch_count(replacement_count, expected_replacements)
        updated_bytes = _validate_support_content(
            current_text.replace(old_string, new_string)
        )
        new_total = sum(existing_sizes.values()) - current_size + len(updated_bytes)
        if new_total > MAX_SUPPORT_TOTAL_BYTES:
            raise SkillStoreError(
                413,
                (
                    "supporting files may contain at most "
                    f"{MAX_SUPPORT_TOTAL_BYTES} bytes in total"
                ),
                code="support_size_exceeded",
            )

        sidecar_path = self._sidecar_path(skill_dir)
        sidecar = self._read_sidecar(skill_dir, expected_id=skill_id)
        old_sidecar = _read_private_bytes(
            sidecar_path,
            max_bytes=_MAX_SIDECAR_BYTES,
            missing_status=500,
            label=".skill.json",
        )
        old_target = current_text.encode("utf-8")
        timestamp = _utc_now()
        sidecar["updated_at"] = timestamp
        _bump_usage_record(usage_record, event="patch", timestamp=timestamp)
        usage_state["skills"][skill_id] = usage_record

        try:
            _atomic_write_bytes(target, updated_bytes)
            _atomic_write_bytes(
                sidecar_path,
                _render_sidecar(self._bind_sidecar(sidecar, skill_dir)),
            )
            self._write_usage_state(scope_dir, usage_state)
        except BaseException as exc:
            _restore_private_file(target, old_target)
            _restore_private_file(sidecar_path, old_sidecar)
            self._restore_usage_state(scope_dir, old_usage_bytes)
            if isinstance(exc, SkillStoreError):
                raise
            if isinstance(exc, OSError):
                raise SkillStoreError(
                    500,
                    f"cannot patch supporting file: {exc}",
                    code="skill_write_failed",
                ) from exc
            raise

    def _load_bundled_catalog(self, requested_root: Path) -> None:
        try:
            info = requested_root.lstat()
        except FileNotFoundError:
            return
        except OSError as exc:
            raise SkillStoreError(
                500,
                f"cannot inspect bundled Skill storage: {exc}",
                code="bundled_skill_invalid",
            ) from exc
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise SkillStoreError(
                500,
                "bundled Skill storage must be a non-symlink directory",
                code="bundled_skill_invalid",
            )
        try:
            root = requested_root.resolve(strict=True)
            entries = sorted(root.iterdir(), key=lambda path: path.name)
        except OSError as exc:
            raise SkillStoreError(
                500,
                f"cannot list bundled Skills: {exc}",
                code="bundled_skill_invalid",
            ) from exc

        self._bundled_root = root
        names: set[str] = set()
        for entry in entries:
            if entry.name.startswith("."):
                continue
            if not _SKILL_ID_RE.fullmatch(entry.name):
                raise SkillStoreError(
                    500,
                    f"invalid bundled Skill id: {entry.name}",
                    code="bundled_skill_invalid",
                )
            try:
                entry_info = entry.lstat()
                resolved = entry.resolve(strict=True)
            except OSError as exc:
                raise SkillStoreError(
                    500,
                    f"cannot inspect bundled Skill {entry.name}: {exc}",
                    code="bundled_skill_invalid",
                ) from exc
            if (
                stat.S_ISLNK(entry_info.st_mode)
                or not stat.S_ISDIR(entry_info.st_mode)
                or resolved.parent != root
            ):
                raise SkillStoreError(
                    500,
                    f"bundled Skill package is unsafe: {entry.name}",
                    code="bundled_skill_invalid",
                )
            self._bundled_skill_dirs[entry.name] = entry
            record = self._read_bundled_record(
                entry,
                include_instructions=False,
            )
            folded_name = str(record["name"]).casefold()
            if folded_name in names:
                raise SkillStoreError(
                    500,
                    f"duplicate bundled Skill name: {record['name']}",
                    code="bundled_skill_invalid",
                )
            names.add(folded_name)
            self._bundled_records[entry.name] = record
            if len(self._bundled_records) > MAX_SKILLS_PER_SCOPE:
                raise SkillStoreError(
                    500,
                    (
                        "the bundled Skill catalog may contain at most "
                        f"{MAX_SKILLS_PER_SCOPE} packages"
                    ),
                    code="bundled_skill_invalid",
                )

    def _read_bundled_record(
        self,
        skill_dir: Path,
        *,
        include_instructions: bool,
    ) -> dict[str, Any]:
        self._validate_bundled_package_root(skill_dir)
        document = self._read_document(
            skill_dir,
            check_instruction_threats=include_instructions,
        )
        linked = self._scan_linked_files(
            skill_dir,
            allowed_root_entries={
                "SKILL.md",
                *BUNDLED_METADATA_FILES,
                *SUPPORT_DIRECTORIES,
            },
            ignore_generated_python_cache=True,
        )
        record: dict[str, Any] = {
            "id": skill_dir.name,
            "name": document["name"],
            "description": document["description"],
            "category": document["category"],
            "version": document["version"],
            "tags": list(document["tags"]),
            "enabled": True,
            "linked_files": [path for path, _ in linked],
            "created_at": None,
            "updated_at": None,
            "source": "bundled",
            "read_only": True,
        }
        if include_instructions:
            record["instructions"] = document["instructions"]
            record["skill_dir"] = str(skill_dir.resolve(strict=True))
        return record

    def _validate_bundled_package_root(self, skill_dir: Path) -> None:
        try:
            info = skill_dir.lstat()
            resolved = skill_dir.resolve(strict=True)
            entries = list(skill_dir.iterdir())
        except OSError as exc:
            raise SkillStoreError(
                500,
                f"cannot inspect bundled Skill package: {exc}",
                code="bundled_skill_invalid",
            ) from exc
        if (
            stat.S_ISLNK(info.st_mode)
            or not stat.S_ISDIR(info.st_mode)
            or self._bundled_root is None
            or resolved.parent != self._bundled_root
        ):
            raise SkillStoreError(
                500,
                f"bundled Skill package is unsafe: {skill_dir.name}",
                code="bundled_skill_invalid",
            )
        allowed = {
            "SKILL.md",
            *BUNDLED_METADATA_FILES,
            *SUPPORT_DIRECTORIES,
        }
        unexpected = sorted(
            entry.name for entry in entries if entry.name not in allowed
        )
        if unexpected:
            raise SkillStoreError(
                500,
                (
                    f"unexpected file in bundled Skill package {skill_dir.name}: "
                    f"{unexpected[0]}"
                ),
                code="bundled_skill_invalid",
            )
        for metadata_name in BUNDLED_METADATA_FILES:
            metadata_path = skill_dir / metadata_name
            try:
                metadata_path.lstat()
            except FileNotFoundError:
                continue
            except OSError as exc:
                raise SkillStoreError(
                    500,
                    f"cannot inspect bundled Skill metadata {metadata_name}: {exc}",
                    code="bundled_skill_invalid",
                ) from exc
            _inspect_private_file_size(
                metadata_path,
                max_bytes=MAX_SUPPORT_FILE_BYTES,
                missing_status=500,
                label=f"bundled Skill metadata {metadata_name}",
            )

    def _read_document(
        self,
        skill_dir: Path,
        *,
        check_instruction_threats: bool = True,
    ) -> dict[str, Any]:
        text, _ = _read_private_text(
            skill_dir / "SKILL.md",
            max_bytes=_MAX_SKILL_DOCUMENT_BYTES,
            missing_status=500,
            label="SKILL.md",
        )
        try:
            parsed = _parse_skill_document(text)
            return _validated_document(
                **parsed,
                check_instruction_threats=check_instruction_threats,
                check_sensitive_material=check_instruction_threats,
            )
        except SkillStoreError as exc:
            if exc.status >= 500:
                raise
            raise SkillStoreError(
                500,
                f"invalid SKILL.md in {skill_dir.name}: {exc.message}",
                code="corrupt_skill",
            ) from exc

    def _read_sidecar(
        self,
        skill_dir: Path,
        *,
        expected_id: str,
    ) -> dict[str, Any]:
        text, _ = _read_private_text(
            self._sidecar_path(skill_dir),
            max_bytes=_MAX_SIDECAR_BYTES,
            missing_status=500,
            label=".skill.json",
        )
        try:
            value = json.loads(text)
        except json.JSONDecodeError as exc:
            raise SkillStoreError(
                500,
                f"invalid Skill sidecar in {expected_id}",
                code="corrupt_skill",
            ) from exc
        required = {
            "schema_version",
            "id",
            "enabled",
            "created_at",
            "updated_at",
            "package_dev",
            "package_ino",
            "package_ctime_ns",
        }
        if not isinstance(value, dict) or set(value) != required:
            raise SkillStoreError(
                500,
                f"invalid Skill sidecar fields in {expected_id}",
                code="corrupt_skill",
            )
        if value["schema_version"] != 1 or value["id"] != expected_id:
            raise SkillStoreError(
                500,
                f"Skill sidecar identity mismatch in {expected_id}",
                code="corrupt_skill",
            )
        if any(
            isinstance(value[field], bool)
            or not isinstance(value[field], int)
            or value[field] < 0
            for field in ("package_dev", "package_ino", "package_ctime_ns")
        ):
            raise SkillStoreError(
                500,
                f"invalid Skill package identity in {expected_id}",
                code="corrupt_skill",
            )
        package_fd = getattr(self._operation, "paths", {}).get(str(skill_dir))
        if package_fd is None:
            raise RuntimeError("workspace Skill package is not pinned")
        package_info = os.fstat(package_fd)
        if (
            value["package_dev"],
            value["package_ino"],
            value["package_ctime_ns"],
        ) != (
            package_info.st_dev,
            package_info.st_ino,
            package_info.st_ctime_ns,
        ):
            raise SkillStoreError(
                409,
                f"stale Skill state in {expected_id}",
                code="stale_skill_state",
            )
        if not isinstance(value["enabled"], bool):
            raise SkillStoreError(
                500,
                f"invalid enabled state in {expected_id}",
                code="corrupt_skill",
            )
        for field in ("created_at", "updated_at"):
            if not isinstance(value[field], str) or not value[field]:
                raise SkillStoreError(
                    500,
                    f"invalid {field} in {expected_id}",
                    code="corrupt_skill",
                )
        return value

    def _scan_linked_files(
        self,
        skill_dir: Path,
        *,
        allowed_root_entries: set[str] | None = None,
        ignore_generated_python_cache: bool = False,
        check_sensitive_material: bool = False,
    ) -> list[tuple[str, int]]:
        linked: list[tuple[str, int]] = []
        total_bytes = 0
        directory_count = 0
        allowed_entries = (
            {"SKILL.md", *SUPPORT_DIRECTORIES}
            if allowed_root_entries is None
            else allowed_root_entries
        )
        root_fd = getattr(self._operation, "paths", {}).get(str(skill_dir))
        if root_fd is None:
            # Bundled Skills are repository-owned and never Agent-writable.
            if skill_dir not in self._bundled_skill_dirs.values():
                raise RuntimeError("workspace Skill package is not pinned")
            root_entries = list(skill_dir.iterdir())
            for entry in root_entries:
                if entry.name not in allowed_entries:
                    raise SkillStoreError(
                        500,
                        f"unexpected file in Skill package: {entry.name}",
                        code="corrupt_skill",
                    )
            return self._scan_bundled_linked_files(
                skill_dir,
                ignore_generated_python_cache=ignore_generated_python_cache,
            )
        try:
            with os.scandir(root_fd) as entries:
                for entry in entries:
                    if entry.name not in allowed_entries:
                        raise SkillStoreError(
                            500,
                            f"unexpected file in Skill package: {entry.name}",
                            code="corrupt_skill",
                        )
        except OSError as exc:
            raise SkillStoreError(
                500,
                f"cannot inspect Skill package: {exc}",
                code="skill_read_failed",
            ) from exc

        for directory_name in sorted(SUPPORT_DIRECTORIES):
            try:
                root_info = os.stat(
                    directory_name, dir_fd=root_fd, follow_symlinks=False
                )
            except FileNotFoundError:
                continue
            except OSError as exc:
                raise SkillStoreError(
                    500,
                    f"cannot inspect supporting directory: {exc}",
                    code="skill_read_failed",
                ) from exc
            if stat.S_ISLNK(root_info.st_mode) or not stat.S_ISDIR(root_info.st_mode):
                raise SkillStoreError(
                    409,
                    f"{directory_name} must be a non-symlink directory",
                    code="unsafe_skill_path",
                )
            directory_count += 1
            if directory_count > MAX_SUPPORT_DIRECTORIES:
                raise SkillStoreError(
                    500,
                    "Skill exceeds the supporting directory limit",
                    code="corrupt_skill",
                )
            support_root = self._pin_child_directory(skill_dir, directory_name)

            def scan(current: Path, relative_root: str) -> None:
                nonlocal directory_count, total_bytes
                current_fd = self._operation.paths[str(current)]
                with os.scandir(current_fd) as entries:
                    child_names = (entry.name for entry in entries)
                    for child_name in child_names:
                        info = os.stat(
                            child_name, dir_fd=current_fd, follow_symlinks=False
                        )
                        relative = f"{relative_root}/{child_name}"
                        if stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode):
                            if ignore_generated_python_cache and child_name == "__pycache__":
                                continue
                            directory_count += 1
                            if directory_count > MAX_SUPPORT_DIRECTORIES:
                                raise SkillStoreError(
                                    500,
                                    "Skill exceeds the supporting directory limit",
                                    code="corrupt_skill",
                                )
                            scan(self._pin_child_directory(current, child_name), relative)
                            continue
                        if stat.S_ISLNK(info.st_mode):
                            raise SkillStoreError(
                                409,
                                f"unsafe supporting path: {relative}",
                                code="unsafe_skill_path",
                            )
                        if ignore_generated_python_cache and child_name.endswith((".pyc", ".pyo")):
                            continue
                        path = current / child_name
                        size_bytes = _inspect_private_file_size(
                            path,
                            max_bytes=MAX_SUPPORT_FILE_BYTES,
                            missing_status=500,
                            label=f"supporting file {relative}",
                        )
                        if check_sensitive_material:
                            content = _read_private_bytes(
                                path,
                                max_bytes=MAX_SUPPORT_FILE_BYTES,
                                missing_status=500,
                                label=f"supporting file {relative}",
                            )
                            try:
                                text = content.decode("utf-8")
                            except UnicodeDecodeError:
                                pass
                            else:
                                if _credential_material_reasons(text):
                                    raise SkillStoreError(
                                        400,
                                        "supporting file contains apparent plaintext "
                                        "credential material",
                                        code="sensitive_skill_content",
                                    )
                        linked.append((relative, size_bytes))
                        total_bytes += size_bytes
                        if len(linked) > MAX_SUPPORT_FILES:
                            raise SkillStoreError(
                                500,
                                "Skill exceeds the supporting file count limit",
                                code="corrupt_skill",
                            )
                        if total_bytes > MAX_SUPPORT_TOTAL_BYTES:
                            raise SkillStoreError(
                                500,
                                "Skill exceeds the supporting file size limit",
                                code="corrupt_skill",
                            )
            scan(support_root, directory_name)
        linked.sort(key=lambda item: item[0])
        return linked

    def _scan_bundled_linked_files(
        self,
        skill_dir: Path,
        *,
        ignore_generated_python_cache: bool,
    ) -> list[tuple[str, int]]:
        linked: list[tuple[str, int]] = []
        total_bytes = 0
        for directory_name in sorted(SUPPORT_DIRECTORIES):
            support_root = skill_dir / directory_name
            try:
                root_info = support_root.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(root_info.st_mode) or not stat.S_ISDIR(root_info.st_mode):
                raise SkillStoreError(
                    500,
                    f"unsafe bundled supporting directory: {directory_name}",
                    code="bundled_skill_invalid",
                )
            for current_root, directory_names, file_names in os.walk(
                support_root, topdown=True, followlinks=False
            ):
                current = Path(current_root)
                for child_name in directory_names:
                    child_info = (current / child_name).lstat()
                    if stat.S_ISLNK(child_info.st_mode):
                        raise SkillStoreError(
                            500,
                            "bundled Skill contains a symlinked directory",
                            code="bundled_skill_invalid",
                        )
                directory_names[:] = sorted(
                    name for name in directory_names
                    if not (ignore_generated_python_cache and name == "__pycache__")
                )
                for file_name in sorted(file_names):
                    if ignore_generated_python_cache and file_name.endswith((".pyc", ".pyo")):
                        continue
                    path = current / file_name
                    size_bytes = _inspect_private_file_size(
                        path,
                        max_bytes=MAX_SUPPORT_FILE_BYTES,
                        missing_status=500,
                        label="bundled supporting file",
                    )
                    linked.append((path.relative_to(skill_dir).as_posix(), size_bytes))
                    total_bytes += size_bytes
                    if (
                        len(linked) > MAX_SUPPORT_FILES
                        or total_bytes > MAX_SUPPORT_TOTAL_BYTES
                    ):
                        raise SkillStoreError(
                            500,
                            "bundled Skill exceeds supporting file limits",
                            code="bundled_skill_invalid",
                        )
        return sorted(linked)

    def _validate_package_tree(self, skill_dir: Path) -> None:
        # Reading package metadata verifies the document/sidecar UTF-8,
        # sidecar identity, support file types/quotas, and absence of symlinks
        # without loading every supporting payload.
        self._read_record(skill_dir, include_instructions=False)

    def _ensure_unique_name(
        self,
        skill_dirs: Sequence[Path],
        name: str,
        *,
        exclude_id: str | None = None,
    ) -> None:
        desired = name.casefold()
        for skill_dir in skill_dirs:
            if self._skill_id_for_path(skill_dir) == exclude_id:
                continue
            existing = self._read_document(
                skill_dir,
                check_instruction_threats=False,
            )
            if str(existing["name"]).casefold() == desired:
                raise SkillStoreError(
                    409,
                    f"a Skill named {name!r} already exists in this scope",
                    code="duplicate_skill_name",
                )

    def _new_skill_id(self, scope_dir: Path, name: str) -> str:
        normalized = unicodedata.normalize("NFKD", name)
        ascii_name = normalized.encode("ascii", "ignore").decode("ascii").lower()
        base = re.sub(r"[^a-z0-9]+", "-", ascii_name).strip("-")
        if not base:
            base = "skill"
        base = base[:48].rstrip("-") or "skill"
        for _ in range(32):
            candidate = f"{base}-{secrets.token_hex(4)}"
            if _SKILL_ID_RE.fullmatch(candidate) and not (scope_dir / candidate).exists():
                return candidate
        raise SkillStoreError(
            500,
            "could not allocate a unique Skill id",
            code="skill_id_allocation_failed",
        )

    def _reject_agent_bundled_conflict(self, *, skill_id: str, name: str) -> None:
        """Keep unattended learning from silently shadowing release Skills."""

        desired_name = name.casefold()
        if skill_id in self._bundled_records or any(
            str(record["name"]).casefold() == desired_name
            for record in self._bundled_records.values()
        ):
            raise SkillStoreError(
                409,
                "background learning cannot shadow a bundled Skill",
                code="bundled_skill_conflict",
            )

    def _replace_document_and_sidecar(
        self,
        skill_dir: Path,
        document: dict[str, Any],
        sidecar: dict[str, Any],
    ) -> None:
        document_path = skill_dir / "SKILL.md"
        sidecar_path = self._sidecar_path(skill_dir)
        old_document = _read_private_bytes(
            document_path,
            max_bytes=_MAX_SKILL_DOCUMENT_BYTES,
            missing_status=500,
            label="SKILL.md",
        )
        old_sidecar = _read_private_bytes(
            sidecar_path,
            max_bytes=_MAX_SIDECAR_BYTES,
            missing_status=500,
            label=".skill.json",
        )
        document_replaced = False
        sidecar_replaced = False
        try:
            _atomic_write_bytes(
                document_path,
                _render_skill_document(document).encode("utf-8"),
            )
            document_replaced = True
            _atomic_write_bytes(
                sidecar_path,
                _render_sidecar(self._bind_sidecar(sidecar, skill_dir)),
            )
            sidecar_replaced = True
        except (OSError, SkillStoreError) as exc:
            try:
                if document_replaced:
                    _atomic_write_bytes(document_path, old_document)
                if sidecar_replaced:
                    _atomic_write_bytes(sidecar_path, old_sidecar)
            except (OSError, SkillStoreError):
                pass
            if isinstance(exc, SkillStoreError):
                raise
            raise SkillStoreError(
                500,
                f"cannot update Skill: {exc}",
                code="skill_write_failed",
            ) from exc

    def _support_target(
        self,
        skill_dir: Path,
        relative: str,
        *,
        must_exist: bool,
    ) -> Path:
        if str(skill_dir) not in getattr(self._operation, "paths", {}):
            if skill_dir not in self._bundled_skill_dirs.values():
                raise RuntimeError("workspace Skill package is not pinned")
            target = skill_dir.joinpath(*relative.split("/"))
            try:
                target.resolve(strict=must_exist).relative_to(skill_dir.resolve(strict=True))
            except (OSError, ValueError) as exc:
                raise SkillStoreError(
                    409,
                    f"unsafe bundled supporting path: {relative}",
                    code="unsafe_skill_path",
                ) from exc
            return target
        current = skill_dir
        parts = relative.split("/")
        for index, part in enumerate(parts):
            parent = current
            try:
                parent_fd = self._operation.paths[str(parent)]
                info = os.stat(part, dir_fd=parent_fd, follow_symlinks=False)
            except FileNotFoundError:
                if must_exist:
                    raise SkillStoreError(
                        404,
                        f"supporting file not found: {relative}",
                        code="support_file_not_found",
                    )
                if index != len(parts) - 1:
                    raise SkillStoreError(
                        409,
                        f"supporting path parent disappeared: {relative}",
                        code="unsafe_skill_path",
                    )
                return parent / part
            except OSError as exc:
                raise SkillStoreError(
                    500,
                    f"cannot inspect supporting path: {exc}",
                    code="skill_read_failed",
                ) from exc
            is_last = index == len(parts) - 1
            if stat.S_ISLNK(info.st_mode):
                raise SkillStoreError(
                    409,
                    f"supporting path must not contain symlinks: {relative}",
                    code="unsafe_skill_path",
                )
            if is_last:
                if not stat.S_ISREG(info.st_mode):
                    raise SkillStoreError(
                        409,
                        f"supporting path is not a regular file: {relative}",
                        code="unsafe_skill_path",
                    )
            elif not stat.S_ISDIR(info.st_mode):
                raise SkillStoreError(
                    409,
                    f"supporting path parent is not a directory: {relative}",
                    code="unsafe_skill_path",
                )
            if not is_last:
                current = self._pin_child_directory(parent, part)
        return current / parts[-1]

    def _ensure_support_parents(self, skill_dir: Path, relative: str) -> None:
        current = skill_dir
        for part in relative.split("/")[:-1]:
            parent = current
            parent_fd = self._operation.paths[str(parent)]
            try:
                info = os.stat(part, dir_fd=parent_fd, follow_symlinks=False)
            except FileNotFoundError:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=parent_fd)
                except OSError as exc:
                    raise SkillStoreError(
                        500,
                        f"cannot create supporting directory: {exc}",
                        code="skill_write_failed",
                    ) from exc
                current = self._pin_child_directory(parent, part)
                continue
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                raise SkillStoreError(
                    409,
                    f"unsafe supporting directory: {relative}",
                    code="unsafe_skill_path",
                )
            current = self._pin_child_directory(parent, part)
            os.fchmod(self._operation.paths[str(current)], 0o700)

    def _rollback_support_write(
        self,
        target: Path,
        old_bytes: bytes | None,
    ) -> None:
        try:
            if old_bytes is None:
                target.unlink(missing_ok=True)
            else:
                _atomic_write_bytes(target, old_bytes)
        except (OSError, SkillStoreError):
            pass

    def _remove_empty_support_parents(self, skill_dir: Path, start: Path) -> None:
        current = start
        while current != skill_dir and current.parent != skill_dir:
            try:
                current.rmdir()
            except OSError:
                break
            current = current.parent
        if current.parent == skill_dir and current.name in SUPPORT_DIRECTORIES:
            try:
                current.rmdir()
            except (OSError, SkillStoreError):
                pass


def _validate_scope_key(scope_key: str) -> str:
    if not isinstance(scope_key, str) or not scope_key:
        raise SkillStoreError(
            400,
            "scope_key must be a non-empty string",
            code="invalid_scope",
        )
    if "\x00" in scope_key:
        raise SkillStoreError(
            400,
            "scope_key must not contain NUL",
            code="invalid_scope",
        )
    _reject_surrogates(scope_key, "scope_key", code="invalid_scope")
    return scope_key


def _validate_created_by(created_by: Any) -> str:
    if not isinstance(created_by, str) or created_by not in _USAGE_CREATED_BY:
        raise SkillStoreError(
            400,
            "created_by must be user or agent",
            code="invalid_skill_provenance",
        )
    return created_by


def _validate_patch_arguments(
    old_string: Any,
    new_string: Any,
    expected_replacements: Any,
) -> None:
    if not isinstance(old_string, str) or not old_string:
        raise SkillStoreError(
            400,
            "old_string must be a non-empty string",
            code="invalid_skill_patch",
        )
    if not isinstance(new_string, str):
        raise SkillStoreError(
            400,
            "new_string must be a string",
            code="invalid_skill_patch",
        )
    for field, value in (("old_string", old_string), ("new_string", new_string)):
        if "\x00" in value:
            raise SkillStoreError(
                400,
                f"{field} must not contain NUL",
                code="invalid_skill_patch",
            )
        _reject_surrogates(value, field, code="invalid_skill_patch")
        if len(value.encode("utf-8")) > MAX_SUPPORT_FILE_BYTES:
            raise SkillStoreError(
                413,
                f"{field} exceeds the patch text size limit",
                code="skill_size_exceeded",
            )
    if (
        isinstance(expected_replacements, bool)
        or not isinstance(expected_replacements, int)
        or not 1 <= expected_replacements <= MAX_PATCH_REPLACEMENTS
    ):
        raise SkillStoreError(
            400,
            (
                "expected_replacements must be between 1 and "
                f"{MAX_PATCH_REPLACEMENTS}"
            ),
            code="invalid_skill_patch",
        )


def _require_patch_count(actual: int, expected: int) -> None:
    if actual != expected:
        raise SkillStoreError(
            409,
            f"expected {expected} replacements, found {actual}",
            code="skill_patch_mismatch",
        )


def _validate_skill_id(skill_id: str) -> str:
    if not isinstance(skill_id, str) or not _SKILL_ID_RE.fullmatch(skill_id):
        raise SkillStoreError(
            400,
            "invalid Skill id",
            code="invalid_skill_id",
        )
    return skill_id


def _validate_scalar(
    value: Any,
    field: str,
    *,
    max_chars: int,
    allow_empty: bool = False,
) -> str:
    if not isinstance(value, str):
        raise SkillStoreError(
            400,
            f"{field} must be a string",
            code="invalid_skill",
        )
    _reject_surrogates(value, field, code="invalid_skill")
    normalized = value.strip()
    if not normalized and not allow_empty:
        raise SkillStoreError(
            400,
            f"{field} must not be empty",
            code="invalid_skill",
        )
    if len(normalized) > max_chars:
        raise SkillStoreError(
            400,
            f"{field} may contain at most {max_chars} characters",
            code="invalid_skill",
        )
    if any(ord(character) < 32 or ord(character) == 127 for character in normalized):
        raise SkillStoreError(
            400,
            f"{field} must be a single line without control characters",
            code="invalid_skill",
        )
    return normalized


def _validate_tags(tags: Sequence[str] | None) -> list[str]:
    if tags is None:
        return []
    if isinstance(tags, (str, bytes)) or not isinstance(tags, Sequence):
        raise SkillStoreError(
            400,
            "tags must be a list of strings",
            code="invalid_skill",
        )
    if len(tags) > MAX_TAGS:
        raise SkillStoreError(
            400,
            f"a Skill may contain at most {MAX_TAGS} tags",
            code="invalid_skill",
        )
    normalized: list[str] = []
    seen: set[str] = set()
    for raw_tag in tags:
        tag = _validate_scalar(raw_tag, "tag", max_chars=64)
        folded = tag.casefold()
        if folded in seen:
            continue
        seen.add(folded)
        normalized.append(tag)
    return normalized


def _validated_document(
    *,
    name: Any,
    description: Any,
    instructions: Any,
    version: Any,
    category: Any,
    tags: Sequence[str] | None,
    check_instruction_threats: bool = True,
    check_sensitive_material: bool = True,
) -> dict[str, Any]:
    normalized_name = _validate_scalar(name, "name", max_chars=MAX_NAME_CHARS)
    normalized_description = _validate_scalar(
        description,
        "description",
        max_chars=MAX_DESCRIPTION_CHARS,
    )
    normalized_version = _validate_scalar(
        version,
        "version",
        max_chars=32,
        allow_empty=True,
    )
    normalized_category = _validate_scalar(
        category,
        "category",
        max_chars=64,
        allow_empty=True,
    )
    if not isinstance(instructions, str):
        raise SkillStoreError(
            400,
            "instructions must be a string",
            code="invalid_skill",
        )
    if not instructions.strip():
        raise SkillStoreError(
            400,
            "instructions must not be empty",
            code="invalid_skill",
        )
    if "\x00" in instructions:
        raise SkillStoreError(
            400,
            "instructions must not contain NUL",
            code="invalid_skill",
        )
    _reject_surrogates(instructions, "instructions", code="invalid_skill")
    if len(instructions.encode("utf-8")) > MAX_INSTRUCTIONS_BYTES:
        raise SkillStoreError(
            413,
            f"instructions may contain at most {MAX_INSTRUCTIONS_BYTES} bytes",
            code="skill_size_exceeded",
        )
    if check_instruction_threats and prompt_threat_reasons(instructions):
        raise SkillStoreError(
            400,
            "instructions resemble prompt-injection or credential-exfiltration commands",
            code="unsafe_skill_instructions",
        )
    normalized_tags = _validate_tags(tags)
    if check_sensitive_material and _credential_material_reasons(
        "\n".join(
            (
                normalized_name,
                normalized_description,
                normalized_version,
                normalized_category,
                *normalized_tags,
                instructions,
            )
        )
    ):
        raise SkillStoreError(
            400,
            "Skill content contains apparent plaintext credential material",
            code="sensitive_skill_content",
        )
    return {
        "name": normalized_name,
        "description": normalized_description,
        "version": normalized_version,
        "category": normalized_category,
        "tags": normalized_tags,
        "instructions": instructions,
    }


def _render_skill_document(document: dict[str, Any]) -> str:
    lines = ["---"]
    for key in _FRONTMATTER_KEYS:
        lines.append(
            f"{key}: "
            + json.dumps(
                document[key],
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
    lines.extend(("---", "", str(document["instructions"])))
    return "\n".join(lines)


def _parse_skill_document(text: str) -> dict[str, Any]:
    if not text.startswith("---\n"):
        raise SkillStoreError(
            400,
            "SKILL.md must start with YAML frontmatter",
            code="invalid_skill",
        )
    closing = text.find("\n---\n", 4)
    if closing < 0:
        raise SkillStoreError(
            400,
            "SKILL.md frontmatter is not terminated",
            code="invalid_skill",
        )
    remainder = text[closing + len("\n---\n") :]
    if not remainder.startswith("\n"):
        raise SkillStoreError(
            400,
            "SKILL.md must contain a blank line after frontmatter",
            code="invalid_skill",
        )
    header = text[4:closing]
    lines = header.splitlines()
    if len(lines) != len(_FRONTMATTER_KEYS):
        raise SkillStoreError(
            400,
            "SKILL.md frontmatter has unexpected fields",
            code="invalid_skill",
        )
    values: dict[str, Any] = {}
    for expected_key, line in zip(_FRONTMATTER_KEYS, lines):
        prefix = f"{expected_key}: "
        if not line.startswith(prefix):
            raise SkillStoreError(
                400,
                "SKILL.md frontmatter is not in canonical format",
                code="invalid_skill",
            )
        try:
            values[expected_key] = json.loads(line[len(prefix) :])
        except json.JSONDecodeError as exc:
            raise SkillStoreError(
                400,
                f"invalid {expected_key} frontmatter value",
                code="invalid_skill",
            ) from exc
    values["instructions"] = remainder[1:]
    return values


def _render_sidecar(sidecar: dict[str, Any]) -> bytes:
    return (
        json.dumps(
            sidecar,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode("utf-8")


def _empty_usage_state() -> dict[str, Any]:
    return {"schema_version": 1, "skills": {}}


def _default_usage_record(*, created_by: str) -> dict[str, Any]:
    return {
        "created_by": _validate_created_by(created_by),
        "use_count": 0,
        "last_used_at": None,
        "patch_count": 0,
        "last_patched_at": None,
        "state": "active",
        "pinned": False,
        "archived_at": None,
    }


def _validated_usage_state(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"schema_version", "skills"}:
        raise SkillStoreError(
            500,
            "invalid Skill usage state fields",
            code="corrupt_skill_usage",
        )
    if value.get("schema_version") != 1 or not isinstance(value.get("skills"), dict):
        raise SkillStoreError(
            500,
            "invalid Skill usage state schema",
            code="corrupt_skill_usage",
        )
    if len(value["skills"]) > MAX_SKILLS_PER_SCOPE:
        raise SkillStoreError(
            500,
            "Skill usage state exceeds the per-scope Skill limit",
            code="corrupt_skill_usage",
        )

    required_record_fields = {
        "created_by",
        "use_count",
        "last_used_at",
        "patch_count",
        "last_patched_at",
        "state",
        "pinned",
        "archived_at",
    }
    skills: dict[str, dict[str, Any]] = {}
    for raw_id, raw_record in value["skills"].items():
        if not isinstance(raw_id, str) or not _SKILL_ID_RE.fullmatch(raw_id):
            raise SkillStoreError(
                500,
                "Skill usage state contains an invalid Skill id",
                code="corrupt_skill_usage",
            )
        if (
            not isinstance(raw_record, dict)
            or set(raw_record) != required_record_fields
        ):
            raise SkillStoreError(
                500,
                f"invalid Skill usage record fields for {raw_id}",
                code="corrupt_skill_usage",
            )
        created_by = raw_record.get("created_by")
        state = raw_record.get("state")
        if created_by not in _USAGE_CREATED_BY or state not in _USAGE_STATES:
            raise SkillStoreError(
                500,
                f"invalid Skill usage record state for {raw_id}",
                code="corrupt_skill_usage",
            )
        for count_field in ("use_count", "patch_count"):
            count = raw_record.get(count_field)
            if isinstance(count, bool) or not isinstance(count, int) or count < 0:
                raise SkillStoreError(
                    500,
                    f"invalid {count_field} for {raw_id}",
                    code="corrupt_skill_usage",
                )
        if not isinstance(raw_record.get("pinned"), bool):
            raise SkillStoreError(
                500,
                f"invalid pinned state for {raw_id}",
                code="corrupt_skill_usage",
            )
        for timestamp_field in (
            "last_used_at",
            "last_patched_at",
            "archived_at",
        ):
            timestamp = raw_record.get(timestamp_field)
            if timestamp is not None and (
                not isinstance(timestamp, str) or not timestamp
            ):
                raise SkillStoreError(
                    500,
                    f"invalid {timestamp_field} for {raw_id}",
                    code="corrupt_skill_usage",
                )
        archived_at = raw_record.get("archived_at")
        if (state == "archived") != (archived_at is not None):
            raise SkillStoreError(
                500,
                f"inconsistent archived state for {raw_id}",
                code="corrupt_skill_usage",
            )
        skills[raw_id] = dict(raw_record)
    return {"schema_version": 1, "skills": skills}


def _parse_usage_state(raw: bytes) -> dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise SkillStoreError(
            500,
            "invalid Skill usage state",
            code="corrupt_skill_usage",
        ) from exc
    return _validated_usage_state(value)


def _render_usage_state(state: dict[str, Any]) -> bytes:
    return (
        json.dumps(
            state,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode("utf-8")


def _bump_usage_record(
    record: dict[str, Any],
    *,
    event: str,
    timestamp: str,
) -> None:
    if event == "use":
        record["use_count"] = int(record["use_count"]) + 1
        record["last_used_at"] = timestamp
        return
    if event == "patch":
        record["patch_count"] = int(record["patch_count"]) + 1
        record["last_patched_at"] = timestamp
        return
    raise ValueError(f"unknown Skill usage event: {event}")


def _validate_support_path(file_path: str) -> str:
    if not isinstance(file_path, str) or not file_path:
        raise SkillStoreError(
            400,
            "supporting file path must be a non-empty string",
            code="invalid_support_path",
        )
    _reject_surrogates(
        file_path,
        "supporting file path",
        code="invalid_support_path",
    )
    if (
        "\x00" in file_path
        or "\\" in file_path
        or file_path.startswith("/")
        or len(file_path) > 240
    ):
        raise SkillStoreError(
            400,
            "invalid supporting file path",
            code="invalid_support_path",
        )
    parts = file_path.split("/")
    if (
        len(parts) < 2
        or parts[0] not in SUPPORT_DIRECTORIES
        or _SUPPORT_WRITE_ORPHAN_RE.fullmatch(parts[-1])
        or any(
            not part
            or part in {".", ".."}
            or len(part.encode("utf-8")) > 255
            or any(ord(character) < 32 or ord(character) == 127 for character in part)
            for part in parts
        )
    ):
        raise SkillStoreError(
            400,
            (
                "supporting files must be relative paths below references, "
                "templates, scripts, or assets"
            ),
            code="invalid_support_path",
        )
    return "/".join(parts)


def _validate_support_content(content: Any) -> bytes:
    if not isinstance(content, str):
        raise SkillStoreError(
            400,
            "supporting file content must be UTF-8 text",
            code="invalid_support_content",
        )
    _reject_surrogates(
        content,
        "supporting file content",
        code="invalid_support_content",
    )
    if "\x00" in content:
        raise SkillStoreError(
            400,
            "supporting file content must not contain NUL",
            code="invalid_support_content",
        )
    if _credential_material_reasons(content):
        raise SkillStoreError(
            400,
            "supporting file contains apparent plaintext credential material",
            code="sensitive_skill_content",
        )
    encoded = content.encode("utf-8")
    if len(encoded) > MAX_SUPPORT_FILE_BYTES:
        raise SkillStoreError(
            413,
            (
                "a supporting file may contain at most "
                f"{MAX_SUPPORT_FILE_BYTES} bytes"
            ),
            code="support_size_exceeded",
        )
    return encoded


def _credential_material_reasons(content: str) -> list[str]:
    """Return high-confidence literal credential classes without flagging prose.

    Credential-related terms and placeholders are intentionally allowed. This
    boundary targets values that are directly reusable as secrets.
    """

    reasons: list[str] = []
    if _PREFIXED_CREDENTIAL_RE.search(content):
        reasons.append("prefixed_token")
    if any(_looks_like_private_key_block(match) for match in _PRIVATE_KEY_BLOCK_RE.finditer(content)):
        reasons.append("private_key")
    for match in _BEARER_CREDENTIAL_RE.finditer(content):
        value = match.group("value")
        if _BEARER_PLACEHOLDER_RE.match(value):
            continue
        if any(character.isdigit() for character in value) or any(
            character in "._~+/=" for character in value
        ):
            reasons.append("bearer_token")
            break
    return reasons


def _looks_like_private_key_block(match: re.Match[str]) -> bool:
    compact = "".join(match.group("body").split())
    if len(compact) < 64 or len(compact) % 4:
        return False
    try:
        decoded = base64.b64decode(compact.encode("ascii"), validate=True)
    except (UnicodeEncodeError, binascii.Error, ValueError):
        return False
    if match.group("label") == "OPENSSH PRIVATE KEY":
        return decoded.startswith(b"openssh-key-v1\x00")
    if len(decoded) < 32 or decoded[0] != 0x30 or len(decoded) < 2:
        return False
    first_length = decoded[1]
    if first_length < 0x80:
        header_length = 2
        payload_length = first_length
    else:
        length_bytes = first_length & 0x7F
        if not 1 <= length_bytes <= 4 or len(decoded) < 2 + length_bytes:
            return False
        header_length = 2 + length_bytes
        payload_length = int.from_bytes(decoded[2:header_length], "big")
    return header_length + payload_length == len(decoded)


def _reject_surrogates(value: str, field: str, *, code: str) -> None:
    if any(0xD800 <= ord(character) <= 0xDFFF for character in value):
        raise SkillStoreError(
            400,
            f"{field} must contain valid UTF-8 text",
            code=code,
        )


def _read_private_text(
    path: Path,
    *,
    max_bytes: int,
    missing_status: int,
    label: str,
) -> tuple[str, int]:
    data = _read_private_bytes(
        path,
        max_bytes=max_bytes,
        missing_status=missing_status,
        label=label,
    )
    try:
        return data.decode("utf-8"), len(data)
    except UnicodeDecodeError as exc:
        raise SkillStoreError(
            409 if missing_status == 404 else 500,
            f"{label} must be UTF-8 text",
            code="invalid_support_content" if missing_status == 404 else "corrupt_skill",
        ) from exc


def _read_private_bytes(
    path: Path,
    *,
    max_bytes: int,
    missing_status: int,
    label: str,
    require_owner_only: bool = False,
    require_single_link: bool = False,
) -> bytes:
    flags = os.O_RDONLY
    if hasattr(os, "O_NONBLOCK"):
        flags |= os.O_NONBLOCK
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(path, flags)
    except FileNotFoundError as exc:
        raise SkillStoreError(
            missing_status,
            f"{label} not found",
            code="support_file_not_found" if missing_status == 404 else "corrupt_skill",
        ) from exc
    except OSError as exc:
        raise SkillStoreError(
            409,
            f"unsafe {label}: {exc}",
            code="unsafe_skill_path",
        ) from exc
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise SkillStoreError(
                409,
                f"{label} must be a regular non-symlink file",
                code="unsafe_skill_path",
            )
        if info.st_nlink != 1:
            raise SkillStoreError(
                409,
                f"{label} must not be hard-linked",
                code="unsafe_skill_path",
            )
        if require_single_link and info.st_nlink != 1:
            raise SkillStoreError(
                409,
                f"{label} must not be hard-linked",
                code="unsafe_skill_path",
            )
        if require_owner_only and (
            info.st_uid != os.geteuid() or info.st_mode & 0o077
        ):
            raise SkillStoreError(
                409,
                f"{label} must be owned by the current user and owner-only",
                code="unsafe_skill_path",
            )
        if info.st_size > max_bytes:
            raise SkillStoreError(
                413 if missing_status == 404 else 500,
                f"{label} exceeds its size limit",
                code="support_size_exceeded" if missing_status == 404 else "corrupt_skill",
            )
        with os.fdopen(fd, "rb") as handle:
            fd = -1
            data = handle.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise SkillStoreError(
                413 if missing_status == 404 else 500,
                f"{label} exceeds its size limit",
                code="support_size_exceeded" if missing_status == 404 else "corrupt_skill",
            )
        return data
    finally:
        if fd >= 0:
            os.close(fd)


def _inspect_private_file_size(
    path: Path,
    *,
    max_bytes: int,
    missing_status: int,
    label: str,
) -> int:
    """Inspect a file without reading its payload or blocking on a FIFO."""

    flags = os.O_RDONLY
    if hasattr(os, "O_NONBLOCK"):
        flags |= os.O_NONBLOCK
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(path, flags)
    except FileNotFoundError as exc:
        raise SkillStoreError(
            missing_status,
            f"{label} not found",
            code="support_file_not_found" if missing_status == 404 else "corrupt_skill",
        ) from exc
    except OSError as exc:
        raise SkillStoreError(
            409,
            f"unsafe {label}: {exc}",
            code="unsafe_skill_path",
        ) from exc
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise SkillStoreError(
                409,
                f"{label} must be a regular non-symlink file",
                code="unsafe_skill_path",
            )
        if info.st_nlink != 1:
            raise SkillStoreError(
                409,
                f"{label} must not be hard-linked",
                code="unsafe_skill_path",
            )
        if info.st_size > max_bytes:
            raise SkillStoreError(
                413 if missing_status == 404 else 500,
                f"{label} exceeds its size limit",
                code="support_size_exceeded" if missing_status == 404 else "corrupt_skill",
            )
        return int(info.st_size)
    finally:
        os.close(fd)


def _atomic_write_bytes(path: Path, data: bytes) -> None:
    """Write one private regular file using a same-directory atomic replace."""

    try:
        info = path.lstat()
    except FileNotFoundError:
        pass
    else:
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            raise SkillStoreError(
                409,
                f"refusing to replace unsafe file: {path.name}",
                code="unsafe_skill_path",
            )

    temporary = path.parent / f".{path.name}.{secrets.token_hex(8)}.tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(temporary, flags, 0o600)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as handle:
            fd = -1
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    except BaseException:
        try:
            temporary.unlink()
        except OSError:
            pass
        raise
    finally:
        if fd >= 0:
            os.close(fd)


def _fsync_directory(path: Path) -> None:
    flags = os.O_RDONLY
    if hasattr(os, "O_DIRECTORY"):
        flags |= os.O_DIRECTORY
    fd = os.open(path, flags)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _remove_pinned_directory_entry(
    parent_fd: int,
    name: str,
    directory_fd: int,
) -> None:
    """Erase one already-pinned private tree without resolving its pathname."""

    remaining = [MAX_SUPPORT_DIRECTORIES + MAX_SUPPORT_FILES + 2]

    def clear(current_fd: int) -> None:
        names: list[str] = []
        with os.scandir(current_fd) as entries:
            for entry in entries:
                remaining[0] -= 1
                if remaining[0] < 0:
                    raise UnsafePrivatePathError(
                        "Skill deletion tree exceeds its limits"
                    )
                names.append(entry.name)
        for child_name in names:
            info = os.stat(child_name, dir_fd=current_fd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode):
                child_fd = open_private_child_directory_fd(
                    current_fd,
                    child_name,
                    mode=None,
                )
                try:
                    clear(child_fd)
                    verify_private_child_directory_fd(
                        current_fd,
                        child_name,
                        child_fd,
                        mode=None,
                    )
                    os.rmdir(child_name, dir_fd=current_fd)
                finally:
                    os.close(child_fd)
                continue
            os.unlink(child_name, dir_fd=current_fd)
        os.fsync(current_fd)

    verify_private_child_directory_fd(parent_fd, name, directory_fd, mode=None)
    clear(directory_fd)
    verify_private_child_directory_fd(parent_fd, name, directory_fd, mode=None)
    os.rmdir(name, dir_fd=parent_fd)
    os.fsync(parent_fd)


def _remove_tree_quietly(path: Path) -> None:
    try:
        shutil.rmtree(path)
    except FileNotFoundError:
        pass
    except OSError:
        pass


def _restore_private_file(path: Path, old_bytes: bytes) -> None:
    """Best-effort rollback for a file replaced within a larger transaction."""

    try:
        _atomic_write_bytes(path, old_bytes)
    except (OSError, SkillStoreError):
        pass


def _copy_skill_record(record: dict[str, Any]) -> dict[str, Any]:
    copied = dict(record)
    copied["tags"] = list(record.get("tags") or [])
    copied["linked_files"] = list(record.get("linked_files") or [])
    return copied


def _without_load_fields(record: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in record.items()
        if key not in {"instructions", "skill_dir"}
    }


def _utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="microseconds")
        .replace("+00:00", "Z")
    )


def _prompt_description(description: str) -> str:
    collapsed = " ".join(description.split())
    if len(collapsed) <= PROMPT_DESCRIPTION_CHARS:
        return collapsed
    return collapsed[: PROMPT_DESCRIPTION_CHARS - 1].rstrip() + "…"


def _json_char_length(value: Any) -> int:
    return len(
        json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )


def _largest_fitting_description(
    existing: list[dict[str, str]],
    base_item: dict[str, str],
    description: str,
    max_chars: int,
) -> str | None:
    if _json_char_length([*existing, base_item]) > max_chars:
        return None
    low = 0
    high = len(description)
    best = ""
    while low <= high:
        middle = (low + high) // 2
        if middle >= len(description):
            candidate_description = description
        elif middle == 0:
            candidate_description = ""
        else:
            candidate_description = description[: max(0, middle - 1)].rstrip() + "…"
        item = dict(base_item)
        item["description"] = candidate_description
        if _json_char_length([*existing, item]) <= max_chars:
            best = candidate_description
            low = middle + 1
        else:
            high = middle - 1
    return best
