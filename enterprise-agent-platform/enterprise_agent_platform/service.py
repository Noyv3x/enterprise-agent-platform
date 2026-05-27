from __future__ import annotations

import os
import re
import secrets
import threading
import time
import urllib.parse
from collections import deque
from pathlib import Path
from typing import Any, Deque

from .auth import TokenSigner, hash_password, verify_password
from .cognee_bridge import CogneeBridge
from .config import OAUTH_SECRET_KEYS, PlatformConfig
from .containers import ContainerManager
from .db import Database, decode_json, encode_json, now_ts
from .hermes import AgentClient, AutoAgentClient
from .internal_config import (
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
    default_model_for_provider,
    normalize_hermes_provider,
)


class ServiceError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


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
        self._conversation_lock = threading.RLock()
        self._agent_queues: dict[str, Deque[dict[str, Any]]] = {}
        self._agent_workers: dict[str, threading.Thread] = {}
        self._agent_status: dict[str, dict[str, Any]] = {}
        self._typing: dict[str, dict[int, dict[str, Any]]] = {}
        self._closed = False
        self.ensure_bootstrap()
        self.runtimes.prepare()
        if autostart_runtime and agent_client is None and self.config.agent_mode != "local":
            self.runtimes.ensure_managed_tooling_ready(wait=False)
            self.runtimes.ensure_hermes_ready(wait=False)

    def close(self) -> None:
        with self._conversation_lock:
            self._closed = True
            workers = list(self._agent_workers.values())
        for worker in workers:
            worker.join(timeout=2)
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
        position: str = "",
        permission_group: str | None = None,
        model_name: str = "",
        thinking_depth: str = DEFAULT_THINKING_DEPTH,
        actor: dict[str, Any] | None,
    ) -> dict[str, Any]:
        if actor is not None and actor.get("role") != "admin":
            raise ServiceError(403, "admin role required")
        username = normalize_name(username)
        requested_role = normalize_role(role)
        group = normalize_permission_group(permission_group or ("admin" if requested_role == "admin" else "member"))
        role = role_for_permission_group(group)
        if not password or len(password) < 4:
            raise ServiceError(400, "password must be at least 4 characters")
        display = display_name.strip() or username
        position = normalize_position(position)
        model_name = normalize_model_name(model_name)
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
            updates["model_name"] = normalize_model_name(str(body.get("model_name", body.get("model", ""))))
        if "thinking_depth" in body:
            updates["thinking_depth"] = normalize_thinking_depth(str(body.get("thinking_depth", "")))
        if "active" in body:
            updates["active"] = 1 if parse_bool(body.get("active")) else 0
        password = str(body.get("password", "") or "")
        if password:
            if len(password) < 4:
                raise ServiceError(400, "password must be at least 4 characters")
            updates["password_hash"] = hash_password(password)

        if not updates:
            return self.get_user(user_id) or {}
        self._guard_admin_update(actor, current, updates)
        assignments = ", ".join(f"{key} = ?" for key in updates)
        self.db.execute(
            f"UPDATE users SET {assignments} WHERE id = ?",
            [*updates.values(), user_id],
        )
        return self.get_user(user_id) or {}

    def deactivate_user(self, actor: dict[str, Any], user_id: int) -> dict[str, Any]:
        return self.update_user(actor, user_id, {"active": False})

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
        subject = self.db.query_one("SELECT * FROM users WHERE id = ?", (int(user_id),))
        if not subject:
            raise ServiceError(404, "user not found")
        limit = max(1, min(int(limit), 500))
        scope_id = str(user_id)
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

    def send_channel_message(self, actor: dict[str, Any], channel_id: int, content: str) -> dict[str, Any]:
        require_permission(actor, PERMISSION_CHAT)
        channel = self.get_channel(actor, channel_id)
        content = content.strip()
        if not content:
            raise ServiceError(400, "message content is required")
        generation = self.account_generation_config(actor)
        scope_id = str(channel_id)
        user_msg = self._append_message(
            scope_type="channel",
            scope_id=scope_id,
            author_type="user",
            user_id=actor["id"],
            username=actor["display_name"],
            content=content,
            metadata={"generation": generation, "agent_mention": bool(channel_agent_request(content))},
        )
        agent_content = channel_agent_request(content)
        if agent_content is None:
            return {
                "user_message": user_msg,
                "agent_message": None,
                "agent_status": self.agent_status(actor, "channel", scope_id),
            }
        status = self._enqueue_agent_reply(
            {
                "scope_type": "channel",
                "scope_id": scope_id,
                "channel": channel,
                "actor": dict(actor),
                "content": agent_content,
                "generation": generation,
                "user_message": user_msg,
            }
        )
        return {"user_message": user_msg, "agent_message": None, "agent_status": status}

    def _send_channel_agent_reply(self, task: dict[str, Any]) -> dict[str, Any]:
        scope_id = str(task["scope_id"])
        channel = task["channel"]
        content = str(task["content"])
        generation = task["generation"]
        user_msg = task["user_message"]
        self._record_agent_activity("channel", scope_id, "preparing", "准备 Agent 请求", "整理频道上下文")
        suggestions = self.knowledge.suggest(
            self._recent_context_before(
                "channel",
                scope_id,
                content,
                int(user_msg["id"]),
                current_speaker=self._actor_display_name(task["actor"]),
            )
        )
        system_prompt = self._channel_system_prompt(channel, suggestions)
        self._record_agent_activity("channel", scope_id, "replying", "等待 Hermes Agent 运行过程", generation["model"])
        result = self.agent_client.generate(
            system_prompt=system_prompt,
            user_message=self._channel_speaker_line(task["actor"], content),
            history=self._agent_history_before("channel", scope_id, int(user_msg["id"])),
            session_id=f"enterprise-channel-{scope_id}-main-agent",
            session_key=f"channel:{scope_id}:main-agent",
            metadata={"knowledge_suggestions": [h.to_dict() for h in suggestions]},
            model=generation["model"],
            thinking_depth=generation["thinking_depth"],
            reasoning_config=generation["reasoning_config"],
            progress_callback=lambda event: self._record_hermes_progress("channel", scope_id, event),
            content_callback=lambda delta: self._record_agent_content_delta("channel", scope_id, delta),
        )
        self._record_agent_activity("channel", scope_id, "complete", "回复已生成", "保存到频道消息")
        metadata = {
            "session_id": result.session_id,
            "degraded": result.degraded,
            "generation": generation,
            "knowledge_suggestions": [h.to_dict() for h in suggestions],
            "reply_to": self._reply_target(task),
        }
        metadata["agent_work"] = self._agent_work_snapshot(task, state="complete")
        message = self._append_message(
            scope_type="channel",
            scope_id=scope_id,
            author_type="agent",
            user_id=None,
            username="Main Agent",
            content=result.content,
            metadata=metadata,
        )
        return message

    def send_private_message(self, actor: dict[str, Any], content: str) -> dict[str, Any]:
        require_permission(actor, PERMISSION_PRIVATE_AGENT)
        content = content.strip()
        if not content:
            raise ServiceError(400, "message content is required")
        generation = self.account_generation_config(actor)
        scope_id = str(actor["id"])
        user_msg = self._append_message(
            scope_type="private",
            scope_id=scope_id,
            author_type="user",
            user_id=actor["id"],
            username=actor["display_name"],
            content=content,
            metadata={"generation": generation},
        )
        current_container = self.containers.get_private_container(actor["id"])
        status = self._enqueue_agent_reply(
            {
                "scope_type": "private",
                "scope_id": scope_id,
                "actor": dict(actor),
                "content": content,
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
        suggestions = self.knowledge.suggest(self._recent_context_before("private", scope_id, content, int(user_msg["id"])))
        system_prompt = self._private_system_prompt(actor, container_data, suggestions)
        self._record_agent_activity("private", scope_id, "replying", "等待 Hermes Agent 运行过程", generation["model"])
        result = self.agent_client.generate(
            system_prompt=system_prompt,
            user_message=content,
            history=self._agent_history_before("private", scope_id, int(user_msg["id"])),
            session_id=container.session_id,
            session_key=f"private:{actor['id']}",
            metadata={"knowledge_suggestions": [h.to_dict() for h in suggestions], "container": container_data},
            model=generation["model"],
            thinking_depth=generation["thinking_depth"],
            reasoning_config=generation["reasoning_config"],
            progress_callback=lambda event: self._record_hermes_progress("private", scope_id, event),
            content_callback=lambda delta: self._record_agent_content_delta("private", scope_id, delta),
        )
        self._record_agent_activity("private", scope_id, "complete", "回复已生成", "保存到私人会话")
        metadata = {
            "session_id": result.session_id,
            "degraded": result.degraded,
            "container": container_data,
            "generation": generation,
            "knowledge_suggestions": [h.to_dict() for h in suggestions],
            "reply_to": self._reply_target(task),
        }
        metadata["agent_work"] = self._agent_work_snapshot(task, state="complete")
        message = self._append_message(
            scope_type="private",
            scope_id=scope_id,
            author_type="agent",
            user_id=None,
            username="Private Agent",
            content=result.content,
            metadata=metadata,
        )
        return message

    def private_status(self, actor: dict[str, Any]) -> dict[str, Any]:
        require_permission(actor, PERMISSION_PRIVATE_AGENT)
        container = self.containers.get_private_container(actor["id"])
        return {
            "container": container.to_dict() if container else None,
            "session_id": f"enterprise-private-u{actor['id']}",
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
        return {"config": config, "runtime": self.runtimes.hermes_status(refresh=True).to_dict()}

    def hermes_internal_config(self, actor: dict[str, Any]) -> dict[str, Any]:
        require_admin(actor)
        self.runtimes.prepare_hermes()
        config = self.runtimes.hermes_runtime_config()
        internal = read_hermes_internal_config(Path(config["config_path"]), Path(config["env_path"]))
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
        require_permission(actor, PERMISSION_MANAGE_KNOWLEDGE)
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

    def account_generation_config(self, actor: dict[str, Any]) -> dict[str, Any]:
        model = normalize_model_name(str(actor.get("model_name") or ""))
        if not model:
            model = str(self.runtimes.hermes_runtime_config().get("model") or self.config.hermes_model)
        thinking_depth = normalize_thinking_depth(str(actor.get("thinking_depth") or DEFAULT_THINKING_DEPTH))
        return {
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

    def _enqueue_agent_reply(self, task: dict[str, Any]) -> dict[str, Any]:
        scope_type = str(task["scope_type"])
        scope_id = str(task["scope_id"])
        key = self._conversation_key(scope_type, scope_id)
        with self._conversation_lock:
            if self._closed:
                raise ServiceError(503, "service is shutting down")
            queue = self._agent_queues.setdefault(key, deque())
            queue.append(task)
            status = self._agent_status.get(key)
            if not status or status.get("state") == "idle":
                status = self._status_for_task(task, "queued", queued_count=len(queue))
            else:
                status = dict(status)
                status["queued_count"] = len(queue)
                status["updated_at"] = now_ts()
            self._agent_status[key] = status

            worker = self._agent_workers.get(key)
            if worker is None or not worker.is_alive():
                worker = threading.Thread(target=self._agent_worker, args=(key,), name=f"agent-reply-{key}", daemon=True)
                self._agent_workers[key] = worker
                worker.start()
            return self._copy_status(status)

    def _agent_worker(self, key: str) -> None:
        while True:
            with self._conversation_lock:
                queue = self._agent_queues.get(key)
                if self._closed or not queue:
                    scope_type, scope_id = self._split_conversation_key(key)
                    self._agent_status[key] = self._idle_agent_status(scope_type, scope_id)
                    self._agent_workers.pop(key, None)
                    return
                task = queue.popleft()
                self._agent_status[key] = self._status_for_task(task, "replying", queued_count=len(queue))

            error = ""
            try:
                if task["scope_type"] == "channel":
                    self._send_channel_agent_reply(task)
                else:
                    self._send_private_agent_reply(task)
            except Exception as exc:
                error = str(exc)
                try:
                    self._append_agent_error(task, error)
                except Exception:
                    pass

            with self._conversation_lock:
                queue = self._agent_queues.get(key)
                if queue:
                    self._agent_status[key] = self._status_for_task(queue[0], "queued", queued_count=len(queue))
                    continue
                scope_type, scope_id = self._split_conversation_key(key)
                self._agent_status[key] = self._idle_agent_status(scope_type, scope_id, last_error=error)
                self._agent_workers.pop(key, None)
                return

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
            "stream_message": None,
        }

    @staticmethod
    def _copy_status(status: dict[str, Any]) -> dict[str, Any]:
        copied = dict(status)
        if copied.get("replying_to"):
            copied["replying_to"] = dict(copied["replying_to"])
        copied["activity"] = [dict(item) for item in copied.get("activity") or []]
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

    def _record_agent_content_delta(self, scope_type: str, scope_id: str, delta: str) -> None:
        delta = str(delta or "")
        if not delta:
            return
        key = self._conversation_key(scope_type, str(scope_id))
        timestamp = now_ts()
        with self._conversation_lock:
            status = dict(self._agent_status.get(key) or self._idle_agent_status(scope_type, str(scope_id)))
            stream = dict(status.get("stream_message") or {})
            stream.setdefault("id", f"stream:{status.get('run_id') or key}:{status.get('started_at') or timestamp}")
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
        return [
            {"user_id": item["user_id"], "username": item["username"], "updated_at": item["updated_at"]}
            for user_id, item in users.items()
            if exclude_user_id is None or user_id != exclude_user_id
        ]

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
                history.append({"role": "user", "content": self._history_message_content(msg)})
            elif msg["author_type"] == "agent":
                history.append({"role": "assistant", "content": self._history_message_content(msg)})
        return history

    def _agent_history_before(self, scope_type: str, scope_id: str, before_message_id: int) -> list[dict[str, str]]:
        rows = self.db.query(
            """
            SELECT * FROM messages
            WHERE scope_type = ? AND scope_id = ? AND id < ?
            ORDER BY id DESC
            LIMIT 30
            """,
            (scope_type, str(scope_id), int(before_message_id)),
        )
        history: list[dict[str, str]] = []
        for row in reversed(rows):
            msg = self._message_from_row(row)
            if msg["author_type"] == "user":
                history.append({"role": "user", "content": self._history_message_content(msg)})
            elif msg["author_type"] == "agent":
                history.append({"role": "assistant", "content": self._history_message_content(msg)})
        return history

    def _recent_context(self, scope_type: str, scope_id: str, content: str) -> str:
        messages = self.list_messages({"id": 0}, scope_type, scope_id, limit=12)
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
        return f"{self._actor_display_name(actor)}: {content}"

    @staticmethod
    def _history_message_content(message: dict[str, Any]) -> str:
        if message.get("scope_type") != "channel":
            return str(message.get("content") or "")
        speaker = str(message.get("username") or ("Agent" if message.get("author_type") == "agent" else "User"))
        return f"{speaker}: {message.get('content') or ''}"

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
    if not value:
        return ""
    if len(value) <= 8:
        return "*" * len(value)
    return f"{value[:3]}...{value[-4:]}"
