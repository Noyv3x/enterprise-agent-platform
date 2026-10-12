# Product boundaries

The platform is a shared, browser-based product built around plain Pi. Platform owns users and product state; Pi owns the agent session. Deployment requires the host Manager. See [architecture](system-architecture.md) and the [Platform API](../reference/platform-api.md).

## Conversation modes

| Mode | Ownership and tools |
| --- | --- |
| Personal AI | One persistent workspace and sandbox per user; Pi file/shell tools, web search/fetch, browser with human takeover, schedules the personal AI manages itself with its schedule tool, MCP connectors (remote servers and local servers in its sandbox), and [subagents and background tasks](#subagents-and-background-tasks) (`task`, `job`, `wait`, background and service `bash`). |
| Channels | A shared conversation and workspace per channel; Pi file/shell tools and web search/fetch, plus the channel workspace's skills and the organization [MCP connectors](#mcp-connectors) with shared credentials that a channel manager enabled for it. Visibility and management use existing permission groups, not a new membership table. |
| Standard chat | Many conversations per user, each with its own working directory and history. Pi file/shell tools and web search/fetch, plus remote [MCP connectors](#mcp-connectors) (its sandbox has no network, so no local servers); no browser, schedules or AGENTS.md context. Chat can use built-in and organization skills (no workspace skills). |

Standard chat supports create, rename and delete. Titles are never generated automatically: a new chat starts as `New chat` and changes only when the user renames it. Users neither see nor change any model or thinking depth, in the personal AI or in chat. Each account belongs to one administrator-managed model policy group (策略组) that sets a model and thinking depth per usage slot: personal AI (also schedules and background-task notices), channel main agent, chat (whose reasoning summaries are shown too), `scout` subagents and `task` subagents. A lower-spec group can serve accounts that do only simple work.

Chat conversations share one network-disabled sandbox per user. File tools restrict the active conversation directory; bash starts there but may access that user's other chat files. The security boundary is per user, not per conversation.

Messages sent during an interactive run are inserted into that run at the AI's next step boundary, unless earlier queued work or cancellation requires a separate turn. Schedule occurrences and compaction remain FIFO. Failed or lost runs are visibly interrupted, not automatically resubmitted; users can resend deliberately. See the [insertion and settlement rules](../reference/platform-api.md#mid-run-insertion).

## Kept features

- Login, users, administrators and permission groups; administrators can sign in as another active account (管理员代入) from the account editor.
- Attachment upload/download, document previews, generated-file links and personal workspace files.
- Artifacts (作品): what the AI publishes for the user to look at, versioned, in a viewer panel (see [Artifacts](#artifacts)).
- Model policy groups, Codex device OAuth, token usage and cache-hit reporting.
- Branding, theme and three locales.
- Scheduled tasks are not a user feature and have no user page; the personal AI creates, changes and reviews them through its own `schedule` tool, and each occurrence runs in the owner's personal AI.
- Host Manager update status and controls.

## Artifacts

The AI publishes things the user should look at as **artifacts** in all three conversation modes, much like Claude Artifacts, instead of leaving a file to download. Supported content: articles (Markdown), single HTML pages, complete multi-file websites (HTML, CSS, JS and assets; links and resources work), SVG, Mermaid diagrams, charts (an HTML page using any chart library), tables (CSV/TSV), code, images and PDF. The AI publishes with its `artifact` tool, or by a standalone `MEDIA:` line for the previewable text kinds (HTML, Markdown, SVG, Mermaid, CSV/TSV); Office files, PDFs and other downloads stay ordinary attachments.

- **Versions.** An artifact is the published path in a conversation. Publishing the same path again creates a new version; identical content creates none. The user can switch versions, diff text versions and download any version. The AI is told to keep the path when revising rather than creating `v2`/`v3` copies.
- **Isolation.** Artifact pages run isolated and never receive the user's session or the platform APIs. Network access from artifact pages is deliberately unrestricted (any CDN, any fetch); see [security](security-and-trust.md#artifacts) for the risk.
- **Scopes.** Personal AI artifacts belong to the owner, chat artifacts to the conversation (deleted with it) and channel artifacts to everyone who can read the channel.
- **Limits.** At most 1000 files, 32 MiB per file and 50 MiB per version.

Not provided yet: click-to-annotate feedback on a page, AI self-check screenshots of an artifact and running dev-server previews. Interfaces: [Platform API](../reference/platform-api.md#artifacts), [frontend](frontend.md).

## Pi-native resources

Long-term memory is workspace `AGENTS.md`, editable by the agent using ordinary tools. There is no dedicated memory system. Retry, compaction and transcript persistence use Pi's `AgentSession` and `SessionManager`.

## Skills

Skills follow the open Agent Skills standard (agentskills.io, the format Claude and Codex also use): a folder with a `SKILL.md`. There are three tiers. **Built-in** skills ship with the platform. **Organization** skills are installed and assigned to permission groups by administrators. **Personal** skills (channel skills in a channel) are installed by the user or by the AI. A user can call a skill explicitly by starting a message with `/<skill-name>`; the composer's `/` menu lists the scope's skills.

Installing, updating and removing personal skills (by the user or the AI) needs the `install_extensions` permission; administrators can withhold it per permission group. Without it, the user's personal skills are not offered to the AI and the install controls are hidden. Users can switch individual skills off for themselves.

Users often paste setup instructions written for other AI products (Claude Code, Claude Desktop/claude.ai, Codex, Cursor, Gemini CLI, OpenCode). The AI is told to carry out their intent with this platform's conventions: the `skill` tool for skills and the `mcp` tool's `import` and `add` for MCP servers. A sandbox start-up step additionally moves skills that a literal install left in `.claude/skills`, `.codex/skills` or `.agents/skills` into the standard directory.

## MCP connectors

MCP connectors give the AI tools, resources and prompts from other systems (Notion, GitHub, an internal service, a local `npx`/`uvx` server). Design and limits: [integrations](integrations.md#mcp); shapes: [Platform API](../reference/platform-api.md#mcp).

- **Organization connectors** are added by administrators and assigned to permission groups. Credentials are per user (each user clicks 连接 and signs in, or enters their own key) or shared (the administrator connects once). Channels can use only shared ones, and only when a channel manager enabled them for that channel.
- **Personal connectors** are added by the user in 设置 → 连接器 or by the AI, and need the existing `install_extensions` permission (administrators can withhold it per group). Local servers run persistently in the user's own sandbox; chat has no local servers because its sandbox has no network.
- Sign-in is one click; API keys and headers are entered in a secure form and never through the chat; the AI is told never to ask for them. Credentials live in Platform only: Runtime, the model and the sandbox never see remote tokens or keys.
- Each tool is a directly callable tool for the AI (with a deferred catalog when there are many); administrators and owners can switch individual tools off. Subagents get the parent's tools: `scout` only read-only ones, `task` all.
- Prompts a server offers appear in the composer `/` menu as `/<connector>:<prompt>`. A server's request for input appears in the conversation as a form or a link; only the person whose message started the run can answer it.
- Config files for other products (`claude mcp add`, `.mcp.json`, `claude_desktop_config.json`, `~/.codex/config.toml`, Cursor, VS Code, OpenCode) found in the workspace are offered for one-click import and are never enabled automatically; pasted instructions are translated by the AI through the `mcp` tool's `import`.
- Tool output is untrusted data. Every call is audited (who, which connector and tool, status and duration, never content). Sampling is not supported.

## Subagents and background tasks

Only the personal AI can run work in the background; channels and standard chat are unchanged and foreground-only.

- **Subagents.** The `task` tool starts one to eight subagents at once and returns immediately. Type `scout` is read-only research (read, grep, find, ls, web search/fetch); type `task` is a general worker that may also use bash, edit and write. Children share the parent's sandbox and workspace, run foreground commands only, cannot start further subagents, and finish with a final report that the AI receives automatically.
- **Background processes.** `bash` can run a command in the background (`async`), start a named long-lived service with readiness checks, or be promoted automatically when a foreground command runs past 60 seconds or the user sends a message meanwhile. Processes are supervised by Manager and survive the end of the AI's turn. `job` lists, reads, feeds input to and stops them; `wait` blocks for the next result.
- **Identity.** Every subagent or process is a task named `bg-<n>`; the user sees it in the work trace and in the computer panel's background-task section, where processes show a read-only output viewer and any task can be stopped.
- **Results reach the AI exactly once.** If a task finishes after the AI's turn ended, Platform starts a new turn in the personal conversation to process the result, recorded as a `task_notice` system message. A result already delivered through `wait` or `job` is not delivered again.
- **Limits.** Per user at most 8 running subagents and 16 running background processes; no lifetime limit (`timeout: 0` means no deadline). Not provided: per-child workspace isolation, port publishing or preview URLs, nested subagents, and automatic restart of interrupted processes.
- **Restarts.** A running subagent blocks system updates until it settles; if Platform restarts or the Runtime stream is lost it becomes `interrupted` and is never replayed. Background processes do not block updates, but a Manager restart stops every sandbox: processes are recorded `interrupted` (reason `system_restart`) and the AI is told.

Interfaces: [Platform API](../reference/platform-api.md#background-tasks), [Runtime API](../reference/runtime-api.md), [security](security-and-trust.md#background-tasks-and-subagents).

## Removed features

No Telegram, mail, approvals, host execution, todo system, live file drafts, learning reviews, dedicated memory management, execution-review or `needs_review` machinery. Subagents and background processes exist only in the personal AI (see above); channels and standard chat stay foreground-only. There is no recurring-schedule continue/complete decision guard, regex completion guard or Firecrawl stack.

Tables of removed features are dropped by migration. Historical messages remain readable, including old `agent_work` activity rendered read-only; this does not imply continued support for their old actions.

## Delivery boundary

The Pi-native product uses five images. Manager simplification requires a settled launcher-based installation and five-image retained generations. Full local checks and isolated staging with copied data and a real model precede release; see [deployment](../operations/deployment.md).
