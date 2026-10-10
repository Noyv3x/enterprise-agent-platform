// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Movable } from './Movable';

/** Each bubble reports its layout top from `data-top`, so a re-render can move it. */
function layout() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const top = Number(this.querySelector('[data-top]')?.getAttribute('data-top') ?? 0);
    return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
}

const bubble = (top: number, slot: string, enter = false) => (
  <Movable messageId={7} slot={slot} enter={enter} leaving={false}><span data-top={top}>Message</span></Movable>
);

describe('Movable', () => {
  let animate: Mock;
  let reduced = false;
  beforeEach(() => {
    reduced = false;
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduced && query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} }));
    animate = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
    layout();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
  });

  it('keeps its node and glides from the old position when its slot changes', () => {
    const { container, rerender } = render(<div>{bubble(300, 'pending')}</div>);
    const node = container.firstElementChild!.firstElementChild;
    rerender(<div>{bubble(120, 'delivered')}</div>);
    expect(container.firstElementChild!.firstElementChild).toBe(node);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0][0]).toEqual([{ transform: 'translateY(180px)' }, { transform: 'translateY(0)' }]);
    expect(animate.mock.calls[0][1].duration).toBeLessThan(300);
  });

  it('does not animate layout changes within the same slot', () => {
    const { rerender } = render(<div>{bubble(300, 'pending')}</div>);
    rerender(<div>{bubble(340, 'pending')}</div>);
    expect(animate).not.toHaveBeenCalled();
  });

  it('hands its position to the same message mounting elsewhere in the same commit, gliding instead of entering', () => {
    const { rerender } = render(<div><article>{bubble(300, 'pending', true)}</article><section /></div>);
    animate.mockClear();
    rerender(<div><article /><section>{bubble(360, 'queued', true)}</section></div>);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0][0]).toEqual([{ transform: 'translateY(-60px)' }, { transform: 'translateY(0)' }]);
  });

  it('plays the entrance only for new messages, and nothing under reduced motion', () => {
    render(<div>{bubble(0, 'queued', true)}</div>);
    expect(animate.mock.calls[0][0][0]).toMatchObject({ opacity: 0 });
    cleanup();
    animate.mockClear();
    render(<div>{bubble(0, 'history', false)}</div>);
    expect(animate).not.toHaveBeenCalled();
    cleanup();
    reduced = true;
    const { rerender } = render(<div>{bubble(300, 'pending', true)}</div>);
    rerender(<div>{bubble(100, 'delivered', true)}</div>);
    expect(animate).not.toHaveBeenCalled();
  });
});
