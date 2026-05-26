from __future__ import annotations

import http.client
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
from dataclasses import replace
from pathlib import Path

from enterprise_agent_platform.config import PlatformConfig
from enterprise_agent_platform.hermes import AgentResult
from enterprise_agent_platform.oauth_flows import OAuthHTTPResponse
from enterprise_agent_platform.server import serve_in_thread
from enterprise_agent_platform.service import EnterpriseService, ServiceError


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
        hermes_home=tmp / "runtimes" / "hermes",
        runtime_startup_wait_seconds=0,
    )


def make_fake_hermes_repo(path: Path) -> None:
    (path / "hermes_cli").mkdir(parents=True, exist_ok=True)
    (path / "hermes_cli" / "__init__.py").write_text("", encoding="utf-8")
    (path / "hermes_cli" / "main.py").write_text("def main(): pass\n", encoding="utf-8")
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


def managed_python(home: Path) -> Path:
    return home / ("Scripts" if os.name == "nt" else "bin") / ("python.exe" if os.name == "nt" else "python")


class PlatformServiceTests(unittest.TestCase):
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
            agent = RecordingAgent()
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
            self.assertIn({"role": "user", "content": "Administrator: VPN onboarding starts in the general channel."}, agent.calls[-1]["history"])
            self.assertIn({"role": "user", "content": "Alice: I need device posture details before Friday."}, agent.calls[-1]["history"])
            self.assertIn("enterprise_kb_search", agent.calls[-1]["system_prompt"])
            self.assertTrue(agent.calls[-1]["metadata"]["knowledge_suggestions"])
            work = agent_message["metadata"]["agent_work"]
            self.assertEqual(work["state"], "complete")
            self.assertEqual(work["run_id"], f"channel:1:{result['user_message']['id']}")
            self.assertIn("model", [item["stage"] for item in work["activity"]])
            self.assertIn("complete", [item["stage"] for item in work["activity"]])
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
                self.assertEqual(status["current_step"], "调用 Hermes Agent")
                self.assertIn("model", [item["stage"] for item in status["activity"]])
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

    def test_admin_can_manage_account_permissions_and_model_policy(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                user = service.create_user(
                    username="alice",
                    password="alice-pass",
                    display_name="Alice",
                    position="Analyst",
                    permission_group="viewer",
                    model_name="gpt-5.3-codex",
                    thinking_depth="low",
                    actor=admin,
                )

                self.assertEqual(user["position"], "Analyst")
                self.assertEqual(user["permission_group"], "viewer")
                self.assertEqual(user["role"], "member")
                self.assertEqual(user["model_name"], "gpt-5.3-codex")
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
                        "model_name": "grok-4.3",
                        "thinking_depth": "high",
                    },
                )
                self.assertEqual(updated["position"], "Engineering Manager")
                self.assertEqual(updated["permission_group"], "manager")
                self.assertIn("manage_knowledge", updated["permissions"])
                self.assertEqual(updated["model_name"], "grok-4.3")
                self.assertEqual(updated["thinking_depth"], "high")

                _, member_actor = service.authenticate("alice", "alice-pass")
                with self.assertRaises(ServiceError) as list_error:
                    service.list_users(member_actor)
                self.assertEqual(list_error.exception.status, 403)
                with self.assertRaises(ServiceError) as update_error:
                    service.update_user(member_actor, admin["id"], {"position": "Owner"})
                self.assertEqual(update_error.exception.status, 403)
            finally:
                service.close()

    def test_account_model_and_thinking_depth_are_used_for_agent_calls(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, admin = service.authenticate("admin", "admin")
                service.create_user(
                    username="bob",
                    password="bob-pass",
                    display_name="Bob",
                    permission_group="member",
                    model_name="grok-4.3",
                    thinking_depth="xhigh",
                    actor=admin,
                )
                _, bob = service.authenticate("bob", "bob-pass")

                result = service.send_private_message(bob, "draft a plan")
                self.assertIsNone(result["agent_message"])
                service.wait_for_agent_idle("private", str(bob["id"]))
                agent_message = service.list_messages(bob, "private", str(bob["id"]))[-1]

                self.assertEqual(agent.calls[-1]["model"], "grok-4.3")
                self.assertEqual(agent.calls[-1]["thinking_depth"], "xhigh")
                self.assertEqual(agent.calls[-1]["reasoning_config"], {"enabled": True, "effort": "xhigh"})
                self.assertEqual(agent_message["metadata"]["generation"]["model"], "grok-4.3")
                self.assertEqual(agent_message["metadata"]["generation"]["thinking_depth"], "xhigh")
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
            runner = RecordingCommandRunner()
            service = EnterpriseService(make_config(tmp), agent_client=RecordingAgent(), runtime_command_runner=runner)
            try:
                hermes_home = service.config.managed_hermes_home
                self.assertTrue((hermes_home / "plugins" / "enterprise_kb" / "plugin.yaml").exists())
                config_text = (hermes_home / "config.yaml").read_text(encoding="utf-8")
                env_text = (hermes_home / ".env").read_text(encoding="utf-8")

                self.assertIn("enterprise-kb", config_text)
                self.assertIn('API_SERVER_ENABLED="true"', env_text)
                self.assertIn('ENTERPRISE_AGENT_TOOL_TOKEN="agent-token"', env_text)
                self.assertIn("API_SERVER_KEY=", env_text)

                _, admin = service.authenticate("admin", "admin")
                status = service.runtime_status(admin)
                self.assertEqual(status["hermes"]["managed"], True)
                self.assertEqual(status["hermes"]["install_state"], "installed")
                self.assertEqual(status["cognee"]["managed"], True)
                self.assertEqual(status["cognee"]["state"], "prepared")
                install_commands = [call["cmd"] for call in runner.calls]
                self.assertIn([str(managed_python(hermes_home / "venv")), "-m", "pip", "install", "-e", str(tmp / "hermes-agent")], install_commands)
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
                launch = launcher.calls[0]
                self.assertEqual(launch["cwd"], tmp / "hermes-agent")
                self.assertEqual(launch["cmd"][0], str(managed_python(config.managed_hermes_home / "venv")))
                self.assertIn("gateway", launch["cmd"])
                self.assertEqual(launch["env"]["HERMES_HOME"], str(config.managed_hermes_home))
                self.assertEqual(launch["env"]["API_SERVER_ENABLED"], "true")
                self.assertEqual(launch["env"]["ENTERPRISE_AGENT_TOOL_TOKEN"], "agent-token")
                self.assertTrue(agent_message["metadata"]["degraded"])
                self.assertIn("Hermes API is not reachable", agent_message["content"])
            finally:
                service.close()

    def test_first_run_installs_hermes_from_adjacent_source(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_fake_hermes_repo(tmp / "hermes-agent")
            runner = RecordingCommandRunner()
            service = EnterpriseService(make_config(tmp), agent_client=RecordingAgent(), runtime_command_runner=runner)
            try:
                hermes_home = service.config.managed_hermes_home
                self.assertTrue((hermes_home / "install.json").exists())
                self.assertEqual(runner.calls[0]["cmd"][:3], [sys.executable, "-m", "venv"])
                self.assertEqual(runner.calls[0]["cmd"][3], str(hermes_home / "venv"))
                self.assertEqual(
                    runner.calls[1]["cmd"],
                    [str(managed_python(hermes_home / "venv")), "-m", "pip", "install", "-e", str(tmp / "hermes-agent")],
                )
                _, admin = service.authenticate("admin", "admin")
                status = service.runtime_status(admin)["hermes"]
                self.assertEqual(status["install_state"], "installed")
                self.assertEqual(status["source"], str(tmp / "hermes-agent"))
            finally:
                service.close()

    def test_hermes_config_can_be_updated_from_platform(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_fake_hermes_repo(tmp / "hermes-agent")
            runner = RecordingCommandRunner()
            service = EnterpriseService(make_config(tmp), agent_client=RecordingAgent(), runtime_command_runner=runner)
            try:
                _, admin = service.authenticate("admin", "admin")
                result = service.update_hermes_config(
                    admin,
                    {
                        "manage_hermes": True,
                        "repo_path": str(tmp / "hermes-agent"),
                        "api_url": "http://127.0.0.1:8766/v1/chat/completions",
                        "model": "enterprise-hermes",
                        "install_extras": "dev",
                        "startup_wait_seconds": 3.5,
                        "api_key": "runtime-key",
                    },
                )

                self.assertEqual(result["config"]["api_port"], 8766)
                self.assertEqual(result["config"]["model"], "enterprise-hermes")
                self.assertEqual(result["config"]["install_extras"], "dev")
                env_text = (service.config.managed_hermes_home / ".env").read_text(encoding="utf-8")
                self.assertIn('API_SERVER_PORT="8766"', env_text)
                self.assertIn('API_SERVER_MODEL_NAME="enterprise-hermes"', env_text)
                self.assertIn('API_SERVER_KEY="runtime-key"', env_text)
                self.assertEqual(
                    runner.calls[-1]["cmd"],
                    [
                        str(managed_python(service.config.managed_hermes_home / "venv")),
                        "-m",
                        "pip",
                        "install",
                        "-e",
                        f"{tmp / 'hermes-agent'}[dev]",
                    ],
                )
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
                yaml_keys = {item["key"] for item in current["internal"]["fields"]}
                env_by_key = {item["key"]: item for item in current["internal"]["env"]}

                self.assertIn("agent.max_turns", yaml_keys)
                self.assertIn("display.show_reasoning", yaml_keys)
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
            service = EnterpriseService(make_config(tmp), agent_client=RecordingAgent(), runtime_command_runner=runner)
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
                self.assertEqual(codex_config["model"], "gpt-5.3-codex")
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
    def test_login_and_channel_message_over_http(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            server, thread = serve_in_thread(make_config(Path(td)), service)
            host, port = server.server_address
            try:
                conn = http.client.HTTPConnection(host, port, timeout=5)
                conn.request(
                    "POST",
                    "/api/auth/login",
                    body=json.dumps({"username": "admin", "password": "admin"}),
                    headers={"Content-Type": "application/json"},
                )
                res = conn.getresponse()
                body = json.loads(res.read().decode("utf-8"))
                cookie = res.getheader("Set-Cookie")
                self.assertEqual(res.status, 200)
                self.assertEqual(body["user"]["username"], "admin")

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
                        "model_name": "gpt-5.3-codex",
                        "thinking_depth": "minimal",
                    }),
                    headers={"Content-Type": "application/json", "Cookie": cookie},
                )
                res = conn.getresponse()
                created_user = json.loads(res.read().decode("utf-8"))["user"]
                self.assertEqual(res.status, 201)
                self.assertEqual(created_user["position"], "Designer")
                self.assertEqual(created_user["model_name"], "gpt-5.3-codex")

                conn.request(
                    "PUT",
                    f"/api/users/{created_user['id']}",
                    body=json.dumps({"permission_group": "manager", "thinking_depth": "high"}),
                    headers={"Content-Type": "application/json", "Cookie": cookie},
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
                    headers={"Content-Type": "application/json", "Cookie": cookie},
                )
                res = conn.getresponse()
                payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 201)
                self.assertEqual(payload["user_message"]["content"], "hello")
                self.assertIsNone(payload["agent_message"])
                self.assertEqual(payload["agent_status"]["state"], "idle")
                service.wait_for_agent_idle("channel", str(channels[0]["id"]))

                conn.request("GET", "/api/mention-targets", headers={"Cookie": cookie})
                res = conn.getresponse()
                payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 200)
                self.assertEqual(payload["targets"][0]["handle"], "agent")

                conn.request(
                    "POST",
                    f"/api/channels/{channels[0]['id']}/messages",
                    body=json.dumps({"content": "@agent hello"}),
                    headers={"Content-Type": "application/json", "Cookie": cookie},
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
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
