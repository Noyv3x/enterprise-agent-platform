# Data, memory and sessions

[Data layout](../reference/data-layout.md) defines physical paths. [Platform API](../reference/platform-api.md) and [Runtime API](../reference/runtime-api.md) define access. SQLite and Pi journals have distinct responsibilities.

## Product database

| Tables | Purpose |
| --- | --- |
| `users`, `settings` | Accounts, permission groups, personal model/thinking settings, the administrator-set chat model (`users.chat_model_name`, `''` follows the personal AI model), branding and OAuth. Signed login cookies use `users.token_version` for revocation; there is no login-session table. |
| `channels`, `messages`, `attachments` | Shared/private product history and attachment metadata; bytes remain on disk. Hiding messages resets the visible conversation. Channel authorization uses permission groups, not membership rows. |
| `agent_scopes` | Stable workspace and sandbox/lifecycle identity per personal or channel scope; Manager reads the scope inventory. |
| `durable_jobs` | One durable queue, using kind `agent`; message and job are inserted atomically. Eligible interactive messages join the running parent as linked running jobs, never independent worker claims; parent-first settlement updates all children in the same transaction. Other work remains FIFO per session. Uncertain inputs are never automatically replayed. Task notice jobs (`payload.notice`, `task_ids`) queue like schedule occurrences: user messages never join them. |
| `agent_schedules`, `agent_schedule_runs` | Schedule configuration, occurrences and execution history. Each occurrence enqueues an agent job in the owner's private scope. |
| `token_usage_events` | Run usage; `raw_usage_json` retains input, output, cache-read and cache-write data for admin reporting. |
| `background_tasks` | One row per subagent (`kind='agent'`) or Manager background process (`kind='process'`, `external_id` = Manager's `proc_…` id, unique), identified as `bg-<id>`. Holds the owner, `name`, `label`, `agent_type` and `prompt`; the outcome (`status` running/completed/failed/stopped/interrupted, `reason`, `exit_code`, `started_at`, `ended_at`, `result` of at most 64 KiB, `work_json` bounded work trace, `usage_json`); the origin (`created_by_message_id`, `created_by_tool_call_id`, `run_job_id`); and delivery (`delivered_at` set exactly once when the model receives the result, `notice_job_id`, `updated_at`). The watcher's Manager feed cursor is the setting `process_changes_cursor`. Running agents are update blockers; their rows become `interrupted` on Platform restart. |
| `schema_migrations` | Ordered, versioned forward migrations (each applied once) and the Manager release schema boundary. |
| `chat_conversations` | `id, user_id, title, created_at, updated_at, deleted_at`. |
| `chat_messages` | `id, conversation_id, role, content, metadata_json, created_at`. |

Executor audit records belong to Manager, not a new SQL audit table. Tables of removed features (memory, Telegram, mail, identities, run inputs, revisions, full-text indexes) are dropped by migration `2026100101`; no pre-Pi data is retained.

## AGENTS.md memory

Personal/channel long-term context is workspace `AGENTS.md`. The agent reads or edits it through normal tools; there is no separate memory API, search index or learning review.

Platform supplies the current AGENTS.md with every run; after an edit, Pi appends the changed file as a system update on the next message rather than rewriting the prompt (see [prompt cache](agent-runtime.md#prompt-cache)).

## SKILL.md skills

Enabled packages live at `.agent-platform/skills/<name>/SKILL.md`. Pi advertises names, descriptions and readable locations; full instructions are read on demand. Bundled skills are read-only Runtime resources.

Standard chat loads neither skills nor AGENTS.md. Files with those names in a chat directory are ordinary files, not automatically discovered context.

## Pi JSONL v3

Runtime stores each conversation at `data/runtimes/agent/sessions-v3/<sha256(sid)>.jsonl`. Pi `SessionManager` owns append-only message, model/thinking and compaction entries. Compaction changes model-visible context without deleting original messages. Platform history, not Runtime debug/export history, drives the UI.

Pi 0.99.2 retains the same JSONL version 3 as 0.87.1. Opening an existing v3 file does not migrate or rewrite it, so this upgrade keeps `sessions-v3/` and needs no copy-migration. The previous Pi release can read the upgraded Runtime's supported message, structured system-prompt, model/thinking and compaction entries, including newly appended turns. No new MCP/codemode or virtual-model features are enabled. Runtime performs no session import at startup.

## Chat files and deletion

A user's conversations share the lightweight `chat-user-<id>` sandbox, mounted from `data/workspaces/chat/user-<id>`. Each conversation uses its own `<conversation_id>/` cwd. File tools reject escapes from that directory; bash can access other files of the same user. This is organizational separation, not a security boundary between that user's conversations.

Platform copies chat uploads into the conversation directory; no attachments mount is provided. Deleting a conversation soft-deletes its database row, deletes its Runtime session and removes its directory. It does not remove other conversations.

## Backup

Back up all persistent data before upgrading. The Manager takes a database snapshot before migration; a release rollback restores that snapshot together with the previous generation, so preserve post-release writes first (see [recovery](../reference/data-layout.md#备份与恢复)).
