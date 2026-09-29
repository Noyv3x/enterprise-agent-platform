import { resolve } from "node:path";
import { TERMINAL_TIMEOUT_DEFAULT_MILLISECONDS } from "./design-contract.generated.js";
import type { JsonObject } from "./types.js";
import { stableHash } from "./utils.js";

export const APPROVAL_ARGUMENT_MAX_BYTES = 16 * 1024;

const SENSITIVE_COMMAND_NAME = /token|password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|credential|cookie|auth|pat|session(?:[_-]?(?:id|key|token|secret))?/i;
const SENSITIVE_HEADER_NAME_SOURCE = "(?:authorization|proxy-authorization|(?:x[-_])?(?:api[-_]?key|access[-_]?token|auth[-_]?token|secret)|(?:set-)?cookie)";
const FORBIDDEN_TERMINAL_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
const FORBIDDEN_TERMINAL_CONTROLS_GLOBAL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

export interface ApprovalObject {
  key: string;
  displayArguments: JsonObject;
}


/** A display-only copy.  The returned value must never be executed. */
export function redactCommandForApproval(value: string): string {
  return boundedUtf8(redactCommand(value), APPROVAL_ARGUMENT_MAX_BYTES);
}

function redactCommand(value: string): string {
  const command = stripTerminalControls(value);
  const display = redactCommandFlat(command);
  return display !== command && hasAmbiguousCredentialDisplay(command)
    ? "[command omitted: redacted sensitive value with complex shell syntax]"
    : display;
}

function redactCommandFlat(value: string): string {
  let command = value;
  command = redactKnownClientCredentialArguments(command);
  command = redactCurlSensitiveHeaders(command);
  command = command.replace(
    /(["'])((?:authorization|proxy-authorization|(?:x[-_])?(?:api[-_]?key|access[-_]?token|auth[-_]?token|secret)|(?:set-)?cookie)\s*:)[\s\S]*?\1/gi,
    "$1$2 [redacted]$1",
  );
  // Match the authentication scheme and its value before the generic header
  // fallback; otherwise the fallback would redact only "Bearer"/"Basic" and
  // leave the credential itself visible.
  command = command.replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s'";|&]+/gi, "$1[redacted]");
  command = command.replace(
    /((?:^|\s)(?:authorization|proxy-authorization|(?:x[-_])?(?:api[-_]?key|access[-_]?token|auth[-_]?token|secret))\s*:\s*)[^\s'";|&]+/gi,
    "$1[redacted]",
  );
  command = command.replace(
    redactedAssignmentPattern(),
    (match, name: string) => SENSITIVE_COMMAND_NAME.test(name) ? `${name}=[redacted]` : match,
  );
  command = command.replace(/((?:set-)?cookie\s*:\s*)[^\s'";|&]+/gi, "$1[redacted]");
  command = command.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi, "$1[redacted]@");
  command = command.replace(
    /([?&])([A-Za-z0-9_.-]{1,128})=([^&#\s'";|]+)/g,
    (match, separator: string, name: string) => SENSITIVE_COMMAND_NAME.test(name)
      ? `${separator}${name}=[redacted]`
      : match,
  );
  command = command.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/g, "[redacted]");
  command = command.replace(/\b(?:github_pat_|gh[pousr]_|glpat-|sk-)[A-Za-z0-9_-]{16,}\b/gi, "[redacted]");
  return command;
}

// Display-only credential matching, not a shell parser or execution policy.
// Match quoted and attached values together so suffixes cannot escape redaction.
const CREDENTIAL_WORD = String.raw`(?:[^\s'";|&]+|"[^"]*"|'[^']*')+`;
const CLIENT_CREDENTIAL_OPTIONS = [
  ["curl", "-[uUb](?:=|\\s*)|--(?:user|proxy-user)(?:=|\\s+)"],
  ["sshpass|mysql(?:admin|dump)?|mariadb(?:-admin|-dump)?|mongo(?:sh)?", "-p(?:=|\\s*)"],
  ["redis-cli|valkey-cli", "-a(?:=|\\s*)"],
  ["(?:docker|podman|nerdctl)\\s+login", "-p(?:=|\\s*)"],
  ["smbclient", "-U(?:=|\\s*)"],
  ["ldapsearch", "-w(?:=|\\s*)"],
  ["sqlcmd|mosquitto_pub|mosquitto_sub", "-P(?:=|\\s*)"],
].map(([client, options]) => ({
  client: new RegExp(String.raw`\b(?:${client})\b([\s\S]*)`),
  option: new RegExp(String.raw`(\s(?:${options}))${CREDENTIAL_WORD}`, "g"),
}));
const NAMED_CREDENTIAL_OPTION = new RegExp(
  String.raw`(^|[\s'"])(-{1,2}(?=[A-Za-z0-9_-]*(?:${SENSITIVE_COMMAND_NAME.source}|pass|pwd))[A-Za-z][A-Za-z0-9_-]{1,127})(=|\s+)${CREDENTIAL_WORD}`,
  "gi",
);

function redactKnownClientCredentialArguments(command: string): string {
  let display = command.replace(NAMED_CREDENTIAL_OPTION, "$1$2$3[redacted]");
  for (const { client, option } of CLIENT_CREDENTIAL_OPTIONS) {
    display = display.replace(client, (match, arguments_: string) =>
      match.slice(0, match.length - arguments_.length) + arguments_.replace(option, "$1[redacted]"));
  }
  return display;
}

function hasAmbiguousCredentialDisplay(command: string): boolean {
  // Deliberately conservative: do not interpret quoting, expansion or evaluators
  // around a hidden value. Ordinary commands without credentials are unaffected.
  return /[$`\\<>]|\b(?:eval|source|sh|bash|zsh|ksh|dash)\b/.test(command);
}

function redactCurlSensitiveHeaders(command: string): string {
  return command.replace(
    curlHeaderArgumentPattern(),
    (match, leading: string, option: string, argument: string) => {
      const parsed = parseSensitiveHeaderArgument(argument);
      if (!parsed) return match;
      return `${leading}${option}${parsed.quote}${parsed.prefix}[redacted]${parsed.quote}`;
    },
  );
}

function curlHeaderArgumentPattern(): RegExp {
  return /(^|[\s;|&])((?:--header(?:[\t\r\n ]*=[\t\r\n ]*|[\t\r\n ]+)|-H(?:[\t\r\n ]*=[\t\r\n ]*|[\t\r\n ]*)))("[^"\r\n]*"|'[^'\r\n]*'|[^\s;|&]+)/gi;
}

function redactedAssignmentPattern(): RegExp {
  return /\b([A-Za-z_][A-Za-z0-9_.-]{0,127})\s*=\s*("[^"]*"|'[^']*'|[^\s;|&]+)/g;
}


function parseSensitiveHeaderArgument(argument: string): { quote: string; prefix: string } | undefined {
  const quote = (argument.startsWith("\"") && argument.endsWith("\""))
    || (argument.startsWith("'") && argument.endsWith("'"))
    ? argument[0] ?? ""
    : "";
  const inner = quote ? argument.slice(1, -1) : argument;
  const matched = new RegExp(`^(\\s*${SENSITIVE_HEADER_NAME_SOURCE}\\s*:\\s*)`, "i").exec(inner);
  const prefix = matched?.[1];
  return prefix === undefined ? undefined : { quote, prefix };
}


export function terminalApprovalObject(
  args: JsonObject,
  workspace?: string,
  defaultTimeoutMs: number = TERMINAL_TIMEOUT_DEFAULT_MILLISECONDS,
): ApprovalObject {
  const command = stringValue(args.command);
  const validationError = terminalCommandValidationError(command);
  if (validationError) throw new Error(validationError);
  const requestedCwd = stringValue(args.cwd) || ".";
  const cwd = resolve(workspace ? resolve(workspace) : process.cwd(), requestedCwd);
  const background = args.background === true;
  // Foreground execution always has an effective deadline. Background work
  // has no implicit deadline, but an explicitly requested auto-kill deadline
  // is execution-relevant and therefore belongs to the approval identity.
  const timeoutMs = background && args.timeout_ms === undefined
    ? undefined
    : effectiveTerminalTimeout(args.timeout_ms, defaultTimeoutMs);
  const identity: JsonObject = { command, cwd, background };
  const displayArguments: JsonObject = {
    command: redactCommand(command),
    cwd,
    background,
  };
  if (timeoutMs !== undefined) {
    identity.timeout_ms = timeoutMs;
    displayArguments.timeout_ms = timeoutMs;
  }
  return {
    key: approvalKey("terminal", identity),
    displayArguments,
  };
}

export function fileApprovalObject(toolName: string, target: string, args: JsonObject): ApprovalObject {
  const normalizedTarget = resolve(target);
  const executionArguments = effectiveFileArguments(toolName, normalizedTarget, args);
  const displayArguments = displayFileArguments(toolName, executionArguments);
  const validationError = approvalDisplayValidationError(displayArguments);
  if (validationError) throw new Error(validationError);
  return {
    key: approvalKey(toolName, executionArguments),
    displayArguments,
  };
}

function effectiveFileArguments(toolName: string, target: string, args: JsonObject): JsonObject {
  if (toolName === "read_file") {
    return {
      path: target,
      offset: typeof args.offset === "number" ? args.offset : 0,
      limit: typeof args.limit === "number" ? args.limit : 100_000,
    };
  }
  if (toolName === "write_file") {
    return { path: target, content: stringValue(args.content) };
  }
  if (toolName === "patch_file") {
    return {
      path: target,
      old_text: stringValue(args.old_text),
      new_text: stringValue(args.new_text),
      expected_replacements: typeof args.expected_replacements === "number"
        ? args.expected_replacements
        : 1,
    };
  }
  if (toolName === "search_files") {
    return {
      path: target,
      query: stringValue(args.query),
      regex: args.regex === true,
      case_sensitive: args.case_sensitive === true,
      max_results: typeof args.max_results === "number" ? args.max_results : 100,
    };
  }
  return { ...args, path: target };
}

function displayFileArguments(toolName: string, args: JsonObject): JsonObject {
  if (toolName === "write_file") {
    return {
      path: args.path,
      content: `[content omitted: ${Buffer.byteLength(stringValue(args.content), "utf8")} UTF-8 bytes]`,
    };
  }
  if (toolName === "patch_file") {
    return {
      path: args.path,
      old_text: `[old_text omitted: ${Buffer.byteLength(stringValue(args.old_text), "utf8")} UTF-8 bytes]`,
      new_text: `[new_text omitted: ${Buffer.byteLength(stringValue(args.new_text), "utf8")} UTF-8 bytes]`,
      expected_replacements: args.expected_replacements,
    };
  }
  if (toolName === "search_files") {
    return { ...args, query: redactCommandForApproval(stringValue(args.query)) };
  }
  return { ...args };
}

export function actionApprovalObject(toolName: string, args: JsonObject): ApprovalObject {
  const action = stringValue(args.action) || "default";
  const nested = objectValue(args.arguments);
  const executionArguments = toolName === "process" || toolName === "mcp"
    ? Object.fromEntries(Object.entries(args).filter(([key]) => key !== "action"))
    : nested;
  if (toolName === "mcp") validateMcpApprovalValue(executionArguments);
  const identity = { action, arguments: executionArguments };
  const displayArguments = displayActionArguments(toolName, action, executionArguments);
  const validationError = approvalDisplayValidationError(displayArguments);
  if (validationError) throw new Error(validationError);
  return {
    key: approvalKey(toolName, identity),
    displayArguments,
  };
}

/** Build the bounded, display-only argument object stored in Runtime events. */
export function redactToolArgumentsForJournal(
  toolName: string,
  args: JsonObject,
  workspace?: string,
): JsonObject {
  if (toolName === "mcp") {
    try {
      return mcpActivityProjection(args);
    } catch (error) {
      return {
        tool: "mcp",
        action: "invalid",
        arguments: {},
        rejected: true,
        validation_error: error instanceof Error ? error.message : "Invalid MCP arguments",
      };
    }
  }
  if (toolName === "terminal") {
    try {
      return terminalApprovalObject(args, workspace).displayArguments;
    } catch (error) {
      return {
        command: redactCommandForApproval(stringValue(args.command)),
        cwd: resolve(workspace ? resolve(workspace) : process.cwd(), stringValue(args.cwd) || "."),
        background: args.background === true,
        rejected: true,
        validation_error: error instanceof Error ? error.message : "Invalid terminal arguments",
      };
    }
  }
  if (["read_file", "write_file", "patch_file", "search_files"].includes(toolName)) {
    const requested = stringValue(args.path) || ".";
    const target = resolve(workspace ? resolve(workspace) : process.cwd(), requested);
    const result: JsonObject = { path: target };
    if (toolName === "read_file") {
      if (typeof args.offset === "number") result.offset = args.offset;
      if (typeof args.limit === "number") result.limit = args.limit;
    } else if (toolName === "search_files") {
      result.query = redactCommandForApproval(stringValue(args.query));
      if (typeof args.regex === "boolean") result.regex = args.regex;
      if (typeof args.case_sensitive === "boolean") result.case_sensitive = args.case_sensitive;
      if (typeof args.max_results === "number") result.max_results = args.max_results;
    } else if (toolName === "patch_file" && typeof args.expected_replacements === "number") {
      result.expected_replacements = args.expected_replacements;
    }
    return result;
  }
  if (["process", "memory", "skill", "browser", "schedule", "mail"].includes(toolName)) {
    try {
      return actionApprovalObject(toolName, args).displayArguments;
    } catch (error) {
      return {
        tool: toolName,
        action: stringValue(args.action) || "default",
        arguments: "[arguments omitted because the approval display limit was exceeded]",
        rejected: true,
        validation_error: error instanceof Error ? error.message : "Invalid approval arguments",
      };
    }
  }
  if (toolName === "delegate_task") {
    const tasks = Array.isArray(args.tasks) ? args.tasks : undefined;
    if (tasks) {
      return {
        tasks: tasks.map((task) => {
          const candidate = objectValue(task);
          return {
            prompt: "[delegated prompt omitted from durable and event records]",
            ...(candidate.role === "leaf" || candidate.role === "orchestrator"
              ? { role: candidate.role }
              : {}),
          };
        }),
      };
    }
    return {
      prompt: "[delegated prompt omitted from durable and event records]",
      ...(args.role === "leaf" || args.role === "orchestrator" ? { role: args.role } : {}),
    };
  }
  return redactJson(args) as JsonObject;
}

function terminalCommandValidationError(command: string): string | undefined {
  if (hasForbiddenTerminalControls(command)) {
    return "Terminal command contains forbidden control characters";
  }
  if (Buffer.byteLength(command, "utf8") > APPROVAL_ARGUMENT_MAX_BYTES) {
    return `Terminal command exceeds the complete approval display limit of ${APPROVAL_ARGUMENT_MAX_BYTES} UTF-8 bytes`;
  }
  if (redactCommandFlat(command) !== command && hasAmbiguousCredentialDisplay(command)) {
    return "Terminal command contains a redacted sensitive value with complex shell syntax";
  }
  if (Buffer.byteLength(redactCommand(command), "utf8") > APPROVAL_ARGUMENT_MAX_BYTES) {
    return `Redacted terminal command exceeds the complete approval display limit of ${APPROVAL_ARGUMENT_MAX_BYTES} UTF-8 bytes`;
  }
  return undefined;
}

export function processWriteHardBlock(input: string): string | undefined {
  if (Buffer.byteLength(input, "utf8") > APPROVAL_ARGUMENT_MAX_BYTES) {
    return `Process input exceeds the complete approval display limit of ${APPROVAL_ARGUMENT_MAX_BYTES} UTF-8 bytes`;
  }
  if (redactCommand(input) !== stripTerminalControls(input)) {
    return "Process input cannot persist a redacted sensitive value in a long-lived shell";
  }
  if (Buffer.byteLength(redactCommand(input), "utf8") > APPROVAL_ARGUMENT_MAX_BYTES) {
    return `Redacted process input exceeds the complete approval display limit of ${APPROVAL_ARGUMENT_MAX_BYTES} UTF-8 bytes`;
  }
  return terminalCommandValidationError(input);
}

function effectiveTerminalTimeout(value: unknown, defaultTimeoutMs: number): number {
  const timeoutMs = value === undefined ? defaultTimeoutMs : value;
  if (!Number.isSafeInteger(timeoutMs) || Number(timeoutMs) <= 0) {
    throw new Error("Foreground terminal timeout must be a positive integer");
  }
  return Number(timeoutMs);
}


function approvalKey(toolName: string, identity: JsonObject): string {
  return `v2:${toolName}:${stableHash(canonicalJson(identity))}`;
}

function displayActionArguments(
  toolName: string,
  action: string,
  args: JsonObject,
): JsonObject {
  const display = redactActionArguments(toolName, action, args);
  return { tool: toolName, action, arguments: display };
}

function redactActionArguments(toolName: string, action: string, args: JsonObject): JsonObject {
  if (toolName === "mcp") return redactCompleteJson(args) as JsonObject;
  const omittedBodyKeys = omittedActionBodyKeys(toolName, action);
  const display: JsonObject = {};
  for (const [key, value] of Object.entries(args)) {
    if (omittedBodyKeys.includes(key)) {
      const body = stringValue(value);
      const label = toolName === "browser" && key === "text" ? "input" : key;
      display[key] = `[${label} omitted: ${Buffer.byteLength(body, "utf8")} UTF-8 bytes]`;
    } else {
      display[key] = redactJson(value);
    }
  }
  if (toolName === "process" && action === "write" && Object.hasOwn(args, "input")) {
    display.input = redactCommandForApproval(stringValue(args.input));
  }
  return display;
}

/** The only MCP projection allowed in execution journals and retained previews. */
export function mcpActivityProjection(args: JsonObject): JsonObject {
  const action = stringValue(args.action);
  if (action !== "list" && action !== "call") throw new Error("mcp action must be list or call");
  const projected: JsonObject = {};
  if (typeof args.server === "string") projected.server = args.server;
  if (action === "call") {
    if (typeof args.server !== "string" || typeof args.tool !== "string") {
      throw new Error("mcp call requires server and tool");
    }
    projected.tool = args.tool;
  }
  validateMcpApprovalValue(projected);
  return { tool: "mcp", action, arguments: projected };
}

function validateMcpApprovalValue(
  value: unknown,
  depth: number = 0,
  budget: { nodes: number } = { nodes: 0 },
): void {
  budget.nodes += 1;
  if (depth > 16 || budget.nodes > 2_048) throw new Error("MCP approval arguments exceed structural limits");
  if (typeof value === "string") {
    if (hasForbiddenTerminalControls(value)) {
      throw new Error("MCP approval arguments contain forbidden control characters");
    }
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("MCP approval arguments contain a non-finite number");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw new Error("MCP approval array exceeds 100 items");
    for (const item of value) validateMcpApprovalValue(item, depth + 1, budget);
    return;
  }
  if (!value || typeof value !== "object") throw new Error("MCP approval arguments must contain only JSON values");
  const entries = Object.entries(value);
  if (entries.length > 100) throw new Error("MCP approval object exceeds 100 fields");
  for (const [key, item] of entries) {
    if (hasForbiddenTerminalControls(key)) {
      throw new Error("MCP approval arguments contain forbidden control characters");
    }
    validateMcpApprovalValue(item, depth + 1, budget);
  }
}

function redactCompleteJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactCompleteJson(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_COMMAND_NAME.test(key) || /^(?:pass|passin|passout|pwd)$/i.test(key)
        ? "[redacted]"
        : redactCompleteJson(item),
    ]));
  }
  if (typeof value === "string") return redactCommandForApproval(value);
  return value;
}

function omittedActionBodyKeys(toolName: string, action: string): string[] {
  if (toolName === "browser" && action === "type") return ["text"];
  if (toolName === "memory") return ["content"];
  if (toolName === "skill") return ["instructions", "content"];
  if (toolName === "schedule") return ["prompt"];
  if (toolName === "mail") return ["text_body", "html_body"];
  return [];
}

function approvalDisplayValidationError(displayArguments: JsonObject): string | undefined {
  const bytes = Buffer.byteLength(canonicalJson(displayArguments), "utf8");
  return bytes > APPROVAL_ARGUMENT_MAX_BYTES
    ? `Approval arguments exceed the complete display limit of ${APPROVAL_ARGUMENT_MAX_BYTES} UTF-8 bytes`
    : undefined;
}

function redactJson(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[omitted]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactJson(item, depth + 1));
  if (value && typeof value === "object") {
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value).slice(0, 50)) {
      result[key] = /token|password|passwd|secret|api[_-]?key|credential|cookie|authorization|auth/i.test(key)
        ? "[redacted]"
        : redactJson(item, depth + 1);
    }
    return result;
  }
  if (typeof value === "string") return redactCommandForApproval(value);
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonObject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function stripTerminalControls(value: string): string {
  return value
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(FORBIDDEN_TERMINAL_CONTROLS_GLOBAL, "");
}

function hasForbiddenTerminalControls(value: string): boolean {
  // Newlines and tabs are meaningful shell syntax/whitespace and remain
  // visible. Other C0/C1 controls and high-risk invisible/bidi formatting
  // characters can alter presentation or make it differ from Bash's bytes.
  return FORBIDDEN_TERMINAL_CONTROLS.test(value);
}

function boundedUtf8(value: string, maximumBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maximumBytes) return value;
  return `${buffer.subarray(0, maximumBytes).toString("utf8").replace(/\uFFFD$/u, "")}\n… [truncated]`;
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
