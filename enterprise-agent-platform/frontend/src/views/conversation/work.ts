import type { Message } from "./types";

/** One entry of an assistant turn's work, in arrival order (platform-api.md § Assistant message work trace). */
export type WorkItem =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  /** a plain status line from old `agent_work` records */
  | { type: "step"; label: string; detail: string }
  | {
      type: "tool";
      id: string;
      name: string;
      args: Record<string, unknown>;
      status: "running" | "done" | "error" | "cancelled";
      output: string;
      startedAt: number | null;
      endedAt: number | null;
    };

export interface WorkTrace {
  items: WorkItem[];
  /** epoch ms; null when the record carries no times */
  startedAt: number | null;
  endedAt: number | null;
  truncated: boolean;
  /** old records count events the previous system dropped */
  omitted: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isoTime(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/** Old records store epoch seconds as strings or numbers. */
function epochTime(value: unknown): number | null {
  const seconds = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

function fromWork(work: Record<string, unknown>): WorkTrace | null {
  if (work.v !== 1 || !Array.isArray(work.items)) return null;
  const items: WorkItem[] = [];
  for (const raw of work.items) {
    const item = record(raw);
    if (!item) continue;
    if (item.type === "thinking" || item.type === "text") items.push({ type: item.type, text: text(item.text) });
    else if (item.type === "tool") {
      const status = item.status === "done" || item.status === "error" ? item.status : "cancelled";
      items.push({
        type: "tool", id: text(item.id), name: text(item.name), args: record(item.args) ?? {}, status,
        output: text(item.output), startedAt: isoTime(item.started_at), endedAt: isoTime(item.ended_at),
      });
    }
  }
  return { items, startedAt: isoTime(work.started_at), endedAt: isoTime(work.ended_at), truncated: work.truncated === true, omitted: 0 };
}

const OLD_TOOL_STATUS: Record<string, "done" | "error"> = { completed: "done", failed: "error" };

/** Maps `metadata.agent_work.activity[]` from the previous system (read-only; removed actions never return). */
function fromActivity(activity: unknown[]): WorkTrace {
  const items: WorkItem[] = [];
  const times: number[] = [];
  let omitted = 0;
  let truncated = false;
  for (const raw of activity) {
    const entry = record(raw);
    if (!entry) continue;
    const detail = text(entry.detail);
    const at = epochTime(entry.at);
    if (at !== null) times.push(at);
    if (entry.stage === "work.truncated") {
      truncated = true;
      if (typeof entry.omitted_events === "number") omitted += entry.omitted_events;
    } else if (entry.stage === "tool") {
      const parameters = record(entry.parameters);
      const ended = epochTime(entry.completed_at);
      if (ended !== null) times.push(ended);
      items.push({
        type: "tool", id: `old-${items.length}`, name: text(entry.tool) || text(entry.label),
        args: parameters ?? (detail ? { detail } : {}), status: OLD_TOOL_STATUS[text(entry.tool_status)] ?? "cancelled",
        output: text(entry.result), startedAt: at, endedAt: ended,
      });
    } else if (entry.stage === "assistant.message") {
      const body = detail || text(entry.line);
      if (body) items.push({ type: "text", text: body });
    } else {
      const label = text(entry.label);
      if (label || detail) items.push({ type: "step", label, detail });
    }
  }
  return {
    items, truncated, omitted,
    startedAt: times.length ? Math.min(...times) : null,
    endedAt: times.length > 1 ? Math.max(...times) : null,
  };
}

/** The persisted trace of an assistant message: `metadata.work` v1, else the old `agent_work` record. */
export function messageWork(message: Message): WorkTrace | null {
  const work = record(message.metadata.work);
  if (work) {
    const trace = fromWork(work);
    if (trace && trace.items.length) return trace;
  }
  const old = record(message.metadata.agent_work);
  if (old && Array.isArray(old.activity)) {
    const trace = fromActivity(old.activity);
    if (trace.items.length || trace.truncated) return trace;
  }
  return null;
}

/** Splits a live run: text after the last tool is the streaming answer; everything before is work. */
export function splitLive(items: WorkItem[]): { work: WorkItem[]; answer: string } {
  let lastTool = -1;
  items.forEach((item, index) => {
    if (item.type === "tool") lastTool = index;
  });
  const work: WorkItem[] = [];
  let answer = "";
  items.forEach((item, index) => {
    if (item.type === "text" && index > lastTool) answer += item.text;
    else work.push(item);
  });
  return { work, answer };
}
