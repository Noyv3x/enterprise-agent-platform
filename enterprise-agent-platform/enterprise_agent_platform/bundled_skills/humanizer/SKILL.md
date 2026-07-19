---
name: "humanizer"
description: "Use when the user asks to humanize, de-slop, edit, or rewrite prose. Detects formulaic AI patterns, matches a supplied voice sample, improves rhythm and specificity, and preserves facts, citations, intent, and the user's voice."
version: "2.5.1"
category: "writing"
tags: ["writing","editing","voice","prose","humanize","rewrite"]
---

# Humanizer

Edit prose so it sounds like a specific person communicating for a specific
reason—not like a generic template. Preserve meaning, facts, citations,
technical terms, and required tone.

This is an editing workflow, not permission to invent personal experiences,
emotions, sources, quotations, or certainty. Do not help impersonate another
real person or evade an integrity requirement.

## Inputs

Establish:

- audience and purpose;
- desired tone and level of formality;
- text that must remain exact;
- whether the user supplied a genuine voice sample;
- whether the result should be shown inline or applied to a workspace file.

When a voice sample exists, study its sentence length, vocabulary,
punctuation, paragraph openings, transitions, humor, and tolerance for
informality. Match recurring tendencies without copying distinctive phrases.

## Common patterns to remove

### Inflated importance

Replace claims that something is "pivotal," "transformative," "a testament,"
or part of a sweeping trend with the concrete consequence that actually
matters.

### Promotional vagueness

Remove unsupported superlatives, generic praise, and phrases such as
"cutting-edge," "seamless," "robust," or "game-changing." Name the capability,
constraint, or measured result instead.

### Empty analysis

Sentences such as "This highlights the importance of..." often repeat the
previous sentence. State the implication directly or delete the sentence.

### Vague attribution

Do not write "experts say," "observers note," or "research shows" unless a
specific, verified source follows. Preserve real citations; never manufacture
one to make prose sound authoritative.

### Formulaic structure

Watch for:

- every paragraph using the same length and cadence;
- repetitive topic sentence, explanation, takeaway blocks;
- excessive headings for a short piece;
- automatic three-item lists;
- conclusions that merely restate the introduction;
- repeated "Moreover," "Furthermore," "Additionally," or "In conclusion."

Combine or split paragraphs according to the argument, not a template.

### Mechanical contrast

Limit repeated constructions such as "not only X, but Y," "it is not X; it is
Y," and strings of negative parallel clauses. Keep one when it genuinely adds
emphasis.

### Punctuation tics

Use em dashes, colons, parentheses, and fragments deliberately. A page full of
em dashes or identical short fragments is another template. Follow the user's
sample when available.

### Meta and disclaimers

Remove model-centered phrases, generic caveats, and commentary about the act
of writing unless they are necessary to the content. Do not conceal a
disclosure the user is required to make.

## Editing workflow

1. **Read for meaning.** Summarize the claim, audience, and constraints before
   changing wording.
2. **Mark the tells.** Identify repeated rhythms, vague claims, filler,
   unnecessary signposting, and unsupported attribution.
3. **Choose a voice.** Prefer the supplied sample. Otherwise use natural,
   direct prose appropriate to the audience.
4. **Rewrite for specificity.** Replace abstractions with the actual actor,
   action, evidence, constraint, or consequence.
5. **Vary rhythm.** Mix short and longer sentences where the argument calls
   for it. Let paragraph length follow ideas.
6. **Protect truth.** Check every number, name, quote, link, and citation
   against the input. Preserve uncertainty at its real level.
7. **Read once more.** Remove any remaining generic summary sentence or
   unnatural transition. Confirm that the result still means the same thing.

## Workspace files

Read the current file before editing:

```text
read_file({"path":"docs/example.md"})
```

For a localized edit, use an exact replacement:

```text
patch_file({
  "path":"docs/example.md",
  "old_text":"exact current passage",
  "new_text":"revised passage",
  "expected_replacements":1
})
```

Use `write_file` only when the user requested a full-file rewrite and the
complete replacement is understood. Show or summarize the changed passage and
do not silently alter unrelated sections.

## Final checks

- Does it sound appropriate for this author and audience?
- Did the rewrite preserve every factual claim and citation?
- Are opinions grounded in the user's text rather than invented?
- Can any sentence be removed without losing meaning?
- Do sentence and paragraph rhythms vary naturally?
- Are transitions earned rather than automatic?
- Is the result clearer, not merely more casual?

License and source attribution are in `references/NOTICE.md`.
