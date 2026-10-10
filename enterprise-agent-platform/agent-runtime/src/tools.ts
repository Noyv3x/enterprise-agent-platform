import { AsyncLocalStorage } from "node:async_hooks";
import { readFile, realpath } from "node:fs/promises";
import { posix as path } from "node:path";
import { createReadTool, createEditTool, createWriteTool, createFindTool, createLsTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Parse } from "typebox/value";
import type { ExecutorTransport, GatewayTransport, OutputListener, Sandbox, ToolContext } from "./transport.js";
import { runBash } from "./background.js";

export interface ToolDependencies {
  sandbox: Sandbox;
  context: () => ToolContext;
  names: string[];
  executor: ExecutorTransport;
  gateway: GatewayTransport;
  skillsDirectory?: string;
  /** Live bash output (sanitized by Manager), in order; the tool result stays authoritative. */
  output?: (toolCallId: string, text: string) => void;
  /** Personal bash only: subscribes to user input inserted into the run (fires at once when some is pending). */
  inputs?: (listener: () => void) => () => void;
  /** Personal bash only: foreground time before a command is promoted to the background (default 60 s). */
  promoteAfterMs?: number;
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const text = (value: string, details: unknown = {}) => ({ content: [{ type: "text" as const, text: value }], details });
const inside = (root: string, value: string) => value === root || value.startsWith(`${root}/`);
const grepSchema = Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()), glob: Type.Optional(Type.String()), ignoreCase: Type.Optional(Type.Boolean()), literal: Type.Optional(Type.Boolean()), context: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1 })) });
const bashSchema = Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default 600, maximum 3600)." })) });
const mcpSchema = Type.Object({ action: Type.Union([Type.Literal("list"), Type.Literal("call")]), server: Type.Optional(Type.String()), tool: Type.Optional(Type.String()), arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())) });
const gatewayArguments = Type.Record(Type.String(), Type.Unknown());
const WAIT_MAX_SECONDS = 1800;
const personalBashSchema = Type.Object({
  command: Type.String(),
  timeout: Type.Optional(Type.Number({ minimum: 0, description: "Seconds. Default 600; foreground maximum 3600, async/name maximum 604800. 0 disables the deadline and is valid only with async or name (a name without timeout has none)." })),
  async: Type.Optional(Type.Boolean({ description: "Start in the background at once (finite command; its deadline still applies)." })),
  name: Type.Optional(Type.String({ description: "Unique name (1-48 chars: letters, digits, . _ -) for a long-lived service: background, no deadline, stdin open." })),
  ready: Type.Optional(Type.Object({
    log: Type.Optional(Type.String({ description: "Regex that must appear in the output." })),
    port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535, description: "TCP port that must accept connections." })),
    host: Type.Optional(Type.String({ description: "Host for the port check (default 127.0.0.1)." })),
    timeout: Type.Optional(Type.Number({ description: "Seconds to wait for readiness (default 30)." })),
  }, { description: "Readiness check for a named service; needs log and/or port (both must hold if both are given)." })),
});
const taskSchema = Type.Object({
  agent: Type.Optional(Type.Union([Type.Literal("scout"), Type.Literal("task")], { description: "scout: read-only research; task (default): general worker." })),
  tasks: Type.Array(Type.Object({ name: Type.Optional(Type.String({ description: "Short name (CamelCase, at most 32 characters); generated if omitted." })), task: Type.String({ description: "Self-contained assignment: target files and non-goals, the change, and the observable result expected." }) }), { minItems: 1, maxItems: 8 }),
  context: Type.Optional(Type.String({ description: "Shared background for all tasks; do not repeat it per task." })),
});
const jobSchema = Type.Object({
  action: Type.Union(["list", "status", "output", "input", "stop"].map(value => Type.Literal(value))),
  id: Type.Optional(Type.String({ description: "Task id such as bg-3 (all actions except list)." })),
  text: Type.Optional(Type.String({ description: "input: text for the service's stdin." })),
  eof: Type.Optional(Type.Boolean({ description: "input: close stdin after the text." })),
  offset: Type.Optional(Type.Integer({ description: "output: byte offset to read from (-1 for the tail)." })),
});
const waitSchema = Type.Object({
  ids: Type.Optional(Type.Array(Type.String(), { minItems: 1, description: "Only these task ids (default: any of yours)." })),
  timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: WAIT_MAX_SECONDS, description: "Seconds to wait (default and maximum 1800)." })),
});
const PERSONAL_BASH_DESCRIPTION = [
  "Execute bash in the sandbox. Output is limited to the last 2000 lines or 50 KiB; when larger, the rest is available with `job output`.",
  "A command still running after 60 s moves to the background on its own (it is not restarted and keeps its deadline), and so does one running when the user sends a message; its result is then delivered to you automatically.",
  "`async` starts a finite command in the background at once (default deadline 600 s; `timeout: 0` for watchers and long jobs).",
  "Long-lived services (dev servers, watchers): give a unique `name`; no deadline, stdin open. `ready` needs `name`, and `log` (regex) and/or `port` (both must hold if both are given; host defaults to 127.0.0.1, ready.timeout 30 s).",
  "Do NOT poll for background work (no `sleep`, `ps`, log tailing): every poll is a wasted turn. Do other work, or end your reply and you will be woken. Use `job` to inspect, feed or stop it.",
].join(" ");
const TASK_DESCRIPTION = [
  "Spawn subagents that work concurrently in this sandbox; the ids (bg-<n>) return immediately and each report is delivered to you automatically when it is done, so do not poll. Up to 8 per call.",
  "Use the most specific agent: `scout` for read-only research when you do not know where the files are, `task` (default) for a worker that can edit and run commands. Prefer one agent to investigate and edit.",
  "Children start blank and share your sandbox and workspace but not your conversation: put what they need in `context` (shared) and in each `task` (self-contained: target files and non-goals, the change, the observable result expected). Never repeat the shared context per task.",
  "Tell workers to skip builds, lint and tests mid-flight and run them once at the end. Children cannot spawn subagents. Limit: 8 running subagents.",
].join(" ");
const JOB_DESCRIPTION = [
  "Inspect and control your background tasks (subagents and background commands), identified as bg-<n>.",
  "Actions: list; status (state, exit code, result or current activity); output (bytes of a command's log from `offset`, -1 for the tail); input (`text` to a named service's stdin, optional `eof`); stop.",
  "Results are delivered automatically when a task ends: use status/output to look in, not to poll.",
].join(" ");
const WAIT_DESCRIPTION = [
  "Wait only when blocked with nothing else to do.",
  "Blocks on your background tasks; returns the first task result (or only from `ids`), early with a note if the user sends a message, or after `timeout` seconds (maximum 1800) with the tasks still running.",
  "Nothing running and nothing undelivered? Errors. Results and messages auto-deliver: NEVER poll while work remains.",
].join(" ");
const SCHEDULE_DESCRIPTION = [
  "Manage your own scheduled tasks. Each time a schedule fires, its `prompt` is sent to you as a new message in this personal conversation, so write the prompt as an instruction to yourself that makes sense without the current chat.",
  "Use it for reminders and for recurring or later work the user asks for; do not tell the user to manage schedules themselves.",
  "Actions: list, get, create, update, pause, resume, delete, run_now and history (past runs); all but list and create need `schedule_id`.",
  "Timing (`schedule`): {type:\"once\", at:<RFC3339 time with offset or Z>}, {type:\"interval\", every_seconds:<n>} or {type:\"cron\", expression:<cron>}. Cron fires in `timezone`, an IANA name that defaults to the user's timezone.",
].join(" ");

export function createTools(cwd: string, dependencies: ToolDependencies): ToolDefinition[] {
  const { sandbox, executor, gateway } = dependencies;
  const personal = sandbox.profile === "agent" && /^private:\d+$/.test(sandbox.scope_key);
  const root = sandbox.profile === "chat" ? path.resolve(cwd) : "/workspace";
  if (!inside("/workspace", path.resolve(cwd))) throw new Error("Tool cwd must be inside /workspace");
  const calls = new AsyncLocalStorage<{ context: ToolContext; signal: AbortSignal | undefined; reads: Map<string, Promise<Buffer>> }>();
  const current = () => { const value = calls.getStore(); if (!value) throw new Error("Tool operation outside execution"); return value; };
  function confined(value: string): string {
    const absolute = path.resolve(cwd, value);
    if (!inside(root, absolute)) throw new Error(`Path is outside ${root}: ${value}`);
    return absolute;
  }
  async function terminal(command: string, timeoutMs = 60_000, auditDetails?: Record<string, unknown>, onOutput?: OutputListener) {
    const call = current();
    return executor.terminal(sandbox, call.context, command, cwd, timeoutMs, call.signal, auditDetails, onOutput);
  }
  async function checked(command: string): Promise<string> {
    const result = await terminal(command);
    if (result.exit_code !== 0) throw new Error(result.stderr || result.stdout || `Sandbox command failed (${result.exit_code ?? result.status})`);
    return result.stdout;
  }
  // Manager protects /file against symlinks. Terminal filesystem operations also
  // check resolved paths so a conversation symlink cannot redirect them elsewhere.
  const guard = (value: string) => `p=$(realpath -e -- ${quote(confined(value))}) && case "$p" in ${quote(root)}|${quote(root)}/*) ;; *) exit 1;; esac`;
  async function file(action: "read" | "write", args: Record<string, unknown>) {
    const call = current();
    return executor.file(sandbox, call.context, action, args, call.signal);
  }
  async function skill(value: string): Promise<string | undefined> {
    if (!value.startsWith("/platform-skills/")) return undefined;
    if (sandbox.profile === "chat") throw new Error("Skills are unavailable in chat");
    const directory = await realpath(dependencies.skillsDirectory ?? "/app/skills");
    const resolved = await realpath(path.resolve(directory, value.slice("/platform-skills/".length)));
    if (!inside(directory, resolved)) throw new Error("Skill path escapes bundled skills");
    return resolved;
  }
  function readRemote(value: string): Promise<Buffer> {
    const reads = current().reads;
    let result = reads.get(value);
    if (!result) { result = loadRemote(value); reads.set(value, result); }
    return result;
  }
  async function binaryRemote(value: string, total: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < total; offset += 196_608) {
      const count = Math.min(196_608, total - offset);
      const encoded = await checked(`${guard(value)} && test "$(stat -c %s -- "$p")" -eq ${total} && dd if="$p" bs=196608 iflag=skip_bytes,count_bytes skip=${offset} count=${count} status=none | base64 -w0`);
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.length !== count || bytes.toString("base64") !== encoded) throw new Error("Incomplete sandbox binary read");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, total);
  }
  async function loadRemote(value: string): Promise<Buffer> {
    const bundled = await skill(value);
    if (bundled) return readFile(bundled);
    const absolute = confined(value);
    const chunks: Buffer[] = [];
    let offset = 0;
    let total: number | undefined;
    do {
      const result = await file("read", { path: absolute, offset, limit: 1_000_000 });
      const returned = result.details.returned ?? -1;
      if (!Number.isSafeInteger(result.details.total) || result.details.total! < 0 ||
          !Number.isSafeInteger(returned) || returned < 0 || returned > 1_000_000 ||
          (total !== undefined && total !== result.details.total)) throw new Error("Invalid sandbox file read counts");
      total = result.details.total!;
      // Manager decodes each byte range separately, including split UTF-8.
      // Never let an unverified, clipped terminal buffer reach Pi's edit tool.
      if (result.content.includes("\ufffd")) return binaryRemote(absolute, total);
      const bytes = Buffer.from(result.content);
      if (bytes.length !== returned || offset + returned > total) throw new Error("Incomplete sandbox file read");
      chunks.push(bytes);
      offset += returned;
      if (offset === total) break;
      if (returned === 0) throw new Error("Manager file read made no progress");
    } while (true);
    return Buffer.concat(chunks, total);
  }
  const access = async (value: string) => {
    const bundled = await skill(value);
    if (bundled) return;
    await file("read", { path: confined(value), limit: 1 });
  };
  const writeRemote = async (value: string, content: string) => { await file("write", { path: confined(value), content }); };
  const exists = async (value: string) => (await terminal(`${guard(value)} && test -e "$p"`)).exit_code === 0;
  const tools: ToolDefinition[] = [
    createReadTool(cwd, { operations: { readFile: readRemote, access, detectImageMimeType: async value => {
      const bytes = await readRemote(value);
      if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
      if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
      if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString())) return "image/gif";
      if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
      return null;
    } } }),
    { name: "bash", label: "bash", description: "Execute bash in the sandbox. Output is limited to the last 2000 lines or 50 KiB; larger output is saved to a readable sandbox file.",
      parameters: bashSchema,
      execute: async (id, args) => {
        // Capture inside the sandbox, not Pi's Runtime-local OutputAccumulator.
        // No Runtime environment is forwarded to the shell.
        // The command's combined output goes to the spill file; a tail follows
        // that file and forwards the same bytes on stderr as live output. stdout
        // carries only the summary protocol. Waiting on the shell (not a pipe)
        // keeps its exit status and lets a lingering background process hold no
        // descriptor the wrapper waits on; --pid ends the tail after a final drain.
        const command = `${guard(cwd)} && f=$(mktemp -- "$p/.pi-bash-XXXXXX.log") || exit 1
bash -c ${quote(args.command)} >"$f" 2>&1 &
b=$!
tail -c +1 -s 0.05 -f --pid="$b" -- "$f" >&2 &
t=$!
wait "$b"
s=$?
wait "$t"
bytes=$(wc -c <"$f"); lines=$(wc -l <"$f")
printf '%s\\n%s\\n%s\\n' "$f" "$bytes" "$lines"
tail -c 51200 -- "$f" | tail -n 2000
if [ "$bytes" -le 51200 ] && [ "$lines" -lt 2000 ]; then rm -- "$f"; fi
exit "$s"`;
        const emit = dependencies.output;
        const result = await terminal(command, args.timeout === undefined ? 600_000 : args.timeout * 1000, undefined,
          emit && ((stream, data) => { if (stream === "stderr") emit(id, data); }));
        const match = /^([^\n]+)\n(\d+)\n(\d+)\n/.exec(result.stdout);
        if (!match) throw new Error(result.stderr || `Sandbox command failed (${result.status})`);
        const spilled = Number(match[2]) > 51200 || Number(match[3]) >= 2000;
        const fullOutputPath = spilled ? confined(match[1]!) : undefined;
        let output = result.stdout.slice(match[0].length) || "(no output)";
        if (fullOutputPath) output += `\n\n[Output truncated. Full output: ${fullOutputPath}]`;
        if (result.exit_code !== 0) throw new Error(`${output}\n\nCommand exited with code ${result.exit_code ?? result.status}`);
        return text(output, fullOutputPath ? { fullOutputPath } : {});
      } } satisfies ToolDefinition<typeof bashSchema>,
    createEditTool(cwd, { operations: { readFile: readRemote, writeFile: writeRemote, access: async value => { confined(value); await access(value); } } }),
    createWriteTool(cwd, { operations: { writeFile: writeRemote, mkdir: async value => {
      const absolute = confined(value);
      await checked(`p=$(realpath -m -- ${quote(absolute)}) && case "$p" in ${quote(root)}|${quote(root)}/*) mkdir -p -- "$p";; *) exit 1;; esac`);
    } } }),
    createFindTool(cwd, { operations: { exists, glob: async (pattern, directory, options) => {
      const output = await checked(`${guard(directory)} && cd -- "$p" && { rg --files --hidden -0 --glob ${quote(pattern)} ${options.ignore.map(ignore => `--glob ${quote(`!${ignore}`)}`).join(" ")}; status=$?; test "$status" -le 1; }`);
      return output.split("\0").filter(Boolean).slice(0, options.limit);
    } } }),
    createLsTool(cwd, { operations: { exists,
      stat: async value => { const result = await terminal(`${guard(value)} && test -d "$p"`); return { isDirectory: () => result.exit_code === 0 }; },
      readdir: async value => (await checked(`${guard(value)} && find "$p" -mindepth 1 -maxdepth 1 -printf '%f\\0'`)).split("\0").filter(Boolean),
    } }),
    { name: "grep", label: "grep", description: "Search sandbox file contents with ripgrep.",
      parameters: grepSchema,
      execute: async (_id, args) => {
        const command = `${guard(args.path ?? cwd)} && rg --no-heading --line-number --color never ${args.ignoreCase ? "-i" : ""} ${args.literal ? "-F" : ""} ${args.glob ? `--glob ${quote(args.glob)}` : ""} ${args.context === undefined ? "" : `-C ${args.context}`} -- ${quote(args.pattern)} "$p"`;
        const result = await terminal(command);
        if (result.exit_code !== 0 && result.exit_code !== 1) throw new Error(result.stderr || "Search failed");
        return text(result.stdout.split("\n").slice(0, args.limit ?? 100).join("\n") || "No matches", { exit_code: result.exit_code });
      } } satisfies ToolDefinition<typeof grepSchema>,
  ];
  function remote(name: string, tool: "web" | "browser" | "schedule" | "tasks", parameters: ToolDefinition["parameters"], action?: string, description = `Use the platform ${name} service.`, timeoutMs?: (params: Record<string, unknown>) => number): ToolDefinition {
    return { name, label: name, description, parameters,
      execute: async (_id, input) => {
        const params = Parse(gatewayArguments, input);
        const { action: requestedAction, ...rest } = params;
        const call = current();
        const operation = action ?? requestedAction;
        if (typeof operation !== "string") throw new Error("Tool action is required");
        const result = await gateway.call(tool, operation, action ? params : rest, call.context, call.signal, timeoutMs?.(params));
        if (result.is_error) throw new Error(result.content);
        if (tool === "browser" && result.data && typeof result.data === "object" && "screenshot" in result.data) {
          const { screenshot, ...details } = result.data;
          if (!screenshot || typeof screenshot !== "object" || !("data" in screenshot) || typeof screenshot.data !== "string" ||
              !("mimeType" in screenshot) || typeof screenshot.mimeType !== "string") throw new Error("Invalid browser screenshot");
          return { content: [{ type: "text", text: result.content }, { type: "image", mimeType: screenshot.mimeType, data: screenshot.data }], details };
        }
        return text(result.content, result.data);
      } };
  }
  tools.push(remote("web_search", "web", Type.Object({ query: Type.String(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }), "search"));
  tools.push(remote("web_fetch", "web", Type.Object({ url: Type.String(), max_chars: Type.Optional(Type.Integer({ minimum: 1 })) }), "fetch"));
  if (personal) {
    tools[tools.findIndex(tool => tool.name === "bash")] = { name: "bash", label: "bash", description: PERSONAL_BASH_DESCRIPTION, parameters: personalBashSchema,
      execute: async (id, args) => runBash(args, { sandbox, cwd, executor, gateway, call: current,
        ...(dependencies.promoteAfterMs === undefined ? {} : { promoteAfterMs: dependencies.promoteAfterMs }),
        ...(dependencies.output ? { output: (data: string) => dependencies.output!(id, data) } : {}),
        ...(dependencies.inputs ? { inputs: dependencies.inputs } : {}) }) } satisfies ToolDefinition<typeof personalBashSchema>;
    tools.push(remote("task", "tasks", taskSchema, "spawn", TASK_DESCRIPTION));
    tools.push(remote("job", "tasks", jobSchema, undefined, JOB_DESCRIPTION));
    tools.push(remote("wait", "tasks", waitSchema, "wait", WAIT_DESCRIPTION, params => (Math.min(typeof params.timeout === "number" ? params.timeout : WAIT_MAX_SECONDS, WAIT_MAX_SECONDS) + 30) * 1000));
  }
  if (personal) {
    tools.push(remote("browser", "browser", Type.Object({
      action: Type.String({ description: "list, new_tab, navigate, snapshot, screenshot, close, click, type, scroll, back, forward, refresh, press, wait, links, images, downloads, stats, extract, viewport, cleanup" }),
      tab_id: Type.Optional(Type.String()), url: Type.Optional(Type.String()), ref: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()), key: Type.Optional(Type.String()), direction: Type.Optional(Type.String()),
      amount: Type.Optional(Type.Number()), offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()),
      schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }, { additionalProperties: true })));
    tools.push(remote("schedule", "schedule", Type.Object({
      action: Type.Union(["list", "get", "create", "update", "pause", "resume", "delete", "run_now", "history"].map(value => Type.Literal(value))),
      schedule_id: Type.Optional(Type.Integer()), name: Type.Optional(Type.String()), prompt: Type.Optional(Type.String()),
      timezone: Type.Optional(Type.String()),
      schedule: Type.Optional(Type.Union([
        Type.Object({ type: Type.Literal("once"), at: Type.String({ description: "RFC3339 timestamp" }) }),
        Type.Object({ type: Type.Literal("interval"), every_seconds: Type.Integer({ minimum: 1 }) }),
        Type.Object({ type: Type.Literal("cron"), expression: Type.String() }),
      ])),
    }), undefined, SCHEDULE_DESCRIPTION));
    tools.push({ name: "mcp", label: "mcp", description: "List configured MCP servers or call an MCP tool in the sandbox.",
      parameters: mcpSchema,
      execute: async (_id, params) => {
        const result = await terminal(`/usr/local/bin/agent-platform-mcp ${quote(Buffer.from(JSON.stringify(params)).toString("base64url"))}`, 35_000,
          { tool: "mcp", action: params.action, arguments: { ...(params.server === undefined ? {} : { server: params.server }), ...(params.tool === undefined ? {} : { tool: params.tool }) } });
        if (result.exit_code !== 0) throw new Error(result.stderr || result.stdout || "MCP failed");
        const data = JSON.parse(result.stdout);
        if (data.error || data.result?.isError) throw new Error(typeof data.error === "string" ? data.error : result.stdout);
        return text(result.stdout, data);
      } } satisfies ToolDefinition<typeof mcpSchema>);
  }
  return tools.filter(tool => dependencies.names.includes(tool.name)).map(tool => ({ ...tool,
    execute: (id, args, signal, update, context) => calls.run({ context: { ...dependencies.context(), tool_call_id: id }, signal, reads: new Map() }, () => tool.execute(id, args, signal, update, context)),
  }));
}
