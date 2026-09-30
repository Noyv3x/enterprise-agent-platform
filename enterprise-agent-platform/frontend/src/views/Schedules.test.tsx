// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldworkProvider } from '../components/ui/fieldwork';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../i18n';
import { Schedules } from './Schedules';
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

function renderSchedules() {
  return render(<I18nProvider><FieldworkProvider mode="light" motion={false}><Schedules /></FieldworkProvider></I18nProvider>);
}

describe('Schedules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
  });
  afterEach(cleanup);

  it('creates an interval schedule from amount and unit and opens it', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/schedules': () => ({ schedules: [] }),
      'POST /api/schedules': (body) => ({ schedule: { ...digest, id: 2, name: body.name, prompt: body.prompt, schedule: body.schedule } }),
      'GET /api/schedules/2/runs': () => ({ runs: [] }),
    });
    renderSchedules();

    await screen.findByText('No schedules yet');
    await user.click(screen.getByRole('button', { name: 'New schedule' }));
    await user.type(screen.getByLabelText('Name'), 'Weekly report');
    await user.type(screen.getByLabelText('Instructions'), 'Draft the weekly report');
    const every = screen.getByLabelText('Every');
    await user.clear(every);
    await user.type(every, '2');
    await user.click(screen.getByRole('button', { name: 'Create schedule' }));

    await screen.findByText('No runs yet');
    expect(sentBody('POST', '/api/schedules')).toEqual({
      name: 'Weekly report',
      prompt: 'Draft the weekly report',
      schedule: { type: 'interval', every_seconds: 172_800 },
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    expect(screen.getByRole('heading', { name: 'Weekly report' })).toBeVisible();
  });

  it('prefills an edit and refuses intervals under five minutes', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/schedules': () => ({ schedules: [digest] }),
      'GET /api/schedules/1/runs': () => ({ runs: [] }),
      'PATCH /api/schedules/1': (body) => ({ schedule: { ...digest, schedule: body.schedule } }),
    });
    renderSchedules();

    await user.click(await screen.findByRole('button', { name: 'Open Morning digest' }));
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const every = screen.getByLabelText('Every');
    expect(every).toHaveValue('10');
    const save = screen.getByRole('button', { name: 'Save changes' });

    await user.clear(every);
    await user.type(every, '4');
    expect(save).toBeDisabled();

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

  it('pauses, resumes and deletes the selected schedule', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/schedules': () => ({ schedules: [digest] }),
      'GET /api/schedules/1/runs': () => ({ runs: [{ id: 5, status: 'failed', trigger: 'scheduled', scheduled_for: '2026-09-30T09:00:00Z', error: 'Model unavailable' }] }),
      'POST /api/schedules/1/pause': () => ({ schedule: { ...digest, state: 'paused', enabled: false } }),
      'POST /api/schedules/1/resume': () => ({ schedule: digest }),
      'DELETE /api/schedules/1': () => ({ ok: true }),
    });
    renderSchedules();

    await user.click(await screen.findByRole('button', { name: 'Open Morning digest' }));
    expect(await screen.findByText('Model unavailable')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Pause' }));
    await user.click(await screen.findByRole('button', { name: 'Resume' }));
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const [, confirm] = await screen.findAllByRole('button', { name: 'Delete' });
    await user.click(confirm);

    expect(await screen.findByText('No schedules yet')).toBeVisible();
    expect(api.request).toHaveBeenCalledWith('/api/schedules/1', { method: 'DELETE' });
  });

  it('shows why an action failed and keeps the schedule', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/schedules': () => ({ schedules: [digest] }),
      'GET /api/schedules/1/runs': () => ({ runs: [] }),
      'POST /api/schedules/1/pause': () => { throw new Error('schedule changed elsewhere'); },
    });
    renderSchedules();

    await user.click(await screen.findByRole('button', { name: 'Open Morning digest' }));
    await user.click(screen.getByRole('button', { name: 'Pause' }));

    expect(await screen.findByText('schedule changed elsewhere')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();
  });
});
