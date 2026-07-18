from __future__ import annotations

import hashlib
import re
import unicodedata
from typing import Iterable


MAX_MEMORY_CONTENT_LENGTH = 4_000
MAX_MEMORY_CANDIDATE_LENGTH = 2_000
MEMORY_QUOTAS: dict[str, tuple[int, int]] = {
    # (maximum rows, maximum characters) per exact scope/target/owner.
    "memory": (200, 100_000),
    "user": (20, 8_000),
}

_INJECTION_PATTERNS = (
    re.compile(
        r"\b(?:ignore|disregard|forget|override|bypass)\b.{0,80}"
        r"\b(?:previous|prior|system|developer|instruction|prompt|policy|rules?)\b",
        re.IGNORECASE | re.DOTALL,
    ),
    re.compile(
        r"\b(?:reveal|show|print|leak|repeat)\b.{0,60}"
        r"\b(?:system|developer)\s+(?:prompt|message|instruction)",
        re.IGNORECASE | re.DOTALL,
    ),
    re.compile(r"\byou\s+are\s+now\b", re.IGNORECASE),
    re.compile(
        r"(?:忽略|无视|無視|忘记|忘記|覆盖|覆蓋|绕过|繞過).{0,40}"
        r"(?:之前|此前|系统|系統|开发者|開發者|指令|提示词|提示詞|规则|規則)",
        re.DOTALL,
    ),
    re.compile(
        r"(?:显示|顯示|打印|列印|泄露|洩露|复述|復述).{0,30}"
        r"(?:系统|系統|开发者|開發者)(?:提示词|提示詞|消息|訊息|指令)",
        re.DOTALL,
    ),
    re.compile(r"(?:从|從)(?:现在|現在)起.{0,12}(?:你是|扮演)", re.DOTALL),
)

_ROLE_MARKER = re.compile(
    r"(?:^|\n)\s*(?:system|developer|assistant)\s*(?:prompt|message)?\s*:",
    re.IGNORECASE,
)
_RESERVED_TAG = re.compile(
    r"</?(?:system|developer|assistant|memory-context|recalled-memory|recalled_memory)\b",
    re.IGNORECASE,
)


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

    value = unicodedata.normalize("NFKC", str(content or ""))
    reasons: list[str] = []
    if _RESERVED_TAG.search(value):
        reasons.append("reserved_prompt_tag")
    if _ROLE_MARKER.search(value):
        reasons.append("role_boundary")
    if any(pattern.search(value) for pattern in _INJECTION_PATTERNS):
        reasons.append("instruction_override")
    if any(
        unicodedata.category(char) == "Cf"
        and char not in {"\u200c", "\u200d"}
        for char in value
    ):
        reasons.append("invisible_control")
    return reasons


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
