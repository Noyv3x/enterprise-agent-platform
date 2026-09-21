# Repository Guidelines

## Project Overview

Start with the [documentation index](docs/README.md) and [product boundaries](docs/design/product.md). State deliverables, non-goals, affected domains, and expected scope before implementation. Report expansion beyond twice that scope or into a new protocol, migration, or release architecture before proceeding.

## Architecture & Data Flow

Follow the [architecture](docs/design/system-architecture.md) and [trust boundaries](docs/design/security-and-trust.md). Trace changed interfaces end-to-end. Preserve ownership and server-side authorization; migrate affected producers, consumers, and acceptance checks together.

## Key Directories

Use the [ownership guide](docs/development/repository.md) and [domain manifest](docs/domains.json), not guessed layouts. Keep credentials, runtime data, generated output, and temporary upstream checkouts out of source changes. Regenerate artifacts through their owners.

## Development Commands

Use [documented commands](docs/development/testing.md): focused feedback during iteration and one complete final gate. Read [deployment prerequisites](docs/operations/deployment.md) before integration work. A development server proves only the surface actually exercised.

## Code Conventions & Common Patterns

Follow adjacent conventions and established interfaces. Avoid unrelated refactors, duplicate controllers, and production fallbacks for tests. Preserve durable boundaries, typed failures, identity fences, and cleanup. Never blindly replay uncertain side effects.

## Important Files

The [documentation workflow](docs/development/documentation-workflow.md) governs specifications and generated contracts. Update intended behavior first; implementation repairs do not require paperwork. Do not rewrite design merely to excuse an implementation mismatch.

## Runtime/Tooling Preferences

Use repository-declared toolchains, package managers, and lockfiles. Preserve collaborator changes; never use destructive resets. Apply least privilege, obtain required authorization, and establish recovery before irreversible operations. Do not modify research checkouts as product source.

## Testing & QA

Follow [change-specific QA](docs/development/testing.md). Verify behavior, rejection, recovery, and races with isolated data and established external-service fakes; never weaken assertions to get green. Exercise UI changes in the actual browser. Report unavailable capabilities and unexecuted checks honestly.

Deliver a coherent, recoverable change with required specifications and generated consumers synchronized. Remove disposable diagnostics and obsolete paths. Complete the full local gate before a release-triggering push; never push unfinished checkpoints merely for CI feedback.
