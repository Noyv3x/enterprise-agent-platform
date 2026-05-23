from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from .db import Database, now_ts


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

    def add_document(
        self,
        *,
        title: str,
        content: str,
        summary: str = "",
        source: str = "",
        created_by: int | None = None,
    ) -> dict[str, Any]:
        title = title.strip()
        content = content.strip()
        if not title:
            raise ValueError("title is required")
        if not content:
            raise ValueError("content is required")
        if not summary:
            summary = summarize_content(content)
        ts = now_ts()
        doc_id = self.db.insert(
            """
            INSERT INTO knowledge_documents(title, summary, content, source, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (title, summary.strip(), content, source.strip(), created_by, ts, ts),
        )
        return self.get_document(doc_id) or {}

    def get_document(self, document_id: int) -> dict[str, Any] | None:
        return self.db.query_one(
            """
            SELECT id, title, summary, content, source, created_by, created_at, updated_at
            FROM knowledge_documents WHERE id = ?
            """,
            (document_id,),
        )

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
        pattern = f"%{query}%"
        rows = self.db.query(
            """
            SELECT id, title, summary, source
            FROM knowledge_documents
            WHERE title LIKE ? OR summary LIKE ? OR content LIKE ?
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
