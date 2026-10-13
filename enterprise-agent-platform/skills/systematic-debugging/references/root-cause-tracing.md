# Root-cause tracing

Bugs usually surface deep in the call stack: a file created in the wrong
directory, a database opened with the wrong path, a request sent with an empty
field. Fixing where the error appears treats a symptom. Trace backward until
you find the original trigger, then fix there.

## Procedure

1. **Observe** the exact symptom (message, path, value).
2. **Find the immediate cause**: the line that directly produces it.
3. **Ask what called it**, and with which values. Write the chain down:
   `createWorktree(dir) ← Session.init() ← Session.create() ← test setup`.
4. **Keep going up** while the value is already wrong at each level.
   Example: an empty string passed as `cwd` resolves to the process working
   directory, so a command ran in the source tree.
5. **Find where the bad value was first created** (an uninitialised variable, a
   default, a parse, a config lookup, a test fixture used before setup).
6. **Fix at that source.** Then consider validating at the other layers
   (`defense-in-depth.md`) so the same class of bug cannot return.

## When you cannot trace by reading

Add temporary instrumentation *before* the dangerous operation, not after it
fails, and include the context that distinguishes callers:

```text
console.error('DEBUG op', { directory, cwd: process.cwd(), stack: new Error().stack })
```

In tests use stderr rather than a logger that may be suppressed. Run once,
filter the output, and read the stacks: which test file, which line, same
parameter each time? Remove the instrumentation when done.

## Finding which test pollutes shared state

If an artifact (a file, a row, a global) appears during the suite but you do
not know which test makes it, bisect: run the tests one at a time (or in halves)
and check for the artifact after each run; stop at the first test that creates
it. Run this in a temporary copy or a temporary directory so you do not touch
the user's working tree, and delete the artifact before the next run.

## Stack trace tips

- Log before the operation, include directory, environment, timestamps.
- `new Error().stack` shows the full call chain.
- Same parameter across failures points to the caller; same caller with
  different parameters points to the data.
