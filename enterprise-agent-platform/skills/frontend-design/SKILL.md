---
name: frontend-design
description: 'Design and build distinctive, production-quality web pages and HTML interfaces (网页 / 落地页 / 官网 / 数据看板 / H5 / HTML 报告 / 小工具界面), or restyle an existing one, with deliberate typography, palette and layout instead of templated defaults. Use when the user wants a page or UI to look good and be viewable right away in the artifact panel. Not for slide decks (frontend-slides), PPTX (presentations) or architecture diagrams (architecture-diagram).'
metadata:
  version: 1.0.0
  upstream: anthropics/skills frontend-design (Apache-2.0), adapted
---

# Frontend design

Act as the design lead at a studio known for giving every client a distinct identity. Make deliberate, opinionated choices about palette, type and layout that belong to this brief. The brief's own words always win, even when it asks for a "default-looking" style.

## Delivery (platform rules)
- Work in the run's working directory: a single `<name>.html` (inline CSS/JS) or a small folder `<name>/index.html` + assets. Publish via a standalone MEDIA line or `artifact publish` (folder → site); revise the same path for a new version. Only the root agent publishes; subagents return paths.
- Artifacts run with no external network: **no web fonts, CDN scripts, remote images or icon fonts.** Use local font stacks (below), inline SVG, CSS shapes, base64 for small images. Charts: hand-written SVG/CSS or a small inline script; no CDN.
- **Self-check is mandatory:** `artifact view` the page at desktop width and at phone width, and again after fixes. Read console messages. Say only what you actually viewed.
- Static visual-only work does not need a dev server; for a running app use the personal-AI `artifact preview` flow, not this skill.

## Start from the subject
Identify the real subject, audience and the page's primary job (if missing, propose one concrete option and proceed). Industry, materials and vernacular are where distinctive choices come from: a children's brand and a finance analyst dashboard must look nothing alike. Use the brief's real content throughout; write plausible copy only where none is given and tell the user it is placeholder (never invent figures, customers or quotes presented as fact).

## Plan, then critique, then build
1. **Plan compactly:** colour (4-6 named hex values), type (families and roles), layout concept (one-sentence prose + ASCII wireframe; alignment), principles (what makes this page unique).
2. **Review the plan against the brief.** If a part is what you would produce for any similar page, revise it and say what changed.
3. **Build.** Mind CSS specificity (a `.section` class and an element selector cancelling each other's margins is common).
4. **Critique with screenshots** and remove one decoration before delivering. Spend boldness in one place; keep everything else quiet.

## Principles
- Open with the most characteristic thing in the subject's world (headline, image, demo, interactive moment); a big number + small label + gradient accent is the default, so use it only when it is truly best.
- Typography carries personality: one family or two clearly distinct. Set a real type scale; line length < 80 Latin characters (Chinese: ~28-40 characters per line).
- Structure encodes information: borders, numbering, eyebrows and dividers only when they mean something (number markers only for real sequences).
- Motion: one orchestrated moment beats scattered fade-ups and hover effects on every card; motion that answers a user action is welcome. Respect `prefers-reduced-motion`.
- Quality floor: responsive to phone width, visible keyboard focus, touch targets ≥ 44px, text contrast ≥ 4.5:1, harmonious palette.
- Copy is design: plain verbs, active voice, specific button labels ("保存修改", not "提交"), errors say what happened and how to fix it, empty states invite an action.

## Avoid the generic tells
Warm-cream background + high-contrast serif + terracotta accent; near-black + one acid accent; broadsheet hairline-rule columns; identical rounded cards with the same soft shadow and gradient washes; tracked-out ALL-CAPS eyebrow above each heading; middle-dot meta strings; "WORD — fragment" labels; `→` on every link; monospace for every small label. They are legitimate when chosen, not when defaulted.

## Chinese and bilingual pages
See `references/chinese-typography.md` for font stacks, sizes, line-height, punctuation and layout rules. In short: system CJK stacks only, body 16-18px (≥ 28px on slides), line-height 1.6-1.8, never letter-space Chinese, `lang="zh-CN"`, avoid ALL-CAPS tricks (they do not exist in Chinese; mixed Latin/CJK needs spacing care).

## References
- `references/chinese-typography.md` – CJK stacks, scales, punctuation, mixed-script rules
- `references/page-patterns.md` – business page patterns (落地页, 数据看板, 报告页, 表单页) and a self-check list
