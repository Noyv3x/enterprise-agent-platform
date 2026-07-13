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

An offline migration can import platform-visible legacy user/assistant history
after the old runtime and this sidecar have both stopped:

```bash
npm run build
node dist/src/legacy-session-importer.js --manifest /absolute/path/legacy-sessions.json --home /absolute/path/agent-runtime-home
```

The manifest must be a non-symlink regular file with mode `0600`. It uses
`{"version":1,"sessions":[...]}`; every session contains `scope_key`,
`lifecycle_id`, `session_id`, a product `model` (`provider` and `id`), and
plain visible `messages` (`role`, `content`, and integer millisecond
`timestamp`). The importer derives all journal paths from hashed identities and
prints only JSON counts. It can refresh a journal created by the same migration
marker, but skips any session that Pi has used.

Environment variables:

- `AGENT_RUNTIME_HOME`: runtime state root; defaults to `data/runtimes/agent`.
- `AGENT_RUNTIME_HOST`: bind host; defaults to `127.0.0.1`.
- `AGENT_RUNTIME_PORT`: bind port; defaults to `8766`.
- `AGENT_RUNTIME_TOKEN` or `AGENT_RUNTIME_TOKEN_FILE`: bearer credential for every endpoint, including health.
- `AGENT_PLATFORM_INTERNAL_URL` and `AGENT_PLATFORM_INTERNAL_TOKEN`: default private platform gateway used by auth and managed tools.
- `AGENT_RUNTIME_RUN_TIMEOUT_MS`: hard top-level and child run lifetime; defaults to 240,000 ms. Timeout aborts the model, approval waits, gateway requests, and process group.
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

Approval responses accept `{ "approval_id": "approval_...", "decision": "once" }`, where decision is `once`, `session`, `always`, or `deny`. `approval_id` may be omitted to resolve the newest pending approval for the run. The legacy `choice` and `resolve_all` fields are accepted for adapter compatibility.

`always` grants are atomically persisted under `AGENT_RUNTIME_HOME/approvals/`. `session` grants use a permission-`0600` lifecycle journal beside the session JSONL files; scope cleanup atomically resets that journal. Neither store contains OAuth credentials.

Session context is physically compacted with an atomic JSONL replacement when it crosses the configured model-context threshold. Disposable delegated scopes delete their session journal and temporary memory after completion, while clearing a conversation deletes the retired lifecycle after active runs and host processes have stopped.

Before a top-level run starts, the runtime performs a best-effort memory search for the user input and injects at most about 2,000 tokens of recalled context. Recall failures do not fail the run.

Managed memory and knowledge tools adapt to the protected `/api/agent/tools/...` routes. Session search reads the sidecar's own scope/lifecycle/session-isolated JSONL journal. Web and browser use `POST {platform_url}/internal/agent/tools/{tool}`. Credential lookup calls `/api/agent/tools/credentials/resolve`; OAuth credentials are resolved by the Python platform and are never accepted in run metadata.

Memory gateway ownership is derived from a positive integer `metadata.actor.id` after tool arguments are merged. Model-provided `owner_user_id`, scope, lifecycle, and session values cannot override runtime context.

Relative file and command working-directory paths default to the Agent workspace. Resolved paths outside the workspace require approval, including traversal and symlink aliases. All host commands and file mutations require approval. Direct file-tool writes to protected system trees (`/etc`, `/boot`, `/proc`, `/sys`, `/dev`), process credential/memory reads under `/proc`, and Docker socket access are blocked; command-text blocking is defense in depth rather than an OS sandbox.

Host commands inherit ordinary process settings such as `PATH`, but the runtime removes environment variables whose names identify secrets, tokens, passwords, API keys, credentials, or private keys before spawning the command.
