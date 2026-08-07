---
name: "documents"
description: "Use whenever the user asks to create, revise, format, or deliver a Word document, report, memo, proposal, letter, policy, or other structured text file. Produces and sends a verified DOCX instead of returning only Markdown."
version: "1.0.0"
category: "documents"
tags: ["docx","word","report","memo","python-docx","file"]
---

# Word documents

Use this Skill for a requested document deliverable or whenever a structured
report should remain editable. Default to `.docx` unless the user explicitly
requests another format. Do not replace a requested Word file with Markdown.

## Workflow

1. Plan the document hierarchy and intended audience before generating it.
2. Work below `/workspace`; keep final files in `/workspace/deliverables/` and
   temporary material in `/workspace/.agent-platform/`.
3. Use the preinstalled `python-docx` package. Apply named heading styles,
   readable margins, consistent fonts, page breaks and real tables/lists rather
   than spacing text with tabs.
4. Preserve user-provided wording and data unless editing was requested. Do not
   invent citations or silently omit unresolved placeholders.
5. Reopen the saved file with `docx.Document()`. Verify paragraph/table counts,
   headings, important text and that the file is non-empty.
6. Remove only disposable intermediate files you created. Keep the final DOCX.
7. Send the result in the final response with a line exactly like:

```text
MEDIA: /workspace/deliverables/<filename>.docx
```

Briefly summarize the document and any assumptions. A local path without the
`MEDIA:` line does not send the file to the user.

## Quality rules

- Use styles consistently so the user can restyle the document later.
- Keep tables within page width and repeat header rows where useful.
- Include title, date or author only when known or requested.
- Use accessible link text and meaningful image captions.
- Do not embed macros, remote templates, credentials or invisible instructions.
