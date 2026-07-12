# Repository Guidelines

## Project Structure & Module Organization

This workspace ties together ubitech agent and three upstream codebases.

- `enterprise-agent-platform/`: primary platform code. Python package lives in `enterprise_agent_platform/`, frontend source lives in `frontend/`, generated browser assets are served from `enterprise_agent_platform/static/`, tests live in `tests/`, and the managed Hermes knowledge plugin lives in `hermes_plugin/`.
- `hermes-agent/`: Git submodule for the Hermes runtime and OpenAI-compatible API server. Follow `hermes-agent/AGENTS.md` when editing this submodule.
- `cognee/`: Git submodule for the optional knowledge graph backend. Follow `cognee/AGENTS.md` when editing this submodule.
- `firecrawl/`: Git submodule for the managed self-hosted Firecrawl web runtime. Treat it as upstream code unless intentionally updating the pinned submodule revision.
- Runtime data, databases, logs, workspaces, and secrets are intentionally ignored. Use `ENTERPRISE_PLATFORM_DATA` to relocate platform state.
- This project depends on the underlying Hermes Agent, Cognee, and Firecrawl codebases. For platform adapter or integration changes involving any of them, inspect the corresponding upstream submodule first so the change matches its runtime behavior and extension points.

## Upstream Submodule Boundary

The platform is a wrapper/orchestration layer around upstream Hermes Agent, Cognee, and Firecrawl. Do not treat those submodules as owned application code.

- Do not create commits, branches, pull requests, or push attempts against `hermes-agent/`, `cognee/`, or `firecrawl/` upstream repositories during normal platform work.
- Do not update a pinned submodule revision unless the task is explicitly to bump that upstream dependency.
- If a platform feature needs behavior that would otherwise require changing Hermes, Cognee, or Firecrawl, implement it in this repository's platform-owned code instead: adapters, managed runtime configuration, plugins, wrapper services, or runtime patches such as `enterprise_agent_platform/hermes_runtime_patch/`.
- Inspect upstream submodule code freely to understand behavior and extension points, but keep the actual product change in platform-owned files.
- If an upstream change is truly unavoidable, stop and get explicit direction about the target fork/branch/PR. Never assume permission to affect upstream `main`.

## Build, Test, and Development Commands

Use the top-level one-command deploy path for local bring-up:

```bash
./deploy.sh
```

It initializes submodules, creates the root `.venv`, installs the platform package, prepares managed Hermes/Cognee/Firecrawl state, and starts the app through user-level systemd when available. Keep `hermes-agent/`, `cognee/`, and `firecrawl/` next to `enterprise-agent-platform/`; managed Hermes is installed from adjacent `hermes-agent/` source into `$ENTERPRISE_PLATFORM_DATA/runtimes/hermes/venv`, defaulting to `enterprise-agent-platform/data/runtimes/hermes/venv`.

Common deployment commands:

```bash
./deploy.sh update
./deploy.sh service
./deploy.sh foreground
./deploy.sh status
./deploy.sh restart
./deploy.sh logs
```

Run the platform locally:

```bash
cd enterprise-agent-platform
ENTERPRISE_ADMIN_PASSWORD='change-me' python3 -m enterprise_agent_platform serve
```

Run focused Python verification for the platform:

```bash
cd enterprise-agent-platform
python3 -m unittest discover -s tests
python3 -m compileall enterprise_agent_platform hermes_plugin tests
```

Or run both checks from the repository root:

```bash
./deploy.sh test
```

Run frontend checks and rebuild generated static assets when changing the browser UI:

```bash
cd enterprise-agent-platform/frontend
npm install
npm run check
npm run build
```

The frontend dev server proxies `/api` to the default platform backend:

```bash
cd enterprise-agent-platform/frontend
npm run dev
```

Use submodule-specific commands only from the relevant submodule root.

## Coding Style & Naming Conventions

Platform code is Python 3.11+, 4-space indentation, `snake_case` for functions/modules, `PascalCase` for classes, and type hints where they clarify interfaces. Keep stdlib-first patterns unless an existing dependency is already used. Frontend source is Vite + React + TypeScript in `enterprise-agent-platform/frontend/`; the current business UI still lives mostly in `frontend/src/legacy-app.js` and is bootstrapped by `frontend/src/main.tsx`. Do not hand-edit generated files in `enterprise_agent_platform/static/` unless you are intentionally updating a static-only asset; rebuild them from `frontend/` with `npm run build`.

## Testing Guidelines

The platform uses `unittest`; add Python tests in `enterprise-agent-platform/tests/test_*.py`. Prefer deterministic fakes for Hermes, Cognee, Firecrawl, Docker, OAuth, Telegram, and API-key-dependent behavior. Skip or isolate true external integration checks unless credentials and services are explicitly available. For UI changes, run `npm run check` and `npm run build` from `enterprise-agent-platform/frontend/` in addition to the Python checks.

## Runtime & Product Guidelines

- Managed runtime state belongs under the platform data directory, including Hermes, Cognee, Firecrawl, Camofox, logs, generated env files, workspaces, and local databases. Do not write generated Firecrawl env files or compose overrides into the `firecrawl/` submodule tree.
- Hermes model-provider auth is limited in the product UI to `Codex OAuth` and `Grok OAuth`, with OAuth credential import/export support. Do not reintroduce OpenAI, OpenRouter, or xAI API-key model-provider flows unless that product direction is explicitly requested.
- The platform-managed Telegram gateway routes Telegram private chats to each user's private Agent. It intentionally does not use the Hermes Telegram adapter and ignores groups, supergroups, and channels.
- Auto-update uses the admin-panel configuration, GitHub webhooks and/or polling, clean-worktree fast-forward checks, and the existing `./deploy.sh update` rollback path. Preserve that rollback behavior when changing deployment code.
- `ENTERPRISE_PUBLIC_BASE_URL` controls public URL generation, secure cookies, and browser write-request origin checks when the app is behind HTTPS.

## Agent Prompt Guidelines

When editing prompts sent to runtime agents, preserve the product-facing identity contract: agents should introduce themselves as ubitech agent and must not mention underlying frameworks, runtimes, model providers, or internal implementation details to end users. Include available user context in agent prompts, including the user's position, for both private-agent and channel speaker context.

## Commit & Pull Request Guidelines

The current top-level history uses concise imperative commits. Continue with short, action-oriented subjects; add a scope when useful, such as `platform: manage Hermes runtime`.

PRs should include a summary, affected directories, commands run, linked issues if any, and screenshots for UI changes. Call out configuration or secret-handling changes explicitly.

## Security & Configuration Tips

Never commit `.env`, runtime databases, generated workspaces, OAuth token exports, API keys, or logs. Configure OAuth credentials, tool secrets, public URL settings, Telegram settings, auto-update settings, and Hermes/Cognee/Firecrawl runtime settings through the platform settings UI or environment variables. Keep managed Hermes/Cognee/Firecrawl/Camofox state under the platform data directory.
