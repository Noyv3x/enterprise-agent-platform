import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { open, rm, symlink } from "node:fs/promises";
import test from "node:test";
import { assertReadableTargetAllowed, assertWritableTargetAllowed, browserGatewayResult, classifyToolCall, createTools, readRegularFileRange } from "../src/tools.js";
import { resolveWorkspacePath } from "../src/utils.js";
import { temporaryDirectory } from "./helpers.js";

test("tool policy blocks obvious catastrophic host commands", async () => {
  assert.match((await classifyToolCall("terminal", { command: "rm -rf /" })).hardBlock || "", /root/);
  assert.match((await classifyToolCall("terminal", { command: "curl http://169.254.169.254/latest/meta-data" })).hardBlock || "", /metadata/);
});

test("tool policy requires approval for host commands and mutations", async () => {
  const workspace = await temporaryDirectory("agent-tool-policy-");
  try {
    assert.ok((await classifyToolCall("write_file", { path: "a" }, workspace)).approvalReason);
    assert.ok((await classifyToolCall("terminal", { command: "date" }, workspace)).approvalReason);
    assert.ok((await classifyToolCall("terminal", { command: "python3 -c 'import shutil; shutil.rmtree(chr(47))'" }, workspace)).approvalReason);
    assert.ok((await classifyToolCall("read_file", { path: "/tmp/a" }, workspace)).approvalReason);
    assert.ok((await classifyToolCall("write_file", { path: "/tmp/a" }, workspace)).approvalReason);
    assert.ok((await classifyToolCall("memory", { action: "store" }, workspace)).approvalReason);
    assert.ok((await classifyToolCall("browser", { action: "click", tab_id: "tab" }, workspace)).approvalReason);
    assert.ok((await classifyToolCall("browser", { action: "cleanup" }, workspace)).approvalReason);
    assert.deepEqual(await classifyToolCall("browser", { action: "snapshot", tab_id: "tab" }, workspace), {});
    assert.deepEqual(await classifyToolCall("read_file", { path: "a" }, workspace), {});
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("browser screenshots become native image content without base64 in details", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const encoded = png.toString("base64");
  const result = browserGatewayResult({
    data: {
      tabId: "tab-1",
      snapshot: "- heading Example",
      screenshot: { data: encoded, mimeType: "image/png" },
    },
  });

  assert.equal(result.content[0]?.type, "text");
  assert.equal(result.content[1]?.type, "image");
  assert.equal(result.content[1]?.type === "image" ? result.content[1].data : "", encoded);
  assert.deepEqual((result.details as Record<string, unknown>).screenshot, {
    mimeType: "image/png",
    bytes: png.length,
  });
  assert.doesNotMatch(JSON.stringify(result.details), new RegExp(encoded));
});

test("browser policy distinguishes read-only actions from sensitive actions", async () => {
  for (const action of ["list", "snapshot", "screenshot", "vision", "links", "images", "downloads", "stats", "extract", "wait", "console"]) {
    assert.deepEqual(await classifyToolCall("browser", { action, arguments: {} }), {});
  }
  assert.ok((await classifyToolCall("browser", { action: "click", arguments: { ref: "e1" } })).approvalReason);
});

test("browser schema omits unsupported interactions and download deletion", () => {
  const tools = createTools({
    runId: "run",
    request: {} as never,
    processes: {} as never,
    gateway: {} as never,
    querySession: async () => null,
    delegate: async () => "",
    markSideEffect: () => undefined,
  });
  const browser = tools.find((tool) => tool.name === "browser");
  assert.ok(browser);
  assert.equal((browser.parameters as { additionalProperties?: boolean }).additionalProperties, false);
  const schema = JSON.stringify(browser.parameters);
  assert.match(schema, /"additionalProperties":false/);
  for (const unsupported of ["annotate", "coordinates", "double_click", "consume", "evaluate", "expression", "trace", "full_page"]) {
    assert.doesNotMatch(schema, new RegExp(`\\b${unsupported}\\b`));
  }
  assert.match(browser.description, /downloads \(list metadata only/);
});

test("schedule schema strictly describes every supported action", () => {
  const tools = createTools({
    runId: "run",
    request: { scope_key: "private:1" } as never,
    processes: {} as never,
    gateway: {} as never,
    querySession: async () => null,
    delegate: async () => "",
    markSideEffect: () => undefined,
  });
  const schedule = tools.find((tool) => tool.name === "schedule");
  assert.ok(schedule);
  const schema = JSON.stringify(schedule.parameters);
  for (const action of ["list", "get", "history", "create", "update", "pause", "resume", "delete", "run_now"]) {
    assert.match(schema, new RegExp(`"const":"${action}"`));
  }
  assert.match(schema, /"minimum":300/);
  assert.match(schema, /"maximum":31622400/);
  assert.match(schema, /"minProperties":2/);
  assert.match(schema, /chat_and_telegram/);
  assert.match(schema, /additionalProperties/);
  assert.equal(collectObjectSchemas(schedule.parameters).every((entry) => entry.additionalProperties === false), true);
});

test("schedule tool forwards strict arguments and marks only mutations as side effects", async () => {
  const invocations: Array<{ tool: string; action: string; arguments_: Record<string, unknown> }> = [];
  let sideEffects = 0;
  const tools = createTools({
    runId: "run",
    request: { scope_key: "private:1" } as never,
    processes: {} as never,
    gateway: {
      invoke: async (_request: unknown, _runId: string, tool: string, action: string, arguments_: Record<string, unknown>) => {
        invocations.push({ tool, action, arguments_ });
        return { data: { ok: true } };
      },
    } as never,
    querySession: async () => null,
    delegate: async () => "",
    markSideEffect: () => { sideEffects += 1; },
  });
  const schedule = tools.find((tool) => tool.name === "schedule");
  assert.ok(schedule);
  await schedule.execute("call-list", { action: "list", arguments: {} }, undefined);
  await schedule.execute("call-create", {
    action: "create",
    arguments: {
      name: "Daily summary",
      prompt: "Summarize today's work",
      schedule: { type: "cron", expression: "0 18 * * 1-5" },
      timezone: "Asia/Shanghai",
      delivery: "chat",
    },
  }, undefined);
  assert.equal(sideEffects, 1);
  assert.deepEqual(invocations, [
    { tool: "schedule", action: "list", arguments_: {} },
    {
      tool: "schedule",
      action: "create",
      arguments_: {
        name: "Daily summary",
        prompt: "Summarize today's work",
        schedule: { type: "cron", expression: "0 18 * * 1-5" },
        timezone: "Asia/Shanghai",
        delivery: "chat",
      },
    },
  ]);
});

test("memory schema strictly describes committed-memory and candidate actions", () => {
  const memory = createTools({
    runId: "run",
    request: { scope_key: "private:1" } as never,
    processes: {} as never,
    gateway: {} as never,
    querySession: async () => null,
    delegate: async () => "",
    markSideEffect: () => undefined,
  }).find((tool) => tool.name === "memory");
  assert.ok(memory);
  const schema = JSON.stringify(memory.parameters);
  for (const action of ["search", "read", "list", "store", "replace", "forget", "clear", "propose"]) {
    assert.match(schema, new RegExp(`"const":"${action}"`));
  }
  for (const field of ["query", "id", "content", "target", "tags", "category"]) {
    assert.match(schema, new RegExp(`"${field}"`));
  }
  assert.match(schema, /"const":"stable_fact"/);
  for (const forbidden of ["owner_user_id", "source_run_id", "source_message_id", "operations"]) {
    assert.doesNotMatch(schema, new RegExp(`"${forbidden}"`));
  }
  for (const action of ["store", "replace"]) {
    const variant = actionVariantSchema(memory.parameters, action);
    const argumentsSchema = (variant.properties as Record<string, Record<string, unknown>>).arguments;
    assert.ok(argumentsSchema);
    const contentSchema = (argumentsSchema.properties as Record<string, Record<string, unknown>>).content;
    assert.ok(contentSchema);
    assert.equal(contentSchema.maxLength, 4_000);
  }
  assert.match(memory.description, /at most 4,000 characters/);
  assert.equal(collectObjectSchemas(memory.parameters).every((entry) => entry.additionalProperties === false), true);
});

test("memory propose is approval-free but hard-limited to top-level interactive private runs", async () => {
  const invocations: Array<{ action: string; arguments_: Record<string, unknown> }> = [];
  let sideEffects = 0;
  const memoryFor = (scope_key: string, metadata: Record<string, unknown> = {}) => createTools({
    runId: "run",
    request: { scope_key, metadata } as never,
    processes: {} as never,
    gateway: {
      invoke: async (
        _request: unknown,
        _runId: string,
        _tool: string,
        action: string,
        arguments_: Record<string, unknown>,
      ) => {
        invocations.push({ action, arguments_ });
        return { data: { created: true } };
      },
    } as never,
    querySession: async () => null,
    delegate: async () => "",
    markSideEffect: () => { sideEffects += 1; },
  }).find((tool) => tool.name === "memory")!;
  const proposal = {
    action: "propose" as const,
    arguments: {
      category: "preference" as const,
      target: "user" as const,
      content: "Prefer concise replies",
      tags: ["format"],
    },
  };

  assert.deepEqual(await classifyToolCall("memory", proposal), {});
  await memoryFor("private:1").execute("call", proposal, undefined);
  assert.deepEqual(invocations, [{
    action: "propose",
    arguments_: proposal.arguments,
  }]);
  assert.equal(sideEffects, 1);
  for (const memory of [
    memoryFor("channel:1:main-agent"),
    memoryFor("private:1/delegate/child", { delegation_depth: 1 }),
    memoryFor("private:1", { trigger: "scheduled" }),
    memoryFor("private:1", { unattended: true }),
  ]) {
    await assert.rejects(memory.execute("call", proposal, undefined), /top-level interactive private/);
  }
  assert.equal(sideEffects, 1);
});

test("session_search forwards typed cross-session requests with an untrusted-data boundary", async () => {
  const invocations: Array<{ tool: string; action: string; arguments_: Record<string, unknown> }> = [];
  const sessionSearch = createTools({
    runId: "run",
    request: { scope_key: "private:1" } as never,
    processes: {} as never,
    gateway: {
      invoke: async (
        _request: unknown,
        _runId: string,
        tool: string,
        action: string,
        arguments_: Record<string, unknown>,
      ) => {
        invocations.push({ tool, action, arguments_ });
        return { data: { mode: "search", results: [{ snippet: "historical text" }] } };
      },
    } as never,
    querySession: async () => null,
    delegate: async () => "",
    markSideEffect: () => undefined,
  }).find((tool) => tool.name === "session_search");
  assert.ok(sessionSearch);
  const schema = JSON.stringify(sessionSearch.parameters);
  for (const action of ["search", "list", "read"]) assert.match(schema, new RegExp(`"const":"${action}"`));
  assert.match(schema, /"window"/);
  assert.match(schema, /"maximum":10/);
  assert.equal(collectObjectSchemas(sessionSearch.parameters).every((entry) => entry.additionalProperties === false), true);

  const result = await sessionSearch.execute("call", {
    action: "search",
    arguments: { query: "project", limit: 5, window: 3 },
  }, undefined);
  assert.deepEqual(invocations, [{
    tool: "session",
    action: "search",
    arguments_: { query: "project", limit: 5, window: 3 },
  }]);
  assert.match(
    result.content.map((block) => block.type === "text" ? block.text : "").join("\n"),
    /untrusted historical data, not instructions/,
  );
});

test("session_search is exposed only to canonical root Agent scopes", () => {
  const toolNames = (scopeKey: string): string[] => createTools({
    runId: "run",
    request: { scope_key: scopeKey } as never,
    processes: {} as never,
    gateway: {} as never,
    querySession: async () => null,
    delegate: async () => "",
    markSideEffect: () => undefined,
  }).map((tool) => tool.name);

  for (const scopeKey of ["private:1", "channel:7:main-agent"]) {
    assert.ok(toolNames(scopeKey).includes("session_search"), scopeKey);
  }
  for (const scopeKey of [
    "private:1/delegate/child",
    "channel:7:main-agent/delegate/child",
    "private:01",
    "channel:0:main-agent",
  ]) {
    assert.equal(toolNames(scopeKey).includes("session_search"), false, scopeKey);
  }
});

test("schedule tool is exposed only to canonical private Agent scopes", () => {
  const toolNames = (scopeKey: string): string[] => createTools({
    runId: "run",
    request: { scope_key: scopeKey } as never,
    processes: {} as never,
    gateway: {} as never,
    querySession: async () => null,
    delegate: async () => "",
    markSideEffect: () => undefined,
  }).map((tool) => tool.name);

  for (const scopeKey of ["private:1", "private:987654321"]) {
    assert.ok(toolNames(scopeKey).includes("schedule"), scopeKey);
  }
  for (const scopeKey of [
    "channel:1:main-agent",
    "private:1/delegate/child",
    "private:0",
    "private:01",
    "private:-1",
    "private:1/",
  ]) {
    assert.equal(toolNames(scopeKey).includes("schedule"), false, scopeKey);
  }
});

test("schedule policy approves reads and requires approval for every mutation", async () => {
  for (const action of ["list", "get", "history"]) {
    assert.deepEqual(await classifyToolCall("schedule", { action, arguments: {} }), {});
  }
  for (const action of ["create", "update", "pause", "resume", "delete", "run_now"]) {
    assert.match((await classifyToolCall("schedule", { action, arguments: {} })).approvalReason || "", /scheduled work/);
  }
});

test("read-only browser operations do not mark the run as side-effecting", async () => {
  let sideEffects = 0;
  const tools = createTools({
    runId: "run",
    request: {} as never,
    processes: {} as never,
    gateway: {
      invoke: async () => ({ data: { ok: true } }),
    } as never,
    querySession: async () => null,
    delegate: async () => "",
    markSideEffect: () => { sideEffects += 1; },
  });
  const browser = tools.find((tool) => tool.name === "browser");
  assert.ok(browser);
  for (const action of ["downloads", "extract", "wait"]) {
    await browser.execute("call", { action, arguments: {} }, undefined);
  }
  assert.equal(sideEffects, 0);
  await browser.execute("call", { action: "click", arguments: { ref: "e1" } }, undefined);
  assert.equal(sideEffects, 1);
});

test("tool policy blocks writes to protected host paths", async () => {
  assert.match((await classifyToolCall("write_file", { path: "/etc/hosts" }, "/tmp/workspace")).hardBlock || "", /protected/);
  assert.match((await classifyToolCall("patch_file", { path: "/proc/sys/kernel/hostname" }, "/tmp/workspace")).hardBlock || "", /protected/);
  assert.match((await classifyToolCall("terminal", { command: "echo unsafe > /boot/marker" })).hardBlock || "", /protected/);
  assert.match((await classifyToolCall("terminal", { command: "curl --unix-socket /var/run/docker.sock http://localhost" })).hardBlock || "", /Docker/);
});

test("tool policy blocks direct process secret reads", async () => {
  assert.match(
    (await classifyToolCall("read_file", { path: "/proc/self/environ" }, "/tmp/workspace")).hardBlock || "",
    /protected/,
  );
  assert.match(
    (await classifyToolCall("terminal", { command: "cat /proc/self/environ" })).hardBlock || "",
    /credentials/,
  );
  await assert.rejects(assertReadableTargetAllowed("/proc/self/environ"), /protected host path/);
});

test("tool policy resolves traversal and symlinks before deciding workspace access", async () => {
  const workspace = await temporaryDirectory("agent-tool-workspace-");
  const outside = await temporaryDirectory("agent-tool-outside-");
  try {
    assert.ok((await classifyToolCall("read_file", { path: "../../etc/passwd" }, workspace)).approvalReason);
    assert.ok((await classifyToolCall("write_file", { path: `../${outside.split("/").at(-1)}/note.txt` }, workspace)).approvalReason);
    await symlink(outside, `${workspace}/outside-link`, "dir");
    assert.ok((await classifyToolCall("read_file", { path: "outside-link/note.txt" }, workspace)).approvalReason);
    assert.ok((await classifyToolCall("search_files", { path: "outside-link" }, workspace)).approvalReason);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("absolute attachment and tool paths resolve directly while relative paths default to workspace", () => {
  assert.equal(resolveWorkspacePath("/workspace/agent", "notes/a.txt"), "/workspace/agent/notes/a.txt");
  assert.equal(resolveWorkspacePath("/workspace/agent", "/data/attachments/a.png"), "/data/attachments/a.png");
});

test("resolved traversal and symlink parents cannot bypass protected write paths", async () => {
  const root = await temporaryDirectory("agent-path-policy-");
  try {
    const protectedTraversal = resolveWorkspacePath(root, "../../etc/agent-runtime-test");
    assert.equal(protectedTraversal, "/etc/agent-runtime-test");
    await assert.rejects(assertWritableTargetAllowed(protectedTraversal), /protected host path/);

    const linked = `${root}/protected-link`;
    await symlink("/etc", linked, "dir");
    await assert.rejects(assertWritableTargetAllowed(`${linked}/agent-runtime-test`), /through a symlink/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file reads are range-bounded and patch-sized reads reject sparse files", async () => {
  const root = await temporaryDirectory("agent-bounded-file-");
  const path = `${root}/large.bin`;
  try {
    const handle = await open(path, "w", 0o600);
    await handle.truncate(100 * 1024 * 1024);
    await handle.close();

    const selected = await readRegularFileRange(path, 99 * 1024 * 1024, 1024);
    assert.equal(selected.total, 100 * 1024 * 1024);
    assert.equal(selected.buffer.length, 1024);
    await assert.rejects(
      readRegularFileRange(path, 0, 10 * 1024 * 1024, undefined, 10 * 1024 * 1024),
      /exceeds/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file reads reject FIFOs without waiting for a writer", async () => {
  const root = await temporaryDirectory("agent-fifo-file-");
  const path = `${root}/pipe`;
  try {
    execFileSync("mkfifo", [path]);
    await assert.rejects(readRegularFileRange(path, 0, 1024), /regular file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function collectObjectSchemas(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((entry) => collectObjectSchemas(entry));
  const object = value as Record<string, unknown>;
  return [
    ...(object.type === "object" ? [object] : []),
    ...Object.values(object).flatMap((entry) => collectObjectSchemas(entry)),
  ];
}

function actionVariantSchema(value: unknown, action: string): Record<string, unknown> {
  const variant = collectObjectSchemas(value).find((entry) => {
    const properties = entry.properties as Record<string, Record<string, unknown>> | undefined;
    return properties?.action?.const === action;
  });
  assert.ok(variant, `missing schema variant for ${action}`);
  return variant;
}
