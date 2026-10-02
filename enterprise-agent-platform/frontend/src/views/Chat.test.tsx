// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../i18n';
import { Chat } from './Chat';
import { resetChatStore } from './chat/chatStore';
import type { ChatConversation } from './conversation/types';

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../api', () => api);

class FakeEventSource extends EventTarget {
  static urls: string[] = [];
  constructor(public url: string) {
    super();
    FakeEventSource.urls.push(url);
  }
  close() {}
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

describe('Chat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChatStore();
    FakeEventSource.urls = [];
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
});
