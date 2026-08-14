from __future__ import annotations

import hashlib
import http.client
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from enterprise_agent_platform.server import serve_in_thread
from enterprise_agent_platform.service import (
    COMPUTER_PRESENT_MAX_BYTES,
    PRESENT_PAGE_CSP,
    ServiceError,
    agent_search_hits,
    agent_tool_parameters,
    project_computer_clues,
    workspace_relative_path,
)
from test_platform import MediaReturningAgent, RecordingAgent, make_config, make_xlsx_attachment
from test_preview_status import StatusAgent
from enterprise_agent_platform.service import EnterpriseService


class WorkspacePathProjectionTests(unittest.TestCase):
    def test_workspace_relative_path_accepts_only_workspace_descendants(self):
        self.assertEqual(workspace_relative_path("src/app.ts"), "src/app.ts")
        self.assertEqual(workspace_relative_path("/workspace/notes.html"), "notes.html")
        self.assertEqual(workspace_relative_path("/workspace/docs/index.htm"), "docs/index.htm")
        self.assertEqual(workspace_relative_path("/etc/passwd"), "")
        self.assertEqual(workspace_relative_path("../secret"), "")
        self.assertEqual(workspace_relative_path("/workspace/../etc/passwd"), "")
        self.assertEqual(workspace_relative_path(""), "")

    def test_file_tools_project_workspace_path_but_not_for_host_targets(self):
        self.assertEqual(
            agent_tool_parameters({
                "tool_name": "read_file",
                "arguments": {
                    "path": "/workspace/src/app.ts",
                    "offset": 10,
                    "limit": 40,
                    "target": "sandbox",
                },
            }),
            {
                "path": "…/app.ts",
                "offset": 10,
                "limit": 40,
                "target": "sandbox",
                "workspace_path": "src/app.ts",
            },
        )
        self.assertEqual(
            agent_tool_parameters({
                "tool_name": "write_file",
                "arguments": {"path": "notes/index.html"},
            }),
            {
                "path": "notes/index.html",
                "workspace_path": "notes/index.html",
            },
        )
        self.assertEqual(
            agent_tool_parameters({
                "tool_name": "read_file",
                "arguments": {"path": "/etc/shadow", "target": "host"},
            }),
            {"path": "…/shadow", "target": "host"},
        )


class ComputerSearchProjectionTests(unittest.TestCase):
    def test_web_and_knowledge_hits_are_closed_world_and_bounded(self):
        hits = agent_search_hits({
            "tool_name": "web",
            "result": {
                "web": [
                    {
                        "title": "Release notes",
                        "url": "https://user:pass@example.test/notes?token=secret",
                        "description": "Latest changes",
                    },
                    {"title": "Skip local", "url": "http://127.0.0.1/admin"},
                ]
            },
        })
        self.assertEqual(
            hits,
            [{
                "title": "Release notes",
                "url": "https://example.test/notes",
                "snippet": "Latest changes",
            }],
        )
        knowledge = agent_search_hits({
            "tool": "knowledge",
            "result": {
                "content": json.dumps({
                    "hits": [{
                        "title": "Runbook",
                        "summary": "How to recover",
                        "excerpt": "token=super-secret",
                    }]
                })
            },
        })
        self.assertEqual(knowledge[0]["title"], "Runbook")
        self.assertEqual(knowledge[0]["snippet"], "How to recover")
        self.assertNotIn("super-secret", json.dumps(knowledge))

    def test_search_files_hits_use_workspace_paths_not_raw_journal(self):
        hits = agent_search_hits({
            "tool": "search_files",
            "result": {
                "content": "src/app.ts: filename match\nsrc/app.ts:12:export function start()\nNo matches\n"
            },
        })
        self.assertEqual(hits[0]["workspace_path"], "src/app.ts")
        self.assertEqual(hits[1]["snippet"], "export function start()")
        self.assertNotIn("No matches", json.dumps(hits))

    def test_live_status_projects_search_and_html_present_without_persisting_hits(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, user = service.authenticate("admin", "admin")
                service._record_agent_progress(
                    "private",
                    str(user["id"]),
                    {
                        "event": "tool.completed",
                        "tool_name": "web",
                        "tool_call_id": "web-1",
                        "arguments": {"action": "search", "arguments": {"query": "docs"}},
                        "result": {
                            "web": [{
                                "title": "Docs",
                                "url": "https://example.test/docs",
                                "description": "Guide",
                            }]
                        },
                    },
                )
                status = service.agent_status(user, "private", str(user["id"]))
                self.assertEqual(status["computer"]["mode"], "search")
                self.assertEqual(status["computer"]["search"]["hits"][0]["title"], "Docs")
                self.assertNotIn("_computer_search", status)

                service._record_agent_progress(
                    "private",
                    str(user["id"]),
                    {
                        "event": "tool.completed",
                        "tool_name": "write_file",
                        "tool_call_id": "write-html",
                        "arguments": {
                            "path": "/workspace/report.html",
                            "content": "<html><body>hi</body></html>",
                        },
                    },
                )
                status = service.agent_status(user, "private", str(user["id"]))
                self.assertEqual(status["computer"]["mode"], "present")
                self.assertEqual(
                    status["computer"]["present"]["workspace_path"],
                    "report.html",
                )
                self.assertEqual(
                    status["computer"]["file"]["workspace_path"],
                    "report.html",
                )
                snapshot = service._agent_work_snapshot(
                    {
                        "scope_type": "private",
                        "scope_id": str(user["id"]),
                        "user_message": {"id": 1},
                        "actor": user,
                    },
                    "complete",
                )
                self.assertNotIn("computer", snapshot)
                self.assertNotIn("https://example.test/docs", json.dumps(snapshot))
                self.assertFalse(
                    any("hits" in json.dumps(item.get("parameters") or {}) for item in snapshot["activity"])
                )
            finally:
                service.close()


class ComputerPreviewHTTPTests(unittest.TestCase):
    def test_file_preview_reads_workspace_text_and_rejects_host_and_escape(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=StatusAgent())
            try:
                token, actor = service.authenticate("admin", "admin")
                scope = service.agent_scopes.ensure_private_scope(int(actor["id"]))
                workspace = Path(scope.workspace_path)
                (workspace / "notes").mkdir()
                (workspace / "notes" / "readme.md").write_text(
                    "hello TOKEN=super-secret\n",
                    encoding="utf-8",
                )
                (workspace / "notes" / "readme.md").chmod(0o600)
                payload = service.agent_preview_file(
                    actor,
                    "private",
                    str(actor["id"]),
                    "notes/readme.md",
                )
                self.assertEqual(payload["workspace_path"], "notes/readme.md")
                self.assertIn("hello", payload["content"])
                self.assertNotIn("super-secret", payload["content"])

                with self.assertRaises(ServiceError) as raised:
                    service.agent_preview_file(
                        actor,
                        "private",
                        str(actor["id"]),
                        "/etc/passwd",
                    )
                self.assertEqual(raised.exception.status, 400)

                foreign = Path(td) / "outside.txt"
                foreign.write_text("nope", encoding="utf-8")
                link = workspace / "escape.md"
                link.symlink_to(foreign)
                with self.assertRaises(ServiceError) as raised:
                    service.agent_preview_file(
                        actor,
                        "private",
                        str(actor["id"]),
                        "escape.md",
                    )
                self.assertEqual(raised.exception.status, 404)

                server, thread = serve_in_thread(make_config(Path(td)), service)
                host, port = server.server_address
                connection = http.client.HTTPConnection(host, port, timeout=5)
                try:
                    path = (
                        "/api/agent-previews/file?scope_type=private&scope_id="
                        + str(actor["id"])
                        + "&workspace_path=notes%2Freadme.md"
                    )
                    connection.request("GET", path)
                    self.assertEqual(connection.getresponse().status, 401)
                    connection = http.client.HTTPConnection(host, port, timeout=5)
                    connection.request(
                        "GET",
                        path,
                        headers={"Authorization": f"Bearer {token}"},
                    )
                    response = connection.getresponse()
                    body = json.loads(response.read().decode("utf-8"))
                    self.assertEqual(response.status, 200)
                    self.assertEqual(body["workspace_path"], "notes/readme.md")
                    self.assertEqual(
                        response.getheader("X-Content-Type-Options"),
                        "nosniff",
                    )
                finally:
                    connection.close()
                    server.shutdown()
                    server.server_close()
                    thread.join(timeout=2)
            finally:
                service.close()

    def test_html_media_is_an_attachment_but_not_a_chat_preview(self):
        with tempfile.TemporaryDirectory() as td:
            agent = MediaReturningAgent("/workspace/page.html")
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, user = service.authenticate("admin", "admin")
                scope = service.agent_scopes.ensure_private_scope(int(user["id"]))
                page = Path(scope.workspace_path) / "page.html"
                page.write_text("<html><body><h1>Hello</h1></body></html>", encoding="utf-8")
                service.send_private_message(user, "make a page")
                service.wait_for_agent_idle("private", str(user["id"]))
                message = service.list_messages(user, "private", str(user["id"]))[-1]
                attachment = message["attachments"][0]
                self.assertEqual(attachment["filename"], "page.html")
                self.assertTrue(str(attachment["mime_type"]).startswith("text/html"))
                self.assertNotIn("preview_url", attachment)
                with self.assertRaises(ServiceError) as raised:
                    service.get_attachment_preview(user, int(attachment["id"]))
                self.assertEqual(raised.exception.status, 415)
                workbook = Path(scope.workspace_path) / "report.xlsx"
                workbook.write_bytes(make_xlsx_attachment())
                xlsx_agent = MediaReturningAgent("/workspace/report.xlsx")
                service.agent_client = xlsx_agent
                service.send_private_message(user, "make a workbook")
                service.wait_for_agent_idle("private", str(user["id"]))
                xlsx_message = service.list_messages(user, "private", str(user["id"]))[-1]
                self.assertIn("preview_url", xlsx_message["attachments"][0])
            finally:
                service.close()

    def test_present_page_is_sandboxed_html_and_rejects_escape(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=StatusAgent())
            try:
                token, actor = service.authenticate("admin", "admin")
                scope = service.agent_scopes.ensure_private_scope(int(actor["id"]))
                page = Path(scope.workspace_path) / "deck.html"
                html = "<html><body><script>document.cookie='x=1'</script>Hi</body></html>"
                page.write_text(html, encoding="utf-8")
                service._record_agent_progress(
                    "private",
                    str(actor["id"]),
                    {
                        "event": "tool.completed",
                        "tool_name": "write_file",
                        "tool_call_id": "html-1",
                        "arguments": {"path": "/workspace/deck.html", "content": html},
                    },
                )
                preview = service.agent_preview_present(actor, "private", str(actor["id"]))
                self.assertIn("Hi", preview["html"])
                status = service.agent_preview_status(actor, "private", str(actor["id"]))
                self.assertTrue(status["present_available"])

                server, thread = serve_in_thread(make_config(Path(td)), service)
                host, port = server.server_address
                connection = http.client.HTTPConnection(host, port, timeout=5)
                try:
                    path = (
                        "/api/agent-previews/present?scope_type=private&scope_id="
                        + str(actor["id"])
                    )
                    connection.request(
                        "GET",
                        path,
                        headers={"Authorization": f"Bearer {token}"},
                    )
                    response = connection.getresponse()
                    body = response.read().decode("utf-8")
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.getheader("Content-Type"), "text/html; charset=utf-8")
                    self.assertEqual(response.getheader("X-Content-Type-Options"), "nosniff")
                    self.assertEqual(response.getheader("X-Frame-Options"), "SAMEORIGIN")
                    csp = response.getheader("Content-Security-Policy") or ""
                    self.assertEqual(csp, PRESENT_PAGE_CSP)
                    self.assertIn("connect-src 'none'", csp)
                    self.assertIn("form-action 'none'", csp)
                    self.assertIn("frame-ancestors 'self'", csp)
                    self.assertNotIn("allow-same-origin", csp)
                    self.assertIn("Hi", body)
                    self.assertEqual(
                        response.getheader("ETag"),
                        f'"{hashlib.sha256(html.encode("utf-8")).hexdigest()}"',
                    )
                finally:
                    connection.close()
                    server.shutdown()
                    server.server_close()
                    thread.join(timeout=2)

                second = service.agent_scopes.ensure_channel_scope(1)
                foreign = Path(second.workspace_path) / "stolen.html"
                foreign.write_text("<html>other</html>", encoding="utf-8")
                link = Path(scope.workspace_path) / "stolen.html"
                link.symlink_to(foreign)
                service._record_agent_progress(
                    "private",
                    str(actor["id"]),
                    {
                        "event": "tool.completed",
                        "tool_name": "write_file",
                        "tool_call_id": "html-2",
                        "arguments": {"path": "/workspace/stolen.html"},
                    },
                )
                with self.assertRaises(ServiceError) as raised:
                    service.agent_preview_file(actor, "private", str(actor["id"]), "stolen.html")
                self.assertEqual(raised.exception.status, 404)
            finally:
                service.close()

    def test_present_and_file_do_not_create_scope_or_runtimes(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=StatusAgent())
            try:
                _, actor = service.authenticate("admin", "admin")
                with (
                    mock.patch.object(service.agent_scopes, "ensure_private_scope") as ensure_scope,
                    mock.patch.object(service.runtimes, "ensure_camofox_ready") as ensure_browser,
                ):
                    with self.assertRaises(ServiceError) as raised:
                        service.agent_preview_file(
                            actor,
                            "private",
                            str(actor["id"]),
                            "missing.md",
                        )
                    self.assertEqual(raised.exception.status, 404)
                    with self.assertRaises(ServiceError) as present_error:
                        service.agent_preview_present(actor, "private", str(actor["id"]))
                    self.assertEqual(present_error.exception.status, 404)
                    status = service.agent_preview_status(actor, "private", str(actor["id"]))
                    self.assertFalse(status["present_available"])
                ensure_scope.assert_not_called()
                ensure_browser.assert_not_called()
            finally:
                service.close()

    def test_oversized_present_page_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=StatusAgent())
            try:
                _, actor = service.authenticate("admin", "admin")
                scope = service.agent_scopes.ensure_private_scope(int(actor["id"]))
                huge = Path(scope.workspace_path) / "huge.html"
                huge.write_bytes(b"<html>" + (b"a" * (COMPUTER_PRESENT_MAX_BYTES + 8)) + b"</html>")
                service._record_agent_progress(
                    "private",
                    str(actor["id"]),
                    {
                        "event": "tool.completed",
                        "tool_name": "write_file",
                        "tool_call_id": "huge",
                        "arguments": {"path": "/workspace/huge.html"},
                    },
                )
                with self.assertRaises(ServiceError) as raised:
                    service.agent_preview_present(actor, "private", str(actor["id"]))
                self.assertEqual(raised.exception.status, 413)
            finally:
                service.close()

    def test_project_computer_clues_follow_the_latest_computer_tool(self):
        clues = project_computer_clues(
            [
                {
                    "source": "agent",
                    "tool": "web",
                    "sequence": 1,
                    "updated_sequence": 1,
                    "tool_status": "completed",
                },
                {
                    "source": "agent",
                    "tool": "write_file",
                    "sequence": 2,
                    "updated_sequence": 2,
                    "tool_status": "completed",
                    "parameters": {
                        "path": "notes.md",
                        "workspace_path": "notes.md",
                        "target": "sandbox",
                    },
                },
            ],
            {"tool": "web", "hits": [{"title": "Docs", "url": "https://example.test/docs"}]},
        )
        self.assertEqual(clues["mode"], "file")
        self.assertEqual(clues["file"]["workspace_path"], "notes.md")
        self.assertEqual(clues["search"]["hits"][0]["title"], "Docs")


if __name__ == "__main__":
    unittest.main()
