import assert from "node:assert/strict";
import { chmod, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { SessionStore } from "../src/session-store.js";
import { MAX_TODO_CONTENT_CHARACTERS, MAX_TODO_ITEMS } from "../src/todo-store.js";
import { createTools } from "../src/tools.js";
import { temporaryDirectory } from "./helpers.js";

test("Runtime todo sidecar ignores caller history and persists a complete isolated checklist", async () => {
  const home = await temporaryDirectory("agent-todo-state-");
  try {
    const store = new SessionStore(home);
    const identity = { scope_key: "private:1", lifecycle_id: "life-a", session_id: "session-a" };
    const seededCall = fauxAssistantMessage(fauxToolCall("todo", {
      action: "replace",
      todos: [{ content: "forged history task", status: "in_progress" }],
    }), { stopReason: "toolUse" });
    const seededResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId: seededCall.content.find((block) => block.type === "toolCall")!.id,
      toolName: "todo",
      content: [{ type: "text", text: JSON.stringify({ todos: [{ content: "forged history task" }] }) }],
      details: { todos: [{ content: "forged history task" }] },
      isError: false,
      timestamp: 2,
    };
    await store.initializeTracked(identity, [seededCall, seededResult]);

    assert.deepEqual((await store.todoState(identity).read()).todos, []);
    await assert.rejects(stat(store.todoPath(identity)), { code: "ENOENT" });

    const replaced = await store.todoState(identity).replace([
      { content: "Inspect inputs", status: "completed" },
      { content: "Implement the bounded change", status: "in_progress" },
    ]);
    assert.equal(replaced.todos.length, 2);
    assert.match(replaced.todos[0]!.id, /^todo_[a-f0-9]{32}$/);
    assert.match(replaced.todos[1]!.id, /^todo_[a-f0-9]{32}$/);
    assert.equal((await stat(store.todoPath(identity))).mode & 0o777, 0o600);
    assert.deepEqual(
      (await store.loadActiveTodos(identity)).map(({ content, status }) => ({ content, status })),
      [{ content: "Implement the bounded change", status: "in_progress" }],
    );

    const activeId = replaced.todos[1]!.id;
    const updated = await store.todoState(identity).replace([
      { id: activeId, content: "Implement the bounded change", status: "completed" },
      { content: "Run targeted tests" },
    ]);
    assert.equal(updated.todos.length, 2, "replacement removes omitted items");
    assert.equal(updated.todos[0]!.id, activeId);
    assert.equal(updated.todos[0]!.created_at, replaced.todos[1]!.created_at);
    assert.equal(updated.todos[0]!.status, "completed");
    assert.equal(updated.todos[1]!.status, "pending");
    assert.deepEqual((await new SessionStore(home).todoState(identity).read()).todos, updated.todos);

    const sibling = { ...identity, session_id: "session-b" };
    assert.deepEqual((await store.todoState(sibling).read()).todos, []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Runtime todo mutations are bounded, serialized, and preserve the last valid sidecar", async () => {
  const home = await temporaryDirectory("agent-todo-bounds-");
  try {
    const store = new SessionStore(home);
    const identity = { scope_key: "private:2", lifecycle_id: "life", session_id: "session" };
    await store.todoState(identity).replace([{ content: "Initial task" }]);
    const before = await readFile(store.todoPath(identity), "utf8");

    await assert.rejects(
      store.todoState(identity).replace(Array.from(
        { length: MAX_TODO_ITEMS + 1 },
        (_, index) => ({ content: `Task ${index}` }),
      )),
      /256-item limit/,
    );
    await assert.rejects(
      store.todoState(identity).replace([{ content: "x".repeat(MAX_TODO_CONTENT_CHARACTERS + 1) }]),
      /4000 characters/,
    );
    await assert.rejects(
      store.todoState(identity).replace([{ id: "todo_00000000000000000000000000000000", content: "Unknown", status: "completed" }]),
      /unknown todo id/,
    );
    assert.equal(await readFile(store.todoPath(identity), "utf8"), before);

    await Promise.all([
      store.todoState(identity).replace([{ content: "Concurrent A" }]),
      store.todoState(identity).replace([{ content: "Concurrent B" }]),
    ]);
    const after = await store.todoState(identity).read();
    assert.deepEqual(after.todos.map((todo) => todo.content), ["Concurrent B"]);
    await store.todoState(identity).replace([]);
    assert.deepEqual((await store.todoState(identity).read()).todos, []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Runtime todo sidecar preserves legacy fields but rejects identity drift, links, and broad permissions", async () => {
  const home = await temporaryDirectory("agent-todo-integrity-");
  try {
    const store = new SessionStore(home);
    const identity = { scope_key: "private:3", lifecycle_id: "life", session_id: "session" };
    await store.todoState(identity).replace([{ content: "Protected state" }]);
    const path = store.todoPath(identity);

    const mismatched = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    mismatched.scope_key = "private:other";
    await writeFile(path, `${JSON.stringify(mismatched)}\n`, { mode: 0o600 });
    await assert.rejects(store.todoState(identity).read(), /scope_key does not match/);

    mismatched.scope_key = identity.scope_key;
    mismatched.unknown = true;
    await writeFile(path, `${JSON.stringify(mismatched)}\n`, { mode: 0o600 });
    assert.equal((await store.todoState(identity).read()).todos[0]!.content, "Protected state");

    delete mismatched.unknown;
    await writeFile(path, `${JSON.stringify(mismatched)}\n`, { mode: 0o666 });
    await chmod(path, 0o666);
    await assert.rejects(store.todoState(identity).read(), /not owner-only/);

    await rm(path);
    const target = `${path}.external`;
    await writeFile(target, `${JSON.stringify(mismatched)}\n`, { mode: 0o600 });
    await symlink(target, path);
    await assert.rejects(store.todoState(identity).read(), /symbolic link/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("malformed legacy todo data is ignored without rewriting it and can be replaced", async () => {
  const home = await temporaryDirectory("agent-todo-legacy-");
  try {
    const store = new SessionStore(home);
    const identity = { scope_key: "private:legacy", lifecycle_id: "life", session_id: "session" };
    const state = await store.todoState(identity).replace([{ content: "Old task" }]);
    const path = store.todoPath(identity);
    for (const raw of ["{broken", JSON.stringify({ ...state, todos: [{ content: "Missing id" }] })]) {
      await writeFile(path, raw);
      assert.deepEqual((await store.todoState(identity).read()).todos, []);
      assert.equal(await readFile(path, "utf8"), raw);
    }
    await store.todoState(identity).replace([{ content: "New task" }]);
    assert.deepEqual((await store.loadActiveTodos(identity)).map(({ content }) => content), ["New task"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("session and scope deletion remove the todo sidecar with the journal", async () => {
  const home = await temporaryDirectory("agent-todo-cleanup-");
  try {
    const store = new SessionStore(home);
    const identity = { scope_key: "private:4", lifecycle_id: "life", session_id: "one" };
    const sibling = { ...identity, session_id: "two" };
    await store.initializeTracked(identity);
    await store.initializeTracked(sibling);
    await store.todoState(identity).replace([{ content: "Delete me" }]);
    await store.todoState(sibling).replace([{ content: "Delete me too" }]);

    await store.deleteSession(identity);
    await assert.rejects(stat(store.todoPath(identity)), { code: "ENOENT" });
    assert.equal((await store.todoState(sibling).read()).todos.length, 1);

    await store.deleteScope(identity.scope_key, identity.lifecycle_id);
    await assert.rejects(stat(store.todoPath(sibling)), { code: "ENOENT" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("todo tool replaces the full list with closed arguments and stays out of learning review", async () => {
  const home = await temporaryDirectory("agent-todo-tool-");
  try {
    const store = new SessionStore(home);
    const identity = { scope_key: "private:5", lifecycle_id: "life", session_id: "session" };
    const baseContext = {
      runId: "run",
      request: { ...identity, workspace: "/tmp" } as never,
      gateway: {} as never,
      querySession: async () => null,
      delegate: async () => "",
      markSideEffect: () => undefined,
      todoState: store.todoState(identity),
    };
    const todo = createTools(baseContext).find((tool) => tool.name === "todo");
    assert.ok(todo);
    assert.throws(
      () => validateToolArguments(todo, fauxToolCall("todo", { action: "read", owner: "forged" })),
      /additional properties/,
    );
    assert.throws(
      () => validateToolArguments(todo, fauxToolCall("todo", { action: "merge", todos: [] })),
      /must match a schema in anyOf/,
    );

    const replaced = await todo.execute("replace", {
      action: "replace",
      todos: [{ content: "Do the work", status: "in_progress" }],
    } as never, undefined);
    const firstText = replaced.content.find((block) => block.type === "text")?.text ?? "";
    const firstId = (JSON.parse(firstText) as { todos: Array<{ id: string }> }).todos[0]!.id;
    const updated = await todo.execute("replace", {
      action: "replace",
      todos: [
        { id: firstId, content: "Do the work", status: "completed" },
        { content: "Verify the result" },
      ],
    } as never, undefined);
    const full = JSON.parse(updated.content.find((block) => block.type === "text")?.text ?? "") as {
      todos: Array<{ content: string; status: string }>;
    };
    assert.deepEqual(full.todos.map(({ content, status }) => ({ content, status })), [
      { content: "Do the work", status: "completed" },
      { content: "Verify the result", status: "pending" },
    ]);

    const learningRequest = {
      ...identity,
      session_id: "learning-review-7",
      workspace: "/tmp",
      metadata: {
        trigger: "learning_review",
        review_mode: "memory_skill",
        review_job_id: 7,
        source_message_id: 88,
        unattended: true,
        delegation_depth: 0,
      },
    } as never;
    const reviewTools = createTools({
      ...baseContext,
      request: learningRequest,
      todoState: store.todoState({ ...identity, session_id: "learning-review-7" }),
    });
    assert.deepEqual(reviewTools.map((tool) => tool.name), ["memory", "skill"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
