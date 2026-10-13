#!/usr/bin/env python3
"""Structural PDF check: pages, encryption, text sample per page, fonts and whether embedded.
Usage: inspect_pdf.py FILE.pdf. Text extraction does not prove the glyphs look right: render too."""
import sys
from pypdf import PdfReader

r = PdfReader(sys.argv[1])
print(f"pages={len(r.pages)} encrypted={r.is_encrypted} metadata={dict(r.metadata or {})}")
bad = False
for n, page in enumerate(r.pages, 1):
    box = page.mediabox
    text = (page.extract_text() or "").strip().replace("\n", " ")
    print(f"p{n} {float(box.width):.0f}x{float(box.height):.0f}pt chars={len(text)} :: {text[:80]}")
    res = page.get("/Resources")
    res = res.get_object() if res is not None else {}
    fonts = res.get("/Font")
    fonts = fonts.get_object() if fonts is not None else {}
    for key, ref in fonts.items():
        f = ref.get_object()
        desc = f.get("/FontDescriptor")
        if "/DescendantFonts" in f:
            desc = f["/DescendantFonts"][0].get_object().get("/FontDescriptor")
        embedded = bool(desc) and any(k in desc.get_object() for k in ("/FontFile", "/FontFile2", "/FontFile3"))
        std14 = str(f.get("/BaseFont", "")).lstrip("/") in {"Helvetica", "Helvetica-Bold", "Times-Roman", "Courier", "Symbol", "ZapfDingbats"}
        if not embedded and not std14:
            bad = True
        print(f"   font {f.get('/BaseFont')} embedded={embedded}")
if bad:
    print("WARNING: non-embedded non-standard font found; CJK text may render blank elsewhere")
    sys.exit(1)
