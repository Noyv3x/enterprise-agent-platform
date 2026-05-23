from __future__ import annotations

import asyncio
import os
import sys
from dataclasses import dataclass
from typing import Any

from .config import PlatformConfig
from .knowledge import summarize_content


@dataclass(frozen=True)
class CogneeStatus:
    available: bool
    backend: str
    error: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"available": self.available, "backend": self.backend, "error": self.error}


class CogneeBridge:
    """Optional bridge to the local Cognee repository.

    The platform always keeps a local SQLite index so the web UI and agent
    tools remain available without heavy LLM/database setup. When
    ENTERPRISE_KB_BACKEND is `hybrid` or `cognee`, this bridge also attempts
    Cognee ingestion/search using the repository path from configuration.
    """

    def __init__(self, config: PlatformConfig, secret_provider, runtime_manager=None):
        self.config = config
        self.secret_provider = secret_provider
        self.runtime_manager = runtime_manager
        self._module = None
        self._status: CogneeStatus | None = None

    def status(self) -> CogneeStatus:
        if self._status is not None:
            return self._status
        if self.config.knowledge_backend == "local":
            self._status = CogneeStatus(False, "local", "")
            return self._status
        try:
            if self.runtime_manager is not None:
                runtime = self.runtime_manager.ensure_cognee_ready()
                if not runtime.available:
                    self._status = CogneeStatus(False, self.config.knowledge_backend, runtime.error)
                    return self._status
            self._module = self._import_cognee()
            self._status = CogneeStatus(True, self.config.knowledge_backend)
        except Exception as exc:
            self._status = CogneeStatus(False, self.config.knowledge_backend, str(exc))
        return self._status

    def refresh_status(self) -> CogneeStatus:
        self._status = None
        return self.status()

    def ingest_document(self, *, title: str, content: str, source: str = "") -> dict[str, Any]:
        if self.config.knowledge_backend not in {"hybrid", "cognee"}:
            return {"attempted": False, "available": False}
        status = self.status()
        if not status.available:
            return {"attempted": True, "available": False, "error": status.error}
        self._seed_cognee_env()
        dataset = self.config.cognee_dataset
        payload = f"# {title}\n\nSource: {source}\n\n{content}"
        try:
            cognee = self._module
            add_result = asyncio.run(
                cognee.add(
                    payload,
                    dataset_name=dataset,
                    run_in_background=False,
                )
            )
            cognify_result = asyncio.run(
                cognee.cognify(
                    datasets=[dataset],
                    run_in_background=self.config.cognee_ingest_background,
                )
            )
            return {
                "attempted": True,
                "available": True,
                "dataset": dataset,
                "add": compact_repr(add_result),
                "cognify": compact_repr(cognify_result),
            }
        except Exception as exc:
            return {"attempted": True, "available": True, "dataset": dataset, "error": str(exc)}

    def search(self, query: str, limit: int = 5) -> list[dict[str, Any]]:
        if self.config.knowledge_backend not in {"hybrid", "cognee"}:
            return []
        status = self.status()
        if not status.available:
            return []
        self._seed_cognee_env()
        try:
            cognee = self._module
            search_type = getattr(cognee.SearchType, "CHUNKS", None) or cognee.SearchType.GRAPH_COMPLETION
            results = asyncio.run(
                cognee.search(
                    query_text=query,
                    query_type=search_type,
                    datasets=[self.config.cognee_dataset],
                    top_k=max(1, min(int(limit), 20)),
                )
            )
        except Exception:
            return []
        normalized: list[dict[str, Any]] = []
        for index, item in enumerate(results or [], start=1):
            text = stringify_cognee_result(item)
            normalized.append(
                {
                    "id": f"cognee:{index}",
                    "title": "Cognee result",
                    "summary": summarize_content(text),
                    "source": "cognee",
                    "score": 0.0,
                }
            )
            if len(normalized) >= limit:
                break
        return normalized

    def _import_cognee(self):
        repo = self.config.cognee_repo
        if repo.exists() and str(repo) not in sys.path:
            sys.path.insert(0, str(repo))
        import cognee  # type: ignore

        return cognee

    def _seed_cognee_env(self) -> None:
        if self.runtime_manager is not None:
            self.runtime_manager.ensure_cognee_ready()
        # Cognee commonly reads LLM_API_KEY, while Hermes users usually store
        # provider-specific keys. Seed only missing vars and never expose values.
        if not os.getenv("LLM_API_KEY"):
            for key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "NOUS_API_KEY", "OPENROUTER_API_KEY"):
                value = self.secret_provider(key)
                if value:
                    os.environ["LLM_API_KEY"] = value
                    break


def stringify_cognee_result(item: Any) -> str:
    if isinstance(item, str):
        return item
    if isinstance(item, dict):
        for key in ("text", "content", "summary", "answer"):
            if item.get(key):
                return str(item[key])
        return str(item)
    for attr in ("text", "content", "summary", "answer"):
        value = getattr(item, attr, None)
        if value:
            return str(value)
    return str(item)


def compact_repr(value: Any, limit: int = 800) -> str:
    text = repr(value)
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "..."
