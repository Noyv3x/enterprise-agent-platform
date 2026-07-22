from __future__ import annotations

import asyncio
import sys
import time
from dataclasses import dataclass
from typing import Any

from .config import PlatformConfig
from .knowledge import summarize_content

# How long a resolved Cognee availability status is trusted before being
# re-evaluated, so availability changes after startup are eventually noticed.
COGNEE_STATUS_TTL_SECONDS = 60.0


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
        self._status_checked_at = 0.0

    def status(self) -> CogneeStatus:
        now = time.time()
        if self._status is not None and (now - self._status_checked_at) < COGNEE_STATUS_TTL_SECONDS:
            return self._status
        backend = self._backend()
        if backend == "local":
            self._status = CogneeStatus(False, "local", "")
            self._status_checked_at = now
            return self._status
        try:
            if self.runtime_manager is not None:
                runtime = self.runtime_manager.ensure_cognee_ready()
                # A managed bridge must only import the distribution that the
                # deploy step installed and verified.  In explicit external
                # mode the runtime manager does not own preparation, so let the
                # bridge try the operator-provided repository instead.
                if runtime.managed and not runtime.available:
                    self._status = CogneeStatus(False, backend, runtime.error)
                    self._status_checked_at = now
                    return self._status
            self._module = self._import_cognee()
            self._status = CogneeStatus(True, backend)
        except Exception as exc:
            self._status = CogneeStatus(False, backend, str(exc))
        self._status_checked_at = now
        return self._status

    def refresh_status(self) -> CogneeStatus:
        self._status = None
        self._status_checked_at = 0.0
        return self.status()

    def ingest_document(self, *, title: str, content: str, source: str = "") -> dict[str, Any]:
        backend = self._backend()
        if backend not in {"hybrid", "cognee"}:
            return {"attempted": False, "available": False}
        status = self.status()
        if not status.available:
            return {"attempted": True, "available": False, "error": status.error}
        self._seed_cognee_env()
        dataset = self._dataset()
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
                    # ``asyncio.run`` owns a short-lived event loop. Cognee's
                    # background mode only schedules an asyncio task and then
                    # returns, so that task is cancelled as the loop closes
                    # while the durable platform job is falsely marked done.
                    # The platform worker is already the background boundary;
                    # wait here for graph construction's real terminal state.
                    run_in_background=False,
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
        limit = min(int(limit), 20)
        if limit <= 0:
            return []
        if self._backend() not in {"hybrid", "cognee"}:
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
                    datasets=[self._dataset()],
                    top_k=limit,
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
        runtime_config = self._runtime_config()
        managed_value = runtime_config.get("manage_cognee")
        managed = (
            self.config.manage_cognee
            if managed_value is None
            else _as_bool(managed_value)
        )
        if not managed:
            repo = self._repo(runtime_config)
            if repo.exists() and str(repo) not in sys.path:
                sys.path.insert(0, str(repo))
        import cognee  # type: ignore

        return cognee

    def _seed_cognee_env(self) -> None:
        if self.runtime_manager is not None:
            self.runtime_manager.ensure_cognee_ready()

    def _runtime_config(self) -> dict[str, Any]:
        if self.runtime_manager is None:
            return {}
        try:
            data = self.runtime_manager.cognee_runtime_config()
        except Exception:
            return {}
        return data if isinstance(data, dict) else {}

    def _backend(self) -> str:
        value = str(self._runtime_config().get("backend") or self.config.knowledge_backend).strip().lower()
        return value if value in {"local", "hybrid", "cognee"} else "hybrid"

    def _dataset(self) -> str:
        return str(self._runtime_config().get("dataset") or self.config.cognee_dataset)

    def _repo(self, runtime_config: dict[str, Any] | None = None):
        from pathlib import Path

        value = (runtime_config or self._runtime_config()).get("repo_path")
        return Path(str(value)).expanduser() if value else self.config.cognee_repo

    def _ingest_background(self) -> bool:
        value = self._runtime_config().get("ingest_background")
        if value is None:
            return self.config.cognee_ingest_background
        return bool(value)


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


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def compact_repr(value: Any, limit: int = 800) -> str:
    text = repr(value)
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "..."
