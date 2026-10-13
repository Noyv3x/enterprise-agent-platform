# Data, memory and sessions

[Data layout](../reference/data-layout.md) defines physical paths. [Platform API](../reference/platform-api.md) and [Runtime API](../reference/runtime-api.md) define access. SQLite and Pi journals have distinct responsibilities.

## Product database

| Tables | Purpose |
| --- | --- |
| `users`, `settings` | Accounts, permission groups, model policy groups (settings key `model_policies_v2`: per group a `main` and a `judge` `{model,thinking}`; each account names one in `users.model_policy`, default `default`), branding and OAuth. There are no per-account model or thinking columns. Signed login cookies use `users.token_version` for revocation; there is no login-session table. |
| `channels`, `messages`, `attachments` | Shared/private product history and attachment metadata; bytes remain on disk. Hiding messages resets the visible conversation. Channel authorization uses permission groups, not membership rows. |
| `agent_scopes` | Stable workspace and sandbox/lifecycle identity per personal or channel scope; Manager reads the scope inventory. |
| `durable_jobs` | One durable queue, using kind `agent`; message and job are inserted atomically. Eligible interactive messages join the running parent as linked running jobs, never independent worker claims; parent-first settlement updates all children in the same transaction. Other work remains FIFO per session. Uncertain inputs are never automatically replayed. Task notice jobs (`payload.notice`, `task_ids`) queue like schedule occurrences: user messages never join them. |
| `agent_schedules`, `agent_schedule_runs` | Schedule configuration, occurrences and execution history. Each occurrence enqueues an agent job in the owner's private scope. |
| `token_usage_events` | Run usage; `raw_usage_json` retains input, output, cache-read and cache-write data for admin reporting. |
| `artifacts`, `artifact_versions` | Published artifacts. `artifacts` (`id`, `scope_type` `private`/`chat`/`channel`, `scope_id` = user id, conversation id or channel id, `owner_user_id` = first publisher, `path` = the absolute sandbox path published, `kind`, `title`, `latest_version`, `created_at`, `updated_at`; unique per `(scope_type, scope_id, path)`) and `artifact_versions` (`artifact_id`, `version`, `entry`, `manifest_json` `{relpath:{sha256,size,mime}}`, `total_size`, `file_count`, `message_id` NULL until the run's assistant message is persisted, `job_id` = the run's durable job, `created_at`; primary key `(artifact_id, version)`, deleted with their artifact). File bytes are not in SQLite: they are content-addressed blobs (see [data layout](../reference/data-layout.md)). Versions are immutable; no row or blob is changed after publication. |
| `artifact_previews` | Live previews, one row per live artifact (`artifacts.kind='live'`, `latest_version` 0, no `artifact_versions`; `path` = `live:<service>`). `artifact_id` (primary key, deleted with the artifact), `preview_id` (128-bit capability, unique), `service` (the named background service), `port`, `start_path`, `base_aware`, `task_id` (the bound process `background_tasks.id`, NULL until the first run, then the last bound task), `state` (`waiting`/`running`/`stopped`, recomputed from the task and kept to announce changes once), `revoked_at` (set only by the user's explicit stop; a revoked row serves nothing), `created_at`, `updated_at`. The row follows its service name: a later process of the same name rebinds it; the capability `preview_id` never changes until revoked. |
| `background_tasks` | One row per subagent (`kind='agent'`) or Manager background process (`kind='process'`, `external_id` = Manager's `proc_…` id, unique), identified as `bg-<id>`. Holds the owner, `name`, `label`, `agent_type` and `prompt`; the outcome (`status` running/completed/failed/stopped/interrupted, `reason`, `exit_code`, `started_at`, `ended_at`, `result` of at most 64 KiB, `work_json` bounded work trace, `usage_json`); the origin (`created_by_message_id`, `created_by_tool_call_id`, `run_job_id`); and delivery (`delivered_at` set exactly once when the model receives the result, `notice_job_id`, `updated_at`). The watcher's Manager feed cursor is the setting `process_changes_cursor`. Running agents are update blockers; their rows become `interrupted` on Platform restart. |
| `skills`, `skill_preferences` | Skill metadata. `skills` rows (`tier` `org`/`personal`/`channel`, `owner_id` = user id, channel id or NULL for org, `name`, `source_json` `{kind:'upload'\|'url'\|'workspace'\|'ai'\|'migrated', url?, path?, subpath?}`, `groups_json` and `enabled` for org skills only, `installed_by`, `installed_at`, `updated_at`; unique per `(tier, owner_id, name)`) record provenance only: files on disk are the source of truth for content, and a personal skill without a row is shown with source `workspace`. `skill_preferences` holds a user's own on/off choice per skill key. The setting `builtin_skills_disabled_v1` is a JSON list of built-in names the administrator disabled organization-wide. |
| `mcp_connectors`, `mcp_secrets`, `mcp_channel_connectors`, `mcp_calls`, `mcp_catalog_cache` | MCP. `mcp_connectors` (`scope` `org`/`personal`, `owner_user_id` for personal, `name` slug unique per scope and owner, `label`, `transport` `http`/`sse`/`stdio`, `url`, `command`, `args_json`, `cwd`, `env_keys_json`/`header_keys_json` = declared secret names, `auth` `none`/`headers`/`oauth`, `credential_mode` `shared`/`per_user` (org only), `oauth_json` `{scopes?, client_id?}`, `groups_json` (`["*"]` or group names), `enabled`, `disabled_tools_json`, `source_json` `{kind: manual\|ai\|import:<format>\|legacy}`, `timeout_s` 1–600, `created_by`, timestamps). `mcp_secrets` (`connector_id`, `user_id` NULL = shared, `kind` `header`/`env`/`oauth_tokens`/`oauth_client`, `name`, `value`, `issuer`, unique per connector, user, kind and name): values are never returned by any API, only whether a key is set; like `settings.secret` this is not encryption. `mcp_channel_connectors` (`channel_id`, `connector_id`, `enabled_by`). `mcp_calls` is the audit (`at`, `user_id`, `scope_key`, `connector_id`, `connector_name`, `tool`, `status` `ok`/`error`/`cancelled`/`timeout`, `duration_ms`; never arguments or results; the latest 10,000 are kept). `mcp_catalog_cache` holds each connection's tools, prompts and resources JSON (`user_id` NULL = shared). Setting `mcp_private_networks_v1`. Connections, pending elicitations and OAuth flows are in memory only. |
| `schema_migrations` | Ordered, versioned forward migrations (each applied once) and the Manager release schema boundary. |
| `chat_conversations` | `id, user_id, title, title_state, created_at, updated_at, deleted_at`. `title_state` is `placeholder` (the client's creation placeholder; eligible for a generated title), `generated` or `user` (any rename). |
| `chat_messages` | `id, conversation_id, role, content, metadata_json, created_at`. |

Executor audit records belong to Manager, not a new SQL audit table. Tables of removed features (memory, Telegram, mail, identities, run inputs, revisions, full-text indexes) are dropped by migration `2026100101`; no pre-Pi data is retained.

## AGENTS.md memory

Personal/channel long-term context is workspace `AGENTS.md`. The agent reads or edits it through normal tools; there is no separate memory API, search index or learning review.

Platform supplies the current AGENTS.md with every run; after an edit, Pi appends the changed file as a system update on the next message rather than rewriting the prompt (see [prompt cache](agent-runtime.md#prompt-cache)).

## SKILL.md skills

Skills use the Agent Skills format: a directory with a `SKILL.md` whose YAML frontmatter has `name`, `description` and optional `license`, `compatibility`, `metadata`, `allowed-tools`, `disable-model-invocation` and the legacy `version`, `category`, `tags`. There are three tiers, each visible in every sandbox at a fixed read-only or read-write path:

| Tier | Host location | Sandbox location |
| --- | --- | --- |
| Built-in | repository `enterprise-agent-platform/skills/<name>/`, baked into the Platform and sandbox images (`AGENT_PLATFORM_BUILTIN_SKILLS_DIR`) | `/opt/agent-platform/skills/builtin/<name>/` |
| Organization | `<data_dir>/skills/org/<name>/`, written by Platform world-readable (directories 0755, files 0644, executables 0755) | `/opt/agent-platform/skills/org/<name>/` (read-only mount, agent and chat profiles) |
| Personal / channel | `<workspace>/.agent-platform/skills/<name>/` | `/workspace/.agent-platform/skills/<name>/` (agent profile only) |

Platform builds the catalog `[{name, description, location}]` (`location` = sandbox path of `SKILL.md`) for every run and Runtime passes it to Pi unchanged. Precedence is by name: personal or channel, then organization, then built-in. `disable-model-invocation: true` hides a skill from the catalog, but an explicit `/name` still works.

- Personal AI (root runs and subagents): personal skills only when the user holds `install_extensions`; organization skills assigned to `*` or to the user's permission group and enabled; built-in skills not disabled organization-wide; minus the user's own disabled skills.
- Channel: the channel workspace's skills, organization skills assigned to `*` or the triggering user's group, built-in skills not disabled organization-wide. User preferences are ignored in the shared channel.
- Standard chat: organization and built-in skills minus the user's disabled skills; no workspace skills. Chat does not load AGENTS.md.

Discovery never follows symlinks and is lenient for existing files: a missing `name` falls back to the directory name; a missing description excludes the skill and records a warning. Installs are strict: `name` is required and normalized to `[a-z0-9]+(-[a-z0-9]+)*` (at most 64 characters), `description` is 1–1024 characters, and the package has at most 2000 files, 50 MB unpacked and a `SKILL.md` of at most 256 KB, without symlinks, hardlinks, devices, absolute paths or `..`. Writes go to a temporary directory on the same filesystem and are renamed into place; an update replaces the directory atomically.

Explicit invocation: when a user message (first prompt or an inserted input) starts with `/<skill-name>` that is in the scope's catalog (hidden skills included), Platform prefixes the prompt text sent to Runtime with `[The user invoked the "<name>" skill. Read <location> first and follow it; resolve its relative paths against <skill dir>.]` followed by the user's text without the token. The stored message is unchanged; other slash text passes through.

Standard chat loads no workspace skills and no AGENTS.md. Files with those names in a chat directory are ordinary files, not automatically discovered context.

## Pi JSONL v3

Runtime stores each conversation at `data/runtimes/agent/sessions-v3/<sha256(sid)>.jsonl`. Pi `SessionManager` owns append-only message, model/thinking and compaction entries. Compaction changes model-visible context without deleting original messages. Platform history, not Runtime debug/export history, drives the UI.

Pi 1.2.0 retains the same JSONL version 3 as 0.87.1 and 0.99.2. Opening an existing v3 file does not migrate or rewrite it, so upgrades keep `sessions-v3/` and need no copy-migration. The previous Pi release (0.99.2) reads the upgraded Runtime's message, structured system-prompt, model/thinking and compaction entries, including newly appended turns whose messages carry 1.1.0's additive `durationMs`. No Pi MCP/codemode or virtual-model features are enabled. Runtime performs no session import at startup.

## Chat files and deletion

A user's conversations share the lightweight `chat-user-<id>` sandbox, mounted from `data/workspaces/chat/user-<id>`. Each conversation uses its own `<conversation_id>/` cwd. File tools reject escapes from that directory; bash can access other files of the same user. This is organizational separation, not a security boundary between that user's conversations.

Platform copies chat uploads into the conversation directory; no attachments mount is provided. Deleting a conversation soft-deletes its database row, deletes its Runtime session, hard-deletes the conversation's artifacts and versions (then every artifact blob no remaining version of any scope references) and removes its directory. It does not remove other conversations.

## Artifact retention

Artifacts have no expiry and no per-user quota; personal and channel artifacts live as long as their scope, chat artifacts as long as the conversation. Blob garbage collection runs only when a chat is deleted: it removes blobs referenced by no remaining version. Publishing writes new blobs before inserting the version, and both steps and collection exclude each other inside the Platform process, so a blob is never collected while a publish that uses it is in flight. Blobs are shared by content, so the same file published in several versions or scopes is stored once. Viewing never mutates anything; view tokens are not stored.

## Backup

Back up all persistent data before upgrading. The Manager takes a database snapshot before migration; a release rollback restores that snapshot together with the previous generation, so preserve post-release writes first (see [recovery](../reference/data-layout.md#备份与恢复)).
