"""Personal-AI subagents and Manager-supervised background processes.

A task is a durable ``background_tasks`` row shown as ``bg-<n>``. Subagents are Runtime runs consumed by one
coroutine each, concurrently with the conversation FIFO. Processes belong to Manager; Platform follows Manager's
change feed. A result reaches the model exactly once: ``delivered_at`` is claimed atomically by ``wait`` or by the
notice worker. Uncertain execution is never replayed.
"""
import asyncio
import html
import json
import logging
import re
import sqlite3
import time
import uuid
from datetime import datetime, timezone

import httpx
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse
from starlette.routing import Route

from .auth import require_permission
from .gates import ManagerClientError, manager_request
from .queue import _WorkTrace

log = logging.getLogger(__name__)

MAX_AGENTS = 8
MAX_RESULT_BYTES = 64 * 1024
OUTPUT_TAIL_BYTES = 16 * 1024
NOTICE_RESULT_CHARS = 4000
GATEWAY_RESULT_CHARS = 20000
SUBAGENT_TOOLS = {
    "scout": ["read", "grep", "find", "ls", "web_search", "web_fetch"],
    "task": ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search", "web_fetch"],
}
# The model policy slot each subagent type runs under.
SUBAGENT_SLOT = {"scout": "scout", "task": "worker"}
SUBAGENT_PROMPT = (
    "You are a subagent working for the user's personal AI, identified as {id}. Complete only the assigned task, "
    "using your tools. {capability} Your final answer is delivered to the personal AI as your report: state what you "
    "found or did, with concrete evidence (paths, commands, output), and what remains uncertain. You share the "
    "workspace with other agents; do not touch files outside the task. You cannot ask questions or start further "
    "subagents or background work.")
CAPABILITY = {
    "scout": "You are read-only: investigate and report, never modify files.",
    "task": "You may modify files and run foreground commands needed for the task.",
}
PROCESS_ID = re.compile(r"proc_[0-9a-z]{1,64}")
TERMINAL = ("completed", "failed", "stopped", "interrupted")


class TaskError(HTTPException):
    """A typed task failure; the gateway reports it as a tool error."""

    def __init__(self, status, code, detail):
        super().__init__(status, detail)
        self.code = code


def _ts():
    return int(time.time())


def _iso(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat() if value is not None else None


def _clip(text, limit=MAX_RESULT_BYTES):
    data = text.encode("utf-8")
    return text if len(data) <= limit else data[:limit].decode("utf-8", "ignore")


def parse_id(value):
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return value
    if isinstance(value, str) and re.fullmatch(r"(bg-)?[0-9]{1,12}", value.strip()):
        number = int(value.strip().removeprefix("bg-"))
        if number > 0:
            return number
    raise TaskError(400, "bad_id", "Task id must look like bg-<n>")


def _summary(args):
    if isinstance(args, dict):
        for key in ("command", "path", "query", "url", "pattern", "task"):
            if isinstance(args.get(key), str):
                return args[key][:120]
        return json.dumps(args, ensure_ascii=False)[:120]
    return ""


def _current(work):
    for item in reversed((work or {}).get("items", [])):
        if item.get("type") == "tool" and item.get("ended_at") is None:
            return {"tool": item["name"], "summary": _summary(item.get("args"))}
    return None


def view(row):
    """The TaskView users and the model see."""
    running_agent = row["kind"] == "agent" and row["status"] == "running"
    work = json.loads(row["work_json"]) if running_agent and row["work_json"] else None
    usage = json.loads(row["usage_json"]) if row["usage_json"] else None
    result = row["result"]
    return {"id": f"bg-{row['id']}", "kind": row["kind"], "name": row["name"], "label": row["label"],
            "agent_type": row["agent_type"], "status": row["status"], "reason": row["reason"],
            "exit_code": row["exit_code"], "started_at": _iso(row["started_at"]), "ended_at": _iso(row["ended_at"]),
            "result_preview": result[-2000:] if row["kind"] == "process" else result[:2000],
            "created_by_message_id": row["created_by_message_id"],
            "created_by_tool_call_id": row["created_by_tool_call_id"],
            "current": _current(work),
            "usage": {"total_tokens": usage.get("total", 0)} if usage else None}


def classify(process):
    """Task outcome for a Manager process View, or None while it still runs."""
    state, code, reason = process.get("state"), process.get("exit_code"), process.get("reason") or ""
    if state == "exited":
        return ("completed" if code == 0 else "failed"), reason, code
    if state == "killed":
        return ("failed", "timeout", code) if reason == "timeout" else ("stopped", reason or "user", code)
    if state == "failed":
        return "failed", reason or "failed", code
    if state == "interrupted":
        return "interrupted", reason or "system_restart", code
    return None


def notice_text(rows):
    """Untrusted results, escaped inside one block; the model must not read them as instructions."""
    parts = ["<background-task-results>"]
    for row in rows:
        ended = row["ended_at"] or row["started_at"]
        attrs = [f'id="bg-{row["id"]}"', f'kind="{row["kind"]}"',
                 f'name="{html.escape(row["name"] or row["label"][:80], quote=True)}"',
                 f'status="{row["status"]}"']
        if row["exit_code"] is not None:
            attrs.append(f'exit_code="{row["exit_code"]}"')
        if row["reason"]:
            attrs.append(f'reason="{html.escape(row["reason"][:80], quote=True)}"')
        attrs.append(f'duration_seconds="{max(0, ended - row["started_at"])}"')
        text = row["result"]
        clipped = text[-NOTICE_RESULT_CHARS:] if row["kind"] == "process" else text[:NOTICE_RESULT_CHARS]
        suffix = f"\n[truncated; use `job output bg-{row['id']}`]" if len(clipped) < len(text) else ""
        parts.append(f"<task {' '.join(attrs)}>\n<result>{html.escape(clipped + suffix, quote=False)}</result>\n</task>")
    parts.append("</background-task-results>")
    return "\n".join(parts) + "\n\nContinue the user's work using these results."


def _ok(content, data=None):
    return {"content": content, "data": data if data is not None else {}, "is_error": False}


class Tasks:
    throttle = 0.5
    poll_pause = 0.2
    retry_initial = 1.0
    retry_max = 30.0

    def __init__(self, platform):
        self.p = platform
        self.children = {}
        self.runs = {}
        self.stop_requested = set()
        self.watcher = None
        self.cancels = set()
        self._event = asyncio.Event()

    # -- storage ---------------------------------------------------------------------------------

    def row(self, tid):
        with self.p.db.connect() as conn:
            return conn.execute("SELECT * FROM background_tasks WHERE id=?", (tid,)).fetchone()

    def owned(self, uid, ident):
        number = parse_id(ident)
        with self.p.db.connect() as conn:
            row = conn.execute("SELECT * FROM background_tasks WHERE id=? AND user_id=?", (number, uid)).fetchone()
        if row is None:
            raise TaskError(404, "not_found", f"Task bg-{number} not found")
        return row

    def signal(self):
        event, self._event = self._event, asyncio.Event()
        event.set()

    def emit(self, row):
        self.p.queue.emit(f"private:{row['user_id']}", {"type": "task", "task": view(row)})

    def scope(self, uid):
        return self.p.queue.scope(self.p.queue.user(uid), "private", authorize=False)

    def origin(self, conn, context):
        """The parent run's job and message, when the Runtime run is known."""
        row = conn.execute(
            "SELECT id,payload_json FROM durable_jobs WHERE kind='agent' AND status='running' "
            "AND json_extract(payload_json,'$.runtime_run_id')=?", (context.get("run_id"),)).fetchone()
        return (row["id"], json.loads(row["payload_json"]).get("message_id")) if row else (None, None)

    def child_owner(self, context):
        """The active user owning a live subagent run, if the context is exactly that run."""
        match = re.fullmatch(r"agent-private-(\d+)-bg-(\d+)", str(context.get("sid", "")))
        if not match:
            return None
        uid, tid = int(match[1]), int(match[2])
        if not context.get("run_id") or self.runs.get(tid) != context["run_id"] \
                or context.get("scope_key") != f"private:{uid}/delegate/bg-{tid}" \
                or context.get("owner_user_id") not in (None, uid):
            return None
        with self.p.db.connect() as conn:
            row = conn.execute(
                "SELECT u.* FROM background_tasks t JOIN users u ON u.id=t.user_id "
                "WHERE t.id=? AND t.user_id=? AND t.kind='agent' AND t.status='running' AND u.active=1",
                (tid, uid)).fetchone()
        return dict(row) if row else None

    # -- lifecycle ---------------------------------------------------------------------------------

    async def start(self):
        """Children never survive a Platform restart; nothing is replayed."""
        with self.p.db.connect() as conn:
            rows = conn.execute("SELECT * FROM background_tasks WHERE kind='agent' AND status='running'").fetchall()
            conn.execute("UPDATE background_tasks SET status='interrupted',reason='platform_restart',ended_at=?,updated_at=? "
                         "WHERE kind='agent' AND status='running'", (_ts(), _ts()))
        for row in rows:
            self.emit(self.row(row["id"]))
            self.cancel_later(f"agent-private-{row['user_id']}-bg-{row['id']}")
        if self.p.settings.manager_executor_token_file.exists():
            self.ensure_watcher()
        await self.flush_all()

    async def stop(self):
        tasks = [*self.children.values(), *self.cancels, *([self.watcher] if self.watcher else [])]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.watcher = None

    def resume(self):
        """After an update reservation: notices skipped under maintenance are created now."""
        if self.p.queue.stopping:
            return
        task = asyncio.ensure_future(self.flush_all())
        self.cancels.add(task)
        task.add_done_callback(self.cancels.discard)

    def cancel_later(self, sid):
        """Best-effort, idempotent cancel of a child session whose task is already settled."""
        async def cancel():
            for _ in range(5):
                try:
                    await self.p.queue.runtime("POST", f"/v1/sessions/{sid}/cancel", timeout=35)
                    return
                except Exception:
                    await asyncio.sleep(1)
        task = asyncio.ensure_future(cancel())
        self.cancels.add(task)
        task.add_done_callback(self.cancels.discard)

    # -- subagents ---------------------------------------------------------------------------------

    async def spawn(self, user, context, args):
        agent = args.get("agent", "task")
        entries = args.get("tasks")
        shared = args.get("context", "")
        if agent not in SUBAGENT_TOOLS:
            raise TaskError(400, "bad_agent", "agent must be scout or task")
        if not isinstance(entries, list) or not 1 <= len(entries) <= MAX_AGENTS:
            raise TaskError(400, "bad_tasks", "tasks must contain 1 to 8 entries")
        if not isinstance(shared, str) or len(shared) > 50000:
            raise TaskError(400, "bad_context", "context must be a string of at most 50000 characters")
        parsed = []
        for entry in entries:
            text = entry.get("task") if isinstance(entry, dict) else None
            name = entry.get("name") if isinstance(entry, dict) else None
            if not isinstance(text, str) or not text.strip() or len(text) > 20000:
                raise TaskError(400, "bad_task", "each task needs a task description of at most 20000 characters")
            if name is not None and (not isinstance(name, str) or not 1 <= len(name.strip()) <= 48):
                raise TaskError(400, "bad_name", "name must be 1 to 48 characters")
            prompt = (f"<context>\n{shared}\n</context>\n\n" if shared.strip() else "") + f"Task:\n{text.strip()}"
            parsed.append((name.strip() if name else None, text.strip(), prompt))
        uid = user["id"]
        async with self.p.gate.admit():
            with self.p.db.connect() as conn:
                conn.execute("BEGIN IMMEDIATE")
                running = conn.execute("SELECT COUNT(*) FROM background_tasks WHERE user_id=? AND kind='agent' "
                                       "AND status='running'", (uid,)).fetchone()[0]
                if running + len(parsed) > MAX_AGENTS:
                    raise TaskError(409, "too_many_subagents",
                                    f"Too many running subagents: {running} running, the limit is {MAX_AGENTS}")
                job_id, message_id = self.origin(conn, context)
                ids = []
                for name, text, prompt in parsed:
                    ids.append(conn.execute(
                        "INSERT INTO background_tasks(user_id,kind,name,label,agent_type,prompt,status,started_at,"
                        "created_by_message_id,created_by_tool_call_id,run_job_id,updated_at) "
                        "VALUES (?,?,?,?,?,?,'running',?,?,?,?,?)",
                        (uid, "agent", name, text.splitlines()[0][:120], agent, prompt, _ts(), message_id,
                         context.get("tool_call_id"), job_id, _ts())).lastrowid)
            for tid in ids:
                self.children[tid] = asyncio.create_task(self.run_child(tid))
        rows = [self.row(tid) for tid in ids]
        for row in rows:
            self.emit(row)
        tasks = [{"id": f"bg-{row['id']}", "name": row["name"], "agent_type": agent} for row in rows]
        return _ok("Started " + ", ".join(f"bg-{row['id']}" for row in rows) +
                   f" ({agent}). Results are delivered automatically when they finish; keep working or call wait.",
                   {"tasks": tasks})

    async def run_child(self, tid):
        row = self.row(tid)
        uid = row["user_id"]
        work = _WorkTrace()
        flusher = asyncio.create_task(self.flush_work(tid, work))
        started = False
        try:
            user = self.p.queue.user(uid)
            info = self.p.queue.scope(user, "private", authorize=False, slot=SUBAGENT_SLOT[row["agent_type"]])
            model = await self.p.queue.selected_model(info)
            sid = f"agent-private-{uid}-bg-{tid}"
            sandbox = {**info["sandbox"], "scope_key": f"private:{uid}/delegate/bg-{tid}"}
            result = await self.p.queue.runtime("POST", f"/v1/sessions/{sid}/runs", json={
                "kind": "subagent", "sandbox": sandbox, "model": model,
                "prompt": {"text": row["prompt"], "images": []},
                "context_prefix": json.dumps({"time": datetime.now(timezone.utc).isoformat(),
                                              "user": user["display_name"], "tz": user["timezone"]}),
                "resources": {"system_prompt": SUBAGENT_PROMPT.format(id=f"bg-{tid}", capability=CAPABILITY[row["agent_type"]]),
                              "agents_md": None, "skills": []},
                "tools": SUBAGENT_TOOLS[row["agent_type"]]})
            started = True
            run_id = self.runs[tid] = result["run_id"]
            if tid in self.stop_requested:
                await self.p.queue.runtime("POST", f"/v1/runs/{run_id}/cancel")
            outcome = None
            async with self.p.http.stream("GET", self.p.settings.runtime_url.rstrip("/") + f"/v1/runs/{run_id}/events?after=0",
                                          headers={"Authorization": f"Bearer {self.p.settings.runtime_token}"},
                                          timeout=None) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    event = json.loads(line[5:].strip())
                    if event.get("type") == "run_end":
                        outcome = event
                        break
                    work.add(event)
            if outcome is None:
                raise RuntimeError("Runtime event stream ended without run_end")
            self.settle_agent(tid, user, info, model, outcome, work)
        except asyncio.CancelledError:
            self.settle(tid, "interrupted", "platform_stopped", result="Platform stopped; execution was not replayed",
                        work=work.data)
            raise
        except Exception as exc:
            self.settle(tid, "interrupted" if started else "failed", "stream_lost" if started else "start_failed",
                        result=str(getattr(exc, "detail", exc))[:2000], work=work.data)
            if started:
                self.cancel_later(f"agent-private-{uid}-bg-{tid}")
        finally:
            flusher.cancel()
            self.children.pop(tid, None)
            self.runs.pop(tid, None)
            self.stop_requested.discard(tid)

    def settle_agent(self, tid, user, info, model, event, work):
        status = event.get("status")
        stopped = tid in self.stop_requested
        error = str(event.get("error") or "")[:500]
        if status == "completed":
            outcome, reason = "completed", ""
        elif status == "cancelled" or stopped:
            outcome, reason = "stopped", "user"
        else:
            outcome, reason = "failed", error or "run_failed"
        usage = event.get("usage") or {}
        self.settle(tid, outcome, reason, result=event.get("text") or error, work=work.finish(), usage=usage,
                    accounting=(user, info, event.get("model", model["id"])))

    def settle(self, tid, status, reason, *, result="", work=None, usage=None, accounting=None, exit_code=None):
        """The only terminal write of a task; exactly one caller wins."""
        with self.p.db.connect() as conn:
            changed = conn.execute(
                "UPDATE background_tasks SET status=?,reason=?,exit_code=?,result=?,work_json=?,usage_json=?,ended_at=?,"
                "updated_at=? WHERE id=? AND status='running'",
                (status, reason, exit_code, _clip(result), json.dumps(work) if work else None,
                 json.dumps(usage) if usage else None, _ts(), _ts(), tid)).rowcount
            if changed and accounting is not None and usage:
                user, info, model = accounting
                conn.execute(
                    "INSERT INTO token_usage_events(user_id,username,display_name,scope_type,scope_id,scope_name,"
                    "request_message_id,response_message_id,provider,model,input_tokens,output_tokens,total_tokens,"
                    "raw_usage_json,created_at) VALUES (?,?,?,?,?,?,NULL,NULL,?,?,?,?,?,?,?)",
                    (user["id"], user["username"], user["display_name"], info["scope_type"], info["scope_id"], "",
                     "openai-codex", model, usage.get("input", 0), usage.get("output", 0), usage.get("total", 0),
                     json.dumps({**usage, "kind": "subagent", "task_id": f"bg-{tid}",
                                 "cacheRead": usage.get("cache_read", 0), "cacheWrite": usage.get("cache_write", 0)}),
                     _ts()))
        if changed:
            self.emit(self.row(tid))
            self.signal()
            self.notify_later(self.row(tid)["user_id"])
        return bool(changed)

    def notify_later(self, uid):
        if getattr(self.p.queue, "stopping", False):
            return
        task = asyncio.ensure_future(self.flush(uid))
        self.cancels.add(task)
        task.add_done_callback(self.cancels.discard)

    async def flush_work(self, tid, work):
        """Persist the child's trace and push at most two task events per second."""
        last = None
        while True:
            await asyncio.sleep(self.throttle)
            encoded = json.dumps(work.data)
            if encoded == last:
                continue
            last = encoded
            with self.p.db.connect() as conn:
                conn.execute("UPDATE background_tasks SET work_json=?,updated_at=? WHERE id=? AND status='running'",
                             (encoded, _ts(), tid))
            row = self.row(tid)
            if row["status"] == "running":
                self.emit(row)

    # -- processes ---------------------------------------------------------------------------------

    async def executor(self, path, body, timeout=10):
        return await manager_request(self.p, "POST", "/v1/executor/" + path, body, executor=True, timeout=timeout)

    async def find_process(self, uid, process_id):
        listing = await self.executor("process/list", {"owner": f"private:{uid}", "include_finished": True})
        return next((item for item in listing.get("processes", []) if item.get("id") == process_id), None)

    async def register_process(self, user, context, args):
        process_id = args.get("process_id")
        if not isinstance(process_id, str) or not PROCESS_ID.fullmatch(process_id):
            raise TaskError(400, "bad_process", "process_id is invalid")
        uid = user["id"]
        with self.p.db.connect() as conn:
            existing = conn.execute("SELECT id FROM background_tasks WHERE external_id=? AND user_id=?",
                                    (process_id, uid)).fetchone()
        if existing:
            return _ok(f"bg-{existing['id']}", {"task_id": f"bg-{existing['id']}"})
        first = await self.find_process(uid, process_id)
        if first is None:
            raise TaskError(404, "process_not_found", "Manager has no such process for this user")
        name = first.get("name") or args.get("name")
        command = str(first.get("command") or args.get("command") or "")
        started = first.get("started_at")
        try:
            started_at = int(datetime.fromisoformat(started.replace("Z", "+00:00")).timestamp()) if started else _ts()
        except (ValueError, AttributeError):
            started_at = _ts()
        try:
            with self.p.db.connect() as conn:
                job_id, message_id = self.origin(conn, context)
                tid = conn.execute(
                    "INSERT INTO background_tasks(user_id,kind,external_id,name,label,status,started_at,delivered_at,"
                    "created_by_message_id,created_by_tool_call_id,run_job_id,updated_at) "
                    "VALUES (?,'process',?,?,?,'running',?,?,?,?,?,?)",
                    (uid, process_id, name if isinstance(name, str) else None, command[:500], started_at,
                     _ts() if args.get("delivered") is True else None, message_id, context.get("tool_call_id"),
                     job_id, _ts())).lastrowid
        except sqlite3.IntegrityError:
            with self.p.db.connect() as conn:
                tid = conn.execute("SELECT id FROM background_tasks WHERE external_id=?", (process_id,)).fetchone()["id"]
            return _ok(f"bg-{tid}", {"task_id": f"bg-{tid}"})
        self.ensure_watcher()
        # The row exists now, so the watcher sees every later change. Read again to cover any change since `first`.
        current = await self.find_process(uid, process_id) or first
        await self.apply_process(tid, current)
        self.emit(self.row(tid))
        self.signal()
        return _ok(f"bg-{tid}", {"task_id": f"bg-{tid}"})

    async def tail(self, uid, process_id):
        try:
            read = await self.executor("process/read", {"process_id": process_id, "owner": f"private:{uid}",
                                                        "offset": -1, "max_bytes": OUTPUT_TAIL_BYTES})
            return str(read.get("data") or "")
        except (ManagerClientError, httpx.HTTPError):
            return ""

    async def apply_process(self, tid, process):
        outcome = classify(process)
        row = self.row(tid)
        if outcome is None or row is None or row["status"] != "running" or process.get("unconfirmed"):
            return False
        status, reason, code = outcome
        tail = await self.tail(row["user_id"], row["external_id"])
        return self.settle(tid, status, reason, result=tail, exit_code=code)

    def ensure_watcher(self):
        if self.watcher is None or self.watcher.done():
            self.watcher = asyncio.create_task(self.watch())

    def cursor(self):
        with self.p.db.connect() as conn:
            row = conn.execute("SELECT value FROM settings WHERE key='process_changes_cursor'").fetchone()
        return int(row[0]) if row else 0

    def save_cursor(self, value):
        with self.p.db.connect() as conn:
            conn.execute("INSERT INTO settings(key,value,secret,updated_at) VALUES ('process_changes_cursor',?,0,?) "
                         "ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
                         (str(value), _ts()))

    async def reconcile(self):
        with self.p.db.connect() as conn:
            rows = conn.execute("SELECT * FROM background_tasks WHERE kind='process' AND status='running'").fetchall()
        for row in rows:
            process = await self.find_process(row["user_id"], row["external_id"])
            if process is not None:
                await self.apply_process(row["id"], process)

    async def watch(self):
        """Follow Manager's global change feed; the cursor is persisted after each applied batch."""
        recovering = True
        backoff = self.retry_initial
        while True:
            try:
                if recovering:
                    await self.reconcile()
                    recovering = False
                after = self.cursor()
                batch = await self.executor("process/changes", {"after": after, "wait_ms": 25000}, timeout=40)
                for process in batch.get("changes", []):
                    with self.p.db.connect() as conn:
                        row = conn.execute("SELECT id FROM background_tasks WHERE external_id=?",
                                           (process.get("id"),)).fetchone()
                    if row:
                        await self.apply_process(row["id"], process)
                next_cursor = batch.get("next")
                if isinstance(next_cursor, int) and not isinstance(next_cursor, bool) and next_cursor != after:
                    self.save_cursor(next_cursor)
                backoff = self.retry_initial
                if not batch.get("changes"):
                    await asyncio.sleep(self.poll_pause)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("Background process watcher failed: %s", exc)
                recovering = True
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, self.retry_max)

    async def receipt_call(self, user, task, action, arguments, details):
        """One audited Manager process operation; an uncertain outcome is never retried."""
        sandbox = self.scope(user["id"])["sandbox"]
        call = {"run_id": f"platform-bg-{task['id']}", "scope_id": f"private:{user['id']}",
                "lifecycle_id": sandbox["lifecycle_id"], "tool_call_id": str(uuid.uuid4()),
                "execution_context": {"sandbox_id": sandbox["sandbox_id"], "workspace_id": sandbox["workspace_id"],
                                      "profile": sandbox["profile"]},
                "target": "sandbox", "action": action, "arguments": arguments}
        receipt = await self.executor("audit", {**call, "audit_id": str(uuid.uuid4()), "operation": "process",
                                                "details": details})
        return await self.executor(f"process/{action}", {**call, "audit_id": receipt["audit_id"],
                                                         "executor_id": receipt["executor_id"]}, timeout=30)

    # -- user and model operations -------------------------------------------------------------

    async def stop_task(self, user, ident):
        row = self.owned(user["id"], ident)
        if row["status"] != "running":
            return view(row)
        tid = row["id"]
        if row["kind"] == "process":
            reply = await self.receipt_call(user, row, "kill", {"process_id": row["external_id"]},
                                            {"process_id": row["external_id"]})
            process = reply.get("process") or {}
            if process.get("unconfirmed"):
                raise TaskError(409, "unconfirmed", f"Stop was sent to bg-{tid} but termination is not confirmed yet")
            await self.apply_process(tid, process)
            current = self.row(tid)
            if current["status"] == "running":
                raise TaskError(409, "unconfirmed", f"Stop was sent to bg-{tid} but termination is not confirmed yet")
            return view(current)
        self.stop_requested.add(tid)
        run_id = self.runs.get(tid)
        try:
            if run_id:
                await self.p.queue.runtime("POST", f"/v1/runs/{run_id}/cancel")
            elif tid not in self.children:
                self.settle(tid, "interrupted", "orphaned", result="No live run for this task")
        except httpx.HTTPError as exc:
            self.stop_requested.discard(tid)
            raise TaskError(502, "runtime_unavailable", "Runtime could not cancel the subagent") from exc
        deadline = asyncio.get_running_loop().time() + 10
        while self.row(tid)["status"] == "running" and asyncio.get_running_loop().time() < deadline:
            await self.changed(0.5)
        return view(self.row(tid))

    async def send_input(self, user, ident, text, eof):
        row = self.owned(user["id"], ident)
        if row["kind"] != "process":
            raise TaskError(400, "not_a_process", "Only background processes accept input")
        if row["status"] != "running":
            raise TaskError(409, "not_running", f"bg-{row['id']} is not running")
        if not isinstance(text, str) or len(text.encode("utf-8")) > 64 * 1024 or not isinstance(eof, bool):
            raise TaskError(400, "bad_input", "text must be at most 64 KiB and eof a boolean")
        if not text and not eof:
            raise TaskError(400, "bad_input", "Nothing to send")
        arguments = {"process_id": row["external_id"], "data": text, "eof": eof}
        try:
            await self.receipt_call(user, row, "stdin", arguments,
                                    {"process_id": row["external_id"], "bytes": len(text.encode("utf-8"))})
        except ManagerClientError as exc:
            if getattr(exc, "upstream_status", None) == 409:
                raise TaskError(409, "stdin_closed", f"bg-{row['id']} does not accept input: {exc.detail}") from exc
            raise
        return view(self.row(row["id"]))

    async def output(self, user, ident, offset=-1, wait_ms=0):
        row = self.owned(user["id"], ident)
        if row["kind"] != "process":
            raise TaskError(400, "not_a_process", "Only background processes have an output log")
        if not isinstance(offset, int) or isinstance(offset, bool) or offset < -1:
            raise TaskError(400, "bad_offset", "offset must be -1 or a byte offset")
        wait_ms = max(0, min(int(wait_ms), 30000))
        return await self.executor("process/read", {"process_id": row["external_id"], "owner": f"private:{user['id']}",
                                                    "offset": offset, "max_bytes": 65536, "wait_ms": wait_ms},
                                   timeout=wait_ms / 1000 + 10)

    def listing(self, uid, limit=100):
        with self.p.db.connect() as conn:
            rows = conn.execute("SELECT * FROM background_tasks WHERE user_id=? ORDER BY (status='running') DESC, id DESC LIMIT ?",
                                (uid, limit)).fetchall()
        return rows

    def detail(self, uid, ident):
        row = self.owned(uid, ident)
        result = {"task": view(row), "result": row["result"]}
        if row["kind"] == "agent":
            result["work"] = json.loads(row["work_json"]) if row["work_json"] else None
        return result

    # -- delivery ----------------------------------------------------------------------------------

    async def changed(self, timeout):
        event = self._event
        try:
            await asyncio.wait_for(event.wait(), timeout)
        except TimeoutError:
            pass

    def claim(self, uid, ids):
        """Atomically deliver the oldest terminal, undelivered task."""
        marks = f" AND id IN ({','.join('?' * len(ids))})" if ids else ""
        with self.p.db.connect() as conn:
            for row in conn.execute("SELECT * FROM background_tasks WHERE user_id=? AND status!='running' "
                                    f"AND delivered_at IS NULL{marks} ORDER BY ended_at,id", (uid, *(ids or ()))).fetchall():
                if conn.execute("UPDATE background_tasks SET delivered_at=?,updated_at=? WHERE id=? AND delivered_at IS NULL",
                                (_ts(), _ts(), row["id"])).rowcount:
                    return row
        return None

    def pending_input(self, context):
        with self.p.db.connect() as conn:
            job_id, _ = self.origin(conn, context)
            if job_id is None:
                return False
            for child in conn.execute("SELECT payload_json FROM durable_jobs WHERE status='running' "
                                      "AND json_extract(payload_json,'$.parent_job_id')=?", (job_id,)):
                mid = json.loads(child[0])["message_id"]
                metadata = conn.execute("SELECT metadata_json FROM messages WHERE id=?", (mid,)).fetchone()
                if metadata and json.loads(metadata[0]).get("delivery") == "pending":
                    return True
        return False

    @staticmethod
    def report(row):
        text = row["result"]
        suffix = ""
        if len(text) > GATEWAY_RESULT_CHARS:
            text, suffix = text[:GATEWAY_RESULT_CHARS], f"\n[truncated; use `job output bg-{row['id']}` for the rest]"
        head = f"bg-{row['id']} ({row['kind']}{' ' + row['agent_type'] if row['agent_type'] else ''}"
        head += f"{', ' + row['name'] if row['name'] else ''}) {row['status']}"
        if row["exit_code"] is not None:
            head += f", exit code {row['exit_code']}"
        if row["reason"]:
            head += f", reason {row['reason']}"
        return head + (("\n" + text) if text else "") + suffix

    async def wait(self, user, context, args, disconnected):
        uid = user["id"]
        ids = args.get("ids")
        if ids is not None:
            if not isinstance(ids, list) or not ids:
                raise TaskError(400, "bad_ids", "ids must be a non-empty list")
            ids = [self.owned(uid, ident)["id"] for ident in ids]
        timeout = args.get("timeout", 1800)
        if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or timeout <= 0:
            raise TaskError(400, "bad_timeout", "timeout must be positive seconds")
        loop = asyncio.get_running_loop()
        deadline = loop.time() + min(timeout, 1800)
        key = f"private:{uid}"
        marks = f" AND id IN ({','.join('?' * len(ids))})" if ids else ""
        while True:
            event = self._event
            running_run = self.p.queue.running.get(key)
            if await disconnected() or (running_run is not None and running_run != context.get("run_id")):
                return {"content": "wait was cancelled", "data": {"cancelled": True}, "is_error": True}
            row = self.claim(uid, ids)
            if row is not None:
                return _ok(self.report(row), {"task": {**view(row), "result": row["result"]}})
            with self.p.db.connect() as conn:
                running = conn.execute(f"SELECT COUNT(*) FROM background_tasks WHERE user_id=? AND status='running'{marks}",
                                       (uid, *(ids or ()))).fetchone()[0]
            if not running:
                raise TaskError(409, "nothing_running", "No background task is running and none has an undelivered result")
            if self.pending_input(context):
                return _ok("A new user message is pending delivery into this run; returning early. Handle it, then wait again if needed.",
                           {"note": "pending_input", "running": running})
            remaining = deadline - loop.time()
            if remaining <= 0:
                return _ok(f"Timed out; {running} task(s) still running.", {"timed_out": True, "running": running})
            try:
                await asyncio.wait_for(event.wait(), min(remaining, 1.0))
            except TimeoutError:
                pass

    def begin_notice(self, job, payload, info):
        """Claim the notice's still-undelivered tasks; None settles the job without a run."""
        ids = [int(i) for i in payload.get("task_ids", [])]
        if not ids:
            ids = [0]
        with self.p.db.connect() as conn:
            marks = ",".join("?" * len(ids))
            claimed = conn.execute(
                f"UPDATE background_tasks SET delivered_at=?,updated_at=? WHERE user_id=? AND delivered_at IS NULL "
                f"AND status!='running' AND id IN ({marks}) RETURNING id", (_ts(), _ts(), payload["user_id"], *ids)).fetchall()
            rows = []
            if claimed:
                rows = conn.execute(f"SELECT * FROM background_tasks WHERE id IN ({','.join('?' * len(claimed))}) "
                                    "ORDER BY ended_at,id", [r[0] for r in claimed]).fetchall()
            if not rows:
                conn.execute("UPDATE durable_jobs SET status='succeeded',updated_at=? WHERE id=?", (_ts(), job["id"]))
                conn.execute("UPDATE messages SET metadata_json=json_set(metadata_json,'$.skipped',json('true'),"
                             "'$.status','completed') WHERE id=?", (payload["message_id"],))
        if not rows:
            self.p.queue.emit(info["scope_key"], {"type": "message", "message": self.p.queue.message(info, payload["message_id"])})
            return None
        return notice_text(rows)

    async def flush_all(self):
        with self.p.db.connect() as conn:
            users = [r[0] for r in conn.execute("SELECT DISTINCT user_id FROM background_tasks WHERE status!='running' "
                                                "AND delivered_at IS NULL AND notice_job_id IS NULL")]
        for uid in users:
            await self.flush(uid)

    async def flush(self, uid):
        """Notice every finished, undelivered task of the user: append to a queued notice or create one."""
        queue = self.p.queue
        key = f"private:{uid}"
        try:
            async with self.p.gate.admit(), queue.lock(key):
                with self.p.db.connect() as conn:
                    user = conn.execute("SELECT * FROM users WHERE id=? AND active=1", (uid,)).fetchone()
                    rows = conn.execute("SELECT * FROM background_tasks WHERE user_id=? AND status!='running' "
                                        "AND delivered_at IS NULL AND notice_job_id IS NULL ORDER BY ended_at,id",
                                        (uid,)).fetchall()
                    if not user or not rows:
                        return
                    info = queue.scope(dict(user), "private", authorize=False)
                    queued = conn.execute(
                        "SELECT id,payload_json FROM durable_jobs WHERE kind='agent' AND status='queued' AND scope_type='private' "
                        "AND scope_id=? AND json_extract(payload_json,'$.notice')=1 ORDER BY id LIMIT 1",
                        (info["scope_id"],)).fetchone()
                    views = [view(row) for row in rows]
                    ids = [row["id"] for row in rows]
                    if queued:
                        payload = json.loads(queued["payload_json"])
                        payload["task_ids"] = [*payload["task_ids"], *ids]
                        job_id, mid = queued["id"], payload["message_id"]
                        metadata = json.loads(conn.execute("SELECT metadata_json FROM messages WHERE id=?", (mid,)).fetchone()[0])
                        metadata["task_ids"] = [*metadata["task_ids"], *(v["id"] for v in views)]
                        metadata["tasks"] = [*metadata["tasks"], *views]
                        conn.execute("UPDATE messages SET metadata_json=?,content=? WHERE id=?",
                                     (json.dumps(metadata), "Background tasks finished: " + ", ".join(metadata["task_ids"]), mid))
                        conn.execute("UPDATE durable_jobs SET payload_json=?,updated_at=? WHERE id=?",
                                     (json.dumps(payload), _ts(), job_id))
                    else:
                        task_ids = [v["id"] for v in views]
                        mid = queue.insert_message(conn, info, dict(user), "system",
                                                   "Background tasks finished: " + ", ".join(task_ids),
                                                   {"kind": "task_notice", "task_ids": task_ids, "tasks": views,
                                                    "status": "queued"})
                        payload = {"user_id": uid, "scope": "private", "message_id": mid, "content": "",
                                   "attachment_ids": [], "schedule_run_id": None, "notice": True, "task_ids": ids}
                        job_id = conn.execute(
                            "INSERT INTO durable_jobs(kind,scope_type,scope_id,dedupe_key,payload_json,status,created_at,updated_at) "
                            "VALUES ('agent',?,?,?,?, 'queued',?,?)",
                            (info["scope_type"], info["scope_id"], str(uuid.uuid4()), json.dumps(payload), _ts(), _ts())).lastrowid
                    conn.execute(f"UPDATE background_tasks SET notice_job_id=? WHERE id IN ({','.join('?' * len(ids))})",
                                 (job_id, *ids))
                queue.emit(key, {"type": "message", "message": queue.message(info, mid)})
                queue.wake(key)
        except HTTPException:
            # Maintenance reservation: the rows stay un-noticed; resume() runs this again on release.
            return

    # -- gateway -----------------------------------------------------------------------------------

    async def gateway(self, user, action, args, context, disconnected):
        handlers = {"spawn": self.g_spawn, "register_process": self.register_process, "list": self.g_list,
                    "status": self.g_status, "output": self.g_output, "input": self.g_input, "stop": self.g_stop}
        if action != "wait" and action not in handlers:
            raise HTTPException(400, "Unsupported tasks action")
        try:
            if action == "wait":
                return await self.wait(user, context, args, disconnected)
            return await handlers[action](user, context, args)
        except TaskError as exc:
            return {"content": exc.detail, "data": {"error": exc.code}, "is_error": True}
        except HTTPException as exc:
            return {"content": str(exc.detail), "data": {"error": "upstream"}, "is_error": True}
        except httpx.HTTPError:
            return {"content": "Runtime request failed", "data": {"error": "upstream"}, "is_error": True}

    async def g_spawn(self, user, context, args):
        return await self.spawn(user, context, args)

    async def g_list(self, user, context, args):
        views = [view(row) for row in self.listing(user["id"], 50)]
        lines = [f"{v['id']} {v['kind']}{' ' + v['agent_type'] if v['agent_type'] else ''} {v['status']} "
                 f"{v['name'] or v['label']}" for v in views]
        return _ok("\n".join(lines) or "No background tasks.", {"tasks": views})

    async def g_status(self, user, context, args):
        detail = self.detail(user["id"], args.get("id"))
        task = detail["task"]
        line = f"{task['id']} {task['kind']} {task['status']}"
        if task["current"]:
            line += f", current: {task['current']['tool']} {task['current']['summary']}"
        return _ok(line, {"task": task, **({"work": detail["work"]} if "work" in detail else {})})

    async def g_output(self, user, context, args):
        row = self.owned(user["id"], args.get("id"))
        if row["kind"] == "agent":
            text = row["result"] or (f"bg-{row['id']} is still running." if row["status"] == "running" else "")
            return _ok(text[:GATEWAY_RESULT_CHARS], {"task": view(row)})
        offset = args.get("offset", -1)
        read = await self.output(user, args.get("id"), offset)
        footer = f"\n[offset {read.get('offset_start')}..{read.get('next_offset')}{', end of output' if read.get('eof') else ''}]"
        return _ok(str(read.get("data", "")) + footer, {k: read.get(k) for k in ("offset_start", "next_offset", "retained_from", "eof")}
                   | {"data": read.get("data", "")})

    async def g_input(self, user, context, args):
        task = await self.send_input(user, args.get("id"), args.get("text", ""), bool(args.get("eof", False)))
        return _ok(f"Sent input to {task['id']}.", {"task": task})

    async def g_stop(self, user, context, args):
        task = await self.stop_task(user, args.get("id"))
        return _ok(f"{task['id']} is {task['status']}.", {"task": task})


# -- user API ------------------------------------------------------------------------------------------


def _owner(request):
    return require_permission(request, "private_agent"), request.app.state.platform.tasks


async def list_tasks(request):
    user, tasks = _owner(request)
    return JSONResponse({"tasks": [view(row) for row in tasks.listing(user["id"])]})


async def get_task(request):
    user, tasks = _owner(request)
    return JSONResponse(tasks.detail(user["id"], request.path_params["id"]))


async def task_output(request):
    user, tasks = _owner(request)
    try:
        offset = int(request.query_params.get("offset", "-1"))
        wait_ms = int(request.query_params.get("wait_ms", "0"))
    except ValueError:
        raise HTTPException(400, "offset and wait_ms must be integers") from None
    return JSONResponse(await tasks.output(user, request.path_params["id"], offset, wait_ms))


async def stop_task(request):
    user, tasks = _owner(request)
    return JSONResponse({"task": await tasks.stop_task(user, request.path_params["id"])})


def routes():
    return [Route("/api/tasks", list_tasks), Route("/api/tasks/{id}", get_task),
            Route("/api/tasks/{id}/output", task_output), Route("/api/tasks/{id}/stop", stop_task, methods=["POST"])]
