import type { JsonObject, RuntimeEvent } from "./types.js";
import { nowIso } from "./utils.js";

export type EventListener = (event: RuntimeEvent) => void;

export interface EventJournalOptions {
  maxEvents?: number;
  maxBytes?: number;
}

const DEFAULT_MAX_EVENTS = 2_048;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MIN_MAX_BYTES = 512;

export class EventJournal {
  readonly runId: string;
  private readonly events: RuntimeEvent[] = [];
  private readonly listeners = new Set<EventListener>();
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private retainedBytes = 0;
  private nextSequence = 1;
  private terminal = false;

  constructor(runId: string, options: EventJournalOptions = {}) {
    this.runId = runId;
    this.maxEvents = positiveInteger(options.maxEvents ?? DEFAULT_MAX_EVENTS, "maxEvents");
    this.maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_MAX_BYTES, "maxBytes");
    if (this.maxBytes < MIN_MAX_BYTES) throw new Error(`maxBytes must be at least ${MIN_MAX_BYTES}`);
  }

  publish(type: string, data: JsonObject = {}): RuntimeEvent {
    const event = boundedEvent({
      sequence: this.nextSequence++,
      type,
      run_id: this.runId,
      timestamp: nowIso(),
      data: cloneData(data),
    }, this.maxBytes);
    const bytes = serializedBytes(event);
    this.events.push(event);
    this.retainedBytes += bytes;
    while (this.events.length > this.maxEvents || this.retainedBytes > this.maxBytes) {
      const removed = this.events.shift();
      if (!removed) break;
      this.retainedBytes -= serializedBytes(removed);
    }
    if (type === "run.completed" || type === "run.failed" || type === "run.cancelled" || type === "run.needs_review") {
      this.terminal = true;
    }
    for (const listener of this.listeners) listener(event);
    if (this.terminal) this.listeners.clear();
    return event;
  }

  list(afterSequence = 0): RuntimeEvent[] {
    return this.events.filter((event) => event.sequence > afterSequence);
  }

  subscribe(afterSequence: number, listener: EventListener): () => void {
    for (const event of this.list(afterSequence)) listener(event);
    if (!this.terminal) this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get isTerminal(): boolean {
    return this.terminal;
  }
}

function boundedEvent(event: RuntimeEvent, maxBytes: number): RuntimeEvent {
  const originalBytes = serializedBytes(event);
  if (originalBytes <= maxBytes) return event;
  const bounded: RuntimeEvent = {
    ...event,
    data: {
      truncated: true,
      original_bytes: Number.isFinite(originalBytes) ? originalBytes : "unserializable",
    },
  };
  const preferredKeys = [
    "status",
    "session_id",
    "error",
    "output",
    "content",
    "delta",
    "approval_id",
    "tool_call_id",
    "tool_name",
    "model",
    "usage",
  ];
  for (const key of preferredKeys) {
    const value = event.data[key];
    if (value === undefined) continue;
    if (typeof value === "string") addBoundedString(bounded, key, value, maxBytes);
    else addIfFits(bounded, key, value, maxBytes);
  }
  return bounded;
}

function addIfFits(event: RuntimeEvent, key: string, value: unknown, maxBytes: number): void {
  const candidate = { ...event, data: { ...event.data, [key]: value } };
  if (serializedBytes(candidate) <= maxBytes) event.data[key] = value;
}

function addBoundedString(event: RuntimeEvent, key: string, value: string, maxBytes: number): void {
  const full = { ...event, data: { ...event.data, [key]: value } };
  if (serializedBytes(full) <= maxBytes) {
    event.data[key] = value;
    return;
  }
  let low = 0;
  let high = value.length;
  let selected: string | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const prefix = `${value.slice(0, middle)}…`;
    const candidate = { ...event, data: { ...event.data, [key]: prefix } };
    if (serializedBytes(candidate) <= maxBytes) {
      selected = prefix;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (selected !== undefined) event.data[key] = selected;
}

function cloneData(data: JsonObject): JsonObject {
  try {
    return JSON.parse(JSON.stringify(data)) as JsonObject;
  } catch {
    return { truncated: true, error: "Event payload was not JSON-serializable" };
  }
}

function serializedBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? Number.POSITIVE_INFINITY : Buffer.byteLength(serialized);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}
