// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShellContext } from '../components/ui/beautiful/controls';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../i18n';
import { Conversation, type ConversationProps } from './Conversation';
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

    history.splice(0, history.length, message(1, 'assistant', 'Earlier **answer**'), message(2, 'user', 'List the files'), message(3, 'assistant', 'Found two files: notes.md and report.pdf.'));
    stream.emit(49, { type: 'run_end', status: 'completed', text: 'Found two files: notes.md and report.pdf.', usage: {}, message: history[2] });

    expect(screen.queryByRole('article', { name: 'Reply in progress' })).not.toBeInTheDocument();
    expect(screen.getByText('Found two files: notes.md and report.pdf.')).toBeVisible();
    await waitFor(() => expect(screen.queryByText('Queued')).not.toBeInTheDocument());
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
