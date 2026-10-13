# Style presets (offline-safe)

Palettes and signature devices adapted from frontend-slides `STYLE_PRESETS.md` (MIT, see NOTICE.md). **Fonts are replaced:** artifacts run under a strict CSP with no external network, so Google Fonts / Fontshare never load. Use only the local stacks below; get character from size, weight, spacing, colour and layout. Abstract CSS shapes only, no illustrations.

## Font stacks (CJK-safe)

```css
--font-sans:  "PingFang SC","Noto Sans CJK SC","Source Han Sans SC","Microsoft YaHei","Hiragino Sans GB",system-ui,sans-serif;
--font-serif: "Songti SC","Noto Serif CJK SC","Source Han Serif SC","STSong","SimSun",Georgia,"Times New Roman",serif;
--font-mono:  "SF Mono","JetBrains Mono",Menlo,Consolas,"Noto Sans Mono CJK SC",monospace;
```
Titles: weight 800-900 sans, or serif for editorial. Chinese needs line-height 1.5-1.7 for body, 1.2-1.3 for titles; never letter-space Chinese text. Traditional Chinese: swap `SC` for `TC` (`"PingFang TC","Noto Sans CJK TC","Microsoft JhengHei"`).

## Dark

| Preset | Vibe | Palette | Signature |
|---|---|---|---|
| Bold Signal | confident, high impact | bg `#1a1a1a`→`#2d2d2d`, card `#FF5722`, text `#fff` | big coloured card focal point; huge section numbers 01/02; breadcrumb nav with active/inactive opacity |
| Electric Studio | clean, high contrast, professional | `#0a0a0a`, `#fff`, accent `#4361ee` | white top / blue bottom split; accent bar on panel edge; quote as hero |
| Creative Voltage | energetic, retro-modern | blue `#0066ff`, dark `#1a1a2e`, neon `#d4ff00` | halftone texture, neon badges |
| Dark Botanical | elegant, premium | `#0f0f0f`, text `#e8e4df`, `#d4a574`, `#e8b4b8`, `#c9b896` | blurred overlapping gradient circles, thin vertical lines, serif |
| Neon Cyber | futuristic | `#0a0f1c`, `#00ffcc`, `#ff00aa` | grid pattern, glow (box-shadow), optional canvas particles |
| Terminal Green | developer | `#0d1117`, `#39d353` | mono only, scan lines, blinking cursor |

## Light

| Preset | Vibe | Palette | Signature |
|---|---|---|---|
| Notebook Tabs | editorial, tactile | outer `#2d2d2d`, page `#f8f6f1`, tabs `#98d4bb #c7b8ea #f4b8c5 #a8d8ea #ffe6a7` | paper card with shadow, coloured edge tabs (vertical text), binder holes |
| Pastel Geometry | friendly, approachable | bg `#c8d9e6`, card `#faf9f7`, pills `#f0b4d4 #a8d4c4 #5a7c6a #9b8dc4 #7c6aad` | rounded card; vertical pills of varying height on the right edge |
| Split Pastel | playful, modern | `#f5e6dc`, `#e4dff0`, badges `#c8f0d8 #f0f0c8 #f0d4e0` | split background, badge pills, grid overlay |
| Vintage Editorial | witty, personality | `#f5f3ee`, `#1a1a1a`, `#e8d4c0` | geometric circle+line+dot, bold bordered boxes |
| Swiss Modern | precise, Bauhaus | `#fff`, `#000`, `#ff3300` | visible grid, asymmetric layouts |
| Paper & Ink | literary, thoughtful | `#faf9f7`, `#1a1a1a`, `#c41e3a` | serif, pull quotes, thin rules |

## Chinese business defaults
- 汇报/述职/董事会: Swiss Modern or Paper & Ink, restrained; one accent colour; numbers big.
- 路演/发布会: Bold Signal or Electric Studio.
- 培训/分享: Pastel Geometry or Notebook Tabs.
- Respect any company colours or logo the user supplies over every preset.

## Avoid
Generic indigo `#6366f1`, purple gradients on white, everything centred, identical card grids, decoration without purpose, glassmorphism.

## CSS gotcha
Never negate CSS functions directly (`-clamp(...)` is silently ignored); use `calc(-1 * clamp(...))`.
