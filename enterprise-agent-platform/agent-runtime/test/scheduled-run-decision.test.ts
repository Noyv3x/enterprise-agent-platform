import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { RunRequest } from "../src/types.js";
import { temporaryDirectory, testConfig, TestRunCoordinator as RunCoordinator } from "./helpers.js";

const MISSING_DECISION_ERROR = "Recurring scheduled run stopped without a successful continue_current or complete_current decision; review is required and the schedule must be paused";

test("a recurring occurrence can explicitly keep its already-computed next run", async () => {
  const home = await temporaryDirectory("agent-schedule-continue-");
  const workspace = await temporaryDirectory("agent-schedule-continue-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("schedule", { action: "continue_current", arguments: {} }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("The recurring check remains necessary."),
  ]);
  const coordinator = new RunCoordinator({ config: testConfig(home), streamFn: faux.provider.streamSimple });
  const calls: Array<{ action: string; arguments: Record<string, unknown> }> = [];
  coordinator.gateway.invoke = async (_request, _runId, _tool, action, arguments_) => {
    calls.push({ action, arguments: arguments_ });
    return { data: { continued: true } };
  };
  try {
    const completed = await coordinator.wait(coordinator.createRun(recurringRequest(workspace, "continue")).id);
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(completed.sideEffectsStarted, false);
    assert.deepEqual(calls, [{ action: "continue_current", arguments: {} }]);
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a recurring occurrence missing its decision exhausts bounded reminders and needs review", async () => {
  const home = await temporaryDirectory("agent-schedule-decision-missing-");
  const workspace = await temporaryDirectory("agent-schedule-decision-missing-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage("The check is complete."),
    (context) => {
      assert.match(JSON.stringify(context.messages), /Before this recurring scheduled occurrence can finish/);
      return fauxAssistantMessage("The check is complete.");
    },
    fauxAssistantMessage("The check is complete."),
  ]);
  const coordinator = new RunCoordinator({ config: testConfig(home), streamFn: faux.provider.streamSimple });
  try {
    const completed = await coordinator.wait(coordinator.createRun(recurringRequest(workspace, "missing")).id);
    assert.equal(completed.status, "needs_review");
    assert.equal(completed.sideEffectsStarted, false);
    assert.equal(completed.error, MISSING_DECISION_ERROR);
    assert.equal(completed.result?.content, "The check is complete.");
    assert.equal(faux.state.callCount, 3);
    const terminal = coordinator.getJournal(completed.id)?.list().find((event) => event.type === "run.needs_review");
    assert.equal(terminal?.data.error, MISSING_DECISION_ERROR);
    assert.equal(terminal?.data.content, "The check is complete.");
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a once occurrence does not require a recurring decision", async () => {
  const home = await temporaryDirectory("agent-schedule-once-");
  const workspace = await temporaryDirectory("agent-schedule-once-workspace-");
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage("The one-time reminder was delivered.")]);
  const coordinator = new RunCoordinator({ config: testConfig(home), streamFn: faux.provider.streamSimple });
  try {
    const request = recurringRequest(workspace, "once");
    request.metadata = { ...request.metadata, schedule_recurring: false };
    const completed = await coordinator.wait(coordinator.createRun(request).id);
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(faux.state.callCount, 1);
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

function recurringRequest(workspace: string, sessionId: string): RunRequest {
  return {
    scope_key: "private:1",
    lifecycle_id: "life",
    session_id: `scheduled-${sessionId}`,
    workspace,
    system_prompt: "You are an Agent.",
    input: "Run the scheduled check.",
    model: { provider: "openai-codex", id: "gpt-5.5" },
    metadata: {
      actor: { id: 1 },
      source_message_id: 81,
      trigger: "scheduled",
      unattended: true,
      schedule_id: "7",
      schedule_run_id: "45",
      schedule_recurring: true,
      scheduled_for: "2026-07-16T08:15:00Z",
    },
  };
}
