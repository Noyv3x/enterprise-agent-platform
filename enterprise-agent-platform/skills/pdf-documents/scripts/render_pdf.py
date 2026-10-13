#!/usr/bin/env python3
"""Rasterize PDF pages to PNG with pypdfium2 so they can be read back as images.
Usage: render_pdf.py FILE.pdf OUT_DIR [--scale 1.4] [--pages 1,2,5]
Prints one PNG path per line. This proves what pypdfium2 draws (glyphs, clipping, layout),
not how every other PDF viewer will draw it."""
import argparse, os
import pypdfium2 as pdfium

ap = argparse.ArgumentParser(); ap.add_argument("pdf"); ap.add_argument("out")
ap.add_argument("--scale", type=float, default=1.4); ap.add_argument("--pages", default="")
a = ap.parse_args()
os.makedirs(a.out, exist_ok=True)
pdf = pdfium.PdfDocument(a.pdf)
want = {int(x) for x in a.pages.split(",") if x} or set(range(1, len(pdf) + 1))
for i in sorted(want):
    if 1 <= i <= len(pdf):
        path = os.path.join(a.out, f"page-{i:03d}.png")
        pdf[i - 1].render(scale=a.scale).to_pil().convert("RGB").save(path)
        print(path)
