---
name: "architecture-diagram"
description: "Use when the user wants a software, cloud, infrastructure, service, or data-flow diagram. Produces a self-contained dark HTML file with accessible inline SVG, labeled flows, semantic colors, boundaries, and a legend without external assets."
version: "1.0.0"
category: "visualization"
tags: ["architecture","diagram","svg","html","infrastructure","cloud"]
---

# Architecture Diagram

Create a standalone HTML document containing inline CSS and SVG. This style is
best for system architecture, cloud infrastructure, services, databases,
security boundaries, and data flow. Prefer another representation when the
user needs a hand-drawn sketch, scientific illustration, or editable diagram
source.

## Workflow

1. Identify components, groups, trust boundaries, and external actors.
2. List directed flows and label their meaning or protocol.
3. Choose a layout that follows the dominant flow from left to right or top to
   bottom.
4. Read the bundled template when a structural reference is useful:

```text
skill({
  "action":"read",
  "arguments":{
    "id":"architecture-diagram",
    "file_path":"templates/template.html"
  }
})
```

5. Write the completed document to a user-selected workspace-relative `.html`
   path, or default to `architecture-diagram.html`.
6. Inspect the generated source and report the path. Do not claim visual
   correctness unless it was actually rendered or reviewed.

## Semantic palette

| Component | Fill | Stroke |
|---|---|---|
| Frontend | `rgba(8,51,68,.55)` | `#22d3ee` |
| Backend | `rgba(6,78,59,.55)` | `#34d399` |
| Database | `rgba(76,29,149,.55)` | `#a78bfa` |
| Cloud/boundary | `rgba(120,53,15,.35)` | `#fbbf24` |
| Security | `rgba(136,19,55,.50)` | `#fb7185` |
| Queue/event bus | `rgba(124,45,18,.45)` | `#fb923c` |
| External actor | `rgba(30,41,59,.75)` | `#94a3b8` |

Use the same color for the same semantic role throughout one diagram. Do not
rely on color alone: every component and flow needs text.

## SVG construction rules

- Set a `viewBox`; let CSS make the SVG responsive.
- Draw the background and connection paths before component boxes so arrows
  stay behind nodes.
- Give every marker a unique ID and use arrowheads consistently.
- Put an opaque dark rectangle beneath a translucent component fill so
  connection lines do not show through.
- Use rounded boxes with a clear title and optional smaller subtitle.
- Keep at least 32 pixels between components and 20 pixels between a boundary
  and its contents.
- Use dashed rose lines for security-sensitive flows and dashed amber boxes
  for regions or cloud boundaries.
- Route lines around boxes. Avoid diagonal crossings where an orthogonal path
  is clearer.
- Place the legend outside every group or boundary.
- Expand the `viewBox` rather than squeezing labels when content grows.

## Document requirements

- one self-contained HTML file;
- no JavaScript;
- no external fonts, stylesheets, images, or runtime dependencies;
- system monospace font stack;
- `<title>` and `<desc>` in the SVG;
- readable contrast and minimum 12px primary labels;
- a short text summary below the diagram for users who cannot consume the
  visual;
- no secrets, real credentials, or sensitive internal endpoints.

## Final checks

- Every requested component appears once in the intended group.
- Every connection has the correct direction and label.
- Arrows do not run through component text.
- Boundaries contain their members and the legend is outside them.
- The SVG has enough height for its lowest element.
- The file opens without network access.

License and source attribution are in `references/NOTICE.md`.
