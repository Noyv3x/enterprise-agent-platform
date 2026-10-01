# Data layout

R2 requires Manager M1. Persistent roots and Manager identity remain unchanged; see [deployment](../operations/deployment.md) and [data design](../design/data-memory-sessions.md).

## 唯一根目录

| Object | Location |
| --- | --- |
| Stable Manager command | `~/.local/bin/agent-platform-manager` |
| Configuration | `~/.config/agent-platform/manager.toml` |
| User systemd unit | `~/.config/systemd/user/agent-platform-manager.service` |
| Default persistent root | `~/.local/share/agent-platform/` |
| Platform data | `<data_root>/data` → `/var/lib/agent-platform` |
| Runtime home | `<data_root>/data/runtimes/agent` → `/var/lib/agent-platform/runtime` |

The account database supplies `~`; installer/Manager do not trust HOME/XDG overrides for persistent roots. The control socket uses a validated runtime directory. Branding does not change technical paths.

```text
<data_root>/
  manager/
    update.json
    releases/
    manager-binaries/
    active-generation
    control/
    secrets/
    logs/
  data/
    platform.db{,-wal,-shm}
    attachments/
    upload-staging/
    workspaces/
      user-<id>/
      channels/channel-<id>/
      chat/user-<id>/<conversation_id>/
    agent-envs/<scope-hash>/{home,env}/
    runtimes/
      agent/
        sessions-v3/<sha256(sid)>.jsonl
        sessions/                 # previous format, not read
        sessions.pre-pi/          # earlier archive if present, not read
      camofox/
      searxng/{config,cache,logs}/
  backups/
```

Directories of removed features, including old skill sidecars and Firecrawl data, may remain on disk; nothing reads them and their presence does not start retired services. Run event buffers are in memory, not a new durable event journal.

Executor commands have no durable process registry or `.pid`/`.out`/`.err`/`.exit`
output files. Old `manager/processes/` and sandbox process artifacts are left
untouched, not adopted or replayed. Running managed sandboxes are stopped before
Manager accepts executor requests after startup; workspace/home/environment
remain persistent and sandboxes restart on demand.

## Workspaces and resources

Personal `user-<id>` and channel `channels/channel-<id>` workspaces mount at `/workspace`. Chat workspace ID `chat-user-<id>` mounts `workspaces/chat/user-<id>` there; each conversation sets cwd to `/workspace/<conversation_id>`. One chat sandbox serves each user, not each conversation. File tools restrict the conversation directory; bash can reach that user's other chat files.

Workspace memory is `AGENTS.md`. Enabled skills use `.agent-platform/skills/<name>/SKILL.md`. MCP uses `.agent-platform/mcp.json` and `.agent-platform/mcp/<server>/`. No dedicated memory/skill state system is active.

Persistent home and environment mount at `/home/agent` and `/opt/agent-env`. Agent attachment mounts remain scope-specific and read-only. Chat has no attachment mount: Platform copies uploads into its conversation directory. Database attachment paths remain relative; downloads require ownership and path validation.

## Sandbox profiles

Manager binds profile and workspace at sandbox creation; omitted `execution_context.profile` and old records default to `agent`. Defaults are configurable in `manager.toml`:

| Profile | Memory / swap | CPUs | PID limit | Network | Idle stop |
| --- | --- | --- | --- | --- | --- |
| `agent` | 2 GiB / 2 GiB | 2 | 1024 | Core network | 10 minutes |
| `chat` | 768 MiB / 768 MiB | 1 | 256 | None | 3 minutes |

| `manager.toml` key | Default |
| --- | --- |
| `sandbox_agent_memory` / `sandbox_agent_memory_swap` | `"2g"` / `"2g"` |
| `sandbox_agent_cpus` / `sandbox_agent_pids_limit` | `"2"` / `1024` |
| `sandbox_idle` | `"10m"` |
| `sandbox_chat_memory` / `sandbox_chat_memory_swap` | `"768m"` / `"768m"` |
| `sandbox_chat_cpus` / `sandbox_chat_pids_limit` | `"1"` / `256` |
| `sandbox_chat_idle` | `"3m"` |

Memory/CPU values are strings, PID limits integers and idle periods Go duration strings. Existing explicit `sandbox_idle` values remain unchanged. Callers cannot configure the profile's network or rebind an existing sandbox; executor audit receipts and process identity also bind the profile.

Stopping an idle sandbox preserves its workspace/home/environment. Image inputs are shared; no host secrets or environment are mounted or forwarded. See [security](../design/security-and-trust.md).

## 受控迁移

Manager stops the sole writer, verifies a snapshot and runs `enterprise-agent-platform migrate --data /var/lib/agent-platform` before starting the candidate. `migrate` applies the ordered forward migrations recorded in `schema_migrations` once each; see the [Platform API](platform-api.md#migration). No pre-Pi data is retained and Runtime performs no session import.

## Manager state and cleanup

Manager's `update.json` remains the operation/reservation authority. Keep current and previous release metadata, validated Manager binaries and required snapshots; preserve in-flight candidates. After successful updates, M1 retains images referenced by current/previous generations or running sandboxes, deleting other deployment-owned images by exact ID only. Never run blanket prune or delete by guessed names.

The schema-1 checkpoint includes Manager state and operation records. Legacy `manager/state.json` and `manager/operations/` may remain on disk but are never imported, changed or deleted. Missing `update.json` is accepted only for fresh state with neither legacy path present; damaged or provisional (`bridge_transition`) checkpoints fail closed rather than reconstructing state from old files. The immutable launcher retains its separate schema-1 `launcher-state.json`, `manager-binaries.json` and version-directory protocol.

## 备份与恢复

Before upgrade, stop the sole writer and save a verified full recovery point outside the deployment root: database with consistent WAL state, attachments, workspaces, environments, Runtime data, Manager configuration/secrets/state and release metadata. A SQLite-only snapshot is not a full backup.

After a release rollback the restored database snapshot does not contain writes made after the snapshot, and Runtime history of the rolled-back generation excludes later v3 turns. Preserve new writes before any rollback; prefer forward repair after traffic has resumed. Never mix recovery points or treat conversation replay as recovery. See [automatic updates](../operations/auto-update.md).
