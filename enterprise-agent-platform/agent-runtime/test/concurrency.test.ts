import assert from "node:assert/strict";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { RunRequest } from "../src/types.js";
import { temporaryDirectory, testConfig, TestRunCoordinator as RunCoordinator } from "./helpers.js";

test("RunCoordinator starts top-level runs in FIFO order at the concurrency limit", async () => {
  const home = await temporaryDirectory("agent-concurrency-");
  const workspace = await temporaryDirectory("agent-concurrency-workspace-");
  const faux = fauxProvider();
  const observed: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  faux.setResponses([
    async (context) => {
      observed.push(lastUserText(context));
      await firstGate;
      return fauxAssistantMessage("first complete");
    },
    (context) => {
      observed.push(lastUserText(context));
      return fauxAssistantMessage("second complete");
    },
    (context) => {
      observed.push(lastUserText(context));
      return fauxAssistantMessage("third complete");
    },
  ]);
  const config = testConfig(home, { maxConcurrency: 1 });
  const coordinator = new RunCoordinator({
    config,
    streamFn: faux.provider.streamSimple,
  });
  try {
    const first = coordinator.createRun(request(workspace, "first"));
    const second = coordinator.createRun(request(workspace, "second"));
    const third = coordinator.createRun(request(workspace, "third"));
    await waitUntil(() => faux.state.callCount === 1);
    assert.equal(first.status, "running");
    assert.equal(second.status, "queued");
    assert.equal(third.status, "queued");
    releaseFirst();
    const completed = await withDeadline(Promise.all([
      coordinator.wait(first.id),
      coordinator.wait(second.id),
      coordinator.wait(third.id),
    ]));
    assert.deepEqual(completed.map((run) => run.status), ["completed", "completed", "completed"]);
    assert.deepEqual(observed, ["first", "second", "third"]);
  } finally {
    releaseFirst();
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("cancelling a queued run prevents provider execution and releases the queue", async () => {
  const home = await temporaryDirectory("agent-queued-cancel-");
  const workspace = await temporaryDirectory("agent-queued-cancel-workspace-");
  const faux = fauxProvider();
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  faux.setResponses([
    async () => {
      await firstGate;
      return fauxAssistantMessage("first complete");
    },
    fauxAssistantMessage("cancelled run must not execute"),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { maxConcurrency: 1 }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const first = coordinator.createRun(request(workspace, "first"));
    const cancelled = coordinator.createRun(request(workspace, "cancel me"));
    await waitUntil(() => faux.state.callCount === 1);
    coordinator.cancel(cancelled.id);
    assert.equal((await coordinator.wait(cancelled.id)).status, "cancelled");
    assert.deepEqual(
      coordinator.getJournal(cancelled.id)?.list().map((event) => event.type),
      ["run.queued", "run.cancelled"],
    );
    releaseFirst();
    assert.equal((await withDeadline(coordinator.wait(first.id))).status, "completed");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(faux.state.callCount, 1);
  } finally {
    releaseFirst();
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("RunCoordinator bounds the waiting queue and cancellation releases capacity", async () => {
  const home = await temporaryDirectory("agent-queue-capacity-");
  const workspace = await temporaryDirectory("agent-queue-capacity-workspace-");
  const faux = fauxProvider();
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  faux.setResponses([
    async () => {
      await firstGate;
      return fauxAssistantMessage("first complete");
    },
    fauxAssistantMessage("replacement complete"),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { maxConcurrency: 1, maxQueuedRuns: 1 }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const first = coordinator.createRun(request(workspace, "capacity first"));
    await waitUntil(() => faux.state.callCount === 1);
    const waiting = coordinator.createRun(request(workspace, "capacity waiting"));
    assert.throws(
      () => coordinator.createRun(request(workspace, "capacity rejected")),
      /run queue is full/,
    );
    coordinator.cancel(waiting.id);
    const replacement = coordinator.createRun(request(workspace, "capacity replacement"));
    releaseFirst();
    assert.equal((await withDeadline(coordinator.wait(first.id))).status, "completed");
    assert.equal((await withDeadline(coordinator.wait(replacement.id))).status, "completed");
  } finally {
    releaseFirst();
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a delegated child can complete when top-level concurrency is one", async () => {
  const home = await temporaryDirectory("agent-delegation-concurrency-");
  const workspace = await temporaryDirectory("agent-delegation-concurrency-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("delegate_task", { prompt: "child task" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("child complete"),
    fauxAssistantMessage("parent complete"),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { maxConcurrency: 1 }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const parent = coordinator.createRun(request(workspace, "delegate this"));
    const completed = await withDeadline(coordinator.wait(parent.id));
    assert.equal(completed.status, "completed");
    assert.equal(completed.result?.content, "parent complete");
    assert.equal(faux.state.callCount, 3);
    assert.ok(coordinator.getJournal(parent.id)?.list().some((event) => event.type === "delegation.completed"));
    assert.equal((await readdir(`${home}/sessions`, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory()).length, 1);
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("cancelling a parent batch cancels every active delegated child", async () => {
  const home = await temporaryDirectory("agent-delegation-batch-cancel-");
  const workspace = await temporaryDirectory("agent-delegation-batch-cancel-workspace-");
  const faux = fauxProvider();
  let childrenStarted = 0;
  let childAborts = 0;
  const waitForAbort = async (_context: Context, options: { signal?: AbortSignal } | undefined) => await new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
    childrenStarted += 1;
    const aborted = () => {
      childAborts += 1;
      resolve(fauxAssistantMessage("child observed cancellation"));
    };
    if (options?.signal?.aborted) aborted();
    else options?.signal?.addEventListener("abort", aborted, { once: true });
  });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("delegate_task", {
      tasks: [{ prompt: "first child" }, { prompt: "second child" }],
    }), { stopReason: "toolUse" }),
    waitForAbort,
    waitForAbort,
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { maxConcurrency: 1, maxDelegatesPerRun: 2 }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const parent = coordinator.createRun(request(workspace, "cancel delegated batch"));
    await waitUntil(() => childrenStarted === 2);
    assert.equal(
      coordinator.getJournal(parent.id)?.list().filter((event) => event.type === "delegation.started").length,
      2,
    );
    assert.equal(coordinator.cancel(parent.id)?.id, parent.id);
    const completed = await withDeadline(coordinator.wait(parent.id));
    assert.equal(completed.status, "cancelled");
    await waitUntil(() => childAborts === 2);
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a delegated child that needs review forces the parent to needs_review", async () => {
  const home = await temporaryDirectory("agent-delegation-review-");
  const workspace = await temporaryDirectory("agent-delegation-review-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("delegate_task", { prompt: "child side effect" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("write_file", { path: "child-marker", content: "child\n" }), { stopReason: "toolUse" }),
    async () => { throw new Error("child provider failed"); },
    fauxAssistantMessage("parent tried to recover"),
  ]);
  const config = testConfig(home, { maxConcurrency: 1 });
  const coordinator = new RunCoordinator({
    config,
    streamFn: faux.provider.streamSimple,
  });
  try {
    const parent = coordinator.createRun(request(workspace, "delegate side effect"));
    const completed = await withDeadline(coordinator.wait(parent.id));
    assert.equal(completed.status, "needs_review");
    assert.equal(completed.sideEffectsStarted, true);
    assert.match(completed.error || "", /child provider failed/);
    assert.equal(await readFile(`${workspace}/child-marker`, "utf8"), "child\n");
    assert.ok(coordinator.getJournal(parent.id)?.list().some((event) => event.type === "delegation.failed"));
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a child write cannot be accepted until the parent performs focused verification", async () => {
  const home = await temporaryDirectory("agent-delegation-parent-verify-");
  const workspace = await temporaryDirectory("agent-delegation-parent-verify-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("delegate_task", { prompt: "write child.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("write_file", { path: "child.txt", content: "child\n" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("read_file", { path: "child.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("child done"),
    fauxAssistantMessage("parent done without checking"),
    (context) => {
      assert.match(lastUserText(context), /delegated Agent started side effects/i);
      return fauxAssistantMessage(fauxToolCall("read_file", { path: "child.txt" }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage("parent verified child.txt"),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { maxConcurrency: 1 }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const parent = coordinator.createRun(request(workspace, "verify delegated write"));
    const completed = await withDeadline(coordinator.wait(parent.id));
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(completed.result?.content, "parent verified child.txt");
    assert.equal(await readFile(`${workspace}/child.txt`, "utf8"), "child\n");
    assert.equal(faux.state.callCount, 7);
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a parent that repeatedly skips delegated side-effect verification enters needs_review", async () => {
  const home = await temporaryDirectory("agent-delegation-unverified-");
  const workspace = await temporaryDirectory("agent-delegation-unverified-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("delegate_task", { prompt: "write child.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("write_file", { path: "child.txt", content: "child\n" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("read_file", { path: "child.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("child done"),
    fauxAssistantMessage("parent skipped verification one"),
    fauxAssistantMessage("parent skipped verification two"),
    fauxAssistantMessage("parent skipped verification three"),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { maxConcurrency: 1 }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const parent = coordinator.createRun(request(workspace, "reject unverified delegated write"));
    const completed = await withDeadline(coordinator.wait(parent.id));
    assert.equal(completed.status, "needs_review");
    assert.match(completed.error || "", /delegated Agent started side effects/i);
    assert.ok(faux.state.callCount >= 7);
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a read-only child does not impose a parent verification turn", async () => {
  const home = await temporaryDirectory("agent-delegation-readonly-");
  const workspace = await temporaryDirectory("agent-delegation-readonly-workspace-");
  await writeFile(`${workspace}/source.txt`, "source\n");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("delegate_task", { prompt: "inspect source.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("read_file", { path: "source.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("child read it"),
    fauxAssistantMessage("parent accepted read-only report"),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { maxConcurrency: 1 }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const parent = coordinator.createRun(request(workspace, "delegate readonly"));
    const completed = await withDeadline(coordinator.wait(parent.id));
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(faux.state.callCount, 4);
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("batch delegation requires one parent verification when any child has side effects", async () => {
  const home = await temporaryDirectory("agent-delegation-batch-verify-");
  const workspace = await temporaryDirectory("agent-delegation-batch-verify-workspace-");
  await writeFile(`${workspace}/source.txt`, "source\n");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("delegate_task", {
      tasks: [{ prompt: "read source.txt" }, { prompt: "write batch.txt" }],
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("read_file", { path: "source.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("write_file", { path: "batch.txt", content: "batch\n" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("read child done"),
    fauxAssistantMessage(fauxToolCall("read_file", { path: "batch.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("write child done"),
    fauxAssistantMessage("parent tried direct final"),
    fauxAssistantMessage(fauxToolCall("read_file", { path: "batch.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("parent verified batch"),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { maxConcurrency: 1, maxDelegatesPerRun: 2 }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const parent = coordinator.createRun(request(workspace, "delegate mixed batch"));
    const completed = await withDeadline(coordinator.wait(parent.id));
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(completed.result?.content, "parent verified batch");
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("nested orchestrators share one trusted root delegation budget", async () => {
  const home = await temporaryDirectory("agent-delegation-tree-budget-");
  const workspace = await temporaryDirectory("agent-delegation-tree-budget-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("delegate_task", {
      prompt: "orchestrate two grandchildren",
      role: "orchestrator",
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("delegate_task", {
      tasks: [{ prompt: "grandchild one" }, { prompt: "grandchild two" }],
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage("first grandchild done"),
    fauxAssistantMessage("orchestrator observed root budget refusal"),
    fauxAssistantMessage("root done"),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, {
      maxConcurrency: 1,
      maxDelegationDepth: 2,
      maxDelegatesPerRun: 2,
    }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const parent = coordinator.createRun(request(workspace, "enforce root delegate budget"));
    const completed = await withDeadline(coordinator.wait(parent.id));
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(
      coordinator.getJournal(parent.id)?.list().filter((event) => event.type === "delegation.started").length,
      2,
    );
    assert.ok(coordinator.getJournal(parent.id)?.list().some(
      (event) => event.type === "delegation.completed",
    ));
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("global child admission rejects without waiting and cancellation releases capacity", async () => {
  const home = await temporaryDirectory("agent-delegation-admission-");
  const workspace = await temporaryDirectory("agent-delegation-admission-workspace-");
  const faux = fauxProvider();
  let childStarted = false;
  let childObservedAbort = false;
  const perTaskTurns = new Map<string, number>();
  const rootInput = (context: Context): string => {
    for (const message of context.messages) {
      if (message.role !== "user") continue;
      const text = typeof message.content === "string"
        ? message.content
        : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      if (!text.includes("runtime_execution_review")) return text;
    }
    return lastUserText(context);
  };
  faux.setResponses(Array.from({ length: 20 }, () => async (context: Context, options) => {
    const input = rootInput(context);
    const turn = perTaskTurns.get(input) ?? 0;
    perTaskTurns.set(input, turn + 1);
    if (input === "first admission root" && turn === 0) {
      return fauxAssistantMessage(fauxToolCall("delegate_task", { prompt: "long child" }), { stopReason: "toolUse" });
    }
    if (input === "long child") {
      return await new Promise((resolve) => {
        childStarted = true;
        const onAbort = () => {
          childObservedAbort = true;
          resolve(fauxAssistantMessage("child cancelled"));
        };
        if (options?.signal?.aborted) onAbort();
        else options?.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (input === "second admission root" && turn === 0) {
      return fauxAssistantMessage(fauxToolCall("delegate_task", { prompt: "must be rejected" }), { stopReason: "toolUse" });
    }
    if (input === "replacement admission root" && turn === 0) {
      return fauxAssistantMessage(fauxToolCall("delegate_task", { prompt: "replacement child" }), { stopReason: "toolUse" });
    }
    if (input === "replacement child") return fauxAssistantMessage("replacement child done");
    if (input === "replacement admission root") return fauxAssistantMessage("replacement root done");
    return fauxAssistantMessage("root handled admission refusal");
  }));
  const coordinator = new RunCoordinator({
    config: testConfig(home, { maxConcurrency: 2, maxDelegatesPerRun: 1 }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const first = coordinator.createRun(request(workspace, "first admission root"));
    await waitUntil(() => childStarted);

    const second = coordinator.createRun(request(workspace, "second admission root"));
    const secondCompleted = await withDeadline(coordinator.wait(second.id));
    assert.equal(secondCompleted.status, "completed", secondCompleted.error);
    assert.equal(
      coordinator.getJournal(second.id)?.list().filter((event) => event.type === "delegation.started").length,
      0,
    );

    coordinator.cancel(first.id);
    assert.equal((await withDeadline(coordinator.wait(first.id))).status, "cancelled");
    await waitUntil(() => childObservedAbort);
    await waitUntil(() => Boolean(coordinator.getJournal(first.id)?.list().some(
      (event) => event.type === "delegation.failed",
    )));
    await new Promise((resolve) => setImmediate(resolve));

    const replacement = coordinator.createRun(request(workspace, "replacement admission root"));
    const replacementCompleted = await withDeadline(coordinator.wait(replacement.id));
    assert.equal(replacementCompleted.status, "completed", replacementCompleted.error);
    assert.equal(
      coordinator.getJournal(replacement.id)?.list().filter((event) => event.type === "delegation.started").length,
      1,
    );
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("scope cleanup fences matching runs until destructive cleanup finishes", async () => {
  const home = await temporaryDirectory("agent-cleanup-fence-");
  const workspace = await temporaryDirectory("agent-cleanup-fence-workspace-");
  const faux = fauxProvider();
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  faux.setResponses([
    async () => {
      await firstGate;
      return fauxAssistantMessage("cancelled response");
    },
    fauxAssistantMessage("replacement complete"),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { maxConcurrency: 2 }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const originalRequest = request(workspace, "cleanup target");
    const original = coordinator.createRun(originalRequest);
    await waitUntil(() => faux.state.callCount === 1);

    const cleanup = coordinator.cleanupScope(
      originalRequest.scope_key,
      originalRequest.lifecycle_id,
      true,
    );
    assert.throws(
      () => coordinator.createRun({ ...originalRequest, session_id: "during-cleanup" }),
      /scope cleanup is in progress/,
    );
    assert.throws(
      () => coordinator.createRun({
        ...originalRequest,
        scope_key: `${originalRequest.scope_key}/delegate/manual-child`,
        session_id: "during-cleanup-child",
      }, true),
      /scope cleanup is in progress/,
    );

    releaseFirst();
    assert.equal(await withDeadline(cleanup), 1);
    assert.equal((await coordinator.wait(original.id)).status, "cancelled");

    const replacement = coordinator.createRun({ ...originalRequest, session_id: "after-cleanup" });
    const completed = await withDeadline(coordinator.wait(replacement.id));
    assert.equal(completed.status, "completed");
    assert.equal(completed.result?.content, "replacement complete");
  } finally {
    releaseFirst();
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("manual compaction fences only the exact session while its journal is rewritten", async () => {
  const home = await temporaryDirectory("agent-compaction-fence-");
  const workspace = await temporaryDirectory("agent-compaction-fence-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage("Current objective\n- Preserve compaction fence state."),
    fauxAssistantMessage("other session complete"),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { maxConcurrency: 2 }),
    streamFn: faux.provider.streamSimple,
  });
  let releaseRewrite!: () => void;
  const rewriteGate = new Promise<void>((resolve) => { releaseRewrite = resolve; });
  let enteredRewrite!: () => void;
  const rewriteEntered = new Promise<void>((resolve) => { enteredRewrite = resolve; });
  const target = request(workspace, "compaction target");
  try {
    await coordinator.sessions.initializeTracked(
      {
        scope_key: target.scope_key,
        lifecycle_id: target.lifecycle_id,
        session_id: target.session_id,
      },
      Array.from({ length: 10 }, (_, index) => ({
        role: "user" as const,
        content: `history-${index}`,
        timestamp: index,
      })),
    );
    const originalRewrite = coordinator.sessions.rewriteCompacted.bind(coordinator.sessions);
    coordinator.sessions.rewriteCompacted = async (...args: Parameters<typeof originalRewrite>) => {
      enteredRewrite();
      await rewriteGate;
      return await originalRewrite(...args);
    };

    const compacting = coordinator.compactSession(
      target.scope_key,
      target.lifecycle_id,
      target.session_id,
      target.model,
      target.gateway,
    );
    await rewriteEntered;
    assert.throws(
      () => coordinator.createRun(target),
      /session compaction is in progress/i,
    );

    const otherSession = coordinator.createRun({
      ...target,
      session_id: "other-session",
      input: "other session",
    });
    assert.equal((await withDeadline(coordinator.wait(otherSession.id))).status, "completed");
    releaseRewrite();
    assert.equal((await withDeadline(compacting)).compacted, true);
  } finally {
    releaseRewrite();
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

function request(workspace: string, input: string): RunRequest {
  return {
    scope_key: `scope:${input}`,
    lifecycle_id: `life:${input}`,
    session_id: `session:${input}`,
    workspace,
    system_prompt: "You are an Agent.",
    input,
    model: { provider: "openai-codex", id: "gpt-5.5" },
  };
}

function lastUserText(context: Context): string {
  const message = [...context.messages].reverse().find((candidate) => candidate.role === "user");
  if (!message || message.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

async function waitUntil(read: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (read()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Test deadline exceeded")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
