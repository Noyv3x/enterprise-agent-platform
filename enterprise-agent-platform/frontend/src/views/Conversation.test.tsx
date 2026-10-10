// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShellContext } from '../components/ui/beautiful/controls';
import { ApiError } from '../api';
import type * as ApiModule from '../api';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../i18n';
import { Conversation, type ConversationProps } from './Conversation';
import type { Message } from './conversation/types';

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../api', async (importOriginal) => ({ ...(await importOriginal<typeof ApiModule>()), request: api.request }));

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
  /** Delivers one event; a stream delta waits for its animation frame, which follows at once here. */
  emit(seq: number, event: Record<string, unknown> & { type: string }) {
    act(() => {
      const frames: FrameRequestCallback[] = [];
      const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => -frames.push(callback));
      this.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify({ seq, ...event }), lastEventId: String(seq) }));
      frame.mockRestore();
      for (const callback of frames) callback(performance.now());
    });
  }
}

type Route = (body: Record<string, unknown>) => unknown;

/** The personal AI loads its background tasks with every conversation; tests without tasks see none. */
const DEFAULT_ROUTES: Record<string, Route> = { 'GET /api/tasks': () => ({ tasks: [] }) };

function serve(routes: Record<string, Route>) {
  api.request.mockImplementation(async (path: string, options: RequestInit = {}) => {
    const key = `${options.method ?? 'GET'} ${path}`;
    const route = routes[key] ?? DEFAULT_ROUTES[key];
    if (!route) throw new Error(`unexpected ${options.method ?? 'GET'} ${path}`);
    return route(options.body && typeof options.body === 'string' ? JSON.parse(options.body) : {});
  });
}

function calls(method: string, path: string): unknown[] {
  return api.request.mock.calls
    .filter(([calledPath, options]) => calledPath === path && (options?.method ?? 'GET') === method)
    .map(([, options]) => (typeof options?.body === 'string' ? JSON.parse(options.body) : options?.body));
}

function message(id: number, role: Message['role'], content: string, status: Message['metadata']['status'] = 'completed'): Message {
  return { id, role, content, metadata: { status }, created_at: '2026-09-30T09:00:00Z', attachments: [] };
}

const page = (messages: Message[], extra: Record<string, unknown> = {}) => ({ messages, next_before_id: null, last_seq: 0, compaction: null, ...extra });

function renderConversation(scope: string, props: Partial<ConversationProps> = {}) {
  const aside = document.createElement('div');
  document.body.append(aside);
  return render(
    <I18nProvider>
      <ShellContext.Provider value={{ narrow: false, openNavigation: () => undefined, asideSlot: aside }}>
        <Conversation scope={scope} {...props} />
      </ShellContext.Provider>
    </I18nProvider>,
  );
}

/** The computer panel also shows the latest step's output; these assertions are about the conversation's own work trace. */
function inThread(text: string): HTMLElement {
  const node = screen.getAllByText(text).find((candidate) => !candidate.closest('aside, [role="complementary"]'));
  if (!node) throw new Error(`no thread text ${text}`);
  return node;
}

async function chooseAction(user: UserEvent, name: string) {
  await user.click(screen.getByRole('button', { name: 'Conversation actions' }));
  await user.click(await screen.findByRole('menuitem', { name }));
}

async function actionDisabled(user: UserEvent, name: string): Promise<boolean> {
  await user.click(screen.getByRole('button', { name: 'Conversation actions' }));
  const item = await screen.findByRole('menuitem', { name });
  const disabled = item.getAttribute('aria-disabled') === 'true';
  await user.click(screen.getByRole('button', { name: 'Conversation actions' }));
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  return disabled;
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('retains the draft, attachment and composer focus when another member starts an empty channel', async () => {
    const user = userEvent.setup();
    const attachment = { id: 17, filename: 'notes.txt', mime_type: 'text/plain', size_bytes: 5, url: '/api/attachments/17', preview_url: '/api/attachments/17/preview' };
    serve({
      'GET /api/conversations/channel-3/messages?limit=100': () => page([]),
      'POST /api/attachments?scope=channel-3': () => ({ attachment }),
      'POST /api/conversations/channel-3/messages': (body) => ({ message: message(3, 'user', String(body.content), 'queued'), job_id: 9 }),
    });
    renderConversation('channel-3');
    const input = await screen.findByLabelText('Message');
    await user.upload(screen.getByTestId('composer-file'), new File(['notes'], 'notes.txt', { type: 'text/plain' }));
    await screen.findByRole('button', { name: 'Remove notes.txt' });
    await user.type(input, 'My unsent draft');
    FakeEventSource.instances[0].emit(1, { type: 'message', message: message(1, 'user', 'Another member posted', 'queued') });
    expect(screen.getByLabelText('Message')).toBe(input);
    expect(input).toHaveFocus();
    expect(input).toHaveValue('My unsent draft');
    expect(screen.getByRole('button', { name: 'Remove notes.txt' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(calls('POST', '/api/conversations/channel-3/messages')).toEqual([{ content: 'My unsent draft', attachment_ids: [17] }]);
  });

  it('keeps a pending insert at the live reply end, delivers it between work segments, and persists the same layout', async () => {
    const user = userEvent.setup();
    const request = message(1, 'user', 'Review the report', 'running');
    const inserted: Message = { ...message(2, 'user', 'Focus on revenue', 'running'), metadata: {
      status: 'running', inserted_into: 1, delivery: 'pending', author_user_id: 2, author_display_name: 'Alex',
    } };
    let history = [request];
    serve({
      'GET /api/conversations/channel-3/messages?limit=100': () => page(history),
      'POST /api/conversations/channel-3/messages': () => ({ message: inserted, job_id: 12 }),
    });
    renderConversation('channel-3', { userId: 1 });
    const input = await screen.findByLabelText('Message');
    const stream = FakeEventSource.instances[0];
    stream.emit(1, { type: 'text_delta', delta: 'I will check the report.' });
    stream.emit(2, { type: 'tool_start', tool_call_id: 'read-report', name: 'read', args: { path: '/workspace/report.txt' } });
    await user.type(input, 'Focus on revenue{Enter}');
    let reply = screen.getByRole('article', { name: 'Reply in progress' });
    expect(within(reply).getByText('Focus on revenue')).toBeVisible();
    expect(within(reply).getByText('Alex')).toBeVisible();
    expect(within(reply).getByText('The agent will see this after its current step')).toBeVisible();
    expect(within(reply).getByText('/workspace/report.txt').compareDocumentPosition(within(reply).getByText('Focus on revenue')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('1 message waiting for the current step to finish')).toBeVisible();
    expect(screen.queryByText(/queued —/)).not.toBeInTheDocument();

    stream.emit(3, { type: 'tool_end', tool_call_id: 'read-report', is_error: false, content_preview: 'Q3 revenue' });
    stream.emit(4, { type: 'input_delivered', message_id: 2 });
    stream.emit(5, { type: 'thinking_delta', delta: 'Compare the revenue figures.' });
    stream.emit(6, { type: 'tool_start', tool_call_id: 'read-revenue', name: 'read', args: { path: '/workspace/revenue.txt' } });
    reply = screen.getByRole('article', { name: 'Reply in progress' });
    expect(screen.queryByText('The agent will see this after its current step')).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Message delivery' })).toHaveTextContent('Message delivered — the agent can now use it');
    expect(screen.getByRole('status', { name: 'Message delivery' })).toHaveAttribute('aria-live', 'polite');
    expect(within(reply).getByText('Focus on revenue').compareDocumentPosition(within(reply).getByText('/workspace/revenue.txt')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(reply).getByText('/workspace/revenue.txt')).toBeVisible();
    expect(screen.getAllByText('Focus on revenue')).toHaveLength(1);
    // Replaying delivery cannot insert another bubble or another segment.
    stream.emit(4, { type: 'input_delivered', message_id: 2 });
    stream.emit(7, { type: 'tool_end', tool_call_id: 'read-revenue', is_error: false, content_preview: 'Revenue rose 20%' });
    stream.emit(8, { type: 'text_delta', delta: 'Revenue rose 20%.' });
    const segmentHeaders = within(reply).getAllByRole('button', { name: /^(Worked|Thought) for/ });
    expect(segmentHeaders).toHaveLength(2);
    for (const header of segmentHeaders) expect(header).toHaveAttribute('aria-expanded', 'false');

    const finished: Message = { ...message(3, 'assistant', 'Revenue rose 20%.'), metadata: {
      status: 'completed', reply_to: { message_id: 1 }, work: {
        v: 1, started_at: '2026-10-03T09:00:00Z', ended_at: '2026-10-03T09:00:10Z', truncated: false, items: [
          { type: 'text', text: 'I will check the report.' },
          { type: 'tool', id: 'read-report', name: 'read', args: { path: '/workspace/report.txt' }, status: 'done', output: 'Q3 revenue' },
          { type: 'input', message_id: 2, at: '2026-10-03T09:00:05Z' },
          { type: 'thinking', text: 'Compare the revenue figures.' },
          { type: 'tool', id: 'read-revenue', name: 'read', args: { path: '/workspace/revenue.txt' }, status: 'done', output: 'Revenue rose 20%' },
        ],
      },
    } };
    history = [{ ...request, metadata: { status: 'completed' } }, { ...inserted, metadata: { ...inserted.metadata, status: 'completed', delivery: 'delivered' } }, finished];
    stream.emit(9, { type: 'run_end', message: finished });
    reply = screen.getByRole('article', { name: 'Agent reply' });
    expect(within(reply).getByText('Focus on revenue')).toBeVisible();
    expect(screen.getAllByText('Focus on revenue')).toHaveLength(1);
    expect(within(reply).getAllByRole('button', { name: /^(Worked|Thought) for/ })).toHaveLength(2);
    for (const header of within(reply).getAllByRole('button', { name: /^(Worked|Thought) for/ })) await user.click(header);
    const ordered = ['I will check the report.', '/workspace/report.txt', 'Focus on revenue', 'Compare the revenue figures.', '/workspace/revenue.txt', 'Revenue rose 20%.'];
    for (let index = 1; index < ordered.length; index++) {
      expect(within(reply).getByText(ordered[index - 1]).compareDocumentPosition(within(reply).getByText(ordered[index])) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument());
  });

  it('orders historical interleaved requests by their linked reply while preserving unpaired id positions', async () => {
    const a1 = { ...message(5, 'assistant', 'A1'), metadata: { reply_to: { message_id: 1 } } };
    const a2 = { ...message(7, 'assistant', 'A2'), metadata: { reply_to: { message_id: 2 } } };
    serve({ 'GET /api/conversations/channel-3/messages?limit=100': () => page([
      message(1, 'user', 'Q1'), message(2, 'user', 'Q2'), message(3, 'system', 'Context note'),
      message(4, 'user', 'Unpaired request'), a1, message(6, 'system', 'Later note'), a2,
    ]) });
    renderConversation('channel-3');
    await screen.findByText('A2');
    const ordered = ['Context note', 'Unpaired request', 'Q1', 'A1', 'Later note', 'Q2', 'A2'];
    for (let index = 1; index < ordered.length; index++) {
      expect(screen.getByText(ordered[index - 1]).compareDocumentPosition(screen.getByText(ordered[index])) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('renders truly queued messages after the live reply and counts only that queue', async () => {
    const inserted: Message = { ...message(2, 'user', 'Inline addition', 'running'), metadata: { status: 'running', inserted_into: 1, delivery: 'pending' } };
    serve({ 'GET /api/conversations/channel-3/messages?limit=100': () => page([
      message(1, 'user', 'Active request', 'running'), inserted, message(3, 'user', 'Next turn', 'queued'),
    ]) });
    renderConversation('channel-3');
    await screen.findByText('Next turn');
    FakeEventSource.instances[0].emit(1, { type: 'thinking_delta', delta: 'Working on the active request' });
    const live = screen.getByRole('article', { name: 'Reply in progress' });
    expect(within(live).getByText('Inline addition')).toBeVisible();
    expect(live.compareDocumentPosition(screen.getByText('Next turn')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Queued · 1 ahead')).toBeVisible();
    expect(screen.getByText('1 queued — messages run in order after the current reply')).toBeVisible();
  });

  it.each([
    ['en', 'Message', 'Add a message to this run…', 'Enter adds to this turn · Alt+Enter sends after it', 'Send options'],
    ['zh-CN', '消息', '补充消息，加入当前任务…', 'Enter 插入当前任务 · Alt+Enter 本轮结束后发送', '发送方式'],
    ['zh-TW', '訊息', '補充訊息，加入目前任務…', 'Enter 插入目前任務 · Alt+Enter 本輪結束後傳送', '傳送方式'],
  ])('explains both send modes in the working composer in %s', async (locale, label, placeholder, hint, options) => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    serve({ 'GET /api/conversations/channel-3/messages?limit=100': () => page([message(1, 'user', 'Working', 'running')]) });
    renderConversation('channel-3');
    expect(await screen.findByLabelText(label)).toHaveAttribute('placeholder', placeholder);
    expect(screen.getByText(hint)).toBeVisible();
    expect(screen.getByRole('button', { name: options })).toHaveAttribute('aria-haspopup', 'menu');
  });

  it('sends Enter into the running turn and Alt+Enter or the menu choice after it', async () => {
    const user = userEvent.setup();
    let next = 10;
    serve({
      'GET /api/conversations/channel-3/messages?limit=100': () => page([message(1, 'user', 'Working', 'running')]),
      // Every accepted message is absorbed, so the turn stays insertable for the next send.
      'POST /api/conversations/channel-3/messages': (body) => ({
        message: { ...message(next++, 'user', String(body.content), 'running'), metadata: { status: 'running', inserted_into: 1, delivery: 'pending' } }, job_id: next,
      }),
    });
    renderConversation('channel-3');
    const input = await screen.findByLabelText('Message');
    await user.type(input, 'Insert this{Enter}');
    await waitFor(() => expect(input).toHaveValue(''));
    await user.type(input, 'After this turn');
    await user.keyboard('{Alt>}{Enter}{/Alt}');
    await waitFor(() => expect(input).toHaveValue(''));
    await user.type(input, 'Chosen from the menu');
    await user.click(screen.getByRole('button', { name: 'Send options' }));
    const menu = await screen.findByRole('menu', { name: 'Send options' });
    expect(within(menu).getByRole('menuitem', { name: /Add to this turn/ })).toHaveTextContent('Enter');
    await user.click(within(menu).getByRole('menuitem', { name: /Send after this turn/ }));
    await waitFor(() => expect(input).toHaveValue(''));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(calls('POST', '/api/conversations/channel-3/messages')).toEqual([
      { content: 'Insert this', attachment_ids: [], mode: 'insert' },
      { content: 'After this turn', attachment_ids: [], mode: 'after_turn' },
      { content: 'Chosen from the menu', attachment_ids: [], mode: 'after_turn' },
    ]);
  });

  it('offers withdraw only to the author before delivery and labels after-turn messages', async () => {
    const pending: Message = { ...message(2, 'user', 'Mine, pending'), metadata: { status: 'running', inserted_into: 1, delivery: 'pending', author_user_id: 1 } };
    const theirs: Message = { ...message(3, 'user', 'Theirs, queued'), metadata: { status: 'queued', author_user_id: 2, author_display_name: 'Alex' } };
    const later: Message = { ...message(4, 'user', 'Mine, after the turn'), metadata: { status: 'queued', send_mode: 'after_turn', author_user_id: 1 } };
    serve({ 'GET /api/conversations/channel-3/messages?limit=100': () => page([{ ...message(1, 'user', 'Start', 'running'), metadata: { status: 'running', author_user_id: 1 } }, pending, theirs, later]) });
    renderConversation('channel-3', { userId: 1 });
    const bubble = (text: string) => screen.getByText(text).closest('div.flex-col') as HTMLElement;
    await screen.findByText('Mine, after the turn');
    expect(within(bubble('Mine, pending')).getByRole('button', { name: 'Withdraw' })).toBeVisible();
    expect(within(bubble('Mine, after the turn')).getByRole('button', { name: 'Withdraw' })).toBeVisible();
    expect(within(bubble('Mine, after the turn')).getByText('Sends after this turn · 2 ahead')).toBeVisible();
    expect(within(bubble('Theirs, queued')).queryByRole('button', { name: 'Withdraw' })).not.toBeInTheDocument();
    expect(within(bubble('Start')).queryByRole('button', { name: 'Withdraw' })).not.toBeInTheDocument();

    FakeEventSource.instances[0].emit(1, { type: 'input_delivered', message_id: 2 });
    expect(within(bubble('Mine, pending')).queryByRole('button', { name: 'Withdraw' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Withdraw' })).toHaveLength(1);
  });

  it('withdraws into the composer: the text goes above the draft and the files return as chips', async () => {
    const user = userEvent.setup();
    const attachment = { id: 17, filename: 'notes.txt', mime_type: 'text/plain', size_bytes: 5, url: '/api/attachments/17', preview_url: '/api/attachments/17/preview' };
    const later: Message = { ...message(2, 'user', 'Check the totals'), metadata: { status: 'queued', send_mode: 'after_turn' }, attachments: [attachment] };
    serve({
      'GET /api/conversations/private/messages?limit=100': () => page([message(1, 'user', 'Working', 'running'), later]),
      'DELETE /api/conversations/private/messages/2': () => ({ content: 'Check the totals', attachments: [attachment] }),
      'POST /api/conversations/private/messages': (body) => ({ message: message(3, 'user', String(body.content), 'queued'), job_id: 9 }),
    });
    renderConversation('private');
    const input = await screen.findByLabelText('Message');
    await user.type(input, 'My draft');
    await user.click(screen.getByRole('button', { name: 'Withdraw' }));
    expect(calls('DELETE', '/api/conversations/private/messages/2')).toHaveLength(1);
    await waitFor(() => expect(input).toHaveValue('Check the totals\n\nMy draft'));
    expect(screen.queryByText('Check the totals', { selector: '[role="log"] *' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove notes.txt' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(calls('POST', '/api/conversations/private/messages')).toEqual([{ content: 'Check the totals\n\nMy draft', attachment_ids: [17], mode: 'insert' }]);
  });

  it('keeps a chat message the agent already read and says so gently', async () => {
    const user = userEvent.setup();
    const pending: Message = { ...message(2, 'user', 'Too late'), metadata: { status: 'running', inserted_into: 1, delivery: 'pending' } };
    serve({
      'GET /api/chat/conversations/abc/messages?limit=100': () => page([message(1, 'user', 'Working', 'running'), pending]),
      'DELETE /api/chat/conversations/abc/messages/2': () => { throw new ApiError('already_seen', 409); },
    });
    renderConversation('chat-abc');
    await user.click(await screen.findByRole('button', { name: 'Withdraw' }));
    expect(await screen.findByText('The agent is already taking this message in')).toHaveAttribute('role', 'status');
    expect(screen.getByText('Too late')).toBeVisible();
    expect(screen.getByLabelText('Message')).toHaveValue('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('removes a message withdrawn elsewhere when message_removed arrives, and ignores later events for it', async () => {
    const theirs: Message = { ...message(2, 'user', 'Withdrawn by Alex'), metadata: { status: 'queued', author_user_id: 2, author_display_name: 'Alex' } };
    serve({ 'GET /api/conversations/channel-3/messages?limit=100': () => page([message(1, 'user', 'Working', 'running'), theirs]) });
    renderConversation('channel-3', { userId: 1 });
    await screen.findByText('Withdrawn by Alex');
    expect(screen.getByText('1 queued — messages run in order after the current reply')).toBeVisible();
    const stream = FakeEventSource.instances[0];
    stream.emit(1, { type: 'message_removed', message_id: 2 });
    await waitFor(() => expect(screen.queryByText('Withdrawn by Alex')).not.toBeInTheDocument());
    stream.emit(2, { type: 'message', message: theirs });
    expect(screen.queryByText('Withdrawn by Alex')).not.toBeInTheDocument();
    expect(screen.queryByText(/queued —/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Message')).toHaveValue('');
  });

  it('keeps a message withdrawn while an earlier page was loading out of that page', async () => {
    const user = userEvent.setup();
    // The app's TypeScript lib predates Promise.withResolvers.
    let release: (value: unknown) => void = () => {};
    serve({
      'GET /api/conversations/private/messages?limit=100': () => page([message(5, 'user', 'Recent')], { next_before_id: 5 }),
      'GET /api/conversations/private/messages?before=5&limit=100': () => new Promise((resolve) => { release = resolve; }),
    });
    renderConversation('private');
    await user.click(await screen.findByRole('button', { name: 'Load earlier messages' }));
    FakeEventSource.instances[0].emit(1, { type: 'message_removed', message_id: 3 });
    release(page([message(2, 'user', 'Kept earlier'), message(3, 'user', 'Withdrawn meanwhile')]));
    expect(await screen.findByText('Kept earlier')).toBeVisible();
    expect(screen.queryByText('Withdrawn meanwhile')).not.toBeInTheDocument();
  });

  it('confirms Stop when queued and pending messages would be cancelled with the run', async () => {
    const user = userEvent.setup();
    const pending: Message = { ...message(2, 'user', 'Pending insert'), metadata: { status: 'running', inserted_into: 1, delivery: 'pending' } };
    serve({
      'GET /api/conversations/private/messages?limit=100': () => page([message(1, 'user', 'Working', 'running'), pending, message(3, 'user', 'Queued next', 'queued')]),
      'POST /api/conversations/private/cancel': () => ({ ok: true }),
    });
    renderConversation('private');
    await user.click(await screen.findByRole('button', { name: 'Stop' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Stop the agent?' });
    expect(dialog).toHaveTextContent('2 queued messages will also be cancelled. You can send them again afterwards.');
    expect(calls('POST', '/api/conversations/private/cancel')).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Keep working' }));
    expect(calls('POST', '/api/conversations/private/cancel')).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Stop' }));
    expect(calls('POST', '/api/conversations/private/cancel')).toEqual([{}]);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('keeps the same bubble node from pending to delivered and the same reply node from live to persisted', async () => {
    const user = userEvent.setup();
    const request = message(1, 'user', 'Review the report', 'running');
    const inserted: Message = { ...message(2, 'user', 'Focus on revenue', 'running'), metadata: { status: 'running', inserted_into: 1, delivery: 'pending' } };
    serve({ 'GET /api/conversations/private/messages?limit=100': () => page([request, inserted]) });
    renderConversation('private');
    await screen.findByText('Focus on revenue');
    const stream = FakeEventSource.instances[0];
    stream.emit(1, { type: 'tool_start', tool_call_id: 'read-report', name: 'read', args: { path: '/workspace/report.txt' } });
    const live = screen.getByRole('article', { name: 'Reply in progress' });
    const bubble = within(live).getByText('Focus on revenue');
    const requestBubble = screen.getByText('Review the report');
    stream.emit(2, { type: 'tool_end', tool_call_id: 'read-report', is_error: false, content_preview: 'Q3' });
    stream.emit(3, { type: 'input_delivered', message_id: 2 });
    stream.emit(4, { type: 'tool_start', tool_call_id: 'read-revenue', name: 'read', args: { path: '/workspace/revenue.txt' } });
    expect(within(live).getByText('Focus on revenue')).toBe(bubble);
    expect(within(live).queryByText('The agent will see this after its current step')).not.toBeInTheDocument();
    // A reader opens the first segment; settling must not close it.
    const first = within(live).getAllByRole('button', { name: /^Worked for/ })[0];
    await user.click(first);
    expect(first).toHaveAttribute('aria-expanded', 'true');
    stream.emit(5, { type: 'tool_end', tool_call_id: 'read-revenue', is_error: false, content_preview: 'Up 20%' });
    stream.emit(6, { type: 'text_delta', delta: 'Revenue rose 20%.' });

    const finished: Message = { ...message(3, 'assistant', 'Revenue rose 20%.'), metadata: {
      status: 'completed', reply_to: { message_id: 1 }, work: {
        v: 1, started_at: '2026-10-03T09:00:00Z', ended_at: '2026-10-03T09:00:10Z', truncated: false, items: [
          { type: 'tool', id: 'read-report', name: 'read', args: { path: '/workspace/report.txt' }, status: 'done', output: 'Q3' },
          { type: 'input', message_id: 2, at: '2026-10-03T09:00:05Z' },
          { type: 'tool', id: 'read-revenue', name: 'read', args: { path: '/workspace/revenue.txt' }, status: 'done', output: 'Up 20%' },
        ],
      },
    } };
    stream.emit(7, { type: 'message', message: { ...request, metadata: { status: 'completed' } } });
    stream.emit(8, { type: 'message', message: { ...inserted, metadata: { ...inserted.metadata, status: 'completed', delivery: 'delivered' } } });
    stream.emit(9, { type: 'run_end', message: finished });
    const settled = screen.getByRole('article', { name: 'Agent reply' });
    expect(settled).toBe(live);
    expect(settled).not.toHaveAttribute('aria-busy');
    expect(within(settled).getByText('Focus on revenue')).toBe(bubble);
    expect(within(settled).getAllByRole('button', { name: /^Worked for/ })[0]).toBe(first);
    expect(first).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Review the report')).toBe(requestBubble);
  });

  it('keeps resend on a cancelled inserted message inside its persisted reply', async () => {
    const user = userEvent.setup();
    const inserted: Message = { ...message(2, 'user', 'Use the revised figures', 'cancelled'), metadata: { status: 'cancelled', inserted_into: 1, delivery: 'delivered' } };
    const answer: Message = { ...message(3, 'assistant', 'Partial result', 'cancelled'), metadata: {
      status: 'cancelled', reply_to: { message_id: 1 },
      work: { v: 1, items: [{ type: 'input', message_id: 2, at: '2026-10-03T09:00:05Z' }] },
    } };
    serve({
      'GET /api/conversations/channel-3/messages?limit=100': () => page([message(1, 'user', 'Review', 'cancelled'), inserted, answer]),
      'POST /api/conversations/channel-3/messages': (body) => ({ message: message(4, 'user', String(body.content), 'queued'), job_id: 14 }),
    });
    renderConversation('channel-3');
    const reply = await screen.findByRole('article', { name: 'Agent reply' });
    expect(within(reply).getByText('Use the revised figures')).toBeVisible();
    await user.click(within(reply).getByRole('button', { name: 'Send again' }));
    expect(calls('POST', '/api/conversations/channel-3/messages')).toEqual([{ content: 'Use the revised figures', attachment_ids: [] }]);
  });

  it('keeps a segment break when its inserted message is not loaded', async () => {
    const user = userEvent.setup();
    const reply: Message = { ...message(5, 'assistant', 'Finished'), metadata: {
      reply_to: { message_id: 1 }, work: { v: 1, started_at: '2026-10-03T09:00:00Z', ended_at: '2026-10-03T09:00:10Z', items: [
        { type: 'text', text: 'Before input' }, { type: 'input', message_id: 2, at: '2026-10-03T09:00:05Z' }, { type: 'thinking', text: 'After input' },
      ] },
    } };
    serve({ 'GET /api/conversations/channel-3/messages?limit=100': () => page([reply], { next_before_id: 5 }) });
    renderConversation('channel-3');
    const article = await screen.findByRole('article', { name: 'Agent reply' });
    const segments = within(article).getAllByRole('button', { name: /^(Worked|Thought) for/ });
    expect(segments).toHaveLength(2);
    for (const segment of segments) await user.click(segment);
    expect(within(article).getByText('Before input')).toBeVisible();
    expect(within(article).getByText('After input')).toBeVisible();
    expect(within(article).queryByText(/will see this|waiting for/)).not.toBeInTheDocument();
  });

  it('renders an absorbed input inside the starting reply before Runtime emits its first event', async () => {
    const inserted: Message = { ...message(2, 'user', 'One more detail', 'running'), metadata: { status: 'running', inserted_into: 1, delivery: 'pending' } };
    serve({ 'GET /api/conversations/channel-3/messages?limit=100': () => page([message(1, 'user', 'Start here', 'running'), inserted]) });
    renderConversation('channel-3');
    const live = await screen.findByRole('article', { name: 'Reply in progress' });
    expect(within(live).getByText('Starting')).toBeVisible();
    expect(within(live).getByText('One more detail')).toBeVisible();
    expect(screen.getByText('Start here').compareDocumentPosition(live) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByText('One more detail')).toHaveLength(1);
  });

  it('does not regress delivered input when its POST acknowledgement arrives after SSE', async () => {
    const user = userEvent.setup();
    let acknowledge!: (value: unknown) => void;
    const inserted: Message = { ...message(2, 'user', 'Keep it brief', 'running'), metadata: { status: 'running', inserted_into: 1, delivery: 'pending' } };
    serve({
      'GET /api/conversations/channel-3/messages?limit=100': () => page([message(1, 'user', 'Explain', 'running')]),
      'POST /api/conversations/channel-3/messages': () => new Promise((resolve) => { acknowledge = resolve; }),
    });
    renderConversation('channel-3');
    await user.type(await screen.findByLabelText('Message'), 'Keep it brief{Enter}');
    const stream = FakeEventSource.instances[0];
    stream.emit(1, { type: 'message', message: inserted });
    stream.emit(2, { type: 'input_delivered', message_id: 2 });
    stream.emit(3, { type: 'thinking_delta', delta: 'Summarize only the key point.' });
    await act(async () => acknowledge({ message: inserted, job_id: 12 }));
    expect(screen.queryByText('The agent will see this after its current step')).not.toBeInTheDocument();
    expect(screen.queryByText('1 message waiting for the current step to finish')).not.toBeInTheDocument();
    expect(screen.getAllByText('Keep it brief')).toHaveLength(1);
  });

  it('keeps earlier assistant text before consecutive delivered inputs instead of merging it into the final answer', async () => {
    const first: Message = { ...message(2, 'user', 'First addition', 'running'), metadata: { status: 'running', inserted_into: 1, delivery: 'pending' } };
    const second: Message = { ...message(3, 'user', 'Second addition', 'running'), metadata: { status: 'running', inserted_into: 1, delivery: 'pending' } };
    serve({ 'GET /api/conversations/channel-3/messages?limit=100': () => page([message(1, 'user', 'Question', 'running'), first, second]) });
    renderConversation('channel-3');
    await screen.findByText('Question');
    const stream = FakeEventSource.instances[0];
    stream.emit(1, { type: 'text_delta', delta: 'Initial answer.' });
    stream.emit(2, { type: 'input_delivered', message_id: 2 });
    stream.emit(3, { type: 'input_delivered', message_id: 3 });
    stream.emit(4, { type: 'text_delta', delta: 'Revised answer.' });
    const live = screen.getByRole('article', { name: 'Reply in progress' });
    expect(within(live).getByText('Initial answer.')).not.toBeVisible();
    expect(within(live).getByText('Revised answer.')).toBeVisible();
    const ordered = ['Initial answer.', 'First addition', 'Second addition', 'Revised answer.'];
    for (let index = 1; index < ordered.length; index++) {
      expect(within(live).getByText(ordered[index - 1]).compareDocumentPosition(within(live).getByText(ordered[index])) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('returns an undelivered insert to the standalone queue without duplicating it', async () => {
    const inserted: Message = { ...message(2, 'user', 'Use this later', 'running'), metadata: { status: 'running', inserted_into: 1, delivery: 'pending' } };
    serve({ 'GET /api/conversations/channel-3/messages?limit=100': () => page([message(1, 'user', 'Running', 'running'), inserted]) });
    renderConversation('channel-3');
    await screen.findByText('Use this later');
    FakeEventSource.instances[0].emit(1, { type: 'message', message: message(2, 'user', 'Use this later', 'queued') });
    const live = screen.getByRole('article', { name: 'Reply in progress' });
    expect(within(live).queryByText('Use this later')).not.toBeInTheDocument();
    expect(live.compareDocumentPosition(screen.getByText('Use this later')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByText('Use this later')).toHaveLength(1);
    expect(screen.getByText('Queued · 1 ahead')).toBeVisible();
  });

  it('resends the selected request when cancellation replies settle in reverse order', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/conversations/channel-3/messages?limit=100': () => page([
        message(1, 'user', 'Request A', 'cancelled'),
        message(2, 'user', 'Request B', 'cancelled'),
        message(3, 'assistant', 'Cancelled B', 'cancelled'),
        message(4, 'assistant', 'Partial A', 'cancelled'),
      ]),
      'POST /api/conversations/channel-3/messages': (body) => ({ message: message(5, 'user', String(body.content), 'queued'), job_id: 9 }),
    });
    renderConversation('channel-3');
    await screen.findByText('Request A');
    // The retry is attached to the request, never inferred from answer completion order.
    const retry = screen.getAllByRole('button', { name: 'Send again' })[0];
    expect(retry.parentElement?.parentElement).toHaveTextContent('Request A');
    await user.click(retry);
    expect(calls('POST', '/api/conversations/channel-3/messages')).toEqual([{ content: 'Request A', attachment_ids: [] }]);
  });

  it('shows a persisted work trace collapsed after the reply, expandable to thinking, interim text and tool details', async () => {
    const user = userEvent.setup();
    const reply = { ...message(2, 'assistant', 'Q3 revenue grew **20%**.'), metadata: { status: 'completed' as const, work: {
      v: 1, started_at: '2026-10-01T05:22:00Z', ended_at: '2026-10-01T05:22:12Z', truncated: false,
      items: [
        { type: 'thinking', text: 'Check the report before summarizing.' },
        { type: 'text', text: 'I will read the revenue report.' },
        { type: 'tool', id: 'call_1', name: 'read', args: { path: '/workspace/revenue.txt' }, status: 'done', output: 'Q3 revenue: $1.2M', started_at: '2026-10-01T05:22:01Z', ended_at: '2026-10-01T05:22:02Z' },
        { type: 'tool', id: 'call_2', name: 'bash', args: { command: 'cat missing.txt' }, status: 'error', output: 'No such file', started_at: '2026-10-01T05:22:03Z', ended_at: '2026-10-01T05:22:04Z' },
      ],
    } } };
    serve({ 'GET /api/conversations/private/messages?limit=100': () => page([message(1, 'user', 'Summarize Q3'), reply]) });
    renderConversation('private');

    expect(await screen.findByText('20%', { selector: 'strong' })).toBeVisible();
    const header = screen.getByRole('button', { name: 'Thought for 12s' });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    await user.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Check the report before summarizing.')).toBeVisible();
    expect(screen.getByText('I will read the revenue report.')).toBeVisible();
    expect(screen.getByRole('button', { name: '2 tool calls' })).toBeVisible();
    expect(inThread('Failed')).toBeVisible();

    const read = screen.getByRole('button', { name: /Read.*revenue\.txt/ });
    expect(inThread('Q3 revenue: $1.2M')).not.toBeVisible();
    await user.click(read);
    expect(read).toHaveAttribute('aria-expanded', 'true');
    expect(inThread('Q3 revenue: $1.2M')).toBeVisible();
  });

  it('renders old agent_work records read-only: tools, interim text, plain steps, omissions, never approval actions', async () => {
    const user = userEvent.setup();
    const oldReply = { ...message(1, 'assistant', 'Done'), metadata: { agent_work: {
      state: 'needs_review',
      activity: [
        { stage: 'preparing', label: 'Preparing workspace', detail: 'sandbox ready', at: '1790000000' },
        { stage: 'assistant.message', source: 'agent', detail: 'Checking the **release**.' },
        { stage: 'tool', source: 'agent', tool: 'terminal', tool_status: 'completed', detail: 'printf release', parameters: { command: 'printf release', cwd: '/workspace' }, result: 'release ready', at: '1790000001', completed_at: '1790000009' },
        { stage: 'tool', source: 'agent', label: 'web', tool_status: 'failed', detail: 'Release notes', result: '<script>bad()</script>' },
        { stage: 'tool', source: 'agent', tool: 'deploy', tool_status: 'running', detail: 'rollout' },
        { stage: 'approval', label: 'Approve deployment', detail: 'production' },
        { stage: 'work.truncated', omitted_events: 4 },
      ],
    } } };
    serve({ 'GET /api/conversations/private/messages?limit=100': () => page([oldReply]) });
    renderConversation('private');

    await user.click(await screen.findByRole('button', { name: 'Worked for 9s' }));
    expect(screen.getByText('release', { selector: 'strong' })).toBeVisible();
    expect(screen.getByText('Preparing workspace')).toBeVisible();
    expect(screen.getByText('3 tool calls')).toBeVisible();
    expect(inThread('Failed')).toBeVisible();
    expect(inThread('Stopped')).toBeVisible();
    await user.click(screen.getByRole('button', { name: /terminal/ }));
    expect(screen.getByText(/"cwd": "\/workspace"/)).toBeVisible();
    expect(inThread('release ready')).toBeVisible();
    await user.click(screen.getByRole('button', { name: /web/ }));
    expect(inThread('<script>bad()</script>')).toBeVisible();
    expect(screen.getByText('Earlier activity was omitted (4)')).toBeVisible();
    // Removed actions stay removed: the approval is a plain line, never a control.
    expect(screen.getByText('Approve deployment')).toBeVisible();
    expect(screen.queryByRole('button', { name: /approve|deny/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/needs.review/i)).not.toBeInTheDocument();
  });

  it('streams thinking, a running tool and the answer, then replaces the live reply with the persisted message', async () => {
    const user = userEvent.setup();
    const history = [message(1, 'assistant', 'Earlier **answer**')];
    serve({
      'GET /api/conversations/private/messages?limit=100': () => page(history, { last_seq: 41 }),
      'POST /api/conversations/private/messages': (body) => ({ message: message(2, 'user', String(body.content), 'queued'), job_id: 9 }),
    });
    renderConversation('private');

    expect(await screen.findByText('answer')).toBeVisible();
    const stream = FakeEventSource.instances[0];
    expect(stream.url).toBe('/api/conversations/private/events?after=41');

    await user.type(screen.getByLabelText('Message'), 'List the files{Enter}');
    expect(calls('POST', '/api/conversations/private/messages')).toEqual([{ content: 'List the files', attachment_ids: [] }]);
    expect(await screen.findByText('List the files')).toBeVisible();
    expect(screen.getAllByText('Queued')[0]).toBeVisible();
    expect(screen.getByLabelText('Message')).toHaveValue('');

    stream.emit(42, { type: 'message', message: message(2, 'user', 'List the files', 'running') });
    expect(screen.getByText('Starting')).toBeVisible();

    stream.emit(43, { type: 'thinking_delta', delta: 'Look at the ' });
    stream.emit(44, { type: 'thinking_delta', delta: 'workspace.' });
    const live = screen.getByRole('article', { name: 'Reply in progress' });
    expect(within(live).getByText('Look at the workspace.')).toBeVisible();
    expect(within(live).getByText(/Thinking/)).toBeVisible();

    stream.emit(45, { type: 'tool_start', tool_call_id: 'call-1', name: 'bash', args: { command: 'ls -la' } });
    expect(within(live).getByText('ls -la')).toBeVisible();
    expect(within(live).getByText('Running')).toBeVisible();
    stream.emit(46, { type: 'tool_end', tool_call_id: 'call-1', name: 'bash', is_error: false, content_preview: { content: [{ type: 'text', text: 'notes.md\nreport.pdf' }] }, details: {} });
    expect(within(live).queryByText('Running')).not.toBeInTheDocument();

    stream.emit(47, { type: 'text_delta', delta: 'Found two ' });
    stream.emit(48, { type: 'text_delta', delta: 'files.' });
    expect(within(live).getByText('Found two files.')).toBeVisible();
    // The work settles while the answer streams.
    expect(within(live).getByRole('button', { name: /^Thought for/ })).toHaveAttribute('aria-expanded', 'false');

    history.splice(0, history.length, message(1, 'assistant', 'Earlier **answer**'), message(2, 'user', 'List the files'), {
      ...message(3, 'assistant', 'Found two files: notes.md and report.pdf.'), metadata: { status: 'completed', reply_to: { message_id: 2 } },
    });
    stream.emit(49, { type: 'run_end', status: 'completed', text: 'Found two files: notes.md and report.pdf.', usage: {}, message: history[2] });

    expect(screen.queryByRole('article', { name: 'Reply in progress' })).not.toBeInTheDocument();
    expect(screen.getByText('Found two files: notes.md and report.pdf.')).toBeVisible();
    await waitFor(() => expect(screen.queryByText('Queued')).not.toBeInTheDocument());
  });

  it('streams empty and separate timed reasoning blocks, preserves Markdown parts, and restores the same persisted summaries', async () => {
    const start = Date.parse('2026-10-04T09:00:00Z');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    let history = [message(1, 'user', 'Review the report', 'running')];
    serve({ 'GET /api/conversations/channel-3/messages?limit=100': () => page(history) });
    renderConversation('channel-3');
    await screen.findByLabelText('Message');
    const stream = FakeEventSource.instances[0];
    stream.emit(1, { type: 'thinking_start' });
    const live = screen.getByRole('article', { name: 'Reply in progress' });
    const pulse = within(live).getAllByRole('status').find((node) => node.textContent === 'Thinking');
    expect(pulse).toBeVisible();
    clock.mockReturnValue(start + 2_000);
    stream.emit(2, { type: 'thinking_end' });
    expect(pulse).not.toBeInTheDocument();
    clock.mockReturnValue(start + 3_000);
    stream.emit(3, { type: 'thinking_start' });
    stream.emit(4, { type: 'thinking_delta', delta: '**Inspecting the report**\n\n<!--' });
    expect(within(live).getByText('Inspecting the report', { selector: 'strong' })).toBeVisible();
    expect(live).not.toHaveTextContent('<!--');
    stream.emit(5, { type: 'thinking_delta', delta: ' -->\n\nReading the figures.\n\n**Comparing totals**\n\n<!-- -->\n\nChecking the arithmetic.' });
    clock.mockReturnValue(start + 11_000);
    stream.emit(6, { type: 'thinking_end' });
    expect(within(live).getByText('Thought for 8s')).toBeVisible();
    expect(within(live).getByText('Comparing totals', { selector: 'strong' })).toBeVisible();
    expect(live).not.toHaveTextContent('**');
    // A provider's unmatched deltas still merge, but never into the explicit finished block.
    stream.emit(7, { type: 'thinking_delta', delta: 'Untimed ' });
    stream.emit(8, { type: 'thinking_delta', delta: 'summary.' });
    expect(within(live).getByText('Untimed summary.')).toBeVisible();
    expect(within(live).getByText('Checking the arithmetic.')).toBeVisible();
    stream.emit(9, { type: 'tool_start', tool_call_id: 'report', name: 'read', args: { path: '/workspace/report.txt' } });
    stream.emit(10, { type: 'tool_end', tool_call_id: 'report', is_error: false, content_preview: 'Totals match.' });
    stream.emit(11, { type: 'text_delta', delta: 'The totals match.' });
    expect(within(live).getByRole('button', { name: /^Thought for/ })).toHaveAttribute('aria-expanded', 'false');
    const reply: Message = { ...message(2, 'assistant', 'The totals match.'), metadata: { status: 'completed', reply_to: { message_id: 1 }, work: {
      v: 1, started_at: '2026-10-04T09:00:00Z', ended_at: '2026-10-04T09:00:12Z', items: [
        { type: 'thinking', text: '', started_at: '2026-10-04T09:00:00Z', ended_at: '2026-10-04T09:00:02Z' },
        { type: 'thinking', text: '**Inspecting the report**\n\n<!-- -->\n\nReading the figures.\n\n**Comparing totals**\n\n<!-- -->\n\nChecking the arithmetic.', started_at: '2026-10-04T09:00:03Z', ended_at: '2026-10-04T09:00:11Z' },
        { type: 'thinking', text: 'Untimed summary.' },
        { type: 'tool', id: 'report', name: 'read', args: { path: '/workspace/report.txt' }, status: 'done', output: 'Totals match.' },
      ],
    } } };
    history = [message(1, 'user', 'Review the report'), reply];
    stream.emit(12, { type: 'run_end', message: reply });
    const finished = screen.getByRole('article', { name: 'Agent reply' });
    fireEvent.click(within(finished).getByRole('button', { name: 'Thought for 12s' }));
    expect(within(finished).getByText('Thought for 8s')).toBeVisible();
    expect(within(finished).getByText('Inspecting the report', { selector: 'strong' })).toBeVisible();
    expect(within(finished).getByText('Comparing totals', { selector: 'strong' })).toBeVisible();
    expect(within(finished).getByText('Untimed summary.')).toBeVisible();
    expect(within(finished).getByText('The totals match.')).toBeVisible();
    expect(within(finished).queryByText('Thought for 2s')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument());
  });

  it('keeps Shift+Enter and IME composition from sending', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/conversations/private/messages?limit=100': () => page([]),
      'POST /api/conversations/private/messages': (body) => ({ message: message(2, 'user', String(body.content), 'queued'), job_id: 9 }),
    });
    renderConversation('private');
    const input = await screen.findByLabelText('Message');
    await user.type(input, 'line one{Shift>}{Enter}{/Shift}line two');
    expect(input).toHaveValue('line one\nline two');
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.compositionEnd(input);
    expect(calls('POST', '/api/conversations/private/messages')).toEqual([]);
    await user.type(input, '{Enter}');
    expect(calls('POST', '/api/conversations/private/messages')).toEqual([{ content: 'line one\nline two', attachment_ids: [] }]);
  });

  it('sends an uploaded attachment without text and shows it as a downloadable file card', async () => {
    const user = userEvent.setup();
    const attachment = { id: 17, filename: 'notes.txt', mime_type: 'text/plain', size_bytes: 5, url: '/api/attachments/17', preview_url: '/api/attachments/17/preview' };
    serve({
      'GET /api/conversations/private/messages?limit=100': () => page([]),
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
    expect(await screen.findByRole('link', { name: 'Download notes.txt' })).toHaveAttribute('href', '/api/attachments/17');
    expect(screen.queryByRole('button', { name: 'Remove notes.txt' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(document.querySelector('iframe')).toHaveAttribute('src', '/api/attachments/17/preview');
  });

  it('accepts pasted files as attachments', async () => {
    const attachment = { id: 18, filename: 'shot.png', mime_type: 'image/png', size_bytes: 2048, url: '/api/attachments/18', preview_url: null };
    serve({
      'GET /api/conversations/private/messages?limit=100': () => page([]),
      'POST /api/attachments?scope=private': () => ({ attachment }),
    });
    renderConversation('private');
    const input = await screen.findByLabelText('Message');
    fireEvent.paste(input, { clipboardData: { files: [new File(['png'], 'shot.png', { type: 'image/png' })] } });
    expect(await screen.findByText('2.0 KB')).toBeVisible();
    expect(calls('POST', '/api/attachments?scope=private')).toHaveLength(1);
  });

  it('attaches an unnamed clipboard image that only appears in the clipboard items', async () => {
    serve({
      'GET /api/conversations/private/messages?limit=100': () => page([]),
      'POST /api/attachments?scope=private': () => ({ attachment: { id: 19, filename: 'pasted-image-1.png', mime_type: 'image/png', size_bytes: 3, url: '/api/attachments/19', preview_url: null } }),
    });
    renderConversation('private');
    const input = await screen.findByLabelText('Message');
    const image = new File(['png'], '', { type: 'image/png' });
    fireEvent.paste(input, { clipboardData: { files: [], items: [{ kind: 'string', type: 'text/html', getAsFile: () => null }, { kind: 'file', type: 'image/png', getAsFile: () => image }] } });
    expect(await screen.findByText('pasted-image-1.png')).toBeVisible();
    expect(calls('POST', '/api/attachments?scope=private')).toHaveLength(1);
  });

  it('attaches files pasted while focus is outside the composer, but not pastes into another text field', async () => {
    serve({
      'GET /api/conversations/private/messages?limit=100': () => page([message(1, 'assistant', 'Hello')]),
      'POST /api/attachments?scope=private': () => ({ attachment: { id: 20, filename: 'shot.png', mime_type: 'image/png', size_bytes: 2048, url: '/api/attachments/20', preview_url: null } }),
    });
    renderConversation('private');
    const input = await screen.findByLabelText('Message');
    const clipboardData = () => ({ files: [new File(['png'], 'shot.png', { type: 'image/png' })], items: [] });

    const other = document.createElement('input');
    document.body.append(other);
    fireEvent.paste(other, { clipboardData: clipboardData() });
    expect(calls('POST', '/api/attachments?scope=private')).toHaveLength(0);
    other.remove();

    fireEvent.paste(screen.getByText('Hello'), { clipboardData: clipboardData() });
    expect(await screen.findByText('2.0 KB')).toBeVisible();
    expect(calls('POST', '/api/attachments?scope=private')).toHaveLength(1);
    expect(input).toHaveFocus();
  });

  it('shows interrupted replies honestly and resends the original request only on request', async () => {
    const user = userEvent.setup();
    const failed: Message = { ...message(5, 'assistant', 'Partial', 'interrupted'), metadata: { status: 'interrupted', error: 'Runtime restarted' } };
    serve({
      'GET /api/conversations/channel-3/messages?limit=100': () => page([message(4, 'user', 'Hi there', 'interrupted'), failed], { last_seq: 7 }),
      'POST /api/conversations/channel-3/messages': (body) => ({ message: message(6, 'user', String(body.content), 'queued'), job_id: 9 }),
    });
    renderConversation('channel-3');

    expect(await screen.findByText('Interrupted')).toBeVisible();
    expect(screen.getByText('Runtime restarted')).toBeVisible();
    expect(calls('POST', '/api/conversations/channel-3/messages')).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Computer' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send again' }));
    expect(calls('POST', '/api/conversations/channel-3/messages')).toEqual([{ content: 'Hi there', attachment_ids: [] }]);
  });

  it('offers View in computer on tool rows only where the computer exists', async () => {
    const user = userEvent.setup();
    const work = { v: 1, started_at: '2026-09-30T09:00:00Z', ended_at: '2026-09-30T09:00:05Z', truncated: false, items: [
      { type: 'tool', id: 't1', name: 'bash', args: { command: 'make' }, status: 'done', output: 'built', started_at: null, ended_at: null },
    ] };
    const reply = { ...message(2, 'assistant', 'Built.'), metadata: { status: 'completed' as const, work } };
    serve({ 'GET /api/conversations/channel-3/messages?limit=100': () => page([reply]) });
    renderConversation('channel-3');
    await user.click(await screen.findByRole('button', { name: 'Worked for 5s' }));
    expect(screen.getByText('make')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'View in computer' })).not.toBeInTheDocument();
  });

  it('stops the current run through the cancel API', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/conversations/private/messages?limit=100': () => page([message(1, 'user', 'Long job', 'running')]),
      'POST /api/conversations/private/cancel': () => ({ ok: true }),
    });
    renderConversation('private');
    await user.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(calls('POST', '/api/conversations/private/cancel')).toEqual([{}]);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('keeps channels read-only without the chat permission and names each author', async () => {
    const theirs = { ...message(1, 'user', 'Release is ready'), metadata: { status: 'completed' as const, author_user_id: 2, author_display_name: 'Alex' } };
    serve({ 'GET /api/conversations/channel-3/messages?limit=100': () => page([theirs]) });
    renderConversation('channel-3', { canSend: false, userId: 1 });
    expect(await screen.findByText('Alex')).toBeVisible();
    expect(screen.getByText('You can read this conversation but not post in it.')).toBeVisible();
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Conversation actions' })).not.toBeInTheDocument();
  });

  it('runs /compact from the composer and keeps compaction busy across later enqueues', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/conversations/private/messages?limit=100': () => page([message(1, 'user', 'Earlier work', 'running')]),
      'POST /api/conversations/private/compact': () => ({ ok: true, job_id: 20, status: 'queued' }),
      'POST /api/conversations/private/messages': () => ({ message: message(3, 'user', 'Later work', 'queued'), job_id: 21 }),
    });
    renderConversation('private');
    const input = await screen.findByLabelText('Message');
    await user.type(input, '/comp');
    expect(screen.getByRole('option', { name: /\/compact/ })).toBeVisible();
    await user.keyboard('{Enter}');
    expect(input).toHaveValue('');
    expect(calls('POST', '/api/conversations/private/compact')).toEqual([{}]);
    const status = screen.getByRole('status', { name: 'Context compaction' });
    expect(within(status).getByText(/Compaction queued/)).toBeVisible();
    expect(await actionDisabled(user, 'Compact context')).toBe(true);

    await user.type(input, 'Later work{Enter}');
    expect(await screen.findByText('Later work')).toBeVisible();
    FakeEventSource.instances[0].emit(1, { type: 'message', message: message(3, 'user', 'Later work', 'queued') });
    expect(within(status).getByText(/Compaction queued/)).toBeVisible();
    expect(calls('POST', '/api/conversations/private/messages')).toEqual([{ content: 'Later work', attachment_ids: [] }]);
  });

  it.each([
    ['done', undefined, /Context compacted/],
    ['nothing_to_compact', 'too_small', /Nothing to compact/],
    ['interrupted', undefined, /Compaction interrupted/],
    ['cancelled', undefined, /Compaction cancelled/],
  ] as const)('settles manual compaction as %s independently of automatic compaction', async (status, reason, label) => {
    const user = userEvent.setup();
    serve({
      'GET /api/conversations/private/messages?limit=100': () => page([message(1, 'assistant', 'Hello')]),
      'POST /api/conversations/private/compact': () => ({ ok: true, job_id: 20, status: 'queued' }),
    });
    renderConversation('private');
    await screen.findByText('Hello');
    await chooseAction(user, 'Compact context');
    const manual = () => screen.getByRole('status', { name: 'Context compaction' });
    const stream = FakeEventSource.instances[0];
    stream.emit(1, { type: 'compaction', phase: 'start', job_id: 20, status: 'compacting', after_message_id: 1 });
    expect(within(manual()).getByText('Compacting context')).toBeVisible();
    stream.emit(2, { type: 'compaction', phase: 'end', reason: 'auto' });
    expect(within(manual()).getByText('Compacting context')).toBeVisible();
    expect(await actionDisabled(user, 'Compact context')).toBe(true);
    stream.emit(3, { type: 'compaction', phase: 'end', job_id: 20, status, reason, after_message_id: 1 });
    expect(within(manual()).getByText(label)).toBeVisible();
    expect(await actionDisabled(user, 'Compact context')).toBe(false);
    stream.emit(4, { type: 'compaction', phase: 'start', job_id: 20, status: 'compacting', after_message_id: 1 });
    expect(within(manual()).getByText(label)).toBeVisible();
  });

  it('keeps a finished compaction where it happened instead of below later messages', async () => {
    serve({
      'GET /api/conversations/private/messages?limit=100': () => page(
        [message(1, 'user', 'First question'), message(2, 'assistant', 'First answer'), message(3, 'user', 'Second question'), message(4, 'assistant', 'Second answer')],
        { compaction: { job_id: 20, status: 'done', after_message_id: 2 } },
      ),
    });
    renderConversation('private');
    const before = await screen.findByText('First answer');
    const row = screen.getByRole('status', { name: 'Context compaction' });
    expect(before.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.compareDocumentPosition(screen.getByText('Second question')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([
    ['has no recorded place', [message(1, 'user', 'Question'), message(2, 'assistant', 'Answer')], { job_id: 20, status: 'done' }],
    ['followed history that was reset', [message(5, 'user', 'Question'), message(6, 'assistant', 'Answer')], { job_id: 20, status: 'done', after_message_id: 2 }],
  ] as const)('does not pin a finished compaction that %s to the thread', async (_case, messages, compaction) => {
    serve({ 'GET /api/conversations/private/messages?limit=100': () => page([...messages], { compaction }) });
    renderConversation('private');
    await screen.findByText('Answer');
    expect(screen.queryByRole('status', { name: 'Context compaction' })).not.toBeInTheDocument();
  });

  it('does not regress a finished operation when the enqueue acknowledgement arrives late', async () => {
    const user = userEvent.setup();
    let acknowledge!: (value: unknown) => void;
    serve({
      'GET /api/conversations/private/messages?limit=100': () => page([message(1, 'assistant', 'Hello')]),
      'POST /api/conversations/private/compact': () => new Promise((resolve) => { acknowledge = resolve; }),
    });
    renderConversation('private');
    await screen.findByText('Hello');
    await chooseAction(user, 'Compact context');
    FakeEventSource.instances[0].emit(1, { type: 'compaction', phase: 'end', job_id: 20, status: 'done', after_message_id: 1 });
    await act(async () => acknowledge({ ok: true, job_id: 20, status: 'queued' }));
    expect(within(screen.getByRole('status', { name: 'Context compaction' })).getByText(/Context compacted/)).toBeVisible();
    expect(await actionDisabled(user, 'Compact context')).toBe(false);
  });

  it.each([
    ['queued', /Compaction queued/, true],
    ['compacting', /Compacting context/, true],
    ['done', /Context compacted/, false],
    ['interrupted', /Compaction interrupted/, false],
  ] as const)('hydrates %s compaction after reload without creating a live reply', async (status, label, busy) => {
    const compaction = status === 'queued' ? { job_id: 20, status } : { job_id: 20, status, after_message_id: null };
    serve({ 'GET /api/conversations/private/messages?limit=100': () => page([], { last_seq: 15, compaction }) });
    renderConversation('private');
    const manual = await screen.findByRole('status', { name: 'Context compaction' });
    expect(within(manual).getByText(label)).toBeVisible();
    expect(screen.queryByRole('article', { name: 'Reply in progress' })).not.toBeInTheDocument();
    if (busy) expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
    else expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
  });

  it('resets a channel conversation only after confirmation and reloads its history', async () => {
    const user = userEvent.setup();
    let history = page([message(1, 'user', 'Old question'), message(2, 'assistant', 'Old answer')], { last_seq: 9 });
    serve({
      'GET /api/conversations/channel-3/messages?limit=100': () => history,
      'POST /api/conversations/channel-3/reset': () => {
        history = page([], { last_seq: 12 });
        return { ok: true };
      },
    });
    renderConversation('channel-3');
    await screen.findByText('Old answer');

    await chooseAction(user, 'Reset conversation…');
    expect(screen.getByText('Reset this conversation?')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls('POST', '/api/conversations/channel-3/reset')).toEqual([]);
    expect(screen.getByText('Old answer')).toBeVisible();

    await chooseAction(user, 'Reset conversation…');
    await user.click(screen.getByRole('button', { name: 'Reset conversation' }));
    expect(calls('POST', '/api/conversations/channel-3/reset')).toEqual([{}]);
    await waitFor(() => expect(screen.queryByText('Old answer')).not.toBeInTheDocument());
    await waitFor(() => expect(FakeEventSource.instances[FakeEventSource.instances.length - 1]?.url).toBe('/api/conversations/channel-3/events?after=12'));
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });

  it('acquires and releases browser takeover with one holder id, forwarding typed text while holding', async () => {
    const user = userEvent.setup();
    let lease: { holder_user_id: number; expires_at: string } | null = null;
    serve({
      'GET /api/conversations/private/messages?limit=100': () => page([]),
      'GET /api/workspace/files?path=': () => ({ files: [{ name: 'report.pdf', path: 'report.pdf', is_dir: false, size_bytes: 2048 }] }),
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

    const panel = await screen.findByRole('complementary', { name: 'Computer' });
    expect(await within(panel).findByRole('img', { name: 'Browser screen: Example login' })).toHaveAttribute('src', expect.stringContaining('/api/browser/screenshot?tab_id=tab-1'));
    expect(within(panel).getByText('Idle')).toBeVisible();
    // The workspace files sit behind a collapsed disclosure and are listed once it opens.
    expect(calls('GET', '/api/workspace/files?path=')).toEqual([]);
    await user.click(within(panel).getByRole('button', { name: 'Workspace files' }));
    expect(await within(panel).findByRole('link', { name: 'Download report.pdf' })).toHaveAttribute('href', '/api/workspace/download?path=report.pdf');

    await user.click(within(panel).getByRole('button', { name: 'Take control' }));
    const viewer = await screen.findByRole('dialog', { name: 'Example login' });
    const [acquired] = calls('POST', '/api/browser/lease') as { holder_id: string }[];
    expect(acquired.holder_id).toEqual(expect.any(String));

    await user.type(within(viewer).getByLabelText('Text to type'), 'alice');
    await user.click(within(viewer).getByRole('button', { name: 'Type' }));
    expect(calls('POST', '/api/browser/action')).toEqual([{ holder_id: acquired.holder_id, action: 'type', arguments: { tab_id: 'tab-1', text: 'alice', mode: 'keyboard' } }]);

    await user.click(within(viewer).getByRole('button', { name: 'Hand back to agent' }));
    await waitFor(() => expect(calls('DELETE', '/api/browser/lease')).toEqual([{ holder_id: acquired.holder_id }]));
    await user.keyboard('{Escape}');
    expect(await within(panel).findByRole('button', { name: 'Take control' })).toBeEnabled();
  });

  it('reports a competing takeover instead of pretending to hold the browser', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/conversations/private/messages?limit=100': () => page([]),
      'GET /api/workspace/files?path=': () => ({ files: [] }),
      'GET /api/browser': () => ({ tabs: [], lease: { holder_user_id: 2, expires_at: '2026-09-30T09:01:00Z' } }),
      'POST /api/browser/lease': () => {
        throw new Error('Browser is controlled by someone else');
      },
    });
    renderConversation('private');

    const panel = await screen.findByRole('complementary', { name: 'Computer' });
    expect(await within(panel).findByText('Someone else is in control')).toBeVisible();
    await user.click(within(panel).getByRole('button', { name: 'Take control' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent('Browser is controlled by someone else');
    expect(screen.queryByRole('button', { name: 'Hand back to agent' })).not.toBeInTheDocument();
  });
});
