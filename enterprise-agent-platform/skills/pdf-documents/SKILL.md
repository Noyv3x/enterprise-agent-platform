---
name: "pdf-documents"
description: "Use when the user wants a PDF created (report, certificate, one-pager, invoice, formatted export), or an existing PDF inspected, merged, split, reordered, rotated, stamped or text-extracted (PDF / 报告 / 合并 / 拆分). Generates PDFs with ReportLab and an embedded Chinese font, renders pages to PNG with pypdfium2 for visual checking, and delivers the file as an artifact. For editable documents use documents (DOCX)."
metadata:
  version: "2.0.0"
  category: "documents"
  tags: ["pdf","reportlab","pypdf","pypdfium2","chinese","render"]
---

# PDF documents

Libraries (preinstalled, offline): `reportlab` 3.6 (create), `pypdf` (inspect/merge/split/rotate/metadata), `pypdfium2` (rasterize pages to check them). Chinese font: WenQuanYi Micro Hei, TrueType, embedded by the kit.
The render-then-look workflow is adapted from OpenAI's Apache-2.0 `pdf` skill (see `references/NOTICE.md`).

Bundled, in place at `/opt/agent-platform/skills/builtin/pdf-documents/`:
- `scripts/pdf_kit.py` — `styles()`, `data_table()` (wrapped CJK cells, repeating header), `build_pdf()` (running header, "n / N" footer, metadata), `register_fonts()`.
- `scripts/example_report.py OUT.pdf` — Chinese business report; copy its shape.
- `scripts/render_pdf.py FILE.pdf OUT_DIR [--scale 1.4] [--pages 1,3]` — PNG per page.
- `scripts/inspect_pdf.py FILE.pdf` — pages, size, text per page, fonts and whether each is embedded (exit 1 if a non-standard font is not embedded).
- `references/recipes.md` — merge/split/rotate/stamp/extract/forms code and the CJK font rules. Read when manipulating existing PDFs or when text looks wrong.

## Workflow
1. **Decide:** new designed document (ReportLab) vs. operating on supplied pages (pypdf: keep every page's appearance; never rebuild what you were asked to merge/split). Editable-document intent → make DOCX instead and optionally a PDF alongside.
2. **Chinese text needs an embedded TrueType font.** ReportLab 3.6 cannot embed OpenType/CFF fonts (Noto CJK `.otf/.ttc` fail with "postscript outlines are not supported"), and its built-in CID fonts (`STSong-Light`) are *not embedded* so viewers without CJK fonts show blanks. Use `pdf_kit.register_fonts()`; it never falls back silently. WenQuanYi Micro Hei has a single weight, so hierarchy comes from size and colour. Paragraph style `wordWrap="CJK"` is already set.
3. **Write in the working directory** (`pwd` of the run: `/workspace/...` or chat `/workspace/<conversation id>/...`); scratch in `.agent-platform/` (render PNGs there, delete when done).
4. **Layout:** A4, margins ≥ 20 mm, body 10.5–11 pt at 1.6 leading, headings by size/colour, tables via `data_table` (numbers right-aligned, header repeats), headings `keepWithNext`, page numbers. Facts and figures exactly as supplied; no invented data or citations.
5. **Check — both, every time:**
   - `python3 …/inspect_pdf.py out.pdf` → page count, text extractable, fonts embedded.
   - `python3 …/render_pdf.py out.pdf .agent-platform/render` then **read the PNGs as images** (the `read` tool shows them): look for tofu/blank glyphs, clipped or overflowing tables, orphan headings, crowded or empty pages, misaligned numbers. Fix and re-render; deliver only after the last render looks right.
6. **Deliver:** standalone `MEDIA: <path>.pdf` line in the final reply (becomes an artifact) or `artifact publish`; same path again = new version. Only the root agent publishes; subagents return paths. (`artifact view` does not render PDFs; the pypdfium2 PNGs are your visual check.)
7. Reply: page count, what was made/changed, assumptions.

## What each check proves
- `inspect_pdf.py` proves the file parses, text extracts and fonts are embedded. Not appearance.
- pypdfium2 PNGs prove how *PDFium* draws these pages (the engine of Chrome and many viewers): glyph coverage, clipping, pagination. Other viewers can differ slightly. Scanned/image PDFs: text extraction returns nothing; there is no OCR here, never claim OCR unless you did it.

## Rules
- Never drop signatures, encryption restrictions or attribution from a supplied PDF without explicit, legitimate instruction; password-protected PDFs need the password from the user; tell the user if signing/form-fill is out of scope.
- Do not run embedded JavaScript/launch actions; do not add external links the user did not supply; never include credentials or unrelated workspace content.
- Merging/splitting: keep page order, report the final page map (e.g. "1–3 from A, 1–2 from B").
