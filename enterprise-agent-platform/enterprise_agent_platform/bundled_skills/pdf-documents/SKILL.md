---
name: "pdf-documents"
description: "Use whenever the user asks to create, assemble, inspect, split, merge, or deliver a PDF. Uses deterministic local PDF libraries, verifies the result, and sends the actual PDF file."
version: "1.0.0"
category: "documents"
tags: ["pdf","report","merge","split","reportlab","pypdf","file"]
---

# PDF documents

Use this Skill when PDF is the requested input or output format. For an
editable report, create DOCX instead unless the user specifically wants PDF.

## Workflow

1. Work below `/workspace`; place final PDFs in `/workspace/deliverables/` and
   temporary files in `/workspace/.agent-platform/`.
2. Use preinstalled `reportlab` to create PDFs and `pypdf` to inspect, merge,
   split or copy pages. Do not install a converter or upload documents to an
   external service for ordinary work.
3. Preserve page order and source content. Treat extracted text as incomplete
   when a PDF is scanned, image-heavy or has complex layout; do not claim OCR
   unless it was actually performed.
4. Reopen the result with `pypdf.PdfReader()`. Verify page count, encryption
   state, representative extracted text when applicable, and non-zero size.
5. Remove only disposable files you created and keep the final PDF.
6. Send it by including this line in the final response:

```text
MEDIA: /workspace/deliverables/<filename>.pdf
```

Briefly state the page count and what was created or changed. Reporting a path
without `MEDIA:` does not attach the document.

## Safety and quality

- Do not execute embedded JavaScript, launch actions, macros or external links.
- Do not remove signatures, restrictions or attribution without explicit and
  legitimate user direction.
- Use readable margins, fonts and page numbers for generated reports.
- Never include credentials or unrelated workspace content.
