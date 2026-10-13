---
name: "one-three-one-rule"
description: "Use when the user asks for options, a \"1-3-1\" proposal, or help choosing between approaches: a business decision (vendor, pricing, hiring, rollout, budget, policy) or a technical one. Produces one problem, three genuinely different options with trade-offs, and one recommendation, sized to the decision. 给我几个方案并推荐一个、方案选型、决策建议。"
license: MIT
metadata:
  version: "2.0.0"
  category: "communication"
  tags: "decision-making,trade-offs,proposal,communication,business,planning"
---

# 1-3-1 decision proposal

Turn an ambiguous choice into a short, forwardable proposal: **1** problem,
**3** options, **1** recommendation. It works for business decisions as well
as technical ones.

Do not force it on a question with one obvious answer, on active debugging, or
when the user has already chosen an approach (then help execute it). If the
problem is really several decisions, split them and say so.

## 1. Problem

One sentence: the decision to make or outcome to reach, plus the constraints
that matter (budget, deadline, headcount, compliance, existing systems, who
decides). Facts you do not have go under **Assumptions**; ask only if the
answer would flip the recommendation.

## 3. Options

Three genuinely different, viable options (A, B, C), commonly spread across
the spectrum such as do-little / balanced / go-big, buy / build / partner, or
now / phased / later. For each, give in one or two lines:

- what it is;
- main advantages;
- main costs or risks, with **cost, time and effort figures only when the user
  or a source supplied them**; otherwise a relative statement and what would
  need measuring (never invent prices, percentages or timelines);
- when it is the right choice.

Do not invent a token option to reach three. If fewer than three are viable,
say so and explain. "Do nothing" counts as an option only when it is real.
Be fair to the option you will not recommend.

## 1. Recommendation

Pick one option, tie it to the user's stated priorities and constraints, and
name the decisive trade-off you are accepting. Then add, **proportionally**:

- **Next steps** (2–5 bullets: who does what first). For a quick choice stop
  here.
- **Success check**: how you will know it worked (a metric or observable
  outcome). Include for decisions that cost real money, time or reputation.
- **Risks to watch and what would change the recommendation**.
- A fuller implementation outline only if the user asked for one; otherwise
  offer to write it (the `plan` skill) afterwards.

Size the whole answer to the stakes: a routine choice is a screenful; a large
decision may use a short table of options and a second page of supporting
detail. Lead with the recommendation if the reader is an executive who will
read only the top.

## Template

```markdown
**问题 / Problem:** <one sentence>  (约束: …  假设: …)

**方案 A — <name>**:做法 · 优点 · 代价/风险 · 适用条件
**方案 B — <name>**: …
**方案 C — <name>**: …

**建议 / Recommendation:** 方案 <X>,因为 … 取舍:我们接受 …
**下一步**: 1. … 2. …
**验收标准**: …
```

Answer in the user's language. Chinese example: *问题:第三季度前是否把客户支持外包?* 方案 A 保持自建;B 只外包夜班;C 全部外包。推荐 B,因为夜班人力最难招;夜班工单占比用户没给,所以写"待核对夜班工单占比",不编数字。

## Check before sending

- One problem, not a bundle.
- Three distinct viable options, or an explicit explanation why not.
- Pros and cons specific to this user's context; no invented figures.
- One clear recommendation; next steps and success check match it.
- Assumptions are visible. If the user picks another option, update the
  recommendation, next steps and success check accordingly.
- If the proposal will be forwarded or is long, save it as a Markdown or
  document file in the run's working directory and publish it per the platform
  delivery rules; revise the same path for changes.

Attribution and licence: `references/NOTICE.md`.
