"""Durable conversations with mid-run inputs; uncertain execution is never replayed."""
import asyncio
import html
import json
import math
import shutil
import time
import uuid
from datetime import datetime, timezone

import httpx

from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route

from .artifacts import scope_ref
from .auth import body_json, current_user, model_choice, permissions
from .db import now
from .files import bounded_read, ensure_workspace, open_workspace
from .skills import skill_guidance


BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search", "web_fetch", "artifact"]


def artifact_guidance(cwd, personal=False):
    """System prompt section, every scope: what to publish as an artifact, what to deliver as a download, the self-check
    before delivery; the personal AI also learns live previews."""
    return ("Publish what the user should look at with the `artifact` tool (action publish, an absolute path under "
            f"{cwd}/): documents and reports (Markdown), Office files (DOCX, XLSX, PPTX) and PDF, web pages, complete multi-file websites (publish the folder; its entry "
            "defaults to index.html), slides as HTML, diagrams (Mermaid .mmd or SVG), charts (an HTML page using any chart library) "
            "and tables (CSV). A standalone "
            f"MEDIA: {cwd}/path line on a DOCX, XLSX, PPTX, PDF, HTML, Markdown, SVG, Mermaid or CSV file publishes it the same way; any other file "
            "(archives, images, code) is only a download. Keep the same path when you revise something: that creates a new version the user can compare, so do not "
            "create v2/v3 copies. "
            "Self-check before you say you are done: after publishing or revising HTML pages, slides, sites or Office files, call `artifact` with "
            "action view (path or id, optional page, width, height, full_page) to look at screenshots of what you built (ids are shown in publish, list and preview results), check for "
            "overlapping or cut-off text, overflow, broken images and console errors, fix them and republish. DOCX, XLSX and PPTX are drawn by the "
            "platform's own viewer, so the screenshot approximates how they open (fonts and effects can differ from Office); PDFs cannot be viewed with it. "
            "For a long deck, view it at the deck's intended size (width and height)."
            + (" To let the user watch a dev server, call `artifact` with action preview (service, port, path, base_aware) FIRST: it returns the "
               "base path (stable for that service) and framework guidance; then start or restart the named background service (bash with name "
               "and port, listening on 0.0.0.0) configured with that base path. Restarting the service keeps the same preview URL." if personal else ""))


FEEDBACK_KINDS = ('element', 'region', 'quote')
MAX_FEEDBACK = 5
FEEDBACK_TEXT = 1000
# What users see of a conversation; `title_state` is server-side bookkeeping for generated titles.
CONVERSATION_FIELDS = ("id", "user_id", "title", "created_at", "updated_at", "deleted_at")
CONVERSATION_COLUMNS = ",".join(CONVERSATION_FIELDS)


def feedback_prefix(items):
    """The escaped `<artifact-feedback>` block that opens a prompt carrying annotate feedback; page text is data, not markup."""
    if not items:
        return ''
    def value(text):
        return html.escape(' '.join(str(text).split()), quote=True)
    lines = ['<artifact-feedback>']
    for item in items:
        parts = [f'artifact="{value(item["artifact_path"])}"', f'version="{item["version"] if item["version"] is not None else "live"}"']
        for key in ('path', 'kind', 'selector', 'text'):
            if item.get(key) is not None:
                parts.append(f'{"page" if key == "path" else key}="{value(item[key])}"')
        lines.append('- ' + ' '.join(parts))
    lines.append('</artifact-feedback>')
    return '\n'.join(lines) + '\n'


def timestamp(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat() if isinstance(value, (int, float)) else value


def visible_metadata(metadata):
    """Message metadata as users see it: no legacy model-usage keys."""
    return {key: value for key, value in metadata.items() if key not in ("generation", "token_usage")}


WORK_TRACE_BYTES = 256 * 1024
"""A work trace's JSON size bound (raised from 96 KiB when edit/write items gained patches)."""
WORK_PATCH_BYTES = 24 * 1024
"""Per edit/write item: the unified patch is kept in whole lines up to this many bytes of JSON."""


class _WorkTrace:
    """A bounded, per-run display record, never a Runtime transcript."""

    def __init__(self):
        started = datetime.now(timezone.utc).isoformat(timespec="microseconds")
        self.data = {"v": 1, "started_at": started, "ended_at": started,
                     "items": [], "truncated": False}
        # JSON size of each item, parallel to data["items"], so a bound check
        # re-encodes only the changed item rather than the whole trace.
        self.sizes = []
        self.last_boundary_position = 0
        self.previous = None
        self.thinking = None

    def size(self):
        """len(json.dumps(self.data).encode("utf-8")): ASCII-escaped JSON, items joined by ", "."""
        return len(json.dumps({**self.data, "items": []})) + sum(self.sizes) + 2 * max(0, len(self.sizes) - 1)

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

    def bounded_patch(self, value):
        """The patch in whole lines up to WORK_PATCH_BYTES of JSON, and whether it was cut."""
        size = 2
        kept = []
        for line in value.splitlines(keepends=True):
            size += len(json.dumps(line).encode("utf-8")) - 2
            if size > WORK_PATCH_BYTES:
                self.data["truncated"] = True
                return "".join(kept), True
            kept.append(line)
        return value, False

    def store(self, item, index=None):
        items = self.data["items"]
        if index is None and item["type"] == "input":
            # Delivery boundaries must survive a full trace. Make space by
            # evicting other work, never an already delivered user input.
            items.append(item)
            self.sizes.append(len(json.dumps(item)))
            while (len(items) > 200 or self.size() +
                   sum(40 for entry in items if entry["type"] in ("tool", "thinking") and
                       entry.get("ended_at", "") is None) > WORK_TRACE_BYTES):
                self.data["truncated"] = True
                victim = next((i for i, entry in enumerate(items) if entry["type"] != "input"), None)
                if victim is None:
                    break
                items.pop(victim)
                self.sizes.pop(victim)
                if victim < self.last_boundary_position:
                    self.last_boundary_position -= 1
            return True
        if index is None and len(items) >= 200:
            self.data["truncated"] = True
            return False
        size = len(json.dumps(item))
        if index is None:
            items.append(item)
            self.sizes.append(size)
        else:
            old, old_size = items[index], self.sizes[index]
            items[index], self.sizes[index] = item, size
        # Reserve timestamp space for unfinished tools and thinking blocks.
        reserve = sum(40 for entry in items if entry["type"] in ("tool", "thinking") and
                      entry.get("ended_at", "") is None)
        if self.size() + reserve > WORK_TRACE_BYTES:
            if index is None:
                items.pop()
                self.sizes.pop()
            else:
                items[index], self.sizes[index] = old, old_size
            self.data["truncated"] = True
            return False
        return True

    def add(self, event):
        kind = event["type"]
        items = self.data["items"]
        if kind == "thinking_start":
            self.thinking = {"type": "thinking", "text": "",
                             "started_at": datetime.now(timezone.utc).isoformat(timespec="microseconds"),
                             "ended_at": None}
            self.store(self.thinking)
            self.previous = "thinking"
        elif kind == "thinking_end":
            for index, entry in enumerate(items):
                if entry is self.thinking:
                    self.store({**entry, "ended_at": datetime.now(timezone.utc).isoformat(timespec="microseconds")},
                               index)
                    break
            self.thinking = None
            self.previous = None
        elif kind in ("thinking_delta", "text_delta"):
            text = event.get("delta", "")
            if not text:
                return
            item_type = kind.removesuffix("_delta")
            if item_type == "thinking" and self.thinking is not None:
                index = next((i for i, entry in enumerate(items) if entry is self.thinking), None)
                if index is None:
                    # A bounded-out block must not merge into unrelated work.
                    return
            else:
                merge = self.previous == item_type and items and items[-1]["type"] == item_type
                index = len(items) - 1 if merge else None
            item = dict(items[index]) if index is not None else {"type": item_type, "text": ""}
            limit = 16000 if item_type == "thinking" else 4000
            item["text"] += self.clipped(text, max(0, limit - len(item["text"])))
            if self.store(item, index) and item_type == "thinking" and self.thinking is not None:
                self.thinking = item
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
                    details = event.get("details") or {}
                    background = details.get("background")
                    if isinstance(background, dict) and isinstance(background.get("task_id"), str):
                        item["background"] = {"task_id": background["task_id"][:32],
                                              "process_id": str(background.get("process_id", ""))[:64]}
                    patch = details.get("patch")
                    if entry["name"] in ("edit", "write") and isinstance(patch, str) and patch:
                        item["patch"], cut = self.bounded_patch(patch)
                        # Runtime may already have cut a large patch to fit its event budget.
                        if cut or details.get("patch_truncated") is True:
                            item["patch_truncated"] = True
                if not self.store(item, index) and kind == "tool_end":
                    # A patch that cannot fit goes first, then the final output; the reserved
                    # timestamp budget guarantees terminal status survives.
                    if "patch" in item:
                        item.pop("patch")
                        item.pop("patch_truncated", None)
                        if self.store(item, index):
                            break
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
        kept = [index for index, item in enumerate(self.data["items"])
                if item["type"] != "text" or index < self.last_boundary_position]
        self.data["items"] = [self.data["items"][index] for index in kept]
        self.sizes = [self.sizes[index] for index in kept]
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
        self.titling = {}

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
        return {key: value for key, value in dict(row).items() if key in CONVERSATION_FIELDS}

    def scope(self, user, scope, authorize=True):
        """Resolve a scope; its `model` is the account group's main model and `judge` its judge (resolved by `selected_model`)."""
        choice = model_choice(self.p.db, user)
        root = self.p.settings.data_dir / "workspaces"
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
                "scope_key": key, "sid": sid, "workspace": workspace, "model": choice["main"], "judge": choice["judge"],
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
                for private in ("model", "effort", "judge_usage"):
                    event.pop(private, None)
                if isinstance(event.get("message"), dict):
                    event["message"]["metadata"] = visible_metadata(event["message"].get("metadata", {}))
                after = event["seq"] = row["id"]
                yield f"id: {after}\nevent: {event['type']}\ndata: {json.dumps(event)}\n\n".encode()
            if not rows:
                yield b": keepalive\n\n"
                await asyncio.sleep(1)

    def feedback(self, user, info, raw):
        """Normalized annotate-feedback items for a message; each names a readable artifact of this very conversation."""
        if raw is None:
            return []
        if not isinstance(raw, list) or len(raw) > MAX_FEEDBACK:
            raise HTTPException(400, f"artifact_feedback must be a list of at most {MAX_FEEDBACK} items")
        scope_type, scope_id = scope_ref(info)
        items = []

        def text(entry, key, limit, clip=False):
            value = entry.get(key)
            if value is not None and not isinstance(value, str):
                raise HTTPException(400, f"artifact_feedback {key} must be a string")
            if value is not None and len(value) > limit:
                if not clip:
                    raise HTTPException(400, f"artifact_feedback {key} must be at most {limit} characters")
                value = value[:limit]
            return value
        with self.p.db.connect() as conn:
            for entry in raw:
                if not isinstance(entry, dict) or not isinstance(entry.get("artifact_id"), int) or isinstance(entry["artifact_id"], bool):
                    raise HTTPException(400, "artifact_feedback items need an integer artifact_id")
                row = self.p.artifacts.readable(user, conn, entry["artifact_id"])
                if (row["scope_type"], row["scope_id"]) != (scope_type, scope_id):
                    raise HTTPException(400, "artifact_feedback must name an artifact of this conversation")
                if entry.get("kind") not in FEEDBACK_KINDS:
                    raise HTTPException(400, "artifact_feedback kind must be element, region or quote")
                version = entry.get("version")
                if row["kind"] == "live":
                    version = None
                elif not isinstance(version, int) or isinstance(version, bool) or not 1 <= version <= row["latest_version"]:
                    raise HTTPException(400, "artifact_feedback version must be an existing version of the artifact")
                rect = entry.get("rect")
                if rect is not None:
                    keys = ("x", "y", "w", "h")
                    if (not isinstance(rect, dict) or set(rect) != set(keys)
                            or any(isinstance(rect[k], bool) or not isinstance(rect[k], (int, float)) or not math.isfinite(rect[k]) for k in keys)):
                        raise HTTPException(400, "artifact_feedback rect must be {x,y,w,h} numbers")
                item = {"artifact_id": row["id"], "version": version, "path": text(entry, "path", 500, clip=True), "kind": entry["kind"],
                        "selector": text(entry, "selector", 500, clip=True), "text": text(entry, "text", FEEDBACK_TEXT), "rect": rect,
                        "title": row["title"], "artifact_kind": row["kind"], "artifact_path": row["path"]}
                items.append({key: value for key, value in item.items() if value is not None or key == "version"})
        return items

    async def enqueue(self, user, scope, content, attachment_ids=None, schedule_run_id=None, mode="insert", artifact_feedback=None):
        if mode not in ("insert", "after_turn"):
            raise HTTPException(400, "Unknown send mode")
        if not isinstance(content, str) or (not content.strip() and not attachment_ids and not artifact_feedback):
            raise HTTPException(400, "Message content is required")
        if len(content.encode()) > 1024 * 1024 or len(attachment_ids or []) > 32:
            raise HTTPException(413, "Message exceeds the Runtime prompt budget")
        info = self.scope(user, scope)
        feedback = self.feedback(user, info, artifact_feedback)
        if info["channel_id"] is not None and "chat" not in permissions(self.p.db, user):
            raise HTTPException(403, "Permission denied")
        async with self.p.gate.admit(), self.lock(info["scope_key"]):
            with self.p.db.connect() as conn:
                if schedule_run_id:
                    existing = conn.execute("SELECT durable_job_id,source_message_id FROM agent_schedule_runs WHERE id=?", (schedule_run_id,)).fetchone()
                    if existing and existing["durable_job_id"] is not None:
                        return {"message": self.message(info, existing["source_message_id"]), "job_id": existing["durable_job_id"]}
                mid = self.insert_message(conn, info, user, "user", content,
                                          {"status": "queued", "author_user_id": user["id"], "author_display_name": user["display_name"],
                                           **({"send_mode": "after_turn"} if mode == "after_turn" else {}),
                                           **({"artifact_feedback": feedback} if feedback else {})})
                self.p.files.bind(user, info, mid, attachment_ids or [], conn=conn)
                titling = info["kind"] == "chat" and self.needs_title(conn, info["scope"][5:])
                payload = {"user_id": user["id"], "scope": scope, "message_id": mid, "content": content,
                           "attachment_ids": attachment_ids or [], "schedule_run_id": schedule_run_id,
                           **({"artifact_feedback": feedback} if feedback else {})}
                job = conn.execute("INSERT INTO durable_jobs(kind,scope_type,scope_id,dedupe_key,payload_json,status,created_at,updated_at) VALUES ('agent',?,?,?,?, 'queued',?,?)",
                                   (info["scope_type"], info["scope_id"], str(uuid.uuid4()), json.dumps(payload), int(time.time()), int(time.time()))).lastrowid
                if schedule_run_id:
                    conn.execute("UPDATE agent_schedule_runs SET durable_job_id=?,source_message_id=?,updated_at=? WHERE id=?", (job, mid, int(time.time()), schedule_run_id))
                if mode == "insert":
                    self.absorb(conn, job, payload, info)
            message = self.message(info, mid)
            self.emit(info["scope_key"], {"type": "message", "message": message})
            if payload.get("parent_job_id"):
                await self.send_inputs(payload["parent_job_id"], info)
            else:
                self.wake(info["scope_key"])
            if titling:
                self.start_title(user, info, content, [attachment["filename"] for attachment in message["attachments"]], mid)
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
            "AND json_extract(payload_json,'$.notice') IS NULL "
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
            prompt["text"] = (feedback_prefix(payload.get("artifact_feedback")) + self.p.skills.invoke(author, info, payload["content"])
                              + ("\n" + prompt["text"] if prompt["text"] else ""))
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

    def withdrawable(self, conn, user, info, message_id):
        """The author's own pending user request and its job, or a typed refusal."""
        if info["kind"] == "chat":
            row = conn.execute("SELECT id,role,content FROM chat_messages WHERE id=? AND conversation_id=?", (message_id, info["scope"][5:])).fetchone()
            role, author = row and row["role"], user["id"]
        else:
            row = conn.execute("SELECT id,author_type,user_id,content FROM messages WHERE id=? AND scope_type=? AND scope_id=? AND hidden_at IS NULL",
                               (message_id, info["scope_type"], info["scope_id"])).fetchone()
            role, author = row and row["author_type"], row and row["user_id"]
        if row is None:
            raise HTTPException(404, "Message not found")
        if author != user["id"]:
            raise HTTPException(403, "Only the author can withdraw this message")
        job = conn.execute(
            "SELECT id,status,payload_json FROM durable_jobs WHERE kind='agent' AND scope_type=? AND scope_id=? "
            "AND json_extract(payload_json,'$.scope')=? AND json_extract(payload_json,'$.message_id')=? ORDER BY id DESC LIMIT 1",
            (info["scope_type"], info["scope_id"], info["scope"], message_id)).fetchone()
        payload = json.loads(job["payload_json"]) if job else {}
        if role != "user" or payload.get("schedule_run_id") is not None or payload.get("notice") or payload.get("operation"):
            raise HTTPException(400, "Message cannot be withdrawn")
        if job is None:
            raise HTTPException(409, "already_seen")
        return row, job, payload

    async def withdraw(self, user, scope, message_id):
        """Remove a request the AI has not seen. Exactly one of withdrawn or delivered/started wins, decided under the scope lock
        (worker start and submission hold it) and, for a submitted input, by Runtime's own answer."""
        info = self.scope(user, scope)
        if info["channel_id"] is not None and "chat" not in permissions(self.p.db, user):
            raise HTTPException(403, "Permission denied")
        table = "chat_messages" if info["kind"] == "chat" else "messages"
        async with self.p.gate.admit(), self.lock(info["scope_key"]):
            with self.p.db.connect() as conn:
                row, job, payload = self.withdrawable(conn, user, info, message_id)
                metadata = json.loads(conn.execute(f"SELECT metadata_json FROM {table} WHERE id=?", (message_id,)).fetchone()[0])
                parent = conn.execute("SELECT payload_json FROM durable_jobs WHERE id=? AND status='running'", (payload.get("parent_job_id"),)).fetchone() if payload.get("parent_job_id") else None
            sent = bool(payload.get("steer_sent"))
            attached = job["status"] == "running" and parent is not None and metadata.get("delivery") == "pending"
            if job["status"] != "queued" and not attached:
                raise HTTPException(409, "already_seen")
            if attached and sent:
                run_id = json.loads(parent["payload_json"]).get("runtime_run_id")
                try:
                    result = await self.runtime("DELETE", f"/v1/runs/{run_id}/inputs/{job['id']}")
                except httpx.HTTPStatusError as exc:
                    if exc.response.status_code in (404, 409):
                        raise HTTPException(409, "already_seen") from exc
                    raise HTTPException(502, "Runtime could not withdraw the message") from exc
                except httpx.RequestError as exc:
                    raise HTTPException(502, "Runtime could not withdraw the message") from exc
                if result.get("removed") is not True:
                    raise HTTPException(502, "Runtime could not withdraw the message")
            with self.p.db.connect() as conn:
                # The parent may have settled while Runtime answered: a requeued input is withdrawn as a queued job, a settled one is final.
                changed = conn.execute(
                    "UPDATE durable_jobs SET status='failed',last_error='withdrawn',updated_at=? WHERE id=? "
                    "AND (status='queued' OR (status='running' AND json_extract(payload_json,'$.parent_job_id') IS NOT NULL "
                    "AND COALESCE(json_extract(payload_json,'$.steer_sent'),0)=?))",
                    (int(time.time()), job["id"], int(sent))).rowcount
                if not changed:
                    raise HTTPException(409, "already_seen")
                attachments = self.p.files.for_message(info, message_id)
                self.p.files.release(info, message_id, conn)
                conn.execute(f"DELETE FROM {table} WHERE id=?", (message_id,))
                self.emit(info["scope_key"], {"type": "message_removed", "message_id": message_id}, conn)
                if info["kind"] == "chat" and (titling := self.titling.pop(info["scope"][5:], None)) is not None:
                    titling.cancel()
        return {"content": row["content"], "attachments": attachments, "artifact_feedback": metadata.get("artifact_feedback", [])}

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
        tasks = getattr(self.p, "tasks", None)
        if tasks is not None:
            tasks.resume()

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
        tasks = list(self.tasks.values()) + list(self.titling.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def runtime(self, method, path, **kwargs):
        response = await self.p.http.request(method, self.p.settings.runtime_url.rstrip("/") + path,
                                             headers={"Authorization": f"Bearer {self.p.settings.runtime_token}"}, **kwargs)
        response.raise_for_status()
        return response.json()

    async def selected_model(self, info):
        """Resolve the main and judge model ids against the live catalog and attach catalog limits; returns the main model."""
        catalog = await self.p.oauth.catalog()
        if not info["model"]["id"]:
            if not catalog["models"]:
                raise HTTPException(409, "No executable model is available")
            info["model"]["id"] = catalog["models"][0]["id"]
        if not info["judge"]["id"]:
            info["judge"]["id"] = info["model"]["id"]
        for model in (info["model"], info["judge"]):
            selected = next((entry for entry in catalog["models"] if entry["id"] == model["id"]), {})
            for field in ("contextWindow", "maxTokens"):
                value = selected.get(field)
                if isinstance(value, int) and not isinstance(value, bool) and value > 0:
                    model[field] = value
        return info["model"]

    @staticmethod
    def model_body(info):
        """The Runtime run fields for a resolved scope: the main model, plus the judge only while the main depth is automatic."""
        return {"model": info["model"], **({"judge": info["judge"]} if info["model"]["thinking"] == "auto" else {})}

    @staticmethod
    def needs_title(conn, cid):
        """True when the conversation still has its creation placeholder and this is its first user message."""
        row = conn.execute("SELECT title_state FROM chat_conversations WHERE id=?", (cid,)).fetchone()
        return bool(row) and row[0] == "placeholder" and conn.execute("SELECT count(*) FROM chat_messages WHERE conversation_id=? AND role='user'", (cid,)).fetchone()[0] == 1

    def start_title(self, user, info, text, files, message_id=None):
        """Single-flight asynchronous title generation for a chat conversation; never blocks message acceptance."""
        cid = info["scope"][5:]
        if self.stopping or cid in self.titling:
            return
        task = asyncio.create_task(self.generate_title(user, info, cid, text, files, message_id))
        self.titling[cid] = task
        task.add_done_callback(lambda done: self.titling.pop(cid, None) if self.titling.get(cid) is done else None)

    async def generate_title(self, user, info, cid, text, files, message_id=None):
        """Ask Runtime for a title with the group's judge; keep the placeholder on any failure. A rename always wins."""
        try:
            await self.selected_model(info)
            judge = info["judge"]
            # Runtime limits: text and names are measured in UTF-16 units; at most 20 files of at most 255 units.
            def clip(value, units):
                return value.encode("utf-16-le")[:units * 2].decode("utf-16-le", "ignore")
            names = [clip(name, 255) for name in files[:20] if name.strip()]
            body_text = clip(text, 8000) if text.strip() else clip("\n".join(names), 8000)
            if not body_text.strip():
                return
            result = await self.runtime("POST", "/v1/titles", json={"judge": judge, "text": body_text, **({"files": names} if names else {})}, timeout=25)
            title = " ".join(result["title"].split())[:120]
            usage = result.get("usage") if isinstance(result.get("usage"), dict) else {}
            if not title:
                return
        except Exception:
            return
        counts = {key: usage.get(key) if isinstance(usage.get(key), int) and not isinstance(usage.get(key), bool) else 0
                  for key in ("input", "output", "cache_read", "cache_write", "total")}
        model = result.get("model") if isinstance(result.get("model"), str) and result.get("model") else judge["id"]
        with self.p.db.connect() as conn:
            conn.execute("INSERT INTO token_usage_events(user_id,username,display_name,scope_type,scope_id,scope_name,request_message_id,response_message_id,provider,model,input_tokens,output_tokens,total_tokens,raw_usage_json,created_at) VALUES (?,?,?,?,?,?,NULL,NULL,?,?,?,?,?,?,?)",
                         (user["id"], user["username"], user["display_name"], info["scope_type"], info["scope_id"], title,
                          "openai-codex", model, counts["input"], counts["output"], counts["total"],
                          json.dumps({**counts, "kind": "title", "cacheRead": counts["cache_read"], "cacheWrite": counts["cache_write"]}), int(time.time())))
            changed = conn.execute("UPDATE chat_conversations SET title=?,title_state='generated' WHERE id=? AND title_state='placeholder' AND deleted_at IS NULL "
                                   "AND (? IS NULL OR EXISTS(SELECT 1 FROM chat_messages WHERE id=? AND conversation_id=?))",
                                   (title, cid, message_id, message_id, cid)).rowcount
            if changed:
                self.emit(info["scope_key"], {"type": "conversation_title", "id": cid, "title": title}, conn)

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

    def resources(self, info, user):
        with self.p.db.connect() as conn:
            row = conn.execute("SELECT value FROM settings WHERE key='ui_branding_v1'").fetchone()
        branding = json.loads(row[0]) if row else {}
        prompt = f"You are {branding.get('agent_name', 'Assistant')}, the assistant in {branding.get('product_name', 'Agent Platform')}. "
        prompt += f"Use your available tools to help the user. {artifact_guidance(info['sandbox']['cwd'], info['kind'] == 'agent' and info['channel_id'] is None)}"
        agents = None
        if info["kind"] == "agent":
            prompt += " Maintain lasting workspace guidance in AGENTS.md. Use advertised skills when relevant.\n\n"
            prompt += skill_guidance(personal=info["channel_id"] is None)
            try:
                content = bounded_read(open_workspace(info["workspace"], "AGENTS.md")).decode("utf-8")
                agents = {"path": "/workspace/AGENTS.md", "content": content}
            except (OSError, HTTPException, UnicodeError):
                pass
        return {"system_prompt": prompt, "agents_md": agents, "skills": self.p.skills.catalog(user, info)}

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
                    notice = None
                    if payload.get("notice"):
                        notice = self.p.tasks.begin_notice(job, payload, info)
                        if notice is None:
                            continue
                    with self.p.db.connect() as conn:
                        table = "chat_messages" if info["kind"] == "chat" else "messages"
                        metadata = json.loads(conn.execute(f"SELECT metadata_json FROM {table} WHERE id=?", (payload["message_id"],)).fetchone()[0])
                        metadata["status"] = "running"
                        conn.execute(f"UPDATE {table} SET metadata_json=? WHERE id=?", (json.dumps(metadata), payload["message_id"]))
                    self.emit(key, {"type": "message", "message": self.message(info, payload["message_id"])})
                    await self.selected_model(info)
                    prompt = self.p.files.prompt(user, info, payload["attachment_ids"])
                    text = payload["content"] if notice is None else notice
                    prompt["text"] = (feedback_prefix(payload.get("artifact_feedback")) + (self.p.skills.invoke(user, info, text) if notice is None else text)
                                      + ("\n" + prompt["text"] if prompt["text"] else ""))
                    tools = BUILTINS + (["skill"] if info["kind"] == "agent" else []) + (["browser", "schedule", "task", "job", "wait"] if info["kind"] == "agent" and info["channel_id"] is None else [])
                    mcp = await self.p.mcp.run_payload(user, info)
                    if mcp is not None:
                        tools.append("mcp")
                    payload.update(runtime_sid=info["sid"], runtime_unsettled=True)
                    with self.p.db.connect() as conn:
                        conn.execute("UPDATE durable_jobs SET payload_json=? WHERE id=?", (json.dumps(payload), job["id"]))
                    self.unsettled[key] = (job["id"], payload)
                    result = await self.runtime("POST", f"/v1/sessions/{info['sid']}/runs", json={
                        "kind": info["kind"], "sandbox": info["sandbox"], **self.model_body(info), "prompt": prompt,
                        "context_prefix": json.dumps({"time": now(), "user": user["display_name"], "tz": user["timezone"]}),
                        "resources": self.resources(info, user), "tools": tools, **({"mcp": mcp} if mcp is not None else {})})
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
        # Applied effort and the judge's usage are administrator accounting only: they never reach the event stream or history.
        effort, judge_usage = event.pop("effort", None), event.pop("judge_usage", None)
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
            self.p.artifacts.link(conn, info, mid, job["id"])
            table = "chat_messages" if info["kind"] == "chat" else "messages"
            old_metadata = json.loads(conn.execute(f"SELECT metadata_json FROM {table} WHERE id=?", (payload["message_id"],)).fetchone()[0])
            conn.execute(f"UPDATE {table} SET metadata_json=? WHERE id=?", (json.dumps({**old_metadata, **metadata}), payload["message_id"]))
            usage = event.get("usage", {})
            conn.execute("INSERT INTO token_usage_events(user_id,username,display_name,scope_type,scope_id,scope_name,request_message_id,response_message_id,provider,model,input_tokens,output_tokens,total_tokens,raw_usage_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                         (user["id"], user["username"], user["display_name"], info["scope_type"], info["scope_id"], info["scope_name"],
                          payload["message_id"], mid, "openai-codex", event.get("model", info["model"]["id"]), usage.get("input", 0), usage.get("output", 0), usage.get("total", 0),
                          json.dumps({**usage, "kind": info["kind"], "cacheRead": usage.get("cache_read", 0), "cacheWrite": usage.get("cache_write", 0),
                                      **({"effort": effort} if isinstance(effort, str) and effort else {})}), int(time.time())))
            if isinstance(judge_usage, dict):
                judged = {key: judge_usage.get(key) if isinstance(judge_usage.get(key), int) and not isinstance(judge_usage.get(key), bool) else 0
                          for key in ("input", "output", "cache_read", "cache_write", "total")}
                conn.execute("INSERT INTO token_usage_events(user_id,username,display_name,scope_type,scope_id,scope_name,request_message_id,response_message_id,provider,model,input_tokens,output_tokens,total_tokens,raw_usage_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                             (user["id"], user["username"], user["display_name"], info["scope_type"], info["scope_id"], info["scope_name"],
                              payload["message_id"], mid, "openai-codex", judge_usage.get("model") if isinstance(judge_usage.get("model"), str) and judge_usage.get("model") else info["judge"]["id"],
                              judged["input"], judged["output"], judged["total"],
                              json.dumps({**judged, "kind": "auto_effort", "cacheRead": judged["cache_read"], "cacheWrite": judged["cache_write"]}), int(time.time())))
            if payload.get("schedule_run_id"):
                conn.execute("UPDATE agent_schedule_runs SET status=?,response_message_id=?,finished_at=?,error=?,updated_at=? WHERE id=?",
                             ("succeeded" if status == "completed" else "failed", mid, int(time.time()), event.get("error", ""), int(time.time()), payload["schedule_run_id"]))
        self.emit(info["scope_key"], {"type": "message", "message": self.message(info, payload["message_id"])})
        for child_mid in child_mids:
            self.emit(info["scope_key"], {"type": "message", "message": self.message(info, child_mid)})
        try:
            await self.p.files.deliver(user, info, mid, event.get("text", ""), job["id"])
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
        with self.p.db.connect() as conn:
            # MEDIA-published versions exist only now; a failed delivery also rewrote the metadata above.
            self.p.artifacts.link(conn, info, mid, job["id"], final=True)
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
            rows = conn.execute(f"SELECT {CONVERSATION_COLUMNS} FROM chat_conversations WHERE user_id=? AND deleted_at IS NULL ORDER BY updated_at DESC", (user["id"],)).fetchall()
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
            conn.execute("INSERT INTO chat_conversations(id,user_id,title,title_state,created_at,updated_at) VALUES (?,?,?,'placeholder',?,?)", (cid, user["id"], title, now(), now()))
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
            p.artifacts.delete_scope("chat", cid)
            shutil.rmtree(info["workspace"])
            return JSONResponse({"ok": True})
        body = await body_json(request)
        if set(body) - {"title"}:
            raise HTTPException(400, "Unknown conversation field")
        title = body.get("title", conversation["title"])
        if not isinstance(title, str) or not title.strip():
            raise HTTPException(400, "Title is required")
        if "title" in body:
            with p.db.connect() as conn:
                conn.execute("UPDATE chat_conversations SET title=?,title_state='user',updated_at=? WHERE id=?", (title, now(), cid))
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
            mode = body.get("mode", "insert")
            return JSONResponse(await queue.enqueue(user, scope, body.get("content"), body.get("attachment_ids"), mode=mode,
                                                        artifact_feedback=body.get("artifact_feedback")), status_code=202)
        return JSONResponse(queue.messages(user, scope, request.query_params.get("before"), request.query_params.get("limit", 100)))
    if action == "events":
        queue.scope(user, scope)
        after = int(request.headers.get("last-event-id", request.query_params.get("after", "0")))
        return StreamingResponse(authenticated_events(request, scope, after), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
    return JSONResponse(await getattr(queue, action)(user, scope), status_code=202 if action == "compact" else 200)


async def withdraw_route(request):
    user = current_user(request)
    scope = "chat-" + request.path_params["id"] if "id" in request.path_params else request.path_params["scope"]
    return JSONResponse(await request.app.state.platform.queue.withdraw(user, scope, request.path_params["message_id"]))


def routes():
    result = [Route("/api/chat/conversations", chats, methods=["GET", "POST"]),
              Route("/api/chat/conversations/{id}", chat, methods=["GET", "PATCH", "DELETE"])]
    for prefix in ("/api/conversations/{scope}", "/api/chat/conversations/{id}"):
        for action in ("messages", "events", "cancel", "compact", "reset"):
            if prefix.startswith("/api/chat") and action == "reset":
                continue
            methods = ["GET", "POST"] if action == "messages" else ["GET"] if action == "events" else ["POST"]
            result.append(Route(prefix + "/" + action, conversation_route, methods=methods))
            if action == "messages":
                result.append(Route(prefix + "/messages/{message_id:int}", withdraw_route, methods=["DELETE"]))
    return result
