"""ReportLab helpers for business PDFs with embedded Chinese text.

Import in place:
    import sys; sys.path.insert(0, "/opt/agent-platform/skills/builtin/pdf-documents/scripts")
    from pdf_kit import *

ReportLab 3.6 can only embed TrueType-outline fonts, so the sandbox ships
WenQuanYi Micro Hei (covers Simplified and Traditional Chinese, Latin, digits).
It has one weight: emphasis comes from size and colour, <b> keeps the same face.
"""
import os
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, Frame, Image, KeepTogether, PageBreak, PageTemplate,
                                Paragraph, Spacer, Table, TableStyle)

CJK_CANDIDATES = [
    (os.environ.get("PDF_CJK_FONT", ""), 0),
    ("/usr/share/fonts/truetype/wqy/wqy-microhei.ttc", 0),
    ("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", 0),
]
FONT = "CJK"
INK, MUTED, ACCENT, RULE, TINT = (colors.HexColor(c) for c in ("#1f2933", "#52606d", "#1d4ed8", "#cbd2d9", "#eef2f7"))


def register_fonts():
    """Register and embed a CJK TrueType font as family 'CJK'. Raises if none is usable
    (never silently fall back to a non-embedded font: viewers would show blanks)."""
    for path, index in CJK_CANDIDATES:
        if path and os.path.exists(path):
            pdfmetrics.registerFont(TTFont(FONT, path, subfontIndex=index))
            pdfmetrics.registerFontFamily(FONT, normal=FONT, bold=FONT, italic=FONT, boldItalic=FONT)
            return FONT
    raise RuntimeError("No CJK TrueType font found; set PDF_CJK_FONT=/path/font.ttf")


def styles(base=10.5):
    register_fonts()
    def s(name, **kw):
        kw.setdefault("fontName", FONT); kw.setdefault("textColor", INK)
        kw.setdefault("fontSize", base); kw.setdefault("leading", base * 1.6)
        kw.setdefault("alignment", TA_LEFT); kw.setdefault("wordWrap", "CJK")  # CJK line breaking
        return ParagraphStyle(name, **kw)
    return {
        "title": s("title", fontSize=base * 2.2, leading=base * 2.9, spaceAfter=6),
        "subtitle": s("subtitle", fontSize=base * 1.15, textColor=MUTED, spaceAfter=18),
        "h1": s("h1", fontSize=base * 1.6, leading=base * 2.2, textColor=ACCENT, spaceBefore=16, spaceAfter=6, keepWithNext=1),
        "h2": s("h2", fontSize=base * 1.25, leading=base * 1.8, spaceBefore=10, spaceAfter=4, keepWithNext=1),
        "body": s("body", firstLineIndent=base * 2, spaceAfter=base * 0.5),  # 2-char indent is the Chinese convention
        "body_flush": s("body_flush", spaceAfter=base * 0.5),
        "bullet": s("bullet", leftIndent=base * 1.6, bulletIndent=base * 0.4, spaceAfter=2),
        "cell": s("cell", fontSize=base * 0.9, leading=base * 1.35),
        "cell_head": s("cell_head", fontSize=base * 0.9, leading=base * 1.35, textColor=colors.white),
        "caption": s("caption", fontSize=base * 0.82, leading=base * 1.2, textColor=MUTED, spaceAfter=8),
    }


def data_table(rows, col_widths, st, number_cols=()):
    """rows[0] is the header. Cells are wrapped in Paragraphs so long text and Chinese wrap
    inside the column; the header row repeats on every page; number columns are right-aligned."""
    out = []
    for r, row in enumerate(rows):
        cells = []
        for c, value in enumerate(row):
            style = st["cell_head"] if r == 0 else st["cell"]
            if c in number_cols:
                style = ParagraphStyle(f"n{r}{c}", parent=style, alignment=2)
            cells.append(Paragraph(str(value), style))
        out.append(cells)
    t = Table(out, colWidths=col_widths, repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), ACCENT),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, TINT]),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, RULE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ]))
    return t


def build_pdf(path, story, title="", author="", header="", pagesize=A4, margins_mm=(22, 20, 22, 20)):
    """Build `story` with a running header, a rule and 'n / N' page numbers (two-pass)."""
    register_fonts()
    left, top, right, bottom = (m * mm for m in margins_mm)
    width, height = pagesize

    class Doc(BaseDocTemplate):
        def __init__(self, *a, **k):
            super().__init__(*a, **k); self.total = None

    def decorate(canvas, doc):
        canvas.saveState(); canvas.setFont(FONT, 8.5); canvas.setFillColor(MUTED)
        if header:
            canvas.drawString(left, height - top + 8 * mm, header)
            canvas.setStrokeColor(RULE); canvas.setLineWidth(0.5)
            canvas.line(left, height - top + 6 * mm, width - right, height - top + 6 * mm)
        total = doc.total or "?"
        canvas.drawRightString(width - right, bottom - 9 * mm, f"{doc.page} / {total}")
        canvas.restoreState()

    def make(total):
        doc = Doc(path, pagesize=pagesize, leftMargin=left, rightMargin=right, topMargin=top, bottomMargin=bottom,
                  title=title, author=author)
        doc.total = total
        doc.addPageTemplates([PageTemplate(id="p", frames=[Frame(left, bottom, width - left - right, height - top - bottom, id="f")], onPage=decorate)])
        return doc
    import copy
    first = make(None); first.build(copy.deepcopy(story))
    make(first.page).build(story)
    return path
