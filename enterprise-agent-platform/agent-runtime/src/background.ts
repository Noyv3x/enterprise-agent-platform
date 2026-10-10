import type { ExecutorTransport, GatewayTransport, ProcessView, Sandbox, ToolContext } from "./transport.js";

export const FOREGROUND_DEFAULT_SECONDS = 600;
export const FOREGROUND_MAX_SECONDS = 3600;
export const BACKGROUND_MAX_SECONDS = 604_800;
/** A foreground command still running after this long is promoted to a background task. */
export const PROMOTE_AFTER_MS = 60_000;
const TAIL_BYTES = 51_200;
const TAIL_LINES = 2000;
const READ_BYTES = 65_536;
const READ_WAIT_MS = 30_000;
const READY_WINDOW_CHARS = 65_536;
const PREVIEW_CHARS = 2000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const HOST = /^[A-Za-z0-9._:-]{1,255}$/;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export interface BashArguments {
  command: string; timeout?: number; async?: boolean; name?: string;
  ready?: { log?: string; port?: number; host?: string; timeout?: number };
}
export interface BackgroundDependencies {
  sandbox: Sandbox;
  cwd: string;
  executor: ExecutorTransport;
  gateway: GatewayTransport;
  /** Context and Pi abort signal of the running tool call. */
  call: () => { context: ToolContext; signal: AbortSignal | undefined };
  /** Live output sink for this tool call. */
  output?: (text: string) => void;
  /** Subscribes to user input inserted into the run; fires at once when some is pending. Returns the unsubscribe. */
  inputs?: (listener: () => void) => () => void;
  promoteAfterMs?: number;
}
interface Plan {
  background: boolean; timeoutMs: number; name?: string;
  ready?: { log?: RegExp; logSource?: string; port?: number; host: string; timeoutMs: number };
}
type ToolText = { content: { type: "text"; text: string }[]; details: unknown };
const result = (text: string, details: unknown = {}): ToolText => ({ content: [{ type: "text", text }], details });

/** Validates the personal bash parameters before anything is started. */
export function plan(args: BashArguments): Plan {
  const background = args.async === true || args.name !== undefined;
  if (args.name !== undefined && !NAME.test(args.name)) throw new Error("name must be 1-48 characters: letters, digits, '.', '_' or '-', starting with a letter or digit");
  let ready: Plan["ready"];
  if (args.ready !== undefined) {
    if (args.name === undefined) throw new Error("ready requires name");
    const { log, port, host = "127.0.0.1", timeout = 30 } = args.ready;
    if (log === undefined && port === undefined) throw new Error("ready needs log and/or port");
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("ready.port must be an integer from 1 to 65535");
    if (!HOST.test(host)) throw new Error("ready.host is not a valid host name or address");
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 3600) throw new Error("ready.timeout must be greater than 0 and at most 3600 seconds");
    let pattern: RegExp | undefined;
    if (log !== undefined) { try { pattern = new RegExp(log, "m"); } catch { throw new Error("ready.log is not a valid regular expression"); } }
    ready = { ...(pattern ? { log: pattern, logSource: log } : {}), ...(port === undefined ? {} : { port }), host, timeoutMs: timeout * 1000 };
  }
  const timeout = args.timeout;
  let seconds: number;
  if (timeout === undefined) seconds = args.name !== undefined ? 0 : FOREGROUND_DEFAULT_SECONDS;
  else if (!Number.isFinite(timeout) || timeout < 0) throw new Error("timeout must be a finite number of seconds, 0 or greater");
  else if (timeout === 0) {
    if (!background) throw new Error("timeout 0 (no deadline) is valid only with async or name");
    seconds = 0;
  } else seconds = Math.min(timeout, background ? BACKGROUND_MAX_SECONDS : FOREGROUND_MAX_SECONDS);
  return { background, timeoutMs: seconds === 0 ? 0 : Math.max(100, Math.round(seconds * 1000)), ...(args.name === undefined ? {} : { name: args.name }), ...(ready ? { ready } : {}) };
}

/** Keeps what the foreground result needs: the byte and line totals plus a bounded tail. */
class Tail {
  private chunks: Buffer[] = [];
  private size = 0;
  bytes = 0;
  lines = 0;
  add(data: string): void {
    const chunk = Buffer.from(data);
    this.bytes += chunk.length;
    for (const byte of chunk) if (byte === 10) this.lines++;
    this.chunks.push(chunk); this.size += chunk.length;
    while (this.chunks.length > 1 && this.size - this.chunks[0]!.length >= TAIL_BYTES) this.size -= this.chunks.shift()!.length;
  }
  get truncated(): boolean { return this.bytes > TAIL_BYTES || this.lines >= TAIL_LINES; }
  text(): string {
    let bytes = Buffer.concat(this.chunks);
    if (bytes.length > TAIL_BYTES) bytes = bytes.subarray(bytes.length - TAIL_BYTES);
    let start = 0;
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
    const lines = bytes.subarray(start).toString().split("\n");
    const trailing = lines.at(-1) === "";
    const kept = lines.slice(-(TAIL_LINES + (trailing ? 1 : 0)));
    return kept.join("\n");
  }
}

function describeEnd(view: ProcessView, timeoutMs: number): string {
  if (view.state === "exited") return `Command exited with code ${view.exit_code ?? view.state}`;
  if (view.state === "killed" && view.reason === "timeout") return `Command timed out after ${Math.round(timeoutMs / 1000)}s`;
  return `Command ${view.state}${view.reason ? ` (${view.reason})` : ""}${view.exit_code === null ? "" : `, exit code ${view.exit_code}`}`;
}

export async function runBash(args: BashArguments, dependencies: BackgroundDependencies): Promise<ToolText> {
  const { sandbox, executor, cwd } = dependencies;
  const settings = plan(args);
  const { context, signal } = dependencies.call();
  signal?.throwIfAborted();
  const proc = await executor.processStart(sandbox, context, { command: args.command, cwd, timeoutMs: settings.timeoutMs, ...(settings.name === undefined ? {} : { name: settings.name }), stdin: settings.name !== undefined }, signal);
  const kill = async () => { try { await executor.processKill(sandbox, context, proc.id); } catch { /* Manager run cancellation is the backstop */ } };
  const trigger = new AbortController();
  type Reason = "threshold" | "input" | "async";
  const promotion: { reason: Reason } = { reason: settings.background ? "async" : "threshold" };
  const fire = (why: Reason) => { if (!trigger.signal.aborted) { promotion.reason = why; trigger.abort(); } };
  const timer = setTimeout(() => fire("threshold"), dependencies.promoteAfterMs ?? PROMOTE_AFTER_MS);
  const unsubscribe = settings.background ? undefined : dependencies.inputs?.(() => fire("input"));
  try {
    if (settings.background) trigger.abort();
    const tail = new Tail();
    let offset = 0;
    let ended: ProcessView | undefined;
    while (!trigger.signal.aborted) {
      let page;
      try {
        page = await executor.processRead(sandbox, proc.id, { offset, maxBytes: READ_BYTES, waitMs: READ_WAIT_MS }, signal ? AbortSignal.any([signal, trigger.signal]) : trigger.signal);
      } catch (error) {
        if (signal?.aborted) { await kill(); throw signal.reason ?? error; }
        if (trigger.signal.aborted) break;
        await kill();
        throw error;
      }
      if (page.data) { tail.add(page.data); try { dependencies.output?.(page.data); } catch { /* live display must not affect the command */ } }
      offset = page.next_offset;
      if (page.eof) { ended = page.process; break; }
    }
    if (signal?.aborted) { await kill(); throw signal.reason ?? new DOMException("Aborted", "AbortError"); }
    if (ended) {
      let output = tail.text() || "(no output)";
      if (tail.truncated) {
        let task: string | undefined;
        try { task = await register(dependencies, context, proc.id, true, settings.name); } catch { /* the note below stays accurate */ }
        output += task ? `\n\n[Output truncated. Full output: job output ${task}]` : "\n\n[Output truncated.]";
      }
      if (ended.state === "exited" && ended.exit_code === 0) return result(output);
      throw new Error(`${output}\n\n${describeEnd(ended, settings.timeoutMs)}`);
    }
    // Promotion: detach, then register; the command keeps running and keeps its deadline.
    clearTimeout(timer); unsubscribe?.();
    await executor.processDetach(sandbox, proc.id);
    let task: string;
    try { task = await register(dependencies, context, proc.id, false, settings.name); }
    catch (error) { await kill(); throw new Error(`Could not register the background process; it was stopped. ${error instanceof Error ? error.message : String(error)}`); }
    const details = { background: { task_id: task, process_id: proc.id } };
    const name = settings.name === undefined ? "" : ` (service "${settings.name}")`;
    const lead = promotion.reason === "input" ? "Backgrounded early to handle an incoming message; the command keeps running.\n\n" : promotion.reason === "threshold" ? `The command ran longer than ${Math.round((dependencies.promoteAfterMs ?? PROMOTE_AFTER_MS) / 1000)}s and was moved to the background; it was not restarted.\n\n` : "";
    const base = `${lead}Running in the background as ${task}${name}. ${settings.timeoutMs === 0 ? "It has no deadline" : `It is stopped after ${Math.round(settings.timeoutMs / 1000)}s`}. Its result is delivered to you automatically when it finishes: do NOT poll (no sleep, ps or log tailing); do other work or end your reply. Use job (status, output, input, stop) to inspect or control it.`;
    if (!settings.ready) return result(base, details);
    return result(`${base}\n\n${await awaitReady(dependencies, context, proc.id, settings.ready, signal)}`, details);
  } finally {
    clearTimeout(timer); unsubscribe?.();
  }
}

async function register(dependencies: BackgroundDependencies, context: ToolContext, processId: string, delivered: boolean, name?: string): Promise<string> {
  const response = await dependencies.gateway.call("tasks", "register_process", { process_id: processId, delivered, ...(name === undefined ? {} : { name }) }, context);
  const data: unknown = response.data;
  const taskId = data && typeof data === "object" && "task_id" in data ? data.task_id : undefined;
  if (response.is_error || typeof taskId !== "string" || !/^bg-\d+$/.test(taskId)) throw new Error(response.is_error ? response.content : "Platform returned no task id");
  return taskId;
}

/** Waits for the log regex and/or port of a named service; both must hold when both are given. */
async function awaitReady(dependencies: BackgroundDependencies, context: ToolContext, processId: string, ready: NonNullable<Plan["ready"]>, signal: AbortSignal | undefined): Promise<string> {
  const { sandbox, executor } = dependencies;
  const deadline = Date.now() + ready.timeoutMs;
  let logOk = ready.log === undefined;
  let portOk = ready.port === undefined;
  let window = "";
  let offset = 0;
  let ended: ProcessView | undefined;
  const preview = () => `Output so far:\n${window.slice(-PREVIEW_CHARS) || "(none)"}`;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const wait = Math.max(1, Math.min(500, deadline - Date.now()));
    const page = await executor.processRead(sandbox, processId, { offset, maxBytes: READ_BYTES, waitMs: wait }, signal);
    offset = page.next_offset;
    if (page.data) window = (window + page.data).slice(-READY_WINDOW_CHARS);
    if (!logOk && ready.log!.test(window)) logOk = true;
    if (!portOk && !page.eof) {
      try {
        const probe = await executor.terminal(sandbox, context, `timeout 3 bash -c ${quote(`exec 3<>/dev/tcp/${ready.host}/${ready.port}`)}`, dependencies.cwd, 5000, signal);
        portOk = probe.exit_code === 0;
      } catch (error) { if (signal?.aborted) throw error; }
    }
    if (page.eof) { ended = page.process; if (!(logOk && portOk)) break; }
    if (logOk && portOk) {
      const checks = [ready.log ? `log matched /${ready.logSource}/` : "", ready.port ? `port ${ready.host}:${ready.port} accepts connections` : ""].filter(Boolean).join(", ");
      return `Ready: ${checks}.\n${preview()}`;
    }
  }
  if (ended) return `Not ready: the process ended before it became ready (${ended.state}${ended.exit_code === null ? "" : `, exit code ${ended.exit_code}`}).\n${preview()}`;
  const missing = [logOk ? "" : `log /${ready.logSource}/ not seen`, portOk ? "" : `port ${ready.host}:${ready.port} not open`].filter(Boolean).join(", ");
  return `Not ready after ${Math.round(ready.timeoutMs / 1000)}s (${missing}); the service is still running. Check job output.\n${preview()}`;
}
