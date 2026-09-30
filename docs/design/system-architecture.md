# System architecture

The system embeds Pi rather than recreating an agent framework. [Product scope](product.md), [trust boundaries](security-and-trust.md), [Platform API](../reference/platform-api.md) and [Runtime API](../reference/runtime-api.md) define its boundaries.

## Components

| Component | Responsibility |
| --- | --- |
| Frontend | Login, conversations, attachments, browser takeover, schedules, settings and administration. |
| Platform | Python 3.11, Starlette/uvicorn/httpx and stdlib SQLite; authentication, authorization, durable product history, FIFO jobs, resources, tool gateways, OAuth and Manager integration. Serves frontend assets on port 8765. |
| Runtime | Node ≥22.19, TypeScript and Pi coding-agent 0.87.1; one live `AgentSession` per conversation, streamed runs and append-only JSONL v3 transcripts. Port 8766 is private. |
| Host Manager | Public ingress, maintenance/update coordination, Docker ownership and audited sandbox execution. It is not an agent tool for host commands. |
| Agent sandbox | Personal or channel workspace, persistent home/environment and foreground tenant execution. |
| Chat sandbox | One lightweight, network-disabled sandbox per user, shared by that user's chat conversations. |
| Camofox / SearXNG | Managed browser and web search. Fetch uses Platform HTTP, not Firecrawl. |

Only Manager owns Docker. Platform and Runtime do not execute tenant commands in their own containers. The five release image keys are `platform`, `agent-runtime`, `camofox`, `agent-sandbox`, `searxng`.

## Message and tool flow

1. Platform authenticates and authorizes a message, inserting it and a `durable_jobs` agent job in one transaction.
2. A per-session FIFO worker selects the model, sandbox identity, stable resources and tool set, then submits one Runtime run.
3. Runtime resumes or creates the conversation's Pi session. Pi owns model turns, retry and compaction; changing time/user/timezone context is prefixed to the user message.
4. File and shell tools call Manager's audited executor. Web, browser and schedule tools call Platform's authenticated internal gateways; MCP runs its stdio client in the sandbox.
5. Runtime emits text/thinking deltas, tool activity, retry/compaction events and a final result. Platform persists the final message and usage; the frontend displays Platform history and streaming updates.

A lost Runtime run becomes interrupted. Platform never resubmits a run whose effects may already have occurred. Pi's model-call retry is not job replay.

## State ownership

SQLite is authoritative for product history, users, permissions, schedules, queue and usage. Pi JSONL is authoritative for model-visible session history. Workspaces hold user files, AGENTS.md and skills; Manager owns lifecycle and release records. These are separate stores, not competing copies of one state machine.

Personal and channel sessions have stable scope/workspace identities. Chat has a per-user sandbox and a per-conversation directory: file tools reject paths outside that directory, while bash starts there but can reach the same user's other chat files. The security boundary is the user sandbox, not the chat directory.

## Lifecycle and release

One run is active per session; idle session objects expire after 15 minutes. Completed-run events are buffered for 10 minutes. Sessions survive object eviction in `sessions-v3/`; the UI uses SQLite rather than Runtime debug history.

Manager M1 must precede R2. Database changes are additive; old runtime journals and removed-feature data remain untouched. See [migration and storage](data-memory-sessions.md) and [deployment](../operations/deployment.md).
