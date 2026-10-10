import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createTools } from "../src/tools.js";
import type { GatewayResult, Sandbox } from "../src/transport.js";
import { FakeProcesses, fakeGateway, noProcesses, personal } from "./fakes.js";

const registered = (taskId = "bg-7"): GatewayResult => ({ content: taskId, data: { task_id: taskId }, is_error: false });
const textOf = (result: { content: { type: string; text?: string }[] }) => result.content.map(part => part.type === "text" ? part.text ?? "" : "").join("");
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function harness(options: { sandbox?: Sandbox; promoteAfterMs?: number; names?: string[]; gateway?: Parameters<typeof fakeGateway>[0] } = {}) {
  const processes = new FakeProcesses();
  const order: string[] = [];
  const executor = processes.executor();
  const wrapped = { ...executor,
    processDetach: async (...args: Parameters<typeof executor.processDetach>) => { order.push("detach"); return executor.processDetach(...args); },
    processKill: async (...args: Parameters<typeof executor.processKill>) => { order.push("kill"); return executor.processKill(...args); } };
  const gateway = fakeGateway(async (tool, action, args, context, timeoutMs) => { order.push(`${tool}.${action}`); return (options.gateway ?? (() => registered()))(tool, action, args, context, timeoutMs); });
  const live: string[] = [];
  const listeners = new Set<() => void>();
  const sandbox = options.sandbox ?? personal;
  const tools = createTools("/workspace", { sandbox, executor: wrapped, gateway, names: options.names ?? ["bash", "task", "job", "wait"],
    context: () => ({ sid: "s", scope_key: sandbox.scope_key, run_id: "run-1", owner_user_id: 1 }),
    output: (_id, text) => live.push(text),
    inputs: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    promoteAfterMs: options.promoteAfterMs ?? 60_000 });
  const invoke = (name: string, args: Record<string, unknown>, signal?: AbortSignal) => tools.find(tool => tool.name === name)!.execute("call-1", args, signal, undefined, {} as ExtensionToolContext);
  const text = (result: Awaited<ReturnType<typeof invoke>>) => result.content.map(part => part.type === "text" ? part.text : "").join("");
  return { processes, gateway, order, live, listeners, tools, invoke, text };
}
const firstProcess = (h: ReturnType<typeof harness>) => [...h.processes.views.keys()][0]!;
async function started(h: ReturnType<typeof harness>) { while (h.processes.views.size === 0) await sleep(1); return firstProcess(h); }

test("a personal command that ends within the threshold keeps today's output format and is never backgrounded", async () => {
  const h = harness();
  const running = h.invoke("bash", { command: "printf hello" });
  const id = await started(h);
  h.processes.write(id, "hel"); await sleep(5); h.processes.write(id, "lo\n"); h.processes.end(id, "exited", 0);
  const result = await running;
  assert.equal(h.text(result), "hello\n");
  assert.deepEqual(result.details, {});
  assert.equal(h.live.join(""), "hello\n");
  const { options } = h.processes.starts[0]!;
  assert.deepEqual(options, { command: "printf hello", cwd: "/workspace", timeoutMs: 600_000, stdin: false });
  assert.deepEqual(h.order, []);
  assert.equal(h.gateway.calls.length, 0);

  const empty = harness();
  const quiet = empty.invoke("bash", { command: "true" });
  empty.processes.end(await started(empty), "exited", 0);
  assert.equal(empty.text(await quiet), "(no output)");

  const failing = harness();
  const failed = failing.invoke("bash", { command: "exit 3" });
  const failingId = await started(failing);
  failing.processes.write(failingId, "failing"); failing.processes.end(failingId, "exited", 3);
  await assert.rejects(failed, /^Error: failing\n\nCommand exited with code 3$/);

  const timedOut = harness();
  const slow = timedOut.invoke("bash", { command: "sleep 9", timeout: 5 });
  timedOut.processes.end(await started(timedOut), "killed", null, "timeout");
  await assert.rejects(slow, /Command timed out after 5s/);
  assert.equal(timedOut.processes.starts[0]!.options.timeoutMs, 5000);
});

test("truncated foreground output keeps the 50 KiB / 2000 line tail and points to job output through a delivered registration", async () => {
  const h = harness();
  const running = h.invoke("bash", { command: "seq 1 3000" });
  const id = await started(h);
  h.processes.write(id, Array.from({ length: 3000 }, (_, index) => String(index + 1)).join("\n") + "\n");
  h.processes.end(id, "exited", 0);
  const output = h.text(await running);
  assert.match(output, /\n\n\[Output truncated\. Full output: job output bg-7\]$/);
  const lines = output.replace(/\n\n\[Output truncated.*$/s, "").split("\n");
  assert.equal(lines.at(-1), "");
  assert.equal(lines.length - 1, 2000);
  assert.equal(lines.at(-2), "3000");
  assert.deepEqual(h.gateway.calls.map(call => [call.tool, call.action, call.args]), [["tasks", "register_process", { process_id: id, delivered: true }]]);
  assert.equal(h.processes.detached.length, 0);

  // Multi-byte output is cut on a character boundary.
  const wide = harness();
  const wideRun = wide.invoke("bash", { command: "wide" });
  const wideId = await started(wide);
  wide.processes.write(wideId, "界".repeat(40_000)); wide.processes.end(wideId, "exited", 0);
  const text = wide.text(await wideRun);
  assert.doesNotMatch(text, /\ufffd/);
  assert.match(text, /Output truncated/);
});

test("a command still running at the threshold is promoted without a rerun and keeps its deadline", async () => {
  const h = harness({ promoteAfterMs: 40 });
  const running = h.invoke("bash", { command: "make all", timeout: 900 });
  const id = await started(h);
  h.processes.write(id, "compiling\n");
  const result = await running;
  assert.equal(h.processes.starts.length, 1, "promotion must not start the command again");
  assert.deepEqual(h.processes.kills, []);
  assert.equal(h.processes.starts[0]!.options.timeoutMs, 900_000, "the deadline stays");
  assert.deepEqual(h.order, ["detach", "tasks.register_process"], "detach first, then register");
  assert.deepEqual(h.processes.detached, [id]);
  assert.deepEqual(result.details, { background: { task_id: "bg-7", process_id: id } });
  assert.match(h.text(result), /moved to the background; it was not restarted/);
  assert.match(h.text(result), /Running in the background as bg-7\./);
  assert.match(h.text(result), /stopped after 900s/);
  assert.deepEqual(h.gateway.calls[0]!.args, { process_id: id, delivered: false });
  assert.equal(h.gateway.calls[0]!.context.tool_call_id, "call-1");
  assert.equal(h.processes.views.get(id)!.state, "running");
  assert.equal(h.live.join(""), "compiling\n");
  assert.equal(h.listeners.size, 0, "the input subscription ends with the call");
});

test("an inserted user input promotes at once, also when it was already pending", async () => {
  const h = harness();
  const running = h.invoke("bash", { command: "npm test" });
  const id = await started(h);
  for (const listener of h.listeners) listener();
  const result = await running;
  assert.match(h.text(result), /^Backgrounded early to handle an incoming message; the command keeps running\./);
  assert.deepEqual(result.details, { background: { task_id: "bg-7", process_id: id } });
  assert.deepEqual(h.order, ["detach", "tasks.register_process"]);
  assert.equal(h.processes.starts.length, 1);

  // `inputs` calls the listener immediately when input is already pending.
  const pending = harness();
  const live = pending.tools.find(tool => tool.name === "bash")!;
  const original = pending.listeners.add.bind(pending.listeners);
  pending.listeners.add = listener => { const set = original(listener); listener(); return set; };
  const early = await live.execute("call-2", { command: "npm test" }, undefined, undefined, {} as ExtensionToolContext);
  assert.match(textOf(early), /Backgrounded early/);
});

test("async and name background at once; async keeps the deadline, a service has none", async () => {
  const h = harness();
  const result = await h.invoke("bash", { command: "npm run build", async: true });
  const options = h.processes.starts[0]!.options;
  assert.equal(options.timeoutMs, 600_000);
  assert.equal(options.stdin, false);
  assert.match(h.text(result), /Running in the background as bg-7\./);
  assert.doesNotMatch(h.text(result), /moved to the background/);
  assert.deepEqual(h.order, ["detach", "tasks.register_process"]);
  assert.equal(h.processes.reads.length, 0, "no foreground wait for async");

  const service = harness();
  const started = await service.invoke("bash", { command: "npm run dev", name: "dev-server" });
  assert.deepEqual(service.processes.starts[0]!.options, { command: "npm run dev", cwd: "/workspace", timeoutMs: 0, name: "dev-server", stdin: true });
  assert.deepEqual(service.gateway.calls[0]!.args, { process_id: firstProcess(service), delivered: false, name: "dev-server" });
  assert.match(service.text(started), /service "dev-server"/);
  assert.match(service.text(started), /no deadline/);

  const longJob = harness();
  await longJob.invoke("bash", { command: "tail -f log", async: true, timeout: 0 });
  assert.equal(longJob.processes.starts[0]!.options.timeoutMs, 0);
});

test("personal bash validates async, timeout, name and ready before starting anything", async () => {
  const h = harness();
  const reject = async (args: Record<string, unknown>, pattern: RegExp) => assert.rejects(h.invoke("bash", { command: "x", ...args }), pattern, JSON.stringify(args));
  await reject({ timeout: 0 }, /only with async or name/);
  await reject({ timeout: -1 }, /timeout must be/);
  await reject({ timeout: Number.NaN }, /timeout must be/);
  await reject({ timeout: Number.POSITIVE_INFINITY }, /timeout must be/);
  await reject({ timeout: 0, async: false }, /only with async or name/);
  await reject({ name: "bad name" }, /name must be/);
  await reject({ name: "-lead" }, /name must be/);
  await reject({ name: "a".repeat(49) }, /name must be/);
  await reject({ ready: { port: 80 } }, /ready requires name/);
  await reject({ name: "svc", ready: {} }, /log and\/or port/);
  await reject({ name: "svc", ready: { log: "(" } }, /not a valid regular expression/);
  await reject({ name: "svc", ready: { port: 0 } }, /port must be/);
  await reject({ name: "svc", ready: { port: 70_000 } }, /port must be/);
  await reject({ name: "svc", ready: { port: 80, host: "bad host; rm" } }, /host/);
  await reject({ name: "svc", ready: { port: 80, timeout: 0 } }, /ready\.timeout/);
  assert.equal(h.processes.starts.length, 0);
  assert.equal(h.gateway.calls.length, 0);

  const limits: [Record<string, unknown>, number][] = [
    [{ timeout: 7200 }, 3_600_000],
    [{ timeout: 0.01 }, 100],
    [{ async: true, timeout: 7200 }, 7_200_000],
    [{ async: true, timeout: 9_999_999 }, 604_800_000],
    [{ async: true, timeout: 0 }, 0],
    [{ name: "svc", timeout: 0 }, 0],
    [{ name: "svc", timeout: 120 }, 120_000],
    [{ name: "svc" }, 0],
  ];
  for (const [args, timeoutMs] of limits) {
    const limited = harness();
    const running = limited.invoke("bash", { command: "x", ...args });
    if (!("async" in args) && !("name" in args)) { limited.processes.end(await started(limited), "exited", 0); }
    await running;
    assert.equal(limited.processes.starts[0]!.options.timeoutMs, timeoutMs, JSON.stringify(args));
  }
});

test("a named service waits for its log line, reports ready and stays running", async () => {
  const h = harness();
  const running = h.invoke("bash", { command: "npm run dev", name: "web", ready: { log: "listening on (\\d+)", timeout: 5 } });
  const id = await started(h);
  await sleep(30);
  h.processes.write(id, "starting\n");
  await sleep(30);
  assert.deepEqual(h.order.slice(0, 2), ["detach", "tasks.register_process"], "readiness is awaited after registration");
  h.processes.write(id, "listening on 3000\n");
  const result = await running;
  assert.match(h.text(result), /Running in the background as bg-7 \(service "web"\)/);
  assert.match(h.text(result), /Ready: log matched \/listening on \(\\d\+\)\//);
  assert.match(h.text(result), /Output so far:\nstarting\nlistening on 3000/);
  assert.deepEqual(result.details, { background: { task_id: "bg-7", process_id: id } });
  assert.equal(h.processes.views.get(id)!.state, "running");
  assert.deepEqual(h.processes.kills, []);
});

test("a named service probes its port from the sandbox; with log and port both must hold", async () => {
  const h = harness();
  h.processes.probes.push(1, 0);
  const result = await h.invoke("bash", { command: "serve", name: "api", ready: { port: 8080, host: "localhost", timeout: 10 } });
  assert.match(h.text(result), /Ready: port localhost:8080 accepts connections\./);
  assert.equal(h.processes.terminals.length, 2);
  assert.match(h.processes.terminals[0]!, /^timeout 3 bash -c 'exec 3<>\/dev\/tcp\/localhost\/8080'$/);

  const both = harness();
  both.processes.probes.push(0);
  const running = both.invoke("bash", { command: "serve", name: "api", ready: { log: "ready", port: 9000, timeout: 0.3 } });
  const id = await started(both);
  const early = await Promise.race([running.then(() => "done"), sleep(150).then(() => "pending")]);
  assert.equal(early, "pending", "an open port alone is not enough when a log pattern is required");
  both.processes.write(id, "server ready\n");
  assert.match(both.text(await running), /Ready: log matched \/ready\/, port 127\.0\.0\.1:9000 accepts connections\./);
});

test("a named service that never becomes ready reports not ready with an output preview and keeps running", async () => {
  const h = harness();
  const running = h.invoke("bash", { command: "slow", name: "slow", ready: { log: "never", port: 7000, timeout: 0.25 } });
  const id = await started(h);
  h.processes.write(id, "warming up\n");
  const result = await running;
  assert.match(h.text(result), /Not ready after 0s \(log \/never\/ not seen, port 127\.0\.0\.1:7000 not open\); the service is still running/);
  assert.match(h.text(result), /Output so far:\nwarming up/);
  assert.equal(h.processes.views.get(id)!.state, "running");
  assert.deepEqual(h.processes.kills, [], "a service that is not ready is not stopped");
  assert.deepEqual(result.details, { background: { task_id: "bg-7", process_id: id } });

  const exited = harness();
  const dying = exited.invoke("bash", { command: "crash", name: "crash", ready: { log: "up", timeout: 5 } });
  const dyingId = await started(exited);
  exited.processes.write(dyingId, "boom\n"); exited.processes.end(dyingId, "exited", 1);
  assert.match(exited.text(await dying), /Not ready: the process ended before it became ready \(exited, exit code 1\)\.\nOutput so far:\nboom/);
});

test("aborting the call kills an unpromoted process; a promoted one is left alone", async () => {
  const h = harness();
  const controller = new AbortController();
  const running = h.invoke("bash", { command: "sleep 1000" }, controller.signal);
  const id = await started(h);
  const rejected = assert.rejects(running, /abort|cancel/i);
  controller.abort(new Error("run cancelled"));
  await rejected;
  assert.deepEqual(h.processes.kills, [id]);
  assert.equal(h.processes.views.get(id)!.state, "killed");
  assert.deepEqual(h.processes.detached, []);
  assert.equal(h.gateway.calls.length, 0);

  const before = harness();
  const cancelled = new AbortController();
  cancelled.abort(new Error("already cancelled"));
  await assert.rejects(before.invoke("bash", { command: "never" }, cancelled.signal), /already cancelled/);
  assert.equal(before.processes.starts.length, 0);

  const promoted = harness();
  const late = new AbortController();
  await promoted.invoke("bash", { command: "serve", async: true }, late.signal);
  late.abort();
  await sleep(10);
  assert.deepEqual(promoted.processes.kills, []);
});

test("a failed registration stops the detached process instead of leaking it", async () => {
  for (const response of [{ content: "too many background processes", data: null, is_error: true }, { content: "ok", data: {}, is_error: false }]) {
    const h = harness({ gateway: () => response });
    await assert.rejects(h.invoke("bash", { command: "serve", async: true }), /Could not register the background process; it was stopped/);
    assert.deepEqual(h.order, ["detach", "tasks.register_process", "kill"]);
    assert.equal(h.processes.views.get(firstProcess(h))!.state, "killed");
  }
});

test("a read failure stops the process and surfaces the error", async () => {
  const failing = harness();
  const original = failing.processes.executor();
  const executor = { ...original, processRead: async () => { throw new Error("Executor HTTP 502"); } };
  const tools = createTools("/workspace", { sandbox: personal, executor, gateway: failing.gateway, names: ["bash"], context: () => ({ sid: "s", scope_key: "private:1", run_id: "r" }) });
  await assert.rejects(tools[0]!.execute("c", { command: "x" }, undefined, undefined, {} as ExtensionToolContext), /Executor HTTP 502/);
  assert.equal(failing.processes.kills.length, 1);
});

test("task, job and wait forward to the tasks gateway with the call context", async () => {
  const h = harness({ gateway: (_tool, action) => ({ content: `did ${action}`, data: { ok: action }, is_error: false }) });
  const spawn = await h.invoke("task", { agent: "scout", tasks: [{ name: "Docs", task: "Find the docs" }, { task: "Find the tests" }], context: "Repo layout" });
  assert.equal(h.text(spawn), "did spawn");
  assert.deepEqual(spawn.details, { ok: "spawn" });
  await h.invoke("job", { action: "list" });
  await h.invoke("job", { action: "output", id: "bg-3", offset: -1 });
  await h.invoke("job", { action: "input", id: "bg-3", text: "q\n", eof: true });
  await h.invoke("job", { action: "stop", id: "bg-3" });
  await h.invoke("job", { action: "status", id: "bg-3" });
  await h.invoke("wait", { ids: ["bg-3"], timeout: 600 });
  await h.invoke("wait", {});
  await h.invoke("wait", { timeout: 99_999 });
  assert.deepEqual(h.gateway.calls.map(call => [call.tool, call.action, call.args]), [
    ["tasks", "spawn", { agent: "scout", tasks: [{ name: "Docs", task: "Find the docs" }, { task: "Find the tests" }], context: "Repo layout" }],
    ["tasks", "list", {}],
    ["tasks", "output", { id: "bg-3", offset: -1 }],
    ["tasks", "input", { id: "bg-3", text: "q\n", eof: true }],
    ["tasks", "stop", { id: "bg-3" }],
    ["tasks", "status", { id: "bg-3" }],
    ["tasks", "wait", { ids: ["bg-3"], timeout: 600 }],
    ["tasks", "wait", {}],
    ["tasks", "wait", { timeout: 99_999 }],
  ]);
  assert(h.gateway.calls.every(call => call.context.tool_call_id === "call-1" && call.context.owner_user_id === 1 && call.context.scope_key === "private:1"));
  assert.deepEqual(h.gateway.calls.slice(0, 6).map(call => call.timeoutMs), Array(6).fill(undefined));
  assert.deepEqual(h.gateway.calls.slice(6).map(call => call.timeoutMs), [630_000, 1_830_000, 1_830_000], "the HTTP deadline exceeds the wait by 30 s and never the 1800 s cap plus 30 s");
  assert.equal(h.processes.starts.length, 0);

  const failing = harness({ gateway: () => ({ content: "Nothing is running and nothing is undelivered", data: null, is_error: true }) });
  await assert.rejects(failing.invoke("wait", {}), /Nothing is running/);
});

test("task, job and wait exist only in the root personal scope", () => {
  const names = ["bash", "task", "job", "wait", "browser", "schedule", "mcp"];
  const scopes: [string, Sandbox, string[]][] = [
    ["root personal", personal, ["bash", "browser", "job", "mcp", "schedule", "task", "wait"]],
    ["subagent", { ...personal, scope_key: "private:1/delegate/bg-4" }, ["bash"]],
    ["channel", { ...personal, scope_key: "channel:2:room" }, ["bash"]],
    ["chat", { ...personal, scope_key: "chat:3", profile: "chat" }, ["bash"]],
  ];
  for (const [label, sandbox, expected] of scopes) {
    const tools = createTools("/workspace", { sandbox, executor: { ...noProcesses } as never, gateway: fakeGateway(() => registered()), names, context: () => ({ sid: "s", scope_key: sandbox.scope_key, run_id: "r" }) });
    assert.deepEqual(tools.map(tool => tool.name).sort(), expected, label);
  }
  const personalBash = createTools("/workspace", { sandbox: personal, executor: { ...noProcesses } as never, gateway: fakeGateway(() => registered()), names: ["bash"], context: () => ({ sid: "s", scope_key: "private:1", run_id: "r" }) })[0]!;
  const foreignBash = createTools("/workspace", { sandbox: { ...personal, scope_key: "channel:2:room" }, executor: { ...noProcesses } as never, gateway: fakeGateway(() => registered()), names: ["bash"], context: () => ({ sid: "s", scope_key: "channel:2:room", run_id: "r" }) })[0]!;
  const properties = (tool: typeof personalBash) => Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties).sort();
  assert.deepEqual(properties(personalBash), ["async", "command", "name", "ready", "timeout"]);
  assert.deepEqual(properties(foreignBash), ["command", "timeout"]);
});

test("channel and chat bash keep running as one foreground terminal call", async () => {
  for (const sandbox of [{ ...personal, scope_key: "channel:2:room" }, { ...personal, scope_key: "chat:3", profile: "chat" as const, cwd: "/workspace/c" }]) {
    const commands: string[] = [];
    const executor = { ...noProcesses, terminal: async (_s: Sandbox, _c: unknown, command: string, _cwd: string, timeoutMs: number) => { commands.push(command); return { stdout: `/workspace/.pi-bash-x.log\n2\n1\nok\n`, stderr: "", exit_code: 0, status: "completed", timeoutMs }; }, file: async () => { throw new Error("unused"); }, cancelRun: async () => true };
    const tools = createTools(sandbox.cwd, { sandbox, executor: executor as never, gateway: fakeGateway(() => registered()), names: ["bash"], context: () => ({ sid: "s", scope_key: sandbox.scope_key, run_id: "r" }) });
    const result = await tools[0]!.execute("c", { command: "echo ok" }, undefined, undefined, {} as ExtensionToolContext);
    assert.equal(textOf(result), "ok\n");
    assert.equal(commands.length, 1);
    assert.match(commands[0]!, /mktemp/);
  }
});
