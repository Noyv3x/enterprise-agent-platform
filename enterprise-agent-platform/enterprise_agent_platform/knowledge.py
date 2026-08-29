from __future__ import annotations

import hashlib
import ipaddress
import json
import math
import os
import re
import struct
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, replace
from typing import Any, Callable, Protocol, Sequence

from .db import Database, encode_json, now_ts
from .knowledge_files import (
    MAX_KNOWLEDGE_FILE_BYTES,
    MAX_KNOWLEDGE_FILES_PER_IMPORT,
    MAX_KNOWLEDGE_IMPORT_BYTES,
    ExtractedKnowledgeFile,
)


CHUNKER_VERSION = "markdown-structure-v1"
CHUNK_TARGET_CHARS = 1_200
CHUNK_OVERLAP_CHARS = 160
DEFAULT_EMBEDDING_BATCH_SIZE = 32
MAX_EMBEDDING_BATCH_SIZE = 256
MAX_EMBEDDING_DIMENSIONS = 65_536
MAX_EMBEDDING_RESPONSE_BYTES = 16 * 1024 * 1024
DEFAULT_EMBEDDING_TIMEOUT_SECONDS = 30.0
KNOWLEDGE_INDEX_JOB_KIND = "knowledge_index"

SETTING_EMBEDDING_BASE_URL = "knowledge_embedding_base_url"
SETTING_EMBEDDING_MODEL = "knowledge_embedding_model"
SETTING_EMBEDDING_DIMENSIONS = "knowledge_embedding_dimensions"
SETTING_EMBEDDING_BATCH_SIZE = "knowledge_embedding_batch_size"
SETTING_EMBEDDING_API_KEY = "KNOWLEDGE_EMBEDDING_API_KEY"


def _resolve_max_content_chars() -> int:
    raw = os.getenv("AGENT_PLATFORM_KB_MAX_CONTENT_CHARS", "").strip()
    if not raw:
        return 2_000_000
    try:
        return int(raw)
    except ValueError:
        return 2_000_000


MAX_CONTENT_CHARS = _resolve_max_content_chars()


class KnowledgeError(RuntimeError):
    """Base class for diagnosable knowledge capability failures."""


class KnowledgeDisabledError(KnowledgeError):
    pass


class KnowledgeUnavailableError(KnowledgeError):
    pass


class EmbeddingProviderError(KnowledgeError):
    def __init__(
        self,
        message: str,
        *,
        retryable: bool,
        status_code: int | None = None,
    ):
        super().__init__(message)
        self.retryable = bool(retryable)
        self.status_code = status_code


class EmbeddingResponseError(EmbeddingProviderError):
    def __init__(self, message: str):
        super().__init__(message, retryable=False)


class EmbeddingClient(Protocol):
    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        ...


EmbeddingTransport = Callable[
    [str, dict[str, str], bytes, float, int],
    tuple[int, str, bytes],
]


@dataclass(frozen=True)
class KnowledgeEmbeddingConfig:
    base_url: str = ""
    model: str = ""
    api_key: str = ""
    dimensions: int | None = None
    batch_size: int = DEFAULT_EMBEDDING_BATCH_SIZE

    @property
    def credential_configured(self) -> bool:
        return bool(self.api_key.strip())

    def validated(self, *, require_enabled: bool = False) -> KnowledgeEmbeddingConfig:
        base_url = self.base_url.strip().rstrip("/")
        model = self.model.strip()
        api_key = self.api_key.strip()
        if require_enabled or api_key or base_url or model:
            base_url = _validate_embedding_base_url(base_url)
            if not model:
                raise ValueError("knowledge embedding model is required")
            if len(model) > 200 or any(ord(char) < 32 for char in model):
                raise ValueError("knowledge embedding model is invalid")
        if require_enabled and not api_key:
            raise ValueError("knowledge embedding API key is required")
        if len(api_key) > 8_192:
            raise ValueError("knowledge embedding API key is too long")
        dimensions = self.dimensions
        if dimensions is not None:
            if isinstance(dimensions, bool) or not 1 <= int(dimensions) <= MAX_EMBEDDING_DIMENSIONS:
                raise ValueError(
                    f"knowledge embedding dimensions must be 1-{MAX_EMBEDDING_DIMENSIONS}"
                )
            dimensions = int(dimensions)
        batch_size = self.batch_size
        if isinstance(batch_size, bool) or not 1 <= int(batch_size) <= MAX_EMBEDDING_BATCH_SIZE:
            raise ValueError(
                f"knowledge embedding batch size must be 1-{MAX_EMBEDDING_BATCH_SIZE}"
            )
        return KnowledgeEmbeddingConfig(
            base_url=base_url,
            model=model,
            api_key=api_key,
            dimensions=dimensions,
            batch_size=int(batch_size),
        )

    def public_dict(self) -> dict[str, Any]:
        return {
            "base_url": self.base_url,
            "model": self.model,
            "dimensions": self.dimensions,
            "batch_size": self.batch_size,
            "credential_configured": self.credential_configured,
        }

    def identity_hash(self) -> str:
        payload = encode_json({
            "base_url": self.base_url,
            "model": self.model,
            "dimensions": self.dimensions,
            "batch_size": self.batch_size,
            "chunker_version": CHUNKER_VERSION,
            "chunk_target_chars": CHUNK_TARGET_CHARS,
            "chunk_overlap_chars": CHUNK_OVERLAP_CHARS,
        }).encode("utf-8")
        return hashlib.sha256(payload).hexdigest()


def _validate_embedding_base_url(value: str) -> str:
    if not value:
        raise ValueError("knowledge embedding base URL is required")
    if len(value) > 2_048:
        raise ValueError("knowledge embedding base URL is too long")
    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise ValueError("knowledge embedding base URL is invalid") from exc
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("knowledge embedding base URL must use HTTPS")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("knowledge embedding base URL must not contain credentials")
    if parsed.query or parsed.fragment:
        raise ValueError("knowledge embedding base URL must not contain query or fragment")
    if port is not None and not 1 <= port <= 65_535:
        raise ValueError("knowledge embedding base URL port is invalid")
    if parsed.scheme == "http":
        try:
            address = ipaddress.ip_address(parsed.hostname)
        except ValueError as exc:
            raise ValueError(
                "HTTP knowledge embedding base URL requires a numeric loopback host"
            ) from exc
        if not address.is_loopback:
            raise ValueError(
                "HTTP knowledge embedding base URL requires a numeric loopback host"
            )
    return urllib.parse.urlunsplit(
        (parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", "")
    )


class _RejectRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        raise urllib.error.HTTPError(
            req.full_url,
            code,
            "knowledge embedding redirects are not allowed",
            headers,
            fp,
        )


def _default_embedding_transport(
    url: str,
    headers: dict[str, str],
    body: bytes,
    timeout_seconds: float,
    max_response_bytes: int,
) -> tuple[int, str, bytes]:
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    opener = urllib.request.build_opener(_RejectRedirects())
    try:
        with opener.open(request, timeout=timeout_seconds) as response:
            payload = response.read(max_response_bytes + 1)
            if len(payload) > max_response_bytes:
                raise EmbeddingResponseError(
                    "knowledge embedding response exceeds the size limit"
                )
            return (
                int(response.status),
                str(response.headers.get("Content-Type") or ""),
                payload,
            )
    except urllib.error.HTTPError as exc:
        retryable = exc.code == 429 or 500 <= exc.code <= 599
        raise EmbeddingProviderError(
            f"knowledge embedding provider returned HTTP {exc.code}",
            retryable=retryable,
            status_code=int(exc.code),
        ) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise EmbeddingProviderError(
            "knowledge embedding provider is unreachable",
            retryable=True,
        ) from exc


class OpenAIEmbeddingClient:
    def __init__(
        self,
        config: KnowledgeEmbeddingConfig,
        *,
        transport: EmbeddingTransport | None = None,
        timeout_seconds: float = DEFAULT_EMBEDDING_TIMEOUT_SECONDS,
        max_response_bytes: int = MAX_EMBEDDING_RESPONSE_BYTES,
    ):
        self.config = config.validated(require_enabled=True)
        self._transport = transport or _default_embedding_transport
        self._timeout_seconds = max(1.0, min(float(timeout_seconds), 120.0))
        self._max_response_bytes = max(1_024, min(int(max_response_bytes), 64 * 1024 * 1024))

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        values = [str(text) for text in texts]
        if not values:
            return []
        if len(values) > MAX_EMBEDDING_BATCH_SIZE:
            raise ValueError("knowledge embedding batch exceeds the supported maximum")
        request_body: dict[str, Any] = {
            "model": self.config.model,
            "input": values,
        }
        if self.config.dimensions is not None:
            request_body["dimensions"] = self.config.dimensions
        endpoint = self.config.base_url
        if not endpoint.endswith("/embeddings"):
            endpoint += "/embeddings"
        status, content_type, body = self._transport(
            endpoint,
            {
                "Authorization": f"Bearer {self.config.api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            json.dumps(request_body, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            self._timeout_seconds,
            self._max_response_bytes,
        )
        if status < 200 or status >= 300:
            raise EmbeddingProviderError(
                f"knowledge embedding provider returned HTTP {status}",
                retryable=status == 429 or 500 <= status <= 599,
                status_code=status,
            )
        if content_type.split(";", 1)[0].strip().casefold() != "application/json":
            raise EmbeddingResponseError(
                "knowledge embedding provider returned a non-JSON response"
            )
        try:
            payload = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise EmbeddingResponseError(
                "knowledge embedding provider returned invalid JSON"
            ) from exc
        if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
            raise EmbeddingResponseError(
                "knowledge embedding provider response is missing data"
            )
        rows = payload["data"]
        if len(rows) != len(values):
            raise EmbeddingResponseError(
                "knowledge embedding provider returned an unexpected vector count"
            )
        vectors: list[list[float]] = []
        for expected_index, row in enumerate(rows):
            if not isinstance(row, dict) or row.get("index") != expected_index:
                raise EmbeddingResponseError(
                    "knowledge embedding provider returned vectors out of order"
                )
            vector = row.get("embedding")
            if not isinstance(vector, list):
                raise EmbeddingResponseError(
                    "knowledge embedding provider returned an invalid vector"
                )
            vectors.append(vector)
        return _validated_vectors(
            vectors,
            expected_count=len(values),
            expected_dimensions=self.config.dimensions,
        )


@dataclass(frozen=True)
class KnowledgeChunk:
    chunk_id: str
    document_id: int
    chunk_index: int
    title_path: str
    content: str
    char_start: int
    char_end: int
    chunk_hash: str


@dataclass(frozen=True)
class KnowledgeHit:
    document_id: int
    chunk_id: str
    title: str
    summary: str
    source: str
    content: str
    title_path: str
    char_start: int
    char_end: int
    score: float

    @property
    def id(self) -> int:
        return self.document_id

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.document_id,
            "document_id": self.document_id,
            "chunk_id": self.chunk_id,
            "title": self.title,
            "summary": self.summary,
            "source": self.source,
            "excerpt": self.content,
            "title_path": self.title_path,
            "char_start": self.char_start,
            "char_end": self.char_end,
            "score": self.score,
        }


class KnowledgeBase:
    def __init__(
        self,
        db: Database,
        config: KnowledgeEmbeddingConfig | None = None,
        embedding_client: EmbeddingClient | None = None,
    ):
        self.db = db
        self._injected_client = embedding_client
        self._configuration_error = ""
        try:
            if config is None and embedding_client is not None:
                config = KnowledgeEmbeddingConfig(
                    base_url="https://injected.invalid/v1",
                    model="injected-test",
                    api_key="injected",
                )
            self._config = config or self._load_configuration()
            self._config = self._config.validated(
                require_enabled=self._config.credential_configured
            )
        except ValueError as exc:
            self._configuration_error = str(exc)
            self._config = KnowledgeEmbeddingConfig()
        self._client = self._make_client(self._config)

    def _load_configuration(self) -> KnowledgeEmbeddingConfig:
        rows = {
            str(row["key"]): row
            for row in self.db.query(
                "SELECT key, value, secret FROM settings WHERE key IN (?, ?, ?, ?, ?)",
                (
                    SETTING_EMBEDDING_BASE_URL,
                    SETTING_EMBEDDING_MODEL,
                    SETTING_EMBEDDING_DIMENSIONS,
                    SETTING_EMBEDDING_BATCH_SIZE,
                    SETTING_EMBEDDING_API_KEY,
                ),
            )
        }
        dimensions_value = str(rows.get(SETTING_EMBEDDING_DIMENSIONS, {}).get("value") or "").strip()
        batch_value = str(rows.get(SETTING_EMBEDDING_BATCH_SIZE, {}).get("value") or "").strip()
        try:
            dimensions = int(dimensions_value) if dimensions_value else None
            batch_size = int(batch_value) if batch_value else DEFAULT_EMBEDDING_BATCH_SIZE
        except ValueError as exc:
            raise ValueError("stored knowledge embedding numeric configuration is invalid") from exc
        secret_row = rows.get(SETTING_EMBEDDING_API_KEY, {})
        api_key = (
            str(secret_row.get("value") or "")
            if int(secret_row.get("secret") or 0) == 1
            else ""
        )
        return KnowledgeEmbeddingConfig(
            base_url=str(rows.get(SETTING_EMBEDDING_BASE_URL, {}).get("value") or ""),
            model=str(rows.get(SETTING_EMBEDDING_MODEL, {}).get("value") or ""),
            api_key=api_key,
            dimensions=dimensions,
            batch_size=batch_size,
        )

    def _make_client(self, config: KnowledgeEmbeddingConfig) -> EmbeddingClient | None:
        if not config.credential_configured:
            return None
        if self._injected_client is not None:
            return self._injected_client
        return OpenAIEmbeddingClient(config)

    def configuration(self) -> KnowledgeEmbeddingConfig:
        return self._config

    def configuration_public(self) -> dict[str, Any]:
        payload = self._config.public_dict()
        payload["error"] = self._configuration_error
        return payload

    def status(self) -> dict[str, Any]:
        document_count = int(self.db.scalar("SELECT count(*) FROM knowledge_documents") or 0)
        active = self.db.query_one(
            "SELECT id, embedding_model, embedding_dimensions, document_count, "
            "ready_document_count, updated_at FROM knowledge_index_generations "
            "WHERE status = 'active' ORDER BY id DESC LIMIT 1"
        )
        building = self.db.query_one(
            "SELECT id, document_count, ready_document_count, last_error, updated_at "
            "FROM knowledge_index_generations WHERE status = 'building' "
            "ORDER BY id DESC LIMIT 1"
        )
        indexed_documents = int(active.get("ready_document_count") or 0) if active else 0
        building_counts = {
            str(row["status"]): int(row["count"])
            for row in self.db.query(
                "SELECT status, count(*) AS count FROM knowledge_document_index "
                "WHERE generation_id = ? GROUP BY status",
                (int(building["id"]) if building else -1,),
            )
        }
        pending_documents = building_counts.get("pending", 0)
        failed_documents = building_counts.get("failed", 0)
        if self._configuration_error:
            state = "degraded"
            last_error = self._configuration_error
        elif not self._config.credential_configured:
            state = "disabled"
            last_error = "knowledge embedding API key is not configured"
        elif building and pending_documents > 0:
            state = "indexing"
            last_error = str(building.get("last_error") or "")
        elif building:
            state = "degraded"
            last_error = str(
                building.get("last_error")
                or "knowledge generation cannot become active"
            )
        elif active:
            state = "ready"
            last_error = ""
        else:
            state = "degraded"
            last_error = "knowledge index has no active generation"
        return {
            "state": state,
            "available": active is not None,
            "active_generation_id": int(active["id"]) if active else None,
            "indexed_documents": indexed_documents,
            "total_documents": document_count,
            "pending_documents": pending_documents,
            "failed_documents": failed_documents,
            "model": str(
                (active or {}).get("embedding_model") or self._config.model
            ),
            "last_error": last_error,
        }

    def _require_enabled(self) -> EmbeddingClient:
        if self._configuration_error:
            raise KnowledgeDisabledError(
                f"knowledge configuration is invalid: {self._configuration_error}"
            )
        if not self._config.credential_configured or self._client is None:
            raise KnowledgeDisabledError(
                "knowledge embedding API key is not configured; knowledge is disabled"
            )
        return self._client

    def ensure_enabled(self) -> None:
        self._require_enabled()

    def probe_configuration(
        self,
        config: KnowledgeEmbeddingConfig,
        embedding_client: EmbeddingClient | None = None,
    ) -> int:
        checked = config.validated(require_enabled=True)
        client = embedding_client or (
            self._injected_client if self._injected_client is not None else OpenAIEmbeddingClient(checked)
        )
        vectors = _validated_vectors(
            client.embed(["knowledge embedding configuration probe"]),
            expected_count=1,
            expected_dimensions=checked.dimensions,
        )
        return len(vectors[0])

    def save_configuration(
        self,
        config: KnowledgeEmbeddingConfig,
        embedding_client: EmbeddingClient | None = None,
    ) -> dict[str, Any]:
        checked = config.validated(require_enabled=True)
        resolved_client = embedding_client or (
            self._injected_client if self._injected_client is not None else OpenAIEmbeddingClient(checked)
        )
        probed_dimensions = self.probe_configuration(checked, resolved_client)
        if checked.dimensions is None:
            checked = replace(checked, dimensions=probed_dimensions)
        old_config, old_client = self._config, self._client
        old_injected_client = self._injected_client
        if embedding_client is not None:
            self._injected_client = embedding_client
        self._config, self._client = checked, resolved_client
        timestamp = now_ts()
        try:
            with self.db.transaction(immediate=True) as conn:
                values = (
                    (SETTING_EMBEDDING_BASE_URL, checked.base_url, 0),
                    (SETTING_EMBEDDING_MODEL, checked.model, 0),
                    (
                        SETTING_EMBEDDING_DIMENSIONS,
                        "" if checked.dimensions is None else str(checked.dimensions),
                        0,
                    ),
                    (SETTING_EMBEDDING_BATCH_SIZE, str(checked.batch_size), 0),
                    (SETTING_EMBEDDING_API_KEY, checked.api_key, 1),
                )
                conn.executemany(
                    "INSERT INTO settings(key, value, secret, updated_at) "
                    "VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET "
                    "value=excluded.value, secret=excluded.secret, "
                    "updated_at=excluded.updated_at",
                    ((key, value, secret, timestamp) for key, value, secret in values),
                )
                generation = self._prepare_generation_in_transaction(conn, force=False)
        except BaseException:
            self._config, self._client = old_config, old_client
            self._injected_client = old_injected_client
            raise
        self._configuration_error = ""
        return {"config": self.configuration_public(), "generation": generation}

    @staticmethod
    def _content_hash(
        title: str,
        content: str,
        source: str,
        identity_extra: str = "",
    ) -> str:
        identity = (title, content, source)
        if identity_extra:
            identity += (identity_extra,)
        payload = "\x00".join(identity).encode("utf-8")
        return hashlib.sha256(payload).hexdigest()

    def add_document_with_status(
        self,
        *,
        title: str,
        content: str,
        summary: str = "",
        source: str = "",
        created_by: int | None = None,
    ) -> tuple[dict[str, Any], bool]:
        self._require_enabled()
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
        timestamp = now_ts()
        content_hash = self._content_hash(title, content, source)
        with self.db.transaction(immediate=True) as conn:
            cursor = conn.execute(
                """
                INSERT INTO knowledge_documents(
                    title, summary, content, source, created_by, created_at,
                    updated_at, content_hash
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(content_hash) WHERE content_hash != '' DO NOTHING
                """,
                (
                    title,
                    summary.strip(),
                    content,
                    source,
                    created_by,
                    timestamp,
                    timestamp,
                    content_hash,
                ),
            )
            row = conn.execute(
                "SELECT id FROM knowledge_documents WHERE content_hash = ?",
                (content_hash,),
            ).fetchone()
            if row is None:
                raise RuntimeError("knowledge document insert did not produce a row")
            self._prepare_generation_in_transaction(conn, force=False)
            document_id = int(row["id"])
        return (self.get_document(document_id) or {}, cursor.rowcount > 0)

    def get_document(self, document_id: int) -> dict[str, Any] | None:
        return self.db.query_one(
            "SELECT d.id, d.title, d.summary, d.content, d.source, d.created_by, "
            "d.created_at, d.updated_at, d.content_hash, "
            "f.filename AS original_filename, f.media_type AS original_media_type, "
            "f.size_bytes AS original_size_bytes, f.sha256 AS original_sha256 "
            "FROM knowledge_documents d LEFT JOIN knowledge_document_files f "
            "ON f.document_id = d.id WHERE d.id = ?",
            (int(document_id),),
        )

    def import_files(
        self,
        files: Sequence[ExtractedKnowledgeFile],
        *,
        created_by: int | None,
    ) -> list[dict[str, Any]]:
        self._require_enabled()
        items = list(files)
        if not items:
            raise ValueError("at least one knowledge file is required")
        if len(items) > MAX_KNOWLEDGE_FILES_PER_IMPORT:
            raise ValueError(
                f"at most {MAX_KNOWLEDGE_FILES_PER_IMPORT} knowledge files are allowed"
            )
        if sum(item.size_bytes for item in items) > MAX_KNOWLEDGE_IMPORT_BYTES:
            raise ValueError("knowledge files exceed 100 MiB total")
        timestamp = now_ts()
        identities: list[tuple[int, bool]] = []
        with self.db.transaction(immediate=True) as conn:
            for item in items:
                title = item.title.strip()
                content = item.content.strip()
                if not title or not content:
                    raise ValueError("knowledge file title and content are required")
                if MAX_CONTENT_CHARS > 0 and len(content) > MAX_CONTENT_CHARS:
                    raise ValueError(
                        f"content exceeds {MAX_CONTENT_CHARS} characters"
                    )
                if (
                    item.size_bytes < 1
                    or item.size_bytes > MAX_KNOWLEDGE_FILE_BYTES
                    or len(item.data) != item.size_bytes
                    or hashlib.sha256(item.data).hexdigest() != item.sha256
                ):
                    raise ValueError("knowledge file integrity is invalid")
                source = item.filename
                content_hash = self._content_hash(
                    title,
                    content,
                    source,
                    item.sha256,
                )
                cursor = conn.execute(
                    "INSERT INTO knowledge_documents("
                    "title, summary, content, source, created_by, created_at, "
                    "updated_at, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(content_hash) WHERE content_hash != '' DO NOTHING",
                    (
                        title,
                        summarize_content(content),
                        content,
                        source,
                        created_by,
                        timestamp,
                        timestamp,
                        content_hash,
                    ),
                )
                row = conn.execute(
                    "SELECT id FROM knowledge_documents WHERE content_hash = ?",
                    (content_hash,),
                ).fetchone()
                if row is None:
                    raise RuntimeError("knowledge file insert did not produce a row")
                document_id = int(row["id"])
                created = cursor.rowcount > 0
                if created:
                    conn.execute(
                        "INSERT INTO knowledge_document_files("
                        "document_id, filename, media_type, size_bytes, sha256, "
                        "content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (
                            document_id,
                            item.filename,
                            item.media_type,
                            item.size_bytes,
                            item.sha256,
                            item.data,
                            timestamp,
                        ),
                    )
                identities.append((document_id, created))
            if any(created for _document_id, created in identities):
                self._prepare_generation_in_transaction(conn, force=False)
        results: list[dict[str, Any]] = []
        for document_id, created in identities:
            document = self.db.query_one(
                "SELECT d.id, d.title, d.summary, d.source, d.created_by, "
                "d.created_at, d.updated_at, d.content_hash, "
                "f.filename AS original_filename, "
                "f.media_type AS original_media_type, "
                "f.size_bytes AS original_size_bytes, "
                "f.sha256 AS original_sha256 "
                "FROM knowledge_documents d LEFT JOIN knowledge_document_files f "
                "ON f.document_id = d.id WHERE d.id = ?",
                (document_id,),
            )
            if document is None:
                raise RuntimeError("knowledge file disappeared after import")
            results.append({"document": document, "created": created})
        return results

    def download_document(self, document_id: int) -> dict[str, Any] | None:
        row = self.db.query_one(
            "SELECT d.title, d.summary, d.content AS document_content, d.source, "
            "f.filename, f.media_type, f.size_bytes, f.sha256, "
            "f.content AS file_content FROM knowledge_documents d "
            "LEFT JOIN knowledge_document_files f ON f.document_id = d.id "
            "WHERE d.id = ?",
            (int(document_id),),
        )
        if row is None:
            return None
        if row.get("file_content") is not None:
            content = bytes(row["file_content"])
            return {
                "filename": str(row["filename"]),
                "media_type": str(row["media_type"]),
                "size_bytes": int(row["size_bytes"]),
                "sha256": str(row["sha256"]),
                "content": content,
                "original": True,
            }
        title = str(row["title"]).strip() or "Knowledge document"
        sections = [f"# {title}"]
        source = str(row["source"] or "").strip()
        summary = str(row["summary"] or "").strip()
        if source:
            sections.append(f"Source: {source}")
        if summary:
            sections.append(summary)
        sections.append(str(row["document_content"]))
        content = "\n\n".join(sections).encode("utf-8")
        return {
            "filename": f"{title}.md",
            "media_type": "text/markdown; charset=utf-8",
            "size_bytes": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
            "content": content,
            "original": False,
        }

    def list_documents(self, limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
        return self.db.query(
            "SELECT d.id, d.title, d.summary, d.source, d.created_by, d.created_at, "
            "d.updated_at, d.content_hash, f.filename AS original_filename, "
            "f.media_type AS original_media_type, "
            "f.size_bytes AS original_size_bytes, f.sha256 AS original_sha256 "
            "FROM knowledge_documents d LEFT JOIN knowledge_document_files f "
            "ON f.document_id = d.id ORDER BY d.updated_at DESC, d.id DESC "
            "LIMIT ? OFFSET ?",
            (max(1, min(int(limit), 200)), max(0, int(offset))),
        )

    def prepare_generation(self, *, force: bool = False) -> int:
        self._require_enabled()
        with self.db.transaction(immediate=True) as conn:
            generation = self._prepare_generation_in_transaction(conn, force=force)
        return int(generation["id"])

    def _prepare_generation_in_transaction(
        self,
        conn,
        *,
        force: bool,
    ) -> dict[str, Any]:
        config_hash = self._config.identity_hash()
        if not force:
            building = conn.execute(
                "SELECT * FROM knowledge_index_generations "
                "WHERE status = 'building' AND config_hash = ? "
                "ORDER BY id DESC LIMIT 1",
                (config_hash,),
            ).fetchone()
            if building is not None:
                failed = int(conn.execute(
                    "SELECT count(*) FROM knowledge_document_index "
                    "WHERE generation_id = ? AND status = 'failed'",
                    (int(building["id"]),),
                ).fetchone()[0])
                if failed == 0:
                    self._synchronize_generation_documents(
                        conn, int(building["id"])
                    )
                    return dict(conn.execute(
                        "SELECT * FROM knowledge_index_generations WHERE id = ?",
                        (int(building["id"]),),
                    ).fetchone())
            active = conn.execute(
                "SELECT * FROM knowledge_index_generations "
                "WHERE status = 'active' AND config_hash = ? LIMIT 1",
                (config_hash,),
            ).fetchone()
            if active is not None and self._generation_covers_current_documents(
                conn, int(active["id"])
            ):
                return dict(active)
        timestamp = now_ts()
        conn.execute(
            "UPDATE knowledge_index_generations SET status = 'failed', "
            "last_error = 'superseded by a newer rebuild', updated_at = ? "
            "WHERE status = 'building'",
            (timestamp,),
        )
        document_count = int(
            conn.execute("SELECT count(*) FROM knowledge_documents").fetchone()[0]
        )
        status = "active" if document_count == 0 else "building"
        if status == "active":
            conn.execute(
                "UPDATE knowledge_index_generations SET status = 'superseded', "
                "updated_at = ? WHERE status = 'active'",
                (timestamp,),
            )
        cursor = conn.execute(
            "INSERT INTO knowledge_index_generations("
            "config_hash, embedding_base_url, embedding_model, "
            "embedding_dimensions, chunker_version, status, document_count, "
            "ready_document_count, created_at, updated_at, activated_at"
            ") VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
            (
                config_hash,
                self._config.base_url,
                self._config.model,
                self._config.dimensions,
                CHUNKER_VERSION,
                status,
                document_count,
                timestamp,
                timestamp,
                timestamp if status == "active" else None,
            ),
        )
        generation_id = int(cursor.lastrowid)
        if status != "active":
            self._synchronize_generation_documents(conn, generation_id)
        return dict(conn.execute(
            "SELECT * FROM knowledge_index_generations WHERE id = ?",
            (generation_id,),
        ).fetchone())

    def _synchronize_generation_documents(self, conn, generation_id: int) -> None:
        timestamp = now_ts()
        documents = conn.execute(
            "SELECT id, content_hash FROM knowledge_documents ORDER BY id"
        ).fetchall()
        for document in documents:
            document_id = int(document["id"])
            expected_hash = str(document["content_hash"])
            conn.execute(
                "INSERT INTO knowledge_document_index("
                "generation_id, document_id, expected_hash, status, created_at, updated_at"
                ") VALUES (?, ?, ?, 'pending', ?, ?) "
                "ON CONFLICT(generation_id, document_id) DO NOTHING",
                (generation_id, document_id, expected_hash, timestamp, timestamp),
            )
            payload = {
                "document_id": document_id,
                "expected_hash": expected_hash,
                "generation_id": generation_id,
            }
            conn.execute(
                "INSERT INTO durable_jobs("
                "kind, scope_type, scope_id, dedupe_key, payload_json, status, "
                "attempts, available_at, lease_until, last_error, created_at, updated_at"
                ") VALUES (?, 'knowledge', ?, ?, ?, 'queued', 0, 0, 0, '', ?, ?) "
                "ON CONFLICT(kind, dedupe_key) DO NOTHING",
                (
                    KNOWLEDGE_INDEX_JOB_KIND,
                    str(document_id),
                    f"generation:{generation_id}:document:{document_id}:{expected_hash}",
                    encode_json(payload),
                    timestamp,
                    timestamp,
                ),
            )
        conn.execute(
            "UPDATE knowledge_index_generations SET "
            "document_count = (SELECT count(*) FROM knowledge_document_index "
            "WHERE generation_id = ?), "
            "ready_document_count = (SELECT count(*) FROM knowledge_document_index "
            "WHERE generation_id = ? AND status = 'ready'), updated_at = ? "
            "WHERE id = ?",
            (generation_id, generation_id, timestamp, generation_id),
        )

    def index_document(self, payload: dict[str, Any]) -> dict[str, Any]:
        generation_id, document_id, expected_hash = _validated_job_payload(payload)
        self._require_enabled()
        indexed = self.db.query_one(
            "SELECT di.status, di.expected_hash, d.title, d.summary, d.content, "
            "d.content_hash, g.status AS generation_status, g.embedding_base_url, "
            "g.embedding_model, g.embedding_dimensions "
            "FROM knowledge_document_index di "
            "JOIN knowledge_documents d ON d.id = di.document_id "
            "JOIN knowledge_index_generations g ON g.id = di.generation_id "
            "WHERE di.generation_id = ? AND di.document_id = ?",
            (generation_id, document_id),
        )
        if indexed is None:
            return {
                "status": "stale",
                "generation_id": generation_id,
                "document_id": document_id,
                "activated": False,
            }
        if str(indexed["status"]) == "ready":
            return {
                "status": "ready",
                "generation_id": generation_id,
                "document_id": document_id,
                "activated": str(indexed["generation_status"]) == "active",
            }
        if (
            str(indexed["generation_status"]) != "building"
            or str(indexed["expected_hash"]) != expected_hash
            or str(indexed["content_hash"]) != expected_hash
        ):
            self.mark_index_failed(payload, "document changed before indexing")
            return {
                "status": "stale",
                "generation_id": generation_id,
                "document_id": document_id,
                "activated": False,
            }
        chunks = chunk_document(
            document_id=document_id,
            title=str(indexed["title"]),
            content=str(indexed["content"]),
        )
        generation_config = KnowledgeEmbeddingConfig(
            base_url=str(indexed["embedding_base_url"]),
            model=str(indexed["embedding_model"]),
            api_key=self._config.api_key,
            dimensions=(
                int(indexed["embedding_dimensions"])
                if indexed["embedding_dimensions"] is not None
                else None
            ),
            batch_size=self._config.batch_size,
        ).validated(require_enabled=True)
        client = self._client_for_generation(generation_config)
        vectors: list[list[float]] = []
        texts = [
            _embedding_text(
                title=str(indexed["title"]),
                summary=str(indexed["summary"]),
                chunk=chunk,
            )
            for chunk in chunks
        ]
        resolved_dimensions = generation_config.dimensions
        for offset in range(0, len(texts), generation_config.batch_size):
            batch = texts[offset : offset + generation_config.batch_size]
            embedded = _validated_vectors(
                client.embed(batch),
                expected_count=len(batch),
                expected_dimensions=resolved_dimensions,
            )
            if resolved_dimensions is None:
                resolved_dimensions = len(embedded[0])
            vectors.extend(embedded)
        if resolved_dimensions is None:  # pragma: no cover - non-empty documents chunk
            raise EmbeddingResponseError("knowledge document produced no vectors")
        timestamp = now_ts()
        activated = False
        with self.db.transaction(immediate=True) as conn:
            current = conn.execute(
                "SELECT di.status AS document_status, di.expected_hash, "
                "d.content_hash, g.status AS generation_status, "
                "g.embedding_dimensions FROM knowledge_document_index di "
                "JOIN knowledge_documents d ON d.id = di.document_id "
                "JOIN knowledge_index_generations g ON g.id = di.generation_id "
                "WHERE di.generation_id = ? AND di.document_id = ?",
                (generation_id, document_id),
            ).fetchone()
            if (
                current is None
                or str(current["document_status"]) == "ready"
                or str(current["expected_hash"]) != expected_hash
                or str(current["content_hash"]) != expected_hash
                or str(current["generation_status"]) != "building"
            ):
                return {
                    "status": "stale",
                    "generation_id": generation_id,
                    "document_id": document_id,
                    "activated": False,
                }
            locked_dimensions = current["embedding_dimensions"]
            if locked_dimensions is None:
                conn.execute(
                    "UPDATE knowledge_index_generations SET embedding_dimensions = ?, "
                    "updated_at = ? WHERE id = ? AND embedding_dimensions IS NULL",
                    (resolved_dimensions, timestamp, generation_id),
                )
            elif int(locked_dimensions) != resolved_dimensions:
                raise EmbeddingResponseError(
                    "knowledge embedding dimensions changed within a generation"
                )
            conn.execute(
                "DELETE FROM knowledge_chunks WHERE generation_id = ? AND document_id = ?",
                (generation_id, document_id),
            )
            for chunk, vector in zip(chunks, vectors, strict=True):
                norm = math.sqrt(sum(value * value for value in vector))
                conn.execute(
                    "INSERT INTO knowledge_chunks("
                    "generation_id, chunk_id, document_id, chunk_index, title_path, "
                    "content, char_start, char_end, chunk_hash, created_at"
                    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        generation_id,
                        chunk.chunk_id,
                        document_id,
                        chunk.chunk_index,
                        chunk.title_path,
                        chunk.content,
                        chunk.char_start,
                        chunk.char_end,
                        chunk.chunk_hash,
                        timestamp,
                    ),
                )
                conn.execute(
                    "INSERT INTO knowledge_chunk_embeddings("
                    "generation_id, chunk_id, dimensions, vector, norm, created_at"
                    ") VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        generation_id,
                        chunk.chunk_id,
                        resolved_dimensions,
                        _pack_vector(vector),
                        norm,
                        timestamp,
                    ),
                )
            conn.execute(
                "UPDATE knowledge_document_index SET status = 'ready', "
                "chunk_count = ?, last_error = '', updated_at = ? "
                "WHERE generation_id = ? AND document_id = ?",
                (len(chunks), timestamp, generation_id, document_id),
            )
            conn.execute(
                "UPDATE knowledge_index_generations SET "
                "ready_document_count = (SELECT count(*) FROM knowledge_document_index "
                "WHERE generation_id = ? AND status = 'ready'), updated_at = ? "
                "WHERE id = ?",
                (generation_id, timestamp, generation_id),
            )
            activated = self._activate_if_complete_in_transaction(conn, generation_id)
        return {
            "status": "ready",
            "generation_id": generation_id,
            "document_id": document_id,
            "chunk_count": len(chunks),
            "dimensions": resolved_dimensions,
            "activated": activated,
        }

    def _client_for_generation(
        self, config: KnowledgeEmbeddingConfig
    ) -> EmbeddingClient:
        if self._injected_client is not None:
            return self._injected_client
        return OpenAIEmbeddingClient(config)

    def mark_index_failed(self, payload: dict[str, Any], error: str) -> None:
        generation_id, document_id, expected_hash = _validated_job_payload(payload)
        safe_error = str(error).strip()[:1_000]
        with self.db.transaction(immediate=True) as conn:
            conn.execute(
                "UPDATE knowledge_document_index SET status = 'failed', "
                "last_error = ?, updated_at = ? WHERE generation_id = ? "
                "AND document_id = ? AND expected_hash = ? AND status != 'ready'",
                (safe_error, now_ts(), generation_id, document_id, expected_hash),
            )
            conn.execute(
                "UPDATE knowledge_index_generations SET last_error = ?, updated_at = ? "
                "WHERE id = ? AND status = 'building'",
                (safe_error, now_ts(), generation_id),
            )

    def _generation_covers_current_documents(self, conn, generation_id: int) -> bool:
        document_count = int(
            conn.execute("SELECT count(*) FROM knowledge_documents").fetchone()[0]
        )
        covered = int(conn.execute(
            "SELECT count(*) FROM knowledge_document_index di "
            "JOIN knowledge_documents d ON d.id = di.document_id "
            "WHERE di.generation_id = ? AND di.status = 'ready' "
            "AND di.expected_hash = d.content_hash",
            (generation_id,),
        ).fetchone()[0])
        indexed = int(conn.execute(
            "SELECT count(*) FROM knowledge_document_index WHERE generation_id = ?",
            (generation_id,),
        ).fetchone()[0])
        return document_count == covered == indexed

    def _activate_if_complete_in_transaction(self, conn, generation_id: int) -> bool:
        if not self._generation_covers_current_documents(conn, generation_id):
            return False
        missing_vectors = int(conn.execute(
            "SELECT count(*) FROM knowledge_document_index di WHERE "
            "di.generation_id = ? AND di.status = 'ready' AND ("
            "NOT EXISTS (SELECT 1 FROM knowledge_chunks c WHERE "
            "c.generation_id = di.generation_id AND c.document_id = di.document_id) "
            "OR EXISTS (SELECT 1 FROM knowledge_chunks c LEFT JOIN "
            "knowledge_chunk_embeddings e ON e.generation_id = c.generation_id "
            "AND e.chunk_id = c.chunk_id WHERE c.generation_id = di.generation_id "
            "AND c.document_id = di.document_id AND e.chunk_id IS NULL))",
            (generation_id,),
        ).fetchone()[0])
        if missing_vectors:
            return False
        timestamp = now_ts()
        conn.execute(
            "UPDATE knowledge_index_generations SET status = 'superseded', "
            "updated_at = ? WHERE status = 'active' AND id != ?",
            (timestamp, generation_id),
        )
        updated = conn.execute(
            "UPDATE knowledge_index_generations SET status = 'active', "
            "activated_at = ?, last_error = '', updated_at = ? "
            "WHERE id = ? AND status = 'building'",
            (timestamp, timestamp, generation_id),
        )
        return updated.rowcount == 1

    def search(
        self,
        query: str,
        limit: int = 5,
        *,
        char_budget: int = 8_000,
    ) -> list[KnowledgeHit]:
        self._require_enabled()
        query = query.strip()
        if not query:
            return []
        limit = max(1, min(int(limit), 20))
        char_budget = max(256, min(int(char_budget), 64_000))
        generation = self.db.query_one(
            "SELECT * FROM knowledge_index_generations WHERE status = 'active' "
            "ORDER BY id DESC LIMIT 1"
        )
        if generation is None:
            raise KnowledgeUnavailableError(
                "knowledge index has no active generation"
            )
        dimensions = generation.get("embedding_dimensions")
        if dimensions is None:
            if int(generation.get("document_count") or 0) == 0:
                return []
            raise KnowledgeUnavailableError(
                "knowledge active generation has no embedding dimensions"
            )
        generation_config = KnowledgeEmbeddingConfig(
            base_url=str(generation["embedding_base_url"]),
            model=str(generation["embedding_model"]),
            api_key=self._config.api_key,
            dimensions=int(dimensions),
            batch_size=self._config.batch_size,
        ).validated(require_enabled=True)
        query_vector = _validated_vectors(
            self._client_for_generation(generation_config).embed([query]),
            expected_count=1,
            expected_dimensions=int(dimensions),
        )[0]
        query_norm = math.sqrt(sum(value * value for value in query_vector))
        rows = self.db.query(
            "SELECT c.chunk_id, c.document_id, c.chunk_index, c.title_path, "
            "c.content, c.char_start, c.char_end, d.title, d.summary, d.source, "
            "e.vector, e.norm, e.dimensions FROM knowledge_chunks c "
            "JOIN knowledge_chunk_embeddings e ON e.generation_id = c.generation_id "
            "AND e.chunk_id = c.chunk_id JOIN knowledge_documents d ON d.id = c.document_id "
            "WHERE c.generation_id = ?",
            (int(generation["id"]),),
        )
        scored: list[tuple[float, dict[str, Any]]] = []
        for row in rows:
            vector = _unpack_vector(row["vector"], int(row["dimensions"]))
            score = sum(a * b for a, b in zip(query_vector, vector, strict=True)) / (
                query_norm * float(row["norm"])
            )
            if not math.isfinite(score):
                raise KnowledgeUnavailableError(
                    "knowledge index contains a non-finite similarity score"
                )
            scored.append((score, row))
        scored.sort(
            key=lambda item: (
                -item[0],
                int(item[1]["document_id"]),
                int(item[1]["chunk_index"]),
            )
        )
        hits: list[KnowledgeHit] = []
        seen_documents: set[int] = set()
        remaining = char_budget
        for score, row in scored:
            document_id = int(row["document_id"])
            if document_id in seen_documents:
                continue
            evidence, char_start, char_end = self._adjacent_evidence(
                int(generation["id"]),
                document_id,
                int(row["chunk_index"]),
                max_chars=remaining,
            )
            if not evidence:
                continue
            hits.append(KnowledgeHit(
                document_id=document_id,
                chunk_id=str(row["chunk_id"]),
                title=str(row["title"]),
                summary=str(row["summary"]),
                source=str(row["source"]),
                content=evidence,
                title_path=str(row["title_path"]),
                char_start=char_start,
                char_end=char_end,
                score=float(score),
            ))
            seen_documents.add(document_id)
            remaining -= len(evidence)
            if len(hits) >= limit or remaining <= 0:
                break
        return hits

    def _adjacent_evidence(
        self,
        generation_id: int,
        document_id: int,
        chunk_index: int,
        *,
        max_chars: int,
    ) -> tuple[str, int, int]:
        if max_chars <= 0:
            return "", 0, 0
        rows = self.db.query(
            "SELECT chunk_index, content, char_start, char_end FROM knowledge_chunks "
            "WHERE generation_id = ? AND document_id = ? AND chunk_index BETWEEN ? AND ? "
            "ORDER BY chunk_index",
            (generation_id, document_id, max(0, chunk_index - 1), chunk_index + 1),
        )
        primary = next(
            (row for row in rows if int(row["chunk_index"]) == chunk_index), None
        )
        if primary is None:
            return "", 0, 0
        selected = [primary]
        for row in rows:
            if row is primary:
                continue
            candidate = sorted(selected + [row], key=lambda item: int(item["chunk_index"]))
            text = "\n\n".join(str(item["content"]) for item in candidate)
            if len(text) <= max_chars:
                selected = candidate
        selected.sort(key=lambda item: int(item["chunk_index"]))
        evidence = "\n\n".join(str(item["content"]) for item in selected)
        if len(evidence) > max_chars:
            evidence = evidence[:max_chars].rstrip()
        return (
            evidence,
            min(int(item["char_start"]) for item in selected),
            max(int(item["char_end"]) for item in selected),
        )

    def suggest(self, context: str, limit: int = 3) -> list[KnowledgeHit]:
        context = context.strip()
        if not context:
            return []
        return self.search(context, limit=limit)


def _validated_job_payload(payload: dict[str, Any]) -> tuple[int, int, str]:
    if not isinstance(payload, dict) or set(payload) != {
        "document_id", "expected_hash", "generation_id"
    }:
        raise ValueError("knowledge index job payload is invalid")
    try:
        generation_id = int(payload["generation_id"])
        document_id = int(payload["document_id"])
    except (TypeError, ValueError) as exc:
        raise ValueError("knowledge index job identity is invalid") from exc
    expected_hash = str(payload["expected_hash"])
    if generation_id < 1 or document_id < 1 or not re.fullmatch(r"[0-9a-f]{64}", expected_hash):
        raise ValueError("knowledge index job identity is invalid")
    return generation_id, document_id, expected_hash


def _validated_vectors(
    vectors: Any,
    *,
    expected_count: int,
    expected_dimensions: int | None,
) -> list[list[float]]:
    if not isinstance(vectors, list) or len(vectors) != expected_count:
        raise EmbeddingResponseError(
            "knowledge embedding provider returned an unexpected vector count"
        )
    result: list[list[float]] = []
    resolved_dimensions = expected_dimensions
    for vector in vectors:
        if not isinstance(vector, list) or not vector:
            raise EmbeddingResponseError(
                "knowledge embedding provider returned an invalid vector"
            )
        if resolved_dimensions is None:
            resolved_dimensions = len(vector)
        if len(vector) != resolved_dimensions or len(vector) > MAX_EMBEDDING_DIMENSIONS:
            raise EmbeddingResponseError(
                "knowledge embedding provider returned inconsistent dimensions"
            )
        clean: list[float] = []
        for value in vector:
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise EmbeddingResponseError(
                    "knowledge embedding provider returned a non-numeric vector"
                )
            number = float(value)
            if not math.isfinite(number):
                raise EmbeddingResponseError(
                    "knowledge embedding provider returned a non-finite vector"
                )
            clean.append(number)
        if not any(value != 0.0 for value in clean):
            raise EmbeddingResponseError(
                "knowledge embedding provider returned a zero vector"
            )
        result.append(clean)
    return result


def _pack_vector(vector: Sequence[float]) -> bytes:
    return struct.pack(f"<{len(vector)}f", *vector)


def _unpack_vector(value: Any, dimensions: int) -> tuple[float, ...]:
    blob = bytes(value)
    if dimensions < 1 or len(blob) != dimensions * 4:
        raise KnowledgeUnavailableError(
            "knowledge index contains an invalid vector payload"
        )
    vector = struct.unpack(f"<{dimensions}f", blob)
    if not all(math.isfinite(item) for item in vector):
        raise KnowledgeUnavailableError(
            "knowledge index contains a non-finite vector payload"
        )
    return vector


def chunk_document(
    *,
    document_id: int,
    title: str,
    content: str,
    target_chars: int = CHUNK_TARGET_CHARS,
    overlap_chars: int = CHUNK_OVERLAP_CHARS,
) -> list[KnowledgeChunk]:
    if document_id < 1:
        raise ValueError("knowledge document id must be positive")
    if target_chars < 128:
        raise ValueError("knowledge chunk target must be at least 128 characters")
    if overlap_chars < 0 or overlap_chars >= target_chars // 2:
        raise ValueError("knowledge chunk overlap is invalid")
    if not content:
        return []
    headings = _heading_events(content)
    chunks: list[KnowledgeChunk] = []
    cursor = 0
    while cursor < len(content):
        while cursor < len(content) and content[cursor].isspace():
            cursor += 1
        if cursor >= len(content):
            break
        maximum = min(len(content), cursor + target_chars)
        end = maximum if maximum == len(content) else _preferred_chunk_end(
            content, cursor, maximum
        )
        while end > cursor and content[end - 1].isspace():
            end -= 1
        if end <= cursor:
            end = maximum
        text = content[cursor:end]
        chunk_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
        identity = "\x00".join(
            (
                str(document_id),
                CHUNKER_VERSION,
                str(cursor),
                str(end),
                chunk_hash,
            )
        )
        chunks.append(KnowledgeChunk(
            chunk_id=hashlib.sha256(identity.encode("utf-8")).hexdigest(),
            document_id=document_id,
            chunk_index=len(chunks),
            title_path=_title_path(title, headings, cursor),
            content=text,
            char_start=cursor,
            char_end=end,
            chunk_hash=chunk_hash,
        ))
        if end >= len(content):
            break
        next_cursor = max(cursor + 1, end - overlap_chars)
        boundary = content.find(" ", next_cursor, end)
        cursor = boundary + 1 if boundary >= 0 else next_cursor
    return chunks


def _preferred_chunk_end(content: str, start: int, maximum: int) -> int:
    minimum = start + max(64, int((maximum - start) * 0.55))
    paragraph = content.rfind("\n\n", minimum, maximum)
    if paragraph >= minimum:
        return paragraph
    newline = content.rfind("\n", minimum, maximum)
    if newline >= minimum:
        return newline
    sentence_end = -1
    for match in re.finditer(r"[.!?。！？]\s*", content[minimum:maximum]):
        sentence_end = minimum + match.end()
    return sentence_end if sentence_end > start else maximum


def _heading_events(content: str) -> list[tuple[int, tuple[str, ...]]]:
    result: list[tuple[int, tuple[str, ...]]] = []
    hierarchy: list[str] = []
    for match in re.finditer(r"(?m)^(#{1,6})[ \t]+(.+?)[ \t]*$", content):
        level = len(match.group(1))
        heading = match.group(2).strip().rstrip("#").strip()
        hierarchy = hierarchy[: level - 1]
        while len(hierarchy) < level - 1:
            hierarchy.append("")
        hierarchy.append(heading)
        result.append((match.start(), tuple(item for item in hierarchy if item)))
    return result


def _title_path(
    title: str,
    headings: list[tuple[int, tuple[str, ...]]],
    offset: int,
) -> str:
    path: tuple[str, ...] = ()
    for position, candidate in headings:
        if position > offset:
            break
        path = candidate
    values = [title.strip(), *path]
    return " > ".join(value for value in values if value)


def _embedding_text(
    *,
    title: str,
    summary: str,
    chunk: KnowledgeChunk,
) -> str:
    parts = [
        f"Title: {title}",
        f"Section: {chunk.title_path}" if chunk.title_path else "",
        f"Summary: {summary}" if summary else "",
        chunk.content,
    ]
    return "\n".join(part for part in parts if part)


def summarize_content(content: str, max_len: int = 220) -> str:
    compact = re.sub(r"\s+", " ", content).strip()
    if len(compact) <= max_len:
        return compact
    return compact[: max_len - 1].rstrip() + "..."
