import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { RunCoordinator } from "../src/run-coordinator.js";
import type { RunRequest } from "../src/types.js";
import { temporaryDirectory, testConfig } from "./helpers.js";

test("RunCoordinator hard timeout cancels a run without side effects", async () => {
  const home = await temporaryDirectory("agent-timeout-");
  const workspace = await temporaryDirectory("agent-timeout-workspace-");
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
    config: testConfig(home, { runTimeoutMs: 40 }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const run = coordinator.createRun(baseRequest(workspace));
    const completed = await withDeadline(coordinator.wait(run.id));
    assert.equal(completed.status, "cancelled");
    assert.equal(completed.timedOut, true);
    assert.equal(completed.sideEffectsStarted, false);
    assert.match(completed.error || "", /hard timeout of 40 ms/);
    assert.deepEqual(
      coordinator.getJournal(run.id)?.list().filter((event) => event.type.startsWith("run.")).map((event) => event.type),
      ["run.queued", "run.started", "run.timeout", "run.cancelled"],
    );
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("RunCoordinator hard timeout marks an interrupted host command needs_review", async () => {
  const home = await temporaryDirectory("agent-tool-timeout-");
  const workspace = await temporaryDirectory("agent-tool-timeout-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("terminal", { command: "sleep 30" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("must not complete"),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { runTimeoutMs: 100 }),
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
    assert.equal(completed.timedOut, true);
    assert.equal(completed.sideEffectsStarted, true);
    assert.match(completed.error || "", /hard timeout of 100 ms/);
    assert.ok(faux.state.callCount >= 1);
    const processes = coordinator.processes.list("scope");
    assert.equal(processes.length, 1);
    assert.equal(processes[0]?.status, "cancelled");
    assert.ok(coordinator.getJournal(run.id)?.list().some((event) => event.type === "run.needs_review"));
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("an uncooperative provider cannot hold the run slot past cleanup grace", async () => {
  const home = await temporaryDirectory("agent-uncooperative-timeout-");
  const workspace = await temporaryDirectory("agent-uncooperative-timeout-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    async () => await new Promise<never>(() => undefined),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { runTimeoutMs: 30, cleanupGraceMs: 40 }),
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
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}
