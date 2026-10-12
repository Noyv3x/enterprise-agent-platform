// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type SkillView } from '../../api';
import type * as ApiModule from '../../api';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../../i18n';
import { SkillSettings } from './Skills';

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../api', async (actual) => ({ ...(await actual<typeof ApiModule>()), request: api.request }));

const skill = (key: string, extra: Partial<SkillView> = {}): SkillView => {
  const [tier, name] = key.split(':') as [SkillView['tier'], string];
  return {
    key, name, description: `${name} description`, tier, version: null, source: null, enabled: true,
    user_disableable: true, manageable: tier === 'personal', updated_at: '2026-10-10T08:00:00Z', warnings: [], ...extra,
  };
};

const catalog = [
  skill('personal:html-presentations', { source: { kind: 'upload' }, version: '1.2.0' }),
  skill('personal:weekly-report', { source: { kind: 'url', url: 'https://github.com/acme/skills/tree/main/weekly-report' } }),
  skill('personal:meeting-notes', { source: { kind: 'ai' } }),
  skill('personal:ubitech-platform', { source: { kind: 'migrated' }, warnings: ['name normalized from Ubitech_Platform'] }),
  skill('org:brand-voice', { source: { kind: 'upload' }, manageable: false }),
  skill('builtin:arxiv', { manageable: false, version: '2' }),
];

type Route = (body: Record<string, unknown> | FormData | undefined) => unknown;
let routes: Record<string, Route> = {};
/** What `GET /api/skills?scope=private` returns now; routes change it the way Platform's catalog would. */
let visible: SkillView[] = [];

function serve(extra: Record<string, Route> = {}, canInstall = true) {
  visible = [...catalog];
  routes = {
    'GET /api/skills?scope=private': () => ({ skills: visible, can_install: canInstall }),
    ...extra,
  };
  api.request.mockImplementation(async (path: string, options: RequestInit = {}) => {
    const route = routes[`${options.method ?? 'GET'} ${path}`];
    if (!route) throw new Error(`unexpected ${options.method ?? 'GET'} ${path}`);
    return route(options.body instanceof FormData ? options.body : options.body ? JSON.parse(String(options.body)) : undefined);
  });
}

function calls(method: string, path: string): unknown[] {
  return api.request.mock.calls.filter(([called, options]) => called === path && (options?.method ?? 'GET') === method)
    .map(([, options]) => options.body instanceof FormData ? options.body : JSON.parse(String(options.body ?? 'null')));
}

const group = (name: string) => screen.getByRole('region', { name }) as HTMLElement;
const row = (name: string) => screen.getByText(name, { selector: 'span' }).closest('li') as HTMLElement;

describe('Settings → Skills', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
  });
  afterEach(cleanup);

  it('shows personal, organization and built-in groups with source tags', async () => {
    serve();
    render(<I18nProvider><SkillSettings scope="private" /></I18nProvider>);

    const personal = await screen.findByRole('region', { name: 'Personal' });
    expect(within(row('html-presentations')).getByText('Uploaded')).toBeVisible();
    expect(within(row('html-presentations')).getByText('v1.2.0')).toBeVisible();
    expect(within(row('weekly-report')).getByText('Link')).toBeVisible();
    expect(within(row('meeting-notes')).getByText('Created by AI')).toBeVisible();
    expect(within(row('ubitech-platform')).getByText('Migrated')).toBeVisible();
    expect(within(row('ubitech-platform')).getByText('1 warning')).toBeVisible();
    expect(within(personal).getAllByRole('listitem')).toHaveLength(4);
    expect(within(group('Organization')).getByText('brand-voice')).toBeVisible();
    expect(within(row('brand-voice')).getByText('Organization')).toBeVisible();
    expect(within(group('Built-in')).getByText('arxiv')).toBeVisible();
    expect(within(row('arxiv')).getByText('Built-in')).toBeVisible();

    // Search narrows every group; a group without matches disappears.
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search skills' }), 'arx');
    expect(screen.queryByRole('region', { name: 'Personal' })).not.toBeInTheDocument();
    expect(within(group('Built-in')).getByText('arxiv')).toBeVisible();
  });

  it('saves the on/off preference for a skill', async () => {
    serve({ 'PUT /api/skills/builtin%3Aarxiv/preference': (body) => ({ skill: { ...catalog[5], enabled: !(body instanceof FormData) && body?.enabled === true } }) });
    render(<I18nProvider><SkillSettings scope="private" /></I18nProvider>);

    const toggle = await screen.findByRole('switch', { name: 'Use arxiv' });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(calls('PUT', '/api/skills/builtin%3Aarxiv/preference')).toEqual([{ enabled: false }]);
  });

  it('installs from a link, offering to replace a skill that already exists', async () => {
    let attempt = 0;
    const installed = skill('personal:pdf-forms', { source: { kind: 'url', url: 'https://github.com/acme/pdf-forms' } });
    serve({
      'POST /api/skills': () => {
        attempt += 1;
        if (attempt === 1) throw new ApiError('pdf-forms is already installed', 409, 'skill_exists');
        visible = [...visible, installed];
        return { skill: installed };
      },
    });
    render(<I18nProvider><SkillSettings scope="private" /></I18nProvider>);

    await userEvent.click(await screen.findByRole('button', { name: 'Install skill' }));
    const dialog = screen.getByRole('dialog', { name: 'Install a skill' });
    expect(dialog).toHaveTextContent('ask it to install the skill');
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Paste a link' }));
    await userEvent.type(within(dialog).getByLabelText('Link'), 'ftp://example.com');
    expect(within(dialog).getByText('Enter a link that starts with https://')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Install' })).toBeDisabled();
    await userEvent.clear(within(dialog).getByLabelText('Link'));
    await userEvent.type(within(dialog).getByLabelText('Link'), 'https://github.com/acme/pdf-forms');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Install' }));

    expect(await within(dialog).findByText('A skill with this name is already installed')).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Replace it' }));

    expect(await screen.findByText('pdf-forms is installed. Your AI can use it from the next message.')).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(calls('POST', '/api/skills')).toEqual([
      { url: 'https://github.com/acme/pdf-forms' },
      { url: 'https://github.com/acme/pdf-forms', replace: true },
    ]);
    expect(await within(group('Personal')).findByText('pdf-forms')).toBeVisible();
  });

  it('installs an uploaded package and asks which skill to take from a multi-skill archive', async () => {
    const installed = skill('personal:slides', { source: { kind: 'upload' } });
    let attempt = 0;
    serve({
      'POST /api/skills': () => {
        attempt += 1;
        if (attempt === 1) throw new ApiError('the archive holds several skills', 409, 'skill_candidates', { candidates: [{ name: 'slides', subpath: 'skills/slides' }, { name: 'docs', subpath: 'skills/docs' }] });
        return { skill: installed };
      },
    });
    render(<I18nProvider><SkillSettings scope="private" /></I18nProvider>);

    await userEvent.click(await screen.findByRole('button', { name: 'Install skill' }));
    const dialog = screen.getByRole('dialog', { name: 'Install a skill' });
    const install = within(dialog).getByRole('button', { name: 'Install' });
    expect(install).toBeDisabled();
    await userEvent.upload(within(dialog).getByLabelText('Skill package'), new File(['zip'], 'bundle.zip', { type: 'application/zip' }));
    expect(within(dialog).getByText('bundle.zip')).toBeVisible();
    await userEvent.click(install);

    const choose = await within(dialog).findByRole('combobox', { name: 'Skill to install' });
    expect(within(dialog).getByRole('button', { name: 'Install selected skill' })).toBeDisabled();
    await userEvent.click(choose);
    await userEvent.click(await screen.findByRole('option', { name: /slides/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Install selected skill' }));

    expect(await screen.findByText('slides is installed. Your AI can use it from the next message.')).toBeVisible();
    const bodies = calls('POST', '/api/skills') as FormData[];
    expect(bodies).toHaveLength(2);
    expect((bodies[0].get('file') as File).name).toBe('bundle.zip');
    expect(bodies[0].get('subpath')).toBeNull();
    expect(bodies[1].get('subpath')).toBe('skills/slides');
  });

  it('confirms before deleting, and offers delete for personal skills only', async () => {
    serve({ 'DELETE /api/skills/personal%3Ameeting-notes': () => { visible = visible.filter((item) => item.key !== 'personal:meeting-notes'); return { ok: true }; } });
    render(<I18nProvider><SkillSettings scope="private" /></I18nProvider>);

    await screen.findByRole('region', { name: 'Personal' });
    expect(within(row('brand-voice')).queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();
    expect(within(row('arxiv')).queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();
    // Only link-installed skills update.
    expect(within(row('weekly-report')).getByRole('button', { name: 'Update weekly-report from its link' })).toBeVisible();
    expect(within(row('meeting-notes')).queryByRole('button', { name: /Update/ })).not.toBeInTheDocument();

    await userEvent.click(within(row('meeting-notes')).getByRole('button', { name: 'Delete meeting-notes' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Delete meeting-notes?' });
    expect(calls('DELETE', '/api/skills/personal%3Ameeting-notes')).toHaveLength(0);
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete skill' }));

    expect(await screen.findByText('meeting-notes was deleted.')).toBeVisible();
    expect(screen.queryByText('meeting-notes', { selector: 'span' })).not.toBeInTheDocument();
    expect(calls('DELETE', '/api/skills/personal%3Ameeting-notes')).toHaveLength(1);
  });

  it('reloads the catalog after an install or delete, so a personal override replaces and restores the organization skill', async () => {
    const override = skill('personal:brand-voice', { source: { kind: 'upload' }, description: 'My own brand voice' });
    const org = catalog[4];
    serve({
      // Platform resolves visibility by name: personal wins over organization, then built-in.
      'POST /api/skills': () => { visible = [...visible.filter((item) => item.name !== 'brand-voice'), override]; return { skill: override }; },
      'DELETE /api/skills/personal%3Abrand-voice': () => { visible = [...visible.filter((item) => item.name !== 'brand-voice'), org]; return { ok: true }; },
    });
    render(<I18nProvider><SkillSettings scope="private" /></I18nProvider>);

    await userEvent.click(await screen.findByRole('button', { name: 'Install skill' }));
    const dialog = screen.getByRole('dialog', { name: 'Install a skill' });
    await userEvent.upload(within(dialog).getByLabelText('Skill package'), new File(['zip'], 'brand-voice.skill'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Install' }));

    expect(await within(group('Personal')).findByText('brand-voice')).toBeVisible();
    expect(screen.getAllByText('brand-voice', { selector: 'span' })).toHaveLength(1);
    expect(within(group('Organization')).queryByText('brand-voice')).not.toBeInTheDocument();

    await userEvent.click(within(row('brand-voice')).getByRole('button', { name: 'Delete brand-voice' }));
    await userEvent.click(within(screen.getByRole('alertdialog', { name: 'Delete brand-voice?' })).getByRole('button', { name: 'Delete skill' }));

    expect(await within(group('Organization')).findByText('brand-voice')).toBeVisible();
    expect(screen.getAllByText('brand-voice', { selector: 'span' })).toHaveLength(1);
    // The first load, then one reload after the install and one after the delete.
    expect(api.request.mock.calls.filter(([path]) => path === '/api/skills?scope=private')).toHaveLength(3);
  });

  it('explains an update refused because the skill at the link was renamed', async () => {
    serve({
      'POST /api/skills/personal%3Aweekly-report/update': () => {
        throw new ApiError('upstream skill is now named team-report', 409, 'skill_update_renamed', { new_name: 'team-report', name: 'weekly-report' });
      },
    });
    render(<I18nProvider><SkillSettings scope="private" /></I18nProvider>);

    await userEvent.click(await screen.findByRole('button', { name: 'Update weekly-report from its link' }));
    expect(await screen.findByText('weekly-report was not updated: the skill at its link is now named “team-report”. Install it from the link as a new skill; weekly-report stays as it is.')).toBeVisible();
    expect(row('weekly-report')).toBeVisible();
  });

  it('hides install, update and delete without the install permission and says why', async () => {
    serve({}, false);
    routes['GET /api/skills?scope=private'] = () => ({ skills: catalog.filter((item) => item.tier !== 'personal'), can_install: false });
    render(<I18nProvider><SkillSettings scope="private" /></I18nProvider>);

    expect(await screen.findByText('Your permission group cannot install skills')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Install skill' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Personal' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete|Update/ })).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Use brand-voice' })).toBeEnabled();
  });

  it('opens a skill with its SKILL.md rendered and its files', async () => {
    serve({
      'GET /api/skills/org%3Abrand-voice': () => ({
        skill: catalog[4],
        content: '---\nname: brand-voice\ndescription: Our tone\n---\n# Brand voice\n\nWrite **plainly**.',
        files: [{ path: 'SKILL.md', size_bytes: 80 }, { path: 'examples/good.md', size_bytes: 2048 }],
      }),
    });
    render(<I18nProvider><SkillSettings scope="private" /></I18nProvider>);

    await userEvent.click(await screen.findByRole('button', { name: /^brand-voice/ }));
    const sheet = screen.getByRole('dialog', { name: 'brand-voice' });
    expect(await within(sheet).findByRole('heading', { name: 'Brand voice' })).toBeVisible();
    expect(within(sheet).getByText('plainly', { selector: 'strong' })).toBeVisible();
    expect(sheet).not.toHaveTextContent('description: Our tone');
    expect(within(sheet).getByText('examples/good.md')).toBeVisible();
    expect(within(sheet).getByText('2.0 KB')).toBeVisible();
    expect(within(sheet).queryByRole('button', { name: 'Delete skill' })).not.toBeInTheDocument();
  });
});
