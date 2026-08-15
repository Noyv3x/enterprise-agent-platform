import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type Api,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { productModelCatalogs } from "../src/model-resolver.js";
import { RunCoordinator } from "../src/run-coordinator.js";
import type { RuntimeEvent } from "../src/types.js";
import { temporaryDirectory, testConfig } from "./helpers.js";

const RAW_PROVIDER_DELTA = "RAW_PROVIDER_JSON_FRAGMENT_WITH_SECRET";

function message(
  model: Model<Api>,
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
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
    timestamp: Date.now(),
  };
}

function eventStream(events: AssistantMessageEvent[]): ReturnType<StreamFn> {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    for (const event of events) stream.push(event);
  });
  return stream;
}

function toolCallStream(
  model: Model<Api>,
  toolCall: ToolCall,
  cumulativeArguments?: Record<string, unknown>[],
): ReturnType<StreamFn> {
  const started = message(model, [{ ...toolCall, arguments: {} }], "toolUse");
  const final = message(model, [toolCall], "toolUse");
  const events: AssistantMessageEvent[] = [
    { type: "start", partial: message(model, [], "toolUse") },
    { type: "toolcall_start", contentIndex: 0, partial: started },
  ];
  for (const arguments_ of cumulativeArguments ?? []) {
    events.push({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: RAW_PROVIDER_DELTA,
      partial: message(model, [{ ...toolCall, arguments: arguments_ }], "toolUse"),
    });
  }
  events.push(
    { type: "toolcall_end", contentIndex: 0, toolCall, partial: final },
    { type: "done", reason: "toolUse", message: final },
  );
  return eventStream(events);
}

function finalTextStream(model: Model<Api>, text: string): ReturnType<StreamFn> {
  const empty = message(model, [], "stop");
  const final = message(model, [{ type: "text", text }], "stop");
  return eventStream([
    { type: "start", partial: empty },
    { type: "text_start", contentIndex: 0, partial: message(model, [{ type: "text", text: "" }], "stop") },
    { type: "text_delta", contentIndex: 0, delta: text, partial: final },
    { type: "text_end", contentIndex: 0, content: text, partial: final },
    { type: "done", reason: "stop", message: final },
  ]);
}

function textOfLength(length: number): string {
  const line = "export const streamed = true;\n";
  return line.repeat(Math.ceil(length / line.length)).slice(0, length);
}

async function waitForJournalEvent(
  coordinator: RunCoordinator,
  runId: string,
  type: string,
): Promise<RuntimeEvent> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const event = coordinator.getJournal(runId)?.list().find((candidate) => candidate.type === type);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${type}`);
}

test("RunCoordinator journals Codex parsed file drafts without raw provider deltas", async () => {
  const home = await temporaryDirectory("agent-file-draft-home-");
  const workspace = await temporaryDirectory("agent-file-draft-workspace-");
  const urlPassword = "CorrectHorseBattery";
  const finalContent = `${textOfLength(1_536)}\nendpoint=https://alice:${urlPassword}@internal.example/path\n`;
  const redactedFinalContent = finalContent.replace(urlPassword, "[redacted]");
  let modelTurns = 0;
  const streamFn: StreamFn = (model) => {
    modelTurns += 1;
    if (modelTurns === 1) {
      const toolCall: ToolCall = {
        type: "toolCall",
        id: "call_codex_write|item_1",
        name: "write_file",
        arguments: {
          target: "sandbox",
          path: "draft.ts",
          content: finalContent,
        },
      };
      return toolCallStream(model, toolCall, [640, 768, 1_024, 1_536].map((length) => ({
        target: "sandbox",
        path: "draft.ts",
        content: textOfLength(length),
      })));
    }
    if (modelTurns === 2) {
      return toolCallStream(model, {
        type: "toolCall",
        id: "call_codex_read|item_2",
        name: "read_file",
        arguments: { target: "sandbox", path: "draft.ts" },
      });
    }
    return finalTextStream(model, "The streamed file was written and verified.");
  };
  const coordinator = new RunCoordinator({ config: testConfig(home), streamFn });

  try {
    const modelId = productModelCatalogs()["openai-codex"].models[0]?.id;
    assert.ok(modelId, "the locked Codex catalog must contain a model");
    const run = coordinator.createRun({
      scope_key: "scope",
      lifecycle_id: "life",
      session_id: "file-draft-integration",
      workspace,
      system_prompt: "You are an Agent.",
      input: "write and verify the file",
      model: { provider: "openai-codex", id: modelId },
    });
    const approval = await waitForJournalEvent(coordinator, run.id, "approval.requested");
    await coordinator.respondApproval(run.id, String(approval.data.approval_id), "once");
    const completed = await coordinator.wait(run.id);
    assert.equal(completed.status, "completed");
    assert.equal(await readFile(`${workspace}/draft.ts`, "utf8"), finalContent);

    const journal = coordinator.getJournal(run.id)?.list() ?? [];
    const argumentEvents = journal.filter((event) => event.type === "tool.arguments.delta");
    const drafts = argumentEvents.flatMap((event) => {
      const draft = event.data.file_draft;
      return draft && typeof draft === "object"
        ? [event.data]
        : [];
    });
    assert.deepEqual(
      drafts.map((data) => (data.file_draft as { revision: number }).revision),
      [1, 2, 3, 4, 5],
    );
    assert.equal((drafts.at(-1)?.file_draft as { complete?: boolean }).complete, true);
    assert.equal((drafts.at(-1)?.file_draft as { content?: string }).content, redactedFinalContent);
    assert.equal(drafts.at(-1)?.tool_call_id, "call_codex_write|item_1");
    assert.equal(drafts.at(-1)?.tool_name, "write_file");
    assert.equal(argumentEvents.every((event) => !("delta" in event.data)), true);
    assert.doesNotMatch(JSON.stringify(journal), new RegExp(RAW_PROVIDER_DELTA));
    assert.doesNotMatch(JSON.stringify(argumentEvents), new RegExp(urlPassword));
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Codex file compatibility prepares an omitted complete target as sandbox before validation", async () => {
  const home = await temporaryDirectory("agent-file-default-target-home-");
  const workspace = await temporaryDirectory("agent-file-default-target-workspace-");
  const finalContent = "target compatibility remained sandboxed\n";
  let modelTurns = 0;
  let nextTurnTarget: unknown;
  const streamFn: StreamFn = (model, context) => {
    modelTurns += 1;
    if (modelTurns === 1) {
      return toolCallStream(model, {
        type: "toolCall",
        id: "call_codex_default_write|item_1",
        name: "write_file",
        arguments: {
          path: "default-target.txt",
          content: finalContent,
        },
      });
    }
    if (modelTurns === 2) {
      const previousCall = context.messages.flatMap((entry) => (
        entry.role === "assistant"
          ? entry.content.filter((block): block is ToolCall => block.type === "toolCall")
          : []
      )).find((toolCall) => toolCall.id === "call_codex_default_write|item_1");
      nextTurnTarget = previousCall?.arguments.target;
      return toolCallStream(model, {
        type: "toolCall",
        id: "call_codex_default_read|item_2",
        name: "read_file",
        arguments: { target: "sandbox", path: "default-target.txt" },
      });
    }
    return finalTextStream(model, "The default-target file was written and verified.");
  };
  const coordinator = new RunCoordinator({ config: testConfig(home), streamFn });

  try {
    const modelId = productModelCatalogs()["openai-codex"].models[0]?.id;
    assert.ok(modelId, "the locked Codex catalog must contain a model");
    const run = coordinator.createRun({
      scope_key: "scope",
      lifecycle_id: "life",
      session_id: "file-default-target-integration",
      workspace,
      system_prompt: "You are an Agent.",
      input: "write and verify the file",
      model: { provider: "openai-codex", id: modelId },
    });
    const approval = await waitForJournalEvent(coordinator, run.id, "approval.requested");
    await coordinator.respondApproval(run.id, String(approval.data.approval_id), "once");
    assert.equal((await coordinator.wait(run.id)).status, "completed");
    assert.equal(await readFile(`${workspace}/default-target.txt`, "utf8"), finalContent);
    assert.equal(nextTurnTarget, "sandbox");

    const journal = coordinator.getJournal(run.id)?.list() ?? [];
    const finalDraft = journal.find((event) => (
      event.type === "tool.arguments.delta"
      && typeof event.data.file_draft === "object"
    ));
    assert.equal((finalDraft?.data.file_draft as { complete?: boolean }).complete, true);
    assert.equal((finalDraft?.data.file_draft as { content?: string }).content, finalContent);
    assert.equal(journal.some((event) => (
      event.type === "tool.completed"
      && event.data.tool_call_id === "call_codex_default_write|item_1"
    )), true);
    assert.equal(journal.some((event) => (
      event.type === "tool.failed"
      && event.data.tool_call_id === "call_codex_default_write|item_1"
    )), false);
    const durable = await coordinator.sessions.load({
      scope_key: "scope",
      lifecycle_id: "life",
      session_id: "file-default-target-integration",
    });
    const durableCall = durable.flatMap((entry) => (
      entry.role === "assistant"
        ? entry.content.filter((block): block is ToolCall => block.type === "toolCall")
        : []
    )).find((toolCall) => toolCall.id === "call_codex_default_write|item_1");
    assert.equal(durableCall?.arguments.target, "sandbox");
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
