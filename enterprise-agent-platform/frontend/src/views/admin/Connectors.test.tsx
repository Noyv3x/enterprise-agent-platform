// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api';
import type * as ApiModule from '../../api';
import type { McpAdminConnector, McpCallRow } from '../../api';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../../i18n';
import { Admin } from '../Admin';

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../api', async (actual) => ({ ...(await actual<typeof ApiModule>()), request: api.request }));
vi.mock('liveline', () => ({ Liveline: () => null }));

const org = (id: number, name: string, extra: Partial<McpAdminConnector> = {}): McpAdminConnector => ({
  id, scope: 'org', name, label: name[0].toUpperCase() + name.slice(1), transport: 'http', url: `https://${name}.example/mcp`,
  header_keys: [], env_keys: [], auth: 'oauth', credential_mode: 'per_user', enabled: true, disabled_tools: [], status: 'idle',
  secrets_set: {}, groups: ['*'], tool_count: 3, source: 'manual', manageable: true, oauth: { scopes: [], client_id: null, client_secret_set: false }, ...extra,
});

const SECRET = 'client-secret-7d1e';

type Route = (body: Record<string, unknown> | undefined) => unknown;
let routes: Record<string, Route> = {};
let visible: McpAdminConnector[] = [];

function serve(connectors: McpAdminConnector[], extra: Record<string, Route> = {}, oauthWarning: string | null = null) {
  visible = connectors;
  routes = {
    'GET /api/admin/mcp/connectors': () => ({ connectors: visible, groups: ['admin', 'manager', 'member'], oauth_warning: oauthWarning }),
    ...extra,
  };
  api.request.mockImplementation(async (path: string, options: RequestInit = {}) => {
    const route = routes[`${options.method ?? 'GET'} ${path}`];
    if (!route) throw new Error(`unexpected ${options.method ?? 'GET'} ${path}`);
    return route(options.body ? JSON.parse(String(options.body)) : undefined);
  });
}

function calls(method: string, path: string): unknown[] {
  return api.request.mock.calls.filter(([called, options]) => called === path && options?.method === method).map(([, options]) => JSON.parse(String(options.body ?? 'null')));
}

function renderAdmin() {
  window.location.hash = '#admin/connectors';
  return render(<I18nProvider><Admin /></I18nProvider>);
}

describe('Admin → Connectors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    window.location.hash = '';
  });

  it('adds a shared OAuth connector for chosen groups with a pre-registered client', async () => {
    const actor = userEvent.setup();
    const created = org(20, 'notion', { credential_mode: 'shared', groups: ['member'], status: 'needs_auth', oauth: { scopes: ['read'], client_id: 'cid-1', client_secret_set: true } });
    serve([], {
      'POST /api/admin/mcp/connectors': () => { visible = [created]; return { connector: created }; },
    });
    renderAdmin();

    await actor.click((await screen.findAllByRole('button', { name: 'Add connector' }))[0]);
    const sheet = screen.getByRole('dialog', { name: 'Add a connector' });
    // Organization connectors are remote only.
    expect(within(sheet).queryByRole('tab', { name: 'Local program' })).not.toBeInTheDocument();
    await actor.type(within(sheet).getByRole('textbox', { name: /Name/ }), 'notion');
    await actor.type(within(sheet).getByRole('textbox', { name: /Server URL/ }), 'https://mcp.notion.com/mcp');
    await actor.click(within(sheet).getByRole('tab', { name: 'OAuth' }));
    await actor.click(within(sheet).getByRole('tab', { name: 'Shared credentials' }));
    await actor.type(within(sheet).getByRole('textbox', { name: 'Client ID' }), 'cid-1');
    await actor.type(within(sheet).getByLabelText(/Client secret/), SECRET);
    await actor.type(within(sheet).getByRole('textbox', { name: 'Scopes' }), 'read');
    await actor.click(within(sheet).getByRole('tab', { name: 'Chosen groups' }));
    await actor.click(within(sheet).getByRole('combobox', { name: 'Permission groups' }));
    await actor.click(await screen.findByRole('option', { name: 'Member' }));
    await actor.keyboard('{Escape}');
    await actor.click(within(sheet).getByRole('button', { name: 'Add connector' }));

    await waitFor(() => expect(calls('POST', '/api/admin/mcp/connectors')).toEqual([{
      name: 'notion', label: 'notion', enabled: true, credential_mode: 'shared', groups: ['member'],
      oauth_scopes: ['read'], oauth_client: { client_id: 'cid-1', client_secret: SECRET }, transport: 'http', url: 'https://mcp.notion.com/mcp', auth: 'oauth',
    }]));
    const detail = await screen.findByRole('dialog', { name: 'Notion' });
    expect(within(detail).getByText('Member')).toBeVisible();
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it('connects a shared connector once for everyone through the popup', async () => {
    const actor = userEvent.setup();
    const popup = { closed: false, location: { href: '' }, close: vi.fn() };
    vi.stubGlobal('open', vi.fn(() => popup));
    serve([org(21, 'github', { credential_mode: 'shared', status: 'needs_auth' })], {
      'POST /api/admin/mcp/connectors/21/connect': () => ({ authorize_url: 'https://github.example/login/oauth/authorize' }),
      'GET /api/admin/mcp/connectors/21/catalog': () => ({ tools: [{ name: 'create_issue', description: 'Create an issue', read_only: false, enabled: true }], prompts: [], resources: [] }),
      'PATCH /api/admin/mcp/connectors/21': () => ({ connector: visible[0] }),
    });
    renderAdmin();

    await actor.click(await screen.findByRole('button', { name: 'Open Github' }));
    const sheet = screen.getByRole('dialog', { name: 'Github' });
    await actor.click(within(sheet).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(popup.location.href).toBe('https://github.example/login/oauth/authorize'));
    visible = [org(21, 'github', { credential_mode: 'shared', status: 'connected' })];
    // The callback page also broadcasts, for when the identity provider severs window.opener.
    act(() => { new BroadcastChannel('mcp-oauth').postMessage({ type: 'mcp-connected', connector: 21 }); });
    expect(await within(sheet).findByText('Github is connected')).toBeVisible();

    // Administrators switch tools off for everyone.
    await actor.click(await within(sheet).findByRole('switch', { name: 'Allow create_issue' }));
    await waitFor(() => expect(calls('PATCH', '/api/admin/mcp/connectors/21')).toEqual([{ disabled_tools: ['create_issue'] }]));
  });

  it('explains when the server needs a pre-registered OAuth client', async () => {
    const actor = userEvent.setup();
    const popup = { closed: false, location: { href: '' }, close: vi.fn() };
    vi.stubGlobal('open', vi.fn(() => popup));
    serve([org(22, 'corp', { credential_mode: 'shared', status: 'needs_auth' })], {
      'POST /api/admin/mcp/connectors/22/connect': () => { throw new ApiError('registration required', 400, 'oauth_registration_required'); },
    });
    renderAdmin();

    await actor.click(await screen.findByRole('button', { name: 'Open Corp' }));
    const sheet = screen.getByRole('dialog', { name: 'Corp' });
    await actor.click(within(sheet).getByRole('button', { name: 'Connect' }));
    expect(await within(sheet).findByText('This server needs a pre-registered OAuth client')).toBeVisible();
    expect(popup.close).toHaveBeenCalled();
  });

  it('shows the HTTPS warning when OAuth cannot return to the platform', async () => {
    serve([org(23, 'notion')], {}, 'https_required');
    renderAdmin();
    expect(await screen.findByText('OAuth sign-in needs an HTTPS address')).toBeVisible();
  });

  it('lists recent calls without their content and filters by connector', async () => {
    const actor = userEvent.setup();
    // `at` is epoch seconds, as mcp_calls stores it; the older row comes first from the server.
    const row: McpCallRow = { id: 1, at: 1791792000, user_id: 3, username: 'alice', display_name: 'Alice', scope_key: 'private:3', connector_id: 21, connector_name: 'github', connector_label: 'GitHub', tool: 'create_issue', status: 'ok', duration_ms: 1530 };
    serve([org(21, 'github')], {
      'GET /api/admin/mcp/calls?limit=200': () => ({ calls: [row, { ...row, id: 2, at: 1791795600, status: 'timeout', tool: 'search', duration_ms: 120000 }] }),
      'GET /api/admin/mcp/calls?limit=200&connector=21': () => ({ calls: [row] }),
    });
    renderAdmin();

    await actor.click(await screen.findByRole('tab', { name: 'Recent calls' }));
    const table = await screen.findByRole('region', { name: 'Recent connector calls' });
    expect(await within(table).findByText('create_issue')).toBeVisible();
    expect(within(table).getAllByText('Alice')).toHaveLength(2);
    expect(within(table).getByText('Timed out')).toBeVisible();
    expect(within(table).getByText('1.5 s')).toBeVisible();
    // Newest first, sorted by the numeric time.
    const rows = within(table).getAllByRole('row').map((item) => item.textContent ?? '');
    expect(rows.findIndex((text) => text.includes('search'))).toBeLessThan(rows.findIndex((text) => text.includes('create_issue')));

    await actor.click(screen.getByRole('combobox', { name: 'Connector' }));
    await actor.click(await screen.findByRole('option', { name: 'Github' }));
    await waitFor(() => expect(within(table).queryByText('search')).not.toBeInTheDocument());
  });

  it('saves the internal-network allowlist and shows the server\'s objection', async () => {
    const actor = userEvent.setup();
    let saved = ['10.20.0.0/16'];
    serve([], {
      'GET /api/admin/mcp/settings': () => ({ private_networks: saved }),
      'PUT /api/admin/mcp/settings': (body) => {
        const entries = (body?.private_networks ?? []) as string[];
        if (entries.includes('not a cidr/99')) throw new ApiError('invalid entry: not a cidr/99', 400);
        saved = entries;
        return { private_networks: saved };
      },
    });
    renderAdmin();

    await actor.click(await screen.findByRole('tab', { name: 'Internal network' }));
    const field = await screen.findByRole('textbox', { name: 'Hosts and networks' });
    expect(field).toHaveValue('10.20.0.0/16');
    await actor.type(field, '{Enter}not a cidr/99');
    await actor.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('invalid entry: not a cidr/99')).toBeVisible();

    await actor.clear(field);
    await actor.type(field, '10.20.0.0/16{Enter}  wiki.corp.example  {Enter}');
    await actor.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls('PUT', '/api/admin/mcp/settings')).toEqual([
      { private_networks: ['10.20.0.0/16', 'not a cidr/99'] },
      { private_networks: ['10.20.0.0/16', 'wiki.corp.example'] },
    ]));
    expect(await screen.findByText('Saved. New connections use the list right away.')).toBeVisible();
  });

  it('declares only header names on a per-user connector', async () => {
    const actor = userEvent.setup();
    const created = org(24, 'jira', { auth: 'headers', header_keys: ['X-Api-Key'] });
    serve([], { 'POST /api/admin/mcp/connectors': () => { visible = [created]; return { connector: created }; } });
    renderAdmin();

    await actor.click((await screen.findAllByRole('button', { name: 'Add connector' }))[0]);
    const sheet = screen.getByRole('dialog', { name: 'Add a connector' });
    await actor.type(within(sheet).getByRole('textbox', { name: /Name/ }), 'jira');
    await actor.type(within(sheet).getByRole('textbox', { name: /Server URL/ }), 'https://jira.example/mcp');
    await actor.click(within(sheet).getByRole('tab', { name: 'Headers' }));
    await actor.click(within(sheet).getByRole('button', { name: 'Add header' }));
    await actor.type(within(sheet).getByRole('textbox', { name: 'Header name 1' }), 'X-Api-Key');
    expect(within(sheet).queryByLabelText('Value of X-Api-Key')).not.toBeInTheDocument();
    await actor.click(within(sheet).getByRole('button', { name: 'Add connector' }));
    await waitFor(() => expect(calls('POST', '/api/admin/mcp/connectors')).toEqual([{
      name: 'jira', label: 'jira', enabled: true, credential_mode: 'per_user', groups: ['*'], transport: 'http', url: 'https://jira.example/mcp', auth: 'headers', headers: { 'X-Api-Key': '' },
    }]));
  });

  it('stores a connector without authentication as shared, even after the mode was switched', async () => {
    const actor = userEvent.setup();
    const created = org(25, 'docs', { auth: 'none', credential_mode: 'shared' });
    serve([], { 'POST /api/admin/mcp/connectors': () => { visible = [created]; return { connector: created }; } });
    renderAdmin();

    await actor.click((await screen.findAllByRole('button', { name: 'Add connector' }))[0]);
    const sheet = screen.getByRole('dialog', { name: 'Add a connector' });
    await actor.type(within(sheet).getByRole('textbox', { name: /Name/ }), 'docs');
    await actor.type(within(sheet).getByRole('textbox', { name: /Server URL/ }), 'https://docs.example/mcp');
    // Pick headers and per-user, then go back to no authentication: the mode no longer applies.
    await actor.click(within(sheet).getByRole('tab', { name: 'Headers' }));
    await actor.click(within(sheet).getByRole('tab', { name: 'Each person signs in' }));
    await actor.click(within(sheet).getByRole('tab', { name: 'None' }));
    expect(within(sheet).queryByRole('tab', { name: 'Shared credentials' })).not.toBeInTheDocument();
    await actor.click(within(sheet).getByRole('button', { name: 'Add connector' }));
    await waitFor(() => expect(calls('POST', '/api/admin/mcp/connectors')).toEqual([{
      name: 'docs', label: 'docs', enabled: true, credential_mode: 'shared', groups: ['*'], transport: 'http', url: 'https://docs.example/mcp', auth: 'none',
    }]));
  });

  it('explains that testing a per-user connector needs the administrator\'s own sign-in', async () => {
    const actor = userEvent.setup();
    serve([org(26, 'jira', { auth: 'headers', header_keys: ['X-Api-Key'] })], {
      'GET /api/admin/mcp/connectors/26/catalog': () => { throw new ApiError('not connected', 409, 'not_connected'); },
      'POST /api/admin/mcp/connectors/26/test': () => { throw new ApiError('not connected', 409, 'not_connected'); },
    });
    renderAdmin();

    await actor.click(await screen.findByRole('button', { name: 'Open Jira' }));
    const sheet = screen.getByRole('dialog', { name: 'Jira' });
    expect(await within(sheet).findByText('You have not connected it yourself')).toBeVisible();
    await actor.click(within(sheet).getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(within(sheet).getAllByText('You have not connected it yourself')).toHaveLength(2));
    expect(within(sheet).queryByText('That did not work')).not.toBeInTheDocument();
  });
});
