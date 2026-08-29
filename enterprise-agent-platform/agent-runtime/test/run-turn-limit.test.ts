import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { LEARNING_REVIEW_MAX_MODEL_TURNS } from "../src/run-coordinator.js";
import type { RunRequest } from "../src/types.js";
import { temporaryDirectory, testConfig, TestRunCoordinator as RunCoordinator } from "./helpers.js";

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

test("ordinary runs retain the configured model turn budget above the learning-review cap", async () => {
  const home = await temporaryDirectory("agent-ordinary-turn-limit-");
  const workspace = await temporaryDirectory("agent-ordinary-turn-limit-workspace-");
  await writeFile(`${workspace}/input.txt`, "ready\n", "utf8");
  const faux = fauxProvider();
  faux.setResponses([
    ...Array.from({ length: LEARNING_REVIEW_MAX_MODEL_TURNS }, () => fauxAssistantMessage(
      fauxToolCall("read_file", { path: "input.txt" }),
      { stopReason: "toolUse" },
    )),
    fauxAssistantMessage("ordinary run completed on its configured final turn"),
  ]);
  const configuredTurns = LEARNING_REVIEW_MAX_MODEL_TURNS + 1;
  const coordinator = new RunCoordinator({
    config: testConfig(home, { maxTurnsPerRun: configuredTurns }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const run = coordinator.createRun(baseRequest(workspace));
    const completed = await coordinator.wait(run.id);

    assert.equal(completed.status, "completed");
    assert.equal(
      completed.result?.content,
      "ordinary run completed on its configured final turn",
    );
    assert.equal(faux.state.callCount, configuredTurns);
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

test("learning reviews stop before their seventeenth model request", async () => {
  assert.equal(LEARNING_REVIEW_MAX_MODEL_TURNS, 16);
  const home = await temporaryDirectory("agent-learning-review-turn-limit-");
  const workspace = await temporaryDirectory("agent-learning-review-turn-limit-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    ...Array.from({ length: LEARNING_REVIEW_MAX_MODEL_TURNS }, (_, index) => fauxAssistantMessage(
      fauxToolCall("memory", {
        action: "search",
        arguments: { query: `review step ${index}` },
      }),
      { stopReason: "toolUse" },
    )),
    fauxAssistantMessage("this seventeenth response must never be requested"),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, {
      maxTurnsPerRun: LEARNING_REVIEW_MAX_MODEL_TURNS + 20,
    }),
    streamFn: faux.provider.streamSimple,
  });
  coordinator.gateway.invoke = async () => ({ data: { memories: [] } });
  try {
    const run = coordinator.createRun({
      scope_key: "private:1",
      lifecycle_id: "life",
      session_id: "learning-review-7",
      workspace,
      system_prompt: "You are an Agent.",
      input: "Review durable learning.",
      model: { provider: "openai-codex", id: "gpt-5.5" },
      metadata: {
        trigger: "learning_review",
        review_mode: "memory_skill",
        review_job_id: 7,
        source_message_id: 88,
        idempotency_key: "agent-learning-review:7",
        unattended: true,
        delegation_depth: 0,
      },
    });
    const completed = await coordinator.wait(run.id);

    assert.equal(completed.status, "failed");
    assert.equal(completed.sideEffectsStarted, false);
    assert.match(
      completed.error || "",
      /model turn limit of 16; model request 17 was not started/,
    );
    assert.equal(
      faux.state.callCount,
      LEARNING_REVIEW_MAX_MODEL_TURNS,
      "the blocked seventeenth request must not reach the provider",
    );
    assert.equal(faux.getPendingResponseCount(), 1);
    const limitEvents = coordinator.getJournal(run.id)?.list().filter(
      (event) => event.type === "run.turn_limit",
    ) ?? [];
    assert.deepEqual(limitEvents[0]?.data, {
      max_turns: LEARNING_REVIEW_MAX_MODEL_TURNS,
      completed_turns: LEARNING_REVIEW_MAX_MODEL_TURNS,
      blocked_turn: LEARNING_REVIEW_MAX_MODEL_TURNS + 1,
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
    system_prompt: "You are an Agent.",
    input: "Complete the task",
    model: { provider: "openai-codex", id: "gpt-5.5" },
  };
}
