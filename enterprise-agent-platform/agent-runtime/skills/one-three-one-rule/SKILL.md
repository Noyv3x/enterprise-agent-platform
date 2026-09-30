---
name: "one-three-one-rule"
description: "Use when the user asks for options, a 1-3-1 proposal, or help choosing technical approaches. Produces one problem, exactly three viable options with trade-offs, and one recommendation with success criteria and an implementation outline."
version: "1.0.0"
category: "communication"
tags: ["decision-making","trade-offs","proposal","communication","planning"]
---

# 1-3-1 Communication Rule

Use this format to turn an ambiguous technical choice into a concise,
forwardable decision proposal.

Do not force it onto simple questions with one obvious answer, active
debugging, or a task where the user has already chosen an approach.

## 1 — Problem

State one decision or desired outcome in one sentence. Describe what must be
resolved and the constraints that matter. Avoid combining separate decisions
with "and."

## 3 — Options

Provide exactly three genuinely different, viable approaches labeled A, B,
and C. For each:

- describe the approach in one or two sentences;
- give the most important advantages;
- give the most important costs or risks;
- note a condition that would make it the right choice.

Do not create token alternatives merely to reach three. If fewer than three
options are viable, say so and explain why instead of inventing one.

## 1 — Recommendation

Choose one option and explain why it best fits the user's stated priorities,
constraints, and current system. Be direct while acknowledging the decisive
trade-off.

Then add:

### Definition of done

List concrete, verifiable outcomes for the recommended option.

### Implementation outline

List the ordered high-level steps needed to execute it. Keep this proportional
unless the user also requested a detailed implementation plan.

## Output template

```markdown
**Problem:** <one sentence>

**Option A — <name>**
- Approach:
- Pros:
- Cons:
- Best when:

**Option B — <name>**
...

**Option C — <name>**
...

**Recommendation:** Option <X>, because ...

**Definition of done**
- ...

**Implementation outline**
1. ...
```

## Verification

- There is one problem, not a bundle of unrelated concerns.
- There are exactly three viable and distinct options, unless infeasibility is
  explicitly explained.
- Pros and cons are specific to the user's context.
- One recommendation is selected.
- Definition of done and implementation outline match that recommendation.
- If the user chooses another option, update both sections accordingly.

License and source attribution are in `references/NOTICE.md`.
