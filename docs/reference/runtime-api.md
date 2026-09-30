# Runtime API

The plain Pi runtime listens on port 8766. `GET /health` returns
`{"status":"ok","service":"agent-platform-runtime"}`. All routes require
`Authorization: Bearer <agent-runtime-token>`. Request bodies are JSON.

## Runs

`POST /v1/sessions/{sid}/runs` returns `202 {"run_id":"..."}` or 409 when
that session is busy. Platform owns FIFO admission and stable session IDs:
`agent-private-<uid>`, `agent-channel-<cid>`, and `chat-<conversation-id>`.

```json
{"kind":"agent","sandbox":{"scope_key":"private:1","workspace_id":"user-1","sandbox_id":"sandbox-1","lifecycle_id":"life-1","profile":"agent","cwd":"/workspace"},"model":{"id":"gpt-5.5","thinking":"medium"},"prompt":{"text":"Hello","images":[]},"context_prefix":"<context time=... user=... tz=...>","resources":{"system_prompt":"You are an assistant.","agents_md":{"path":"/workspace/AGENTS.md","content":"Project instructions"},"skills":[]},"tools":["read","bash","edit","write","grep","find","ls","web_search","web_fetch","browser","schedule","mcp"]}
```

Image entries are `{mime,data}` with base64 data. Skill entries are
`{name,description,path}`. Chat uses `kind:chat`, `profile:chat`, a
conversation directory beneath `/workspace`, and only read/bash/edit/write/
grep/find/ls/web_search/web_fetch. Chat never loads AGENTS.md or skills.
Browser, schedules and MCP are available only to personal agent scopes.
Run and compact `model` objects also accept optional positive integer
`contextWindow` and `maxTokens`. Platform authorizes model IDs against its
account catalog. Runtime accepts those Codex IDs even when absent from Pi's
static catalog, using native Codex transport metadata and supplied token
limits (or native template defaults).

Resources, tools and kind are fixed when a live session is constructed;
subsequent runs cannot change that prefix. Volatile context is prepended to
the user message, never the system prompt. Pi cache warming is disabled;
compaction and retry use Pi defaults. Normal and summarization requests share
the conversation session ID and enabled prompt caching. Credentials come from
Platform's `POST /api/agent/tools/credentials/resolve`; refresh uses
`force_refresh`. Credential and tool-gateway requests have finite deadlines
combined with SDK cancellation.

`GET /v1/runs/{run_id}/events?after=<seq>` streams SSE JSON objects with
monotonic `seq` and `type`. Omit `after` to replay from the beginning.
Completed buffers remain available for ten minutes, with a 4 MiB per-run
encoded replay budget. Old complete events are evicted without renumbering;
a cursor older than retained history receives HTTP 410. Oversized individual
events create a replay gap and disconnect live consumers rather than silently
truncate the final answer. Complete model history remains in the session.
Healthy consumers receive 16 KiB chunks, pausing until drain as needed;
clients exceeding a 4 MiB pending queue or stalled for ten seconds are
disconnected and may reconnect with their last sequence. Tool activity
previews are bounded to 64 KiB and omit image bytes; Pi still receives
complete browser image content.

| Type | Fields |
| --- | --- |
| text_delta, thinking_delta | delta |
| tool_start | tool_call_id, name, args |
| tool_update | tool_call_id, partial |
| tool_end | tool_call_id, name, is_error, content_preview, details |
| retry | attempt, max, delay_ms, error |
| compaction | phase (start/end), reason |
| run_end | status (completed/failed/cancelled), text, usage, model, error?, side_effects |

`usage` contains `input`, `output`, `cache_read`, `cache_write`, `total`.
`run_end` is always the last event. No draft events are emitted.
`side_effects` becomes true when bash/write/edit, a mutating browser or
schedule action, or any MCP operation starts.

`POST /v1/runs/{run_id}/cancel` returns `{ok:true}` and cancels Pi and
Manager execution. `POST /v1/sessions/{sid}/cancel` settles an active run
even when its submission response (and run ID) was lost. It waits for pending
session construction and terminal run state, returning
`{cancelled:true,run_id:"..."}`; idle sessions return
`{cancelled:false,run_id:null}`. The response wait is bounded to 30 seconds
(504 if exceeded); new runs remain fenced until cancellation settles.
Manager rejection/unconfirmed termination does not release the session fence
or emit terminal `run_end`; retry cancellation to confirm the same run.
Cancellation during admission aborts credential lookup; an unadmitted request
returns 409 and idle cancellation reports no run ID.
Session cancellation also aborts and waits for an active manual compaction,
including a cold restored session. It returns `{cancelled:true,run_id:null}`
once compaction settles; the interrupted compact request returns HTTP 409
with `{"error":"Session compaction cancelled"}`.
This never resubmits a prompt or deletes history. After Runtime restart it
reports only current Runtime activity, not cleanup of detached Manager work.

`POST /v1/sessions/{sid}/compact` requires
`{model:{id:"gpt-5.5",thinking:"medium"}}`. Successful summarization returns
HTTP 200 `{compacted:true,model:"gpt-5.5",usage:{input,output,cache_read,cache_write,total}}`,
using the actual Pi compaction token usage. A session with insufficient
history returns HTTP 200 `{compacted:false,reason:"too_small"}` without
calling the summarization provider. This no-work result is not a failure.
The requested model/thinking are used for summarization, including when
restoring a persisted session after restart or eviction. Platform validates
current model policy before requesting compaction.
Concurrent session mutations return 409. `DELETE /v1/sessions/{sid}`
disposes the object and deletes its v3 file. `GET
/v1/sessions/{sid}/history?before=<entry_id>&limit=n` returns
`{messages:[{entry_id,message}],next_before}` containing model-visible
messages for debugging/export, not UI message storage.

## Execution and persistence

Sessions idle for fifteen minutes are disposed. Files are Pi JSONL v3 at
`<home>/sessions-v3/<sha256(sid)>.jsonl`. All tenant execution uses Manager's
Unix executor: audit receipt followed by terminal/file operation, with
`execution_context.profile`. No host environment is forwarded.
Every terminal request has a finite deadline. Bash uses its explicit Pi
timeout when supplied, otherwise ten minutes; all terminal deadlines are
capped at one hour. This bounds outstanding Manager commands after a
Runtime restart without tracking or replaying old runs.
File tool paths stay inside the sandbox root (chat inside its conversation directory).
Chat sandboxes are shared by one user's conversations: the security boundary
is the user, not the conversation. Bash starts in the conversation directory
but may access that user's other files. Pi read/edit/write/find/ls use remote
operations; custom bash keeps output capture and large-output spill files
inside the sandbox, while grep invokes sandbox `rg`. Binary reads use bounded,
byte-count-verified chunks so truncated transport output cannot reach edit.
`/platform-skills/` reads map read-only to `/app/skills/`.
Runtime reads bundled SKILL.md frontmatter once on startup and advertises
that catalog for agent sessions. Request workspace skills override bundled
skills with the same name. Chat sessions never advertise either catalog.

Web, browser and schedule tools call Platform
`POST /internal/agent/tools/{web|browser|schedule}` using agent-tool-token
and `{action,arguments,context:{sid,scope_key,run_id,owner_user_id?,channel_id?}}`.
MCP invokes `/usr/local/bin/agent-platform-mcp <base64url-json>` through the
sandbox executor with Manager's MCP audit projection/private-output handling;
encoded call arguments are not presented as ordinary audited shell commands.

Startup reads `<home>/migration/active-sessions.json` entries
`{sid,scope_key,lifecycle_id,session_id}`. Matching v4 journal identities are
converted losslessly, preserving all messages and the latest compaction's
model context. Only newline-terminated source transactions are committed;
torn suffixes are ignored without editing the source. Session and marker
publication fsync both files and parent directories.

Every startup reconciles each imported sid's source identity, last committed
sequence and source digest. If rollback changed or extended the old journal,
a migration-owned v3 import is archived as `<file>.superseded-<timestamp>`
and re-imported. If Pi has appended entries since import, its history wins:
Runtime keeps the v3 file and logs a warning instead of silently discarding
turns. Unprovable older imports without provenance are also retained with a
warning. `sessions/` and `sessions.pre-pi/` are never modified.

Runtime environment/secret mount contracts remain the deployed ones:
`AGENT_RUNTIME_HOME`, `AGENT_RUNTIME_HOST`, `AGENT_RUNTIME_PORT`,
`AGENT_RUNTIME_MAX_BODY_BYTES`, `AGENT_RUNTIME_TOKEN_FILE`,
`AGENT_PLATFORM_INTERNAL_URL`, `AGENT_PLATFORM_INTERNAL_TOKEN_FILE`,
`AGENT_MANAGER_EXECUTOR_SOCKET`, `AGENT_MANAGER_EXECUTOR_TOKEN_FILE`.
