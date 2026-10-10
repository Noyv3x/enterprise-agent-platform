import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { LiveBuffer } from "../src/live-events.js";
import { createTools } from "../src/tools.js";
import { createExecutorTransport, type ExecutorTransport, type OutputListener, type Sandbox } from "../src/transport.js";
import { noProcesses } from "./fakes.js";

// A subagent scope: it keeps the foreground bash whose live output this test exercises.
const sandbox: Sandbox = { scope_key: "private:1/delegate/bg-1", workspace_id: "user-1", sandbox_id: "sandbox-1", lifecycle_id: "life-1", profile: "agent", cwd: "/workspace" };
const context = { sid: "s", scope_key: sandbox.scope_key, run_id: "run-1", tool_call_id: "call-1" };
const result = { stdout: "out", stderr: "", exit_code: 0, status: "completed" };

async function executorSocket(handler: (headers: IncomingHttpHeaders, respond: Parameters<Parameters<typeof createServer>[1] & object>[1]) => void) {
  const directory = await mkdtemp(join(tmpdir(), "pi-stream-"));
  const socket = join(directory, "executor.sock");
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    if (req.url?.endsWith("/audit")) { res.setHeader("content-type", "application/json"); res.end('{"audit_id":"a","executor_id":"e"}'); return; }
    handler(req.headers, res);
  });
  server.listen(socket);
  await once(server, "listening");
  return { transport: createExecutorTransport({ socketPath: socket, token: "t" }), async stop() { server.closeAllConnections(); server.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("terminal parses NDJSON frames, delivers output in order and resolves the result frame", async () => {
  const seen: (string | undefined)[] = [];
  const f = await executorSocket((headers, res) => {
    seen.push(headers.accept);
    res.setHeader("content-type", "application/x-ndjson");
    const frames = [{ type: "output", stream: "stderr", data: "héllo " }, { type: "output", stream: "stdout", data: "x" }, { type: "output", stream: "stderr", data: "wörld\n" }, { type: "result", result }];
    const wire = Buffer.from(frames.map(frame => JSON.stringify(frame)).join("\n") + "\n");
    // Split inside a multi-byte character and inside a frame.
    const cut = wire.indexOf(Buffer.from("é")) + 1;
    res.write(wire.subarray(0, cut));
    setTimeout(() => res.end(wire.subarray(cut)), 20);
  });
  try {
    const live: [string, string][] = [];
    const output = await f.transport.terminal(sandbox, context, "cmd", "/workspace", 1000, undefined, undefined, (stream, data) => live.push([stream, data]));
    assert.deepEqual(output, result);
    assert.deepEqual(live, [["stderr", "héllo "], ["stdout", "x"], ["stderr", "wörld\n"]]);
    assert.deepEqual(seen, ["application/x-ndjson"]);
  } finally { await f.stop(); }
});

test("terminal falls back to plain JSON from an older Manager and sends no Accept without a listener", async () => {
  const accepts: (string | undefined)[] = [];
  const f = await executorSocket((headers, res) => { accepts.push(headers.accept); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ result })); });
  try {
    const live: string[] = [];
    assert.deepEqual(await f.transport.terminal(sandbox, context, "cmd", "/workspace", 1000, undefined, undefined, (_stream, data) => live.push(data)), result);
    assert.deepEqual(await f.transport.terminal(sandbox, context, "cmd", "/workspace", 1000), result);
    assert.deepEqual(live, []);
    assert.deepEqual(accepts, ["application/x-ndjson", undefined]);
  } finally { await f.stop(); }
});

test("terminal rejects stream error frames, truncated streams and ordinary HTTP errors", async () => {
  const modes = ["error", "truncated", "http"];
  const f = await executorSocket((_headers, res) => {
    const mode = modes.shift();
    if (mode === "http") { res.statusCode = 409; res.setHeader("content-type", "application/json"); res.end('{"error":"busy"}'); return; }
    res.setHeader("content-type", "application/x-ndjson");
    res.write('{"type":"output","stream":"stdout","data":"a"}\n');
    res.end(mode === "error" ? '{"type":"error","status":502,"error":"sandbox lost"}\n' : "");
  });
  try {
    const live: string[] = [];
    const run = () => f.transport.terminal(sandbox, context, "cmd", "/workspace", 1000, undefined, undefined, (_stream, data) => live.push(data));
    await assert.rejects(run(), /sandbox lost/);
    await assert.rejects(run(), /without a result/);
    await assert.rejects(run(), /busy/);
    assert.deepEqual(live, ["a", "a"]);
  } finally { await f.stop(); }
});

test("terminal ignores a throwing listener", async () => {
  const f = await executorSocket((_headers, res) => {
    res.setHeader("content-type", "application/x-ndjson");
    res.end(`{"type":"output","stream":"stdout","data":"a"}\n${JSON.stringify({ type: "result", result })}\n`);
  });
  try { assert.deepEqual(await f.transport.terminal(sandbox, context, "cmd", "/workspace", 1000, undefined, undefined, () => { throw new Error("boom"); }), result); }
  finally { await f.stop(); }
});

test("LiveBuffer sends the first text at once, coalesces the rest in order and flushes on close", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const sent: string[] = [];
  const buffer = new LiveBuffer({ intervalMs: 50, send: text => sent.push(text) });
  buffer.push("a");
  assert.deepEqual(sent, ["a"]);
  for (const part of ["b", "c", "d"]) buffer.push(part);
  assert.deepEqual(sent, ["a"]);
  t.mock.timers.tick(49);
  assert.deepEqual(sent, ["a"]);
  t.mock.timers.tick(1);
  assert.deepEqual(sent, ["a", "bcd"]);
  buffer.push("e");
  buffer.close();
  assert.deepEqual(sent, ["a", "bcd", "e"]);
  buffer.push("ignored");
  assert.deepEqual(sent, ["a", "bcd", "e"]);
});

test("LiveBuffer enforces its byte cap on a character boundary and reports the limit once", () => {
  const sent: string[] = [];
  let limits = 0;
  const buffer = new LiveBuffer({ intervalMs: 1000, limitBytes: 10, send: text => sent.push(text), onLimit: () => limits++ });
  buffer.push("ab");
  buffer.push("界界界界");
  buffer.push("more");
  assert.deepEqual(sent, ["ab", "界界"]);
  assert.equal(limits, 1);
});

// Runs the wrapper under sh like Manager does, forwarding stderr as live output.
function localExecutor(directory: string): ExecutorTransport {
  return {
    ...noProcesses,
    async terminal(_sandbox, _context, command, _cwd, _timeout, _signal, _details, onOutput?: OutputListener) {
      const child = spawn("sh", ["-c", command.replaceAll("/workspace", directory)], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", chunk => onOutput?.("stderr", chunk.replaceAll(directory, "/workspace")));
      const [code] = await once(child, "close") as [number];
      return { stdout: stdout.replaceAll(directory, "/workspace"), stderr: "", exit_code: code, status: "completed" };
    },
    async file() { throw new Error("unused"); },
    async cancelRun() { return true; },
  };
}

test("bash streams ordered live output while the final result, exit code and spill behavior stay exact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-bash-live-"));
  try {
    const live: [string, string][] = [];
    const tools = createTools("/workspace", { sandbox, executor: localExecutor(directory), gateway: { async call() { throw new Error("unused"); } },
      context: () => ({ sid: "s", scope_key: sandbox.scope_key, run_id: "run-1" }), names: ["bash"], output: (id, text) => live.push([id, text]) });
    const invoke = (command: string) => tools[0]!.execute("call-9", { command }, undefined, undefined, {} as ExtensionToolContext);

    // Real shell and real time: the ordering of live output relative to the command's own pauses is the behavior under test.
    const small = await invoke("printf one; sleep 0.3; printf two >&2; sleep 0.3; printf three");
    assert.deepEqual(small.content, [{ type: "text", text: "onetwothree" }]);
    assert.deepEqual(small.details, {});
    assert.equal(live.length > 1, true);
    assert.deepEqual([...new Set(live.map(([id]) => id))], ["call-9"]);
    assert.equal(live.map(([, text]) => text).join(""), "onetwothree");

    live.length = 0;
    await assert.rejects(invoke("printf failing; exit 3"), /failing\n\nCommand exited with code 3/);
    assert.equal(live.map(([, text]) => text).join(""), "failing");

    live.length = 0;
    const empty = await invoke("true");
    assert.deepEqual(empty.content, [{ type: "text", text: "(no output)" }]);
    assert.equal(live.length, 0);

    // A background process holding the output file open must not stall the call.
    const started = Date.now();
    await invoke("sleep 5 & printf bg");
    assert.ok(Date.now() - started < 3000);

    live.length = 0;
    const large = await invoke("for i in $(seq 1 2500); do printf '%0100d\\n' \"$i\"; done");
    assert.ok(large.details && typeof large.details === "object" && "fullOutputPath" in large.details && typeof large.details.fullOutputPath === "string");
    const spill = large.details.fullOutputPath;
    assert.ok(spill.startsWith("/workspace/.pi-bash-"));
    const full = await readFile(spill.replace("/workspace", directory), "utf8");
    assert.equal(Buffer.byteLength(full), 2500 * 101);
    assert.equal(live.map(([, text]) => text).join(""), full);
    assert.match(JSON.stringify(large.content), /Output truncated\. Full output: \/workspace\/\.pi-bash-/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
