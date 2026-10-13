# Notice

- Origin: https://github.com/anthropics/skills (`skills/skill-creator`)
- Upstream revision: `dbd4588f9e1033efb41dad4bef2f7947c8993d44` (main, committed 2026-10-09; cloned 2026-10-13)
- License: Apache-2.0 (`skills/skill-creator/LICENSE.txt` upstream, kept verbatim as `LICENSE`). Other directories in that repository have other licenses; nothing from the proprietary docx/pdf/pptx/xlsx skills is included.

## Changes made for this platform
- Capture-intent, writing-guide, progressive-disclosure, test-then-iterate and description-tuning guidance condensed from upstream `SKILL.md`.
- Rewritten around the platform `skill` tool (install/update/remove/info; permission, next-message and root-run-only rules); removed `claude -p` driven eval/benchmark scripts, the eval viewer, grader/comparator agents, packaging and Claude.ai/Cowork sections (no Claude CLI, no local browser display here). Testing uses `task` subagents in the personal AI, and manual user trials in channels.
- `scripts/validate_skill.py` is derived from upstream `quick_validate.py` and re-based on the Platform parser's install rules (name, description length, frontmatter YAML, size/file limits, symlinks) plus authoring-hygiene warnings.
- `references/skill-anatomy.md` is new.
