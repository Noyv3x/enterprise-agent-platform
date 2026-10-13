// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../api';
import { ThemeProvider } from '../context/ThemeContext';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../i18n';
import { accessFor } from '../shell/routes';
import { Sidebar } from '../shell/Sidebar';
import { Chat } from './Chat';
import { resetChatStore } from './chat/chatStore';
import type { ChatConversation } from './conversation/types';

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../api', () => api);

class FakeEventSource extends EventTarget {
  static urls: string[] = [];
  static instances: FakeEventSource[] = [];
  constructor(public url: string) {
    super();
    FakeEventSource.urls.push(url);
    FakeEventSource.instances.push(this);
  }
  close() {}
  emit(seq: number, event: Record<string, unknown> & { type: string }) {
    act(() => {
      this.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify({ seq, ...event }), lastEventId: String(seq) }));
    });
  }
}

type Route = (body: Record<string, unknown>) => unknown;

function serve(routes: Record<string, Route>) {
  api.request.mockImplementation(async (path: string, options: RequestInit = {}) => {
    const method = options.method ?? 'GET';
    if (method === 'GET' && /^\/api\/chat\/conversations\/[^/]+\/messages\?limit=100$/.test(path)) return { messages: [], next_before_id: null, last_seq: 0, compaction: null };
    const route = routes[`${method} ${path}`];
    if (!route) throw new Error(`unexpected ${method} ${path}`);
    return route(typeof options.body === 'string' ? JSON.parse(options.body) : {});
  });
}

function calls(method: string, path: string): unknown[] {
  return api.request.mock.calls
    .filter(([calledPath, options]) => calledPath === path && (options?.method ?? 'GET') === method)
    .map(([, options]) => (typeof options?.body === 'string' ? JSON.parse(options.body) : undefined));
}

function conversation(id: string, title: string): ChatConversation {
  return { id, user_id: 1, title, created_at: '2026-09-30T09:00:00Z', updated_at: '2026-09-30T09:00:00Z', deleted_at: null };
}

function renderChat(id?: string) {
  return render(<I18nProvider><Chat id={id} userName="Ada" /></I18nProvider>);
}

const owner: User = { id: 1, username: 'ada', display_name: 'Ada', role: 'user', position: '', permission_group: '', thinking_depth: '', timezone: 'UTC', active: true };

/** The open chat beside the app sidebar, as the shell shows them. */
function renderChatWithSidebar(id: string) {
  return render(
    <I18nProvider>
      <ThemeProvider>
        <Sidebar user={owner} channels={[]} access={accessFor('user', ['chat'])} route={{ view: 'chat', id }} navigate={vi.fn()} onSignOut={vi.fn()} collapsed={false} onCollapsedChange={vi.fn()} />
        <main><Chat id={id} userName="Ada" /></main>
      </ThemeProvider>
    </I18nProvider>,
  );
}

describe('Chat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChatStore();
    FakeEventSource.urls = [];
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    window.location.hash = '';
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('creates the conversation on the first send, posts the message, then opens it, with no model to pick or show', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/chat/conversations': () => ({ conversations: [] }),
      'POST /api/chat/conversations': () => ({ conversation: conversation('c-new', '') }),
      'POST /api/chat/conversations/c-new/messages': (body) => ({ message: { id: 1, role: 'user', content: body.content, metadata: { status: 'queued' }, created_at: '2026-09-30T09:00:00Z', attachments: [] }, job_id: 3 }),
    });
    renderChat();

    expect(await screen.findByText('Hello Ada')).toBeVisible();
    expect(calls('POST', '/api/chat/conversations')).toEqual([]);
    expect(screen.queryByRole('button', { name: /^Model/ })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Message'), 'Plan a trip{Enter}');

    await waitFor(() => expect(window.location.hash).toBe('#chat-c-new'));
    expect(calls('POST', '/api/chat/conversations')).toEqual([{ title: 'New chat' }]);
    expect(calls('POST', '/api/chat/conversations/c-new/messages')).toEqual([{ content: 'Plan a trip', attachment_ids: [] }]);
  });

  it('renames through the header menu', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/chat/conversations': () => ({ conversations: [conversation('c-1', 'Trip plan')] }),
      'PATCH /api/chat/conversations/c-1': (body) => ({ conversation: conversation('c-1', String(body.title)) }),
    });
    renderChat('c-1');

    await screen.findByRole('heading', { name: 'Trip plan' });
    await user.click(screen.getByRole('button', { name: 'Conversation actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename…' }));
    const field = screen.getByLabelText('Chat name');
    await user.clear(field);
    await user.type(field, 'Kyoto trip{Enter}');
    expect(calls('PATCH', '/api/chat/conversations/c-1')).toEqual([{ title: 'Kyoto trip' }]);
    expect(await screen.findByRole('heading', { name: 'Kyoto trip' })).toBeVisible();
  });

  it('deletes only after confirmation, then returns to a new chat', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/chat/conversations': () => ({ conversations: [conversation('c-1', 'Trip plan')] }),
      'DELETE /api/chat/conversations/c-1': () => ({ ok: true }),
    });
    renderChat('c-1');
    await screen.findByRole('heading', { name: 'Trip plan' });

    await user.click(screen.getByRole('button', { name: 'Conversation actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete chat…' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls('DELETE', '/api/chat/conversations/c-1')).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Conversation actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete chat…' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(calls('DELETE', '/api/chat/conversations/c-1')).toEqual([undefined]);
    await waitFor(() => expect(window.location.hash).toBe('#chat'));
  });

  it('names the blank, loading and missing chat Plain chat in every locale, while an open chat keeps its title', async () => {
    const names = { en: ['Plain chat', 'New chat'], 'zh-CN': ['纯聊天模式', '新聊天'], 'zh-TW': ['純聊天模式', '新聊天'] };
    // The app's TypeScript lib predates Promise.withResolvers.
    let release: (value: unknown) => void = () => undefined;
    for (const [locale, [name, newChat]] of Object.entries(names)) {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
      resetChatStore();
      api.request.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
      renderChat('gone');
      expect(screen.getByRole('heading', { name })).toBeVisible();
      await act(async () => release({ conversations: [conversation('c-1', 'Trip plan')] }));
      // The missing chat offers a new one under the same mode heading.
      expect(await screen.findByRole('button', { name: newChat })).toBeVisible();
      expect(screen.getByRole('heading', { name })).toBeVisible();
      cleanup();
      renderChat();
      expect(screen.getByRole('heading', { name })).toBeVisible();
      cleanup();
    }
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'zh-CN');
    serve({ 'GET /api/chat/conversations': () => ({ conversations: [conversation('c-1', 'Trip plan')] }) });
    renderChat('c-1');
    expect(await screen.findByRole('heading', { name: 'Trip plan' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: '纯聊天模式' })).not.toBeInTheDocument();
    // An empty plain chat asks like a new one, not with the channel's "answers everyone here".
    expect(screen.getByText('想问点什么？')).toBeVisible();
    expect(screen.queryByText('开始对话，智能体会回复这里的每个人')).not.toBeInTheDocument();
  });

  it('shows a generated title in the header and the sidebar as soon as the stream delivers it', async () => {
    serve({ 'GET /api/chat/conversations': () => ({ conversations: [conversation('c-1', 'New chat'), conversation('c-2', 'Older chat')] }) });
    renderChatWithSidebar('c-1');
    const nav = screen.getByRole('complementary', { name: 'Workspace navigation' });
    await screen.findByRole('heading', { name: 'New chat' });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(FakeEventSource.instances[0].url).toBe('/api/chat/conversations/c-1/events?after=0');
    // Opening the chat re-reads the list once (titles generated while it was closed); let that settle first.
    await waitFor(() => expect(calls('GET', '/api/chat/conversations')).toHaveLength(2));

    FakeEventSource.instances[0].emit(1, { type: 'conversation_title', id: 'c-1', title: 'Kyoto itinerary' });
    expect(screen.getByRole('heading', { name: 'Kyoto itinerary' })).toBeVisible();
    expect(within(nav).getByRole('button', { name: 'Kyoto itinerary' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).queryByRole('button', { name: 'New chat', current: 'page' })).not.toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'Older chat' })).toBeVisible();
    // Only the list changed: no request re-read it.
    expect(calls('GET', '/api/chat/conversations')).toHaveLength(2);
  });

  it('keeps the user’s rename when a generated title arrives after it', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/chat/conversations': () => ({ conversations: [conversation('c-1', 'New chat')] }),
      'PATCH /api/chat/conversations/c-1': (body) => ({ conversation: conversation('c-1', String(body.title)) }),
    });
    renderChat('c-1');
    await screen.findByRole('heading', { name: 'New chat' });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Conversation actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename…' }));
    const field = screen.getByLabelText('Chat name');
    await user.clear(field);
    await user.type(field, 'My trip{Enter}');
    await screen.findByRole('heading', { name: 'My trip' });

    FakeEventSource.instances[0].emit(1, { type: 'conversation_title', id: 'c-1', title: 'Kyoto itinerary' });
    expect(screen.getByRole('heading', { name: 'My trip' })).toBeVisible();
  });

  it('still takes a generated title after a rename Platform refused', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/chat/conversations': () => ({ conversations: [conversation('c-1', 'New chat')] }),
      'PATCH /api/chat/conversations/c-1': () => { throw new Error('The chat is busy'); },
    });
    renderChat('c-1');
    await screen.findByRole('heading', { name: 'New chat' });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Conversation actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename…' }));
    const field = screen.getByLabelText('Chat name');
    await user.clear(field);
    await user.type(field, 'My trip{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('The chat is busy');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    FakeEventSource.instances[0].emit(1, { type: 'conversation_title', id: 'c-1', title: 'Kyoto itinerary' });
    expect(await screen.findByRole('heading', { name: 'Kyoto itinerary' })).toBeVisible();
  });

  it('picks up a title generated while the chat was closed when it opens', async () => {
    let reads = 0;
    serve({ 'GET /api/chat/conversations': () => ({ conversations: [conversation('c-1', ++reads === 1 ? 'New chat' : 'Kyoto itinerary')] }) });
    renderChat('c-1');
    expect(await screen.findByRole('heading', { name: 'Kyoto itinerary' })).toBeVisible();
  });

  it('never lets an older list response undo a title that arrived after it was requested', async () => {
    // The app's TypeScript lib predates Promise.withResolvers.
    let release: (value: unknown) => void = () => undefined;
    let reads = 0;
    api.request.mockImplementation((path: string) => {
      if (path !== '/api/chat/conversations') return Promise.resolve({ messages: [], next_before_id: null, last_seq: 0, compaction: null });
      if (++reads === 1) return Promise.resolve({ conversations: [conversation('c-1', 'New chat')] });
      return new Promise((resolve) => { release = resolve; });
    });
    renderChat('c-1');
    await screen.findByRole('heading', { name: 'New chat' });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await waitFor(() => expect(reads).toBe(2));

    FakeEventSource.instances[0].emit(1, { type: 'conversation_title', id: 'c-1', title: 'Kyoto itinerary' });
    await act(async () => release({ conversations: [conversation('c-1', 'New chat')] }));
    expect(screen.getByRole('heading', { name: 'Kyoto itinerary' })).toBeVisible();
  });
});
