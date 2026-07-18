import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
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

test("compaction archives the exact durable entries when recovery removes an orphan tool result", async () => {
  const home = await temporaryDirectory("agent-session-orphan-compaction-");
  const workspace = await temporaryDirectory("agent-session-orphan-compaction-workspace-");
  const faux = fauxProvider();
  faux.setResponses([async () => fauxAssistantMessage("compaction completed safely")]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { compactionThreshold: 0.000001 }),
    streamFn: faux.provider.streamSimple,
  });
  const request: RunRequest = {
    scope_key: "scope",
    lifecycle_id: "life",
    session_id: "session",
    workspace,
    system_prompt: "You are ubitech agent.",
    input: "continue after recovery",
    model: { provider: "openai-codex", id: "gpt-5.5" },
  };
  const identity = {
    scope_key: request.scope_key,
    lifecycle_id: request.lifecycle_id,
    session_id: request.session_id,
  };
  const history: AgentMessage[] = [
    {
      role: "toolResult",
      toolCallId: "missing-call",
      toolName: "terminal",
      content: [{ type: "text", text: "orphan-raw-marker" }],
      isError: false,
      timestamp: 0,
    },
    { role: "user", content: "omitted-user-one", timestamp: 1 },
    { ...fauxAssistantMessage("omitted-assistant-two"), timestamp: 2 },
    { role: "user", content: "omitted-user-three", timestamp: 3 },
    { ...fauxAssistantMessage("last-exact-omitted-marker"), timestamp: 4 },
    { role: "user", content: "first-retained-marker", timestamp: 5 },
    { ...fauxAssistantMessage("retained-assistant"), timestamp: 6 },
    { role: "user", content: "retained-user", timestamp: 7 },
    { ...fauxAssistantMessage("most-recent-retained"), timestamp: 8 },
  ];
  try {
    await coordinator.sessions.initialize(identity, history);
    const run = coordinator.createRun(request);
    const completed = await coordinator.wait(run.id);
    assert.equal(completed.status, "completed");
    assert.ok(coordinator.getJournal(run.id)?.list().some((event) => event.type === "context.compacted"));

    const archive = await readFile(coordinator.sessions.archivePath(identity), "utf8");
    assert.match(archive, /orphan-raw-marker/);
    assert.match(archive, /last-exact-omitted-marker/);
    assert.doesNotMatch(archive, /first-retained-marker/);

    const active = JSON.stringify(await coordinator.sessions.load(identity));
    assert.doesNotMatch(active, /orphan-raw-marker/);
    assert.doesNotMatch(active, /last-exact-omitted-marker/);
    assert.match(active, /first-retained-marker/);

    const searchable = JSON.stringify(await coordinator.sessions.loadSearchable(identity));
    for (const marker of [
      "orphan-raw-marker",
      "last-exact-omitted-marker",
      "first-retained-marker",
      "compaction completed safely",
    ]) {
      assert.match(searchable, new RegExp(marker));
    }
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
