import assert from "node:assert/strict";
import { createServer } from "node:http";
import { rm, stat } from "node:fs/promises";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { IdempotencyStore } from "../src/persistence.js";
import { RunCoordinator } from "../src/run-coordinator.js";
import type { RunRequest } from "../src/types.js";
import { temporaryDirectory, testConfig } from "./helpers.js";

test("RunCoordinator deduplicates scope-local idempotency keys during retention", async () => {
  const home = await temporaryDirectory("agent-idempotency-");
  const workspace = await temporaryDirectory("agent-idempotency-workspace-");
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage("one execution")]);
  const config = testConfig(home);
  const coordinator = new RunCoordinator({ config, streamFn: faux.provider.streamSimple });
  try {
    const request = baseRequest(workspace);
    request.metadata = { idempotency_key: "job-42" };
    const first = coordinator.createRun(request);
    const duplicate = coordinator.createRun(structuredClone(request));
    assert.equal(duplicate.id, first.id);
    assert.equal((await coordinator.wait(first.id)).status, "completed");
    assert.equal(faux.state.callCount, 1);
    const indexFile = await stat(`${home}/idempotency/index.json`);
    assert.equal(indexFile.mode & 0o777, 0o600);

    coordinator.shutdown();
    const restartedFaux = fauxProvider();
    restartedFaux.setResponses([fauxAssistantMessage("must not execute")]);
    const restarted = new RunCoordinator({ config, streamFn: restartedFaux.provider.streamSimple });
    const reused = restarted.createRun(structuredClone(request));
    assert.equal(reused.id, first.id);
    assert.equal(reused.status, "completed");
    assert.equal(reused.result?.content, "one execution");
    assert.equal(restartedFaux.state.callCount, 0);
    assert.deepEqual(
      restarted.getJournal(reused.id)?.list().map((event) => event.type),
      ["run.reused", "run.completed"],
    );
    restarted.shutdown();
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("an interrupted persisted idempotent run becomes needs_review without replay", async () => {
  const home = await temporaryDirectory("agent-idempotency-interrupted-");
  const workspace = await temporaryDirectory("agent-idempotency-interrupted-workspace-");
  const config = testConfig(home);
  try {
    const request = baseRequest(workspace);
    request.metadata = { idempotency_key: "job-interrupted" };
    const persisted = new IdempotencyStore(home);
    persisted.create("scope", "job-interrupted", "run_original", "session", 60_000);
    persisted.update("scope", "job-interrupted", { status: "running", retentionMs: 60_000 });

    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("must not execute")]);
    const restarted = new RunCoordinator({ config, streamFn: faux.provider.streamSimple });
    const reused = restarted.createRun(request);
    assert.equal(reused.id, "run_original");
    assert.equal(reused.status, "needs_review");
    assert.equal(faux.state.callCount, 0);
    assert.match(reused.error || "", /not executed again/);
    assert.deepEqual(
      restarted.getJournal(reused.id)?.list().map((event) => event.type),
      ["run.reused", "run.needs_review"],
    );
    restarted.shutdown();
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("RunCoordinator recalls bounded memory into the top-level system prompt", async () => {
  const home = await temporaryDirectory("agent-memory-");
  const workspace = await temporaryDirectory("agent-memory-workspace-");
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/agent/tools/memory/search") {
      response.end(JSON.stringify({ memories: [{ id: 1, content: "The preferred language is Chinese." }] }));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  let observedSystemPrompt = "";
  const faux = fauxProvider();
  faux.setResponses([
    (context) => {
      observedSystemPrompt = context.systemPrompt || "";
      return fauxAssistantMessage("used memory");
    },
  ]);
  const coordinator = new RunCoordinator({ config: testConfig(home), streamFn: faux.provider.streamSimple });
  try {
    const request = baseRequest(workspace);
    request.gateway = { base_url: `http://127.0.0.1:${address.port}`, token: "tool-token" };
    const run = coordinator.createRun(request);
    assert.equal((await coordinator.wait(run.id)).status, "completed");
    assert.match(observedSystemPrompt, /<recalled_memory>/);
    assert.match(observedSystemPrompt, /preferred language is Chinese/);
    assert.ok(coordinator.getJournal(run.id)?.list().some((event) => event.type === "memory.recalled"));
  } finally {
    coordinator.shutdown();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
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
    input: "What do I prefer?",
    model: { provider: "openai-codex", id: "gpt-5.5" },
  };
}
