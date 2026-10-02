# Integrations

Tool request/response shapes belong in the [Runtime API](../reference/runtime-api.md) and [Platform API](../reference/platform-api.md). Internal web/browser/schedule gateways require the agent-tool bearer and trusted run/scope context.

## Web search and fetch

`web_search` uses managed SearXNG. `web_fetch` uses direct Platform HTTP GET with public-address SSRF validation on the initial URL and every redirect, time/size limits and HTML-to-Markdown extraction. There is no Firecrawl, PostgreSQL queue, Redis, RabbitMQ or Playwright fetch stack.

All three conversation modes can search/fetch. Chat's sandbox has no network; its web requests use the Platform gateway, not sandbox networking. See [web trust rules](security-and-trust.md#web-and-browser).

## Browser and human takeover

Personal AI uses managed Camofox with a Platform-derived per-scope identity. The computer panel displays screenshot previews and permits human takeover. One holder owns an expiring lease; agent browser actions return busy while a human holds it. Releasing or expiring the lease returns control to the agent. Browser support is absent from channels and standard chat.

Camofox is a separate managed capability. Its outage may degrade browsing without making core login/conversation services unavailable.

## MCP

Personal AI invokes `/usr/local/bin/agent-platform-mcp` inside its sandbox through an audited foreground terminal call. The helper implements stdio `tools/list` and `tools/call`, not a host daemon or a Platform MCP gateway.

Configuration is `/workspace/.agent-platform/mcp.json`:

```json
{"mcpServers":{"example":{"command":"/workspace/.agent-platform/mcp/example/server","args":[],"env":{},"cwd":"/workspace"}}}
```

Server packages and tenant-provided configuration remain in the workspace. The helper reloads configuration each invocation and uses workspace-contained command/cwd paths. Do not copy host credentials/environment into its process. Chat and channels have no MCP tool or dedicated MCP management panel.

## Schedules

Schedules are managed only by the personal AI through its `schedule` tool (list/get/create/update/pause/resume/delete/run-now and `history` for past runs); users have no schedule UI or API. Each occurrence inserts a normal durable agent job in the owner's private scope, sending the schedule's `prompt` to the personal AI as a new message. Jobs share that conversation's FIFO ordering and produce ordinary messages and usage records.

Once, interval and cron timing use the configured timezone. The existing schedule/run tables remain authoritative. The tool is owner-scoped through the internal gateway. No continue-current/complete-current tool, completion decision guard or Telegram delivery remains. Standard chat and channel agents do not manage schedules.

## Models and OAuth

Administrators manage models and the Codex device authorization flow. Platform persists OAuth credentials and refreshes them; Runtime resolves access tokens through Platform, including forced provider refresh. Personal model/thinking settings and the optional per-account chat model are administrator-managed and not visible to users.

## Host Manager

Platform presents authenticated Manager status/configuration, check and update operations. Manager owns image pulls, resource-profile sandbox creation, maintenance and release recovery. See [automatic updates](../operations/auto-update.md); these controls are not agent host-execution tools.
