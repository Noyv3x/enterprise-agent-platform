---
name: "presentations"
description: "Use whenever the user asks for slides, a deck, a presentation, a pitch, or a PPTX to be created or edited. Produces, verifies, and sends a polished, professional, presentation-ready file rather than returning a Markdown slide outline."
version: "1.1.0"
category: "documents"
tags: ["pptx","slides","presentation","deck","python-pptx","file"]
---

# Presentation files

Use this Skill whenever slides or a deck are requested. An outline can be an
intermediate step, but the default deliverable is a real `.pptx` file.

## Workflow

1. Define the audience, decision or story and a short slide sequence. Keep one
   clear message per slide. Follow supplied brand materials; otherwise establish
   one restrained professional visual system before building individual slides.
2. Work below `/workspace`; save finals in `/workspace/deliverables/` and
   temporary assets in `/workspace/.agent-platform/`.
3. Use the preinstalled `python-pptx` package. Choose a coherent 16:9 layout,
   strong contrast, consistent type scale, a grid and adequate safe margins.
   Prefer charts, diagrams and concise callouts over dense paragraphs. Vary
   layouts to support the story while preserving the same alignment, palette
   and typographic system; do not expose raw default template styling.
4. Never stretch images or invent data. Cite sources in speaker notes or a
   compact footer when the user supplied or requested sources.
5. Reopen the file with `pptx.Presentation()`. Verify slide count, titles,
   important text, minimum readable text size, image aspect ratios, and that
   every shape stays inside the slide bounds without unintended overlaps.
   Check the file is non-empty. Render and inspect slides when a renderer is
   available; otherwise state honestly that pixel-level rendering was unavailable.
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
- Avoid tiny body text, accidental clipping and decorative elements that do not
  support the slide's message.
- Keep editable text and shapes when possible.
- Do not embed macros, remote templates, credentials or external trackers.
