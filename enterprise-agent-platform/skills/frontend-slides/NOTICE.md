# Notice

- Origin: https://github.com/zarazhangrui/frontend-slides
- Upstream revision: `9906a34d640d2111f724544cbc50f7f130569ae1` (main, cloned 2026-10-13)
- License: MIT, Copyright (c) 2025 Zara Zhang. Full text in `LICENSE` (verified to be the repository's root license; this skill's files are from that tree).

## Changes made for this platform
- `SKILL.md` rewritten and shortened; Claude-specific question UI, `open` command, Vercel deploy and Playwright PDF export workflows removed (no network / no local Chromium in the sandbox); artifact publish and `artifact view` self-check added; output paths follow the run's working directory.
- `assets/viewport-base.css` is unchanged upstream.
- `assets/deck-skeleton.html` is new (built on the upstream stage model; adds `#N` links and `#all` overview).
- `references/style-presets.md` derived from upstream `STYLE_PRESETS.md`: web fonts (Google Fonts/Fontshare) replaced by local CJK-capable stacks; Chinese business defaults added.
- `references/animation-patterns.md`: upstream with two troubleshooting rows adjusted.
- `scripts/extract-pptx.py`: upstream, JSON written as UTF-8 without escaping CJK.
- Not included: upstream `bold-template-pack/` (2 MB, third-party web-font based designs, separate licence audit needed), `deploy.sh`, `export-pdf.sh`, inline-editing implementation, README.
