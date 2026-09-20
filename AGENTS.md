# Repository Guidelines

## Project Overview

Start with the [documentation index](docs/README.md) and [product purpose and boundaries](docs/design/product.md) before deciding what a change should accomplish. This file provides assistant workflow and navigation; keep architecture, configuration, product, and operational facts in canonical `docs/`, not a second handbook here.

Before implementation, state deliverables, non-goals, affected domains, and expected scope. Pause and report if scope exceeds twice the estimate or becomes a new protocol, migration, or release architecture.

## Architecture & Data Flow

Consult [system architecture](docs/design/system-architecture.md), [Runtime design](docs/design/agent-runtime.md), and [frontend design](docs/design/frontend.md). Trace request admission, durable work, model/tool execution, result persistence, and event reconciliation end-to-end before changing an interface.

Preserve documented ownership and [trust boundaries](docs/design/security-and-trust.md). Keep authorization server-side; do not bypass execution/audit boundaries or introduce parallel controllers. Migrate every affected producer, consumer, and acceptance check together.

## Key Directories

Use the [directory ownership map](docs/development/repository.md) and [domain manifest](docs/domains.json) to choose source and test locations; do not infer ownership from a familiar project layout. Keep changes within the requested domains.

Keep runtime databases, credentials, uploads, temporary upstream checkouts, and generated output out of source changes. Put disposable diagnostics in an explicit temporary location and remove them after verification. Regenerate artifacts through their documented owners rather than editing them directly.

## Development Commands

Run from the repository root:

```sh
./scripts/test.sh affected
./scripts/test.sh full
python3 scripts/docs_sync.py check
python3 scripts/docs_sync.py check-change --base HEAD --head WORKTREE
```

Use `affected` during iteration and one final `full` gate for delivery. Check the actual working tree, not an empty `HEAD`-to-`HEAD` comparison. After changing a machine contract, regenerate with `python3 scripts/docs_sync.py sync`.

For focused frontend work:

```sh
npm --prefix enterprise-agent-platform/frontend run dev
npm --prefix enterprise-agent-platform/frontend run check
npm --prefix enterprise-agent-platform/frontend run build
```

Use [component commands](docs/development/testing.md) for other builds/tests and static checks, including `go vet`. Do not invent `npm run lint`. Treat a UI dev server as UI-only verification; use the [deployment guide](docs/operations/deployment.md) for complete startup prerequisites.

## Code Conventions & Common Patterns

- Follow adjacent formatting and naming; use Python `snake_case` and existing `*_test.go`, `test_*.py`, and `*.test.ts(x)` test conventions. Avoid unrelated formatting or refactors.
- Reuse explicit client/executor interfaces for dependency injection; never add test-only execution fallbacks to production code.
- Use existing transaction helpers, durable/idempotent mutation boundaries, and typed errors. Preserve review-needed outcomes when side effects are uncertain; never blindly replay mutations after a timeout.
- Preserve account, scope, Run, and lifecycle checks across asynchronous work. Cancellation alone is not a stale-response fence; release locks, subscriptions, and capacity on every exit path.
- Reuse typed UI actions/reducers and stable selectors. Avoid freshly allocated array/object snapshots in `useSyncExternalStore` selectors. Keep user-visible changes localized and accessible.

## Important Files

Use [docs/domains.json](docs/domains.json) to identify every affected specification and generated consumer. Follow the [documentation workflow](docs/development/documentation-workflow.md): update intended design/contracts first, then implementation and tests. Do not rewrite intended design merely to excuse a mismatch.

For implementation tracing, start at existing composition roots rather than adding alternatives: [Manager entry](manager/cmd/agent-platform-manager/main.go), [Platform server](enterprise-agent-platform/enterprise_agent_platform/server.py) / [service](enterprise-agent-platform/enterprise_agent_platform/service.py), [Runtime server](enterprise-agent-platform/agent-runtime/src/server.ts) / [coordinator](enterprise-agent-platform/agent-runtime/src/run-coordinator.ts), and [UI App](enterprise-agent-platform/frontend/src/App.tsx). Consult the [configuration reference](docs/reference/configuration.md) and [Runtime API](docs/reference/runtime-api.md) before changing their contracts.

## Runtime/Tooling Preferences

Use repository-declared Node/npm, Python, and Go toolchains; resolve versions from component manifests and CI rather than copying defaults. Use existing npm lockfiles and `npm ci` in the relevant workspace; do not substitute Bun or another package manager because the assistant harness provides it. Invoke repository Python tools with `python3`.

Avoid redundant Runtime builds: use the documented build-once/compiled-test sequence. Preserve user and collaborator changes; never use destructive resets to hide conflicts. Apply least privilege to external inputs, credentials, and production data; verify boundaries and a recovery path before irreversible operations. Do not modify temporary upstream checkouts as product source.

## Testing & QA

Follow the [change-specific QA requirements](docs/development/testing.md). Reuse existing Go testing, Python unittest, Node test-runner, and Vitest/Testing Library patterns. Use isolated temporary data, real UI providers/store, and deterministic fakes at established external-service boundaries.

Cover observable behavior, authorization denial, recovery, and asynchronous identity races. Prefer explicit synchronization over sleeps; do not increase timeouts, weaken assertions, or replace behavioral coverage with source/CSS snapshots to get green results.

For UI changes, verify the actual browser surface: keyboard/focus, scrolling, short/zoomed windows, responsive layouts, and reduced motion. Report unavailable capabilities and unexecuted checks honestly. Read Docker/systemd integration prerequisites before running those gates against any host.

Deliver coherent documentation, implementation, tests, and generated consumers. Remove diagnostic patches and unused compatibility paths. Before a release-triggering push, complete the full local gate; never push incomplete checkpoints merely to obtain CI feedback.
