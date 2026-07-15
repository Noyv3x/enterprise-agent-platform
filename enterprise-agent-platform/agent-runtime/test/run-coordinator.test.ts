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
