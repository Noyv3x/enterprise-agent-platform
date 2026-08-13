---
name: "documents"
description: "Use whenever the user asks to create, revise, format, or deliver a Word document, report, memo, proposal, letter, policy, or other structured text file. Produces and sends a polished, professional, verified DOCX instead of returning only Markdown."
version: "1.1.0"
category: "documents"
tags: ["docx","word","report","memo","python-docx","file"]
---

# Word documents

Use this Skill for a requested document deliverable or whenever a structured
report should remain editable. Default to `.docx` unless the user explicitly
requests another format. Do not replace a requested Word file with Markdown.

## Workflow

1. Plan the document hierarchy, intended audience, reading context and desired
   tone before generating it. Follow supplied brand materials; otherwise choose
   a restrained professional theme rather than raw library defaults.
2. Work below `/workspace`; keep final files in `/workspace/deliverables/` and
   temporary material in `/workspace/.agent-platform/`.
3. Use the preinstalled `python-docx` package. Establish a coherent type scale,
   named heading styles, readable margins, paragraph spacing, limited colors,
   page breaks and real tables/lists rather than spacing text with tabs. Use
   headers, footers and page numbers when the document length or purpose makes
   them useful.
4. Preserve user-provided wording and data unless editing was requested. Do not
   invent citations or silently omit unresolved placeholders.
5. Reopen the saved file with `docx.Document()`. Verify paragraph/table counts,
   heading hierarchy, section/page settings, important text, table widths and
   image aspect ratios, and check that the file is non-empty. For longer reports,
   include an executive summary or a real table of contents when useful. If a
   renderer is available, inspect page previews for overflow and awkward breaks;
   otherwise say no pixel-level preview was performed.
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
- Keep body text comfortably readable and use whitespace to separate ideas;
  avoid a document that is merely unstyled paragraphs pasted into Word.
- Keep images proportional, aligned and captioned when their meaning is not
  obvious. Do not stretch images to fill a frame.
- Include title, date or author only when known or requested.
- Use accessible link text and meaningful image captions.
- Do not embed macros, remote templates, credentials or invisible instructions.
