import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { RunCoordinator } from "../src/run-coordinator.js";
import type { RunRequest } from "../src/types.js";
import { temporaryDirectory, testConfig } from "./helpers.js";

test("a run can finish normally on its final allowed model turn", async () => {
  const home = await temporaryDirectory("agent-turn-limit-complete-");
  const workspace = await temporaryDirectory("agent-turn-limit-complete-workspace-");
  await writeFile(`${workspace}/input.txt`, "ready\n", "utf8");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("read_file", { path: "input.txt" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("completed on the final allowed turn"),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { maxTurnsPerRun: 2 }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const run = coordinator.createRun(baseRequest(workspace));
    const completed = await coordinator.wait(run.id);

    assert.equal(completed.status, "completed");
    assert.equal(completed.result?.content, "completed on the final allowed turn");
    assert.equal(faux.state.callCount, 2);
    assert.equal(faux.getPendingResponseCount(), 0);
    assert.equal(
      coordinator.getJournal(run.id)?.list().some((event) => event.type === "run.turn_limit"),
      false,
    );
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("the turn limit stops before starting the next provider request", async () => {
  const home = await temporaryDirectory("agent-turn-limit-stop-");
  const workspace = await temporaryDirectory("agent-turn-limit-stop-workspace-");
  await writeFile(`${workspace}/input.txt`, "ready\n", "utf8");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("read_file", { path: "input.txt" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("read_file", { path: "input.txt" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("this response must never be requested"),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { maxTurnsPerRun: 2 }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const run = coordinator.createRun(baseRequest(workspace));
    const completed = await coordinator.wait(run.id);

    assert.equal(completed.status, "failed");
    assert.equal(completed.sideEffectsStarted, false);
    assert.match(completed.error || "", /model turn limit of 2; model request 3 was not started/);
    assert.equal(faux.state.callCount, 2, "the blocked third request must not reach the provider");
    assert.equal(faux.getPendingResponseCount(), 1);

    const limitEvents = coordinator.getJournal(run.id)?.list().filter(
      (event) => event.type === "run.turn_limit",
    ) ?? [];
    assert.equal(limitEvents.length, 1);
    assert.deepEqual(limitEvents[0]?.data, {
      max_turns: 2,
      completed_turns: 2,
      blocked_turn: 3,
    });
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

function baseRequest(workspace: string): RunRequest {
  return {
    scope_key: "scope",
    lifecycle_id: "life",
    session_id: "session",
    workspace,
    system_prompt: "You are ubitech agent.",
    input: "Complete the task",
    model: { provider: "openai-codex", id: "gpt-5.5" },
  };
}
