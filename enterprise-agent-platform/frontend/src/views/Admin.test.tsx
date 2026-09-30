// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from '../api';
import { FieldworkProvider } from '../components/ui/fieldwork';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../i18n';
import { Admin } from './Admin';

vi.mock('../api', () => ({ request: vi.fn() }));

const policyPath = '/api/admin/users/7/chat-model-policy';
const responses: Record<string, unknown> = {
  '/api/me': { user: { id: 1, username: 'admin', display_name: 'Admin', role: 'admin', position: '', permission_group: 'admin', model_name: '', thinking_depth: 'medium', timezone: 'UTC', active: true } },
  '/api/admin/users': { users: [{ id: 7, username: 'ana', display_name: 'Ana', role: 'user', position: '', permission_group: 'member', model_name: '', thinking_depth: 'medium', timezone: 'UTC', active: true }] },
  '/api/admin/permission-groups': { groups: [{ name: 'member', permissions: ['chat'] }] },
  '/api/admin/models': { models: [{ id: 'gpt-a', name: 'GPT A' }, { id: 'gpt-b', name: 'GPT B' }], connected: true },
  // `retired` is no longer in the catalog but is still part of the saved policy.
  [policyPath]: { allowed_models: ['gpt-a', 'retired'], default_model_id: 'gpt-a' },
};

describe('Admin chat model policy', () => {
  beforeEach(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    vi.mocked(request).mockImplementation(async (path: string, options?: RequestInit) => {
      if (options?.method === 'PUT') return JSON.parse(String(options.body));
      if (path in responses) return responses[path];
      throw new Error(`unexpected request ${path}`);
    });
  });
  afterEach(() => {
    cleanup();
    vi.mocked(request).mockReset();
    window.localStorage.clear();
  });

  it('moves the default to an allowed model and keeps unavailable saved models when saving', async () => {
    render(<I18nProvider><FieldworkProvider mode="light"><Admin /></FieldworkProvider></I18nProvider>);

    fireEvent.click(await screen.findByRole('button', { name: 'Chat models' }));
    const panel = await screen.findByRole('dialog');
    const allowGptA = await within(panel).findByRole('checkbox', { name: 'GPT A' });
    expect(allowGptA).toBeChecked();
    expect(within(panel).getByRole('checkbox', { name: 'retired · unavailable' })).toBeChecked();

    fireEvent.click(within(panel).getByRole('checkbox', { name: 'GPT B' }));
    fireEvent.click(allowGptA);
    fireEvent.click(within(panel).getByRole('button', { name: 'Save chat models' }));

    await waitFor(() => expect(request).toHaveBeenCalledWith(policyPath, {
      method: 'PUT',
      body: JSON.stringify({ allowed_models: ['gpt-b', 'retired'], default_model_id: 'gpt-b' }),
    }));
  });
});
