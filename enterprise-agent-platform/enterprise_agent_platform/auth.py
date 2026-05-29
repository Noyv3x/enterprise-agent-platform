from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from dataclasses import dataclass
from typing import Any


PBKDF2_ITERATIONS = 260_000


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode((data + padding).encode("ascii"))


def hash_password(password: str, *, salt: bytes | None = None) -> str:
    if not password:
        raise ValueError("password must not be empty")
    salt = salt or os.urandom(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        PBKDF2_ITERATIONS,
    )
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${_b64url(salt)}${_b64url(digest)}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        scheme, iterations_s, salt_s, digest_s = encoded.split("$", 3)
        if scheme != "pbkdf2_sha256":
            return False
        iterations = int(iterations_s)
        salt = _b64url_decode(salt_s)
        expected = _b64url_decode(digest_s)
    except Exception:
        return False
    actual = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        iterations,
    )
    return hmac.compare_digest(actual, expected)


@dataclass(frozen=True)
class TokenPayload:
    user_id: int
    expires_at: int
    nonce: str
    version: int = 1

    def to_dict(self) -> dict[str, Any]:
        return {"uid": self.user_id, "exp": self.expires_at, "nonce": self.nonce, "ver": self.version}


class TokenSigner:
    def __init__(self, secret: str, ttl_seconds: int = 8 * 60 * 60):
        if not secret:
            raise ValueError("token secret must not be empty")
        self._secret = secret.encode("utf-8")
        self._ttl_seconds = ttl_seconds

    def issue(self, user_id: int, version: int = 1) -> str:
        payload = TokenPayload(
            user_id=user_id,
            expires_at=int(time.time()) + self._ttl_seconds,
            nonce=secrets.token_urlsafe(12),
            version=int(version),
        )
        body = _b64url(json.dumps(payload.to_dict(), separators=(",", ":")).encode("utf-8"))
        sig = _b64url(hmac.new(self._secret, body.encode("ascii"), hashlib.sha256).digest())
        return f"{body}.{sig}"

    def verify(self, token: str) -> TokenPayload | None:
        try:
            body, sig = token.split(".", 1)
        except ValueError:
            return None
        expected = _b64url(hmac.new(self._secret, body.encode("ascii"), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, expected):
            return None
        try:
            data = json.loads(_b64url_decode(body).decode("utf-8"))
            payload = TokenPayload(
                user_id=int(data["uid"]),
                expires_at=int(data["exp"]),
                nonce=str(data["nonce"]),
                version=int(data.get("ver", 1)),
            )
        except Exception:
            return None
        if payload.expires_at < int(time.time()):
            return None
        return payload
