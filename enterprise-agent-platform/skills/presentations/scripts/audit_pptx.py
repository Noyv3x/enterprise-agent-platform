#!/usr/bin/env python3
"""Structural PPTX audit. Usage: audit_pptx.py FILE.pptx [--min-pt 12]
Reports per slide: title, shapes outside the slide, text below the minimum size, overlapping text boxes,
missing title, empty placeholders, picture aspect distortion, notes. Exit 1 when a hard problem is found.
Estimated text overflow is heuristic (CJK chars ~1em wide); confirm with `artifact view`."""
import sys
from pptx import Presentation
from pptx.util import Emu

min_pt = float(sys.argv[sys.argv.index("--min-pt") + 1]) if "--min-pt" in sys.argv else 12
prs = Presentation(sys.argv[1]); W, H = prs.slide_width, prs.slide_height
print(f"slides={len(prs.slides)} size={Emu(W).inches:.2f}x{Emu(H).inches:.2f}in")
bad = 0

def est_lines(shape):
    """Rough rendered line count for a text frame; compare to its height."""
    total = 0.0
    width_pt = Emu(shape.width).pt - 14
    for p in shape.text_frame.paragraphs:
        size = max([r.font.size.pt for r in p.runs if r.font.size] or [18])
        em = sum(1.0 if ord(ch) > 0x2E80 else 0.55 for ch in p.text) * size
        lines = max(1, -(-int(em) // max(int(width_pt), 1)))
        total += lines * size * 1.3 + size * 0.5
    return total

for i, slide in enumerate(prs.slides, 1):
    title = slide.shapes.title.text if slide.shapes.title is not None and slide.shapes.title.has_text_frame else None
    notes = slide.has_notes_slide and slide.notes_slide.notes_text_frame.text.strip()
    print(f"slide {i}: title={title!r} shapes={len(slide.shapes)} notes={'yes' if notes else 'no'}")
    if not title:
        print("   ! no title placeholder text"); bad += 1
    boxes = []
    for sh in slide.shapes:
        if sh.left is None:
            continue
        r, b = sh.left + sh.width, sh.top + sh.height
        if sh.left < 0 or sh.top < 0 or r > W or b > H:
            print(f"   ! outside slide: {sh.name}"); bad += 1
        if sh.is_placeholder and sh.has_text_frame and not sh.text_frame.text.strip():
            print(f"   ! empty placeholder: {sh.name}"); bad += 1
        if sh.shape_type == 13:  # picture
            cw, ch = sh.crop_left + sh.crop_right, sh.crop_top + sh.crop_bottom
            iw, ih = sh.image.size
            shown = (sh.width / sh.height); native = (iw * (1 - cw)) / (ih * (1 - ch))
            if abs(shown / native - 1) > 0.03:
                print(f"   ! picture distorted {sh.name}: shown {shown:.2f} vs native {native:.2f}"); bad += 1
        if sh.has_text_frame and sh.text_frame.text.strip():
            sizes = [r.font.size.pt for p in sh.text_frame.paragraphs for r in p.runs if r.font.size]
            if sizes and min(sizes) < min_pt:
                print(f"   ! font {min(sizes):.0f}pt < {min_pt:.0f}pt: {sh.name}"); bad += 1
            if sh.shape_type != 14 and est_lines(sh) > Emu(sh.height).pt * 1.15:
                print(f"   ? text may overflow its box: {sh.name} ({sh.text_frame.text[:30]!r})")
            boxes.append((sh.name, sh.left, sh.top, r, b))
    for a in range(len(boxes)):
        for c in range(a + 1, len(boxes)):
            n1, l1, t1, r1, b1 = boxes[a]; n2, l2, t2, r2, b2 = boxes[c]
            if l1 < r2 and l2 < r1 and t1 < b2 and t2 < b1:
                print(f"   ? text boxes overlap: {n1} / {n2}")
sys.exit(1 if bad else 0)
