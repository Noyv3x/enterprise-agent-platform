// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ApiModule from '../../api';
import type { BuiltinSkill, OrgSkill } from '../../api';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../../i18n';
import { Admin } from '../Admin';

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../api', async (actual) => ({ ...(await actual<typeof ApiModule>()), request: api.request }));
vi.mock('liveline', () => ({ Liveline: () => null }));

const base = { version: null, enabled: true, user_disableable: true, manageable: true, updated_at: '2026-10-10T08:00:00Z', warnings: [] };
const org: OrgSkill[] = [
  { ...base, key: 'org:brand-voice', name: 'brand-voice', description: 'Write in our brand voice', tier: 'org', source: { kind: 'upload' }, groups: ['*'] },
  { ...base, key: 'org:weekly-report', name: 'weekly-report', description: 'Weekly status report', tier: 'org', source: { kind: 'url', url: 'https://github.com/acme/skills/tree/main/weekly-report' }, groups: ['manager'], enabled: false },
];
const builtin: BuiltinSkill[] = [
  { ...base, key: 'builtin:arxiv', name: 'arxiv', description: 'Search arXiv papers', tier: 'builtin', source: null, manageable: false, org_enabled: true },
  { ...base, key: 'builtin:plan', name: 'plan', description: 'Plan work', tier: 'builtin', source: null, manageable: false, org_enabled: false },
];

type Route = (body: Record<string, unknown> | FormData | undefined) => unknown;
let routes: Record<string, Route> = {};

function serve(extra: Record<string, Route> = {}) {
  routes = {
    'GET /api/admin/skills': () => ({ org, builtin, groups: ['admin', 'manager', 'member'] }),
    'GET /api/skills/org%3Aweekly-report': () => ({ skill: org[1], content: '# Weekly report', files: [{ path: 'SKILL.md', size_bytes: 15 }] }),
    'GET /api/skills/builtin%3Aarxiv': () => ({ skill: builtin[0], content: '# arXiv', files: [] }),
    ...extra,
  };
  api.request.mockImplementation(async (path: string, options: RequestInit = {}) => {
    const route = routes[`${options.method ?? 'GET'} ${path}`];
    if (!route) throw new Error(`unexpected ${options.method ?? 'GET'} ${path}`);
    return route(options.body instanceof FormData ? options.body : options.body ? JSON.parse(String(options.body)) : undefined);
  });
}

function calls(method: string, path: string): unknown[] {
  return api.request.mock.calls.filter(([called, options]) => called === path && options?.method === method)
    .map(([, options]) => options.body instanceof FormData ? options.body : JSON.parse(String(options.body ?? 'null')));
}

function renderAdmin(hash: string) {
  window.location.hash = hash;
  return render(<I18nProvider><Admin /></I18nProvider>);
}

describe('Admin → Skills', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    window.location.hash = '';
  });

  it('assigns an organization skill to chosen permission groups and switches it on', async () => {
    const actor = userEvent.setup();
    serve({ 'PATCH /api/admin/skills/weekly-report': () => ({ skill: org[1] }) });
    renderAdmin('#admin/skills');

    const table = await screen.findByRole('region', { name: 'Organization skills' });
    expect(within(table).getByLabelText('Available to: Everyone')).toBeVisible();
    expect(within(table).getByLabelText('Available to: Manager')).toBeVisible();
    await actor.click(within(table).getByRole('button', { name: 'Open weekly-report' }));

    const sheet = screen.getByRole('dialog', { name: 'weekly-report' });
    expect(await within(sheet).findByRole('heading', { name: 'Weekly report' })).toBeVisible();
    const save = within(sheet).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    expect(within(sheet).getByRole('button', { name: 'Update from link' })).toBeVisible();

    await actor.click(within(sheet).getByRole('combobox', { name: 'Permission groups' }));
    await actor.click(await screen.findByRole('option', { name: 'Member' }));
    await actor.keyboard('{Escape}');
    await actor.click(within(sheet).getByRole('switch', { name: 'Enable weekly-report' }));
    await actor.click(save);

    await waitFor(() => expect(calls('PATCH', '/api/admin/skills/weekly-report')).toEqual([{ enabled: true, groups: ['manager', 'member'] }]));
    expect(await screen.findByText('weekly-report saved. Changes apply from the next message.')).toBeVisible();
  });

  it('requires at least one group when not assigned to everyone', async () => {
    const actor = userEvent.setup();
    serve({ 'GET /api/skills/org%3Abrand-voice': () => ({ skill: org[0], content: '# Brand voice', files: [] }) });
    renderAdmin('#admin/skills');

    await actor.click(await screen.findByRole('button', { name: 'Open brand-voice' }));
    const sheet = screen.getByRole('dialog', { name: 'brand-voice' });
    await actor.click(within(sheet).getByRole('tab', { name: 'Chosen groups' }));
    expect(within(sheet).getByText('Choose at least one group.')).toBeVisible();
    expect(within(sheet).getByRole('button', { name: 'Save' })).toBeDisabled();
    await actor.click(within(sheet).getByRole('tab', { name: 'Everyone' }));
    expect(within(sheet).getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('installs an organization skill for the chosen groups', async () => {
    const actor = userEvent.setup();
    serve({ 'POST /api/admin/skills': () => ({ skill: org[0] }) });
    renderAdmin('#admin/skills');

    await actor.click(await screen.findByRole('button', { name: 'Install skill' }));
    const dialog = screen.getByRole('dialog', { name: 'Install a skill' });
    expect(dialog).not.toHaveTextContent('ask it to install');
    await actor.upload(within(dialog).getByLabelText('Skill package'), new File(['zip'], 'brand.skill'));
    await actor.click(within(dialog).getByRole('tab', { name: 'Chosen groups' }));
    expect(within(dialog).getByRole('button', { name: 'Install' })).toBeDisabled();
    await actor.click(within(dialog).getByRole('combobox', { name: 'Permission groups' }));
    await actor.click(await screen.findByRole('option', { name: 'Manager' }));
    await actor.keyboard('{Escape}');
    await actor.click(within(dialog).getByRole('button', { name: 'Install' }));

    expect(await screen.findByText('brand-voice is installed for the chosen groups.')).toBeVisible();
    const [body] = calls('POST', '/api/admin/skills') as FormData[];
    expect((body.get('file') as File).name).toBe('brand.skill');
    expect(body.get('groups')).toBe('["manager"]');
  });

  it('turns a built-in skill off for the whole organization', async () => {
    const actor = userEvent.setup();
    serve({ 'PUT /api/admin/skills/builtin/arxiv': () => ({ ok: true }) });
    renderAdmin('#admin/skills');

    await actor.click(await screen.findByRole('tab', { name: 'Built-in' }));
    const table = screen.getByRole('region', { name: 'Built-in skills' });
    expect(within(table).queryByRole('button', { name: 'Install skill' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install skill' })).not.toBeInTheDocument();
    const toggle = within(table).getByRole('switch', { name: 'Enable arxiv for everyone' });
    expect(toggle).toBeChecked();
    expect(within(table).getByRole('switch', { name: 'Enable plan for everyone' })).not.toBeChecked();
    await actor.click(toggle);

    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(calls('PUT', '/api/admin/skills/builtin/arxiv')).toEqual([{ enabled: false }]);
  });

  it('labels the install permission in permission groups', async () => {
    serve({
      'GET /api/admin/permission-groups': () => ({ groups: [{ name: 'member', permissions: ['chat', 'private_agent', 'install_extensions'] }] }),
      'GET /api/admin/users': () => ({ users: [] }),
    });
    renderAdmin('#admin/groups');

    expect(await screen.findByLabelText('Permissions: Plain chat, Personal AI, Install skills and connectors')).toBeVisible();
  });
});
