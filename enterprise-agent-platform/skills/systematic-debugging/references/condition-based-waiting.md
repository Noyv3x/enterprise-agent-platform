# Condition-based waiting

Flaky tests often guess at timing with arbitrary sleeps; they pass on a fast
machine and fail under load or in parallel runs. Wait for the condition you
actually care about instead of a guessed duration.

```text
// Before: guessing
await sleep(50); expect(getResult()).toBeDefined()

// After: waiting for the condition, with a timeout and a clear message
await waitFor(() => getResult() !== undefined, 'result to be set')
```

Generic helper (any language): poll the condition about every 10 ms, **call the
getter inside the loop** so the data is fresh, and fail with a descriptive
message after a timeout (for example 5 s).

| Wait for | Condition |
|---|---|
| an event | `events.find(e => e.type === 'DONE')` |
| a state | `machine.state === 'ready'` |
| a count | `items.length >= 5` |
| a file | `exists(path)` |

Mistakes: polling every millisecond (wasted CPU), no timeout (hangs forever),
caching state before the loop (stale).

An arbitrary delay is correct only when you are testing real timing (debounce,
throttle, a tick interval). Then first wait for the triggering condition, base
the delay on a known interval, and comment why (for example "two 100 ms ticks").
