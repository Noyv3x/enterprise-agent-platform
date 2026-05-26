from __future__ import annotations

import os
import re
import secrets
import urllib.parse
from pathlib import Path
from typing import Any

from .auth import TokenSigner, hash_password, verify_password
from .cognee_bridge import CogneeBridge
from .config import OAUTH_SECRET_KEYS, PlatformConfig
from .containers import ContainerManager
from .db import Database, decode_json, encode_json, now_ts
from .hermes import AgentClient, AutoAgentClient
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
    PlatformRuntimeManager,
    default_base_url_for_provider,
    default_model_for_provider,
    normalize_hermes_provider,
)


class ServiceError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class EnterpriseService:
    def __init__(
        self,
        config: PlatformConfig,
        agent_client: AgentClient | None = None,
        runtime_process_launcher=None,
        runtime_command_runner=None,
        oauth_http_client=None,
        autostart_runtime: bool = True,
    ):
        self.config = config
        self.config.data_dir.mkdir(parents=True, exist_ok=True)
        self.db = Database(config.db_path)
        self.tokens = TokenSigner(config.token_secret, config.token_ttl_seconds)
        self.knowledge = KnowledgeBase(self.db)
        self.runtimes = PlatformRuntimeManager(
            config,
            self.get_secret,
            process_launcher=runtime_process_launcher,
            command_runner=runtime_command_runner,
            setting_provider=self.get_setting,
        )
        self.cognee = CogneeBridge(config, self.get_secret, self.runtimes)
        self.containers = ContainerManager(config, self.db)
        self.agent_client = agent_client or AutoAgentClient(config, self.get_secret, self.runtimes)
        self.oauth_flows = OAuthFlowManager(oauth_http_client)
        self.ensure_bootstrap()
        self.runtimes.prepare()
        if autostart_runtime and agent_client is None and self.config.agent_mode != "local":
            self.runtimes.ensure_hermes_ready(wait=False)

    def close(self) -> None:
        self.runtimes.close()
        self.db.close()

    def ensure_bootstrap(self) -> None:
        if not self.db.scalar("SELECT COUNT(*) FROM channels"):
            ts = now_ts()
            self.db.execute(
                "INSERT INTO channels(name, description, created_at) VALUES (?, ?, ?)",
                ("general", "Company-wide agent channel", ts),
            )
        if not self.db.scalar("SELECT COUNT(*) FROM users"):
            password = os.getenv("ENTERPRISE_ADMIN_PASSWORD", "admin")
            self.create_user(
                username="admin",
                password=password,
                display_name="Administrator",
                role="admin",
                actor=None,
            )
        if not self.get_setting("agent_tool_token"):
            token = self.config.agent_tool_token or secrets.token_urlsafe(32)
            self.set_setting("agent_tool_token", token, secret=True)
        if not self.config.hermes_api_key and not self.get_secret("ENTERPRISE_HERMES_API_KEY") and not self.get_secret("API_SERVER_KEY"):
            self.set_setting("API_SERVER_KEY", secrets.token_urlsafe(32), secret=True)

    def create_user(
        self,
        *,
        username: str,
        password: str,
        display_name: str = "",
        role: str = "member",
        actor: dict[str, Any] | None,
    ) -> dict[str, Any]:
        if actor is not None and actor.get("role") != "admin":
            raise ServiceError(403, "admin role required")
        username = normalize_name(username)
        if role not in {"admin", "member"}:
            raise ServiceError(400, "invalid role")
        if not password or len(password) < 4:
            raise ServiceError(400, "password must be at least 4 characters")
        display = display_name.strip() or username
        ts = now_ts()
        try:
            user_id = self.db.insert(
                """
                INSERT INTO users(username, display_name, password_hash, role, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (username, display, hash_password(password), role, ts),
            )
        except Exception as exc:
            raise ServiceError(409, f"user already exists: {username}") from exc
        return self.get_user(user_id) or {}

    def authenticate(self, username: str, password: str) -> tuple[str, dict[str, Any]]:
        user = self.db.query_one(
            "SELECT * FROM users WHERE username = ? AND active = 1",
            (normalize_name(username),),
        )
        if not user or not verify_password(password, user["password_hash"]):
            raise ServiceError(401, "invalid username or password")
        self.db.execute("UPDATE users SET last_login_at = ? WHERE id = ?", (now_ts(), user["id"]))
        public = self.public_user(user)
        return self.tokens.issue(int(user["id"])), public

    def user_from_token(self, token: str | None) -> dict[str, Any] | None:
        if not token:
            return None
        payload = self.tokens.verify(token)
        if not payload:
            return None
        user = self.get_user(payload.user_id)
        if not user or not user.get("active"):
            return None
        return user

    def get_user(self, user_id: int) -> dict[str, Any] | None:
        row = self.db.query_one("SELECT * FROM users WHERE id = ?", (user_id,))
        return self.public_user(row) if row else None

    def list_users(self, actor: dict[str, Any]) -> list[dict[str, Any]]:
        require_admin(actor)
        rows = self.db.query("SELECT * FROM users ORDER BY id")
        return [self.public_user(row) for row in rows]

    @staticmethod
    def public_user(row: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": int(row["id"]),
            "username": row["username"],
            "display_name": row["display_name"],
            "role": row["role"],
            "active": bool(row["active"]),
            "created_at": row["created_at"],
            "last_login_at": row.get("last_login_at"),
        }

    def list_channels(self, actor: dict[str, Any]) -> list[dict[str, Any]]:
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
        messages = [self._message_from_row(row) for row in reversed(rows)]
        return messages

    def send_channel_message(self, actor: dict[str, Any], channel_id: int, content: str) -> dict[str, Any]:
        channel = self.get_channel(actor, channel_id)
        content = content.strip()
        if not content:
            raise ServiceError(400, "message content is required")
        scope_id = str(channel_id)
        user_msg = self._append_message(
            scope_type="channel",
            scope_id=scope_id,
            author_type="user",
            user_id=actor["id"],
            username=actor["display_name"],
            content=content,
            metadata={},
        )
        context = self._recent_context("channel", scope_id, content)
        suggestions = self.knowledge.suggest(context)
        system_prompt = self._channel_system_prompt(channel, suggestions)
        result = self.agent_client.generate(
            system_prompt=system_prompt,
            user_message=content,
            history=self._agent_history("channel", scope_id),
            session_id=f"enterprise-channel-{channel_id}-main-agent",
            session_key=f"channel:{channel_id}:main-agent",
            metadata={"knowledge_suggestions": [h.to_dict() for h in suggestions]},
        )
        agent_msg = self._append_message(
            scope_type="channel",
            scope_id=scope_id,
            author_type="agent",
            user_id=None,
            username="Main Agent",
            content=result.content,
            metadata={
                "session_id": result.session_id,
                "degraded": result.degraded,
                "knowledge_suggestions": [h.to_dict() for h in suggestions],
            },
        )
        return {"user_message": user_msg, "agent_message": agent_msg}

    def send_private_message(self, actor: dict[str, Any], content: str) -> dict[str, Any]:
        content = content.strip()
        if not content:
            raise ServiceError(400, "message content is required")
        container = self.containers.ensure_private_container(
            user_id=actor["id"],
            username=actor["username"],
            secrets_env=self.model_secret_env(),
        )
        scope_id = str(actor["id"])
        user_msg = self._append_message(
            scope_type="private",
            scope_id=scope_id,
            author_type="user",
            user_id=actor["id"],
            username=actor["display_name"],
            content=content,
            metadata={"container": container.to_dict()},
        )
        context = self._recent_context("private", scope_id, content)
        suggestions = self.knowledge.suggest(context)
        system_prompt = self._private_system_prompt(actor, container.to_dict(), suggestions)
        result = self.agent_client.generate(
            system_prompt=system_prompt,
            user_message=content,
            history=self._agent_history("private", scope_id),
            session_id=container.session_id,
            session_key=f"private:{actor['id']}",
            metadata={"knowledge_suggestions": [h.to_dict() for h in suggestions], "container": container.to_dict()},
        )
        agent_msg = self._append_message(
            scope_type="private",
            scope_id=scope_id,
            author_type="agent",
            user_id=None,
            username="Private Agent",
            content=result.content,
            metadata={
                "session_id": result.session_id,
                "degraded": result.degraded,
                "container": container.to_dict(),
                "knowledge_suggestions": [h.to_dict() for h in suggestions],
            },
        )
        return {"user_message": user_msg, "agent_message": agent_msg, "container": container.to_dict()}

    def private_status(self, actor: dict[str, Any]) -> dict[str, Any]:
        container = self.containers.get_private_container(actor["id"])
        return {"container": container.to_dict() if container else None, "session_id": f"enterprise-private-u{actor['id']}"}

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
        return {"config": config, "runtime": self.runtimes.hermes_status(refresh=True).to_dict()}

    def update_hermes_config(self, actor: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
        require_admin(actor)
        if "manage_hermes" in body:
            self.set_setting(HERMES_SETTING_MANAGED, "1" if parse_bool(body.get("manage_hermes")) else "0")
        if "repo_path" in body:
            repo_path = str(body.get("repo_path", "")).strip()
            if not repo_path:
                raise ServiceError(400, "Hermes source path is required")
            self.set_setting(HERMES_SETTING_REPO, str(Path(repo_path).expanduser()))
        if "api_url" in body:
            api_url = str(body.get("api_url", "")).strip()
            parsed = urllib.parse.urlparse(api_url)
            if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                raise ServiceError(400, "Hermes API URL must be an http(s) URL")
            self.set_setting(HERMES_SETTING_API_URL, api_url)
        provider = None
        if "provider" in body:
            provider = normalize_hermes_provider(str(body.get("provider", "") or "auto"))
            if provider not in SUPPORTED_OAUTH_PROVIDERS:
                raise ServiceError(400, "Hermes provider must be Codex OAuth or Grok OAuth")
            self.set_setting(HERMES_SETTING_PROVIDER, provider)
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
            if provider and model in {"", "hermes-agent"}:
                model = default_model_for_provider(provider) or model
            if not model:
                raise ServiceError(400, "Hermes model is required")
            self.set_setting(HERMES_SETTING_MODEL, model)
        elif provider:
            default_model = default_model_for_provider(provider)
            if default_model:
                self.set_setting(HERMES_SETTING_MODEL, default_model)
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
        raise ServiceError(404, "runtime not found")

    def oauth_provider_status(self, actor: dict[str, Any]) -> dict[str, Any]:
        require_admin(actor)
        active_provider = normalize_hermes_provider(self.get_setting(HERMES_SETTING_PROVIDER) or self.config.hermes_provider)
        if active_provider not in SUPPORTED_OAUTH_PROVIDERS:
            active_provider = "openai-codex"
        runtime_oauth = self.runtimes.hermes_runtime_config().get("oauth", {})
        providers = []
        for provider in SUPPORTED_OAUTH_PROVIDERS:
            info = oauth_provider_info(provider)
            configured = self._oauth_tokens_configured(provider)
            runtime_status = runtime_oauth.get(provider, {}) if isinstance(runtime_oauth, dict) else {}
            providers.append(
                {
                    **info,
                    "configured": configured or bool(runtime_status.get("configured")),
                    "active": active_provider == provider,
                    "last_refresh": self._oauth_last_refresh(provider) or runtime_status.get("last_refresh"),
                }
            )
        return {"providers": providers, "active_provider": active_provider}

    def start_oauth_verification(self, actor: dict[str, Any], provider: str) -> dict[str, Any]:
        require_admin(actor)
        provider = normalize_hermes_provider(provider)
        if provider not in SUPPORTED_OAUTH_PROVIDERS:
            raise ServiceError(400, "OAuth provider must be Codex OAuth or Grok OAuth")
        self._select_oauth_provider(provider)
        try:
            flow = self.oauth_flows.start(provider)
        except OAuthFlowError as exc:
            raise ServiceError(exc.status, exc.message) from exc
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
        doc = self.knowledge.add_document(
            title=str(body.get("title", "")),
            summary=str(body.get("summary", "")),
            content=str(body.get("content", "")),
            source=str(body.get("source", "")),
            created_by=actor["id"],
        )
        doc["cognee"] = self.cognee.ingest_document(
            title=doc["title"],
            content=doc["content"],
            source=doc.get("source", ""),
        )
        return doc

    def search_knowledge(self, query: str, limit: int = 5) -> list[dict[str, Any]]:
        local = [hit.to_dict() for hit in self.knowledge.search(query, limit)]
        if len(local) >= limit and self.config.knowledge_backend != "cognee":
            return local[:limit]
        cognee_hits = self.cognee.search(query, limit=max(0, limit - len(local)))
        if self.config.knowledge_backend == "cognee":
            return cognee_hits or local[:limit]
        return (local + cognee_hits)[:limit]

    def get_knowledge_document(self, document_id: int) -> dict[str, Any]:
        doc = self.knowledge.get_document(document_id)
        if not doc:
            raise ServiceError(404, "knowledge document not found")
        return doc

    def knowledge_status(self) -> dict[str, Any]:
        return {
            "local": {"available": True, "backend": "sqlite-fts"},
            "cognee": self.cognee.status().to_dict(),
            "mode": self.config.knowledge_backend,
            "dataset": self.config.cognee_dataset,
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

    def _select_oauth_provider(self, provider: str) -> None:
        self.set_setting(HERMES_SETTING_PROVIDER, provider)
        self.set_setting(HERMES_SETTING_MODEL, default_model_for_provider(provider))
        self.set_setting(HERMES_SETTING_PROVIDER_BASE_URL, default_base_url_for_provider(provider))
        self.runtimes.prepare_hermes()

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
    ) -> dict[str, Any]:
        msg_id = self.db.insert(
            """
            INSERT INTO messages(scope_type, scope_id, author_type, user_id, username, content, metadata_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (scope_type, str(scope_id), author_type, user_id, username, content, encode_json(metadata), now_ts()),
        )
        row = self.db.query_one("SELECT * FROM messages WHERE id = ?", (msg_id,))
        return self._message_from_row(row)

    @staticmethod
    def _message_from_row(row: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": int(row["id"]),
            "scope_type": row["scope_type"],
            "scope_id": row["scope_id"],
            "author_type": row["author_type"],
            "user_id": row["user_id"],
            "username": row["username"],
            "content": row["content"],
            "metadata": decode_json(row["metadata_json"]),
            "created_at": row["created_at"],
        }

    def _agent_history(self, scope_type: str, scope_id: str) -> list[dict[str, str]]:
        messages = self.list_messages({"id": 0}, scope_type, scope_id, limit=30)
        history: list[dict[str, str]] = []
        for msg in messages[:-1]:
            if msg["author_type"] == "user":
                history.append({"role": "user", "content": msg["content"]})
            elif msg["author_type"] == "agent":
                history.append({"role": "assistant", "content": msg["content"]})
        return history

    def _recent_context(self, scope_type: str, scope_id: str, content: str) -> str:
        messages = self.list_messages({"id": 0}, scope_type, scope_id, limit=12)
        return "\n".join([m["content"] for m in messages] + [content])

    def _channel_system_prompt(self, channel: dict[str, Any], suggestions) -> str:
        passive = format_passive_suggestions(suggestions)
        return (
            "你是企业级 Agent 平台中的频道主 Agent。该频道由多人共享，你代表一个统一的 bot 主线程工作。\n"
            f"频道: #{channel['name']}。请保留上下文连续性，明确区分用户请求和企业事实。\n"
            "企业知识库已作为工具暴露给你: enterprise_kb_search(query, limit) 与 enterprise_kb_read(document_id)。\n"
            "当提示中出现 kb:<id> 时，优先用 enterprise_kb_read 读取完整条目再作答。\n"
            f"{passive}"
        )

    def _private_system_prompt(self, actor: dict[str, Any], container: dict[str, Any], suggestions) -> str:
        passive = format_passive_suggestions(suggestions)
        return (
            "你是企业级 Agent 平台中该用户的私人 Agent。每个用户拥有隔离会话和自动管理的工作容器。\n"
            f"当前用户: {actor['display_name']} ({actor['username']})。\n"
            f"工作区: {container['workspace_path']}；容器状态: {container['container_status']}；会话: {container['session_id']}。\n"
            "模型密钥由平台集中配置，不要要求用户再次提供密钥。\n"
            "企业知识库工具: enterprise_kb_search(query, limit) 与 enterprise_kb_read(document_id)。\n"
            f"{passive}"
        )


def require_admin(actor: dict[str, Any]) -> None:
    if actor.get("role") != "admin":
        raise ServiceError(403, "admin role required")


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


def parse_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def mask_secret(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 8:
        return "*" * len(value)
    return f"{value[:3]}...{value[-4:]}"
