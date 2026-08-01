from __future__ import annotations

import hashlib
import json
import os
import posixpath
import re
import sqlite3
import stat
import struct
from pathlib import Path
from typing import Any, Iterator

from .camofox_state import _read_sidecar, is_expected_camofox_sidecar
from .container_contract_generated import AGENT_RUNTIME_HANDOFF
from .db import Database
from .secure_fs import (
    UnsafePrivatePathError,
    open_private_child_directory_fd,
    open_private_directory_fd,
    read_private_file_at,
)
from .technical_profile import (
    SOURCE_TECHNICAL_PROFILE,
    TechnicalProfile,
    technical_profile,
)


HANDOFF_EVIDENCE_SCHEMA_VERSION = 1
_MAX_IDENTITY_JSON_BYTES = 8 * 1024 * 1024
_RUNTIME_VALIDATION_LIMITS = AGENT_RUNTIME_HANDOFF["validation_limits"]


def _runtime_validation_limit(name: str) -> int:
    value = _RUNTIME_VALIDATION_LIMITS[name]
    if type(value) is not int or value <= 0:
        raise RuntimeError(f"Agent Runtime handoff limit {name} is invalid")
    return value


_MAX_RUNTIME_IDENTITIES = _runtime_validation_limit("maximum_identity_records")
_MAX_RUNTIME_JSONL_BYTES = _runtime_validation_limit("maximum_jsonl_bytes")
_MAX_RUNTIME_JSONL_RECORDS = _runtime_validation_limit("maximum_jsonl_records")
_MAX_RUNTIME_DIRECTORY_ENTRIES = _runtime_validation_limit(
    "maximum_directory_entries"
)
_SHA256_NAME = re.compile(r"^[0-9a-f]{64}$")


def collect_platform_handoff_evidence(
    db: Database,
    data_dir: Path,
    workspace_identity_sha256: str,
    blockers: dict[str, Any],
    technical_profile_value: TechnicalProfile | str = SOURCE_TECHNICAL_PROFILE,
) -> dict[str, Any]:
    """Return the bounded, secret-free Platform side of handoff evidence.

    The caller retains the Platform conversation/admission lock for the whole
    call.  This function performs no repair, reservation, directory creation,
    schema upgrade, or persistence.
    """

    profile = technical_profile(technical_profile_value)
    integrity_row = db.query_one("PRAGMA integrity_check(1)")
    if integrity_row is None or list(integrity_row.values()) != ["ok"]:
        raise sqlite3.IntegrityError("database integrity_check did not return ok")
    if db.query_one("PRAGMA foreign_key_check") is not None:
        raise sqlite3.IntegrityError("database foreign_key_check returned violations")
    database_schema_version = int(
        db.scalar("SELECT COALESCE(MAX(version), 0) FROM schema_migrations") or 0
    )
    if database_schema_version <= 0:
        raise sqlite3.DatabaseError("database schema version is unavailable")

    runtime_identity_sha256 = _runtime_identity(db, Path(data_dir) / "runtimes" / "agent")
    camofox_sidecar = (
        Path(data_dir)
        / "runtimes"
        / "camofox"
        / profile.camofox_sidecar_name
    )
    if not is_expected_camofox_sidecar(_read_sidecar(camofox_sidecar), profile):
        raise sqlite3.DatabaseError("Platform Camoufox sidecar is outside the current schema")

    count_fields = (
        "active_agent_tasks",
        "active_learning_reviews",
        "queued_agent_jobs",
        "running_agent_jobs",
        "admissions_in_progress",
    )
    counts: dict[str, int] = {}
    for field in count_fields:
        value = blockers.get(field)
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            raise sqlite3.DatabaseError(f"Platform handoff blocker {field} is invalid")
        counts[field] = value
    reserved = blockers.get("reserved")
    if not isinstance(reserved, bool):
        raise sqlite3.DatabaseError("Platform handoff reservation evidence is invalid")
    if not _SHA256_NAME.fullmatch(workspace_identity_sha256):
        raise sqlite3.DatabaseError("workspace identity digest is invalid")

    return {
        "schema_version": HANDOFF_EVIDENCE_SCHEMA_VERSION,
        "technical_profile": profile.profile_id,
        "database_schema_version": database_schema_version,
        "database_integrity": "ok",
        "database_foreign_keys": "ok",
        "platform_reservation_idle": not reserved,
        **counts,
        "runtime_schema_ready": True,
        "workspace_schema_ready": True,
        "camofox_schema_ready": True,
        "runtime_identity_sha256": runtime_identity_sha256,
        "workspace_identity_sha256": workspace_identity_sha256,
    }


def _runtime_identity(db: Database, runtime_root: Path) -> str:
    current_rows = db.query(
        """
        SELECT scope_key, session_id, lifecycle_id
        FROM agent_runtime_scopes
        ORDER BY scope_key
        LIMIT ?
        """,
        (_MAX_RUNTIME_IDENTITIES + 1,),
    )
    if len(current_rows) > _MAX_RUNTIME_IDENTITIES:
        raise sqlite3.DatabaseError(
            "Agent Runtime current identity count exceeds the handoff limit"
        )
    alias_rows = db.query(
        """
        SELECT scope_key, lifecycle_id, session_id
        FROM agent_runtime_scope_sessions
        ORDER BY scope_key, lifecycle_id, session_id
        LIMIT ?
        """,
        (_MAX_RUNTIME_IDENTITIES + 1,),
    )
    if len(alias_rows) > _MAX_RUNTIME_IDENTITIES:
        raise sqlite3.DatabaseError("Agent Runtime identity count exceeds the handoff limit")
    scope_rows = db.query(
        "SELECT scope_key FROM agent_scopes ORDER BY scope_key LIMIT ?",
        (_MAX_RUNTIME_IDENTITIES + 1,),
    )
    if len(scope_rows) > _MAX_RUNTIME_IDENTITIES:
        raise sqlite3.DatabaseError(
            "Agent Runtime scope count exceeds the handoff limit"
        )
    scope_keys = {str(row["scope_key"]) for row in scope_rows}
    if len(current_rows) != len(scope_keys) or {
        str(row["scope_key"]) for row in current_rows
    } != scope_keys:
        raise sqlite3.DatabaseError("Agent Runtime current scope identity is incomplete")
    aliases: dict[str, dict[str, dict[str, tuple[str, str]]]] = {}
    normalized_aliases: list[dict[str, str]] = []
    for row in alias_rows:
        scope_key = _runtime_text(row.get("scope_key"), "scope_key")
        lifecycle_id = _runtime_text(row.get("lifecycle_id"), "lifecycle_id")
        session_id = _runtime_text(row.get("session_id"), "session_id")
        if scope_key not in scope_keys:
            raise sqlite3.DatabaseError("Agent Runtime alias references an unknown scope")
        lifecycle_hash = _identity_hash(lifecycle_id)
        session_hash = _identity_hash(session_id)
        sessions = aliases.setdefault(scope_key, {}).setdefault(lifecycle_hash, {})
        if session_hash in sessions:
            raise sqlite3.DatabaseError("Agent Runtime alias identity is duplicated")
        sessions[session_hash] = (lifecycle_id, session_id)
        normalized_aliases.append(
            {
                "scope_key": scope_key,
                "lifecycle_id": lifecycle_id,
                "session_id": session_id,
            }
        )
    for row in current_rows:
        scope_key = _runtime_text(row.get("scope_key"), "scope_key")
        lifecycle_id = _runtime_text(row.get("lifecycle_id"), "lifecycle_id")
        session_id = _runtime_text(row.get("session_id"), "session_id")
        if _identity_hash(session_id) not in aliases.get(scope_key, {}).get(
            _identity_hash(lifecycle_id), {}
        ):
            raise sqlite3.DatabaseError("Agent Runtime current session has no durable alias")

    runtime_fd = _runtime_open_directory(runtime_root, 0o700)
    try:
        disk = _runtime_tree_evidence(runtime_fd, aliases, scope_keys)
    finally:
        os.close(runtime_fd)
    projection = {
        "current": [
            {
                "scope_key": _runtime_text(row.get("scope_key"), "scope_key"),
                "lifecycle_id": _runtime_text(row.get("lifecycle_id"), "lifecycle_id"),
                "session_id": _runtime_text(row.get("session_id"), "session_id"),
            }
            for row in current_rows
        ],
        "aliases": normalized_aliases,
        **disk,
    }
    return _canonical_sha256(projection)


def _runtime_tree_evidence(
    runtime_fd: int,
    aliases: dict[str, dict[str, dict[str, tuple[str, str]]]],
    scope_keys: set[str],
) -> dict[str, Any]:
    contract = AGENT_RUNTIME_HANDOFF
    current = set(contract["current_roots"])
    ephemeral = set(contract["ephemeral_roots"])
    retired_contract = contract["p1_retired_roots"]
    retired = set(retired_contract)
    names = set(_runtime_directory_names(runtime_fd))
    unknown = names - current - ephemeral - retired
    if unknown:
        raise sqlite3.DatabaseError(
            "Agent Runtime contains unknown top-level state: " + sorted(unknown)[0]
        )
    retired_present = names & retired
    if retired_present and retired_present != retired:
        raise sqlite3.DatabaseError("Agent Runtime P1 retired roots are incomplete")

    for name in sorted(ephemeral & names):
        fd = _runtime_open_child(runtime_fd, name, 0o700)
        os.close(fd)

    sessions_evidence: list[dict[str, str]] = []
    sessions_fd = _runtime_optional_child(runtime_fd, "sessions", 0o700)
    if sessions_fd is not None:
        try:
            sessions_evidence = _runtime_sessions_evidence(sessions_fd, aliases)
        finally:
            os.close(sessions_fd)

    approvals_evidence: dict[str, Any] | None = None
    approvals_fd = _runtime_optional_child(runtime_fd, "approvals", 0o700)
    if approvals_fd is not None:
        try:
            approvals_evidence = _runtime_approvals_evidence(
                approvals_fd, scope_keys
            )
        finally:
            os.close(approvals_fd)

    idempotency_evidence: dict[str, Any] | None = None
    idempotency_fd = _runtime_optional_child(runtime_fd, "idempotency", 0o700)
    if idempotency_fd is not None:
        try:
            idempotency_evidence = _runtime_idempotency_evidence(
                idempotency_fd, aliases
            )
        finally:
            os.close(idempotency_fd)

    retired_evidence: dict[str, Any] | None = None
    if retired_present:
        retired_evidence = _runtime_retired_evidence(runtime_fd, retired_contract)
    return {
        "session_files": sessions_evidence,
        "approvals": approvals_evidence,
        "idempotency": idempotency_evidence,
        "p1_retired": retired_evidence,
    }


def _runtime_sessions_evidence(
    sessions_fd: int,
    aliases: dict[str, dict[str, dict[str, tuple[str, str]]]],
) -> list[dict[str, str]]:
    scope_by_hash = {_identity_hash(scope): scope for scope in aliases}
    if len(scope_by_hash) != len(aliases):
        raise sqlite3.DatabaseError("Agent Runtime scope hash collision")
    evidence: list[dict[str, str]] = []
    seen = 0
    for scope_hash in _runtime_directory_names(sessions_fd):
        seen += 1
        if seen > _MAX_RUNTIME_IDENTITIES:
            raise sqlite3.DatabaseError("Agent Runtime disk identity count exceeds the limit")
        if not _SHA256_NAME.fullmatch(scope_hash) or scope_hash not in scope_by_hash:
            raise sqlite3.DatabaseError("Agent Runtime disk contains an unknown scope identity")
        scope_key = scope_by_hash[scope_hash]
        scope_fd = _runtime_open_child(sessions_fd, scope_hash, 0o700)
        try:
            names = _runtime_directory_names(scope_fd)
            if "scope.json" not in names:
                raise sqlite3.DatabaseError("Agent Runtime scope manifest is missing")
            scope_raw, scope_payload = _runtime_json_at(
                scope_fd, "scope.json", 16 * 1024
            )
            if scope_payload != {"scope_key": scope_key}:
                raise sqlite3.DatabaseError("Agent Runtime scope manifest is invalid")
            evidence.append(
                {
                    "path": f"sessions/{scope_hash}/scope.json",
                    "sha256": hashlib.sha256(scope_raw).hexdigest(),
                }
            )
            for lifecycle_hash in names:
                if lifecycle_hash == "scope.json":
                    continue
                seen += 1
                if seen > _MAX_RUNTIME_IDENTITIES:
                    raise sqlite3.DatabaseError(
                        "Agent Runtime disk identity count exceeds the limit"
                    )
                lifecycle_sessions = aliases[scope_key].get(lifecycle_hash)
                if (
                    not _SHA256_NAME.fullmatch(lifecycle_hash)
                    or lifecycle_sessions is None
                ):
                    raise sqlite3.DatabaseError(
                        "Agent Runtime disk contains an unknown lifecycle identity"
                    )
                lifecycle_fd = _runtime_open_child(scope_fd, lifecycle_hash, 0o700)
                try:
                    evidence.extend(
                        _runtime_lifecycle_evidence(
                            lifecycle_fd,
                            f"sessions/{scope_hash}/{lifecycle_hash}",
                            scope_key,
                            lifecycle_sessions,
                        )
                    )
                finally:
                    os.close(lifecycle_fd)
        finally:
            os.close(scope_fd)
    return sorted(evidence, key=lambda item: item["path"])


def _runtime_lifecycle_evidence(
    lifecycle_fd: int,
    relative: str,
    scope_key: str,
    sessions: dict[str, tuple[str, str]],
) -> list[dict[str, str]]:
    evidence: list[dict[str, str]] = []
    manifests: set[str] = set()
    journals: set[str] = set()
    for name in _runtime_directory_names(lifecycle_fd):
        if name == "approvals.jsonl":
            raw, _ = read_private_file_at(
                lifecycle_fd, name, maximum_bytes=_MAX_RUNTIME_JSONL_BYTES
            )
            _validate_approval_jsonl(raw, set(sessions.values()))
            evidence.append(
                {"path": f"{relative}/{name}", "sha256": hashlib.sha256(raw).hexdigest()}
            )
            continue
        suffix = next(
            (value for value in (".manifest.json", ".archive.jsonl", ".jsonl") if name.endswith(value)),
            "",
        )
        session_hash = name[: -len(suffix)] if suffix else ""
        identity = sessions.get(session_hash)
        if not _SHA256_NAME.fullmatch(session_hash) or identity is None or not suffix:
            raise sqlite3.DatabaseError("Agent Runtime lifecycle contains an unknown file")
        lifecycle_id, session_id = identity
        if suffix == ".manifest.json":
            raw, payload = _runtime_json_at(lifecycle_fd, name, 16 * 1024)
            if (
                set(payload) != {"scope_key", "lifecycle_id", "session_id", "updated_at"}
                or payload["scope_key"] != scope_key
                or payload["lifecycle_id"] != lifecycle_id
                or payload["session_id"] != session_id
                or not isinstance(payload["updated_at"], str)
                or not payload["updated_at"]
            ):
                raise sqlite3.DatabaseError("Agent Runtime session manifest is invalid")
            manifests.add(session_hash)
        else:
            raw, _ = read_private_file_at(
                lifecycle_fd, name, maximum_bytes=_MAX_RUNTIME_JSONL_BYTES
            )
            _validate_session_jsonl(raw, scope_key, lifecycle_id, session_id)
            journals.add(session_hash)
        evidence.append(
            {"path": f"{relative}/{name}", "sha256": hashlib.sha256(raw).hexdigest()}
        )
    if not journals.issubset(manifests):
        raise sqlite3.DatabaseError("Agent Runtime journal has no identity manifest")
    return evidence


def _runtime_approvals_evidence(
    directory_fd: int, scope_keys: set[str]
) -> dict[str, Any] | None:
    names = _runtime_directory_names(directory_fd)
    if not names:
        return None
    if names != ["always.json"]:
        raise sqlite3.DatabaseError("Agent Runtime approvals contains unknown state")
    raw, payload = _runtime_json_at(directory_fd, "always.json", _MAX_IDENTITY_JSON_BYTES)
    if (
        set(payload) != {"version", "grants"}
        or type(payload["version"]) is not int
        or payload["version"] != 2
        or not isinstance(payload["grants"], list)
    ):
        raise sqlite3.DatabaseError("Agent Runtime permanent approvals are outside schema 2")
    if len(payload["grants"]) > _MAX_RUNTIME_IDENTITIES:
        raise sqlite3.DatabaseError("Agent Runtime permanent approval count exceeds the limit")
    seen: set[tuple[str, str]] = set()
    for grant in payload["grants"]:
        if not isinstance(grant, dict) or set(grant) != {"scope_key", "approval_key", "tool_name", "created_at"}:
            raise sqlite3.DatabaseError("Agent Runtime permanent approval is invalid")
        scope = grant["scope_key"]
        approval = grant["approval_key"]
        if (
            scope not in scope_keys
            or not isinstance(approval, str)
            or not approval.startswith("v2:")
            or not isinstance(grant["tool_name"], str)
            or not grant["tool_name"]
            or not isinstance(grant["created_at"], str)
            or not grant["created_at"]
            or (scope, approval) in seen
        ):
            raise sqlite3.DatabaseError("Agent Runtime permanent approval is invalid or duplicated")
        seen.add((scope, approval))
    return {"sha256": hashlib.sha256(raw).hexdigest(), "records": len(payload["grants"])}


def _runtime_idempotency_evidence(
    directory_fd: int,
    aliases: dict[str, dict[str, dict[str, tuple[str, str]]]],
) -> dict[str, Any] | None:
    names = _runtime_directory_names(directory_fd)
    if not names:
        return None
    if names != ["index.json"]:
        raise sqlite3.DatabaseError("Agent Runtime idempotency contains unknown state")
    raw, payload = _runtime_json_at(directory_fd, "index.json", _MAX_IDENTITY_JSON_BYTES)
    if (
        set(payload) != {"version", "records"}
        or type(payload["version"]) is not int
        or payload["version"] != 1
        or not isinstance(payload["records"], list)
    ):
        raise sqlite3.DatabaseError("Agent Runtime idempotency index is invalid")
    records = payload["records"]
    if len(records) > _MAX_RUNTIME_IDENTITIES:
        raise sqlite3.DatabaseError("Agent Runtime idempotency count exceeds the limit")
    known_sessions = {
        session
        for lifecycles in aliases.values()
        for sessions in lifecycles.values()
        for _, session in sessions.values()
    }
    allowed = {"lookup_hash", "run_id", "session_id", "status", "created_at", "updated_at", "expires_at", "result", "inputs", "error"}
    seen: set[str] = set()
    for record in records:
        if not isinstance(record, dict) or not set(record).issubset(allowed):
            raise sqlite3.DatabaseError("Agent Runtime idempotency record is invalid")
        required = {"lookup_hash", "run_id", "session_id", "status", "created_at", "updated_at", "expires_at"}
        if not required.issubset(record):
            raise sqlite3.DatabaseError("Agent Runtime idempotency record is incomplete")
        lookup = record["lookup_hash"]
        created, updated, expires = record["created_at"], record["updated_at"], record["expires_at"]
        if (
            not isinstance(lookup, str)
            or not _SHA256_NAME.fullmatch(lookup)
            or lookup in seen
            or not isinstance(record["run_id"], str)
            or not record["run_id"]
            or record["session_id"] not in known_sessions
            or record["status"] not in {"completed", "failed", "cancelled", "needs_review"}
            or any(isinstance(value, bool) or not isinstance(value, int) for value in (created, updated, expires))
            or created < 0
            or updated < created
            or expires < updated
        ):
            raise sqlite3.DatabaseError("Agent Runtime idempotency record is active or outside the current schema")
        seen.add(lookup)
    return {"sha256": hashlib.sha256(raw).hexdigest(), "records": len(records)}


def _validate_session_jsonl(raw: bytes, scope: str, lifecycle: str, session: str) -> None:
    for payload in _runtime_jsonl(raw, "session"):
        allowed = {"id", "type", "timestamp", "scope_key", "lifecycle_id", "session_id", "model_content_security_version", "payload"}
        required = {"id", "type", "timestamp", "scope_key", "lifecycle_id", "session_id", "payload"}
        if not required.issubset(payload) or not set(payload).issubset(allowed):
            raise sqlite3.DatabaseError("Agent Runtime session entry has unknown or missing fields")
        if (
            any(not isinstance(payload[field], str) or not payload[field] for field in ("id", "type", "timestamp", "scope_key", "lifecycle_id", "session_id"))
            or payload["type"] not in {"header", "message", "compaction", "run"}
            or payload["scope_key"] != scope
            or payload["lifecycle_id"] != lifecycle
            or payload["session_id"] != session
        ):
            raise sqlite3.DatabaseError("Agent Runtime session entry identity is invalid")


def _validate_approval_jsonl(raw: bytes, sessions: set[tuple[str, str]]) -> None:
    known_sessions = {session for _, session in sessions}
    for payload in _runtime_jsonl(raw, "approval"):
        allowed = {"id", "type", "timestamp", "session_id", "tool_name", "approval_key"}
        if not {"id", "type", "timestamp"}.issubset(payload) or not set(payload).issubset(allowed):
            raise sqlite3.DatabaseError("Agent Runtime approval entry has unknown or missing fields")
        if any(not isinstance(payload[field], str) or not payload[field] for field in ("id", "type", "timestamp")):
            raise sqlite3.DatabaseError("Agent Runtime approval entry is invalid")
        if payload["type"] == "clear":
            if set(payload) != {"id", "type", "timestamp"}:
                raise sqlite3.DatabaseError("Agent Runtime approval clear entry contains grant fields")
        elif payload["type"] == "grant":
            if set(payload) != allowed or payload["session_id"] not in known_sessions or not isinstance(payload["tool_name"], str) or not payload["tool_name"] or not isinstance(payload["approval_key"], str) or not payload["approval_key"].startswith("v2:"):
                raise sqlite3.DatabaseError("Agent Runtime approval grant entry is invalid")
        else:
            raise sqlite3.DatabaseError("Agent Runtime approval entry is invalid")


def _runtime_jsonl(raw: bytes, label: str) -> Iterator[dict[str, Any]]:
    """Yield bounded JSONL records using the bridge's whitespace semantics."""

    records = 0
    start = 0
    view = memoryview(raw)
    while start < len(raw):
        newline = raw.find(b"\n", start)
        if newline < 0:
            line = view[start:]
            start = len(raw)
        else:
            line = view[start:newline]
            start = newline + 1
        try:
            normalized = str(line, "utf-8").strip()
        except UnicodeDecodeError as exc:
            raise sqlite3.DatabaseError(
                f"Agent Runtime {label} JSONL is invalid UTF-8"
            ) from exc
        if not normalized:
            continue
        records += 1
        if records > _MAX_RUNTIME_JSONL_RECORDS:
            raise sqlite3.DatabaseError(
                f"Agent Runtime {label} JSONL exceeds the record limit"
            )
        yield _runtime_decode_object(normalized, f"Agent Runtime {label} JSONL")


def _runtime_retired_evidence(runtime_fd: int, contract: dict[str, Any]) -> dict[str, Any]:
    app_fd = _runtime_open_child(runtime_fd, "app", int(contract["app"]["mode"]))
    try:
        app_names = _runtime_directory_names(app_fd)
        if app_names != sorted(contract["app"]["top_level_entries"]):
            raise sqlite3.DatabaseError("Agent Runtime retired app top-level inventory is invalid")
        install_raw, install = _runtime_json_at(app_fd, "install.json", 64 * 1024, mode=None)
        if set(install) != {"installed_at", "source_signature"} or not isinstance(install["installed_at"], str) or not install["installed_at"] or install["source_signature"] != contract["app"]["install_source_signature"]:
            raise sqlite3.DatabaseError("Agent Runtime retired app installation identity is invalid")
        _, package = _runtime_json_at(app_fd, "package.json", 1024 * 1024, mode=None)
        if package.get("name") != contract["app"]["package_name"] or package.get("version") != contract["app"]["package_version"]:
            raise sqlite3.DatabaseError("Agent Runtime retired app package identity is invalid")
        inventory = _runtime_retired_inventory(app_fd, contract["app"])
    finally:
        os.close(app_fd)
    for name in ("home", "memory"):
        fd = _runtime_open_child(runtime_fd, name, int(contract[name]["mode"]))
        try:
            if _runtime_directory_names(fd):
                raise sqlite3.DatabaseError(f"Agent Runtime retired {name} is not empty")
        finally:
            os.close(fd)
    migration_contract = contract["migration"]
    migration_fd = _runtime_open_child(runtime_fd, "migration", int(migration_contract["mode"]))
    try:
        if _runtime_directory_names(migration_fd) != [migration_contract["file_name"]]:
            raise sqlite3.DatabaseError("Agent Runtime retired migration inventory is invalid")
        migration_raw, migration = _runtime_json_at(
            migration_fd,
            migration_contract["file_name"],
            1024 * 1024,
            mode=int(migration_contract["file_mode"]),
        )
        if (
            set(migration) != set(migration_contract["fields"])
            or type(migration["version"]) is not int
            or migration["version"] != migration_contract["schema_version"]
            or migration["phase"] != migration_contract["phase"]
        ):
            raise sqlite3.DatabaseError("Agent Runtime retired migration record is invalid")
        for field, value in migration.items():
            if field == "phase":
                continue
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise sqlite3.DatabaseError("Agent Runtime retired migration counter is invalid")
    finally:
        os.close(migration_fd)
    return {
        **inventory,
        "install_sha256": hashlib.sha256(install_raw).hexdigest(),
        "migration_sha256": hashlib.sha256(migration_raw).hexdigest(),
    }


def _runtime_retired_inventory(app_fd: int, contract: dict[str, Any]) -> dict[str, Any]:
    if contract["inventory_algorithm"] != "runtime-retired-tree-v1":
        raise sqlite3.DatabaseError("Agent Runtime retired inventory algorithm is unsupported")
    digest = hashlib.sha256()
    entries = 0
    leaf_bytes = 0
    maximum_entries = contract["inventory_entries"]
    maximum_leaf_bytes = contract["inventory_regular_bytes"]
    if (
        type(maximum_entries) is not int
        or maximum_entries <= 0
        or type(maximum_leaf_bytes) is not int
        or maximum_leaf_bytes <= 0
    ):
        raise sqlite3.DatabaseError(
            "Agent Runtime retired app inventory budget is invalid"
        )
    root_device = os.fstat(app_fd).st_dev
    allowed_symlinks = dict(contract["allowed_symlinks"])
    seen_symlinks: set[str] = set()

    def record(kind: bytes, path: str, mode: int, size: int, detail: bytes) -> None:
        nonlocal entries, leaf_bytes
        if entries >= maximum_entries:
            raise sqlite3.DatabaseError(
                "Agent Runtime retired app exceeds its entry budget"
            )
        if kind != b"D" and (
            size < 0 or size > maximum_leaf_bytes - leaf_bytes
        ):
            raise sqlite3.DatabaseError(
                "Agent Runtime retired app exceeds its byte budget"
            )
        encoded_path = path.encode("utf-8")
        digest.update(kind)
        digest.update(struct.pack(">I", len(encoded_path)))
        digest.update(encoded_path)
        digest.update(struct.pack(">I", mode))
        digest.update(struct.pack(">Q", size))
        digest.update(struct.pack(">I", len(detail)))
        digest.update(detail)
        entries += 1
        if kind != b"D":
            leaf_bytes += size

    def walk(directory_fd: int, relative: str, *, emit_self: bool) -> None:
        if emit_self:
            info = os.fstat(directory_fd)
            _runtime_require_info(info, "directory", None, relative, root_device)
            record(b"D", relative, stat.S_IMODE(info.st_mode), 0, b"")
        child_dirs: list[tuple[str, os.stat_result]] = []
        leaves: list[tuple[str, os.stat_result]] = []
        names = _runtime_directory_names(
            directory_fd,
            maximum_entries=maximum_entries - entries,
        )
        level_leaf_bytes = 0
        for name in names:
            info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                child_dirs.append((name, info))
            else:
                leaves.append((name, info))
                if (
                    info.st_size < 0
                    or info.st_size > maximum_leaf_bytes - leaf_bytes - level_leaf_bytes
                ):
                    raise sqlite3.DatabaseError(
                        "Agent Runtime retired app exceeds its byte budget"
                    )
                level_leaf_bytes += info.st_size
        # v1 deliberately emits all immediate directories, then all immediate
        # leaves, then recursively visits those directories in the same order.
        for name, info in child_dirs:
            path = name if relative == "." else f"{relative}/{name}"
            _runtime_require_info(info, "directory", None, path, root_device)
            record(b"D", path, stat.S_IMODE(info.st_mode), 0, b"")
        for name, info in leaves:
            path = name if relative == "." else f"{relative}/{name}"
            if stat.S_ISREG(info.st_mode):
                file_hash = _runtime_hash_regular_at(
                    directory_fd,
                    name,
                    info,
                    root_device,
                    maximum_bytes=maximum_leaf_bytes - leaf_bytes,
                )
                record(b"F", path, stat.S_IMODE(info.st_mode), info.st_size, file_hash)
            elif stat.S_ISLNK(info.st_mode):
                _runtime_require_owner(info, path, root_device, link_count=1)
                target = os.readlink(name, dir_fd=directory_fd)
                after = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                if (after.st_dev, after.st_ino, after.st_size) != (info.st_dev, info.st_ino, info.st_size):
                    raise sqlite3.DatabaseError("Agent Runtime retired symlink changed while reading")
                expected = allowed_symlinks.get(path)
                normalized = posixpath.normpath(posixpath.join(posixpath.dirname(path), target))
                if expected != target or target.startswith("/") or normalized == ".." or normalized.startswith("../"):
                    raise sqlite3.DatabaseError("Agent Runtime retired symlink is outside the contract")
                detail = target.encode("utf-8")
                if len(detail) != info.st_size:
                    raise sqlite3.DatabaseError("Agent Runtime retired symlink size is invalid")
                seen_symlinks.add(path)
                record(b"L", path, stat.S_IMODE(info.st_mode), len(detail), detail)
            else:
                raise sqlite3.DatabaseError("Agent Runtime retired app contains a special file")
        for name, _ in child_dirs:
            child_fd = _runtime_open_child(directory_fd, name, None)
            try:
                walk(child_fd, name if relative == "." else f"{relative}/{name}", emit_self=False)
            finally:
                os.close(child_fd)

    root_info = os.fstat(app_fd)
    _runtime_require_info(root_info, "directory", int(contract["mode"]), ".", root_device)
    record(b"D", ".", stat.S_IMODE(root_info.st_mode), 0, b"")
    walk(app_fd, ".", emit_self=False)
    if seen_symlinks != set(allowed_symlinks):
        raise sqlite3.DatabaseError("Agent Runtime retired symlink inventory is incomplete")
    actual = {
        "inventory_algorithm": contract["inventory_algorithm"],
        "inventory_sha256": digest.hexdigest(),
        "inventory_entries": entries,
        "inventory_regular_bytes": leaf_bytes,
    }
    for field, value in actual.items():
        if value != contract[field]:
            raise sqlite3.DatabaseError(f"Agent Runtime retired app {field} does not match")
    return actual


def _runtime_hash_regular_at(
    parent_fd: int,
    name: str,
    before: os.stat_result,
    root_device: int,
    *,
    maximum_bytes: int,
) -> bytes:
    _runtime_require_info(before, "file", None, name, root_device, link_count=1)
    if before.st_size < 0 or before.st_size > maximum_bytes:
        raise sqlite3.DatabaseError(
            "Agent Runtime retired file exceeds its byte budget"
        )
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0), dir_fd=parent_fd)
    try:
        opened = os.fstat(fd)
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise sqlite3.DatabaseError("Agent Runtime retired file changed while opening")
        _runtime_require_info(opened, "file", None, name, root_device, link_count=1)
        if opened.st_size < 0 or opened.st_size > maximum_bytes:
            raise sqlite3.DatabaseError(
                "Agent Runtime retired file exceeds its byte budget"
            )
        digest = hashlib.sha256()
        size = 0
        remaining = maximum_bytes + 1
        while remaining:
            chunk = os.read(fd, min(256 * 1024, remaining))
            if not chunk:
                break
            digest.update(chunk)
            size += len(chunk)
            remaining -= len(chunk)
        if size > maximum_bytes:
            raise sqlite3.DatabaseError(
                "Agent Runtime retired file exceeds its byte budget"
            )
        after_fd = os.fstat(fd)
    finally:
        os.close(fd)
    after_path = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if (
        (after_fd.st_dev, after_fd.st_ino, after_fd.st_size) != (before.st_dev, before.st_ino, before.st_size)
        or (after_path.st_dev, after_path.st_ino, after_path.st_size) != (before.st_dev, before.st_ino, before.st_size)
        or size != before.st_size
    ):
        raise sqlite3.DatabaseError("Agent Runtime retired file changed while hashing")
    return digest.digest()


def _runtime_open_directory(path: Path, mode: int | None) -> int:
    try:
        return open_private_directory_fd(path, mode=mode)
    except (FileNotFoundError, UnsafePrivatePathError) as exc:
        raise sqlite3.DatabaseError(f"Agent Runtime directory is unsafe: {path}") from exc


def _runtime_open_child(parent_fd: int, name: str, mode: int | None) -> int:
    try:
        return open_private_child_directory_fd(parent_fd, name, mode=mode)
    except (FileNotFoundError, UnsafePrivatePathError) as exc:
        raise sqlite3.DatabaseError(f"Agent Runtime child directory is unsafe: {name}") from exc


def _runtime_optional_child(parent_fd: int, name: str, mode: int | None) -> int | None:
    try:
        return open_private_child_directory_fd(parent_fd, name, mode=mode)
    except FileNotFoundError:
        return None
    except UnsafePrivatePathError as exc:
        raise sqlite3.DatabaseError(f"Agent Runtime child directory is unsafe: {name}") from exc


def _runtime_directory_names(
    directory_fd: int,
    *,
    maximum_entries: int = _MAX_RUNTIME_DIRECTORY_ENTRIES,
) -> list[str]:
    if type(maximum_entries) is not int or maximum_entries < 0:
        raise ValueError("maximum_entries must be a non-negative integer")
    names: list[str] = []
    try:
        with os.scandir(directory_fd) as iterator:
            for entry in iterator:
                if len(names) >= maximum_entries:
                    raise sqlite3.DatabaseError(
                        "Agent Runtime directory exceeds its entry limit"
                    )
                names.append(entry.name)
    except OSError as exc:
        raise sqlite3.DatabaseError("Agent Runtime directory could not be enumerated") from exc
    return sorted(names)


def _runtime_json_at(
    parent_fd: int,
    name: str,
    maximum_bytes: int,
    *,
    mode: int | None = 0o600,
) -> tuple[bytes, dict[str, Any]]:
    try:
        raw, _ = read_private_file_at(
            parent_fd, name, maximum_bytes=maximum_bytes, mode=mode
        )
    except (FileNotFoundError, UnsafePrivatePathError) as exc:
        raise sqlite3.DatabaseError(f"Agent Runtime JSON file is unsafe: {name}") from exc
    return raw, _runtime_decode_object(raw, f"Agent Runtime JSON file {name}")


def _runtime_decode_object(raw: bytes | str, label: str) -> dict[str, Any]:
    def closed_object(pairs):
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate key {key}")
            result[key] = value
        return result

    try:
        text = raw.decode("utf-8") if isinstance(raw, bytes) else raw
        value = json.loads(
            text,
            object_pairs_hook=closed_object,
            parse_constant=lambda constant: (_ for _ in ()).throw(
                ValueError(f"non-standard JSON constant {constant}")
            ),
        )
    except (UnicodeDecodeError, ValueError, TypeError) as exc:
        raise sqlite3.DatabaseError(f"{label} is invalid JSON") from exc
    if not isinstance(value, dict):
        raise sqlite3.DatabaseError(f"{label} must be an object")
    return value


def _runtime_require_owner(info: os.stat_result, display: str, root_device: int, *, link_count: int | None = None) -> None:
    if info.st_dev != root_device or (hasattr(os, "getuid") and info.st_uid != os.getuid()) or (hasattr(os, "getgid") and info.st_gid != os.getgid()) or (link_count is not None and info.st_nlink != link_count):
        raise sqlite3.DatabaseError(f"Agent Runtime retired entry metadata is unsafe: {display}")


def _runtime_require_info(info: os.stat_result, kind: str, mode: int | None, display: str, root_device: int, *, link_count: int | None = None) -> None:
    valid = stat.S_ISDIR(info.st_mode) if kind == "directory" else stat.S_ISREG(info.st_mode)
    if not valid or (mode is not None and stat.S_IMODE(info.st_mode) != mode):
        raise sqlite3.DatabaseError(f"Agent Runtime retired {kind} metadata is unsafe: {display}")
    _runtime_require_owner(info, display, root_device, link_count=link_count)


def _runtime_text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 512 or any(
        character in value for character in "\r\n\x00"
    ):
        raise sqlite3.DatabaseError(f"Agent Runtime {field} is invalid")
    return value


def _identity_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _canonical_sha256(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()
