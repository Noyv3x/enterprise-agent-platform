from __future__ import annotations

import http.client
import hashlib
import hmac
import importlib.util
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
import urllib.parse
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

from enterprise_agent_platform import runtimes as runtime_module
from enterprise_agent_platform.auto_update import AutoUpdateManager
from enterprise_agent_platform.config import PlatformConfig
from enterprise_agent_platform.hermes import AgentResult, HermesAgentClient
from enterprise_agent_platform.oauth_flows import OAuthHTTPResponse
from enterprise_agent_platform.server import serve_in_thread
from enterprise_agent_platform.service import (
    BOOTSTRAP_ADMIN_PASSWORD_FILE,
    MAX_LOGIN_FAILURES,
    EnterpriseService,
    ServiceError,
    UploadedFile,
)
from enterprise_agent_platform.telegram_gateway import TelegramGateway


class RecordingAgent:
    def __init__(self):
        self.calls = []

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        return AgentResult(
            content=f"agent response to {kwargs['user_message']}",
            session_id=kwargs["session_id"],
            raw={"ok": True},
        )


class ApprovalRecordingAgent(RecordingAgent):
    def __init__(self):
        super().__init__()
        self.approvals = []

    def respond_approval(self, *, run_id, choice, resolve_all=False):
        payload = {"run_id": run_id, "choice": choice, "resolve_all": resolve_all}
        self.approvals.append(payload)
        return {**payload, "resolved": 1}


class UsageReportingAgent:
    def __init__(self, usages):
        self.usages = list(usages)
        self.calls = []

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        usage = self.usages[min(len(self.calls) - 1, len(self.usages) - 1)]
        return AgentResult(
            content=f"agent response to {kwargs['user_message']}",
            session_id=kwargs["session_id"],
            raw={"model": kwargs.get("model"), "usage": usage},
        )


class RotatingSessionAgent:
    def __init__(self, first_returned_session_id: str):
        self.first_returned_session_id = first_returned_session_id
        self.calls = []

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        session_id = self.first_returned_session_id if len(self.calls) == 1 else kwargs["session_id"]
        return AgentResult(
            content=f"agent response to {kwargs['user_message']}",
            session_id=session_id,
            raw={"ok": True},
        )


class MediaReturningAgent:
    def __init__(self, media_path: Path):
        self.media_path = media_path
        self.calls = []

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        return AgentResult(
            content=f"created file\nMEDIA:{self.media_path}",
            session_id=kwargs["session_id"],
            raw={"ok": True},
        )


class BlockingAgent:
    def __init__(self):
        self.calls = []
        self.started = threading.Event()
        self.release = threading.Event()

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        self.started.set()
        self.release.wait(timeout=5)
        return AgentResult(
            content=f"agent response to {kwargs['user_message']}",
            session_id=kwargs["session_id"],
            raw={"ok": True},
        )


class ProgressAgent:
    def __init__(self):
        self.calls = []

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        progress_callback = kwargs.get("progress_callback")
        if progress_callback:
            progress_callback(
                {
                    "tool": "enterprise_kb_search",
                    "emoji": "🔍",
                    "label": "VPN access policy",
                    "toolCallId": "call-1",
                    "status": "running",
                }
            )
            progress_callback(
                {
                    "tool": "enterprise_kb_search",
                    "toolCallId": "call-1",
                    "status": "completed",
                }
            )
        return AgentResult(
            content=f"agent response to {kwargs['user_message']}",
            session_id=kwargs["session_id"],
            raw={"ok": True},
        )


class FakeTelegramBot:
    def __init__(self):
        self.sent = []
        self.files_sent = []
        self.files = {}

    def send_message(self, **kwargs):
        self.sent.append(kwargs)

    def send_file(self, **kwargs):
        self.files_sent.append(kwargs)

    def get_file(self, file_id):
        return {"file_id": file_id, "file_path": self.files[file_id][0]}

    def download_file(self, file_path):
        for path, data in self.files.values():
            if path == file_path:
                return data
        raise KeyError(file_path)


class StreamingAgent:
    def __init__(self):
        self.calls = []
        self.first_delta = threading.Event()
        self.release = threading.Event()

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        content_callback = kwargs.get("content_callback")
        if content_callback:
            content_callback("Hello ")
            self.first_delta.set()
            self.release.wait(timeout=5)
            content_callback("world")
        return AgentResult(
            content="Hello world",
            session_id=kwargs["session_id"],
            raw={"ok": True},
        )


class ToolBoundaryStreamingAgent:
    def __init__(self):
        self.calls = []
        self.first_delta = threading.Event()
        self.release_tool = threading.Event()
        self.tool_started = threading.Event()
        self.release_final = threading.Event()

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        content_callback = kwargs.get("content_callback")
        progress_callback = kwargs.get("progress_callback")
        if content_callback:
            content_callback("Now browser_vision call.\n\n")
            self.first_delta.set()
        self.release_tool.wait(timeout=5)
        if progress_callback:
            progress_callback(
                {
                    "tool": "browser_vision",
                    "toolCallId": "call-1",
                    "status": "running",
                }
            )
            self.tool_started.set()
        self.release_final.wait(timeout=5)
        if content_callback:
            content_callback("好了，这次成功了。")
        return AgentResult(
            content="好了，这次成功了。",
            session_id=kwargs["session_id"],
            raw={"ok": True},
        )


class FakeProcess:
    pid = 43210

    def __init__(self):
        self.running = True

    def poll(self):
        return None if self.running else 0

    def terminate(self):
        self.running = False

    def wait(self, timeout=None):
        self.running = False
        return 0

    def kill(self):
        self.running = False


class RecordingLauncher:
    def __init__(self):
        self.calls = []
        self.processes = []

    def start(self, cmd, *, cwd, env, log_path):
        process = FakeProcess()
        self.calls.append({"cmd": cmd, "cwd": cwd, "env": env, "log_path": log_path})
        self.processes.append(process)
        return process


class RecordingCommandRunner:
    def __init__(self):
        self.calls = []

    def run(self, cmd, *, cwd, env, log_path, timeout):
        self.calls.append({"cmd": cmd, "cwd": cwd, "env": env, "log_path": log_path, "timeout": timeout})
        if len(cmd) >= 4 and cmd[1:3] == ["-m", "venv"]:
            venv_dir = Path(cmd[3])
            python = venv_dir / ("Scripts" if os.name == "nt" else "bin") / ("python.exe" if os.name == "nt" else "python")
            python.parent.mkdir(parents=True, exist_ok=True)
            python.write_text("", encoding="utf-8")
        return subprocess.CompletedProcess(cmd, 0)


class FakeResponsesStream:
    def __init__(self, events):
        self.events = events
        self.kwargs = None
        self.closed = False

    def create(self, **kwargs):
        self.kwargs = kwargs
        return self

    def __iter__(self):
        return iter(self.events)

    def close(self):
        self.closed = True


class FakeCodexClient:
    def __init__(self, events):
        self.responses = FakeResponsesStream(events)


class FakeCodexAgent:
    _interrupt_requested = False

    def __init__(self):
        self.activity = []
        self.deltas = []
        self.reasoning = []

    def _get_transport(self):
        return SimpleNamespace(preflight_kwargs=lambda kwargs, allow_stream=False: kwargs)

    def _touch_activity(self, message):
        self.activity.append(message)

    def _fire_stream_delta(self, delta):
        self.deltas.append(delta)

    def _fire_reasoning_delta(self, delta):
        self.reasoning.append(delta)


class FakeOAuthHTTPClient:
    def __init__(self):
        self.calls = []

    def get_json(self, url, *, timeout=20.0):
        self.calls.append(("get_json", url, {}))
        return OAuthHTTPResponse(
            200,
            {
                "authorization_endpoint": "https://xai.example/authorize",
                "token_endpoint": "https://xai.example/token",
            },
        )

    def post_json(self, url, body, *, timeout=20.0):
        self.calls.append(("post_json", url, dict(body)))
        if url.endswith("/usercode"):
            return OAuthHTTPResponse(
                200,
                {
                    "user_code": "CODE-1234",
                    "device_auth_id": "device-1",
                    "interval": 1,
                    "expires_in": 900,
                },
            )
        if url.endswith("/token"):
            return OAuthHTTPResponse(200, {"authorization_code": "codex-code", "code_verifier": "codex-verifier"})
        return OAuthHTTPResponse(404, {}, "not found")

    def post_form(self, url, body, *, timeout=20.0):
        self.calls.append(("post_form", url, dict(body)))
        if url == "https://auth.openai.com/oauth/token":
            return OAuthHTTPResponse(200, {"access_token": "codex-access", "refresh_token": "codex-refresh"})
        if url == "https://xai.example/token":
            return OAuthHTTPResponse(
                200,
                {
                    "access_token": "grok-access",
                    "refresh_token": "grok-refresh",
                    "id_token": "grok-id",
                    "token_type": "Bearer",
                    "expires_in": 3600,
                },
            )
        return OAuthHTTPResponse(404, {}, "not found")


class FakeHermesBridge:
    def __init__(self):
        self.catalog_calls = []

    def available(self):
        return True

    def model_catalog(self, provider, *, force_refresh=False):
        self.catalog_calls.append((provider, force_refresh))
        if provider == "openai-codex":
            return {
                "provider": "openai-codex",
                "models": ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"],
                "default_model": "gpt-5.5",
            }
        if provider == "xai-oauth":
            return {
                "provider": "xai-oauth",
                "models": ["grok-4.3", "grok-4.20-0309-reasoning"],
                "default_model": "grok-4.3",
            }
        return {"provider": provider, "models": [], "default_model": ""}


def make_config(tmp: Path) -> PlatformConfig:
    return PlatformConfig(
        data_dir=tmp,
        host="127.0.0.1",
        port=0,
        public_base_url="http://127.0.0.1:0",
        token_secret="test-secret",
        token_ttl_seconds=3600,
        agent_tool_token="agent-token",
        agent_mode="local",
        hermes_api_url="http://127.0.0.1:8642/v1/chat/completions",
        hermes_api_key="",
        hermes_model="hermes-agent",
        hermes_timeout_seconds=2,
        knowledge_backend="local",
        cognee_dataset="enterprise_knowledge",
        cognee_ingest_background=True,
        container_backend="local",
        container_image="python:3.11-slim",
        cognee_repo=tmp / "cognee",
        hermes_repo=tmp / "hermes-agent",
        firecrawl_repo=tmp / "firecrawl",
        camofox_url="http://127.0.0.1:19377",
        firecrawl_api_url="http://127.0.0.1:13002",
        hermes_home=tmp / "runtimes" / "hermes",
        runtime_startup_wait_seconds=0,
        allow_insecure_bootstrap_password=True,
    )


def make_fake_hermes_repo(path: Path) -> None:
    (path / "hermes_cli").mkdir(parents=True, exist_ok=True)
    (path / "hermes_cli" / "__init__.py").write_text("", encoding="utf-8")
    (path / "hermes_cli" / "main.py").write_text("def main(): pass\n", encoding="utf-8")
    (path / "hermes_cli" / "secret_prompt.py").write_text("def masked_secret_prompt(*args, **kwargs): return ''\n", encoding="utf-8")
    (path / "hermes_cli" / "config.py").write_text(
        "DEFAULT_CONFIG = {\n"
        "    'agent': {'max_turns': 90, 'api_max_retries': 3},\n"
        "    'display': {'show_reasoning': False, 'streaming': True},\n"
        "    'toolsets': ['hermes-cli'],\n"
        "    'tool_output': {'max_bytes': 60000},\n"
        "}\n",
        encoding="utf-8",
    )
    (path / "pyproject.toml").write_text(
        '[project]\nname = "hermes-agent-test"\nversion = "0.0.0"\n',
        encoding="utf-8",
    )


def make_fake_cognee_repo(path: Path) -> None:
    (path / "cognee").mkdir(parents=True, exist_ok=True)
    (path / "cognee" / "__init__.py").write_text(
        "class SearchType:\n    CHUNKS = 'chunks'\n",
        encoding="utf-8",
    )


def make_fake_firecrawl_repo(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    (path / "docker-compose.yml").write_text("services:\n  api:\n    image: firecrawl\n", encoding="utf-8")


def git_run(cwd: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        text=True,
        capture_output=True,
        check=True,
    )


def git_commit_all(cwd: Path, message: str) -> None:
    git_run(cwd, "add", ".")
    subprocess.run(
        ["git", "-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", message],
        cwd=str(cwd),
        text=True,
        capture_output=True,
        check=True,
    )


class FakeAutoUpdateConfig:
    def __init__(self, *, enabled=True, interval=30, remote="origin", branch="main"):
        self.enabled = enabled
        self.interval = interval
        self.remote = remote
        self.branch = branch

    def auto_update_enabled(self):
        return self.enabled

    def auto_update_interval_seconds(self):
        return self.interval

    def auto_update_remote(self):
        return self.remote

    def auto_update_branch(self):
        return self.branch


class FakeAutoUpdater:
    def __init__(self):
        self.triggers = []

    def status(self):
        return {"trigger_count": len(self.triggers)}

    def trigger(self, reason):
        self.triggers.append(reason)
        return self.status()

    def stop(self):
        pass


def managed_python(home: Path) -> Path:
    return home / ("Scripts" if os.name == "nt" else "bin") / ("python.exe" if os.name == "nt" else "python")


class PlatformServiceTests(unittest.TestCase):
    def test_auto_update_manager_detects_remote_commit_and_skips_dirty_tree(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            remote = root / "remote.git"
            downstream = root / "downstream"
            upstream = root / "upstream"
            git_run(root, "init", "--bare", str(remote))
            downstream.mkdir()
            git_run(downstream, "init")
            git_run(downstream, "checkout", "-b", "main")
            (downstream / "README.md").write_text("initial\n", encoding="utf-8")
            deploy = downstream / "deploy.sh"
            deploy.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
            deploy.chmod(0o755)
            git_commit_all(downstream, "initial")
            git_run(downstream, "remote", "add", "origin", str(remote))
            git_run(downstream, "push", "-u", "origin", "main")

            git_run(root, "clone", str(remote), str(upstream))
            git_run(upstream, "checkout", "main")
            (upstream / "README.md").write_text("updated\n", encoding="utf-8")
            git_commit_all(upstream, "updated")
            git_run(upstream, "push", "origin", "main")

            launched = []
            manager = AutoUpdateManager(
                FakeAutoUpdateConfig(branch="main"),
                repo_root=downstream,
                launcher=lambda reason: launched.append(reason) or [str(deploy), "update"],
            )
            status = manager.check_once("webhook")
            self.assertTrue(status["update_available"])
            self.assertTrue(status["update_started"])
            self.assertEqual(launched, ["webhook"])
            self.assertEqual(status["branch"], "main")

            (downstream / "local-change.txt").write_text("dirty\n", encoding="utf-8")
            dirty = manager.check_once("poll")
            self.assertTrue(dirty["dirty"])
            self.assertFalse(dirty["update_started"])
            self.assertEqual(launched, ["webhook"])

    def test_token_usage_report_tracks_account_scope_provider_and_model(self):
        with tempfile.TemporaryDirectory() as td:
            agent = UsageReportingAgent(
                [
                    {"input_tokens": 10, "output_tokens": 4, "total_tokens": 14},
                    {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8},
                ]
            )
            service = EnterpriseService(
                make_config(Path(td)),
                agent_client=agent,
                hermes_bridge=FakeHermesBridge(),
            )
            try:
                _, admin = service.authenticate("admin", "admin")
                member = service.create_user(
                    username="token-user",
                    password="member-pass",
                    display_name="Token User",
                    role="member",
                    actor=admin,
                )
                _, member_actor = service.authenticate("token-user", "member-pass")

                service.send_channel_message(admin, 1, "@agent channel usage")
                service.wait_for_agent_idle("channel", "1")
                service.send_private_message(member_actor, "private usage")
                service.wait_for_agent_idle("private", str(member["id"]))

                report = service.token_usage_report(admin, days=30)
                self.assertEqual(report["summary"]["event_count"], 2)
                self.assertEqual(report["summary"]["input_tokens"], 15)
                self.assertEqual(report["summary"]["output_tokens"], 7)
                self.assertEqual(report["summary"]["total_tokens"], 22)
                self.assertEqual(report["today"]["total_tokens"], 22)
                self.assertEqual(report["last_7_days"]["total_tokens"], 22)
                self.assertEqual(len(report["daily_usage"]), 7)
                self.assertEqual(sum(day["total_tokens"] for day in report["daily_usage"]), 22)
                self.assertEqual(report["daily_usage"][-1]["total_tokens"], 22)

                by_account = {row["username"]: row for row in report["by_account"]}
                self.assertEqual(by_account["admin"]["total_tokens"], 14)
                self.assertEqual(by_account["token-user"]["total_tokens"], 8)

                detail_keys = {
                    (row["username"], row["scope_type"], row["scope_name"], row["provider"], row["model"]): row
                    for row in report["details"]
                }
                self.assertIn(("admin", "channel", "#general", "openai-codex", "gpt-5.5"), detail_keys)
                self.assertIn(("token-user", "private", "Token User", "openai-codex", "gpt-5.5"), detail_keys)

                channel_messages = service.list_messages(admin, "channel", "1")
                agent_message = next(message for message in channel_messages if message["author_type"] == "agent")
                self.assertEqual(agent_message["metadata"]["token_usage"]["total_tokens"], 14)
                self.assertEqual(agent_message["metadata"]["token_usage"]["provider"], "openai-codex")
            finally:
                service.close()

    def test_token_usage_report_exposes_today_and_last_7_day_consumption(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(
                make_config(Path(td)),
                agent_client=RecordingAgent(),
                hermes_bridge=FakeHermesBridge(),
            )
            try:
                _, admin = service.authenticate("admin", "admin")
                now = int(time.time())
                today_start = service._token_usage_day_start(now)
                two_days_ago = service._token_usage_day_start(now, offset_days=-2) + 60
                eight_days_ago = service._token_usage_day_start(now, offset_days=-8) + 60

                for created_at, total_tokens in (
                    (today_start, 100),
                    (two_days_ago, 70),
                    (eight_days_ago, 9),
                ):
                    service.db.insert(
                        """
                        INSERT INTO token_usage_events(
                            user_id, username, display_name, scope_type, scope_id, scope_name,
                            request_message_id, response_message_id, provider, model,
                            input_tokens, output_tokens, total_tokens, raw_usage_json, degraded, created_at
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            int(admin["id"]),
                            "admin",
                            "Administrator",
                            "channel",
                            "1",
                            "#general",
                            1,
                            2,
                            "openai-codex",
                            "gpt-5.5",
                            total_tokens // 2,
                            total_tokens - (total_tokens // 2),
                            total_tokens,
                            "{}",
                            0,
                            created_at,
                        ),
                    )

                report = service.token_usage_report(admin, days=30)
                daily = {row["date"]: row for row in report["daily_usage"]}

                self.assertEqual(report["summary"]["total_tokens"], 179)
                self.assertEqual(report["today"]["total_tokens"], 100)
                self.assertEqual(report["last_7_days"]["total_tokens"], 170)
                self.assertEqual(len(report["daily_usage"]), 7)
                self.assertEqual(sum(row["total_tokens"] for row in report["daily_usage"]), 170)
                self.assertEqual(report["daily_usage"][-1]["start_at"], today_start)
                self.assertEqual(report["daily_usage"][-1]["total_tokens"], 100)
                self.assertEqual(
                    daily[time.strftime("%Y-%m-%d", time.localtime(two_days_ago))]["total_tokens"],
                    70,
                )
                self.assertNotIn(time.strftime("%Y-%m-%d", time.localtime(eight_days_ago)), daily)
            finally:
                service.close()

    def test_agent_approval_status_can_be_responded_from_channel_scope(self):
        with tempfile.TemporaryDirectory() as td:
            agent = ApprovalRecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, admin = service.authenticate("admin", "admin")
                service._record_hermes_progress(
                    "channel",
                    "1",
                    {
                        "event": "approval.request",
                        "run_id": "run_42",
                        "command": "rm -rf build",
                        "description": "recursive delete",
                        "choices": ["once", "session", "always", "deny"],
                    },
                )

                status = service.agent_status(admin, "channel", "1")
                self.assertEqual(status["state"], "approval")
                self.assertEqual(status["approval"]["run_id"], "run_42")
                self.assertEqual(status["approval"]["command"], "rm -rf build")

                result = service.respond_agent_approval(admin, "channel", "1", "session")

                self.assertEqual(agent.approvals, [{"run_id": "run_42", "choice": "session", "resolve_all": False}])
                self.assertTrue(result["ok"])
                self.assertEqual(result["agent_status"]["state"], "replying")
                self.assertIsNone(result["agent_status"]["approval"])
                self.assertEqual(result["agent_status"]["current_step"], "权限审批已处理")
            finally:
                service.close()

    def test_hermes_client_uses_post_tool_stream_as_final_response(self):
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                events = [
                    "data: "
                    + json.dumps({"choices": [{"delta": {"content": "Now browser_vision call.\n\n"}}]})
                    + "\n\n",
                    (
                        "event: hermes.tool.progress\n"
                        f"data: {json.dumps({'tool': 'browser_vision', 'toolCallId': 'call-1', 'status': 'running'})}\n\n"
                    ),
                    (
                        "event: hermes.tool.progress\n"
                        f"data: {json.dumps({'tool': 'browser_vision', 'toolCallId': 'call-1', 'status': 'completed'})}\n\n"
                    ),
                    "data: " + json.dumps({"choices": [{"delta": {"content": "好了，这次成功了。"}}]}) + "\n\n",
                    "data: [DONE]\n\n",
                ]
                for event in events:
                    self.wfile.write(event.encode("utf-8"))
                    self.wfile.flush()

            def log_message(self, format, *args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as td:
                config = replace(
                    make_config(Path(td)),
                    agent_mode="hermes",
                    hermes_api_url=f"http://127.0.0.1:{server.server_port}/v1/chat/completions",
                )
                chunks = []
                progress = []
                client = HermesAgentClient(config, lambda name: "")
                result = client.generate(
                    system_prompt="system",
                    user_message="question",
                    history=[],
                    session_id="session-1",
                    session_key="channel:1:main-agent",
                    progress_callback=progress.append,
                    content_callback=chunks.append,
                )

                self.assertEqual(result.content, "好了，这次成功了。")
                self.assertEqual(chunks, ["Now browser_vision call.\n\n", None, "好了，这次成功了。"])
                self.assertEqual([event["status"] for event in progress], ["running", "completed"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=1)

    def test_hermes_client_keeps_pre_tool_text_when_no_post_tool_response(self):
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                events = [
                    "data: "
                    + json.dumps({"choices": [{"delta": {"content": "Here is the summary you asked for."}}]})
                    + "\n\n",
                    (
                        "event: hermes.tool.progress\n"
                        f"data: {json.dumps({'tool': 'browser_vision', 'toolCallId': 'call-1', 'status': 'running'})}\n\n"
                    ),
                    "data: [DONE]\n\n",
                ]
                for event in events:
                    self.wfile.write(event.encode("utf-8"))
                    self.wfile.flush()

            def log_message(self, format, *args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as td:
                config = replace(
                    make_config(Path(td)),
                    agent_mode="hermes",
                    hermes_api_url=f"http://127.0.0.1:{server.server_port}/v1/chat/completions",
                )
                client = HermesAgentClient(config, lambda name: "")
                result = client.generate(
                    system_prompt="system",
                    user_message="question",
                    history=[],
                    session_id="session-1",
                    session_key="channel:1:main-agent",
                    progress_callback=lambda event: None,
                    content_callback=lambda chunk: None,
                )
                # Pre-tool prose is preserved instead of being lost (which used
                # to raise "no final streaming response").
                self.assertEqual(result.content, "Here is the summary you asked for.")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=1)

    def test_hermes_runtime_patch_backfills_codex_stream_output_null(self):
        patch_path = Path(runtime_module.__file__).resolve().parent / "hermes_runtime_patch" / "sitecustomize.py"
        spec = importlib.util.spec_from_file_location("enterprise_hermes_runtime_patch_test", patch_path)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        terminal = SimpleNamespace(status="completed", output=None)
        events = [
            SimpleNamespace(type="response.output_text.delta", delta="O"),
            SimpleNamespace(type="response.output_text.delta", delta="K"),
            SimpleNamespace(type="response.completed", response=terminal),
        ]
        client = FakeCodexClient(events)
        agent = FakeCodexAgent()
        first_delta = []

        result = module._run_raw_responses_stream(
            agent,
            {"model": "gpt-5.3-codex", "input": []},
            client=client,
            on_first_delta=lambda: first_delta.append(True),
        )

        self.assertEqual(agent.deltas, ["O", "K"])
        self.assertEqual(first_delta, [True])
        self.assertTrue(client.responses.closed)
        self.assertEqual(client.responses.kwargs["stream"], True)
        self.assertEqual(len(result.output), 1)
        self.assertEqual(result.output[0].content[0].text, "OK")

    def test_hermes_runtime_patch_backfills_auxiliary_codex_stream_output_null(self):
        patch_path = Path(runtime_module.__file__).resolve().parent / "hermes_runtime_patch" / "sitecustomize.py"
        spec = importlib.util.spec_from_file_location("enterprise_hermes_runtime_patch_aux_test", patch_path)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        class FakeAuxiliaryResponses(FakeResponsesStream):
            def stream(self, **kwargs):
                raise TypeError("'NoneType' object is not iterable")

        class FakeAuxiliaryClient:
            def __init__(self, events):
                self.responses = FakeAuxiliaryResponses(events)

        class FakeAuxiliaryAdapter:
            def __init__(self, client):
                self._client = client

            def create(self, **kwargs):
                with self._client.responses.stream(**kwargs) as stream:
                    for _event in stream:
                        pass
                    return stream.get_final_response()

        fake_auxiliary = types.ModuleType("agent.auxiliary_client")
        fake_auxiliary._CodexCompletionsAdapter = FakeAuxiliaryAdapter
        fake_agent = types.ModuleType("agent")
        fake_agent.auxiliary_client = fake_auxiliary
        old_agent = sys.modules.get("agent")
        old_auxiliary = sys.modules.get("agent.auxiliary_client")
        sys.modules["agent"] = fake_agent
        sys.modules["agent.auxiliary_client"] = fake_auxiliary
        try:
            module._install_auxiliary_response_stream_patch()

            terminal = SimpleNamespace(status="completed", output=None)
            client = FakeAuxiliaryClient([
                SimpleNamespace(type="response.output_text.delta", delta="O"),
                SimpleNamespace(type="response.output_text.delta", delta="K"),
                SimpleNamespace(type="response.completed", response=terminal),
            ])
            result = FakeAuxiliaryAdapter(client).create(model="gpt-5.3-codex", input=[])
        finally:
            if old_agent is None:
                sys.modules.pop("agent", None)
            else:
                sys.modules["agent"] = old_agent
            if old_auxiliary is None:
                sys.modules.pop("agent.auxiliary_client", None)
            else:
                sys.modules["agent.auxiliary_client"] = old_auxiliary

        self.assertTrue(client.responses.closed)
        self.assertEqual(client.responses.kwargs["stream"], True)
        self.assertEqual(len(result.output), 1)
        self.assertEqual(result.output[0].content[0].text, "OK")
        with self.assertRaises(TypeError):
            client.responses.stream()

    def test_hermes_client_streams_tool_progress_events(self):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                requests.append({"headers": dict(self.headers), "body": body})
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("X-Hermes-Session-Id", "stream-session")
                self.end_headers()
                events = [
                    (
                        "event: hermes.tool.progress\n"
                        f"data: {json.dumps({'tool': 'enterprise_kb_search', 'emoji': '🔍', 'label': 'VPN policy', 'toolCallId': 'call-1', 'status': 'running'})}\n\n"
                    ),
                    f"data: {json.dumps({'choices': [{'delta': {'role': 'assistant'}}]})}\n\n",
                    f"data: {json.dumps({'choices': [{'delta': {'content': 'Found '}}]})}\n\n",
                    (
                        "event: hermes.tool.progress\n"
                        f"data: {json.dumps({'tool': 'enterprise_kb_search', 'toolCallId': 'call-1', 'status': 'completed'})}\n\n"
                    ),
                    f"data: {json.dumps({'choices': [{'delta': {'content': 'policy.'}}]})}\n\n",
                    "data: [DONE]\n\n",
                ]
                for event in events:
                    self.wfile.write(event.encode("utf-8"))
                    self.wfile.flush()

            def log_message(self, format, *args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as td:
                config = replace(
                    make_config(Path(td)),
                    agent_mode="hermes",
                    hermes_api_url=f"http://127.0.0.1:{server.server_port}/v1/chat/completions",
                    hermes_api_key="test-key",
                )
                events = []
                content_chunks = []
                client = HermesAgentClient(config, lambda name: "")
                result = client.generate(
                    system_prompt="system",
                    user_message="question",
                    history=[],
                    session_id="session-1",
                    session_key="channel:1:main-agent",
                    progress_callback=events.append,
                    content_callback=content_chunks.append,
                )

                self.assertEqual(result.content, "Found policy.")
                self.assertEqual(content_chunks, ["Found ", "policy."])
                self.assertEqual(result.session_id, "stream-session")
                self.assertEqual([event["status"] for event in events], ["running", "completed"])
                self.assertEqual(events[0]["tool"], "enterprise_kb_search")
                self.assertTrue(requests[-1]["body"]["stream"])
                self.assertEqual(requests[-1]["headers"]["Authorization"], "Bearer test-key")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=1)

    def test_hermes_client_reads_run_events_and_posts_approval_response(self):
        requests = []
        approvals = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
                if self.path == "/v1/runs":
                    requests.append({"headers": dict(self.headers), "body": body})
                    self.send_response(202)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"run_id": "run_1", "status": "started"}).encode("utf-8"))
                    return
                if self.path == "/v1/runs/run_1/approval":
                    approvals.append({"headers": dict(self.headers), "body": body})
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(
                        json.dumps(
                            {
                                "object": "hermes.run.approval_response",
                                "run_id": "run_1",
                                "choice": body.get("choice"),
                                "resolved": 1,
                            }
                        ).encode("utf-8")
                    )
                    return
                self.send_response(404)
                self.end_headers()

            def do_GET(self):
                if self.path != "/v1/runs/run_1/events":
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                events = [
                    {"event": "message.delta", "run_id": "run_1", "delta": "Hello "},
                    {
                        "event": "approval.request",
                        "run_id": "run_1",
                        "command": "rm -rf build",
                        "description": "recursive delete",
                        "choices": ["once", "session", "always", "deny"],
                    },
                    {"event": "approval.responded", "run_id": "run_1", "choice": "once"},
                    {"event": "message.delta", "run_id": "run_1", "delta": "world"},
                    {
                        "event": "run.completed",
                        "run_id": "run_1",
                        "session_id": "session-rotated",
                        "output": "Hello world",
                        "usage": {"input_tokens": 2, "output_tokens": 1, "total_tokens": 3},
                    },
                ]
                for event in events:
                    self.wfile.write(f"data: {json.dumps(event)}\n\n".encode("utf-8"))
                    self.wfile.flush()

            def log_message(self, format, *args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as td:
                config = replace(
                    make_config(Path(td)),
                    agent_mode="hermes",
                    hermes_api_url=f"http://127.0.0.1:{server.server_port}/v1/chat/completions",
                    hermes_api_key="test-key",
                )
                progress = []
                chunks = []
                client = HermesAgentClient(config, lambda name: "")
                result = client.generate(
                    system_prompt="system",
                    user_message="question",
                    history=[],
                    session_id="session-1",
                    session_key="channel:1:main-agent",
                    progress_callback=progress.append,
                    content_callback=chunks.append,
                )
                response = client.respond_approval(run_id="run_1", choice="always", resolve_all=True)

                self.assertEqual(result.content, "Hello world")
                self.assertEqual(result.session_id, "session-rotated")
                self.assertEqual(chunks, ["Hello ", "world"])
                self.assertEqual([event["event"] for event in progress], ["approval.request", "approval.responded"])
                self.assertEqual(result.raw["mode"], "runs")
                self.assertEqual(result.raw["usage"]["total_tokens"], 3)
                self.assertEqual(requests[0]["body"]["input"][0]["content"], "question")
                self.assertEqual(requests[0]["body"]["instructions"], "system")
                self.assertEqual(requests[0]["headers"]["X-Hermes-Session-Id"], "session-1")
                self.assertEqual(requests[0]["headers"]["X-Hermes-Session-Key"], "channel:1:main-agent")
                self.assertEqual(approvals[0]["body"], {"choice": "always", "all": True})
                self.assertEqual(response["resolved"], 1)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=1)

    def test_hermes_client_streams_responses_api_output_text_events(self):
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                events = [
                    f"data: {json.dumps({'type': 'response.output_text.delta', 'delta': '看到了'})}\n\n",
                    f"data: {json.dumps({'type': 'response.output_text.delta', 'delta': '图片。'})}\n\n",
                    "data: [DONE]\n\n",
                ]
                for event in events:
                    self.wfile.write(event.encode("utf-8"))
                    self.wfile.flush()

            def log_message(self, format, *args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as td:
                config = replace(
                    make_config(Path(td)),
                    agent_mode="hermes",
                    hermes_api_url=f"http://127.0.0.1:{server.server_port}/v1/chat/completions",
                )
                chunks = []
                client = HermesAgentClient(config, lambda name: "")
                result = client.generate(
                    system_prompt="system",
                    user_message="question",
                    history=[],
                    session_id="session-1",
                    session_key="channel:1:main-agent",
                    content_callback=chunks.append,
                )

                self.assertEqual(result.content, "看到了图片。")
                self.assertEqual(chunks, ["看到了", "图片。"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=1)

    def test_auto_agent_falls_back_instead_of_saving_empty_hermes_response(self):
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()

            def log_message(self, format, *args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as td:
                service = EnterpriseService(
                    replace(
                        make_config(Path(td)),
                        agent_mode="auto",
                        hermes_api_url=f"http://127.0.0.1:{server.server_port}/v1/chat/completions",
                    )
                )
                try:
                    _, user = service.authenticate("admin", "admin")
                    service.send_channel_message(user, 1, "@agent hello")
                    service.wait_for_agent_idle("channel", "1")
                    messages = service.list_messages(user, "channel", "1")

                    self.assertNotIn("(agent returned an empty response)", messages[-1]["content"])
                    self.assertIn("Hermes Agent request did not complete", messages[-1]["content"])
                    self.assertTrue(messages[-1]["metadata"]["degraded"])
                finally:
                    service.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=1)

    def test_hermes_client_sends_image_attachments_as_multimodal_content(self):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                requests.append(body)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(
                    json.dumps({"choices": [{"message": {"content": "saw image"}}]}).encode("utf-8")
                )

            def log_message(self, format, *args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as td:
                tmp = Path(td)
                image_path = tmp / "image.png"
                image_path.write_bytes(b"\x89PNG\r\n\x1a\nimage-bytes")
                config = replace(
                    make_config(tmp),
                    agent_mode="hermes",
                    hermes_api_url=f"http://127.0.0.1:{server.server_port}/v1/chat/completions",
                    hermes_api_key="test-key",
                )
                client = HermesAgentClient(config, lambda name: "")
                result = client.generate(
                    system_prompt="system",
                    user_message="look at this\n\n[User attached image: image.png (image/png, 19 B); local path: /tmp/image.png]",
                    history=[],
                    session_id="session-1",
                    session_key="private:1",
                    attachments=[
                        {
                            "filename": "image.png",
                            "mime_type": "image/png",
                            "is_image": True,
                            "local_path": str(image_path),
                            "size_bytes": image_path.stat().st_size,
                        }
                    ],
                )

                self.assertEqual(result.content, "saw image")
                content = requests[-1]["messages"][-1]["content"]
                self.assertIsInstance(content, list)
                self.assertEqual(content[0]["type"], "text")
                self.assertEqual(content[1]["type"], "image_url")
                self.assertTrue(content[1]["image_url"]["url"].startswith("data:image/png;base64,"))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=1)

    def test_default_repo_paths_support_whole_checkout_startup(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "hermes-agent").mkdir()
            (root / "cognee").mkdir()
            (root / "enterprise-agent-platform").mkdir()
            old_env = {key: os.environ.get(key) for key in ("ENTERPRISE_HERMES_REPO", "ENTERPRISE_COGNEE_REPO")}
            for key in old_env:
                os.environ.pop(key, None)
            try:
                root_config = PlatformConfig.from_env(root)
                platform_config = PlatformConfig.from_env(root / "enterprise-agent-platform")
                self.assertEqual(root_config.hermes_repo, root / "hermes-agent")
                self.assertEqual(root_config.cognee_repo, root / "cognee")
                self.assertEqual(platform_config.hermes_repo, root / "hermes-agent")
                self.assertEqual(platform_config.cognee_repo, root / "cognee")
            finally:
                for key, value in old_env.items():
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value

    def test_existing_admin_rows_migrate_to_admin_permission_group(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            conn = sqlite3.connect(tmp / "platform.db")
            try:
                conn.execute(
                    """
                    CREATE TABLE users (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        username TEXT NOT NULL UNIQUE,
                        display_name TEXT NOT NULL,
                        password_hash TEXT NOT NULL,
                        role TEXT NOT NULL DEFAULT 'member',
                        active INTEGER NOT NULL DEFAULT 1,
                        created_at INTEGER NOT NULL,
                        last_login_at INTEGER
                    )
                    """
                )
                conn.execute(
                    """
                    INSERT INTO users(username, display_name, password_hash, role, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    ("admin", "Administrator", "legacy", "admin", 1),
                )
                conn.commit()
            finally:
                conn.close()
            service = EnterpriseService(make_config(tmp), agent_client=RecordingAgent())
            try:
                user = service.get_user(1)
                self.assertEqual(user["role"], "admin")
                self.assertEqual(user["permission_group"], "admin")
                self.assertIn("system_settings", user["permissions"])
            finally:
                service.close()

    def test_channel_uses_shared_agent_session_and_passive_kb_suggestions(self):
        with tempfile.TemporaryDirectory() as td:
            agent = ProgressAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            _, user = service.authenticate("admin", "admin")
            service.add_knowledge_document(
                user,
                {
                    "title": "VPN Access Policy",
                    "summary": "Employees must use SSO for VPN.",
                    "content": "VPN access requires SSO, device posture checks, and quarterly access review.",
                    "source": "policy",
                },
            )
            alice = service.create_user(
                username="alice",
                password="alice-pass",
                display_name="Alice",
                permission_group="member",
                actor=user,
            )
            service.send_channel_message(user, 1, "VPN onboarding starts in the general channel.")
            service.send_channel_message(alice, 1, "I need device posture details before Friday.")

            result = service.send_channel_message(user, 1, "@agent What is the VPN access policy?")
            self.assertIsNone(result["agent_message"])
            self.assertEqual(result["user_message"]["content"], "@agent What is the VPN access policy?")
            service.wait_for_agent_idle("channel", "1")
            messages = service.list_messages(user, "channel", "1")
            agent_message = messages[-1]

            self.assertEqual(agent_message["username"], "Main Agent")
            self.assertEqual(agent.calls[-1]["session_id"], "enterprise-channel-1-main-agent")
            self.assertEqual(agent.calls[-1]["session_key"], "channel:1:main-agent")
            self.assertEqual(agent.calls[-1]["user_message"], "Administrator: What is the VPN access policy?")
            self.assertEqual(agent.calls[-1]["history"], [])
            self.assertIn("enterprise_kb_search", agent.calls[-1]["system_prompt"])
            self.assertTrue(agent.calls[-1]["metadata"]["knowledge_suggestions"])
            workspace = Path(agent.calls[-1]["metadata"]["workspace"]["path"])
            self.assertTrue(workspace.is_dir())
            self.assertEqual(agent.calls[-1]["metadata"]["workspace"]["scope"], "channel")
            self.assertEqual(workspace.name, "channel-1")
            work = agent_message["metadata"]["agent_work"]
            self.assertEqual(work["state"], "complete")
            self.assertEqual(work["run_id"], f"channel:1:{result['user_message']['id']}")
            hermes_activity = [item for item in work["activity"] if item.get("source") == "hermes"]
            self.assertEqual(len(hermes_activity), 1)
            self.assertEqual(hermes_activity[0]["line"], '🔍 enterprise_kb_search: "VPN access policy"')
            self.assertEqual(hermes_activity[0]["tool_status"], "completed")
            service.close()

    def test_channel_reuses_hermes_returned_session_after_rotation(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RotatingSessionAgent("compressed-channel-session")
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, user = service.authenticate("admin", "admin")
                service.send_channel_message(user, 1, "@agent first")
                service.wait_for_agent_idle("channel", "1")
                service.send_channel_message(user, 1, "@agent second")
                service.wait_for_agent_idle("channel", "1")

                self.assertEqual(agent.calls[0]["session_id"], "enterprise-channel-1-main-agent")
                self.assertEqual(agent.calls[1]["session_id"], "compressed-channel-session")
                self.assertEqual(agent.calls[0]["history"], [])
                self.assertEqual(agent.calls[1]["history"], [])
                self.assertEqual(agent.calls[1]["session_key"], "channel:1:main-agent")
            finally:
                service.close()

    def test_channel_agent_reply_exposes_streaming_content_while_running(self):
        with tempfile.TemporaryDirectory() as td:
            agent = StreamingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, user = service.authenticate("admin", "admin")
                result = service.send_channel_message(user, 1, "@agent stream a reply")
                self.assertIsNone(result["agent_message"])
                self.assertTrue(agent.first_delta.wait(timeout=1))

                status = service.agent_status(user, "channel", "1")
                self.assertEqual(status["state"], "replying")
                self.assertEqual(status["stream_message"]["content"], "Hello ")
                self.assertEqual(status["stream_message"]["username"], "Main Agent")

                agent.release.set()
                service.wait_for_agent_idle("channel", "1")
                messages = service.list_messages(user, "channel", "1")
                self.assertEqual(messages[-1]["content"], "Hello world")
                self.assertIsNone(service.agent_status(user, "channel", "1").get("stream_message"))
            finally:
                agent.release.set()
                service.close()

    def test_channel_agent_reply_clears_pre_tool_stream_on_substantive_tool(self):
        with tempfile.TemporaryDirectory() as td:
            agent = ToolBoundaryStreamingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, user = service.authenticate("admin", "admin")
                service.send_channel_message(user, 1, "@agent screenshot the browser")
                self.assertTrue(agent.first_delta.wait(timeout=1))
                status = service.agent_status(user, "channel", "1")
                self.assertEqual(status["stream_message"]["content"], "Now browser_vision call.\n\n")

                agent.release_tool.set()
                self.assertTrue(agent.tool_started.wait(timeout=1))
                status = service.agent_status(user, "channel", "1")
                self.assertIsNone(status.get("stream_message"))
                self.assertEqual(status["stream_messages"][-1]["content"], "Now browser_vision call.\n\n")
                self.assertFalse(status["stream_messages"][-1]["active"])
                self.assertEqual(status["activity"][-1]["tool"], "browser_vision")

                agent.release_final.set()
                service.wait_for_agent_idle("channel", "1")
                messages = service.list_messages(user, "channel", "1")
                self.assertEqual(messages[-1]["content"], "好了，这次成功了。")
            finally:
                agent.release_tool.set()
                agent.release_final.set()
                service.close()

    def test_channel_message_without_agent_mention_does_not_trigger_agent(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, user = service.authenticate("admin", "admin")

                result = service.send_channel_message(user, 1, "normal channel message")
                status = service.wait_for_agent_idle("channel", "1")
                messages = service.list_messages(user, "channel", "1")

                self.assertEqual(result["user_message"]["content"], "normal channel message")
                self.assertIsNone(result["agent_message"])
                self.assertEqual(status["state"], "idle")
                self.assertEqual(messages[-1]["content"], "normal channel message")
                self.assertEqual(agent.calls, [])
            finally:
                service.close()

    def test_telegram_private_message_routes_through_platform_private_agent(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            bot = FakeTelegramBot()
            gateway = TelegramGateway(service, bot=bot, autostart=False)
            try:
                _, user = service.authenticate("admin", "admin")
                service.update_telegram_private_config(user, {"telegram_user_id": "12345", "telegram_username": "alice_tg"})
                result = gateway.process_update(
                    {
                        "update_id": 1,
                        "message": {
                            "message_id": 10,
                            "chat": {"id": 12345, "type": "private"},
                            "from": {"id": 12345, "username": "alice_tg", "first_name": "Alice"},
                            "text": "private request",
                        },
                    }
                )

                self.assertTrue(result["ok"])
                self.assertEqual(result["scope_type"], "private")
                self.assertEqual(len(agent.calls), 1)
                self.assertEqual(agent.calls[0]["session_key"], f"private:{user['id']}")
                self.assertEqual(agent.calls[0]["metadata"]["workspace"]["scope"], "private")
                self.assertEqual(
                    agent.calls[0]["metadata"]["workspace"]["path"],
                    agent.calls[0]["metadata"]["container"]["workspace_path"],
                )
                self.assertEqual(result["scope_id"], str(user["id"]))
                self.assertEqual(len(bot.sent), 1)
                self.assertEqual(bot.sent[0]["chat_id"], 12345)
                self.assertEqual(bot.sent[0]["reply_to_message_id"], 10)
                self.assertIn("agent response to private request", bot.sent[0]["text"])
                identity = service.db.query_one(
                    "SELECT user_id FROM external_identities WHERE provider = 'telegram' AND external_id = '12345'"
                )
                self.assertIsNotNone(identity)
            finally:
                service.close()

    def test_telegram_document_is_stored_as_platform_attachment(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            bot = FakeTelegramBot()
            bot.files["file-1"] = ("documents/report.txt", b"hello from telegram")
            gateway = TelegramGateway(service, bot=bot, autostart=False)
            try:
                _, user = service.authenticate("admin", "admin")
                service.update_telegram_private_config(user, {"telegram_user_id": "45678", "telegram_username": "doc_tg"})
                result = gateway.process_update(
                    {
                        "update_id": 4,
                        "message": {
                            "message_id": 40,
                            "chat": {"id": 45678, "type": "private"},
                            "from": {"id": 45678, "username": "doc_tg", "first_name": "Doc"},
                            "caption": "please inspect",
                            "document": {
                                "file_id": "file-1",
                                "file_unique_id": "unique-1",
                                "file_name": "report.txt",
                                "mime_type": "text/plain",
                                "file_size": 19,
                            },
                        },
                    }
                )

                self.assertEqual(result["attachment_count"], 1)
                self.assertEqual(len(agent.calls), 1)
                self.assertEqual(agent.calls[0]["attachments"][0]["filename"], "report.txt")
                self.assertEqual(agent.calls[0]["attachments"][0]["mime_type"], "text/plain")
                messages = service._messages_for_scope("private", result["scope_id"])
                self.assertEqual(messages[0]["attachments"][0]["filename"], "report.txt")
            finally:
                service.close()

    def test_telegram_private_agent_generated_attachment_is_sent_back(self):
        with tempfile.TemporaryDirectory() as td, tempfile.TemporaryDirectory() as media_td:
            media_path = Path(media_td) / "result.csv"
            media_path.write_text("a,b\n1,2\n", encoding="utf-8")
            agent = MediaReturningAgent(media_path)
            previous_roots = os.environ.get("ENTERPRISE_MEDIA_ROOTS")
            os.environ["ENTERPRISE_MEDIA_ROOTS"] = media_td
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            bot = FakeTelegramBot()
            gateway = TelegramGateway(service, bot=bot, autostart=False)
            try:
                _, user = service.authenticate("admin", "admin")
                service.update_telegram_private_config(user, {"telegram_user_id": "56789", "telegram_username": "media_tg"})
                result = gateway.process_update(
                    {
                        "update_id": 5,
                        "message": {
                            "message_id": 50,
                            "chat": {"id": 56789, "type": "private"},
                            "from": {"id": 56789, "username": "media_tg", "first_name": "Media"},
                            "text": "make a csv",
                        },
                    }
                )

                self.assertIsNotNone(result["agent_message_id"])
                self.assertEqual(len(bot.sent), 1)
                self.assertEqual(bot.sent[0]["text"], "created file")
                self.assertEqual(len(bot.files_sent), 1)
                self.assertEqual(bot.files_sent[0]["filename"], "result.csv")
                self.assertEqual(bot.files_sent[0]["content_type"], "text/csv")
            finally:
                service.close()
                if previous_roots is None:
                    os.environ.pop("ENTERPRISE_MEDIA_ROOTS", None)
                else:
                    os.environ["ENTERPRISE_MEDIA_ROOTS"] = previous_roots

    def test_telegram_unlinked_private_message_replies_with_binding_hint(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            bot = FakeTelegramBot()
            gateway = TelegramGateway(service, bot=bot, autostart=False)
            try:
                result = gateway.process_update(
                    {
                        "update_id": 6,
                        "message": {
                            "message_id": 60,
                            "chat": {"id": 67890, "type": "private"},
                            "from": {"id": 67890, "username": "unlinked_tg", "first_name": "Unlinked"},
                            "text": "hello",
                        },
                    }
                )

                self.assertEqual(result["ignored"], "unlinked telegram user")
                self.assertEqual(agent.calls, [])
                self.assertEqual(len(bot.sent), 1)
                self.assertIn("67890", bot.sent[0]["text"])
            finally:
                service.close()

    def test_telegram_group_messages_are_ignored_without_platform_channel_records(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            bot = FakeTelegramBot()
            gateway = TelegramGateway(service, bot=bot, autostart=False)
            try:
                result = gateway.process_update(
                    {
                        "update_id": 3,
                        "message": {
                            "message_id": 30,
                            "chat": {"id": -1002, "type": "group", "title": "General"},
                            "from": {"id": 34567, "username": "carol_tg", "first_name": "Carol"},
                            "text": "normal group note",
                        },
                    }
                )

                self.assertEqual(result["ignored"], "non-private chat")
                self.assertEqual(agent.calls, [])
                self.assertEqual(bot.sent, [])
                self.assertEqual(service._messages_for_scope("channel", "1"), [])
            finally:
                service.close()

    def test_telegram_settings_and_per_user_link_conflict(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                member = service.create_user(
                    username="tg-member",
                    password="member-password",
                    display_name="Telegram Member",
                    actor=admin,
                    permission_group="member",
                )

                config = service.update_telegram_admin_config(
                    admin,
                    {
                        "enabled": True,
                        "polling": False,
                        "bot_username": "enterprise_private_bot",
                        "bot_token": "123456:token",
                        "webhook_secret": "secret-token",
                    },
                )
                self.assertTrue(config["config"]["enabled"])
                self.assertFalse(config["config"]["polling"])
                self.assertTrue(config["config"]["bot_token_configured"])
                self.assertIn("/api/telegram/webhook/secret-token", config["config"]["webhook_url"])

                mine = service.update_telegram_private_config(
                    admin,
                    {"telegram_user_id": "123456789", "telegram_username": "admin_tg"},
                )
                self.assertEqual(mine["link"]["telegram_user_id"], "123456789")
                with self.assertRaises(ServiceError) as ctx:
                    service.update_telegram_private_config(member, {"telegram_user_id": "123456789"})
                self.assertEqual(ctx.exception.status, 409)
            finally:
                service.close()

    def test_channel_image_attachment_is_stored_and_passed_to_agent(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, user = service.authenticate("admin", "admin")

                result = service.send_channel_message(
                    user,
                    1,
                    "@agent inspect this",
                    [UploadedFile("diagram.png", "image/png", b"\x89PNG\r\n\x1a\nimage")],
                )
                self.assertEqual(result["user_message"]["attachments"][0]["filename"], "diagram.png")
                self.assertTrue(result["user_message"]["attachments"][0]["is_image"])
                service.wait_for_agent_idle("channel", "1")

                call = agent.calls[-1]
                self.assertEqual(len(call["attachments"]), 1)
                self.assertTrue(Path(call["attachments"][0]["local_path"]).exists())
                self.assertIn("[User attached image: diagram.png", call["user_message"])
                messages = service.list_messages(user, "channel", "1")
                self.assertEqual(messages[0]["attachments"][0]["download_url"], f"/api/attachments/{messages[0]['attachments'][0]['id']}?download=1")
            finally:
                service.close()

    def test_channel_message_returns_before_agent_finishes_and_reports_reply_target(self):
        with tempfile.TemporaryDirectory() as td:
            agent = BlockingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, user = service.authenticate("admin", "admin")
                member = service.create_user(
                    username="alice",
                    password="alice-pass",
                    display_name="Alice",
                    permission_group="member",
                    actor=user,
                )

                started_at = time.monotonic()
                result = service.send_channel_message(user, 1, "@agent slow question")
                elapsed = time.monotonic() - started_at

                self.assertLess(elapsed, 0.5)
                self.assertEqual(result["user_message"]["content"], "@agent slow question")
                self.assertIsNone(result["agent_message"])
                self.assertTrue(agent.started.wait(timeout=1))
                status = service.agent_status(user, "channel", "1")
                self.assertEqual(status["state"], "replying")
                self.assertEqual(status["replying_to"]["username"], "Administrator")
                self.assertEqual(status["current_step"], "等待 Hermes Agent 运行过程")
                self.assertIn("replying", [item["stage"] for item in status["activity"]])
                self.assertEqual(service.list_messages(user, "channel", "1")[-1]["content"], "@agent slow question")

                second_started_at = time.monotonic()
                second = service.send_channel_message(member, 1, "second normal message")
                self.assertLess(time.monotonic() - second_started_at, 0.5)
                self.assertEqual(second["user_message"]["content"], "second normal message")
                status = service.agent_status(user, "channel", "1")
                self.assertEqual(status["state"], "replying")
                self.assertEqual(status["replying_to"]["username"], "Administrator")
                self.assertEqual(status["queued_count"], 0)
                self.assertEqual(service.list_messages(user, "channel", "1")[-1]["content"], "second normal message")

                third = service.send_channel_message(member, 1, "@agent second question")
                self.assertEqual(third["user_message"]["content"], "@agent second question")
                status = service.agent_status(user, "channel", "1")
                self.assertEqual(status["queued_count"], 1)
                self.assertEqual(service.list_messages(user, "channel", "1")[-1]["content"], "@agent second question")

                agent.release.set()
                status = service.wait_for_agent_idle("channel", "1")
                self.assertEqual(status["state"], "idle")
                self.assertEqual([call["user_message"] for call in agent.calls], ["Administrator: slow question", "Alice: second question"])
                final_message = service.list_messages(user, "channel", "1")[-1]
                self.assertEqual(final_message["content"], "agent response to Alice: second question")
                self.assertEqual(final_message["metadata"]["agent_work"]["state"], "complete")
                self.assertTrue(final_message["metadata"]["agent_work"]["activity"][-1]["line"].startswith("✅"))
            finally:
                agent.release.set()
                service.close()

    def test_channel_mention_targets_include_agent_and_active_users(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                service.create_user(
                    username="alice",
                    password="alice-pass",
                    display_name="Alice",
                    position="Designer",
                    permission_group="member",
                    actor=admin,
                )
                _, alice = service.authenticate("alice", "alice-pass")

                targets = service.mention_targets(alice)
                self.assertEqual(targets[0]["handle"], "agent")
                self.assertIn(
                    {"kind": "user", "id": alice["id"], "handle": "alice", "label": "Alice", "description": "Designer"},
                    targets,
                )
            finally:
                service.close()

    def test_channel_typing_presence_excludes_current_user(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                member = service.create_user(
                    username="alice",
                    password="alice-pass",
                    display_name="Alice",
                    permission_group="member",
                    actor=admin,
                )

                self.assertEqual(service.update_typing(member, "channel", "1", True)["typing"], [])
                typing = service.typing_users(admin, "channel", "1")
                self.assertEqual(typing[0]["username"], "Alice")
                self.assertEqual(service.update_typing(member, "channel", "1", False)["typing"], [])
                self.assertEqual(service.typing_users(admin, "channel", "1"), [])
            finally:
                service.close()

    def test_private_agent_creates_local_workspace_and_independent_session(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            _, user = service.authenticate("admin", "admin")

            result = service.send_private_message(user, "Create a project plan")
            self.assertIsNone(result["agent_message"])
            service.wait_for_agent_idle("private", str(user["id"]))

            container = service.private_status(user)["container"]
            self.assertEqual(container["backend"], "local")
            self.assertTrue(Path(container["workspace_path"]).exists())
            self.assertEqual(agent.calls[-1]["session_id"], "enterprise-private-u1")
            self.assertEqual(agent.calls[-1]["session_key"], "private:1")
            service.close()

    def test_private_agent_accepts_file_only_message_and_passes_file_path(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, user = service.authenticate("admin", "admin")

                result = service.send_private_message(
                    user,
                    "",
                    [UploadedFile("brief.txt", "text/plain", b"project brief")],
                )
                self.assertEqual(result["user_message"]["content"], "")
                self.assertEqual(result["user_message"]["attachments"][0]["filename"], "brief.txt")
                service.wait_for_agent_idle("private", str(user["id"]))

                call = agent.calls[-1]
                self.assertIn("brief.txt", call["user_message"])
                self.assertIn("local path:", call["user_message"])
                self.assertTrue(Path(call["attachments"][0]["local_path"]).exists())
            finally:
                service.close()

    def test_agent_prompt_uses_ubitech_identity_and_includes_user_position(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, admin = service.authenticate("admin", "admin")
                service.create_user(
                    username="alice",
                    password="alice-pass",
                    display_name="Alice",
                    position="Product Manager",
                    permission_group="member",
                    actor=admin,
                )
                _, alice = service.authenticate("alice", "alice-pass")

                service.send_private_message(alice, "draft a roadmap")
                service.wait_for_agent_idle("private", str(alice["id"]))
                private_prompt = agent.calls[-1]["system_prompt"]
                self.assertIn("你是 ubitech 的企业级 Agent", private_prompt)
                self.assertIn("不要提及底层框架", private_prompt)
                self.assertIn("当前用户: Alice (@alice)，职位: Product Manager", private_prompt)
                self.assertNotIn("Hermes", private_prompt)

                service.send_channel_message(alice, 1, "@agent summarize status")
                service.wait_for_agent_idle("channel", "1")
                self.assertEqual(agent.calls[-1]["user_message"], "Alice，职位: Product Manager: summarize status")
            finally:
                service.close()

    def test_agent_media_tags_are_saved_as_returned_attachments(self):
        with tempfile.TemporaryDirectory() as td, tempfile.TemporaryDirectory() as media_td:
            tmp = Path(td)
            # The broad system temp dir is no longer an implicit media root (it is
            # shared host state, so trusting it would let a prompt-injected agent
            # exfiltrate arbitrary readable temp files via MEDIA: tags). An
            # operator allow-lists this generated-media directory explicitly via
            # ENTERPRISE_MEDIA_ROOTS, the documented escape hatch alongside the
            # managed Hermes scratch dirs that are trusted by default.
            media_path = Path(media_td) / "result.csv"
            media_path.write_text("a,b\n1,2\n", encoding="utf-8")
            agent = MediaReturningAgent(media_path)
            previous_roots = os.environ.get("ENTERPRISE_MEDIA_ROOTS")
            os.environ["ENTERPRISE_MEDIA_ROOTS"] = media_td
            service = EnterpriseService(make_config(tmp), agent_client=agent)
            try:
                _, user = service.authenticate("admin", "admin")

                service.send_private_message(user, "make a csv")
                service.wait_for_agent_idle("private", str(user["id"]))
                agent_message = service.list_messages(user, "private", str(user["id"]))[-1]

                self.assertEqual(agent_message["content"], "created file")
                self.assertEqual(agent_message["attachments"][0]["filename"], "result.csv")
                attachment, stored_path = service.get_attachment_file(user, agent_message["attachments"][0]["id"])
                self.assertEqual(attachment["mime_type"], "text/csv")
                self.assertEqual(stored_path.read_text(encoding="utf-8"), "a,b\n1,2\n")
            finally:
                service.close()
                if previous_roots is None:
                    os.environ.pop("ENTERPRISE_MEDIA_ROOTS", None)
                else:
                    os.environ["ENTERPRISE_MEDIA_ROOTS"] = previous_roots

    def test_agent_media_tags_outside_allowed_roots_are_refused(self):
        # A path that exists but lives outside the temp dir and the workspace
        # tree (here: next to the test file in the repo) must never be read and
        # surfaced as an attachment, even though the file is present.
        probe = Path(__file__).resolve().parent / "_media_denied_probe.csv"
        if str(probe).startswith(tempfile.gettempdir()):
            self.skipTest("repository tree is under the temp dir; cannot test refusal deterministically")
        probe.write_text("secret,value\n1,2\n", encoding="utf-8")
        try:
            with tempfile.TemporaryDirectory() as td:
                tmp = Path(td)
                agent = MediaReturningAgent(probe)
                service = EnterpriseService(make_config(tmp), agent_client=agent)
                try:
                    _, user = service.authenticate("admin", "admin")
                    service.send_private_message(user, "exfiltrate please")
                    service.wait_for_agent_idle("private", str(user["id"]))
                    agent_message = service.list_messages(user, "private", str(user["id"]))[-1]
                    self.assertEqual(agent_message["attachments"], [])
                    self.assertIn("outside the allowed media directories", agent_message["content"])
                finally:
                    service.close()
        finally:
            probe.unlink(missing_ok=True)

    def test_agent_media_cannot_exfiltrate_data_dir_secrets(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            # A secret-like file under the data dir (which the test harness puts
            # under the temp dir) must be refused even though the temp dir is an
            # allowed media root, because it is not in a safe data subtree.
            secret = tmp / "secret-export.txt"
            secret.write_text("session_secret=topsecret\n", encoding="utf-8")
            agent = MediaReturningAgent(secret)
            service = EnterpriseService(make_config(tmp), agent_client=agent)
            try:
                _, user = service.authenticate("admin", "admin")
                service.send_private_message(user, "exfiltrate secrets")
                service.wait_for_agent_idle("private", str(user["id"]))
                msg = service.list_messages(user, "private", str(user["id"]))[-1]
                self.assertEqual(msg["attachments"], [])
                self.assertIn("outside the allowed media directories", msg["content"])
            finally:
                service.close()

    def test_multiple_users_share_channel_main_agent_without_model_key_injection(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            _, admin = service.authenticate("admin", "admin")
            member = service.create_user(
                username="alice",
                password="alice-pass",
                display_name="Alice",
                role="member",
                actor=admin,
            )

            service.send_channel_message(admin, 1, "@agent admin asks")
            service.send_channel_message(member, 1, "@agent member asks")
            service.wait_for_agent_idle("channel", "1")
            channel_sessions = [call["session_id"] for call in agent.calls[-2:]]
            self.assertEqual(channel_sessions, ["enterprise-channel-1-main-agent", "enterprise-channel-1-main-agent"])

            service.send_private_message(member, "private task")
            service.wait_for_agent_idle("private", str(member["id"]))
            self.assertEqual(service.private_status(member)["container"]["session_id"], "enterprise-private-u2")
            self.assertEqual(service.model_secret_env(), {})
            service.close()

    def test_private_reuses_hermes_returned_session_after_rotation(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RotatingSessionAgent("compressed-private-session")
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, user = service.authenticate("admin", "admin")
                service.send_private_message(user, "first")
                service.wait_for_agent_idle("private", str(user["id"]))
                service.send_private_message(user, "second")
                service.wait_for_agent_idle("private", str(user["id"]))

                self.assertEqual(agent.calls[0]["session_id"], "enterprise-private-u1")
                self.assertEqual(agent.calls[1]["session_id"], "compressed-private-session")
                self.assertEqual(agent.calls[0]["history"], [])
                self.assertEqual(agent.calls[1]["history"], [])
                self.assertEqual(service.private_status(user)["container"]["session_id"], "compressed-private-session")
            finally:
                service.close()

    def test_admin_can_delete_channel_messages_by_id_before_time_and_clear(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                member = service.create_user(
                    username="alice",
                    password="alice-pass",
                    display_name="Alice",
                    permission_group="member",
                    actor=admin,
                )

                first = service.send_channel_message(admin, 1, "first")["user_message"]
                second = service.send_channel_message(member, 1, "second")["user_message"]
                third = service.send_channel_message(admin, 1, "third")["user_message"]
                service.db.execute("UPDATE messages SET created_at = ? WHERE id = ?", (1000, first["id"]))
                service.db.execute("UPDATE messages SET created_at = ? WHERE id = ?", (2000, second["id"]))
                service.db.execute("UPDATE messages SET created_at = ? WHERE id = ?", (3000, third["id"]))

                audit = service.audit_channel_messages(admin, 1)
                self.assertEqual(audit["total"], 3)
                self.assertEqual([message["content"] for message in audit["messages"]], ["first", "second", "third"])

                with self.assertRaises(ServiceError) as member_error:
                    service.delete_channel_message(member, 1, first["id"])
                self.assertEqual(member_error.exception.status, 403)

                deleted = service.delete_channel_message(admin, 1, second["id"])
                self.assertEqual(deleted["deleted"], 1)
                self.assertEqual(deleted["message"]["content"], "second")
                self.assertEqual([message["content"] for message in service.audit_channel_messages(admin, 1)["messages"]], ["first", "third"])

                before = service.delete_channel_messages_before(admin, 1, 2500)
                self.assertEqual(before["deleted"], 1)
                self.assertEqual([message["content"] for message in service.audit_channel_messages(admin, 1)["messages"]], ["third"])

                cleared = service.clear_channel_messages(admin, 1)
                self.assertEqual(cleared["deleted"], 1)
                self.assertEqual(service.audit_channel_messages(admin, 1)["total"], 0)
            finally:
                service.close()

    def test_admin_can_audit_all_private_agent_conversations(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, admin = service.authenticate("admin", "admin")
                service.create_user(
                    username="alice",
                    password="alice-pass",
                    display_name="Alice",
                    permission_group="member",
                    actor=admin,
                )
                _, alice = service.authenticate("alice", "alice-pass")

                service.send_private_message(alice, "alice private task")
                service.wait_for_agent_idle("private", str(alice["id"]))
                service.send_private_message(admin, "admin private task")
                service.wait_for_agent_idle("private", str(admin["id"]))

                conversations = service.list_private_conversation_audits(admin)
                by_user = {item["username"]: item for item in conversations}
                self.assertEqual(by_user["alice"]["message_count"], 2)
                self.assertEqual(by_user["alice"]["user_message_count"], 1)
                self.assertEqual(by_user["alice"]["agent_message_count"], 1)
                self.assertEqual(by_user["admin"]["message_count"], 2)

                audit = service.audit_private_messages(admin, alice["id"])
                self.assertEqual(audit["subject"]["username"], "alice")
                self.assertEqual(audit["total"], 2)
                self.assertEqual(audit["messages"][0]["content"], "alice private task")
                self.assertEqual(audit["messages"][1]["content"], "agent response to alice private task")

                with self.assertRaises(ServiceError) as member_error:
                    service.audit_private_messages(alice, admin["id"])
                self.assertEqual(member_error.exception.status, 403)

                service.deactivate_user(admin, alice["id"])
                retained = {item["username"]: item for item in service.list_private_conversation_audits(admin)}
                self.assertFalse(retained["alice"]["active"])
                self.assertEqual(retained["alice"]["message_count"], 2)
                self.assertEqual(service.audit_private_messages(admin, alice["id"])["total"], 2)
            finally:
                service.close()

    def test_admin_can_delete_private_agent_messages_by_id_before_time_and_clear(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                service.create_user(
                    username="alice",
                    password="alice-pass",
                    display_name="Alice",
                    permission_group="member",
                    actor=admin,
                )
                _, alice = service.authenticate("alice", "alice-pass")

                first = service.send_private_message(alice, "first")["user_message"]
                service.wait_for_agent_idle("private", str(alice["id"]))
                second = service.send_private_message(alice, "second")["user_message"]
                service.wait_for_agent_idle("private", str(alice["id"]))
                third = service.send_private_message(alice, "third")["user_message"]
                service.wait_for_agent_idle("private", str(alice["id"]))

                service.db.execute("UPDATE messages SET created_at = ? WHERE id = ?", (1000, first["id"]))
                service.db.execute("UPDATE messages SET created_at = ? WHERE content = ?", (1100, "agent response to first"))
                service.db.execute("UPDATE messages SET created_at = ? WHERE id = ?", (2000, second["id"]))
                service.db.execute("UPDATE messages SET created_at = ? WHERE content = ?", (2100, "agent response to second"))
                service.db.execute("UPDATE messages SET created_at = ? WHERE id = ?", (3000, third["id"]))
                service.db.execute("UPDATE messages SET created_at = ? WHERE content = ?", (3100, "agent response to third"))

                audit = service.audit_private_messages(admin, alice["id"])
                self.assertEqual(audit["total"], 6)
                self.assertEqual(
                    [message["content"] for message in audit["messages"]],
                    ["first", "agent response to first", "second", "agent response to second", "third", "agent response to third"],
                )

                with self.assertRaises(ServiceError) as member_error:
                    service.delete_private_message(alice, alice["id"], first["id"])
                self.assertEqual(member_error.exception.status, 403)

                deleted = service.delete_private_message(admin, alice["id"], second["id"])
                self.assertEqual(deleted["deleted"], 1)
                self.assertEqual(deleted["message"]["content"], "second")
                self.assertEqual(
                    [message["content"] for message in service.audit_private_messages(admin, alice["id"])["messages"]],
                    ["first", "agent response to first", "agent response to second", "third", "agent response to third"],
                )

                with self.assertRaises(ServiceError) as wrong_scope_error:
                    service.delete_private_message(admin, admin["id"], third["id"])
                self.assertEqual(wrong_scope_error.exception.status, 404)

                before = service.delete_private_messages_before(admin, alice["id"], 2500)
                self.assertEqual(before["deleted"], 3)
                self.assertEqual(
                    [message["content"] for message in service.audit_private_messages(admin, alice["id"])["messages"]],
                    ["third", "agent response to third"],
                )

                cleared = service.clear_private_messages(admin, alice["id"])
                self.assertEqual(cleared["deleted"], 2)
                self.assertEqual(service.audit_private_messages(admin, alice["id"])["total"], 0)
            finally:
                service.close()

    def test_admin_can_manage_account_permissions_and_model_policy(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent(), hermes_bridge=FakeHermesBridge())
            try:
                _, admin = service.authenticate("admin", "admin")
                user = service.create_user(
                    username="alice",
                    password="alice-pass",
                    display_name="Alice",
                    position="Analyst",
                    permission_group="viewer",
                    model_name="gpt-5.4",
                    thinking_depth="low",
                    actor=admin,
                )

                self.assertEqual(user["position"], "Analyst")
                self.assertEqual(user["permission_group"], "viewer")
                self.assertEqual(user["role"], "member")
                self.assertEqual(user["model_name"], "gpt-5.4")
                self.assertEqual(user["thinking_depth"], "low")
                self.assertNotIn("chat", user["permissions"])
                groups = {item["id"] for item in service.list_permission_groups(admin)}
                self.assertIn("admin", groups)
                self.assertIn("manager", groups)

                updated = service.update_user(
                    admin,
                    user["id"],
                    {
                        "position": "Engineering Manager",
                        "permission_group": "manager",
                        "model_name": "gpt-5.4",
                        "thinking_depth": "high",
                    },
                )
                self.assertEqual(updated["position"], "Engineering Manager")
                self.assertEqual(updated["permission_group"], "manager")
                self.assertIn("manage_knowledge", updated["permissions"])
                self.assertEqual(updated["model_name"], "gpt-5.4")
                self.assertEqual(updated["thinking_depth"], "high")

                with self.assertRaises(ServiceError) as model_error:
                    service.update_user(admin, user["id"], {"model_name": "not-from-hermes"})
                self.assertEqual(model_error.exception.status, 400)

                _, member_actor = service.authenticate("alice", "alice-pass")
                with self.assertRaises(ServiceError) as list_error:
                    service.list_users(member_actor)
                self.assertEqual(list_error.exception.status, 403)
                with self.assertRaises(ServiceError) as update_error:
                    service.update_user(member_actor, admin["id"], {"position": "Owner"})
                self.assertEqual(update_error.exception.status, 403)
            finally:
                service.close()

    def test_member_can_update_own_profile_and_change_password(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                member = service.create_user(
                    username="alice",
                    password="alice-pass",
                    display_name="Alice",
                    position="Analyst",
                    permission_group="member",
                    actor=admin,
                )
                old_token, member_actor = service.authenticate("alice", "alice-pass")

                updated = service.update_current_user(
                    member_actor,
                    {
                        "display_name": "Alice B.",
                        "position": "Engineering",
                        "permission_group": "admin",
                        "active": False,
                    },
                )
                self.assertEqual(updated["display_name"], "Alice B.")
                self.assertEqual(updated["position"], "Engineering")
                self.assertEqual(updated["permission_group"], "member")
                self.assertTrue(updated["active"])

                with self.assertRaises(ServiceError) as wrong_password:
                    service.change_current_user_password(
                        member_actor,
                        {"current_password": "wrong-pass", "new_password": "new-alice-password"},
                    )
                self.assertEqual(wrong_password.exception.status, 400)
                self.assertIsNotNone(service.user_from_token(old_token))

                new_token, changed = service.change_current_user_password(
                    member_actor,
                    {"current_password": "alice-pass", "new_password": "new-alice-password"},
                )
                self.assertEqual(changed["id"], member["id"])
                self.assertIsNone(service.user_from_token(old_token))
                self.assertIsNotNone(service.user_from_token(new_token))
                with self.assertRaises(ServiceError) as old_login:
                    service.authenticate("alice", "alice-pass")
                self.assertEqual(old_login.exception.status, 401)
                _, fresh = service.authenticate("alice", "new-alice-password")
                self.assertEqual(fresh["display_name"], "Alice B.")
            finally:
                service.close()

    def test_account_model_and_thinking_depth_are_used_for_agent_calls(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent, hermes_bridge=FakeHermesBridge())
            try:
                _, admin = service.authenticate("admin", "admin")
                service.create_user(
                    username="bob",
                    password="bob-pass",
                    display_name="Bob",
                    permission_group="member",
                    model_name="gpt-5.4",
                    thinking_depth="xhigh",
                    actor=admin,
                )
                _, bob = service.authenticate("bob", "bob-pass")

                result = service.send_private_message(bob, "draft a plan")
                self.assertIsNone(result["agent_message"])
                service.wait_for_agent_idle("private", str(bob["id"]))
                agent_message = service.list_messages(bob, "private", str(bob["id"]))[-1]

                self.assertEqual(agent.calls[-1]["model"], "gpt-5.4")
                self.assertEqual(agent.calls[-1]["thinking_depth"], "xhigh")
                self.assertEqual(agent.calls[-1]["reasoning_config"], {"enabled": True, "effort": "xhigh"})
                self.assertEqual(agent_message["metadata"]["generation"]["model"], "gpt-5.4")
                self.assertEqual(agent_message["metadata"]["generation"]["thinking_depth"], "xhigh")
            finally:
                service.close()

    def test_generation_falls_back_when_system_model_is_stale(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent, hermes_bridge=FakeHermesBridge())
            try:
                _, admin = service.authenticate("admin", "admin")
                service.set_setting(runtime_module.HERMES_SETTING_MODEL, "gpt-5.3-codex")

                result = service.send_private_message(admin, "draft a plan")
                self.assertIsNone(result["agent_message"])
                service.wait_for_agent_idle("private", str(admin["id"]))
                agent_message = service.list_messages(admin, "private", str(admin["id"]))[-1]

                self.assertEqual(agent.calls[-1]["model"], "gpt-5.5")
                self.assertEqual(agent_message["metadata"]["generation"]["model"], "gpt-5.5")
            finally:
                service.close()

    def test_admin_can_update_own_model_without_invalidating_session(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent(), hermes_bridge=FakeHermesBridge())
            try:
                token, admin = service.authenticate("admin", "admin")
                updated = service.update_user(
                    admin,
                    admin["id"],
                    {
                        "display_name": admin["display_name"],
                        "position": admin.get("position", ""),
                        "permission_group": "admin",
                        "model_name": "gpt-5.4",
                        "thinking_depth": admin.get("thinking_depth", "medium"),
                        "active": True,
                    },
                )
                self.assertEqual(updated["model_name"], "gpt-5.4")
                self.assertIsNotNone(service.user_from_token(token))
            finally:
                service.close()

    def test_viewer_permission_group_cannot_send_messages(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                service.create_user(
                    username="viewer",
                    password="viewer-pass",
                    display_name="Viewer",
                    permission_group="viewer",
                    actor=admin,
                )
                _, viewer = service.authenticate("viewer", "viewer-pass")

                with self.assertRaises(ServiceError) as send_error:
                    service.send_channel_message(viewer, 1, "hello")
                self.assertEqual(send_error.exception.status, 403)
                with self.assertRaises(ServiceError) as private_error:
                    service.send_private_message(viewer, "hello")
                self.assertEqual(private_error.exception.status, 403)
            finally:
                service.close()

    def test_oauth_secret_keys_are_admin_configurable_but_not_model_env(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                keys = {item["key"] for item in service.list_secrets(admin)}

                self.assertIn("CODEX_OAUTH_ACCESS_TOKEN", keys)
                self.assertIn("CODEX_OAUTH_REFRESH_TOKEN", keys)
                self.assertIn("GROK_OAUTH_ACCESS_TOKEN", keys)
                self.assertIn("GROK_OAUTH_REFRESH_TOKEN", keys)
                self.assertIn("GROK_OAUTH_ID_TOKEN", keys)
                self.assertNotIn("OPENAI_API_KEY", keys)
                self.assertNotIn("XAI_API_KEY", keys)
                self.assertNotIn("XAI_OAUTH_REFRESH_TOKEN", keys)

                service.set_secret(admin, "CODEX_OAUTH_ACCESS_TOKEN", "codex-access")
                self.assertNotIn("CODEX_OAUTH_ACCESS_TOKEN", service.model_secret_env())
                with self.assertRaises(ServiceError):
                    service.set_secret(admin, "OPENAI_API_KEY", "sk-test-value")
            finally:
                service.close()

    def test_agent_tool_token_protects_knowledge_endpoints(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            _, user = service.authenticate("admin", "admin")
            doc = service.add_knowledge_document(user, {"title": "Runbook", "content": "Restart service alpha."})

            self.assertFalse(service.validate_agent_tool_token("wrong"))
            self.assertTrue(service.validate_agent_tool_token("agent-token"))
            self.assertEqual(service.get_knowledge_document(doc["id"])["title"], "Runbook")
            service.close()

    def test_platform_prepares_managed_hermes_and_cognee_without_manual_install(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_fake_hermes_repo(tmp / "hermes-agent")
            make_fake_cognee_repo(tmp / "cognee")
            make_fake_firecrawl_repo(tmp / "firecrawl")
            runner = RecordingCommandRunner()
            config = make_config(tmp)
            service = EnterpriseService(config, agent_client=RecordingAgent(), runtime_command_runner=runner)
            try:
                hermes_home = service.config.managed_hermes_home
                self.assertTrue((hermes_home / "plugins" / "enterprise_kb" / "plugin.yaml").exists())
                config_text = (hermes_home / "config.yaml").read_text(encoding="utf-8")
                env_text = (hermes_home / ".env").read_text(encoding="utf-8")

                self.assertIn("enterprise-kb", config_text)
                self.assertIn("backend: firecrawl", config_text)
                self.assertIn("cloud_provider: local", config_text)
                self.assertIn("managed_persistence: true", config_text)
                self.assertIn('API_SERVER_ENABLED="true"', env_text)
                self.assertIn('ENTERPRISE_AGENT_TOOL_TOKEN="agent-token"', env_text)
                self.assertIn("API_SERVER_KEY=", env_text)
                self.assertIn(f'CAMOFOX_URL="{config.camofox_url}"', env_text)
                self.assertIn(f'FIRECRAWL_API_URL="{config.firecrawl_api_url}"', env_text)

                _, admin = service.authenticate("admin", "admin")
                status = service.runtime_status(admin)
                self.assertEqual(status["hermes"]["managed"], True)
                self.assertEqual(status["hermes"]["install_state"], "installed")
                self.assertEqual(status["cognee"]["managed"], True)
                self.assertEqual(status["cognee"]["state"], "prepared")
                self.assertEqual(status["camofox"]["managed"], True)
                self.assertEqual(status["camofox"]["url"], config.camofox_url)
                self.assertEqual(status["firecrawl"]["managed"], True)
                self.assertEqual(status["firecrawl"]["url"], config.firecrawl_api_url)
                # Managed Firecrawl secrets are written under the platform data
                # dir (firecrawl_runtime_dir) rather than into the submodule tree,
                # so runtime secrets never land in the repo working copy.
                firecrawl_env_text = (config.firecrawl_runtime_dir / ".env").read_text(encoding="utf-8")
                self.assertIn('PORT="13002"', firecrawl_env_text)
                self.assertIn('HOST="0.0.0.0"', firecrawl_env_text)
                self.assertIn('USE_DB_AUTHENTICATION="false"', firecrawl_env_text)
                self.assertIn('BULL_AUTH_KEY=', firecrawl_env_text)
                install_commands = [call["cmd"] for call in runner.calls]
                runtime_source = hermes_home / "source" / "hermes-agent"
                self.assertTrue(runtime_source.exists())
                self.assertTrue((hermes_home / "source" / "source.json").exists())
                self.assertFalse((tmp / "hermes-agent" / "source.json").exists())
                self.assertIn(
                    [str(managed_python(hermes_home / "venv")), "-m", "pip", "install", "-e", str(runtime_source)],
                    install_commands,
                )
            finally:
                service.close()

    def test_auto_agent_starts_managed_hermes_before_local_fallback(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_fake_hermes_repo(tmp / "hermes-agent")
            config = replace(
                make_config(tmp),
                agent_mode="auto",
                hermes_api_url="http://127.0.0.1:9/v1/chat/completions",
                hermes_timeout_seconds=0.2,
                runtime_startup_wait_seconds=0,
            )
            launcher = RecordingLauncher()
            runner = RecordingCommandRunner()
            service = EnterpriseService(config, runtime_process_launcher=launcher, runtime_command_runner=runner)
            try:
                _, user = service.authenticate("admin", "admin")
                result = service.send_channel_message(user, 1, "@agent hello")
                self.assertIsNone(result["agent_message"])
                service.wait_for_agent_idle("channel", "1", timeout=10)
                agent_message = service.list_messages(user, "channel", "1")[-1]

                self.assertTrue(launcher.calls)
                launch = next(call for call in launcher.calls if "gateway" in call["cmd"])
                runtime_source = config.managed_hermes_home / "source" / "hermes-agent"
                self.assertEqual(launch["cwd"], runtime_source)
                self.assertEqual(launch["cmd"][0], str(managed_python(config.managed_hermes_home / "venv")))
                self.assertIn("gateway", launch["cmd"])
                self.assertEqual(launch["env"]["HERMES_HOME"], str(config.managed_hermes_home))
                self.assertEqual(launch["env"]["API_SERVER_ENABLED"], "true")
                self.assertEqual(launch["env"]["ENTERPRISE_AGENT_TOOL_TOKEN"], "agent-token")
                self.assertEqual(launch["env"]["CAMOFOX_URL"], config.camofox_url)
                self.assertEqual(launch["env"]["FIRECRAWL_API_URL"], config.firecrawl_api_url)
                python_path = launch["env"]["PYTHONPATH"].split(os.pathsep)
                patch_path = str(Path(runtime_module.__file__).resolve().parent / "hermes_runtime_patch")
                self.assertEqual(python_path[0], patch_path)
                self.assertEqual(python_path[1], str(runtime_source))
                self.assertTrue(agent_message["metadata"]["degraded"])
                self.assertIn("Hermes Agent request did not complete", agent_message["content"])
            finally:
                service.close()

    def test_platform_manages_browser_and_firecrawl_process_lifecycle(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_fake_hermes_repo(tmp / "hermes-agent")
            make_fake_firecrawl_repo(tmp / "firecrawl")
            config = replace(make_config(tmp), agent_mode="auto", runtime_startup_wait_seconds=0)
            launcher = RecordingLauncher()
            runner = RecordingCommandRunner()
            service = EnterpriseService(config, runtime_process_launcher=launcher, runtime_command_runner=runner)
            try:
                _, admin = service.authenticate("admin", "admin")
                status = service.runtime_status(admin)
                self.assertEqual(status["camofox"]["state"], "starting")
                self.assertEqual(status["firecrawl"]["state"], "starting")
                commands = [call["cmd"] for call in launcher.calls]
                self.assertTrue(any("@askjo/camofox-browser@^1.5.2" in cmd for cmd in commands))
                self.assertTrue(any(cmd[:2] == ["docker", "compose"] and "up" in cmd for cmd in commands))
                firecrawl_launch = next(call for call in launcher.calls if call["cmd"][:2] == ["docker", "compose"] and "up" in call["cmd"])
                override_path = config.firecrawl_runtime_dir / "docker-compose.enterprise.yaml"
                self.assertIn("docker-compose.yml", firecrawl_launch["cmd"])
                self.assertIn(str(override_path), firecrawl_launch["cmd"])
                self.assertIn("--no-build", firecrawl_launch["cmd"])
                self.assertIn("--pull", firecrawl_launch["cmd"])
                self.assertIn("missing", firecrawl_launch["cmd"])
                self.assertEqual(firecrawl_launch["env"]["DOCKER_BUILDKIT"], "1")
                self.assertEqual(firecrawl_launch["env"]["COMPOSE_DOCKER_CLI_BUILD"], "1")
                self.assertEqual(firecrawl_launch["env"]["PORT"], "13002")
                override_text = override_path.read_text(encoding="utf-8")
                self.assertIn("ghcr.io/firecrawl/firecrawl:latest", override_text)
                self.assertIn("ghcr.io/firecrawl/playwright-service:latest", override_text)
                self.assertIn("ghcr.io/firecrawl/nuq-postgres:latest", override_text)

                service.restart_runtime(admin, "camofox")
                service.restart_runtime(admin, "firecrawl")
                self.assertGreaterEqual(len([call for call in launcher.calls if "@askjo/camofox-browser@^1.5.2" in call["cmd"]]), 2)
                self.assertGreaterEqual(len([call for call in launcher.calls if call["cmd"][:2] == ["docker", "compose"] and "up" in call["cmd"]]), 2)
            finally:
                service.close()

            self.assertTrue(all(not process.running for process in launcher.processes))

    def test_first_run_installs_hermes_from_managed_patched_source_copy(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_fake_hermes_repo(tmp / "hermes-agent")
            runner = RecordingCommandRunner()
            service = EnterpriseService(make_config(tmp), agent_client=RecordingAgent(), runtime_command_runner=runner)
            try:
                hermes_home = service.config.managed_hermes_home
                runtime_source = hermes_home / "source" / "hermes-agent"
                self.assertTrue((hermes_home / "install.json").exists())
                self.assertTrue(runtime_source.exists())
                self.assertEqual(runner.calls[0]["cmd"][:3], [sys.executable, "-m", "venv"])
                self.assertEqual(runner.calls[0]["cmd"][3], str(hermes_home / "venv"))
                self.assertEqual(
                    runner.calls[1]["cmd"],
                    [str(managed_python(hermes_home / "venv")), "-m", "pip", "install", "-e", str(runtime_source)],
                )
                _, admin = service.authenticate("admin", "admin")
                status = service.runtime_status(admin)["hermes"]
                self.assertEqual(status["install_state"], "installed")
                self.assertEqual(status["source"], f"{runtime_source} (patched from {tmp / 'hermes-agent'})")
            finally:
                service.close()

    def test_hermes_config_can_be_updated_from_platform(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_fake_hermes_repo(tmp / "hermes-agent")
            runner = RecordingCommandRunner()
            bridge = FakeHermesBridge()
            service = EnterpriseService(
                make_config(tmp),
                agent_client=RecordingAgent(),
                runtime_command_runner=runner,
                hermes_bridge=bridge,
            )
            try:
                _, admin = service.authenticate("admin", "admin")
                result = service.update_hermes_config(
                    admin,
                    {
                        "manage_hermes": True,
                        "repo_path": str(tmp / "hermes-agent"),
                        "api_url": "http://127.0.0.1:8766/v1/chat/completions",
                        "model": "gpt-5.4",
                        "install_extras": "dev",
                        "startup_wait_seconds": 3.5,
                        "api_key": "runtime-key",
                    },
                )

                self.assertEqual(result["config"]["api_port"], 8766)
                self.assertEqual(result["config"]["model"], "gpt-5.4")
                self.assertEqual(result["config"]["install_extras"], "dev")
                env_text = (service.config.managed_hermes_home / ".env").read_text(encoding="utf-8")
                self.assertIn('API_SERVER_PORT="8766"', env_text)
                self.assertIn('API_SERVER_MODEL_NAME="gpt-5.4"', env_text)
                self.assertIn('API_SERVER_KEY="runtime-key"', env_text)
                self.assertEqual(
                    runner.calls[-1]["cmd"],
                    [
                        str(managed_python(service.config.managed_hermes_home / "venv")),
                        "-m",
                        "pip",
                        "install",
                        "-e",
                        f"{service.config.managed_hermes_home / 'source' / 'hermes-agent'}[dev]",
                    ],
                )
            finally:
                service.close()

    def test_update_hermes_config_rejects_untrusted_repo_path(self):
        # A directory containing a pyproject.toml but located outside the
        # trusted submodule tree must be rejected, so a web admin cannot drive
        # `pip install -e <attacker dir>` (arbitrary code execution).
        evil = Path(__file__).resolve().parent / "_evil_hermes_repo"
        evil.mkdir(exist_ok=True)
        (evil / "pyproject.toml").write_text("[project]\nname = 'evil'\nversion = '0'\n", encoding="utf-8")
        try:
            with tempfile.TemporaryDirectory() as td:
                tmp = Path(td)
                if str(evil).startswith(str(tmp)):
                    self.skipTest("repository tree is under the temp dir; cannot test refusal deterministically")
                make_fake_hermes_repo(tmp / "hermes-agent")
                service = EnterpriseService(make_config(tmp), agent_client=RecordingAgent())
                try:
                    _, admin = service.authenticate("admin", "admin")
                    with self.assertRaises(ServiceError) as ctx:
                        service.update_hermes_config(admin, {"repo_path": str(evil)})
                    self.assertEqual(ctx.exception.status, 403)
                    # The trusted bundled path is still accepted.
                    ok = service.update_hermes_config(admin, {"repo_path": str(tmp / "hermes-agent")})
                    self.assertIn("repo_path", ok["config"])
                finally:
                    service.close()
        finally:
            shutil.rmtree(evil, ignore_errors=True)

    def test_update_hermes_config_rejects_workspace_repo_path(self):
        # An agent-writable workspace directory containing a pyproject.toml must
        # be rejected so an agent cannot plant a build backend for an admin to
        # install.
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_fake_hermes_repo(tmp / "hermes-agent")
            planted = tmp / "workspaces" / "user-1"
            planted.mkdir(parents=True, exist_ok=True)
            (planted / "pyproject.toml").write_text("[project]\nname = 'x'\nversion = '0'\n", encoding="utf-8")
            service = EnterpriseService(make_config(tmp), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                with self.assertRaises(ServiceError) as ctx:
                    service.update_hermes_config(admin, {"repo_path": str(planted)})
                self.assertEqual(ctx.exception.status, 403)
            finally:
                service.close()

    def test_hermes_internal_config_exposes_yaml_and_env_without_leaking_secrets(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_fake_hermes_repo(tmp / "hermes-agent")
            runner = RecordingCommandRunner()
            service = EnterpriseService(make_config(tmp), agent_client=RecordingAgent(), runtime_command_runner=runner)
            try:
                _, admin = service.authenticate("admin", "admin")

                current = service.hermes_internal_config(admin)
                fields_by_key = {item["key"]: item for item in current["internal"]["fields"]}
                yaml_keys = set(fields_by_key)
                env_by_key = {item["key"]: item for item in current["internal"]["env"]}

                self.assertIn("agent.max_turns", yaml_keys)
                self.assertIn("display.show_reasoning", yaml_keys)
                self.assertEqual(fields_by_key["agent.max_turns"]["value"], 90)
                self.assertFalse(fields_by_key["agent.max_turns"]["configured"])
                self.assertTrue(fields_by_key["agent.max_turns"]["defaulted"])
                self.assertEqual(fields_by_key["display.show_reasoning"]["value"], False)
                self.assertFalse(fields_by_key["display.show_reasoning"]["configured"])
                self.assertTrue(fields_by_key["display.show_reasoning"]["defaulted"])
                self.assertEqual(fields_by_key["toolsets"]["value"], "[\n  \"hermes-cli\"\n]")
                self.assertTrue(fields_by_key["toolsets"]["defaulted"])
                self.assertIn("API_SERVER_KEY", env_by_key)
                self.assertTrue(env_by_key["API_SERVER_KEY"]["secret"])
                self.assertEqual(env_by_key["API_SERVER_KEY"]["value"], "")

                updated = service.update_hermes_internal_config(
                    admin,
                    {
                        "yaml_updates": {
                            "agent.max_turns": "12",
                            "display.show_reasoning": "true",
                        },
                        "env": {
                            "HERMES_MAX_ITERATIONS": "12",
                            "OPENROUTER_API_KEY": "openrouter-secret",
                        },
                    },
                )
                fields = {item["key"]: item for item in updated["internal"]["fields"]}
                env = {item["key"]: item for item in updated["internal"]["env"]}

                self.assertEqual(fields["agent.max_turns"]["value"], 12)
                self.assertEqual(fields["display.show_reasoning"]["value"], True)
                self.assertEqual(env["HERMES_MAX_ITERATIONS"]["value"], "12")
                self.assertEqual(env["OPENROUTER_API_KEY"]["value"], "")
                self.assertTrue(env["OPENROUTER_API_KEY"]["masked"])

                with self.assertRaises(ServiceError) as bad_yaml:
                    service.update_hermes_internal_config(admin, {"yaml_text": "not: [valid"})
                self.assertEqual(bad_yaml.exception.status, 400)
            finally:
                service.close()

    def test_cognee_internal_config_exposes_and_updates_managed_env(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_fake_cognee_repo(tmp / "cognee")
            service = EnterpriseService(make_config(tmp), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")

                current = service.cognee_config(admin)
                env_keys = {item["key"] for item in current["internal"]["env"]}
                self.assertIn("LLM_MODEL", env_keys)
                self.assertIn("VECTOR_DB_PROVIDER", env_keys)
                self.assertIn("DATA_ROOT_DIRECTORY", env_keys)

                updated = service.update_cognee_config(
                    admin,
                    {
                        "env": {
                            "LLM_MODEL": "openai/gpt-5-mini",
                            "VECTOR_DB_PROVIDER": "lancedb",
                            "LLM_API_KEY": "llm-secret",
                        }
                    },
                )
                env = {item["key"]: item for item in updated["internal"]["env"]}
                env_text = (tmp / "runtimes" / "cognee" / ".env").read_text(encoding="utf-8")

                self.assertEqual(env["LLM_MODEL"]["value"], "openai/gpt-5-mini")
                self.assertEqual(env["VECTOR_DB_PROVIDER"]["value"], "lancedb")
                self.assertEqual(env["LLM_API_KEY"]["value"], "")
                self.assertTrue(env["LLM_API_KEY"]["masked"])
                self.assertIn('LLM_MODEL="openai/gpt-5-mini"', env_text)
            finally:
                service.close()

    def test_platform_writes_managed_codex_and_grok_oauth_state_for_hermes(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_fake_hermes_repo(tmp / "hermes-agent")
            runner = RecordingCommandRunner()
            bridge = FakeHermesBridge()
            service = EnterpriseService(
                make_config(tmp),
                agent_client=RecordingAgent(),
                runtime_command_runner=runner,
                hermes_bridge=bridge,
            )
            try:
                _, admin = service.authenticate("admin", "admin")
                service.set_secret(admin, "CODEX_OAUTH_ACCESS_TOKEN", "codex-access")
                service.set_secret(admin, "CODEX_OAUTH_REFRESH_TOKEN", "codex-refresh")
                service.set_secret(admin, "GROK_OAUTH_ACCESS_TOKEN", "grok-access")
                service.set_secret(admin, "GROK_OAUTH_REFRESH_TOKEN", "grok-refresh")

                codex_config = service.update_hermes_config(
                    admin,
                    {
                        "provider": "codex",
                        "model": "hermes-agent",
                    },
                )["config"]
                auth_path = service.config.managed_hermes_home / "auth.json"
                auth_store = json.loads(auth_path.read_text(encoding="utf-8"))

                self.assertEqual(codex_config["provider"], "openai-codex")
                self.assertEqual(codex_config["model"], "gpt-5.5")
                self.assertIn(("openai-codex", False), bridge.catalog_calls)
                self.assertEqual(auth_store["active_provider"], "openai-codex")
                self.assertEqual(auth_store["providers"]["openai-codex"]["auth_mode"], "chatgpt")
                self.assertEqual(auth_store["providers"]["openai-codex"]["tokens"]["access_token"], "codex-access")
                self.assertEqual(auth_store["providers"]["openai-codex"]["tokens"]["refresh_token"], "codex-refresh")

                grok_config = service.update_hermes_config(
                    admin,
                    {
                        "provider": "grok-oauth",
                        "model": "hermes-agent",
                    },
                )["config"]
                auth_store = json.loads(auth_path.read_text(encoding="utf-8"))
                config_text = (service.config.managed_hermes_home / "config.yaml").read_text(encoding="utf-8")
                env_text = (service.config.managed_hermes_home / ".env").read_text(encoding="utf-8")

                self.assertEqual(grok_config["provider"], "xai-oauth")
                self.assertEqual(grok_config["model"], "grok-4.3")
                self.assertIn(("xai-oauth", False), bridge.catalog_calls)
                self.assertEqual(grok_config["provider_base_url"], "https://api.x.ai/v1")
                self.assertEqual(auth_store["active_provider"], "xai-oauth")
                self.assertEqual(auth_store["providers"]["xai-oauth"]["auth_mode"], "oauth_pkce")
                self.assertEqual(auth_store["providers"]["xai-oauth"]["tokens"]["access_token"], "grok-access")
                self.assertEqual(auth_store["providers"]["xai-oauth"]["tokens"]["refresh_token"], "grok-refresh")
                self.assertIn("provider: xai-oauth", config_text)
                self.assertIn("default: grok-4.3", config_text)
                self.assertIn('HERMES_INFERENCE_PROVIDER="xai-oauth"', env_text)
                self.assertIn('HERMES_XAI_BASE_URL="https://api.x.ai/v1"', env_text)
            finally:
                service.close()

    def test_oauth_model_selection_is_validated_against_hermes_catalog(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_fake_hermes_repo(tmp / "hermes-agent")
            bridge = FakeHermesBridge()
            service = EnterpriseService(
                make_config(tmp),
                agent_client=RecordingAgent(),
                runtime_command_runner=RecordingCommandRunner(),
                hermes_bridge=bridge,
            )
            try:
                _, admin = service.authenticate("admin", "admin")
                config = service.hermes_config(admin)["config"]
                self.assertEqual(
                    config["model_catalog"]["openai-codex"]["models"],
                    ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"],
                )

                with self.assertRaises(ServiceError) as ctx:
                    service.update_hermes_config(admin, {"provider": "codex", "model": "not-from-hermes"})
                self.assertEqual(ctx.exception.status, 400)

                updated = service.update_hermes_config(admin, {"provider": "codex", "model": "gpt-5.4"})
                self.assertEqual(updated["config"]["model"], "gpt-5.4")
                self.assertIn(("openai-codex", False), bridge.catalog_calls)
            finally:
                service.close()

    def test_platform_does_not_resurrect_relogin_required_codex_oauth_state(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_fake_hermes_repo(tmp / "hermes-agent")
            service = EnterpriseService(make_config(tmp), agent_client=RecordingAgent(), hermes_bridge=FakeHermesBridge())
            try:
                _, admin = service.authenticate("admin", "admin")
                service.set_secret(admin, "CODEX_OAUTH_ACCESS_TOKEN", "codex-access")
                service.set_secret(admin, "CODEX_OAUTH_REFRESH_TOKEN", "codex-refresh")
                service.update_hermes_config(admin, {"provider": "codex", "model": "hermes-agent"})

                auth_path = service.config.managed_hermes_home / "auth.json"
                auth_store = json.loads(auth_path.read_text(encoding="utf-8"))
                state = auth_store["providers"]["openai-codex"]
                state["last_auth_error"] = {
                    "provider": "openai-codex",
                    "code": "refresh_token_reused",
                    "message": "Codex refresh token was already consumed by another client.",
                    "reason": "credential_pool_refresh_failure",
                    "relogin_required": True,
                    "at": "2026-06-07T01:37:29Z",
                }
                auth_path.write_text(json.dumps(auth_store), encoding="utf-8")

                service.runtimes.prepare_hermes()

                auth_store = json.loads(auth_path.read_text(encoding="utf-8"))
                state = auth_store["providers"]["openai-codex"]
                self.assertNotIn("access_token", state["tokens"])
                self.assertNotIn("refresh_token", state["tokens"])
                codex_status = next(
                    item for item in service.oauth_provider_status(admin)["providers"] if item["id"] == "openai-codex"
                )
                self.assertFalse(codex_status["configured"])
                self.assertEqual(codex_status["last_auth_error"]["code"], "refresh_token_reused")

                service.set_secret(admin, "CODEX_OAUTH_ACCESS_TOKEN", "codex-access-2")
                service.set_secret(admin, "CODEX_OAUTH_REFRESH_TOKEN", "codex-refresh-2")
                service.runtimes.prepare_hermes()

                auth_store = json.loads(auth_path.read_text(encoding="utf-8"))
                state = auth_store["providers"]["openai-codex"]
                self.assertEqual(state["tokens"]["access_token"], "codex-access-2")
                self.assertEqual(state["tokens"]["refresh_token"], "codex-refresh-2")
                self.assertNotIn("last_auth_error", state)
            finally:
                service.close()

    def test_api_providers_are_limited_to_codex_and_grok_oauth(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                status = service.oauth_provider_status(admin)
                self.assertEqual([item["id"] for item in status["providers"]], ["openai-codex", "xai-oauth"])
                self.assertEqual(status["active_provider"], "openai-codex")

                with self.assertRaises(ServiceError) as update_error:
                    service.update_hermes_config(admin, {"provider": "openrouter"})
                self.assertEqual(update_error.exception.status, 400)

                with self.assertRaises(ServiceError) as key_error:
                    service.set_secret(admin, "XAI_API_KEY", "xai-key")
                self.assertEqual(key_error.exception.status, 400)
            finally:
                service.close()

    def test_codex_guided_oauth_flow_stores_tokens_for_hermes(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_fake_hermes_repo(tmp / "hermes-agent")
            service = EnterpriseService(
                make_config(tmp),
                agent_client=RecordingAgent(),
                oauth_http_client=FakeOAuthHTTPClient(),
                hermes_bridge=FakeHermesBridge(),
            )
            try:
                _, admin = service.authenticate("admin", "admin")

                started = service.start_oauth_verification(admin, "openai-codex")
                flow = started["flow"]
                self.assertEqual(flow["kind"], "device_code")
                self.assertEqual(flow["user_code"], "CODE-1234")
                self.assertEqual(started["active_provider"], "openai-codex")

                completed = service.poll_oauth_verification(admin, "openai-codex", {"flow_id": flow["flow_id"]})
                self.assertTrue(completed["flow"]["complete"])
                self.assertEqual(service.get_secret("CODEX_OAUTH_ACCESS_TOKEN"), "codex-access")
                self.assertEqual(service.get_secret("CODEX_OAUTH_REFRESH_TOKEN"), "codex-refresh")

                auth_store = json.loads((service.config.managed_hermes_home / "auth.json").read_text(encoding="utf-8"))
                self.assertEqual(auth_store["active_provider"], "openai-codex")
                self.assertEqual(auth_store["providers"]["openai-codex"]["tokens"]["access_token"], "codex-access")
                self.assertTrue(next(item for item in completed["providers"] if item["id"] == "openai-codex")["configured"])
            finally:
                service.close()

    def test_grok_guided_oauth_flow_accepts_pasted_callback_url(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_fake_hermes_repo(tmp / "hermes-agent")
            service = EnterpriseService(
                make_config(tmp),
                agent_client=RecordingAgent(),
                oauth_http_client=FakeOAuthHTTPClient(),
                hermes_bridge=FakeHermesBridge(),
            )
            try:
                _, admin = service.authenticate("admin", "admin")

                started = service.start_oauth_verification(admin, "grok-oauth")
                flow = started["flow"]
                self.assertEqual(flow["kind"], "manual_callback")
                query = urllib.parse.parse_qs(urllib.parse.urlparse(flow["authorize_url"]).query)
                self.assertEqual(query["referrer"], ["hermes-agent"])
                callback_url = f"{flow['redirect_uri']}?code=grok-code&state={query['state'][0]}"

                completed = service.complete_oauth_verification(
                    admin,
                    "xai-oauth",
                    {"flow_id": flow["flow_id"], "callback_url": callback_url},
                )
                self.assertTrue(completed["flow"]["complete"])
                self.assertEqual(service.get_secret("GROK_OAUTH_ACCESS_TOKEN"), "grok-access")
                self.assertEqual(service.get_secret("GROK_OAUTH_REFRESH_TOKEN"), "grok-refresh")
                self.assertEqual(service.get_secret("GROK_OAUTH_ID_TOKEN"), "grok-id")

                auth_store = json.loads((service.config.managed_hermes_home / "auth.json").read_text(encoding="utf-8"))
                self.assertEqual(auth_store["active_provider"], "xai-oauth")
                self.assertEqual(auth_store["providers"]["xai-oauth"]["tokens"]["access_token"], "grok-access")
                self.assertTrue(next(item for item in completed["providers"] if item["id"] == "xai-oauth")["configured"])
            finally:
                service.close()

    def test_oauth_credentials_export_import_roundtrip_restores_managed_state(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source_dir = root / "source"
            target_dir = root / "target"
            make_fake_hermes_repo(source_dir / "hermes-agent")
            make_fake_hermes_repo(target_dir / "hermes-agent")
            source = EnterpriseService(
                make_config(source_dir),
                agent_client=RecordingAgent(),
                runtime_command_runner=RecordingCommandRunner(),
                hermes_bridge=FakeHermesBridge(),
            )
            target = EnterpriseService(
                make_config(target_dir),
                agent_client=RecordingAgent(),
                runtime_command_runner=RecordingCommandRunner(),
                hermes_bridge=FakeHermesBridge(),
            )
            try:
                _, source_admin = source.authenticate("admin", "admin")
                source.set_secret(source_admin, "CODEX_OAUTH_ACCESS_TOKEN", "codex-access")
                source.set_secret(source_admin, "CODEX_OAUTH_REFRESH_TOKEN", "codex-refresh")
                source.set_secret(source_admin, "GROK_OAUTH_ACCESS_TOKEN", "grok-access")
                source.set_secret(source_admin, "GROK_OAUTH_REFRESH_TOKEN", "grok-refresh")
                source.set_secret(source_admin, "GROK_OAUTH_ID_TOKEN", "grok-id")
                source.update_hermes_config(source_admin, {"provider": "grok-oauth"})

                exported = source.export_oauth_credentials(source_admin)
                self.assertEqual(exported["kind"], "enterprise-agent-platform.oauth-credentials")
                self.assertEqual(exported["version"], 1)
                self.assertEqual(exported["active_provider"], "xai-oauth")
                self.assertEqual(
                    exported["providers"]["openai-codex"]["credentials"]["CODEX_OAUTH_ACCESS_TOKEN"],
                    "codex-access",
                )
                self.assertEqual(
                    exported["providers"]["xai-oauth"]["credentials"]["GROK_OAUTH_ID_TOKEN"],
                    "grok-id",
                )
                self.assertNotIn("API_SERVER_KEY", json.dumps(exported))

                _, target_admin = target.authenticate("admin", "admin")
                imported = target.import_oauth_credentials(target_admin, {"credentials": exported})

                self.assertCountEqual(imported["imported"]["providers"], ["openai-codex", "xai-oauth"])
                self.assertEqual(imported["active_provider"], "xai-oauth")
                self.assertEqual(target.get_secret("CODEX_OAUTH_ACCESS_TOKEN"), "codex-access")
                self.assertEqual(target.get_secret("CODEX_OAUTH_REFRESH_TOKEN"), "codex-refresh")
                self.assertEqual(target.get_secret("GROK_OAUTH_ACCESS_TOKEN"), "grok-access")
                self.assertEqual(target.get_secret("GROK_OAUTH_REFRESH_TOKEN"), "grok-refresh")
                self.assertEqual(target.get_secret("GROK_OAUTH_ID_TOKEN"), "grok-id")

                auth_store = json.loads((target.config.managed_hermes_home / "auth.json").read_text(encoding="utf-8"))
                self.assertEqual(auth_store["active_provider"], "xai-oauth")
                self.assertEqual(auth_store["providers"]["openai-codex"]["tokens"]["access_token"], "codex-access")
                self.assertEqual(auth_store["providers"]["xai-oauth"]["tokens"]["access_token"], "grok-access")
                self.assertEqual(auth_store["providers"]["xai-oauth"]["tokens"]["id_token"], "grok-id")
            finally:
                source.close()
                target.close()

    def test_oauth_credentials_import_rejects_incomplete_token_pairs(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                with self.assertRaises(ServiceError) as import_error:
                    service.import_oauth_credentials(
                        admin,
                        {
                            "credentials": {
                                "providers": {
                                    "openai-codex": {
                                        "credentials": {"CODEX_OAUTH_ACCESS_TOKEN": "codex-access"}
                                    }
                                }
                            }
                        },
                    )
                self.assertEqual(import_error.exception.status, 400)
            finally:
                service.close()

    def test_bootstrap_admin_password_is_generated_by_default(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            config = replace(make_config(tmp), allow_insecure_bootstrap_password=False)
            service = EnterpriseService(config, agent_client=RecordingAgent())
            try:
                password_path = tmp / BOOTSTRAP_ADMIN_PASSWORD_FILE
                self.assertTrue(password_path.exists())
                password = password_path.read_text(encoding="utf-8").strip()
                self.assertGreaterEqual(len(password), 24)
                with self.assertRaises(ServiceError) as login_error:
                    service.authenticate("admin", "admin")
                self.assertEqual(login_error.exception.status, 401)
                _, admin = service.authenticate("admin", password)
                self.assertEqual(admin["username"], "admin")
                if os.name != "nt":
                    self.assertEqual(password_path.stat().st_mode & 0o777, 0o600)
            finally:
                service.close()

    def test_login_failures_are_rate_limited_per_client(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                for _ in range(MAX_LOGIN_FAILURES):
                    with self.assertRaises(ServiceError) as login_error:
                        service.authenticate("admin", "wrong-password", client_id="198.51.100.10")
                    self.assertEqual(login_error.exception.status, 401)
                with self.assertRaises(ServiceError) as limited:
                    service.authenticate("admin", "admin", client_id="198.51.100.10")
                self.assertEqual(limited.exception.status, 429)

                _, admin = service.authenticate("admin", "admin", client_id="198.51.100.11")
                self.assertEqual(admin["username"], "admin")
            finally:
                service.close()

    def test_password_change_revokes_existing_sessions(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                token, admin = service.authenticate("admin", "admin")
                self.assertIsNotNone(service.user_from_token(token))
                service.update_user(admin, admin["id"], {"password": "new-strong-password"})
                # The previously issued token must no longer authenticate.
                self.assertIsNone(service.user_from_token(token))
                fresh_token, _ = service.authenticate("admin", "new-strong-password")
                self.assertIsNotNone(service.user_from_token(fresh_token))
            finally:
                service.close()

    def test_permission_change_and_explicit_revoke_invalidate_sessions(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                member = service.create_user(
                    username="member1", password="member-password", actor=admin, permission_group="member"
                )
                token, _ = service.authenticate("member1", "member-password")
                self.assertIsNotNone(service.user_from_token(token))
                # Downgrading the permission group invalidates the live token.
                service.update_user(admin, member["id"], {"permission_group": "viewer"})
                self.assertIsNone(service.user_from_token(token))
                # Explicit revoke also invalidates a fresh token.
                token2, _ = service.authenticate("member1", "member-password")
                self.assertIsNotNone(service.user_from_token(token2))
                service.revoke_user_sessions(member["id"])
                self.assertIsNone(service.user_from_token(token2))
            finally:
                service.close()

    def test_tampered_and_expired_tokens_are_rejected(self):
        from enterprise_agent_platform.auth import TokenSigner

        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                token, _ = service.authenticate("admin", "admin")
                self.assertIsNone(service.user_from_token(token + "tamper"))
                self.assertIsNone(service.user_from_token("not.a.valid.token"))
                self.assertIsNone(service.user_from_token(""))
                secret = service.get_secret("ENTERPRISE_SESSION_SECRET")
                self.assertTrue(secret)
                expired = TokenSigner(secret, ttl_seconds=-10).issue(1, 1)
                self.assertIsNone(service.user_from_token(expired))
            finally:
                service.close()

    def test_database_handles_concurrent_threads(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                errors: list[Exception] = []

                def worker(n: int) -> None:
                    try:
                        for i in range(20):
                            service.db.execute(
                                "INSERT INTO messages(scope_type, scope_id, author_type, user_id, "
                                "username, content, created_at) VALUES ('channel', ?, 'system', NULL, '', ?, ?)",
                                (f"t{n}", f"msg-{n}-{i}", 0),
                            )
                            service.db.query("SELECT COUNT(*) FROM messages")
                    except Exception as exc:  # noqa: BLE001 - recorded for assertion
                        errors.append(exc)

                workers = [threading.Thread(target=worker, args=(n,)) for n in range(8)]
                for t in workers:
                    t.start()
                for t in workers:
                    t.join(timeout=30)
                self.assertEqual(errors, [])
                total = service.db.scalar("SELECT COUNT(*) FROM messages WHERE author_type = 'system'")
                self.assertEqual(total, 8 * 20)
            finally:
                service.close()

    def test_database_rejects_use_after_close(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            db = service.db
            service.close()
            # After close, a lingering caller gets a clean error, not an
            # AttributeError from a None connection.
            with self.assertRaises(sqlite3.ProgrammingError):
                db.query("SELECT 1")

    def test_agent_queue_depth_is_capped(self):
        from enterprise_agent_platform.service import MAX_AGENT_QUEUE_DEPTH

        with tempfile.TemporaryDirectory() as td:
            agent = BlockingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, user = service.authenticate("admin", "admin")
                service.send_private_message(user, "first")
                self.assertTrue(agent.started.wait(timeout=5))
                # The first task is now held in the worker; fill the queue to the
                # cap, then the next enqueue must be rejected rather than growing
                # memory without bound.
                for i in range(MAX_AGENT_QUEUE_DEPTH):
                    service.send_private_message(user, f"queued-{i}")
                with self.assertRaises(ServiceError) as ctx:
                    service.send_private_message(user, "overflow")
                self.assertEqual(ctx.exception.status, 429)
            finally:
                agent.release.set()
                service.close()

    def test_cognee_ingest_runs_in_background(self):
        from enterprise_agent_platform.cognee_bridge import CogneeStatus

        with tempfile.TemporaryDirectory() as td:
            config = replace(make_config(Path(td)), knowledge_backend="hybrid")
            service = EnterpriseService(config, agent_client=RecordingAgent())
            try:
                done = threading.Event()
                calls: list[str] = []

                class FakeCognee:
                    def ingest_document(self, *, title, content, source=""):
                        calls.append(title)
                        done.set()
                        return {"attempted": True, "available": True, "dataset": "x"}

                    def search(self, query, limit=5):
                        return []

                    def status(self):
                        return CogneeStatus(True, "hybrid")

                service.cognee = FakeCognee()
                _, user = service.authenticate("admin", "admin")
                doc = service.add_knowledge_document(user, {"title": "Async Doc", "content": "body"})
                # The request returns immediately with a "queued" marker.
                self.assertTrue(doc["cognee"].get("queued"))
                # The heavy ingest happens on the background worker.
                self.assertTrue(done.wait(timeout=5))
                self.assertEqual(calls, ["Async Doc"])
                result = service.cognee_ingest_result(doc["id"])
                self.assertTrue(result and result.get("available"))
            finally:
                service.close()

    def test_channel_and_private_reads_enforce_authorization(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                alice = service.create_user(
                    username="alice", password="alice-password", actor=admin, permission_group="member"
                )
                bob = service.create_user(
                    username="bob", password="bob-password", actor=admin, permission_group="member"
                )
                service.send_private_message(alice, "alice secret")
                # Bob must not be able to read Alice's private conversation.
                with self.assertRaises(ServiceError) as ctx:
                    service.list_messages(bob, "private", str(alice["id"]))
                self.assertEqual(ctx.exception.status, 403)
                # Alice can read her own private conversation.
                own = service.list_messages(alice, "private", str(alice["id"]))
                self.assertTrue(any(m["content"] == "alice secret" for m in own))
                # A permissionless actor cannot read channel history.
                with self.assertRaises(ServiceError) as ctx2:
                    service.list_messages({"id": 0}, "channel", "1")
                self.assertEqual(ctx2.exception.status, 403)
                # A member with read_workspace can read the channel.
                self.assertIsInstance(service.list_messages(alice, "channel", "1"), list)
            finally:
                service.close()

    def test_knowledge_reads_require_read_permission(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                doc = service.add_knowledge_document(admin, {"title": "Policy", "content": "secret policy"})
                for call in (
                    lambda: service.list_knowledge_documents({"id": 0}),
                    lambda: service.user_search_knowledge({"id": 0}, "policy"),
                    lambda: service.user_knowledge_document({"id": 0}, doc["id"]),
                ):
                    with self.assertRaises(ServiceError) as ctx:
                        call()
                    self.assertEqual(ctx.exception.status, 403)
                # The token-gated agent-tool path still resolves documents.
                self.assertEqual(service.get_knowledge_document(doc["id"])["title"], "Policy")
            finally:
                service.close()

    def test_knowledge_status_reports_fts_and_ingest_state(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                status = service.knowledge_status()
                self.assertTrue(status["local"]["available"])
                self.assertEqual(status["local"]["fts5"], service.db.fts_available)
                self.assertEqual(status["local"]["backend"], "sqlite-fts" if service.db.fts_available else "sqlite-like")
                self.assertIn("ingest_pending", status)
                self.assertEqual(status["mode"], "local")
            finally:
                service.close()

    def test_docker_backend_applies_isolation_hardening(self):
        with tempfile.TemporaryDirectory() as td:
            config = replace(make_config(Path(td)), container_backend="docker")
            runner_calls: list[list[str]] = []

            def fake_run(cmd, **kwargs):
                runner_calls.append(cmd)
                if cmd[:2] == ["docker", "inspect"]:
                    return SimpleNamespace(returncode=1, stdout="")
                if cmd[:2] == ["docker", "run"]:
                    return SimpleNamespace(returncode=0, stdout="cid123\n")
                return SimpleNamespace(returncode=0, stdout="")

            service = EnterpriseService(config, agent_client=RecordingAgent(), container_command_runner=fake_run)
            try:
                container = service.containers.ensure_private_container(user_id=1, username="admin", secrets_env={})
                self.assertEqual(container.backend, "docker")
                run_cmd = next(c for c in runner_calls if c[:2] == ["docker", "run"])
                self.assertIn("--cap-drop", run_cmd)
                self.assertIn("ALL", run_cmd)
                self.assertIn("--security-opt", run_cmd)
                self.assertIn("no-new-privileges", run_cmd)
                self.assertIn("--pids-limit", run_cmd)
                self.assertIn("--memory", run_cmd)
                # No secrets are forwarded into the container with an empty env.
                self.assertNotIn("-e", run_cmd)
            finally:
                service.close()

    def test_managed_cognee_environment_is_seeded_from_platform(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_fake_cognee_repo(tmp / "cognee")
            old_env = {key: os.environ.get(key) for key in ("DATA_ROOT_DIRECTORY", "SYSTEM_ROOT_DIRECTORY", "CACHE_ROOT_DIRECTORY", "COGNEE_LOGS_DIR", "LLM_API_KEY")}
            for key in old_env:
                os.environ.pop(key, None)
            service = None
            try:
                service = EnterpriseService(make_config(tmp), agent_client=RecordingAgent())
                service.runtimes.ensure_cognee_ready()

                self.assertEqual(os.environ["DATA_ROOT_DIRECTORY"], str(tmp / "runtimes" / "cognee" / "data"))
                self.assertEqual(os.environ["SYSTEM_ROOT_DIRECTORY"], str(tmp / "runtimes" / "cognee" / "system"))
                self.assertEqual(os.environ["CACHE_ROOT_DIRECTORY"], str(tmp / "runtimes" / "cognee" / "cache"))
                self.assertEqual(os.environ["COGNEE_LOGS_DIR"], str(tmp / "runtimes" / "cognee" / "logs"))
                self.assertNotIn("LLM_API_KEY", os.environ)
            finally:
                if service is not None:
                    service.close()
                for key, value in old_env.items():
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value


class PlatformHTTPTests(unittest.TestCase):
    def test_telegram_webhook_uses_gateway_secret_instead_of_cookie_csrf(self):
        with tempfile.TemporaryDirectory() as td:
            config = replace(
                make_config(Path(td)),
                telegram_enabled=True,
                telegram_bot_token="123456:token",
                telegram_webhook_secret="telegram-secret",
            )
            service = EnterpriseService(config, agent_client=RecordingAgent())
            seen = []

            def fake_update(body):
                seen.append(body)
                return {"ok": True, "seen": body.get("update_id")}

            service.telegram_gateway_update = fake_update
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            try:
                conn = http.client.HTTPConnection(host, port, timeout=5)
                body = json.dumps({"update_id": 99})
                conn.request(
                    "POST",
                    "/api/telegram/webhook/telegram-secret",
                    body=body,
                    headers={"Content-Type": "application/json"},
                )
                res = conn.getresponse()
                payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 200)
                self.assertEqual(payload, {"ok": True, "seen": 99})
                self.assertEqual(seen, [{"update_id": 99}])

                conn.request(
                    "POST",
                    "/api/telegram/webhook/wrong",
                    body=body,
                    headers={"Content-Type": "application/json"},
                )
                res = conn.getresponse()
                payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 403)
                self.assertEqual(payload["error"], "invalid Telegram webhook secret")
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)

    def test_auto_update_webhook_requires_secret_and_accepts_github_hmac(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            service = EnterpriseService(config, agent_client=RecordingAgent())
            fake_updater = FakeAutoUpdater()
            service._auto_updater = fake_updater
            secret = "auto-update-secret-value"
            service.set_setting("auto_update_enabled", "1")
            service.set_setting("ENTERPRISE_AUTO_UPDATE_WEBHOOK_SECRET", secret, secret=True)
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            try:
                body = json.dumps({"ref": "refs/heads/main"}).encode("utf-8")
                conn = http.client.HTTPConnection(host, port, timeout=5)
                conn.request(
                    "POST",
                    "/api/auto-update/webhook/wrong",
                    body=body,
                    headers={"Content-Type": "application/json"},
                )
                res = conn.getresponse()
                denied = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 403)
                self.assertEqual(denied["error"], "invalid auto update webhook secret")

                signature = "sha256=" + hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
                conn.request(
                    "POST",
                    "/api/auto-update/webhook/wrong",
                    body=body,
                    headers={"Content-Type": "application/json", "X-Hub-Signature-256": signature},
                )
                res = conn.getresponse()
                accepted = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 202)
                self.assertTrue(accepted["accepted"])
                self.assertEqual(fake_updater.triggers, ["webhook"])
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)

    def test_token_usage_api_is_admin_only(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            service = EnterpriseService(config, agent_client=RecordingAgent())
            _, admin = service.authenticate("admin", "admin")
            service.create_user(
                username="usage-member",
                password="member-pass",
                display_name="Usage Member",
                role="member",
                actor=admin,
            )
            admin_token, _ = service.authenticate("admin", "admin")
            member_token, _ = service.authenticate("usage-member", "member-pass")
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            try:
                conn = http.client.HTTPConnection(host, port, timeout=5)
                conn.request("GET", "/api/admin/token-usage", headers={"Authorization": f"Bearer {admin_token}"})
                res = conn.getresponse()
                payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 200)
                self.assertIn("summary", payload)

                conn.request("GET", "/api/admin/token-usage", headers={"Authorization": f"Bearer {member_token}"})
                res = conn.getresponse()
                payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 403)
                self.assertEqual(payload["error"], "admin role required")
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)

    def test_http_current_user_settings_and_password_routes(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            service = EnterpriseService(config, agent_client=RecordingAgent())
            _, admin = service.authenticate("admin", "admin")
            service.create_user(
                username="settings-member",
                password="member-pass",
                display_name="Settings Member",
                position="Designer",
                permission_group="member",
                actor=admin,
            )
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            origin = f"http://{host}:{port}"
            try:
                conn = http.client.HTTPConnection(host, port, timeout=5)
                conn.request(
                    "POST",
                    "/api/auth/login",
                    body=json.dumps({"username": "settings-member", "password": "member-pass"}),
                    headers={"Content-Type": "application/json", "Origin": origin},
                )
                res = conn.getresponse()
                payload = json.loads(res.read().decode("utf-8"))
                cookie = res.getheader("Set-Cookie")
                self.assertEqual(res.status, 200)
                self.assertEqual(payload["user"]["username"], "settings-member")
                self.assertTrue(cookie)

                conn.request(
                    "PUT",
                    "/api/auth/me",
                    body=json.dumps(
                        {
                            "display_name": "Self Service User",
                            "position": "Product Lead",
                            "permission_group": "admin",
                        }
                    ),
                    headers={"Content-Type": "application/json", "Cookie": cookie, "Origin": origin},
                )
                res = conn.getresponse()
                updated = json.loads(res.read().decode("utf-8"))["user"]
                self.assertEqual(res.status, 200)
                self.assertEqual(updated["display_name"], "Self Service User")
                self.assertEqual(updated["position"], "Product Lead")
                self.assertEqual(updated["permission_group"], "member")

                conn.request(
                    "PUT",
                    "/api/auth/password",
                    body=json.dumps(
                        {"current_password": "wrong-pass", "new_password": "new-member-password"}
                    ),
                    headers={"Content-Type": "application/json", "Cookie": cookie, "Origin": origin},
                )
                res = conn.getresponse()
                denied = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 400)
                self.assertEqual(denied["error"], "current password is incorrect")

                conn.request(
                    "PUT",
                    "/api/auth/password",
                    body=json.dumps(
                        {"current_password": "member-pass", "new_password": "new-member-password"}
                    ),
                    headers={"Content-Type": "application/json", "Cookie": cookie, "Origin": origin},
                )
                res = conn.getresponse()
                changed = json.loads(res.read().decode("utf-8"))
                new_cookie = res.getheader("Set-Cookie")
                self.assertEqual(res.status, 200)
                self.assertEqual(changed["user"]["username"], "settings-member")
                self.assertTrue(new_cookie)

                conn.request("GET", "/api/auth/me", headers={"Cookie": cookie})
                res = conn.getresponse()
                res.read()
                self.assertEqual(res.status, 401)

                conn.request("GET", "/api/auth/me", headers={"Cookie": new_cookie})
                res = conn.getresponse()
                me = json.loads(res.read().decode("utf-8"))["user"]
                self.assertEqual(res.status, 200)
                self.assertEqual(me["display_name"], "Self Service User")

                conn.request(
                    "POST",
                    "/api/auth/login",
                    body=json.dumps({"username": "settings-member", "password": "member-pass"}),
                    headers={"Content-Type": "application/json", "Origin": origin},
                )
                res = conn.getresponse()
                res.read()
                self.assertEqual(res.status, 401)

                conn.request(
                    "POST",
                    "/api/auth/login",
                    body=json.dumps({"username": "settings-member", "password": "new-member-password"}),
                    headers={"Content-Type": "application/json", "Origin": origin},
                )
                res = conn.getresponse()
                res.read()
                self.assertEqual(res.status, 200)
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)

    def test_http_security_headers_secure_cookie_and_csrf_origin_check(self):
        with tempfile.TemporaryDirectory() as td:
            config = replace(make_config(Path(td)), public_base_url="https://agents.example")
            service = EnterpriseService(config, agent_client=RecordingAgent())
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            try:
                conn = http.client.HTTPConnection(host, port, timeout=5)
                conn.request("GET", "/")
                res = conn.getresponse()
                res.read()
                self.assertEqual(res.status, 200)
                self.assertEqual(res.getheader("X-Frame-Options"), "DENY")
                self.assertEqual(res.getheader("X-Content-Type-Options"), "nosniff")
                self.assertIn("frame-ancestors 'none'", res.getheader("Content-Security-Policy"))

                conn.request(
                    "POST",
                    "/api/auth/login",
                    body=json.dumps({"username": "admin", "password": "admin"}),
                    headers={"Content-Type": "application/json", "Origin": "https://evil.example"},
                )
                res = conn.getresponse()
                denied = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 403)
                self.assertEqual(denied["error"], "cross-origin request denied")

                conn.request(
                    "POST",
                    "/api/auth/login",
                    body=json.dumps({"username": "admin", "password": "admin"}),
                    headers={"Content-Type": "application/json", "Origin": "https://agents.example"},
                )
                res = conn.getresponse()
                res.read()
                cookie = res.getheader("Set-Cookie")
                self.assertEqual(res.status, 200)
                self.assertIn("HttpOnly", cookie)
                self.assertIn("SameSite=Lax", cookie)
                self.assertIn("Secure", cookie)

                conn.request(
                    "POST",
                    "/api/channels",
                    body=json.dumps({"name": "blocked"}),
                    headers={"Content-Type": "application/json", "Cookie": cookie, "Origin": "https://evil.example"},
                )
                res = conn.getresponse()
                denied = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 403)
                self.assertEqual(denied["error"], "cross-origin request denied")

                conn.request(
                    "POST",
                    "/api/channels",
                    body=json.dumps({"name": "allowed"}),
                    headers={"Content-Type": "application/json", "Cookie": cookie, "Origin": "https://agents.example"},
                )
                res = conn.getresponse()
                created = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 201)
                self.assertEqual(created["channel"]["name"], "allowed")
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)

    def test_security_config_can_enable_public_https_cookie_without_restart(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            service = EnterpriseService(config, agent_client=RecordingAgent())
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            origin = f"http://{host}:{port}"
            try:
                conn = http.client.HTTPConnection(host, port, timeout=5)
                conn.request(
                    "POST",
                    "/api/auth/login",
                    body=json.dumps({"username": "admin", "password": "admin"}),
                    headers={"Content-Type": "application/json", "Origin": origin},
                )
                res = conn.getresponse()
                res.read()
                cookie = res.getheader("Set-Cookie")
                self.assertEqual(res.status, 200)
                self.assertNotIn("Secure", cookie)

                conn.request(
                    "PUT",
                    "/api/system/security/config",
                    body=json.dumps(
                        {
                            "public_base_url": "https://agents.example",
                            "trusted_proxy": True,
                            "host": "127.0.0.1",
                            "port": 8766,
                            "session_ttl_seconds": 7200,
                        }
                    ),
                    headers={"Content-Type": "application/json", "Cookie": cookie, "Origin": origin},
                )
                res = conn.getresponse()
                updated = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 200)
                security = updated["config"]
                self.assertEqual(security["public_base_url"], "https://agents.example")
                self.assertTrue(security["secure_cookie_enabled"])
                self.assertTrue(security["trusted_proxy"])
                self.assertTrue(security["listen_restart_required"])
                self.assertEqual(security["session_ttl_seconds"], 7200)

                conn.request(
                    "POST",
                    "/api/auth/login",
                    body=json.dumps({"username": "admin", "password": "admin"}),
                    headers={"Content-Type": "application/json", "Origin": "https://agents.example"},
                )
                res = conn.getresponse()
                res.read()
                secure_cookie = res.getheader("Set-Cookie")
                self.assertEqual(res.status, 200)
                self.assertIn("Secure", secure_cookie)
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)

    def test_security_config_rejects_invalid_public_settings(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                with self.assertRaises(ServiceError) as bad_url:
                    service.update_platform_security_config(admin, {"public_base_url": "javascript:alert(1)"})
                self.assertEqual(bad_url.exception.status, 400)
                with self.assertRaises(ServiceError) as bad_port:
                    service.update_platform_security_config(admin, {"port": 70000})
                self.assertEqual(bad_port.exception.status, 400)
                with self.assertRaises(ServiceError) as bad_secret:
                    service.update_platform_security_config(admin, {"session_secret": "short"})
                self.assertEqual(bad_secret.exception.status, 400)
            finally:
                service.close()

    def test_csrf_requires_origin_for_cookie_requests_but_exempts_bearer(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            service = EnterpriseService(config, agent_client=RecordingAgent())
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            origin = f"http://{host}:{port}"
            try:
                token, _ = service.authenticate("admin", "admin")
                conn = http.client.HTTPConnection(host, port, timeout=5)
                conn.request(
                    "POST",
                    "/api/auth/login",
                    body=json.dumps({"username": "admin", "password": "admin"}),
                    headers={"Content-Type": "application/json", "Origin": origin},
                )
                res = conn.getresponse()
                res.read()
                cookie = res.getheader("Set-Cookie")

                # A cookie-authenticated state-changing request with no Origin
                # or Referer must be refused (closes the no-header CSRF bypass).
                conn.request(
                    "POST",
                    "/api/channels",
                    body=json.dumps({"name": "no-origin"}),
                    headers={"Content-Type": "application/json", "Cookie": cookie},
                )
                res = conn.getresponse()
                denied = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 403)
                self.assertIn("Origin", denied["error"])

                # A bearer-token request is exempt (not forgeable cross-origin).
                conn.request(
                    "POST",
                    "/api/channels",
                    body=json.dumps({"name": "bearer-ok"}),
                    headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
                )
                res = conn.getresponse()
                created = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 201)
                self.assertEqual(created["channel"]["name"], "bearer-ok")
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)

    def test_scope_events_stream_emits_update(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            service = EnterpriseService(config, agent_client=RecordingAgent())
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            try:
                token, _ = service.authenticate("admin", "admin")
                conn = http.client.HTTPConnection(host, port, timeout=5)
                conn.request("GET", "/api/channels/1/events", headers={"Authorization": f"Bearer {token}"})
                res = conn.getresponse()
                self.assertEqual(res.status, 200)
                self.assertIn("text/event-stream", res.getheader("Content-Type"))
                buf = b""
                event_block = None
                deadline = time.time() + 5
                while time.time() < deadline:
                    chunk = res.read(1)
                    if not chunk:
                        break
                    buf += chunk
                    while b"\n\n" in buf:
                        block, buf = buf.split(b"\n\n", 1)
                        text = block.decode("utf-8")
                        if text.startswith("event: update"):
                            event_block = text
                            break
                    if event_block:
                        break
                self.assertIsNotNone(event_block)
                self.assertIn('"agent_status"', event_block)
                self.assertIn('"latest_message_id"', event_block)
                conn.close()
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)

    def test_attachment_inline_is_limited_to_safe_image_mime_types(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            server, thread = serve_in_thread(make_config(Path(td)), service)
            host, port = server.server_address
            try:
                token, admin = service.authenticate("admin", "admin")
                svg_message = service.send_channel_message(
                    admin,
                    1,
                    "svg",
                    [UploadedFile("diagram.svg", "image/svg+xml", b"<svg><script>alert(1)</script></svg>")],
                )["user_message"]
                png_message = service.send_channel_message(
                    admin,
                    1,
                    "png",
                    [UploadedFile("pixel.png", "image/png", b"\x89PNG\r\n\x1a\n")],
                )["user_message"]
                self.assertFalse(svg_message["attachments"][0]["is_image"])
                self.assertTrue(png_message["attachments"][0]["is_image"])

                conn = http.client.HTTPConnection(host, port, timeout=5)
                conn.request("GET", svg_message["attachments"][0]["url"], headers={"Authorization": f"Bearer {token}"})
                res = conn.getresponse()
                res.read()
                self.assertEqual(res.status, 200)
                self.assertTrue(res.getheader("Content-Disposition").startswith("attachment;"))

                conn.request("GET", png_message["attachments"][0]["url"], headers={"Authorization": f"Bearer {token}"})
                res = conn.getresponse()
                res.read()
                self.assertEqual(res.status, 200)
                self.assertTrue(res.getheader("Content-Disposition").startswith("inline;"))
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)

    def test_login_and_channel_message_over_http(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(
                make_config(Path(td)),
                agent_client=RecordingAgent(),
                hermes_bridge=FakeHermesBridge(),
            )
            server, thread = serve_in_thread(make_config(Path(td)), service)
            host, port = server.server_address
            try:
                conn = http.client.HTTPConnection(host, port, timeout=5)
                origin = f"http://{host}:{port}"
                conn.request(
                    "POST",
                    "/api/auth/login",
                    body=json.dumps({"username": "admin", "password": "admin"}),
                    headers={"Content-Type": "application/json", "Origin": origin},
                )
                res = conn.getresponse()
                body = json.loads(res.read().decode("utf-8"))
                cookie = res.getheader("Set-Cookie")
                self.assertEqual(res.status, 200)
                self.assertEqual(body["user"]["username"], "admin")
                admin = body["user"]

                conn.request("GET", "/api/channels", headers={"Cookie": cookie})
                res = conn.getresponse()
                channels = json.loads(res.read().decode("utf-8"))["channels"]
                self.assertEqual(channels[0]["name"], "general")

                conn.request("GET", "/api/system/runtime", headers={"Cookie": cookie})
                res = conn.getresponse()
                runtime = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 200)
                self.assertIn("hermes", runtime)
                self.assertIn("cognee", runtime)

                conn.request("GET", "/api/system/hermes/config", headers={"Cookie": cookie})
                res = conn.getresponse()
                hermes_config = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 200)
                self.assertIn("config", hermes_config)
                self.assertIn("repo_path", hermes_config["config"])

                conn.request("GET", "/api/permission-groups", headers={"Cookie": cookie})
                res = conn.getresponse()
                groups = json.loads(res.read().decode("utf-8"))["permission_groups"]
                self.assertEqual(res.status, 200)
                self.assertIn("admin", {group["id"] for group in groups})

                conn.request(
                    "POST",
                    "/api/users",
                    body=json.dumps({
                        "username": "http-user",
                        "password": "http-pass",
                        "display_name": "HTTP User",
                        "position": "Designer",
                        "permission_group": "member",
                        "model_name": "gpt-5.4",
                        "thinking_depth": "minimal",
                    }),
                    headers={"Content-Type": "application/json", "Cookie": cookie, "Origin": origin},
                )
                res = conn.getresponse()
                created_user = json.loads(res.read().decode("utf-8"))["user"]
                self.assertEqual(res.status, 201)
                self.assertEqual(created_user["position"], "Designer")
                self.assertEqual(created_user["model_name"], "gpt-5.4")

                conn.request(
                    "PUT",
                    f"/api/users/{created_user['id']}",
                    body=json.dumps({"permission_group": "manager", "thinking_depth": "high"}),
                    headers={"Content-Type": "application/json", "Cookie": cookie, "Origin": origin},
                )
                res = conn.getresponse()
                updated_user = json.loads(res.read().decode("utf-8"))["user"]
                self.assertEqual(res.status, 200)
                self.assertEqual(updated_user["permission_group"], "manager")
                self.assertEqual(updated_user["thinking_depth"], "high")

                conn.request(
                    "POST",
                    f"/api/channels/{channels[0]['id']}/messages",
                    body=json.dumps({"content": "hello"}),
                    headers={"Content-Type": "application/json", "Cookie": cookie, "Origin": origin},
                )
                res = conn.getresponse()
                payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 201)
                self.assertEqual(payload["user_message"]["content"], "hello")
                self.assertIsNone(payload["agent_message"])
                self.assertEqual(payload["agent_status"]["state"], "idle")
                service.wait_for_agent_idle("channel", str(channels[0]["id"]))

                boundary = "----enterprise-platform-test"
                multipart = (
                    f"--{boundary}\r\n"
                    'Content-Disposition: form-data; name="content"\r\n\r\n'
                    "file upload\r\n"
                    f"--{boundary}\r\n"
                    'Content-Disposition: form-data; name="files"; filename="note.txt"\r\n'
                    "Content-Type: text/plain\r\n\r\n"
                    "hello file\r\n"
                    f"--{boundary}--\r\n"
                ).encode("utf-8")
                conn.request(
                    "POST",
                    f"/api/channels/{channels[0]['id']}/messages",
                    body=multipart,
                    headers={"Content-Type": f"multipart/form-data; boundary={boundary}", "Cookie": cookie, "Origin": origin},
                )
                res = conn.getresponse()
                payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 201)
                self.assertEqual(payload["user_message"]["attachments"][0]["filename"], "note.txt")

                conn.request("GET", payload["user_message"]["attachments"][0]["url"], headers={"Cookie": cookie})
                res = conn.getresponse()
                self.assertTrue(res.getheader("Content-Disposition").startswith("attachment;"))
                attachment_body = res.read()
                self.assertEqual(res.status, 200)
                self.assertEqual(attachment_body, b"hello file")

                conn.request("GET", "/api/mention-targets", headers={"Cookie": cookie})
                res = conn.getresponse()
                payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 200)
                self.assertEqual(payload["targets"][0]["handle"], "agent")

                conn.request(
                    "POST",
                    f"/api/channels/{channels[0]['id']}/messages",
                    body=json.dumps({"content": "@agent hello"}),
                    headers={"Content-Type": "application/json", "Cookie": cookie, "Origin": origin},
                )
                res = conn.getresponse()
                payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 201)
                self.assertEqual(payload["user_message"]["content"], "@agent hello")
                self.assertIn(payload["agent_status"]["state"], {"queued", "replying", "idle"})
                service.wait_for_agent_idle("channel", str(channels[0]["id"]))

                conn.request("GET", f"/api/channels/{channels[0]['id']}/messages", headers={"Cookie": cookie})
                res = conn.getresponse()
                payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 200)
                self.assertEqual(payload["messages"][-1]["content"], "agent response to Administrator: hello")
                self.assertEqual(payload["messages"][-1]["metadata"]["agent_work"]["state"], "complete")
                self.assertEqual(payload["agent_status"]["state"], "idle")

                conn.request("GET", f"/api/admin/channels/{channels[0]['id']}/messages?limit=10", headers={"Cookie": cookie})
                res = conn.getresponse()
                audit_payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 200)
                self.assertGreaterEqual(audit_payload["total"], 3)
                hello_message = next(message for message in audit_payload["messages"] if message["content"] == "hello")

                conn.request(
                    "DELETE",
                    f"/api/admin/channels/{channels[0]['id']}/messages/{hello_message['id']}",
                    body="{}",
                    headers={"Content-Type": "application/json", "Cookie": cookie, "Origin": origin},
                )
                res = conn.getresponse()
                delete_payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 200)
                self.assertEqual(delete_payload["deleted"], 1)

                conn.request("GET", "/api/admin/private-agent/conversations", headers={"Cookie": cookie})
                res = conn.getresponse()
                private_payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 200)
                self.assertIn("admin", {item["username"] for item in private_payload["conversations"]})

                conn.request(
                    "POST",
                    "/api/private-agent/messages",
                    body=json.dumps({"content": "private http"}),
                    headers={"Content-Type": "application/json", "Cookie": cookie, "Origin": origin},
                )
                res = conn.getresponse()
                private_message_payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 201)
                self.assertEqual(private_message_payload["user_message"]["content"], "private http")
                service.wait_for_agent_idle("private", str(admin["id"]))

                conn.request(
                    "GET",
                    f"/api/admin/private-agent/conversations/{admin['id']}/messages?limit=10",
                    headers={"Cookie": cookie},
                )
                res = conn.getresponse()
                private_audit_payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 200)
                private_http_message = next(
                    message for message in private_audit_payload["messages"] if message["content"] == "private http"
                )

                conn.request(
                    "DELETE",
                    f"/api/admin/private-agent/conversations/{admin['id']}/messages/{private_http_message['id']}",
                    body="{}",
                    headers={"Content-Type": "application/json", "Cookie": cookie, "Origin": origin},
                )
                res = conn.getresponse()
                private_delete_payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 200)
                self.assertEqual(private_delete_payload["deleted"], 1)
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
