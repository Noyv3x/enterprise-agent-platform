import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createModelRuntime } from "../src/credentials.js";

test("concurrent expired Codex auth refreshes through Platform once and observes rotated credentials", async (t) => {
  let access = "expired-token";
  let expires = Math.floor(Date.now() / 1000) - 60;
  let refreshes = 0;
  let unavailable = false;
  let selectedModel = "gpt-5.4";
  let availableModel = selectedModel;
  const server = createServer(async (request, response) => {
    if (request.url !== "/api/agent/tools/credentials/resolve" || request.headers.authorization !== "Bearer tool-secret") {
      response.writeHead(401).end();
      return;
    }
    if (unavailable) {
      response.writeHead(503).end("secret upstream diagnostic");
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body) as { force_refresh: boolean; model: string };
    if (input.model !== availableModel) {
      response.writeHead(409).end("Model no longer available");
      return;
    }
    if (input.force_refresh) {
      refreshes++;
      access = "refreshed-token";
      expires = Math.floor(Date.now() / 1000) + 3600;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      access_token: access, expires_at: expires,
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const runtime = await createModelRuntime(url, "tool-secret", () => selectedModel);
  const results = await Promise.all([runtime.getAuth("openai-codex"), runtime.getAuth("openai-codex")]);
  assert.deepEqual(results.map((result) => result?.auth.apiKey), ["refreshed-token", "refreshed-token"]);
  assert.equal(refreshes, 1);

  access = "externally-rotated-token";
  assert.equal((await runtime.getAuth("openai-codex"))?.auth.apiKey, access);
  // A session can change model while the original model leaves the catalog.
  availableModel = "gpt-5.3-codex";
  selectedModel = availableModel;
  assert.equal((await runtime.getAuth("openai-codex"))?.auth.apiKey, access);
  unavailable = true;
  await assert.rejects(runtime.getAuth("openai-codex"), (error: Error) => {
    assert.match(error.message, /HTTP 503/);
    assert.doesNotMatch(error.message, /secret upstream diagnostic|tool-secret|rotated-token/);
    return true;
  });
  unavailable = false;
  assert.equal((await runtime.getAuth("openai-codex"))?.auth.apiKey, access);
  await assert.rejects(runtime.logout("openai-codex"), /managed by Platform/);
});

test("credential deadline and caller cancellation interrupt a stalled JSON body", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"access_token":');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const runtime = await createModelRuntime(url, "secret", () => "gpt-5.4", 100);
  await assert.rejects(runtime.getAvailable("openai-codex"), /abort|timeout/i);
  const controller = new AbortController();
  const operation = runtime.getAvailable("openai-codex", { signal: controller.signal });
  controller.abort(new DOMException("Caller cancelled", "AbortError"));
  await assert.rejects(operation, /abort|cancel/i);
});
