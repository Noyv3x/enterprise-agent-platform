---
name: "test-driven-development"
description: "Use when implementing behavior or fixing a reproducible defect where automated tests are practical: new features, bug fixes, refactors that must keep behavior, boundary and error handling. Drives a RED-GREEN-REFACTOR loop that proves each test fails for the right reason, preserves existing and user-written code, and runs the wider suite. 测试驱动开发、先写失败测试、回归测试。"
license: MIT
metadata:
  version: "2.0.0"
  category: "software-development"
  tags: "testing,tdd,red-green-refactor,regression,quality"
---

# Test-Driven Development

The proof is not that a test passes. It is that the test first failed for the
expected missing or broken behavior, then passed after the smallest relevant
change. If you never watched it fail, you do not know it can catch the bug.

## When to use

New behavior with a stable observable interface; a deterministically
reproducible bug; a refactor that must not change behavior; parsing,
validation, state and error boundaries.

Use judgment for generated files, throwaway spikes, configuration, visual-only
work, or environments without a feasible harness: say what verification you
used instead rather than manufacturing a low-value test.

## Preserve existing work

Never delete or rewrite existing or user-written implementation just to
recreate a textbook RED state. When code already exists (or you already wrote
some while exploring):

1. Add a **characterization test** for behavior that must stay.
2. Add a focused **regression test** for the missing or wrong behavior.
3. Verify the new test fails for the intended reason against the current code
   (temporarily bypass the fix in a scratch copy or by toggling the behavior,
   never by destroying work).
4. Make a localized change; keep unrelated behavior.

Never discard user changes, and never rewrite broad areas to satisfy the
ritual. Throwaway exploration code may be discarded, but only code you wrote
yourself in this task.

## RED

1. Describe one behavior in caller-visible terms.
2. Read the existing tests and conventions; reuse their fixtures and style.
3. Before writing the body, name the production change that would make the test
   fail, and confirm that change is a bug, not just a decision
   (`references/writing-good-tests.md`).
4. Write the smallest focused test with a descriptive name; derive expected
   values by hand, not with the code under test.
5. Run only that test. Confirm it **fails** (not errors) with the expected
   message, because the behavior is absent or wrong, not because of a syntax
   error, bad import, missing fixture or broken environment.

A new test that passes immediately does not exercise the gap: strengthen it or
reconsider whether work is needed.

## GREEN

1. Implement only what the failing test needs; no extra options or features.
2. Re-run the focused test and watch it pass.
3. Run adjacent tests, then the project's own test command for the affected
   area. A passing file you wrote is not a passing suite; report any failure you
   see by name, including one you did not cause.
4. Do not refactor opportunistically while behavior is unproven.

For bug fixes keep the regression test.

## REFACTOR

Only when green: remove duplication, improve names and boundaries, simplify
control flow, preserve public behavior, and re-run the tests after each step.
Do not change behavior and structure in the same step when you can separate
them.

## Test quality

- Exercise public behavior, not implementation details.
- Realistic inputs, explicit assertions, the important error or boundary path.
- Deterministic and isolated; wait on conditions, not guessed sleeps.
- Mock only slow, external or unstable boundaries. Never assert on the mock
  itself; keep real what the test depends on.
- Do not test source text, constants or framework mechanics.
- Finish with a mutation check: for each realistic bad change (wrong constant,
  wrong branch, missing side effect, empty return, missing validation) at least
  one test should fail.

Details: `references/writing-good-tests.md`.

## Subagents

Subagents may write tests or implement separate units, but give each its own
files and tell it to run only its focused tests. The parent owns verification:
after subagents land, run the focused tests and the surrounding suite once
yourself and report the real output. Do not run the full suite from several
agents at the same time.

## Completion checklist

- New or changed behavior has a focused test where practical.
- It was observed failing for the right reason, then passing.
- The change was minimal; refactoring kept behavior.
- Relevant existing tests still pass; failures are named.
- The report lists the commands run and any untested risk.

Do not stage, commit or push unless the user separately asked.

Attribution and licence: `references/NOTICE.md`.
