// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../i18n';
import { Channels, type Channel } from './Channels';

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../api', () => api);

const general: Channel = { id: 1, name: 'general', description: 'Everyone', archived: false };
const ops: Channel = { id: 2, name: 'ops', description: '', archived: false };

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
    api.request.mockImplementation(async (_path: string, options: RequestInit) => ({ channel: { ...ops, ...JSON.parse(String(options.body)) } }));
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
    api.request.mockResolvedValue({ ok: true });
    const { onChange } = renderChannels({ admin: true });

    await user.click(screen.getByRole('button', { name: 'Edit general' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'general' })).getByRole('button', { name: 'Archive' }));
    expect(api.request).not.toHaveBeenCalled();
    await user.click(within(await screen.findByRole('alertdialog', { name: 'Archive #general?' })).getByRole('button', { name: 'Archive' }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith([ops]));
    expect(api.request).toHaveBeenCalledWith('/api/channels/1', { method: 'DELETE' });
  });
});
