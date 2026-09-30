# Agent Runtime

Runtime embeds `@earendil-works/pi-coding-agent@0.87.1`. The [Runtime API](../reference/runtime-api.md) is the wire contract; [Platform](../reference/platform-api.md) owns product-facing APIs.

## One Pi session per conversation

Create one `AgentSession` with `createAgentSession`, a supplied model runtime, `SessionManager.open(file)`, an empty private agent directory and a custom resource loader. The loader returns only Platform-supplied resources: no host filesystem discovery, package discovery or tenant extensions.

Platform chooses stable session IDs: `agent-private-<uid>`, `agent-channel-<cid>` and `chat-<conversation_id>`; reset may rotate an ID. Only one run can use an ID at a time. Platform queues later messages FIFO. Idle objects are disposed after 15 minutes; persisted history survives. Pi owns retries, default compaction and manual `/compact`.

## Tools and remote operations

Pi's `read`, `edit`, `write`, `find` and `ls` use remote operations. `grep` is a custom sandbox `rg` adapter because Pi 0.87.1's stock grep starts a local process. `bash` also uses a sandbox adapter so large output spills inside the sandbox rather than Pi's local temporary files. Runtime never executes tenant commands locally.

Each Manager file/terminal execution consumes a fresh audit receipt; terminal audit details contain the exact command. Commands run foreground with a finite timeout: bash defaults to 10 minutes and permits an explicit Pi timeout up to one hour. Edits use remote read/write. Never forward Pi BashOperations `options.env` into the sandbox.

- Personal AI: built-ins, web search/fetch, browser, schedule and MCP.
- Channels: built-ins and web search/fetch.
- Chat: built-ins and web search/fetch only; no AGENTS.md or skills.

Web/browser/schedule are thin Platform gateway tools. MCP invokes the image's stdio helper inside the personal sandbox. Bundled skills live in Runtime at `/app/skills/`; read-only `/platform-skills/` locations are served by Runtime's read adapter. Workspace skills are ordinary `SKILL.md` files.

Resolve file paths inside the workspace and reject escapes. Chat file tools enforce the conversation directory; bash starts there but can access other chat directories belonging to the same user. The per-user sandbox is the execution boundary.

## Prompt cache

Platform sends the system prompt, AGENTS.md, skill advertisements, tools and sandbox with every run. Runtime reuses the live session object while these inputs are unchanged; when any differs, it opens a new Pi session object on the persisted transcript and leaves reconciliation to Pi. Pi keeps the transcript's leading system prompt as the request instructions and appends only the changed sections as a system update, so the cached prefix is never rewritten and an edited AGENTS.md applies from the next message. Each change adds one copy of the changed section to the context until compaction. Runtime adds no reload schedule of its own. Branding controls the fixed product/agent wording.

Current time, display name and timezone go into a short user-message prefix, never the system prompt. History is append-only; Pi compaction appends its own entries. Use `SettingsManager.inMemory({cacheWarming: 'off'})` with Pi retry/compaction defaults. Keep the conversation session ID stable for Codex's `prompt_cache_key`; auxiliary LLM calls use stable prefixes and that same ID. Platform records input/output/cache-read/cache-write usage and exposes cache-hit ratio.

## Credentials and completion

Platform owns OAuth storage and refresh. Runtime resolves credentials through the authenticated Platform endpoint; forced Codex refresh returns to Platform rather than writing another credential store.

Run completion follows Pi's settled/idle state, not a provisional end before retry. Stream tool, text, thinking, retry and compaction events; retain events for up to 10 minutes after completion within bounded replay storage. Expired/evicted cursors require explicit recovery, not silent truncation; exact limits are in the Runtime API. No drafts, completion guards, approvals, subagents or background-process controller. The side-effects flag becomes true when bash/write/edit, browser or schedule mutation, or an MCP call starts; cancellation cannot promise rollback.

Session cancellation waits for active admission/run work with a bounded HTTP response deadline and is idempotent when idle. Unconfirmed Manager termination keeps the session fenced and withholds terminal completion; retry cancellation against the same run rather than starting another. Runtime restart does not discover or clean up orphan sandbox commands; this is an accepted limitation, bounded by terminal execution deadlines. Manual compaction receives Platform's chosen summary model/thinking settings, including for a cold session. Exact requests and timeout responses belong in the [Runtime API](../reference/runtime-api.md).

## Migration

At startup, use Platform's `migration/active-sessions.json` to find active format-4 journals by identity. Write all message entries in order to `sessions-v3/<sha256(sid)>.jsonl`, including history predating compaction; append the latest old compaction summary with the first retained message ID. Stage each file and rename atomically; write `.migrated-from-v4` last. Never modify `sessions/` or `sessions.pre-pi/`. Old lifecycles and delegate journals remain on disk but are not imported. See [data and sessions](data-memory-sessions.md).

Each startup reconciles import provenance against the old journal. If rollback changed that source and Pi has not appended to the imported v3 history, archive the prior import and re-import it. If Pi has added turns, or provenance cannot be established, preserve v3 history and warn rather than silently discarding turns. Old source journals remain untouched.
