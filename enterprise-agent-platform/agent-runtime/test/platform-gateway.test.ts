import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { PlatformGateway } from "../src/platform-gateway.js";
import type { RunRequest } from "../src/types.js";

test("PlatformGateway adapts memory and credential calls to protected platform routes", async () => {
  const seen: string[] = [];
  let memoryBody: Record<string, unknown> = {};
  let scheduleBody: Record<string, unknown> = {};
  const server = createServer(async (request, response) => {
    seen.push(`${request.method} ${request.url} ${request.headers.authorization || ""}`);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (request.url === "/api/agent/tools/memory/search") {
      memoryBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    } else if (request.url === "/internal/agent/tools/schedule") {
      scheduleBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    }
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/agent/tools/memory/search") response.end(JSON.stringify({ memories: [{ id: 1, content: "remembered" }] }));
    else if (request.url === "/internal/agent/tools/schedule") response.end(JSON.stringify({ data: { id: 7 } }));
    else if (request.url === "/api/agent/tools/credentials/resolve") response.end(JSON.stringify({ access_token: "fresh-token" }));
    else { response.statusCode = 404; response.end(JSON.stringify({ error: "not found" })); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const gateway = new PlatformGateway(`http://127.0.0.1:${address.port}`, "gateway-token");
    const request: RunRequest = {
      scope_key: "scope",
      lifecycle_id: "life",
      session_id: "session",
      workspace: "/tmp",
      system_prompt: "system",
      input: "input",
      model: { provider: "openai-codex", id: "gpt-5" },
      metadata: { actor: { id: 42 } },
      gateway: { base_url: "http://127.0.0.1:1", token: "rotated-token" },
    };
    const memory = await gateway.invoke(request, "run", "memory", "search", {
      query: "remember",
      owner_user_id: 999,
      scope_key: "forged-scope",
      lifecycle_id: "forged-life",
      session_id: "forged-session",
    });
    assert.match(memory.content || "", /remembered/);
    assert.equal(memoryBody.owner_user_id, 42);
    assert.equal(memoryBody.scope_key, "scope");
    assert.equal(memoryBody.lifecycle_id, "life");
    assert.equal(memoryBody.session_id, "session");
    await gateway.invoke(request, "scheduled-run", "schedule", "pause", {
      schedule_id: 7,
      scope_key: "forged-scope",
    });
    assert.equal(scheduleBody.tool, "schedule");
    assert.equal(scheduleBody.action, "pause");
    assert.deepEqual(scheduleBody.arguments, { schedule_id: 7, scope_key: "forged-scope" });
    assert.deepEqual(scheduleBody.context, {
      run_id: "scheduled-run",
      scope_key: "scope",
      lifecycle_id: "life",
      session_id: "session",
      workspace: "/tmp",
      owner_user_id: 42,
    });
    assert.equal(await gateway.token(request, "openai-codex"), "fresh-token");
    assert.ok(seen.every((entry) => entry.endsWith("Bearer rotated-token")));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
