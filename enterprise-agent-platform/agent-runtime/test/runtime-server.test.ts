import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createConnection } from "node:net";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { RunCoordinator } from "../src/run-coordinator.js";
import { createRuntimeServer } from "../src/server.js";
import { temporaryDirectory, testConfig } from "./helpers.js";

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
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
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
