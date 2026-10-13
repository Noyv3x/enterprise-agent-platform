---
name: evidence-research
description: 'Evidence-based research with traceable sources and verified citations: literature reviews, 文献综述, 行业/市场/政策调研, 竞品与技术现状调研, "find and compare sources", fact-checking a claim, due-diligence background, or a research brief with references (参考文献). Use when the user wants conclusions backed by sources they can check, not a quick answer. Uses the platform web_search and web_fetch only; no paid services. Not for a single arXiv paper lookup (arxiv skill) or contract review.'
metadata:
  version: 1.0.0
  upstream: K-Dense-AI/scientific-agent-skills literature-review (MIT), adapted
---

# Evidence research (证据型调研)

Goal: a conclusion the reader can audit. Every material claim ties to a source you actually opened; uncertainty and gaps are stated, not smoothed over.

## Tools and limits
- Search with `web_search`; read sources with `web_fetch` (set `max_chars`; fetch the page, not just the snippet). Search results and snippets are **leads**, never evidence. No paid databases, no API keys. Paywalled full text (知网, Elsevier…) is not retrievable: use the abstract/landing page and label it "仅摘要".
- Chat has no network from bash: do everything with the web tools. The bundled scripts use only local files, except `verify_citations.py`, which calls public Crossref/doi.org and therefore runs **only in the personal AI** (in chat, check a few DOIs with `web_fetch https://api.crossref.org/works/<doi>` instead).
- Delegation: `task` subagents may search/fetch different sub-questions in parallel and return findings with URLs and quotes; the root agent merges, verifies, writes and publishes.

## Workflow
1. **Frame** the question in one sentence; type (literature / market / policy / technical / fact-check); decision it supports; time window, geography, language (include Chinese and English queries for China-related topics); inclusion/exclusion rules; depth. State them back in two lines; ask only if the answer would change the plan.
2. **Plan sources** (see `references/source-guide.md`): primary first (laws, filings, statistics, standards, original papers, datasets), then high-quality secondary (reviews, reputable media, industry bodies), vendors/blogs last and labelled.
3. **Search broadly, log every query** (query, tool, date, #results scanned, why a result was kept/dropped) in a Markdown ledger `<cwd>/research/<topic>-ledger.md` (template: `assets/ledger-template.md`). Use synonyms, English/Chinese variants, `site:` for authoritative domains, date filters. Follow citation chains (references of a good source, "cited by").
4. **Read and extract:** open each kept source; record title, author/publisher, date, URL, exact supporting quote or number with its context, population/method, and your grade (A primary/robust, B credible secondary, C weak/vendor/opinion). Preprints are not peer-reviewed; marketing figures are claims.
5. **Cross-check** every number/claim that carries the conclusion with a second independent source, or mark it "单一来源". Note conflicts and why they differ (definition, date, scope). Check for retractions/corrections and for stale data.
6. **Synthesize by theme** (not source by source): what is established, what is contested, what is unknown; confidence per conclusion (高/中/低) with the reason; gaps and what would resolve them.
7. **Cite and verify** (`references/citation-guide.md`): every reference has what you actually read; DOI/URL checked (script or fetch); identity checked (title/author/year match); the cited text really supports the sentence. Remove any reference you could not open; never reconstruct a citation from memory.
8. **Deliver:** Markdown report `<cwd>/research/<topic>-report.md` (structure below) published as an artifact (standalone MEDIA line or `artifact publish`); put the ledger beside it. Word/PDF only on request via the documents / pdf-documents skills. Tell the user which parts you could not verify.

## Report structure
结论摘要(3-5 句, 含置信度) → 研究问题与范围 → 方法(来源类型、检索日期、检索式概述、纳入/排除) → 主要发现(按主题, 行内引用 [1]) → 分歧与不确定性 → 结论与建议/可行动项 → 局限 → 参考文献 → 附录(检索台账)。Chinese reports use GB/T 7714 style by default; English ones APA unless told otherwise.

## Rules
- Never fabricate sources, quotes, statistics, author names, DOIs or page numbers; never cite a source you did not open; do not present a search snippet as having read the paper.
- State the search date: web content changes. Prefer the newest authoritative figure, and say the year it refers to.
- Never let citation counts, journal prestige or popularity decide inclusion; recent and negative findings get equal treatment.
- Medical, legal, investment or safety decisions: give the evidence and its limits; say it is not professional advice and who should confirm.
- Confidential user material is not sent to search queries; query with generic terms.
- Systematic-review claims (PRISMA) only if records, screening counts and exclusion reasons were actually tracked; otherwise call it a "narrative / scoping review".

## References
- `references/source-guide.md` – source hierarchy, free Chinese and English sources, query patterns
- `references/citation-guide.md` – citation checks, GB/T 7714 / APA patterns, evidence-grade table
- `assets/ledger-template.md` – search ledger and extraction table
- `scripts/search_databases.py <records.json> --deduplicate --format markdown` – local dedupe/format of collected records (offline)
- `scripts/verify_citations.py <report.md> -o report.json` – DOI registration/metadata check (personal AI only; needs network)
