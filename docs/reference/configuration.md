# Configuration

Exact request fields belong in the [Platform API](platform-api.md) and [Runtime API](runtime-api.md). Fixed container paths and secret wiring are defined by the entrypoints and Compose; do not add parallel environment/configuration conventions.

## Services and secrets

Platform serves on 8765 with data `/var/lib/agent-platform`. Runtime serves privately on 8766 with home `/var/lib/agent-platform/runtime`; Platform connects through `AGENT_PLATFORM_AGENT_RUNTIME_URL`, and Runtime uses `AGENT_PLATFORM_INTERNAL_URL` for tool/credential gateways.

Container secret files live under `/run/secrets/agent-platform/`: session signing, agent-tool, agent-runtime, Camofox access, Manager control and Manager executor credentials are separate. Platform/Runtime receive only their required secrets: Platform the Manager control credential (`AGENT_PLATFORM_MANAGER_TOKEN_FILE`) and, for background-task stop/input/list/read and the process change feed, the Manager executor credential (`AGENT_PLATFORM_MANAGER_EXECUTOR_TOKEN_FILE`, same Manager socket); Runtime only the executor credential. No secret files or host environment are passed into sandboxes.

Manager configuration remains `~/.config/agent-platform/manager.toml`. Its public settings cover update enablement/interval/channel and LAN/ingress CIDRs. M1 adds configurable agent/chat sandbox resource profiles; defaults and mount layout are in [data layout](data-layout.md#sandbox-profiles).

All historically accepted `manager.toml` keys still parse. `health_timeout_seconds` and `drain_timeout_seconds` are compatibility no-ops (positive integers remain required); lifecycle deadlines are owned by the update and readiness protocols. Existing Firecrawl data and secrets are left untouched, but Manager neither creates nor reconciles that retired stack.

## Models and account settings

Personal AI uses `users.model_name` and `thinking_depth`; an empty `model_name` uses the first catalog model. Standard chat uses `users.chat_model_name` when an administrator set it, otherwise the personal AI model, with the same `thinking_depth` as the personal AI. Only administrators see or change these models; users see and change only their thinking depth.

Codex device OAuth is deployment-wide Platform state. Platform owns durable credentials and refresh; Runtime resolves access through Platform. Protect the DB as credential-bearing data: `secret` flags do not encrypt stored values.

## 品牌

Administrators configure product name, agent name, primary color and validated logo through Platform. Public branding includes only display data and revision, not other settings. Defaults are `Agent Platform`, `Agent` and neutral styling. Branding never changes paths, cookies, container identity or release assets. See [frontend](../design/frontend.md#branding).

## Agent resources

Personal/channel context uses workspace `AGENTS.md`; skills use `.agent-platform/skills/*/SKILL.md`; personal MCP configuration is `.agent-platform/mcp.json`. These are ordinary workspace resources, not settings panels or dedicated memory/skill databases. Chat does not load them.

Platform supplies the system prompt, resources and tools with every run, and Pi reconciles any change (see [prompt cache](../design/agent-runtime.md#prompt-cache)). User/time/timezone context is prefixed to messages. Cache warming is off; retry and compaction use Pi defaults rather than product-specific knobs. Subagent and background-process limits (8 and 16 running per user) are fixed product limits, not settings. No approvals, host execution, learning, Telegram, mail or Firecrawl configuration is active in R2.
