# Integrations

Tool request/response shapes belong in the [Runtime API](../reference/runtime-api.md) and [Platform API](../reference/platform-api.md). Internal web/browser/schedule/tasks/skills/artifacts/mcp gateways require the agent-tool bearer and trusted run/scope context.

## Web search and fetch

`web_search` uses managed SearXNG. `web_fetch` uses direct Platform HTTP GET with public-address SSRF validation on the initial URL and every redirect, time/size limits and HTML-to-Markdown extraction. There is no Firecrawl, PostgreSQL queue, Redis, RabbitMQ or Playwright fetch stack.

All three conversation modes can search/fetch. Chat's sandbox has no network; its web requests use the Platform gateway, not sandbox networking. See [web trust rules](security-and-trust.md#web-and-browser).

## Browser and human takeover

Personal AI uses managed Camofox with a Platform-derived per-scope identity. The computer panel displays screenshot previews and permits human takeover. One holder owns an expiring lease; agent browser actions return busy while a human holds it. Releasing or expiring the lease returns control to the agent. Browser support is absent from channels and standard chat.

Camofox is a separate managed capability. Its outage may degrade browsing without making core login/conversation services unavailable.

## Artifacts and MEDIA

The AI shows things to the user in two ways. Runtime's `artifact` tool (publish, list) is a thin call to the internal `artifacts` gateway in every root run (personal, chat and channel; never subagents), and Platform owns the artifact records and blobs. A standalone `MEDIA: <sandbox cwd>/path` line in the final reply keeps delivering downloads as before, with one change: a MEDIA file of a previewable text kind (`.html`, `.htm`, `.md`, `.markdown`, `.svg`, `.mmd`, `.mermaid`, `.csv`, `.tsv`) publishes an artifact version instead of creating an attachment (the same snapshot, limits and version rules as the tool; the run's reply links to it like any other published version). Images, PDFs, Office files and every other extension stay attachments, so existing DOCX/XLSX/PPTX/PDF skills are unchanged. A MEDIA delivery that cannot be published (outside the workspace, over a limit, vanished) is skipped, as attachments are. The `MEDIA:` line stays in the message text. Platform's system prompt tells the AI, in every scope, to publish what the user should look at with `artifact`, keep the same path when revising and use MEDIA only for downloads; built-in skills whose deliverable is an HTML or Markdown document say the same. See [Platform API](../reference/platform-api.md#artifacts) and [security](security-and-trust.md#artifacts).

## MCP

Platform is the MCP client. Runtime only proxies: each available tool becomes a Runtime tool whose call goes to the internal `mcp` gateway, so credentials, connections and results stay in Platform (the package is `enterprise_agent_platform/mcp`; shapes: [Platform API](../reference/platform-api.md#mcp)). It uses the official Python SDK (`mcp`, with its own `httpx2` client), which negotiates the protocol per server: Streamable HTTP in `auto` mode (2026-07-28, falling back to the 2025 handshake-era versions) and the explicit legacy HTTP+SSE transport. Sampling is not supported (deprecated in 2026-07-28); tools, resources, prompts and elicitation are.

**Connectors.** A connector is one MCP server.
- **Organization connectors** are added by administrators (remote only) and assigned to permission groups (`["*"]` = everyone). Credentials are *shared* (the administrator connects once; every use runs as that account) or *per user* (each user authorizes or enters their own).
- **Personal connectors** are added by the user or by the AI and need `install_extensions`. Remote ones work in the personal AI and in chat; local stdio servers (`npx`, `uvx`, …) work only in the personal AI.
- **Channels** use only organization connectors with shared credentials that someone who manages channels enabled for that channel; never personal or per-user ones.
- **Subagents** get the parent's tools filtered by type: `scout` only tools annotated `readOnlyHint: true`, `task` all of them.

Transport is `http` (Streamable HTTP, negotiated), `sse` (legacy) or `stdio`; authentication is `none`, `headers` (API keys entered in a secure form, stored in Platform, never through the chat) or `oauth` (the user clicks 连接 and signs in; see [Remote MCP](security-and-trust.md#remote-mcp-network-policy-and-oauth)).

**Stdio servers** run persistently in the owner's personal sandbox, not once per call: Platform starts the command through Manager's stdio channel with a custom SDK transport, passes env values from storage in the receipt-bound start (never in argv), and reconnects lazily after the sandbox stops, never replaying a `tools/call` after an uncertain failure. The channel's rules are in [security](security-and-trust.md#effects-and-recovery) and the [Runtime API](../reference/runtime-api.md).

**Connections and catalogs.** One connection per (connector, credential owner), opened on first use and closed after 10 minutes idle. Tools, prompts and resources are cached (`mcp_catalog_cache`), refreshed on `list_changed` and when older than 10 minutes. A run never waits on a slow server: it uses the cache and refreshes in the background (the first ever fetch waits at most 20 s). Calls time out after 120 s (per-connector `timeout_s` up to 600 s; time spent waiting for the user does not count) and a cancelled run or gateway request cancels the server-side call.

**Tools for the AI.** A run payload carries `mcp: {tools, deferred, catalog_text?}` for the connectors that are available in the scope, enabled, connected (credentials present) and tools that are not switched off. Each tool is `mcp__<connector>__<tool>` (sanitized, at most 64 characters, a stable 6-hex hash suffix on truncation or collision) with the description prefixed `[<label>] ` and the input schema passed through. More than 40 tools or more than 64 KB of schemas switch to deferred mode: no individual tools, a `connector.tool — description` list in the system prompt and the `mcp` tool's `describe` and `call`. Results map to text, at most 4 images of 2 MiB, structured content as fenced JSON unless it repeats the text, resource links as lines, `isError` as an error, and text over 200 KB is truncated with a note.

**The `mcp` tool.** Every scope with a connector has it for `call`, `describe`, `list`, `list_resources` and `read_resource`. The personal AI also has `add`, `remove`, `import`, `connect`, `enable` and `disable` (with `install_extensions`), even when no connector exists yet. The AI never receives or asks for a secret: `add` declares `env_keys`/`header_keys` and Platform shows the user a card (`mcp_action_required`) with a secure form or a 连接 button.

**Confirmation.** What the AI adds or imports (and what a workspace file import creates) is `pending_confirmation` until its owner confirms the destination in the card or in settings; credentials, sign-in and tests wait for it. **Limits that never fail a run:** descriptions are cut to 4000 bytes, a tool whose schema is over 64 KB is not registered directly (it stays callable through `describe` and `call`), more than 200 tools or 64 KB of schemas defer, and `catalog_text` is capped at 60,000 bytes with a note.

**Prompts and resources.** MCP prompts appear in the composer `/` menu as `/<connector>:<prompt>`; picking one asks for its arguments and inserts the rendered text. Resources are read by the AI through `list_resources` and `read_resource`.

**Elicitation.** A server's request for input (a form from a JSON schema, or a link) appears as a card in the conversation of the run that triggered it (`mcp_elicitation`); both the legacy request and the 2026-07-28 `input_required` rounds are supported. Only the user who triggered the run can answer; the card times out as *cancel* after 10 minutes and nothing is ever answered automatically.

**Importing instructions written for other products.** `mcp` `import` parses Claude Code (`.mcp.json`, `~/.claude.json`, `claude mcp add …`, `claude mcp add-json`), Claude Desktop (`claude_desktop_config.json`), Codex (`~/.codex/config.toml`, `codex mcp add …`), Cursor and VS Code (`mcp.json`: `mcpServers`, `servers`, `mcp.servers`) and `opencode.json`. Literal secrets move into storage, `${VAR}` placeholders become missing secrets the user fills in a card, and every import creates connectors with source `import:<format>`. Foreign config files found in the personal workspace (the same set, one level deep) are only *offered* for one-click import in settings; nothing is ever enabled automatically. Earlier `/workspace/.agent-platform/mcp.json` files were imported once as personal local connectors by migration `2026101501` (source `legacy`).

**Audit.** Every call writes a row to `mcp_calls`: who, which connector and tool, status (`ok`, `error`, `cancelled`, `timeout`) and duration; never arguments or results. The latest 10,000 are kept and administrators read them in 管理 → 连接器.

## Instructions written for other products

Users paste install instructions written for Claude Code, Claude Desktop/claude.ai, Codex, Cursor, Gemini CLI or OpenCode. For the personal and channel AI, Platform's system prompt states that skills use the Agent Skills format and are installed, updated, removed or saved only with the `skill` tool, and tells the model to carry out the intent this platform's way: skills through the `skill` tool rather than `.claude/skills`, `~/.codex/skills` or `.agents/skills`; MCP servers (personal AI only; it alone manages connectors) through the `mcp` tool's `import` and `add` actions, with secret values entered by the user in a secure form and never in the chat, rather than `claude mcp add`, `codex mcp add`, `.mcp.json`, `~/.claude.json`, `~/.codex/config.toml` or `claude_desktop_config.json`; to tell the user in one plain sentence, in their language, that the instructions were for another product and how they were adapted; and to say plainly when a step cannot work here (the user's own computer, a desktop app, an app restart). The sandbox start-up step that migrates literal installs is a safety net, not the primary path. Skill installation is governed by `install_extensions` (see [security](security-and-trust.md#installed-skills)).

## Schedules

Schedules are managed only by the personal AI through its `schedule` tool (list/get/create/update/pause/resume/delete/run-now and `history` for past runs); users have no schedule UI or API. Each occurrence inserts a normal durable agent job in the owner's private scope, sending the schedule's `prompt` to the personal AI as a new message. Jobs share that conversation's FIFO ordering and produce ordinary messages and usage records.

Once, interval and cron timing use the configured timezone. The existing schedule/run tables remain authoritative. The tool is owner-scoped through the internal gateway. No continue-current/complete-current tool, completion decision guard or Telegram delivery remains. Standard chat and channel agents do not manage schedules.

## Subagents and background tasks

Personal AI only. Runtime's `task`, `job` and `wait` tools are thin calls to the internal `tasks` gateway; Platform owns the task records (`background_tasks`, identified to the model and the user as `bg-<n>`). Product behavior and limits: [product](product.md#subagents-and-background-tasks); shapes: [Platform API](../reference/platform-api.md#background-tasks).

- **Subagents** are Runtime runs of kind `subagent` on their own session, in the parent's sandbox, with the tool subset of their type. Platform consumes each child's events concurrently with the conversation's FIFO (a child never occupies the conversation queue), keeps a bounded work trace and result, records usage, and pushes throttled SSE `task` events.
- **Background processes** are supervised by Manager (not Runtime, not Platform). Runtime promotes or starts them and registers the Manager process id with Platform (`register_process`). Platform follows Manager's global state-change feed (`process/changes`, cursor kept in `settings.process_changes_cursor`) and reads current state on registration, so a process that ended before registration is still captured. Stop and input go to Manager's executor API with an audit receipt, using Platform's executor credential.
- **Delivery.** Each finished task is delivered to the model once: by `wait` (long-poll) or by an automatic notice turn; a process whose output Runtime already returned in full (registered with `delivered:true`) is never notified. A notice is a `system` message `task_notice` plus a durable queued job; several tasks finishing before it starts share one notice, and tasks delivered in the meantime are dropped, so the AI never processes a result twice.

## Models and OAuth

Administrators manage models and the Codex device authorization flow. Platform persists OAuth credentials and refreshes them; Runtime resolves access tokens through Platform, including forced provider refresh. Which model and thinking depth each usage gets is set by administrator-managed model policy groups and is not visible to users.

## Host Manager

Platform presents authenticated Manager status/configuration, check and update operations. Manager owns image pulls, resource-profile sandbox creation, maintenance and release recovery. See [automatic updates](../operations/auto-update.md); these controls are not agent host-execution tools.
