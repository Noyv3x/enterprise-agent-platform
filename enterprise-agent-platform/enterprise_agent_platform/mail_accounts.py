from __future__ import annotations

import re
from typing import Any

from .db import Database, now_ts
from .mail_gateway import MAIL_SECURITY_MODES, MailGatewayError, normalize_folder


MAX_MAIL_ACCOUNTS_PER_USER = 20
MIN_MAIL_POLL_SECONDS = 60
MAX_MAIL_POLL_SECONDS = 3600
_HOST_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$")


class MailAccountError(ValueError):
    pass


def _text(value: Any, *, field: str, maximum: int, required: bool = True) -> str:
    clean = str(value or "").strip()
    if required and not clean:
        raise MailAccountError(f"{field} is required")
    if len(clean) > maximum or any(character in clean for character in "\r\n\x00"):
        raise MailAccountError(f"{field} is invalid")
    return clean


def _host(value: Any, *, field: str) -> str:
    clean = _text(value, field=field, maximum=253).rstrip(".")
    if not _HOST_RE.fullmatch(clean) or clean.startswith(("http:", "https:")):
        raise MailAccountError(f"{field} must be a hostname or IP address")
    return clean


def _port(value: Any, *, field: str) -> int:
    if isinstance(value, bool):
        raise MailAccountError(f"{field} must be a valid port")
    try:
        port = int(value)
    except (TypeError, ValueError) as exc:
        raise MailAccountError(f"{field} must be a valid port") from exc
    if port < 1 or port > 65535:
        raise MailAccountError(f"{field} must be a valid port")
    return port


def _security(value: Any, *, field: str) -> str:
    clean = str(value or "").strip().casefold()
    if clean not in MAIL_SECURITY_MODES:
        raise MailAccountError(f"{field} must be tls or starttls")
    return clean


def _boolean(value: Any, *, field: str) -> bool:
    if not isinstance(value, bool):
        raise MailAccountError(f"{field} must be a boolean")
    return value


def _poll_interval(value: Any) -> int:
    if isinstance(value, bool):
        raise MailAccountError("poll_interval_seconds is invalid")
    try:
        interval = int(value)
    except (TypeError, ValueError) as exc:
        raise MailAccountError("poll_interval_seconds is invalid") from exc
    if interval < MIN_MAIL_POLL_SECONDS or interval > MAX_MAIL_POLL_SECONDS:
        raise MailAccountError(
            f"poll_interval_seconds must be between {MIN_MAIL_POLL_SECONDS} and {MAX_MAIL_POLL_SECONDS}"
        )
    return interval


class MailAccountStore:
    def __init__(self, db: Database):
        self.db = db

    @staticmethod
    def public(row: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": int(row["id"]),
            "label": str(row.get("label") or ""),
            "email_address": str(row.get("email_address") or ""),
            "username": str(row.get("username") or ""),
            "imap_host": str(row.get("imap_host") or ""),
            "imap_port": int(row.get("imap_port") or 0),
            "imap_security": str(row.get("imap_security") or "tls"),
            "smtp_host": str(row.get("smtp_host") or ""),
            "smtp_port": int(row.get("smtp_port") or 0),
            "smtp_security": str(row.get("smtp_security") or "tls"),
            "enabled": bool(row.get("enabled")),
            "wake_enabled": bool(row.get("wake_enabled")),
            "wake_folder": str(row.get("wake_folder") or "INBOX"),
            "poll_interval_seconds": int(row.get("poll_interval_seconds") or 300),
            "credential_configured": bool(row.get("credential_configured")),
            "last_checked_at": (
                int(row["last_checked_at"])
                if row.get("last_checked_at") is not None
                else None
            ),
            "last_error": str(row.get("last_error") or ""),
            "created_at": int(row.get("created_at") or 0),
            "updated_at": int(row.get("updated_at") or 0),
        }

    def list(self, owner_user_id: int) -> list[dict[str, Any]]:
        rows = self.db.query(
            """
            SELECT accounts.*,
                   CASE WHEN credentials.account_id IS NULL THEN 0 ELSE 1 END
                       AS credential_configured
            FROM mail_accounts AS accounts
            LEFT JOIN mail_account_credentials AS credentials
              ON credentials.account_id = accounts.id
            WHERE accounts.owner_user_id = ?
            ORDER BY accounts.id
            """,
            (int(owner_user_id),),
        )
        return [self.public(row) for row in rows]

    def get(self, owner_user_id: int, account_id: int) -> dict[str, Any] | None:
        return self.db.query_one(
            """
            SELECT accounts.*,
                   CASE WHEN credentials.account_id IS NULL THEN 0 ELSE 1 END
                       AS credential_configured
            FROM mail_accounts AS accounts
            LEFT JOIN mail_account_credentials AS credentials
              ON credentials.account_id = accounts.id
            WHERE accounts.owner_user_id = ? AND accounts.id = ?
            """,
            (int(owner_user_id), int(account_id)),
        )

    def get_with_credential(
        self, owner_user_id: int, account_id: int
    ) -> tuple[dict[str, Any], str] | None:
        row = self.db.query_one(
            """
            SELECT accounts.*, credentials.password
            FROM mail_accounts AS accounts
            JOIN mail_account_credentials AS credentials
              ON credentials.account_id = accounts.id
            WHERE accounts.owner_user_id = ? AND accounts.id = ?
            """,
            (int(owner_user_id), int(account_id)),
        )
        if row is None:
            return None
        password = str(row.pop("password") or "")
        if not password:
            return None
        return row, password

    def create(self, owner_user_id: int, body: dict[str, Any]) -> dict[str, Any]:
        if int(
            self.db.scalar(
                "SELECT count(*) FROM mail_accounts WHERE owner_user_id = ?",
                (int(owner_user_id),),
            )
            or 0
        ) >= MAX_MAIL_ACCOUNTS_PER_USER:
            raise MailAccountError("mail account limit reached")
        values = self._validated_create(body)
        password = self._password(body.get("password"), required=True)
        ts = now_ts()
        with self.db.transaction(immediate=True) as conn:
            cursor = conn.execute(
                """
                INSERT INTO mail_accounts(
                    owner_user_id, label, email_address, username,
                    imap_host, imap_port, imap_security,
                    smtp_host, smtp_port, smtp_security,
                    enabled, wake_enabled, wake_folder, poll_interval_seconds,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    int(owner_user_id),
                    values["label"],
                    values["email_address"],
                    values["username"],
                    values["imap_host"],
                    values["imap_port"],
                    values["imap_security"],
                    values["smtp_host"],
                    values["smtp_port"],
                    values["smtp_security"],
                    int(values["enabled"]),
                    int(values["wake_enabled"]),
                    values["wake_folder"],
                    values["poll_interval_seconds"],
                    ts,
                    ts,
                ),
            )
            account_id = int(cursor.lastrowid)
            conn.execute(
                "INSERT INTO mail_account_credentials(account_id, password, updated_at) VALUES (?, ?, ?)",
                (account_id, password, ts),
            )
        row = self.get(owner_user_id, account_id)
        if row is None:
            raise RuntimeError("mail account insert did not produce a row")
        return self.public(row)

    def update(
        self, owner_user_id: int, account_id: int, body: dict[str, Any]
    ) -> dict[str, Any]:
        current = self.get(owner_user_id, account_id)
        if current is None:
            raise MailAccountError("mail account not found")
        allowed = {
            "label", "email_address", "username", "imap_host", "imap_port",
            "imap_security", "smtp_host", "smtp_port", "smtp_security",
            "enabled", "wake_enabled", "wake_folder", "poll_interval_seconds",
            "password",
        }
        unknown = sorted(set(body) - allowed)
        if unknown:
            raise MailAccountError("unknown mail account fields: " + ", ".join(unknown))
        updates: dict[str, Any] = {}
        validators = {
            "label": lambda value: _text(value, field="label", maximum=120),
            "email_address": lambda value: self._email(value),
            "username": lambda value: _text(value, field="username", maximum=320),
            "imap_host": lambda value: _host(value, field="imap_host"),
            "imap_port": lambda value: _port(value, field="imap_port"),
            "imap_security": lambda value: _security(value, field="imap_security"),
            "smtp_host": lambda value: _host(value, field="smtp_host"),
            "smtp_port": lambda value: _port(value, field="smtp_port"),
            "smtp_security": lambda value: _security(value, field="smtp_security"),
            "enabled": lambda value: _boolean(value, field="enabled"),
            "wake_enabled": lambda value: _boolean(value, field="wake_enabled"),
            "wake_folder": lambda value: self._folder(value),
            "poll_interval_seconds": _poll_interval,
        }
        for field, validator in validators.items():
            if field in body:
                updates[field] = validator(body[field])
        password: str | None = None
        if "password" in body:
            password = self._password(body.get("password"), required=False)
            if not password:
                raise MailAccountError("password cannot be cleared")
        if not updates and password is None:
            return self.public(current)
        checkpoint_fields = {
            "imap_host", "imap_port", "imap_security", "username",
            "password", "wake_folder",
        }
        checkpoint_reset = bool(checkpoint_fields & (set(updates) | ({"password"} if password else set())))
        if updates.get("wake_enabled") is True and not bool(current.get("wake_enabled")):
            checkpoint_reset = True
        ts = now_ts()
        with self.db.transaction(immediate=True) as conn:
            owner_row = conn.execute(
                "SELECT * FROM mail_accounts WHERE owner_user_id = ? AND id = ?",
                (int(owner_user_id), int(account_id)),
            ).fetchone()
            if owner_row is None:
                raise MailAccountError("mail account not found")
            assignments = [f"{field} = ?" for field in updates]
            values = [int(value) if isinstance(value, bool) else value for value in updates.values()]
            assignments.extend(("revision = revision + 1", "last_error = ''", "updated_at = ?"))
            values.append(ts)
            if checkpoint_reset:
                assignments.extend(("checkpoint_initialized = 0", "uid_validity = NULL", "last_uid = 0"))
            conn.execute(
                f"UPDATE mail_accounts SET {', '.join(assignments)} WHERE id = ? AND owner_user_id = ?",
                (*values, int(account_id), int(owner_user_id)),
            )
            if password is not None:
                conn.execute(
                    """
                    INSERT INTO mail_account_credentials(account_id, password, updated_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(account_id) DO UPDATE SET
                        password = excluded.password, updated_at = excluded.updated_at
                    """,
                    (int(account_id), password, ts),
                )
        row = self.get(owner_user_id, account_id)
        if row is None:
            raise RuntimeError("updated mail account disappeared")
        return self.public(row)

    def delete(self, owner_user_id: int, account_id: int) -> bool:
        cursor = self.db.execute(
            "DELETE FROM mail_accounts WHERE owner_user_id = ? AND id = ?",
            (int(owner_user_id), int(account_id)),
        )
        return cursor.rowcount > 0

    def due_for_poll(self, timestamp: int, *, limit: int = 20) -> list[dict[str, Any]]:
        return self.db.query(
            """
            SELECT accounts.*, credentials.password
            FROM mail_accounts AS accounts
            JOIN mail_account_credentials AS credentials
              ON credentials.account_id = accounts.id
            JOIN users ON users.id = accounts.owner_user_id
            WHERE accounts.enabled = 1
              AND accounts.wake_enabled = 1
              AND users.active = 1
              AND (accounts.last_checked_at IS NULL
                   OR accounts.last_checked_at + accounts.poll_interval_seconds <= ?)
            ORDER BY COALESCE(
                         accounts.last_checked_at + accounts.poll_interval_seconds,
                         0
                     ),
                     accounts.id
            LIMIT ?
            """,
            (int(timestamp), max(1, min(int(limit), 100))),
        )

    def record_check(
        self, account_id: int, *, error: str = "", immediately_due: bool = False
    ) -> None:
        checked_at = now_ts()
        if immediately_due and not error:
            # Persist the first scheduling second after the current boundary.
            # It is due again on the worker's next pass without waiting for the
            # configured interval, while strict advancement prevents an id tie
            # from letting this account jump ahead of already-due work. The
            # ordering survives process restarts without an in-memory cursor.
            self.db.execute(
                """
                UPDATE mail_accounts
                SET last_checked_at = ? - poll_interval_seconds + 1,
                    last_error = '',
                    updated_at = ?
                WHERE id = ?
                """,
                (checked_at, checked_at, int(account_id)),
            )
            return
        self.db.execute(
            "UPDATE mail_accounts SET last_checked_at = ?, last_error = ?, updated_at = ? WHERE id = ?",
            (checked_at, str(error)[:2_000], checked_at, int(account_id)),
        )

    @staticmethod
    def _folder(value: Any) -> str:
        try:
            return normalize_folder(value)
        except MailGatewayError as exc:
            raise MailAccountError(str(exc)) from exc

    @staticmethod
    def _email(value: Any) -> str:
        clean = _text(value, field="email_address", maximum=320).casefold()
        if "@" not in clean or clean.startswith("@") or clean.endswith("@"):
            raise MailAccountError("email_address is invalid")
        return clean

    @staticmethod
    def _password(value: Any, *, required: bool) -> str:
        password = str(value or "")
        if required and not password:
            raise MailAccountError("password is required")
        if len(password) > 4_096 or "\x00" in password:
            raise MailAccountError("password is invalid")
        return password

    def _validated_create(self, body: dict[str, Any]) -> dict[str, Any]:
        allowed = {
            "label", "email_address", "username", "imap_host", "imap_port",
            "imap_security", "smtp_host", "smtp_port", "smtp_security",
            "enabled", "wake_enabled", "wake_folder", "poll_interval_seconds",
            "password",
        }
        unknown = sorted(set(body) - allowed)
        if unknown:
            raise MailAccountError("unknown mail account fields: " + ", ".join(unknown))
        return {
            "label": _text(body.get("label"), field="label", maximum=120),
            "email_address": self._email(body.get("email_address")),
            "username": _text(body.get("username"), field="username", maximum=320),
            "imap_host": _host(body.get("imap_host"), field="imap_host"),
            "imap_port": _port(body.get("imap_port"), field="imap_port"),
            "imap_security": _security(body.get("imap_security"), field="imap_security"),
            "smtp_host": _host(body.get("smtp_host"), field="smtp_host"),
            "smtp_port": _port(body.get("smtp_port"), field="smtp_port"),
            "smtp_security": _security(body.get("smtp_security"), field="smtp_security"),
            "enabled": _boolean(body.get("enabled", True), field="enabled"),
            "wake_enabled": _boolean(body.get("wake_enabled", False), field="wake_enabled"),
            "wake_folder": self._folder(body.get("wake_folder", "INBOX")),
            "poll_interval_seconds": _poll_interval(body.get("poll_interval_seconds", 300)),
        }
