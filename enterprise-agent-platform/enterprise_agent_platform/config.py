from __future__ import annotations

import math
import os
import secrets
from dataclasses import dataclass
from pathlib import Path

from .design_contract_generated import (
    RUN_IDLE_TIMEOUT_DEFAULT_SECONDS,
    RUN_IDLE_TIMEOUT_MAXIMUM_SECONDS,
    RUN_IDLE_TIMEOUT_MINIMUM_SECONDS,
    RUN_IDLE_TIMEOUT_PLATFORM_ENVIRONMENT_VARIABLE,
)
from .technical_profile import (
    SOURCE_TECHNICAL_PROFILE,
    TechnicalProfile,
    select_technical_profile,
)
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
    runtime_startup_wait_seconds: float = 8.0
    camofox_url: str = "http://camofox:9377"
    firecrawl_api_url: str = "http://firecrawl-api:3002"
    # Web search talks directly to the private SearXNG service.
    # Firecrawl remains responsible only for scraping/extracting result pages.
    searxng_api_url: str = "http://searxng:8080"
    searxng_timeout_seconds: float = 20.0
    allow_insecure_bootstrap_password: bool = False
    trust_forwarded_headers: bool = False
    telegram_enabled: bool = False
    telegram_bot_token: str = ""
    telegram_bot_username: str = ""
    telegram_webhook_secret: str = ""
    telegram_polling: bool = True
    agent_runtime_url: str = "http://agent-runtime:8766"
    agent_runtime_token: str = ""
    agent_runtime_model: str = "gpt-5.5"
    agent_runtime_provider: str = "openai-codex"
    agent_runtime_idle_timeout_seconds: float = float(
        RUN_IDLE_TIMEOUT_DEFAULT_SECONDS
    )
    platform_internal_url: str = "http://platform:8765"
    manager_socket: Path | None = None
    manager_token_file: Path | None = None
    host_data_root: Path | None = None
    technical_profile: TechnicalProfile = SOURCE_TECHNICAL_PROFILE

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
    def agent_runtime_data_dir(self) -> Path:
        return self.runtime_dir / "agent"

    @property
    def cognee_runtime_dir(self) -> Path:
        return self.runtime_dir / "cognee"

    @property
    def workspace_internal_directory(self) -> str:
        return self.technical_profile.workspace_internal_directory

    @property
    def session_cookie_name(self) -> str:
        return self.technical_profile.session_cookie_name

    @property
    def health_service(self) -> str:
        return self.technical_profile.health_service

    @property
    def search_health_service(self) -> str:
        return self.technical_profile.search_health_service

    @classmethod
    def from_env(cls, base_dir: Path | None = None) -> "PlatformConfig":
        base = base_dir or Path.cwd()
        profile = select_technical_profile()
        if (
            os.getenv(profile.deployment_mode_environment_variable, "")
            .strip()
            .lower()
            != "container"
        ):
            raise ValueError(
                f"{profile.deployment_mode_environment_variable} must be 'container'"
            )
        manager_socket = Path(
            os.getenv(
                profile.manager_socket_environment_variable,
                str(profile.default_manager_socket),
            )
        ).expanduser()
        manager_token_file = Path(
            os.getenv(
                profile.manager_token_file_environment_variable,
                str(profile.default_manager_token_file),
            )
        ).expanduser()
        if not manager_socket.is_absolute() or not manager_token_file.is_absolute():
            raise ValueError("Manager socket and token file paths must be absolute")
        data_name = profile.environment_variable(
            "ENTERPRISE_PLATFORM_DATA",
            target_name="AGENT_PLATFORM_DATA",
        )
        data_default = profile.default_data_root or (base / "data")
        data_dir = Path(os.getenv(data_name, data_default)).expanduser()
        if profile.is_target:
            exact_data_root = Path(os.path.abspath(os.fspath(data_dir)))
            if exact_data_root != profile.default_data_root:
                raise ValueError(
                    f"{data_name} must be {profile.default_data_root} for the target profile"
                )
            if manager_socket != profile.default_manager_socket:
                raise ValueError(
                    f"{profile.manager_socket_environment_variable} must be "
                    f"{profile.default_manager_socket} for the target profile"
                )
            if manager_token_file != profile.default_manager_token_file:
                raise ValueError(
                    f"{profile.manager_token_file_environment_variable} must be "
                    f"{profile.default_manager_token_file} for the target profile"
                )
        host_data_root_value = os.getenv(
            profile.host_data_root_environment_variable, ""
        ).strip()
        host_data_root = (
            Path(os.path.normpath(host_data_root_value)).expanduser()
            if host_data_root_value
            else None
        )
        if host_data_root is not None and not host_data_root.is_absolute():
            raise ValueError(
                f"{profile.host_data_root_environment_variable} must be absolute"
            )
        host_name = profile.environment_variable(
            "ENTERPRISE_PLATFORM_HOST", target_name="AGENT_PLATFORM_HOST"
        )
        port_name = profile.environment_variable(
            "ENTERPRISE_PLATFORM_PORT", target_name="AGENT_PLATFORM_PORT"
        )
        host = os.getenv(host_name, "127.0.0.1")
        port = _env_int(port_name, 8765, minimum=1, maximum=65535)
        default_public = f"http://{host}:{port}"
        env_name = profile.environment_variable
        session_secret_name = env_name("ENTERPRISE_SESSION_SECRET")
        token_secret = os.getenv(session_secret_name) or secrets.token_urlsafe(32)
        return cls(
            data_dir=data_dir,
            host=host,
            port=port,
            public_base_url=os.getenv(
                env_name("ENTERPRISE_PUBLIC_BASE_URL"), default_public
            ).rstrip("/"),
            token_secret=token_secret,
            token_ttl_seconds=_env_int(
                env_name("ENTERPRISE_SESSION_TTL_SECONDS"),
                8 * 60 * 60,
                minimum=1,
            ),
            agent_tool_token=os.getenv(env_name("ENTERPRISE_AGENT_TOOL_TOKEN")),
            knowledge_backend=os.getenv(
                env_name("ENTERPRISE_KB_BACKEND"), "hybrid"
            ).strip().lower()
            or "hybrid",
            cognee_dataset=os.getenv(
                env_name("ENTERPRISE_COGNEE_DATASET"), "enterprise_knowledge"
            ),
            cognee_ingest_background=os.getenv(
                env_name("ENTERPRISE_COGNEE_INGEST_BACKGROUND"), "1"
            ).strip().lower()
            in {"1", "true", "yes", "on"},
            runtime_startup_wait_seconds=_env_float(
                env_name("ENTERPRISE_RUNTIME_STARTUP_WAIT_SECONDS"),
                8.0,
                minimum=0.0,
            ),
            camofox_url=os.getenv(
                env_name("ENTERPRISE_CAMOFOX_URL"),
                "http://camofox:9377",
            ).strip().rstrip("/"),
            firecrawl_api_url=os.getenv(
                env_name("ENTERPRISE_FIRECRAWL_API_URL"),
                "http://firecrawl-api:3002",
            ).strip().rstrip("/"),
            searxng_api_url=os.getenv(
                env_name("ENTERPRISE_SEARXNG_API_URL"),
                "http://searxng:8080",
            ).strip().rstrip("/"),
            searxng_timeout_seconds=_env_float(
                env_name("ENTERPRISE_SEARXNG_TIMEOUT_SECONDS"),
                20.0,
                minimum=1.0,
                maximum=120.0,
            ),
            allow_insecure_bootstrap_password=_env_bool(
                env_name("ENTERPRISE_ALLOW_DEFAULT_ADMIN_PASSWORD"), False
            ),
            trust_forwarded_headers=_env_bool(
                env_name("ENTERPRISE_TRUSTED_PROXY"), False
            ),
            telegram_enabled=_env_bool(
                env_name("ENTERPRISE_TELEGRAM_ENABLED"), False
            ),
            telegram_bot_token=os.getenv(
                env_name("ENTERPRISE_TELEGRAM_BOT_TOKEN"), ""
            ).strip(),
            telegram_bot_username=os.getenv(
                env_name("ENTERPRISE_TELEGRAM_BOT_USERNAME"), ""
            ).strip().lstrip("@"),
            telegram_webhook_secret=os.getenv(
                env_name("ENTERPRISE_TELEGRAM_WEBHOOK_SECRET"), ""
            ).strip(),
            telegram_polling=_env_bool(
                env_name("ENTERPRISE_TELEGRAM_POLLING"), True
            ),
            agent_runtime_url=os.getenv(
                env_name("ENTERPRISE_AGENT_RUNTIME_URL"),
                "http://agent-runtime:8766",
            ).strip().rstrip("/"),
            agent_runtime_token=os.getenv(
                env_name("ENTERPRISE_AGENT_RUNTIME_TOKEN"), ""
            ).strip(),
            agent_runtime_model=os.getenv(
                env_name("ENTERPRISE_AGENT_RUNTIME_MODEL"), "gpt-5.5"
            ).strip()
            or "gpt-5.5",
            agent_runtime_provider=os.getenv(
                env_name("ENTERPRISE_AGENT_RUNTIME_PROVIDER"), "openai-codex"
            ).strip().lower() or "openai-codex",
            agent_runtime_idle_timeout_seconds=_env_float(
                env_name(RUN_IDLE_TIMEOUT_PLATFORM_ENVIRONMENT_VARIABLE),
                float(RUN_IDLE_TIMEOUT_DEFAULT_SECONDS),
                minimum=float(RUN_IDLE_TIMEOUT_MINIMUM_SECONDS),
                maximum=float(RUN_IDLE_TIMEOUT_MAXIMUM_SECONDS),
            ),
            platform_internal_url=os.getenv(
                env_name("ENTERPRISE_PLATFORM_INTERNAL_URL"),
                "http://platform:8765",
            ).strip().rstrip("/"),
            manager_socket=manager_socket,
            manager_token_file=manager_token_file,
            host_data_root=host_data_root,
            technical_profile=profile,
        )


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
    if not math.isfinite(value):
        raise ValueError(
            f"Invalid value for {name}: {raw!r} (expected a finite number)"
        )
    if minimum is not None and value < minimum:
        raise ValueError(f"Invalid value for {name}: {value} (must be >= {minimum})")
    if maximum is not None and value > maximum:
        raise ValueError(f"Invalid value for {name}: {value} (must be <= {maximum})")
    return value
