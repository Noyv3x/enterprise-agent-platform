# Deployment

Production uses a host Manager with managed Docker containers. See [automatic updates](auto-update.md), [data layout](../reference/data-layout.md) and [security](../design/security-and-trust.md).

## Prerequisites and release order

Linux, Docker Engine, Compose v2, user-level systemd and a deployment user permitted to use Docker are required. The user's account home must exist, be owned by that user, not be a symlink and not be group/world writable. The production host needs no source checkout, Python virtualenv or Node installation.

**Install R1 / Manager M1 before R2.** M1 introduced five-image catalog support through the normal launcher self-update; R2 must not be offered directly to an older Manager. Before installing the simplified Manager, confirm the current and retained rollback releases both use five-image catalogs and the preceding update is settled and healthy. The simplified Manager rejects ten-image catalogs.

## Topology

The independent launcher and Manager run under `agent-platform-manager.service`. Manager owns public ingress, maintenance mode, Docker and audited execution. Platform contains the frontend; Runtime, Camofox and SearXNG remain private. Business containers never receive the Docker socket. Persistent state uses bind mounts, not anonymous volumes.

The only accepted image keys are `platform`, `agent-runtime`, `camofox`, `agent-sandbox`, `searxng`; all five are required, and unknown keys are rejected. Firecrawl services are absent, not unavailable dependencies. Platform binds to host loopback; publish through Manager, optionally behind a TLS reverse proxy. Explicit LAN/CIDR configuration is required for direct network access.

## Installation and management

```sh
curl -fsSL https://github.com/Noyv3x/enterprise-agent-platform/releases/latest/download/install.sh | bash -s -- --yes
agent-platform-manager status
agent-platform-manager preflight
agent-platform-manager check
agent-platform-manager update
```

The installer validates the immutable manifest and Manager bytes before activation. It is for a new data root, not repair of an existing installation. Commands `restart`, `rollback`, `repair` and `logs` operate through the existing authenticated local control socket. `check` discovers a candidate; it does not install it. Never manually edit update reservations or replace image digests with mutable tags.

## 发布物启动与健康

Release manifests remain schema 2 / protocol 2. Manager owns the reservation/snapshot/migration/start/probe/commit sequence; at most one Platform writer runs. Its fixed migration entry point remains:

```sh
enterprise-agent-platform migrate --data /var/lib/agent-platform
```

Platform health is `/healthz` on 8765; Runtime health is authenticated `/health` on 8766. Exact payloads and internal Manager contracts belong in the [Platform API](../reference/platform-api.md) and [Runtime API](../reference/runtime-api.md). An open port alone is not release readiness. Camofox/search failures degrade those capabilities rather than core login/conversations.

Annotate capture and the AI's `artifact view` need Camofox to reach Platform: Camofox opens `AGENT_PLATFORM_ARTIFACT_RENDER_BASE_URL` (default `http://platform:8765`, the Platform container on the shared core network) with a dedicated renderer identity per render. The Camofox container's `AGENT_PLATFORM_CAMOFOX_RENDER_ALLOWED_HOSTS` (compose default `platform:8765`) must name that same host and port: renderer contexts may reach nothing private except that address, and a mismatch makes renders fail. If Camofox is down or cannot reach that URL, those calls fail with `render_unavailable`; conversations and normal artifact viewing are unaffected. Live previews and WebSocket hot reload need Platform's `websockets` dependency (declared in `pyproject.toml` and `uv.lock`), which lets uvicorn accept upgrades, and Manager's executor proxy (see below under sandbox profiles).

Image builds compile Runtime TypeScript and frontend static assets on the build host once for both architectures. Runtime production dependencies are installed separately for each target architecture and cached by the package manifests; Python third-party dependencies are cached from `pyproject.toml` before application source is copied. Native modules and the Python virtualenv never cross architectures. Entrypoints, users, health checks and runtime file layouts are unchanged.

## Sandbox profiles

| Profile | Memory / swap | CPUs | PIDs | Network | Idle stop |
| --- | --- | --- | --- | --- | --- |
| `agent` (personal/channel) | 2 GiB / 2 GiB | 2 | 1024 | Core | 10 min |
| `chat` (one per user) | 768 MiB / 768 MiB | 1 | 256 | None | 3 min |

Defaults are configurable in M1's `manager.toml`; see [exact keys and types](../reference/data-layout.md#sandbox-profiles). Profile and workspace are bound at creation; omitted `execution_context.profile` defaults to `agent`. Chat has no attachments mount; Platform copies uploads into each conversation directory. Chat file tools enforce that directory; bash starts there but may access the user's other conversations. No per-conversation containers are created.

Every sandbox, agent and chat, mounts the host `skills/org` data directory read-only at `/opt/agent-platform/skills/org`; Manager creates it (0755) if missing, and sandboxes created before this mount existed gain it when their image is replaced. Built-in skills are baked into the sandbox and Platform images at `/opt/agent-platform/skills/builtin`; the Runtime image carries none. Manager passes `AGENT_PLATFORM_SANDBOX_PROFILE` (`agent` or `chat`) at creation. At every start of an `agent` sandbox the entrypoint, as root and before dropping to the agent identity, runs the skills safety net `/usr/local/bin/agent-platform-skills`: it moves skills installed into `~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills` or the workspace equivalents into `/workspace/.agent-platform/skills` (a pointer stub there is archived under `.agent-platform/skills-archive/`, and on any other name conflict the incoming copy is), and links those foreign paths to the standard directory. It never resolves a path through a symlink (a foreign path crossing one is skipped) and performs every change relative to directory file descriptors opened without following links; it is idempotent, never deletes user content, and a failure never prevents the sandbox from starting; the chat profile is never touched. It logs one summary line to the container log.

A named background service that declares a `port` is served through Manager's executor proxy route: Manager (a host process) must be able to reach the sandbox's IP on the core Docker bridge (the default rootful bridge; no published ports are involved), and the service must listen on `0.0.0.0` — a server bound to the container's `127.0.0.1` is unreachable. `chat` sandboxes have no network and cannot be proxied. A running service keeps its sandbox resident like any background process.

M1 prefetches the sandbox image during update pulls. Idle stop preserves data but never stops a sandbox that hosts a running background process (an obsolete image is likewise replaced only after its processes end). The sandbox image includes office-document tools (python-docx, openpyxl, XlsxWriter, python-pptx 1.0.2, ReportLab, pypdf, `pypdfium2` for rasterizing PDF pages, and the WenQuanYi Micro Hei CJK TrueType font, which ReportLab can embed in Chinese PDFs) and `uv`/`uvx` next to Node's `npx`, so local stdio MCP servers (`npx -y …`, `uvx …`) start without host involvement; MCP stdio connections never keep a sandbox resident (an idle stop ends them and Platform restarts them lazily); installing workspace dependencies must not require host execution or host credentials.

The image keeps its existing tini entrypoint and sudo capability: no additional Docker `--init` or `no-new-privileges` flag is added, preserving pip/npm installs that need system dependencies or global paths inside the sandbox.

## Backup and rollback

Before upgrading, stop the sole writer and take a verified full data backup outside the deployment root. Include consistent SQLite/WAL, workspaces, attachments, environments, Runtime sessions and Manager state/configuration/secrets. Automatic DB snapshots are not full backups.

R2 writes sessions only to `sessions-v3/`; `sessions/` and `sessions.pre-pi/` are not read. Database migrations are ordered and forward-only. A release rollback restores the pre-update snapshot with the previous generation and will not see later writes or v3 turns. Preserve post-release writes before rollback; never replace live data blindly with the pre-upgrade snapshot. See [recovery](../reference/data-layout.md#备份与恢复).

## Acceptance before R2 release

Run the [full local gate](../development/testing.md), then isolated staging on the production host with separate project/ports/network and a copied DB, workspaces and Runtime data (exclude the large music folder). Use the copied real Codex OAuth credentials; never mount production data writable or copy credentials into a sandbox.

Exercise personal bash/edit, search/fetch, browser takeover, schedule and MCP list; channel conversation; chat create/delete/code and the administrator's chat model; migrated context recall; compaction; consecutive-turn cache usage and sandbox resource usage. Tear staging down after preserving evidence. Container health/cookie/screenshot smoke does not prove real-model migration or agent execution.
