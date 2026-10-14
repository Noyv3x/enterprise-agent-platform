// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../../i18n';
import { Reply } from './Messages';
import type { LiveRun, Message } from './types';
import type { WebData } from './web';
import type { WorkItem } from './work';
import { WorkView } from './WorkView';

const NOW = Date.parse('2026-10-04T09:00:20Z');
const thinking = (text: string, startedAt: number | null = null, endedAt: number | null = null): WorkItem => ({ type: 'thinking', text, startedAt, endedAt });
const view = (items: WorkItem[], working = true) => <I18nProvider><WorkView trace={{ items, startedAt: NOW - 10_000, endedAt: null, truncated: false, omitted: 0 }} working={working} run={working ? 'live' : 2} /></I18nProvider>;
const pulse = () => screen.queryAllByRole('status').find((node) => node.textContent === 'Thinking');

function persisted(items: Record<string, unknown>[]): Message {
  return {
    id: 2, role: 'assistant', content: 'The report is ready.', created_at: '2026-10-04T09:00:20Z', attachments: [],
    metadata: { status: 'completed', work: {
      v: 1, started_at: '2026-10-04T09:00:00Z', ended_at: '2026-10-04T09:00:20Z', items,
    } },
  };
}

describe('thinking blocks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders bold Markdown headlines without literal asterisks or comment sentinels and never live-announces the text', () => {
    const item = thinking('**Inspecting packages**\n\n<!-- -->\n\nReading the manifest.\n\n**Choosing a fix**\n\n<!--', NOW - 8_000);
    const { container } = render(view([item]));
    const headline = screen.getByText('Inspecting packages', { selector: 'strong' });
    expect(headline).toBeVisible();
    expect(screen.getByText('Choosing a fix', { selector: 'strong' })).toBeVisible();
    expect(container).not.toHaveTextContent('**');
    expect(container).not.toHaveTextContent('<!--');
    expect(headline.closest('[aria-live]')).toHaveAttribute('aria-live', 'off');
    expect(headline.closest('[role="status"]')).toBeNull();
  });

  it('shows a stable polite pulse at an empty open block and hides the same block once ended', () => {
    const items = [thinking('Earlier summary', NOW - 8_000, NOW - 3_000), thinking('', NOW)];
    const { rerender } = render(view(items));
    const indicator = pulse();
    expect(indicator).toBeVisible();
    expect(indicator).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText('Earlier summary').compareDocumentPosition(indicator!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    act(() => vi.advanceTimersByTime(3_000));
    expect(pulse()).toBe(indicator);
    expect(indicator).toHaveTextContent(/^Thinking$/);
    rerender(view([items[0], thinking('', NOW, NOW + 3_000)]));
    expect(pulse()).toBeUndefined();
    expect(screen.getByText('Earlier summary')).toBeVisible();
  });

  it('hides finished placeholder-only blocks and pulses only while they are open', () => {
    const { rerender } = render(view([thinking('... …\n<!--', NOW)]));
    expect(pulse()).toBeVisible();
    rerender(view([thinking('... …\n<!-- -->', NOW, NOW + 1_000)]));
    expect(pulse()).toBeUndefined();
    expect(screen.queryByText('Thought for 1s')).not.toBeInTheDocument();
    expect(screen.queryByText(/\.\.\./)).not.toBeInTheDocument();
  });

  it('freezes each finished duration while the next live block keeps counting', () => {
    const first = thinking('First summary', NOW - 8_000, NOW - 2_000);
    const { rerender } = render(view([first, thinking('Second summary', NOW - 2_000)]));
    expect(screen.getByText('Thought for 6s')).toBeVisible();
    expect(screen.getByText('Thinking · 2s')).toBeVisible();
    act(() => vi.advanceTimersByTime(3_000));
    expect(screen.getByText('Thought for 6s')).toBeVisible();
    expect(screen.getByText('Thinking · 5s')).toBeVisible();
    rerender(view([first, thinking('Second summary', NOW - 2_000, NOW + 3_000)]));
    expect(screen.getByText('Thought for 5s')).toBeVisible();
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByText('Thought for 5s')).toBeVisible();
    expect(screen.queryByText(/Thinking ·/)).not.toBeInTheDocument();
  });

  it('restores per-block durations, hides empty blocks and reads old untimed persisted thinking', () => {
    const message = persisted([
      { type: 'thinking', text: '', started_at: '2026-10-04T09:00:00Z', ended_at: '2026-10-04T09:00:02Z' },
      { type: 'thinking', text: '**Recorded summary**\n\nUseful detail.', started_at: '2026-10-04T09:00:02Z', ended_at: '2026-10-04T09:00:10Z' },
      { type: 'thinking', text: 'Old untimed summary' },
      { type: 'thinking', text: 'Interrupted summary', started_at: '2026-10-04T09:00:12Z', ended_at: null },
      { type: 'thinking', text: '', started_at: '2026-10-04T09:00:13Z', ended_at: null },
    ]);
    render(<I18nProvider><Reply message={message} renderInput={() => null} /></I18nProvider>);
    const header = screen.getByRole('button', { name: 'Thought for 20s' });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(header);
    expect(screen.getByText('Recorded summary', { selector: 'strong' })).toBeVisible();
    expect(screen.getByText('Thought for 8s')).toBeVisible();
    expect(screen.queryByText('Thought for 2s')).not.toBeInTheDocument();
    expect(screen.getByText('Old untimed summary')).toBeVisible();
    expect(screen.getAllByText('Thought', { exact: true })).toHaveLength(2);
    expect(pulse()).toBeUndefined();
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByText('Thought for 8s')).toBeVisible();
    expect(screen.getByText('Interrupted summary')).toBeVisible();
  });

  it.each([
    ['en', 'Thinking · 8s', 'Thought for 8s'],
    ['zh-CN', '思考中 · 8s', '思考了 8s'],
    ['zh-TW', '思考中 · 8s', '思考了 8s'],
  ])('localizes live and finished block durations through useWords in %s', (locale, active, done) => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    const { rerender } = render(view([thinking('Summary', NOW - 8_000)]));
    expect(screen.getByText(active)).toBeVisible();
    rerender(view([thinking('Summary', NOW - 8_000, NOW)]));
    expect(screen.getByText(done)).toBeVisible();
  });

  it('keeps overall work headings accurate when a settled answer gains an inserted-message segment', () => {
    const first = thinking('Before the insertion', NOW - 10_000, NOW - 5_000);
    const run: LiveRun = { items: [first, { type: 'text', text: 'Initial answer' }], thinkingIndex: null, calls: [], startedAt: NOW - 10_000, notice: null, artifacts: [] };
    const renderRun = (current: LiveRun) => <I18nProvider><Reply run={current} renderInput={() => <p>Inserted request</p>} /></I18nProvider>;
    const { rerender } = render(renderRun(run));
    expect(screen.getByRole('button', { name: 'Thought for 10s' })).toBeVisible();
    act(() => vi.advanceTimersByTime(5_000));
    const input: WorkItem = { type: 'input', messageId: 3, at: NOW + 5_000 };
    rerender(renderRun({ ...run, items: [...run.items, input, thinking('After the insertion', NOW + 5_000)], thinkingIndex: 3 }));
    expect(screen.getByRole('button', { name: 'Thought for 15s' })).toBeVisible();
    expect(screen.getByRole('button', { name: /^Thinking/ })).toBeVisible();
    act(() => vi.advanceTimersByTime(4_000));
    expect(screen.getByText('Thinking · 4s')).toBeVisible();
    const article = screen.getByRole('article', { name: 'Reply in progress' });
    expect(within(article).getByText('Inserted request').compareDocumentPosition(within(article).getByText('After the insertion')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    rerender(renderRun({ ...run, items: [...run.items, input, thinking('After the insertion', NOW + 5_000, NOW + 9_000), { type: 'text', text: 'Final answer' }] }));
    expect(screen.getByRole('button', { name: 'Thought for 15s' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Thought for 4s' })).toBeVisible();
  });
});

describe('file change chips', () => {
  beforeEach(() => window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en'));
  afterEach(cleanup);

  it('count an overwrite exactly from its patch and fall back to the written lines without one', () => {
    const write = (id: string, path: string, patch?: string): WorkItem => ({
      type: 'tool', id, name: 'write', args: { path, content: 'a\nB\nc\n' }, status: 'done', output: '', startedAt: NOW - 5000, endedAt: NOW - 4000,
      ...(patch ? { patch } : {}),
    });
    render(view([
      write('w1', '/workspace/report.md', '--- report.md\n+++ report.md\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n'),
      write('w2', '/workspace/new.md'),
    ]));
    const changed = screen.getByRole('button', { name: 'Show changes to report.md' });
    expect(changed).toHaveTextContent('+1');
    expect(changed).toHaveTextContent('−1');
    expect(screen.getByRole('button', { name: 'Show changes to new.md' })).toHaveTextContent(/^new\.md\+3$/);
  });
});

describe('web steps in the work trace', () => {
  afterEach(cleanup);

  it.each([
    ['en', 'Searching for “2026 新能源汽车销量”', 'Reading news.cn'],
    ['zh-CN', '正在搜索「2026 新能源汽车销量」', '正在阅读 news.cn'],
    ['zh-TW', '正在搜尋「2026 新能源汽车销量」', '正在閱讀 news.cn'],
  ])('announces what the AI is searching or reading, politely, in %s', (locale, searching, reading) => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    const search: WorkItem = { type: 'tool', id: 's', name: 'web_search', args: { query: '2026 新能源汽车销量' }, status: 'running', output: '', startedAt: NOW, endedAt: null };
    const { rerender } = render(view([search]));
    const status = screen.getAllByRole('status').find((node) => node.textContent?.startsWith(searching));
    expect(status).toBeTruthy();
    const fetch: WorkItem = { type: 'tool', id: 'f', name: 'web_fetch', args: { url: 'https://www.news.cn/a' }, status: 'running', output: '', startedAt: NOW, endedAt: null };
    rerender(view([{ ...search, status: 'done' }, fetch]));
    expect(screen.getAllByRole('status').some((node) => node.textContent?.startsWith(reading))).toBe(true);
  });
});

describe('web step group header', () => {
  beforeEach(() => window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en'));
  afterEach(cleanup);
  const fetch = (id: string, status: 'running' | 'done' | 'error' | 'cancelled', web?: WebData): WorkItem => ({
    type: 'tool', id, name: 'web_fetch', args: { url: `https://news.cn/${id}` }, status, output: '', startedAt: NOW - 1000, endedAt: status === 'running' ? null : NOW,
    ...(web ? { web } : {}),
  });
  const page: WebData = { kind: 'page', url: 'https://news.cn/a', title: 'A', via: 'direct', chars: 10, truncated: false, excerpt: '' };
  const blocked: WebData = { kind: 'failure', error: 'blocked', url: 'https://news.cn/b', host: 'news.cn', status: 401, protection: '', triedBrowser: true, message: '' };

  it('counts only pages actually read; running and stopped reads are not', () => {
    const { rerender } = render(view([fetch('a', 'done', page), fetch('b', 'error', blocked), fetch('c', 'running'), fetch('d', 'cancelled')]));
    expect(screen.getByRole('button', { name: '1 page read · 1 could not be opened · opening 1 page' })).toBeVisible();
    rerender(view([fetch('c', 'running')]));
    expect(screen.getByRole('button', { name: 'Opening 1 page' })).toBeVisible();
    rerender(view([fetch('d', 'cancelled')], false));
    expect(screen.getByRole('button', { name: '1 web step' })).toBeInTheDocument();
  });

  it('never makes a link of an address that is not http or https', () => {
    const search: WorkItem = {
      type: 'tool', id: 's', name: 'web_search', args: { query: 'q' }, status: 'done', output: '', startedAt: NOW - 1000, endedAt: NOW,
      web: { kind: 'search', query: 'q', unresponsive: [], results: [{ title: 'Evil', url: 'javascript:alert(1)', description: '' }, { title: 'Good', url: 'https://news.cn/', description: '' }] },
    };
    render(view([search]));
    fireEvent.click(screen.getByRole('button', { name: /Searched/ }));
    expect(screen.getByRole('link', { name: 'Good' })).toHaveAttribute('href', 'https://news.cn/');
    expect(screen.queryByRole('link', { name: 'Evil' })).not.toBeInTheDocument();
  });
});
