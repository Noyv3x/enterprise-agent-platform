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
    COMPUTER_FILE_PREVIEW_MAX_BYTES,
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

    def test_mcp_parameters_keep_only_safe_identity_fields(self):
        self.assertEqual(
            agent_tool_parameters({
                "tool": "mcp",
                "arguments": {
                    "action": "call",
                    "arguments": {
                        "server": "project.docs-v1",
                        "tool": "search_documents",
                        "arguments": {"token": "secret", "query": "private"},
                        "env": {"API_KEY": "secret"},
                    },
                },
                "result": {"content": "private result"},
            }),
            {
                "action": "call",
                "server": "project.docs-v1",
                "tool": "search_documents",
            },
        )
        self.assertEqual(
            agent_tool_parameters({
                "tool": "mcp",
                "arguments": {
                    "action": "list",
                    "arguments": {"server": "../unsafe"},
                },
            }),
            {"action": "list"},
        )


class ComputerSearchProjectionTests(unittest.TestCase):
    def test_web_hits_are_closed_world_and_bounded(self):
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


class ComputerFileDraftProjectionTests(unittest.TestCase):
    @staticmethod
    def _activate(service: EnterpriseService, actor: dict[str, object]) -> dict[str, object]:
        task: dict[str, object] = {
            "scope_type": "private",
            "scope_id": str(actor["id"]),
            "user_message": {"id": 71, "content": "write it"},
            "actor": actor,
            "content": "write it",
        }
        key = f"private:{actor['id']}"
        with service._conversation_lock:
            service._agent_status[key] = service._status_for_task(
                task,
                "replying",
                queued_count=0,
            )
        return task

    @staticmethod
    def _draft_event(
        *,
        tool: str = "write_file",
        tool_call_id: str = "write-draft-1",
        kind: str = "file",
        workspace_path: str = "src/app.ts",
        content: str = "draft text",
        revision: object = 1,
        complete: object = False,
        truncated: object = False,
        discarded: object = False,
    ) -> dict[str, object]:
        draft: dict[str, object] = {
            "workspace_path": workspace_path,
            "kind": kind,
            "revision": revision,
            "complete": complete,
            "truncated": truncated,
            "discarded": discarded,
        }
        if discarded is not True:
            draft["content"] = content
        return {
            "event": "tool.arguments.delta",
            "tool_name": tool,
            "tool_call_id": tool_call_id,
            "file_draft": draft,
        }

    def test_write_draft_is_live_only_monotonic_and_cleared_by_terminal_event(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, actor = service.authenticate("admin", "admin")
                scope = service.agent_scopes.ensure_private_scope(int(actor["id"]))
                target = Path(scope.workspace_path) / "src" / "app.ts"
                target.parent.mkdir()
                target.write_text("committed old text", encoding="utf-8")
                task = self._activate(service, actor)

                secret_draft = "draft TOKEN=super-secret\nline two"
                service._record_agent_progress(
                    "private",
                    str(actor["id"]),
                    self._draft_event(content=secret_draft),
                )
                status = service.agent_status(actor, "private", str(actor["id"]))
                self.assertEqual(
                    status["computer"],
                    {
                        "mode": "file",
                        "file": {
                            "source": "draft",
                            "draft_kind": "file",
                            "tool": "write_file",
                            "target": "sandbox",
                            "tool_call_id": "write-draft-1",
                            "workspace_path": "src/app.ts",
                            "status": "drafting",
                            "revision": "draft:write-draft-1:1",
                        },
                    },
                )
                self.assertNotIn("super-secret", json.dumps(status))
                self.assertNotIn("_computer_file_draft", status)
                preview = service.agent_preview_file(
                    actor,
                    "private",
                    str(actor["id"]),
                    "src/app.ts",
                )
                self.assertEqual(preview["source"], "draft")
                self.assertEqual(preview["draft_kind"], "file")
                self.assertEqual(preview["revision"], "draft:write-draft-1:1")
                self.assertIn("TOKEN=•••", preview["content"])
                self.assertNotIn("super-secret", preview["content"])

                snapshot = service._agent_work_snapshot(task, "complete")
                self.assertNotIn("draft text", json.dumps(snapshot))
                self.assertNotIn("super-secret", json.dumps(snapshot))
                self.assertNotIn("computer", snapshot)

                service._record_agent_progress(
                    "private",
                    str(actor["id"]),
                    self._draft_event(content="stale", revision=1, complete=True),
                )
                self.assertEqual(
                    service.agent_preview_file(
                        actor,
                        "private",
                        str(actor["id"]),
                        "src/app.ts",
                    )["revision"],
                    "draft:write-draft-1:1",
                )

                service._record_agent_progress(
                    "private",
                    str(actor["id"]),
                    self._draft_event(
                        tool="patch_file",
                        tool_call_id="write-draft-1",
                        kind="replacement",
                        content="identity swap",
                        revision=2,
                    ),
                )
                self.assertEqual(
                    service.agent_preview_file(
                        actor,
                        "private",
                        str(actor["id"]),
                        "src/app.ts",
                    )["revision"],
                    "draft:write-draft-1:1",
                )

                service._record_agent_progress(
                    "private",
                    str(actor["id"]),
                    self._draft_event(content="final draft", revision=2, complete=True),
                )
                pending = service.agent_status(actor, "private", str(actor["id"]))
                self.assertEqual(pending["computer"]["file"]["status"], "pending")
                self.assertEqual(pending["computer"]["file"]["revision"], "draft:write-draft-1:2")
                self.assertEqual(
                    service.agent_preview_file(
                        actor,
                        "private",
                        str(actor["id"]),
                        "src/app.ts",
                    )["content"],
                    "final draft",
                )

                service._record_agent_progress(
                    "private",
                    str(actor["id"]),
                    {
                        "event": "tool.failed",
                        "tool_name": "write_file",
                        "tool_call_id": "another-tool",
                        "execution_started": False,
                    },
                )
                self.assertEqual(
                    service.agent_preview_file(
                        actor,
                        "private",
                        str(actor["id"]),
                        "src/app.ts",
                    )["source"],
                    "draft",
                )

                service._record_agent_progress(
                    "private",
                    str(actor["id"]),
                    {
                        "event": "tool.completed",
                        "tool_name": "write_file",
                        "tool_call_id": "write-draft-1",
                        "arguments": {"path": "/workspace/src/app.ts", "target": "sandbox"},
                    },
                )
                committed = service.agent_preview_file(
                    actor,
                    "private",
                    str(actor["id"]),
                    "src/app.ts",
                )
                self.assertEqual(committed["source"], "workspace")
                self.assertEqual(committed["content"], "committed old text")
                completed = service.agent_status(actor, "private", str(actor["id"]))
                self.assertNotEqual(
                    completed.get("computer", {}).get("file", {}).get("revision"),
                    "draft:write-draft-1:2",
                )
            finally:
                service.close()

    def test_patch_replacement_draft_can_be_discarded(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, actor = service.authenticate("admin", "admin")
                scope = service.agent_scopes.ensure_private_scope(int(actor["id"]))
                target = Path(scope.workspace_path) / "src" / "app.ts"
                target.parent.mkdir()
                target.write_text("committed", encoding="utf-8")
                self._activate(service, actor)
                service._record_agent_progress(
                    "private",
                    str(actor["id"]),
                    self._draft_event(
                        tool="patch_file",
                        tool_call_id="patch-draft-1",
                        kind="replacement",
                        content="replacement fragment",
                        complete=True,
                    ),
                )
                preview = service.agent_preview_file(
                    actor,
                    "private",
                    str(actor["id"]),
                    "src/app.ts",
                )
                self.assertEqual(preview["source"], "draft")
                self.assertEqual(preview["draft_kind"], "replacement")
                self.assertEqual(preview["content"], "replacement fragment")

                service._record_agent_progress(
                    "private",
                    str(actor["id"]),
                    self._draft_event(
                        tool="patch_file",
                        tool_call_id="patch-draft-1",
                        kind="replacement",
                        revision=2,
                        discarded=True,
                    ),
                )
                self.assertEqual(
                    service.agent_preview_file(
                        actor,
                        "private",
                        str(actor["id"]),
                        "src/app.ts",
                    )["source"],
                    "workspace",
                )
                self.assertNotIn(
                    "computer",
                    service.agent_status(actor, "private", str(actor["id"])),
                )
            finally:
                service.close()

    def test_draft_is_unavailable_outside_active_state_and_dropped_by_run_replacement(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, actor = service.authenticate("admin", "admin")
                scope = service.agent_scopes.ensure_private_scope(int(actor["id"]))
                target = Path(scope.workspace_path) / "src" / "app.ts"
                target.parent.mkdir()
                target.write_text("workspace version", encoding="utf-8")
                self._activate(service, actor)
                service._record_agent_progress(
                    "private",
                    str(actor["id"]),
                    self._draft_event(content="ephemeral version"),
                )
                key = f"private:{actor['id']}"
                with service._conversation_lock:
                    anomalous = dict(service._agent_status[key])
                    anomalous["state"] = "idle"
                    service._agent_status[key] = anomalous
                self.assertEqual(
                    service.agent_preview_file(
                        actor,
                        "private",
                        str(actor["id"]),
                        "src/app.ts",
                    )["source"],
                    "workspace",
                )
                self.assertNotIn(
                    "computer",
                    service.agent_status(actor, "private", str(actor["id"])),
                )

                replacement_task = {
                    "scope_type": "private",
                    "scope_id": str(actor["id"]),
                    "user_message": {"id": 72, "content": "new run"},
                    "actor": actor,
                    "content": "new run",
                }
                with service._conversation_lock:
                    service._agent_status[key] = service._status_for_task(
                        replacement_task,
                        "replying",
                        queued_count=0,
                    )
                    self.assertNotIn("_computer_file_draft", service._agent_status[key])
                self.assertEqual(
                    service.agent_preview_file(
                        actor,
                        "private",
                        str(actor["id"]),
                        "src/app.ts",
                    )["source"],
                    "workspace",
                )
            finally:
                service.close()

    def test_invalid_file_draft_payloads_are_ignored(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, actor = service.authenticate("admin", "admin")
                self._activate(service, actor)
                invalid = [
                    self._draft_event(tool="read_file"),
                    self._draft_event(tool_call_id=""),
                    self._draft_event(kind="replacement"),
                    self._draft_event(revision=0),
                    self._draft_event(revision=True),
                    self._draft_event(revision=2**53),
                    self._draft_event(workspace_path="/workspace/src/app.ts"),
                    self._draft_event(workspace_path="../app.ts"),
                    self._draft_event(content="x" * (COMPUTER_FILE_PREVIEW_MAX_BYTES + 1)),
                    self._draft_event(complete="false"),
                ]
                invalid_discard = self._draft_event(discarded=True)
                invalid_discard["file_draft"]["content"] = "must be omitted"
                invalid.append(invalid_discard)
                for event in invalid:
                    with self.subTest(event=event):
                        service._record_agent_progress(
                            "private",
                            str(actor["id"]),
                            event,
                        )
                        with service._conversation_lock:
                            internal = service._agent_status[f"private:{actor['id']}"]
                            self.assertNotIn("_computer_file_draft", internal)
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
                self.assertEqual(payload["source"], "workspace")
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
                    self.assertEqual(body["source"], "workspace")
                    self.assertEqual(
                        response.getheader("X-Content-Type-Options"),
                        "nosniff",
                    )

                    ComputerFileDraftProjectionTests._activate(service, actor)
                    service._record_agent_progress(
                        "private",
                        str(actor["id"]),
                        ComputerFileDraftProjectionTests._draft_event(
                            workspace_path="notes/readme.md",
                            content="HTTP draft TOKEN=http-secret",
                            revision=4,
                            complete=True,
                        ),
                    )
                    connection = http.client.HTTPConnection(host, port, timeout=5)
                    connection.request(
                        "GET",
                        path,
                        headers={"Authorization": f"Bearer {token}"},
                    )
                    response = connection.getresponse()
                    draft_body = json.loads(response.read().decode("utf-8"))
                    self.assertEqual(response.status, 200)
                    self.assertEqual(draft_body["source"], "draft")
                    self.assertEqual(draft_body["draft_kind"], "file")
                    self.assertEqual(draft_body["revision"], "draft:write-draft-1:4")
                    self.assertIn("TOKEN=•••", draft_body["content"])
                    self.assertNotIn("http-secret", json.dumps(draft_body))
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
