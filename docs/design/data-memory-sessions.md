# Data, memory and sessions

[Data layout](../reference/data-layout.md) defines physical paths. [Platform API](../reference/platform-api.md) and [Runtime API](../reference/runtime-api.md) define access. SQLite and Pi journals have distinct responsibilities.

## Product database

| Tables | Purpose |
| --- | --- |
| `users`, `settings` | Accounts, permission groups, personal model/thinking settings, branding and OAuth. Signed login cookies use `users.token_version` for revocation; there is no login-session table. |
| `channels`, `messages`, `conversation_revisions`, `attachments` | Shared/private product history, reset revisions and attachment metadata; bytes remain on disk. Channel authorization uses permission groups, not membership rows. |
| `agent_scopes`, `agent_runtime_scopes`, `agent_runtime_scope_sessions` | Stable workspace inventory and active runtime identity; Manager continues to read the scope inventory. |
| `durable_jobs` | One durable queue, using kind `agent`; message and job are inserted atomically. FIFO per session; no automatic replay after uncertain execution. |
| `agent_schedules`, `agent_schedule_runs` | Schedule configuration, occurrences and execution history. Each occurrence enqueues an agent job in the owner's private scope. |
| `token_usage_events` | Run usage; `raw_usage_json` retains input, output, cache-read and cache-write data for admin reporting. |
| `schema_migrations` | Additive, versioned migrations and the Manager release schema boundary. |
| `chat_conversations` | `id, user_id, title, model_id, created_at, updated_at, deleted_at`. |
| `chat_messages` | `id, conversation_id, role, content, metadata_json, created_at`. |
| `chat_model_policies` | `user_id` primary key, `allowed_models_json, default_model_id, updated_at`. |

Removed-feature tables are retained but no longer consumed as active features. Executor audit records belong to Manager, not a new SQL audit table.

## AGENTS.md memory

Personal/channel long-term context is workspace `AGENTS.md`. The agent reads or edits it through normal tools; there is no separate memory API, search index or learning review.

During `migrate`, export old `agent_memories` into a `## Memory (migrated)` section once per destination workspace. User-target memories go only to that user's private workspace. Preserve existing content and old tables. The session captures supplied AGENTS.md when its in-memory object is created; edits do not mutate an active system prompt.

## SKILL.md skills

Enabled packages stay at `.agent-platform/skills/<name>/SKILL.md`; disabled old packages move to `.agent-platform/skills-disabled/`. Preserve package files rather than reconstructing them from sidecar state. Pi advertises names, descriptions and readable locations; full instructions are read on demand. Bundled skills are read-only Runtime resources.

Standard chat loads neither skills nor AGENTS.md. Files with those names in a chat directory are ordinary files, not automatically discovered context.

## Pi JSONL v3

Runtime stores each conversation at `data/runtimes/agent/sessions-v3/<sha256(sid)>.jsonl`. Pi `SessionManager` owns append-only message, model/thinking and compaction entries. Compaction changes model-visible context without deleting original messages. Platform history, not Runtime debug/export history, drives the UI.

Platform's migration writes `data/runtimes/agent/migration/active-sessions.json` from active scope identities. Runtime imports matching production format-4 journals into the separate v3 tree, preserving all messages and the latest compaction's retained context. Temporary output is atomically renamed and the migration marker is written last. Retrying is idempotent; old `sessions/` and `sessions.pre-pi/` are never modified. Inactive lifecycles and delegate children stay archived, not imported.

## Chat files and deletion

A user's conversations share the lightweight `chat-user-<id>` sandbox, mounted from `data/workspaces/chat/user-<id>`. Each conversation uses its own `<conversation_id>/` cwd. File tools reject escapes from that directory; bash can access other files of the same user. This is organizational separation, not a security boundary between that user's conversations.

Platform copies chat uploads into the conversation directory; no attachments mount is provided. Deleting a conversation soft-deletes its database row, deletes its Runtime session and removes its directory. It does not remove other conversations or historical rollback data.

## Rollback

R2 makes additive DB changes and writes a new session directory. Old formats and removed-feature data remain readable by the previous release. This preserves rollback compatibility, not bidirectional transcript synchronization: the previous Runtime will not see R2 turns. Back up all persistent data before upgrading; never overwrite post-release writes with an old snapshot without preserving them.
