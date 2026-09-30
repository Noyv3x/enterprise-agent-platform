// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldworkProvider } from '../components/ui/fieldwork';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../i18n';
import { Chat } from './Chat';
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
    if (method === 'GET' && /^\/api\/chat\/conversations\/[^/]+\/messages\?limit=100$/.test(path)) return { messages: [], next_before_id: null, last_seq: 0 };
    const route = routes[`${method} ${path}`];
    if (!route) throw new Error(`unexpected ${method} ${path}`);
    return route(options.body ? JSON.parse(String(options.body)) : {});
  });
}

function calls(method: string, path: string): unknown[] {
  return api.request.mock.calls
    .filter(([calledPath, options]) => calledPath === path && (options?.method ?? 'GET') === method)
    .map(([, options]) => (options?.body ? JSON.parse(String(options.body)) : undefined));
}

function conversation(id: string, title: string, model_id: string): ChatConversation {
  return { id, user_id: 1, title, model_id, created_at: '2026-09-30T09:00:00Z', updated_at: '2026-09-30T09:00:00Z', deleted_at: null };
}

function renderChat() {
  return render(<I18nProvider><FieldworkProvider mode="light" motion={false}><Chat /></FieldworkProvider></I18nProvider>);
}

describe('Chat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    FakeEventSource.urls = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('creates a chat on the default model and opens its conversation', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/chat/conversations': () => ({ conversations: [] }),
      'GET /api/chat/models': () => ({ allowed_models: ['gpt-small', 'gpt-large'], default_model_id: 'gpt-large' }),
      'POST /api/chat/conversations': (body) => ({ conversation: conversation('c-new', '', String(body.model_id)) }),
    });
    renderChat();

    expect(await screen.findByText('Start a chat')).toBeVisible();
    await user.click(screen.getAllByRole('button', { name: 'New chat' })[0]);

    expect(calls('POST', '/api/chat/conversations')).toEqual([{ model_id: 'gpt-large' }]);
    expect(await screen.findByRole('heading', { name: 'New chat' })).toBeVisible();
    await waitFor(() => expect(FakeEventSource.urls).toEqual(['/api/chat/conversations/c-new/events?after=0']));
    expect(screen.getByRole('combobox')).toHaveValue('gpt-large');
    expect(screen.queryByRole('button', { name: 'Computer' })).not.toBeInTheDocument();
  });

  it('offers only allowed models and flags a model the policy no longer allows', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/chat/conversations': () => ({ conversations: [conversation('c-1', 'Trip plan', 'gpt-retired')] }),
      'GET /api/chat/models': () => ({ allowed_models: ['gpt-small', 'gpt-large'], default_model_id: 'gpt-small' }),
      'PATCH /api/chat/conversations/c-1': (body) => ({ conversation: conversation('c-1', 'Trip plan', String(body.model_id)) }),
    });
    renderChat();

    const picker = await screen.findByRole('combobox');
    const options = Array.from(picker.querySelectorAll('option')).map((option) => [option.value, option.disabled]);
    expect(options).toEqual([['gpt-retired', true], ['gpt-small', false], ['gpt-large', false]]);
    expect(screen.getByText('Pick an allowed model to continue')).toBeVisible();

    await user.selectOptions(picker, 'gpt-small');
    expect(calls('PATCH', '/api/chat/conversations/c-1')).toEqual([{ model_id: 'gpt-small' }]);
    await waitFor(() => expect(screen.queryByText('Pick an allowed model to continue')).not.toBeInTheDocument());
    expect(picker).toHaveValue('gpt-small');
  });

  it('deletes a chat only after confirmation', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/chat/conversations': () => ({ conversations: [conversation('c-1', 'Trip plan', 'gpt-small'), conversation('c-2', 'Budget', 'gpt-small')] }),
      'GET /api/chat/models': () => ({ allowed_models: ['gpt-small'], default_model_id: 'gpt-small' }),
      'DELETE /api/chat/conversations/c-1': () => ({ ok: true }),
    });
    renderChat();

    await user.click(await screen.findByRole('button', { name: 'Delete Trip plan' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls('DELETE', '/api/chat/conversations/c-1')).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Delete Trip plan' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(calls('DELETE', '/api/chat/conversations/c-1')).toEqual([undefined]);
    await waitFor(() => expect(screen.queryByRole('button', { name: /Trip plan/ })).not.toBeInTheDocument());
    expect(await screen.findByRole('heading', { name: 'Budget' })).toBeVisible();
  });

  it('blocks new chats when the policy allows no model', async () => {
    serve({
      'GET /api/chat/conversations': () => ({ conversations: [] }),
      'GET /api/chat/models': () => ({ allowed_models: [], default_model_id: '' }),
    });
    renderChat();

    expect(await screen.findByText('No chat models available')).toBeVisible();
    for (const button of screen.getAllByRole('button', { name: 'New chat' })) expect(button).toBeDisabled();
  });
});
