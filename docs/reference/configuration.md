# Configuration

Exact request fields belong in the [Platform API](platform-api.md) and [Runtime API](runtime-api.md). Fixed container paths and secret wiring are defined by the entrypoints and Compose; do not add parallel environment/configuration conventions.

## Services and secrets

Platform serves on 8765 with data `/var/lib/agent-platform`. Runtime serves privately on 8766 with home `/var/lib/agent-platform/runtime`; Platform connects through `AGENT_PLATFORM_AGENT_RUNTIME_URL`, and Runtime uses `AGENT_PLATFORM_INTERNAL_URL` for tool/credential gateways.

Container secret files live under `/run/secrets/agent-platform/`: session signing, agent-tool, agent-runtime, Camofox access, Manager control and Manager executor credentials are separate. Platform/Runtime receive only their required secrets. No secret files or host environment are passed into sandboxes.

Manager configuration remains `~/.config/agent-platform/manager.toml`. Its public settings cover update enablement/interval/channel and LAN/ingress CIDRs. M1 adds configurable agent/chat sandbox resource profiles; defaults and mount layout are in [data layout](data-layout.md#sandbox-profiles).

## Models and account settings

Personal AI uses `users.model_name` and `thinking_depth`. Standard chat uses each user's allowed model list/default and each conversation's selected model. Server-side policy restricts choices; a frontend model picker is not authorization.

Codex device OAuth is deployment-wide Platform state. Platform owns durable credentials and refresh; Runtime resolves access through Platform. Protect the DB as credential-bearing data: `secret` flags do not encrypt stored values.

## 品牌

Administrators configure product name, agent name, primary color and validated logo through Platform. Public branding includes only display data and revision, not other settings. Defaults are `Agent Platform`, `Agent` and neutral styling. Branding never changes paths, cookies, container identity or release assets. See [frontend](../design/frontend.md#branding).

## Agent resources

Personal/channel context uses workspace `AGENTS.md`; skills use `.agent-platform/skills/*/SKILL.md`; personal MCP configuration is `.agent-platform/mcp.json`. These are ordinary workspace resources, not settings panels or dedicated memory/skill databases. Chat does not load them.

Runtime captures system prompt/resources/tools when creating its in-memory Pi session, which happens after 60 idle minutes or after compaction. User/time/timezone context is prefixed to messages. Cache warming is off; retry and compaction use Pi defaults rather than product-specific knobs. No approvals, host execution, background jobs, learning, Telegram, mail or Firecrawl configuration is active in R2.
