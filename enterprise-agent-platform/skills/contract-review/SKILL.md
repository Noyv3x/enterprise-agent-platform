---
name: contract-review
description: 'Review a commercial contract or NDA for the user''s side: clause-by-clause risk flags (绿/黄/红), suggested redline wording, negotiation priorities and a business-impact summary, with the governing law stated explicitly (default: PRC / 中国大陆 business context). Use when the user shares a 合同 / 协议 / NDA / 保密协议 / 采购、销售、服务、框架协议 and asks for 审查, 风险, 修改意见, 谈判要点, or a quick screen before signing. Produces decision support for staff and in-house or outside counsel, not legal advice, and does not draft court procedure documents.'
metadata:
  version: 1.0.0
  upstream: anthropics/knowledge-work-plugins legal (Apache-2.0), adapted
---

# Contract review (合同审查)

You support business staff and counsel. You do **not** give legal advice and never replace a licensed lawyer: every output says so, in one plain sentence, and names what needs 律师/法务复核.

## Before reviewing: pin down four things (ask only what is missing; otherwise state assumptions)
1. **Our side** (甲方/乙方 and role: buyer, vendor, licensor, employer…). The same clause favours different parties.
2. **Governing law and forum** actually written in the contract, and the law you review under. Default assumption: 中华人民共和国法律 (大陆), written in Chinese. If the contract is governed by another law (HK, Singapore, England, NY…), or is cross-border, say that your clause-law notes are PRC-based only, review structure/commercial risk generically, and flag that local counsel must confirm. Never apply US/EU positions silently.
3. **Playbook:** the company's standard positions if the user supplied them (file, pasted, or a saved skill). Else say "按通行商业惯例审查,未采用公司标准" and use `references/clause-checklist.md`.
4. **Deadline, deal size, relationship, focus clauses.**

## Workflow
1. **Read the whole contract first** (all attachments, annexes, order forms, referenced terms). Use the documents/PDF skills to extract text; if the file is scanned/unreadable, say so rather than guessing. Note contract type; clauses interact (an uncapped indemnity vs a liability cap).
2. **Clause-by-clause analysis** over the categories in `references/clause-checklist.md` (liability, indemnity/违约责任, IP, data/personal information, confidentiality, term/termination, payment/tax/invoice, delivery/acceptance, dispute resolution, assignment, force majeure, signing formalities…). For each: present / absent / unusual, what it says (quote with clause number), risk colour for **our side**.
3. **Classify:** 🟢 green acceptable; 🟡 yellow negotiate (give redline + fallback + impact of accepting); 🔴 red escalate (specific risk, market alternative, exposure, who must sign off). For quantified risk use severity × likelihood from `references/risk-matrix.md`.
4. **Redlines** for yellow/red: current text (exact quote), proposed wording (in the contract's language, ready to paste), one-line rationale shareable with the counterparty, priority (must / should / nice), fallback.
5. **Law-dependent points:** when a point turns on a statute (e.g. 违约金过高调整, 格式条款, 个人信息出境), name the statute and check the *current* official text with `web_search` / `web_fetch` (国家法律法规数据库 flk.npc.gov.cn, 最高人民法院, 国家网信办). Cite article numbers only when verified in this run; otherwise write "待核实". Laws change; training memory is not a source.
6. **Summary:** overall risk, top 3 issues, negotiation strategy (lead with must-haves, trade nice-to-haves), timeline, next steps, plus the missing-information list.
7. **Deliver:** a Markdown review memo in the working directory (`<cwd>/contract-review-<contract-name>.md`), published as an artifact (standalone MEDIA line or `artifact publish`). If the user wants Word, use the documents skill to produce a `.docx` with the redline table, and say plainly that it is a comment table, not tracked changes in their original file. Never edit the user's original, never "sign", send or approve anything.

## NDA quick screen
For a 保密协议 use the shorter screen in `references/clause-checklist.md` (definition breadth, carve-outs, term, permitted disclosures, residuals, injunction/liquidated damages, non-solicit/non-compete slipped in, governing law). Output: 🟢 sign through normal approval / 🟡 needs 法务 / 🔴 significant issues, with the reasons.

## Output template
```
## 合同审查摘要
文件 | 当事方及角色 | 我方 | 适用法律/争议解决 | 审查依据(公司标准/通行惯例) | 截止时间
## 关键发现(3-5 条, 带颜色)
## 逐条分析
### <条款类别> — 🟢/🟡/🔴
合同约定(第X条原文) / 标准立场 / 偏差 / 业务影响 / 修改建议(原文→建议→理由→优先级→退让方案)
## 谈判策略
## 待确认事项与下一步
## 免责声明: 本分析为辅助判断材料,不构成法律意见,签署前请由律师/法务复核。
```

## Boundaries
- Not legal advice; no guarantee of enforceability or outcomes; do not predict court results.
- Personal data in contracts (names, ID numbers, bank accounts) stays in the workspace; do not paste it into web searches.
- Do not invent facts about the counterparty; verification (工商信息, 资质) needs the user's authorised sources or public registries you actually fetched.
- Contract is not in Chinese/English: offer translation or review in the original language and flag translation risk.
- Very long contracts (50+ pages): offer the material sections first, then the complete pass.
- Litigation/arbitration filings, 律师函, procedure steps are a different job: say it is outside this skill.

## References
- `references/clause-checklist.md` – clause categories with PRC-oriented review points, NDA screen, signing formalities
- `references/risk-matrix.md` – severity × likelihood scoring and escalation criteria
