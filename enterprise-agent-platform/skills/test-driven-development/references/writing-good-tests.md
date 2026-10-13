# Writing good tests

Load when writing or changing tests, adding mocks, or adding test-only helpers.
Two principles: every test **names the break it catches**, and every test
**exercises the real thing**.

## 1. Name the break

Before writing the body: which production change should make this test fail,
and is that change a bug or a decision? A test earns its place by catching a
wrong branch, a missing side effect, a wrong argument, a boundary case or a
broken contract.

- **Derive expectations independently.** Use literals and hand-checked
  fixtures; table-driven tests with literal expected values are preferred. An
  expectation computed by the code under test passes whatever that code does.
  ```text
  bad : expected = buildQuery(tag); assert buildQuery(tag) == expected
  good: assert buildQuery("urgent") == 'tag:"urgent"'
  ```
- **No change detectors.** If only intentional decisions can fail it (a
  constant's value, exact message wording, private structure), it fires on
  redesign and sleeps through bugs. Test behavior that depends on the
  decision: not `MAX_RETRIES == 5` but "a failing call is retried five times and
  a sixth attempt never happens".
- **Behavior, not text.** Do not assert that a script or config contains a
  line. Run it on controlled input and assert outputs, side effects or exit
  codes.
- **Your code, not the framework.** Test the contract your code makes at its
  boundaries (the route you register, the query you emit, the payload you
  produce). Trivial getters, constants and forwarding earn tests only if they
  validate, normalize, default, derive, enforce or cause side effects.

Gate: cannot name a production change that fails the test → redesign it around
an observable behavior.

## 2. Exercise the real thing

- **A mock earns no assertions.** Asserting a mock exists or was called says
  nothing about the component. Assert the real component's behavior.
- **Mock at the right level.** Learn the real method's side effects first; mock
  the slow or external operation below them and keep what the test depends on
  real. When unsure, run against the real implementation first.
- **Make doubles specific.** When arguments, call counts or ordering are part
  of the contract, assert them; give each branch (success, error, malformed) its
  own fixture so the wrong branch cannot satisfy the expectation.
- **Mirror real data completely.** Partial fake payloads pass while integration
  breaks on an omitted field.
- **Production classes carry production methods only.** Cleanup only tests use
  belongs in test utilities.
- **Prefer real components over elaborate mocks.** When mock setup outgrows the
  test logic, write an integration test instead.

## Mutation check

Before finishing, mentally mutate the code: wrong constant or argument, wrong
branch, missing state change or side effect, empty or default return, missing
validation for zero / empty / unauthorized / malformed input. A mutation no test
catches means unprotected behavior or a tautological test.

## Warning signs

Setup and assertion share one object; the test can fail only through a crash;
it fails on every intentional change but never on accidental breakage; expected
values hidden behind loops or builders; assertions on `*-mock` identifiers;
a method called only from tests; mock setup is more than half the test;
the test exists only for coverage.
