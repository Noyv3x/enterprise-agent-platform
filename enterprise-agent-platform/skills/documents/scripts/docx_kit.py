"""python-docx helpers for business Word documents with correct Chinese typography.

    import sys; sys.path.insert(0, "/opt/agent-platform/skills/builtin/documents/scripts")
    from docx_kit import *

Fonts are only NAMES inside the DOCX; the reader's Word/WPS resolves them. Always set the
eastAsia slot, otherwise Chinese text silently falls back to the theme font.
"""
from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

LATIN, EAST = "Calibri", "Microsoft YaHei"          # sans: proposals, decks-as-docs
EAST_SERIF = "SimSun"                               # use for contracts / formal letters
ACCENT = RGBColor(0x1D, 0x4E, 0xD8)
INK = RGBColor(0x1F, 0x29, 0x33)


def set_fonts(style_or_run, latin=LATIN, east=EAST):
    """Set ascii/hAnsi/eastAsia/cs fonts on a style or run."""
    f = style_or_run.font
    f.name = latin
    rpr = (style_or_run.element.get_or_add_rPr() if hasattr(style_or_run, "element") and hasattr(style_or_run.element, "get_or_add_rPr")
           else style_or_run._element.get_or_add_rPr())
    fonts = rpr.find(qn("w:rFonts"))
    if fonts is None:
        fonts = OxmlElement("w:rFonts"); rpr.append(fonts)
    for slot in ("w:ascii", "w:hAnsi", "w:cs"):
        fonts.set(qn(slot), latin)
    fonts.set(qn("w:eastAsia"), east)


def new_document(body_pt=11, east=EAST, latin=LATIN, margins_cm=(2.54, 2.54, 3.17, 3.17), language="zh-CN"):
    """A4 document with a coherent style set: Normal, Title, Heading 1-3, List Bullet/Number, Caption."""
    doc = Document()
    sec = doc.sections[0]
    sec.page_width, sec.page_height = Cm(21), Cm(29.7)
    sec.top_margin, sec.bottom_margin, sec.left_margin, sec.right_margin = (Cm(m) for m in margins_cm)
    st = doc.styles
    normal = st["Normal"]; set_fonts(normal, latin, east)
    normal.font.size = Pt(body_pt); normal.font.color.rgb = INK
    normal.paragraph_format.line_spacing = 1.5; normal.paragraph_format.space_after = Pt(6)
    lang = OxmlElement("w:lang"); lang.set(qn("w:val"), "en-US"); lang.set(qn("w:eastAsia"), language)
    normal.element.get_or_add_rPr().append(lang)
    spec = {"Title": (24, 0, 12, False), "Heading 1": (16, 18, 6, True), "Heading 2": (13.5, 12, 4, True), "Heading 3": (12, 8, 3, True)}
    for name, (size, before, after, colored) in spec.items():
        s = st[name]; set_fonts(s, latin, east)
        s.font.size = Pt(size); s.font.bold = True
        s.font.color.rgb = ACCENT if colored else INK
        s.paragraph_format.space_before, s.paragraph_format.space_after = Pt(before), Pt(after)
        s.paragraph_format.keep_with_next = True
    for name in ("List Bullet", "List Number", "Caption"):
        set_fonts(st[name], latin, east)
    _fix_bullets(doc, latin)
    st["Caption"].font.size = Pt(9); st["Caption"].font.color.rgb = RGBColor(0x52, 0x60, 0x6D)
    return doc


def _fix_bullets(doc, latin):
    """The stock template draws bullets with the Symbol font (U+F0B7), which renders as a box in
    viewers without that font. Use a plain '•' in the body font instead."""
    numbering = doc.part.numbering_part.element
    for lvl in numbering.iter(qn("w:lvl")):
        fmt = lvl.find(qn("w:numFmt"))
        if fmt is not None and fmt.get(qn("w:val")) == "bullet":
            lvl.find(qn("w:lvlText")).set(qn("w:val"), "•")
            rpr = lvl.find(qn("w:rPr"))
            if rpr is not None:
                for f in rpr.findall(qn("w:rFonts")):
                    rpr.remove(f)
                f = OxmlElement("w:rFonts")
                for slot in ("w:ascii", "w:hAnsi", "w:cs", "w:eastAsia"):
                    f.set(qn(slot), latin)
                rpr.insert(0, f)


def indent_body(paragraph, chars=2):
    """Chinese body convention: first-line indent of N characters (use sparingly, not in tables/lists)."""
    paragraph.paragraph_format.first_line_indent = Pt(chars * (paragraph.style.font.size.pt if paragraph.style.font.size else 11))


def _field(paragraph, instruction, placeholder="1"):
    """Complex field: begin / instruction / separate / cached result / end, each in its own run."""
    def run_with(tag, **attrs):
        run = paragraph.add_run(); el = OxmlElement(tag)
        for k, v in attrs.items():
            el.set(qn(k.replace("_", ":", 1)), v)
        run._r.append(el); return run, el
    run_with("w:fldChar", w_fldCharType="begin")
    _, instr = run_with("w:instrText"); instr.set(qn("xml:space"), "preserve"); instr.text = f" {instruction} "
    run_with("w:fldChar", w_fldCharType="separate")
    result = paragraph.add_run(placeholder)
    run_with("w:fldChar", w_fldCharType="end")
    return result


def add_page_number_footer(section, prefix="第 ", middle=" 页 / 共 ", suffix=" 页"):
    """Footer 'Page X of N' using real PAGE / NUMPAGES fields (Word updates them when opening)."""
    p = section.footer.paragraphs[0]; p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    for text, field in ((prefix, None), (None, "PAGE"), (middle, None), (None, "NUMPAGES"), (suffix, None)):
        if text:
            p.add_run(text)
        else:
            _field(p, field)
    for r in p.runs:
        r.font.size = Pt(9)


def add_header_text(section, text):
    p = section.header.paragraphs[0]; p.text = text; p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    for r in p.runs:
        r.font.size = Pt(9); r.font.color.rgb = RGBColor(0x52, 0x60, 0x6D)


def add_toc(doc, levels="1-3"):
    """Insert a real TOC field. Until the reader updates fields (Word: F9 / right-click, WPS: 更新域)
    it shows the placeholder, so only use a TOC in long documents and tell the user to update it.
    Never fake a TOC by typing page numbers."""
    p = doc.add_paragraph()
    _field(p, f'TOC \\o "{levels}" \\h \\z \\u', "（目录：打开后右键选择“更新域”生成）")
    return p


def _shade(cell, hex_fill):
    pr = cell._tc.get_or_add_tcPr(); shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear"); shd.set(qn("w:color"), "auto"); shd.set(qn("w:fill"), hex_fill); pr.append(shd)


def add_table(doc, rows, widths_cm, number_cols=(), caption=None, font_pt=10):
    """rows[0] is the header (shaded, repeats on each page, never split across pages by a row break).
    widths_cm must sum to <= text width (A4 default margins: 15.2 cm)."""
    if caption:
        doc.add_paragraph(caption, style="Caption").paragraph_format.keep_with_next = True
    t = doc.add_table(rows=len(rows), cols=len(rows[0])); t.style = "Table Grid"
    t.alignment = WD_TABLE_ALIGNMENT.CENTER; t.autofit = False
    for r, row in enumerate(rows):
        tr = t.rows[r]._tr
        trpr = tr.get_or_add_trPr(); cant = OxmlElement("w:cantSplit"); trpr.append(cant)
        if r == 0:
            h = OxmlElement("w:tblHeader"); trpr.append(h)
        for c, value in enumerate(row):
            cell = t.cell(r, c); cell.width = Cm(widths_cm[c])
            p = cell.paragraphs[0]; p.paragraph_format.space_before = Pt(3); p.paragraph_format.space_after = Pt(3); p.paragraph_format.line_spacing = 1.2
            run = p.add_run(str(value)); run.font.size = Pt(font_pt)
            if c in number_cols:
                p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
            if r == 0:
                run.font.bold = True; run.font.color.rgb = RGBColor(255, 255, 255); _shade(cell, "1D4ED8")
            elif r % 2 == 0:
                _shade(cell, "EEF2F7")
    return t
