---
name: "architecture-diagram"
description: "Use when the user wants a software, cloud, infrastructure, network, service or data-flow architecture diagram (系统架构图、部署图、数据流图、技术架构). Produces a self-contained HTML file with inline SVG, readable labels, semantic colors, boundaries and a legend, supports light and dark, scrolls cleanly in narrow panels, and is checked with artifact view before delivery."
license: MIT
metadata:
  version: "2.0.0"
  category: "visualization"
  tags: "architecture,diagram,svg,html,infrastructure,cloud"
---

# Architecture diagram

One standalone HTML document with inline CSS and SVG: no JavaScript, no
external fonts, images or stylesheets. Best for system architecture, cloud
infrastructure, services, databases, security boundaries and data flow. Use
another format for hand-drawn sketches, scientific illustration, org charts, or
when the user needs editable diagram source (then offer Mermaid or SVG as a
separate deliverable).

## Workflow (the publish, view, fix loop is required)

1. **Gather**: components, groups, trust boundaries, external actors, directed
   flows and what each flow carries (protocol, data, direction). Use only what
   the user or sources say; if a detail is unknown, label it "to be confirmed"
   rather than inventing a component or endpoint.
2. **Plan the layout** before writing: dominant flow left to right (or top to
   bottom), groups as boundaries, at most about 10 to 12 nodes per diagram. Split
   a larger system into an overview plus one detail diagram per area.
3. **Read the template** (read-only) as the structural reference:
   `read({"path":"/opt/agent-platform/skills/builtin/architecture-diagram/templates/template.html"})`
4. **Write** the complete HTML with `write` to a workspace-relative path under
   the run's working directory (default `architecture-diagram.html`). Never
   write into the built-in folder.
5. **Publish**: `artifact publish` with the file's absolute sandbox path and a
   short title. Do not use a MEDIA line for this deliverable and only the root
   agent publishes (a subagent returns the path).
6. **View**: `artifact view` on the published path, **twice**: at the panel
   width (`width: 420`) and at desktop width (`width: 1280`). Look at the
   screenshots for text outside or overlapping boxes, labels crossed by arrows,
   clipped content, wrong arrow direction, missing legend entries and console
   errors.
7. **Fix and re-publish the same path** (a new version, never `-v2` files).
   Repeat view until clean. If a check could not be done, say so; never claim
   a visual check that did not happen.
8. Reply with the path, a two or three line summary of what the diagram shows
   and any assumptions.

## Readable labels

- Node titles 16 to 18 SVG units, details and flow labels at least 13, boundary
  labels at least 12. Do not shrink text to make something fit; enlarge the
  `viewBox` or split the diagram.
- Short labels: a noun phrase of one to four words per line. Move long text
  into the summary cards or a table under the diagram.
- Size boxes to their text with at least 12 units of padding; keep 32 units
  between nodes and 20 between a boundary and its contents.
- Put a flow label above its arrow in clear space, never across a boundary line
  or another label. Chinese labels are about twice as wide per character as
  Latin ones: allow 16 units per character at the 16-unit size.
- Colors never carry meaning alone: every node and flow has text, and the
  legend names each color used.

## Colors and theme

Use the CSS classes in the template: `frontend`, `backend`, `database`,
`security`, `queue`, `external`, `boundary`. They draw from CSS variables with a
light default and a dark override under `prefers-color-scheme: dark`, using solid
fills (no translucent fills over lines) and a self-contained card background, so
contrast holds in either theme. Do not hard-code hex colors on elements. If the
user supplies brand colors, change the variables once in `:root`, and keep text
contrast at least 4.5 : 1.

## Narrow panels and mobile

The artifact panel can be around 400 px wide. The template gives the SVG a
`min-width: 600px` inside a scrolling card, so labels stay readable and the
diagram scrolls sideways, with a visible swipe hint below 700 px. Keep the whole
meaning available without scrolling: the summary cards under the diagram list the
components and flows in text. Do not set a large fixed `min-width`
(beyond about 640) and never hide content with `overflow: hidden`.

## SVG construction

- `viewBox` set, width from CSS, `<title>` and `<desc>` present.
- Draw order: grid and background, boundaries, connections, nodes, then the
  legend outside every boundary.
- Unique marker ids; consistent arrowheads; orthogonal routes around boxes,
  no diagonal crossings through text.
- Dashed rose lines (`flow sensitive`) for security-sensitive flows; dashed
  amber boxes for regions or cloud boundaries.
- Grow the `viewBox` height so the lowest element, including the legend, fits.
- No secrets, real credentials or sensitive internal endpoints.

## Final checks

- Every requested component appears once, in the right group.
- Every flow has the correct direction and label.
- Nothing overlaps text; the legend is outside the boundaries.
- Both screenshots (420 and 1280 px) were inspected after the last change.
- The file opens with no network access.

Attribution and licence: `references/NOTICE.md`.
