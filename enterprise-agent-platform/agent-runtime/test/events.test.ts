import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { Writable } from 'node:stream';
import { RunEvents } from '../src/events.js';

class Response extends Writable {
  chunks: Buffer[] = [];
  headersSent = false;
  constructor(private readonly blocked = false) { super({ highWaterMark: blocked ? 1 : 1024 * 1024 }); }
  writeHead() { this.headersSent = true; return this; }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.chunks.push(chunk);
    if (!this.blocked) callback();
  }
  asHttp(): ServerResponse { return this as unknown as ServerResponse; }
}

function values(response: Response): Record<string, any>[] {
  return Buffer.concat(response.chunks).toString().split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.split('\ndata: ')[1]!));
}

test('byte eviction preserves absolute sequences and rejects stale cursors before headers', () => {
  const events = new RunEvents(180);
  for (let i = 0; i < 40; i++) {
    events.emit({ type: 'text_delta', delta: '界'.repeat(8) });
    assert(events.retainedBytes <= 180);
    assert.equal(events.latestSeq, i + 1);
  }
  const stale = new Response();
  assert.throws(() => events.subscribe(0, stale.asHttp()), { status: 410, message: /replay expired/ });
  assert.equal(stale.headersSent, false);
  const recent = new Response();
  events.subscribe(39, recent.asHttp());
  assert.deepEqual(values(recent).map(event => event.seq), [40]);
  assert.equal(events.retainedBytes, Buffer.byteLength(recent.chunks[0]!) * 2);
  events.emit({ type: 'run_end', text: 'done' });
  events.close();
  assert.deepEqual(values(recent).map(event => event.seq), [40, 41]);
  assert.equal(recent.writableEnded, true);
});

test('oversized final text reaches live clients intact but leaves an explicit replay gap', () => {
  const events = new RunEvents(100);
  const live = new Response();
  events.subscribe(0, live.asHttp());
  events.emit({ type: 'text_delta', delta: 'first' });
  const text = 'final answer '.repeat(10000);
  events.emit({ type: 'run_end', text });
  events.close();
  assert.equal(values(live)[1]!.text, text);
  assert.equal(events.latestSeq, 2);
  assert.equal(events.retainedBytes, 0);
  assert.equal(live.writableEnded, true);
  assert.throws(() => events.subscribe(1, new Response().asHttp()), { status: 410 });
  const caughtUp = new Response();
  events.subscribe(2, caughtUp.asHttp());
  assert.equal(caughtUp.writableEnded, true);
  events.emit({ type: 'ignored' });
  assert.equal(events.latestSeq, 2);
});

test('stalled live and replay clients time out without queuing more writable chunks', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = new RunEvents();
  const slow = new Response(true);
  const fast = new Response();
  events.subscribe(0, slow.asHttp());
  events.subscribe(0, fast.asHttp());
  events.emit({ type: 'text_delta', delta: 'first' });
  assert.equal(slow.destroyed, false);
  events.emit({ type: 'text_delta', delta: 'second' });
  assert.deepEqual(values(slow).map(event => event.delta), ['first']);
  assert.deepEqual(values(fast).map(event => event.delta), ['first', 'second']);
  const replay = new Response(true);
  events.subscribe(0, replay.asHttp());
  assert.equal(replay.destroyed, false);
  assert.deepEqual(values(replay).map(event => event.delta), ['first']);
  t.mock.timers.tick(10_000);
  assert.equal(slow.destroyed, true);
  assert.equal(replay.destroyed, true);
  events.close();
  events.dispose();
  assert.equal(fast.writableEnded, true);
  assert.equal(events.retainedBytes, 0);
});

test('accumulating slow clients are disconnected at the fixed backlog budget', () => {
  const events = new RunEvents();
  const slow = new Response(true);
  events.subscribe(0, slow.asHttp());
  events.emit({ type: 'text_delta', delta: 'first' });
  for (let i = 0; i < 5; i++) events.emit({ type: 'text_delta', delta: 'x'.repeat(1024 * 1024) });
  assert.equal(slow.destroyed, true);
  assert.deepEqual(values(slow).map(event => event.delta), ['first']);
  assert(events.retainedBytes <= 4 * 1024 * 1024);
  events.dispose();
});

test('activity projections remove image bytes and share a bounded UTF-8 preview budget without changing Pi results', () => {
  const events = new RunEvents();
  const live = new Response();
  events.subscribe(0, live.asHttp());
  const image = { type: 'image', mimeType: 'image/png', data: 'PRIVATE_IMAGE_BASE64', metadata: { original: 'PRIVATE_IMAGE_BASE64' } };
  const result = { content: [image, { type: 'text', text: '界\\\"'.repeat(100000) }], details: { screenshot: 'PRIVATE_IMAGE_BASE64', more: 'x'.repeat(100000) } };
  const before = structuredClone(result);
  events.emit({ type: 'tool_start', args: { images: [image], screenshot: image.data } });
  events.emit({ type: 'tool_update', partial: result });
  events.emit({ type: 'tool_end', content_preview: result.content, details: result.details });
  const projected = values(live);
  assert.deepEqual(projected[0]!.args.images, [{ type: 'image', mimeType: 'image/png' }]);
  assert.deepEqual(projected[1]!.partial.content[0], { type: 'image', mimeType: 'image/png' });
  assert.deepEqual(projected[2]!.content_preview[0], { type: 'image', mimeType: 'image/png' });
  for (const event of projected) {
    assert(!JSON.stringify(event).includes('PRIVATE_IMAGE_BASE64'));
    const { type, seq, ...activity } = event;
    assert(Buffer.byteLength(JSON.stringify(activity)) <= 64 * 1024);
  }
  assert.deepEqual(result, before);
  events.close();
});

test('deep external tool previews cannot abort the run or lose later terminal events', () => {
  const events = new RunEvents();
  const response = new Response();
  events.subscribe(0, response.asHttp());
  let details: unknown = 'deep leaf';
  for (let i = 0; i < 10000; i++) details = { nested: details };
  events.emit({ type: 'tool_end', details });
  events.emit({ type: 'run_end', text: 'answer after deep result' });
  events.close();
  const projected = values(response);
  let nested = projected[0]!.details;
  let depth = 0;
  while (nested.nested) { nested = nested.nested; depth++; }
  assert.equal(depth, 32);
  assert.deepEqual(nested, {});
  assert.equal(projected[1]!.text, 'answer after deep result');
  assert.equal(response.writableEnded, true);
});

test('HTTP replay returns recent terminal events and exposes stale history as HTTP 410', async t => {
  const events = new RunEvents(180);
  for (let i = 0; i < 10; i++) events.emit({ type: 'text_delta', delta: 'abcdefgh' });
  events.emit({ type: 'run_end', text: 'complete' });
  events.close();
  const server = createServer((request, response) => {
    try { events.subscribe(Number(new URL(request.url!, 'http://localhost').searchParams.get('after')), response); }
    catch (error) {
      assert(error instanceof Error && 'status' in error && typeof error.status === 'number');
      response.writeHead(error.status);
      response.end(error.message);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address();
  assert(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const recent = await fetch(`${base}/?after=10`);
  assert.equal(recent.status, 200);
  assert.match(recent.headers.get('content-type')!, /text\/event-stream/);
  assert.match(await recent.text(), /id: 11\ndata: .*"text":"complete"/);
  const stale = await fetch(`${base}/?after=0`);
  assert.equal(stale.status, 410);
  assert.match(await stale.text(), /replay expired/);
});

test('healthy HTTP clients receive large terminal frames live and through replay', async t => {
  const events = new RunEvents();
  const text = 'answer 界 '.repeat(50000);
  const server = createServer((request, response) => {
    events.subscribe(0, response);
    if (request.url === '/live') {
      events.emit({ type: 'run_end', text });
      events.close();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { events.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address();
  assert(address && typeof address === 'object');
  for (const path of ['/live', '/replay']) {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { signal: AbortSignal.timeout(5000) });
    const wire = await response.text();
    const event = JSON.parse(wire.split('\ndata: ')[1]!);
    assert.equal(event.text, text);
    assert.equal(event.seq, 1);
  }
});
