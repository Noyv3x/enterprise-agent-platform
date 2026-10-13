---
name: "codebase-inspection"
description: "Use when the user asks how big a repository or folder is: file counts, languages, lines of code, comment/documentation ratio, which directories hold the most code, or a size comparison between two scopes. Runs a bundled read-only counter (works offline in chat and personal sandboxes) and explains what the numbers do and do not mean. Not for architecture review, code quality, security or productivity assessment. 代码量统计、语言构成、仓库规模。"
license: MIT
metadata:
  version: "2.0.0"
  category: "software-development"
  tags: "codebase,metrics,lines-of-code,languages,repository"
---

# Repository metrics

Scope: **size and composition only** (files, languages, code / comment /
blank lines, documentation volume, distribution across top-level folders).
Counts are descriptive. They say nothing about quality, productivity,
complexity, test coverage, security or architecture; if the user wants those,
say this skill does not measure them and use a different workflow
(`read`, `grep`, running the project's own tools).

## Rules

- **Read-only.** Never install packages, create or modify a `.venv`, run
  `npm install`, build, or write any file into the project being measured. The
  counter below needs only the Python 3 standard library and no network, so it
  works in the chat sandbox and the personal sandbox alike.
- Output goes to the reply. If the user wants a saved report, write it under the
  run's working directory (not inside the inspected project unless asked) and
  deliver it per the platform rules.
- Confirm or choose the scope: the directory to measure. For a monorepo,
  measure the top-level components separately with `--by-dir`.

## Run it

The script is read in place from the built-in skill folder:

```text
bash({"command":"python3 /opt/agent-platform/skills/builtin/codebase-inspection/scripts/repo_metrics.py <dir> --by-dir","timeout":180})
```

| Option | Effect |
|---|---|
| `--by-dir` | also break code lines down by top-level directory |
| `--json` | machine-readable output |
| `--exclude a,b` | skip more directory names |
| `--no-default-excludes` | include vendored/build folders (say so in the report) |
| `--no-git` | walk the directory instead of asking git |

File discovery uses `git ls-files` (tracked plus untracked-but-not-ignored) when
the folder is a Git checkout, so `.gitignore` is honored; otherwise it walks the
directory. The same exclusion list is applied every time, so two runs are
comparable: `.git node_modules venv .venv __pycache__ .cache dist build out
target .next .tox .mypy_cache .pytest_cache .ruff_cache coverage vendor
third_party` and similar (printed in the output).

To compare two revisions, run the same script with the same options on both
(for example a second checkout or `git worktree` created in a scratch
directory, never by switching the user's branch).

## What the script counts

- Languages by extension or file name; unknown extensions are listed as
  "unknown text".
- **Code**, **comment**, **blank** via simple per-language comment markers.
  Python docstrings and strings inside code count as code; a code line with a
  trailing comment counts as code. This is a heuristic, not a parser.
- Markdown, reStructuredText and text files count as **documentation**
  (non-blank lines), not code. JSON, YAML, TOML and XML are kind `data`; the
  "Code %" column is a share of code+data lines.
- Not counted: binary files, files over 2 MiB, generated or minified files and
  lockfiles, symlinks, unreadable files (each count is reported).

## Report

State: inspected path, discovery method, exclusions, the table (files and
lines per language), notable ratios (for example comment-to-code), what was not
counted, and the limits above. Mention the script path and that no tool
version applies (bundled, standard library). Do not rank people or teams by
line counts or say more lines means more functionality. A very large tree is
fine: the script is single pass, but measure components separately if the output
would be too long to read.

## Optional: pygount (personal AI only, when asked)

If the user specifically wants `pygount`'s classifier and the sandbox has
network, run it **isolated, pinned and outside the project**, for example
`uvx --from pygount==<version> pygount ...`, after checking the version exists;
never `pip install` into the project or its `.venv`. In chat sandboxes it is not
available; use the bundled script. Report which tool produced the numbers, since
the two classifiers differ.

Attribution and licence: `references/NOTICE.md`.
