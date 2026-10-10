import asyncio
import base64
import json
import tempfile
import unittest
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.requests import Request

from enterprise_agent_platform.db import Database, now
from policy_support import set_default_policy
from enterprise_agent_platform.auth import issue_session, public_user
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

    def release(self, info, mid, conn):
        pass

    async def deliver(self, user, info, mid, text):
        return []



class ControlledStream(httpx.AsyncByteStream):
    def __init__(self):
        self.started = asyncio.Event()
        self.frames = asyncio.Queue()
        self.seq = 0

    async def __aiter__(self):
        self.started.set()
        while True:
            frame = await self.frames.get()
            if frame is None:
                return
            events, received = frame
            data = []
            for event in events:
                self.seq += 1
                data.append("data: " + json.dumps({"seq": self.seq, **event}) + "\n\n")
            yield "".join(data).encode()
            if received is not None:
                received.set()

    async def send(self, *events):
        received = asyncio.Event()
        self.frames.put_nowait((events, received))
        await asyncio.wait_for(received.wait(), 2)

    def finish(self, status="completed", text="answer", undelivered_inputs=()):
        self.frames.put_nowait(([{"type": "run_end", "status": status, "text": text,
                                 "model": "model-a", "usage": {},
                                 "undelivered_inputs": list(undelivered_inputs)}], None))

    def disconnect(self):
        self.frames.put_nowait(None)

class QueueTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        db = Database(root / "platform.db")
        db.migrate(root)
        with db.connect() as conn:
            for uid in (1, 2):
                conn.execute("INSERT INTO users(id,username,display_name,password_hash,role,created_at) VALUES (?,?,?,?,?,?)",
                             (uid, f"u{uid}", f"User {uid}", "unused", "admin", 1))
            set_default_policy(conn)
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
        self.streams = {}
        self.run_started = asyncio.Event()
        self.cancelled_runs = set()
        self.steers = []
        self.steer_jobs = []
        self.steer_started = asyncio.Event()
        self.steer_hold = asyncio.Event()
        self.steer_hold.set()
        self.steer_status = 200
        self.steer_error = None
        self.removals = []
        self.remove_started = asyncio.Event()
        self.remove_hold = asyncio.Event()
        self.remove_hold.set()
        self.remove_status = 200
        self.remove_error = None

        async def runtime(request):
            self.calls.append((request.method, request.url.path))
            if request.url.path.endswith("/runs"):
                self.requests.append(json.loads(request.content))
                run_id = f"r{len(self.requests)}"
                self.run_started.set()
                await self.hold.wait()
                return httpx.Response(202, json={"run_id": run_id})
            if request.url.path.endswith("/steer"):
                body = json.loads(request.content)
                self.steers.append((request.url.path, body))
                self.steer_jobs.append(self.job(int(body["input_id"])))
                self.steer_started.set()
                await self.steer_hold.wait()
                if self.steer_error is not None:
                    raise self.steer_error
                return httpx.Response(self.steer_status, json={"ok": self.steer_status == 200})
            if request.method == "DELETE" and "/inputs/" in request.url.path:
                self.removals.append(request.url.path)
                self.remove_started.set()
                await self.remove_hold.wait()
                if self.remove_error is not None:
                    raise self.remove_error
                return httpx.Response(self.remove_status, json={"removed": True} if self.remove_status == 200 else {"error": "Input is already delivered"})
            if request.url.path.startswith("/v1/runs/") and request.url.path.endswith("/cancel"):
                self.cancelled_runs.add(request.url.path.split("/")[-2])
                return httpx.Response(200, json={"cancelled": True})
            if request.url.path.endswith("/events"):
                run_id = request.url.path.split("/")[-2]
                if run_id in self.streams:
                    return httpx.Response(200, stream=self.streams[run_id])
                if self.runtime_stream is not None:
                    return httpx.Response(200, stream=self.runtime_stream)
                if self.runtime_events is not None:
                    return httpx.Response(200, text="".join(
                        "data: " + json.dumps({"seq": seq, **event}) + "\n\n"
                        for seq, event in enumerate(self.runtime_events, 1)))
                events = [{"seq": 1, "type": "text_delta", "delta": "answer"}]
                if not self.loss:
                    events.append({"seq": 2, "type": "run_end",
                                   "status": "cancelled" if run_id in self.cancelled_runs else "completed",
                                   "text": "answer", "model": "model-a",
                                   "usage": {"input": 10, "output": 2, "cache_read": 8, "cache_write": 1, "total": 21},
                                   "undelivered_inputs": []})
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

    def job(self, result):
        ident = result["job_id"] if isinstance(result, dict) else result
        with self.p.db.connect() as conn:
            row = dict(conn.execute("SELECT * FROM durable_jobs WHERE id=?", (ident,)).fetchone())
        row["payload"] = json.loads(row["payload_json"])
        return row

    def recorded_events(self, scope="private", user=None):
        key = self.q.payload_key({"scope": scope, "user_id": (user or self.user)["id"]})
        with self.p.db.connect() as conn:
            return [json.loads(row[0]) for row in conn.execute(
                "SELECT event_json FROM queue_events WHERE scope_key=? ORDER BY id", (key,))]

    async def begin_run(self, scope="private", user=None, content="first", schedule_run_id=None):
        stream = ControlledStream()
        self.streams[f"r{len(self.requests) + 1}"] = stream
        result = await self.q.enqueue(user or self.user, scope, content, schedule_run_id=schedule_run_id)
        await asyncio.wait_for(stream.started.wait(), 2)
        return result, stream

    def schedule_occurrence(self):
        with self.p.db.connect() as conn:
            conn.execute("INSERT INTO agent_schedules(id,owner_user_id,name,prompt,schedule_json,created_at,updated_at) VALUES (1,1,'Once','scheduled','{}',1,1)")
            conn.execute("INSERT INTO agent_schedule_runs(id,schedule_id,scheduled_for,created_at,updated_at) VALUES (1,1,1,1,1)")
        return 1

    def assert_reply_to(self, message, request):
        self.assertEqual(message["metadata"]["reply_to"]["message_id"], request["message"]["id"])

    async def test_idle_messages_start_separate_runs_with_stable_session(self):
        first = await self.q.enqueue(self.user, "private", "first")
        await self.drain()
        second = await self.q.enqueue(self.user, "private", "second")
        await self.drain()
        self.assertEqual([r["prompt"]["text"] for r in self.requests], ["first", "second"])
        self.assertEqual([path for method, path in self.calls if path.endswith("/runs")], ["/v1/sessions/agent-private-1/runs"] * 2)
        self.assertEqual(self.steers, [])
        page = self.q.messages(self.user, "private")
        self.assertEqual([m["content"] for m in page["messages"]], ["first", "answer", "second", "answer"])
        self.assertIsNone(page["next_before_id"])
        self.assertEqual(page["messages"][0]["metadata"]["author_display_name"], "User 1")
        self.assert_reply_to(page["messages"][1], first)
        self.assert_reply_to(page["messages"][3], second)
        for request in (first, second):
            self.assertNotIn("parent_job_id", self.job(request)["payload"])
            self.assertNotIn("inserted_into", request["message"]["metadata"])
        with self.p.db.connect() as conn:
            self.assertEqual([r[0] for r in conn.execute("SELECT status FROM durable_jobs ORDER BY id")], ["succeeded", "succeeded"])
            usage = json.loads(conn.execute("SELECT raw_usage_json FROM token_usage_events LIMIT 1").fetchone()[0])
            self.assertEqual(usage["cacheRead"], 8)

    async def test_active_run_absorbs_before_run_id_and_delivers_in_acceptance_order(self):
        stream = self.streams["r1"] = ControlledStream()
        self.hold.clear()
        parent = await self.q.enqueue(self.user, "private", "first")
        await asyncio.wait_for(self.run_started.wait(), 2)
        children = [await self.q.enqueue(self.user, "private", text) for text in ("second", "third")]
        self.assertEqual(self.steers, [])
        self.assertNotIn("private:1", self.q.running)
        for child in children:
            stored = self.job(child)
            self.assertEqual(stored["status"], "running")
            self.assertEqual(stored["payload"]["parent_job_id"], parent["job_id"])
            self.assertFalse(stored["payload"].get("steer_sent", False))
            self.assertEqual(child["message"]["metadata"]["status"], "running")
            self.assertEqual(child["message"]["metadata"]["inserted_into"], parent["message"]["id"])
            self.assertEqual(child["message"]["metadata"]["delivery"], "pending")
        self.hold.set()
        await asyncio.wait_for(stream.started.wait(), 2)
        self.assertEqual([path for path, body in self.steers], ["/v1/runs/r1/steer"] * 2)
        self.assertEqual([body["input_id"] for path, body in self.steers],
                         [str(child["job_id"]) for child in children])
        self.assertEqual([body["prompt"] for path, body in self.steers],
                         [{"text": text, "images": []} for text in ("second", "third")])
        for stored in self.steer_jobs:
            self.assertEqual(stored["status"], "running")
            self.assertEqual(stored["payload"]["parent_job_id"], parent["job_id"])
            self.assertIs(stored["payload"]["steer_sent"], True)
        await stream.send({"type": "text_delta", "delta": "Original answer before insertion"},
                          *[{"type": "input_delivered", "input_id": str(child["job_id"])} for child in children],
                          {"type": "text_delta", "delta": "Updated answer"})
        stream.finish(text="Updated answer")
        await self.drain()
        page = self.q.messages(self.user, "private")
        self.assertEqual([message["content"] for message in page["messages"]],
                         ["first", "second", "third", "Updated answer"])
        self.assert_reply_to(page["messages"][-1], parent)
        self.assertEqual(len(self.requests), 1)
        self.assertTrue(all(self.job(request)["status"] == "succeeded" for request in (parent, *children)))
        for message in page["messages"][1:3]:
            self.assertEqual((message["metadata"]["status"], message["metadata"]["delivery"]),
                             ("completed", "delivered"))
        work = page["messages"][-1]["metadata"]["work"]
        self.assertFalse(work["truncated"])
        self.assertEqual(work["items"][0], {"type": "text", "text": "Original answer before insertion"})
        self.assertEqual([item["message_id"] for item in work["items"][1:]],
                         [child["message"]["id"] for child in children])
        for item in work["items"][1:]:
            self.assertEqual(set(item), {"type", "message_id", "at"})
            self.assertEqual(item["type"], "input")
            self.assertLessEqual(work["started_at"], item["at"])
            self.assertLessEqual(item["at"], work["ended_at"])
        events = self.recorded_events()
        delivered = [event for event in events if event["type"] == "input_delivered"]
        self.assertEqual(delivered, [{"type": "input_delivered", "message_id": child["message"]["id"]}
                                     for child in children])
        for event in delivered:
            prior = events[events.index(event) - 1]
            self.assertEqual(prior["type"], "message")
            self.assertEqual(prior["message"]["id"], event["message_id"])
            self.assertEqual(prior["message"]["metadata"]["delivery"], "delivered")
        public = self.q.events(self.user, "private", 0)
        try:
            async with asyncio.timeout(2):
                for expected in events:
                    event = json.loads((await anext(public)).split(b"data: ", 1)[1])
                    self.assertEqual(event["type"], expected["type"])
                    self.assertNotIn("input_id", json.dumps(event))
                    self.assertNotIn("undelivered_inputs", json.dumps(event))
        finally:
            await public.aclose()
        with self.p.db.connect() as conn:
            usage = conn.execute("SELECT request_message_id,response_message_id FROM token_usage_events").fetchall()
        self.assertEqual([tuple(row) for row in usage], [(parent["message"]["id"], page["messages"][-1]["id"])])

    async def test_chat_and_channel_insertions_use_author_context_and_attachment_prompt(self):
        from enterprise_agent_platform.files import Files as WorkspaceFiles
        self.p.files = WorkspaceFiles(self.p)
        with self.p.db.connect() as conn:
            conn.execute("INSERT INTO chat_conversations VALUES ('steering',1,'Steering',?,?,NULL)", (now(), now()))
            conn.execute("INSERT INTO channels(id,name,created_at) VALUES (1,'General',1)")
            conn.execute("UPDATE users SET display_name='Channel Author',timezone='Asia/Tokyo' WHERE id=2")
        for scope, uid, name, timezone in [
            ("chat-steering", 1, "Updated Chat Author", "Pacific/Auckland"),
            ("channel-1", 2, "Channel Author", "Asia/Tokyo"),
        ]:
            with self.subTest(scope=scope):
                with self.p.db.connect() as conn:
                    conn.execute("UPDATE users SET display_name='User 1',timezone='UTC' WHERE id=1")
                parent, stream = await self.begin_run(scope, self.q.user(1))
                with self.p.db.connect() as conn:
                    conn.execute("UPDATE users SET display_name=?,timezone=? WHERE id=?", (name, timezone, uid))
                author = self.q.user(uid)
                info = self.q.scope(author, scope)
                image = base64.b64decode(
                    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4hcAAAAASUVORK5CYII=")
                attachments = [
                    self.p.files.store(author, info, "report.txt", b"quarterly report"),
                    self.p.files.store(author, info, "chart.png", image),
                ]
                ids = [attachment["id"] for attachment in attachments]
                expected_prompt = self.p.files.prompt(author, info, ids)
                with patch.object(self.p.files, "prompt", wraps=self.p.files.prompt) as prompt:
                    child = await self.q.enqueue(author, scope, "Use these instead", ids)
                prompt.assert_called_once()
                self.assertEqual(prompt.call_args.args[0]["id"], uid)
                self.assertEqual(prompt.call_args.args[1]["scope_key"], info["scope_key"])
                self.assertEqual(prompt.call_args.args[2], ids)
                body = self.steers[-1][1]
                self.assertEqual(body["prompt"], {"text": "Use these instead\n" + expected_prompt["text"],
                                                  "images": expected_prompt["images"]})
                self.assertEqual(body["prompt"]["images"], [{"mime": "image/png", "data": base64.b64encode(image).decode()}])
                prefix = json.loads(body["context_prefix"])
                self.assertEqual((prefix["user"], prefix["tz"]), (name, timezone))
                self.assertIsInstance(prefix["time"], str)
                original_prefix = json.loads(self.requests[-1]["context_prefix"])
                self.assertEqual((original_prefix["user"], original_prefix["tz"]), ("User 1", "UTC"))
                self.assertEqual(child["message"]["metadata"]["author_display_name"], name)
                self.assertEqual(child["message"]["metadata"]["author_user_id"], uid)
                self.assertEqual(child["message"]["metadata"]["inserted_into"], parent["message"]["id"])
                self.assertEqual([attachment["id"] for attachment in child["message"]["attachments"]], ids)
                self.assertEqual(self.job(child)["payload"]["parent_job_id"], parent["job_id"])
                await stream.send({"type": "input_delivered", "input_id": str(child["job_id"])})
                stream.finish()
                await self.drain()
                replies = [message for message in self.q.messages(author, scope)["messages"] if message["role"] == "assistant"]
                self.assertEqual(len(replies), 1)
                self.assert_reply_to(replies[0], parent)
                self.assertEqual(replies[0]["metadata"]["work"]["items"][0]["message_id"], child["message"]["id"])
                self.assertEqual(self.job(child)["status"], "succeeded")
        self.assertEqual(len(self.requests), 2)

    async def test_active_insertion_preserves_content_and_attachment_validation(self):
        parent, stream = await self.begin_run()
        for content, attachments, status in [
            ("", [], 400), ("x" * (1024 * 1024 + 1), [], 413),
            ("too many attachments", list(range(33)), 413), ("unknown attachment", [999], 404),
        ]:
            with self.subTest(status=status, attachments=len(attachments)):
                with self.assertRaises(HTTPException) as rejected:
                    await self.q.enqueue(self.user, "private", content, attachments)
                self.assertEqual(rejected.exception.status_code, status)
        with self.p.db.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM durable_jobs").fetchone()[0], 1)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0], 1)
        self.assertEqual(self.steers, [])
        stream.finish()
        await self.drain()
        self.assert_reply_to(self.q.messages(self.user, "private")["messages"][-1], parent)

    async def test_scheduled_parent_does_not_absorb_interactive_message(self):
        parent, stream = await self.begin_run(content="scheduled", schedule_run_id=self.schedule_occurrence())
        child = await self.q.enqueue(self.user, "private", "interactive")
        self.assertEqual(self.job(child)["status"], "queued")
        self.assertNotIn("parent_job_id", self.job(child)["payload"])
        self.assertNotIn("inserted_into", child["message"]["metadata"])
        self.assertEqual(self.steers, [])
        stream.finish()
        await self.drain()
        self.assertEqual([request["prompt"]["text"] for request in self.requests], ["scheduled", "interactive"])
        replies = [message for message in self.q.messages(self.user, "private")["messages"] if message["role"] == "assistant"]
        for reply, request in zip(replies, (parent, child), strict=True):
            self.assert_reply_to(reply, request)
        with self.p.db.connect() as conn:
            self.assertEqual(conn.execute("SELECT status FROM agent_schedule_runs").fetchone()[0], "succeeded")

    async def test_schedule_occurrence_during_interactive_run_stays_fifo(self):
        parent, stream = await self.begin_run()
        scheduled = await self.q.enqueue(self.user, "private", "scheduled", schedule_run_id=self.schedule_occurrence())
        self.assertEqual(self.job(scheduled)["status"], "queued")
        self.assertNotIn("parent_job_id", self.job(scheduled)["payload"])
        self.assertNotIn("inserted_into", scheduled["message"]["metadata"])
        self.assertEqual(self.steers, [])
        stream.finish()
        await self.drain()
        self.assertEqual([request["prompt"]["text"] for request in self.requests], ["first", "scheduled"])
        replies = [message for message in self.q.messages(self.user, "private")["messages"] if message["role"] == "assistant"]
        for reply, request in zip(replies, (parent, scheduled), strict=True):
            self.assert_reply_to(reply, request)

    async def test_queued_work_prevents_later_interactive_absorption(self):
        parent, stream = await self.begin_run()
        compact = await self.q.compact(self.user, "private")
        child = await self.q.enqueue(self.user, "private", "after queued compaction")
        self.assertEqual(self.job(compact)["status"], "queued")
        self.assertEqual(self.job(child)["status"], "queued")
        self.assertNotIn("parent_job_id", self.job(child)["payload"])
        self.assertEqual(child["message"]["metadata"]["status"], "queued")
        self.assertEqual(self.steers, [])
        stream.finish()
        await self.drain()
        operations = [path.rsplit("/", 1)[-1] for method, path in self.calls if method == "POST"]
        self.assertEqual(operations, ["runs", "compact", "runs"])
        replies = [message for message in self.q.messages(self.user, "private")["messages"] if message["role"] == "assistant"]
        for reply, request in zip(replies, (parent, child), strict=True):
            self.assert_reply_to(reply, request)

    async def test_cancelling_scope_keeps_new_messages_out_of_active_run(self):
        parent, stream = await self.begin_run()
        inserted = await self.q.enqueue(self.user, "private", "cancel with parent")
        await self.q.cancel(self.user, "private")
        self.assertIn("private:1", self.q.cancelling)
        later = await self.q.enqueue(self.user, "private", "after cancellation")
        self.assertEqual(self.job(later)["status"], "queued")
        self.assertNotIn("parent_job_id", self.job(later)["payload"])
        self.assertEqual(len(self.steers), 1)
        stream.finish(status="cancelled", undelivered_inputs=[str(inserted["job_id"])])
        await self.drain()
        messages = self.q.messages(self.user, "private")["messages"]
        child = next(message for message in messages if message["id"] == inserted["message"]["id"])
        self.assertEqual(child["metadata"]["status"], "cancelled")
        self.assertEqual(self.job(inserted)["status"], "failed")
        self.assertEqual([request["prompt"]["text"] for request in self.requests], ["first", "after cancellation"])
        replies = [message for message in messages if message["role"] == "assistant"]
        for reply, request in zip(replies, (parent, later), strict=True):
            self.assert_reply_to(reply, request)

    async def test_other_scope_backlog_does_not_prevent_insertion(self):
        parent, stream = await self.begin_run()
        with patch.object(self.q, "wake"):
            other = await self.q.enqueue(self.q.user(2), "private", "other user's queue")
        child = await self.q.enqueue(self.user, "private", "same scope")
        self.assertEqual(self.job(other)["status"], "queued")
        self.assertEqual(self.job(child)["payload"]["parent_job_id"], parent["job_id"])
        await stream.send({"type": "input_delivered", "input_id": str(child["job_id"])})
        stream.finish()
        await self.drain()
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.job(other)["status"], "queued")

    async def test_normal_completion_requeues_only_undelivered_inputs_in_order(self):
        parent, stream = await self.begin_run()
        delivered = await self.q.enqueue(self.user, "private", "used in parent")
        pending = [await self.q.enqueue(self.user, "private", text) for text in ("queued one", "queued two")]
        await stream.send({"type": "input_delivered", "input_id": str(delivered["job_id"])})
        original_settle = self.q.settle_inputs
        settled = []

        def settle(conn, parent_job_id, info, status, error=None):
            if parent_job_id == parent["job_id"]:
                self.assertTrue(conn.in_transaction)
                self.assertEqual(conn.execute("SELECT status FROM durable_jobs WHERE id=?", (parent_job_id,)).fetchone()[0],
                                 "succeeded")
                with self.p.db.connect() as observer:
                    self.assertEqual([row[0] for row in observer.execute("SELECT status FROM durable_jobs ORDER BY id")],
                                     ["running"] * 4)
            mids = original_settle(conn, parent_job_id, info, status, error)
            if parent_job_id == parent["job_id"]:
                settled.extend(mids)
                self.assertEqual([row[0] for row in conn.execute("SELECT status FROM durable_jobs ORDER BY id")],
                                 ["succeeded", "succeeded", "queued", "queued"])
            return mids

        with patch.object(self.q, "settle_inputs", side_effect=settle):
            stream.finish(undelivered_inputs=[str(child["job_id"]) for child in pending])
            await self.drain()
        self.assertEqual(settled, [child["message"]["id"] for child in (delivered, *pending)])
        self.assertEqual([request["prompt"]["text"] for request in self.requests], ["first", "queued one", "queued two"])
        messages = self.q.messages(self.user, "private")["messages"]
        replies = [message for message in messages if message["role"] == "assistant"]
        for reply, request in zip(replies, (parent, *pending), strict=True):
            self.assert_reply_to(reply, request)
        for child in pending:
            job = self.job(child)
            self.assertEqual(job["status"], "succeeded")
            self.assertNotIn("parent_job_id", job["payload"])
            self.assertNotIn("steer_sent", job["payload"])
            message = next(message for message in messages if message["id"] == child["message"]["id"])
            self.assertNotIn("inserted_into", message["metadata"])
            self.assertNotIn("delivery", message["metadata"])
            updates = [event["message"] for event in self.recorded_events() if event["type"] == "message"
                       and event["message"]["id"] == child["message"]["id"]]
            queued = next(message for message in updates if message["metadata"]["status"] == "queued")
            self.assertNotIn("inserted_into", queued["metadata"])
            self.assertNotIn("delivery", queued["metadata"])
        delivered_message = next(message for message in messages if message["id"] == delivered["message"]["id"])
        self.assertEqual(delivered_message["metadata"]["status"], "completed")
        self.assertEqual(delivered_message["metadata"]["delivery"], "delivered")
        self.assertNotIn("undelivered_inputs", json.dumps(self.recorded_events()))
        with self.p.db.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM token_usage_events").fetchone()[0], 3)

    async def test_failed_cancelled_and_lost_parents_settle_children_without_replies(self):
        for runtime_status, status in [("failed", "interrupted"), ("cancelled", "cancelled"), (None, "interrupted")]:
            with self.subTest(status=runtime_status):
                first_request = len(self.requests)
                parent, stream = await self.begin_run(content=f"parent {runtime_status}")
                children = [await self.q.enqueue(self.user, "private", text) for text in ("delivered", "pending")]
                await stream.send({"type": "input_delivered", "input_id": str(children[0]["job_id"])})
                if runtime_status is None:
                    stream.disconnect()
                else:
                    stream.finish(status=runtime_status, undelivered_inputs=[str(children[1]["job_id"])])
                await self.drain()
                self.assertEqual(len(self.requests), first_request + 1)
                messages = self.q.messages(self.user, "private")["messages"]
                replies = [message for message in messages if message["role"] == "assistant"
                           and message["metadata"]["reply_to"]["message_id"] == parent["message"]["id"]]
                self.assertEqual(len(replies), 1)
                self.assertEqual(replies[0]["metadata"]["status"], status)
                for child, delivery in zip(children, ("delivered", "pending"), strict=True):
                    self.assertEqual(self.job(child)["status"], "failed")
                    message = next(message for message in messages if message["id"] == child["message"]["id"])
                    self.assertEqual(message["metadata"]["status"], status)
                    self.assertEqual(message["metadata"]["delivery"], delivery)
                    self.assertEqual(message["metadata"]["inserted_into"], parent["message"]["id"])
                    self.assertFalse(any(message["role"] == "assistant"
                                         and message["metadata"]["reply_to"]["message_id"] == child["message"]["id"]
                                         for message in messages))
                    updates = [event["message"] for event in self.recorded_events() if event["type"] == "message"
                               and event["message"]["id"] == child["message"]["id"]]
                    self.assertEqual(updates[-1]["metadata"]["status"], status)
                self.assertNotIn("undelivered_inputs", json.dumps(self.recorded_events()))
                self.assertEqual(self.q.active, 0)

    async def test_file_delivery_failure_interrupts_delivered_and_pending_children(self):
        for runtime_status in ("completed", "cancelled", "failed"):
            with self.subTest(status=runtime_status):
                before = len(self.requests)
                parent, stream = await self.begin_run()
                children = [await self.q.enqueue(self.user, "private", text) for text in ("delivered", "pending")]
                await stream.send({"type": "input_delivered", "input_id": str(children[0]["job_id"])})
                with patch.object(self.p.files, "deliver", side_effect=OSError("attachment storage unavailable")):
                    stream.finish(status=runtime_status, undelivered_inputs=[str(children[1]["job_id"])])
                    await self.drain()
                self.assertEqual(len(self.requests), before + 1)
                self.assertTrue(all(self.job(request)["status"] == "failed" for request in (parent, *children)))
                messages = [message for message in self.q.messages(self.user, "private")["messages"]
                            if message["id"] >= parent["message"]["id"]]
                replies = [message for message in messages if message["role"] == "assistant"]
                self.assertEqual(len(replies), 1)
                self.assert_reply_to(replies[0], parent)
                for message in messages:
                    self.assertEqual(message["metadata"]["status"], "interrupted")
                    self.assertIn("attachment storage unavailable", message["metadata"]["error"])
                for child in children:
                    updates = [event["message"] for event in self.recorded_events() if event["type"] == "message"
                               and event["message"]["id"] == child["message"]["id"]]
                    self.assertEqual(updates[-1]["metadata"]["status"], "interrupted")

    async def test_definite_steer_rejections_requeue_with_independent_replies(self):
        for status in (404, 409):
            with self.subTest(status=status):
                parent, stream = await self.begin_run(content=f"parent {status}")
                self.steer_status = status
                child = await self.q.enqueue(self.user, "private", f"rejected {status}")
                stored = self.job(child)
                self.assertEqual(stored["status"], "queued")
                self.assertNotIn("parent_job_id", stored["payload"])
                self.assertNotIn("steer_sent", stored["payload"])
                self.assertEqual(child["message"]["metadata"]["status"], "queued")
                self.assertNotIn("inserted_into", child["message"]["metadata"])
                self.assertNotIn("delivery", child["message"]["metadata"])
                stream.finish()
                await self.drain()
                self.assertEqual([request["prompt"]["text"] for request in self.requests[-2:]],
                                 [f"parent {status}", f"rejected {status}"])
                replies = [message for message in self.q.messages(self.user, "private")["messages"] if message["role"] == "assistant"]
                self.assert_reply_to(replies[-2], parent)
                self.assert_reply_to(replies[-1], child)
                self.assertEqual(self.job(child)["status"], "succeeded")
        self.assertEqual(len(self.steers), 2)

    async def test_uncertain_steer_is_never_resent_by_repeat_drain_or_recovery(self):
        for error, delivered in [(httpx.ReadTimeout("lost steer response"), True),
                                 (httpx.ConnectError("steer connection lost"), False)]:
            with self.subTest(error=type(error).__name__):
                before = len(self.steers)
                parent, stream = await self.begin_run()
                self.steer_error = error
                child = await self.q.enqueue(self.user, "private", "uncertain input")
                self.assertEqual(self.job(child)["status"], "running")
                self.assertIs(self.job(child)["payload"]["steer_sent"], True)
                self.assertIs(self.steer_jobs[-1]["payload"]["steer_sent"], True)
                info = self.q.scope(self.user, "private")
                async with self.q.lock(info["scope_key"]):
                    await self.q.send_inputs(parent["job_id"], info)
                    await self.q.send_inputs(parent["job_id"], info)
                self.q.resume()
                self.assertEqual(len(self.steers), before + 1)
                if delivered:
                    await stream.send({"type": "input_delivered", "input_id": str(child["job_id"])})
                    stream.finish()
                else:
                    stream.disconnect()
                await self.drain()
                self.q = self.p.queue = Queue(self.p)
                await self.q.start()
                await self.drain()
                async with self.q.lock(info["scope_key"]):
                    await self.q.send_inputs(parent["job_id"], info)
                self.assertEqual(len(self.steers), before + 1)
                self.assertEqual(self.job(child)["status"], "succeeded" if delivered else "failed")
                replies = [message for message in self.q.messages(self.user, "private")["messages"] if message["role"] == "assistant"]
                self.assert_reply_to(replies[-1], parent)
                self.assertFalse(any(message["metadata"]["reply_to"]["message_id"] == child["message"]["id"]
                                     for message in replies))

    def stored(self, scope, mid):
        table = "chat_messages" if scope.startswith("chat-") else "messages"
        with self.p.db.connect() as conn:
            return conn.execute(f"SELECT 1 FROM {table} WHERE id=?", (mid,)).fetchone() is not None

    async def assert_refused(self, status, detail, user, scope, mid):
        with self.assertRaises(HTTPException) as caught:
            await self.q.withdraw(user, scope, mid)
        self.assertEqual((caught.exception.status_code, caught.exception.detail), (status, detail))

    def real_files(self):
        from enterprise_agent_platform.files import Files as WorkspaceFiles
        self.p.files = WorkspaceFiles(self.p)
        with self.p.db.connect() as conn:
            conn.execute("INSERT INTO chat_conversations VALUES ('c1',1,'Chat',?,?,NULL)", (now(), now()))
            conn.execute("INSERT INTO channels(id,name,created_at) VALUES (1,'General',1)")

    async def test_after_turn_is_never_absorbed_and_runs_as_its_own_turn_after_the_current_one(self):
        self.real_files()
        for scope in ("private", "chat-c1", "channel-1"):
            with self.subTest(scope=scope):
                before = len(self.requests)
                parent, stream = await self.begin_run(scope)
                later = await self.q.enqueue(self.user, scope, "after this turn", mode="after_turn")
                stored = self.job(later)
                self.assertEqual(stored["status"], "queued")
                self.assertNotIn("parent_job_id", stored["payload"])
                self.assertEqual(later["message"]["metadata"]["send_mode"], "after_turn")
                self.assertEqual(later["message"]["metadata"]["status"], "queued")
                self.assertNotIn("inserted_into", later["message"]["metadata"])
                behind = await self.q.enqueue(self.user, scope, "behind it")
                self.assertEqual(self.job(behind)["status"], "queued", "queued work stops later inserts from overtaking it")
                self.assertNotIn("send_mode", behind["message"]["metadata"])
                self.assertEqual(self.steers, [])
                stream.finish()
                await self.drain()
                self.assertEqual([r["prompt"]["text"] for r in self.requests[before:]], ["first", "after this turn", "behind it"])
                replies = [m for m in self.q.messages(self.user, scope)["messages"] if m["role"] == "assistant"]
                for reply, request in zip(replies, (parent, later, behind), strict=True):
                    self.assert_reply_to(reply, request)
        self.assertEqual(self.steers, [])

    async def test_send_mode_is_validated_and_after_turn_on_an_idle_scope_runs_normally(self):
        with self.assertRaises(HTTPException) as caught:
            await self.q.enqueue(self.user, "private", "x", mode="sideways")
        self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(self.q.messages(self.user, "private")["messages"], [])
        sent = await self.q.enqueue(self.user, "private", "idle", mode="after_turn")
        await self.drain()
        self.assertEqual([r["prompt"]["text"] for r in self.requests], ["idle"])
        self.assertEqual(self.job(sent)["status"], "succeeded")

    async def test_withdrawing_a_queued_message_returns_content_and_attachments_that_stay_owned(self):
        self.real_files()
        for scope in ("private", "chat-c1", "channel-1"):
            for mode in ("insert", "after_turn"):
                with self.subTest(scope=scope, mode=mode):
                    before = len(self.requests)
                    parent, stream = await self.begin_run(scope)
                    # A queued schedule-free predecessor keeps the insert-mode message FIFO; after_turn is queued by itself.
                    blocker = await self.q.enqueue(self.user, scope, "blocker", mode="after_turn")
                    info = self.q.scope(self.user, scope)
                    attachment = self.p.files.store(self.user, info, "report.txt", b"data")
                    queued = await self.q.enqueue(self.user, scope, "my text", [attachment["id"]], mode=mode)
                    self.assertEqual(self.job(queued)["status"], "queued")
                    mid = queued["message"]["id"]
                    result = await self.q.withdraw(self.user, scope, mid)
                    self.assertEqual(result, {"content": "my text", "attachments": [attachment]})
                    self.assertFalse(self.stored(scope, mid))
                    job = self.job(queued)
                    self.assertEqual((job["status"], job["last_error"]), ("failed", "withdrawn"))
                    self.assertEqual(self.recorded_events(scope)[-1], {"type": "message_removed", "message_id": mid})
                    with self.p.db.connect() as conn:
                        row, _ = self.p.files.owned(self.user, attachment["id"], conn)
                        self.assertIsNone(row["message_id"])
                        self.assertEqual(row["uploader_user_id"], 1)
                        self.assertTrue(self.p.files.storage(row).exists(), "the uploaded file itself is kept")
                    stream.finish()
                    await self.drain()
                    self.assertEqual([r["prompt"]["text"] for r in self.requests[before:]], ["first", "blocker"], "the withdrawn message never runs")
                    again = await self.q.enqueue(self.user, scope, "my text again", [attachment["id"]])
                    self.assertEqual([a["id"] for a in again["message"]["attachments"]], [attachment["id"]])
                    await self.drain()
                    self.assertEqual(self.requests[-1]["prompt"]["text"].split("\n")[0], "my text again")
                    self.assertEqual(self.q.messages(self.user, scope)["messages"][-2]["content"], "my text again")

    async def test_withdrawing_an_absorbed_message_before_submission_never_reaches_runtime(self):
        stream = self.streams["r1"] = ControlledStream()
        self.hold.clear()
        parent = await self.q.enqueue(self.user, "private", "first")
        await asyncio.wait_for(self.run_started.wait(), 2)
        dropped = await self.q.enqueue(self.user, "private", "changed my mind")
        kept = await self.q.enqueue(self.user, "private", "keep this")
        for child in (dropped, kept):
            self.assertEqual(self.job(child)["payload"]["parent_job_id"], parent["job_id"])
        self.assertEqual(await self.q.withdraw(self.user, "private", dropped["message"]["id"]), {"content": "changed my mind", "attachments": []})
        self.assertEqual(self.job(dropped)["status"], "failed")
        self.assertFalse(self.stored("private", dropped["message"]["id"]))
        self.hold.set()
        await asyncio.wait_for(stream.started.wait(), 2)
        self.assertEqual([body["input_id"] for path, body in self.steers], [str(kept["job_id"])])
        self.assertEqual(self.removals, [])
        await stream.send({"type": "input_delivered", "input_id": str(kept["job_id"])})
        stream.finish()
        await self.drain()
        messages = self.q.messages(self.user, "private")["messages"]
        self.assertEqual([m["content"] for m in messages], ["first", "keep this", "answer"])
        self.assertEqual(self.job(kept)["status"], "succeeded")

    async def test_withdrawing_a_submitted_undelivered_input_removes_it_from_the_run(self):
        self.real_files()
        for scope in ("private", "chat-c1", "channel-1"):
            with self.subTest(scope=scope):
                before = len(self.requests)
                parent, stream = await self.begin_run(scope)
                info = self.q.scope(self.user, scope)
                attachment = self.p.files.store(self.user, info, "notes.txt", b"notes")
                child = await self.q.enqueue(self.user, scope, "wait, not that", [attachment["id"]])
                self.assertIs(self.job(child)["payload"]["steer_sent"], True)
                mid = child["message"]["id"]
                removals = len(self.removals)
                self.assertEqual(await self.q.withdraw(self.user, scope, mid), {"content": "wait, not that", "attachments": [attachment]})
                self.assertEqual(self.removals[removals:], [f"/v1/runs/r{before + 1}/inputs/{child['job_id']}"])
                self.assertEqual(self.job(child)["status"], "failed")
                self.assertFalse(self.stored(scope, mid))
                self.assertEqual(self.recorded_events(scope)[-1], {"type": "message_removed", "message_id": mid})
                await stream.send({"type": "input_delivered", "input_id": str(child["job_id"])})
                stream.finish()
                await self.drain()
                self.assertEqual(len(self.requests), before + 1, "nothing is requeued or run for the withdrawn input")
                messages = self.q.messages(self.user, scope)["messages"]
                self.assertEqual([m["content"] for m in messages if m["role"] == "user"], ["first"])
                self.assertEqual(len([m for m in messages if m["role"] == "assistant"]), 1)
                self.assertFalse(any(e["type"] == "input_delivered" for e in self.recorded_events(scope)))

    async def test_message_removed_reaches_the_event_stream_without_a_message_payload(self):
        parent, stream = await self.begin_run()
        child = await self.q.enqueue(self.user, "private", "gone")
        await self.q.withdraw(self.user, "private", child["message"]["id"])
        stream.finish()
        await self.drain()
        public = self.q.events(self.user, "private", 0)
        removed = None
        try:
            async with asyncio.timeout(2):
                while removed is None:
                    event = json.loads((await anext(public)).split(b"data: ", 1)[1])
                    if event["type"] == "message_removed":
                        removed = event
        finally:
            await public.aclose()
        self.assertEqual({k: v for k, v in removed.items() if k != "seq"}, {"type": "message_removed", "message_id": child["message"]["id"]})

    async def test_withdraw_is_refused_once_the_ai_has_seen_or_started_the_message(self):
        parent, stream = await self.begin_run()
        child = await self.q.enqueue(self.user, "private", "read by the AI")
        await stream.send({"type": "input_delivered", "input_id": str(child["job_id"])})
        removals = len(self.removals)
        await self.assert_refused(409, "already_seen", self.user, "private", child["message"]["id"])
        await self.assert_refused(409, "already_seen", self.user, "private", parent["message"]["id"])
        self.assertEqual(len(self.removals), removals, "a delivered input is refused without asking Runtime")
        for mid in (child["message"]["id"], parent["message"]["id"]):
            self.assertTrue(self.stored("private", mid))
        stream.finish()
        await self.drain()
        done = self.q.messages(self.user, "private")["messages"]
        for message in done:
            if message["role"] == "assistant":
                await self.assert_refused(400, "Message cannot be withdrawn", self.user, "private", message["id"])
            else:
                await self.assert_refused(409, "already_seen", self.user, "private", message["id"])
        await self.assert_refused(404, "Message not found", self.user, "private", 99999)
        self.assertEqual([m["id"] for m in self.q.messages(self.user, "private")["messages"]], [m["id"] for m in done])

    async def test_runtime_conflict_or_unreachable_leaves_the_input_untouched(self):
        for status, error, expected in [(409, None, (409, "already_seen")), (404, None, (409, "already_seen")),
                                        (500, None, (502, "Runtime could not withdraw the message")),
                                        (200, httpx.ConnectError("down"), (502, "Runtime could not withdraw the message"))]:
            with self.subTest(status=status, error=type(error).__name__):
                parent, stream = await self.begin_run()
                child = await self.q.enqueue(self.user, "private", "maybe seen")
                self.remove_status, self.remove_error = status, error
                await self.assert_refused(*expected, self.user, "private", child["message"]["id"])
                self.remove_status, self.remove_error = 200, None
                self.assertEqual(self.job(child)["status"], "running")
                self.assertTrue(self.stored("private", child["message"]["id"]))
                await stream.send({"type": "input_delivered", "input_id": str(child["job_id"])})
                stream.finish()
                await self.drain()
                self.assertEqual(self.job(child)["status"], "succeeded")

    async def test_withdraw_racing_delivery_has_exactly_one_outcome(self):
        # Runtime delivers while the removal request is in flight: delivered wins.
        parent, stream = await self.begin_run()
        child = await self.q.enqueue(self.user, "private", "race me")
        self.remove_hold.clear()
        self.remove_started.clear()
        self.remove_status = 409
        attempt = asyncio.create_task(self.q.withdraw(self.user, "private", child["message"]["id"]))
        await asyncio.wait_for(self.remove_started.wait(), 2)
        await stream.send({"type": "input_delivered", "input_id": str(child["job_id"])})
        self.remove_hold.set()
        with self.assertRaises(HTTPException) as caught:
            await attempt
        self.assertEqual((caught.exception.status_code, caught.exception.detail), (409, "already_seen"))
        stream.finish()
        await self.drain()
        self.assertEqual(self.job(child)["status"], "succeeded")
        self.assertEqual([m["content"] for m in self.q.messages(self.user, "private")["messages"]], ["first", "race me", "answer"])
        self.assertNotIn("message_removed", [e["type"] for e in self.recorded_events()])
        # Runtime removes it first: withdrawn wins and no delivery event can follow.
        self.remove_status = 200
        parent, stream = await self.begin_run()
        child = await self.q.enqueue(self.user, "private", "race me again")
        self.remove_hold.clear()
        self.remove_started.clear()
        attempt = asyncio.create_task(self.q.withdraw(self.user, "private", child["message"]["id"]))
        await asyncio.wait_for(self.remove_started.wait(), 2)
        self.remove_hold.set()
        self.assertEqual((await attempt)["content"], "race me again")
        await stream.send({"type": "input_delivered", "input_id": str(child["job_id"])})
        stream.finish()
        await self.drain()
        self.assertEqual(self.job(child)["status"], "failed")
        self.assertEqual([m["content"] for m in self.q.messages(self.user, "private")["messages"]], ["first", "race me", "answer", "first", "answer"])

    async def test_withdraw_while_the_parent_finishes_is_withdrawn_as_a_requeued_message(self):
        parent, stream = await self.begin_run()
        child = await self.q.enqueue(self.user, "private", "undelivered at turn end")
        self.remove_hold.clear()
        self.remove_started.clear()
        attempt = asyncio.create_task(self.q.withdraw(self.user, "private", child["message"]["id"]))
        await asyncio.wait_for(self.remove_started.wait(), 2)
        stream.finish(undelivered_inputs=[str(child["job_id"])])
        for _ in range(200):
            if self.job(parent)["status"] == "succeeded":
                break
            await asyncio.sleep(0.01)
        self.assertEqual(self.job(child)["status"], "queued", "undelivered input returned to the FIFO")
        self.remove_hold.set()
        self.assertEqual((await attempt)["content"], "undelivered at turn end")
        await self.drain()
        self.assertEqual(self.job(child)["status"], "failed")
        self.assertEqual(len(self.requests), 1, "the withdrawn message never becomes its own turn")
        self.assertEqual([m["content"] for m in self.q.messages(self.user, "private")["messages"]], ["first", "answer"])

    async def test_withdraw_authorization_follows_sending_rules(self):
        self.real_files()
        author, other = self.q.user(1), self.q.user(2)
        parent, stream = await self.begin_run("channel-1", author)
        private_parent, private_stream = await self.begin_run("private", author)
        chat_parent, chat_stream = await self.begin_run("chat-c1", author)
        mine = await self.q.enqueue(author, "channel-1", "channel message", mode="after_turn")
        await self.assert_refused(403, "Only the author can withdraw this message", other, "channel-1", mine["message"]["id"])
        self.assertTrue(self.stored("channel-1", mine["message"]["id"]))
        private = await self.q.enqueue(author, "private", "mine", mode="after_turn")
        chat = await self.q.enqueue(author, "chat-c1", "mine too", mode="after_turn")
        # Other users reach neither a private scope nor a chat they do not own, and ids from other scopes are unknown.
        await self.assert_refused(404, "Message not found", other, "private", private["message"]["id"])
        await self.assert_refused(404, "Conversation not found", other, "chat-c1", chat["message"]["id"])
        await self.assert_refused(404, "Message not found", author, "private", mine["message"]["id"])
        with patch("enterprise_agent_platform.queue.permissions", return_value={"read_workspace", "private_agent"}):
            await self.assert_refused(403, "Permission denied", author, "channel-1", mine["message"]["id"])
            await self.assert_refused(403, "Permission denied", author, "chat-c1", chat["message"]["id"])
        for user, scope, sent in ((author, "private", private), (author, "chat-c1", chat), (author, "channel-1", mine)):
            self.assertEqual((await self.q.withdraw(user, scope, sent["message"]["id"]))["content"], sent["message"]["content"])
        for finished in (stream, private_stream, chat_stream):
            finished.finish()
        await self.drain()

    async def test_schedule_occurrences_cannot_be_withdrawn(self):
        parent, stream = await self.begin_run()
        run_id = self.schedule_occurrence()
        scheduled = await self.q.enqueue(self.user, "private", "scheduled", schedule_run_id=run_id)
        self.assertEqual(self.job(scheduled)["status"], "queued")
        await self.assert_refused(400, "Message cannot be withdrawn", self.user, "private", scheduled["message"]["id"])
        self.assertTrue(self.stored("private", scheduled["message"]["id"]))
        stream.finish()
        await self.drain()

    async def test_routes_send_mode_and_withdraw_over_http(self):
        self.real_files()
        from starlette.responses import JSONResponse

        async def error(request, exc):
            return JSONResponse({"error": exc.detail}, status_code=exc.status_code)

        app = Starlette(routes=routes(), exception_handlers={HTTPException: error})
        app.state.platform = self.p
        parent, stream = await self.begin_run()
        chat_parent, chat_stream = await self.begin_run("chat-c1")
        channel_parent, channel_stream = await self.begin_run("channel-1")
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://platform") as client:
            with patch("enterprise_agent_platform.queue.current_user", return_value=self.user):
                for base in ("/api/conversations/private", "/api/chat/conversations/c1"):
                    self.assertEqual((await client.post(base + "/messages", json={"content": "x", "mode": "later"})).status_code, 400)
                    sent = await client.post(base + "/messages", json={"content": "queued text", "mode": "after_turn"})
                    self.assertEqual(sent.status_code, 202)
                    message = sent.json()["message"]
                    self.assertEqual(message["metadata"]["send_mode"], "after_turn")
                    removed = await client.delete(f"{base}/messages/{message['id']}")
                    self.assertEqual((removed.status_code, removed.json()), (200, {"content": "queued text", "attachments": []}))
                    again = await client.delete(f"{base}/messages/{message['id']}")
                    self.assertEqual(again.status_code, 404)
                inserted = await client.post("/api/conversations/private/messages", json={"content": "inserted"})
                self.assertNotIn("send_mode", inserted.json()["message"]["metadata"])
                await stream.send({"type": "input_delivered", "input_id": str(inserted.json()["job_id"])})
                seen = await client.delete(f"/api/conversations/private/messages/{inserted.json()['message']['id']}")
                self.assertEqual((seen.status_code, seen.json()), (409, {"error": "already_seen"}))
                self.assertEqual((await client.delete("/api/conversations/private/messages/abc")).status_code, 404)
            with patch("enterprise_agent_platform.queue.current_user", return_value=self.q.user(2)):
                theirs = await client.post("/api/conversations/channel-1/messages", json={"content": "channel", "mode": "after_turn"})
                self.assertEqual(theirs.status_code, 202)
            with patch("enterprise_agent_platform.queue.current_user", return_value=self.user):
                forbidden = await client.delete(f"/api/conversations/channel-1/messages/{theirs.json()['message']['id']}")
                self.assertEqual((forbidden.status_code, forbidden.json()["error"]), (403, "Only the author can withdraw this message"))
        stream.finish()
        channel_stream.finish()
        chat_stream.finish()
        await self.drain()

    async def test_startup_recovery_settles_absorbed_inputs_without_replay(self):
        self.q.stopping = True
        parent = await self.q.enqueue(self.user, "private", "lost parent")
        with self.p.db.connect() as conn:
            conn.execute("UPDATE durable_jobs SET status='running' WHERE id=?", (parent["job_id"],))
            conn.execute("UPDATE messages SET metadata_json=json_set(metadata_json,'$.status','running') WHERE id=?",
                         (parent["message"]["id"],))
        children = [await self.q.enqueue(self.user, "private", text)
                    for text in ("not submitted", "uncertain submission", "already delivered")]
        with self.p.db.connect() as conn:
            for child, sent in zip(children, (False, True, True), strict=True):
                conn.execute("UPDATE durable_jobs SET payload_json=json_set(payload_json,'$.steer_sent',json(?)) WHERE id=?",
                             (json.dumps(sent), child["job_id"]))
            conn.execute("UPDATE messages SET metadata_json=json_set(metadata_json,'$.delivery','delivered') WHERE id=?",
                         (children[-1]["message"]["id"],))
        self.q = self.p.queue = Queue(self.p)
        await self.q.start()
        await self.drain()
        await self.q.start()
        await self.drain()
        self.assertEqual(self.requests, [])
        self.assertEqual(self.steers, [])
        self.assertEqual(self.calls, [("POST", "/v1/sessions/agent-private-1/cancel")])
        self.assertTrue(all(self.job(request)["status"] == "failed" for request in (parent, *children)))
        messages = self.q.messages(self.user, "private")["messages"]
        replies = [message for message in messages if message["role"] == "assistant"]
        self.assertEqual(len(replies), 1)
        self.assert_reply_to(replies[0], parent)
        for message in messages:
            self.assertEqual(message["metadata"]["status"], "interrupted")
            self.assertIn("Platform restarted", message["metadata"]["error"])
        self.assertEqual(self.q.active, 0)

    async def test_input_delivery_ignores_unknown_foreign_and_duplicate_ids(self):
        parent, stream = await self.begin_run()
        child = await self.q.enqueue(self.user, "private", "deliver once")
        other_parent, other_stream = await self.begin_run(user=self.q.user(2))
        other_child = await self.q.enqueue(self.q.user(2), "private", "belongs to another run")
        await stream.send(
            {"type": "input_delivered", "input_id": "unknown-runtime-input"},
            {"type": "input_delivered", "input_id": str(parent["job_id"])},
            {"type": "input_delivered", "input_id": str(other_child["job_id"])},
            {"type": "input_delivered", "input_id": str(child["job_id"])},
            {"type": "input_delivered", "input_id": str(child["job_id"])})
        other_message = self.q.message(self.q.scope(self.q.user(2), "private"), other_child["message"]["id"])
        self.assertEqual(other_message["metadata"]["delivery"], "pending")
        await other_stream.send({"type": "input_delivered", "input_id": str(other_child["job_id"])})
        stream.finish()
        other_stream.finish()
        await self.drain()
        events = self.recorded_events()
        self.assertEqual([event for event in events if event["type"] == "input_delivered"],
                         [{"type": "input_delivered", "message_id": child["message"]["id"]}])
        self.assertNotIn("unknown-runtime-input", json.dumps(events))
        reply = self.q.messages(self.user, "private")["messages"][-1]
        self.assertEqual(len(reply["metadata"]["work"]["items"]), 1)
        self.assert_reply_to(reply, parent)
        self.assert_reply_to(self.q.messages(self.q.user(2), "private")["messages"][-1], other_parent)

    async def test_parent_finish_while_steer_is_in_flight_cannot_strand_or_revive_child(self):
        for response_status, run_status in [(200, "completed"), (404, "failed"), (409, "cancelled")]:
            with self.subTest(response_status=response_status, run_status=run_status):
                parent, stream = await self.begin_run()
                parent_finished = asyncio.Event()
                original_finish = self.q.finish

                async def finish(job, *args, **kwargs):
                    await original_finish(job, *args, **kwargs)
                    if job["id"] == parent["job_id"]:
                        parent_finished.set()

                self.steer_status = response_status
                self.steer_started.clear()
                self.steer_hold.clear()
                with patch.object(self.q, "finish", side_effect=finish):
                    accepted = asyncio.create_task(self.q.enqueue(self.user, "private", "racing input"))
                    try:
                        await asyncio.wait_for(self.steer_started.wait(), 2)
                        child_id = int(self.steers[-1][1]["input_id"])
                        stream.finish(status=run_status, undelivered_inputs=[str(child_id)])
                        await asyncio.wait_for(parent_finished.wait(), 2)
                        self.assertEqual(self.job(child_id)["status"], "queued" if run_status == "completed" else "failed")
                        self.steer_hold.set()
                        child = await asyncio.wait_for(accepted, 2)
                        await self.drain()
                    finally:
                        self.steer_hold.set()
                        if not accepted.done():
                            accepted.cancel()
                        await asyncio.gather(accepted, return_exceptions=True)
                self.assertEqual(self.job(child)["status"], "succeeded" if run_status == "completed" else "failed")
                replies = [message for message in self.q.messages(self.user, "private")["messages"] if message["role"] == "assistant"]
                child_replies = [message for message in replies
                                 if message["metadata"]["reply_to"]["message_id"] == child["message"]["id"]]
                self.assertEqual(len(child_replies), 1 if run_status == "completed" else 0)
                self.assertEqual(self.q.active, 0)

    async def test_absorb_rechecks_parent_after_stale_running_selection(self):
        self.q.stopping = True
        parent = await self.q.enqueue(self.user, "private", "parent")
        child = await self.q.enqueue(self.user, "private", "arrives while parent finishes")
        with self.p.db.connect() as conn:
            conn.execute("UPDATE durable_jobs SET status='running' WHERE id=?", (parent["job_id"],))
            stale = conn.execute("SELECT id,payload_json FROM durable_jobs WHERE id=?", (parent["job_id"],)).fetchone()
        info = self.q.scope(self.user, "private")
        job = self.job(parent)
        await self.q.finish(job, job["payload"], self.user, info,
                            {"type": "run_end", "status": "completed", "text": "settled", "usage": {}})

        class StaleSelection:
            def __init__(self, connection):
                self.connection = connection

            def execute(self, sql, parameters=()):
                if sql.startswith("SELECT id,payload_json") and "status='running'" in sql:
                    return SimpleNamespace(fetchone=lambda: stale)
                return self.connection.execute(sql, parameters)

        payload = self.job(child)["payload"]
        with self.p.db.connect() as conn:
            self.assertFalse(self.q.absorb(StaleSelection(conn), child["job_id"], payload, info))
        self.assertNotIn("parent_job_id", payload)
        self.assertEqual(self.job(child)["status"], "queued")
        self.assertNotIn("inserted_into", self.q.message(info, child["message"]["id"])["metadata"])
        self.q.stopping = False
        self.q.resume()
        await self.drain()
        self.assertEqual([request["prompt"]["text"] for request in self.requests], ["arrives while parent finishes"])
        self.assert_reply_to(self.q.messages(self.user, "private")["messages"][-1], child)

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

    async def test_worker_stop_interrupts_inserted_inputs_without_replay_on_restart(self):
        parent, stream = await self.begin_run()
        children = [await self.q.enqueue(self.user, "private", text) for text in ("delivered", "pending")]
        await stream.send({"type": "input_delivered", "input_id": str(children[0]["job_id"])})
        await self.q.stop()
        self.q = self.p.queue = Queue(self.p)
        await self.q.start()
        await self.drain()
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(len(self.steers), 2)
        self.assertTrue(all(self.job(request)["status"] == "failed" for request in (parent, *children)))
        messages = self.q.messages(self.user, "private")["messages"]
        replies = [message for message in messages if message["role"] == "assistant"]
        self.assertEqual(len(replies), 1)
        self.assert_reply_to(replies[0], parent)
        self.assertTrue(all(message["metadata"]["status"] == "interrupted" for message in messages))
        self.assertEqual(self.q.active, 0)

    async def test_chat_interruption_and_queued_cancellation_keep_reply_to(self):
        with self.p.db.connect() as conn:
            conn.execute("INSERT INTO chat_conversations VALUES ('interrupted',1,'Interrupted',?,?,NULL)", (now(), now()))
        self.loss = True
        interrupted = await self.q.enqueue(self.user, "chat-interrupted", "uncertain chat")
        await self.drain()
        self.q.stopping = True
        cancelled = await self.q.enqueue(self.user, "chat-interrupted", "cancel queued chat")
        await self.q.cancel(self.user, "chat-interrupted")
        replies = [message for message in self.q.messages(self.user, "chat-interrupted")["messages"]
                   if message["role"] == "assistant"]
        self.assertEqual([message["metadata"]["status"] for message in replies], ["interrupted", "cancelled"])
        for reply, request in zip(replies, (interrupted, cancelled), strict=True):
            self.assert_reply_to(reply, request)

    def test_work_thinking_blocks_keep_separate_start_and_end_times(self):
        instant = datetime(2026, 10, 4, tzinfo=timezone.utc)
        moments = [instant + timedelta(seconds=second) for second in (0, 1, 9, 10, 13, 14)]
        with patch("enterprise_agent_platform.queue.datetime") as clock:
            clock.now.side_effect = moments
            trace = _WorkTrace()
            trace.add({"type": "thinking_start"})
            self.assertEqual(trace.data["items"], [{
                "type": "thinking", "text": "", "started_at": moments[1].isoformat(timespec="microseconds"),
                "ended_at": None,
            }])
            trace.add({"type": "thinking_delta", "delta": "**Inspecting**\n\n"})
            trace.add({"type": "thinking_delta", "delta": "First summary."})
            trace.add({"type": "thinking_end"})
            trace.add({"type": "thinking_start"})
            trace.add({"type": "thinking_delta", "delta": "Second summary."})
            trace.add({"type": "thinking_end"})
            work = trace.finish()
        self.assertEqual(work["items"], [
            {"type": "thinking", "text": "**Inspecting**\n\nFirst summary.",
             "started_at": moments[1].isoformat(timespec="microseconds"),
             "ended_at": moments[2].isoformat(timespec="microseconds")},
            {"type": "thinking", "text": "Second summary.",
             "started_at": moments[3].isoformat(timespec="microseconds"),
             "ended_at": moments[4].isoformat(timespec="microseconds")},
        ])
        self.assertFalse(work["truncated"])

    def test_work_empty_thinking_block_retains_start_and_end_times(self):
        instant = datetime(2026, 10, 4, tzinfo=timezone.utc)
        moments = [instant + timedelta(seconds=second) for second in (0, 2, 5, 6)]
        with patch("enterprise_agent_platform.queue.datetime") as clock:
            clock.now.side_effect = moments
            trace = _WorkTrace()
            trace.add({"type": "thinking_start"})
            trace.add({"type": "thinking_end"})
            work = trace.finish()
        self.assertEqual(work["items"], [{
            "type": "thinking", "text": "", "started_at": moments[1].isoformat(timespec="microseconds"),
            "ended_at": moments[2].isoformat(timespec="microseconds"),
        }])
        self.assertFalse(work["truncated"])

    def test_work_thinking_delta_fallback_merges_without_open_blocks(self):
        trace = _WorkTrace()
        for event in [
            {"type": "thinking_delta", "delta": "Legacy "},
            {"type": "thinking_delta", "delta": ""},
            {"type": "thinking_delta", "delta": "summary."},
            {"type": "tool_start", "tool_call_id": "read", "name": "read", "args": {}},
            {"type": "tool_end", "tool_call_id": "read", "is_error": False, "content_preview": []},
            {"type": "thinking_delta", "delta": "Another "},
            {"type": "thinking_delta", "delta": "summary."},
            {"type": "thinking_start"},
            {"type": "thinking_delta", "delta": "Explicit block."},
            {"type": "thinking_end"},
            {"type": "thinking_delta", "delta": "Later "},
            {"type": "thinking_delta", "delta": "summary."},
        ]:
            trace.add(event)
        items = trace.finish()["items"]
        self.assertEqual([item["type"] for item in items], ["thinking", "tool", "thinking", "thinking", "thinking"])
        for index, text in ((0, "Legacy summary."), (2, "Another summary."), (4, "Later summary.")):
            self.assertEqual(items[index], {"type": "thinking", "text": text})
        self.assertEqual(items[3]["text"], "Explicit block.")
        self.assertIsNotNone(items[3]["ended_at"])

    def test_work_thinking_blocks_clip_at_16000_characters(self):
        for character in ("x", "漢", "😀"):
            with self.subTest(character=character):
                trace = _WorkTrace()
                trace.add({"type": "thinking_start"})
                trace.add({"type": "thinking_delta", "delta": "x" * 15998 + character})
                trace.add({"type": "thinking_delta", "delta": character})
                self.assertFalse(trace.data["truncated"])
                trace.add({"type": "thinking_delta", "delta": "discarded suffix"})
                trace.add({"type": "thinking_end"})
                work = trace.finish()
                self.assertEqual(work["items"][0]["text"], "x" * 15998 + character * 2)
                self.assertIsNotNone(work["items"][0]["ended_at"])
                self.assertTrue(work["truncated"])

    def test_work_trace_bound_reserves_thinking_end_times_with_input_eviction(self):
        limit = 96 * 1024
        instant = datetime(2026, 10, 4, tzinfo=timezone.utc)
        marker = {"type": "input", "message_id": 42, "at": instant.isoformat(timespec="microseconds")}
        victim_length = len(json.dumps(marker)) - len(json.dumps({"type": "thinking", "text": ""})) - 25
        for insert_input in (False, True):
            for character in ("x", "漢", "😀"):
                with self.subTest(insert_input=insert_input, character=character):
                    with patch("enterprise_agent_platform.queue.datetime") as clock:
                        clock.now.return_value = instant
                        trace = _WorkTrace()
                        trace.add({"type": "thinking_delta", "delta": "v" * victim_length})
                        for index in range(22):
                            trace.add({"type": "text_delta", "delta": "p" * 4000})
                            trace.add({"type": "tool_start", "tool_call_id": str(index), "name": "read", "args": {}})
                            trace.add({"type": "tool_end", "tool_call_id": str(index),
                                       "is_error": False, "content_preview": []})
                        trace.add({"type": "thinking_start"})
                        room = limit - len(json.dumps(trace.data).encode("utf-8")) - 40
                        width = len(json.dumps(character).encode("utf-8")) - 2
                        summary = character * (room // width) + "x" * (room % width)
                        self.assertGreater(len(summary), 0)
                        self.assertLess(len(summary), 16000)
                        trace.add({"type": "thinking_delta", "delta": summary})
                        self.assertEqual(len(json.dumps(trace.data).encode("utf-8")), limit - 40)
                        trace.add({"type": "thinking_delta", "delta": "x" * 40})
                        self.assertEqual(trace.data["items"][-1]["text"], summary)
                        self.assertTrue(trace.data["truncated"])
                        # Setting truncated changes false to true, freeing one byte.
                        trace.add({"type": "thinking_delta", "delta": "x"})
                        self.assertEqual(len(json.dumps(trace.data).encode("utf-8")), limit - 40)
                        if insert_input:
                            trace.add({"type": "input_delivered", "message_id": 42})
                            self.assertEqual(trace.data["items"][-1], marker)
                            self.assertEqual(trace.data["items"][0]["type"], "tool")
                        trace.add({"type": "thinking_end"})
                        work = trace.finish()
                    block = next(item for item in work["items"]
                                 if item["type"] == "thinking" and "started_at" in item)
                    self.assertEqual(block["text"], summary + "x")
                    self.assertEqual(block["started_at"], marker["at"])
                    self.assertEqual(block["ended_at"], marker["at"])
                    self.assertLessEqual(len(json.dumps(work).encode("utf-8")), limit)

    def test_work_rejected_thinking_start_cannot_merge_into_prior_block(self):
        trace = _WorkTrace()
        for index in range(199):
            trace.add({"type": "tool_start", "tool_call_id": str(index), "name": "read", "args": {}})
        trace.add({"type": "thinking_delta", "delta": "Retained legacy summary."})
        trace.add({"type": "thinking_start"})
        trace.add({"type": "thinking_delta", "delta": "Discarded new block."})
        trace.add({"type": "thinking_end"})
        work = trace.finish()
        self.assertEqual(len(work["items"]), 200)
        self.assertEqual(work["items"][-1], {"type": "thinking", "text": "Retained legacy summary."})
        self.assertTrue(work["truncated"])

    def test_work_evicted_thinking_block_cannot_overwrite_later_items(self):
        trace = _WorkTrace()
        trace.add({"type": "thinking_start"})
        trace.add({"type": "thinking_delta", "delta": "Evicted summary."})
        for index in range(199):
            trace.add({"type": "tool_start", "tool_call_id": str(index), "name": "read", "args": {}})
        trace.add({"type": "input_delivered", "message_id": 42})
        trace.add({"type": "thinking_delta", "delta": "Discarded continuation."})
        trace.add({"type": "thinking_end"})
        trace.add({"type": "tool_end", "tool_call_id": "198", "is_error": False,
                   "content_preview": [{"type": "text", "text": "Finished"}]})
        work = trace.finish()
        self.assertEqual(len(work["items"]), 200)
        self.assertEqual([item["type"] for item in work["items"]], ["tool"] * 199 + ["input"])
        self.assertEqual(work["items"][-1]["message_id"], 42)
        self.assertEqual(work["items"][-2]["status"], "done")
        self.assertEqual(work["items"][-2]["output"], "Finished")
        self.assertIsNotNone(work["items"][-2]["ended_at"])
        self.assertTrue(work["truncated"])

    def test_work_input_boundary_preserves_prior_text_and_removes_final_answer(self):
        trace = _WorkTrace()
        trace.add({"type": "text_delta", "delta": "Earlier answer"})
        trace.add({"type": "input_delivered", "message_id": 42})
        trace.add({"type": "text_delta", "delta": "Final answer"})
        work = trace.finish()
        self.assertFalse(work["truncated"])
        self.assertEqual(work["items"][0], {"type": "text", "text": "Earlier answer"})
        self.assertEqual(len(work["items"]), 2)
        marker = work["items"][1]
        self.assertEqual(set(marker), {"type", "message_id", "at"})
        self.assertEqual((marker["type"], marker["message_id"]), ("input", 42))
        self.assertLessEqual(work["started_at"], marker["at"])
        self.assertLessEqual(marker["at"], work["ended_at"])

    def test_work_input_markers_survive_item_limit_and_later_tool_updates(self):
        trace = _WorkTrace()
        trace.add({"type": "input_delivered", "message_id": 11})
        for index in range(200):
            trace.add({"type": "tool_start", "tool_call_id": str(index), "name": "read", "args": {}})
        self.assertEqual(len(trace.data["items"]), 200)
        trace.add({"type": "input_delivered", "message_id": 12})
        self.assertEqual(len(trace.data["items"]), 200)
        for ident in ("0", "198"):
            trace.add({"type": "tool_end", "tool_call_id": ident, "is_error": False,
                       "content_preview": [{"type": "text", "text": "finished"}]})
        work = trace.finish()
        self.assertTrue(work["truncated"])
        self.assertEqual([item["message_id"] for item in work["items"] if item["type"] == "input"], [11, 12])
        tools = [item for item in work["items"] if item["type"] == "tool"]
        self.assertEqual([item["id"] for item in tools], [str(index) for index in range(1, 199)])
        self.assertEqual((tools[-1]["status"], tools[-1]["output"]), ("done", "finished"))
        self.assertLessEqual(len(json.dumps(work).encode("utf-8")), 96 * 1024)

    def test_work_input_markers_evict_non_input_items_at_json_byte_limit(self):
        limit = 96 * 1024
        for character in ("x", "漢", "😀"):
            with self.subTest(character=character):
                trace = _WorkTrace()
                trace.add({"type": "input_delivered", "message_id": 11})
                width = len(json.dumps(character).encode("utf-8")) - 2
                index = 0
                while True:
                    item_type = "thinking" if index % 2 == 0 else "text"
                    overhead = len(json.dumps({"type": item_type, "text": ""}).encode("utf-8")) + 2
                    room = limit - len(json.dumps(trace.data).encode("utf-8")) - overhead - 8
                    count = min(4000, room // width)
                    if count <= 0:
                        break
                    trace.add({"type": item_type + "_delta", "delta": character * count})
                    index += 1
                self.assertGreater(len(json.dumps(trace.data).encode("utf-8")), limit - 128)
                before = len(trace.data["items"])
                trace.add({"type": "input_delivered", "message_id": 12})
                self.assertLessEqual(len(trace.data["items"]), before)
                self.assertLessEqual(len(json.dumps(trace.data).encode("utf-8")), limit)
                work = trace.finish()
                self.assertTrue(work["truncated"])
                self.assertEqual([item["message_id"] for item in work["items"] if item["type"] == "input"], [11, 12])
                self.assertLessEqual(len(work["items"]), 200)
                self.assertLessEqual(len(json.dumps(work).encode("utf-8")), limit)

    def test_work_retains_all_input_markers_when_markers_alone_exceed_item_limit(self):
        trace = _WorkTrace()
        for message_id in range(205):
            trace.add({"type": "input_delivered", "message_id": message_id})
        trace.add({"type": "thinking_delta", "delta": "No room for more work"})
        work = trace.finish()
        self.assertTrue(work["truncated"])
        self.assertEqual(len(work["items"]), 205)
        self.assertEqual([item["message_id"] for item in work["items"]], list(range(205)))
        self.assertTrue(all(item["type"] == "input" for item in work["items"]))

    def test_work_exact_field_bounds_do_not_truncate(self):
        trace = _WorkTrace()
        args = {"command": "x" * (2000 - len(json.dumps({"command": ""})))}
        for event in [
            {"type": "thinking_delta", "delta": "t" * 16000},
            {"type": "text_delta", "delta": "p" * 4000},
            {"type": "tool_start", "tool_call_id": "exact", "name": "bash", "args": args},
            {"type": "tool_end", "tool_call_id": "exact", "is_error": False,
             "content_preview": [{"type": "text", "text": "o" * 2000}]},
        ]:
            trace.add(event)
        work = trace.finish()
        self.assertFalse(work["truncated"])
        self.assertEqual(work["items"][0]["text"], "t" * 16000)
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

    async def test_work_thinking_blocks_interleave_with_tools_and_inputs_and_relay_over_sse(self):
        parent, stream = await self.begin_run()
        child = await self.q.enqueue(self.user, "private", "Check the totals too")
        events = [
            {"type": "thinking_start"},
            {"type": "thinking_delta", "delta": "Before tool. "},
            {"type": "tool_start", "tool_call_id": "read", "name": "read", "args": {}},
            {"type": "thinking_delta", "delta": "After tool start. "},
            {"type": "input_delivered", "input_id": str(child["job_id"])},
            {"type": "thinking_delta", "delta": "After input."},
            {"type": "tool_end", "tool_call_id": "read", "is_error": False,
             "content_preview": [{"type": "text", "text": "Read complete."}]},
            {"type": "thinking_end"},
            {"type": "thinking_start"},
            {"type": "thinking_end"},
            {"type": "thinking_start"},
            {"type": "thinking_delta", "delta": "Final summary."},
            {"type": "thinking_end"},
            {"type": "text_delta", "delta": "Final answer"},
        ]
        await stream.send(*events)
        stream.finish(text="Final answer")
        await self.drain()
        message = self.q.messages(self.user, "private")["messages"][-1]
        self.assert_reply_to(message, parent)
        self.assertEqual(message["content"], "Final answer")
        work = message["metadata"]["work"]
        items = work["items"]
        self.assertEqual([item["type"] for item in items], ["thinking", "tool", "input", "thinking", "thinking"])
        self.assertEqual([item["text"] for item in items if item["type"] == "thinking"],
                         ["Before tool. After tool start. After input.", "", "Final summary."])
        self.assertEqual((items[1]["status"], items[1]["output"]), ("done", "Read complete."))
        self.assertEqual(items[2]["message_id"], child["message"]["id"])
        for item in items:
            if item["type"] in ("thinking", "tool"):
                self.assertLessEqual(work["started_at"], item["started_at"])
                self.assertLessEqual(item["started_at"], item["ended_at"])
                self.assertLessEqual(item["ended_at"], work["ended_at"])
        self.assertFalse(work["truncated"])
        public = self.q.events(self.user, "private", 0)
        relayed = []
        try:
            async with asyncio.timeout(2):
                async for frame in public:
                    event = json.loads(frame.split(b"data: ", 1)[1])
                    event.pop("seq")
                    if event["type"] == "run_end":
                        self.assertEqual(event["message"], message)
                        break
                    if event["type"] != "message":
                        relayed.append(event)
        finally:
            await public.aclose()
        self.assertEqual(relayed, [
            {"type": "input_delivered", "message_id": child["message"]["id"]}
            if event["type"] == "input_delivered" else event for event in events
        ])

    async def test_work_unfinished_thinking_blocks_survive_run_outcomes(self):
        for runtime_status, message_status in [
            ("completed", "completed"), ("failed", "interrupted"), ("cancelled", "cancelled"),
            (None, "interrupted"),
        ]:
            with self.subTest(status=runtime_status):
                message = await self.run_work([
                    {"type": "thinking_start"},
                    {"type": "thinking_delta", "delta": "Partial summary."},
                ], runtime_status)
                self.assertEqual(message["metadata"]["status"], message_status)
                work = message["metadata"]["work"]
                self.assertEqual(len(work["items"]), 1)
                block = work["items"][0]
                self.assertEqual((block["type"], block["text"]), ("thinking", "Partial summary."))
                self.assertLessEqual(work["started_at"], block["started_at"])
                self.assertLessEqual(block["started_at"], work["ended_at"])
                self.assertIsNone(block["ended_at"])

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
                {"type": "thinking_delta", "delta": "t" * 15999},
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
        self.assertEqual(work["items"][0]["text"], "t" * 15999 + "a")
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
        parent = await self.q.enqueue(self.user, "private", "active")
        await asyncio.wait_for(self.run_started.wait(), 2)
        child = await self.q.enqueue(self.user, "private", "inserted before run creation")
        self.assertEqual(self.job(child)["payload"]["parent_job_id"], parent["job_id"])
        await self.q.cancel(self.user, "private")
        self.hold.set()
        await self.drain()
        self.assertEqual(len(self.requests), 1)
        self.assertIn(("POST", "/v1/runs/r1/cancel"), self.calls)
        messages = self.q.messages(self.user, "private")["messages"]
        self.assertTrue(all(message["metadata"]["status"] == "cancelled" for message in messages))
        self.assertEqual(self.steers, [])
        replies = [message for message in messages if message["role"] == "assistant"]
        self.assertEqual(len(replies), 1)
        self.assert_reply_to(replies[0], parent)
        self.assertEqual(self.job(child)["status"], "failed")
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

    async def test_empty_policy_model_executes_with_the_first_catalog_model(self):
        with self.p.db.connect() as conn:
            set_default_policy(conn, model="", thinking="off")
        self.p.oauth = SimpleNamespace(catalog=AsyncMock(return_value={"models": [{"id": "catalog-default"}, {"id": "second"}]}))
        await self.q.enqueue(self.q.user(1), "private", "Use inherited settings")
        await self.drain()
        self.assertEqual(self.requests[0]["model"], {"id": "catalog-default", "thinking": "off"})

    async def test_request_users_without_policy_fields_run_with_their_policy_group(self):
        # HTTP handlers receive the public projection, which never carries the model policy.
        with self.p.db.connect() as conn:
            set_default_policy(conn, model="model-b", thinking="high")
        caller = public_user(self.q.user(1))
        self.assertNotIn("model_policy", caller)
        await self.q.enqueue(caller, "private", "From the browser")
        await self.drain()
        self.assertEqual(self.requests[0]["model"], {"id": "model-b", "thinking": "high"})

    async def test_each_usage_runs_with_its_policy_slot(self):
        cid = "11111111-1111-1111-1111-111111111111"
        with self.p.db.connect() as conn:
            conn.execute("INSERT INTO chat_conversations VALUES (?,?, 'Slots',?,?,NULL)", (cid, 1, now(), now()))
            conn.execute("INSERT INTO channels(id,name,created_at) VALUES (1,'General',1)")
            set_default_policy(
                conn, personal={"model": "m-personal", "thinking": "low"}, channel={"model": "m-channel", "thinking": "high"},
                chat={"model": "m-chat", "thinking": "minimal"}, scout={"model": "m-scout", "thinking": "off"},
                worker={"model": "m-worker", "thinking": "xhigh"})
        chat = "chat-" + cid
        await self.q.enqueue(self.q.user(1), "private", "personal")
        await self.drain()
        await self.q.enqueue(self.q.user(1), "private", "scheduled", schedule_run_id=self.schedule_occurrence())
        await self.drain()
        await self.q.enqueue(self.q.user(1), "channel-1", "channel")
        await self.drain()
        await self.q.enqueue(self.q.user(1), chat, "chat")
        await self.drain()
        self.assertEqual([request["model"] for request in self.requests], [
            {"id": "m-personal", "thinking": "low"}, {"id": "m-personal", "thinking": "low"},
            {"id": "m-channel", "thinking": "high"}, {"id": "m-chat", "thinking": "minimal"}])
        for scope in (chat, "private", "channel-1"):
            await self.q.compact(self.q.user(1), scope)
            await self.drain()
        self.assertEqual([entry["model"] for entry in self.compactions], [
            {"id": "m-chat", "thinking": "minimal"}, {"id": "m-personal", "thinking": "low"}, {"id": "m-channel", "thinking": "high"}])
        user = self.q.user(1)
        for usage, expected in (("scout", {"id": "m-scout", "thinking": "off"}), ("worker", {"id": "m-worker", "thinking": "xhigh"})):
            self.assertEqual(self.q.scope(user, "private", slot=usage)["model"], expected)

    async def test_channel_agent_uses_the_triggering_users_policy_group(self):
        with self.p.db.connect() as conn:
            conn.execute("INSERT INTO channels(id,name,created_at) VALUES (1,'General',1)")
            group = {slot: {"model": "m-light", "thinking": "off"} for slot in ("personal", "channel", "chat", "scout", "worker")}
            conn.execute("UPDATE settings SET value=json_insert(value,'$[#]',json(?)) WHERE key='model_policies_v1'",
                         (json.dumps({"name": "light", "label": "Light", "slots": group}),))
            conn.execute("UPDATE users SET model_policy='light' WHERE id=2")
        await self.q.enqueue(self.q.user(2), "channel-1", "from user two")
        await self.drain()
        await self.q.enqueue(self.q.user(1), "channel-1", "from user one")
        await self.drain()
        self.assertEqual([request["model"]["id"] for request in self.requests], ["m-light", "model-a"])


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
        before = await self.q.enqueue(self.user, "private", "before")
        await asyncio.wait_for(self.run_started.wait(), 2)
        self.compact_hold.clear()
        accepted = await self.q.compact(self.user, "private")
        self.assertEqual(accepted["status"], "queued")
        self.assertEqual(self.q.messages(self.user, "private")["compaction"]["status"], "queued")
        self.hold.set()
        await asyncio.wait_for(self.compact_started.wait(), 2)
        after = [await self.q.enqueue(self.user, "private", text) for text in ("after one", "after two")]
        for child in after:
            self.assertEqual(self.job(child)["status"], "queued")
            self.assertNotIn("parent_job_id", self.job(child)["payload"])
            self.assertNotIn("inserted_into", child["message"]["metadata"])
        self.assertEqual(self.steers, [])
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
        replies = [message for message in page["messages"] if message["role"] == "assistant"]
        for reply, request in zip(replies, (before, *after), strict=True):
            self.assert_reply_to(reply, request)
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
