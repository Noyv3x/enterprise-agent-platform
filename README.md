# Enterprise Agent Platform Workspace

This repository manages the enterprise agent platform built on top of the local Hermes Agent and Cognee codebases.

## Layout

- `enterprise-agent-platform/` - the web platform layer: account login, channel chat, private agents, managed workspaces/containers, central model key configuration, enterprise knowledge base, tests, and Hermes knowledge-tool plugin.
- `hermes-agent/` - Git submodule pinned to `NousResearch/hermes-agent`, used as the agent runtime and OpenAI-compatible agent API backend.
- `cognee/` - Git submodule pinned to `topoteretes/cognee`, used as the optional enterprise knowledge graph backend.

## Quick Start

```bash
git submodule update --init --recursive
cd enterprise-agent-platform
ENTERPRISE_ADMIN_PASSWORD='change-me' python3 -m enterprise_agent_platform serve
```

Then open `http://127.0.0.1:8765`.

If no admin password is configured before first boot, the bootstrap account is `admin` / `admin`.

## Verification

```bash
cd enterprise-agent-platform
python3 -m unittest discover -s tests
python3 -m compileall enterprise_agent_platform tests
```

## Hermes Knowledge Tools

```bash
cd enterprise-agent-platform
python3 -m enterprise_agent_platform install-hermes-plugin
python3 -m enterprise_agent_platform print-agent-token
```

Set these for Hermes:

```bash
export ENTERPRISE_PLATFORM_URL='http://127.0.0.1:8765'
export ENTERPRISE_AGENT_TOOL_TOKEN='<printed token>'
```

Enable plugin key `enterprise_kb` in Hermes config. The platform exposes:

- `enterprise_kb_search(query, limit)`
- `enterprise_kb_read(document_id)`

## Runtime Data

Runtime databases, workspaces, local containers, logs, and secrets are intentionally excluded from Git. Use `ENTERPRISE_PLATFORM_DATA` to choose the platform data directory.
