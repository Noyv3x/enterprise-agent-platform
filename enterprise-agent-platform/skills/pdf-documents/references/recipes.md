# PDF recipes

```python
import sys; sys.path.insert(0, "/opt/agent-platform/skills/builtin/pdf-documents/scripts")
from pdf_kit import *            # styles(), data_table(), build_pdf(), A4, mm, Paragraph, Spacer, PageBreak, KeepTogether
```

## Create
```python
st = styles()                                  # registers the CJK font
story = [Paragraph("标题", st["title"]), Paragraph("正文……", st["body"]),
         data_table([["项目","金额"],["A","1,200"]], [100*mm, 50*mm], st, number_cols=(1,))]
build_pdf("/workspace/报告.pdf", story, title="报告", author="经营分析组", header="2026 Q3 报告")
```
Images: `Image(path, width=120*mm, height=120*mm*h/w)` (keep ratio; PNG/JPEG). Charts: draw with PIL or reportlab.graphics, embed as vector (`reportlab.graphics.charts`) where possible; labels need the CJK font (`fontName="CJK"`).
Landscape: `pagesize=landscape(A4)`; cover page: first `PageTemplate` without header; long tables split across pages automatically (`repeatRows=1`). Use `Paragraph` in cells (string cells do not wrap, and Chinese overflows the column).

## Font rules
- ReportLab 3.6 embeds **TrueType-outline** fonts only: `TTFont("CJK", "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc", subfontIndex=0)`. A user font: `PDF_CJK_FONT=/path/font.ttf`.
- Noto/Source Han `.otf`/`.ttc` (CFF outlines) → error; `STSong-Light`/`HeiseiMin-W3` CID fonts → not embedded, blank in many viewers. Do not use either.
- Glyph coverage: Micro Hei covers GB2312 + common Traditional; rare characters may show as boxes — the render check catches this.
- Latin text uses the same font by default (consistent metrics). Helvetica is only used for ReportLab internals.

## pypdf operations
```python
from pypdf import PdfReader, PdfWriter
r = PdfReader("a.pdf")
if r.is_encrypted: r.decrypt(password_from_user)
w = PdfWriter()
for p in r.pages[2:5]: w.add_page(p)           # split / extract pages 3-5
for p in PdfReader("b.pdf").pages: w.add_page(p)   # merge
w.pages[0].rotate(90)                          # rotate
w.add_metadata({"/Title": "合订本"}); w.write("out.pdf")
```
- Outline/bookmarks: `w.add_outline_item("第一部分", page_number=0)`.
- Stamp / watermark: build a one-page PDF with ReportLab (`pdf_kit` font) and `page.merge_page(stamp_page)`.
- Text: `page.extract_text()` — layout approximate; scanned pages return empty.
- Form fields: `r.get_fields()`, `w.update_page_form_field_values(...)`, `w.set_need_appearances_writer(True)`; always render after filling.
- Never write to the source file; never remove `/Encrypt`, signatures (`/Sig`) or `/Perms` without explicit legitimate instruction. Merging/modifying invalidates digital signatures: tell the user.
- Compress: `page.compress_content_streams()`; images are not recompressed.

## Render
`render_pdf.py in.pdf out_dir --scale 1.4` (≈ 100 dpi; use 2 to read small text). Many pages: `--pages 1,2,last` and a contact sheet by pasting PNGs with PIL if you need an overview.
Reading a PDF's visuals (supplied by the user): render selected pages and read the PNGs; extract text separately; say which you used.
