import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createConnection } from "node:net";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { RunCoordinator } from "../src/run-coordinator.js";
import { createRuntimeServer } from "../src/server.js";
import { temporaryDirectory, testConfig } from "./helpers.js";

test("runtime refuses to start with an empty configured bearer token", async () => {
  const home = await temporaryDirectory("agent-server-empty-token-");
  try {
    assert.throws(
      () => createRuntimeServer(testConfig(home, { bearerToken: "" })),
      /bearer token must be non-empty/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("runtime serves authenticated run creation and replayable SSE", async () => {
  const home = await temporaryDirectory("agent-server-");
  const workspace = await temporaryDirectory("agent-workspace-");
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage("hello from pi")]);
  const config = testConfig(home, { bearerToken: "secret" });
  const coordinator = new RunCoordinator({ config, streamFn: faux.provider.streamSimple });
  const runtime = createRuntimeServer(config, coordinator);
  try {
    const address = await runtime.listen();
    const base = `http://${address.host}:${address.port}`;
    const missingHealth = await fetch(`${base}/health`);
    assert.equal(missingHealth.status, 401);
    const wrongHealth = await fetch(`${base}/health`, { headers: { authorization: "Bearer wrong" } });
    assert.equal(wrongHealth.status, 401);
    const health = await fetch(`${base}/health`, { headers: { authorization: "Bearer secret" } });
    assert.equal(health.status, 200);
    const healthBody = await health.json() as Record<string, unknown>;
    assert.equal(healthBody.status, "ok");
    assert.equal(healthBody.service, "ubitech-agent-runtime");
    assert.equal(healthBody.version, "0.1.0");
    assert.equal(healthBody.pid, process.pid);
    assert.equal(Number.isInteger(healthBody.uptime_seconds), true);
    const unauthorizedModels = await fetch(`${base}/v1/models`);
    assert.equal(unauthorizedModels.status, 401);
    const models = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer secret" } });
    assert.equal(models.status, 200);
    const modelBody = await models.json() as {
      version: number;
      source: string;
      providers: Record<string, { provider: string; default_model: string; models: Array<{ id: string }> }>;
    };
    assert.equal(modelBody.version, 1);
    assert.equal(modelBody.source, "pi-runtime");
    assert.equal(modelBody.providers["openai-codex"]?.provider, "openai-codex");
    assert.ok(modelBody.providers["openai-codex"]?.models.some((model) => model.id === "gpt-5.5"));
    assert.equal(modelBody.providers["xai-oauth"]?.provider, "xai-oauth");
    const modelsWithQuery = await fetch(`${base}/v1/models?provider=openai-codex`, {
      headers: { authorization: "Bearer secret" },
    });
    assert.equal(modelsWithQuery.status, 400);
    const unauthorized = await fetch(`${base}/v1/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(unauthorized.status, 401);
    const unsafeModel = await fetch(`${base}/v1/runs`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({
        scope_key: "user:1",
        lifecycle_id: "life",
        session_id: "unsafe",
        workspace,
        system_prompt: "system",
        input: "hello",
        model: { provider: "openai-codex", id: "gpt-5.5", base_url: "https://attacker.invalid/v1" },
      }),
    });
    assert.equal(unsafeModel.status, 400);
    const malformed = await fetch(`${base}/v1/runs`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ model: { provider: "openai-codex", id: "gpt-5.5" } }),
    });
    assert.equal(malformed.status, 400);
    const malformedCleanup = await fetch(`${base}/v1/scopes/cleanup`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ scope_key: "user:1", delete_sessions: "false" }),
    });
    assert.equal(malformedCleanup.status, 400);
    const created = await fetch(`${base}/v1/runs`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({
        scope_key: "user:1",
        lifecycle_id: "life",
        session_id: "session",
        workspace,
        system_prompt: "You are ubitech agent.",
        input: "hello",
        history: [
          { role: "user", content: "earlier question" },
          { role: "assistant", content: "earlier answer" },
        ],
        model: { provider: "openai-codex", id: "gpt-5.5" },
      }),
    });
    assert.equal(created.status, 202);
    const body = await created.json() as { run_id: string; events_url: string };
    const completed = await coordinator.wait(body.run_id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.result?.content, "hello from pi");
    const eventsResponse = await fetch(`${base}${body.events_url}`, { headers: { authorization: "Bearer secret" } });
    const events = await eventsResponse.text();
    assert.match(events, /event: run\.queued/);
    assert.match(events, /event: message\.delta/);
    assert.match(events, /event: run\.completed/);
    assert.match(events, /"output":"hello from pi"/);
  } finally {
    await runtime.close();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime approval endpoint accepts decision and rejects retired compatibility fields", async () => {
  const home = await temporaryDirectory("agent-server-approval-");
  const workspace = await temporaryDirectory("agent-server-approval-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("terminal", { command: "touch approved.txt && stat approved.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("approved"),
  ]);
  const config = testConfig(home, { bearerToken: "secret", approvalTimeoutMs: 5_000 });
  const coordinator = new RunCoordinator({ config, streamFn: faux.provider.streamSimple });
  const runtime = createRuntimeServer(config, coordinator);
  try {
    const address = await runtime.listen();
    const base = `http://${address.host}:${address.port}`;
    const run = coordinator.createRun({
      scope_key: "private:1",
      lifecycle_id: "life",
      session_id: "session",
      workspace,
      system_prompt: "You are ubitech agent.",
      input: "run it",
      model: { provider: "openai-codex", id: "gpt-5.5" },
    });
    const deadline = Date.now() + 2_000;
    let approval = coordinator.getJournal(run.id)?.list().find((event) => event.type === "approval.requested");
    while (!approval && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      approval = coordinator.getJournal(run.id)?.list().find((event) => event.type === "approval.requested");
    }
    assert.ok(approval);
    const approvalId = String(approval.data.approval_id);
    const headers = { authorization: "Bearer secret", "content-type": "application/json" };
    const inputBody = {
      message_id: "message-2",
      scope_key: "private:1",
      lifecycle_id: "life",
      input: "include this follow-up",
    };
    assert.equal((await fetch(`${base}/v1/runs/${run.id}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(inputBody),
    })).status, 401);
    assert.equal((await fetch(`${base}/v1/runs/${run.id}/input`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...inputBody, scope_key: "another-scope" }),
    })).status, 409);
    const joined = await fetch(`${base}/v1/runs/${run.id}/input`, {
      method: "POST",
      headers,
      body: JSON.stringify(inputBody),
    });
    assert.equal(joined.status, 202);
    assert.deepEqual(await joined.json(), {
      run_id: run.id,
      message_id: "message-2",
      state: "accepted",
    });
    assert.equal((await fetch(`${base}/v1/runs/${run.id}/input`, {
      method: "POST",
      headers,
      body: JSON.stringify(inputBody),
    })).status, 202);

    const choiceAlias = await fetch(`${base}/v1/runs/${run.id}/approval`, {
      method: "POST",
      headers,
      body: JSON.stringify({ approval_id: approvalId, choice: "once" }),
    });
    assert.equal(choiceAlias.status, 400);

    const resolveAll = await fetch(`${base}/v1/runs/${run.id}/approval`, {
      method: "POST",
      headers,
      body: JSON.stringify({ approval_id: approvalId, decision: "once", resolve_all: true }),
    });
    assert.equal(resolveAll.status, 400);

    const accepted = await fetch(`${base}/v1/runs/${run.id}/approval`, {
      method: "POST",
      headers,
      body: JSON.stringify({ approval_id: approvalId, decision: "once" }),
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), {
      run_id: run.id,
      approval_id: approvalId,
      decision: "once",
      resolved: true,
    });
    assert.equal((await coordinator.wait(run.id)).status, "completed");
    const replayedInput = await fetch(`${base}/v1/runs/${run.id}/input`, {
      method: "POST",
      headers,
      body: JSON.stringify(inputBody),
    });
    assert.equal(replayedInput.status, 200);
    assert.equal((await replayedInput.json() as { state: string }).state, "injected");
  } finally {
    await runtime.close();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime rejects a slow JSON request body at the configured deadline", async () => {
  const home = await temporaryDirectory("agent-server-body-deadline-");
  const config = testConfig(home, { bearerToken: "secret", requestBodyTimeoutMs: 30 });
  const runtime = createRuntimeServer(config);
  let socket: ReturnType<typeof createConnection> | undefined;
  try {
    const address = await runtime.listen();
    socket = createConnection({ host: address.host, port: address.port });
    const response = await new Promise<string>((resolvePromise, reject) => {
      let received = "";
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for the body deadline response")), 2_000);
      socket!.setEncoding("utf8");
      socket!.on("data", (chunk: string) => { received += chunk; });
      socket!.once("error", (error) => {
        clearTimeout(timeout);
        if (received) resolvePromise(received);
        else reject(error);
      });
      socket!.once("close", () => {
        clearTimeout(timeout);
        resolvePromise(received);
      });
      socket!.once("connect", () => {
        socket!.write([
          "POST /v1/runs HTTP/1.1",
          `Host: ${address.host}:${address.port}`,
          "Authorization: Bearer secret",
          "Content-Type: application/json",
          "Content-Length: 100",
          "Connection: keep-alive",
          "",
          "{",
        ].join("\r\n"));
      });
    });
    assert.match(response, /^HTTP\/1\.1 408 /);
    assert.match(response, /connection: close/i);
    assert.match(response, /Request body deadline exceeded/);
  } finally {
    socket?.destroy();
    await runtime.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("runtime exposes only bounded read-only processes owned by a root scope", async () => {
  const home = await temporaryDirectory("agent-server-preview-");
  const workspace = await temporaryDirectory("agent-server-preview-workspace-");
  const config = testConfig(home, { bearerToken: "secret" });
  const coordinator = new RunCoordinator({ config });
  const runtime = createRuntimeServer(config, coordinator);
  try {
    const root = await coordinator.processes.run({
      runId: "root-run",
      scopeKey: "private:9",
      lifecycleId: "life-9",
      command: "printf root",
      cwd: workspace,
    });
    const child = await coordinator.processes.run({
      runId: "child-run",
      scopeKey: "private:9/delegate/child",
      lifecycleId: "life-9",
      command: "printf child",
      cwd: workspace,
    });
    await coordinator.processes.run({
      runId: "sibling-run",
      scopeKey: "private:90",
      lifecycleId: "life-9",
      command: "printf sibling",
      cwd: workspace,
    });
    const address = await runtime.listen();
    const base = `http://${address.host}:${address.port}`;
    const query = "scope_key=private%3A9&lifecycle_id=life-9";

    assert.equal((await fetch(`${base}/v1/scopes/processes?${query}`)).status, 401);
    assert.equal((await fetch(`${base}/v1/scopes/processes?scope_key=private%3A9`, {
      headers: { authorization: "Bearer secret" },
    })).status, 400);
    const response = await fetch(`${base}/v1/scopes/processes?${query}`, {
      headers: { authorization: "Bearer secret" },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      processes: Array<Record<string, unknown>>;
      revision: string;
      unchanged?: true;
    };
    assert.match(body.revision, /^preview_[a-f0-9]{32}:\d+$/);
    assert.equal(body.unchanged, undefined);
    assert.deepEqual(new Set(body.processes.map((process) => process.id)), new Set([root.id, child.id]));
    for (const process of body.processes) {
      for (const internal of ["pid", "run_id", "scope_key", "lifecycle_id", "stdout", "stderr"]) {
        assert.equal(internal in process, false);
      }
      assert.equal(typeof process.output, "string");
    }
    const unchanged = await fetch(`${base}/v1/scopes/processes?${query}&since_revision=${body.revision}`, {
      headers: { authorization: "Bearer secret" },
    });
    assert.equal(unchanged.status, 200);
    assert.deepEqual(await unchanged.json(), {
      processes: [],
      revision: body.revision,
      unchanged: true,
    });
    for (const invalid of ["", "-1", "+1", "bad token", "slash/value", "x".repeat(129)]) {
      assert.equal((await fetch(`${base}/v1/scopes/processes?${query}&since_revision=${encodeURIComponent(invalid)}`, {
        headers: { authorization: "Bearer secret" },
      })).status, 400);
    }
    assert.equal((await fetch(`${base}/v1/scopes/processes?${query}&since_revision=1&since_revision=1`, {
      headers: { authorization: "Bearer secret" },
    })).status, 400);
    assert.equal((await fetch(`${base}/v1/scopes/processes?${query}&extra=1`, {
      headers: { authorization: "Bearer secret" },
    })).status, 400);
    assert.equal((await fetch(`${base}/v1/scopes/processes?${query}`, {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    })).status, 404);
  } finally {
    await runtime.close();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime exposes a lightweight live-process summary without terminal output", async () => {
  const home = await temporaryDirectory("agent-server-preview-summary-");
  const workspace = await temporaryDirectory("agent-server-preview-summary-workspace-");
  const config = testConfig(home, { bearerToken: "secret" });
  const coordinator = new RunCoordinator({ config });
  const runtime = createRuntimeServer(config, coordinator);
  try {
    await coordinator.processes.run({
      runId: "completed-run",
      scopeKey: "private:9",
      lifecycleId: "life-9",
      command: "printf completed-summary-secret",
      cwd: workspace,
    });
    await coordinator.processes.run({
      runId: "root-live-run",
      scopeKey: "private:9",
      lifecycleId: "life-9",
      command: "printf root-summary-secret; sleep 30",
      cwd: workspace,
      background: true,
    });
    await coordinator.processes.run({
      runId: "child-live-run",
      scopeKey: "private:9/delegate/child",
      lifecycleId: "life-9",
      command: "printf child-summary-secret; sleep 30",
      cwd: workspace,
      background: true,
    });
    await coordinator.processes.run({
      runId: "sibling-live-run",
      scopeKey: "private:90",
      lifecycleId: "life-9",
      command: "printf sibling-summary-secret; sleep 30",
      cwd: workspace,
      background: true,
      updateBehavior: "terminate",
    });
    await coordinator.processes.run({
      runId: "old-life-live-run",
      scopeKey: "private:9",
      lifecycleId: "old-life",
      command: "printf old-life-summary-secret; sleep 30",
      cwd: workspace,
      background: true,
    });

    const address = await runtime.listen();
    const base = `http://${address.host}:${address.port}`;
    const query = "scope_key=private%3A9&lifecycle_id=life-9";
    assert.equal((await fetch(`${base}/v1/scopes/process-summary?${query}`)).status, 401);
    assert.equal((await fetch(`${base}/v1/scopes/process-summary?scope_key=private%3A9`, {
      headers: { authorization: "Bearer secret" },
    })).status, 400);
    assert.equal((await fetch(`${base}/v1/scopes/process-summary?${query}&extra=1`, {
      headers: { authorization: "Bearer secret" },
    })).status, 400);
    assert.equal((await fetch(`${base}/v1/scopes/process-summary?${query}&scope_key=private%3A9`, {
      headers: { authorization: "Bearer secret" },
    })).status, 400);

    const response = await fetch(`${base}/v1/scopes/process-summary?${query}`, {
      headers: { authorization: "Bearer secret" },
    });
    assert.equal(response.status, 200);
    const raw = await response.text();
    assert.deepEqual(JSON.parse(raw), { running_terminal_count: 2 });
    assert.doesNotMatch(raw, /summary-secret|command|stdout|stderr|output|processes/);

    assert.equal((await fetch(`${base}/v1/processes/update-blockers`)).status, 401);
    assert.equal((await fetch(`${base}/v1/processes/update-blockers?scope_key=private%3A9`, {
      headers: { authorization: "Bearer secret" },
    })).status, 400);
    const blockerResponse = await fetch(`${base}/v1/processes/update-blockers`, {
      headers: { authorization: "Bearer secret" },
    });
    assert.equal(blockerResponse.status, 200);
    const blockerRaw = await blockerResponse.text();
    assert.deepEqual(JSON.parse(blockerRaw), {
      running_background_terminal_count: 4,
      update_blocking_terminal_count: 3,
      terminable_background_terminal_count: 1,
    });
    assert.doesNotMatch(
      blockerRaw,
      /summary-secret|command|scope|lifecycle|pid|stdout|stderr|output|processes/,
    );
  } finally {
    coordinator.processes.killScope("private:9");
    coordinator.processes.killScope("private:90");
    await coordinator.processes.waitForScopeExit("private:9", undefined, 5_000);
    await coordinator.processes.waitForScopeExit("private:90", undefined, 5_000);
    await runtime.close();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
