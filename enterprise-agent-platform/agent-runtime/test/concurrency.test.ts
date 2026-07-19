import assert from "node:assert/strict";
import { access, readdir, rm } from "node:fs/promises";
import test from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { RunCoordinator } from "../src/run-coordinator.js";
import type { RunRequest } from "../src/types.js";
import { temporaryDirectory, testConfig } from "./helpers.js";

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
  const coordinator = new RunCoordinator({
    config: testConfig(home, { maxConcurrency: 1 }),
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

test("a delegated child that needs review forces the parent to needs_review", async () => {
  const home = await temporaryDirectory("agent-delegation-review-");
  const workspace = await temporaryDirectory("agent-delegation-review-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("delegate_task", { prompt: "child side effect" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("terminal", { command: "touch child-marker && stat child-marker" }), { stopReason: "toolUse" }),
    async () => { throw new Error("child provider failed"); },
    fauxAssistantMessage("parent tried to recover"),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { maxConcurrency: 1 }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const parent = coordinator.createRun(request(workspace, "delegate side effect"));
    await waitUntil(() => Boolean(
      coordinator.getJournal(parent.id)?.list().some((event) => event.type === "approval.requested"),
    ));
    const approval = coordinator.getJournal(parent.id)?.list().find((event) => event.type === "approval.requested");
    assert.equal(approval?.data.session_id, parent.request.session_id);
    await coordinator.respondApproval(parent.id, String(approval?.data.approval_id), "session");
    const completed = await withDeadline(coordinator.wait(parent.id));
    assert.equal(completed.status, "needs_review");
    assert.equal(completed.sideEffectsStarted, true);
    assert.match(completed.error || "", /child provider failed/);
    await access(`${workspace}/child-marker`);
    assert.equal(await coordinator.sessions.hasSessionApproval({
      scope_key: parent.request.scope_key,
      lifecycle_id: parent.request.lifecycle_id,
      session_id: parent.request.session_id,
    }, "terminal"), true);
    assert.ok(coordinator.getJournal(parent.id)?.list().some((event) => event.type === "delegation.failed"));
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

function request(workspace: string, input: string): RunRequest {
  return {
    scope_key: `scope:${input}`,
    lifecycle_id: `life:${input}`,
    session_id: `session:${input}`,
    workspace,
    system_prompt: "You are ubitech agent.",
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
