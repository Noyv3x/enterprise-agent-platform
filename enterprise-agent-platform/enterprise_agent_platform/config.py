from __future__ import annotations

import os
import secrets
from dataclasses import dataclass
from pathlib import Path

OAUTH_SECRET_KEYS = (
    "CODEX_OAUTH_ACCESS_TOKEN",
    "CODEX_OAUTH_REFRESH_TOKEN",
    "GROK_OAUTH_ACCESS_TOKEN",
    "GROK_OAUTH_REFRESH_TOKEN",
    "GROK_OAUTH_ID_TOKEN",
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
    knowledge_backend: str
    cognee_dataset: str
    cognee_ingest_background: bool
    cognee_repo: Path
    manage_cognee: bool = True
    runtime_startup_wait_seconds: float = 8.0
    manage_camofox: bool = True
    camofox_url: str = "http://127.0.0.1:9377"
    camofox_command: str = ""
    manage_firecrawl: bool = True
    firecrawl_repo: Path | None = None
    firecrawl_api_url: str = "http://127.0.0.1:3002"
    firecrawl_command: str = ""
    allow_insecure_bootstrap_password: bool = False
    trust_forwarded_headers: bool = False
    telegram_enabled: bool = False
    telegram_bot_token: str = ""
    telegram_bot_username: str = ""
    telegram_webhook_secret: str = ""
    telegram_polling: bool = True
    auto_update_enabled: bool = False
    auto_update_interval_seconds: int = 30
    auto_update_remote: str = "origin"
    auto_update_branch: str = ""
    auto_update_webhook_secret: str = ""
    # Platform-owned Agent runtime.
    manage_agent_runtime: bool = True
    agent_runtime_url: str = "http://127.0.0.1:8766"
    agent_runtime_token: str = ""
    agent_runtime_home: Path | None = None
    agent_runtime_model: str = "gpt-5.5"
    agent_runtime_provider: str = "openai-codex"
    agent_runtime_timeout_seconds: float = 240.0

    @property
    def db_path(self) -> Path:
        return self.data_dir / "platform.db"

    @property
    def workspace_dir(self) -> Path:
        return self.data_dir / "workspaces"

    @property
    def runtime_dir(self) -> Path:
        return self.data_dir / "runtimes"

    @property
    def managed_agent_runtime_home(self) -> Path:
        return (self.agent_runtime_home or self.runtime_dir / "agent").expanduser()

    @property
    def cognee_runtime_dir(self) -> Path:
        return self.runtime_dir / "cognee"

    @property
    def firecrawl_runtime_dir(self) -> Path:
        return self.runtime_dir / "firecrawl"

    @classmethod
    def from_env(cls, base_dir: Path | None = None) -> "PlatformConfig":
        base = base_dir or Path.cwd()
        data_dir = Path(os.getenv("ENTERPRISE_PLATFORM_DATA", base / "data")).expanduser()
        host = os.getenv("ENTERPRISE_PLATFORM_HOST", "127.0.0.1")
        port = _env_int("ENTERPRISE_PLATFORM_PORT", 8765, minimum=1, maximum=65535)
        default_public = f"http://{host}:{port}"
        token_secret = os.getenv("ENTERPRISE_SESSION_SECRET") or secrets.token_urlsafe(32)
        return cls(
            data_dir=data_dir,
            host=host,
            port=port,
            public_base_url=os.getenv("ENTERPRISE_PUBLIC_BASE_URL", default_public).rstrip("/"),
            token_secret=token_secret,
            token_ttl_seconds=_env_int("ENTERPRISE_SESSION_TTL_SECONDS", 8 * 60 * 60, minimum=1),
            agent_tool_token=os.getenv("ENTERPRISE_AGENT_TOOL_TOKEN"),
            knowledge_backend=os.getenv("ENTERPRISE_KB_BACKEND", "hybrid").strip().lower() or "hybrid",
            cognee_dataset=os.getenv("ENTERPRISE_COGNEE_DATASET", "enterprise_knowledge"),
            cognee_ingest_background=os.getenv("ENTERPRISE_COGNEE_INGEST_BACKGROUND", "1").strip().lower()
            in {"1", "true", "yes", "on"},
            cognee_repo=Path(os.getenv("ENTERPRISE_COGNEE_REPO", _default_repo_path(base, "cognee"))).expanduser(),
            manage_cognee=os.getenv("ENTERPRISE_MANAGE_COGNEE", "1").strip().lower()
            in {"1", "true", "yes", "on"},
            runtime_startup_wait_seconds=_env_float("ENTERPRISE_RUNTIME_STARTUP_WAIT_SECONDS", 8.0, minimum=0.0),
            manage_camofox=os.getenv("ENTERPRISE_MANAGE_CAMOFOX", "1").strip().lower()
            in {"1", "true", "yes", "on"},
            camofox_url=os.getenv("ENTERPRISE_CAMOFOX_URL", "http://127.0.0.1:9377").strip().rstrip("/"),
            camofox_command=os.getenv("ENTERPRISE_CAMOFOX_COMMAND", "").strip(),
            manage_firecrawl=os.getenv("ENTERPRISE_MANAGE_FIRECRAWL", "1").strip().lower()
            in {"1", "true", "yes", "on"},
            firecrawl_repo=Path(os.getenv("ENTERPRISE_FIRECRAWL_REPO", _default_repo_path(base, "firecrawl"))).expanduser(),
            firecrawl_api_url=os.getenv("ENTERPRISE_FIRECRAWL_API_URL", "http://127.0.0.1:3002").strip().rstrip("/"),
            firecrawl_command=os.getenv("ENTERPRISE_FIRECRAWL_COMMAND", "").strip(),
            allow_insecure_bootstrap_password=_env_bool("ENTERPRISE_ALLOW_DEFAULT_ADMIN_PASSWORD", False),
            trust_forwarded_headers=_env_bool("ENTERPRISE_TRUSTED_PROXY", False),
            telegram_enabled=_env_bool("ENTERPRISE_TELEGRAM_ENABLED", False),
            telegram_bot_token=os.getenv("ENTERPRISE_TELEGRAM_BOT_TOKEN", "").strip(),
            telegram_bot_username=os.getenv("ENTERPRISE_TELEGRAM_BOT_USERNAME", "").strip().lstrip("@"),
            telegram_webhook_secret=os.getenv("ENTERPRISE_TELEGRAM_WEBHOOK_SECRET", "").strip(),
            telegram_polling=_env_bool("ENTERPRISE_TELEGRAM_POLLING", True),
            auto_update_enabled=_env_bool("ENTERPRISE_AUTO_UPDATE_ENABLED", False),
            auto_update_interval_seconds=_env_int("ENTERPRISE_AUTO_UPDATE_INTERVAL_SECONDS", 30, minimum=5),
            auto_update_remote=os.getenv("ENTERPRISE_AUTO_UPDATE_REMOTE", "origin").strip() or "origin",
            auto_update_branch=os.getenv("ENTERPRISE_AUTO_UPDATE_BRANCH", "").strip(),
            auto_update_webhook_secret=os.getenv("ENTERPRISE_AUTO_UPDATE_WEBHOOK_SECRET", "").strip(),
            manage_agent_runtime=_env_bool("ENTERPRISE_MANAGE_AGENT_RUNTIME", True),
            agent_runtime_url=os.getenv(
                "ENTERPRISE_AGENT_RUNTIME_URL",
                "http://127.0.0.1:8766",
            ).strip().rstrip("/"),
            agent_runtime_token=os.getenv("ENTERPRISE_AGENT_RUNTIME_TOKEN", "").strip(),
            agent_runtime_home=Path(
                os.getenv("ENTERPRISE_AGENT_RUNTIME_HOME", data_dir / "runtimes" / "agent")
            ).expanduser(),
            agent_runtime_model=os.getenv("ENTERPRISE_AGENT_RUNTIME_MODEL", "gpt-5.5").strip() or "gpt-5.5",
            agent_runtime_provider=os.getenv(
                "ENTERPRISE_AGENT_RUNTIME_PROVIDER", "openai-codex"
            ).strip().lower() or "openai-codex",
            agent_runtime_timeout_seconds=_env_float(
                "ENTERPRISE_AGENT_RUNTIME_TIMEOUT_SECONDS", 240.0, minimum=1.0
            ),
        )


def _default_repo_path(base: Path, name: str) -> Path:
    in_base = base / name
    if in_base.exists():
        return in_base
    in_parent = base.parent / name
    if in_parent.exists():
        return in_parent
    return in_base


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(
    name: str,
    default: int,
    *,
    minimum: int | None = None,
    maximum: int | None = None,
) -> int:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw.strip())
    except ValueError as exc:
        raise ValueError(f"Invalid value for {name}: {raw!r} (expected an integer)") from exc
    if minimum is not None and value < minimum:
        raise ValueError(f"Invalid value for {name}: {value} (must be >= {minimum})")
    if maximum is not None and value > maximum:
        raise ValueError(f"Invalid value for {name}: {value} (must be <= {maximum})")
    return value


def _env_float(
    name: str,
    default: float,
    *,
    minimum: float | None = None,
    maximum: float | None = None,
) -> float:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = float(raw.strip())
    except ValueError as exc:
        raise ValueError(f"Invalid value for {name}: {raw!r} (expected a number)") from exc
    if minimum is not None and value < minimum:
        raise ValueError(f"Invalid value for {name}: {value} (must be >= {minimum})")
    if maximum is not None and value > maximum:
        raise ValueError(f"Invalid value for {name}: {value} (must be <= {maximum})")
    return value
