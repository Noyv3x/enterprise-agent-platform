from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path
from typing import Any

from .secure_fs import (
    UnsafePrivatePathError,
    ensure_private_directory,
    open_private_child_directory_fd,
    open_private_directory_fd,
    publish_private_file_at,
    read_private_file_at,
)
from .technical_profile import (
    SOURCE_TECHNICAL_PROFILE,
    TARGET_TECHNICAL_PROFILE,
    TechnicalProfile,
    other_technical_profile,
    technical_profile,
)


CAMOFOX_SIDECAR_SCHEMA_VERSION = 1
CAMOFOX_SIDECAR_NAME = SOURCE_TECHNICAL_PROFILE.camofox_sidecar_name
CAMOFOX_TARGET_SIDECAR_NAME = TARGET_TECHNICAL_PROFILE.camofox_sidecar_name
CAMOFOX_SOURCE_TECHNICAL_PROFILE = SOURCE_TECHNICAL_PROFILE.profile_id
CAMOFOX_TARGET_TECHNICAL_PROFILE = TARGET_TECHNICAL_PROFILE.profile_id
_MAX_SIDECAR_BYTES = 16 * 1024


def expected_camofox_sidecar(
    technical_profile_value: TechnicalProfile | str = SOURCE_TECHNICAL_PROFILE,
) -> dict[str, Any]:
    profile = technical_profile(technical_profile_value)
    return {
        "schema_version": CAMOFOX_SIDECAR_SCHEMA_VERSION,
        "kind": "platform-camofox-runtime",
        "technical_profile": profile.profile_id,
        "runtime_relative_path": "runtimes/camofox",
        "profiles_relative_path": "runtimes/camofox/profiles",
        "cookies_relative_path": "runtimes/camofox/cookies",
        "traces_relative_path": "runtimes/camofox/traces",
        "profile_directory_format": "sha256-user-id-32",
    }


def is_expected_camofox_sidecar(
    value: Any,
    technical_profile_value: TechnicalProfile | str = SOURCE_TECHNICAL_PROFILE,
) -> bool:
    """Match the sidecar without treating JSON booleans as integers."""

    return (
        isinstance(value, dict)
        and type(value.get("schema_version")) is int
        and value == expected_camofox_sidecar(technical_profile_value)
    )


def ensure_camofox_runtime_sidecar(
    data_dir: Path,
    *,
    commit_schema_upgrade: bool = True,
    technical_profile_value: TechnicalProfile | str = SOURCE_TECHNICAL_PROFILE,
) -> Path:
    """Create or validate the only Platform-owned Camoufox metadata file.

    Browser profile contents remain owned by the pinned Camoufox dependency.
    In particular, this function never enumerates or rewrites Cookie, IndexedDB,
    storage-state, meta.json, or webpage storage files.
    """

    profile = technical_profile(technical_profile_value)
    data_root = Path(data_dir).expanduser()
    runtime_root = data_root / "runtimes" / "camofox"
    sidecar = runtime_root / profile.camofox_sidecar_name
    expected = expected_camofox_sidecar(profile)
    if not commit_schema_upgrade:
        try:
            # This is a pre-writer identity check.  A legacy source-profile
            # root may still have the process umask's mode until the normal
            # startup path tightens it below; pin it read-only here without
            # mutating permissions, while still enforcing owner and type.
            data_fd = open_private_directory_fd(data_root, mode=None)
        except FileNotFoundError:
            return sidecar
        try:
            try:
                runtimes_fd = open_private_child_directory_fd(data_fd, "runtimes")
            except FileNotFoundError:
                return sidecar
            try:
                try:
                    directory_fd = open_private_child_directory_fd(
                        runtimes_fd, "camofox"
                    )
                except FileNotFoundError:
                    return sidecar
            finally:
                os.close(runtimes_fd)
        finally:
            os.close(data_fd)
    else:
        data_root = ensure_private_directory(data_root)
        runtimes = ensure_private_directory(data_root / "runtimes")
        runtime_root = ensure_private_directory(runtimes / "camofox")
        directory_fd = open_private_directory_fd(runtime_root)
    try:
        other_name = other_technical_profile(profile).camofox_sidecar_name
        try:
            os.stat(other_name, dir_fd=directory_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise sqlite3.DatabaseError(
                "Platform Camoufox runtime contains another technical profile sidecar"
            )
        try:
            actual = _read_sidecar_at(directory_fd, profile.camofox_sidecar_name)
        except FileNotFoundError:
            if not commit_schema_upgrade:
                return sidecar
            encoded = (
                json.dumps(expected, ensure_ascii=False, sort_keys=True) + "\n"
            ).encode("utf-8")
            try:
                publish_private_file_at(
                    directory_fd,
                    profile.camofox_sidecar_name,
                    encoded,
                    replace_identity=None,
                )
            except UnsafePrivatePathError as exc:
                raise sqlite3.DatabaseError(
                    "Platform Camoufox sidecar could not be published safely"
                ) from exc
            return sidecar

        if not is_expected_camofox_sidecar(actual, profile):
            raise sqlite3.DatabaseError(
                "Platform Camoufox sidecar does not match the current technical profile"
            )
        return sidecar
    finally:
        os.close(directory_fd)


def _read_sidecar(path: Path) -> dict[str, Any]:
    directory_fd = open_private_directory_fd(path.parent)
    try:
        return _read_sidecar_at(directory_fd, path.name)
    except UnsafePrivatePathError as exc:
        raise sqlite3.DatabaseError(
            f"Platform Camoufox sidecar cannot be opened safely: {path}"
        ) from exc
    finally:
        os.close(directory_fd)


def _read_sidecar_at(directory_fd: int, name: str) -> dict[str, Any]:
    try:
        raw, _ = read_private_file_at(
            directory_fd,
            name,
            maximum_bytes=_MAX_SIDECAR_BYTES,
        )
    except UnsafePrivatePathError as exc:
        raise sqlite3.DatabaseError(
            "Platform Camoufox sidecar has unsafe file metadata"
        ) from exc

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
            "Platform Camoufox sidecar is invalid JSON"
        ) from exc
    if not isinstance(payload, dict):
        raise sqlite3.DatabaseError(
            "Platform Camoufox sidecar must be an object"
        )
    return payload
