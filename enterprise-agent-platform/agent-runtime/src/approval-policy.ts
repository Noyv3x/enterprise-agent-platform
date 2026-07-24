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

/**
 * Normalize command text only for conservative policy inspection. Never use
 * this representation for approval identity, display, or execution: Unicode
 * compatibility folding can change the exact object the user is approving.
 */
export function normalizeCommandForApproval(value: string): string {
  return stripTerminalControls(value)
    .normalize("NFKC")
    .replaceAll("\0", "")
    .replace(/\\\r?\n/g, "")
    .replaceAll("\r\n", "\n")
    .trim();
}

/** A display-only copy.  The returned value must never be executed. */
export function redactCommandForApproval(value: string): string {
  return boundedUtf8(redactCommand(value), APPROVAL_ARGUMENT_MAX_BYTES);
}

function redactCommand(value: string): string {
  const command = stripTerminalControls(value);
  if (containsNestedSensitiveCredential(command)) {
    return "[command omitted: nested shell evaluation contains a redacted credential]";
  }
  return redactCommandFlat(command);
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

function containsNestedSensitiveCredential(command: string, depth = 0): boolean {
  const nestedScripts: string[] = [];
  for (const words of shellCommands(command)) {
    for (let index = 0; index < words.length; index += 1) {
      const executable = basename(words[index] ?? "").toLowerCase();
      if (["sh", "bash", "zsh", "ksh", "dash"].includes(executable)) {
        const scriptOption = words.slice(index + 1).findIndex((argument) => /^-[a-z]*c[a-z]*$/i.test(argument));
        if (scriptOption >= 0) {
          const script = words[index + scriptOption + 2];
          if (script !== undefined) nestedScripts.push(script);
        }
      } else if (executable === "eval") {
        const script = words.slice(index + 1).join(" ");
        if (script) nestedScripts.push(script);
      }
    }
  }
  nestedScripts.push(...shellSubstitutions(command));
  // Reaching the inspection bound while another evaluator is still present
  // is not proof of safety. Reject instead of allowing arbitrary wrapper
  // depth to become a credential-redaction bypass.
  if (depth >= 4) return nestedScripts.length > 0;
  for (const script of nestedScripts) {
    const stripped = stripTerminalControls(script);
    if (redactCommandFlat(stripped) !== stripped) return true;
    if (containsNestedSensitiveCredential(stripped, depth + 1)) return true;
  }
  return false;
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

function shellEnvironmentAssignmentPattern(): RegExp {
  return /(^|[\s;|&])([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|[^\s;|&]+)/g;
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

interface ShellWordSpan {
  start: number;
  end: number;
  text: string;
}

interface SensitiveCliArgumentSpan {
  start: number;
  end: number;
  replacement: string;
}

function redactKnownClientCredentialArguments(command: string): string {
  let redacted = command;
  for (const span of sensitiveCliArgumentSpans(command).sort((left, right) => right.start - left.start)) {
    redacted = `${redacted.slice(0, span.start)}${span.replacement}${redacted.slice(span.end)}`;
  }
  return redacted;
}

function sensitiveCliArgumentSpans(command: string): SensitiveCliArgumentSpan[] {
  const sensitive: SensitiveCliArgumentSpan[] = [];
  const add = (span: SensitiveCliArgumentSpan): void => {
    if (span.end <= span.start) return;
    const overlapping = sensitive.findIndex((current) => span.start < current.end && span.end > current.start);
    if (overlapping < 0) {
      sensitive.push(span);
      return;
    }
    const current = sensitive[overlapping];
    if (current && span.end - span.start > current.end - current.start) sensitive[overlapping] = span;
  };

  for (const words of shellCredentialCommandSpans(command)) {
    // Sensitive named options are private even when they occur in a quoted
    // example or shell comment: these snapshots are persisted and displayed,
    // not executed. Scanning every word avoids turning comments into a secret
    // exfiltration side channel.
    for (let index = 0; index < words.length; index += 1) {
      const argument = words[index];
      if (!argument) continue;
      const equals = /^(-{1,2}[A-Za-z][A-Za-z0-9_-]{1,127})=([\s\S]*)$/.exec(argument.text);
      if (equals && isSensitiveCliOption(equals[1] ?? "")) {
        add({ start: argument.start, end: argument.end, replacement: `${equals[1]}=[redacted]` });
        continue;
      }
      if (/^-{1,2}[A-Za-z][A-Za-z0-9_-]{1,127}$/.test(argument.text)
        && isSensitiveCliOption(argument.text)) {
        const value = words[index + 1];
        if (value) {
          add({ start: value.start, end: value.end, replacement: "[redacted]" });
          index += 1;
        }
      }
    }

    for (let commandIndex = 0; commandIndex < words.length; commandIndex += 1) {
      const executable = basename(words[commandIndex]?.text ?? "").toLowerCase().replace(/\.exe$/, "");
      const args = words.slice(commandIndex + 1);
      if (executable === "curl") {
        addShortCredentialOptions(args, ["-u", "-U", "-b"], add);
        addNamedCredentialOptions(args, ["--user", "--proxy-user"], add);
      } else if (executable === "sshpass") {
        addShortCredentialOptions(args, ["-p"], add);
      } else if ([
        "mysql", "mysqladmin", "mysqldump", "mariadb", "mariadb-admin", "mariadb-dump",
        "mongo", "mongosh",
      ].includes(executable)) {
        addShortCredentialOptions(args, ["-p"], add);
      } else if (["redis-cli", "valkey-cli"].includes(executable)) {
        addShortCredentialOptions(args, ["-a"], add);
      } else if (["docker", "podman", "nerdctl"].includes(executable)
        && args.some((argument) => argument.text.toLowerCase() === "login")) {
        addShortCredentialOptions(args, ["-p"], add);
      } else if (executable === "smbclient") {
        addShortCredentialOptions(args, ["-U"], add);
      } else if (executable === "ldapsearch") {
        addShortCredentialOptions(args, ["-w"], add);
      } else if (["sqlcmd", "mosquitto_pub", "mosquitto_sub"].includes(executable)) {
        addShortCredentialOptions(args, ["-P"], add);
      }
    }

    for (const word of words) {
      if (!/\s/.test(word.text)) continue;
      if (redactCommandFlat(word.text) !== word.text) {
        add({ start: word.start, end: word.end, replacement: "[redacted]" });
      }
    }
  }
  return sensitive;
}

function isSensitiveCliOption(option: string): boolean {
  const name = option.replace(/^-+/, "");
  return SENSITIVE_COMMAND_NAME.test(name) || /^(?:pass|passin|passout|pwd)$/i.test(name);
}

function addNamedCredentialOptions(
  args: ShellWordSpan[],
  options: string[],
  add: (span: SensitiveCliArgumentSpan) => void,
): void {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    for (const option of options) {
      if (argument.text === option) {
        const value = args[index + 1];
        if (value) add({ start: value.start, end: value.end, replacement: "[redacted]" });
      } else if (argument.text.startsWith(`${option}=`)) {
        add({ start: argument.start, end: argument.end, replacement: `${option}=[redacted]` });
      }
    }
  }
}

function addShortCredentialOptions(
  args: ShellWordSpan[],
  options: string[],
  add: (span: SensitiveCliArgumentSpan) => void,
): void {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    for (const option of options) {
      if (argument.text === option) {
        const value = args[index + 1];
        if (value) add({ start: value.start, end: value.end, replacement: "[redacted]" });
      } else if (argument.text.startsWith(`${option}=`)) {
        add({ start: argument.start, end: argument.end, replacement: `${option}=[redacted]` });
      } else if (argument.text.startsWith(option) && argument.text.length > option.length) {
        add({ start: argument.start, end: argument.end, replacement: `${option}[redacted]` });
      }
    }
  }
}

function shellCredentialCommandSpans(command: string): ShellWordSpan[][] {
  const commands: ShellWordSpan[][] = [];
  let words: ShellWordSpan[] = [];
  let word = "";
  let wordStart: number | undefined;
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  const startWord = (index: number): void => {
    if (wordStart === undefined) wordStart = index;
  };
  const flushWord = (end: number): void => {
    if (wordStart !== undefined) words.push({ start: wordStart, end, text: word });
    word = "";
    wordStart = undefined;
  };
  const flushCommand = (end: number): void => {
    flushWord(end);
    if (words.length > 0) commands.push(words);
    words = [];
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";
    if (escaped) {
      word += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      startWord(index);
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else word += character;
      continue;
    }
    if (character === "'" || character === "\"") {
      startWord(index);
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (character === "\n") flushCommand(index);
      else flushWord(index);
      continue;
    }
    if (";&|".includes(character)) {
      flushCommand(index);
      continue;
    }
    startWord(index);
    word += character;
  }
  flushCommand(command.length);
  return commands;
}

function hasExecutableSyntaxInSensitiveRegion(command: string): boolean {
  const offsets = executableShellSyntaxOffsets(command);
  if (offsets.length === 0) return false;
  const overlaps = (match: RegExpMatchArray): boolean => {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    return offsets.some((offset) => offset >= start && offset < end);
  };

  for (const match of command.matchAll(curlHeaderArgumentPattern())) {
    if (parseSensitiveHeaderArgument(match[3] ?? "") && overlaps(match)) return true;
  }
  for (const span of sensitiveCliArgumentSpans(command)) {
    if (offsets.some((offset) => offset >= span.start && offset < span.end)) return true;
  }
  for (const pattern of [
    /(["'])((?:authorization|proxy-authorization|(?:x[-_])?(?:api[-_]?key|access[-_]?token|auth[-_]?token|secret)|(?:set-)?cookie)\s*:)[\s\S]*?\1/gi,
    /((?:^|\s)(?:authorization|proxy-authorization|(?:x[-_])?(?:api[-_]?key|access[-_]?token|auth[-_]?token|secret))\s*:\s*)[^\s'";|&]+/gi,
    /(authorization\s*:\s*(?:bearer|basic)\s+)[^\s'";|&]+/gi,
    /((?:set-)?cookie\s*:\s*)[^\s'";|&]+/gi,
    /([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi,
  ]) {
    for (const match of command.matchAll(pattern)) {
      if (overlaps(match)) return true;
    }
  }
  for (const match of command.matchAll(redactedAssignmentPattern())) {
    if (SENSITIVE_COMMAND_NAME.test(match[1] ?? "") && overlaps(match)) return true;
  }
  for (const match of command.matchAll(/([?&])([A-Za-z0-9_.-]{1,128})=([^&#\s'";|]+)/g)) {
    if (SENSITIVE_COMMAND_NAME.test(match[2] ?? "") && overlaps(match)) return true;
  }
  return false;
}

function executableShellSyntaxOffsets(command: string): number[] {
  const offsets: number[] = [];
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (
      character === "`"
      || (character === "$" && command[index + 1] === "(")
      || ((character === "<" || character === ">") && command[index + 1] === "(")
    ) {
      offsets.push(index);
    }
  }
  for (const match of command.matchAll(/\$\{[^}\r\n]{0,1024}@P\}/g)) {
    offsets.push(match.index ?? 0);
  }

  let quote: "'" | "\"" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote === "'") {
      if (character === "'") quote = undefined;
      continue;
    }
    if (character === "\\") {
      const next = command[index + 1];
      if (quote === undefined || next === "$" || next === "`" || next === "\"" || next === "\\" || next === "\n") {
        index += 1;
      }
      continue;
    }
    if (quote === "\"") {
      if (character === "\"") {
        quote = undefined;
      }
      continue;
    }
    if (character === "'") {
      quote = "'";
    } else if (character === "\"") {
      quote = "\"";
    } else if (character === "<" || character === ">") {
      offsets.push(index);
    }
  }
  return offsets;
}

interface SensitiveEnvironmentAssignment {
  name: string;
  value: string;
}

function sensitiveEnvironmentAssignments(command: string): SensitiveEnvironmentAssignment[] {
  const assignments: SensitiveEnvironmentAssignment[] = [];
  for (const match of command.matchAll(shellEnvironmentAssignmentPattern())) {
    const nameOffset = (match.index ?? 0) + (match[1]?.length ?? 0);
    if (!isUnquotedShellPosition(command, nameOffset)) continue;
    const name = match[2] ?? "";
    if (!SENSITIVE_COMMAND_NAME.test(name)) continue;
    assignments.push({ name, value: match[3] ?? "" });
  }
  return assignments;
}

function isUnquotedShellPosition(command: string, position: number): boolean {
  let quote: "'" | "\"" | undefined;
  for (let index = 0; index < position; index += 1) {
    const character = command[index];
    if (character === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (character === "'" && quote !== "\"") {
      quote = quote === "'" ? undefined : "'";
    } else if (character === "\"" && quote !== "'") {
      quote = quote === "\"" ? undefined : "\"";
    }
  }
  return quote === undefined;
}

function sensitiveEnvironmentAssignmentValidationError(command: string): string | undefined {
  const assignments = sensitiveEnvironmentAssignments(command);
  if (assignments.some((assignment) => !isCredentialSafeAssignmentValue(assignment.value))) {
    return "Sensitive environment assignment contains a value outside the credential-safe character set";
  }
  if (hasSensitiveRedaction(command) && hasHiddenValueReevaluation(command)) {
    return "A redacted sensitive value is combined with shell re-evaluation";
  }
  return undefined;
}

function isCredentialSafeAssignmentValue(value: string): boolean {
  const first = value[0];
  const candidate = (first === "'" || first === "\"") && value.endsWith(first)
    ? value.slice(1, -1)
    : value;
  return /^[A-Za-z0-9._~+/:@%=-]*$/.test(candidate);
}

function hasSensitiveRedaction(command: string): boolean {
  const displayBase = stripTerminalControls(command);
  return redactCommand(displayBase) !== displayBase;
}

function hasHiddenValueReevaluation(command: string): boolean {
  if (/\$\(|`|[<>]\(|\$\{[^}\r\n]{0,1024}@P\}/.test(command)) return true;
  if (/(?:^|[;&|\n])\s*(?:for\s*)?\(\(/.test(command)) return true;

  const simplifiedReferences = command.replace(
    /\$\{[^}\r\n]{1,256}\}/g,
    () => "$__REDACTED_PARAMETER__",
  );
  for (const words of shellCommands(simplifiedReferences)) {
    const executableIndex = unwrapCommand(words);
    if (executableIndex >= words.length) continue;
    const executableWord = words[executableIndex] ?? "";
    if (/^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?!-])$/.test(executableWord)) return true;

    const executable = basename(executableWord).toLowerCase();
    const args = words.slice(executableIndex + 1);
    if (executable === "eval" || executable === "source" || executable === "." || executable === "let") return true;
    if (["sh", "bash", "zsh", "ksh", "dash"].includes(executable)) {
      if (args.some((arg) => /^-[a-z]*c[a-z]*$/i.test(arg))) return true;
    }
    if (["declare", "typeset", "local"].includes(executable)) {
      if (args.some((arg) => /^-[a-z]*i[a-z]*$/i.test(arg))) return true;
    }
  }
  return false;
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
  const updateBehavior = background
    ? (args.update_behavior === "terminate" ? "terminate" : "wait")
    : "foreground";
  // Foreground execution always has an effective deadline. Background work
  // has no implicit deadline, but an explicitly requested auto-kill deadline
  // is execution-relevant and therefore belongs to the approval identity.
  const timeoutMs = background && args.timeout_ms === undefined
    ? undefined
    : effectiveTerminalTimeout(args.timeout_ms, defaultTimeoutMs);
  const identity: JsonObject = { command, cwd, background, update_behavior: updateBehavior };
  const displayArguments: JsonObject = {
    command: redactCommand(command),
    cwd,
    background,
    update_behavior: updateBehavior,
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
  const executionArguments = toolName === "process"
    ? Object.fromEntries(Object.entries(args).filter(([key]) => key !== "action"))
    : nested;
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
  if (["process", "memory", "skill", "browser", "schedule"].includes(toolName)) {
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
    return {
      prompt: "[delegated prompt omitted from durable and event records]",
      ...(Object.hasOwn(args, "system_prompt")
        ? { system_prompt: "[delegated system prompt omitted from durable and event records]" }
        : {}),
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
  if (containsNestedSensitiveCredential(command)) {
    return "Terminal command contains a credential inside nested shell evaluation";
  }
  if (hasExecutableSyntaxInSensitiveRegion(command)) {
    return "Terminal command contains executable shell syntax inside a redacted sensitive value";
  }
  const assignmentValidationError = sensitiveEnvironmentAssignmentValidationError(command);
  if (assignmentValidationError) return assignmentValidationError;
  if (Buffer.byteLength(redactCommand(command), "utf8") > APPROVAL_ARGUMENT_MAX_BYTES) {
    return `Redacted terminal command exceeds the complete approval display limit of ${APPROVAL_ARGUMENT_MAX_BYTES} UTF-8 bytes`;
  }
  return undefined;
}

export function processWriteHardBlock(input: string): string | undefined {
  if (Buffer.byteLength(input, "utf8") > APPROVAL_ARGUMENT_MAX_BYTES) {
    return `Process input exceeds the complete approval display limit of ${APPROVAL_ARGUMENT_MAX_BYTES} UTF-8 bytes`;
  }
  if (hasSensitiveRedaction(input)) {
    return "Process input cannot persist a redacted sensitive value in a long-lived shell";
  }
  if (Buffer.byteLength(redactCommand(input), "utf8") > APPROVAL_ARGUMENT_MAX_BYTES) {
    return `Redacted process input exceeds the complete approval display limit of ${APPROVAL_ARGUMENT_MAX_BYTES} UTF-8 bytes`;
  }
  return hardBlockedCommand(input);
}

function effectiveTerminalTimeout(value: unknown, defaultTimeoutMs: number): number {
  const timeoutMs = value === undefined ? defaultTimeoutMs : value;
  if (!Number.isSafeInteger(timeoutMs) || Number(timeoutMs) <= 0) {
    throw new Error("Foreground terminal timeout must be a positive integer");
  }
  return Number(timeoutMs);
}

export function hardBlockedCommand(command: string): string | undefined {
  const validationError = terminalCommandValidationError(command);
  if (validationError) return validationError;
  const normalized = normalizeCommandForApproval(command);
  const detection = normalized
    .replace(/\$\{IFS\b[^}]*\}|\$IFS\b/gi, " ")
    .replace(/\$\(\s*\)|``/g, "")
    .replace(/''|""/g, "");
  if (isForkBomb(detection)) return "Fork bombs are blocked";
  if (pipelineFeedsShell(detection)) return "Piping dynamically generated input into a shell is blocked";

  for (const script of shellSubstitutions(detection)) {
    const nested = hardBlockedCommand(script);
    if (nested) return nested;
  }

  const commandVariables = new Map<string, string>();
  for (const parsedWords of shellCommands(detection)) {
    if (rememberLiteralAssignments(parsedWords, commandVariables)) continue;
    const words = expandKnownCommandVariables(parsedWords, commandVariables);
    const redirectedTarget = outputRedirectionTargets(words).find((target) => isRawBlockDevice(target));
    if (redirectedTarget) return "Writing a raw block device is blocked";
    if (outputRedirectionTargets(words).some(isProtectedSystemTarget)) {
      return "Writing protected host system paths is blocked";
    }
    const executableIndex = unwrapCommand(words);
    if (executableIndex >= words.length) continue;
    let executable = basename(words[executableIndex] ?? "").toLowerCase();
    let args = words.slice(executableIndex + 1);
    if (executable === "busybox" && args.length > 0) {
      executable = basename(args[0] ?? "").toLowerCase();
      args = args.slice(1);
    }

    if (!isLiteralOutputCommand(executable) && args.some((arg) => isCloudMetadataTarget(arg))) {
      return "Cloud metadata access is blocked";
    }
    if (!isLiteralOutputCommand(executable) && args.some((arg) => isDockerSocketTarget(arg))) {
      return "Docker socket access is blocked";
    }
    if (!isLiteralOutputCommand(executable) && args.some((arg) => isManagerControlTarget(arg))) {
      return "Manager control and state access is blocked";
    }
    if (!isLiteralOutputCommand(executable) && args.some((arg) => isProtectedProcessTarget(arg))) {
      return "Reading process credentials and memory is blocked";
    }

    if (["shutdown", "reboot", "poweroff", "halt"].includes(executable)) {
      return "System power operations are blocked";
    }
    if ((executable === "init" || executable === "telinit") && args.some((arg) => arg === "0" || arg === "6")) {
      return "System power operations are blocked";
    }
    if (executable === "systemctl" && args.some((arg) => ["poweroff", "reboot", "halt", "kexec"].includes(arg.toLowerCase()))) {
      return "System power operations are blocked";
    }
    if (executable === "mkfs" || executable.startsWith("mkfs.")) {
      return "Filesystem formatting is blocked";
    }
    if (["fdisk", "parted"].includes(executable)) {
      return "Disk partitioning is blocked";
    }
    if (executable === "kill" && args.includes("-1")) {
      return "Killing every host process is blocked";
    }
    if (executable === "rm" && recursivelyDeletesProtectedRoot(args)) {
      return "Recursive deletion of a protected host root is blocked";
    }
    if (executable === "find" && findDeletesProtectedRoot(args)) {
      return "Recursive deletion of a protected host root is blocked";
    }
    if (executable === "find") {
      for (const script of findExecutedScripts(args)) {
        const nested = hardBlockedCommand(script);
        if (nested) return nested;
      }
      if (findExecDeletesProtectedRoot(args)) {
        return "Recursive deletion of a protected host root is blocked";
      }
    }
    if (executable === "wipefs" && args.some((arg) => isRawBlockDevice(stripAssignment(arg)))) {
      return "Erasing raw block-device signatures is blocked";
    }
    if (executable === "dd" && args.some((arg) => rawBlockAssignment(arg))) {
      return "Writing a raw block device is blocked";
    }
    if (writesProtectedSystemPath(executable, args)) {
      return "Writing protected host system paths is blocked";
    }
    if (["sh", "bash", "zsh", "ksh", "dash"].includes(executable)) {
      const scriptIndex = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/i.test(arg));
      const script = scriptIndex >= 0 ? args[scriptIndex + 1] : undefined;
      if (script) {
        const nested = hardBlockedCommand(script);
        if (nested) return nested;
      }
    }
    if (executable === "eval") {
      const nested = hardBlockedCommand(args.join(" "));
      if (nested) return nested;
    }
  }
  return undefined;
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
  const omittedBodyKeys = toolName === "browser" && action === "type"
    ? ["text"]
    : toolName === "memory"
      ? ["content"]
      : toolName === "skill"
        ? ["instructions", "content"]
        : toolName === "schedule"
          ? ["prompt"]
          : [];
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

function shellCommands(command: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  const flushWord = (): void => {
    if (word) words.push(word);
    word = "";
  };
  const flushCommand = (): void => {
    flushWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";
    if (escaped) {
      word += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else word += character;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === ">" || character === "<") {
      flushWord();
      const repeated = command[index + 1] === character;
      words.push(repeated ? `${character}${character}` : character);
      if (repeated) index += 1;
      continue;
    }
    if (character === "{" && command[index + 1] === "}") {
      flushWord();
      words.push("{}");
      index += 1;
      continue;
    }
    if (";&|(){}".includes(character) || character === "\n") {
      flushCommand();
      continue;
    }
    if (/\s/.test(character)) {
      flushWord();
      continue;
    }
    word += character;
  }
  flushCommand();
  return commands;
}

function shellSubstitutions(command: string): string[] {
  const scripts: string[] = [];
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && !singleQuoted) {
      escaped = true;
      continue;
    }
    if (character === "'" && !doubleQuoted) {
      singleQuoted = !singleQuoted;
      continue;
    }
    if (character === '"' && !singleQuoted) {
      doubleQuoted = !doubleQuoted;
      continue;
    }
    if (singleQuoted) continue;
    if (character === "`") {
      const end = command.indexOf("`", index + 1);
      if (end > index) {
        scripts.push(command.slice(index + 1, end));
        index = end;
      }
      continue;
    }
    const opensSubstitution = (character === "$" || character === "<" || character === ">")
      && command[index + 1] === "(";
    if (!opensSubstitution) continue;
    let depth = 1;
    let nestedSingle = false;
    let nestedDouble = false;
    let nestedEscaped = false;
    let end = index + 2;
    for (; end < command.length; end += 1) {
      const nestedCharacter = command[end] ?? "";
      if (nestedEscaped) {
        nestedEscaped = false;
        continue;
      }
      if (nestedCharacter === "\\" && !nestedSingle) {
        nestedEscaped = true;
        continue;
      }
      if (nestedCharacter === "'" && !nestedDouble) nestedSingle = !nestedSingle;
      else if (nestedCharacter === '"' && !nestedSingle) nestedDouble = !nestedDouble;
      else if (!nestedSingle && !nestedDouble && nestedCharacter === "(") depth += 1;
      else if (!nestedSingle && !nestedDouble && nestedCharacter === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth === 0) {
      scripts.push(command.slice(index + 2, end));
      index = end;
    }
  }
  return scripts;
}

function pipelineFeedsShell(command: string): boolean {
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character !== "|" || command[index + 1] === "|") {
      if (character === "|" && command[index + 1] === "|") index += 1;
      continue;
    }
    const right = command.slice(index + 1).replace(/^&/, "");
    const words = shellCommands(right)[0] ?? [];
    const executableIndex = unwrapCommand(words);
    if (executableIndex >= words.length) continue;
    let executable = basename(words[executableIndex] ?? "").toLowerCase();
    let args = words.slice(executableIndex + 1);
    if (executable === "busybox" && args.length > 0) {
      executable = basename(args[0] ?? "").toLowerCase();
      args = args.slice(1);
    }
    if (["sh", "bash", "zsh", "ksh", "dash"].includes(executable) && shellReadsStandardInput(args)) {
      return true;
    }
  }
  return false;
}

function shellReadsStandardInput(args: string[]): boolean {
  if (args.some((arg) => /^-[a-z]*c[a-z]*$/i.test(arg))) return false;
  let optionsEnded = false;
  for (const arg of args) {
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith("-")) continue;
    return false;
  }
  return true;
}

function rememberLiteralAssignments(words: string[], variables: Map<string, string>): boolean {
  if (words.length === 0) return false;
  const assignments: Array<[string, string]> = [];
  for (const word of words) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(word);
    if (!match) return false;
    assignments.push([match[1] ?? "", match[2] ?? ""]);
  }
  for (const [name, value] of assignments) variables.set(name, value);
  return true;
}

function expandKnownCommandVariables(words: string[], variables: Map<string, string>): string[] {
  const expanded: string[] = [];
  for (const word of words) {
    const match = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(word);
    const value = match ? variables.get(match[1] || match[2] || "") : undefined;
    if (value === undefined) {
      expanded.push(word);
      continue;
    }
    const replacement = shellCommands(value)[0];
    expanded.push(...(replacement && replacement.length > 0 ? replacement : [value]));
  }
  return expanded;
}

function unwrapCommand(words: string[]): number {
  let index = 0;
  while (index < words.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")) {
      index += 1;
      continue;
    }
    if (/^\d+$/.test(words[index] ?? "") && [">", ">>", "<", "<<"].includes(words[index + 1] ?? "")) {
      index += 3;
      continue;
    }
    if ([">", ">>", "<", "<<"].includes(words[index] ?? "")) {
      index += 2;
      continue;
    }
    const word = basename(words[index] ?? "").toLowerCase();
    if (word === "command") {
      index += 1;
      while (index < words.length) {
        const option = words[index] ?? "";
        if (option === "--") {
          index += 1;
          break;
        }
        if (option === "-p") {
          index += 1;
          continue;
        }
        // command -v/-V inspects a name; it does not execute that operand.
        if (option === "-v" || option === "-V") return words.length;
        break;
      }
      continue;
    }
    if (word === "exec") {
      index += 1;
      while (index < words.length) {
        const option = words[index] ?? "";
        if (option === "--") {
          index += 1;
          break;
        }
        if (option === "-a") {
          index += 2;
          continue;
        }
        if (option === "-c" || option === "-l") {
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    if (word === "nohup") {
      index += 1;
      if (words[index] === "--") index += 1;
      continue;
    }
    if (word === "time") {
      index += 1;
      while (index < words.length) {
        const option = words[index] ?? "";
        if (option === "--") {
          index += 1;
          break;
        }
        if (["-p", "--portability", "-a", "--append", "-v", "--verbose"].includes(option)) {
          index += 1;
          continue;
        }
        if (["-f", "--format", "-o", "--output"].includes(option)) {
          index += 2;
          continue;
        }
        break;
      }
      continue;
    }
    if (word === "nice") {
      index += 1;
      while (index < words.length) {
        const option = words[index] ?? "";
        if (option === "--") {
          index += 1;
          break;
        }
        if (option === "-n" || option === "--adjustment") {
          index += 2;
          continue;
        }
        if (/^(?:-\d+|--adjustment=-?\d+)$/.test(option)) {
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    if (word === "setsid") {
      index += 1;
      while (["-c", "-f", "-w", "--ctty", "--fork", "--wait"].includes(words[index] ?? "")) index += 1;
      if (words[index] === "--") index += 1;
      continue;
    }
    if (word === "builtin") {
      index += 1;
      if (words[index] === "--") index += 1;
      continue;
    }
    if (word === "sudo") {
      index += 1;
      while ((words[index] ?? "").startsWith("-")) {
        const option = words[index] ?? "";
        index += 1;
        if (["-u", "--user", "-g", "--group", "-h", "--host"].includes(option)) index += 1;
      }
      continue;
    }
    if (word === "env") {
      index += 1;
      while (index < words.length) {
        const option = words[index] ?? "";
        if (option === "--") {
          index += 1;
          break;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(option)) {
          index += 1;
          continue;
        }
        if (["-u", "--unset", "-C", "--chdir"].includes(option)) {
          index += 2;
          continue;
        }
        if (option.startsWith("--unset=") || option.startsWith("--chdir=") || option === "-i" || option === "--ignore-environment") {
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    break;
  }
  return index;
}

function recursivelyDeletesProtectedRoot(args: string[]): boolean {
  const recursive = args.some((arg) => arg === "--recursive" || /^-[^-]*[rR]/.test(arg));
  if (!recursive) return false;
  for (const arg of args) {
    if (arg.startsWith("-") || arg === "--") continue;
    if (protectedDeleteTarget(arg)) return true;
  }
  return false;
}

function findDeletesProtectedRoot(args: string[]): boolean {
  if (!args.includes("-delete")) return false;
  return findSearchRoots(args).some(protectedDeleteTarget);
}

function findExecutedScripts(args: string[]): string[] {
  const scripts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "-exec" && args[index] !== "-execdir") continue;
    const words: string[] = [];
    for (index += 1; index < args.length; index += 1) {
      const word = args[index] ?? "";
      if (word === ";" || word === "+") break;
      if (word !== "{}") words.push(word);
    }
    if (words.length > 0) scripts.push(words.join(" "));
  }
  return scripts;
}

function findExecDeletesProtectedRoot(args: string[]): boolean {
  if (!findSearchRoots(args).some(protectedDeleteTarget)) return false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "-exec" && args[index] !== "-execdir") continue;
    const command: string[] = [];
    for (index += 1; index < args.length; index += 1) {
      const word = args[index] ?? "";
      if (word === ";" || word === "+") break;
      command.push(word);
    }
    const executableIndex = unwrapCommand(command);
    const executable = basename(command[executableIndex] ?? "").toLowerCase();
    const commandArgs = command.slice(executableIndex + 1);
    if (executable === "rm"
        && commandArgs.includes("{}")
        && commandArgs.some((arg) => arg === "--recursive" || /^-[^-]*[rR]/.test(arg))) {
      return true;
    }
  }
  return false;
}

function findSearchRoots(args: string[]): string[] {
  const roots: string[] = [];
  let index = 0;
  while (index < args.length) {
    const option = args[index] ?? "";
    if (["-H", "-L", "-P"].includes(option) || /^-O\d+$/.test(option)) {
      index += 1;
      continue;
    }
    if (option === "-D") {
      index += 2;
      continue;
    }
    if (option === "--") {
      index += 1;
      break;
    }
    break;
  }
  for (; index < args.length; index += 1) {
    const value = args[index] ?? "";
    if (value.startsWith("-") || value === "!" || value === "(" || value === ")") break;
    roots.push(value);
  }
  return roots;
}

function protectedDeleteTarget(value: string): boolean {
  const home = process.env.HOME ? resolve(process.env.HOME) : "";
  const homeReference = /^(?:~|\$HOME|\$\{HOME(?::[-=?+][^}]*)?\})/i.exec(value)?.[0];
  if (homeReference && !value.slice(homeReference.length).replace(/^\/+/, "")) return true;
  const expanded = homeReference
    ? `${home}${value.slice(homeReference.length)}`
    : value;
  if (!expanded.startsWith("/")) return false;
  const wildcardIndex = expanded.search(/[?*\[]/);
  const stablePrefix = wildcardIndex < 0 ? expanded : expanded.slice(0, wildcardIndex);
  const normalized = resolve(stablePrefix === "/" ? "/" : stablePrefix.replace(/\/+$/, ""));
  if (normalized === "/" || (home && normalized === home)) return true;
  return ["/home", "/root", "/etc", "/usr", "/var", "/bin", "/sbin", "/boot", "/lib", "/lib64"]
    .includes(normalized);
}

function rawBlockAssignment(value: string): boolean {
  return /^of=/i.test(value) && isRawBlockDevice(stripAssignment(value));
}

function stripAssignment(value: string): string {
  const equals = value.indexOf("=");
  return equals >= 0 ? value.slice(equals + 1) : value;
}

function isRawBlockDevice(value: string): boolean {
  return /^\/dev\/(?:(?:sd|hd|vd|xvd)[a-z](?:\d+)?|nvme\d+n\d+(?:p\d+)?|mmcblk\d+(?:p\d+)?|md\d+|dm-\d+|mapper\/[^/]+)\/?$/i.test(value);
}

function outputRedirectionTargets(args: string[]): string[] {
  const targets: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (![">", ">>"].includes(args[index] ?? "")) continue;
    const target = args[index + 1];
    if (target) targets.push(target);
  }
  return targets;
}

function writesProtectedSystemPath(executable: string, args: string[]): boolean {
  const writers = new Set(["rm", "mv", "cp", "install", "chmod", "chown", "truncate", "tee", "dd", "ln"]);
  if (executable === "sed" && !args.some((arg) => /^-[^-]*i/.test(arg) || arg === "--in-place" || arg.startsWith("--in-place="))) {
    return false;
  }
  if (executable !== "sed" && !writers.has(executable)) return false;
  return args.some((arg) => !arg.startsWith("-") && isProtectedSystemTarget(stripAssignment(arg)));
}

function isProtectedSystemTarget(value: string): boolean {
  if (/^\/dev\/(?:null|stdin|stdout|stderr)\/?$/i.test(value)) return false;
  return /^\/(?:etc|boot|proc|sys|dev)(?:\/|$)/i.test(value);
}

function isCloudMetadataTarget(value: string): boolean {
  return /(?:169\.254\.169\.254|metadata\.google\.internal)/i.test(value);
}

function isDockerSocketTarget(value: string): boolean {
  return /(?:\/var\/run|\/run)\/docker\.sock(?:\/|$)/i.test(value);
}

function isManagerControlTarget(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return /^(?:\/var\/run|\/run)\/ubitech-agent(?:\/|$)/i.test(normalized)
    || /^\/var\/lib\/ubitech-agent\/manager(?:\/|$)/i.test(normalized)
    || /^\/(?:root|home\/[^/]+)\/\.local\/share\/ubitech-agent\/manager(?:\/|$)/i.test(normalized)
    || /^\/(?:root|home\/[^/]+)\/\.config\/ubitech-agent(?:\/|$)/i.test(normalized)
    || /^(?:~|\$HOME|\$\{HOME(?::[-=?+][^}]*)?\})\/\.local\/share\/ubitech-agent\/manager(?:\/|$)/i.test(normalized)
    || /^(?:~|\$HOME|\$\{HOME(?::[-=?+][^}]*)?\})\/\.config\/ubitech-agent(?:\/|$)/i.test(normalized);
}

function isProtectedProcessTarget(value: string): boolean {
  return /^\/proc\/(?:self|thread-self|\d+)\/(?:environ|cmdline|mem|fd)(?:\/|$)/i.test(value);
}

function isLiteralOutputCommand(executable: string): boolean {
  return executable === "echo" || executable === "printf";
}

function isForkBomb(value: string): boolean {
  return /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(value);
}

function basename(value: string): string {
  return value.replaceAll("\\", "/").split("/").at(-1) ?? value;
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
