from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass
from typing import Any

from .db import Database, now_ts


def _resolve_max_content_chars() -> int:
    """Per-document content cap (characters).

    Defaults generously (~2M characters, well below the 5MB request-body cap)
    so legitimate long enterprise documents are accepted while a handful of
    pathologically large docs cannot bloat the FTS index or Cognee ingestion.
    A value <= 0 disables the limit.
    """
    raw = os.getenv("ENTERPRISE_KB_MAX_CONTENT_CHARS", "").strip()
    if not raw:
        return 2_000_000
    try:
        return int(raw)
    except ValueError:
        return 2_000_000


MAX_CONTENT_CHARS = _resolve_max_content_chars()


@dataclass(frozen=True)
class KnowledgeHit:
    id: int
    title: str
    summary: str
    source: str
    score: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "summary": self.summary,
            "source": self.source,
            "score": self.score,
        }


class KnowledgeBase:
    def __init__(self, db: Database):
        self.db = db
        self._ensure_content_hash_schema()

    @staticmethod
    def _content_hash(title: str, content: str, source: str) -> str:
        payload = "\x00".join((title, content, source)).encode("utf-8")
        return hashlib.sha256(payload).hexdigest()

    def _ensure_content_hash_schema(self) -> None:
        """Add/backfill the concurrent-safe document idempotency key."""

        with self.db.transaction() as conn:
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(knowledge_documents)").fetchall()}
            if "content_hash" not in columns:
                conn.execute("ALTER TABLE knowledge_documents ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''")
            rows = conn.execute(
                "SELECT id, title, content, source, content_hash FROM knowledge_documents ORDER BY id"
            ).fetchall()
            seen: dict[str, tuple[int, str, str, str]] = {}
            for row in rows:
                digest = self._content_hash(str(row["title"]), str(row["content"]), str(row["source"] or ""))
                prior = seen.get(digest)
                current = (int(row["id"]), str(row["title"]), str(row["content"]), str(row["source"] or ""))
                if prior is not None:
                    # Preserve every historical row (including exact duplicates)
                    # because document ids may have been copied into audit logs
                    # or external Cognee metadata. The oldest row retains the
                    # canonical digest used for future idempotent inserts; later
                    # rows receive stable id-qualified migration digests.
                    digest = hashlib.sha256(f"{digest}:{current[0]}".encode("ascii")).hexdigest()
                seen[digest] = current
                if str(row["content_hash"] or "") != digest:
                    conn.execute(
                        "UPDATE knowledge_documents SET content_hash = ? WHERE id = ?",
                        (digest, current[0]),
                    )
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_documents_content_hash "
                "ON knowledge_documents(content_hash) WHERE content_hash != ''"
            )

    def add_document(
        self,
        *,
        title: str,
        content: str,
        summary: str = "",
        source: str = "",
        created_by: int | None = None,
    ) -> dict[str, Any]:
        doc, _created = self.add_document_with_status(
            title=title, content=content, summary=summary, source=source, created_by=created_by
        )
        return doc

    def add_document_with_status(
        self,
        *,
        title: str,
        content: str,
        summary: str = "",
        source: str = "",
        created_by: int | None = None,
    ) -> tuple[dict[str, Any], bool]:
        """Like ``add_document`` but also reports whether a NEW row was created.

        ``created`` is False on a dedup hit (an identical document already
        existed), letting callers skip re-queuing Cognee ingestion for a no-op
        re-submit so duplicates do not re-flood the graph backend.
        """
        title = title.strip()
        content = content.strip()
        source = source.strip()
        if not title:
            raise ValueError("title is required")
        if not content:
            raise ValueError("content is required")
        if MAX_CONTENT_CHARS > 0 and len(content) > MAX_CONTENT_CHARS:
            raise ValueError(f"content exceeds {MAX_CONTENT_CHARS} characters")
        if not summary:
            summary = summarize_content(content)
        ts = now_ts()
        content_hash = self._content_hash(title, content, source)
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                INSERT INTO knowledge_documents(
                    title, summary, content, source, created_by, created_at, updated_at, content_hash
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(content_hash) WHERE content_hash != '' DO NOTHING
                """,
                (title, summary.strip(), content, source, created_by, ts, ts, content_hash),
            )
            row = conn.execute(
                "SELECT id FROM knowledge_documents WHERE content_hash = ?",
                (content_hash,),
            ).fetchone()
        if row is None:
            raise RuntimeError("knowledge document insert did not produce a row")
        doc_id = int(row["id"])
        return (self.get_document(doc_id) or {}, cursor.rowcount > 0)

    def get_document(self, document_id: int) -> dict[str, Any] | None:
        return self.db.query_one(
            """
            SELECT id, title, summary, content, source, created_by, created_at, updated_at
            FROM knowledge_documents WHERE id = ?
            """,
            (document_id,),
        )

    def delete_document(self, document_id: int) -> bool:
        """Remove a document. Returns True when a row was deleted.

        The knowledge_fts DELETE trigger keeps the FTS index in sync
        automatically. Callers that mirror to an external backend (e.g. Cognee)
        are responsible for signalling that backend separately.
        """
        cur = self.db.execute(
            "DELETE FROM knowledge_documents WHERE id = ?",
            (document_id,),
        )
        return cur.rowcount > 0

    def list_documents(self, limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
        return self.db.query(
            """
            SELECT id, title, summary, source, created_by, created_at, updated_at
            FROM knowledge_documents
            ORDER BY updated_at DESC, id DESC
            LIMIT ? OFFSET ?
            """,
            (limit, offset),
        )

    def search(self, query: str, limit: int = 5) -> list[KnowledgeHit]:
        query = query.strip()
        if not query:
            return []
        limit = max(1, min(int(limit), 20))
        fts_query = make_fts_query(query)
        if fts_query:
            try:
                rows = self.db.query(
                    """
                    SELECT d.id, d.title, d.summary, d.source, bm25(knowledge_fts) AS rank
                    FROM knowledge_fts
                    JOIN knowledge_documents d ON d.id = knowledge_fts.rowid
                    WHERE knowledge_fts MATCH ?
                    ORDER BY rank
                    LIMIT ?
                    """,
                    (fts_query, limit),
                )
                return [
                    KnowledgeHit(
                        id=int(row["id"]),
                        title=row["title"],
                        summary=row["summary"],
                        source=row["source"],
                        score=float(row["rank"] or 0.0),
                    )
                    for row in rows
                ]
            except Exception:
                pass
        # Escape LIKE metacharacters so user-supplied % and _ are matched
        # literally on this fallback path. The backslash must be escaped first
        # so the ESCAPE char it introduces stays literal.
        safe = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{safe}%"
        rows = self.db.query(
            r"""
            SELECT id, title, summary, source
            FROM knowledge_documents
            WHERE title LIKE ? ESCAPE '\' OR summary LIKE ? ESCAPE '\' OR content LIKE ? ESCAPE '\'
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (pattern, pattern, pattern, limit),
        )
        return [
            KnowledgeHit(
                id=int(row["id"]),
                title=row["title"],
                summary=row["summary"],
                source=row["source"],
                score=0.0,
            )
            for row in rows
        ]

    def suggest(self, context: str, limit: int = 3) -> list[KnowledgeHit]:
        terms = extract_terms(context)
        if not terms:
            return []
        query = " ".join(terms[:8])
        return self.search(query, limit=limit)


def summarize_content(content: str, max_len: int = 220) -> str:
    compact = re.sub(r"\s+", " ", content).strip()
    if len(compact) <= max_len:
        return compact
    return compact[: max_len - 1].rstrip() + "..."


def extract_terms(text: str) -> list[str]:
    candidates = re.findall(r"[\w\u4e00-\u9fff]{2,}", text.lower(), flags=re.UNICODE)
    stop = {
        "the",
        "and",
        "for",
        "with",
        "that",
        "this",
        "from",
        "are",
        "you",
        "我",
        "你",
        "我们",
        "这个",
        "一个",
        "可以",
        "需要",
    }
    seen: set[str] = set()
    result: list[str] = []
    for term in candidates:
        if term in stop or term in seen:
            continue
        seen.add(term)
        result.append(term)
    return result


def make_fts_query(text: str) -> str:
    terms = extract_terms(text)
    safe: list[str] = []
    for term in terms[:12]:
        cleaned = re.sub(r"[^\w\u4e00-\u9fff]", "", term, flags=re.UNICODE)
        if cleaned:
            safe.append(f"{cleaned}*")
    return " OR ".join(safe)


def format_passive_suggestions(hits: list[KnowledgeHit]) -> str:
    if not hits:
        return ""
    lines = [
        '检测到企业知识库中的以下条目可能对当前工作有帮助。若需要完整内容，请调用工具 enterprise_kb_read；若需要更多条目，请调用 enterprise_kb_search。'
    ]
    for hit in hits:
        lines.append(f"- kb:{hit.id} | {hit.title}: {hit.summary}")
    return "\n".join(lines)
