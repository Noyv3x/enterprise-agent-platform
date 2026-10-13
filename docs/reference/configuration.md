# Configuration

Exact request fields belong in the [Platform API](platform-api.md) and [Runtime API](runtime-api.md). Fixed container paths and secret wiring are defined by the entrypoints and Compose; do not add parallel environment/configuration conventions.

## Services and secrets

Platform serves on 8765 with data `/var/lib/agent-platform`. Runtime serves privately on 8766 with home `/var/lib/agent-platform/runtime`; Platform connects through `AGENT_PLATFORM_AGENT_RUNTIME_URL`, and Runtime uses `AGENT_PLATFORM_INTERNAL_URL` for tool/credential gateways.

`AGENT_PLATFORM_ARTIFACT_RENDER_BASE_URL` (default `http://platform:8765`) is the address Camofox uses to reach Platform when it renders an artifact for `artifact view` or annotate capture; it must resolve from the Camofox container to Platform's own port and carry no path. Set it only for a non-default container network. Camofox applies a strict egress policy to renderer contexts (`artifact-render:` identities): only public addresses plus the hosts in `AGENT_PLATFORM_CAMOFOX_RENDER_ALLOWED_HOSTS` (Camofox container environment; comma-separated `host` or `host:port`, set by the compose file to `platform:8765`) are reachable. If the render base URL's host or port is changed, set that variable to match, or renders fail with `render_unavailable`.

Container secret files live under `/run/secrets/agent-platform/`: session signing, agent-tool, agent-runtime, Camofox access, Manager control and Manager executor credentials are separate. Platform/Runtime receive only their required secrets: Platform the Manager control credential (`AGENT_PLATFORM_MANAGER_TOKEN_FILE`) and, for background-task stop/input/list/read and the process change feed, the Manager executor credential (`AGENT_PLATFORM_MANAGER_EXECUTOR_TOKEN_FILE`, same Manager socket); Runtime only the executor credential. No secret files or host environment are passed into sandboxes.

Manager configuration remains `~/.config/agent-platform/manager.toml`. Its public settings cover update enablement/interval/channel and LAN/ingress CIDRs. M1 adds configurable agent/chat sandbox resource profiles; defaults and mount layout are in [data layout](data-layout.md#sandbox-profiles).

All historically accepted `manager.toml` keys still parse. `health_timeout_seconds` and `drain_timeout_seconds` are compatibility no-ops (positive integers remain required); lifecycle deadlines are owned by the update and readiness protocols. Existing Firecrawl data and secrets are left untouched, but Manager neither creates nor reconciles that retired stack.

## Models and account settings

Each account belongs to exactly one model policy group (`users.model_policy`; settings key `model_policies_v2`; migration and fresh install create `default`). A group sets `main` and `judge`, each `{model,thinking}`. `main` serves every agent usage: personal AI (schedules, background-task notices), the channel main agent (using the triggering user's group), pure chat, `scout` and `task` subagents and manual compaction of any scope. `judge` serves chat titles and, when `main.thinking` is `auto`, the per-turn difficulty judgment; its `thinking` is never `auto`. An empty `main.model` uses the first catalog model; an empty `judge.model` uses the group's resolved main model. `auto` requires an explicitly named GPT-6-family main model. Only administrators see or change groups and assignments; users see and change neither models nor thinking depth.

Codex device OAuth is deployment-wide Platform state. Platform owns durable credentials and refresh; Runtime resolves access through Platform. Protect the DB as credential-bearing data: `secret` flags do not encrypt stored values.

## MCP

Connectors, secrets and the call audit are Platform data (see [data model](../design/data-memory-sessions.md#product-database)). The only setting is `mcp_private_networks_v1` (administrator, 管理 → 连接器): a JSON list of CIDRs and host names that remote MCP endpoints may resolve to although they are not public; empty by default (see [network policy](../design/security-and-trust.md#remote-mcp-network-policy-and-oauth)). OAuth sign-in needs `AGENT_PLATFORM_PUBLIC_BASE_URL` to be https (or loopback); the redirect URI is `<public base URL>/api/mcp/oauth/callback`. Timeouts (calls 120 s, per-connector up to 600 s; connections idle 10 min; elicitations 10 min) are fixed product limits.

## 品牌

Administrators configure product name, agent name, primary color and validated logo through Platform. Public branding includes only display data and revision, not other settings. Defaults are `Agent Platform`, `Agent` and neutral styling. Branding never changes paths, cookies, container identity or release assets. See [frontend](../design/frontend.md#branding).

## Agent resources

Personal/channel context uses workspace `AGENTS.md`; personal/channel skills use `.agent-platform/skills/*/SKILL.md`; MCP connectors are database records, not workspace files (the old `.agent-platform/mcp.json` was imported once by migration `2026101501`), and the SDK's `httpx2` client trusts the operating system certificate store. Built-in skills come from the image directory `AGENT_PLATFORM_BUILTIN_SKILLS_DIR` (Platform default `/opt/agent-platform/skills/builtin`; tests and development point it at the repository's `enterprise-agent-platform/skills`) and organization skills from `<data_dir>/skills/org`; see [skills](../design/data-memory-sessions.md#skillmd-skills). Skill management is in the settings UI and the AI's `skill` tool (permission `install_extensions`); there is no dedicated memory database. Chat loads only built-in and organization skills, never AGENTS.md or workspace skills.

Platform supplies the system prompt, resources and tools with every run, and Pi reconciles any change (see [prompt cache](../design/agent-runtime.md#prompt-cache)). User/time/timezone context is prefixed to messages. Cache warming is off; retry and compaction use Pi defaults rather than product-specific knobs. Subagent and background-process limits (8 and 16 running per user) are fixed product limits, not settings. No approvals, host execution, learning, Telegram, mail or Firecrawl configuration is active in R2.
