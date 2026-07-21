from __future__ import annotations

import base64
import binascii
import json
import re
import threading
import time
from typing import Any, Callable

from .oauth_flows import OAuthHTTPClient


MODEL_CATALOG_CACHE_SETTING = "agent_model_catalog_cache_v1"
CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0"
XAI_MODELS_URL = "https://api.x.ai/v1/models"
RUNTIME_CATALOG_TTL_SECONDS = 5 * 60
OAUTH_CATALOG_TTL_SECONDS = 10 * 60
FAILED_REFRESH_RETRY_SECONDS = 60
_MODEL_ID_RE = re.compile(r"^[^\r\n\x00]{1,160}$")


class ModelCatalogManager:
    """Merge Runtime capabilities with provider OAuth visibility.

    The Agent Runtime is the sole authority for executable model metadata.
    Provider discovery may narrow or annotate that trusted set, but can never
    introduce a model that the Runtime cannot resolve safely.
    """

    def __init__(
        self,
        *,
        runtime_loader: Callable[[], dict[str, Any]],
        credential_loader: Callable[[str], tuple[str, int]],
        oauth_configured: Callable[[str], bool],
        credential_revision: Callable[[str], int],
        http_client: OAuthHTTPClient,
        cache_loader: Callable[[], str | None],
        cache_saver: Callable[[str], None],
        clock: Callable[[], float] = time.time,
    ):
        self._runtime_loader = runtime_loader
        self._credential_loader = credential_loader
        self._oauth_configured = oauth_configured
        self._credential_revision = credential_revision
        self._http = http_client
        self._cache_saver = cache_saver
        self._clock = clock
        self._lock = threading.RLock()
        self._persist_lock = threading.Lock()
        self._runtime_condition = threading.Condition(self._lock)
        self._runtime_refreshing = False
        self._runtime_generation = 0
        self._runtime_refreshed = False
        self._runtime_failure_at = 0
        self._runtime_failure_error = ""
        self._oauth_conditions = {
            provider: threading.Condition(self._lock)
            for provider in ("openai-codex", "xai-oauth")
        }
        self._oauth_refreshing: set[str] = set()
        self._oauth_generations = {
            provider: 0
            for provider in ("openai-codex", "xai-oauth")
        }
        self._oauth_failures: dict[str, tuple[int, int, str]] = {}
        try:
            cached = cache_loader()
        except Exception:
            cached = None
        self._cache = self._load_cache(cached)

    def catalogs(self) -> dict[str, dict[str, Any]]:
        return {
            provider: self.catalog(provider)
            for provider in ("openai-codex", "xai-oauth")
        }

    def catalog(self, provider: str) -> dict[str, Any]:
        if provider not in {"openai-codex", "xai-oauth"}:
            return {
                "provider": provider,
                "models": [],
                "model_details": [],
                "default_model": "",
                "source": "unavailable",
                "stale": False,
                "fetched_at": None,
                "oauth_verified_models": [],
                "error": "unsupported provider",
            }
        runtime, runtime_stale, runtime_error, runtime_at = self._runtime_catalogs()
        trusted = runtime.get(provider, {})
        details = trusted.get("models") if isinstance(trusted, dict) else []
        if not isinstance(details, list):
            details = []
        trusted_ids = [str(item.get("id") or "") for item in details if isinstance(item, dict)]
        trusted_ids = [model_id for model_id in trusted_ids if _valid_model_id(model_id)]
        default_model = str(trusted.get("default_model") or "") if isinstance(trusted, dict) else ""
        if default_model not in trusted_ids:
            default_model = trusted_ids[0] if trusted_ids else ""
        if not trusted_ids:
            return {
                "provider": provider,
                "models": [],
                "model_details": [],
                "default_model": "",
                "source": "agent-runtime",
                "stale": runtime_stale,
                "fetched_at": runtime_at,
                "oauth_verified_models": [],
                "error": runtime_error or "Agent Runtime returned no supported models",
            }

        if not self._oauth_configured(provider):
            return self._result(
                provider,
                trusted_ids,
                details,
                default_model,
                source="agent-runtime",
                stale=runtime_stale,
                fetched_at=runtime_at,
                verified=[],
                error=runtime_error,
            )

        discovered, oauth_at, oauth_stale, oauth_error, oauth_source = self._oauth_models(provider)
        trusted_set = set(trusted_ids)
        verified = [model_id for model_id in discovered if model_id in trusted_set]

        if provider == "openai-codex" and discovered:
            # Codex exposes an account-scoped catalog. Only models both
            # visible to this OAuth account and executable by the Runtime
            # may be selected.
            selected = verified
            selected_set = set(selected)
            detail_by_id = {
                str(item.get("id")): item
                for item in details
                if isinstance(item, dict) and item.get("id") in selected_set
            }
            selected_details = [detail_by_id[model_id] for model_id in selected if model_id in detail_by_id]
            selected_default = default_model if default_model in selected_set else (selected[0] if selected else "")
            unsupported_count = len([model_id for model_id in discovered if model_id not in trusted_set])
            compatibility_error = ""
            if discovered and not selected:
                compatibility_error = "OAuth models are not yet supported by this Agent Runtime"
            elif unsupported_count:
                compatibility_error = (
                    f"{unsupported_count} OAuth model(s) are hidden until Runtime metadata is available"
                )
            return self._result(
                provider,
                selected,
                selected_details,
                selected_default,
                source=oauth_source,
                stale=runtime_stale or oauth_stale,
                fetched_at=oauth_at or runtime_at,
                verified=verified,
                error=oauth_error or runtime_error or compatibility_error,
            )

        # xAI's /v1/models response is not exhaustive for OAuth accounts.
        # Keep the complete trusted Runtime catalog and expose the live
        # intersection only as an availability signal, never an allowlist.
        return self._result(
            provider,
            trusted_ids,
            details,
            default_model,
            source=("agent-runtime+oauth" if discovered else "agent-runtime-fallback"),
            stale=runtime_stale or oauth_stale or bool(oauth_error),
            fetched_at=oauth_at or runtime_at,
            verified=verified,
            error=oauth_error or runtime_error,
        )

    def invalidate_oauth(self, provider: str | None = None) -> None:
        with self._lock:
            oauth = self._cache.setdefault("oauth", {})
            if provider:
                oauth.pop(provider, None)
                self._oauth_failures.pop(provider, None)
                self._oauth_generations[provider] = self._oauth_generations.get(provider, 0) + 1
                condition = self._oauth_conditions.get(provider)
                if condition is not None:
                    condition.notify_all()
            else:
                oauth.clear()
                self._oauth_failures.clear()
                for current, condition in self._oauth_conditions.items():
                    self._oauth_generations[current] += 1
                    condition.notify_all()
        self._persist_latest()

    def invalidate_runtime(self) -> None:
        with self._lock:
            self._runtime_generation += 1
            self._runtime_refreshed = False
            self._runtime_failure_at = 0
            self._runtime_failure_error = ""
            self._runtime_condition.notify_all()

    def _runtime_catalogs(self) -> tuple[dict[str, Any], bool, str, int | None]:
        while True:
            now = int(self._clock())
            with self._runtime_condition:
                cached_providers, fetched_at = self._runtime_cache_locked()
                if self._runtime_refreshed and self._runtime_failure_at:
                    if _is_recent(now, self._runtime_failure_at, FAILED_REFRESH_RETRY_SECONDS):
                        return cached_providers, True, self._runtime_failure_error, fetched_at or None
                    # The failure backoff elapsed. Do not let an otherwise-fresh
                    # last-known-good cache suppress the required Runtime retry.
                elif (
                    self._runtime_refreshed
                    and cached_providers
                    and _is_recent(now, fetched_at, RUNTIME_CATALOG_TTL_SECONDS)
                ):
                    return cached_providers, False, "", fetched_at
                if self._runtime_refreshing:
                    self._runtime_condition.wait()
                    continue
                self._runtime_refreshing = True
                generation = self._runtime_generation

            try:
                payload = self._runtime_loader()
                providers = _normalize_runtime_providers(
                    payload.get("providers") if isinstance(payload, dict) else None
                )
                if not providers:
                    raise ValueError("Agent Runtime returned an empty model catalog")
                outcome: tuple[dict[str, Any], str] | Exception = (
                    providers,
                    str(payload.get("source") or "agent-runtime"),
                )
            except Exception as exc:
                outcome = exc

            completed_at = int(self._clock())
            persist = False
            retry = False
            with self._runtime_condition:
                self._runtime_refreshing = False
                if generation != self._runtime_generation:
                    retry = True
                elif isinstance(outcome, Exception):
                    self._runtime_refreshed = True
                    self._runtime_failure_at = completed_at
                    self._runtime_failure_error = _safe_error(outcome)
                    cached_providers, fetched_at = self._runtime_cache_locked()
                    result = (
                        cached_providers,
                        True,
                        self._runtime_failure_error,
                        fetched_at or None,
                    )
                else:
                    providers, source = outcome
                    self._cache["runtime"] = {
                        "fetched_at": completed_at,
                        "providers": providers,
                        "source": source,
                    }
                    self._runtime_refreshed = True
                    self._runtime_failure_at = 0
                    self._runtime_failure_error = ""
                    persist = True
                    result = (providers, False, "", completed_at)
                self._runtime_condition.notify_all()

            if retry:
                continue
            if persist:
                self._persist_latest()
            return result

    def _oauth_models(self, provider: str) -> tuple[list[str], int | None, bool, str, str]:
        condition = self._oauth_conditions[provider]
        while True:
            revision = _nonnegative_integer(self._credential_revision(provider))
            now = int(self._clock())
            with condition:
                cached_models, cached_at, cached_revision = self._oauth_cache_locked(provider)
                recent_failure = self._oauth_failures.get(provider)
                if (
                    recent_failure
                    and recent_failure[0] == revision
                    and _is_recent(now, recent_failure[1], FAILED_REFRESH_RETRY_SECONDS)
                ):
                    return (
                        cached_models if cached_revision == revision else [],
                        (cached_at or None) if cached_revision == revision else None,
                        True,
                        recent_failure[2],
                        "oauth-cache"
                        if cached_models and cached_revision == revision
                        else "agent-runtime-fallback",
                    )
                if (
                    cached_models
                    and cached_revision == revision
                    and _is_recent(now, cached_at, OAUTH_CATALOG_TTL_SECONDS)
                ):
                    return cached_models, cached_at, False, "", "oauth-cache"
                if provider in self._oauth_refreshing:
                    condition.wait()
                    continue
                self._oauth_refreshing.add(provider)
                generation = self._oauth_generations[provider]

            active_revision = revision
            models: list[str] | None = None
            error = ""
            superseded = False
            try:
                credential_snapshot = self._credential_loader(provider)
                if (
                    not isinstance(credential_snapshot, tuple)
                    or len(credential_snapshot) != 2
                    or not isinstance(credential_snapshot[0], str)
                    or not credential_snapshot[0]
                ):
                    raise RuntimeError("OAuth credential loader returned an invalid snapshot")
                access_token = credential_snapshot[0]
                active_revision = _nonnegative_integer(credential_snapshot[1])
                url = CODEX_MODELS_URL if provider == "openai-codex" else XAI_MODELS_URL
                additional_headers: dict[str, str] = {}
                if provider == "openai-codex":
                    account_id = _codex_account_id(access_token)
                    if account_id:
                        additional_headers["ChatGPT-Account-Id"] = account_id
                response = self._http.get_bearer_json(
                    url,
                    access_token,
                    additional_headers=additional_headers,
                    timeout=15.0,
                )
                if response.status != 200:
                    raise RuntimeError(f"OAuth model discovery returned HTTP {response.status}")
                models = (
                    _parse_codex_models(response.data)
                    if provider == "openai-codex"
                    else _parse_xai_models(response.data)
                )
                if not models:
                    raise RuntimeError("OAuth model discovery returned no models")
                final_revision = _nonnegative_integer(self._credential_revision(provider))
                superseded = final_revision != active_revision
            except Exception as exc:
                error = _safe_error(exc)
                if not models:
                    models = None
                try:
                    final_revision = _nonnegative_integer(self._credential_revision(provider))
                except Exception:
                    final_revision = active_revision
                if final_revision != active_revision:
                    superseded = True
                else:
                    active_revision = final_revision

            completed_at = int(self._clock())
            persist = False
            retry = False
            with condition:
                self._oauth_refreshing.discard(provider)
                if generation != self._oauth_generations[provider] or superseded:
                    retry = True
                elif models is not None:
                    oauth_cache = self._cache.setdefault("oauth", {})
                    oauth_cache[provider] = {
                        "fetched_at": completed_at,
                        "credential_revision": active_revision,
                        "models": models,
                    }
                    self._oauth_failures.pop(provider, None)
                    persist = True
                    result = (models, completed_at, False, "", "oauth-live")
                else:
                    self._oauth_failures[provider] = (active_revision, completed_at, error)
                    cached_models, cached_at, cached_revision = self._oauth_cache_locked(provider)
                    if cached_models and cached_revision == active_revision:
                        result = (cached_models, cached_at or None, True, error, "oauth-cache")
                    else:
                        result = ([], None, True, error, "agent-runtime-fallback")
                condition.notify_all()

            if retry:
                continue
            if persist:
                self._persist_latest()
            return result

    def _runtime_cache_locked(self) -> tuple[dict[str, Any], int]:
        cached = self._cache.get("runtime")
        if not isinstance(cached, dict):
            return {}, 0
        return (
            _normalize_runtime_providers(cached.get("providers")),
            _positive_timestamp(cached.get("fetched_at")) or 0,
        )

    def _oauth_cache_locked(self, provider: str) -> tuple[list[str], int, int]:
        oauth_cache = self._cache.get("oauth")
        if not isinstance(oauth_cache, dict):
            return [], 0, 0
        cached = oauth_cache.get(provider)
        if not isinstance(cached, dict):
            return [], 0, 0
        return (
            _clean_model_ids(cached.get("models")),
            _positive_timestamp(cached.get("fetched_at")) or 0,
            _nonnegative_integer(cached.get("credential_revision")),
        )

    @staticmethod
    def _result(
        provider: str,
        models: list[str],
        details: list[dict[str, Any]],
        default_model: str,
        *,
        source: str,
        stale: bool,
        fetched_at: int | None,
        verified: list[str],
        error: str,
    ) -> dict[str, Any]:
        return {
            "provider": provider,
            "models": list(models),
            "model_details": [dict(item) for item in details],
            "default_model": default_model,
            "source": source,
            "stale": bool(stale),
            "fetched_at": fetched_at,
            "oauth_verified_models": list(verified),
            "error": error,
        }

    @staticmethod
    def _load_cache(raw: str | None) -> dict[str, Any]:
        try:
            value = json.loads(raw) if raw else {}
        except (TypeError, json.JSONDecodeError):
            return {"version": 1, "oauth": {}}
        if (
            not isinstance(value, dict)
            or type(value.get("version")) is not int
            or value.get("version") != 1
        ):
            return {"version": 1, "oauth": {}}
        cache: dict[str, Any] = {"version": 1, "oauth": {}}
        runtime = value.get("runtime")
        if isinstance(runtime, dict):
            providers = _normalize_runtime_providers(runtime.get("providers"))
            fetched_at = _positive_timestamp(runtime.get("fetched_at"))
            if providers and fetched_at:
                cache["runtime"] = {
                    "fetched_at": fetched_at,
                    "providers": providers,
                    "source": str(runtime.get("source") or "agent-runtime"),
                }
        oauth = value.get("oauth")
        if isinstance(oauth, dict):
            for provider in ("openai-codex", "xai-oauth"):
                entry = oauth.get(provider)
                if not isinstance(entry, dict):
                    continue
                models = _clean_model_ids(entry.get("models"))
                fetched_at = _positive_timestamp(entry.get("fetched_at"))
                revision = _optional_nonnegative_integer(entry.get("credential_revision"))
                if models and fetched_at and revision is not None:
                    cache["oauth"][provider] = {
                        "fetched_at": fetched_at,
                        "credential_revision": revision,
                        "models": models,
                    }
        return cache

    def _persist_latest(self) -> None:
        # Serialize persistence separately from the state lock. Every saver
        # observes the latest complete snapshot, so an older refresh cannot
        # overwrite a newer provider result after slow storage I/O.
        with self._persist_lock:
            try:
                with self._lock:
                    self._cache["version"] = 1
                    payload = json.dumps(
                        self._cache,
                        ensure_ascii=False,
                        separators=(",", ":"),
                    )
                self._cache_saver(payload)
            except Exception:
                # Catalog persistence is an availability optimization. The
                # in-memory snapshot remains valid if storage is unavailable.
                pass


def _normalize_runtime_providers(value: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(value, dict):
        return {}
    normalized: dict[str, dict[str, Any]] = {}
    for provider in ("openai-codex", "xai-oauth"):
        raw = value.get(provider)
        if not isinstance(raw, dict):
            continue
        models: list[dict[str, Any]] = []
        seen: set[str] = set()
        for item in raw.get("models") if isinstance(raw.get("models"), list) else []:
            if not isinstance(item, dict):
                continue
            model_id = str(item.get("id") or "").strip()
            if not _valid_model_id(model_id) or model_id in seen:
                continue
            seen.add(model_id)
            models.append({**item, "id": model_id})
        default_model = str(raw.get("default_model") or "").strip()
        if default_model not in seen:
            default_model = models[0]["id"] if models else ""
        normalized[provider] = {
            **raw,
            "provider": provider,
            "models": models,
            "default_model": default_model,
        }
    return normalized


def _parse_codex_models(payload: Any) -> list[str]:
    entries = payload.get("models") if isinstance(payload, dict) else None
    if not isinstance(entries, list):
        return []
    sortable: list[tuple[int, str]] = []
    for item in entries:
        if not isinstance(item, dict):
            continue
        visibility = str(item.get("visibility") or "").strip().lower()
        if visibility in {"hide", "hidden"}:
            continue
        model_id = str(item.get("slug") or "").strip()
        if not _valid_model_id(model_id):
            continue
        priority = item.get("priority")
        rank = int(priority) if isinstance(priority, (int, float)) else 10_000
        sortable.append((rank, model_id))
    sortable.sort(key=lambda item: (item[0], item[1]))
    return _clean_model_ids([model_id for _, model_id in sortable])


def _parse_xai_models(payload: Any) -> list[str]:
    entries = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(entries, list):
        entries = payload.get("models") if isinstance(payload, dict) else None
    if not isinstance(entries, list):
        return []
    return _clean_model_ids([
        item.get("id") if isinstance(item, dict) else item
        for item in entries
    ])


def _clean_model_ids(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    models: list[str] = []
    seen: set[str] = set()
    for raw in value:
        model_id = str(raw or "").strip()
        if not _valid_model_id(model_id) or model_id in seen:
            continue
        seen.add(model_id)
        models.append(model_id)
    return models


def _valid_model_id(value: str) -> bool:
    return bool(_MODEL_ID_RE.fullmatch(str(value or "")))


def _codex_account_id(access_token: str) -> str:
    """Extract the account routing claim used by Codex OAuth requests.

    The token signature is not trusted here: this value is only echoed as a
    routing header alongside the same bearer token. Authentication remains the
    provider's responsibility.
    """

    parts = str(access_token or "").split(".")
    if len(parts) != 3 or not parts[1]:
        return ""
    try:
        padded = parts[1] + "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
    except (binascii.Error, ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return ""
    auth = payload.get("https://api.openai.com/auth") if isinstance(payload, dict) else None
    account_id = str(auth.get("chatgpt_account_id") or "").strip() if isinstance(auth, dict) else ""
    if not account_id or len(account_id) > 200 or re.search(r"[\r\n\x00]", account_id):
        return ""
    return account_id


def _positive_timestamp(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return parsed if parsed > 0 else None


def _nonnegative_integer(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    try:
        parsed = int(value)
    except (TypeError, ValueError, OverflowError):
        return 0
    return parsed if parsed >= 0 else 0


def _optional_nonnegative_integer(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return parsed if parsed >= 0 else None


def _is_recent(now: int, timestamp: int, ttl: int) -> bool:
    age = now - timestamp
    return timestamp > 0 and 0 <= age < ttl


def _safe_error(exc: Exception) -> str:
    message = str(exc).strip() or type(exc).__name__
    return message[:500]
