import asyncio
import json
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import httpx
from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse

from enterprise_agent_platform.gates import (
    Gate, ManagerClientError, ManagerResponseUncertainError, manager_request, routes,
)


class GateTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.token = self.root / "token"
        self.token.write_text("first-token")
        self.conn = sqlite3.connect(":memory:")
        self.addCleanup(self.conn.close)
        self.conn.execute("CREATE TABLE durable_jobs(kind TEXT, status TEXT)")
        self.platform = SimpleNamespace(
            settings=SimpleNamespace(data_dir=self.root, manager_token_file=self.token,
                                     manager_socket=str(self.root / "manager.sock")),
            queue=SimpleNamespace(active=0, resume=lambda: None),
            db=SimpleNamespace(connect=lambda: self.conn, schema_version=lambda: 17,
                               migrate=lambda root: (root / "published").write_text("migrated")),
        )
        self.gate = self.platform.gate = Gate(self.platform)
        async def error(request, exc):
            return JSONResponse({"error": exc.detail}, status_code=exc.status_code)
        self.app = Starlette(routes=routes(), exception_handlers={HTTPException: error})
        self.app.state.platform = self.platform
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test",
                                        headers={"Authorization": "Bearer first-token"})
        self.addAsyncCleanup(self.client.aclose)

    def idle(self, reserved=False):
        return dict(reserved=reserved, active_agent_tasks=0,
                    queued_agent_jobs=0, running_agent_jobs=0, admissions_in_progress=0, blocker_error="")

    async def test_exact_json_and_owner_replays(self):
        reply = await self.client.post("/internal/manager/update/readiness", json={"operation_id": "one"})
        self.assertEqual(reply.json(), self.idle(True))
        self.assertEqual(await self.gate.readiness("one"), self.idle(True))
        other = await self.gate.readiness("two")
        self.assertEqual(other, {**self.idle(), "blocker_error": "another update already owns the platform"})
        health = await self.client.get("/internal/manager/health")
        self.assertEqual(health.json(), {"status": "ok", "schema_version": 17, "update_reserved": True, **self.idle()})
        for commit in (False, True):
            with self.assertRaises(HTTPException) as raised:
                await self.gate.release("two", commit=commit)
            self.assertEqual(raised.exception.status_code, 409)
        with self.assertRaises(HTTPException) as raised:
            async with self.gate.admit():
                self.fail("reserved gate admitted work")
        self.assertEqual(raised.exception.status_code, 503)

    async def test_admission_lifetime_cancellation_and_contention(self):
        entered = asyncio.Event()
        async def work():
            async with self.gate.admit():
                entered.set()
                await asyncio.Future()
        task = asyncio.create_task(work())
        await entered.wait()
        self.assertEqual(await self.gate.readiness("one"), {**self.idle(), "admissions_in_progress": 1})
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        results = await asyncio.gather(*(self.gate.readiness(str(i)) for i in range(20)))
        self.assertEqual(sum(r["reserved"] for r in results), 1)
        self.assertEqual(self.gate.admissions, 0)

    async def test_durable_and_active_blockers_shutdown(self):
        for state in ("queued", "running"):
            self.conn.execute("INSERT INTO durable_jobs VALUES ('agent', ?)", (state,))
            self.assertEqual(await self.gate.readiness("one"), {**self.idle(), f"{state}_agent_jobs": 1})
            self.conn.execute("DELETE FROM durable_jobs")
        self.platform.queue.active = 2
        self.assertEqual(await self.gate.readiness("one"), {**self.idle(), "active_agent_tasks": 2})
        self.platform.queue.active = 0
        self.gate.closing = True
        self.assertEqual(await self.gate.readiness("one"), {**self.idle(), "blocker_error": "service is shutting down"})

    async def test_commit_publishes_before_release_failed_commit_held_abort_does_not_publish(self):
        self.assertEqual(await self.gate.release("never-reserved", commit=False), {"released": True})
        await self.gate.readiness("one")
        await self.gate.release("one", commit=False)
        self.assertFalse((self.root / "published").exists())
        await self.gate.readiness("two")
        original = self.platform.db.migrate
        def failed(root):
            self.assertEqual(self.gate.reserved, "two")
            self.assertTrue(self.gate.lock.locked())
            raise OSError("publication failed")
        self.platform.db.migrate = failed
        with self.assertRaisesRegex(OSError, "publication failed"):
            await self.gate.release("two", commit=True)
        self.assertEqual(self.gate.reserved, "two")
        self.platform.db.migrate = original
        self.assertEqual(await self.gate.release("two", commit=True), {"released": True})
        self.assertEqual((self.root / "published").read_text(), "migrated")
        self.platform.db.migrate = failed
        self.assertEqual(await self.gate.release("two", commit=True), {"released": True})
        await self.gate.readiness("three")
        with self.assertRaises(HTTPException):
            await self.gate.release("two", commit=True)
        await self.gate.release("three", commit=False)
        with self.assertRaises(HTTPException):
            await self.gate.release("two", commit=True)

    async def test_http_auth_rotation_and_strict_json(self):
        self.token.write_text("second-token")
        self.assertEqual((await self.client.get("/internal/manager/health")).status_code, 401)
        self.client.headers["Authorization"] = "Bearer second-token"
        self.assertEqual((await self.client.get("/internal/manager/health")).status_code, 200)
        for raw in ('{}', '[]', '{"operation_id":3}', '{"operation_id":" "}',
                    '{"operation_id":"x","operation_id":"x"}',
                    '{"operation_id":"x","extra":true}', '{"operation_id":"x"} true'):
            response = await self.client.post("/internal/manager/update/readiness", content=raw)
            self.assertEqual(response.status_code, 400, raw)
            self.assertEqual(response.json(), {"error": "invalid manager request"})
        self.token.unlink()
        self.assertEqual((await self.client.get("/internal/manager/health")).status_code, 401)

    async def start_manager(self, responses):
        self.requests = []
        async def handle(reader, writer):
            headers = await reader.readuntil(b"\r\n\r\n")
            self.requests.append(headers)
            for line in headers.split(b"\r\n"):
                if line.lower().startswith(b"content-length:"):
                    await reader.readexactly(int(line.split(b":", 1)[1]))
            response = responses.pop(0)
            writer.write(response)
            await writer.drain()
            writer.close()
            await writer.wait_closed()
        server = await asyncio.start_unix_server(handle, path=self.platform.settings.manager_socket)
        self.addCleanup(server.close)
        self.addAsyncCleanup(server.wait_closed)
        return server

    @staticmethod
    def response(body, code=200, length=None):
        return f"HTTP/1.1 {code} Test\r\nContent-Length: {len(body) if length is None else length}\r\nConnection: close\r\n\r\n".encode() + body

    async def test_real_uds_fresh_token_and_no_replay_uncertain_responses(self):
        responses = [self.response(b'{"generation":4}'), self.response(b'{"ok":true}')]
        for body in (b'', b'[]', b'{broken', b'{"a":1,"a":2}'):
            responses.append(self.response(body))
        responses.extend([self.response(b'{', length=50), self.response(b'x' * 65),
                          self.response(b'{"error":"conflict"}', 409)])
        server = await self.start_manager(responses)
        self.assertEqual(await manager_request(self.platform, "GET", "/v1/status"), {"generation": 4})
        self.token.write_text("rotated")
        self.assertEqual(await manager_request(self.platform, "PATCH", "/v1/config", {"update_enabled": False}), {"ok": True})
        self.assertIn(b"Bearer rotated", self.requests[1])
        for _ in range(5):
            with self.assertRaises(ManagerResponseUncertainError):
                await manager_request(self.platform, "POST", "/v1/operations", {"operation": "update"})
        with patch("enterprise_agent_platform.gates.MAX_MANAGER_RESPONSE_BYTES", 64):
            with self.assertRaises(ManagerResponseUncertainError):
                await manager_request(self.platform, "POST", "/v1/check", {})
        with self.assertRaises(ManagerClientError) as raised:
            await manager_request(self.platform, "POST", "/v1/operations", {})
        self.assertNotIsInstance(raised.exception, ManagerResponseUncertainError)
        self.assertEqual(len(self.requests), 9)
        server.close()

    async def test_restore_over_real_uds(self):
        op = "op_" + "a" * 32
        active = dict(maintenance=True, active_operation_id=op, operation_id=op,
                      finalize_pending_operation_id="", gate_settlement=None)
        settled = dict(active, active_operation_id="", finalize_pending_operation_id=op,
                       public_state="updating", target=None,
                       current={"id": "b" * 40, "source_commit": "b" * 40},
                       gate_settlement={"schema_version": 1, "operation_id": op, "action": "commit"})
        bad = dict(settled, target={"id": "c" * 40})
        server = await self.start_manager([self.response(json.dumps(x).encode()) for x in (active, bad, settled)])
        await self.gate.restore()
        self.assertEqual(self.gate.reserved, op)
        with self.assertRaises(ManagerClientError):
            await self.gate.restore()
        self.assertEqual(self.gate.reserved, op)
        await self.gate.restore()
        self.assertIsNone(self.gate.reserved)
        self.assertEqual(await self.gate.release(op, commit=True), {"released": True})
        self.assertFalse((self.root / "published").exists())
        server.close()

    async def test_restore_rejects_invalid_slots_and_accepts_finalize_abort(self):
        op = "op_" + "a" * 32
        finalizing = dict(maintenance=True, active_operation_id="", operation_id=op,
                          finalize_pending_operation_id=op, gate_settlement=None)
        invalid = [
            {k: v for k, v in finalizing.items() if k != "gate_settlement"},
            dict(finalizing, maintenance=1),
            dict(finalizing, maintenance=False),
            dict(finalizing, active_operation_id=op),
            dict(finalizing, operation_id="other"),
            dict(finalizing, active_operation_id=False),
            dict(finalizing, finalize_pending_operation_id=""),
        ]
        aborted = dict(finalizing, public_state="updating", target=None,
                       current={"id": "b" * 40, "source_commit": "b" * 40},
                       gate_settlement={"schema_version": 1, "operation_id": op, "action": "abort"})
        for change in ({"schema_version": True}, {"extra": True}, {"operation_id": "wrong"},
                       {"action": "release"}):
            invalid.append(dict(aborted, gate_settlement={**aborted["gate_settlement"], **change}))
        server = await self.start_manager([
            self.response(json.dumps(x).encode()) for x in [finalizing, *invalid, aborted]
        ])
        await self.gate.restore()
        self.assertEqual(self.gate.reserved, op)
        for _ in invalid:
            with self.assertRaises(ManagerClientError):
                await self.gate.restore()
            self.assertEqual(self.gate.reserved, op)
        await self.gate.restore()
        self.assertIsNone(self.gate.reserved)
        self.assertEqual(await self.gate.release(op, commit=False), {"released": True})
        with self.assertRaises(HTTPException):
            await self.gate.release(op, commit=True)
        self.assertFalse((self.root / "published").exists())
        server.close()
