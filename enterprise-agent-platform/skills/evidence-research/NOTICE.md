# Notice

- Origin: https://github.com/K-Dense-AI/scientific-agent-skills (`skills/literature-review`, v1.11; ideas also from `citation-management` and `database-lookup`)
- Upstream revision: `a1043ef544e3a100c28e70a736b6cf32554d0677` (main, cloned 2026-10-13)
- License: MIT, Copyright (c) 2025 K-Dense Inc. The repository's `LICENSE.md` is the only license file; the skill's frontmatter also states "MIT license". Kept verbatim as `LICENSE`.

## Changes made for this platform
- `SKILL.md` rewritten for the platform `web_search` / `web_fetch` tools, with a research ledger, evidence grading and an audit-oriented report structure; broadened from biomedical literature reviews to general business, policy and technical research.
- Removed upstream paid or key-gated paths: Parallel CLI search, OpenRouter AI schematics, Pandoc/XeLaTeX PDF export (`generate_pdf.py`, `generate_schematic*.py` are not included), and PubMed/Google Scholar scrapers.
- `scripts/search_databases.py` is unchanged from upstream (local dedupe/format). `scripts/verify_citations.py` is upstream with the `requests` dependency replaced by a small `urllib` shim (the sandbox image has no `requests`); DOI check needs network, so personal AI only.
- `references/` and `assets/ledger-template.md` are new (Chinese and English sources, GB/T 7714 patterns, PRC-oriented source hierarchy).
