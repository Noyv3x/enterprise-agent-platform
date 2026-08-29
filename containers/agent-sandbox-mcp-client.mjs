#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_WORKSPACE = "/workspace";
const DEFAULT_CONFIG = "/workspace/.agent-platform/mcp.json";
const CONFIG_MAX_BYTES = 256 * 1024;
const REQUEST_MAX_BYTES = 12 * 1024;
const STDOUT_MAX_BYTES = 1024 * 1024;
const STDERR_MAX_BYTES = 64 * 1024;
const LINE_MAX_BYTES = 256 * 1024;
const MESSAGE_MAX_COUNT = 256;
const SERVER_MAX_COUNT = 32;
const SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export async function executeMcpRequest(request, options = {}) {
  assertRequest(request);
  const workspaceRoot = await realpath(options.workspaceRoot ?? DEFAULT_WORKSPACE);
  const configPath = options.configPath ?? DEFAULT_CONFIG;
  const servers = await loadServers(workspaceRoot, configPath, request.action === "list");
  const deadline = Date.now() + (options.timeoutMs ?? 25_000);

  if (request.action === "call") {
    const server = servers.get(request.server);
    if (!server) throw new Error(`MCP server ${request.server} is not configured`);
    const response = await exchange(server, "tools/call", {
      name: request.tool,
      arguments: request.arguments,
    }, deadline);
    return { server: request.server, tool: request.tool, ...response };
  }

  if (request.server === undefined) return { servers: [...servers.keys()] };
  const server = servers.get(request.server);
  if (!server) {
    throw new Error(`MCP server ${request.server} is not configured`);
  }
  const response = await exchange(server, "tools/list", {}, deadline);
  return { server: request.server, ...response };
}

async function loadServers(workspaceRoot, configPath, missingIsEmpty) {
  let descriptor;
  try {
    descriptor = await open(configPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const configRealPath = await realpath(`/proc/self/fd/${descriptor.fd}`);
    if (!within(workspaceRoot, configRealPath)) throw new Error("MCP config must remain inside the workspace");
  } catch (error) {
    await descriptor?.close();
    if (missingIsEmpty && error?.code === "ENOENT") return new Map();
    throw error;
  }
  try {
    const metadata = await descriptor.stat();
    if (!metadata.isFile() || metadata.size > CONFIG_MAX_BYTES) {
      throw new Error(`MCP config exceeds ${CONFIG_MAX_BYTES} bytes or is not a regular file`);
    }
    const bytes = await descriptor.readFile();
    let parsed;
    try {
      parsed = JSON.parse(textDecoder.decode(bytes));
    } catch {
      throw new Error("MCP config must be valid UTF-8 JSON");
    }
    requireObject(parsed, "MCP config");
    requireKeys(parsed, ["mcpServers"], "MCP config");
    requireObject(parsed.mcpServers, "mcpServers");
    const entries = Object.entries(parsed.mcpServers);
    if (entries.length > SERVER_MAX_COUNT) throw new Error(`MCP config exceeds ${SERVER_MAX_COUNT} servers`);
    const result = new Map();
    for (const [id, raw] of entries.sort(([left], [right]) => left.localeCompare(right))) {
      if (!SERVER_ID.test(id)) throw new Error("MCP config contains an invalid server id");
      result.set(id, await normalizeServer(raw, workspaceRoot));
    }
    return result;
  } finally {
    await descriptor.close();
  }
}

async function normalizeServer(raw, workspaceRoot) {
  requireObject(raw, "MCP server");
  requireKeys(raw, ["command", "args", "env", "cwd"], "MCP server");
  if (typeof raw.command !== "string" || utf8Bytes(raw.command) < 1 || utf8Bytes(raw.command) > 4_096 || raw.command.includes("\0")) {
    throw new Error("MCP server command must be a bounded string");
  }
  const cwdCandidate = raw.cwd === undefined ? workspaceRoot : raw.cwd;
  if (typeof cwdCandidate !== "string" || utf8Bytes(cwdCandidate) > 4_096 || cwdCandidate.includes("\0")) {
    throw new Error("MCP server cwd must be a bounded string");
  }
  const pinnedCwd = await pinWorkspaceDirectory(
    workspaceRoot,
    isAbsolute(cwdCandidate) ? cwdCandidate : resolve(workspaceRoot, cwdCandidate),
  );
  const cwd = pinnedCwd.path;
  await pinnedCwd.descriptor.close();

  const args = raw.args ?? [];
  if (!Array.isArray(args) || args.length > 64) throw new Error("MCP server args must be an array of at most 64 strings");
  let argumentBytes = 0;
  for (const argument of args) {
    if (typeof argument !== "string" || argument.includes("\0") || utf8Bytes(argument) > 8_192) {
      throw new Error("MCP server args must contain bounded strings");
    }
    argumentBytes += utf8Bytes(argument);
  }
  if (argumentBytes > 64 * 1024) throw new Error("MCP server args exceed 64 KiB");

  const configuredEnv = raw.env ?? {};
  requireObject(configuredEnv, "MCP server env");
  if (Object.keys(configuredEnv).length > 64) throw new Error("MCP server env exceeds 64 entries");
  let environmentBytes = 0;
  for (const [name, value] of Object.entries(configuredEnv)) {
    if (!ENV_NAME.test(name) || typeof value !== "string" || value.includes("\0") || utf8Bytes(value) > 8_192) {
      throw new Error("MCP server env contains an invalid entry");
    }
    environmentBytes += utf8Bytes(name) + utf8Bytes(value);
  }
  if (environmentBytes > 64 * 1024) throw new Error("MCP server env exceeds 64 KiB");

  let command = raw.command;
  let commandPath;
  if (raw.command.includes("/")) {
    const pinnedCommand = await pinWorkspaceCommand(
      workspaceRoot,
      isAbsolute(raw.command) ? raw.command : resolve(cwd, raw.command),
    );
    command = pinnedCommand.path;
    commandPath = pinnedCommand.path;
    await pinnedCommand.descriptor.close();
  }
  return {
    command,
    commandPath,
    args: [...args],
    cwd,
    workspaceRoot,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "/home/agent",
      LANG: process.env.LANG ?? "C.UTF-8",
      ...configuredEnv,
    },
  };
}

async function exchange(server, method, params, deadline) {
  const timeoutMs = deadline - Date.now();
  if (timeoutMs <= 0) throw new Error("MCP request timed out");
  const pinnedCwd = await pinWorkspaceDirectory(server.workspaceRoot, server.cwd);
  let pinnedCommand;
  try {
    pinnedCommand = server.commandPath
      ? await pinWorkspaceCommand(server.workspaceRoot, server.commandPath)
      : undefined;
    return await new Promise((resolveResult, rejectResult) => {
      const child = spawn(pinnedCommand ? "/proc/self/fd/3" : server.command, server.args, {
        cwd: "/proc/self/fd/4",
        env: server.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe", pinnedCommand?.descriptor.fd ?? "ignore", pinnedCwd.descriptor.fd],
        windowsHide: true,
      });
    let stage = 1;
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let messages = 0;
    let buffer = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const timer = setTimeout(() => fail(new Error("MCP request timed out")), timeoutMs);

    const stop = () => {
      clearTimeout(timer);
      child.stdin.end();
      if (!child.killed) child.kill("SIGTERM");
      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 250);
      killTimer.unref();
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      stop();
      rejectResult(error);
    };
    const succeed = (result) => {
      if (settled) return;
      settled = true;
      stop();
      resolveResult(result);
    };
    const send = (message) => {
      if (settled) return;
      const line = `${JSON.stringify(message)}\n`;
      if (utf8Bytes(line) > LINE_MAX_BYTES) {
        fail(new Error("MCP client request exceeds the message limit"));
        return;
      }
      child.stdin.write(line, (error) => {
        if (error) fail(new Error("MCP server input failed"));
      });
    };
    const handle = (message) => {
      requireObject(message, "MCP message");
      if (message.jsonrpc !== "2.0") throw new Error("MCP server returned an invalid JSON-RPC version");
      if (typeof message.method === "string") {
        if (Object.hasOwn(message, "id")) {
          send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Method not supported" },
          });
        }
        return;
      }
      if (message.id !== stage) throw new Error("MCP server returned a mismatched response id");
      const hasError = Object.hasOwn(message, "error");
      const hasResult = Object.hasOwn(message, "result");
      if (hasError === hasResult) throw new Error("MCP server response must contain exactly one result or error");
      if (hasError) {
        succeed({ error: boundedProtocolError(message.error) });
        return;
      }
      assertJsonBounds(message.result);
      if (stage === 1) {
        requireObject(message.result, "MCP initialize result");
        if (
          typeof message.result.protocolVersion !== "string"
          || utf8Bytes(message.result.protocolVersion) < 1
          || utf8Bytes(message.result.protocolVersion) > 32
        ) {
          throw new Error("MCP initialize result has an invalid protocol version");
        }
        stage = 2;
        send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
        send({ jsonrpc: "2.0", id: 2, method, params });
      } else {
        succeed({ result: message.result });
      }
    };

    child.stdout.on("data", (chunk) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > STDOUT_MAX_BYTES) return fail(new Error("MCP server stdout exceeds 1 MiB"));
      try {
        buffer += decoder.decode(chunk, { stream: true });
      } catch {
        return fail(new Error("MCP server stdout is not valid UTF-8"));
      }
      if (utf8Bytes(buffer) > LINE_MAX_BYTES && !buffer.includes("\n")) {
        return fail(new Error("MCP server message exceeds 256 KiB"));
      }
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        messages += 1;
        if (messages > MESSAGE_MAX_COUNT || utf8Bytes(line) > LINE_MAX_BYTES) {
          return fail(new Error("MCP server exceeded the message limit"));
        }
        try {
          handle(JSON.parse(line));
        } catch (error) {
          return fail(error instanceof Error ? error : new Error("MCP server returned invalid JSON"));
        }
        if (settled) return;
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > STDERR_MAX_BYTES) fail(new Error("MCP server stderr exceeds 64 KiB"));
    });
    child.stdin.on("error", () => fail(new Error("MCP server input failed")));
    child.on("error", () => fail(new Error("MCP server could not be started")));
    child.on("exit", () => {
      if (!settled) fail(new Error("MCP server exited before returning a result"));
    });

      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "agent-platform-mcp-client", version: "1" },
        },
      });
    });
  } finally {
    await pinnedCommand?.descriptor.close();
    await pinnedCwd.descriptor.close();
  }
}

function boundedProtocolError(value) {
  requireObject(value, "MCP error");
  requireKeys(value, ["code", "message", "data"], "MCP error");
  if (!Number.isSafeInteger(value.code)) throw new Error("MCP error code is invalid");
  if (typeof value.message !== "string" || utf8Bytes(value.message) > 2_048) {
    throw new Error("MCP error message is invalid");
  }
  const result = { code: value.code, message: value.message };
  if (Object.hasOwn(value, "data")) {
    assertJsonBounds(value.data);
    result.data = value.data;
  }
  return result;
}

function assertRequest(request) {
  requireObject(request, "MCP request");
  if (request.action !== "list" && request.action !== "call") throw new Error("MCP action must be list or call");
  requireKeys(request, request.action === "list"
    ? ["action", "server"]
    : ["action", "server", "tool", "arguments"], "MCP request");
  if (request.server !== undefined && (typeof request.server !== "string" || !SERVER_ID.test(request.server))) {
    throw new Error("MCP server id is invalid");
  }
  if (request.action === "call") {
    if (typeof request.server !== "string") throw new Error("MCP call requires server");
    if (typeof request.tool !== "string" || utf8Bytes(request.tool) < 1 || utf8Bytes(request.tool) > 256 || /[\u0000-\u001f\u007f]/.test(request.tool)) {
      throw new Error("MCP tool name is invalid");
    }
    requireObject(request.arguments, "MCP call arguments");
    assertJsonBounds(request.arguments);
  }
  if (utf8Bytes(JSON.stringify(request)) > REQUEST_MAX_BYTES) throw new Error("MCP request exceeds 12 KiB");
}

function assertJsonBounds(value, depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (depth > 16 || budget.nodes > 2_048) throw new Error("MCP JSON value exceeds structural limits");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("MCP JSON value contains a non-finite number");
    return;
  }
  if (typeof value === "string") {
    if (utf8Bytes(value) > 8_192) throw new Error("MCP JSON string exceeds 8 KiB");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw new Error("MCP JSON array exceeds 100 items");
    for (const item of value) assertJsonBounds(item, depth + 1, budget);
    return;
  }
  requireObject(value, "MCP JSON value");
  const entries = Object.entries(value);
  if (entries.length > 100) throw new Error("MCP JSON object exceeds 100 fields");
  for (const [key, item] of entries) {
    if (utf8Bytes(key) > 256 || key.includes("\0")) throw new Error("MCP JSON key is invalid");
    assertJsonBounds(item, depth + 1, budget);
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function requireKeys(value, allowed, label) {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) throw new Error(`${label} contains unsupported fields`);
}

function within(root, target) {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function pinWorkspaceDirectory(workspaceRoot, candidate) {
  return await pinWorkspacePath(workspaceRoot, candidate, true);
}

async function pinWorkspaceCommand(workspaceRoot, candidate) {
  return await pinWorkspacePath(workspaceRoot, candidate, false);
}

async function pinWorkspacePath(workspaceRoot, candidate, directory) {
  const flags = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (directory ? fsConstants.O_DIRECTORY : 0);
  const descriptor = await open(candidate, flags);
  try {
    const path = await realpath(`/proc/self/fd/${descriptor.fd}`);
    if (!within(workspaceRoot, path)) {
      throw new Error(directory
        ? "MCP server cwd must be a workspace directory"
        : "MCP server command path must remain inside the workspace");
    }
    const metadata = await descriptor.stat();
    if (directory ? !metadata.isDirectory() : !metadata.isFile() || (metadata.mode & 0o111) === 0) {
      throw new Error(directory
        ? "MCP server cwd must be a workspace directory"
        : "MCP server command path must be an executable file");
    }
    return { descriptor, path };
  } catch (error) {
    await descriptor.close();
    throw error;
  }
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, "utf8");
}

function decodeCliRequest(argument) {
  if (typeof argument !== "string" || argument.length < 1 || argument.length > 20_000 || !/^[A-Za-z0-9_-]+$/.test(argument)) {
    throw new Error("MCP client request payload is invalid");
  }
  const bytes = Buffer.from(argument, "base64url");
  if (bytes.length > REQUEST_MAX_BYTES || bytes.toString("base64url") !== argument) {
    throw new Error("MCP client request payload is invalid");
  }
  try {
    return JSON.parse(textDecoder.decode(bytes));
  } catch {
    throw new Error("MCP client request payload is not valid UTF-8 JSON");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error("MCP client accepts exactly one request payload");
    const result = await executeMcpRequest(decodeCliRequest(process.argv[2]));
    const output = JSON.stringify(result);
    if (utf8Bytes(output) > STDOUT_MAX_BYTES) throw new Error("MCP result exceeds 1 MiB");
    process.stdout.write(`${output}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "MCP client failed";
    process.stderr.write(`${message.slice(0, 2_048)}\n`);
    process.exitCode = 1;
  }
}
