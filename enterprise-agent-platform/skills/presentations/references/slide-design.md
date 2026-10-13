# Slide design reference (16:9, 13.333 × 7.5 in)

## Grid
Margin 0.7 in; content width 11.93 in; title band top 0.45–1.45 in; content area 1.7–6.7 in; footer 6.95 in (12 pt muted). `pptx_kit.MARGIN`, `CONTENT_W`. 12-column thinking: 3 cards = (width − 2 gaps)/3 with 0.3 in gaps.

## Type scale (pt)
Title 28–32 bold · section/KPI figure 26–30 · body 18–22 · table/chart labels 14–16 · footer/caption/source 12. Never below 12. Chinese needs ~1.0 em per character: a 11.9 in box at 20 pt holds ≈ 40 Chinese characters per line.

## Storyline templates
- **Decision memo:** 结论/建议 → 背景与问题 → 方案对比 → 风险 → 需要的决策与时间表.
- **Business review:** 摘要（3 个关键数字）→ 业绩（图）→ 原因 → 风险 → 下一步（负责人+日期）.
- **Proposal/pitch:** 痛点 → 方案 → 价值证据 → 实施计划 → 报价/投入 → 下一步.
- **Training:** 目标 → 概念 → 示例 → 练习 → 小结.
Open with the answer; close with the ask/next steps. 8–15 slides for 20–30 min.

## Layout recipes (all in the kit)
- Title slide: title + one-line takeaway + presenter/date.
- KPI row: 3 `add_card` (figure + label) + 2 bullets of reading.
- Chart + takeaway: `add_chart` left 60–65 %, 2–3 bullets right; title carries the finding.
- Table: ≤ 6 rows × 5 columns, numbers right-aligned, units in header, highlight one row.
- Compare: two columns with a heading each; same number of rows.
- Process: 3–5 `add_card` in a row with numbers.

## Colour and contrast
One accent (`1D4ED8`), neutrals `1F2933`/`52606D`/`EEF2F7`. Text/background contrast ≥ 4.5:1; never colour alone to encode meaning. Charts: palette order blue, amber, green, violet; ≤ 5 series; data labels on.

## Notes and sources
Speaker notes (`slide.notes_slide.notes_text_frame.text`): talking points, data source, caveats. Footer: confidential label, date, page.

## Known python-pptx limits
No animations/transitions/SmartArt creation; no slide deletion API (use XML only if essential); charts have limited styling; default template is 4:3 — the kit sets 16:9 and repositions the title placeholder; layouts' other placeholders keep 4:3 geometry, so only use the 'Title Only' layout.
