import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { estimateTokens, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { RequestContextUsage } from "../src/context-usage.js";
import { temporaryDirectory, testConfig, TestRunCoordinator as RunCoordinator } from "./helpers.js";

const user = (content: string): AgentMessage => ({ role: "user", content, timestamp: 1 });
function measuredAnswer(tokens: number): AssistantMessage {
  const answer = fauxAssistantMessage("done");
  answer.usage = {
    input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  return answer;
}

for (const envelope of ["system", "tools"] as const) {
  test(`request budget includes large ${envelope} before the first provider measurement`, () => {
    const meter = new RequestContextUsage(envelope === "system" ? "s".repeat(40_000) : "", envelope === "tools" ? [{
      name: "inspect", description: "Inspect evidence", parameters: {
        type: "object", properties: { query: { type: "string", description: "d".repeat(40_000) } },
      },
    }] : []);
    const messages = [user("short")];
    assert.ok(meter.measure(messages, messages, 100_000)!.used_tokens > 10_000);
    assert.equal(meter.measure(messages, messages, 100_000)!.estimated, true);
  });
}

test("only this Run's matching provider prefix replaces the full request estimate", () => {
  const meter = new RequestContextUsage("s".repeat(40_000), []);
  const prompt = user("request");
  const answer = measuredAnswer(32_000);
  meter.beginRequest([prompt]);
  meter.completeResponse(answer);
  const messages = [prompt, answer];
  assert.deepEqual(meter.measure(messages, messages, 128_000), {
    used_tokens: 32_000, max_tokens: 128_000, percent: 25, estimated: false,
  });
  const followUp = user("next");
  const continued = [...messages, followUp];
  assert.equal(meter.measure(continued, continued, 128_000)!.used_tokens, 32_000 + estimateTokens(followUp));
  assert.equal(meter.measure(continued, continued, 128_000)!.estimated, true);
  const restored = new RequestContextUsage("different prompt", []);
  assert.ok(restored.measure(messages, messages, 128_000)!.used_tokens < 100);
  const changed = [user("rewritten prefix"), answer];
  assert.ok(meter.measure(changed, changed, 128_000)!.used_tokens < 11_000);
  assert.equal(answer.usage.totalTokens, 32_000, "durable usage remains audit data");
});

test("compaction invalidates retained usage and zero or abnormal responses remain estimates", () => {
  const meter = new RequestContextUsage("system", []);
  const archived = user("large old history".repeat(4_000));
  const answer = measuredAnswer(90_000);
  meter.beginRequest([archived]);
  meter.completeResponse(answer);
  const compacted = [user("handoff"), answer];
  assert.ok(meter.measure(compacted, compacted, 100_000)!.used_tokens < 100);
  for (const tokens of [0, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const response = measuredAnswer(tokens);
    meter.beginRequest(compacted);
    meter.completeResponse(response);
    const final = [...compacted, response];
    assert.equal(meter.measure(final, final, 100_000)!.estimated, true);
  }
  const failed = measuredAnswer(50_000);
  failed.stopReason = "error";
  meter.beginRequest(compacted);
  meter.completeResponse(failed);
  assert.ok(meter.measure([...compacted, failed], [...compacted, failed], 100_000)!.used_tokens < 100);
});

test("image fallback counts pixels heuristically rather than base64 bytes", () => {
  const meter = new RequestContextUsage("system", []);
  const image = (length: number): AgentMessage[] => [{
    role: "user", content: [{ type: "image", data: "A".repeat(length), mimeType: "image/png" }], timestamp: 1,
  }];
  const small = image(100);
  const large = image(1_000_000);
  assert.equal(meter.measure(small, small, 128_000)!.used_tokens, meter.measure(large, large, 128_000)!.used_tokens);
});

function responseStream(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: structuredClone(message) });
    stream.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
    stream.end(message);
  });
  return stream;
}

test("large system request triggers automatic compaction despite tiny restored usage", async () => {
  const home = await temporaryDirectory("agent-request-system-");
  const workspace = await temporaryDirectory("agent-request-system-workspace-");
  let summaries = 0;
  const streamFn: StreamFn = (_model, context) => {
    if (context.systemPrompt?.startsWith("Create a concise continuation handoff")) {
      summaries += 1;
      return responseStream(measuredAnswer(1));
    }
    return responseStream(measuredAnswer(123));
  };
  const coordinator = new RunCoordinator({ config: testConfig(home, { compactionThreshold: 0.5 }), streamFn });
  try {
    const run = coordinator.createRun({
      scope_key: "private:request-system", lifecycle_id: "life", session_id: "system", workspace,
      system_prompt: "s".repeat(700_000), input: "finish",
      history: [...Array.from({ length: 9 }, () => user("short")), measuredAnswer(1)],
      model: { provider: "openai-codex", id: "gpt-5.5" },
    });
    const completed = await coordinator.wait(run.id);
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(summaries, 1);
    assert.equal(completed.result?.context_usage?.used_tokens, 123);
    assert.equal(completed.result?.context_usage?.estimated, false);
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("post-compaction zero usage measures only the active projection without repeated old-usage triggers", async () => {
  const home = await temporaryDirectory("agent-request-projection-");
  const workspace = await temporaryDirectory("agent-request-projection-workspace-");
  let summaries = 0;
  let turns = 0;
  let expectedUsage = 0;
  const streamFn: StreamFn = (_model, context) => {
    if (context.systemPrompt?.startsWith("Create a concise continuation handoff")) {
      summaries += 1;
      return responseStream(measuredAnswer(0));
    }
    turns += 1;
    const response = measuredAnswer(0);
    if (turns === 1) {
      response.content = [fauxToolCall("todo", { action: "read" })];
      response.stopReason = "toolUse";
    }
    const projected = [...context.messages, response];
    expectedUsage = new RequestContextUsage(context.systemPrompt ?? "", context.tools ?? [])
      .measure(projected, projected, 272_000)!.used_tokens;
    return responseStream(response);
  };
  const coordinator = new RunCoordinator({ config: testConfig(home, { compactionThreshold: 0.5 }), streamFn });
  try {
    const run = coordinator.createRun({
      scope_key: "private:request-projection", lifecycle_id: "life", session_id: "projection", workspace,
      system_prompt: "Inspect once then finish", input: "finish",
      history: [user("archive evidence ".repeat(50_000)), ...Array.from({ length: 8 }, () => user("short")), measuredAnswer(250_000)],
      model: { provider: "openai-codex", id: "gpt-5.5" },
    });
    const completed = await coordinator.wait(run.id);
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(summaries, 1);
    assert.equal(turns, 2);
    assert.equal(completed.result?.context_usage?.used_tokens, expectedUsage);
    assert.equal(completed.result?.context_usage?.estimated, true);
    assert.ok(expectedUsage < 136_000, "archived evidence and tail audit usage are excluded");
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("available tool schemas alone push a short request over the automatic threshold", async () => {
  const home = await temporaryDirectory("agent-request-tools-");
  const workspace = await temporaryDirectory("agent-request-tools-workspace-");
  let threshold = 1;
  let summaries = 0;
  let calibrating = true;
  const history = Array.from({ length: 9 }, () => user("short"));
  const streamFn: StreamFn = (model, context) => {
    if (context.systemPrompt?.startsWith("Create a concise continuation handoff")) {
      summaries += 1;
    } else if (calibrating) {
      const messages = [...history, ...context.messages];
      const withoutTools = new RequestContextUsage(context.systemPrompt ?? "", [])
        .measure(messages, messages, model.contextWindow)!.used_tokens;
      const withTools = new RequestContextUsage(context.systemPrompt ?? "", context.tools ?? [])
        .measure(messages, messages, model.contextWindow)!.used_tokens;
      assert.ok(withTools > withoutTools + 100);
      threshold = (withoutTools + withTools) / 2 / model.contextWindow;
    }
    return responseStream(measuredAnswer(0));
  };
  const calibration = new RunCoordinator({ config: testConfig(home), streamFn });
  let coordinator: RunCoordinator | undefined;
  const request = {
    scope_key: "private:request-tools", lifecycle_id: "life", workspace,
    system_prompt: "Inspect once then finish", input: "finish",
    model: { provider: "openai-codex", id: "gpt-5.5" },
  };
  try {
    const initial = calibration.createRun({ ...request, session_id: "calibration" });
    const calibrated = await calibration.wait(initial.id);
    assert.equal(calibrated.status, "completed", calibrated.error);
    calibrating = false;
    coordinator = new RunCoordinator({ config: testConfig(home, { compactionThreshold: threshold }), streamFn });
    const run = coordinator.createRun({ ...request, session_id: "tools", history });
    const completed = await coordinator.wait(run.id);
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(summaries, 1);
  } finally {
    calibration.shutdown();
    coordinator?.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("each post-compaction provider response establishes a fresh exact usage anchor", async () => {
  const home = await temporaryDirectory("agent-request-fresh-anchor-");
  let summaries = 0;
  let turns = 0;
  const streamFn: StreamFn = (_model, context) => {
    if (context.systemPrompt?.startsWith("Create a concise continuation handoff")) {
      summaries += 1;
      return responseStream(measuredAnswer(9_000));
    }
    turns += 1;
    const response = measuredAnswer(turns === 3 ? 12_345 : 200_000 + turns);
    if (turns < 3) {
      response.content = [fauxToolCall("todo", { action: "read" })];
      response.stopReason = "toolUse";
    }
    return responseStream(response);
  };
  const coordinator = new RunCoordinator({ config: testConfig(home, { compactionThreshold: 0.5 }), streamFn });
  try {
    const run = coordinator.createRun({
      scope_key: "private:request-fresh-anchor", lifecycle_id: "life", session_id: "fresh",
      workspace: "/workspace", system_prompt: "Read the current task state, then answer.", input: "finish",
      history: Array.from({ length: 9 }, () => user("short")),
      model: { provider: "openai-codex", id: "gpt-5.5" },
    });
    const completed = await coordinator.wait(run.id);
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(turns, 3);
    assert.equal(summaries, 2, "each high main-model measurement must trigger a new eligible compaction");
    assert.equal(completed.result?.context_usage?.used_tokens, 12_345);
    assert.equal(completed.result?.context_usage?.estimated, false);
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true, maxRetries: 3 });
  }
});
