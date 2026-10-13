---
name: "presentations"
description: "Use when the user asks for slides, a deck, PPT/PPTX, a pitch, training or report presentation (演示文稿 / 幻灯片 / 汇报). Builds or edits a real editable .pptx with python-pptx: 16:9 grid, title placeholders, native charts and tables, Chinese fonts, speaker notes, then delivers it as an artifact. For an HTML slide show use the HTML presentation skill if one is available."
metadata:
  version: "2.0.0"
  category: "documents"
  tags: ["pptx","slides","presentation","deck","python-pptx","chinese"]
---

# Presentations (PPTX)

Library: `python-pptx` **1.0.2** (preinstalled, offline; the sandbox moved from 0.6.21 because 1.0.x is the maintained, typed line — API used here is the same on both). Never `pip install` in chat (no network).

Bundled, in place at `/opt/agent-platform/skills/builtin/presentations/`:
- `scripts/pptx_kit.py` — `new_deck()` (13.333×7.5 in), `add_slide(prs, title, notes)` (real title placeholder), `add_text`, `add_card` (KPI), `add_chart` (native, editable), `add_table`, `add_picture_fit`, `add_footer`, CJK-aware `set_font` (sets latin + `a:ea`).
- `scripts/example_deck.py OUT.pptx` — 5-slide Chinese review deck; copy its shape.
- `scripts/audit_pptx.py FILE.pptx` — missing titles, shapes outside slide, text < 12 pt, distorted pictures, probable overflow/overlap, notes. Exit 1 on hard problems.
- `references/slide-design.md` — story structure, layout recipes, sizes. Read before designing.

## Workflow
1. **Story first.** Audience, decision/ask, time (≈ 1–2 min per slide), tone. Write the slide *titles* as full-sentence claims ("订阅收入逐季提升，硬件连续两季下滑"); the sequence of titles must read as the argument. Get/confirm facts and numbers from the user's sources; never invent figures. Sources go into notes or a small footer.
2. **Base:** supplied template/deck → `Presentation(path)` and use its layouts/theme (copy the file, edit the copy). Otherwise `new_deck()`; one palette (`ACCENT` + neutrals, charts may use `PALETTE`), one font pair (Latin + 微软雅黑 east), ≥ 12 pt everywhere, body 18–24 pt, titles 28–32 pt, ≤ 6 lines of body per slide, 0.7 in margins.
3. **One message per slide**, layouts varied by content: KPI cards, chart + takeaway, table, two-column compare, process, quote. Charts/tables as native objects (editable), not pictures of them; images keep aspect ratio (`add_picture_fit`). No walls of text: move detail to speaker notes.
4. **Write to the working directory** (`pwd` of the run: `/workspace/...` or chat `/workspace/<conversation id>/...`), e.g. `Q3经营复盘.pptx`; scratch under `.agent-platform/`.
5. **Audit:** `python3 …/audit_pptx.py out.pptx`; fix every `!` and judge every `?`.
6. **Deliver:** standalone `MEDIA: <path>.pptx` line in the final reply (becomes a downloadable, previewable artifact) or `artifact publish`; rebuild to the same path for new versions. Then **`artifact view`** the artifact and read the screenshots: look for clipped/overflowing text, overlaps, unreadable charts, tofu glyphs. Only the root agent publishes/views; subagents return paths.
7. Reply: slide count, storyline in one line, assumptions, and what was/wasn't checked.

## What each check proves
- `audit_pptx.py`: geometry and font-size facts from the file. Overflow detection is an estimate.
- `artifact view`: how the platform viewer (pptx-renderer) draws the slides — real evidence for layout, but **not PowerPoint/WPS**: fonts (微软雅黑 is substituted), chart styling, gradients, SmartArt, animations and transitions differ. Report it as "checked in the platform viewer".
- Neither tests animations (python-pptx cannot create them) or macros.

## Rules
- Editing an existing deck: keep masters, layouts, fonts, theme; modify text by runs (`paragraph.runs[0].text = …`) to keep formatting; add slides from the deck's own layouts; python-pptx cannot delete slides cleanly or create animations/transitions/SmartArt — say so rather than faking. Don't change slide size of a supplied deck.
- Images: only ones the user supplied or you generated; never remote URLs; embed PNG/JPEG, keep ≤ 2 MB each.
- No macros, external links the user didn't supply, tracking, or credentials. Every slide has a title (accessibility, outline).
- Chinese: avoid orphan punctuation at line start (shorten text instead), fullwidth punctuation, keep numbers with units on one line.
