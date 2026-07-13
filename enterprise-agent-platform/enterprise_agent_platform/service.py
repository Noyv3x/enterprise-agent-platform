from __future__ import annotations

import fcntl
import hashlib
import ipaddress
import json
import mimetypes
import os
import re
import secrets
import shlex
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import weakref
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Deque

from .auth import TokenSigner, hash_password, verify_password
from .agent_scopes import AgentExecutionScope, AgentScopeManager
from .auto_update import AutoUpdateManager
from .cognee_bridge import CogneeBridge
from .config import OAUTH_SECRET_KEYS, PlatformConfig
from .db import Database, decode_json, encode_json, now_ts
from .agent_runtime_client import (
    AgentClient,
    AgentResult,
    AgentRuntimeClient,
    AgentRuntimeRunError,
)
from .internal_config import (
    read_cognee_internal_config,
    update_env_file,
)
from .jobs import DurableJob, DurableJobStore
from .knowledge import KnowledgeBase, format_passive_suggestions
from .oauth_flows import (
    CODEX_OAUTH_CLIENT_ID,
    CODEX_TOKEN_URL,
    XAI_OAUTH_CLIENT_ID,
    XAI_OAUTH_DISCOVERY_URL,
    OAuthFlowError,
    OAuthFlowManager,
    SUPPORTED_OAUTH_PROVIDERS,
    normalize_oauth_provider,
    oauth_provider_info,
)
from .runtimes import (
    AGENT_SETTING_COMPACTION_THRESHOLD,
    AGENT_SETTING_MANAGED,
    AGENT_SETTING_MAX_CONCURRENCY,
    AGENT_SETTING_MODEL,
    AGENT_SETTING_PROVIDER,
    AGENT_SETTING_TIMEOUT,
    PlatformRuntimeManager,
)
from .secure_fs import ensure_private_directory, write_private_file_exclusive


class ServiceError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class _AgentTaskCancelled(Exception):
    def __init__(self, message: str, *, needs_review: bool = False):
        super().__init__(message)
        self.needs_review = bool(needs_review)


class _ResizableConcurrencyGate:
    """A process-wide run limit that can follow runtime settings live.

    Reducing the limit never interrupts active generations; it only blocks new
    entrants until the active count falls below the new ceiling.
    """

    def __init__(self, limit: int):
        self._condition = threading.Condition()
        self._limit = max(1, min(64, int(limit)))
        self._active = 0

    @property
    def limit(self) -> int:
        with self._condition:
            return self._limit

    def resize(self, limit: int) -> None:
        with self._condition:
            self._limit = max(1, min(64, int(limit)))
            self._condition.notify_all()

    def __enter__(self) -> "_ResizableConcurrencyGate":
        with self._condition:
            while self._active >= self._limit:
                self._condition.wait()
            self._active += 1
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:
        with self._condition:
            self._active -= 1
            self._condition.notify_all()


@dataclass(frozen=True)
class UploadedFile:
    filename: str
    content_type: str
    data: bytes


def _float_env(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)) or str(default))
    except (TypeError, ValueError):
        return default


MAX_ATTACHMENTS_PER_MESSAGE = 10
MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
MAX_ATTACHMENTS_TOTAL_BYTES = max(
    MAX_ATTACHMENT_BYTES,
    int(os.getenv("ENTERPRISE_MAX_ATTACHMENTS_TOTAL_BYTES", str(100 * 1024 * 1024)) or "0"),
)
# Cumulative per-uploader storage budget for attachment blobs. Bounds deliberate
# or accidental disk exhaustion by any authenticated chat/private-agent user.
# 0 disables the quota.
ATTACHMENT_QUOTA_BYTES = max(0, int(os.getenv("ENTERPRISE_ATTACHMENT_QUOTA_BYTES", str(2 * 1024 * 1024 * 1024)) or "0"))
GLOBAL_ATTACHMENT_QUOTA_BYTES = max(
    0,
    int(os.getenv("ENTERPRISE_GLOBAL_ATTACHMENT_QUOTA_BYTES", str(10 * 1024 * 1024 * 1024)) or "0"),
)
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
MAX_AGENT_SESSION_ID_LENGTH = 512
# Global ceiling on concurrent in-flight Agent generations. Each conversation
# still drains its own queue in FIFO order, while this bound prevents a burst of
# distinct conversations from exhausting host threads and sockets.
MAX_CONCURRENT_AGENT_RUNS = max(
    1,
    min(64, int(os.getenv("ENTERPRISE_MAX_CONCURRENT_AGENT_RUNS", "8") or "8")),
)
# Cognee ingestion is heavy; it runs on a background worker so document creation
# never blocks the request thread (and, via the DB, every other request).
MAX_INGEST_QUEUE_DEPTH = 256
MAX_TRACKED_INGEST_RESULTS = 1000
# Bounded retry for transient Cognee ingest failures. A failed job is re-queued
# with a short capped backoff up to this many attempts before it is dropped and
# counted as a permanent failure (surfaced in knowledge_status).
MAX_INGEST_ATTEMPTS = max(1, int(os.getenv("ENTERPRISE_INGEST_MAX_ATTEMPTS", "3") or "3"))
INGEST_RETRY_BACKOFF_CAP_SECONDS = 30
AGENT_JOB_LEASE_SECONDS = max(60, int(os.getenv("ENTERPRISE_AGENT_JOB_LEASE_SECONDS", "3600") or "3600"))
COGNEE_JOB_LEASE_SECONDS = max(60, int(os.getenv("ENTERPRISE_COGNEE_JOB_LEASE_SECONDS", "3600") or "3600"))
TELEGRAM_LINK_TTL_SECONDS = max(60, min(int(os.getenv("ENTERPRISE_TELEGRAM_LINK_TTL_SECONDS", "600") or "600"), 3600))
TELEGRAM_DELIVERY_JOB_KIND = "telegram_delivery"
TELEGRAM_DELIVERY_LEASE_SECONDS = max(
    60, int(os.getenv("ENTERPRISE_TELEGRAM_DELIVERY_LEASE_SECONDS", "600") or "600")
)
TELEGRAM_DELIVERY_POLL_SECONDS = max(
    0.05, min(_float_env("ENTERPRISE_TELEGRAM_DELIVERY_POLL_SECONDS", 0.2), 2.0)
)
_DURABLE_AGENT_START_MESSAGE_SETTING = "durable_agent_jobs_start_message_id"
TELEGRAM_LINK_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
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
VISIBLE_TOOL_PROGRESS_EVENTS = frozenset(
    {"tool.started", "tool.updated", "tool.completed", "tool.failed"}
)


def is_substantive_tool_start(payload: dict[str, Any]) -> bool:
    if not isinstance(payload, dict):
        return False
    status = str(payload.get("status") or payload.get("event_type") or payload.get("event") or "").lower()
    if status not in {"running", "started", "start", "tool.started"}:
        return False
    tool = str(payload.get("tool") or payload.get("tool_name") or "").strip()
    return bool(tool) and not tool.startswith("_")

PERMISSION_READ_WORKSPACE = "read_workspace"
PERMISSION_CHAT = "chat"
PERMISSION_PRIVATE_AGENT = "private_agent"
PERMISSION_MANAGE_CHANNELS = "manage_channels"
PERMISSION_MANAGE_KNOWLEDGE = "manage_knowledge"
PERMISSION_MANAGE_USERS = "manage_users"
PERMISSION_SYSTEM_SETTINGS = "system_settings"

OAUTH_CREDENTIAL_EXPORT_KIND = "ubitech-agent.oauth-credentials"
OAUTH_CREDENTIAL_EXPORT_VERSION = 1
LEGACY_GENERATED_ATTACHMENT_SOURCE = "hermes"
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
        "description": "管理账户、模型配置和平台运行时。",
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
        "description": "管理频道和知识库，并使用 ubitech agent。",
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
        "description": "只能查看频道消息和知识库。",
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
        legacy_cleanup_runner=None,
        auto_update_runner=None,
        auto_update_launcher=None,
        auto_update_repo_root: Path | None = None,
        autostart_runtime: bool = True,
    ):
        self.config = config
        ensure_private_directory(self.config.data_dir)
        self._instance_lock_fd: int | None = None
        self._instance_lock_finalizer: weakref.finalize | None = None
        self._acquire_instance_lock()
        self.db = Database(config.db_path)
        self.jobs = DurableJobStore(self.db)
        # Agent runs and Telegram sends can have external side effects. An
        # interrupted running record is quarantined rather than blindly
        # repeated; queued work remains recoverable and is claimed at least
        # once after its exact Agent reply becomes available.
        self.jobs.recover_interrupted(unsafe_kinds={"agent", TELEGRAM_DELIVERY_JOB_KIND})
        # Telegram updates interrupted before acknowledgement are made
        # claimable again. Telegram will redeliver an unacknowledged webhook or
        # an uncommitted long-poll update; the update-id row remains the dedupe
        # boundary for every completed delivery.
        self.db.execute(
            "UPDATE telegram_updates SET status = 'queued', last_error = ? WHERE status = 'processing'",
            ("gateway interrupted by service restart",),
        )
        self.tokens = TokenSigner(self._resolve_session_secret(), self._effective_session_ttl_seconds())
        self.knowledge = KnowledgeBase(self.db)
        self._agent_runtime_config_lock = threading.RLock()
        self.runtimes = PlatformRuntimeManager(
            config,
            self.get_secret,
            process_launcher=runtime_process_launcher,
            command_runner=runtime_command_runner,
            setting_provider=self.get_setting,
        )
        self.cognee = CogneeBridge(config, self.get_secret, self.runtimes)
        # This runner is used only for one-time cleanup of resources recorded by
        # pre-host-execution installations. No Agent container is provisioned.
        self.agent_scopes = AgentScopeManager(
            config,
            self.db,
            cleanup_runner=legacy_cleanup_runner,
        )
        if not self.get_setting("agent_tool_token"):
            self.set_setting(
                "agent_tool_token",
                self.config.agent_tool_token or secrets.token_urlsafe(32),
                secret=True,
            )
        if not self.get_setting("agent_runtime_token"):
            self.set_setting(
                "agent_runtime_token",
                self.config.agent_runtime_token or secrets.token_urlsafe(32),
                secret=True,
            )
        self._uses_default_agent_client = agent_client is None
        self.agent_client = agent_client or self._new_agent_runtime_client()
        self.oauth_flows = OAuthFlowManager(oauth_http_client)
        self._conversation_lock = threading.RLock()
        # Message rows and their attachment files form one logical unit.  This
        # lock closes the file-written/row-inserted window against concurrent
        # administrative deletion; it is deliberately re-entrant because the
        # high-level delete helpers call the lower-level file cleanup helper.
        self._attachment_lock = threading.RLock()
        self._agent_queues: dict[str, Deque[dict[str, Any]]] = {}
        self._agent_workers: dict[str, threading.Thread] = {}
        self._agent_active_tasks: dict[str, dict[str, Any]] = {}
        self._agent_scope_epochs: dict[str, int] = {}
        self._agent_status: dict[str, dict[str, Any]] = {}
        self._typing: dict[str, dict[int, dict[str, Any]]] = {}
        self._auth_lock = threading.RLock()
        self._login_failures: dict[tuple[str, str], Deque[float]] = {}
        self._login_failures_by_user: dict[str, Deque[float]] = {}
        # Per-user upload timestamps for the sliding-window rate limiter.
        self._upload_rate: dict[int, Deque[float]] = {}
        # Fixed dummy hash so authentication spends a comparable amount of time
        # whether or not the username exists, eliminating a timing oracle.
        self._dummy_password_hash = hash_password(secrets.token_urlsafe(16))
        self._ingest_lock = threading.Lock()
        self._ingest_condition = threading.Condition(self._ingest_lock)
        self._ingest_queue: Deque[dict[str, Any]] = deque()
        self._ingest_thread: threading.Thread | None = None
        self._ingest_wakeup = threading.Event()
        self._ingest_results: dict[int, dict[str, Any]] = {}
        # Operator-visible counters for documents that exhausted ingest retries.
        self._ingest_failed_count = 0
        self._ingest_last_error = ""
        self._telegram_gateway = None
        self._telegram_delivery_lock = threading.Lock()
        self._telegram_delivery_wakeup = threading.Event()
        self._telegram_delivery_thread: threading.Thread | None = None
        self._telegram_delivery_handler: Callable[[dict[str, Any], dict[str, Any], dict[str, Any]], None] | None = None
        self._telegram_delivery_generation = 0
        self._auto_updater = AutoUpdateManager(
            self,
            repo_root=auto_update_repo_root,
            runner=auto_update_runner,
            launcher=auto_update_launcher,
        )
        self._closed = False
        self._resources_closed = False
        self._close_lock = threading.Lock()
        self.ensure_bootstrap()
        # Use the runtime manager's canonical parser so malformed legacy
        # values and persisted settings produce the exact same ceiling in both
        # the Python scheduler and the Node sidecar.
        self._agent_run_gate = _ResizableConcurrencyGate(
            self.runtimes._effective_agent_max_concurrency()
        )
        # Bootstrap may copy one-release legacy settings into the neutral Agent
        # runtime keys. Rebuild the owned client once so its URL and timeouts
        # agree with the runtime manager from the first actual generation.
        if self._uses_default_agent_client:
            self.agent_client = self._new_agent_runtime_client()
        self._cleanup_incomplete_attachment_messages()
        self._cleanup_orphan_attachment_files()
        # One-time compatibility cleanup. Failures stay tracked on the scope row
        # and are retried at a later start; they never prevent the host backend
        # from serving requests.
        try:
            self.agent_scopes.cleanup_legacy_containers()
        except Exception as exc:
            print(f"Failed to clean up legacy Agent containers: {exc}", file=sys.stderr)
        self.runtimes.prepare()
        if autostart_runtime and agent_client is None:
            prepare_agent_runtime = getattr(self.agent_client, "prepare_runtime", None)
            if callable(prepare_agent_runtime):
                try:
                    prepare_agent_runtime()
                except Exception as exc:
                    print(f"Failed to prepare Agent runtime client: {exc}", file=sys.stderr)
            self.runtimes.ensure_managed_tooling_ready(wait=False)
            self.runtimes.ensure_agent_runtime_ready(wait=False)
        self._recover_durable_work()
        self._start_telegram_gateway()
        self._start_auto_update_listener()

    def _new_agent_runtime_client(self) -> AgentRuntimeClient:
        runtime = self.runtimes.agent_runtime_config()
        runtime_token = self.config.agent_runtime_token or self.get_secret("agent_runtime_token")
        internal_host = str(self.config.host or "").strip()
        if internal_host in {"0.0.0.0", "::", ""}:
            internal_host = "127.0.0.1"
        if ":" in internal_host and not internal_host.startswith("["):
            internal_host = f"[{internal_host}]"
        return AgentRuntimeClient(
            str(runtime.get("runtime_url") or self.config.agent_runtime_url),
            runtime_token,
            timeout_seconds=float(
                runtime.get("timeout_seconds") or self.config.agent_runtime_timeout_seconds
            ),
            gateway_base_url=f"http://{internal_host}:{self.config.port}",
            gateway_token=self.get_secret("agent_tool_token"),
            default_provider=str(
                runtime.get("provider") or self.config.agent_runtime_provider
            ),
            default_model=str(runtime.get("model") or self.config.agent_runtime_model),
        )

    def close(self) -> None:
        with self._close_lock:
            if self._resources_closed:
                return
            with self._conversation_lock:
                self._closed = True
                workers = list(self._agent_workers.values())
            self.unregister_telegram_delivery_handler()
            if self._telegram_gateway is not None:
                self._telegram_gateway.stop()
            self._auto_updater.stop()
            self._ingest_wakeup.set()
            self._telegram_delivery_wakeup.set()

            # First terminate scope-owned processes and the managed runtimes so
            # blocked HTTP/Cognee calls return. The database deliberately stays
            # open until every worker has observed shutdown and persisted its
            # durable terminal state.
            self._cleanup_all_agent_scopes()
            close_agent_client = getattr(self.agent_client, "close", None)
            if callable(close_agent_client):
                try:
                    close_agent_client()
                except Exception:
                    pass
            self.runtimes.close()

            with self._ingest_lock:
                ingest = self._ingest_thread
            with self._telegram_delivery_lock:
                telegram_delivery = self._telegram_delivery_thread
            deadline = time.monotonic() + 15.0
            for worker in [ingest, telegram_delivery, *workers]:
                if worker is None or worker is threading.current_thread():
                    continue
                worker.join(timeout=max(0.0, deadline - time.monotonic()))

            live_workers = [
                worker
                for worker in [ingest, telegram_delivery, *workers]
                if worker is not None and worker is not threading.current_thread() and worker.is_alive()
            ]
            if live_workers:
                # Closing SQLite here would create a deterministic teardown race
                # with the still-running worker. Leave it open for a later close
                # attempt/process exit and make the condition operator-visible.
                print(
                    "Service shutdown deferred database close because workers are still active: "
                    + ", ".join(worker.name for worker in live_workers),
                    file=sys.stderr,
                )
                return
            self.db.close()
            self._release_instance_lock()
            self._resources_closed = True

    def _acquire_instance_lock(self) -> None:
        """Enforce one service process per platform data directory.

        SQLite serializes individual writes but cannot make the platform's
        in-memory workers, lifecycle epochs, and external side effects a
        multi-process transaction. The supported small trusted deployment is
        therefore explicitly single-instance. ``flock`` is released by the
        kernel on process death, making startup recovery proof that no prior
        owner is still processing Telegram updates or Agent jobs.
        """

        lock_path = self.config.data_dir / ".enterprise-platform.lock"
        fd = os.open(str(lock_path), os.O_RDWR | os.O_CREAT, 0o600)
        try:
            os.chmod(lock_path, 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            os.close(fd)
            raise RuntimeError(
                f"another ubitech agent instance is already using {self.config.data_dir}"
            ) from exc
        except Exception:
            os.close(fd)
            raise
        os.ftruncate(fd, 0)
        os.write(fd, f"{os.getpid()}\n".encode("ascii"))
        self._instance_lock_fd = fd
        self._instance_lock_finalizer = weakref.finalize(self, os.close, fd)

    def _release_instance_lock(self) -> None:
        fd = self._instance_lock_fd
        if fd is None:
            return
        self._instance_lock_fd = None
        finalizer = self._instance_lock_finalizer
        self._instance_lock_finalizer = None
        if finalizer is not None and finalizer.alive:
            finalizer.detach()
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)

    def _cleanup_agent_scope(
        self,
        scope_key: str,
        *,
        lifecycle_id: str | None = None,
        delete_sessions: bool = False,
        strict: bool = False,
    ) -> None:
        cleanup = getattr(self.agent_client, "cleanup_scope", None)
        if not callable(cleanup):
            return
        try:
            try:
                cleanup(
                    scope_key,
                    lifecycle_id=lifecycle_id,
                    delete_sessions=delete_sessions,
                )
            except TypeError:
                try:
                    # Test/local adapters and one-release third-party integrations
                    # may still expose the pre-delete-sessions signature.
                    cleanup(scope_key, lifecycle_id=lifecycle_id)
                except TypeError:
                    # Older adapters may expose only the original scope signature.
                    cleanup(scope_key)
        except Exception as exc:
            if not strict:
                print(f"Failed to clean Agent scope {scope_key}: {exc}", file=sys.stderr)
            else:
                # A successful lifecycle mutation must not leave a known live run
                # capable of further host-side tool effects. Restarting the managed
                # runtime is the fail-closed fallback when targeted cancellation
                # cannot be confirmed.
                try:
                    status = self.runtimes.restart_agent_runtime()
                except Exception as restart_exc:
                    raise ServiceError(
                        503,
                        f"Agent scope was reset but runtime cancellation failed: {restart_exc}",
                    ) from restart_exc
                if not status.available:
                    raise ServiceError(
                        503,
                        f"Agent scope was reset but runtime cancellation could not be confirmed: {status.error or exc}",
                    ) from exc
        try:
            self._agent_browser_tool(scope_key, "cleanup", {})
        except Exception as exc:
            # Browser is optional and may be disabled. Runtime/process cleanup
            # remains authoritative; tab/session reclamation is best effort.
            print(f"Failed to clean Agent browser scope {scope_key}: {exc}", file=sys.stderr)

    def _cleanup_all_agent_scopes(self) -> None:
        for row in self.db.query("SELECT scope_key FROM agent_scopes ORDER BY scope_key"):
            self._cleanup_agent_scope(str(row["scope_key"]))

    def _task_scope_is_current(self, task: dict[str, Any]) -> bool:
        key = self._conversation_key(str(task["scope_type"]), str(task["scope_id"]))
        with self._conversation_lock:
            lifecycle_current = (
                not self._closed
                and int(task.get("_scope_epoch") or 0) == int(self._agent_scope_epochs.get(key, 0))
            )
            if not lifecycle_current:
                return False
            job_id = int(task.get("_job_id") or 0)
            if not job_id:
                return True
            job = self.jobs.get(job_id)
            return job is not None and job.status == "running"

    def _ensure_agent_task_can_run(self, task: dict[str, Any]) -> None:
        if not self._task_scope_is_current(task):
            with self._conversation_lock:
                shutting_down = self._closed
            raise _AgentTaskCancelled(
                "service is shutting down" if shutting_down else "Agent conversation was reset",
                needs_review=shutting_down,
            )
        actor = task.get("actor") or {}
        user_id = actor.get("id")
        current = self.get_user(int(user_id)) if user_id is not None else None
        if not current or not current.get("active"):
            raise _AgentTaskCancelled("Agent request cancelled because the user account is inactive")

    def _cancel_agent_scope_work(
        self,
        scope_type: str,
        scope_id: str,
        *,
        reason: str,
        cleanup_runtime: bool = True,
    ) -> None:
        """Invalidate and terminally cancel active/queued work for a scope."""

        scope_type = str(scope_type)
        scope_id = str(scope_id)
        key = self._conversation_key(scope_type, scope_id)
        with self._conversation_lock:
            self._agent_scope_epochs[key] = int(self._agent_scope_epochs.get(key, 0)) + 1
            queued = list(self._agent_queues.pop(key, deque()))
            self._agent_status[key] = self._idle_agent_status(scope_type, scope_id)
            self._typing.pop(key, None)
        queued_ids = {
            int(task.get("_job_id") or 0)
            for task in queued
            if int(task.get("_job_id") or 0) > 0
        }
        timestamp = now_ts()
        with self.db.transaction() as conn:
            conn.execute(
                """
                UPDATE durable_jobs
                SET status = 'failed', lease_until = 0, last_error = ?, updated_at = ?
                WHERE kind = 'agent' AND scope_type = ? AND scope_id = ?
                  AND status IN ('queued', 'running')
                """,
                (str(reason)[:2000], timestamp, scope_type, scope_id),
            )
            if scope_type == "private":
                conn.execute(
                    """
                    UPDATE durable_jobs
                    SET status = 'failed', lease_until = 0, last_error = ?, updated_at = ?
                    WHERE kind = ? AND scope_type = 'private' AND scope_id = ? AND status = 'queued'
                    """,
                    (str(reason)[:2000], timestamp, TELEGRAM_DELIVERY_JOB_KIND, scope_id),
                )
            # Queues are only a wake-up mechanism, but keeping this explicit set
            # makes the intent clear and covers an in-memory task whose scope
            # fields were malformed before validation.
            for job_id in queued_ids:
                conn.execute(
                    """
                    UPDATE durable_jobs
                    SET status = 'failed', lease_until = 0, last_error = ?, updated_at = ?
                    WHERE id = ? AND status IN ('queued', 'running')
                    """,
                    (str(reason)[:2000], timestamp, job_id),
                )

        if scope_type == "private":
            scope_key = self.agent_scopes.private_scope_key(int(scope_id))
        else:
            scope_key = self.agent_scopes.channel_scope_key(scope_id)
        if cleanup_runtime and self.agent_scopes.get_scope(scope_key) is not None:
            self._cleanup_agent_scope(scope_key)

    def _recover_durable_work(self) -> None:
        """Rebuild disposable wake-up queues from the SQLite work ledger."""

        self._surface_interrupted_agent_jobs()
        self._surface_failed_agent_jobs_without_message()
        self._recover_agent_message_job_gaps()

        # Recovery is the only producer for these disposable in-memory queues;
        # silently truncating here strands every row after the limit until a
        # later process restart. Small internal deployments can safely rebuild
        # all queued ledger entries in one pass.
        for job in self.jobs.queued("agent", limit=None):
            task = dict(job.payload)
            if not self._valid_recovered_agent_task(task):
                self.jobs.mark_failed(job.id, "durable Agent payload is no longer valid")
                continue
            key = self._conversation_key(str(task["scope_type"]), str(task["scope_id"]))
            task["_scope_epoch"] = int(self._agent_scope_epochs.get(key, 0))
            task["_job_id"] = job.id
            self._schedule_agent_task(task, enforce_limit=False)

        recovered_ingest = []
        for job in self.jobs.queued("cognee", limit=None):
            payload = dict(job.payload)
            if not payload.get("document_id"):
                self.jobs.mark_failed(job.id, "durable Cognee payload is missing document_id")
                continue
            payload["_job_id"] = job.id
            recovered_ingest.append(payload)
        if recovered_ingest:
            with self._ingest_lock:
                self._ingest_queue.extend(recovered_ingest)
                self._start_ingest_worker_locked()

    def _surface_interrupted_agent_jobs(self) -> None:
        """Persist one visible reply for side-effectful runs needing review."""

        rows = self.db.query(
            "SELECT id FROM durable_jobs WHERE kind = 'agent' AND status = 'needs_review' ORDER BY id"
        )
        for row in rows:
            job = self.jobs.get(int(row["id"]))
            if job is None:
                continue
            if self._durable_job_success_message_exists(job.id):
                self.jobs.mark_succeeded(job.id, reconcile=True)
                continue
            if self._durable_job_message_exists(job.id):
                continue
            task = dict(job.payload)
            if not self._valid_recovered_agent_task(task):
                continue
            task["_job_id"] = job.id
            self._append_agent_error(
                task,
                "Agent execution was interrupted during restart; its side effects are uncertain and it was not run twice.",
            )

    def _surface_failed_agent_jobs_without_message(self) -> None:
        """Repair a failed run whose user-visible error write also failed.

        The ledger transition is intentionally independent from message I/O so
        a transient SQLite/filesystem failure cannot leave work running. This
        startup pass supplies the complementary at-least-once error message;
        ``durable_job_id`` makes repeated starts idempotent.
        """

        for row in self.db.query(
            "SELECT id FROM durable_jobs WHERE kind = 'agent' AND status = 'failed' ORDER BY id"
        ):
            job = self.jobs.get(int(row["id"]))
            if job is None or self._durable_job_message_exists(job.id):
                continue
            task = dict(job.payload)
            if not self._valid_recovered_agent_task(task):
                continue
            actor = task.get("actor") if isinstance(task.get("actor"), dict) else {}
            current = self.get_user(int(actor.get("id") or 0))
            if current is None or not current.get("active"):
                # Deactivation is an intentional lifecycle cancellation, not a
                # failed reply that should repopulate a private conversation.
                continue
            task["_job_id"] = job.id
            try:
                self._append_agent_error(
                    task,
                    job.last_error or "Agent execution failed before its error response could be saved.",
                )
            except Exception as exc:
                print(f"Failed to restore Agent error message for job {job.id}: {exc}", file=sys.stderr)

    def _recover_agent_message_job_gaps(self) -> None:
        """Repair the narrow message-commit/job-enqueue crash window.

        The first upgraded start records a high-water mark so historical chat
        is never replayed. Every later start scans only messages created under
        the durable-jobs release and recreates a missing idempotent job when no
        Agent reply already targets that message.
        """

        raw_start = self.get_setting(_DURABLE_AGENT_START_MESSAGE_SETTING)
        if raw_start is None:
            high_water = int(self.db.scalar("SELECT COALESCE(MAX(id), 0) FROM messages") or 0)
            self.set_setting(_DURABLE_AGENT_START_MESSAGE_SETTING, str(high_water))
            return
        try:
            start_id = max(0, int(raw_start))
        except (TypeError, ValueError):
            start_id = int(self.db.scalar("SELECT COALESCE(MAX(id), 0) FROM messages") or 0)
            self.set_setting(_DURABLE_AGENT_START_MESSAGE_SETTING, str(start_id))
            return

        rows = self.db.query(
            """
            SELECT * FROM messages
            WHERE id > ? AND author_type = 'user'
            ORDER BY id
            """,
            (start_id,),
        )
        for row in rows:
            message_id = int(row["id"])
            metadata = decode_json(row.get("metadata_json"))
            if str(row["scope_type"]) == "channel" and not bool(metadata.get("agent_mention")):
                continue
            if self.db.scalar(
                "SELECT 1 FROM durable_jobs WHERE kind = 'agent' AND dedupe_key = ?",
                (f"message:{message_id}",),
            ):
                continue
            if self._message_has_agent_reply(str(row["scope_type"]), str(row["scope_id"]), message_id):
                continue
            task = self._recovered_agent_task_from_message(row, metadata)
            if task is None:
                continue
            job, _ = self.jobs.enqueue(
                kind="agent",
                dedupe_key=f"message:{message_id}",
                payload=task,
                scope_type=str(row["scope_type"]),
                scope_id=str(row["scope_id"]),
            )
            task = dict(job.payload)
            task["_job_id"] = job.id
            self._schedule_agent_task(task, enforce_limit=False)

    def _recovered_agent_task_from_message(
        self,
        row: dict[str, Any],
        metadata: dict[str, Any],
    ) -> dict[str, Any] | None:
        user_id = row.get("user_id")
        actor = self.get_user(int(user_id)) if user_id is not None else None
        if not actor or not actor.get("active"):
            return None
        scope_type = str(row["scope_type"])
        scope_id = str(row["scope_id"])
        user_message = self._message_from_row(row)
        task: dict[str, Any] = {
            "scope_type": scope_type,
            "scope_id": scope_id,
            "actor": actor,
            "content": str(metadata.get("agent_request_content") or row.get("content") or ""),
            "attachments": self._attachments_for_message(int(row["id"]), include_local_path=True),
            "generation": metadata.get("generation") if isinstance(metadata.get("generation"), dict) else {},
            "user_message": user_message,
        }
        if scope_type == "channel":
            channel = self.db.query_one("SELECT * FROM channels WHERE id = ? AND archived = 0", (int(scope_id),))
            if channel is None:
                return None
            task["channel"] = channel
        return task

    def _message_has_agent_reply(self, scope_type: str, scope_id: str, message_id: int) -> bool:
        return self.agent_message_replying_to(scope_type, scope_id, message_id) is not None

    def _durable_job_message_exists(self, job_id: int) -> bool:
        rows = self.db.query(
            "SELECT metadata_json FROM messages WHERE author_type = 'agent' ORDER BY id DESC"
        )
        for row in rows:
            try:
                stored_job_id = int(decode_json(row.get("metadata_json")).get("durable_job_id") or 0)
            except (AttributeError, TypeError, ValueError):
                continue
            if stored_job_id == int(job_id):
                return True
        return False

    def _durable_job_success_message_exists(self, job_id: int) -> bool:
        rows = self.db.query(
            "SELECT metadata_json FROM messages WHERE author_type = 'agent' ORDER BY id DESC"
        )
        for row in rows:
            metadata = decode_json(row.get("metadata_json"))
            try:
                stored_job_id = int(metadata.get("durable_job_id") or 0)
            except (AttributeError, TypeError, ValueError):
                continue
            work = metadata.get("agent_work") if isinstance(metadata, dict) else None
            if stored_job_id == int(job_id) and isinstance(work, dict) and work.get("state") == "complete":
                return True
        return False

    def _valid_recovered_agent_task(self, task: dict[str, Any]) -> bool:
        try:
            scope_type = str(task["scope_type"])
            scope_id = str(task["scope_id"])
            user_message_id = int((task.get("user_message") or {})["id"])
        except (KeyError, TypeError, ValueError):
            return False
        if scope_type not in {"channel", "private"} or not scope_id:
            return False
        return bool(
            self.db.scalar(
                "SELECT 1 FROM messages WHERE id = ? AND scope_type = ? AND scope_id = ?",
                (user_message_id, scope_type, scope_id),
            )
        )

    def _start_telegram_gateway(self) -> None:
        if not self.telegram_enabled() or not self.telegram_bot_token():
            return
        try:
            from .telegram_gateway import TelegramGateway

            self._telegram_gateway = TelegramGateway(self, wait_for_response=False)
            self._telegram_gateway.start()
        except Exception as exc:
            print(f"Failed to start Telegram gateway: {exc}", file=sys.stderr)

    def _restart_telegram_gateway(self) -> None:
        # Revoke the sender before stopping/replacing the gateway.  The outbox
        # worker checks this registration generation again immediately before
        # transport I/O, so a disabled or rotated bot cannot consume queued
        # deliveries through a stale handler.
        self.unregister_telegram_delivery_handler()
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
                ("general", "ubitech agent shared channel", ts),
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
        legacy_settings = {
            AGENT_SETTING_PROVIDER: "hermes_provider",
            AGENT_SETTING_MODEL: "hermes_model",
            AGENT_SETTING_TIMEOUT: "hermes_timeout_seconds",
        }
        defaults = {
            AGENT_SETTING_PROVIDER: self.config.agent_runtime_provider,
            AGENT_SETTING_MODEL: self.config.agent_runtime_model,
            AGENT_SETTING_TIMEOUT: str(self.config.agent_runtime_timeout_seconds),
            AGENT_SETTING_MAX_CONCURRENCY: str(MAX_CONCURRENT_AGENT_RUNS),
            AGENT_SETTING_COMPACTION_THRESHOLD: "0.8",
        }
        for key, default in defaults.items():
            if self.get_setting(key) is not None:
                continue
            legacy_key = legacy_settings.get(key)
            legacy_value = self.get_setting(legacy_key) if legacy_key else None
            self.set_setting(key, legacy_value or default)

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

    def update_current_user(self, actor: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
        user_id = int(actor["id"])
        current = self.db.query_one("SELECT * FROM users WHERE id = ? AND active = 1", (user_id,))
        if not current:
            raise ServiceError(404, "user not found")

        updates: dict[str, Any] = {}
        if "display_name" in body:
            display_name = str(body.get("display_name", "")).strip()
            updates["display_name"] = display_name or current["username"]
        if "position" in body:
            updates["position"] = normalize_position(str(body.get("position", "")))

        updates = _changed_user_updates(current, updates)
        if not updates:
            return self.get_user(user_id) or {}
        assignments = ", ".join(f"{key} = ?" for key in updates)
        self.db.execute(
            f"UPDATE users SET {assignments} WHERE id = ?",
            [*updates.values(), user_id],
        )
        return self.get_user(user_id) or {}

    def change_current_user_password(self, actor: dict[str, Any], body: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        user_id = int(actor["id"])
        current = self.db.query_one("SELECT * FROM users WHERE id = ? AND active = 1", (user_id,))
        if not current:
            raise ServiceError(404, "user not found")

        current_password = str(body.get("current_password", "") or "")
        new_password = str(body.get("new_password", body.get("password", "")) or "")
        if not current_password:
            raise ServiceError(400, "current password is required")
        if not verify_password(current_password, str(current["password_hash"])):
            raise ServiceError(400, "current password is incorrect")
        if len(new_password) < MIN_PASSWORD_LENGTH:
            raise ServiceError(400, f"password must be at least {MIN_PASSWORD_LENGTH} characters")

        self.db.execute(
            "UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?",
            (hash_password(new_password), user_id),
        )
        updated = self.db.query_one("SELECT * FROM users WHERE id = ?", (user_id,))
        if not updated:
            raise ServiceError(404, "user not found")
        user = self.public_user(updated)
        token = self.tokens.issue(user_id, int(updated.get("token_version") or 1))
        return token, user

    def list_users(self, actor: dict[str, Any]) -> list[dict[str, Any]]:
        require_admin(actor)
        rows = self.db.query("SELECT * FROM users ORDER BY id")
        return [self.public_user(row) for row in rows]

    def impersonate_user(self, actor: dict[str, Any], user_id: int) -> tuple[str, dict[str, Any]]:
        """Issue a normal session token for an active target user.

        This is intentionally simple: after an admin chooses "impersonate", the
        browser's current admin cookie is replaced with the target user's cookie,
        exactly as if that user had just logged in.
        """
        require_admin(actor)
        target = self.db.query_one("SELECT * FROM users WHERE id = ? AND active = 1", (int(user_id),))
        if not target:
            raise ServiceError(404, "user not found")
        self.db.execute("UPDATE users SET last_login_at = ? WHERE id = ?", (now_ts(), target["id"]))
        user = self.public_user(target)
        token = self.tokens.issue(int(target["id"]), int(target.get("token_version") or 1))
        return token, user

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
        deactivating = updates.get("active") == 0
        deactivated_scope: AgentExecutionScope | None = None
        with self._conversation_lock:
            if deactivating:
                deactivated_scope = self.agent_scopes.get_scope(
                    self.agent_scopes.private_scope_key(int(user_id))
                )
            with self.db.transaction() as conn:
                # Serialize the invariant check with the mutation so two
                # administrators cannot both demote/deactivate themselves as
                # the other's presumed remaining administrator. The outer
                # lifecycle lock also orders stale authenticated writes after
                # this privilege/account change.
                conn.execute("BEGIN IMMEDIATE")
                locked = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
                if locked is None:
                    raise ServiceError(404, "user not found")
                self._guard_admin_update(actor, dict(locked), updates, conn=conn)
                conn.execute(
                    f"UPDATE users SET {assignments} WHERE id = ?",
                    [*updates.values(), user_id],
                )
            if deactivating:
                self._cancel_agent_scope_work(
                    "private",
                    str(int(user_id)),
                    reason="Agent request cancelled because the user account was deactivated",
                    cleanup_runtime=False,
                )
                if deactivated_scope is not None:
                    # Keep the lifecycle gate closed until the old sidecar run
                    # and its processes are confirmed terminal. Otherwise a
                    # reactivation/new send can race and be killed by stale
                    # scope cleanup.
                    self._cleanup_agent_scope(
                        deactivated_scope.scope_key,
                        lifecycle_id=deactivated_scope.lifecycle_id,
                        strict=True,
                    )
        return self.get_user(user_id) or {}

    def deactivate_user(self, actor: dict[str, Any], user_id: int) -> dict[str, Any]:
        result = self.update_user(actor, user_id, {"active": False})
        # Host execution keeps the user's scoped workspace, memory and session
        # so an administrator can reactivate the account without data loss.
        try:
            self.agent_scopes.deactivate_private_scope(int(user_id))
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

    def _guard_admin_update(
        self,
        actor: dict[str, Any],
        current: dict[str, Any],
        updates: dict[str, Any],
        *,
        conn=None,
    ) -> None:
        target_id = int(current["id"])
        next_role = str(updates.get("role", current["role"]))
        next_active = bool(updates.get("active", current["active"]))
        if target_id == int(actor["id"]):
            if not next_active:
                raise ServiceError(400, "cannot deactivate your own account")
            if next_role != "admin":
                raise ServiceError(400, "cannot remove your own admin permission")
        if current["role"] == "admin" and (next_role != "admin" or not next_active):
            if conn is None:
                remaining = self.db.scalar(
                    "SELECT COUNT(*) FROM users WHERE id != ? AND role = 'admin' AND active = 1",
                    (target_id,),
                )
            else:
                remaining = conn.execute(
                    "SELECT COUNT(*) FROM users WHERE id != ? AND role = 'admin' AND active = 1",
                    (target_id,),
                ).fetchone()[0]
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

    def agent_message_replying_to(
        self,
        scope_type: str,
        scope_id: str,
        user_message_id: int,
    ) -> dict[str, Any] | None:
        """Return only the Agent message that explicitly targets one user turn."""

        rows = self.db.query(
            """
            SELECT * FROM messages
            WHERE scope_type = ? AND scope_id = ? AND author_type = 'agent' AND id > ?
            ORDER BY id
            """,
            (str(scope_type), str(scope_id), int(user_message_id)),
        )
        for row in rows:
            metadata = decode_json(row.get("metadata_json"))
            reply_to = metadata.get("reply_to") if isinstance(metadata, dict) else None
            try:
                reply_message_id = int((reply_to or {}).get("message_id") or 0)
            except (AttributeError, TypeError, ValueError):
                continue
            if reply_message_id == int(user_message_id):
                return self._message_from_row(row)
        return None

    def wait_for_agent_reply_to(
        self,
        scope_type: str,
        scope_id: str,
        user_message_id: int,
        *,
        timeout: float = 240.0,
    ) -> dict[str, Any] | None:
        deadline = time.monotonic() + max(0.0, float(timeout))
        while True:
            message = self.agent_message_replying_to(scope_type, scope_id, user_message_id)
            if message is not None:
                return message
            if time.monotonic() >= deadline:
                return None
            time.sleep(min(TELEGRAM_DELIVERY_POLL_SECONDS, max(0.0, deadline - time.monotonic())))

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

        return TelegramGateway(self, autostart=False, wait_for_response=False).process_update(update)

    def register_telegram_delivery_handler(
        self,
        handler: Callable[[dict[str, Any], dict[str, Any], dict[str, Any]], None],
    ) -> int:
        """Install the current Bot API sender and start the bounded outbox worker."""

        with self._telegram_delivery_lock:
            self._telegram_delivery_generation += 1
            self._telegram_delivery_handler = handler
            generation = self._telegram_delivery_generation
            self._ensure_telegram_delivery_worker_locked()
        self._telegram_delivery_wakeup.set()
        return generation

    def unregister_telegram_delivery_handler(self, generation: int | None = None) -> None:
        """Revoke one sender registration without disturbing a newer gateway."""

        with self._telegram_delivery_lock:
            if generation is not None and int(generation) != self._telegram_delivery_generation:
                return
            self._telegram_delivery_handler = None
            self._telegram_delivery_generation += 1
        self._telegram_delivery_wakeup.set()

    def _ensure_telegram_delivery_worker_locked(self) -> None:
        if self._closed or self._telegram_delivery_handler is None:
            return
        if self._telegram_delivery_thread is None or not self._telegram_delivery_thread.is_alive():
            self._telegram_delivery_thread = threading.Thread(
                target=self._telegram_delivery_worker,
                name="telegram-delivery",
                daemon=True,
            )
            self._telegram_delivery_thread.start()

    def enqueue_telegram_delivery(
        self,
        *,
        actor: dict[str, Any],
        update_id: int | None,
        user_message_id: int,
        chat_id: int | str,
        reply_to_message_id: int | None,
        message_thread_id: int | None,
    ) -> DurableJob:
        payload = {
            "update_id": update_id,
            "user_id": int(actor["id"]),
            "scope_type": "private",
            "scope_id": str(actor["id"]),
            "user_message_id": int(user_message_id),
            "chat_id": chat_id,
            "reply_to_message_id": reply_to_message_id,
            "message_thread_id": message_thread_id,
        }
        job, _ = self.jobs.enqueue(
            kind=TELEGRAM_DELIVERY_JOB_KIND,
            dedupe_key=f"message:{int(user_message_id)}",
            payload=payload,
            scope_type="private",
            scope_id=str(actor["id"]),
        )
        with self._telegram_delivery_lock:
            self._ensure_telegram_delivery_worker_locked()
        self._telegram_delivery_wakeup.set()
        return job

    def enqueue_telegram_text_delivery(
        self,
        *,
        update_id: int,
        chat_id: int | str,
        reply_to_message_id: int | None,
        message_thread_id: int | None,
        text: str,
        result: dict[str, Any],
    ) -> DurableJob:
        payload = {
            "delivery_type": "text",
            "update_id": int(update_id),
            "chat_id": chat_id,
            "reply_to_message_id": reply_to_message_id,
            "message_thread_id": message_thread_id,
            "text": str(text),
            "result": dict(result),
        }
        job, _ = self.jobs.enqueue(
            kind=TELEGRAM_DELIVERY_JOB_KIND,
            dedupe_key=f"update:{int(update_id)}:reply",
            payload=payload,
            scope_type="telegram_update",
            scope_id=str(int(update_id)),
        )
        with self._telegram_delivery_lock:
            self._ensure_telegram_delivery_worker_locked()
        self._telegram_delivery_wakeup.set()
        return job

    def telegram_text_delivery(self, update_id: int | None) -> DurableJob | None:
        if update_id is None:
            return None
        return self.jobs.get_by_key(
            TELEGRAM_DELIVERY_JOB_KIND,
            f"update:{int(update_id)}:reply",
        )

    def telegram_update_result(self, update_id: int | None) -> dict[str, Any]:
        if update_id is None:
            return {}
        row = self.db.query_one(
            "SELECT result_json FROM telegram_updates WHERE update_id = ?",
            (int(update_id),),
        )
        result = decode_json(row.get("result_json")) if row else {}
        return result if isinstance(result, dict) else {}

    def wait_for_telegram_delivery(self, job_id: int, *, timeout: float) -> DurableJob | None:
        deadline = time.monotonic() + max(0.0, float(timeout))
        while True:
            job = self.jobs.get(int(job_id))
            if job is None or job.status in {"succeeded", "failed", "needs_review"}:
                return job
            if time.monotonic() >= deadline:
                return job
            time.sleep(min(0.05, max(0.0, deadline - time.monotonic())))

    def _telegram_delivery_worker(self) -> None:
        """Match exact replies, claim once, and deliver through one fixed worker."""

        while not self._closed:
            with self._telegram_delivery_lock:
                handler = self._telegram_delivery_handler
                generation = self._telegram_delivery_generation
            if handler is None or not self.telegram_enabled():
                self._telegram_delivery_wakeup.wait(TELEGRAM_DELIVERY_POLL_SECONDS)
                self._telegram_delivery_wakeup.clear()
                continue

            try:
                jobs = self.jobs.ready(TELEGRAM_DELIVERY_JOB_KIND, limit=1000)
            except Exception as exc:
                print(f"Telegram delivery worker could not read the outbox: {exc}", file=sys.stderr)
                self._telegram_delivery_wakeup.wait(TELEGRAM_DELIVERY_POLL_SECONDS)
                self._telegram_delivery_wakeup.clear()
                continue
            for job in jobs:
                if self._closed:
                    return
                with self._telegram_delivery_lock:
                    registration_is_current = (
                        self._telegram_delivery_handler is handler
                        and self._telegram_delivery_generation == generation
                    )
                if not registration_is_current or not self.telegram_enabled():
                    break
                try:
                    self._process_telegram_delivery_job(job, handler, generation)
                except Exception as exc:
                    # Keep the fixed worker alive across an unexpected malformed
                    # row or transient SQLite failure. A future pass/restart sees
                    # the still-queued or running ledger state.
                    print(f"Telegram delivery worker failed on job {job.id}: {exc}", file=sys.stderr)

            self._telegram_delivery_wakeup.wait(TELEGRAM_DELIVERY_POLL_SECONDS)
            self._telegram_delivery_wakeup.clear()

    def _process_telegram_delivery_job(
        self,
        job: DurableJob,
        handler: Callable[[dict[str, Any], dict[str, Any], dict[str, Any]], None],
        generation: int,
    ) -> None:
        payload = job.payload
        text_delivery = str(payload.get("delivery_type") or "") == "text"
        if text_delivery:
            if payload.get("chat_id") is None or not str(payload.get("text") or "").strip():
                self.jobs.mark_failed(job.id, "Telegram text delivery payload is invalid")
                return
            agent_message = {
                "id": None,
                "content": str(payload["text"]),
                "attachments": [],
                "metadata": {},
            }
            actor: dict[str, Any] = {}
        else:
            try:
                user_message_id = int(payload["user_message_id"])
                scope_type = str(payload["scope_type"])
                scope_id = str(payload["scope_id"])
            except (KeyError, TypeError, ValueError):
                self.jobs.mark_failed(job.id, "Telegram delivery payload is invalid")
                return

            agent_message = self.agent_message_replying_to(
                scope_type,
                scope_id,
                user_message_id,
            )
            if agent_message is None:
                agent_job = self.jobs.get_by_key("agent", f"message:{user_message_id}")
                if agent_job is None or agent_job.status not in {"failed", "needs_review"}:
                    return
                # Normally Agent failures persist an exactly-linked message.
                agent_message = {
                    "id": None,
                    "content": "Agent 请求未能完成，请在平台中检查任务状态后重试。",
                    "attachments": [],
                    "metadata": {"reply_to": {"message_id": user_message_id}},
                }
            actor = self.get_user(int(payload.get("user_id") or 0)) or {}

        claimed = self.jobs.mark_running(
            job.id,
            lease_seconds=TELEGRAM_DELIVERY_LEASE_SECONDS,
        )
        if claimed is None:
            return
        if not text_delivery and not actor.get("active"):
            self.jobs.mark_failed(job.id, "Telegram delivery user is missing or inactive")
            return
        try:
            # Reserve the current registration immediately before transport,
            # but never hold the configuration lock across network I/O. A send
            # already reserved before revocation may finish as an in-flight
            # request; no later job can reserve the stale generation, and
            # shutdown/token rotation cannot block for the Bot API's 60s file
            # timeout merely trying to acquire this lock.
            with self._telegram_delivery_lock:
                if (
                    self._closed
                    or not self.telegram_enabled()
                    or self._telegram_delivery_handler is not handler
                    or self._telegram_delivery_generation != int(generation)
                ):
                    self.jobs.requeue(job.id, error="Telegram delivery handler was revoked")
                    return
            handler(actor, payload, agent_message)
        except Exception as exc:
            # A transport failure can be ambiguous: Telegram may have accepted
            # the send before the response was lost. Quarantine instead of
            # automatically duplicating a successful message.
            self.jobs.mark_failed(job.id, str(exc), needs_review=True)
            print(f"Telegram delivery {job.id} needs review: {exc}", file=sys.stderr)
        else:
            self.jobs.mark_succeeded(job.id)

    def claim_telegram_update(self, update_id: int) -> bool:
        """Atomically claim a Telegram update across webhook/poller workers."""

        update_id = int(update_id)
        ts = now_ts()
        with self.db.transaction() as conn:
            row = conn.execute(
                "SELECT status FROM telegram_updates WHERE update_id = ?",
                (update_id,),
            ).fetchone()
            if row is None:
                conn.execute(
                    """
                    INSERT INTO telegram_updates(update_id, status, received_at, last_error)
                    VALUES (?, 'processing', ?, '')
                    """,
                    (update_id, ts),
                )
                claimed = True
            elif str(row["status"]) in {"queued", "failed"}:
                cursor = conn.execute(
                    """
                    UPDATE telegram_updates
                    SET status = 'processing', processed_at = NULL, last_error = ''
                    WHERE update_id = ? AND status IN ('queued', 'failed')
                    """,
                    (update_id,),
                )
                claimed = cursor.rowcount > 0
            else:
                claimed = False
            if update_id % 100 == 0:
                conn.execute(
                    """
                    DELETE FROM telegram_updates
                    WHERE received_at < ? AND status IN ('succeeded', 'ignored')
                    """,
                    (ts - 30 * 24 * 60 * 60,),
                )
        return claimed

    def finish_telegram_update(self, update_id: int, *, ignored: bool = False, error: str = "") -> None:
        status = "failed" if error else ("ignored" if ignored else "succeeded")
        self.db.execute(
            """
            UPDATE telegram_updates
            SET status = ?, processed_at = ?, last_error = ?
            WHERE update_id = ? AND status = 'processing'
            """,
            (status, now_ts(), str(error)[:2000], int(update_id)),
        )

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
        ts = now_ts()
        self.db.execute(
            "DELETE FROM telegram_link_challenges WHERE expires_at <= ?",
            (ts,),
        )
        identity = self.db.query_one(
            """
            SELECT external_id, username, display_name, updated_at
            FROM external_identities
            WHERE provider = 'telegram' AND user_id = ?
            """,
            (int(actor["id"]),),
        )
        pending = self.db.query_one(
            "SELECT expires_at FROM telegram_link_challenges WHERE user_id = ? AND expires_at > ?",
            (int(actor["id"]), ts),
        )
        return {
            "gateway": self.telegram_public_config(),
            "link": ({
                "telegram_user_id": identity["external_id"] if identity else "",
                "telegram_username": identity["username"] if identity else "",
                "telegram_display_name": identity["display_name"] if identity else "",
                "updated_at": identity["updated_at"] if identity else None,
            } if identity else None),
            # A GET intentionally never reveals the one-time code again. The
            # browser can still poll this expiry while waiting for Telegram to
            # complete the proof-of-ownership flow.
            "pending": ({"status": "pending", "expires_at": int(pending["expires_at"])} if pending else None),
            "deliveries": self.jobs.counts(
                kind=TELEGRAM_DELIVERY_JOB_KIND,
                scope_type="private",
                scope_id=str(actor["id"]),
            ),
        }

    def update_telegram_private_config(self, actor: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
        require_permission(actor, PERMISSION_PRIVATE_AGENT)
        if body.get("telegram_user_id") not in {None, ""}:
            raise ServiceError(400, "Telegram accounts must be linked with a one-time bot command")
        code = self._new_telegram_link_code()
        code_hash = self._telegram_link_code_hash(code)
        ts = now_ts()
        expires_at = ts + TELEGRAM_LINK_TTL_SECONDS
        with self.db.transaction() as conn:
            conn.execute("DELETE FROM telegram_link_challenges WHERE expires_at <= ?", (ts,))
            conn.execute(
                """
                INSERT INTO telegram_link_challenges(user_id, code_hash, expires_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    code_hash = excluded.code_hash,
                    expires_at = excluded.expires_at,
                    updated_at = excluded.updated_at
                """,
                (int(actor["id"]), code_hash, expires_at, ts, ts),
            )
        result = self.telegram_private_config(actor)
        result["pending"] = {
            "status": "pending",
            "expires_at": expires_at,
            "code": code,
            "command": f"/link {code}",
        }
        return result

    def unlink_telegram_private_config(self, actor: dict[str, Any]) -> dict[str, Any]:
        require_permission(actor, PERMISSION_PRIVATE_AGENT)
        with self.db.transaction() as conn:
            conn.execute(
                "DELETE FROM external_identities WHERE provider = 'telegram' AND user_id = ?",
                (int(actor["id"]),),
            )
            conn.execute(
                "DELETE FROM telegram_link_challenges WHERE user_id = ?",
                (int(actor["id"]),),
            )
        return self.telegram_private_config(actor)

    def complete_telegram_link(
        self,
        code: str,
        telegram_user: dict[str, Any],
        *,
        update_id: int | None = None,
    ) -> dict[str, Any]:
        """Consume a one-time challenge and bind the speaking Telegram user."""

        normalized = self._normalize_telegram_link_code(code)
        if not normalized:
            raise ServiceError(400, "Telegram binding code is invalid")
        external_id = self._validate_telegram_user_id(telegram_user.get("id"))
        code_hash = hashlib.sha256(normalized.encode("ascii")).hexdigest()
        ts = now_ts()
        with self.db.transaction() as conn:
            # Consume the one-time proof under an immediate write lock so two
            # simultaneous bot updates cannot both validate the same code.
            conn.execute("BEGIN IMMEDIATE")
            challenge = conn.execute(
                """
                SELECT c.user_id, c.expires_at, u.active
                FROM telegram_link_challenges c
                JOIN users u ON u.id = c.user_id
                WHERE c.code_hash = ?
                """,
                (code_hash,),
            ).fetchone()
            if challenge is None or int(challenge["expires_at"]) <= ts:
                conn.execute("DELETE FROM telegram_link_challenges WHERE code_hash = ?", (code_hash,))
                raise ServiceError(400, "Telegram binding code is invalid or expired")
            if not bool(challenge["active"]):
                raise ServiceError(403, "Platform account is inactive")
            user_id = int(challenge["user_id"])
            conflict = conn.execute(
                """
                SELECT user_id FROM external_identities
                WHERE provider = 'telegram' AND external_id = ? AND user_id != ?
                """,
                (external_id, user_id),
            ).fetchone()
            if conflict is not None:
                raise ServiceError(409, "This Telegram account is already linked to another platform user")
            existing = conn.execute(
                """
                SELECT created_at FROM external_identities
                WHERE provider = 'telegram' AND (user_id = ? OR external_id = ?)
                ORDER BY CASE WHEN external_id = ? THEN 0 ELSE 1 END LIMIT 1
                """,
                (user_id, external_id, external_id),
            ).fetchone()
            conn.execute(
                "DELETE FROM external_identities WHERE provider = 'telegram' AND user_id = ?",
                (user_id,),
            )
            conn.execute(
                """
                INSERT INTO external_identities(
                    provider, external_id, user_id, username, display_name,
                    metadata_json, created_at, updated_at
                ) VALUES ('telegram', ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    external_id,
                    user_id,
                    str(telegram_user.get("username") or "").strip().lstrip("@")[:80],
                    self._telegram_display_name(telegram_user)[:120],
                    encode_json({"configured_by": "telegram_challenge", "user": telegram_user}),
                    int(existing["created_at"]) if existing else ts,
                    ts,
                ),
            )
            conn.execute("DELETE FROM telegram_link_challenges WHERE user_id = ?", (user_id,))
            if update_id is not None:
                conn.execute(
                    """
                    UPDATE telegram_updates
                    SET result_json = ?
                    WHERE update_id = ? AND status = 'processing'
                    """,
                    (
                        encode_json(
                            {
                                "ok": True,
                                "command": True,
                                "linked": True,
                                "user_id": user_id,
                            }
                        ),
                        int(update_id),
                    ),
                )
        actor = self.get_user(user_id)
        if actor is None:
            raise ServiceError(404, "Platform account no longer exists")
        return actor

    @classmethod
    def _new_telegram_link_code(cls) -> str:
        raw = "".join(secrets.choice(TELEGRAM_LINK_CODE_ALPHABET) for _ in range(8))
        return f"{raw[:4]}-{raw[4:]}"

    @staticmethod
    def _normalize_telegram_link_code(value: Any) -> str:
        normalized = re.sub(r"[^A-Za-z0-9]", "", str(value or "")).upper()
        if len(normalized) != 8 or any(ch not in TELEGRAM_LINK_CODE_ALPHABET for ch in normalized):
            return ""
        return normalized

    @classmethod
    def _telegram_link_code_hash(cls, value: Any) -> str:
        normalized = cls._normalize_telegram_link_code(value)
        if not normalized:
            raise ServiceError(400, "Telegram binding code is invalid")
        return hashlib.sha256(normalized.encode("ascii")).hexdigest()

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
        enabled = parse_bool(body.get("enabled")) if "enabled" in body else None
        polling = parse_bool(body.get("polling")) if "polling" in body else None
        username = None
        token = None
        webhook_secret = None
        if "bot_username" in body:
            username = str(body.get("bot_username") or "").strip().lstrip("@")
            if username and not re.fullmatch(r"[A-Za-z0-9_]{3,80}", username):
                raise ServiceError(400, "Telegram bot username is invalid")
        if "bot_token" in body:
            token = str(body.get("bot_token") or "").strip()
        if "webhook_secret" in body:
            webhook_secret = str(body.get("webhook_secret") or "").strip()
            if webhook_secret and not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", webhook_secret):
                raise ServiceError(400, "Telegram webhook secret must be 8-128 URL-safe characters")

        # Validation happens first; then revoke the old token-bound transport
        # before changing any live setting. This closes the rotation window in
        # which the old Bot API client could otherwise consume queued outbox
        # rows after a new token had already been persisted.
        self.unregister_telegram_delivery_handler()
        if "enabled" in body:
            self.set_setting(TELEGRAM_SETTING_ENABLED, "1" if enabled else "0")
        if "polling" in body:
            self.set_setting(TELEGRAM_SETTING_POLLING, "1" if polling else "0")
        if "bot_username" in body:
            self.set_setting(TELEGRAM_SETTING_BOT_USERNAME, username or "")
        if token is not None:
            if token:
                self.set_setting(TELEGRAM_SECRET_BOT_TOKEN, token, secret=True)
        if webhook_secret is not None:
            if webhook_secret:
                self.set_setting(TELEGRAM_SECRET_WEBHOOK_SECRET, webhook_secret, secret=True)
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
        with self._conversation_lock:
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
            cleanup_scope_keys = self._active_agent_scope_keys_for_message_ids([int(message_id)])
            self._delete_message_ids(
                [int(message_id)],
                reason="Agent request cancelled because its source message was deleted",
            )
            result = {"deleted": 1, "message": message}
            for scope_key in cleanup_scope_keys:
                self._cleanup_agent_scope(scope_key, strict=True)
        return result

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
        with self._conversation_lock:
            rows = self.db.query(
                """
                SELECT id FROM messages
                WHERE scope_type = 'channel' AND scope_id = ? AND created_at < ?
                """,
                (scope_id, before_ts),
            )
            message_ids = [int(row["id"]) for row in rows]
            cleanup_scope_keys = self._active_agent_scope_keys_for_message_ids(message_ids)
            deleted = self._delete_message_ids(
                message_ids,
                reason="Agent request cancelled because its source message was deleted",
            )
            result = {"deleted": deleted, "before_created_at": before_ts}
            for scope_key in cleanup_scope_keys:
                self._cleanup_agent_scope(scope_key, strict=True)
        return result

    def clear_channel_messages(self, actor: dict[str, Any], channel_id: int) -> dict[str, Any]:
        require_admin(actor)
        self.get_channel(actor, channel_id)
        return self._clear_agent_conversation("channel", str(channel_id))

    def _clear_agent_conversation(self, scope_type: str, scope_id: str) -> dict[str, Any]:
        """Atomically order clear against new sends and terminal Agent writes."""

        with self._conversation_lock:
            if scope_type == "channel":
                agent_scope = self._channel_agent_scope(scope_id)
            else:
                agent_scope = self.agent_scopes.ensure_private_scope(int(scope_id))
            # Rotate the durable Agent lifecycle before deleting visible
            # history. If this persistence step fails, the API fails with all
            # messages intact; it can never report a partially cleared UI that
            # silently reconnects to the old Agent memory session.
            self.agent_scopes.rotate_session(agent_scope.scope_key)
            self._cancel_agent_scope_work(
                scope_type,
                scope_id,
                reason=f"Agent request cancelled because the {scope_type} conversation was cleared",
                cleanup_runtime=False,
            )
            deleted = self.db.scalar(
                "SELECT COUNT(*) FROM messages WHERE scope_type = ? AND scope_id = ?",
                (scope_type, scope_id),
            )
            rows = self.db.query(
                "SELECT id FROM messages WHERE scope_type = ? AND scope_id = ?",
                (scope_type, scope_id),
            )
            self._delete_message_ids(
                [int(row["id"]) for row in rows],
                reason=f"Agent request cancelled because the {scope_type} conversation was cleared",
            )
            result = {"deleted": int(deleted or 0)}
            self._cleanup_agent_scope(
                agent_scope.scope_key,
                lifecycle_id=agent_scope.lifecycle_id,
                delete_sessions=True,
                strict=True,
            )
        return result

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
        with self._conversation_lock:
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
            cleanup_scope_keys = self._active_agent_scope_keys_for_message_ids([int(message_id)])
            self._delete_message_ids(
                [int(message_id)],
                reason="Agent request cancelled because its source message was deleted",
            )
            result = {"deleted": 1, "message": message}
            for scope_key in cleanup_scope_keys:
                self._cleanup_agent_scope(scope_key, strict=True)
        return result

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
        with self._conversation_lock:
            rows = self.db.query(
                """
                SELECT id FROM messages
                WHERE scope_type = 'private' AND scope_id = ? AND created_at < ?
                """,
                (scope_id, before_ts),
            )
            message_ids = [int(row["id"]) for row in rows]
            cleanup_scope_keys = self._active_agent_scope_keys_for_message_ids(message_ids)
            deleted = self._delete_message_ids(
                message_ids,
                reason="Agent request cancelled because its source message was deleted",
            )
            result = {"deleted": deleted, "before_created_at": before_ts}
            for scope_key in cleanup_scope_keys:
                self._cleanup_agent_scope(scope_key, strict=True)
        return result

    def clear_private_messages(self, actor: dict[str, Any], user_id: int) -> dict[str, Any]:
        require_admin(actor)
        subject = self._private_audit_subject(user_id)
        scope_id = str(int(subject["id"]))
        return self._clear_agent_conversation("private", scope_id)

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
        provider = normalize_oauth_provider(str(generation.get("provider") or self._active_oauth_provider()))
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
        scope_id = str(channel_id)
        agent_content = channel_agent_request(content)
        if agent_content is not None and uploads:
            cleaned = AGENT_MENTION_RE.sub("", content).strip()
            cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
            agent_content = cleaned
        with self._conversation_lock:
            actor = self._fresh_active_actor(actor)
            require_permission(actor, PERMISSION_CHAT)
            generation = self.account_generation_config(actor)
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
                    "agent_request_content": agent_content or "",
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
        self._record_agent_activity(
            "channel",
            scope_id,
            "replying",
            "等待 Agent 运行过程",
            generation["model"],
            coalesce=True,
        )
        agent_scope = self._channel_agent_scope(scope_id)
        session_id = agent_scope.session_id
        workspace_path = Path(agent_scope.workspace_path)
        execution = agent_scope.to_execution_dict()
        result = self.agent_client.generate(
            system_prompt=system_prompt,
            user_message=self._channel_speaker_line(task["actor"], prompt_content),
            history=self._agent_session_seed_history("channel", scope_id, int(user_msg["id"])),
            session_id=session_id,
            session_key=f"channel:{scope_id}:main-agent",
            metadata={
                "knowledge_suggestions": [h.to_dict() for h in suggestions],
                "idempotency_key": f"agent-job:{int(task.get('_job_id') or user_msg['id'])}",
                "provider": generation["provider"],
                "actor": self._agent_actor_metadata(task["actor"]),
                "execution": execution,
                "workspace": {
                    "path": str(workspace_path),
                    "scope": "channel",
                    "scope_id": scope_id,
                },
                "attachments": self._attachment_metadata_for_agent(attachments),
            },
            attachments=attachments,
            model=generation["model"],
            thinking_depth=generation["thinking_depth"],
            reasoning_config=generation["reasoning_config"],
            progress_callback=lambda event: (
                self._record_agent_progress("channel", scope_id, event)
                if self._task_scope_is_current(task)
                else None
            ),
            content_callback=lambda delta: (
                self._record_agent_content_delta("channel", scope_id, delta)
                if self._task_scope_is_current(task)
                else None
            ),
        )
        self._ensure_agent_task_can_run(task)
        clean_content, generated_attachments = self._extract_generated_attachments(
            result.content,
            workspace_path=workspace_path,
        )
        token_usage = self._token_usage_from_agent_result(result, generation)
        with self._conversation_lock:
            # Session persistence, terminal status and message insertion form a
            # single lifecycle boundary against clear/deactivate.
            self._ensure_agent_task_can_run(task)
            self._remember_channel_agent_session_id(scope_id, result.session_id)
            refreshed_scope = self.agent_scopes.get_scope(agent_scope.scope_key)
            if refreshed_scope is not None:
                execution = refreshed_scope.to_execution_dict()
            self._record_agent_activity("channel", scope_id, "complete", "回复已生成", "保存到频道消息")
            metadata = {
                "session_id": result.session_id,
                "degraded": result.degraded,
                "execution": execution,
                "generation": generation,
                "knowledge_suggestions": [h.to_dict() for h in suggestions],
                "idempotency_key": f"agent-job:{int(task.get('_job_id') or user_msg['id'])}",
                "reply_to": self._reply_target(task),
            }
            if task.get("_job_id"):
                metadata["durable_job_id"] = int(task["_job_id"])
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
                attachment_source="agent_generated",
                attachment_uploader_user_id=int(task["actor"]["id"]),
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
        *,
        telegram_update_id: int | None = None,
    ) -> dict[str, Any]:
        require_permission(actor, PERMISSION_PRIVATE_AGENT)
        content = content.strip()
        uploads = self._normalize_uploaded_files(attachments)
        if not content and not uploads:
            raise ServiceError(400, "message content is required")
        if telegram_update_id is not None:
            try:
                telegram_update_id = int(telegram_update_id)
            except (TypeError, ValueError) as exc:
                raise ServiceError(400, "Telegram update id is invalid") from exc
        scope_id = str(actor["id"])
        with self._conversation_lock:
            actor = self._fresh_active_actor(actor)
            require_permission(actor, PERMISSION_PRIVATE_AGENT)
            default_generation = self.account_generation_config(actor)
            user_msg = (
                self._private_user_message_for_telegram_update(scope_id, telegram_update_id)
                if telegram_update_id is not None
                else None
            )
            if user_msg is None:
                if uploads:
                    self._enforce_upload_rate_limit(actor.get("id"))
                metadata: dict[str, Any] = {
                    "generation": default_generation,
                    "attachment_count": len(uploads),
                }
                if telegram_update_id is not None:
                    metadata["telegram_update_id"] = telegram_update_id
                user_msg = self._append_message(
                    scope_type="private",
                    scope_id=scope_id,
                    author_type="user",
                    user_id=actor["id"],
                    username=actor["display_name"],
                    content=content,
                    metadata=metadata,
                    attachments=uploads,
                )
            stored_metadata = user_msg.get("metadata") if isinstance(user_msg.get("metadata"), dict) else {}
            generation = (
                stored_metadata.get("generation")
                if isinstance(stored_metadata.get("generation"), dict)
                else default_generation
            )
            task_content = str(user_msg.get("content") or "")
            agent_attachments = self._attachments_for_message(int(user_msg["id"]), include_local_path=True)
            agent_scope = self.agent_scopes.ensure_private_scope(actor["id"])
            status = self._enqueue_agent_reply(
                {
                    "scope_type": "private",
                    "scope_id": scope_id,
                    "actor": dict(actor),
                    "content": task_content,
                    "attachments": agent_attachments,
                    "generation": generation,
                    "user_message": user_msg,
                }
            )
        return {
            "user_message": user_msg,
            "agent_message": None,
            "agent_status": status,
            "execution": agent_scope.to_execution_dict(),
        }

    def _fresh_active_actor(self, actor: dict[str, Any]) -> dict[str, Any]:
        """Revalidate a request actor at the serialized mutation boundary."""

        try:
            user_id = int(actor["id"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ServiceError(401, "authentication required") from exc
        current = self.get_user(user_id)
        if current is None or not current.get("active"):
            raise ServiceError(401, "account is inactive")
        return current

    def _private_user_message_for_telegram_update(
        self,
        scope_id: str,
        update_id: int,
    ) -> dict[str, Any] | None:
        """Find one replayed Telegram turn by parsing, never pattern matching, metadata."""

        rows = self.db.query(
            """
            SELECT * FROM messages
            WHERE scope_type = 'private' AND scope_id = ? AND author_type = 'user'
            ORDER BY id DESC
            """,
            (str(scope_id),),
        )
        for row in rows:
            metadata = decode_json(row.get("metadata_json"))
            stored_update_id = metadata.get("telegram_update_id") if isinstance(metadata, dict) else None
            # JSON Telegram update IDs are integers. Requiring that exact type
            # avoids accidental matches against arbitrary string metadata.
            if type(stored_update_id) is int and stored_update_id == int(update_id):
                return self._message_from_row(row)
        return None

    def _send_private_agent_reply(self, task: dict[str, Any]) -> dict[str, Any]:
        actor = task["actor"]
        content = str(task["content"])
        attachments = list(task.get("attachments") or [])
        prompt_content = self._agent_prompt_content(content, attachments, default="请处理这些附件。")
        generation = task["generation"]
        scope_id = str(task["scope_id"])
        user_msg = task["user_message"]
        self._record_agent_activity("private", scope_id, "preparing", "准备私人工作区", f"u{actor['id']}")
        agent_scope = self.agent_scopes.ensure_private_scope(actor["id"])
        execution = agent_scope.to_execution_dict()
        suggestions = self.knowledge.suggest(self._recent_context_before("private", scope_id, prompt_content, int(user_msg["id"])))
        system_prompt = self._private_system_prompt(actor, agent_scope, suggestions)
        self._record_agent_activity(
            "private",
            scope_id,
            "replying",
            "等待 Agent 运行过程",
            generation["model"],
            coalesce=True,
        )
        result = self.agent_client.generate(
            system_prompt=system_prompt,
            user_message=prompt_content,
            history=self._agent_session_seed_history("private", scope_id, int(user_msg["id"])),
            session_id=agent_scope.session_id,
            session_key=agent_scope.scope_key,
            metadata={
                "knowledge_suggestions": [h.to_dict() for h in suggestions],
                "idempotency_key": f"agent-job:{int(task.get('_job_id') or user_msg['id'])}",
                "provider": generation["provider"],
                "actor": self._agent_actor_metadata(actor),
                "execution": execution,
                "workspace": {
                    "path": agent_scope.workspace_path,
                    "scope": "private",
                    "user_id": actor["id"],
                },
                "attachments": self._attachment_metadata_for_agent(attachments),
            },
            attachments=attachments,
            model=generation["model"],
            thinking_depth=generation["thinking_depth"],
            reasoning_config=generation["reasoning_config"],
            progress_callback=lambda event: (
                self._record_agent_progress("private", scope_id, event)
                if self._task_scope_is_current(task)
                else None
            ),
            content_callback=lambda delta: (
                self._record_agent_content_delta("private", scope_id, delta)
                if self._task_scope_is_current(task)
                else None
            ),
        )
        self._ensure_agent_task_can_run(task)
        clean_content, generated_attachments = self._extract_generated_attachments(
            result.content, owner_id=int(scope_id)
        )
        token_usage = self._token_usage_from_agent_result(result, generation)
        with self._conversation_lock:
            self._ensure_agent_task_can_run(task)
            if self._valid_agent_session_id(result.session_id):
                self.agent_scopes.update_session_id(agent_scope.scope_key, result.session_id)
                refreshed_scope = self.agent_scopes.get_scope(agent_scope.scope_key)
                if refreshed_scope is not None:
                    execution = refreshed_scope.to_execution_dict()
            self._record_agent_activity("private", scope_id, "complete", "回复已生成", "保存到私人会话")
            metadata = {
                "session_id": result.session_id,
                "degraded": result.degraded,
                "execution": execution,
                "generation": generation,
                "knowledge_suggestions": [h.to_dict() for h in suggestions],
                "idempotency_key": f"agent-job:{int(task.get('_job_id') or user_msg['id'])}",
                "reply_to": self._reply_target(task),
            }
            if task.get("_job_id"):
                metadata["durable_job_id"] = int(task["_job_id"])
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
                attachment_source="agent_generated",
                attachment_uploader_user_id=int(task["actor"]["id"]),
            )
        self._telegram_delivery_wakeup.set()
        self._record_token_usage_event(
            task,
            token_usage,
            response_message_id=int(message["id"]),
            scope_name=self._actor_display_name(actor),
        )
        return message

    def private_status(self, actor: dict[str, Any]) -> dict[str, Any]:
        require_permission(actor, PERMISSION_PRIVATE_AGENT)
        agent_scope = self.agent_scopes.ensure_private_scope(actor["id"])
        return {
            "execution": agent_scope.to_execution_dict(),
            "session_id": agent_scope.session_id,
            "agent_status": self.agent_status(actor, "private", str(actor["id"])),
            "jobs": self.jobs.counts(
                kind="agent", scope_type="private", scope_id=str(actor["id"])
            ),
        }

    def runtime_status(self, actor: dict[str, Any]) -> dict[str, Any]:
        require_admin(actor)
        return self.runtimes.status(refresh=True)

    def agent_runtime_config(self, actor: dict[str, Any]) -> dict[str, Any]:
        require_admin(actor)
        with self._agent_runtime_config_lock:
            config = self.runtimes.agent_runtime_config()
            config["model_catalog"] = self._oauth_model_catalogs()
            config["oauth"] = self.oauth_provider_status(actor)
            return {
                "config": config,
                "runtime": self.runtimes.agent_runtime_status(refresh=True).to_dict(),
            }

    def update_agent_runtime_config(self, actor: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
        require_admin(actor)
        with self._agent_runtime_config_lock:
            updates: dict[str, str] = {}
            if "managed" in body:
                updates[AGENT_SETTING_MANAGED] = (
                    "1" if parse_bool(body.get("managed")) else "0"
                )
            provider = None
            if "provider" in body:
                provider = normalize_oauth_provider(str(body.get("provider") or ""))
                if provider not in SUPPORTED_OAUTH_PROVIDERS:
                    raise ServiceError(400, "Agent provider must be Codex OAuth or Grok OAuth")
                updates[AGENT_SETTING_PROVIDER] = provider
            active_provider = provider or self._active_oauth_provider()
            if "model" in body:
                updates[AGENT_SETTING_MODEL] = self._resolve_oauth_model_selection(
                    active_provider, str(body.get("model") or "")
                )
            elif provider:
                updates[AGENT_SETTING_MODEL] = self._default_oauth_model(provider)
            if "timeout_seconds" in body:
                try:
                    timeout = float(body.get("timeout_seconds"))
                except (TypeError, ValueError) as exc:
                    raise ServiceError(400, "timeout_seconds must be a number") from exc
                if not 1 <= timeout <= 3600:
                    raise ServiceError(400, "timeout_seconds must be between 1 and 3600")
                updates[AGENT_SETTING_TIMEOUT] = str(timeout)
            if "max_concurrency" in body:
                try:
                    concurrency = int(body.get("max_concurrency"))
                except (TypeError, ValueError) as exc:
                    raise ServiceError(400, "max_concurrency must be an integer") from exc
                if not 1 <= concurrency <= 64:
                    raise ServiceError(400, "max_concurrency must be between 1 and 64")
                updates[AGENT_SETTING_MAX_CONCURRENCY] = str(concurrency)
            if "compaction_threshold" in body:
                try:
                    threshold = float(body.get("compaction_threshold"))
                except (TypeError, ValueError) as exc:
                    raise ServiceError(400, "compaction_threshold must be a number") from exc
                if not 0.5 <= threshold <= 0.95:
                    raise ServiceError(400, "compaction_threshold must be between 0.5 and 0.95")
                updates[AGENT_SETTING_COMPACTION_THRESHOLD] = str(threshold)

            if updates:
                timestamp = now_ts()
                with self.db.transaction() as connection:
                    connection.execute("BEGIN IMMEDIATE")
                    for key, value in updates.items():
                        connection.execute(
                            """
                            INSERT INTO settings(key, value, secret, updated_at)
                            VALUES (?, ?, 0, ?)
                            ON CONFLICT(key) DO UPDATE SET
                                value=excluded.value,
                                secret=0,
                                updated_at=excluded.updated_at
                            """,
                            (key, value, timestamp),
                        )
            if AGENT_SETTING_MAX_CONCURRENCY in updates:
                self._agent_run_gate.resize(
                    int(updates[AGENT_SETTING_MAX_CONCURRENCY])
                )
            if self.runtimes._managed_agent_runtime_enabled():
                self.runtimes.restart_agent_runtime()
            if self._uses_default_agent_client:
                self.agent_client = self._new_agent_runtime_client()
            return self.agent_runtime_config(actor)

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

    def restart_runtime(self, actor: dict[str, Any], name: str) -> dict[str, Any]:
        require_admin(actor)
        clean = name.strip().lower()
        if clean == "agent":
            return {"runtime": self.runtimes.restart_agent_runtime().to_dict()}
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
        if clean == "agent":
            install_status = self.runtimes.install_agent_runtime(force=True)
            return {"runtime": install_status.to_dict(), "config": self.runtimes.agent_runtime_config()}
        if clean == "camofox":
            return {"runtime": self.runtimes.ensure_camofox_ready(wait=True).to_dict()}
        if clean == "firecrawl":
            return {"runtime": self.runtimes.ensure_firecrawl_ready(wait=True).to_dict()}
        raise ServiceError(404, "runtime not found")

    def oauth_provider_status(self, actor: dict[str, Any]) -> dict[str, Any]:
        require_admin(actor)
        active_provider = self._active_oauth_provider()
        runtime_oauth: dict[str, Any] = {}
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
                    # The platform database is the sole OAuth credential store.
                    "last_refresh": self._oauth_display_last_refresh(
                        provider,
                        runtime_status.get("last_refresh"),
                    ),
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

    def resolve_agent_credentials(self, body: dict[str, Any]) -> dict[str, Any]:
        """Resolve a current OAuth access token for the loopback Agent runtime."""

        provider = normalize_oauth_provider(str(body.get("provider") or self._active_oauth_provider()))
        if provider not in SUPPORTED_OAUTH_PROVIDERS:
            raise ServiceError(400, "OAuth provider must be Codex OAuth or Grok OAuth")
        force_refresh = parse_bool(body.get("force_refresh"))
        access_key, refresh_key, expires_key = {
            "openai-codex": (
                "CODEX_OAUTH_ACCESS_TOKEN",
                "CODEX_OAUTH_REFRESH_TOKEN",
                "CODEX_OAUTH_EXPIRES_AT",
            ),
            "xai-oauth": (
                "GROK_OAUTH_ACCESS_TOKEN",
                "GROK_OAUTH_REFRESH_TOKEN",
                "GROK_OAUTH_EXPIRES_AT",
            ),
        }[provider]
        with self._auth_lock:
            access_token = self.get_secret(access_key)
            refresh_token = self.get_secret(refresh_key)
            try:
                expires_at = int(self.get_setting(expires_key) or "0")
            except ValueError:
                expires_at = 0
            should_refresh = bool(refresh_token) and (
                force_refresh or expires_at <= now_ts() + 90
            )
            if should_refresh:
                response = self._refresh_oauth_access_token(provider, refresh_token)
                access_token = str(response.get("access_token") or "").strip()
                if not access_token:
                    raise ServiceError(502, "OAuth refresh response did not contain an access token")
                rotated_refresh = str(response.get("refresh_token") or refresh_token).strip()
                self.set_setting(access_key, access_token, secret=True)
                self.set_setting(refresh_key, rotated_refresh, secret=True)
                try:
                    expires_in = max(60, int(response.get("expires_in") or 3600))
                except (TypeError, ValueError):
                    expires_in = 3600
                expires_at = now_ts() + expires_in
                self.set_setting(expires_key, str(expires_at))
                id_token = str(response.get("id_token") or "").strip()
                if provider == "xai-oauth" and id_token:
                    self.set_setting("GROK_OAUTH_ID_TOKEN", id_token, secret=True)
            if not access_token:
                raise ServiceError(409, f"{oauth_provider_info(provider)['label']} is not connected")
        info = oauth_provider_info(provider)
        return {
            "provider": provider,
            "access_token": access_token,
            "token_type": "Bearer",
            "expires_at": expires_at or None,
            "base_url": info["base_url"],
            "model": self._oauth_model_catalog(provider)["default_model"],
        }

    def _refresh_oauth_access_token(self, provider: str, refresh_token: str) -> dict[str, Any]:
        if provider == "openai-codex":
            response = self.oauth_flows.http.post_form(
                CODEX_TOKEN_URL,
                {
                    "grant_type": "refresh_token",
                    "refresh_token": refresh_token,
                    "client_id": CODEX_OAUTH_CLIENT_ID,
                },
                timeout=30.0,
            )
        else:
            discovery = self.oauth_flows.http.get_json(XAI_OAUTH_DISCOVERY_URL, timeout=20.0)
            if discovery.status != 200:
                raise ServiceError(502, f"Grok OAuth discovery failed with HTTP {discovery.status}")
            token_endpoint = str(discovery.data.get("token_endpoint") or "").strip()
            if not token_endpoint:
                raise ServiceError(502, "Grok OAuth discovery did not return a token endpoint")
            response = self.oauth_flows.http.post_form(
                token_endpoint,
                {
                    "grant_type": "refresh_token",
                    "refresh_token": refresh_token,
                    "client_id": XAI_OAUTH_CLIENT_ID,
                },
                timeout=30.0,
            )
        if response.status != 200:
            raise ServiceError(502, f"OAuth token refresh failed with HTTP {response.status}: {response.text}")
        return dict(response.data)

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
        active_provider = normalize_oauth_provider(str(active_raw)) if active_raw else ""
        if active_provider in SUPPORTED_OAUTH_PROVIDERS and self._oauth_tokens_configured(active_provider):
            self._select_oauth_provider(active_provider)
        else:
            self.runtimes.prepare_agent_runtime()

        return {
            "imported": {
                "providers": imported_providers,
                "keys": imported_keys,
            },
            **self.oauth_provider_status(actor),
        }

    def start_oauth_verification(self, actor: dict[str, Any], provider: str) -> dict[str, Any]:
        require_admin(actor)
        provider = normalize_oauth_provider(provider)
        if provider not in SUPPORTED_OAUTH_PROVIDERS:
            raise ServiceError(400, "OAuth provider must be Codex OAuth or Grok OAuth")
        # Do not switch the live provider here: authentication has not yet
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
        provider = normalize_oauth_provider(provider)
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
        provider = normalize_oauth_provider(provider)
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
        try:
            doc, created = self.knowledge.add_document_with_status(
                title=str(body.get("title", "")),
                summary=str(body.get("summary", "")),
                content=str(body.get("content", "")),
                source=str(body.get("source", "")),
                created_by=actor["id"],
            )
        except ValueError as exc:
            message = str(exc)
            raise ServiceError(413 if message.startswith("content exceeds ") else 400, message) from exc
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
        document_id = int(doc.get("id") or 0)
        job, _ = self.jobs.enqueue(
            kind="cognee",
            dedupe_key=f"document:{document_id}",
            scope_type="knowledge",
            scope_id=str(document_id),
            payload={
                "document_id": document_id,
                "title": doc["title"],
                "content": doc["content"],
                "source": doc.get("source", ""),
            },
        )
        if job.status != "queued":
            return {
                "attempted": True,
                "available": True,
                "queued": False,
                "document_id": document_id,
                "job_id": job.id,
                "job_status": job.status,
            }
        payload = dict(job.payload)
        payload["_job_id"] = job.id
        with self._ingest_lock:
            if self._closed:
                return {"attempted": False, "available": False, "error": "service shutting down"}
            if not any(int(item.get("_job_id") or 0) == job.id for item in self._ingest_queue):
                self._ingest_queue.append(payload)
            self._ingest_wakeup.set()
            self._start_ingest_worker_locked()
        return {
            "attempted": True,
            "available": True,
            "queued": True,
            "document_id": document_id,
            "job_id": job.id,
        }

    def _start_ingest_worker_locked(self) -> None:
        if self._ingest_thread is None or not self._ingest_thread.is_alive():
            self._ingest_thread = threading.Thread(
                target=self._ingest_worker, name="cognee-ingest", daemon=True
            )
            self._ingest_thread.start()

    def _ingest_worker(self) -> None:
        while True:
            with self._ingest_lock:
                if self._closed or not self._ingest_queue:
                    self._ingest_thread = None
                    return
                job = self._ingest_queue.popleft()
            job_id = int(job.get("_job_id") or 0)
            stored = self.jobs.get(job_id) if job_id else None
            if stored is None or stored.status != "queued":
                continue
            delay = max(0, int(stored.available_at) - now_ts())
            if delay:
                with self._ingest_lock:
                    # Put delayed retries behind newly accepted ready work so a
                    # single backoff does not head-of-line block all ingestion.
                    self._ingest_queue.append(job)
                self._ingest_wakeup.clear()
                self._ingest_wakeup.wait(min(delay, 1))
                continue
            claimed = self.jobs.mark_running(job_id, lease_seconds=COGNEE_JOB_LEASE_SECONDS)
            if claimed is None:
                continue
            try:
                result = self.cognee.ingest_document(
                    title=job["title"], content=job["content"], source=job["source"]
                )
            except Exception as exc:  # never let a bad ingest kill the worker
                result = {"attempted": True, "available": True, "error": str(exc)}
            error = result.get("error")
            if error and claimed.attempts < MAX_INGEST_ATTEMPTS:
                backoff = min(2 ** claimed.attempts, INGEST_RETRY_BACKOFF_CAP_SECONDS)
                print(
                    f"Cognee ingest attempt {claimed.attempts} failed for document {job.get('document_id')}: "
                    f"{error}; retrying in {backoff}s",
                    file=sys.stderr,
                )
                self.jobs.requeue(job_id, delay_seconds=backoff, error=str(error))
                with self._ingest_lock:
                    if not self._closed:
                        self._ingest_queue.append(job)
                continue
            if error:
                self.jobs.mark_failed(job_id, str(error))
                print(f"Cognee ingest failed for document {job.get('document_id')}: {error}", file=sys.stderr)
                with self._ingest_lock:
                    self._ingest_failed_count += 1
                    self._ingest_last_error = str(error)
            else:
                self.jobs.mark_succeeded(job_id)
            doc_id = job.get("document_id")
            if doc_id is not None:
                with self._ingest_lock:
                    self._ingest_results[int(doc_id)] = result
                    while len(self._ingest_results) > MAX_TRACKED_INGEST_RESULTS:
                        self._ingest_results.pop(next(iter(self._ingest_results)), None)
                    self._ingest_condition.notify_all()

    def cognee_ingest_result(self, document_id: int) -> dict[str, Any] | None:
        document_id = int(document_id)
        deadline = time.monotonic() + 0.25
        with self._ingest_condition:
            while document_id not in self._ingest_results and time.monotonic() < deadline:
                if self._ingest_thread is None or not self._ingest_thread.is_alive():
                    break
                self._ingest_condition.wait(timeout=max(0, deadline - time.monotonic()))
            result = self._ingest_results.get(document_id)
            return dict(result) if result else None

    def search_knowledge(self, query: str, limit: int = 5) -> list[dict[str, Any]]:
        local = [hit.to_dict() for hit in self.knowledge.search(query, limit)]
        if len(local) >= limit and self.config.knowledge_backend != "cognee":
            return local[:limit]
        if self.config.knowledge_backend == "cognee":
            # Pure Cognee mode requests the full caller budget. Local hits are
            # only a fallback and must not shrink a result set that replaces
            # them when the graph backend succeeds.
            cognee_hits = self.cognee.search(query, limit=limit)
            return _dedupe_knowledge_hits(cognee_hits or local)[:limit]
        cognee_hits = self.cognee.search(query, limit=max(0, limit - len(local)))
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

    def agent_memory_search(self, body: dict[str, Any]) -> dict[str, Any]:
        scope_key = self._validated_agent_memory_scope(body.get("scope_key"))
        target = str(body.get("target") or "memory").strip().lower()
        if target not in {"memory", "user"}:
            raise ServiceError(400, "memory target must be memory or user")
        owner_user_id = self._memory_owner_user_id(target, body.get("owner_user_id"))
        limit = max(1, min(int(body.get("limit") or 8), 20))
        query = str(body.get("query") or "").strip()
        params: list[Any] = [scope_key, target]
        owner_clause = "owner_user_id IS NULL"
        if target == "user":
            owner_clause = "owner_user_id = ?"
            params.append(owner_user_id)
        rows: list[dict[str, Any]]
        terms = [part for part in re.findall(r"[\w\-]{2,}", query, flags=re.UNICODE) if part]
        if terms and getattr(self.db, "fts_available", False):
            match = " OR ".join(f'"{term.replace(chr(34), chr(34) * 2)}"' for term in terms[:16])
            try:
                rows = self.db.query(
                    f"""
                    SELECT m.*, bm25(agent_memory_fts) AS rank
                    FROM agent_memory_fts
                    JOIN agent_memories m ON m.id = agent_memory_fts.rowid
                    WHERE agent_memory_fts MATCH ? AND m.scope_key = ?
                      AND m.target = ? AND {owner_clause}
                    ORDER BY rank, m.updated_at DESC LIMIT ?
                    """,
                    [match, *params, limit],
                )
            except Exception:
                rows = []
        else:
            rows = []
        if not rows:
            like_clause = ""
            fallback_params: list[Any] = list(params)
            if query:
                like_clause = " AND (content LIKE ? OR tags_json LIKE ?)"
                fallback_params.extend([f"%{query}%", f"%{query}%"])
            rows = self.db.query(
                f"""
                SELECT * FROM agent_memories
                WHERE scope_key = ? AND target = ? AND {owner_clause}{like_clause}
                ORDER BY updated_at DESC LIMIT ?
                """,
                [*fallback_params, limit],
            )
        return {"memories": [self._public_agent_memory(row) for row in rows]}

    def agent_memory_mutate(self, body: dict[str, Any]) -> dict[str, Any]:
        scope_key = self._validated_agent_memory_scope(body.get("scope_key"))
        operations = body.get("operations")
        if not isinstance(operations, list):
            operations = [body]
        if not operations or len(operations) > 50:
            raise ServiceError(400, "memory operations must contain between 1 and 50 items")
        changed: list[dict[str, Any]] = []
        with self.db.transaction() as conn:
            for raw in operations:
                if not isinstance(raw, dict):
                    raise ServiceError(400, "memory operation must be an object")
                action = str(raw.get("action") or "add").strip().lower()
                target = str(raw.get("target") or body.get("target") or "memory").strip().lower()
                if target not in {"memory", "user"}:
                    raise ServiceError(400, "memory target must be memory or user")
                owner_user_id = self._memory_owner_user_id(
                    target, raw.get("owner_user_id", body.get("owner_user_id"))
                )
                if action == "add":
                    content = str(raw.get("content") or "").strip()
                    if not content or len(content) > 20_000:
                        raise ServiceError(400, "memory content must contain 1 to 20000 characters")
                    tags = raw.get("tags") if isinstance(raw.get("tags"), list) else []
                    tags_json = encode_json([str(tag)[:80] for tag in tags[:20]])
                    timestamp = now_ts()
                    cursor = conn.execute(
                        """
                        INSERT INTO agent_memories(
                            scope_key, target, owner_user_id, content, tags_json, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                        (scope_key, target, owner_user_id, content, tags_json, timestamp, timestamp),
                    )
                    changed.append({"action": "add", "id": int(cursor.lastrowid)})
                    continue
                if action == "clear":
                    if target == "user":
                        cursor = conn.execute(
                            "DELETE FROM agent_memories WHERE scope_key = ? AND target = ? AND owner_user_id = ?",
                            (scope_key, target, owner_user_id),
                        )
                    else:
                        cursor = conn.execute(
                            "DELETE FROM agent_memories WHERE scope_key = ? AND target = ?",
                            (scope_key, target),
                        )
                    changed.append({"action": "clear", "deleted": max(0, int(cursor.rowcount))})
                    continue
                try:
                    memory_id = int(raw.get("id"))
                except (TypeError, ValueError) as exc:
                    raise ServiceError(400, "memory id is required") from exc
                row = conn.execute(
                    "SELECT * FROM agent_memories WHERE id = ? AND scope_key = ? AND target = ?",
                    (memory_id, scope_key, target),
                ).fetchone()
                if row is None or (target == "user" and int(row["owner_user_id"] or 0) != owner_user_id):
                    raise ServiceError(404, "memory not found")
                if action == "remove":
                    conn.execute("DELETE FROM agent_memories WHERE id = ?", (memory_id,))
                    changed.append({"action": "remove", "id": memory_id})
                elif action == "replace":
                    content = str(raw.get("content") or "").strip()
                    if not content or len(content) > 20_000:
                        raise ServiceError(400, "memory content must contain 1 to 20000 characters")
                    decoded_tags = decode_json(str(row["tags_json"] or "[]"))
                    tags = raw.get("tags") if isinstance(raw.get("tags"), list) else (
                        decoded_tags if isinstance(decoded_tags, list) else []
                    )
                    conn.execute(
                        "UPDATE agent_memories SET content = ?, tags_json = ?, updated_at = ? WHERE id = ?",
                        (content, encode_json([str(tag)[:80] for tag in list(tags)[:20]]), now_ts(), memory_id),
                    )
                    changed.append({"action": "replace", "id": memory_id})
                else:
                    raise ServiceError(400, "memory action must be add, replace, remove or clear")
        return {"changed": changed, **self.agent_memory_search({
            "scope_key": scope_key,
            "target": body.get("target") or "memory",
            "owner_user_id": body.get("owner_user_id"),
            "limit": 20,
        })}

    def agent_session_search(self, body: dict[str, Any]) -> dict[str, Any]:
        scope_key = self._validated_agent_memory_scope(body.get("scope_key"))
        scope = self.agent_scopes.get_scope(scope_key)
        if scope is None:
            raise ServiceError(404, "Agent scope not found")
        requested_session = str(body.get("session_id") or "").strip()
        if requested_session and requested_session != scope.session_id:
            raise ServiceError(404, "Agent session not found in the current lifecycle")
        limit = max(1, min(int(body.get("limit") or 50), 200))
        query = str(body.get("query") or "").strip()
        params: list[Any] = [scope.scope_type, scope.scope_id]
        where = "scope_type = ? AND scope_id = ?"
        if query:
            where += " AND content LIKE ?"
            params.append(f"%{query}%")
        rows = self.db.query(
            f"SELECT * FROM messages WHERE {where} ORDER BY id DESC LIMIT ?",
            [*params, limit],
        )
        return {
            "session_id": scope.session_id,
            "lifecycle_id": scope.lifecycle_id,
            "messages": [self._message_from_row(row) for row in reversed(rows)],
        }

    def invoke_agent_runtime_tool(self, body: dict[str, Any]) -> dict[str, Any]:
        tool = str(body.get("tool") or "").strip().lower()
        action = str(body.get("action") or "").strip().lower()
        arguments = body.get("arguments") if isinstance(body.get("arguments"), dict) else {}
        context = body.get("context") if isinstance(body.get("context"), dict) else {}
        scope_key = str(context.get("scope_key") or "").strip()
        # Runtime context is authoritative. Tool arguments are model-controlled
        # and must never be able to redirect a call into another Agent scope.
        common = {**arguments, "scope_key": scope_key}
        if tool == "memory":
            if action in {"search", "read", "list"}:
                result = self.agent_memory_search(common)
            else:
                result = self.agent_memory_mutate({**common, "action": action})
        elif tool == "session":
            result = self.agent_session_search({
                **common,
                "session_id": context.get("session_id"),
            })
        elif tool == "knowledge":
            if action in {"search", "query"}:
                query = str(arguments.get("query") or arguments.get("q") or "").strip()
                result = {"results": self.search_knowledge(query, int(arguments.get("limit") or 5))}
            elif action in {"read", "get"}:
                result = {"document": self.get_knowledge_document(int(arguments.get("document_id") or arguments.get("id")))}
            else:
                raise ServiceError(400, "knowledge action must be search or read")
        elif tool == "web":
            result = self._agent_web_tool(action, arguments)
        elif tool == "browser":
            result = self._agent_browser_tool(scope_key, action, arguments)
        else:
            raise ServiceError(404, "Agent tool not found")
        return {
            "content": json.dumps(result, ensure_ascii=False, indent=2),
            "data": result,
            "is_error": False,
        }

    def _agent_web_tool(self, action: str, arguments: dict[str, Any]) -> dict[str, Any]:
        base_url = self.config.firecrawl_api_url.rstrip("/")
        headers: dict[str, str] = {}
        api_key = self.get_secret("FIRECRAWL_API_KEY")
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        if action in {"search", "query"}:
            query = str(arguments.get("query") or "").strip()
            if not query:
                raise ServiceError(400, "web search query is required")
            limit = max(1, min(int(arguments.get("limit") or 5), 100))
            payload = self._runtime_json_request(
                base_url + "/v1/search",
                {"query": query, "limit": limit, "scrapeOptions": {"formats": []}},
                headers=headers,
                timeout=60,
            )
            raw_results = payload.get("data") or payload.get("web") or []
            if isinstance(raw_results, dict):
                raw_results = raw_results.get("web") or []
            results = []
            for index, item in enumerate(raw_results if isinstance(raw_results, list) else []):
                if not isinstance(item, dict):
                    continue
                url = str(item.get("url") or "")
                if url:
                    self._validate_external_url(url)
                results.append({
                    "title": str(item.get("title") or ""),
                    "url": url,
                    "description": str(item.get("description") or item.get("markdown") or "")[:2000],
                    "position": index + 1,
                })
            return {"web": results}
        if action in {"extract", "scrape", "read"}:
            raw_urls = arguments.get("urls")
            if not isinstance(raw_urls, list):
                raw_urls = [arguments.get("url")]
            urls = [str(value or "").strip() for value in raw_urls if str(value or "").strip()]
            if not urls or len(urls) > 5:
                raise ServiceError(400, "web extract accepts between 1 and 5 URLs")
            char_limit = max(1000, min(int(arguments.get("char_limit") or 100_000), 500_000))
            results = []
            for url in urls:
                self._validate_external_url(url)
                payload = self._runtime_json_request(
                    base_url + "/v1/scrape",
                    {"url": url, "formats": ["markdown", "html"]},
                    headers=headers,
                    timeout=60,
                )
                data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
                metadata = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
                final_url = str(metadata.get("sourceURL") or metadata.get("url") or url)
                self._validate_external_url(final_url)
                content = str(data.get("markdown") or data.get("html") or "")
                if len(content) > char_limit:
                    half = max(1, char_limit // 2)
                    content = content[:half] + "\n…[truncated]…\n" + content[-half:]
                results.append({
                    "url": final_url,
                    "title": str(metadata.get("title") or ""),
                    "content": content,
                    "metadata": metadata,
                })
            return {"results": results}
        raise ServiceError(400, "web action must be search or extract")

    def _agent_browser_tool(
        self,
        scope_key: str,
        action: str,
        arguments: dict[str, Any],
    ) -> dict[str, Any]:
        self._validated_agent_memory_scope(scope_key)
        base_url = self.config.camofox_url.rstrip("/")
        user_id = "agent-" + hashlib.sha256(scope_key.encode("utf-8")).hexdigest()[:24]
        access_key = self.runtimes._camofox_access_key()
        headers = {"Authorization": f"Bearer {access_key}"}
        tab_id = str(arguments.get("tab_id") or arguments.get("tabId") or "").strip()
        if action in {"cleanup", "close_session"}:
            return self._runtime_json_request(
                f"{base_url}/sessions/{urllib.parse.quote(user_id, safe='')}",
                None,
                headers=headers,
                timeout=30,
                method="DELETE",
            )
        if action in {"navigate", "open"} and not tab_id:
            url = str(arguments.get("url") or "").strip()
            self._validate_external_url(url)
            return self._runtime_json_request(
                base_url + "/tabs",
                {"userId": user_id, "sessionKey": "agent", "url": url},
                headers=headers,
                timeout=60,
            )
        if action in {"list", "tabs", "status"}:
            return self._runtime_json_request(
                base_url + "/tabs?" + urllib.parse.urlencode({"userId": user_id}),
                None,
                headers=headers,
                timeout=30,
                method="GET",
            )
        if not tab_id:
            raise ServiceError(400, "browser tab_id is required")
        encoded_tab_id = urllib.parse.quote(tab_id, safe="")
        if action in {"snapshot", "screenshot"}:
            query = {"userId": user_id}
            if action == "screenshot":
                # Camofox can include a bounded base64 screenshot in its JSON
                # snapshot response, which keeps the private gateway JSON-only.
                query["includeScreenshot"] = "true"
            return self._runtime_json_request(
                f"{base_url}/tabs/{encoded_tab_id}/snapshot?{urllib.parse.urlencode(query)}",
                None,
                headers=headers,
                timeout=60,
                method="GET",
            )
        if action == "console":
            return self._runtime_json_request(
                f"{base_url}/tabs/{encoded_tab_id}/console?"
                + urllib.parse.urlencode({"userId": user_id}),
                None,
                headers=headers,
                timeout=30,
                method="GET",
            )
        if action in {"close", "close_tab"}:
            return self._runtime_json_request(
                f"{base_url}/tabs/{encoded_tab_id}",
                {"userId": user_id},
                headers=headers,
                timeout=30,
                method="DELETE",
            )
        route_actions = {
            "navigate": "navigate",
            "click": "click",
            "type": "type",
            "scroll": "scroll",
            "back": "back",
            "press": "press",
            "evaluate": "evaluate",
        }
        route = route_actions.get(action)
        if route is None:
            raise ServiceError(400, "unsupported browser action")
        payload = dict(arguments)
        payload.pop("tab_id", None)
        payload.pop("tabId", None)
        # The runtime-derived browser identity is authoritative. Camofox uses
        # userId when resolving every tab ID, so this also prevents one Agent
        # from operating another Agent's guessed tab ID.
        payload["userId"] = user_id
        if route == "navigate" and payload.get("url"):
            self._validate_external_url(str(payload["url"]))
        return self._runtime_json_request(
            f"{base_url}/tabs/{encoded_tab_id}/{route}",
            payload,
            headers=headers,
            timeout=60,
        )

    @staticmethod
    def _runtime_json_request(
        url: str,
        body: dict[str, Any] | None,
        *,
        headers: dict[str, str],
        timeout: float,
        method: str = "POST",
    ) -> dict[str, Any]:
        request_headers = {"Accept": "application/json", **headers}
        data = None
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=data, headers=request_headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read(10 * 1024 * 1024).decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            detail = exc.read(65536).decode("utf-8", errors="replace")
            raise ServiceError(502, f"managed tool returned HTTP {exc.code}: {detail[:1000]}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise ServiceError(502, f"managed tool request failed: {exc}") from exc
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError as exc:
            raise ServiceError(502, "managed tool returned invalid JSON") from exc
        return payload if isinstance(payload, dict) else {"data": payload}

    @staticmethod
    def _validate_external_url(value: str) -> None:
        try:
            parsed = urllib.parse.urlparse(str(value or "").strip())
            if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
                raise ValueError
            if any(key.lower() in {"token", "api_key", "apikey", "password", "secret"} for key, _ in urllib.parse.parse_qsl(parsed.query)):
                raise ServiceError(400, "URL contains a sensitive query parameter")
            addresses = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80))
        except ServiceError:
            raise
        except (ValueError, OSError) as exc:
            raise ServiceError(400, "URL must be a resolvable public http(s) URL") from exc
        for address in addresses:
            ip = ipaddress.ip_address(address[4][0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
                raise ServiceError(403, "private, local and metadata network targets are blocked")

    def _validated_agent_memory_scope(self, value: Any) -> str:
        scope_key = str(value or "").strip()
        if not scope_key or len(scope_key) > 512:
            raise ServiceError(400, "valid Agent scope_key is required")
        parent_key = scope_key.split(":child:", 1)[0].split("/delegate/", 1)[0]
        if self.agent_scopes.get_scope(parent_key) is None:
            raise ServiceError(404, "Agent scope not found")
        return scope_key

    @staticmethod
    def _memory_owner_user_id(target: str, value: Any) -> int | None:
        if target != "user":
            return None
        try:
            owner_user_id = int(value)
        except (TypeError, ValueError) as exc:
            raise ServiceError(400, "owner_user_id is required for user memory") from exc
        if owner_user_id <= 0:
            raise ServiceError(400, "owner_user_id is invalid")
        return owner_user_id

    @staticmethod
    def _public_agent_memory(row: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": int(row["id"]),
            "scope_key": str(row["scope_key"]),
            "target": str(row["target"]),
            "owner_user_id": row.get("owner_user_id"),
            "content": str(row["content"]),
            "tags": (
                decoded if isinstance((decoded := decode_json(str(row.get("tags_json") or "[]"))), list) else []
            ),
            "created_at": int(row["created_at"]),
            "updated_at": int(row["updated_at"]),
        }

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
        durable = self.jobs.counts(kind="cognee")
        with self._ingest_lock:
            ingest_pending = durable["queued"] + durable["running"]
            ingest_failed = max(self._ingest_failed_count, durable["failed"] + durable["needs_review"])
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
            "ingest_jobs": durable,
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
        runtime_model = normalize_model_name(
            str(self.runtimes.agent_runtime_config().get("model") or self.config.agent_runtime_model)
        )
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
        known_keys = set(OAUTH_SECRET_KEYS) | {"agent_tool_token"}
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
            # Managed runs carry the current tool token in every request. The
            # sidecar keeps the internal target URL fixed but accepts this
            # request-level credential, so rotation takes effect for new runs
            # without exposing the token or requiring a runtime restart.
            if self._uses_default_agent_client:
                self.agent_client = self._new_agent_runtime_client()
            return
        clean = raw_key.upper()
        if not re.fullmatch(r"[A-Z0-9_]{2,80}", clean):
            raise ServiceError(400, "invalid secret key")
        allowed_keys = set(OAUTH_SECRET_KEYS)
        if clean not in allowed_keys:
            raise ServiceError(400, "unsupported secret key")
        if not value:
            raise ServiceError(400, "secret value is required")
        self.set_setting(clean, value, secret=True)

    def _active_oauth_provider(self) -> str:
        active_provider = normalize_oauth_provider(
            self.get_setting(AGENT_SETTING_PROVIDER)
            or self.config.agent_runtime_provider
        )
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
            provider = normalize_oauth_provider(str(raw_provider))
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
        self.set_setting(AGENT_SETTING_PROVIDER, provider)
        self.set_setting(AGENT_SETTING_MODEL, self._default_oauth_model(provider))

    def _oauth_model_catalogs(self) -> dict[str, dict[str, Any]]:
        return {provider: self._oauth_model_catalog(provider) for provider in SUPPORTED_OAUTH_PROVIDERS}

    def _oauth_model_catalog(self, provider: str) -> dict[str, Any]:
        provider = normalize_oauth_provider(provider)
        catalogs = {
            "openai-codex": {
                "models": ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"],
                "default_model": "gpt-5.5",
            },
            "xai-oauth": {
                "models": [
                    "grok-4.3",
                    "grok-4.20-0309-reasoning",
                    "grok-4.20-0309-non-reasoning",
                ],
                "default_model": "grok-4.3",
            },
        }
        catalog = catalogs.get(provider, {"models": [], "default_model": ""})
        return {
            "provider": provider,
            "models": list(catalog["models"]),
            "default_model": str(catalog["default_model"]),
            "source": "agent-runtime",
            "error": "" if provider in catalogs else "unsupported provider",
        }

    def _default_oauth_model(self, provider: str) -> str:
        catalog = self._oauth_model_catalog(provider)
        default_model = catalog["default_model"]
        if default_model:
            return default_model
        label = oauth_provider_info(provider)["label"]
        detail = f": {catalog['error']}" if catalog.get("error") else ""
        raise ServiceError(503, f"Agent model catalog for {label} is unavailable{detail}")

    def _resolve_oauth_model_selection(self, provider: str, model: str) -> str:
        catalog = self._oauth_model_catalog(provider)
        models = catalog["models"]
        if not models:
            label = oauth_provider_info(provider)["label"]
            detail = f": {catalog['error']}" if catalog.get("error") else ""
            raise ServiceError(503, f"Agent model catalog for {label} is unavailable{detail}")
        clean = str(model or "").strip()
        if clean in {"", "agent"}:
            clean = catalog["default_model"] or models[0]
        if clean not in models:
            label = oauth_provider_info(provider)["label"]
            raise ServiceError(400, f"Agent model must be selected from the catalog for {label}")
        return clean

    def _validate_account_model_name(self, model: str) -> str:
        clean = normalize_model_name(model)
        if clean in {"", "agent"}:
            return ""
        provider = self._active_oauth_provider()
        catalog = self._oauth_model_catalog(provider)
        models = catalog["models"]
        label = oauth_provider_info(provider)["label"]
        if not models:
            detail = f": {catalog['error']}" if catalog.get("error") else ""
            raise ServiceError(503, f"Agent model catalog for {label} is unavailable{detail}")
        if clean not in models:
            raise ServiceError(400, f"Account model must be selected from the Agent catalog for {label}")
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
        if provider == "openai-codex":
            self.set_setting("CODEX_OAUTH_ACCESS_TOKEN", str(tokens.get("access_token", "")), secret=True)
            self.set_setting("CODEX_OAUTH_REFRESH_TOKEN", str(tokens.get("refresh_token", "")), secret=True)
            expires_key = "CODEX_OAUTH_EXPIRES_AT"
        elif provider == "xai-oauth":
            self.set_setting("GROK_OAUTH_ACCESS_TOKEN", str(tokens.get("access_token", "")), secret=True)
            self.set_setting("GROK_OAUTH_REFRESH_TOKEN", str(tokens.get("refresh_token", "")), secret=True)
            expires_key = "GROK_OAUTH_EXPIRES_AT"
            id_token = str(tokens.get("id_token", "") or "").strip()
            if id_token:
                self.set_setting("GROK_OAUTH_ID_TOKEN", id_token, secret=True)
        else:
            return
        try:
            expires_in = max(60, int(tokens.get("expires_in") or 3600))
        except (TypeError, ValueError):
            expires_in = 3600
        self.set_setting(expires_key, str(now_ts() + expires_in))
        self._select_oauth_provider(provider)

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

    def _oauth_display_last_refresh(self, provider: str, runtime_value: Any) -> Any:
        db_value = self._oauth_last_refresh(provider)
        if not runtime_value:
            return db_value
        if not db_value:
            return runtime_value
        runtime_epoch = self._oauth_timestamp_epoch(runtime_value)
        if runtime_epoch is None:
            return runtime_value
        return db_value if db_value >= runtime_epoch else runtime_value

    @staticmethod
    def _oauth_timestamp_epoch(value: Any) -> int | None:
        if isinstance(value, (int, float)):
            return int(value)
        text = str(value or "").strip()
        if not text:
            return None
        if re.fullmatch(r"\d+(?:\.\d+)?", text):
            return int(float(text))
        if text.endswith("Z"):
            text = f"{text[:-1]}+00:00"
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return int(parsed.timestamp())

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
            result = self._copy_status(status)
        result["jobs"] = self.jobs.counts(
            kind="agent", scope_type=scope_type, scope_id=scope_id
        )
        return result

    def respond_agent_approval(
        self,
        actor: dict[str, Any],
        scope_type: str,
        scope_id: str,
        choice: str,
        resolve_all: bool = False,
    ) -> dict[str, Any]:
        scope_type, scope_id = self._normalize_conversation(actor, scope_type, scope_id)
        if scope_type == "channel":
            require_permission(actor, PERMISSION_CHAT)
        aliases = {"approve": "once", "approved": "once", "allow": "once"}
        normalized_choice = aliases.get(str(choice or "").strip().lower(), str(choice or "").strip().lower())
        if normalized_choice not in {"once", "session", "always", "deny"}:
            raise ServiceError(400, "invalid approval choice")
        key = self._conversation_key(scope_type, scope_id)
        with self._conversation_lock:
            status = self._agent_status.get(key) or self._idle_agent_status(scope_type, scope_id)
            approval = dict(status.get("approval") or {})
        run_id = str(approval.get("run_id") or "").strip()
        if not run_id:
            raise ServiceError(409, "no pending approval for this conversation")
        approval_id = str(approval.get("approval_id") or "").strip()
        responder = self._actor_display_name(actor)
        respond = getattr(self.agent_client, "respond_approval", None)
        if not callable(respond):
            raise ServiceError(503, "agent approval response is not supported")
        try:
            approval_result = respond(
                run_id=run_id,
                choice=normalized_choice,
                resolve_all=bool(resolve_all),
                approval_id=approval_id or None,
            )
        except ValueError as exc:
            raise ServiceError(400, str(exc)) from exc
        except Exception as exc:
            raise ServiceError(502, str(exc)) from exc
        updated = self._mark_agent_approval_responded(
            scope_type,
            scope_id,
            normalized_choice,
            responder=responder,
            approval_result=approval_result if isinstance(approval_result, dict) else {},
        )
        return {"ok": True, "approval": approval_result, "agent_status": updated}

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
        task = dict(task)
        with self._conversation_lock:
            if self._closed:
                raise ServiceError(503, "service is shutting down")
            scope_epoch = int(self._agent_scope_epochs.get(key, 0))
        # Epochs are process-local cancellation generations. Do not persist one
        # in the durable payload: after a clean restart current queued work must
        # rebase onto the new process's epoch zero.
        task.pop("_scope_epoch", None)
        try:
            user_message_id = int((task.get("user_message") or {})["id"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ServiceError(500, "Agent task is missing its persisted user message") from exc
        job, _ = self.jobs.enqueue(
            kind="agent",
            dedupe_key=f"message:{user_message_id}",
            payload=task,
            scope_type=scope_type,
            scope_id=scope_id,
        )
        if job.status != "queued":
            key = self._conversation_key(scope_type, scope_id)
            with self._conversation_lock:
                return self._copy_status(
                    self._agent_status.get(key) or self._idle_agent_status(scope_type, scope_id)
                )
        task = dict(job.payload)
        task["_scope_epoch"] = scope_epoch
        task["_job_id"] = job.id
        try:
            return self._schedule_agent_task(task, enforce_limit=True)
        except Exception as exc:
            self.jobs.mark_failed(job.id, str(exc))
            raise

    def _schedule_agent_task(self, task: dict[str, Any], *, enforce_limit: bool) -> dict[str, Any]:
        scope_type = str(task["scope_type"])
        scope_id = str(task["scope_id"])
        key = self._conversation_key(scope_type, scope_id)
        with self._conversation_lock:
            if self._closed:
                raise ServiceError(503, "service is shutting down")
            queue = self._agent_queues.setdefault(key, deque())
            job_id = int(task.get("_job_id") or 0)
            if job_id and any(int(item.get("_job_id") or 0) == job_id for item in queue):
                status = self._agent_status.get(key) or self._idle_agent_status(scope_type, scope_id)
                return self._copy_status(status)
            if enforce_limit and len(queue) >= MAX_AGENT_QUEUE_DEPTH:
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
                    job_id = int(task.get("_job_id") or 0)
                    if job_id and self.jobs.mark_running(job_id, lease_seconds=AGENT_JOB_LEASE_SECONDS) is None:
                        # Another worker (or a terminal transition) already owns
                        # this ledger entry. Never execute a side-effectful Agent
                        # run unless this worker atomically claimed it.
                        continue
                    self._agent_active_tasks[key] = task
                    self._agent_status[key] = self._status_for_task(task, "replying", queued_count=len(queue))

                error = ""
                error_persisted = True
                try:
                    # Only N replies hit the Agent runtime (and hold a thread /
                    # socket) at once; each conversation still drains its own
                    # queue in FIFO order while queued runs wait on the semaphore.
                    with self._agent_run_gate:
                        self._ensure_agent_task_can_run(task)
                        if task["scope_type"] == "channel":
                            self._send_channel_agent_reply(task)
                        else:
                            self._send_private_agent_reply(task)
                    # The reply insertion itself is lifecycle-serialized by
                    # ``_send_*_agent_reply``.  A reset that wins after that
                    # insertion moves the ledger to ``failed`` and removes the
                    # message; this CAS then becomes a harmless no-op.  A
                    # shutdown that begins after a committed reply must not
                    # quarantine already-successful work merely because the
                    # in-memory epoch changed between commit and this update.
                    if job_id:
                        self.jobs.mark_succeeded(job_id)
                except _AgentTaskCancelled as exc:
                    error = str(exc)
                    if job_id:
                        self.jobs.mark_failed(job_id, error, needs_review=exc.needs_review)
                except Exception as exc:
                    error = str(exc)
                    runtime_needs_review = (
                        isinstance(exc, AgentRuntimeRunError)
                        and exc.state == "needs_review"
                    )
                    with self._conversation_lock:
                        shutting_down = self._closed
                    if shutting_down:
                        if job_id:
                            self.jobs.mark_failed(job_id, error, needs_review=True)
                        error_persisted = True
                    else:
                        try:
                            self._append_agent_error(task, error, require_current=True)
                        except _AgentTaskCancelled:
                            # A reset/deactivation owns the terminal state; do
                            # not recreate an error message after it completed.
                            error_persisted = True
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
                        if job_id:
                            self.jobs.mark_failed(
                                job_id,
                                error,
                                needs_review=runtime_needs_review,
                            )

                with self._conversation_lock:
                    self._agent_active_tasks.pop(key, None)
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
                self._agent_active_tasks.pop(key, None)
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

    def _append_agent_error(
        self,
        task: dict[str, Any],
        error: str,
        *,
        require_current: bool = False,
    ) -> None:
        username = "Main Agent" if task["scope_type"] == "channel" else "Private Agent"
        metadata = {"error": error, "reply_to": self._reply_target(task)}
        if task.get("_job_id"):
            metadata["durable_job_id"] = int(task["_job_id"])
        metadata["agent_work"] = self._agent_work_snapshot(task, state="error")
        kwargs = {
            "scope_type": str(task["scope_type"]),
            "scope_id": str(task["scope_id"]),
            "author_type": "agent",
            "user_id": None,
            "username": username,
            "content": f"Agent 回复失败: {error}",
            "metadata": metadata,
        }
        if require_current:
            with self._conversation_lock:
                self._ensure_agent_task_can_run(task)
                self._record_agent_activity(
                    str(task["scope_type"]),
                    str(task["scope_id"]),
                    "error",
                    "Agent 回复失败",
                    error[:180],
                )
                self._append_message(**kwargs)
        else:
            self._record_agent_activity(
                str(task["scope_type"]),
                str(task["scope_id"]),
                "error",
                "Agent 回复失败",
                error[:180],
            )
            self._append_message(**kwargs)
        if str(task["scope_type"]) == "private":
            self._telegram_delivery_wakeup.set()

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
        label = "等待 Agent 处理" if state == "queued" else "等待 Agent 运行过程"
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
            "approval": None,
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
            "approval": None,
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
        if copied.get("approval"):
            copied["approval"] = dict(copied["approval"])
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
        coalesce: bool = False,
    ) -> None:
        key = self._conversation_key(scope_type, str(scope_id))
        timestamp = now_ts()
        with self._conversation_lock:
            status = dict(self._agent_status.get(key) or self._idle_agent_status(scope_type, str(scope_id)))
            activity = [dict(item) for item in status.get("activity") or []]
            item = {
                "stage": stage,
                "source": source,
                "label": label,
                "detail": detail,
                "line": line if line is not None else agent_work_line(stage, label, detail),
                "at": timestamp,
            }
            matched_index = None
            if coalesce:
                for index in range(len(activity) - 1, -1, -1):
                    if activity[index].get("stage") == stage and activity[index].get("source") == source:
                        matched_index = index
                        break
            if matched_index is not None:
                activity.pop(matched_index)
            activity.append(item)
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

    def _record_agent_progress(self, scope_type: str, scope_id: str, event: dict[str, Any]) -> None:
        if not isinstance(event, dict):
            return
        event_type = str(event.get("event") or event.get("type") or event.get("event_type") or "").strip().lower()
        if event_type == "approval.request":
            self._record_agent_approval_request(scope_type, scope_id, event)
            return
        if event_type == "approval.responded":
            self._mark_agent_approval_responded(
                scope_type,
                scope_id,
                str(event.get("choice") or "").strip().lower(),
                responder="",
                approval_result=event,
            )
            return
        if event_type not in VISIBLE_TOOL_PROGRESS_EVENTS:
            return
        tool = str(event.get("tool") or event.get("tool_name") or "").strip()
        if not tool:
            return
        detail = agent_tool_detail(event)
        tool_call_id = str(event.get("toolCallId") or event.get("tool_call_id") or event.get("id") or "").strip()
        tool_status = str(event.get("status") or event_type).strip().lower()
        timestamp = now_ts()
        key = self._conversation_key(scope_type, str(scope_id))
        with self._conversation_lock:
            status = dict(self._agent_status.get(key) or self._idle_agent_status(scope_type, str(scope_id)))
            activity = [dict(item) for item in status.get("activity") or []]
            if tool_status in {
                "completed",
                "complete",
                "done",
                "tool.completed",
                "failed",
                "error",
                "tool.failed",
            }:
                terminal_status = (
                    "failed"
                    if tool_status in {"failed", "error", "tool.failed"}
                    else "completed"
                )
                matched_index: int | None = None
                if tool_call_id:
                    for index in range(len(activity) - 1, -1, -1):
                        item = activity[index]
                        if item.get("source") == "agent" and item.get("tool_call_id") == tool_call_id:
                            matched_index = index
                            break
                if matched_index is None and not tool_call_id:
                    for index in range(len(activity) - 1, -1, -1):
                        item = activity[index]
                        if (
                            item.get("source") == "agent"
                            and item.get("tool") == tool
                            and item.get("tool_status") == "running"
                        ):
                            matched_index = index
                            break
                if matched_index is None:
                    item = {
                        "stage": "tool",
                        "source": "agent",
                        "label": tool,
                        "detail": detail,
                        "line": agent_progress_line({**event, "tool": tool, "label": detail}),
                        "tool": tool,
                        "tool_call_id": tool_call_id,
                        "at": timestamp,
                    }
                else:
                    # A tool occupies one row for its entire lifecycle. Move the
                    # completed row to the end so approval events that happened
                    # while it was paused remain in chronological order.
                    item = activity.pop(matched_index)
                    item["tool"] = tool
                    item["label"] = tool
                    if detail:
                        item["detail"] = detail
                item["tool_status"] = terminal_status
                item["completed_at"] = timestamp
                activity.append(item)
                status["activity"] = activity[-30:]
                status["current_step"] = (
                    f"{tool} 执行失败"
                    if terminal_status == "failed"
                    else f"完成 {tool}"
                )
                status["updated_at"] = timestamp
                self._agent_status[key] = status
                return

            line = agent_progress_line({**event, "tool": tool, "label": detail})
            existing = None
            if tool_call_id:
                for item in reversed(activity):
                    if item.get("source") == "agent" and item.get("tool_call_id") == tool_call_id:
                        existing = item
                        break
            elif event_type == "tool.updated":
                for item in reversed(activity):
                    if (
                        item.get("source") == "agent"
                        and item.get("tool") == tool
                        and item.get("tool_status") == "running"
                    ):
                        existing = item
                        break
            item_data = {
                "stage": "tool",
                "source": "agent",
                "label": tool,
                "line": line,
                "tool": tool,
                "tool_call_id": tool_call_id,
                "tool_status": "running",
                "at": timestamp,
            }
            if detail:
                item_data["detail"] = detail
            if existing is not None:
                existing.update(item_data)
            else:
                item_data.setdefault("detail", "")
                activity.append(item_data)
            if is_substantive_tool_start(event):
                status = self._finalize_stream_message(status, timestamp)
            if status.get("state") == "approval":
                status["state"] = "replying"
                status["approval"] = None
            status["activity"] = activity[-30:]
            status["current_step"] = line
            status["updated_at"] = timestamp
            self._agent_status[key] = status

    def _record_agent_approval_request(self, scope_type: str, scope_id: str, event: dict[str, Any]) -> None:
        timestamp = now_ts()
        key = self._conversation_key(scope_type, str(scope_id))
        approval = self._approval_request_from_event(event, timestamp)
        line = f"等待权限审批: {approval['description']}"
        with self._conversation_lock:
            status = dict(self._agent_status.get(key) or self._idle_agent_status(scope_type, str(scope_id)))
            status = self._finalize_stream_message(status, timestamp)
            activity = [dict(item) for item in status.get("activity") or []]
            approval_id = approval["approval_id"]
            if approval_id and any(
                item.get("stage") == "approval.responded" and item.get("approval_id") == approval_id
                for item in activity
            ):
                return
            item_data = {
                "stage": "approval",
                "source": "agent",
                "label": "等待权限审批",
                "detail": approval["description"],
                "line": line,
                "approval_id": approval_id,
                "at": timestamp,
            }
            existing = None
            if approval_id:
                for item in reversed(activity):
                    if item.get("stage") == "approval" and item.get("approval_id") == approval_id:
                        existing = item
                        break
            if existing is None:
                activity.append(item_data)
            else:
                existing.update(item_data)
            status["state"] = "approval"
            status["approval"] = approval
            status["activity"] = activity[-30:]
            status["current_step"] = line
            status["updated_at"] = timestamp
            self._agent_status[key] = status

    def _mark_agent_approval_responded(
        self,
        scope_type: str,
        scope_id: str,
        choice: str,
        *,
        responder: str,
        approval_result: dict[str, Any],
    ) -> dict[str, Any]:
        timestamp = now_ts()
        key = self._conversation_key(scope_type, str(scope_id))
        choice_label = {
            "once": "允许一次",
            "session": "本会话允许",
            "always": "始终允许",
            "deny": "拒绝",
        }.get(choice, choice or "已处理")
        with self._conversation_lock:
            status = dict(self._agent_status.get(key) or self._idle_agent_status(scope_type, str(scope_id)))
            activity = [dict(item) for item in status.get("activity") or []]
            current_approval = dict(status.get("approval") or {})
            approval_id = str(
                (approval_result or {}).get("approval_id")
                or (approval_result or {}).get("id")
                or current_approval.get("approval_id")
                or ""
            ).strip()
            existing = None
            if approval_id:
                for item in reversed(activity):
                    if item.get("stage") == "approval.responded" and item.get("approval_id") == approval_id:
                        existing = item
                        break
            detail = f"{responder}: {choice_label}" if responder else choice_label
            item_data = {
                "stage": "approval.responded",
                "source": "platform",
                "label": "权限审批已处理",
                "detail": detail,
                "line": f"权限审批已处理: {choice_label}",
                "approval_id": approval_id,
                "approval_choice": choice,
                "approval_responder": responder,
                "at": timestamp,
                "approval_result": dict(approval_result or {}),
            }
            if existing is None:
                activity.append(item_data)
            elif responder or not existing.get("approval_responder"):
                # Prefer the user-facing HTTP responder over the anonymous SSE
                # acknowledgement when the two paths race.
                existing.update(item_data)
            current_approval_id = str(current_approval.get("approval_id") or "").strip()
            resolves_current = not current_approval_id or not approval_id or current_approval_id == approval_id
            if resolves_current:
                status["state"] = (
                    "replying"
                    if status.get("state") in {"approval", "replying"}
                    else status.get("state", "replying")
                )
                status["approval"] = None
                status["current_step"] = "权限审批已处理"
            status["activity"] = activity[-30:]
            status["updated_at"] = timestamp
            self._agent_status[key] = status
            return self._copy_status(status)

    @staticmethod
    def _approval_request_from_event(event: dict[str, Any], timestamp: int) -> dict[str, Any]:
        choices = event.get("choices")
        if not isinstance(choices, list) or not choices:
            choices = ["once", "session", "always", "deny"]
        pattern_keys = event.get("pattern_keys")
        if not isinstance(pattern_keys, list):
            pattern_keys = [event.get("pattern_key")] if event.get("pattern_key") else []
        return {
            "run_id": str(event.get("run_id") or "").strip(),
            "approval_id": str(event.get("approval_id") or event.get("id") or "").strip(),
            "command": str(event.get("command") or "").strip(),
            "description": str(event.get("description") or "危险操作需要权限审批").strip(),
            "pattern_key": str(event.get("pattern_key") or "").strip(),
            "pattern_keys": [str(item) for item in pattern_keys if str(item or "").strip()],
            "choices": [str(item) for item in choices if str(item or "").strip()],
            "requested_at": int(float(event.get("timestamp") or timestamp)),
        }

    def _agent_work_snapshot(self, task: dict[str, Any], state: str) -> dict[str, Any]:
        key = self._conversation_key(str(task["scope_type"]), str(task["scope_id"]))
        with self._conversation_lock:
            status = self._copy_status(
                self._agent_status.get(key)
                or self._idle_agent_status(str(task["scope_type"]), str(task["scope_id"]))
            )
        tool_activity = []
        for item in status.get("activity") or []:
            tool = str(item.get("tool") or "").strip()
            if (
                item.get("source") == "agent"
                and item.get("stage") == "tool"
                and tool
                and tool.lower() != "tool"
            ):
                tool_activity.append(item)
        return {
            "run_id": self._run_id_for_task(task),
            "state": state,
            "replying_to": self._reply_target(task),
            "activity": tool_activity,
            "current_step": status.get("current_step") or "",
            "started_at": status.get("started_at"),
            "updated_at": status.get("updated_at"),
            "approval": status.get("approval"),
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
        attachment_uploader_user_id: int | None = None,
    ) -> dict[str, Any]:
        with self._attachment_lock:
            return self._append_message_with_attachments_locked(
                scope_type=scope_type,
                scope_id=scope_id,
                author_type=author_type,
                user_id=user_id,
                username=username,
                content=content,
                metadata=metadata,
                attachments=attachments,
                attachment_source=attachment_source,
                attachment_uploader_user_id=attachment_uploader_user_id,
            )

    def _append_message_with_attachments_locked(
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
        attachment_uploader_user_id: int | None = None,
    ) -> dict[str, Any]:
        attachments = list(attachments or [])
        metadata = dict(metadata)
        if attachments:
            metadata["attachment_count"] = len(attachments)
        final_metadata = dict(metadata)
        if attachments:
            # The message row and attachment rows live in separate SQLite
            # transactions because blob writes occur between them. Mark the row
            # incomplete first; startup deletes any row left in this state by a
            # hard process death, before durable Agent-gap recovery can execute
            # a request with silently missing files.
            metadata["_attachment_commit"] = "pending"
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
                    uploader_user_id=(
                        int(attachment_uploader_user_id)
                        if attachment_uploader_user_id is not None
                        else user_id
                    ),
                    source=attachment_source,
                    attachments=attachments,
                )
                self.db.execute(
                    "UPDATE messages SET metadata_json = ? WHERE id = ?",
                    (encode_json(final_metadata), int(msg_id)),
                )
            except Exception:
                # The message row is already committed with attachment_count=N
                # but the blobs/rows failed to land. Remove the orphaned message
                # (ON DELETE CASCADE clears any partial attachment rows) so we do
                # not leave a message claiming attachments that do not exist.
                try:
                    self._delete_message_ids(
                        [int(msg_id)],
                        reason="message attachment commit failed",
                    )
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
        total_bytes = 0
        for item in attachments:
            data = bytes(item.data or b"")
            if not data:
                raise ServiceError(400, "attachment is empty")
            if len(data) > MAX_ATTACHMENT_BYTES:
                raise ServiceError(413, f"attachment exceeds {MAX_ATTACHMENT_BYTES // (1024 * 1024)} MB")
            filename = sanitize_attachment_filename(item.filename)
            content_type = normalize_attachment_mime(filename, item.content_type)
            total_bytes += len(data)
            if MAX_ATTACHMENTS_TOTAL_BYTES > 0 and total_bytes > MAX_ATTACHMENTS_TOTAL_BYTES:
                raise ServiceError(
                    413,
                    f"attachments exceed {MAX_ATTACHMENTS_TOTAL_BYTES // (1024 * 1024)} MB total",
                )
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
        root = self._attachment_root()
        target_dir = root / scope_type / str(scope_id)
        ensure_private_directory(root / scope_type)
        ensure_private_directory(target_dir)
        timestamp = now_ts()
        written: list[Path] = []
        try:
            with self.db.transaction() as conn:
                # Serialize quota check + rows so concurrent uploads cannot all
                # pass an old SUM snapshot. Files are staged under owner-only
                # directories and removed if the transaction fails.
                conn.execute("BEGIN IMMEDIATE")
                self._enforce_attachment_quota(
                    uploader_user_id,
                    attachments,
                    conn=conn,
                    scope_type=scope_type,
                    scope_id=str(scope_id),
                    source=source,
                )
                for attachment in attachments:
                    digest = hashlib.sha256(attachment.data).hexdigest()
                    ext = safe_attachment_suffix(attachment.filename)
                    storage_path = f"{scope_type}/{scope_id}/{message_id}-{secrets.token_urlsafe(12)}{ext}"
                    target = root / storage_path
                    write_private_file_exclusive(target, attachment.data)
                    written.append(target)
                    conn.execute(
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

    def _enforce_attachment_quota(
        self,
        uploader_user_id: int | None,
        attachments: list[UploadedFile],
        *,
        conn=None,
        scope_type: str = "",
        scope_id: str = "",
        source: str = "upload",
    ) -> None:
        """Reject uploads that would exceed the per-uploader storage budget."""
        incoming = sum(len(attachment.data) for attachment in attachments)
        if incoming <= 0:
            return
        query_one = conn.execute if conn is not None else self.db._conn.execute
        quota_user_id = uploader_user_id
        if quota_user_id is None and source in {LEGACY_GENERATED_ATTACHMENT_SOURCE, "agent_generated"} and scope_type == "private":
            try:
                quota_user_id = int(scope_id)
            except (TypeError, ValueError):
                quota_user_id = None
        if ATTACHMENT_QUOTA_BYTES > 0 and quota_user_id is not None:
            existing = query_one(
                "SELECT COALESCE(SUM(size_bytes), 0) FROM attachments "
                "WHERE uploader_user_id = ? OR "
                "(source IN (?, 'agent_generated') AND scope_type = 'private' AND scope_id = ?)",
                (int(quota_user_id), LEGACY_GENERATED_ATTACHMENT_SOURCE, str(quota_user_id)),
            ).fetchone()[0]
            if int(existing or 0) + incoming > ATTACHMENT_QUOTA_BYTES:
                raise ServiceError(413, "attachment storage quota exceeded")
        if GLOBAL_ATTACHMENT_QUOTA_BYTES > 0:
            global_existing = query_one("SELECT COALESCE(SUM(size_bytes), 0) FROM attachments").fetchone()[0]
            if int(global_existing or 0) + incoming > GLOBAL_ATTACHMENT_QUOTA_BYTES:
                raise ServiceError(507, "global attachment storage quota exceeded")

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

    def _delete_message_ids(self, message_ids: list[int], *, reason: str) -> int:
        """Delete exact message ids and cancel work derived from those rows.

        Callers may already hold ``_conversation_lock``; both locks are
        re-entrant so all deletion paths share the same ordering.  The database
        transition commits before best-effort unlinks. A crash after commit can
        therefore leave only an unreferenced blob, which startup reconciliation
        removes, never a live attachment row pointing at an intentionally
        deleted message.
        """

        ids = sorted({int(message_id) for message_id in message_ids if int(message_id) > 0})
        if not ids:
            return 0
        placeholders = ",".join("?" for _ in ids)
        dedupe_keys = [f"message:{message_id}" for message_id in ids]
        key_placeholders = ",".join("?" for _ in dedupe_keys)
        with self._conversation_lock:
            with self._attachment_lock:
                paths = self._attachment_file_paths_for_messages(ids)
                with self.db.transaction() as conn:
                    conn.execute(
                        f"""
                        UPDATE durable_jobs
                        SET status = 'failed', lease_until = 0, last_error = ?, updated_at = ?
                        WHERE kind IN ('agent', ?)
                          AND dedupe_key IN ({key_placeholders})
                          AND status IN ('queued', 'running')
                        """,
                        (
                            str(reason)[:2000],
                            now_ts(),
                            TELEGRAM_DELIVERY_JOB_KIND,
                            *dedupe_keys,
                        ),
                    )
                    cursor = conn.execute(
                        f"DELETE FROM messages WHERE id IN ({placeholders})",
                        ids,
                    )
                self._unlink_attachment_paths(paths)
                return max(0, int(cursor.rowcount))

    def _active_agent_scope_keys_for_message_ids(self, message_ids: list[int]) -> set[str]:
        """Return Agent scopes whose currently running source turn is deleted.

        The caller holds ``_conversation_lock`` so the active-task snapshot is
        ordered with both deletion and terminal Agent persistence.
        """

        wanted = {int(message_id) for message_id in message_ids if int(message_id) > 0}
        scope_keys: set[str] = set()
        for task in self._agent_active_tasks.values():
            try:
                message_id = int((task.get("user_message") or {})["id"])
            except (KeyError, TypeError, ValueError):
                continue
            if message_id not in wanted:
                continue
            scope_type = str(task.get("scope_type") or "")
            scope_id = str(task.get("scope_id") or "")
            if scope_type == "private":
                try:
                    scope_keys.add(self.agent_scopes.private_scope_key(int(scope_id)))
                except (TypeError, ValueError):
                    continue
            elif scope_type == "channel" and scope_id:
                scope_keys.add(self.agent_scopes.channel_scope_key(scope_id))
        return scope_keys

    def _attachment_file_paths_for_messages(self, message_ids: list[int]) -> list[Path]:
        ids = sorted({int(message_id) for message_id in message_ids if int(message_id) > 0})
        if not ids:
            return []
        placeholders = ",".join("?" for _ in ids)
        rows = self.db.query(
            f"SELECT storage_path FROM attachments WHERE message_id IN ({placeholders})",
            ids,
        )
        root = self._attachment_root().resolve()
        paths: list[Path] = []
        for row in rows:
            path = (root / str(row["storage_path"])).resolve()
            if root != path and root not in path.parents:
                continue
            paths.append(path)
        return paths

    @staticmethod
    def _unlink_attachment_paths(paths: list[Path]) -> None:
        for path in paths:
            try:
                path.unlink()
            except OSError:
                pass

    def _cleanup_orphan_attachment_files(self) -> None:
        """Remove attachment blobs that have no database row after a crash."""

        with self._attachment_lock:
            root = self._attachment_root().resolve()
            referenced: set[Path] = set()
            for row in self.db.query("SELECT storage_path FROM attachments"):
                path = (root / str(row["storage_path"])).resolve()
                if root != path and root not in path.parents:
                    continue
                referenced.add(path)
            for path in root.rglob("*"):
                if not path.is_file():
                    continue
                try:
                    resolved = path.resolve()
                except OSError:
                    continue
                if resolved not in referenced:
                    try:
                        path.unlink()
                    except OSError:
                        pass

    def _cleanup_incomplete_attachment_messages(self) -> None:
        """Discard messages interrupted before their attachment commit."""

        message_ids: list[int] = []
        for row in self.db.query(
            "SELECT id, metadata_json FROM messages WHERE metadata_json LIKE ?",
            ('%"_attachment_commit":"pending"%',),
        ):
            metadata = decode_json(row.get("metadata_json"))
            if isinstance(metadata, dict) and metadata.get("_attachment_commit") == "pending":
                message_ids.append(int(row["id"]))
        self._delete_message_ids(
            message_ids,
            reason="message attachment commit was interrupted by service restart",
        )

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
        return ensure_private_directory(root)

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
        """Dedicated scratch dir for managed Agent-generated media.

        Lives under the platform data dir (not the shared system temp dir) so
        runtime-generated files are isolated from shared system temporary data.
        """
        return self.config.managed_agent_runtime_home / "tmp"

    def _media_safe_data_subtrees(
        self,
        owner_id: int | None,
        workspace_path: Path | None = None,
    ) -> list[Path]:
        """Subtrees under the platform data dir that ARE safe to read media from
        (the agent's own workspace, the managed Agent generated-media cache, and
        the dedicated managed media scratch dir), used to keep platform secrets
        unreadable even when the data dir overlaps another allowed root."""
        if workspace_path is not None:
            workspace = workspace_path
        elif owner_id is not None:
            workspace = self.config.workspace_dir / f"user-{int(owner_id)}"
        else:
            workspace = self.config.workspace_dir
        subtrees: list[Path] = []
        for path in (
            workspace,
            self.config.managed_agent_runtime_home / "cache",
            self._managed_media_tmp_dir(),
        ):
            try:
                subtrees.append(path.resolve())
            except OSError:
                continue
        return subtrees

    def _media_allowed_roots(
        self,
        owner_id: int | None,
        workspace_path: Path | None = None,
    ) -> list[Path]:
        """Directories the platform will read agent-generated media from.

        For a private conversation only the owning user's workspace is allowed;
        a channel response is restricted to that channel Agent's workspace.
        The managed Agent runtime writes generated documents/images/audio under
        its cache and the dedicated
        managed media scratch dir, so those subtrees are allowed, plus any
        operator-configured ``ENTERPRISE_MEDIA_ROOTS``. The broad system temp dir
        is intentionally NOT allowed: it is shared with other processes/users on
        the host, so allowing it would let a prompt-injected agent exfiltrate
        arbitrary readable temp files via ``MEDIA:`` tags. Platform secrets
        elsewhere under the data directory (``platform.db``, runtime state,
        the bootstrap admin password) are never readable — see
        ``_resolve_media_path``.
        """
        candidates = list(self._media_safe_data_subtrees(owner_id, workspace_path))
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

    def _resolve_media_path(
        self,
        raw_path: str,
        owner_id: int | None,
        workspace_path: Path | None = None,
    ) -> Path | None:
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
        roots = self._media_allowed_roots(owner_id, workspace_path)
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
            safe = self._media_safe_data_subtrees(owner_id, workspace_path)
            if not any(candidate == s or candidate.is_relative_to(s) for s in safe):
                return None
        return candidate

    def _extract_generated_attachments(
        self,
        content: str,
        owner_id: int | None = None,
        workspace_path: Path | None = None,
    ) -> tuple[str, list[UploadedFile]]:
        content = str(content or "")
        candidates: list[UploadedFile] = []
        missing: list[str] = []
        refused: list[str] = []
        seen_paths: set[Path] = set()
        candidate_total = 0
        aggregate_limit_exceeded = False
        for match in MEDIA_TAG_RE.finditer(content):
            raw_path = clean_media_path(match.group("path"))
            if not raw_path:
                continue
            path = self._resolve_media_path(raw_path, owner_id, workspace_path)
            if path is None:
                # Distinguish "file is gone" from "file is outside the sandbox"
                # for diagnostics, without reading anything out of scope.
                try:
                    exists = Path(os.path.expanduser(raw_path)).exists()
                except OSError:
                    exists = False
                (refused if exists else missing).append(raw_path)
                continue
            if path in seen_paths:
                continue
            seen_paths.add(path)
            if len(candidates) >= MAX_ATTACHMENTS_PER_MESSAGE:
                refused.append(raw_path)
                continue
            try:
                size = path.stat().st_size
                if size > MAX_ATTACHMENT_BYTES:
                    refused.append(raw_path)
                    continue
                if MAX_ATTACHMENTS_TOTAL_BYTES > 0 and candidate_total + size > MAX_ATTACHMENTS_TOTAL_BYTES:
                    refused.append(raw_path)
                    aggregate_limit_exceeded = True
                    continue
                with path.open("rb") as handle:
                    data = handle.read(MAX_ATTACHMENT_BYTES + 1)
                if len(data) > MAX_ATTACHMENT_BYTES:
                    refused.append(raw_path)
                    continue
                candidates.append(
                    UploadedFile(path.name, normalize_attachment_mime(path.name, ""), data)
                )
                candidate_total += len(data)
            except OSError:
                missing.append(raw_path)

        if aggregate_limit_exceeded:
            candidates = []
        try:
            attachments = self._normalize_uploaded_files(candidates)
        except ServiceError as exc:
            # A generated response must never bypass the same aggregate limits
            # as a browser upload. Keep the textual answer visible while
            # refusing the whole oversized batch instead of saving a partial,
            # misleading set of files.
            attachments = []
            refused.append(f"generated attachment batch ({exc.message})")

        if not attachments and not missing and not refused:
            return content, []

        cleaned = MEDIA_TAG_RE.sub("", content)
        cleaned = cleaned.replace("[[audio_as_voice]]", "").replace("[[as_document]]", "")
        cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
        notes: list[str] = []
        if missing:
            notes.append("Agent returned file path(s) that the platform could not read: " + ", ".join(missing[:5]))
        if refused:
            notes.append(
                "Agent returned file path(s) that exceeded attachment limits or were outside the allowed media "
                "directories; they were not shared: "
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

    def _agent_session_seed_history(
        self,
        scope_type: str,
        scope_id: str,
        before_message_id: int,
    ) -> list[dict[str, str]]:
        """Seed a newly materialized runtime session from visible platform history.

        The sidecar records a durable seed marker and ignores this list after
        the first run for a scope/lifecycle/session tuple.
        """

        rows = self.db.query(
            """
            SELECT author_type, content FROM messages
            WHERE scope_type = ? AND scope_id = ? AND id < ?
              AND author_type IN ('user', 'agent', 'system')
            ORDER BY id DESC LIMIT 30
            """,
            (str(scope_type), str(scope_id), int(before_message_id)),
        )
        roles = {"user": "user", "agent": "assistant", "system": "system"}
        return [
            {"role": roles[str(row["author_type"])], "content": str(row["content"])}
            for row in reversed(rows)
            if str(row.get("content") or "").strip()
        ]

    @staticmethod
    def _valid_agent_session_id(session_id: str | None) -> bool:
        if not isinstance(session_id, str):
            return False
        if not session_id or len(session_id) > MAX_AGENT_SESSION_ID_LENGTH:
            return False
        return not any(ch in session_id for ch in "\r\n\x00")

    def _channel_agent_session_id(self, scope_id: str) -> str:
        return self._channel_agent_scope(scope_id).session_id

    def _remember_channel_agent_session_id(self, scope_id: str, session_id: str | None) -> None:
        if self._valid_agent_session_id(session_id):
            self.agent_scopes.update_session_id(
                self.agent_scopes.channel_scope_key(scope_id),
                str(session_id),
            )

    def _channel_agent_workspace(self, scope_id: str) -> Path:
        return Path(self._channel_agent_scope(scope_id).workspace_path)

    def _channel_agent_scope(self, scope_id: str) -> AgentExecutionScope:
        return self.agent_scopes.ensure_channel_scope(scope_id)

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

    @staticmethod
    def _agent_actor_metadata(actor: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": actor.get("id"),
            "username": actor.get("username"),
            "display_name": actor.get("display_name") or actor.get("username") or "User",
            "position": actor.get("position") or "",
        }

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
            "你是 ubitech agent。对外介绍自己时，只说自己是 ubitech agent；"
            "不要提及底层框架、运行时、模型供应商或内部实现。\n"
            f"当前工作模式: 频道协作。频道: #{channel['name']}。请保留上下文连续性，明确区分用户请求和知识库事实。\n"
            "知识库已通过 knowledge 工具提供；使用 search 操作检索，使用 read 操作读取完整条目。\n"
            "当提示中出现 kb:<id> 时，优先使用 knowledge/read 读取完整条目再作答。\n"
            f"{passive}"
        )

    def _private_system_prompt(
        self,
        actor: dict[str, Any],
        agent_scope: AgentExecutionScope,
        suggestions,
    ) -> str:
        passive = format_passive_suggestions(suggestions)
        return (
            "你是 ubitech agent。对外介绍自己时，只说自己是 ubitech agent；"
            "不要提及底层框架、运行时、模型供应商或内部实现。\n"
            "当前工作模式: 私人助手。每个用户拥有独立工作区、记忆和会话；命令在受信任的宿主机执行。\n"
            f"当前用户: {self._actor_context_label(actor, include_username=True, include_empty_position=True)}。\n"
            f"工作区: {agent_scope.workspace_path}；会话: {agent_scope.session_id}。\n"
            "模型密钥由平台集中配置，不要要求用户再次提供密钥。\n"
            "知识库通过 knowledge 工具提供；使用 search 操作检索，使用 read 操作读取完整条目。\n"
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


def agent_progress_line(event: dict[str, Any]) -> str:
    tool = str(event.get("tool") or event.get("tool_name") or "tool").strip() or "tool"
    label = str(event.get("label") or event.get("preview") or "").strip()
    emoji = str(event.get("emoji") or "⚙️").strip() or "⚙️"
    if label and label != tool:
        return f"{emoji} {tool}: \"{label}\""
    return f"{emoji} {tool}..."


def agent_tool_detail(event: dict[str, Any]) -> str:
    """Return a bounded, secret-redacted summary for a visible tool row.

    Raw tool arguments are never copied wholesale into message metadata. Only
    a small allowlist of useful fields is considered, and write/patch bodies are
    intentionally excluded.
    """

    tool = str(event.get("tool") or event.get("tool_name") or "").strip().lower()
    explicit = str(event.get("label") or event.get("preview") or "").strip()
    if explicit and explicit.lower() not in {tool, "tool"}:
        return _safe_tool_summary_text(explicit)
    arguments = event.get("arguments")
    if not isinstance(arguments, dict):
        return ""

    if tool == "terminal":
        return _safe_terminal_command_summary(arguments.get("command"))
    if tool == "process":
        return _safe_tool_summary_text(arguments.get("action"))
    if tool in {"read_file", "write_file", "patch_file"}:
        return _safe_tool_path(arguments.get("path"))
    if tool == "search_files":
        parts = [
            _safe_tool_summary_text(arguments.get("query")),
            _safe_tool_path(arguments.get("path")),
        ]
        return " · ".join(part for part in parts if part and part != ".")[:160]

    action = _safe_tool_summary_text(arguments.get("action"), limit=40)
    nested = arguments.get("arguments")
    nested = nested if isinstance(nested, dict) else {}
    if tool in {"web", "knowledge", "memory", "session"}:
        query = _safe_tool_summary_text(nested.get("query") or nested.get("q"))
        url = _safe_tool_url(nested.get("url"))
        identifier = _safe_tool_summary_text(nested.get("document_id") or nested.get("id"), limit=40)
        primary = query or url or identifier
        if primary:
            return primary
    if tool == "browser":
        url = _safe_tool_url(nested.get("url"))
        parts = [action, url]
        return " · ".join(part for part in parts if part)[:160]
    return action


def _safe_tool_path(value: Any) -> str:
    clean = _safe_tool_summary_text(value, limit=120)
    if not clean:
        return ""
    path = Path(clean)
    if path.is_absolute():
        return f"…/{path.name}" if path.name else "…"
    return clean


def _safe_terminal_command_summary(value: Any) -> str:
    """Expose command actions without persisting their arguments or values."""

    command = re.sub(r"[\x00-\x1f\x7f]+", " ", str(value or ""))
    actions: list[str] = []
    for segment in re.split(r"\s*(?:&&|\|\||[;|])\s*", command):
        try:
            tokens = shlex.split(segment, posix=True)
        except ValueError:
            tokens = segment.split()
        while tokens and (
            re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", tokens[0])
            or tokens[0] in {"command", "env", "exec", "nohup", "sudo"}
        ):
            tokens.pop(0)
        if not tokens:
            continue
        action = Path(tokens[0]).name.strip()
        if action and action not in actions:
            actions.append(action)
        if len(actions) >= 4:
            break
    return " · ".join(actions)


def _safe_tool_url(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        parsed = urllib.parse.urlsplit(raw)
        hostname = parsed.hostname or ""
        if not hostname and "://" not in raw and not raw.startswith(("/", "?", "#")):
            hostname = urllib.parse.urlsplit(f"//{raw}").hostname or ""
    except ValueError:
        return ""
    # Userinfo, path parameters, query strings and fragments may all carry
    # credentials. The host is enough context for a compact activity row.
    return _safe_tool_summary_text(hostname)


def _safe_tool_summary_text(value: Any, *, limit: int = 160) -> str:
    clean = re.sub(r"[\x00-\x1f\x7f]+", " ", str(value or ""))
    clean = re.sub(r"\s+", " ", clean).strip()
    if not clean:
        return ""
    clean = re.sub(
        r"(?i)\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|cookie|signature|session[_-]?(?:id|token|key|secret))[A-Za-z0-9_.-]*)\b(?:\s*[:=]\s*|\s+)(?:\"[^\"]*\"|'[^']*'|[^\s,;&|]+)",
        lambda match: f"{match.group(1)}=•••",
        clean,
    )
    clean = re.sub(r"(?i)\b(authorization\s*:\s*(?:bearer|basic))\s+\S+", r"\1 •••", clean)
    clean = re.sub(r"(?i)\b((?:set-)?cookie\s*:)\s*[^\s,;]+", r"\1 •••", clean)
    clean = re.sub(r"(?i)((?<!\S)(?:-u|--user)\s+)\S+", r"\1•••", clean)
    clean = re.sub(r"([A-Za-z][A-Za-z0-9+.-]*://)[^/\s:@]+:[^@/\s]+@", r"\1•••@", clean)
    clean = re.sub(
        r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b",
        "•••",
        clean,
    )
    clean = re.sub(r"\b(?:sk|gh[pousr])[-_][A-Za-z0-9_-]{16,}\b", "•••", clean)
    clean = re.sub(r"\b[A-Fa-f0-9]{32,}\b", "•••", clean)
    clean = re.sub(r"\b[A-Za-z0-9_+/=-]{48,}\b", "•••", clean)
    clean = re.sub(
        r"(?<![A-Za-z0-9:])/(?:home|root|tmp|var|opt|srv)/(?:[^\s\"';&|]+/)*([^\s\"';&|/]*)",
        lambda match: f"…/{match.group(1)}" if match.group(1) else "…",
        clean,
    )
    if len(clean) > limit:
        clean = clean[: max(1, limit - 1)].rstrip() + "…"
    return clean


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
