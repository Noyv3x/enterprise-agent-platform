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
import { temporaryDirectory, testConfig, TestRunCoordinator as RunCoordinator } from "./helpers.js";

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
  cumulativeArguments?: ToolCall["arguments"][],
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

for (const explicitTarget of [true, false]) {
test(`RunCoordinator completes drafts with ${explicitTarget ? "explicit" : "default"} sandbox target`, async () => {
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
          ...(explicitTarget ? { target: "sandbox" } : {}),
          path: "draft.ts",
          content: finalContent,
        },
      };
      return toolCallStream(model, toolCall, [640, 768, 1_024, 1_536].map((length) => ({
        ...(explicitTarget ? { target: "sandbox" } : {}),
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
    if (explicitTarget) assert.ok(drafts.length >= 3);
    else assert.equal(drafts.length, 2, "implicit target stays private until arguments finish");
    assert.equal(drafts.slice(0, -1).every((data) => (data.file_draft as { done: boolean }).done === false), true);
    assert.equal((drafts.at(-1)?.file_draft as { done: boolean }).done, true);
    const completedIndex = journal.findIndex((event) => event.type === "tool.completed" && event.data.tool_call_id === "call_codex_write|item_1");
    const doneIndex = journal.findIndex((event) => event.type === "tool.arguments.delta" && (event.data.file_draft as { done?: boolean } | undefined)?.done);
    assert.ok(doneIndex >= 0 && completedIndex === doneIndex + 1);
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
}

