import { constants } from "node:fs";
import { mkdir, open, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { JsonObject, JsonValue, RunRequest } from "./types.js";
import { PlatformGateway } from "./platform-gateway.js";
import { ProcessRegistry } from "./process-registry.js";
import { errorMessage, id, resolveWorkspacePath, throwIfAborted, truncate } from "./utils.js";

export interface ToolFactoryContext {
  runId: string;
  request: RunRequest;
  processes: ProcessRegistry;
  gateway: PlatformGateway;
  querySession: (action: string, arguments_: JsonObject, signal?: AbortSignal) => Promise<JsonValue>;
  delegate: (prompt: string, systemPrompt: string | undefined, signal?: AbortSignal) => Promise<string>;
  markSideEffect: () => void;
}

function textResult(content: string, details: JsonValue = null): AgentToolResult<JsonValue> {
  return { content: [{ type: "text", text: content }], details };
}

function objectValue(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonObject;
}

function gatewayResult(result: { content?: string; data?: JsonValue; is_error?: boolean }): AgentToolResult<JsonValue> {
  if (result.is_error) throw new Error(result.content || "Platform tool failed");
  return textResult(result.content || JSON.stringify(result.data ?? null, null, 2), result.data ?? null);
}

const terminalSchema = Type.Object({
  command: Type.String({ minLength: 1 }),
  cwd: Type.Optional(Type.String()),
  timeout_ms: Type.Optional(Type.Integer({ minimum: 100, maximum: 3_600_000 })),
  background: Type.Optional(Type.Boolean()),
});

const processSchema = Type.Object({
  action: Type.Union([Type.Literal("list"), Type.Literal("read"), Type.Literal("write"), Type.Literal("kill")]),
  process_id: Type.Optional(Type.String()),
  input: Type.Optional(Type.String()),
});

const readFileSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
});

const MAX_PATCH_FILE_BYTES = 10 * 1024 * 1024;

const writeFileSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  content: Type.String(),
});

const patchFileSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  old_text: Type.String({ minLength: 1 }),
  new_text: Type.String(),
  expected_replacements: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
});

const searchFilesSchema = Type.Object({
  query: Type.String({ minLength: 1 }),
  path: Type.Optional(Type.String()),
  regex: Type.Optional(Type.Boolean()),
  case_sensitive: Type.Optional(Type.Boolean()),
  max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
});

const gatewaySchema = Type.Object({
  action: Type.String({ minLength: 1 }),
  arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

const delegateSchema = Type.Object({
  prompt: Type.String({ minLength: 1 }),
  system_prompt: Type.Optional(Type.String()),
});

export function createTools(context: ToolFactoryContext): AgentTool[] {
  const terminal: AgentTool<typeof terminalSchema, JsonValue> = {
    name: "terminal",
    label: "Terminal",
    description: "Run a command on the host in this Agent's workspace. Use background=true for a long-lived process.",
    parameters: terminalSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate) {
      context.markSideEffect();
      const cwd = resolveWorkspacePath(context.request.workspace, params.cwd || ".");
      const options: Parameters<ProcessRegistry["run"]>[0] = {
        runId: context.runId,
        scopeKey: context.request.scope_key,
        lifecycleId: context.request.lifecycle_id,
        command: params.command,
        cwd,
        background: params.background ?? false,
        onUpdate(update) {
          const output = update.stdout ?? update.stderr ?? "";
          onUpdate?.(textResult(output, update));
        },
      };
      if (signal) options.signal = signal;
      if (params.timeout_ms !== undefined) options.timeoutMs = params.timeout_ms;
      const result = await context.processes.run(options);
      return textResult(
        result.status === "running"
          ? `Process started: ${result.id} (pid ${result.pid ?? "unknown"})`
          : `${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}\n[exit ${result.exit_code ?? "unknown"}]`,
        result as unknown as JsonValue,
      );
    },
  };

  const processTool: AgentTool<typeof processSchema, JsonValue> = {
    name: "process",
    label: "Process",
    description: "List, inspect, write to, or stop background processes owned by this Agent.",
    parameters: processSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      if (params.action === "list") {
        return textResult(JSON.stringify(
          context.processes.list(context.request.scope_key, context.request.lifecycle_id),
          null,
          2,
        ));
      }
      if (!params.process_id) throw new Error("process_id is required for this action");
      if (params.action === "read") {
        const process = context.processes.get(
          context.request.scope_key,
          params.process_id,
          context.request.lifecycle_id,
        );
        return textResult(`${process.stdout}${process.stderr ? `\n[stderr]\n${process.stderr}` : ""}`, process as unknown as JsonValue);
      }
      context.markSideEffect();
      if (params.action === "write") {
        context.processes.write(
          context.request.scope_key,
          params.process_id,
          params.input ?? "",
          context.request.lifecycle_id,
        );
        return textResult("Input sent");
      }
      return textResult(
        "Process stop requested",
        context.processes.kill(
          context.request.scope_key,
          params.process_id,
          context.request.lifecycle_id,
        ) as unknown as JsonValue,
      );
    },
  };

  const readTool: AgentTool<typeof readFileSchema, JsonValue> = {
    name: "read_file",
    label: "Read file",
    description: "Read a UTF-8 file from the Agent workspace with byte offset and limit support.",
    parameters: readFileSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const path = resolveWorkspacePath(context.request.workspace, params.path);
      await assertReadableTargetAllowed(path);
      const offset = params.offset ?? 0;
      const limit = params.limit ?? 100_000;
      const selected = await readRegularFileRange(path, offset, limit, signal);
      return textResult(selected.buffer.toString("utf8"), {
        path,
        offset,
        returned: selected.buffer.length,
        total: selected.total,
      });
    },
  };

  const writeTool: AgentTool<typeof writeFileSchema, JsonValue> = {
    name: "write_file",
    label: "Write file",
    description: "Create or replace a UTF-8 file in the Agent workspace atomically.",
    parameters: writeFileSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const path = resolveWorkspacePath(context.request.workspace, params.path);
      await assertWritableTargetAllowed(path);
      context.markSideEffect();
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${id("tmp")}`;
      try {
        await writeFile(temporary, params.content, { encoding: "utf8", mode: 0o600 });
        await assertWritableTargetAllowed(path);
        await rename(temporary, path);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      return textResult(`Wrote ${Buffer.byteLength(params.content)} bytes to ${params.path}`);
    },
  };

  const patchTool: AgentTool<typeof patchFileSchema, JsonValue> = {
    name: "patch_file",
    label: "Patch file",
    description: "Replace exact text in a workspace file, refusing ambiguous replacement counts.",
    parameters: patchFileSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const path = resolveWorkspacePath(context.request.workspace, params.path);
      await assertWritableTargetAllowed(path);
      const selected = await readRegularFileRange(
        path,
        0,
        MAX_PATCH_FILE_BYTES,
        signal,
        MAX_PATCH_FILE_BYTES,
      );
      const content = selected.buffer.toString("utf8");
      const count = content.split(params.old_text).length - 1;
      const expected = params.expected_replacements ?? 1;
      if (count !== expected) throw new Error(`Expected ${expected} replacements, found ${count}`);
      context.markSideEffect();
      const updated = content.split(params.old_text).join(params.new_text);
      const temporary = `${path}.${id("tmp")}`;
      try {
        await writeFile(temporary, updated, { encoding: "utf8", mode: 0o600 });
        await assertWritableTargetAllowed(path);
        await rename(temporary, path);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      return textResult(`Patched ${params.path} (${count} replacement${count === 1 ? "" : "s"})`);
    },
  };

  const searchTool: AgentTool<typeof searchFilesSchema, JsonValue> = {
    name: "search_files",
    label: "Search files",
    description: "Search filenames and UTF-8 file contents below a workspace directory.",
    parameters: searchFilesSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params, signal) {
      const root = resolveWorkspacePath(context.request.workspace, params.path || ".");
      await assertReadableTargetAllowed(root);
      const max = params.max_results ?? 100;
      const flags = params.case_sensitive ? "g" : "gi";
      let matcher: RegExp;
      try {
        matcher = new RegExp(params.regex ? params.query : escapeRegExp(params.query), flags);
      } catch (error) {
        throw new Error(`Invalid search expression: ${errorMessage(error)}`);
      }
      const results: string[] = [];
      await walk(root, async (path) => {
        if (results.length >= max) return;
        throwIfAborted(signal);
        const display = relative(context.request.workspace, path);
        matcher.lastIndex = 0;
        if (matcher.test(display)) results.push(`${display}: filename match`);
        if (results.length >= max) return;
        const info = await stat(path);
        if (!info.isFile() || info.size > 2_000_000) return;
        const { buffer } = await readRegularFileRange(path, 0, 2_000_000, signal, 2_000_000);
        if (buffer.includes(0)) return;
        const lines = buffer.toString("utf8").split("\n");
        for (let index = 0; index < lines.length && results.length < max; index += 1) {
          matcher.lastIndex = 0;
          if (matcher.test(lines[index] ?? "")) results.push(`${display}:${index + 1}:${truncate(lines[index] ?? "", 500)}`);
        }
      }, signal);
      return textResult(results.length ? results.join("\n") : "No matches", { count: results.length });
    },
  };

  const gatewayTools = (["memory", "knowledge", "web", "browser"] as const).map((name): AgentTool<typeof gatewaySchema, JsonValue> => ({
    name,
    label: name[0]!.toUpperCase() + name.slice(1),
    description: gatewayDescription(name),
    parameters: gatewaySchema,
    executionMode: name === "knowledge" || name === "web" ? "parallel" : "sequential",
    async execute(_toolCallId, params, signal) {
      if (isGatewayMutation(name, params.action)) context.markSideEffect();
      return gatewayResult(await context.gateway.invoke(context.request, context.runId, name, params.action, objectValue(params.arguments), signal));
    },
  }));

  const sessionTool: AgentTool<typeof gatewaySchema, JsonValue> = {
    name: "session",
    label: "Session",
    description: gatewayDescription("session"),
    parameters: gatewaySchema,
    executionMode: "parallel",
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const result = await context.querySession(
        params.action,
        objectValue(params.arguments),
        signal,
      );
      return textResult(JSON.stringify(result, null, 2), result);
    },
  };

  const delegateTool: AgentTool<typeof delegateSchema, JsonValue> = {
    name: "delegate_task",
    label: "Delegate task",
    description: "Delegate a bounded task to a child ubitech agent sharing the parent workspace but using an isolated session.",
    parameters: delegateSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      const result = await context.delegate(params.prompt, params.system_prompt, signal);
      return textResult(result);
    },
  };

  return [
    terminal,
    processTool,
    readTool,
    writeTool,
    patchTool,
    searchTool,
    sessionTool,
    ...gatewayTools,
    delegateTool,
  ];
}

export interface ToolPolicyResult {
  hardBlock?: string;
  approvalReason?: string;
}

export async function classifyToolCall(toolName: string, args: unknown, workspace?: string): Promise<ToolPolicyResult> {
  const values = objectValue(args);
  if (toolName === "terminal") {
    const command = typeof values.command === "string" ? values.command : "";
    const hardBlock = blockedCommand(command);
    if (hardBlock) return { hardBlock };
    return { approvalReason: "Run a command on the host" };
  }
  if (["read_file", "write_file", "patch_file", "search_files"].includes(toolName)) {
    const requestedPath = typeof values.path === "string" ? values.path : ".";
    const addressedPath = workspace ? resolveWorkspacePath(workspace, requestedPath) : requestedPath;
    const mutatesFile = toolName === "write_file" || toolName === "patch_file";
    if (mutatesFile) {
      try {
        await assertWritableTargetAllowed(addressedPath);
      } catch (error) {
        return { hardBlock: errorMessage(error) };
      }
      if (!workspace || await isOutsideWorkspace(workspace, addressedPath)) {
        return { approvalReason: "Write a file outside the Agent workspace" };
      }
      return { approvalReason: "Modify a file in the Agent workspace" };
    }
    try {
      await assertReadableTargetAllowed(addressedPath);
    } catch (error) {
      return { hardBlock: errorMessage(error) };
    }
    if (!workspace) {
      if (isAbsolute(requestedPath) || pathTraversesUp(requestedPath)) {
        return { approvalReason: "Access a path outside the Agent workspace" };
      }
      return {};
    }
    if (await isOutsideWorkspace(workspace, addressedPath)) {
      return { approvalReason: "Access a path outside the Agent workspace" };
    }
    return {};
  }
  if (toolName === "process" && values.action !== "list" && values.action !== "read") return { approvalReason: "Control a host process" };
  if (toolName === "memory" && !["search", "read", "list"].includes(String(values.action || ""))) {
    return { approvalReason: "Modify this Agent's durable memory" };
  }
  if (toolName === "browser" && [
    "click",
    "type",
    "press",
    "evaluate",
    "download",
    "close",
    "close_tab",
    "cleanup",
    "close_session",
  ].includes(String(values.action || ""))) {
    return { approvalReason: "Perform a sensitive browser action" };
  }
  return {};
}

async function isOutsideWorkspace(workspace: string, addressedPath: string): Promise<boolean> {
  const [canonicalWorkspace, canonicalTarget] = await Promise.all([
    canonicalPath(resolve(workspace)),
    canonicalPath(resolve(addressedPath)),
  ]);
  const fromWorkspace = relative(canonicalWorkspace, canonicalTarget);
  return fromWorkspace === ".." || fromWorkspace.startsWith("../") || isAbsolute(fromWorkspace);
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return await canonicalWriteTarget(path);
  }
}

function pathTraversesUp(path: string): boolean {
  return path.replaceAll("\\", "/").split("/").includes("..");
}

function blockedCommand(command: string): string | undefined {
  const normalized = command.toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/\b(?:shutdown|reboot|poweroff|halt)\b/, "System power operations are blocked"],
    [/\bmkfs(?:\.|\s)|\b(?:fdisk|parted)\b/, "Disk formatting and partitioning are blocked"],
    [/\brm\s+(?:-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\s+\/(?:\s|$|\*)/, "Recursive deletion of the system root is blocked"],
    [/:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/, "Fork bombs are blocked"],
    [/169\.254\.169\.254|metadata\.google\.internal/, "Cloud metadata access is blocked"],
    [/(?:\/var\/run|\/run)\/docker\.sock\b/, "Docker socket access is blocked"],
    [/(?:^|[\s"'=])\/proc\/(?:self|thread-self|\d+)\/(?:environ|cmdline|mem|fd)(?:\/|\b)/, "Reading process credentials and memory is blocked"],
  ];
  for (const [pattern, reason] of rules) if (pattern.test(normalized)) return reason;
  const withoutSafeDevices = normalized.replaceAll(/\/dev\/(?:null|stdin|stdout|stderr)\b/g, "");
  const protectedTarget = String.raw`\/(?:etc|boot|proc|sys|dev)(?:\/|\b)`;
  const destructiveWrite = new RegExp(String.raw`\b(?:rm|mv|cp|install|chmod|chown|truncate|tee|dd|ln|sed\s+-[^\n]*i)\b[^\n;&|]*${protectedTarget}`);
  const redirectedWrite = new RegExp(String.raw`(?:>|>>)\s*["']?${protectedTarget}`);
  if (destructiveWrite.test(withoutSafeDevices) || redirectedWrite.test(withoutSafeDevices)) {
    return "Writing protected host system paths is blocked";
  }
  return undefined;
}

function protectedWritePath(path: string): boolean {
  if (!path || !isAbsolute(path)) return false;
  const normalized = path.replaceAll("\\", "/");
  if (/^\/dev\/(?:null|stdin|stdout|stderr)$/.test(normalized)) return false;
  return /^\/(?:etc|boot|proc|sys|dev)(?:\/|$)/.test(normalized)
    || /^(?:\/var\/run|\/run)\/docker\.sock$/.test(normalized);
}

function protectedReadPath(path: string): boolean {
  if (!path || !isAbsolute(path)) return false;
  const normalized = path.replaceAll("\\", "/");
  return /^\/proc\/(?:self|thread-self|\d+)\/(?:environ|cmdline|mem|fd)(?:\/|$)/.test(normalized)
    || /^\/proc\/(?:kcore|keys|key-users)(?:\/|$)/.test(normalized);
}

export async function assertReadableTargetAllowed(target: string): Promise<void> {
  const addressed = resolve(target);
  if (protectedReadPath(addressed)) throw new Error(`Reading protected host path ${addressed} is blocked`);
  const canonical = await canonicalPath(addressed);
  if (protectedReadPath(canonical)) throw new Error(`Reading protected host path ${canonical} through a symlink is blocked`);
}

export async function assertWritableTargetAllowed(target: string): Promise<void> {
  const addressed = resolve(target);
  if (protectedWritePath(addressed)) throw new Error(`Writing protected host path ${addressed} is blocked`);
  const canonical = await canonicalWriteTarget(addressed);
  if (protectedWritePath(canonical)) throw new Error(`Writing protected host path ${canonical} through a symlink is blocked`);
}

async function canonicalWriteTarget(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let cursor = dirname(target);
  const suffix = [basename(target)];
  while (true) {
    try {
      const canonicalParent = await realpath(cursor);
      return resolve(canonicalParent, ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error(`Unable to resolve a safe parent for ${target}`);
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

export async function readRegularFileRange(
  path: string,
  offset: number,
  limit: number,
  signal?: AbortSignal,
  maximumTotalBytes?: number,
): Promise<{ buffer: Buffer; total: number }> {
  throwIfAborted(signal);
  // O_NONBLOCK prevents opening a FIFO from pinning the Agent run forever.
  // Descriptor-level stat then closes the lstat/open race for devices and
  // other non-regular paths.
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Agent file tools require a regular file: ${path}`);
    if (!Number.isSafeInteger(info.size) || info.size < 0) {
      throw new Error(`Agent file size is invalid: ${path}`);
    }
    if (maximumTotalBytes !== undefined && info.size > maximumTotalBytes) {
      throw new Error(`File exceeds the ${maximumTotalBytes}-byte tool limit: ${path}`);
    }
    const start = Math.min(offset, info.size);
    const length = Math.max(0, Math.min(limit, info.size - start));
    const buffer = Buffer.alloc(length);
    let consumed = 0;
    while (consumed < length) {
      throwIfAborted(signal);
      const { bytesRead } = await handle.read(
        buffer,
        consumed,
        length - consumed,
        start + consumed,
      );
      if (bytesRead === 0) break;
      consumed += bytesRead;
    }
    throwIfAborted(signal);
    return { buffer: buffer.subarray(0, consumed), total: info.size };
  } finally {
    await handle.close();
  }
}

async function walk(root: string, visit: (path: string) => Promise<void>, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    throwIfAborted(signal);
    if (entry.isSymbolicLink() || entry.name === ".git" || entry.name === "node_modules") continue;
    const path = resolveWorkspacePath(root, entry.name);
    if (entry.isDirectory()) await walk(path, visit, signal);
    else if (entry.isFile()) await visit(path);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function gatewayDescription(name: "memory" | "session" | "knowledge" | "web" | "browser"): string {
  const descriptions = {
    memory: "Manage durable memory isolated to this Agent. Actions: search, read, list, store, replace, forget, clear.",
    session: "Inspect this Agent's isolated session journal. Actions: search (arguments.query), read (arguments.index), list; arguments.limit bounds results.",
    knowledge: "Use the platform knowledge base. Actions: search, read.",
    web: "Use the managed web gateway. Actions: search, extract.",
    browser: "Use this Agent's isolated managed browser profile. Actions: navigate, list, snapshot, screenshot, click, type, scroll, back, press, evaluate, console, close.",
  };
  return descriptions[name];
}

function isGatewayMutation(name: string, action: string): boolean {
  if (name === "memory") return !["search", "read", "list"].includes(action);
  if (name === "browser") return !["snapshot", "screenshot", "status"].includes(action);
  return false;
}

export type TerminalParams = Static<typeof terminalSchema>;
