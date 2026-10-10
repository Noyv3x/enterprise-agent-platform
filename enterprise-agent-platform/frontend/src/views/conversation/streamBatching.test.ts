// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessagePage } from './types';
import { useConversation } from './useConversation';

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../api', () => api);

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  constructor(public url: string) {
    super();
    FakeEventSource.instances.push(this);
  }
  close() {}
  emit(seq: number, event: Record<string, unknown> & { type: string }) {
    act(() => {
      this.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify({ seq, ...event }) }));
    });
  }
}

const page: MessagePage = { messages: [], next_before_id: null, last_seq: 0, compaction: null };
let frames: FrameRequestCallback[] = [];

function nextFrame() {
  act(() => {
    const due = frames;
    frames = [];
    for (const callback of due) callback(performance.now());
  });
}

describe('live stream commits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    frames = [];
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => frames.push(callback));
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    api.request.mockResolvedValue(page);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function connect() {
    let renders = 0;
    const hook = renderHook(() => {
      renders += 1;
      return useConversation('channel-3');
    });
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    return { hook, stream: FakeEventSource.instances[0], renders: () => renders };
  }

  it('commits a burst of text deltas once, at the next animation frame', async () => {
    const { hook, stream, renders } = await connect();
    const before = renders();
    for (const [index, delta] of ['The ', 'report ', 'is ', 'ready.'].entries()) stream.emit(index + 1, { type: 'text_delta', delta });
    expect(renders()).toBe(before);
    expect(hook.result.current.live).toBeNull();
    expect(frames).toHaveLength(1);
    nextFrame();
    expect(renders()).toBe(before + 1);
    expect(hook.result.current.live?.items).toEqual([{ type: 'text', text: 'The report is ready.' }]);
  });

  it('commits waiting deltas before any other event, in arrival order', async () => {
    const { hook, stream, renders } = await connect();
    const before = renders();
    stream.emit(1, { type: 'thinking_delta', delta: 'Check the ' });
    stream.emit(2, { type: 'thinking_delta', delta: 'manifest.' });
    stream.emit(3, { type: 'tool_start', tool_call_id: 'read-1', name: 'read', args: { path: '/workspace/a.txt' } });
    expect(renders()).toBe(before + 1);
    expect(hook.result.current.live?.items.map((item) => item.type)).toEqual(['thinking', 'tool']);
    expect(hook.result.current.live?.items[0]).toMatchObject({ text: 'Check the manifest.' });
    stream.emit(4, { type: 'text_delta', delta: 'Done.' });
    stream.emit(5, { type: 'run_end', message: { id: 9, role: 'assistant', content: 'Done.', metadata: { status: 'completed' }, created_at: '2026-10-10T08:00:00Z', attachments: [] } });
    expect(hook.result.current.live).toBeNull();
    expect(hook.result.current.lastRun?.messageId).toBe(9);
    expect(hook.result.current.messages.map((message) => message.id)).toEqual([9]);
    // The frame scheduled for the delta finds nothing left to commit (once run_end's page refresh has landed).
    await act(async () => undefined);
    const settled = renders();
    nextFrame();
    expect(renders()).toBe(settled);
  });
});
