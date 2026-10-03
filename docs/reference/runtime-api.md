# Runtime API

The plain Pi runtime listens on port 8766. `GET /health` returns
`{"status":"ok","service":"agent-platform-runtime"}`. All routes require
`Authorization: Bearer <agent-runtime-token>`. Request bodies are JSON.

## Runs

`POST /v1/sessions/{sid}/runs` returns `202 {"run_id":"..."}` or 409 when
that session is busy. Platform owns admission and stable session IDs:
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

Resources, tools and kind are fixed when a live session is constructed.
Unchanged inputs reuse that object; changed inputs reopen the same transcript
and Pi appends changed system-prompt sections without rewriting its leading
prompt. Volatile context is prepended to the user message, never the system
prompt. Pi cache warming is disabled; compaction and retry use Pi defaults.
Normal and summarization requests share the conversation session ID and
enabled prompt caching. Credentials come from Platform's
`POST /api/agent/tools/credentials/resolve`; refresh uses `force_refresh`.
Credential and tool-gateway requests have finite deadlines combined with
SDK cancellation.

`POST /v1/runs/{run_id}/steer` inserts input into the active run:

```json
{"input_id":"42","prompt":{"text":"Use the other file instead","images":[]},"context_prefix":"<context time=... user=... tz=...>"}
```

All fields shown are required. `input_id` is a string of 1–64 characters.
`prompt.text` and `context_prefix` are strings; `prompt.images` is an array
of the same `{mime,data}` entries as a run prompt (empty when there are no
images). Success returns HTTP 200 `{"ok":true}`. Repeating an accepted
`input_id` for that run returns success without queuing it twice.
Invalid bodies return 400, unknown runs 404, and new inputs return 409 with
`{"error":"..."}` if the run is done, cancelled, no longer accepting input,
or already has 32 pending inputs.

A run accepts input from creation until its Pi session prompt returns. All
pending inputs are delivered together at the next Pi turn boundary, in
acceptance order; inputs queued before the agent loop starts are included
in its first model request. An input arriving during a final answer can
continue the same run with another model response. The model text is exactly
`[context_prefix, prompt.text].filter(Boolean).join('\n')`; images are mapped
as in run prompts. Steering is literal user input: `/skill:` commands and
prompt templates are not expanded.

`input_delivered` is emitted when Pi adds the corresponding user message to
the model context. Delivered inputs persist as ordinary user messages in the
Pi transcript. Once the session prompt returns, Runtime closes admission
and clears Pi's input queues. Every terminal `run_end`, including cancellation
and failure, reports accepted but undelivered IDs in `undelivered_inputs`,
in acceptance order (an empty array when all were delivered). These cleared
inputs never enter a later run. An uncertain delivery must not be blindly
replayed.

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
| tool_input_start | tool_call_id, name |
| tool_input_delta | tool_call_id, delta |
| tool_update | tool_call_id, partial |
| tool_output | tool_call_id, delta?, truncated? |
| tool_end | tool_call_id, name, is_error, content_preview, details |
| retry | attempt, max, delay_ms, error |
| compaction | phase (start/end), reason |
| input_delivered | input_id |
| run_end | status (completed/failed/cancelled), text, usage, model, error?, side_effects, undelivered_inputs |

`usage` contains `input`, `output`, `cache_read`, `cache_write`, `total`.
`run_end` is always the last event. No draft events are emitted.
`side_effects` becomes true when bash/write/edit, a mutating browser or
schedule action, or any MCP operation starts.

`tool_input_start` marks the model beginning to generate a tool call (Pi
`message_update`/`toolcall_start`, resolved through `partial.content[contentIndex]`);
`tool_input_delta` carries raw argument-JSON text fragments in order, coalesced
to about 100 ms, for every tool. Concatenating all deltas for an id yields the
argument JSON as generated; `tool_start` stays the authoritative full arguments.
`tool_output` carries live bash output text, appended in order and coalesced to
at most about 8 events per second per call. Live output is capped at 512 KiB per
call, after which one `{tool_call_id,delta:"",truncated:true}` is emitted and
no more follow. `tool_end` stays authoritative for the result. All three are
informational: they never set `side_effects` and Platform ignores them in work traces.

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
restoring a persisted session after restart or eviction.
Concurrent session mutations return 409. `DELETE /v1/sessions/{sid}`
disposes the object and deletes its v3 file. `GET
/v1/sessions/{sid}/history?before=<entry_id>&limit=n` returns
`{messages:[{entry_id,message}],next_before}` containing model-visible
messages for debugging/export, not UI message storage.

## Execution and persistence

Sessions idle for fifteen minutes are disposed. A run whose kind, sandbox,
resources or tools differ from the live object's opens a new Pi session object;
Pi appends the difference (see
[prompt cache](../design/agent-runtime.md#prompt-cache)). Files are Pi JSONL v3 at
`<home>/sessions-v3/<sha256(sid)>.jsonl`. Existing v3 files are opened without
rewrite.

All tenant execution uses Manager's Unix executor with its separate executor
Bearer token. The only executor endpoints are POST `/v1/executor/audit`,
`/v1/executor/terminal`, `/v1/executor/file` and `/v1/executor/runs/cancel`.
An audit receipt is one-shot and binds the operation, arguments and complete
identity, including `execution_context.profile`; terminal/file calls consume it.
The only target is `sandbox`; host execution is rejected.

Terminal supports foreground `action:run` with `command`, `cwd`, `timeout_ms`
and `background:false`. It returns bounded `stdout`, `stderr`, `status` and
`exit_code`. Bash uses its explicit Pi timeout when supplied, otherwise
600000 ms; deadlines are capped at 3600000 ms. Timeout and run cancellation
kill the whole command process group inside the sandbox, including grandchildren.
Cancellation returns `{confirmed}` and must not claim success before termination
is confirmed. Running commands and unconfirmed-termination identities are tracked
only in memory, not persisted or recovered as background work. If the sandbox
supervisor is lost or stopped and cleanup cannot be proved, cancellation retries
remain `{confirmed:false}`; Manager restart's sandbox cleanup is the reset boundary.

Terminal responses are JSON by default. A request with `Accept:
application/x-ndjson` opts into streaming: `Content-Type:
application/x-ndjson`, one JSON object per line, flushed per frame:
`{"type":"output","stream":"stdout"|"stderr","data":"<text>"}` carries output
after Manager redaction, in commit order (never an undecided suffix or a secret
split across frames); the last line is `{"type":"result","result":{…}}` (the
JSON-mode object plus `type`) or `{"type":"error","status":409,"error":"…"}`
for a failure after streaming began. Failures before the first frame use the
ordinary HTTP error response. Private (MCP) output is never streamed. At most
1 MiB is streamed per call, pending frames are bounded (a reader too slow to
drain them stops receiving output frames), and the result frame stays
authoritative. Redaction withholds an undecided suffix of up to 512 bytes per
stream, so the newest bytes appear in frames only as more output arrives or at
exit. Disconnect, cancellation, audit, admission and timeouts are unchanged.

Runtime opts in for bash only. The in-sandbox wrapper writes combined output to
the spill file exactly as before and also tails it to stderr, which Runtime
forwards as live `tool_output`; stdout keeps the summary protocol (path, bytes,
lines, then the tail). Runtime ignores stdout frames for live output. If Manager
answers with plain JSON (an older Manager during a rolling update) the result is
used with no live output.

Foreground admission is limited to 16 pending/running calls per scope family
and 128 globally. Admission counts begin before sandbox creation or process
startup, and slots are released when execution settles. Over-limit calls return
the ordinary executor conflict/error response; they never start a command.

File supports `read` and `write`; read returns `content` and byte counts in
`details.returned` and `details.total`. Process/task/scope-process APIs and
patch/search file actions are not supported. Before accepting executor requests
after startup, Manager stops running managed sandboxes; workspace, home and
environment persist and sandboxes restart on demand. Idle stop remains active.
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
The `schedule` tool's actions are `list|get|create|update|pause|resume|delete|run_now|history`; it is owner-scoped, personal-AI only, and each occurrence sends the schedule's `prompt` to the personal AI as a new message.
MCP invokes `/usr/local/bin/agent-platform-mcp <base64url-json>` through the
sandbox executor with Manager's MCP audit projection/private-output handling;
encoded call arguments are not presented as ordinary audited shell commands.

Runtime environment/secret mount contracts remain the deployed ones:
`AGENT_RUNTIME_HOME`, `AGENT_RUNTIME_HOST`, `AGENT_RUNTIME_PORT`,
`AGENT_RUNTIME_MAX_BODY_BYTES`, `AGENT_RUNTIME_TOKEN_FILE`,
`AGENT_PLATFORM_INTERNAL_URL`, `AGENT_PLATFORM_INTERNAL_TOKEN_FILE`,
`AGENT_MANAGER_EXECUTOR_SOCKET`, `AGENT_MANAGER_EXECUTOR_TOKEN_FILE`.
