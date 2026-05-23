from __future__ import annotations

import http.client
import json
import tempfile
import unittest
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
    )


class PlatformServiceTests(unittest.TestCase):
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

    def test_agent_tool_token_protects_knowledge_endpoints(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            _, user = service.authenticate("admin", "admin")
            doc = service.add_knowledge_document(user, {"title": "Runbook", "content": "Restart service alpha."})

            self.assertFalse(service.validate_agent_tool_token("wrong"))
            self.assertTrue(service.validate_agent_tool_token("agent-token"))
            self.assertEqual(service.get_knowledge_document(doc["id"])["title"], "Runbook")
            service.close()


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
