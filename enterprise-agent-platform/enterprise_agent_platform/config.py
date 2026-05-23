from __future__ import annotations

import os
import secrets
from dataclasses import dataclass
from pathlib import Path


MODEL_SECRET_KEYS = (
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY",
    "NOUS_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "XAI_API_KEY",
    "MOONSHOT_API_KEY",
    "ZAI_API_KEY",
    "NVIDIA_API_KEY",
)


@dataclass(frozen=True)
class PlatformConfig:
    data_dir: Path
    host: str
    port: int
    public_base_url: str
    token_secret: str
    token_ttl_seconds: int
    agent_tool_token: str | None
    agent_mode: str
    hermes_api_url: str
    hermes_api_key: str
    hermes_model: str
    hermes_timeout_seconds: float
    knowledge_backend: str
    cognee_dataset: str
    cognee_ingest_background: bool
    container_backend: str
    container_image: str
    cognee_repo: Path
    hermes_repo: Path

    @property
    def db_path(self) -> Path:
        return self.data_dir / "platform.db"

    @property
    def workspace_dir(self) -> Path:
        return self.data_dir / "workspaces"

    @classmethod
    def from_env(cls, base_dir: Path | None = None) -> "PlatformConfig":
        base = base_dir or Path.cwd()
        data_dir = Path(os.getenv("ENTERPRISE_PLATFORM_DATA", base / "data")).expanduser()
        host = os.getenv("ENTERPRISE_PLATFORM_HOST", "127.0.0.1")
        port = int(os.getenv("ENTERPRISE_PLATFORM_PORT", "8765"))
        default_public = f"http://{host}:{port}"
        token_secret = os.getenv("ENTERPRISE_SESSION_SECRET") or secrets.token_urlsafe(32)
        return cls(
            data_dir=data_dir,
            host=host,
            port=port,
            public_base_url=os.getenv("ENTERPRISE_PUBLIC_BASE_URL", default_public).rstrip("/"),
            token_secret=token_secret,
            token_ttl_seconds=int(os.getenv("ENTERPRISE_SESSION_TTL_SECONDS", str(8 * 60 * 60))),
            agent_tool_token=os.getenv("ENTERPRISE_AGENT_TOOL_TOKEN"),
            agent_mode=os.getenv("ENTERPRISE_AGENT_MODE", "auto").strip().lower() or "auto",
            hermes_api_url=os.getenv(
                "ENTERPRISE_HERMES_API_URL",
                "http://127.0.0.1:8642/v1/chat/completions",
            ),
            hermes_api_key=os.getenv("ENTERPRISE_HERMES_API_KEY", ""),
            hermes_model=os.getenv("ENTERPRISE_HERMES_MODEL", "hermes-agent"),
            hermes_timeout_seconds=float(os.getenv("ENTERPRISE_HERMES_TIMEOUT_SECONDS", "240")),
            knowledge_backend=os.getenv("ENTERPRISE_KB_BACKEND", "hybrid").strip().lower() or "hybrid",
            cognee_dataset=os.getenv("ENTERPRISE_COGNEE_DATASET", "enterprise_knowledge"),
            cognee_ingest_background=os.getenv("ENTERPRISE_COGNEE_INGEST_BACKGROUND", "1").strip().lower()
            in {"1", "true", "yes", "on"},
            container_backend=os.getenv("ENTERPRISE_CONTAINER_BACKEND", "auto").strip().lower() or "auto",
            container_image=os.getenv("ENTERPRISE_CONTAINER_IMAGE", "python:3.11-slim"),
            cognee_repo=Path(os.getenv("ENTERPRISE_COGNEE_REPO", base.parent / "cognee")).expanduser(),
            hermes_repo=Path(os.getenv("ENTERPRISE_HERMES_REPO", base.parent / "hermes-agent")).expanduser(),
        )
