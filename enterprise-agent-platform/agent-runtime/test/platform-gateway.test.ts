import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { PlatformGateway } from "../src/platform-gateway.js";
import type { RunRequest } from "../src/types.js";

test("PlatformGateway adapts memory and credential calls to protected platform routes", async () => {
  const seen: string[] = [];
  let memoryBody: Record<string, unknown> = {};
  let scheduleBody: Record<string, unknown> = {};
  let credentialBody: Record<string, unknown> = {};
  const server = createServer(async (request, response) => {
    seen.push(`${request.method} ${request.url} ${request.headers.authorization || ""}`);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (request.url === "/api/agent/tools/memory/search") {
      memoryBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    } else if (request.url === "/internal/agent/tools/schedule") {
      scheduleBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    } else if (request.url === "/api/agent/tools/credentials/resolve") {
      credentialBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
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
      model: { provider: "openai-codex", id: "requested-model" },
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
    assert.deepEqual(credentialBody, {
      provider: "openai-codex",
      model: "requested-model",
      scope_key: "scope",
    });
    assert.ok(seen.every((entry) => entry.endsWith("Bearer rotated-token")));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("PlatformGateway forwards schedule identity only for a valid top-level scheduled occurrence", async () => {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: { completed: true } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const gateway = new PlatformGateway(`http://127.0.0.1:${address.port}`, "token");
    const request: RunRequest = {
      scope_key: "private:42",
      lifecycle_id: "life",
      session_id: "session",
      workspace: "/workspace",
      system_prompt: "system",
      input: "input",
      model: { provider: "openai-codex", id: "gpt-5" },
      metadata: {
        actor: { id: 42 },
        source_message_id: 99,
        trigger: "scheduled",
        unattended: true,
        schedule_id: "7",
        schedule_run_id: "45",
        schedule_recurring: true,
      },
    };
    await gateway.invoke(request, "scheduled-run", "schedule", "complete_current", {});
    await gateway.invoke({
      ...request,
      metadata: { ...request.metadata, trigger: "interactive", unattended: false },
    }, "ordinary-run", "schedule", "complete_current", {});
    await gateway.invoke({
      ...request,
      metadata: { ...request.metadata, schedule_run_id: "not-an-id" },
    }, "invalid-run", "schedule", "complete_current", {});

    assert.deepEqual((bodies[0]?.context as Record<string, unknown>), {
      run_id: "scheduled-run",
      scope_key: "private:42",
      lifecycle_id: "life",
      session_id: "session",
      workspace: "/workspace",
      owner_user_id: 42,
      source_message_id: 99,
      trigger: "scheduled",
      unattended: true,
      schedule_id: "7",
      schedule_run_id: "45",
      schedule_recurring: true,
    });
    for (const body of bodies.slice(1)) {
      const context = body.context as Record<string, unknown>;
      assert.equal(context.schedule_id, undefined);
      assert.equal(context.schedule_run_id, undefined);
      assert.equal(context.schedule_recurring, undefined);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("PlatformGateway forwards mail through the internal boundary with trusted tool-call identity", async () => {
  let body: Record<string, unknown> = {};
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: { status: "succeeded" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const gateway = new PlatformGateway(`http://127.0.0.1:${address.port}`, "token");
    const request: RunRequest = {
      scope_key: "private:42",
      lifecycle_id: "life",
      session_id: "session",
      workspace: "/workspace",
      system_prompt: "system",
      input: "input",
      model: { provider: "openai-codex", id: "gpt-5" },
      metadata: { actor: { id: 42 }, trigger: "email", unattended: false },
    };
    await gateway.invoke(
      request,
      "run-mail",
      "mail",
      "send",
      { account_id: 3, to: ["user@example.com"], subject: "Hello", text_body: "private" },
      undefined,
      "call-mail",
    );
    assert.equal(body.tool, "mail");
    assert.equal(body.action, "send");
    assert.deepEqual(body.arguments, {
      account_id: 3,
      to: ["user@example.com"],
      subject: "Hello",
      text_body: "private",
    });
    assert.deepEqual(body.context, {
      run_id: "run-mail",
      scope_key: "private:42",
      lifecycle_id: "life",
      session_id: "session",
      workspace: "/workspace",
      owner_user_id: 42,
      tool_call_id: "call-mail",
      trigger: "email",
      unattended: false,
    });
    await assert.rejects(
      gateway.invoke(request, "run", "mail", "delete", {}, undefined, "call"),
      /mail action is not supported/,
    );
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
    await gateway.invoke(request, "run-replace", "memory", "replace", {
      id: 12,
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
    assert.equal(bodies[1]?.body.source_type, "automatic");
    assert.deepEqual(bodies[1]?.body.operations, [
      {
        action: "add",
        target: "user",
        owner_user_id: 42,
        content: "one",
        source_run_id: "run-batch",
        source_message_id: 88,
        source_type: "automatic",
      },
      {
        action: "clear",
        target: "user",
        owner_user_id: 42,
        source_run_id: "run-batch",
        source_message_id: 88,
        source_type: "automatic",
      },
    ]);
    assert.equal(bodies[2]?.body.action, "replace");
    assert.equal(bodies[2]?.body.source_run_id, "run-replace");
    assert.equal(bodies[2]?.body.source_message_id, 88);
    assert.equal(bodies[2]?.body.source_type, "automatic");
    assert.equal(Object.hasOwn(bodies[2]?.body || {}, "candidate_hash"), false);
    assert.equal(Object.hasOwn(bodies[3]?.body || {}, "owner_user_id"), false);
    assert.deepEqual(bodies[3]?.body.operations, [
      { action: "clear", target: "user", source_run_id: "run-no-owner", source_type: "automatic" },
    ]);
    assert.equal(Object.hasOwn(bodies[3]?.body || {}, "source_message_id"), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("PlatformGateway forwards trusted learning-review context and normalizes reconcile operations", async () => {
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
      session_id: "learning-review-7",
      workspace: "/workspace",
      system_prompt: "system",
      input: "review",
      model: { provider: "openai-codex", id: "gpt-5" },
      metadata: {
        actor: { id: 42 },
        source_message_id: 88,
        trigger: "learning_review",
        review_mode: "memory_skill",
        review_job_id: 7,
        idempotency_key: "agent-learning-review:7",
        unattended: true,
        delegation_depth: 0,
      },
    };
    await gateway.invoke(request, "review-run", "memory", "reconcile", {
      review_job_id: 999,
      operations: [
        { action: "store", target: "memory", content: "Stable fact" },
        { action: "forget", target: "memory", id: 3 },
      ],
    });
    await gateway.invoke(request, "review-run", "memory", "search", { query: "stable" });
    await gateway.invoke(request, "review-run", "memory", "read", { id: 3 });
    await gateway.invoke(request, "review-run", "memory", "list", {});
    await gateway.invoke(request, "review-run", "skill", "patch", {
      id: "review-code",
      old_string: "old",
      new_string: "new",
    });

    assert.equal(bodies[0]?.path, "/api/agent/tools/memory");
    assert.equal(bodies[0]?.body.action, "reconcile");
    assert.equal(bodies[0]?.body.review_mode, "memory_skill");
    assert.equal(bodies[0]?.body.review_job_id, 7);
    assert.equal(bodies[0]?.body.source_message_id, 88);
    assert.deepEqual(bodies[0]?.body.operations, [
      {
        action: "add",
        target: "memory",
        content: "Stable fact",
        owner_user_id: 42,
        source_run_id: "review-run",
        source_message_id: 88,
        source_type: "automatic",
      },
      {
        action: "remove",
        target: "memory",
        id: 3,
        owner_user_id: 42,
        source_run_id: "review-run",
        source_message_id: 88,
        source_type: "automatic",
      },
    ]);
    for (const [index, action] of ["search", "read", "list"].entries()) {
      const read = bodies[index + 1];
      assert.equal(read?.path, "/api/agent/tools/memory/search");
      assert.equal(read?.body.action, action);
      assert.equal(read?.body.review_mode, "memory_skill");
      assert.equal(read?.body.review_job_id, 7);
      assert.equal(read?.body.parent_run_id, "");
      assert.equal(read?.body.delegation_depth, 0);
      assert.equal(read?.body.trigger, "learning_review");
      assert.equal(read?.body.unattended, true);
      assert.equal(read?.body.source_message_id, 88);
    }
    const skillContext = bodies[4]?.body.context as Record<string, unknown>;
    assert.equal(skillContext.review_mode, "memory_skill");
    assert.equal(skillContext.review_job_id, 7);
    assert.equal(skillContext.trigger, "learning_review");
    assert.equal(skillContext.unattended, true);
    assert.equal(skillContext.source_message_id, 88);
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

test("PlatformGateway rejects removed action and argument aliases before transport", async () => {
  const gateway = new PlatformGateway("http://127.0.0.1:1", "token");
  const request = {
    scope_key: "private:42",
    lifecycle_id: "life",
    session_id: "session",
    workspace: "/workspace",
    model: { provider: "openai-codex", id: "gpt-5" },
  } as never;

  await assert.rejects(
    gateway.invoke(request, "run", "memory", "delete", { id: 1 }),
    /memory action is not supported/,
  );
  await assert.rejects(
    gateway.invoke(request, "run", "session", "get", {}),
    /session action must be search, list, or read/,
  );
  await assert.rejects(
    gateway.invoke(request, "run", "web", "query", { query: "test" }),
    /web action must be search or extract/,
  );
});

test("PlatformGateway keeps Skill model arguments separate from authoritative run context", async () => {
  let body: Record<string, unknown> = {};
  let path = "";
  const server = createServer(async (request, response) => {
    path = request.url || "";
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: { skill: { id: "code-review" } } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const gateway = new PlatformGateway(`http://127.0.0.1:${address.port}`, "token");
    await gateway.invoke({
      scope_key: "private:42",
      lifecycle_id: "trusted-life",
      session_id: "trusted-session",
      workspace: "/trusted/workspace",
      system_prompt: "system",
      input: "input",
      model: { provider: "openai-codex", id: "gpt-5" },
      metadata: { actor: { id: 42 }, source_message_id: 77 },
    }, "trusted-run", "skill", "load", {
      id: "code-review",
      scope_key: "forged-scope",
      lifecycle_id: "forged-life",
      owner_user_id: 999,
    });

    assert.equal(path, "/internal/agent/tools/skill");
    assert.equal(body.tool, "skill");
    assert.equal(body.action, "load");
    assert.deepEqual(body.arguments, {
      id: "code-review",
      scope_key: "forged-scope",
      lifecycle_id: "forged-life",
      owner_user_id: 999,
    });
    // Reserved fields stay in the model-controlled arguments object, where the
    // platform rejects them; they cannot replace the trusted context envelope.
    assert.deepEqual(body.context, {
      run_id: "trusted-run",
      scope_key: "private:42",
      lifecycle_id: "trusted-life",
      session_id: "trusted-session",
      workspace: "/trusted/workspace",
      owner_user_id: 42,
      source_message_id: 77,
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
