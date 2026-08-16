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
    await store.initialize(identity, [seededCall, seededResult]);

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
    const merged = await store.todoState(identity).merge([
      { id: activeId, status: "completed" },
      { content: "Run targeted tests" },
    ]);
    assert.equal(merged.todos.length, 3);
    assert.equal(merged.todos[1]!.id, activeId, "updates must preserve stable Runtime ids");
    assert.equal(merged.todos[1]!.status, "completed");
    assert.equal(merged.todos[2]!.status, "pending");
    assert.deepEqual((await new SessionStore(home).todoState(identity).read()).todos, merged.todos);

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
    const initial = await store.todoState(identity).replace([{ content: "Initial task" }]);
    const before = await readFile(store.todoPath(identity), "utf8");

    await assert.rejects(
      store.todoState(identity).replace(Array.from(
        { length: MAX_TODO_ITEMS + 1 },
        (_, index) => ({ content: `Task ${index}` }),
      )),
      /256-item limit/,
    );
    await assert.rejects(
      store.todoState(identity).merge([{ content: "x".repeat(MAX_TODO_CONTENT_CHARACTERS + 1) }]),
      /4000 characters/,
    );
    await assert.rejects(
      store.todoState(identity).merge([{ id: "todo_00000000000000000000000000000000", status: "completed" }]),
      /unknown todo id/,
    );
    assert.equal(await readFile(store.todoPath(identity), "utf8"), before);

    await Promise.all([
      store.todoState(identity).merge([{ content: "Concurrent A" }]),
      store.todoState(identity).merge([{ content: "Concurrent B" }]),
    ]);
    const after = await store.todoState(identity).read();
    assert.equal(after.todos.length, 3);
    assert.equal(after.todos[0]!.id, initial.todos[0]!.id);
    assert.deepEqual(new Set(after.todos.map((todo) => todo.content)), new Set([
      "Initial task",
      "Concurrent A",
      "Concurrent B",
    ]));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Runtime todo sidecar rejects identity drift, unknown fields, links, and broad permissions", async () => {
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
    await assert.rejects(store.todoState(identity).read(), /unknown or missing fields/);

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

test("session and scope deletion remove the todo sidecar with the journal", async () => {
  const home = await temporaryDirectory("agent-todo-cleanup-");
  try {
    const store = new SessionStore(home);
    const identity = { scope_key: "private:4", lifecycle_id: "life", session_id: "one" };
    const sibling = { ...identity, session_id: "two" };
    await store.initialize(identity);
    await store.initialize(sibling);
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

test("todo tool has closed read/replace/merge schemas, returns the full list, and stays out of learning review", async () => {
  const home = await temporaryDirectory("agent-todo-tool-");
  try {
    const store = new SessionStore(home);
    const identity = { scope_key: "private:5", lifecycle_id: "life", session_id: "session" };
    const baseContext = {
      runId: "run",
      request: { ...identity, workspace: "/tmp" } as never,
      processes: {} as never,
      gateway: {} as never,
      querySession: async () => null,
      delegate: async () => "",
      markSideEffect: () => undefined,
      todoState: store.todoState(identity),
    };
    const todo = createTools(baseContext).find((tool) => tool.name === "todo");
    assert.ok(todo);
    assert.match(todo.description, /at least three distinct, independently trackable steps/);
    assert.match(todo.description, /multiple separately completable tasks/);
    assert.match(todo.description, /single read\/query\/command or small single-file change when that is the whole request/);
    assert.match(todo.description, /routine inspection, one small change, and its focused verification are one linear task/);
    assert.match(todo.description, /keep only one item in_progress/);
    assert.match(todo.description, /completed immediately after it is actually finished and appropriately verified/);
    assert.match(todo.description, /not a scheduled-task tool, process watcher, durable memory/);
    assert.match(todo.description, /process\.wait/);

    assert.doesNotThrow(() => validateToolArguments(todo, fauxToolCall("todo", { action: "read" })));
    assert.doesNotThrow(() => validateToolArguments(todo, fauxToolCall("todo", {
      action: "replace",
      todos: [{ content: "Do the work", status: "in_progress" }],
    })));
    assert.throws(
      () => validateToolArguments(todo, fauxToolCall("todo", { action: "read", owner: "forged" })),
      /additional properties/,
    );
    assert.throws(
      () => validateToolArguments(todo, fauxToolCall("todo", { action: "append", todos: [] })),
      /must match a schema in anyOf/,
    );

    const replaced = await todo.execute("replace", {
      action: "replace",
      todos: [{ content: "Do the work", status: "in_progress" }],
    } as never, undefined);
    const firstText = replaced.content.find((block) => block.type === "text")?.text ?? "";
    const firstId = (JSON.parse(firstText) as { todos: Array<{ id: string }> }).todos[0]!.id;
    const merged = await todo.execute("merge", {
      action: "merge",
      todos: [
        { id: firstId, status: "completed" },
        { content: "Verify the result" },
      ],
    } as never, undefined);
    const full = JSON.parse(merged.content.find((block) => block.type === "text")?.text ?? "") as {
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
        idempotency_key: "agent-learning-review:7",
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
