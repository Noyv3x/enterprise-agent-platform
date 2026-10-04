// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../../i18n';
import { AssistantMessage, LiveReply } from './Messages';
import type { LiveRun, Message } from './types';
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
    render(<I18nProvider><AssistantMessage message={message} renderInput={() => null} /></I18nProvider>);
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
    const run: LiveRun = { items: [first, { type: 'text', text: 'Initial answer' }], thinkingIndex: null, calls: [], startedAt: NOW - 10_000, notice: null };
    const renderRun = (current: LiveRun) => <I18nProvider><LiveReply run={current} inserted={[]} renderInput={() => <p>Inserted request</p>} /></I18nProvider>;
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
