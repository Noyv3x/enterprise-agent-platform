from __future__ import annotations

import sqlite3
from typing import Any

from .db import Database, now_ts


class SylverPlatformConnectionError(ValueError):
    pass


def _owner_id(value: Any) -> int:
    if isinstance(value, bool):
        raise SylverPlatformConnectionError("owner_user_id is invalid")
    try:
        owner_user_id = int(value)
    except (TypeError, ValueError) as exc:
        raise SylverPlatformConnectionError("owner_user_id is invalid") from exc
    if owner_user_id <= 0:
        raise SylverPlatformConnectionError("owner_user_id is invalid")
    return owner_user_id


def _remote_user_id(value: Any) -> int:
    if isinstance(value, bool):
        raise SylverPlatformConnectionError("remote_user_id is invalid")
    try:
        remote_user_id = int(value)
    except (TypeError, ValueError) as exc:
        raise SylverPlatformConnectionError("remote_user_id is invalid") from exc
    if remote_user_id <= 0:
        raise SylverPlatformConnectionError("remote_user_id is invalid")
    return remote_user_id


def _text(
    value: Any,
    *,
    field: str,
    maximum: int,
    required: bool = False,
) -> str:
    clean = str(value or "").strip()
    if required and not clean:
        raise SylverPlatformConnectionError(f"{field} is required")
    if len(clean) > maximum or any(character in clean for character in "\r\n\x00"):
        raise SylverPlatformConnectionError(f"{field} is invalid")
    return clean


def _token(value: Any) -> str:
    token = str(value or "")
    if not token or not token.strip():
        raise SylverPlatformConnectionError("token is required")
    if len(token) > 4_096 or any(character in token for character in "\r\n\x00"):
        raise SylverPlatformConnectionError("token is invalid")
    return token


class SylverPlatformConnectionStore:
    """Own the one verified Sylver Platform connection for each local user."""

    def __init__(self, db: Database):
        self.db = db

    @staticmethod
    def public(row: dict[str, Any]) -> dict[str, Any]:
        """Return the credential-free connection projection used by APIs."""

        return {
            "owner_user_id": int(row["owner_user_id"]),
            "base_url": str(row.get("base_url") or ""),
            "remote_user_id": int(row["remote_user_id"]),
            "username": str(row.get("username") or ""),
            "full_name": str(row.get("full_name") or ""),
            "title": str(row.get("title") or ""),
            "email": str(row.get("email") or ""),
            "role": str(row.get("role") or ""),
            "verified_at": int(row.get("verified_at") or 0),
            "created_at": int(row.get("created_at") or 0),
            "updated_at": int(row.get("updated_at") or 0),
            "credential_configured": bool(row.get("credential_configured")),
        }

    def get(self, owner_user_id: int) -> dict[str, Any] | None:
        row = self.db.query_one(
            """
            SELECT connections.*,
                   CASE WHEN credentials.owner_user_id IS NULL THEN 0 ELSE 1 END
                       AS credential_configured
            FROM sylver_platform_connections AS connections
            LEFT JOIN sylver_platform_credentials AS credentials
              ON credentials.owner_user_id = connections.owner_user_id
            WHERE connections.owner_user_id = ?
            """,
            (_owner_id(owner_user_id),),
        )
        return self.public(row) if row is not None else None

    def get_with_credential(
        self,
        owner_user_id: int,
    ) -> tuple[dict[str, Any], str] | None:
        row = self.db.query_one(
            """
            SELECT connections.*, credentials.token,
                   1 AS credential_configured
            FROM sylver_platform_connections AS connections
            JOIN sylver_platform_credentials AS credentials
              ON credentials.owner_user_id = connections.owner_user_id
            WHERE connections.owner_user_id = ?
            """,
            (_owner_id(owner_user_id),),
        )
        if row is None:
            return None
        token = str(row.pop("token") or "")
        if not token:
            return None
        return self.public(row), token

    def upsert(
        self,
        owner_user_id: int,
        body: dict[str, Any],
    ) -> dict[str, Any]:
        if not isinstance(body, dict):
            raise SylverPlatformConnectionError("connection body is invalid")
        allowed = {
            "base_url",
            "token",
            "remote_user_id",
            "username",
            "full_name",
            "title",
            "email",
            "role",
        }
        unknown = sorted(set(body) - allowed)
        if unknown:
            raise SylverPlatformConnectionError(
                "unknown Sylver Platform connection fields: " + ", ".join(unknown)
            )
        owner_id = _owner_id(owner_user_id)
        values = {
            "base_url": _text(
                body.get("base_url"), field="base_url", maximum=2_048, required=True
            ),
            "remote_user_id": _remote_user_id(body.get("remote_user_id")),
            "username": _text(
                body.get("username"), field="username", maximum=255, required=True
            ),
            "full_name": _text(
                body.get("full_name"), field="full_name", maximum=512
            ),
            "title": _text(body.get("title"), field="title", maximum=255),
            "email": _text(body.get("email"), field="email", maximum=320),
            "role": _text(body.get("role"), field="role", maximum=128),
            "token": _token(body.get("token")),
        }
        timestamp = now_ts()
        try:
            with self.db.transaction(immediate=True) as connection:
                connection.execute(
                    """
                    INSERT INTO sylver_platform_connections(
                        owner_user_id, base_url, remote_user_id, username,
                        full_name, title, email, role, verified_at,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(owner_user_id) DO UPDATE SET
                        base_url = excluded.base_url,
                        remote_user_id = excluded.remote_user_id,
                        username = excluded.username,
                        full_name = excluded.full_name,
                        title = excluded.title,
                        email = excluded.email,
                        role = excluded.role,
                        verified_at = excluded.verified_at,
                        updated_at = excluded.updated_at
                    """,
                    (
                        owner_id,
                        values["base_url"],
                        values["remote_user_id"],
                        values["username"],
                        values["full_name"],
                        values["title"],
                        values["email"],
                        values["role"],
                        timestamp,
                        timestamp,
                        timestamp,
                    ),
                )
                connection.execute(
                    """
                    INSERT INTO sylver_platform_credentials(
                        owner_user_id, token, updated_at
                    ) VALUES (?, ?, ?)
                    ON CONFLICT(owner_user_id) DO UPDATE SET
                        token = excluded.token,
                        updated_at = excluded.updated_at
                    """,
                    (owner_id, values["token"], timestamp),
                )
        except sqlite3.IntegrityError as exc:
            message = str(exc).casefold()
            if "base_url" in message and "remote_user_id" in message:
                raise SylverPlatformConnectionError(
                    "Sylver Platform identity is already connected to another user"
                ) from exc
            raise SylverPlatformConnectionError(
                "Sylver Platform connection could not be stored"
            ) from exc
        stored = self.get(owner_id)
        if stored is None:  # pragma: no cover - transaction invariant
            raise RuntimeError("Sylver Platform connection disappeared after upsert")
        return stored

    def delete(self, owner_user_id: int) -> bool:
        cursor = self.db.execute(
            "DELETE FROM sylver_platform_connections WHERE owner_user_id = ?",
            (_owner_id(owner_user_id),),
        )
        return cursor.rowcount > 0
