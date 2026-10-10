// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../i18n';
import { Admin } from './Admin';

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../api', () => api);
// Liveline draws on a canvas jsdom does not have.
vi.mock('liveline', () => ({ Liveline: () => null }));

const user = (id: number, username: string, extra: Record<string, unknown> = {}) => ({
  id, username, display_name: username.toUpperCase(), role: 'user', position: '', permission_group: 'member',
  model_policy: 'default', timezone: 'UTC', active: true, ...extra,
});
const me = user(1, 'admin', { role: 'admin', permission_group: 'admin' });
const ana = user(7, 'ana');
const ben = user(8, 'ben', { permission_group: 'viewer', model_policy: 'light', active: false });

const slots = (model: string, thinking: string) => ({
  personal: { model, thinking }, channel: { model, thinking }, chat: { model, thinking }, scout: { model, thinking }, worker: { model, thinking },
});
const policies = [
  { name: 'default', label: 'Default', slots: { ...slots('gpt-a', 'medium'), scout: { model: 'retired', thinking: 'low' } } },
  { name: 'light', label: 'Light', slots: slots('', 'off') },
  { name: 'spare', label: 'Spare', slots: slots('', 'medium') },
];

type Route = (body: Record<string, unknown>) => unknown;
let routes: Record<string, Route> = {};

function serve(extra: Record<string, Route> = {}) {
  routes = {
    'GET /api/me': () => ({ user: me }),
    'GET /api/admin/users': () => ({ users: [me, ana, ben] }),
    'GET /api/admin/permission-groups': () => ({ groups: [{ name: 'admin', permissions: ['chat', 'manage_users'] }, { name: 'member', permissions: ['chat'] }, { name: 'viewer', permissions: [] }, { name: 'unused', permissions: ['chat'] }] }),
    'GET /api/admin/models': () => ({ models: [{ id: 'gpt-a', name: 'GPT A' }, { id: 'gpt-b', name: 'GPT B' }], connected: true }),
    'GET /api/admin/model-policies': () => ({ policies, members: { default: 2, light: 1 } }),
    ...extra,
  };
  api.request.mockImplementation(async (path: string, options: RequestInit = {}) => {
    const route = routes[`${options.method ?? 'GET'} ${path}`];
    if (!route) throw new Error(`unexpected ${options.method ?? 'GET'} ${path}`);
    return route(options.body ? JSON.parse(String(options.body)) : {});
  });
}

function sent(method: string, path: string): unknown {
  const call = api.request.mock.calls.find(([calledPath, options]) => calledPath === path && options?.method === method);
  return call ? JSON.parse(String(call[1].body)) : undefined;
}

function renderAdmin(hash = '#admin') {
  window.location.hash = hash;
  return render(<I18nProvider><Admin /></I18nProvider>);
}

describe('Admin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
    window.localStorage.clear();
    window.location.hash = '';
  });

  it('searches and filters accounts', async () => {
    const actor = userEvent.setup();
    serve();
    renderAdmin();

    expect(await screen.findByRole('button', { name: 'Open ANA' })).toBeVisible();
    await actor.type(screen.getByRole('searchbox', { name: 'Search accounts' }), 'be');
    expect(screen.queryByRole('button', { name: 'Open ANA' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open BEN' })).toBeVisible();

    await actor.clear(screen.getByRole('searchbox', { name: 'Search accounts' }));
    await actor.click(screen.getByRole('button', { name: 'Filter' }));
    await actor.click(within(screen.getByRole('group', { name: 'Status' })).getByRole('menuitemradio', { name: 'Active' }));
    expect(screen.queryByRole('button', { name: 'Open BEN' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open ANA' })).toBeVisible();
  });

  it('saves only changed account fields from the editor sheet', async () => {
    const actor = userEvent.setup();
    serve({
      'PATCH /api/admin/users/7': (body) => ({ user: { ...ana, ...body } }),
    });
    renderAdmin();

    await actor.click(await screen.findByRole('button', { name: 'Open ANA' }));
    const sheet = await screen.findByRole('dialog', { name: 'ANA' });
    const position = within(sheet).getByRole('textbox', { name: 'Position' });
    await actor.type(position, 'Analyst');
    await actor.click(within(sheet).getByRole('button', { name: 'Save account' }));

    await waitFor(() => expect(sent('PATCH', '/api/admin/users/7')).toEqual({ position: 'Analyst' }));
    expect(await within(sheet).findByText('Saved')).toBeVisible();
  });

  it('assigns the model policy group instead of models or thinking depth', async () => {
    const actor = userEvent.setup();
    serve({
      'PATCH /api/admin/users/7': (body) => ({ user: { ...ana, ...body } }),
    });
    renderAdmin();

    expect(within(await screen.findByRole('row', { name: /ANA/ })).getByText('Default')).toBeVisible();
    await actor.click(screen.getByRole('button', { name: 'Open ANA' }));
    const sheet = await screen.findByRole('dialog', { name: 'ANA' });
    expect(within(sheet).queryByRole('combobox', { name: /model$|Thinking depth/ })).not.toBeInTheDocument();
    const select = within(sheet).getByRole('combobox', { name: 'Model policy group' });
    expect(select).toHaveTextContent('Default');
    await actor.click(select);
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Default', 'Light', 'Spare']);
    await actor.click(screen.getByRole('option', { name: 'Light' }));
    await actor.click(within(sheet).getByRole('button', { name: 'Save account' }));

    await waitFor(() => expect(sent('PATCH', '/api/admin/users/7')).toEqual({ model_policy: 'light' }));
    expect(await within(screen.getByRole('row', { name: /ANA/ })).findByText('Light')).toBeVisible();
  });

  it('deactivates another account only after confirmation', async () => {
    const actor = userEvent.setup();
    serve({
      'DELETE /api/admin/users/7': () => ({ ok: true }),
    });
    renderAdmin();

    await actor.click(await screen.findByRole('button', { name: 'Open ANA' }));
    const sheet = await screen.findByRole('dialog', { name: 'ANA' });
    await actor.click(within(sheet).getByRole('button', { name: 'Deactivate' }));
    expect(api.request).not.toHaveBeenCalledWith('/api/admin/users/7', { method: 'DELETE' });
    const confirm = await screen.findByRole('alertdialog', { name: 'Deactivate ANA?' });
    await actor.click(within(confirm).getByRole('button', { name: 'Deactivate' }));

    await waitFor(() => expect(api.request).toHaveBeenCalledWith('/api/admin/users/7', { method: 'DELETE' }));
    expect(await within(sheet).findByRole('button', { name: 'Reactivate' })).toBeVisible();
  });

  it('impersonates only another active account, then reloads at the home route', async () => {
    const actor = userEvent.setup();
    serve({
      'POST /api/admin/users/7/impersonate': () => ({ user: ana }),
    });
    renderAdmin();

    for (const [row, title] of [['ADMIN', 'ADMIN'], ['BEN', 'BEN']]) {
      await actor.click(await screen.findByRole('button', { name: `Open ${row}` }));
      const sheet = await screen.findByRole('dialog', { name: title });
      expect(await within(sheet).findByRole('button', { name: 'Impersonate' })).toBeDisabled();
      await actor.click(within(sheet).getByRole('button', { name: 'Done' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    }

    const location = { assign: vi.fn(), reload: vi.fn(), hash: '#admin' };
    vi.stubGlobal('location', location);
    await actor.click(await screen.findByRole('button', { name: 'Open ANA' }));
    const sheet = await screen.findByRole('dialog', { name: 'ANA' });
    await actor.click(await within(sheet).findByRole('button', { name: 'Impersonate' }));

    await waitFor(() => expect(location.reload).toHaveBeenCalledTimes(1));
    expect(api.request).toHaveBeenCalledWith('/api/admin/users/7/impersonate', { method: 'POST', body: '{}' });
    expect(location.assign).toHaveBeenCalledWith('#');
  });

  it('opens the tab named in the hash and refuses to delete a group that still has accounts', async () => {
    const actor = userEvent.setup();
    serve({ 'PUT /api/admin/permission-groups': (body) => body });
    renderAdmin('#admin/groups');

    expect(screen.getByRole('tab', { name: 'Permission groups' })).toHaveAttribute('aria-selected', 'true');
    await actor.click(await screen.findByRole('button', { name: 'Open Member' }));
    let sheet = await screen.findByRole('dialog', { name: 'Member' });
    expect(within(sheet).getByRole('button', { name: 'Delete group' })).toBeDisabled();
    await actor.click(within(sheet).getByRole('button', { name: 'Done' }));

    await actor.click(screen.getByRole('button', { name: 'Open unused' }));
    sheet = await screen.findByRole('dialog', { name: 'unused' });
    await actor.click(within(sheet).getByRole('button', { name: 'Delete group' }));
    await actor.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete group' }));

    await waitFor(() => expect(sent('PUT', '/api/admin/permission-groups')).toEqual({ groups: [
      { name: 'admin', permissions: ['chat', 'manage_users'] }, { name: 'member', permissions: ['chat'] }, { name: 'viewer', permissions: [] },
    ] }));
  });

  it('edits one slot of a model policy group and saves the whole list', async () => {
    const actor = userEvent.setup();
    serve({ 'PUT /api/admin/model-policies': (body) => ({ ...body, members: { default: 2, light: 1 } }) });
    renderAdmin('#admin/policies');

    expect(screen.getByRole('tab', { name: 'Model policy groups' })).toHaveAttribute('aria-selected', 'true');
    await actor.click(await screen.findByRole('button', { name: 'Open Default' }));
    const sheet = await screen.findByRole('dialog', { name: 'Default' });
    expect(within(sheet).getByRole('textbox', { name: 'Identifier' })).toHaveAttribute('readonly');
    await actor.click(within(sheet).getByRole('combobox', { name: 'Chat model' }));
    await actor.click(screen.getByRole('option', { name: 'GPT B' }));
    await actor.click(within(sheet).getByRole('combobox', { name: 'Chat thinking depth' }));
    await actor.click(screen.getByRole('option', { name: 'High' }));
    await actor.click(within(sheet).getByRole('button', { name: 'Save group' }));

    await waitFor(() => expect(sent('PUT', '/api/admin/model-policies')).toEqual({ policies: [
      { ...policies[0], slots: { ...policies[0].slots, chat: { model: 'gpt-b', thinking: 'high' } } }, policies[1], policies[2],
    ] }));
    expect(await within(sheet).findByText('Saved')).toBeVisible();
  });

  it('creates a model policy group on the system default after validating its identifier', async () => {
    const actor = userEvent.setup();
    serve({ 'PUT /api/admin/model-policies': (body) => ({ ...body, members: { default: 2, light: 1 } }) });
    renderAdmin('#admin/policies');

    await actor.click(await screen.findByRole('button', { name: 'New group' }));
    const sheet = await screen.findByRole('dialog', { name: 'New model policy group' });
    await actor.type(within(sheet).getByRole('textbox', { name: 'Name' }), 'Frugal');
    await actor.type(within(sheet).getByRole('textbox', { name: 'Identifier' }), 'Frugal');
    expect(within(sheet).getByText(/Start with a lowercase letter/)).toBeVisible();
    expect(within(sheet).getByRole('button', { name: 'Create group' })).toBeDisabled();
    await actor.clear(within(sheet).getByRole('textbox', { name: 'Identifier' }));
    await actor.type(within(sheet).getByRole('textbox', { name: 'Identifier' }), 'frugal');
    await actor.click(within(sheet).getByRole('button', { name: 'Create group' }));

    await waitFor(() => expect(sent('PUT', '/api/admin/model-policies')).toEqual({ policies: [
      ...policies, { name: 'frugal', label: 'Frugal', slots: slots('', 'medium') },
    ] }));
  });

  it('shows a configured model the catalog no longer offers as unavailable', async () => {
    const actor = userEvent.setup();
    serve();
    renderAdmin('#admin/policies');

    expect(await within(await screen.findByRole('row', { name: /Default/ })).findByText('retired · unavailable')).toBeVisible();
    await actor.click(screen.getByRole('button', { name: 'Open Default' }));
    const sheet = await screen.findByRole('dialog', { name: 'Default' });
    const scout = within(sheet).getByRole('combobox', { name: 'Research subagent model' });
    expect(scout).toHaveTextContent('retired · unavailable');
    await actor.click(scout);
    // The system default names the catalog model it currently resolves to on its second line.
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['System defaultCurrently GPT A', 'GPT A', 'GPT B', 'retired · unavailable']);
  });

  it('refuses to delete a model policy group that still has accounts', async () => {
    const actor = userEvent.setup();
    serve({ 'PUT /api/admin/model-policies': (body) => ({ ...body, members: { default: 2, light: 1 } }) });
    renderAdmin('#admin/policies');

    await actor.click(await screen.findByRole('button', { name: 'Open Light' }));
    let sheet = await screen.findByRole('dialog', { name: 'Light' });
    expect(within(sheet).getByRole('button', { name: 'Delete group' })).toBeDisabled();
    expect(within(sheet).getByText('Move its 1 accounts to another group before deleting it.')).toBeVisible();
    await actor.click(within(sheet).getByRole('button', { name: 'Done' }));

    await actor.click(screen.getByRole('button', { name: 'Open Spare' }));
    sheet = await screen.findByRole('dialog', { name: 'Spare' });
    await actor.click(within(sheet).getByRole('button', { name: 'Delete group' }));
    await actor.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete group' }));

    await waitFor(() => expect(sent('PUT', '/api/admin/model-policies')).toEqual({ policies: [policies[0], policies[1]] }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open Spare' })).not.toBeInTheDocument());
  });

  it('shows the device code while waiting and reloads models once authorized', async () => {
    const actor = userEvent.setup();
    let polls = 0;
    const flow = { flow_id: 'f1', provider: 'openai', kind: 'device', status: 'waiting_for_user', complete: false, expires_at: 1_900_000_000, verification_url: 'https://example.test/device', user_code: 'ABCD-1234', poll_interval: 1 };
    serve({
      'GET /api/admin/models': () => ({ models: [], connected: false }),
      'POST /api/admin/oauth/start': () => flow,
      'POST /api/admin/oauth/f1/poll': () => (polls += 1) < 2 ? flow : { ...flow, status: 'complete', complete: true },
    });
    renderAdmin('#admin/models');

    await actor.click(await screen.findByRole('button', { name: 'Connect Codex account' }));
    expect(await screen.findByLabelText('Device code')).toHaveTextContent('ABCD-1234');
    expect(screen.getByRole('link', { name: /example\.test\/device/ })).toHaveAttribute('href', 'https://example.test/device');
    routes['GET /api/admin/models'] = () => ({ models: [{ id: 'gpt-a', name: 'GPT A' }], connected: true });

    expect(await screen.findByText('Codex account connected', {}, { timeout: 4000 })).toBeVisible();
    expect(screen.getByText('GPT A')).toBeVisible();
    expect(polls).toBe(2);
  });

  it('rolls back only after confirmation, against the current generation', async () => {
    const actor = userEvent.setup();
    const status = { generation: 4, current: { id: 'r2', source_commit: 'abc', database_version: 3, images: {}, activated_at: null }, previous: { id: 'r1', source_commit: 'def', database_version: 3, images: {}, activated_at: null }, target: null, public_state: 'idle', phase: '', services: { platform: { status: 'healthy' } }, error: '', operation_id: '', checked_at: null };
    serve({
      'GET /api/admin/system': () => status,
      'GET /api/admin/system/config': () => ({ update_enabled: true, update_interval: 3600, release_manifest_url: 'https://example.test/manifest' }),
      'POST /api/admin/system/operations': () => ({ ok: true }),
    });
    renderAdmin('#admin/system');

    await actor.click(await screen.findByRole('button', { name: 'Roll back' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Roll back to the previous release?' });
    expect(api.request).not.toHaveBeenCalledWith('/api/admin/system/operations', expect.anything());
    await actor.click(within(confirm).getByRole('button', { name: 'Roll back' }));

    await waitFor(() => expect(sent('POST', '/api/admin/system/operations')).toMatchObject({ operation: 'rollback', expected_generation: 4 }));
  });
});
