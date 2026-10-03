import { createContext } from "react";
import { partialArgs } from "./partialJson";
import type { LastRun, LiveRun, Message, RunRef, ToolCall } from "./types";
import { messageWork, toolVerb, type Words } from "./work";

/** How the computer window renders a step. */
export type StepKind = "shell" | "file" | "browser" | "search" | "fetch" | "other";

/** Tools whose work is a file. */
export const FILE_TOOLS = new Set(["write", "edit", "read"]);
/** Tools shown as commands in the terminal transcript. */
export const SHELL_TOOLS = new Set(["bash", "grep", "find", "ls"]);

export function stepKind(name: string): StepKind {
  if (SHELL_TOOLS.has(name)) return "shell";
  if (FILE_TOOLS.has(name)) return "file";
  if (name === "browser") return "browser";
  if (name === "web_search") return "search";
  if (name === "web_fetch") return "fetch";
  return "other";
}

/** Shown by the personal AI conversation only: opens the computer panel on one step of a run. */
export const ComputerContext = createContext<{ show: (run: RunRef, callId: string) => void } | null>(null);

const persisted = new WeakMap<Message, ToolCall[]>();

/** One reply's persisted work trace as calls (bounded args and output previews), oldest first; cached per message.
 * Oversized arguments survive only as a JSON prefix (`_preview`); its readable part is parsed back. */
export function messageCalls(message: Message): ToolCall[] {
  const cached = persisted.get(message);
  if (cached) return cached;
  const calls: ToolCall[] = [];
  for (const item of messageWork(message)?.items ?? []) {
    if (item.type !== "tool") continue;
    const preview = item.args._preview;
    const args = typeof preview === "string" ? { ...partialArgs(preview), _preview: preview } : item.args;
    calls.push({ id: item.id, name: item.name, status: item.status, args, input: "", output: item.output, truncated: false, streamed: false, diff: "" });
  }
  persisted.set(message, calls);
  return calls;
}

/** A run the window can show: its steps and whether it is the live run or the one that just ended. */
export interface RunSteps {
  run: RunRef;
  calls: readonly ToolCall[];
  /** the live run or the run that just ended: its newest browser step shows the live browser */
  current: boolean;
}

/** What following shows: the live run once it has a step, else the run that just ended, else the latest reply with
 * tool steps (after a reload). Null when there is no step at all. */
export function followedRun(live: LiveRun | null, lastRun: LastRun | null, messages: readonly Message[]): RunSteps | null {
  if (live?.calls.length) return { run: "live", calls: live.calls, current: true };
  if (lastRun) return { run: lastRun.messageId, calls: lastRun.calls, current: true };
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const calls = messageCalls(message);
    if (calls.length) return { run: message.id, calls, current: false };
  }
  return null;
}

/** The calls of one run: live, the run that just ended (full streams), or a persisted reply (bounded). */
export function runCalls(run: RunRef, live: LiveRun | null, lastRun: LastRun | null, messages: readonly Message[]): readonly ToolCall[] | null {
  if (run === "live") return live?.calls ?? null;
  if (lastRun?.messageId === run) return lastRun.calls;
  const message = messages.find((item) => item.id === run && item.role === "assistant");
  return message ? messageCalls(message) : null;
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function quote(value: string): string {
  return /^[\w./@:=+,-]+$/.test(value) ? value : JSON.stringify(value);
}

function clip(value: string, max = 80): string {
  const line = value.split("\n", 1)[0];
  return line.length > max || line.length < value.length ? `${line.slice(0, max)}…` : line;
}

export function fileName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

export function host(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** A shell step as one terminal line: bash as typed, grep/find/ls as the equivalent command. */
export function commandLine(call: ToolCall): string {
  const { args } = call;
  const path = str(args.path);
  switch (call.name) {
    case "grep": {
      const parts = ["$ grep -rn", quote(str(args.pattern))];
      if (str(args.glob)) parts.push(`--include=${quote(str(args.glob))}`);
      parts.push(quote(path || "."));
      return parts.join(" ");
    }
    case "find":
      return `$ find ${quote(path || ".")} -name ${quote(str(args.pattern))}`;
    case "ls":
      return `$ ls ${quote(path || ".")}`;
    default:
      return `$ ${str(args.command)}`;
  }
}

/** The step as one line under the window, with the conversation's tool verb: "Run pytest -q", "Write handlers.py". */
export function stepTitle(call: ToolCall, w: Words): string {
  const { args } = call;
  const verb = toolVerb(call.name, w);
  let subject = "";
  switch (stepKind(call.name)) {
    case "shell":
      subject = call.name === "bash" ? clip(str(args.command)) : clip(commandLine(call).slice(2));
      break;
    case "file":
      subject = fileName(str(args.path));
      break;
    case "search": {
      const query = clip(str(args.query));
      subject = query ? w(`"${query}"`, `“${query}”`, `「${query}」`) : "";
      break;
    }
    case "fetch":
      subject = host(str(args.url));
      break;
    case "browser":
      subject = str(args.url) ? host(str(args.url)) : str(args.action);
      break;
    default:
      subject = clip(str(args.action) || str(args.name) || [str(args.server), str(args.tool)].filter(Boolean).join(" · "));
  }
  const running = call.status === "preparing" || call.status === "running";
  // Chinese reads the running step as "正在…"; English keeps the verb and the status pill says it is working.
  const phrase = running ? w(verb, `正在${verb}`, `正在${verb}`) : verb;
  return subject ? `${phrase} ${subject}` : phrase;
}

/** Number of lines in `text` (an empty string has none). */
export function lineCount(text: string): number {
  if (!text) return 0;
  let count = 1;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) count++;
  return count;
}

/** The last `max` lines of `text` without splitting the whole text; `first` is the 1-based number of the first kept line. */
export function tailLines(text: string, max: number): { lines: string[]; cut: boolean; first: number } {
  // Walk back over `max` line breaks; the last one found bounds the kept lines.
  let at = text.length;
  for (let n = 0; n < max && at >= 0; n++) at = at > 0 ? text.lastIndexOf("\n", at - 1) : -1;
  const start = at + 1;
  const cut = start > 0;
  const kept = text.slice(start);
  return { lines: kept ? kept.split("\n") : [], cut, first: cut ? lineCount(text.slice(0, start)) : 1 };
}

/** The first `max` lines of `text`, for reader-style views where the beginning matters. */
export function headLines(text: string, max: number): { text: string; cut: boolean } {
  let at = -1;
  for (let n = 0; n < max; n++) {
    at = text.indexOf("\n", at + 1);
    if (at === -1) return { text, cut: false };
  }
  return { text: text.slice(0, at), cut: true };
}
