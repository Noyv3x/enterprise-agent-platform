from __future__ import annotations

import http.client
import json
import os
import subprocess
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from enterprise_agent_platform.config import PlatformConfig
from enterprise_agent_platform.hermes import AgentResult
from enterprise_agent_platform.server import serve_in_thread
from enterprise_agent_platform.service import EnterpriseService


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

            result = service.send_channel_message(user, 1, "What is the VPN access policy?")

            self.assertEqual(result["agent_message"]["username"], "Main Agent")
            self.assertEqual(agent.calls[-1]["session_id"], "enterprise-channel-1-main-agent")
            self.assertEqual(agent.calls[-1]["session_key"], "channel:1:main-agent")
            self.assertIn("enterprise_kb_search", agent.calls[-1]["system_prompt"])
            self.assertTrue(agent.calls[-1]["metadata"]["knowledge_suggestions"])
            service.close()

    def test_private_agent_creates_local_workspace_and_independent_session(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            _, user = service.authenticate("admin", "admin")

            result = service.send_private_message(user, "Create a project plan")

            container = result["container"]
            self.assertEqual(container["backend"], "local")
            self.assertTrue(Path(container["workspace_path"]).exists())
            self.assertEqual(agent.calls[-1]["session_id"], "enterprise-private-u1")
            self.assertEqual(agent.calls[-1]["session_key"], "private:1")
            service.close()

    def test_multiple_users_share_channel_main_agent_but_keep_private_key_injection(self):
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
            service.set_secret(admin, "OPENAI_API_KEY", "sk-test-value")

            service.send_channel_message(admin, 1, "admin asks")
            service.send_channel_message(member, 1, "member asks")
            channel_sessions = [call["session_id"] for call in agent.calls[-2:]]
            self.assertEqual(channel_sessions, ["enterprise-channel-1-main-agent", "enterprise-channel-1-main-agent"])

            private = service.send_private_message(member, "private task")
            self.assertEqual(private["container"]["session_id"], "enterprise-private-u2")
            self.assertEqual(service.model_secret_env()["OPENAI_API_KEY"], "sk-test-value")
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
                self.assertIn("XAI_OAUTH_REFRESH_TOKEN", keys)

                service.set_secret(admin, "CODEX_OAUTH_ACCESS_TOKEN", "codex-access")
                self.assertNotIn("CODEX_OAUTH_ACCESS_TOKEN", service.model_secret_env())
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
                hermes_timeout_seconds=0.2,
                runtime_startup_wait_seconds=0,
            )
            launcher = RecordingLauncher()
            runner = RecordingCommandRunner()
            service = EnterpriseService(config, runtime_process_launcher=launcher, runtime_command_runner=runner)
            try:
                _, user = service.authenticate("admin", "admin")
                result = service.send_channel_message(user, 1, "hello")

                self.assertTrue(launcher.calls)
                launch = launcher.calls[0]
                self.assertEqual(launch["cwd"], tmp / "hermes-agent")
                self.assertEqual(launch["cmd"][0], str(managed_python(config.managed_hermes_home / "venv")))
                self.assertIn("gateway", launch["cmd"])
                self.assertEqual(launch["env"]["HERMES_HOME"], str(config.managed_hermes_home))
                self.assertEqual(launch["env"]["API_SERVER_ENABLED"], "true")
                self.assertEqual(launch["env"]["ENTERPRISE_AGENT_TOOL_TOKEN"], "agent-token")
                self.assertTrue(result["agent_message"]["metadata"]["degraded"])
                self.assertIn("Hermes API is not reachable", result["agent_message"]["content"])
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
                _, admin = service.authenticate("admin", "admin")
                service.set_secret(admin, "OPENAI_API_KEY", "sk-test-value")
                service.runtimes.ensure_cognee_ready()

                self.assertEqual(os.environ["DATA_ROOT_DIRECTORY"], str(tmp / "runtimes" / "cognee" / "data"))
                self.assertEqual(os.environ["SYSTEM_ROOT_DIRECTORY"], str(tmp / "runtimes" / "cognee" / "system"))
                self.assertEqual(os.environ["CACHE_ROOT_DIRECTORY"], str(tmp / "runtimes" / "cognee" / "cache"))
                self.assertEqual(os.environ["COGNEE_LOGS_DIR"], str(tmp / "runtimes" / "cognee" / "logs"))
                self.assertEqual(os.environ["LLM_API_KEY"], "sk-test-value")
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

                conn.request(
                    "POST",
                    f"/api/channels/{channels[0]['id']}/messages",
                    body=json.dumps({"content": "hello"}),
                    headers={"Content-Type": "application/json", "Cookie": cookie},
                )
                res = conn.getresponse()
                payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 201)
                self.assertEqual(payload["agent_message"]["content"], "agent response to hello")
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
