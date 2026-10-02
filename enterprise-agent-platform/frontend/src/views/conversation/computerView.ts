import type { Message, ToolCall } from "./types";
import { messageWork } from "./work";

export type PanelView = "browser" | "terminal" | "editor";

/** Tools whose work is a file: the editor view. */
export const FILE_TOOLS = new Set(["write", "edit", "read"]);

/** The view that shows a tool's work. */
export function viewOf(name: string): PanelView {
  if (FILE_TOOLS.has(name)) return "editor";
  if (name === "browser") return "browser";
  return "terminal";
}

/** The view of the newest activity; the browser when there is none. */
export function followView(calls: readonly ToolCall[]): PanelView {
  const last = calls[calls.length - 1];
  return last ? viewOf(last.name) : "browser";
}

/** Calls of the latest reply's persisted work trace (bounded args and output previews), oldest first. */
export function persistedCalls(messages: readonly Message[]): ToolCall[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const work = messageWork(message);
    const calls: ToolCall[] = [];
    for (const item of work?.items ?? []) {
      if (item.type !== "tool") continue;
      calls.push({ id: item.id, name: item.name, status: item.status, args: item.args, input: "", output: item.output, truncated: false, streamed: false, diff: "" });
    }
    if (calls.length) return calls;
  }
  return [];
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function quote(value: string): string {
  return /^[\w./@:=+,-]+$/.test(value) ? value : JSON.stringify(value);
}

function clip(value: string, max = 160): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** The call as one terminal line: shell tools as the equivalent command, everything else as `› name summary`. */
export function commandLine(call: ToolCall): string {
  const { args } = call;
  const path = str(args.path);
  switch (call.name) {
    case "bash":
      return `$ ${str(args.command)}`;
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
  }
  const query = str(args.query);
  if (query) return `› ${call.name} ${JSON.stringify(clip(query))}`;
  const first = str(args.url) || str(args.path) || [str(args.server), str(args.tool)].filter(Boolean).join(" · ")
    || [str(args.action), str(args.name)].filter(Boolean).join(" ") || str(args._preview);
  if (first) return `› ${call.name} ${clip(first)}`;
  const json = Object.keys(args).length ? JSON.stringify(args) : "";
  return `› ${call.name || "…"}${json ? ` ${clip(json)}` : ""}`;
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
