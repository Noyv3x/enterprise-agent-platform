---
name: skill-creator
description: 'Create, improve, test, install or remove Agent Skills on this platform (创建 / 优化 / 安装 / 更新 / 删除技能, 把刚完成的流程沉淀成技能). Use when the user says "make this a skill", wants a reusable workflow saved, wants an existing skill reviewed or its trigger description tuned, or wants to install a skill from a GitHub / zip URL or a workspace folder. Uses the platform `skill` tool, not any CLI.'
metadata:
  version: 1.0.0
  upstream: anthropics/skills skill-creator (Apache-2.0), adapted
---

# Skill creator

A skill is a folder with `SKILL.md` (frontmatter `name` + `description`, then instructions) plus optional `references/`, `scripts/`, `assets/`. Descriptions are always in context; the body loads when triggered; other files load on demand.

## Platform facts
- Manage skills only through the **`skill` tool**: `list`, `info {name}`, `install` with exactly one source (`{url}` GitHub repo/tree/blob, `.zip`, `.tar.gz`, `.skill`, raw SKILL.md; `{path}` workspace folder/zip/`.skill`; or `{content:{name,description,body,files?}}`), optional `{subpath}` and `{replace:true}`, `update {name}` (URL-installed only), `remove {name}`. Never write into `.claude/skills`, `.codex`, `.agents/skills` or any other product's folder.
- The tool exists only in the personal AI and channel root runs. In chat or in a subagent: write the draft folder under the working directory and tell the user to install it from the personal AI.
- Installing/updating/removing needs the user's install permission; a refusal is final, report it. Installed skills are usable from the **next message**. Personal/channel skills override organization skills, which override built-ins of the same name; do not shadow a built-in unless asked.
- Built-in skills (`/opt/agent-platform/skills/builtin/`) are read-only: copy to the workspace to modify, install under a new name.

## Workflow
1. **Capture intent** (use the conversation first: tools used, steps, corrections, formats): what it enables, when it should trigger (real user phrases, Chinese and English), expected output, edge cases, dependencies. Ask only what is missing.
2. **Check overlap:** `skill list`; if an existing skill already covers it, improve that one (copy, edit, install with `replace`) instead of adding a competitor.
3. **Draft in the workspace:** `<cwd>/<skill-name>/SKILL.md` (+ resources). Writing rules below.
4. **Validate:** `python /opt/agent-platform/skills/builtin/skill-creator/scripts/validate_skill.py <cwd>/<skill-name>` (the Platform's install rules plus hygiene). Fix errors and warnings.
5. **Test with 2-3 realistic prompts** (what a real user would type). In the personal AI (the only scope with the `task` tool), spawn a `task` subagent per prompt with the draft path ("read <path>/SKILL.md and follow it for: <prompt>; save outputs under <dir>; return paths") and, for comparison, one without the skill; read outputs and transcripts yourself. In a channel (no `task`): install the draft first, then ask the user to try the prompts in a fresh message and report what happens; you can still dry-run a prompt yourself by following the draft step by step. Skip formal benchmarks unless the user wants them. Subjective skills need the user's eyes, not assertions: show the outputs.
6. **Iterate** on failures; generalize rather than patching for the sample prompts; remove instructions that do not change behaviour.
7. **Install:** `skill install {path: "<cwd>/<skill-name>"}` (add `replace:true` when updating). Report the name and tell the user it works from the next message. Offer `info {name}` to confirm.
8. **Tune the description** (optional): write ~10 should-trigger and ~10 near-miss should-not-trigger prompts, judge by reading the description against each, adjust, re-install. Near-misses matter more than obvious cases.

## Writing rules
- `name`: lowercase letters, digits, hyphens, ≤64, matches the folder. `description`: ≤1024 characters; say what it does AND when to use it (trigger phrases, file types, situations); be slightly pushy, models under-trigger; mention the nearest sibling skills it must not steal from. Quote the YAML value if it contains `: `.
- `metadata.version` for every release (bump on change).
- Body: imperative, explain *why*, keep < 500 lines; push detail into `references/` with a note on when to read each; scripts for deterministic steps (do not make the model retype them).
- Paths: outputs under the run's working directory (never a hard-coded `/workspace/deliverables`); bundled files are read in place from `/opt/agent-platform/skills/<tier>/<name>/` (built-ins) — installed personal skills live at `/workspace/.agent-platform/skills/<name>/`. Reference bundled files relative to the skill folder.
- No network assumptions in chat; use the platform web tools or mark steps personal-AI-only.
- Viewable deliverables: publish as artifacts (standalone MEDIA line or `artifact publish`), only from the root agent; self-check with `artifact view`.
- Chinese-speaking users: include Chinese trigger phrases and examples where natural.
- Third-party material: keep its LICENSE/NOTICE with origin, revision, license, changes. Do not copy proprietary or unlicensed skills.
- Safety: no malware, exfiltration or surprising behaviour; a skill should do what its description says.

## Installing from outside
`skill install {url}`: for a multi-skill repo give `{subpath}`; the tool lists candidates when ambiguous. Before installing someone else's skill, `read` its SKILL.md and scripts (what it runs, what it fetches, what it writes) and tell the user the findings; check its license.

## References
- `references/skill-anatomy.md` – layout, frontmatter fields, a minimal template, a content-install example
- `scripts/validate_skill.py` – pre-install validator
