import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { RunCoordinator } from "../src/run-coordinator.js";
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

async function waitUntil<T>(read: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}
