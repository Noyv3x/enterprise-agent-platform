# Page patterns and final checks

## Patterns
- **落地页 / 官网:** hero (one claim + proof) → 3-5 value blocks with real content → evidence (cases, numbers with sources) → single clear call to action. One memorable device only.
- **数据看板:** top KPIs (value, unit, period-over-period, tooltip for definition) → one main chart → breakdown tables. Inline SVG charts, labelled axes, colour-blind safe palette, "数据截至 YYYY-MM-DD" visible. Never fabricate data; if sample data, label it 示例数据.
- **HTML 报告:** executive summary first, anchored table of contents, sections with conclusions as headings, sources and assumptions at the end, print stylesheet (`@media print`).
- **表单 / 小工具:** labels above fields, inline validation, disabled-with-reason, keyboard order, persisted state only with localStorage when the user asks.

## Self-check before delivering (via `artifact view`)
1. Desktop (~1280) and phone (~390) both: nothing clipped, no horizontal scroll, readable text.
2. CJK glyphs render with the intended family (no tofu boxes); mixed Latin/Chinese baseline looks even.
3. Console clean; no failed requests (no external resources).
4. Contrast, focus ring, tap targets.
5. Copy: no lorem ipsum, no invented facts; placeholders flagged.
