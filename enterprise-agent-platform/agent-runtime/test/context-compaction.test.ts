import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { compactContext } from "../src/run-coordinator.js";

test("context compaction keeps a leading multi-tool call paired with its results", () => {
  const messages: AgentMessage[] = [
    user("initial request", 0),
    assistantText("old one", 1),
    assistantText("old two", 2),
    assistantText("old three", 3),
    assistantTools(["call-a", "call-b"], 4),
    toolResult("call-a", 5),
    toolResult("call-b", 6),
    assistantTools(["call-c"], 7),
    toolResult("call-c", 8),
    assistantText("recent one", 9),
    assistantText("recent two", 10),
    assistantText("recent three", 11),
  ];

  const compacted = compactContext(messages);

  assert.equal(compacted[0]?.role, "user");
  assert.equal(compacted[1], messages[4]);
  assertNoOrphanToolResults(compacted);
});

function user(content: string, timestamp: number): AgentMessage {
  return { role: "user", content, timestamp };
}

function assistantText(text: string, timestamp: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.5",
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp,
  };
}

function assistantTools(ids: string[], timestamp: number): AgentMessage {
  return {
    role: "assistant",
    content: ids.map((id) => ({
      type: "toolCall" as const,
      id,
      name: "session",
      arguments: { action: "list" },
    })),
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.5",
    usage: emptyUsage(),
    stopReason: "toolUse",
    timestamp,
  };
}

function toolResult(toolCallId: string, timestamp: number): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "session",
    content: [{ type: "text", text: "ok" }],
    isError: false,
    timestamp,
  };
}

function assertNoOrphanToolResults(messages: AgentMessage[]): void {
  const known = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) if (block.type === "toolCall") known.add(block.id);
    } else if (message.role === "toolResult") {
      assert.ok(known.has(message.toolCallId), `orphan result ${message.toolCallId}`);
    }
  }
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
