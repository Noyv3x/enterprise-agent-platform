// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../api';
import { FieldworkProvider } from '../components/ui/fieldwork';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../i18n';
import { Settings } from './Settings';

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../api', () => api);

const alice: User = {
  id: 7,
  username: 'alice',
  display_name: 'Alice',
  role: 'user',
  position: 'Engineer',
  permission_group: 'member',
  model_name: 'gpt-5',
  thinking_depth: 'medium',
  timezone: 'UTC',
  active: true,
};

function renderSettings(onSaved = vi.fn()) {
  render(<I18nProvider><FieldworkProvider mode="light" motion={false}><Settings user={alice} onSaved={onSaved} /></FieldworkProvider></I18nProvider>);
  return onSaved;
}

describe('Settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
  });
  afterEach(cleanup);

  it('saves only a changed profile and hands the returned user to the shell', async () => {
    const user = userEvent.setup();
    const saved = { ...alice, display_name: 'Alice Chen' };
    api.request.mockResolvedValue({ user: saved });
    const onSaved = renderSettings();

    const save = screen.getByRole('button', { name: 'Save profile' });
    expect(save).toBeDisabled();
    const name = screen.getByLabelText('Display name');
    await user.clear(name);
    await user.type(name, '  Alice Chen ');
    await user.click(save);

    expect(await screen.findByText('Profile saved')).toBeVisible();
    expect(api.request).toHaveBeenCalledWith('/api/me', { method: 'PATCH', body: JSON.stringify({ display_name: 'Alice Chen', timezone: 'UTC' }) });
    expect(onSaved).toHaveBeenCalledWith(saved);
  });

  it('requires the current password, blocks mismatches, and clears credentials after a change', async () => {
    const user = userEvent.setup();
    api.request.mockResolvedValue({ user: alice });
    renderSettings();

    const change = screen.getByRole('button', { name: 'Change password' });
    await user.type(screen.getByLabelText('New password'), 'correct horse');
    await user.type(screen.getByLabelText('Confirm new password'), 'correct hose');
    expect(screen.getByText('The passwords do not match')).toBeVisible();
    expect(change).toBeDisabled();

    await user.clear(screen.getByLabelText('Confirm new password'));
    await user.type(screen.getByLabelText('Confirm new password'), 'correct horse');
    expect(change).toBeDisabled();
    expect(api.request).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Current password'), 'old secret');
    await user.click(change);

    expect(await screen.findByText('Password changed')).toBeVisible();
    expect(api.request).toHaveBeenCalledWith('/api/me', { method: 'PATCH', body: JSON.stringify({ password: 'correct horse', current_password: 'old secret' }) });
    expect(screen.getByLabelText('Current password')).toHaveValue('');
    expect(screen.getByLabelText('New password')).toHaveValue('');
    expect(screen.getByLabelText('Confirm new password')).toHaveValue('');
  });

  it('shows the server reason when a password is rejected', async () => {
    const user = userEvent.setup();
    api.request.mockRejectedValue(new Error('password must contain at least 8 characters'));
    renderSettings();

    await user.type(screen.getByLabelText('Current password'), 'old secret');
    await user.type(screen.getByLabelText('New password'), 'short');
    await user.type(screen.getByLabelText('Confirm new password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByText('password must contain at least 8 characters')).toBeVisible();
    expect(screen.getByLabelText('New password')).toHaveValue('short');
  });
});
