"""Durable conversations with mid-run inputs; uncertain execution is never replayed."""
import asyncio
import json
import os
import shutil
import time
import uuid
from datetime import datetime, timezone

import httpx

from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route

from .auth import body_json, current_user, permissions
from .db import now
from .files import bounded_read, ensure_workspace, open_workspace


BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search", "web_fetch"]


def timestamp(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat() if isinstance(value, (int, float)) else value


def visible_metadata(metadata):
    """Message metadata as users see it: no legacy model-usage keys."""
    return {key: value for key, value in metadata.items() if key not in ("generation", "token_usage")}


class _WorkTrace:
    """A bounded, per-run display record, never a Runtime transcript."""

    def __init__(self):
        started = datetime.now(timezone.utc).isoformat(timespec="microseconds")
        self.data = {"v": 1, "started_at": started, "ended_at": started,
                     "items": [], "truncated": False}
        self.last_boundary_position = 0
        self.previous = None

    def clipped(self, text, limit):
        if len(text) > limit:
            self.data["truncated"] = True
        return text[:limit]

    def preview(self, parts):
        text = ""
        for part in parts:
            if part.get("type") == "text":
                value = part.get("text", "")
                if len(text) + len(value) > 2000:
                    self.data["truncated"] = True
                text += value[:max(0, 2000 - len(text))]
        return text

    def store(self, item, index=None):
        items = self.data["items"]
        if index is None and item["type"] == "input":
            # Delivery boundaries must survive a full trace. Make space by
            # evicting other work, never an already delivered user input.
            items.append(item)
            while (len(items) > 200 or len(json.dumps(self.data).encode("utf-8")) +
                   sum(40 for entry in items if entry["type"] == "tool" and entry["ended_at"] is None) > 96 * 1024):
                self.data["truncated"] = True
                victim = next((i for i, entry in enumerate(items) if entry["type"] != "input"), None)
                if victim is None:
                    break
                items.pop(victim)
                if victim < self.last_boundary_position:
                    self.last_boundary_position -= 1
            return True
        if index is None and len(items) >= 200:
            self.data["truncated"] = True
            return False
        old = items[index] if index is not None else None
        if index is None:
            items.append(item)
        else:
            items[index] = item
        # Reserve timestamp space for unfinished tools before accepting growth.
        reserve = sum(40 for entry in items if entry["type"] == "tool" and entry["ended_at"] is None)
        if len(json.dumps(self.data).encode("utf-8")) + reserve > 96 * 1024:
            if index is None:
                items.pop()
            else:
                items[index] = old
            self.data["truncated"] = True
            return False
        return True

    def add(self, event):
        kind = event["type"]
        items = self.data["items"]
        if kind in ("thinking_delta", "text_delta"):
            text = event.get("delta", "")
            if not text:
                return
            item_type = kind.removesuffix("_delta")
            merge = self.previous == item_type and items and items[-1]["type"] == item_type
            prior = items[-1]["text"] if merge else ""
            text = prior + self.clipped(text, max(0, 4000 - len(prior)))
            self.store({"type": item_type, "text": text}, len(items) - 1 if merge else None)
            self.previous = item_type
        elif kind == "tool_start":
            self.previous = "tool"
            self.last_boundary_position = len(items)
            args = event.get("args", {})
            encoded = json.dumps(args)
            if len(encoded) > 2000:
                args = {"_preview": self.clipped(encoded, 2000)}
            self.store({"type": "tool", "id": event["tool_call_id"], "name": event["name"],
                        "args": args, "status": "cancelled", "output": "",
                        "started_at": datetime.now(timezone.utc).isoformat(timespec="microseconds"),
                        "ended_at": None})
        elif kind in ("tool_update", "tool_end"):
            self.previous = "tool"
            for index, entry in enumerate(items):
                if entry["type"] != "tool" or entry["id"] != event["tool_call_id"]:
                    continue
                item = dict(entry)
                if kind == "tool_update":
                    item["output"] = self.preview(event.get("partial", {}).get("content", []))
                else:
                    item["output"] = self.preview(event.get("content_preview", []))
                    item["status"] = "error" if event.get("is_error") else "done"
                    item["ended_at"] = datetime.now(timezone.utc).isoformat(timespec="microseconds")
                if not self.store(item, index) and kind == "tool_end":
                    # The reserved timestamp budget guarantees terminal status
                    # survives even when the final output cannot fit.
                    item["output"] = entry["output"]
                    self.store(item, index)
                break
        elif kind == "input_delivered":
            self.store({"type": "input", "message_id": event["message_id"],
                        "at": datetime.now(timezone.utc).isoformat(timespec="microseconds")})
            self.last_boundary_position = len(items) - 1
            self.previous = "input"

    def finish(self):
        self.data["ended_at"] = datetime.now(timezone.utc).isoformat(timespec="microseconds")
        self.data["items"] = [item for index, item in enumerate(self.data["items"])
                              if item["type"] != "text" or index < self.last_boundary_position]
        return self.data if self.data["items"] else None


class Queue:
    def __init__(self, platform):
        self.p = platform
        self.tasks = {}
        self.locks = {}
        self.running = {}
        self.cancelling = set()
        self.starts = {}
        self.unsettled = {}
        self.stopping = False

    @property
    def active(self):
        return len(self.tasks.keys() | self.unsettled.keys())

    def lock(self, key):
        return self.locks.setdefault(key, asyncio.Lock())

    def conversation(self, user, conversation_id):
        with self.p.db.connect() as conn:
            row = conn.execute("SELECT * FROM chat_conversations WHERE id=? AND user_id=? AND deleted_at IS NULL",
                               (conversation_id, user["id"])).fetchone()
        if not row:
            raise HTTPException(404, "Conversation not found")
        return dict(row)

    def scope(self, user, scope, authorize=True):
        root = self.p.settings.data_dir / "workspaces"
        with self.p.db.connect() as conn:
            names = conn.execute("SELECT model_name,chat_model_name FROM users WHERE id=?", (user["id"],)).fetchone()
        model = {"id": names["model_name"], "thinking": "off" if user["thinking_depth"] == "none" else user["thinking_depth"]}
        kind, channel = "agent", None
        scope_name = ""
        required = "chat" if scope.startswith("chat-") else "private_agent" if scope == "private" else "read_workspace"
        if authorize and required not in permissions(self.p.db, user):
            raise HTTPException(403, "Permission denied")
        if scope.startswith("chat-"):
            conversation = self.conversation(user, scope[5:])
            kind = "chat"
            scope_name = conversation["title"]
            scope_type, scope_id, key = "private", conversation["id"], scope
            workspace_id = f"chat-user-{user['id']}"
            workspace = root / "chat" / f"user-{user['id']}" / conversation["id"]
            sid = scope
            model = {"id": names["chat_model_name"] or names["model_name"], "thinking": "off"}
            sandbox_key = f"chat:{user['id']}"
            cwd = f"/workspace/{conversation['id']}"
        elif scope == "private":
            scope_type, scope_id = "private", str(user["id"])
            key, sid = f"private:{scope_id}", f"agent-private-{scope_id}"
            workspace_id, workspace = f"user-{scope_id}", root / f"user-{scope_id}"
            sandbox_key, cwd = key, "/workspace"
        elif scope.startswith("channel-") and scope[8:].isdigit():
            channel = int(scope[8:])
            with self.p.db.connect() as conn:
                row = conn.execute("SELECT * FROM channels WHERE id=? AND (archived=0 OR ?)", (channel, not authorize)).fetchone()
            if not row:
                raise HTTPException(404, "Channel not found")
            scope_name = row["name"]
            scope_type, scope_id = "channel", str(channel)
            key, sid = f"channel:{channel}:main-agent", f"agent-channel-{channel}"
            workspace_id = f"channels/channel-{channel}"
            workspace, sandbox_key, cwd = root / workspace_id, key, "/workspace"
        else:
            raise HTTPException(404, "Conversation not found")
        with self.p.db.connect() as conn:
            session = conn.execute("SELECT sid FROM queue_sessions WHERE scope_key=?", (key,)).fetchone()
            if session:
                sid = session[0]
            else:
                conn.execute("INSERT INTO queue_sessions(scope_key,sid) VALUES (?,?)", (key, sid))
            old = conn.execute("SELECT * FROM agent_scopes WHERE scope_key=?", (key,)).fetchone() if kind == "agent" else None
            sandbox_id = old["sandbox_id"] if old else workspace_id.replace("/", "-")
            lifecycle = old["lifecycle_id"] if old and old["lifecycle_id"] else sandbox_key
            if kind == "agent" and not old:
                created = int(time.time())
                conn.execute("INSERT INTO agent_scopes(scope_key,scope_type,scope_id,session_id,lifecycle_id,workspace_path,sandbox_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                             (key, scope_type, scope_id, sid, lifecycle, workspace_id, sandbox_id, created, created))
        ensure_workspace(self.p.settings.data_dir, workspace)
        return {"kind": kind, "scope": scope, "scope_type": scope_type, "scope_id": scope_id,
                "scope_key": key, "sid": sid, "workspace": workspace, "model": model,
                "scope_name": scope_name,
                "owner_user_id": user["id"] if channel is None else None, "channel_id": channel,
                "sandbox": {"scope_key": sandbox_key, "workspace_id": workspace_id, "sandbox_id": sandbox_id,
                            "lifecycle_id": lifecycle, "profile": kind, "cwd": cwd}}

    def insert_message(self, conn, info, user, role, text, metadata):
        if info["kind"] == "chat":
            cursor = conn.execute("INSERT INTO chat_messages(conversation_id,role,content,metadata_json,created_at) VALUES (?,?,?,?,?)",
                                  (info["scope"][5:], role, text, json.dumps(metadata), now()))
            conn.execute("UPDATE chat_conversations SET updated_at=? WHERE id=?", (now(), info["scope"][5:]))
        else:
            cursor = conn.execute("INSERT INTO messages(scope_type,scope_id,author_type,user_id,username,content,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?)",
                                  (info["scope_type"], info["scope_id"], "agent" if role == "assistant" else role,
                                   user["id"], user["username"], text, json.dumps(metadata), int(time.time())))
        return cursor.lastrowid

    def message(self, info, message_id):
        table = "chat_messages" if info["kind"] == "chat" else "messages"
        with self.p.db.connect() as conn:
            row = conn.execute(f"SELECT * FROM {table} WHERE id=?", (message_id,)).fetchone()
        role = row["role"] if info["kind"] == "chat" else {"agent": "assistant"}.get(row["author_type"], row["author_type"])
        metadata = visible_metadata(json.loads(row["metadata_json"]))
        if info["kind"] == "agent" and role == "user":
            metadata.setdefault("author_display_name", row["username"])
            metadata.setdefault("author_user_id", row["user_id"])
        return {"id": row["id"], "role": role, "content": row["content"], "metadata": metadata,
                "created_at": timestamp(row["created_at"]), "attachments": self.p.files.for_message(info, message_id)}

    def messages(self, user, scope, before=None, limit=100):
        info = self.scope(user, scope)
        limit = max(1, min(int(limit), 200))
        table = "chat_messages" if info["kind"] == "chat" else "messages"
        where, args = ("conversation_id=?", [scope[5:]]) if info["kind"] == "chat" else ("scope_type=? AND scope_id=? AND hidden_at IS NULL", [info["scope_type"], info["scope_id"]])
        if before is not None:
            where += " AND id<?"
            args.append(int(before))
        with self.p.db.connect() as conn:
            rows = conn.execute(f"SELECT id FROM {table} WHERE {where} ORDER BY id DESC LIMIT ?", (*args, limit + 1)).fetchall()
        ids = [row[0] for row in rows[:limit]]
        with self.p.db.connect() as conn:
            last_seq = self.starts.get(info["scope_key"])
            if last_seq is None:
                last_seq = conn.execute("SELECT COALESCE(MAX(id),0) FROM queue_events WHERE scope_key=?", (info["scope_key"],)).fetchone()[0]
            compact = conn.execute("SELECT id,payload_json FROM durable_jobs WHERE kind='agent' AND scope_type=? AND scope_id=? AND json_extract(payload_json,'$.operation')='compact' AND json_extract(payload_json,'$.scope')=? ORDER BY id DESC LIMIT 1",
                                   (info["scope_type"], info["scope_id"], scope)).fetchone()
            latest = {"job_id": compact["id"], **json.loads(compact["payload_json"])["compaction"]} if compact else None
        return {"messages": [self.message(info, mid) for mid in reversed(ids)],
                "next_before_id": ids[-1] if len(rows) > limit else None, "last_seq": last_seq, "compaction": latest}

    def emit(self, key, event, conn=None):
        if conn is None:
            with self.p.db.connect() as connection:
                return self.emit(key, event, connection)
        conn.execute("INSERT INTO queue_events(scope_key,event_json,created_at) VALUES (?,?,?)", (key, json.dumps(event), now()))

    def stream_access(self, user, scope):
        required = "chat" if scope.startswith("chat-") else "private_agent" if scope == "private" else "read_workspace"
        if required not in permissions(self.p.db, user):
            raise HTTPException(403, "Permission denied")
        if scope.startswith("chat-"):
            self.conversation(user, scope[5:])
        elif scope.startswith("channel-"):
            with self.p.db.connect() as conn:
                if not conn.execute("SELECT 1 FROM channels WHERE id=? AND archived=0", (scope[8:],)).fetchone():
                    raise HTTPException(404, "Channel not found")

    async def events(self, user, scope, after=0):
        key = self.payload_key({"scope": scope, "user_id": user["id"]})
        while not self.stopping:
            self.stream_access(user, scope)
            with self.p.db.connect() as conn:
                rows = conn.execute("SELECT id,event_json FROM queue_events WHERE scope_key=? AND id>? ORDER BY id LIMIT 100", (key, after)).fetchall()
            for row in rows:
                event = json.loads(row["event_json"])
                event.pop("model", None)
                if isinstance(event.get("message"), dict):
                    event["message"]["metadata"] = visible_metadata(event["message"].get("metadata", {}))
                after = event["seq"] = row["id"]
                yield f"id: {after}\nevent: {event['type']}\ndata: {json.dumps(event)}\n\n".encode()
            if not rows:
                yield b": keepalive\n\n"
                await asyncio.sleep(1)

    async def enqueue(self, user, scope, content, attachment_ids=None, schedule_run_id=None):
        if not isinstance(content, str) or (not content.strip() and not attachment_ids):
            raise HTTPException(400, "Message content is required")
        if len(content.encode()) > 1024 * 1024 or len(attachment_ids or []) > 32:
            raise HTTPException(413, "Message exceeds the Runtime prompt budget")
        info = self.scope(user, scope)
        if info["channel_id"] is not None and "chat" not in permissions(self.p.db, user):
            raise HTTPException(403, "Permission denied")
        async with self.p.gate.admit(), self.lock(info["scope_key"]):
            with self.p.db.connect() as conn:
                if schedule_run_id:
                    existing = conn.execute("SELECT durable_job_id,source_message_id FROM agent_schedule_runs WHERE id=?", (schedule_run_id,)).fetchone()
                    if existing and existing["durable_job_id"] is not None:
                        return {"message": self.message(info, existing["source_message_id"]), "job_id": existing["durable_job_id"]}
                mid = self.insert_message(conn, info, user, "user", content,
                                          {"status": "queued", "author_user_id": user["id"], "author_display_name": user["display_name"]})
                self.p.files.bind(user, info, mid, attachment_ids or [], conn=conn)
                payload = {"user_id": user["id"], "scope": scope, "message_id": mid, "content": content,
                           "attachment_ids": attachment_ids or [], "schedule_run_id": schedule_run_id}
                job = conn.execute("INSERT INTO durable_jobs(kind,scope_type,scope_id,dedupe_key,payload_json,status,created_at,updated_at) VALUES ('agent',?,?,?,?, 'queued',?,?)",
                                   (info["scope_type"], info["scope_id"], str(uuid.uuid4()), json.dumps(payload), int(time.time()), int(time.time()))).lastrowid
                if schedule_run_id:
                    conn.execute("UPDATE agent_schedule_runs SET durable_job_id=?,source_message_id=?,updated_at=? WHERE id=?", (job, mid, int(time.time()), schedule_run_id))
                self.absorb(conn, job, payload, info)
            message = self.message(info, mid)
            self.emit(info["scope_key"], {"type": "message", "message": message})
            if payload.get("parent_job_id"):
                await self.send_inputs(payload["parent_job_id"], info)
            else:
                self.wake(info["scope_key"])
        return {"message": self.message(info, mid), "job_id": job}

    def absorb(self, conn, job_id, payload, info):
        """Attach only while the interactive parent and queue admission remain valid."""
        if payload.get("schedule_run_id") is not None or info["scope_key"] in self.cancelling:
            return False
        parent = conn.execute(
            "SELECT id,payload_json FROM durable_jobs WHERE kind='agent' AND status='running' "
            "AND scope_type=? AND scope_id=? AND json_extract(payload_json,'$.scope')=? "
            "AND json_extract(payload_json,'$.parent_job_id') IS NULL "
            "AND json_extract(payload_json,'$.operation') IS NULL "
            "AND json_extract(payload_json,'$.schedule_run_id') IS NULL ORDER BY id LIMIT 1",
            (info["scope_type"], info["scope_id"], payload["scope"])).fetchone()
        if parent is None:
            return False
        attached = conn.execute(
            "UPDATE durable_jobs SET status='running',payload_json=json_set(payload_json,'$.parent_job_id',?),updated_at=? "
            "WHERE id=? AND status='queued' "
            "AND EXISTS (SELECT 1 FROM durable_jobs WHERE id=? AND status='running') "
            "AND NOT EXISTS (SELECT 1 FROM durable_jobs WHERE kind='agent' AND status='queued' AND id!=? "
            "AND scope_type=? AND scope_id=? AND json_extract(payload_json,'$.scope')=?)",
            (parent["id"], int(time.time()), job_id, parent["id"], job_id,
             info["scope_type"], info["scope_id"], payload["scope"])).rowcount
        if not attached:
            return False
        payload["parent_job_id"] = parent["id"]
        table = "chat_messages" if info["kind"] == "chat" else "messages"
        conn.execute(
            f"UPDATE {table} SET metadata_json=json_set(metadata_json,'$.status','running','$.inserted_into',?,'$.delivery','pending') WHERE id=?",
            (json.loads(parent["payload_json"])["message_id"], payload["message_id"]))
        return True

    def requeue_input(self, conn, job_id, parent_job_id, info):
        """Detach only a still-absorbed input; late HTTP responses cannot revive it."""
        row = conn.execute(
            "UPDATE durable_jobs SET status='queued',payload_json=json_remove(payload_json,'$.parent_job_id','$.steer_sent'),updated_at=? "
            "WHERE id=? AND status='running' AND json_extract(payload_json,'$.parent_job_id')=? RETURNING payload_json",
            (int(time.time()), job_id, parent_job_id)).fetchone()
        if row is None:
            return None
        mid = json.loads(row["payload_json"])["message_id"]
        table = "chat_messages" if info["kind"] == "chat" else "messages"
        conn.execute(
            f"UPDATE {table} SET metadata_json=json_set(json_remove(metadata_json,'$.inserted_into','$.delivery'),'$.status','queued') WHERE id=?",
            (mid,))
        return mid

    async def send_inputs(self, parent_job_id, info):
        """Caller holds the scope lock, preserving acceptance order across senders."""
        with self.p.db.connect() as conn:
            parent = conn.execute("SELECT payload_json FROM durable_jobs WHERE id=? AND status='running'", (parent_job_id,)).fetchone()
            if parent is None:
                return
            run_id = json.loads(parent["payload_json"]).get("runtime_run_id")
            if not run_id or info["scope_key"] in self.cancelling:
                return
            rows = conn.execute(
                "SELECT id,payload_json FROM durable_jobs WHERE status='running' "
                "AND json_extract(payload_json,'$.parent_job_id')=? "
                "AND COALESCE(json_extract(payload_json,'$.steer_sent'),0)=0 ORDER BY id",
                (parent_job_id,)).fetchall()
        for row in rows:
            payload = json.loads(row["payload_json"])
            author = self.user(payload["user_id"])
            prompt = self.p.files.prompt(author, info, payload["attachment_ids"])
            prompt["text"] = payload["content"] + ("\n" + prompt["text"] if prompt["text"] else "")
            with self.p.db.connect() as conn:
                sent = conn.execute(
                    "UPDATE durable_jobs SET payload_json=json_set(payload_json,'$.steer_sent',json('true')),updated_at=? "
                    "WHERE id=? AND status='running' AND json_extract(payload_json,'$.parent_job_id')=? "
                    "AND COALESCE(json_extract(payload_json,'$.steer_sent'),0)=0 "
                    "AND EXISTS (SELECT 1 FROM durable_jobs WHERE id=? AND status='running')",
                    (int(time.time()), row["id"], parent_job_id, parent_job_id)).rowcount
            if not sent:
                continue
            try:
                await self.runtime("POST", f"/v1/runs/{run_id}/steer", json={
                    "input_id": str(row["id"]), "prompt": prompt,
                    "context_prefix": json.dumps({"time": now(), "user": author["display_name"], "tz": author["timezone"]})})
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code not in (404, 409):
                    continue
                with self.p.db.connect() as conn:
                    mid = self.requeue_input(conn, row["id"], parent_job_id, info)
                if mid is not None:
                    self.emit(info["scope_key"], {"type": "message", "message": self.message(info, mid)})
                    self.wake(info["scope_key"])
            except httpx.RequestError:
                # Persisted before submission: an uncertain side effect is never retried.
                continue

    def input_delivered(self, parent_job_id, info, input_id):
        with self.p.db.connect() as conn:
            row = conn.execute(
                "SELECT payload_json FROM durable_jobs WHERE CAST(id AS TEXT)=? AND status='running' "
                "AND json_extract(payload_json,'$.parent_job_id')=?", (input_id, parent_job_id)).fetchone()
            if row is None:
                return None
            mid = json.loads(row["payload_json"])["message_id"]
            table = "chat_messages" if info["kind"] == "chat" else "messages"
            changed = conn.execute(
                f"UPDATE {table} SET metadata_json=json_set(metadata_json,'$.delivery','delivered') "
                "WHERE id=? AND json_extract(metadata_json,'$.delivery')='pending'", (mid,)).rowcount
        if not changed:
            return None
        self.emit(info["scope_key"], {"type": "message", "message": self.message(info, mid)})
        return {"type": "input_delivered", "message_id": mid}

    def settle_inputs(self, conn, parent_job_id, info, status, error=None):
        rows = conn.execute(
            "SELECT id,payload_json FROM durable_jobs WHERE status='running' "
            "AND json_extract(payload_json,'$.parent_job_id')=? ORDER BY id", (parent_job_id,)).fetchall()
        table = "chat_messages" if info["kind"] == "chat" else "messages"
        mids = []
        for row in rows:
            mid = json.loads(row["payload_json"])["message_id"]
            metadata = json.loads(conn.execute(f"SELECT metadata_json FROM {table} WHERE id=?", (mid,)).fetchone()[0])
            if status == "completed" and metadata["delivery"] != "delivered":
                self.requeue_input(conn, row["id"], parent_job_id, info)
            else:
                metadata["status"] = status
                if error:
                    metadata["error"] = error
                conn.execute(f"UPDATE {table} SET metadata_json=? WHERE id=?", (json.dumps(metadata), mid))
                conn.execute("UPDATE durable_jobs SET status=?,last_error=?,updated_at=? WHERE id=?",
                             ("succeeded" if status == "completed" else "failed", error or "", int(time.time()), row["id"]))
            mids.append(mid)
        return mids

    def wake(self, key):
        if not self.stopping and not getattr(self.p.gate, "reserved", None) and key not in self.tasks:
            self.tasks[key] = asyncio.create_task(self.worker(key))

    def resume(self):
        with self.p.db.connect() as conn:
            rows = conn.execute("SELECT payload_json FROM durable_jobs WHERE kind='agent' AND status='queued' ORDER BY id").fetchall()
        for row in rows:
            self.wake(self.payload_key(json.loads(row[0])))
        for key in self.unsettled:
            self.wake(key)

    def user(self, uid):
        with self.p.db.connect() as conn:
            row = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if not row:
            raise HTTPException(404, "User not found")
        return dict(row)

    def pending(self, key):
        with self.p.db.connect() as conn:
            rows = conn.execute("SELECT * FROM durable_jobs WHERE kind='agent' AND status='queued' ORDER BY id").fetchall()
        for row in rows:
            payload = json.loads(row["payload_json"])
            if self.payload_key(payload) == key:
                return dict(row), payload
        return None

    @staticmethod
    def payload_key(payload):
        scope = payload.get("scope", "")
        if scope == "private":
            return f"private:{payload['user_id']}"
        if scope.startswith("channel-"):
            return f"channel:{scope[8:]}:main-agent"
        return scope

    async def start(self):
        self.stopping = False
        with self.p.db.connect() as conn:
            rows = conn.execute("SELECT * FROM durable_jobs WHERE kind='agent' AND (status IN ('running','queued') OR json_extract(payload_json,'$.runtime_unsettled')=1) ORDER BY id").fetchall()
        for row in rows:
            payload = json.loads(row["payload_json"])
            if payload.get("parent_job_id"):
                # Recovery settles linked inputs with their parent, never as turns.
                continue
            if not payload.get("scope") and payload.get("user_message"):
                with self.p.db.connect() as conn:
                    message = conn.execute("SELECT * FROM messages WHERE id=?", (payload["user_message"]["id"],)).fetchone()
                    schedule = conn.execute("SELECT id FROM agent_schedule_runs WHERE durable_job_id=?", (row["id"],)).fetchone()
                    if message:
                        payload = {"user_id": payload["actor"]["id"],
                                   "scope": "private" if message["scope_type"] == "private" else "channel-" + message["scope_id"],
                                   "message_id": message["id"], "content": message["content"],
                                   "attachment_ids": [a[0] for a in conn.execute("SELECT id FROM attachments WHERE message_id=?", (message["id"],))],
                                   "schedule_run_id": schedule[0] if schedule else None}
                        conn.execute("UPDATE durable_jobs SET payload_json=? WHERE id=?", (json.dumps(payload), row["id"]))
            key = self.payload_key(payload)
            if row["status"] == "running" and key and not payload.get("runtime_sid"):
                info = self.scope(self.user(payload["user_id"]), payload["scope"], authorize=False)
                payload.update(runtime_sid=info["sid"], runtime_unsettled=True)
                with self.p.db.connect() as conn:
                    conn.execute("UPDATE durable_jobs SET payload_json=? WHERE id=?", (json.dumps(payload), row["id"]))
            if payload.get("runtime_unsettled"):
                self.unsettled[key] = (row["id"], payload)
            if row["status"] == "running" or not key:
                await self.interrupt(dict(row), payload, "Platform restarted; execution was not replayed")
            self.wake(key)

    async def stop(self):
        self.stopping = True
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def runtime(self, method, path, **kwargs):
        response = await self.p.http.request(method, self.p.settings.runtime_url.rstrip("/") + path,
                                             headers={"Authorization": f"Bearer {self.p.settings.runtime_token}"}, **kwargs)
        response.raise_for_status()
        return response.json()

    async def selected_model(self, info):
        catalog = await self.p.oauth.catalog()
        if not info["model"]["id"]:
            if not catalog["models"]:
                raise HTTPException(409, "No executable model is available")
            info["model"]["id"] = catalog["models"][0]["id"]
        selected = next((model for model in catalog["models"] if model["id"] == info["model"]["id"]), {})
        for field in ("contextWindow", "maxTokens"):
            value = selected.get(field)
            if isinstance(value, int) and not isinstance(value, bool) and value > 0:
                info["model"][field] = value
        return info["model"]

    async def settle(self, key):
        while key in self.unsettled:
            job_id, payload = self.unsettled[key]
            try:
                await self.runtime("POST", f"/v1/sessions/{payload['runtime_sid']}/cancel", timeout=35)
            except Exception:
                # Cancellation is idempotent. Only settlement is retried, never a prompt.
                await asyncio.sleep(1)
                continue
            payload["runtime_unsettled"] = False
            with self.p.db.connect() as conn:
                conn.execute("UPDATE durable_jobs SET payload_json=? WHERE id=?", (json.dumps(payload), job_id))
            self.unsettled.pop(key, None)

    def resources(self, info):
        with self.p.db.connect() as conn:
            row = conn.execute("SELECT value FROM settings WHERE key='ui_branding_v1'").fetchone()
        branding = json.loads(row[0]) if row else {}
        prompt = f"You are {branding.get('agent_name', 'Assistant')}, the assistant in {branding.get('product_name', 'Agent Platform')}. "
        prompt += f"Use your available tools to help the user. Deliver files with a standalone MEDIA: {info['sandbox']['cwd']}/path line."
        agents, skills = None, []
        if info["kind"] == "agent":
            prompt += " Maintain lasting workspace guidance in AGENTS.md. Use advertised skills when relevant."
            try:
                content = bounded_read(open_workspace(info["workspace"], "AGENTS.md")).decode("utf-8")
                agents = {"path": "/workspace/AGENTS.md", "content": content}
            except (OSError, HTTPException, UnicodeError):
                pass
            try:
                directory = open_workspace(info["workspace"], ".agent-platform/skills", directory=True)
            except (OSError, HTTPException):
                names = []
            else:
                try:
                    names = sorted(os.listdir(directory))
                finally:
                    os.close(directory)
            for skill_name in names:
                relative = f".agent-platform/skills/{skill_name}/SKILL.md"
                try:
                    text = bounded_read(open_workspace(info["workspace"], relative)).decode("utf-8")
                except (OSError, HTTPException, UnicodeError):
                    continue
                metadata = {}
                if text.startswith("---\n"):
                    for line in text.split("---", 2)[1].splitlines():
                        name, _, value = line.partition(":")
                        metadata[name.strip()] = value.strip().strip("\"'")
                skills.append({"name": metadata.get("name", skill_name), "description": metadata.get("description", ""),
                               "path": "/workspace/" + relative})
        return {"system_prompt": prompt, "agents_md": agents, "skills": skills}

    async def worker(self, key):
        try:
            while not self.stopping:
                await self.settle(key)
                async with self.p.gate.admit(), self.lock(key):
                    pending = self.pending(key)
                    if not pending:
                        return
                    job, payload = pending
                    with self.p.db.connect() as conn:
                        self.starts[key] = conn.execute("SELECT COALESCE(MAX(id),0) FROM queue_events WHERE scope_key=?", (key,)).fetchone()[0]
                        conn.execute("UPDATE durable_jobs SET status='running',attempts=attempts+1,updated_at=? WHERE id=?", (int(time.time()), job["id"]))
                        if payload.get("schedule_run_id"):
                            conn.execute("UPDATE agent_schedule_runs SET status='running',started_at=?,updated_at=? WHERE id=?",
                                         (int(time.time()), int(time.time()), payload["schedule_run_id"]))
                work = _WorkTrace()
                try:
                    user = self.user(payload["user_id"])
                    if not user["active"]:
                        raise HTTPException(403, "User is inactive")
                    info = self.scope(user, payload["scope"])
                    if payload.get("operation") == "compact":
                        await self.execute_compact(job, payload, user, info)
                        continue
                    with self.p.db.connect() as conn:
                        table = "chat_messages" if info["kind"] == "chat" else "messages"
                        metadata = json.loads(conn.execute(f"SELECT metadata_json FROM {table} WHERE id=?", (payload["message_id"],)).fetchone()[0])
                        metadata["status"] = "running"
                        conn.execute(f"UPDATE {table} SET metadata_json=? WHERE id=?", (json.dumps(metadata), payload["message_id"]))
                    self.emit(key, {"type": "message", "message": self.message(info, payload["message_id"])})
                    await self.selected_model(info)
                    prompt = self.p.files.prompt(user, info, payload["attachment_ids"])
                    prompt["text"] = payload["content"] + ("\n" + prompt["text"] if prompt["text"] else "")
                    tools = BUILTINS + (["browser", "schedule", "mcp"] if info["kind"] == "agent" and info["channel_id"] is None else [])
                    payload.update(runtime_sid=info["sid"], runtime_unsettled=True)
                    with self.p.db.connect() as conn:
                        conn.execute("UPDATE durable_jobs SET payload_json=? WHERE id=?", (json.dumps(payload), job["id"]))
                    self.unsettled[key] = (job["id"], payload)
                    result = await self.runtime("POST", f"/v1/sessions/{info['sid']}/runs", json={
                        "kind": info["kind"], "sandbox": info["sandbox"], "model": info["model"], "prompt": prompt,
                        "context_prefix": json.dumps({"time": now(), "user": user["display_name"], "tz": user["timezone"]}),
                        "resources": self.resources(info), "tools": tools})
                    run_id = result["run_id"]
                    payload["runtime_run_id"] = run_id
                    with self.p.db.connect() as conn:
                        conn.execute("UPDATE durable_jobs SET payload_json=? WHERE id=?", (json.dumps(payload), job["id"]))
                    self.running[key] = run_id
                    if key in self.cancelling:
                        await self.runtime("POST", f"/v1/runs/{run_id}/cancel")
                    else:
                        async with self.lock(key):
                            await self.send_inputs(job["id"], info)
                    ended = False
                    async with self.p.http.stream("GET", self.p.settings.runtime_url.rstrip("/") + f"/v1/runs/{run_id}/events?after=0",
                                                  headers={"Authorization": f"Bearer {self.p.settings.runtime_token}"}, timeout=None) as response:
                        response.raise_for_status()
                        async for line in response.aiter_lines():
                            if not line.startswith("data:"):
                                continue
                            event = json.loads(line[5:].strip())
                            event.pop("seq", None)
                            if event["type"] == "input_delivered":
                                event = self.input_delivered(job["id"], info, event.get("input_id"))
                                if event is None:
                                    continue
                            work.add(event)
                            if event["type"] == "run_end":
                                payload["runtime_unsettled"] = False
                                self.unsettled.pop(key, None)
                                await self.finish(job, payload, user, info, event, work)
                                ended = True
                                break
                            self.emit(key, event)
                    if not ended:
                        raise RuntimeError("Runtime event stream ended without run_end")
                except asyncio.CancelledError:
                    await self.interrupt(job, payload, "Platform stopped; execution was not replayed", work)
                    raise
                except Exception as exc:
                    await self.interrupt(job, payload, str(exc), work)
                finally:
                    self.running.pop(key, None)
                    self.cancelling.discard(key)
                    self.starts.pop(key, None)
        finally:
            self.cancelling.discard(key)
            self.tasks.pop(key, None)

    async def finish(self, job, payload, user, info, event, work=None):
        if payload.get("parent_job_id"):
            return
        event.pop("undelivered_inputs", None)
        if payload.get("operation") == "compact":
            self.finish_compact(job, payload, event["status"], error=event.get("error"))
            return
        status = event["status"]
        if status == "failed":
            status = event["status"] = "interrupted"
        metadata = {"status": status}
        if event.get("error"):
            metadata["error"] = event["error"]
        assistant_metadata = {**metadata, "reply_to": {"message_id": payload["message_id"]}}
        if work is not None and (trace := work.finish()):
            assistant_metadata["work"] = trace
        with self.p.db.connect() as conn:
            # Acquire the write lock by settling the parent FIRST. Absorption's
            # conditional update can therefore never attach to a finished job.
            changed = conn.execute(
                "UPDATE durable_jobs SET status=?,payload_json=?,last_error=?,updated_at=? "
                "WHERE id=? AND status IN ('queued','running')",
                ("succeeded" if status == "completed" else "failed", json.dumps(payload),
                 event.get("error", ""), int(time.time()), job["id"])).rowcount
            if not changed:
                return
            child_mids = self.settle_inputs(conn, job["id"], info, status, event.get("error"))
            mid = self.insert_message(conn, info, user, "assistant", event.get("text", ""), assistant_metadata)
            table = "chat_messages" if info["kind"] == "chat" else "messages"
            old_metadata = json.loads(conn.execute(f"SELECT metadata_json FROM {table} WHERE id=?", (payload["message_id"],)).fetchone()[0])
            conn.execute(f"UPDATE {table} SET metadata_json=? WHERE id=?", (json.dumps({**old_metadata, **metadata}), payload["message_id"]))
            usage = event.get("usage", {})
            conn.execute("INSERT INTO token_usage_events(user_id,username,display_name,scope_type,scope_id,scope_name,request_message_id,response_message_id,provider,model,input_tokens,output_tokens,total_tokens,raw_usage_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                         (user["id"], user["username"], user["display_name"], info["scope_type"], info["scope_id"], info["scope_name"],
                          payload["message_id"], mid, "openai-codex", event.get("model", info["model"]["id"]), usage.get("input", 0), usage.get("output", 0), usage.get("total", 0),
                          json.dumps({**usage, "kind": info["kind"], "cacheRead": usage.get("cache_read", 0), "cacheWrite": usage.get("cache_write", 0)}), int(time.time())))
            if payload.get("schedule_run_id"):
                conn.execute("UPDATE agent_schedule_runs SET status=?,response_message_id=?,finished_at=?,error=?,updated_at=? WHERE id=?",
                             ("succeeded" if status == "completed" else "failed", mid, int(time.time()), event.get("error", ""), int(time.time()), payload["schedule_run_id"]))
        self.emit(info["scope_key"], {"type": "message", "message": self.message(info, payload["message_id"])})
        for child_mid in child_mids:
            self.emit(info["scope_key"], {"type": "message", "message": self.message(info, child_mid)})
        try:
            await self.p.files.deliver(user, info, mid, event.get("text", ""))
        except Exception as exc:
            event["error"] = assistant_metadata["error"] = f"File delivery failed: {exc}"
            event["status"] = assistant_metadata["status"] = "interrupted"
            failed_mids = []
            with self.p.db.connect() as conn:
                conn.execute("UPDATE durable_jobs SET status='failed',last_error=?,updated_at=? WHERE id=?",
                             (event["error"], int(time.time()), job["id"]))
                conn.execute(f"UPDATE {table} SET metadata_json=? WHERE id=?", (json.dumps(assistant_metadata), mid))
                conn.execute(f"UPDATE {table} SET metadata_json=json_set(metadata_json,'$.status','interrupted','$.error',?) WHERE id=?",
                             (event["error"], payload["message_id"]))
                # File delivery can fail after the run's terminal settlement. Children
                # cannot execute while this worker is finishing their parent.
                for child_mid in child_mids:
                    changed = conn.execute(
                        "UPDATE durable_jobs SET status='failed',last_error=?,updated_at=?,"
                        "payload_json=json_set(payload_json,'$.parent_job_id',?) "
                        "WHERE kind='agent' AND (status IN ('queued','succeeded') OR "
                        "(status='failed' AND json_extract(payload_json,'$.parent_job_id')=?)) "
                        "AND scope_type=? AND scope_id=? "
                        "AND json_extract(payload_json,'$.scope')=? AND json_extract(payload_json,'$.message_id')=?",
                        (event["error"], int(time.time()), job["id"], job["id"], info["scope_type"], info["scope_id"],
                         payload["scope"], child_mid)).rowcount
                    if changed:
                        conn.execute(
                            f"UPDATE {table} SET metadata_json=json_set(metadata_json,'$.status','interrupted','$.error',?,"
                            "'$.inserted_into',?,'$.delivery',COALESCE(json_extract(metadata_json,'$.delivery'),'pending')) WHERE id=?",
                            (event["error"], payload["message_id"], child_mid))
                        failed_mids.append(child_mid)
            for changed_mid in [payload["message_id"], *failed_mids]:
                self.emit(info["scope_key"], {"type": "message", "message": self.message(info, changed_mid)})
        event["message"] = self.message(info, mid)
        self.emit(info["scope_key"], event)

    async def interrupt(self, job, payload, error, work=None):
        if payload.get("operation") == "compact":
            status = "cancelled" if self.payload_key(payload) in self.cancelling else "interrupted"
            self.finish_compact(job, payload, status, error=error)
            return
        if self.payload_key(payload):
            user = self.user(payload["user_id"])
            info = self.scope(user, payload["scope"], authorize=False)
            await self.finish(job, payload, user, info, {"type": "run_end", "status": "interrupted", "text": "", "error": error, "usage": {}}, work)
        else:
            with self.p.db.connect() as conn:
                conn.execute("UPDATE durable_jobs SET status='failed',last_error=?,updated_at=? WHERE id=?", (error, int(time.time()), job["id"]))

    async def cancel(self, user, scope):
        info = self.scope(user, scope)
        if info["channel_id"] is not None and "chat" not in permissions(self.p.db, user):
            raise HTTPException(403, "Permission denied")
        async with self.p.gate.admit(), self.lock(info["scope_key"]):
            if info["scope_key"] in self.tasks:
                self.cancelling.add(info["scope_key"])
            while pending := self.pending(info["scope_key"]):
                job, payload = pending
                await self.finish(job, payload, self.user(payload["user_id"]), info,
                                  {"type": "run_end", "status": "cancelled", "text": "", "usage": {}})
            run_id = self.running.get(info["scope_key"])
            unsettled = self.unsettled.get(info["scope_key"])
            if unsettled and unsettled[1].get("operation") == "compact":
                await self.runtime("POST", f"/v1/sessions/{unsettled[1]['runtime_sid']}/cancel", timeout=35)
            if run_id:
                await self.runtime("POST", f"/v1/runs/{run_id}/cancel")
        return {"ok": True}

    async def compact(self, user, scope):
        info = self.scope(user, scope)
        if info["channel_id"] is not None and "chat" not in permissions(self.p.db, user):
            raise HTTPException(403, "Permission denied")
        async with self.p.gate.admit(), self.lock(info["scope_key"]):
            payload = {"operation": "compact", "user_id": user["id"], "scope": scope,
                       "compaction": {"status": "queued"}}
            with self.p.db.connect() as conn:
                job_id = conn.execute("INSERT INTO durable_jobs(kind,scope_type,scope_id,dedupe_key,payload_json,status,created_at,updated_at) VALUES ('agent',?,?,?,?, 'queued',?,?)",
                                      (info["scope_type"], info["scope_id"], str(uuid.uuid4()), json.dumps(payload), int(time.time()), int(time.time()))).lastrowid
                self.emit(info["scope_key"], {"type": "compaction", "phase": "queued", "job_id": job_id, "status": "queued"}, conn)
            self.wake(info["scope_key"])
        return {"ok": True, "job_id": job_id, "status": "queued"}

    def compaction_anchor(self, conn, job_id, scope):
        """The message a manual compaction follows: the newest message except user messages queued behind it (FIFO)."""
        scope_type, scope_id = conn.execute("SELECT scope_type,scope_id FROM durable_jobs WHERE id=?", (job_id,)).fetchone()
        later = [row[0] for row in conn.execute(
            "SELECT json_extract(payload_json,'$.message_id') FROM durable_jobs WHERE id>? AND scope_type=? AND scope_id=? "
            "AND json_extract(payload_json,'$.scope')=? AND json_extract(payload_json,'$.message_id') IS NOT NULL",
            (job_id, scope_type, scope_id, scope))]
        exclude = f" AND id NOT IN ({','.join('?' * len(later))})" if later else ""
        if scope.startswith("chat-"):
            row = conn.execute(f"SELECT MAX(id) FROM chat_messages WHERE conversation_id=?{exclude}", (scope[5:], *later)).fetchone()
        else:
            row = conn.execute(f"SELECT MAX(id) FROM messages WHERE scope_type=? AND scope_id=? AND hidden_at IS NULL{exclude}",
                               (scope_type, scope_id, *later)).fetchone()
        return row[0]

    def finish_compact(self, job, payload, status, reason=None, error=None, accounting=None):
        """Commit the manual-operation outcome and its actual usage together."""
        started = payload.get("compaction") or {}
        result = {"status": status}
        if reason:
            result["reason"] = reason
        if error:
            result["error"] = error
        with self.p.db.connect() as conn:
            state = conn.execute("SELECT status FROM durable_jobs WHERE id=?", (job["id"],)).fetchone()[0]
            if state not in ("queued", "running"):
                return
            # Keep the place recorded at start; an operation settled without starting is placed where it settled.
            result["after_message_id"] = (started["after_message_id"] if "after_message_id" in started
                                          else self.compaction_anchor(conn, job["id"], payload["scope"]))
            payload["compaction"] = result
            conn.execute("UPDATE durable_jobs SET status=?,payload_json=?,last_error=?,updated_at=? WHERE id=?",
                         ("succeeded" if status in ("done", "nothing_to_compact") else "failed",
                          json.dumps(payload), error or "", int(time.time()), job["id"]))
            if accounting is not None:
                conn.execute("INSERT INTO token_usage_events(user_id,username,display_name,scope_type,scope_id,scope_name,request_message_id,response_message_id,provider,model,input_tokens,output_tokens,total_tokens,raw_usage_json,created_at) VALUES (?,?,?,?,?,?,NULL,NULL,?,?,?,?,?,?,?)", accounting)
            self.emit(self.payload_key(payload), {"type": "compaction", "phase": "end", "job_id": job["id"], **result}, conn)

    async def execute_compact(self, job, payload, user, info):
        if info["channel_id"] is not None and "chat" not in permissions(self.p.db, user):
            raise HTTPException(403, "Permission denied")
        model = await self.selected_model(info)
        key = info["scope_key"]
        if key in self.cancelling:
            self.finish_compact(job, payload, "cancelled")
            return
        with self.p.db.connect() as conn:
            anchor = self.compaction_anchor(conn, job["id"], payload["scope"])
            payload.update(runtime_sid=info["sid"], runtime_unsettled=True, compaction={"status": "compacting", "after_message_id": anchor})
            conn.execute("UPDATE durable_jobs SET payload_json=? WHERE id=?", (json.dumps(payload), job["id"]))
            self.emit(key, {"type": "compaction", "phase": "start", "job_id": job["id"], "status": "compacting", "after_message_id": anchor}, conn)
        self.unsettled[key] = (job["id"], payload)
        result = await self.runtime("POST", f"/v1/sessions/{info['sid']}/compact", json={"model": model}, timeout=900)
        if result.get("compacted") is True:
            status, reason = "done", None
        elif result.get("compacted") is False and result.get("reason") == "too_small":
            status, reason = "nothing_to_compact", "too_small"
        else:
            raise RuntimeError("Runtime returned an invalid compaction outcome")
        payload["runtime_unsettled"] = False
        self.unsettled.pop(key, None)
        accounting = None
        if status == "done" and result.get("usage") is not None:
            usage = result["usage"]
            accounting = (user["id"], user["username"], user["display_name"], info["scope_type"], info["scope_id"], info["scope_name"],
                          "openai-codex", result.get("model", model["id"]), usage.get("input", 0), usage.get("output", 0), usage.get("total", 0),
                          json.dumps({**usage, "kind": "compaction", "cacheRead": usage.get("cache_read", 0), "cacheWrite": usage.get("cache_write", 0)}), int(time.time()))
        self.finish_compact(job, payload, "cancelled" if key in self.cancelling else status, reason=reason, accounting=accounting)

    async def reset(self, user, scope):
        info = self.scope(user, scope)
        if info["channel_id"] is not None and "chat" not in permissions(self.p.db, user):
            raise HTTPException(403, "Permission denied")
        async with self.p.gate.admit(), self.lock(info["scope_key"]):
            if info["scope_key"] in self.tasks:
                raise HTTPException(409, "Cancel active work before resetting")
            await self.runtime("DELETE", f"/v1/sessions/{info['sid']}")
            with self.p.db.connect() as conn:
                conn.execute("UPDATE queue_sessions SET sid=? WHERE scope_key=?", (info["sid"] + "-" + uuid.uuid4().hex, info["scope_key"]))
                conn.execute("UPDATE messages SET hidden_at=? WHERE scope_type=? AND scope_id=? AND hidden_at IS NULL", (int(time.time()), info["scope_type"], info["scope_id"]))
                conn.execute("DELETE FROM queue_events WHERE scope_key=?", (info["scope_key"],))
        return {"ok": True}


async def chats(request):
    user = current_user(request)
    p = request.app.state.platform
    if "chat" not in permissions(p.db, user):
        raise HTTPException(403, "Permission denied")
    if request.method == "GET":
        with p.db.connect() as conn:
            rows = conn.execute("SELECT * FROM chat_conversations WHERE user_id=? AND deleted_at IS NULL ORDER BY updated_at DESC", (user["id"],)).fetchall()
        return JSONResponse({"conversations": [dict(row) for row in rows]})
    body = await body_json(request)
    if set(body) - {"title"}:
        raise HTTPException(400, "Unknown conversation field")
    title = body.get("title", "New chat")
    if not isinstance(title, str) or not title.strip():
        raise HTTPException(400, "Title is required")
    cid = str(uuid.uuid4())
    async with p.gate.admit():
        with p.db.connect() as conn:
            conn.execute("INSERT INTO chat_conversations(id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?)", (cid, user["id"], title, now(), now()))
        p.queue.scope(user, "chat-" + cid)
    return JSONResponse({"conversation": p.queue.conversation(user, cid)}, status_code=201)


async def chat(request):
    user = current_user(request)
    p = request.app.state.platform
    cid = request.path_params["id"]
    conversation = p.queue.conversation(user, cid)
    if "chat" not in permissions(p.db, user):
        raise HTTPException(403, "Permission denied")
    if request.method == "GET":
        return JSONResponse({"conversation": conversation})
    info = p.queue.scope(user, "chat-" + cid)
    async with p.gate.admit(), p.queue.lock(info["scope_key"]):
        if info["scope_key"] in p.queue.tasks:
            raise HTTPException(409, "Cancel active work before changing the conversation")
        if request.method == "DELETE":
            await p.queue.runtime("DELETE", f"/v1/sessions/{info['sid']}")
            with p.db.connect() as conn:
                conn.execute("UPDATE chat_conversations SET deleted_at=?,updated_at=? WHERE id=?", (now(), now(), cid))
            shutil.rmtree(info["workspace"])
            return JSONResponse({"ok": True})
        body = await body_json(request)
        if set(body) - {"title"}:
            raise HTTPException(400, "Unknown conversation field")
        title = body.get("title", conversation["title"])
        if not isinstance(title, str) or not title.strip():
            raise HTTPException(400, "Title is required")
        with p.db.connect() as conn:
            conn.execute("UPDATE chat_conversations SET title=?,updated_at=? WHERE id=?", (title, now(), cid))
    return JSONResponse({"conversation": p.queue.conversation(user, cid)})


async def authenticated_events(request, scope, after):
    queue = request.app.state.platform.queue
    try:
        user = current_user(request)
    except HTTPException:
        return
    stream = queue.events(user, scope, after)
    try:
        async for chunk in stream:
            user = current_user(request)
            queue.stream_access(user, scope)
            yield chunk
    except HTTPException:
        return
    finally:
        await stream.aclose()


async def conversation_route(request):
    user = current_user(request)
    queue = request.app.state.platform.queue
    scope = "chat-" + request.path_params["id"] if "id" in request.path_params else request.path_params["scope"]
    action = request.url.path.rsplit("/", 1)[-1]
    if action == "messages":
        if request.method == "POST":
            body = await request.json()
            return JSONResponse(await queue.enqueue(user, scope, body.get("content"), body.get("attachment_ids")), status_code=202)
        return JSONResponse(queue.messages(user, scope, request.query_params.get("before"), request.query_params.get("limit", 100)))
    if action == "events":
        queue.scope(user, scope)
        after = int(request.headers.get("last-event-id", request.query_params.get("after", "0")))
        return StreamingResponse(authenticated_events(request, scope, after), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
    return JSONResponse(await getattr(queue, action)(user, scope), status_code=202 if action == "compact" else 200)


def routes():
    result = [Route("/api/chat/conversations", chats, methods=["GET", "POST"]),
              Route("/api/chat/conversations/{id}", chat, methods=["GET", "PATCH", "DELETE"])]
    for prefix in ("/api/conversations/{scope}", "/api/chat/conversations/{id}"):
        for action in ("messages", "events", "cancel", "compact", "reset"):
            if prefix.startswith("/api/chat") and action == "reset":
                continue
            methods = ["GET", "POST"] if action == "messages" else ["GET"] if action == "events" else ["POST"]
            result.append(Route(prefix + "/" + action, conversation_route, methods=methods))
    return result
