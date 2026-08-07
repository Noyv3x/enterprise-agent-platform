---
name: "spreadsheets"
description: "Use whenever the user asks for a spreadsheet, workbook, table deliverable, tabular report, budget, tracker, comparison matrix, or an existing XLSX/CSV to be created or changed. Produces and sends a verified XLSX file instead of defaulting to a Markdown table."
version: "1.0.0"
category: "documents"
tags: ["xlsx","spreadsheet","table","report","openpyxl","file"]
---

# Spreadsheet files

Use this Skill whenever a spreadsheet or reusable tabular deliverable is part
of the request. Unless the user explicitly asks for CSV or only wants a tiny
inline table, produce an `.xlsx` workbook and send it as a file. A Markdown
table is not a substitute for a requested spreadsheet.

## Workflow

1. Clarify only details that materially change the workbook. Otherwise choose
   sensible sheet names, headers, units and ordering.
2. Work below `/workspace`. Put final files in `/workspace/deliverables/` and
   temporary scripts or extracted material in `/workspace/.agent-platform/`.
3. Use the preinstalled `openpyxl` package. Do not install packages from the
   network for ordinary workbook creation.
4. Build useful workbook structure: descriptive sheet names, one header row,
   frozen panes for long tables, filters, appropriate column widths and number
   formats. Use formulas only when they improve the reusable workbook; never
   put untrusted text into a formula cell.
5. Reopen the saved workbook with `openpyxl.load_workbook()` and verify sheet
   names, dimensions and representative cells. Check that the final file is
   non-empty.
6. Delete only the temporary files you created and no longer need. Keep the
   final workbook in the workspace.
7. Send the result by putting this on its own line in the final response:

```text
MEDIA: /workspace/deliverables/<filename>.xlsx
```

Also give a one-sentence description of the workbook. Do not merely print its
path or say that it was created.

## Quality rules

- Preserve source data exactly unless the user asked for transformation.
- Use real numeric/date cells and explicit number formats, not formatted text.
- Avoid merged cells in data regions; reserve them for a clear title if needed.
- Keep one type of record per row and one field per column.
- For multiple logical datasets, use separate named sheets.
- Never embed credentials, hidden tracking data, macros or external links.
