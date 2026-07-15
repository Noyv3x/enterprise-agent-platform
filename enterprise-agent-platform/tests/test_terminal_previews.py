from __future__ import annotations

import http.client
import json
import tempfile
import unittest
from pathlib import Path

from enterprise_agent_platform.agent_runtime_client import AgentResult
from enterprise_agent_platform.config import PlatformConfig
from enterprise_agent_platform.server import serve_in_thread
from enterprise_agent_platform.service import EnterpriseService, ServiceError


class PreviewAgent:
    def __init__(self) -> None:
        self.preview_calls: list[tuple[str, str]] = []
        self.processes: list[dict] = []

    def generate(self, **kwargs):
        return AgentResult(
            content="ok",
            session_id=kwargs["session_id"],
            raw={"ok": True},
        )

    def terminal_previews(self, scope_key: str, lifecycle_id: str) -> dict:
        self.preview_calls.append((scope_key, lifecycle_id))
        return {"processes": list(self.processes)}


def make_config(root: Path) -> PlatformConfig:
    return PlatformConfig(
        data_dir=root,
        host="127.0.0.1",
        port=0,
        public_base_url="http://127.0.0.1:0",
        token_secret="terminal-preview-test-secret",
        token_ttl_seconds=3600,
        agent_tool_token="agent-tool-token",
        knowledge_backend="local",
        cognee_dataset="knowledge",
        cognee_ingest_background=False,
        cognee_repo=root / "cognee",
        manage_cognee=False,
        manage_camofox=False,
        manage_firecrawl=False,
        firecrawl_repo=root / "firecrawl",
        allow_insecure_bootstrap_password=True,
        manage_agent_runtime=False,
        agent_runtime_url="http://127.0.0.1:18766",
        agent_runtime_token="runtime-token",
        agent_runtime_home=root / "runtimes" / "agent",
        runtime_startup_wait_seconds=0,
    )


class TerminalPreviewTests(unittest.TestCase):
    def test_preview_does_not_create_scope_and_platform_reapplies_a_field_allowlist(self):
        with tempfile.TemporaryDirectory() as td:
            agent = PreviewAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _token, admin = service.authenticate("admin", "admin")
                scope_key = service.agent_scopes.private_scope_key(int(admin["id"]))
                self.assertIsNone(service.agent_scopes.get_scope(scope_key))

                self.assertEqual(
                    service.agent_terminal_previews(admin, "private", str(admin["id"])),
                    {"processes": []},
                )
                self.assertIsNone(service.agent_scopes.get_scope(scope_key))
                self.assertEqual(agent.preview_calls, [])

                scope = service.agent_scopes.ensure_private_scope(int(admin["id"]))
                agent.processes = [
                    {
                        "id": "process-1",
                        "title": "T" * 300,
                        "command": (
                            "curl -b 'sid=cookie-switch-secret' --cookie=session=cookie-long-secret "
                            "-u user:user-password "
                            "-H 'Cookie: sid=first-header-secret; theme=second-header-secret' "
                            "'https://example.test/run?token=query-token-secret"
                            "&password=query-password-secret&cookie=query-cookie-secret"
                            "&auth=query-auth-secret&session=query-session-secret' "
                            "github_pat_abcdefghijklmnopqrstuvwxyz"
                        ),
                        "cwd": "/workspace/" + "d" * 3000,
                        "stdout": "\x1b]0;unsafe-title\x07\x1b[31mhello\x1b[0m\x01",
                        "stderr": "warning",
                        "output": "hello\n[stderr]\nwarning",
                        "status": "running",
                        "started_at": "2026-07-15T00:00:00Z",
                        "updated_at": "2026-07-15T00:00:01Z",
                        "truncated": True,
                        "pid": 123,
                        "run_id": "internal-run",
                        "scope_key": "private:other",
                        "lifecycle_id": "internal-life",
                        "unexpected": "do not expose",
                    }
                ]

                result = service.agent_terminal_previews(admin, "private", str(admin["id"]))
                self.assertEqual(agent.preview_calls, [(scope.scope_key, scope.lifecycle_id)])
                process = result["processes"][0]
                self.assertEqual(
                    set(process),
                    {
                        "id",
                        "title",
                        "command",
                        "cwd",
                        "stdout",
                        "stderr",
                        "output",
                        "status",
                        "running",
                        "started_at",
                        "updated_at",
                        "truncated",
                    },
                )
                self.assertEqual(process["stdout"], "hello")
                self.assertLessEqual(len(process["title"].encode("utf-8")), 200)
                self.assertLessEqual(len(process["command"].encode("utf-8")), 4 * 1024)
                self.assertLessEqual(len(process["cwd"].encode("utf-8")), 2 * 1024)
                for secret in (
                    "cookie-switch-secret",
                    "cookie-long-secret",
                    "user-password",
                    "first-header-secret",
                    "second-header-secret",
                    "query-token-secret",
                    "query-password-secret",
                    "query-cookie-secret",
                    "query-auth-secret",
                    "query-session-secret",
                    "github_pat_abcdefghijklmnopqrstuvwxyz",
                ):
                    self.assertNotIn(secret, process["command"])

                member = service.create_user(
                    username="preview-member",
                    password="member-password",
                    display_name="Preview Member",
                    role="member",
                    actor=admin,
                )
                _member_token, member_actor = service.authenticate("preview-member", "member-password")
                with self.assertRaises(ServiceError) as denied:
                    service.agent_terminal_previews(member_actor, "private", str(admin["id"]))
                self.assertEqual(denied.exception.status, 403)
                self.assertNotEqual(member["id"], admin["id"])
            finally:
                service.close()

    def test_http_preview_supports_etag_without_exposing_a_write_contract(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            agent = PreviewAgent()
            service = EnterpriseService(config, agent_client=agent)
            token, admin = service.authenticate("admin", "admin")
            service.agent_scopes.ensure_private_scope(int(admin["id"]))
            agent.processes = [
                {
                    "id": "process-http",
                    "title": "Terminal 1",
                    "command": "printf hello",
                    "cwd": "/workspace",
                    "stdout": "hello",
                    "stderr": "",
                    "output": "hello",
                    "status": "completed",
                    "running": False,
                    "started_at": "2026-07-15T00:00:00Z",
                    "updated_at": "2026-07-15T00:00:01Z",
                    "exit_code": 0,
                    "truncated": False,
                }
            ]
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            path = (
                "/api/agent-previews/terminals"
                f"?scope_type=private&scope_id={admin['id']}"
            )
            try:
                connection = http.client.HTTPConnection(host, port, timeout=5)
                connection.request("GET", path)
                unauthorized = connection.getresponse()
                unauthorized.read()
                self.assertEqual(unauthorized.status, 401)

                headers = {"Authorization": f"Bearer {token}"}
                connection.request("GET", path, headers=headers)
                response = connection.getresponse()
                body = json.loads(response.read().decode("utf-8"))
                etag = response.getheader("ETag")
                self.assertEqual(response.status, 200)
                self.assertEqual(body["processes"][0]["output"], "hello")
                self.assertTrue(etag)
                self.assertEqual(response.getheader("Cache-Control"), "private, no-cache, max-age=0")
                self.assertEqual(response.getheader("Cross-Origin-Resource-Policy"), "same-origin")

                connection.request(
                    "GET",
                    path,
                    headers={**headers, "If-None-Match": f'"unrelated", W/{etag}'},
                )
                unchanged = connection.getresponse()
                self.assertEqual(unchanged.status, 304)
                self.assertEqual(unchanged.getheader("Content-Length"), "0")
                self.assertEqual(unchanged.getheader("Cross-Origin-Resource-Policy"), "same-origin")
                self.assertEqual(unchanged.read(), b"")

                connection.request(
                    "POST",
                    path,
                    body="{}",
                    headers={**headers, "Content-Type": "application/json"},
                )
                read_only = connection.getresponse()
                read_only.read()
                self.assertIn(read_only.status, {403, 404, 405})
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
