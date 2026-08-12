import assert from "node:assert/strict";
import test from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import { withModelStreamRetry } from "../src/model-stream-retry.js";

const model = {
  id: "test-model",
  name: "Test Model",
  api: "openai-responses" as const,
  provider: "openai-codex" as const,
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};
const context = { messages: [] };

function message(stopReason: AssistantMessage["stopReason"], errorMessage?: string, text = ""): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function attempt(events: AssistantMessageEvent[]): ReturnType<StreamFn> {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    for (const event of events) stream.push(event);
  });
  return stream;
}

async function collect(stream: Awaited<ReturnType<StreamFn>>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("retries an invisible overload and only exposes the successful attempt", async () => {
  let calls = 0;
  const overloaded = message("error", "Codex error: Our servers are currently overloaded. Please try again later.");
  const success = message("stop", undefined, "done");
  const source: StreamFn = () => {
    calls += 1;
    return calls === 1
      ? attempt([{ type: "start", partial: overloaded }, { type: "error", reason: "error", error: overloaded }])
      : attempt([
        { type: "start", partial: message("stop") },
        { type: "text_delta", contentIndex: 0, delta: "done", partial: success },
        { type: "done", reason: "stop", message: success },
      ]);
  };
  const retried = withModelStreamRetry(source, { baseDelayMs: 0, random: () => 0.5 });

  const events = await collect(await retried(model, context));

  assert.equal(calls, 2);
  assert.equal(events.filter((event) => event.type === "error").length, 0);
  assert.equal(events.filter((event) => event.type === "start").length, 1);
  assert.equal(events.at(-1)?.type, "done");
});

test("stops after the bounded retry budget", async () => {
  let calls = 0;
  const overloaded = message("error", "service overloaded");
  const source: StreamFn = () => {
    calls += 1;
    return attempt([{ type: "error", reason: "error", error: overloaded }]);
  };
  const retried = withModelStreamRetry(source, {
    maxRetries: 3,
    baseDelayMs: 0,
    random: () => 0.5,
  });

  const events = await collect(await retried(model, context));

  assert.equal(calls, 4);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "error");
});

test("does not retry quota, policy, billing, or authentication failures", async () => {
  for (const errorText of [
    "insufficient_quota",
    "billing limit reached",
    "invalid API key",
    "Request terminated due to content policy",
    "content_policy_violation: server error",
    "safety_filter: service unavailable",
    "Authentication failed: upstream server error",
    "HTTP 403: service unavailable for this account",
    "payment_required: upstream server error",
    "maximum context length exceeded at 128500 tokens",
    "Response terminated because the context window was exceeded",
    "context_length_exceeded",
    "Prompt is too long for this model",
    "Input exceeds maximum of 128000 tokens",
    "Maximum output size is 500 tokens",
    "Response would exceed the output token limit",
  ]) {
    let calls = 0;
    const failed = message("error", errorText);
    const source: StreamFn = () => {
      calls += 1;
      return attempt([{ type: "error", reason: "error", error: failed }]);
    };
    const events = await collect(await withModelStreamRetry(source, { baseDelayMs: 0 })(model, context));
    assert.equal(calls, 1, errorText);
    assert.equal(events.at(-1)?.type, "error", errorText);
  }
});

test("does not retry after a non-empty text delta", async () => {
  let calls = 0;
  const partial = message("error", "service overloaded", "partial");
  const source: StreamFn = () => {
    calls += 1;
    return attempt([
      { type: "text_delta", contentIndex: 0, delta: "partial", partial },
      { type: "error", reason: "error", error: partial },
    ]);
  };

  const events = await collect(await withModelStreamRetry(source, { baseDelayMs: 0 })(model, context));

  assert.equal(calls, 1);
  assert.deepEqual(events.map((event) => event.type), ["text_delta", "error"]);
});

test("does not retry after a tool call becomes visible", async () => {
  let calls = 0;
  const partial = message("error", "service overloaded");
  const source: StreamFn = () => {
    calls += 1;
    return attempt([
      {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { type: "toolCall", id: "call_1", name: "terminal", arguments: {} },
        partial,
      },
      { type: "error", reason: "error", error: partial },
    ]);
  };

  await collect(await withModelStreamRetry(source, { baseDelayMs: 0 })(model, context));
  assert.equal(calls, 1);
});

test("cancelling during backoff prevents another provider request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const overloaded = message("error", "service overloaded");
  const source: StreamFn = () => {
    calls += 1;
    return attempt([{ type: "error", reason: "error", error: overloaded }]);
  };
  const retried = withModelStreamRetry(source, {
    baseDelayMs: 10_000,
    random: () => 0.5,
    onRetry: () => controller.abort(),
  });

  const output = await retried(model, context, { signal: controller.signal });
  const events = await collect(output);
  const result = await output.result();
  assert.equal(calls, 1);
  assert.equal(events.at(-1)?.type, "error");
  assert.equal(result.stopReason, "aborted");
});

test("a throwing custom stream still settles iteration and result", async () => {
  const source: StreamFn = async () => {
    throw new Error("invalid custom adapter");
  };
  const output = await withModelStreamRetry(source, { baseDelayMs: 0 })(model, context);

  const events = await collect(output);
  const result = await output.result();

  assert.equal(events.at(-1)?.type, "error");
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage || "", /terminal event/);
});

test("refreshes activity during retry backoff", async () => {
  let calls = 0;
  let heartbeats = 0;
  const overloaded = message("error", "service overloaded");
  const success = message("stop", undefined, "done");
  const source: StreamFn = () => {
    calls += 1;
    return calls === 1
      ? attempt([{ type: "error", reason: "error", error: overloaded }])
      : attempt([{ type: "done", reason: "stop", message: success }]);
  };

  const output = await withModelStreamRetry(source, {
    baseDelayMs: 20,
    random: () => 0.5,
    activityHeartbeatMs: 2,
    onRetryActivity: () => { heartbeats += 1; },
  })(model, context);
  await collect(output);

  assert.equal(calls, 2);
  assert.ok(heartbeats > 0);
});
