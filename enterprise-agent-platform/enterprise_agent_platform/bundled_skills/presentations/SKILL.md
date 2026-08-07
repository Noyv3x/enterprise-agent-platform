---
name: "presentations"
description: "Use whenever the user asks for slides, a deck, a presentation, a pitch, or a PPTX to be created or edited. Produces, verifies, and sends a real presentation file rather than returning a Markdown slide outline."
version: "1.0.0"
category: "documents"
tags: ["pptx","slides","presentation","deck","python-pptx","file"]
---

# Presentation files

Use this Skill whenever slides or a deck are requested. An outline can be an
intermediate step, but the default deliverable is a real `.pptx` file.

## Workflow

1. Define the audience, decision or story and a short slide sequence. Keep one
   clear message per slide.
2. Work below `/workspace`; save finals in `/workspace/deliverables/` and
   temporary assets in `/workspace/.agent-platform/`.
3. Use the preinstalled `python-pptx` package. Choose a coherent 16:9 layout,
   strong contrast, consistent type scale and adequate margins. Prefer charts,
   diagrams and concise callouts over dense paragraphs.
4. Never stretch images or invent data. Cite sources in speaker notes or a
   compact footer when the user supplied or requested sources.
5. Reopen the file with `pptx.Presentation()`. Verify slide count, titles,
   important text and shape boundaries programmatically. Check the file is
   non-empty; state honestly if visual rendering was unavailable.
6. Remove only your disposable intermediate assets and keep the final deck.
7. Send it with this exact final-response pattern:

```text
MEDIA: /workspace/deliverables/<filename>.pptx
```

Include a short description and slide count. Do not stop at a Markdown outline
unless the user explicitly asked only for an outline.

## Quality rules

- Avoid walls of text, tiny type, random alignment and repeated identical layouts.
- Use a limited palette with accessible contrast and consistent spacing.
- Keep editable text and shapes when possible.
- Do not embed macros, remote templates, credentials or external trackers.
