---
name: frontend-slides
description: 'Build an HTML slide deck (网页版演示文稿 / HTML 幻灯片) that opens directly in the artifact panel and in any browser: pitches, talks, training, internal reports, or converting an existing .pptx into a web deck. Use when the user asks for web/HTML slides or an animated, designed presentation they can view immediately. For an editable PowerPoint file (.pptx) use the presentations skill instead; for single diagrams use architecture-diagram.'
metadata:
  version: 1.0.0
  upstream: zarazhangrui/frontend-slides (MIT), adapted
---

# HTML slide decks

One self-contained `.html` file: inline CSS/JS, no build, no external fonts or network. Fixed 1920×1080 stage scaled as a whole (never reflowed per device).

## Delivery (platform rules)
- Write to the run's working directory: `<cwd>/<deck-name>.html` (personal AI `/workspace/...`, chat `/workspace/<conversation id>/...`). Images go in `<deck-name>-assets/` next to it, referenced relatively; prefer inline SVG/CSS shapes or base64 for few small images.
- Start from `/opt/agent-platform/skills/builtin/frontend-slides/assets/deck-skeleton.html` (read-only; copy its content into your file). It already contains `viewport-base.css`, scaling, keyboard/touch/wheel navigation, `#N` deep links and `#all` overview. Keep that `<style>` base block verbatim.
- Publish with a standalone MEDIA line or `artifact publish`; revise the **same path** to make a new version. Subagents never publish; they return the path.
- No network in chat: never `<link>` web fonts or CDN scripts. Use the font stacks in `references/style-presets.md`. Deploy/PDF-upload services are not available; offer the HTML download, or browser print (CSS already prints one slide per page).

## Workflow
1. **Brief (one message, ask only what is missing):** purpose (汇报/路演/培训/分享), audience, slide count (5-10 / 10-20 / 20+), content state (ready / rough notes / topic only), density: **speaker-led** (1 idea per slide, ≤3 bullets, big type) or **reading-first** (4-8 bullets or 4-6 cards, grids/tables). Mixed needs → pick the nearer mode. If the user gave company colours/logo/template, those win over presets.
2. **Outline** the slides (title + one-line message each; the title states the conclusion, not the topic). Show it only when the deck is long or content is ambiguous; otherwise proceed.
3. **Style:** pick a preset from `references/style-presets.md` that fits purpose/audience, or design a custom one (committed palette, one distinctive layout device). Do not render process labels ("preview", "option A", preset names) on slides. For a deck where taste is unclear, write 2-3 one-slide previews (`<name>-style-a.html` …), publish them, let the user choose, then delete previews.
4. **Build** the full deck. Motion guidance in `references/animation-patterns.md` (CSS-only, `prefers-reduced-motion` already handled).
5. **Self-check (mandatory, root agent):** `artifact view` the deck at `#all` (every slide as a thumbnail) and at `#1`, `#N` for dense slides. Fix overflow, overlap, tiny text, clipped cards, wrong CJK font, console errors; re-view. State only what you actually viewed.
6. Summarize: path, slide count, style, navigation (←/→, Space, swipe), how to edit (CSS variables in `:root`).

## Hard rules
- Authored size 1920×1080. Body ≥ 28px, small labels ≥ 24px, titles 72-112px. No scrolling, no overflow, no overlapping panels; too much content → split into more slides, never shrink.
- Slide visibility only through `.active/.visible` (visibility/opacity), never `display:none`.
- Never negate CSS functions (`-clamp()`); use `calc(-1 * …)`.
- Chinese: line-height 1.5-1.7 body / 1.2-1.3 titles, no letter-spacing, full-width punctuation; numbers and units with real values (never invent figures; mark placeholders visibly and tell the user).
- No generic "AI look": no purple-on-white gradients, identical card grids, everything centred, decoration without purpose.
- Images: inspect each supplied image (view it), use only usable ones, never reuse the same image on several slides (logo on title + closing excepted), `object-fit: contain` inside the stage.

## Converting a .pptx
`python /opt/agent-platform/skills/builtin/frontend-slides/scripts/extract-pptx.py <input.pptx> <workdir>` writes `<workdir>/extracted-slides.json` (titles, text, notes) and `<workdir>/assets/` (images). Confirm titles/counts with the user, pick a style, then rebuild preserving text, images, order; put speaker notes in HTML comments. Needs `python-pptx` (present in the sandbox).

## Modifying an existing deck
Count existing elements before adding; over the density limit → split into continuation slides and tell the user. Re-run the artifact view check after every change.

## References
- `references/style-presets.md` – 12 offline-safe style palettes, font stacks, Chinese business defaults
- `references/animation-patterns.md` – effects by feeling, backgrounds, troubleshooting
- `assets/deck-skeleton.html`, `assets/viewport-base.css`, `scripts/extract-pptx.py`
