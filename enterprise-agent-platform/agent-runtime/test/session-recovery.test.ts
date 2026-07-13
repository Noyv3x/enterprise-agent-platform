import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { RunCoordinator } from "../src/run-coordinator.js";
import type { RunRequest } from "../src/types.js";
import { temporaryDirectory, testConfig } from "./helpers.js";

test("RunCoordinator repairs a durable assistant tool call with no result", async () => {
  const home = await temporaryDirectory("agent-session-recovery-");
  const workspace = await temporaryDirectory("agent-session-recovery-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    async (context) => {
      const assistant = context.messages.find((message) => message.role === "assistant");
      assert.ok(assistant?.role === "assistant");
      assert.equal(assistant.content.some((block) => block.type === "toolCall"), false);
      assert.match(
        assistant.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"),
        /outcome is unknown/,
      );
      return fauxAssistantMessage("recovered safely");
    },
  ]);
  const coordinator = new RunCoordinator({ config: testConfig(home), streamFn: faux.provider.streamSimple });
  const request: RunRequest = {
    scope_key: "scope",
    lifecycle_id: "life",
    session_id: "session",
    workspace,
    system_prompt: "You are ubitech agent.",
    input: "continue",
    model: { provider: "openai-codex", id: "gpt-5.5" },
  };
  try {
    const identity = {
      scope_key: request.scope_key,
      lifecycle_id: request.lifecycle_id,
      session_id: request.session_id,
    };
    await coordinator.sessions.initialize(identity, []);
    await coordinator.sessions.appendMessage(
      identity,
      fauxAssistantMessage(fauxToolCall("terminal", { command: "touch unknown" }), { stopReason: "toolUse" }),
    );
    const run = coordinator.createRun(request);
    const completed = await coordinator.wait(run.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.result?.content, "recovered safely");
    assert.ok(coordinator.getJournal(run.id)?.list().some((event) => event.type === "session.repaired"));
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
