from __future__ import annotations

import gzip
import http.client
import json
import tempfile
import unittest
from pathlib import Path

from enterprise_agent_platform.agent_runtime_client import (
    AgentResult,
    AgentRuntimeConnectionError,
)
from enterprise_agent_platform.config import PlatformConfig
from enterprise_agent_platform.server import serve_in_thread
from enterprise_agent_platform.service import EnterpriseService, ServiceError


class PreviewAgent:
    def __init__(self) -> None:
        self.preview_calls: list[tuple[str, str, int | str | None]] = []
        self.summary_calls: list[tuple[str, str]] = []
        self.processes: list[dict] = []
        self.revision = 7
        self.preview_error = False

    def generate(self, **kwargs):
        return AgentResult(
            content="ok",
            session_id=kwargs["session_id"],
            raw={"ok": True},
        )

    def terminal_previews(
        self,
        scope_key: str,
        lifecycle_id: str,
        since_revision: int | str | None = None,
    ) -> dict:
        self.preview_calls.append((scope_key, lifecycle_id, since_revision))
        if self.preview_error:
            raise AgentRuntimeConnectionError("runtime unavailable")
        if since_revision == self.revision:
            return {
                "processes": [],
                "revision": self.revision,
                "unchanged": True,
            }
        return {"processes": list(self.processes), "revision": self.revision}

    def terminal_preview_summary(self, scope_key: str, lifecycle_id: str) -> dict:
        self.summary_calls.append((scope_key, lifecycle_id))
        return {
            "running_terminal_count": sum(
                1
                for process in self.processes
                if process.get("status") == "running" or process.get("running") is True
            )
        }


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
                    {"processes": [], "revision": 0},
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
                self.assertEqual(
                    agent.preview_calls,
                    [(scope.scope_key, scope.lifecycle_id, None)],
                )
                process = result["processes"][0]
                self.assertEqual(
                    set(process),
                    {
                        "id",
                        "title",
                        "command",
                        "cwd",
                        "output",
                        "status",
                        "running",
                        "started_at",
                        "updated_at",
                        "truncated",
                    },
                )
                self.assertEqual(process["output"], "hello\n[stderr]\nwarning")
                self.assertEqual(result["revision"], 7)
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

    def test_runtime_failure_returns_a_full_empty_snapshot_that_clears_stale_terminals(self):
        with tempfile.TemporaryDirectory() as td:
            agent = PreviewAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _token, admin = service.authenticate("admin", "admin")
                service.agent_scopes.ensure_private_scope(int(admin["id"]))
                agent.processes = [
                    {
                        "id": "process-running",
                        "output": "live",
                        "status": "running",
                    }
                ]
                first = service.agent_terminal_previews(
                    admin,
                    "private",
                    str(admin["id"]),
                )
                self.assertEqual(len(first["processes"]), 1)
                self.assertEqual(first["revision"], agent.revision)

                agent.preview_error = True
                failed = service.agent_terminal_previews(
                    admin,
                    "private",
                    str(admin["id"]),
                    since_revision=agent.revision,
                )
                self.assertEqual(failed, {"processes": [], "revision": 0})
            finally:
                service.close()

    def test_http_preview_excludes_completed_processes_and_supports_etag(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            agent = PreviewAgent()
            agent.revision = "preview_abcdef0123456789:7"
            service = EnterpriseService(config, agent_client=agent)
            token, admin = service.authenticate("admin", "admin")
            service.agent_scopes.ensure_private_scope(int(admin["id"]))
            agent.processes = [
                {
                    "id": "process-completed",
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
                },
                {
                    "id": "process-running",
                    "title": "Terminal 2",
                    "command": "sleep 30",
                    "cwd": "/workspace",
                    "stdout": "live",
                    "stderr": "",
                    "output": "live" + ("x" * 2_048),
                    "status": "running",
                    "running": True,
                    "started_at": "2026-07-15T00:00:02Z",
                    "updated_at": "2026-07-15T00:00:03Z",
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
                connection.request(
                    "GET",
                    path,
                    headers={**headers, "Accept-Encoding": "gzip"},
                )
                response = connection.getresponse()
                response_body = response.read()
                self.assertEqual(response.getheader("Content-Encoding"), "gzip")
                self.assertEqual(
                    response.getheader("Vary"),
                    "Cookie, Authorization, Accept-Encoding",
                )
                body = json.loads(gzip.decompress(response_body))
                etag = response.getheader("ETag")
                self.assertEqual(response.status, 200)
                self.assertEqual(
                    [process["id"] for process in body["processes"]],
                    ["process-running"],
                )
                self.assertEqual(
                    body["processes"][0]["output"],
                    "live" + ("x" * 2_048),
                )
                self.assertTrue(etag)
                self.assertEqual(response.getheader("Cache-Control"), "private, no-cache, max-age=0")
                self.assertEqual(response.getheader("Cross-Origin-Resource-Policy"), "same-origin")

                connection.request(
                    "GET",
                    path + f"&since_revision={agent.revision}",
                    headers=headers,
                )
                revision_unchanged = connection.getresponse()
                revision_body = json.loads(
                    revision_unchanged.read().decode("utf-8")
                )
                self.assertEqual(revision_unchanged.status, 200)
                self.assertEqual(
                    revision_body,
                    {
                        "processes": [],
                        "revision": agent.revision,
                        "unchanged": True,
                    },
                )

                connection.request(
                    "GET",
                    path,
                    headers={
                        **headers,
                        "Accept-Encoding": "gzip",
                        "If-None-Match": f'"unrelated", W/{etag}',
                    },
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

                connection.request(
                    "GET",
                    path + "&since_revision=-1",
                    headers=headers,
                )
                invalid_revision = connection.getresponse()
                invalid_revision.read()
                self.assertEqual(invalid_revision.status, 400)
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
