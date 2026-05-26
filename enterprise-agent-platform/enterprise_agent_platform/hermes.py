from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Protocol

from .config import PlatformConfig


@dataclass(frozen=True)
class AgentResult:
    content: str
    session_id: str
    raw: dict[str, Any]
    degraded: bool = False


class AgentClient(Protocol):
    def generate(
        self,
        *,
        system_prompt: str,
        user_message: str,
        history: list[dict[str, str]],
        session_id: str,
        session_key: str,
        metadata: dict[str, Any] | None = None,
        model: str | None = None,
        thinking_depth: str | None = None,
        reasoning_config: dict[str, Any] | None = None,
    ) -> AgentResult:
        ...


class LocalAgentClient:
    """Deterministic fallback used for local development and tests."""

    def generate(
        self,
        *,
        system_prompt: str,
        user_message: str,
        history: list[dict[str, str]],
        session_id: str,
        session_key: str,
        metadata: dict[str, Any] | None = None,
        model: str | None = None,
        thinking_depth: str | None = None,
        reasoning_config: dict[str, Any] | None = None,
    ) -> AgentResult:
        prefix = "Main agent" if session_key.startswith("channel:") else "Private agent"
        hints = metadata.get("knowledge_suggestions", []) if metadata else []
        hint_text = ""
        if hints:
            titles = ", ".join(str(item.get("title", "")) for item in hints[:3])
            hint_text = f"\n\n知识库提示: {titles}"
        content = f"{prefix} received: {user_message}{hint_text}"
        return AgentResult(content=content, session_id=session_id, raw={"mode": "local"}, degraded=True)


class HermesAgentClient:
    def __init__(self, config: PlatformConfig, secret_provider, runtime_config_provider=None):
        self.config = config
        self.secret_provider = secret_provider
        self.runtime_config_provider = runtime_config_provider

    def generate(
        self,
        *,
        system_prompt: str,
        user_message: str,
        history: list[dict[str, str]],
        session_id: str,
        session_key: str,
        metadata: dict[str, Any] | None = None,
        model: str | None = None,
        thinking_depth: str | None = None,
        reasoning_config: dict[str, Any] | None = None,
    ) -> AgentResult:
        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(history[-30:])
        messages.append({"role": "user", "content": user_message})
        effective_model = str(model or self._effective_model())
        body = {
            "model": effective_model,
            "messages": messages,
            "stream": False,
        }
        self._apply_reasoning_config(body, thinking_depth=thinking_depth, reasoning_config=reasoning_config)
        headers = {
            "Content-Type": "application/json",
            "X-Hermes-Session-Id": session_id,
            "X-Hermes-Session-Key": session_key,
            "Idempotency-Key": f"{session_id}:{int(time.time() * 1000)}",
        }
        api_key = self.config.hermes_api_key or self.secret_provider("ENTERPRISE_HERMES_API_KEY") or self.secret_provider("API_SERVER_KEY")
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        request = urllib.request.Request(
            self._effective_api_url(),
            data=json.dumps(body).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=self._effective_timeout_seconds()) as response:
            raw = json.loads(response.read().decode("utf-8"))
            response_session = response.headers.get("X-Hermes-Session-Id") or session_id
        choices = raw.get("choices") or []
        content = ""
        if choices:
            message = choices[0].get("message") or {}
            content = str(message.get("content") or "")
        if not content:
            content = str(raw.get("final_response") or "")
        return AgentResult(content=content or "(agent returned an empty response)", session_id=response_session, raw=raw)

    def _runtime_config(self) -> dict[str, Any]:
        if self.runtime_config_provider is None:
            return {}
        try:
            data = self.runtime_config_provider()
        except Exception:
            return {}
        return data if isinstance(data, dict) else {}

    def _effective_api_url(self) -> str:
        return str(self._runtime_config().get("api_url") or self.config.hermes_api_url)

    def _effective_model(self) -> str:
        return str(self._runtime_config().get("model") or self.config.hermes_model)

    def _effective_timeout_seconds(self) -> float:
        raw = self._runtime_config().get("timeout_seconds")
        try:
            return max(1.0, float(raw)) if raw is not None else self.config.hermes_timeout_seconds
        except (TypeError, ValueError):
            return self.config.hermes_timeout_seconds

    @staticmethod
    def _apply_reasoning_config(
        body: dict[str, Any],
        *,
        thinking_depth: str | None,
        reasoning_config: dict[str, Any] | None,
    ) -> None:
        config = dict(reasoning_config or {})
        depth = str(thinking_depth or "").strip().lower()
        if not config and depth:
            config = {"enabled": False} if depth == "none" else {"enabled": True, "effort": depth}
        if not config:
            return
        body["reasoning_config"] = config
        body["reasoning"] = config
        if config.get("enabled") is False:
            body["reasoning_effort"] = "none"
            return
        effort = str(config.get("effort") or "").strip().lower()
        if effort:
            body["reasoning_effort"] = effort


class AutoAgentClient:
    def __init__(self, config: PlatformConfig, secret_provider, runtime_manager=None):
        self.config = config
        self.runtime_manager = runtime_manager
        runtime_config_provider = runtime_manager.hermes_runtime_config if runtime_manager is not None else None
        self.hermes = HermesAgentClient(config, secret_provider, runtime_config_provider=runtime_config_provider)
        self.local = LocalAgentClient()

    def generate(self, **kwargs: Any) -> AgentResult:
        if self.config.agent_mode == "local":
            return self.local.generate(**kwargs)
        try:
            if self.runtime_manager is not None:
                self.runtime_manager.ensure_hermes_ready(wait=True)
            return self.hermes.generate(**kwargs)
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError, KeyError, ValueError) as exc:
            if self.config.agent_mode == "hermes":
                raise
            fallback = self.local.generate(**kwargs)
            return AgentResult(
                content=(
                    "Hermes API is not reachable, so this response was produced by the local "
                    f"platform fallback. Original error: {exc}\n\n{fallback.content}"
                ),
                session_id=fallback.session_id,
                raw={"mode": "auto-fallback", "error": str(exc)},
                degraded=True,
            )
