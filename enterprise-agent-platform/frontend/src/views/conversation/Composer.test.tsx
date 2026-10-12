// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type McpPrompt, type SkillView } from '../../api';
import type * as ApiModule from '../../api';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../../i18n';
import { Composer } from './Composer';

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../api', async (importOriginal) => ({ ...(await importOriginal<typeof ApiModule>()), request: api.request }));

const skill = (name: string, enabled = true): SkillView => ({
  key: `org:${name}`, name, description: `${name} description`, tier: 'org', version: null, source: null, enabled,
  user_disableable: true, manageable: false, updated_at: null, warnings: [],
});

const prompts: McpPrompt[] = [
  {
    connector: 'notion', connector_label: 'Notion', name: 'summarize', title: 'Summarize a page', description: 'Summarize one page',
    arguments: [{ name: 'page', description: 'Page title', required: true }, { name: 'tone', description: null, required: false }],
  },
  { connector: 'notion', connector_label: 'Notion', name: 'weekly', title: null, description: 'Weekly report', arguments: [] },
];

describe('Composer `/` menu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    api.request.mockImplementation(async (path: string, options: RequestInit = {}) => {
      if (path === '/api/skills?scope=channel-4') return { skills: [skill('arxiv'), skill('archive-notes', false), skill('plan')], can_install: false };
      if (path === '/api/mcp/prompts?scope=channel-4') return { prompts, connectors: [{ name: 'notion', label: 'Notion' }] };
      if (path === '/api/mcp/prompts/render' && options.method === 'POST') {
        const body = JSON.parse(String(options.body)) as { name: string; arguments: Record<string, string> };
        return { text: body.name === 'summarize' ? `Summarize the page ${body.arguments.page} in ${body.arguments.tone ?? 'a neutral'} tone.` : 'Write the weekly report.' };
      }
      throw new Error(`unexpected ${path}`);
    });
  });
  afterEach(cleanup);

  it('lists the scope’s enabled skills next to the commands and inserts `/name ` when one is picked', async () => {
    const run = vi.fn();
    const onSend = vi.fn(async () => {});
    render(<I18nProvider><Composer ensureScope={async () => 'channel-4'} onSend={onSend} catalogScope="channel-4" placeholder="Write"
      commands={[{ key: 'compact', name: '/compact', desc: 'Summarize older turns', run }]} /></I18nProvider>);
    await waitFor(() => expect(api.request).toHaveBeenCalledWith('/api/skills?scope=channel-4'));
    const input = screen.getByRole('combobox', { name: 'Message' });

    await userEvent.type(input, '/');
    expect(await screen.findByRole('option', { name: /\/arxiv/ })).toBeVisible();
    expect(screen.getByRole('option', { name: /\/compact/ })).toBeVisible();
    expect(screen.queryByRole('option', { name: /archive-notes/ })).not.toBeInTheDocument();

    await userEvent.type(input, 'ar');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await userEvent.click(screen.getByRole('option', { name: /\/arxiv/ }));
    expect(input).toHaveValue('/arxiv ');
    expect(run).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await userEvent.type(input, 'find papers{Enter}');
    expect(onSend).toHaveBeenCalledWith('/arxiv find papers', [], undefined);
  });

  it('offers skills only at the start of the message, where Platform reads them', async () => {
    render(<I18nProvider><Composer ensureScope={async () => 'channel-4'} onSend={vi.fn()} catalogScope="channel-4" placeholder="Write"
      commands={[{ key: 'compact', name: '/compact', desc: 'Summarize older turns', run: vi.fn() }]} /></I18nProvider>);
    await waitFor(() => expect(api.request).toHaveBeenCalled());
    const input = screen.getByRole('combobox', { name: 'Message' });

    await userEvent.type(input, 'please /');
    expect(await screen.findByRole('option', { name: /\/compact/ })).toBeVisible();
    expect(screen.queryByRole('option', { name: /\/arxiv/ })).not.toBeInTheDocument();
  });

  it('lists MCP prompts as `/<connector>:<prompt>`, asks for their arguments and inserts the rendered text', async () => {
    const onSend = vi.fn(async () => {});
    render(<I18nProvider><Composer ensureScope={async () => 'channel-4'} onSend={onSend} catalogScope="channel-4" placeholder="Write" /></I18nProvider>);
    await waitFor(() => expect(api.request).toHaveBeenCalledWith('/api/mcp/prompts?scope=channel-4'));
    const input = screen.getByRole('combobox', { name: 'Message' });

    await userEvent.type(input, 'Context first /notion:');
    const option = await screen.findByRole('option', { name: /\/notion:summarize/ });
    expect(option).toHaveTextContent('Summarize one page');
    expect(option).toHaveTextContent('Notion');
    expect(screen.getByRole('option', { name: /\/notion:weekly/ })).toBeVisible();
    await userEvent.type(input, 'sum');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await userEvent.click(screen.getByRole('option', { name: /\/notion:summarize/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Summarize a page' });
    const page = within(dialog).getByLabelText(/^page/);
    expect(page).toHaveFocus();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Insert' }));
    expect(within(dialog).getByText('Required')).toBeVisible();
    expect(api.request).not.toHaveBeenCalledWith('/api/mcp/prompts/render', expect.anything());

    await userEvent.type(page, 'Roadmap{Enter}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const [, request] = api.request.mock.calls.find(([path]) => path === '/api/mcp/prompts/render')!;
    // An empty optional argument is left out for the server's default.
    expect(JSON.parse(String(request.body))).toEqual({ scope: 'channel-4', connector: 'notion', name: 'summarize', arguments: { page: 'Roadmap' } });
    expect(input).toHaveValue('Context first\n\nSummarize the page Roadmap in a neutral tone.');
    expect(input).toHaveFocus();
    expect(onSend).not.toHaveBeenCalled();

    // A prompt without arguments inserts at once.
    await userEvent.clear(input);
    await userEvent.type(input, '/notion:wee');
    await userEvent.click(await screen.findByRole('option', { name: /\/notion:weekly/ }));
    await waitFor(() => expect(input).toHaveValue('Write the weekly report.'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('says to reconnect when the connector refuses its sign-in or keys while rendering a prompt', async () => {
    render(<I18nProvider><Composer ensureScope={async () => 'channel-4'} onSend={vi.fn()} catalogScope="channel-4" placeholder="Write" /></I18nProvider>);
    await waitFor(() => expect(api.request).toHaveBeenCalledWith('/api/mcp/prompts?scope=channel-4'));
    const fallback = api.request.getMockImplementation()!;
    api.request.mockImplementation(async (path: string, options: RequestInit = {}) => {
      if (path !== '/api/mcp/prompts/render') return fallback(path, options);
      const { name } = JSON.parse(String(options.body)) as { name: string };
      throw name === 'weekly'
        ? new ApiError('Authorization is required', 409, 'needs_auth')
        : new ApiError('The server rejected the credentials', 409, 'credentials_rejected');
    });
    const input = screen.getByRole('combobox', { name: 'Message' });

    await userEvent.type(input, '/notion:wee');
    await userEvent.click(await screen.findByRole('option', { name: /\/notion:weekly/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Notion needs to be connected again. Reconnect it in Settings → Connectors, then try again.');
    expect(input).toHaveValue('');

    await userEvent.type(input, '/notion:sum');
    await userEvent.click(await screen.findByRole('option', { name: /\/notion:summarize/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Summarize a page' });
    await userEvent.type(within(dialog).getByLabelText(/^page/), 'Roadmap{Enter}');
    expect(await within(dialog).findByText('Notion rejected its keys. Update them in Settings → Connectors, then try again.')).toBeVisible();
    expect(input).toHaveValue('');
  });
});
