from __future__ import annotations

import os
import re
import secrets
import hashlib
import mimetypes
import sys
import threading
import time
import urllib.parse
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Deque

from .auth import TokenSigner, hash_password, verify_password
from .auto_update import AutoUpdateManager
from .cognee_bridge import CogneeBridge
from .config import OAUTH_SECRET_KEYS, PlatformConfig
from .containers import ContainerManager
from .db import Database, decode_json, encode_json, now_ts
from .hermes import AgentClient, AgentResult, AutoAgentClient, is_substantive_tool_start
from .hermes_oauth_bridge import HermesOAuthBridge
from .internal_config import (
    load_hermes_default_config,
    read_cognee_internal_config,
    read_hermes_internal_config,
    update_env_file,
    update_yaml_text,
    update_yaml_values,
)
from .knowledge import KnowledgeBase, format_passive_suggestions
from .oauth_flows import OAuthFlowError, OAuthFlowManager, SUPPORTED_OAUTH_PROVIDERS, oauth_provider_info
from .runtimes import (
    HERMES_SETTING_API_URL,
    HERMES_SETTING_INSTALL_EXTRAS,
    HERMES_SETTING_MANAGED,
    HERMES_SETTING_MODEL,
    HERMES_SETTING_PROVIDER,
    HERMES_SETTING_PROVIDER_BASE_URL,
    HERMES_SETTING_REPO,
    HERMES_SETTING_STARTUP_WAIT,
    HERMES_SETTING_TIMEOUT,
    PlatformRuntimeManager,
    default_base_url_for_provider,
    normalize_hermes_provider,
)


class ServiceError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass(frozen=True)
class UploadedFile:
    filename: str
    content_type: str
    data: bytes


MAX_ATTACHMENTS_PER_MESSAGE = 10
MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
# Cumulative per-uploader storage budget for attachment blobs. Bounds deliberate
# or accidental disk exhaustion by any authenticated chat/private-agent user.
# 0 disables the quota.
ATTACHMENT_QUOTA_BYTES = max(0, int(os.getenv("ENTERPRISE_ATTACHMENT_QUOTA_BYTES", str(2 * 1024 * 1024 * 1024)) or "0"))
# Sliding-window per-user upload rate limit. Caps how many attachment-bearing
# messages a single user can send within the window, providing lightweight
# backpressure against storage floods. Only messages that carry attachments are
# counted, so ordinary chat is unaffected. 0 disables the limiter.
UPLOAD_RATE_LIMIT_WINDOW_SECONDS = max(1, int(os.getenv("ENTERPRISE_UPLOAD_RATE_WINDOW_SECONDS", "60") or "60"))
MAX_UPLOADS_PER_WINDOW = max(0, int(os.getenv("ENTERPRISE_MAX_UPLOADS_PER_WINDOW", "30") or "0"))
MIN_PASSWORD_LENGTH = 8
BOOTSTRAP_ADMIN_PASSWORD_FILE = "bootstrap-admin-password.txt"
LOGIN_FAILURE_WINDOW_SECONDS = 15 * 60
MAX_LOGIN_FAILURES = 8
# A per-account ceiling across all client identities, so a distributed brute
# force (rotating source IPs / X-Forwarded-For) against one username is still
# bounded even though the per-(user, client) limit alone could be evaded.
MAX_LOGIN_FAILURES_PER_USER = 50
# Hard ceiling on the number of distinct keys retained in the in-memory login
# failure maps. Usernames are attacker-controlled even for invalid logins, so
# without this bound a flood of distinct usernames could grow the maps without
# limit. When the cap is exceeded we sweep expired entries and, if still over,
# evict the oldest-by-last-timestamp entries (bounded LRU).
MAX_LOGIN_FAILURE_KEYS = 10_000
# Bound in-memory agent state so a flood of @agent messages or many idle
# conversations cannot grow memory without limit.
MAX_AGENT_QUEUE_DEPTH = 64
MAX_TRACKED_CONVERSATIONS = 1000
HERMES_CHANNEL_SESSION_SETTING_PREFIX = "hermes_session:channel:"
MAX_HERMES_SESSION_ID_LENGTH = 512
# Global ceiling on concurrent in-flight Hermes generations. Each conversation
# still drains its own queue in FIFO order, but only this many replies hit the
# Hermes backend (and hold a thread/socket) at once, providing backpressure so a
# burst of distinct active conversations cannot exhaust threads/sockets or
# overwhelm Hermes.
MAX_CONCURRENT_AGENT_RUNS = max(1, int(os.getenv("ENTERPRISE_MAX_CONCURRENT_AGENT_RUNS", "8") or "8"))
# Cognee ingestion is heavy; it runs on a background worker so document creation
# never blocks the request thread (and, via the DB, every other request).
MAX_INGEST_QUEUE_DEPTH = 256
MAX_TRACKED_INGEST_RESULTS = 1000
# Bounded retry for transient Cognee ingest failures. A failed job is re-queued
# with a short capped backoff up to this many attempts before it is dropped and
# counted as a permanent failure (surfaced in knowledge_status).
MAX_INGEST_ATTEMPTS = max(1, int(os.getenv("ENTERPRISE_INGEST_MAX_ATTEMPTS", "3") or "3"))
INGEST_RETRY_BACKOFF_CAP_SECONDS = 30
SAFE_INLINE_ATTACHMENT_MIME_TYPES = {
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
}
MEDIA_TAG_RE = re.compile(
    r'''[`"']?MEDIA:\s*(?P<path>`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|(?:~/|/)\S+(?:[^\S\n]+\S+)*?\.(?:png|jpe?g|gif|webp|bmp|tiff|svg|mp4|mov|avi|mkv|webm|ogg|opus|mp3|wav|m4a|flac|epub|pdf|zip|rar|7z|docx?|xlsx?|pptx?|txt|md|csv|tsv|json|xml|ya?ml|apk|ipa)(?=[\s`"',;:)\]}]|$))[`"']?''',
    re.IGNORECASE,
)
THINKING_DEPTHS = ("none", "minimal", "low", "medium", "high", "xhigh")
DEFAULT_THINKING_DEPTH = "medium"
AGENT_MENTION_RE = re.compile(r"(?<![\w@])@(agent|main-agent|main_agent|main\s+agent)(?![A-Za-z0-9_-])", re.IGNORECASE)

PERMISSION_READ_WORKSPACE = "read_workspace"
PERMISSION_CHAT = "chat"
PERMISSION_PRIVATE_AGENT = "private_agent"
PERMISSION_MANAGE_CHANNELS = "manage_channels"
PERMISSION_MANAGE_KNOWLEDGE = "manage_knowledge"
PERMISSION_MANAGE_USERS = "manage_users"
PERMISSION_SYSTEM_SETTINGS = "system_settings"

OAUTH_CREDENTIAL_EXPORT_KIND = "enterprise-agent-platform.oauth-credentials"
OAUTH_CREDENTIAL_EXPORT_VERSION = 1
PLATFORM_SETTING_PUBLIC_BASE_URL = "platform_public_base_url"
PLATFORM_SETTING_TRUSTED_PROXY = "platform_trusted_proxy"
PLATFORM_SETTING_HOST = "platform_host"
PLATFORM_SETTING_PORT = "platform_port"
PLATFORM_SETTING_SESSION_TTL = "platform_session_ttl_seconds"
TELEGRAM_SETTING_ENABLED = "telegram_enabled"
TELEGRAM_SETTING_BOT_USERNAME = "telegram_bot_username"
TELEGRAM_SETTING_POLLING = "telegram_polling"
TELEGRAM_SECRET_BOT_TOKEN = "ENTERPRISE_TELEGRAM_BOT_TOKEN"
TELEGRAM_SECRET_WEBHOOK_SECRET = "ENTERPRISE_TELEGRAM_WEBHOOK_SECRET"
AUTO_UPDATE_SETTING_ENABLED = "auto_update_enabled"
AUTO_UPDATE_SETTING_INTERVAL = "auto_update_interval_seconds"
AUTO_UPDATE_SETTING_REMOTE = "auto_update_remote"
AUTO_UPDATE_SETTING_BRANCH = "auto_update_branch"
AUTO_UPDATE_SECRET_WEBHOOK_SECRET = "ENTERPRISE_AUTO_UPDATE_WEBHOOK_SECRET"
OAUTH_PROVIDER_SECRET_KEYS = {
    "openai-codex": ("CODEX_OAUTH_ACCESS_TOKEN", "CODEX_OAUTH_REFRESH_TOKEN"),
    "xai-oauth": ("GROK_OAUTH_ACCESS_TOKEN", "GROK_OAUTH_REFRESH_TOKEN", "GROK_OAUTH_ID_TOKEN"),
}

PERMISSION_GROUPS: dict[str, dict[str, Any]] = {
    "admin": {
        "label": "管理员",
        "description": "管理企业账户、模型配置和平台运行时。",
        "permissions": [
            PERMISSION_READ_WORKSPACE,
            PERMISSION_CHAT,
            PERMISSION_PRIVATE_AGENT,
            PERMISSION_MANAGE_CHANNELS,
            PERMISSION_MANAGE_KNOWLEDGE,
            PERMISSION_MANAGE_USERS,
            PERMISSION_SYSTEM_SETTINGS,
        ],
    },
    "manager": {
        "label": "经理",
        "description": "管理频道和知识库，并使用企业 Agent。",
        "permissions": [
            PERMISSION_READ_WORKSPACE,
            PERMISSION_CHAT,
            PERMISSION_PRIVATE_AGENT,
            PERMISSION_MANAGE_CHANNELS,
            PERMISSION_MANAGE_KNOWLEDGE,
        ],
    },
    "member": {
        "label": "成员",
        "description": "使用频道、知识库和私人 Agent。",
        "permissions": [
            PERMISSION_READ_WORKSPACE,
            PERMISSION_CHAT,
            PERMISSION_PRIVATE_AGENT,
        ],
    },
    "viewer": {
        "label": "只读",
        "description": "只能查看频道消息和企业知识。",
        "permissions": [PERMISSION_READ_WORKSPACE],
    },
}


class EnterpriseService:
    def __init__(
        self,
        config: PlatformConfig,
        agent_client: AgentClient | None = None,
        runtime_process_launcher=None,
        runtime_command_runner=None,
        oauth_http_client=None,
        hermes_bridge=None,
        container_command_runner=None,
        auto_update_runner=None,
        auto_update_launcher=None,
        auto_update_repo_root: Path | None = None,
        autostart_runtime: bool = True,
    ):
        self.config = config
        self.config.data_dir.mkdir(parents=True, exist_ok=True)
        self.db = Database(config.db_path)
        self.tokens = TokenSigner(self._resolve_session_secret(), self._effective_session_ttl_seconds())
        self.knowledge = KnowledgeBase(self.db)
        self.runtimes = PlatformRuntimeManager(
            config,
            self.get_secret,
            process_launcher=runtime_process_launcher,
            command_runner=runtime_command_runner,
            setting_provider=self.get_setting,
        )
        self.cognee = CogneeBridge(config, self.get_secret, self.runtimes)
        self.containers = ContainerManager(config, self.db, runner=container_command_runner)
        self.agent_client = agent_client or AutoAgentClient(config, self.get_secret, self.runtimes)
        self.hermes_bridge = hermes_bridge or HermesOAuthBridge(self.runtimes)
        oauth_flow_bridge = None if oauth_http_client is not None else self.hermes_bridge
        self.oauth_flows = OAuthFlowManager(oauth_http_client, hermes_bridge=oauth_flow_bridge)
        self._conversation_lock = threading.RLock()
        self._agent_queues: dict[str, Deque[dict[str, Any]]] = {}
        self._agent_workers: dict[str, threading.Thread] = {}
        self._agent_status: dict[str, dict[str, Any]] = {}
        self._typing: dict[str, dict[int, dict[str, Any]]] = {}
        # Global backpressure on concurrent in-flight Hermes generations.
        self._agent_run_semaphore = threading.BoundedSemaphore(MAX_CONCURRENT_AGENT_RUNS)
        self._auth_lock = threading.RLock()
        self._login_failures: dict[tuple[str, str], Deque[float]] = {}
        self._login_failures_by_user: dict[str, Deque[float]] = {}
        # Per-user upload timestamps for the sliding-window rate limiter.
        self._upload_rate: dict[int, Deque[float]] = {}
        # Fixed dummy hash so authentication spends a comparable amount of time
        # whether or not the username exists, eliminating a timing oracle.
        self._dummy_password_hash = hash_password(secrets.token_urlsafe(16))
        self._ingest_lock = threading.Lock()
        self._ingest_queue: Deque[dict[str, Any]] = deque()
        self._ingest_thread: threading.Thread | None = None
        self._ingest_results: dict[int, dict[str, Any]] = {}
        # Operator-visible counters for documents that exhausted ingest retries.
        self._ingest_failed_count = 0
        self._ingest_last_error = ""
        # Background reclaimer for idle per-user containers. Disabled (no thread)
        # unless ENTERPRISE_CONTAINER_IDLE_HOURS > 0.
        self._reaper_stop = threading.Event()
        self._reaper_thread: threading.Thread | None = None
        self._telegram_gateway = None
        self._auto_updater = AutoUpdateManager(
            self,
            repo_root=auto_update_repo_root,
            runner=auto_update_runner,
            launcher=auto_update_launcher,
        )
        self._closed = False
        self.ensure_bootstrap()
        self.runtimes.prepare()
        if autostart_runtime and agent_client is None and self.config.agent_mode != "local":
            self.runtimes.ensure_managed_tooling_ready(wait=False)
            self.runtimes.ensure_hermes_ready(wait=False)
        self._start_container_reaper()
        self._start_telegram_gateway()
        self._start_auto_update_listener()

    def _start_container_reaper(self) -> None:
        """Start a daemon thread that periodically reclaims idle per-user
        containers, so a user who simply stops messaging (without being
        deactivated) does not leak a running container. No-op unless
        ENTERPRISE_CONTAINER_IDLE_HOURS > 0; for the local-workspace backend the
        sweep is a cheap query that matches nothing."""
        try:
            idle_hours = float(os.getenv("ENTERPRISE_CONTAINER_IDLE_HOURS", "0") or "0")
        except ValueError:
            idle_hours = 0.0
        if idle_hours <= 0:
            return
        interval = max(300.0, min(idle_hours * 3600.0, 3600.0))

        def _loop() -> None:
            while not self._closed:
                try:
                    self.containers.reap_idle_containers(idle_hours=idle_hours)
                except Exception:
                    pass
                # Wake immediately on shutdown; otherwise sweep on each interval.
                if self._reaper_stop.wait(interval):
                    return

        self._reaper_thread = threading.Thread(target=_loop, name="container-reaper", daemon=True)
        self._reaper_thread.start()

    def close(self) -> None:
        with self._conversation_lock:
            self._closed = True
            workers = list(self._agent_workers.values())
        if self._telegram_gateway is not None:
            self._telegram_gateway.stop()
        self._auto_updater.stop()
        self._reaper_stop.set()
        reaper = self._reaper_thread
        if reaper is not None:
            reaper.join(timeout=2)
        for worker in workers:
            worker.join(timeout=2)
        with self._ingest_lock:
            ingest = self._ingest_thread
        if ingest is not None:
            ingest.join(timeout=2)
        self.runtimes.close()
        self.db.close()

    def _start_telegram_gateway(self) -> None:
        if not self.telegram_enabled() or not self.telegram_bot_token():
            return
        try:
            from .telegram_gateway import TelegramGateway

            self._telegram_gateway = TelegramGateway(self)
            self._telegram_gateway.start()
        except Exception as exc:
            print(f"Failed to start Telegram gateway: {exc}", file=sys.stderr)

    def _restart_telegram_gateway(self) -> None:
        if self._telegram_gateway is not None:
            self._telegram_gateway.stop()
            self._telegram_gateway = None
        self._start_telegram_gateway()

    def _start_auto_update_listener(self) -> None:
        if self.auto_update_enabled():
            self._auto_updater.start()

    def ensure_bootstrap(self) -> None:
        if not self.db.scalar("SELECT COUNT(*) FROM channels"):
            ts = now_ts()
            self.db.execute(
                "INSERT INTO channels(name, description, created_at) VALUES (?, ?, ?)",
                ("general", "Company-wide agent channel", ts),
            )
        if not self.db.scalar("SELECT COUNT(*) FROM users"):
            password, allow_weak = self._bootstrap_admin_password()
            self.create_user(
                username="admin",
                password=password,
                display_name="Administrator",
                role="admin",
                actor=None,
                _allow_weak_password=allow_weak,
            )
        if not self.get_setting("agent_tool_token"):
            token = self.config.agent_tool_token or secrets.token_urlsafe(32)
            self.set_setting("agent_tool_token", token, secret=True)
        if not self.config.hermes_api_key and not self.get_secret("ENTERPRISE_HERMES_API_KEY") and not self.get_secret("API_SERVER_KEY"):
            self.set_setting("API_SERVER_KEY", secrets.token_urlsafe(32), secret=True)

    def _bootstrap_admin_password(self) -> tuple[str, bool]:
        configured = os.getenv("ENTERPRISE_ADMIN_PASSWORD")
        if configured:
            return configured, False
        if self.config.allow_insecure_bootstrap_password:
            return "admin", True

        password_path = self.config.data_dir / BOOTSTRAP_ADMIN_PASSWORD_FILE
        if password_path.exists():
            existing = password_path.read_text(encoding="utf-8").strip()
            if existing:
                return existing, False

        password = secrets.token_urlsafe(24)
        password_path.parent.mkdir(parents=True, exist_ok=True)
        password_path.write_text(password + "\n", encoding="utf-8")
        try:
            password_path.chmod(0o600)
        except OSError:
            pass
        return password, False

    def _resolve_session_secret(self) -> str:
        """Resolve a stable HMAC signing secret for session tokens.

        Precedence: an explicit ``ENTERPRISE_SESSION_SECRET`` env var wins so
        operators can rotate it; otherwise reuse a value previously persisted in
        the settings table; otherwise persist this process's secret so it stays
        stable across restarts. Without persistence, ``config.token_secret``
        falls back to a fresh random value on every boot, which would silently
        invalidate every outstanding session/token each time the service
        restarts (including systemd auto-restarts).
        """
        env_secret = os.getenv("ENTERPRISE_SESSION_SECRET")
        if env_secret:
            return env_secret
        row = self.db.query_one(
            "SELECT value FROM settings WHERE key = ? AND secret = 1",
            ("ENTERPRISE_SESSION_SECRET",),
        )
        if row and row["value"]:
            return str(row["value"])
        secret = self.config.token_secret or secrets.token_urlsafe(32)
        self.set_setting("ENTERPRISE_SESSION_SECRET", secret, secret=True)
        return secret

    def _effective_session_ttl_seconds(self) -> int:
        value = self.get_setting(PLATFORM_SETTING_SESSION_TTL)
        if value:
            try:
                parsed = int(value)
            except (TypeError, ValueError):
                parsed = self.config.token_ttl_seconds
            return max(60, min(parsed, 30 * 24 * 60 * 60))
        return int(self.config.token_ttl_seconds)

    def public_base_url(self) -> str:
        return (self.get_setting(PLATFORM_SETTING_PUBLIC_BASE_URL) or self.config.public_base_url).rstrip("/")

    def trust_forwarded_headers(self) -> bool:
        raw = self.get_setting(PLATFORM_SETTING_TRUSTED_PROXY)
        if raw is not None:
            return parse_bool(raw)
        return bool(self.config.trust_forwarded_headers)

    def platform_security_config(self, actor: dict[str, Any]) -> dict[str, Any]:
        require_admin(actor)
        desired_host = self.get_setting(PLATFORM_SETTING_HOST) or self.config.host
        desired_port = self._desired_platform_port()
        public_base_url = self.public_base_url()
        admin_row = self.db.query_one("SELECT password_hash FROM users WHERE username = ?", ("admin",))
        admin_default_password_active = bool(admin_row and verify_password("admin", str(admin_row["password_hash"])))
        session_secret_row = self.db.query_one(
            "SELECT updated_at FROM settings WHERE key = ? AND secret = 1",
            ("ENTERPRISE_SESSION_SECRET",),
        )
        env_session_secret = bool(os.getenv("ENTERPRISE_SESSION_SECRET"))
        return {
            "config": {
                "public_base_url": public_base_url,
                "secure_cookie_enabled": urllib.parse.urlparse(public_base_url).scheme == "https",
                "trusted_proxy": self.trust_forwarded_headers(),
                "host": desired_host,
                "port": desired_port,
                "applied_host": self.config.host,
                "applied_port": self.config.port,
                "listen_restart_required": desired_host != self.config.host or desired_port != self.config.port,
                "session_ttl_seconds": self._effective_session_ttl_seconds(),
                "session_secret_configured": env_session_secret or bool(session_secret_row),
                "session_secret_source": "env" if env_session_secret else ("stored" if session_secret_row else "generated"),
                "session_secret_updated_at": session_secret_row["updated_at"] if session_secret_row else None,
                "allow_default_admin_password": bool(self.config.allow_insecure_bootstrap_password),
                "admin_default_password_active": admin_default_password_active,
                "bootstrap_password_file_exists": (self.config.data_dir / BOOTSTRAP_ADMIN_PASSWORD_FILE).exists(),
                "bootstrap_password_path": str(self.config.data_dir / BOOTSTRAP_ADMIN_PASSWORD_FILE),
            }
        }

    def update_platform_security_config(self, actor: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
        require_admin(actor)
        restart_required = False
        session_secret_restart_required = False
        if "public_base_url" in body:
            public_base_url = self._validate_public_base_url(str(body.get("public_base_url") or ""))
            self.set_setting(PLATFORM_SETTING_PUBLIC_BASE_URL, public_base_url)
        if "trusted_proxy" in body:
            self.set_setting(PLATFORM_SETTING_TRUSTED_PROXY, "1" if parse_bool(body.get("trusted_proxy")) else "0")
        if "host" in body:
            host = self._validate_listen_host(str(body.get("host") or ""))
            self.set_setting(PLATFORM_SETTING_HOST, host)
            restart_required = restart_required or host != self.config.host
        if "port" in body:
            port = self._validate_listen_port(body.get("port"))
            self.set_setting(PLATFORM_SETTING_PORT, str(port))
            restart_required = restart_required or port != self.config.port
        if "session_ttl_seconds" in body:
            ttl = self._validate_session_ttl(body.get("session_ttl_seconds"))
            self.set_setting(PLATFORM_SETTING_SESSION_TTL, str(ttl))
            self.tokens = TokenSigner(self._resolve_session_secret(), ttl)
        session_secret = str(body.get("session_secret") or "").strip()
        if session_secret:
            if len(session_secret) < 32:
                raise ServiceError(400, "session secret must be at least 32 characters")
            self.set_setting("ENTERPRISE_SESSION_SECRET", session_secret, secret=True)
            session_secret_restart_required = True
            restart_required = True
        result = self.platform_security_config(actor)
        result["restart_required"] = restart_required
        result["session_secret_restart_required"] = session_secret_restart_required
        return result

    def _desired_platform_port(self) -> int:
        value = self.get_setting(PLATFORM_SETTING_PORT)
        if value:
            try:
                return self._validate_listen_port(value)
            except ServiceError:
                return int(self.config.port)
        return int(self.config.port)

    @staticmethod
    def _validate_public_base_url(value: str) -> str:
        url = value.strip().rstrip("/")
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ServiceError(400, "public base URL must be an http(s) URL")
        return url

    @staticmethod
    def _validate_listen_host(value: str) -> str:
        host = value.strip()
        if not host:
            raise ServiceError(400, "listen host is required")
        if len(host) > 253 or any(ch.isspace() for ch in host):
            raise ServiceError(400, "listen host is invalid")
        return host

    @staticmethod
    def _validate_listen_port(value: Any) -> int:
        try:
            port = int(value)
        except (TypeError, ValueError) as exc:
            raise ServiceError(400, "listen port must be an integer") from exc
        if port < 1 or port > 65535:
            raise ServiceError(400, "listen port must be between 1 and 65535")
        return port

    @staticmethod
    def _validate_session_ttl(value: Any) -> int:
        try:
            ttl = int(value)
        except (TypeError, ValueError) as exc:
            raise ServiceError(400, "session TTL must be an integer") from exc
        if ttl < 60 or ttl > 30 * 24 * 60 * 60:
            raise ServiceError(400, "session TTL must be between 60 and 2592000 seconds")
        return ttl

    def create_user(
        self,
        *,
        username: str,
        password: str,
        display_name: str = "",
        role: str = "member",
        position: str = "",
        permission_group: str | None = None,
        model_name: str = "",
        thinking_depth: str = DEFAULT_THINKING_DEPTH,
        actor: dict[str, Any] | None,
        _allow_weak_password: bool = False,
    ) -> dict[str, Any]:
        if actor is not None and actor.get("role") != "admin":
            raise ServiceError(403, "admin role required")
        username = normalize_name(username)
        requested_role = normalize_role(role)
        group = normalize_permission_group(permission_group or ("admin" if requested_role == "admin" else "member"))
        role = role_for_permission_group(group)
        if not password or (len(password) < MIN_PASSWORD_LENGTH and not _allow_weak_password):
            raise ServiceError(400, f"password must be at least {MIN_PASSWORD_LENGTH} characters")
        display = display_name.strip() or username
        position = normalize_position(position)
        model_name = self._validate_account_model_name(model_name)
        thinking_depth = normalize_thinking_depth(thinking_depth)
        ts = now_ts()
        try:
            user_id = self.db.insert(
                """
                INSERT INTO users(
                    username, display_name, password_hash, role, position,
                    permission_group, model_name, thinking_depth, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (username, display, hash_password(password), role, position, group, model_name, thinking_depth, ts),
            )
        except Exception as exc:
            raise ServiceError(409, f"user already exists: {username}") from exc
        return self.get_user(user_id) or {}

    def authenticate(self, username: str, password: str, *, client_id: str = "") -> tuple[str, dict[str, Any]]:
        try:
            clean_username = normalize_name(username)
        except ServiceError as exc:
            self._record_login_failure(str(username).strip().lower()[:80] or "invalid", client_id)
            raise ServiceError(401, "invalid username or password") from exc
        # Per-(user, client) limit blocks a single source brute forcing one
        # account, regardless of whether the supplied password is correct.
        self._check_login_rate_limit(clean_username, client_id)
        user = self.db.query_one(
            "SELECT * FROM users WHERE username = ? AND active = 1",
            (clean_username,),
        )
        # Always run a PBKDF2 verification, even when the user does not exist, so
        # wall-clock time does not reveal whether a username is valid (timing
        # oracle). The dummy result is discarded.
        if user:
            password_ok = verify_password(password, user["password_hash"])
        else:
            verify_password(password, self._dummy_password_hash)
            password_ok = False
        if not password_ok:
            self._record_login_failure(clean_username, client_id)
            # The per-user ceiling only bounds wrong-password attempts; a correct
            # credential is never blocked by it (avoids remote account-lockout
            # DoS). Surface the ceiling as a 429 so a distributed brute force
            # against one account still sees backpressure.
            if self._login_failures_over_user_limit(clean_username):
                raise ServiceError(429, "too many failed login attempts; try again later")
            raise ServiceError(401, "invalid username or password")
        self._clear_login_failures(clean_username, client_id)
        self.db.execute("UPDATE users SET last_login_at = ? WHERE id = ?", (now_ts(), user["id"]))
        public = self.public_user(user)
        return self.tokens.issue(int(user["id"]), int(user.get("token_version") or 1)), public

    def _check_login_rate_limit(self, username: str, client_id: str) -> None:
        key = self._login_failure_key(username, client_id)
        now = time.time()
        with self._auth_lock:
            per_client = self._login_failures.get(key)
            if per_client:
                self._trim_login_failures(per_client, now, self._login_failures, key)
                if len(per_client) >= MAX_LOGIN_FAILURES:
                    raise ServiceError(429, "too many failed login attempts; try again later")

    def _login_failures_over_user_limit(self, username: str) -> bool:
        """Return True when the per-account wrong-password ceiling is reached."""
        user_key = self._login_failure_key(username, "")[0]
        now = time.time()
        with self._auth_lock:
            per_user = self._login_failures_by_user.get(user_key)
            if not per_user:
                return False
            self._trim_login_failures(per_user, now, self._login_failures_by_user, user_key)
            return len(per_user) >= MAX_LOGIN_FAILURES_PER_USER

    def _record_login_failure(self, username: str, client_id: str) -> None:
        key = self._login_failure_key(username, client_id)
        now = time.time()
        with self._auth_lock:
            client_failures = self._login_failures.setdefault(key, deque())
            self._trim_login_failures(client_failures, now)
            client_failures.append(now)
            user_failures = self._login_failures_by_user.setdefault(key[0], deque())
            self._trim_login_failures(user_failures, now)
            user_failures.append(now)
            # Bound the number of distinct keys so attacker-controlled usernames
            # cannot grow the maps without limit (memory-exhaustion DoS).
            self._evict_stale_login_failures_locked(now)

    def _clear_login_failures(self, username: str, client_id: str) -> None:
        key = self._login_failure_key(username, client_id)
        with self._auth_lock:
            self._login_failures.pop(key, None)
            self._login_failures_by_user.pop(key[0], None)

    @staticmethod
    def _trim_login_failures(
        failures: Deque[float],
        now: float,
        parent: dict[Any, Deque[float]] | None = None,
        key: Any = None,
    ) -> None:
        cutoff = now - LOGIN_FAILURE_WINDOW_SECONDS
        while failures and failures[0] < cutoff:
            failures.popleft()
        # Drop the key from its parent map once it has no recent failures left,
        # so emptied entries do not accumulate.
        if parent is not None and not failures:
            parent.pop(key, None)

    def _evict_stale_login_failures_locked(self, now: float) -> None:
        """Bound the login-failure maps. Caller must hold ``_auth_lock``.

        First sweep entries whose newest failure has aged out of the window;
        if a map is still over the key cap, evict the oldest-by-last-timestamp
        entries (bounded LRU).
        """
        cutoff = now - LOGIN_FAILURE_WINDOW_SECONDS
        for store in (self._login_failures, self._login_failures_by_user):
            if len(store) <= MAX_LOGIN_FAILURE_KEYS:
                continue
            for k in [k for k, dq in store.items() if not dq or dq[-1] < cutoff]:
                store.pop(k, None)
            if len(store) <= MAX_LOGIN_FAILURE_KEYS:
                continue
            ordered = sorted(store.items(), key=lambda item: item[1][-1] if item[1] else 0.0)
            for k, _dq in ordered[: len(store) - MAX_LOGIN_FAILURE_KEYS]:
                store.pop(k, None)

    @staticmethod
    def _login_failure_key(username: str, client_id: str) -> tuple[str, str]:
        clean_user = str(username or "unknown").strip().lower()[:80] or "unknown"
        clean_client = str(client_id or "local").strip()[:120] or "local"
        return clean_user, clean_client

    def user_from_token(self, token: str | None) -> dict[str, Any] | None:
        if not token:
            return None
        payload = self.tokens.verify(token)
        if not payload:
            return None
        row = self.db.query_one(
            "SELECT active, token_version FROM users WHERE id = ?",
            (payload.user_id,),
        )
        if not row or not row.get("active"):
            return None
        # Reject tokens minted before a session-invalidating change (password
        # reset, role/permission change, deactivation, explicit revoke).
        if int(row.get("token_version") or 1) != int(payload.version):
            return None
        return self.get_user(payload.user_id)

    def revoke_user_sessions(self, user_id: int) -> None:
        """Invalidate all outstanding session tokens for a user."""
        self.db.execute(
            "UPDATE users SET token_version = token_version + 1 WHERE id = ?",
            (int(user_id),),
        )

    def get_user(self, user_id: int) -> dict[str, Any] | None:
        row = self.db.query_one("SELECT * FROM users WHERE id = ?", (user_id,))
        return self.public_user(row) if row else None

    def list_users(self, actor: dict[str, Any]) -> list[dict[str, Any]]:
        require_admin(actor)
        rows = self.db.query("SELECT * FROM users ORDER BY id")
        return [self.public_user(row) for row in rows]

    def mention_targets(self, actor: dict[str, Any]) -> list[dict[str, Any]]:
        require_permission(actor, PERMISSION_CHAT)
        rows = self.db.query("SELECT id, username, display_name, position FROM users WHERE active = 1 ORDER BY display_name, username")
        targets = [
            {
                "kind": "agent",
                "handle": "agent",
                "label": "Agent",
                "description": "呼叫频道 Agent",
            }
        ]
        for row in rows:
            username = str(row["username"])
            display = str(row["display_name"] or username)
            targets.append(
                {
                    "kind": "user",
                    "id": int(row["id"]),
                    "handle": username,
                    "label": display,
                    "description": str(row["position"] or username),
                }
            )
        return targets

    def list_permission_groups(self, actor: dict[str, Any]) -> list[dict[str, Any]]:
        require_admin(actor)
        return [
            {"id": key, **value}
            for key, value in PERMISSION_GROUPS.items()
        ]

    def update_user(self, actor: dict[str, Any], user_id: int, body: dict[str, Any]) -> dict[str, Any]:
        require_admin(actor)
        current = self.db.query_one("SELECT * FROM users WHERE id = ?", (user_id,))
        if not current:
            raise ServiceError(404, "user not found")

        updates: dict[str, Any] = {}
        if "display_name" in body:
            display_name = str(body.get("display_name", "")).strip()
            updates["display_name"] = display_name or current["username"]
        if "position" in body:
            updates["position"] = normalize_position(str(body.get("position", "")))
        if "permission_group" in body or "role" in body:
            if "permission_group" in body:
                group = normalize_permission_group(str(body.get("permission_group", "")))
            else:
                group = "admin" if normalize_role(str(body.get("role", ""))) == "admin" else "member"
            updates["permission_group"] = group
            updates["role"] = role_for_permission_group(group)
        if "model_name" in body or "model" in body:
            updates["model_name"] = self._validate_account_model_name(
                str(body.get("model_name", body.get("model", "")))
            )
        if "thinking_depth" in body:
            updates["thinking_depth"] = normalize_thinking_depth(str(body.get("thinking_depth", "")))
        if "active" in body:
            updates["active"] = 1 if parse_bool(body.get("active")) else 0
        password = str(body.get("password", "") or "")
        if password:
            if len(password) < MIN_PASSWORD_LENGTH:
                raise ServiceError(400, f"password must be at least {MIN_PASSWORD_LENGTH} characters")
            updates["password_hash"] = hash_password(password)

        updates = _changed_user_updates(current, updates)
        if not updates:
            return self.get_user(user_id) or {}
        self._guard_admin_update(actor, current, updates)
        # Invalidate existing sessions when credentials or privileges change, or
        # when the account is deactivated, so a captured token cannot outlive a
        # password reset or a permission downgrade.
        bump_sessions = (
            "password_hash" in updates
            or "permission_group" in updates
            or "role" in updates
            or updates.get("active") == 0
        )
        assignments = ", ".join(f"{key} = ?" for key in updates)
        if bump_sessions:
            assignments += ", token_version = token_version + 1"
        self.db.execute(
            f"UPDATE users SET {assignments} WHERE id = ?",
            [*updates.values(), user_id],
        )
        return self.get_user(user_id) or {}

    def deactivate_user(self, actor: dict[str, Any], user_id: int) -> dict[str, Any]:
        result = self.update_user(actor, user_id, {"active": False})
        # Reclaim the user's private agent container so a deactivated account
        # does not leave a running/leaked container behind (best-effort; the
        # method swallows backend errors and always clears the private_agents row).
        try:
            self.containers.remove_private_container(int(user_id))
        except Exception:
            pass
        return result

    @staticmethod
    def public_user(row: dict[str, Any]) -> dict[str, Any]:
        group = public_permission_group(row)
        thinking_depth = str(row.get("thinking_depth") or DEFAULT_THINKING_DEPTH).strip().lower()
        if thinking_depth not in THINKING_DEPTHS:
            thinking_depth = DEFAULT_THINKING_DEPTH
        return {
            "id": int(row["id"]),
            "username": row["username"],
            "display_name": row["display_name"],
            "role": row["role"],
            "position": row.get("position", "") or "",
            "permission_group": group,
            "permission_group_label": PERMISSION_GROUPS[group]["label"],
            "permissions": list(PERMISSION_GROUPS[group]["permissions"]),
            "model_name": row.get("model_name", "") or "",
            "thinking_depth": thinking_depth,
            "active": bool(row["active"]),
            "created_at": row["created_at"],
            "last_login_at": row.get("last_login_at"),
        }

    def _guard_admin_update(self, actor: dict[str, Any], current: dict[str, Any], updates: dict[str, Any]) -> None:
        target_id = int(current["id"])
        next_role = str(updates.get("role", current["role"]))
        next_active = bool(updates.get("active", current["active"]))
        if target_id == int(actor["id"]):
            if not next_active:
                raise ServiceError(400, "cannot deactivate your own account")
            if next_role != "admin":
                raise ServiceError(400, "cannot remove your own admin permission")
        if current["role"] == "admin" and (next_role != "admin" or not next_active):
            remaining = self.db.scalar(
                "SELECT COUNT(*) FROM users WHERE id != ? AND role = 'admin' AND active = 1",
                (target_id,),
            )
            if not remaining:
                raise ServiceError(400, "at least one active admin account is required")

    def list_channels(self, actor: dict[str, Any]) -> list[dict[str, Any]]:
        require_permission(actor, PERMISSION_READ_WORKSPACE)
        rows = self.db.query(
            """
            SELECT c.*, (
                SELECT COUNT(*) FROM messages m
                WHERE m.scope_type = 'channel' AND m.scope_id = CAST(c.id AS TEXT)
            ) AS message_count
            FROM channels c
            WHERE archived = 0
            ORDER BY c.id
            """
        )
        return [dict(row) for row in rows]

    def create_channel(self, actor: dict[str, Any], name: str, description: str = "") -> dict[str, Any]:
        require_permission(actor, PERMISSION_MANAGE_CHANNELS)
        clean = normalize_channel_name(name)
        ts = now_ts()
        try:
            channel_id = self.db.insert(
                "INSERT INTO channels(name, description, created_by, created_at) VALUES (?, ?, ?, ?)",
                (clean, description.strip(), actor["id"], ts),
            )
        except Exception as exc:
            raise ServiceError(409, f"channel already exists: {clean}") from exc
        return self.get_channel(actor, channel_id)

    def get_channel(self, actor: dict[str, Any], channel_id: int) -> dict[str, Any]:
        row = self.db.query_one("SELECT * FROM channels WHERE id = ? AND archived = 0", (channel_id,))
        if not row:
            raise ServiceError(404, "channel not found")
        return dict(row)

    def list_messages(self, actor: dict[str, Any], scope_type: str, scope_id: str, limit: int = 100) -> list[dict[str, Any]]:
        # Reads are authorized like any other scope access: channels require
        # read_workspace, private conversations require private_agent and must
        # belong to the actor. (Internal callers use _messages_for_scope.)
        scope_type, scope_id = self._normalize_conversation(actor, scope_type, scope_id)
        return self._messages_for_scope(scope_type, scope_id, limit)

    def _messages_for_scope(self, scope_type: str, scope_id: str, limit: int = 100) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit), 300))
        rows = self.db.query(
            """
            SELECT * FROM messages
            WHERE scope_type = ? AND scope_id = ?
            ORDER BY id DESC
            LIMIT ?
            """,
            (scope_type, str(scope_id), limit),
        )
        return [self._message_from_row(row) for row in reversed(rows)]

    def latest_message_id(self, scope_type: str, scope_id: str) -> int:
        row = self.db.query_one(
            "SELECT MAX(id) AS mid FROM messages WHERE scope_type = ? AND scope_id = ?",
            (scope_type, str(scope_id)),
        )
        return int(row["mid"]) if row and row["mid"] is not None else 0

    def wait_for_agent_message_after(
        self,
        scope_type: str,
        scope_id: str,
        after_id: int,
        *,
        timeout: float = 240.0,
    ) -> dict[str, Any] | None:
        deadline = time.time() + max(0.0, float(timeout))
        scope_id = str(scope_id)
        while True:
            row = self.db.query_one(
                """
                SELECT * FROM messages
                WHERE scope_type = ? AND scope_id = ? AND author_type = 'agent' AND id > ?
                ORDER BY id
                LIMIT 1
                """,
                (scope_type, scope_id, int(after_id)),
            )
            if row:
                return self._message_from_row(row)
            status = self.agent_status_for_system(scope_type, scope_id)
            if status.get("state") == "idle" and time.time() >= deadline:
                return None
            if time.time() >= deadline:
                return None
            time.sleep(0.2)

    def agent_status_for_system(self, scope_type: str, scope_id: str) -> dict[str, Any]:
        key = self._conversation_key(scope_type, str(scope_id))
        with self._conversation_lock:
            return self._copy_status(self._agent_status.get(key) or self._idle_agent_status(scope_type, str(scope_id)))

    def telegram_enabled(self) -> bool:
        raw = self.get_setting(TELEGRAM_SETTING_ENABLED)
        if raw is None:
            return bool(self.config.telegram_enabled)
        return parse_bool(raw)

    def telegram_polling_enabled(self) -> bool:
        raw = self.get_setting(TELEGRAM_SETTING_POLLING)
        if raw is None:
            return bool(self.config.telegram_polling)
        return parse_bool(raw)

    def telegram_bot_token(self) -> str:
        return self.get_secret(TELEGRAM_SECRET_BOT_TOKEN) or self.config.telegram_bot_token

    def telegram_bot_username(self) -> str:
        return (self.get_setting(TELEGRAM_SETTING_BOT_USERNAME) or self.config.telegram_bot_username or "").strip().lstrip("@")

    def telegram_webhook_secret(self) -> str:
        return self.get_secret(TELEGRAM_SECRET_WEBHOOK_SECRET) or self.config.telegram_webhook_secret

    def telegram_gateway_update(self, update: dict[str, Any]) -> dict[str, Any]:
        from .telegram_gateway import TelegramGateway

        return TelegramGateway(self, autostart=False).process_update(update)

    def telegram_actor_for_user(self, telegram_user: dict[str, Any]) -> dict[str, Any]:
        external_id = str(telegram_user.get("id") or "").strip()
        if not external_id:
            raise ServiceError(400, "Telegram user id is required")
        row = self.db.query_one(
            "SELECT user_id FROM external_identities WHERE provider = 'telegram' AND external_id = ?",
            (external_id,),
        )
        if row:
            user = self.get_user(int(row["user_id"]))
            if user and user.get("active"):
                self._refresh_telegram_identity(int(user["id"]), external_id, telegram_user)
                return user
        raise ServiceError(403, "Telegram user is not linked to a platform account")

    def telegram_private_config(self, actor: dict[str, Any]) -> dict[str, Any]:
        require_permission(actor, PERMISSION_PRIVATE_AGENT)
        identity = self.db.query_one(
            """
            SELECT external_id, username, display_name, updated_at
            FROM external_identities
            WHERE provider = 'telegram' AND user_id = ?
            """,
            (int(actor["id"]),),
        )
        return {
            "gateway": self.telegram_public_config(),
            "link": {
                "telegram_user_id": identity["external_id"] if identity else "",
                "telegram_username": identity["username"] if identity else "",
                "telegram_display_name": identity["display_name"] if identity else "",
                "updated_at": identity["updated_at"] if identity else None,
            },
        }

    def update_telegram_private_config(self, actor: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
        require_permission(actor, PERMISSION_PRIVATE_AGENT)
        external_id = self._validate_telegram_user_id(body.get("telegram_user_id"))
        conflict = self.db.query_one(
            """
            SELECT user_id FROM external_identities
            WHERE provider = 'telegram' AND external_id = ? AND user_id != ?
            """,
            (external_id, int(actor["id"])),
        )
        if conflict:
            raise ServiceError(409, "Telegram user id is already linked to another account")
        ts = now_ts()
        existing = self.db.query_one(
            "SELECT created_at FROM external_identities WHERE provider = 'telegram' AND user_id = ?",
            (int(actor["id"]),),
        )
        self.db.execute(
            "DELETE FROM external_identities WHERE provider = 'telegram' AND user_id = ?",
            (int(actor["id"]),),
        )
        self.db.execute(
            """
            INSERT INTO external_identities(
                provider, external_id, user_id, username, display_name, metadata_json, created_at, updated_at
            )
            VALUES ('telegram', ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                external_id,
                int(actor["id"]),
                str(body.get("telegram_username") or "").strip().lstrip("@")[:80],
                str(body.get("telegram_display_name") or "").strip()[:120],
                encode_json({"configured_by": "user"}),
                int(existing["created_at"]) if existing else ts,
                ts,
            ),
        )
        return self.telegram_private_config(actor)

    def unlink_telegram_private_config(self, actor: dict[str, Any]) -> dict[str, Any]:
        require_permission(actor, PERMISSION_PRIVATE_AGENT)
        self.db.execute(
            "DELETE FROM external_identities WHERE provider = 'telegram' AND user_id = ?",
            (int(actor["id"]),),
        )
        return self.telegram_private_config(actor)

    def telegram_public_config(self) -> dict[str, Any]:
        return {
            "enabled": self.telegram_enabled(),
            "bot_username": self.telegram_bot_username(),
            "polling": self.telegram_polling_enabled(),
            "bot_token_configured": bool(self.telegram_bot_token()),
            "webhook_secret_configured": bool(self.telegram_webhook_secret()),
            "webhook_url": self.telegram_webhook_url(),
        }

    def telegram_webhook_url(self) -> str:
        secret = self.telegram_webhook_secret()
        if not secret:
            return ""
        return f"{self.public_base_url()}/api/telegram/webhook/{urllib.parse.quote(secret, safe='')}"

    def telegram_admin_config(self, actor: dict[str, Any]) -> dict[str, Any]:
        require_admin(actor)
        linked_rows = self.db.query(
            """
            SELECT e.external_id, e.username AS telegram_username, e.display_name AS telegram_display_name,
                   e.updated_at, u.id AS user_id, u.username, u.display_name
            FROM external_identities e
            JOIN users u ON u.id = e.user_id
            WHERE e.provider = 'telegram'
            ORDER BY u.display_name, u.username
            """
        )
        return {"config": self.telegram_public_config(), "linked_users": linked_rows}

    def update_telegram_admin_config(self, actor: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
        require_admin(actor)
        if "enabled" in body:
            self.set_setting(TELEGRAM_SETTING_ENABLED, "1" if parse_bool(body.get("enabled")) else "0")
        if "polling" in body:
            self.set_setting(TELEGRAM_SETTING_POLLING, "1" if parse_bool(body.get("polling")) else "0")
        if "bot_username" in body:
            username = str(body.get("bot_username") or "").strip().lstrip("@")
            if username and not re.fullmatch(r"[A-Za-z0-9_]{3,80}", username):
                raise ServiceError(400, "Telegram bot username is invalid")
            self.set_setting(TELEGRAM_SETTING_BOT_USERNAME, username)
        if "bot_token" in body:
            token = str(body.get("bot_token") or "").strip()
            if token:
                self.set_setting(TELEGRAM_SECRET_BOT_TOKEN, token, secret=True)
        if "webhook_secret" in body:
            secret = str(body.get("webhook_secret") or "").strip()
            if secret:
                if not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", secret):
                    raise ServiceError(400, "Telegram webhook secret must be 8-128 URL-safe characters")
                self.set_setting(TELEGRAM_SECRET_WEBHOOK_SECRET, secret, secret=True)
        self._restart_telegram_gateway()
        return self.telegram_admin_config(actor)

    def auto_update_enabled(self) -> bool:
        raw = self.get_setting(AUTO_UPDATE_SETTING_ENABLED)
        if raw is None:
            return bool(self.config.auto_update_enabled)
        return parse_bool(raw)

    def auto_update_interval_seconds(self) -> int:
        raw = self.get_setting(AUTO_UPDATE_SETTING_INTERVAL)
        value = self.config.auto_update_interval_seconds
        if raw:
            try:
                value = int(raw)
            except (TypeError, ValueError):
                value = self.config.auto_update_interval_seconds
        return max(5, min(int(value), 3600))

    def auto_update_remote(self) -> str:
        return (self.get_setting(AUTO_UPDATE_SETTING_REMOTE) or self.config.auto_update_remote or "origin").strip() or "origin"

    def auto_update_branch(self) -> str:
        return (self.get_setting(AUTO_UPDATE_SETTING_BRANCH) or self.config.auto_update_branch or "").strip()

    def auto_update_webhook_secret(self) -> str:
        return self.get_secret(AUTO_UPDATE_SECRET_WEBHOOK_SECRET) or self.config.auto_update_webhook_secret

    def auto_update_webhook_url(self) -> str:
        secret = self.auto_update_webhook_secret()
        if not secret:
            return ""
        return f"{self.public_base_url()}/api/auto-update/webhook/{urllib.parse.quote(secret, safe='')}"

    def auto_update_config(self, actor: dict[str, Any]) -> dict[str, Any]:
        require_admin(actor)
        return {
            "config": {
                "enabled": self.auto_update_enabled(),
                "interval_seconds": self.auto_update_interval_seconds(),
                "remote": self.auto_update_remote(),
                "branch": self.auto_update_branch(),
                "webhook_secret_configured": bool(self.auto_update_webhook_secret()),
                "webhook_url": self.auto_update_webhook_url(),
            },
            "status": self._auto_updater.status(),
        }

    def update_auto_update_config(self, actor: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
        require_admin(actor)
        if "enabled" in body:
            self.set_setting(AUTO_UPDATE_SETTING_ENABLED, "1" if parse_bool(body.get("enabled")) else "0")
        if "interval_seconds" in body:
            try:
                interval = int(body.get("interval_seconds"))
            except (TypeError, ValueError) as exc:
                raise ServiceError(400, "auto update interval must be an integer") from exc
            if interval < 5 or interval > 3600:
                raise ServiceError(400, "auto update interval must be between 5 and 3600 seconds")
            self.set_setting(AUTO_UPDATE_SETTING_INTERVAL, str(interval))
        if "remote" in body:
            self.set_setting(AUTO_UPDATE_SETTING_REMOTE, self._validate_auto_update_git_name(str(body.get("remote") or "origin"), "remote"))
        if "branch" in body:
            branch = str(body.get("branch") or "").strip()
            if branch:
                branch = self._validate_auto_update_git_name(branch, "branch")
            self.set_setting(AUTO_UPDATE_SETTING_BRANCH, branch)
        if "webhook_secret" in body:
            secret = str(body.get("webhook_secret") or "").strip()
            if secret:
                self.set_setting(AUTO_UPDATE_SECRET_WEBHOOK_SECRET, self._validate_auto_update_secret(secret), secret=True)
        if self.auto_update_enabled() and not self.auto_update_webhook_secret():
            self.set_setting(AUTO_UPDATE_SECRET_WEBHOOK_SECRET, secrets.token_urlsafe(32), secret=True)
        if self.auto_update_enabled():
            self._auto_updater.start()
            self._auto_updater.trigger("config")
        else:
            self._auto_updater.stop()
        return self.auto_update_config(actor)

    def trigger_auto_update_check(self, actor: dict[str, Any]) -> dict[str, Any]:
        require_admin(actor)
        if not self.auto_update_enabled():
            return {"accepted": False, "reason": "auto update is disabled", "status": self._auto_updater.status()}
        return {"accepted": True, "status": self._auto_updater.trigger("manual")}

    def auto_update_webhook(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.auto_update_enabled():
            return {"accepted": False, "reason": "auto update is disabled", "status": self._auto_updater.status()}
        ref = str(payload.get("ref") or "").strip()
        branch = self.auto_update_branch()
        if ref.startswith("refs/heads/") and branch and ref.removeprefix("refs/heads/") != branch:
            return {"accepted": False, "reason": f"ignored ref {ref}", "status": self._auto_updater.status()}
        return {"accepted": True, "status": self._auto_updater.trigger("webhook")}

    @staticmethod
    def _validate_auto_update_git_name(value: str, label: str) -> str:
        clean = value.strip()
        if not clean or not re.fullmatch(r"[A-Za-z0-9._/-]{1,120}", clean) or clean.startswith("-") or ".." in clean:
            raise ServiceError(400, f"auto update {label} is invalid")
        return clean

    @staticmethod
    def _validate_auto_update_secret(value: str) -> str:
        clean = value.strip()
        if len(clean) < 16 or len(clean) > 160 or any(ch.isspace() for ch in clean):
            raise ServiceError(400, "auto update webhook secret must be 16-160 non-space characters")
        return clean

    @staticmethod
    def _validate_telegram_user_id(value: Any) -> str:
        clean = str(value or "").strip()
        if not re.fullmatch(r"[1-9][0-9]{4,20}", clean):
            raise ServiceError(400, "Telegram user id must be a numeric id")
        return clean

    def _refresh_telegram_identity(self, user_id: int, external_id: str, telegram_user: dict[str, Any]) -> None:
        ts = now_ts()
        self.db.execute(
            """
            INSERT OR REPLACE INTO external_identities(
                provider, external_id, user_id, username, display_name, metadata_json, created_at, updated_at
            )
            VALUES (
                'telegram', ?, ?, ?, ?, ?,
                COALESCE((SELECT created_at FROM external_identities WHERE provider = 'telegram' AND external_id = ?), ?),
                ?
            )
            """,
            (
                external_id,
                int(user_id),
                str(telegram_user.get("username") or ""),
                self._telegram_display_name(telegram_user),
                encode_json({"user": telegram_user}),
                external_id,
                ts,
                ts,
            ),
        )

    @staticmethod
    def _telegram_display_name(telegram_user: dict[str, Any]) -> str:
        first = str(telegram_user.get("first_name") or "").strip()
        last = str(telegram_user.get("last_name") or "").strip()
        username = str(telegram_user.get("username") or "").strip()
        return " ".join(part for part in (first, last) if part).strip() or username or f"Telegram {telegram_user.get('id')}"

    def audit_channel_messages(self, actor: dict[str, Any], channel_id: int, limit: int = 200) -> dict[str, Any]:
        require_admin(actor)
        channel = self.get_channel(actor, channel_id)
        limit = max(1, min(int(limit), 500))
        scope_id = str(channel_id)
        total = self.db.scalar(
            "SELECT COUNT(*) FROM messages WHERE scope_type = 'channel' AND scope_id = ?",
            (scope_id,),
        )
        rows = self.db.query(
            """
            SELECT * FROM messages
            WHERE scope_type = 'channel' AND scope_id = ?
            ORDER BY id DESC
            LIMIT ?
            """,
            (scope_id, limit),
        )
        return {
            "channel": channel,
            "messages": [self._message_from_row(row) for row in reversed(rows)],
            "total": int(total or 0),
        }

    def delete_channel_message(self, actor: dict[str, Any], channel_id: int, message_id: int) -> dict[str, Any]:
        require_admin(actor)
        self.get_channel(actor, channel_id)
        row = self.db.query_one(
            """
            SELECT * FROM messages
            WHERE id = ? AND scope_type = 'channel' AND scope_id = ?
            """,
            (int(message_id), str(channel_id)),
        )
        if not row:
            raise ServiceError(404, "channel message not found")
        message = self._message_from_row(row)
        self._delete_attachment_files_for_messages([int(message_id)])
        self.db.execute("DELETE FROM messages WHERE id = ?", (int(message_id),))
        return {"deleted": 1, "message": message}

    def delete_channel_messages_before(self, actor: dict[str, Any], channel_id: int, before_created_at: int) -> dict[str, Any]:
        require_admin(actor)
        self.get_channel(actor, channel_id)
        try:
            before_ts = int(before_created_at)
        except (TypeError, ValueError) as exc:
            raise ServiceError(400, "before_created_at must be a unix timestamp") from exc
        if before_ts <= 0:
            raise ServiceError(400, "before_created_at must be a unix timestamp")
        scope_id = str(channel_id)
        deleted = self.db.scalar(
            """
            SELECT COUNT(*) FROM messages
            WHERE scope_type = 'channel' AND scope_id = ? AND created_at < ?
            """,
            (scope_id, before_ts),
        )
        rows = self.db.query(
            """
            SELECT id FROM messages
            WHERE scope_type = 'channel' AND scope_id = ? AND created_at < ?
            """,
            (scope_id, before_ts),
        )
        self._delete_attachment_files_for_messages([int(row["id"]) for row in rows])
        self.db.execute(
            """
            DELETE FROM messages
            WHERE scope_type = 'channel' AND scope_id = ? AND created_at < ?
            """,
            (scope_id, before_ts),
        )
        return {"deleted": int(deleted or 0), "before_created_at": before_ts}

    def clear_channel_messages(self, actor: dict[str, Any], channel_id: int) -> dict[str, Any]:
        require_admin(actor)
        self.get_channel(actor, channel_id)
        scope_id = str(channel_id)
        deleted = self.db.scalar(
            "SELECT COUNT(*) FROM messages WHERE scope_type = 'channel' AND scope_id = ?",
            (scope_id,),
        )
        rows = self.db.query(
            "SELECT id FROM messages WHERE scope_type = 'channel' AND scope_id = ?",
            (scope_id,),
        )
        self._delete_attachment_files_for_messages([int(row["id"]) for row in rows])
        self.db.execute(
            "DELETE FROM messages WHERE scope_type = 'channel' AND scope_id = ?",
            (scope_id,),
        )
        return {"deleted": int(deleted or 0)}

    def list_private_conversation_audits(self, actor: dict[str, Any]) -> list[dict[str, Any]]:
        require_admin(actor)
        rows = self.db.query(
            """
            SELECT
                u.*,
                COALESCE(stats.message_count, 0) AS message_count,
                COALESCE(stats.user_message_count, 0) AS user_message_count,
                COALESCE(stats.agent_message_count, 0) AS agent_message_count,
                stats.first_message_at AS first_message_at,
                stats.last_message_at AS last_message_at
            FROM users u
            LEFT JOIN (
                SELECT
                    scope_id,
                    COUNT(*) AS message_count,
                    SUM(CASE WHEN author_type = 'user' THEN 1 ELSE 0 END) AS user_message_count,
                    SUM(CASE WHEN author_type = 'agent' THEN 1 ELSE 0 END) AS agent_message_count,
                    MIN(created_at) AS first_message_at,
                    MAX(created_at) AS last_message_at
                FROM messages
                WHERE scope_type = 'private'
                GROUP BY scope_id
            ) stats ON stats.scope_id = CAST(u.id AS TEXT)
            ORDER BY
                CASE WHEN stats.last_message_at IS NULL THEN 1 ELSE 0 END,
                stats.last_message_at DESC,
                u.id
            """
        )
        conversations = []
        for row in rows:
            user = self.public_user(row)
            conversations.append(
                {
                    "user": user,
                    "user_id": user["id"],
                    "username": user["username"],
                    "display_name": user["display_name"],
                    "active": user["active"],
                    "message_count": int(row.get("message_count") or 0),
                    "user_message_count": int(row.get("user_message_count") or 0),
                    "agent_message_count": int(row.get("agent_message_count") or 0),
                    "first_message_at": row.get("first_message_at"),
                    "last_message_at": row.get("last_message_at"),
                }
            )
        return conversations

    def audit_private_messages(self, actor: dict[str, Any], user_id: int, limit: int = 200) -> dict[str, Any]:
        require_admin(actor)
        subject = self._private_audit_subject(user_id)
        limit = max(1, min(int(limit), 500))
        scope_id = str(int(subject["id"]))
        total = self.db.scalar(
            "SELECT COUNT(*) FROM messages WHERE scope_type = 'private' AND scope_id = ?",
            (scope_id,),
        )
        rows = self.db.query(
            """
            SELECT * FROM messages
            WHERE scope_type = 'private' AND scope_id = ?
            ORDER BY id DESC
            LIMIT ?
            """,
            (scope_id, limit),
        )
        return {
            "subject": self.public_user(subject),
            "messages": [self._message_from_row(row) for row in reversed(rows)],
            "total": int(total or 0),
        }

    def delete_private_message(self, actor: dict[str, Any], user_id: int, message_id: int) -> dict[str, Any]:
        require_admin(actor)
        subject = self._private_audit_subject(user_id)
        row = self.db.query_one(
            """
            SELECT * FROM messages
            WHERE id = ? AND scope_type = 'private' AND scope_id = ?
            """,
            (int(message_id), str(int(subject["id"]))),
        )
        if not row:
            raise ServiceError(404, "private message not found")
        message = self._message_from_row(row)
        self._delete_attachment_files_for_messages([int(message_id)])
        self.db.execute("DELETE FROM messages WHERE id = ?", (int(message_id),))
        return {"deleted": 1, "message": message}

    def delete_private_messages_before(self, actor: dict[str, Any], user_id: int, before_created_at: int) -> dict[str, Any]:
        require_admin(actor)
        subject = self._private_audit_subject(user_id)
        try:
            before_ts = int(before_created_at)
        except (TypeError, ValueError) as exc:
            raise ServiceError(400, "before_created_at must be a unix timestamp") from exc
        if before_ts <= 0:
            raise ServiceError(400, "before_created_at must be a unix timestamp")
        scope_id = str(int(subject["id"]))
        deleted = self.db.scalar(
            """
            SELECT COUNT(*) FROM messages
            WHERE scope_type = 'private' AND scope_id = ? AND created_at < ?
            """,
            (scope_id, before_ts),
        )
        rows = self.db.query(
            """
            SELECT id FROM messages
            WHERE scope_type = 'private' AND scope_id = ? AND created_at < ?
            """,
            (scope_id, before_ts),
        )
        self._delete_attachment_files_for_messages([int(row["id"]) for row in rows])
        self.db.execute(
            """
            DELETE FROM messages
            WHERE scope_type = 'private' AND scope_id = ? AND created_at < ?
            """,
            (scope_id, before_ts),
        )
        return {"deleted": int(deleted or 0), "before_created_at": before_ts}

    def clear_private_messages(self, actor: dict[str, Any], user_id: int) -> dict[str, Any]:
        require_admin(actor)
        subject = self._private_audit_subject(user_id)
        scope_id = str(int(subject["id"]))
        deleted = self.db.scalar(
            "SELECT COUNT(*) FROM messages WHERE scope_type = 'private' AND scope_id = ?",
            (scope_id,),
        )
        rows = self.db.query(
            "SELECT id FROM messages WHERE scope_type = 'private' AND scope_id = ?",
            (scope_id,),
        )
        self._delete_attachment_files_for_messages([int(row["id"]) for row in rows])
        self.db.execute(
            "DELETE FROM messages WHERE scope_type = 'private' AND scope_id = ?",
            (scope_id,),
        )
        return {"deleted": int(deleted or 0)}

    def _private_audit_subject(self, user_id: int) -> dict[str, Any]:
        subject = self.db.query_one("SELECT * FROM users WHERE id = ?", (int(user_id),))
        if not subject:
            raise ServiceError(404, "user not found")
        return subject

    def token_usage_report(self, actor: dict[str, Any], days: int = 30, limit: int = 200) -> dict[str, Any]:
        require_admin(actor)
        try:
            clean_days = int(days)
        except (TypeError, ValueError):
            clean_days = 30
        clean_days = max(1, min(clean_days, 3650))
        try:
            clean_limit = int(limit)
        except (TypeError, ValueError):
            clean_limit = 200
        clean_limit = max(10, min(clean_limit, 1000))
        until = now_ts()
        since = until - clean_days * 24 * 60 * 60
        today_start = self._token_usage_day_start(until)
        seven_day_start = self._token_usage_day_start(until, offset_days=-6)
        params = (since,)
        summary_row = self.db.query_one(
            """
            SELECT
                COUNT(*) AS event_count,
                COUNT(DISTINCT user_id) AS account_count,
                SUM(CASE WHEN scope_type = 'private' THEN 1 ELSE 0 END) AS private_event_count,
                SUM(CASE WHEN scope_type = 'channel' THEN 1 ELSE 0 END) AS channel_event_count,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(total_tokens), 0) AS total_tokens,
                MAX(created_at) AS last_used_at
            FROM token_usage_events
            WHERE created_at >= ?
            """,
            params,
        ) or {}
        by_account = self.db.query(
            """
            SELECT
                u.id AS user_id,
                u.username,
                u.display_name,
                u.active,
                COALESCE(stats.event_count, 0) AS event_count,
                COALESCE(stats.input_tokens, 0) AS input_tokens,
                COALESCE(stats.output_tokens, 0) AS output_tokens,
                COALESCE(stats.total_tokens, 0) AS total_tokens,
                stats.last_used_at AS last_used_at
            FROM users u
            LEFT JOIN (
                SELECT
                    user_id,
                    COUNT(*) AS event_count,
                    COALESCE(SUM(input_tokens), 0) AS input_tokens,
                    COALESCE(SUM(output_tokens), 0) AS output_tokens,
                    COALESCE(SUM(total_tokens), 0) AS total_tokens,
                    MAX(created_at) AS last_used_at
                FROM token_usage_events
                WHERE created_at >= ?
                GROUP BY user_id
            ) stats ON stats.user_id = u.id
            ORDER BY total_tokens DESC, event_count DESC, last_used_at DESC
            LIMIT ?
            """,
            (since, clean_limit),
        )
        by_scope = self.db.query(
            """
            SELECT
                scope_type,
                scope_id,
                scope_name,
                COUNT(*) AS event_count,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(total_tokens), 0) AS total_tokens,
                MAX(created_at) AS last_used_at
            FROM token_usage_events
            WHERE created_at >= ?
            GROUP BY scope_type, scope_id, scope_name
            ORDER BY total_tokens DESC, event_count DESC, last_used_at DESC
            LIMIT ?
            """,
            (since, clean_limit),
        )
        by_model = self.db.query(
            """
            SELECT
                provider,
                model,
                COUNT(*) AS event_count,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(total_tokens), 0) AS total_tokens,
                MAX(created_at) AS last_used_at
            FROM token_usage_events
            WHERE created_at >= ?
            GROUP BY provider, model
            ORDER BY total_tokens DESC, event_count DESC, last_used_at DESC
            LIMIT ?
            """,
            (since, clean_limit),
        )
        details = self.db.query(
            """
            SELECT
                e.user_id,
                COALESCE(MAX(u.username), MAX(e.username), '') AS username,
                COALESCE(MAX(u.display_name), MAX(e.display_name), MAX(e.username), '') AS display_name,
                e.scope_type,
                e.scope_id,
                e.scope_name,
                e.provider,
                e.model,
                COUNT(*) AS event_count,
                COALESCE(SUM(e.input_tokens), 0) AS input_tokens,
                COALESCE(SUM(e.output_tokens), 0) AS output_tokens,
                COALESCE(SUM(e.total_tokens), 0) AS total_tokens,
                MAX(e.created_at) AS last_used_at
            FROM token_usage_events e
            LEFT JOIN users u ON u.id = e.user_id
            WHERE e.created_at >= ?
            GROUP BY e.user_id, e.scope_type, e.scope_id, e.scope_name, e.provider, e.model
            ORDER BY total_tokens DESC, event_count DESC, last_used_at DESC
            LIMIT ?
            """,
            (since, clean_limit),
        )
        recent = self.db.query(
            """
            SELECT
                e.*,
                COALESCE(u.username, e.username, '') AS current_username,
                COALESCE(u.display_name, e.display_name, e.username, '') AS current_display_name
            FROM token_usage_events e
            LEFT JOIN users u ON u.id = e.user_id
            WHERE e.created_at >= ?
            ORDER BY e.id DESC
            LIMIT ?
            """,
            (since, min(clean_limit, 100)),
        )
        return {
            "window": {"days": clean_days, "since": since, "until": until},
            "summary": self._token_usage_summary_from_row(summary_row),
            "today": self._token_usage_summary_between(today_start, until),
            "last_7_days": self._token_usage_summary_between(seven_day_start, until),
            "daily_usage": self._token_usage_daily_series(until),
            "by_account": [self._token_usage_aggregate_row(row) for row in by_account],
            "by_scope": [self._token_usage_aggregate_row(row) for row in by_scope],
            "by_model": [self._token_usage_aggregate_row(row) for row in by_model],
            "details": [self._token_usage_aggregate_row(row) for row in details],
            "recent": [self._token_usage_event_row(row) for row in recent],
        }

    def _token_usage_summary_between(self, since: int, until: int) -> dict[str, Any]:
        row = self.db.query_one(
            """
            SELECT
                COUNT(*) AS event_count,
                COUNT(DISTINCT user_id) AS account_count,
                SUM(CASE WHEN scope_type = 'private' THEN 1 ELSE 0 END) AS private_event_count,
                SUM(CASE WHEN scope_type = 'channel' THEN 1 ELSE 0 END) AS channel_event_count,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(total_tokens), 0) AS total_tokens,
                MAX(created_at) AS last_used_at
            FROM token_usage_events
            WHERE created_at >= ? AND created_at <= ?
            """,
            (int(since), int(until)),
        ) or {}
        return self._token_usage_summary_from_row(row)

    def _token_usage_daily_series(self, until: int) -> list[dict[str, Any]]:
        day_starts = [self._token_usage_day_start(until, offset_days=offset) for offset in range(-6, 1)]
        if not day_starts:
            return []
        buckets: dict[int, dict[str, Any]] = {}
        account_sets: dict[int, set[int]] = {}
        for start_at in day_starts:
            next_start = self._token_usage_day_start(start_at, offset_days=1)
            end_at = min(int(until), next_start - 1)
            buckets[start_at] = {
                "date": time.strftime("%Y-%m-%d", time.localtime(start_at)),
                "label": time.strftime("%m/%d", time.localtime(start_at)),
                "start_at": int(start_at),
                "end_at": int(max(start_at, end_at)),
                "event_count": 0,
                "account_count": 0,
                "input_tokens": 0,
                "output_tokens": 0,
                "total_tokens": 0,
            }
            account_sets[start_at] = set()

        rows = self.db.query(
            """
            SELECT user_id, created_at, input_tokens, output_tokens, total_tokens
            FROM token_usage_events
            WHERE created_at >= ? AND created_at <= ?
            """,
            (day_starts[0], int(until)),
        )
        for row in rows:
            created_at = int(row.get("created_at") or 0)
            day_start = self._token_usage_day_start(created_at)
            bucket = buckets.get(day_start)
            if bucket is None:
                continue
            bucket["event_count"] += 1
            if row.get("user_id") is not None:
                account_sets[day_start].add(int(row["user_id"]))
            bucket["input_tokens"] += int(row.get("input_tokens") or 0)
            bucket["output_tokens"] += int(row.get("output_tokens") or 0)
            bucket["total_tokens"] += int(row.get("total_tokens") or 0)

        for start_at in day_starts:
            buckets[start_at]["account_count"] = len(account_sets[start_at])
        return [buckets[start_at] for start_at in day_starts]

    @staticmethod
    def _token_usage_day_start(timestamp: int, *, offset_days: int = 0) -> int:
        local = time.localtime(int(timestamp))
        return int(time.mktime((local.tm_year, local.tm_mon, local.tm_mday + offset_days, 0, 0, 0, -1, -1, -1)))

    @staticmethod
    def _token_usage_summary_from_row(row: dict[str, Any]) -> dict[str, Any]:
        return {
            "event_count": int(row.get("event_count") or 0),
            "account_count": int(row.get("account_count") or 0),
            "private_event_count": int(row.get("private_event_count") or 0),
            "channel_event_count": int(row.get("channel_event_count") or 0),
            "input_tokens": int(row.get("input_tokens") or 0),
            "output_tokens": int(row.get("output_tokens") or 0),
            "total_tokens": int(row.get("total_tokens") or 0),
            "last_used_at": row.get("last_used_at"),
        }

    @staticmethod
    def _token_usage_aggregate_row(row: dict[str, Any]) -> dict[str, Any]:
        result = dict(row)
        for key in ("user_id", "event_count", "input_tokens", "output_tokens", "total_tokens", "last_used_at"):
            if key in result and result[key] is not None:
                result[key] = int(result[key])
        if "active" in result:
            result["active"] = bool(result["active"])
        return result

    @staticmethod
    def _token_usage_event_row(row: dict[str, Any]) -> dict[str, Any]:
        result = dict(row)
        result["username"] = result.pop("current_username", None) or result.get("username") or ""
        result["display_name"] = result.pop("current_display_name", None) or result.get("display_name") or result["username"]
        result["raw_usage"] = decode_json(result.pop("raw_usage_json", "{}"))
        for key in (
            "id",
            "user_id",
            "request_message_id",
            "response_message_id",
            "input_tokens",
            "output_tokens",
            "total_tokens",
            "created_at",
        ):
            if key in result and result[key] is not None:
                result[key] = int(result[key])
        result["degraded"] = bool(result.get("degraded"))
        return result

    def _token_usage_from_agent_result(self, result: AgentResult, generation: dict[str, Any]) -> dict[str, Any] | None:
        usage = extract_token_usage(result.raw)
        if usage is None:
            return None
        provider = normalize_hermes_provider(str(generation.get("provider") or self._active_oauth_provider()))
        model = normalize_model_name(str(extract_model_name(result.raw) or generation.get("model") or ""))
        return {
            "provider": provider,
            "model": model,
            "input_tokens": int(usage.get("input_tokens") or 0),
            "output_tokens": int(usage.get("output_tokens") or 0),
            "total_tokens": int(usage.get("total_tokens") or 0),
            "raw_usage": usage.get("raw_usage") if isinstance(usage.get("raw_usage"), dict) else {},
            "degraded": bool(result.degraded),
        }

    @staticmethod
    def _public_token_usage(usage: dict[str, Any]) -> dict[str, Any]:
        return {
            "provider": usage.get("provider") or "",
            "model": usage.get("model") or "",
            "input_tokens": int(usage.get("input_tokens") or 0),
            "output_tokens": int(usage.get("output_tokens") or 0),
            "total_tokens": int(usage.get("total_tokens") or 0),
            "degraded": bool(usage.get("degraded")),
        }

    def _record_token_usage_event(
        self,
        task: dict[str, Any],
        usage: dict[str, Any] | None,
        *,
        response_message_id: int,
        scope_name: str,
    ) -> None:
        if not usage:
            return
        actor = task.get("actor") or {}
        user_message = task.get("user_message") or {}
        try:
            self.db.insert(
                """
                INSERT INTO token_usage_events(
                    user_id, username, display_name, scope_type, scope_id, scope_name,
                    request_message_id, response_message_id, provider, model,
                    input_tokens, output_tokens, total_tokens, raw_usage_json, degraded, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    int(actor.get("id") or 0),
                    str(actor.get("username") or ""),
                    self._actor_display_name(actor),
                    str(task.get("scope_type") or ""),
                    str(task.get("scope_id") or ""),
                    str(scope_name or ""),
                    int(user_message.get("id") or 0),
                    int(response_message_id),
                    str(usage.get("provider") or ""),
                    str(usage.get("model") or ""),
                    int(usage.get("input_tokens") or 0),
                    int(usage.get("output_tokens") or 0),
                    int(usage.get("total_tokens") or 0),
                    encode_json(usage.get("raw_usage") if isinstance(usage.get("raw_usage"), dict) else {}),
                    1 if usage.get("degraded") else 0,
                    now_ts(),
                ),
            )
        except Exception as exc:
            print(f"Failed to record token usage: {exc}", file=sys.stderr)

    def send_channel_message(
        self,
        actor: dict[str, Any],
        channel_id: int,
        content: str,
        attachments: list[UploadedFile] | None = None,
    ) -> dict[str, Any]:
        require_permission(actor, PERMISSION_CHAT)
        channel = self.get_channel(actor, channel_id)
        content = content.strip()
        uploads = self._normalize_uploaded_files(attachments)
        if not content and not uploads:
            raise ServiceError(400, "message content is required")
        if uploads:
            self._enforce_upload_rate_limit(actor.get("id"))
        generation = self.account_generation_config(actor)
        scope_id = str(channel_id)
        agent_content = channel_agent_request(content)
        if agent_content is not None and uploads:
            cleaned = AGENT_MENTION_RE.sub("", content).strip()
            cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
            agent_content = cleaned
        user_msg = self._append_message(
            scope_type="channel",
            scope_id=scope_id,
            author_type="user",
            user_id=actor["id"],
            username=actor["display_name"],
            content=content,
            metadata={
                "generation": generation,
                "agent_mention": agent_content is not None,
                "attachment_count": len(uploads),
            },
            attachments=uploads,
        )
        if agent_content is None:
            return {
                "user_message": user_msg,
                "agent_message": None,
                "agent_status": self.agent_status(actor, "channel", scope_id),
            }
        agent_attachments = self._attachments_for_message(int(user_msg["id"]), include_local_path=True)
        status = self._enqueue_agent_reply(
            {
                "scope_type": "channel",
                "scope_id": scope_id,
                "channel": channel,
                "actor": dict(actor),
                "content": agent_content,
                "attachments": agent_attachments,
                "generation": generation,
                "user_message": user_msg,
            }
        )
        return {"user_message": user_msg, "agent_message": None, "agent_status": status}

    def _send_channel_agent_reply(self, task: dict[str, Any]) -> dict[str, Any]:
        scope_id = str(task["scope_id"])
        channel = task["channel"]
        content = str(task["content"])
        attachments = list(task.get("attachments") or [])
        prompt_content = self._agent_prompt_content(content, attachments, default="请处理这些附件。")
        generation = task["generation"]
        user_msg = task["user_message"]
        self._record_agent_activity("channel", scope_id, "preparing", "准备 Agent 请求", "整理频道上下文")
        suggestions = self.knowledge.suggest(
            self._recent_context_before(
                "channel",
                scope_id,
                prompt_content,
                int(user_msg["id"]),
                current_speaker=self._actor_display_name(task["actor"]),
            )
        )
        system_prompt = self._channel_system_prompt(channel, suggestions)
        self._record_agent_activity("channel", scope_id, "replying", "等待 Hermes Agent 运行过程", generation["model"])
        session_id = self._channel_agent_session_id(scope_id)
        result = self.agent_client.generate(
            system_prompt=system_prompt,
            user_message=self._channel_speaker_line(task["actor"], prompt_content),
            history=self._hermes_owned_history(),
            session_id=session_id,
            session_key=f"channel:{scope_id}:main-agent",
            metadata={
                "knowledge_suggestions": [h.to_dict() for h in suggestions],
                "attachments": self._attachment_metadata_for_agent(attachments),
            },
            attachments=attachments,
            model=generation["model"],
            thinking_depth=generation["thinking_depth"],
            reasoning_config=generation["reasoning_config"],
            progress_callback=lambda event: self._record_hermes_progress("channel", scope_id, event),
            content_callback=lambda delta: self._record_agent_content_delta("channel", scope_id, delta),
        )
        self._remember_channel_agent_session_id(scope_id, result.session_id)
        clean_content, generated_attachments = self._extract_generated_attachments(result.content)
        self._record_agent_activity("channel", scope_id, "complete", "回复已生成", "保存到频道消息")
        token_usage = self._token_usage_from_agent_result(result, generation)
        metadata = {
            "session_id": result.session_id,
            "degraded": result.degraded,
            "generation": generation,
            "knowledge_suggestions": [h.to_dict() for h in suggestions],
            "reply_to": self._reply_target(task),
        }
        if token_usage:
            metadata["token_usage"] = self._public_token_usage(token_usage)
        metadata["agent_work"] = self._agent_work_snapshot(task, state="complete")
        message = self._append_message(
            scope_type="channel",
            scope_id=scope_id,
            author_type="agent",
            user_id=None,
            username="Main Agent",
            content=clean_content,
            metadata=metadata,
            attachments=generated_attachments,
            attachment_source="hermes",
        )
        self._record_token_usage_event(
            task,
            token_usage,
            response_message_id=int(message["id"]),
            scope_name=f"#{channel['name']}",
        )
        return message

    def send_private_message(
        self,
        actor: dict[str, Any],
        content: str,
        attachments: list[UploadedFile] | None = None,
    ) -> dict[str, Any]:
        require_permission(actor, PERMISSION_PRIVATE_AGENT)
        content = content.strip()
        uploads = self._normalize_uploaded_files(attachments)
        if not content and not uploads:
            raise ServiceError(400, "message content is required")
        if uploads:
            self._enforce_upload_rate_limit(actor.get("id"))
        generation = self.account_generation_config(actor)
        scope_id = str(actor["id"])
        user_msg = self._append_message(
            scope_type="private",
            scope_id=scope_id,
            author_type="user",
            user_id=actor["id"],
            username=actor["display_name"],
            content=content,
            metadata={"generation": generation, "attachment_count": len(uploads)},
            attachments=uploads,
        )
        agent_attachments = self._attachments_for_message(int(user_msg["id"]), include_local_path=True)
        current_container = self.containers.get_private_container(actor["id"])
        status = self._enqueue_agent_reply(
            {
                "scope_type": "private",
                "scope_id": scope_id,
                "actor": dict(actor),
                "content": content,
                "attachments": agent_attachments,
                "generation": generation,
                "user_message": user_msg,
            }
        )
        return {
            "user_message": user_msg,
            "agent_message": None,
            "agent_status": status,
            "container": current_container.to_dict() if current_container else None,
        }

    def _send_private_agent_reply(self, task: dict[str, Any]) -> dict[str, Any]:
        actor = task["actor"]
        content = str(task["content"])
        attachments = list(task.get("attachments") or [])
        prompt_content = self._agent_prompt_content(content, attachments, default="请处理这些附件。")
        generation = task["generation"]
        scope_id = str(task["scope_id"])
        user_msg = task["user_message"]
        self._record_agent_activity("private", scope_id, "preparing", "准备私人工作区", f"u{actor['id']}")
        container = self.containers.ensure_private_container(
            user_id=actor["id"],
            username=actor["username"],
            secrets_env=self.model_secret_env(),
        )
        container_data = container.to_dict()
        suggestions = self.knowledge.suggest(self._recent_context_before("private", scope_id, prompt_content, int(user_msg["id"])))
        system_prompt = self._private_system_prompt(actor, container_data, suggestions)
        self._record_agent_activity("private", scope_id, "replying", "等待 Hermes Agent 运行过程", generation["model"])
        result = self.agent_client.generate(
            system_prompt=system_prompt,
            user_message=prompt_content,
            history=self._hermes_owned_history(),
            session_id=container.session_id,
            session_key=f"private:{actor['id']}",
            metadata={
                "knowledge_suggestions": [h.to_dict() for h in suggestions],
                "container": container_data,
                "attachments": self._attachment_metadata_for_agent(attachments),
            },
            attachments=attachments,
            model=generation["model"],
            thinking_depth=generation["thinking_depth"],
            reasoning_config=generation["reasoning_config"],
            progress_callback=lambda event: self._record_hermes_progress("private", scope_id, event),
            content_callback=lambda delta: self._record_agent_content_delta("private", scope_id, delta),
        )
        if self._valid_hermes_session_id(result.session_id):
            self.containers.update_private_session_id(actor["id"], result.session_id)
            container_data["session_id"] = result.session_id
        clean_content, generated_attachments = self._extract_generated_attachments(
            result.content, owner_id=int(scope_id)
        )
        self._record_agent_activity("private", scope_id, "complete", "回复已生成", "保存到私人会话")
        token_usage = self._token_usage_from_agent_result(result, generation)
        metadata = {
            "session_id": result.session_id,
            "degraded": result.degraded,
            "container": container_data,
            "generation": generation,
            "knowledge_suggestions": [h.to_dict() for h in suggestions],
            "reply_to": self._reply_target(task),
        }
        if token_usage:
            metadata["token_usage"] = self._public_token_usage(token_usage)
        metadata["agent_work"] = self._agent_work_snapshot(task, state="complete")
        message = self._append_message(
            scope_type="private",
            scope_id=scope_id,
            author_type="agent",
            user_id=None,
            username="Private Agent",
            content=clean_content,
            metadata=metadata,
            attachments=generated_attachments,
            attachment_source="hermes",
        )
        self._record_token_usage_event(
            task,
            token_usage,
            response_message_id=int(message["id"]),
            scope_name=self._actor_display_name(actor),
        )
        return message

    def private_status(self, actor: dict[str, Any]) -> dict[str, Any]:
        require_permission(actor, PERMISSION_PRIVATE_AGENT)
        container = self.containers.get_private_container(actor["id"])
        return {
            "container": container.to_dict() if container else None,
            "session_id": container.session_id if container else f"enterprise-private-u{actor['id']}",
            "agent_status": self.agent_status(actor, "private", str(actor["id"])),
        }

    def runtime_status(self, actor: dict[str, Any]) -> dict[str, Any]:
        require_admin(actor)
        return self.runtimes.status(refresh=True)

    def hermes_config(self, actor: dict[str, Any]) -> dict[str, Any]:
        require_admin(actor)
        config = self.runtimes.hermes_runtime_config()
        config["api_key_configured"] = bool(
            self.config.hermes_api_key
            or self.get_secret("ENTERPRISE_HERMES_API_KEY")
            or self.get_secret("API_SERVER_KEY")
        )
        config["model_catalog"] = self._oauth_model_catalogs()
        return {"config": config, "runtime": self.runtimes.hermes_status(refresh=True).to_dict()}

    def hermes_internal_config(self, actor: dict[str, Any]) -> dict[str, Any]:
        require_admin(actor)
        self.runtimes.prepare_hermes()
        config = self.runtimes.hermes_runtime_config()
        defaults, default_error = load_hermes_default_config(Path(config["repo_path"]))
        internal = read_hermes_internal_config(
            Path(config["config_path"]),
            Path(config["env_path"]),
            default_config=defaults,
            default_error=default_error,
        )
        return {"config": config, "internal": internal, "runtime": self.runtimes.hermes_status(refresh=True).to_dict()}

    def update_hermes_internal_config(self, actor: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
        require_admin(actor)
        config = self.runtimes.hermes_runtime_config()
        try:
            if "yaml_text" in body:
                update_yaml_text(Path(config["config_path"]), str(body.get("yaml_text") or ""))
            yaml_updates = body.get("yaml_updates")
            if isinstance(yaml_updates, dict):
                update_yaml_values(Path(config["config_path"]), yaml_updates)
            env_updates = body.get("env")
            if isinstance(env_updates, dict):
                update_env_file(Path(config["env_path"]), env_updates)
        except ValueError as exc:
            raise ServiceError(400, str(exc)) from exc
        self.runtimes.prepare_hermes()
        return self.hermes_internal_config(actor)

    def cognee_config(self, actor: dict[str, Any]) -> dict[str, Any]:
        require_admin(actor)
        runtime_config = self.runtimes.cognee_runtime_config()
        internal = read_cognee_internal_config(
            Path(runtime_config["env_path"]),
            {
                "DATA_ROOT_DIRECTORY": str(runtime_config.get("data_root_directory", "")),
                "SYSTEM_ROOT_DIRECTORY": str(runtime_config.get("system_root_directory", "")),
                "CACHE_ROOT_DIRECTORY": str(runtime_config.get("cache_root_directory", "")),
                "COGNEE_LOGS_DIR": str(runtime_config.get("logs_dir", "")),
                "COGNEE_SKIP_CONNECTION_TEST": "true" if runtime_config.get("skip_connection_test") else "false",
            },
        )
        return {
            "config": runtime_config,
            "internal": internal,
            "runtime": self.runtimes.cognee_status().to_dict(),
            "knowledge": self.knowledge_status(),
        }

    def update_cognee_config(self, actor: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
        require_admin(actor)
        runtime_config = self.runtimes.cognee_runtime_config()
        env_updates = body.get("env")
        if isinstance(env_updates, dict):
            try:
                update_env_file(Path(runtime_config["env_path"]), env_updates)
            except ValueError as exc:
                raise ServiceError(400, str(exc)) from exc
        self.cognee.refresh_status()
        self.runtimes.ensure_cognee_ready()
        return self.cognee_config(actor)

    def _hermes_repo_allowed_roots(self) -> list[Path]:
        """Trusted base directories a managed Hermes source path may live under.

        Defaults to ONLY the bundled submodule directory (the parent tree is not
        trusted, because it contains agent/user-writable storage such as the
        workspaces). Operators can widen this via
        ``ENTERPRISE_HERMES_REPO_ALLOWED_ROOTS`` (os.pathsep separated). This is
        the trust boundary that prevents a (possibly compromised) web admin from
        pointing the source path at an attacker-influenced directory, which
        would otherwise run code via ``pip install -e <dir>`` and the gateway.
        """
        roots: list[Path] = []
        for base in (self.config.hermes_repo,):
            try:
                roots.append(base.resolve())
            except OSError:
                continue
        for raw in os.getenv("ENTERPRISE_HERMES_REPO_ALLOWED_ROOTS", "").split(os.pathsep):
            raw = raw.strip()
            if raw:
                try:
                    roots.append(Path(raw).expanduser().resolve())
                except OSError:
                    continue
        return roots

    def _validate_hermes_repo_path(self, repo_path: str) -> str:
        try:
            candidate = Path(repo_path).expanduser().resolve()
        except OSError as exc:
            raise ServiceError(400, "Hermes source path is invalid") from exc
        if not candidate.is_dir():
            raise ServiceError(400, "Hermes source path does not exist")
        if not (candidate / "pyproject.toml").exists():
            raise ServiceError(400, "Hermes source path must contain pyproject.toml")
        # Never install from agent/user-writable storage (the workspace tree)
        # even if an override root were to cover it.
        try:
            workspace_root = self.config.workspace_dir.resolve()
        except OSError:
            workspace_root = None
        if workspace_root is not None and (candidate == workspace_root or candidate.is_relative_to(workspace_root)):
            raise ServiceError(403, "Hermes source path must not be inside the agent workspace")
        roots = self._hermes_repo_allowed_roots()
        if not any(candidate == root or candidate.is_relative_to(root) for root in roots):
            raise ServiceError(
                403,
                "Hermes source path must be located under a trusted directory; set "
                "ENTERPRISE_HERMES_REPO_ALLOWED_ROOTS to permit additional locations",
            )
        return str(candidate)

    def update_hermes_config(self, actor: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
        require_admin(actor)
        if "manage_hermes" in body:
            self.set_setting(HERMES_SETTING_MANAGED, "1" if parse_bool(body.get("manage_hermes")) else "0")
        if "repo_path" in body:
            repo_path = str(body.get("repo_path", "")).strip()
            if not repo_path:
                raise ServiceError(400, "Hermes source path is required")
            self.set_setting(HERMES_SETTING_REPO, self._validate_hermes_repo_path(repo_path))
        if "api_url" in body:
            api_url = str(body.get("api_url", "")).strip()
            parsed = urllib.parse.urlparse(api_url)
            if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                raise ServiceError(400, "Hermes API URL must be an http(s) URL")
            self.set_setting(HERMES_SETTING_API_URL, api_url)
        previous_provider = self._active_oauth_provider()
        provider = None
        if "provider" in body:
            provider = normalize_hermes_provider(str(body.get("provider", "") or "auto"))
            if provider not in SUPPORTED_OAUTH_PROVIDERS:
                raise ServiceError(400, "Hermes provider must be Codex OAuth or Grok OAuth")
            self.set_setting(HERMES_SETTING_PROVIDER, provider)
        provider_changed = provider is not None and provider != previous_provider
        if "provider_base_url" in body or "base_url" in body:
            raw_base_url = body.get("provider_base_url", body.get("base_url", ""))
            base_url = str(raw_base_url or "").strip().rstrip("/")
            if base_url:
                parsed = urllib.parse.urlparse(base_url)
                if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                    raise ServiceError(400, "Hermes provider base URL must be an http(s) URL")
            self.set_setting(HERMES_SETTING_PROVIDER_BASE_URL, base_url)
        if "model" in body:
            model = str(body.get("model", "")).strip()
            if model or provider_changed:
                model_provider = provider or previous_provider
                if model_provider in SUPPORTED_OAUTH_PROVIDERS:
                    model = self._resolve_oauth_model_selection(model_provider, model)
                if not model:
                    raise ServiceError(400, "Hermes model is required")
                self.set_setting(HERMES_SETTING_MODEL, model)
        elif provider and provider_changed:
            self.set_setting(HERMES_SETTING_MODEL, self._default_oauth_model(provider))
            if not self.get_setting(HERMES_SETTING_PROVIDER_BASE_URL):
                self.set_setting(HERMES_SETTING_PROVIDER_BASE_URL, default_base_url_for_provider(provider))
        if "install_extras" in body:
            extras = str(body.get("install_extras", "")).strip()
            if extras and not re.fullmatch(r"[A-Za-z0-9_,.-]{1,120}", extras):
                raise ServiceError(400, "Hermes install extras contain unsupported characters")
            self.set_setting(HERMES_SETTING_INSTALL_EXTRAS, extras)
        if "startup_wait_seconds" in body:
            try:
                wait_seconds = float(body.get("startup_wait_seconds"))
            except (TypeError, ValueError) as exc:
                raise ServiceError(400, "startup wait seconds must be a number") from exc
            if wait_seconds < 0 or wait_seconds > 120:
                raise ServiceError(400, "startup wait seconds must be between 0 and 120")
            self.set_setting(HERMES_SETTING_STARTUP_WAIT, str(wait_seconds))
        if "timeout_seconds" in body:
            try:
                timeout_seconds = float(body.get("timeout_seconds"))
            except (TypeError, ValueError) as exc:
                raise ServiceError(400, "timeout seconds must be a number") from exc
            if timeout_seconds < 1 or timeout_seconds > 3600:
                raise ServiceError(400, "timeout seconds must be between 1 and 3600")
            self.set_setting(HERMES_SETTING_TIMEOUT, str(timeout_seconds))
        api_key = str(body.get("api_key", "")).strip()
        if api_key:
            self.set_setting("API_SERVER_KEY", api_key, secret=True)
        self.runtimes.prepare_hermes()
        return self.hermes_config(actor)

    def restart_runtime(self, actor: dict[str, Any], name: str) -> dict[str, Any]:
        require_admin(actor)
        clean = name.strip().lower()
        if clean == "hermes":
            return {"runtime": self.runtimes.restart_hermes().to_dict()}
        if clean == "camofox":
            return {"runtime": self.runtimes.restart_camofox().to_dict()}
        if clean == "firecrawl":
            return {"runtime": self.runtimes.restart_firecrawl().to_dict()}
        if clean == "cognee":
            self.cognee.refresh_status()
            return {"runtime": self.runtimes.ensure_cognee_ready().to_dict()}
        raise ServiceError(404, "runtime not found")

    def install_runtime(self, actor: dict[str, Any], name: str) -> dict[str, Any]:
        require_admin(actor)
        clean = name.strip().lower()
        if clean == "hermes":
            install_status = self.runtimes.install_hermes(force=True)
            if install_status.available:
                self.runtimes.prepare_hermes()
            return {"runtime": install_status.to_dict(), "config": self.runtimes.hermes_runtime_config()}
        if clean == "camofox":
            return {"runtime": self.runtimes.ensure_camofox_ready(wait=True).to_dict()}
        if clean == "firecrawl":
            return {"runtime": self.runtimes.ensure_firecrawl_ready(wait=True).to_dict()}
        raise ServiceError(404, "runtime not found")

    def oauth_provider_status(self, actor: dict[str, Any]) -> dict[str, Any]:
        require_admin(actor)
        active_provider = self._active_oauth_provider()
        runtime_oauth = self.runtimes.hermes_runtime_config().get("oauth", {})
        providers = []
        for provider in SUPPORTED_OAUTH_PROVIDERS:
            info = oauth_provider_info(provider)
            catalog = self._oauth_model_catalog(provider)
            configured = self._oauth_tokens_configured(provider)
            runtime_status = runtime_oauth.get(provider, {}) if isinstance(runtime_oauth, dict) else {}
            last_auth_error = runtime_status.get("last_auth_error") if isinstance(runtime_status, dict) else None
            if not isinstance(last_auth_error, dict):
                last_auth_error = None
            relogin_required = bool(last_auth_error and last_auth_error.get("relogin_required"))
            providers.append(
                {
                    **info,
                    "models": catalog["models"],
                    "default_model": catalog["default_model"],
                    "model_catalog_error": catalog["error"],
                    "configured": (configured or bool(runtime_status.get("configured"))) and not relogin_required,
                    "active": active_provider == provider,
                    # Hermes owns token refresh and keeps auth.json current, so
                    # prefer the runtime value; the DB write time is only a
                    # fallback before Hermes has written auth.json (e.g. right
                    # after a credential import).
                    "last_refresh": runtime_status.get("last_refresh") or self._oauth_last_refresh(provider),
                    "last_auth_error": dict(last_auth_error) if last_auth_error else None,
                }
            )
        return {"providers": providers, "active_provider": active_provider}

    def export_oauth_credentials(self, actor: dict[str, Any]) -> dict[str, Any]:
        require_admin(actor)
        providers: dict[str, dict[str, Any]] = {}
        for provider in SUPPORTED_OAUTH_PROVIDERS:
            info = oauth_provider_info(provider)
            catalog = self._oauth_model_catalog(provider)
            credentials = {
                key: value
                for key in OAUTH_PROVIDER_SECRET_KEYS[provider]
                if (value := self.get_secret(key))
            }
            providers[provider] = {
                "id": provider,
                "label": info["label"],
                "model": catalog["default_model"],
                "configured": self._oauth_tokens_configured(provider),
                "credentials": credentials,
            }
        return {
            "kind": OAUTH_CREDENTIAL_EXPORT_KIND,
            "version": OAUTH_CREDENTIAL_EXPORT_VERSION,
            "exported_at": now_ts(),
            "active_provider": self._active_oauth_provider(),
            "providers": providers,
        }

    def import_oauth_credentials(self, actor: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
        require_admin(actor)
        payload = body.get("credentials", body)
        if not isinstance(payload, dict):
            raise ServiceError(400, "OAuth credential import must be a JSON object")
        by_provider = self._extract_oauth_credentials(payload)
        imported_keys = []
        imported_providers = []
        for provider, secrets_by_key in by_provider.items():
            if not secrets_by_key:
                continue
            required = OAUTH_PROVIDER_SECRET_KEYS[provider][:2]
            if any(key in secrets_by_key for key in required) and not all(key in secrets_by_key for key in required):
                label = oauth_provider_info(provider)["label"]
                raise ServiceError(400, f"{label} import requires both access and refresh tokens")
            imported_providers.append(provider)
            for key, value in secrets_by_key.items():
                self.set_setting(key, value, secret=True)
                imported_keys.append(key)
        if not imported_keys:
            raise ServiceError(400, "no supported OAuth credentials found in import file")

        active_raw = payload.get("active_provider")
        active_provider = normalize_hermes_provider(str(active_raw)) if active_raw else ""
        if active_provider in SUPPORTED_OAUTH_PROVIDERS and self._oauth_tokens_configured(active_provider):
            self._select_oauth_provider(active_provider)
        else:
            self.runtimes.prepare_hermes()

        return {
            "imported": {
                "providers": imported_providers,
                "keys": imported_keys,
            },
            **self.oauth_provider_status(actor),
        }

    def start_oauth_verification(self, actor: dict[str, Any], provider: str) -> dict[str, Any]:
        require_admin(actor)
        provider = normalize_hermes_provider(provider)
        if provider not in SUPPORTED_OAUTH_PROVIDERS:
            raise ServiceError(400, "OAuth provider must be Codex OAuth or Grok OAuth")
        # Do NOT switch the live Hermes provider here: authentication has not yet
        # completed and no tokens exist. Switching now would point the running
        # agent at a token-less provider if the admin abandons the flow. The
        # provider only becomes active in _store_oauth_flow_result once tokens are
        # stored. Surface the in-progress target for the UI without mutating
        # runtime config.
        try:
            flow = self.oauth_flows.start(provider)
        except OAuthFlowError as exc:
            raise ServiceError(exc.status, exc.message) from exc
        if isinstance(flow, dict):
            flow.setdefault("target_provider", provider)
        return {"flow": flow, **self.oauth_provider_status(actor)}

    def poll_oauth_verification(self, actor: dict[str, Any], provider: str, body: dict[str, Any]) -> dict[str, Any]:
        require_admin(actor)
        provider = normalize_hermes_provider(provider)
        if provider not in SUPPORTED_OAUTH_PROVIDERS:
            raise ServiceError(400, "OAuth provider must be Codex OAuth or Grok OAuth")
        flow_id = str(body.get("flow_id", "")).strip()
        try:
            flow = self.oauth_flows.poll(provider, flow_id)
        except OAuthFlowError as exc:
            raise ServiceError(exc.status, exc.message) from exc
        self._store_oauth_flow_result(provider, flow)
        return {"flow": flow, **self.oauth_provider_status(actor)}

    def complete_oauth_verification(self, actor: dict[str, Any], provider: str, body: dict[str, Any]) -> dict[str, Any]:
        require_admin(actor)
        provider = normalize_hermes_provider(provider)
        if provider not in SUPPORTED_OAUTH_PROVIDERS:
            raise ServiceError(400, "OAuth provider must be Codex OAuth or Grok OAuth")
        flow_id = str(body.get("flow_id", "")).strip()
        callback_url = str(body.get("callback_url", "")).strip()
        try:
            flow = self.oauth_flows.complete(provider, flow_id, callback_url)
        except OAuthFlowError as exc:
            raise ServiceError(exc.status, exc.message) from exc
        self._store_oauth_flow_result(provider, flow)
        return {"flow": flow, **self.oauth_provider_status(actor)}

    def add_knowledge_document(self, actor: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
        require_permission(actor, PERMISSION_MANAGE_KNOWLEDGE)
        doc, created = self.knowledge.add_document_with_status(
            title=str(body.get("title", "")),
            summary=str(body.get("summary", "")),
            content=str(body.get("content", "")),
            source=str(body.get("source", "")),
            created_by=actor["id"],
        )
        # Only enqueue Cognee ingestion for a genuinely new document; a dedup hit
        # (identical re-submit) must not re-flood the graph backend with a
        # duplicate add+cognify of content it already holds.
        if created:
            doc["cognee"] = self._queue_cognee_ingest(doc)
        else:
            doc["cognee"] = {"attempted": False, "available": True, "deduplicated": True}
        return doc

    def _queue_cognee_ingest(self, doc: dict[str, Any]) -> dict[str, Any]:
        """Schedule Cognee ingestion off the request thread.

        Cognee's add+cognify can take many seconds; running it inline would hold
        the request thread (and contend on the database) for the whole graph
        build. For the local backend ingestion is a no-op, so we return the
        immediate (synchronous) result and skip the worker entirely.
        """
        if self.config.knowledge_backend not in {"hybrid", "cognee"}:
            return self.cognee.ingest_document(
                title=doc["title"], content=doc["content"], source=doc.get("source", "")
            )
        with self._ingest_lock:
            if self._closed:
                return {"attempted": False, "available": False, "error": "service shutting down"}
            self._ingest_queue.append(
                {
                    "document_id": doc.get("id"),
                    "title": doc["title"],
                    "content": doc["content"],
                    "source": doc.get("source", ""),
                    "attempts": 0,
                }
            )
            while len(self._ingest_queue) > MAX_INGEST_QUEUE_DEPTH:
                self._ingest_queue.popleft()
            if self._ingest_thread is None or not self._ingest_thread.is_alive():
                self._ingest_thread = threading.Thread(
                    target=self._ingest_worker, name="cognee-ingest", daemon=True
                )
                self._ingest_thread.start()
        return {"attempted": True, "available": True, "queued": True, "document_id": doc.get("id")}

    def _ingest_worker(self) -> None:
        while True:
            with self._ingest_lock:
                if self._closed or not self._ingest_queue:
                    self._ingest_thread = None
                    return
                job = self._ingest_queue.popleft()
            try:
                result = self.cognee.ingest_document(
                    title=job["title"], content=job["content"], source=job["source"]
                )
            except Exception as exc:  # never let a bad ingest kill the worker
                result = {"attempted": True, "available": True, "error": str(exc)}
            error = result.get("error")
            if error and self._retry_ingest_job(job, str(error)):
                # Re-queued for another attempt; do not record a terminal result.
                continue
            if error:
                print(f"Cognee ingest failed for document {job.get('document_id')}: {error}", file=sys.stderr)
                with self._ingest_lock:
                    self._ingest_failed_count += 1
                    self._ingest_last_error = str(error)
            doc_id = job.get("document_id")
            if doc_id is not None:
                with self._ingest_lock:
                    self._ingest_results[int(doc_id)] = result
                    while len(self._ingest_results) > MAX_TRACKED_INGEST_RESULTS:
                        self._ingest_results.pop(next(iter(self._ingest_results)), None)

    def _retry_ingest_job(self, job: dict[str, Any], error: str) -> bool:
        """Re-queue a failed ingest job with capped backoff.

        Returns True when the job was re-queued for another attempt, False when
        retries are exhausted, the service is closing, or the queue is full.
        """
        attempts = int(job.get("attempts", 0)) + 1
        if attempts >= MAX_INGEST_ATTEMPTS:
            return False
        backoff = min(2 ** attempts, INGEST_RETRY_BACKOFF_CAP_SECONDS)
        print(
            f"Cognee ingest attempt {attempts} failed for document {job.get('document_id')}: "
            f"{error}; retrying in {backoff}s",
            file=sys.stderr,
        )
        time.sleep(backoff)
        with self._ingest_lock:
            if self._closed or len(self._ingest_queue) >= MAX_INGEST_QUEUE_DEPTH:
                return False
            job["attempts"] = attempts
            self._ingest_queue.append(job)
            return True

    def cognee_ingest_result(self, document_id: int) -> dict[str, Any] | None:
        with self._ingest_lock:
            result = self._ingest_results.get(int(document_id))
            return dict(result) if result else None

    def search_knowledge(self, query: str, limit: int = 5) -> list[dict[str, Any]]:
        local = [hit.to_dict() for hit in self.knowledge.search(query, limit)]
        if len(local) >= limit and self.config.knowledge_backend != "cognee":
            return local[:limit]
        cognee_hits = self.cognee.search(query, limit=max(0, limit - len(local)))
        if self.config.knowledge_backend == "cognee":
            return _dedupe_knowledge_hits(cognee_hits or local)[:limit]
        # Local (bm25-ranked) results lead; cognee graph results follow. Dedupe
        # only removes same-keyspace duplicates (e.g. a repeated local id);
        # local and cognee hits use disjoint id keyspaces and are never collapsed
        # together (see _dedupe_knowledge_hits).
        return _dedupe_knowledge_hits(local + cognee_hits)[:limit]

    def get_knowledge_document(self, document_id: int) -> dict[str, Any]:
        doc = self.knowledge.get_document(document_id)
        if not doc:
            raise ServiceError(404, "knowledge document not found")
        return doc

    # User-facing knowledge reads require read_workspace. The bare
    # search_knowledge/get_knowledge_document methods stay unauthenticated for
    # the agent-tool boundary, which is gated separately by the agent token.
    def list_knowledge_documents(self, actor: dict[str, Any]) -> list[dict[str, Any]]:
        require_permission(actor, PERMISSION_READ_WORKSPACE)
        return self.knowledge.list_documents()

    def user_search_knowledge(self, actor: dict[str, Any], query: str, limit: int = 5) -> list[dict[str, Any]]:
        require_permission(actor, PERMISSION_READ_WORKSPACE)
        return self.search_knowledge(query, limit)

    def user_knowledge_document(self, actor: dict[str, Any], document_id: int) -> dict[str, Any]:
        require_permission(actor, PERMISSION_READ_WORKSPACE)
        return self.get_knowledge_document(document_id)

    def knowledge_status(self) -> dict[str, Any]:
        with self._ingest_lock:
            ingest_pending = len(self._ingest_queue)
            ingest_failed = self._ingest_failed_count
            ingest_last_error = self._ingest_last_error
        fts = bool(getattr(self.db, "fts_available", False))
        return {
            "local": {
                "available": True,
                "backend": "sqlite-fts" if fts else "sqlite-like",
                "fts5": fts,
            },
            "cognee": self.cognee.status().to_dict(),
            "mode": self.config.knowledge_backend,
            "dataset": self.config.cognee_dataset,
            "ingest_pending": ingest_pending,
            "ingest_failed": ingest_failed,
            "ingest_last_error": ingest_last_error,
        }

    def get_setting(self, key: str) -> str | None:
        row = self.db.query_one("SELECT value FROM settings WHERE key = ?", (key,))
        return row["value"] if row else None

    def set_setting(self, key: str, value: str, *, secret: bool = False) -> None:
        self.db.execute(
            """
            INSERT INTO settings(key, value, secret, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value, secret=excluded.secret, updated_at=excluded.updated_at
            """,
            (key, value, 1 if secret else 0, now_ts()),
        )

    def get_secret(self, key: str) -> str:
        row = self.db.query_one("SELECT value FROM settings WHERE key = ? AND secret = 1", (key,))
        if row:
            return str(row["value"])
        return os.getenv(key, "")

    def model_secret_env(self) -> dict[str, str]:
        return {}

    def account_generation_config(self, actor: dict[str, Any]) -> dict[str, Any]:
        provider = self._active_oauth_provider()
        runtime_model = normalize_model_name(str(self.runtimes.hermes_runtime_config().get("model") or self.config.hermes_model))
        model = normalize_model_name(str(actor.get("model_name") or "")) or runtime_model
        model = self._validated_generation_model(model, fallback_model=runtime_model)
        thinking_depth = normalize_thinking_depth(str(actor.get("thinking_depth") or DEFAULT_THINKING_DEPTH))
        return {
            "provider": provider,
            "model": model,
            "thinking_depth": thinking_depth,
            "reasoning_config": reasoning_config_for_depth(thinking_depth),
        }

    def list_secrets(self, actor: dict[str, Any]) -> list[dict[str, Any]]:
        require_admin(actor)
        rows = self.db.query("SELECT key, value, updated_at FROM settings WHERE secret = 1 ORDER BY key")
        found = {row["key"]: row for row in rows}
        items = []
        known_keys = set(OAUTH_SECRET_KEYS) | {"API_SERVER_KEY", "agent_tool_token"}
        for key in sorted(known_keys):
            value = found.get(key, {}).get("value") or os.getenv(key, "")
            items.append({
                "key": key,
                "configured": bool(value),
                "masked": mask_secret(value),
                "updated_at": found.get(key, {}).get("updated_at"),
            })
        return items

    def set_secret(self, actor: dict[str, Any], key: str, value: str) -> None:
        require_admin(actor)
        raw_key = key.strip()
        if raw_key == "agent_tool_token":
            if not value:
                raise ServiceError(400, "secret value is required")
            self.set_setting(raw_key, value, secret=True)
            return
        clean = raw_key.upper()
        if not re.fullmatch(r"[A-Z0-9_]{2,80}", clean):
            raise ServiceError(400, "invalid secret key")
        allowed_keys = set(OAUTH_SECRET_KEYS) | {"API_SERVER_KEY"}
        if clean not in allowed_keys:
            raise ServiceError(400, "unsupported secret key")
        if not value:
            raise ServiceError(400, "secret value is required")
        self.set_setting(clean, value, secret=True)

    def _active_oauth_provider(self) -> str:
        active_provider = normalize_hermes_provider(self.get_setting(HERMES_SETTING_PROVIDER) or self.config.hermes_provider)
        return active_provider if active_provider in SUPPORTED_OAUTH_PROVIDERS else "openai-codex"

    def _extract_oauth_credentials(self, payload: dict[str, Any]) -> dict[str, dict[str, str]]:
        by_provider: dict[str, dict[str, str]] = {provider: {} for provider in SUPPORTED_OAUTH_PROVIDERS}
        self._collect_flat_oauth_credentials(by_provider, payload)
        top_level_credentials = payload.get("credentials")
        if isinstance(top_level_credentials, dict):
            self._collect_flat_oauth_credentials(by_provider, top_level_credentials)
        providers = payload.get("providers")
        if providers is None:
            return by_provider
        if not isinstance(providers, dict):
            raise ServiceError(400, "OAuth credential providers must be a JSON object")
        for raw_provider, entry in providers.items():
            provider = normalize_hermes_provider(str(raw_provider))
            if provider not in SUPPORTED_OAUTH_PROVIDERS:
                continue
            if not isinstance(entry, dict):
                raise ServiceError(400, f"OAuth credential provider {raw_provider} must be a JSON object")
            source = entry.get("credentials")
            if not isinstance(source, dict):
                source = entry.get("secrets")
            if source is None:
                source = entry
            if not isinstance(source, dict):
                raise ServiceError(400, f"OAuth credential provider {raw_provider} credentials must be a JSON object")
            self._collect_provider_oauth_credentials(by_provider, provider, source)
        return by_provider

    def _collect_flat_oauth_credentials(self, by_provider: dict[str, dict[str, str]], source: dict[str, Any]) -> None:
        for provider in SUPPORTED_OAUTH_PROVIDERS:
            self._collect_provider_oauth_credentials(by_provider, provider, source)

    def _collect_provider_oauth_credentials(
        self,
        by_provider: dict[str, dict[str, str]],
        provider: str,
        source: dict[str, Any],
    ) -> None:
        for key in OAUTH_PROVIDER_SECRET_KEYS[provider]:
            value = source.get(key)
            if value is None:
                continue
            clean = str(value).strip()
            if clean:
                by_provider[provider][key] = clean

    def _select_oauth_provider(self, provider: str) -> None:
        self.set_setting(HERMES_SETTING_PROVIDER, provider)
        self.set_setting(HERMES_SETTING_MODEL, self._default_oauth_model(provider))
        self.set_setting(HERMES_SETTING_PROVIDER_BASE_URL, default_base_url_for_provider(provider))
        self.runtimes.prepare_hermes()

    def _oauth_model_catalogs(self) -> dict[str, dict[str, Any]]:
        return {provider: self._oauth_model_catalog(provider) for provider in SUPPORTED_OAUTH_PROVIDERS}

    def _oauth_model_catalog(self, provider: str) -> dict[str, Any]:
        provider = normalize_hermes_provider(provider)
        result: dict[str, Any] = {
            "provider": provider,
            "models": [],
            "default_model": "",
            "source": "hermes",
            "error": "",
        }
        bridge = self.hermes_bridge
        try:
            if bridge is None or not bridge.available():
                result["error"] = "Hermes model catalog is not available"
                return result
            catalog = bridge.model_catalog(provider)
        except OAuthFlowError as exc:
            result["error"] = exc.message
            return result
        except Exception as exc:
            result["error"] = str(exc) or type(exc).__name__
            return result

        models = _clean_model_ids(catalog.get("models") if isinstance(catalog, dict) else [])
        default_model = str(catalog.get("default_model") or "").strip() if isinstance(catalog, dict) else ""
        if default_model not in models:
            default_model = models[0] if models else ""
        result["models"] = models
        result["default_model"] = default_model
        return result

    def _default_oauth_model(self, provider: str) -> str:
        catalog = self._oauth_model_catalog(provider)
        default_model = catalog["default_model"]
        if default_model:
            return default_model
        label = oauth_provider_info(provider)["label"]
        detail = f": {catalog['error']}" if catalog.get("error") else ""
        raise ServiceError(503, f"Hermes model catalog for {label} is unavailable{detail}")

    def _resolve_oauth_model_selection(self, provider: str, model: str) -> str:
        catalog = self._oauth_model_catalog(provider)
        models = catalog["models"]
        if not models:
            label = oauth_provider_info(provider)["label"]
            detail = f": {catalog['error']}" if catalog.get("error") else ""
            raise ServiceError(503, f"Hermes model catalog for {label} is unavailable{detail}")
        clean = str(model or "").strip()
        if clean in {"", "hermes-agent"}:
            clean = catalog["default_model"] or models[0]
        if clean not in models:
            label = oauth_provider_info(provider)["label"]
            raise ServiceError(400, f"Hermes model must be selected from the Hermes catalog for {label}")
        return clean

    def _validate_account_model_name(self, model: str) -> str:
        clean = normalize_model_name(model)
        if clean in {"", "hermes-agent"}:
            return ""
        provider = self._active_oauth_provider()
        catalog = self._oauth_model_catalog(provider)
        models = catalog["models"]
        label = oauth_provider_info(provider)["label"]
        if not models:
            detail = f": {catalog['error']}" if catalog.get("error") else ""
            raise ServiceError(503, f"Hermes model catalog for {label} is unavailable{detail}")
        if clean not in models:
            raise ServiceError(400, f"Account model must be selected from the Hermes catalog for {label}")
        return clean

    def _validated_generation_model(self, model: str, *, fallback_model: str = "") -> str:
        clean = normalize_model_name(model)
        fallback = normalize_model_name(fallback_model)
        provider = self._active_oauth_provider()
        catalog = self._oauth_model_catalog(provider)
        models = catalog["models"]
        if not models:
            return clean or fallback
        if clean in models:
            return clean
        if fallback in models:
            return fallback
        return catalog["default_model"] or models[0]

    def _store_oauth_flow_result(self, provider: str, flow: dict[str, Any]) -> None:
        tokens = flow.pop("tokens", None)
        if not tokens:
            return
        self._select_oauth_provider(provider)
        if provider == "openai-codex":
            self.set_setting("CODEX_OAUTH_ACCESS_TOKEN", str(tokens.get("access_token", "")), secret=True)
            self.set_setting("CODEX_OAUTH_REFRESH_TOKEN", str(tokens.get("refresh_token", "")), secret=True)
        elif provider == "xai-oauth":
            self.set_setting("GROK_OAUTH_ACCESS_TOKEN", str(tokens.get("access_token", "")), secret=True)
            self.set_setting("GROK_OAUTH_REFRESH_TOKEN", str(tokens.get("refresh_token", "")), secret=True)
            id_token = str(tokens.get("id_token", "") or "").strip()
            if id_token:
                self.set_setting("GROK_OAUTH_ID_TOKEN", id_token, secret=True)
        self.runtimes.prepare_hermes()

    def _oauth_tokens_configured(self, provider: str) -> bool:
        if provider == "openai-codex":
            return bool(self.get_secret("CODEX_OAUTH_ACCESS_TOKEN") and self.get_secret("CODEX_OAUTH_REFRESH_TOKEN"))
        if provider == "xai-oauth":
            return bool(self.get_secret("GROK_OAUTH_ACCESS_TOKEN") and self.get_secret("GROK_OAUTH_REFRESH_TOKEN"))
        return False

    def _oauth_last_refresh(self, provider: str) -> int | None:
        keys = {
            "openai-codex": "CODEX_OAUTH_ACCESS_TOKEN",
            "xai-oauth": "GROK_OAUTH_ACCESS_TOKEN",
        }
        key = keys.get(provider)
        if not key:
            return None
        row = self.db.query_one("SELECT updated_at FROM settings WHERE key = ? AND secret = 1", (key,))
        return int(row["updated_at"]) if row and row.get("updated_at") else None

    def agent_tool_token(self, actor: dict[str, Any]) -> dict[str, str]:
        require_admin(actor)
        return {"token": self.get_setting("agent_tool_token") or ""}

    def validate_agent_tool_token(self, token: str | None) -> bool:
        expected = self.get_setting("agent_tool_token") or self.config.agent_tool_token
        return bool(token and expected and secrets.compare_digest(token, expected))

    def agent_status(self, actor: dict[str, Any], scope_type: str, scope_id: str) -> dict[str, Any]:
        scope_type, scope_id = self._normalize_conversation(actor, scope_type, scope_id)
        key = self._conversation_key(scope_type, scope_id)
        with self._conversation_lock:
            status = self._agent_status.get(key) or self._idle_agent_status(scope_type, scope_id)
            return self._copy_status(status)

    def update_typing(self, actor: dict[str, Any], scope_type: str, scope_id: str, typing: bool) -> dict[str, Any]:
        scope_type, scope_id = self._normalize_conversation(actor, scope_type, scope_id)
        if scope_type == "channel":
            require_permission(actor, PERMISSION_CHAT)
        key = self._conversation_key(scope_type, scope_id)
        with self._conversation_lock:
            users = self._typing.setdefault(key, {})
            if typing:
                users[int(actor["id"])] = {
                    "user_id": int(actor["id"]),
                    "username": actor.get("display_name") or actor.get("username") or "User",
                    "updated_at": now_ts(),
                    "expires_at": time.time() + 5,
                }
            else:
                users.pop(int(actor["id"]), None)
            return {"typing": self._typing_users_locked(key, exclude_user_id=int(actor["id"]))}

    def typing_users(self, actor: dict[str, Any], scope_type: str, scope_id: str) -> list[dict[str, Any]]:
        scope_type, scope_id = self._normalize_conversation(actor, scope_type, scope_id)
        key = self._conversation_key(scope_type, scope_id)
        with self._conversation_lock:
            return self._typing_users_locked(key, exclude_user_id=int(actor["id"]))

    def wait_for_agent_idle(self, scope_type: str, scope_id: str, timeout: float = 5) -> dict[str, Any]:
        key = self._conversation_key(scope_type, str(scope_id))
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self._conversation_lock:
                worker = self._agent_workers.get(key)
                status = self._copy_status(self._agent_status.get(key) or self._idle_agent_status(scope_type, str(scope_id)))
            if status["state"] == "idle" and (worker is None or not worker.is_alive()):
                return status
            if worker is not None:
                worker.join(timeout=0.05)
            else:
                time.sleep(0.05)
        with self._conversation_lock:
            return self._copy_status(self._agent_status.get(key) or self._idle_agent_status(scope_type, str(scope_id)))

    def _prune_agent_status_locked(self) -> None:
        """Drop the oldest idle conversation statuses once the cap is exceeded.

        Must be called while holding ``_conversation_lock``. Only conversations
        that are idle with no queued work and no live worker are eligible, so an
        active or queued conversation is never evicted.
        """
        if len(self._agent_status) <= MAX_TRACKED_CONVERSATIONS:
            return
        prunable = [
            (status.get("updated_at") or 0, key)
            for key, status in self._agent_status.items()
            if status.get("state") == "idle"
            and not self._agent_queues.get(key)
            and not (self._agent_workers.get(key) and self._agent_workers[key].is_alive())
        ]
        prunable.sort()
        excess = len(self._agent_status) - MAX_TRACKED_CONVERSATIONS
        for _, key in prunable[:excess]:
            self._agent_status.pop(key, None)
            # These keys are idle with no queued work and no live worker, so the
            # companion entries (if any) are empty residue; drop them too.
            self._drop_empty_conversation_maps_locked(key)

    def _enqueue_agent_reply(self, task: dict[str, Any]) -> dict[str, Any]:
        scope_type = str(task["scope_type"])
        scope_id = str(task["scope_id"])
        key = self._conversation_key(scope_type, scope_id)
        with self._conversation_lock:
            if self._closed:
                raise ServiceError(503, "service is shutting down")
            queue = self._agent_queues.setdefault(key, deque())
            if len(queue) >= MAX_AGENT_QUEUE_DEPTH:
                raise ServiceError(429, "agent is busy; too many queued messages for this conversation")
            queue.append(task)
            status = self._agent_status.get(key)
            if not status or status.get("state") == "idle":
                status = self._status_for_task(task, "queued", queued_count=len(queue))
            else:
                status = dict(status)
                status["queued_count"] = len(queue)
                status["updated_at"] = now_ts()
            self._agent_status[key] = status
            self._prune_agent_status_locked()

            worker = self._agent_workers.get(key)
            if worker is None or not worker.is_alive():
                worker = threading.Thread(target=self._agent_worker, args=(key,), name=f"agent-reply-{key}", daemon=True)
                self._agent_workers[key] = worker
                worker.start()
            return self._copy_status(status)

    def _agent_worker(self, key: str) -> None:
        # Wrapped in try/finally so the worker is always unregistered (and any
        # empty queue dropped) even on an unexpected BaseException, preventing a
        # conversation from being stuck in a non-idle state with a dead worker.
        try:
            while True:
                with self._conversation_lock:
                    queue = self._agent_queues.get(key)
                    if self._closed or not queue:
                        scope_type, scope_id = self._split_conversation_key(key)
                        self._agent_status[key] = self._idle_agent_status(scope_type, scope_id)
                        self._drop_empty_conversation_maps_locked(key)
                        self._agent_workers.pop(key, None)
                        return
                    task = queue.popleft()
                    self._agent_status[key] = self._status_for_task(task, "replying", queued_count=len(queue))

                error = ""
                error_persisted = True
                try:
                    # Only N replies hit the Hermes backend (and hold a thread /
                    # socket) at once; each conversation still drains its own
                    # queue in FIFO order while queued runs wait on the semaphore.
                    with self._agent_run_semaphore:
                        if task["scope_type"] == "channel":
                            self._send_channel_agent_reply(task)
                        else:
                            self._send_private_agent_reply(task)
                except Exception as exc:
                    error = str(exc)
                    try:
                        self._append_agent_error(task, error)
                    except Exception as persist_exc:
                        # The user-facing error message could not be persisted
                        # (e.g. transient DB lock). Surface the secondary failure
                        # instead of swallowing it so the conversation does not
                        # silently fall idle with nothing rendered.
                        error_persisted = False
                        print(
                            f"Failed to persist agent error for {key}: {persist_exc}",
                            file=sys.stderr,
                        )

                with self._conversation_lock:
                    queue = self._agent_queues.get(key)
                    if queue:
                        self._agent_status[key] = self._status_for_task(queue[0], "queued", queued_count=len(queue))
                        continue
                    scope_type, scope_id = self._split_conversation_key(key)
                    idle = self._idle_agent_status(scope_type, scope_id, last_error=error)
                    if error and not error_persisted:
                        # Keep a visible terminal error state: with no persisted
                        # message and no live bubble the failure would otherwise
                        # vanish from the UI entirely.
                        idle["state"] = "error"
                        idle["current_step"] = "Agent 回复失败"
                        idle["activity"] = [
                            {
                                "stage": "error",
                                "source": "platform",
                                "label": "Agent 回复失败",
                                "detail": error[:180],
                                "line": agent_work_line("error", "Agent 回复失败", error[:180]),
                                "at": now_ts(),
                            }
                        ]
                    self._agent_status[key] = idle
                    self._drop_empty_conversation_maps_locked(key)
                    self._agent_workers.pop(key, None)
                    return
        finally:
            with self._conversation_lock:
                worker = self._agent_workers.get(key)
                if worker is None or worker is threading.current_thread():
                    self._agent_workers.pop(key, None)
                    if not self._agent_queues.get(key):
                        self._agent_queues.pop(key, None)

    def _drop_empty_conversation_maps_locked(self, key: str) -> None:
        """Remove empty companion-map entries for a conversation key.

        Must be called while holding ``_conversation_lock``. ``_agent_status`` is
        bounded separately by ``_prune_agent_status_locked``; this keeps the
        unbounded companion maps (queues / typing) consistent with that cap.
        """
        if not self._agent_queues.get(key):
            self._agent_queues.pop(key, None)
        if not self._typing.get(key):
            self._typing.pop(key, None)

    def _append_agent_error(self, task: dict[str, Any], error: str) -> None:
        username = "Main Agent" if task["scope_type"] == "channel" else "Private Agent"
        self._record_agent_activity(str(task["scope_type"]), str(task["scope_id"]), "error", "Agent 回复失败", error[:180])
        metadata = {"error": error, "reply_to": self._reply_target(task)}
        metadata["agent_work"] = self._agent_work_snapshot(task, state="error")
        self._append_message(
            scope_type=str(task["scope_type"]),
            scope_id=str(task["scope_id"]),
            author_type="agent",
            user_id=None,
            username=username,
            content=f"Agent 回复失败: {error}",
            metadata=metadata,
        )

    def _normalize_conversation(self, actor: dict[str, Any], scope_type: str, scope_id: str) -> tuple[str, str]:
        scope_type = str(scope_type).strip().lower()
        scope_id = str(scope_id)
        if scope_type == "channel":
            require_permission(actor, PERMISSION_READ_WORKSPACE)
            self.get_channel(actor, int(scope_id))
            return "channel", scope_id
        if scope_type == "private":
            require_permission(actor, PERMISSION_PRIVATE_AGENT)
            if scope_id != str(actor["id"]):
                raise ServiceError(403, "private agent conversation is user scoped")
            return "private", scope_id
        raise ServiceError(400, "unsupported message scope")

    @staticmethod
    def _conversation_key(scope_type: str, scope_id: str) -> str:
        return f"{scope_type}:{scope_id}"

    @staticmethod
    def _split_conversation_key(key: str) -> tuple[str, str]:
        scope_type, _, scope_id = key.partition(":")
        return scope_type, scope_id

    def _status_for_task(self, task: dict[str, Any], state: str, queued_count: int) -> dict[str, Any]:
        label = "等待 Agent 处理" if state == "queued" else "开始处理 Agent 请求"
        started_at = now_ts()
        return {
            "scope_type": str(task["scope_type"]),
            "scope_id": str(task["scope_id"]),
            "run_id": self._run_id_for_task(task),
            "state": state,
            "replying_to": self._reply_target(task),
            "queued_count": queued_count,
            "activity": [
                {
                    "stage": state,
                    "source": "platform",
                    "label": label,
                    "detail": "",
                    "line": agent_work_line(state, label, ""),
                    "at": started_at,
                }
            ],
            "current_step": label,
            "started_at": started_at,
            "updated_at": started_at,
            "last_error": "",
            "stream_messages": [],
            "stream_message": None,
        }

    @staticmethod
    def _idle_agent_status(scope_type: str, scope_id: str, last_error: str = "") -> dict[str, Any]:
        return {
            "scope_type": scope_type,
            "scope_id": str(scope_id),
            "run_id": "",
            "state": "idle",
            "replying_to": None,
            "queued_count": 0,
            "activity": [],
            "current_step": "",
            "started_at": None,
            "updated_at": now_ts(),
            "last_error": last_error,
            "stream_messages": [],
            "stream_message": None,
        }

    @staticmethod
    def _copy_status(status: dict[str, Any]) -> dict[str, Any]:
        copied = dict(status)
        if copied.get("replying_to"):
            copied["replying_to"] = dict(copied["replying_to"])
        copied["activity"] = [dict(item) for item in copied.get("activity") or []]
        copied["stream_messages"] = [dict(item) for item in copied.get("stream_messages") or []]
        if copied.get("stream_message"):
            copied["stream_message"] = dict(copied["stream_message"])
        return copied

    def _record_agent_activity(
        self,
        scope_type: str,
        scope_id: str,
        stage: str,
        label: str,
        detail: str = "",
        *,
        source: str = "platform",
        line: str | None = None,
    ) -> None:
        key = self._conversation_key(scope_type, str(scope_id))
        timestamp = now_ts()
        with self._conversation_lock:
            status = dict(self._agent_status.get(key) or self._idle_agent_status(scope_type, str(scope_id)))
            activity = [dict(item) for item in status.get("activity") or []]
            activity.append(
                {
                    "stage": stage,
                    "source": source,
                    "label": label,
                    "detail": detail,
                    "line": line if line is not None else agent_work_line(stage, label, detail),
                    "at": timestamp,
                }
            )
            status["activity"] = activity[-30:]
            status["current_step"] = label
            status["updated_at"] = timestamp
            self._agent_status[key] = status

    @staticmethod
    def _finalize_stream_message(status: dict[str, Any], timestamp: int) -> dict[str, Any]:
        stream = dict(status.get("stream_message") or {})
        content = str(stream.get("content") or "")
        if not content:
            status["stream_message"] = None
            return status
        stream["active"] = False
        stream["updated_at"] = timestamp
        segments = [dict(item) for item in status.get("stream_messages") or []]
        if not segments or segments[-1].get("id") != stream.get("id"):
            segments.append(stream)
        else:
            segments[-1] = stream
        status["stream_messages"] = segments[-8:]
        status["stream_message"] = None
        return status

    def _record_agent_content_delta(self, scope_type: str, scope_id: str, delta: str | None) -> None:
        key = self._conversation_key(scope_type, str(scope_id))
        timestamp = now_ts()
        with self._conversation_lock:
            status = dict(self._agent_status.get(key) or self._idle_agent_status(scope_type, str(scope_id)))
            if delta is None:
                status = self._finalize_stream_message(status, timestamp)
                status["updated_at"] = timestamp
                self._agent_status[key] = status
                return
            delta = str(delta or "")
            if not delta:
                return
            stream = dict(status.get("stream_message") or {})
            stream.setdefault(
                "id",
                f"stream:{status.get('run_id') or key}:{status.get('started_at') or timestamp}:"
                f"{len(status.get('stream_messages') or [])}",
            )
            stream.setdefault("author_type", "agent")
            stream.setdefault("username", "Main Agent" if scope_type == "channel" else "Private Agent")
            stream.setdefault("created_at", status.get("started_at") or timestamp)
            stream["content"] = str(stream.get("content") or "") + delta
            stream["updated_at"] = timestamp
            stream["active"] = True
            status["stream_message"] = stream
            status["updated_at"] = timestamp
            self._agent_status[key] = status

    def _record_hermes_progress(self, scope_type: str, scope_id: str, event: dict[str, Any]) -> None:
        if not isinstance(event, dict):
            return
        tool = str(event.get("tool") or event.get("tool_name") or "tool").strip() or "tool"
        label = str(event.get("label") or event.get("preview") or tool).strip() or tool
        tool_call_id = str(event.get("toolCallId") or event.get("tool_call_id") or event.get("id") or "").strip()
        tool_status = str(event.get("status") or event.get("event_type") or "running").strip().lower()
        timestamp = now_ts()
        key = self._conversation_key(scope_type, str(scope_id))
        with self._conversation_lock:
            status = dict(self._agent_status.get(key) or self._idle_agent_status(scope_type, str(scope_id)))
            activity = [dict(item) for item in status.get("activity") or []]
            if tool_status in {"completed", "complete", "done", "tool.completed"}:
                updated = False
                if tool_call_id:
                    for item in reversed(activity):
                        if item.get("source") == "hermes" and item.get("tool_call_id") == tool_call_id:
                            item["tool_status"] = "completed"
                            item["completed_at"] = timestamp
                            updated = True
                            break
                if updated:
                    status["activity"] = activity[-30:]
                    status["current_step"] = f"完成 {tool}"
                    status["updated_at"] = timestamp
                    self._agent_status[key] = status
                return

            line = hermes_progress_line(event)
            existing = None
            if tool_call_id:
                for item in reversed(activity):
                    if item.get("source") == "hermes" and item.get("tool_call_id") == tool_call_id:
                        existing = item
                        break
            item_data = {
                "stage": "tool",
                "source": "hermes",
                "label": tool,
                "detail": label,
                "line": line,
                "tool": tool,
                "tool_call_id": tool_call_id,
                "tool_status": "running",
                "at": timestamp,
            }
            if existing is not None:
                existing.update(item_data)
            else:
                activity.append(item_data)
            if is_substantive_tool_start(event):
                status = self._finalize_stream_message(status, timestamp)
            status["activity"] = activity[-30:]
            status["current_step"] = line
            status["updated_at"] = timestamp
            self._agent_status[key] = status

    def _agent_work_snapshot(self, task: dict[str, Any], state: str) -> dict[str, Any]:
        key = self._conversation_key(str(task["scope_type"]), str(task["scope_id"]))
        with self._conversation_lock:
            status = self._copy_status(self._agent_status.get(key) or self._idle_agent_status(str(task["scope_type"]), str(task["scope_id"])))
        return {
            "run_id": self._run_id_for_task(task),
            "state": state,
            "replying_to": self._reply_target(task),
            "activity": status.get("activity") or [],
            "current_step": status.get("current_step") or "",
            "started_at": status.get("started_at"),
            "updated_at": status.get("updated_at"),
        }

    @staticmethod
    def _run_id_for_task(task: dict[str, Any]) -> str:
        message = task["user_message"]
        return f"{task['scope_type']}:{task['scope_id']}:{message['id']}"

    @staticmethod
    def _reply_target(task: dict[str, Any]) -> dict[str, Any]:
        actor = task["actor"]
        message = task["user_message"]
        content = str(task.get("content") or "")
        if not content and task.get("attachments"):
            names = ", ".join(str(item.get("filename") or "attachment") for item in list(task.get("attachments") or [])[:3])
            content = f"attachments: {names}" if names else "attachments"
        return {
            "message_id": int(message["id"]),
            "user_id": int(actor["id"]),
            "username": actor.get("display_name") or actor.get("username") or "User",
            "content_preview": content[:120],
        }

    def _typing_users_locked(self, key: str, exclude_user_id: int | None = None) -> list[dict[str, Any]]:
        users = self._typing.get(key, {})
        now = time.time()
        expired = [user_id for user_id, item in users.items() if float(item.get("expires_at", 0)) <= now]
        for user_id in expired:
            users.pop(user_id, None)
        result = [
            {"user_id": item["user_id"], "username": item["username"], "updated_at": item["updated_at"]}
            for user_id, item in users.items()
            if exclude_user_id is None or user_id != exclude_user_id
        ]
        # Drop the now-empty outer entry so per-conversation typing state does not
        # accumulate forever (update_typing's setdefault recreates it on demand).
        if not users:
            self._typing.pop(key, None)
        return result

    def _append_message(
        self,
        *,
        scope_type: str,
        scope_id: str,
        author_type: str,
        user_id: int | None,
        username: str,
        content: str,
        metadata: dict[str, Any],
        attachments: list[UploadedFile] | None = None,
        attachment_source: str = "upload",
    ) -> dict[str, Any]:
        attachments = list(attachments or [])
        metadata = dict(metadata)
        if attachments:
            metadata["attachment_count"] = len(attachments)
        msg_id = self.db.insert(
            """
            INSERT INTO messages(scope_type, scope_id, author_type, user_id, username, content, metadata_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (scope_type, str(scope_id), author_type, user_id, username, content, encode_json(metadata), now_ts()),
        )
        if attachments:
            try:
                self._store_attachments(
                    message_id=msg_id,
                    scope_type=scope_type,
                    scope_id=str(scope_id),
                    uploader_user_id=user_id,
                    source=attachment_source,
                    attachments=attachments,
                )
            except Exception:
                # The message row is already committed with attachment_count=N
                # but the blobs/rows failed to land. Remove the orphaned message
                # (ON DELETE CASCADE clears any partial attachment rows) so we do
                # not leave a message claiming attachments that do not exist.
                try:
                    self.db.execute("DELETE FROM messages WHERE id = ?", (int(msg_id),))
                except Exception:
                    pass
                raise
        row = self.db.query_one("SELECT * FROM messages WHERE id = ?", (msg_id,))
        return self._message_from_row(row)

    def _normalize_uploaded_files(self, attachments: list[UploadedFile] | None) -> list[UploadedFile]:
        if not attachments:
            return []
        if len(attachments) > MAX_ATTACHMENTS_PER_MESSAGE:
            raise ServiceError(400, f"at most {MAX_ATTACHMENTS_PER_MESSAGE} attachments are allowed")
        normalized = []
        for item in attachments:
            data = bytes(item.data or b"")
            if not data:
                raise ServiceError(400, "attachment is empty")
            if len(data) > MAX_ATTACHMENT_BYTES:
                raise ServiceError(413, f"attachment exceeds {MAX_ATTACHMENT_BYTES // (1024 * 1024)} MB")
            filename = sanitize_attachment_filename(item.filename)
            content_type = normalize_attachment_mime(filename, item.content_type)
            normalized.append(UploadedFile(filename=filename, content_type=content_type, data=data))
        return normalized

    def _store_attachments(
        self,
        *,
        message_id: int,
        scope_type: str,
        scope_id: str,
        uploader_user_id: int | None,
        source: str,
        attachments: list[UploadedFile],
    ) -> None:
        self._enforce_attachment_quota(uploader_user_id, attachments)
        root = self._attachment_root()
        target_dir = root / scope_type / str(scope_id)
        target_dir.mkdir(parents=True, exist_ok=True)
        timestamp = now_ts()
        written: list[Path] = []
        try:
            for attachment in attachments:
                digest = hashlib.sha256(attachment.data).hexdigest()
                ext = safe_attachment_suffix(attachment.filename)
                storage_path = f"{scope_type}/{scope_id}/{message_id}-{secrets.token_urlsafe(12)}{ext}"
                target = root / storage_path
                target.write_bytes(attachment.data)
                written.append(target)
                self.db.insert(
                    """
                    INSERT INTO attachments(
                        message_id, scope_type, scope_id, uploader_user_id, source,
                        filename, storage_path, mime_type, size_bytes, sha256, created_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        message_id,
                        scope_type,
                        str(scope_id),
                        uploader_user_id,
                        source,
                        attachment.filename,
                        storage_path,
                        attachment.content_type,
                        len(attachment.data),
                        digest,
                        timestamp,
                    ),
                )
        except Exception:
            # Roll back every file written in this batch so a mid-batch failure
            # does not leave orphan blobs on disk. The attachment rows for this
            # message are removed by the caller via ON DELETE CASCADE.
            for path in written:
                try:
                    path.unlink()
                except OSError:
                    pass
            raise

    def _enforce_attachment_quota(self, uploader_user_id: int | None, attachments: list[UploadedFile]) -> None:
        """Reject uploads that would exceed the per-uploader storage budget."""
        if ATTACHMENT_QUOTA_BYTES <= 0 or uploader_user_id is None:
            return
        incoming = sum(len(attachment.data) for attachment in attachments)
        if incoming <= 0:
            return
        existing = self.db.scalar(
            "SELECT COALESCE(SUM(size_bytes), 0) FROM attachments WHERE uploader_user_id = ?",
            (int(uploader_user_id),),
        )
        if int(existing or 0) + incoming > ATTACHMENT_QUOTA_BYTES:
            raise ServiceError(413, "attachment storage quota exceeded")

    def _enforce_upload_rate_limit(self, uploader_user_id: int | None) -> None:
        """Sliding-window per-user rate limit for attachment-bearing messages."""
        if MAX_UPLOADS_PER_WINDOW <= 0 or uploader_user_id is None:
            return
        now = time.time()
        cutoff = now - UPLOAD_RATE_LIMIT_WINDOW_SECONDS
        with self._auth_lock:
            timestamps = self._upload_rate.setdefault(int(uploader_user_id), deque())
            while timestamps and timestamps[0] < cutoff:
                timestamps.popleft()
            if len(timestamps) >= MAX_UPLOADS_PER_WINDOW:
                raise ServiceError(429, "upload rate limit exceeded; try again later")
            timestamps.append(now)

    def _attachments_for_message(self, message_id: int, *, include_local_path: bool = False) -> list[dict[str, Any]]:
        rows = self.db.query(
            "SELECT * FROM attachments WHERE message_id = ? ORDER BY id",
            (int(message_id),),
        )
        return [self._attachment_from_row(row, include_local_path=include_local_path) for row in rows]

    def _delete_attachment_files_for_messages(self, message_ids: list[int]) -> None:
        ids = [int(message_id) for message_id in message_ids if int(message_id) > 0]
        if not ids:
            return
        placeholders = ",".join("?" for _ in ids)
        rows = self.db.query(
            f"SELECT storage_path FROM attachments WHERE message_id IN ({placeholders})",
            ids,
        )
        root = self._attachment_root().resolve()
        for row in rows:
            path = (root / str(row["storage_path"])).resolve()
            if root != path and root not in path.parents:
                continue
            try:
                path.unlink()
            except OSError:
                pass

    def get_attachment_file(self, actor: dict[str, Any], attachment_id: int) -> tuple[dict[str, Any], Path]:
        row = self.db.query_one("SELECT * FROM attachments WHERE id = ?", (int(attachment_id),))
        if not row:
            raise ServiceError(404, "attachment not found")
        self._authorize_attachment(actor, row)
        root = self._attachment_root().resolve()
        path = (root / str(row["storage_path"])).resolve()
        if root != path and root not in path.parents:
            raise ServiceError(404, "attachment not found")
        if not path.exists() or not path.is_file():
            raise ServiceError(404, "attachment file is missing")
        return self._attachment_from_row(row), path

    def _authorize_attachment(self, actor: dict[str, Any], row: dict[str, Any]) -> None:
        scope_type = str(row["scope_type"])
        scope_id = str(row["scope_id"])
        if scope_type == "channel":
            require_permission(actor, PERMISSION_READ_WORKSPACE)
            self.get_channel(actor, int(scope_id))
            return
        if scope_type == "private":
            if scope_id == str(actor["id"]):
                require_permission(actor, PERMISSION_PRIVATE_AGENT)
                return
            require_admin(actor)
            return
        raise ServiceError(400, "unsupported attachment scope")

    def _attachment_from_row(self, row: dict[str, Any], *, include_local_path: bool = False) -> dict[str, Any]:
        mime_type = str(row.get("mime_type") or "application/octet-stream")
        item = {
            "id": int(row["id"]),
            "message_id": int(row["message_id"]),
            "scope_type": row["scope_type"],
            "scope_id": row["scope_id"],
            "source": row["source"],
            "filename": row["filename"],
            "mime_type": mime_type,
            "size_bytes": int(row["size_bytes"] or 0),
            "sha256": row["sha256"],
            "created_at": row["created_at"],
            "is_image": is_safe_inline_attachment_mime(mime_type),
            "url": f"/api/attachments/{int(row['id'])}",
            "download_url": f"/api/attachments/{int(row['id'])}?download=1",
        }
        if include_local_path:
            item["local_path"] = str(self._attachment_root() / str(row["storage_path"]))
        return item

    def _attachment_root(self) -> Path:
        root = self.config.data_dir / "attachments"
        root.mkdir(parents=True, exist_ok=True)
        return root

    def _agent_prompt_content(
        self,
        content: str,
        attachments: list[dict[str, Any]],
        *,
        default: str,
    ) -> str:
        text = str(content or "").strip() or default
        lines = self._attachment_context_lines(attachments, include_local_paths=True)
        if lines:
            return f"{text}\n\n" + "\n".join(lines)
        return text

    def _attachment_context_lines(
        self,
        attachments: list[dict[str, Any]],
        *,
        include_local_paths: bool = False,
    ) -> list[str]:
        lines = []
        for attachment in attachments:
            kind = "image" if attachment.get("is_image") else "file"
            filename = str(attachment.get("filename") or "attachment")
            mime_type = str(attachment.get("mime_type") or "application/octet-stream")
            size = format_bytes(int(attachment.get("size_bytes") or 0))
            line = f"[User attached {kind}: {filename} ({mime_type}, {size})"
            local_path = str(attachment.get("local_path") or "").strip()
            if include_local_paths and local_path:
                line += f"; local path: {local_path}"
            line += "]"
            lines.append(line)
        return lines

    @staticmethod
    def _attachment_metadata_for_agent(attachments: list[dict[str, Any]]) -> list[dict[str, Any]]:
        keys = ("id", "filename", "mime_type", "size_bytes", "sha256", "is_image", "local_path")
        return [{key: item[key] for key in keys if key in item} for item in attachments]

    def _managed_media_tmp_dir(self) -> Path:
        """Dedicated scratch dir for managed-Hermes generated media.

        Lives under the platform data dir (not the shared system temp dir) so
        Hermes can write generated files here without those files being readable
        across tenants/processes. Managed Hermes should be pointed at this via
        ``TMPDIR`` in its process environment.
        """
        return self.config.managed_hermes_home / "tmp"

    def _media_safe_data_subtrees(self, owner_id: int | None) -> list[Path]:
        """Subtrees under the platform data dir that ARE safe to read media from
        (the agent's own workspace, the managed Hermes generated-media cache, and
        the dedicated managed media scratch dir), used to keep platform secrets
        unreadable even when the data dir overlaps another allowed root."""
        if owner_id is not None:
            workspace = self.config.workspace_dir / f"user-{int(owner_id)}"
        else:
            workspace = self.config.workspace_dir
        subtrees: list[Path] = []
        for path in (
            workspace,
            self.config.managed_hermes_home / "cache",
            self._managed_media_tmp_dir(),
        ):
            try:
                subtrees.append(path.resolve())
            except OSError:
                continue
        return subtrees

    def _media_allowed_roots(self, owner_id: int | None) -> list[Path]:
        """Directories the platform will read agent-generated media from.

        For a private conversation only the owning user's workspace is allowed;
        a shared channel allows the whole workspace tree. Managed Hermes writes
        generated documents/images/audio under its cache and the dedicated
        managed media scratch dir, so those subtrees are allowed, plus any
        operator-configured ``ENTERPRISE_MEDIA_ROOTS``. The broad system temp dir
        is intentionally NOT allowed: it is shared with other processes/users on
        the host, so allowing it would let a prompt-injected agent exfiltrate
        arbitrary readable temp files via ``MEDIA:`` tags. Platform secrets
        elsewhere under the data directory (``platform.db``, the managed Hermes
        ``.env``, the bootstrap admin password) are never readable — see
        ``_resolve_media_path``.
        """
        candidates = list(self._media_safe_data_subtrees(owner_id))
        for raw in os.getenv("ENTERPRISE_MEDIA_ROOTS", "").split(os.pathsep):
            raw = raw.strip()
            if raw:
                candidates.append(Path(raw).expanduser())
        roots: list[Path] = []
        for candidate in candidates:
            try:
                roots.append(candidate.resolve())
            except OSError:
                continue
        return roots

    def _resolve_media_path(self, raw_path: str, owner_id: int | None) -> Path | None:
        """Resolve a model-supplied MEDIA: path, confining it to allowed roots.

        Symlinks are resolved before the containment check so a symlink inside
        an allowed root cannot point at a sensitive file outside it. Returns the
        resolved path only when it is a regular file under an allowed media root
        AND not a platform secret under the data dir; otherwise returns None.
        """
        try:
            candidate = Path(os.path.expanduser(raw_path)).resolve()
        except OSError:
            return None
        if not candidate.is_file():
            return None
        roots = self._media_allowed_roots(owner_id)
        if not any(candidate == root or candidate.is_relative_to(root) for root in roots):
            return None
        # Even within an allowed root (e.g. the temp dir overlapping a data dir
        # that an operator relocated under /tmp), never serve platform secrets:
        # reject anything under the data dir except the explicitly safe subtrees.
        try:
            data_root = self.config.data_dir.resolve()
        except OSError:
            return candidate
        if candidate == data_root or candidate.is_relative_to(data_root):
            safe = self._media_safe_data_subtrees(owner_id)
            if not any(candidate == s or candidate.is_relative_to(s) for s in safe):
                return None
        return candidate

    def _extract_generated_attachments(
        self, content: str, owner_id: int | None = None
    ) -> tuple[str, list[UploadedFile]]:
        content = str(content or "")
        attachments: list[UploadedFile] = []
        missing: list[str] = []
        refused: list[str] = []
        for match in MEDIA_TAG_RE.finditer(content):
            raw_path = clean_media_path(match.group("path"))
            if not raw_path:
                continue
            path = self._resolve_media_path(raw_path, owner_id)
            if path is None:
                # Distinguish "file is gone" from "file is outside the sandbox"
                # for diagnostics, without reading anything out of scope.
                try:
                    exists = Path(os.path.expanduser(raw_path)).exists()
                except OSError:
                    exists = False
                (refused if exists else missing).append(raw_path)
                continue
            try:
                if path.stat().st_size > MAX_ATTACHMENT_BYTES:
                    refused.append(raw_path)
                    continue
                data = path.read_bytes()
                attachments.extend(
                    self._normalize_uploaded_files(
                        [UploadedFile(path.name, normalize_attachment_mime(path.name, ""), data)]
                    )
                )
            except Exception:
                missing.append(raw_path)

        if not attachments and not missing and not refused:
            return content, []

        cleaned = MEDIA_TAG_RE.sub("", content)
        cleaned = cleaned.replace("[[audio_as_voice]]", "").replace("[[as_document]]", "")
        cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
        notes: list[str] = []
        if missing:
            notes.append("Hermes returned file path(s) that the platform could not read: " + ", ".join(missing[:5]))
        if refused:
            notes.append(
                "Hermes returned file path(s) outside the allowed media directories; they were not shared: "
                + ", ".join(refused[:5])
            )
        if notes:
            cleaned = (cleaned + "\n\n" + "\n".join(notes)).strip()
        return cleaned, attachments

    def _message_from_row(self, row: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": int(row["id"]),
            "scope_type": row["scope_type"],
            "scope_id": row["scope_id"],
            "author_type": row["author_type"],
            "user_id": row["user_id"],
            "username": row["username"],
            "content": row["content"],
            "metadata": decode_json(row["metadata_json"]),
            "attachments": self._attachments_for_message(int(row["id"])),
            "created_at": row["created_at"],
        }

    @staticmethod
    def _hermes_owned_history() -> list[dict[str, str]]:
        """Hermes owns transcript continuity and context compression."""
        return []

    @staticmethod
    def _default_channel_agent_session_id(scope_id: str) -> str:
        return f"enterprise-channel-{scope_id}-main-agent"

    @staticmethod
    def _valid_hermes_session_id(session_id: str | None) -> bool:
        if not isinstance(session_id, str):
            return False
        if not session_id or len(session_id) > MAX_HERMES_SESSION_ID_LENGTH:
            return False
        return not any(ch in session_id for ch in "\r\n\x00")

    def _channel_agent_session_id(self, scope_id: str) -> str:
        stored = self.get_setting(f"{HERMES_CHANNEL_SESSION_SETTING_PREFIX}{scope_id}:main-agent")
        if self._valid_hermes_session_id(stored):
            return str(stored)
        return self._default_channel_agent_session_id(scope_id)

    def _remember_channel_agent_session_id(self, scope_id: str, session_id: str | None) -> None:
        if self._valid_hermes_session_id(session_id):
            self.set_setting(f"{HERMES_CHANNEL_SESSION_SETTING_PREFIX}{scope_id}:main-agent", str(session_id))

    def _recent_context(self, scope_type: str, scope_id: str, content: str) -> str:
        messages = self._messages_for_scope(scope_type, scope_id, limit=12)
        return "\n".join([m["content"] for m in messages] + [content])

    def _recent_context_before(
        self,
        scope_type: str,
        scope_id: str,
        content: str,
        before_message_id: int,
        current_speaker: str = "",
    ) -> str:
        rows = self.db.query(
            """
            SELECT * FROM messages
            WHERE scope_type = ? AND scope_id = ? AND id < ?
            ORDER BY id DESC
            LIMIT 12
            """,
            (scope_type, str(scope_id), int(before_message_id)),
        )
        messages = [self._message_from_row(row) for row in reversed(rows)]
        current = f"{current_speaker}: {content}" if current_speaker else content
        return "\n".join([self._history_message_content(m) for m in messages] + [current])

    @staticmethod
    def _actor_display_name(actor: dict[str, Any]) -> str:
        return str(actor.get("display_name") or actor.get("username") or "User")

    def _channel_speaker_line(self, actor: dict[str, Any], content: str) -> str:
        return f"{self._actor_context_label(actor)}: {content}"

    def _actor_context_label(
        self,
        actor: dict[str, Any],
        *,
        include_username: bool = False,
        include_empty_position: bool = False,
    ) -> str:
        label = self._actor_display_name(actor)
        username = str(actor.get("username") or "").strip()
        if include_username and username:
            label = f"{label} (@{username})"
        position = str(actor.get("position") or "").strip()
        if position or include_empty_position:
            label = f"{label}，职位: {position or '未设置'}"
        return label

    @staticmethod
    def _history_message_content(message: dict[str, Any]) -> str:
        content = str(message.get("content") or "")
        attachments = message.get("attachments") or []
        if attachments:
            lines = []
            for attachment in attachments:
                kind = "image" if attachment.get("is_image") else "file"
                lines.append(
                    f"[Attached {kind}: {attachment.get('filename')} "
                    f"({attachment.get('mime_type')}, {format_bytes(int(attachment.get('size_bytes') or 0))})]"
                )
            content = f"{content}\n" + "\n".join(lines) if content else "\n".join(lines)
        if message.get("scope_type") != "channel":
            return content
        speaker = str(message.get("username") or ("Agent" if message.get("author_type") == "agent" else "User"))
        return f"{speaker}: {content}"

    def _channel_system_prompt(self, channel: dict[str, Any], suggestions) -> str:
        passive = format_passive_suggestions(suggestions)
        return (
            "你是 ubitech 的企业级 Agent。对外介绍自己时，只说自己是 ubitech 的企业级 Agent；"
            "不要提及底层框架、运行时、模型供应商或内部实现。\n"
            f"当前工作模式: 频道协作。频道: #{channel['name']}。请保留上下文连续性，明确区分用户请求和企业事实。\n"
            "企业知识库已作为工具暴露给你: enterprise_kb_search(query, limit) 与 enterprise_kb_read(document_id)。\n"
            "当提示中出现 kb:<id> 时，优先用 enterprise_kb_read 读取完整条目再作答。\n"
            f"{passive}"
        )

    def _private_system_prompt(self, actor: dict[str, Any], container: dict[str, Any], suggestions) -> str:
        passive = format_passive_suggestions(suggestions)
        return (
            "你是 ubitech 的企业级 Agent。对外介绍自己时，只说自己是 ubitech 的企业级 Agent；"
            "不要提及底层框架、运行时、模型供应商或内部实现。\n"
            "当前工作模式: 私人助手。每个用户拥有隔离会话和自动管理的工作容器。\n"
            f"当前用户: {self._actor_context_label(actor, include_username=True, include_empty_position=True)}。\n"
            f"工作区: {container['workspace_path']}；容器状态: {container['container_status']}；会话: {container['session_id']}。\n"
            "模型密钥由平台集中配置，不要要求用户再次提供密钥。\n"
            "企业知识库工具: enterprise_kb_search(query, limit) 与 enterprise_kb_read(document_id)。\n"
            f"{passive}"
        )


def _dedupe_knowledge_hits(hits: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop hits that share the same id key, preserving order.

    This only collapses duplicates within a single keyspace (e.g. a local
    document id repeated in the local results). Local hits use integer document
    ids while Cognee hits use synthetic ``cognee:N`` string ids, so the two
    keyspaces never collide and local vs Cognee results are NEVER collapsed
    together. True cross-backend dedup is not possible here because Cognee
    returns synthesized graph chunks with no recoverable source-document
    identity (constant title/source), so there is no key to match them on.
    """
    seen: set[str] = set()
    result: list[dict[str, Any]] = []
    for hit in hits:
        key = str(hit.get("id"))
        if key in seen:
            continue
        seen.add(key)
        result.append(hit)
    return result


_USAGE_INPUT_KEYS = ("input_tokens", "prompt_tokens", "inputTokens", "promptTokens")
_USAGE_OUTPUT_KEYS = ("output_tokens", "completion_tokens", "outputTokens", "completionTokens")
_USAGE_TOTAL_KEYS = ("total_tokens", "totalTokens")


def extract_token_usage(payload: Any) -> dict[str, Any] | None:
    candidates: list[dict[str, Any]] = []

    def walk(value: Any, depth: int = 0) -> None:
        if depth > 10:
            return
        if isinstance(value, dict):
            usage = value.get("usage")
            if isinstance(usage, dict):
                _append_usage_candidate(candidates, usage)
            if _looks_like_usage_dict(value):
                _append_usage_candidate(candidates, value)
            for child in value.values():
                walk(child, depth + 1)
        elif isinstance(value, list):
            for item in value:
                walk(item, depth + 1)

    walk(payload)
    if not candidates:
        return None
    return max(
        candidates,
        key=lambda item: (
            int(item.get("total_tokens") or 0),
            int(item.get("input_tokens") or 0) + int(item.get("output_tokens") or 0),
        ),
    )


def _append_usage_candidate(candidates: list[dict[str, Any]], raw_usage: dict[str, Any]) -> None:
    input_tokens = _usage_int(raw_usage, _USAGE_INPUT_KEYS)
    output_tokens = _usage_int(raw_usage, _USAGE_OUTPUT_KEYS)
    total_tokens = _usage_int(raw_usage, _USAGE_TOTAL_KEYS)
    if total_tokens <= 0:
        total_tokens = input_tokens + output_tokens
    candidates.append(
        {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": total_tokens,
            "raw_usage": dict(raw_usage),
        }
    )


def _looks_like_usage_dict(value: dict[str, Any]) -> bool:
    keys = set(value.keys())
    return bool(keys.intersection(_USAGE_INPUT_KEYS) or keys.intersection(_USAGE_OUTPUT_KEYS) or keys.intersection(_USAGE_TOTAL_KEYS))


def _usage_int(data: dict[str, Any], keys: tuple[str, ...]) -> int:
    for key in keys:
        value = data.get(key)
        if isinstance(value, bool) or value is None:
            continue
        if isinstance(value, (int, float)):
            return max(0, int(value))
        if isinstance(value, str):
            clean = value.strip().replace(",", "")
            if not clean:
                continue
            try:
                return max(0, int(float(clean)))
            except ValueError:
                continue
    return 0


def extract_model_name(payload: Any) -> str:
    found = ""

    def walk(value: Any, depth: int = 0) -> None:
        nonlocal found
        if depth > 10:
            return
        if isinstance(value, dict):
            model = value.get("model")
            if isinstance(model, str) and model.strip():
                found = model.strip()
            for child in value.values():
                walk(child, depth + 1)
        elif isinstance(value, list):
            for item in value:
                walk(item, depth + 1)

    walk(payload)
    return normalize_model_name(found)


def require_admin(actor: dict[str, Any]) -> None:
    if actor.get("role") != "admin":
        raise ServiceError(403, "admin role required")


def require_permission(actor: dict[str, Any], permission: str) -> None:
    if actor.get("role") == "admin":
        return
    if permission not in set(actor.get("permissions") or []):
        raise ServiceError(403, "permission required")


def role_for_permission_group(group: str) -> str:
    return "admin" if group == "admin" else "member"


def public_permission_group(row: dict[str, Any]) -> str:
    group = str(row.get("permission_group") or "").strip().lower()
    if group in PERMISSION_GROUPS:
        return group
    return "admin" if row.get("role") == "admin" else "member"


def normalize_role(value: str) -> str:
    role = str(value or "member").strip().lower()
    if role not in {"admin", "member"}:
        raise ServiceError(400, "invalid role")
    return role


def normalize_permission_group(value: str) -> str:
    group = str(value or "member").strip().lower()
    if group not in PERMISSION_GROUPS:
        raise ServiceError(400, "invalid permission group")
    return group


def normalize_position(value: str) -> str:
    clean = str(value or "").strip()
    if len(clean) > 80 or re.search(r"[\r\n\x00]", clean):
        raise ServiceError(400, "invalid position")
    return clean


def normalize_model_name(value: str) -> str:
    clean = str(value or "").strip()
    if len(clean) > 120 or re.search(r"[\r\n\x00]", clean):
        raise ServiceError(400, "invalid model name")
    return clean


def _changed_user_updates(current: dict[str, Any], updates: dict[str, Any]) -> dict[str, Any]:
    changed: dict[str, Any] = {}
    for key, value in updates.items():
        if key == "password_hash":
            changed[key] = value
            continue
        if key == "active":
            if int(value) != int(current.get(key) or 0):
                changed[key] = value
            continue
        current_value = current.get(key)
        if str(value or "") != str(current_value or ""):
            changed[key] = value
    return changed


def _clean_model_ids(values: Any) -> list[str]:
    if not isinstance(values, list):
        return []
    models: list[str] = []
    seen: set[str] = set()
    for value in values:
        model = str(value or "").strip()
        if not model or len(model) > 160 or re.search(r"[\r\n\x00]", model):
            continue
        if model in seen:
            continue
        seen.add(model)
        models.append(model)
    return models


def normalize_thinking_depth(value: str) -> str:
    clean = str(value or DEFAULT_THINKING_DEPTH).strip().lower()
    if not clean:
        clean = DEFAULT_THINKING_DEPTH
    if clean not in THINKING_DEPTHS:
        raise ServiceError(400, "invalid thinking depth")
    return clean


def reasoning_config_for_depth(thinking_depth: str) -> dict[str, Any] | None:
    depth = normalize_thinking_depth(thinking_depth)
    if depth == "none":
        return {"enabled": False}
    return {"enabled": True, "effort": depth}


def normalize_name(value: str) -> str:
    clean = value.strip().lower()
    if not re.fullmatch(r"[a-z0-9_.-]{2,40}", clean):
        raise ServiceError(400, "invalid username")
    return clean


def normalize_channel_name(value: str) -> str:
    clean = value.strip().lower().replace(" ", "-")
    if not re.fullmatch(r"[a-z0-9][a-z0-9_.-]{1,48}", clean):
        raise ServiceError(400, "invalid channel name")
    return clean


def sanitize_attachment_filename(value: str) -> str:
    clean = Path(str(value or "attachment")).name.strip()
    clean = re.sub(r"[\r\n\x00/\\]+", "_", clean)
    clean = re.sub(r"\s+", " ", clean).strip(" .")
    if not clean:
        clean = "attachment"
    if len(clean) > 180:
        suffix = Path(clean).suffix[:32]
        stem = clean[: max(1, 180 - len(suffix))]
        clean = f"{stem}{suffix}"
    return clean


def normalize_attachment_mime(filename: str, value: str) -> str:
    clean = str(value or "").split(";", 1)[0].strip().lower()
    if not clean or "/" not in clean or re.search(r"[\r\n\x00]", clean):
        clean = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    return clean[:120]


def is_safe_inline_attachment_mime(mime_type: str) -> bool:
    return str(mime_type or "").split(";", 1)[0].strip().lower() in SAFE_INLINE_ATTACHMENT_MIME_TYPES


def safe_attachment_suffix(filename: str) -> str:
    suffix = Path(filename).suffix.lower()
    if not suffix or len(suffix) > 24 or not re.fullmatch(r"\.[a-z0-9][a-z0-9._-]{0,22}", suffix):
        return ""
    return suffix


def clean_media_path(value: str) -> str:
    path = str(value or "").strip()
    if len(path) >= 2 and path[0] == path[-1] and path[0] in "`\"'":
        path = path[1:-1].strip()
    return path.lstrip("`\"'").rstrip("`\"',.;:)}]")


def format_bytes(value: int) -> str:
    size = max(0, int(value or 0))
    units = ("B", "KB", "MB", "GB")
    amount = float(size)
    for unit in units:
        if amount < 1024 or unit == units[-1]:
            if unit == "B":
                return f"{int(amount)} {unit}"
            return f"{amount:.1f} {unit}"
        amount /= 1024


def channel_agent_request(content: str) -> str | None:
    if not AGENT_MENTION_RE.search(content):
        return None
    cleaned = AGENT_MENTION_RE.sub("", content).strip()
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    return cleaned or content.strip()


def agent_work_line(stage: str, label: str, detail: str = "") -> str:
    stage = str(stage or "").strip().lower()
    label = str(label or "").strip()
    detail = str(detail or "").strip()
    if stage == "preparing":
        return f"📁 {label}{(': ' + detail) if detail else ''}"
    if stage == "complete":
        return f"✅ {label}"
    if stage == "error":
        return f"⚠️ {label}{(': ' + detail) if detail else ''}"
    if stage == "queued":
        return f"⏳ {label or '等待 Agent 处理'}"
    if stage == "replying":
        return f"💬 {label or '开始处理 Agent 请求'}"
    return f"• {label}{(': ' + detail) if detail else ''}"


def hermes_progress_line(event: dict[str, Any]) -> str:
    tool = str(event.get("tool") or event.get("tool_name") or "tool").strip() or "tool"
    label = str(event.get("label") or event.get("preview") or "").strip()
    emoji = str(event.get("emoji") or "⚙️").strip() or "⚙️"
    if label and label != tool:
        return f"{emoji} {tool}: \"{label}\""
    return f"{emoji} {tool}..."


def parse_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def mask_secret(value: str) -> str:
    # Fixed-width mask so the rendered hint never encodes the secret's length and
    # never reveals a prefix; only long values expose a short trailing suffix as a
    # recognition hint. Kept consistent with internal_config.mask_value.
    if not value:
        return ""
    if len(value) < 12:
        return "********"
    return f"...{value[-4:]}"
