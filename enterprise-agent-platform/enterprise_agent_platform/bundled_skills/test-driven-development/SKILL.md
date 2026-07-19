---
name: "test-driven-development"
description: "Use when implementing behavior or fixing a reproducible defect where tests are practical. Guides a safe RED-GREEN-REFACTOR loop that preserves user code, verifies the intended failure, makes the smallest fix, and runs the wider suite."
version: "1.1.0"
category: "software-development"
tags: ["testing","tdd","red-green-refactor","regression","quality"]
---

# Test-Driven Development

Use tests to define behavior before expanding implementation. The essential
proof is not that a test passes; it is that the test first failed for the
expected missing or broken behavior, then passed after the smallest relevant
change.

## When to use

- new behavior with a stable, observable interface;
- a bug that can be reproduced deterministically;
- refactoring where current behavior must remain unchanged;
- boundary cases involving parsing, validation, state, or error handling.

Use judgment for generated files, exploratory spikes, visual-only work, or
environments without a feasible harness. Explain the alternative verification
rather than manufacturing a low-value test.

## Preserve existing work

Do not delete an existing implementation merely to recreate a textbook RED
state. In legacy or partially implemented code:

- add a characterization test for behavior that must remain;
- add a focused regression test for the missing or incorrect behavior;
- verify that the new test fails for the intended reason;
- make a localized change that preserves unrelated behavior.

Never discard user changes or rewrite broad areas just to satisfy this
workflow.

## RED

1. Describe one behavior in user-visible or caller-visible terms.
2. Inspect existing tests and conventions.
3. Add the smallest focused test with a descriptive name.
4. Run only that test first.
5. Confirm it fails because the behavior is absent or wrong—not because of a
   syntax error, missing fixture, wrong import, or broken environment.

A passing new test before implementation usually means it does not exercise
the intended gap. Strengthen the assertion or reassess whether work is needed.

## GREEN

1. Implement only what is necessary for the failing behavior.
2. Re-run the focused test and observe it pass.
3. Run adjacent tests that cover the same component or boundary.
4. Avoid opportunistic refactors while the behavior is still unproven.

For bug fixes, keep the regression test. It should fail against the old
behavior and prevent recurrence.

## REFACTOR

Only after green:

- remove duplication;
- improve names and boundaries;
- simplify control flow;
- preserve public behavior;
- run the focused and relevant surrounding suites after each meaningful step.

Do not change behavior and structure simultaneously when separate changes are
possible.

## Test quality

Prefer tests that:

- exercise public behavior instead of implementation details;
- use realistic inputs and explicit assertions;
- cover the important error or boundary path;
- remain deterministic and isolated;
- fail with a useful message.

Use mocks at unstable or expensive boundaries, not as a substitute for testing
the unit's real logic. Do not assert that a mock was called when the outcome is
what matters.

## Delegation

A child agent can independently identify missing cases without receiving edit
authority:

```text
delegate_task({
  "prompt":"Review these requirements and existing tests. Identify the smallest behavior-first test cases and likely edge cases. Do not edit files.",
  "system_prompt":"Act as a test-design reviewer. Focus on observable behavior and deterministic verification."
})
```

The parent remains responsible for reviewing any delegated result and running
the actual verification.

## Completion checklist

- The new or changed behavior has a focused test where practical.
- The test was observed failing for the correct reason.
- The smallest implementation made it pass.
- Relevant existing tests still pass.
- Refactoring did not change behavior.
- The final report names the commands run and any untested risk.

Do not stage, commit, or push unless the user separately requested it.

License and source attribution are in `references/NOTICE.md`.
