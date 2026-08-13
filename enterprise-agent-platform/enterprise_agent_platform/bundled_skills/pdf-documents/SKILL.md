---
name: "pdf-documents"
description: "Use whenever the user asks to create, assemble, inspect, split, merge, or deliver a PDF. Uses deterministic local PDF libraries to create or preserve a polished, professional, verified PDF and sends the actual file."
version: "1.1.0"
category: "documents"
tags: ["pdf","report","merge","split","reportlab","pypdf","file"]
---

# PDF documents

Use this Skill when PDF is the requested input or output format. For an
editable report, create DOCX instead unless the user specifically wants PDF.

## Workflow

1. Identify whether the task is generating a new designed document or preserving
   existing source pages. For new documents, identify audience and purpose and
   choose a restrained professional visual direction; for merge/split/reorder
   work, preserve source page appearance unless redesign was explicitly requested.
2. Work below `/workspace`; place final PDFs in `/workspace/deliverables/` and
   temporary files in `/workspace/.agent-platform/`.
3. Use preinstalled `reportlab` to create PDFs and `pypdf` to inspect, merge,
   split or copy pages. Do not install a converter or upload documents to an
   external service for ordinary work.
4. For generated PDFs, use a coherent type scale, readable margins and line
   lengths, consistent spacing and alignment, limited color, styled tables and
   useful page numbers/headers/footers. Do not ship raw library defaults.
5. Preserve page order and source content. Treat extracted text as incomplete
   when a PDF is scanned, image-heavy or has complex layout; do not claim OCR
   unless it was actually performed.
6. Reopen the result with `pypdf.PdfReader()`. Verify page count, encryption
   state, page boxes, representative extracted text when applicable, and non-zero
   size. Render and inspect representative pages for clipping, overflow and
   awkward pagination when a renderer is available; otherwise say no pixel-level
   preview was performed.
7. Remove only disposable files you created and keep the final PDF.
8. Send it by including this line in the final response:

```text
MEDIA: /workspace/deliverables/<filename>.pdf
```

Briefly state the page count and what was created or changed. Reporting a path
without `MEDIA:` does not attach the document.

## Safety and quality

- Do not execute embedded JavaScript, launch actions, macros or external links.
- Do not remove signatures, restrictions or attribution without explicit and
  legitimate user direction.
- Use readable margins, fonts, hierarchy and page numbers for generated reports;
  keep tables within page bounds and avoid widows, orphan headings and crowded pages.
- Never include credentials or unrelated workspace content.
