# Enterprise Agent Platform

This is a thin enterprise platform layer for the local `hermes-agent` and `cognee` repositories in this workspace.

It provides:

- Account/password login with signed HttpOnly sessions.
- Channel-based web chat. Each channel routes to one shared main Hermes agent thread.
- Per-user private agents. The platform creates an isolated workspace and, when Docker is available, starts a managed container for the user.
- Central model/API key configuration. Users never enter model keys in their private agent session.
- Enterprise knowledge base with document ingestion, search, passive per-turn suggestions, optional Cognee hybrid indexing, and Hermes tools.
- A Hermes plugin exposing `enterprise_kb_search` and `enterprise_kb_read`.

## Run

```bash
cd /home/dev/code/agent/enterprise-agent-platform
ENTERPRISE_ADMIN_PASSWORD='change-me' python3 -m enterprise_agent_platform serve
```

Open `http://127.0.0.1:8765`.

If `ENTERPRISE_ADMIN_PASSWORD` is not set before first run, the bootstrap account is `admin` / `admin`.

## Hermes Integration

Start Hermes' API server separately and point the platform at it:

```bash
export ENTERPRISE_HERMES_API_URL='http://127.0.0.1:8642/v1/chat/completions'
export ENTERPRISE_HERMES_API_KEY='<API_SERVER_KEY if configured>'
python3 -m enterprise_agent_platform serve
```

The platform sends:

- `X-Hermes-Session-Id: enterprise-channel-<id>-main-agent` for shared channel bot threads.
- `X-Hermes-Session-Id: enterprise-private-u<user_id>` for private agents.
- `X-Hermes-Session-Key` for long-term memory scoping.

## Knowledge Tools For Hermes

The platform keeps a local SQLite/FTS index for fast UI reads and deterministic operation. Set `ENTERPRISE_KB_BACKEND=hybrid` (default) to also attempt ingestion/search through the local `cognee` repository, or `ENTERPRISE_KB_BACKEND=local` to skip Cognee during development.

Install the bundled plugin into a Hermes profile:

```bash
python3 -m enterprise_agent_platform install-hermes-plugin
python3 -m enterprise_agent_platform print-agent-token
```

Then configure Hermes with:

```bash
export ENTERPRISE_PLATFORM_URL='http://127.0.0.1:8765'
export ENTERPRISE_AGENT_TOOL_TOKEN='<printed token>'
```

Enable the plugin in Hermes config under `plugins.enabled` with `enterprise_kb`. The tools exposed to Hermes are:

- `enterprise_kb_search(query, limit)`
- `enterprise_kb_read(document_id)`

## Container Behavior

`ENTERPRISE_CONTAINER_BACKEND=auto` is the default. It uses Docker if `docker info` succeeds; otherwise it creates a local workspace under `data/workspaces/user-<id>`.

Useful settings:

```bash
export ENTERPRISE_CONTAINER_BACKEND=docker
export ENTERPRISE_CONTAINER_IMAGE=python:3.11-slim
```

## Tests

```bash
cd /home/dev/code/agent/enterprise-agent-platform
python3 -m unittest discover -s tests
```
