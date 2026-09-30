# Security and trust

## Execution boundary

The sandbox is the tenant execution boundary. Pi is not a sandbox. Runtime never runs tenant shell commands locally and never discovers host context, skills or extensions. Only host Manager owns Docker and executes audited sandbox operations. There is no host-execution product tool, approval workflow or approval-based escape hatch.

Personal AI and each channel have distinct workspaces/sandboxes. Chat uses one network-disabled sandbox per user, shared across that user's conversations. Chat file tools restrict paths to the active conversation directory; bash only sets cwd and can reach the same user's other chat files. Do not describe conversation directories as separate security boundaries.

Use Manager's `agent` and `chat` resource profiles; identities bind a sandbox to its workspace and profile at creation. Resource limits are in [deployment](../operations/deployment.md). No business container or sandbox receives the Docker socket.

## Authentication and authorization

- Platform authenticates signed cookies and checks active users and `token_version` on requests. Password/revocation changes invalidate prior tokens.
- Cookie-authenticated mutations and login must be same-origin: the `Origin` must equal the configured public base URL or the origin the browser actually used. With `AGENT_PLATFORM_TRUSTED_PROXY=1` (container deployments, where the Manager gateway discards client-supplied forwarding headers and rebuilds them from the accepted connection), that request origin comes from `X-Forwarded-Proto`/`X-Forwarded-Host` and login throttling keys on `X-Forwarded-For`; otherwise `Host`, the public scheme and the TCP peer are used.
- Server-side ownership protects personal scopes, chat conversations, files, schedules and browser takeover. Channel read/manage permissions come from permission groups; there is no implicit membership policy.
- Runtime bearer, internal tool bearer, Manager control and Manager executor credentials are separate capabilities. Public APIs do not accept caller-supplied trusted scope identities.
- Model policy is enforced server-side: chat model choices must be allowed for that user; personal model settings are separate.
- Manager remains the ingress and maintenance boundary. Keep Platform on loopback/private networking, expose no Runtime port, and use TLS at the external proxy. Rebuild forwarding headers from trusted ingress information rather than trusting client headers.

## Secrets

Platform owns Codex OAuth persistence and refresh. Runtime requests model access tokens through the authenticated resolver. Host service credentials and environment must never enter tenant sandboxes: never forward Pi's BashOperations `options.env`, mount secret directories, or embed credentials in prompts/tool output. Tenant-configured MCP credentials are workspace-owned configuration, not host credentials.

Secret files and Manager state remain owner-only. The database's secret flag is not encryption; backups need the same protection as live data. Avoid credentials in logs, browser previews, error messages and model context.

## Files and untrusted content

Resolve tool paths within the allowed workspace (chat file tools: conversation directory). Validate ownership and resolved paths for downloads, previews and `MEDIA: /workspace/<path>` output; a model-written path is not authorization. Bundled `/platform-skills/` content is read-only.

Attachments, websites, browser pages, MCP output and workspace instructions may contain hostile instructions. They do not grant host capabilities or change authenticated ownership. Do not claim heuristic text scanning, model obedience or a confirmation dialog is an isolation boundary.

## Web and browser

Web fetch accepts public HTTP(S) destinations only, with address checks repeated on every redirect, bounded time/response size and safe HTML extraction. Reject local/private/link-local destinations and unsafe schemes. Search results are untrusted URLs, not permission to access internal services. Chat web tools run through Platform; chat bash has no network.

Camofox uses a Platform-derived scope identity and service authentication. Personal browser takeover is a single-holder expiring lease; agent browser actions return busy while held. Takeover grants browser interaction, not host or cross-user access.

Before each agent-requested navigation, Platform resolves the URL host and rejects metadata, link-local, multicast or reserved destinations, URL userinfo, and any address within the subnets of Platform's own container network interfaces. Platform discovers those interface subnets at runtime; shared core-network service names are therefore covered without injected CIDR configuration. Camofox's existing enforcement remains unchanged.

This check does not intercept every in-page link or redirect. Residual browser access to core services through those paths is an accepted risk, not a guarantee of network isolation; internal services still require their bearer tokens. Do not equate the navigation check with web fetch's redirect-by-redirect SSRF protection.

## Effects and recovery

Cancellation stops future work but cannot undo completed external effects. A lost/failed run becomes visibly interrupted; do not replay it automatically. Executor audit receipts are one-shot and identity-bound. Removed approval/background/review systems must not be recreated as retry or completion heuristics.

Manager update reservations block new work before migration and release only through the existing owner-bound commit/abort protocol. Keep migrations additive and original journals untouched. See [operations](../operations/auto-update.md) and [API contracts](../reference/platform-api.md).
