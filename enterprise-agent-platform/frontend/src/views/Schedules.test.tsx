// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../i18n';
import { Schedules } from './Schedules';
import { ScheduleRuns } from './schedules/ScheduleRuns';
import type { Schedule } from './schedules/model';

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../api', () => api);

const digest: Schedule = {
  id: 1,
  name: 'Morning digest',
  prompt: 'Summarize the news',
  schedule: { type: 'interval', every_seconds: 600 },
  timezone: 'UTC',
  delivery: 'chat',
  state: 'active',
  enabled: true,
  next_run_at: '2026-10-01T09:00:00Z',
  last_run: null,
  created_at: '2026-09-30T09:00:00Z',
  updated_at: '2026-09-30T09:00:00Z',
};
const report: Schedule = { ...digest, id: 3, name: 'Weekly report', last_run: { id: 9, status: 'failed', error: 'Model unavailable' } };

type Route = (body: Record<string, unknown>) => unknown;

function serve(routes: Record<string, Route>) {
  api.request.mockImplementation(async (path: string, options: RequestInit = {}) => {
    const route = routes[`${options.method ?? 'GET'} ${path}`];
    if (!route) throw new Error(`unexpected ${options.method ?? 'GET'} ${path}`);
    return route(options.body ? JSON.parse(String(options.body)) : {});
  });
}

function sentBody(method: string, path: string): unknown {
  const call = api.request.mock.calls.find(([calledPath, options]) => calledPath === path && options?.method === method);
  return call ? JSON.parse(String(call[1].body)) : undefined;
}

const renderSchedules = () => render(<I18nProvider><Schedules /></I18nProvider>);
const row = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });

describe('Schedules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
  });
  afterEach(cleanup);

  it('creates an interval schedule from amount and unit and expands it', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/schedules': () => ({ schedules: [] }),
      'POST /api/schedules': (body) => ({ schedule: { ...digest, id: 2, name: body.name, prompt: body.prompt, schedule: body.schedule } }),
    });
    renderSchedules();

    await screen.findByText('No schedules yet');
    await user.click(screen.getAllByRole('button', { name: 'New schedule' })[0]);
    const sheet = await screen.findByRole('dialog', { name: 'New schedule' });
    await user.type(within(sheet).getByRole('textbox', { name: 'Name' }), 'Weekly report');
    await user.type(within(sheet).getByRole('textbox', { name: 'Instructions' }), 'Draft the weekly report');
    const every = within(sheet).getByRole('textbox', { name: 'Every' });
    await user.clear(every);
    await user.type(every, '2');
    await user.click(within(sheet).getByRole('button', { name: 'Create schedule' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(sentBody('POST', '/api/schedules')).toEqual({
      name: 'Weekly report',
      prompt: 'Draft the weekly report',
      schedule: { type: 'interval', every_seconds: 172_800 },
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    expect(row('Weekly report')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Every 2 days')).toBeVisible();
  });

  it('prefills an edit and refuses intervals under five minutes', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/schedules': () => ({ schedules: [digest] }),
      'PATCH /api/schedules/1': (body) => ({ schedule: { ...digest, schedule: body.schedule } }),
    });
    renderSchedules();

    await user.click(await screen.findByRole('button', { name: /^Morning digest/ }));
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const sheet = await screen.findByRole('dialog', { name: 'Edit schedule' });
    const every = within(sheet).getByRole('textbox', { name: 'Every' });
    expect(every).toHaveValue('10');
    const save = within(sheet).getByRole('button', { name: 'Save changes' });

    await user.clear(every);
    await user.type(every, '4');
    expect(save).toBeDisabled();
    expect(within(sheet).getByText('At least 5 minutes.')).toBeVisible();

    await user.clear(every);
    await user.type(every, '30');
    await user.click(save);

    await waitFor(() => expect(sentBody('PATCH', '/api/schedules/1')).toEqual({
      name: 'Morning digest',
      prompt: 'Summarize the news',
      schedule: { type: 'interval', every_seconds: 1_800 },
      timezone: 'UTC',
    }));
  });

  it('pauses and resumes, and deletes only after confirmation', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/schedules': () => ({ schedules: [digest] }),
      'POST /api/schedules/1/pause': () => ({ schedule: { ...digest, state: 'paused', enabled: false } }),
      'POST /api/schedules/1/resume': () => ({ schedule: digest }),
      'DELETE /api/schedules/1': () => ({ ok: true }),
    });
    renderSchedules();

    await user.click(await screen.findByRole('button', { name: /^Morning digest/ }));
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(await screen.findByRole('button', { name: /Morning digest.*Paused/ })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(api.request).not.toHaveBeenCalledWith('/api/schedules/1', { method: 'DELETE' });
    const confirm = await screen.findByRole('alertdialog', { name: 'Delete “Morning digest”?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('No schedules yet')).toBeVisible();
    expect(api.request).toHaveBeenCalledWith('/api/schedules/1', { method: 'DELETE' });
  });

  it('runs now after confirmation and shows run history', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/schedules': () => ({ schedules: [digest] }),
      'POST /api/schedules/1/run-now': () => ({ schedule: { ...digest, last_run: { id: 6, status: 'succeeded', trigger: 'manual' } } }),
      'GET /api/schedules/1/runs': () => ({ runs: [{ id: 5, status: 'failed', trigger: 'scheduled', scheduled_for: '2026-09-30T09:00:00Z', error: 'Model unavailable' }] }),
    });
    renderSchedules();

    await user.click(await screen.findByRole('button', { name: /^Morning digest/ }));
    await user.click(screen.getByRole('button', { name: 'Run now' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(api.request).toHaveBeenCalledWith('/api/schedules/1/run-now', { method: 'POST', body: '{}' }));

    await user.click(screen.getByRole('button', { name: 'Run history' }));
    const history = await screen.findByRole('dialog', { name: 'Run history' });
    await user.click(await within(history).findByRole('button', { name: /^Scheduled run/ }));
    expect(within(history).getByText('Model unavailable')).toBeVisible();
  });

  it('filters to failed schedules and keeps a schedule when an action fails', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/schedules': () => ({ schedules: [digest, report] }),
      'POST /api/schedules/3/pause': () => { throw new Error('schedule changed elsewhere'); },
    });
    renderSchedules();

    await user.click(await screen.findByRole('button', { name: /^Failed/ }));
    expect(screen.queryByRole('button', { name: /^Morning digest/ })).not.toBeInTheDocument();

    await user.click(row('Weekly report'));
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(await screen.findByText('schedule changed elsewhere')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();
  });

  it('serializes actions across schedules until the pending request settles', async () => {
    const user = userEvent.setup();
    let finishPause!: (value: unknown) => void;
    let finishRun!: (value: unknown) => void;
    // The frontend targets ES2020, which does not include Promise.withResolvers.
    const pause = new Promise((resolve) => { finishPause = resolve; });
    const run = new Promise((resolve) => { finishRun = resolve; });
    serve({
      'GET /api/schedules': () => ({ schedules: [digest, report] }),
      'POST /api/schedules/1/pause': () => pause,
      'POST /api/schedules/3/run-now': () => run,
    });
    renderSchedules();
    await user.click(await screen.findByRole('button', { name: /^Morning digest/ }));
    await user.click(row('Weekly report'));
    const first = within(screen.getByRole('group', { name: 'Actions for Morning digest' }));
    const second = within(screen.getByRole('group', { name: 'Actions for Weekly report' }));
    await user.click(first.getByRole('button', { name: 'Pause' }));
    expect(second.getByRole('button', { name: 'Run now' })).toBeDisabled();
    await user.click(second.getByRole('button', { name: 'Run now' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    await act(async () => finishPause({ schedule: { ...digest, state: 'paused' } }));
    await user.click(second.getByRole('button', { name: 'Run now' }));
    const confirm = await screen.findByRole('alertdialog');
    await user.click(within(confirm).getByRole('button', { name: 'Run now' }));
    expect(confirm).toBeVisible();
    expect(first.getByRole('button', { name: 'Resume' })).toBeDisabled();
    expect(within(confirm).getByRole('button', { name: 'Run now' })).toBeDisabled();
    await act(async () => finishRun({ schedule: report }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(first.getByRole('button', { name: 'Resume' })).toBeEnabled();
    expect(api.request.mock.calls.filter(([path]) => path === '/api/schedules/3/run-now')).toHaveLength(1);
  });

  it.each([false, true])('keeps cached history and exposes retry after refresh failure (empty: %s)', async (empty) => {
    const user = userEvent.setup();
    const cached = empty ? [] : [{ id: 5, status: 'succeeded', trigger: 'scheduled', scheduled_for: '2026-09-30T09:00:00Z' }];
    let fail = false;
    serve({
      'GET /api/schedules/1/runs': () => {
        if (fail) throw new Error('History offline');
        return { runs: cached };
      },
    });
    const rendered = render(<I18nProvider><ScheduleRuns scheduleId={1} timezone="UTC" revision={0} /></I18nProvider>);
    expect(await screen.findByText(empty ? 'No runs yet' : 'Scheduled run')).toBeVisible();
    fail = true;
    rendered.rerender(<I18nProvider><ScheduleRuns scheduleId={1} timezone="UTC" revision={1} /></I18nProvider>);
    expect(await screen.findByText('History offline')).toBeVisible();
    expect(screen.getByText(empty ? 'No runs yet' : 'Scheduled run')).toBeVisible();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText('History offline')).not.toBeInTheDocument());
    expect(screen.getByText(empty ? 'No runs yet' : 'Scheduled run')).toBeVisible();
  });
});
