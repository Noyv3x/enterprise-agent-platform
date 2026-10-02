import { useCallback, useEffect, useReducer, useRef } from "react";
import { request } from "../../api";
import { conversationBase } from "./routes";
import { partialArgs } from "./partialJson";
import type { Compaction, LiveRun, Message, MessagePage, ToolCall } from "./types";

const PAGE = 100;
/** The panel keeps at most this much live output per call; the Runtime already limits it to 512 KiB. */
const OUTPUT_CAP = 512 * 1024;
const EVENT_TYPES = [
  "message", "text_delta", "thinking_delta", "tool_input_start", "tool_input_delta", "tool_start", "tool_update", "tool_output", "tool_end",
  "retry", "compaction", "run_end",
] as const;

/** Platform SSE payloads (platform-api.md § SSE). */
type StreamEvent = { seq: number } & (
  | { type: "message"; message: Message }
  | { type: "text_delta" | "thinking_delta"; delta: string }
  | { type: "tool_input_start"; tool_call_id: string; name: string }
  | { type: "tool_input_delta"; tool_call_id: string; delta: string }
  | { type: "tool_start"; tool_call_id: string; name: string; args: Record<string, unknown> | null }
  | { type: "tool_update"; tool_call_id: string; partial: unknown }
  | { type: "tool_output"; tool_call_id: string; delta: string; truncated?: boolean }
  | { type: "tool_end"; tool_call_id: string; is_error: boolean; content_preview: unknown; details?: { diff?: unknown } | null }
  | { type: "retry" }
  | ({ type: "compaction"; phase: "queued" | "start" | "end" } & Partial<Compaction>)
  | { type: "run_end"; message?: Message | null }
);

interface State {
  phase: "loading" | "ready" | "error";
  error: string;
  messages: Message[];
  nextBefore: number | null;
  live: LiveRun | null;
  compaction: Compaction | null;
  compactionSeq: number;
  /** Watermark from the first page; the stream starts there. */
  after: number | null;
  /** Tool calls of the run that just ended, for the computer panel until the next run starts. */
  lastCalls: ToolCall[] | null;
}

type Action =
  | { type: "loaded"; page: MessagePage }
  | { type: "failed"; error: string }
  | { type: "older"; page: MessagePage }
  | { type: "upsert"; messages: Message[] }
  | { type: "compactQueued"; compaction: Compaction }
  | { type: "event"; event: StreamEvent; at: number };

const initial: State = { phase: "loading", error: "", messages: [], nextBefore: null, live: null, compaction: null, compactionSeq: 0, after: null, lastCalls: null };

function upsert(state: State, incoming: Message[]): Message[] {
  const oldest = state.messages[0]?.id;
  const byId = new Map(state.messages.map((message) => [message.id, message]));
  for (const message of incoming) {
    // Replayed events can announce messages older than the loaded page; those belong to "load earlier".
    if (state.nextBefore !== null && oldest !== undefined && message.id < oldest && !byId.has(message.id)) continue;
    byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** Tool partials and previews arrive as strings or Pi content blocks; the panel only shows their text. */
export function outputText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  const blocks = Array.isArray(value) ? value : typeof value === "object" && "content" in value && Array.isArray(value.content) ? value.content : null;
  if (blocks) {
    return blocks
      .map((block: unknown) => (block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : ""))
      .join("");
  }
  return JSON.stringify(value, null, 2);
}

function latestCompaction(current: Compaction | null, incoming: Compaction): Compaction {
  if (!current || incoming.job_id > current.job_id) return incoming;
  if (incoming.job_id < current.job_id) return current;
  // A delayed HTTP acknowledgement or replay must not undo a started or settled operation.
  if (current.status !== "queued" && (incoming.status === "queued" || current.status !== "compacting")) return current;
  return incoming;
}

function newCall(id: string, name: string): ToolCall {
  return { id, name, status: "preparing", args: {}, input: "", output: "", truncated: false, streamed: false, diff: "" };
}

/** Updates (or creates, when its first event was missed) one call; the other calls keep their identity for memoized views. */
function patchCall(calls: ToolCall[], id: string, patch: (call: ToolCall) => ToolCall): ToolCall[] {
  let index = -1;
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i].id === id) {
      index = i;
      break;
    }
  }
  if (index < 0) return [...calls, patch(newCall(id, ""))];
  const next = calls.slice();
  next[index] = patch(calls[index]);
  return next;
}

function applyCallEvent(call: ToolCall, event: StreamEvent): ToolCall {
  switch (event.type) {
    case "tool_input_start":
      return { ...call, name: event.name || call.name };
    case "tool_input_delta": {
      const input = call.input + event.delta;
      // Once tool_start delivered the authoritative arguments, late fragments change nothing visible.
      return call.status === "preparing" ? { ...call, input, args: partialArgs(input) } : { ...call, input };
    }
    case "tool_start":
      return { ...call, name: event.name, status: "running", args: event.args ?? call.args };
    case "tool_update":
      return call.streamed ? call : { ...call, output: outputText(event.partial) };
    case "tool_output": {
      if (call.truncated) return call;
      const room = OUTPUT_CAP - call.output.length;
      if (event.truncated || event.delta.length > room) {
        return { ...call, streamed: true, truncated: true, output: event.delta ? call.output + event.delta.slice(0, Math.max(0, room)) : call.output };
      }
      return { ...call, streamed: true, output: call.output + event.delta };
    }
    case "tool_end": {
      const diff = event.details?.diff;
      return {
        ...call, name: call.name, status: event.is_error ? "error" : "done", truncated: false,
        output: outputText(event.content_preview) || call.output, diff: typeof diff === "string" ? diff : call.diff,
      };
    }
    default:
      return call;
  }
}

function applyEvent(state: State, event: StreamEvent, at: number): State {
  if (event.type === "message") return { ...state, messages: upsert(state, [event.message]) };
  if (event.type === "run_end") {
    // Calls cut short by a stop or failure are not running any more.
    const calls = state.live?.calls.map((call) => (call.status === "preparing" || call.status === "running" ? { ...call, status: "cancelled" as const } : call));
    return { ...state, live: null, lastCalls: calls?.length ? calls : state.lastCalls, messages: event.message ? upsert(state, [event.message]) : state.messages };
  }
  if (event.type === "compaction" && event.job_id !== undefined && event.status !== undefined) {
    const compaction: Compaction = { job_id: event.job_id, status: event.status, reason: event.reason, error: event.error, after_message_id: event.after_message_id };
    return { ...state, compaction: latestCompaction(state.compaction, compaction), compactionSeq: Math.max(state.compactionSeq, event.seq) };
  }
  // Automatic Pi compaction is run activity, never the durable manual operation.
  if (event.type === "compaction" && event.phase === "end" && state.live === null) return state;
  const live: LiveRun = state.live ?? { items: [], calls: [], startedAt: at, notice: null };
  if (event.type === "tool_input_start" || event.type === "tool_input_delta" || event.type === "tool_output") {
    return { ...state, live: { ...live, calls: patchCall(live.calls, event.tool_call_id, (call) => applyCallEvent(call, event)) } };
  }
  const items = [...live.items];
  const last = items[items.length - 1];
  switch (event.type) {
    case "text_delta":
    case "thinking_delta": {
      const type = event.type === "text_delta" ? "text" : "thinking";
      // Consecutive deltas of one kind merge into one item, as in the persisted trace.
      if (last?.type === type) items[items.length - 1] = { type, text: last.text + event.delta };
      else items.push({ type, text: event.delta });
      return { ...state, live: { ...live, items, notice: null } };
    }
    case "tool_start":
      items.push({ type: "tool", id: event.tool_call_id, name: event.name, args: event.args ?? {}, output: "", status: "running", startedAt: at, endedAt: null });
      return { ...state, live: { ...live, items, calls: patchCall(live.calls, event.tool_call_id, (call) => applyCallEvent(call, event)), notice: null } };
    case "tool_update":
    case "tool_end":
      return {
        ...state,
        live: {
          ...live,
          calls: patchCall(live.calls, event.tool_call_id, (call) => applyCallEvent(call, event)),
          items: items.map((item) => {
            if (item.type !== "tool" || item.id !== event.tool_call_id) return item;
            return event.type === "tool_update"
              ? { ...item, output: outputText(event.partial) }
              : { ...item, output: outputText(event.content_preview) || item.output, status: event.is_error ? "error" : "done", endedAt: at };
          }),
        },
      };
    case "retry":
      return { ...state, live: { ...live, notice: "retry" } };
    case "compaction":
      return { ...state, live: { ...live, notice: event.phase === "start" ? "compaction" : null } };
  }
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "loaded":
      return {
        ...state, phase: "ready", error: "", messages: action.page.messages,
        nextBefore: action.page.next_before_id, after: action.page.last_seq, live: null, lastCalls: null,
        compaction: action.page.last_seq < state.compactionSeq ? state.compaction
          : action.page.compaction ? latestCompaction(state.compaction, action.page.compaction) : null,
      };
    case "failed":
      return { ...state, phase: "error", error: action.error };
    case "older":
      return { ...state, messages: [...action.page.messages, ...state.messages], nextBefore: action.page.next_before_id };
    case "upsert":
      return { ...state, messages: upsert(state, action.messages) };
    case "compactQueued":
      return { ...state, compaction: latestCompaction(state.compaction, action.compaction) };
    case "event":
      return applyEvent(state, action.event, action.at);
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** History, live SSE activity and actions for one conversation scope. Remount (key) the caller per scope. */
export function useConversation(scope: string, onRunEnd?: () => void) {
  const base = conversationBase(scope);
  const [state, dispatch] = useReducer(reducer, initial);
  const onRunEndRef = useRef(onRunEnd);
  onRunEndRef.current = onRunEnd;

  const load = useCallback(async () => {
    try {
      dispatch({ type: "loaded", page: await request<MessagePage>(`${base}/messages?limit=${PAGE}`) });
    } catch (error) {
      dispatch({ type: "failed", error: errorText(error) });
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const { after } = state;
  useEffect(() => {
    if (after === null) return;
    // On reconnect EventSource also sends Last-Event-ID, which the Platform prefers over `after`.
    const source = new EventSource(`${base}/events?after=${after}`);
    const handle = (raw: Event) => {
      if (!(raw instanceof MessageEvent) || typeof raw.data !== "string") return;
      let event: StreamEvent;
      try {
        event = JSON.parse(raw.data) as StreamEvent;
      } catch {
        return;
      }
      dispatch({ type: "event", event, at: Date.now() });
      if (event.type === "run_end") {
        // Queued inputs change status without their own events; refresh the latest page once per run.
        request<MessagePage>(`${base}/messages?limit=${PAGE}`)
          .then((page) => dispatch({ type: "upsert", messages: page.messages }))
          .catch(() => undefined);
        onRunEndRef.current?.();
      }
    };
    for (const type of EVENT_TYPES) source.addEventListener(type, handle);
    return () => source.close();
  }, [base, after]);

  const loadOlder = useCallback(async () => {
    if (state.nextBefore === null) return;
    dispatch({ type: "older", page: await request<MessagePage>(`${base}/messages?before=${state.nextBefore}&limit=${PAGE}`) });
  }, [base, state.nextBefore]);

  const send = useCallback(async (content: string, attachmentIds: number[]) => {
    const result = await request<{ message: Message; job_id: number }>(`${base}/messages`, {
      method: "POST",
      body: JSON.stringify({ content, attachment_ids: attachmentIds }),
    });
    dispatch({ type: "upsert", messages: [result.message] });
  }, [base]);

  const cancel = useCallback(() => request<{ ok: true }>(`${base}/cancel`, { method: "POST", body: "{}" }), [base]);
  const compact = useCallback(async () => {
    const result = await request<{ ok: true; job_id: number; status: "queued" }>(`${base}/compact`, { method: "POST", body: "{}" });
    dispatch({ type: "compactQueued", compaction: { job_id: result.job_id, status: result.status } });
  }, [base]);
  // Reset starts a fresh agent session; the history page and event watermark are reloaded afterwards.
  const reset = useCallback(async () => {
    await request<{ ok: true }>(`${base}/reset`, { method: "POST", body: "{}" });
    await load();
  }, [base, load]);

  const compactBusy = state.compaction?.status === "queued" || state.compaction?.status === "compacting";
  const busy = compactBusy || state.live !== null || state.messages.some((message) => message.metadata?.status === "queued" || message.metadata?.status === "running");
  return { ...state, busy, compactBusy, reload: load, loadOlder, send, cancel, compact, reset };
}
