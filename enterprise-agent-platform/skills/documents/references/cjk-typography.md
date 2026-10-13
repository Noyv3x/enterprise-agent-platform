# Chinese typography in DOCX

## Fonts
A DOCX stores font **names**; the reader's Word/WPS resolves them. Every run/style needs four slots: `ascii`, `hAnsi`, `cs` (Latin) and **`eastAsia`** (Chinese). `docx_kit.set_fonts()` sets all four. python-docx's `font.name` alone sets only the Latin slot, so Chinese silently falls back to the theme font.

| Use | eastAsia | Latin |
|---|---|---|
| Proposals, reports, decks-as-docs | 微软雅黑 (`Microsoft YaHei`) | Calibri / Arial |
| Contracts, formal letters, academic | 宋体 (`SimSun`); headings 黑体 (`SimHei`) | Times New Roman |
| 党政机关公文 (GB/T 9704) | 正文 仿宋_GB2312 三号；标题 方正小标宋简体 二号；一级标题 黑体、二级 楷体 | — |
| Mac/WPS-safe alternative | 苹方 / 思源黑体 are not guaranteed on Windows: prefer the names above | — |

Do not embed fonts. If the user needs exact appearance everywhere, deliver a PDF as well (pdf-documents).

## Sizes (字号 → pt)
初号 42, 小初 36, 一号 26, 小一 24, 二号 22, 小二 18, 三号 16, 小三 15, 四号 14, 小四 12, 五号 10.5, 小五 9.
Business body 小四 or 五号; table text 五号/小五; footnotes/captions 小五.

## Paragraphs
- Body: first-line indent 2 characters (`indent_body`), line spacing 1.5 (or fixed 22–28 pt for 公文), space after 6 pt. No indent in tables, lists, headings, captions.
- Headings numbering conventions: 一、 → （一） → 1. → （1）; contracts use 第一条 / 1.1 / (1). Pick one scheme and keep it; typed numbers inside the heading text are acceptable, auto-numbering from python-docx needs a custom numbering definition and is not worth the risk.
- Justified text with mixed Latin looks gappy: keep left-aligned unless the template requires 两端对齐.
- Punctuation: full-width （）：；，。、？！“”‘’ in Chinese sentences; ASCII only inside Latin phrases, URLs, code, numbers (`3.14`, `12,800`). Avoid straight quotes `"` in Chinese text.
- Numbers/dates/amounts: `2026 年 10 月 13 日`, `¥12,800.00`, `12.5%`, large amounts `1,250 万元`; contracts also write 大写金额 (壹万贰仟元整) next to figures. Keep units in table headers (`金额（万元）`), not every cell.
- Dates and parties must agree across the document (title block, body, signature block).

## Contract / formal-letter skeleton
标题 → 合同编号 → 甲方/乙方（全称、统一社会信用代码、地址、联系人） → 鉴于/背景 → 条款（定义、标的、价款与支付、交付与验收、知识产权、保密、违约责任、争议解决、生效与终止） → 签署页（签字/盖章栏，日期）. Leave 【】 placeholders for unknown facts; never invent legal references.

## Page setup
A4, margins top/bottom 2.54 cm, left/right 3.17 cm (Word default) or 公文 37/35/28/26 mm. Header: document short title right-aligned 9 pt; footer: `第 X 页 / 共 N 页` fields. Cover page: use a separate section so the footer can be suppressed (`section.different_first_page_header_footer = True`).
