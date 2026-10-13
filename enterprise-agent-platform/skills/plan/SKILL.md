---
name: "plan"
description: "Use ONLY when the user asks for a plan as the deliverable or says not to implement/execute yet (\"先出方案\", \"只做计划\", \"plan only\"). Never when the same request authorizes doing the work. Investigates read-only and writes an actionable plan: a software implementation plan or a business/project plan (goals, milestones, owners, budget, risks). 只出方案不执行。"
license: MIT
metadata:
  version: "3.0.0"
  category: "planning"
  tags: "planning,implementation-plan,project-plan,business-plan,design,migration,verification"
---

# Plan mode

Use this skill only when the plan itself is the deliverable. If the request
also asks for or authorizes the work ("plan it and do it", "帮我做一下"), plan
as part of execution and continue; do not stop at a plan.

While planning you may read files, search, inspect Git history, browse with
the web tools and run non-mutating diagnostics. Do not edit product files,
install dependencies, start services, send messages, commit or push. The only
intended write is the plan document.

## Output location and revisions

Write the plan under the run's working directory, workspace-relative:

```text
.agent-platform/plans/YYYY-MM-DD_HHMMSS-short-slug.md
```

If the user names a file, normalize it under `.agent-platform/plans/` unless
they ask for another location. Publish it (`artifact publish` with the absolute
sandbox path, or a standalone MEDIA line) so the user reads it in the artifact
panel. **Revisions overwrite and republish the same path**; that creates a new
version. Never save `-v2`/`-final` copies. Only the root agent publishes;
a subagent returns the path. Say in the reply what changed in each revision.

## Investigate first

1. Restate goal, constraints and what success looks like.
2. Read the repository guidance and the relevant implementation (software), or
   the supplied documents, figures and prior decisions (business). Use web
   tools for current external facts and cite them with links.
3. Locate what the change touches: tests, config, migrations, generated
   artifacts, interfaces, runtime boundaries; or stakeholders, dependencies,
   budget lines, deadlines, approvals.
4. Note existing patterns to follow.
5. Ask only questions whose answers materially change the plan; otherwise state
   a conservative assumption and mark it. Verify each finding against the
   source before it enters the plan; label anything unverified as such.

For a large repository investigate one affected component at a time and record
paths, current behavior and risks.

## Software plan

Use this structure (drop empty sections; skip "rollout" if not applicable):

```markdown
# <Title>
## Goal
## Current state        (behavior + exact paths as evidence)
## Scope                (in / out)
## Assumptions and decisions   (chosen approach, rejected alternatives and why)
## Tasks
### 1. <Task>
- Files: `exact/path`
- Change: behavior, exact interfaces (names, signatures, payload fields), state transitions, error paths
- Verification: the failing test to write first and the exact command
- Depends on: <task>
## Data, rollout, compatibility   (migration, rollback, order of deployment, flags)
## Risks
## Final verification    (commands, manual checks, acceptance criteria)
```

Task quality: each task is understandable alone, ordered by dependency, names
exact files when known, and specifies interfaces and test cases, not "update the
backend". Use code snippets only to remove ambiguity. A task must not say "add
validation", "handle errors" or "write tests for the above" without saying
which; mark uncertain paths or APIs as "confirm during implementation".

## Business or project plan

For proposals, launches, campaigns, migrations, hiring, budgets, events and
operations work, use `references/business-plan.md`. It covers objective and
success measures, scope, workstreams with owners and dates, resources and
budget with stated assumptions, dependencies, risks, decision points and a
review cadence. Never invent figures, dates, headcount or approvals: use the
user's numbers, mark estimates as estimates with their basis, and list data you
still need.

## Self-review before handing over

- Every requirement in the request maps to a task or a stated exclusion.
- No placeholders ("TBD", "etc.", "handle appropriately") and no task that
  depends on an undefined name or number.
- Names, paths and interfaces are consistent across tasks.
- Each task has a check that can actually fail.
- Assumptions, unverified claims and open decisions are listed explicitly.

## Handoff

Give the user the plan path and a compact summary, the unresolved decisions and
the risky steps, then **wait for explicit authorization**. Do not stage, commit
or push the plan unless separately asked. Do not pretend a plan has been
executed or reviewed by anyone else.

Attribution and licence: `references/NOTICE.md`.
