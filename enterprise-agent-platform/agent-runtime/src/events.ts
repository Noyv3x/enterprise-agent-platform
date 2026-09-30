import type { ServerResponse } from 'node:http';

const ACTIVITY_BYTES = 64 * 1024;

// Project only the transport preview: Pi retains the original tool result for the model.
function preview(value: unknown, budget: { left: number }, depth = 0): unknown {
  if (budget.left < 4 || depth > 32) return undefined;
  if (typeof value === 'string') {
    if (/^data:image\//i.test(value)) value = '[image omitted]';
    const text = value as string;
    let result = text.slice(0, budget.left);
    if (result.length < text.length) result += '…';
    if (Buffer.byteLength(JSON.stringify(result)) > budget.left) {
      let low = 0, high = Math.min(text.length, budget.left);
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(JSON.stringify(text.slice(0, middle) + '…')) <= budget.left) low = middle;
        else high = middle - 1;
      }
      result = text.slice(0, low) + '…';
      if (Buffer.byteLength(JSON.stringify(result)) > budget.left) return undefined;
    }
    budget.left -= Buffer.byteLength(JSON.stringify(result));
    return result;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > budget.left) return undefined;
    budget.left -= bytes;
    return value;
  }
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(value) && record.type === 'image') {
    // Image blocks must never carry payloads (including nested metadata) to SSE.
    return previewContainer({ type: 'image', mimeType: typeof record.mimeType === 'string' ? record.mimeType : 'application/octet-stream' }, budget, depth);
  }
  return previewContainer(value, budget, depth);
}

function previewContainer(value: object, budget: { left: number }, depth: number): unknown {
  budget.left -= 2;
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const entry of value) {
      if (budget.left < 5) break;
      if (result.length) budget.left--;
      const projected = preview(entry, budget, depth + 1);
      if (projected === undefined) break;
      result.push(projected);
    }
    return result;
  }
  const result: Record<string, unknown> = Object.create(null);
  const record = value as Record<string, unknown>;
  for (const key in record) {
    if (!Object.hasOwn(record, key) || /^(screenshot|base64|image_data|image_base64)$/i.test(key)) continue;
    const cost = Buffer.byteLength(JSON.stringify(key)) + 2;
    if (budget.left < cost + 4) break;
    budget.left -= cost;
    const projected = preview(record[key], budget, depth + 1);
    if (projected !== undefined) result[key] = projected;
  }
  return result;
}

function project(event: { type: string; [key: string]: unknown }): Record<string, unknown> {
  const fields = event.type === 'tool_start' ? ['args'] : event.type === 'tool_update' ? ['partial'] : event.type === 'tool_end' ? ['content_preview', 'details'] : [];
  const result = { ...event };
  const budget = { left: ACTIVITY_BYTES - 64 };
  for (const field of fields) if (field in result) result[field] = preview(result[field], budget);
  return result;
}

// Frames are shared with replay storage; each client has a bounded backlog and
// at most one small chunk in Node's writable buffer while waiting for drain.
class Client {
  private readonly queue = new Map<number, Buffer>();
  private next = 0;
  private bytes = 0;
  private offset = 0;
  private waiting = false;
  private ending = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly response: ServerResponse, private readonly remove: () => void) {
    response.once('close', this.cleanup);
    response.on('drain', this.drain);
  }

  private readonly cleanup = () => {
    this.stopped = true;
    clearTimeout(this.timer);
    this.queue.clear();
    this.bytes = 0;
    this.response.off('drain', this.drain);
    this.response.off('close', this.cleanup);
    this.remove();
  };

  private readonly drain = () => {
    clearTimeout(this.timer);
    this.waiting = false;
    this.pump();
  };

  enqueue(frame: Buffer): void {
    if (this.stopped) return;
    if (this.bytes + frame.length > 4 * 1024 * 1024) { this.destroy(); return; }
    this.queue.set(this.next++, frame);
    this.bytes += frame.length;
    this.pump();
  }

  private pump(): void {
    if (this.stopped || this.waiting) return;
    if (this.response.destroyed) { this.cleanup(); return; }
    while (this.queue.size) {
      const [key, frame] = this.queue.entries().next().value!;
      const end = Math.min(this.offset + 16 * 1024, frame.length);
      const chunk = frame.subarray(this.offset, end);
      this.offset = end;
      if (end === frame.length) {
        this.queue.delete(key);
        this.bytes -= frame.length;
        this.offset = 0;
      }
      if (!this.response.write(chunk)) {
        this.waiting = true;
        this.timer = setTimeout(() => this.destroy(), 10_000);
        this.timer.unref();
        return;
      }
    }
    if (this.ending) { this.cleanup(); this.response.end(); }
  }

  close(): void { this.ending = true; this.pump(); }
  destroy(): void { this.cleanup(); this.response.destroy(); }
}

export class RunEvents {
  private readonly retained = new Map<number, Buffer>();
  private readonly clients = new Map<ServerResponse, Client>();
  private bytes = 0;
  private seq = 0;
  private floor = 0;
  private closed = false;

  constructor(private readonly maxBytes = 4 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('Replay byte budget must be a nonnegative safe integer');
  }

  get retainedBytes(): number { return this.bytes; }
  get latestSeq(): number { return this.seq; }

  emit(event: { type: string; [key: string]: unknown }): void {
    if (this.closed) return;
    const seq = this.seq + 1;
    const wire = Buffer.from(`id: ${seq}\ndata: ${JSON.stringify({ ...project(event), seq })}\n\n`);
    this.seq = seq;
    const bytes = wire.length;
    if (bytes > this.maxBytes) {
      this.retained.clear();
      this.bytes = 0;
      this.floor = seq;
    } else {
      while (this.bytes + bytes > this.maxBytes) {
        const oldest = this.retained.entries().next().value!;
        this.retained.delete(oldest[0]);
        this.bytes -= oldest[1].length;
        this.floor = oldest[0];
      }
      this.retained.set(seq, wire);
      this.bytes += bytes;
    }
    for (const client of this.clients.values()) client.enqueue(wire);
  }

  subscribe(after: number, response: ServerResponse): void {
    if (after < this.floor) throw Object.assign(new Error(`Run event replay expired: cursor ${after} precedes retained history; reconnect after sequence ${this.floor} or reload run state`), { status: 410 });
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const client = new Client(response, () => { this.clients.delete(response); });
    this.clients.set(response, client);
    for (const [seq, frame] of this.retained) if (seq > after) client.enqueue(frame);
    if (this.closed) client.close();
  }


  close(): void {
    this.closed = true;
    for (const client of this.clients.values()) client.close();
  }

  dispose(): void {
    this.closed = true;
    for (const client of this.clients.values()) client.destroy();
    this.retained.clear();
    this.bytes = 0;
    this.floor = this.seq;
  }
}
