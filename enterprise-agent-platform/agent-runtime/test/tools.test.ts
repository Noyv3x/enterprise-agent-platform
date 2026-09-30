import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createTools } from "../src/tools.js";
import { createExecutorTransport, createGatewayTransport, type ExecutorTransport, type Sandbox } from "../src/transport.js";

const sandbox: Sandbox = { scope_key: "private:1", workspace_id: "user-1", sandbox_id: "sandbox-1", lifecycle_id: "life-1", profile: "agent", cwd: "/workspace" };

test("remote Pi tools audit exact operations and never forward host environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-tools-"));
  const calls: { path: string; body: { audit_id: string; arguments: Record<string, unknown>; execution_context: { profile: string }; target: string; tool_call_id: string; details: Record<string, unknown> } }[] = [];
  const contents = new Map([["/workspace/a.txt", "old\n"]]);
  const executorServer = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer executor-secret");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ path: req.url!, body });
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/audit")) { res.end(JSON.stringify({ audit_id: body.audit_id, executor_id: "receipt" })); return; }
    if (req.url?.endsWith("/cancel")) { res.end('{"confirmed":true}'); return; }
    const audit = calls.at(-2)!;
    assert.equal(audit.path, "/v1/executor/audit");
    assert.equal(body.audit_id, audit.body.audit_id);
    assert.deepEqual(body.arguments, audit.body.arguments);
    assert.equal(body.execution_context.profile, "agent");
    assert.equal(body.target, "sandbox");
    assert.equal(body.tool_call_id, "call-1");
    if (req.url?.endsWith("/file")) {
      if (body.action === "write") contents.set(body.arguments.path, body.arguments.content);
      const full = contents.get(body.arguments.path) ?? "";
      const value = body.action === "read" ? full.slice(body.arguments.offset ?? 0, (body.arguments.offset ?? 0) + body.arguments.limit) : "written";
      res.end(JSON.stringify({ content: value, details: { returned: value.length, total: full.length } }));
    } else {
      if (audit.body.details.tool === "mcp") {
        const encoded = String(body.arguments.command).split("'")[1]!;
        const params = JSON.parse(Buffer.from(encoded, "base64url").toString());
        assert.deepEqual(audit.body.details, params.action === "list" ? { tool: "mcp", action: "list", arguments: {} } : { tool: "mcp", action: "call", arguments: { server: "docs", tool: "lookup" } });
        assert.equal(JSON.stringify(audit.body.details).includes("private-document"), false);
      } else assert.equal(audit.body.details.command, body.arguments.command);
      assert.equal(body.arguments.background, false);
      assert.equal("env" in body.arguments, false);
      assert.ok(Number.isFinite(body.arguments.timeout_ms));
      assert.ok(body.arguments.timeout_ms > 0 && body.arguments.timeout_ms <= 3_600_000);
      const command: string = body.arguments.command;
      const stdout = command.startsWith("/usr/local/bin/agent-platform-mcp") ? JSON.stringify(audit.body.details.action === "call" ? { result: { token: "private-document" } } : { servers: ["docs"] }) : command.includes("rg --files") ? "a.txt\u0000" : command.includes("rg --no-heading") ? "a.txt:1:new\n" : command.includes("-printf") ? "a.txt\u0000" : command.includes("mktemp") ? "/workspace/.pi-bash-test.log\n5\n0\nhello" : "";
      res.end(JSON.stringify({ result: { stdout, stderr: "", exit_code: 0, status: "completed" } }));
    }
  });
  const gatewayBodies: { path: string; action: string; context: { tool_call_id: string }; arguments: Record<string, unknown> }[] = [];
  const gatewayServer = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer gateway-secret");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    gatewayBodies.push({ path: req.url, ...JSON.parse(Buffer.concat(chunks).toString()) });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ content: "result", data: { accepted: true }, is_error: false }));
  });
  executorServer.listen(join(directory, "executor.sock")); await once(executorServer, "listening");
  gatewayServer.listen(0, "127.0.0.1"); await once(gatewayServer, "listening");
  try {
    const address = gatewayServer.address() as { port: number };
    const executor = createExecutorTransport({ socketPath: join(directory, "executor.sock"), token: "executor-secret" });
    const gateway = createGatewayTransport({ baseUrl: `http://127.0.0.1:${address.port}`, token: "gateway-secret" });
    const dependencies = { sandbox, executor, gateway, context: () => ({ sid: "agent-private-1", scope_key: sandbox.scope_key, run_id: "run-1", owner_user_id: 1 }), names: ["read", "write", "edit", "bash", "grep", "find", "ls", "web_search", "web_fetch", "browser", "schedule", "mcp"], skillsDirectory: join(directory, "skills") };
    const tools = createTools("/workspace", dependencies);
    const invoke = async (name: string, args: Record<string, unknown>) => tools.find(tool => tool.name === name)!.execute("call-1", args, undefined, undefined, {} as ExtensionToolContext);
    assert.match(JSON.stringify(await invoke("read", { path: "a.txt" })), /old/);
    await invoke("edit", { path: "a.txt", edits: [{ oldText: "old", newText: "new" }] });
    assert.equal(contents.get("/workspace/a.txt"), "new\n");
    await invoke("write", { path: "b.txt", content: "created" });
    assert.equal(contents.get("/workspace/b.txt"), "created");
    process.env.PI_REMOTE_SECRET_TEST = "must-not-forward";
    try { assert.match(JSON.stringify(await invoke("bash", { command: "printf hello" })), /hello/); }
    finally { delete process.env.PI_REMOTE_SECRET_TEST; }
    assert.equal(calls.at(-1)?.body.arguments.timeout_ms, 600_000);
    await invoke("bash", { command: "printf hello", timeout: 7200 });
    assert.equal(calls.at(-1)?.body.arguments.timeout_ms, 3_600_000);
    await invoke("bash", { command: "printf hello", timeout: 2 });
    assert.equal(calls.at(-1)?.body.arguments.timeout_ms, 2000);
    for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await executor.terminal(sandbox, { ...dependencies.context(), tool_call_id: "call-1" }, "printf hello", "/workspace", timeout);
      assert.equal(calls.at(-1)?.body.arguments.timeout_ms, 600_000);
    }
    assert.match(JSON.stringify(await invoke("grep", { pattern: "new" })), /a.txt:1:new/);
    assert.match(JSON.stringify(await invoke("find", { pattern: "*.txt" })), /a.txt/);
    assert.match(JSON.stringify(await invoke("ls", {})), /a.txt/);
    assert.match(JSON.stringify(await invoke("mcp", { action: "list" })), /docs/);
    const mcp = await invoke("mcp", { action: "call", server: "docs", tool: "lookup", arguments: { token: "private-document" } });
    assert.deepEqual(mcp.details, { result: { token: "private-document" } });
    await invoke("web_search", { query: "Pi" });
    await invoke("web_fetch", { url: "https://example.org", max_chars: 1000 });
    await invoke("browser", { action: "navigate", url: "https://example.org" });
    await invoke("schedule", { action: "create", name: "Reminder", prompt: "hello" });
    assert.deepEqual(gatewayBodies.map(body => [body.path, body.action]), [["/internal/agent/tools/web", "search"], ["/internal/agent/tools/web", "fetch"], ["/internal/agent/tools/browser", "navigate"], ["/internal/agent/tools/schedule", "create"]]);
    assert.equal(gatewayBodies[0]?.context.tool_call_id, "call-1");
    assert.equal(gatewayBodies[1]?.arguments.max_chars, 1000);
    assert.equal(await executor.cancelRun(sandbox, "run-1"), true);
    const before = calls.length;
    await assert.rejects(invoke("read", { path: "/etc/passwd" }), /outside/);
    await mkdir(join(directory, "skills", "demo"), { recursive: true });
    await writeFile(join(directory, "skills", "demo", "SKILL.md"), "bundled skill");
    assert.match(JSON.stringify(await invoke("read", { path: "/platform-skills/demo/SKILL.md" })), /bundled skill/);
    await assert.rejects(invoke("write", { path: "/platform-skills/demo/SKILL.md", content: "no" }), /outside/);
    await writeFile(join(directory, "outside"), "private");
    await symlink(join(directory, "outside"), join(directory, "skills", "escape"));
    await assert.rejects(invoke("read", { path: "/platform-skills/escape" }), /escapes/);
    assert.equal(calls.length, before);
    const chatTools = createTools("/workspace/conversation-a", { ...dependencies, sandbox: { ...sandbox, profile: "chat", scope_key: "chat:1" } });
    assert.equal(chatTools.some(tool => ["browser", "schedule", "mcp"].includes(tool.name)), false);
    for (const name of ["read", "write", "edit", "grep", "find", "ls"]) {
      const tool = chatTools.find(value => value.name === name)!;
      await assert.rejects(tool.execute("chat-call", { path: "../conversation-b", content: "x", edits: [{ oldText: "x", newText: "y" }], pattern: "x" }, undefined, undefined, {} as ExtensionToolContext), /outside/);
    }
    assert.equal(calls.length, before);
  } finally {
    executorServer.close(); gatewayServer.close();
    await Promise.all([once(executorServer, "close"), once(gatewayServer, "close")]);
    await rm(directory, { recursive: true, force: true });
  }
});

test("remote reads preserve large UTF-8 and binary bytes and reject clipped chunks before edit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-remote-files-"));
  const shell = promisify(execFile);
  let clipped = false;
  const executor: ExecutorTransport = {
    async terminal(_sandbox, _context, command) {
      const { stdout } = await shell("bash", ["-c", command.replaceAll("/workspace", directory)], { maxBuffer: 2_000_000 });
      return { stdout: (clipped && command.includes("base64") ? stdout.slice(4) : stdout).replaceAll(directory, "/workspace"), stderr: "", exit_code: 0, status: "completed" };
    },
    async file(_sandbox, _context, action, args) {
      const filename = String(args.path).replace("/workspace", directory);
      if (action === "write") { await writeFile(filename, String(args.content)); return { content: "", details: {} }; }
      const data = await readFile(filename);
      const offset = Number(args.offset ?? 0);
      const bytes = data.subarray(offset, offset + Number(args.limit));
      return { content: bytes.toString("utf8"), details: { total: data.length, returned: bytes.length } };
    },
    async cancelRun() { return true; },
  };
  const tools = createTools("/workspace", { sandbox, executor, gateway: { async call() { throw new Error("unused"); } },
    context: () => ({ sid: "files", scope_key: sandbox.scope_key, run_id: "files" }), names: ["read", "edit", "bash"] });
  const invoke = (name: string, args: Record<string, unknown>) => tools.find(tool => tool.name === name)!.execute("files", args, undefined, undefined, {} as ExtensionToolContext);
  try {
    for (const original of ["prefix\n" + "a".repeat(999_992) + "🙂suffix\n", "prefix\n\ufffd" + "b".repeat(1_100_000) + "\nsuffix\n"]) {
      await writeFile(join(directory, "large.txt"), original);
      await invoke("edit", { path: "large.txt", edits: [{ oldText: "suffix", newText: "changed" }] });
      assert.equal(await readFile(join(directory, "large.txt"), "utf8"), original.replace("suffix", "changed"));
      clipped = true;
      await assert.rejects(invoke("edit", { path: "large.txt", edits: [{ oldText: "changed", newText: "lost" }] }), /Incomplete sandbox binary read/);
      assert.equal(await readFile(join(directory, "large.txt"), "utf8"), original.replace("suffix", "changed"));
      clipped = false;
    }
    const binary = Buffer.concat([Buffer.from([0xff, 0, 0xfe]), Buffer.alloc(1_100_000, 65), Buffer.from("\nBINARY-END\n")]);
    await writeFile(join(directory, "binary.dat"), binary);
    const read = await invoke("read", { path: "binary.dat", offset: 2 });
    assert.match(JSON.stringify(read.content), /BINARY-END/);
    const result = await invoke("bash", { command: "printf 'START\\n'; for ((i=0;i<2500;i++)); do printf '%0500d\\n' \"$i\"; done; printf 'END\\n'" });
    assert.ok(result.details && typeof result.details === "object" && "fullOutputPath" in result.details && typeof result.details.fullOutputPath === "string");
    const spill = result.details.fullOutputPath;
    assert.ok(spill.startsWith("/workspace/.pi-bash-"));
    const full = await readFile(spill.replace("/workspace", directory), "utf8");
    assert.ok(full.startsWith("START\n")); assert.ok(full.endsWith("END\n"));
    assert.equal(Buffer.byteLength(full), 1_252_510);
    assert.match(JSON.stringify(await invoke("read", { path: spill, offset: 2502 })), /END/);
    assert.ok(JSON.stringify(result.content).length < 55_000);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("browser screenshot and vision deliver image content without image details", async () => {
  const image = { mimeType: "image/png", data: "iVBORw0KGgo=", bytes: 8 };
  const tools = createTools("/workspace", { sandbox, executor: {} as ExecutorTransport,
    gateway: { async call() { return { content: "tab preview", data: { tabId: "tab", screenshot: image, snapshot: "page" }, is_error: false }; } },
    context: () => ({ sid: "images", scope_key: sandbox.scope_key, run_id: "images" }), names: ["browser"] });
  for (const action of ["screenshot", "vision"]) {
    const result = await tools[0]!.execute("image", { action, tab_id: "tab" }, undefined, undefined, {} as ExtensionToolContext);
    assert.deepEqual(result.content, [{ type: "text", text: "tab preview" }, { type: "image", mimeType: image.mimeType, data: image.data }]);
    assert.deepEqual(result.details, { tabId: "tab", snapshot: "page" });
  }
});

test("gateway deadline bounds stalled bodies even with SDK cancellation signal", async t => {
  const originalTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", () => originalTimeout(50));
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"content":');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const gateway = createGatewayTransport({ baseUrl: `http://127.0.0.1:${address.port}`, token: "test" });
    const controller = new AbortController();
    await assert.rejects(gateway.call("browser", "screenshot", {}, { sid: "deadline", scope_key: sandbox.scope_key, run_id: "deadline" }, controller.signal), /abort|timeout/i);
    assert.equal(controller.signal.aborted, false);
    const cancelled = new AbortController();
    cancelled.abort(new Error("user cancelled"));
    await assert.rejects(gateway.call("web", "search", {}, { sid: "cancel", scope_key: sandbox.scope_key, run_id: "cancel" }, cancelled.signal), /user cancelled/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
