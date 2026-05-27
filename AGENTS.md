# Repository Guidelines

## Project Structure & Module Organization

This workspace ties together an enterprise platform and three upstream codebases.

- `enterprise-agent-platform/`: primary platform code. Python package lives in `enterprise_agent_platform/`, browser assets in `enterprise_agent_platform/static/`, tests in `tests/`, and the managed Hermes knowledge plugin in `hermes_plugin/`.
- `hermes-agent/`: Git submodule for the Hermes runtime and OpenAI-compatible API server. Follow `hermes-agent/AGENTS.md` when editing this submodule.
- `cognee/`: Git submodule for the optional knowledge graph backend. Follow `cognee/AGENTS.md` when editing this submodule.
- `firecrawl/`: Git submodule for the managed self-hosted Firecrawl web runtime. Treat it as upstream code unless intentionally updating the pinned submodule revision.
- Runtime data, databases, logs, workspaces, and secrets are intentionally ignored. Use `ENTERPRISE_PLATFORM_DATA` to relocate platform state.
- This project depends on the underlying Hermes Agent and Cognee codebases. For platform adapter or integration changes involving either system, inspect the corresponding upstream submodule first so the change matches its runtime behavior and extension points.

## Build, Test, and Development Commands

Use the top-level one-command deploy path for local bring-up:

```bash
./deploy.sh
```

It initializes submodules, creates `.venv`, installs the platform package, prepares managed Hermes/Cognee/Firecrawl state, and starts the app through user-level systemd when available. Keep `hermes-agent/`, `cognee/`, and `firecrawl/` next to `enterprise-agent-platform/`; managed Hermes is installed from adjacent `hermes-agent/` source into `data/runtimes/hermes/venv`.

Run the platform locally:

```bash
cd enterprise-agent-platform
ENTERPRISE_ADMIN_PASSWORD='change-me' python3 -m enterprise_agent_platform serve
```

Run focused verification for the platform:

```bash
cd enterprise-agent-platform
python3 -m unittest discover -s tests
python3 -m compileall enterprise_agent_platform hermes_plugin tests
```

Or run both checks from the repository root:

```bash
./deploy.sh test
```

Use submodule-specific commands only from the relevant submodule root.

## Coding Style & Naming Conventions

Platform code is Python 3.11+, 4-space indentation, `snake_case` for functions/modules, `PascalCase` for classes, and type hints where they clarify interfaces. Keep stdlib-first patterns unless an existing dependency is already used. Static assets are plain HTML/CSS/JavaScript; keep UI code small and framework-free unless the project adopts a framework.

## Testing Guidelines

The platform uses `unittest`; add tests in `enterprise-agent-platform/tests/test_*.py`. Prefer deterministic fakes for Hermes, Cognee, Docker, and API-key-dependent behavior. Skip or isolate true external integration checks unless credentials and services are explicitly available.

## Commit & Pull Request Guidelines

The current top-level history uses concise imperative commits, e.g. `Initial enterprise agent platform workspace`. Continue with short, action-oriented subjects; add a scope when useful, such as `platform: manage Hermes runtime`.

PRs should include a summary, affected directories, commands run, linked issues if any, and screenshots for UI changes. Call out configuration or secret-handling changes explicitly.

## Security & Configuration Tips

Never commit `.env`, runtime databases, generated workspaces, API keys, or logs. Configure model credentials and Hermes runtime settings through the platform settings UI or environment variables. Keep managed Hermes/Cognee/Firecrawl state under the platform data directory.
