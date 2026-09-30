# Deployment

Production uses a host Manager with managed Docker containers. See [automatic updates](auto-update.md), [data layout](../reference/data-layout.md) and [security](../design/security-and-trust.md).

## Prerequisites and release order

Linux, Docker Engine, Compose v2, user-level systemd and a deployment user permitted to use Docker are required. The user's account home must exist, be owned by that user, not be a symlink and not be group/world writable. The production host needs no source checkout, Python virtualenv or Node installation.

**Install R1 / Manager M1 before R2.** Current N+1 installs M1 through its normal self-update while R1 still ships ten images and the legacy application. Confirm the M1 update is settled and healthy before accepting R2's five-image catalog. R2 must not be offered directly to an older Manager. Manager simplification beyond M1 is a later release.

## Topology

The independent launcher and Manager run under `agent-platform-manager.service`. Manager owns public ingress, maintenance mode, Docker and audited execution. Platform contains the frontend; Runtime, Camofox and SearXNG remain private. Business containers never receive the Docker socket. Persistent state uses bind mounts, not anonymous volumes.

R2 image keys: `platform`, `agent-runtime`, `camofox`, `agent-sandbox`, `searxng`. Firecrawl services are absent, not unavailable dependencies. Platform binds to host loopback; publish through Manager, optionally behind a TLS reverse proxy. Explicit LAN/CIDR configuration is required for direct network access.

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

Image builds compile Runtime TypeScript and frontend static assets on the build host once for both architectures. Runtime production dependencies are installed separately for each target architecture and cached by the package manifests; Python third-party dependencies are cached from `pyproject.toml` before application source is copied. Native modules and the Python virtualenv never cross architectures. Entrypoints, users, health checks and runtime file layouts are unchanged.

## Sandbox profiles

| Profile | Memory / swap | CPUs | PIDs | Network | Idle stop |
| --- | --- | --- | --- | --- | --- |
| `agent` (personal/channel) | 2 GiB / 2 GiB | 2 | 1024 | Core | 10 min |
| `chat` (one per user) | 768 MiB / 768 MiB | 1 | 256 | None | 3 min |

Defaults are configurable in M1's `manager.toml`; see [exact keys and types](../reference/data-layout.md#sandbox-profiles). Profile and workspace are bound at creation; omitted `execution_context.profile` defaults to `agent`. Chat has no attachments mount; Platform copies uploads into each conversation directory. Chat file tools enforce that directory; bash starts there but may access the user's other conversations. No per-conversation containers are created.

M1 prefetches the sandbox image during update pulls. Idle stop preserves data. The sandbox image includes office-document tools and the stdio MCP helper; installing workspace dependencies must not require host execution or host credentials.

The image keeps its existing tini entrypoint and sudo capability: no additional Docker `--init` or `no-new-privileges` flag is added, preserving pip/npm installs that need system dependencies or global paths inside the sandbox.

## Backup and rollback

Before upgrading, stop the sole writer and take a verified full data backup outside the deployment root. Include consistent SQLite/WAL, workspaces, attachments, environments, Runtime sessions and Manager state/configuration/secrets. Automatic DB snapshots are not full backups.

R2 writes new sessions only to `sessions-v3/`; `sessions/` and `sessions.pre-pi/` remain untouched. Database migration is additive. Old releases remain able to read old data but will not see new v3 turns. Preserve post-release writes before rollback; never replace live data blindly with the pre-upgrade snapshot. See [recovery](../reference/data-layout.md#备份与恢复).

## Acceptance before R2 release

Run the [full local gate](../development/testing.md), then isolated staging on the production host with separate project/ports/network and a copied DB, workspaces and Runtime data (exclude the large music folder). Use the copied real Codex OAuth credentials; never mount production data writable or copy credentials into a sandbox.

Exercise personal bash/edit, search/fetch, browser takeover, schedule and MCP list; channel conversation; chat create/delete/code/model policy; migrated context recall; compaction; consecutive-turn cache usage and sandbox resource usage. Tear staging down after preserving evidence. Container health/cookie/screenshot smoke does not prove real-model migration or agent execution.
