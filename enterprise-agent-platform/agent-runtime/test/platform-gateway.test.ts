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

test("PlatformGateway preserves memory actions and recursively enforces trusted ownership", async () => {
  const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    bodies.push({
      path: request.url || "",
      body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>,
    });
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const gateway = new PlatformGateway(`http://127.0.0.1:${address.port}`, "token");
    const request: RunRequest = {
      scope_key: "private:42",
      lifecycle_id: "life",
      session_id: "current-session",
      workspace: "/tmp",
      system_prompt: "system",
      input: "input",
      model: { provider: "openai-codex", id: "gpt-5" },
      metadata: {
        actor: { id: 42 },
        idempotency_key: "agent-job:77",
        source_message_id: 88,
      },
    };

    await gateway.invoke(request, "run-read", "memory", "read", {
      id: 9,
      target: "user",
      owner_user_id: 999,
    });
    await gateway.invoke(request, "run-batch", "memory", "store", {
      owner_user_id: 999,
      operations: [
        { action: "add", target: "user", owner_user_id: 7, content: "one" },
        { action: "clear", target: "user", owner_user_id: 8 },
      ],
    });
    await gateway.invoke(request, "run-propose", "memory", "propose", {
      category: "preference",
      target: "user",
      content: "  Prefers   concise replies  ",
      source_run_id: "forged",
      source_message_id: 999,
      source_type: "manual",
      candidate_hash: "forged",
    });
    const actorless = {
      ...request,
      metadata: { idempotency_key: "agent-job:999" },
    };
    await gateway.invoke(actorless, "run-no-owner", "memory", "store", {
      owner_user_id: 999,
      operations: [{ action: "clear", target: "user", owner_user_id: 999 }],
    });

    assert.equal(bodies[0]?.path, "/api/agent/tools/memory/search");
    assert.deepEqual(bodies[0]?.body, {
      id: 9,
      target: "user",
      owner_user_id: 42,
      scope_key: "private:42",
      lifecycle_id: "life",
      session_id: "current-session",
      run_id: "run-read",
      action: "read",
    });
    assert.equal(bodies[1]?.path, "/api/agent/tools/memory");
    assert.equal(bodies[1]?.body.action, "add");
    assert.equal(bodies[1]?.body.owner_user_id, 42);
    assert.equal(bodies[1]?.body.source_run_id, "run-batch");
    assert.equal(bodies[1]?.body.source_message_id, 88);
    assert.equal(bodies[1]?.body.source_type, "tool");
    assert.deepEqual(bodies[1]?.body.operations, [
      {
        action: "add",
        target: "user",
        owner_user_id: 42,
        content: "one",
        source_run_id: "run-batch",
        source_message_id: 88,
        source_type: "tool",
      },
      {
        action: "clear",
        target: "user",
        owner_user_id: 42,
        source_run_id: "run-batch",
        source_message_id: 88,
        source_type: "tool",
      },
    ]);
    assert.equal(bodies[2]?.body.source_run_id, "run-propose");
    assert.equal(bodies[2]?.body.source_message_id, 88);
    assert.equal(bodies[2]?.body.source_type, "tool");
    assert.equal(Object.hasOwn(bodies[2]?.body || {}, "candidate_hash"), false);
    assert.equal(Object.hasOwn(bodies[3]?.body || {}, "owner_user_id"), false);
    assert.deepEqual(bodies[3]?.body.operations, [
      { action: "clear", target: "user", source_run_id: "run-no-owner", source_type: "tool" },
    ]);
    assert.equal(Object.hasOwn(bodies[3]?.body || {}, "source_message_id"), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("PlatformGateway forwards typed platform session-search actions within the trusted scope", async () => {
  let body: Record<string, unknown> = {};
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ mode: "read", found: true, session: { session_id: "historical" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const gateway = new PlatformGateway(`http://127.0.0.1:${address.port}`, "token");
    await gateway.invoke({
      scope_key: "private:1",
      lifecycle_id: "current-life",
      session_id: "current-session",
      workspace: "/tmp",
      system_prompt: "system",
      input: "input",
      model: { provider: "openai-codex", id: "gpt-5" },
      metadata: { actor: { id: 1 } },
    }, "run", "session", "read", { session_id: "historical", limit: 80 });
    assert.deepEqual(body, {
      session_id: "historical",
      limit: 80,
      scope_key: "private:1",
      lifecycle_id: "current-life",
      run_id: "run",
      action: "read",
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
