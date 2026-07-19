---
name: "plan"
description: "Use only when the user requests a plan-only deliverable or says not to implement yet; never when that request authorizes implementation. Investigates the workspace and writes actionable tasks, risks, and checks under .ubitech/plans/."
version: "2.0.0"
category: "software-development"
tags: ["planning","implementation-plan","design","migration","verification"]
---

# Plan Mode

Use this Skill only when the requested deliverable is the plan itself. It is
not applicable when the same request already asks for or authorizes
implementation; in that case, plan as part of execution and continue the
authorized work.

When the request is plan-only, produce a decision-ready implementation plan,
not an implementation. Investigation may read files, search the workspace,
inspect Git history, or run non-mutating diagnostics. Do not edit product
files, install dependencies, start services, commit, or push while using this
mode.

The only intended write is the requested plan document.

## Output location

Save the plan inside the active Agent workspace:

```text
.ubitech/plans/YYYY-MM-DD_HHMMSS-short-slug.md
```

Use a workspace-relative path. If the user provides a filename, normalize it
under `.ubitech/plans/` unless they explicitly request another workspace
location.

## Investigation

Before writing:

1. Restate the goal, constraints, and definition of success.
2. Inspect repository guidance and the relevant implementation.
3. Locate tests, configuration, migrations, generated artifacts, and runtime
   boundaries affected by the change.
4. Identify existing patterns worth following.
5. Ask only questions whose answers materially change the plan. Otherwise,
   state a conservative assumption.

Useful calls:

```text
search_files({"query":"relevant symbol or route","path":"."})
read_file({"path":"path/to/relevant/file"})
terminal({"command":"git diff --stat && git status --short"})
```

For a large repository, a bounded read-only investigation may be delegated:

```text
delegate_task({
  "prompt":"Inspect the repository for the components, tests, and configuration affected by this proposed change. Return file paths, current behavior, and risks. Do not edit files.",
  "system_prompt":"Act as a read-only implementation-planning investigator. Ground every claim in repository evidence."
})
```

Review delegated findings yourself before including them.

## Required plan structure

```markdown
# <Plan title>

## Goal
One concise outcome statement.

## Current state
Relevant behavior and evidence, with exact paths.

## Scope
- In scope
- Out of scope

## Assumptions and decisions
- Assumptions that influenced the design
- Selected approach and rejected alternatives

## Implementation tasks
### 1. <Task>
- Files: `exact/path`
- Change: precise behavior and interfaces
- Verification: exact focused checks
- Dependencies: preceding task, if any

## Data, rollout, and compatibility
Migration, rollback, feature flags, deployment order, or "not applicable".

## Risks
Known failure modes and mitigations.

## Final verification
Commands, manual checks, and acceptance criteria.
```

## Task quality

Each task should be independently understandable and ordered by dependency.
Name exact files when known. Describe interfaces, state transitions, error
paths, and test cases—not vague instructions such as "update backend" or
"improve UI."

Include code snippets only when they resolve ambiguity; do not duplicate whole
files. Mark uncertain paths or APIs as items to confirm during implementation.

## Handoff

After writing the plan:

- give the user the plan path and a compact summary;
- call out unresolved decisions and risky steps;
- wait for explicit authorization before implementation;
- do not stage, commit, or push the plan unless separately requested.

License and source attribution are in `references/NOTICE.md`.
