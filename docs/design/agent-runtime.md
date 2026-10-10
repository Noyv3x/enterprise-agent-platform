# Agent Runtime

Runtime embeds `@earendil-works/pi-coding-agent@0.99.2`. The [Runtime API](../reference/runtime-api.md) is the wire contract; [Platform](../reference/platform-api.md) owns product-facing APIs.

## One Pi session per conversation

Create one `AgentSession` with `createAgentSession`, a supplied model runtime, `SessionManager.open(file)`, an empty private agent directory and a custom resource loader. The loader returns only Platform-supplied resources: no host filesystem discovery, package discovery or tenant extensions.

Platform chooses stable session IDs: `agent-private-<uid>`, `agent-channel-<cid>` and `chat-<conversation_id>`; reset may rotate an ID. Only one run can use an ID at a time. Platform can steer eligible interactive messages into that run; other messages queue FIFO. Idle objects are disposed after 15 minutes; persisted history survives. Pi owns retries, default compaction and manual `/compact`.

Runtime accepts idempotent, bounded steering inputs from run creation until its session prompt returns. It queues literal user messages through Pi's agent, with all pending messages delivered together in acceptance order at the next turn boundary, including after a provisional final answer. It does not expand skill commands or prompt templates. The input's author/timezone prefix and images follow ordinary run-prompt construction. Delivery is observed when Pi starts the user message; delivered messages are persisted in the same transcript. Closing a run clears Pi's queues and reports accepted but undelivered inputs, so no input leaks into a later run. Cancellation stops admission immediately; a delivery whose outcome is uncertain is not automatically replayed.

## Tools and remote operations

Pi's `read`, `edit`, `write`, `find` and `ls` use remote operations. `grep` is a custom sandbox `rg` adapter because Pi 0.99.2's stock grep still starts a local process. `bash` also uses a sandbox adapter so large output spills inside the sandbox rather than Pi's local temporary files. Runtime never executes tenant commands locally.

Each Manager file/terminal execution consumes a fresh audit receipt; terminal audit details contain the exact command. Channel, chat and subagent commands run foreground with a finite timeout: bash defaults to 10 minutes and permits an explicit Pi timeout up to one hour. Edits use remote read/write. Never forward Pi BashOperations `options.env` into the sandbox.

- Personal AI: built-ins, web search/fetch, browser, schedule, MCP, and the background tools `task`, `job` and `wait` with an extended `bash`.
- Channels: built-ins and web search/fetch.
- Chat: built-ins and web search/fetch only; no AGENTS.md or skills.
- Subagents (`kind:subagent`, scope `private:<uid>/delegate/bg-<n>`): a Platform-chosen subset of the built-ins plus web search/fetch, foreground bash only, no AGENTS.md, and never `task`, `job`, `wait`, browser, schedule or MCP.

Personal `bash` runs the command as a Manager-supervised process that Runtime follows by long-polling its log. It stays in the foreground, with today's output format, while it ends within 60 s; at 60 s, on `async`/`name`, or when a user message is inserted into the run, it is promoted without a rerun: Runtime detaches it from the run, registers it with Platform as task `bg-<n>` and returns at once. A `name` starts a service with no deadline and stdin open and optionally waits for log/port readiness. Unpromoted processes die with the run; promoted ones belong to Manager and outlive Runtime and the run. `task`, `job` and `wait` are thin Platform gateway tools, available only in the root personal scope, so subagents cannot spawn subagents. See the [Runtime API](../reference/runtime-api.md#personal-bash-background-processes-and-task-tools).

Web/browser/schedule are thin Platform gateway tools. MCP invokes the image's stdio helper inside the personal sandbox. Bundled skills live in Runtime at `/app/skills/`; read-only `/platform-skills/` locations are served by Runtime's read adapter. Workspace skills are ordinary `SKILL.md` files.

Resolve file paths inside the workspace and reject escapes. Chat file tools enforce the conversation directory; bash starts there but can access other chat directories belonging to the same user. The per-user sandbox is the execution boundary.

## Prompt cache

Platform sends the system prompt, AGENTS.md, skill advertisements, tools and sandbox with every run. Runtime reuses the live session object while these inputs are unchanged; when any differs, it opens a new Pi session object on the persisted transcript and leaves reconciliation to Pi. Pi keeps the transcript's leading system prompt as the request instructions and appends only the changed sections as a system update, so the cached prefix is never rewritten and an edited AGENTS.md applies from the next message. Each change adds one copy of the changed section to the context until compaction. Runtime adds no reload schedule of its own. Branding controls the fixed product/agent wording.

Current time, display name and timezone go into a short user-message prefix, never the system prompt. History is append-only; Pi compaction appends its own entries. Use `SettingsManager.inMemory({cacheWarming: 'off'})` with Pi retry/compaction defaults. Keep the conversation session ID stable for Codex's `prompt_cache_key`; auxiliary LLM calls use stable prefixes and that same ID. Platform records input/output/cache-read/cache-write usage and exposes cache-hit ratio.

## Credentials and completion

Platform owns OAuth storage and refresh. Runtime resolves credentials through the authenticated Platform endpoint; forced Codex refresh returns to Platform rather than writing another credential store.

Run completion follows Pi's settled/idle state, not a provisional end before retry. Stream tool, text, thinking (`thinking_start`/`thinking_delta`/`thinking_end` for each reasoning block, including empty blocks), retry and compaction events, delivery acknowledgements (`input_delivered`), plus live bash output (`tool_output`) and tool-call argument generation (`tool_input_start`/`tool_input_delta`), both coalesced and capped, with `tool_start`/`tool_end` authoritative; retain events for up to 10 minutes after completion within bounded replay storage. Terminal `run_end` always includes the undelivered input IDs. Expired/evicted cursors require explicit recovery, not silent truncation; exact limits are in the Runtime API. No drafts, completion guards, approvals, subagents or background-process controller. The side-effects flag becomes true when bash/write/edit, browser or schedule mutation, or an MCP call starts; cancellation cannot promise rollback.

With thinking enabled, Pi requests reasoning summaries with `summary: auto`, which OpenAI documents as the most detailed available for most reasoning models; raw reasoning text is also forwarded when a model exposes it.

Session cancellation waits for active admission/run work with a bounded HTTP response deadline and is idempotent when idle. Unconfirmed Manager termination keeps the session fenced and withholds terminal completion; retry cancellation against the same run rather than starting another. Runtime restart does not discover or clean up orphan sandbox commands: unpromoted processes are bounded by their deadlines and by Manager's lease handling, promoted ones are owned by Manager and Platform. Manual compaction receives Platform's chosen summary model/thinking settings, including for a cold session. Exact requests and timeout responses belong in the [Runtime API](../reference/runtime-api.md).

## Session storage

Sessions are Pi JSONL version 3 files under `sessions-v3/<sha256(sid)>.jsonl`; existing files open without rewriting and custom entries already in them stay readable. Built-in MCP/codemode and virtual models remain disabled by the supplied resource loader. Runtime performs no session migration or import at startup. See [data and sessions](data-memory-sessions.md).
