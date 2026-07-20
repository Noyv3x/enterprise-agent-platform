# Repository Guidelines

## Project Structure & Module Organization

This workspace contains ubitech agent plus two upstream integrations.

- `enterprise-agent-platform/`: primary platform code. Python lives in `enterprise_agent_platform/`, frontend source in `frontend/`, generated browser assets in `enterprise_agent_platform/static/`, tests in `tests/`, and the platform-owned Node.js runtime in `agent-runtime/`.
- `cognee/`: Git submodule for the optional knowledge graph backend. Follow `cognee/AGENTS.md` when editing this submodule.
- `firecrawl/`: Git submodule for managed webpage extraction. Web search uses a separate platform-managed local SearXNG service. Treat Firecrawl itself as upstream code unless intentionally updating the pinned submodule revision.
- Runtime data, databases, logs, workspaces, and secrets are intentionally ignored. Use `ENTERPRISE_PLATFORM_DATA` to relocate platform state.
- The Agent runtime directly uses exact npm versions of `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`; it does not use a Pi submodule or CLI wrapper.

## Upstream Submodule Boundary

Cognee and Firecrawl are upstream submodules. Do not treat them as owned application code.

- Do not create commits, branches, pull requests, or push attempts against `cognee/` or `firecrawl/` during normal platform work.
- Do not update a pinned submodule revision unless the task is explicitly to bump that upstream dependency.
- Implement Agent behavior in `agent-runtime/` or platform-owned Python adapters. Implement Cognee/Firecrawl integration changes through platform adapters and managed configuration.
- Inspect upstream submodule code freely to understand behavior and extension points, but keep the actual product change in platform-owned files.
- If an upstream change is truly unavoidable, stop and get explicit direction about the target fork/branch/PR. Never assume permission to affect upstream `main`.

## Build, Test, and Development Commands

Use the top-level one-command deploy path for local bring-up:

```bash
./deploy.sh
```

It initializes Cognee/Firecrawl submodules, creates the root `.venv`, installs the platform package, builds the locked Node.js Agent runtime, prepares managed state including local SearXNG, and starts the app through user-level systemd when available. Python 3.11+ and Node.js 22.19+ are required.

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
python3 -m compileall enterprise_agent_platform tests
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

Run Agent runtime checks when changing model, session, tool, approval, process, or delegation behavior:

```bash
cd enterprise-agent-platform/agent-runtime
npm ci
npm run check
npm test
npm run build
```

Use submodule-specific commands only from the relevant submodule root.

## Coding Style & Naming Conventions

Platform code is Python 3.11+, 4-space indentation, `snake_case` for functions/modules, `PascalCase` for classes, and type hints where they clarify interfaces. Agent runtime code is strict TypeScript targeting Node.js 22.19+. Frontend source is Vite + React + TypeScript in `enterprise-agent-platform/frontend/`. Do not hand-edit generated files in `enterprise_agent_platform/static/`; rebuild them from `frontend/` with `npm run build`.

## Testing Guidelines

The platform uses `unittest`; add Python tests in `enterprise-agent-platform/tests/test_*.py`. The Agent runtime uses Node's test runner under `agent-runtime/test/`. Prefer deterministic fakes for models, Cognee, Firecrawl, SearXNG, OAuth, Telegram, and credential-dependent behavior. Skip or isolate true external integration checks unless credentials and services are explicitly available. For UI changes, run `npm run check`, `npm test`, and `npm run build` from `frontend/`.

## Runtime & Product Guidelines

- Managed runtime state belongs under the platform data directory, including Agent sessions/memory, Cognee, Firecrawl, SearXNG, Camofox, logs, workspaces, and local databases. Keep generated Firecrawl and SearXNG configuration out of the `firecrawl/` submodule tree.
- Model-provider auth is limited in the product UI to `Codex OAuth` and `Grok OAuth`, with OAuth credential import/export support. Do not reintroduce OpenAI, OpenRouter, or xAI API-key flows unless explicitly requested.
- The platform-managed Telegram gateway routes private chats to each user's private Agent and ignores groups, supergroups, and channels.
- Agents execute on the host with logical workspace/session/memory/browser separation. Preserve the `once/session/always/deny` approval flow, protected file-path checks, and defense-in-depth blocking of obvious destructive commands; none of these is an OS sandbox.
- Auto-update uses the admin-panel configuration, GitHub webhooks and/or polling, clean-worktree fast-forward checks, and the existing `./deploy.sh update` rollback path. Preserve that rollback behavior when changing deployment code.
- `ENTERPRISE_PUBLIC_BASE_URL` controls public URL generation, secure cookies, and browser write-request origin checks when the app is behind HTTPS.

## Agent Prompt Guidelines

When editing prompts sent to runtime agents, preserve the product-facing identity contract: agents should introduce themselves as ubitech agent and must not mention underlying frameworks, runtimes, model providers, or internal implementation details to end users. Include available user context in agent prompts, including the user's position, for both private-agent and channel speaker context.

## Commit & Pull Request Guidelines

The current top-level history uses concise imperative commits. Continue with short, action-oriented subjects; add a scope when useful, such as `runtime: isolate Agent sessions`.

PRs should include a summary, affected directories, commands run, linked issues if any, and screenshots for UI changes. Call out configuration or secret-handling changes explicitly.

## Security & Configuration Tips

Never commit `.env`, runtime databases, generated workspaces, OAuth token exports, API keys, bearer tokens, or logs. Configure OAuth credentials, tool secrets, public URL settings, Telegram settings, auto-update settings, and runtime settings through the platform UI or environment variables. Keep all managed state under the platform data directory.
