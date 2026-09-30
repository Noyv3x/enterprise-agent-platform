// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldworkProvider } from '../components/ui/fieldwork';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../i18n';
import { Conversation } from './Conversation';
import type { Message } from './conversation/types';

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../api', () => api);

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  closed = false;
  constructor(public url: string) {
    super();
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(seq: number, event: Record<string, unknown> & { type: string }) {
    act(() => {
      this.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify({ seq, ...event }), lastEventId: String(seq) }));
    });
  }
}

type Route = (body: Record<string, unknown>) => unknown;

function serve(routes: Record<string, Route>) {
  api.request.mockImplementation(async (path: string, options: RequestInit = {}) => {
    const route = routes[`${options.method ?? 'GET'} ${path}`];
    if (!route) throw new Error(`unexpected ${options.method ?? 'GET'} ${path}`);
    return route(options.body && typeof options.body === 'string' ? JSON.parse(options.body) : {});
  });
}

function calls(method: string, path: string): unknown[] {
  return api.request.mock.calls
    .filter(([calledPath, options]) => calledPath === path && (options?.method ?? 'GET') === method)
    .map(([, options]) => (options?.body ? JSON.parse(String(options.body)) : undefined));
}

function message(id: number, role: Message['role'], content: string, status: Message['metadata']['status'] = 'completed'): Message {
  return { id, role, content, metadata: { status }, created_at: '2026-09-30T09:00:00Z', attachments: [] };
}

function renderConversation(scope: string) {
  return render(<I18nProvider><FieldworkProvider mode="light" motion={false}><Conversation scope={scope} /></FieldworkProvider></I18nProvider>);
}

describe('Conversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('retains legacy tool results and commentary without restoring review controls', async () => {
    const user = userEvent.setup();
    const oldReply = { ...message(1, 'assistant', 'Done'), metadata: { agent_work: {
      state: 'needs_review',
      activity: [
        { stage: 'assistant.message', source: 'agent', detail: 'Checking the **release**.' },
        { stage: 'tool', source: 'agent', tool: 'terminal', tool_status: 'completed', detail: 'printf release', parameters: { command: 'printf release', cwd: '/workspace' }, result: 'release ready' },
        { stage: 'tool', source: 'agent', tool: 'web', tool_status: 'failed', detail: 'Release notes', result: '<script>bad()</script>' },
        { stage: 'approval', label: 'Approve deployment' },
        { stage: 'work.truncated', omitted_events: 4 },
      ],
    } } };
    serve({ 'GET /api/conversations/private/messages?limit=100': () => ({ messages: [oldReply], next_before_id: null, last_seq: 0 }) });
    renderConversation('private');
    expect(await screen.findByText('Done')).toBeVisible();
    expect(screen.getByText('release', { selector: 'strong' })).toBeVisible();
    expect(screen.getByText('Completed')).toBeVisible();
    expect(screen.getByText('Failed')).toBeVisible();
    await user.click(screen.getByText('terminal'));
    expect(screen.getByText(/release ready/)).toBeVisible();
    expect(screen.getByText(/release ready/)).toHaveTextContent('"cwd": "/workspace"');
    await user.click(screen.getByText('web'));
    expect(screen.getByText('<script>bad()</script>')).toBeVisible();
    expect(screen.getByText('Earlier activity was omitted (4)')).toBeVisible();
    expect(screen.queryByText('Approve deployment')).not.toBeInTheDocument();
    expect(screen.queryByText(/needs.review/i)).not.toBeInTheDocument();
  });

  it('sends an uploaded attachment without requiring message text', async () => {
    const user = userEvent.setup();
    const attachment = { id: 17, filename: 'notes.txt', mime_type: 'text/plain', size_bytes: 5, url: '/api/attachments/17', preview_url: null };
    serve({
      'GET /api/conversations/private/messages?limit=100': () => ({ messages: [], next_before_id: null, last_seq: 0 }),
      'POST /api/attachments?scope=private': () => ({ attachment }),
      'POST /api/conversations/private/messages': () => ({ message: { ...message(1, 'user', '', 'queued'), attachments: [attachment] }, job_id: 9 }),
    });
    renderConversation('private');
    const send = await screen.findByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    await user.upload(screen.getByTestId('composer-file'), new File(['notes'], 'notes.txt', { type: 'text/plain' }));
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);
    expect(calls('POST', '/api/conversations/private/messages')).toEqual([{ content: '', attachment_ids: [17] }]);
    expect(await screen.findByRole('link', { name: /Download/ })).toHaveAttribute('href', '/api/attachments/17');
    expect(screen.queryByRole('button', { name: 'Remove notes.txt' })).not.toBeInTheDocument();
  });

  it('sends a message, streams tool activity and text, then replaces the stream with the final reply', async () => {
    const user = userEvent.setup();
    const history = [message(1, 'assistant', 'Earlier **answer**')];
    serve({
      'GET /api/conversations/private/messages?limit=100': () => ({ messages: history, next_before_id: null, last_seq: 41 }),
      'POST /api/conversations/private/messages': (body) => ({ message: message(2, 'user', String(body.content), 'queued'), job_id: 9 }),
    });
    renderConversation('private');

    expect(await screen.findByText('answer')).toBeVisible();
    const stream = FakeEventSource.instances[0];
    expect(stream.url).toBe('/api/conversations/private/events?after=41');

    await user.type(screen.getByLabelText('Message'), 'List the files{Enter}');
    expect(calls('POST', '/api/conversations/private/messages')).toEqual([{ content: 'List the files', attachment_ids: [] }]);
    expect(await screen.findByText('List the files')).toBeVisible();
    expect(screen.getByText('Queued')).toBeVisible();
    expect(screen.getByLabelText('Message')).toHaveValue('');

    stream.emit(42, { type: 'tool_start', tool_call_id: 'call-1', name: 'bash', args: { command: 'ls -la' } });
    const live = screen.getByRole('article', { name: 'Reply in progress' });
    expect(within(live).getByText('Ran command')).toBeVisible();
    expect(within(live).getByText('ls -la')).toBeVisible();
    expect(within(live).getByText('Running')).toBeVisible();

    stream.emit(43, { type: 'tool_end', tool_call_id: 'call-1', name: 'bash', is_error: false, content_preview: 'notes.md\nreport.pdf', details: {} });
    expect(within(live).queryByText('Running')).not.toBeInTheDocument();
    expect(within(live).getByText(/report\.pdf/)).toBeInTheDocument();

    stream.emit(44, { type: 'text_delta', delta: 'Found two ' });
    stream.emit(45, { type: 'text_delta', delta: 'files.' });
    expect(within(live).getByText('Found two files.')).toBeVisible();

    history.splice(0, history.length, message(1, 'assistant', 'Earlier **answer**'), message(2, 'user', 'List the files'), message(3, 'assistant', 'Found two files: notes.md and report.pdf.'));
    stream.emit(46, { type: 'run_end', status: 'completed', text: 'Found two files: notes.md and report.pdf.', usage: {}, model: 'gpt', message: history[2] });

    expect(screen.queryByRole('article', { name: 'Reply in progress' })).not.toBeInTheDocument();
    expect(screen.getByText('Found two files: notes.md and report.pdf.')).toBeVisible();
    // The refreshed page settles the queued input.
    await waitFor(() => expect(screen.queryByText('Queued')).not.toBeInTheDocument());
  });

  it('shows interrupted replies as visible terminal state without resubmitting', async () => {
    const failed: Message = { ...message(5, 'assistant', 'Partial', 'interrupted'), metadata: { status: 'interrupted', error: 'Runtime restarted' } };
    serve({ 'GET /api/conversations/channel-3/messages?limit=100': () => ({ messages: [message(4, 'user', 'Hi'), failed], next_before_id: null, last_seq: 7 }) });
    renderConversation('channel-3');

    expect(await screen.findByText('Interrupted — send again to retry')).toBeVisible();
    expect(screen.getByText('Runtime restarted')).toBeVisible();
    expect(calls('POST', '/api/conversations/channel-3/messages')).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Computer' })).not.toBeInTheDocument();
  });

  it('queues compaction during an active run and keeps it busy across later message enqueues', async () => {
    const user = userEvent.setup();
    const history = [message(1, 'user', 'Earlier work', 'running')];
    serve({
      'GET /api/conversations/private/messages?limit=100': () => ({ messages: history, next_before_id: null, last_seq: 0, compaction: null }),
      'POST /api/conversations/private/compact': () => ({ ok: true, job_id: 20, status: 'queued' }),
      'POST /api/conversations/private/messages': () => ({ message: message(3, 'user', 'Later work', 'queued'), job_id: 21 }),
    });
    renderConversation('private');
    await screen.findByText('Earlier work');
    const compact = screen.getByRole('button', { name: 'Compact context' });
    expect(compact).toBeEnabled();
    await user.click(compact);
    const status = screen.getByRole('status', { name: 'Context compaction' });
    expect(within(status).getByText('Queued')).toBeVisible();
    expect(compact).toBeDisabled();
    await user.type(screen.getByLabelText('Message'), 'Later work{Enter}');
    expect(await screen.findByText('Later work')).toBeVisible();
    FakeEventSource.instances[0].emit(1, { type: 'message', message: message(3, 'user', 'Later work', 'queued') });
    expect(within(status).getByText('Queued')).toBeVisible();
    expect(compact).toBeDisabled();
    expect(calls('POST', '/api/conversations/private/compact')).toEqual([{}]);
    expect(calls('POST', '/api/conversations/private/messages')).toEqual([{ content: 'Later work', attachment_ids: [] }]);
  });

  it('keeps manual compaction state when an older run-end history refresh arrives', async () => {
    const user = userEvent.setup();
    let refresh!: (value: unknown) => void;
    let reads = 0;
    serve({
      'GET /api/conversations/private/messages?limit=100': () => ++reads === 1
        ? { messages: [], next_before_id: null, last_seq: 0, compaction: null }
        : new Promise((resolve) => { refresh = resolve; }),
      'POST /api/conversations/private/compact': () => ({ ok: true, job_id: 20, status: 'queued' }),
      'POST /api/conversations/private/cancel': () => ({ ok: true }),
    });
    renderConversation('private');
    await screen.findByRole('button', { name: 'Send' });
    const stream = FakeEventSource.instances[0];
    stream.emit(1, { type: 'run_end' });
    await user.click(screen.getByRole('button', { name: 'Compact context' }));
    stream.emit(2, { type: 'compaction', phase: 'start', job_id: 20, status: 'compacting' });
    await act(async () => refresh({ messages: [], next_before_id: null, last_seq: 1, compaction: null }));
    expect(within(screen.getByRole('status', { name: 'Context compaction' })).getByText('Compacting')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Compact context' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(calls('POST', '/api/conversations/private/cancel')).toEqual([{}]);
    stream.emit(3, { type: 'compaction', phase: 'end', job_id: 20, status: 'cancelled' });
    expect(within(screen.getByRole('status', { name: 'Context compaction' })).getByText('Cancelled')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
  });

  it.each([
    ['done', undefined, 'Done'],
    ['nothing_to_compact', 'too_small', 'Nothing to compact'],
    ['interrupted', undefined, 'Interrupted'],
    ['cancelled', undefined, 'Cancelled'],
  ] as const)('settles manual compaction as %s independently of automatic compaction', async (status, reason, label) => {
    const user = userEvent.setup();
    serve({
      'GET /api/conversations/private/messages?limit=100': () => ({ messages: [], next_before_id: null, last_seq: 0, compaction: null }),
      'POST /api/conversations/private/compact': () => ({ ok: true, job_id: 20, status: 'queued' }),
    });
    renderConversation('private');
    await screen.findByRole('button', { name: 'Send' });
    const compact = screen.getByRole('button', { name: 'Compact context' });
    await user.click(compact);
    const manual = screen.getByRole('status', { name: 'Context compaction' });
    const stream = FakeEventSource.instances[0];
    stream.emit(1, { type: 'compaction', phase: 'start', job_id: 20, status: 'compacting' });
    expect(within(manual).getByText('Compacting')).toBeVisible();
    stream.emit(2, { type: 'compaction', phase: 'end', reason: 'auto' });
    expect(within(manual).getByText('Compacting')).toBeVisible();
    expect(compact).toBeDisabled();
    stream.emit(3, { type: 'compaction', phase: 'end', job_id: 20, status, reason });
    expect(within(manual).getByText(label)).toBeVisible();
    if (reason === 'too_small') expect(within(manual).getByText('The conversation is too short to compact.')).toBeVisible();
    expect(compact).toBeEnabled();
    stream.emit(4, { type: 'compaction', phase: 'start', job_id: 20, status: 'compacting' });
    expect(within(manual).getByText(label)).toBeVisible();
  });

  it('does not regress a finished SSE operation when the enqueue acknowledgement arrives late', async () => {
    const user = userEvent.setup();
    let acknowledge!: (value: unknown) => void;
    serve({
      'GET /api/conversations/private/messages?limit=100': () => ({ messages: [], next_before_id: null, last_seq: 0, compaction: null }),
      'POST /api/conversations/private/compact': () => new Promise((resolve) => { acknowledge = resolve; }),
    });
    renderConversation('private');
    await screen.findByRole('button', { name: 'Send' });
    const compact = screen.getByRole('button', { name: 'Compact context' });
    await user.click(compact);
    expect(compact).toBeDisabled();
    await user.click(compact);
    expect(calls('POST', '/api/conversations/private/compact')).toEqual([{}]);
    FakeEventSource.instances[0].emit(1, { type: 'compaction', phase: 'end', job_id: 20, status: 'done' });
    await act(async () => acknowledge({ ok: true, job_id: 20, status: 'queued' }));
    expect(within(screen.getByRole('status', { name: 'Context compaction' })).getByText('Done')).toBeVisible();
    expect(compact).toBeEnabled();
  });

  it.each([
    ['queued', 'Queued', true],
    ['compacting', 'Compacting', true],
    ['done', 'Done', false],
    ['nothing_to_compact', 'Nothing to compact', false],
    ['interrupted', 'Interrupted', false],
    ['cancelled', 'Cancelled', false],
  ] as const)('hydrates %s compaction after reload without creating a live reply', async (status, label, busy) => {
    serve({
      'GET /api/conversations/private/messages?limit=100': () => ({
        messages: [], next_before_id: null, last_seq: 15, compaction: { job_id: 20, status },
      }),
    });
    const mounted = renderConversation('private');
    await screen.findByRole('status', { name: 'Context compaction' });
    mounted.unmount();
    renderConversation('private');
    const manual = await screen.findByRole('status', { name: 'Context compaction' });
    expect(within(manual).getByText(label)).toBeVisible();
    expect(screen.queryByRole('article', { name: 'Reply in progress' })).not.toBeInTheDocument();
    if (busy) {
      expect(screen.getByRole('button', { name: 'Compact context' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
    } else {
      expect(screen.getByRole('button', { name: 'Compact context' })).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    }
  });

  it('resets a channel conversation only after confirmation and reloads its history', async () => {
    const user = userEvent.setup();
    let page = { messages: [message(1, 'user', 'Old question'), message(2, 'assistant', 'Old answer')], next_before_id: null, last_seq: 9 };
    serve({
      'GET /api/conversations/channel-3/messages?limit=100': () => page,
      'POST /api/conversations/channel-3/reset': () => {
        page = { messages: [], next_before_id: null, last_seq: 12 };
        return { ok: true };
      },
    });
    renderConversation('channel-3');

    await user.click(await screen.findByRole('button', { name: 'Reset' }));
    expect(screen.getByText('Reset this conversation?')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls('POST', '/api/conversations/channel-3/reset')).toEqual([]);
    expect(screen.getByText('Old answer')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await user.click(screen.getByRole('button', { name: 'Reset conversation' }));
    expect(calls('POST', '/api/conversations/channel-3/reset')).toEqual([{}]);
    await waitFor(() => expect(screen.queryByText('Old answer')).not.toBeInTheDocument());
    await waitFor(() => expect(FakeEventSource.instances[FakeEventSource.instances.length - 1]?.url).toBe('/api/conversations/channel-3/events?after=12'));
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });

  it('acquires and releases browser takeover with one holder id', async () => {
    const user = userEvent.setup();
    let lease: { holder_user_id: number; expires_at: string } | null = null;
    serve({
      'GET /api/conversations/private/messages?limit=100': () => ({ messages: [], next_before_id: null, last_seq: 0 }),
      'GET /api/browser': () => ({ tabs: [{ tabId: 'tab-1', url: 'https://example.com/login', title: 'Example login' }], lease }),
      'POST /api/browser/lease': () => {
        lease = { holder_user_id: 1, expires_at: '2026-09-30T09:01:00Z' };
        return { lease };
      },
      'DELETE /api/browser/lease': () => {
        lease = null;
        return { ok: true };
      },
      'POST /api/browser/action': () => ({ content: 'ok', data: {}, is_error: false }),
    });
    renderConversation('private');

    await user.click(await screen.findByRole('button', { name: 'Computer' }));
    expect(await screen.findByRole('img', { name: 'Example login' })).toHaveAttribute('src', expect.stringContaining('/api/browser/screenshot?tab_id=tab-1'));
    expect(screen.getByText('The agent is using the browser')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Take control' }));
    expect(await screen.findByText('You are controlling the browser')).toBeVisible();
    const [acquired] = calls('POST', '/api/browser/lease') as { holder_id: string }[];
    expect(acquired.holder_id).toEqual(expect.any(String));

    await user.type(screen.getByLabelText('Text to type'), 'alice');
    await user.click(screen.getByRole('button', { name: 'Type' }));
    expect(calls('POST', '/api/browser/action')).toEqual([{ holder_id: acquired.holder_id, action: 'type', arguments: { tab_id: 'tab-1', text: 'alice', mode: 'keyboard' } }]);

    await user.click(screen.getByRole('button', { name: 'Hand back to agent' }));
    expect(await screen.findByText('The agent is using the browser')).toBeVisible();
    expect(calls('DELETE', '/api/browser/lease')).toEqual([{ holder_id: acquired.holder_id }]);
    expect(screen.getByRole('button', { name: 'Take control' })).toBeEnabled();
  });

  it('reports a competing takeover instead of pretending to hold the browser', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/conversations/private/messages?limit=100': () => ({ messages: [], next_before_id: null, last_seq: 0 }),
      'GET /api/browser': () => ({ tabs: [], lease: { holder_user_id: 2, expires_at: '2026-09-30T09:01:00Z' } }),
      'POST /api/browser/lease': () => {
        throw new Error('Browser is controlled by someone else');
      },
    });
    renderConversation('private');

    await user.click(await screen.findByRole('button', { name: 'Computer' }));
    expect(await screen.findByText('A person is controlling the browser')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Take control' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Browser is controlled by someone else');
    expect(screen.queryByText('You are controlling the browser')).not.toBeInTheDocument();
  });
});
