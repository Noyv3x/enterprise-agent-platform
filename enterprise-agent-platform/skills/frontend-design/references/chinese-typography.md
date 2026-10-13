# Chinese typography for HTML pages

## Font stacks (local only, no downloads)
```css
:root{
  --sans:  "PingFang SC","Noto Sans CJK SC","Source Han Sans SC","Microsoft YaHei","Hiragino Sans GB",system-ui,sans-serif;
  --serif: "Songti SC","Noto Serif CJK SC","Source Han Serif SC","STSong","SimSun",Georgia,serif;
  --kai:   "Kaiti SC","STKaiti","KaiTi",serif;               /* sparing: quotes, seals */
  --mono:  "SF Mono",Menlo,Consolas,"Noto Sans Mono CJK SC",monospace;
}
```
Traditional Chinese: replace `SC` with `TC` / `HK`, `Microsoft YaHei` → `Microsoft JhengHei`. Put the Latin face first only if you have a real local one; otherwise CJK-first stacks render Latin acceptably.

## Scale and rhythm
- Body 16-18px (mobile 16px), line-height 1.7; headings 1.25-1.35; paragraph spacing 0.8-1em. Measure 28-40 characters.
- Weights: 400 body, 600/700 headings; very thin weights (<300) fail on many Windows systems.
- No `letter-spacing` on Chinese; no `text-transform: uppercase` expectations; italics do not exist in CJK, use weight/colour or `font-style` only on Latin.
- `text-align: justify` with `text-justify: inter-ideograph` is safe for body; avoid for mixed narrow columns.
- `word-break: normal; overflow-wrap: anywhere;` for long URLs/IDs in table cells.

## Punctuation and mixed script
- Full-width punctuation `，。、；：？！“”（）` in Chinese sentences; half-width inside Latin phrases. Prefer `「」` in zh-TW.
- Leave a thin space between Chinese and Latin/digits only when the typeface needs it (`<span style="margin:0 .15em">`), never double spaces.
- Numbers: use tabular figures for tables (`font-variant-numeric: tabular-nums`), group thousands (1,234,567) or 万/亿 units consistently; show units next to numbers.
- Dates `2026年10月13日` or `2026-10-13`; currency `¥1,280.00`.
- Line-start/end rules: `line-break: strict;` improves kinsoku handling.

## Layout habits of Chinese business UIs
- Information density is higher than Western sites: tables, filters and status tags are normal; keep hierarchy with spacing and weight, not whitespace alone.
- Primary action colour must contrast with status colours; Chinese finance convention: red = up, green = down (state this in the legend when users may expect the opposite).
- Navigation labels 2-4 characters; button labels 2-4 characters verbs (保存, 导出报表).
