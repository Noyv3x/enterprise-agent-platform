from __future__ import annotations

import hashlib
import unicodedata
from typing import Iterable

from .prompt_security import prompt_threat_reasons


MAX_MEMORY_CONTENT_LENGTH = 4_000
MAX_MEMORY_CANDIDATE_LENGTH = 2_000
MEMORY_QUOTAS: dict[str, tuple[int, int]] = {
    # (maximum rows, maximum characters) per exact scope/target/owner.
    "memory": (200, 100_000),
    "user": (20, 8_000),
}

def normalize_memory_content(content: str) -> str:
    """Return the stable representation used for deduplication."""

    normalized = unicodedata.normalize("NFKC", str(content or ""))
    return " ".join(normalized.split()).strip().casefold()


def memory_content_hash(content: str) -> str:
    return hashlib.sha256(normalize_memory_content(content).encode("utf-8")).hexdigest()


def memory_dedupe_key(
    scope_key: str,
    target: str,
    owner_user_id: int | None,
    content: str,
) -> str:
    material = "\x1f".join(
        (
            str(scope_key),
            str(target),
            str(owner_user_id or 0),
            memory_content_hash(content),
        )
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def memory_injection_reasons(content: str) -> list[str]:
    """Identify content that could turn recalled data into model instructions.

    This deliberately targets explicit prompt-boundary and instruction-override
    language. Ordinary preferences and facts should remain valid memories.
    """

    return prompt_threat_reasons(content)


def validate_memory_content(
    content: str, *, max_length: int = MAX_MEMORY_CONTENT_LENGTH
) -> tuple[str, str]:
    value = str(content or "").strip()
    if not value or len(value) > max_length:
        raise ValueError(
            f"memory content must contain 1 to {max_length} characters"
        )
    if memory_injection_reasons(value):
        raise ValueError("memory content resembles prompt-injection instructions")
    return value, memory_content_hash(value)


def normalize_memory_tags(tags: Iterable[object] | None) -> list[str]:
    if tags is None:
        return []
    result: list[str] = []
    seen: set[str] = set()
    for raw in tags:
        tag = " ".join(str(raw).split()).strip()[:80]
        key = tag.casefold()
        if not tag or key in seen:
            continue
        seen.add(key)
        result.append(tag)
        if len(result) >= 20:
            break
    return result
