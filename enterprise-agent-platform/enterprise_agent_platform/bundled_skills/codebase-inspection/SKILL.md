---
name: "codebase-inspection"
description: "Use when the user asks about repository size, languages, file counts, or code/comment ratios. Runs pygount from a workspace-local .venv with dependency and build folders excluded, then explains the metrics and their limits."
version: "1.0.0"
category: "software-development"
tags: ["codebase","metrics","lines-of-code","languages","pygount","repository"]
---

# Codebase Inspection

Use `pygount` to measure file counts, language composition, code, comments,
documentation, and blank lines. Counts are descriptive signals, not measures
of productivity or quality.

## Scope first

Confirm the workspace-relative directory to inspect. Exclude vendored
dependencies, generated output, virtual environments, caches, and version
control data unless the user explicitly wants them included.

Recommended exclusions:

```text
.git,node_modules,venv,.venv,__pycache__,.cache,dist,build,.next,.tox,.eggs,.mypy_cache,.pytest_cache,.ruff_cache,coverage,vendor,third_party
```

## Workspace-local installation

Never install into the host Python. Reuse an existing workspace `.venv` when
it is healthy; otherwise create it:

```text
terminal({
  "command":"test -x .venv/bin/python || python3 -m venv .venv; .venv/bin/python -m pip install pygount",
  "timeout_ms":180000
})
```

This changes only the workspace environment. If dependency installation is
out of scope or network access is unavailable, report the blocker and offer a
clearly labeled, less precise fallback instead of altering the host.

## Standard summary

Run from the Agent workspace or set the tool's `cwd` to the requested
workspace-relative subdirectory:

```text
terminal({
  "command":".venv/bin/pygount --format=summary --folders-to-skip='.git,node_modules,venv,.venv,__pycache__,.cache,dist,build,.next,.tox,.eggs,.mypy_cache,.pytest_cache,.ruff_cache,coverage,vendor,third_party' .",
  "timeout_ms":180000
})
```

When `cwd` is a subdirectory, adjust the executable path relative to that
directory or invoke it from the workspace root with the target directory as
the final argument.

For machine-readable results:

```text
terminal({
  "command":".venv/bin/pygount --format=json --folders-to-skip='.git,node_modules,venv,.venv,__pycache__,.cache,dist,build,.next,.tox,vendor,third_party' .",
  "timeout_ms":180000
})
```

For selected suffixes:

```text
terminal({
  "command":".venv/bin/pygount --suffix=py,js,jsx,ts,tsx --format=summary --folders-to-skip='.git,node_modules,venv,.venv,dist,build,.next' .",
  "timeout_ms":180000
})
```

## Interpretation

Report:

- inspected path and exclusion list;
- tool/version and command;
- total files and code lines;
- language breakdown with percentages;
- notable comment-to-code ratios;
- generated, binary, unknown, or empty-file categories;
- limitations that could materially affect the result.

Important caveats:

- Markdown is commonly classified as documentation/comments rather than code.
- Minified, generated, vendored, JSON, template, and notebook files can skew
  counts.
- Logical statements and physical lines are different measurements.
- A larger count does not imply more functionality or better engineering.
- Compare revisions only when the same tool version, scope, and exclusions
  were used.

For a very large monorepo, measure top-level components separately or filter
suffixes rather than allowing an unbounded scan.

License and source attribution are in `references/NOTICE.md`.
