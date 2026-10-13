# Editing a supplied DOCX safely

1. Copy the original to a new filename first; edit the copy. Report the new path.
2. `Document(path)`; edit **runs**, not whole paragraph text: `paragraph.text = "…"` destroys run formatting. To replace text spanning runs, put the new text in the first run and clear the others (keep `r.font` of the first).
3. Find content by walking `doc.paragraphs`, `doc.tables` (cells contain paragraphs), and each `section.header/footer`. Text boxes, content controls, footnotes and text inside shapes are NOT in `doc.paragraphs`: search the XML (`doc.element.body.iter(qn("w:t"))`) before claiming a term is absent.
4. Insert new paragraphs after an existing one with `copy.deepcopy(p._p)` + `addnext`, then set text on the clone, so style/indent/numbering carry over. Never type list numbers by hand into numbered lists.
5. python-docx keeps parts it does not understand (comments, custom XML, embedded objects) on save, but it cannot create comments or tracked changes. If the user asks for tracked revisions, say you cannot produce native tracked changes and offer a clearly marked changed copy plus a change list.
6. Do not touch: fields (TOC, PAGE, cross-references), section breaks, headers/footers, styles of untouched text, document properties of the original author unless asked.
7. Legacy `.doc`, password-protected or macro (`.docm`) files: cannot be edited safely here. Say so; ask for `.docx` or rebuild from content with the user's agreement.
8. After saving: reopen, diff paragraph counts and the list of changed paragraphs against the original, run `inspect_docx.py`, and `artifact view` the result. State exactly what changed and what was left alone.
