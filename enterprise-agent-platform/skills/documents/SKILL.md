---
name: "documents"
description: "Use when the user asks to write, revise, reformat or deliver a Word document: proposal, report, contract, memo, letter, policy, meeting minutes, resume (DOCX / 文档 / 方案 / 报告 / 合同 / 通知). Builds or edits a real .docx with styles, tables, headers/footers and correct Chinese typography, then delivers it as an artifact. Not for PDF output (use pdf-documents) or spreadsheets/decks."
metadata:
  version: "2.0.0"
  category: "documents"
  tags: ["docx","word","report","proposal","contract","chinese","python-docx"]
---

# Word documents (DOCX)

Default deliverable for an editable document is `.docx`, never Markdown. Libraries: `python-docx`, `lxml` (preinstalled; no network needed, works in chat).

Bundled, read in place (read-only), `/opt/agent-platform/skills/builtin/documents/`:
- `scripts/docx_kit.py` — `new_document()` (A4, styles, eastAsia fonts, real bullets), `add_table()` (shaded header that repeats, no split rows, right-aligned numbers), `add_page_number_footer()`, `add_header_text()`, `add_toc()`, `indent_body()`.
- `scripts/example_proposal.py OUT.docx` — a Chinese proposal using all of them; copy its shape.
- `scripts/inspect_docx.py FILE.docx` — headings, tables wider than the page, CJK runs lacking an eastAsia font.
- `references/cjk-typography.md` (fonts, 字号, indentation, punctuation, 公文/合同 conventions) and `references/editing-existing.md` (preserve-first rules) — read before formal documents or edits.

## Workflow
1. **Clarify the document, not the tool.** Audience, purpose, decision wanted, length, language, brand/template supplied? Use a supplied template/file as the base (`Document(path)`); otherwise `new_document()`. Contracts and formal letters: serif east font (`EAST_SERIF`), 小四 12 pt; business proposals/reports: sans.
2. **Structure first.** Title block → (summary / conclusion first for reports) → numbered headings (Heading 1–3 styles only, never bold Normal text) → tables/lists → appendix. TOC only for long documents (≥ ~8 pages) and tell the user to update fields (WPS: 更新域); never type fake page numbers.
3. **Write in the working directory** (the cwd of this run: `/workspace/...` for personal AI, `/workspace/<conversation id>/...` for chat — never a hard-coded folder). Descriptive filename, e.g. `智能客服方案建议书-V1.docx`; scratch files under `.agent-platform/`.
4. **Build with styles, not manual formatting.** Real list styles, real tables (`add_table`), page-number *fields*, header/footer per section, `keep_with_next` on headings, images with captions and preserved aspect ratio (`doc.add_picture(path, width=Cm(14))`). Put every figure the user gave verbatim; mark unknowns as `【待补充：…】` and list them in the reply — never invent data, names, clause numbers or citations.
5. **Check.** `python3 …/inspect_docx.py out.docx`, fix what it flags. Then deliver (below) and look at the rendering with `artifact view`.
6. **Deliver.** Final reply contains a standalone line `MEDIA: <path>/<file>.docx` (the platform turns it into a downloadable, previewable artifact) — or call `artifact publish` on the file. Revising the same path creates a new version, so iterate on one filename instead of `_v2`, `_final`. Only the root agent publishes/views artifacts; subagents return the path.

## What each check proves
- `inspect_docx.py` proves structure: styles used, table widths, eastAsia font present. It does **not** prove the layout.
- `artifact view` on the DOCX artifact renders it with the platform's browser viewer (docx-preview): good for overflow, table fit, obvious page-break problems, missing/tofu glyphs. It is **not** Microsoft Word: pagination, fields (TOC/page counts), tracked changes and some fonts differ. Say "checked in the platform viewer", not "checked in Word".
- If `artifact view` is unavailable, say no visual check was done.

## Rules
- Chinese text: always set the **eastAsia** font (the kit does for every style); body 小四(12pt)/五号(10.5pt), line spacing 1.5 or fixed 22–28 pt, 2-character first-line indent for body paragraphs only, full-width punctuation, thin gaps between Chinese and digits/Latin only if the house style asks. Fonts are names resolved on the reader's machine (微软雅黑/宋体/仿宋); the sandbox does not have them, so previews use fallbacks.
- Editing a supplied file: never overwrite the original; save as a new name, change only what was asked, keep run formatting, comments, tracked changes, fields, numbering, headers/footers, sections. `.doc` (legacy) cannot be edited here: ask for `.docx` or rebuild and say so. See `references/editing-existing.md`.
- Tables must fit the text width (A4 default text width 14.7 cm in `new_document`); repeat header rows; no merged-cell layout tricks.
- No macros, remote templates, external links the user did not supply, hidden text, or credentials.
- Legal/contract content: draft from the user's terms only; flag that it needs review by counsel; do not fabricate clauses, laws or case citations.
