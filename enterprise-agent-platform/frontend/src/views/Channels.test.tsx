// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../i18n';
import type { McpChannelConnector } from '../api';
import { Channels, type Channel } from './Channels';

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../api', () => api);

const general: Channel = { id: 1, name: 'general', description: 'Everyone', archived: false };
const ops: Channel = { id: 2, name: 'ops', description: '', archived: false };

// The reduced view Platform gives channel managers: the URL origin only, no secrets, groups or errors.
const connector = (id: number, name: string, label: string): McpChannelConnector => ({
  id, scope: 'org', name, label, transport: 'http', auth: 'oauth', enabled: true, status: 'connected', origin: `https://${name}.example`,
});
const shared = [connector(7, 'notion', 'Notion'), connector(8, 'jira', 'Jira')];

/** Channel connectors are read whenever a manager opens a channel; `other` answers everything else. */
function serve(other: (path: string, options: RequestInit) => unknown = () => ({ ok: true })) {
  let enabled = [7];
  api.request.mockImplementation(async (path: string, options: RequestInit = {}) => {
    if (/^\/api\/channels\/\d+\/mcp$/.test(path)) {
      if (options.method === 'PUT') enabled = JSON.parse(String(options.body)).connector_ids;
      return { connectors: shared, connector_ids: enabled };
    }
    return other(path, options);
  });
}
const mutations = () => api.request.mock.calls.filter(([, options]) => options?.method && options.method !== 'GET');

function renderChannels(props: { admin?: boolean; permissions?: string[] } = {}) {
  const onChange = vi.fn();
  const onOpen = vi.fn();
  render(<I18nProvider><Channels channels={[general, ops]} onChange={onChange} onOpen={onOpen} admin={props.admin ?? false} permissions={props.permissions ?? ['read_workspace']} /></I18nProvider>);
  return { onChange, onOpen };
}

describe('Channels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
  });
  afterEach(cleanup);

  it('lets readers open channels but not manage them', async () => {
    const user = userEvent.setup();
    const { onOpen } = renderChannels();

    expect(screen.queryByRole('button', { name: 'New channel' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open ops' }));
    expect(onOpen).toHaveBeenCalledWith('channel-2');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renames a channel and rejects a duplicate name', async () => {
    const user = userEvent.setup();
    serve((_path, options) => ({ channel: { ...ops, ...JSON.parse(String(options.body)) } }));
    const { onChange } = renderChannels({ permissions: ['read_workspace', 'manage_channels'] });

    await user.click(screen.getByRole('button', { name: 'Edit ops' }));
    const sheet = await screen.findByRole('dialog', { name: 'ops' });
    const name = within(sheet).getByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.type(name, 'general');
    expect(within(sheet).getByText('A channel with this name already exists.')).toBeVisible();
    expect(within(sheet).getByRole('button', { name: 'Save' })).toBeDisabled();

    await user.clear(name);
    await user.type(name, 'operations');
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith([general, { ...ops, name: 'operations', description: '' }]));
    expect(api.request).toHaveBeenCalledWith('/api/channels/2', { method: 'PATCH', body: JSON.stringify({ name: 'operations', description: '' }) });
  });

  it('archives only after confirmation', async () => {
    const user = userEvent.setup();
    serve();
    const { onChange } = renderChannels({ admin: true });

    await user.click(screen.getByRole('button', { name: 'Edit general' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'general' })).getByRole('button', { name: 'Archive' }));
    expect(mutations()).toEqual([]);
    await user.click(within(await screen.findByRole('alertdialog', { name: 'Archive #general?' })).getByRole('button', { name: 'Archive' }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith([ops]));
    expect(api.request).toHaveBeenCalledWith('/api/channels/1', { method: 'DELETE' });
  });

  it('lets a channel manager switch shared organization connectors on for the channel', async () => {
    const user = userEvent.setup();
    serve();
    renderChannels({ permissions: ['read_workspace', 'manage_channels'] });

    await user.click(screen.getByRole('button', { name: 'Edit ops' }));
    const sheet = await screen.findByRole('dialog', { name: 'ops' });
    const section = await within(sheet).findByRole('region', { name: 'Connectors' });
    expect(await within(section).findByRole('switch', { name: 'Use Notion in this channel' })).toHaveAttribute('aria-checked', 'true');
    const jira = within(section).getByRole('switch', { name: 'Use Jira in this channel' });
    expect(jira).toHaveAttribute('aria-checked', 'false');
    expect(within(section).getByText('https://notion.example')).toBeVisible();

    await user.click(jira);
    await waitFor(() => expect(within(section).getByRole('switch', { name: 'Use Jira in this channel' })).toHaveAttribute('aria-checked', 'true'));
    expect(api.request).toHaveBeenCalledWith('/api/channels/2/mcp', { method: 'PUT', body: JSON.stringify({ connector_ids: [7, 8] }) });

    await user.click(within(section).getByRole('switch', { name: 'Use Notion in this channel' }));
    await waitFor(() => expect(api.request).toHaveBeenCalledWith('/api/channels/2/mcp', { method: 'PUT', body: JSON.stringify({ connector_ids: [8] }) }));
  });
});
