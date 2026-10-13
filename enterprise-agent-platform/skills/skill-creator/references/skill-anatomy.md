# Skill anatomy

```
my-skill/
├── SKILL.md            required: frontmatter + instructions (< 500 lines)
├── references/         docs loaded on demand (long guides, schemas, examples)
├── scripts/            deterministic helpers, run in place
├── assets/             templates, fonts, icons used in outputs
└── NOTICE.md/LICENSE   when material is third-party
```

## Frontmatter (Platform-recognised keys)
`name`, `description` (required); `license`, `compatibility` (≤500 chars), `metadata` (`version`, free keys), `allowed-tools`, `disable-model-invocation: true` (hide from the model catalog; user can still invoke with `/name`), legacy top-level `version`, `category`, `tags`.

## Minimal template
```markdown
---
name: weekly-report
description: 'Draft the weekly 周报 from the user's notes or task list in the company template. Use when the user asks for 周报, weekly status, or 本周进展 summaries.'
metadata:
  version: 1.0.0
---

# Weekly report

1. Read the user's notes (or the files they name).
2. Group into 本周完成 / 风险与阻塞 / 下周计划; quantify results only with numbers from the sources.
3. Write `<cwd>/weekly-report-<YYYY-MM-DD>.md`; publish it as an artifact with a standalone MEDIA line.
```

## Saving a just-finished workflow without files
```json
{"action":"install","content":{"name":"weekly-report","description":"…when to use…","body":"# Weekly report\n1. …","files":{"references/template.md":"…"}}}
```

## Progressive disclosure patterns
- Variants by domain: `references/aws.md`, `references/gcp.md`; SKILL.md chooses.
- Reference files over 300 lines start with a table of contents.
- Deterministic or repeated code goes in `scripts/`; SKILL.md says how to run it and what it outputs.

## Description examples
Weak: "Helps with reports."
Better: "Draft and revise monthly business reports (月报/经营分析) from spreadsheets or notes, with a conclusion-first structure. Use whenever the user mentions 月报, 经营分析, 汇报材料, or attaches KPI sheets, even if they do not say 'report'. Not for slides (presentations) or contracts."
