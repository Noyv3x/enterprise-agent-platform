// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api';
import type * as ApiModule from '../../api';
import type { McpConnectorView } from '../../api';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../../i18n';
import { ConnectorSettings } from './Connectors';

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../api', async (actual) => ({ ...(await actual<typeof ApiModule>()), request: api.request }));

const view = (id: number, name: string, extra: Partial<McpConnectorView> = {}): McpConnectorView => ({
  id, scope: 'personal', name, label: name[0].toUpperCase() + name.slice(1), transport: 'http', url: `https://${name}.example/mcp`,
  header_keys: [], env_keys: [], auth: 'none', credential_mode: 'per_user', enabled: true, disabled_tools: [], status: 'connected',
  secrets_set: {}, tool_count: 2, source: 'manual', manageable: true, ...extra,
});

/** The secret the tests type; it must never be rendered back. */
const SECRET = 'sk-live-4f9a-very-secret';

/** Stands in for the OAuth callback page, which reports over this channel only. */
const callback = new BroadcastChannel('mcp-oauth');
afterAll(() => callback.close());

type Route = (body: Record<string, unknown> | undefined) => unknown;
let routes: Record<string, Route> = {};
let visible: McpConnectorView[] = [];

function serve(connectors: McpConnectorView[], extra: Record<string, Route> = {}, detected: { path: string; format: string; servers: string[] }[] = []) {
  visible = connectors;
  routes = {
    'GET /api/mcp/connectors?scope=private': () => ({ connectors: visible, can_install: true }),
    'GET /api/mcp/import/detected': () => ({ files: detected }),
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

/** No secret value anywhere: not in text, not in an input, not in an attribute. */
function expectSecretHidden(secret = SECRET) {
  expect(document.body.innerHTML).not.toContain(secret);
  for (const input of document.querySelectorAll('input, textarea')) expect((input as HTMLInputElement).value).not.toBe(secret);
}

const renderSettings = () => render(<I18nProvider><ConnectorSettings scope="private" /></I18nProvider>);

describe('Settings → Connectors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists organization and personal connectors with status and last error', async () => {
    serve([
      view(1, 'notion', { scope: 'org', auth: 'oauth', status: 'needs_auth', manageable: false }),
      view(2, 'github', { auth: 'headers', header_keys: ['Authorization'], secrets_set: { Authorization: true }, source: 'import:claude' }),
      view(3, 'files', { transport: 'stdio', url: null, command: 'npx', args: ['-y', 'server-files'], status: 'error', last_error: 'spawn npx ENOENT' }),
    ]);
    renderSettings();

    const org = await screen.findByRole('region', { name: 'Organization' });
    expect(within(org).getByText('Notion')).toBeVisible();
    expect(within(org).getByText('Sign-in needed')).toBeVisible();
    expect(within(org).getByRole('button', { name: 'Connect · Notion' })).toBeVisible();
    const mine = screen.getByRole('region', { name: 'My connectors' });
    expect(within(mine).getByText('Imported')).toBeVisible();
    expect(within(mine).getByText('spawn npx ENOENT')).toBeVisible();
    expect(within(mine).getByText('Local program')).toBeVisible();
    expect(within(mine).getByRole('switch', { name: 'Use Github' })).toHaveAttribute('aria-checked', 'true');
    // Organization connectors cannot be switched off by users.
    expect(within(org).queryByRole('switch')).not.toBeInTheDocument();
  });

  it('adds a remote connector whose header value goes only to the secret store', async () => {
    const actor = userEvent.setup();
    const created = view(9, 'linear', { auth: 'headers', header_keys: ['Authorization'], secrets_set: { Authorization: true }, tool_count: null });
    serve([], {
      'POST /api/mcp/connectors': () => { visible = [created]; return { connector: created }; },
      'GET /api/mcp/connectors/9/catalog': () => ({ tools: [], prompts: [], resources: [] }),
    });
    renderSettings();

    await actor.click((await screen.findAllByRole('button', { name: 'Add connector' }))[0]);
    const sheet = screen.getByRole('dialog', { name: 'Add a connector' });
    await actor.type(within(sheet).getByRole('textbox', { name: /Name/ }), 'linear');
    await actor.type(within(sheet).getByRole('textbox', { name: /Server URL/ }), 'https://mcp.linear.app/mcp');
    await actor.click(within(sheet).getByRole('tab', { name: 'Headers' }));
    await actor.click(within(sheet).getByRole('button', { name: 'Add header' }));
    await actor.type(within(sheet).getByRole('textbox', { name: 'Header name 1' }), 'Authorization');
    const value = within(sheet).getByLabelText('Value of Authorization');
    expect(value).toHaveAttribute('type', 'password');
    await actor.type(value, SECRET);
    await actor.click(within(sheet).getByRole('button', { name: 'Add connector' }));

    await waitFor(() => expect(calls('POST', '/api/mcp/connectors')).toEqual([{
      name: 'linear', label: 'linear', enabled: true, transport: 'http', url: 'https://mcp.linear.app/mcp', auth: 'headers', headers: { Authorization: SECRET },
    }]));
    // The sheet now shows the new connector; its header reads only as set.
    const detail = await screen.findByRole('dialog', { name: 'Linear' });
    expect(within(detail).getByText('Authorization')).toBeVisible();
    expect(within(detail).getAllByText('Set').length).toBeGreaterThan(0);
    expectSecretHidden();
  });

  it('adds a local program with arguments one per line and a secret environment variable', async () => {
    const actor = userEvent.setup();
    const created = view(10, 'files', { transport: 'stdio', url: null, command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace/My Docs'], env_keys: ['API_KEY'], secrets_set: { API_KEY: true }, status: 'idle' });
    serve([], {
      'POST /api/mcp/connectors': () => { visible = [created]; return { connector: created }; },
      'GET /api/mcp/connectors/10/catalog': () => ({ tools: [], prompts: [], resources: [] }),
    });
    renderSettings();

    await actor.click((await screen.findAllByRole('button', { name: 'Add connector' }))[0]);
    const sheet = screen.getByRole('dialog', { name: 'Add a connector' });
    await actor.click(within(sheet).getByRole('tab', { name: 'Local program' }));
    await actor.type(within(sheet).getByRole('textbox', { name: /Name/ }), 'files');
    await actor.type(within(sheet).getByRole('textbox', { name: /Command/ }), 'npx');
    await actor.type(within(sheet).getByRole('textbox', { name: /Arguments/ }), '-y{Enter}@modelcontextprotocol/server-filesystem{Enter}/workspace/My Docs');
    await actor.click(within(sheet).getByRole('button', { name: 'Add variable' }));
    await actor.type(within(sheet).getByRole('textbox', { name: 'Variable name 1' }), 'API_KEY');
    await actor.type(within(sheet).getByLabelText('Value of API_KEY'), SECRET);
    await actor.click(within(sheet).getByRole('button', { name: 'Add connector' }));

    await waitFor(() => expect(calls('POST', '/api/mcp/connectors')).toEqual([{
      name: 'files', label: 'files', enabled: true, transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace/My Docs'], cwd: null, auth: 'none', env: { API_KEY: SECRET },
    }]));
    await screen.findByRole('dialog', { name: 'Files' });
    expectSecretHidden();
  });

  it('rejects an invalid name and a missing URL before sending anything', async () => {
    const actor = userEvent.setup();
    serve([view(1, 'notion')]);
    renderSettings();

    await actor.click((await screen.findAllByRole('button', { name: 'Add connector' }))[0]);
    const sheet = screen.getByRole('dialog', { name: 'Add a connector' });
    await actor.type(within(sheet).getByRole('textbox', { name: /Name/ }), 'notion');
    await actor.click(within(sheet).getByRole('button', { name: 'Add connector' }));
    expect(within(sheet).getByText('You already have a connector with this name.')).toBeVisible();
    expect(within(sheet).getByText('Enter an address that starts with https:// or http://')).toBeVisible();
    expect(calls('POST', '/api/mcp/connectors')).toEqual([]);
  });

  it('connects OAuth through the popup and its mcp-connected message', async () => {
    const actor = userEvent.setup();
    const popup: { closed: boolean; opener: unknown; location: { href: string }; close: () => void } = { closed: false, opener: window, location: { href: 'about:blank' }, close: vi.fn() };
    const open = vi.fn(() => popup);
    vi.stubGlobal('open', open);
    serve([view(4, 'notion', { auth: 'oauth', status: 'needs_auth', tool_count: null })], {
      'POST /api/mcp/connectors/4/connect': () => ({ authorize_url: 'https://auth.notion.example/authorize?state=abc' }),
      'GET /api/mcp/connectors/4/catalog': () => ({ tools: [{ name: 'search', description: 'Search pages', read_only: true, enabled: true }], prompts: [], resources: [] }),
    });
    renderSettings();

    await actor.click(await screen.findByRole('button', { name: 'Connect · Notion' }));
    const sheet = screen.getByRole('dialog', { name: 'Notion' });
    await actor.click(within(sheet).getByRole('button', { name: 'Connect' }));
    // The popup opens inside the click, before the request, then goes to the authorize page.
    expect(open).toHaveBeenCalledWith('about:blank', 'mcp-oauth', expect.stringContaining('popup'));
    await waitFor(() => expect(popup.location.href).toBe('https://auth.notion.example/authorize?state=abc'));
    expect(within(sheet).getByRole('button', { name: 'Waiting for sign-in…' })).toBeDisabled();
    // The identity provider's pages get no handle on this window.
    expect(popup.opener).toBeNull();

    // A window message is not a callback any more, nor is a callback for another connector.
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: { type: 'mcp-connected', connector: 4 }, origin: window.location.origin })); });
    act(() => { callback.postMessage({ type: 'mcp-connected', connector: 5 }); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(within(sheet).getByRole('button', { name: 'Waiting for sign-in…' })).toBeVisible();

    visible = [view(4, 'notion', { auth: 'oauth', status: 'connected' })];
    act(() => { callback.postMessage({ type: 'mcp-connected', connector: 4 }); });
    expect(await within(sheet).findByText('Notion is connected')).toBeVisible();
    expect(within(sheet).getByText('Connected')).toBeVisible();
    expect(within(sheet).getByRole('button', { name: 'Disconnect' })).toBeVisible();
    expect(await within(sheet).findByText('search')).toBeVisible();
  });

  it('reports a failed sign-in from the callback page', async () => {
    const actor = userEvent.setup();
    vi.stubGlobal('open', vi.fn(() => ({ closed: false, location: { href: '' }, close: vi.fn() })));
    serve([view(4, 'notion', { auth: 'oauth', status: 'needs_auth' })], {
      'POST /api/mcp/connectors/4/connect': () => ({ authorize_url: 'https://auth.notion.example/authorize' }),
    });
    renderSettings();

    await actor.click(await screen.findByRole('button', { name: 'Connect · Notion' }));
    const sheet = screen.getByRole('dialog', { name: 'Notion' });
    await actor.click(within(sheet).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(calls('POST', '/api/mcp/connectors/4/connect')).toHaveLength(1));
    act(() => { callback.postMessage({ type: 'mcp-connect-failed', connector: 4, error: 'access_denied' }); });
    expect(await within(sheet).findByText('access_denied')).toBeVisible();
    // A failed sign-in can be tried again from the notice.
    expect(within(sheet).getAllByRole('button', { name: 'Reconnect' }).length).toBeGreaterThan(0);
  });

  it('switches single tools off and keeps names the server no longer offers', async () => {
    const actor = userEvent.setup();
    serve([view(5, 'notion', { disabled_tools: ['old_tool'] })], {
      'GET /api/mcp/connectors/5/catalog': () => ({
        tools: [
          { name: 'search', description: 'Search pages', read_only: true, enabled: true },
          { name: 'delete_page', description: 'Delete a page', read_only: false, enabled: true },
        ], prompts: [], resources: [],
      }),
      'PATCH /api/mcp/connectors/5': () => ({ connector: visible[0] }),
    });
    renderSettings();

    await actor.click(await screen.findByRole('button', { name: /Notion/ }));
    const sheet = screen.getByRole('dialog', { name: 'Notion' });
    expect(await within(sheet).findByText('2 of 2 on')).toBeVisible();
    expect(within(sheet).getByText('Read-only')).toBeVisible();
    await actor.click(within(sheet).getByRole('switch', { name: 'Allow delete_page' }));
    await waitFor(() => expect(calls('PATCH', '/api/mcp/connectors/5')).toEqual([{ disabled_tools: ['old_tool', 'delete_page'] }]));
    expect(within(sheet).getByRole('switch', { name: 'Allow delete_page' })).toHaveAttribute('aria-checked', 'false');
    expect(within(sheet).getByText('1 of 2 on')).toBeVisible();
  });

  it('saves the user\'s own keys for a per-user organization connector without showing them', async () => {
    const actor = userEvent.setup();
    const org = view(6, 'jira', { scope: 'org', auth: 'headers', header_keys: ['X-Api-Key', 'X-Team'], secrets_set: { 'X-Api-Key': false, 'X-Team': true }, status: 'needs_secrets', manageable: false });
    serve([org], {
      'PUT /api/mcp/connectors/6/credentials': () => {
        visible = [{ ...org, secrets_set: { 'X-Api-Key': true, 'X-Team': true }, status: 'idle' }];
        return { connector: visible[0] };
      },
      'GET /api/mcp/connectors/6/catalog': () => ({ tools: [], prompts: [], resources: [] }),
    });
    renderSettings();

    await actor.click(await screen.findByRole('button', { name: 'Enter keys · Jira' }));
    const sheet = screen.getByRole('dialog', { name: 'Jira' });
    const form = within(sheet).getByRole('form', { name: 'Your keys' });
    const key = within(form).getByLabelText(/X-Api-Key/);
    const team = within(form).getByLabelText(/X-Team/);
    expect(key).toHaveAttribute('type', 'password');
    expect(key).toHaveValue('');
    expect(team).toHaveValue('');
    expect(within(form).getByText('Not set')).toBeVisible();
    expect(within(form).getByText('Set')).toBeVisible();
    await actor.type(key, SECRET);
    await actor.click(within(form).getByRole('button', { name: 'Save keys' }));

    // Only the typed value is sent; the stored one is left alone.
    await waitFor(() => expect(calls('PUT', '/api/mcp/connectors/6/credentials')).toEqual([{ secrets: { 'X-Api-Key': SECRET } }]));
    expect(await within(sheet).findByText('Keys saved')).toBeVisible();
    expect(within(form).getByLabelText(/X-Api-Key/)).toHaveValue('');
    expect(within(form).getAllByText('Set')).toHaveLength(2);
    expectSecretHidden();
  });

  it('offers detected config files and imports a pasted claude mcp add line', async () => {
    const actor = userEvent.setup();
    const imported = view(11, 'notion', { auth: 'oauth', status: 'needs_auth', source: 'import:claude-cli' });
    serve([], {
      'POST /api/mcp/import': () => { visible = [imported]; return { connectors: [imported], missing: [{ connector: 'notion', kind: 'oauth' }] }; },
    }, [{ path: '/workspace/.mcp.json', format: 'claude', servers: ['github'] }]);
    renderSettings();

    const banner = await screen.findByText('Found MCP settings from other tools in your workspace');
    expect(banner).toBeVisible();
    expect(screen.getByText('/workspace/.mcp.json')).toBeVisible();
    await actor.click(screen.getAllByRole('button', { name: 'Import' })[0]);
    const dialog = screen.getByRole('dialog', { name: 'Import connectors' });
    await actor.type(within(dialog).getByRole('textbox', { name: 'Install instructions or config' }), 'claude mcp add --transport http notion https://mcp.notion.com/mcp');
    await actor.click(within(dialog).getByRole('button', { name: 'Import' }));

    await waitFor(() => expect(calls('POST', '/api/mcp/import')).toEqual([{ text: 'claude mcp add --transport http notion https://mcp.notion.com/mcp' }]));
    expect(await within(dialog).findByText('Imported 1 connector(s)')).toBeVisible();
    expect(within(dialog).getByText('Needs sign-in')).toBeVisible();
    await actor.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(await screen.findByRole('region', { name: 'My connectors' })).toHaveTextContent('Notion');
  });

  it('imports a detected workspace file by path', async () => {
    const actor = userEvent.setup();
    const imported = view(12, 'github', { auth: 'headers', header_keys: ['Authorization'], status: 'needs_secrets' });
    serve([], {
      'POST /api/mcp/import': () => { visible = [imported]; return { connectors: [imported], missing: [{ connector: 'github', kind: 'secrets', keys: ['Authorization'] }] }; },
    }, [{ path: '/workspace/.mcp.json', format: 'claude', servers: ['github'] }]);
    renderSettings();

    await actor.click(await screen.findByRole('button', { name: 'Review and import' }));
    const dialog = screen.getByRole('dialog', { name: 'Import connectors' });
    expect(within(dialog).getByRole('radio', { name: /\.mcp\.json/ })).toBeChecked();
    await actor.click(within(dialog).getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(calls('POST', '/api/mcp/import')).toEqual([{ path: '/workspace/.mcp.json' }]));
    expect(await within(dialog).findByText('Needs keys: Authorization')).toBeVisible();
    await actor.click(within(dialog).getByRole('button', { name: 'Done' }));
    // Everything in the file was imported, so the offer disappears.
    await waitFor(() => expect(screen.queryByText('Found MCP settings from other tools in your workspace')).not.toBeInTheDocument());
  });

  it('edits a personal connector: removes a stored header and adds a new one', async () => {
    const actor = userEvent.setup();
    const github = view(13, 'github', { auth: 'headers', header_keys: ['Authorization', 'X-Old'], secrets_set: { Authorization: true, 'X-Old': true } });
    serve([github], {
      'GET /api/mcp/connectors/13/catalog': () => ({ tools: [], prompts: [], resources: [] }),
      'PATCH /api/mcp/connectors/13': () => ({ connector: github }),
    });
    renderSettings();

    await actor.click(await screen.findByRole('button', { name: /Github/ }));
    await actor.click(within(screen.getByRole('dialog', { name: 'Github' })).getByRole('button', { name: 'Edit' }));
    const sheet = screen.getByRole('dialog', { name: 'Edit Github' });
    expect(within(sheet).getByLabelText('Value of Authorization')).toHaveValue('');
    await actor.click(within(sheet).getByRole('button', { name: 'Remove X-Old' }));
    await actor.click(within(sheet).getByRole('button', { name: 'Add header' }));
    await actor.type(within(sheet).getByRole('textbox', { name: 'Header name 2' }), 'X-Workspace');
    await actor.type(within(sheet).getByLabelText('Value of X-Workspace'), 'acme');
    await actor.click(within(sheet).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calls('PATCH', '/api/mcp/connectors/13')).toEqual([{
      label: 'Github', enabled: true, transport: 'http', url: 'https://github.example/mcp', auth: 'headers', header_keys: ['Authorization', 'X-Workspace'], env_keys: [],
      secrets: { 'X-Old': null, 'X-Workspace': 'acme' },
    }]));
  });

  it('holds a connector the AI added until the user confirms where it connects', async () => {
    const actor = userEvent.setup();
    const added = view(14, 'notion', { auth: 'oauth', source: 'ai', enabled: false, status: 'pending_confirmation', url: 'https://mcp.notion.example/v1/mcp?team=acme', tool_count: null });
    serve([added], {
      'POST /api/mcp/connectors/14/confirm': () => { visible = [{ ...added, enabled: true, status: 'needs_auth' }]; return { connector: visible[0] }; },
    });
    renderSettings();

    const mine = await screen.findByRole('region', { name: 'My connectors' });
    expect(within(mine).getByText('Awaiting your confirmation')).toBeVisible();
    // Only the origin: the destination, without a path or query that could hide anything.
    expect(within(mine).getByText('https://mcp.notion.example')).toBeVisible();
    expect(within(mine).queryByRole('switch')).not.toBeInTheDocument();
    await actor.click(within(mine).getByRole('button', { name: 'Review · Notion' }));

    const sheet = screen.getByRole('dialog', { name: 'Notion' });
    expect(within(sheet).getByText('Your AI added this connector. Check it before it runs.')).toBeVisible();
    expect(within(sheet).getByText('https://mcp.notion.example')).toBeVisible();
    // Nothing that reaches the server before confirmation: no sign-in, no test, no switch.
    expect(within(sheet).queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: 'Test connection' })).not.toBeInTheDocument();
    expect(within(sheet).queryByRole('switch', { name: 'Enable Notion' })).not.toBeInTheDocument();

    await actor.click(within(sheet).getByRole('button', { name: 'Confirm and turn on' }));
    await waitFor(() => expect(calls('POST', '/api/mcp/connectors/14/confirm')).toEqual([{}]));
    expect(await within(sheet).findByText('Notion is confirmed and on')).toBeVisible();
    expect(within(sheet).getByRole('button', { name: 'Connect' })).toBeVisible();
  });

  it('shows an imported local program\'s command and hides its key form until confirmed', async () => {
    const actor = userEvent.setup();
    serve([view(15, 'files', { transport: 'stdio', url: null, command: 'npx', args: ['-y', 'server-files'], env_keys: ['API_KEY'], secrets_set: { API_KEY: false }, source: 'import:claude', enabled: false, status: 'pending_confirmation' })]);
    renderSettings();

    await actor.click(await screen.findByRole('button', { name: 'Review · Files' }));
    const sheet = screen.getByRole('dialog', { name: 'Files' });
    expect(within(sheet).getByText('This connector was imported. Check it before it runs.')).toBeVisible();
    expect(within(sheet).getByText('It will start this program in your computer:')).toBeVisible();
    expect(within(sheet).getAllByText('npx -y server-files').length).toBeGreaterThan(0);
    expect(within(sheet).queryByRole('form', { name: 'Your keys' })).not.toBeInTheDocument();
  });

  it('reads an upstream 409 needs_auth as re-authorization needed', async () => {
    const actor = userEvent.setup();
    serve([view(16, 'notion', { auth: 'oauth', status: 'connected' })], {
      'POST /api/mcp/connectors/16/test': () => { throw new ApiError('The server rejected the credentials (HTTP 401)', 409, 'needs_auth'); },
      'GET /api/mcp/connectors/16/catalog': () => { throw new ApiError('The server rejected the credentials (HTTP 401)', 409, 'credentials_rejected'); },
    });
    renderSettings();

    await actor.click(await screen.findByRole('button', { name: /Notion/ }));
    const sheet = screen.getByRole('dialog', { name: 'Notion' });
    // The tool list's own request was refused the same way.
    expect(await within(sheet).findByText(/so its tools cannot be listed/)).toBeVisible();
    await actor.click(within(sheet).getByRole('button', { name: 'Test connection' }));
    expect(await within(sheet).findByText('The service no longer accepts the saved sign-in. Connect again to continue.')).toBeVisible();
    expect(within(sheet).getAllByText('Re-authorization needed').length).toBe(2);
    expect(within(sheet).getAllByRole('button', { name: 'Reconnect' })).toHaveLength(2);
  });

  it('lists what an import skipped and why', async () => {
    const actor = userEvent.setup();
    serve([view(1, 'github')], {
      'POST /api/mcp/import': () => ({ connectors: [], missing: [], skipped: [
        { name: 'github', reason: 'exists' },
        { name: 'files', reason: 'local_not_allowed' },
        { name: 'broken', reason: 'invalid', message: 'url must start with http:// or https://' },
      ] }),
    });
    renderSettings();

    await actor.click((await screen.findAllByRole('button', { name: 'Import' }))[0]);
    const dialog = screen.getByRole('dialog', { name: 'Import connectors' });
    await actor.type(within(dialog).getByRole('textbox', { name: 'Install instructions or config' }), '{{"mcpServers": {{}}');
    await actor.click(within(dialog).getByRole('button', { name: 'Import' }));

    expect(await within(dialog).findByText('Nothing new was imported')).toBeVisible();
    expect(within(dialog).queryByText('No connectors were found in it')).not.toBeInTheDocument();
    const skipped = within(dialog).getByRole('region', { name: 'Skipped' });
    expect(within(skipped).getByText('a connector with this name already exists')).toBeVisible();
    expect(within(skipped).getByText('local programs are only for the personal AI')).toBeVisible();
    expect(within(skipped).getByText('url must start with http:// or https://')).toBeVisible();
  });
});
