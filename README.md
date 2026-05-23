# Enterprise Agent Platform Workspace

This repository manages the enterprise agent platform built on top of the local Hermes Agent and Cognee codebases.

## Layout

- `enterprise-agent-platform/` - the web platform layer: account login, channel chat, private agents, managed workspaces/containers, central model key configuration, enterprise knowledge base, tests, and Hermes knowledge-tool plugin.
- `hermes-agent/` - Git submodule pinned to `NousResearch/hermes-agent`, used as the agent runtime and OpenAI-compatible agent API backend.
- `cognee/` - Git submodule pinned to `topoteretes/cognee`, used as the optional enterprise knowledge graph backend.

## Quick Start

```bash
./deploy.sh
```

Then open `http://127.0.0.1:8765`. The deploy script initializes submodules, creates the platform `.venv`, installs the platform, prepares managed runtime state, and starts the platform. If user-level systemd is available it installs and starts `enterprise-agent-platform.service`; otherwise it runs the server in the foreground.

If no admin password is configured before first boot, the bootstrap account is `admin` / `admin`.

On first startup, the platform expects the adjacent `hermes-agent/` submodule to be present. `./deploy.sh` initializes that submodule automatically, and the platform creates `enterprise-agent-platform/data/runtimes/hermes/venv`, installs Hermes from local source with an editable install, writes managed Hermes config, and starts the Hermes API server when agent traffic needs it. Hermes source path, API URL, model name, install extras, startup wait, and API server key can be managed in the platform Settings screen.

Service management:

```bash
./deploy.sh status
./deploy.sh restart
./deploy.sh logs
./deploy.sh foreground
```

## Verification

```bash
./deploy.sh test
```

## Hermes Knowledge Tools

The managed startup installs and enables the `enterprise-kb` Hermes plugin automatically. The plugin exposes:

- `enterprise_kb_search(query, limit)`
- `enterprise_kb_read(document_id)`

## Runtime Data

Runtime databases, workspaces, local containers, logs, and secrets are intentionally excluded from Git. Use `ENTERPRISE_PLATFORM_DATA` to choose the platform data directory.
