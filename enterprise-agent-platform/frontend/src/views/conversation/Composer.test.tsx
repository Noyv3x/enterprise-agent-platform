// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillView } from '../../api';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../../i18n';
import { Composer } from './Composer';

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../api', () => api);

const skill = (name: string, enabled = true): SkillView => ({
  key: `org:${name}`, name, description: `${name} description`, tier: 'org', version: null, source: null, enabled,
  user_disableable: true, manageable: false, updated_at: null, warnings: [],
});

describe('Composer `/` menu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    api.request.mockImplementation(async (path: string) => {
      if (path === '/api/skills?scope=channel-4') return { skills: [skill('arxiv'), skill('archive-notes', false), skill('plan')], can_install: false };
      throw new Error(`unexpected ${path}`);
    });
  });
  afterEach(cleanup);

  it('lists the scope’s enabled skills next to the commands and inserts `/name ` when one is picked', async () => {
    const run = vi.fn();
    const onSend = vi.fn(async () => {});
    render(<I18nProvider><Composer ensureScope={async () => 'channel-4'} onSend={onSend} skillScope="channel-4" placeholder="Write"
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
    render(<I18nProvider><Composer ensureScope={async () => 'channel-4'} onSend={vi.fn()} skillScope="channel-4" placeholder="Write"
      commands={[{ key: 'compact', name: '/compact', desc: 'Summarize older turns', run: vi.fn() }]} /></I18nProvider>);
    await waitFor(() => expect(api.request).toHaveBeenCalled());
    const input = screen.getByRole('combobox', { name: 'Message' });

    await userEvent.type(input, 'please /');
    expect(await screen.findByRole('option', { name: /\/compact/ })).toBeVisible();
    expect(screen.queryByRole('option', { name: /\/arxiv/ })).not.toBeInTheDocument();
  });
});
