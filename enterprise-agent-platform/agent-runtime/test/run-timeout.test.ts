import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { RunRequest } from "../src/types.js";
import {
  fakeExecutionManager,
  temporaryDirectory,
  testConfig,
  TestRunCoordinator as RunCoordinator,
} from "./helpers.js";

/** Wide enough that CI scheduling between model/tool turns is not the product idle. */
const SURVIVES_SCHEDULER_IDLE_MS = 400;

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

test("model retry backoff heartbeats keep a short-idle run active", async () => {
  const home = await temporaryDirectory("agent-model-retry-idle-");
  const workspace = await temporaryDirectory("agent-model-retry-idle-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "Codex error: Our servers are currently overloaded. Please try again later.",
    }),
    fauxAssistantMessage("recovered after retry backoff"),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { runIdleTimeoutMs: 100 }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const started = Date.now();
    const run = coordinator.createRun(baseRequest(workspace));
    const completed = await withDeadline(coordinator.wait(run.id), 4_000);
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(completed.result?.content, "recovered after retry backoff");
    assert.equal(faux.state.callCount, 2);
    assert.ok(Date.now() - started >= 700, "the provider retry should outlive the idle window");
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

test("cancelling a run during model retry backoff settles without cleanup timeout", async () => {
  const home = await temporaryDirectory("agent-model-retry-cancel-");
  const workspace = await temporaryDirectory("agent-model-retry-cancel-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "Codex error: Our servers are currently overloaded. Please try again later.",
    }),
    fauxAssistantMessage("must not be requested"),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { runIdleTimeoutMs: 5_000, cleanupGraceMs: 500 }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const run = coordinator.createRun(baseRequest(workspace));
    await waitUntil(() => faux.state.callCount === 1 ? true : undefined);
    await delay(25);
    coordinator.cancel(run.id);
    const completed = await withDeadline(coordinator.wait(run.id), 2_000);
    assert.equal(completed.status, "cancelled", completed.error);
    assert.equal(faux.state.callCount, 1);
    assert.equal(
      coordinator.getJournal(run.id)?.list().some((event) => event.type === "run.cleanup_timeout"),
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
      command: "sleep 0.80; printf finished",
      timeout_ms: 2_000,
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage("terminal complete"),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { runIdleTimeoutMs: SURVIVES_SCHEDULER_IDLE_MS }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const started = Date.now();
    const run = coordinator.createRun(baseRequest(workspace));
    await waitUntil(() => coordinator.getJournal(run.id)?.list().find(
      (event) => event.type === "tool.started" && event.data.tool_name === "terminal",
    ), 10_000);
    blockEventLoop(100);
    const completed = await withDeadline(coordinator.wait(run.id));
    assert.equal(completed.status, "completed");
    assert.equal(completed.result?.content, "terminal complete");
    assert.ok(Date.now() - started >= SURVIVES_SCHEDULER_IDLE_MS, "the run should outlive the configured idle window while active");
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

test("process wait pauses the run idle guard for its full observation lifecycle", async () => {
  const home = await temporaryDirectory("agent-active-process-wait-");
  const workspace = await temporaryDirectory("agent-active-process-wait-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("terminal", {
      command: "sleep 0.20; printf finished",
      background: true,
    }), { stopReason: "toolUse" }),
    (context) => {
      const match = /Process started: (process_[a-z0-9]+)/i.exec(JSON.stringify(context.messages));
      assert.ok(match?.[1]);
      return fauxAssistantMessage(fauxToolCall("process", {
        action: "wait",
        process_id: match[1],
        timeout_ms: 1_000,
      }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage("background task complete"),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { runIdleTimeoutMs: SURVIVES_SCHEDULER_IDLE_MS }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const started = Date.now();
    const run = coordinator.createRun(baseRequest(workspace));
    const completed = await withDeadline(coordinator.wait(run.id));
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(completed.result?.content, "background task complete");
    assert.ok(Date.now() - started >= 150, "the process wait should outlive the previous 50 ms idle window");
    assert.equal(
      coordinator.getJournal(run.id)?.list().some((event) => event.type === "run.idle_timeout"),
      false,
    );
    const waitEvent = coordinator.getJournal(run.id)?.list().find(
      (event) => event.type === "tool.completed" && event.data.tool_name === "process",
    );
    assert.match(JSON.stringify(waitEvent?.data.result), /wait_timed_out/);
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
    executor: fakeExecutionManager({
      async terminal(_context, arguments_) {
        assert.equal(arguments_.timeout_ms, 100);
        throw new Error("Terminal command timed out after 100 ms");
      },
    }),
  });
  try {
    const run = coordinator.createRun(baseRequest(workspace));
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
    config: testConfig(home, { runIdleTimeoutMs: SURVIVES_SCHEDULER_IDLE_MS }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const run = coordinator.createRun(baseRequest(workspace));
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
    fauxAssistantMessage(fauxToolCall("terminal", {
      command: "printf approved",
      target: "host",
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage("approved complete"),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { runIdleTimeoutMs: 2_000, approvalTimeoutMs: 10_000 }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const run = coordinator.createRun(baseRequest(workspace));
    const approval = await waitUntil(() => coordinator.getJournal(run.id)?.list().find(
      (event) => event.type === "approval.requested",
    ), 10_000);
    await delay(3_000);
    assert.equal(coordinator.getRun(run.id)?.status, "running");
    assert.equal(
      coordinator.getJournal(run.id)?.list().some((event) => event.type === "run.idle_timeout"),
      false,
    );
    await coordinator.respondApproval(run.id, String(approval.data.approval_id), "once");
    const completed = await withDeadline(coordinator.wait(run.id), 10_000);
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
      target: "host",
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage("child complete"),
    fauxAssistantMessage(fauxToolCall("terminal", {
      command: "printf parent-verified && npm --version >/dev/null # npm run check",
      timeout_ms: 1_000,
      target: "host",
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage("parent complete"),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, {
      runIdleTimeoutMs: 2_000,
      approvalTimeoutMs: 10_000,
      maxConcurrency: 1,
    }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const parent = coordinator.createRun(baseRequest(workspace));
    const approval = await waitUntil(() => coordinator.getJournal(parent.id)?.list().find(
      (event) => event.type === "approval.requested",
    ), 10_000);
    await delay(3_000);
    assert.equal(coordinator.getRun(parent.id)?.status, "running");
    assert.equal(
      coordinator.getJournal(parent.id)?.list().some((event) => event.type === "run.idle_timeout"),
      false,
    );
    await coordinator.respondApproval(parent.id, String(approval.data.approval_id), "once");
    const parentVerificationApproval = await waitUntil(() => {
      const requests = coordinator.getJournal(parent.id)?.list().filter(
        (event) => event.type === "approval.requested",
      ) ?? [];
      return requests.length >= 2 ? requests.at(-1) : undefined;
    }, 10_000);
    await coordinator.respondApproval(
      parent.id,
      String(parentVerificationApproval?.data.approval_id),
      "once",
    );
    const completed = await withDeadline(coordinator.wait(parent.id), 10_000);
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
    config: testConfig(home, { runIdleTimeoutMs: SURVIVES_SCHEDULER_IDLE_MS }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const run = coordinator.createRun(baseRequest(workspace));
    const completed = await withDeadline(coordinator.wait(run.id));
    assert.equal(completed.status, "needs_review");
    assert.equal(completed.idleTimedOut, true);
    assert.equal(completed.sideEffectsStarted, true);
    assert.match(completed.error || "", new RegExp(`idle timeout ${SURVIVES_SCHEDULER_IDLE_MS} ms`));
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
  let markProviderStarted: (() => void) | undefined;
  const providerStarted = new Promise<void>((resolve) => {
    markProviderStarted = resolve;
  });
  faux.setResponses([
    async () => {
      markProviderStarted?.();
      return await new Promise<never>(() => undefined);
    },
    fauxAssistantMessage("the next run acquired the released slot"),
  ]);
  const coordinator = new RunCoordinator({
    // Keep the idle window well above shared-runner scheduling jitter. The
    // provider never settles, so the test still proves bounded slot release.
    config: testConfig(home, { runIdleTimeoutMs: 1_000, cleanupGraceMs: 100, maxConcurrency: 1 }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const run = coordinator.createRun(baseRequest(workspace));
    await withDeadline(providerStarted, 10_000);
    const next = coordinator.createRun({
      ...baseRequest(workspace),
      scope_key: "next-scope",
      lifecycle_id: "next-life",
      session_id: "next-session",
    });
    const [completed, nextCompleted] = await withDeadline(Promise.all([
      coordinator.wait(run.id),
      coordinator.wait(next.id),
    ]), 5_000);
    assert.equal(completed.status, "needs_review");
    assert.match(completed.error || "", /cleanup did not settle/);
    assert.ok(coordinator.getJournal(run.id)?.list().some(
      (event) => event.type === "run.cleanup_timeout",
    ));
    assert.equal(nextCompleted.status, "completed");
    assert.equal(nextCompleted.result?.content, "the next run acquired the released slot");
  } finally {
    coordinator.shutdown();
    await rm(home, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 10,
    });
    await rm(workspace, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 10,
    });
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
    config: testConfig(home, { runIdleTimeoutMs: SURVIVES_SCHEDULER_IDLE_MS, cleanupGraceMs: 200 }),
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
    system_prompt: "You are an Agent.",
    input: "Complete the task",
    model: { provider: "openai-codex", id: "gpt-5.5" },
  };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function blockEventLoop(milliseconds: number): void {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    // Deliberately simulate a contended CI event loop. The foreground process
    // continues in the operating system while JavaScript timers cannot fire.
  }
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
