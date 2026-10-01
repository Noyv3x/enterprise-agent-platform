# Product boundaries

The platform is a shared, browser-based product built around plain Pi. Platform owns users and product state; Pi owns the agent session. Deployment requires the host Manager. See [architecture](system-architecture.md) and the [Platform API](../reference/platform-api.md).

## Conversation modes

| Mode | Ownership and tools |
| --- | --- |
| Personal AI | One persistent workspace and sandbox per user; Pi file/shell tools, web search/fetch, browser with human takeover, schedules and workspace-configured MCP. |
| Channels | A shared conversation and workspace per channel; Pi file/shell tools and web search/fetch. Visibility and management use existing permission groups, not a new membership table. |
| Standard chat | Many conversations per user, each with its own working directory, history and model selection. Pi file/shell tools and web search/fetch only; no browser, schedules, MCP, skills or AGENTS.md context. |

Standard chat supports create, rename and delete. Automatic titles are optional. Administrators set each user's allowed chat models and default; users choose only among allowed models. The personal AI retains its separate per-user model and thinking depth.

Chat conversations share one network-disabled sandbox per user. File tools restrict the active conversation directory; bash starts there but may access that user's other chat files. The security boundary is per user, not per conversation.

Messages sent during a run queue FIFO; they are not joined into the active input. Failed or lost runs are visibly interrupted, not automatically resubmitted. Users can resend deliberately.

## Kept features

- Login, users, administrators and permission groups; administrators can sign in as another active account (管理员代入) from the account editor.
- Attachment upload/download, document previews, generated-file links and personal workspace files.
- Model settings, Codex device OAuth, token usage and cache-hit reporting.
- Branding, theme and three locales.
- Schedule management and history; occurrences run in the owner's personal AI.
- Host Manager update status and controls.

## Pi-native resources

Long-term memory is workspace `AGENTS.md`, editable by the agent using ordinary tools. Skills are `SKILL.md` packages advertised through Pi. There is no dedicated memory or skill administration system. Retry, compaction and transcript persistence use Pi's `AgentSession` and `SessionManager`.

## Removed features

No Telegram, mail, approvals, host execution, todo system, delegation/subagents, background processes, live file drafts, input joining, learning reviews, dedicated memory/skill management, execution-review or `needs_review` machinery. There is no recurring-schedule continue/complete decision guard, regex completion guard or Firecrawl stack.

Tables of removed features are dropped by migration. Historical messages remain readable, including old `agent_work` activity rendered read-only; this does not imply continued support for their old actions.

## Delivery boundary

The Pi-native product uses five images. Manager simplification requires a settled launcher-based installation and five-image retained generations. Full local checks and isolated staging with copied data and a real model precede release; see [deployment](../operations/deployment.md).
