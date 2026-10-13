# Defense in depth

A single validation at the place you fixed can be bypassed by another code
path, a refactor or a test double. After you have found the root cause of a bug
caused by invalid data, make the bug structurally hard to reintroduce by
checking at each layer the data passes through. Keep this proportional: add the
layers that are cheap and meaningful, not all four by reflex.

1. **Entry point**: reject obviously invalid input at the API boundary (empty,
   wrong type, missing, nonexistent path).
2. **Business logic**: check the data makes sense for this operation
   ("projectDir required for workspace initialisation").
3. **Environment guards**: refuse dangerous operations in specific contexts
   (for example, refuse to run a destructive command outside a temporary
   directory while under test).
4. **Diagnostics**: log enough context (and a stack) at the risky operation so
   the next failure is quick to explain.

Process: trace the data flow, mark every checkpoint, add validation at each
worthwhile one, then test that each layer rejects the bad input on its own (a
test that bypasses layer 1 must still be stopped by layer 2).
