import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { temporaryDirectory, testConfig, TestRunCoordinator as RunCoordinator } from "./helpers.js";

test("automatic compaction iteratively re-compacts a long tool loop in one Run", async () => {
  const home = await temporaryDirectory("agent-repeated-compaction-");
  const workspace = await temporaryDirectory("agent-repeated-compaction-workspace-");
  const main = fauxProvider();
  const summaries = fauxProvider();
  const rawInputSecret = `ghp_${"A".repeat(36)}`;
  const rawOutputSecret = `github_pat_${"B".repeat(48)}`;
  const objective = "ORIGINAL_ACCEPTANCE: finish every bounded inspection before replying";
  const latestRequest = "LATEST_REQUEST: return one final answer after the inspections";
  const summaryInputs: AgentMessage[][] = [];
  let summaryCalls = 0;

  main.setResponses([
    ...Array.from({ length: 10 }, () => fauxAssistantMessage(
      fauxToolCall("todo", { action: "read" }),
      { stopReason: "toolUse" },
    )),
    fauxAssistantMessage("All bounded inspections are complete."),
  ]);
  summaries.setResponses(Array.from({ length: 16 }, (_unused, index) => fauxAssistantMessage(
    `HANDOFF_REVISION_${index + 1}\n${objective}\n${latestRequest}\nAuthorization: Bearer ${rawOutputSecret}`,
  )));
  const streamFn: StreamFn = (model, context, options) => {
    if (context.systemPrompt?.startsWith("Create a concise continuation handoff")) {
      summaryCalls += 1;
      summaryInputs.push(structuredClone(context.messages));
      return summaries.provider.streamSimple(model, context, options);
    }
    return main.provider.streamSimple(model, context, options);
  };
  const coordinator = new RunCoordinator({
    config: testConfig(home, { compactionThreshold: 0.00001 }),
    streamFn,
  });
  const identity = {
    scope_key: "private:repeated-compaction",
    lifecycle_id: "life",
    session_id: "long-tool-loop",
  };

  try {
    const run = coordinator.createRun({
      ...identity,
      workspace,
      system_prompt: "You are an Agent.",
      input: latestRequest,
      history: [
        {
          role: "user",
          content: `${objective}\nAPI_TOKEN=${rawInputSecret}`,
          timestamp: 1,
        },
        ...Array.from({ length: 8 }, (_, index) => ({
          role: "user" as const,
          content: `Historical inspection ${index}: ${"evidence ".repeat(80)}`,
          timestamp: index + 2,
        })),
      ],
      model: { provider: "openai-codex", id: "gpt-5.5" },
    });
    const completed = await coordinator.wait(run.id);

    assert.equal(completed.status, "completed", completed.error);
    assert.equal(completed.result?.content, "All bounded inspections are complete.");
    assert.ok(summaryCalls >= 3, `expected repeated automatic compaction, received ${summaryCalls} summaries`);
    assert.equal(
      coordinator.getJournal(run.id)?.list().filter((event) => event.type === "context.compacted").length,
      summaryCalls,
      "each durable rewrite must publish exactly one event after it commits",
    );
    assert.match(JSON.stringify(summaryInputs[1]), /HANDOFF_REVISION_1/);
    assert.match(JSON.stringify(summaryInputs[1]), new RegExp(objective));
    assert.match(JSON.stringify(summaryInputs[1]), new RegExp(latestRequest));
    for (const input of summaryInputs) {
      const serialized = JSON.stringify(input);
      assert.doesNotMatch(serialized, new RegExp(rawInputSecret));
      assert.doesNotMatch(serialized, new RegExp(rawOutputSecret));
    }

    const tracked = await coordinator.sessions.loadTracked(identity);
    assert.equal(
      tracked.filter((entry) => entry.synthetic_kind === "context_compaction_notice").length,
      1,
      "the active journal must contain only the newest handoff",
    );
    const active = JSON.stringify(tracked);
    assert.match(active, new RegExp(`HANDOFF_REVISION_${summaryCalls}`));
    assert.doesNotMatch(active, new RegExp(rawOutputSecret));
    const archive = await readFile(coordinator.sessions.archivePath(identity), "utf8");
    assert.doesNotMatch(archive, /HANDOFF_REVISION_/);
    assert.match(archive, new RegExp(rawInputSecret), "the owner-scoped archive retains original history");
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("cancelling a repeated automatic summary preserves the last committed handoff", async () => {
  const home = await temporaryDirectory("agent-repeated-compaction-cancel-");
  const workspace = await temporaryDirectory("agent-repeated-compaction-cancel-workspace-");
  const main = fauxProvider();
  const summaries = fauxProvider();
  let announceSecondSummary = (): void => {};
  const secondSummaryStarted = new Promise<void>((resolve) => { announceSecondSummary = resolve; });

  main.setResponses([
    fauxAssistantMessage(fauxToolCall("todo", { action: "read" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("todo", { action: "read" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("must not finish after cancellation"),
  ]);
  summaries.setResponses([
    fauxAssistantMessage("FIRST_COMMITTED_HANDOFF\nContinue the bounded inspection."),
    async (_context, options) => {
      announceSecondSummary();
      return await new Promise<ReturnType<typeof fauxAssistantMessage>>((_resolve, reject) => {
        const rejectAbort = () => reject(Object.assign(new Error("summary cancelled"), { name: "AbortError" }));
        if (options?.signal?.aborted) rejectAbort();
        else options?.signal?.addEventListener("abort", rejectAbort, { once: true });
      });
    },
  ]);
  const streamFn: StreamFn = (model, context, options) => context.systemPrompt?.startsWith(
    "Create a concise continuation handoff",
  )
    ? summaries.provider.streamSimple(model, context, options)
    : main.provider.streamSimple(model, context, options);
  const coordinator = new RunCoordinator({
    config: testConfig(home, { compactionThreshold: 0.00001 }),
    streamFn,
  });
  const identity = {
    scope_key: "private:repeated-compaction-cancel",
    lifecycle_id: "life",
    session_id: "cancel-second-summary",
  };

  try {
    const run = coordinator.createRun({
      ...identity,
      workspace,
      system_prompt: "You are an Agent.",
      input: "Continue until every inspection is complete.",
      history: Array.from({ length: 9 }, (_, index) => ({
        role: "user" as const,
        content: `Durable history ${index}: ${"context ".repeat(80)}`,
        timestamp: index + 1,
      })),
      model: { provider: "openai-codex", id: "gpt-5.5" },
    });

    await secondSummaryStarted;
    const trackedBeforeCancel = await coordinator.sessions.loadTracked(identity);
    const archiveBeforeCancel = await readFile(coordinator.sessions.archivePath(identity), "utf8");
    assert.equal(
      trackedBeforeCancel.filter((entry) => entry.synthetic_kind === "context_compaction_notice").length,
      1,
    );
    assert.match(JSON.stringify(trackedBeforeCancel), /FIRST_COMMITTED_HANDOFF/);

    coordinator.cancel(run.id);
    const cancelled = await coordinator.wait(run.id);
    assert.equal(cancelled.status, "cancelled");
    const trackedAfterCancel = await coordinator.sessions.loadTracked(identity);
    assert.deepEqual(
      trackedAfterCancel.slice(0, trackedBeforeCancel.length),
      trackedBeforeCancel,
      "cancellation may append its normal aborted Agent message but must not replace committed context",
    );
    assert.equal(
      trackedAfterCancel.filter((entry) => entry.synthetic_kind === "context_compaction_notice").length,
      1,
    );
    assert.doesNotMatch(JSON.stringify(trackedAfterCancel), /SECOND_/);
    assert.equal(await readFile(coordinator.sessions.archivePath(identity), "utf8"), archiveBeforeCancel);
    assert.equal(
      coordinator.getJournal(run.id)?.list().filter((event) => event.type === "context.compacted").length,
      1,
      "the aborted second summary must not publish a durable compaction event",
    );
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
