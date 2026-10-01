# Platform API (Pi-native)

All paths are same-origin. JSON requests/responses; errors `{ "error": "message" }` with appropriate HTTP status. Auth is an HttpOnly SameSite=Lax signed `agent_platform_session` cookie, preserving installed sessions across upgrade and rollback. Mutations require same-origin requests. IDs are integers except chat conversation IDs (UUID strings). Dates are ISO 8601 UTC strings. Lists are objects, not bare arrays.

## Auth and bootstrap
- POST `/api/auth/login` `{username,password}` → `{user}`; POST `/api/auth/logout` `{}` → `{ok:true}`.
- Login failures use bounded 15-minute client/account counters; throttled requests return 429 before password hashing for exhausted client/pair budgets. Password changes require current-password proof (missing or wrong returns 400) and issue a fresh installed-session cookie.
- GET `/api/bootstrap` → `{user,branding,permissions,channels,chat_models}`.
- GET/PATCH `/api/me` (patch `{display_name?,timezone?,password?,current_password?}`) → `{user}`. Changing `password` requires valid `current_password`; success renews the caller's cookie while revoking older copies.
- User: `{id,username,display_name,role,position,permission_group,model_name,thinking_depth,timezone,active}`. Passwords never returned.
- Branding: `{product_name,agent_name,primary_color,logo}`. Permissions: string array. Admin receives all permissions.
- GET `/api/branding` is public and returns `{branding}` for the login page.

## Personal AI and channels
- GET `/api/channels` → `{channels:[{id,name,description,archived}]}`; POST same `{name,description?}` → `{channel}`; PATCH/DELETE `/api/channels/{id}` → `{channel}` / `{ok:true}`.
- GET `/api/conversations/{scope}/messages?before=<id>&limit=100` → `{messages,next_before_id,last_seq,compaction}`. Scope is `private` or `channel-<id>`. `compaction` is the latest manual-compaction status described below, or null.
- POST same `{content,attachment_ids?:[]}` → HTTP 202 `{message,job_id}` (FIFO; never joins an active input). Empty content is accepted when authorized attachments are supplied.
- POST `/api/conversations/{scope}/cancel` → `{ok:true}`; POST `/api/conversations/{scope}/reset` → `{ok:true}`.
- POST `/api/conversations/{scope}/compact` → HTTP 202 `{ok:true,job_id,status:"queued"}`. Manual compaction is a durable operation in the same per-session FIFO as messages; existing work finishes first and later messages wait behind it. The Runtime compaction request has a 15-minute timeout.
- GET `/api/conversations/{scope}/events?after=<seq>` → SSE.
- Message: `{id,role:"user"|"assistant"|"system",content,metadata,created_at,attachments:[]}`. Metadata includes `status:"queued"|"running"|"completed"|"interrupted"|"cancelled"`, optional error.

### Assistant message work trace

Assistant messages may include `metadata.work` v1. It is stored only in the assistant message metadata, not a separate work table; the terminal `run_end.message` and history pages expose the same object:

```json
{
  "v": 1,
  "started_at": "2026-10-01T09:00:00+00:00",
  "ended_at": "2026-10-01T09:00:03+00:00",
  "items": [
    {"type": "thinking", "text": "Inspect the report first."},
    {"type": "text", "text": "I will read the report."},
    {"type": "tool", "id": "call_1", "name": "read", "args": {"path": "report.txt"}, "status": "done", "output": "Revenue increased.", "started_at": "2026-10-01T09:00:01+00:00", "ended_at": "2026-10-01T09:00:02+00:00"}
  ],
  "truncated": false
}
```

- Times are ISO-8601 UTC. Items retain arrival order; consecutive thinking deltas merge, and consecutive text deltas merge. The final answer is `message.content`, never repeated in work: text items after the last tool item are dropped (including all text items if there is no tool).
- Tool fields are `type:"tool"`, `id`, `name`, `args`, `status`, `output`, `started_at`, and `ended_at`. Status is `done`, `error`, or `cancelled`; unfinished tools become `cancelled` at termination, with `ended_at:null`. Output previews use text parts from Runtime tool results, including partial updates when interrupted.
- Bounds apply during streaming: each thinking/text item is at most 4,000 characters; tool args JSON is at most 2,000 characters or is replaced with `{"_preview":"<first 2,000 chars of the JSON>"}`; tool output is at most 2,000 characters; at most 200 items and at most 96 KiB of UTF-8 JSON for the whole object. `truncated:true` means any bound applied.
- Omit `work` if no items remain. Completed, failed (exposed as `interrupted`), cancelled and interrupted runs retain whatever work arrived, including a Platform interruption after partial streaming.
- Older messages may carry `metadata.agent_work.activity` from the previous system. Render those records read-only, without restoring removed actions. Older releases ignore the unknown `work` metadata key; the Pi-native reader before `af47c14` decodes and returns the metadata object without a closed-key schema. No database schema migration is required.

## Standard chat
- GET `/api/chat/models` → `{allowed_models:[string],default_model_id:string}`.
- GET `/api/chat/conversations` → `{conversations:[Conversation]}`; POST same `{title?,model_id?}` → `{conversation}`.
- GET/PATCH `/api/chat/conversations/{id}` → `{conversation}` (patch `{title?,model_id?}`); DELETE same → `{ok:true}`.
- Conversation: `{id,user_id,title,model_id,created_at,updated_at,deleted_at:null}`.
- GET/POST `/api/chat/conversations/{id}/messages`, GET `.../events`, POST `.../cancel`, POST `.../compact`: same shapes as agent conversation routes. Chat tools are only Pi built-ins plus web search/fetch. Model must be allowed by admin policy.
- One chat sandbox is shared by all conversations of one user (`chat-user-<id>`, profile `chat`). The security boundary is the user. File tools reject paths outside `/workspace/<conversation_id>`; bash starts there but may access that same user's other conversation files. Conversation deletion removes only its directory.

## SSE
Each event uses `id: <seq>`, `event: <type>`, `data: <JSON>`. Event object includes `{seq,type,...}`. Types: `message {message}`, `text_delta {delta}`, `thinking_delta {delta}`, `tool_start {tool_call_id,name,args}`, `tool_update {tool_call_id,partial}`, `tool_end {tool_call_id,name,is_error,content_preview,details}`, `retry {attempt,max,delay_ms,error}`, `compaction {phase,reason}`, `run_end {status,text,usage,model,error?,message}`. Reconnect using `after` or Last-Event-ID. `interrupted` is a visible terminal state; no automatic resubmission.
Message pages are ascending by id; `next_before_id` is null at the oldest page. SSE sequences are globally monotonic, durable, and filtered by authorized scope. Without `after`, events replay from the beginning; reconnect with the latest sequence. User messages broadcast when queued; assistant messages are inserted only at termination, including interruption.
The page `last_seq` watermark is the active job's starting sequence, or the current scope maximum while idle; use it for the initial SSE `after` to recover partial output without replaying old runs. Last-Event-ID wins over the query parameter on reconnect. User message metadata includes `author_user_id` and `author_display_name`, and `message` also announces transition to running. Reset, chat deletion and chat updates return 409 while busy; cancel first. Manual compaction instead joins the FIFO.
Manual compaction emits `compaction` events with `{phase:"queued"|"start"|"end",job_id,status,reason?,error?,after_message_id?}`. Status is `queued`, `compacting`, `done`, `nothing_to_compact`, `interrupted`, or `cancelled`; `nothing_to_compact` carries `reason:"too_small"` and is a successful no-op, not an error. `after_message_id` is the operation's place in the transcript: the newest message when it started (or settled without starting), excluding user messages still queued behind it; `null` for an empty conversation; absent while queued. The messages-page `compaction` object retains `{job_id,status,reason?,error?,after_message_id?}` for reloads. Manual compaction creates no artificial conversation messages. Automatic compaction during a model run retains its existing `compaction {phase:"start"|"end",reason}` events.
Open event streams recheck the signed session and current authorization before emitting each batch; revocation terminates the stream. After uncertain submission or stream loss, the interrupted prompt is never resubmitted. Platform cancels and settles any still-live run for that session, even without a successor job; uncertain work continues blocking Manager readiness until settled. After a Runtime restart there may be no live run to cancel: Platform continues the queue; untracked Manager commands are not reclaimed and expire under their finite command timeout.

## Attachments and workspace
- POST `/api/attachments?scope=private|channel-<id>|chat-<uuid>` multipart field `file` → `{attachment}`. Attachment `{id,filename,mime_type,size_bytes,url,preview_url}`.
- GET `/api/attachments/{id}` authenticated download; GET `/api/attachments/{id}/preview` image/document preview.
- Previews: images return PNG thumbnails; PDF returns inline PDF with a sandbox policy; DOCX/XLSX/PPTX and text return bounded `text/plain` previews. Other formats have `preview_url:null`. Originals live outside tenant-writable workspaces; copies for model tools are made into scope uploads. Uploads are limited to 32 MiB each; aggregate inline image data is limited to 12 MiB before message acceptance.
- GET `/api/workspace/files?path=` → `{files:[{name,path,is_dir,size_bytes}]}`; GET `/api/workspace/download?path=` authenticated download. Paths relative to personal workspace.
- Agent `MEDIA: /workspace/path` output creates normal authorized downloadable attachments.
`MEDIA:` lines remain in message content for compatibility; attachments are additionally rendered as download links.

## Browser (personal AI only)
- GET `/api/browser` → `{tabs:[],lease:{holder_user_id,expires_at}|null}`.
- POST `/api/browser/action` `{action,arguments:{},holder_id}` → `{content,data,is_error}`.
- POST `/api/browser/lease` `{holder_id:"per-tab UUID"}` → `{lease}` (acquire/renew, 60 seconds); DELETE same with `{holder_id}` → `{ok:true}`. Another holder (including another tab of the same user), or agent action during takeover, returns HTTP 409.
- GET `/api/browser/screenshot?tab_id=` → PNG.
- Browser actions include `new_tab {url}`, `navigate {tab_id,url}`, `click {tab_id,x,y}` or `{tab_id,ref}`, `type {tab_id,text,mode:"keyboard"}` (without a ref), `press {tab_id,key}`, `scroll {tab_id,direction,amount}`, `back|forward|refresh {tab_id}`, `snapshot {tab_id}`, and `close {tab_id}`. New tabs return Camofox `tabId`; tab lists retain Camofox tab objects. Screenshot coordinates are viewport pixels.
- Navigation permits ordinary LAN targets but rejects dangerous address ranges, credential-bearing URLs and the Platform container's own interface subnets. This entry-point check does not intercept every in-page redirect/link; see the documented residual risk in [security and trust](../design/security-and-trust.md).

## Schedules
- GET `/api/schedules` → `{schedules:[]}`; POST same `{name,prompt,schedule,timezone?}` → `{schedule}`.
- GET/PATCH/DELETE `/api/schedules/{id}` → `{schedule}` / `{ok:true}`.
- POST `/api/schedules/{id}/{pause|resume|run-now}` → `{schedule}`.
- GET `/api/schedules/{id}/runs` → `{runs:[]}`.
- Schedule: `{id,name,prompt,schedule,timezone,delivery:"chat",state,enabled,next_run_at,last_run,created_at,updated_at}`. Schedule specification: `{type:"once",at:ISO}` or `{type:"interval",every_seconds:n}` or `{type:"cron",expression:string}`. Each occurrence queues personal AI work.

## Admin and model settings
- GET `/api/admin/users` → `{users:[]}`; POST same `{username,password,display_name?,role?,permission_group?,model_name?,thinking_depth?}` → `{user}`; PATCH `/api/admin/users/{id}` same mutable user fields plus `{password?,active?}` → `{user}`; DELETE same → `{ok:true}` (deactivate/revoke).
- POST `/api/admin/users/{id}/impersonate` with `{}` → `{user}` for the target, and sets a fresh normal session cookie for that account (same attributes as login), replacing the admin's cookie. Admin only and same-origin; 404 if the target is missing or deactivated, 400 if it is the caller. The target's `token_version` and other sessions are untouched.
- GET/PUT `/api/admin/users/{id}/chat-model-policy` → `{allowed_models:[string],default_model_id:string}`. PUT takes that exact shape.
- GET `/api/admin/permission-groups` → `{groups:[{name,permissions:[string]}]}`; PUT same `{groups:[...]}` → same.
- GET/PATCH `/api/admin/branding` → `{branding}`; patch accepts branding fields.
- GET `/api/admin/models` → `{models:[{id,name,contextWindow?,maxTokens?}],connected:boolean}`. Positive token limits are included when advertised by the provider and forwarded to Runtime; visible authorized Codex model IDs are not limited to a bundled static list.
- POST `/api/admin/oauth/start` `{}` → `{flow_id,provider,kind,status,complete,expires_at,verification_url,user_code,poll_interval}`; POST `/api/admin/oauth/{flow_id}/poll` `{}` → same, status `waiting_for_user` or `complete`. DELETE `/api/admin/oauth` → `{ok:true}`.
- GET `/api/admin/usage` → `{input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cache_hit_ratio,events:[]}` (ratio cache_read/(input+cache_read), zero when denominator zero).
- GET `/api/admin/system` → Manager `/v1/status` JSON unchanged; GET/PATCH `/api/admin/system/config` → Manager config unchanged; POST `/api/admin/system/check` `{idempotency_key}` → Manager check unchanged; POST `/api/admin/system/operations` `{operation,idempotency_key,expected_generation?}` → Manager operation unchanged.
- Roles and permission groups are independent. Editable permission catalog: `read_workspace`, `chat`, `private_agent`, `manage_channels`, `manage_users`, `system_settings`. Existing group names may be retained or new groups added; a referenced group cannot be removed.
- `thinking_depth`: `off|minimal|low|medium|high|xhigh`. Model catalog choices apply to both personal and chat models; chat policy defaults must belong to its allowed list.
- Branding `logo` accepts a PNG/WebP data URL (maximum 256 KiB and 4096 pixels per dimension); null clears it.
- OAuth `expires_at` is epoch seconds, not an ISO date. Expired device flows return HTTP 410.
- Usage totals are all-time; `events` contains the newest 200 events without date filters. Events contain id/user_id/username/display_name/scope_type/scope_id/scope_name/request_message_id/response_message_id/provider/model/input_tokens/output_tokens/total_tokens/degraded/created_at and parsed `raw_usage` (including cache counters).
New events add `raw_usage.kind:"agent"|"chat"|"compaction"`; missing kind on old rows means agent. `scope_name` holds the channel name or chat conversation title, and is empty for personal AI. Chat keeps legacy `scope_type:"private"` but uses its conversation UUID as `scope_id`. Completed manual compaction records the Runtime-reported input/output/cache usage and model with null request/response message IDs; its tokens contribute to totals and cache-hit ratio. `nothing_to_compact` creates no token-usage event.

## Internal contracts
Manager bearer routes and health remain byte-compatible; healthz `{status:"ok",service:"agent-platform"}`. POST `/internal/manager/update/{readiness|commit-release|abort-release}` body `{operation_id}`; readiness `{reserved,active_agent_tasks,queued_agent_jobs,running_agent_jobs,admissions_in_progress,blocker_error}`; release `{released:true}`. GET `/internal/manager/health` includes status, schema_version, update_reserved and readiness counters.
Internal health additionally includes `reserved:false`; `update_reserved` reports actual reservation ownership. Abort with any nonempty operation id is idempotently successful when unreserved. Commit replays only the most recently committed id while unreserved; a competing owner returns 409. A failed commit keeps admission frozen.
Installed container startup requires successful Manager reservation recovery before starting workers or schedules. An absent or unreachable control socket fails startup; it never disables the Manager boundary.
Runtime bearer POST `/api/agent/tools/credentials/resolve` `{provider,model,scope_key?,force_refresh?}` → `{provider,access_token,token_type:"Bearer",expires_at,base_url,model}`. POST `/internal/agent/tools/{web|browser|schedule}` `{action,arguments,context:{sid,scope_key,run_id,owner_user_id?,channel_id?}}` → `{content,data,is_error}`.

## Migration
`enterprise-agent-platform migrate` creates the live tables if missing and then applies an ordered list of forward migrations recorded in `schema_migrations`. Each version is applied once, in the same transaction and file lock as the schema statements; the highest recorded version is the `schema_version` that health and the release contract report. Migration `2026100101` (`drop-pre-pi-rollback-compat`) drops the tables, triggers and full-text indexes of removed features, deletes `durable_jobs` rows whose kind is not `agent`, and removes the obsolete `durable_agent_jobs_start_message_id` setting and the `pi_schema_migrations` ledger. No pre-Pi data is retained.

New personal/channel scopes record their workspace, sandbox and lifecycle identity in `agent_scopes`. Workspace `AGENTS.md` and `.agent-platform/skills` are read as they are on disk.
