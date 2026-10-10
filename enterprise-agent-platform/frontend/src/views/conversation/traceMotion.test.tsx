// @vitest-environment jsdom
/// <reference types="node" />
// The reduced-motion check reads the stylesheet from disk: Vitest does not load CSS into jsdom.

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type * as ReactMarkdownModule from 'react-markdown';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ThinkingStateModule from '../../components/ui/beautiful/primitives/ThinkingState';
import type * as ToolChipsModule from '../../components/ui/beautiful/primitives/ToolChips';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../../i18n';
import { Markdown } from './Markdown';
import type { WorkItem, WorkTrace } from './work';
import { WorkView } from './WorkView';

const renders = vi.hoisted(() => ({ toolChips: 0, prose: [] as string[], markdown: [] as string[] }));

vi.mock('../../components/ui/beautiful/primitives/ToolChips', async (importOriginal) => {
  const actual = await importOriginal<typeof ToolChipsModule>();
  return {
    ...actual,
    default: (props: Parameters<typeof actual.default>[0]) => {
      renders.toolChips += 1;
      return actual.default(props);
    },
  };
});

vi.mock('../../components/ui/beautiful/primitives/ThinkingState', async (importOriginal) => {
  const actual = await importOriginal<typeof ThinkingStateModule>();
  return {
    ...actual,
    TraceProse: (props: Parameters<typeof actual.TraceProse>[0]) => {
      renders.prose.push(typeof props.heading === 'string' ? props.heading : 'live');
      return actual.TraceProse(props);
    },
  };
});

vi.mock('react-markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactMarkdownModule>();
  return {
    ...actual,
    default: (props: Parameters<typeof actual.default>[0]) => {
      renders.markdown.push(String(props.children));
      return actual.default(props);
    },
  };
});

const NOW = Date.parse('2026-10-10T09:00:20Z');
const thinking = (text: string, startedAt: number | null, endedAt: number | null = null): WorkItem => ({ type: 'thinking', text, startedAt, endedAt });
const tool = (id: string, path: string): WorkItem => ({ type: 'tool', id, name: 'read', args: { path }, status: 'done', output: 'ok', startedAt: NOW - 9_000, endedAt: NOW - 8_000 });
const trace = (items: WorkItem[]): WorkTrace => ({ items, startedAt: NOW - 10_000, endedAt: null, truncated: false, omitted: 0 });
const view = (items: WorkItem[], working: boolean) => <I18nProvider><WorkView trace={trace(items)} working={working} run={working ? 'live' : 2} /></I18nProvider>;
const markdown = (content: string, streaming = false) => <I18nProvider><Markdown content={content} streaming={streaming} /></I18nProvider>;

/** The disclosure grid under a ThinkingState header. */
function disclosure(header: HTMLElement): HTMLElement {
  return header.nextElementSibling as HTMLElement;
}

function animated(node: Element | null): boolean {
  return Boolean((node as HTMLElement | null)?.style.animation);
}

describe('work trace motion', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    renders.toolChips = 0;
    renders.prose = [];
    renders.markdown = [];
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('collapses a settled trace through a zero-minimum clip box with no measured rail', () => {
    render(view([thinking('Recorded summary', NOW - 10_000, NOW - 5_000), tool('read-1', '/workspace/a.txt')], false));
    const header = screen.getByRole('button', { name: 'Thought for 10s' });
    const grid = disclosure(header);
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(grid).toHaveStyle({ gridTemplateRows: '0fr' });
    expect(grid).toHaveAttribute('inert');
    // A 0fr track only reaches zero height when its single item may shrink below its content.
    expect(grid.children).toHaveLength(1);
    expect(grid.firstElementChild).toHaveClass('min-h-0', 'overflow-hidden');
    expect(grid).toHaveClass('duration-300', 'ease-out-strong');
    const rail = grid.querySelector('span[aria-hidden].bg-line') as HTMLElement;
    expect(rail).toHaveClass('-top-2', 'bottom-2.5');
    expect(rail.style.height).toBe('');
    fireEvent.click(header);
    expect(grid).toHaveStyle({ gridTemplateRows: '1fr' });
    expect(grid).not.toHaveAttribute('inert');
  });

  it('ticks live durations without re-rendering the trace rows', () => {
    const items = [thinking('Settled summary', NOW - 10_000, NOW - 6_000), tool('read-1', '/workspace/a.txt'), thinking('Live summary', NOW - 2_000)];
    render(view(items, true));
    expect(screen.getByText('Thinking · 2s')).toBeVisible();
    const header = screen.getByRole('button', { name: 'Thinking' });
    expect(header).toHaveTextContent('Thinking 10s');
    const chips = renders.toolChips;
    const prose = renders.prose.length;
    act(() => vi.advanceTimersByTime(3_000));
    expect(screen.getByText('Thinking · 5s')).toBeVisible();
    expect(header).toHaveTextContent('Thinking 13s');
    expect(screen.getByText('Thought for 4s')).toBeVisible();
    expect(renders.toolChips).toBe(chips);
    expect(renders.prose).toHaveLength(prose);
  });

  it('re-renders only the tool group whose call changed', () => {
    const first = tool('read-1', '/workspace/a.txt');
    const { rerender } = render(view([first, thinking('Between', NOW - 7_000, NOW - 6_000), tool('read-2', '/workspace/b.txt')], true));
    const chips = renders.toolChips;
    const running: WorkItem = { ...tool('read-2', '/workspace/b.txt'), status: 'running' } as WorkItem;
    rerender(view([first, thinking('Between', NOW - 7_000, NOW - 6_000), running], true));
    expect(renders.toolChips).toBe(chips + 1);
  });

  it('animates rows that arrive live but restores a settled trace in place', () => {
    const settled = render(view([thinking('Recorded summary', NOW - 10_000, NOW - 5_000), tool('read-1', '/workspace/a.txt')], false));
    fireEvent.click(screen.getByRole('button', { name: 'Thought for 10s' }));
    expect(animated(screen.getByText('Recorded summary').closest('[aria-live="off"]'))).toBe(false);
    expect(animated(screen.getByText('/workspace/a.txt').closest('button')!.parentElement!.parentElement)).toBe(false);
    expect(animated(screen.getByText('Thought for 10s'))).toBe(false);
    settled.unmount();

    const first = tool('read-1', '/workspace/a.txt');
    const { rerender } = render(view([first], true));
    expect(animated(screen.getByText('/workspace/a.txt').closest('button')!.parentElement!.parentElement)).toBe(true);
    rerender(view([first, tool('read-2', '/workspace/b.txt')], true));
    expect(animated(screen.getByText('/workspace/b.txt').closest('button')!.parentElement!.parentElement)).toBe(true);
    rerender(view([first, tool('read-2', '/workspace/b.txt')], false));
    expect(animated(screen.getByText(/^Worked for/))).toBe(true);
  });

  it('keeps settled Markdown blocks while the streaming tail grows', () => {
    const intro = '## Result\n\nThe build failed because the lock file drifted.\n\n';
    const { rerender } = render(markdown(`${intro}- pin vite`, true));
    const heading = screen.getByRole('heading', { name: 'Result' });
    const parsed = (source: string) => renders.markdown.filter((children) => children === source).length;
    expect(parsed('## Result\n\n')).toBe(1);
    rerender(markdown(`${intro}- pin vite\n- raise the timeout`, true));
    rerender(markdown(`${intro}- pin vite\n- raise the timeout\n\nAll tests pass.`, true));
    expect(screen.getByRole('heading', { name: 'Result' })).toBe(heading);
    expect(parsed('## Result\n\n')).toBe(1);
    expect(parsed('The build failed because the lock file drifted.\n\n')).toBe(1);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('renders streamed Markdown exactly like the whole document', () => {
    const document = [
      '# Plan', '', '1. first step', '', '2. second step', '', 'Text with $x^2$ math', '', '$$', 'a + b', '$$', '',
      '| a | b |', '|---|---|', '| 1 | 2 |', '', '```ts', 'const a = 1;', '', 'const b = 2;', '```', '', '> quoted', '> lines', '',
      'Heading', '===', '', '- a', '- b', '', '  continued', '', 'tail',
    ].join('\n');
    const streamed = render(markdown('', true));
    for (let end = 1; end <= document.length; end += 3) streamed.rerender(markdown(document.slice(0, end), true));
    streamed.rerender(markdown(document));
    // Whole renders put newline text between top-level elements; the elements themselves must match.
    const blocks = [...streamed.container.children].map((element) => element.outerHTML);
    streamed.unmount();
    // A definition makes the renderer keep the document whole; it renders nothing itself.
    const whole = render(markdown(`${document}\n\n[unused]: https://example.com`));
    expect(blocks).toEqual([...whole.container.children].map((element) => element.outerHTML));
  });

  it('removes animation and transition delays under reduced motion', () => {
    const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(readFileSync(resolve(__dirname, '../../components/ui/beautiful/foundation.css'), 'utf8'))?.[1] ?? '';
    expect(block).toMatch(/\*,\s*\*::before,\s*\*::after\s*\{/);
    expect(block).toMatch(/animation-delay: 0s !important;/);
    expect(block).toMatch(/transition-delay: 0s !important;/);
    expect(block).toMatch(/animation-duration: 0\.01ms !important;/);
  });
});
