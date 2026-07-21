import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { RunCoordinator } from "../src/run-coordinator.js";
import type { RunRequest } from "../src/types.js";
import { temporaryDirectory, testConfig } from "./helpers.js";

test("RunCoordinator inactivity timeout cancels a run without side effects", async () => {
  const home = await temporaryDirectory("agent-idle-timeout-");
  const workspace = await temporaryDirectory("agent-idle-timeout-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    async (_context, options) => await new Promise<never>((_resolve, reject) => {
      const signal = options?.signal;
      if (signal?.aborted) {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        return;
      }
      signal?.addEventListener(
        "abort",
        () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        { once: true },
      );
    }),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { runIdleTimeoutMs: 40 }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const run = coordinator.createRun(baseRequest(workspace));
    const completed = await withDeadline(coordinator.wait(run.id));
    assert.equal(completed.status, "cancelled");
    assert.equal(completed.idleTimedOut, true);
    assert.equal(completed.sideEffectsStarted, false);
    assert.match(completed.error || "", /idle timeout 40 ms/);
    assert.deepEqual(
      coordinator.getJournal(run.id)?.list().filter((event) => event.type.startsWith("run.")).map((event) => event.type),
      ["run.queued", "run.started", "run.idle_timeout", "run.cancelled"],
    );
    const timeoutEvent = coordinator.getJournal(run.id)?.list().find((event) => event.type === "run.idle_timeout");
    assert.equal(timeoutEvent?.data.timeout_ms, 40);
    assert.equal(typeof timeoutEvent?.data.last_activity, "string");
    assert.equal(typeof timeoutEvent?.data.last_activity_at, "string");
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("streaming model activity can exceed the run idle duration", async () => {
  const home = await temporaryDirectory("agent-active-model-");
  const workspace = await temporaryDirectory("agent-active-model-workspace-");
  const faux = fauxProvider({
    tokensPerSecond: 20,
    tokenSize: { min: 1, max: 1 },
  });
  const response = "active-model-response-".repeat(8);
  faux.setResponses([fauxAssistantMessage(response)]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { runIdleTimeoutMs: 1_000 }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const started = Date.now();
    const run = coordinator.createRun(baseRequest(workspace));
    const completed = await withDeadline(coordinator.wait(run.id), 5_000);
    assert.equal(completed.status, "completed");
    assert.equal(completed.result?.content, response);
    assert.ok(Date.now() - started >= 1_000, "the streamed response should outlive the idle window");
    assert.equal(
      coordinator.getJournal(run.id)?.list().some((event) => event.type === "run.idle_timeout"),
      false,
    );
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("active foreground terminal work can exceed the run idle duration", async () => {
  const home = await temporaryDirectory("agent-active-terminal-");
  const workspace = await temporaryDirectory("agent-active-terminal-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("terminal", {
      command: "sleep 0.16; printf finished",
      timeout_ms: 1_000,
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage("terminal complete"),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { runIdleTimeoutMs: 50 }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const started = Date.now();
    const run = coordinator.createRun(baseRequest(workspace));
    const approval = await waitUntil(() => coordinator.getJournal(run.id)?.list().find(
      (event) => event.type === "approval.requested",
    ));
    await coordinator.respondApproval(run.id, String(approval.data.approval_id), "once");
    const completed = await withDeadline(coordinator.wait(run.id));
    assert.equal(completed.status, "completed");
    assert.equal(completed.result?.content, "terminal complete");
    assert.ok(Date.now() - started >= 120, "the run should outlive the configured idle window while active");
    assert.equal(
      coordinator.getJournal(run.id)?.list().some((event) => event.type === "run.idle_timeout"),
      false,
    );
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("foreground terminal uses the runtime default deadline when timeout_ms is omitted", async () => {
  const home = await temporaryDirectory("agent-default-terminal-timeout-");
  const workspace = await temporaryDirectory("agent-default-terminal-timeout-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("terminal", { command: "sleep 30" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("reported terminal timeout"),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { runIdleTimeoutMs: 500, terminalTimeoutMs: 100 }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const run = coordinator.createRun(baseRequest(workspace));
    const approval = await waitUntil(() => coordinator.getJournal(run.id)?.list().find(
      (event) => event.type === "approval.requested",
    ));
    await coordinator.respondApproval(run.id, String(approval.data.approval_id), "once");
    const completed = await withDeadline(coordinator.wait(run.id));
    assert.equal(completed.status, "completed");
    assert.equal(completed.result?.content, "reported terminal timeout");
    const failedTool = coordinator.getJournal(run.id)?.list().find((event) => event.type === "tool.failed");
    assert.ok(failedTool);
    assert.match(JSON.stringify(failedTool.data.result), /Terminal command timed out after 100 ms/);
    assert.equal(
      coordinator.getJournal(run.id)?.list().some((event) => event.type === "run.idle_timeout"),
      false,
    );
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("background terminal output does not keep a later hung model turn active", async () => {
  const home = await temporaryDirectory("agent-background-output-idle-");
  const workspace = await temporaryDirectory("agent-background-output-idle-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("terminal", {
      command: "while :; do printf 'tick\\n'; sleep 0.02; done",
      background: true,
    }), { stopReason: "toolUse" }),
    async (_context, options) => await new Promise<never>((_resolve, reject) => {
      options?.signal?.addEventListener(
        "abort",
        () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        { once: true },
      );
    }),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { runIdleTimeoutMs: 80 }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const run = coordinator.createRun(baseRequest(workspace));
    const approval = await waitUntil(() => coordinator.getJournal(run.id)?.list().find(
      (event) => event.type === "approval.requested",
    ));
    await coordinator.respondApproval(run.id, String(approval.data.approval_id), "once");
    const completed = await withDeadline(coordinator.wait(run.id));
    assert.equal(completed.status, "needs_review");
    assert.equal(completed.idleTimedOut, true);
    assert.ok(coordinator.getJournal(run.id)?.list().some(
      (event) => event.type === "run.idle_timeout",
    ));
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("approval waits pause the run inactivity deadline", async () => {
  const home = await temporaryDirectory("agent-approval-idle-");
  const workspace = await temporaryDirectory("agent-approval-idle-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("terminal", { command: "printf approved" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("approved complete"),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { runIdleTimeoutMs: 40, approvalTimeoutMs: 1_000 }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const run = coordinator.createRun(baseRequest(workspace));
    const approval = await waitUntil(() => coordinator.getJournal(run.id)?.list().find(
      (event) => event.type === "approval.requested",
    ));
    await delay(120);
    assert.equal(coordinator.getRun(run.id)?.status, "running");
    assert.equal(
      coordinator.getJournal(run.id)?.list().some((event) => event.type === "run.idle_timeout"),
      false,
    );
    await coordinator.respondApproval(run.id, String(approval.data.approval_id), "once");
    const completed = await withDeadline(coordinator.wait(run.id));
    assert.equal(completed.status, "completed");
    assert.equal(completed.result?.content, "approved complete");
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("delegated child activity refreshes the parent inactivity deadline", async () => {
  const home = await temporaryDirectory("agent-child-activity-");
  const workspace = await temporaryDirectory("agent-child-activity-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("delegate_task", { prompt: "perform slow child work" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("terminal", {
      command: "sleep 0.16; printf child-finished",
      timeout_ms: 1_000,
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage("child complete"),
    fauxAssistantMessage("parent complete"),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { runIdleTimeoutMs: 50, maxConcurrency: 1 }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const parent = coordinator.createRun(baseRequest(workspace));
    const approval = await waitUntil(() => coordinator.getJournal(parent.id)?.list().find(
      (event) => event.type === "approval.requested",
    ));
    await delay(120);
    assert.equal(coordinator.getRun(parent.id)?.status, "running");
    assert.equal(
      coordinator.getJournal(parent.id)?.list().some((event) => event.type === "run.idle_timeout"),
      false,
    );
    await coordinator.respondApproval(parent.id, String(approval.data.approval_id), "once");
    const completed = await withDeadline(coordinator.wait(parent.id));
    assert.equal(completed.status, "completed");
    assert.equal(completed.result?.content, "parent complete");
    assert.equal(
      coordinator.getJournal(parent.id)?.list().some((event) => event.type === "run.idle_timeout"),
      false,
    );
    assert.ok(coordinator.getJournal(parent.id)?.list().some((event) => event.type === "delegation.completed"));
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("inactivity after a completed side effect marks the run needs_review", async () => {
  const home = await temporaryDirectory("agent-side-effect-idle-");
  const workspace = await temporaryDirectory("agent-side-effect-idle-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("terminal", { command: "printf changed" }), { stopReason: "toolUse" }),
    async (_context, options) => await new Promise<never>((_resolve, reject) => {
      options?.signal?.addEventListener(
        "abort",
        () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        { once: true },
      );
    }),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { runIdleTimeoutMs: 60 }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const run = coordinator.createRun(baseRequest(workspace));
    const approval = await waitUntil(() => coordinator.getJournal(run.id)?.list().find(
      (event) => event.type === "approval.requested",
    ));
    await coordinator.respondApproval(run.id, String(approval.data.approval_id), "once");
    const completed = await withDeadline(coordinator.wait(run.id));
    assert.equal(completed.status, "needs_review");
    assert.equal(completed.idleTimedOut, true);
    assert.equal(completed.sideEffectsStarted, true);
    assert.match(completed.error || "", /idle timeout 60 ms/);
    assert.ok(coordinator.getJournal(run.id)?.list().some((event) => event.type === "run.needs_review"));
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("an uncooperative provider cannot hold the run slot past idle cleanup grace", async () => {
  const home = await temporaryDirectory("agent-uncooperative-idle-");
  const workspace = await temporaryDirectory("agent-uncooperative-idle-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    async () => await new Promise<never>(() => undefined),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { runIdleTimeoutMs: 30, cleanupGraceMs: 40 }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const started = Date.now();
    const run = coordinator.createRun(baseRequest(workspace));
    const completed = await withDeadline(coordinator.wait(run.id));
    assert.equal(completed.status, "needs_review");
    assert.ok(Date.now() - started < 500);
    assert.match(completed.error || "", /cleanup did not settle/);
    assert.ok(coordinator.getJournal(run.id)?.list().some(
      (event) => event.type === "run.cleanup_timeout",
    ));
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("external cancellation cannot be reclassified as an idle timeout during cleanup grace", async () => {
  const home = await temporaryDirectory("agent-cancel-idle-race-");
  const workspace = await temporaryDirectory("agent-cancel-idle-race-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    async () => await new Promise<never>(() => undefined),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { runIdleTimeoutMs: 50, cleanupGraceMs: 120 }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const run = coordinator.createRun(baseRequest(workspace));
    await waitUntil(() => faux.state.callCount > 0 ? true : undefined);
    coordinator.cancel(run.id);
    const completed = await withDeadline(coordinator.wait(run.id));
    assert.equal(completed.status, "needs_review");
    assert.equal(completed.idleTimedOut, undefined);
    assert.match(completed.error || "", /^Run cancelled; Agent cleanup did not settle/);
    assert.equal(
      coordinator.getJournal(run.id)?.list().some((event) => event.type === "run.idle_timeout"),
      false,
    );
    assert.ok(coordinator.getJournal(run.id)?.list().some(
      (event) => event.type === "run.cleanup_timeout",
    ));
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("zero disables the run inactivity timeout", async () => {
  const home = await temporaryDirectory("agent-idle-disabled-");
  const workspace = await temporaryDirectory("agent-idle-disabled-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    async () => {
      await delay(80);
      return fauxAssistantMessage("completed without an idle watchdog");
    },
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { runIdleTimeoutMs: 0 }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const run = coordinator.createRun(baseRequest(workspace));
    const completed = await withDeadline(coordinator.wait(run.id));
    assert.equal(completed.status, "completed");
    assert.equal(completed.result?.content, "completed without an idle watchdog");
    assert.equal(
      coordinator.getJournal(run.id)?.list().some((event) => event.type === "run.idle_timeout"),
      false,
    );
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

function baseRequest(workspace: string): RunRequest {
  return {
    scope_key: "scope",
    lifecycle_id: "life",
    session_id: "session",
    workspace,
    system_prompt: "You are ubitech agent.",
    input: "Complete the task",
    model: { provider: "openai-codex", id: "gpt-5.5" },
  };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
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

async function waitUntil<T>(read: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await delay(5);
  }
  throw new Error("Timed out waiting for condition");
}
