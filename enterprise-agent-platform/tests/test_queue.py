import asyncio
import json
import tempfile
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.requests import Request

from enterprise_agent_platform.db import Database, now
from enterprise_agent_platform.auth import issue_session
from enterprise_agent_platform.queue import Queue, _WorkTrace, authenticated_events, routes


class Gate:
    @asynccontextmanager
    async def admit(self):
        yield


class Files:
    def bind(self, user, info, mid, ids, conn=None):
        if ids:
            raise HTTPException(404, "Attachment not found")

    def prompt(self, user, info, ids):
        return {"text": "", "images": []}

    def for_message(self, info, mid):
        return []

    async def deliver(self, user, info, mid, text):
        return []


class QueueTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        db = Database(root / "platform.db")
        db.migrate(root)
        with db.connect() as conn:
            for uid in (1, 2):
                conn.execute("INSERT INTO users(id,username,display_name,password_hash,role,model_name,created_at) VALUES (?,?,?,?,?,?,?)",
                             (uid, f"u{uid}", f"User {uid}", "unused", "admin", "model-a", 1))
        self.calls = []
        self.requests = []
        self.compactions = []
        self.compact_hold = asyncio.Event()
        self.compact_hold.set()
        self.compact_started = asyncio.Event()
        self.compact_result = {"compacted": True, "model": "model-a",
                               "usage": {"input": 10, "output": 2, "cache_read": 8, "cache_write": 1, "total": 21}}
        self.compact_timeout = None
        self.hold = asyncio.Event()
        self.hold.set()
        self.loss = False
        self.runtime_events = None
        self.runtime_stream = None

        async def runtime(request):
            self.calls.append((request.method, request.url.path))
            if request.url.path.endswith("/runs"):
                self.requests.append(json.loads(request.content))
                await self.hold.wait()
                return httpx.Response(202, json={"run_id": f"r{len(self.requests)}"})
            if request.url.path.endswith("/events"):
                if self.runtime_stream is not None:
                    return httpx.Response(200, stream=self.runtime_stream)
                if self.runtime_events is not None:
                    return httpx.Response(200, text="".join(
                        "data: " + json.dumps({"seq": seq, **event}) + "\n\n"
                        for seq, event in enumerate(self.runtime_events, 1)))
                events = [{"seq": 1, "type": "text_delta", "delta": "answer"}]
                if not self.loss:
                    events.append({"seq": 2, "type": "run_end", "status": "completed", "text": "answer", "model": "model-a",
                                   "usage": {"input": 10, "output": 2, "cache_read": 8, "cache_write": 1, "total": 21}})
                return httpx.Response(200, text="".join("data: " + json.dumps(e) + "\n\n" for e in events))
            if request.url.path.endswith("/compact"):
                self.compactions.append(json.loads(request.content))
                self.compact_timeout = request.extensions["timeout"]["read"]
                self.compact_started.set()
                await self.compact_hold.wait()
                return httpx.Response(200, json=self.compact_result)
            return httpx.Response(200, json={"ok": True})

        self.http = httpx.AsyncClient(transport=httpx.MockTransport(runtime))
        self.p = SimpleNamespace(db=db, http=self.http, gate=Gate(), files=Files(), settings=SimpleNamespace(data_dir=root, runtime_url="http://runtime", runtime_token="test"))
        self.p.oauth = SimpleNamespace(catalog=AsyncMock(return_value={"models": [{"id": "model-a"}, {"id": "model-b"}]}))
        self.q = self.p.queue = Queue(self.p)
        self.user = self.q.user(1)

    async def asyncTearDown(self):
        await self.q.stop()
        await self.http.aclose()
        self.temp.cleanup()

    async def drain(self):
        while self.q.tasks:
            await asyncio.gather(*list(self.q.tasks.values()))

    async def test_fifo_single_submit_and_stable_session(self):
        self.hold.clear()
        await self.q.enqueue(self.user, "private", "first")
        await asyncio.sleep(0)
        await self.q.enqueue(self.user, "private", "second")
        self.assertEqual([r["prompt"]["text"] for r in self.requests], ["first"])
        self.hold.set()
        await self.drain()
        self.assertEqual([r["prompt"]["text"] for r in self.requests], ["first", "second"])
        self.assertEqual([path for method, path in self.calls if path.endswith("/runs")], ["/v1/sessions/agent-private-1/runs"] * 2)
        page = self.q.messages(self.user, "private")
        self.assertEqual([m["content"] for m in page["messages"]], ["first", "second", "answer", "answer"])
        self.assertIsNone(page["next_before_id"])
        self.assertEqual(page["messages"][0]["metadata"]["author_display_name"], "User 1")
        with self.p.db.connect() as conn:
            self.assertEqual([r[0] for r in conn.execute("SELECT status FROM durable_jobs ORDER BY id")], ["succeeded", "succeeded"])
            usage = json.loads(conn.execute("SELECT raw_usage_json FROM token_usage_events LIMIT 1").fetchone()[0])
            self.assertEqual(usage["cacheRead"], 8)

    async def test_loss_interrupted_without_resubmission(self):
        self.loss = True
        await self.q.enqueue(self.user, "private", "uncertain")
        await self.drain()
        await self.q.start()
        await self.drain()
        self.assertEqual(len(self.requests), 1)
        message = self.q.messages(self.user, "private")["messages"][-1]
        self.assertEqual(message["metadata"]["status"], "interrupted")
        self.assertIn("without run_end", message["metadata"]["error"])
        self.assertIn(("POST", "/v1/sessions/agent-private-1/cancel"), self.calls)
        self.assertEqual(self.q.active, 0)

    def test_work_exact_field_bounds_do_not_truncate(self):
        trace = _WorkTrace()
        args = {"command": "x" * (2000 - len(json.dumps({"command": ""})))}
        for event in [
            {"type": "thinking_delta", "delta": "t" * 4000},
            {"type": "text_delta", "delta": "p" * 4000},
            {"type": "tool_start", "tool_call_id": "exact", "name": "bash", "args": args},
            {"type": "tool_end", "tool_call_id": "exact", "is_error": False,
             "content_preview": [{"type": "text", "text": "o" * 2000}]},
        ]:
            trace.add(event)
        work = trace.finish()
        self.assertFalse(work["truncated"])
        self.assertEqual(work["items"][0]["text"], "t" * 4000)
        self.assertEqual(work["items"][1]["text"], "p" * 4000)
        self.assertEqual(work["items"][2]["args"], args)
        self.assertEqual(work["items"][2]["output"], "o" * 2000)

    async def run_work(self, events, status="completed"):
        self.runtime_events = list(events)
        if status is not None:
            self.runtime_events.append({"type": "run_end", "status": status, "text": "Final answer"})
        await self.q.enqueue(self.user, "private", "Inspect the report")
        await self.drain()
        return self.q.messages(self.user, "private")["messages"][-1]

    async def test_work_preserves_arrival_order_and_excludes_final_answer(self):
        message = await self.run_work([
            {"type": "thinking_delta", "delta": "Read "},
            {"type": "thinking_delta", "delta": "the report"},
            {"type": "text_delta", "delta": "Checking "},
            {"type": "text_delta", "delta": "the figures"},
            {"type": "tool_start", "tool_call_id": "read", "name": "read", "args": {"path": "report.csv"}},
            {"type": "thinking_delta", "delta": "Compare totals"},
            {"type": "tool_start", "tool_call_id": "sum", "name": "bash", "args": {"command": "sum report.csv"}},
            {"type": "tool_update", "tool_call_id": "read",
             "partial": {"content": [{"type": "text", "text": "Reading…"}]}},
            {"type": "tool_end", "tool_call_id": "sum", "is_error": False,
             "content_preview": [{"type": "text", "text": "Total: "}, {"type": "text", "text": "42"}]},
            {"type": "tool_end", "tool_call_id": "read", "is_error": False,
             "content_preview": [{"type": "text", "text": "Rows: 3"}]},
            {"type": "text_delta", "delta": "Final answer"},
            {"type": "thinking_delta", "delta": "Ready to respond"},
        ])
        work = message["metadata"]["work"]
        self.assertEqual(work["v"], 1)
        self.assertFalse(work["truncated"])
        self.assertLessEqual(work["started_at"], work["ended_at"])
        items = work["items"]
        self.assertEqual([(item["type"], item.get("text", item.get("id"))) for item in items], [
            ("thinking", "Read the report"), ("text", "Checking the figures"), ("tool", "read"),
            ("thinking", "Compare totals"), ("tool", "sum"), ("thinking", "Ready to respond")])
        for item, name, args, output in [
            (items[2], "read", {"path": "report.csv"}, "Rows: 3"),
            (items[4], "bash", {"command": "sum report.csv"}, "Total: 42"),
        ]:
            self.assertEqual((item["name"], item["args"], item["status"], item["output"]),
                             (name, args, "done", output))
            self.assertLessEqual(item["started_at"], item["ended_at"])
        self.assertEqual(message["content"], "Final answer")
        stream = self.q.events(self.user, "private", 0)
        try:
            async with asyncio.timeout(2):
                async for frame in stream:
                    event = json.loads(frame.split(b"data: ", 1)[1])
                    if event["type"] == "run_end":
                        self.assertEqual(event["message"], message)
                        break
        finally:
            await stream.aclose()
        self.assertNotIn("work", self.q.messages(self.user, "private")["messages"][0]["metadata"])
        with self.p.db.connect() as conn:
            payload = json.loads(conn.execute("SELECT payload_json FROM durable_jobs").fetchone()[0])
        self.assertNotIn('"work"', json.dumps(payload))

    async def test_work_tool_errors_and_unfinished_tools_survive_run_outcomes(self):
        for runtime_status, message_status in [
            ("completed", "completed"), ("failed", "interrupted"), ("cancelled", "cancelled"),
            (None, "interrupted"),
        ]:
            with self.subTest(status=runtime_status):
                message = await self.run_work([
                    {"type": "tool_start", "tool_call_id": "ok", "name": "read", "args": {}},
                    {"type": "tool_end", "tool_call_id": "ok", "is_error": False,
                     "content_preview": [{"type": "text", "text": "Read complete"}]},
                    {"type": "tool_start", "tool_call_id": "bad", "name": "bash", "args": {}},
                    {"type": "tool_end", "tool_call_id": "bad", "is_error": True,
                     "content_preview": [{"type": "text", "text": "Permission denied"}]},
                    {"type": "tool_start", "tool_call_id": "pending", "name": "bash", "args": {}},
                    {"type": "tool_update", "tool_call_id": "pending",
                     "partial": {"content": [{"type": "text", "text": "Partial result"}]}},
                ], runtime_status)
                self.assertEqual(message["metadata"]["status"], message_status)
                items = message["metadata"]["work"]["items"]
                self.assertEqual([(item["id"], item["status"], item["output"]) for item in items], [
                    ("ok", "done", "Read complete"), ("bad", "error", "Permission denied"),
                    ("pending", "cancelled", "Partial result")])
                self.assertIsNone(items[2]["ended_at"])

    async def test_work_is_absent_for_empty_and_text_only_runs(self):
        for events in ([], [{"type": "text_delta", "delta": "Final answer"}]):
            with self.subTest(events=events):
                message = await self.run_work(events)
                self.assertNotIn("work", message["metadata"])

    async def test_worker_cancellation_keeps_work_already_received(self):
        received = asyncio.Event()
        never = asyncio.Event()

        class PausedStream(httpx.AsyncByteStream):
            async def __aiter__(self):
                events = [
                    {"seq": 1, "type": "thinking_delta", "delta": "Inspecting"},
                    {"seq": 2, "type": "tool_start", "tool_call_id": "pending", "name": "read", "args": {}},
                    {"seq": 3, "type": "tool_update", "tool_call_id": "pending",
                     "partial": {"content": [{"type": "text", "text": "First page"}]}},
                ]
                yield "".join("data: " + json.dumps(event) + "\n\n" for event in events).encode()
                received.set()
                await never.wait()

        self.runtime_stream = PausedStream()
        await self.q.enqueue(self.user, "private", "Read the report")
        await asyncio.wait_for(received.wait(), 2)
        for task in list(self.q.tasks.values()):
            task.cancel()
        await asyncio.gather(*list(self.q.tasks.values()), return_exceptions=True)
        message = self.q.messages(self.user, "private")["messages"][-1]
        self.assertEqual(message["metadata"]["status"], "interrupted")
        items = message["metadata"]["work"]["items"]
        self.assertEqual(items[0], {"type": "thinking", "text": "Inspecting"})
        self.assertEqual((items[1]["id"], items[1]["status"], items[1]["output"]),
                         ("pending", "cancelled", "First page"))
        self.assertIsNone(items[1]["ended_at"])

    async def test_work_individual_bounds_preserve_prefixes(self):
        args = {"command": "x" * 2100}
        original_add = _WorkTrace.add

        def checked_add(trace, event):
            original_add(trace, event)
            if event["type"] == "tool_update":
                self.assertEqual(trace.data["items"][2]["output"], "u" * 2000)

        with patch.object(_WorkTrace, "add", checked_add):
            message = await self.run_work([
                {"type": "thinking_delta", "delta": "t" * 3999},
                {"type": "thinking_delta", "delta": "ail"},
                {"type": "text_delta", "delta": "p" * 3999},
                {"type": "text_delta", "delta": "ost"},
                {"type": "tool_start", "tool_call_id": "large", "name": "bash", "args": args},
                {"type": "tool_update", "tool_call_id": "large",
                 "partial": {"content": [{"type": "text", "text": "u" * 2100}]}},
                {"type": "tool_end", "tool_call_id": "large", "is_error": False,
                 "content_preview": [{"type": "text", "text": "f" * 2100}]},
            ])
        self.assertEqual(message["metadata"]["status"], "completed")
        work = message["metadata"]["work"]
        self.assertEqual(work["items"][0]["text"], "t" * 3999 + "a")
        self.assertEqual(work["items"][1]["text"], "p" * 3999 + "o")
        self.assertEqual(work["items"][2]["args"], {"_preview": json.dumps(args)[:2000]})
        self.assertEqual(work["items"][2]["output"], "f" * 2000)
        self.assertTrue(work["truncated"])

    async def test_work_item_count_is_bounded_during_streaming_and_at_finish(self):
        original_add = _WorkTrace.add

        def checked_add(trace, event):
            original_add(trace, event)
            self.assertLessEqual(len(trace.data["items"]), 200)

        with patch.object(_WorkTrace, "add", checked_add):
            message = await self.run_work([
                {"type": "tool_start", "tool_call_id": str(index), "name": "read", "args": {}}
                for index in range(205)
            ])
        self.assertEqual(message["metadata"]["status"], "completed")
        work = message["metadata"]["work"]
        self.assertEqual([item["id"] for item in work["items"]], [str(index) for index in range(200)])
        self.assertTrue(work["truncated"])
        self.assertTrue(all(item["status"] == "cancelled" for item in work["items"]))

    async def test_work_global_json_byte_bound_applies_during_streaming_including_unicode(self):
        original_add = _WorkTrace.add

        def checked_add(trace, event):
            original_add(trace, event)
            self.assertLessEqual(len(json.dumps(trace.data).encode("utf-8")), 96 * 1024)

        for text in ("x" * 4000, "漢😀" * 2000):
            with self.subTest(unicode=text.startswith("漢")):
                events = [
                    {"type": "tool_start", "tool_call_id": "retained", "name": "read", "args": {}},
                    {"type": "tool_update", "tool_call_id": "retained",
                     "partial": {"content": [{"type": "text", "text": "First page"}]}},
                ]
                for index in range(40):
                    events.extend([
                        {"type": "thinking_delta", "delta": text},
                        {"type": "tool_start", "tool_call_id": str(index), "name": "read", "args": {}},
                        {"type": "tool_end", "tool_call_id": str(index), "is_error": False,
                         "content_preview": [{"type": "text", "text": "done"}]},
                    ])
                is_error = text.startswith("漢")
                events.append({"type": "tool_end", "tool_call_id": "retained", "is_error": is_error,
                               "content_preview": [{"type": "text", "text": "😀" * 2000}]})
                with patch.object(_WorkTrace, "add", checked_add):
                    message = await self.run_work(events)
                self.assertEqual(message["metadata"]["status"], "completed")
                work = message["metadata"]["work"]
                self.assertLessEqual(len(json.dumps(work).encode("utf-8")), 96 * 1024)
                self.assertTrue(work["truncated"])
                self.assertEqual(work["items"][1], {"type": "thinking", "text": text})
                retained = work["items"][0]
                self.assertEqual((retained["id"], retained["status"]),
                                 ("retained", "error" if is_error else "done"))
                self.assertIsNotNone(retained["ended_at"])
                self.assertEqual(retained["output"], "First page")

    async def test_restart_resumes_queued_never_running(self):
        self.q.stopping = True
        await self.q.enqueue(self.user, "private", "already submitted")
        await self.q.enqueue(self.user, "private", "not submitted")
        with self.p.db.connect() as conn:
            conn.execute("UPDATE durable_jobs SET status='running' WHERE id=(SELECT MIN(id) FROM durable_jobs)")
        await self.q.start()
        await self.drain()
        self.assertEqual([r["prompt"]["text"] for r in self.requests], ["not submitted"])
        self.assertEqual([m["metadata"]["status"] for m in self.q.messages(self.user, "private")["messages"] if m["role"] == "assistant"], ["interrupted", "completed"])

    async def test_attachment_failure_rolls_back_message_and_job(self):
        with self.assertRaises(HTTPException):
            await self.q.enqueue(self.user, "private", "invalid", [999])
        with self.p.db.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM durable_jobs").fetchone()[0], 0)

    async def test_cancel_during_submit_and_reset(self):
        self.hold.clear()
        await self.q.enqueue(self.user, "private", "active")
        await asyncio.sleep(0)
        await self.q.enqueue(self.user, "private", "queued")
        await self.q.cancel(self.user, "private")
        self.hold.set()
        await self.drain()
        self.assertEqual(len(self.requests), 1)
        self.assertIn(("POST", "/v1/runs/r1/cancel"), self.calls)
        self.assertIn("cancelled", [m["metadata"]["status"] for m in self.q.messages(self.user, "private")["messages"]])
        await self.q.compact(self.user, "private")
        await self.drain()
        await self.q.reset(self.user, "private")
        self.assertEqual(self.q.messages(self.user, "private")["messages"], [])
        self.assertNotEqual(self.q.scope(self.user, "private")["sid"], "agent-private-1")

    async def test_chat_ownership_create_delete_and_shared_sandbox(self):
        app = Starlette(routes=routes())
        app.state.platform = self.p
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://platform") as client:
            with patch("enterprise_agent_platform.queue.current_user", return_value=self.user):
                first = (await client.post("/api/chat/conversations", json={})).json()["conversation"]
                second = (await client.post("/api/chat/conversations", json={"title": "Second"})).json()["conversation"]
                self.assertEqual(set(first), {"id", "user_id", "title", "created_at", "updated_at", "deleted_at"})
                self.assertEqual((await client.post("/api/chat/conversations", json={"model_id": "model-b"})).status_code, 400)
                self.assertEqual((await client.patch("/api/chat/conversations/" + first["id"], json={"model_id": "model-b"})).status_code, 400)
                self.assertEqual((await client.patch("/api/chat/conversations/" + first["id"], json={"title": "Renamed", "model_id": "model-b"})).status_code, 400)
                self.assertEqual((await client.get("/api/chat/conversations/" + first["id"])).json()["conversation"]["title"], "New chat")
                self.assertEqual((await client.patch("/api/chat/conversations/" + first["id"], json={"title": "Renamed"})).json()["conversation"]["title"], "Renamed")
                self.assertEqual((await client.get("/api/chat/models")).status_code, 404)
                info = self.q.scope(self.user, "chat-" + first["id"])
                other = self.q.scope(self.user, "chat-" + second["id"])
                self.assertEqual(info["sandbox"]["sandbox_id"], other["sandbox"]["sandbox_id"])
                self.assertNotEqual(info["sandbox"]["cwd"], other["sandbox"]["cwd"])
                await self.q.enqueue(self.user, "chat-" + first["id"], "hello")
                await self.drain()
                self.assertIsNone(self.requests[0]["resources"]["agents_md"])
                self.assertIn(f"MEDIA: {info['sandbox']['cwd']}/path", self.requests[0]["resources"]["system_prompt"])
                self.assertEqual(self.requests[0]["resources"]["skills"], [])
                self.assertNotIn("browser", self.requests[0]["tools"])
            with patch("enterprise_agent_platform.queue.current_user", return_value=self.q.user(2)):
                self.assertEqual((await client.get("/api/chat/conversations/" + first["id"])).status_code, 404)
                self.assertEqual((await client.delete("/api/chat/conversations/" + first["id"])).status_code, 404)
            with patch("enterprise_agent_platform.queue.current_user", return_value=self.user):
                self.assertEqual((await client.delete("/api/chat/conversations/" + first["id"])).status_code, 200)
                self.assertFalse(info["workspace"].exists())
                self.assertEqual((await client.get("/api/chat/conversations/" + first["id"])).status_code, 404)
                with self.p.db.connect() as conn:
                    self.assertIsNotNone(conn.execute("SELECT deleted_at FROM chat_conversations WHERE id=?", (first["id"],)).fetchone()[0])

    async def test_durable_events_reconnect(self):
        await self.q.enqueue(self.user, "private", "hello")
        await self.drain()
        stream = self.q.events(self.user, "private", 0)
        first = await anext(stream)
        seq = int(first.splitlines()[0].split(b": ")[1])
        await stream.aclose()
        stream = self.q.events(self.user, "private", seq)
        next_event = await anext(stream)
        self.assertGreater(int(next_event.splitlines()[0].split(b": ")[1]), seq)
        event = json.loads(next_event.split(b"data: ")[1])
        self.assertEqual(event["message"]["metadata"]["status"], "running")
        await stream.aclose()

    async def test_reserved_startup_defers_until_resume(self):
        self.q.stopping = True
        await self.q.enqueue(self.user, "private", "after release")
        self.p.gate.reserved = "update"
        await self.q.start()
        self.assertEqual(self.q.active, 0)
        self.assertEqual(self.requests, [])
        self.p.gate.reserved = None
        self.q.resume()
        await self.drain()
        self.assertEqual([r["prompt"]["text"] for r in self.requests], ["after release"])

    async def test_legacy_queued_payload_resumes_trusted_message(self):
        self.q.stopping = True
        result = await self.q.enqueue(self.user, "private", "durable content")
        legacy = {"actor": {"id": 1}, "user_message": {"id": result["message"]["id"]},
                  "scope_type": "private", "scope_id": "1", "content": "stale content", "attachments": []}
        with self.p.db.connect() as conn:
            conn.execute("UPDATE durable_jobs SET payload_json=? WHERE id=?", (json.dumps(legacy), result["job_id"]))
        await self.q.start()
        await self.drain()
        self.assertEqual([r["prompt"]["text"] for r in self.requests], ["durable content"])

    async def test_resources_never_read_symlinks_or_symlinked_parents(self):
        info = self.q.scope(self.user, "private")
        secret = self.p.settings.data_dir / "host-secret"
        secret.write_text("---\nname: leaked-secret\ndescription: host credential\n---\n")
        (info["workspace"] / "AGENTS.md").symlink_to(secret)
        skills = info["workspace"] / ".agent-platform" / "skills"
        skills.mkdir(parents=True)
        good = skills / "good"
        good.mkdir()
        (good / "SKILL.md").write_text("---\nname: safe\ndescription: safe workspace instructions\n---\n")
        linked = skills / "linked"
        linked.mkdir()
        (linked / "SKILL.md").symlink_to(secret)
        external = self.p.settings.data_dir / "outside-skill"
        external.mkdir()
        (external / "SKILL.md").write_text(secret.read_text())
        (skills / "parent-link").symlink_to(external, target_is_directory=True)
        await self.q.enqueue(self.user, "private", "Show available guidance")
        await self.drain()
        resources = self.requests[0]["resources"]
        self.assertIsNone(resources["agents_md"])
        self.assertEqual([skill["name"] for skill in resources["skills"]], ["safe"])

    async def test_resource_swap_before_open_cannot_leak_secret(self):
        from enterprise_agent_platform.files import open_workspace
        info = self.q.scope(self.user, "private")
        agents = info["workspace"] / "AGENTS.md"
        agents.write_text("safe instructions")
        secret = self.p.settings.data_dir / "host-secret"
        secret.write_text("credential-must-not-reach-runtime")
        def swap_before_open(root, value, directory=False):
            if value == "AGENTS.md":
                agents.unlink()
                agents.symlink_to(secret)
            return open_workspace(root, value, directory=directory)
        with patch("enterprise_agent_platform.queue.open_workspace", side_effect=swap_before_open):
            await self.q.enqueue(self.user, "private", "Show available guidance")
            await self.drain()
        self.assertIsNone(self.requests[0]["resources"]["agents_md"])
        self.assertNotIn(secret.read_text(), json.dumps(self.requests))

    async def check_uncertain_run(self, lose_submission):
        cancelling, settle = asyncio.Event(), asyncio.Event()
        submitted = []
        async def runtime(request):
            if request.url.path.endswith("/runs"):
                submitted.append(json.loads(request.content)["prompt"]["text"])
                if lose_submission and len(submitted) == 1:
                    raise httpx.ReadError("Response lost after admission")
                return httpx.Response(202, json={"run_id": "current"})
            if request.url.path.endswith("/cancel"):
                cancelling.set()
                await settle.wait()
                return httpx.Response(200, json={"cancelled": True, "run_id": "current"})
            events = [] if len(submitted) == 1 else [{"type": "run_end", "status": "completed", "text": "second completed", "usage": {}, "model": "model-a"}]
            return httpx.Response(200, text="".join("data: " + json.dumps(e) + "\n\n" for e in events))
        async with httpx.AsyncClient(transport=httpx.MockTransport(runtime)) as client:
            self.p.http = client
            await self.q.enqueue(self.user, "private", "uncertain first")
            await self.q.enqueue(self.user, "private", "untouched second")
            await asyncio.wait_for(cancelling.wait(), 2)
            with self.p.db.connect() as conn:
                rows = conn.execute("SELECT status,payload_json FROM durable_jobs ORDER BY id").fetchall()
            self.assertEqual([row["status"] for row in rows], ["failed", "queued"])
            self.assertTrue(json.loads(rows[0]["payload_json"])["runtime_unsettled"])
            self.assertEqual(submitted, ["uncertain first"])
            await self.q.stop()
            self.q = self.p.queue = Queue(self.p)
            cancelling.clear()
            await self.q.start()
            await asyncio.wait_for(cancelling.wait(), 2)
            self.assertEqual(submitted, ["uncertain first"])
            settle.set()
            await self.drain()
            self.assertEqual(submitted, ["uncertain first", "untouched second"])
            self.assertEqual(self.q.messages(self.user, "private")["messages"][-1]["content"], "second completed")

    async def test_stream_loss_preserves_backlog_until_durable_settlement(self):
        await self.check_uncertain_run(False)

    async def test_unknown_submission_preserves_backlog_until_durable_settlement(self):
        await self.check_uncertain_run(True)

    async def test_live_stream_revocation_and_role_changes(self):
        app = Starlette()
        app.state.platform = self.p
        self.p.settings.session_secret = "test-stream-secret"
        for mutation in ("active=0", "token_version=token_version+1", "role='user',permission_group='no-access'"):
            with self.subTest(mutation=mutation):
                with self.p.db.connect() as conn:
                    conn.execute("UPDATE users SET active=1,role='admin',permission_group='member' WHERE id=1")
                token = issue_session(self.p.settings, self.q.user(1))
                request = Request({"type": "http", "method": "GET", "path": "/", "headers": [(b"cookie", ("agent_platform_session=" + token).encode())], "app": app})
                self.q.emit("private:1", {"type": "text_delta", "delta": "authorized"})
                self.q.emit("private:1", {"type": "text_delta", "delta": "must-not-arrive"})
                stream = authenticated_events(request, "private", 0)
                with patch.object(self.q, "scope", side_effect=AssertionError("SSE must not mutate scope")):
                    self.assertIn(b"authorized", await anext(stream))
                    with self.p.db.connect() as conn:
                        conn.execute("UPDATE users SET " + mutation + " WHERE id=1")
                    with self.assertRaises(StopAsyncIteration):
                        await anext(stream)

    async def test_legacy_default_model_and_thinking_execute(self):
        with self.p.db.connect() as conn:
            conn.execute("UPDATE users SET model_name='',thinking_depth='none' WHERE id=1")
        self.p.oauth = SimpleNamespace(catalog=AsyncMock(return_value={"models": [{"id": "catalog-default"}]}))
        await self.q.enqueue(self.q.user(1), "private", "Use inherited settings")
        await self.drain()
        self.assertEqual(self.requests[0]["model"], {"id": "catalog-default", "thinking": "off"})

    async def test_chat_follows_the_personal_model_until_an_administrator_sets_one(self):
        cid = "11111111-1111-1111-1111-111111111111"
        with self.p.db.connect() as conn:
            conn.execute("INSERT INTO chat_conversations VALUES (?,?, 'Switch models',?,?,NULL)", (cid, 1, now(), now()))
        scope = "chat-" + cid
        await self.q.enqueue(self.user, scope, "Follows personal")
        await self.drain()
        self.assertEqual(self.requests[0]["model"], {"id": "model-a", "thinking": "off"})
        with self.p.db.connect() as conn:
            conn.execute("UPDATE users SET chat_model_name='model-b' WHERE id=1")
        await self.q.enqueue(self.user, scope, "Admin model")
        await self.drain()
        self.assertEqual(self.requests[1]["model"], {"id": "model-b", "thinking": "off"})
        await self.q.compact(self.user, scope)
        await self.drain()
        self.assertEqual(self.compactions, [{"model": {"id": "model-b", "thinking": "off"}}])
        await self.q.enqueue(self.user, "private", "Personal AI is unaffected")
        await self.drain()
        self.assertEqual(self.requests[2]["model"], {"id": "model-a", "thinking": "medium"})
        with self.p.db.connect() as conn:
            conn.execute("UPDATE users SET model_name='',chat_model_name='' WHERE id=1")
        self.p.oauth = SimpleNamespace(catalog=AsyncMock(return_value={"models": [{"id": "catalog-default"}]}))
        await self.q.enqueue(self.user, scope, "Catalog default")
        await self.drain()
        self.assertEqual(self.requests[3]["model"], {"id": "catalog-default", "thinking": "off"})

    async def test_users_see_no_model_in_events_or_messages(self):
        await self.q.enqueue(self.user, "private", "hello")
        await self.drain()
        with self.p.db.connect() as conn:
            conn.execute("UPDATE messages SET metadata_json=json_set(metadata_json,'$.generation','{}','$.token_usage','{}') WHERE author_type='agent'")
        for message in self.q.messages(self.user, "private")["messages"]:
            self.assertFalse({"generation", "token_usage"} & set(message["metadata"]))
        stream = self.q.events(self.user, "private", 0)
        event = {}
        while event.get("type") != "run_end":
            event = json.loads((await anext(stream)).split(b"data: ")[1])
        await stream.aclose()
        self.assertNotIn("model", event)
        with self.p.db.connect() as conn:
            self.assertEqual(conn.execute("SELECT model FROM token_usage_events").fetchone()[0], "model-a")

    async def test_compact_cancel_before_runtime_submission(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def catalog():
            entered.set()
            await release.wait()
            return {"models": [{"id": "model-a"}]}
        self.p.oauth.catalog = catalog
        await self.q.compact(self.user, "private")
        await asyncio.wait_for(entered.wait(), 2)
        await self.q.cancel(self.user, "private")
        release.set()
        await self.drain()
        self.assertEqual(self.compactions, [])
        self.assertEqual(self.q.messages(self.user, "private")["compaction"]["status"], "cancelled")

    async def test_compact_cancelled_while_queued_is_placed_where_it_settled(self):
        await self.q.enqueue(self.user, "private", "hello")
        await self.drain()
        newest = self.q.messages(self.user, "private")["messages"][-1]["id"]
        self.q.stopping = True
        await self.q.compact(self.user, "private")
        self.assertNotIn("after_message_id", self.q.messages(self.user, "private")["compaction"])
        await self.q.cancel(self.user, "private")
        compaction = self.q.messages(self.user, "private")["compaction"]
        self.assertEqual((compaction["status"], compaction["after_message_id"]), ("cancelled", newest))

    async def test_compact_permission_and_ownership(self):
        with self.p.db.connect() as conn:
            conn.execute("UPDATE users SET role='user',permission_group='no-access' WHERE id=2")
            conn.execute("INSERT INTO chat_conversations VALUES ('policy',1,'Policy',?,?,NULL)", (now(), now()))
        with self.assertRaises(HTTPException) as denied:
            await self.q.compact(self.q.user(2), "private")
        self.assertEqual(denied.exception.status_code, 403)
        with self.assertRaises(HTTPException) as ownership:
            await self.q.compact(self.q.user(2), "chat-policy")
        self.assertIn(ownership.exception.status_code, (403, 404))

    async def test_compact_fifo_and_accounting_without_phantom_messages(self):
        self.hold.clear()
        await self.q.enqueue(self.user, "private", "before")
        await asyncio.sleep(0)
        self.compact_hold.clear()
        accepted = await self.q.compact(self.user, "private")
        self.assertEqual(accepted["status"], "queued")
        self.assertEqual(self.q.messages(self.user, "private")["compaction"]["status"], "queued")
        self.hold.set()
        await asyncio.wait_for(self.compact_started.wait(), 2)
        await self.q.enqueue(self.user, "private", "after one")
        await self.q.enqueue(self.user, "private", "after two")
        self.assertEqual([r["prompt"]["text"] for r in self.requests], ["before"])
        self.assertEqual(self.q.messages(self.user, "private")["compaction"]["status"], "compacting")
        self.compact_hold.set()
        await self.drain()
        self.assertEqual(self.compact_timeout, 900)
        self.assertEqual([r["prompt"]["text"] for r in self.requests], ["before", "after one", "after two"])
        page = self.q.messages(self.user, "private")
        # Placed after the reply to "before": earlier work had finished when compaction started.
        before_reply = [m for m in page["messages"] if m["role"] == "assistant"][0]["id"]
        self.assertEqual(page["compaction"], {"job_id": accepted["job_id"], "status": "done", "after_message_id": before_reply})
        self.assertEqual([m["content"] for m in page["messages"] if m["role"] == "user"], ["before", "after one", "after two"])
        self.assertEqual([m["metadata"]["status"] for m in page["messages"] if m["role"] == "assistant"], ["completed"] * 3)
        with self.p.db.connect() as conn:
            events = [json.loads(row[0]) for row in conn.execute("SELECT event_json FROM queue_events")]
            usage = conn.execute("SELECT * FROM token_usage_events WHERE json_extract(raw_usage_json,'$.kind')='compaction'").fetchone()
        self.assertEqual([(e["phase"], e["status"]) for e in events if e["type"] == "compaction"], [("queued", "queued"), ("start", "compacting"), ("end", "done")])
        self.assertEqual([e.get("after_message_id", "absent") for e in events if e["type"] == "compaction"], ["absent", before_reply, before_reply])
        self.assertIsNone(usage["request_message_id"])
        self.assertIsNone(usage["response_message_id"])
        self.assertEqual((usage["input_tokens"], usage["output_tokens"], usage["total_tokens"]), (10, 2, 21))
        self.assertEqual(json.loads(usage["raw_usage_json"])["cacheRead"], 8)

    async def test_compact_too_small_and_cancelled_queued_have_no_messages_or_usage(self):
        self.compact_result = {"compacted": False, "reason": "too_small"}
        await self.q.compact(self.user, "private")
        await self.drain()
        page = self.q.messages(self.user, "private")
        self.assertEqual(page["compaction"]["status"], "nothing_to_compact")
        self.assertEqual(page["compaction"]["reason"], "too_small")
        self.assertIsNone(page["compaction"]["after_message_id"])
        self.q.stopping = True
        await self.q.compact(self.user, "private")
        await self.q.cancel(self.user, "private")
        self.assertEqual(self.q.messages(self.user, "private")["compaction"]["status"], "cancelled")
        with self.p.db.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM token_usage_events").fetchone()[0], 0)

    async def test_compact_restart_settles_before_prompt_without_replay(self):
        self.q.stopping = True
        compact = await self.q.compact(self.user, "private")
        await self.q.enqueue(self.user, "private", "after crash")
        with self.p.db.connect() as conn:
            conn.execute("UPDATE durable_jobs SET status='running' WHERE id=?", (compact["job_id"],))
        await self.q.start()
        await self.drain()
        self.assertEqual(self.calls[0], ("POST", "/v1/sessions/agent-private-1/cancel"))
        self.assertEqual(self.compactions, [])
        self.assertEqual([r["prompt"]["text"] for r in self.requests], ["after crash"])
        compaction = self.q.messages(self.user, "private")["compaction"]
        # "after crash" is queued behind the compaction, so it is not where the compaction belongs.
        self.assertEqual((compaction["status"], compaction["after_message_id"]), ("interrupted", None))

    async def test_compact_uncertain_blocks_until_sid_cancel_settles(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def runtime(request):
            self.calls.append((request.method, request.url.path))
            if request.url.path.endswith("/compact"):
                raise httpx.ReadTimeout("lost compact response")
            if request.url.path.endswith("/cancel"):
                entered.set()
                await release.wait()
                return httpx.Response(200, json={"cancelled": True, "run_id": None})
            return await self.http.send(request)
        async with httpx.AsyncClient(transport=httpx.MockTransport(runtime)) as client:
            self.p.http = client
            await self.q.compact(self.user, "private")
            await asyncio.wait_for(entered.wait(), 2)
            await self.q.enqueue(self.user, "private", "after uncertainty")
            self.assertEqual(self.requests, [])
            self.assertEqual(self.q.active, 1)
            release.set()
            await self.drain()
        self.assertEqual([r["prompt"]["text"] for r in self.requests], ["after uncertainty"])
        self.assertEqual(self.q.messages(self.user, "private")["compaction"]["status"], "interrupted")

    async def test_cancel_running_compact_settles_before_following_prompt(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def runtime(request):
            if request.url.path.endswith("/compact"):
                entered.set()
                await release.wait()
                return httpx.Response(409, json={"error": "Session compaction cancelled"})
            if request.url.path.endswith("/cancel"):
                release.set()
                return httpx.Response(200, json={"cancelled": True, "run_id": None})
            return await self.http.send(request)
        async with httpx.AsyncClient(transport=httpx.MockTransport(runtime)) as client:
            self.p.http = client
            await self.q.compact(self.user, "private")
            await asyncio.wait_for(entered.wait(), 2)
            await self.q.cancel(self.user, "private")
            await self.q.enqueue(self.user, "private", "after cancel")
            await self.drain()
        self.assertEqual(self.q.messages(self.user, "private")["compaction"]["status"], "cancelled")
        self.assertEqual([r["prompt"]["text"] for r in self.requests], ["after cancel"])

    async def test_cancelled_backlog_keeps_uncertain_runtime_blocking(self):
        cancelling = asyncio.Event()
        async def unavailable(request):
            if request.url.path.endswith("/runs"):
                raise httpx.ReadError("Runtime response lost")
            cancelling.set()
            return httpx.Response(503, json={"error": "Runtime unavailable"})
        async with httpx.AsyncClient(transport=httpx.MockTransport(unavailable)) as client:
            self.p.http = client
            await self.q.enqueue(self.user, "private", "uncertain")
            await self.q.enqueue(self.user, "private", "cancel this backlog")
            await asyncio.wait_for(cancelling.wait(), 2)
            await self.q.cancel(self.user, "private")
            self.assertEqual(self.q.active, 1)
            await self.q.stop()
            self.assertEqual(self.q.active, 1)
            with self.p.db.connect() as conn:
                rows = conn.execute("SELECT status,payload_json FROM durable_jobs ORDER BY id").fetchall()
            self.assertEqual([row["status"] for row in rows], ["failed", "failed"])
            self.assertTrue(json.loads(rows[0]["payload_json"])["runtime_unsettled"])
            self.assertEqual(self.q.messages(self.user, "private")["messages"][-1]["metadata"]["status"], "cancelled")

    async def test_schedule_occurrence_deduplicates_recovery(self):
        with self.p.db.connect() as conn:
            conn.execute("INSERT INTO agent_schedules(id,owner_user_id,name,prompt,schedule_json,created_at,updated_at) VALUES (1,1,'Once','scheduled','{}',1,1)")
            conn.execute("INSERT INTO agent_schedule_runs(id,schedule_id,scheduled_for,created_at,updated_at) VALUES (1,1,1,1,1)")
        self.q.stopping = True
        first = await self.q.enqueue(self.user, "private", "scheduled", schedule_run_id=1)
        recovered = await self.q.enqueue(self.user, "private", "scheduled", schedule_run_id=1)
        self.assertEqual(first["job_id"], recovered["job_id"])
        self.assertEqual(first["message"]["id"], recovered["message"]["id"])
        await self.q.start()
        await self.drain()
        self.assertEqual([request["prompt"]["text"] for request in self.requests], ["scheduled"])

    async def test_legacy_author_metadata_preserves_historical_name(self):
        info = self.q.scope(self.user, "private")
        with self.p.db.connect() as conn:
            mid = self.q.insert_message(conn, info, self.user, "user", "old message", {})
            conn.execute("UPDATE messages SET username='Historical Name' WHERE id=?", (mid,))
        message = self.q.message(info, mid)
        self.assertEqual(message["metadata"]["author_display_name"], "Historical Name")
        self.assertEqual(message["metadata"]["author_user_id"], 1)
        with self.p.db.connect() as conn:
            self.assertEqual(conn.execute("SELECT metadata_json FROM messages WHERE id=?", (mid,)).fetchone()[0], "{}")

    async def test_new_scope_records_live_sandbox_identity_once(self):
        with self.p.db.connect() as conn:
            conn.execute("INSERT INTO channels(id,name,created_at) VALUES (1,'General',1)")
        for scope, expected in (("private", "user-1"), ("channel-1", "channels/channel-1")):
            info = self.q.scope(self.user, scope)
            with self.p.db.connect() as conn:
                row = conn.execute("SELECT * FROM agent_scopes WHERE scope_key=?", (info["scope_key"],)).fetchone()
            self.assertEqual((row["workspace_path"], row["sandbox_id"], row["lifecycle_id"]),
                             (expected, expected.replace("/", "-"), info["sandbox"]["lifecycle_id"]))
            self.assertFalse((info["workspace"] / ".agent-platform-scope.json").exists())
            await self.q.reset(self.user, scope)
            self.assertEqual(self.q.scope(self.user, scope)["sandbox"], info["sandbox"])
            with self.p.db.connect() as conn:
                self.assertEqual(conn.execute("SELECT count(*) FROM agent_scopes WHERE scope_key=?", (info["scope_key"],)).fetchone()[0], 1)

    async def test_attachment_only_authorization_and_delivery(self):
        from enterprise_agent_platform.files import Files as WorkspaceFiles
        self.p.files = WorkspaceFiles(self.p)
        info = self.q.scope(self.user, "private")
        attachment = self.p.files.store(self.user, info, "report.txt", b"quarterly report")
        with self.assertRaises(HTTPException):
            await self.q.enqueue(self.q.user(2), "private", "", [attachment["id"]])
        result = await self.q.enqueue(self.user, "private", "", [attachment["id"]])
        await self.drain()
        self.assertEqual(result["message"]["attachments"][0]["id"], attachment["id"])
        self.assertIn("report.txt", self.requests[0]["prompt"]["text"])
        with self.assertRaises(HTTPException):
            await self.q.enqueue(self.user, "private", "")

    async def test_single_uncertain_run_blocks_until_confirmed_without_successor(self):
        from enterprise_agent_platform.gates import Gate as ManagerGate
        self.p.gate = ManagerGate(self.p)
        cancelling, confirmed = asyncio.Event(), asyncio.Event()
        original = self.q.runtime
        async def runtime(method, path, **kwargs):
            if path.endswith("/cancel"):
                cancelling.set()
                await confirmed.wait()
            return await original(method, path, **kwargs)
        self.q.runtime = runtime
        self.loss = True
        await self.q.enqueue(self.user, "private", "uncertain only")
        await asyncio.wait_for(cancelling.wait(), 2)
        self.assertEqual(self.q.active, 1)
        self.assertIsNone(self.q.pending("private:1"))
        readiness = await self.p.gate.readiness("update")
        self.assertFalse(readiness["reserved"])
        self.assertEqual(readiness["active_agent_tasks"], 1)
        confirmed.set()
        await self.drain()
        self.assertEqual(self.q.active, 0)
        self.assertEqual(len(self.requests), 1)
        self.assertTrue((await self.p.gate.readiness("update"))["reserved"])


if __name__ == "__main__":
    unittest.main()
