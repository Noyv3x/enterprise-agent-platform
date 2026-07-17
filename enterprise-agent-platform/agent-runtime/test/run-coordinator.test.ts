import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  adaptImageContentForModel,
  RunCoordinator,
  sanitizeToolResultForJournal,
} from "../src/run-coordinator.js";
import { AlwaysApprovalStore } from "../src/persistence.js";
import { temporaryDirectory, testConfig } from "./helpers.js";

test("RunCoordinator pauses a sensitive tool until approval", async () => {
  const home = await temporaryDirectory("agent-coordinator-");
  const workspace = await temporaryDirectory("agent-coordinator-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("terminal", { command: "touch approved.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("finished"),
  ]);
  const config = testConfig(home);
  const coordinator = new RunCoordinator({ config, streamFn: faux.provider.streamSimple });
  try {
    const run = coordinator.createRun({
      scope_key: "scope",
      lifecycle_id: "life",
      session_id: "session",
      workspace,
      system_prompt: "You are ubitech agent.",
      input: "run it",
      model: { provider: "openai-codex", id: "gpt-5.5" },
    });
    const approval = await waitUntil(() => coordinator.getJournal(run.id)?.list().find((event) => event.type === "approval.requested"));
    const approvalId = String(approval.data.approval_id);
    await coordinator.respondApproval(run.id, approvalId, "once");
    const completed = await coordinator.wait(run.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.result?.content, "finished");
    assert.ok(coordinator.getJournal(run.id)?.list().some((event) => event.type === "tool.completed"));
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("unattended scheduled runs reject sensitive tools immediately without requesting approval", async () => {
  const home = await temporaryDirectory("agent-scheduled-no-approval-");
  const workspace = await temporaryDirectory("agent-scheduled-no-approval-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("terminal", { command: "touch should-not-exist.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("The command requires a persistent authorization."),
  ]);
  const coordinator = new RunCoordinator({ config: testConfig(home), streamFn: faux.provider.streamSimple });
  try {
    const run = coordinator.createRun({
      scope_key: "scope",
      lifecycle_id: "life",
      session_id: "scheduled-session",
      workspace,
      system_prompt: "You are ubitech agent.",
      input: "run the scheduled task",
      model: { provider: "openai-codex", id: "gpt-5.5" },
      metadata: {
        trigger: "scheduled",
        unattended: true,
        schedule_id: "7",
        schedule_run_id: "42",
        scheduled_for: "2026-07-16T08:00:00Z",
      },
    });
    const completed = await coordinator.wait(run.id);
    assert.equal(completed.status, "completed");
    const events = coordinator.getJournal(run.id)?.list() ?? [];
    assert.equal(events.some((event) => event.type === "approval.requested"), false);
    const failed = events.find((event) => event.type === "tool.failed");
    assert.ok(failed);
    assert.equal(failed.data.unattended_authorization_required, true);
    assert.match(String(failed.data.reason), /persistent always authorization/);
    await assert.rejects(readFile(`${workspace}/should-not-exist.txt`, "utf8"), { code: "ENOENT" });
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("unattended scheduled runs accept only a persistent always authorization", async () => {
  const home = await temporaryDirectory("agent-scheduled-always-");
  const workspace = await temporaryDirectory("agent-scheduled-always-workspace-");
  new AlwaysApprovalStore(home).grant("scope", "terminal");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("terminal", { command: "touch allowed.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("finished"),
  ]);
  const coordinator = new RunCoordinator({ config: testConfig(home), streamFn: faux.provider.streamSimple });
  try {
    const run = coordinator.createRun({
      scope_key: "scope",
      lifecycle_id: "life",
      session_id: "scheduled-always",
      workspace,
      system_prompt: "You are ubitech agent.",
      input: "run the scheduled task",
      model: { provider: "openai-codex", id: "gpt-5.5" },
      metadata: {
        trigger: "scheduled",
        unattended: true,
        schedule_id: "7",
        schedule_run_id: "43",
        scheduled_for: "2026-07-16T08:05:00Z",
      },
    });
    const completed = await coordinator.wait(run.id);
    assert.equal(completed.status, "completed");
    assert.equal(await readFile(`${workspace}/allowed.txt`, "utf8"), "");
    const events = coordinator.getJournal(run.id)?.list() ?? [];
    assert.equal(events.some((event) => event.type === "approval.requested"), false);
    assert.ok(events.some((event) => event.type === "tool.completed"));
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("persisted session approval does not authorize an unattended scheduled run", async () => {
  const home = await temporaryDirectory("agent-scheduled-session-grant-");
  const workspace = await temporaryDirectory("agent-scheduled-session-grant-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("terminal", { command: "touch session-not-allowed.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("The session grant was insufficient."),
  ]);
  const coordinator = new RunCoordinator({ config: testConfig(home), streamFn: faux.provider.streamSimple });
  const identity = { scope_key: "scope", lifecycle_id: "life", session_id: "scheduled-session-grant" };
  try {
    await coordinator.sessions.appendSessionApproval(identity, "terminal");
    const run = coordinator.createRun({
      ...identity,
      workspace,
      system_prompt: "You are ubitech agent.",
      input: "run the scheduled task",
      model: { provider: "openai-codex", id: "gpt-5.5" },
      metadata: {
        trigger: "scheduled",
        unattended: true,
        schedule_id: "7",
        schedule_run_id: "44",
        scheduled_for: "2026-07-16T08:10:00Z",
      },
    });
    const completed = await coordinator.wait(run.id);
    assert.equal(completed.status, "completed");
    const events = coordinator.getJournal(run.id)?.list() ?? [];
    assert.equal(events.some((event) => event.type === "approval.requested"), false);
    assert.equal(events.find((event) => event.type === "tool.failed")?.data.unattended_authorization_required, true);
    await assert.rejects(readFile(`${workspace}/session-not-allowed.txt`, "utf8"), { code: "ENOENT" });
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("unattended scheduled runs cannot mutate schedules even with an always authorization", async () => {
  const home = await temporaryDirectory("agent-scheduled-mutation-");
  const workspace = await temporaryDirectory("agent-scheduled-mutation-workspace-");
  new AlwaysApprovalStore(home).grant("private:1", "schedule");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("schedule", { action: "pause", arguments: { schedule_id: 7 } }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Scheduled runs cannot alter schedules."),
  ]);
  const coordinator = new RunCoordinator({ config: testConfig(home), streamFn: faux.provider.streamSimple });
  coordinator.gateway.invoke = async () => assert.fail("blocked schedule mutation must not reach the platform gateway");
  try {
    const run = coordinator.createRun({
      scope_key: "private:1",
      lifecycle_id: "life",
      session_id: "scheduled-mutation",
      workspace,
      system_prompt: "You are ubitech agent.",
      input: "pause the schedule",
      model: { provider: "openai-codex", id: "gpt-5.5" },
      metadata: {
        trigger: "scheduled",
        unattended: true,
        schedule_id: "7",
        schedule_run_id: "45",
        scheduled_for: "2026-07-16T08:15:00Z",
      },
    });
    const completed = await coordinator.wait(run.id);
    assert.equal(completed.status, "completed");
    const events = coordinator.getJournal(run.id)?.list() ?? [];
    assert.equal(events.some((event) => event.type === "approval.requested"), false);
    const failed = events.find((event) => event.type === "tool.failed");
    assert.equal(failed?.data.unattended_authorization_required, true);
    assert.match(String(failed?.data.reason), /cannot mutate schedules/);
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("nested delegated unattended blocks reach the scheduled parent journal", async () => {
  const home = await temporaryDirectory("agent-scheduled-delegate-block-");
  const workspace = await temporaryDirectory("agent-scheduled-delegate-block-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("delegate_task", { prompt: "delegate the sensitive command again" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("delegate_task", { prompt: "run the sensitive command" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("terminal", { command: "touch delegated-should-not-exist.txt" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("The delegated command requires persistent authorization."),
    fauxAssistantMessage("The nested delegate could not run the command."),
    fauxAssistantMessage("The scheduled parent is done."),
  ]);
  const coordinator = new RunCoordinator({ config: testConfig(home), streamFn: faux.provider.streamSimple });
  try {
    const run = coordinator.createRun({
      scope_key: "private:1",
      lifecycle_id: "life",
      session_id: "scheduled-delegate",
      workspace,
      system_prompt: "You are ubitech agent.",
      input: "run the scheduled delegated task",
      model: { provider: "openai-codex", id: "gpt-5.5" },
      metadata: {
        trigger: "scheduled",
        unattended: true,
        schedule_id: "7",
        schedule_run_id: "46",
        scheduled_for: "2026-07-16T08:20:00Z",
      },
    });
    const completed = await coordinator.wait(run.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.result?.content, "The scheduled parent is done.");
    const events = coordinator.getJournal(run.id)?.list() ?? [];
    assert.equal(events.some((event) => event.type === "approval.requested"), false);
    const failed = events.find(
      (event) => event.type === "tool.failed" && event.data.unattended_authorization_required === true,
    );
    assert.ok(failed);
    assert.equal(failed.data.tool_name, "terminal");
    assert.equal(typeof failed.data.child_run_id, "string");
    assert.match(String(failed.data.reason), /persistent always authorization/);
    assert.equal("result" in failed.data, false, "delegated forwarding must keep only stable fields");
    await assert.rejects(readFile(`${workspace}/delegated-should-not-exist.txt`, "utf8"), { code: "ENOENT" });
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("interactive schedule mutations use the normal approval flow", async () => {
  const home = await temporaryDirectory("agent-interactive-schedule-");
  const workspace = await temporaryDirectory("agent-interactive-schedule-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("schedule", { action: "delete", arguments: { schedule_id: 7 } }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("The schedule was not deleted."),
  ]);
  const coordinator = new RunCoordinator({ config: testConfig(home), streamFn: faux.provider.streamSimple });
  coordinator.gateway.invoke = async () => assert.fail("denied schedule mutation must not reach the platform gateway");
  try {
    const run = coordinator.createRun({
      scope_key: "private:1",
      lifecycle_id: "life",
      session_id: "interactive-schedule",
      workspace,
      system_prompt: "You are ubitech agent.",
      input: "delete the schedule",
      model: { provider: "openai-codex", id: "gpt-5.5" },
    });
    const approval = await waitUntil(() => coordinator.getJournal(run.id)?.list().find(
      (event) => event.type === "approval.requested",
    ));
    assert.equal(approval.data.tool_name, "schedule");
    await coordinator.respondApproval(run.id, String(approval.data.approval_id), "deny");
    const completed = await coordinator.wait(run.id);
    assert.equal(completed.status, "completed");
    const failed = coordinator.getJournal(run.id)?.list().find((event) => event.type === "tool.failed");
    assert.equal(failed?.data.unattended_authorization_required, undefined);
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("session tool searches the delegated Agent's own durable journal", async () => {
  const home = await temporaryDirectory("agent-session-tool-");
  const workspace = await temporaryDirectory("agent-session-tool-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage("first answer"),
    fauxAssistantMessage(
      fauxToolCall("session", { action: "search", arguments: { query: "unique child note" } }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("journal searched"),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home),
    streamFn: faux.provider.streamSimple,
  });
  const identity = {
    scope_key: "private:1/delegate/child",
    lifecycle_id: "life",
    session_id: "parent:child",
  };
  try {
    const first = coordinator.createRun({
      ...identity,
      workspace,
      system_prompt: "You are ubitech agent.",
      input: "unique child note",
      model: { provider: "openai-codex", id: "gpt-5.5" },
    });
    assert.equal((await coordinator.wait(first.id)).status, "completed");

    const second = coordinator.createRun({
      ...identity,
      workspace,
      system_prompt: "You are ubitech agent.",
      input: "search the current session",
      model: { provider: "openai-codex", id: "gpt-5.5" },
    });
    assert.equal((await coordinator.wait(second.id)).status, "completed");

    const persisted = await coordinator.sessions.load(identity);
    const toolResult = persisted.find((message) => message.role === "toolResult");
    assert.ok(toolResult);
    assert.match(JSON.stringify(toolResult), /unique child note/);
    assert.match(JSON.stringify(toolResult), /private:1\/delegate\/child/);
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("text-only model context keeps browser vision snapshot and explicitly omits pixels", () => {
  const encoded = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
  const messages: AgentMessage[] = [{
    role: "toolResult",
    toolCallId: "browser-call",
    toolName: "browser",
    content: [
      { type: "text", text: "Page snapshot\nbutton [ref=e1] Submit" },
      { type: "image", data: encoded, mimeType: "image/png" },
    ],
    details: { tabId: "tab-1" },
    isError: false,
    timestamp: Date.now(),
  }];

  const adapted = adaptImageContentForModel(messages, false);
  const visible = JSON.stringify(adapted);
  assert.match(visible, /button \[ref=e1\] Submit/);
  assert.match(visible, /does not advertise image input/);
  assert.doesNotMatch(visible, new RegExp(encoded));
  assert.equal(adaptImageContentForModel(messages, true), messages);
  assert.match(JSON.stringify(messages), new RegExp(encoded), "the live Agent result must remain unchanged");
});

test("tool journal sanitization deeply removes image data without mutating the live result", () => {
  const encoded = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
  const liveResult = {
    content: [{ type: "image", data: encoded, mimeType: "image/png" }],
    details: { nested: [{ data: encoded, mimeType: "image/png" }] },
  };

  const sanitized = sanitizeToolResultForJournal(liveResult) as typeof liveResult & {
    content: Array<{ bytes: number; omitted: boolean }>;
    details: { nested: Array<{ bytes: number; omitted: boolean }> };
  };
  assert.equal(sanitized.content[0]?.bytes, 8);
  assert.equal(sanitized.content[0]?.omitted, true);
  assert.equal(sanitized.details.nested[0]?.bytes, 8);
  assert.equal(sanitized.details.nested[0]?.omitted, true);
  assert.doesNotMatch(JSON.stringify(sanitized), new RegExp(encoded));
  assert.equal(liveResult.content[0]?.data, encoded);
  assert.equal(liveResult.details.nested[0]?.data, encoded);
});

test("Spark receives browser vision text fallback while work records omit the live screenshot", async () => {
  const home = await temporaryDirectory("agent-spark-browser-vision-");
  const workspace = await temporaryDirectory("agent-spark-browser-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("browser", { action: "vision", arguments: { question: "What is visible?" } }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("The Submit button is visible from the accessibility snapshot."),
  ]);
  const visionFaux = fauxProvider();
  visionFaux.setResponses([
    fauxAssistantMessage("A blue Submit button is visible in the lower-right portion of the page."),
  ]);
  const contexts: AgentMessage[][] = [];
  const visionCalls: Array<{ model: string; messages: AgentMessage[] }> = [];
  const streamFn: StreamFn = (model, context, options) => {
    contexts.push(structuredClone(context.messages));
    return faux.provider.streamSimple(model, context, options);
  };
  const visionStreamFn: StreamFn = (model, context, options) => {
    visionCalls.push({ model: model.id, messages: structuredClone(context.messages) });
    return visionFaux.provider.streamSimple(model, context, options);
  };
  const coordinator = new RunCoordinator({ config: testConfig(home), streamFn, visionStreamFn });
  const encoded = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
  coordinator.gateway.invoke = async () => ({
    data: {
      tabId: "tab-1",
      url: "https://example.test/",
      snapshot: "Page snapshot\nbutton [ref=e1] Submit",
      question: "What is visible?",
      screenshot: { data: encoded, mimeType: "image/png" },
    },
  });

  try {
    const run = coordinator.createRun({
      scope_key: "scope",
      lifecycle_id: "life",
      session_id: "spark-browser",
      workspace,
      system_prompt: "You are ubitech agent.",
      input: "Inspect the page",
      model: { provider: "openai-codex", id: "gpt-5.3-codex-spark" },
      metadata: { idempotency_key: "spark-vision-once" },
    });
    const completed = await coordinator.wait(run.id);
    assert.equal(completed.status, "completed");
    assert.equal(contexts.length, 2);
    assert.equal(visionCalls.length, 1);
    assert.equal(visionCalls[0]?.model, "gpt-5.4-mini");
    assert.match(JSON.stringify(visionCalls[0]?.messages), new RegExp(encoded), "the companion must receive the live image");
    const secondContext = JSON.stringify(contexts[1]);
    assert.match(secondContext, /button \[ref=e1\] Submit/);
    assert.match(secondContext, /does not advertise image input/);
    assert.match(secondContext, /untrusted_browser_visual_analysis/);
    assert.match(secondContext, /blue Submit button/);
    assert.doesNotMatch(secondContext, new RegExp(encoded));

    const publicResult = JSON.stringify(completed.result);
    assert.doesNotMatch(publicResult, new RegExp(encoded));
    assert.match(publicResult, /Image content omitted from retained run result/);
    assert.equal(completed.result?.content, "The Submit button is visible from the accessibility snapshot.");
    const idempotency = await readFile(`${home}/idempotency/index.json`, "utf8");
    assert.doesNotMatch(idempotency, new RegExp(encoded));

    const toolEvent = coordinator.getJournal(run.id)?.list().find((event) => event.type === "tool.completed");
    assert.ok(toolEvent);
    const eventText = JSON.stringify(toolEvent.data);
    assert.doesNotMatch(eventText, new RegExp(encoded));
    assert.match(eventText, /"mimeType":"image\/png"/);
    assert.match(eventText, /"bytes":8/);
    assert.match(eventText, /"omitted":true/);
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Spark browser vision timeout degrades to snapshot text without failing the run", async () => {
  const home = await temporaryDirectory("agent-spark-browser-timeout-");
  const workspace = await temporaryDirectory("agent-spark-browser-timeout-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("browser", { action: "vision", arguments: { question: "What is visible?" } }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("I used the accessibility snapshot because pixel analysis was unavailable."),
  ]);
  const contexts: AgentMessage[][] = [];
  const streamFn: StreamFn = (model, context, options) => {
    contexts.push(structuredClone(context.messages));
    return faux.provider.streamSimple(model, context, options);
  };
  const visionStreamFn: StreamFn = async (_model, _context, options) => await new Promise((_, reject) => {
    options?.signal?.addEventListener("abort", () => reject(new Error("cancelled auxiliary request")), { once: true });
  });
  const coordinator = new RunCoordinator({
    config: testConfig(home),
    streamFn,
    visionStreamFn,
    visionTimeoutMs: 10,
  });
  const encoded = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
  coordinator.gateway.invoke = async () => ({
    data: {
      snapshot: "Page snapshot\nheading [ref=e1] Status",
      question: "What is visible?",
      screenshot: { data: encoded, mimeType: "image/png" },
    },
  });

  try {
    const run = coordinator.createRun({
      scope_key: "scope",
      lifecycle_id: "life",
      session_id: "spark-browser-timeout",
      workspace,
      system_prompt: "You are ubitech agent.",
      input: "Inspect the page",
      model: { provider: "openai-codex", id: "gpt-5.3-codex-spark" },
    });
    const completed = await coordinator.wait(run.id);
    assert.equal(completed.status, "completed");
    const secondContext = JSON.stringify(contexts[1]);
    assert.match(secondContext, /heading \[ref=e1\] Status/);
    assert.match(secondContext, /auxiliary analysis timed out/);
    assert.match(secondContext, /do not imply that pixels were inspected/);
    assert.doesNotMatch(secondContext, new RegExp(encoded));
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

async function waitUntil<T>(read: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}
