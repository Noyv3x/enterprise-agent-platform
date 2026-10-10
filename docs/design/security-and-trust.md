# Security and trust

## Execution boundary

The sandbox is the tenant execution boundary. Pi is not a sandbox. Runtime never runs tenant shell commands locally and never discovers host context, skills or extensions. Only host Manager owns Docker and executes audited sandbox operations. There is no host-execution product tool, approval workflow or approval-based escape hatch.

Personal AI and each channel have distinct workspaces/sandboxes. Chat uses one network-disabled sandbox per user, shared across that user's conversations. Chat file tools restrict paths to the active conversation directory; bash only sets cwd and can reach the same user's other chat files. Do not describe conversation directories as separate security boundaries.

Use Manager's `agent` and `chat` resource profiles; identities bind a sandbox to its workspace and profile at creation. Resource limits are in [deployment](../operations/deployment.md). No business container or sandbox receives the Docker socket.

## Authentication and authorization

- Platform authenticates signed cookies and checks active users and `token_version` on requests. Password/revocation changes invalidate prior tokens.
- Administrators can impersonate any other active account (管理员代入). This simply issues a normal session for the target and replaces the caller's cookie, as if the target had just signed in: no flag marks the session as impersonated, other sessions and `token_version` are unchanged, and returning to the admin requires signing in again.
- Cookie-authenticated mutations and login must be same-origin: the `Origin` must equal the configured public base URL or the origin the browser actually used. With `AGENT_PLATFORM_TRUSTED_PROXY=1` (container deployments, where the Manager gateway discards client-supplied forwarding headers and rebuilds them from the accepted connection), that request origin comes from `X-Forwarded-Proto`/`X-Forwarded-Host` and login throttling keys on `X-Forwarded-For`; otherwise `Host`, the public scheme and the TCP peer are used.
- Server-side ownership protects personal scopes, chat conversations, files, schedules and browser takeover. Channel read/manage permissions come from permission groups; there is no implicit membership policy.
- Runtime bearer, internal tool bearer, Manager control and Manager executor credentials are separate capabilities. Platform holds the control credential and the executor credential (for background-task stop, input, list, read and the process change feed); Runtime holds only the executor credential. Public APIs do not accept caller-supplied trusted scope identities.
- Models are not a user setting: only administrators edit model policy groups (`model_policies_v1`) and assign accounts to them (`users.model_policy`). Self-facing payloads (public user, bootstrap, `/api/me`) and user-visible events carry no model, group or thinking-depth identifiers, and no self-service route changes them. Platform resolves the model server-side from the slot that matches the usage (personal, channel, chat, scout, worker) in the account's group, else the first catalog model; request bodies cannot select one.
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

## Background tasks and subagents

Personal AI only; channels and chat have no such tools, and a subagent session cannot reach the `tasks` gateway (its session is not a root personal session).

- Ownership: a task row belongs to one user. The user API and the AI's `job`/`wait` tools resolve a task only through its owner; another user's or a foreign task id is "not found", and API calls need `private_agent`. Process ids from Runtime are accepted only if Manager lists them under the caller's own owner scope (`private:<uid>`).
- Stop and input are real executor operations: Platform requests a one-shot audit receipt (operation `process`, action `kill` or `stdin`; stdin audit records the process id and byte count, never content), then calls Manager. A process counts as `stopped` only after Manager confirms termination; an unconfirmed kill leaves the task `running` and is reported as an error.
- Subagents share the parent's sandbox and workspace, so they are not isolated from it or from each other. Their tool set is fixed by Platform (`scout`: read, grep, find, ls, web search/fetch; `task`: additionally bash, edit, write), they run foreground commands only and cannot spawn subagents. Limits: 8 running subagents and 16 running processes per user.
- Recovery: a subagent whose Runtime stream is lost, or that was running when Platform restarted, becomes `interrupted` and is never replayed (Platform only cancels any still-live child run). A Manager restart stops every sandbox, so running processes become `interrupted` (`system_restart`); commands are never rerun. Results of finished tasks reach the AI exactly once: `delivered_at` is set atomically by `wait` or by the notice worker, and a notice whose tasks were already delivered is skipped. Task results are untrusted tool output: the notice prompt escapes them inside a `<background-task-results>` block and they carry no authority.

## Effects and recovery

Cancellation stops future work but cannot undo completed external effects. A lost/failed run becomes visibly interrupted; do not replay it automatically. Executor audit receipts are one-shot and identity-bound. Removed approval/review systems must not be recreated as retry or completion heuristics; background work follows [its own rules](#background-tasks-and-subagents).

Manager accepts sandbox foreground terminal execution, supervised background
processes (`operation:"process"` receipts for start/stdin/kill; stdin audit
records the process id and byte count, never content) and confined file
read/write. Timeout, kill and cancellation terminate and confirm the sandbox command
process group, including grandchildren; stopping the host Docker client alone is
not confirmation. Foreground commands have in-memory run ownership. Background
processes are owned by the scope-family root of the creating call; read-only routes
require the matching owner, and foreign ids are indistinguishable from missing ones.
Their combined output passes through the same incremental redactor before it is
written to the capped log (`<manager state>/processes/<id>/output.log`, owner-only);
commands shown in views are redacted. Process records survive a Manager restart as
history only: running processes become `interrupted` (`system_restart`) and are never replayed.
Before executor readiness on every Manager startup, all running managed sandbox
containers are stopped. Failure to confirm cleanup prevents executor readiness.
Sandbox workspace, home and environment are retained and restart on demand.
MCP keeps its safe audit projection and private-output redaction.

Manager update reservations block new work before migration and release only through the existing owner-bound commit/abort protocol. Migrations are ordered and forward-only. See [operations](../operations/auto-update.md) and [API contracts](../reference/platform-api.md).
