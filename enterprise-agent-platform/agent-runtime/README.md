# ubitech agent runtime

Platform-owned Node.js sidecar built directly on `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`. It owns the model/tool loop, durable JSONL sessions, approval waits, host processes, delegation, and the private HTTP/SSE protocol used by the Python platform.

## Build and run

Node.js 22.19 or newer is required.

```bash
npm ci
npm run check
npm test
npm start
```

Environment variables:

- `AGENT_RUNTIME_HOME`: runtime state root; defaults to `data/runtimes/agent`.
- `AGENT_RUNTIME_HOST`: bind host; defaults to `127.0.0.1`.
- `AGENT_RUNTIME_PORT`: bind port; defaults to `8766`.
- `AGENT_RUNTIME_TOKEN` or `AGENT_RUNTIME_TOKEN_FILE`: bearer credential for every endpoint, including health.
- `AGENT_PLATFORM_INTERNAL_URL` and `AGENT_PLATFORM_INTERNAL_TOKEN`: default private platform gateway used by auth and managed tools.
- `AGENT_RUNTIME_RUN_IDLE_TIMEOUT_MS`: maximum run inactivity; defaults to 1,800,000 ms (30 minutes), and `0` disables it. Model and tool progress, new input, and internal runtime stages refresh the deadline. Approval waits pause it, and child-run activity refreshes its parent. Inactivity aborts the model, gateway requests, and process group without imposing a wall-clock limit on active work.
- `AGENT_RUNTIME_MAX_TURNS`: maximum model requests within one run; defaults to 90, with a range of 1–1,000. The limit cannot be disabled because actively looping model/tool work continually refreshes the inactivity watchdog. A run may finish normally on its final allowed response; if another model request would be required, the runtime emits `run.turn_limit` and stops before sending it.
- `AGENT_RUNTIME_TERMINAL_TIMEOUT_MS`: default foreground terminal-command deadline; defaults to 180,000 ms (3 minutes), range 100–3,600,000 ms. A tool call's explicit `timeout_ms` overrides it; background commands do not inherit it.
- `AGENT_RUNTIME_MAX_CONCURRENCY`: fair FIFO top-level run concurrency from 1 to 64; defaults to 8. Delegated child runs share their parent's execution slot.
- `AGENT_RUNTIME_MAX_QUEUED_RUNS`: maximum waiting top-level runs; defaults to 256. New runs receive HTTP 429 when the queue is full.
- `AGENT_RUNTIME_REQUEST_BODY_TIMEOUT_MS`: total deadline for receiving a JSON request body; defaults to 15,000 ms.
- `AGENT_RUNTIME_CLEANUP_GRACE_MS`: maximum wait for an aborted provider/tool loop to settle; defaults to 5,000 ms.
- `AGENT_RUNTIME_APPROVAL_TIMEOUT_MS`, `AGENT_RUNTIME_RUN_RETENTION_MS`, `AGENT_RUNTIME_MAX_DELEGATION_DEPTH`, `AGENT_RUNTIME_MAX_DELEGATES`, `AGENT_RUNTIME_MAX_BODY_BYTES`, and `AGENT_RUNTIME_COMPACTION_THRESHOLD`: bounded runtime controls.

The process prints one JSON `ready` line after it starts listening. It handles `SIGINT` and `SIGTERM` by cancelling active runs and making a best-effort attempt to terminate registered process groups. Deliberately detached descendants require deployment-level cgroup or systemd-scope controls if hard termination guarantees are needed.

## Private API

- `GET /health`
- `POST /v1/runs`
- `GET /v1/runs/{run_id}`
- `GET /v1/runs/{run_id}/events` (SSE; supports `Last-Event-ID` and `?after=`)
- `POST /v1/runs/{run_id}/approval`
- `POST /v1/runs/{run_id}/cancel`
- `POST /v1/scopes/cleanup`

A run request has this shape:

```json
{
  "scope_key": "user:42",
  "lifecycle_id": "lifecycle-id",
  "session_id": "session-id",
  "workspace": "/absolute/workspace",
  "system_prompt": "You are ubitech agent.",
  "input": "Help with this task",
  "history": [],
  "attachments": [],
  "model": { "provider": "openai-codex", "id": "gpt-5.4" },
  "thinking_level": "medium",
  "metadata": {
    "idempotency_key": "durable-job-42"
  }
}
```

`POST /v1/runs` returns HTTP 202 with `run_id`, `status`, and `events_url`. Every SSE `data` value is an envelope:

```json
{
  "sequence": 1,
  "type": "run.queued",
  "run_id": "run_...",
  "timestamp": "2026-07-13T00:00:00.000Z",
  "data": {}
}
```

Terminal events are `run.completed`, `run.failed`, `run.cancelled`, and `run.needs_review`. Completion data contains both `output` and its `content` alias, plus `session_id`, `model`, and `usage`.

Model selection is restricted to product OAuth providers and fixed runtime endpoints. Codex accepts `openai-codex` or `codex` with `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, or `gpt-5.3-codex-spark`. Grok accepts `xai-oauth` or `grok` with `grok-4.3`, `grok-4.20-0309-reasoning`, or `grok-4.20-0309-non-reasoning`. Requests cannot override the provider API type or base URL.

A non-empty `metadata.idempotency_key` is scoped by `scope_key`. Its status and terminal result are stored atomically under `AGENT_RUNTIME_HOME/idempotency/`, so repeated creation returns the original run and a synthesized replayable terminal journal even after sidecar restart. A run interrupted by restart is returned as `needs_review` and is never executed again automatically.

Approval responses accept `{ "approval_id": "approval_...", "decision": "once" }`, where decision is `once`, `session`, `always`, or `deny`. `approval_id` may be omitted to resolve the newest pending approval for the run. Unknown fields are rejected.

`always` grants are atomically persisted under `AGENT_RUNTIME_HOME/approvals/`. `session` grants use a permission-`0600` lifecycle journal beside the session JSONL files; scope cleanup atomically resets that journal. Neither store contains OAuth credentials.

Session context is compacted with an atomic JSONL replacement when it crosses the configured model-context threshold. Before replacement, omitted messages are fsynced to an append-only, entry-id-deduplicated archive beside the active journal. The local `session` tool searches the archive plus the active journal, preserving full durable tool-call history. Disposable delegated scopes delete their session journal, archive, and temporary memory after completion.

Before a top-level run starts, the runtime performs a best-effort query search of Agent memory and lists the current user's profile memory. Empty results are not injected. Whole records that fit separate bounded budgets are serialized as escaped structured data with an explicit untrusted-data boundary; recall failures do not fail the run.

Managed memory and knowledge tools adapt to the protected `/api/agent/tools/...` routes. `session` searches the sidecar's scope/lifecycle/session-isolated active journal and archive; `session_search` uses the platform API for cross-session user/Agent text, result windows, and session reads. Both tools mark returned history as untrusted data, never instructions. Web and browser use `POST {platform_url}/internal/agent/tools/{tool}`. Credential lookup calls `/api/agent/tools/credentials/resolve`; OAuth credentials are resolved by the Python platform and are never accepted in run metadata.

Memory gateway ownership is derived from a positive integer `metadata.actor.id` after tool arguments are merged. Model-provided `owner_user_id`, including values nested in batch operations, cannot override runtime context. Mutations receive trusted run/message provenance and `source_type=tool`; committed memory content accepted by `store` and `replace` is limited to 4,000 characters. A top-level interactive private Agent may submit an idempotent pending `memory.propose` candidate for stable user facts or Agent rules without a write-approval card; proposals are not committed memory and are not recalled until accepted by the platform.

Relative file and command working-directory paths default to the Agent workspace. Resolved paths outside the workspace require approval, including traversal and symlink aliases. All host commands and file mutations require approval. Direct file-tool writes to protected system trees (`/etc`, `/boot`, `/proc`, `/sys`, `/dev`), process credential/memory reads under `/proc`, and Docker socket access are blocked; command-text blocking is defense in depth rather than an OS sandbox.

Foreground terminal commands send an internal activity heartbeat while their process remains alive, so a quiet but healthy command does not trip the run inactivity watchdog. A model-supplied `timeout_ms` remains the command's independent deadline; background commands return immediately and do not keep a completed Agent run active.

Host commands inherit ordinary process settings such as `PATH`, but the runtime removes environment variables whose names identify secrets, tokens, passwords, API keys, credentials, or private keys before spawning the command.
